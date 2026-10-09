/**
 * Independent HTTP / authenticated WS / real Godot hierarchy integration.
 * Requires an isolated source snapshot and an explicitly frozen runtime build.
 * No browser, GPU, real Agent, export, fabricated worker, or production state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const codeRoot = process.env.WORLD_ATELIER_CREATION_CODE_ROOT && resolve(process.env.WORLD_ATELIER_CREATION_CODE_ROOT);
const expectedBuild = process.env.WORLD_ATELIER_EXPECT_RUNTIME_BUILD;
const port = 48921, origin = `http://127.0.0.1:${port}`, api = `${origin}/creation-api`;
const sceneId = 'scene-harbor', otherSceneId = 'scene-second', cabinId = 'prefab-cabin', doorId = 'prefab-door';
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const uid = prefix => `${prefix}-${randomUUID()}`;
const clone = structuredClone;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /^(password|token|authorization|cap|code)$/i.test(key) ? '[redacted]' : clean(entry)])) : typeof value === 'string' ? value.replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]') : value;
const addressKey = address => JSON.stringify([address.project_id, address.branch_id, address.resource_id, address.instance_path, address.definition_node_id]);

// Independent numeric oracle. It does not import the production TRS/resolver.
function quatMultiply(a, b) {
  const [x, y, z, w] = a, [X, Y, Z, W] = b;
  return [w * X + x * W + y * Z - z * Y, w * Y - x * Z + y * W + z * X, w * Z + x * Y - y * X + z * W, w * W - x * X - y * Y - z * Z];
}
function trs(position = [0, 0, 0], degrees = [0, 0, 0], scale = [1, 1, 1]) {
  const [x, y, z] = degrees.map(n => n * Math.PI / 360);
  return { position, rotation: quatMultiply(quatMultiply([0, Math.sin(y), 0, Math.cos(y)], [Math.sin(x), 0, 0, Math.cos(x)]), [0, 0, Math.sin(z), Math.cos(z)]), scale };
}
function matrix({ position: p, rotation: [x, y, z, w], scale: s }) {
  return [(1 - 2 * y * y - 2 * z * z) * s[0], (2 * x * y + 2 * z * w) * s[0], (2 * x * z - 2 * y * w) * s[0], 0,
    (2 * x * y - 2 * z * w) * s[1], (1 - 2 * x * x - 2 * z * z) * s[1], (2 * y * z + 2 * x * w) * s[1], 0,
    (2 * x * z + 2 * y * w) * s[2], (2 * y * z - 2 * x * w) * s[2], (1 - 2 * x * x - 2 * y * y) * s[2], 0, ...p, 1];
}
function multiply(a, b) {
  return Array.from({ length: 16 }, (_, index) => {
    const row = index % 4, col = Math.floor(index / 4);
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[col * 4 + k], 0);
  });
}
function near(actual, expected, label, tolerance = 0.00008) {
  assert.equal(actual?.length, expected.length, `${label}: vector length`);
  assert.ok(actual.every((n, i) => Number.isFinite(n) && Math.abs(n - expected[i]) <= tolerance), `${label}: ${JSON.stringify(actual)} versus ${JSON.stringify(expected)}`);
}
function node(id, parent, transform = trs(), extra = {}) {
  return { id, name: id, kind: 'anchor', parent_id: parent, transform, color: '#74d5cd', solid: false, components: {}, ...extra };
}
function document(id, kind = 'scene') {
  return { schema: 2, id, kind, name: id, root_id: 'root', nodes: { root: node('root', null, trs(), { kind: 'group' }) }, instances: {} };
}
function behaviorSource(nested = false) {
  return `extends RefCounted
func initialize(context) -> Dictionary:
\tcontext.state["ticks"] = int(context.state.get("ticks", 0))
\tcontext.state["interactions"] = int(context.state.get("interactions", 0))
${nested ? '\tcontext.state["address"] = context.address.duplicate(true)\n\tcontext.state["source_revision"] = context.source_revision\n\tcontext.state["object_version"] = context.object_version\n\tcontext.state["source_world_matrix"] = context.source_world_matrix.duplicate()\n' : ''}\treturn {"ok": true}
func tick(context, _delta: float) -> Dictionary:
\tif context.role == "authority":
\t\tcontext.state["ticks"] = int(context.state["ticks"]) + 1
\treturn {"ok": true}
func interact(context, player: Dictionary) -> Dictionary:
\tcontext.state["interactions"] = int(context.state["interactions"]) + 1
\tcontext.state["last_player"] = player["id"]
\treturn {"ok": true}
`;
}
async function freePort() {
  const probe = createServer();
  await new Promise((yes, no) => { probe.once('error', no); probe.listen(port, '127.0.0.1', yes); });
  await new Promise(yes => probe.close(yes));
}

test('hierarchy integration: actual isolated service, two users and Godot authority', { timeout: 360000 }, async t => {
  assert.ok(codeRoot && codeRoot !== root, 'Set WORLD_ATELIER_CREATION_CODE_ROOT to an independently copied source/runtime directory; do not execute against the production tree');
  assert.match(expectedBuild ?? '', /^[a-f0-9]{64}$/, 'Set the explicitly approved WORLD_ATELIER_EXPECT_RUNTIME_BUILD before running');
  await freePort();
  const out = resolve(root, '.local/creation-verification/hierarchy-world', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-real-hierarchy-world-'));
  await mkdir(out, { recursive: true });
  await chmod(out, 0o700);
  const godot = process.env.GODOT_BIN ?? '/Applications/Godot.app/Contents/MacOS/Godot';
  const report = { started_at: new Date().toISOString(), root, code_root: codeRoot, data, port, expected_runtime_build: expectedBuild,
    scope: 'Actual isolated HTTP + authenticated WS + Godot editor binary --headless --path. No real Agent, exported native app, browser, GPU, UI handle or Case02/05 completion claim.',
    node_version: process.version, godot_version: execFileSync(godot, ['--version'], { encoding: 'utf8' }).trim(),
    cases: [], processes: [], children: [], source_hashes: {}, completed: false };
  let child, runtime, A, B, projectId, peerA, peerB, flatAsset, nestedAsset, model, entryRoot, flatRevision, worldId, epoch, initialAuthorityPid;
  let log = '', fatal = false;
  const sockets = new Set(), seenChildren = new Map(), credentials = [];
  const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(clean(report), null, 2) + '\n');
  const trace = row => appendFileSync(resolve(out, 'client-traffic.jsonl'), JSON.stringify(clean({ at: Date.now(), ...row })) + '\n');
  const files = ['services/preview/server.mjs', 'services/preview/glb.mjs', 'tests/creation/observe-worker.mjs'];
  for (const directory of ['services/creation', 'packages/scene']) {
    for (const name of await readdir(resolve(codeRoot, directory))) if (/\.(mjs|js|json)$/.test(name)) files.push(`${directory}/${name}`);
  }
  for (const file of files) report.source_hashes[file] = sha(await readFile(resolve(codeRoot, file)));
  function processes() {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)).filter(Boolean).map(match => ({ pid: +match[1], ppid: +match[2], state: match[3], command: match[4] }));
  }
  function sampleProcesses() {
    const parents = new Set(report.processes.map(p => p.pid));
    for (const row of processes().filter(p => parents.has(p.ppid))) seenChildren.set(row.pid, { ...seenChildren.get(row.pid), ...row, last_seen_at: Date.now() });
    report.children = [...seenChildren.values()];
  }
  const monitor = setInterval(sampleProcesses, 250); monitor.unref();
  async function start() {
    await freePort();
    const env = { ...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: data, WORLD_ATELIER_CREATION_DATA: resolve(data, 'creation'), WORLD_ATELIER_DISABLE_AGENT: '1', WORLD_ATELIER_ENABLE_HIERARCHY: '1', WORLD_ATELIER_TEST_WORKER_TRACE: resolve(out, 'worker-wire.jsonl') };
    delete env.WORLD_ATELIER_DISABLE_WORLDS;
    child = spawn(process.execPath, ['--import', './tests/creation/observe-worker.mjs', 'services/preview/server.mjs'], { cwd: codeRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { pid: child.pid, started_at: Date.now() }; report.processes.push(record);
    child.stdout.on('data', bytes => { log += `[${record.pid} stdout] ${bytes}`; }); child.stderr.on('data', bytes => { log += `[${record.pid} stderr] ${bytes}`; });
    child.once('exit', (exit_code, signal) => Object.assign(record, { exit_code, signal, stopped_at: Date.now() }));
    for (let i = 0; i < 140; i++) {
      if (child.exitCode !== null) throw Error(clean(log));
      try { const response = await fetch(`${api}/health`); if (response.ok) return response.json(); } catch {}
      await delay(50);
    }
    throw Error('Isolated hierarchy service did not become ready');
  }
  async function stop() {
    // Keep the real client sockets open until the parent begins orderly shutdown.
    if (child && child.exitCode === null && child.signalCode === null) {
      const owned = child, exited = new Promise(yes => owned.once('exit', yes)); owned.kill('SIGTERM');
      const timer = setTimeout(() => owned.kill('SIGKILL'), 10000); await exited; clearTimeout(timer);
    }
    for (const socket of sockets) socket.terminate(); sockets.clear();
    await freePort();
  }
  async function request(method, path, user = A, input, raw = false) {
    const headers = { origin, 'content-type': raw ? 'application/octet-stream' : 'application/json' };
    if (user) headers.authorization = `Bearer ${user.token}`;
    if (raw) headers['x-asset-name'] = encodeURIComponent(input.name);
    const response = await fetch(api + path, { method, headers, body: input === undefined ? undefined : raw ? input.bytes : JSON.stringify(input) });
    const value = await response.json();
    await trace({ transport: 'http', method, path, actor: user?.user?.id, input: raw ? { name: input.name, bytes: input.bytes.length, sha256: sha(input.bytes) } : input, status: response.status, value });
    return { status: response.status, value };
  }
  const ok = (response, code = 200) => { assert.equal(response.status, code, JSON.stringify(clean(response.value))); return response.value; };
  const branchPath = (branch = 'main') => `/projects/${projectId}/branches/${branch}`;
  const branch = (name = 'main') => request('GET', branchPath(name)).then(ok);
  async function transaction(ops, { user = A, branch: name = 'main', base, expectedHead, transactionId = uid('hierarchy-edit') } = {}) {
    const current = base ?? await branch(name);
    return request('POST', `${branchPath(name)}/transactions`, user, { transaction_id: transactionId, base_revision: current.head, ...(expectedHead ? { expected_head: expectedHead } : {}), ops });
  }
  async function rows(resource = sceneId, revision = null, name = 'main') {
    const head = revision ?? (await branch(name)).head;
    return ok(await request('GET', `${branchPath(name)}/resolved-scene?revision=${head}&resource_id=${resource}`));
  }
  async function scene(resource = sceneId, revision = null) {
    return ok(await request('GET', `${branchPath()}/runtime-scene?revision=${revision ?? (await branch()).head}&resource_id=${resource}`));
  }
  const address = (path, id, resource = sceneId) => ({ project_id: projectId, branch_id: 'main', resource_id: resource, instance_path: path, definition_node_id: id });
  const findRow = (value, target) => value.rows.find(row => addressKey(row.address) === addressKey(target));
  const mount = (id, prefab, parent, transform = trs(), overrides = []) => ({ instance_id: id, prefab_id: prefab.id, prefab_revision: prefab.version, parent_id: parent, transform, overrides });
  const behavior = asset => ({ id: 'independent-hierarchy-counter', api: 1, script_hash: asset.id, script_url: asset.url, properties: {} });
  async function upload(text, name) { return ok(await request('POST', `/projects/${projectId}/assets`, A, { name, bytes: Buffer.from(text) }, true), 201); }
  async function connect(user, resource = sceneId, name = 'main') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/creation`, { origin }), messages = [];
    sockets.add(ws); const peer = { ws, user, resource, branch: name, messages, generation: 1, inputSeq: 0 };
    ws.on('message', bytes => { const packet = JSON.parse(bytes.toString()); messages.push(packet); void trace({ transport: 'ws-receive', actor: user.user.id, packet }); });
    ws.on('error', () => {});
    peer.send = packet => { void trace({ transport: 'ws-send', actor: user.user.id, packet }); ws.send(JSON.stringify(packet)); };
    peer.wait = async (predicate, mark = 0, timeout = 8000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { const found = messages.slice(mark).find(predicate); if (found) return found; await delay(15); }
      throw Error(`Authenticated WS timeout: ${JSON.stringify(clean(messages.slice(-4)))}`);
    };
    peer.current = () => messages.findLast(m => m.type === 'world' && m.packet?.action === 'snapshot')?.packet.snapshot;
    await new Promise((yes, no) => { ws.once('open', yes); ws.once('error', no); });
    peer.send({ type: 'auth', token: user.token }); await peer.wait(m => m.type === 'authenticated');
    peer.send({ type: 'subscribe', project_id: projectId, branch_id: name, resource_id: resource, generation: peer.generation });
    await peer.wait(m => m.type === 'baseline');
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) peer.send({ type: 'ping' }); }, 10000); ping.unref(); ws.once('close', () => clearInterval(ping));
    return peer;
  }
  async function subscribe(peer, resource, name = 'main') {
    const mark = peer.messages.length; peer.resource = resource; peer.branch = name; peer.generation++;
    peer.send({ type: 'subscribe', project_id: projectId, branch_id: name, resource_id: resource, generation: peer.generation });
    return peer.wait(m => m.type === 'baseline' && m.generation === peer.generation, mark);
  }
  const snapshot = (peer, predicate, mark = peer.messages.length, timeout = 10000) => peer.wait(m => m.type === 'world' && m.packet?.action === 'snapshot' && predicate(m.packet.snapshot), mark, timeout).then(m => m.packet.snapshot);
  async function join(peer, revision) {
    const mark = peer.messages.length;
    peer.send({ type: 'world_join', project_id: projectId, branch_id: peer.branch, resource_id: peer.resource, runtime_build_id: runtime.build_id, ...(revision ? { source_revision: revision } : {}) });
    const response = await peer.wait(m => m.type === 'world' && m.packet.action === 'join' || m.type === 'error', mark, 70000);
    assert.equal(response.type, 'world', JSON.stringify(response));
    const state = await snapshot(peer, s => s.world_id === response.packet.world_id && s.players[peer.user.user.id]?.online, mark);
    peer.inputSeq = state.players[peer.user.user.id].last_input_seq; return response.packet;
  }
  function input(peer, move, extra = {}) {
    const state = peer.current(), input_seq = ++peer.inputSeq;
    peer.send({ type: 'world_input', input: { world_id: state.world_id, epoch: state.epoch, scene_revision: state.scene_revision, input_seq, move, ...extra } }); return input_seq;
  }
  async function zero(peer) {
    const mark = peer.messages.length, sequence = input(peer, [0, 0]);
    return snapshot(peer, s => s.players[peer.user.user.id]?.last_input_seq >= sequence && Math.abs(s.players[peer.user.user.id].velocity[0]) < 0.01 && Math.abs(s.players[peer.user.user.id].velocity[2]) < 0.01, mark);
  }
  function authorityPids(expectedCount) {
    sampleProcesses(); const current = processes().filter(p => p.ppid === child.pid && p.command.includes('--authority'));
    if (expectedCount !== undefined) assert.equal(current.length, expectedCount);
    for (const process of current) { assert.ok(process.command.startsWith(`${godot} `)); assert.ok(process.command.includes(`--headless --path ${resolve(codeRoot, 'runtimes/model-preview')}`)); }
    return current;
  }
  async function verification(value) {
    const v = value.verification ?? value;
    assert.ok(v.evidence?.report && v.evidence?.log, 'Real Godot validator evidence is required');
    const reportBytes = await readFile(v.evidence.report), logBytes = await readFile(v.evidence.log);
    const parsed = JSON.parse(reportBytes);
    await mkdir(resolve(out, 'validators'), { recursive: true });
    await writeFile(resolve(out, 'validators', `${v.id}.json`), JSON.stringify(clean(parsed), null, 2));
    await writeFile(resolve(out, 'validators', `${v.id}.log`), clean(logBytes.toString()));
    if (v.status === 'passed') { assert.equal(v.process.code, 0); assert.equal(parsed.ok, true); assert.equal(parsed.completed, true); assert.equal(/SCRIPT ERROR|Parse Error|ERROR:/.test(logBytes.toString()), false); }
    return { verification: v, report: parsed };
  }
  async function publish(resource = sceneId) {
    const current = await branch(), result = ok(await request('POST', `${branchPath()}/publish`, A, { revision: current.head, resource_id: resource }));
    return { ...result, checked: await verification(result), revision: current.head };
  }
  async function workerPackets() { return (await readFile(resolve(out, 'worker-wire.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  function assertGraph(graph, pack) {
    assert.ok(graph, 'Expected actual Godot scene_graph, not the source compatibility objects list');
    assert.equal(graph.pack_hash, pack.pack_hash);
    assert.equal(graph.objects.length, pack.objects.length); assert.equal(graph.mounts.length, pack.mounts.length);
    for (const object of pack.objects) {
      const actual = graph.objects.find(row => row.id === object.id); assert.ok(actual);
      assert.deepEqual(actual.address, object.address); assert.equal(actual.object_version, object.object_version); assert.equal(actual.ancestry_hash, object.ancestry_hash);
      near(actual.world_matrix, object.world_matrix, `actual Godot ${object.id}`);
      assert.equal(actual.source_revision, pack.source_revision);
      for (const field of ['position', 'rotation', 'scale']) near(actual.local_transform[field], object.local_transform[field], `actual local ${object.id}.${field}`);
    }
    for (const mount of pack.mounts) {
      const actual = graph.mounts.find(row => row.id === mount.id); assert.ok(actual); assert.deepEqual(actual.address, mount.address); near(actual.world_matrix, mount.world_matrix, `actual mount ${mount.id}`);
    }
  }
  async function step(id, title, fn, required = true) {
    const item = { id, title, status: 'running', observations: {}, started_at: Date.now() }; report.cases.push(item);
    await t.test(`${id} ${title}`, async () => {
      try { await fn(item.observations); item.status = 'passed'; }
      catch (error) { item.status = 'failed'; item.error = { message: error.message, stack: error.stack }; throw error; }
      finally { item.finished_at = Date.now(); await save(); console.log(`HIERARCHY_CASE ${id} ${item.status}`); }
    });
    if (required && item.status !== 'passed') { fatal = true; throw Error(`Cannot safely continue after ${id}`); }
  }
  // Stages are added below. Preparing this driver is not an executed acceptance.
  try {
    report.health = await start();
    for (const label of ['owner', 'peer']) {
      const password = uid('isolated-password'), name = uid(`hierarchy-${label}`), user = ok(await request('POST', '/auth/register', null, { name, password }), 201);
      credentials.push({ name, password, user_id: user.user.id }); if (label === 'owner') A = user; else B = user;
    }
    const created = ok(await request('POST', '/projects', A, { name: uid('Independent hierarchy fixture'), template: 'empty' }), 201);
    projectId = created.project.id; report.project_id = projectId;
    const invite = ok(await request('POST', `/projects/${projectId}/invites`, A, { role: 'editor' }), 201); ok(await request('POST', '/invites/join', B, { code: invite.code }));
    await writeFile(resolve(out, 'fixture-access.private.json'), JSON.stringify({ data, project_id: projectId, users: credentials }, null, 2), { mode: 0o600 });
    await step('AH01', 'frozen capability-bearing runtime and actual downloadable hashes', async o => {
      assert.equal(report.health.agent_ready, false); assert.equal(report.health.worlds_ready, true); assert.equal(report.health.hierarchy_editing, true);
      const response = await fetch(`${origin}/preview-runtime/manifest.json`); assert.equal(response.status, 200); runtime = await response.json();
      assert.equal(runtime.build_id, expectedBuild); report.runtime_manifest = runtime;
      assert.ok(runtime.capabilities?.document_schemas?.includes('creation-hierarchy-2'));
      const immutable = await fetch(`${origin}/preview-builds/${runtime.build_id}/manifest.json`); assert.equal(immutable.status, 200); assert.deepEqual(await immutable.json(), runtime);
      for (const file of runtime.sources) assert.equal(sha(await readFile(resolve(codeRoot, 'runtimes/model-preview', file.path))), file.sha256);
      o.files = [];
      for (const file of runtime.files) {
        const asset = await fetch(`${origin}/preview-builds/${runtime.build_id}/${file.path}`), bytes = Buffer.from(await asset.arrayBuffer());
        assert.equal(asset.status, 200); assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256); o.files.push({ path: file.path, sha256: sha(bytes), bytes: bytes.length });
      }
      const catalog = JSON.parse(await readFile(resolve(codeRoot, 'content/model-preview/manifest.json'), 'utf8'));
      model = catalog.assets.find(asset => asset.slug === 'beacon') ?? catalog.assets[0];
      assert.equal(sha(await readFile(resolve(codeRoot, 'content/model-preview', model.file))), model.sha256);
      flatAsset = await upload(behaviorSource(), 'independent-flat-counter.gd'); nestedAsset = await upload(behaviorSource(true), 'independent-nested-address-counter.gd');
      o.fixture_assets = [{ id: model.sha256, kind: 'actual builtin GLB', bytes: model.bytes }, flatAsset, nestedAsset];
    });
    await step('AH02', 'two authenticated clients actually play the flat document before migration', async o => {
      const current = await branch();
      const made = ok(await transaction([{ type: 'put_object', resource_id: sceneId, object_id: 'baseline-counter', expected_version: null,
        object: { id: 'baseline-counter', name: 'Independent flat counter', kind: 'anchor', position: [0, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1], components: { interactable: { radius: 12, label: 'Independent fixture' }, behaviors: [behavior(flatAsset)] } } }], { base: current }));
      flatRevision = made.revision;
      const s = ok(await request('POST', `${branchPath()}/sessions`, A, { title: 'Retained flat source observation' }), 201);
      const object = made.branch.manifest.resources[sceneId].objects[0];
      const attachment = ok(await request('POST', `/sessions/${s.id}/attachments`, A, { resource_id: sceneId, object_id: object.id, revision: flatRevision, expected_version: object.version }), 201);
      report.flat_attachment = { session_id: s.id, attachment };
      peerA = await connect(A); peerB = await connect(B);
      const [a, b] = await Promise.all([join(peerA, flatRevision), join(peerB, flatRevision)]);
      assert.equal(a.world_id, b.world_id); assert.equal(a.epoch, b.epoch); worldId = a.world_id; epoch = a.epoch; initialAuthorityPid = authorityPids(1)[0].pid;
      const before = await snapshot(peerA, state => state.players[A.user.id]?.grounded && state.players[B.user.id]?.grounded);
      for (let i = 0; i < 5; i++) { input(peerA, [1, 0]); input(peerB, [-1, 0]); await delay(100); }
      await zero(peerA); const stopped = await zero(peerB);
      assert.ok(stopped.players[A.user.id].position[0] > before.players[A.user.id].position[0] + 1);
      assert.ok(stopped.players[B.user.id].position[0] < before.players[B.user.id].position[0] - 1);
      const interactions = stopped.object_states['baseline-counter']['independent-hierarchy-counter'].interactions;
      const seq = input(peerA, [0, 0], { interact: true });
      const acted = await snapshot(peerA, state => state.players[A.user.id].last_input_seq >= seq && state.object_states['baseline-counter']['independent-hierarchy-counter'].interactions === interactions + 1);
      await zero(peerA); o.before = before; o.after_actual_input = acted; o.joins = [a, b]; o.authority = authorityPids(1)[0];
    });
    await step('AH03', 'explicit flat migration preserves old live until real same-process publish', async o => {
      const before = await branch(), live = clone(peerA.current());
      const missing = await transaction([{ type: 'migrate_hierarchy', resource_id: sceneId }], { base: before }); assert.equal(missing.status, 409); assert.equal((await branch()).head, before.head);
      const migrated = ok(await transaction([{ type: 'migrate_hierarchy', resource_id: sceneId }], { base: before, expectedHead: before.head }));
      assert.equal(migrated.branch.manifest.schema, 'creation-hierarchy-2'); entryRoot = migrated.branch.manifest.resources[sceneId].root_id;
      const original = before.manifest.resources[sceneId].objects[0], converted = migrated.branch.manifest.resources[sceneId].nodes[original.id];
      near(matrix(converted.transform), matrix(trs(original.position, original.rotation, original.scale)), 'migration TRS'); assert.deepEqual(converted.components, original.components);
      const oldStillRuns = await snapshot(peerA, state => state.tick >= live.tick + 15);
      assert.equal(oldStillRuns.scene_revision, flatRevision); assert.equal(authorityPids(1)[0].pid, initialAuthorityPid);
      const mark = peerB.messages.length;
      peerB.send({ type: 'world_join', project_id: projectId, branch_id: 'main', resource_id: sceneId, runtime_build_id: runtime.build_id, source_revision: migrated.revision });
      assert.equal((await peerB.wait(m => m.type === 'error', mark)).status, 409, 'Fixed new-source Play must not silently borrow the old flat live');
      const retained = ok(await request('GET', `/sessions/${report.flat_attachment.session_id}`));
      assert.deepEqual(retained.draft_attachments[0], report.flat_attachment.attachment);
      const published = await publish(), applied = await snapshot(peerA, state => state.scene_revision === published.revision);
      assert.equal(applied.world_id, worldId); assert.equal(applied.epoch, epoch); assert.equal(authorityPids(1)[0].pid, initialAuthorityPid);
      assert.equal(applied.object_states['baseline-counter']['independent-hierarchy-counter'].interactions, live.object_states['baseline-counter']['independent-hierarchy-counter'].interactions);
      for (const user of [A, B]) near([applied.players[user.user.id].position[0], applied.players[user.user.id].position[2]], [live.players[user.user.id].position[0], live.players[user.user.id].position[2]], 'migration player XZ', 0.03);
      const pack = (await scene(sceneId, published.revision)).hierarchy_pack; assertGraph(published.checked.report.scene_graph, pack);
      o.source_before = before.head; o.source_after = migrated.revision; o.old_live_after_migration = oldStillRuns; o.actual_publication = published; o.applied = applied;
    });
    await step('AH04', 'two scenes and three pinned shared prefabs retain complete nested identities', async o => {
      const door = document(doorId, 'prefab'); door.nodes.root.transform = trs([0, 0.75, 0]);
      door.nodes.door = node('door', 'root', trs([0.5, 0.1, 1]), { name: 'Same named nested door', kind: 'model', model_hash: model.sha256, model_url: `/preview-assets/${model.sha256}.glb`,
        components: { collider: { shape: 'box', size: [0.6, 1.4, 0.2], offset: [0, 0.7, 0] }, trigger: { shape: 'box', size: [1, 2, 0.4], offset: [0, 1, 0] }, behaviors: [behavior(nestedAsset)] } });
      ok(await transaction([{ type: 'create_resource', resource_id: doorId, resource: door }]));
      let current = await branch();
      const cabin = document(cabinId, 'prefab'); cabin.nodes.root.transform = trs([0.3, 0.2, -0.2]);
      cabin.nodes.shell = node('shell', 'root', trs(), { name: 'Cabin shell v1', kind: 'model', model_hash: model.sha256, model_url: `/preview-assets/${model.sha256}.glb` });
      cabin.instances['door-slot'] = mount('door-slot', current.manifest.resources[doorId], 'root', trs([1, 0.5, 0]));
      const second = document(otherSceneId); second.nodes.root.transform = trs([3, 0, 0], [0, 10, 0]);
      ok(await transaction([{ type: 'create_resource', resource_id: cabinId, resource: cabin }, { type: 'create_resource', resource_id: otherSceneId, resource: second }]));
      current = await branch();
      const parent = trs([12, 2, -8], [12, 24, 8], [1.2, 1.4, 0.8]);
      const nodes = [node('carrier', entryRoot, parent, { kind: 'group' }), node('carrier-peer', entryRoot, trs([16, 2, -8], [12, 24, 8], [1.2, 1.4, 0.8]), { kind: 'group' }),
        node('shear-parent', entryRoot, trs([10, 3, -5], [27, -31, 16], [2, 0.6, 1.4]), { kind: 'group' }),
        node('edit-prop', 'carrier', trs([0, 1, 0], [8, 17, 11], [0.8, 1.1, 0.9]), { kind: 'model', model_hash: model.sha256, model_url: `/preview-assets/${model.sha256}.glb` }),
        node('box-probe', 'carrier', trs([3, 0, 0]), { components: { collider: { shape: 'box', size: [1, 1, 1] } } })];
      const leftOverride = { target: { instance_path: ['door-slot'], definition_node_id: 'door' }, path: ['color'], value: '#3399ff' };
      const ops = nodes.map(value => ({ type: 'put_node', resource_id: sceneId, node_id: value.id, expected_version: null, node: value }));
      ops.push({ type: 'instantiate_prefab', resource_id: sceneId, instance_id: 'hut-a', expected_version: null, instance: mount('hut-a', current.manifest.resources[cabinId], 'carrier', trs(), [leftOverride]) },
        { type: 'instantiate_prefab', resource_id: sceneId, instance_id: 'hut-b', expected_version: null, instance: mount('hut-b', current.manifest.resources[cabinId], entryRoot, trs([-10, 1, -8], [0, 35, 0])) },
        { type: 'instantiate_prefab', resource_id: otherSceneId, instance_id: 'hut-c', expected_version: null, instance: mount('hut-c', current.manifest.resources[cabinId], 'root', trs([0, 2, -6], [0, 60, 10])) });
      const made = ok(await transaction(ops));
      const firstRows = await rows(), otherRows = await rows(otherSceneId), a = findRow(firstRows, address(['hut-a', 'door-slot'], 'door')), b = findRow(firstRows, address(['hut-b', 'door-slot'], 'door')), c = findRow(otherRows, address(['hut-c', 'door-slot'], 'door', otherSceneId));
      assert.ok(a && b && c); assert.equal(a.node.name, b.node.name); assert.notEqual(addressKey(a.address), addressKey(b.address));
      assert.equal(a.node.color, '#3399ff'); assert.equal(b.node.color, '#74d5cd'); assert.equal(c.node.color, '#74d5cd');
      const expected = [parent, trs(), cabin.nodes.root.transform, cabin.instances['door-slot'].transform, door.nodes.root.transform, door.nodes.door.transform].map(matrix).reduce(multiply);
      near(a.world_matrix, expected, 'independent six-level world matrix oracle');
      report.fixture = { source_revision: made.revision, flat_counter_id: 'baseline-counter', model_hash: model.sha256, nested_script_hash: nestedAsset.id, instances: [a.address, b.address, c.address], original_cabin_revision: made.branch.manifest.resources[cabinId].version };
      o.rows = [a, b, c]; o.independent_expected_matrix = expected; o.fixture = report.fixture;
    });
    await step('AH05', 'definition edits stay pinned, preview CAS and explicit selected-instance upgrade', async o => {
      let current = await branch(); const oldPin = current.manifest.resources[cabinId].version, previousArchive = clone(current.manifest.prefab_revisions[oldPin]);
      const shell = current.manifest.resources[cabinId].nodes.shell;
      ok(await transaction([{ type: 'patch_node', resource_id: cabinId, node_id: 'shell', expected_version: shell.version, patch: { name: 'Cabin shell v2', color: '#bb6622' } }]));
      current = await branch(); const newPin = current.manifest.resources[cabinId].version;
      assert.notEqual(newPin, oldPin); assert.deepEqual(current.manifest.prefab_revisions[oldPin], previousArchive);
      for (const [resource, id] of [[sceneId, 'hut-a'], [sceneId, 'hut-b'], [otherSceneId, 'hut-c']]) assert.equal(current.manifest.resources[resource].instances[id].prefab_revision, oldPin);
      const missingHead = await request('POST', `${branchPath()}/hierarchy-preview`, A, { prefab_id: cabinId, prefab_revision: newPin }); assert.equal(missingHead.status, 409);
      const impact = ok(await request('POST', `${branchPath()}/hierarchy-preview`, A, { expected_head: current.head, prefab_id: cabinId, prefab_revision: newPin })); assert.equal(impact.direct.length, 3);
      let preview = ok(await request('POST', `${branchPath()}/hierarchy-preview`, A, { expected_head: current.head, resource_id: sceneId, instance_id: 'hut-a', prefab_revision: newPin }));
      assert.equal(preview.conflicts.length, 0); assert.equal(preview.retained.length, 1);
      const staleHead = current.head, staleInstance = current.manifest.resources[sceneId].instances['hut-a'];
      ok(await transaction([{ type: 'patch_node', resource_id: sceneId, node_id: 'box-probe', expected_version: current.manifest.resources[sceneId].nodes['box-probe'].version, patch: { name: 'Unrelated source advance' } }]));
      const op = { type: 'upgrade_instance', resource_id: sceneId, instance_id: 'hut-a', expected_version: staleInstance.version, prefab_revision: newPin, expected_preview_hash: preview.preview_hash, resolutions: {} };
      assert.equal((await transaction([op], { expectedHead: staleHead })).status, 409);
      current = await branch(); assert.equal((await transaction([op], { expectedHead: current.head })).status, 409, 'Current head cannot salvage an old preview hash');
      assert.equal((await branch()).head, current.head);
      preview = ok(await request('POST', `${branchPath()}/hierarchy-preview`, A, { expected_head: current.head, resource_id: sceneId, instance_id: 'hut-a', prefab_revision: newPin }));
      ok(await transaction([{ ...op, expected_preview_hash: preview.preview_hash }], { expectedHead: current.head }));
      current = await branch(); assert.equal(current.manifest.resources[sceneId].instances['hut-a'].prefab_revision, newPin); assert.equal(current.manifest.resources[sceneId].instances['hut-b'].prefab_revision, oldPin); assert.equal(current.manifest.resources[otherSceneId].instances['hut-c'].prefab_revision, oldPin);
      const resolved = await rows(); assert.equal(findRow(resolved, address(['hut-a'], 'shell')).node.name, 'Cabin shell v2'); assert.equal(findRow(resolved, address(['hut-b'], 'shell')).node.name, 'Cabin shell v1'); assert.equal(findRow(resolved, address(['hut-a', 'door-slot'], 'door')).node.color, '#3399ff');
      const removal = ok(await transaction([{ type: 'delete_instance', resource_id: cabinId, instance_id: 'door-slot', expected_version: current.manifest.resources[cabinId].instances['door-slot'].version }]));
      current = await branch(); const noDoor = current.manifest.resources[cabinId].version;
      const conflict = ok(await request('POST', `${branchPath()}/hierarchy-preview`, A, { expected_head: current.head, resource_id: sceneId, instance_id: 'hut-a', prefab_revision: noDoor }));
      assert.ok(conflict.conflicts.some(c => c.reason === 'node_or_instance_path_deleted'));
      assert.equal((await transaction([{ ...op, expected_version: current.manifest.resources[sceneId].instances['hut-a'].version, prefab_revision: noDoor, expected_preview_hash: conflict.preview_hash }], { expectedHead: current.head })).status, 409);
      assert.equal((await branch()).head, current.head); ok(await transaction(removal.inverse));
      o.old_pin = oldPin; o.new_pin = newPin; o.impact = impact; o.selected_preview = preview; o.unresolved_deletion_conflict = conflict;
    });
    await step('AH06', 'two real users merge disjoint nested edits and fence conflicting transforms and undo', async o => {
      let current = await branch(); const marks = [peerA.messages.length, peerB.messages.length];
      const override = (id, color) => ({ type: 'set_override', resource_id: sceneId, instance_id: id, expected_version: current.manifest.resources[sceneId].instances[id].version,
        override: { target: { instance_path: ['door-slot'], definition_node_id: 'door' }, path: ['color'], value: color } });
      const disjoint = await Promise.all([transaction([override('hut-a', '#55ccaa')], { user: A, base: current }), transaction([override('hut-b', '#cc8899')], { user: B, base: current })]);
      disjoint.forEach(response => ok(response));
      for (const peer of [peerA, peerB]) for (const response of disjoint) await peer.wait(m => m.type === 'committed' && m.transaction_id === response.value.transaction_id && m.generation === peer.generation, marks[peer === peerA ? 0 : 1]);
      const resolved = await rows(); assert.equal(findRow(resolved, address(['hut-a', 'door-slot'], 'door')).node.color, '#55ccaa'); assert.equal(findRow(resolved, address(['hut-b', 'door-slot'], 'door')).node.color, '#cc8899');
      current = await branch(); const instance = current.manifest.resources[sceneId].instances['hut-a'];
      const transforms = [1, 2].map(x => ({ ...clone(instance.transform), position: [x, ...instance.transform.position.slice(1)] }));
      const conflict = await Promise.all([A, B].map((user, i) => transaction([{ type: 'patch_instance', resource_id: sceneId, instance_id: 'hut-a', expected_version: instance.version, patch: { transform: transforms[i] } }], { user, base: current })));
      assert.deepEqual(conflict.map(response => response.status).sort(), [200, 409]);
      const winner = conflict.findIndex(response => response.status === 200), receipt = conflict[winner].value;
      current = await branch(); near(current.manifest.resources[sceneId].instances['hut-a'].transform.position, transforms[winner].position, 'winning complete instance transform');
      const later = ok(await transaction([{ type: 'set_override', resource_id: sceneId, instance_id: 'hut-a', expected_version: current.manifest.resources[sceneId].instances['hut-a'].version,
        override: { target: { instance_path: ['door-slot'], definition_node_id: 'door' }, path: ['name'], value: 'Peer retained later nested edit' } }], { user: [B, A][winner] }));
      const deniedUndo = await transaction(receipt.inverse, { user: [A, B][winner] }); assert.equal(deniedUndo.status, 409); assert.equal((await branch()).head, later.revision);
      o.disjoint_receipts = disjoint; o.transform_competition = conflict; o.stale_undo = deniedUndo;
    });
    await step('AH07', 'real WS preview cancellation leaves canonical source unchanged and rejects stale identity', async o => {
      const current = await branch(), resolved = await rows(), target = findRow(resolved, address(['hut-a', 'door-slot'], 'door'));
      const moved = [...target.world_matrix]; moved[12] += 0.5;
      const packet = { type: 'drag_preview', generation: peerA.generation, source_revision: current.head, address: target.address, expected_version: target.object_version, expected_ancestry_hash: target.ancestry_hash, world_matrix: moved };
      const mark = peerB.messages.length; peerA.send(packet);
      const delivered = await peerB.wait(m => m.type === 'drag_preview' && addressKey(m.preview.address) === addressKey(target.address), mark);
      assert.deepEqual(delivered.preview.world_matrix, moved); assert.equal((await branch()).head, current.head);
      const clashMark = peerB.messages.length; peerB.send({ ...packet, generation: peerB.generation }); assert.equal((await peerB.wait(m => m.type === 'error', clashMark)).status, 409);
      const endedMark = peerB.messages.length; peerA.send({ type: 'drag_end', generation: peerA.generation }); await peerB.wait(m => m.type === 'drag_end' && addressKey(m.address) === addressKey(target.address), endedMark);
      assert.equal((await branch()).head, current.head); assert.deepEqual(findRow(await rows(), target.address).world_matrix, target.world_matrix);
      for (const patch of [{ generation: peerA.generation - 1 }, { source_revision: 'obsolete-source' }, { expected_ancestry_hash: 'obsolete-ancestor' }, { address: { ...target.address, branch_id: 'other' } }]) {
        const rejectedAt = peerA.messages.length; peerA.send({ ...packet, ...patch }); assert.equal((await peerA.wait(m => m.type === 'error', rejectedAt)).status, 409);
      }
      const live = peerA.current(); assert.ok((await snapshot(peerA, state => state.tick > live.tick + 10)).tick > live.tick);
      o.preview = delivered; o.canonical_head = current.head; o.scope = 'Authenticated WS preview/drag_end protocol, not physical Escape/focus-loss or visual gizmo proof';
    });
    await step('AH08', 'API keep-world reparent, conditional undo/redo and unrepresentable local TRS rejection', async o => {
      let current = await branch(), resolved = await rows();
      const target = findRow(resolved, address([], 'edit-prop')), parent = findRow(resolved, address([], 'carrier-peer'));
      const reparent = { type: 'reparent_node', resource_id: sceneId, node_id: 'edit-prop', expected_version: target.node.version, parent_id: 'carrier-peer', expected_ancestry_hash: target.ancestry_hash,
        expected_parent_ancestry_hash: parent.ancestry_hash, expected_parent_version: parent.node.version, keep_world: true };
      const moved = ok(await transaction([reparent])); near(findRow(await rows(), target.address).world_matrix, target.world_matrix, 'keep-world reparent');
      const undone = ok(await transaction(moved.inverse)); assert.equal((await branch()).manifest.resources[sceneId].nodes['edit-prop'].parent_id, 'carrier'); near(findRow(await rows(), target.address).world_matrix, target.world_matrix, 'conditional undo');
      const redone = ok(await transaction(undone.inverse)); assert.equal((await branch()).manifest.resources[sceneId].nodes['edit-prop'].parent_id, 'carrier-peer'); near(findRow(await rows(), target.address).world_matrix, target.world_matrix, 'conditional redo');
      ok(await transaction(redone.inverse));
      current = await branch(); resolved = await rows(); const actual = findRow(resolved, target.address), incompatible = findRow(resolved, address([], 'shear-parent'));
      const bad = await transaction([{ ...reparent, expected_version: actual.node.version, expected_ancestry_hash: actual.ancestry_hash, parent_id: 'shear-parent', expected_parent_version: incompatible.node.version, expected_parent_ancestry_hash: incompatible.ancestry_hash }]);
      assert.equal(bad.status, 422); assert.equal((await branch()).head, current.head); near(findRow(await rows(), target.address).world_matrix, actual.world_matrix, 'bad reparent leaves source');
      const carrier = current.manifest.resources[sceneId].nodes.carrier, altered = clone(carrier.transform); altered.position[1] += 0.25;
      const changed = ok(await transaction([{ type: 'patch_node', resource_id: sceneId, node_id: 'carrier', expected_version: carrier.version, patch: { transform: altered } }]));
      const oldWorld = [...actual.world_matrix]; oldWorld[12] += 1;
      const stale = await transaction([{ type: 'set_node_world_transform', resource_id: sceneId, node_id: 'edit-prop', expected_version: actual.node.version, expected_ancestry_hash: actual.ancestry_hash, world_matrix: oldWorld }]);
      assert.equal(stale.status, 409); assert.equal((await branch()).head, changed.revision); ok(await transaction(changed.inverse));
      o.reparent_receipt = moved; o.undo_receipt = undone; o.redo_receipt = redone; o.unrepresentable_local_trs = bad; o.ancestor_rejection = stale;
    });
    await step('AH09', 'actual Godot validates complete matrices, fixed GLB, nested behavior and two scene worlds', async o => {
      const current = await branch(), documents = [];
      for (const resource of [sceneId, otherSceneId, cabinId]) {
        const envelope = await scene(resource, current.head), pack = envelope.hierarchy_pack;
        assert.equal(sha(envelope.hierarchy_pack_canonical), pack.pack_hash);
        const validation = ok(await request('POST', `${branchPath()}/validate`, A, { revision: current.head, resource_id: resource }));
        assert.equal(validation.status, 'passed'); const checked = await verification(validation);
        assertGraph(checked.report.scene_graph, pack); assert.deepEqual(checked.report.runtime_capabilities, runtime.capabilities);
        for (const object of pack.objects.filter(row => row.node.model_hash)) {
          const actual = checked.report.assets.find(asset => asset.id === object.id); assert.ok(actual, 'GLB must actually be parsed for every visible fixture object');
          assert.equal(actual.hash, object.node.model_hash); assert.ok(actual.mesh_count > 0); assert.deepEqual(actual.address, object.address);
        }
        for (const object of pack.objects.filter(row => row.node.components?.trigger)) {
          const actual = checked.report.scene_graph.physics.find(row => row.id === object.id && row.kind === 'trigger'); assert.ok(actual); assert.equal(actual.shape, 'box');
          const world = object.world_matrix, offset = object.node.components.trigger.offset ?? [0, 0, 0];
          const center = [0, 1, 2].map(row => world[12 + row] + offset.reduce((sum, n, col) => sum + world[col * 4 + row] * n, 0));
          const axisLengths = [0, 4, 8].map(index => Math.hypot(...world.slice(index, index + 3)));
          near(actual.world_matrix.slice(12, 15), center, 'actual Area center'); near(actual.size, object.node.components.trigger.size.map((n, axis) => n * axisLengths[axis]), 'actual Area dimensions');
        }
        const collisionIds = pack.objects.filter(row => row.node.components?.collider).map(row => row.id);
        for (const id of collisionIds) assert.ok(checked.report.scene_graph.physics.some(row => row.id === id && row.kind === 'collider' && row.faces > 0));
        documents.push({ resource, pack, verification: validation.id, actual_graph: checked.report.scene_graph, actual_assets: checked.report.assets });
      }
      const main = documents.find(doc => doc.resource === sceneId), a = main.pack.objects.find(row => addressKey(row.address) === addressKey(address(['hut-a', 'door-slot'], 'door')));
      const instance = current.manifest.resources[sceneId].instances['hut-a'], cabin = current.manifest.prefab_revisions[instance.prefab_revision], inner = cabin.instances['door-slot'], door = current.manifest.prefab_revisions[inner.prefab_revision];
      const oracle = [current.manifest.resources[sceneId].nodes[entryRoot].transform, current.manifest.resources[sceneId].nodes.carrier.transform, instance.transform, cabin.nodes[cabin.root_id].transform, inner.transform, door.nodes[door.root_id].transform, door.nodes.door.transform].map(matrix).reduce(multiply);
      near(a.world_matrix, oracle, 'independent source ancestor multiplication'); near(main.actual_graph.objects.find(row => row.id === a.id).world_matrix, oracle, 'actual Godot versus independent oracle');
      const before = clone(peerA.current()), applied = await publish();
      const live = await snapshot(peerA, state => state.scene_revision === applied.revision && state.object_states[a.id]?.['independent-hierarchy-counter']?.ticks > 0);
      assert.equal(live.world_id, worldId); assert.equal(live.epoch, epoch); assert.equal(authorityPids(1)[0].pid, initialAuthorityPid);
      const wire = await workerPackets(), actualApply = wire.findLast(row => row.direction === 'godot_to_node' && row.packet.type === 'applied' && row.packet.scene_revision === applied.revision);
      assert.ok(actualApply?.packet.ok); assertGraph(actualApply.packet.scene_graph, main.pack);
      for (const object of main.pack.objects.filter(row => row.node.components.behaviors?.some(value => value.script_hash === nestedAsset.id))) {
        const state = live.object_states[object.id]['independent-hierarchy-counter']; assert.deepEqual(state.address, object.address); assert.equal(state.source_revision, applied.revision); assert.equal(state.object_version, object.object_version); near(state.source_world_matrix, object.world_matrix, 'real behavior context full matrix');
      }
      const later = await snapshot(peerA, state => state.tick >= live.tick + 15);
      for (const object of main.pack.objects.filter(row => row.node.components.behaviors?.some(value => value.script_hash === nestedAsset.id))) assert.equal(later.object_states[object.id]['independent-hierarchy-counter'].ticks - live.object_states[object.id]['independent-hierarchy-counter'].ticks, later.tick - live.tick);
      assert.equal(later.object_states['baseline-counter']['independent-hierarchy-counter'].interactions, before.object_states['baseline-counter']['independent-hierarchy-counter'].interactions);
      await subscribe(peerB, otherSceneId); const otherJoin = await join(peerB, applied.revision); assert.notEqual(otherJoin.world_id, worldId); authorityPids(2);
      const otherPack = documents.find(doc => doc.resource === otherSceneId).pack, c = otherPack.objects.find(row => row.address.definition_node_id === 'door');
      const otherState = await snapshot(peerB, state => state.object_states[c.id]?.['independent-hierarchy-counter']?.ticks > 2);
      assert.deepEqual(otherState.object_states[c.id]['independent-hierarchy-counter'].address, c.address); assert.equal(Boolean(otherState.players[A.user.id]?.online), false);
      const stillMain = await snapshot(peerA, state => state.tick > later.tick + 10); assert.equal(stillMain.world_id, worldId); assert.equal(stillMain.players[B.user.id].online, false);
      await subscribe(peerB, sceneId); await join(peerB, applied.revision); const together = await snapshot(peerA, state => state.players[A.user.id]?.online && state.players[B.user.id]?.online);
      o.documents = documents; o.real_applied_packet = actualApply; o.shared_snapshot = together; o.other_scene_snapshot = otherState; o.independent_expected_matrix = oracle;
    });
    await step('AH10', 'unsupported collision transforms save source but reject runtime application atomically', async o => {
      o.candidates = [];
      for (const kind of ['sheared-box', 'anisotropic-sphere']) {
        const current = await branch(), original = current.manifest.resources[sceneId].nodes['box-probe'];
        const patch = kind === 'sheared-box' ? { transform: trs(original.transform.position, [0, 35, 0], original.transform.scale) } : { components: { ...clone(original.components), trigger: { shape: 'sphere', radius: 1 } } };
        const live = clone(peerA.current()), saved = ok(await transaction([{ type: 'patch_node', resource_id: sceneId, node_id: 'box-probe', expected_version: original.version, patch }]));
        const packed = await request('GET', `${branchPath()}/runtime-scene?revision=${saved.revision}&resource_id=${sceneId}`); assert.equal(packed.status, 422); assert.match(packed.value.error, kind === 'sheared-box' ? /runtime_sheared_box_unsupported/ : /runtime_sphere_transform_unsupported/);
        const rejected = await request('POST', `${branchPath()}/publish`, A, { revision: saved.revision, resource_id: sceneId }); assert.equal(rejected.status, 422); assert.equal((await branch()).head, saved.revision);
        const after = await snapshot(peerA, state => state.tick > live.tick + 12); assert.equal(after.scene_revision, live.scene_revision); assert.ok(authorityPids(2).some(process => process.pid === initialAuthorityPid)); assert.deepEqual(after.runtime_fault, {});
        o.candidates.push({ kind, source_was_saved: true, source_revision: saved.revision, rejected, retained_live: after });
        ok(await transaction(saved.inverse));
      }
      o.boundary = 'Pack rejects unsupported physics before spawning a candidate. Source remains the saved draft until explicit undo; prior live continues. This is separate from AH08 source rejection.';
    });
    await step('AH11', 'actual bad nested GDScript is rejected and old authority keeps running', async o => {
      const broken = await upload('extends RefCounted\nfunc initialize( -> Dictionary:\n\treturn {"ok":true}\n', 'independent-bad-nested.gd');
      const current = await branch(), live = clone(peerA.current()), original = current.manifest.resources[sceneId].instances['hut-a'];
      const candidate = ok(await transaction([{ type: 'set_override', resource_id: sceneId, instance_id: 'hut-a', expected_version: original.version,
        override: { target: { instance_path: ['door-slot'], definition_node_id: 'door' }, path: ['components', 'behaviors'], value: [behavior(broken)] } }]));
      try {
        const result = await request('POST', `${branchPath()}/publish`, A, { revision: candidate.revision, resource_id: sceneId }); assert.equal(result.status, 422);
        const v = result.value.details?.verification; assert.equal(v?.status, 'failed'); const checked = await verification(v); assert.equal(checked.report.ok, false); assert.notEqual(v.process.code, 0);
        const after = await snapshot(peerA, state => state.tick > live.tick + 10); assert.equal(after.scene_revision, live.scene_revision); assert.equal(after.module_assets.includes(broken.id), false); assert.ok(after.module_assets.includes(nestedAsset.id)); assert.deepEqual(after.runtime_fault, {});
        assert.ok(authorityPids(2).some(process => process.pid === initialAuthorityPid)); o.rejection = result; o.after = after;
      } finally { ok(await transaction(candidate.inverse)); }
      o.restored_valid_publication = await publish(); await snapshot(peerA, state => state.scene_revision === o.restored_valid_publication.revision);
    });
    await step('AH12', 'branch and complete nested attachment identities remain isolated through actual APIs', async o => {
      const current = await branch(); ok(await request('POST', `/projects/${projectId}/branches`, A, { from_branch: 'main', branch_id: 'independent-branch', expected_head: current.head }), 201);
      const before = await rows(), rowA = findRow(before, address(['hut-a', 'door-slot'], 'door')), rowB = findRow(before, address(['hut-b', 'door-slot'], 'door'));
      const sessions = [], attachments = [];
      for (const [i, row] of [rowA, rowB].entries()) {
        const session = ok(await request('POST', `${branchPath()}/sessions`, A, { title: `Nested source attachment ${i + 1}` }), 201); sessions.push(session.id);
        attachments.push(ok(await request('POST', `/sessions/${session.id}/attachments`, A, { revision: current.head, address: row.address, expected_version: row.object_version }), 201));
      }
      assert.notEqual(addressKey(attachments[0].address), addressKey(attachments[1].address)); assert.equal(attachments[0].definition_node_id, attachments[1].definition_node_id);
      await subscribe(peerB, sceneId, 'independent-branch'); const wrongMark = peerB.messages.length;
      peerB.send({ type: 'drag_preview', generation: peerB.generation, source_revision: current.head, address: rowA.address, expected_version: rowA.object_version, expected_ancestry_hash: rowA.ancestry_hash, world_matrix: rowA.world_matrix });
      assert.equal((await peerB.wait(m => m.type === 'error', wrongMark)).status, 409);
      const branchCurrent = await branch('independent-branch'); const isolated = ok(await transaction([{ type: 'set_override', resource_id: sceneId, instance_id: 'hut-b', expected_version: branchCurrent.manifest.resources[sceneId].instances['hut-b'].version,
        override: { target: { instance_path: ['door-slot'], definition_node_id: 'door' }, path: ['color'], value: '#ffff00' } }], { user: B, branch: 'independent-branch', base: branchCurrent }));
      assert.equal((await branch()).head, current.head); assert.equal(findRow(await rows(), rowB.address).node.color, rowB.node.color);
      const otherRows = await rows(sceneId, isolated.revision, 'independent-branch'); const isolatedRow = otherRows.rows.find(row => row.address.instance_path.join('/') === 'hut-b/door-slot' && row.address.definition_node_id === 'door'); assert.equal(isolatedRow.node.color, '#ffff00'); assert.equal(isolatedRow.address.branch_id, 'independent-branch');
      await subscribe(peerB, sceneId); await join(peerB, current.head); await snapshot(peerA, state => state.players[B.user.id]?.online);
      o.sessions = sessions; o.attachments = attachments; o.branch_only_revision = isolated.revision; o.main_revision = current.head;
    });
    await step('AH13', 'real graceful restart retains applied hierarchy, pinned definitions and nested behavior state', async o => {
      await zero(peerA); await zero(peerB); const observed = clone(peerA.current()), source = await branch(), oldPid = child.pid;
      await stop();
      const db = new DatabaseSync(resolve(data, 'creation/creation.sqlite'), { readOnly: true });
      const saved = JSON.parse(db.prepare("SELECT body FROM documents WHERE kind='creator_world' AND id=?").get(worldId).body); db.close();
      assert.equal(saved.failure, undefined); assert.equal(saved.revision, observed.scene_revision); assert.ok(saved.snapshot.tick >= observed.tick);
      const wire = await workerPackets(), shutdown = wire.findLast(row => row.server_pid === oldPid && row.direction === 'node_to_godot' && row.packet.type === 'shutdown' && row.packet.request_id);
      // Two actual rooms are stopped; select the checkpoint for this world explicitly.
      const acknowledgements = wire.filter(row => row.server_pid === oldPid && row.direction === 'godot_to_node' && row.packet.type === 'checkpoint' && row.packet.snapshot?.world_id === worldId);
      const checkpoint = acknowledgements.at(-1); assert.ok(shutdown); assert.equal(checkpoint?.packet.ok, true);
      assert.ok(wire.some(row => row.server_pid === oldPid && row.direction === 'node_to_godot' && row.packet.type === 'shutdown' && row.packet.request_id === checkpoint.packet.request_id));
      assert.deepEqual(saved.snapshot, checkpoint.packet.snapshot);
      await start(); peerA = await connect(A); peerB = await connect(B); const [a, b] = await Promise.all([join(peerA), join(peerB)]);
      assert.equal(a.world_id, worldId); assert.equal(b.world_id, worldId); assert.equal(a.epoch, epoch + 1);
      const restored = await snapshot(peerA, state => state.players[A.user.id]?.online && state.players[B.user.id]?.online);
      assert.equal(restored.scene_revision, saved.revision); assert.notEqual(authorityPids(1)[0].pid, initialAuthorityPid);
      for (const user of [A, B]) near([restored.players[user.user.id].position[0], restored.players[user.user.id].position[2]], [saved.snapshot.players[user.user.id].position[0], saved.snapshot.players[user.user.id].position[2]], 'restored player XZ', 0.03);
      for (const [id, modules] of Object.entries(saved.snapshot.object_states)) {
        const oldState = modules['independent-hierarchy-counter']; if (!oldState) continue;
        const state = restored.object_states[id]['independent-hierarchy-counter']; assert.equal(state.interactions, oldState.interactions); assert.ok(state.ticks >= oldState.ticks);
        if (oldState.address) { assert.deepEqual(state.address, oldState.address); assert.equal(state.object_version, oldState.object_version); near(state.source_world_matrix, oldState.source_world_matrix, 'restored nested context'); }
      }
      const sourceAfter = await branch(); assert.equal(sourceAfter.head, source.head); assert.deepEqual(sourceAfter.manifest, source.manifest);
      o.saved = saved; o.actual_checkpoint = checkpoint; o.restored = restored; o.source_revision = source.head;
      report.fixture.final_source_revision = source.head; report.fixture.final_world = { world_id: worldId, epoch: restored.epoch, revision: restored.scene_revision, runtime_build_id: runtime.build_id };
    });
  } catch (error) { report.fatal_error = { message: error.message, stack: error.stack }; throw error; }
  finally {
    await stop(); clearInterval(monitor); sampleProcesses();
    for (let i = 0; i < 30; i++) { report.remaining_owned_children = processes().filter(p => seenChildren.has(p.pid)); if (!report.remaining_owned_children.length) break; await delay(100); }
    report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(resolve(codeRoot, file)))])));
    report.source_changed_during_run = files.filter(file => report.source_hashes[file] !== report.source_hashes_after[file]);
    if (runtime) report.runtime_source_changed_during_run = (await Promise.all(runtime.sources.map(async file => ({ path: file.path, matches: sha(await readFile(resolve(codeRoot, 'runtimes/model-preview', file.path))) === file.sha256 })))).filter(file => !file.matches).map(file => file.path);
    report.completed = report.cases.length > 0 && !fatal && report.cases.every(c => c.status === 'passed') && !report.remaining_owned_children.length && !report.source_changed_during_run.length && !(report.runtime_source_changed_during_run?.length);
    await cp(resolve(data, 'creation'), resolve(out, 'stopped-fixture-data'), { recursive: true });
    await save(); await writeFile(resolve(out, 'server.log'), clean(log)); await writeFile(resolve(out, 'executed-driver.mjs'), await readFile(fileURLToPath(import.meta.url)));
    console.log(`HIERARCHY_REPORT ${resolve(out, 'report.json')}`);
  }
});
