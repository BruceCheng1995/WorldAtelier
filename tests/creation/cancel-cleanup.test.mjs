/** FAKE protocol boundary probes. These do not run Codex or validate real OS exit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { drainCancelledTurn } from '../../services/creation/cancel-cleanup.mjs';
import { CodexAgent } from '../../services/creation/codex-agent.mjs';

const item = (id='current',extra={})=>({type:'commandExecution',id,processId:'executor-'+id,cwd:'/probe',status:'inProgress',...extra});
class FakeAdapter extends EventEmitter {
  constructor(){super();this.items=[];this.entries=[];this.killed=[];this.lists=0;this.turnStatus='interrupted';}
  async readThread(){return {thread:{id:'thread',turns:[{id:'turn',status:this.turnStatus,items:this.items}]}};}
  async listBackgroundTerminals(){this.lists++;return {data:this.entries,nextCursor:null};}
  async terminateBackgroundTerminal(threadId,processId){this.killed.push({threadId,processId});this.entries=this.entries.filter(e=>e.processId!==processId);return {terminated:true};}
  start(i,turnId='turn',threadId='thread'){this.emit('notification',{method:'item/started',params:{threadId,turnId,item:i}});}
  complete(i){this.emit('notification',{method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{...i,status:'failed',exitCode:-1}}});}
}
const options={threadId:'thread',turnId:'turn',timeoutMs:500,quietMs:45,pollIntervalMs:8};
test('FAKE: official wrappers send executor IDs and exact schema, not OS kills',async()=>{
 const agent=Object.create(CodexAgent.prototype),calls=[];agent._rpc=async(...args)=>{calls.push(args);return {data:[],nextCursor:null};};
 await agent.listBackgroundTerminals('thread',{cursor:'page',limit:7,timeoutMs:30});await agent.terminateBackgroundTerminal('thread','17577',{timeoutMs:30});
 assert.deepEqual(calls[0],['thread/backgroundTerminals/list',{threadId:'thread',cursor:'page',limit:7},{timeoutMs:30}]);
 assert.deepEqual(calls[1],['thread/backgroundTerminals/terminate',{threadId:'thread',processId:'17577'},{timeoutMs:30}]);
});
test('FAKE: terminal-before-start race is caught; old turn and other thread survive',async()=>{
 const a=new FakeAdapter(),i=item(),old=item('older'),foreign=item('foreign');a.entries=[{itemId:old.id,...old},{itemId:foreign.id,...foreign}];
 const p=drainCancelledTurn(a,options);setTimeout(()=>{a.start(old,'older-turn');a.start(foreign,'turn','other-thread');a.entries.push({itemId:i.id,...i});a.start(i);},20);
 const r=await p;assert.equal(r.status,'verified');assert.deepEqual(a.killed,[{threadId:'thread',processId:i.processId}]);assert.equal(a.entries.length,2);assert.equal(a.listenerCount('notification'),0);
});
test('FAKE: thread/read restores exact item ownership and confirms natural completion',async()=>{
 const a=new FakeAdapter();a.items=[item('finished',{status:'completed',exitCode:0})];const r=await drainCancelledTurn(a,options);assert.equal(r.status,'verified');assert.equal(a.killed.length,0);assert.ok(a.lists>1);
});
test('FAKE: all list pages inspected, exact persisted item IDs only',async()=>{
 const a=new FakeAdapter(),i=item();let live=true;a.listBackgroundTerminals=async(_t,{cursor})=>cursor?{data:live?[{itemId:i.id,...i}]:[],nextCursor:null}:{data:[{itemId:'unrelated',processId:'not-ours'}],nextCursor:'second'};
 a.terminateBackgroundTerminal=async(t,p)=>{a.killed.push(p);live=false;return {terminated:true};};
 const r=await drainCancelledTurn(a,{...options,knownItemIds:['current']});assert.equal(r.status,'verified');assert.deepEqual(a.killed,[i.processId]);
});
test('FAKE: known running command missing from registry remains uncertain',async()=>{
 const a=new FakeAdapter();const r=await drainCancelledTurn(a,{...options,knownItemIds:['missing'],timeoutMs:65});assert.equal(r.status,'uncertain');assert.equal(a.killed.length,0);
});
test('FAKE: terminate false is not success or blindly repeated; completion can reconcile',async()=>{
 const a=new FakeAdapter(),i=item();a.items=[i];a.entries=[{itemId:i.id,...i}];a.terminateBackgroundTerminal=async()=>{a.killed.push('attempt');return {terminated:false};};
 const r=await drainCancelledTurn(a,{...options,timeoutMs:70});assert.equal(r.status,'uncertain');assert.deepEqual(a.killed,['attempt']);
});
test('FAKE: official confirmation alone cannot hide a still-listed terminal',async()=>{
 const a=new FakeAdapter(),i=item();a.items=[i];a.entries=[{itemId:i.id,...i}];a.terminateBackgroundTerminal=async()=>({terminated:true});
 const r=await drainCancelledTurn(a,{...options,timeoutMs:70});assert.equal(r.status,'uncertain');assert.deepEqual(r.remainingOwnedItemIds,['current']);
});
test('FAKE: disconnect and missing turn terminal cannot release the next-turn gate',async()=>{
 const a=new FakeAdapter();const p=drainCancelledTurn(a,options);setTimeout(()=>a.emit('disconnected'),10);assert.equal((await p).status,'uncertain');
 const b=new FakeAdapter();b.turnStatus='inProgress';assert.equal((await drainCancelledTurn(b,{...options,timeoutMs:60})).reason,'turn_terminal_unconfirmed');
});
test('FAKE: mismatched process identity, RPC timeout, and audit failure are uncertain',async()=>{
 const a=new FakeAdapter(),i=item();a.items=[i];a.entries=[{itemId:i.id,...i,processId:'replacement'}];assert.equal((await drainCancelledTurn(a,options)).status,'uncertain');assert.equal(a.killed.length,0);
 const b=new FakeAdapter();b.listBackgroundTerminals=()=>new Promise(()=>{});assert.equal((await drainCancelledTurn(b,{...options,timeoutMs:35})).status,'uncertain');
 const c=new FakeAdapter();assert.equal((await drainCancelledTurn(c,{...options,onEvent(){throw Error('disk full');}})).status,'uncertain');
});
