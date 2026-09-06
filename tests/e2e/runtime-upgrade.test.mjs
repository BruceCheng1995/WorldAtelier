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

test('real immutable runtime upgrade, startup fallback and coordinator-crash recovery', { timeout: 10 * 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-atelier-upgrade-e2e-'));
  const service = new Service(directory), probes = [], paused = new Set(), owned = new Map();
  const context = { evidence: { kind: 'independent-real-runtime-transfer', directory, source_runtime: SOURCE_RUNTIME, target_runtime: TARGET_RUNTIME,
    rendered_client_evidence: false, fabricated_authority_messages: false, checkpoint_access: 'read-only own temporary SQLite', phases: [] } };
  t.diagnostic(`Isolated runtime upgrade data: ${directory}`);
  const phase = async (name, fn) => {
    let failure;
    await t.test(name, async () => {
      const started = Date.now();
      try { await fn(); context.evidence.phases.push({ name, status: 'passed', elapsed_ms: Date.now() - started }); }
      catch (error) { failure = error; context.evidence.phases.push({ name, status: 'failed', error: safeText(error.message) }); throw error; }
    });
    if (failure) throw new Error(`Dependent runtime-upgrade phases stopped after: ${name}`, { cause: failure });
  };
  const connect = async (fixture, account, release) => {
    const prepared = await checkout(account, context.projectId, fixture.worldId, fixture.branch, release.id);
    const peer = new ProtocolClient(`${fixture.branch} ${account.user.name}`); probes.push(peer);
    await peer.connect(prepared.prepared); await peer.loaded(); return peer;
  };
  const remember = async (worldId, release) => {
    const host = await assertAuthority(service.child.pid, worldId, release, service.runtimeRoot); owned.set(host.pid, host); return host;
  };
  const fixture = async branch => {
    const worldId = (await api(`/api/projects/${context.projectId}/worlds`, { account: context.owner, method: 'POST', body: { branch } })).data.world.id;
    const value = { branch, worldId, oldHost: await remember(worldId, context.sourceRelease) };
    value.a = await connect(value, context.owner, context.sourceRelease); value.b = await connect(value, context.member, context.sourceRelease);
    assert.equal((await value.a.command('interact', { object_id: 'landing_crystal_0' })).ok, true);
    value.lastAck = await value.b.command('interact', { object_id: 'landing_crystal_1' }); assert.equal(value.lastAck.ok, true);
    assert.equal((await value.a.command('move', { x: 0, z: 0 })).ok, true);
    value.before = await world(context.owner, worldId);
    const base = await content(context.owner, context.projectId, branch), changed = clone(base.content);
    changed.revision_label = `real runtime upgrade fixture ${branch}`; changed.rules.attack_damage += 2;
    await commit(context.owner, context.projectId, branch, base.revision, changed);
    value.target = (await build(context.owner, context.projectId, branch, TARGET_RUNTIME)).release;
    assert.equal(value.target.runtime_hash, TARGET_RUNTIME);
    return value;
  };
  const getReceipt = async id => (await api(`/api/upgrades/${id}`, { account: context.owner })).data.upgrade;
  const pauseTarget = async value => {
    const executable = resolve(service.runtimeRoot, value.target.runtime_hash, value.target.authority_binary);
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const item = descendants(await processList(), service.child.pid).find(item => item.command.startsWith(executable + ' ') &&
        item.command.includes('--role=authority') && item.command.split(/\s+/).includes(`--world=${value.worldId}`));
      if (item) {
        const host = { pid: item.pid, parent_pid: item.ppid, executable, world_id: value.worldId, runtime_hash: value.target.runtime_hash };
        owned.set(item.pid, host); process.kill(item.pid, 'SIGSTOP'); paused.add(item.pid);
        await until('new actual authority is suspended', async () => /T/.test((await execFileAsync('ps', ['-p', String(item.pid), '-o', 'stat='])).stdout));
        const state = await world(context.owner, value.worldId);
        assert.equal(state.status, 'starting', 'Fault injection must catch real target startup before ready; missing this boundary is a failed fixture.');
        assert.equal(state.release_id, value.target.id); assert.ok(state.upgrade_id);
        const receipt = await getReceipt(state.upgrade_id), checkpoint = checkpointFromDisk(service, receipt);
        assert.equal(receipt.status, 'starting'); assert.ok(receipt.source_watermark > value.lastAck.sequence);
        return { host, world: state, receipt, checkpoint, paused_at: Date.now() };
      }
      await pause(5);
    }
    throw new Error('Actual target startup was not intercepted; no injected startup-boundary evidence obtained.');
  };
  const verifyResumed = async (value, expectedRelease, checkpoint) => {
    const resumed = await until('world runs after runtime handoff', async () => {
      const state = await world(context.owner, value.worldId);
      return state.status === 'running' && !state.upgrade_id ? state : null;
    }, 35_000);
    assert.equal(resumed.release_id, expectedRelease.id); assert.ok(resumed.epoch > value.before.epoch);
    assert.ok(resumed.durable_sequence > checkpoint.sequence);
    assertProgress(resumed.state, checkpoint.state, [context.owner.user.id, context.member.user.id]);
    const host = await remember(value.worldId, expectedRelease); assert.notEqual(host.pid, value.oldHost.pid);
    assert.ok(!(await processList()).some(item => item.pid === value.oldHost.pid), 'Previous authority must be gone before resumed play.');
    const a = await connect(value, context.owner, expectedRelease), b = await connect(value, context.member, expectedRelease);
    rejected(await a.command('move', { x: 0, z: 0 }, { epoch: value.before.epoch }), 'old epoch after runtime transfer');
    assert.equal((await a.command('move', { x: 0, z: 0 })).ok, true);
    assert.equal((await b.command('move', { x: 0, z: 0 })).ok, true);
    const snapshot = await a.snapshot(packet => packet.state.players[context.member.user.id]?.online === true);
    assertProgress(snapshot.state, checkpoint.state, [context.owner.user.id, context.member.user.id]);
    return { world: resumed, host, rejoined_actor_ids: [a.user_id, b.user_id] };
  };
  try {
    await phase('two distinct official exported runtimes and independent branch fixtures are real', async () => {
      assert.match(SOURCE_RUNTIME, /^[a-f0-9]{64}$/); assert.match(TARGET_RUNTIME, /^[a-f0-9]{64}$/); assert.notEqual(SOURCE_RUNTIME, TARGET_RUNTIME);
      for (const hash of [SOURCE_RUNTIME, TARGET_RUNTIME]) {
        const manifest = JSON.parse(await readFile(join(service.runtimeRoot, hash, 'manifest.json'), 'utf8'));
        assert.equal(manifest.hash, hash); await access(resolve(service.runtimeRoot, hash, manifest.authority_binary));
      }
      await service.start(); const suffix = randomUUID().slice(0, 8);
      for (const role of ['owner', 'member']) context[role] = (await api('/api/auth/register', { method: 'POST',
        body: { name: `upgrade_${role}_${suffix}`, password: `Test-${randomUUID()}` }, status: 201 })).data;
      context.projectId = (await api('/api/projects', { account: context.owner, method: 'POST', body: { name: `Runtime upgrade ${suffix}` } })).data.project.id;
      await api(`/api/projects/${context.projectId}/members`, { account: context.owner, method: 'POST', body: { name: context.member.user.name, role: 'tester' } });
      context.sourceRelease = (await build(context.owner, context.projectId, 'main', SOURCE_RUNTIME)).release;
      for (const name of ['upgrade-success', 'upgrade-fallback', 'upgrade-crash'])
        await api(`/api/projects/${context.projectId}/branches`, { account: context.owner, method: 'POST', body: { name } });
      context.evidence.project_id = context.projectId; context.evidence.source_release = context.sourceRelease.id;
    });

    await phase('normal runtime upgrade freezes real final state and resumes two actors under the new binary and epoch', async () => {
      const value = await fixture('upgrade-success'), cursors = [value.a.counter, value.b.counter], started = Date.now();
      const response = (await api(`/api/worlds/${value.worldId}/apply-latest`, { account: context.owner, method: 'POST', body: { release_id: value.target.id } })).data;
      assert.equal(response.ok, true); assert.equal(response.requires_client_upgrade, true);
      const receipt = await getReceipt(response.upgrade.id); assert.equal(receipt.status, 'complete');
      const checkpoint = checkpointFromDisk(service, receipt); assert.ok(checkpoint.sequence > value.lastAck.sequence);
      assert.equal(receipt.source_epoch, value.before.epoch); assert.ok(receipt.target_epoch > receipt.source_epoch);
      assert.ok(receipt.target_watermark > receipt.source_watermark);
      context.evidence.success_partial_before_rejoin = { old_authority: value.oldHost, receipt,
        checkpoint: { id: checkpoint.id, tick: checkpoint.state.tick, state_hash: checkpoint.state_hash } };
      for (const [index, peer] of [value.a, value.b].entries()) {
        await peer.wait(message => message.type === 'runtime_upgrade' && message.status === 'preparing', cursors[index]);
        await peer.wait(message => message.type === 'runtime_upgrade' && message.status === 'ready', cursors[index]);
        rejected(await peer.command('move', { x: 0, z: 0 }), 'old client after runtime replacement');
      }
      const resumed = await verifyResumed(value, value.target, checkpoint);
      context.evidence.success = { old_authority: value.oldHost, new_authority: resumed.host, receipt,
        freeze: { id: checkpoint.id, tick: checkpoint.state.tick, state_hash: checkpoint.state_hash }, elapsed_ms: Date.now() - started,
        matched_rejoin: resumed.rejoined_actor_ids, progress_preserved: true };
      await api(`/api/worlds/${value.worldId}/sleep`, { account: context.owner, method: 'POST', body: {} });
    });

    await phase('SIGKILL of the actual starting target restores the exact frozen source release and permits explicit matching-world rejoin', async () => {
      const value = await fixture('upgrade-fallback'), intercepted = pauseTarget(value);
      const request = api(`/api/worlds/${value.worldId}/apply-latest`, { account: context.owner, method: 'POST', body: { release_id: value.target.id }, status: 400 });
      const pausedTarget = await intercepted; process.kill(pausedTarget.host.pid, 'SIGKILL'); paused.delete(pausedTarget.host.pid);
      const response = await request; assert.match(response.data.error, /Runtime upgrade failed.*rolled-back/);
      const receipt = await getReceipt(pausedTarget.receipt.id); assert.equal(receipt.status, 'rolled-back');
      const resumed = await verifyResumed(value, context.sourceRelease, pausedTarget.checkpoint);
      assert.ok(resumed.world.epoch > pausedTarget.world.epoch, 'Rollback must allocate another epoch, never revive target authority identity.');
      assert.equal((await project(context.owner, context.projectId)).branches.find(branch => branch.name === value.branch).playable_head, value.target.id,
        'A world-specific infrastructure failure must not undo a potentially healthy global release.');
      context.evidence.startup_fallback = { old_authority: value.oldHost, killed_target: pausedTarget.host, fallback_authority: resumed.host,
        receipt, frozen_state_hash: pausedTarget.checkpoint.state_hash, restored_epoch: resumed.world.epoch,
        explicit_release_rejoin: context.sourceRelease.id, response_error: response.data.error };
      await api(`/api/worlds/${value.worldId}/sleep`, { account: context.owner, method: 'POST', body: {} });
    });

    await phase('SIGKILL of coordinator after persisted freeze resumes the pinned target and closes the durable upgrade receipt', async () => {
      const value = await fixture('upgrade-crash'), intercepted = pauseTarget(value);
      const request = api(`/api/worlds/${value.worldId}/apply-latest`, { account: context.owner, method: 'POST', body: { release_id: value.target.id } })
        .then(result => ({ result }), error => ({ error: safeText(error.message) }));
      const pausedTarget = await intercepted, oldServer = service.child.pid;
      process.kill(oldServer, 'SIGKILL'); await service.exited;
      process.kill(pausedTarget.host.pid, 'SIGCONT'); paused.delete(pausedTarget.host.pid);
      await until('orphaned suspended target exits when coordinator is gone', async () => !(await processList()).some(item => item.pid === pausedTarget.host.pid), 6000);
      const interrupted = await request; assert.ok(interrupted.error, 'Crash must interrupt actual in-flight HTTP upgrade operation.');
      await service.stop(); await service.start();
      const receipt = await until('upgrade receipt closes after coordinator restart', async () => {
        const receipt = await getReceipt(pausedTarget.receipt.id); return receipt.status === 'complete' && receipt.recovered_after_restart === true ? receipt : null;
      }, 35_000);
      const checkpoint = checkpointFromDisk(service, receipt); assert.equal(checkpoint.state_hash, pausedTarget.checkpoint.state_hash);
      const resumed = await verifyResumed(value, value.target, checkpoint);
      assert.ok(resumed.world.epoch > pausedTarget.world.epoch); assert.equal(receipt.target_epoch, resumed.world.epoch);
      assert.ok(receipt.target_watermark > receipt.source_watermark);
      context.evidence.coordinator_crash = { killed_server_pid: oldServer, interrupted_target: pausedTarget.host, recovered_authority: resumed.host,
        receipt, frozen_state_hash: checkpoint.state_hash, interrupted_http: interrupted.error, progress_preserved: true };
    });
  } finally {
    for (const pid of paused) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await Promise.allSettled(probes.map(peer => peer.close())); await service.stop();
    for (const item of await processList()) {
      const host = owned.get(item.pid);
      if (host && item.command.startsWith(host.executable + ' ') && item.command.split(/\s+/).includes(`--world=${host.world_id}`))
        try { process.kill(item.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    context.evidence.server_launches = service.children;
    const database = new DatabaseSync(join(service.data, 'world-atelier.sqlite'), { readOnly: true });
    try { context.evidence.durable_transfers = database.prepare('SELECT body FROM documents WHERE kind=?').all('transfer').map(row => JSON.parse(row.body)); }
    finally { database.close(); }
    await appendFile(join(directory, 'observations.json'), JSON.stringify(context.evidence, null, 2));
    t.diagnostic(`Runtime upgrade observations: ${directory}/observations.json. These are protocol clients; this does not prove rendered client transfer, arbitrary state schema migration, or every crash boundary.`);
  }
});
