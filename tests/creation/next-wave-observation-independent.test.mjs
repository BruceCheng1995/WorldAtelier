/** Independent N/A tests against real SQLite/source blobs and product classes.
 * Capture packets and build/native indexes are explicit fixtures. No real
 * window, Godot telemetry or model understanding is claimed by these tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationService} from '../../services/creation/service.mjs';
import {PlayContextBuffer} from '../../apps/creation-workspace/play-context-buffer.js';
import {normalizePlayCapture,samePlayContext} from '../../packages/contracts/play-context.mjs';
import {assetFixturePNG} from './asset-test-fixtures.mjs';
import {seedRuntimeFixture} from './next-wave-runtime-fixture.mjs';
import {ROOT,ORIGIN} from './next-wave-test-support.mjs';

function fixture(t){
  const data=mkdtempSync(join(tmpdir(),'atelier-next-wave-observation-')),creation=join(data,'creation'),seed=seedRuntimeFixture(creation,{name:'observation'}),server=createServer();
  const saved={agent:process.env.WORLD_ATELIER_DISABLE_AGENT,worlds:process.env.WORLD_ATELIER_DISABLE_WORLDS};let service;
  try{process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';service=new CreationService({server,root:ROOT,data:creation,origin:ORIGIN,publicPlay:true});}
  finally{for(const [key,value] of [['WORLD_ATELIER_DISABLE_AGENT',saved.agent],['WORLD_ATELIER_DISABLE_WORLDS',saved.worlds]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
  service.observations.liveTimeout=100;
  t.after(async()=>{await service.close();server.close();rmSync(data,{recursive:true,force:true});});
  const owner=seed.accounts.owner.user,other=seed.accounts.editor.user,viewer=seed.accounts.viewer.user,store=service.store,p=seed.project_id;
  const session=store.createSession(owner,p,'main',{title:'Independent private observations',visibility:'private'});
  const scope={project_id:p,branch_id:'main',source_revision:seed.job.source_revision,build_id:seed.job.id,canonical_identity:seed.job.canonical_identity,runtime_instance_id:'independent-run-1',resource_id:'entry',scene_generation:1,session_kind:'local_preview'};
  let serial=0;
  const capture=(patch={})=>({protocol:'wa-play-context-1',request_id:'independent-capture-'+(++serial),scope:{...scope},captured_at:Date.now(),window:{requested_seconds:60,start_ms:1000,end_ms:61000},
    events:[{id:'input-1',at_ms:5000,kind:'pointer_down',source:'user_input',resource_id:'entry',scene_generation:1,payload:{button:1,position:[0.4,0.5]}}],
    snapshot:{objects:[{runtime_id:'runtime-door',name:'Door',observed_values:{open:false}}],tick:120},focus:{kind:'screen_region',rect:[0.2,0.2,0.3,0.4],runtime_ids:['runtime-door']},frames:[],gaps:[],...patch});
  const frame={id:'frame-1',at_ms:60000,captured_at:Date.now(),resource_id:'entry',scene_generation:1,data_url:'data:image/png;base64,'+assetFixturePNG(2).toString('base64')};
  return{...seed,data,service,store,owner,other,viewer,p,session,scope,capture,frame};
}

test('O05 capture and retries freeze evidence without moving source, starting an Agent or duplicating frames',t=>{
  const f=fixture(t),before=f.store.branchFor(f.owner,f.p,'main').head,input=f.capture({frames:[f.frame]});
  const result=f.service.observations.capture(f.owner,f.session.id,input),stored=f.service.observations.get(f.owner,f.session.id,result.observation_id),draft=f.store.sessionFor(f.owner,f.session.id).draft_attachments;
  assert.equal(stored.provenance.authority,'not_authoritative');assert.equal(stored.snapshot.objects[0].mapping,'runtime_only');assert.equal(stored.snapshot.objects[0].source_reference,null);
  assert.equal(draft.filter(a=>a.kind==='play_observation').length,1);assert.equal(draft.filter(a=>a.kind==='image').length,1);
  assert.equal(f.service.observations.capture(f.owner,f.session.id,input).replayed,true);assert.deepEqual(f.store.sessionFor(f.owner,f.session.id).draft_attachments,draft);
  assert.throws(()=>f.service.observations.capture(f.owner,f.session.id,{...input,focus:{kind:'none'}}),error=>error.status===409);
  input.snapshot.objects[0].observed_values.open=true;assert.equal(f.service.observations.get(f.owner,f.session.id,result.observation_id).snapshot.objects[0].observed_values.open,false);
  assert.equal(f.store.branchFor(f.owner,f.p,'main').head,before);assert.equal(f.store.list('creator_run').length,0);
});

test('O05 repeated frame IDs cannot create ambiguous historical focus/image references',t=>{
  const f=fixture(t),input=f.capture({frames:[f.frame,{...f.frame,at_ms:61000}],focus:{kind:'screen_point',point:[0.3,0.4],frame_id:f.frame.id}});
  assert.throws(()=>f.service.observations.capture(f.owner,f.session.id,input),error=>error.status===422);
  assert.equal(f.store.list('creator_play_observation').length,0);
});

test('O04 private evidence and original frame bytes remain unreadable to other creators and players',t=>{
  const f=fixture(t),saved=f.service.observations.capture(f.owner,f.session.id,f.capture({frames:[f.frame]}));
  for(const user of [f.other,f.viewer,f.accounts.player.user]){
    assert.throws(()=>f.service.observations.read(user,f.session.id,saved.observation_id,{section:'events'}),error=>error.status===403);
    assert.throws(()=>f.service.observations.image(user,f.session.id,saved.observation_id,f.frame.id),error=>error.status===403);
  }
  const own=f.service.observations.image(f.owner,f.session.id,saved.observation_id,f.frame.id);assert.deepEqual(own.bytes,assetFixturePNG(2));
});

test('O06 an unauthorized handle request has no invalidation side effect on its rightful owner',t=>{
  const f=fixture(t),window=f.service.observations.register(f.owner,f.session.id,{window_id:'window-one',scope:f.scope});
  assert.throws(()=>f.service.observations.poll(f.other,f.session.id,window.handle,{secret:window.secret}),error=>[403,404,410].includes(error.status));
  assert.doesNotThrow(()=>f.service.observations.poll(f.owner,f.session.id,window.handle,{secret:window.secret}));
});

test('O06 malformed same-character-length UTF-8 secrets are ordinary 403 failures',t=>{
  const f=fixture(t),window=f.service.observations.register(f.owner,f.session.id,{window_id:'window-one',scope:f.scope});
  assert.throws(()=>f.service.observations.poll(f.owner,f.session.id,window.handle,{secret:'é'.repeat(window.secret.length)}),error=>error.status===403);
  assert.doesNotThrow(()=>f.service.observations.poll(f.owner,f.session.id,window.handle,window));
});

test('O06 rebinding one browser window to a new generation immediately invalidates old reads',async t=>{
  const f=fixture(t),old=f.service.observations.register(f.owner,f.session.id,{window_id:'same-browser-window',scope:f.scope});
  const waiting=f.service.observations.current(f.owner,f.session.id,old.handle),outcome=waiting.then(value=>({status:200,value}),error=>error);
  const fresh=f.service.observations.register(f.owner,f.session.id,{window_id:'same-browser-window',scope:{...f.scope,scene_generation:2}});
  assert.notEqual(fresh.handle,old.handle);
  assert.throws(()=>f.service.observations.poll(f.owner,f.session.id,old.handle,old),error=>error.status===410);
  assert.equal((await outcome).status,410);
});

test('O06 rebinding one window into another session revokes the former session handle',t=>{
  const f=fixture(t),old=f.service.observations.register(f.owner,f.session.id,{window_id:'same-browser-window',scope:f.scope}),next=f.store.createSession(f.owner,f.p,'main',{title:'Second private session',visibility:'private'});
  f.service.observations.register(f.owner,next.id,{window_id:'same-browser-window',scope:f.scope});
  assert.throws(()=>f.service.observations.poll(f.owner,f.session.id,old.handle,old),error=>error.status===410);
});

test('O06 a shared-authority epoch change cannot be treated as the same observation context',t=>{
  const f=fixture(t),a={...f.scope,session_kind:'shared_world',world_id:'world-one',epoch:1},b={...a,epoch:2};
  assert.equal(samePlayContext(a,b),false);assert.equal(samePlayContext(a,b,{scene:false}),false);
  const old=f.service.observations.register(f.owner,f.session.id,{window_id:'shared-window',scope:a});
  const fresh=f.service.observations.register(f.owner,f.session.id,{window_id:'shared-window',scope:b});assert.notEqual(old.handle,fresh.handle);
  assert.throws(()=>f.service.observations.poll(f.owner,f.session.id,old.handle,old),error=>error.status===410);
});

test('O06 current observations append new immutable records without consuming the message draft',async t=>{
  const f=fixture(t),original=f.service.observations.capture(f.owner,f.session.id,f.capture()),draft=f.store.sessionFor(f.owner,f.session.id),window=f.service.observations.register(f.owner,f.session.id,{window_id:'window',scope:f.scope});
  const current=f.service.observations.current(f.owner,f.session.id,window.handle),poll=f.service.observations.poll(f.owner,f.session.id,window.handle,window);
  f.service.observations.respond(f.owner,f.session.id,window.handle,{...window,request_id:poll.requests[0].id,capture:f.capture({snapshot:{objects:[],tick:400}})});
  const saved=await current;assert.notEqual(saved.observation_id,original.observation_id);assert.equal(saved.snapshot.tick,400);assert.deepEqual(f.store.sessionFor(f.owner,f.session.id),draft);assert.equal(f.service.observations.get(f.owner,f.session.id,original.observation_id).snapshot.tick,120);
});

const bufferScope={project_id:'project',branch_id:'main',source_revision:'source',build_id:'build',canonical_identity:'identity',runtime_instance_id:'runtime',resource_id:'A',scene_generation:1,session_kind:'local_preview'};
test('O01 one oversized event cannot remain over the local byte budget forever',()=>{
  let now=0;const buffer=new PlayContextBuffer({now:()=>now,wallNow:()=>1000,limits:{localBytes:1024,captureBytes:2048,text:100}});buffer.bind(bufferScope);
  buffer.record({kind:'author_reported',source:'author_reported',payload:{text:'x'.repeat(5000)}});
  assert.ok(buffer.bytes<=1024);assert.ok(buffer.gaps.length>0);assert.ok(JSON.stringify(buffer.freeze({requestId:'bounded'})).length<=2048);
});

test('O01 one oversized snapshot object cannot bypass all byte budgets',()=>{
  const buffer=new PlayContextBuffer({now:()=>1000,wallNow:()=>1000,limits:{localBytes:2048,captureBytes:3072,text:100}});buffer.bind(bufferScope);
  buffer.accept({type:'play_context',protocol:'wa-play-context-1',runtime_instance_id:'runtime',source_revision:'source',resource_id:'A',scene_generation:1,sequence:1,kind:'snapshot',payload:{objects:[{runtime_id:'one',name:'x'.repeat(6000)}]}});
  assert.ok(JSON.stringify(buffer.snapshot).length<=2048);assert.ok(buffer.gaps.length>0);assert.ok(JSON.stringify(buffer.freeze({requestId:'snapshot-bounded'})).length<=3072);
});

test('O01 default sixty-second cutoff and explicitly extended windows are bounded and report gaps',()=>{
  let now=0;const buffer=new PlayContextBuffer({now:()=>now,wallNow:()=>1000});buffer.bind(bufferScope);
  buffer.record({kind:'pointer_down',payload:{button:1}});now=61000;buffer.record({kind:'pointer_down',payload:{button:2}});
  let frozen=buffer.freeze({requestId:'default'});assert.equal(frozen.window.requested_seconds,60);assert.equal(frozen.events.length,1);assert.equal(frozen.events[0].payload.button,2);
  assert.throws(()=>buffer.extend(601));buffer.extend(120);now=62000;frozen=buffer.freeze({requestId:'extended'});assert.equal(frozen.window.requested_seconds,120);assert.ok(frozen.gaps.length>0,'Cannot claim previously discarded events were recovered by extending.');
});

test('O06 local buffer drops old-authority material when its shared epoch changes',()=>{
  const buffer=new PlayContextBuffer({now:()=>1000,wallNow:()=>1000}),first={...bufferScope,session_kind:'shared_world',world_id:'world',epoch:1};
  buffer.bind(first);buffer.record({kind:'pointer_down',payload:{button:1}});buffer.bind({...first,epoch:2});assert.equal(buffer.events.length,0);
});

function continuationFixture(f){
  const branch=f.store.fork(f.owner,f.p,{from_branch:'main',branch_id:'night',name:'Night',expected_head:f.job.source_revision});
  const saved=f.service.observations.capture(f.owner,f.session.id,f.capture({frames:[f.frame]}));
  const first=f.store.appendMessage(f.session.id,{role:'user',content:'Private sent intention',attachments:saved.session.draft_attachments});
  f.store.appendMessage(f.session.id,{role:'assistant',content:'Historical assistant result',attachments:[]});
  const source=f.store.sessionFor(f.owner,f.session.id);source.draft='DO NOT COPY UNSENT PRIVATE DRAFT';source.executor_thread_id='original-thread';source.draft_attachments=[];f.store.put('creator_session',source);
  return{branch,saved,first,input:{request_id:'independent-continuation',target_branch_id:'night',expected_target_head:branch.head,cutoff_message_id:first.id,objective:'Continue the sent goal here'}};
}

test('X01 continuation fixes the historical cutoff without rebinding source execution or drafts',t=>{
  const f=fixture(t),p=continuationFixture(f),before=f.store.sessionView(f.owner,f.session.id),result=f.service.continuations.create(f.owner,f.session.id,p.input);
  assert.equal(result.session.visibility,'private');assert.equal(result.session.branch_id,'night');assert.equal(result.session.executor_thread_id,null);assert.deepEqual(f.store.sessionView(f.owner,f.session.id),before);
  const history=f.service.continuations.read(f.owner,result.session.id,{section:'messages'});assert.equal(history.items.length,1);assert.equal(history.items[0].content,'Private sent intention');assert.equal(history.items[0].attachments[0].branch_id,'main');
  f.store.appendMessage(f.session.id,{role:'user',content:'Later must not drift',attachments:[]});assert.deepEqual(f.service.continuations.read(f.owner,result.session.id,{section:'messages'}),history);
});

test('X02 explicitly selecting zero observations does not silently carry all source captures',t=>{
  const f=fixture(t),p=continuationFixture(f),result=f.service.continuations.create(f.owner,f.session.id,{...p.input,observation_ids:[]});
  const summary=f.service.continuations.read(f.owner,result.session.id);assert.deepEqual(summary.observation_ids,[]);
  assert.throws(()=>f.service.continuations.read(f.owner,result.session.id,{section:'observations',observation_id:p.saved.observation_id}),error=>error.status===403);
});

test('X02 later sharing of a target does not expose its private source messages or frames',t=>{
  const f=fixture(t),p=continuationFixture(f),result=f.service.continuations.create(f.owner,f.session.id,p.input);f.store.updateSession(f.owner,result.session.id,{visibility:'shared'});
  for(const section of ['summary','messages','mapping','observations'])assert.throws(()=>f.service.continuations.read(f.other,result.session.id,{section,observation_id:p.saved.observation_id}),error=>error.status===403);
  assert.throws(()=>f.service.observations.image(f.other,f.session.id,p.saved.observation_id,f.frame.id),error=>error.status===403);
});

test('X03 a failed frozen-message write rolls back the new session, context and idempotency receipt',t=>{
  const f=fixture(t),p=continuationFixture(f),before=Object.fromEntries(['creator_session','creator_session_continuation','creator_session_continuation_receipt'].map(kind=>[kind,f.store.list(kind)])),put=f.store.put.bind(f.store);
  f.store.put=(kind,value)=>{if(kind==='creator_continuation_message')throw Error('Independent frozen-history storage failure');return put(kind,value);};
  assert.throws(()=>f.service.continuations.create(f.owner,f.session.id,p.input),/Independent frozen-history/);f.store.put=put;
  for(const [kind,rows] of Object.entries(before))assert.deepEqual(f.store.list(kind),rows);
});
