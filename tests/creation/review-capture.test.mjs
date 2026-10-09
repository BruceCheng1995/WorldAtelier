import test from 'node:test';
import assert from 'node:assert/strict';
import {backup} from 'node:sqlite';
import {mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationGoalReview} from '../../services/creation/goal-review.mjs';
import {CreationReviewCapture} from '../../services/creation/review-capture.mjs';
import {hash} from '../../services/creation/schema.mjs';

// REAL SQLite, auth, immutable object bytes, SHA-256, restart and backup/restore.
// FAKE world registry/socket/snapshots, Agent runs, validator and apply records.
// These are boundary/storage tests, NOT actual Godot/browser/Case 13 acceptance.
const work = resolve(import.meta.dirname, '../../.local/review-capture-tests');
mkdirSync(work, {recursive: true});
let counter = 0;
const requestId = () => `capture-test-${++counter}`;
const bad = (fn, status = 409) => assert.throws(fn, e => e.status === status);
const copy = value => structuredClone(value);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=', 'base64');

function fixture(t) {
  const directory = mkdtempSync(resolve(work, 'storage-')), dbPath = resolve(directory, 'creation.sqlite'), evidenceDirectory = resolve(directory, 'private-evidence');
  let store = new CreationStore(dbPath), capture, ledger;
  const owner = {id: 'owner'}, editor = {id: 'editor'}, viewer = {id: 'viewer'};
  for (const user of [owner, editor, viewer]) store.put('creator_user', {...user, name: user.id});
  const project = store.createProject(owner, {name: 'Capture storage fixture'}, {entry_scene_id: 'room', resources: {room: {id: 'room', kind: 'scene', name: 'Fake world scene', objects: []}}}).project;
  store.put('creator_project', {...project, members: {owner: 'owner', editor: 'editor', viewer: 'viewer'}});
  const session = store.createSession(owner, project.id, 'main');
  const revision = store.branchFor(owner, project.id, 'main').head;
  const run = {id: 'fake-run', session_id: session.id, project_id: project.id, branch_id: 'main', owner_user_id: owner.id, input_revision: revision, targets: [{resource_id: 'room', object_id: 'fixture-object'}], status: 'completed', verifications: ['fake-verification'], deliveries: ['fake-delivery'], changes: []};
  const goal = {id: 'fake-goal', session_id: session.id, run_id: run.id, objective: 'Fake goal for storage boundary test'};
  store.put('creator_run', run); store.put('creator_goal', goal);
  store.put('creator_verification', {id: 'fake-verification', project_id: project.id, branch_id: 'main', resource_id: 'room', revision, runtime_build_id: 'FAKE-build', status: 'passed', report: {test_double: true}});
  const snapshot = {world_id: 'FAKE-world', epoch: 1, scene_revision: revision, sequence: 20, players: {owner: {position: [1, 0, 2]}}, objects: [], test_double: true};
  const world = {id: snapshot.world_id, key: `${project.id}:main:room`, project_id: project.id, branch_id: 'main', resource_id: 'room', revision, runtime_build_id: 'FAKE-build', epoch: 1, snapshot, history: new Map(), ready: true, activated: true, ws: {readyState: 1}};
  for (const n of [9, 10, 15, 20]) world.history.set(n, {...copy(snapshot), sequence: n});
  store.put('creator_world', {id: world.id, project_id: project.id, branch_id: 'main', resource_id: 'room', revision, runtime_build_id: world.runtime_build_id, epoch: 1, snapshot: copy(snapshot)});
  store.put('creator_delivery', {id: 'fake-delivery', world_id: world.id, epoch: 1, revision, applied_sequence: 10, verification_id: 'fake-verification', created_at: 1});
  const worlds = {worlds: new Map([[world.key, world]])};
  function services() {
    capture = new CreationReviewCapture({store, worlds, directory: evidenceDirectory});
    ledger = new CreationGoalReview({store, resolveEvidence: capture.resolveEvidence});
  }
  services();
  t.after(() => {store.close(); rmSync(directory, {recursive: true, force: true});});
  const open = () => ledger.open(owner, goal.id, {request_id: requestId(), expected_review_id: ledger.current(goal.id)?.id ?? null, run_id: store.get('creator_goal', goal.id).run_id, revision, runtime_build_id: world.runtime_build_id, criteria: [{id: 'visible', text: 'Fixture pixels observation'}]}).review;
  const review = open();
  const input = (overrides = {}) => ({request_id: requestId(), goal_id: goal.id, review_id: ledger.current(goal.id).id, expected_version: ledger.current(goal.id).version, world_id: world.id, epoch: world.epoch, ...overrides});
  const begin = overrides => capture.beginClientObservation(owner, input(overrides));
  const submit = (start, bytes = PNG, user = owner) => capture.submitClientObservation(user, start.capture_id, {bytes, mime_type: 'image/png'});
  const share = () => store.put('creator_session', {...session, visibility: 'shared'});
  const delegate = users => ledger.setReviewers(owner, goal.id, {request_id: requestId(), review_id: ledger.current(goal.id).id, expected_version: ledger.current(goal.id).version, reviewer_user_ids: users});
  return {directory, dbPath, evidenceDirectory, owner, editor, viewer, project, session, revision, run, goal, review, world, worlds, input, open, begin, submit, share, delegate,
    get store() {return store;}, get capture() {return capture;}, get ledger() {return ledger;},
    restart() {store.close(); store = new CreationStore(dbPath); services();},
  };
}

test('capture: trace retains exact server-held historical snapshot bytes and all identities', t => {
  const f = fixture(t), expected = copy(f.world.history.get(15));
  const result = f.capture.captureRuntimeTrace(f.owner, f.input({sequence: 15}));
  const {artifact, bytes} = f.capture.readArtifact(f.owner, result.baseline_ref);
  assert.deepEqual(JSON.parse(bytes).snapshot, expected);
  assert.equal(hash(bytes), artifact.sha256); assert.equal(artifact.kind, 'runtime_trace');
  assert.equal(artifact.pin.provenance, 'server_runtime_snapshot'); assert.equal(artifact.pin.render_verified, false);
  assert.deepEqual(Object.fromEntries(['project_id','branch_id','session_id','goal_id','run_id','review_id','revision','runtime_build_id','world_id','epoch','sequence'].map(k => [k, artifact.pin[k]])), {project_id: f.project.id, branch_id: 'main', session_id: f.session.id, goal_id: f.goal.id, run_id: f.run.id, review_id: f.review.id, revision: f.revision, runtime_build_id: 'FAKE-build', world_id: 'FAKE-world', epoch: 1, sequence: 15});
  assert.equal(artifact.pin.state_hash, hash(expected)); assert(!('storage_key' in artifact));
  f.world.history.get(15).players.owner.position[0] = 99; f.world.history.clear();
  assert.deepEqual(f.capture.readArtifact(f.owner, artifact.id).bytes, bytes);
  assert.equal(statSync(resolve(f.evidenceDirectory, artifact.sha256)).mode & 0o777, 0o600);
  assert.equal(statSync(f.evidenceDirectory).mode & 0o777, 0o777 & 0o700);
});

test('capture: rejects missing, future, pre-application and mismatched history snapshots', t => {
  const f = fixture(t);
  for (const sequence of [9, 11, 21]) bad(() => f.begin({sequence}));
  f.world.history.set(21, {...f.world.snapshot, sequence: 21}); bad(() => f.begin({sequence: 21}));
  for (const patch of [{epoch: 2}, {world_id: 'elsewhere'}, {scene_revision: 'old'}, {sequence: 16}, {runtime_fault: {message: 'boom'}}]) {
    f.world.history.set(15, {...copy(f.world.snapshot), sequence: 15, ...patch}); bad(() => f.begin({sequence: 15}));
  }
  for (const n of [-1, 1.5, '15']) bad(() => f.begin({sequence: n}), 400);
  assert.equal(f.store.list('creator_goal_review_artifact').length, 0);
});

test('capture: persisted world rows cannot impersonate a currently connected authority', t => {
  const f = fixture(t);
  f.worlds.worlds.clear(); bad(() => f.begin()); f.worlds.worlds.set(f.world.key, f.world);
  const original = {...f.world};
  for (const patch of [{ready: false}, {activated: false}, {failed: true}, {failure: {}}, {ws: {readyState: 3}}, {runtime_build_id: 'different'}, {revision: 'old'}, {branch_id: 'other'}, {project_id: 'other'}, {key: 'not-registered'}]) {
    Object.assign(f.world, original, patch); bad(() => f.begin());
  }
  Object.assign(f.world, original); f.worlds.closing = true; bad(() => f.begin());
  assert.equal(f.store.list('creator_goal_review_artifact').length, 0);
});

test('capture: source, run, target and actual delivery binding are checked at start', t => {
  const f = fixture(t), delivery = f.store.get('creator_delivery', 'fake-delivery');
  f.store.put('creator_delivery', {...delivery, applied_sequence: 11}); bad(() => f.begin());
  f.store.put('creator_delivery', delivery);
  for (const patch of [{targets: []}, {input_hash: 'changed'}]) {
    f.store.put('creator_run', {...f.run, ...patch}); bad(() => f.begin());
  }
  f.store.put('creator_run', f.run); f.store.put('creator_goal', {...f.goal, objective: 'changed'}); bad(() => f.begin());
  f.store.put('creator_goal', f.goal);
  const branch = f.store.branchFor(f.owner, f.project.id, 'main');
  f.store.put('creator_branch', {...branch, head: 'new-source'}); bad(() => f.begin());
});

test('capture: durable request replay preserves old identity and checks permission first', t => {
  const f = fixture(t), input = f.input(), a = f.capture.beginClientObservation(f.owner, input);
  f.restart();
  assert.equal(f.capture.beginClientObservation(f.owner, input).capture_id, a.capture_id);
  bad(() => f.capture.captureRuntimeTrace(f.owner, input));
  bad(() => f.capture.beginClientObservation(f.owner, {...input, sequence: 15}));
  f.open();
  assert.equal(f.capture.beginClientObservation(f.owner, input).pin.review_id, f.review.id, 'retry never moves to new review');
  const p = f.store.get('creator_project', f.project.id); delete p.members.owner; f.store.put('creator_project', p);
  bad(() => f.capture.beginClientObservation(f.owner, input), 403);
});

test('capture: client image preserves bytes, labels user provenance and cannot be overwritten', t => {
  const f = fixture(t), start = f.begin(), result = f.submit(start);
  assert.equal(result.artifact.kind, 'authenticated_client_observation');
  assert.equal(result.artifact.pin.provenance, 'authenticated_user_upload');
  assert.equal(result.artifact.pin.render_verified, false);
  assert.equal(result.artifact.submitted_by, f.owner.id);
  assert.deepEqual(f.capture.readArtifact(f.owner, result.artifact.id).bytes, PNG);
  f.world.snapshot.sequence = 40; f.world.history.clear();
  assert.equal(f.submit(start).replayed, true);
  bad(() => f.submit(start, Buffer.concat([PNG, Buffer.from('different')])));
  assert.equal(f.store.list('creator_goal_review_artifact').length, 2);
});

test('capture: unknown paths, URLs, forged pin/snapshot/kind and invalid image inputs fail closed', t => {
  const f = fixture(t);
  for (const patch of [{url: 'https://example.com'}, {path: '/etc/passwd'}, {snapshot: f.world.snapshot}, {kind: 'runtime_trace'}, {pin: {review_id: f.review.id}}]) bad(() => f.begin(patch), 400);
  const start = f.begin();
  for (const patch of [{url: 'https://example.com'}, {storage_key: '../secret'}, {pin: start.pin}, {kind: 'runtime_trace'}]) bad(() => f.capture.submitClientObservation(f.owner, start.capture_id, {bytes: PNG, mime_type: 'image/png', ...patch}), 400);
  bad(() => f.submit(start, 'file:///etc/passwd'), 413);
  bad(() => f.submit(start, Buffer.alloc(8 * 1024 * 1024 + 1)), 413);
  bad(() => f.submit(start, Buffer.from('<html>')), 415);
  bad(() => f.capture.submitClientObservation(f.owner, start.capture_id, {bytes: PNG, mime_type: 'text/html'}), 415);
  const trace = f.capture.captureRuntimeTrace(f.owner, f.input()); bad(() => f.submit(trace), 403);
});

test('capture: late image cannot finish or resolve into a newer review of the same goal/run', t => {
  const f = fixture(t), pending = f.begin(), completed = f.begin(), oldImage = f.submit(completed).artifact;
  const newer = f.open();
  bad(() => f.submit(pending));
  assert.equal(f.submit(completed).artifact.pin.review_id, f.review.id, 'completed retry stays historical');
  bad(() => f.capture.resolveEvidence({user: f.owner, goal: f.goal, review: newer, reference: oldImage.id}));
  bad(() => f.ledger.addEvidence(f.owner, f.goal.id, {request_id: requestId(), review_id: newer.id, expected_version: newer.version, artifact_refs: [oldImage.id], checks: [{criterion_id: 'visible', result: 'passed', observation: 'stale image'}]}));
  assert.equal(f.ledger.current(f.goal.id).evidence_ids.length, 0);
});

test('capture: late image is rejected after source/run/epoch changes or a terminal decision', t => {
  const f = fixture(t), start = f.begin();
  f.store.put('creator_run', {...f.run, id: 'next-run'}); f.store.put('creator_goal', {...f.goal, run_id: 'next-run'}); bad(() => f.submit(start));
  f.store.put('creator_goal', f.goal);
  f.world.epoch = 2; bad(() => f.submit(start)); f.world.epoch = 1;
  f.world.resource_id = 'another-scene'; bad(() => f.submit(start)); f.world.resource_id = 'room';
  f.world.snapshot.sequence = 19; bad(() => f.submit(start)); f.world.snapshot.sequence = 20;
  const branch = f.store.branchFor(f.owner, f.project.id, 'main'); f.store.put('creator_branch', {...branch, head: 'next-source'}); bad(() => f.submit(start)); f.store.put('creator_branch', branch);
  f.ledger.decide(f.owner, f.goal.id, {request_id: requestId(), review_id: f.review.id, expected_version: 1, outcome: 'reject', reason: 'test boundary', evidence_ids: []}); bad(() => f.submit(start));
});

test('capture: advancing world history and another evidence addition do not rewrite pending capture pins', t => {
  const f = fixture(t), first = f.begin({sequence: 15}), trace = f.capture.captureRuntimeTrace(f.owner, f.input());
  f.ledger.addEvidence(f.owner, f.goal.id, {request_id: requestId(), review_id: f.review.id, expected_version: 1, artifact_refs: [trace.baseline_ref], checks: [{criterion_id: 'visible', result: 'failed', observation: 'fixture observation'}]});
  f.world.snapshot.sequence = 80; f.world.history.clear();
  const image = f.submit(first).artifact;
  assert.equal(image.pin.sequence, 15); assert.equal(image.pin.review_version, 1);
});

test('capture: private/shared read rights, explicit reviewer writes and uploader identity', t => {
  const f = fixture(t), trace = f.capture.captureRuntimeTrace(f.owner, f.input());
  for (const user of [f.editor, f.viewer, {id: 'stranger'}]) bad(() => f.capture.readArtifact(user, trace.baseline_ref), 403);
  f.share();
  assert.equal(f.capture.readArtifact(f.viewer, trace.baseline_ref).artifact.id, trace.baseline_ref);
  bad(() => f.capture.beginClientObservation(f.viewer, f.input()), 403);
  bad(() => f.capture.beginClientObservation(f.editor, f.input()), 403);
  f.delegate([f.editor.id]);
  const editorStart = f.capture.beginClientObservation(f.editor, f.input());
  bad(() => f.submit(editorStart), 403);
  f.delegate([]); bad(() => f.submit(editorStart, PNG, f.editor), 403);
  f.store.put('creator_session', f.session); bad(() => f.capture.readArtifact(f.viewer, trace.baseline_ref), 403);
});

test('capture: expired pending image is retained as a baseline but cannot be completed', t => {
  const f = fixture(t), start = f.begin(), intent = f.store.get('creator_goal_review_capture', start.capture_id);
  // Explicit clock fixture; the production module never mutates capture intents.
  f.store.put('creator_goal_review_capture', {...intent, expires_at: Date.now() - 1});
  bad(() => f.submit(start));
  assert(f.capture.retentionRoots().artifacts.some(a => a.id === start.baseline_ref));
  assert(f.capture.readArtifact(f.owner, start.baseline_ref).bytes.length);
});

test('capture: corrupt/missing objects and symlinks cannot be served, resolved or backed up', t => {
  const f = fixture(t), trace = f.capture.captureRuntimeTrace(f.owner, f.input()), path = resolve(f.evidenceDirectory, trace.artifact.sha256);
  const original = readFileSync(path); writeFileSync(path, 'corrupted');
  bad(() => f.capture.readArtifact(f.owner, trace.baseline_ref));
  bad(() => [...f.capture.enumerateBackupArtifacts()]);
  writeFileSync(path, original); unlinkSync(path); bad(() => f.capture.readArtifact(f.owner, trace.baseline_ref));
  const outside = resolve(f.directory, 'outside'); writeFileSync(outside, original); symlinkSync(outside, path);
  bad(() => f.capture.readArtifact(f.owner, trace.baseline_ref));
  bad(() => f.capture.readBytes('../outside'));
});

test('capture: new artifact resolver integrates with ledger and decision rereads actual bytes', t => {
  const f = fixture(t), image = f.submit(f.begin()).artifact;
  const evidence = f.ledger.addEvidence(f.owner, f.goal.id, {request_id: requestId(), review_id: f.review.id, expected_version: 1, artifact_refs: [image.id], checks: [{criterion_id: 'visible', result: 'passed', observation: 'Explicit fixture pixels, not real acceptance'}]});
  const decision = {request_id: requestId(), review_id: f.review.id, expected_version: evidence.review.version, outcome: 'pass', reason: 'Storage integration fixture only', evidence_ids: [evidence.evidence.id]};
  const path = resolve(f.evidenceDirectory, image.sha256); writeFileSync(path, 'broken'); bad(() => f.ledger.decide(f.owner, f.goal.id, decision));
  writeFileSync(path, PNG); assert.equal(f.ledger.decide(f.owner, f.goal.id, decision).decision.outcome, 'pass');
});

test('capture: full SQLite and enumerated byte backup restores historical reviews in fresh paths', async t => {
  const f = fixture(t), completed = f.submit(f.begin()).artifact, pending = f.begin({sequence: 15});
  f.open();
  const roots = f.capture.retentionRoots();
  assert.deepEqual(roots.revision_ids, [f.revision]); assert.deepEqual(roots.runtime_build_ids, ['FAKE-build']);
  assert.equal(roots.review_ids.length, 2, 'uncaptured current review also retains its source');
  assert(roots.artifacts.some(a => a.id === pending.baseline_ref));
  const restoredDirectory = resolve(f.directory, 'restore'); mkdirSync(restoredDirectory, {mode: 0o700});
  const restoredDb = resolve(restoredDirectory, 'creation.sqlite');
  await backup(f.store.db, restoredDb);
  for (const file of f.capture.enumerateBackupArtifacts()) {
    const path = resolve(restoredDirectory, file.relative_path); mkdirSync(resolve(restoredDirectory, 'review-evidence'), {recursive: true, mode: 0o700});
    writeFileSync(path, file.bytes, {mode: 0o600}); assert.equal(hash(readFileSync(path)), file.sha256);
  }
  const restoredStore = new CreationStore(restoredDb);
  try {
    const restored = new CreationReviewCapture({store: restoredStore, worlds: {worlds: new Map()}, directory: resolve(restoredDirectory, 'review-evidence')});
    rmSync(f.evidenceDirectory, {recursive: true});
    assert.deepEqual(restored.readArtifact(f.owner, completed.id).bytes, PNG);
    assert.equal(restored.readArtifact(f.owner, pending.baseline_ref).artifact.pin.sequence, 15);
    assert.deepEqual(restored.retentionRoots(), roots);
    bad(() => restored.captureRuntimeTrace(f.owner, f.input()));
    bad(() => restored.readArtifact(f.viewer, completed.id), 403);
  } finally {restoredStore.close();}
});
