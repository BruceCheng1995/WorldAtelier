/** Actual native-Linux enforcement checks; no Docker daemon or product port.
 * Run inside the verification image as the same non-root UID used by the app.
 * macOS/Windows skip the runtime group explicitly. On Linux, an unavailable or
 * mismatched helper is a failure; WORLD_ATELIER_REQUIRE_LINUX_ISOLATION=1 also
 * rejects running this suite on the wrong OS. This is not 9-game acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, statSync, existsSync, symlinkSync, readdirSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {executionCapabilities, prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';
import {linuxExecutionCapabilities, linuxExecutionIdentity, linuxSandboxPath, LINUX_EXECUTION_POLICY} from '../../services/creation/linux-execution.mjs';
import {godotErrorLines, LINUX_DESKTOP_PROBE_ERROR} from '../../tools/godot-diagnostics.mjs';

const root = resolve(import.meta.dirname, '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const denied = value => { assert.equal(value.allowed, false, JSON.stringify(value)); assert.ok([1, 13, 18].includes(value.errno), JSON.stringify(value)); };
const unavailable = error => error.code === 'EXECUTION_ENVIRONMENT_UNAVAILABLE' && error.status === 503;

const PROBE = String.raw`import ctypes, errno, fcntl, json, os, resource, signal, socket, struct, sys, threading
action = sys.argv[1]
p = json.loads(sys.argv[2])
stage = 'operation'

def syscall(name, *args):
    library = ctypes.CDLL('libseccomp.so.2')
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_syscall_resolve_name.restype = ctypes.c_int
    nr = library.seccomp_syscall_resolve_name(name.encode())
    if nr < 0:
        raise RuntimeError('Test system libseccomp does not know ' + name)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    result = libc.syscall(nr, *args)
    if result < 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    return result

def operation():
    global stage
    if action == 'context':
        status = {}
        with open('/proc/self/status') as source:
            for line in source:
                key, _, value = line.partition(':')
                if key in ['NoNewPrivs', 'Seccomp', 'Seccomp_filters']:
                    status[key] = int(value.strip())
        return {'status': status, 'home': os.environ.get('HOME'), 'private_env': os.environ.get('WA_LINUX_TEST_PRIVATE')}
    if action == 'read':
        with open(p['path']) as source:
            return source.read()
    if action == 'write':
        with open(p['path'], 'a') as target:
            target.write('isolated-write\n')
        return True
    if action == 'truncate':
        fd = os.open(p['path'], os.O_RDONLY | os.O_TRUNC)
        os.close(fd)
        return True
    if action == 'mkdir':
        os.mkdir(p['path'])
        return True
    if action == 'chmod':
        os.chmod(p['path'], 0o640)
        return True
    if action == 'fchmod':
        fd = os.open(p['path'], os.O_RDONLY)
        try:
            os.fchmod(fd, 0o640)
        finally:
            os.close(fd)
        return True
    if action == 'chown':
        os.chown(p['path'], os.geteuid(), os.getegid())
        return True
    if action == 'utime':
        os.utime(p['path'], (1600000000, 1600000000))
        return True
    if action == 'xattr':
        os.setxattr(p['path'], 'user.wa_isolation_probe', b'explicit-test-attribute')
        return True
    if action == 'rename':
        os.rename(p['source'], p['target'])
        return True
    if action == 'hardlink':
        os.link(p['source'], p['target'])
        return True
    if action == 'symlink_escape':
        os.symlink(p['target'], p['link'])
        with open(p['link']) as source:
            return source.read()
    if action == 'fd':
        return os.read(p['fd'], 100).decode()
    if action == 'directory_fd':
        fd = os.open(p['name'], os.O_RDONLY, dir_fd=p['fd'])
        try:
            return os.read(fd, 100).decode()
        finally:
            os.close(fd)
    if action == 'thread':
        values = []
        worker = threading.Thread(target=lambda: values.append(73))
        worker.start()
        worker.join(3)
        if worker.is_alive() or values != [73]:
            raise RuntimeError('Thread did not finish its actual work')
        return values[0]
    if action == 'fork':
        child = os.fork()
        if child == 0:
            os._exit(0)
        try:
            os.waitpid(child, 0)
        except OSError:
            pass
        return child > 0
    if action == 'spawn':
        child = os.posix_spawn(sys.executable, [sys.executable, '-c', 'pass'], dict(os.environ))
        os.waitpid(child, 0)
        return child > 0
    if action == 'clone3':
        return syscall('clone3', ctypes.c_void_p(0), ctypes.c_size_t(88))
    if action == 'socket':
        family = {'ipv4': socket.AF_INET, 'ipv6': socket.AF_INET6, 'unix': socket.AF_UNIX}[p['family']]
        kind = socket.SOCK_DGRAM if p.get('datagram') else socket.SOCK_STREAM
        if p.get('flags'):
            kind |= socket.SOCK_NONBLOCK | socket.SOCK_CLOEXEC
        sock = socket.socket(family, kind, p.get('protocol', 0))
        sock.close()
        return True
    if action == 'socket_option':
        family = socket.AF_INET6 if p.get('family') == 'ipv6' else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            options = {'reuse': (socket.SOL_SOCKET, socket.SO_REUSEADDR), 'v6only': (socket.IPPROTO_IPV6, socket.IPV6_V6ONLY), 'keepalive': (socket.SOL_SOCKET, socket.SO_KEEPALIVE), 'nodelay': (socket.IPPROTO_TCP, socket.TCP_NODELAY)}
            stage = 'setsockopt'
            sock.setsockopt(*options[p['option']], 1)
            return True
        finally:
            sock.close()
    if action.startswith('tcp_'):
        family = socket.AF_INET6 if p.get('family') == 'ipv6' else socket.AF_INET
        host = '::1' if family == socket.AF_INET6 else '127.0.0.1'
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            # Positive controls prepare a connected/bound descriptor. The
            # confined calls deliberately reach their named syscall directly,
            # rather than reporting a prior denied connect as a denied send.
            if p.get('positive_setup') and action in ['tcp_send', 'tcp_receive']:
                sock.connect((host, p['port']))
            if p.get('positive_setup') and action == 'tcp_listen':
                sock.bind((host, p['port']))
            stage = action[4:]
            if action == 'tcp_bind': sock.bind((host, p['port'])); return True
            if action == 'tcp_listen': sock.listen(1); return True
            if action == 'tcp_connect': sock.connect((host, p['port'])); return True
            if action == 'tcp_send':
                sock.sendall(b'owned-network-send', socket.MSG_NOSIGNAL)
                return len(b'owned-network-send')
            if action == 'tcp_receive':
                chunks = []
                while True:
                    chunk = sock.recv(100)
                    if not chunk: break
                    chunks.append(chunk)
                return b''.join(chunks).decode()
            raise RuntimeError('Unknown TCP action')
        finally:
            sock.close()
    if action == 'socketpair':
        a, b = socket.socketpair()
        a.close()
        b.close()
        return True
    if action == 'signal_other':
        os.kill(p['pid'], 0)  # Permission probe only; never signal the test runner.
        return True
    if action == 'signal_self':
        received = []
        signal.signal(signal.SIGUSR1, lambda number, frame: received.append(number))
        os.kill(os.getpid(), signal.SIGUSR1)
        if received != [signal.SIGUSR1]:
            raise RuntimeError('The same-process signal was not delivered')
        return True
    if action in ['fcntl_owner', 'fcntl_owner_ex']:
        read_fd, write_fd = os.pipe()
        try:
            if action == 'fcntl_owner':
                fcntl.fcntl(read_fd, fcntl.F_SETOWN, p['pid'])
            else:
                fcntl.fcntl(read_fd, 15, struct.pack('ii', 1, p['pid']))  # F_SETOWN_EX / F_OWNER_PID
            # Never enable O_ASYNC or write: this probes setup without sending
            # SIGIO to the test runner or any existing process.
            return True
        finally:
            os.close(read_fd)
            os.close(write_fd)
    if action == 'prlimit_other':
        return list(resource.prlimit(p['pid'], resource.RLIMIT_NOFILE))
    if action == 'pidfd_other':
        fd = syscall('pidfd_open', p['pid'], 0)
        os.close(fd)
        return True
    if action == 'io_uring':
        params = ctypes.create_string_buffer(256)
        fd = syscall('io_uring_setup', 1, ctypes.byref(params))
        os.close(fd)
        return True
    raise RuntimeError('Unknown probe action ' + action)

try:
    value = operation()
    result = {'allowed': True, 'value': value}
except OSError as error:
    result = {'allowed': False, 'errno': error.errno, 'error': str(error)}
result.update({'uid': os.getuid(), 'euid': os.geteuid(), 'pid': os.getpid(), 'stage': stage})
print(json.dumps(result))
`;

const SOCKET_FD_PARENT = String.raw`import json, os, socket, subprocess, sys
spec = json.loads(sys.argv[1])
a, b = socket.socketpair()
try:
    a.sendall(b'owned-inherited-socket')
    args = [str(b.fileno()) if item == '__INHERITED_FD__' else item for item in spec['args']]
    args = [item.replace('__INHERITED_FD__', str(b.fileno())) for item in args]
    child = subprocess.run([spec['command']] + args, cwd=spec['options']['cwd'], env=spec['options']['env'], pass_fds=(b.fileno(),), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)
    print(json.dumps({'status': child.returncode, 'stdout': child.stdout, 'stderr': child.stderr}))
finally:
    a.close()
    b.close()
`;

// This trusted positive-control parent uses only its own loopback listener.
// Candidate ports are 52000-63999, so the product/test port 48921 is excluded.
const NETWORK_PARENT = String.raw`import json, os, socket, subprocess, sys, threading
spec = json.loads(sys.argv[1])
family = socket.AF_INET6 if spec['family'] == 'ipv6' else socket.AF_INET
host = '::1' if family == socket.AF_INET6 else '127.0.0.1'
listener = socket.socket(family, socket.SOCK_STREAM)
for offset in range(200):
    port = 52000 + ((os.getpid() + offset) % 12000)
    try:
        listener.bind((host, port))
        break
    except OSError:
        if offset == 199:
            raise
network = {'connections': 0, 'received': '', 'errors': []}
stop = threading.Event()
worker = None
def serve():
    listener.settimeout(0.1)
    while not stop.is_set():
        try:
            peer, address = listener.accept()
        except socket.timeout:
            continue
        except OSError as error:
            if not stop.is_set(): network['errors'].append(str(error))
            return
        network['connections'] += 1
        try:
            peer.settimeout(3)
            if spec['operation'] == 'tcp_receive':
                peer.sendall(b'owned-network-receive')
            else:
                chunks = []
                while True:
                    chunk = peer.recv(100)
                    if not chunk: break
                    chunks.append(chunk)
                network['received'] = b''.join(chunks).decode()
        except OSError as error:
            network['errors'].append(str(error))
        finally:
            peer.close()
        return
if spec['operation'] in ['tcp_connect', 'tcp_send', 'tcp_receive']:
    listener.listen(2)
    worker = threading.Thread(target=serve)
    worker.start()
else:
    listener.close()  # The bind/listen positive child uses this reserved port.
try:
    args = [item.replace('__CONTROL_PORT__', str(port)) for item in spec['args']]
    child = subprocess.run([spec['command']] + args, cwd=spec['options']['cwd'], env=spec['options']['env'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)
finally:
    if worker and spec.get('positive'): worker.join(4)
    stop.set()
    listener.close()
    if worker: worker.join(4)
print(json.dumps({'status': child.returncode, 'stdout': child.stdout, 'stderr': child.stderr, 'port': port, 'uid': os.getuid(), 'network': network}))
`;

function run(spec, {stdio = ['ignore', 'pipe', 'pipe'], timeout = 20000, logPrefix} = {}) {
  const result = spawnSync(spec.command, spec.args, {...spec.options, stdio, encoding:'utf8', timeout, maxBuffer:2*1024*1024});
  if (logPrefix) {
    mkdirSync(dirname(logPrefix), {recursive:true});
    writeFileSync(logPrefix + '.stdout.log', result.stdout ?? '');
    writeFileSync(logPrefix + '.stderr.log', result.stderr ?? '');
    writeFileSync(logPrefix + '.receipt.json', JSON.stringify({command:spec.command, args:spec.args, status:result.status, signal:result.signal, error:result.error?.message ?? null}, null, 2) + '\n');
  }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, JSON.stringify({command:spec.command, args:spec.args, status:result.status, signal:result.signal, stdout:result.stdout, stderr:result.stderr}));
  return result;
}

test('a missing or mismatched Linux helper never advertises available enforcement', t => {
  // Production /tmp remains noexec. The verification runner can provide its
  // own executable fixture volume, e.g. WORLD_ATELIER_TEST_EXECUTABLE_DIRECTORY=/data.
  const base = mkdtempSync(join(process.env.WORLD_ATELIER_TEST_EXECUTABLE_DIRECTORY ?? tmpdir(), 'wa-linux-unavailable-')), previous = process.env.WORLD_ATELIER_LINUX_SANDBOX;
  t.after(() => { if (previous === undefined) delete process.env.WORLD_ATELIER_LINUX_SANDBOX; else process.env.WORLD_ATELIER_LINUX_SANDBOX = previous; rmSync(base, {recursive:true, force:true}); });
  process.env.WORLD_ATELIER_LINUX_SANDBOX = join(base, 'missing-helper');
  assert.equal(linuxExecutionCapabilities().available, false);
  if (process.platform === 'linux') assert.throws(() => prepareExecutionEnvironment({directory:join(base, 'execution')}), unavailable);
  // This deliberately false receipt tests rejection, never successful isolation.
  const mismatch = join(base, 'mismatched-helper');
  writeFileSync(mismatch, '#!/bin/sh\nprintf \'%s\\n\' \'{"policy":"wa-linux-landlock-seccomp-1","source_sha256":"' + '0'.repeat(64) + '","abi":3,"filesystem":true,"seccomp":true}\'\n', {mode:0o755});
  process.env.WORLD_ATELIER_LINUX_SANDBOX = mismatch;
  const capabilities = linuxExecutionCapabilities();
  assert.equal(capabilities.available, false); assert.match(capabilities.reason, /策略源码不匹配/);
  if (process.platform === 'linux') assert.throws(() => prepareExecutionEnvironment({directory:join(base, 'execution')}), unavailable);
});

test('native Linux: actual filesystem, descriptor, process and network enforcement', {timeout:240000}, async t => {
  if (process.platform !== 'linux') {
    assert.notEqual(process.env.WORLD_ATELIER_REQUIRE_LINUX_ISOLATION, '1', 'This verification must run inside native Linux, not on the host OS');
    t.skip('Native Linux is required. No Linux isolation or Godot runtime acceptance is claimed on this OS.'); return;
  }
  const capabilities = executionCapabilities();
  assert.equal(capabilities.available, true, JSON.stringify(capabilities));
  assert.equal(capabilities.provider, 'linux-landlock-seccomp');
  assert.ok(capabilities.landlock_abi >= 3);
  assert.equal(capabilities.network, 'denied');
  assert.equal(capabilities.socket_construction, 'unconnected_tcp_only');
  assert.notEqual(process.geteuid(), 0, 'Run as the non-root application UID so DAC-positive controls match deployment');
  const identity = linuxExecutionIdentity();
  assert.equal(identity.policy, LINUX_EXECUTION_POLICY);
  assert.equal(identity.source_sha256, digest(readFileSync(join(root, 'tools/linux-sandbox.c'))));
  assert.equal(identity.helper_sha256, digest(readFileSync(linuxSandboxPath())));

  const base = mkdtempSync(join(tmpdir(), 'wa-linux-enforcement-'));
  const evidenceRoot = resolve(process.env.WORLD_ATELIER_LINUX_TEST_EVIDENCE ?? join(root, '.local/creation-verification/linux-execution'));
  mkdirSync(evidenceRoot, {recursive:true});
  const evidence = mkdtempSync(join(evidenceRoot, 'run-'));
  writeFileSync(join(evidence, 'environment.json'), JSON.stringify({platform:process.platform, architecture:process.arch, uid:process.getuid(), capabilities, identity}, null, 2) + '\n');
  t.diagnostic('LINUX_ISOLATION_EVIDENCE ' + evidence);
  const probes = join(base, 'probes'), readable = join(base, 'read-only'), writable = join(base, 'write'), outside = join(base, 'outside'), directory = join(base, 'execution');
  for (const path of [probes, readable, writable, outside]) mkdirSync(path);
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const python = process.env.WORLD_ATELIER_TEST_PYTHON ?? '/usr/bin/python3';
  const probe = join(probes, 'probe.py'), socketParent = join(probes, 'socket-parent.py'), networkParent = join(probes, 'network-parent.py');
  writeFileSync(probe, PROBE); writeFileSync(socketParent, SOCKET_FD_PARENT); writeFileSync(networkParent, NETWORK_PARENT);
  const source = join(readable, 'source.txt'), secret = join(outside, 'owned-private.txt'), sourceText = 'readable-fixed-source\n', privateText = 'owned-private-test-data\n';
  writeFileSync(source, sourceText, {mode:0o600}); writeFileSync(secret, privateText, {mode:0o600});
  const environment = prepareExecutionEnvironment({directory, readPaths:[probes, readable], writePaths:[writable]});
  const specification = (action, params = {}, isolated = true) => {
    const args = [probe, action, JSON.stringify(params)];
    return isolated ? environment.command(python, args) : {command:python, args, options:{cwd:base, env:{...process.env, PYTHONDONTWRITEBYTECODE:'1'}}};
  };
  const invoke = (action, params = {}, {isolated = true, stdio} = {}) => {
    const result = JSON.parse(run(specification(action, params, isolated), {stdio}).stdout.trim());
    assert.equal(result.uid, process.getuid()); assert.equal(result.euid, process.geteuid()); return result;
  };
  const positive = (action, params) => { const value = invoke(action, params, {isolated:false}); assert.equal(value.allowed, true, JSON.stringify(value)); return value; };

  await t.test('same-UID controls are readable/writable, while fixed source and outside paths remain protected', () => {
    assert.equal(positive('read', {path:secret}).value, privateText);
    positive('write', {path:secret}); writeFileSync(secret, privateText);
    assert.equal(invoke('read', {path:source}).value, sourceText);
    denied(invoke('read', {path:secret}));
    denied(invoke('write', {path:secret})); denied(invoke('write', {path:source}));
    const output = join(writable, 'created.txt'); assert.equal(invoke('write', {path:output}).allowed, true);
    assert.match(readFileSync(output, 'utf8'), /isolated-write/);
    assert.equal(invoke('mkdir', {path:join(writable, 'allowed-dir')}).allowed, true);
    denied(invoke('mkdir', {path:join(outside, 'forbidden-dir')}));
    assert.equal(readFileSync(secret, 'utf8'), privateText); assert.equal(readFileSync(source, 'utf8'), sourceText);
  });

  await t.test('O_RDONLY|O_TRUNC cannot truncate either a readable source or an outside file', () => {
    const control = join(outside, 'truncate-control'); writeFileSync(control, 'owned truncation control'); positive('truncate', {path:control}); assert.equal(statSync(control).size, 0);
    denied(invoke('truncate', {path:source})); denied(invoke('truncate', {path:secret}));
    assert.equal(readFileSync(secret, 'utf8'), privateText); assert.equal(readFileSync(source, 'utf8'), sourceText);
  });

  for (const action of ['chmod', 'fchmod', 'chown', 'utime', 'xattr']) await t.test('metadata write is denied: ' + action, t => {
    const control = join(outside, action + '-control'); writeFileSync(control, 'owned metadata control', {mode:0o600});
    const available = invoke(action, {path:control}, {isolated:false});
    if (action === 'xattr' && !available.allowed && [45, 95].includes(available.errno)) { t.skip('The fixture filesystem does not support user xattrs; no xattr enforcement result is claimed.'); return; }
    assert.equal(available.allowed, true, JSON.stringify(available));
    const before = {mode:statSync(source).mode, mtime:statSync(source).mtimeMs, bytes:readFileSync(source, 'utf8')};
    denied(invoke(action, {path:source}));
    assert.deepEqual({mode:statSync(source).mode, mtime:statSync(source).mtimeMs, bytes:readFileSync(source, 'utf8')}, before);
  });

  await t.test('relative, symlink, proc-root, hardlink and rename routes cannot escape the allowed directories', () => {
    symlinkSync(secret, join(writable, 'existing-escape'));
    denied(invoke('read', {path:join(writable, 'existing-escape')}));
    denied(invoke('write', {path:join(writable, 'existing-escape')}));
    denied(invoke('read', {path:'../outside/owned-private.txt'}));
    denied(invoke('read', {path:'/proc/self/root' + secret}));
    denied(invoke('symlink_escape', {target:secret, link:join(writable, 'new-escape')}));
    const from = join(writable, 'rename-source'), target = join(outside, 'renamed'); writeFileSync(from, 'owned rename data');
    denied(invoke('rename', {source:from, target})); assert.ok(existsSync(from)); assert.equal(existsSync(target), false);
    denied(invoke('hardlink', {source:secret, target:join(writable, 'hardlinked-private')}));
    assert.equal(existsSync(join(writable, 'hardlinked-private')), false); assert.equal(readFileSync(secret, 'utf8'), privateText);
  });

  await t.test('inherited file and directory descriptors are closed before the target program', () => {
    const file = openSync(secret, 'r'), dir = openSync(outside, 'r');
    try {
      for (const [action, params, fd] of [['fd', {fd:3}, file], ['directory_fd', {fd:3, name:'owned-private.txt'}, dir]]) {
        assert.equal(invoke(action, params, {isolated:false, stdio:['ignore', 'pipe', 'pipe', fd]}).value, privateText);
        const result = invoke(action, params, {stdio:['ignore', 'pipe', 'pipe', fd]});
        assert.equal(result.allowed, false); assert.equal(result.errno, 9, JSON.stringify(result));
      }
    } finally { closeSync(file); closeSync(dir); }
  });

  await t.test('inherited Unix socket descriptors are also closed, without opening a TCP test port', () => {
    for (const isolated of [false, true]) {
      const spec = specification('fd', {fd:'__INHERITED_FD__'}, isolated);
      // The wrapper fills the descriptor as JSON number, after socketpair().
      spec.args = spec.args.map(arg => arg.replace('"__INHERITED_FD__"', '__INHERITED_FD__'));
      const parent = run({command:python, args:[socketParent, JSON.stringify(spec)], options:{cwd:base, env:process.env}});
      const child = JSON.parse(parent.stdout); assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      if (isolated) { assert.equal(result.allowed, false); assert.equal(result.errno, 9); }
      else { assert.equal(result.allowed, true); assert.equal(result.value, 'owned-inherited-socket'); }
    }
  });

  await t.test('threads and same-process signals work while fork and spawn are rejected', () => {
    positive('thread'); positive('fork'); positive('spawn'); positive('signal_self');
    assert.equal(invoke('thread').value, 73); assert.equal(invoke('signal_self').allowed, true);
    denied(invoke('fork')); denied(invoke('spawn'));
    const clone = invoke('clone3'); assert.equal(clone.allowed, false); assert.equal(clone.errno, 38, 'clone3 must return ENOSYS so libc can use the allowed thread-clone path');
  });

  await t.test('only unconnected IPv4/IPv6 TCP descriptors and the two inert editor options can be constructed', () => {
    for (const family of ['ipv4', 'ipv6']) for (const protocol of [0, 6]) for (const flags of [false, true]) {
      const params = {family, protocol, flags}; positive('socket', params); assert.equal(invoke('socket', params).allowed, true);
    }
    for (const params of [{family:'ipv4', option:'reuse'}, {family:'ipv6', option:'reuse'}, {family:'ipv6', option:'v6only'}]) { positive('socket_option', params); assert.equal(invoke('socket_option', params).allowed, true); }
    for (const option of ['keepalive', 'nodelay']) { positive('socket_option', {option}); denied(invoke('socket_option', {option})); }
    denied(invoke('socket', {family:'ipv4', protocol:17}));
  });

  await t.test('constructed TCP descriptors cannot bind, listen, connect, send or receive', () => {
    for (const family of ['ipv4', 'ipv6']) for (const operation of ['tcp_bind', 'tcp_listen', 'tcp_connect', 'tcp_send', 'tcp_receive']) {
      for (const isolated of [false, true]) {
        const spec = specification(operation, {family, port:'__CONTROL_PORT__', positive_setup:!isolated}, isolated);
        spec.args = spec.args.map(arg => arg.replace('"__CONTROL_PORT__"', '__CONTROL_PORT__'));
        Object.assign(spec, {family, operation, positive:!isolated});
        const raw = run({command:python, args:[networkParent, JSON.stringify(spec)], options:{cwd:base, env:process.env}});
        const parent = JSON.parse(raw.stdout); assert.equal(parent.status, 0, parent.stderr); assert.notEqual(parent.port, 48921); assert.equal(parent.uid, process.getuid());
        const result = JSON.parse(parent.stdout); assert.equal(result.stage, operation.slice(4)); assert.equal(result.uid, process.getuid());
        if (isolated) { denied(result); assert.equal(result.errno, 1); assert.equal(parent.network.connections, 0); }
        else {
          assert.equal(result.allowed, true, JSON.stringify(result)); assert.deepEqual(parent.network.errors, []);
          if (['tcp_connect', 'tcp_send', 'tcp_receive'].includes(operation)) assert.equal(parent.network.connections, 1);
          if (operation === 'tcp_send') assert.equal(parent.network.received, 'owned-network-send');
          if (operation === 'tcp_receive') assert.equal(result.value, 'owned-network-receive');
        }
      }
    }
  });

  await t.test('UDP, Unix sockets, socketpair and io_uring remain unavailable', () => {
    for (const params of [{family:'ipv4', datagram:true}, {family:'ipv6', datagram:true}, {family:'unix'}]) { positive('socket', params); denied(invoke('socket', params)); }
    positive('socketpair'); denied(invoke('socketpair'));
    const uring = invoke('io_uring'); assert.equal(uring.allowed, false); assert.equal(uring.errno, 1);
  });

  await t.test('another same-UID process cannot be signalled or inspected through resource/pidfd APIs', () => {
    for (const action of ['signal_other', 'fcntl_owner', 'fcntl_owner_ex', 'prlimit_other', 'pidfd_other']) { positive(action, {pid:process.pid}); denied(invoke(action, {pid:process.pid})); }
  });

  await t.test('no_new_privs and seccomp are active, and host environment values are not inherited', () => {
    const previous = process.env.WA_LINUX_TEST_PRIVATE; process.env.WA_LINUX_TEST_PRIVATE = 'owned-environment-sentinel';
    try {
      const control = positive('context').value, isolated = invoke('context').value;
      assert.equal(control.private_env, 'owned-environment-sentinel'); assert.equal(isolated.private_env, null);
      assert.equal(isolated.home, environment.directories.home); assert.equal(isolated.status.NoNewPrivs, 1); assert.equal(isolated.status.Seccomp, 2);
      assert.ok(isolated.status.Seccomp_filters > control.status.Seccomp_filters, 'the helper adds its own enforced filter to the outer container policy');
    } finally { if (previous === undefined) delete process.env.WA_LINUX_TEST_PRIVATE; else process.env.WA_LINUX_TEST_PRIVATE = previous; }
  });

  await t.test('networked workers and subprocess-enabled invocations fail closed at the JavaScript boundary', () => {
    assert.throws(() => prepareExecutionEnvironment({directory:join(base, 'network-refused'), networkOrigins:['http://127.0.0.1:48910']}), unavailable);
    assert.throws(() => environment.command(python, [probe, 'thread', '{}'], {allowSubprocesses:true}), unavailable);
  });

  await t.test('real Godot imports and runs a bounded headless project under the same Linux isolation', () => {
    const godot = process.env.GODOT_BIN ?? '/usr/local/bin/godot', project = join(base, 'godot-project'); mkdirSync(project);
    const allowed = join(project, 'allowed.txt'), output = join(writable, 'godot-result.json'); writeFileSync(allowed, sourceText);
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Linux Isolation Probe"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    writeFileSync(join(project, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://probe.gd" id="1"]\n[node name="Probe" type="Node"]\nscript = ExtResource("1")\n');
    writeFileSync(join(project, 'probe.gd'), `extends Node
func _thread_value() -> int:
    return 73
func _ready() -> void:
    var args: Dictionary = {}
    for argument in OS.get_cmdline_user_args():
        var parts := argument.split("=", true, 1)
        if parts.size() == 2:
            args[parts[0]] = parts[1]
    var source := FileAccess.open(args["--allowed"], FileAccess.READ)
    var forbidden := FileAccess.open(args["--outside"], FileAccess.READ)
    var worker := Thread.new()
    var started := worker.start(Callable(self, "_thread_value"))
    var threaded = worker.wait_to_finish() if started == OK else -1
    var result := {"allowed_read": source != null, "outside_denied": forbidden == null, "thread_result": threaded, "headless": DisplayServer.get_name() == "headless"}
    var target := FileAccess.open(args["--output"], FileAccess.WRITE)
    if target == null:
        printerr("LINUX_ISOLATION_GODOT_OUTPUT_FAILED")
        get_tree().quit(2)
        return
    target.store_string(JSON.stringify(result))
    target.close()
    print("LINUX_ISOLATION_GODOT_ACTUAL_RUN " + JSON.stringify(result))
    get_tree().quit(0 if result.allowed_read and result.outside_denied and result.thread_result == 73 and result.headless else 1)
`);
    const importer = prepareExecutionEnvironment({directory:join(base, 'godot-import'), readPaths:[project], writePaths:[project]});
    const importSpec = importer.command(godot, ['--headless', '--editor', '--path', project, '--import'], {godot:true, projectPath:project});
    assert.ok(importSpec.args.includes('--audio-driver')); assert.ok(importSpec.args.includes('Dummy'));
    const imported = run(importSpec, {timeout:120000, logPrefix:join(evidence, 'godot-import')});
    const importRaw = imported.stdout + '\n' + imported.stderr;
    const importErrors = godotErrorLines(importRaw, {linux:true, allowEditorRidLeaks:true});
    writeFileSync(join(evidence, 'godot-import.diagnostics.json'), JSON.stringify({allowed_startup_diagnostic:LINUX_DESKTOP_PROBE_ERROR, desktop_probe_denials:importRaw.split(/\r?\n/).filter(line => line === LINUX_DESKTOP_PROBE_ERROR).length, remaining_errors:importErrors, raw_logs_preserved:true}, null, 2) + '\n');
    assert.deepEqual(importErrors, [], 'Only the exact once-per-process desktop probe denial and known editor RID teardown diagnostics may be exempted');
    const runner = prepareExecutionEnvironment({directory:join(base, 'godot-run'), readPaths:[project], writePaths:[writable]});
    const spec = runner.command(godot, ['--headless', '--path', project, '--fixed-fps', '60', '--quit-after', '90', '--', '--allowed=' + allowed, '--outside=' + secret, '--output=' + output], {godot:true, projectPath:project});
    const actual = run(spec, {timeout:30000, logPrefix:join(evidence, 'godot-run')});
    const runtimeRaw = actual.stdout + '\n' + actual.stderr, runtimeErrors = godotErrorLines(runtimeRaw, {linux:true});
    writeFileSync(join(evidence, 'godot-run.diagnostics.json'), JSON.stringify({allowed_startup_diagnostic:LINUX_DESKTOP_PROBE_ERROR, desktop_probe_denials:runtimeRaw.split(/\r?\n/).filter(line => line === LINUX_DESKTOP_PROBE_ERROR).length, remaining_errors:runtimeErrors, raw_logs_preserved:true}, null, 2) + '\n');
    assert.deepEqual(runtimeErrors, [], 'Other command failures, duplicate startup diagnostics and actual runtime errors must remain failures');
    assert.match(actual.stdout, /LINUX_ISOLATION_GODOT_ACTUAL_RUN/);
    assert.deepEqual(JSON.parse(readFileSync(output)), {allowed_read:true, outside_denied:true, thread_result:73, headless:true});
    assert.equal(readFileSync(secret, 'utf8'), privateText);
    assert.equal(readFileSync(allowed, 'utf8'), sourceText);
    assert.ok(readdirSync(runner.directories.logs).some(name => name.endsWith('.log')));
  });
});
