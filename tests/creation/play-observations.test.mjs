import test from 'node:test';
import assert from 'node:assert/strict';
import {contextFixture} from './play-context-fixture.mjs';

test('play capture persists immutable runtime evidence, exact source references and actual image attachments',t=>{
  const f=contextFixture(t),head=f.store.branchFor(f.owner,f.p,'main').head,input=f.capture();
  const result=f.service.observations.capture(f.owner,f.session.id,input),observation=f.service.observations.get(f.owner,f.session.id,result.observation_id);
  assert.equal(observation.snapshot.objects[0].mapping,'exact_source');assert.deepEqual(observation.snapshot.objects[0].position,[3,0,0]);assert.deepEqual(observation.snapshot.objects[0].source_reference.source_pose.world_matrix.slice(12,15),[0,0,0]);
  assert.equal(observation.provenance.authority,'not_authoritative');assert.equal(observation.frames[0].data_url,undefined);
  assert.equal(result.session.draft_attachments.filter(a=>a.kind==='image').length,1);assert.equal(result.session.draft_attachments.filter(a=>a.kind==='play_observation').length,1);
  assert.equal(f.store.branchFor(f.owner,f.p,'main').head,head);assert.equal(f.store.list('creator_run').length,0);
  input.snapshot.objects[0].position=[99,99,99];assert.deepEqual(f.service.observations.get(f.owner,f.session.id,result.observation_id).snapshot.objects[0].position,[3,0,0]);
});
test('same request replays once, changed payload is rejected and unauthorized roles cannot upload or read',t=>{
  const f=contextFixture(t),input=f.capture(),first=f.service.observations.capture(f.owner,f.session.id,input),count=first.session.draft_attachments.length;
  assert.equal(f.service.observations.capture(f.owner,f.session.id,input).replayed,true);assert.equal(f.store.sessionFor(f.owner,f.session.id).draft_attachments.length,count);
  assert.throws(()=>f.service.observations.capture(f.owner,f.session.id,{...input,focus:{kind:'none'}}),{status:409});
  for(const user of [f.other,f.viewer]){assert.throws(()=>f.service.observations.capture(user,f.session.id,f.capture()),{status:403});assert.throws(()=>f.service.observations.read(user,f.session.id,first.observation_id),{status:403});}
});
test('fixed build, project, branch and resource mismatch cannot be laundered as an observation',t=>{
  const f=contextFixture(t);
  for(const patch of [{branch_id:'other'},{source_revision:'wrong'},{build_id:'wrong'},{resource_id:'missing'},{canonical_identity:'wrong'}])assert.throws(()=>f.service.observations.capture(f.owner,f.session.id,f.capture({scope:{...f.scope,...patch}})));
  assert.equal(f.store.list('creator_play_observation').length,0);
});
test('dynamic origin is optional and names never become source addresses',t=>{
  const f=contextFixture(t),input=f.capture({snapshot:{objects:[
    {runtime_id:'a',name:'Door',source:{}},
    {runtime_id:'b',name:'Door',source:{prefab_path:'res://door.tscn',definition_node_id:'door'}},
    {runtime_id:'c',name:'Door',source:{address:{...f.row.address,definition_node_id:'nonexistent'},object_version:'door-v1'}},
  ]}});
  const result=f.service.observations.capture(f.owner,f.session.id,input),rows=f.service.observations.read(f.owner,f.session.id,result.observation_id,{section:'objects'}).items;
  assert.deepEqual(rows.map(row=>row.mapping),['runtime_only','spawned_from_prefab','missing_or_ambiguous']);assert.equal(rows[0].source_reference,null);assert.ok(rows.every(row=>row.write_authority===false));
});
test('read sections paginate and frame bytes are checked before materializing to the creator workspace',t=>{
  const f=contextFixture(t),result=f.service.observations.capture(f.owner,f.session.id,f.capture());
  const page=f.service.observations.read(f.owner,f.session.id,result.observation_id,{section:'objects',limit:1});assert.equal(page.items.length,1);assert.equal(page.next_cursor,null);
  const frame=f.service.observations.materializeFrame(f.owner,f.session.id,result.observation_id,'frame-one',f.data);assert.match(frame.path,/context\/play-observations/);assert.equal(frame.width,1);
});
test('live read requests create new immutable captures without changing the draft or old observation',async t=>{
  const f=contextFixture(t,{liveTimeout:1000}),original=f.service.observations.capture(f.owner,f.session.id,f.capture()),before=f.store.sessionFor(f.owner,f.session.id);
  const window=f.service.observations.register(f.owner,f.session.id,{window_id:'window-one',scope:f.scope});
  const waiting=f.service.observations.current(f.owner,f.session.id,window.handle),poll=f.service.observations.poll(f.owner,f.session.id,window.handle,window);
  assert.equal(poll.requests.length,1);
  f.service.observations.respond(f.owner,f.session.id,window.handle,{...window,request_id:poll.requests[0].id,capture:f.capture({snapshot:{objects:[],tick:250}})});
  const latest=await waiting;assert.notEqual(latest.observation_id,original.observation_id);assert.equal(latest.snapshot.tick,250);
  assert.deepEqual(f.store.sessionFor(f.owner,f.session.id),before);assert.equal(f.service.observations.get(f.owner,f.session.id,original.observation_id).snapshot.tick,120);
});
test('live handles expire on close, scene mismatch, secret mismatch and permission loss',async t=>{
  const f=contextFixture(t,{liveTimeout:1000}),window=f.service.observations.register(f.owner,f.session.id,{window_id:'window-one',scope:f.scope});
  assert.throws(()=>f.service.observations.poll(f.owner,f.session.id,window.handle,{secret:'wrong'}),{status:403});
  const waiting=f.service.observations.current(f.owner,f.session.id,window.handle);const rejected=assert.rejects(waiting,{status:410});
  f.service.observations.closeWindow(f.owner,f.session.id,window.handle,window);await rejected;
  assert.throws(()=>f.service.observations.poll(f.owner,f.session.id,window.handle,window),{status:410});
});
test('silent current windows time out and never replay gameplay input',async t=>{
  const f=contextFixture(t,{liveTimeout:20}),window=f.service.observations.register(f.owner,f.session.id,{window_id:'window-one',scope:f.scope});
  await assert.rejects(f.service.observations.current(f.owner,f.session.id,window.handle),{status:408});assert.equal(f.store.list('creator_play_observation').length,0);
});
