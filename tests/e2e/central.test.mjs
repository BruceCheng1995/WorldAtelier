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

test('real central service, isolated persistence and Godot authority E2E', { timeout: 12 * 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-atelier-central-e2e-'));
  const service = new Service(directory);
  const probes = [];
  const context = { accounts: {}, evidence: { kind: 'independent-protocol-e2e', rendered_client_evidence: false, agent_execution: false, directory, phases: [] } };
  t.diagnostic(`Isolated data and logs: ${directory}`);
  const phase = async (name, fn) => {
    let failed;
    await t.test(name, async () => {
      const started = Date.now();
      try { await fn(); context.evidence.phases.push({ name, status: 'passed', elapsed_ms: Date.now() - started }); }
      catch (error) { failed = error; context.evidence.phases.push({ name, status: 'failed', error: safeText(error.message) }); throw error; }
    });
    if (failed) throw new Error(`Dependent E2E phases stopped after: ${name}`, { cause: failed });
  };
  const connect = async (account, label) => {
    const resolved = await checkout(account, context.projectId, context.worldId);
    const probe = new ProtocolClient(label); probes.push(probe);
    await probe.connect(resolved.prepared);
    return probe;
  };
  try {
    await phase('isolated real server starts; independent accounts and project namespaces', async () => {
      await service.start();
      await api('/api/projects', { status: 401 });
      const suffix = randomUUID().slice(0, 8);
      for (const role of ['owner', 'editor', 'tester', 'viewer', 'outsider']) {
        const name = `e2e_${role}_${suffix}`, password = `Test-${randomUUID()}`;
        const registered = (await api('/api/auth/register', { method: 'POST', body: { name, password }, status: 201 })).data;
        assert.ok(registered.token && registered.user?.id);
        context.accounts[role] = { ...registered, password, name };
      }
      const { owner, outsider, editor, tester, viewer } = context.accounts;
      const projectKey = randomUUID(), projectRequest = { account: owner, method: 'POST', body: { name: `Alpha ${suffix}` }, idempotencyKey: projectKey };
      const createdProjects = await Promise.all([api('/api/projects', projectRequest), api('/api/projects', projectRequest)]);
      context.projectId = createdProjects[0].data.project.id;
      assert.equal(createdProjects[1].data.project.id, context.projectId, 'Concurrent retries must resolve to one actual project.');
      await api('/api/projects', { ...projectRequest, body: { name: 'A different operation reusing the same key' }, status: 409 });
      context.otherProjectId = (await api('/api/projects', { account: outsider, method: 'POST', body: { name: `Beta ${suffix}` } })).data.project.id;
      for (const [role, account] of Object.entries({ editor, tester, viewer })) await api(`/api/projects/${context.projectId}/members`, { account: owner, method: 'POST', body: { name: account.name, role } });
      assert.deepEqual((await api('/api/projects', { account: owner })).data.projects.map(p => p.id), [context.projectId]);
      assert.deepEqual((await api('/api/projects', { account: outsider })).data.projects.map(p => p.id), [context.otherProjectId]);
      await api(`/api/projects/${context.projectId}`, { account: outsider, status: [403, 404] });
      await api(`/api/projects/${context.otherProjectId}`, { account: owner, status: [403, 404] });
      const alpha = await content(owner, context.projectId), beta = await content(outsider, context.otherProjectId);
      assert.ok(alpha.content.zones.length >= 4, 'The game seed must include its four authored areas. This does not prove they have been played.');
      const changed = clone(alpha.content); changed.revision_label = 'alpha-only-edit';
      await commit(owner, context.projectId, 'main', alpha.revision, changed);
      assert.deepEqual((await content(outsider, context.otherProjectId)).content, beta.content, 'Creating or editing another project must not overwrite a shared revision record.');
    });

    await phase('membership and write roles are enforced by the API', async () => {
      const { owner, editor, tester, viewer } = context.accounts;
      const base = await content(owner, context.projectId);
      for (const account of [tester, viewer]) {
        await api(`/api/projects/${context.projectId}/branches/main/commit`, { account, method: 'POST', body: { base_revision: base.revision, content: base.content }, status: 403 });
        await api(`/api/projects/${context.projectId}/branches/main/build`, { account, method: 'POST', body: {}, status: 403 });
      }
      await api(`/api/projects/${context.projectId}/members`, { account: editor, method: 'POST', body: { name: viewer.name, role: 'editor' }, status: 403 });
      await api(`/api/projects/${context.projectId}/tasks`, { account: viewer, method: 'POST', body: { branch: 'main', object_id: base.content.objects[0].id, title: 'must reject' }, status: 403 });
      await api(`/api/projects/${context.projectId}/members`, { account: owner, method: 'POST', body: { name: owner.name, role: 'viewer' }, status: 400 });
      assert.deepEqual((await content(owner, context.projectId)).content, base.content);
    });

    await phase('offline three-way merge preserves disjoint edits and rejects real conflicts', async () => {
      const { owner, editor } = context.accounts, projectId = context.projectId;
      await api(`/api/projects/${projectId}/branches`, { account: editor, method: 'POST', body: { name: 'experiment', from_branch: 'main' } });
      const exported = (await api(`/api/projects/${projectId}/branches/experiment/offline`, { account: editor })).data;
      assert.equal(exported.format, 1); assert.equal(exported.project_id, projectId);
      const remote = clone(exported.content); remote.rules.attack_damage += 1;
      await commit(owner, projectId, 'experiment', exported.base_revision, remote, 'Remote edit while workspace is offline');
      const local = clone(exported.content); local.objects[0].name += ' · offline';
      await api(`/api/projects/${projectId}/branches/experiment/import`, { account: editor, method: 'POST', body: { ...exported, content: local } });
      const merged = await content(editor, projectId, 'experiment');
      assert.equal(merged.content.rules.attack_damage, remote.rules.attack_damage);
      assert.equal(merged.content.objects[0].name, local.objects[0].name);
      const conflicting = clone(exported.content); conflicting.rules.attack_damage += 3;
      const conflict = await api(`/api/projects/${projectId}/branches/experiment/commit`, { account: editor, method: 'POST', body: { base_revision: exported.base_revision, content: conflicting }, status: 409 });
      assert.ok(conflict.data.details?.conflicts?.length, 'Conflict must identify actual conflicting content paths.');
      assert.equal((await content(editor, projectId, 'experiment')).revision, merged.revision);
      const main = await content(owner, projectId), mainEdit = clone(main.content); mainEdit.rules.enemy_damage += 1;
      await commit(owner, projectId, 'main', main.revision, mainEdit);
      await api(`/api/projects/${projectId}/branches/experiment/merge`, { account: editor, method: 'POST', body: { target: 'main' } });
      const combined = await content(owner, projectId);
      assert.equal(combined.content.rules.attack_damage, remote.rules.attack_damage);
      assert.equal(combined.content.rules.enemy_damage, mainEdit.rules.enemy_damage);
      assert.equal(combined.content.objects[0].name, local.objects[0].name);
      context.taskObjectId = combined.content.objects[0].id;
      await api(`/api/projects/${projectId}/branches`, { account: editor, method: 'POST', body: { name: 'merge_conflict', from_branch: 'main' } });
      const branchChange = clone(combined.content); branchChange.title = 'branch title';
      await commit(editor, projectId, 'merge_conflict', combined.revision, branchChange);
      const mainChange = clone(combined.content); mainChange.title = 'main title';
      const mainRevision = await commit(owner, projectId, 'main', combined.revision, mainChange);
      await api(`/api/projects/${projectId}/branches/merge_conflict/merge`, { account: editor, method: 'POST', body: { target: 'main' }, status: 409 });
      assert.equal((await content(owner, projectId)).revision, mainRevision.revision);
    });

    await phase('real Godot validation publishes immutable desktop and Web artifacts', async () => {
      const { owner } = context.accounts;
      const result = await build(owner, context.projectId, 'main');
      context.originalRelease = result.release;
      assert.ok(result.release.artifacts.some(a => a.platform === 'web'), 'Actual Web export missing.');
      assert.ok(result.release.artifacts.some(a => a.platform === 'macos'), 'Actual macOS export missing.');
      context.evidence.artifacts = [];
      for (const artifact of result.release.artifacts) context.evidence.artifacts.push(await verifyArtifact(artifact));
      context.evidence.initial_build = { id: result.build.id, revision: result.build.revision, release_id: result.release.id, runtime_hash: result.release.runtime_hash };
    });

    await phase('real authority and two independent clients share gameplay without client-supplied state', async () => {
      const { owner, editor, outsider } = context.accounts;
      context.worldId = (await api(`/api/projects/${context.projectId}/worlds`, { account: owner, method: 'POST', body: { branch: 'main', name: 'Independent E2E world' } })).data.world.id;
      const running = await until('real world running', async () => { const w = await world(owner, context.worldId); if (w.status === 'failed') throw Error(w.error); return w.status === 'running' && w.state ? w : null; });
      context.authority = await assertAuthority(service.child.pid, context.worldId, context.originalRelease);
      context.originalEpoch = running.epoch;
      context.evidence.authority = context.authority;
      await api(`/api/worlds/${context.worldId}`, { account: outsider, status: [403, 404] });
      context.a = await connect(owner, 'owner protocol peer');
      context.b = await connect(editor, 'editor protocol peer');
      await context.a.loaded(); await context.b.loaded();
      assert.notEqual(context.a.user_id, context.b.user_id);
      assert.equal(context.a.world_id, context.b.world_id);
      await context.a.snapshot(s => s.state.players[owner.user.id] && s.state.players[editor.user.id]);
      context.b.autoSnapshotAck = false;
      const slowCursor = context.b.counter;
      const held = await context.b.wait(message => message.type === 'snapshot', slowCursor);
      const progressed = await until('authority continues while a client withholds snapshot consumption ACK', async () => {
        const value = await world(owner, context.worldId); return value.state.tick > held.state.tick + 9 ? value : null;
      });
      const withheldSnapshots = context.b.records.filter(record => record.index > slowCursor && record.message.type === 'snapshot');
      assert.equal(withheldSnapshots.length, 1, 'A paused reader must receive at most one unacknowledged snapshot, not an accumulating stream.');
      context.b.autoSnapshotAck = true; context.b.acknowledgeSnapshot(held);
      const caughtUp = await context.b.snapshot(snapshot => snapshot.sequence >= progressed.sequence);
      context.evidence.snapshot_backpressure = { held_sequence: held.sequence, progressed_sequence: progressed.sequence,
        caught_up_sequence: caughtUp.sequence, unacknowledged_snapshot_count: withheldSnapshots.length };
      const before = clone(context.a.state.players[owner.user.id]);
      const pickup = await context.a.command('interact', { object_id: 'landing_crystal_0' });
      assert.equal(pickup.ok, true, JSON.stringify(pickup));
      const shared = await context.b.snapshot(s => s.state.objects.landing_crystal_0?.collected === true && s.state.players[owner.user.id]?.crystals === before.crystals + 2);
      assert.ok(pickup.sequence > 0);
      rejected(await context.a.command('interact', { object_id: 'landing_crystal_0' }), 'duplicate pickup');
      rejected(await context.b.command('interact', { object_id: 'landing_crystal_0' }), 'shared pickup already collected');
      const otherPickup = await context.b.command('interact', { object_id: 'landing_crystal_1' });
      assert.equal(otherPickup.ok, true, JSON.stringify(otherPickup));
      rejected(await context.a.command('set_state', { crystals: 999999, x: 99999 }), 'arbitrary client state');
      const repeated = { type: 'command', request_id: randomUUID(), epoch: context.a.epoch, release_id: context.a.release_id,
        control_generation: context.a.control_generation, action: 'interact', payload: { object_id: 'landing_crystal_2' } };
      const duplicateCursor = context.a.counter;
      context.a.send(repeated); context.a.send(repeated);
      const duplicateAcks = await until('two real responses to simultaneous duplicate input', () => {
        const responses = context.a.records.filter(record => record.index > duplicateCursor && record.message.type === 'ack' && record.message.request_id === repeated.request_id).map(record => record.message);
        return responses.length >= 2 ? responses : null;
      });
      assert.equal(duplicateAcks[0].ok, true, JSON.stringify(duplicateAcks[0]));
      assert.deepEqual(duplicateAcks[1], duplicateAcks[0], 'Duplicate in-flight input must share one durable authority outcome.');
      const replay = await context.a.command(repeated.action, repeated.payload, { request_id: repeated.request_id });
      assert.deepEqual(replay, duplicateAcks[0], 'Completed input retry must replay the same stored authority outcome.');
      rejected(await context.a.command('move', { x: 0, z: 0 }, { request_id: repeated.request_id }), 'request ID reused for a different gameplay operation');
      const state = await context.a.snapshot(s => s.state.objects.landing_crystal_1?.collected === true && s.state.objects.landing_crystal_2?.collected === true);
      assert.equal(state.state.players[owner.user.id].crystals, shared.state.players[owner.user.id].crystals + 2);
      context.evidence.command_retries = { request_id: repeated.request_id, response_sequence: duplicateAcks[0].sequence, simultaneous_ack_count: duplicateAcks.length };
      context.progress = { owner_crystals: state.state.players[owner.user.id].crystals, editor_crystals: state.state.players[editor.user.id].crystals };
      context.speedBefore = await movementPerTick(context.a);
      context.pinned = (await checkout(owner, context.projectId, context.worldId)).fixed;
    });

    await phase('offline content import cannot overwrite online progress or implicitly apply a release', async () => {
      const { owner } = context.accounts;
      const workspace = (await api(`/api/projects/${context.projectId}/branches/main/offline`, { account: owner })).data;
      const changed = clone(workspace.content); changed.revision_label = 'offline-source-only';
      await api(`/api/projects/${context.projectId}/branches/main/import`, { account: owner, method: 'POST', body: {
        ...workspace, content: changed, state: { players: { [owner.user.id]: { crystals: 999999, x: 99999 } } }, progress: { quest_stage: 9999 },
      } });
      const after = await world(owner, context.worldId);
      assert.equal(after.release_id, context.originalRelease.id);
      assert.equal(after.state.players[owner.user.id].crystals, context.progress.owner_crystals);
      assert.equal(after.state.objects.landing_crystal_0.collected, true);
      assert.equal((await content(owner, context.projectId)).content.revision_label, 'offline-source-only');
    });

    await phase('branch-scoped task transitions require a real matching world application', async () => {
      const { owner, editor } = context.accounts;
      context.task = (await api(`/api/projects/${context.projectId}/tasks`, { account: editor, method: 'POST', body: { branch: 'main', object_id: context.taskObjectId, title: 'E2E explicit task fixture: content update' } })).data.task;
      const foreign = (await api(`/api/projects/${context.projectId}/tasks`, { account: editor, method: 'POST', body: { branch: 'experiment', object_id: context.taskObjectId, title: 'E2E fixture in another branch' } })).data.task;
      await context.a.snapshot(s => s.state.tasks?.some(item => item.id === context.task.id && item.status === 'editing'));
      const current = await context.b.snapshot(s => s.state.tasks?.some(item => item.id === context.task.id));
      assert.ok(!current.state.tasks.some(item => item.id === foreign.id), 'Other branch task must not enter this world.');
      await api(`/api/tasks/${context.task.id}`, { account: owner, method: 'PATCH', body: { status: 'delivered' }, status: 400 });
      await api(`/api/tasks/${context.task.id}`, { account: owner, method: 'PATCH', body: { status: 'testing' } });
      await context.a.snapshot(s => s.state.tasks?.some(item => item.id === context.task.id && item.status === 'testing'));
      const failed = (await api(`/api/projects/${context.projectId}/tasks`, { account: owner, method: 'POST', body: { branch: 'main', object_id: context.taskObjectId, title: 'E2E explicit failed-task fixture' } })).data.task;
      await api(`/api/tasks/${failed.id}`, { account: owner, method: 'PATCH', body: { status: 'failed' } });
      await context.b.snapshot(s => s.state.tasks?.some(item => item.id === failed.id && item.status === 'failed'));
    });

    await phase('compatible content hot update uses real host ACK, fences old peers and preserves progress', async () => {
      const { owner, editor } = context.accounts;
      const base = await content(owner, context.projectId), changed = clone(base.content);
      changed.rules.player_speed = Number(base.content.rules.player_speed) * 1.5;
      const taskObject = changed.objects.find(item => item.id === context.taskObjectId);
      taskObject.color = taskObject.color === '#ffb42b' ? '#ffd84a' : '#ffb42b';
      await commit(editor, context.projectId, 'main', base.revision, changed, 'Actual E2E speed and object appearance update');
      const result = await build(owner, context.projectId, 'main'); context.newRelease = result.release;
      assert.notEqual(result.release.id, context.originalRelease.id);
      assert.equal(result.release.runtime_hash, context.originalRelease.runtime_hash, 'This scenario requires compatible content within the same real runtime build.');
      const pinnedPrepare = (await api(`/api/checkouts/${context.pinned.checkout.id}/prepare-join`, { account: owner, method: 'POST', body: {} })).data;
      assert.equal(pinnedPrepare.release_id, context.originalRelease.id, 'A source/playable head advance must not rewrite an already resolved checkout.');
      await verifyArtifact(context.originalRelease.artifacts[0]);
      const aCursor = context.a.counter, bCursor = context.b.counter;
      let applyFailure;
      const applying = api(`/api/worlds/${context.worldId}/apply-latest`, { account: owner, method: 'POST', body: {}, timeout: 40_000 })
        .catch(error => { applyFailure = error; return null; });
      const waitContent = (client, cursor) => until(`actual content application to ${client.label}`, () => {
        if (applyFailure) throw applyFailure;
        return client.records.find(record => record.index > cursor && record.message.type === 'content' && record.message.release_id === result.release.id)?.message;
      });
      const seen = await waitContent(context.a, aCursor);
      await waitContent(context.b, bCursor);
      assert.equal(seen.content.rules.player_speed, changed.rules.player_speed);
      rejected(await context.a.command('move', { x: 1, z: 0 }, { release_id: context.originalRelease.id }), 'stale content command');
      await context.a.loaded(result.release.id); await context.b.loaded(result.release.id);
      const applicationResponse = await applying;
      if (applyFailure) throw applyFailure;
      const applied = applicationResponse.data;
      assert.equal(applied.ok, true); assert.ok(applied.sequence > 0);
      const authoritative = await world(owner, context.worldId);
      assert.equal(authoritative.release_id, result.release.id);
      assert.equal(authoritative.epoch, context.originalEpoch);
      assert.equal(authoritative.state.players[owner.user.id].crystals, context.progress.owner_crystals);
      assert.equal(authoritative.state.players[editor.user.id].crystals, context.progress.editor_crystals);
      assert.equal(authoritative.state.objects.landing_crystal_0.collected, true);
      assert.equal((await assertAuthority(service.child.pid, context.worldId, context.newRelease)).pid, context.authority.pid, 'Compatible JSON update must not relaunch the world authority.');
      const speedAfter = await movementPerTick(context.a);
      assert.ok(speedAfter.per_tick / context.speedBefore.per_tick > 1.2, `Real movement did not change with speed content: ${JSON.stringify({ before: context.speedBefore, after: speedAfter })}`);
      context.evidence.movement = { before: context.speedBefore, after: speedAfter };
      const tasks = (await project(owner, context.projectId)).tasks;
      assert.equal(tasks.find(item => item.id === context.task.id).status, 'delivered');
      await context.a.snapshot(s => s.state.tasks?.some(item => item.id === context.task.id && item.status === 'delivered'));
      await api(`/api/checkouts/${context.pinned.checkout.id}/prepare-join`, { account: owner, method: 'POST', body: {}, status: 409 });
      context.evidence.content_application = { release_id: result.release.id, sequence: applied.sequence, authority_pid: context.authority.pid };
    });

    await phase('a bad candidate fails actual validation and leaves playable and live versions intact', async () => {
      const { owner } = context.accounts;
      const before = await content(owner, context.projectId), broken = clone(before.content);
      broken.rules.player_speed = -1; // structurally valid JSON, rejected by the real Godot content parser.
      await commit(owner, context.projectId, 'main', before.revision, broken, 'Intentional invalid content candidate');
      const failed = await build(owner, context.projectId, 'main', 'failed');
      const metadata = await project(owner, context.projectId);
      assert.equal(metadata.branches.find(item => item.name === 'main').playable_head, context.newRelease.id);
      const stillRunning = await world(owner, context.worldId);
      assert.equal(stillRunning.status, 'running'); assert.equal(stillRunning.release_id, context.newRelease.id);
      assert.equal(stillRunning.state.players[owner.user.id].crystals, context.progress.owner_crystals);
      const tick = stillRunning.state.tick;
      await context.a.snapshot(s => s.state.tick > tick + 4);
      assert.equal((await assertAuthority(service.child.pid, context.worldId, context.newRelease)).pid, context.authority.pid);
      context.evidence.failed_candidate = { build_id: failed.build.id, status: failed.build.status, error: safeText(failed.build.error) };
      const head = await content(owner, context.projectId);
      await commit(owner, context.projectId, 'main', head.revision, before.content, 'Restore source after explicit invalid-candidate test');
    });

    await phase('same-user handoff and reconnect retain one controller and preserve actor progress', async () => {
      const { owner } = context.accounts, old = context.a;
      const replacement = await connect(owner, 'replacement owner protocol peer');
      assert.equal((await old.command('move', { x: 0, z: 0 })).ok, true, 'Preparing replacement must leave original control usable.');
      rejected(await replacement.command('attack'), 'not-yet-loaded replacement');
      const oldCursor = old.counter;
      await replacement.loaded();
      await old.wait(m => m.type === 'revoked', oldCursor);
      rejected(await old.command('attack'), 'revoked old controller');
      const loadedCursor = old.counter;
      old.send({ type: 'loaded', release_id: context.newRelease.id });
      const refusal = await old.wait(m => m.type === 'error' || m.type === 'active', loadedCursor);
      assert.equal(refusal.type, 'error', 'A revoked connection must not reacquire control by repeating loaded.');
      const state = await replacement.snapshot(s => s.state.players[owner.user.id]);
      assert.equal(state.state.players[owner.user.id].crystals, context.progress.owner_crystals);
      assert.equal(Object.keys(state.state.players).filter(id => id === owner.user.id).length, 1);
      const contenders = [await connect(owner, 'simultaneous owner peer A'), await connect(owner, 'simultaneous owner peer B')];
      const cursors = contenders.map(peer => peer.counter), replacementCursor = replacement.counter;
      for (const peer of contenders) peer.send({ type: 'loaded', release_id: context.newRelease.id });
      await replacement.wait(m => m.type === 'revoked', replacementCursor);
      await until('concurrent loaded requests settle with one active controller', () => {
        const answered = contenders.every((peer, index) => peer.records.some(record => record.index > cursors[index] && ['active', 'revoked', 'error'].includes(record.message.type)));
        return answered && contenders.filter(peer => peer.active).length === 1;
      });
      const winner = contenders.find(peer => peer.active), loser = contenders.find(peer => !peer.active);
      assert.equal((await winner.command('move', { x: 0, z: 0 })).ok, true);
      rejected(await loser.command('attack'), 'simultaneous handoff loser');
      if (loser.records.some(record => record.message.type === 'active')) {
        assert.ok(loser.records.some(record => record.message.type === 'revoked'), 'A previously activated losing connection must receive explicit revocation.');
      }
      context.evidence.concurrent_handoff = { active_count: contenders.filter(peer => peer.active).length, winner_generation: winner.control_generation };
      await old.close(); await replacement.close();
      for (const peer of contenders) await peer.close();
      context.a = await connect(owner, 'reconnected owner protocol peer'); await context.a.loaded();
      const rejoined = await context.a.snapshot(s => s.state.players[owner.user.id]);
      assert.equal(rejoined.state.players[owner.user.id].crystals, context.progress.owner_crystals);
      assert.equal(rejoined.state.objects.landing_crystal_0.collected, true);
    });

    await phase('server and authority restart restore durable state and reject an old epoch', async () => {
      const { owner, editor } = context.accounts;
      const before = await world(owner, context.worldId);
      await Promise.all(probes.map(probe => probe.close()));
      await service.stop(); await service.start();
      for (const account of [owner, editor]) {
        const login = (await api('/api/auth/login', { method: 'POST', body: { name: account.name, password: account.password } })).data;
        assert.equal(login.user.id, account.user.id); account.token = login.token;
      }
      const restored = await until('authority restores after service restart', async () => {
        const value = await world(owner, context.worldId);
        if (value.status === 'failed') throw new Error(`Restoration failed: ${value.error}`);
        return value.status === 'running' && value.state ? value : null;
      }, 35_000);
      assert.ok(restored.epoch > before.epoch, 'Restored authority must fence the previous epoch.');
      assert.equal(restored.release_id, before.release_id);
      assert.equal(restored.state.players[owner.user.id].crystals, context.progress.owner_crystals);
      assert.equal(restored.state.players[editor.user.id].crystals, context.progress.editor_crystals);
      assert.equal(restored.state.objects.landing_crystal_0.collected, true);
      assert.ok(restored.sequence >= before.sequence);
      const host = await assertAuthority(service.child.pid, context.worldId, context.newRelease);
      assert.notEqual(host.pid, context.authority.pid, 'This phase intentionally tests cross-process recovery, not hot reload.');
      context.a = await connect(owner, 'post-restart owner protocol peer'); await context.a.loaded();
      rejected(await context.a.command('attack', {}, { epoch: before.epoch }), 'pre-restart authority epoch');
      assert.equal((await context.a.command('move', { x: 0, z: 0 })).ok, true);
      context.evidence.restoration = { old_epoch: before.epoch, new_epoch: restored.epoch, authority: host, sequence: restored.sequence };
    });
  } finally {
    await Promise.allSettled(probes.map(probe => probe.close()));
    await service.stop();
    context.evidence.server_launches = service.children;
    // Only per-phase observations, never a fabricated full-acceptance verdict.
    await appendFile(join(directory, 'observations.json'), JSON.stringify(context.evidence, null, 2));
    t.diagnostic(`Protocol E2E observations retained at ${directory}/observations.json. Rendered Web/native gameplay, Codex execution and script/module hot reload remain separate acceptance work.`);
  }
});
