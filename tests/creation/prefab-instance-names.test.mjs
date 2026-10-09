import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {HIERARCHY_SCHEMA,emptyDocument,prepareManifest,resolveScene,normalizeInstance} from '../../services/creation/hierarchy.mjs';
import {applyHierarchyOps} from '../../services/creation/hierarchy-operations.mjs';
import {identityTransform} from '../../packages/scene/transform.mjs';
import {numberedInstanceName} from '../../services/creation/instance-names.mjs';

const anchor=(id,name)=>({id,name,kind:'anchor',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],components:{},solid:false});
function fixture(t,hierarchy=false){
  const directory=mkdtempSync(resolve(tmpdir(),'atelier-prefab-names-')),store=new CreationStore(resolve(directory,'creation.sqlite'));
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const user=store.register({name:'Name test',password:'test-password-long-enough'}).user;
  const manifest={schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]},other:{id:'other',kind:'scene',name:'Other',objects:[]},plant:{id:'plant',kind:'prefab',name:'豌豆射手',objects:[anchor('body','豌豆射手'),anchor('leaf','叶片')]}}};
  const project=store.createProject(user,{name:'Isolated instance names'},manifest).project.id;let serial=0;
  const current=()=>store.branchView(user,project,'main');
  const apply=(ops,extra={})=>store.apply(user,project,'main',{transaction_id:`names-${++serial}`,base_revision:current().head,ops,...extra});
  if(hierarchy){
    const resources={scene:emptyDocument('scene','scene','Scene'),other:emptyDocument('other','scene','Other'),plant:emptyDocument('plant','prefab','豌豆射手')};
    resources.plant.nodes.body={id:'body',name:'身体',parent_id:'root',kind:'anchor',transform:identityTransform(),components:{},solid:false};
    const fixed=prepareManifest({schema:HIERARCHY_SCHEMA,entry_scene_id:'scene',resources,prefab_revisions:{}}),revision=store.writeRevision(project,[current().head],fixed,user.id);
    store.put('creator_branch',{...store.get('creator_branch',`${project}:main`),head:revision.id});
  }
  const spawn=(id,extra={},rid='scene')=>({type:'instantiate_prefab',resource_id:rid,instance_id:id,expected_version:null,instance:{instance_id:id,prefab_id:'plant',prefab_revision:current().manifest.resources.plant.version,parent_id:'root',transform:identityTransform(),overrides:[],...extra}});
  const put=(id,extra={},rid='scene')=>({type:'put_object',resource_id:rid,object_id:id,expected_version:null,object:{...anchor(id,'豌豆射手'),prefab:'plant',prefab_node_id:'body',...extra}});
  return{store,user,project,current,apply,spawn,put};
}

test('hierarchy creation allocates unique local names in one transaction, concurrent baselines and exact replay',t=>{
  const f=fixture(t,true),base=f.current().head,pin=f.current().manifest.resources.plant.version;
  f.apply([f.spawn('a'),f.spawn('b')]);
  const input={transaction_id:'stale-baseline-create',base_revision:base,ops:[f.spawn('c')]};
  const first=f.store.apply(f.user,f.project,'main',input),replayed=f.store.apply(f.user,f.project,'main',input);
  assert.equal(replayed.replayed,true);assert.equal(replayed.revision,first.revision);
  const instances=f.current().manifest.resources.scene.instances;assert.deepEqual(Object.values(instances).map(i=>i.name),['豌豆射手 1','豌豆射手 2','豌豆射手 3']);
  assert.ok(Object.values(instances).every(i=>i.prefab_revision===pin));assert.equal(f.current().manifest.resources.plant.version,pin);
  f.apply([f.spawn('elsewhere',{},'other')]);assert.equal(f.current().manifest.resources.other.instances.elsewhere.name,'豌豆射手 1');
});

test('hierarchy rename edits one mount and clears its legacy root name override, with exact undo',t=>{
  const f=fixture(t,true),pin=f.current().manifest.resources.plant.version;
  f.apply([f.spawn('a'),f.spawn('b')]);
  let a=f.current().manifest.resources.scene.instances.a;
  f.apply([{type:'set_override',resource_id:'scene',instance_id:'a',expected_version:a.version,override:{target:{instance_path:[],definition_node_id:'root'},path:['name'],value:'旧覆盖名'}}]);
  a=f.current().manifest.resources.scene.instances.a;const before=structuredClone(a);
  const renamed=f.apply([{type:'patch_instance',resource_id:'scene',instance_id:'a',expected_version:a.version,patch:{name:'西侧守卫'}}]);
  const rows=resolveScene(f.current().manifest,'scene'),root=id=>rows.find(r=>r.address.instance_path.join('/')===id&&r.node.id==='root');
  assert.equal(root('a').node.name,'西侧守卫');assert.equal(root('b').node.name,'豌豆射手 2');
  const current=f.current().manifest.resources.scene.instances.a;assert.deepEqual(current.transform,before.transform);assert.deepEqual(current.overrides,[]);assert.equal(current.prefab_revision,pin);
  assert.equal(f.current().manifest.resources.plant.version,pin);assert.equal(f.current().manifest.resources.plant.nodes.root.name,'豌豆射手');
  assert.throws(()=>f.apply([{type:'patch_instance',resource_id:'scene',instance_id:'a',expected_version:a.version,patch:{name:'stale'}}]),{status:409});
  f.apply(renamed.inverse);assert.deepEqual(f.current().manifest.resources.scene.instances.a,before);
});

test('hierarchy delete and undo preserve custom/generated names and historical unnamed instance hashes',t=>{
  const f=fixture(t,true);f.apply([f.spawn('a',{name:'明确自定名'}),f.spawn('b')]);
  const before=structuredClone(f.current().manifest.resources.scene.instances);
  const deleted=f.apply([{type:'delete_instance',resource_id:'scene',instance_id:'b',expected_version:before.b.version}]);f.apply(deleted.inverse);
  assert.deepEqual(f.current().manifest.resources.scene.instances,before);
  const legacy=normalizeInstance(f.spawn('legacy').instance);assert.equal(legacy.name,undefined);
  let manifest=structuredClone(f.current().manifest);manifest.resources.scene.instances.legacy=legacy;manifest=prepareManifest(manifest);
  const removed=applyHierarchyOps(manifest,[{type:'delete_instance',resource_id:'scene',instance_id:'legacy',expected_version:legacy.version}],()=>true);
  const restored=applyHierarchyOps(removed.manifest,removed.inverse,()=>true);assert.deepEqual(restored.manifest.resources.scene.instances.legacy,legacy);
});

test('flat prefab nodes allocate by source node name and preserve custom rename, replay and deletion undo',t=>{
  const f=fixture(t),base=f.current().head;
  const first=f.apply([f.put('a'),f.put('b'),f.put('leaf',{name:'叶片',prefab_node_id:'leaf'}),f.put('custom',{name:'前排守卫'})]);
  assert.deepEqual(first.branch.manifest.resources.scene.objects.map(o=>o.name),['豌豆射手 1','豌豆射手 2','叶片 1','前排守卫']);
  const input={transaction_id:'flat-concurrent',base_revision:base,ops:[f.put('c')]};const one=f.store.apply(f.user,f.project,'main',input);assert.equal(f.store.apply(f.user,f.project,'main',input).revision,one.revision);
  let a=f.current().manifest.resources.scene.objects.find(o=>o.id==='a');
  f.apply([{type:'patch_object',resource_id:'scene',object_id:'a',expected_version:a.version,patch:{name:'河边守卫'}}]);
  a=f.current().manifest.resources.scene.objects.find(o=>o.id==='a');const deletion=f.apply([{type:'delete_object',resource_id:'scene',object_id:'a',expected_version:a.version}]);f.apply(deletion.inverse);
  const restored=f.current().manifest.resources.scene.objects.find(o=>o.id==='a');assert.notEqual(restored.version,a.version);assert.deepEqual({...restored,version:undefined},{...a,version:undefined});assert.equal(f.current().manifest.resources.scene.objects.find(o=>o.id==='c').name,'豌豆射手 3');
  assert.deepEqual(f.current().manifest.resources.plant.objects.map(o=>o.name),['豌豆射手','叶片']);
});

test('number allocation avoids existing node names and limits long names without losing suffix',()=>{
  assert.equal(numberedInstanceName('豌豆射手',['豌豆射手 1','豌豆射手 2']),'豌豆射手 3');
  assert.equal(numberedInstanceName('豌豆射手',['豌豆射手 1','豌豆射手 7']),'豌豆射手 8');
  const first=numberedInstanceName('长'.repeat(160),[]),second=numberedInstanceName('长'.repeat(160),[first]);
  assert.equal(first.length,160);assert.equal(second.length,160);assert.ok(second.endsWith(' 2'));
});
