/**
 * Independent contract tests: REAL isolated SQLite and manager/service methods;
 * explicitly FAKE executor, transport, world projection and rendered observation.
 * No Codex process, model call, Godot process, HTTP listener, GPU or Case13 claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { CreationStore } from '../../services/creation/store.mjs';
import { CreationService } from '../../services/creation/service.mjs';
import { CreationAgentRuns } from '../../services/creation/agent-runs.mjs';
import { CreationWorlds } from '../../services/creation/worlds.mjs';
import { HIERARCHY_SCHEMA, emptyDocument, prepareManifest, resolveScene, scopedAddressKey } from '../../services/creation/hierarchy.mjs';
import { hierarchyRuntimeId } from '../../services/creation/hierarchy-view.mjs';
import { inspectionObjects, inspectionAttachment } from '../../services/creation/inspection-objects.mjs';
import { identityTransform } from '../../packages/scene/transform.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const uid = prefix => `${prefix}-${randomUUID()}`;
const clone = structuredClone;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolvePromise; const promise = new Promise(r => { resolvePromise = r; }); return { promise, resolve: resolvePromise }; };
const status = code => error => error.status === code;
const pause = () => new Promise(r => setImmediate(r));

class ExplicitFakeExecutor extends EventEmitter {
  constructor() { super(); this.connected = true; this.threads = new Map(); this.turns = new Map(); this.calls = []; this.counter = 0; this.nextGate = null; this.loseNextReply = false; this.resumeResult = null; }
  async start() { this.connected = true; }
  async listModels() { return { data: [{ model: 'FAKE-executor-contract-only', isDefault: true }] }; }
  async accountStatus() { return { account: { type: 'FAKE-no-account' } }; }
  async createThread(options) {
    const id = `FAKE-thread-${++this.counter}`; this.threads.set(id, { ...options, loaded: true, busy: false, uncertain: false });
    this.calls.push({ method: 'createThread', thread_id: id }); return { thread: { id, turns: [] }, reconciliation: { canSend: true } };
  }
  async resumeThread(options) {
    this.threads.set(options.threadId, { ...options, loaded: true, busy: false, uncertain: false });
    this.calls.push({ method: 'resumeThread', thread_id: options.threadId, expected_turn_id: options.expectedTurnId, expected_message_id: options.expectedClientUserMessageId }); return this.resumeResult ? clone(this.resumeResult) : { thread: { id: options.threadId, turns: [] }, reconciliation: { canSend: true, uncertain: false } };
  }
  async sendTurn(threadId, input) {
    const turn = { id: `FAKE-turn-${++this.counter}`, status: 'inProgress', items: [] }; this.turns.set(`${threadId}/${turn.id}`, turn); this.threads.get(threadId).busy = true;
    this.calls.push({ method: 'sendTurn', thread_id: threadId, turn_id: turn.id, message_id: input.clientUserMessageId });
    const gate = this.nextGate; this.nextGate = null;
    if (gate) { gate.entered.resolve({ threadId, turn: clone(turn) }); await gate.release.promise; }
    if (this.loseNextReply) { this.loseNextReply = false; throw Object.assign(new Error('FAKE lost turn/start RPC response'), { uncertain: true }); }
    return { turn: clone(turn) };
  }
  holdNextTurn() { const gate = { entered: deferred(), release: deferred() }; this.nextGate = gate; return gate; }
  notification(method, params) { this.emit('event', { kind: 'notification', method, params: clone(params) }); }
  complete(run, outcome = 'completed') {
    const turn = { id: run.turn_id, status: outcome, items: [] }; this.turns.set(`${run.thread_id}/${run.turn_id}`, turn);
    this.threads.get(run.thread_id).busy = false; this.emit('terminal', { threadId: run.thread_id, turn });
  }
  async tool(run, name, args, callId = uid('FAKE-call')) {
    const thread = this.threads.get(run.thread_id);
    const request = { scope: thread.scope, threadId: run.thread_id, turnId: run.turn_id, tool: name, arguments: clone(args), callId, cwd: thread.cwd, signal: new AbortController().signal };
    this.calls.push({ method: 'FAKE-dynamic-tool', tool: name, call_id: callId, thread_id: run.thread_id, turn_id: run.turn_id });
    return thread.onDynamicTool(request);
  }
  async stop() { this.connected = false; } // No real executor or subprocess exists.
}

function hierarchyFixture() {
  const scene = emptyDocument('scene'), cabin = emptyDocument('cabin', 'prefab'), door = emptyDocument('door', 'prefab');
  door.nodes.same = { id: 'same', parent_id: 'root', name: 'Same door', kind: 'anchor', color: '#74d5cd', solid: false, components: {}, transform: identityTransform() };
  let value = prepareManifest({ schema: HIERARCHY_SCHEMA, entry_scene_id: 'scene', resources: { scene, cabin, door }, prefab_revisions: {} });
  const mount = (id, prefab) => ({ instance_id: id, prefab_id: prefab, prefab_revision: value.resources[prefab].version, parent_id: 'root', transform: identityTransform(), overrides: [] });
  value.resources.cabin.instances.inner = mount('inner', 'door'); value = prepareManifest(value);
  value.resources.scene.instances.left = mount('left', 'cabin'); value.resources.scene.instances.right = { ...mount('right', 'cabin'), transform: { ...identityTransform(), position: [8, 0, 0] } };
  return prepareManifest(value);
}

function fixture(report) {
  const data = mkdtempSync(resolve(tmpdir(), 'atelier-FAKE-creator-contract-')), file = resolve(data, 'creation.sqlite');
  let store = new CreationStore(file);
  const user = store.register({ name: uid('contract-owner'), password: uid('password') }).user;
  const base = store.createProject(user, { name: 'FAKE executor contract fixture' }, { entry_scene_id: 'scene', resources: { scene: { id: 'scene', kind: 'scene', name: 'Scene', objects: [] } } });
  const p = base.project.id, revision = store.writeRevision(p, [base.branch.head], hierarchyFixture(), user.id);
  store.put('creator_branch', { ...store.get('creator_branch', `${p}:main`), head: revision.id });
  const publicPackets = [], privatePackets = [], commits = [];
  // Prototype methods are the actual implementation. Transport is a collector.
  const service = Object.assign(Object.create(CreationService.prototype), { data, root, origin: 'http://FAKE-contract.invalid', hierarchyEditing: true, assets: { directory: resolve(data, 'assets') }, worlds: null,
    realtime: { committed: (project, branch, value) => commits.push({ project, branch, value: clone(value) }), development: (project, branch, states) => publicPackets.push({ project, branch, states: clone(states) }), sessionEvent: (sid, event) => privatePackets.push({ sid, event: clone(event) }) } });
  mkdirSync(service.assets.directory); Object.defineProperty(service, 'store', { get: () => store });
  let executor = new ExplicitFakeExecutor(), manager = new CreationAgentRuns({ service, adapter: executor }); service.agent = manager;
  const info = { data, sqlite_file: file, project_id: p, executor: 'FAKE', transport: 'FAKE collector', runtime: 'none' }; report.fixtures.push(info);
  const f = { data, file, user, p, service, publicPackets, privatePackets, commits, get store() { return store; }, get executor() { return executor; }, get manager() { return manager; },
    current: () => store.branchView(user, p, 'main'), scope: () => ({ project_id: p, branch_id: 'main', resource_id: 'scene' }),
    address: (side = 'left') => ({ project_id: p, branch_id: 'main', resource_id: 'scene', instance_path: [side, 'inner'], definition_node_id: 'same' }),
    row: (side = 'left', manifest = f.current().manifest) => resolveScene(manifest, 'scene', f.scope()).find(r => scopedAddressKey(r.address) === scopedAddressKey(f.address(side))),
    session: (branch = 'main') => store.createSession(user, p, branch, { title: 'FAKE-executor contract session' }),
    attach: (session, side = 'left') => store.attach(user, session.id, { revision: f.current().head, address: f.address(side), expected_version: f.row(side).object_version }),
    send: (session, input = {}) => manager.send(user, session.id, { text: 'FAKE contract goal, never a real Agent request', client_user_message_id: uid('message'), ...input }),
    apply: ops => service.committed(user, p, 'main', { transaction_id: uid('transaction'), base_revision: f.current().head, ops }),
    override: (side = 'left', color = '#119944') => ({ type: 'set_override', resource_id: 'scene', instance_id: side, expected_version: f.current().manifest.resources.scene.instances[side].version, override: { target: { instance_path: ['inner'], definition_node_id: 'same' }, path: ['color'], value: color } }),
    async reopen() { await manager.close(); store.close(); store = new CreationStore(file); executor = new ExplicitFakeExecutor(); manager = new CreationAgentRuns({ service, adapter: executor }); service.agent = manager; },
    async close() { info.executor_calls = clone(executor.calls); await manager.close(); store.close(); }
  };
  return f;
}

test('FAKE executor integration contract, real SQLite, no live Agent/HTTP/Godot', { timeout: 45000 }, async t => {
  const out = resolve(root, '.local/creation-verification/creator-integration-contract', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)); mkdirSync(out, { recursive: true });
  const files = ['services/creation/agent-runs.mjs', 'services/creation/service.mjs', 'services/creation/hierarchy-agent.mjs', 'services/creation/inspection-objects.mjs', 'services/creation/worlds.mjs', 'services/creation/store.mjs'];
  const report = { started_at: new Date().toISOString(), evidence: 'REAL SQLite; FAKE executor, FAKE transport, explicitly synthetic world/observation fixture rows', counts_as_real_agent: false, counts_as_Case13: false, fixtures: [], cases: [], source_hashes: Object.fromEntries(files.map(f => [f, digest(readFileSync(resolve(root, f)))])) };
  const save = () => writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  async function check(id, title, fn) {
    const item = { id, title, status: 'running' }; report.cases.push(item);
    await t.test(`${id} ${title}`, async () => { const f = fixture(report); try { await fn(f, item); assert.equal(f.manager.lastProjectionError, undefined, 'No swallowed public-state projection exception'); item.status = 'passed'; } catch (error) { item.status = 'failed'; item.error = { message: error.message, stack: error.stack }; throw error; } finally { await f.close(); save(); } });
  }
  try {
    await check('CIC01', 'same-goal CAS, exact message replay and SQLite reopen retain identity', async (f, evidence) => {
      const s = f.session(); f.attach(s); const first = await f.send(s, { text: 'Original objective', client_user_message_id: 'first' }); f.executor.complete(first.run);
      const goal = f.store.get('creator_goal', first.run.goal_id), input = { text: 'Revise the same objective', client_user_message_id: 'continue', goal_id: goal.id, expected_run_id: first.run.id };
      const second = await f.send(s, input); assert.equal(second.run.goal_id, goal.id); assert.equal(second.run.previous_run_id, first.run.id); assert.deepEqual(second.run.targets, first.run.targets);
      assert.equal(f.store.get('creator_goal', goal.id).objective, 'Original objective'); assert.deepEqual(f.store.get('creator_goal', goal.id).run_ids, [first.run.id, second.run.id]);
      const replay = await f.send(s, input); assert.equal(replay.replayed, true); assert.equal(replay.run.id, second.run.id); assert.equal(f.executor.calls.filter(c => c.method === 'sendTurn').length, 2);
      await assert.rejects(f.send(s, { ...input, text: 'Changed payload with same message ID' }), status(409));
      await assert.rejects(f.send(s, { ...input, client_user_message_id: 'stale-cas' }), status(409));
      f.executor.complete(second.run); await f.reopen(); const replayAfter = await f.send(s, input); assert.equal(replayAfter.replayed, true); assert.equal(replayAfter.run.id, second.run.id); assert.equal(f.executor.calls.length, 0);
      assert.equal(f.store.sessionView(f.user, s.id).messages.filter(m => m.role === 'user').length, 2); evidence.goal_id = goal.id; evidence.run_ids = [first.run.id, second.run.id];
    });
    await check('CIC02', 'pending turn response fences concurrent submit and late old-turn notifications', async f => {
      const s = f.session(); f.attach(s); const first = await f.send(s); f.executor.complete(first.run);
      const gate = f.executor.holdNextTurn(), next = f.send(s, { goal_id: first.run.goal_id, expected_run_id: first.run.id }); const entered = await gate.entered.promise;
      try {
        await assert.rejects(f.send(s), status(409));
        const newId = f.store.get('creator_goal', first.run.goal_id).run_id; assert.notEqual(newId, first.run.id); assert.equal(f.store.get('creator_run', newId).turn_id, undefined);
        f.executor.complete(first.run); f.executor.notification('item/completed', { threadId: first.run.thread_id, turnId: first.run.turn_id, item: { id: 'FAKE-old-message', type: 'agentMessage', text: 'PRIVATE old turn' } });
        f.executor.notification('item/completed', { threadId: first.run.thread_id, turnId: entered.turn.id, item: { id: 'FAKE-new-before-response', type: 'agentMessage', text: 'PRIVATE new before RPC response' } });
        assert.equal(f.store.get('creator_run', newId).turn_id, undefined); assert.equal(f.store.get('creator_run', newId).status, 'running');
        await assert.rejects(f.executor.tool(first.run, 'world_apply', { transaction_id: uid('old'), base_revision: f.current().head, ops: [f.override()] }), status(409));
      } finally { gate.release.resolve(); }
      const second = await next; assert.equal(second.run.turn_id, entered.turn.id); assert.equal(second.run.status, 'running'); assert.equal(f.store.get('creator_goal', first.run.goal_id).run_id, second.run.id);
      const messages = f.store.sessionView(f.user, s.id).messages; assert.equal(messages.find(m => m.executor_item_id === 'FAKE-old-message').run_id, first.run.id); assert.equal(messages.find(m => m.executor_item_id === 'FAKE-new-before-response').run_id, second.run.id);
    });
    await check('CIC03', 'nested world_apply changes one door, replays once and retains deleted targets', async f => {
      const s = f.session(); f.attach(s); const run = (await f.send(s)).run;
      const read = JSON.parse((await f.executor.tool(run, 'world_read', { resource_id: 'scene' })).contentItems[0].text);
      assert.equal(read.resolved_resource.revision, f.current().head); assert.ok(read.resolved_resource.rows.some(r => scopedAddressKey(r.address) === scopedAddressKey(f.address()))); assert.match(readFileSync(read.documentation, 'utf8'), /set_override/);
      const right = clone(f.row('right')), input = { transaction_id: uid('nested'), base_revision: f.current().head, ops: [f.override()] }, call = uid('call');
      const applied = await f.executor.tool(run, 'world_apply', input, call), head = f.current().head; assert.equal(f.row().node.color, '#119944'); assert.deepEqual(f.row('right'), right);
      assert.deepEqual(await f.executor.tool(run, 'world_apply', input, call), applied); assert.equal(f.current().head, head); assert.equal(f.commits.length, 1);
      const before = f.store.get('creator_run', run.id).targets; assert.ok(before.some(t => scopedAddressKey(t.address) === scopedAddressKey(f.address())));
      await f.executor.tool(run, 'world_apply', { transaction_id: uid('delete'), base_revision: head, ops: [{ type: 'delete_instance', resource_id: 'scene', instance_id: 'left', expected_version: f.current().manifest.resources.scene.instances.left.version }] });
      assert.equal(f.row(), undefined); assert.ok(f.row('right')); const after = f.store.get('creator_run', run.id).targets; assert.ok(after.some(t => scopedAddressKey(t.address) === scopedAddressKey(f.address()))); assert.ok(after.some(t => t.address.instance_path[0] === 'left' && t.address.definition_node_id === 'root'));
      assert.equal(after.some(t => t.address.instance_path[0] === 'right'), false); assert.equal(f.manager.publicState(f.p, 'main').some(t => t.address.instance_path[0] === 'left'), false);
    });
    await check('CIC04', 'source/applied/frozen pins remain distinct and reject mixed revision or branch', async f => {
      const s = f.session(), old = f.current(), row = f.row(), source = f.attach(s);
      const observedMatrix = clone(row.world_matrix); observedMatrix[12] = 7; observedMatrix[13] = 2; observedMatrix[14] = 3;
      const observation = { id: hierarchyRuntimeId(row.address), address: row.address, object_version: row.object_version, world_matrix: observedMatrix };
      const observations = inspectionObjects(old.manifest, f.scope(), [observation]);
      const fixed = { id: uid('FAKE-inspection'), project_id: f.p, branch_id: 'main', resource_id: 'scene', owner_user_id: f.user.id, world_id: 'FAKE-world-no-runtime', epoch: 4, sequence: 90, revision: old.head, runtime_build_id: 'FAKE-build-no-render', state_hash: 'FAKE-state-not-a-real-ACK', stop_ack_sequence: 88, input_zero_seq: 3, observations };
      f.store.put('creator_inspection', fixed); f.apply([f.override('left', '#331199')]); const changed = f.row(); assert.notEqual(changed.object_version, row.object_version);
      assert.equal(source.revision, old.head); assert.deepEqual(source.world_matrix, row.world_matrix);
      assert.throws(() => f.store.attach(f.user, s.id, { revision: f.current().head, address: f.address(), expected_version: row.object_version }), status(409));
      assert.throws(() => f.store.attach(f.user, s.id, { revision: old.head, address: { ...f.address(), branch_id: 'other' }, expected_version: row.object_version }), status(409));
      assert.throws(() => inspectionObjects(old.manifest, f.scope(), [{ ...observation, object_version: changed.object_version }]), status(409));
      assert.throws(() => inspectionObjects(f.current().manifest, f.scope(), [observation]), status(409));
      assert.throws(() => inspectionObjects(old.manifest, f.scope(), [{ ...observation, address: { ...row.address, branch_id: 'other' } }]), status(409));
      const input = { inspection_id: fixed.id, world_id: fixed.world_id, epoch: fixed.epoch, sequence: fixed.sequence, resource_id: fixed.resource_id, address: row.address, expected_version: row.object_version };
      const attached = CreationWorlds.prototype.attachInspection.call({ store: f.store }, f.user, s.id, input); assert.equal(attached.source_revision, old.head); assert.deepEqual(attached.source_world_matrix, row.world_matrix); assert.deepEqual(attached.world_matrix, observedMatrix); assert.equal(attached.observation.runtime_build_id, fixed.runtime_build_id);
      for (const patch of [{ epoch: 5 }, { sequence: 91 }, { world_id: 'FAKE-other' }, { resource_id: 'door' }, { expected_version: changed.object_version }, { address: { ...row.address, branch_id: 'other' } }]) assert.throws(() => CreationWorlds.prototype.attachInspection.call({ store: f.store }, f.user, s.id, { ...input, ...patch }), status(409));
      f.store.fork(f.user, f.p, { from_branch: 'main', branch_id: 'other', expected_head: f.current().head }); const other = f.session('other'); assert.throws(() => CreationWorlds.prototype.attachInspection.call({ store: f.store }, f.user, other.id, input), status(403));
      assert.deepEqual(inspectionAttachment(old.manifest, fixed, input).world_matrix, observedMatrix);
    });
    await check('CIC05', 'two active runs on the same address have independent editing states which clear on completion', async (f, evidence) => {
      const s1=f.session();f.attach(s1);const one=(await f.send(s1,{text:'PRIVATE goal one'})).run;
      await f.executor.tool(one,'world_apply',{transaction_id:uid('one'),base_revision:f.current().head,ops:[f.override()]});
      const s2=f.session();f.attach(s2);const two=(await f.send(s2,{text:'PRIVATE goal two'})).run;
      const states=f.manager.publicState(f.p,'main'),a=states.find(t=>t.run_id===one.id),b=states.find(t=>t.run_id===two.id);
      assert.ok(a&&b);assert.equal(a.status,'editing');assert.equal(b.status,'editing');assert.deepEqual(a.address,b.address);assert.equal(states.length,2);
      assert.equal(JSON.stringify(states).includes('PRIVATE goal'),false);assert.equal(states.some(t=>'verification' in t||'acceptance' in t),false);
      f.executor.complete(one);assert.equal(f.store.get('creator_goal',one.goal_id).status,'completed');assert.deepEqual(f.manager.publicState(f.p,'main').map(t=>t.run_id),[two.id]);
      f.executor.complete(two);assert.equal(f.store.get('creator_goal',two.goal_id).status,'completed');assert.deepEqual(f.manager.publicState(f.p,'main'),[]);
      assert.equal(f.store.list('creator_auto_verification').length,0);evidence.source_saved_without_review=true;
    });
    await check('CIC06', 'manual tools bind validation to the exact active run without a review prerequisite', async f => {
      const s=f.session();f.attach(s);const run=(await f.send(s)).run,calls=[];
      f.service.validator={async validate(user,p,b,input){input.guard();calls.push(input);return{id:uid('FAKE-check'),status:'passed'};}};
      await f.executor.tool(run,'game_validate',{revision:run.input_revision,resource_id:'scene'});
      assert.deepEqual(calls[0].origin,{run_id:run.id,session_id:s.id});
      f.executor.complete(run);await f.send(s,{goal_id:run.goal_id,expected_run_id:run.id});assert.throws(calls[0].guard,status(409));
      assert.equal(f.store.list('creator_auto_verification').length,0);
    });
    await check('CIC07', 'pending exact-turn input blocks continuation while unknown-turn events cannot bind latest', async f => {
      const s = f.session(); const run = (await f.send(s)).run;
      f.executor.notification('item/completed', { threadId: run.thread_id, turnId: 'FAKE-unknown-turn', item: { id: 'FAKE-unknown-message', type: 'agentMessage', text: 'Must remain unattributed' } });
      assert.equal(f.store.sessionView(f.user, s.id).messages.some(m => m.executor_item_id === 'FAKE-unknown-message'), false); assert.equal(f.store.get('creator_run', run.id).turn_id, run.turn_id);
      f.executor.complete(run);
      // Explicit pending fixture to exercise manager CAS gate independently of adapter delivery order.
      f.manager.requests.set('FAKE-pending', { params: { threadId: run.thread_id, turnId: run.turn_id } });
      await assert.rejects(f.send(s, { goal_id: run.goal_id, expected_run_id: run.id }), status(409));
      f.manager.requests.delete('FAKE-pending'); await f.send(s, { goal_id: run.goal_id, expected_run_id: run.id }); assert.equal(f.store.list('creator_goal').length, 1);
    });
    for (const [id, outcome] of [['CIC08', 'completed'], ['CIC09', 'inProgress']]) await check(id, `lost RPC response recovers only an explicitly matched ${outcome} turn`, async f => {
      const s = f.session(); f.executor.loseNextReply = true;
      await assert.rejects(f.send(s, { client_user_message_id: 'lost-response-message' }), /FAKE lost turn\/start/);
      const run = f.store.list('creator_run')[0], sent = f.executor.calls.find(c => c.method === 'sendTurn');
      assert.equal(run.status, 'uncertain'); assert.equal(run.turn_id, undefined);
      const turn = { id: sent.turn_id, status: outcome, items: [] };
      f.executor.resumeResult = { thread: { id: run.thread_id, turns: [turn] }, reconciliation: { canSend: false, uncertain: true } };
      await f.manager.reconcile(f.user, s.id); assert.equal(f.store.get('creator_run', run.id).turn_id, undefined, 'A merely visible latest turn is not proof of binding'); assert.equal(f.store.get('creator_run', run.id).status, 'uncertain');
      f.executor.resumeResult.reconciliation = { canSend: outcome === 'completed', uncertain: false, matchedTurnId: sent.turn_id };
      await f.manager.reconcile(f.user, s.id); const recovered = f.store.get('creator_run', run.id);
      assert.equal(recovered.turn_id, sent.turn_id); assert.equal(recovered.status, outcome === 'completed' ? 'completed' : 'running');
      assert.ok(f.executor.calls.filter(c => c.method === 'resumeThread').every(c => c.expected_message_id === 'lost-response-message'));
      assert.equal(f.executor.calls.filter(c => c.method === 'sendTurn').length, 1, 'Recovery never resubmits the goal');
    });
  } finally {
    report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(files.map(f => [f, digest(readFileSync(resolve(root, f)))])); report.source_changed_during_run = files.filter(f => report.source_hashes[f] !== report.source_hashes_after[f]);
    report.completed = report.cases.every(c => c.status === 'passed') && !report.source_changed_during_run.length; save(); writeFileSync(resolve(out, 'executed-driver.mjs'), readFileSync(fileURLToPath(import.meta.url)));
    console.log('FAKE_CREATOR_CONTRACT_REPORT ' + resolve(out, 'report.json'));
  }
});
