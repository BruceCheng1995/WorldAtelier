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
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';

// Independent protocol probes. They never connect to /host or manufacture a
// Godot authority response. Their loaded messages are NOT rendering evidence.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 48921;
const PROXY_PORT = 48922;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const INTERNAL_BASE = `http://127.0.0.1:${PORT}`;
const SERVER = join(ROOT, 'services/control-plane/server.mjs');
const BUILD_TIMEOUT = Number(process.env.WORLD_ATELIER_E2E_BUILD_TIMEOUT_MS ?? 180_000);
const TARGET_RUNTIME = process.env.WORLD_ATELIER_E2E_TARGET_RUNTIME ?? '636968d30a10bb8a66b89a83e3f5a9ba927da235b5eeaef91950af857bb4588d';
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

async function api(path, { account, method = 'GET', body, status, timeout = 35_000, idempotencyKey, extraHeaders = {} } = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
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
      env: { ...process.env, WORLD_ATELIER_PORT: String(PORT), WORLD_ATELIER_DATA: this.data, WORLD_ATELIER_RUNTIME_ROOT: this.runtimeRoot, WORLD_ATELIER_PUBLIC_URL: BASE, WORLD_ATELIER_BIND_HOST: '127.0.0.1' },
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
        const response = await fetch(`${INTERNAL_BASE}/health`, { signal: AbortSignal.timeout(600) });
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
    assert.equal(Number(url.port), PROXY_PORT, 'Probe must connect through the configured reverse proxy, not directly to the backend.');
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

async function project(account, projectId) { return (await api(`/api/projects/${projectId}`, { account })).data; }
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

// This proxy forwards bytes only. It does not originate gameplay messages or
// connect to /host. All runtime replies come from the real exported authority.
class LocalProxy {
  constructor() { this.requests = []; this.upgrades = []; this.sockets = new Set(); this.errors = []; }
  async start() {
    this.server = createHttpServer((request, response) => {
      const record = { method: request.method, path: new URL(request.url, BASE).pathname, status: null, response_bytes: 0 };
      this.requests.push(record);
      const upstream = httpRequest({ hostname: '127.0.0.1', port: PORT, method: request.method, path: request.url,
        headers: { ...request.headers, 'x-forwarded-proto': 'http', 'x-forwarded-host': `127.0.0.1:${PROXY_PORT}` } }, incoming => {
        record.status = incoming.statusCode;
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.on('data', chunk => { record.response_bytes += chunk.length; });
        incoming.pipe(response);
      });
      upstream.on('error', error => {
        this.errors.push(error.message);
        if (!response.headersSent) response.writeHead(502);
        response.end('isolated proxy upstream failure');
      });
      request.pipe(upstream);
    });
    this.server.on('connection', socket => this.track(socket));
    this.server.on('upgrade', (request, socket, head) => {
      const record = { path: new URL(request.url, BASE).pathname, client_bytes: head.length, server_bytes: 0 };
      this.upgrades.push(record);
      assert.equal(record.path, '/play', 'The independent proxy must never impersonate a host.');
      const upstream = connectTcp({ host: '127.0.0.1', port: PORT }, () => {
        const headers = request.rawHeaders.flatMap((value, index, all) => index % 2 === 0 ? [`${value}: ${all[index + 1]}`] : []);
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      this.track(upstream);
      socket.on('data', chunk => { record.client_bytes += chunk.length; });
      upstream.on('data', chunk => { record.server_bytes += chunk.length; });
      upstream.on('error', error => { this.errors.push(error.message); socket.destroy(); });
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
    });
    await new Promise((resolveStart, reject) => {
      this.server.once('error', reject);
      this.server.listen(PROXY_PORT, '127.0.0.1', resolveStart);
    });
  }
  track(socket) { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); socket.on('error', () => {}); }
  async stop() {
    if (!this.server?.listening) return;
    const stopped = new Promise(resolveStop => this.server.close(resolveStop));
    for (const socket of this.sockets) socket.destroy();
    await stopped;
  }
}

test('configured public origin routes an actual checkout and game connection through a local reverse proxy', { timeout: 5 * 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-atelier-public-address-e2e-'));
  const service = new Service(directory), proxy = new LocalProxy(), probes = [];
  const context = { evidence: { kind: 'independent-local-reverse-proxy-e2e', directory, runtime_hash: TARGET_RUNTIME,
    internal_origin: INTERNAL_BASE, configured_origin: BASE, rendered_client_evidence: false,
    public_network_tested: false, tls_tested: false, fabricated_authority_messages: false, phases: [] } };
  const phase = async (name, fn) => {
    let failure;
    await t.test(name, async () => {
      const started = Date.now();
      try { await fn(); context.evidence.phases.push({ name, status: 'passed', elapsed_ms: Date.now() - started }); }
      catch (error) { failure = error; context.evidence.phases.push({ name, status: 'failed', error: safeText(error.message) }); throw error; }
    });
    if (failure) throw new Error(`Dependent proxy phases stopped after: ${name}`, { cause: failure });
  };
  try {
    await phase('independent backend, proxy and actual immutable Godot release are available', async () => {
      await service.start(); await proxy.start();
      assert.equal((await api('/health')).data.ok, true);
      assert.match(service.logTail, /bind 127\.0\.0\.1:48921/);
      const suffix = randomUUID().slice(0, 8);
      context.owner = (await api('/api/auth/register', { method: 'POST', body: { name: `proxy_owner_${suffix}`, password: `Test-${randomUUID()}` }, status: 201 })).data;
      context.projectId = (await api('/api/projects', { account: context.owner, method: 'POST', body: { name: `Local proxy fixture ${suffix}` } })).data.project.id;
      const built = await build(context.owner, context.projectId, 'main', TARGET_RUNTIME);
      context.release = built.release;
      assert.equal(context.release.runtime_hash, TARGET_RUNTIME);
      context.worldId = (await api(`/api/projects/${context.projectId}/worlds`, { account: context.owner, method: 'POST', body: { branch: 'main', name: 'Local proxy world' } })).data.world.id;
      context.host = await assertAuthority(service.child.pid, context.worldId, context.release);
      context.evidence.fixture = { build_id: built.build.id, release_id: context.release.id, authority: context.host };
    });
    await phase('prepare-join and actual Web entry use the configured origin despite forwarded header claims', async () => {
      context.checkout = await checkout(context.owner, context.projectId, context.worldId, 'main', context.release.id);
      const prepared = context.checkout.prepared;
      assert.equal(prepared.server_url, `ws://127.0.0.1:${PROXY_PORT}`);
      const gameUrl = new URL(prepared.game_url, BASE);
      assert.equal(gameUrl.origin, BASE);
      assert.equal(gameUrl.searchParams.get('server'), prepared.server_url);
      assert.equal(gameUrl.searchParams.get('ticket'), prepared.ticket);
      const response = await fetch(gameUrl, { signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      const html = await response.text(); assert.ok(html.length > 1000); assert.match(html, /index\.js/);
      const forged = (await api(`/api/checkouts/${context.checkout.fixed.checkout.id}/prepare-join`, { account: context.owner, method: 'POST', body: {},
        extraHeaders: { Host: 'untrusted.invalid:9999', Forwarded: 'host=untrusted.invalid:9999;proto=https', 'X-Forwarded-Host': 'untrusted.invalid:9999' } })).data;
      assert.equal(forged.server_url, prepared.server_url, 'Client destination must come from explicit configuration.');
      context.evidence.routing = { server_url: prepared.server_url, game_path: gameUrl.pathname, web_entry_bytes: Buffer.byteLength(html),
        explicit_origin_ignores_forwarded_claim: true };
    });
    await phase('a real protocol client enters through the proxy and receives authoritative movement and pickup', async () => {
      const peer = new ProtocolClient('proxied player'); probes.push(peer);
      await peer.connect(context.checkout.prepared); await peer.loaded();
      assert.equal(peer.world_id, context.worldId); assert.equal(peer.release_id, context.release.id);
      assert.equal(peer.user_id, context.owner.user.id);
      const pickup = await peer.command('interact', { object_id: 'landing_crystal_0' }); assert.equal(pickup.ok, true);
      const collected = await peer.snapshot(packet => packet.state.objects.landing_crystal_0?.collected === true);
      assert.equal(collected.state.players[peer.user_id].crystals, 2);
      const movement = await movementPerTick(peer); assert.ok(movement.per_tick > 0.1);
      assert.equal((await assertAuthority(service.child.pid, context.worldId, context.release)).pid, context.host.pid);
      assert.equal(proxy.upgrades.length, 1); assert.equal(proxy.upgrades[0].path, '/play');
      assert.ok(proxy.upgrades[0].client_bytes > 100); assert.ok(proxy.upgrades[0].server_bytes > 1000);
      assert.deepEqual(proxy.errors, []);
      assert.ok(proxy.requests.some(item => item.path === context.evidence.routing.game_path && item.status === 200));
      context.evidence.play = { world_id: peer.world_id, release_id: peer.release_id, epoch: peer.epoch, user_id: peer.user_id,
        pickup_ack_sequence: pickup.sequence, collected_snapshot_sequence: collected.sequence, movement, authority_pid: context.host.pid };
    });
  } finally {
    await Promise.allSettled(probes.map(peer => peer.close()));
    await proxy.stop(); await service.stop();
    context.evidence.server_launches = service.children;
    context.evidence.proxy_requests = proxy.requests; context.evidence.proxy_upgrades = proxy.upgrades;
    context.evidence.proxy_errors = proxy.errors;
    await appendFile(join(directory, 'observations.json'), JSON.stringify(context.evidence, null, 2));
    t.diagnostic(`Public-address observations: ${directory}/observations.json. A loopback HTTP reverse proxy and a WS protocol client do not prove public deployment, TLS, Web rendering or native client UI.`);
  }
});
