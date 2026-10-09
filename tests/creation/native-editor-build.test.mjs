import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';
import {hash} from '../../services/creation/schema.mjs';

test('native editor build pins all scenes and loads a real static scene without author lifecycle',{timeout:180000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),base=join(root,'.local/creation-verification/native-framework');mkdirSync(base,{recursive:true});
  const data=mkdtempSync(join(base,'editor-build-')),store=new CreationStore(join(data,'creation.sqlite')),native=new NativeProjects({store,data});
  const service={root,data,store,native},builds=new CreationBuilds({service});
  t.after(async()=>{await builds.close();await native.close();store.close();});
  const user=store.register({name:'native-editor-'+crypto.randomUUID(),password:'native-editor-test-password'}).user;
  const created=store.createProject(user,{name:'Native editor'},{entry_scene_id:'main',resources:{main:{id:'main',name:'Main',kind:'scene',objects:[]}}}),p=created.project.id;
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Editor author"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',name:'Main',kind:'scene',path:'main.tscn'},box:{id:'box',name:'Box',kind:'prefab',path:'box.tscn'}}}),
    'author.gd':'extends Node3D\n@export var attack: float = 10.0\nfunc _ready():\n\tpush_error("AUTHOR_GAMEPLAY_RAN_IN_EDITOR")\n',
    'box.tscn':'[gd_scene load_steps=3 format=3]\n[ext_resource type="Script" path="res://author.gd" id="1"]\n[sub_resource type="BoxMesh" id="mesh"]\n[node name="Box" type="Node3D"]\nscript = ExtResource("1")\nmetadata/wa_node_id = "box"\n[node name="Visual" type="MeshInstance3D" parent="."]\nmesh = SubResource("mesh")\n',
    'main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://box.tscn" id="1"]\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id = "root"\n[node name="A" parent="." instance=ExtResource("1")]\nattack = 20.0\nmetadata/wa_instance_id = "a"\n'
  };
  const imported=await native.apply(user,p,'main',{transaction_id:'import',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
  // Queue execution is driven explicitly here; no server or port is launched.
  builds.pump=()=>{};
  const first=builds.prepareNativePreview(user,p,'main',{source_revision:imported.revision,entry_scene_id:'box',request_id:'one'});
  const second=builds.prepareNativePreview(user,p,'main',{source_revision:imported.revision,entry_scene_id:'main',request_id:'two'});
  assert.equal(first.job.id,second.job.id);assert.equal(second.reused,true);
  const job=store.get('creator_build',first.job.id),source=await builds.assemble(job);
  const config=JSON.parse(readFileSync(join(source,'atelier_editor/native-editor.json')));
  assert.equal(Object.keys(config.preview_scenes).length,2);assert.equal(config.policy.gameplay,false);assert.equal(config.policy.author_autoloads,false);
  const files=Object.entries((await import('../../services/creation/native-agent-workspace.mjs')).scanNativeWorkspace(source).files);
  assert.equal(files.some(([path])=>path==='author.gd'||path==='box.tscn'||path==='main.tscn'),false);
  await builds.command(job,builds.godot,['--headless','--editor','--path',source,'--import'],data,{isolatedProject:source,importing:true});
  const log=await builds.command(job,builds.godot,['--headless','--path',source,'--quit-after','3'],data,{isolatedProject:source});
  assert.match(log,/PREVIEW_LOADED/);assert.doesNotMatch(log,/AUTHOR_GAMEPLAY_RAN_IN_EDITOR|SCRIPT ERROR|ERROR:/);
  for(const [path,entry]of files)assert.equal(hash(readFileSync(join(source,path))),entry.hash,'fixed editor input unchanged '+path);
  writeFileSync(join(data,'report.json'),JSON.stringify({ok:true,job_id:job.id,source_identity:imported.branch.manifest.source_identity,config,scope:'actual build queue pin/assembly, source preservation and static Godot startup; no Web'},null,2));
});
