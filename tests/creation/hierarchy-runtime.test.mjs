import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {packHierarchyRuntime} from '../../services/creation/hierarchy-runtime.mjs';
import {HIERARCHY_SCHEMA,emptyDocument,resolveScene,migrateFlatManifest,addressKey} from '../../services/creation/hierarchy.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {matrix,multiply} from '../../packages/scene/transform.mjs';
import {hierarchyRuntimeSource,trs,anchor,prepare,mount} from '../fixtures/hierarchy-runtime-source.mjs';
const options={project_id:'project-fixture',branch_id:'main',resource_id:'scene',source_revision:'source-fixture-v1',assetAllowed:()=>true};
const pack=(m=hierarchyRuntimeSource(),extra={})=>packHierarchyRuntime(m,{...options,...extra});
const at=(p,path,id)=>p.objects.find(o=>addressKey(o.address)===addressKey({instance_path:path,definition_node_id:id}));
const near=(actual,expected)=>{assert.equal(actual.length,expected.length);actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-8,`${i}: ${v} != ${expected[i]}`));};
const simple=()=>({schema:HIERARCHY_SCHEMA,entry_scene_id:'scene',resources:{scene:emptyDocument('scene')},prefab_revisions:{}});
const failWith=code=>e=>e.status===422&&e.message===code;

test('mount and prefab-root transforms both survive; full resolver rows and source are preserved',()=>{
  const m=hierarchyRuntimeSource(),before=structuredClone(m),p=pack(m),root=at(p,['a'],'root'),door=at(p,['a'],'door');
  const mountA=p.mounts.find(x=>x.address.instance_path.join('/')==='a');
  near(mountA.world_position,[11,3,1]);near(root.world_position,[11,9,1]);near(door.world_position,[19,9,1]);
  near(at(p,['a','sign'],'tip').world_position,[21,11,0]);
  assert.deepEqual(root.parent,{kind:'mount',id:mountA.id});assert.equal(root.parent_key,at(p,[],'carrier').key);
  assert.deepEqual(mountA.parent,{kind:'object',id:'carrier'});assert.equal(mountA.ancestry_hash,root.ancestry_hash);
  for(const row of resolveScene(m,'scene',options)) {
    const actual=at(p,row.address.instance_path,row.address.definition_node_id);
    for(const [key,value]of Object.entries(row))assert.deepEqual(actual[key],value,key);
    assert.equal(actual.address.project_id,options.project_id);assert.equal(actual.address.branch_id,options.branch_id);
  }
  assert.deepEqual(m,before);
});

test('consumer can rebuild every world matrix from assembly_order and local TRS alone',()=>{
  const p=pack(),maps={object:new Map(p.objects.map(o=>[o.id,o])),mount:new Map(p.mounts.map(o=>[o.id,o]))},built=new Map();
  for(const ref of p.assembly_order) {
    const key=ref.kind+':'+ref.id,entry=maps[ref.kind].get(ref.id);assert.ok(entry);assert.ok(!built.has(key));
    let world=matrix(entry.local_transform);
    if(entry.parent){const parent=built.get(entry.parent.kind+':'+entry.parent.id);assert.ok(parent,'parent must already exist');world=multiply(parent,world);near(parent,entry.parent_world_matrix);}
    near(world,entry.world_matrix);built.set(key,world);
  }
  assert.equal(built.size,p.objects.length+p.mounts.length);
});

test('stable runtime IDs survive source revision, ancestor motion, override and pinned-definition upgrade',()=>{
  let m=hierarchyRuntimeSource();const first=pack(m),old=at(first,['a'],'door');
  m.resources.scene.nodes.carrier.transform=trs([15,1,0],[0,90,0],[2,2,2]);m=prepare(m);
  const moved=pack(m,{source_revision:'source-fixture-v2'});assert.equal(at(moved,['a'],'door').id,old.id);
  assert.notEqual(at(moved,['a'],'door').ancestry_hash,old.ancestry_hash);
  m.resources.house.nodes.door.name='upgraded';m=prepare(m);
  const pinned=pack(m);assert.equal(at(pinned,['a'],'door').definition_revision,old.definition_revision);
  m.resources.scene.instances.a.prefab_revision=m.resources.house.version;
  m.resources.scene.instances.a.overrides=[{target:{instance_path:[],definition_node_id:'door'},path:['color'],value:'#ff0000'}];m=prepare(m);
  const upgraded=pack(m),a=at(upgraded,['a'],'door');assert.equal(a.id,old.id);assert.equal(a.node.id,'door');
  assert.equal(a.node.color,'#ff0000');assert.equal(at(upgraded,['b'],'door').node.color,old.node.color);
  assert.notEqual(a.object_version,old.object_version);assert.notEqual(a.node.version,a.definition_node_version);
  assert.equal(first.mounts.find(x=>x.instance_id==='a').id,upgraded.mounts.find(x=>x.instance_id==='a').id);
});

test('flat migration keeps every original state key, including all 400 content objects',()=>{
  const objects=Array.from({length:400},(_,i)=>({id:'old-'+i,name:'old '+i,kind:'anchor',position:[i,0,0],rotation:[0,0,0],scale:[1,1,1],components:{}}));
  const flat={schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',name:'Legacy',kind:'scene',version:'old-doc',objects}}};
  const p=pack(migrateFlatManifest(flat,()=>true));assert.equal(p.objects.length,401);assert.equal(p.mounts.length,0);
  for(const old of objects)assert.equal(at(p,[],old.id).id,old.id);
});

test('effective fixed asset closure excludes superseded and unrelated inputs and enforces asset permissions',()=>{
  const oldModel='a'.repeat(64),newModel='b'.repeat(64),oldScript='c'.repeat(64),newScript='d'.repeat(64),unused='e'.repeat(64);
  const behavior=h=>({id:'logic',api:1,script_hash:h,script_url:`/preview-assets/${h}.gd`,properties:{counter:1}});
  let m=simple(),prefab=emptyDocument('asset-prefab','prefab'),unusedDoc=emptyDocument('unused','prefab');
  prefab.nodes.model=anchor('model','root',trs(),{kind:'model',model_hash:oldModel,model_url:`/preview-assets/${oldModel}.glb`,components:{behaviors:[behavior(oldScript)]}});
  unusedDoc.nodes.model=anchor('model','root',trs(),{kind:'model',model_hash:unused,model_url:`/preview-assets/${unused}.glb`});
  m.resources[prefab.id]=prefab;m.resources.unused=unusedDoc;m=prepare(m);
  m.resources.scene.instances.a=mount('a',m.resources[prefab.id],'root',trs(),[
    {target:{instance_path:[],definition_node_id:'model'},path:['model_hash'],value:newModel},
    {target:{instance_path:[],definition_node_id:'model'},path:['model_url'],value:`/preview-assets/${newModel}.glb`},
    {target:{instance_path:[],definition_node_id:'model'},path:['components','behaviors'],value:[behavior(newScript)]}]);m=prepare(m);
  const accesses=[],p=pack(m,{assetAllowed:(h,ext)=>{accesses.push([h,ext]);return [newModel,newScript].includes(h);}});
  assert.deepEqual(p.asset_closure.map(a=>[a.hash,a.extension]),[[newScript,'gd'],[newModel,'glb']]);
  assert.deepEqual(new Set(accesses.map(a=>a[0])),new Set([newModel,newScript]));
  assert.deepEqual(p.prefab_closure,[{resource_id:prefab.id,revision:m.resources[prefab.id].version}]);
  assert.throws(()=>pack(m,{assetAllowed:()=>false}),/不能访问/);
  assert.throws(()=>pack(m,{assetAllowed:()=>Promise.resolve(true)}),/不能访问/);
  assert.throws(()=>pack(m,{assetAllowed:undefined}),failWith('runtime_asset_validator_required'));
});

test('canonical output is invariant to map insertion order and serializes with a verifiable hash',()=>{
  const m=hierarchyRuntimeSource(),p=pack(m),reordered=structuredClone(m);
  reordered.resources=Object.fromEntries(Object.entries(reordered.resources).reverse());
  for(const doc of [...Object.values(reordered.resources),...Object.values(reordered.prefab_revisions)]) {
    doc.nodes=Object.fromEntries(Object.entries(doc.nodes).reverse());doc.instances=Object.fromEntries(Object.entries(doc.instances).reverse());
  }
  const other=pack(reordered);assert.deepEqual(other,p);
  const json=JSON.parse(JSON.stringify(p)),{pack_hash,...payload}=json;assert.deepEqual(json,p);assert.equal(pack_hash,hash(payload));
  assert.notEqual(pack(m,{source_revision:'different-fixed-revision'}).pack_hash,pack_hash);
  const scoped=pack(m,{branch_id:'another-branch'});assert.notEqual(scoped.pack_hash,pack_hash);assert.equal(at(scoped,['a'],'door').id,at(p,['a'],'door').id);
});

test('runtime expansion budget counts group roots and mounts: accepts 1000, rejects 1001 atomically',()=>{
  let m=simple(),prefab=emptyDocument('wide','prefab');for(let i=0;i<330;i++)prefab.nodes['n'+i]=anchor('n'+i);
  m.resources.wide=prefab;m=prepare(m);
  for(const id of ['a','b','c'])m.resources.scene.instances[id]=mount(id,m.resources.wide);
  for(let i=0;i<3;i++)m.resources.scene.nodes['extra'+i]=anchor('extra'+i);m=prepare(m);
  const p=pack(m);assert.equal(p.objects.length+p.mounts.length,1000);
  m.resources.scene.nodes.extra3=anchor('extra3');m=prepare(m);const before=structuredClone(m);
  assert.throws(()=>pack(m),failWith('runtime_expansion_limit'));assert.deepEqual(m,before);
});

test('world coordinate boundary includes hidden mount origins and component offsets',()=>{
  let m=simple();m.resources.scene.nodes.edge=anchor('edge','root',trs([10000,0,0]));assert.ok(pack(m));
  m.resources.scene.nodes.edge.transform.position[0]=10000.01;assert.throws(()=>pack(m),failWith('runtime_world_bounds'));
  m=simple();m.resources.scene.nodes.area=anchor('area','root',trs([9999,0,0]),{components:{trigger:{shape:'sphere',offset:[2,0,0]}}});
  assert.throws(()=>pack(m),failWith('runtime_world_bounds'));
  m=simple();const p=emptyDocument('offset-root','prefab');p.nodes.root.transform=trs([-1000,0,0]);m.resources[p.id]=p;m=prepare(m);
  m.resources.scene.instances.a=mount('a',m.resources[p.id],'root',trs([10001,0,0]));
  assert.throws(()=>pack(m),failWith('runtime_world_bounds'));
});

test('visual shear remains exact; shear box and ellipsoid Area candidates reject with full addresses',()=>{
  let m=simple();m.resources.scene.nodes.parent=anchor('parent','root',trs([0,0,0],[0,0,0],[2,1,1]));
  m.resources.scene.nodes.child=anchor('child','parent',trs([0,0,0],[0,45,0]));
  const p=pack(m);assert.equal(at(p,[],'child').world_transform,null);assert.ok(at(p,[],'child').world_matrix[8]!==0);
  for(const [kind,shape,code]of [['trigger','sphere','runtime_sphere_transform_unsupported'],['interactable','sphere','runtime_sphere_transform_unsupported'],['trigger','box','runtime_sheared_box_unsupported'],['collider','box','runtime_sheared_box_unsupported']]) {
    const candidate=structuredClone(m);candidate.resources.scene.nodes.child.components={[kind]:{shape}};
    assert.throws(()=>pack(candidate),e=>failWith(code)(e)&&e.details.address.definition_node_id==='child');
  }
  m.resources.scene.nodes.child.components={collider:{shape:'trimesh'}};assert.ok(pack(m));
  m.resources.scene.nodes.child.transform=trs();m.resources.scene.nodes.child.components={interactable:{radius:2}};
  assert.throws(()=>pack(m),failWith('runtime_sphere_transform_unsupported'));
  m.resources.scene.nodes.child.components={trigger:{shape:'box',size:[1,2,3]}};assert.ok(pack(m));
  m.resources.scene.nodes.parent.transform.scale=[2,2,2];m.resources.scene.nodes.child.components={interactable:{radius:2}};assert.ok(pack(m));
});

test('top-level collision with nested ID rejects; object/mount namespaces are independent',()=>{
  let m=hierarchyRuntimeSource(),p=pack(m),nestedId=at(p,['a'],'door').id,mountId=p.mounts[0].id;
  m.resources.scene.nodes[mountId]=anchor(mountId);assert.ok(pack(m));
  m.resources.scene.nodes[nestedId]=anchor(nestedId);assert.throws(()=>pack(m),failWith('runtime_id_collision'));
});

test('non-JSON source, tampered pinned definitions and noncanonical asset references cannot enter a pack',()=>{
  for(const value of [undefined,NaN,Infinity,new Date(),new Map()]){const m=simple();m.extra=value;assert.throws(()=>pack(m),failWith('runtime_non_json_input'));}
  let m=hierarchyRuntimeSource();const revision=m.resources.scene.instances.a.prefab_revision;m.prefab_revisions[revision].name='tampered';
  assert.throws(()=>pack(m),/immutable_prefab_hash_mismatch/);
  m=simple();m.resources.scene.nodes.bad=anchor('bad','root',trs(),{model_hash:'a'.repeat(64)});assert.throws(()=>pack(m),failWith('runtime_asset_reference'));
  m.resources.scene.nodes.bad.model_url='/preview-assets/'+('a'.repeat(64))+'.glb?cap=not-a-canonical-url';assert.throws(()=>pack(m),/不可变/);
  m=simple();m.resources.scene.nodes.bad=anchor('bad','root',trs(),{components:{interactable:{shape:'capsule'}}});assert.throws(()=>pack(m),failWith('runtime_component_shape_unsupported'));
});

test('published asset-free consumer fixture is the current canonical pack',()=>{
  const fixture=JSON.parse(readFileSync(new URL('../fixtures/hierarchy-runtime-mounts.json',import.meta.url),'utf8'));
  assert.deepEqual(fixture,pack());assert.equal(fixture.asset_closure.length,0);
});
