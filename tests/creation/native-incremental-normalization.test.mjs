// Actual Godot imports/indexes and SQLite source transactions, isolated files.
// This verifies incremental ID normalization, not live browser/gameplay behavior.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';import {NativeProjects} from '../../services/creation/native-project.mjs';
import {runNativeScene,importNativeProject} from '../../tools/native-scene/invoke.mjs';
test('changed prefab gets stable IDs once while unchanged owners inherit and preserve source bytes',{timeout:180000},async t=>{
 const data=mkdtempSync(join(tmpdir(),'wa-incremental-native-')),store=new CreationStore(join(data,'creation.sqlite')),requests=[];let imports=0;
 const native=new NativeProjects({store,data,engine:async args=>{requests.push(structuredClone(args.request));return runNativeScene(args);},importProject:async args=>{imports++;return importNativeProject(args);}});
 t.after(async()=>{await native.close();store.close();rmSync(data,{recursive:true,force:true});});
 const user=store.register({name:'Normalization tester',password:'independent-native-password'}).user;
 const project=store.createProject(user,{name:'Incremental normalization'},{entry_scene_id:'a',resources:{a:{id:'a',kind:'scene',name:'A',objects:[]}}}).project.id;
 const files={
  'project.godot':'config_version=5\n[application]\nconfig/name="Incremental test"\nrun/main_scene="res://scenes/a.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'a',resources:{a:{id:'a',kind:'scene',name:'A',path:'scenes/a.tscn'},b:{id:'b',kind:'scene',name:'B',path:'scenes/b.tscn'},weapon:{id:'weapon',kind:'prefab',name:'Weapon',path:'prefabs/weapon.tscn'}}}),
  'weapon.gd':'extends Node3D\n@export var attack: float = 10.0\n',
  'prefabs/weapon.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://weapon.gd" id="1"]\n[node name="Weapon" type="Node3D"]\nscript = ExtResource("1")\nattack = 12.0\nmetadata/wa_node_id = "weapon-root"\n',
  'scenes/a.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://prefabs/weapon.tscn" id="1"]\n[node name="A" type="Node3D"]\nmetadata/wa_node_id = "a-root"\n[node name="Weapon" parent="." instance=ExtResource("1")]\nattack = 20.0\nmetadata/wa_instance_id = "a-weapon"\n',
  'scenes/b.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://prefabs/weapon.tscn" id="1"]\n[node name="B" type="Node3D"]\nmetadata/wa_node_id = "b-root"\n[node name="Weapon" parent="." instance=ExtResource("1")]\nmetadata/wa_instance_id = "b-weapon"\n',
  'extras/unknown.bin':Buffer.from([0,255,37,13,10,144]),
 };
 const initial=await native.inspectFiles(Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,native.archive.put(bytes)])),{assignIds:true});
 const branch=store.branchFor(user,project,'main');branch.head=store.writeRevision(project,[branch.head],initial,user.id).id;store.put('creator_branch',branch);
 const get=()=>store.branchView(user,project,'main'),apply=ops=>native.apply(user,project,'main',{transaction_id:'tx-'+crypto.randomUUID(),base_revision:get().head,ops});
 const originalPrefab=initial.source_files['prefabs/weapon.tscn'],prefabText=native.archive.read(originalPrefab).toString().replace(/attack = [^\n]+/,'attack = 15.0')+'\n[node name="NewBarrel" type="Node3D" parent="."]\nposition = Vector3(1, 2, 3)\n';
 requests.length=0;imports=0;
 const changed=await apply([{type:'put_source_file',path:'prefabs/weapon.tscn',expected_hash:originalPrefab.hash,text:prefabText}]),next=changed.branch.manifest;
 assert.equal(imports,1,'file-only update has one complete import');assert.deepEqual(requests.filter(r=>r.action==='apply'&&r.assign_ids).map(r=>r.scene_path),['res://prefabs/weapon.tscn']);
 for(const path of ['scenes/a.tscn','scenes/b.tscn','extras/unknown.bin'])assert.equal(next.source_files[path].hash,initial.source_files[path].hash,path+' stays byte-exact');
 const find=(m,rid,id)=>m.resources[rid].native_nodes.find(n=>n.node_id===id),value=(m,rid,id,name)=>find(m,rid,id).properties.find(p=>p.name===name);
 assert.equal(value(next,'a','weapon-root','attack').value,20);assert.equal(value(next,'a','weapon-root','attack').overridden,true);assert.equal(value(next,'b','weapon-root','attack').value,15);
 const child=next.resources.weapon.native_nodes.find(n=>n.name==='NewBarrel');assert.ok(child?.node_id,'Godot assigns new definition stable ID');
 for(const [rid,instance]of [['a','a-weapon'],['b','b-weapon']]){const inherited=find(next,rid,child.node_id);assert.ok(inherited,'unchanged owner receives new definition child');assert.deepEqual(inherited.instance_ids,[instance]);assert.equal(find(next,rid,rid+'-root').node_id,find(initial,rid,rid+'-root').node_id);}
 requests.length=0;imports=0;
 const after=await apply([{type:'put_source_file',path:'weapon.gd',expected_hash:next.source_files['weapon.gd'].hash,text:files['weapon.gd']+'func changed_logic() -> int:\n\treturn 42\n'}]);
 assert.equal(imports,1);assert.equal(requests.filter(r=>r.action==='apply'&&r.assign_ids).length,0,'script-only change does not resave scenes');assert.ok(requests.some(r=>r.action==='inspect_many'),'all resources still receive engine-derived indexing');
 for(const rid of ['a','b','weapon'])assert.notEqual(after.branch.manifest.resources[rid].version,next.resources[rid].version,rid+' invalidates from script content change');
 for(const path of ['scenes/a.tscn','scenes/b.tscn','prefabs/weapon.tscn','extras/unknown.bin'])assert.equal(after.branch.manifest.source_files[path].hash,next.source_files[path].hash);
 assert.equal(find(after.branch.manifest,'weapon',child.node_id).node_id,child.node_id);
});
