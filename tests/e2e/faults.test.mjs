import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, appendFile } from 'node:fs/promises';
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
const PINNED_RUNTIME = process.env.WORLD_ATELIER_E2E_RUNTIME_HASH ?? '9eb9ebc848361cefe7f1d4b998acd7084bb38d321e188151b1dd632c426f11a7';
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
  const created = (await api(`/api/projects/${projectId}/branches/${branch}/build`, { account, method: 'POST', body: { runtime_hash: PINNED_RUNTIME } })).data.build;
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

test('real fault matrix: access revocation, build ordering, pinned download and abrupt recovery', { timeout: 12 * 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-atelier-faults-e2e-'));
  const service = new Service(directory), probes = [], paused = new Set(), ownedProcesses = new Map();
  const context = { evidence: { kind: 'independent-real-fault-injection-e2e', directory, pinned_runtime: PINNED_RUNTIME,
    rendered_client_evidence: false, fabricated_authority_messages: false, phases: [] } };
  t.diagnostic(`Isolated fault matrix data: ${directory}`);
  const phase = async (name, fn) => {
    let failure;
    await t.test(name, async () => {
      const started = Date.now();
      try { await fn(); context.evidence.phases.push({ name, status: 'passed', elapsed_ms: Date.now() - started }); }
      catch (error) { failure = error; context.evidence.phases.push({ name, status: 'failed', error: safeText(error.message) }); throw error; }
    });
    if (failure) throw new Error(`Dependent fault phases stopped after: ${name}`, { cause: failure });
  };
  const connect = async (account, label) => {
    const prepared = await checkout(account, context.projectId, context.worldId);
    const peer = new ProtocolClient(label); probes.push(peer); await peer.connect(prepared.prepared); await peer.loaded(); return peer;
  };
  const apply = async release => {
    const currentPeers = [context.a, context.b], cursors = currentPeers.map(peer => peer.counter);
    let failure;
    const request = api(`/api/worlds/${context.worldId}/apply-latest`, { account: context.owner, method: 'POST', body: {} }).catch(error => { failure = error; return null; });
    for (let index = 0; index < currentPeers.length; index++) {
      const peer = currentPeers[index];
      await until(`new content reaches ${peer.label}`, () => {
        if (failure) throw failure;
        return peer.records.find(record => record.index > cursors[index] && record.message.type === 'content' && record.message.release_id === release.id);
      });
      await peer.loaded(release.id);
    }
    const response = await request; if (failure) throw failure;
    assert.equal(response.data.ok, true);
    assert.equal((await assertAuthority(service.child.pid, context.worldId, release)).pid, context.authority.pid);
    context.release = release; return response.data;
  };
  const rememberAuthority = async release => {
    const host = await assertAuthority(service.child.pid, context.worldId, release);
    ownedProcesses.set(host.pid, { executable: host.executable, role: 'authority', world_id: context.worldId }); return host;
  };
  const commitCurrent = async document => {
    const base = await content(context.owner, context.projectId);
    return commit(context.owner, context.projectId, 'main', base.revision, document, 'Explicit independent fault-matrix content');
  };
  try {
    await phase('real isolated authority, accounts and confirmed shared progress establish the fixture', async () => {
      assert.match(PINNED_RUNTIME, /^[a-f0-9]{64}$/); await service.start();
      const suffix = randomUUID().slice(0, 8);
      for (const role of ['owner', 'member']) context[role] = (await api('/api/auth/register', { method: 'POST',
        body: { name: `fault_${role}_${suffix}`, password: `Test-${randomUUID()}` }, status: 201 })).data;
      context.projectId = (await api('/api/projects', { account: context.owner, method: 'POST', body: { name: `Fault matrix ${suffix}` } })).data.project.id;
      await api(`/api/projects/${context.projectId}/members`, { account: context.owner, method: 'POST', body: { name: context.member.user.name, role: 'tester' } });
      const result = await build(context.owner, context.projectId, 'main'); context.release = result.release;
      assert.equal(result.release.runtime_hash, PINNED_RUNTIME, 'Fault matrix must use the explicitly selected real immutable runtime.');
      context.worldId = (await api(`/api/projects/${context.projectId}/worlds`, { account: context.owner, method: 'POST', body: { branch: 'main' } })).data.world.id;
      context.authority = await rememberAuthority(result.release); context.evidence.initial_authority = context.authority;
      context.a = await connect(context.owner, 'fault owner'); context.b = await connect(context.member, 'fault member');
      assert.equal((await context.a.command('interact', { object_id: 'landing_crystal_0' })).ok, true);
      assert.equal((await context.b.command('interact', { object_id: 'landing_crystal_1' })).ok, true);
      const state = await context.a.snapshot(packet => packet.state.objects.landing_crystal_0?.collected && packet.state.objects.landing_crystal_1?.collected);
      context.progress = { owner: state.state.players[context.owner.user.id].crystals, member: state.state.players[context.member.user.id].crystals };
      context.evidence.baseline = { release_id: context.release.id, world_id: context.worldId, epoch: state.epoch, sequence: state.sequence, progress: context.progress };
    });

    await phase('member removal revokes live control and already prepared access before allowing a fresh authorized rejoin', async () => {
      const path = `/api/projects/${context.projectId}`;
      const bytes = Buffer.from('extends RefCounted\nfunc evaluate(context: Dictionary) -> Dictionary:\n\treturn {}\n');
      const asset = (await api(`${path}/assets`, { account: context.owner, method: 'POST', body: { name: 'permission-fixture.gd', mime: 'text/x-gdscript', data_base64: bytes.toString('base64') } })).data.asset;
      await api(`${path}/assets/${asset.hash}`, { account: context.member });
      const fixed = await checkout(context.member, context.projectId, context.worldId), old = context.b, cursor = old.counter;
      await api(`${path}/members/${context.owner.user.id}`, { account: context.owner, method: 'DELETE', body: {}, status: [400, 403] });
      await api(`${path}/members/${context.member.user.id}`, { account: context.member, method: 'DELETE', body: {}, status: 403 });
      await api(`${path}/members/${context.member.user.id}`, { account: context.owner, method: 'DELETE', body: {} });
      await old.wait(message => message.type === 'revoked', cursor);
      await until('revoked active transport is closed', () => old.socket.readyState === WebSocket.CLOSED);
      await api(path, { account: context.member, status: 403 });
      await api(`${path}/assets/${asset.hash}`, { account: context.member, status: 403 });
      await api(`/api/checkouts/${fixed.fixed.checkout.id}/prepare-join`, { account: context.member, method: 'POST', body: {}, status: 403 });
      const denied = new ProtocolClient('revoked already-issued join ticket'); probes.push(denied);
      const deniedConnection = denied.connect(fixed.prepared).catch(() => null);
      const refusal = await denied.wait(message => message.type === 'error');
      assert.match(refusal.error, /membership|permission|access|revoked/i);
      await denied.close(); await deniedConnection;
      const after = await world(context.owner, context.worldId);
      assert.equal(after.state.players[context.member.user.id].crystals, context.progress.member);
      await api(`${path}/members`, { account: context.owner, method: 'POST', body: { name: context.member.user.name, role: 'tester' } });
      context.b = await connect(context.member, 'freshly authorized member');
      const rejoined = await context.b.snapshot(packet => packet.state.players[context.member.user.id]?.online === true);
      assert.equal(rejoined.state.players[context.member.user.id].crystals, context.progress.member);
      context.evidence.permission_revocation = { revoked_transport_closed: true, prepared_ticket_refusal: refusal.error, actor_id_preserved: context.member.user.id };
    });

    await phase('real paused validator completes after a newer build and cannot regress playable head', async () => {
      const source = await content(context.owner, context.projectId), first = clone(source.content); first.revision_label = 'slow actual validator candidate';
      const firstRevision = await commitCurrent(first);
      const scheduled = (await api(`/api/projects/${context.projectId}/branches/main/build`, { account: context.owner, method: 'POST', body: { runtime_hash: PINNED_RUNTIME } })).data.build;
      const candidateFile = join(service.data, 'builds', scheduled.id, 'content.json');
      const executable = context.authority.executable;
      const validator = await until('actual first validator is available for process-level pause', async () => {
        const found = descendants(await processList(), service.child.pid).find(item => item.command.startsWith(executable + ' ') && item.command.includes('--role=validate') && item.command.includes(`--content=${candidateFile}`));
        if (found) return found;
        const state = (await project(context.owner, context.projectId)).builds.find(item => item.id === scheduled.id);
        if (state && terminalBuild.has(state.status)) throw new Error(`Fixture missed real validator pause; build already ${state.status}. No ordering proof obtained.`);
        return null;
      });
      ownedProcesses.set(validator.pid, { executable, role: 'validate', content: candidateFile });
      process.kill(validator.pid, 'SIGSTOP'); paused.add(validator.pid);
      await until('validator is actually suspended', async () => /T/.test((await execFileAsync('ps', ['-p', String(validator.pid), '-o', 'stat='])).stdout));
      const pausedAt = Date.now();
      const later = clone(first); later.revision_label = 'newer actual validator candidate'; later.rules.attack_damage += 1;
      const laterRevision = await commitCurrent(later), newer = await build(context.owner, context.projectId, 'main');
      assert.equal(newer.build.revision, laterRevision.revision);
      const newerCompletedAt = Date.now();
      process.kill(validator.pid, 'SIGCONT'); paused.delete(validator.pid);
      const previous = await until('resumed real old validator finishes', async () => {
        const item = (await project(context.owner, context.projectId)).builds.find(build => build.id === scheduled.id);
        return item && terminalBuild.has(item.status) ? item : null;
      });
      assert.equal(previous.status, 'superseded'); assert.equal(previous.revision, firstRevision.revision);
      assert.match(previous.log, /CONTENT_VALIDATED/, 'Late build must actually complete Godot validation.');
      assert.equal((await project(context.owner, context.projectId)).branches.find(branch => branch.name === 'main').playable_head, newer.release.id);
      await apply(newer.release);
      context.evidence.out_of_order_build = { paused_pid: validator.pid, paused_at: pausedAt, newer_completed_at: newerCompletedAt,
        older_build: previous.id, older_status: previous.status, newer_build: newer.build.id, playable_release: newer.release.id };
    });

    await phase('slow real artifact consumption remains pinned while a newer release invalidates the old join preparation', async () => {
      const fixed = (await api(`/api/projects/${context.projectId}/checkouts`, { account: context.owner, method: 'POST',
        body: { branch: 'main', platform: 'macos', mode: 'join-live', world_id: context.worldId } })).data;
      const artifact = fixed.artifacts.find(item => item.platform === 'macos' && item.path.endsWith('.zip'));
      const response = await fetch(new URL(artifact.url, BASE), { signal: AbortSignal.timeout(60_000) }); assert.equal(response.status, 200);
      const reader = response.body.getReader(), first = await reader.read(), hashing = createHash('sha256');
      assert.ok(first.value?.length > 0 && first.value.length < artifact.bytes);
      let bytes = first.value.length; hashing.update(first.value);
      const heldAt = Date.now();
      try {
        const source = await content(context.owner, context.projectId), next = clone(source.content); next.revision_label = 'advanced during actual download';
        await commitCurrent(next); const newer = await build(context.owner, context.projectId, 'main');
        assert.notEqual(newer.release.id, fixed.release.id); await apply(newer.release);
        await api(`/api/checkouts/${fixed.checkout.id}/prepare-join`, { account: context.owner, method: 'POST', body: {}, status: 409 });
        const resumedAt = Date.now();
        for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; hashing.update(part.value); }
        assert.equal(bytes, artifact.bytes); assert.equal(hashing.digest('hex'), artifact.sha256);
        context.evidence.slow_download = { pinned_release: fixed.release.id, new_release: newer.release.id, asset_sha256: artifact.sha256,
          initial_consumed_bytes: first.value.length, total_bytes: bytes, held_at: heldAt, resumed_at: resumedAt, stale_checkout_status: 409 };
      } finally { await reader.cancel().catch(() => {}); }
    });

    await phase('SIGKILL after a critical ACK preserves progress, retires the disconnected old host and fences the restored epoch', async () => {
      const oldWorld = await world(context.owner, context.worldId), oldHost = context.authority;
      const requestId = randomUUID();
      const accepted = await context.a.command('interact', { object_id: 'landing_crystal_2' }, { request_id: requestId });
      assert.equal(accepted.ok, true); assert.ok(accepted.sequence > oldWorld.sequence);
      const killedPid = service.child.pid, killedAt = Date.now();
      process.kill(killedPid, 'SIGKILL'); await service.exited;
      await until('disconnected real authority exits after coordinator crash', async () => !(await processList()).some(item => item.pid === oldHost.pid), 6000);
      await service.stop(); await service.start();
      const restored = await until('new authority restores acknowledged state after abrupt coordinator death', async () => {
        const value = await world(context.owner, context.worldId);
        if (value.status === 'failed') throw new Error(value.error);
        return value.status === 'running' && value.state ? value : null;
      }, 35_000);
      assert.ok(restored.epoch > oldWorld.epoch); assert.ok(restored.sequence >= accepted.sequence);
      assert.equal(restored.state.players[context.owner.user.id].crystals, context.progress.owner + 2);
      assert.equal(restored.state.players[context.member.user.id].crystals, context.progress.member);
      for (const id of ['landing_crystal_0', 'landing_crystal_1', 'landing_crystal_2']) assert.equal(restored.state.objects[id].collected, true);
      context.authority = await rememberAuthority(context.release); assert.notEqual(context.authority.pid, oldHost.pid);
      context.a = await connect(context.owner, 'crash-restored owner'); context.b = await connect(context.member, 'crash-restored member');
      const replay = await context.a.command('interact', { object_id: 'landing_crystal_2' }, { request_id: requestId });
      assert.deepEqual(replay, accepted, 'The confirmed critical operation must replay its durable outcome after coordinator death.');
      rejected(await context.a.command('move', { x: 0, z: 0 }, { epoch: oldWorld.epoch }), 'old authority epoch after abrupt restoration');
      assert.equal((await context.a.command('move', { x: 0, z: 0 })).ok, true);
      context.evidence.abrupt_recovery = { killed_server_pid: killedPid, killed_at: killedAt, critical_ack: accepted,
        old_authority: oldHost, new_authority: context.authority, old_epoch: oldWorld.epoch, new_epoch: restored.epoch,
        restored_sequence: restored.sequence, old_authority_exited: true, replay_equal: true };
    });
  } finally {
    for (const pid of paused) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await Promise.allSettled(probes.map(peer => peer.close())); await service.stop();
    // Clean up only process identities observed as children of this isolated
    // service. Never infer ownership from an executable name or port alone.
    for (const item of await processList()) {
      const owned = ownedProcesses.get(item.pid);
      if (owned && item.command.startsWith(owned.executable + ' ') && item.command.includes(`--role=${owned.role}`) &&
        (!owned.world_id || item.command.includes(`--world=${owned.world_id}`)) && (!owned.content || item.command.includes(`--content=${owned.content}`))) {
        try { process.kill(item.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    context.evidence.server_launches = service.children;
    await appendFile(join(directory, 'observations.json'), JSON.stringify(context.evidence, null, 2));
    t.diagnostic(`Fault observations: ${directory}/observations.json. This does not prove lease fencing during network partition, every crash instruction boundary, or runtime-version transfer; no authority ACK is manufactured.`);
  }
});
