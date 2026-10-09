/** Independent recovery regression: FAKE Codex protocol, real temporary SQLite.
 * No real Agent, listening service, browser or game runtime is started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { CreationStore } from '../../services/creation/store.mjs';
import { CreationAgentRuns } from '../../services/creation/agent-runs.mjs';
import { CodexAgent } from '../../services/creation/codex-agent.mjs';

class FakeRecoveryAdapter extends EventEmitter {
  constructor({ turnStatus = 'completed', goalStatus = 'paused' } = {}) {
    super(); this.connected = true; this.threads = new Map(); this.sendCalls = 0;
    this.turn = { id: 'FAKE-turn', status: turnStatus, items: [] };
    this.goal = { threadId: 'FAKE-thread', objective: 'FAKE recovery objective', status: goalStatus };
  }
  async start() { this.connected = true; }
  async listModels() { return { data: [{ model: 'FAKE-model', isDefault: true }] }; }
  async accountStatus() { return { account: { type: 'FAKE' } }; }
  async readThread() { return { thread: { id: 'FAKE-thread', turns: [structuredClone(this.turn)] } }; }
  async resumeThread() {
    const busy = this.turn.status === 'inProgress';
    this.threads.set('FAKE-thread', { loaded: true, busy, uncertain: false });
    return { ...await this.readThread(), reconciliation: { canSend: !busy, uncertain: false, matchedTurnId: this.turn.id } };
  }
  async getGoal() { return { goal: structuredClone(this.goal) }; }
  async setGoal(_thread, patch) { Object.assign(this.goal, patch); return this.getGoal(); }
  async listBackgroundTerminals() { return { data: [], nextCursor: null }; }
  pendingRequests() { return []; }
  async sendTurn() { this.sendCalls++; return { turn: { id: 'FAKE-next', status: 'inProgress' } }; }
  async stop() { this.connected = false; this.emit('disconnected'); }
}

function fixture(t, options = {}) {
  const data = mkdtempSync(resolve(tmpdir(), 'atelier-FAKE-recovery-'));
  const store = new CreationStore(resolve(data, 'state.sqlite'));
  const user = { id: 'user', name: 'Recovery owner', color: '#abcdef' };
  store.put('creator_user', user);
  store.put('creator_project', { id: 'project', members: { user: 'owner' } });
  store.put('creator_branch', { id: 'project:main', project_id: 'project', branch_id: 'main', head: 'rev' });
  store.put('creator_revision', { id: 'rev', project_id: 'project', manifest: { schema: 'creation-flat-1', resources: {} } });
  store.put('creator_session', { id: 'session', project_id: 'project', branch_id: 'main', owner_user_id: 'user', executor_thread_id: 'FAKE-thread', model: 'FAKE-model', draft: '', draft_attachments: [] });
  store.put('creator_goal', { id: 'goal', session_id: 'session', run_id: 'run', status: 'running' });
  store.put('creator_run', { id: 'run', goal_id: 'goal', session_id: 'session', project_id: 'project', branch_id: 'main', owner_user_id: 'user', thread_id: 'FAKE-thread', turn_id: 'FAKE-turn', turn_ids: ['FAKE-turn'], client_user_message_id: 'FAKE-message', status: 'running', execution_mode: 'goal', goal_initializing: false, goal_activation_confirmed: true, executor_goal_objective: 'FAKE recovery objective', executor_goal: { status: 'active', objective: 'FAKE recovery objective' }, lease_generation: 1, targets: [], changes: [], deliveries: [], created_at: 1 });
  if (options.historicalCleanup) {
    store.put('creator_run', { ...store.get('creator_run', 'run'), id: 'old-cancelled', turn_id: 'FAKE-old-turn', turn_ids: ['FAKE-old-turn'], created_at: 0, status: 'interrupted', execution_mode: 'default', cancel_requested_at: 1, cleanup_status: 'verified', cleanup_checked_at: 2, cleanup_result: { status: 'verified', reason: 'owned_terminals_stopped_and_rechecked', commands: [] } });
    store.put('creator_run', { ...store.get('creator_run', 'run'), status: 'completed', execution_mode: 'default', completed_at: 3 });
  }
  const service = { data, root: data, origin: 'http://FAKE.invalid', store, sessionEvent: (sid, event) => store.appendSessionEvent(sid, event), realtime: { development() {} } };
  const adapter = new FakeRecoveryAdapter(options);
  const manager = new CreationAgentRuns({ service, adapter, cleanupOptions: { quietMs: 5, pollIntervalMs: 2, timeoutMs: 100 } });
  t.after(async () => { await manager.close(); store.close(); rmSync(data, { recursive: true, force: true }); });
  return { store, user, adapter, manager, latest: () => store.get('creator_run', 'run') };
}

for (const goalStatus of ['paused', 'complete', 'blocked', 'usage_limited']) {
  test(`FAKE restart: completed native turn and ${goalStatus} goal release the persisted uncertain run`, async t => {
    const f = fixture(t, { goalStatus });
    assert.equal(f.latest().status, 'uncertain', 'host restart must first revoke the old live lease');
    const result = await f.manager.reconcile(f.user, 'session');
    assert.equal(result.reconciliation.canSend, true);
    assert.equal(f.latest().status, 'completed', 'confirmed terminal native turn must not leave a permanent uncertain run');
    assert.equal(f.latest().executor_goal.status, goalStatus);
    assert.equal(f.adapter.sendCalls, 0, 'recovery must not replay the user goal');
    await f.manager.send(f.user, 'session', { text: 'Continue after the recovered result', client_user_message_id: 'FAKE-next-message' });
    assert.equal(f.adapter.sendCalls, 1, 'the user can send one new explicit follow-up');
  });
}

test('FAKE restart: an actually active native turn retains the busy gate and does not replay', async t => {
  const f = fixture(t, { turnStatus: 'inProgress', goalStatus: 'active' });
  const result = await f.manager.reconcile(f.user, 'session');
  assert.equal(result.reconciliation.canSend, false);
  assert.equal(f.latest().status, 'running');
  await assert.rejects(f.manager.send(f.user, 'session', { text: 'Premature follow-up', client_user_message_id: 'FAKE-next-message' }), error => error.status === 409);
  assert.equal(f.adapter.sendCalls, 0);
});

test('FAKE restart: unresolved historical command cleanup still blocks follow-up', async t => {
  const f = fixture(t);
  f.store.put('creator_run', { ...f.latest(), id: 'old-cancelled', created_at: 0, status: 'interrupted', cancel_requested_at: 1, cleanup_status: 'uncertain', command_items: [{ id: 'FAKE-command', type: 'commandExecution', status: 'inProgress', turn_id: 'FAKE-turn' }] });
  await assert.rejects(f.manager.send(f.user, 'session', { text: 'Unsafe follow-up', client_user_message_id: 'FAKE-next-message' }), error => error.status === 409);
  assert.equal(f.adapter.sendCalls, 0);
});

test('FAKE restart: verified historical cancellation remains settled when a newer run is already completed', async t => {
  const f = fixture(t, { historicalCleanup: true });
  const previous = f.store.get('creator_run', 'old-cancelled');
  assert.equal(previous.cleanup_status, 'verified', 'restart must not invalidate durable successful cleanup with no new command evidence');
  assert.equal(previous.cleanup_checked_at, 2);
  assert.equal(f.latest().status, 'completed');
  assert.deepEqual(f.manager.cleanupBlocked('session'), []);
  await f.manager.send(f.user, 'session', { text: 'Explicit follow-up after service restart', client_user_message_id: 'FAKE-new-explicit-message' });
  assert.equal(f.adapter.sendCalls, 1);
  assert.equal(f.store.get('creator_run', 'old-cancelled').status, 'interrupted');
});

test('FAKE reconciliation records only live requests in the current session and never fabricates answers', async t => {
  const f = fixture(t, { turnStatus: 'inProgress', goalStatus: 'active' });
  const live = { session_id: 'session', requestKey: 'FAKE-live-key' };
  const stale = { session_id: 'session', requestKey: 'FAKE-stale-key' };
  const foreign = { session_id: 'different-session', requestKey: 'FAKE-foreign-key' };
  for (const request of [live, stale, foreign]) f.manager.requests.set(request.requestKey, request);
  f.adapter.pendingRequests = thread => { assert.equal(thread, 'FAKE-thread'); return [{ key: live.requestKey }, { key: foreign.requestKey }]; };
  f.adapter.replyRequest = () => assert.fail('reconciliation is not a user answer');
  await f.manager.reconcile(f.user, 'session');
  const events = f.store.db.prepare('SELECT body FROM events WHERE project_id=? ORDER BY sequence').all('session:session').map(row => JSON.parse(row.body));
  const reconciled = events.filter(event => event.kind === 'requests_reconciled');
  assert.equal(reconciled.length, 1);
  assert.deepEqual(reconciled[0].request_keys, [live.requestKey]);
  assert.equal(events.some(event => event.kind === 'serverRequestReply'), false);
  assert.equal(f.adapter.sendCalls, 0);
});

function adapterFixture(t, turns) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'atelier-FAKE-recovery-adapter-')));
  const cwd = resolve(root, 'creator'); mkdirSync(cwd);
  const adapter = new CodexAgent({ workspaceRoot: root, spawnProcess() { throw Error('No real executor is permitted in this regression'); } });
  const calls = [];
  adapter._rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/goal/get') return { goal: null };
    assert.ok(['thread/read', 'thread/resume'].includes(method), 'recovery must not issue an execution or cancellation RPC');
    return { thread: { id: 'FAKE-thread', cwd, status: { type: 'idle' }, turns: structuredClone(turns) } };
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { adapter, calls, resume: expected => adapter.resumeThread({ threadId: 'FAKE-thread', cwd, scope: { projectId: 'project', branchId: 'main', userId: 'user', sessionId: 'session' }, ...expected }) };
}

test('FAKE adapter: known exact turn ID recovers even when resumed history omitted the client ID', async t => {
  const f = adapterFixture(t, [{ id: 'known-turn', status: 'completed', items: [] }]);
  const result = await f.resume({ expectedTurnId: 'known-turn', expectedClientUserMessageId: 'original-client-id' });
  assert.equal(result.reconciliation.matchedTurnId, 'known-turn');
  assert.equal(result.reconciliation.missingExpectedTurn, false);
  assert.equal(result.reconciliation.canSend, true);
  assert.equal(f.adapter.threads.get('FAKE-thread').uncertain, false);
});

test('FAKE adapter: missing known turn never falls back to a different turn sharing the client ID', async t => {
  const f = adapterFixture(t, [{ id: 'different-turn', status: 'completed', items: [{ type: 'userMessage', clientId: 'original-client-id' }] }]);
  const result = await f.resume({ expectedTurnId: 'known-turn', expectedClientUserMessageId: 'original-client-id' });
  assert.equal(result.reconciliation.matchedTurnId, null);
  assert.equal(result.reconciliation.uncertain, true);
  assert.equal(result.reconciliation.canSend, false);
});

test('FAKE adapter: lost turn-start reply recovers only from its persisted client ID', async t => {
  const f = adapterFixture(t, [{ id: 'recovered-turn', status: 'completed', items: [{ type: 'userMessage', clientId: 'original-client-id' }] }]);
  const result = await f.resume({ expectedClientUserMessageId: 'original-client-id' });
  assert.equal(result.reconciliation.matchedTurnId, 'recovered-turn');
  assert.equal(result.reconciliation.canSend, true);
});

test('FAKE adapter: unknown turn with missing client ID stays uncertain instead of assuming submission failed', async t => {
  const f = adapterFixture(t, [{ id: 'unidentified-turn', status: 'completed', items: [] }]);
  const result = await f.resume({ expectedClientUserMessageId: 'original-client-id' });
  assert.equal(result.reconciliation.matchedTurnId, null);
  assert.equal(result.reconciliation.uncertain, true);
  assert.equal(result.reconciliation.canSend, false);
});
