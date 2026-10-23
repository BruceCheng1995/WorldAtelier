import test from 'node:test';
import assert from 'node:assert/strict';
import {contextFixture} from './play-context-fixture.mjs';

function prepare(f){
  const branch=f.store.fork(f.owner,f.p,{from_branch:'main',branch_id:'night',name:'Night',expected_head:f.revision.id});
  const observed=f.service.observations.capture(f.owner,f.session.id,f.capture());
  const first=f.store.appendMessage(f.session.id,{role:'user',content:'Make this door open.',attachments:observed.session.draft_attachments});
  f.store.appendMessage(f.session.id,{role:'assistant',content:'Unfinished work remains.',attachments:[]});
  const source=f.store.sessionFor(f.owner,f.session.id);source.draft='Private unsent request';source.draft_attachments=[];source.executor_thread_id='do-not-move-thread';f.store.put('creator_session',source);
  return {branch,first,observed,input:{request_id:'continue-one',target_branch_id:'night',expected_target_head:branch.head,cutoff_message_id:first.id,objective:'Continue making the door open here.'}};
}
test('continuing creates a private distinct session with fixed cutoff and does not transfer drafts, runs or authority',t=>{
  const f=contextFixture(t),p=prepare(f),before=f.store.sessionView(f.owner,f.session.id),result=f.service.continuations.create(f.owner,f.session.id,p.input);
  assert.notEqual(result.session.id,f.session.id);assert.equal(result.session.visibility,'private');assert.equal(result.session.branch_id,'night');assert.equal(result.session.executor_thread_id,null);assert.equal(result.session.draft,p.input.objective);assert.deepEqual(result.session.runs,[]);
  assert.deepEqual(f.store.sessionView(f.owner,f.session.id),before);const messages=f.service.continuations.read(f.owner,result.session.id,{section:'messages'});
  assert.equal(messages.items.length,1);assert.equal(messages.items[0].content,'Make this door open.');assert.equal(messages.items[0].source_session_id,f.session.id);assert.equal(messages.items[0].attachments[0].branch_id,'main');
  assert.equal(result.session.draft_attachments[0].branch_id,'night','wrapper belongs to target, historical messages retain original scope');
});
test('historical source edits and new messages never drift the captured context',t=>{
  const f=contextFixture(t),p=prepare(f),result=f.service.continuations.create(f.owner,f.session.id,p.input),before=f.service.continuations.read(f.owner,result.session.id,{section:'messages'});
  f.store.appendMessage(f.session.id,{role:'user',content:'Later instruction',attachments:[]});f.store.updateSession(f.owner,f.session.id,{title:'Renamed source'});
  assert.deepEqual(f.service.continuations.read(f.owner,result.session.id,{section:'messages'}),before);
});
test('continuation requests are idempotent, fixed-target and owner-only',t=>{
  const f=contextFixture(t),p=prepare(f),first=f.service.continuations.create(f.owner,f.session.id,p.input);
  assert.equal(f.service.continuations.create(f.owner,f.session.id,p.input).session.id,first.session.id);
  assert.throws(()=>f.service.continuations.create(f.owner,f.session.id,{...p.input,objective:'Different'}),{status:409});
  assert.throws(()=>f.service.continuations.create(f.other,f.session.id,{...p.input,request_id:'other'}),{status:403});
  assert.throws(()=>f.service.continuations.create(f.owner,f.session.id,{...p.input,request_id:'stale',expected_target_head:'old'}),{status:409});
  assert.throws(()=>f.service.continuations.read(f.other,first.session.id),{status:403});
});
test('same stable addresses map while changed versions and deleted resources remain explicit',t=>{
  const f=contextFixture(t),p=prepare(f),first=f.service.continuations.create(f.owner,f.session.id,p.input),mapping=f.service.continuations.read(f.owner,first.session.id,{section:'mapping'}).items;
  assert.ok(mapping.some(m=>m.status==='same'));assert.ok(mapping.every(m=>!m.target||m.target.address.branch_id==='night'));
  const manifest=structuredClone(f.revision.manifest);manifest.resources.room.native_nodes[0].version='door-v2';
  const revision=f.store.writeRevision(f.p,[p.branch.head],manifest,f.owner.id);f.store.put('creator_branch',{...p.branch,head:revision.id});
  const second=f.service.continuations.create(f.owner,f.session.id,{...p.input,request_id:'continue-two',expected_target_head:revision.id});
  assert.ok(f.service.continuations.read(f.owner,second.session.id,{section:'mapping'}).items.some(m=>m.status==='changed'));
});
test('source private history remains protected even if target is explicitly shared later',t=>{
  const f=contextFixture(t),p=prepare(f),result=f.service.continuations.create(f.owner,f.session.id,p.input);f.store.updateSession(f.owner,result.session.id,{visibility:'shared'});
  assert.throws(()=>f.service.continuations.read(f.other,result.session.id,{section:'messages'}),{status:403});
});
test('explicit empty observation selection excludes private frames and observations from the continuation',t=>{
  const f=contextFixture(t),p=prepare(f),result=f.service.continuations.create(f.owner,f.session.id,{...p.input,observation_ids:[]});
  assert.deepEqual(result.context.observation_ids,[]);const messages=f.service.continuations.read(f.owner,result.session.id,{section:'messages'}).items;
  assert.ok(messages[0].attachments.every(a=>a.excluded===true));assert.ok(messages[0].attachments.every(a=>!a.sha256&&!a.observation_id));
  assert.throws(()=>f.service.continuations.read(f.owner,result.session.id,{section:'observations',observation_id:p.observed.observation_id}),{status:403});
});
