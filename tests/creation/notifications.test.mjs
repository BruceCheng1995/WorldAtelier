import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationInbox} from '../../services/creation/inbox.mjs';
import {CreationNotifications} from '../../services/creation/notifications.mjs';
import {emptyDocument,prepareManifest,HIERARCHY_SCHEMA} from '../../services/creation/hierarchy.mjs';
import {hierarchyRuntimeId} from '../../services/creation/hierarchy-view.mjs';

// Focused producer-boundary tests. SQLite is real; Agent, Godot and client event
// payloads are explicitly synthetic. No running world or browser is controlled.
function fixture(t){
  const dir=mkdtempSync(resolve(tmpdir(),'atelier-notifications-')),store=new CreationStore(resolve(dir,'db.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const owner={id:'owner',name:'Owner'},editor={id:'editor',name:'Editor'};for(const user of [owner,editor])store.put('creator_user',user);
  const objects=[{id:'one',kind:'anchor'},{id:'two',kind:'anchor'}];
  const {project,branch}=store.createProject(owner,{name:'Notifications fixture'},{entry_scene_id:'room',resources:{room:{id:'room',kind:'scene',name:'Room',objects},prefab:{id:'prefab',kind:'prefab',name:'Prefab',objects:[]}}});
  const p=store.get('creator_project',project.id);p.members.editor='editor';store.put('creator_project',p);
  const session=store.createSession(owner,project.id,'main');session.executor_thread_id='development-thread';store.put('creator_session',session);
  const run={id:'run1',goal_id:'goal1',session_id:session.id,project_id:project.id,branch_id:'main',owner_user_id:owner.id,input_revision:branch.head,changes:[],targets:[{resource_id:'room',object_id:'one'}],status:'completed'};
  const goal={id:'goal1',session_id:session.id,run_id:run.id,run_ids:[run.id]};store.put('creator_run',run);store.put('creator_goal',goal);
  const errors=[],service={store,root:'/private/project',data:'/private/data',worlds:{closing:false},agent:{runForTurn:()=>run},observe(fn){try{return fn();}catch(error){errors.push(error);throw error;}}};
  service.inbox=new CreationInbox({store});const notices=new CreationNotifications({service});
  const scope={project_id:project.id,branch_id:'main',revision:branch.head,resource_id:'room',runtime_build_id:'build1'};
  const job=(changes={})=>({id:'auto1',...scope,session_id:session.id,goal_id:goal.id,run_id:run.id,actor_id:owner.id,resource_ids:['room'],targets:run.targets,reports:[],checks:[],status:'failed',created_at:100,...changes});
  const items=()=>store.list('creator_inbox_item'),open=(code)=>items().filter(i=>i.status==='open'&&i.code===code);
  return{store,owner,editor,projectId:project.id,session,run,goal,service,notices,scope,job,items,open,errors};
}
const bad=(fn,status=409)=>assert.throws(fn,e=>e.status===status);

test('notifications: canonical game checks without a shared build ID retain their actual validation identity',t=>{
  const f=fixture(t),base={...f.scope,runtime_build_id:undefined,status:'failed',error:'explicit notification fixture',game_validation_identity:{identity_hash:'a'.repeat(64)}};
  f.notices.verification({...base,id:'canonical-first'});
  f.notices.verification({...base,id:'canonical-other-runtime',game_validation_identity:{identity_hash:'b'.repeat(64)}});
  assert.equal(f.open('godot_validation').length,2);
  f.notices.verification({...base,id:'canonical-passed',status:'passed'});
  assert.equal(f.open('godot_validation').length,1);assert.equal(f.open('godot_validation')[0].runtime_build_id,'b'.repeat(64));
  assert.deepEqual(f.errors,[]);
});

test('notifications: cleanup and execution recovery have valid exact source/kind/run selectors',t=>{
  const f=fixture(t);
  f.notices.session(f.session.id,{kind:'run_state',run:{...f.run,status:'uncertain',error:'uncertain execution'}});
  f.notices.session(f.session.id,{kind:'run_state',run:{...f.run,status:'interrupted',cleanup_status:'uncertain'}});
  assert.equal(f.open('agent_execution').length,1);assert.equal(f.open('agent_cleanup').length,1);
  f.notices.session(f.session.id,{kind:'run_state',run:{...f.run,status:'interrupted',cleanup_status:'verified'}});
  assert.equal(f.open('agent_cleanup').length,0);assert.equal(f.open('agent_execution').length,1);
  f.notices.session(f.session.id,{kind:'run_state',run:f.run});
  assert.equal(f.open('agent_execution').length,0);assert.equal(f.errors.length,0);
});

test('notifications: development requests close through actual thread events and replies',t=>{
  const f=fixture(t),request={kind:'approval_request',request_key:'dev:key',method:'item/tool/requestUserInput',params:{turnId:'turn1'}};
  f.notices.session(f.session.id,request);
  assert.equal(f.open('agent_request').length,1);
  f.notices.session(f.session.id,{kind:'notification',method:'thread/closed'});
  assert.equal(f.open('agent_request').length,0);
  f.notices.session(f.session.id,{...request,request_key:'dev:key2'});f.notices.requestClosed(f.session.id,'dev:key2');
  assert.equal(f.open('agent_request').length,0);assert.equal(f.errors.length,0);
});

test('notifications: passed Godot check resolves only same run/resource/revision/build and private errors remain private',t=>{
  const f=fixture(t),failed={id:'v1',...f.scope,status:'failed',error:'parse error',origin:{run_id:f.run.id}};
  f.notices.verification(failed);
  assert.equal(f.service.inbox.list(f.editor).items.length,0,'private origin does not default to all project editors');
  f.notices.verification({...failed,id:'v-public',origin:null});
  f.notices.verification({...failed,id:'v-other-resource',resource_id:'prefab'});
  f.notices.verification({...failed,id:'v-other-build',runtime_build_id:'build2'});
  f.notices.verification({...failed,id:'v-passed',status:'passed'});
  const remaining=f.open('godot_validation');assert.equal(remaining.length,3);
  assert(remaining.some(i=>i.run_id===null));assert(remaining.some(i=>i.resource_id==='prefab'));assert(remaining.some(i=>i.runtime_build_id==='build2'));
  assert.equal(f.errors.length,0);
});

test('notifications: successful development does not rewrite a failed tool call',t=>{
  const f=fixture(t);
  f.notices.session(f.session.id,{kind:'notification',method:'item/completed',params:{turnId:'t',item:{id:'tool1',type:'commandExecution',status:'failed'}}});
  f.notices.session(f.session.id,{kind:'run_state',run:{...f.run,status:'completed'}});
  assert.equal(f.items().find(i=>i.code==='agent_tool').status,'open');
  assert.equal(f.store.list('creator_auto_verification').length,0);
});

test('notifications: per-client document recovery isolates nonce/user/build/resource and can cover loaded children',t=>{
  const f=fixture(t),base={...f.scope,code:'asset_load',client_id:'tab-a',event_id:'error-a',object_id:'one',message:'load failed'};
  f.notices.client(f.owner,base);
  f.notices.client(f.owner,{...base,client_id:'tab-b',event_id:'error-b'});
  f.notices.client(f.editor,{...base,event_id:'other-user'});
  f.notices.client(f.owner,{...base,runtime_build_id:'build2',event_id:'other-build'});
  f.notices.client(f.owner,{...base,resource_id:'prefab',object_id:undefined,event_id:'other-resource'});
  const result=f.notices.clientRecovered(f.owner,{...base,object_id:undefined});
  assert.equal(result.count,1);const remaining=f.open('asset_load');assert.equal(remaining.length,4);
  assert(remaining.some(i=>i.client_id==='tab-b'));assert(remaining.some(i=>i.recipient_user_ids[0]===f.editor.id));assert(remaining.some(i=>i.runtime_build_id==='build2'));assert(remaining.some(i=>i.resource_id==='prefab'));
  assert.equal(f.notices.clientRecovered(f.owner,{...base,client_id:undefined,object_id:undefined}).count,0,'legacy null nonce cannot clear a different tab');
  bad(()=>f.notices.client(f.owner,{...base,event_id:'long',client_id:'x'.repeat(161)}),400);
});

test('notifications: fixed flat targets reject forged/mismatched addresses and source changes do not rebind them',t=>{
  const f=fixture(t),base={...f.scope,code:'asset_load',event_id:'client1',client_id:'tab',message:'load failed'};
  bad(()=>f.notices.client(f.owner,{...base,object_id:'missing'}));
  const address={project_id:f.projectId,branch_id:'main',resource_id:'room',instance_path:[],definition_node_id:'one'};
  const result=f.notices.client(f.owner,{...base,address});assert.deepEqual(result.item.targets[0].address,address);
  bad(()=>f.notices.client(f.owner,{...base,event_id:'forged',address:{...address,definition_node_id:'missing'}}));
  bad(()=>f.notices.client(f.owner,{...base,event_id:'mismatch',address,object_id:'two'}));
  bad(()=>f.notices.client(f.owner,{...base,event_id:'branch',address:{...address,branch_id:'other'}}));
  const branch=f.store.branchFor(f.owner,f.projectId,'main'),manifest=structuredClone(f.store.get('creator_revision',branch.head).manifest);manifest.resources.room.objects=manifest.resources.room.objects.filter(o=>o.id!=='one');
  const next=f.store.writeRevision(f.projectId,[branch.head],manifest,f.owner.id);f.store.put('creator_branch',{...branch,head:next.id});
  assert.equal(f.notices.client(f.owner,{...base,event_id:'old-pinned',address}).item.revision,f.scope.revision);
  bad(()=>f.notices.client(f.owner,{...base,event_id:'new-missing',revision:next.id,address}));
});

test('notifications: hierarchy runtime IDs and full instance paths resolve against the pinned manifest',t=>{
  const f=fixture(t),prefab=emptyDocument('prefab','prefab'),room=emptyDocument('room');
  let manifest=prepareManifest({schema:HIERARCHY_SCHEMA,entry_scene_id:'room',resources:{room,prefab},prefab_revisions:{}},()=>true);
  for(const instance_id of ['a','b'])manifest.resources.room.instances[instance_id]={instance_id,prefab_id:'prefab',prefab_revision:manifest.resources.prefab.version,parent_id:'root',transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},overrides:[]};
  manifest=prepareManifest(manifest,()=>true);const branch=f.store.branchFor(f.owner,f.projectId,'main'),revision=f.store.writeRevision(f.projectId,[branch.head],manifest,f.owner.id);f.store.put('creator_branch',{...branch,head:revision.id});
  const address={project_id:f.projectId,branch_id:'main',resource_id:'room',instance_path:['a'],definition_node_id:'root'},base={...f.scope,revision:revision.id,client_id:'tab',code:'asset_load',event_id:'hierarchy',message:'synthetic failure'};
  const one=f.notices.client(f.owner,{...base,object_id:hierarchyRuntimeId(address)});assert.deepEqual(one.item.targets[0].address,address);
  const two=f.notices.client(f.owner,{...base,event_id:'second',address:{...address,instance_path:['b']}});assert.notEqual(one.item.id,two.item.id);
  bad(()=>f.notices.client(f.owner,{...base,event_id:'fake',address:{...address,instance_path:['missing']}}));
  f.notices.clientRecovered(f.owner,{...base,address});assert.equal(f.open('asset_load').length,1);assert.equal(f.open('asset_load')[0].id,two.item.id);
});

test('notifications: real world-ready boundary only resolves connection failures for its recovered epochs',t=>{
  const f=fixture(t),world={...f.scope,id:'world1',epoch:1};f.store.put('creator_world',{...world});
  f.notices.world(world,{id:'connection1',kind:'infrastructure',message:'connection lost'});
  f.notices.world(world,{id:'behavior1',kind:'behavior',message:'script failed',runtime_fault:{object_id:'one'}});
  f.notices.world({...world,epoch:3},{id:'future',kind:'infrastructure',message:'future failure'});
  f.notices.worldReady({...world,epoch:2});
  assert.equal(f.open('world_connection').length,1);assert.equal(f.open('world_connection')[0].epoch,3);assert.equal(f.open('world_behavior').length,1);
  const before=f.items().length;
  f.notices.world(world,{id:'shutdown',kind:'infrastructure',message:'stop'},{notify:false});
  f.service.worlds.closing=true;f.notices.world(world,{id:'closing',kind:'infrastructure',message:'stop'});
  assert.equal(f.items().length,before);
});

test('notifications: Godot event envelopes retain every actual object and diagnostic in the pinned world',t=>{
  const f=fixture(t),world={...f.scope,id:'world-wrapped',epoch:4};f.store.put('creator_world',world);
  f.notices.world(world,{id:'wrapped-fault',kind:'behavior',message:'Runtime behavior failed',runtime_fault:[
    {kind:'runtime_fault',data:{object_id:'one',component_id:'script-one',error:'first actual fault'}},
    {kind:'runtime_fault',data:{object_id:'two',component_id:'script-two',error:'second actual fault'}},
  ]});
  const [item]=f.open('world_behavior');
  assert.deepEqual(item.targets.map(target=>target.object_id).sort(),['one','two']);
  assert.equal(item.world_id,world.id);assert.equal(item.epoch,4);assert.equal(item.revision,f.scope.revision);
  assert.match(item.message,/first actual fault/);assert.match(item.message,/second actual fault/);
  assert.equal(f.errors.length,0);
});

test('notifications: empty and sensitive messages remain nonempty, and build success closes only its job error',t=>{
  const f=fixture(t),job={id:'build1',project_id:f.projectId,branch_id:'main',source_revision:f.scope.revision,actor_id:f.owner.id,status:'failed',error:'  '};
  f.notices.build(job);f.notices.build({...job,id:'build2'});f.notices.build({...job,status:'completed',target_results:[],error:null});
  const errors=f.open('build_result').filter(i=>i.kind==='error');assert.equal(errors.length,1);assert.equal(errors[0].job_id,'build2');
  assert(f.items().every(i=>i.message.trim()));
  const message=f.notices.clean('/private/data/file ?token=SECRET&cap=ALSO /private/project/path');
  assert(!message.includes('SECRET'));assert(!message.includes('ALSO'));assert(!message.includes('/private/'));
  assert.equal(f.errors.length,0);
});

test('notifications: removing a target document does not lose the Agent failure notification',t=>{
  const f=fixture(t),branch=f.store.branchFor(f.owner,f.projectId,'main'),manifest=structuredClone(f.store.get('creator_revision',branch.head).manifest);
  delete manifest.resources.prefab;
  const next=f.store.writeRevision(f.projectId,[branch.head],manifest,f.owner.id);f.store.put('creator_branch',{...branch,head:next.id});
  const run={...f.run,changes:[next.id],targets:[{resource_id:'prefab',object_id:'removed'}],status:'failed',error:'Failed after deleting prefab'};f.store.put('creator_run',run);
  f.notices.session(f.session.id,{kind:'run_state',run});
  assert.equal(f.open('agent_execution').length,1);assert.deepEqual(f.open('agent_execution')[0].targets,[]);
});
