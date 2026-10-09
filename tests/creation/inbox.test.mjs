import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationInbox} from '../../services/creation/inbox.mjs';
import {issueSummary} from '../../apps/creation-workspace/inbox.js';

// Domain/SQLite tests only: producer events below are declared synthetic test
// input. They are not evidence of actual Agent/Godot/browser verification.
function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'atelier-inbox-test-')), path = resolve(directory, 'creation.sqlite');
  let store = new CreationStore(path), clock = 1000, sequence = 0, notifications = [];
  const owner = {id: 'owner', name: 'Owner'}, editor = {id: 'editor', name: 'Editor'}, viewer = {id: 'viewer', name: 'Viewer'}, outsider = {id: 'outsider', name: 'Other'};
  for (const user of [owner, editor, viewer, outsider]) store.put('creator_user', user);
  const manifest = {entry_scene_id: 'room', resources: {room: {id: 'room', kind: 'scene', name: 'Room', objects: [{id: 'marker', kind: 'anchor'}]}, prefab: {id: 'prefab', kind: 'prefab', name: 'Prefab', objects: []}}};
  const created = store.createProject(owner, {name: 'Inbox fixture'}, manifest), projectId = created.project.id;
  const project = store.get('creator_project', projectId); project.members.editor = 'editor'; project.members.viewer = 'viewer'; store.put('creator_project', project);
  const session = store.createSession(owner, projectId, 'main', {title: 'PRIVATE SESSION', visibility: 'private'}), revision = created.branch.head;
  const run = {id: 'run1', goal_id: 'goal1', session_id: session.id, project_id: projectId, branch_id: 'main', owner_user_id: owner.id, input_revision: revision, changes: [], status: 'running'};
  const goal = {id: 'goal1', run_id: run.id, run_ids: [run.id], session_id: session.id};
  store.put('creator_run', run); store.put('creator_goal', goal);
  const create = () => new CreationInbox({store, now: () => clock, onChanged: event => notifications.push(event)});
  let inbox = create();
  t.after(() => {store.close(); rmSync(directory, {recursive: true, force: true});});
  const input = (changes = {}) => ({event_id: `event-${++sequence}`, dedupe_key: 'synthetic-load-error', source: 'backend', kind: 'error',
    project_id: projectId, branch_id: 'main', resource_id: 'room', revision, title: 'Synthetic fault', message: 'TEST ONLY failure',
    targets: [{resource_id: 'room', object_id: 'marker', private_note: 'PRIVATE TARGET TEXT'}], ...changes});
  const agent = (changes = {}) => input({source: 'agent', session_id: session.id, run_id: run.id, goal_id: goal.id, title: 'PRIVATE TITLE', message: 'PRIVATE BODY', ...changes});
  return {get store() {return store;}, get inbox() {return inbox;}, owner, editor, viewer, outsider, projectId, project, session, run, goal, revision, input, agent,
    get notifications() {return notifications;}, tick(n = 1) {clock += n;},
    restart() {store.close(); store = new CreationStore(path); notifications = []; inbox = create();}};
}
const bad = (fn, status = 409) => assert.throws(fn, error => error.status === status);

test('inbox: shared issues go to current developers, private Agent issues only to owner; counts do not leak', t => {
  const f = fixture(t), common = f.inbox.record(f.input()).item, secret = f.inbox.record(f.agent()).item;
  assert.deepEqual(common.recipient_user_ids, ['editor', 'owner']); assert.deepEqual(secret.recipient_user_ids, ['owner']);
  assert.equal(f.inbox.list(f.owner).items.length, 2);
  assert.deepEqual(f.inbox.list(f.editor).counts, {unread: 1, actionable: 1});
  assert.deepEqual(f.inbox.list(f.viewer).counts, {unread: 0, actionable: 0});
  assert.deepEqual(f.inbox.list(f.outsider).counts, {unread: 0, actionable: 0});
  bad(() => f.inbox.get(f.editor, secret.id), 403); bad(() => f.inbox.get(f.viewer, common.id), 403);
  assert(!JSON.stringify(f.inbox.list(f.editor)).includes('PRIVATE'));
  bad(() => f.inbox.record(f.agent({recipient_user_ids: ['editor']})), 403);
  bad(() => f.inbox.record(f.input({recipient_user_ids: ['outsider']})), 403);
});

test('inbox: exact event replay is durable and changed payload cannot reuse the event ID', t => {
  const f = fixture(t), input = f.input(), first = f.inbox.record(input);
  assert.equal(first.changed, true); assert.equal(f.notifications.length, 1);
  const replay = f.inbox.record(input); assert.equal(replay.replayed, true); assert.equal(replay.item.occurrences, 1);
  bad(() => f.inbox.record({...input, message: 'changed'}));
  bad(() => f.inbox.record({...input, branch_id: 'other'}));
  f.restart(); const p = f.store.get('creator_project', f.projectId); delete p.members.editor; f.store.put('creator_project', p);
  assert.equal(f.inbox.record(input).replayed, true, 'membership drift does not rewrite original event fingerprint');
  assert.equal(f.store.list('creator_inbox_item').length, 1);
});

test('inbox: repeated frames aggregate; material progress and actual recurrence become unread again', t => {
  const f = fixture(t), first = f.inbox.record(f.input()).item;
  f.inbox.read(f.owner, first.id, {expected_version: 1, request_id: 'read-first'});
  f.tick(); const repeat = f.inbox.record(f.input());
  assert.equal(repeat.item.id, first.id); assert.equal(repeat.item.occurrences, 2); assert.equal(repeat.item.version, 1); assert.equal(repeat.changed, false);
  assert.equal(f.inbox.get(f.owner, first.id).unread, false);
  f.tick(); const update = f.inbox.record(f.input({message: 'A different observed detail'}));
  assert.equal(update.item.version, 2); assert.equal(f.inbox.get(f.owner, first.id).unread, true);
  f.inbox.close(first.id, {status: 'resolved', reason: 'Synthetic successful repeat of covered check'});
  f.tick(); const reopened = f.inbox.record(f.input({message: 'A different observed detail'}));
  assert.equal(reopened.item.status, 'open'); assert.equal(reopened.item.version, 4); assert.equal(reopened.item.resolution, null);
  assert.equal(reopened.item.resolution_history[0].status, 'resolved', 'recurrence preserves prior closure history');
});

test('inbox: read is personal, preserves issue state, guards versions and reauthorizes receipt replay', t => {
  const f = fixture(t), item = f.inbox.record(f.input()).item, input = {expected_version: 1, request_id: 'read-1'};
  const result = f.inbox.read(f.owner, item.id, input);
  assert.equal(result.item.status, 'open'); assert.equal(result.item.unread, false); assert.equal(result.item.read_at, 1000);
  assert.equal(f.inbox.get(f.editor, item.id).unread, true); assert.equal(f.inbox.get(f.editor, item.id).read_at, null);
  assert.equal(f.inbox.read(f.owner, item.id, input).replayed, true);
  f.tick(); f.inbox.record(f.input({message: 'New material finding'}));
  assert.equal(f.inbox.read(f.owner, item.id, input).item.unread, true, 'old replay cannot read new content');
  bad(() => f.inbox.read(f.owner, item.id, {...input, expected_version: 2}));
  bad(() => f.inbox.read(f.owner, item.id, {expected_version: 1, request_id: 'stale-read'}));
  const project = f.store.get('creator_project', f.projectId); delete project.members.owner; f.store.put('creator_project', project);
  bad(() => f.inbox.read(f.owner, item.id, input), 403);
});

test('inbox: recipient details are revoked when project role or session visibility changes', t => {
  const f = fixture(t); f.store.put('creator_session', {...f.session, visibility: 'shared'});
  const item = f.inbox.record(f.input({session_id: f.session.id})).item;
  assert.equal(f.inbox.get(f.editor, item.id).status, 'open');
  f.store.put('creator_session', f.session);
  bad(() => f.inbox.get(f.editor, item.id), 403); assert.equal(f.inbox.list(f.editor).counts.unread, 0);
  f.store.put('creator_session', {...f.session, visibility: 'shared'});
  const p = f.store.get('creator_project', f.projectId); p.members.editor = 'viewer'; f.store.put('creator_project', p);
  bad(() => f.inbox.get(f.editor, item.id), 403); assert.equal(f.inbox.list(f.editor).items.length, 0);
});

test('inbox: global backend notifications require explicit persisted recipients and never make asset markers', t => {
  const f = fixture(t), input = {event_id: 'global1', dedupe_key: 'global', source: 'backend', kind: 'error', title: 'Connection lost', message: 'Synthetic service fault'};
  bad(() => f.inbox.record(input), 400);
  const item = f.inbox.record({...input, recipient_user_ids: [f.owner.id]}).item;
  assert.equal(f.inbox.get(f.owner, item.id).project_id, null); assert.equal(f.inbox.list(f.editor).items.length, 0);
  assert.equal(f.inbox.projection(f.owner, f.projectId, 'main').length, 0);
  bad(() => f.inbox.record({...input, event_id: 'global2', recipient_user_ids: [f.owner.id], resource_id: 'room'}), 400);
});

test('inbox: cross-branch, revision, source, build, target and request pins keep incidents distinct', t => {
  const f = fixture(t); f.store.fork(f.owner, f.projectId, {from_branch: 'main', branch_id: 'other'});
  const variants = [f.input(), f.input({branch_id: 'other'}), f.input({source: 'godot_client'}), f.input({runtime_build_id: 'another-build'}),
    f.input({targets: [{resource_id: 'room', object_id: 'different'}]})];
  const ids = variants.map(input => f.inbox.record(input).item.id); assert.equal(new Set(ids).size, 5);
  assert.equal(f.inbox.projection(f.owner, f.projectId, 'other').length, 1);
  const address = {project_id: f.projectId, branch_id: 'other', resource_id: 'room', instance_path: [], definition_node_id: 'marker'};
  bad(() => f.inbox.record(f.input({targets: [{address}]})));
  bad(() => f.inbox.record(f.agent({branch_id: 'other'})));
});

test('inbox: source advancement preserves historical unresolved items but removes current asset markers', t => {
  const f = fixture(t), item = f.inbox.record(f.input()).item;
  const before = f.inbox.projection(f.viewer, f.projectId, 'main'); assert.equal(before.length, 1);
  const branch = f.store.branchFor(f.owner, f.projectId, 'main');
  const manifest = f.store.get('creator_revision', branch.head).manifest; manifest.resources.room.name = 'Changed room';
  const next = f.store.writeRevision(f.projectId, [branch.head], manifest, f.owner.id, {test: 'advance'});
  f.store.put('creator_branch', {...branch, head: next.id});
  const current = f.inbox.get(f.owner, item.id); assert.equal(current.status, 'open'); assert.equal(current.context_current, false);
  assert.equal(f.inbox.projection(f.viewer, f.projectId, 'main').length, 0);
  const newItem = f.inbox.record(f.input({revision: next.id})).item; assert.notEqual(item.id, newItem.id);
});

test('inbox: safe public markers omit all private content and preserve full nested identity', t => {
  const f = fixture(t), address = {project_id: f.projectId, branch_id: 'main', resource_id: 'room', instance_path: ['same', 'same'], definition_node_id: 'door'};
  const item = f.inbox.record(f.agent({targets: [{address, private_note: 'SECRET TARGET'}], kind: 'decision', request_key: 'PRIVATE-REQUEST', actions: [{id: 'decision', label: 'PRIVATE ACTION'}]})).item;
  const projection = f.inbox.projection(f.viewer, f.projectId, 'main'); assert.equal(projection.length, 1);
  assert.deepEqual(projection[0].targets[0].address, address);
  const encoded = JSON.stringify(projection);
  for (const secret of ['PRIVATE', 'SECRET', f.session.id, f.run.id, f.goal.id, 'actions', 'message', 'recipient_user_ids']) assert(!encoded.includes(secret), secret);
  assert.equal(f.inbox.get(f.owner, item.id).request_key, 'PRIVATE-REQUEST');
});

test('inbox: safe projection carries scope for the real frontend flat and nested target summaries', t => {
  const f = fixture(t), scope = {project_id: f.projectId, branch_id: 'main', resource_id: 'room'};
  const flat = f.inbox.record(f.agent()).item;
  const address = {...scope, instance_path: ['left'], definition_node_id: 'door'};
  const nested = f.inbox.record(f.agent({dedupe_key: 'nested', targets: [{address}]})).item;
  const projection = f.inbox.projection(f.viewer, f.projectId, 'main');
  for (const item of projection) {
    assert.equal(item.project_id, f.projectId); assert.equal(item.branch_id, 'main');
    assert.equal(item.message, undefined); assert.equal(item.session_id, undefined);
  }
  assert.deepEqual(issueSummary(projection, {...scope, object_id: 'marker'}).ids, [flat.id]);
  assert.deepEqual(issueSummary(projection, {...scope, address}).ids, [nested.id]);
  assert.equal(issueSummary(projection, {...scope, branch_id: 'other', object_id: 'marker'}).count, 0);
  assert.equal(issueSummary(projection, {...scope, address: {...address, instance_path: ['right']}}).count, 0);
});

test('inbox: decision notification cannot execute requests; obsolete disables actions and keeps history', t => {
  const f = fixture(t), original = f.store.get('creator_run', f.run.id);
  const item = f.inbox.record(f.agent({kind: 'decision', request_key: 'epoch:request', actions: [{id: 'decision', label: 'Open actual question'}]})).item;
  assert.equal(f.inbox.get(f.owner, item.id).actions[0].enabled, true); assert.equal(f.inbox.list(f.owner).counts.actionable, 1);
  f.inbox.read(f.owner, item.id, {expected_version: 1, request_id: 'read'});
  assert.deepEqual(f.store.get('creator_run', f.run.id), original);
  const closed = f.inbox.closeByScope({source: 'agent', kind: 'decision', session_id: f.session.id, request_key: 'epoch:request'}, {status: 'obsolete', reason: 'Actual producer request no longer pending'});
  assert.equal(closed.count, 1); assert.equal(f.inbox.get(f.owner, item.id).actions[0].enabled, false);
  assert.equal(f.inbox.list(f.owner).counts.actionable, 0); assert.equal(f.inbox.get(f.owner, item.id).unread, true);
  f.restart(); assert.equal(f.inbox.get(f.owner, item.id).status, 'obsolete');
});

test('inbox: historical navigation preserves original action grants and locate requires unchanged resource content', t => {
  const f = fixture(t), descriptors = ['session', 'build', 'locate', 'decision'].map(id => ({id, label: id}));
  const item = f.inbox.record(f.agent({kind: 'decision', request_key: 'pending:history', runtime_build_id: 'original-build', actions: descriptors})).item;
  const enabled = id => Object.fromEntries(f.inbox.get(f.owner, id).actions.map(action => [action.id, action.enabled]));
  f.inbox.close(item.id, {status: 'obsolete', reason: 'Producer request ended'});
  assert.deepEqual(enabled(item.id), {session: true, build: true, locate: true, decision: false});
  f.store.put('creator_goal', {...f.goal, run_id: 'new-run'});
  assert.equal(f.inbox.get(f.owner, item.id).context_current, false);
  assert.equal(enabled(item.id).locate, true, 'an unchanged current resource remains safe to browse across goal generations');
  const branch = f.store.branchFor(f.owner, f.projectId, 'main'), manifest = f.store.get('creator_revision', branch.head).manifest;
  manifest.resources.room.name = 'Changed'; const revision = f.store.writeRevision(f.projectId, [branch.head], manifest, f.owner.id);
  f.store.put('creator_branch', {...branch, head: revision.id});
  assert.deepEqual(enabled(item.id), {session: true, build: true, locate: false, decision: false});
  f.store.put('creator_goal', f.goal);
  const denied = f.inbox.record(f.agent({dedupe_key: 'producer-disabled', kind: 'decision', request_key: 'pending:disabled', actions: descriptors.map(action => ({...action, enabled: false, reason: 'Producer disabled'}))})).item;
  f.inbox.close(denied.id, {status: 'resolved', reason: 'Actual producer result'});
  for (const action of f.inbox.get(f.owner, denied.id).actions) {assert.equal(action.enabled, false); assert.equal(action.reason, 'Producer disabled');}
  f.restart(); assert.equal(enabled(item.id).session, true); assert.equal(enabled(item.id).decision, false);
});

test('inbox: precise producer close does not resolve another source/category or mutate authoritative domains', t => {
  const f = fixture(t), a = f.inbox.record(f.input({kind: 'validation'})).item;
  const b = f.inbox.record(f.input({source: 'godot_client'})).item;
  const goal = f.store.get('creator_goal', f.goal.id), run = f.store.get('creator_run', f.run.id), branch = f.store.branchFor(f.owner, f.projectId, 'main');
  bad(() => f.inbox.closeByScope({project_id: f.projectId}, {status: 'resolved', reason: 'Too broad'}), 400);
  const done = f.inbox.closeByScope({project_id: f.projectId, branch_id: 'main', source: 'backend', kind: 'validation', revision: f.revision}, {status: 'resolved', reason: 'Covered validation actually reran successfully'});
  assert.equal(done.count, 1); assert.equal(done.items[0].id, a.id); assert.equal(f.inbox.get(f.owner, b.id).status, 'open');
  assert.deepEqual(f.store.get('creator_goal', f.goal.id), goal); assert.deepEqual(f.store.get('creator_run', f.run.id), run); assert.deepEqual(f.store.branchFor(f.owner, f.projectId, 'main'), branch);
  bad(() => f.inbox.close(a.id, {status: 'obsolete', reason: 'Do not rewrite close history'}));
  assert.equal(f.inbox.close(a.id, {status: 'resolved', reason: 'Covered validation actually reran successfully'}).changed, false);
});

test('inbox: late event cannot reopen resolved incident; material new-world errors get separate identities', t => {
  const f = fixture(t), item = f.inbox.record(f.input({occurred_at: 900})).item;
  f.tick(100); f.inbox.close(item.id, {status: 'resolved', reason: 'Synthetic recovery at 1100'});
  f.tick(100); const late = f.inbox.record(f.input({occurred_at: 1000, message: 'Late old detail'}));
  assert.equal(late.item.status, 'resolved'); assert.equal(late.changed, false); assert.notEqual(late.item.message, 'Late old detail');
  f.store.put('creator_world', {id: 'world1', project_id: f.projectId, branch_id: 'main', resource_id: 'room', revision: f.revision, epoch: 2, runtime_build_id: 'build2'});
  const old = f.inbox.record(f.input({source: 'godot_authority', world_id: 'world1', epoch: 1, runtime_build_id: 'build1'})).item;
  const current = f.inbox.record(f.input({source: 'godot_authority', world_id: 'world1', epoch: 2, runtime_build_id: 'build2'})).item;
  assert.notEqual(old.id, current.id); assert.equal(f.inbox.get(f.owner, old.id).context_current, false);
  assert.equal(f.inbox.get(f.owner, current.id).context_current, true);
});

test('inbox: authenticated pagination keeps private counts hidden and rechecks access after every cursor', t => {
  const f = fixture(t); for (let i = 0; i < 5; i++) f.inbox.record(f.input({dedupe_key: `issue-${i}`}));
  f.inbox.record(f.agent());
  const first = f.inbox.list(f.editor, {limit: 2}); assert.equal(first.items.length, 2); assert.equal(first.counts.unread, 5);
  bad(() => f.inbox.list(f.owner, {cursor: first.next_cursor}), 400);
  const second = f.inbox.list(f.editor, {limit: 2, cursor: first.next_cursor});
  const last = f.inbox.list(f.editor, {limit: 2, cursor: second.next_cursor});
  assert.equal(new Set([...first.items, ...second.items, ...last.items].map(i => i.id)).size, 5); assert.equal(last.next_cursor, null);
  const project = f.store.get('creator_project', f.projectId); delete project.members.editor; f.store.put('creator_project', project);
  assert.deepEqual(f.inbox.list(f.editor, {cursor: first.next_cursor}), {items: [], counts: {unread: 0, actionable: 0}, next_cursor: null});
});

test('inbox: callback errors do not make durable writes fail; callbacks contain no message bodies', t => {
  const f = fixture(t), inbox = new CreationInbox({store: f.store, now: () => 2000, onChanged: () => {throw new Error('WS down');}});
  const result = inbox.record(f.input()); assert.equal(result.changed, true); assert.equal(inbox.lastNotificationError.message, 'WS down');
  assert.equal(inbox.get(f.owner, result.item.id).status, 'open');
  const normal = f.inbox.record(f.agent()); assert.equal(normal.changed, true);
  assert(!JSON.stringify(f.notifications).includes('PRIVATE')); assert(!JSON.stringify(f.notifications).includes('message'));
});

test('inbox: malformed scopes, oversized payloads and illegal client authority fields write nothing', t => {
  const f = fixture(t), before = f.store.list('creator_inbox_item').length;
  for (const patch of [{source: 'invented'}, {status: 'resolved'}, {message: 'x'.repeat(12001)}, {recipient_user_ids: ['owner', 'owner']}, {actions: [{id: 'do', label: 'Do', run_command: 'arbitrary'}]}]) {
    bad(() => f.inbox.record(f.input(patch)), 400);
  }
  assert.equal(f.store.list('creator_inbox_item').length, before);
});

test('inbox: filters apply before pagination, full scoped counts remain stable, and job/code closures are precise', t => {
  const f = fixture(t);
  const error1 = f.inbox.record(f.input({job_id: 'job1', code: 'import_failed'})).item;
  const error2 = f.inbox.record(f.input({job_id: 'job2', code: 'import_failed'})).item;
  const notice = f.inbox.record(f.input({kind: 'notice', dedupe_key: 'job-done', job_id: 'job3'})).item;
  assert.notEqual(error1.id, error2.id);
  f.inbox.read(f.owner, error1.id, {expected_version: 1, request_id: 'read-job'});
  const unread = f.inbox.list(f.owner, {filter: 'unread', limit: 1});
  assert.equal(unread.items.length, 1); assert.equal(unread.counts.unread, 2); assert.equal(unread.counts.actionable, 2);
  assert.notEqual(unread.items[0].id, error1.id);
  const actionable = f.inbox.list(f.owner, {filter: 'actionable'});
  assert.deepEqual(new Set(actionable.items.map(item => item.id)), new Set([error1.id, error2.id]));
  assert.equal(actionable.counts.unread, 2); assert(!actionable.items.some(item => item.id === notice.id));
  const result = f.inbox.closeByScope({project_id: f.projectId, source: 'backend', kind: 'error', code: 'import_failed', job_id: 'job1'}, {status: 'resolved', reason: 'Same job retry succeeded'});
  assert.equal(result.count, 1); assert.equal(result.items[0].id, error1.id);
  assert.equal(f.inbox.get(f.owner, error2.id).status, 'open');
});

test('inbox: source edits do not prevent answering an actual pending decision, but edited targets lose markers', t => {
  const f = fixture(t), item = f.inbox.record(f.agent({kind: 'decision', request_key: 'epoch:waiting', actions: [{id: 'decision', label: 'Answer'}]})).item;
  const branch = f.store.branchFor(f.owner, f.projectId, 'main');
  const manifest = f.store.get('creator_revision', branch.head).manifest; manifest.resources.room.name = 'Changed target';
  const next = f.store.writeRevision(f.projectId, [branch.head], manifest, f.editor.id, {test: 'collaborator change'});
  f.store.put('creator_branch', {...branch, head: next.id});
  assert.equal(f.inbox.get(f.owner, item.id).actions[0].enabled, true);
  assert.equal(f.inbox.list(f.owner, {filter: 'actionable'}).items.length, 1);
  assert.equal(f.inbox.projection(f.viewer, f.projectId, 'main').length, 0, 'historical target pin is not a current marker');
  f.store.put('creator_goal', {...f.goal, run_id: 'next-run'});
  assert.equal(f.inbox.get(f.owner, item.id).actions[0].enabled, false);
});

test('inbox: unchanged targets survive unrelated scene revisions; every target and prefab dependency is checked', t => {
  const f = fixture(t), resourceItem = f.inbox.record(f.input()).item;
  const branchItem = f.inbox.record(f.input({dedupe_key: 'branch', resource_id: null, targets: []})).item;
  const multiItem = f.inbox.record(f.input({dedupe_key: 'multi', targets: [{resource_id: 'room'}, {resource_id: 'prefab'}]})).item;
  const advance = edit => {
    const branch = f.store.branchFor(f.owner, f.projectId, 'main'), manifest = f.store.get('creator_revision', branch.head).manifest;
    edit(manifest); const next = f.store.writeRevision(f.projectId, [branch.head], manifest, f.editor.id, {test: 'change'});
    f.store.put('creator_branch', {...branch, head: next.id}); return next;
  };
  advance(manifest => {manifest.resources.other = {id: 'other', kind: 'scene', name: 'Unrelated scene', objects: []};});
  assert.equal(f.inbox.get(f.owner, resourceItem.id).context_current, true);
  assert.equal(f.inbox.get(f.owner, multiItem.id).context_current, true);
  assert.equal(f.inbox.get(f.owner, branchItem.id).context_current, false);
  assert.deepEqual(new Set(f.inbox.projection(f.viewer, f.projectId, 'main').map(item => item.id)), new Set([resourceItem.id, multiItem.id]));
  advance(manifest => {manifest.resources.prefab.name = 'Changed conservative dependency';});
  assert.equal(f.inbox.get(f.owner, resourceItem.id).context_current, false);
  assert.equal(f.inbox.get(f.owner, multiItem.id).context_current, false);
  assert.equal(f.inbox.projection(f.viewer, f.projectId, 'main').length, 0);
  assert.equal(f.inbox.get(f.owner, resourceItem.id).status, 'open', 'historical is not automatically resolved');
});

test('inbox: target filtering precedes pagination, includes whole-resource issues and isolates nested instances', t => {
  const f = fixture(t), scope = {project_id:f.projectId,branch_id:'main',resource_id:'room'};
  const left = {...scope,instance_path:['left'],definition_node_id:'door'}, right = {...scope,instance_path:['right'],definition_node_id:'door'};
  const all = f.inbox.record(f.input({dedupe_key:'whole',targets:[{resource_id:'room'}]})).item;
  const a = f.inbox.record(f.input({dedupe_key:'left',targets:[{address:left}]})).item;
  const b = f.inbox.record(f.input({dedupe_key:'right',targets:[{address:right}]})).item;
  f.inbox.record(f.input({dedupe_key:'prefab',resource_id:'prefab',targets:[{resource_id:'prefab'}]}));
  const opts = {project_id:f.projectId,branch_id:'main',target:{address:left},limit:1};
  const first = f.inbox.list(f.owner,opts), second=f.inbox.list(f.owner,{...opts,cursor:first.next_cursor});
  assert.deepEqual(new Set([...first.items,...second.items].map(i=>i.id)),new Set([all.id,a.id]));
  assert.equal(first.counts.unread,4);assert.equal(first.counts.actionable,4);assert.equal(second.next_cursor,null);
  assert(!first.items.some(i=>i.id===b.id));assert(!second.items.some(i=>i.id===b.id));
  assert.equal(f.inbox.list(f.owner,{...opts,target:{resource_id:'room'},limit:20}).items.length,3);
  assert.deepEqual(f.inbox.list(f.owner,{...opts,target:{resource_id:'room',object_id:'door'},limit:20}).items.map(i=>i.id),[all.id],'bare node name cannot match nested instances');
  bad(()=>f.inbox.list(f.owner,{...opts,target:{address:{...left,branch_id:'wrong'}}}));
  bad(()=>f.inbox.list(f.owner,{target:{resource_id:'room'}}),400);
});
