/**
 * Independent protocol regression: actual CodexAgent + CreationAgentRuns +
 * CreationStore, with only the external App Server stdio replaced by a scripted
 * FAKE transport. No listening port, Codex process, browser or Godot is started.
 * Assertions target emitted RPCs, durable lifecycle and real tool/ACL gates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CodexAgent } from '../../services/creation/codex-agent.mjs';
import { CreationAgentRuns } from '../../services/creation/agent-runs.mjs';
import { CreationStore } from '../../services/creation/store.mjs';

const root = resolve(import.meta.dirname, '../..');
const clone = structuredClone;
const tick = () => new Promise(done => setImmediate(done));
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.ok(predicate(), 'scripted FAKE protocol condition was not reached');
};

class ScriptedAppServer extends EventEmitter {
  constructor(options = {}) {
    super(); this.pid = 1; this.options = options; this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.messages = []; this.thread = null; this.goal = null; this.serial = 0; this.clock = 1; this.background = [];
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      const message = JSON.parse(chunk); this.messages.push(clone(message));
      queueMicrotask(() => void this.handle(message).catch(error => this.server({ id: message.id, error: { code: -32000, message: error.message } })));
      done();
    } });
  }
  server(message) { this.stdout.write(JSON.stringify(message) + '\n'); }
  reply(message, result) { this.server({ id: message.id, result: clone(result) }); }
  notification(method, params) { this.server({ method, params: clone(params) }); }
  snapshot() {
    const thread = clone(this.thread);
    if (this.options.reconstructedMessageIds) for (const turn of thread.turns) turn.items.forEach((item, index) => { if (item.type === 'agentMessage') item.id = 'history-' + turn.id + '-' + index; });
    return thread;
  }
  calls(method) { return this.messages.filter(message => message.method === method); }
  updateGoal(status, { notify = true, objective } = {}) {
    this.goal = { threadId: this.thread.id, objective: objective ?? this.goal?.objective ?? 'FAKE objective', status,
      createdAt: this.goal?.createdAt ?? this.clock, updatedAt: ++this.clock, tokensUsed: 0, timeUsedSeconds: 0 };
    if (notify) this.notification('thread/goal/updated', { threadId: this.thread.id, goal: this.goal });
    return clone(this.goal);
  }
  autonomousTurn() {
    const turn = { id: 'FAKE-turn-' + (++this.serial), status: 'inProgress', items: [] };
    this.thread.turns.push(turn); this.thread.status = { type: 'active' };
    this.notification('turn/started', { threadId: this.thread.id, turn });
    return clone(turn);
  }
  complete(turnId, status = 'completed') {
    const turn = this.thread.turns.find(turn => turn.id === turnId); assert.ok(turn);
    turn.status = status; this.thread.status = { type: 'idle' };
    this.notification('turn/completed', { threadId: this.thread.id, turn });
  }
  startCommand(turnId, id) {
    const item = { id, type: 'commandExecution', processId: 'FAKE-process-' + id, cwd: this.thread.cwd, status: 'inProgress', command: 'FAKE background command ' + id };
    this.thread.turns.find(turn => turn.id === turnId).items.push(item);
    this.background.push({ turnId, itemId: id, processId: item.processId, cwd: item.cwd });
    this.notification('item/started', { threadId: this.thread.id, turnId, item });
  }
  async handle(message) {
    if (message.id === undefined || !message.method) return;
    const p = message.params;
    if (message.method === 'initialize') return this.reply(message, { userAgent: 'EXPLICIT-FAKE-native-modes' });
    if (message.method === 'account/read') return this.reply(message, { account: { type: 'FAKE-no-paid-account' } });
    if (message.method === 'model/list') return this.reply(message, { data: [{ model: 'FAKE-mode-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' },{ reasoningEffort:'medium' }] }] });
    if (message.method === 'thread/start') {
      this.thread = { id: 'FAKE-thread', cwd: p.cwd, ephemeral: false, status: { type: 'idle' }, turns: [] };
      return this.reply(message, { thread: this.snapshot() });
    }
    if (['thread/read', 'thread/resume'].includes(message.method)) return this.reply(message, { thread: this.snapshot() });
    if (message.method === 'thread/goal/set') {
      this.updateGoal(p.status ?? this.goal?.status ?? 'active', { notify: false, objective: p.objective });
      if (p.status === 'active') await this.options.beforeActiveReply?.(this, message);
      if (p.status === 'paused') await this.options.beforePausedReply?.(this, message);
      return this.reply(message, { goal: this.goal });
    }
    if (message.method === 'thread/goal/get') {
      if (this.options.onGetGoal) return this.options.onGetGoal(this, message);
      return this.reply(message, { goal: this.goal });
    }
    if (message.method === 'turn/start') {
      const turn = { id: 'FAKE-turn-' + (++this.serial), status: this.options.initialStatus ?? 'inProgress',
        items: [{ id: 'FAKE-user-' + this.serial, type: 'userMessage', clientId: p.clientUserMessageId, content: clone(p.input) }] };
      this.thread.turns.push(turn); this.thread.status = { type: turn.status === 'inProgress' ? 'active' : 'idle' };
      await this.options.beforeTurnReply?.(this, turn, message);
      return this.reply(message, { turn });
    }
    if (message.method === 'turn/interrupt') { this.complete(p.turnId, 'interrupted'); return this.reply(message, {}); }
    if (message.method === 'thread/backgroundTerminals/list') return this.reply(message, { data: this.background, nextCursor: null });
    if (message.method === 'thread/backgroundTerminals/terminate') {
      const entry = this.background.find(entry => entry.processId === p.processId); assert.ok(entry);
      const item = this.thread.turns.find(turn => turn.id === entry.turnId)?.items.find(item => item.id === entry.itemId); assert.ok(item);
      item.status = 'failed'; item.exitCode = -1; this.background = this.background.filter(value => value !== entry);
      this.notification('item/completed', { threadId: this.thread.id, turnId: entry.turnId, item });
      return this.reply(message, { terminated: true });
    }
    throw Error('Unexpected FAKE RPC: ' + message.method);
  }
  kill(signal) { queueMicrotask(() => { this.stdout.end(); this.stderr.end(); this.emit('close', 0, signal); }); return true; }
}

function fixture(t, options = {}) {
  const data = realpathSync(mkdtempSync(resolve(tmpdir(), 'atelier-FAKE-native-modes-')));
  const store = new CreationStore(resolve(data, 'creation.sqlite'));
  const owner = store.register({ name: 'Modes owner ' + randomUUID(), password: 'FAKE-isolated-password' }).user;
  const editor = store.register({ name: 'Modes editor ' + randomUUID(), password: 'FAKE-isolated-password' }).user;
  const manifest = { schema: 'creation-flat-1', entry_scene_id: 'scene', resources: { scene: { id: 'scene', kind: 'scene', name: '测试场景', objects: [] } } };
  const project = store.createProject(owner, { name: 'Isolated modes protocol' }, manifest).project.id;
  store.setMember(owner, project, editor.id, 'editor');
  const user = options.editor ? editor : owner;
  const session = store.createSession(user, project, 'main', { access_mode: 'full-access' });
  const events = []; const service = { root, data, origin: 'http://FAKE-no-listener.invalid', store,
    assets: { directory: resolve(data, 'assets') }, realtime: { development() {} },
    sessionEvent(sid, event) { events.push(clone(event)); return store.appendSessionEvent(sid, event); } };
  mkdirSync(service.assets.directory); const workspaceRoot = resolve(data, 'workspaces'); mkdirSync(workspaceRoot);
  let transport;
  const adapter = new CodexAgent({ workspaceRoot, requestTimeoutMs: 1000, spawnProcess: () => transport = new ScriptedAppServer(options) });
  const manager = new CreationAgentRuns({ service, adapter, cleanupOptions: { quietMs: 10, pollIntervalMs: 2, timeoutMs: 200 } });
  t.after(async () => { await manager.close(); store.close(); rmSync(data, { recursive: true, force: true }); });
  return { data, store, owner, editor, user, session, project, service, manager, adapter, events,
    get transport() { return transport; },
    send(text, extra = {}) { return manager.send(user, session.id, { text, client_user_message_id: 'message-' + randomUUID(), ...extra }); },
    latest() { return manager.runForSession(session.id); },
    request(tool, turnId = manager.runForSession(session.id)?.turn_id, args = {}) {
      const bound = adapter.threads.get(transport.thread.id);
      return { threadId: transport.thread.id, turnId, tool, arguments: args, callId: 'call-' + randomUUID(), scope: clone(bound.scope), cwd: bound.cwd, signal: new AbortController().signal };
    },
    async complete(status = 'complete') { const run = manager.runForSession(session.id); transport.updateGoal(status); transport.complete(run.turn_id); await tick(); },
  };
}

test('Plan uses real collaborationMode + readOnly even in a Full access session; switching back restores explicit Default', async t => {
  const f = fixture(t);
  const sent = await f.send('/plan 规划两个宝箱');
  const params = f.transport.calls('turn/start').at(-1).params;
  assert.equal(params.collaborationMode.mode, 'plan'); assert.equal(params.collaborationMode.settings.model, 'FAKE-mode-model');
  assert.deepEqual(params.sandboxPolicy, { type: 'readOnly' }); assert.equal(params.approvalPolicy, 'never');
  assert.equal(sent.run.execution_mode, 'plan'); assert.equal(sent.session.messages[0].content, '规划两个宝箱');
  assert.equal(f.transport.calls('thread/start')[0].params.config['features.goals'], true);
  f.transport.complete(sent.run.turn_id); await tick();
  assert.equal(f.store.get('creator_goal', sent.run.goal_id).status, 'planned');
  await f.send('继续讨论'); const next = f.transport.calls('turn/start').at(-1).params;
  assert.equal(next.collaborationMode.mode, 'default'); assert.deepEqual(next.sandboxPolicy, { type: 'dangerFullAccess' });
});

test('Plan rejects every central mutating/build tool through the actual manager before any source/asset effect', async t => {
  const f = fixture(t); await f.send('/plan 只规划');
  const head = f.store.branchView(f.user, f.project, 'main').head;
  const denied = ['semantic_apply', 'knowledge_write', 'world_apply', 'asset_publish', 'workspace_prepare', 'workspace_test', 'game_validate', 'world_validate', 'shared_world_validate', 'world_publish'];
  for (const tool of denied) await assert.rejects(f.manager.dynamic(f.request(tool)), error => error.status === 403 && /规划模式/.test(error.message), tool);
  const read = await f.manager.dynamic(f.request('world_read', undefined, { resource_id: 'scene' }));
  assert.equal(read.success, true); assert.equal(f.store.branchView(f.user, f.project, 'main').head, head);
  assert.equal(f.store.list('creator_asset').length, 0);
});

test('slash-mode validation, message replay and cross-owner access occur before another native turn', async t => {
  const f = fixture(t);
  await assert.rejects(f.send('/plan', {}), error => error.status === 400);
  await assert.rejects(f.send('/plan design', { execution_mode: 'goal' }), error => error.status === 400);
  const msg = 'stable-' + randomUUID(); const first = await f.send('/plan design', { client_user_message_id: msg });
  const replay = await f.send('/plan design', { client_user_message_id: msg }); assert.equal(replay.replayed, true); assert.equal(replay.run.id, first.run.id);
  await assert.rejects(f.send('/goal design', { client_user_message_id: msg }), error => error.status === 409);
  await assert.rejects(f.manager.send(f.editor, f.session.id, { text: '/goal private', client_user_message_id: randomUUID() }), error => error.status === 403);
  assert.equal(f.transport.calls('turn/start').length, 1);
});

test('Goal is registered paused, initial turn is durably bound, and only then activated', async t => {
  let observed;
  const f = fixture(t, { beforeActiveReply: () => { observed = f.latest(); } });
  const sent = await f.send('/goal 实现可重复宝箱');
  const calls = f.transport.messages.filter(m => ['thread/goal/set', 'turn/start'].includes(m.method));
  assert.deepEqual(calls.map(m => [m.method, m.params.status ?? null]), [['thread/goal/set', 'paused'], ['turn/start', null], ['thread/goal/set', 'active']]);
  assert.equal(observed.turn_id, sent.run.turn_id); assert.equal(observed.status, 'running');
  assert.deepEqual(sent.run.turn_ids, [sent.run.turn_id]); assert.equal(sent.run.goal_initializing, false);
  assert.equal(sent.run.executor_goal.status, 'active'); assert.match(sent.run.executor_goal.objective, /实现可重复宝箱/);
  assert.equal(calls[1].params.collaborationMode.mode, 'default'); assert.equal(calls[1].params.sandboxPolicy.type, 'dangerFullAccess');
});

test('active native Goal spans real notification turns, rejects old-turn tools and completes only after native completion', async t => {
  const f = fixture(t); const first = await f.send('/goal 持续执行'); const initial = first.run.turn_id;
  f.transport.complete(initial); await tick(); assert.equal(f.latest().status, 'running');
  assert.equal(f.store.get('creator_goal', first.run.goal_id).status, 'running');
  const next = f.transport.autonomousTurn(); await tick(); const current = f.latest();
  assert.equal(current.id, first.run.id); assert.equal(current.goal_id, first.run.goal_id); assert.equal(current.turn_id, next.id);
  assert.deepEqual(current.turn_ids, [initial, next.id]); assert.ok(current.lease_generation > first.run.lease_generation);
  await assert.rejects(f.manager.dynamic(f.request('world_read', initial)), error => error.status === 409);
  assert.equal((await f.manager.dynamic(f.request('world_read', next.id))).success, true);
  f.transport.notification('turn/completed', { threadId: current.thread_id, turn: { id: initial, status: 'completed', items: [] } }); await tick();
  assert.equal(f.latest().turn_id, next.id); assert.equal(f.latest().status, 'running');
  await f.complete(); assert.equal(f.latest().status, 'completed');
  assert.equal(f.store.get('creator_goal', first.run.goal_id).status, 'completed');
  assert.equal(f.store.list('creator_auto_verification').length, 0);
});

test('Goal continuation emitted before activation RPC reply is retained and receives the live tool lease', async t => {
  let continuation;
  const f = fixture(t, { initialStatus: 'completed', beforeActiveReply: server => { continuation = server.autonomousTurn(); } });
  const sent = await f.send('/goal 快速首轮后的自动继续'); await tick();
  assert.equal(sent.run.status, 'running'); assert.equal(f.latest().turn_id, continuation.id, 'activation can schedule the next turn before its response reaches the host');
  assert.equal((await f.manager.dynamic(f.request('world_read', continuation.id))).success, true);
});

test('reconcile an active autonomous Goal turn without requiring the initial user-message client ID on that turn', async t => {
  const f = fixture(t); const first = await f.send('/goal 可恢复持续执行');
  f.transport.complete(first.run.turn_id); await tick(); const next = f.transport.autonomousTurn(); await tick();
  const current = f.latest(); current.status = 'uncertain'; f.store.put('creator_run', current);
  f.adapter.threads.get(current.thread_id).loaded = false;
  const resumed = await f.manager.reconcile(f.user, f.session.id);
  assert.equal(resumed.reconciliation.uncertain, false, 'native autonomous turns do not contain the original userMessage clientId');
  assert.equal(f.latest().status, 'running'); assert.equal(f.latest().turn_id, next.id);
  assert.equal(f.transport.calls('turn/start').length, 1, 'reconciliation must not resubmit the initial user message');
});

test('user interruption pauses native Goal before turn/interrupt and rejects later tool writes', async t => {
  const f = fixture(t); await f.send('/goal 可停止目标'); const before = f.transport.messages.length;
  await f.manager.interrupt(f.user, f.session.id);
  const calls = f.transport.messages.slice(before).filter(m => ['thread/goal/set', 'turn/interrupt'].includes(m.method));
  assert.equal(calls[0].method, 'thread/goal/set'); assert.equal(calls[0].params.status, 'paused'); assert.equal(calls[1].method, 'turn/interrupt');
  assert.equal(f.latest().status, 'interrupted');
  await assert.rejects(f.manager.dynamic(f.request('world_apply')), error => error.status === 409);
  await Promise.allSettled([...f.manager.cleanups.values()]); assert.equal(f.latest().cleanup_status, 'verified');
});

test('permission revocation pauses the persistent native Goal rather than interrupting only its current turn', async t => {
  const f = fixture(t, { editor: true }); await f.send('/goal 编辑权限撤销后不能自发续跑');
  f.store.setMember(f.owner, f.project, f.editor.id, null); f.manager.permissionsChanged(f.project); await tick();
  assert.equal(f.transport.goal.status, 'paused', 'an active native goal can otherwise schedule fresh shell turns after the revoked turn is interrupted');
  await assert.rejects(f.manager.dynamic(f.request('world_read')), error => error.status === 403);
});

test('a failed native goal activation must still interrupt the already submitted initial turn', async t => {
  const f = fixture(t, { beforeActiveReply: () => { throw Error('FAKE activation rejected after initial turn started'); } });
  await assert.rejects(f.send('/goal 激活失败边界'), /activation rejected/);
  assert.equal(f.transport.calls('turn/start').length, 1);
  await tick(); assert.equal(f.transport.thread.turns[0].status, 'interrupted', 'the host must not leave an untracked shell-capable turn active after returning a failure');
});

test('unknown goal-update thread identities cannot rewrite the current run goal', async t => {
  const f = fixture(t); await f.send('/goal 当前目标'); const before = f.latest().executor_goal;
  f.transport.notification('thread/goal/updated', { threadId: f.transport.thread.id, goal: { ...before, threadId: 'OTHER-thread', status: 'complete', updatedAt: before.updatedAt + 1 } }); await tick();
  assert.deepEqual(f.latest().executor_goal, before, 'a goal payload must agree with its event/session thread identity');
});

test('starting Plan after a resumed thread pauses its actual native Goal even when local goal cache was lost', async t => {
  const f = fixture(t, { initialStatus: 'completed' });
  await f.manager.bind(f.session); const bound = f.adapter.threads.get(f.transport.thread.id);
  f.transport.updateGoal('active', { notify: false, objective: 'FAKE retained native goal' });
  await f.adapter.resumeThread({ threadId: f.transport.thread.id, cwd: bound.cwd, scope: bound.scope, dynamicTools: bound.tools, onDynamicTool: bound.onDynamicTool, accessMode: 'full-access' });
  await f.adapter.sendTurn(f.transport.thread.id, { text: '只讨论', model: 'FAKE-mode-model', executionMode: 'plan', accessMode: 'full-access' });
  assert.equal(f.transport.goal.status, 'paused', 'read-only Plan cannot coexist with an unpaused persisted implementation goal');
});

test('Goal cancellation drains commands from all its native turns and preserves unrelated terminals', async t => {
  const f = fixture(t); const first = await f.send('/goal 跨轮命令清理');
  f.transport.startCommand(first.run.turn_id, 'first-command'); f.transport.complete(first.run.turn_id); await tick();
  const next = f.transport.autonomousTurn(); await tick(); f.transport.startCommand(next.id, 'second-command'); await tick();
  f.transport.background.push({ itemId: 'unrelated-item', processId: 'preserved-process', turnId: 'unrelated-turn', cwd: f.transport.thread.cwd });
  await f.manager.interrupt(f.user, f.session.id); await Promise.allSettled([...f.manager.cleanups.values()]);
  assert.equal(f.latest().cleanup_status, 'verified');
  assert.deepEqual(f.transport.calls('thread/backgroundTerminals/terminate').map(call => call.params.processId).sort(), ['FAKE-process-first-command', 'FAKE-process-second-command']);
  assert.deepEqual(f.transport.background.map(entry => entry.processId), ['preserved-process']);
  assert.deepEqual(f.manager.commandEvidence(f.latest()).map(item => item.turn_id).sort(), [first.run.turn_id, next.id]);
});

test('native Goal completed before initial turn/start reply is never reactivated', async t => {
  const f = fixture(t, { initialStatus: 'completed', beforeTurnReply: server => { server.updateGoal('complete'); } });
  const sent = await f.send('/goal 首轮快速完成'); await tick();
  assert.equal(sent.run.status, 'completed'); assert.equal(f.latest().executor_goal.status, 'complete');
  assert.equal(f.transport.calls('thread/goal/set').filter(call => call.params.status === 'active').length, 0);
  assert.equal(f.store.get('creator_goal', sent.run.goal_id).status, 'completed');
  assert.equal(f.store.list('creator_auto_verification').length, 0);
});

test('a delayed active getGoal reply cannot roll back a newer complete notification', async t => {
  let pending, oldGoal;
  const f = fixture(t, { onGetGoal: (server, message) => { pending = message; oldGoal = clone(server.goal); } });
  const first = await f.send('/goal 旧读取不倒退完成'); f.transport.complete(first.run.turn_id);
  await until(() => pending); f.transport.updateGoal('complete'); await tick();
  assert.equal(f.latest().status, 'completed');
  f.transport.reply(pending, { goal: oldGoal }); await tick();
  assert.equal(f.latest().executor_goal.status, 'complete'); assert.equal(f.latest().status, 'completed');
});

test('cancellation invalidates source tool lease before waiting for native Goal pause acknowledgement', async t => {
  let cancelling = false, observed = false;
  const f = fixture(t, { beforePausedReply: () => {
    if (!cancelling) return;
    assert.throws(() => f.manager.assertRun(f.request('world_apply')), error => error.status === 409);
    observed = true;
  } });
  await f.send('/goal 暂停回执期间不可写'); cancelling = true;
  await f.manager.interrupt(f.user, f.session.id); assert.equal(observed, true);
});

test('actual plan item type persists the full final planning text as a visible session message', async t => {
  const f = fixture(t); const sent = await f.send('/plan 返回真实规划');
  const item = { id: 'FAKE-plan-item', type: 'plan', text: '完整计划：每天只能领取一次；刷新规则待定。' };
  f.transport.thread.turns[0].items.push(item);
  f.transport.notification('item/completed', { threadId: sent.run.thread_id, turnId: sent.run.turn_id, item }); f.transport.complete(sent.run.turn_id); await tick();
  const messages = f.store.sessionView(f.user, f.session.id).messages;
  assert.ok(messages.some(message => message.role === 'assistant' && message.content === item.text && message.run_id === sent.run.id));
});

test('fixed-context SHA-256 announced to the real Agent identifies the actual manifest file bytes', async t => {
  const f = fixture(t); const sent = await f.send('/plan 读取固定上下文');
  const input = f.transport.calls('turn/start')[0].params.input[0].text;
  const expected = /固定上下文 SHA-256: ([a-f0-9]{64})/.exec(input)?.[1]; assert.ok(expected);
  const cwd = f.adapter.threads.get(sent.run.thread_id).cwd;
  const bytes = readFileSync(resolve(cwd, 'context', sent.run.id, 'manifest.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
});

test('resume reconstructed message IDs do not duplicate output or erase legitimate repeated text within/across turns', async t => {
  const f = fixture(t, { initialStatus: 'completed', reconstructedMessageIds: true, beforeTurnReply: (server, turn) => {
    for (const ordinal of [1, 2]) {
      const item = { id: 'live-' + turn.id + '-' + ordinal, type: 'agentMessage', text: '这句正文允许在真实不同消息中重复。' };
      turn.items.push(item); server.notification('item/completed', { threadId: server.thread.id, turnId: turn.id, item });
    }
  } });
  const first = await f.send('/plan 第一次讨论'); const second = await f.send('/plan 第二次讨论');
  const messages = () => f.store.sessionView(f.user, f.session.id).messages.filter(message => message.role === 'assistant');
  assert.equal(messages().length, 4); assert.equal(messages().filter(message => message.run_id === first.run.id).length, 2);
  await f.manager.reconcile(f.user, f.session.id);
  assert.equal(messages().length, 4, 'history-only IDs are aliases of existing exact-turn messages, not four new messages');
  assert.equal(messages().filter(message => message.run_id === first.run.id).length, 2); assert.equal(messages().filter(message => message.run_id === second.run.id).length, 2);
});

test('native world_read source_path returns only fixed file projection through real dynamic tool and guards',async t=>{
  const {NativeSourceArchive,nativeSourceIdentity}=await import('../../services/creation/native-source.mjs');
  const {NativeTransactions}=await import('../../services/creation/native-transactions.mjs');
  const f=fixture(t,{editor:true}),archive=new NativeSourceArchive(resolve(f.data,'native-source/objects'));
  const text='extends Node\n# original fixed source\n',files={'project.godot':archive.put('config_version=5\n'),'main.gd':archive.put(text),'too-large.gd':archive.put('#'.repeat(256*1024+1))};
  const sourceIdentity=nativeSourceIdentity(files),manifest={schema:'creation-native-1',entry_scene_id:'scene',source_files:files,source_identity:sourceIdentity,index_source_identity:sourceIdentity,resources:{scene:{id:'scene',kind:'scene',name:'Scene',path:'scene.tscn',version:'resource-v1',native_nodes:[],unknown_large_index:'index'.repeat(500000)}}};
  const initial=f.store.branchFor(f.user,f.project,'main'),fixed=f.store.writeRevision(f.project,[initial.head],manifest,f.user.id);initial.head=fixed.id;f.store.put('creator_branch',initial);
  const coordinator=new NativeTransactions({store:f.store,archive,prepare(){throw Error('This test must never run Godot or native writes');}});f.service.native={archive,source:coordinator.source.bind(coordinator)};
  await f.send('Read a source file using the explicit fake executor');
  const newerFiles={...files,'main.gd':archive.put('extends Node\n# later head\n')},newerIdentity=nativeSourceIdentity(newerFiles),newer=f.store.writeRevision(f.project,[fixed.id],{...manifest,source_files:newerFiles,source_identity:newerIdentity,index_source_identity:newerIdentity},f.user.id);f.store.put('creator_branch',{...initial,head:newer.id});
  const request=f.request('world_read',undefined,{source_path:'main.gd',revision:fixed.id}),result=await f.manager.dynamic(request),value=JSON.parse(result.contentItems[0].text);
  assert.equal(value.projection,'native-source-file');assert.equal(value.head,fixed.id);assert.equal(value.source_identity,sourceIdentity);assert.equal(value.source.revision,fixed.id);assert.equal(value.source.hash,files['main.gd'].hash);assert.equal(value.source.text,text);assert.equal('data_base64' in value.source,false);
  for(const field of ['manifest','resource','resolved_resource'])assert.equal(field in value,false);assert.ok(result.contentItems[0].text.length<16000,'a tiny file must not return the multi-megabyte engine index');
  assert.equal(JSON.parse(readFileSync(value.source_index,'utf8')).revision,fixed.id);assert.equal(f.store.get('creator_tool_receipt',f.latest().id+':'+request.callId).result.contentItems[0].text,result.contentItems[0].text);
  const fullResult=await f.manager.dynamic(f.request('world_read',undefined,{resource_id:'scene',revision:fixed.id})),fullPointer=JSON.parse(fullResult.contentItems[0].text);
  assert.ok(Buffer.byteLength(JSON.stringify(fullResult))<=256*1024);
  assert.equal(fullPointer.projection,'tool-result-file');
  const full=JSON.parse(readFileSync(fullPointer.result_file,'utf8'));
  assert.equal(full.projection,'native-resource');assert.equal('manifest' in full,false);assert.equal(full.resource.unknown_large_index,manifest.resources.scene.unknown_large_index);assert.equal(full.resource.version,'resource-v1');
  await assert.rejects(f.manager.dynamic(f.request('world_read',undefined,{source_path:'too-large.gd'})),error=>error.status===413);
  const aborted=f.request('world_read',undefined,{source_path:'main.gd'});aborted.signal=AbortSignal.abort();await assert.rejects(f.manager.dynamic(aborted),/执行已结束/);
  f.store.setMember(f.owner,f.project,f.user.id,null);await assert.rejects(f.manager.dynamic(request),/权限/);f.store.setMember(f.owner,f.project,f.user.id,'editor');
  const run=f.latest();f.store.put('creator_run',{...run,status:'completed'});await assert.rejects(f.manager.dynamic(request),/租约/);
});

test('native world_read keeps a small scene inline when unrelated native indices exceed the executor line limit',async t=>{
  const {NativeSourceArchive,nativeSourceIdentity}=await import('../../services/creation/native-source.mjs');
  const {NativeTransactions}=await import('../../services/creation/native-transactions.mjs');
  const f=fixture(t),archive=new NativeSourceArchive(resolve(f.data,'native-source/objects'));
  const text='extends Control\n# fixed cover source\n',files={'project.godot':archive.put('config_version=5\n'),'cover.gd':archive.put(text)};
  const sourceIdentity=nativeSourceIdentity(files),node={node_id:'cover-root',path:'.',name:'Cover',type:'Control',version:'node-v7',instance_ids:[],properties:[{name:'visible',value:true,version:'property-v3'}]};
  const scene={id:'scene',kind:'scene',name:'Cover',path:'cover.tscn',version:'resource-v4',native_nodes:[node]};
  const giant={id:'unrelated',kind:'prefab',name:'Unrelated',path:'unrelated.tscn',version:'other-v2',native_nodes:[],unknown_large_index:'unrelated-index\n'.repeat(2300000)};
  const manifest={schema:'creation-native-1',entry_scene_id:'scene',source_files:files,source_identity:sourceIdentity,index_source_identity:sourceIdentity,resources:{scene,unrelated:giant}};
  assert.ok(Buffer.byteLength(JSON.stringify(manifest))>32*1024*1024,'fixture must exceed the real executor line budget');
  const initial=f.store.branchFor(f.user,f.project,'main'),fixed=f.store.writeRevision(f.project,[initial.head],manifest,f.user.id);f.store.put('creator_branch',{...initial,head:fixed.id});
  const coordinator=new NativeTransactions({store:f.store,archive,prepare(){throw Error('No Godot or source writes permitted');}});f.service.native={archive,source:coordinator.source.bind(coordinator)};
  await f.send('Inspect the isolated native cover');
  const result=await f.manager.dynamic(f.request('world_read',undefined,{resource_id:'scene',revision:fixed.id})),value=JSON.parse(result.contentItems[0].text);
  assert.equal(result.success,true);assert.ok(Buffer.byteLength(JSON.stringify(result))<256*1024);
  assert.equal(value.projection,'native-resource');assert.equal('manifest' in value,false);assert.equal(value.head,fixed.id);
  assert.equal(value.resource.version,'resource-v4');assert.deepEqual(value.resource.native_nodes,[node]);
  assert.deepEqual(value.resolved_resource,{revision:fixed.id,resource_id:'scene'});
  const directory=Array.isArray(value.resources)?value.resources:Object.values(value.resources);
  assert.deepEqual(directory.map(resource=>resource.id).sort(),['scene','unrelated']);
  for(const resource of directory){assert.equal('native_nodes' in resource,false);assert.equal('unknown_large_index' in resource,false);}
  assert.ok(!result.contentItems[0].text.includes('unrelated-index'));
  const sourceResult=await f.manager.dynamic(f.request('world_read',undefined,{source_path:'cover.gd',revision:fixed.id})),source=JSON.parse(sourceResult.contentItems[0].text);
  assert.equal(source.source.text,text);assert.equal(source.source.hash,files['cover.gd'].hash);assert.equal(source.head,fixed.id);
  assert.equal(f.store.branchFor(f.user,f.project,'main').head,fixed.id);
});

test('oversized tool replies and persisted old receipts stay bounded without repeating the original tool effect',async t=>{
  const f=fixture(t);await f.send('Read the isolated knowledge payload');
  const large={revision:'fixed-knowledge-v1',text:'中文😀\n"quoted"\\'.repeat(100000)};let calls=0;
  f.service.semantic={knowledge(){calls++;return large;}};
  const request=f.request('knowledge_read',undefined,{id:'large'}),result=await f.manager.dynamic(request),pointer=JSON.parse(result.contentItems[0].text);
  assert.equal(result.success,true);assert.ok(Buffer.byteLength(JSON.stringify(result))<=256*1024);assert.equal(pointer.projection,'tool-result-file');
  const bytes=readFileSync(pointer.result_file);assert.deepEqual(JSON.parse(bytes),large);assert.equal(pointer.bytes,bytes.length);assert.equal(pointer.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(pointer.summary.revision,large.revision);
  assert.deepEqual(await f.manager.dynamic(request),result);assert.equal(calls,1,'same callId must not repeat the operation');
  const historical=f.request('knowledge_read',undefined,{id:'historical'}),receiptId=f.latest().id+':'+historical.callId;
  f.store.put('creator_tool_receipt',{id:receiptId,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(large)}]}});
  const recovered=await f.manager.dynamic(historical),recoveredPointer=JSON.parse(recovered.contentItems[0].text);
  assert.equal(recovered.success,true);assert.ok(Buffer.byteLength(JSON.stringify(recovered))<=256*1024);assert.equal(recoveredPointer.projection,'tool-result-file');
  assert.deepEqual(JSON.parse(readFileSync(recoveredPointer.result_file,'utf8')),large);assert.equal(calls,1,'old receipts are compacted without replaying the tool');
  const wireRequest={threadId:f.transport.thread.id,turnId:f.latest().turn_id,callId:'FAKE-large-wire',tool:'knowledge_read',arguments:{id:'wire'}};
  f.transport.server({id:9001,method:'item/tool/call',params:wireRequest});
  await until(()=>f.transport.messages.some(message=>message.id===9001&&message.result));
  const wire=f.transport.messages.find(message=>message.id===9001).result;
  assert.equal(wire.success,true);assert.ok(Buffer.byteLength(JSON.stringify(wire))<=256*1024);
  f.transport.notification('item/completed',{threadId:wireRequest.threadId,turnId:wireRequest.turnId,item:{id:wireRequest.callId,type:'dynamicToolCall',tool:'knowledge_read',status:'completed',success:true,result:wire}});
  await tick();assert.equal(f.adapter.connected,true);assert.equal(f.latest().status,'running');
  const beforeReplay=calls;f.transport.server({id:9001,method:'item/tool/call',params:wireRequest});await tick();
  assert.equal(calls,beforeReplay,'duplicate executor RPC only resends its bounded receipt');
  assert.equal(f.transport.messages.filter(message=>message.id===9001&&message.result).length,2);
});

test('large same-name attachment snapshots remain immutable history while Agent input and context contain short references',async t=>{
  const f=fixture(t),payload='PRIVATE-SNAPSHOT-PAYLOAD-'.repeat(100000);
  const attachments=[
    {id:'reference-old',kind:'prefab',role:'reference',name:'宝箱',project_id:f.project,branch_id:'main',resource_id:'scene',source_revision:'captured-old',snapshot:{name:'宝箱',version:'old-node-version',payload,assets:[{data_base64:payload}]},world_matrix:Array(16).fill(17)},
    {id:'reference-new',kind:'prefab',role:'reference',name:'宝箱',project_id:f.project,branch_id:'main',resource_id:'scene',source_revision:'captured-new',snapshot:{name:'宝箱',version:'new-node-version',payload},world_matrix:Array(16).fill(27)}
  ],original=clone(attachments);
  const projected=clone(original);projected[0].snapshot.assets=[{data_omitted:true}];
  f.store.put('creator_session',{...f.store.get('creator_session',f.session.id),draft_attachments:attachments});
  const sent=await f.send('比较 [[ref:reference-old]] 和 [[ref:reference-new]]');
  const params=f.transport.calls('turn/start').at(-1).params,wire=JSON.stringify(params.input);
  assert.ok(Buffer.byteLength(wire)<100000,'multi-megabyte snapshots must not be in turn/start');
  assert.ok(!wire.includes('PRIVATE-SNAPSHOT-PAYLOAD'));assert.ok(!wire.includes('world_matrix'));assert.ok(!wire.includes('data_base64'));
  assert.match(params.input[0].text,/\[@@宝箱\]\(attachment:reference-old\).*\[@@宝箱\]\(attachment:reference-new\)/);
  const contextPath=f.store.get('creator_session',f.session.id).executor_thread_id&&f.adapter.threads.get(f.transport.thread.id).cwd;
  const current=JSON.parse(readFileSync(resolve(contextPath,'context/current.json'),'utf8')),context=JSON.parse(readFileSync(current.manifest,'utf8'));
  assert.ok(Buffer.byteLength(JSON.stringify(context))<100000);assert.equal(context.attachments.length,2);
  const wireReferences=JSON.parse(params.input[1].text.slice(params.input[1].text.indexOf('\n')+1));
  assert.deepEqual(wireReferences,context.attachments,'wire links resolve to exactly the fixed-context snapshots');
  assert.notEqual(context.attachments[0].snapshot_file,context.attachments[1].snapshot_file);
  for(let i=0;i<2;i++){
    const reference=context.attachments[i];assert.equal(reference.id,original[i].id);assert.equal(reference.href,'attachment:'+original[i].id);assert.equal(reference.source_revision,original[i].source_revision);
    for(const field of ['snapshot','assets','world_matrix','payload'])assert.equal(field in reference,false);
    const archived=readFileSync(reference.snapshot_file);assert.deepEqual(JSON.parse(archived),projected[i]);assert.equal(reference.sha256,createHash('sha256').update(archived).digest('hex'));assert.ok(!archived.toString().includes('data_base64'));
  }
  attachments[0].snapshot.version='tampered';attachments[1].name='tampered';attachments.splice(0,1);
  const persisted=f.store.sessionView(f.user,f.session.id).messages.find(message=>message.role==='user'&&message.run_id===sent.run.id);
  assert.deepEqual(persisted.attachments,original);
  const submission=f.events.find(event=>event.kind==='submission'&&event.clientUserMessageId===sent.run.client_user_message_id);
  assert.deepEqual(submission.attachments,original,'local submission evidence retains original immutable snapshots');
  assert.deepEqual(JSON.parse(readFileSync(context.attachments[0].snapshot_file,'utf8')),projected[0]);
});

test('adapter freezes large references before async setup and still rejects cross-scope attachments',async t=>{
  const f=fixture(t);await f.manager.bind(f.session);
  const threadId=f.transport.thread.id,bound=f.adapter.threads.get(threadId),attachment={id:'frozen-reference',kind:'knowledge',name:'冻结规则',project_id:f.project,branch_id:'main',source_revision:'old-observation',snapshot:{content:'FROZEN-PAYLOAD-'.repeat(200000)}};
  const original=clone(attachment),input=[attachment],cwd=f.adapter._cwd.bind(f.adapter);let entered,release;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  f.adapter._cwd=async path=>{entered();await gate;return cwd(path);};
  const pending=f.adapter.sendTurn(threadId,{text:'Read [$$冻结规则](attachment:frozen-reference)',attachments:input,model:'FAKE-mode-model'});await started;
  attachment.name='mutated';attachment.snapshot.content='mutated';input.push({id:'late-added'});release();await pending;
  f.adapter._cwd=cwd;
  const submission=f.events.find(event=>event.kind==='submission');assert.deepEqual(submission.attachments,[original]);
  const wire=JSON.stringify(f.transport.calls('turn/start').at(-1).params.input);assert.ok(!wire.includes('FROZEN-PAYLOAD'));assert.ok(!wire.includes('late-added'));assert.ok(!wire.includes('mutated'));assert.ok(Buffer.byteLength(wire)<100000);
  f.transport.complete(bound.turnId);await tick();const calls=f.transport.calls('turn/start').length;
  for(const scope of [{project_id:'foreign-project'},{branch_id:'foreign-branch'}]){
    await assert.rejects(f.adapter.sendTurn(threadId,{text:'Invalid scope',attachments:[{...original,...scope}],model:'FAKE-mode-model'}),{code:'ATTACHMENT_SCOPE_MISMATCH'});
  }
  assert.equal(f.transport.calls('turn/start').length,calls);
});

test('historical overflow receipt replay cannot direct the Agent back to archived raw resource bytes',async t=>{
  const f=fixture(t);await f.send('Replay the isolated historical result');
  const request=f.request('knowledge_read',undefined,{id:'old-result'}),rawAsset=Buffer.from('HISTORICAL_ASSET_BYTES'.repeat(10000)).toString('base64');
  const oldValue={revision:'historic',resource:{$type:'Resource',class:'ImageTexture',path:'res://assets/icon.png',data_base64:rawAsset}};
  const text=JSON.stringify(oldValue),sha256=createHash('sha256').update(text).digest('hex'),file=resolve(request.cwd,'outputs/tool-results',sha256+'.json');mkdirSync(resolve(request.cwd,'outputs/tool-results'),{recursive:true});writeFileSync(file,text);
  const pointer={projection:'tool-result-file',result_file:file,sha256,bytes:Buffer.byteLength(text),summary:{revision:'historic'}};
  f.store.put('creator_tool_receipt',{id:f.latest().id+':'+request.callId,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(pointer)}]}});
  f.service.semantic={knowledge(){assert.fail('old receipt must never execute another tool effect');}};
  const result=await f.manager.dynamic(request),body=JSON.parse(result.contentItems[0].text);
  assert.equal(result.success,true);assert.ok(!JSON.stringify(body).includes(rawAsset));
  const exposed=body.result_file?JSON.parse(readFileSync(body.result_file,'utf8')):body;
  assert.ok(!JSON.stringify(exposed).includes(rawAsset),'replayed file pointers must be reprojected before exposing historical result files');
  assert.ok(JSON.stringify(exposed).includes('res://assets/icon.png'));
  assert.equal(readFileSync(file,'utf8'),text,'historical evidence remains unchanged while its Agent projection is refreshed');
});
