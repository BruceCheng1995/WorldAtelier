/** Independent checks against the actual distributable source bundle.
 * Uses temporary SQLite/source/media directories and the real request router,
 * without a listening port, Agent, Godot process, or fabricated runtime ACK.
 * Browser rendering and canonical game execution are separate checks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync, symlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {gzipSync} from 'node:zlib';
import {CreationService} from '../../services/creation/service.mjs';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {ProjectMedia} from '../../services/creation/project-media.mjs';
import {DefaultProjectBundle, installDefaultProjects, DEFAULT_PROJECT_FORMAT, DEFAULT_CATALOG_FORMAT} from '../../services/creation/default-projects.mjs';
import {nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {hash} from '../../services/creation/schema.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = join(root, 'content/default-projects');
const origin = 'http://127.0.0.1:48921'; // The router is exercised without listening.
const password = 'independent-default-project-test-password';
const names = ['小小梦魇', '俄罗斯方块', '坦克大战', '小巷漫步', '塔防游戏', 'TPS', '植物大战僵尸', '兽人必须死', '贪吃蛇'].sort();
const count = (store, kind) => store.db.prepare('SELECT count(*) AS n FROM documents WHERE kind=?').get(kind).n;
const sourceState = store => [...store.db.prepare("SELECT id, json_extract(body,'$.head') AS head FROM documents WHERE kind='creator_branch' ORDER BY id").iterate()];
const records = store => Array.from(store.db.prepare('SELECT kind,id,body FROM documents ORDER BY kind,id').iterate(), row => [row.kind, row.id, hash(row.body)]);
const status = code => error => error.status === code;

function fixture(t) {
  const data = mkdtempSync(join(tmpdir(), 'wa-defaults-independent-'));
  const store = new CreationStore(join(data, 'creation.sqlite'));
  store.publicPlay = true;
  const native = new NativeProjects({store, data});
  const projectMedia = new ProjectMedia({store, data});
  t.after(async () => { await native.close(); store.close(); rmSync(data, {recursive:true, force:true}); });
  return {data, store, native, projectMedia};
}

function serviceFixture(t, {defaultProjects = true} = {}) {
  const data = mkdtempSync(join(tmpdir(), 'wa-defaults-router-'));
  let service;
  const start = () => {
    const server = createServer();
    const previous = new Map(['WORLD_ATELIER_DISABLE_AGENT', 'WORLD_ATELIER_DISABLE_WORLDS'].map(key => [key, process.env[key]]));
    for (const key of previous.keys()) process.env[key] = '1';
    try { service = new CreationService({server, root, data, origin, publicPlay:true, defaultProjects}); }
    finally { for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value; }
  };
  start();
  t.after(async () => { await service.close(); rmSync(data, {recursive:true, force:true}); });
  const request = async (method, path, auth, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, {method, url:'/creation-api/' + path, socket:{remoteAddress:'127.0.0.1'}, headers:{host:'127.0.0.1:48921', origin, 'content-type':'application/json', ...(auth ? {authorization:'Bearer ' + auth.token} : {})}});
    const res = {headers:{}, setHeader(key, value) { this.headers[key] = value; }, writeHead(code, headers) { this.status = code; Object.assign(this.headers, headers); }, end(bytes) { this.value = bytes ? JSON.parse(String(bytes)) : null; }};
    assert.equal(await service.request(req, res), true, method + ' ' + path);
    return res;
  };
  return {get service() { return service; }, get store() { return service.store; }, data, request, async restart() { await service.close(); start(); }};
}

function writeCatalog(path, catalog) {
  catalog.version = hash({projects:catalog.projects, objects:catalog.objects});
  writeFileSync(join(path, 'catalog.json'), JSON.stringify(catalog));
}

// A small real project makes corruption/transaction cases cheap while retaining
// the exact production transport and native source format.
function subset(t) {
  const bundle = new DefaultProjectBundle(directory);
  const project = structuredClone(bundle.catalog.projects.find(item => item.name === '俄罗斯方块'));
  const keys = new Set(project.cover ? [project.cover.hash] : []);
  for (const branch of project.branches) {
    keys.add(branch.snapshot);
    if (branch.cover) keys.add(branch.cover.hash);
    for (const entry of Object.values(bundle.snapshot(branch).source_files)) keys.add(entry.hash);
  }
  const catalog = {format:DEFAULT_CATALOG_FORMAT, projects:[project], objects:Object.fromEntries([...keys].map(key => [key, structuredClone(bundle.catalog.objects[key])]))};
  const path = mkdtempSync(join(tmpdir(), 'wa-defaults-bundle-'));
  t.after(() => rmSync(path, {recursive:true, force:true}));
  for (const entry of Object.values(catalog.objects)) for (const part of entry.parts) {
    const relative = `objects/${part.hash.slice(0, 2)}/${part.hash}.gzpart`;
    mkdirSync(dirname(join(path, relative)), {recursive:true});
    copyFileSync(join(directory, relative), join(path, relative));
  }
  writeCatalog(path, catalog);
  return {path, catalog, project, bundle};
}

function addObject(path, catalog, bytes, key = hash(bytes)) {
  const compressed = gzipSync(bytes), partHash = hash(compressed);
  const partPath = join(path, `objects/${partHash.slice(0, 2)}/${partHash}.gzpart`);
  mkdirSync(dirname(partPath), {recursive:true}); writeFileSync(partPath, compressed);
  catalog.objects[key] = {size:bytes.length, parts:[{hash:partHash, size:compressed.length}]};
  return key;
}

test('the shipped nine projects open as read-only native projects in a fresh service', {timeout:180000}, async t => {
  const f = serviceFixture(t), bundle = new DefaultProjectBundle(directory);
  assert.equal(f.service.defaultProjects.installed.length, 9);
  assert.deepEqual(f.store.list('creator_project').map(item => item.name).sort(), names);
  assert.equal(count(f.store, 'creator_branch'), 11);
  assert.equal(count(f.store, 'creator_revision'), 11);
  for (const kind of ['creator_user', 'creator_login', 'creator_session', 'creator_message', 'creator_run', 'creator_world', 'creator_build', 'creator_native_game_release', 'creator_native_game_pointer']) assert.equal(count(f.store, kind), 0, kind);

  await t.test('every fixed branch has complete source bytes, its engine index, and portable resource paths', () => {
    for (const project of bundle.catalog.projects) {
      const installed = f.store.get('creator_project', project.id);
      assert.deepEqual(installed.members, {});
      assert.equal(installed.default_project.format, DEFAULT_PROJECT_FORMAT);
      assert.equal(installed.default_project.bundle_version, bundle.catalog.version);
      for (const branch of project.branches) {
        const installedBranch = f.store.get('creator_branch', `${project.id}:${branch.id}`);
        const revision = f.store.get('creator_revision', installedBranch.head), manifest = revision.manifest;
        assert.deepEqual(revision.parents, []);
        assert.equal(revision.actor_id, null);
        assert.equal(manifest.source_identity, branch.source_identity);
        assert.equal(nativeSourceIdentity(manifest.source_files), branch.source_identity);
        assert.equal(manifest.index_source_identity, branch.source_identity);
        f.service.native.archive.verify(manifest.source_files);
        assert.equal(manifest.resources[manifest.entry_scene_id].kind, 'scene');
        for (const resource of Object.values(manifest.resources)) {
          assert.ok(manifest.source_files[resource.path], resource.path);
          assert.equal(resource.project_source_identity, branch.source_identity);
          assert.ok(Array.isArray(resource.native_nodes));
        }
      }
    }
    for (const media of f.store.list('creator_project_media')) {
      assert.ok(bundle.catalog.projects.some(project => project.id === media.project_id));
      assert.equal(hash(readFileSync(join(f.service.projectMedia.directory, media.image_id))), media.image_id);
      assert.equal(media.url, `/creation-api/projects/${media.project_id}/media/${media.image_id}`);
    }
  });

  const first = (await f.request('POST', 'auth/register', null, {name:'First visitor', password})).value;
  const second = (await f.request('POST', 'auth/register', null, {name:'Second visitor', password})).value;
  const project = bundle.catalog.projects.find(item => item.name === '俄罗斯方块');
  const p = project.id, b = 'main', base = `projects/${p}/branches/${b}`;

  await t.test('registered visitors see every example without synthetic accounts or project membership', async () => {
    assert.equal((await f.request('GET', 'bootstrap')).status, 401);
    for (const auth of [first, second]) {
      const response = await f.request('GET', 'bootstrap', auth);
      assert.equal(response.status, 200);
      assert.equal(response.value.projects.length, 9);
      assert.equal(response.value.projects.reduce((n, item) => n + item.branches.length, 0), 11);
      for (const item of response.value.projects) { assert.equal(item.role, 'viewer'); assert.deepEqual(item.members, []); }
    }
    assert.equal(f.store.canCreateProject(first.user), true);
    assert.equal(f.store.canCreateProject(second.user), false);
    const response = await f.request('GET', base, second);
    assert.equal(response.status, 200);
    assert.ok(Object.values(response.value.manifest.resources).some(resource => resource.kind === 'prefab'));
    const playable = await f.request('GET', base + '/playable-game', second);
    assert.equal(playable.status, 200);
    assert.equal(playable.value.source_revision, response.value.head);
    assert.equal(playable.value.resource_id, response.value.manifest.entry_scene_id);
    assert.equal(playable.value.game_build_id, undefined);
    assert.doesNotThrow(() => f.service.builds.authorizeNativePreview(second.user, p, b, response.value.head));
    assert.equal((await f.request('GET', base + '/semantic-resources', second)).status, 200);
    assert.equal((await f.request('GET', base + '/knowledge', second)).status, 200);
    assert.deepEqual((await f.request('GET', base + '/sessions', second)).value.sessions, []);
    assert.equal((await f.request('GET', base + '/native-source', second)).status, 403);
  });

  await t.test('read-only examples deny edits, exports, releases, sessions and unreviewable access requests', async () => {
    const before = sourceState(f.store);
    const calls = [
      ['POST', base + '/transactions', {transaction_id:'deny-edit', base_revision:before.find(row => row.id === `${p}:main`).head, ops:[]}],
      ['POST', `projects/${p}/branches`, {from_branch:'main', branch_id:'unauthorized', name:'Unauthorized'}],
      ['POST', base + '/sessions', {title:'Unauthorized session'}],
      ['POST', base + '/builds', {kind:'source', targets:['source'], request_id:'deny-export'}],
      ['POST', base + '/game-releases', {}],
      ['PATCH', `projects/${p}`, {name:'Unauthorized rename', expected_version:1}],
      ['PATCH', `projects/${p}/presentation`, {expected_version:1, auto_update:true}],
      ['PATCH', `projects/${p}/sharing`, {request_id:'deny-share', expected_version:1, general_access:'members_only'}],
      ['POST', `projects/${p}/access-requests`, {request_id:'deny-request', reason:'Nobody owns this example'}],
    ];
    for (const [method, path, body] of calls) {
      const result = await f.request(method, path, second, body);
      assert.equal(result.status, 403, `${method} ${path}: ${JSON.stringify(result.value)}`);
    }
    const access = await f.request('GET', `projects/${p}/collaboration`, second);
    assert.equal(access.status, 200);
    assert.equal(access.value.capabilities.can_request_edit, false);
    assert.deepEqual(sourceState(f.store), before);
    for (const kind of ['creator_access_request', 'creator_session', 'creator_build', 'creator_native_game_release']) assert.equal(count(f.store, kind), 0, kind);
  });

  await t.test('the first real account can create its own game, without granting everybody edit rights', async () => {
    const manifest = f.store.get('creator_revision', f.store.get('creator_branch', `${p}:main`).head).manifest;
    const own = f.store.createProject(first.user, {name:'First visitor owned game'}, manifest);
    assert.equal(own.project.role, 'owner');
    assert.equal(f.store.canCreateProject(second.user), false);
    assert.throws(() => f.store.createProject(second.user, {name:'Denied'}, manifest), status(403));
    assert.equal(f.store.roleFor(second.user, f.store.get('creator_project', own.project.id)), 'player');
    const ordinary = await f.request('GET', `projects/${own.project.id}/branches/main/playable-game`, second);
    assert.equal(ordinary.status, 422);
    assert.equal(ordinary.value.details.code, 'game_release_unavailable');
    const publicSemantic = await f.request('GET', `projects/${own.project.id}/branches/main/semantic-resources`, second);
    assert.equal(publicSemantic.status, 403);
    f.store.updateProject(first.user, own.project.id, {expected_version:1, archived:true});
    assert.equal(f.store.canCreateProject(first.user), true);
    assert.equal(f.store.canCreateProject(second.user), false);
  });

  await t.test('public-play configuration, project visibility and disabled accounts remain authoritative', async () => {
    f.store.publicPlay = false;
    assert.equal((await f.request('GET', base, second)).status, 403);
    assert.equal((await f.request('GET', 'bootstrap', second)).value.projects.length, 0);
    f.store.publicPlay = true;
    const row = f.store.get('creator_project', p);
    f.store.put('creator_project', {...row, public_play:false});
    assert.equal((await f.request('GET', base + '/playable-game', second)).status, 403);
    f.store.put('creator_project', row);
    const account = f.store.get('creator_user', second.user.id);
    f.store.put('creator_user', {...account, disabled_at:Date.now()});
    assert.equal((await f.request('GET', 'bootstrap', second)).status, 401);
    assert.equal(f.store.roleFor(second.user, row), null);
    f.store.put('creator_user', account);
  });

  await t.test('repeat installation preserves archived/private examples and makes no database writes', () => {
    const row = f.store.get('creator_project', p);
    f.store.put('creator_project', {...row, name:'Locally retained name', public_play:false, archived_at:123456789, permission_version:7});
    const before = records(f.store), heads = sourceState(f.store);
    const report = installDefaultProjects({store:f.store, native:f.service.native, projectMedia:f.service.projectMedia, directory});
    assert.deepEqual(report.installed, []); assert.deepEqual(report.adopted, []);
    assert.equal(report.existing.length, 9);
    assert.deepEqual(records(f.store), before);
    assert.deepEqual(sourceState(f.store), heads);
  });

  await t.test('a real service restart keeps the same installed source and visibility settings', async () => {
    const heads = sourceState(f.store), projectBefore = f.store.get('creator_project', p);
    const revisions = count(f.store, 'creator_revision');
    await f.restart();
    assert.equal(f.service.defaultProjects.existing.length, 9);
    assert.deepEqual(f.service.defaultProjects.installed, []);
    assert.deepEqual(sourceState(f.store), heads);
    assert.deepEqual(f.store.get('creator_project', p), projectBefore);
    assert.equal(count(f.store, 'creator_revision'), revisions);
    const response = await f.request('GET', 'bootstrap', second);
    assert.equal(response.status, 200);
    assert.equal(response.value.projects.some(item => item.id === p), false);
  });
});

test('service construction without opting in does not install distributable projects', async t => {
  const f = serviceFixture(t, {defaultProjects:false});
  assert.equal(count(f.store, 'creator_project'), 0);
  assert.equal(count(f.store, 'creator_revision'), 0);
});

test('matching existing author projects retain ownership, privacy, sessions and source history', async t => {
  const f = fixture(t), s = subset(t);
  installDefaultProjects({...f, directory:s.path});
  const user = f.store.register({name:'Existing author', password}).user;
  const original = f.store.get('creator_project', s.project.id);
  const {default_project, ...authored} = original;
  Object.assign(authored, {name:'Existing author title', members:{[user.id]:'owner'}, public_play:false, permission_version:9});
  f.store.put('creator_project', authored);
  const session = f.store.createSession(user, s.project.id, 'main', {title:'Private author context', visibility:'private'});
  f.store.put('creator_project', {...authored, archived_at:12345});
  const before = records(f.store), heads = sourceState(f.store);
  const report = installDefaultProjects({...f, directory:s.path});
  assert.deepEqual(report.adopted, [s.project.id]); assert.deepEqual(report.installed, []);
  const {default_project:recognized, ...after} = f.store.get('creator_project', s.project.id);
  assert.equal(recognized.format, DEFAULT_PROJECT_FORMAT);
  assert.deepEqual(after, {...authored, archived_at:12345});
  assert.deepEqual(sourceState(f.store), heads);
  assert.deepEqual(f.store.get('creator_session', session.id), session);
  assert.deepEqual(records(f.store).filter(row => row[0] !== 'creator_project'), before.filter(row => row[0] !== 'creator_project'));
});

test('existing IDs with different source and similarly named user projects are never replaced', t => {
  const f = fixture(t), s = subset(t), user = f.store.register({name:'Existing project owner', password}).user;
  const manifest = s.bundle.snapshot(s.project.branches[0]);
  const other = f.store.createProject(user, {name:s.project.name}, manifest);
  f.store.put('creator_project', {id:s.project.id, name:'Unrelated same-ID project', members:{[user.id]:'owner'}, created_at:123});
  // Deliberately conflicting stored identity: this is a rejection fixture,
  // not a manufactured engine result or accepted native revision.
  f.store.put('creator_revision', {id:'src-independent-collision', manifest:{source_identity:'f'.repeat(64)}});
  f.store.put('creator_branch', {id:`${s.project.id}:main`, project_id:s.project.id, branch_id:'main', head:'src-independent-collision'});
  const before = f.store.get('creator_project', s.project.id), own = f.store.get('creator_project', other.project.id);
  const report = installDefaultProjects({...f, directory:s.path});
  assert.deepEqual(report.conflicts, [s.project.id]); assert.deepEqual(report.installed, []);
  assert.deepEqual(f.store.get('creator_project', s.project.id), before);
  assert.deepEqual(f.store.get('creator_project', other.project.id), own);
});

test('a user-created project with the same display name does not prevent installing the actual example', t => {
  const f = fixture(t), s = subset(t), user = f.store.register({name:'Same-name project owner', password}).user;
  const own = f.store.createProject(user, {name:s.project.name}, s.bundle.snapshot(s.project.branches[0]));
  const before = f.store.get('creator_project', own.project.id);
  const report = installDefaultProjects({...f, directory:s.path});
  assert.deepEqual(report.installed, [s.project.id]);
  assert.equal(count(f.store, 'creator_project'), 2);
  assert.deepEqual(f.store.get('creator_project', own.project.id), before);
  assert.deepEqual(f.store.get('creator_project', s.project.id).members, {});
});

test('missing, corrupted, symlinked and invalid native source bundles leave no partial project', async t => {
  for (const mode of ['missing', 'compressed-bytes', 'decoded-bytes', 'symlink', 'source-path', 'private-metadata', 'source-identity']) await t.test(mode, t => {
    const f = fixture(t), s = subset(t), branch = s.project.branches[0];
    const manifest = s.bundle.snapshot(branch);
    const key = manifest.source_files['project.godot'].hash, entry = s.catalog.objects[key];
    const part = entry.parts[0], path = join(s.path, `objects/${part.hash.slice(0, 2)}/${part.hash}.gzpart`);
    if (mode === 'missing') unlinkSync(path);
    if (mode === 'compressed-bytes') { const bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes); }
    if (mode === 'decoded-bytes') {
      const bytes = Buffer.from(s.bundle.readObject(key)); bytes[0] ^= 1;
      addObject(s.path, s.catalog, bytes, key); writeCatalog(s.path, s.catalog);
    }
    if (mode === 'symlink') { unlinkSync(path); const outside = join(f.data, 'outside.gzpart'); writeFileSync(outside, 'outside'); symlinkSync(outside, path); }
    if (mode === 'source-path' || mode === 'private-metadata') {
      if (mode === 'source-path') manifest.source_files['../outside.gd'] = manifest.source_files['project.godot'];
      else manifest.sessions = [{title:'Private information must never be distributed'}];
      branch.snapshot = addObject(s.path, s.catalog, Buffer.from(JSON.stringify(manifest))); writeCatalog(s.path, s.catalog);
    }
    if (mode === 'source-identity') { branch.source_identity = '0'.repeat(64); writeCatalog(s.path, s.catalog); }
    assert.throws(() => installDefaultProjects({...f, directory:s.path}));
    for (const kind of ['creator_project', 'creator_branch', 'creator_revision', 'creator_project_media']) assert.equal(count(f.store, kind), 0, kind);
    assert.equal(existsSync(join(f.data, 'outside.gd')), false);
  });
});

test('an interrupted database transaction cannot expose a project without its complete branches', t => {
  const f = fixture(t), s = subset(t), put = f.store.put.bind(f.store);
  f.store.put = (kind, row) => { if (kind === 'creator_branch') throw Error('Independent injected SQLite write failure'); return put(kind, row); };
  assert.throws(() => installDefaultProjects({...f, directory:s.path}), /Independent injected SQLite write failure/);
  for (const kind of ['creator_project', 'creator_branch', 'creator_revision', 'creator_project_media']) assert.equal(count(f.store, kind), 0, kind);
  f.store.put = put;
  assert.deepEqual(installDefaultProjects({...f, directory:s.path}).installed, [s.project.id]);
  assert.equal(count(f.store, 'creator_branch'), 1);
});
