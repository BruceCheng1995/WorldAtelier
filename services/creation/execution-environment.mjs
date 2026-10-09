import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (message, details) => Object.assign(new Error(message), { status: 503, code: 'EXECUTION_ENVIRONMENT_UNAVAILABLE', details });
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
function canonical(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return resolve(canonical(dirname(absolute)), relative(dirname(absolute), absolute));
}
function regularTreePath(root, path, label) {
  let at = root;
  for (const part of relative(root, path).split(sep)) {
    at = resolve(at, part);
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw failure(`${label} contains a symbolic link`);
  }
  return path;
}
function sourceEntries(manifest) {
  if (!manifest || !Array.isArray(manifest.sources) || !manifest.sources.length) throw failure('Runtime source manifest is missing');
  const seen = new Set();
  for (const entry of manifest.sources) {
    if (!entry || typeof entry.path !== 'string' || isAbsolute(entry.path) || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..' || part === '.godot') || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.path)) throw failure('Runtime source manifest contains an unsafe or duplicate entry');
    seen.add(entry.path);
  }
  if (!seen.has('project.godot')) throw failure('Runtime source manifest has no project.godot');
  return manifest.sources;
}

export function verifyRuntimeSources({ directory, manifest }) {
  const root = realpathSync(directory);
  for (const entry of sourceEntries(manifest)) {
    const file = regularTreePath(root, resolve(root, entry.path), 'Runtime source');
    if (!lstatSync(file).isFile() || digest(readFileSync(file)) !== entry.sha256) throw failure('Godot 源码已经变化，请先构建匹配客户端', { path: entry.path });
  }
  return true;
}

// Copy exactly the pinned source list. Imported .godot data is generated later
// in this private project, never copied from the mutable platform checkout.
export function snapshotRuntime({ sourceDirectory, destination, manifest }) {
  const source = realpathSync(sourceDirectory), target = canonical(destination), entries = sourceEntries(manifest);
  if (inside(source, target) || inside(target, source)) throw failure('Runtime snapshot overlaps its source');
  if (existsSync(target)) throw failure('Runtime snapshot destination must be new');
  const bytes = entries.map(entry => {
    const path = regularTreePath(source, resolve(source, entry.path), 'Runtime source');
    if (!inside(source, path) || !lstatSync(path).isFile()) throw failure('Runtime source is not a regular file');
    const content = readFileSync(path);
    if (digest(content) !== entry.sha256) throw failure('Godot 源码已经变化，请先构建匹配客户端', { path: entry.path });
    return [entry, content];
  });
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const [entry, content] of bytes) {
    const path = resolve(target, entry.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { flag: 'wx', mode: 0o400 });
  }
  verifyRuntimeSnapshot({ directory: target, manifest });
  return { directory: target, runtime_build_id: manifest.build_id, source_hash: digest(JSON.stringify(entries)) };
}

export function verifyRuntimeSnapshot({ directory, manifest }) {
  const root = realpathSync(directory), entries = sourceEntries(manifest), expected = new Set(entries.map(entry => entry.path));
  const walk = (path, generated = false) => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const file = resolve(path, item.name), name = relative(root, file).split(sep).join('/');
      if (item.isSymbolicLink()) throw failure('Runtime snapshot contains a symbolic link');
      if (item.isDirectory()) walk(file, generated || name === '.godot');
      else if (!item.isFile() || (!generated && !expected.has(name))) throw failure('Runtime snapshot contains an unlisted source', { path: name });
    }
  };
  walk(root);
  for (const entry of entries) {
    const file = regularTreePath(root, resolve(root, entry.path), 'Runtime snapshot');
    if (!lstatSync(file).isFile() || digest(readFileSync(file)) !== entry.sha256) throw failure('Runtime snapshot source differs from its fixed manifest', { path: entry.path });
  }
  return true;
}

export function executionCapabilities() {
  const available = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
  return { version: 1, available, provider: available ? 'macos-seatbelt' : 'unsupported', file_writes: available ? 'explicit_paths' : 'unavailable', file_reads: available ? 'system_and_explicit_paths' : 'unavailable', network: available ? 'explicit_loopback_tcp_ports' : 'unavailable', host_file_metadata_readable: true, mach_service_lookup: 'host_available', private_user_data: available, inherited_host_environment: false, resource_limits: false, multi_tenant_isolation: false, subprocesses: 'denied_by_default' };
}

export function prepareExecutionEnvironment({ directory, readPaths = [], writePaths = [], safeSavePaths = [], networkOrigins = [], extraEnv = {} }) {
  const capabilities = executionCapabilities();
  if (!capabilities.available) throw failure('This host has no supported enforced execution environment; no unprotected fallback was started', capabilities);
  const root = canonical(directory); mkdirSync(root, { recursive: true, mode: 0o700 });
  const directories = Object.fromEntries(['home', 'tmp', 'cache', 'data', 'config', 'logs'].map(name => {
    const path = regularTreePath(root, resolve(root, name), 'Execution directory'); mkdirSync(path, { recursive: true, mode: 0o700 }); return [name, path];
  }));
  // Godot macOS reads HOME for both user:// and cache paths. These are child
  // environment entries only; never assign to the service's process.env.
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directories.home, TMPDIR: directories.tmp + sep, TMP: directories.tmp, TEMP: directories.tmp, XDG_CACHE_HOME: directories.cache, XDG_DATA_HOME: directories.data, XDG_CONFIG_HOME: directories.config, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC', GODOT_SILENCE_ROOT_WARNING: '1', __GODOT_SHELL_ENV_SET: '1' };
  for (const [name, value] of Object.entries(extraEnv)) {
    if (!['WA_WORKER_URL', 'WA_WORKER_TOKEN'].includes(name) || typeof value !== 'string' || value.includes('\0')) throw failure('Unexpected execution environment variable');
    env[name] = value;
  }
  const ports = [...new Set(networkOrigins.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw failure('Execution network access must target an explicit loopback service origin');
    return Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80));
  }))];
  const saves = safeSavePaths.map(canonical);
  const reads = readPaths.map(canonical), writes = [...Object.values(directories), ...writePaths.map(canonical), ...saves];
  const quote = value => JSON.stringify(value);
  return { directory: root, directories, env, capabilities: { ...capabilities, loopback_tcp_ports: ports },
    command(executable, args, { godot = false, projectPath, logName = 'godot.log', allowSubprocesses = false } = {}) {
      if (!isAbsolute(executable)) throw failure('Execution requires an absolute executable path');
      const binary = realpathSync(executable), commandArgs = [...args];
      if (godot) {
        if (!/^[A-Za-z0-9_.-]+$/.test(logName) || ['.', '..'].includes(logName)) throw failure('Invalid Godot log name');
        const separator = commandArgs.findIndex(arg => arg === '--' || arg === '++');
        commandArgs.splice(separator < 0 ? commandArgs.length : separator, 0, '--log-file', resolve(directories.logs, logName));
      }
      const app = binary.includes('.app/') ? binary.slice(0, binary.indexOf('.app/') + 4) : binary;
      const readable = [...new Set(['/System', '/private/preboot', '/private/var/db/dyld', '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/Library/Apple', '/Library/Fonts', '/Library/Preferences', '/dev', '/private/etc', app, ...reads, ...writes, ...(projectPath ? [canonical(projectPath)] : [])])];
      // Seatbelt is inherited by subprocesses. Mach services/sysctls needed by
      // Apple's runtime remain available; this is not a VM or tenant boundary.
      const profile = ['(version 1)', '(deny default)', `(allow process-exec sysctl-read mach-lookup${allowSubprocesses ? ' process-fork' : ''})`, '(allow file-read-metadata file-map-executable)', '(allow file-read-data (literal "/"))', `(allow file-read* ${readable.map(path => `(subpath ${quote(path)})`).join(' ')})`, `(allow file-write* (literal "/dev/null") ${writes.map(path => `(subpath ${quote(path)})`).join(' ')} ${saves.map(path => `(regex (string-append "^" (regex-quote ${quote(path)}) #"-[A-Za-z0-9]+$"))`).join(' ')})`, ...ports.map(port => `(allow network-outbound (remote tcp "localhost:${port}"))`)].join('\n');
      const profileFile = resolve(root, `sandbox-${digest(profile).slice(0, 16)}.sb`); writeFileSync(profileFile, profile, { mode: 0o600 });
      return { command: '/usr/bin/sandbox-exec', args: ['-f', profileFile, binary, ...commandArgs], options: { cwd: root, env: { ...env } } };
    }
  };
}
