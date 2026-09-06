import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, appendFile, readFile, rename } from 'node:fs/promises';
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
    return this.wait(message => message.type === 'active' && message.release_id === releaseId, after);
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

test('real world sleep, wake and self-contained backup restoration', { timeout: 10 * 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-atelier-backup-e2e-'));
  const service = new Service(join(directory, 'source')), probes = [];
  const context = { evidence: { kind: 'independent-real-sleep-backup-restore', directory, runtime_hash: TARGET_RUNTIME,
    rendered_client_evidence: false, fabricated_authority_messages: false, phases: [] } };
  const phase = async (name, fn) => {
    let failure;
    await t.test(name, async () => {
      const started = Date.now();
      try { await fn(); context.evidence.phases.push({ name, status: 'passed', elapsed_ms: Date.now() - started }); }
      catch (error) { failure = error; context.evidence.phases.push({ name, status: 'failed', error: safeText(error.message) }); throw error; }
    });
    if (failure) throw new Error(`Dependent backup phases stopped after: ${name}`, { cause: failure });
  };
  const connect = async account => {
    const prepared = await checkout(account, context.projectId, context.worldId, 'main', context.release.id);
    const peer = new ProtocolClient(account.user.name); probes.push(peer); await peer.connect(prepared.prepared); await peer.loaded(); return peer;
  };
  const freeze = async () => {
    const response = (await api(`/api/worlds/${context.worldId}/sleep`, { account: context.owner, method: 'POST', body: {} })).data;
    assert.equal(response.ok, true); assert.equal(response.world.status, 'sleeping');
    const before = response.world;
    await pause(300);
    const after = await world(context.owner, context.worldId);
    assert.equal(after.sequence, before.sequence); assert.equal(sha256(canonical(after.state)), sha256(canonical(before.state)), 'A sleeping world must not continue simulation.');
    assert.ok(!descendants(await processList(), service.child.pid).some(item => item.command.split(/\s+/).includes(`--world=${context.worldId}`)), 'Sleeping world must release its actual authority process.');
    return before;
  };
  const command = async (name, args) => {
    const result = await execFileAsync(process.execPath, [join(ROOT, 'tools/backup.mjs'), ...args], { cwd: ROOT, maxBuffer: 4_000_000, timeout: 180_000 });
    await appendFile(join(directory, `${name}.log`), safeText(result.stdout + result.stderr));
    const output = JSON.parse(result.stdout.trim()); assert.equal(output.ok, true); return output;
  };
  try {
    await phase('real shared progress plus current and historical immutable releases establish the backup fixture', async () => {
      await mkdir(service.directory, { recursive: true }); await service.start(); const suffix = randomUUID().slice(0, 8);
      for (const role of ['owner', 'member']) context[role] = (await api('/api/auth/register', { method: 'POST',
        body: { name: `backup_${role}_${suffix}`, password: `Test-${randomUUID()}` }, status: 201 })).data;
      context.projectId = (await api('/api/projects', { account: context.owner, method: 'POST', body: { name: `Backup ${suffix}` } })).data.project.id;
      await api(`/api/projects/${context.projectId}/members`, { account: context.owner, method: 'POST', body: { name: context.member.user.name, role: 'tester' } });
      const assetBytes = Buffer.from('extends RefCounted\nfunc evaluate(context: Dictionary) -> Dictionary:\n\treturn {}\n');
      context.asset = (await api(`/api/projects/${context.projectId}/assets`, { account: context.owner, method: 'POST',
        body: { name: 'backup-fixture.gd', mime: 'text/x-gdscript', data_base64: assetBytes.toString('base64') } })).data.asset;
      context.assetBytes = assetBytes;
      context.oldRelease = (await build(context.owner, context.projectId, 'main', TARGET_RUNTIME)).release;
      const source = await content(context.owner, context.projectId), changed = clone(source.content); changed.revision_label = 'current backup release'; changed.rules.attack_damage += 3;
      await commit(context.owner, context.projectId, 'main', source.revision, changed);
      context.release = (await build(context.owner, context.projectId, 'main', TARGET_RUNTIME)).release;
      assert.notEqual(context.release.id, context.oldRelease.id);
      context.worldId = (await api(`/api/projects/${context.projectId}/worlds`, { account: context.owner, method: 'POST', body: { branch: 'main' } })).data.world.id;
      context.host = await assertAuthority(service.child.pid, context.worldId, context.release, service.runtimeRoot);
      context.a = await connect(context.owner); context.b = await connect(context.member);
      assert.equal((await context.a.command('interact', { object_id: 'landing_crystal_0' })).ok, true);
      context.requestId = randomUUID(); context.criticalAck = await context.b.command('interact', { object_id: 'landing_crystal_1' }, { request_id: context.requestId });
      assert.equal(context.criticalAck.ok, true);
      context.baseline = await world(context.owner, context.worldId);
      context.evidence.fixture = { project_id: context.projectId, world_id: context.worldId, old_release: context.oldRelease.id, current_release: context.release.id,
        authority: context.host, critical_ack: context.criticalAck, asset_hash: context.asset.hash };
    });

    await phase('sleep freezes final state and stops its authority; explicit rejoin wakes a new epoch with the same actors', async () => {
      const asleep = await freeze(); assert.ok(asleep.sequence > context.criticalAck.sequence);
      const repeated = (await api(`/api/worlds/${context.worldId}/sleep`, { account: context.owner, method: 'POST', body: {} })).data;
      assert.equal(repeated.sequence, asleep.sequence, 'Repeated sleep must not allocate another checkpoint.');
      assertProgress(asleep.state, context.baseline.state, [context.owner.user.id, context.member.user.id]);
      rejected(await context.a.command('move', { x: 0, z: 0 }), 'sleep-revoked player');
      // Keep old sockets present to exercise the real revoked-control cleanup.
      context.a = await connect(context.owner); context.b = await connect(context.member);
      const awake = await world(context.owner, context.worldId), host = await assertAuthority(service.child.pid, context.worldId, context.release, service.runtimeRoot);
      assert.ok(awake.epoch > asleep.epoch); assert.notEqual(host.pid, context.host.pid);
      assertProgress(awake.state, asleep.state, [context.owner.user.id, context.member.user.id]);
      assert.equal((await context.a.command('move', { x: 0, z: 0 })).ok, true);
      assert.equal((await context.b.command('move', { x: 0, z: 0 })).ok, true);
      context.evidence.sleep_wake = { sleeping_sequence: asleep.sequence, frozen_tick: asleep.state.tick, frozen_state_hash: sha256(canonical(asleep.state)),
        old_authority: context.host, new_authority: host, old_epoch: asleep.epoch, new_epoch: awake.epoch };
      context.sleeping = await freeze();
    });

    await phase('backup copies actual database, source assets, both releases and complete runtime into independent restore roots', async () => {
      context.backup = join(directory, 'backup');
      const created = await command('backup-create', ['create', `--data=${service.data}`, `--out=${context.backup}`, `--runtime-root=${service.runtimeRoot}`]);
      assert.equal(created.worlds.find(item => item.id === context.worldId).sequence, context.sleeping.sequence);
      const manifest = JSON.parse(await readFile(join(context.backup, 'backup.json'), 'utf8'));
      assert.ok(manifest.files.some(item => item.path === `data/objects/${context.asset.hash}`));
      for (const release of [context.oldRelease, context.release])
        assert.ok(manifest.files.some(item => item.path === `data/artifacts/${release.content_hash}/content.json`));
      assert.ok(manifest.files.some(item => item.path === `runtimes/${TARGET_RUNTIME}/${context.release.authority_binary}`));
      await Promise.allSettled(probes.map(peer => peer.close())); await service.stop();
      await rename(service.data, join(directory, 'retired-source-data'));
      service.directory = join(directory, 'restored-service'); await mkdir(service.directory, { recursive: true });
      service.data = join(service.directory, 'data'); service.runtimeRoot = join(directory, 'restored-runtimes');
      const restored = await command('backup-restore', ['restore', `--from=${context.backup}`, `--data=${service.data}`, `--runtime-root=${service.runtimeRoot}`]);
      assert.deepEqual(restored.runtimes, [TARGET_RUNTIME]);
      for (const file of manifest.files) {
        const path = file.path.startsWith('data/') ? join(service.data, file.path.slice(5)) : join(service.runtimeRoot, file.path.slice('runtimes/'.length));
        const bytes = await readFile(path); assert.equal(bytes.length, file.bytes); assert.equal(sha256(bytes), file.sha256);
      }
      context.evidence.backup = { source_retired: true, backup_path: context.backup, restored_data: service.data, restored_runtime_root: service.runtimeRoot,
        verified_files: manifest.files.length, total_bytes: manifest.files.reduce((sum, item) => sum + item.bytes, 0), worlds: created.worlds };
    });

    await phase('restored service executes the backup binary, retains permissions and historical downloads, and resumes acknowledged gameplay', async () => {
      await service.start();
      const asleep = await world(context.owner, context.worldId); assert.equal(asleep.status, 'sleeping');
      assert.equal(sha256(canonical(asleep.state)), sha256(canonical(context.sleeping.state)));
      const asset = (await api(`/api/projects/${context.projectId}/assets/${context.asset.hash}`, { account: context.member })).data;
      assert.equal(sha256(Buffer.from(asset.data_base64, 'base64')), context.asset.hash);
      const historical = (await api(`/api/projects/${context.projectId}/checkouts`, { account: context.owner, method: 'POST',
        body: { branch: 'main', platform: 'macos', mode: 'offline', release_id: context.oldRelease.id } })).data;
      assert.equal(historical.release.id, context.oldRelease.id);
      const artifact = historical.artifacts.find(item => item.platform === 'macos' && item.path.endsWith('.zip'));
      const download = await verifyArtifact(artifact);
      const oldContentResponse = await fetch(new URL(context.oldRelease.content_url, BASE), { headers: { Authorization: `Bearer ${context.owner.token}` } });
      assert.equal(oldContentResponse.status, 200); assert.equal(sha256(Buffer.from(await oldContentResponse.arrayBuffer())), context.oldRelease.content_hash);
      context.a = await connect(context.owner); context.b = await connect(context.member);
      const host = await assertAuthority(service.child.pid, context.worldId, context.release, service.runtimeRoot);
      assert.ok(host.executable.startsWith(service.runtimeRoot + '/'), 'Restored process must execute the backup copy, not global original artifacts.');
      const awake = await world(context.owner, context.worldId); assert.ok(awake.epoch > asleep.epoch);
      assertProgress(awake.state, asleep.state, [context.owner.user.id, context.member.user.id]);
      const replay = await context.b.command('interact', { object_id: 'landing_crystal_1' }, { request_id: context.requestId });
      assert.deepEqual(replay, context.criticalAck, 'Backup must preserve the actual acknowledged critical-command receipt.');
      const newPickup = await context.a.command('interact', { object_id: 'landing_crystal_2' }); assert.equal(newPickup.ok, true);
      const live = await context.a.snapshot(packet => packet.state.objects.landing_crystal_2?.collected === true);
      assert.equal(live.state.players[context.owner.user.id].crystals, asleep.state.players[context.owner.user.id].crystals + 2);
      context.evidence.restored_gameplay = { authority: host, old_epoch: asleep.epoch, restored_epoch: awake.epoch,
        restored_tick: awake.state.tick, historical_download: download, critical_receipt_replayed: true, new_pickup_ack: newPickup };
    });
  } finally {
    await Promise.allSettled(probes.map(peer => peer.close())); await service.stop();
    context.evidence.server_launches = service.children;
    await appendFile(join(directory, 'observations.json'), JSON.stringify(context.evidence, null, 2));
    t.diagnostic(`Sleep/backup observations: ${directory}/observations.json. Real headless authority and protocol clients only; not rendered offline gameplay, remote disaster recovery, backup retention or every crash boundary.`);
  }
});
