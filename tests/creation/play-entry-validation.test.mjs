/** Real fixed-source assembly with an explicit command recorder.
 * No Godot command executes and no build is marked completed. These checks
 * cover validation selection/source retention, not successful game execution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';
import {DefaultProjectBundle} from '../../services/creation/default-projects.mjs';
import {gameStorage, snapshotProjectRuntime} from '../../services/creation/project-snapshot.mjs';
import {isPrefabTest, isPrefabTestPath} from '../../services/creation/prefab-tests.mjs';
import {hash} from '../../services/creation/schema.mjs';

const root = resolve(import.meta.dirname, '../..');

function fixture(t) {
  const data = mkdtempSync(join(tmpdir(), 'wa-play-entry-validation-'));
  const store = new CreationStore(join(data, 'creation.sqlite'));
  const native = new NativeProjects({store, data});
  const bundle = new DefaultProjectBundle(join(root, 'content/default-projects'));
  const sample = bundle.catalog.projects.find(project => project.name === '小小梦魇');
  const manifest = bundle.snapshot(sample.branches.find(branch => branch.id === 'main'));
  for (const entry of Object.values(manifest.source_files)) native.archive.put(bundle.readObject(entry.hash));
  const user = store.register({name:'Validation scope owner', password:'independent-validation-scope-password'}).user;
  const created = store.createProject(user, {name:sample.name}, manifest);
  const service = {root, data, store, native};
  const builds = new CreationBuilds({service});
  t.after(async () => { await builds.close(); await native.close(); store.close(); rmSync(data, {recursive:true, force:true}); });
  return {data, store, native, manifest, user, created, builds};
}

function jobFor(f, purpose) {
  const job = {id:'build-' + randomUUID(), kind:'application', ...(purpose ? {purpose} : {}), project_id:f.created.project.id, project_name:f.created.project.name, branch_id:'main', source_revision:f.created.branch.head,
    entry_scene_id:purpose === 'prefab_test' ? 'prefab-child' : f.manifest.entry_scene_id, actor_id:f.user.id, targets:['web'], status:'queued', artifacts:[], target_results:[]};
  const source = join(f.builds.directory, job.id, 'project');
  const snapshot = snapshotProjectRuntime(root, source);
  Object.assign(job, {runtime_sources:snapshot.files, runtime_source_hash:snapshot.hash, storage:gameStorage(f.builds.service, job.project_id, 'main')});
  return {job, source};
}

function recordCommands(f, {failEntry = false} = {}) {
  const commands = [], stop = Error('Independent test stops before platform export'), originalPresets = f.builds.presets.bind(f.builds);
  f.builds.presets = (job, configured = false) => {
    if (configured) throw stop;
    return originalPresets(job, configured);
  };
  f.builds.command = async (_job, bin, args, cwd, options = {}) => {
    commands.push({bin, args:[...args], cwd, options:{...options}});
    if (args.includes('--version')) return '4.6.stable.command-recording-test';
    if (args.some(arg => arg.startsWith('--release-scene=')) && failEntry) throw Error('Independent entry runtime failure');
    return ''; // Explicit test double: no readiness or runtime ACK is manufactured.
  };
  return {commands, stop};
}

test('Play validates only its canonical entry while preserving every gameplay dependency', async t => {
  const f = fixture(t), {job, source} = jobFor(f, 'play'), recorder = recordCommands(f);
  await assert.rejects(() => f.builds.execute(job), error => error === recorder.stop);
  const checks = recorder.commands.filter(command => command.args.some(arg => arg.startsWith('--release-scene=')));
  assert.equal(checks.length, 1);
  assert.ok(checks[0].args.includes('--release-scene=' + job.entry_scene_id));
  assert.ok(checks[0].args.includes('--headless'));
  assert.equal(checks[0].args[checks[0].args.indexOf('--fixed-fps') + 1], '60');
  assert.equal(checks[0].args[checks[0].args.indexOf('--quit-after') + 1], '180');
  assert.equal(checks[0].options.requiredMarker, 'STANDALONE_READY');
  assert.equal(checks[0].options.isolatedProject, source);
  assert.notEqual(checks[0].options.allowErrors, true);
  const imports = recorder.commands.filter(command => command.args.includes('--import'));
  assert.equal(imports.length, 1);
  assert.ok(recorder.commands.indexOf(imports[0]) < recorder.commands.indexOf(checks[0]));
  assert.equal(imports[0].options.importing, true);
  assert.equal(imports[0].options.isolatedProject, source);

  const inventory = new Map(job.source_files.map(entry => [entry.path, entry]));
  for (const [path, entry] of Object.entries(f.manifest.source_files)) {
    // Test-only source is retained centrally; canonical gameplay already has
    // an explicit policy excluding test_scenes/ from exported game projections.
    assert.equal(hash(f.native.archive.read(entry)), entry.hash);
    if (isPrefabTestPath(path)) continue;
    assert.ok(inventory.has(path), path + ' remains in the fixed source inventory');
    assert.ok(existsSync(join(f.builds.directory, job.id, 'export-project', path)), path + ' remains in the export projection');
    if (['project.godot', '.atelier/catalog.json'].includes(path)) continue;
    assert.equal(hash(readFileSync(join(source, path))), entry.hash, path);
    assert.equal(hash(readFileSync(join(f.builds.directory, job.id, 'export-project', path))), entry.hash, path);
  }
  const release = JSON.parse(readFileSync(join(source, 'atelier_runtime/release.json')));
  for (const resource of Object.values(f.manifest.resources).filter(resource => !isPrefabTest(resource))) assert.ok(release.scenes[resource.id], resource.id);
  assert.equal(release.entry_scene_id, job.entry_scene_id);
  assert.equal(release.scenes['prefab-child'].kind, 'prefab');
  assert.match(readFileSync(join(source, 'project.godot'), 'utf8'), /GameRuntime="\*res:\/\/atelier_runtime\/standalone.gd"/);
  assert.equal(f.store.branchFor(f.user, job.project_id, 'main').head, job.source_revision);
  assert.notEqual(job.status, 'completed');
  assert.deepEqual(job.artifacts, []);
});

test('ordinary exports and explicit prefab previews keep their existing validation scopes', async t => {
  for (const purpose of [undefined, 'prefab_test']) await t.test(purpose ?? 'ordinary application export', async t => {
    const f = fixture(t), {job} = jobFor(f, purpose), recorder = recordCommands(f);
    await assert.rejects(() => f.builds.execute(job), error => error === recorder.stop);
    const actual = recorder.commands.flatMap(command => command.args.filter(arg => arg.startsWith('--release-scene=')).map(arg => arg.slice('--release-scene='.length)));
    const expected = purpose === 'prefab_test' ? [job.entry_scene_id] : Object.values(f.manifest.resources).filter(resource => !isPrefabTest(resource)).map(resource => resource.id);
    assert.deepEqual(actual, expected);
    assert.notEqual(job.status, 'completed');
    assert.deepEqual(job.artifacts, []);
  });
});

test('an error during the selected Play entry still prevents export', async t => {
  const f = fixture(t), {job} = jobFor(f, 'play'), recorder = recordCommands(f, {failEntry:true});
  await assert.rejects(() => f.builds.execute(job), /Independent entry runtime failure/);
  assert.equal(recorder.commands.filter(command => command.args.some(arg => arg.startsWith('--release-scene='))).length, 1);
  assert.equal(recorder.commands.some(command => command.args.includes('--export-release')), false);
  assert.equal(job.timings.find(item => item.phase === 'resource_check').status, 'failed');
  assert.deepEqual(job.artifacts, []);
  assert.notEqual(job.status, 'completed');
  assert.equal(f.store.branchFor(f.user, job.project_id, 'main').head, job.source_revision);
});
