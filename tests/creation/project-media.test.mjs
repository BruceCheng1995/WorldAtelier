/** Independent media API tests. Real HTTP and SQLite, temporary data, port 48921.
 * No Agent or Godot runtime is started; these checks establish catalog/media
 * persistence and authorization, not gameplay or visual experience acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {deflateSync} from 'node:zlib';
import {CreationService} from '../../services/creation/service.mjs';

const root = resolve(import.meta.dirname, '../..');
const port = Number(process.env.WORLD_ATELIER_MEDIA_TEST_PORT ?? 48921);
const origin = `http://127.0.0.1:${port}`;

// Small valid PNG fixtures with distinct pixels, including correct chunk CRCs.
function png(red = 30) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, red, 100, 200, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const upload = (red = 30) => ({data_url: `data:image/png;base64,${png(red).toString('base64')}`, name: `截图-${red}.png`});
// Actual Chromium canvas exports, with optional color-profile metadata removed.
const rasterFixtures = {
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z',
  webp: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=',
};

test('project and branch cover media: isolated HTTP, persistence, CAS and authorization', {timeout: 60000}, async t => {
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-project-media-'));
  let server, service;
  async function start() {
    server = createServer(async (req, res) => {
      try { if (await service.request(req, res)) return; res.writeHead(404); res.end(); }
      catch (error) { res.writeHead(500); res.end(error.message); }
    });
    const previous = ['WORLD_ATELIER_DISABLE_AGENT', 'WORLD_ATELIER_DISABLE_WORLDS'].map(key => [key, process.env[key]]);
    for (const [key] of previous) process.env[key] = '1';
    try { service = new CreationService({server, root, data, origin}); }
    finally { for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value; }
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  }
  async function stop() {
    await service?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  }
  t.after(async () => { await stop(); await rm(data, {recursive: true, force: true}); });
  await start();
  async function request(method, path, account, body, extraHeaders = {}) {
    const response = await fetch(new URL(path.startsWith('/') ? path : '/creation-api/' + path, origin), {
      method,
      headers: {origin, connection: 'close', 'content-type': 'application/json', ...(account ? {authorization: `Bearer ${account.token}`} : {}), ...extraHeaders},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {status: response.status, headers: response.headers, bytes, value: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : undefined};
  }
  function ok(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.value)); return result.value; }
  const account = async name => ok(await request('POST', 'auth/register', null, {name, password: 'isolated-test-password'}), 201);
  const owner = await account('Media owner'), editor = await account('Media editor'), viewer = await account('Media viewer'), outsider = await account('Unrelated creator');
  let serial = 0;
  const create = async () => ok(await request('POST', 'projects', owner, {name: `Media game ${++serial}`, template: 'empty'}), 201);
  const catalog = async (who = owner) => ok(await request('GET', 'bootstrap', who));
  const project = async id => (await catalog()).projects.find(p => p.id === id);
  const path = (id, branch) => `projects/${id}${branch ? `/branches/${branch}` : ''}/presentation`;
  const presentation = async (id, branch) => { const p = await project(id); return branch ? p.branches.find(b => b.branch_id === branch).presentation : p.presentation; };
  const patch = (id, version, body, who = owner, branch) => request('PATCH', path(id, branch), who, {expected_version: version, ...body});
  async function add(id, red, branch, who = owner) {
    const before = await presentation(id, branch);
    ok(await patch(id, before.version, {image: upload(red)}, who, branch));
    const after = await presentation(id, branch);
    assert.equal(after.version, before.version + 1);
    return after;
  }
  async function capture(id, red, branch = 'main', overrides = {}, who = owner) {
    const source = ok(await request('GET', `projects/${id}/branches/${branch}`, owner));
    const current = await presentation(id), branchMedia = source.presentation;
    return request('POST', `projects/${id}/branches/${branch}/auto-cover`, who, {
      expected_version: branchMedia.version, expected_project_version: current.version,
      source_revision: source.head, resource_id: source.manifest.entry_scene_id,
      runtime_build_id: 'a'.repeat(64), mode: 'edit', image: upload(red), ...overrides,
    });
  }

  await t.test('bootstrap represents multiple games and branches with empty media defaults', async () => {
    const a = await create(), b = await create();
    ok(await request('POST', `projects/${a.project.id}/branches`, owner, {from_branch: 'main', branch_id: 'experiment', name: '实验分支'}), 201);
    const items = (await catalog()).projects;
    for (const id of [a.project.id, b.project.id]) {
      const p = items.find(row => row.id === id);
      assert.deepEqual(p.presentation.images, []); assert.equal(p.presentation.cover_id, null);
      assert.equal(p.presentation.auto_update, true); assert.equal(p.presentation.auto_image_id, null); assert.equal(p.presentation.last_auto_at, null);
      assert.ok(Number.isInteger(p.presentation.version));
      for (const branch of p.branches) assert.deepEqual(branch.presentation, p.presentation);
    }
    assert.equal(items.find(row => row.id === a.project.id).branches.length, 2);
    assert.equal(items.find(row => row.id === b.project.id).branches.length, 1);
  });

  await t.test('uploads preserve bytes and metadata, with independent project and branch covers', async () => {
    const {project: p} = await create();
    const initial = await request('GET', `projects/${p.id}/branches/main`, owner);
    const game = await add(p.id, 40), branch = await add(p.id, 41, 'main');
    assert.equal(game.cover_id, game.images[0].id); assert.equal(branch.cover_id, branch.images[0].id);
    assert.notEqual(game.cover_id, branch.cover_id);
    assert.deepEqual(await presentation(p.id), game);
    const image = game.images[0];
    for (const field of ['id', 'url', 'name', 'mime', 'created_at']) assert.ok(image[field], `missing ${field}`);
    assert.equal(image.name, '截图-40.png'); assert.equal(image.mime, 'image/png');
    assert.equal(image.data_url, undefined, 'bootstrap must not inline uploaded file bytes');
    const media = await request('GET', image.url, owner);
    assert.equal(media.status, 200); assert.deepEqual(media.bytes, png(40));
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
    assert.match(media.headers.get('cache-control'), /private|no-store/);
    assert.equal(ok(await request('GET', `projects/${p.id}/branches/main`, owner)).head, ok(initial).head, 'cover edits must not change source revisions');
  });

  await t.test('cover selection, deletion and explicit clearing remain coherent', async () => {
    const {project: p} = await create();
    await add(p.id, 50); const two = await add(p.id, 51);
    const [first, second] = two.images;
    ok(await patch(p.id, two.version, {cover_id: second.id}));
    let state = await presentation(p.id); assert.equal(state.cover_id, second.id);
    ok(await patch(p.id, state.version, {remove_image_id: first.id}));
    state = await presentation(p.id); assert.equal(state.cover_id, second.id); assert.equal(state.images.length, 1);
    ok(await patch(p.id, state.version, {cover_id: null}));
    state = await presentation(p.id); assert.equal(state.cover_id, null); assert.equal(state.images.length, 1);
    ok(await patch(p.id, state.version, {cover_id: second.id}));
    state = await presentation(p.id);
    ok(await patch(p.id, state.version, {remove_image_id: second.id}));
    state = await presentation(p.id); assert.equal(state.cover_id, null); assert.deepEqual(state.images, []);
    assert.equal((await request('GET', second.url, owner)).status, 404, 'removed media is not still served');
  });

  await t.test('valid JPEG and WebP screenshots are accepted and served unchanged', async () => {
    const {project: p} = await create();
    for (const [format, base64] of Object.entries(rasterFixtures)) {
      const before = await presentation(p.id), mime = `image/${format}`;
      ok(await patch(p.id, before.version, {image: {data_url: `data:${mime};base64,${base64}`, name: `screenshot.${format}`}}));
      const image = (await presentation(p.id)).images.at(-1), result = await request('GET', image.url, owner);
      assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), mime);
      assert.deepEqual(result.bytes, Buffer.from(base64, 'base64'));
    }
  });

  await t.test('concurrent updates use CAS and a rejected write changes neither list nor version', async () => {
    const {project: p} = await create(), before = await presentation(p.id);
    const results = await Promise.all([patch(p.id, before.version, {image: upload(60)}), patch(p.id, before.version, {image: upload(61)})]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const after = await presentation(p.id); assert.equal(after.images.length, 1); assert.equal(after.version, before.version + 1);
    assert.equal((await request('PATCH', path(p.id), owner, {cover_id: after.cover_id})).status, 400);
    assert.equal((await patch(p.id, before.version, {remove_image_id: after.cover_id})).status, 409);
    assert.deepEqual(await presentation(p.id), after);
  });

  await t.test('fork inherits images, then removal and cover fallback affect only that branch', async () => {
    const {project: p} = await create();
    await add(p.id, 65, 'main'); const source = await add(p.id, 66, 'main');
    ok(await request('POST', `projects/${p.id}/branches`, owner, {from_branch: 'main', branch_id: 'art-test', name: '美术实验'}), 201);
    assert.deepEqual(await presentation(p.id, 'art-test'), source);
    ok(await patch(p.id, source.version, {remove_image_id: source.cover_id}, owner, 'art-test'));
    const fork = await presentation(p.id, 'art-test');
    assert.equal(fork.images.length, 1); assert.equal(fork.cover_id, source.images[1].id);
    assert.deepEqual(await presentation(p.id, 'main'), source);
    assert.equal((await request('GET', source.images[0].url, owner)).status, 200, 'media referenced by the source branch must remain available');
    ok(await patch(p.id, source.version, {remove_image_id: source.cover_id}, owner, 'main'));
    assert.equal((await request('GET', source.images[0].url, owner)).status, 404, 'unreferenced media must stop being served');
  });

  await t.test('member permissions and revocation apply to media reads and writes', async () => {
    const {project: p} = await create();
    for (const [who, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
      const invite = ok(await request('POST', `projects/${p.id}/invites`, owner, {role}), 201);
      ok(await request('POST', 'invites/join', who, {code: invite.code}));
    }
    const state = await add(p.id, 70, undefined, editor), media = state.images[0];
    assert.equal((await request('GET', media.url, viewer)).status, 200);
    assert.equal((await request('GET', media.url, outsider)).status, 403);
    assert.equal((await request('GET', media.url, null)).status, 401);
    for (const who of [viewer, outsider]) assert.equal((await patch(p.id, state.version, {image: upload(71)}, who)).status, 403);
    assert.equal((await catalog(outsider)).projects.some(row => row.id === p.id), false);
    ok(await request('PATCH', `projects/${p.id}/members/${editor.user.id}`, owner, {role: null}));
    assert.equal((await request('GET', media.url, editor)).status, 403);
    assert.equal((await patch(p.id, state.version, {image: upload(72)}, editor)).status, 403);
    assert.deepEqual(await presentation(p.id), state);
  });

  await t.test('media and cover IDs cannot be used through another project or branch', async () => {
    const {project: a} = await create(), {project: b} = await create();
    const media = (await add(a.id, 80)).images[0], untouched = await presentation(b.id);
    assert.equal((await request('GET', `projects/${b.id}/media/${media.id}`, owner)).status, 404);
    assert.ok([400, 404, 422].includes((await patch(b.id, untouched.version, {cover_id: media.id})).status));
    assert.ok([400, 404].includes((await patch(b.id, untouched.version, {remove_image_id: media.id})).status));
    assert.deepEqual(await presentation(b.id), untouched);
    const branch = await presentation(a.id, 'main');
    assert.ok([400, 404, 422].includes((await patch(a.id, branch.version, {cover_id: media.id}, owner, 'main')).status));
    assert.deepEqual(await presentation(a.id, 'main'), branch);
  });

  await t.test('invalid images, unknown references and over-limit requests leave state unchanged', async () => {
    const {project: p} = await create(), before = await presentation(p.id);
    const invalid = [
      {data_url: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'), name: 'unsafe.svg'},
      {data_url: 'data:image/png;base64,' + Buffer.from('not an image').toString('base64'), name: 'fake.png'},
      {data_url: 'data:image/png;base64,%%%%', name: 'broken.png'},
      {data_url: 'data:image/jpeg;base64,' + png().toString('base64'), name: 'wrong.jpeg'},
      {data_url: 'https://example.com/image.png', name: 'remote.png'},
      {data_url: 'data:image/png;base64,', name: 'empty.png'},
      {data_url: 'data:image/png;base64,' + Buffer.concat([png().subarray(0, 33), png().subarray(-12)]).toString('base64'), name: 'missing-pixel-data.png'},
    ];
    for (const image of invalid) {
      const result = await patch(p.id, before.version, {image});
      assert.ok([400, 413, 422].includes(result.status), `${image.name}: ${result.status} ${JSON.stringify(result.value)}`);
      assert.deepEqual(await presentation(p.id), before);
    }
    const large = Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024)]);
    const tooLarge = await patch(p.id, before.version, {image: {name: 'large.png', data_url: `data:image/png;base64,${large.toString('base64')}`}});
    assert.equal(tooLarge.status, 413); assert.deepEqual(await presentation(p.id), before);
    const crossOrigin = await request('PATCH', path(p.id), owner, {expected_version: before.version, image: upload()}, {origin: 'https://unrelated.invalid'});
    assert.equal(crossOrigin.status, 403); assert.deepEqual(await presentation(p.id), before);
  });

  await t.test('eight screenshot limit rejects a ninth without a partial write', async () => {
    const {project: p} = await create();
    for (let i = 0; i < 8; i++) await add(p.id, 100 + i);
    const state = await presentation(p.id); assert.equal(state.images.length, 8);
    const ninth = await patch(p.id, state.version, {image: upload(108)});
    assert.ok([400, 409, 413, 422].includes(ninth.status));
    assert.deepEqual(await presentation(p.id), state);
  });

  await t.test('service restart retains project and branch image metadata, cover selection and bytes', async () => {
    const {project: p} = await create();
    const game = await add(p.id, 120), branch = await add(p.id, 121, 'main');
    await stop(); await start();
    assert.deepEqual(await presentation(p.id), game); assert.deepEqual(await presentation(p.id, 'main'), branch);
    assert.deepEqual((await request('GET', game.images[0].url, owner)).bytes, png(120));
    assert.deepEqual((await request('GET', branch.images[0].url, owner)).bytes, png(121));
    const next = await add(p.id, 122); assert.equal(next.images.length, 2);
  });

  await t.test('automatic main capture updates game and branch, then replaces one slot and retires old media', async () => {
    const {project: p} = await create();
    const first = ok(await capture(p.id, 130));
    for (const state of [first.presentation, first.project_presentation]) {
      assert.equal(state.auto_update, true); assert.equal(state.images.length, 1);
      assert.equal(state.cover_id, state.auto_image_id); assert.equal(state.last_auto_at, first.captured_at);
      assert.equal(state.images[0].source, 'automatic'); assert.equal(state.images[0].branch_id, 'main');
      assert.equal(state.images[0].runtime_build_id, 'a'.repeat(64)); assert.equal(state.images[0].mode, 'edit');
    }
    assert.equal(first.presentation.cover_id, first.project_presentation.cover_id);
    const second = ok(await capture(p.id, 131, 'main', {mode: 'play'}));
    assert.equal(second.presentation.images.length, 1); assert.equal(second.project_presentation.images.length, 1);
    assert.equal(second.presentation.version, first.presentation.version + 1);
    assert.notEqual(second.presentation.cover_id, first.presentation.cover_id);
    assert.equal((await request('GET', first.presentation.images[0].url, owner)).status, 404);
    await assert.rejects(access(resolve(data, 'project-media', first.presentation.cover_id)), {code: 'ENOENT'}, 'superseded automatic bytes must not accumulate');
    assert.deepEqual((await request('GET', second.presentation.images[0].url, owner)).bytes, png(131));
  });

  await t.test('replacing an automatic image preserves its bytes while another project uses the same image', async () => {
    const {project: p} = await create(), {project: other} = await create();
    const captured = ok(await capture(p.id, 190));
    const manual = await add(other.id, 190); assert.equal(manual.images[0].id, captured.presentation.cover_id);
    ok(await capture(p.id, 191));
    assert.equal((await request('GET', captured.presentation.images[0].url, owner)).status, 404);
    assert.deepEqual((await request('GET', manual.images[0].url, owner)).bytes, png(190));
    await access(resolve(data, 'project-media', manual.images[0].id));
  });

  await t.test('non-main automatic capture is isolated and main honors independently manual scopes', async () => {
    const {project: p} = await create();
    ok(await request('POST', `projects/${p.id}/branches`, owner, {from_branch: 'main', branch_id: 'auto-test', name: '自动截图实验'}), 201);
    const gameBefore = await presentation(p.id), mainBefore = await presentation(p.id, 'main');
    const fork = ok(await capture(p.id, 140, 'auto-test'));
    assert.equal(fork.presentation.images.length, 1);
    assert.deepEqual(await presentation(p.id), gameBefore); assert.deepEqual(await presentation(p.id, 'main'), mainBefore);
    const manualGame = await add(p.id, 141); assert.equal(manualGame.auto_update, false);
    ok(await capture(p.id, 142)); assert.deepEqual(await presentation(p.id), manualGame);
    const main = await presentation(p.id, 'main');
    ok(await patch(p.id, main.version, {auto_update: false}, owner, 'main'));
    ok(await patch(p.id, manualGame.version, {auto_update: true}));
    const manualBranch = await presentation(p.id, 'main');
    ok(await capture(p.id, 143)); assert.deepEqual(await presentation(p.id, 'main'), manualBranch);
    assert.equal((await presentation(p.id)).images[0].source, 'automatic');
    assert.ok((await presentation(p.id)).images.some(i => i.id === manualGame.images[0].id), 'restoring automatic mode retains manually uploaded screenshots');
  });

  await t.test('manual actions pause automatic updates; restoration and legacy defaults are persisted', async () => {
    const {project: p} = await create(); await capture(p.id, 150);
    for (const branch of [undefined, 'main']) {
      const before = await presentation(p.id, branch);
      ok(await patch(p.id, before.version, {cover_id: before.cover_id}, owner, branch));
      assert.equal((await presentation(p.id, branch)).auto_update, false);
    }
    const game = await presentation(p.id), main = await presentation(p.id, 'main');
    assert.equal((await capture(p.id, 151)).status, 409);
    assert.deepEqual(await presentation(p.id), game); assert.deepEqual(await presentation(p.id, 'main'), main);
    for (const branch of [undefined, 'main']) {
      const before = await presentation(p.id, branch);
      ok(await patch(p.id, before.version, {auto_update: true}, owner, branch));
    }
    ok(await capture(p.id, 152));
    const after = await presentation(p.id);
    assert.equal((await patch(p.id, after.version, {auto_update: true, image: upload(153)})).status, 400);
    assert.equal((await patch(p.id, after.version, {auto_update: 'yes'})).status, 400);
    assert.deepEqual(await presentation(p.id), after);
    const legacy = service.store.get('creator_project', p.id);
    delete legacy.presentation.auto_update; delete legacy.presentation.auto_image_id; delete legacy.presentation.last_auto_at;
    service.store.put('creator_project', legacy); // Explicit isolated fixture for older persisted metadata.
    assert.equal((await presentation(p.id)).auto_update, false, 'preexisting manually curated images must remain manual');
    await stop(); await start();
    assert.equal((await presentation(p.id)).auto_update, false);
    assert.equal((await presentation(p.id, 'main')).auto_update, true);
  });

  await t.test('automatic capture rejects stale versions, wrong source/context and unauthorized users atomically', async () => {
    const {project: p} = await create(); const first = ok(await capture(p.id, 160));
    const invalid = [
      [{expected_version: 0}, 409], [{expected_project_version: 0}, 409],
      [{source_revision: 'src-obsolete'}, 409], [{resource_id: 'missing-scene'}, 422],
      [{runtime_build_id: 'not-a-build'}, 422], [{mode: 'inspect'}, 422],
    ];
    for (const [overrides, status] of invalid) {
      assert.equal((await capture(p.id, 161, 'main', overrides)).status, status);
      assert.deepEqual(await presentation(p.id), first.project_presentation); assert.deepEqual(await presentation(p.id, 'main'), first.presentation);
    }
    for (const who of [viewer, outsider]) assert.equal((await capture(p.id, 161, 'main', {}, who)).status, 403);
    const source = ok(await request('GET', `projects/${p.id}/branches/main`, owner));
    ok(await request('POST', `projects/${p.id}/branches/main/transactions`, owner, {transaction_id: 'auto-media-prefab-fixture', base_revision: source.head, ops: [{type: 'create_resource', resource_id: 'prefab-auto-test', resource: {kind: 'prefab', name: '非场景截图拒绝夹具', objects: []}}]}));
    assert.equal((await capture(p.id, 162, 'main', {resource_id: 'prefab-auto-test'})).status, 422);
    assert.deepEqual(await presentation(p.id), first.project_presentation); assert.deepEqual(await presentation(p.id, 'main'), first.presentation);
  });

  await t.test('a full restored game gallery rolls back both automatic targets, preserving all manual images', async () => {
    const {project: p} = await create();
    for (let i = 0; i < 8; i++) await add(p.id, 170 + i);
    const manual = await presentation(p.id); ok(await patch(p.id, manual.version, {auto_update: true}));
    const game = await presentation(p.id), main = await presentation(p.id, 'main');
    assert.equal((await capture(p.id, 179)).status, 422);
    assert.deepEqual(await presentation(p.id), game); assert.deepEqual(await presentation(p.id, 'main'), main);
    ok(await patch(p.id, game.version, {remove_image_id: game.images[0].id}));
    const reduced = await presentation(p.id); ok(await patch(p.id, reduced.version, {auto_update: true}));
    const captured = ok(await capture(p.id, 180)); assert.equal(captured.project_presentation.images.length, 8);
    const next = ok(await capture(p.id, 181)); assert.equal(next.project_presentation.images.length, 8);
    for (const image of game.images.slice(1)) assert.ok(next.project_presentation.images.some(i => i.id === image.id));
  });
});
