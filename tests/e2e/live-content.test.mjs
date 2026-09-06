import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, appendFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Independent protocol probes. They never connect to /host or manufacture a
// Godot authority response. Their loaded messages are NOT rendering evidence.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 48921;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = join(ROOT, 'services/control-plane/server.mjs');
const BUILD_TIMEOUT = Number(process.env.WORLD_ATELIER_E2E_BUILD_TIMEOUT_MS ?? 180_000);
const execFileAsync = promisify(execFile);
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const clone = value => structuredClone(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const terminalBuild = new Set(['passed', 'failed', 'superseded']);

function safeText(value) {
  return String(value)
    .replace(/(--host-key=)[^\s]+/g, '$1[redacted]')
    .replace(/([?&]ticket=)[^&\s]+/g, '$1[redacted]')
    .replace(/("(?:token|ticket|host_key)"\s*:\s*")[^"]+/g, '$1[redacted]');
}

async function until(label, fn, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await pause(60);
  }
  throw new Error(`Timed out: ${label} (${timeout} ms)`);
}

async function api(path, { account, method = 'GET', body, status, timeout = 35_000, idempotencyKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (account) headers.Authorization = `Bearer ${account.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = idempotencyKey ?? randomUUID();
  const response = await fetch(new URL(path, BASE), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${method} ${path}: expected JSON, got ${response.status}: ${safeText(text.slice(0, 400))}`); }
  const accepted = status === undefined ? response.ok : (Array.isArray(status) ? status.includes(response.status) : response.status === status);
  assert.ok(accepted, `${method} ${path}: HTTP ${response.status}: ${safeText(JSON.stringify(data).slice(0, 2200))}`);
  return { status: response.status, data };
}

async function processList() {
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=', '-o', 'ppid=', '-o', 'command='], { maxBuffer: 4_000_000 });
  return stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function descendants(list, parentPid) {
  const owned = new Set([parentPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of list) if (owned.has(item.ppid) && !owned.has(item.pid)) { owned.add(item.pid); changed = true; }
  }
  return list.filter(item => item.pid !== parentPid && owned.has(item.pid));
}

async function assertAuthority(serverPid, worldId, release) {
  assert.match(release.runtime_hash, /^[a-f0-9]{64}$/);
  assert.equal(typeof release.authority_binary, 'string', 'Release must name its immutable exported authority.');
  const releaseDirectory = join(ROOT, '.local/artifacts', release.runtime_hash);
  const executable = resolve(releaseDirectory, release.authority_binary);
  assert.ok(executable.startsWith(releaseDirectory + '/'), 'Authority executable must belong to the pinned release directory.');
  const found = await until(`real Godot authority process for ${worldId}`, async () => {
    return descendants(await processList(), serverPid).find(item =>
      item.command.startsWith(executable + ' ') &&
      /(?:^|\s)--role=authority(?:\s|$)/.test(item.command) &&
      item.command.split(/\s+/).includes(`--world=${worldId}`));
  });
  // Never expose host-key command-line arguments in diagnostics.
  return { pid: found.pid, parent_pid: found.ppid, world_id: worldId, executable, runtime_hash: release.runtime_hash };
}

class Service {
  constructor(directory) { this.directory = directory; this.data = join(directory, 'data'); this.children = []; }
  async start() {
    assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Run this driver with Node >= 24 (the server uses node:sqlite).');
    await access(SERVER).catch(() => { throw new Error(`Missing real service entry: ${SERVER}; E2E is not ready.`); });
    await access(join(ROOT, 'content/world.json')).catch(() => { throw new Error('Missing authored content/world.json; integrate the Godot worker before E2E.'); });
    await mkdir(this.data, { recursive: true });
    await new Promise((resolvePort, reject) => {
      const check = createServer();
      check.once('error', () => reject(new Error(`Port ${PORT} is already occupied; refusing to attach to or stop another service.`)));
      check.listen(PORT, '127.0.0.1', () => check.close(resolvePort));
    });
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: { ...process.env, WORLD_ATELIER_PORT: String(PORT), WORLD_ATELIER_DATA: this.data },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    this.child = child;
    this.children.push({ pid: child.pid, started_at: Date.now() });
    this.logTail = '';
    const log = chunk => {
      const clean = safeText(chunk.toString());
      this.logTail = (this.logTail + clean).slice(-10_000);
      this.logWrites = (this.logWrites ?? Promise.resolve()).then(() => appendFile(join(this.directory, 'server.log'), clean));
    };
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.on('error', error => { this.spawnError = error; });
    this.exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
    await until('isolated control service /health', async () => {
      if (this.spawnError) throw this.spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Service exited before ready: ${this.logTail}`);
      try {
        const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(600) });
        const health = await response.json();
        return response.ok && health.ok === true && health.version === '0.1.0' ? health : null;
      } catch { return null; }
    }, 30_000);
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stopped = await Promise.race([this.exited.then(() => true), pause(5_000).then(() => false)]);
      if (!stopped) {
        // Only our separately created process group, never a port-wide kill.
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await this.exited;
      }
    }
    await this.logWrites;
    this.child = null;
    this.spawnError = null;
  }
}

class ProtocolClient {
  constructor(label) {
    this.label = label; this.records = []; this.counter = 0; this.active = false;
    this.autoSnapshotAck = true;
    this.state = null; this.content = null; this.knownReleases = new Set();
  }
  async connect(prepared) {
    const url = new URL(prepared.server_url); url.pathname = '/play';
    assert.equal(url.hostname, '127.0.0.1', 'Probe must use the isolated localhost server.');
    assert.equal(Number(url.port), PORT, 'Probe must not connect to the normal server port.');
    this.socket = new WebSocket(url);
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      this.records.push({ index: ++this.counter, message });
      if (this.records.length > 1500) this.records.shift();
      if (message.type === 'welcome') {
        this.welcome = message; this.user_id = message.user_id; this.world_id = message.world_id;
        this.epoch = message.epoch; this.release_id = message.release_id;
        this.control_generation = message.control_generation; this.content = clone(message.content);
        this.state = message.state; this.knownReleases.add(message.release_id);
      }
      if (message.type === 'active') {
        this.active = true;
        for (const field of ['epoch', 'release_id', 'control_generation']) if (message[field] !== undefined) this[field] = message[field];
      }
      if (message.type === 'snapshot') {
        this.state = message.state; this.latestSnapshot = message;
        if (this.autoSnapshotAck && this.socket.readyState === WebSocket.OPEN) this.acknowledgeSnapshot(message);
      }
      if (message.type === 'content') {
        this.active = false; this.content = clone(message.content); this.pending_release = message.release_id;
        this.knownReleases.add(message.release_id);
      }
      if (message.type === 'revoked') this.active = false;
    });
    this.socket.on('error', error => { this.socketError = error.message; });
    await until(`${this.label} socket open`, () => {
      if (this.socketError) throw new Error(this.socketError);
      return this.socket.readyState === WebSocket.OPEN;
    });
    this.send({ type: 'hello', ticket: prepared.ticket, snapshot_ack: true });
    return this.wait(message => message.type === 'welcome', 0);
  }
  send(message) { assert.equal(this.socket.readyState, WebSocket.OPEN, `${this.label} socket is not open`); this.socket.send(JSON.stringify(message)); }
  acknowledgeSnapshot(packet) {
    assert.equal(packet.type, 'snapshot'); assert.ok(Number.isSafeInteger(packet.sequence));
    this.send({ type: 'snapshot_ack', sequence: packet.sequence, release_id: packet.release_id, epoch: packet.epoch });
  }
  async wait(predicate, after = 0, timeout = 15_000) {
    return until(`${this.label}: expected WebSocket message after ${after}`, () => {
      const record = this.records.find(item => item.index > after && predicate(item.message));
      if (record) return record.message;
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`${this.label}: socket closed before expected message (${this.socketError ?? 'no socket error'})`);
      return null;
    }, timeout);
  }
  async loaded(releaseId = this.welcome.release_id) {
    assert.ok(this.knownReleases.has(releaseId), 'A protocol probe cannot acknowledge content it never received.');
    assert.equal(this.content?.schema, 1, 'Content must be decoded before protocol loaded acknowledgement.');
    assert.ok(Array.isArray(this.content.objects));
    const after = this.counter;
    this.send({ type: 'loaded', release_id: releaseId });
    return this.wait(message => message.type === 'active' && message.release_id === releaseId, after);
  }
  async command(action, payload = {}, overrides = {}) {
    const after = this.counter;
    const request = { type: 'command', request_id: randomUUID(), epoch: this.epoch, release_id: this.release_id,
      control_generation: this.control_generation, action, payload, ...overrides };
    this.send(request);
    return this.wait(message => (message.type === 'ack' && message.request_id === request.request_id) || message.type === 'error', after);
  }
  async snapshot(predicate = () => true, timeout = 15_000) {
    return until(`${this.label}: authoritative snapshot`, () => this.latestSnapshot && predicate(this.latestSnapshot) ? clone(this.latestSnapshot) : null, timeout);
  }
  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    const ended = new Promise(resolveClose => this.socket.once('close', resolveClose));
    this.socket.close();
    await Promise.race([ended, pause(1000)]);
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

function rejected(response, label) {
  assert.ok(response.type === 'error' || (response.type === 'ack' && response.ok === false), `${label}: expected rejection, received ${safeText(JSON.stringify(response))}`);
}

async function project(account, projectId) { return (await api(`/api/projects/${projectId}`, { account })).data; }
async function content(account, projectId, branch = 'main') { return (await api(`/api/projects/${projectId}/branches/${branch}/content`, { account })).data; }
async function world(account, worldId) { return (await api(`/api/worlds/${worldId}`, { account })).data.world; }
async function commit(account, projectId, branch, base, changed, message = 'Independent E2E content edit') {
  return (await api(`/api/projects/${projectId}/branches/${branch}/commit`, { account, method: 'POST', body: { base_revision: base, content: changed, message } })).data;
}
async function build(account, projectId, branch, expected = 'passed') {
  const created = (await api(`/api/projects/${projectId}/branches/${branch}/build`, { account, method: 'POST', body: {} })).data.build;
  assert.ok(created?.id, 'Build response must identify the real asynchronous job.');
  const result = await until(`build ${created.id} reaches a terminal status`, async () => {
    const item = (await project(account, projectId)).builds.find(value => value.id === created.id);
    return item && terminalBuild.has(item.status) ? item : null;
  }, BUILD_TIMEOUT);
  assert.equal(result.status, expected, `Build ${created.id}: ${result.error ?? ''}\n${safeText(String(result.log ?? '').slice(-3500))}`);
  if (expected === 'passed') {
    assert.match(String(result.log), /CONTENT_VALIDATED/, 'A successful build must include the actual Godot validator result.');
    const release = (await project(account, projectId)).releases.find(value => value.id === result.release_id);
    assert.equal(release?.status, 'ready');
    assert.equal(release.revision, result.revision);
    assert.match(release.runtime_hash, /^[a-f0-9]{64}$/);
    assert.match(release.content_hash, /^[a-f0-9]{64}$/);
    return { build: result, release };
  }
  assert.ok(result.error, 'Failed build must retain its actual error.');
  return { build: result };
}

async function checkout(account, projectId, worldId, branch = 'main') {
  const fixed = (await api(`/api/projects/${projectId}/checkouts`, { account, method: 'POST', body: { branch, platform: 'web', mode: 'join-live', world_id: worldId } })).data;
  const prepared = (await api(`/api/checkouts/${fixed.checkout.id}/prepare-join`, { account, method: 'POST', body: {} })).data;
  assert.equal(prepared.release_id, fixed.release.id);
  assert.equal(prepared.world_id, worldId);
  assert.match(prepared.game_url, /\/artifacts\/[a-f0-9]{64}\/web\/index\.html\?/);
  return { fixed, prepared };
}

async function verifyArtifact(artifact) {
  assert.ok(artifact.bytes > 0, 'Export artifact must be nonempty.');
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  const url = new URL(artifact.url, BASE);
  assert.equal(url.origin, BASE, 'Do not download artifacts from another environment.');
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, `Missing export artifact: ${url.pathname}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, artifact.bytes, `Artifact size mismatch: ${artifact.path}`);
  assert.equal(sha256(bytes), artifact.sha256, `Artifact hash mismatch: ${artifact.path}`);
  assert.match(response.headers.get('cache-control') ?? '', /immutable/);
  return { platform: artifact.platform, path: artifact.path, bytes: bytes.length, sha256: artifact.sha256 };
}

async function movementPerTick(client, direction = 1) {
  const pending = [];
  const sendMove = () => { const command = client.command('move', { x: direction, z: 0 }); pending.push(command); return command; };
  const first = await sendMove(); assert.equal(first.ok, true, JSON.stringify(first));
  const previous = client.latestSnapshot?.state.tick ?? -1;
  let timer;
  try {
    timer = setInterval(() => { sendMove().catch(() => {}); }, 100);
    const start = await client.snapshot(s => s.state.tick > previous && s.state.players[client.user_id]);
    const end = await client.snapshot(s => s.state.tick >= start.state.tick + 18);
    const a = start.state.players[client.user_id], b = end.state.players[client.user_id];
    const distance = Math.hypot(b.x - a.x, b.z - a.z);
    assert.ok(distance > 0.5, 'Normal input must move the real authoritative player.');
    return { distance, ticks: end.state.tick - start.state.tick, per_tick: distance / (end.state.tick - start.state.tick) };
  } finally {
    clearInterval(timer);
    const answers = await Promise.all(pending);
    for (const answer of answers) assert.equal(answer.ok, true, JSON.stringify(answer));
    const stopped = await client.command('move', { x: 0, z: 0 });
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
  }
}

function invalidMeshGlb() {
  // Valid GLB v2 container and JSON, but mesh POSITION references an absent
  // accessor. HTTP/header validation must accept it; Godot GLTF must reject it.
  const document = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 999 } }] }], accessors: [], buffers: [], bufferViews: [] };
  const json = Buffer.from(JSON.stringify(document));
  const chunk = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(chunk);
  const header = Buffer.alloc(20);
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + chunk.length, 8);
  header.writeUInt32LE(chunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, chunk]);
}

const GOOD_BEHAVIOR = `extends RefCounted
func evaluate(context: Dictionary) -> Dictionary:
	var factor = 1.0
	if int(context.get("player_count", 0)) >= 2:
		factor = 1.5
	return {"player_speed": float(context.get("rules", {}).get("player_speed", 8.0)) * factor}
`;
const COMPILE_ERROR_BEHAVIOR = `extends RefCounted
func evaluate(context: Dictionary) -> Dictionary:
	return {"player_speed": }
`;
const IMMEDIATE_ERROR_BEHAVIOR = `extends RefCounted
func evaluate(context: Dictionary) -> Dictionary:
	var absent = {}
	return {"player_speed": absent["missing"]}
`;
const LATE_ERROR_BEHAVIOR = `extends RefCounted
func evaluate(context: Dictionary) -> Dictionary:
	if context.get("action", "") == "attack":
		var absent = {}
		return {"player_speed": absent["missing"]}
	return {"player_speed": 16.0}
`;

test('real uploaded GLB and behavior modules, isolated authority hot apply and rollback', { timeout: 12 * 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-atelier-live-content-e2e-'));
  const service = new Service(directory), probes = [];
  const context = { accounts: {}, evidence: { kind: 'independent-live-content-protocol-e2e', directory,
    rendered_client_evidence: false, agent_execution: false, phases: [], assets: [], applications: [] } };
  t.diagnostic(`Isolated live-content data and logs: ${directory}`);
  const phase = async (name, fn) => {
    let failed;
    await t.test(name, async () => {
      const started = Date.now();
      try { await fn(); context.evidence.phases.push({ name, status: 'passed', elapsed_ms: Date.now() - started }); }
      catch (error) { failed = error; context.evidence.phases.push({ name, status: 'failed', error: safeText(error.message) }); throw error; }
    });
    if (failed) throw new Error(`Dependent live-content phases stopped after: ${name}`, { cause: failed });
  };
  const upload = async (name, mime, bytes) => {
    const asset = (await api(`/api/projects/${context.projectId}/assets`, { account: context.accounts.owner, method: 'POST',
      body: { name, mime, data_base64: bytes.toString('base64') }, status: 201 })).data.asset;
    assert.equal(asset.hash, sha256(bytes)); assert.equal(asset.bytes, bytes.length); assert.equal(asset.mime, mime);
    const returned = (await api(`/api/projects/${context.projectId}/assets/${asset.hash}`, { account: context.accounts.owner })).data;
    assert.equal(sha256(Buffer.from(returned.data_base64, 'base64')), asset.hash, 'Stored project asset must round-trip exactly.');
    context.evidence.assets.push({ name, mime, hash: asset.hash, bytes: asset.bytes });
    return asset;
  };
  const commitDocument = async (document, message) => {
    const current = await content(context.accounts.owner, context.projectId);
    return commit(context.accounts.owner, context.projectId, 'main', current.revision, document, message);
  };
  const healthy = async release => {
    const value = await world(context.accounts.owner, context.worldId);
    assert.equal(value.status, 'running'); assert.equal(value.release_id, release.id);
    assert.equal(value.epoch, context.epoch);
    for (const [id, progress] of Object.entries(context.progress)) {
      const player = value.state.players[id]; assert.ok(player, 'Actor identity must survive content changes.');
      for (const [key, expected] of Object.entries(progress)) assert.equal(player[key], expected, `Preserved player ${key}`);
    }
    assert.equal(value.state.objects.landing_crystal_0.collected, true);
    assert.equal((await assertAuthority(service.child.pid, context.worldId, release)).pid, context.authority.pid);
    return value;
  };
  const applyRelease = async release => {
    const owner = context.accounts.owner, cursors = probes.map(peer => peer.counter);
    let applyFailure;
    const pending = api(`/api/worlds/${context.worldId}/apply-latest`, { account: owner, method: 'POST', body: {}, timeout: 40_000 })
      .catch(error => { applyFailure = error; return null; });
    for (let index = 0; index < probes.length; index++) {
      const peer = probes[index];
      await until(`actual content ${release.id} arrives at ${peer.label}`, () => {
        if (applyFailure) throw applyFailure;
        return peer.records.find(record => record.index > cursors[index] && record.message.type === 'content' && record.message.release_id === release.id);
      });
      await peer.loaded(release.id);
    }
    const response = await pending; if (applyFailure) throw applyFailure;
    assert.equal(response.data.ok, true); assert.ok(response.data.sequence > 0);
    const value = await healthy(release);
    context.evidence.applications.push({ release_id: release.id, sequence: response.data.sequence, authority_pid: context.authority.pid, tick: value.state.tick });
    return value;
  };
  const verifyMaterialized = async (release, expectedAssets) => {
    const response = await fetch(new URL(release.content_url, BASE), { headers: { Authorization: `Bearer ${context.accounts.owner.token}` }, signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(sha256(bytes), release.content_hash);
    const document = JSON.parse(bytes.toString('utf8'));
    for (const asset of expectedAssets) {
      const blob = document.asset_blobs?.[asset.hash]; assert.ok(blob, 'Release must deliver the actual referenced asset bytes.');
      assert.equal(blob.mime, asset.mime); assert.equal(sha256(Buffer.from(blob.data_base64, 'base64')), asset.hash);
    }
    return document;
  };
  const rejectsBehavior = async (name, source, pattern) => {
    const asset = await upload(name, 'text/x-gdscript', Buffer.from(source));
    const changed = clone(context.goodSource); changed.behaviors = [{ id: 'expedition_rules', asset_hash: asset.hash, api: 1 }];
    await commitDocument(changed, `Intentional ${name} candidate`);
    const result = await build(context.accounts.owner, context.projectId, 'main', 'failed');
    assert.match(result.build.error, /Godot rejected candidate/, 'This case must reach the actual exported Godot validator.');
    assert.match(result.build.error, pattern);
    const metadata = await project(context.accounts.owner, context.projectId);
    assert.equal(metadata.branches.find(branch => branch.name === 'main').playable_head, context.goodRelease.id);
    const current = await healthy(context.goodRelease);
    assert.deepEqual(current.state.module_assets, [context.goodBehavior.hash]);
    await context.a.snapshot(snapshot => snapshot.state.tick > current.state.tick + 3);
    context.evidence[name] = { build_id: result.build.id, source_hash: asset.hash, error: safeText(result.build.error) };
  };
  try {
    await phase('real exported authority and two protocol peers establish preserved gameplay baseline', async () => {
      await service.start();
      const suffix = randomUUID().slice(0, 8);
      for (const role of ['owner', 'peer', 'outsider']) {
        const name = `live_${role}_${suffix}`, password = `Test-${randomUUID()}`;
        context.accounts[role] = (await api('/api/auth/register', { method: 'POST', body: { name, password }, status: 201 })).data;
      }
      const { owner, peer } = context.accounts;
      context.projectId = (await api('/api/projects', { account: owner, method: 'POST', body: { name: `Live content ${suffix}` } })).data.project.id;
      await api(`/api/projects/${context.projectId}/members`, { account: owner, method: 'POST', body: { name: peer.user.name, role: 'tester' } });
      const source = await content(owner, context.projectId); context.baseSource = clone(source.content);
      context.baseSource.behaviors = []; context.baseSource.rules.player_speed = 8;
      await commitDocument(context.baseSource, 'Explicit live-content baseline without behavior modules');
      const initial = await build(owner, context.projectId, 'main'); context.baseRelease = initial.release;
      context.worldId = (await api(`/api/projects/${context.projectId}/worlds`, { account: owner, method: 'POST', body: { branch: 'main', name: 'Independent live-content world' } })).data.world.id;
      context.authority = await assertAuthority(service.child.pid, context.worldId, initial.release);
      context.evidence.authority = context.authority;
      for (const [label, account] of [['owner', owner], ['peer', peer]]) {
        const prepared = await checkout(account, context.projectId, context.worldId);
        const probe = new ProtocolClient(`live content ${label}`); probes.push(probe);
        await probe.connect(prepared.prepared); await probe.loaded();
      }
      [context.a, context.b] = probes;
      const baseline = await context.a.snapshot(value => value.state.players[owner.user.id] && value.state.players[peer.user.id]);
      context.epoch = baseline.epoch;
      assert.equal((await context.a.command('interact', { object_id: 'landing_crystal_0' })).ok, true);
      const shared = await context.b.snapshot(value => value.state.objects.landing_crystal_0?.collected === true);
      context.progress = {};
      for (const account of [owner, peer]) {
        const player = shared.state.players[account.user.id];
        context.progress[account.user.id] = { crystals: player.crystals, collected: player.collected, kills: player.kills, level: player.level };
      }
      context.speedBefore = await movementPerTick(context.a, 1);
      context.evidence.baseline = { release_id: initial.release.id, epoch: context.epoch, movement: context.speedBefore, progress: context.progress };
    });

    await phase('uploaded real GLB is project-scoped, materialized, validated and applied by the same authority', async () => {
      const owner = context.accounts.owner;
      const bytes = await readFile(join(ROOT, 'runtimes/godot/assets/explorer.glb'));
      context.model = await upload('explorer.glb', 'model/gltf-binary', bytes);
      await api(`/api/projects/${context.projectId}/assets/${context.model.hash}`, { account: context.accounts.outsider, status: 403 });
      const assets = (await api(`/api/projects/${context.projectId}/assets`, { account: owner })).data.assets;
      assert.ok(assets.some(asset => asset.hash === context.model.hash));
      const changed = clone(context.baseSource); context.modelObject = 'launch_beacon';
      assert.ok(changed.objects.some(object => object.id === context.modelObject));
      changed.objects.find(object => object.id === context.modelObject).model_asset = context.model.hash;
      await commitDocument(changed, 'Bind the actual uploaded GLB to a stable object');
      const result = await build(owner, context.projectId, 'main'); context.modelRelease = result.release; context.modelSource = changed;
      await verifyMaterialized(result.release, [context.model]);
      await applyRelease(result.release);
      assert.equal(context.b.content.objects.find(object => object.id === context.modelObject).model_asset, context.model.hash);
      assert.equal(sha256(Buffer.from(context.b.content.asset_blobs[context.model.hash].data_base64, 'base64')), context.model.hash);
      context.evidence.model_binding = { object_id: context.modelObject, asset_hash: context.model.hash, release_id: result.release.id, rendered: false };
    });

    await phase('valid-container but corrupt GLB reaches Godot parser rejection and preserves the live release', async () => {
      const bad = await upload('invalid-mesh-accessor.glb', 'model/gltf-binary', invalidMeshGlb());
      const changed = clone(context.modelSource); changed.objects.find(object => object.id === context.modelObject).model_asset = bad.hash;
      await commitDocument(changed, 'Intentional GLTF mesh accessor failure');
      const rejectedBuild = await build(context.accounts.owner, context.projectId, 'main', 'failed');
      assert.match(rejectedBuild.build.error, /Godot rejected candidate/);
      assert.match(rejectedBuild.build.error, /GLB parse failed/);
      const metadata = await project(context.accounts.owner, context.projectId);
      assert.equal(metadata.branches.find(branch => branch.name === 'main').playable_head, context.modelRelease.id);
      const current = await healthy(context.modelRelease);
      await context.a.snapshot(snapshot => snapshot.state.tick > current.state.tick + 3);
      context.evidence.bad_glb = { hash: bad.hash, build_id: rejectedBuild.build.id, error: safeText(rejectedBuild.build.error) };
    });

    await phase('uploaded conditional GDScript changes actual movement while base content rules and progress stay fixed', async () => {
      context.goodBehavior = await upload('cooperative-speed.gd', 'text/x-gdscript', Buffer.from(GOOD_BEHAVIOR));
      const changed = clone(context.modelSource); changed.behaviors = [{ id: 'expedition_rules', asset_hash: context.goodBehavior.hash, api: 1 }];
      await commitDocument(changed, 'Actual source module: faster movement with two online players');
      const result = await build(context.accounts.owner, context.projectId, 'main'); context.goodRelease = result.release; context.goodSource = changed;
      const materialized = await verifyMaterialized(result.release, [context.model, context.goodBehavior]);
      assert.equal(materialized.rules.player_speed, context.baseSource.rules.player_speed, 'Changed speed must come from uploaded behavior, not a parameter edit.');
      await applyRelease(result.release);
      const active = await context.a.snapshot(value => value.state.module_assets?.includes(context.goodBehavior.hash) && value.state.effective_rules?.player_speed === 12);
      const movement = await movementPerTick(context.a, -1), ratio = movement.per_tick / context.speedBefore.per_tick;
      assert.ok(ratio > 1.3 && ratio < 1.7, `Unexpected real behavior movement ratio: ${ratio}`);
      context.evidence.behavior = { source_hash: context.goodBehavior.hash, release_id: result.release.id, active_hashes: active.state.module_assets,
        base_speed: materialized.rules.player_speed, effective_speed: active.state.effective_rules.player_speed, movement, ratio };
    });

    await phase('GDScript syntax error is rejected by actual compilation before promotion', async () => {
      await rejectsBehavior('compile_error', COMPILE_ERROR_BEHAVIOR, /behavior compilation rejected|Parse Error/);
    });

    await phase('invalid GDScript evaluation output during preparation is rejected without replacing old state', async () => {
      await rejectsBehavior('preparation_execution_error', IMMEDIATE_ERROR_BEHAVIOR, /behavior execution rejected|invalid behavior output/);
    });

    await phase('late invalid script output quarantines the bad release and restores full prior content through real host ACK', async () => {
      const asset = await upload('late-attack-fault.gd', 'text/x-gdscript', Buffer.from(LATE_ERROR_BEHAVIOR));
      const changed = clone(context.goodSource); changed.behaviors = [{ id: 'expedition_rules', asset_hash: asset.hash, api: 1 }];
      await commitDocument(changed, 'Explicit delayed-fault fixture: fail only on a normal attack');
      const candidate = await build(context.accounts.owner, context.projectId, 'main');
      await applyRelease(candidate.release);
      await context.a.snapshot(value => value.state.module_assets?.includes(asset.hash) && value.state.effective_rules?.player_speed === 16);
      const before = await world(context.accounts.owner, context.worldId), cursors = probes.map(peer => peer.counter);
      const attack = await context.a.command('attack');
      context.evidence.late_fault_trigger = { source_hash: asset.hash, release_id: candidate.release.id, response: attack, tick_before: before.state.tick };
      const recovered = await until('central quarantines and fully rolls back the bad runtime release', async () => {
        const value = await world(context.accounts.owner, context.worldId);
        if (value.health === 'degraded' || value.status === 'failed') throw new Error(`Real runtime recovery failed: ${safeText(JSON.stringify({ health: value.health, error: value.error, recovery_error: value.recovery_error }))}`);
        return value.health === 'recovered' && value.release_id === context.goodRelease.id ? value : null;
      }, 25_000);
      for (let index = 0; index < probes.length; index++) {
        const peer = probes[index];
        await peer.wait(message => message.type === 'content' && message.release_id === context.goodRelease.id, cursors[index]);
        assert.equal(peer.active, false, 'Rolled-back content must be acknowledged before restoring gameplay control.');
        await peer.loaded(context.goodRelease.id);
      }
      const metadata = await project(context.accounts.owner, context.projectId);
      assert.equal(metadata.releases.find(release => release.id === candidate.release.id).status, 'quarantined');
      assert.equal(metadata.branches.find(branch => branch.name === 'main').playable_head, context.goodRelease.id);
      const rollback = metadata.activity.find(event => event.kind === 'runtime_rollback' && event.failed_release === candidate.release.id);
      assert.ok(Number.isSafeInteger(rollback?.activity_sequence), 'Activity stream must identify its own separate sequence domain.');
      assert.ok(Number.isSafeInteger(attack.sequence) && Number.isSafeInteger(rollback?.world_sequence) && rollback.world_sequence > attack.sequence,
        `Rollback must confirm a real authority watermark beyond the triggering command; activity sequence is not that watermark: ${JSON.stringify({ attack_sequence: attack.sequence, rollback })}`);
      assert.equal(recovered.failed_release, candidate.release.id);
      const state = await healthy(context.goodRelease);
      assert.deepEqual(state.state.module_assets, [context.goodBehavior.hash]);
      assert.equal(state.state.effective_rules.player_speed, 12);
      for (const id of Object.keys(context.progress)) {
        assert.ok(Math.hypot(state.state.players[id].x - before.state.players[id].x, state.state.players[id].z - before.state.players[id].z) < 0.01, 'Fault recovery must retain the stationary actor position.');
      }
      const movement = await movementPerTick(context.a, 1);
      assert.ok(movement.per_tick / context.speedBefore.per_tick > 1.3 && movement.per_tick / context.speedBefore.per_tick < 1.7);
      context.evidence.runtime_rollback = { failed_release: candidate.release.id, restored_release: state.release_id, health: recovered.health,
        world_sequence: rollback.world_sequence, activity_sequence: rollback.activity_sequence, authority_pid: context.authority.pid, epoch: state.epoch, active_hashes: state.state.module_assets,
        effective_rules: state.state.effective_rules, fault_event: metadata.activity.find(event => event.kind === 'runtime_fault'), movement };
    });
  } finally {
    await Promise.allSettled(probes.map(peer => peer.close()));
    await service.stop(); context.evidence.server_launches = service.children;
    await appendFile(join(directory, 'observations.json'), JSON.stringify(context.evidence, null, 2));
    t.diagnostic(`Live-content observations: ${directory}/observations.json. Protocol peers are not rendered Godot clients; this is not Web/native visual, arbitrary-code sandbox, complete offline or cross-branch acceptance.`);
  }
});
