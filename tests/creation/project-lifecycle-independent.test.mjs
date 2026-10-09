/** Independent project lifecycle and manual artwork HTTP tests.
 * Real auth, SQLite, native source imports and media bytes on isolated port 48921.
 * Native imports use the existing headless adapter. No Agent or game is launched;
 * PNG inputs are explicit test fixtures, not evidence of a captured game frame.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {deflateSync} from 'node:zlib';
import {CreationService} from '../../services/creation/service.mjs';

const root = resolve(import.meta.dirname, '../..');
const port = Number(process.env.WORLD_ATELIER_LIFECYCLE_TEST_PORT ?? 48921);
const origin = `http://127.0.0.1:${port}`;

function png(red) {
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, 90, 190, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const image = red => ({data_url: `data:image/png;base64,${png(red).toString('base64')}`, name: `手动截图-${red}.png`});

test('project rename/archive/restore and manual covers preserve independent state boundaries', {timeout: 180000}, async t => {
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-project-lifecycle-'));
  let server, service;
  async function start() {
    server = createServer(async (req, res) => {
      try { if (await service.request(req, res)) return; res.writeHead(404); res.end(); }
      catch (error) { res.writeHead(500); res.end(error.message); }
    });
    const saved = ['WORLD_ATELIER_DISABLE_AGENT', 'WORLD_ATELIER_DISABLE_WORLDS'].map(key => [key, process.env[key]]);
    for (const [key] of saved) process.env[key] = '1';
    try { service = new CreationService({server, root, data, origin}); }
    finally { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; }
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  }
  async function stop() {
    await service?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  }
  t.after(async () => { await stop(); await rm(data, {recursive: true, force: true}); });
  await start();
  async function request(method, path, account, body, headers = {}) {
    const response = await fetch(new URL(path.startsWith('/') ? path : '/creation-api/' + path, origin), {
      method, headers: {origin, connection: 'close', 'content-type': 'application/json', ...(account ? {authorization: `Bearer ${account.token}`} : {}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {status: response.status, bytes, value: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : undefined};
  }
  const ok = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result.value)); return result.value; };
  const account = async name => ok(await request('POST', 'auth/register', null, {name, password: 'isolated-lifecycle-password'}), 201);
  const owner = await account('Lifecycle owner'), editor = await account('Lifecycle editor'), viewer = await account('Lifecycle viewer'), outsider = await account('Lifecycle outsider');
  const bootstrap = async (who = owner) => ok(await request('GET', 'bootstrap', who));
  const project = async id => (await bootstrap()).projects.find(p => p.id === id);
  const branch = async (id, branchId = 'main') => ok(await request('GET', `projects/${id}/branches/${branchId}`, owner));
  const patch = (id, version, body, who = owner) => request('PATCH', `projects/${id}`, who, {expected_version: version, ...body});
  async function create(name) { return ok(await request('POST', 'projects', owner, {name, template: 'empty'}), 201).project; }
  async function grant(id, who, role) {
    const invite = ok(await request('POST', `projects/${id}/invites`, owner, {role}), 201);
    ok(await request('POST', 'invites/join', who, {code: invite.code}));
  }
  async function captureBody(id, red, overrides = {}, branchId = 'main') {
    const p = await project(id), b = await branch(id, branchId);
    return {expected_version: b.presentation.version, expected_project_version: p.presentation.version, scope: 'both',
      source_revision: b.head, resource_id: b.manifest.entry_scene_id, runtime_build_id: 'a'.repeat(64),
      mode: 'play', scene_generation: 2, image: image(red), ...overrides};
  }
  const capture = (id, input, who = owner, branchId = 'main') => request('POST', `projects/${id}/branches/${branchId}/manual-cover`, who, input);
  const snapshot = async id => ({project: (await project(id)).presentation, branch: (await branch(id)).presentation});
  const a = await create('原工程名称');
  await grant(a.id, editor, 'editor'); await grant(a.id, viewer, 'viewer');

  await t.test('owner rename trims the display name without changing native source, branch names or sessions', async () => {
    const before = await branch(a.id), p = await project(a.id);
    const session = ok(await request('POST', `projects/${a.id}/branches/main/sessions`, owner, {title: '保留会话'}), 201);
    const sessionsBefore = service.store.list('creator_session');
    ok(await patch(a.id, p.permission_version, {name: '  改名后的工程  '}));
    const changed = await project(a.id), after = await branch(a.id);
    assert.equal(changed.id, a.id); assert.equal(changed.name, '改名后的工程');
    assert.equal(changed.permission_version, p.permission_version + 1);
    assert.equal(after.name, before.name); assert.equal(after.head, before.head);
    assert.deepEqual(after.manifest.source_files, before.manifest.source_files);
    assert.deepEqual(changed.presentation, p.presentation);
    assert.deepEqual(service.store.list('creator_session'), sessionsBefore);
    assert.ok(session.id);
  });

  await t.test('nonowners cannot rename/archive/restore, and malformed edits leave metadata unchanged', async () => {
    const before = await project(a.id);
    for (const who of [editor, viewer, outsider, null]) {
      for (const body of [{name: '越权改名'}, {archived: true}, {archived: false}])
        assert.equal((await patch(a.id, before.permission_version, body, who)).status, who ? 403 : 401);
    }
    for (const body of [{name: ''}, {name: '  '}, {name: 'x'.repeat(161)}, {archived: 'yes'}, {}])
      assert.equal((await patch(a.id, before.permission_version, body)).status, 400, JSON.stringify(body));
    assert.equal((await request('PATCH', `projects/${a.id}`, owner, {name: '缺少版本'})).status, 400);
    assert.equal((await request('PATCH', `projects/${a.id}`, owner, {expected_version: before.permission_version, name: '跨源'}, {origin: 'https://unrelated.invalid'})).status, 403);
    assert.deepEqual(await project(a.id), before);
  });

  await t.test('simultaneous renames and permission changes share the same CAS boundary', async () => {
    const before = await project(a.id);
    const results = await Promise.all([patch(a.id, before.permission_version, {name: '并发名称 A'}), patch(a.id, before.permission_version, {name: '并发名称 B'})]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    let current = await project(a.id); assert.equal(current.permission_version, before.permission_version + 1);
    ok(await request('PATCH', `projects/${a.id}/members/${editor.user.id}`, owner, {role: 'viewer'}));
    assert.equal((await patch(a.id, current.permission_version, {archived: true})).status, 409);
    current = await project(a.id); assert.equal(Boolean(current.archived_at), false);
    ok(await request('PATCH', `projects/${a.id}/members/${editor.user.id}`, owner, {role: 'editor'}));
  });

  let archivedMedia;
  await t.test('archive removes all access while only the owner can discover its recovery metadata', async () => {
    ok(await capture(a.id, await captureBody(a.id, 40)));
    const before = await branch(a.id), p = await project(a.id), sessions = service.store.list('creator_session');
    archivedMedia = p.presentation.images[0];
    const lateCapture = await captureBody(a.id, 41);
    ok(await patch(a.id, p.permission_version, {archived: true}));
    const catalog = await bootstrap(); assert.equal(catalog.projects.some(p => p.id === a.id), false);
    const archived = catalog.archived_projects.find(p => p.id === a.id);
    assert.ok(archived.archived_at); assert.equal(archived.name, p.name); assert.equal(archived.permission_version, p.permission_version + 1);
    assert.equal(archived.branch_count, 1); assert.equal(archived.manifest, undefined); assert.equal(archived.branches, undefined);
    for (const who of [owner, editor, viewer, outsider]) {
      assert.equal((await request('GET', `projects/${a.id}/branches/main`, who)).status, 403);
      assert.equal((await request('GET', archivedMedia.url, who)).status, 403);
      if (who !== owner) assert.equal((await bootstrap(who)).archived_projects?.some(p => p.id === a.id) ?? false, false);
    }
    assert.equal((await capture(a.id, lateCapture)).status, 403);
    assert.equal(service.store.get('creator_branch', `${a.id}:main`).head, before.head);
    assert.deepEqual(service.store.list('creator_session'), sessions);
  });

  await t.test('archived state survives restart; guarded restore recovers the same project/media/source', async () => {
    const archived = (await bootstrap()).archived_projects.find(p => p.id === a.id);
    const head = service.store.get('creator_branch', `${a.id}:main`).head;
    await stop(); await start();
    assert.equal((await bootstrap()).archived_projects.find(p => p.id === a.id).permission_version, archived.permission_version);
    assert.equal((await patch(a.id, archived.permission_version - 1, {archived: false})).status, 409);
    for (const who of [editor, viewer, outsider]) assert.equal((await patch(a.id, archived.permission_version, {archived: false}, who)).status, 403);
    ok(await patch(a.id, archived.permission_version, {archived: false}));
    const restored = await project(a.id); assert.equal(restored.id, a.id); assert.equal(restored.permission_version, archived.permission_version + 1);
    assert.equal((await branch(a.id)).head, head); assert.equal((await bootstrap()).archived_projects.some(p => p.id === a.id), false);
    assert.deepEqual((await request('GET', archivedMedia.url, owner)).bytes, png(40));
    assert.equal((await request('GET', `projects/${a.id}/branches/main`, editor)).status, 200);
    await stop(); await start(); assert.equal((await project(a.id)).id, a.id);
  });

  const b = await create('手动封面工程');
  await grant(b.id, editor, 'editor'); await grant(b.id, viewer, 'viewer');
  await t.test('each capture scope selects the new image, pauses only that scope, and records actual frame context', async () => {
    const untouched = await snapshot(b.id), source = await branch(b.id);
    ok(await capture(b.id, await captureBody(b.id, 60, {scope: 'branch'}), editor));
    const branchOnly = await snapshot(b.id); assert.deepEqual(branchOnly.project, untouched.project);
    assert.equal(branchOnly.branch.auto_update, false); assert.equal(branchOnly.branch.cover_id, branchOnly.branch.images.at(-1).id);
    ok(await capture(b.id, await captureBody(b.id, 61, {scope: 'project', mode: 'inspect'})));
    const projectOnly = await snapshot(b.id); assert.deepEqual(projectOnly.branch, branchOnly.branch);
    assert.equal(projectOnly.project.auto_update, false);
    ok(await capture(b.id, await captureBody(b.id, 62, {scope: 'both'})));
    const both = await snapshot(b.id); assert.equal(both.project.cover_id, both.branch.cover_id);
    for (const media of [both.project, both.branch]) {
      const photo = media.images.find(i => i.id === media.cover_id);
      assert.equal(media.auto_update, false); assert.equal(photo.source_revision, source.head);
      assert.equal(photo.branch_id, 'main'); assert.equal(photo.resource_id, source.manifest.entry_scene_id);
      assert.equal(photo.runtime_build_id, 'a'.repeat(64)); assert.equal(photo.mode, 'play'); assert.equal(photo.scene_generation, 2);
      assert.deepEqual((await request('GET', photo.url, owner)).bytes, png(62));
    }
    assert.equal((await branch(b.id)).head, source.head);
    await stop(); await start(); assert.deepEqual(await snapshot(b.id), both);
  });

  await t.test('CAS and a late automatic request cannot overwrite the selected manual image', async () => {
    const before = await snapshot(b.id), input = await captureBody(b.id, 70);
    const results = await Promise.all([capture(b.id, input), capture(b.id, {...input, image: image(71)})]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const after = await snapshot(b.id);
    assert.equal(after.project.version, before.project.version + 1); assert.equal(after.branch.version, before.branch.version + 1);
    assert.equal((await request('POST', `projects/${b.id}/branches/main/auto-cover`, owner, {...input, image: image(72)})).status, 409);
    assert.deepEqual(await snapshot(b.id), after);
    const fresh = await captureBody(b.id, 73);
    for (const changes of [{expected_version: input.expected_version}, {expected_project_version: input.expected_project_version}]) {
      assert.equal((await capture(b.id, {...fresh, ...changes})).status, 409);
      assert.deepEqual(await snapshot(b.id), after);
    }
  });

  await t.test('manual capture rejects unauthorized, invalid context and unrelated revisions without a partial save', async () => {
    const before = await snapshot(b.id), body = await captureBody(b.id, 80), other = await branch(a.id);
    for (const who of [viewer, outsider]) assert.equal((await capture(b.id, body, who)).status, 403);
    assert.equal((await capture(b.id, body, null)).status, 401);
    for (const [change, status] of [[{scope: 'everything'}, 400], [{mode: 'loading'}, 422], [{runtime_build_id: 'invalid'}, 422], [{resource_id: 'absent-scene'}, 422], [{source_revision: other.head}, 409]]) {
      const result = await capture(b.id, {...body, ...change}); assert.equal(result.status, status, JSON.stringify(result.value));
      assert.deepEqual(await snapshot(b.id), before);
    }
  });

  await t.test('an already-running ancestor frame retains its actual source revision; a sibling branch frame is rejected', async () => {
    const old = await branch(b.id), originalFile = old.manifest.source_files['scenes/main.tscn'];
    const text = service.native.archive.read(originalFile).toString();
    ok(await request('POST', `projects/${b.id}/branches`, owner, {from_branch: 'main', branch_id: 'sibling', name: '独立来源'}), 201);
    const edit = async (branchId, base, suffix) => ok(await request('POST', `projects/${b.id}/branches/${branchId}/transactions`, owner, {
      transaction_id: `manual-cover-${branchId}`, base_revision: base,
      ops: [{type: 'put_source_file', path: 'scenes/main.tscn', expected_hash: originalFile.hash, text: text + `\n; ${suffix}\n`}],
    }));
    const main = await edit('main', old.head, 'main advanced'), sibling = await edit('sibling', old.head, 'sibling advanced');
    assert.notEqual(main.revision, old.head);
    ok(await capture(b.id, await captureBody(b.id, 90, {source_revision: old.head})));
    const current = await snapshot(b.id), photo = current.project.images.find(i => i.id === current.project.cover_id);
    assert.equal(photo.source_revision, old.head); assert.equal((await branch(b.id)).head, main.revision);
    assert.equal((await capture(b.id, await captureBody(b.id, 91, {source_revision: sibling.revision}))).status, 409);
    assert.deepEqual(await snapshot(b.id), current);
  });

  await t.test('a full project gallery rolls back both target scopes and leaves the existing cover intact', async () => {
    let current = await snapshot(b.id), red = 100;
    while (current.project.images.length < 8) {
      ok(await request('PATCH', `projects/${b.id}/presentation`, owner, {expected_version: current.project.version, image: image(red++)}));
      current = await snapshot(b.id);
    }
    const before = await snapshot(b.id);
    assert.equal((await capture(b.id, await captureBody(b.id, 120))).status, 422);
    assert.deepEqual(await snapshot(b.id), before);
  });

  await t.test('manually keeping an identical automatic frame preserves that photo after automatic updates resume', async () => {
    async function resume() {
      const state = await snapshot(a.id);
      ok(await request('PATCH', `projects/${a.id}/presentation`, owner, {expected_version: state.project.version, auto_update: true}));
      ok(await request('PATCH', `projects/${a.id}/branches/main/presentation`, owner, {expected_version: state.branch.version, auto_update: true}));
    }
    await resume();
    ok(await request('POST', `projects/${a.id}/branches/main/auto-cover`, owner, await captureBody(a.id, 130)));
    const automatic = await snapshot(a.id), samePhotoId = automatic.project.cover_id;
    ok(await capture(a.id, await captureBody(a.id, 130)));
    const manual = await snapshot(a.id);
    assert.equal(manual.project.cover_id, samePhotoId); assert.equal(manual.branch.cover_id, samePhotoId);
    await resume();
    ok(await request('POST', `projects/${a.id}/branches/main/auto-cover`, owner, await captureBody(a.id, 131)));
    const refreshed = await snapshot(a.id);
    for (const scope of ['project', 'branch']) {
      assert.ok(refreshed[scope].images.some(i => i.id === samePhotoId && i.source === 'manual'), `${scope}: manually kept photo disappeared`);
      assert.notEqual(refreshed[scope].cover_id, samePhotoId);
    }
  });
});
