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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), port = 48921, origin = `http://127.0.0.1:${port}`, api = origin + '/creation-api';
const pause = ms => new Promise(yes => setTimeout(yes, ms)), uid = p => `${p}-${randomUUID()}`, hash = value => createHash('sha256').update(value).digest('hex');
const redact = value => Array.isArray(value) ? value.map(redact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(token|password|code|email|account|authorization|access_token|refresh_token|id_token|api_key|cap)$/i.test(k) ? '[redacted]' : redact(v)])) : typeof value === 'string' ? value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]').replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]') : value;
async function freePort() { const server = createServer(); await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); await new Promise(yes => server.close(yes)); }

test('real creation manager cancellation drains owned terminal before reopening session', { timeout: 180000 }, async t => {
  await freePort(); const out = resolve(root, '.local/creation-verification/agent-cancel', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`), data = await mkdtemp(resolve(tmpdir(), 'atelier-creation-cancel-')); await mkdir(out, { recursive: true });
  const report = { started_at: new Date().toISOString(), root, port, data, node: process.version, scope: 'real bounded Codex command via creation HTTP manager; worlds disabled; no synthetic executor event or OS signal to native PID', cases: [], events: [], http: [], ws: [], samples: [], processes: [], source_hashes: {}, completed: false };
  const files = ['services/creation/agent-runs.mjs', 'services/creation/cancel-cleanup.mjs', 'services/creation/codex-agent.mjs', 'services/creation/service.mjs', 'services/creation/realtime.mjs', 'services/creation/store.mjs'];
  for (const file of files) report.source_hashes[file] = hash(await readFile(resolve(root, file)));
  report.codex_version = execFileSync(process.env.CODEX_BIN ?? '/opt/homebrew/bin/codex', ['--version'], { encoding: 'utf8' }).trim();
  let child, log = '', user, project, session, workspace, socket, cursor = 0, native, input, run, model, lastMessageId;
  const save = async () => { await writeFile(resolve(out, 'report.json'), JSON.stringify(redact(report), null, 2) + '\n'); await writeFile(resolve(out, 'events.json'), JSON.stringify(redact(report.events), null, 2) + '\n'); };
  async function start() {
    await freePort(); const env = { ...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: data, WORLD_ATELIER_CREATION_DATA: resolve(data, 'creation'), WORLD_ATELIER_DISABLE_WORLDS: '1', WORLD_ATELIER_TEST_CODEX_TRACE: resolve(out, 'codex-rpc.jsonl') }; delete env.WORLD_ATELIER_DISABLE_AGENT;
    child = spawn(process.execPath, ['--import', './tests/creation/observe-codex.mjs', 'services/preview/server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); const record = { pid: child.pid, started_at: Date.now() }; report.processes.push(record);
    child.stdout.on('data', b => { log += `[${record.pid} stdout] ${b}`; }); child.stderr.on('data', b => { log += `[${record.pid} stderr] ${b}`; }); child.once('exit', (exit_code, signal) => Object.assign(record, { exit_code, signal, stopped_at: Date.now() }));
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error(log); try { const response = await fetch(api + '/health'); if (response.ok) return response.json(); } catch {} await pause(50); } throw Error('Service startup timeout');
  }
  async function stop() { socket?.terminate(); if (!child || child.exitCode !== null || child.signalCode !== null) return; const own = child, gone = new Promise(yes => own.once('exit', yes)); own.kill('SIGTERM'); const timer = setTimeout(() => own.kill('SIGKILL'), 15000); await gone; clearTimeout(timer); await freePort(); }
  async function req(method, path, body, authenticated = true) { const headers = { origin, 'content-type': 'application/json' }; if (authenticated && user) headers.authorization = `Bearer ${user.token}`; const response = await fetch(api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); const value = await response.json(); report.http.push(redact({ at: Date.now(), method, path, body, status: response.status, value })); return { status: response.status, value }; }
  const ok = (value, expected = 200) => { assert.equal(value.status, expected, JSON.stringify(redact(value.value))); return value.value; };
  const view = () => req('GET', `/sessions/${session.id}`).then(ok);
  async function events() { const list = ok(await req('GET', `/sessions/${session.id}/events?after=${cursor}`)).events; for (const e of list) { assert.ok(e.cursor > cursor); cursor = e.cursor; report.events.push(e); } if (list.length === 500) return events(); }
  async function waitFor(predicate, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { await events(); const current = await view(); const selected = current.runs.find(r => r.id === run.id); if (predicate(selected, current)) return { run: selected, session: current }; await pause(60); } throw Error('Real cancellation state did not meet required gate; no goal replay'); }
  async function sample(label) {
    let ps = null; try { ps = execFileSync('/bin/ps', ['-ww', '-p', String(native.pid), '-o', 'pid=,ppid=,pgid=,stat=,lstart=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null; } catch (error) { ps = error.stdout?.toString().trim() || null; }
    const beats = await readFile(resolve(workspace, 'heartbeat.log'), 'utf8').catch(() => ''), rows = beats.trim().split('\n').filter(Boolean); const value = { at: Date.now(), label, ps, heartbeat_count: rows.length, last_heartbeat: rows.at(-1), finished: await stat(resolve(workspace, 'finished.txt')).then(() => true, () => false) }; report.samples.push(value); return value;
  }
  async function step(id, title, fn, fatal = false) { const row = { id, title, status: 'running', started_at: Date.now(), observations: {} }; report.cases.push(row); await t.test(`${id} ${title}`, async () => { try { await fn(row.observations); row.status = 'passed'; } catch (error) { row.status = 'failed'; row.error = { message: error.message, stack: error.stack }; throw error; } finally { row.finished_at = Date.now(); await save(); console.log(`CANCEL_CASE ${id} ${row.status}`); } }); if (fatal && row.status !== 'passed') throw Error(`Stopped at ${id}; no automatic replacement goal`); }
  try {
    report.health = await start(); user = ok(await req('POST', '/auth/register', { name: uid('cancel-owner'), password: uid('password') }, false), 201); project = ok(await req('POST', '/projects', { name: uid('Cancellation isolated fixture'), template: 'empty' }), 201); session = ok(await req('POST', `/projects/${project.project.id}/branches/main/sessions`, { title: 'Actual cancellation gate probe' }), 201);
    workspace = resolve(data, 'creation/workspaces', project.project.id, 'main', user.user.id, session.id); await mkdir(workspace, { recursive: true }); report.workspace = workspace; report.creator_session_id = session.id;
    const marker = uid('owned-fixture'), script = `import os,time,json\nfrom pathlib import Path\nstart=time.time()\nPath('started.json').write_text(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'start':start,'marker':'${marker}'}))\nprint('CANCEL_PROBE_READY',flush=True)\nwhile time.time()-start < 18:\n with open('heartbeat.log','a') as f:f.write(str(time.time())+'\\n')\n time.sleep(0.2)\nPath('finished.txt').write_text('natural completion')\n`;
    await writeFile(resolve(workspace, 'cancel_probe.py'), script); await writeFile(resolve(out, 'fixture.py'), script);
    await step('CC01', 'real model and private WS subscription with worlds explicitly disabled', async o => {
      assert.equal(report.health.worlds_ready, false); const status = ok(await req('GET', '/agent/status')); assert.equal(status.ready, true); assert.equal(status.authenticated, true); model = status.default_model; assert.ok(status.models.some(x => x.model === model)); report.model = model;
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws/creation`, { origin }); socket.on('message', b => report.ws.push(redact(JSON.parse(b.toString())))); socket.on('error', () => {}); await new Promise((yes, no) => { socket.once('open', yes); socket.once('error', no); }); socket.send(JSON.stringify({ type: 'auth', token: user.token }));
      const until = Date.now() + 3000; while (!report.ws.some(x => x.type === 'authenticated') && Date.now() < until) await pause(10); assert.ok(report.ws.some(x => x.type === 'authenticated'));
      socket.send(JSON.stringify({ type: 'subscribe', project_id: project.project.id, branch_id: 'main', resource_id: 'scene-harbor', generation: 1 })); socket.send(JSON.stringify({ type: 'session_subscribe', session_id: session.id, after: 0 }));
      while (!report.ws.some(x => x.type === 'baseline') && Date.now() < until) await pause(10); assert.ok(report.ws.some(x => x.type === 'baseline')); const ping = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 10000); ping.unref(); socket.once('close', () => clearInterval(ping)); o.model = model;
    }, true);
    await step('CC02', 'actual command interrupt, late-start observation, exact terminate and next-turn gate', async o => {
      input = { client_user_message_id: uid('cancel-message'), model, text: 'This is an authorized bounded cancellation test in this dedicated workspace. Execute exactly one normal foreground command `python3 cancel_probe.py` using your normal command tool. The test script is already present. Do not modify it, background the shell, retry the command, create other content, use world tools, or send messages elsewhere. Stay with the command until completion or interruption. The host will cancel as soon as the actual process starts.' };
      const started = ok(await req('POST', `/sessions/${session.id}/turns`, input), 202); run = started.run; report.start = started;
      const until = Date.now() + 90000; while (Date.now() < until) { try { native = JSON.parse(await readFile(resolve(workspace, 'started.json'), 'utf8')); break; } catch {} await pause(2); } assert.equal(native?.marker, marker, 'Actual owned native command did not start');
      report.native = native; report.interrupt_at = Date.now(); const cancel = ok(await req('POST', `/sessions/${session.id}/interrupt`, {})); report.interrupt_response = cancel;
      const gateInput = { client_user_message_id: uid('blocked-next-message'), model, text: 'This message probes a cancellation gate and must be rejected. If it is unexpectedly executed, do not run tools or modify anything; state that the gate failed.' }; lastMessageId = gateInput.client_user_message_id; const gate = await req('POST', `/sessions/${session.id}/turns`, gateInput); o.gate = gate; assert.equal(gate.status, 409);
      const before = await sample('after_interrupt_response'); const settled = await waitFor(r => r.status === 'interrupted' && r.cleanup_status === 'verified'); run = settled.run; o.run = run;
      await events(); const terminal = report.events.find(e => e.kind === 'notification' && e.method === 'turn/completed' && e.params?.turn?.id === run.turn_id && e.params.turn.status === 'interrupted'); assert.ok(terminal);
      const commands = report.events.filter(e => e.kind === 'notification' && e.method === 'item/started' && e.params?.turnId === run.turn_id && e.params.item?.type === 'commandExecution'); assert.equal(commands.length, 1); const command = commands[0].params.item;
      const late = commands.filter(e => e.cursor > terminal.cursor); o.late_started = late.map(e => ({ cursor: e.cursor, at: e.at, item_id: e.params.item.id })); o.terminal = { at: terminal.at, cursor: terminal.cursor }; report.late_start_observed = late.length > 0;
      assert.ok(run.cleanup_result.commands.some(c => c.itemId === command.id && c.processId === command.processId && c.terminationConfirmed));
      const calls = (await readFile(resolve(out, 'codex-rpc.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse), terminate = calls.filter(c => c.direction === 'request' && c.method === 'thread/backgroundTerminals/terminate'); assert.equal(terminate.length, 1); assert.deepEqual(terminate[0].params, { threadId: run.thread_id, processId: command.processId });
      const result = calls.find(c => c.direction === 'result' && c.server_pid === terminate[0].server_pid && c.call_id === terminate[0].call_id); assert.equal(result.value.terminated, true);
      const after = await sample('cleanup_verified'); assert.equal(after.ps, null); assert.equal(after.finished, false); assert.ok(after.heartbeat_count >= before.heartbeat_count); o.official_terminate = { request: terminate[0], result }; o.cleanup_sample = after;
    }, true);
    await step('CC03', 'executor remains alive past natural completion deadline without heartbeats or end marker', async o => {
      const baseline = await sample('hold_begin'), until = native.start * 1000 + 19500;
      while (Date.now() < until) { await pause(Math.min(1000, until - Date.now())); await sample('hold'); }
      const after = await sample('past_natural_deadline'); assert.equal(after.ps, null); assert.equal(after.heartbeat_count, baseline.heartbeat_count); assert.equal(after.finished, false); assert.ok(child.exitCode === null && child.signalCode === null);
      const actual = ok(await req('GET', '/agent/status')); assert.equal(actual.connected, true); o.executor_status = { ready: actual.ready, connected: actual.connected }; o.baseline = baseline; o.after = after;
      const replay = ok(await req('POST', `/sessions/${session.id}/turns`, input), 202); assert.equal(replay.replayed, true); assert.equal(replay.run.id, run.id); assert.equal(replay.run.cleanup_status, 'verified'); const current = await view(); assert.equal(current.runs.length, 1); assert.equal(current.messages.some(m => m.client_user_message_id === lastMessageId), false);
    });
    await step('CC04', 'restart preserves verified cleanup and never resubmits the cancelled goal', async o => {
      const before = await view(), processId = child.pid; await stop(); await start(); const restored = await view(); assert.equal(restored.executor_thread_id, before.executor_thread_id); assert.equal(restored.runs.length, 1); assert.equal(restored.runs[0].status, 'interrupted'); assert.equal(restored.runs[0].cleanup_status, 'verified');
      const reconciled = ok(await req('POST', `/sessions/${session.id}/reconcile`, {})); assert.equal(reconciled.reconciliation.canSend, true); assert.equal(reconciled.session.runs[0].cleanup_status, 'verified');
      const replay = ok(await req('POST', `/sessions/${session.id}/turns`, input), 202); assert.equal(replay.replayed, true); assert.equal(replay.run.id, run.id); const repeated = ok(await req('POST', `/sessions/${session.id}/interrupt`, {})); assert.equal(repeated.run.status, 'interrupted'); assert.equal(repeated.run.cleanup_status, 'verified');
      const calls = (await readFile(resolve(out, 'codex-rpc.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); assert.equal(calls.filter(c => c.direction === 'request' && c.method === 'turn/start').length, 1); assert.equal(calls.filter(c => c.direction === 'request' && c.method === 'thread/backgroundTerminals/terminate').length, 1);
      const after = await sample('after_restart_reconcile'); assert.equal(after.ps, null); assert.equal(after.heartbeat_count, report.samples.find(s => s.label === 'cleanup_verified').heartbeat_count); assert.equal(after.finished, false); o.old_service_pid = processId; o.new_service_pid = child.pid; o.reconciliation = reconciled.reconciliation; o.after = after;
    });
    report.completed = report.cases.every(c => c.status === 'passed');
    if (!report.late_start_observed) report.unverified_case = 'This actual run did not reproduce command item/started after turn/completed. Do not count late-start coverage from timing-independent cleanup success.';
  } catch (error) { report.fatal_error = { message: error.message, stack: error.stack }; throw error; }
  finally {
    if (child && user && session && run) { try { await req('POST', `/sessions/${session.id}/interrupt`, {}); await events(); } catch {} }
    // A failed assertion must not let App Server shutdown masquerade as cancellation.
    if (native && Date.now() < native.start * 1000 + 19500) await pause(native.start * 1000 + 19500 - Date.now());
    if (native) await sample('before_service_shutdown'); await stop(); report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(resolve(root, file)))]))); report.source_changed_during_run = files.filter(file => report.source_hashes[file] !== report.source_hashes_after[file]);
    await save(); await writeFile(resolve(out, 'server.log'), redact(log)); await writeFile(resolve(out, 'executed-driver.mjs'), await readFile(fileURLToPath(import.meta.url))); await writeFile(resolve(out, 'executed-observer.mjs'), await readFile(resolve(root, 'tests/creation/observe-codex.mjs')));
    console.log(`CANCEL_REPORT ${resolve(out, 'report.json')}`); console.log(`CANCEL_COUNTS ${JSON.stringify(report.counts)}`);
  }
});
