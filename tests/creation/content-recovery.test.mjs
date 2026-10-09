import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';

// The actual published Agent candidate is copied unchanged through real APIs.
// No behavior fixture, fabricated authority ACK, production mutation or GPU claim.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = 48921, origin = `http://127.0.0.1:${port}`, api = origin + '/creation-api';
const rid = 'scene-harbor', anchor = 'anchor-0508f749-1d19-4765-9821-c79a3f01a4de', behavior = 'step-celebration-v1';
const expectedRevision = 'src-efba4a3a0ff7be1268079874a4dbcf996407cfa0966ceaa1a542311ca5012c60';
const legacy = process.env.WORLD_ATELIER_CONTACT_MODE === 'legacy';
const legacyBuild = '680cd7a5a2b5e07654e24e0840e6279ba0478301d6848db0d52c22545c04bb9d';
const uid = p => `${p}-${randomUUID()}`, delay = ms => new Promise(r => setTimeout(r, ms));
const hash = x => createHash('sha256').update(x).digest('hex');
const clean = x => Array.isArray(x) ? x.map(clean) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, /^(token|password|code|cap|authorization)$/i.test(k) ? '[redacted]' : clean(v)])) : typeof x === 'string' ? x.replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]') : x;
const semantic = x => Array.isArray(x) ? x.map(semantic) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'version').map(([k, v]) => [k, semantic(v)])) : x;
const state = s => s.object_states[anchor]?.[behavior];
const observation = s => ({ world_id: s.world_id, epoch: s.epoch, scene_revision: s.scene_revision, sequence: s.sequence, tick: s.tick, event_sequence: s.event_sequence, players: s.players, trigger: state(s), trigger_contacts: s.trigger_contacts, module_assets: s.module_assets, runtime_fault: s.runtime_fault });
async function freePort() { const server = createServer(); await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); await new Promise(r => server.close(r)); }
function processes() { return execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' }).trim().split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], state: m[3], command: m[4] })); }

test(legacy ? 'actual old 680 runtime checkpoint migrates its missing contact ledger on the new runtime' : 'actual published fireworks: checkpoint restore and offline rejoin preserve contact identity', { timeout: 210000 }, async t => {
  assert.match(process.env.WORLD_ATELIER_EXPECT_RUNTIME_BUILD ?? '', /^[a-f0-9]{64}$/, 'Run only after the integration owner provides a frozen runtime build');
  if (legacy) assert.ok(process.env.WORLD_ATELIER_LEGACY_CODE_ROOT && resolve(process.env.WORLD_ATELIER_LEGACY_CODE_ROOT) !== root, 'Legacy runtime uses a separate owned source snapshot');
  await freePort();
  const out = resolve(root, '.local/creation-verification', legacy ? 'content-legacy-recovery' : 'content-recovery', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-content-recovery-'));
  await mkdir(out, { recursive: true });
  const artifactPath = resolve(root, '.local/creation-verification/browser/first-content-delivery.json');
  const artifactBytes = await readFile(artifactPath), published = JSON.parse(artifactBytes);
  assert.equal(published.source_revision, expectedRevision);
  const report = { started_at: new Date().toISOString(), out, data, port, scope: 'Exact actual Agent-authored content imported into an independent API project; real Godot editor binary --headless --path authority, two authenticated protocol clients. Real process shutdown/checkpoint/restore and real offline rejoin, original scripts unmodified. No browser/GPU or universal behavior claim.', source_artifact: { path: artifactPath, sha256: hash(artifactBytes), revision: published.source_revision }, cases: [], traffic: [], timeline: [], assets: [], services: [], signals: [], source_hashes: {}, completed: false };
  report.mode = legacy ? 'actual_old_runtime_missing_ledger_migration' : 'new_ledger_persistence_and_presence';
  if (legacy) report.scope = 'Exact original published content; first authority actually runs immutable 680 source and produces a real shutdown checkpoint without trigger_contacts. A second owned service on the frozen new runtime restores those same persisted bytes. No manual checkpoint edit, fake worker ACK, Agent execution or GPU claim.';
  const sourceFiles = ['services/creation/worlds.mjs', 'services/creation/realtime.mjs', 'services/creation/store.mjs', 'services/creation/service.mjs', 'services/preview/server.mjs', 'runtimes/model-preview/world_simulation.gd', 'runtimes/model-preview/authority_worker.gd', 'runtimes/model-preview/behavior_registry.gd'];
  for (const f of sourceFiles) report.source_hashes[f] = hash(await readFile(resolve(root, f)));
  let child, log = '', A, B, project, runtime, peerA, peerB, worldId, savedCheckpoint, preStop, beforeService, activeCodeRoot = root;
  const sockets = new Set(), authorities = new Map();
  const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(clean(report), null, 2) + '\n');
  const record = (label, snapshot) => { const row = { at: Date.now(), label, ...observation(snapshot) }; report.timeline.push(row); return row; };
  const stable = x => Array.isArray(x) ? `[${x.map(stable).join(',')}]` : x && typeof x === 'object' ? `{${Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',')}}` : JSON.stringify(x);
  const documents = kind => { const db = new DatabaseSync(resolve(data, 'creation/creation.sqlite'), { readOnly: true }); try { return db.prepare('SELECT body FROM documents WHERE kind=?').all(kind).map(x => JSON.parse(x.body)); } finally { db.close(); } };
  const storedWorld = () => documents('creator_world').find(w => w.id === worldId);
  const wire = async () => (await readFile(resolve(out, 'worker-wire.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  function authority() { const rows = processes().filter(p => p.ppid === child?.pid && p.command.includes('--authority')); assert.equal(rows.length, 1, 'One real owned Godot authority'); authorities.set(rows[0].pid, rows[0]); return rows[0]; }
  function platformContact(s, player, expected) {
    // Frozen platform handoff: schema 1, object-keyed members and legacy_pending.
    assert.ok(s.trigger_contacts && typeof s.trigger_contacts === 'object', 'Actual snapshot includes the platform contact ledger');
    assert.equal(s.trigger_contacts.schema, 1);
    assert.ok(s.trigger_contacts.members && typeof s.trigger_contacts.members === 'object');
    assert.ok(Array.isArray(s.trigger_contacts.legacy_pending));
    const ids = s.trigger_contacts.members[anchor] ?? [];
    assert.ok(Array.isArray(ids), 'Platform ledger stores player IDs per trigger object');
    assert.equal(ids.includes(player), expected, 'Platform spatial contact is separate from behavior inside_players');
  }
  const sameXZ = (a, b) => { for (const n of [0, 2]) assert.ok(Math.abs(a.position[n] - b.position[n]) < .02, 'Saved player XZ is preserved'); };
  async function waitUntil(predicate, timeout = 7000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const v = await predicate(); if (v) return v; await delay(25); } throw Error('Condition timeout'); }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const own = child, row = processes().find(p => p.pid === own.pid);
    assert.ok(row && row.command.includes('services/preview/server.mjs')); assert.ok(own.pid > 1);
    report.signals.push({ at: Date.now(), target: own.pid, signal: 'SIGTERM', verified_process: row, open_test_sockets: [...sockets].filter(s => s.readyState === WebSocket.OPEN).length });
    const ended = new Promise(r => own.once('exit', r)); own.kill('SIGTERM'); const force = setTimeout(() => { report.signals.push({ at: Date.now(), target: own.pid, signal: 'SIGKILL', reason: 'owned service shutdown timeout' }); own.kill('SIGKILL'); }, 12000); await ended; clearTimeout(force);
    await waitUntil(() => !processes().some(p => authorities.has(p.pid)));
    if (worldId) { try { await writeFile(resolve(out, `authority-server-${own.pid}.log`), clean(await readFile(resolve(data, 'creation/worlds', worldId + '.log'), 'utf8'))); } catch {} }
    await freePort();
  }
  async function start() {
    await freePort();
    activeCodeRoot = legacy && report.services.length === 0 ? resolve(process.env.WORLD_ATELIER_LEGACY_CODE_ROOT) : root;
    const env = { ...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: data, WORLD_ATELIER_CREATION_DATA: resolve(data, 'creation'), WORLD_ATELIER_DISABLE_AGENT: '1', WORLD_ATELIER_TEST_WORKER_TRACE: resolve(out, 'worker-wire.jsonl') }; delete env.WORLD_ATELIER_DISABLE_WORLDS;
    child = spawn(process.execPath, ['--import', './tests/creation/observe-worker.mjs', 'services/preview/server.mjs'], { cwd: activeCodeRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { pid: child.pid, code_root: activeCodeRoot, started_at: Date.now() }; report.services.push(entry); child.stdout.on('data', b => { log += `[${entry.pid}] ${b}`; }); child.stderr.on('data', b => { log += `[${entry.pid}] ${b}`; }); child.once('exit', (code, signal) => Object.assign(entry, { exit_code: code, signal, stopped_at: Date.now() }));
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error(log); try { const r = await fetch(api + '/health'); if (r.ok) return r.json(); } catch {} await delay(50); } throw Error('Independent service startup timeout');
  }
  async function request(method, path, user = A, input, raw = false) {
    const headers = { origin, 'content-type': raw ? 'application/octet-stream' : 'application/json' }; if (user) headers.authorization = `Bearer ${user.token}`; if (raw) headers['x-asset-name'] = encodeURIComponent(input.name);
    const r = await fetch(api + path, { method, headers, body: input === undefined ? undefined : raw ? input.bytes : JSON.stringify(input) }); const value = await r.json();
    report.traffic.push(clean({ at: Date.now(), method, path, actor: user?.user?.id, input: raw ? { name: input.name, sha256: hash(input.bytes), bytes: input.bytes.length } : input, status: r.status, value })); return { status: r.status, value };
  }
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(clean(r.value))); return r.value; };
  const branchPath = () => `/projects/${project.project.id}/branches/main`;
  async function connect(user) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/creation`, { origin }), messages = []; sockets.add(ws);
    const peer = { ws, user, messages, inputSeq: 0 };
    ws.on('error', () => {}); ws.on('message', bytes => { const packet = JSON.parse(bytes.toString()); messages.push(packet); report.traffic.push(clean({ at: Date.now(), transport: 'ws', actor: user.user.id, packet })); });
    peer.send = packet => { report.traffic.push(clean({ at: Date.now(), transport: 'ws-send', actor: user.user.id, packet })); ws.send(JSON.stringify(packet)); };
    peer.wait = async (predicate, mark = 0, timeout = 5000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const match = messages.slice(mark).find(predicate); if (match) return match; await delay(10); } throw Error('WebSocket timeout: ' + JSON.stringify(clean(messages.slice(-3)))); };
    peer.current = () => messages.findLast(m => m.type === 'world' && m.packet?.action === 'snapshot')?.packet.snapshot;
    await new Promise((yes, no) => { ws.once('open', yes); ws.once('error', no); }); peer.send({ type: 'auth', token: user.token }); await peer.wait(m => m.type === 'authenticated');
    peer.send({ type: 'subscribe', project_id: project.project.id, branch_id: 'main', resource_id: rid, generation: 1 }); assert.equal((await peer.wait(m => m.type === 'baseline' || m.type === 'error')).type, 'baseline'); return peer;
  }
  const snapshot = (peer, predicate, mark = peer.messages.length, timeout = 5000) => peer.wait(m => m.type === 'world' && m.packet?.action === 'snapshot' && predicate(m.packet.snapshot), mark, timeout).then(m => m.packet.snapshot);
  async function join(peer) {
    const mark = peer.messages.length; peer.send({ type: 'world_join', project_id: project.project.id, branch_id: 'main', resource_id: rid, runtime_build_id: runtime.build_id });
    const packet = await peer.wait(m => m.type === 'world' && m.packet?.action === 'join' || m.type === 'error', mark, 70000); assert.equal(packet.type, 'world', JSON.stringify(clean(packet)));
    const s = await snapshot(peer, s => s.players[peer.user.user.id]?.online, mark); peer.inputSeq = s.players[peer.user.user.id].last_input_seq; worldId = s.world_id; authority(); record('actual_join_' + peer.user.user.id, s); return s;
  }
  function input(peer, move, extra = {}) { const s = peer.current(); const seq = ++peer.inputSeq; peer.send({ type: 'world_input', input: { world_id: s.world_id, epoch: s.epoch, scene_revision: s.scene_revision, input_seq: seq, move, ...extra } }); return seq; }
  async function zero(peer) { const mark = peer.messages.length, seq = input(peer, [0, 0]); return snapshot(peer, s => s.players[peer.user.user.id].last_input_seq >= seq && Math.hypot(s.players[peer.user.user.id].velocity[0], s.players[peer.user.user.id].velocity[2]) < .01, mark); }
  async function moveUntil(peer, move, predicate) {
    const movement = { started_at: Date.now(), move, actor: peer.user.user.id, before: peer.current().players[peer.user.user.id] }; (report.movements ??= []).push(movement);
    for (let i = 0; i < 60; i++) { if (predicate(peer.current().players[peer.user.user.id])) break; input(peer, move); await delay(100); }
    const result = await zero(peer); Object.assign(movement, { finished_at: Date.now(), after: result.players[peer.user.user.id], reached: predicate(result.players[peer.user.user.id]) }); assert.ok(movement.reached, 'Real movement reached the requested location; actual ' + JSON.stringify(movement.after.position)); return result;
  }
  async function copyRestoreVerification(v) {
    assert.ok(v && v.evidence?.report); await mkdir(resolve(out, 'validators'), { recursive: true });
    const actual = JSON.parse(await readFile(v.evidence.report, 'utf8')), logText = await readFile(v.evidence.log, 'utf8'), candidate = JSON.parse(await readFile(resolve(dirname(v.evidence.report), 'candidate.json'), 'utf8'));
    await writeFile(resolve(out, 'validators', v.id + '.json'), JSON.stringify(clean({ verification: v, candidate, actual }), null, 2)); await writeFile(resolve(out, 'validators', v.id + '.log'), clean(logText));
    assert.equal(v.state_hash, hash(stable(candidate.state))); assert.equal(v.status, 'passed'); assert.equal(v.process.code, 0); assert.equal(actual.ok, true); assert.equal(actual.completed, true); assert.equal(/SCRIPT ERROR|Parse Error|ERROR:/.test(logText), false); return { candidate, actual };
  }
  async function step(id, title, fn, fatal = true) {
    if (legacy) id = id.replace('CTR', 'CLR');
    const row = { id, title, status: 'running', observations: {}, started_at: Date.now() }; report.cases.push(row);
    await t.test(id + ' ' + title, async () => { try { await fn(row.observations); row.status = 'passed'; } catch (e) { row.status = 'failed'; row.error = { message: e.message, stack: e.stack }; throw e; } finally { row.finished_at = Date.now(); await save(); console.log('CONTENT_RECOVERY_CASE ' + id + ' ' + row.status); } });
    if (fatal && row.status !== 'passed') throw Error('Cannot continue after ' + id);
  }
  try {
    report.health = await start(); assert.equal(report.health.agent_ready, false); assert.equal(report.health.worlds_ready, true);
    A = ok(await request('POST', '/auth/register', null, { name: uid('trigger-owner'), password: uid('password') }), 201); B = ok(await request('POST', '/auth/register', null, { name: uid('trigger-peer'), password: uid('password') }), 201);
    project = ok(await request('POST', '/projects', A, { name: uid('Published content trigger reproduction'), template: 'harbor' }), 201); report.project_id = project.project.id;
    const invite = ok(await request('POST', `/projects/${project.project.id}/invites`, A, { role: 'editor' }), 201); ok(await request('POST', '/invites/join', B, { code: invite.code }));
    await step('CTR01', 'exact published objects, scripts and GLBs copied with unchanged hashes', async o => {
      const assets = new Map();
      for (const resource of Object.values(published.manifest.resources)) for (const object of resource.objects) {
        if (object.model_hash) assets.set(object.model_hash, 'glb');
        for (const b of object.components?.behaviors ?? []) assets.set(b.script_hash, 'gd');
      }
      for (const [digest, ext] of assets) {
        const path = resolve(root, '.local/model-preview/creation/assets', `${digest}.${ext}`), bytes = await readFile(path); assert.equal(hash(bytes), digest);
        const asset = ok(await request('POST', `/projects/${project.project.id}/assets`, A, { name: `published-${digest}.${ext}`, bytes }, true), 201); assert.equal(asset.id, digest); report.assets.push({ sha256: digest, ext, bytes: bytes.length, source_path: path });
      }
      const ops = [];
      for (const resource of Object.values(published.manifest.resources)) for (const object of resource.objects) ops.push({ type: 'put_object', resource_id: resource.id, object_id: object.id, expected_version: project.branch.manifest.resources[resource.id].objects.find(x => x.id === object.id)?.version ?? null, object });
      const changed = ok(await request('POST', branchPath() + '/transactions', A, { transaction_id: uid('exact-published-content'), base_revision: project.branch.head, ops }));
      const current = ok(await request('GET', branchPath())); assert.deepEqual(semantic(current.manifest), semantic(published.manifest));
      report.imported_revision = changed.revision; await writeFile(resolve(out, 'imported-manifest.json'), JSON.stringify(current.manifest, null, 2)); await writeFile(resolve(out, 'published-manifest.json'), JSON.stringify(published.manifest, null, 2));
      runtime = await (await fetch(origin + '/preview-runtime/manifest.json')).json(); report.runtime_build_id = runtime.build_id; assert.equal(runtime.build_id, legacy ? legacyBuild : process.env.WORLD_ATELIER_EXPECT_RUNTIME_BUILD); report.runtime_sources = runtime.sources;
      for (const f of runtime.sources) assert.equal(hash(await readFile(resolve(activeCodeRoot, 'runtimes/model-preview', f.path))), f.sha256);
      if (legacy) report.legacy_runtime = { build_id: runtime.build_id, sources: runtime.sources, code_root: activeCodeRoot };
      o.resources = Object.keys(current.manifest.resources).length; o.assets = report.assets.length; o.manifest_equal_excluding_generated_versions = true;
      peerA = await connect(A); peerB = await connect(B); await join(peerA); await join(peerB);
      await snapshot(peerA, s => s.players[B.user.id]?.online && Object.values(s.players).every(p => p.grounded));
      report.authority = authority(); assert.match(report.authority.command, /Godot.*--headless --path/);
      await delay(600); o.outside = record('two_outside_no_input', peerA.current()); assert.equal(state(peerA.current()).activation_count, 0); assert.ok(Object.values(peerA.current().players).every(p => Math.hypot(p.position[0], p.position[2]) > 2));
    }, true);
    await step('CTR02', 'actual entry reaches one, then graceful shutdown with both client sockets open', async o => {
      await moveUntil(peerA, [0, -1], p => p.position[2] < .6);
      await snapshot(peerA, s => state(s).activation_count === 1);
      await delay(650); preStop = peerA.current(); beforeService = child.pid;
      o.before = record('inside_before_graceful_shutdown', preStop); o.authority = authority();
      assert.equal(state(preStop).activation_count, 1); assert.ok(state(preStop).inside_players.includes(A.user.id));
      if (legacy) assert.equal(Object.hasOwn(preStop, 'trigger_contacts'), false, 'Actual old runtime has no platform contact ledger'); else platformContact(preStop, A.user.id, true);
      assert.equal(peerA.ws.readyState, WebSocket.OPEN); assert.equal(peerB.ws.readyState, WebSocket.OPEN);
      await stop(); assert.equal(report.services.find(p => p.pid === beforeService).exit_code, 0);
      savedCheckpoint = storedWorld(); const actual = await wire();
      const shutdown = actual.findLast(x => x.server_pid === beforeService && x.direction === 'node_to_godot' && x.packet.type === 'shutdown'); assert.ok(shutdown?.packet.request_id);
      const checkpoint = actual.find(x => x.server_pid === beforeService && x.direction === 'godot_to_node' && x.packet.type === 'checkpoint' && x.packet.request_id === shutdown.packet.request_id);
      Object.assign(o, { saved: savedCheckpoint, actual_shutdown: shutdown, actual_checkpoint: checkpoint, leave_packets: actual.filter(x => x.server_pid === beforeService && x.direction === 'node_to_godot' && x.packet.type === 'leave') });
      assert.equal(checkpoint?.packet.ok, true); assert.deepEqual(savedCheckpoint.snapshot, checkpoint.packet.snapshot); assert.ok(!savedCheckpoint.failure); assert.deepEqual(savedCheckpoint.failure_history, []);
      assert.equal(state(savedCheckpoint.snapshot).activation_count, 1); sameXZ(savedCheckpoint.snapshot.players[A.user.id], preStop.players[A.user.id]);
      if (legacy) { assert.equal(savedCheckpoint.runtime_build_id, legacyBuild); assert.equal(Object.hasOwn(savedCheckpoint.snapshot, 'trigger_contacts'), false, 'The actual persisted checkpoint predates the new ledger'); } else platformContact(savedCheckpoint.snapshot, A.user.id, true);
    });
    await step('CTR03', 'outside peer wakes restored world, then inside owner joins without input and stays at one', async o => {
      await start(); const service = child.pid;
      const restoredBuild = await (await fetch(origin + '/preview-runtime/manifest.json')).json();
      assert.equal(restoredBuild.build_id, process.env.WORLD_ATELIER_EXPECT_RUNTIME_BUILD, 'Recovery uses the frozen target runtime');
      runtime = restoredBuild; report.runtime_build_id = runtime.build_id; report.runtime_sources = runtime.sources;
      for (const f of runtime.sources) assert.equal(hash(await readFile(resolve(root, 'runtimes/model-preview', f.path))), f.sha256);
      peerB = await connect(B); await join(peerB);
      const first = peerB.current(); await snapshot(peerB, s => s.tick >= first.tick + 90);
      const waiting = peerB.current(); o.restore_gap = record('restored_world_while_A_not_joined', waiting);
      assert.equal(waiting.players[A.user.id].online, false, 'A is offline until its actual join in this authority incarnation');
      assert.equal(waiting.players[B.user.id].online, true);
      peerA = await connect(A); await join(peerA); const joined = peerA.current();
      await snapshot(peerA, s => s.tick >= joined.tick + 90); const after = peerA.current(); o.after = record('A_rejoined_without_input', after);
      const actual = await wire(), init = actual.find(x => x.server_pid === service && x.direction === 'node_to_godot' && x.packet.type === 'init');
      const verification = documents('creator_verification').filter(v => v.started_at >= report.services.at(-1).started_at).sort((a, b) => a.started_at - b.started_at)[0];
      const validated = await copyRestoreVerification(verification); Object.assign(o, { init, verification, validator_snapshot: validated.actual.snapshot, authority: authority() });
      assert.deepEqual(init.packet.state, savedCheckpoint.snapshot); assert.deepEqual(validated.candidate.state, savedCheckpoint.snapshot);
      assert.equal(actual.filter(x => x.server_pid === service && x.direction === 'node_to_godot' && x.packet.type === 'input').length, 0, 'No input sent during restore/rejoin');
      for (const s of [waiting, after]) { assert.equal(s.world_id, preStop.world_id); assert.equal(s.epoch, preStop.epoch + 1); assert.equal(s.scene_revision, report.imported_revision); assert.equal(state(s).activation_count, 1, 'Restoring contact must not replay trigger entry'); platformContact(s, A.user.id, true); sameXZ(s.players[A.user.id], savedCheckpoint.snapshot.players[A.user.id]); }
      assert.equal(after.players[A.user.id].last_input_seq, savedCheckpoint.snapshot.players[A.user.id].last_input_seq); assert.equal(after.players[A.user.id].online, true); assert.deepEqual(after.runtime_fault, {});
    });
    await step('CTR04', 'physical exit then real reentry after restore increments exactly to two', async o => {
      o.before = record('before_exit_after_restore', peerA.current());
      await moveUntil(peerA, [0, .35], p => p.position[2] > 2.2); await delay(400); const outside = peerA.current(); o.outside = record('physical_exit_after_restore', outside);
      assert.equal(state(outside).activation_count, 1); platformContact(outside, A.user.id, false);
      await moveUntil(peerA, [0, -.5], p => p.position[2] < .6); await delay(650); const inside = peerA.current(); o.inside = record('physical_reentry_after_restore', inside);
      assert.equal(state(inside).activation_count, 2); platformContact(inside, A.user.id, true); assert.deepEqual(inside.runtime_fault, {});
      if (legacy) { const events = (await wire()).filter(x => x.direction === 'godot_to_node' && x.packet.type === 'world_events').flatMap(x => x.packet.events).filter(e => e.kind === 'anchor_celebrate'); o.actual_events = events; assert.equal(events.length, 2); assert.ok(events.every(e => e.data.player_id === A.user.id)); }
    });
    if (!legacy) {
    await step('CTR05', 'explicit offline leave and original-position rejoin do not increment while another player continues', async o => {
      const before = peerA.current(), pid = authority().pid, mark = peerB.messages.length; o.before = record('before_offline_leave', before);
      peerA.send({ type: 'world_leave' });
      const offline = await snapshot(peerB, s => s.players[A.user.id]?.online === false, mark);
      await snapshot(peerB, s => s.tick >= offline.tick + 90); const waiting = peerB.current(); o.offline = record('A_offline_B_still_running', waiting);
      const afterLeaveWire = await wire(); o.actual_leave = afterLeaveWire.findLast(x => x.direction === 'node_to_godot' && x.packet.type === 'leave' && x.packet.player_id === A.user.id);
      assert.ok(o.actual_leave); await join(peerA); const joined = peerA.current(); await snapshot(peerA, s => s.tick >= joined.tick + 90); const after = peerA.current(); o.after = record('A_same_position_offline_rejoin', after);
      for (const s of [waiting, after]) { assert.equal(s.world_id, before.world_id); assert.equal(s.epoch, before.epoch); assert.equal(state(s).activation_count, 2, 'No spatial exit occurred during offline presence change'); platformContact(s, A.user.id, true); sameXZ(s.players[A.user.id], before.players[A.user.id]); }
      assert.equal(after.players[A.user.id].last_input_seq, before.players[A.user.id].last_input_seq); assert.equal(authority().pid, pid); assert.deepEqual(after.runtime_fault, {});
      o.business_inside_note = 'inside_players is original behavior-owned state and may be pruned for offline users; trigger_contacts is the platform spatial ledger. Both raw values retained.';
    });
    await step('CTR06', 'physical exit after offline rejoin clears contact and another entry increments exactly to three', async o => {
      await moveUntil(peerA, [0, .35], p => p.position[2] > 2.2); await delay(400); const outside = peerA.current(); o.outside = record('physical_exit_after_offline_rejoin', outside);
      assert.equal(state(outside).activation_count, 2); platformContact(outside, A.user.id, false);
      await moveUntil(peerA, [0, -.5], p => p.position[2] < .6); await delay(650); const inside = peerA.current(); o.inside = record('physical_reentry_after_offline_rejoin', inside);
      assert.equal(state(inside).activation_count, 3); platformContact(inside, A.user.id, true); assert.deepEqual(inside.runtime_fault, {});
      const events = (await wire()).filter(x => x.direction === 'godot_to_node' && x.packet.type === 'world_events').flatMap(x => x.packet.events).filter(e => e.kind === 'anchor_celebrate'); o.actual_events = events;
      assert.equal(events.length, 3, 'Exactly three genuine physical entries across both authority processes'); assert.ok(events.every(e => e.data.player_id === A.user.id));
    });
    }
    report.completed = report.cases.every(x => x.status === 'passed');
  } catch (e) { report.fatal_error = { message: e.message, stack: e.stack }; throw e; }
  finally {
    await stop(); for (const ws of sockets) ws.terminate();
    report.authorities = [...authorities.values()]; report.remaining_owned_authorities = processes().filter(p => authorities.has(p.pid)); report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(x => x.status === 'passed').length, failed: report.cases.filter(x => x.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(sourceFiles.map(async f => [f, hash(await readFile(resolve(root, f)))]))); report.source_changed_during_run = sourceFiles.filter(f => report.source_hashes[f] !== report.source_hashes_after[f]);
    report.runtime_sources_after = await Promise.all((runtime?.sources ?? []).map(async f => ({ path: f.path, sha256: hash(await readFile(resolve(root, 'runtimes/model-preview', f.path))) })));
    report.runtime_source_changed_during_run = report.runtime_sources_after.filter(f => runtime.sources.find(old => old.path === f.path)?.sha256 !== f.sha256).map(f => f.path);
    if (report.legacy_runtime) { report.legacy_runtime_sources_after = await Promise.all(report.legacy_runtime.sources.map(async f => ({ path: f.path, sha256: hash(await readFile(resolve(report.legacy_runtime.code_root, 'runtimes/model-preview', f.path))) }))); report.legacy_runtime_source_changed_during_run = report.legacy_runtime_sources_after.filter(f => report.legacy_runtime.sources.find(old => old.path === f.path)?.sha256 !== f.sha256).map(f => f.path); if (report.legacy_runtime_source_changed_during_run.length) report.completed = false; }
    if (report.source_changed_during_run.length || report.runtime_source_changed_during_run.length) report.completed = false;
    await save(); await writeFile(resolve(out, 'timeline.json'), JSON.stringify(report.timeline, null, 2)); await writeFile(resolve(out, 'server.log'), clean(log)); await writeFile(resolve(out, 'executed-driver.mjs'), await readFile(fileURLToPath(import.meta.url))); await writeFile(resolve(out, 'executed-observer.mjs'), await readFile(resolve(root, 'tests/creation/observe-worker.mjs')));
    try { const actual = await wire(); await writeFile(resolve(out, 'actual-content-events.json'), JSON.stringify(actual.filter(x => x.direction === 'godot_to_node' && x.packet.type === 'world_events'), null, 2)); } catch {}
    console.log('CONTENT_RECOVERY_REPORT ' + resolve(out, 'report.json')); console.log('CONTENT_RECOVERY_COUNTS ' + JSON.stringify(report.counts));
  }
});
