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
  constructor({ turnStatus = 'interrupted', goalStatus = 'paused' } = {}) {
    super(); this.connected = true; this.threads = new Map(); this.sendCalls = 0;
    this.match = true; this.turn = { id: 'FAKE-turn', status: turnStatus, items: [] };
    this.goal = { threadId: 'FAKE-thread', objective: 'FAKE recovery objective', status: goalStatus };
  }
  async start() { this.connected = true; }
  async listModels() { return { data: [{ model: 'FAKE-model', isDefault: true }] }; }
  async accountStatus() { return { account: { type: 'FAKE' } }; }
  async readThread() { return { thread: { id: 'FAKE-thread', turns: [structuredClone(this.turn)] } }; }
  async resumeThread() {
    const busy = this.turn.status === 'inProgress';
    this.threads.set('FAKE-thread', { loaded: true, busy, uncertain: false });
    return { ...await this.readThread(), reconciliation: { canSend: !busy && this.match, uncertain: !this.match, matchedTurnId: this.match ? this.turn.id : null } };
  }
  async getGoal() { return { goal: structuredClone(this.goal) }; }
  async setGoal(_thread, patch) { Object.assign(this.goal, patch); return this.getGoal(); }
  async listBackgroundTerminals() { return { data: [], nextCursor: null }; }
  pendingRequests() { return []; }
  async sendTurn(_thread, input) { this.sendCalls++; this.lastInput = input; this.goal.objective = input.goalObjective; return { turn: { id: 'FAKE-next', status: 'inProgress' } }; }
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
  store.put('creator_goal', { id: 'goal', session_id: 'session', run_id: 'run', status: 'running', objective: 'Make the original boss scene' });
  store.put('creator_run', { id: 'run', goal_id: 'goal', session_id: 'session', project_id: 'project', branch_id: 'main', owner_user_id: 'user', thread_id: 'FAKE-thread', turn_id: 'FAKE-turn', turn_ids: ['FAKE-turn'], client_user_message_id: 'FAKE-message', status: 'running', execution_mode: options.mode ?? 'default', goal_initializing: false, goal_activation_confirmed: true, executor_goal_objective: 'FAKE recovery objective', executor_goal: { status: 'active', objective: 'FAKE recovery objective' }, lease_generation: 1, targets: [], changes: [], deliveries: [], created_at: 1 });
  if (options.historicalCleanup) {
    store.put('creator_run', { ...store.get('creator_run', 'run'), id: 'old-cancelled', turn_id: 'FAKE-old-turn', turn_ids: ['FAKE-old-turn'], created_at: 0, status: 'interrupted', execution_mode: 'default', cancel_requested_at: 1, cleanup_status: 'verified', cleanup_checked_at: 2, cleanup_result: { status: 'verified', reason: 'owned_terminals_stopped_and_rechecked', commands: [] } });
    store.put('creator_run', { ...store.get('creator_run', 'run'), status: 'completed', execution_mode: 'default', completed_at: 3 });
  }
  const service = { data, root: data, origin: 'http://FAKE.invalid', store, sessionEvent: (sid, event) => store.appendSessionEvent(sid, event), realtime: { development() {} } };
  const adapter = new FakeRecoveryAdapter(options);
  const manager = new CreationAgentRuns({ service, adapter, autoResumeOptions: { delays: options.delays ?? [100000,100000,100000] }, cleanupOptions: { quietMs: 5, pollIntervalMs: 2, timeoutMs: 100 } });
  t.after(async () => { await manager.close(); store.close(); rmSync(data, { recursive: true, force: true }); });
  return { store, user, adapter, manager, latest: () => store.get('creator_run', 'run') };
}


test('FAKE automatic recovery resumes confirmed interrupted turn once, preserving goal and draft', async t => {
  const f=fixture(t), session=f.store.get('creator_session','session');
  session.draft='An unsent new idea';session.draft_attachments=[{id:'draft-only',kind:'knowledge',role:'reference'}];f.store.put('creator_session',session);
  await Promise.all([f.manager.autoResume.resume('run'),f.manager.autoResume.resume('run')]);
  assert.equal(f.adapter.sendCalls,1);
  const next=f.manager.runForSession('session');assert.equal(next.auto_resume_count,1);assert.equal(next.previous_run_id,'run');assert.equal(next.goal_id,'goal');
  assert.equal(f.latest().auto_resume.status,'continued');assert.equal(f.latest().cleanup_status,'verified');
  assert.equal(f.store.get('creator_goal','goal').objective,'Make the original boss scene');
  assert.equal(f.store.get('creator_session','session').draft,session.draft);assert.deepEqual(f.store.get('creator_session','session').draft_attachments,session.draft_attachments);
  assert.deepEqual(f.adapter.lastInput.attachments,[]);assert.match(f.adapter.lastInput.text,/Make the original boss scene/);
  await f.manager.autoResume.resume('run');assert.equal(f.adapter.sendCalls,1);
  f.manager.autoResume.capture(next,'executor_disconnected');assert.equal(next.auto_resume,undefined);
});
for(const turnStatus of ['completed','failed','inProgress'])test(`FAKE automatic recovery never replays ${turnStatus}`,async t=>{
 const f=fixture(t,{turnStatus});await f.manager.autoResume.resume('run');assert.equal(f.adapter.sendCalls,0);assert.equal(f.latest().auto_resume.status,'settled');
});
test('FAKE automatic recovery rejects unidentified turn and stops after bounded attempts',async t=>{
 const f=fixture(t);f.adapter.match=false;for(let i=0;i<3;i++){clearTimeout(f.manager.autoResume.timers.get('run'));f.manager.autoResume.timers.delete('run');await f.manager.autoResume.resume('run');}assert.equal(f.adapter.sendCalls,0);assert.equal(f.latest().auto_resume.status,'stopped');assert.equal(f.latest().auto_resume.attempts,3);
});
test('FAKE automatic recovery respects user stop before timer',async t=>{
 const f=fixture(t);await f.manager.interrupt(f.user,'session');await f.manager.autoResume.resume('run');assert.equal(f.adapter.sendCalls,0);assert.equal(f.latest().auto_resume_blocked_reason,'user_cancel');
});
test('FAKE automatic recovery respects revoked permission',async t=>{
 const f=fixture(t);f.store.put('creator_project',{id:'project',members:{}});await f.manager.autoResume.resume('run');assert.equal(f.adapter.sendCalls,0);assert.equal(f.latest().auto_resume.status,'stopped');
});
test('FAKE automatic recovery pauses for pending user decision without fabricating answer',async t=>{
 const f=fixture(t);f.manager.request({requestKey:'decision',method:'item/tool/requestUserInput',params:{threadId:'FAKE-thread',turnId:'FAKE-turn',questions:[]}});await f.manager.autoResume.resume('run');assert.equal(f.adapter.sendCalls,0);assert.equal(f.latest().auto_resume_blocked_reason,'waiting_for_user');
});
test('FAKE automatic recovery does not supersede a newer user run',async t=>{
 const f=fixture(t);f.store.put('creator_run',{...f.latest(),id:'newer',created_at:100,auto_resume:undefined});await f.manager.autoResume.resume('run');assert.equal(f.adapter.sendCalls,0);assert.equal(f.latest().auto_resume.status,'stopped');
});
test('FAKE automatic recovery preserves native goal execution',async t=>{
 const f=fixture(t,{mode:'goal'});await f.manager.autoResume.resume('run');assert.equal(f.adapter.sendCalls,1);const next=f.manager.runForSession('session');assert.equal(next.execution_mode,'goal');assert.equal(next.executor_goal.status,'active');assert.equal(next.goal_activation_confirmed,true);
});
test('FAKE automatic recovery captures live executor disconnect and excludes waiting/cancelled runs',async t=>{
 const f=fixture(t);let run=f.latest();delete run.auto_resume;run.status='running';f.store.put('creator_run',run);f.adapter.connected=false;f.adapter.emit('disconnected');assert.equal(f.latest().auto_resume.reason,'executor_disconnected');assert.equal(f.latest().status,'uncertain');await f.manager.autoResume.resume('run');assert.equal(f.adapter.sendCalls,1);
 for(const extra of [{awaiting_user:true},{cancel_requested_at:1},{ai_limit_reason:'limit'},{auto_resume_count:1}]){const candidate={...run,...extra,auto_resume:undefined};f.manager.autoResume.capture(candidate,'executor_disconnected');assert.equal(candidate.auto_resume,undefined);}
});

test('FAKE timer automatically continues a persisted interrupted run without browser subscription',async t=>{
 const f=fixture(t,{delays:[1,2,3]});for(let i=0;i<100&&f.adapter.sendCalls===0;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(f.adapter.sendCalls,1);await Promise.all([...f.manager.autoResume.active.values()]);assert.equal(f.latest().auto_resume.status,'continued');
});
test('FAKE cancellation during reconciliation cannot be overwritten by automatic continuation',async t=>{
 const f=fixture(t);const original=f.adapter.resumeThread.bind(f.adapter);let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 f.adapter.resumeThread=async()=>{entered();await gate;return original();};
 const pending=f.manager.autoResume.resume('run');await started;f.manager.cancelRun('run','permission_revoked');release();await pending;assert.equal(f.adapter.sendCalls,0);assert.equal(f.latest().auto_resume_blocked_reason,'permission_revoked');
});
test('FAKE unresolved owned command prevents automatic follow-up',async t=>{
 const f=fixture(t);const run=f.latest();run.command_items=[{id:'unresolved-command',type:'commandExecution',status:'inProgress',turn_id:'FAKE-turn'}];f.store.put('creator_run',run);await f.manager.autoResume.resume('run');assert.equal(f.adapter.sendCalls,0);assert.equal(f.latest().cleanup_status,'uncertain');assert.equal(f.latest().auto_resume.status,'pending');
});
test('FAKE temporary revocation after terminal cleanup remains binding even after access restoration',async t=>{
 const f=fixture(t);const validate=f.manager.validateSettings.bind(f.manager);let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.manager.validateSettings=async(...args)=>{entered();await gate;return validate(...args);};
 const pending=f.manager.autoResume.resume('run');await started;
 assert.equal(f.latest().status,'interrupted');assert.equal(f.latest().cleanup_status,'verified');assert.equal(f.latest().auto_resume.status,'pending');
 f.store.put('creator_project',{id:'project',members:{}});f.manager.permissionsChanged('project');
 f.store.put('creator_project',{id:'project',members:{user:'owner'}});f.manager.permissionsChanged('project');release();await pending;
 assert.equal(f.adapter.sendCalls,0);assert.equal(f.latest().auto_resume_blocked_reason,'permission_revoked');assert.equal(f.latest().auto_resume.status,'stopped');assert.equal(f.manager.runForSession('session').id,'run');
});
