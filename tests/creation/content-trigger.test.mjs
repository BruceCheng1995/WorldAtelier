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

// The actual published Agent candidate is copied unchanged through real APIs.
// No behavior fixture, fabricated authority ACK, production mutation or GPU claim.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = 48921, origin = `http://127.0.0.1:${port}`, api = origin + '/creation-api';
const rid = 'scene-harbor', anchor = 'anchor-0508f749-1d19-4765-9821-c79a3f01a4de', behavior = 'step-celebration-v1';
const expectedRevision = 'src-efba4a3a0ff7be1268079874a4dbcf996407cfa0966ceaa1a542311ca5012c60';
const uid = p => `${p}-${randomUUID()}`, delay = ms => new Promise(r => setTimeout(r, ms));
const hash = x => createHash('sha256').update(x).digest('hex');
const clean = x => Array.isArray(x) ? x.map(clean) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, /^(token|password|code|cap|authorization)$/i.test(k) ? '[redacted]' : clean(v)])) : typeof x === 'string' ? x.replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]') : x;
const semantic = x => Array.isArray(x) ? x.map(semantic) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'version').map(([k, v]) => [k, semantic(v)])) : x;
const state = s => s.object_states[anchor]?.[behavior];
const observation = s => ({ world_id: s.world_id, epoch: s.epoch, scene_revision: s.scene_revision, sequence: s.sequence, tick: s.tick, event_sequence: s.event_sequence, players: s.players, trigger: state(s), module_assets: s.module_assets, runtime_fault: s.runtime_fault });
async function freePort() { const server = createServer(); await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); await new Promise(r => server.close(r)); }
function processes() { return execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' }).trim().split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], state: m[3], command: m[4] })); }

test('actual published fireworks: no synthetic activation during join or identical scene application', { timeout: 180000 }, async t => {
  await freePort();
  const out = resolve(root, '.local/creation-verification/content-trigger', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-content-trigger-'));
  await mkdir(out, { recursive: true });
  const artifactPath = resolve(root, '.local/creation-verification/browser/first-content-delivery.json');
  const artifactBytes = await readFile(artifactPath), published = JSON.parse(artifactBytes);
  assert.equal(published.source_revision, expectedRevision);
  const report = { started_at: new Date().toISOString(), out, data, port, scope: 'Exact actual Agent-authored content imported into an independent API project; real Godot editor binary --headless --path authority, two authenticated protocol clients. No browser/GPU or universal behavior claim.', source_artifact: { path: artifactPath, sha256: hash(artifactBytes), revision: published.source_revision }, cases: [], traffic: [], timeline: [], assets: [], source_hashes: {}, completed: false };
  const sourceFiles = ['services/creation/worlds.mjs', 'services/creation/realtime.mjs', 'services/creation/store.mjs', 'runtimes/model-preview/world_simulation.gd', 'runtimes/model-preview/authority_worker.gd'];
  for (const f of sourceFiles) report.source_hashes[f] = hash(await readFile(resolve(root, f)));
  let child, log = '', A, B, project, runtime, peerA, peerB, lastPublication;
  const sockets = new Set();
  const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(clean(report), null, 2) + '\n');
  const record = (label, snapshot) => { const row = { at: Date.now(), label, ...observation(snapshot) }; report.timeline.push(row); return row; };
  async function start() {
    const env = { ...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: data, WORLD_ATELIER_CREATION_DATA: resolve(data, 'creation'), WORLD_ATELIER_DISABLE_AGENT: '1', WORLD_ATELIER_TEST_WORKER_TRACE: resolve(out, 'worker-wire.jsonl') }; delete env.WORLD_ATELIER_DISABLE_WORLDS;
    child = spawn(process.execPath, ['--import', './tests/creation/observe-worker.mjs', 'services/preview/server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    report.service = { pid: child.pid, started_at: Date.now() }; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; }); child.once('exit', (code, signal) => Object.assign(report.service, { exit_code: code, signal, stopped_at: Date.now() }));
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
    const s = await snapshot(peer, s => s.players[peer.user.user.id]?.online, mark); peer.inputSeq = s.players[peer.user.user.id].last_input_seq; record('actual_join_' + peer.user.user.id, s); return s;
  }
  function input(peer, move, extra = {}) { const s = peer.current(); const seq = ++peer.inputSeq; peer.send({ type: 'world_input', input: { world_id: s.world_id, epoch: s.epoch, scene_revision: s.scene_revision, input_seq: seq, move, ...extra } }); return seq; }
  async function zero(peer) { const mark = peer.messages.length, seq = input(peer, [0, 0]); return snapshot(peer, s => s.players[peer.user.user.id].last_input_seq >= seq && Math.hypot(s.players[peer.user.user.id].velocity[0], s.players[peer.user.user.id].velocity[2]) < .01, mark); }
  async function moveUntil(peer, move, predicate) {
    const movement = { started_at: Date.now(), move, actor: peer.user.user.id, before: peer.current().players[peer.user.user.id] }; (report.movements ??= []).push(movement);
    for (let i = 0; i < 60; i++) { if (predicate(peer.current().players[peer.user.user.id])) break; input(peer, move); await delay(100); }
    const result = await zero(peer); Object.assign(movement, { finished_at: Date.now(), after: result.players[peer.user.user.id], reached: predicate(result.players[peer.user.user.id]) }); assert.ok(movement.reached, 'Real movement reached the requested location; actual ' + JSON.stringify(movement.after.position)); return result;
  }
  async function publish() {
    const result = ok(await request('POST', branchPath() + '/publish', A, { revision: report.imported_revision, resource_id: rid }));
    const v = result.verification; assert.equal(v.status, 'passed'); assert.equal(v.process.code, 0);
    await mkdir(resolve(out, 'validators'), { recursive: true }); await writeFile(resolve(out, 'validators', v.id + '.json'), clean(await readFile(v.evidence.report, 'utf8'))); await writeFile(resolve(out, 'validators', v.id + '.log'), clean(await readFile(v.evidence.log, 'utf8')));
    await snapshot(peerA, s => s.sequence > result.delivery.applied_sequence); lastPublication = result; return result;
  }
  async function step(id, title, fn, fatal = false) {
    const row = { id, title, status: 'running', observations: {}, started_at: Date.now() }; report.cases.push(row);
    await t.test(id + ' ' + title, async () => { try { await fn(row.observations); row.status = 'passed'; } catch (e) { row.status = 'failed'; row.error = { message: e.message, stack: e.stack }; throw e; } finally { row.finished_at = Date.now(); await save(); console.log('CONTENT_TRIGGER_CASE ' + id + ' ' + row.status); } });
    if (fatal && row.status !== 'passed') throw Error('Cannot continue after ' + id);
  }
  try {
    report.health = await start(); assert.equal(report.health.agent_ready, false); assert.equal(report.health.worlds_ready, true);
    A = ok(await request('POST', '/auth/register', null, { name: uid('trigger-owner'), password: uid('password') }), 201); B = ok(await request('POST', '/auth/register', null, { name: uid('trigger-peer'), password: uid('password') }), 201);
    project = ok(await request('POST', '/projects', A, { name: uid('Published content trigger reproduction'), template: 'harbor' }), 201); report.project_id = project.project.id;
    const invite = ok(await request('POST', `/projects/${project.project.id}/invites`, A, { role: 'editor' }), 201); ok(await request('POST', '/invites/join', B, { code: invite.code }));
    await step('CT01', 'exact published objects, scripts and GLBs copied with unchanged hashes', async o => {
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
      runtime = await (await fetch(origin + '/preview-runtime/manifest.json')).json(); report.runtime_build_id = runtime.build_id; report.runtime_sources = runtime.sources;
      for (const f of runtime.sources) assert.equal(hash(await readFile(resolve(root, 'runtimes/model-preview', f.path))), f.sha256);
      o.resources = Object.keys(current.manifest.resources).length; o.assets = report.assets.length; o.manifest_equal_excluding_generated_versions = true;
      peerA = await connect(A); peerB = await connect(B); await join(peerA); await join(peerB);
      await snapshot(peerA, s => s.players[B.user.id]?.online && Object.values(s.players).every(p => p.grounded));
      report.authority = processes().find(p => p.ppid === child.pid && p.command.includes('--authority')); assert.ok(report.authority); assert.match(report.authority.command, /Godot.*--headless --path/);
    }, true);
    await step('CT02', 'two initial joins outside trigger, no input and no activation', async o => {
      await delay(800); const s = peerA.current(); o.after = record('two_players_idle_no_input', s);
      assert.equal(report.traffic.filter(x => x.transport === 'ws-send' && x.packet?.type === 'world_input').length, 0);
      assert.ok(Object.values(s.players).every(p => Math.hypot(p.position[0], p.position[2]) > 2)); assert.deepEqual(state(s).inside_players, []); assert.equal(state(s).activation_count, 0, 'Joining outside must not activate fireworks');
    });
    await step('CT03', 'two identical scene applications while both remain outside do not activate', async o => {
      o.applications = [];
      for (let i = 0; i < 2; i++) {
        const before = record('outside_before_apply_' + i, peerA.current()), result = await publish(); await delay(650); const after = record('outside_after_apply_' + i, peerA.current());
        assert.ok(Object.values(after.players).every(p => Math.hypot(p.position[0], p.position[2]) > 2));
        o.applications.push({ before, after, delivery: result.delivery, validator_snapshot: result.verification.report?.snapshot }); await save();
      }
      assert.equal(report.traffic.filter(x => x.transport === 'ws-send' && x.packet?.type === 'world_input').length, 0);
      for (const r of o.applications) { assert.deepEqual(r.after.players, r.before.players); assert.equal(r.after.trigger.activation_count, r.before.trigger.activation_count, 'Unchanged-position application must not activate fireworks'); }
    });
    await step('CT04', 'real movement into trigger adds one activation and holding position does not repeat', async o => {
      const before = record('before_real_walk', peerA.current());
      for (let i = 0; i < 20; i++) { input(peerA, [0, -1]); await delay(100); if (peerA.current().players[A.user.id].position[2] < .6) break; }
      await zero(peerA); await delay(400); const entered = record('after_real_walk_zero_ack', peerA.current()); await delay(700); const held = record('after_holding_inside', peerA.current());
      Object.assign(o, { before, entered, held }); assert.ok(entered.players[A.user.id].position[2] < 1.35, 'Actual authority player reached circle'); assert.ok(state(peerA.current()).inside_players.includes(A.user.id));
      assert.equal(entered.trigger.activation_count, before.trigger.activation_count + 1); assert.equal(held.trigger.activation_count, entered.trigger.activation_count);
    });
    await step('CT05', 'identical application preserves inside membership without synthetic reentry', async o => {
      const before = record('inside_before_apply', peerA.current()); assert.ok(before.trigger.inside_players.includes(A.user.id));
      const result = await publish(); await delay(600); const after = record('inside_after_apply', peerA.current());
      Object.assign(o, { before, after, delivery: result.delivery }); assert.deepEqual(after.trigger.inside_players, before.trigger.inside_players); assert.equal(after.trigger.activation_count, before.trigger.activation_count); assert.deepEqual(after.players, before.players);
    });
    await step('CT06', 'real exit and a new entry trigger once, without suppressing valid events', async o => {
      const before = record('before_actual_exit', peerA.current());
      // Stop outside the trigger while remaining on the raised platform. A fast
      // z=2.8 target overshot the physical ledge under 10 Hz observations.
      await moveUntil(peerA, [0, .35], p => p.position[2] >= 2.2); await delay(250); const exited = record('after_actual_exit', peerA.current());
      assert.ok(!exited.trigger.inside_players.includes(A.user.id)); assert.equal(exited.trigger.activation_count, before.trigger.activation_count);
      await moveUntil(peerA, [0, -.5], p => p.position[2] <= .6); await delay(250); const reentered = record('after_actual_reentry', peerA.current());
      Object.assign(o, { before, exited, reentered }); assert.ok(reentered.trigger.inside_players.includes(A.user.id)); assert.equal(reentered.trigger.activation_count, before.trigger.activation_count + 1);
    });
    await step('CT07', 'actual published coral E interaction emits once and survives compatible application', async o => {
      await moveUntil(peerA, [0, -.5], p => p.position[2] <= -1.4);
      await moveUntil(peerA, [.5, 0], p => p.position[0] >= 2.4);
      await delay(250); const before = record('at_coral_before_E', peerA.current()), countBefore = peerA.current().object_states['obj-tree-11']['coral-tree-resonance'].resonance_count;
      const mark = peerA.messages.length, seq = input(peerA, [0, 0], { interact: true });
      const after = await snapshot(peerA, s => s.players[A.user.id].last_input_seq >= seq && s.object_states['obj-tree-11']['coral-tree-resonance'].resonance_count === countBefore + 1, mark);
      await zero(peerA); await delay(500); assert.equal(peerA.current().object_states['obj-tree-11']['coral-tree-resonance'].resonance_count, countBefore + 1);
      const result = await publish(); await delay(500); const preserved = peerA.current();
      Object.assign(o, { before, interaction: observation(after), count_before: countBefore, count_after: after.object_states['obj-tree-11']['coral-tree-resonance'].resonance_count, count_after_application: preserved.object_states['obj-tree-11']['coral-tree-resonance'].resonance_count, delivery: result.delivery });
      assert.equal(preserved.object_states['obj-tree-11']['coral-tree-resonance'].resonance_count, countBefore + 1);
      const wire = (await readFile(resolve(out, 'worker-wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const events = wire.filter(x => x.direction === 'godot_to_node' && x.packet.type === 'world_events').flatMap(x => x.packet.events).filter(e => e.kind === 'coral_resonance');
      assert.equal(events.length, 1); assert.equal(events[0].object_id, 'obj-tree-11'); assert.equal(events[0].data.player_id, A.user.id); assert.equal(events[0].data.delta, 1); o.actual_events = events;
    });
    await step('CT08', 'published Blender GLB is really parsed and original object TRS stays in the applied document', async o => {
      const expected = published.manifest.resources[rid].objects.find(x => x.id === 'obj-arch-02');
      assert.equal(expected.model_hash, '390c674e544e0df60360ea101efa83daa3da38e0c16521717ec263ec2c927f71');
      const parsed = lastPublication.verification.report.assets.find(x => x.id === expected.id); assert.equal(parsed.hash, expected.model_hash); assert.equal(parsed.mesh_count, 48);
      const wire = (await readFile(resolve(out, 'worker-wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const applied = wire.findLast(x => x.direction === 'node_to_godot' && x.packet.type === 'apply_scene').packet;
      const actual = applied.scene.objects.find(x => x.id === expected.id); assert.equal(actual.model_hash, expected.model_hash);
      for (const field of ['position', 'rotation', 'scale']) assert.deepEqual(actual[field], expected[field]);
      Object.assign(o, { parsed_asset: parsed, applied_object: actual, original_object: expected, scope: 'Real GLTF parser and exact TRS in the actual applied document; visual appearance and rendered Node transform remain browser acceptance.' });
    });
    report.completed = report.cases.every(x => x.status === 'passed');
  } catch (e) { report.fatal_error = { message: e.message, stack: e.stack }; throw e; }
  finally {
    for (const ws of sockets) ws.terminate();
    if (child && child.exitCode === null && child.signalCode === null) { const exit = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 10000); await exit; clearTimeout(force); }
    report.remaining_authority = report.authority ? processes().filter(p => p.pid === report.authority.pid) : [];
    report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(x => x.status === 'passed').length, failed: report.cases.filter(x => x.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(sourceFiles.map(async f => [f, hash(await readFile(resolve(root, f)))]))); report.source_changed_during_run = sourceFiles.filter(f => report.source_hashes[f] !== report.source_hashes_after[f]);
    await save(); await writeFile(resolve(out, 'timeline.json'), JSON.stringify(report.timeline, null, 2)); await writeFile(resolve(out, 'server.log'), clean(log)); await writeFile(resolve(out, 'executed-driver.mjs'), await readFile(fileURLToPath(import.meta.url))); await writeFile(resolve(out, 'executed-observer.mjs'), await readFile(resolve(root, 'tests/creation/observe-worker.mjs')));
    try { const wire = (await readFile(resolve(out, 'worker-wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); await writeFile(resolve(out, 'actual-content-events.json'), JSON.stringify(wire.filter(x => x.direction === 'godot_to_node' && x.packet.type === 'world_events'), null, 2)); } catch {}
    console.log('CONTENT_TRIGGER_REPORT ' + resolve(out, 'report.json')); console.log('CONTENT_TRIGGER_COUNTS ' + JSON.stringify(report.counts));
  }
});
