import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {CreationStore} from '../../services/creation/store.mjs';
import {HIERARCHY_SCHEMA,emptyDocument,prepareManifest,migrateFlatManifest,resolveScene,normalizeDocument,normalizeInstance,addressKey,nodeTarget} from '../../services/creation/hierarchy.mjs';
import {applyHierarchyOps} from '../../services/creation/hierarchy-operations.mjs';
import {previewInstanceUpgrade,prefabImpact} from '../../services/creation/hierarchy-prefabs.mjs';
import {identityTransform,matrix,multiply,inverse,decompose,quaternionFromEulerDegrees} from '../../packages/scene/transform.mjs';
const allowed=()=>true;
const trs=(position=[0,0,0],euler=[0,0,0],scale=[1,1,1])=>({position,rotation:quaternionFromEulerDegrees(euler),scale});
const node=(id,parent='root',transform=identityTransform(),extra={})=>({id,name:id,parent_id:parent,kind:'anchor',color:'#74d5cd',solid:false,components:{},transform,...extra});
function fixtures() {
  const scene=emptyDocument('scene'),second=emptyDocument('second'),sign=emptyDocument('sign','prefab'),house=emptyDocument('house','prefab');
  sign.nodes.sign=node('sign','root',trs([0,2,1]));house.nodes.door=node('door','root',trs([0,1,2]),{components:{interactable:{radius:2,label:'开门'}}});
  let manifest=prepareManifest({schema:HIERARCHY_SCHEMA,entry_scene_id:'scene',resources:{scene,second,sign,house},prefab_revisions:{}},allowed);
  const mount=(instance_id,prefab)=>({instance_id,prefab_id:prefab,prefab_revision:manifest.resources[prefab].version,parent_id:'root',transform:identityTransform(),overrides:[]});
  manifest.resources.house.instances.sign=mount('sign','sign');manifest=prepareManifest(manifest,allowed);
  manifest.resources.scene.instances.a=mount('a','house');manifest.resources.scene.instances.b={...mount('b','house'),transform:trs([10,3,0])};manifest.resources.second.instances.c=mount('c','house');
  return prepareManifest(manifest,allowed);
}
const row=(m,rid,path,nid)=>resolveScene(m,rid).find(r=>addressKey(r.address)===addressKey({instance_path:path,definition_node_id:nid}));
const op=(m,operation)=>applyHierarchyOps(m,[operation],allowed).manifest;
const near=(a,b,epsilon=1e-7)=>{assert.equal(a.length,b.length);a.forEach((x,i)=>assert.ok(Math.abs(x-b[i])<epsilon,`${i}: ${x} != ${b[i]}`));};

test('multi-axis TRS inverse and exact decomposition, including rotations near 180 degrees',()=>{
  for(const angles of [[27,61,-19],[180,0,0],[0,180,0],[0,0,180]]){
    const t=trs([12.5,3,-8.25],angles,[.4,2,4]),m=matrix(t);near(matrix(decompose(m)),m);near(multiply(inverse(m),m),matrix(identityTransform()));
  }
});
test('hierarchy movement includes Y, rotated parent, nonuniform scale and stable IDs',()=>{
  let m=fixtures();m.resources.scene.nodes.parent=node('parent','root',trs([4,7,-2],[0,90,0],[2,3,4]));m.resources.scene.nodes.child=node('child','parent',trs([1,2,3]));m=prepareManifest(m,allowed);
  near(row(m,'scene',[],'child').world_position,[16,13,-4]);
  const childVersion=m.resources.scene.nodes.child.version;
  m=op(m,{type:'patch_node',resource_id:'scene',node_id:'parent',expected_version:m.resources.scene.nodes.parent.version,patch:{transform:trs([5,8,-2],[0,90,0],[2,3,4])}});
  near(row(m,'scene',[],'child').world_position,[17,14,-4]);assert.equal(m.resources.scene.nodes.child.version,childVersion);
});
test('world shear stays exact; keep-world reparent rejects unrepresentable local shear atomically',()=>{
  let m=fixtures();m.resources.scene.nodes.parent=node('parent','root',trs([1,3,0],[0,0,0],[2,1,1]));m.resources.scene.nodes.child=node('child','parent',trs([0,2,0],[0,45,0]));m=prepareManifest(m,allowed);
  assert.equal(row(m,'scene',[],'child').world_transform,null);
  const before=structuredClone(m),r=row(m,'scene',[],'child'),p=row(m,'scene',[],'root');
  assert.throws(()=>op(m,{type:'reparent_node',resource_id:'scene',node_id:'child',expected_version:m.resources.scene.nodes.child.version,parent_id:'root',keep_world:true,expected_ancestry_hash:r.ancestry_hash,expected_parent_ancestry_hash:p.ancestry_hash,expected_parent_version:p.node.version}),/unrepresentable_shear/);
  assert.deepEqual(m,before);
});
test('keep-world reparent preserves all matrix entries and undo is conditional',()=>{
  let m=fixtures();m.resources.scene.nodes.parent=node('parent','root',trs([10,3,4],[20,40,10],[2,2,2]));m.resources.scene.nodes.child=node('child','root',trs([2,4,7],[13,42,1],[1,2,3]));m=prepareManifest(m,allowed);
  const r=row(m,'scene',[],'child'),p=row(m,'scene',[],'parent');
  const result=applyHierarchyOps(m,[{type:'reparent_node',resource_id:'scene',node_id:'child',expected_version:r.node.version,parent_id:'parent',keep_world:true,expected_ancestry_hash:r.ancestry_hash,expected_parent_ancestry_hash:p.ancestry_hash,expected_parent_version:p.node.version}],allowed);
  near(row(result.manifest,'scene',[],'child').world_matrix,r.world_matrix);
  near(row(applyHierarchyOps(result.manifest,result.inverse,allowed).manifest,'scene',[],'child').world_matrix,r.world_matrix);
});
test('grandparent movement fences stale world edit even when direct parent local version is unchanged',()=>{
  let m=fixtures();m.resources.scene.nodes.g=node('g');m.resources.scene.nodes.p=node('p','g');m.resources.scene.nodes.n=node('n','p');m=prepareManifest(m,allowed);
  const stale=row(m,'scene',[],'n'),pv=m.resources.scene.nodes.p.version;
  m=op(m,{type:'patch_node',resource_id:'scene',node_id:'g',expected_version:m.resources.scene.nodes.g.version,patch:{transform:trs([0,3,0])}});
  assert.equal(m.resources.scene.nodes.p.version,pv);
  assert.throws(()=>op(m,{type:'set_node_world_transform',resource_id:'scene',node_id:'n',expected_version:stale.node.version,expected_ancestry_hash:stale.ancestry_hash,world_transform:trs([12.5,3,-8.25])}),/祖先/);
  const fresh=row(m,'scene',[],'n');m=op(m,{type:'set_node_world_transform',resource_id:'scene',node_id:'n',expected_version:fresh.node.version,expected_ancestry_hash:fresh.ancestry_hash,world_transform:trs([12.5,3,-8.25])});near(row(m,'scene',[],'n').world_position,[12.5,3,-8.25]);
});
test('three houses and nested signs retain distinct identity; one override affects exactly one',()=>{
  let m=fixtures();const before=row(m,'scene',['b','sign'],'sign'),target={instance_path:['sign'],definition_node_id:'sign'};
  m=op(m,{type:'set_override',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,override:{target,path:['color'],value:'#ff0000'}});
  assert.equal(row(m,'scene',['a','sign'],'sign').node.color,'#ff0000');assert.equal(row(m,'scene',['b','sign'],'sign').node.color,before.node.color);assert.equal(row(m,'second',['c','sign'],'sign').node.color,before.node.color);
  assert.notEqual(addressKey(row(m,'scene',['a','sign'],'sign').address),addressKey(before.address));
  assert.equal(Object.keys(m.resources.scene.nodes).length,1,'resolved nodes must never become source copies');
});
test('definition updates stay pinned, preview lists two scenes, upgrade retains overrides',()=>{
  let m=fixtures();m=op(m,{type:'set_override',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,override:{target:nodeTarget('door'),path:['color'],value:'#ff0000'}});
  const old=m.resources.scene.instances.a.prefab_revision;
  m=op(m,{type:'patch_node',resource_id:'house',node_id:'door',expected_version:m.resources.house.nodes.door.version,patch:{components:{interactable:{radius:4,label:'新门'}}}});
  assert.equal(row(m,'scene',['a'],'door').node.components.interactable.radius,2);assert.equal(m.resources.scene.instances.a.prefab_revision,old);
  const revision=m.resources.house.version,impact=prefabImpact(m,'house',revision,{source_revision:'src-fixed'});assert.equal(impact.direct.length,3);
  for(const plan of impact.direct){m=op(m,{type:'upgrade_instance',resource_id:plan.resource_id,instance_id:plan.instance_id,expected_version:m.resources[plan.resource_id].instances[plan.instance_id].version,prefab_revision:revision,expected_preview_hash:previewInstanceUpgrade(m,plan.resource_id,plan.instance_id,revision).preview_hash});}
  assert.equal(row(m,'scene',['a'],'door').node.color,'#ff0000');assert.equal(row(m,'scene',['b'],'door').node.components.interactable.radius,4);
});
test('deleted overridden node produces explicit conflict; only chosen drop unblocks upgrade',()=>{
  let m=fixtures();m=op(m,{type:'set_override',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,override:{target:nodeTarget('door'),path:['color'],value:'#ff0000'}});
  m=op(m,{type:'delete_node',resource_id:'house',node_id:'door',expected_version:m.resources.house.nodes.door.version});const plan=previewInstanceUpgrade(m,'scene','a',m.resources.house.version);
  assert.equal(plan.conflicts[0].reason,'node_or_instance_path_deleted');
  const update={type:'upgrade_instance',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,prefab_revision:m.resources.house.version,expected_preview_hash:plan.preview_hash};
  assert.throws(()=>op(m,update),/未解决/);assert.ok(row(m,'scene',['a'],'door'));
  m=op(m,{...update,resolutions:{[plan.conflicts[0].override_key]:'drop_override'}});assert.equal(row(m,'scene',['a'],'door'),undefined);assert.ok(row(m,'scene',['b'],'door'));
});
test('nested definition upgrade proceeds inside out and reports a deleted nested path conflict',()=>{
  let m=fixtures();m=op(m,{type:'set_override',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,override:{target:{instance_path:['sign'],definition_node_id:'sign'},path:['color'],value:'#ff0000'}});
  m=op(m,{type:'delete_instance',resource_id:'house',instance_id:'sign',expected_version:m.resources.house.instances.sign.version});
  const plan=previewInstanceUpgrade(m,'scene','a',m.resources.house.version);assert.equal(plan.conflicts.length,1);
});
test('unknown components, cycles, illegal fields, duplicate IDs and invalid dependency hashes reject',()=>{
  const base=fixtures();
  for(const edit of [m=>m.resources.scene.nodes.root.parent_id='root',m=>m.resources.scene.nodes.root.components={alien:{}},m=>m.prefab_revisions[m.resources.house.version].name='tampered',m=>m.resources.scene.instances.a.prefab_revision='0'.repeat(64)]){
    const m=structuredClone(base);edit(m);assert.throws(()=>prepareManifest(m,allowed));
  }
  let m=fixtures();m.resources.house.instances.self={instance_id:'self',prefab_id:'house',prefab_revision:m.resources.house.version,parent_id:'root',transform:identityTransform(),overrides:[]};assert.throws(()=>prepareManifest(m,allowed),/prefab_cycle/);
  assert.throws(()=>op(base,{type:'set_override',resource_id:'scene',instance_id:'a',expected_version:base.resources.scene.instances.a.version,override:{target:nodeTarget('door'),path:['parent_id'],value:'evil'}}),/unsupported_override_field/);
});
test('asset pair and behavior override permissions are revalidated on complete candidate',()=>{
  let m=fixtures();const h='a'.repeat(64),g='b'.repeat(64);
  m.resources.house.nodes.door={...m.resources.house.nodes.door,kind:'model',model_hash:h,model_url:`/preview-assets/${h}.glb`};m=prepareManifest(m,allowed);
  const input={type:'set_override',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,override:{target:nodeTarget('door'),path:['model_hash'],value:g}};
  // The old pinned house does not even have this field; it cannot be fabricated by an override.
  assert.throws(()=>op(m,input),/override_field_missing/);
  const plan=previewInstanceUpgrade(m,'scene','a',m.resources.house.version);m=op(m,{type:'upgrade_instance',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,prefab_revision:m.resources.house.version,expected_preview_hash:plan.preview_hash});
  input.expected_version=m.resources.scene.instances.a.version;assert.throws(()=>op(m,input),/模型必须引用/);
  const pair=[input,{...input,override:{...input.override,path:['model_url'],value:`/preview-assets/${g}.glb`}}];
  // Whole-instance compare is updated for the second operation.
  const interim=structuredClone(m.resources.scene.instances.a);interim.overrides=[input.override];
  pair[1].expected_version=normalizeInstance(interim).version;
  assert.throws(()=>applyHierarchyOps(m,pair,(hash)=>hash!==g),/不能访问/);
  const updated=applyHierarchyOps(m,pair,allowed).manifest;assert.equal(row(updated,'scene',['a'],'door').node.model_hash,g);
});
function setup(t) {
  const dir=mkdtempSync(resolve(tmpdir(),'atelier-hierarchy-'));const store=new CreationStore(resolve(dir,'state.sqlite'));
  t.after(()=>{if(store.db.isOpen)store.close();rmSync(dir,{recursive:true,force:true});});
  const user=store.register({name:'Hierarchy owner',password:'hierarchy-password'}).user;
  const flat={schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'旧场景',objects:[{id:'legacy',kind:'anchor',name:'旧节点',position:[12.5,3,-8.25],rotation:[27,61,-19],scale:[.4,2,4],color:'#aabbcc',solid:false,components:{},custom_note:'preserve me'}]}}};
  const created=store.createProject(user,{},flat),p=created.project.id;
  let serial=0;
  const current=(b='main')=>store.branchView(user,p,b);
  const apply=(ops,extra={},b='main')=>store.apply(user,p,b,{transaction_id:'tx-'+(++serial),base_revision:current(b).head,ops,...extra});
  return {store,user,p,current,apply,dir};
}
test('explicit migration preserves all legacy fields and old immutable attachments; source changes alone',t=>{
  const {store,user,p,current,apply}=setup(t),old=current(),session=store.createSession(user,p,'main');
  const attachment=store.attach(user,session.id,{revision:old.head,resource_id:'scene',object_id:'legacy',expected_version:old.manifest.resources.scene.objects[0].version});
  assert.throws(()=>apply([{type:'migrate_hierarchy'}]),/固定当前/);
  apply([{type:'migrate_hierarchy'}],{expected_head:old.head});
  const next=current(),migrated=next.manifest.resources.scene.nodes.legacy;
  assert.equal(migrated.custom_note,'preserve me');near(matrix(migrated.transform),matrix(trs([12.5,3,-8.25],[27,61,-19],[.4,2,4])));
  assert.deepEqual(store.sessionFor(user,session.id).draft_attachments[0],attachment);assert.equal(store.get('creator_revision',old.head).manifest.schema,'creation-flat-1');
  assert.equal(store.list('creator_world').length,0);
  const resolved=row(next.manifest,'scene',[],'legacy');const attached=store.attach(user,session.id,{revision:next.head,address:{resource_id:'scene',instance_path:[],definition_node_id:'legacy'},expected_version:resolved.object_version});
  near(attached.position,[12.5,3,-8.25]);assert.equal(attached.address.definition_node_id,'legacy');
  assert.throws(()=>apply([{type:'patch_object',resource_id:'scene',object_id:'legacy',expected_version:migrated.version,patch:{name:'wrong'}}]),/不支持/);
});
test('source transaction rollback, replay, permissions and stale Agent fencing are durable',t=>{
  const {store,user,p,current,apply}=setup(t);apply([{type:'migrate_hierarchy'}],{expected_head:current().head});const before=current();
  const valid={type:'patch_node',resource_id:'scene',node_id:'legacy',expected_version:before.manifest.resources.scene.nodes.legacy.version,patch:{name:'first'}};
  assert.throws(()=>apply([valid,{type:'delete_node',resource_id:'scene',node_id:'absent',expected_version:null}]),/不存在/);assert.equal(current().head,before.head);
  const input={transaction_id:'durable-retry',base_revision:before.head,ops:[valid]};const first=store.apply(user,p,'main',input);assert.equal(store.apply(user,p,'main',input).revision,first.revision);
  assert.throws(()=>store.apply(user,p,'main',{...input,ops:[{...valid,patch:{name:'second'}}]}),/同一事务/);
  const stranger=store.register({name:'Viewer user',password:'hierarchy-password'}).user;store.setMember(user,p,stranger.id,'viewer');assert.throws(()=>store.apply(stranger,p,'main',input),/权限/);
  assert.throws(()=>store.apply(user,p,'main',{...input,transaction_id:'stale-run'},{run_id:'none',lease_generation:1}),/取消/);
});
test('node undo preserves another user change on a different node and rejects same-node overwrite',t=>{
  const {current,apply}=setup(t);apply([{type:'migrate_hierarchy'}],{expected_head:current().head});
  apply([{type:'put_node',resource_id:'scene',node_id:'other',expected_version:null,node:node('other',current().manifest.resources.scene.root_id)}]);
  const first=apply([{type:'patch_node',resource_id:'scene',node_id:'legacy',expected_version:current().manifest.resources.scene.nodes.legacy.version,patch:{name:'my edit'}}]);
  apply([{type:'patch_node',resource_id:'scene',node_id:'other',expected_version:current().manifest.resources.scene.nodes.other.version,patch:{name:'other edit'}}]);
  apply(first.inverse);assert.equal(current().manifest.resources.scene.nodes.other.name,'other edit');assert.equal(current().manifest.resources.scene.nodes.legacy.name,'旧节点');
  const second=apply([{type:'patch_node',resource_id:'scene',node_id:'legacy',expected_version:current().manifest.resources.scene.nodes.legacy.version,patch:{name:'my edit again'}}]);
  apply([{type:'patch_node',resource_id:'scene',node_id:'legacy',expected_version:current().manifest.resources.scene.nodes.legacy.version,patch:{name:'someone else'}}]);
  assert.throws(()=>apply(second.inverse),/目标已变化/);
});
test('merge keeps stable topology, immutable archives and source branch can merge twice',t=>{
  const {store,user,p,current,apply}=setup(t);apply([{type:'migrate_hierarchy'}],{expected_head:current().head});
  store.fork(user,p,{from_branch:'main',branch_id:'work',expected_head:current().head});
  apply([{type:'put_node',resource_id:'scene',node_id:'main-child',expected_version:null,node:node('main-child',current().manifest.resources.scene.root_id)}]);
  apply([{type:'patch_node',resource_id:'scene',node_id:'legacy',expected_version:current('work').manifest.resources.scene.nodes.legacy.version,patch:{name:'branch edit'}}],{},'work');
  let preview=store.mergePreview(user,p,'main',{source_branch_id:'work'});assert.equal(preview.conflicts.length,0);store.merge(user,p,'main',{preview_id:preview.id});
  assert.ok(current().manifest.resources.scene.nodes['main-child']);assert.equal(current().manifest.resources.scene.nodes.legacy.name,'branch edit');
  apply([{type:'patch_node',resource_id:'scene',node_id:'legacy',expected_version:current('work').manifest.resources.scene.nodes.legacy.version,patch:{name:'branch edit 2'}}],{},'work');
  preview=store.mergePreview(user,p,'main',{source_branch_id:'work'});store.merge(user,p,'main',{preview_id:preview.id});assert.equal(current().manifest.resources.scene.nodes.legacy.name,'branch edit 2');
});
test('real Godot Node3D legacy Euler migration matches matrices for all multi-axis fixtures',t=>{
  const dir=mkdtempSync(resolve(tmpdir(),'atelier-godot-trs-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const cases=[[[12.5,3,-8.25],[27,61,-19],[.4,2,4]],[[-4,8,12],[89,173,44],[2,3,1]],[[1,2,3],[0,180,180],[5,.1,2]]];
  const data=cases.map(([position,rotation,scale])=>({position,rotation,scale}));writeFileSync(resolve(dir,'input.json'),JSON.stringify(data));
  writeFileSync(resolve(dir,'probe.gd'),`extends SceneTree\nfunc _initialize():\n\tvar cases=JSON.parse_string(FileAccess.get_file_as_string("${resolve(dir,'input.json')}"))\n\tvar rows=[]\n\tfor c in cases:\n\t\tvar n=Node3D.new()\n\t\tn.position=Vector3(c.position[0],c.position[1],c.position[2])\n\t\tn.rotation_degrees=Vector3(c.rotation[0],c.rotation[1],c.rotation[2])\n\t\tn.scale=Vector3(c.scale[0],c.scale[1],c.scale[2])\n\t\tvar b=n.transform.basis\n\t\tvar p=n.position\n\t\trows.append({"rotation_order":n.rotation_order,"matrix":[b.x.x,b.x.y,b.x.z,0,b.y.x,b.y.y,b.y.z,0,b.z.x,b.z.y,b.z.z,0,p.x,p.y,p.z,1]})\n\t\tn.free()\n\tprint("HIERARCHY_GODOT_TRS="+JSON.stringify(rows))\n\tquit()\n`);
  const result=spawnSync('godot',['--headless','--path',dir,'--script',resolve(dir,'probe.gd')],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr+result.stdout);const payload=result.stdout.split('\n').find(l=>l.startsWith('HIERARCHY_GODOT_TRS='));assert.ok(payload,result.stdout);
  const rows=JSON.parse(payload.split('=')[1]);rows.forEach((r,i)=>{assert.equal(r.rotation_order,2,'Godot YXZ is enum 2');near(r.matrix,matrix(trs(...cases[i])),2e-5);});
});
test('expansion and depth budgets are enforced regardless of node insertion order',()=>{
  let m=fixtures();for(let i=0;i<34;i++)m.resources.scene.nodes['deep'+i]=node('deep'+i,i?'deep'+(i-1):'root');assert.throws(()=>prepareManifest(m,allowed),/hierarchy_depth_exceeded/);
  m=fixtures();for(let i=0;i<401;i++)m.resources.scene.nodes['wide'+i]=node('wide'+i);assert.throws(()=>prepareManifest(m,allowed),/too_many_local_nodes/);
  m=fixtures();for(let i=0;i<100;i++)m.resources.sign.nodes['leaf'+i]=node('leaf'+i);m=prepareManifest(m,allowed);
  for(let i=0;i<50;i++)m.resources.scene.instances['wide'+i]={instance_id:'wide'+i,prefab_id:'sign',prefab_revision:m.resources.sign.version,parent_id:'root',transform:identityTransform(),overrides:[]};assert.throws(()=>prepareManifest(m,allowed),/expanded_node_limit/);
  m=fixtures();for(const scale of [[0,1,1],[-1,1,1],[Infinity,1,1]]){const input=structuredClone(m);input.resources.scene.instances.a.transform.scale=scale;assert.throws(()=>prepareManifest(input,allowed));}
});
test('component variant/deleted field conflicts and behavior script overrides cannot bypass asset access',()=>{
  let m=fixtures();m.resources.house.nodes.door.components.collider={shape:'box',size:[1,2,3]};m.resources.house.nodes.door.components.behaviors=[];m=prepareManifest(m,allowed);
  let plan=previewInstanceUpgrade(m,'scene','a',m.resources.house.version);m=op(m,{type:'upgrade_instance',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,prefab_revision:m.resources.house.version,expected_preview_hash:plan.preview_hash});
  m=op(m,{type:'set_override',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,override:{target:nodeTarget('door'),path:['components','collider','size'],value:[2,3,4]}});
  m=op(m,{type:'patch_node',resource_id:'house',node_id:'door',expected_version:m.resources.house.nodes.door.version,patch:{components:{...m.resources.house.nodes.door.components,collider:{shape:'trimesh',size:[1,2,3]}}}});
  plan=previewInstanceUpgrade(m,'scene','a',m.resources.house.version);assert.equal(plan.conflicts[0].reason,'component_variant_changed');
  const script='c'.repeat(64);assert.throws(()=>applyHierarchyOps(m,[{type:'set_override',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,override:{target:nodeTarget('door'),path:['components','behaviors'],value:[{id:'logic',api:1,script_hash:script,script_url:`/preview-assets/${script}.gd`,properties:{}}]}}],()=>false),/不能访问/);
});
test('subtree deletion undo includes instance mounts; forged restore operations are rejected',t=>{
  const {current,apply}=setup(t);apply([{type:'migrate_hierarchy'}],{expected_head:current().head});let doc=current().manifest.resources.scene;
  apply([{type:'put_node',resource_id:'scene',node_id:'parent',expected_version:null,node:node('parent',doc.root_id)},{type:'put_node',resource_id:'scene',node_id:'child',expected_version:null,node:node('child','parent')}]);
  doc=current().manifest.resources.scene;assert.throws(()=>apply([{type:'delete_node',resource_id:'scene',node_id:'parent',expected_version:doc.nodes.parent.version}]),/cascade/);
  const removed=apply([{type:'delete_node',resource_id:'scene',node_id:'parent',expected_version:doc.nodes.parent.version,cascade:true}]);assert.equal(current().manifest.resources.scene.nodes.child,undefined);
  assert.throws(()=>apply([{...removed.inverse[0],document:{...removed.inverse[0].document,name:'tampered'}}]),/原始逆操作/);apply(removed.inverse);assert.equal(current().manifest.resources.scene.nodes.child.parent_id,'parent');
});
test('source/applied/frozen adapters use their supplied fixed manifest and preserve old version identity',async()=>{
  const {resolveObjectReference,assertHierarchyRuntimeCompatibility}=await import('../../services/creation/hierarchy-references.mjs');
  const manifest=fixtures(),address={project_id:'p',branch_id:'b',resource_id:'scene',instance_path:['a'],definition_node_id:'door'};
  const reference={manifest,source_revision:'fixed',domain:'frozen',project_id:'p',branch_id:'b',observation:{source_revision:'fixed',world_id:'w',epoch:1,sequence:7,inspection_id:'i',object_world_matrix:matrix(trs([90,10,20]))}};
  assert.equal(resolveObjectReference(reference,address).source_revision,'fixed');near(resolveObjectReference(reference,address).observed_pose.world_position,[90,10,20]);near(resolveObjectReference(reference,address).source_pose.world_position,[0,1,2]);
  assert.throws(()=>resolveObjectReference({...reference,source_revision:'latest'},address),/观察基线/);
  assert.throws(()=>resolveObjectReference(reference,{...address,instance_path:['missing']}),/已删除/);
  assert.throws(()=>assertHierarchyRuntimeCompatibility(manifest),/尚不支持/);assert.doesNotThrow(()=>assertHierarchyRuntimeCompatibility({schema:'creation-flat-1'}));
});
test('already-forked flat branches can opt in separately and compare a deterministic migrated ancestor',t=>{
  const {store,user,p,current,apply}=setup(t);store.fork(user,p,{from_branch:'main',branch_id:'old-branch',expected_head:current().head});
  apply([{type:'migrate_hierarchy'}],{expected_head:current().head});
  assert.throws(()=>store.mergePreview(user,p,'main',{source_branch_id:'old-branch'}),/显式迁移/);
  apply([{type:'migrate_hierarchy'}],{expected_head:current('old-branch').head},'old-branch');
  apply([{type:'patch_node',resource_id:'scene',node_id:'legacy',expected_version:current('old-branch').manifest.resources.scene.nodes.legacy.version,patch:{color:'#ff0000'}}],{},'old-branch');
  const preview=store.mergePreview(user,p,'main',{source_branch_id:'old-branch'});assert.equal(preview.conflicts.length,0);store.merge(user,p,'main',{preview_id:preview.id});assert.equal(current().manifest.resources.scene.nodes.legacy.color,'#ff0000');
});
test('prefab archive remains fixed across branch merge and unchanged instances keep their version',t=>{
  const {store,user,p,current,apply}=setup(t);apply([{type:'migrate_hierarchy'}],{expected_head:current().head});const prefab=emptyDocument('house','prefab');prefab.nodes.door=node('door');
  apply([{type:'create_resource',resource_id:'house',resource:prefab}]);const pin=current().manifest.resources.house.version;
  apply([{type:'instantiate_prefab',resource_id:'scene',instance_id:'a',expected_version:null,instance:{instance_id:'a',prefab_id:'house',prefab_revision:pin,parent_id:current().manifest.resources.scene.root_id,transform:identityTransform(),overrides:[]}}]);
  const old=structuredClone(current().manifest.prefab_revisions[pin]);store.fork(user,p,{from_branch:'main',branch_id:'prefab-edit',expected_head:current().head});
  apply([{type:'patch_node',resource_id:'house',node_id:'door',expected_version:current('prefab-edit').manifest.resources.house.nodes.door.version,patch:{name:'new door'}}],{},'prefab-edit');
  const preview=store.mergePreview(user,p,'main',{source_branch_id:'prefab-edit'});store.merge(user,p,'main',{preview_id:preview.id});assert.deepEqual(current().manifest.prefab_revisions[pin],old);assert.equal(current().manifest.resources.scene.instances.a.prefab_revision,pin);
  assert.equal(row(current().manifest,'scene',['a'],'door').node.name,'door');assert.equal(current().manifest.resources.house.nodes.door.name,'new door');
});
test('moving an entire nested prefab carries children, and mount reparent preserves world pose',()=>{
  let m=fixtures();const before=row(m,'scene',['a','sign'],'sign').world_position;
  m=op(m,{type:'patch_instance',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,patch:{transform:trs([5,3,-4],[0,90,0],[2,3,4])}});
  near(row(m,'scene',['a','sign'],'sign').world_position,[9,9,-4]);assert.deepEqual(row(m,'scene',['b','sign'],'sign').world_position,[10,5,1]);assert.deepEqual(before,[0,2,1]);
  m.resources.scene.nodes.mountParent=node('mountParent','root',trs([6,7,8],[20,30,40],[2,2,2]));m=prepareManifest(m,allowed);
  const old=row(m,'scene',[],'root'),parent=row(m,'scene',[],'mountParent'),pose=row(m,'scene',['a','sign'],'sign').world_matrix;
  m=op(m,{type:'reparent_instance',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,parent_id:'mountParent',keep_world:true,expected_old_parent_version:old.node.version,expected_ancestry_hash:old.ancestry_hash,expected_parent_version:parent.node.version,expected_parent_ancestry_hash:parent.ancestry_hash});near(row(m,'scene',['a','sign'],'sign').world_matrix,pose);
});
test('fixed archive and content survive a real SQLite close/reopen',t=>{
  const {store,user,p,current,apply,dir}=setup(t);apply([{type:'migrate_hierarchy'}],{expected_head:current().head});apply([{type:'create_resource',resource_id:'prefab',resource:emptyDocument('prefab','prefab')}]);
  const expected=current();store.close();const reopened=new CreationStore(resolve(dir,'state.sqlite'));try{assert.deepEqual(reopened.branchView(user,p,'main'),expected);}finally{reopened.close();}
});
test('nested instance world-space editing fences external ancestors and preserves other instances',()=>{
  let m=fixtures();const stale=row(m,'scene',['a','sign'],'sign');
  m=op(m,{type:'patch_node',resource_id:'scene',node_id:'root',expected_version:m.resources.scene.nodes.root.version,patch:{transform:trs([4,6,8])}});
  const operation={type:'set_override_world_transform',resource_id:'scene',instance_id:'a',expected_version:m.resources.scene.instances.a.version,target:{instance_path:['sign'],definition_node_id:'sign'},expected_object_version:stale.object_version,expected_ancestry_hash:stale.ancestry_hash,world_transform:trs([12.5,3,-8.25])};
  assert.throws(()=>op(m,operation),/祖先/);const current=row(m,'scene',['a','sign'],'sign'),other=row(m,'scene',['b','sign'],'sign').world_matrix;
  m=op(m,{...operation,expected_object_version:current.object_version,expected_ancestry_hash:current.ancestry_hash});near(row(m,'scene',['a','sign'],'sign').world_position,[12.5,3,-8.25]);near(row(m,'scene',['b','sign'],'sign').world_matrix,other);
});
test('migration retains all 400 legacy objects in addition to the new hierarchy root',()=>{
  const flat={schema:'creation-flat-1',entry_scene_id:'full',resources:{full:{id:'full',kind:'scene',name:'满容量旧文档',version:'legacy',objects:Array.from({length:400},(_,i)=>({id:'object-'+i,name:'节点'+i,kind:'anchor',position:[i,3,0],rotation:[0,0,0],scale:[1,1,1],components:{},color:'#74d5cd',solid:false}))}}};
  const migrated=migrateFlatManifest(flat,allowed);assert.equal(Object.keys(migrated.resources.full.nodes).length,401);assert.equal(migrated.resources.full.nodes['object-399'].transform.position[0],399);
});
