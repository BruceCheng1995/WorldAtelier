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
test('FAKE manager: cancel immediately invalidates lease; terminal cannot open gate before late command cleanup',async()=>{
 const f=fixture();try{const r=await f.manager.interrupt(f.user,'session');assert.equal(r.run.status,'interrupted');assert.equal(r.run.cleanup_status,'pending');assert.ok(r.run.lease_generation>1);
 await assert.rejects(f.manager.send(f.user,'session',next),/尚未确认停止/);assert.equal(f.adapter.sendCalls,0);
 await settled(f.manager);const done=f.store.get('creator_run','run');assert.equal(done.cleanup_status,'verified');assert.equal(done.status,'interrupted');assert.deepEqual(f.adapter.terminated,['process-first']);assert.equal(done.command_items[0].status,'failed');
 const replay=await f.manager.send(f.user,'session',{text:'original goal',client_user_message_id:'original-message'});assert.equal(replay.replayed,true);assert.equal(f.adapter.sendCalls,0);
 await f.manager.send(f.user,'session',next);assert.equal(f.adapter.sendCalls,1);assert.equal(JSON.stringify(f.publicPackets).includes('FAKE test command'),false);
 }finally{await f.close();}
});
test('FAKE manager: a much later old-turn item reopens durable cleanup and gates the session',async()=>{
 const f=fixture();try{await f.manager.interrupt(f.user,'session');await settled(f.manager);const generation=f.store.get('creator_run','run').cleanup_generation;
 f.adapter.startCommand('later');assert.equal(f.store.get('creator_run','run').cleanup_status,'pending');assert.ok(f.store.get('creator_run','run').cleanup_generation>generation);await assert.rejects(f.manager.send(f.user,'session',next),/尚未确认停止/);
 await settled(f.manager);assert.equal(f.store.get('creator_run','run').cleanup_status,'verified');assert.deepEqual(f.adapter.terminated,['process-first','process-later']);
 }finally{await f.close();}
});
test('FAKE manager: unconfirmed terminate is durable uncertain; repeated cancel does not resend the goal',async()=>{
 const f=fixture();try{f.adapter.terminationSucceeds=false;await f.manager.interrupt(f.user,'session');await settled(f.manager);assert.equal(f.store.get('creator_run','run').cleanup_status,'uncertain');await assert.rejects(f.manager.send(f.user,'session',next),/尚未确认停止/);assert.equal(f.adapter.sendCalls,0);
 f.adapter.terminationSucceeds=true;const before=f.adapter.interruptCalls;await f.manager.interrupt(f.user,'session');await settled(f.manager);assert.equal(f.adapter.interruptCalls,before);assert.equal(f.store.get('creator_run','run').cleanup_status,'verified');
 }finally{await f.close();}
});
test('FAKE manager + real SQLite reopen: verified cleanup remains durable with empty thread/read items',async()=>{
 const f=fixture();let active=f.manager;try{await active.interrupt(f.user,'session');await settled(active);assert.equal(f.store.get('creator_run','run').cleanup_status,'verified');const restarted=await f.restart();active=restarted.manager;
 assert.equal(f.store.get('creator_run','run').status,'interrupted');assert.equal(f.store.get('creator_run','run').cleanup_status,'verified');assert.equal(active.cleanupBlocked('session').length,0);
 const result=await active.reconcile(f.user,'session');assert.equal(result.reconciliation.canSend,true);assert.equal(result.reconciliation.uncertain,false);assert.equal(f.store.get('creator_run','run').cleanup_status,'verified');assert.equal(restarted.adapter.sendCalls,0);
 }finally{await f.close(active);}
});
test('FAKE manager: unrelated background terminal survives cancellation',async()=>{
 const f=fixture();try{f.adapter.entries.push({itemId:'older-command',processId:'preserved',cwd:'/fake/private-session',turnId:'older-turn'});await f.manager.interrupt(f.user,'session');await settled(f.manager);assert.equal(f.store.get('creator_run','run').cleanup_status,'verified');assert.ok(f.adapter.entries.some(e=>e.processId==='preserved'));assert.equal(f.adapter.terminated.includes('preserved'),false);
 }finally{await f.close();}
});
