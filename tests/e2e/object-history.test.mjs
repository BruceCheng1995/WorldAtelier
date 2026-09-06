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
import { DatabaseSync } from 'node:sqlite';

// Independent protocol probes. They never connect to /host or manufacture a
// Godot authority response. Their loaded messages are NOT rendering evidence.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 48921;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = join(ROOT, 'services/control-plane/server.mjs');
const BUILD_TIMEOUT = Number(process.env.WORLD_ATELIER_E2E_BUILD_TIMEOUT_MS ?? 180_000);
const SOURCE_RUNTIME = process.env.WORLD_ATELIER_E2E_SOURCE_RUNTIME ?? '9eb9ebc848361cefe7f1d4b998acd7084bb38d321e188151b1dd632c426f11a7';
const TARGET_RUNTIME = process.env.WORLD_ATELIER_E2E_TARGET_RUNTIME ?? 'a83e58fbf8851cf76d702079deb4a5e861c47ff22c8b3f18354c5f8c1d4f1c90';
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

async function assertAuthority(serverPid, worldId, release, runtimeRoot = join(ROOT, '.local/artifacts')) {
  assert.match(release.runtime_hash, /^[a-f0-9]{64}$/);
  assert.equal(typeof release.authority_binary, 'string', 'Release must name its immutable exported authority.');
  const releaseDirectory = join(runtimeRoot, release.runtime_hash);
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
  constructor(directory) { this.runtimeRoot = join(ROOT, '.local/artifacts'); this.directory = directory; this.data = join(directory, 'data'); this.children = []; }
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
      env: { ...process.env, WORLD_ATELIER_PORT: String(PORT), WORLD_ATELIER_DATA: this.data, WORLD_ATELIER_RUNTIME_ROOT: this.runtimeRoot },
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
      if (['revoked', 'runtime_upgrade'].includes(message.type)) this.active = false;
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
    const answer = await this.wait(message => (message.type === 'active' && message.release_id === releaseId) || message.type === 'error', after);
    assert.equal(answer.type, 'active', `${this.label} loaded was rejected: ${safeText(JSON.stringify(answer))}`);
    return answer;
  }
  async command(action, payload = {}, overrides = {}) {
    const after = this.counter;
    const request = { type: 'command', request_id: randomUUID(), epoch: this.epoch, release_id: this.release_id,
      control_generation: this.control_generation, action, payload, ...overrides };
    this.send(request);
    return this.wait(message => (message.type === 'ack' && message.request_id === request.request_id) || (message.type === 'error' && (!message.request_id || message.request_id === request.request_id)), after);
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
async function build(account, projectId, branch, runtimeHash, expected = 'passed') {
  const created = (await api(`/api/projects/${projectId}/branches/${branch}/build`, { account, method: 'POST', body: { runtime_hash: runtimeHash } })).data.build;
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

async function checkout(account, projectId, worldId, branch = 'main', releaseId) {
  const fixed = (await api(`/api/projects/${projectId}/checkouts`, { account, method: 'POST', body: { branch, platform: 'web', mode: 'join-live', world_id: worldId, release_id: releaseId } })).data;
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

async function movementPerTick(client) {
  const pending = [];
  const sendMove = () => { const command = client.command('move', { x: 1, z: 0 }); pending.push(command); return command; };
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

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

// Read-only forensic access to OUR temporary SQLite database. This observes the
// persisted freeze checkpoint; it neither inserts state nor manufactures an ACK.
function checkpointFromDisk(service, receipt) {
  assert.ok(receipt.checkpoint_id, 'Upgrade receipt must identify its independent frozen checkpoint.');
  const database = new DatabaseSync(join(service.data, 'world-atelier.sqlite'), { readOnly: true });
  try {
    const row = database.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get('checkpoint', receipt.checkpoint_id);
    assert.ok(row, 'Frozen checkpoint must exist durably.');
    const checkpoint = JSON.parse(row.body);
    assert.equal(sha256(canonical(checkpoint.state)), checkpoint.state_hash, 'Independently recomputed final-state hash must match.');
    assert.equal(checkpoint.sequence, receipt.source_watermark);
    assert.equal(checkpoint.epoch, receipt.source_epoch);
    assert.equal(checkpoint.release_id, receipt.source_release);
    return checkpoint;
  } finally { database.close(); }
}

function assertProgress(actual, expected, users) {
  for (const userId of users) {
    assert.ok(actual.players[userId], 'Stable actor ID must survive transfer.');
    for (const key of ['crystals', 'collected', 'kills', 'level', 'x', 'z'])
      assert.equal(actual.players[userId][key], expected.players[userId][key], `Player ${userId} ${key} changed across frozen-state transfer.`);
  }
  for (const objectId of ['landing_crystal_0', 'landing_crystal_1'])
    assert.equal(actual.objects[objectId].collected, true, `${objectId} progress must survive transfer.`);
  assert.ok(actual.tick >= expected.tick, 'Simulation tick may not regress at runtime handoff.');
}

test('observed object version, real build lifecycle and per-world delivery history', { timeout: 10 * 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-atelier-object-history-e2e-'));
  const service = new Service(directory), probes = [];
  const context = { objectId: 'launch_beacon', evidence: { kind: 'independent-real-object-history', directory, runtime_hash: TARGET_RUNTIME,
    rendered_client_evidence: false, fabricated_authority_messages: false, annotation_fixture: true, phases: [] } };
  const phase = async (name, fn) => {
    let failure;
    await t.test(name, async () => {
      const started = Date.now();
      try { await fn(); context.evidence.phases.push({ name, status: 'passed', elapsed_ms: Date.now() - started }); }
      catch (error) { failure = error; context.evidence.phases.push({ name, status: 'failed', error: safeText(error.message) }); throw error; }
    });
    if (failure) throw new Error(`Dependent object-history phases stopped after: ${name}`, { cause: failure });
  };
  const history = async (branch = 'main') => (await api(`/api/projects/${context.projectId}/branches/${branch}/objects/${context.objectId}/history?limit=30`, { account: context.owner })).data;
  const task = async id => (await project(context.owner, context.projectId)).tasks.find(item => item.id === id);
  const connect = async (account, worldId) => {
    const prepared = await checkout(account, context.projectId, worldId, 'main', context.baseRelease.id);
    const peer = new ProtocolClient(account.user.name); probes.push(peer); await peer.connect(prepared.prepared); await peer.loaded(); return peer;
  };
  const annotate = async body => (await api(`/api/projects/${context.projectId}/tasks`, { account: context.owner, method: 'POST', body })).data.task;
  const overlay = async (worldId, taskId, predicate) => until(`real authority overlay ${taskId}`, async () => {
    const state = await world(context.owner, worldId), item = state.state.tasks?.find(value => value.id === taskId);
    return item && predicate(item) ? item : null;
  });
  const apply = async (worldId, peer, host) => {
    const after = peer.counter;
    const response = (await api(`/api/worlds/${worldId}/apply-latest`, { account: context.owner, method: 'POST', body: { release_id: context.nextRelease.id } })).data;
    assert.equal(response.ok, true); assert.equal(response.requires_client_upgrade, false);
    await peer.wait(message => message.type === 'content' && message.release_id === context.nextRelease.id, after); await peer.loaded(context.nextRelease.id);
    assert.equal((await assertAuthority(service.child.pid, worldId, context.nextRelease)).pid, host.pid, 'Compatible object update must keep the real host process.');
    return response;
  };
  try {
    await phase('two same-branch authorities and one independent branch establish real versioned scenes', async () => {
      await service.start(); const suffix = randomUUID().slice(0, 8);
      for (const role of ['owner', 'member']) context[role] = (await api('/api/auth/register', { method: 'POST',
        body: { name: `object_${role}_${suffix}`, password: `Test-${randomUUID()}` }, status: 201 })).data;
      context.projectId = (await api('/api/projects', { account: context.owner, method: 'POST', body: { name: `Object history ${suffix}` } })).data.project.id;
      await api(`/api/projects/${context.projectId}/members`, { account: context.owner, method: 'POST', body: { name: context.member.user.name, role: 'tester' } });
      context.base = await content(context.owner, context.projectId);
      context.baseObject = context.base.content.objects.find(item => item.id === context.objectId);
      context.baseHash = sha256(canonical(context.baseObject));
      context.baseRelease = (await build(context.owner, context.projectId, 'main', TARGET_RUNTIME)).release;
      await api(`/api/projects/${context.projectId}/branches`, { account: context.owner, method: 'POST', body: { name: 'object-history-side' } });
      for (const [key, branch] of [['worldA', 'main'], ['worldB', 'main'], ['sideWorld', 'object-history-side']]) {
        context[key] = (await api(`/api/projects/${context.projectId}/worlds`, { account: context.owner, method: 'POST', body: { branch, name: `independent ${key}` } })).data.world.id;
        context[`${key}Host`] = await assertAuthority(service.child.pid, context[key], context.baseRelease);
      }
      context.a = await connect(context.owner, context.worldA); context.b = await connect(context.member, context.worldB);
      assert.equal((await context.a.command('interact', { object_id: 'landing_crystal_0' })).ok, true);
      assert.equal((await context.b.command('interact', { object_id: 'landing_crystal_1' })).ok, true);
      context.sideTask = await annotate({ branch: 'object-history-side', object_id: context.objectId, title: 'Independent branch annotation fixture', origin: 'source', base_revision: context.base.revision });
      await overlay(context.sideWorld, context.sideTask.id, value => value.status === 'editing');
      context.evidence.fixture = { project_id: context.projectId, world_a: context.worldAHost, world_b: context.worldBHost,
        side_world: context.sideWorldHost, base_revision: context.base.revision, base_release: context.baseRelease.id, base_object_hash: context.baseHash };
    });

    await phase('a live annotation pins the actually observed release when source head is ahead, with stale and cross-branch references rejected', async () => {
      context.changed = clone(context.base.content);
      context.changedObject = context.changed.objects.find(item => item.id === context.objectId);
      context.changedObject.color = '#ff8844'; context.changedObject.scale = 1.35; context.changedObject.name += ' · candidate';
      context.nextRevision = (await commit(context.owner, context.projectId, 'main', context.base.revision, context.changed)).revision;
      context.nextHash = sha256(canonical(context.changedObject)); assert.notEqual(context.nextHash, context.baseHash);
      context.annotation = await annotate({ branch: 'main', object_id: context.objectId, title: 'Live observed version fixture while source is ahead', origin: 'live',
        observed_world_id: context.worldA, observed_release_id: context.baseRelease.id, observed_object_hash: context.baseHash, base_revision: context.nextRevision });
      assert.equal(context.annotation.base_revision, context.base.revision); assert.equal(context.annotation.annotation_revision, context.base.revision);
      assert.equal(context.annotation.base_object_hash, context.baseHash); assert.equal(context.annotation.origin, 'live');
      assert.equal(context.annotation.observation.release_id, context.baseRelease.id); assert.equal(context.annotation.observation.world_id, context.worldA);
      assert.equal(context.annotation.observation.object_hash, context.baseHash);
      assert.equal(context.annotation.history[0].kind, 'created'); assert.equal(context.annotation.history[0].revision, context.base.revision);
      const body = { branch: 'main', object_id: context.objectId, title: 'Deliberately invalid observation fixture', origin: 'live',
        observed_world_id: context.worldA, observed_release_id: context.baseRelease.id };
      await api(`/api/projects/${context.projectId}/tasks`, { account: context.owner, method: 'POST', body: { ...body, observed_object_hash: context.nextHash }, status: 409 });
      await api(`/api/projects/${context.projectId}/tasks`, { account: context.owner, method: 'POST', body: { ...body, observed_release_id: 'release_nonexistent' }, status: 409 });
      await api(`/api/projects/${context.projectId}/tasks`, { account: context.owner, method: 'POST', body: { ...body, observed_world_id: context.sideWorld }, status: 403 });
      await api(`/api/projects/${context.projectId}/tasks`, { account: context.owner, method: 'POST', body: { branch: 'object-history-side', object_id: context.objectId,
        title: 'Unreachable source reference fixture', origin: 'source', base_revision: context.nextRevision }, status: 409 });
      context.unrelated = await annotate({ branch: 'main', object_id: 'landing_crystal_0', title: 'Unmodified object annotation fixture', origin: 'source', base_revision: context.base.revision });
      const state = await history(); assert.equal(state.source.revision, context.nextRevision); assert.equal(state.source.object_hash, context.nextHash);
      assert.equal(state.playable.revision, context.base.revision); assert.equal(state.playable.object_hash, context.baseHash);
      assert.deepEqual(new Set(state.worlds.map(value => value.object_hash)), new Set([context.baseHash]));
      const version = state.versions.find(value => value.revision === context.nextRevision); assert.ok(version);
      assert.deepEqual(version.changes.map(change => change.path).sort(), ['color', 'name', 'scale']);
      context.evidence.observed_annotation = { id: context.annotation.id, base_revision: context.annotation.base_revision,
        actual_observation: context.annotation.observation, source_ahead_revision: context.nextRevision, expected_new_object_hash: context.nextHash,
        rejected_cases: ['wrong observed hash', 'wrong observed release', 'wrong branch world', 'unreachable branch source'] };
    });

    await phase('actual build and first-world application record complete object delivery while the unupdated world remains testing', async () => {
      const result = await build(context.owner, context.projectId, 'main', TARGET_RUNTIME); context.nextRelease = result.release;
      const testing = await task(context.annotation.id); assert.equal(testing.status, 'testing'); assert.equal(testing.candidate_revision, context.nextRevision);
      assert.equal(testing.candidate_build_id, result.build.id); assert.equal(testing.candidate_release_id, result.release.id);
      assert.ok(testing.history.some(entry => entry.kind === 'build_started' && entry.object_hash === context.nextHash));
      assert.ok(testing.history.some(entry => entry.kind === 'build_passed' && entry.release_id === result.release.id));
      await overlay(context.worldA, testing.id, value => value.status === 'testing'); await overlay(context.worldB, testing.id, value => value.status === 'testing');
      const applied = await apply(context.worldA, context.a, context.worldAHost);
      const delivered = await task(testing.id); assert.equal(delivered.status, 'delivered'); assert.equal(delivered.delivered_revision, context.nextRevision);
      assert.equal(delivered.delivered_object_hash, context.nextHash); assert.equal(delivered.delivered_release_id, result.release.id);
      assert.equal(delivered.delivered_world_id, context.worldA); assert.equal(delivered.applied_sequence, applied.sequence);
      const event = delivered.history.find(entry => entry.kind === 'delivered'); assert.equal(event.revision, context.nextRevision);
      assert.equal(event.object_hash, context.nextHash); assert.equal(event.world_sequence, applied.sequence); assert.equal(event.world_id, context.worldA);
      const a = await overlay(context.worldA, testing.id, value => value.status === 'delivered' && value.delivery_status === 'applied');
      const b = await overlay(context.worldB, testing.id, value => value.status === 'testing' && value.delivery_status === 'awaiting_world');
      assert.equal(a.world_object_hash, context.nextHash); assert.equal(b.world_object_hash, context.baseHash);
      assert.equal(context.b.content.objects.find(value => value.id === context.objectId).color, context.baseObject.color);
      assert.equal(context.a.content.objects.find(value => value.id === context.objectId).color, context.changedObject.color);
      const state = await history(), currentTask = state.tasks.find(value => value.id === testing.id);
      assert.equal(currentTask.worlds.find(value => value.world_id === context.worldA).delivery_status, 'applied');
      assert.equal(currentTask.worlds.find(value => value.world_id === context.worldB).delivery_status, 'awaiting_world');
      assert.equal(state.worlds.find(value => value.world_id === context.worldA).applied_sequence, applied.sequence);
      assert.equal((await task(context.unrelated.id)).status, 'editing', 'Unchanged object task must not be auto-delivered by an unrelated build.');
      const side = await history('object-history-side'); assert.equal(side.source.revision, context.base.revision); assert.equal(side.playable.release_id, context.baseRelease.id);
      assert.ok(!side.tasks.some(value => value.id === testing.id)); assert.ok(!side.versions.some(value => value.revision === context.nextRevision));
      assert.equal((await task(context.sideTask.id)).status, 'editing');
      context.evidence.partial_world_delivery = { task_id: testing.id, real_build_id: result.build.id, delivered_revision: delivered.delivered_revision,
        delivered_hash: delivered.delivered_object_hash, release_id: delivered.delivered_release_id, world_a_sequence: applied.sequence,
        world_a_overlay: { status: a.status, delivery_status: a.delivery_status, hash: a.world_object_hash },
        world_b_overlay: { status: b.status, delivery_status: b.delivery_status, hash: b.world_object_hash }, branch_isolation: true };
    });

    await phase('second world applies the same immutable object version and stale live observations are rejected after application', async () => {
      const applied = await apply(context.worldB, context.b, context.worldBHost);
      await overlay(context.worldB, context.annotation.id, value => value.status === 'delivered' && value.delivery_status === 'applied');
      const state = await history(); assert.ok(state.tasks.find(value => value.id === context.annotation.id).worlds.every(value => value.delivery_status === 'applied'));
      assert.ok(state.worlds.every(value => value.object_hash === context.nextHash));
      assert.equal(state.worlds.find(value => value.world_id === context.worldB).applied_sequence, applied.sequence);
      await api(`/api/projects/${context.projectId}/tasks`, { account: context.owner, method: 'POST', body: { branch: 'main', object_id: context.objectId,
        title: 'Stale post-application observation fixture', origin: 'live', observed_world_id: context.worldA, observed_release_id: context.baseRelease.id }, status: 409 });
      const a = await world(context.owner, context.worldA), b = await world(context.owner, context.worldB);
      assert.equal(a.state.players[context.owner.user.id].crystals, 2); assert.equal(b.state.players[context.member.user.id].crystals, 2);
      context.evidence.all_worlds_delivered = { world_b_sequence: applied.sequence, world_hashes: state.worlds.map(value => ({ id: value.world_id, hash: value.object_hash })), player_progress_preserved: true };
    });

    await phase('a real Godot build failure updates the new annotation cycle and both world overlays without replacing good object versions', async () => {
      context.badTask = await annotate({ branch: 'main', object_id: context.objectId, title: 'Deliberately failing real candidate fixture', origin: 'live',
        observed_world_id: context.worldA, observed_release_id: context.nextRelease.id, observed_object_hash: context.nextHash });
      const changed = clone(context.changed); changed.objects.find(value => value.id === context.objectId).color = '#aa4477'; changed.rules.player_speed = -1;
      const badRevision = (await commit(context.owner, context.projectId, 'main', context.nextRevision, changed)).revision;
      const rejectedBuild = (await build(context.owner, context.projectId, 'main', TARGET_RUNTIME, 'failed')).build;
      assert.match(String(rejectedBuild.log), /invalid rule: player_speed/); assert.match(rejectedBuild.error, /Godot rejected/);
      const failed = await task(context.badTask.id); assert.equal(failed.status, 'failed'); assert.equal(failed.candidate_revision, badRevision);
      assert.equal(failed.candidate_build_id, rejectedBuild.id); assert.ok(failed.error);
      assert.ok(failed.history.some(entry => entry.kind === 'build_started' && entry.revision === badRevision));
      assert.ok(failed.history.some(entry => entry.kind === 'build_failed' && entry.build_id === rejectedBuild.id));
      assert.ok(!failed.history.some(entry => entry.kind === 'delivered'));
      await overlay(context.worldA, failed.id, value => value.status === 'failed'); await overlay(context.worldB, failed.id, value => value.status === 'failed');
      const state = await history(); assert.equal(state.source.revision, badRevision); assert.equal(state.playable.release_id, context.nextRelease.id);
      assert.ok(state.worlds.every(value => value.object_hash === context.nextHash));
      for (const [worldId, peer, host] of [[context.worldA, context.a, context.worldAHost], [context.worldB, context.b, context.worldBHost]]) {
        assert.equal((await assertAuthority(service.child.pid, worldId, context.nextRelease)).pid, host.pid);
        assert.equal((await peer.command('move', { x: 0, z: 0 })).ok, true);
      }
      const side = await history('object-history-side'); assert.equal(side.source.revision, context.base.revision); assert.equal((await task(context.sideTask.id)).status, 'editing');
      const sideState = await world(context.owner, context.sideWorld); assert.ok(!sideState.state.tasks.some(value => value.id === failed.id));
      context.evidence.failed_candidate = { task_id: failed.id, base_revision: failed.base_revision, candidate_revision: failed.candidate_revision,
        build_id: rejectedBuild.id, actual_godot_error: rejectedBuild.error, task_history: failed.history,
        good_playable_release: state.playable.release_id, unchanged_live_hash: context.nextHash, actual_overlays_failed: true };
    });
  } finally {
    await Promise.allSettled(probes.map(peer => peer.close())); await service.stop();
    context.evidence.server_launches = service.children;
    await appendFile(join(directory, 'observations.json'), JSON.stringify(context.evidence, null, 2));
    t.diagnostic(`Object-history observations: ${directory}/observations.json. Annotations are explicit API fixtures and clients are protocol probes; this does not prove the Portal history UI, visual appearance, Codex task execution or arbitrary dependency-aware delivery.`);
  }
});
