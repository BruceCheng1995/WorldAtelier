import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

// Real signals, real Godot processes and real validator/authority replies only.
// Fixture logic belongs only to this isolated test project, not user content.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = 48921, origin = `http://127.0.0.1:${port}`, api = origin + '/creation-api';
const rid = 'scene-harbor', oid = 'recovery-counter', bid = 'recovery-probe';
const uid = p => `${p}-${randomUUID()}`, delay = ms => new Promise(r => setTimeout(r, ms));
const hash = x => createHash('sha256').update(x).digest('hex');
const stable = x => Array.isArray(x) ? `[${x.map(stable).join(',')}]` : x && typeof x === 'object' ? `{${Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',')}}` : JSON.stringify(x);
const clean = x => Array.isArray(x) ? x.map(clean) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, /^(token|password|code|cap|authorization)$/i.test(k) ? '[redacted]' : clean(v)])) : typeof x === 'string' ? x.replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]') : x;
const componentState = s => s.object_states[oid][bid];
const script = threshold => `extends RefCounted\nfunc initialize(context) -> Dictionary:\n\tif context.role == "authority":\n\t\tcontext.state["counter"] = int(context.state.get("counter",0))\n\t\tcontext.state["interactions"] = int(context.state.get("interactions",0))\n\treturn {"ok":true}\nfunc tick(context, _delta: float) -> Dictionary:\n\tif context.role == "authority":\n\t\tcontext.state["counter"] = int(context.state["counter"]) + 1\n${threshold ? `\t\tif context.state["counter"] >= ${threshold}:\n\t\t\tinner_error()\n` : ''}\treturn {"ok":true}\nfunc interact(context, _player: Dictionary) -> Dictionary:\n\tif context.role == "authority":\n\t\tcontext.state["interactions"] = int(context.state.get("interactions",0)) + 1\n\treturn {"ok":true}\n${threshold ? 'func inner_error():\n\tvar absent = {}\n\treturn absent["missing_field"]\n' : ''}`;
function processes() { return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' }).trim().split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], state: m[4], command: m[5] })); }
async function freePort() { const s = createServer(); await new Promise((yes, no) => { s.once('error', no); s.listen(port, '127.0.0.1', yes); }); await new Promise(r => s.close(r)); }

test('creation recovery: own process-group SIGINT, real authority failure and explicit recovery', { timeout: 240000 }, async t => {
  await freePort();
  const out = resolve(root, '.local/creation-verification/world-recovery', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`), data = await mkdtemp(resolve(tmpdir(), 'atelier-world-recovery-'));
  await mkdir(out, { recursive: true });
  const report = { started_at: new Date().toISOString(), out, data, port, scope: 'Actual own-process-group SIGINT and owned authority SIGKILL; real Godot headless editor binary, HTTP and authenticated WS, passive real worker trace. Generic test behavior only. Agent disabled; not GPU, exported native package or production shutdown acceptance.', cases: [], traffic: [], signals: [], processes: [], source_hashes: {}, completed: false };
  const files = ['services/creation/worlds.mjs', 'services/creation/service.mjs', 'services/creation/realtime.mjs', 'services/preview/server.mjs'];
  for (const f of files) report.source_hashes[f] = hash(await readFile(resolve(root, f)));
  let child, log = '', A, project, runtime, peer, goodAsset, worldId, currentRevision;
  const sockets = new Set(), authorities = new Map();
  const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(clean(report), null, 2) + '\n');
  const documents = kind => { const db = new DatabaseSync(resolve(data, 'creation/creation.sqlite'), { readOnly: true }); try { return db.prepare('SELECT body FROM documents WHERE kind=?').all(kind).map(x => JSON.parse(x.body)); } finally { db.close(); } };
  const storedWorld = () => documents('creator_world').find(w => w.id === worldId);
  function failureEntry(saved, kind) { assert.equal(saved.failure.kind, kind); assert.ok(saved.failure_history.includes(saved.failure.id)); const entry = documents('creator_world_failure').find(f => f.id === saved.failure.id); assert.ok(entry); assert.equal(entry.kind, kind); assert.equal(entry.world_id, saved.id); assert.equal(entry.epoch, saved.epoch); assert.equal(entry.revision, saved.revision); assert.equal(entry.runtime_build_id, saved.runtime_build_id); assert.equal(entry.snapshot_hash, hash(stable(saved.snapshot))); return entry; }
  const actualWire = async () => (await readFile(resolve(out, 'worker-wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const authorityList = () => processes().filter(p => p.ppid === child?.pid && p.command.includes('--authority'));
  function authority() { const list = authorityList(); assert.equal(list.length, 1, 'One actual Godot authority'); authorities.set(list[0].pid, list[0]); return list[0]; }
  async function waitUntil(predicate, timeout = 6000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const x = await predicate(); if (x) return x; await delay(25); } throw Error('Condition timeout'); }
  async function start() {
    await freePort();
    const env = { ...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: data, WORLD_ATELIER_CREATION_DATA: resolve(data, 'creation'), WORLD_ATELIER_DISABLE_AGENT: '1', WORLD_ATELIER_TEST_WORKER_TRACE: resolve(out, 'worker-wire.jsonl') }; delete env.WORLD_ATELIER_DISABLE_WORLDS;
    child = spawn(process.execPath, ['--import', './tests/creation/observe-worker.mjs', 'services/preview/server.mjs'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { pid: child.pid, started_at: Date.now() }; report.processes.push(entry);
    child.stdout.on('data', b => { log += `[${entry.pid}] ${b}`; }); child.stderr.on('data', b => { log += `[${entry.pid}] ${b}`; }); child.once('exit', (code, signal) => Object.assign(entry, { exit_code: code, signal, stopped_at: Date.now() }));
    await waitUntil(async () => { if (child.exitCode !== null) throw Error(log); try { const r = await fetch(api + '/health'); if (r.ok) return true; } catch {} return false; });
    const processRow = processes().find(p => p.pid === child.pid); assert.equal(processRow.pgid, child.pid); Object.assign(entry, { pgid: processRow.pgid });
  }
  async function stop(groupSignal = false) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const own = child, exit = new Promise(r => own.once('exit', r));
    const processRow = processes().find(p => p.pid === own.pid); assert.equal(processRow.pgid, own.pid); assert.ok(own.pid > 1);
    report.signals.push({ at: Date.now(), signal: groupSignal ? 'SIGINT' : 'SIGTERM', target: groupSignal ? -own.pid : own.pid, verified_process: processRow, group_members: processes().filter(p => p.pgid === own.pid) });
    if (groupSignal) process.kill(-own.pid, 'SIGINT'); else own.kill('SIGTERM');
    const force = setTimeout(() => own.kill('SIGKILL'), 12000); await exit; clearTimeout(force); await freePort();
  }
  async function request(method, path, input, raw = false) {
    const headers = { origin, 'content-type': raw ? 'application/octet-stream' : 'application/json' }; if (A) headers.authorization = `Bearer ${A.token}`; if (raw) headers['x-asset-name'] = encodeURIComponent(input.name);
    const r = await fetch(api + path, { method, headers, body: input === undefined ? undefined : raw ? input.bytes : JSON.stringify(input) }); const value = await r.json(); report.traffic.push(clean({ at: Date.now(), method, path, input: raw ? { name: input.name, sha256: hash(input.bytes) } : input, status: r.status, value })); return { status: r.status, value };
  }
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(clean(r.value))); return r.value; };
  const path = () => `/projects/${project.project.id}/branches/main`;
  const asset = source => request('POST', `/projects/${project.project.id}/assets`, { name: uid('recovery-module') + '.gd', bytes: Buffer.from(source) }, true).then(x => ok(x, 201));
  const components = a => ({ interactable: { radius: 12, label: 'Independent recovery counter' }, behaviors: [{ id: bid, api: 1, script_hash: a.id, script_url: a.url, properties: {} }] });
  async function patch(a) { const b = ok(await request('GET', path())), o = b.manifest.resources[rid].objects.find(x => x.id === oid); const changed = ok(await request('POST', path() + '/transactions', { transaction_id: uid('recovery-change'), base_revision: b.head, ops: [{ type: 'patch_object', resource_id: rid, object_id: oid, expected_version: o.version, patch: { components: components(a) } }] })); currentRevision = changed.revision; return changed; }
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/creation`, { origin }), messages = []; sockets.add(ws); const p = { ws, messages, seq: 0 };
    ws.on('error', () => {}); ws.on('message', b => { const packet = JSON.parse(b.toString()); messages.push(packet); report.traffic.push(clean({ at: Date.now(), transport: 'ws', packet })); });
    p.send = packet => { report.traffic.push(clean({ at: Date.now(), transport: 'ws-send', packet })); ws.send(JSON.stringify(packet)); };
    p.wait = async (predicate, mark = 0, timeout = 5000) => waitUntil(() => messages.slice(mark).find(predicate), timeout);
    p.current = () => messages.findLast(m => m.type === 'world' && m.packet?.action === 'snapshot')?.packet.snapshot;
    await new Promise((yes, no) => { ws.once('open', yes); ws.once('error', no); }); p.send({ type: 'auth', token: A.token }); await p.wait(m => m.type === 'authenticated');
    p.send({ type: 'subscribe', project_id: project.project.id, branch_id: 'main', resource_id: rid, generation: 1 }); assert.equal((await p.wait(m => m.type === 'baseline' || m.type === 'error')).type, 'baseline'); return p;
  }
  const snapshot = (p, predicate, mark = p.messages.length, timeout = 5000) => p.wait(m => m.type === 'world' && m.packet?.action === 'snapshot' && predicate(m.packet.snapshot), mark, timeout).then(m => m.packet.snapshot);
  async function join(p, expect = 'world') { const mark = p.messages.length; p.send({ type: 'world_join', project_id: project.project.id, branch_id: 'main', resource_id: rid, runtime_build_id: runtime.build_id }); const response = await p.wait(m => m.type === 'world' && m.packet?.action === 'join' || m.type === 'error', mark, 70000); assert.equal(response.type, expect, JSON.stringify(clean(response))); if (expect === 'world') { await snapshot(p, s => s.players[A.user.id]?.online, mark); p.seq = p.current().players[A.user.id].last_input_seq; worldId = response.packet.world_id; } else assert.equal(response.status, 422); return response; }
  function input(move, extra = {}) { const s = peer.current(), seq = ++peer.seq; peer.send({ type: 'world_input', input: { world_id: s.world_id, epoch: s.epoch, scene_revision: s.scene_revision, input_seq: seq, move, ...extra } }); return seq; }
  async function zero() { const mark = peer.messages.length, seq = input([0, 0]); return snapshot(peer, s => s.players[A.user.id].last_input_seq >= seq && Math.hypot(s.players[A.user.id].velocity[0], s.players[A.user.id].velocity[2]) < .01, mark); }
  async function copyVerification(v) {
    assert.ok(v.evidence?.report); await mkdir(resolve(out, 'validators'), { recursive: true });
    const actual = JSON.parse(await readFile(v.evidence.report, 'utf8')), logText = await readFile(v.evidence.log, 'utf8'), candidate = JSON.parse(await readFile(resolve(dirname(v.evidence.report), 'candidate.json'), 'utf8'));
    await writeFile(resolve(out, 'validators', v.id + '.json'), JSON.stringify(clean({ verification: v, candidate, actual }), null, 2)); await writeFile(resolve(out, 'validators', v.id + '.log'), clean(logText));
    assert.equal(v.state_hash, hash(stable(candidate.state))); if (v.status === 'passed') { assert.equal(v.process.code, 0); assert.equal(actual.ok, true); assert.equal(actual.completed, true); assert.equal(/SCRIPT ERROR|Parse Error|ERROR:/.test(logText), false); } return { candidate, actual, log: logText };
  }
  async function publish(expect = 200) { const result = await request('POST', path() + '/publish', { revision: currentRevision, resource_id: rid }); assert.equal(result.status, expect, JSON.stringify(clean(result.value))); const v = result.value.verification ?? result.value.details?.verification; assert.ok(v); await copyVerification(v); return result.value; }
  async function step(id, title, fn, fatal = true) { const row = { id, title, status: 'running', observations: {}, started_at: Date.now() }; report.cases.push(row); await t.test(id + ' ' + title, async () => { try { await fn(row.observations); row.status = 'passed'; } catch (e) { row.status = 'failed'; row.error = { message: e.message, stack: e.stack }; throw e; } finally { row.finished_at = Date.now(); await save(); console.log('WORLD_RECOVERY_CASE ' + id + ' ' + row.status); } }); if (fatal && row.status !== 'passed') throw Error('Cannot safely continue after ' + id); }
  try {
    await start(); A = ok(await request('POST', '/auth/register', { name: uid('recovery-owner'), password: uid('password') }), 201); project = ok(await request('POST', '/projects', { name: uid('Independent world recovery'), template: 'empty' }), 201); report.project_id = project.project.id;
    goodAsset = await asset(script()); const changed = ok(await request('POST', path() + '/transactions', { transaction_id: uid('recovery-fixture'), base_revision: project.branch.head, ops: [{ type: 'put_object', resource_id: rid, object_id: oid, expected_version: null, object: { id: oid, name: 'Independent recovery fixture', kind: 'anchor', position: [0, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1], components: components(goodAsset) } }] })); currentRevision = changed.revision;
    await step('CR01', 'actual runtime, authority and persisted gameplay before signal tests', async o => {
      runtime = await (await fetch(origin + '/preview-runtime/manifest.json')).json(); report.runtime_build_id = runtime.build_id; report.runtime_sources = runtime.sources;
      for (const f of runtime.sources) assert.equal(hash(await readFile(resolve(root, 'runtimes/model-preview', f.path))), f.sha256);
      peer = await connect(); await join(peer); await snapshot(peer, s => s.players[A.user.id].grounded);
      for (let i = 0; i < 3; i++) { input([.4, 0]); await delay(100); } await zero();
      const mark = peer.messages.length, seq = input([0, 0], { interact: true }); await snapshot(peer, s => s.players[A.user.id].last_input_seq >= seq && componentState(s).interactions === 1, mark); await zero();
      o.state = peer.current(); o.authority = authority(); assert.ok(o.state.players[A.user.id].position[0] > .3);
    });
    await step('CR02', 'real own-group SIGINT saves the actual checkpoint and same-head join recovers', async o => {
      const before = peer.current(), oldService = child.pid, beforeAuthority = authority(); o.before = before; o.authority_process_group = beforeAuthority;
      assert.notEqual(beforeAuthority.pgid, child.pid, 'Godot authority must be isolated from the parent terminal signal group');
      await stop(true); assert.equal(report.processes.find(p => p.pid === oldService).exit_code, 0); assert.ok(!processes().some(p => p.pid === beforeAuthority.pid)); const saved = storedWorld(), wire = await actualWire();
      const shutdown = wire.findLast(x => x.server_pid === oldService && x.direction === 'node_to_godot' && x.packet.type === 'shutdown'); assert.ok(shutdown?.packet.request_id, 'Real shutdown command');
      const checkpoint = wire.find(x => x.direction === 'godot_to_node' && x.packet.type === 'checkpoint' && x.packet.request_id === shutdown.packet.request_id); assert.equal(checkpoint?.packet.ok, true); assert.deepEqual(saved.snapshot, checkpoint.packet.snapshot); assert.ok(!saved.failure); assert.deepEqual(saved.failure_history, []); assert.equal(saved.revision, currentRevision);
      await start(); peer = await connect(); await join(peer); const after = peer.current(); assert.equal(after.world_id, before.world_id); assert.equal(after.epoch, before.epoch + 1); assert.equal(after.scene_revision, currentRevision); assert.equal(componentState(after).interactions, 1); assert.ok(componentState(after).counter >= componentState(saved.snapshot).counter);
      assert.equal(after.players[A.user.id].last_input_seq, saved.snapshot.players[A.user.id].last_input_seq); for (const n of [0, 2]) assert.ok(Math.abs(after.players[A.user.id].position[n] - saved.snapshot.players[A.user.id].position[n]) < .02);
      const v = documents('creator_verification').filter(v => v.started_at >= report.processes.at(-1).started_at).sort((a, b) => a.started_at - b.started_at)[0], verified = await copyVerification(v); assert.deepEqual(verified.candidate.state, saved.snapshot);
      Object.assign(o, { old_service_pid: oldService, saved, actual_shutdown: shutdown, actual_checkpoint: checkpoint, restored: after, restored_authority: authority(), restore_verification: v });
    });
    await step('CR03', 'abnormal real authority exit blocks auto join but explicit validated publication restores', async o => {
      await zero(); const before = peer.current(), actual = authority(); assert.equal(actual.ppid, child.pid); report.signals.push({ at: Date.now(), target: actual.pid, signal: 'SIGKILL', verified_process: actual }); process.kill(actual.pid, 'SIGKILL');
      const failed = await waitUntil(() => storedWorld()?.failure && storedWorld()); await waitUntil(() => !processes().some(p => p.pid === actual.pid)); const archivedFailure = failureEntry(failed, 'infrastructure');
      const rejected = await join(peer, 'error'); assert.equal(authorityList().length, 0);
      const publicationRequest = request('POST', path() + '/publish', { revision: currentRevision, resource_id: rid });
      const validatorProcess = await waitUntil(() => processes().find(p => p.ppid === child.pid && p.command.includes('--validate-scene=')));
      const mark = peer.messages.length; peer.send({ type: 'world_join', project_id: project.project.id, branch_id: 'main', resource_id: rid, runtime_build_id: runtime.build_id });
      const [published, duringRecovery] = await Promise.all([publicationRequest, peer.wait(m => m.type === 'error' || m.type === 'world' && m.packet?.action === 'join', mark)]);
      assert.equal(duringRecovery.type, 'error'); assert.ok([409, 422].includes(duringRecovery.status), 'Concurrent join is quarantined during validation (422) or locked during start/ACK (409), never borrowing recovery permission');
      const result = ok(published); await copyVerification(result.verification); assert.equal(result.verification.status, 'passed'); await join(peer); const after = peer.current(), recovered = storedWorld(); assert.ok(!recovered.failure); assert.equal(after.world_id, before.world_id); assert.equal(after.epoch, before.epoch + 1); assert.equal(after.scene_revision, currentRevision); assert.equal(componentState(after).interactions, 1);
      assert.ok(recovered.failure_history.includes(archivedFailure.id)); assert.deepEqual(documents('creator_world_failure').find(f => f.id === archivedFailure.id), archivedFailure);
      Object.assign(o, { killed_authority: actual, failed, immutable_failure: archivedFailure, auto_join_rejection: rejected, actual_recovery_validator: validatorProcess, concurrent_join_rejection: duringRecovery, publication: result, recovered, restored: after, new_authority: authority() });
    });
    await step('CR04', 'late VM fault cannot restart automatically or repeatedly pass explicit validation', async o => {
      const before = peer.current(), threshold = componentState(before).counter + 180, bad = await asset(script(threshold)); await patch(bad); const result = await publish(); assert.equal(result.verification.status, 'passed');
      await snapshot(peer, s => s.scene_revision === currentRevision); const running = authority(), failure = await waitUntil(() => storedWorld()?.failure && storedWorld(), 12000); await waitUntil(() => !processes().some(p => p.pid === running.pid)); const archivedFailure = failureEntry(failure, 'behavior'); assert.ok(archivedFailure.runtime_fault);
      const wire = await actualWire(), faultPackets = wire.filter(x => x.direction === 'godot_to_node' && (x.packet.type === 'world_events' && x.packet.events.some(e => e.kind === 'runtime_fault') || x.packet.type === 'world_snapshot' && Object.keys(x.packet.snapshot?.runtime_fault ?? {}).length)); assert.ok(faultPackets.length, 'Actual Godot runtime fault, not a fabricated failure record');
      o.rejects = []; for (let i = 0; i < 3; i++) { o.rejects.push(await join(peer, 'error')); await delay(150); assert.equal(authorityList().length, 0); }
      await stop(); await start(); peer = await connect(); o.after_restart_rejection = await join(peer, 'error'); assert.equal(authorityList().length, 0);
      const failedValidation = ok(await request('POST', path() + '/validate', { revision: currentRevision, resource_id: rid })); await copyVerification(failedValidation); assert.equal(failedValidation.status, 'failed');
      const failedPublication = await request('POST', path() + '/publish', { revision: currentRevision, resource_id: rid }); assert.equal(failedPublication.status, 422); assert.equal(authorityList().length, 0); assert.ok(storedWorld().failure);
      assert.deepEqual(storedWorld().failure_history, failure.failure_history); assert.deepEqual(documents('creator_world_failure').find(f => f.id === archivedFailure.id), archivedFailure);
      Object.assign(o, { threshold, bad_asset: bad, initial_real_validation: result.verification, failure, immutable_failure: archivedFailure, actual_runtime_fault_packets: faultPackets, failed_explicit_validation: failedValidation, failed_publication: failedPublication });
    });
    await step('CR05', 'fixed source explicitly recovers after the retained runtime failure', async o => {
      const failed = storedWorld(); await patch(goodAsset); const result = await publish(); await join(peer); const after = peer.current(), saved = storedWorld();
      assert.equal(result.verification.status, 'passed'); assert.ok(!saved.failure); assert.deepEqual(saved.failure_history, failed.failure_history); assert.equal(after.world_id, failed.id); assert.equal(after.epoch, failed.epoch + 1); assert.equal(after.scene_revision, currentRevision); assert.equal(componentState(after).interactions, 1); assert.equal(Object.keys(after.runtime_fault).length, 0);
      Object.assign(o, { failed, recovery: result, saved, restored: after, authority: authority() });
    });
    report.completed = report.cases.every(c => c.status === 'passed');
  } catch (e) { report.fatal_error = { message: e.message, stack: e.stack }; throw e; }
  finally {
    await stop(); for (const ws of sockets) ws.terminate();
    report.authorities = [...authorities.values()]; report.remaining_owned_authorities = processes().filter(p => authorities.has(p.pid)); report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(files.map(async f => [f, hash(await readFile(resolve(root, f)))]))); report.source_changed_during_run = files.filter(f => report.source_hashes[f] !== report.source_hashes_after[f]);
    await save(); await writeFile(resolve(out, 'server.log'), clean(log)); await writeFile(resolve(out, 'executed-driver.mjs'), await readFile(fileURLToPath(import.meta.url))); await writeFile(resolve(out, 'executed-observer.mjs'), await readFile(resolve(root, 'tests/creation/observe-worker.mjs')));
    console.log('WORLD_RECOVERY_REPORT ' + resolve(out, 'report.json')); console.log('WORLD_RECOVERY_COUNTS ' + JSON.stringify(report.counts));
  }
});
