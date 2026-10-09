/**
 * Independent annotation contracts using the actual store, spatial resolution,
 * inspection attachment builder and send paths. SQLite/workspaces are temporary.
 * Rendered observations, executor and RPC transport are explicit FAKE fixtures;
 * this suite does not claim a real browser, Godot world or paid Agent run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,realpathSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationAgentRuns} from '../../services/creation/agent-runs.mjs';
import {CodexAgent} from '../../services/creation/codex-agent.mjs';
import {emptyDocument,resolveScene,scopedAddressKey} from '../../services/creation/hierarchy.mjs';
import {inspectionObjects,inspectionAttachment} from '../../services/creation/inspection-objects.mjs';
import {hierarchyRuntimeId} from '../../services/creation/hierarchy-view.mjs';
import {identity,identityTransform,matrix,quaternionFromEulerDegrees} from '../../packages/scene/transform.mjs';
import vm from 'node:vm';

const clone=structuredClone;
const near=(a,b)=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-7,`${i}: ${v} != ${b[i]}`));};
const trs=(position=[0,0,0],degrees=[0,0,0],scale=[1,1,1])=>({position,rotation:quaternionFromEulerDegrees(degrees),scale});
const node=(id,parent_id,transform=identityTransform())=>({id,name:id,kind:'anchor',parent_id,transform,solid:false,color:'#74d5cd',components:{}});

function fixture(t,{hierarchy=false}={}){
  const data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-annotation-context-'))),file=resolve(data,'state.sqlite');
  let store=new CreationStore(file);
  t.after(()=>{if(store.db.isOpen)store.close();rmSync(data,{recursive:true,force:true});});
  const owner=store.register({name:'Annotation owner',password:'annotation-test-password'}).user;
  const manifest={schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'坐标测试场景',objects:[{id:'anchor',name:'旧名称',kind:'anchor',position:[12.5,3,-8.25],rotation:[27,61,-19],scale:[.4,2,4],solid:false,color:'#aabbcc',components:{}}]}}};
  const project=store.createProject(owner,{name:'Annotation fixture'},manifest).project.id;
  let serial=0;
  const current=(b='main')=>store.branchView(owner,project,b);
  const apply=(ops,b='main',extra={})=>store.apply(owner,project,b,{transaction_id:`annotation-${++serial}`,base_revision:current(b).head,ops,...extra});
  if(hierarchy)apply([{type:'migrate_hierarchy'}],'main',{expected_head:current().head});
  const address=(resource_id,id,path=[])=>({project_id:project,branch_id:'main',resource_id,instance_path:path,definition_node_id:id});
  const row=a=>resolveScene(current().manifest,a.resource_id,a).find(r=>scopedAddressKey(r.address)===scopedAddressKey(a));
  // Annotation fixtures do not select a model effort; the explicit fake
  // executor below intentionally advertises no reasoning-effort capability.
  const session=store.createSession(owner,project,'main',{effort:null});
  const attach=(a,extra={})=>store.attach(owner,session.id,{revision:current().head,address:a,expected_version:row(a).object_version,...extra});
  return {data,owner,project,session,current,apply,address,row,attach,get store(){return store;},reopen(){store.close();store=new CreationStore(file);}};
}

function addHierarchy(f){
  const root=f.current().manifest.resources.scene.root_id;
  f.apply([{type:'put_node',resource_id:'scene',node_id:'grandparent',expected_version:null,node:node('grandparent',root)},
    {type:'put_node',resource_id:'scene',node_id:'parent',expected_version:null,node:node('parent','grandparent',trs([4,7,-2],[0,90,0],[2,3,4]))},
    {type:'put_node',resource_id:'scene',node_id:'child',expected_version:null,node:node('child','parent',trs([1,2,3]))}]);
  return f.address('scene','child');
}

test('flat anchor fixes complete coordinate convention and quaternion pose without relabeling its Euler snapshot',t=>{
  const f=fixture(t),before=f.current(),target=before.manifest.resources.scene.objects[0];
  const camera={position:[20,10,5],target:[12.5,3,-8.25],view:'perspective',projection:'perspective'};
  const a=f.store.attach(f.owner,f.session.id,{revision:before.head,resource_id:'scene',object_id:target.id,expected_version:target.version,camera});
  assert.equal(a.context_version,1);assert.equal(a.domain,'source');assert.equal(a.kind,'spatial_anchor');
  assert.equal(a.source_revision,before.head);assert.equal(a.resource_name,'坐标测试场景');assert.equal(a.resource_kind,'scene');
  assert.equal(a.resource_version,before.manifest.resources.scene.version);assert.equal(a.coordinate_system.rotation_format,'quaternion_xyzw');
  assert.equal(a.coordinate_system.snapshot_rotation_format,'euler_degrees_YXZ');assert.equal(a.coordinate_system.matrix_layout,'column_major');
  assert.equal(a.coordinate_system.units,'metres');assert.equal(a.coordinate_system.basis,'right_handed_y_up');
  assert.deepEqual(a.coordinate_system.origin,{resource_id:'scene',resource_version:a.resource_version,source_revision:before.head});
  assert.deepEqual(a.snapshot.rotation,[27,61,-19]);near(a.local_transform.rotation,quaternionFromEulerDegrees([27,61,-19]));
  near(a.world_position,[12.5,3,-8.25]);near(a.world_matrix,matrix(trs(target.position,target.rotation,target.scale)));
  assert.deepEqual(a.source_pose.world_matrix,a.world_matrix);assert.deepEqual(a.source_pose.local_transform,a.local_transform);assert.equal(a.observed_pose,null);
  assert.equal(a.parent_address,null);assert.deepEqual(a.parent_world_matrix,identity());assert.deepEqual(a.ancestor_chain,[]);
  assert.equal(a.camera.source,'client_viewport');assert.equal(a.camera.space,'scene_world');assert.deepEqual(a.camera.position,camera.position);
  camera.position[0]=999;assert.equal(a.camera.position[0],20);
});

test('hierarchy source captures transformed parents and keeps stale historical coordinates when an ancestor moves',t=>{
  const f=fixture(t,{hierarchy:true}),address=addHierarchy(f),a=f.attach(address),before=clone(a);
  near(a.world_position,[16,13,-4]);near(a.local_transform.position,[1,2,3]);assert.equal(a.coordinate_system.snapshot_rotation_format,'quaternion_xyzw');
  assert.deepEqual(a.parent_address,f.address('scene','parent'));assert.equal(a.parent_version,f.row(f.address('scene','parent')).object_version);
  near(a.parent_world_matrix,matrix(trs([4,7,-2],[0,90,0],[2,3,4])));
  assert.ok(a.ancestor_chain.some(n=>n.address.definition_node_id==='grandparent'));
  const parent=a.ancestor_chain.find(n=>n.address.definition_node_id==='parent');assert.ok(parent);near(parent.world_matrix,a.parent_world_matrix);
  const oldParentVersion=a.parent_version;
  f.apply([{type:'patch_node',resource_id:'scene',node_id:'grandparent',expected_version:f.current().manifest.resources.scene.nodes.grandparent.version,patch:{transform:trs([0,5,0])}}]);
  const fresh=f.attach(address);near(fresh.world_position,[16,18,-4]);assert.equal(fresh.parent_version,oldParentVersion);assert.notEqual(fresh.ancestry_hash,a.ancestry_hash);
  assert.deepEqual(f.store.sessionFor(f.owner,f.session.id).draft_attachments[0],before);
  f.reopen();assert.deepEqual(f.store.sessionFor(f.owner,f.session.id).draft_attachments[0],before);
});

test('same nested prefab node is identified by fixed instance chains and independent definitions keep their own origin',t=>{
  const f=fixture(t,{hierarchy:true}),inner=emptyDocument('inner','prefab','门定义'),outer=emptyDocument('outer','prefab','房屋定义');
  inner.nodes.door=node('door',inner.root_id,trs([0,2,1]));
  f.apply([{type:'create_resource',resource_id:'inner',resource:inner},{type:'create_resource',resource_id:'outer',resource:outer}]);
  const mount=(instance_id,prefab_id,parent_id,transform=identityTransform())=>({instance_id,prefab_id,prefab_revision:f.current().manifest.resources[prefab_id].version,parent_id,transform,overrides:[]});
  f.apply([{type:'instantiate_prefab',resource_id:'outer',instance_id:'inside',expected_version:null,instance:mount('inside','inner','root',trs([1,0,0]))}]);
  const root=f.current().manifest.resources.scene.root_id;
  f.apply([{type:'instantiate_prefab',resource_id:'scene',instance_id:'left',expected_version:null,instance:mount('left','outer',root)},
    {type:'instantiate_prefab',resource_id:'scene',instance_id:'right',expected_version:null,instance:mount('right','outer',root,trs([10,3,0]))}]);
  const left=f.attach(f.address('scene','door',['left','inside'])),right=f.attach(f.address('scene','door',['right','inside']));
  assert.notDeepEqual(left.address,right.address);assert.equal(left.definition_node_id,right.definition_node_id);
  near(left.world_position,[1,2,1]);near(right.world_position,[11,5,1]);
  assert.deepEqual(left.prefab_instances.map(p=>p.prefab_id),['outer','inner']);
  assert.deepEqual(left.prefab_instances.map(p=>p.prefab_revision),[f.current().manifest.resources.outer.version,f.current().manifest.resources.inner.version]);
  assert.ok(left.prefab_instances.every(p=>typeof p.instance_version==='string'&&p.transform));
  const mountedRoot=f.attach(f.address('scene','root',['right','inside']));
  near(mountedRoot.parent_world_matrix.slice(12,15),[11,3,0]);
  near(mountedRoot.source_pose.world_position,[11,3,0]);
  const definition=f.attach(f.address('inner','door'));
  assert.equal(definition.space,'prefab_definition');assert.equal(definition.coordinate_system.space,'prefab_definition');
  assert.equal(definition.coordinate_system.origin.resource_id,'inner');assert.equal(definition.resource_kind,'prefab');
  near(definition.world_position,[0,2,1]);assert.deepEqual(definition.prefab_instances,[]);
  assert.throws(()=>f.attach({...left.address,branch_id:'other'}),/作用域|会话|分支/);
});

test('FAKE rendered inspection keeps observed pose separate from source parents, convention and fixed world identity',t=>{
  const f=fixture(t,{hierarchy:true}),address=addHierarchy(f),row=f.row(address),branch=f.current();
  const rendered=matrix(trs([90,10,20],[12,45,3])),scope={project_id:f.project,branch_id:'main',resource_id:'scene'};
  const observations=inspectionObjects(branch.manifest,scope,[{id:hierarchyRuntimeId(address),address,object_version:row.object_version,world_matrix:rendered}]);
  const inspection={id:'FAKE-inspection',...scope,revision:branch.head,world_id:'FAKE-world',epoch:7,sequence:123,state_hash:'FAKE-state',runtime_build_id:'FAKE-runtime',stop_ack_sequence:124,input_zero_seq:8,observations};
  const a=inspectionAttachment(branch.manifest,inspection,{address,expected_version:row.object_version,camera:{position:[20,15,30],target:[90,10,20],view:'perspective'}});
  assert.equal(a.domain,'frozen');assert.equal(a.context_version,1);near(a.position,[90,10,20]);near(a.world_position,[90,10,20]);near(a.world_matrix,rendered);
  near(a.observed_pose.world_position,[90,10,20]);near(a.observed_pose.world_matrix,rendered);near(a.source_pose.world_position,[16,13,-4]);
  near(a.source_pose.local_transform.position,[1,2,3]);near(a.source_pose.parent_world_matrix,matrix(trs([4,7,-2],[0,90,0],[2,3,4])));
  assert.equal(a.source_revision,branch.head);assert.equal(a.observation.inspection_id,'FAKE-inspection');assert.equal(a.observation.epoch,7);assert.equal(a.observation.sequence,123);assert.equal(a.observation.state_hash,'FAKE-state');
  const fixed=clone(a);inspection.observations[0].world_matrix[12]=0;assert.deepEqual(a,fixed);
  assert.throws(()=>f.attach(address,{observation:{world_id:'forged'}}),/检查快照|世界服务/);
});

test('invalid client camera is rejected without persisting an incomplete attachment',t=>{
  const f=fixture(t,{hierarchy:true}),address=addHierarchy(f);
  for(const camera of [{position:[Infinity,0,0],target:[0,0,0]},{position:[1,2],target:[0,0,0]},{position:[0,0,0],target:[NaN,0,0]}]){
    assert.throws(()=>f.attach(address,{camera}));assert.equal(f.store.sessionFor(f.owner,f.session.id).draft_attachments.length,0);
  }
});

class ExplicitFakeExecutor extends EventEmitter{
  constructor(){super();this.connected=true;this.threads=new Map();this.turns=new Map();this.inputs=[];}
  async start(){}
  async listModels(){return {data:[{model:'FAKE-annotation-model',isDefault:true,supportedReasoningEfforts:[]}]};}
  async accountStatus(){return {account:{type:'FAKE-no-model-account'}};}
  async createThread(input){this.threads.set('FAKE-thread',{...input,loaded:true,busy:false,uncertain:false});return {thread:{id:'FAKE-thread',turns:[]}};}
  async sendTurn(threadId,input){this.inputs.push(clone(input));const turn={id:'FAKE-turn',status:'completed',items:[]};this.turns.set(`${threadId}/${turn.id}`,turn);return {turn};}
  async stop(){}
}

test('actual send manager persists the enriched snapshot and forwards it unchanged to an explicit FAKE executor',async t=>{
  const f=fixture(t,{hierarchy:true}),address=addHierarchy(f),attachment=f.attach(address),executor=new ExplicitFakeExecutor();
  const service={store:f.store,data:f.data,origin:'http://127.0.0.1:48921',sessionEvent(){},realtime:{development(){}}};
  const manager=new CreationAgentRuns({service,adapter:executor});t.after(()=>manager.close());
  const sent=await manager.send(f.owner,f.session.id,{text:'请将入口放在这个历史批注位置',client_user_message_id:'annotation-sent-once'});
  assert.deepEqual(executor.inputs[0].attachments,[attachment]);assert.deepEqual(sent.session.messages[0].attachments,[attachment]);assert.deepEqual(sent.session.draft_attachments,[]);
  f.apply([{type:'patch_node',resource_id:'scene',node_id:'child',expected_version:f.current().manifest.resources.scene.nodes.child.version,patch:{name:'发送后更名',transform:trs([80,90,100])}}]);
  assert.deepEqual(f.store.sessionView(f.owner,f.session.id).messages[0].attachments,[attachment]);
  const replay=await manager.send(f.owner,f.session.id,{text:'请将入口放在这个历史批注位置',client_user_message_id:'annotation-sent-once'});
  assert.equal(replay.replayed,true);assert.equal(executor.inputs.length,1);assert.deepEqual(replay.session.messages[0].attachments,[attachment]);
});

test('actual Codex sendTurn captures immutable context before an async boundary and sends its reference index using explicit FAKE RPC',async t=>{
  const f=fixture(t,{hierarchy:true}),a=f.attach(addHierarchy(f)),frozen=clone(a),agent=new CodexAgent({workspaceRoot:f.data}),calls=[];
  const cwd=resolve(f.data,'FAKE-creator-session');mkdirSync(cwd);
  agent.threads.set('FAKE-thread',{loaded:true,cwd,scope:{projectId:f.project,branchId:'main'},busy:false,uncertain:false});
  agent._rpc=async(method,params)=>{calls.push({method,params:clone(params)});return {turn:{id:'FAKE-turn',status:'completed'}};};
  const pending=agent.sendTurn('FAKE-thread',{text:'使用固定批注',model:'FAKE-annotation-model',attachments:[a],clientUserMessageId:'annotation-wire'});
  a.world_position[0]=999;a.source_pose.local_transform.position[0]=999;await pending;
  assert.equal(calls[0].method,'turn/start');const payload=calls[0].params.input.find(x=>x.text.startsWith('World Atelier reference links'));
  assert.ok(payload);const [reference]=JSON.parse(payload.text.slice(payload.text.indexOf('\n')+1));
  assert.equal(reference.href,`attachment:${frozen.id}`);assert.equal(reference.source_revision,frozen.source_revision);
  assert.deepEqual(JSON.parse(readFileSync(reference.snapshot_file,'utf8')),frozen);
  assert.equal(reference.world_position,undefined,'the default model input remains a compact reference');
  await assert.rejects(agent.sendTurn('FAKE-thread',{text:'wrong branch',attachments:[{...frozen,branch_id:'other'}]}),{code:'ATTACHMENT_SCOPE_MISMATCH'});
  assert.equal(calls.length,1);
});

function presentation(){
  const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
  const functions=source.split('// BEGIN ANNOTATION PRESENTATION')[1]?.split('// END ANNOTATION PRESENTATION')[0];
  assert.ok(functions,'actual workspace presentation boundaries are present');
  const context={structuredClone,escapeChat:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
  vm.createContext(context);vm.runInContext(functions.replaceAll('export function ','function '),context);return context;
}

test('actual annotation presentation separates source and observed coordinates, escapes content and tolerates old attachments',()=>{
  const ui=presentation(),a={context_version:1,resource_name:'<img src=x onerror=alert(1)>',resource_id:'scene',resource_kind:'scene',branch_id:'main',space:'scene_world',basis:'right_handed_y_up',world_position:[90,10,20],
    source_pose:{world_position:[16,13,-4],local_transform:trs([1,2,3])},observation:{world_id:'w',epoch:7,sequence:123,inspection_id:'i',state_hash:'s'},camera:null};
  const html=ui.annotationDetails(a);
  assert.match(html,/所见世界位置/);assert.match(html,/90\.000 \/ 10\.000 \/ 20\.000/);assert.match(html,/源稿世界位置/);assert.match(html,/16\.000 \/ 13\.000 \/ -4\.000/);
  assert.match(html,/四元数 X \/ Y \/ Z \/ W/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
  assert.match(ui.annotationCoordinateSummary(a),/^所见世界 · 90\.00, 10\.00, 20\.00 m$/);
  assert.match(ui.annotationCoordinateSummary({...a,space:'prefab_definition'}),/^定义空间/);
  const old={object_id:'old',branch_id:'main',resource_id:'scene',position:[1,2,3],revision:'old-revision'};
  assert.doesNotThrow(()=>ui.annotationDetails(old));assert.match(ui.annotationDetails(old),/未记录/);assert.match(ui.annotationDetails(old),/old-revision/);
});

test('actual camera capture fences scene, render generation, mode and revision and clones the accepted view',()=>{
  const ui=presentation(),context={documentId:'scene',seq:2,mode:'inspect',revision:'fixed'},view={...context,camera:{position:[20,10,5],target:[12.5,3,-8.25],view:'perspective'}};
  const camera=ui.fixedAnnotationCamera(view,context);assert.deepEqual(camera,view.camera);camera.position[0]=999;assert.equal(view.camera.position[0],20);
  for(const [key,value]of [['documentId','other'],['seq',3],['mode','edit'],['revision','moving-head']])assert.equal(ui.fixedAnnotationCamera({...view,[key]:value},context),null);
  assert.equal(ui.fixedAnnotationCamera(null,context),null);
});
