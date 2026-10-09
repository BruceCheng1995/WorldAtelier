// Actual isolated Godot baking and persistent native_main scene replacement.
// No browser, Web export, production data, or fabricated runtime ACKs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {nativeScenePacket} from '../../services/creation/native-view.mjs';
import {prepareNativeEditorContent,nativeContentCompatible,NATIVE_CONTENT_PROTOCOL} from '../../services/creation/native-editor-content.mjs';

test('native content reload uses real PackedScene inheritance in one resident editor without another build',{timeout:240000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),base=join(root,'.local/creation-verification/native-framework');mkdirSync(base,{recursive:true});
  const data=mkdtempSync(join(base,'editor-content-independent-')),store=new CreationStore(join(data,'creation.sqlite')),native=new NativeProjects({store,data});
  const builds=new CreationBuilds({service:{root,data,store,native}});builds.pump=()=>{};
  t.after(async()=>{await builds.close();await native.close();store.close();});
  const user=store.register({name:'Content owner '+crypto.randomUUID(),password:'independent-content-password'}).user;
  const outsider=store.register({name:'Content outsider '+crypto.randomUUID(),password:'independent-content-password'}).user;
  const created=store.createProject(user,{name:'Independent native content'},{entry_scene_id:'main',resources:{main:{id:'main',name:'Main',kind:'scene',objects:[]}}}),p=created.project.id;
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Independent content test"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',name:'Main',kind:'scene',path:'main.tscn'},box:{id:'box',name:'Box',kind:'prefab',path:'box.tscn'}}}),
    'author.gd':'extends Node3D\n@export var attack: float = 10.0\nfunc _ready():\n\tpush_error("AUTHOR_GAMEPLAY_RAN_IN_EDITOR")\n',
    'box.tscn':'[gd_scene load_steps=4 format=3]\n[ext_resource type="Script" path="res://author.gd" id="1"]\n[sub_resource type="StandardMaterial3D" id="mat"]\nalbedo_color = Color(0.9, 0.2, 0.1, 1)\n[sub_resource type="BoxMesh" id="mesh"]\nmaterial = SubResource("mat")\n[node name="Box" type="Node3D"]\nposition = Vector3(1, 0, 0)\nscript = ExtResource("1")\nattack = 12.0\nmetadata/wa_node_id = "box"\n[node name="Visual" type="MeshInstance3D" parent="."]\nmesh = SubResource("mesh")\n',
    'main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://box.tscn" id="1"]\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id = "root"\n[node name="A" parent="." instance=ExtResource("1")]\nposition = Vector3(5, 0, 0)\nattack = 20.0\nmetadata/wa_instance_id = "a"\n[node name="B" parent="." instance=ExtResource("1")]\nmetadata/wa_instance_id = "b"\n',
    'unused.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
  };
  const imported=await native.apply(user,p,'main',{transaction_id:'import',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
  const first=builds.prepareNativePreview(user,p,'main',{source_revision:imported.revision,entry_scene_id:'main',request_id:'resident'});
  let job=store.get('creator_build',first.job.id);const fixedProject=await builds.assemble(job);job=store.get('creator_build',job.id);
  assert.equal(job.native_content_protocol,NATIVE_CONTENT_PROTOCOL);
  const changedText=native.archive.read(imported.branch.manifest.source_files['box.tscn']).toString().replace('Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0)','Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0)').replace('attack = 12.0','attack = 15.0')+'\n[node name="NewChild" type="Node3D" parent="."]\nposition = Vector3(0, 3, 0)\n';
  const changed=await native.apply(user,p,'main',{transaction_id:'definition-edit',base_revision:imported.revision,ops:[{type:'put_source_file',path:'box.tscn',expected_hash:imported.branch.manifest.source_files['box.tscn'].hash,text:changedText}]});
  const input={build_id:job.id,source_revision:changed.revision,resource_id:'main'};
  const [result,prefab]=await Promise.all([prepareNativeEditorContent(builds,user,p,'main',input),prepareNativeEditorContent(builds,user,p,'main',{...input,resource_id:'box'})]);
  assert.equal(result.compatible,true);assert.equal(prefab.compatible,true);
  assert.equal(result.content.base_source_identity,imported.branch.manifest.source_identity);assert.equal(result.content.source_identity,changed.branch.manifest.source_identity);
  assert.equal(result.content.related_scenes.length,1);assert.equal(result.content.related_scenes[0].resource_id,'box');
  assert.equal(prefab.content.resource_id,'box');assert.notEqual(prefab.content.sha256,result.content.sha256);
  for(const content of [result.content,prefab.content]){const bytes=Buffer.from(content.data_base64,'base64');assert.equal(bytes.length,content.size);assert.equal(hash(bytes),content.sha256);}
  const a=changed.branch.manifest.resources.main.native_nodes.find(n=>n.path==='A'),b=changed.branch.manifest.resources.main.native_nodes.find(n=>n.path==='B');
  assert.equal(a.properties.find(p=>p.name==='attack').value,20);assert.equal(b.properties.find(p=>p.name==='attack').value,15);
  assert.equal(store.list('creator_build').length,1,'content changes never create a Web build');
  await assert.rejects(prepareNativeEditorContent(builds,outsider,p,'main',input),error=>error.status===403||error.status===404);
  await assert.rejects(prepareNativeEditorContent(builds,user,p,'wrong-branch',input),error=>error.status===409);
  await assert.rejects(prepareNativeEditorContent(builds,user,p,'main',{...input,build_id:'missing-build'}),error=>error.status===404);
  await assert.rejects(prepareNativeEditorContent(builds,user,p,'main',{...input,source_revision:'missing-source'}),error=>error.status===409);
  await assert.rejects(prepareNativeEditorContent(builds,user,p,'main',{...input,resource_id:'missing-scene'}),error=>error.status===404);
  const compatible=changed.branch.manifest;
  assert.equal(nativeContentCompatible(imported.branch.manifest,compatible),true);
  assert.equal(nativeContentCompatible(imported.branch.manifest,{...compatible,source_files:{...compatible.source_files,'project.godot':{hash:'changed'}}}),false);
  assert.equal(nativeContentCompatible(imported.branch.manifest,{...compatible,source_files:{...compatible.source_files,'new.svg':{hash:'new'}}}),false);

  // Run the original fixed editor plus an external probe in an isolated copy.
  // Its real receive() validates content bytes, replaces the native scene, and
  // emits the loaded event itself. No protocol acknowledgements are injected.
  const runtime=join(data,'persistent-probe');cpSync(fixedProject,runtime,{recursive:true});
  const packet={...nativeScenePacket(changed.branch.manifest,'main',{project_id:p,branch_id:'main',revision:changed.revision}),source_revision:changed.revision,native_preview_content:result.content,frame:false,editable:true};
  writeFileSync(join(runtime,'content-packet.json'),JSON.stringify(packet));
  writeFileSync(join(runtime,'content-probe.gd'),`extends SceneTree
func _initialize():
\tcall_deferred("verify")
func check(value: bool, message: String):
\tif not value:
\t\tpush_error("CONTENT_PROBE_FAILED " + message)
\t\tquit(2)
func verify():
\tvar host=load("res://atelier_editor/main.tscn").instantiate()
\troot.add_child(host)
\tfor n in range(8): await process_frame
\tcheck(host.native_active, "resident editor initially loaded")
\tvar identity=host.get_instance_id()
\tvar nonce=host.nonce
\tvar before=host.authored_root
\tcheck(is_equal_approx(before.get_node("A").position.x, 5), "initial explicit override")
\tcheck(is_equal_approx(before.get_node("B").position.x, 1), "initial definition default")
\tvar packet: Dictionary=JSON.parse_string(FileAccess.get_file_as_string("res://content-packet.json"))
\tpacket.merge({"source":"world-atelier-workspace","nonce":nonce,"type":"scene","seq":host.requested_seq+1},true)
\thost.receive(packet)
\tfor n in range(8): await process_frame
\tcheck(host.get_instance_id()==identity and host.nonce==nonce, "same resident editor and message identity")
\tcheck(host.applied_seq==packet.seq, "real loaded sequence")
\tcheck(host.native_document.source_identity==packet.source_identity, "new exact source identity")
\tcheck(not host.native_document.has("native_preview_content"), "no retained base64 payload")
\tcheck(is_equal_approx(host.authored_root.get_node("A").position.x, 5), "explicit instance position survives definition edit")
\tcheck(is_equal_approx(host.authored_root.get_node("B").position.x, 2), "unoverridden instance follows real PackedScene")
\tcheck(host.authored_root.has_node("A/NewChild") and host.authored_root.has_node("B/NewChild"), "both instances inherit new native node")
\tcheck(host.authored_root.get_node("A").get_script()==null, "author lifecycle script removed")
\tcheck(host.authored_root.get_node("B/Visual").mesh.material.albedo_color.r>0.8, "inline material survives user path loading")
\tcheck(host.native_content_scenes.has("res://box.tscn"), "new prefab closure is cached")
\tvar drag_prefab=host.native_content_scenes["res://box.tscn"].instantiate()
\tcheck(is_equal_approx(drag_prefab.position.x,2) and drag_prefab.has_node("NewChild"), "drag closure follows latest prefab")
\tdrag_prefab.free()
\tvar active=host.authored_root
\tvar applied=host.applied_seq
\tvar bad=packet.duplicate(true)
\tbad.seq=host.requested_seq+1
\tbad.native_preview_content.base_source_identity="foreign-base"
\thost.receive(bad)
\tcheck(host.authored_root==active and host.applied_seq==applied, "foreign base rejected without destroying scene")
\tcheck(host.outbound_log.back().code=="native_content_mismatch", "foreign base has exact rejection")
\tbad=packet.duplicate(true)
\tbad.seq=host.requested_seq+1
\tbad.native_preview_content.sha256="invalid-hash"
\thost.receive(bad)
\tcheck(host.authored_root==active and host.applied_seq==applied, "corrupt bytes preserve old scene")
\tcheck(host.outbound_log.back().code=="native_content_hash", "corrupt content has exact rejection")
\tcheck(not FileAccess.file_exists("user://wa-editor-"+packet.native_preview_content.sha256+".scn"), "temporary scene file removed")
\tprint("CONTENT_PROBE_PASSED " + JSON.stringify({"resident_id":identity,"source_identity":host.native_document.source_identity,"loaded_seq":applied,"new_node":true,"material":true}))
\tquit(0)
`);
  await builds.command(job,builds.godot,['--headless','--editor','--path',runtime,'--import'],data,{isolatedProject:runtime,importing:true});
  const log=await builds.command(job,builds.godot,['--headless','--path',runtime,'--script','res://content-probe.gd'],data,{isolatedProject:runtime});
  assert.match(log,/CONTENT_PROBE_PASSED/);assert.doesNotMatch(log,/CONTENT_PROBE_FAILED|AUTHOR_GAMEPLAY_RAN_IN_EDITOR|SCRIPT ERROR|ERROR:/);
  const withTexture=changedText.replace(/(\[sub_resource type="StandardMaterial3D")/,'[ext_resource type="Texture2D" path="res://unused.svg" id="new_texture"]\n\n$1')+'\n[node name="NewTexture" type="Sprite3D" parent="."]\ntexture = ExtResource("new_texture")\n';
  const dependencyChange=await native.apply(user,p,'main',{transaction_id:'new-media-dependency',base_revision:changed.revision,ops:[{type:'put_source_file',path:'box.tscn',expected_hash:compatible.source_files['box.tscn'].hash,text:withTexture}]});
  assert.deepEqual(await prepareNativeEditorContent(builds,user,p,'main',{...input,source_revision:dependencyChange.revision}),{compatible:false,reason:'new_media_dependency'},'previously unused media is not assumed present in the resident pack');
  const changedSettings=await native.apply(user,p,'main',{transaction_id:'settings-edit',base_revision:dependencyChange.revision,ops:[{type:'put_source_file',path:'project.godot',expected_hash:compatible.source_files['project.godot'].hash,text:native.archive.read(compatible.source_files['project.godot']).toString().replace('Independent content test','Changed content settings')}]});
  assert.deepEqual(await prepareNativeEditorContent(builds,user,p,'main',{...input,source_revision:changedSettings.revision}),{compatible:false,reason:'media_or_settings_changed'});
  assert.equal(store.list('creator_build').length,1);
  assert.equal(readdirSync(builds.directory).some(name=>name.startsWith('editor-content-')),false,'temporary preparation work removed');
  const report={ok:true,scope:'actual Godot scene bake and persistent native_main, no Web export',job_id:job.id,source_revision:changed.revision,content_sha256:result.content.sha256,build_count:1,log};
  writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2));
  console.log('NATIVE_EDITOR_CONTENT_EVIDENCE '+data);
});
