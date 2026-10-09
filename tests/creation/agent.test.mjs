import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = 48921, origin = `http://127.0.0.1:${port}`, api = `${origin}/creation-api`, rid = 'scene-harbor';
const pause = ms => new Promise(ok => setTimeout(ok, ms));
const uid = prefix => `${prefix}-${randomUUID()}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const branchPath = p => `/projects/${p}/branches/main`;
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, /^(token|password|code|email|account|authorization|access_token|refresh_token|id_token|api_key|cap)$/i.test(key) ? '[redacted]' : redact(v)]));
  if (typeof value === 'string') return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]').replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
  return value;
}
async function free() { const s = createServer(); await new Promise((ok, no) => { s.once('error', no); s.listen(port, '127.0.0.1', ok); }); await new Promise(ok => s.close(ok)); }

test('real Codex creation session: tool execution, durable continuation and interrupt', { timeout: 480000 }, async t => {
  await free();
  const out = resolve(root, '.local/creation-verification/agent', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-creation-agent-')); await mkdir(out, { recursive: true });
  const sourceFiles = ['services/creation/agent-runs.mjs', 'services/creation/codex-agent.mjs', 'services/creation/store.mjs', 'services/creation/service.mjs', 'services/creation/realtime.mjs', 'services/preview/server.mjs'];
  const report = { started_at: new Date().toISOString(), root, port, data, node: process.version, scope: 'actual local Codex App Server with isolated creator workspace; no Blender/game/world/browser', cases: [], events: [], public_packets: [], owner_packets: [], http: [], processes: [], source_hashes: {}, completed: false };
  for (const path of sourceFiles) report.source_hashes[path] = hash(await readFile(resolve(root, path)));
  report.codex_version = execFileSync(process.env.CODEX_BIN ?? '/opt/homebrew/bin/codex', ['--version'], { encoding: 'utf8' }).trim();
  let child, log = '', A, B, session, projectId, model, workspace, cursor = 0, activeRun, peerA, peerB;
  const sockets = new Set();
  const save = async () => { await writeFile(resolve(out, 'report.json'), JSON.stringify(redact(report), null, 2) + '\n'); await writeFile(resolve(out, 'events.json'), JSON.stringify(redact(report.events), null, 2) + '\n'); };
  async function start() {
    await free(); const env = { ...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: data, WORLD_ATELIER_CREATION_DATA: resolve(data, 'creation'), WORLD_ATELIER_DISABLE_WORLDS: '1' }; delete env.WORLD_ATELIER_DISABLE_AGENT;
    child = spawn(process.execPath, ['services/preview/server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { pid: child.pid, started_at: Date.now() }; report.processes.push(record);
    child.stdout.on('data', b => { log += `[${record.pid} stdout] ${b}`; }); child.stderr.on('data', b => { log += `[${record.pid} stderr] ${b}`; }); child.once('exit', (exit_code, signal) => Object.assign(record, { exit_code, signal, stopped_at: Date.now() }));
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error(log); try { const r = await fetch(api + '/health'); if (r.ok) return; } catch {} await pause(50); } throw Error('Service startup timed out');
  }
  async function stop() {
    for (const ws of sockets) ws.terminate(); sockets.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const own = child, gone = new Promise(ok => own.once('exit', ok)); own.kill('SIGTERM'); const timer = setTimeout(() => own.kill('SIGKILL'), 8000); await gone; clearTimeout(timer); await free();
  }
  async function req(method, path, user = A, input) {
    const headers = { origin, 'content-type': 'application/json' }; if (user) headers.authorization = `Bearer ${user.token}`;
    const response = await fetch(api + path, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
    const value = await response.json(); report.http.push(redact({ at: Date.now(), method, path, actor: user?.user?.id, input, status: response.status, value })); return { status: response.status, value };
  }
  const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(redact(response.value))); return response.value; };
  async function branch() { return ok(await req('GET', branchPath(projectId))); }
  async function view() { return ok(await req('GET', `/sessions/${session.id}`)); }
  async function events() {
    while (true) {
      const list = ok(await req('GET', `/sessions/${session.id}/events?after=${cursor}`)).events;
      for (const event of list) { assert.ok(event.cursor > cursor); cursor = event.cursor; report.events.push(event); }
      if (list.length < 500) break;
    }
    await save(); return report.events;
  }
  async function awaitRun(runId, statuses = ['completed', 'failed', 'interrupted'], timeout = 150000) {
    const until = Date.now() + timeout; let lastNotice = Date.now();
    while (Date.now() < until) {
      await events(); const current = await view(), run = current.runs.find(x => x.id === runId);
      if (statuses.includes(run?.status)) return { run, session: current };
      const pending = report.events.findLast(e => e.kind === 'approval_request');
      if (pending) throw Object.assign(Error(`Actual approval/input pending: ${pending.method}; no synthetic approval sent`), { request_key: pending.request_key });
      if (Date.now() - lastNotice > 10000) { console.log(`AGENT_WAIT ${runId} ${run?.status} events=${report.events.length}`); lastNotice = Date.now(); }
      await pause(500);
    }
    throw Error(`Run ${runId} did not reach a terminal state; do not retry its message`);
  }
  async function ws(user, targetArray) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/creation`, { origin }), messages = []; sockets.add(socket);
    socket.on('message', bytes => { const packet = JSON.parse(bytes.toString()); messages.push(packet); targetArray.push(packet); }); socket.on('error', () => {});
    const send = packet => socket.send(JSON.stringify(packet));
    const wait = async (type, mark = 0) => { const deadline = Date.now() + 3000; while (Date.now() < deadline) { const found = messages.slice(mark).find(m => m.type === type); if (found) return found; await pause(10); } throw Error(`WS ${type} timeout`); };
    await new Promise((yes, no) => { socket.once('open', yes); socket.once('error', no); }); send({ type: 'auth', token: user.token }); await wait('authenticated');
    send({ type: 'subscribe', project_id: projectId, branch_id: 'main', resource_id: rid, generation: 1 }); await wait('baseline');
    const ping = setInterval(() => { if (socket.readyState === WebSocket.OPEN) send({ type: 'ping' }); }, 10000); ping.unref(); socket.on('close', () => clearInterval(ping));
    return { socket, messages, send, wait };
  }
  async function step(id, title, fn) {
    const row = { id, title, status: 'running', started_at: Date.now(), observations: {} }; report.cases.push(row);
    await t.test(`${id} ${title}`, async () => { try { await fn(row.observations); row.status = 'passed'; } catch (error) { row.status = 'failed'; row.error = { message: error.message, stack: error.stack }; throw error; } finally { row.finished_at = Date.now(); await save(); console.log(`AGENT_CASE ${id} ${row.status}`); } });
    if (row.status !== 'passed') throw Error(`Stop after ${id}; no replacement goal or automatic retry`);
  }
  const terminal = run => ['completed', 'failed', 'interrupted'].includes(run?.status);
  try {
    await start();
    A = ok(await req('POST', '/auth/register', null, { name: uid('agent-owner'), password: uid('password') }), 201);
    B = ok(await req('POST', '/auth/register', null, { name: uid('agent-peer'), password: uid('password') }), 201);
    const created = ok(await req('POST', '/projects', A, { name: uid('Agent isolated validation'), template: 'empty' }), 201); projectId = created.project.id;
    const invite = ok(await req('POST', `/projects/${projectId}/invites`, A, { role: 'editor' }), 201); ok(await req('POST', '/invites/join', B, { code: invite.code }));
    ok(await req('POST', branchPath(projectId) + '/transactions', A, { transaction_id: uid('setup'), base_revision: created.branch.head, ops: [{ type: 'put_object', resource_id: rid, object_id: 'agent-anchor', expected_version: null, object: { id: 'agent-anchor', name: 'Independent Agent anchor', kind: 'anchor', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], components: {} } }] }));
    session = ok(await req('POST', branchPath(projectId) + '/sessions', A, { title: 'Real executor verification' }), 201);
    workspace = resolve(data, 'creation/workspaces', projectId, 'main', A.user.id, session.id);
    report.project_id = projectId; report.creator_session_id = session.id; report.workspace = workspace;
    peerA = await ws(A, report.owner_packets); peerB = await ws(B, report.public_packets);
    peerA.send({ type: 'session_subscribe', session_id: session.id, after: 0 }); await peerA.wait('session_events');
    const initial = await branch(), observed = initial.manifest.resources[rid].objects[0];
    ok(await req('POST', `/sessions/${session.id}/attachments`, A, { revision: initial.head, resource_id: rid, object_id: observed.id, expected_version: observed.version }), 201);
    const secret = uid('PRIVATE-ONLY-SENTINEL'); report.privacy_sentinel = secret;
    let firstInput, firstRun, secondRun;

    await step('CA01', 'actual executor availability and default model', async o => {
      const status = ok(await req('GET', '/agent/status')); assert.equal(status.ready, true); assert.equal(status.authenticated, true); assert.equal(status.executor, 'local-codex-app-server');
      model = status.default_model; assert.ok(model && status.models.some(x => x.model === model)); o.status = status; report.actual_model = model;
      console.log(`AGENT_MODEL ${model}`);
      assert.equal((await req('GET', `/sessions/${session.id}`, B)).status, 403); assert.equal((await req('GET', `/sessions/${session.id}/events`, B)).status, 403);
    });
    await step('CA02', 'real world_read, local file/native command, world_apply and message idempotency', async o => {
      firstInput = { client_user_message_id: uid('client-message'), model, text: `This is an authorized independent integration test in your dedicated session workspace. Do not implement gameplay, run Blender, invoke world_validate/world_publish, or edit server/user projects. Read WORLD-API.md. Call world_read for ${rid}; the existing object is agent-anchor. Create a real local file agent-transform.json containing {"position":[7.25,1.5,-2],"rotation":[10,20,30],"scale":[1.25,1.5,0.75],"round":1}. Use your normal command tool to read it back and verify it, then append exactly one line "round-1" to effects.log. Read actual object versions and use world_apply to set agent-anchor's full TRS to those values. Read back with world_read. Private conversation sentinel ${secret} must never be placed in shared world fields or public assets. Report source persistence accurately; this test does not publish a playable world. Do all actions now.` };
      const started = ok(await req('POST', `/sessions/${session.id}/turns`, A, firstInput), 202); activeRun = started.run; firstRun = started.run; report.first_start = started;
      assert.ok(started.run.turn_id && started.run.thread_id); assert.equal(started.run.model, model);
      const replay = ok(await req('POST', `/sessions/${session.id}/turns`, A, firstInput), 202); assert.equal(replay.replayed, true); assert.equal(replay.run.id, started.run.id);
      assert.equal((await req('POST', `/sessions/${session.id}/turns`, A, { ...firstInput, text: firstInput.text + ' changed' })).status, 409);
      assert.equal((await req('POST', `/sessions/${session.id}/turns`, A, { text: 'Concurrent unrelated turn must not start', client_user_message_id: uid('concurrent'), model })).status, 409);
      const finished = await awaitRun(started.run.id); activeRun = finished.run; firstRun = finished.run; assert.equal(finished.run.status, 'completed', JSON.stringify(finished.run.error));
      const after = await branch(), target = after.manifest.resources[rid].objects.find(x => x.id === 'agent-anchor');
      assert.deepEqual(target.position, [7.25, 1.5, -2]); assert.deepEqual(target.rotation, [10, 20, 30]); assert.deepEqual(target.scale, [1.25, 1.5, 0.75]); assert.ok(finished.run.changes.includes(after.head));
      const file = JSON.parse(await readFile(resolve(workspace, 'agent-transform.json'), 'utf8')); assert.equal(file.round, 1); assert.deepEqual(file.position, target.position);
      assert.deepEqual((await readFile(resolve(workspace, 'effects.log'), 'utf8')).trim().split(/\r?\n/), ['round-1']);
      const items = report.events.filter(e => e.kind === 'notification' && e.method === 'item/completed').map(e => e.params?.item).filter(Boolean);
      assert.ok(items.some(x => x.type === 'dynamicToolCall' && x.tool === 'world_read' && x.success)); assert.ok(items.some(x => x.type === 'dynamicToolCall' && x.tool === 'world_apply' && x.success)); assert.ok(items.some(x => x.type === 'commandExecution' && x.status === 'completed' && x.exitCode === 0));
      assert.equal(finished.session.messages.filter(x => x.role === 'user' && x.client_user_message_id === firstInput.client_user_message_id).length, 1); assert.equal(finished.session.messages.find(x => x.role === 'user').attachments[0].revision, initial.head);
      assert.equal(JSON.stringify(report.public_packets).includes(secret), false); assert.ok(report.public_packets.some(x => x.type === 'development'));
      o.run = finished.run; o.final_head = after.head; o.file_sha256 = hash(await readFile(resolve(workspace, 'agent-transform.json'))); o.completed_item_types = items.map(x => ({ id: x.id, type: x.type, tool: x.tool, status: x.status, success: x.success, exitCode: x.exitCode }));
    });
    await step('CA03', 'restart resumes the same real thread and replay does not repeat effects', async o => {
      const before = await view(), pid = child.pid; await stop(); await start();
      const retained = await view(); assert.equal(retained.executor_thread_id, before.executor_thread_id); assert.deepEqual(retained.messages, before.messages);
      const replay = ok(await req('POST', `/sessions/${session.id}/turns`, A, firstInput), 202); assert.equal(replay.replayed, true); assert.equal(replay.run.id, firstRun.id);
      const status = ok(await req('GET', '/agent/status')); assert.equal(status.ready, true);
      const reconcile = ok(await req('POST', `/sessions/${session.id}/reconcile`, A, {})); assert.equal(reconcile.reconciliation.canSend, true); assert.equal(reconcile.session.executor_thread_id, before.executor_thread_id);
      assert.deepEqual((await readFile(resolve(workspace, 'effects.log'), 'utf8')).trim().split(/\r?\n/), ['round-1']);
      peerA = await ws(A, report.owner_packets); peerB = await ws(B, report.public_packets); peerA.send({ type: 'session_subscribe', session_id: session.id, after: cursor }); await peerA.wait('session_events');
      o.old_pid = pid; o.new_pid = child.pid; o.reconciliation = reconcile.reconciliation; o.thread_id = retained.executor_thread_id;
    });
    await step('CA04', 'second actual turn continues prior workspace/context on the same thread', async o => {
      const input = { client_user_message_id: uid('client-message'), model, text: `Continue our previous independent test in this same session. Read agent-transform.json and effects.log produced in round 1; do not rerun round 1. Use a native command to verify that effects.log has exactly one round-1 line. Change the local JSON to round=2 and add exactly 1 to its X position, preserving its other position/rotation/scale values. Append exactly one round-2 line. Call world_read for ${rid}, then world_apply with the actual current expected_version to update the same agent-anchor to your new complete TRS. Read back using world_read. Do not create other content or publish/run a game. Keep the earlier private sentinel out of shared fields. Report what persisted.` };
      const started = ok(await req('POST', `/sessions/${session.id}/turns`, A, input), 202); activeRun = started.run;
      assert.equal(started.run.thread_id, firstRun.thread_id); assert.notEqual(started.run.turn_id, firstRun.turn_id);
      const finished = await awaitRun(started.run.id); activeRun = finished.run; secondRun = finished.run; assert.equal(finished.run.status, 'completed', JSON.stringify(finished.run.error));
      const after = await branch(), target = after.manifest.resources[rid].objects.find(x => x.id === 'agent-anchor'); assert.deepEqual(target.position, [8.25, 1.5, -2]); assert.deepEqual(target.rotation, [10, 20, 30]); assert.deepEqual(target.scale, [1.25, 1.5, 0.75]);
      const file = JSON.parse(await readFile(resolve(workspace, 'agent-transform.json'), 'utf8')); assert.equal(file.round, 2); assert.deepEqual(file.position, target.position);
      assert.deepEqual((await readFile(resolve(workspace, 'effects.log'), 'utf8')).trim().split(/\r?\n/), ['round-1', 'round-2']);
      const replay = ok(await req('POST', `/sessions/${session.id}/turns`, A, input), 202); assert.equal(replay.replayed, true); assert.equal(replay.run.id, finished.run.id);
      assert.equal(JSON.stringify(report.public_packets).includes(secret), false); assert.equal((await req('GET', `/sessions/${session.id}/events`, B)).status, 403);
      o.run = secondRun; o.final_head = after.head;
    });
    await step('CA05', 'real long command interrupt reaches terminal and does not repeat goal', async o => {
      const before = await branch();
      const input = { client_user_message_id: uid('interrupt-message'), model, text: `This is a bounded cancellation test. Do not read or modify the shared world. Use your normal command-execution tool to run one foreground Python command now, without a background shell ampersand: import os,time; from pathlib import Path; Path('interrupt-probe.pid').write_text(str(os.getpid())); print('INTERRUPT_READY',flush=True); time.sleep(45); Path('should-not-exist.txt').write_text('command finished'). Stay with this command until it finishes or is interrupted. Do not rerun it, do not start another task, and do not write should-not-exist.txt by any other means. The external tester will interrupt this turn after the command really starts.` };
      const started = ok(await req('POST', `/sessions/${session.id}/turns`, A, input), 202); activeRun = started.run;
      let nativePid; const deadline = Date.now() + 90000;
      while (Date.now() < deadline) { await events(); try { nativePid = Number(await readFile(resolve(workspace, 'interrupt-probe.pid'), 'utf8')); if (Number.isSafeInteger(nativePid) && nativePid > 0) break; } catch {} const current = await view(); if (terminal(current.runs.find(x => x.id === started.run.id))) throw Error('Turn ended before the cancellation command began'); await pause(250); }
      assert.ok(nativePid, 'No actual long command process started');
      o.native_command_pid = nativePid; o.request_at = Date.now();
      const response = ok(await req('POST', `/sessions/${session.id}/interrupt`, A, {})); o.interrupt_response = response;
      const finished = await awaitRun(started.run.id, ['interrupted', 'failed', 'completed'], 30000); activeRun = finished.run; assert.equal(finished.run.status, 'interrupted');
      assert.ok(report.events.some(e => e.kind === 'notification' && e.method === 'turn/completed' && e.params?.turn?.id === started.run.turn_id && e.params.turn.status === 'interrupted'));
      const until = Date.now() + 5000; let alive = true;
      while (Date.now() < until) { try { process.kill(nativePid, 0); } catch { alive = false; break; } await pause(100); }
      o.native_process_stopped = !alive; assert.equal(alive, false, 'Interrupted native command process is still alive');
      assert.equal(await stat(resolve(workspace, 'should-not-exist.txt')).then(() => true, () => false), false);
      assert.deepEqual(await branch(), before);
      const replay = ok(await req('POST', `/sessions/${session.id}/turns`, A, input), 202); assert.equal(replay.replayed, true); assert.equal(replay.run.id, finished.run.id); assert.equal(replay.run.status, 'interrupted');
      const repeatedInterrupt = ok(await req('POST', `/sessions/${session.id}/interrupt`, A, {})); assert.equal(repeatedInterrupt.run.id, finished.run.id); assert.equal(repeatedInterrupt.run.status, 'interrupted');
      o.run = finished.run;
    });
    report.completed = true;
  } catch (error) { report.fatal_error = { message: error.message, stack: error.stack }; throw error; }
  finally {
    if (child && A && session && activeRun && !terminal(activeRun)) { try { await req('POST', `/sessions/${session.id}/interrupt`, A, {}); await awaitRun(activeRun.id, ['interrupted', 'failed', 'completed'], 15000); } catch (error) { report.cleanup_warning = error.message; } }
    if (A && session) { try { await events(); } catch {} }
    await stop(); report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(sourceFiles.map(async p => [p, hash(await readFile(resolve(root, p)))]))); report.source_changed_during_run = sourceFiles.filter(p => report.source_hashes[p] !== report.source_hashes_after[p]);
    await save(); await writeFile(resolve(out, 'server.log'), redact(log)); console.log(`AGENT_REPORT ${resolve(out, 'report.json')}`); console.log(`AGENT_COUNTS ${JSON.stringify(report.counts)}`);
  }
});
