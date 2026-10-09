/** FAKE Codex protocol, real isolated SQLite persistence. No live executor or UI claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { CreationStore } from '../../services/creation/store.mjs';
import { CreationAgentRuns } from '../../services/creation/agent-runs.mjs';
import { hash } from '../../services/creation/schema.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const command=(id,extra={})=>({id,type:'commandExecution',processId:'process-'+id,cwd:'/fake/private-session',status:'inProgress',command:'FAKE test command',...extra});
class FakeAdapter extends EventEmitter {
 constructor(){super();this.connected=true;this.threads=new Map([['thread',{loaded:true,busy:true}]]);this.turns=new Map([['turn',{id:'turn',status:'inProgress',items:[]}]]);this.entries=[];this.terminated=[];this.interruptCalls=0;this.sendCalls=0;this.delayStarted=true;this.terminationSucceeds=true;}
 notification(method,params){const event={kind:'notification',method,params};this.emit('event',event);this.emit('notification',event);if(method==='turn/completed')this.emit('terminal',{threadId:params.threadId,turn:params.turn});}
 async start(){this.connected=true;}
 async listModels(){return{data:[{model:'fake-model',isDefault:true}]};}
 async accountStatus(){return{account:{type:'fake'}};}
 async readThread(){return{thread:{id:'thread',turns:[...this.turns.values()]}};}
 async resumeThread(){this.threads.set('thread',{loaded:true,busy:false});return{...await this.readThread(),reconciliation:{canSend:true,uncertain:false,matchedTurnId:'turn'}};}
 async listBackgroundTerminals(){return{data:this.entries,nextCursor:null};}
 async terminateBackgroundTerminal(_thread,processId){this.terminated.push(processId);if(!this.terminationSucceeds)return{terminated:false};const entry=this.entries.find(x=>x.processId===processId);this.entries=this.entries.filter(x=>x.processId!==processId);if(entry)this.notification('item/completed',{threadId:'thread',turnId:entry.turnId,item:command(entry.itemId,{status:'failed',exitCode:-1})});return{terminated:true};}
 async interrupt(){this.interruptCalls++;this.turns.set('turn',{id:'turn',status:'interrupted',items:[]});this.notification('turn/completed',{threadId:'thread',turn:this.turns.get('turn')});if(this.delayStarted)setTimeout(()=>this.startCommand('first'),5);return{};}
 startCommand(id,turnId='turn'){this.entries.push({itemId:id,processId:'process-'+id,cwd:'/fake/private-session',turnId});this.notification('item/started',{threadId:'thread',turnId,item:command(id)});}
 async sendTurn(){this.sendCalls++;return{turn:{id:'next',status:'inProgress'}};}
 async stop(){this.connected=false;this.emit('disconnected');}
}
function fixture(){
 const data=mkdtempSync(resolve(tmpdir(),'atelier-cancel-unit-')),file=resolve(data,'state.sqlite');let store=new CreationStore(file);
 const user={id:'user',name:'Owner',color:'#abcdef'};store.put('creator_user',user);store.put('creator_project',{id:'project',members:{user:'owner'}});store.put('creator_branch',{id:'project:main',project_id:'project',branch_id:'main',head:'rev'});store.put('creator_revision',{id:'rev',project_id:'project',manifest:{schema:'creation-flat-1',resources:{}}});
 store.put('creator_session',{id:'session',project_id:'project',branch_id:'main',owner_user_id:'user',executor_thread_id:'thread',model:'fake-model',draft:'next goal',draft_attachments:[]});
 const publicPackets=[],privatePackets=[];const service={data,root:data,origin:'http://fake.test',get store(){return store;},sessionEvent:(sid,e)=>{privatePackets.push(e);return store.appendSessionEvent(sid,e);},realtime:{development:(p,b,s)=>publicPackets.push(s)}};
 const adapter=new FakeAdapter(),options={service,adapter,cleanupOptions:{quietMs:25,pollIntervalMs:5,timeoutMs:200}};
 const manager=new CreationAgentRuns(options);manager.models=[{model:'fake-model',isDefault:true}];
 const run={id:'run',session_id:'session',project_id:'project',branch_id:'main',owner_user_id:'user',thread_id:'thread',turn_id:'turn',client_user_message_id:'original-message',input_hash:hash({text:'original goal',model:null}),status:'running',lease_generation:1,targets:[],changes:[],deliveries:[],created_at:1};store.put('creator_run',run);
 return{data,file,user,service,adapter,manager,publicPackets,privatePackets,get store(){return store;},async restart(){await manager.close();store.close();store=new CreationStore(file);const a=new FakeAdapter();a.delayStarted=false;a.turns.set('turn',{id:'turn',status:'interrupted',items:[]});a.threads.clear();const m=new CreationAgentRuns({...options,adapter:a});return{adapter:a,manager:m};},async close(m=manager){await m.close();store.close();rmSync(data,{recursive:true,force:true});}};
}
async function settled(m){for(let i=0;i<50;i++){await Promise.all([...m.cleanups.values()]);await wait(5);if(!m.cleanups.size)return;}throw Error('FAKE cleanup did not settle');}
const next={text:'next goal',client_user_message_id:'next-message'};

function delayedFixture(){
 const f=fixture();
 f.store.put('creator_run',{...f.store.get('creator_run','run'),status:'completed'});
 f.adapter.turns.set('turn',{id:'turn',status:'completed',items:[]});f.adapter.delayStarted=false;
 let release,reject,entered;const ready=new Promise(r=>entered=r),gate=new Promise((yes,no)=>{release=yes;reject=no;});
 f.adapter.sendTurn=async()=>{f.adapter.sendCalls++;const turn={id:'next',status:'inProgress',items:[]};f.adapter.turns.set('thread/next',turn);entered();await gate;return{turn};};
 f.adapter.interrupt=async(threadId,turnId)=>{f.adapter.interruptCalls++;assert.equal(threadId,'thread');assert.equal(turnId,'next');const turn={id:turnId,status:'interrupted',items:[]};f.adapter.turns.set('thread/next',turn);f.adapter.notification('turn/completed',{threadId,turn});return{};};
 const setRole=role=>{const project=f.store.get('creator_project','project');if(role)project.members.user=role;else delete project.members.user;f.store.put('creator_project',project);};
 return Object.assign(f,{ready,release,reject,setRole});
}
test('FAKE revocation: delayed bind preserves revoked lease after access restoration, blocks waiting tools and drains pre-response command',async()=>{
 const f=delayedFixture();try{
  const sent=f.manager.send(f.user,'session',next);await f.ready;
  const run=f.manager.runForSession('session');assert.equal(run.turn_id,undefined);
  const pendingTool=f.manager.dynamic({threadId:'thread',turnId:'next',scope:{sessionId:'session',userId:'user'},signal:new AbortController().signal,tool:'world_read'});
  const toolBlocked=assert.rejects(pendingTool,/所属执行已结束|租约已失效|尚未确认停止/);
  f.adapter.startCommand('pending-response','next');
  f.setRole('viewer');f.manager.permissionsChanged('project');
  const revoked=f.store.get('creator_run',run.id);assert.equal(revoked.status,'cancelling');assert.ok(revoked.lease_generation>run.lease_generation);assert.equal(f.adapter.interruptCalls,0);
  f.setRole('owner');f.release();const result=await sent;await toolBlocked;await settled(f.manager);
  assert.equal(result.run.status,'interrupted');assert.equal(f.adapter.interruptCalls,1);assert.deepEqual(f.adapter.terminated,['process-pending-response']);
  const final=f.store.get('creator_run',run.id);assert.equal(final.cleanup_status,'verified');assert.equal(final.cleanup_reason,'permission_revoked');assert.equal(final.turn_id,'next');
  assert.equal(JSON.stringify(f.publicPackets).includes('FAKE test command'),false);
 }finally{await f.close();}
});
test('FAKE revocation: permission recheck catches missing callback and does not leak removed-user session data',async()=>{
 const f=delayedFixture();try{
  const sent=f.manager.send(f.user,'session',next);const denied=assert.rejects(sent,error=>error.status===403);await f.ready;f.setRole(null);f.release();await denied;await settled(f.manager);
  const run=f.manager.runForSession('session');assert.equal(f.adapter.interruptCalls,1);assert.equal(run.status,'interrupted');assert.equal(run.cleanup_status,'verified');assert.equal(run.cleanup_reason,'permission_revoked');
 }finally{await f.close();}
});
test('FAKE revocation: RPC rejection preserves cancellation and requires reconciliation for unknown turn',async()=>{
 const f=delayedFixture();try{
  const sent=f.manager.send(f.user,'session',next);const denied=assert.rejects(sent,/FAKE uncertain RPC/);await f.ready;f.setRole('viewer');f.manager.permissionsChanged('project');f.reject(Object.assign(Error('FAKE uncertain RPC'),{uncertain:true}));await denied;
  const run=f.manager.runForSession('session');assert.equal(run.status,'cancelling');assert.equal(run.cleanup_status,'uncertain');assert.equal(run.cleanup_error,'cancelled_turn_id_unconfirmed');assert.equal(f.adapter.interruptCalls,0);
  f.setRole('owner');assert.throws(()=>f.manager.assertCleanupReady('session'),/尚未确认停止/);
 }finally{await f.close();}
});
test('FAKE revocation: starting cancellation never starts a turn and remains settled after manager restart',async()=>{
 const f=delayedFixture();let active=f.manager;try{
  const original=f.service.sessionEvent;let once=true;
  f.service.sessionEvent=(sid,event)=>{const result=original(sid,event);if(once&&event.kind==='run_state'&&event.run.status==='starting'){once=false;f.setRole('viewer');f.manager.permissionsChanged('project');}return result;};
  await assert.rejects(f.manager.send(f.user,'session',next),error=>error.status===403);
  const run=f.manager.runForSession('session');assert.equal(run.status,'interrupted');assert.equal(run.cleanup_status,'verified');assert.equal(run.cleanup_result.reason,'turn_not_submitted');assert.equal(f.adapter.sendCalls,0);assert.equal(run.turn_id,undefined);
  assert.equal(f.store.get('creator_goal',run.goal_id).status,'cancelled');f.setRole('owner');await active.close();
  active=new CreationAgentRuns({service:f.service,adapter:new FakeAdapter()});assert.equal(f.store.get('creator_run',run.id).cleanup_status,'verified');assert.doesNotThrow(()=>active.assertCleanupReady('session'));
 }finally{await f.close(active);}
});
test('FAKE revocation: context preparation cancellation cannot be promoted back to running',async()=>{
 const f=delayedFixture();try{
  const context=f.manager.environments.context.bind(f.manager.environments);
  f.manager.environments.context=options=>{const value=context(options);f.setRole('viewer');f.manager.permissionsChanged('project');f.setRole('owner');return value;};
  await assert.rejects(f.manager.send(f.user,'session',next),/已取消或发生变化/);
  const run=f.manager.runForSession('session');assert.equal(run.status,'interrupted');assert.equal(run.cleanup_status,'verified');assert.equal(f.adapter.sendCalls,0);
 }finally{await f.close();}
});
test('FAKE revocation: observed terminal before delayed response is cleaned without interrupting another turn',async()=>{
 const f=delayedFixture();try{
  const sent=f.manager.send(f.user,'session',next);await f.ready;f.setRole('viewer');f.manager.permissionsChanged('project');f.setRole('owner');
  const turn={id:'next',status:'completed',items:[]};f.adapter.turns.set('thread/next',turn);f.adapter.notification('turn/completed',{threadId:'thread',turn});f.release();await sent;await settled(f.manager);
  const run=f.manager.runForSession('session');assert.equal(run.status,'completed');assert.equal(run.cleanup_status,'verified');assert.equal(f.adapter.interruptCalls,0);assert.ok(run.cancel_requested_at);
 }finally{await f.close();}
});
test('FAKE revocation: unchanged permissions retain normal running turn and writable lease',async()=>{
 const f=delayedFixture();try{
  const sent=f.manager.send(f.user,'session',next);await f.ready;f.manager.permissionsChanged('project');f.release();const result=await sent;
  assert.equal(result.run.status,'running');assert.equal(result.run.cleanup_status,undefined);assert.equal(result.run.lease_generation,1);assert.equal(f.adapter.interruptCalls,0);
 }finally{await f.close();}
});

test('FAKE revocation: delayed reconciliation binds unknown cancelled turn without reviving its lease',async()=>{
 const f=fixture();try{
  f.store.put('creator_run',{...f.store.get('creator_run','run'),status:'uncertain',turn_id:null});f.adapter.threads.clear();f.adapter.delayStarted=false;
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.adapter.resumeThread=async()=>{entered();await gate;f.adapter.threads.set('thread',{loaded:true,busy:true});return{thread:{id:'thread',turns:[{id:'turn',status:'inProgress',items:[]}]},reconciliation:{canSend:false,matchedTurnId:'turn'}};};
  const bound=f.manager.bind(f.store.get('creator_session','session'),{reconcile:true});await ready;
  const project=f.store.get('creator_project','project');project.members.user='viewer';f.store.put('creator_project',project);f.manager.permissionsChanged('project');const generation=f.store.get('creator_run','run').lease_generation;
  project.members.user='owner';f.store.put('creator_project',project);release();await bound;await settled(f.manager);
  const run=f.store.get('creator_run','run');assert.equal(run.status,'interrupted');assert.equal(run.cleanup_status,'verified');assert.ok(run.lease_generation>generation);assert.equal(run.cleanup_reason,'permission_revoked');assert.equal(f.adapter.interruptCalls,1);
 }finally{await f.close();}
});
