import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';

// Real native editor subprocesses, real source bytes, real SQLite commits.
// This checks backend engine integration, not the browser/Play delivery.
test('native source transactions preserve engine inheritance and round-trip from original files',{timeout:180000},async t=>{
  const data=mkdtempSync(join(tmpdir(),'atelier-native-engine-')),store=new CreationStore(join(data,'creation.sqlite'));
  const native=new NativeProjects({store,data,enforceIsolation:true});
  t.after(async()=>{await native.close();store.close();rmSync(data,{recursive:true,force:true});});
  const user=store.register({name:'native-engine-author',password:'independent-test-password'}).user;
  const created=store.createProject(user,{name:'Native engine integration'},{entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',objects:[]}}}),p=created.project.id;
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Native backend test"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',path:'scenes/main.tscn'},weapon:{id:'weapon',kind:'prefab',name:'Weapon',path:'prefabs/weapon.tscn'}}}),
    'scripts/weapon.gd':'extends Node3D\n@export var attack: float = 10.0\n@export var interval: float = 1.5\n',
    'prefabs/weapon.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/weapon.gd" id="1"]\n[node name="Weapon" type="Node3D"]\nscript = ExtResource("1")\ninterval = 2.0\nmetadata/wa_node_id = "weapon-root"\n[node name="Barrel" type="Node3D" parent="."]\nposition = Vector3(0,2,0)\nmetadata/wa_node_id = "barrel"\n',
    'scenes/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://prefabs/weapon.tscn" id="1"]\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id = "main-root"\n[node name="A" parent="." instance=ExtResource("1")]\nattack = 20.0\nmetadata/wa_instance_id = "a"\n[node name="B" parent="." instance=ExtResource("1")]\nmetadata/wa_instance_id = "b"\n',
  };
  const files=Object.fromEntries(Object.entries(texts).map(([path,text])=>[path,native.archive.put(text)]));
  const initial=await native.inspectFiles(files,{assignIds:true});
  const branch=store.branchFor(user,p,'main');branch.head=store.writeRevision(p,[branch.head],initial,user.id).id;store.put('creator_branch',branch);
  const current=()=>store.branchView(user,p,'main');
  const find=(manifest,rid,nodeId,instances=[])=>manifest.resources[rid].native_nodes.find(node=>node.node_id===nodeId&&JSON.stringify(node.instance_ids)===JSON.stringify(instances));
  const prop=(manifest,rid,nodeId,name,instances=[])=>find(manifest,rid,nodeId,instances).properties.find(property=>property.name===name);
  const apply=ops=>native.apply(user,p,'main',{transaction_id:'tx-'+crypto.randomUUID(),base_revision:current().head,ops});
  const set=(manifest,rid,nodeId,name,value,instances=[])=>({type:'set_native_property',resource_id:rid,target:{node_id:nodeId,instance_ids:instances},property:name,value,expected_property_version:prop(manifest,rid,nodeId,name,instances).version});
  assert.equal(prop(initial,'main','weapon-root','attack',['a']).value,20);
  assert.equal(prop(initial,'main','weapon-root','attack',['b']).value,10);
  const first=await apply([set(initial,'weapon','weapon-root','attack',15),set(initial,'weapon','weapon-root','interval',3)]);
  assert.equal(prop(first.branch.manifest,'main','weapon-root','attack',['a']).value,20);
  assert.equal(prop(first.branch.manifest,'main','weapon-root','attack',['b']).value,15);
  assert.equal(prop(first.branch.manifest,'main','weapon-root','interval',['a']).value,3);
  assert.equal(prop(first.branch.manifest,'main','weapon-root','interval',['b']).value,3);
  const reset=set(first.branch.manifest,'main','weapon-root','attack',null,['a']);reset.type='reset_native_property';delete reset.value;
  const second=await apply([reset]);assert.equal(prop(second.branch.manifest,'main','weapon-root','attack',['a']).value,15);
  assert.equal(prop(second.branch.manifest,'main','weapon-root','attack',['a']).overridden,false);
  const saved=native.archive.read(second.branch.manifest.source_files['scenes/main.tscn']).toString();assert.doesNotMatch(saved,/^attack\s*=/m);
  const again=await native.inspectFiles(second.branch.manifest.source_files);
  assert.equal(again.source_identity,second.branch.manifest.source_identity);assert.equal(again.resources.main.version,second.branch.manifest.resources.main.version);
  assert.equal(prop(again,'main','weapon-root','attack',['b']).value,15);
  const script=second.branch.manifest.source_files['scripts/weapon.gd'];
  const third=await apply([{type:'put_source_file',path:'scripts/weapon.gd',expected_hash:script.hash,text:texts['scripts/weapon.gd']+'func authored_logic() -> int:\n\treturn 42\n'}]);
  assert.ok(third.changed_resources.includes('main'),'a script-only implementation change invalidates dependent scene');
  assert.notEqual(third.branch.manifest.resources.main.version,second.branch.manifest.resources.main.version);
  assert.equal(native.archive.read(initial.source_files['scripts/weapon.gd']).toString(),texts['scripts/weapon.gd']);
});
