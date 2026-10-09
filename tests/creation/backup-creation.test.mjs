import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationGoalReview} from '../../services/creation/goal-review.mjs';
import {CreationReviewCapture} from '../../services/creation/review-capture.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {createCreationBackup, restoreCreationBackup} from '../../tools/backup-creation.mjs';

// Actual SQLite online backup, file IO, hash verification, private permissions,
// CLI restore and post-deletion reads. Godot snapshots, build exports, validation
// and Agent runs are explicit FAKE fixtures, not runtime acceptance evidence.
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const work = resolve(root, '.local/backup-creation-tests'); mkdirSync(work, {recursive: true});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=', 'base64');
const privateText = 'PRIVATE BACKUP SESSION CONTENT';
let n = 0; const request = () => `backup-fixture-${++n}`;

function fixture(t, {withCapabilities = true, mismatchCapabilitySource = false} = {}) {
  const directory = mkdtempSync(resolve(work, 'case-')), data = resolve(directory, 'live/creation'), runtimes = resolve(directory, 'live/releases');
  const evidenceRoot = resolve(data, 'review-evidence');
  let store = new CreationStore(resolve(data, 'creation.sqlite')), closed = false;
  function close() {if (!closed) {store.close(); closed = true;}}
  t.after(() => {close(); rmSync(directory, {recursive: true, force: true});});
  const owner = {id: 'owner'}, viewer = {id: 'viewer'};
  for (const user of [owner, viewer]) store.put('creator_user', {...user, name: user.id});
  const project = store.createProject(owner, {name: 'Backup storage fixture'}, {entry_scene_id: 'room', resources: {room: {id: 'room', kind: 'scene', name: 'Fixture', objects: []}}}).project;
  const p = store.get('creator_project', project.id); p.members.viewer = 'viewer'; store.put('creator_project', p);
  const base = store.branchFor(owner, project.id, 'main').head;
  const asset = (extension, bytes) => {
    const id = hash(bytes); mkdirSync(resolve(data, 'assets'), {recursive: true}); writeFileSync(resolve(data, 'assets', `${id}.${extension}`), bytes);
    store.put('creator_asset', {id, ext: extension, bytes: bytes.length, project_ids: [project.id]}); return id;
  };
  const model = asset('glb', Buffer.from('FAKE GLB BYTE FIXTURE')), script = asset('gd', Buffer.from('FAKE GDSCRIPT BYTE FIXTURE'));
  const unused = asset('glb', Buffer.from('FAKE REGISTERED UNREFERENCED ASSET'));
  const scene = {schema: 'creation-hierarchy-2', entry_scene_id: 'room', resources: {room: {id: 'room', nodes: {}, instances: {fixture: {overrides: [{path: ['model_hash'], value: model}, {path: ['model_url'], value: `/preview-assets/${model}.glb`}]}}}}, prefab_revisions: {historic: {nodes: {node: {model_hash: model, model_url: `/preview-assets/${model}.glb`, components: {behaviors: [{script_hash: script, script_url: `/preview-assets/${script}.gd`}]}}}}}};
  const revision = store.writeRevision(project.id, [base], scene, owner.id).id;
  const branch = store.branchFor(owner, project.id, 'main'); store.put('creator_branch', {...branch, head: revision});
  const capabilities = {schema: 1, document_schemas: ['creation-hierarchy-2'], features: ['FAKE-feature']};
  const capabilityBytes = Buffer.from(JSON.stringify(capabilities) + '\n');
  const sources = [{path: 'preview.gd', sha256: hash('FAKE RUNTIME SOURCE')}, ...(withCapabilities ? [{path: 'runtime_capabilities.json', sha256: hash(mismatchCapabilitySource ? 'DIFFERENT SOURCE BYTES' : capabilityBytes)}] : [])];
  const files = ['index.html','index.js','index.wasm','index.pck'].map(path => {const bytes = Buffer.from(`FAKE EXPORT ${path}`); return {path, sha256: hash(bytes), bytes: bytes.length};});
  if (withCapabilities) files.push({path: 'runtime_capabilities.json', sha256: hash(capabilityBytes), bytes: capabilityBytes.length});
  const buildId = hash(JSON.stringify({sources, files})); mkdirSync(resolve(runtimes, buildId), {recursive: true});
  for (const file of files) writeFileSync(resolve(runtimes, buildId, file.path), file.path === 'runtime_capabilities.json' ? capabilityBytes : `FAKE EXPORT ${file.path}`);
  writeFileSync(resolve(runtimes, buildId, 'manifest.json'), JSON.stringify({format: 1, build_id: buildId, sources, files, ...(withCapabilities ? {capabilities} : {})}));
  const session = store.createSession(owner, project.id, 'main', {visibility:'private'}); store.put('creator_session', {...session, draft: privateText});
  const run = {id: 'fake-run', session_id: session.id, project_id: project.id, branch_id: 'main', owner_user_id: owner.id, input_revision: revision, status: 'completed', changes: [], targets: [], verifications: ['fake-verification'], deliveries: ['fake-delivery']};
  const goal = {id: 'fake-goal', session_id: session.id, run_id: run.id, objective: 'FAKE BACKUP GOAL'};
  store.put('creator_run', run); store.put('creator_goal', goal);
  store.put('creator_verification', {id: 'fake-verification', project_id: project.id, branch_id: 'main', resource_id: 'room', revision, runtime_build_id: buildId, status: 'passed'});
  const snapshot = {world_id: 'FAKE-world', epoch: 1, scene_revision: revision, sequence: 20, objects: [], test_double: true};
  const world = {id: 'FAKE-world', key: 'FAKE-key', project_id: project.id, branch_id: 'main', resource_id: 'room', revision, runtime_build_id: buildId, epoch: 1, snapshot, ready: true, activated: true, ws: {readyState: 1}, history: new Map()};
  store.put('creator_world', {...world, ws: undefined, history: undefined});
  store.put('creator_delivery', {id: 'fake-delivery', world_id: world.id, epoch: 1, revision, applied_sequence: 10, verification_id: 'fake-verification'});
  const captures = new CreationReviewCapture({store, worlds: {worlds: new Map([[world.key, world]])}, directory: evidenceRoot});
  const reviews = new CreationGoalReview({store, resolveEvidence: captures.resolveEvidence});
  const open = () => reviews.open(owner, goal.id, {request_id: request(), expected_review_id: reviews.current(goal.id)?.id ?? null, run_id: run.id, revision, runtime_build_id: buildId, criteria: [{id: 'check', text: 'FAKE criteria'}]}).review;
  const review = open(), input = () => ({request_id: request(), goal_id: goal.id, review_id: review.id, expected_version: 1, world_id: world.id, epoch: 1});
  const complete = captures.beginClientObservation(owner, input());
  const image = captures.submitClientObservation(owner, complete.capture_id, {bytes: PNG, mime_type: 'image/png'}).artifact;
  const pending = captures.beginClientObservation(owner, input()); open();
  return {directory, data, runtimes, evidenceRoot, store, owner, viewer, project, base, revision, buildId, model, script, unused, image, pending, complete, close, asset,
    create: (out, extra = {}) => createCreationBackup({data, out, ...extra}),
    destroySources() {close(); rmSync(resolve(directory, 'live'), {recursive: true});},
  };
}
function rows(path, kind) {const db = new DatabaseSync(path, {readOnly: true}); try {return db.prepare('SELECT body FROM documents WHERE kind=?').all(kind).map(r => JSON.parse(r.body));} finally {db.close();}}
function assertPrivate(path) {assert.equal(statSync(path).mode & 0o777, statSync(path).isDirectory() ? 0o700 : 0o600); if (statSync(path).isDirectory()) for (const name of readdirSync(path)) assertPrivate(resolve(path, name));}

test('backup: fixed online SQLite inventory excludes later writes; fresh CLI restore survives original deletion', async t => {
  const f = fixture(t), out = resolve(f.directory, 'backup'), restored = resolve(f.directory, 'restored');
  let lateAsset;
  const result = await f.create(out, {onSnapshot() {lateAsset = f.asset('glb', Buffer.from('LATE LIVE ASSET')); f.store.put('creator_message', {id: 'late-message', text: 'written while copying'});}});
  assert.equal(result.ok, true); assert.equal(result.artifact_count, 3); assertPrivate(out);
  const snapshotDb = resolve(out, 'data/creation.sqlite');
  assert(!rows(snapshotDb, 'creator_asset').some(a => a.id === lateAsset)); assert.equal(rows(snapshotDb, 'creator_message').length, 0);
  assert(f.store.get('creator_asset', lateAsset), 'online writer was not paused or rolled back');
  const retained = JSON.parse(readFileSync(resolve(out, 'retention.json')));
  assert.deepEqual(retained.source_revision_ids, [f.base, f.revision].sort()); assert.equal(retained.review_ids.length, 2); assert.equal(retained.capture_ids.length, 2);
  assert.deepEqual(retained.source_asset_closure.find(r => r.revision_id === f.revision).asset_refs.map(a => `${a.id}.${a.ext}`).sort(), [`${f.model}.glb`, `${f.script}.gd`].sort());
  assert.equal(retained.runtime_sources[0].source_bytes_included, false);
  assert(existsSync(resolve(out, `data/assets/${f.unused}.glb`)), 'conservative closure retains registered unused assets');
  f.destroySources();
  const cli = await exec(process.execPath, [resolve(root, 'tools/backup-creation.mjs'), 'restore', `--from=${out}`, `--out=${restored}`]);
  assert.equal(JSON.parse(cli.stdout).ok, true); assert(!cli.stdout.includes(privateText)); assertPrivate(restored);
  const store = new CreationStore(resolve(restored, 'data/creation.sqlite'));
  try {
    const capture = new CreationReviewCapture({store, worlds: {worlds: new Map()}, directory: resolve(restored, 'data/review-evidence')});
    assert.deepEqual(capture.readArtifact(f.owner, f.image.id).bytes, PNG);
    assert.equal(capture.readArtifact(f.owner, f.pending.baseline_ref).artifact.pin.review_id, f.image.pin.review_id);
    assert.throws(() => capture.readArtifact(f.viewer, f.image.id), e => e.status === 403);
    assert.equal(store.get('creator_session', f.image.pin.session_id).draft, privateText);
    assert.equal(hash(readFileSync(resolve(restored, `data/assets/${f.model}.glb`))), f.model);
    assert.equal(readFileSync(resolve(restored, `runtimes/${f.buildId}/index.wasm`), 'utf8'), 'FAKE EXPORT index.wasm');
  } finally {store.close();}
});

test('backup: bad evidence, asset and Web runtime hashes fail without a completed destination', async t => {
  for (const kind of ['evidence','asset','runtime']) await t.test(kind, async t => {
    const f = fixture(t), out = resolve(f.directory, 'backup');
    const path = kind === 'evidence' ? resolve(f.evidenceRoot, f.image.sha256) : kind === 'asset' ? resolve(f.data, 'assets', `${f.model}.glb`) : resolve(f.runtimes, f.buildId, 'index.wasm');
    writeFileSync(path, 'CORRUPTED');
    await assert.rejects(f.create(out), /mismatch/);
    assert(!existsSync(out)); assert(!readdirSync(f.directory).some(name => name.includes('.preparing-')));
  });
});

test('backup: missing registered closure or pending baseline fails before claiming completion', async t => {
  for (const kind of ['asset_registration','baseline']) await t.test(kind, async t => {
    const f = fixture(t), out = resolve(f.directory, 'backup');
    if (kind === 'asset_registration') f.store.remove('creator_asset', f.script);
    else f.store.remove('creator_goal_review_artifact', f.pending.baseline_ref);
    await assert.rejects(f.create(out), /missing/); assert(!existsSync(out));
  });
});

test('backup: invalid build identity or missing retained historical build fails', async t => {
  const f = fixture(t), out = resolve(f.directory, 'backup'), path = resolve(f.runtimes, f.buildId, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path)); manifest.sources[0].sha256 = '0'.repeat(64); writeFileSync(path, JSON.stringify(manifest));
  await assert.rejects(f.create(out), /identity mismatch/); assert(!existsSync(out));
  unlinkSync(path); await assert.rejects(f.create(out), /ENOENT/); assert(!existsSync(out));
});

test('backup: symlinks are rejected and existing destination is never overwritten', async t => {
  const f = fixture(t), out = resolve(f.directory, 'backup'), artifactPath = resolve(f.evidenceRoot, f.image.sha256), outside = resolve(f.directory, 'outside');
  writeFileSync(outside, PNG); unlinkSync(artifactPath); symlinkSync(outside, artifactPath);
  await assert.rejects(f.create(out), /Symlink/); assert(!existsSync(out));
  mkdirSync(out); writeFileSync(resolve(out, 'keep'), 'KEEP');
  await assert.rejects(f.create(out), /already exists/); assert.equal(readFileSync(resolve(out, 'keep'), 'utf8'), 'KEEP');
  await assert.rejects(f.create(resolve(f.data, 'nested-backup')), /outside/);
});

test('restore: tampered bytes, omitted DB-referenced evidence and path traversal cannot publish a restore', async t => {
  const f = fixture(t), out = resolve(f.directory, 'backup'), restored = resolve(f.directory, 'restore'); await f.create(out);
  const artifactPath = resolve(out, 'data/review-evidence', f.image.sha256); writeFileSync(artifactPath, 'BAD');
  await assert.rejects(restoreCreationBackup({from: out, out: restored}), /mismatch/); assert(!existsSync(restored)); writeFileSync(artifactPath, PNG);
  const manifestPath = resolve(out, 'backup.json'), original = JSON.parse(readFileSync(manifestPath));
  writeFileSync(manifestPath, JSON.stringify({...original, files: original.files.filter(f => f.path !== `data/review-evidence/${hash(PNG)}`)}));
  await assert.rejects(restoreCreationBackup({from: out, out: restored}), /closure file missing/); assert(!existsSync(restored));
  writeFileSync(manifestPath, JSON.stringify({...original, files: [...original.files, {path: '../escape', sha256: hash('bad'), bytes: 3}]}));
  await assert.rejects(restoreCreationBackup({from: out, out: restored}), /Unsafe/); assert(!existsSync(restored));
});

test('backup: CLI create uses explicit private evidence/runtime roots and prints no stored session data', async t => {
  const f = fixture(t), out = resolve(f.directory, 'backup');
  const cli = await exec(process.execPath, [resolve(root, 'tools/backup-creation.mjs'), 'create', `--data=${f.data}`, `--out=${out}`, `--evidence-root=${f.evidenceRoot}`, `--runtime-root=${f.runtimes}`]);
  assert.equal(JSON.parse(cli.stdout).ok, true); assert(!cli.stdout.includes(privateText)); assertPrivate(out);
  const manifest = JSON.parse(readFileSync(resolve(out, 'backup.json')));
  assert.equal(manifest.consistency, 'sqlite_online_backup_then_fixed_snapshot_inventory');
  assert.equal(manifest.contains_private_authorization_data, true);
});

test('backup: capability bytes and source hash must bind the top-level projection', async t => {
  const f = fixture(t), out = resolve(f.directory, 'backup'), manifestPath = resolve(f.runtimes, f.buildId, 'manifest.json');
  const original = readFileSync(manifestPath), manifest = JSON.parse(original);
  manifest.capabilities.features = ['UNBOUND CLAIM']; writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.create(out), /capability projection mismatch/); assert(!existsSync(out));
  writeFileSync(manifestPath, original);
  writeFileSync(resolve(f.runtimes, f.buildId, 'runtime_capabilities.json'), '{}');
  await assert.rejects(f.create(out), /capability bytes mismatch/); assert(!existsSync(out));
});

test('backup: legacy Web builds without capabilities remain restorable without invented source bytes', async t => {
  const f = fixture(t, {withCapabilities: false}), out = resolve(f.directory, 'backup'), restored = resolve(f.directory, 'restore');
  await f.create(out); f.destroySources(); await restoreCreationBackup({from: out, out: restored});
  assert(!existsSync(resolve(restored, 'runtimes', f.buildId, 'runtime_capabilities.json')));
  assert.equal(JSON.parse(readFileSync(resolve(restored, 'retention.json'))).runtime_sources[0].source_bytes_included, false);
});

test('backup: a valid build hash cannot excuse different capability source and export digests', async t => {
  const f = fixture(t, {mismatchCapabilitySource: true}), out = resolve(f.directory, 'backup');
  await assert.rejects(f.create(out), /capability source\/file binding mismatch/); assert(!existsSync(out));
});
