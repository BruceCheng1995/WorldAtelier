/** Real domain/SQLite/authorization with explicit FAKE WebSocket transport.
 * No listening server, real Agent, Godot process or browser is started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationInbox} from '../../services/creation/inbox.mjs';
import {CreationCollaboration} from '../../services/creation/collaboration.mjs';
import {CreationRealtime} from '../../services/creation/realtime.mjs';
import {CreationService} from '../../services/creation/service.mjs';

const denied = (action, status) => assert.throws(action, error => error.status === status);

function fixture(t) {
  const data = mkdtempSync(resolve(tmpdir(), 'atelier-collaboration-regression-'));
  const store = new CreationStore(resolve(data, 'creation.sqlite'));
  store.publicPlay = false;
  const users = Object.fromEntries(['owner', 'editor', 'peer', 'viewer', 'outsider'].map(id => {
    const user = {id, name: `FAKE ${id}`, color: '#abcdef'};
    store.put('creator_user', user); return [id, user];
  }));
  const project = store.createProject(users.owner, {name: 'Private collaboration regression'}, {
    entry_scene_id: 'room', resources: {room: {id: 'room', kind: 'scene', name: 'Room',
      objects: ['owner', 'editor', 'peer'].map(id => ({id: `${id}-anchor`, kind: 'anchor'}))}},
  }).project.id;
  const inbox = new CreationInbox({store}), collaboration = new CreationCollaboration({store, inbox});
  const resources = [];
  t.after(() => {for (const resource of resources) resource.close(); store.close(); rmSync(data, {recursive: true, force: true});});
  return {store, inbox, collaboration, project, users, resources};
}

test('collaboration regression: removed private member cannot read project through an old join receipt or used code', t => {
  const f = fixture(t), {owner, editor} = f.users;
  const invite = f.collaboration.invite(owner, f.project, {request_id: 'invite-editor', role: 'editor'});
  const input = {request_id: 'join-editor', code: invite.code};
  assert.equal(f.collaboration.join(editor, input).role, 'editor');
  f.collaboration.member(owner, f.project, editor.id, {request_id: 'remove-editor', role: null});
  denied(() => f.store.projectFor(editor, f.project), 403);
  const version = f.store.get('creator_project', f.project).permission_version;

  denied(() => f.collaboration.join(editor, input), 403);
  denied(() => f.collaboration.join(editor, {...input, request_id: 'join-editor-again'}), 403);
  denied(() => f.store.joinInvite(editor, invite.code), 403);
  f.collaboration.revokeInvite(owner, f.project, invite.id, {request_id: 'revoke-used-invite'});
  denied(() => f.collaboration.join(editor, input), 403);

  const project = f.store.get('creator_project', f.project);
  assert.equal(project.members[editor.id], undefined);
  assert.equal(project.permission_version, version, 'receipt replay must not regrant membership');
});

test('collaboration regression: accepting a lower role consumes the invitation without downgrading an editor', t => {
  const f = fixture(t), {owner, editor, outsider} = f.users;
  f.collaboration.member(owner, f.project, editor.id, {request_id: 'make-editor', role: 'editor'});
  const invite = f.collaboration.invite(owner, f.project, {request_id: 'invite-viewer', role: 'viewer'});
  const version = f.store.get('creator_project', f.project).permission_version;
  assert.equal(f.collaboration.join(editor, {request_id: 'accept-lower-role', code: invite.code}).role, 'editor');
  assert.equal(f.store.get('creator_project', f.project).permission_version, version);
  const consumed = f.store.get('creator_invite', invite.id);
  assert.equal(consumed.used_by, editor.id); assert.ok(consumed.used_at);
  assert.equal(f.collaboration.view(owner, f.project).invites.find(row => row.id === invite.id).status, 'used');
  denied(() => f.collaboration.join(outsider, {request_id: 'second-recipient', code: invite.code}), 410);
  assert.equal(f.collaboration.join(editor, {request_id: 'same-recipient-retry', code: invite.code}).role, 'editor');
  assert.equal(f.store.get('creator_project', f.project).members[outsider.id], undefined);
});

class FakeSocket extends EventEmitter {
  constructor() {super(); this.readyState = 1; this.packets = [];}
  send(bytes) {this.packets.push(JSON.parse(bytes));}
  receive(message) {this.emit('message', Buffer.from(JSON.stringify(message)));}
  close() {if (this.readyState === 3) return; this.readyState = 3; this.emit('close');}
}

function realtimeFixture(t) {
  const f = fixture(t), {owner, editor, peer, viewer} = f.users;
  for (const user of [editor, peer, viewer]) f.store.setMember(owner, f.project, user.id, user === viewer ? 'viewer' : 'editor');
  const realtime = new CreationRealtime({server: new EventEmitter(), store: f.store});
  f.resources.push(realtime);
  const agentChanges = [], automaticChanges = [], notices = [];
  const service = {store: f.store, realtime, agent: {permissionsChanged: p => agentChanges.push(p)},
    automatic: {invalidate: (p, b) => automaticChanges.push([p, b])}, inboxChanged: () => notices.push('changed')};
  f.collaboration.onChanged = (p, meta) => CreationService.prototype.collaborationChanged.call(service, p, meta);
  const peers = Object.fromEntries([owner, editor, peer].map(user => {
    const ws = new FakeSocket(); realtime.connect(ws, 'http://fake.test');
    ws.receive({type: 'auth', token: f.store.issueLogin(user).token});
    ws.receive({type: 'subscribe', project_id: f.project, branch_id: 'main', resource_id: 'room', generation: 1});
    const client = [...realtime.connections.values()].find(row => row.ws === ws);
    const branch = f.store.branchView(user, f.project, 'main'), object = branch.manifest.resources.room.objects.find(row => row.id === `${user.id}-anchor`);
    const drag = {type: 'drag_preview', generation: 1, object_id: object.id, expected_version: object.version,
      source_revision: branch.head, position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1]};
    ws.receive(drag); assert.equal(ws.packets.some(packet => packet.type === 'error'), false);
    return [user.id, {ws, client, drag}];
  }));
  assert.equal(realtime.previews.size, 3, 'actual drag message handler acquired three independent leases');
  return {...f, realtime, peers, agentChanges, automaticChanges, notices};
}

test('collaboration regression: requests and receipt replays retain other editors drag leases and do not invalidate execution', t => {
  const f = realtimeFixture(t), before = structuredClone([...f.realtime.previews]);
  const input = {request_id: 'viewer-request', reason: 'FAKE request while other users edit'};
  const request = f.collaboration.request(f.users.viewer, f.project, input).request;
  assert.equal(f.collaboration.request(f.users.viewer, f.project, input).replayed, true);
  assert.equal(f.collaboration.request(f.users.viewer, f.project, {...input, request_id: 'duplicate-click'}).request.id, request.id);
  assert.deepEqual([...f.realtime.previews], before);
  assert.equal(f.inbox.list(f.users.owner).items.filter(item => item.access_request_id === request.id).length, 1);
  assert.equal(f.notices.length, 3); assert.deepEqual(f.agentChanges, []); assert.deepEqual(f.automaticChanges, []);
  for (const {ws} of Object.values(f.peers)) assert.equal(ws.packets.some(packet => packet.type === 'drag_end'), false);
});

test('collaboration regression: demotion clears only the affected drag lease and fences subsequent writes', t => {
  const f = realtimeFixture(t), before = [...f.realtime.previews].filter(([, value]) => value.peer_id !== f.peers.editor.client.id);
  f.collaboration.member(f.users.owner, f.project, f.users.editor.id, {request_id: 'demote-editor', role: 'viewer'});
  assert.deepEqual([...f.realtime.previews], before);
  assert.deepEqual(f.agentChanges, [f.project]); assert.deepEqual(f.automaticChanges, [], 'permissions do not schedule retired verification');
  for (const {ws} of Object.values(f.peers)) {
    assert.deepEqual(ws.packets.filter(packet => packet.type === 'drag_end').map(packet => packet.peer_id), [f.peers.editor.client.id]);
  }
  f.peers.editor.ws.receive(f.peers.editor.drag);
  assert.equal(f.peers.editor.ws.packets.at(-1).status, 403);
  assert.deepEqual([...f.realtime.previews], before, 'rejecting the revoked editor preserves unrelated live leases');
});
