/** Uses actual completed Agent/review records in an authorized online database.
 * No server, executor, authority, fabricated domain rows or browser is started.
 * Read APIs below use real product prototypes with a read-only SQLite connection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCreationBackup} from '../../tools/backup-creation.mjs';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationGoalReview} from '../../services/creation/goal-review.mjs';
import {CreationReviewCapture} from '../../services/creation/review-capture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exec = promisify(execFile), pause = ms => new Promise(yes => setTimeout(yes, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
const json = path => JSON.parse(readFileSync(path, 'utf8'));

function readOnlyStore(path) {
  // Bypass the normal writable bootstrap only; all domain reads and permission
  // checks are the actual CreationStore/Storage methods over actual backup rows.
  const store = Object.create(CreationStore.prototype);
  store.db = new DatabaseSync(path, {readOnly: true});
  store.read = store.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?');
  return store;
}
function withStore(path, fn) {const store = readOnlyStore(path); try {return fn(store);} finally {store.close();}}
function privateTree(path) {
  const s = statSync(path); assert.equal(s.mode & 0o777, s.isDirectory() ? 0o700 : 0o600, path);
  if (s.isDirectory()) for (const name of readdirSync(path)) privateTree(resolve(path, name));
}

test('actual online creation backup, isolated restore, private evidence and run history', {timeout: 120000}, async t => {
  assert.equal(process.env.WORLD_ATELIER_RUN_LIVE_BACKUP, '1', 'Explicit owner authorization required for the source database');
  const data = resolve(process.env.WORLD_ATELIER_BACKUP_SOURCE_DATA ?? 'missing');
  const runtimeRoot = resolve(process.env.WORLD_ATELIER_BACKUP_RUNTIME_ROOT ?? 'missing');
  const priorPath = resolve(process.env.WORLD_ATELIER_BACKUP_AGENT_REPORT ?? 'missing');
  const prior = json(priorPath); assert.equal(prior.completed, true); assert.equal(prior.counts.passed, 5);
  const resumePath = process.env.WORLD_ATELIER_BACKUP_RESUME_REPORT;
  const resume = resumePath ? json(resolve(resumePath)) : null;
  if (resume) {
    assert.equal(resume.source_data, data); assert.equal(resume.source_agent_report, priorPath);
    for (const id of ['BI01', 'BI02', 'BI03']) assert.equal(resume.cases.find(c => c.id === id)?.status, 'passed');
  }
  assert.equal(data, resolve(root, '.local/creation-verification/hierarchy-world/ui-fixture-c08affc6/creation'));
  assert.equal(runtimeRoot, resolve(root, '.local/creation-verification/integration-ui/code-1dde/.local/model-preview/releases'));
  const out = resolve(root, '.local/creation-verification/backup-integration', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(out, {recursive: true, mode: 0o700}); chmodSync(out, 0o700);
  const bundle = resume ? resume.bundle : resolve(out, 'bundle'), restore = resume ? resume.restore : resolve(out, 'restore');
  const liveDB = resolve(data, 'creation.sqlite'), snapshotDB = resolve(bundle, 'data/creation.sqlite'), restoredDB = resolve(restore, 'data/creation.sqlite');
  const worldId = prior.initial_world.world_id, sessionId = prior.creator_session_id;
  const finalCase = prior.cases.find(c => c.id === 'RB03').observations;
  const goalId = finalCase.run.goal_id, expectedRuns = prior.final_session.runs.map(r => r.id);
  const report = {started_at: new Date().toISOString(), source_data: data, runtime_root: runtimeRoot, source_agent_report: priorPath,
    output: out, bundle, restore, completed: false, cases: [], ...(resume ? {resumed_from: resolve(resumePath), resumed_scope: 'Only recheck BI04 against the same existing restored snapshot; prior backup/restore results stay unchanged'} : {}), scope: 'Real existing online SQLite, real retained Agent/Godot verification records and runtime traces. Restore is storage-only; no authority/server/executor starts, fake rows or browser inputs.',
    limitations: ['Historical validation directory files (candidate.json, report.json and godot.log) are excluded by the backup format; the actual inline report/process records are retained.', 'Godot engine, historical runtime source bytes, Agent workspace and process continuation are not in this data backup. Web runtime files and source hash inventory are included.']};
  const files = ['tools/backup-creation.mjs', 'services/creation/store.mjs', 'services/creation/goal-review.mjs', 'services/creation/review-capture.mjs', 'services/control-plane/storage.mjs'];
  report.source_hashes = Object.fromEntries(files.map(f => [f, digest(readFileSync(resolve(root, f)))]));
  if (resume) assert.deepEqual(report.source_hashes, resume.source_hashes);
  const save = () => writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  const liveWorld = () => withStore(liveDB, s => s.get('creator_world', worldId));
  async function step(id, title, fn) {
    const c = {id, title, status: 'running', started_at: Date.now(), observations: {}}; report.cases.push(c);
    await t.test(`${id} ${title}`, async () => {try {await fn(c.observations); c.status = 'passed';} catch (e) {c.status = 'failed'; c.error = {message: e.message, stack: e.stack}; throw e;} finally {c.finished_at = Date.now(); save(); console.log(`LIVE_BACKUP_CASE ${id} ${c.status}`);}});
    if (c.status !== 'passed') throw Error(`Stop after ${id}; original online service is untouched`);
  }
  let manifest, retention, snapshotWorld;
  try {
    if (resume) {manifest = json(resolve(bundle, 'backup.json')); retention = json(resolve(bundle, 'retention.json'));}
    else {
    await step('BI01', 'online SQLite snapshot stays fixed while the original real world advances', async o => {
      const health = await fetch('http://127.0.0.1:48921/creation-api/health'); assert.equal(health.status, 200);
      o.health_before = await health.json(); assert.equal(o.health_before.worlds_ready, true);
      const result = await createCreationBackup({data, out: bundle, runtimeRoot, onSnapshot: async timing => {
        const staged = readdirSync(out).filter(name => name.startsWith('bundle.preparing-')); assert.equal(staged.length, 1);
        const fixedPath = resolve(out, staged[0], 'data/creation.sqlite');
        snapshotWorld = withStore(fixedPath, s => s.get('creator_world', worldId)); assert.ok(snapshotWorld?.snapshot);
        const fixedHash = digest(stable(snapshotWorld)), until = Date.now() + 10000;
        let later = liveWorld();
        while (later.snapshot.sequence <= snapshotWorld.snapshot.sequence && Date.now() < until) {await pause(100); later = liveWorld();}
        assert.equal(later.id, worldId); assert.equal(later.epoch, snapshotWorld.epoch); assert.equal(later.revision, snapshotWorld.revision);
        assert.ok(later.snapshot.sequence > snapshotWorld.snapshot.sequence); assert.ok(later.snapshot.tick > snapshotWorld.snapshot.tick);
        assert.equal(digest(stable(withStore(fixedPath, s => s.get('creator_world', worldId)))), fixedHash);
        o.online_observation = {...timing, snapshot_sequence: snapshotWorld.snapshot.sequence, snapshot_tick: snapshotWorld.snapshot.tick, later_sequence: later.snapshot.sequence, later_tick: later.snapshot.tick, fixed_world_record_sha256: fixedHash};
      }});
      assert.equal(result.ok, true); manifest = json(resolve(bundle, 'backup.json')); retention = json(resolve(bundle, 'retention.json'));
      assert.equal(manifest.consistency, 'sqlite_online_backup_then_fixed_snapshot_inventory'); assert.equal(manifest.status, 'complete');
      assert.equal(digest(stable(withStore(snapshotDB, s => s.get('creator_world', worldId)))), o.online_observation.fixed_world_record_sha256);
      privateTree(bundle); o.result = result; o.manifest_sha256 = digest(readFileSync(resolve(bundle, 'backup.json')));
    });
    await step('BI02', 'real restore CLI and every backup file match byte-for-byte in a new private directory', async o => {
      const result = await exec(process.execPath, [resolve(root, 'tools/backup-creation.mjs'), 'restore', `--from=${bundle}`, `--out=${restore}`]);
      writeFileSync(resolve(out, 'restore-cli.log'), result.stdout + result.stderr, {mode: 0o600}); o.cli = {exit_code: 0, stdout: JSON.parse(result.stdout)};
      assert.equal(o.cli.stdout.ok, true); assert.equal(json(resolve(restore, 'restore.json')).service_started, false);
      o.files = [];
      for (const f of manifest.files) {
        const before = readFileSync(resolve(bundle, f.path)), after = readFileSync(resolve(restore, f.path));
        assert.equal(before.length, f.bytes); assert.equal(after.length, f.bytes); assert.equal(digest(before), f.sha256); assert.equal(digest(after), f.sha256); assert.ok(before.equals(after));
        o.files.push({path: f.path, bytes: f.bytes, sha256: f.sha256});
      }
      for (const p of [snapshotDB, restoredDB]) assert.equal(withStore(p, s => s.db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
      privateTree(restore); o.total_bytes = o.files.reduce((sum, f) => sum + f.bytes, 0);
    });
    await step('BI03', 'actual two traces, validation records and complete Web runtime closure survive restore', async o => {
      const refs = prior.cases.find(c => c.id === 'RB04').observations;
      const traceDescriptors = ['before', 'after'].map(label => refs[label].result.artifact);
      o.traces = [];
      for (const expected of traceDescriptors) {
        const row = withStore(restoredDB, s => s.get('creator_goal_review_artifact', expected.id));
        assert.equal(row.sha256, expected.sha256); assert.deepEqual(row.pin, expected.pin);
        const live = readFileSync(resolve(data, 'review-evidence', row.storage_key)), restored = readFileSync(resolve(restore, 'data/review-evidence', row.storage_key));
        assert.ok(live.equals(restored)); assert.equal(digest(restored), expected.sha256); assert.equal(restored.length, expected.byte_length);
        o.traces.push({id: row.id, sha256: row.sha256, bytes: row.byte_length, pin: row.pin});
      }
      const verifications = withStore(snapshotDB, s => s.list('creator_verification').filter(v => v.project_id === prior.project_id));
      o.verifications = [];
      for (const expected of verifications) {
        const actual = withStore(restoredDB, s => s.get('creator_verification', expected.id));
        assert.deepEqual(actual, expected);
        const rawPath = resolve(data, 'worlds/verification', expected.id, 'report.json'), raw = readFileSync(rawPath);
        assert.deepEqual(JSON.parse(raw), actual.report);
        const originalRow = withStore(snapshotDB, s => s.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get('creator_verification', expected.id).body);
        const restoredRow = withStore(restoredDB, s => s.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get('creator_verification', expected.id).body);
        assert.equal(originalRow, restoredRow);
        o.verifications.push({id: actual.id, status: actual.status, exit_code: actual.process.code, origin: actual.origin ?? null, sqlite_body_sha256: digest(originalRow), canonical_report_sha256: digest(stable(actual.report)), original_report_file_sha256: digest(raw), original_report_file_restored: existsSync(resolve(restore, 'data/worlds/verification', expected.id, 'report.json'))});
      }
      assert.equal(verifications.length, 4); assert.deepEqual(o.verifications.map(v => v.exit_code).sort(), [0, 0, 0, 2]);
      assert.ok(retention.runtime_build_ids.includes(prior.expected_runtime_build)); o.runtimes = [];
      for (const build of retention.runtime_build_ids) {
        const before = readFileSync(resolve(runtimeRoot, build, 'manifest.json')), after = readFileSync(resolve(restore, 'runtimes', build, 'manifest.json'));
        assert.ok(before.equals(after)); const m = JSON.parse(after);
        assert.equal(digest(JSON.stringify({sources: m.sources, files: m.files})), build);
        for (const f of m.files) {const live = readFileSync(resolve(runtimeRoot, build, f.path)), restored = readFileSync(resolve(restore, 'runtimes', build, f.path)); assert.ok(live.equals(restored)); assert.equal(digest(restored), f.sha256); assert.equal(restored.length, f.bytes);}
        o.runtimes.push({build_id: build, manifest_sha256: digest(after), file_count: m.files.length, capabilities: m.capabilities, source_inventory_count: m.sources.length, historical_source_bytes_included: false});
      }
      for (const build of retention.runtime_sources) assert.equal(build.source_bytes_included, false);
      o.asset_file_count = manifest.files.filter(f => f.path.startsWith('data/assets/')).length;
      o.all_retained_source_revision_count = retention.source_revision_ids.length;
    });
    }
    await step('BI04', 'restored real permissions and same-goal histories can be read without starting a runtime', async o => {
      const access = json(resolve(dirname(priorPath), 'access.private.json'));
      const store = readOnlyStore(restoredDB);
      try {
        const owner = store.publicUser(store.get('creator_user', access.users[0].user_id)), outsider = store.publicUser(store.get('creator_user', access.users[1].user_id));
        const session = store.sessionView(owner, sessionId); assert.equal(session.goals.length, 1); assert.deepEqual(session.runs.map(r => r.id), expectedRuns); assert.equal(session.messages.filter(m => m.role === 'user').length, 2);
        assert.throws(() => store.sessionView(outsider, sessionId), e => e.status === 403);
        const ledger = new CreationGoalReview({store}), context = ledger.context(owner, goalId); assert.equal(context.run.id, finalCase.run.id);
        const history = ledger.history(owner, goalId), expectedHistory = prior.cases.find(c => c.id === 'RB05').observations.history;
        const originalBytes = readFileSync(resolve(dirname(priorPath), 'own-records-readonly.json'));
        assert.equal(digest(originalBytes), json(resolve(dirname(priorPath), 'evidence-sha256.json'))['own-records-readonly.json']);
        const originalRecords = JSON.parse(originalBytes);
        assert.ok(history.length >= expectedHistory.length);
        for (const expected of expectedHistory) {
          const actual = history.find(h => h.review.id === expected.review.id); assert.ok(actual);
          // The initial public report masked numeric process.code as a secret.
          // Its hash-pinned read-only SQLite audit preserved the real exit code.
          const original = originalRecords.find(r => r.kind === 'creator_goal_review' && r.id === expected.review.id); assert.ok(original);
          assert.deepEqual(actual.review, original.body); assert.deepEqual(actual.decision, expected.decision);
        }
        const snapshotReviews = withStore(snapshotDB, s => s.list('creator_goal_review').filter(r => r.goal_id === goalId));
        assert.equal(history.length, snapshotReviews.length);
        for (const row of snapshotReviews) assert.deepEqual(history.find(h => h.review.id === row.id).review, row);
        assert.throws(() => ledger.history(outsider, goalId), e => e.status === 403);
        // Actual artifact read methods, with no live-world constructor/registry.
        const capture = Object.assign(Object.create(CreationReviewCapture.prototype), {store, ledger, directory: resolve(restore, 'data/review-evidence')});
        const artifacts = store.list('creator_goal_review_artifact').filter(a => a.session_id === sessionId); assert.ok(artifacts.length >= 2);
        const expectedArtifacts = prior.cases.find(c => c.id === 'RB04').observations;
        for (const label of ['before', 'after']) assert.ok(artifacts.some(a => a.id === expectedArtifacts[label].result.artifact.id));
        for (const a of artifacts) {const value = capture.readArtifact(owner, a.id); assert.equal(digest(value.bytes), a.sha256); assert.throws(() => capture.readArtifact(outsider, a.id), e => e.status === 403);}
        let cursor = 0, count = 0; for (;;) {const events = store.sessionEvents(owner, sessionId, cursor); if (!events.length) break; for (const e of events) {assert.ok(e.cursor > cursor); cursor = e.cursor; count++;}}
        assert.ok(count >= prior.cases.find(c => c.id === 'RB05').observations.event_count); assert.throws(() => store.sessionEvents(outsider, sessionId), e => e.status === 403);
        o.result = {session_id: sessionId, goal_id: goalId, run_ids: session.runs.map(r => r.id), thread_ids: session.runs.map(r => r.thread_id), turn_ids: session.runs.map(r => r.turn_id), reviews: history.map(h => ({id: h.review.id, run_id: h.review.run_id, outcome: h.decision?.outcome ?? null})), original_review_ids_unchanged: expectedHistory.map(h => h.review.id), later_online_review_ids: history.filter(h => !expectedHistory.some(e => e.review.id === h.review.id)).map(h => h.review.id), event_count: count, event_cursor: cursor, private_read_rejections: 3 + artifacts.length, actual_world_process_started: false, auth_login_not_executed: true};
      } finally {store.close();}
      const dbEntry = manifest.files.find(f => f.path === 'data/creation.sqlite'); assert.equal(digest(readFileSync(restoredDB)), dbEntry.sha256, 'Read-only permission checks must not alter restored DB bytes');
      const health = await fetch('http://127.0.0.1:48921/creation-api/health'); assert.equal(health.status, 200); o.health_after = await health.json();
    });
    report.completed = true;
  } catch (e) {report.fatal_error = {message: e.message, stack: e.stack}; throw e;}
  finally {
    report.finished_at = new Date().toISOString(); report.counts = {executed: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length};
    report.source_hashes_after = Object.fromEntries(files.map(f => [f, digest(readFileSync(resolve(root, f)))])); report.source_changed_during_run = files.filter(f => report.source_hashes[f] !== report.source_hashes_after[f]); if (report.source_changed_during_run.length) report.completed = false;
    save(); writeFileSync(resolve(out, 'executed-driver.mjs'), readFileSync(fileURLToPath(import.meta.url)), {mode: 0o600}); console.log(`LIVE_CREATION_BACKUP_REPORT ${resolve(out, 'report.json')}`);
  }
});
