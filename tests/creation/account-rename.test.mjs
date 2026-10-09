import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {CreationStore} from '../../services/creation/store.mjs';

// Actual isolated HTTP, authenticated WebSocket and persistent SQLite checks.
// Initial administrator and minimal scene are fixtures. No Agent or Godot starts.
const root = resolve(import.meta.dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}

test('account rename: self service, administrator, identity continuity and concurrency', {timeout: process.env.WORLD_ATELIER_ACCOUNT_RENAME_BROWSER_GATE === '1' ? 720000 : 120000}, async t => {
  const port = Number(process.env.WORLD_ATELIER_ACCOUNT_RENAME_TEST_PORT ?? 48921);
  await freePort(port);
  const origin = `http://127.0.0.1:${port}`, directory = mkdtempSync(resolve(tmpdir(), 'wa-account-rename-'));
  const database = resolve(directory, 'creation/creation.sqlite');
  const credentials = {name: 'Administrator', password: 'independent-rename-password'};
  const fixture = new CreationStore(database), admin = fixture.register(credentials);
  fixture.put('creator_admin_settings', {id: 'singleton', owner_user_id: admin.user.id});
  const project = fixture.createProject(admin.user, {name: 'Rename continuity'}, {
    entry_scene_id: 'scene-harbor', resources: {'scene-harbor': {id: 'scene-harbor', name: 'Identity test scene', kind: 'scene', objects: []}},
  }).project;
  fixture.close();
  let child, logs = '';
  const peers = new Set();
  async function stop() {
    for (const peer of peers) peer.ws.terminate();
    peers.clear();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(kill);
    }
    await freePort(port);
  }
  async function start() {
    const env = {...process.env, WORLD_ATELIER_PREVIEW_PORT: String(port), WORLD_ATELIER_PREVIEW_DATA: directory,
      WORLD_ATELIER_CREATION_DATA: resolve(directory, 'creation'), WORLD_ATELIER_DISABLE_AGENT: '1',
      WORLD_ATELIER_DISABLE_WORLDS: '1', WORLD_ATELIER_PUBLIC_PLAY: '1', WORLD_ATELIER_LAN: '0'};
    delete env.WORLD_ATELIER_ADMIN_USER_ID;
    delete env.WORLD_ATELIER_PREVIEW_HOST;
    child = spawn(process.execPath, ['services/preview/server.mjs'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', bytes => logs += bytes);
    child.stderr.on('data', bytes => logs += bytes);
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try {
        const response = await fetch(origin + '/creation-api/health');
        if (response.ok) {
          const health = await response.json();
          assert.equal(health.agent_ready, false);
          assert.equal(health.worlds_ready, false);
          return;
        }
      } catch {}
      await delay(30);
    }
    throw new Error('Isolated rename test service did not start: ' + logs);
  }
  t.after(async () => { try { await stop(); } finally { rmSync(directory, {recursive: true, force: true}); } });
  async function request(method, path, actor, input, extraHeaders = {}) {
    const response = await fetch(origin + '/creation-api' + path, {method, headers: {
      origin, 'content-type': 'application/json', ...(actor ? {authorization: 'Bearer ' + actor.token} : {}), ...extraHeaders,
    }, ...(input === undefined ? {} : {body: JSON.stringify(input)})});
    return {status: response.status, value: await response.json()};
  }
  const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.value)); return response.value; };
  const profile = (actor, name, expected_name, extra = {}) => request('PATCH', '/auth/profile', actor, {name, expected_name, ...extra});
  const detail = async actor => ok(await request('GET', '/admin/users/' + actor.user.id, admin)).item;
  const adminInput = async (actor, name) => ({request_id: randomUUID(), expected_version: (await detail(actor)).version,
    reason: 'Independent account rename test', action: 'rename', value: name});
  const adminPatch = (actor, input, caller = admin) => request('PATCH', '/admin/users/' + actor.user.id, caller, input);
  async function connect(actor, projectId) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws/creation', {origin});
    const peer = {ws, messages: []}; peers.add(peer);
    ws.on('message', bytes => peer.messages.push(JSON.parse(bytes.toString())));
    ws.on('error', () => {});
    await new Promise((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject);});
    peer.packet = async predicate => {
      for (let i = 0; i < 150; i++) {
        const packet = peer.messages.find(predicate);
        if (packet) return packet;
        await delay(20);
      }
      throw new Error('Expected WebSocket packet missing; received ' + peer.messages.map(message => message.type).join(', '));
    };
    ws.send(JSON.stringify({type: 'auth', token: actor.token}));
    await peer.packet(message => message.type === 'authenticated');
    if (projectId) {
      ws.send(JSON.stringify({type: 'subscribe', project_id: projectId, branch_id: 'main', resource_id: 'scene-harbor', generation: 1}));
      await peer.packet(message => message.type === 'baseline');
    }
    return peer;
  }

  await start();
  const user = ok(await request('POST', '/auth/register', null, {name: 'Bruce1', password: credentials.password}), 201);
  const other = ok(await request('POST', '/auth/register', null, {name: 'Other user', password: credentials.password}), 201);
  const projectVersion = ok(await request('GET', '/admin/projects/' + project.id, admin)).item.version;
  ok(await request('PATCH', '/admin/projects/' + project.id, admin, {request_id: randomUUID(), expected_version: projectVersion,
    reason: 'Verify rename broadcast does not cross project access', action: 'public_play', value: false}));
  const invitation = ok(await request('POST', `/projects/${project.id}/invites`, admin, {role: 'editor'}), 201);
  ok(await request('POST', '/invites/join', user, {code: invitation.code}));
  const session = ok(await request('POST', `/projects/${project.id}/branches/main/sessions`, user, {title: 'Retained creator session', draft: 'Retained draft'}), 201);
  const beforeBootstrap = ok(await request('GET', '/bootstrap', user));
  const ownPeer = await connect(user, project.id), memberPeer = await connect(admin, project.id), unrelatedPeer = await connect(other);

  await t.test('self rename retains authenticated identity, membership, session and updates online names', async () => {
    const before = await detail(user);
    const result = ok(await profile(user, '  Coconut  ', 'Bruce1'));
    assert.deepEqual(result.user, {...user.user, name: 'Coconut'});
    const after = ok(await request('GET', '/bootstrap', user));
    assert.equal(after.user.name, 'Coconut');
    assert.equal(after.user.id, user.user.id);
    assert.equal(after.can_create_project, beforeBootstrap.can_create_project);
    assert.equal(after.projects.find(item => item.id === project.id).role, 'editor');
    assert.equal(after.projects.find(item => item.id === project.id).members.find(item => item.id === user.user.id).name, 'Coconut');
    assert.deepEqual(ok(await request('GET', '/sessions/' + session.id, user)), {...session, messages: [], runs: [], goals: []});
    assert.equal((await detail(user)).version, before.version + 1);
    assert.equal((await detail(user)).login_count, before.login_count);
    for (const peer of [ownPeer, memberPeer]) {
      const packet = await peer.packet(message => message.type === 'user_updated' && message.user?.id === user.user.id && message.user.name === 'Coconut');
      assert.deepEqual(packet.user, result.user);
      await peer.packet(message => message.type === 'branch_presence' && message.peers.some(item => item.id === user.user.id && item.name === 'Coconut'));
    }
    assert.equal(unrelatedPeer.messages.some(message => message.type === 'user_updated' && message.user?.id === user.user.id), false);
    assert.equal((await request('POST', '/auth/login', null, {name: 'Bruce1', password: credentials.password})).status, 401);
    assert.equal(ok(await request('POST', '/auth/login', null, {name: 'cOcOnUt', password: credentials.password})).user.id, user.user.id);
    assert.equal((await request('POST', '/auth/login', null, {name: 'Coconut', password: 'incorrect-password'})).status, 401);
  });

  await t.test('validation, normalization, stale names and unauthorized inputs reject without mutation', async () => {
    for (const name of ['', '   ', 'x'.repeat(161), 'Hidden\u200bname', 'Control\nname', 42, null]) assert.equal((await profile(user, name, 'Coconut')).status, 400);
    assert.equal((await request('PATCH', '/auth/profile', user, {name: 'No guard'})).status, 400);
    assert.equal((await profile(user, 'Stale attempt', 'Bruce1')).status, 409);
    assert.equal((await profile(user, 'Other user', 'Coconut')).status, 409);
    assert.equal((await profile(other, 'ＣＯＣＯＮＵＴ', 'Other user')).status, 409);
    assert.equal((await request('POST', '/auth/register', null, {name: 'ＣＯＣＯＮＵＴ', password: credentials.password})).status, 409);
    assert.equal((await profile(null, 'Anonymous', 'Coconut')).status, 401);
    assert.equal((await profile(user, 'Hijack', 'Coconut', {id: other.user.id})).status, 400);
    assert.equal((await request('PATCH', '/auth/profile', user, {name: 'CSRF', expected_name: 'Coconut'}, {origin: 'http://evil.invalid'})).status, 403);
    assert.equal(ok(await request('GET', '/bootstrap', user)).user.name, 'Coconut');
    assert.equal(ok(await request('GET', '/bootstrap', other)).user.name, 'Other user');
    ok(await profile(user, 'coconut', 'Coconut'));
    ok(await profile(user, 'Coconut', 'coconut'));
    ok(await profile(other, 'x'.repeat(160), 'Other user'));
    ok(await profile(other, 'Other user', 'x'.repeat(160)));
  });

  await t.test('admin rename is guarded, audited, idempotent and preserves permissions and login', async () => {
    const input = await adminInput(user, 'Coconut Admin');
    assert.equal((await adminPatch(user, input, other)).status, 403);
    const result = ok(await adminPatch(user, input));
    assert.equal(result.after.name, 'Coconut Admin');
    assert.equal(ok(await adminPatch(user, input)).replayed, true);
    assert.equal((await adminPatch(user, {...input, value: 'Different retry'})).status, 409);
    assert.equal((await adminPatch(user, {...input, request_id: randomUUID(), value: 'Stale version'})).status, 409);
    const audit = ok(await request('GET', '/admin/audit?limit=100', admin)).items.filter(item => item.request_id === input.request_id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].before.name, 'Coconut');
    assert.equal(audit[0].after.name, 'Coconut Admin');
    assert.equal(audit[0].actor_id, admin.user.id);
    assert.equal(ok(await request('GET', '/bootstrap', user)).user.name, 'Coconut Admin');
    assert.equal(ok(await request('GET', '/sessions/' + session.id, user)).owner_user_id, user.user.id);
    assert.equal((await detail(user)).projects.find(item => item.id === project.id).role, 'editor');
    assert.equal((await request('POST', '/auth/login', null, {name: 'Coconut', password: credentials.password})).status, 401);
    assert.equal(ok(await request('POST', '/auth/login', null, {name: 'Coconut Admin', password: credentials.password})).user.id, user.user.id);
    assert.equal((await adminPatch(user, await adminInput(user, 'OTHER USER'))).status, 409);
    const beforeSelfRename = await adminInput(user, 'Stale administrator edit');
    ok(await profile(user, 'Coconut', 'Coconut Admin'));
    assert.equal((await adminPatch(user, beforeSelfRename)).status, 409);
    ok(await adminPatch(admin, await adminInput(admin, 'Renamed administrator')));
    assert.equal(ok(await request('GET', '/bootstrap', admin)).can_admin, true);
  });

  await t.test('racing renames commit only one guarded change or one unique name', async () => {
    const race = await Promise.all(['First rename', 'Second rename'].map(name => profile(user, name, 'Coconut')));
    assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
    const winningName = race.find(result => result.status === 200).value.user.name;
    ok(await profile(user, 'Coconut', winningName));
    const uniqueRace = await Promise.all([profile(user, 'Contested name', 'Coconut'), profile(other, 'CONTESTED NAME', 'Other user')]);
    assert.deepEqual(uniqueRace.map(result => result.status).sort(), [200, 409]);
    if (uniqueRace[0].status === 200) ok(await profile(user, 'Coconut', 'Contested name'));
    else ok(await profile(other, 'Other user', 'CONTESTED NAME'));
  });

  await t.test('disabled users cannot rename themselves; admin can rename and restore them', async () => {
    const input = await adminInput(other, 'Unused');
    ok(await adminPatch(other, {...input, action: 'status', value: 'disabled'}));
    assert.equal((await profile(other, 'Forbidden rename', 'Other user')).status, 401);
    ok(await adminPatch(other, await adminInput(other, 'Disabled renamed')));
    assert.equal((await detail(other)).status, 'disabled');
    assert.equal((await request('POST', '/auth/login', null, {name: 'Disabled renamed', password: credentials.password})).status, 403);
    const restore = await adminInput(other, 'Unused');
    ok(await adminPatch(other, {...restore, action: 'status', value: 'active'}));
    assert.equal(ok(await request('POST', '/auth/login', null, {name: 'Disabled renamed', password: credentials.password})).user.id, other.user.id);
  });

  await t.test('renamed identity, admin authority and original creator session survive service restart', async () => {
    await stop();
    await start();
    assert.equal(ok(await request('GET', '/bootstrap', user)).user.name, 'Coconut');
    assert.equal(ok(await request('GET', '/bootstrap', admin)).can_admin, true);
    assert.equal(ok(await request('GET', '/bootstrap', admin)).user.name, 'Renamed administrator');
    assert.equal(ok(await request('GET', '/sessions/' + session.id, user)).owner_user_id, user.user.id);
    assert.equal(ok(await request('POST', '/auth/login', null, {name: 'Coconut', password: credentials.password})).user.id, user.user.id);
  });
  if (process.env.WORLD_ATELIER_ACCOUNT_RENAME_BROWSER_GATE === '1') {
    const gate = resolve(directory, 'browser-complete.json'), setup = resolve(directory, 'browser-setup.json');
    writeFileSync(setup, JSON.stringify({origin, gate, user: {name: 'Coconut', password: credentials.password},
      admin: {name: 'Renamed administrator', password: credentials.password}, project_id: project.id}), {mode: 0o600});
    console.log('ACCOUNT_RENAME_BROWSER_READY ' + setup);
    for (let i = 0; i < 600 && !existsSync(gate); i++) await delay(1000);
    assert.ok(existsSync(gate), 'Independent browser check was not released');
  }
});
