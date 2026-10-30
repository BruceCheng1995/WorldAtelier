/** Deployment-doctor classification tests, never game-runtime evidence.
 * Tool version programs and ZIP members are explicit inert fixtures. SQLite,
 * esbuild, the Python ZIP reader and (on macOS) the no-write sandbox probe are
 * real. All writable fixtures are temporary; no server or installer is started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, symlinkSync, unlinkSync, chmodSync, readdirSync, lstatSync, readlinkSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {checkDeployment, EXPECTED_GODOT} from '../../tools/check-deployment.mjs';
import {DefaultProjectBundle, DEFAULT_CATALOG_FORMAT} from '../../services/creation/default-projects.mjs';
import {hash} from '../../services/creation/schema.mjs';

const root = resolve(import.meta.dirname, '../..');
const realPython = spawnSync('/usr/bin/which', ['python3'], {encoding:'utf8'}).stdout.trim();
const result = (report, id) => report.checks.find(check => check.id === id);
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function program(path, output, {versionOnly = false, code = 0} = {}) {
  mkdirSync(dirname(path), {recursive:true});
  try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  writeFileSync(path, '#!/bin/sh\n' + (versionOnly ? '[ "$#" = 1 ] && [ "$1" = "--version" ] || exit 91\n' : '') + `printf '%s\\n' ${shellQuote(output)}\nexit ${code}\n`, {mode:0o755});
  chmodSync(path, 0o755);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal ordinary ZIP records with stored entries and real CRC32 checksums.
function templateZip(entries = {'godot.js':'EXPLICIT INERT TEMPLATE SCRIPT', 'godot.wasm':'NOT AN EXECUTABLE WASM', 'godot.html':'<html>Explicit template structure fixture</html>'}) {
  const files = [], central = []; let offset = 0;
  for (const [path, content] of Object.entries(entries)) {
    const name = Buffer.from(path), bytes = Buffer.from(content), crc = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt32LE(crc, 16); header.writeUInt32LE(bytes.length, 20); header.writeUInt32LE(bytes.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    files.push(local, name, bytes); central.push(header, name); offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}

function templates(path, {version = '4.6.stable', entries} = {}) {
  mkdirSync(path, {recursive:true}); writeFileSync(join(path, 'version.txt'), version + '\n');
  writeFileSync(join(path, 'web_nothreads_release.zip'), templateZip(entries));
}

function smallBundle(directory) {
  const source = join(root, 'content/default-projects'), bundle = new DefaultProjectBundle(source);
  const project = structuredClone(bundle.catalog.projects.find(project => project.name === '俄罗斯方块'));
  const hashes = new Set(project.cover ? [project.cover.hash] : []);
  for (const branch of project.branches) {
    hashes.add(branch.snapshot); if (branch.cover) hashes.add(branch.cover.hash);
    for (const entry of Object.values(bundle.snapshot(branch).source_files)) hashes.add(entry.hash);
  }
  const catalog = {format:DEFAULT_CATALOG_FORMAT, projects:[project], objects:Object.fromEntries([...hashes].map(key => [key, structuredClone(bundle.catalog.objects[key])]))};
  for (const entry of Object.values(catalog.objects)) for (const part of entry.parts) {
    const path = `objects/${part.hash.slice(0, 2)}/${part.hash}.gzpart`;
    mkdirSync(dirname(join(directory, path)), {recursive:true}); copyFileSync(join(source, path), join(directory, path));
  }
  const save = () => { catalog.version = hash({projects:catalog.projects, objects:catalog.objects}); writeFileSync(join(directory, 'catalog.json'), JSON.stringify(catalog)); };
  save(); return {catalog, project, save, manifest:bundle.snapshot(project.branches[0])};
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wa-deployment-doctor-')), bin = join(directory, 'bin'), userHome = join(directory, 'home');
  mkdirSync(bin); mkdirSync(userHome);
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  for (const [name, output] of [['npm','11.0.0'], ['git','git version 2.49.0'], ['curl','curl 8.7.1'], ['zip','Zip 3.0']]) program(join(bin, name), output);
  assert.ok(realPython, 'The template-check fixture requires an installed Python 3 reader');
  symlinkSync(realPython, join(bin, 'python3'));
  const godot = join(bin, 'inert-godot-version-program'); program(godot, EXPECTED_GODOT, {versionOnly:true});
  for (const filename of ['package.json', 'package-lock.json']) copyFileSync(join(root, filename), join(directory, filename));
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json')));
  mkdirSync(join(directory, 'node_modules'));
  for (const name of Object.keys(pkg.dependencies)) { const path = join(directory, 'node_modules', name); mkdirSync(dirname(path), {recursive:true}); symlinkSync(join(root, 'node_modules', name), path); }
  const standard = join(userHome, 'Library/Application Support/Godot/export_templates/4.6.stable'); templates(standard);
  templates(join(userHome, '.local/share/godot/export_templates/4.6.stable'));
  const bundleDirectory = join(directory, 'content/default-projects'), bundle = smallBundle(bundleDirectory);
  const env = {...process.env, PATH:bin, HOME:userHome, GODOT_BIN:godot, PYTHONDONTWRITEBYTECODE:'1'};
  for (const key of ['WORLD_ATELIER_EXPORT_TEMPLATES','WORLD_ATELIER_PUBLIC_PLAY','WORLD_ATELIER_DEFAULT_PROJECTS','WORLD_ATELIER_PREVIEW_PORT']) delete env[key];
  const run = (options = {}) => checkDeployment({directory, env, userHome, platform:process.platform, probeService:false, ...options});
  return {directory, bin, userHome, godot, standard, bundleDirectory, bundle, env, run};
}

function inventory(directory) {
  const rows = [];
  const walk = path => { for (const name of readdirSync(path).sort()) { const full = join(path, name), stat = lstatSync(full), local = full.slice(directory.length + 1); if (stat.isSymbolicLink()) rows.push([local, 'link', readlinkSync(full)]); else if (stat.isDirectory()) walk(full); else rows.push([local, stat.mode, hash(readFileSync(full))]); } };
  walk(directory); return rows;
}

test('a complete prerequisite fixture is classified without writing source or creating a service', {skip:process.platform !== 'darwin'}, async t => {
  const f = fixture(t), before = inventory(f.directory), report = await f.run();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => check.status === 'fail')));
  assert.equal(report.schema, 'world-atelier-deployment-check-1');
  assert.equal(result(report, 'execution_isolation').status, 'pass');
  assert.equal(result(report, 'esbuild_binary').status, 'pass');
  assert.deepEqual(result(report, 'godot').detail, {path:f.godot, version:EXPECTED_GODOT});
  assert.equal(result(report, 'preview_web_template').detail.zip_crc, 'passed');
  assert.equal(result(report, 'default_projects').detail.projects, 1);
  assert.equal(result(report, 'service'), undefined);
  assert.equal(report.checks.some(check => /codex/i.test(check.id)), false);
  assert.match(report.scope, /不代表.*游戏运行/);
  assert.deepEqual(inventory(f.directory), before);
});

test('unsupported hosts and old Node versions are explicit failures, not successful deployment', async t => {
  const f = fixture(t);
  for (const platform of ['linux', 'win32']) {
    const report = await f.run({platform}); assert.equal(report.ok, false);
    assert.equal(result(report, 'host').status, 'fail'); assert.match(result(report, 'host').detail, new RegExp(platform));
    assert.equal(result(report, 'execution_isolation'), undefined);
  }
  const old = await f.run({nodeVersion:'23.11.0'}); assert.equal(result(old, 'node').status, 'fail'); assert.match(result(old, 'node').detail, /24\+/);
  assert.equal(result(await f.run({nodeVersion:'24.0.0'}), 'node').status, 'pass');
});

test('Godot must exist, be executable and absolute, and print the exact pinned version', async t => {
  const f = fixture(t);
  for (const path of [join(f.directory, 'missing-godot'), 'godot']) { const report = await f.run({env:{...f.env, GODOT_BIN:path}}); assert.equal(result(report, 'godot').status, 'fail'); }
  chmodSync(f.godot, 0o644); assert.equal(result(await f.run(), 'godot').status, 'fail'); chmodSync(f.godot, 0o755);
  for (const version of ['4.7.stable.official.other', '4.6.1.stable.official.other', '4.6.stable.custom.89cea1439']) {
    program(f.godot, version, {versionOnly:true}); const report = await f.run();
    assert.equal(report.ok, false); assert.equal(result(report, 'godot').status, 'fail'); assert.ok(result(report, 'godot').detail.includes(version));
  }
  program(f.godot, 'Explicit failing version program', {code:7}); assert.equal(result(await f.run(), 'godot').status, 'fail');
});

test('tool detection honors the supplied PATH and rejects a Python 2 version program', async t => {
  const f = fixture(t), emptyPath = join(f.directory, 'empty-bin'); mkdirSync(emptyPath);
  const missing = await f.run({env:{...f.env, PATH:emptyPath}});
  for (const name of ['npm', 'git', 'python3', 'curl', 'zip']) assert.equal(result(missing, name).status, 'fail', name);
  assert.equal(result(missing, 'preview_web_template').status, 'fail');
  assert.equal(result(missing, 'godot').status, 'pass', 'an absolute version program does not depend on PATH');
  program(join(f.bin, 'python3'), 'Python 2.7.18');
  assert.equal(result(await f.run(), 'python3').status, 'fail');
});

test('standard preview templates remain required when Play uses a custom directory', async t => {
  const f = fixture(t), custom = join(f.directory, 'custom-templates'); templates(custom);
  const env = {...f.env, WORLD_ATELIER_EXPORT_TEMPLATES:custom};
  const good = await f.run({env});
  assert.equal(result(good, 'preview_web_template').status, 'pass');
  assert.equal(result(good, 'play_web_template').status, 'pass');
  assert.equal(result(good, 'play_web_template').detail.directory, custom);
  unlinkSync(join(f.standard, 'web_nothreads_release.zip'));
  const absentPreview = await f.run({env}); assert.equal(result(absentPreview, 'preview_web_template').status, 'fail'); assert.equal(result(absentPreview, 'play_web_template').status, 'pass');
  templates(f.standard); rmSync(custom, {recursive:true});
  const absentPlay = await f.run({env}); assert.equal(result(absentPlay, 'preview_web_template').status, 'pass'); assert.equal(result(absentPlay, 'play_web_template').status, 'fail');
  const emptyPlay = await f.run({env:{...f.env, WORLD_ATELIER_EXPORT_TEMPLATES:''}});
  assert.equal(result(emptyPlay, 'export_template_path')?.status, 'fail', 'an empty configured path must not silently fall back to the standard runtime directory');
  const relative = await f.run({env:{...f.env, WORLD_ATELIER_EXPORT_TEMPLATES:'custom-templates'}});
  assert.equal(result(relative, 'export_template_path')?.status, 'fail');
});

test('wrong template versions, missing members and real CRC corruption are rejected', async t => {
  const f = fixture(t), path = join(f.standard, 'web_nothreads_release.zip');
  templates(f.standard, {version:'4.7.stable'}); assert.equal(result(await f.run(), 'preview_web_template').status, 'fail');
  templates(f.standard, {entries:{'godot.js':'Explicit incomplete template'}}); assert.equal(result(await f.run(), 'preview_web_template').status, 'fail');
  templates(f.standard); const bytes = readFileSync(path), index = bytes.indexOf(Buffer.from('EXPLICIT INERT TEMPLATE SCRIPT')); assert.ok(index >= 0); bytes[index] ^= 1; writeFileSync(path, bytes);
  const corrupt = result(await f.run(), 'preview_web_template'); assert.equal(corrupt.status, 'fail'); assert.match(corrupt.detail, /Corrupt|CRC/);
  writeFileSync(path, 'Not a ZIP archive'); assert.equal(result(await f.run(), 'preview_web_template').status, 'fail');
});

test('an uninstalled checkout returns actionable checks instead of crashing on module imports', async t => {
  const f = fixture(t); rmSync(join(f.directory, 'node_modules'), {recursive:true});
  const report = await f.run();
  assert.equal(report.ok, false); assert.equal(result(report, 'dependencies').status, 'fail'); assert.equal(result(report, 'esbuild_binary').status, 'fail');
  assert.match(result(report, 'dependencies').fix, /npm ci/);
  assert.equal(result(report, 'default_projects').status, 'pass');
  unlinkSync(join(f.directory, 'package-lock.json'));
  assert.equal(result(await f.run(), 'dependency_lock').status, 'fail');
});

test('lock mismatches and an unusable esbuild implementation are reported separately', async t => {
  const f = fixture(t), path = join(f.directory, 'package-lock.json'), original = readFileSync(path), lock = JSON.parse(original);
  lock.packages['node_modules/esbuild'].version = '0.0.0'; writeFileSync(path, JSON.stringify(lock));
  assert.equal(result(await f.run(), 'dependencies').status, 'fail'); writeFileSync(path, original);
  // Use a separate checkout so Node's require resolution cache cannot retain
  // the previously loaded real esbuild behind this fixture's replaced symlink.
  const broken = fixture(t), esbuild = join(broken.directory, 'node_modules/esbuild'); unlinkSync(esbuild); mkdirSync(esbuild);
  writeFileSync(join(esbuild, 'package.json'), JSON.stringify({name:'esbuild', version:JSON.parse(original).packages['node_modules/esbuild'].version, main:'index.cjs'}));
  writeFileSync(join(esbuild, 'index.cjs'), 'exports.transformSync = () => { throw new Error("Explicit inert esbuild failure fixture"); };\n');
  const report = await broken.run(); assert.equal(result(report, 'dependencies').status, 'pass'); assert.equal(result(report, 'esbuild_binary').status, 'fail');
  assert.match(result(report, 'esbuild_binary').detail, /Explicit inert esbuild failure fixture/);
});

test('distribution preflight follows snapshot, source and cover references, not only listed objects', async t => {
  for (const missing of ['snapshot', 'source', 'cover']) await t.test(missing, async t => {
    const f = fixture(t), {catalog, project, manifest, save} = f.bundle;
    const key = missing === 'snapshot' ? project.branches[0].snapshot : missing === 'cover' ? project.cover.hash : manifest.source_files['project.godot'].hash;
    delete catalog.objects[key]; save(); // Still has a valid catalog fingerprint.
    const report = await f.run(); assert.equal(report.ok, false); assert.equal(result(report, 'default_projects').status, 'fail');
  });
});

test('missing or changed compressed distribution bytes cannot pass preflight', async t => {
  const f = fixture(t), entry = Object.values(f.bundle.catalog.objects)[0], part = entry.parts[0], path = join(f.bundleDirectory, `objects/${part.hash.slice(0, 2)}/${part.hash}.gzpart`);
  const bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes);
  assert.equal(result(await f.run(), 'default_projects').status, 'fail');
  unlinkSync(path); assert.equal(result(await f.run(), 'default_projects').status, 'fail');
});

test('configuration that hides examples and absent optional browser tooling are explicit', async t => {
  const f = fixture(t), report = await f.run({env:{...f.env, WORLD_ATELIER_DEFAULT_PROJECTS:'0', WORLD_ATELIER_PUBLIC_PLAY:'0'}});
  assert.equal(report.ok, false); assert.equal(result(report, 'default_projects_enabled').status, 'fail'); assert.equal(result(report, 'public_examples').status, 'fail');
  assert.equal(result(report, 'browser_test_dependency'), undefined);
  const browser = await f.run({browser:true}); assert.equal(result(browser, 'browser_test_dependency').status, 'fail'); assert.match(result(browser, 'browser_test_dependency').fix, /omit=dev/);
});

test('effective public/default flags match the actual server, including empty values and isolated ports', async t => {
  const f = fixture(t);
  for (const value of ['false', 'true', '']) {
    const report = await f.run({env:{...f.env, WORLD_ATELIER_DEFAULT_PROJECTS:value, WORLD_ATELIER_PUBLIC_PLAY:value}});
    assert.equal(result(report, 'default_projects_enabled')?.status, 'fail', JSON.stringify(value));
    assert.equal(result(report, 'public_examples')?.status, 'fail', JSON.stringify(value));
  }
  const privatePort = await f.run({env:{...f.env, WORLD_ATELIER_PREVIEW_PORT:'48921'}});
  assert.equal(result(privatePort, 'default_projects_enabled')?.status, 'fail');
  assert.equal(result(privatePort, 'public_examples')?.status, 'fail');
  const explicit = await f.run({env:{...f.env, WORLD_ATELIER_PREVIEW_PORT:'48921', WORLD_ATELIER_DEFAULT_PROJECTS:'1', WORLD_ATELIER_PUBLIC_PLAY:'1'}});
  assert.notEqual(result(explicit, 'default_projects_enabled')?.status, 'fail');
  assert.notEqual(result(explicit, 'public_examples')?.status, 'fail');
});

test('invalid ports and incomplete isolated-data configuration fail before any service probe', async t => {
  const f = fixture(t);
  for (const port of ['0', '65536', 'not-a-number']) assert.equal(result(await f.run({env:{...f.env, WORLD_ATELIER_PREVIEW_PORT:port}}), 'service_port')?.status, 'fail');
  const env = {...f.env, WORLD_ATELIER_PREVIEW_PORT:'48921', WORLD_ATELIER_DEFAULT_PROJECTS:'1', WORLD_ATELIER_PUBLIC_PLAY:'1'};
  assert.equal(result(await f.run({env}), 'isolated_test_data')?.status, 'fail');
  assert.equal(result(await f.run({env:{...env, WORLD_ATELIER_PREVIEW_DATA:'same-data', WORLD_ATELIER_CREATION_DATA:'same-data'}}), 'isolated_test_data')?.status, 'fail');
  assert.equal(result(await f.run({env:{...env, WORLD_ATELIER_PREVIEW_DATA:join(f.directory, 'preview'), WORLD_ATELIER_CREATION_DATA:join(f.directory, 'creation')}}), 'isolated_test_data')?.status, 'pass');
});

test('the read-only service probe distinguishes absent, matching, foreign and unresponsive listeners', async t => {
  const f = fixture(t), previousFetch = globalThis.fetch, calls = [];
  try {
    let transport;
    globalThis.fetch = async (url, options) => { calls.push({url, method:options?.method ?? 'GET'}); return transport(); };
    transport = () => { throw Object.assign(new TypeError('Explicit connection refusal fixture'), {cause:{code:'ECONNREFUSED'}}); };
    const absent = await f.run({probeService:true}); assert.equal(result(absent, 'service').status, 'info'); assert.equal(result(absent, 'service').detail.existing_workspace, false);
    transport = () => new Response(JSON.stringify({ok:true, service:'model-preview', runtime_ready:false, public_play:true, default_projects:true}), {headers:{'content-type':'application/json'}});
    const present = await f.run({probeService:true}); assert.equal(result(present, 'service').status, 'info'); assert.equal(result(present, 'service').detail.runtime_ready, false);
    transport = () => new Response(JSON.stringify({ok:true, service:'different-application'}), {headers:{'content-type':'application/json'}});
    assert.equal(result(await f.run({probeService:true}), 'service').status, 'fail');
    transport = () => { throw new DOMException('Explicit timeout fixture', 'TimeoutError'); };
    assert.equal(result(await f.run({probeService:true}), 'service').status, 'fail');
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.url === 'http://127.0.0.1:48910/preview-api/health' && call.method === 'GET'));
  } finally { globalThis.fetch = previousFetch; }
});

test('CLI JSON success has exit 0 while explicitly remaining a prerequisite check', {skip:process.platform !== 'darwin'}, t => {
  const f = fixture(t), preload = join(f.directory, 'no-network-probe.mjs');
  writeFileSync(preload, 'globalThis.fetch = async () => { throw Object.assign(new TypeError("Explicit absent-service fixture"), {cause:{code:"ECONNREFUSED"}}); };\n');
  const run = spawnSync(process.execPath, ['--import', preload, join(root, 'tools/check-deployment.mjs'), '--json'], {cwd:f.directory, env:f.env, encoding:'utf8', timeout:60000, maxBuffer:4*1024*1024});
  assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stdout + run.stderr);
  const report = JSON.parse(run.stdout); assert.equal(report.ok, true); assert.match(report.scope, /不代表.*游戏运行/);
  assert.equal(result(report, 'service').detail.existing_workspace, false);
});

test('CLI JSON failures have exit 1, invalid arguments have exit 2, and help has exit 0', t => {
  const f = fixture(t), script = join(root, 'tools/check-deployment.mjs');
  program(f.godot, '4.7.stable.official.explicit-fixture', {versionOnly:true});
  // Invalid service configuration prevents even a read-only network probe.
  const env = {...f.env, WORLD_ATELIER_PREVIEW_PORT:'not-a-port'};
  const failed = spawnSync(process.execPath, [script, '--json'], {cwd:f.directory, env, encoding:'utf8', timeout:60000, maxBuffer:4*1024*1024});
  assert.equal(failed.error, undefined); assert.equal(failed.status, 1, failed.stderr);
  const report = JSON.parse(failed.stdout); assert.equal(report.ok, false); assert.equal(report.root, root);
  assert.equal(result(report, 'godot').status, 'fail'); assert.equal(result(report, 'service_port').status, 'fail');
  for (const [args, exit] of [[['--unknown-option'], 2], [['--help'], 0]]) {
    const run = spawnSync(process.execPath, [script, ...args], {cwd:f.directory, env, encoding:'utf8', timeout:10000});
    assert.equal(run.error, undefined); assert.equal(run.status, exit);
  }
});
