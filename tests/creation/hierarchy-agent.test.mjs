import test from 'node:test';
import assert from 'node:assert/strict';
import { targetFromAttachment,targetsForOperations,resolvePublicTarget,worldApiGuide } from '../../services/creation/hierarchy-agent.mjs';
import { HIERARCHY_SCHEMA,emptyDocument,prepareManifest,resolveScene,scopedAddressKey } from '../../services/creation/hierarchy.mjs';
import { applyHierarchyOps } from '../../services/creation/hierarchy-operations.mjs';
import { hierarchyRuntimeId } from '../../services/creation/hierarchy-view.mjs';
import { identityTransform } from '../../packages/scene/transform.mjs';
import { hash } from '../../services/creation/schema.mjs';
const scope={project_id:'p',branch_id:'main',resource_id:'scene'},clone=structuredClone;
const node=(id,parent='root')=>({id,name:'同名门',kind:'anchor',parent_id:parent,transform:identityTransform(),solid:false,components:{},color:'#74d5cd'});
const address=(path,id)=>({...scope,instance_path:path,definition_node_id:id});
function fixture(){
  const scene=emptyDocument('scene'),house=emptyDocument('house','prefab'),door=emptyDocument('door','prefab');scene.nodes.parent={...node('parent'),name:'Parent'};scene.nodes.child=node('child','parent');door.nodes.door=node('door');
  let m=prepareManifest({schema:HIERARCHY_SCHEMA,entry_scene_id:'scene',resources:{scene,house,door},prefab_revisions:{}},()=>true);
  const mount=(iid,prefab)=>({instance_id:iid,prefab_id:prefab,prefab_revision:m.resources[prefab].version,parent_id:'root',transform:identityTransform(),overrides:[]});
  m.resources.house.instances.inner=mount('inner','door');m=prepareManifest(m,()=>true);
  m.resources.scene.instances.left={...mount('left','house'),parent_id:'parent'};m.resources.scene.instances.right=mount('right','house');return prepareManifest(m,()=>true);
}
const locate=(m,a)=>resolveScene(m,a.resource_id,a).find(r=>scopedAddressKey(r.address)===scopedAddressKey(a));
const key=t=>scopedAddressKey(t.address);
test('fixed nested attachment metadata survives without source lookup or private snapshot leakage',()=>{
  const a=address(['left','inner'],'door'),attachment={id:'a',...scope,address:a,revision:'old-source',object_version:'old-object',resource_version:'old-resource',definition_revision:'old-definition',snapshot:{secret:'private'},position:[9,8,7]};
  const t=targetFromAttachment(attachment,scope);assert.deepEqual(t.address,a);assert.equal(t.object_id,null);assert.equal(t.source_revision,'old-source');assert.equal(t.object_version,'old-object');assert.equal(t.resource_version,'old-resource');assert.equal(t.definition_revision,'old-definition');assert.equal(t.snapshot,undefined);assert.equal(t.position,undefined);
  attachment.address.instance_path[0]='changed';assert.equal(t.address.instance_path[0],'left');assert.throws(()=>targetFromAttachment({...attachment,branch_id:'other'},scope),/身份|作用域/);
});
test('two same-name nested doors retain distinct canonical addresses and A runtime IDs',()=>{
  const m=fixture(),a=address(['left','inner'],'door'),b=address(['right','inner'],'door');
  const left=resolvePublicTarget(m,scope,{address:a}),right=resolvePublicTarget(m,scope,{address:b});assert.notEqual(left.runtimeId,right.runtimeId);assert.equal(left.runtimeId,hierarchyRuntimeId(a));assert.deepEqual(left.address,a);assert.deepEqual(Object.keys(left).sort(),['address','contentFingerprint','runtimeId'].sort());assert.match(left.contentFingerprint,/^[a-f0-9]{64}$/);
});
test('mount transform targets every nested descendant and changes their fingerprints without changing another instance',()=>{
  const m=fixture(),op={type:'patch_instance',resource_id:'scene',instance_id:'left',expected_version:m.resources.scene.instances.left.version,patch:{transform:{...identityTransform(),position:[6,0,0]}}};
  const before=targetsForOperations(m,scope,[op],'before');assert.ok(before.length>=3);assert.ok(before.every(t=>t.address.instance_path[0]==='left'));assert.ok(before.some(t=>key(t)===scopedAddressKey(address(['left','inner'],'door'))));
  const next=applyHierarchyOps(m,[op],()=>true).manifest;
  for(const t of before)assert.notEqual(resolvePublicTarget(m,scope,t).contentFingerprint,resolvePublicTarget(next,scope,t).contentFingerprint);
  assert.deepEqual(resolvePublicTarget(m,scope,{address:address(['right','inner'],'door')}),resolvePublicTarget(next,scope,{address:address(['right','inner'],'door')}));
});
test('ordinary ancestor transform includes mounted descendants; field override stays at complete addressed node',()=>{
  const m=fixture(),parent={type:'patch_node',resource_id:'scene',node_id:'parent',patch:{transform:identityTransform()}};
  const all=targetsForOperations(m,scope,[parent],'src');assert.ok(all.some(t=>key(t)===scopedAddressKey(address(['left','inner'],'door'))));assert.ok(all.some(t=>t.object_id==='child'));assert.ok(!all.some(t=>t.address.instance_path[0]==='right'));
  const override={type:'set_override',resource_id:'scene',instance_id:'left',override:{target:{instance_path:['inner'],definition_node_id:'door'},path:['name'],value:'另一个门'}};
  const exact=targetsForOperations(m,scope,[override],'src');assert.equal(exact.length,1);assert.deepEqual(exact[0].address,address(['left','inner'],'door'));assert.equal(exact[0].object_version,locate(m,exact[0].address).object_version);
});
test('deletion retains pre-transaction targets; deleted objects resolve null instead of another same-name door',()=>{
  const m=fixture(),op={type:'delete_instance',resource_id:'scene',instance_id:'left',expected_version:m.resources.scene.instances.left.version};const old=targetsForOperations(m,scope,[op],'old');const next=applyHierarchyOps(m,[op],()=>true).manifest;
  assert.ok(old.length);assert.deepEqual(targetsForOperations(next,scope,[op],'new'),[]);assert.ok(old.every(t=>resolvePublicTarget(next,scope,t)===null));assert.ok(resolvePublicTarget(next,scope,{address:address(['right','inner'],'door')}));
  const nodeDelete={type:'delete_node',resource_id:'scene',node_id:'child',expected_version:m.resources.scene.nodes.child.version},deleted=applyHierarchyOps(m,[nodeDelete],()=>true).manifest;
  const absent=targetsForOperations(deleted,scope,[nodeDelete],'deleted')[0];assert.equal(absent.missing,true);assert.equal(absent.object_version,null);assert.equal(resolvePublicTarget(deleted,scope,absent),null);
});
test('flat historical target and old content hash semantics stay unchanged; no implicit hierarchy migration',()=>{
  const object={id:'old-door',name:'门',position:[1,2,3],rotation:[0,15,0],scale:[1,1,1],solid:false,version:'v1'},m={schema:'creation-flat-1',resources:{scene:{id:'scene',version:'resource-old',objects:[object]}}};
  const target=targetFromAttachment({...scope,object_id:'old-door',revision:'flat-old',object_version:'v1'},scope);assert.deepEqual(target.address,address([],'old-door'));assert.equal(target.resource_version,null);assert.equal(target.definition_revision,null);assert.equal(target.source_revision,'flat-old');
  const content=clone(object);delete content.version;const old=resolvePublicTarget(m,scope,target);assert.equal(old.contentFingerprint,hash(content));assert.equal(old.runtimeId,'old-door');
  const next=clone(m);next.resources.scene.objects[0].version='v2';assert.deepEqual(resolvePublicTarget(next,scope,target),old);assert.equal(resolvePublicTarget(m,scope,{address:address(['fake'],'old-door')}),null);
  assert.equal(targetsForOperations(m,scope,[{type:'patch_object',resource_id:'scene',object_id:'old-door'}],'flat-old')[0].object_version,'v1');assert.equal(m.schema,'creation-flat-1');
});
test('new prefab directory draft does not change fixed instances; explicit new fixed dependency changes fingerprint',()=>{
  const m=fixture(),a={address:address(['left','inner'],'door')},before=resolvePublicTarget(m,scope,a),draft=clone(m);
  draft.resources.door.nodes.other=node('other');const newer=prepareManifest(draft,()=>true);assert.deepEqual(resolvePublicTarget(newer,scope,a),before);
  const change=clone(newer);change.resources.house.instances.inner.prefab_revision=change.resources.door.version;const outer=prepareManifest(change,()=>true);outer.resources.scene.instances.left.prefab_revision=outer.resources.house.version;const upgraded=prepareManifest(outer,()=>true);
  assert.notEqual(resolvePublicTarget(upgraded,scope,a).contentFingerprint,before.contentFingerprint);
});
test('scope and schema gates fail closed, and WORLD-API matches each source schema',()=>{
  const m=fixture();assert.throws(()=>targetsForOperations(m,scope,[{type:'patch_node',resource_id:'other',node_id:'door'}],'src'),/资源分组/);assert.throws(()=>resolvePublicTarget(m,scope,{address:{...address([],'child'),branch_id:'other'}}),/作用域/);
  const h2=worldApiGuide(m),flat=worldApiGuide({schema:'creation-flat-1'});assert.match(h2,/set_override_world_transform/);assert.match(h2,/expected_object_version/);assert.match(h2,/world shear/);assert.match(h2,/creation-hierarchy-2/);assert.match(flat,/creation-flat-1/);assert.match(flat,/patch_object/);assert.match(flat,/separate sole-op/);assert.throws(()=>worldApiGuide({schema:'unknown'}),/不支持/);
});
