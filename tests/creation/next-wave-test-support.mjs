// Independent 2026-10-23 acceptance support. No product state, runtime ACK or
// feature result is fabricated here. Functional drivers opt in to each layer.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
export const PORT = 48921;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const delay = ms => new Promise(done => setTimeout(done, ms));

// Chrome resolves the reserved *.localhost origin itself. Node's system DNS
// does not on every host, so transport-only probes connect the same loopback
// listener with the actual runtime Host. Browser tests use the normal URL and
// never install a custom resolver or a secure-context override.
export async function runtimeFetch(input,options={}) {
  const url=new URL(input);
  if(url.hostname!=='wa-runtime.localhost')return fetch(url,options);
  assert.equal(url.protocol,'http:');assert.equal(Number(url.port),PORT);
  return new Promise((done,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:PORT,path:url.pathname+url.search,method:options.method??'GET',headers:{...options.headers,Host:url.host}},res=>{
      const chunks=[];let size=0;
      res.on('data',bytes=>{size+=bytes.length;if(size>4*1024*1024){req.destroy(Error('Independent runtime HTTP probe exceeded 4 MiB'));return;}chunks.push(bytes);});
      res.on('end',()=>done(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });
    req.setTimeout(15000,()=>req.destroy(Error('Independent runtime HTTP probe timed out')));req.on('error',reject);req.end(options.body);
  });
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(?:authorization|cookie|set-cookie|token|password|ticket|host_key|worker_token|access_token)$/i.test(key) ? '[redacted]' : redact(item)]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9_.~-]+/g, '$1[redacted]')
    .replace(/(\/creation-runtime\/)[A-Za-z0-9_-]{43}(\/)/g, '$1[grant]$2')
    .replace(/([?&](?:ticket|token|cap|grant)=)[^&\s"']+/g, '$1[redacted]')
    .replace(/((?:atelier_release|wa_admin)=)[^;\s]+/g, '$1[redacted]')
    .replace(/("(?:token|password|ticket|host_key|worker_token)"\s*:\s*")[^"]+/g, '$1[redacted]')
    .replace(/(--host-key=)[^\s]+/g, '$1[redacted]');
}

export async function waitFor(label, read, {timeout = 15000, interval = 50} = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(interval);
  }
  throw new Error(`Timed out: ${label} (${timeout} ms)`);
}

export function implementationSnapshot(root = ROOT) {
  const names = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {cwd: root, encoding: 'utf8'}).trim().split('\n');
  const included = names.filter(name => /^(?:apps\/creation-workspace\/|services\/(?:creation|preview)\/|tools\/|packages\/|tests\/creation\/next-wave-|docs\/CREATION-NEXT-WAVE-)/.test(name));
  const files = Object.fromEntries([...new Set(included)].filter(name => existsSync(join(root, name))).sort().map(name => [name, sha256(readFileSync(join(root, name)))]));
  const productFiles = Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith('tests/') && !name.startsWith('docs/')));
  return {
    root,
    head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    working_tree: execFileSync('git', ['status', '--short'], {cwd: root, encoding: 'utf8'}).trim().split('\n').filter(Boolean),
    files,
    identity: sha256(JSON.stringify(files)),
    product_identity: sha256(JSON.stringify(productFiles)),
  };
}

export class Evidence {
  constructor(name, {layers = [], root = ROOT, scope = ''} = {}) {
    assert.match(name, /^[a-z0-9-]+$/);
    this.root = realpathSync(root);
    this.directory = join(ROOT, '.local/creation-verification/next-wave', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    mkdirSync(this.directory, {recursive: true});
    this.report = {format: 1, name, scope, layers, started_at: new Date().toISOString(), completed: false, cases: [], processes: [], errors: [], source: implementationSnapshot(this.root), versions: {node: process.versions.node}, boundary: {positive_runtime_acks: 'Only the actual Godot client may produce positive runtime ACKs; test drivers never fabricate them.'}};
    this.save();
  }
  save() { writeFileSync(join(this.directory, 'report.json'), JSON.stringify(redact(this.report), null, 2) + '\n'); }
  json(name, value) {
    assert.ok(!name.includes('..') && !name.startsWith('/'));
    const destination = join(this.directory, name); mkdirSync(dirname(destination), {recursive: true});
    writeFileSync(destination, JSON.stringify(redact(value), null, 2) + '\n');
    return destination;
  }
  text(name, value) {
    assert.ok(!name.includes('..') && !name.startsWith('/'));
    const destination = join(this.directory, name); mkdirSync(dirname(destination), {recursive: true});
    writeFileSync(destination, redact(String(value)));
    return destination;
  }
  async check(id, description, layers, execute) {
    const receipt = {id, description, layers, status: 'running', started_at: new Date().toISOString()};
    this.report.cases.push(receipt); this.save();
    try { await execute(receipt); receipt.status = 'passed'; }
    catch (error) { receipt.status = 'failed'; receipt.error = {message: error.message, stack: error.stack}; throw error; }
    finally { receipt.finished_at = new Date().toISOString(); this.save(); }
    return receipt;
  }
  finish({completed = false} = {}) {
    this.report.completed = completed && this.report.cases.length > 0 && this.report.cases.every(item => item.status === 'passed') && this.report.errors.length === 0;
    this.report.finished_at = new Date().toISOString();
    const after = implementationSnapshot(this.root);
    this.report.source_after = {head: after.head, identity: after.identity, product_identity: after.product_identity};
    this.report.source_changed_during_execution = after.identity !== this.report.source.identity;
    this.report.product_changed_during_execution = after.product_identity !== this.report.source.product_identity;
    this.save();
    return this.directory;
  }
}

export async function requireFreeTestPort() {
  await new Promise((done, reject) => {
    const server = createServer();
    server.once('error', error => reject(new Error(`Independent test port ${PORT} is unavailable; refusing to attach or stop its owner: ${error.code}`)));
    server.listen(PORT, '127.0.0.1', () => server.close(done));
  });
}

export class IsolatedService {
  constructor(evidence, {agent = false, worlds = false, publicPlay = true, lan = false, environment = {}, data = null} = {}) {
    this.evidence = evidence; this.root = evidence.root;
    this.data = data ? realpathSync(data) : mkdtempSync(join(tmpdir(), 'atelier-next-wave-'));
    const formal = realpathSync(join(ROOT, '.local/model-preview'));
    assert.ok(this.data !== formal && !this.data.startsWith(formal + sep), 'Test data must not overlap product data.');
    this.creationData = join(this.data, 'creation');
    this.settings = {agent, worlds, publicPlay, lan, environment};
    this.log = ''; this.child = null;
  }
  async start() {
    assert.equal(this.child, null, 'Only one owned service at a time.');
    await requireFreeTestPort();
    const env = {...process.env};
    for (const key of Object.keys(env)) if (key.startsWith('WORLD_ATELIER_') || key.startsWith('WA_WORKER_')) delete env[key];
    Object.assign(env, this.settings.environment, {
      WORLD_ATELIER_PREVIEW_PORT: String(PORT),
      WORLD_ATELIER_PREVIEW_DATA: this.data,
      WORLD_ATELIER_CREATION_DATA: this.creationData,
      WORLD_ATELIER_DISABLE_AGENT: this.settings.agent ? '0' : '1',
      WORLD_ATELIER_DISABLE_WORLDS: this.settings.worlds ? '0' : '1',
      WORLD_ATELIER_PUBLIC_PLAY: this.settings.publicPlay ? '1' : '0',
      WORLD_ATELIER_LAN: this.settings.lan ? '1' : '0',
    });
    const child = this.child = spawn(process.execPath, ['services/preview/server.mjs'], {cwd: this.root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    const processReceipt = {pid: child.pid, role: 'isolated-preview-service', port: PORT, data: this.data, started_at: new Date().toISOString()};
    this.evidence.report.processes.push(processReceipt);
    const append = bytes => { this.log += redact(bytes.toString()); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    this.exited = new Promise(done => child.once('exit', (code, signal) => {Object.assign(processReceipt, {code, signal, finished_at: new Date().toISOString()}); done();}));
    child.once('error', error => { this.startError = error; });
    await waitFor('isolated creation service readiness', async () => {
      if (this.startError) throw this.startError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned service exited during startup: ' + this.log.slice(-4000));
      try {
        const response = await fetch(ORIGIN + '/creation-api/health', {signal: AbortSignal.timeout(750)});
        if (!response.ok) return null;
        const health = await response.json(); return health.ok ? health : null;
      } catch { return null; }
    }, {timeout: 30000});
    this.evidence.report.service = {origin: ORIGIN, root: this.root, data: this.data, settings: {agent: this.settings.agent, worlds: this.settings.worlds, publicPlay: this.settings.publicPlay, lan: this.settings.lan}};
    this.evidence.save(); return this;
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') this.evidence.report.errors.push({phase: 'cleanup', message: error.message}); }
      }, 15000);
      await this.exited; clearTimeout(timer);
    }
    this.child = null; this.startError = null;
    this.evidence.text('server.log', this.log); this.evidence.save();
    await requireFreeTestPort();
  }
  removeData() { assert.equal(this.child, null, 'Stop the owned service before removing test data.'); rmSync(this.data, {recursive: true, force: true}); }
}

export async function request(method, path, {actor = null, body, expected = 200, origin = ORIGIN, timeout = 60000, headers = {}} = {}) {
  assert.ok(path.startsWith('/creation-api/'), 'Use the declared creation API route.');
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {origin, ...(actor ? {authorization: `Bearer ${actor.token}`} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(timeout),
  });
  const raw = await response.text(); let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`${method} ${path}: non-JSON ${response.status}: ${redact(raw.slice(0, 500))}`); }
  if (expected !== null) assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${path}: ${response.status}: ${JSON.stringify(redact(value)).slice(0, 2500)}`);
  return {status: response.status, value, headers: response.headers};
}

export async function registerActor(label) {
  const credentials = {name: `next-wave-${label}-${randomUUID().slice(0, 6)}`, password: randomUUID() + randomUUID()};
  const {value} = await request('POST', '/creation-api/auth/register', {body: credentials, expected: 201});
  return {...value, credentials};
}

export function safeRelativeEvidence(path, evidence) {
  const result = relative(evidence.directory, resolve(path));
  assert.ok(result && !result.startsWith('..') && !result.startsWith(sep));
  return result;
}
