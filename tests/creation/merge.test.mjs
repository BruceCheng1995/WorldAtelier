import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = 48921, origin = `http://127.0.0.1:${port}`, api = `${origin}/creation-api`, rid = 'scene-harbor';
const pause = ms => new Promise(ok => setTimeout(ok, ms));
const uid = p => `${p}-${randomUUID()}`;
const hash = x => createHash('sha256').update(x).digest('hex');
const address = (p, b = 'main') => `/projects/${p}/branches/${b}`;
const at = (b, id = 'x') => b.manifest.resources[rid].objects.find(x => x.id === id);
const anchor = id => ({ id, name: id, kind: 'anchor', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], components: {} });
const clean = x => Array.isArray(x) ? x.map(clean) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, ['password', 'token', 'code'].includes(k) ? '[redacted]' : clean(v)])) : x;
async function free() { const s = createServer(); await new Promise((ok, no) => { s.once('error', no); s.listen(port, '127.0.0.1', ok); }); await new Promise(ok => s.close(ok)); }

test('creation merge and scale: actual isolated service', { timeout: 90000 }, async t => {
  await free();
  const out = resolve(root, '.local/creation-verification/merge', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-creation-merge-'));
  await mkdir(out, { recursive: true });
  const sources = ['services/creation/store.mjs', 'services/creation/schema.mjs', 'services/creation/realtime.mjs', 'services/creation/service.mjs', 'services/preview/server.mjs'];
  const report = { started_at: new Date().toISOString(), root, port, data, node: process.version, agent_disabled: true, scope: 'HTTP/WS merge and TRS bounds; no Godot/browser/Agent/world', cases: [], traffic: [], processes: [], source_hashes: {}, completed: false };
  for (const file of sources) report.source_hashes[file] = hash(await readFile(resolve(root, file)));
  let child, log = '', sockets = new Set();
  const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(clean(report), null, 2) + '\n');
  async function start() {
    await free();
    child = spawn(process.execPath, ['services/preview/server.mjs'], { cwd: root, env: { ...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: data, WORLD_ATELIER_CREATION_DATA: resolve(data, 'creation'), WORLD_ATELIER_DISABLE_AGENT: '1', WORLD_ATELIER_DISABLE_WORLDS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { pid: child.pid, started_at: Date.now() }; report.processes.push(record);
    child.stdout.on('data', b => { log += `[${record.pid} stdout] ${b}`; }); child.stderr.on('data', b => { log += `[${record.pid} stderr] ${b}`; });
    child.once('exit', (code, signal) => Object.assign(record, { exit_code: code, signal, stopped_at: Date.now() }));
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error(log); try { const response = await fetch(api + '/health'); if (response.ok) return; } catch {} await pause(50); }
    throw Error('Independent service failed to start');
  }
  async function stop() {
    for (const ws of sockets) ws.terminate(); sockets.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const own = child, exited = new Promise(ok => own.once('exit', ok)); own.kill('SIGTERM');
    const kill = setTimeout(() => own.kill('SIGKILL'), 4000); await exited; clearTimeout(kill); await free();
  }
  async function req(method, path, user = null, input) {
    const headers = { origin, 'content-type': 'application/json' }; if (user) headers.authorization = `Bearer ${user.token}`;
    const response = await fetch(api + path, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
    const value = await response.json(); report.traffic.push(clean({ at: Date.now(), method, path, actor: user?.user?.id, input, status: response.status, value })); return { status: response.status, value };
  }
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.value)); return r.value; };
  async function read(user, p, b = 'main') { return ok(await req('GET', address(p, b), user)); }
  async function tx(user, p, b, ops) { const branch = await read(user, p, b); return ok(await req('POST', address(p, b) + '/transactions', user, { transaction_id: uid('tx'), base_revision: branch.head, ops })); }
  async function patch(user, p, b, id, changes) { const branch = await read(user, p, b); return tx(user, p, b, [{ type: 'patch_object', resource_id: rid, object_id: id, expected_version: at(branch, id).version, patch: changes }]); }
  async function preview(user, p, target = 'main', source = 'source') { return ok(await req('POST', address(p, target) + '/merge-preview', user, { source_branch_id: source })); }
  async function merge(user, p, compare, resolutions = {}, target = 'main') { return req('POST', address(p, target) + '/merge', user, { preview_id: compare.id, resolutions }); }
  async function check(id, title, fn) {
    const row = { id, title, status: 'running', started_at: Date.now(), observations: {} }; report.cases.push(row);
    await t.test(`${id} ${title}`, async () => { try { await fn(row.observations); row.status = 'passed'; } catch (error) { row.status = 'failed'; row.error = { message: error.message, stack: error.stack }; throw error; } finally { row.finished_at = Date.now(); await save(); console.log(`MERGE_CASE ${id} ${row.status}`); } });
  }
  async function wsPeer(user, p) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/creation`, { origin }), messages = []; sockets.add(ws);
    ws.on('message', bytes => { const packet = JSON.parse(bytes.toString()); messages.push(packet); report.traffic.push(clean({ at: Date.now(), transport: 'ws', actor: user.user.id, packet })); }); ws.on('error', () => {});
    const send = message => { report.traffic.push(clean({ at: Date.now(), transport: 'ws-send', actor: user.user.id, packet: message })); ws.send(JSON.stringify(message)); };
    const wait = async (type, predicate = () => true, mark = 0) => { const until = Date.now() + 2000; while (Date.now() < until) { const message = messages.slice(mark).find(m => m.type === type && predicate(m)); if (message) return message; await pause(10); } throw Error(`Timed out waiting ${type}: ${JSON.stringify(messages.slice(mark))}`); };
    await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); }); send({ type: 'auth', token: user.token }); await wait('authenticated');
    send({ type: 'subscribe', project_id: p, branch_id: 'main', resource_id: rid, generation: 1 }); await wait('baseline');
    return { ws, send, wait, messages };
  }
  try {
    await start();
    const A = ok(await req('POST', '/auth/register', null, { name: uid('merge-owner'), password: uid('password') }), 201);
    const B = ok(await req('POST', '/auth/register', null, { name: uid('merge-editor'), password: uid('password') }), 201);
    const V = ok(await req('POST', '/auth/register', null, { name: uid('merge-viewer'), password: uid('password') }), 201);
    async function fixture(label) {
      const created = ok(await req('POST', '/projects', A, { name: uid(label), template: 'empty' }), 201), p = created.project.id;
      for (const [user, role] of [[B, 'editor'], [V, 'viewer']]) { const invite = ok(await req('POST', `/projects/${p}/invites`, A, { role }), 201); ok(await req('POST', '/invites/join', user, { code: invite.code })); }
      await tx(A, p, 'main', ['x', 'y'].map(id => ({ type: 'put_object', resource_id: rid, object_id: id, expected_version: null, object: anchor(id) })));
      const base = await read(A, p); ok(await req('POST', `/projects/${p}/branches`, A, { from_branch: 'main', branch_id: 'source', expected_head: base.head }), 201);
      return { p, base };
    }
    let successful;
    await check('CM01', 'fixed base/source/target and disjoint object merge', async o => {
      const f = await fixture('disjoint');
      const source = await patch(B, f.p, 'source', 'x', { position: [2, 3, 4], rotation: [15, 30, 45], scale: [1.5, 2, 0.5] });
      const target = await patch(A, f.p, 'main', 'y', { name: 'target-only', position: [-3, 2, -5] });
      const compare = await preview(A, f.p); assert.equal(compare.base_revision, f.base.head); assert.equal(compare.source_revision, source.revision); assert.equal(compare.target_revision, target.revision); assert.equal(compare.conflicts.length, 0);
      const peer = await wsPeer(B, f.p), mark = peer.messages.length;
      const result = ok(await merge(A, f.p, compare));
      const broadcast = await peer.wait('committed', m => m.revision === result.revision, mark); assert.equal(broadcast.transaction_id, compare.id);
      assert.deepEqual(at(result.branch).position, [2, 3, 4]); assert.deepEqual(at(result.branch).scale, [1.5, 2, 0.5]); assert.equal(at(result.branch, 'y').name, 'target-only');
      assert.equal((await read(B, f.p, 'source')).head, source.revision);
      successful = { ...f, compare, result, source }; o.preview = compare; o.result = result; peer.ws.close();
    });
    for (const choice of ['source', 'target']) await check(choice === 'source' ? 'CM02' : 'CM03', `same-object conflict requires explicit ${choice} choice and stays atomic`, async o => {
      const f = await fixture('conflict-' + choice);
      const source = await patch(B, f.p, 'source', 'x', { position: [9, 8, 7] });
      const target = await patch(A, f.p, 'main', 'x', { scale: [2, 3, 4] });
      await patch(B, f.p, 'source', 'y', { name: 'non-conflicting-source-y' });
      const compare = await preview(A, f.p); const key = `object/${rid}/x`;
      assert.equal(compare.conflicts.length, 1); assert.equal(compare.conflicts[0].key, key);
      assert.equal((await merge(A, f.p, compare)).status, 409); assert.deepEqual(await read(A, f.p), target.branch);
      assert.equal((await merge(A, f.p, compare, { [key]: 'invalid-choice' })).status, 409); assert.deepEqual(await read(A, f.p), target.branch);
      const result = ok(await merge(A, f.p, compare, { [key]: choice }));
      const expected = at(choice === 'source' ? source.branch : target.branch);
      for (const prop of ['position', 'rotation', 'scale']) assert.deepEqual(at(result.branch)[prop], expected[prop]);
      assert.equal(at(result.branch, 'y').name, 'non-conflicting-source-y'); o.preview = compare; o.choice = choice; o.result = result;
    });
    await check('CM04', 'either head moving after preview rejects stale merge', async o => {
      o.attempts = [];
      for (const changedBranch of ['source', 'main']) {
        const f = await fixture('stale-' + changedBranch); await patch(B, f.p, 'source', 'x', { name: 'source-before-preview' });
        const compare = await preview(A, f.p); await patch(A, f.p, changedBranch, 'y', { name: 'after-preview' });
        const targetBefore = await read(A, f.p), sourceBefore = await read(B, f.p, 'source');
        const result = await merge(A, f.p, compare); assert.equal(result.status, 409); assert.deepEqual(await read(A, f.p), targetBefore); assert.deepEqual(await read(B, f.p, 'source'), sourceBefore);
        o.attempts.push({ changed_branch: changedBranch, preview: compare, error: result.value });
      }
    });
    await check('CM05', 'merge preview and completed result remain after restart', async o => {
      const f = await fixture('restart'); await patch(B, f.p, 'source', 'x', { name: 'source-conflict' }); await patch(A, f.p, 'main', 'x', { name: 'target-conflict' });
      const compare = await preview(A, f.p), before = await read(A, f.p), pid1 = child.pid;
      await stop(); await start(); assert.deepEqual(await read(A, f.p), before); assert.equal((await merge(A, f.p, compare)).status, 409); assert.deepEqual(await read(A, f.p), before);
      const choices = { [`object/${rid}/x`]: 'source' }, result = ok(await merge(A, f.p, compare, choices)), pid2 = child.pid;
      await stop(); await start(); assert.deepEqual(await read(A, f.p), result.branch);
      const replay = ok(await merge(A, f.p, compare, choices)); assert.equal(replay.revision, result.revision); assert.equal(replay.replayed, true);
      o.pids = [pid1, pid2, child.pid]; o.preview = compare; o.result = result;
    });
    await check('CM06', 'merge retry has one result and differing resolutions are rejected', async o => {
      assert.ok(successful, 'CM01 fixture did not complete');
      const { p, compare, result } = successful, before = await read(A, p);
      const replay = ok(await merge(A, p, compare)); assert.equal(replay.replayed, true); assert.equal(replay.revision, result.revision); assert.deepEqual(await read(A, p), before);
      const other = await merge(A, p, compare, { arbitrary: 'target' }); assert.equal(other.status, 409); assert.deepEqual(await read(A, p), before);
      o.replay = replay; o.changed_decision = other.value;
    });
    await check('CM07', 'source continues after merge and next merge does not reapply old delta', async o => {
      assert.ok(successful, 'CM01 fixture did not complete'); const { p, source } = successful;
      const continued = await patch(B, p, 'source', 'x', { name: 'source-second-round', position: [4, 6, 8] });
      const compare = await preview(A, p); assert.equal(compare.base_revision, source.revision); assert.equal(compare.source_revision, continued.revision); assert.equal(compare.conflicts.length, 0);
      assert.deepEqual(compare.changes.map(c => c.key), [`object/${rid}/x`]);
      const result = ok(await merge(A, p, compare)); assert.equal(at(result.branch).name, 'source-second-round'); assert.equal(at(result.branch, 'y').name, 'target-only');
      o.preview = compare; o.result = result;
    });
    await check('CM08', 'merge endpoints enforce role, project and target-preview scope', async o => {
      const f = await fixture('permissions'); await patch(B, f.p, 'source', 'x', { name: 'permission-source' }); const compare = await preview(A, f.p);
      assert.equal((await req('POST', address(f.p) + '/merge-preview', V, { source_branch_id: 'source' })).status, 403);
      assert.equal((await merge(V, f.p, compare)).status, 403);
      assert.equal((await merge(A, f.p, compare, {}, 'source')).status, 404);
      const other = await fixture('other-project'); assert.equal((await merge(A, other.p, compare)).status, 404);
      const result = ok(await merge(B, f.p, compare));
      ok(await req('PATCH', `/projects/${f.p}/members/${B.user.id}`, A, { role: 'viewer' }));
      assert.equal((await merge(B, f.p, compare)).status, 403); o.result = result;
    });
    await check('CM09', 'canonical scale accepts 0.1/5 and rejects 0.01/100 atomically', async o => {
      const f = await fixture('scale'); o.accepted = []; o.rejected = [];
      for (const scale of [[0.1, 1, 5], 0.1, 5]) { const result = await patch(A, f.p, 'main', 'x', { scale }); const expected = Array.isArray(scale) ? scale : [scale, scale, scale]; assert.deepEqual(at(result.branch).scale, expected); o.accepted.push(at(result.branch).scale); }
      for (const scale of [[0.01, 1, 1], [1, 100, 1], 0.01, 100]) {
        const before = await read(A, f.p), response = await req('POST', address(f.p) + '/transactions', A, { transaction_id: uid('scale'), base_revision: before.head, ops: [{ type: 'patch_object', resource_id: rid, object_id: 'x', expected_version: at(before).version, patch: { scale } }] });
        assert.equal(response.status, 400); assert.deepEqual(await read(A, f.p), before); o.rejected.push({ scale, response: response.value });
      }
    });
    await check('CM10', 'WS preview uses the same scale boundaries without persisting preview', async o => {
      const f = await fixture('preview-scale'), before = await read(A, f.p), a = await wsPeer(A, f.p), b = await wsPeer(B, f.p);
      const data = { type: 'drag_preview', generation: 1, object_id: 'x', expected_version: at(before).version, position: [1, 2, 3], rotation: [10, 20, 30] };
      for (const scale of [[0.1, 1, 5], [5, 0.1, 0.1]]) { const mark = b.messages.length; a.send({ ...data, scale }); const packet = await b.wait('drag_preview', m => m.preview.scale[0] === scale[0], mark); assert.deepEqual(packet.preview.scale, scale); a.send({ type: 'drag_end', generation: 1 }); }
      for (const scale of [[0.01, 1, 1], [1, 100, 1]]) { const mark = a.messages.length, bm = b.messages.length; a.send({ ...data, scale }); assert.equal((await a.wait('error', () => true, mark)).status, 400); await pause(30); assert.equal(b.messages.slice(bm).filter(x => x.type === 'drag_preview').length, 0); }
      assert.deepEqual(await read(A, f.p), before); o.document_unchanged = true; a.ws.close(); b.ws.close();
    });
    report.completed = true;
  } catch (error) { report.fatal_error = { message: error.message, stack: error.stack }; throw error; }
  finally {
    await stop(); report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(sources.map(async f => [f, hash(await readFile(resolve(root, f)))])));
    report.source_changed_during_run = sources.filter(f => report.source_hashes[f] !== report.source_hashes_after[f]);
    await save(); await writeFile(resolve(out, 'server.log'), log); console.log(`MERGE_REPORT ${resolve(out, 'report.json')}`); console.log(`MERGE_COUNTS ${JSON.stringify(report.counts)}`);
  }
});
