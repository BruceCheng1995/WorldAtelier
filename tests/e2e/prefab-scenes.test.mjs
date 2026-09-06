import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, readdir, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GODOT = process.env.GODOT_BIN ?? '/Applications/Godot.app/Contents/MacOS/Godot';
const RENDER = process.env.WORLD_ATELIER_E2E_RENDER === '1';
const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const systems = ['selection', 'editing', 'testing', 'delivered', 'failed', 'move_and_dash', 'combat', 'death_respawn',
  'collection_reward', 'beacon_progress', 'upgrade_and_healing', 'collision', 'content_replacement', 'offline_restore', 'player_avatar', 'model_binding'];
const systemChecks = { selection: 5, editing: 7, testing: 7, delivered: 7, failed: 7, move_and_dash: 5, combat: 5, death_respawn: 4,
  collection_reward: 5, beacon_progress: 4, upgrade_and_healing: 5, collision: 6, content_replacement: 5, offline_restore: 7, player_avatar: 9, model_binding: 6 };

test('independently load every real prefab scene and optionally capture its representative renderer', { timeout: 5 * 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'world-atelier-prefab-e2e-'));
  const game = join(directory, 'game'), generated = join(directory, 'generated');
  const evidence = { kind: 'independent-isolated-prefab-scene-audit', directory,
    launch_type: 'Godot editor binary --path isolated source copy', requested_render: RENDER, visual_reviewed: false,
    fixture_positions_resources_and_prerequisites_seeded: true, live_user_world_mutations: false, phases: [] };
  let inventory, manifest;
  const phase = async (name, fn) => {
    let failure;
    await t.test(name, async () => {
      const started = Date.now();
      try { await fn(); evidence.phases.push({ name, status: 'passed', elapsed_ms: Date.now() - started }); }
      catch (error) { failure = error; evidence.phases.push({ name, status: 'failed', error: error.message }); throw error; }
    });
    if (failure) throw new Error(`Dependent prefab stages stopped after: ${name}`, { cause: failure });
  };
  const execute = async (label, binary, args, timeout = 90_000) => {
    try {
      const result = await run(binary, args, { cwd: ROOT, timeout, maxBuffer: 8_000_000 });
      const log = result.stdout + result.stderr; await writeFile(join(directory, label + '.log'), log);
      assert.ok(!/(?:SCRIPT ERROR|Parse Error|(?:^|\n)ERROR:|PREFAB_FAIL|shader compilation|VALIDATE_STATUS)/i.test(log),
        `${label} contains a real runtime or renderer error; inspect preserved log.`);
      return result.stdout;
    } catch (error) {
      if (error.stdout !== undefined) await writeFile(join(directory, label + '.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
      throw error;
    }
  };
  const checkReport = async reportDir => {
    const report = JSON.parse(await readFile(join(reportDir, 'prefab-report.json'), 'utf8'));
    assert.equal(report.ok, true); assert.equal(report.failed, 0); assert.equal(report.fixtures, inventory.items.length);
    assert.deepEqual(new Set(report.results.map(item => item.id)), new Set(inventory.items.map(item => item.id)));
    assert.equal(new Set(report.results.map(item => item.id)).size, report.results.length, 'No fixture may be counted twice.');
    let total = 0;
    for (const item of inventory.items) {
      const result = report.results.find(value => value.id === item.id);
      assert.equal(result.ok, true, item.id); assert.equal(result.completed, true, item.id); assert.deepEqual(result.failures, [], item.id);
      const fixture = JSON.parse(await readFile(item.config, 'utf8'));
      let expected;
      if (item.category === 'object') {
        const definition = fixture.content.objects.find(value => value.id === fixture.subject_id);
        expected = 6 + (definition.solid === true ? 1 : 0) + (['crystal', 'beacon', 'gate', 'supply', 'forge'].includes(item.kind) ? 1 : 0);
      } else if (item.category === 'enemy') expected = 6;
      else expected = systemChecks[item.kind];
      assert.ok(Number.isInteger(expected), `No assertion-count contract for ${item.id}`);
      assert.equal(result.checks.length, expected, `${item.id}: a nested GDScript error must not silently omit checks.`);
      for (const check of result.checks) assert.equal(check.ok, true, `${item.id}: ${check.detail}`);
      total += result.checks.length;
    }
    assert.equal(total, 1928, 'Current authored inventory must execute all independently counted assertions.');
    return { fixtures: report.fixtures, assertions: total, rendered_captures: report.rendered_captures, path: join(reportDir, 'prefab-report.json') };
  };
  try {
    await phase('isolated source and generated inventory exactly cover authored IDs and supported systems', async () => {
      await cp(join(ROOT, 'runtimes/godot'), game, { recursive: true, filter: source => !['.git', '.local'].includes(basename(source)) });
      manifest = JSON.parse(await readFile(join(ROOT, '.local/runtime-build/manifest.json'), 'utf8'));
      for (const file of manifest.source_files) assert.equal(hash(await readFile(join(game, file.path))), file.sha256, `Source differs from exported manifest: ${file.path}`);
      evidence.reference_runtime_hash = manifest.hash; evidence.reference_source_hash = manifest.source_hash; evidence.matched_manifest_source_files = manifest.source_files.length;
      evidence.fixture_script_hash = hash(await readFile(join(game, 'tests/prefab_fixture.gd')));
      evidence.generator_hash = hash(await readFile(join(ROOT, 'tools/godot-prefab-scenes.py')));
      evidence.verifier_hash = hash(await readFile(join(ROOT, 'tools/godot-prefab-verify.gd')));
      evidence.engine_version = (await execute('engine-version', GODOT, ['--version'])).trim();
      await execute('generate-scenes', 'python3', [join(ROOT, 'tools/godot-prefab-scenes.py'), `--output=${generated}`]);
      inventory = JSON.parse(await readFile(join(generated, 'inventory.json'), 'utf8'));
      const sourceBytes = await readFile(join(ROOT, 'content/world.json')), source = JSON.parse(sourceBytes.toString());
      assert.equal(inventory.source_content_sha256, hash(sourceBytes));
      assert.deepEqual(inventory.counts, { objects: 227, extra_supported_prefabs: 1, enemies: 46, systems: 16, total: 290 });
      const expectedIds = [...source.objects.map(value => 'object-' + value.id), 'object-supported_platform',
        ...source.enemies.map(value => 'enemy-' + value.id), ...systems.map(value => 'system-' + value)];
      assert.equal(inventory.items.length, expectedIds.length); assert.deepEqual(new Set(inventory.items.map(value => value.id)), new Set(expectedIds));
      const canonicalGenerated = await realpath(generated);
      for (const item of inventory.items) {
        assert.ok((await realpath(item.scene)).startsWith(canonicalGenerated + '/') && (await realpath(item.config)).startsWith(canonicalGenerated + '/'));
        const scene = await readFile(item.scene, 'utf8');
        assert.match(scene, /\[gd_scene /); assert.match(scene, /res:\/\/tests\/prefab_fixture.gd/);
      }
      evidence.inventory = { path: join(generated, 'inventory.json'), counts: inventory.counts, content_sha256: inventory.source_content_sha256,
        object_kinds: inventory.object_kinds, enemy_kinds: inventory.enemy_kinds };
      await execute('isolated-import', GODOT, ['--headless', '--editor', '--path', game, '--import']);
    });
    await phase('every generated PackedScene executes complete actual gameplay and geometry assertions headlessly', async () => {
      const reportDir = join(directory, 'headless'); await mkdir(reportDir, { recursive: true });
      await execute('headless-scenes', GODOT, ['--headless', '--path', game, '--script', join(ROOT, 'tools/godot-prefab-verify.gd'), '--',
        `--inventory=${join(generated, 'inventory.json')}`, `--report-dir=${reportDir}`]);
      evidence.headless = await checkReport(reportDir); assert.equal(evidence.headless.rendered_captures, 0);
    });
    if (RENDER) await phase('actual native renderer captures all 36 prefab and system categories without runtime or shader errors', async () => {
      const reportDir = join(directory, 'render'); await mkdir(reportDir, { recursive: true });
      await execute('render-scenes', GODOT, ['--path', game, '--resolution', '1440x960', '--script', join(ROOT, 'tools/godot-prefab-verify.gd'), '--',
        '--render', `--inventory=${join(generated, 'inventory.json')}`, `--report-dir=${reportDir}`], 120_000);
      evidence.render = await checkReport(reportDir); assert.equal(evidence.render.rendered_captures, 36);
      const captures = (await readdir(reportDir)).filter(name => name.endsWith('.png'));
      const expected = [...new Set(inventory.items.map(item => `${item.category}-${item.kind}.png`))];
      assert.equal(captures.length, 36); assert.deepEqual(new Set(captures), new Set(expected));
      evidence.render.images = [];
      for (const name of captures) {
        const bytes = await readFile(join(reportDir, name)); assert.ok(bytes.length > 1000);
        assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
        evidence.render.images.push({ path: join(reportDir, name), bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: hash(bytes) });
      }
    });
  } finally {
    await writeFile(join(directory, 'observations.json'), JSON.stringify(evidence, null, 2));
    t.diagnostic(`Independent prefab evidence: ${directory}/observations.json. ${evidence.render?.images ? `${evidence.render.images.length} rendered captures require separate visual inspection.` : 'No completed rendered-capture evidence.'} Uses editor binary, not exported app or Web clients; seeded fixtures do not prove campaign completion or GLB mesh collision.`);
  }
});
