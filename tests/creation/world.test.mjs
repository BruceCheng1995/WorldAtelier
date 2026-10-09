import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const focus = process.env.WORLD_ATELIER_WORLD_FOCUS === 'boundaries';
const port = 48921, origin = `http://127.0.0.1:${port}`, api = origin + '/creation-api', rid = 'scene-harbor', oid = 'independent-counter';
const delay = ms => new Promise(yes => setTimeout(yes, ms));
const uid = p => `${p}-${randomUUID()}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
const clean = x => Array.isArray(x) ? x.map(clean) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, /^(token|password|code|cap|authorization)$/i.test(k) ? '[redacted]' : clean(v)])) : typeof x === 'string' ? x.replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]') : x;
const branchPath = (p, b = 'main') => `/projects/${p}/branches/${b}`;
const moduleState = s => s.object_states[oid]['counter-v1'];
const xz = player => [player.position[0], player.position[2]];
function closeXZ(a, b, tolerance = .03) { assert.ok(a.every((n, i) => Math.abs(n - b[i]) < tolerance), `XZ mismatch ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); }
async function freePort() { const server = createServer(); await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); await new Promise(yes => server.close(yes)); }
function source(version = 1) { return `extends RefCounted\nfunc initialize(context) -> Dictionary:\n\tcontext.state["counter"] = int(context.state.get("counter", 0))\n\tcontext.state["interactions"] = int(context.state.get("interactions", 0))\n\tcontext.state["version"] = ${version}\n\treturn {"ok":true}\nfunc tick(context, _delta: float) -> Dictionary:\n\tif context.role == "authority":\n\t\tcontext.state["counter"] = int(context.state["counter"]) + ${version === 1 ? 1 : 3}\n\treturn {"ok":true}\nfunc interact(context, player: Dictionary) -> Dictionary:\n\tcontext.state["interactions"] = int(context.state["interactions"]) + 1\n\tcontext.state["last_player"] = player["id"]\n\treturn {"ok":true}\n`; }

test('creation worlds: actual isolated Godot authority and two authenticated users', { timeout: 240000 }, async t => {
  await freePort();
  const out = resolve(root, '.local/creation-verification/world', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-creation-world-')); await mkdir(out, { recursive: true });
  const godot = process.env.GODOT_BIN ?? '/Applications/Godot.app/Contents/MacOS/Godot';
  const report = { started_at: new Date().toISOString(), root, data, port, focus: focus ? 'boundaries' : 'full', passive_worker_trace: true, node: process.version, godot_version: execFileSync(godot, ['--version'], { encoding: 'utf8' }).trim(), scope: 'actual editor binary --headless --path authority; HTTP/WS clients, no GPU/browser/personal-inspection claim, Agent disabled', cases: [], traffic: [], processes: [], children: [], source_hashes: {}, completed: false };
  const files = ['services/creation/worlds.mjs', 'services/creation/execution-environment.mjs', 'services/creation/store.mjs', 'services/creation/service.mjs', 'services/creation/realtime.mjs', 'services/creation/assets.mjs', 'services/preview/server.mjs'];
  for (const file of files) report.source_hashes[file] = hash(await readFile(resolve(root, file)));
  let child, log = '', A, B, outsider, projectId, peerA, peerB, runtime, good1, good2, appliedRevision, worldId, epoch, authorityPid;
  const sockets = new Set(), seenChildren = new Map();
  const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(clean(report), null, 2) + '\n');
  function readProcesses() {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], state: m[3], command: m[4] }));
  }
  function sampleProcesses() {
    const parents = new Set(report.processes.map(x => x.pid));
    for (const entry of readProcesses().filter(p => parents.has(p.ppid))) {
      const record = seenChildren.get(entry.pid) ?? { ...entry, first_seen_at: Date.now() }; record.last_seen_at = Date.now(); seenChildren.set(entry.pid, record);
    }
    report.children = [...seenChildren.values()];
  }
  const monitor = setInterval(sampleProcesses, 250); monitor.unref();
  async function start() {
    await freePort(); const env = { ...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: data, WORLD_ATELIER_CREATION_DATA: resolve(data, 'creation'), WORLD_ATELIER_DISABLE_AGENT: '1', WORLD_ATELIER_TEST_WORKER_TRACE: resolve(out, 'worker-wire.jsonl') }; delete env.WORLD_ATELIER_DISABLE_WORLDS;
    child = spawn(process.execPath, ['--import', './tests/creation/observe-worker.mjs', 'services/preview/server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { pid: child.pid, started_at: Date.now() }; report.processes.push(record);
    child.stdout.on('data', b => { log += `[${record.pid} stdout] ${b}`; }); child.stderr.on('data', b => { log += `[${record.pid} stderr] ${b}`; }); child.once('exit', (exit_code, signal) => Object.assign(record, { exit_code, signal, stopped_at: Date.now() }));
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error(log); try { const response = await fetch(api + '/health'); if (response.ok) return response.json(); } catch {} await delay(50); } throw Error('Independent world service startup timeout');
  }
  async function stop() {
    for (const ws of sockets) ws.terminate(); sockets.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const own = child, stopped = new Promise(yes => own.once('exit', yes)); own.kill('SIGTERM'); const timer = setTimeout(() => own.kill('SIGKILL'), 10000); await stopped; clearTimeout(timer); await freePort();
  }
  async function req(method, path, user = A, input, raw = false) {
    const headers = { origin, 'content-type': raw ? 'application/octet-stream' : 'application/json' }; if (user) headers.authorization = `Bearer ${user.token}`; if (raw) headers['x-asset-name'] = encodeURIComponent(input.name);
    const response = await fetch(api + path, { method, headers, body: input === undefined ? undefined : raw ? input.bytes : JSON.stringify(input) }); const value = await response.json();
    report.traffic.push(clean({ at: Date.now(), transport: 'http', method, path, actor: user?.user?.id, input: raw ? { name: input.name, bytes: input.bytes.length, sha256: hash(input.bytes) } : input, status: response.status, value })); return { status: response.status, value };
  }
  const ok = (result, expected = 200) => { assert.equal(result.status, expected, JSON.stringify(clean(result.value))); return result.value; };
  const branch = b => req('GET', branchPath(projectId, b)).then(ok);
  async function asset(text, name) { return ok(await req('POST', `/projects/${projectId}/assets`, A, { name, bytes: Buffer.from(text) }, true), 201); }
  function components(module) { return { interactable: { radius: 12, label: 'Independent counter' }, behaviors: [{ id: 'counter-v1', api: 1, script_hash: module.id, script_url: module.url, properties: {} }] }; }
  async function patch(patchValue) {
    const current = await branch(), target = current.manifest.resources[rid].objects.find(o => o.id === oid);
    return ok(await req('POST', branchPath(projectId) + '/transactions', A, { transaction_id: uid('world-test'), base_revision: current.head, ops: [{ type: 'patch_object', resource_id: rid, object_id: oid, expected_version: target.version, patch: patchValue }] }));
  }
  async function connect(user, b = 'main') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/creation`, { origin }), messages = []; sockets.add(ws);
    const peer = { ws, user, messages, branch: b, generation: 1, inputSeq: 0 };
    ws.on('message', bytes => { const packet = JSON.parse(bytes.toString()); messages.push(packet); report.traffic.push(clean({ at: Date.now(), transport: 'ws', actor: user.user.id, packet })); }); ws.on('error', () => {});
    peer.send = packet => { report.traffic.push(clean({ at: Date.now(), transport: 'ws-send', actor: user.user.id, packet })); ws.send(JSON.stringify(packet)); };
    peer.wait = async (predicate, mark = 0, timeout = 5000) => { const end = Date.now() + timeout; while (Date.now() < end) { const found = messages.slice(mark).find(predicate); if (found) return found; await delay(15); } throw Error(`WS packet timeout: ${JSON.stringify(clean(messages.slice(-4)))}`); };
    peer.current = () => messages.findLast(m => m.type === 'world' && m.packet?.action === 'snapshot')?.packet.snapshot;
    await new Promise((yes, no) => { ws.once('open', yes); ws.once('error', no); }); peer.send({ type: 'auth', token: user.token }); await peer.wait(m => m.type === 'authenticated');
    peer.send({ type: 'subscribe', project_id: projectId, branch_id: b, resource_id: rid, generation: peer.generation }); await peer.wait(m => m.type === 'baseline' || m.type === 'error');
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) peer.send({ type: 'ping' }); }, 10000); ping.unref(); ws.on('close', () => clearInterval(ping)); return peer;
  }
  async function join(peer) {
    const mark = peer.messages.length; peer.send({ type: 'world_join', project_id: projectId, branch_id: peer.branch, resource_id: rid, runtime_build_id: runtime.build_id });
    const response = await peer.wait(m => m.type === 'world' && m.packet.action === 'join' || m.type === 'error', mark, 70000); assert.equal(response.type, 'world', JSON.stringify(response));
    await snapshot(peer, s => s.players[peer.user.user.id]?.online === true, mark); peer.inputSeq = peer.current().players[peer.user.user.id].last_input_seq; return response.packet;
  }
  const snapshot = (peer, predicate, mark = peer.messages.length, timeout = 5000) => peer.wait(m => m.type === 'world' && m.packet.action === 'snapshot' && predicate(m.packet.snapshot), mark, timeout).then(m => m.packet.snapshot);
  function input(peer, move, extra = {}) {
    const s = peer.current(), seq = ++peer.inputSeq; peer.send({ type: 'world_input', input: { world_id: s.world_id, epoch: s.epoch, scene_revision: s.scene_revision, input_seq: seq, move, ...extra } }); return seq;
  }
  async function zero(peer) { const mark = peer.messages.length, seq = input(peer, [0, 0]); return snapshot(peer, s => s.players[peer.user.user.id]?.last_input_seq >= seq && Math.abs(s.players[peer.user.user.id].velocity[0]) < .01 && Math.abs(s.players[peer.user.user.id].velocity[2]) < .01, mark); }
  function fixedRuntime(execution,kind) {
    assert.ok(execution?.runtime?.directory, 'Persisted execution identifies the actual fixed runtime');
    const directory=realpathSync(execution.runtime.directory),within=relative(realpathSync(resolve(data,'creation/worlds')),directory);
    assert.match(within,kind==='authority'?/^executions\/authority-[^/]+\/runtime$/:/^verification\/verification-[^/]+\/runtime$/);
    assert.notEqual(directory,realpathSync(resolve(root,'runtimes/model-preview')));
    assert.equal(execution.runtime.runtime_build_id,runtime.build_id);
    assert.equal(execution.runtime.source_hash,hash(JSON.stringify(runtime.sources)));
    assert.equal(execution.capabilities.provider,'macos-seatbelt');assert.equal(execution.capabilities.private_user_data,true);
    for(const file of runtime.sources)assert.equal(hash(readFileSync(resolve(directory,file.path))),file.sha256,`Fixed runtime source: ${file.path}`);
    return directory;
  }
  function authority() {
    sampleProcesses(); const current = readProcesses().filter(p => p.ppid === child.pid && p.command.includes('--authority'));
    assert.equal(current.length, 1, 'Exactly one real authority child process for this room'); assert.ok(current[0].command.startsWith(godot + ' ')); assert.ok(current[0].command.includes('--headless'));
    const db=new DatabaseSync(resolve(data,'creation/creation.sqlite'),{readOnly:true});let world;
    try{world=JSON.parse(db.prepare("SELECT body FROM documents WHERE kind='creator_world' AND id=?").get(worldId).body);}finally{db.close();}
    const directory=fixedRuntime(world.execution,'authority');assert.ok(current[0].command.includes('--path '+directory+' '));
    return {...current[0],execution:world.execution};
  }
  async function verification(result) {
    const v = result.verification ?? result; assert.ok(v.evidence?.report && v.evidence?.log);
    fixedRuntime(v.execution,'verification');
    const disk = JSON.parse(await readFile(v.evidence.report, 'utf8')), logText = await readFile(v.evidence.log, 'utf8');
    await mkdir(resolve(out, 'validators'), { recursive: true }); await writeFile(resolve(out, 'validators', v.id + '.json'), JSON.stringify(clean(disk), null, 2)); await writeFile(resolve(out, 'validators', v.id + '.log'), clean(logText));
    if (v.status === 'passed') { assert.equal(v.process.code, 0); assert.equal(disk.ok, true); assert.equal(disk.completed, true); assert.equal(/SCRIPT ERROR|Parse Error|ERROR:/.test(logText), false); }
    return { verification: v, log: logText, report: disk };
  }
  async function step(id, title, fn, fatal = false) {
    const row = { id, title, status: 'running', started_at: Date.now(), observations: {} }; report.cases.push(row);
    await t.test(`${id} ${title}`, async () => { try { await fn(row.observations); row.status = 'passed'; } catch (error) { row.status = 'failed'; row.error = { message: error.message, stack: error.stack }; throw error; } finally { row.finished_at = Date.now(); await save(); console.log(`WORLD_CASE ${id} ${row.status}`); } });
    if (fatal && row.status !== 'passed') throw Error(`Cannot safely continue after ${id}`);
  }
  try {
    report.health = await start();
    A = ok(await req('POST', '/auth/register', null, { name: uid('world-owner'), password: uid('password') }), 201); B = ok(await req('POST', '/auth/register', null, { name: uid('world-peer'), password: uid('password') }), 201); outsider = ok(await req('POST', '/auth/register', null, { name: uid('world-outsider'), password: uid('password') }), 201);
    const created = ok(await req('POST', '/projects', A, { name: uid('Independent Godot world'), template: 'empty' }), 201); projectId = created.project.id; report.project_id = projectId;
    const invite = ok(await req('POST', `/projects/${projectId}/invites`, A, { role: 'editor' }), 201); ok(await req('POST', '/invites/join', B, { code: invite.code }));
    good1 = await asset(source(1), 'independent-counter-1.gd'); good2 = await asset(source(2), 'independent-counter-2.gd');
    const catalog = JSON.parse(await readFile(resolve(root, 'content/model-preview/manifest.json'), 'utf8')), model = catalog.assets[0];
    ok(await req('POST', branchPath(projectId) + '/transactions', A, { transaction_id: uid('world-fixture'), base_revision: created.branch.head, ops: [
      { type: 'put_object', resource_id: rid, object_id: oid, expected_version: null, object: { id: oid, name: 'Independent lifecycle counter', kind: 'anchor', position: [0, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1], components: components(good1) } },
      { type: 'put_object', resource_id: rid, object_id: 'decor-model', expected_version: null, object: { id: 'decor-model', name: 'HTTP GLTF fixture', kind: 'model', model_hash: model.sha256, model_url: `/preview-assets/${model.sha256}.glb`, position: [20, 0, 20], rotation: [0, 20, 0], scale: [1, 1, 1], solid: false, components: {} } }
    ] }));
    await step('CW01', 'real runtime manifest and immutable download hashes, worker authentication', async o => {
      assert.equal(report.health.agent_ready, false); assert.equal(report.health.worlds_ready, true);
      const response = await fetch(origin + '/preview-runtime/manifest.json'); assert.equal(response.status, 200); runtime = await response.json(); report.runtime_manifest = runtime;
      const immutable = await fetch(`${origin}/preview-builds/${runtime.build_id}/manifest.json`); assert.equal(immutable.status, 200); assert.deepEqual(await immutable.json(), runtime);
      for (const file of runtime.sources) assert.equal(hash(await readFile(resolve(root, 'runtimes/model-preview', file.path))), file.sha256);
      o.files = [];
      for (const file of runtime.files) { const downloaded = await fetch(`${origin}/preview-builds/${runtime.build_id}/${file.path}`); const bytes = Buffer.from(await downloaded.arrayBuffer()); assert.equal(downloaded.status, 200); assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256); o.files.push({ path: file.path, bytes: bytes.length, sha256: hash(bytes) }); }
      let opened = false; const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/ws/world-worker`); unauthorized.on('open', () => { opened = true; unauthorized.close(); }); unauthorized.on('error', () => {}); await new Promise(yes => unauthorized.once('close', yes)); assert.equal(opened, false); o.unauthorized_worker_opened = opened;
    }, true);
    await step('CW02', 'two real users share one actual Godot authority and matching build', async o => {
      peerA = await connect(A); peerB = await connect(B);
      const badMark = peerA.messages.length; peerA.send({ type: 'world_join', project_id: projectId, branch_id: 'main', resource_id: rid, runtime_build_id: '0'.repeat(64) });
      const denied = await peerA.wait(m => m.type === 'error', badMark, 70000); assert.equal(denied.status, 409); assert.equal(peerA.messages.slice(badMark).some(m => m.type === 'world' && m.packet.action === 'join'), false);
      const [ja, jb] = await Promise.all([join(peerA), join(peerB)]); assert.equal(ja.world_id, jb.world_id); assert.equal(ja.epoch, jb.epoch); assert.equal(ja.manifest.runtime_build_id, runtime.build_id);
      const s = await snapshot(peerA, s => s.players[A.user.id]?.online && s.players[B.user.id]?.online); assert.equal(s.players[A.user.id].name, A.user.name); assert.equal(s.players[B.user.id].name, B.user.name);
      assert.ok(s.module_assets.includes(good1.id)); assert.equal(moduleState(s).version, 1); worldId = s.world_id; epoch = s.epoch; appliedRevision = s.scene_revision; authorityPid = authority().pid;
      o.joins = [ja, jb]; o.actual_authority = authority(); o.snapshot = s; report.world_id = worldId;
    }, true);
    if (!focus) {
    await step('CW03', 'actual movement, physics input deduplication and zero-input acknowledgement', async o => {
      await snapshot(peerA, s => s.players[A.user.id]?.grounded && s.players[B.user.id]?.grounded);
      const before = copy(peerA.current());
      for (let i = 0; i < 7; i++) { input(peerA, [1, 0]); input(peerB, [0, 1]); await delay(100); }
      await zero(peerA); const stopped = await zero(peerB); const later = await snapshot(peerA, s => s.tick > stopped.tick + 12);
      assert.ok(later.players[A.user.id].position[0] > before.players[A.user.id].position[0] + 2); assert.ok(later.players[B.user.id].position[2] > before.players[B.user.id].position[2] + 2);
      closeXZ(xz(later.players[A.user.id]), xz(stopped.players[A.user.id])); closeXZ(xz(later.players[B.user.id]), xz(stopped.players[B.user.id]));
      const same = await peerB.wait(m => m.type === 'world' && m.packet.action === 'snapshot' && m.packet.snapshot.sequence === later.sequence); assert.deepEqual(same.packet.snapshot, later);
      const interactionsBefore = moduleState(later).interactions, seq = input(peerA, [0, 0], { interact: true }); const interacted = await snapshot(peerA, s => s.players[A.user.id].last_input_seq >= seq && moduleState(s).interactions === interactionsBefore + 1); await zero(peerA);
      o.before = before; o.stopped = stopped; o.same_sequence_snapshot = later; o.interaction = interacted;
    });
    await step('CW04', 'source edits and isolated real validation do not silently replace live content', async o => {
      const before = copy(peerA.current()); const change = await patch({ position: [1, 0, 3], components: components(good2) }); const mark = peerA.messages.length;
      const candidate = ok(await req('POST', branchPath(projectId) + '/validate', A, { revision: change.revision, resource_id: rid })); const checked = await verification(candidate); assert.equal(candidate.status, 'passed');
      const after = await snapshot(peerA, s => s.tick > before.tick + 20, mark); assert.equal(after.scene_revision, appliedRevision); assert.equal(moduleState(after).version, 1); assert.equal(moduleState(after).counter - moduleState(before).counter, after.tick - before.tick); assert.equal(authority().pid, authorityPid);
      assert.ok(checked.report.assets.length > 0); o.candidate = candidate; o.source_head = change.revision; o.old_live_snapshot = after;
    }, true);
    await step('CW05', 'real publish installs changed behavior code and preserves players and component state', async o => {
      await zero(peerA); await zero(peerB); const before = copy(peerA.current()), current = await branch();
      const result = ok(await req('POST', branchPath(projectId) + '/publish', A, { revision: current.head, resource_id: rid })); await verification(result); const after = await snapshot(peerA, s => s.scene_revision === current.head && moduleState(s).version === 2);
      appliedRevision = current.head; assert.equal(result.delivery.world_id, worldId); assert.equal(after.epoch, epoch); assert.equal(authority().pid, authorityPid); assert.ok(after.tick >= before.tick); assert.ok(moduleState(after).counter >= moduleState(before).counter); assert.equal(moduleState(after).interactions, moduleState(before).interactions);
      for (const user of [A, B]) { closeXZ(xz(after.players[user.user.id]), xz(before.players[user.user.id])); assert.equal(after.players[user.user.id].last_input_seq, before.players[user.user.id].last_input_seq); }
      const later = await snapshot(peerA, s => s.tick > after.tick + 15); assert.equal(moduleState(later).counter - moduleState(after).counter, 3 * (later.tick - after.tick)); assert.ok(later.module_assets.includes(good2.id)); assert.equal(later.module_assets.includes(good1.id), false);
      await peerB.wait(m => m.type === 'world_scene' && m.scene_revision === current.head); o.result = result; o.before = before; o.after = after; o.changed_code_slope = { counter_delta: moduleState(later).counter - moduleState(after).counter, tick_delta: later.tick - after.tick };
    }, true);
    await step('CW06', 'stale epoch/revision/sequence inputs and unauthorized users cannot mutate the world', async o => {
      const stopped = await zero(peerA), previousSeq = stopped.players[A.user.id].last_input_seq;
      for (const stale of [{ epoch: epoch - 1 }, { scene_revision: 'stale-source' }]) { const mark = peerA.messages.length; input(peerA, [1, 0], stale); assert.equal((await peerA.wait(m => m.type === 'error', mark)).status, 409); }
      const mark = peerA.messages.length; peerA.send({ type: 'world_input', input: { world_id: worldId, epoch, scene_revision: appliedRevision, input_seq: previousSeq, move: [1, 0], interact: true } });
      const later = await snapshot(peerA, s => s.tick > stopped.tick + 20, mark); assert.equal(later.players[A.user.id].last_input_seq, previousSeq); closeXZ(xz(later.players[A.user.id]), xz(stopped.players[A.user.id])); assert.equal(moduleState(later).interactions, moduleState(stopped).interactions);
      const denied = await connect(outsider); assert.equal(denied.messages.find(m => m.type === 'error').status, 403);
      ok(await req('PATCH', `/projects/${projectId}/members/${B.user.id}`, A, { role: null })); await snapshot(peerA, s => s.players[B.user.id]?.online === false); assert.notEqual(peerB.ws.readyState, WebSocket.OPEN);
      ok(await req('PATCH', `/projects/${projectId}/members/${B.user.id}`, A, { role: 'editor' })); peerB = await connect(B); await join(peerB); o.last_good_input_seq = previousSeq; o.old_inputs_snapshot = later;
    });
    for (const [caseId, name, text] of [['CW07', 'compile error', 'extends RefCounted\nfunc initialize( -> Dictionary:\n\treturn {"ok":true}\n'], ['CW08', 'VM error even when callback says ok', 'extends RefCounted\nfunc inner_error() -> void:\n\tvar missing = {}\n\tprint(missing["absent"])\nfunc initialize(_context) -> Dictionary:\n\tinner_error()\n\treturn {"ok":true}\n']]) await step(caseId, `actual Godot rejects ${name} while old world continues`, async o => {
      const bad = await asset(text, 'negative-' + caseId + '.gd'), before = copy(peerA.current());
      const change = await patch({ components: components(bad) });
      try {
        const result = await req('POST', branchPath(projectId) + '/publish', A, { revision: change.revision, resource_id: rid }); assert.equal(result.status, 422); const v = result.value.details?.verification; assert.ok(v); const checked = await verification(v); assert.equal(v.status, 'failed'); assert.ok(v.process.code !== 0 || /SCRIPT ERROR|Parse Error|ERROR:/.test(checked.log));
        const after = await snapshot(peerA, s => s.tick > before.tick + 10); assert.equal(after.scene_revision, appliedRevision); assert.equal(moduleState(after).version, 2); assert.equal(authority().pid, authorityPid); o.rejection = result; o.after = after;
      } finally { await patch({ components: components(good2) }); }
    });
    await step('CW09', 'actual HTTP hash mismatch rejects corrupted candidate bytes and leaves old world ticking', async o => {
      const bytes = Buffer.from(source(2) + '# unique hash-failure candidate\n'), bad = await asset(bytes.toString(), 'hash-fixture.gd'), path = resolve(data, 'creation/assets', bad.id + '.gd');
      const damaged = Buffer.concat([bytes, Buffer.from('# injected corruption in isolated data only\n')]); await writeFile(path, damaged); const before = copy(peerA.current());
      const change = await patch({ components: components(bad) });
      try {
        const result = await req('POST', branchPath(projectId) + '/publish', A, { revision: change.revision, resource_id: rid }); assert.equal(result.status, 422); const v = result.value.details?.verification; assert.ok(v); const checked = await verification(v); assert.equal(v.status, 'failed'); assert.match(JSON.stringify(checked.report), /SHA-256|hash/i);
        const after = await snapshot(peerA, s => s.tick > before.tick + 10); assert.equal(after.scene_revision, appliedRevision); assert.equal(authority().pid, authorityPid); o.fault_injection = { file: path, expected_sha256: bad.id, damaged_sha256: hash(damaged), bytes: damaged.length }; o.rejection = result; o.after = after;
      } finally { await writeFile(path, bytes); await patch({ components: components(good2) }); }
    });
    }
    await step('CW12', 'concurrent same-identity joins grant control to exactly one real socket', async o => {
      peerA.send({ type: 'world_leave' }); await snapshot(peerB, s => s.players[A.user.id]?.online === false); peerA.ws.close();
      const twins = await Promise.all([connect(A), connect(A)]), marks = twins.map(p => p.messages.length);
      for (const peer of twins) peer.send({ type: 'world_join', project_id: projectId, branch_id: 'main', resource_id: rid, runtime_build_id: runtime.build_id });
      const responses = await Promise.all(twins.map((peer, i) => peer.wait(m => m.type === 'world' && m.packet.action === 'join' || m.type === 'error', marks[i])));
      assert.equal(responses.filter(r => r.type === 'world').length, 1); assert.equal(responses.filter(r => r.type === 'error' && r.status === 409).length, 1);
      const win = responses.findIndex(r => r.type === 'world'), lose = 1 - win; peerA = twins[win]; await snapshot(peerA, s => s.players[A.user.id]?.online === true); peerA.inputSeq = peerA.current().players[A.user.id].last_input_seq;
      const rejected = twins[lose], mark = rejected.messages.length, s = peerA.current(); rejected.send({ type: 'world_input', input: { world_id: s.world_id, epoch: s.epoch, scene_revision: s.scene_revision, input_seq: peerA.inputSeq + 1, move: [1, 0] } }); assert.equal((await rejected.wait(m => m.type === 'error', mark)).status, 409); rejected.ws.close();
      o.responses = responses; o.winner_user_id = A.user.id; o.authority = authority();
    }, true);
    await step('CW10', 'changing a document subscription fences control of the old world', async o => {
      await zero(peerB); const before = copy(peerB.current()), current = await branch(); ok(await req('POST', `/projects/${projectId}/branches`, A, { from_branch: 'main', branch_id: 'other', expected_head: current.head }), 201);
      const mark = peerB.messages.length; peerB.generation++; peerB.send({ type: 'subscribe', project_id: projectId, branch_id: 'other', resource_id: rid, generation: peerB.generation }); await peerB.wait(m => m.type === 'baseline' && m.branch_id === 'other', mark);
      const inputMark = peerB.messages.length; input(peerB, [1, 0]);
      try { const denied = await peerB.wait(m => m.type === 'error', inputMark, 1200); assert.equal(denied.status, 409); o.rejection = denied; }
      finally { peerB.send({ type: 'world_leave' }); await delay(100); peerB.generation++; const restore = peerB.messages.length; peerB.send({ type: 'subscribe', project_id: projectId, branch_id: 'main', resource_id: rid, generation: peerB.generation }); await peerB.wait(m => m.type === 'baseline' && m.branch_id === 'main', restore); await join(peerB); }
      o.before = before;
    });
    await step('CW13', 'unsubscribe fences old control and stops further old-world delivery', async o => {
      await zero(peerB); const before = copy(peerB.current()), mark = peerB.messages.length; peerB.send({ type: 'unsubscribe' }); input(peerB, [1, 0]); assert.equal((await peerB.wait(m => m.type === 'error', mark)).status, 409);
      peerB.send({ type: 'ping' }); await peerB.wait(m => m.type === 'pong', mark); const afterFence = peerB.messages.length; const stopped = await snapshot(peerA, s => s.players[B.user.id]?.online === false && s.tick > before.tick + 15);
      assert.equal(peerB.messages.slice(afterFence).some(m => m.type === 'world'), false); closeXZ(xz(stopped.players[B.user.id]), xz(before.players[B.user.id]));
      peerB.generation++; const restore = peerB.messages.length; peerB.send({ type: 'subscribe', project_id: projectId, branch_id: 'main', resource_id: rid, generation: peerB.generation }); await peerB.wait(m => m.type === 'baseline', restore); await join(peerB); o.fenced_snapshot = stopped;
    });
    if (focus) await patch({ name: 'Unpublished source head ahead of the persisted world' });
    await step('CW11', 'service restart restores the persisted applied world checkpoint with a new epoch', async o => {
      await zero(peerA); await zero(peerB); const observed = copy(peerA.current()), sourceHead = (await branch()).head, oldService = child.pid; await stop();
      const db = new DatabaseSync(resolve(data, 'creation/creation.sqlite'), { readOnly: true }); const saved = JSON.parse(db.prepare("SELECT body FROM documents WHERE kind='creator_world' AND id=?").get(worldId).body); db.close();
      assert.equal(saved.revision, appliedRevision); assert.equal(saved.snapshot.scene_revision, appliedRevision); assert.ok(saved.snapshot.tick >= observed.tick); assert.notEqual(sourceHead, appliedRevision);
      const wire = (await readFile(resolve(out, 'worker-wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse), shutdown = wire.findLast(x => x.server_pid === oldService && x.direction === 'node_to_godot' && x.packet.type === 'shutdown'); assert.ok(shutdown?.packet.request_id);
      const checkpoint = wire.find(x => x.direction === 'godot_to_node' && x.packet.type === 'checkpoint' && x.packet.request_id === shutdown.packet.request_id); assert.equal(checkpoint?.packet.ok, true); assert.deepEqual(saved.snapshot, checkpoint.packet.snapshot);
      await start(); peerA = await connect(A); peerB = await connect(B); const [ja, jb] = await Promise.all([join(peerA), join(peerB)]); const after = await snapshot(peerA, s => s.players[A.user.id]?.online && s.players[B.user.id]?.online);
      assert.equal(ja.world_id, worldId); assert.equal(jb.world_id, worldId); assert.equal(after.epoch, epoch + 1); assert.equal(after.scene_revision, appliedRevision); assert.notEqual(authority().pid, authorityPid); assert.ok(after.tick >= saved.snapshot.tick); assert.ok(moduleState(after).counter >= moduleState(saved.snapshot).counter); assert.equal(moduleState(after).interactions, moduleState(saved.snapshot).interactions);
      for (const user of [A, B]) { closeXZ(xz(after.players[user.user.id]), xz(saved.snapshot.players[user.user.id])); assert.equal(after.players[user.user.id].last_input_seq, saved.snapshot.players[user.user.id].last_input_seq); }
      const mark = peerA.messages.length; input(peerA, [1, 0], { epoch }); assert.equal((await peerA.wait(m => m.type === 'error', mark)).status, 409);
      const restoredDb = new DatabaseSync(resolve(data, 'creation/creation.sqlite'), { readOnly: true }); const validations = restoredDb.prepare("SELECT body FROM documents WHERE kind='creator_verification'").all().map(x => JSON.parse(x.body)); restoredDb.close();
      const restoreCheck = validations.filter(v => v.started_at >= report.processes.at(-1).started_at && v.revision === appliedRevision).sort((a, b) => a.started_at - b.started_at)[0]; assert.ok(restoreCheck); assert.equal(restoreCheck.state_hash, hash(stable(saved.snapshot)));
      const actualCandidate = JSON.parse(await readFile(resolve(dirname(restoreCheck.evidence.report), 'candidate.json'), 'utf8')); assert.deepEqual(actualCandidate.state, saved.snapshot); await verification(restoreCheck); await writeFile(resolve(out, 'restore-candidate.json'), JSON.stringify(clean(actualCandidate), null, 2));
      o.old_service_pid = oldService; o.new_service_pid = child.pid; o.saved_checkpoint = saved; o.actual_shutdown = shutdown; o.actual_checkpoint = checkpoint; o.restore_verification = restoreCheck; o.after = after; o.restored_authority = authority(); o.scope = 'Actual Godot shutdown reply equals the stored checkpoint; that same state/hash is passed to the independent restart validator. This does not claim crash zero-loss.';
    });
    report.completed = report.cases.every(c => c.status === 'passed');
  } catch (error) { report.fatal_error = { message: error.message, stack: error.stack }; throw error; }
  finally {
    await stop(); clearInterval(monitor); sampleProcesses();
    for (let i = 0; i < 30; i++) { report.remaining_owned_children = readProcesses().filter(p => seenChildren.has(p.pid)); if (!report.remaining_owned_children.length) break; await delay(100); }
    if (report.remaining_owned_children.length) { report.completed = false; report.cleanup_warning = 'Owned Godot child process remains after service shutdown; exact PIDs recorded, no unrelated process terminated.'; }
    report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(resolve(root, file)))]))); report.source_changed_during_run = files.filter(file => report.source_hashes[file] !== report.source_hashes_after[file]);
    if (runtime) report.runtime_source_changed_during_run = (await Promise.all(runtime.sources.map(async file => ({ path: file.path, matches: hash(await readFile(resolve(root, 'runtimes/model-preview', file.path))) === file.sha256 })))).filter(x => !x.matches).map(x => x.path);
    await save(); await writeFile(resolve(out, 'server.log'), clean(log)); await writeFile(resolve(out, 'executed-driver.mjs'), await readFile(fileURLToPath(import.meta.url)));
    console.log(`WORLD_REPORT ${resolve(out, 'report.json')}`); console.log(`WORLD_COUNTS ${JSON.stringify(report.counts)}`);
  }
});
