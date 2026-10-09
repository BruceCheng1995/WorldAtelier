import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

// Actual HTTP + authenticated WS. No fake authority, runtime ACK, Agent events,
// database fixtures, or browser automation. All runtime/game assertions remain separate.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = 48921, origin = `http://127.0.0.1:${port}`;
const api = `${origin}/creation-api`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unique = prefix => `${prefix}-${randomUUID()}`;
const entry = 'scene-harbor';
const anchor = (id, position = [0, 0, 0]) => ({ id, name: id, kind: 'anchor', position, rotation: [0, 0, 0], scale: [1, 1, 1], components: {} });
const pathBranch = (p, b = 'main') => `/projects/${p}/branches/${b}`;
const obj = (branch, id, resource = entry) => branch.manifest.resources[resource].objects.find(o => o.id === id);

function sanitized(value) {
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, /^(token|password|code|cap|host_key)$/i.test(key) ? '[redacted]' : sanitized(val)]));
  if (typeof value === 'string') return value.replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]');
  return value;
}

async function requireFreePort() {
  const server = createServer();
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  await new Promise(ok => server.close(ok));
}

test('creation backend: isolated real HTTP/WS and durable state', { timeout: 150000 }, async t => {
  await requireFreePort();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(root, '.local/creation-verification/backend', `${stamp}-${randomUUID().slice(0, 8)}`);
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-creation-backend-'));
  await mkdir(out, { recursive: true });
  const report = { schema: 1, started_at: new Date().toISOString(), root, port, data, evidence: out, source_hashes: {}, service_runs: [], agent_disabled: true, scope: 'actual HTTP/WS only; no Agent, authority, Godot input or browser execution', cases: [], traffic: [], observations: {}, completed: false };
  const sources = ['services/creation/schema.mjs', 'services/creation/seed.mjs', 'services/creation/store.mjs', 'services/creation/assets.mjs', 'services/creation/realtime.mjs', 'services/creation/service.mjs', 'services/preview/server.mjs', 'services/control-plane/storage.mjs'];
  for (const p of sources) report.source_hashes[p] = hash(await readFile(resolve(root, p)));
  let child, currentRun, serverLog = '', peers = new Set();
  const save = async () => writeFile(resolve(out, 'report.json'), JSON.stringify(sanitized(report), null, 2) + '\n');
  const logTraffic = event => report.traffic.push(sanitized({ at: Date.now(), ...event }));

  async function start() {
    await requireFreePort();
    child = spawn(process.execPath, ['services/preview/server.mjs'], { cwd: root, env: { ...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: data, WORLD_ATELIER_CREATION_DATA: resolve(data, 'creation'), WORLD_ATELIER_DISABLE_AGENT: '1', WORLD_ATELIER_DISABLE_WORLDS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    currentRun = { pid: child.pid, started_at: Date.now(), command: [process.execPath, 'services/preview/server.mjs'], exit_code: null, signal: null };
    report.service_runs.push(currentRun);
    const own = currentRun;
    child.stdout.on('data', b => { serverLog += `[${own.pid} stdout] ${b}`; });
    child.stderr.on('data', b => { serverLog += `[${own.pid} stderr] ${b}`; });
    child.once('exit', (code, signal) => { own.exit_code = code; own.signal = signal; own.exited_at = Date.now(); });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Service exited: ${serverLog}`);
      try { const r = await fetch(`${api}/health`); if (r.ok) return await r.json(); } catch {}
      await delay(50);
    }
    throw new Error(`Service failed to start: ${serverLog}`);
  }
  async function stop(signal = 'SIGTERM') {
    for (const peer of peers) peer.ws.terminate();
    peers.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const processToStop = child;
    const exited = new Promise(ok => processToStop.once('exit', ok));
    processToStop.kill(signal);
    await Promise.race([exited, delay(4000).then(() => { if (processToStop.exitCode === null && processToStop.signalCode === null) processToStop.kill('SIGKILL'); })]);
    await exited;
    await requireFreePort();
  }
  async function request(method, path, user = null, payload, options = {}) {
    const headers = {};
    if (user) headers.authorization = `Bearer ${user.token}`;
    if (method !== 'GET' && method !== 'HEAD' && options.origin !== false) headers.origin = options.origin ?? origin;
    const body = options.raw ?? (payload === undefined ? undefined : JSON.stringify(payload));
    if (payload !== undefined) headers['content-type'] = 'application/json';
    Object.assign(headers, options.headers ?? {});
    const response = await fetch(options.absolute ? path : api + path, { method, headers, body });
    const bytes = Buffer.from(await response.arrayBuffer());
    let value;
    try { value = JSON.parse(bytes.toString()); } catch { value = { bytes: bytes.length, sha256: hash(bytes) }; }
    logTraffic({ transport: 'http', method, path, actor: user?.user?.id, request: options.raw ? { bytes: options.raw.length, sha256: hash(options.raw) } : payload, status: response.status, response: value });
    return { status: response.status, value, bytes, headers: response.headers };
  }
  function expect(response, status = 200) { assert.equal(response.status, status, JSON.stringify(response.value)); return response.value; }
  async function readBranch(user, p, b = 'main') { return expect(await request('GET', pathBranch(p, b), user)); }
  async function transact(user, p, b, ops, options = {}) {
    const before = options.base ? null : await readBranch(user, p, b);
    return request('POST', pathBranch(p, b) + '/transactions', user, { transaction_id: options.id ?? unique('tx'), base_revision: options.base ?? before.head, ops, ...(options.extra ?? {}) });
  }
  async function invite(owner, p, user, role = 'editor') {
    const invitation = expect(await request('POST', `/projects/${p}/invites`, owner, { role }), 201);
    return expect(await request('POST', '/invites/join', user, { code: invitation.code }));
  }
  async function project(owner, label, template = 'empty', members = []) {
    const result = expect(await request('POST', '/projects', owner, { name: unique(label), template }), 201);
    for (const [user, role] of members) await invite(owner, result.project.id, user, role);
    return result.project.id;
  }
  async function putAnchors(user, p, names, resource = entry) {
    return expect(await transact(user, p, 'main', names.map(id => ({ type: 'put_object', resource_id: resource, object_id: id, expected_version: null, object: anchor(id) }))));
  }
  async function connect(user, p, b = 'main', resource = entry, generation = 1) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/creation`, { origin });
    const peer = { ws, messages: [], errors: [], closed: false, user, generation, resource, p, b };
    peers.add(peer);
    ws.on('message', bytes => { const message = JSON.parse(bytes.toString()); peer.messages.push(message); logTraffic({ transport: 'ws-receive', actor: user.user.id, peer_id: peer.peer_id, packet: message }); });
    ws.on('error', e => peer.errors.push(e.message));
    ws.on('close', (code, reason) => { peer.closed = true; peer.close_code = code; logTraffic({ transport: 'ws-close', actor: user.user.id, peer_id: peer.peer_id, code, reason: reason.toString() }); });
    peer.send = message => { logTraffic({ transport: 'ws-send', actor: user.user.id, peer_id: peer.peer_id, packet: message }); ws.send(JSON.stringify(message)); };
    peer.wait = async (type, predicate = () => true, from = 0, timeout = 2500) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = peer.messages.slice(from).find(m => m.type === type && predicate(m));
        if (found) return found;
        await delay(10);
      }
      throw new Error(`WS timeout ${type}: ${JSON.stringify(peer.messages.slice(from))}`);
    };
    await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
    peer.send({ type: 'auth', token: user.token });
    const auth = await peer.wait('authenticated'); peer.peer_id = auth.peer_id;
    assert.equal(auth.user.id, user.user.id);
    peer.send({ type: 'subscribe', project_id: p, branch_id: b, resource_id: resource, generation });
    const baseline = await peer.wait('baseline');
    assert.equal(baseline.project_id, p); assert.equal(baseline.branch_id, b); assert.equal(baseline.resource_id, resource); assert.equal(baseline.generation, generation);
    return peer;
  }
  async function check(id, title, fn) {
    const row = { id, title, status: 'running', started_at: Date.now(), observations: {} };
    report.cases.push(row);
    await t.test(`${id} ${title}`, async () => {
      try { await fn(row.observations); row.status = 'passed'; }
      catch (error) { row.status = 'failed'; row.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
      finally { row.finished_at = Date.now(); await save(); console.log(`CREATION_CASE ${id} ${row.status}`); }
    });
  }

  try {
    report.health = await start();
    const users = {};
    for (const label of ['owner', 'editor', 'viewer', 'outsider', 'logout']) users[label] = expect(await request('POST', '/auth/register', null, { name: unique(label), password: unique('test-password') }), 201);
    const { owner: A, editor: B, viewer: V, outsider: X, logout: L } = users;
    report.users = Object.fromEntries(Object.entries(users).map(([key, value]) => [key, value.user]));

    await check('CB01', 'authentication, origin and explicit empty/template projects', async o => {
      assert.equal((await request('GET', '/bootstrap')).status, 401);
      assert.equal((await request('POST', '/projects', A, { name: 'origin-rejected', template: 'empty' }, { origin: false })).status, 403);
      assert.equal((await request('POST', '/projects', A, { name: 'origin-rejected', template: 'empty' }, { origin: 'https://example.invalid' })).status, 403);
      const p = await project(A, 'empty');
      const empty = await readBranch(A, p); assert.equal(empty.manifest.schema, 'creation-flat-1');
      assert.equal(Object.keys(empty.manifest.resources).length, 1); assert.equal(empty.manifest.resources[entry].objects.length, 0);
      const q = await project(A, 'template', 'harbor'); const harbor = await readBranch(A, q);
      assert.equal(Object.values(harbor.manifest.resources).filter(r => r.kind === 'prefab').length, 6);
      assert.equal(harbor.manifest.resources[entry].objects.length, 5);
      assert.equal((await request('GET', pathBranch(p), X)).status, 403);
      o.project = p; o.template = q; o.resources = Object.keys(harbor.manifest.resources);
    });

    const p = await project(A, 'collaboration', 'empty', [[B, 'editor'], [V, 'viewer']]);
    await putAnchors(A, p, ['a', 'b']);
    const peerA = await connect(A, p), peerB = await connect(B, p);

    await check('CB02', 'two real WS clients preserve disjoint full TRS updates', async o => {
      const base = await readBranch(A, p), ma = peerA.messages.length, mb = peerB.messages.length;
      const txA = unique('tx'), txB = unique('tx');
      const [ra, rb] = await Promise.all([
        transact(A, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: obj(base, 'a').version, patch: { position: [12.5, 3, -8.25], rotation: [23, -50.8305, 17], scale: [1.25, 1.8, 0.75] } }], { base: base.head, id: txA, extra: { actor_id: B.user.id, actor: { id: B.user.id, name: 'forged' } } }),
        transact(B, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'b', expected_version: obj(base, 'b').version, patch: { position: [-2, 5, 7] } }], { base: base.head, id: txB })
      ]);
      const a = expect(ra), b = expect(rb); assert.equal(a.actor.id, A.user.id); assert.equal(b.actor.id, B.user.id);
      for (const [peer, mark] of [[peerA, ma], [peerB, mb]]) {
        await peer.wait('committed', m => m.transaction_id === txA, mark); await peer.wait('committed', m => m.transaction_id === txB, mark);
        const receipts = peer.messages.slice(mark).filter(m => m.type === 'committed');
        assert.deepEqual(receipts.map(m => m.document_sequence), [base.doc_sequences[entry] + 1, base.doc_sequences[entry] + 2]);
      }
      const after = await readBranch(A, p); assert.deepEqual(obj(after, 'a').scale, [1.25, 1.8, 0.75]); assert.deepEqual(obj(after, 'a').rotation, [23, -50.8305, 17]); assert.deepEqual(obj(after, 'b').position, [-2, 5, 7]);
      o.revisions = [base.head, a.revision, b.revision, after.head]; o.final = after;
    });

    await check('CB03', 'same-object concurrent TRS conflict is explicit', async o => {
      const base = await readBranch(A, p), previous = obj(base, 'a');
      const replies = await Promise.all([
        transact(A, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: previous.version, patch: { position: [1, 2, 3] } }], { base: base.head }),
        transact(B, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: previous.version, patch: { scale: [2, 3, 4] } }], { base: base.head })
      ]);
      assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
      const after = await readBranch(A, p); assert.equal(after.doc_sequences[entry], base.doc_sequences[entry] + 1);
      if (replies[0].status === 200) { assert.deepEqual(obj(after, 'a').position, [1, 2, 3]); assert.deepEqual(obj(after, 'a').scale, previous.scale); }
      else { assert.deepEqual(obj(after, 'a').position, previous.position); assert.deepEqual(obj(after, 'a').scale, [2, 3, 4]); }
      o.responses = replies.map(r => ({ status: r.status, value: r.value }));
    });

    await check('CB04', 'object-version ABA and delete/recreate reject old writes', async o => {
      const base = await readBranch(A, p), first = obj(base, 'b');
      let r = expect(await transact(A, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'b', expected_version: first.version, patch: { name: 'changed' } }]));
      r = expect(await transact(A, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'b', expected_version: obj(r.branch, 'b').version, patch: { name: first.name } }]));
      assert.notEqual(obj(r.branch, 'b').version, first.version);
      assert.equal((await transact(B, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'b', expected_version: first.version, patch: { position: [99, 0, 0] } }], { base: base.head })).status, 409);
      const beforeDelete = obj(r.branch, 'b');
      expect(await transact(A, p, 'main', [{ type: 'delete_object', resource_id: entry, object_id: 'b', expected_version: beforeDelete.version }]));
      const recreated = expect(await transact(A, p, 'main', [{ type: 'put_object', resource_id: entry, object_id: 'b', expected_version: null, object: beforeDelete }]));
      assert.notEqual(obj(recreated.branch, 'b').version, beforeDelete.version);
      assert.equal((await transact(B, p, 'main', [{ type: 'delete_object', resource_id: entry, object_id: 'b', expected_version: beforeDelete.version }])).status, 409);
      o.versions = [first.version, beforeDelete.version, obj(recreated.branch, 'b').version];
    });

    await check('CB05', 'idempotent concurrent retry only commits and broadcasts once', async o => {
      const base = await readBranch(A, p), transaction_id = unique('retry'), mark = peerB.messages.length;
      const payload = { transaction_id, base_revision: base.head, ops: [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: obj(base, 'a').version, patch: { name: 'idempotent-name' } }] };
      const responses = await Promise.all([request('POST', pathBranch(p) + '/transactions', A, payload), request('POST', pathBranch(p) + '/transactions', A, payload)]);
      responses.forEach(r => expect(r)); assert.equal(responses[0].value.revision, responses[1].value.revision);
      assert.equal(responses.filter(r => r.value.replayed).length, 1);
      await peerB.wait('committed', m => m.transaction_id === transaction_id, mark); await delay(80);
      assert.equal(peerB.messages.slice(mark).filter(m => m.type === 'committed' && m.transaction_id === transaction_id).length, 1);
      assert.equal((await request('POST', pathBranch(p) + '/transactions', A, { ...payload, ops: [{ ...payload.ops[0], patch: { name: 'different-payload' } }] })).status, 409);
      o.payload = payload; o.receipt = responses[0].value;
      report.observations.restart_receipt = { p, payload, revision: responses[0].value.revision };
    });

    await check('CB06', 'invalid later operation and invalid dependency have no partial commit', async o => {
      const before = await readBranch(A, p);
      const response = await transact(A, p, 'main', [
        { type: 'put_object', resource_id: entry, object_id: 'must-not-exist', expected_version: null, object: anchor('must-not-exist') },
        { type: 'patch_object', resource_id: entry, object_id: 'missing-object', expected_version: null, patch: { name: 'bad' } }
      ]);
      assert.equal(response.status, 404); assert.deepEqual(await readBranch(A, p), before);
      const dependency = await transact(A, p, 'main', [{ type: 'put_object', resource_id: entry, object_id: 'bad-prefab', expected_version: null, object: { ...anchor('bad-prefab'), prefab: 'missing-prefab' } }]);
      assert.equal(dependency.status, 422); assert.deepEqual(await readBranch(A, p), before);
      const hierarchy = await transact(A, p, 'main', [{ type: 'put_object', resource_id: entry, object_id: 'unsupported-child', expected_version: null, object: { ...anchor('unsupported-child'), parent_id: 'a' } }]);
      assert.equal(hierarchy.status, 422); assert.deepEqual(await readBranch(A, p), before);
      o.rejected = [response.value, dependency.value, hierarchy.value];
    });

    await check('CB07', 'server-generated inverse restores full TRS and fences later peer changes', async o => {
      const base = await readBranch(A, p), before = obj(base, 'a');
      const changed = expect(await transact(A, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: before.version, patch: { position: [3, 7, 11], rotation: [21, 35, 15], scale: [1.1, 2.2, 3.3] } }]));
      const undo = expect(await transact(A, p, 'main', changed.inverse));
      for (const key of ['position', 'rotation', 'scale']) assert.deepEqual(obj(undo.branch, 'a')[key], before[key]);
      const second = expect(await transact(A, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: obj(undo.branch, 'a').version, patch: { name: 'A-before-B' } }]));
      expect(await transact(B, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: obj(second.branch, 'a').version, patch: { name: 'B-later' } }]));
      assert.equal((await transact(A, p, 'main', second.inverse)).status, 409);
      assert.equal(obj(await readBranch(A, p), 'a').name, 'B-later');
      o.inverse = changed.inverse;
    });

    await check('CB08', 'independent resource creation and fork/doc state isolation', async o => {
      const base = await readBranch(A, p);
      const result = expect(await transact(A, p, 'main', [
        { type: 'create_resource', resource_id: 'scene-second', resource: { kind: 'scene', name: 'Second scene', objects: [anchor('a')] } },
        { type: 'create_resource', resource_id: 'prefab-unplaced', resource: { kind: 'prefab', name: 'Unplaced prefab', objects: [anchor('definition-root')] } }
      ]));
      assert.equal(result.branch.doc_sequences[entry], base.doc_sequences[entry]);
      assert.equal(result.branch.manifest.resources['prefab-unplaced'].kind, 'prefab');
      const fork = expect(await request('POST', `/projects/${p}/branches`, A, { from_branch: 'main', branch_id: 'other', expected_head: result.revision, name: 'Other branch' }), 201);
      assert.equal(fork.head, result.revision);
      expect(await transact(B, p, 'other', [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: obj(fork, 'a').version, patch: { name: 'Only other' } }]));
      assert.equal(obj(await readBranch(A, p), 'a').name, 'B-later');
      assert.equal(obj(await readBranch(A, p, 'other'), 'a').name, 'Only other');
      assert.equal((await readBranch(A, p)).manifest.resources['scene-second'].objects[0].name, 'a');
      o.fork = fork;
    });

    await check('CB09', 'subscribe/commit overlap converges and rejects stale generation', async o => {
      const peer = await connect(A, p), base = await readBranch(A, p), mark = peer.messages.length;
      peer.send({ type: 'subscribe', project_id: p, branch_id: 'other', resource_id: entry, generation: 2 });
      const targetBase = await readBranch(B, p, 'other');
      const changed = expect(await transact(B, p, 'other', [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: obj(targetBase, 'a').version, patch: { name: 'overlap-committed' } }]));
      const baseline = await peer.wait('baseline', m => m.generation === 2, mark);
      if (baseline.branch.head !== changed.revision) await peer.wait('committed', m => m.revision === changed.revision && m.generation === 2, mark);
      const later = peer.messages.length;
      peer.send({ type: 'presence', generation: 1, camera: { position: [900, 0, 0], target: [0, 0, 0] } });
      const error = await peer.wait('error', () => true, later); assert.equal(error.status, 409);
      assert.equal((await readBranch(A, p)).head, base.head);
      o.baseline = baseline; o.changed = changed.revision;
      peer.ws.close();
    });

    await check('CB10', 'real camera identity, drag leases and cancellation remain ephemeral', async o => {
      const before = await readBranch(A, p), mark = peerB.messages.length;
      peerA.send({ type: 'presence', generation: 1, user: { id: X.user.id, name: 'forged' }, camera: { position: [5, 7, 9], target: [1, 2, 3] }, selected_id: 'a', mode: 'editing' });
      const presence = await peerB.wait('presence', m => m.peers.some(peer => peer.peer_id === peerA.peer_id && peer.camera?.position?.[0] === 5), mark);
      const actor = presence.peers.find(peer => peer.peer_id === peerA.peer_id); assert.equal(actor.id, A.user.id); assert.equal(actor.name, A.user.name); assert.notEqual(actor.name, 'forged');
      const target = obj(before, 'a'), m1 = peerB.messages.length;
      const drag = { type: 'drag_preview', generation: 1, object_id: 'a', expected_version: target.version, position: [15, 2, 3], rotation: [10, 20, 30], scale: [2, 3, 4] };
      peerA.send(drag); await peerB.wait('drag_preview', m => m.preview.peer_id === peerA.peer_id, m1);
      const m2 = peerB.messages.length; peerB.send(drag); assert.equal((await peerB.wait('error', () => true, m2)).status, 409);
      assert.deepEqual(await readBranch(A, p), before);
      const m3 = peerB.messages.length; peerA.send({ type: 'drag_end', generation: 1 });
      await peerB.wait('drag_end', m => m.peer_id === peerA.peer_id, m3);
      const m4 = peerB.messages.length; peerA.send(drag); await peerB.wait('drag_preview', () => true, m4);
      const expired = await peerB.wait('drag_end', m => m.peer_id === peerA.peer_id, m4, 6500);
      assert.deepEqual(await readBranch(A, p), before); o.actor = actor; o.expiry = expired;
    });

    await check('CB11', 'unsubscribe does not permit reusing an older subscription generation', async o => {
      const peer = await connect(A, p, 'main', entry, 5);
      const mark = peer.messages.length;
      peer.send({ type: 'unsubscribe' });
      peer.send({ type: 'subscribe', project_id: p, branch_id: 'other', resource_id: entry, generation: 1 });
      await delay(100);
      o.received = peer.messages.slice(mark);
      const baseline = o.received.find(m => m.type === 'baseline' && m.generation === 1);
      if (baseline) {
        const before = peer.messages.length;
        peer.send({ type: 'presence', generation: 1, camera: { position: [777, 1, 1], target: [0, 0, 0] } });
        o.accepted_late_presence = await peer.wait('presence', m => m.peers.some(x => x.peer_id === peer.peer_id && x.camera?.position?.[0] === 777), before);
      }
      peer.ws.close();
      assert.equal(Boolean(baseline), false, 'generation 1 accepted after an earlier generation 5 and unsubscribe');
      assert.ok(o.received.some(m => m.type === 'error' && m.status === 409));
    });

    await check('CB12', 'permissions fence viewer writes, cached receipts and revoked peers', async o => {
      const q = await project(A, 'permissions', 'empty', [[B, 'editor'], [V, 'viewer']]);
      await putAnchors(A, q, ['target']);
      const bpeer = await connect(B, q), vpeer = await connect(V, q), base = await readBranch(B, q);
      const payload = { transaction_id: unique('permission-replay'), base_revision: base.head, ops: [{ type: 'patch_object', resource_id: entry, object_id: 'target', expected_version: obj(base, 'target').version, patch: { name: 'B accepted' } }] };
      expect(await request('POST', pathBranch(q) + '/transactions', B, payload));
      assert.equal((await request('POST', pathBranch(q) + '/transactions', V, payload)).status, 403);
      const vm = vpeer.messages.length; vpeer.send({ type: 'drag_preview', generation: 1, object_id: 'target', expected_version: obj(await readBranch(A, q), 'target').version, position: [1, 2, 3] });
      assert.equal((await vpeer.wait('error', () => true, vm)).status, 403);
      expect(await request('PATCH', `/projects/${q}/members/${B.user.id}`, A, { role: 'viewer' }));
      assert.equal((await request('POST', pathBranch(q) + '/transactions', B, payload)).status, 403);
      expect(await request('PATCH', `/projects/${q}/members/${B.user.id}`, A, { role: null }));
      for (let i = 0; i < 100 && !bpeer.closed; i++) await delay(10);
      assert.equal(bpeer.closed, true); assert.equal((await request('GET', pathBranch(q), B)).status, 403);
      assert.equal((await request('POST', pathBranch(q) + '/transactions', B, payload)).status, 403);
      o.revoked_peer = { id: bpeer.peer_id, close_code: bpeer.close_code }; o.project = q;
    });

    await check('CB13', 'invalid member ID is rejected without poisoning persisted project', async o => {
      const q = await project(X, 'invalid-member');
      const result = await request('PATCH', `/projects/${q}/members/user-does-not-exist`, X, { role: 'editor' });
      const bootstrap = await request('GET', '/bootstrap', X);
      o.mutation = { status: result.status, value: result.value }; o.bootstrap_after = { status: bootstrap.status, value: bootstrap.value }; o.project = q;
      assert.ok([400, 404].includes(result.status), `unknown user returned ${result.status}`);
      assert.equal(bootstrap.status, 200); assert.ok(!bootstrap.value.projects.find(x => x.id === q).members.some(m => m.id === 'user-does-not-exist'));
    });

    let assetPersistence;
    await check('CB14', 'project assets have immutable bytes and scoped revocable access', async o => {
      const q = await project(A, 'assets', 'harbor', [[B, 'editor'], [V, 'viewer']]);
      const foreign = await project(A, 'other-assets');
      const catalog = JSON.parse(await readFile(resolve(root, 'content/model-preview/manifest.json')));
      const original = await readFile(resolve(root, 'content/model-preview', catalog.assets[0].file));
      const jsonLength = original.readUInt32LE(12), doc = JSON.parse(original.subarray(20, 20 + jsonLength).toString().trim());
      doc.extras = { ...(doc.extras ?? {}), independent_test: unique('asset-fixture') };
      const jsonBytes = Buffer.from(JSON.stringify(doc)); const padded = Buffer.alloc(Math.ceil(jsonBytes.length / 4) * 4, 32); jsonBytes.copy(padded);
      const rest = original.subarray(20 + jsonLength), bytes = Buffer.alloc(20 + padded.length + rest.length);
      original.copy(bytes, 0, 0, 20); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(padded.length, 12); padded.copy(bytes, 20); rest.copy(bytes, 20 + padded.length);
      const uploadPath = `/projects/${q}/assets`, headers = { 'x-asset-name': 'independent-fixture.glb' };
      assert.equal((await request('POST', uploadPath, V, undefined, { raw: bytes, headers })).status, 403);
      const asset = expect(await request('POST', uploadPath, A, undefined, { raw: bytes, headers }), 201); assert.equal(asset.id, hash(bytes));
      const scriptBytes = Buffer.from('extends RefCounted\nfunc evaluate(context: Dictionary) -> Dictionary:\n\treturn {}\n');
      const script = expect(await request('POST', uploadPath, A, undefined, { raw: scriptBytes, headers: { 'x-asset-name': 'probe.gd' } }), 201); assert.equal(script.id, hash(scriptBytes));
      assert.equal((await request('POST', uploadPath, A, undefined, { raw: Buffer.from([0xff]), headers: { 'x-asset-name': 'bad.gd' } })).status, 400);
      const scene = await readBranch(A, q), target = scene.manifest.resources[entry].objects[0];
      const model = { type: 'patch_object', resource_id: entry, object_id: target.id, expected_version: target.version, patch: { model_hash: asset.id, model_url: asset.url, components: { behaviors: [{ id: 'probe', api: 1, script_hash: script.id, script_url: script.url }] } } };
      expect(await transact(A, q, 'main', [model]));
      assert.equal((await request('GET', origin + asset.url, null, undefined, { absolute: true })).status, 403);
      assert.equal((await transact(A, foreign, 'main', [{ type: 'put_object', resource_id: entry, object_id: 'foreign-model', expected_version: null, object: { ...target, id: 'foreign-model', prefab: undefined, model_hash: asset.id, model_url: asset.url } }])).status, 403);
      const rendered = expect(await request('GET', pathBranch(q) + '/runtime-scene', B));
      const url = rendered.objects.find(x => x.id === target.id).model_url;
      const downloaded = await request('GET', origin + url, null, undefined, { absolute: true }); assert.equal(downloaded.status, 200); assert.equal(hash(downloaded.bytes), asset.id); assert.equal(downloaded.headers.get('cache-control'), 'private,no-store');
      const foreignScene = expect(await request('GET', pathBranch(foreign) + '/runtime-scene', A));
      assert.equal(foreignScene.objects.length, 0);
      expect(await request('PATCH', `/projects/${q}/members/${B.user.id}`, A, { role: null }));
      assert.equal((await request('GET', origin + url, null, undefined, { absolute: true })).status, 403);
      const ownScene = expect(await request('GET', pathBranch(q) + '/runtime-scene', A));
      assetPersistence = { url: ownScene.objects.find(x => x.id === target.id).model_url, hash: asset.id, p: q };
      o.asset = asset; o.script = script; o.fixture = { source: catalog.assets[0].file, mutation: 'GLB JSON extras only; original binary chunk preserved', hash: hash(bytes) };
      o.scope_limit = 'Storage/auth/container verification only; uploaded script not compiled and GLB not parsed by Godot in this run.';
    });

    await check('CB20', 'invalid GLB is a recoverable input rejection without document mutation', async o => {
      const before = await readBranch(A, p);
      const result = await request('POST', `/projects/${p}/assets`, A, undefined, { raw: Buffer.from('broken'), headers: { 'x-asset-name': 'invalid.glb' } });
      const after = await readBranch(A, p);
      o.response = { status: result.status, value: result.value }; o.unchanged = after.head === before.head;
      assert.deepEqual(after, before);
      assert.equal(result.status, 400, JSON.stringify(result.value));
    });

    let savedSession;
    await check('CB15', 'persistent creator sessions, sharing and frozen anchor attachments', async o => {
      const s1 = expect(await request('POST', pathBranch(p) + '/sessions', A, { title: 'Persistent private one', visibility: 'private' }), 201);
      const s2 = expect(await request('POST', pathBranch(p) + '/sessions', A, { title: 'Persistent private two', visibility: 'private' }), 201);
      const sb = expect(await request('POST', pathBranch(p) + '/sessions', B, { title: 'B private', visibility: 'private' }), 201);
      const so = expect(await request('POST', pathBranch(p, 'other') + '/sessions', A, { title: 'Other branch private', visibility: 'private' }), 201);
      assert.notEqual(s1.id, s2.id); assert.equal(s1.executor_thread_id, null);
      const aList = expect(await request('GET', pathBranch(p) + '/sessions', A)).sessions;
      assert.deepEqual(aList.map(x => x.id).sort(), [s1.id, s2.id].sort()); assert.ok(!aList.some(x => x.id === sb.id || x.id === so.id));
      assert.equal((await request('GET', `/sessions/${s1.id}`, B)).status, 403);
      expect(await request('PATCH', `/sessions/${s1.id}`, A, { draft: 'Immutable anchor follow-up', visibility: 'shared' }));
      expect(await request('GET', `/sessions/${s1.id}`, B));
      assert.equal((await request('PATCH', `/sessions/${s1.id}`, B, { draft: 'must not overwrite' })).status, 403);
      const before = await readBranch(A, p), target = obj(before, 'a');
      const attachment = expect(await request('POST', `/sessions/${s1.id}/attachments`, A, { revision: before.head, resource_id: entry, object_id: 'a', expected_version: target.version }), 201);
      assert.equal(attachment.kind, 'spatial_anchor'); assert.deepEqual(attachment.position, target.position); assert.equal(attachment.revision, before.head); assert.equal(attachment.units, 'metres');
      expect(await transact(B, p, 'main', [{ type: 'patch_object', resource_id: entry, object_id: 'a', expected_version: target.version, patch: { name: 'moved after attachment', position: [8, 9, 10] } }]));
      const retained = expect(await request('GET', `/sessions/${s1.id}`, A)); assert.deepEqual(retained.draft_attachments[0], attachment);
      assert.equal((await request('POST', `/sessions/${s1.id}/attachments`, A, { revision: before.head, resource_id: entry, object_id: 'a', expected_version: target.version, observation: { world_id: 'forged' } })).status, 422);
      expect(await request('PATCH', `/sessions/${s1.id}`, A, { visibility: 'private' }));
      assert.equal((await request('GET', `/sessions/${s1.id}`, B)).status, 403);
      assert.equal((await request('GET', `/sessions/${s1.id}/events`, B)).status, 403);
      savedSession = { id: s1.id, attachment, draft: retained.draft };
      o.sessions = [s1.id, s2.id, sb.id, so.id]; o.attachment = attachment; o.scope_limit = 'Saved draft+attachment, not a sent immutable Message or actual Agent context.';
    });

    await check('CB16', 'logout invalidates existing token and WS subsequent messages', async o => {
      const q = await project(L, 'logout'); const peer = await connect(L, q);
      expect(await request('POST', '/auth/logout', L, {}));
      assert.equal((await request('GET', '/bootstrap', L)).status, 401);
      const mark = peer.messages.length; peer.send({ type: 'ping' }); assert.equal((await peer.wait('error', () => true, mark)).status, 401);
      for (let i = 0; i < 50 && !peer.closed; i++) await delay(10);
      assert.equal(peer.closed, true); o.peer_closed = peer.closed;
    });

    await check('CB17', 'explicitly disabled Agent and world endpoints remain unavailable', async o => {
      const health = expect(await request('GET', '/health', A)); assert.equal(health.agent_ready, false); assert.equal(health.worlds_ready, false);
      const status = expect(await request('GET', '/agent/status', A)); assert.equal(status.ready, false);
      const session = savedSession ?? expect(await request('POST', pathBranch(p) + '/sessions', A, {}), 201);
      const replies = [
        await request('POST', `/sessions/${session.id}/turns`, A, { text: 'Do not execute; readiness boundary test' }),
        await request('POST', pathBranch(p) + '/validate', A, {}),
        await request('POST', pathBranch(p) + '/publish', A, {})
      ];
      for (const reply of replies) assert.equal(reply.status, 503);
      const after = expect(await request('GET', `/sessions/${session.id}`, A)); assert.equal(after.messages.length, 0); assert.equal(after.runs.length, 0);
      o.responses = replies.map(r => r.value); o.health = health; o.boundary = 'Agent and worlds are explicitly disabled by this test; this is not a claim about production readiness or an Agent/world acceptance pass.';
    });

    await check('CB18', 'acknowledged document, receipt, session and asset survive graceful restart', async o => {
      const before = await readBranch(A, p), pid = child.pid;
      await stop(); await start(); assert.notEqual(child.pid, pid);
      assert.deepEqual(await readBranch(A, p), before);
      const receipt = report.observations.restart_receipt;
      assert.ok(receipt, 'required prior receipt fixture was not produced');
      const replay = expect(await request('POST', pathBranch(p) + '/transactions', A, receipt.payload)); assert.equal(replay.replayed, true); assert.equal(replay.revision, receipt.revision);
      assert.deepEqual(await readBranch(A, p), before);
      assert.ok(savedSession, 'required session fixture was not produced');
      const session = expect(await request('GET', `/sessions/${savedSession.id}`, A)); assert.equal(session.draft, savedSession.draft); assert.deepEqual(session.draft_attachments[0], savedSession.attachment);
      assert.ok(assetPersistence, 'required asset fixture was not produced');
      const asset = await request('GET', origin + assetPersistence.url, null, undefined, { absolute: true }); assert.equal(asset.status, 200); assert.equal(hash(asset.bytes), assetPersistence.hash);
      o.previous_pid = pid; o.new_pid = child.pid; o.persisted_head = before.head;
    });

    await check('CB19', 'critical edit and receipt survive abrupt independent service termination', async o => {
      const before = await readBranch(A, p), transaction_id = unique('crash-retry');
      const payload = { transaction_id, base_revision: before.head, ops: [{ type: 'patch_object', resource_id: entry, object_id: 'b', expected_version: obj(before, 'b').version, patch: { position: [31, 17, -23] } }] };
      const accepted = expect(await request('POST', pathBranch(p) + '/transactions', B, payload));
      const pid = child.pid; await stop('SIGKILL'); await start();
      const restored = await readBranch(A, p); assert.equal(restored.head, accepted.revision); assert.deepEqual(obj(restored, 'b').position, [31, 17, -23]);
      const replay = expect(await request('POST', pathBranch(p) + '/transactions', B, payload)); assert.equal(replay.replayed, true); assert.equal(replay.revision, accepted.revision);
      const peer = await connect(B, p); const baseline = peer.messages.find(m => m.type === 'baseline'); assert.equal(baseline.branch.head, accepted.revision); peer.ws.close();
      o.previous_pid = pid; o.new_pid = child.pid; o.revision = accepted.revision;
    });

    report.completed = true;
  } catch (error) {
    report.fatal_error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    await stop();
    report.finished_at = new Date().toISOString();
    report.counts = { passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length, executed: report.cases.length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(sources.map(async p => [p, hash(await readFile(resolve(root, p)))])));
    report.source_changed_during_run = sources.filter(p => report.source_hashes[p] !== report.source_hashes_after[p]);
    await writeFile(resolve(out, 'server.log'), sanitized(serverLog));
    await save();
    console.log(`CREATION_REPORT ${resolve(out, 'report.json')}`);
    console.log(`CREATION_COUNTS ${JSON.stringify(report.counts)}`);
  }
});
