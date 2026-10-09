import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {snapshotProjectRuntime,assembleProject} from '../../services/creation/project-snapshot.mjs';
import {importNativeProject} from '../../tools/native-scene/invoke.mjs';
import {nativeEnvironmentFields} from '../../services/creation/native-agent-workspace.mjs';
const exec=promisify(execFile),root=resolve(import.meta.dirname,'../..'),godot='/Applications/Godot.app/Contents/MacOS/Godot';

test('fixed native source boots actual PackedScene through namespaced canonical GameRuntime',{timeout:180000},async t=>{
  const base=join(root,'.local/creation-verification/native-framework');mkdirSync(base,{recursive:true});
  const data=mkdtempSync(join(base,'canonical-')),store=new CreationStore(join(data,'creation.sqlite')),native=new NativeProjects({store,data});
  t.after(async()=>{await native.close();store.close();});
  const user=store.register({name:'native-canonical-'+crypto.randomUUID(),password:'native-canonical-test-password'}).user;
  const created=store.createProject(user,{name:'Native canonical'},{entry_scene_id:'main',resources:{main:{id:'main',name:'Main',kind:'scene',objects:[]}}}),p=created.project.id;
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Author settings"\n[display]\nwindow/size/viewport_width=1234\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',name:'Main',kind:'scene',path:'scenes/main.tscn'},weapon:{id:'weapon',name:'Weapon',kind:'prefab',path:'prefabs/weapon.tscn'}}}),
    'scripts/weapon.gd':'extends Node3D\n@export var attack: float = 10.0\nfunc _ready():\n\tset_meta("native_ready",true)\n',
    'prefabs/weapon.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/weapon.gd" id="1"]\n[node name="Weapon" type="Node3D"]\nscript = ExtResource("1")\nmetadata/wa_node_id = "weapon-root"\n',
    'scenes/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://prefabs/weapon.tscn" id="1"]\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id = "main-root"\n[node name="A" parent="." instance=ExtResource("1")]\nattack = 20.0\nmetadata/wa_instance_id = "a"\n[node name="B" parent="." instance=ExtResource("1")]\nmetadata/wa_instance_id = "b"\n',
    'release.json':'{"author_custom_file":true}\n','README.md':'author readme\n','custom/data.bin':Buffer.from([0,255,3,4])
  };
  const imported=await native.apply(user,p,'main',{transaction_id:'import',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,value])=>({path,data_base64:Buffer.from(value).toString('base64')}))}]});
  const manifest=imported.branch.manifest,directory=join(data,'project'),runtime=snapshotProjectRuntime(root,directory);
  await assembleProject({service:{store,native},user,project_id:p,branch_id:'main',revision:imported.revision,directory,runtime_source_hash:runtime.hash});
  const environment=nativeEnvironmentFields(manifest,directory);
  for(const [path,entry]of Object.entries(manifest.source_files))if(path!=='project.godot')assert.deepEqual(readFileSync(join(directory,path)),native.archive.read(entry),path+' preserved byte-for-byte');
  assert.ok(environment.files.some(file=>file.path==='.atelier/catalog.json'));
  const config=readFileSync(join(directory,'project.godot'),'utf8');assert.match(config,/window\/size\/viewport_width=1234/);assert.match(config,/GameRuntime="\*res:\/\/atelier_runtime\/standalone.gd"/);
  const release=JSON.parse(readFileSync(join(directory,'atelier_runtime/release.json')));assert.equal(release.scenes.main.native_scene_path,'res://scenes/main.tscn');assert.equal(release.scenes.weapon.kind,'prefab');
  writeFileSync(join(directory,'canonical_probe.gd'),`extends Node
func check(value: bool, message: String):
\tif not value:
\t\tpush_error("NATIVE_CANONICAL_FAILED "+message)
\t\tget_tree().quit(1)
func _ready():
\tprocess_mode = Node.PROCESS_MODE_ALWAYS
\tvar runtime = get_tree().root.get_node("GameRuntime")
\tfor i in 400:
\t\tawait get_tree().process_frame
\t\tif runtime.running: break
\tcheck(runtime.running,"runtime became active")
\tcheck(get_tree().current_scene.scene_file_path == "res://scenes/main.tscn","actual native current_scene")
\tvar actual = get_tree().current_scene
\tcheck(actual.get_node("A").attack == 20.0 and actual.get_node("B").attack == 10.0,"native inheritance")
\tcheck(actual.get_node("A").get_meta("native_ready",false),"real author script ready")
\tfor object in runtime.release.scenes.main.objects:
\t\tcheck(runtime.projection.objects[object.id] == actual.get_node(object.native_path),"index resolves actual node")
\tawait get_tree().create_timer(0.1).timeout
\tcheck(runtime.simulation.tick > 0,"real native physics ticks")
\truntime.debug.enter_inspection()
\tvar tick = runtime.simulation.tick
\tawait get_tree().create_timer(0.1).timeout
\tcheck(runtime.simulation.tick == tick,"inspection freezes native tick")
\tcheck(runtime.debug.restore_inspection(),"inspection restores")
\tawait get_tree().create_timer(0.1).timeout
\tcheck(runtime.simulation.tick > tick,"native tick resumes")
\tprint("NATIVE_CANONICAL_VERIFIED "+JSON.stringify({"scene_path":actual.scene_file_path,"source_revision":runtime.release.revision,"source_identity":runtime.release.source_identity,"object_count":runtime.projection.objects.size()}))
\tget_tree().quit(0)
`);
  writeFileSync(join(directory,'project.godot'),config.replace('[autoload]','[autoload]\nCanonicalProbe="*res://canonical_probe.gd"'));
  const importedProject=await importNativeProject({projectDirectory:directory,godotPath:godot,enforceIsolation:true});
  for(const file of environment.files)if(file.path!=='project.godot'){
    const {hash}=await import('../../services/creation/schema.mjs');assert.equal(hash(readFileSync(join(directory,file.path))),file.sha256,'Godot import must not change pinned input '+file.path);
  }
  const run=await exec(godot,['--headless','--path',directory],{timeout:30000,maxBuffer:4*1024*1024});
  const output=run.stdout+run.stderr;writeFileSync(join(data,'runtime.log'),output);assert.doesNotMatch(output,/SCRIPT ERROR|ERROR:/);assert.match(output,/NATIVE_CANONICAL_VERIFIED/);
  writeFileSync(join(data,'report.json'),JSON.stringify({source_revision:imported.revision,source_identity:manifest.source_identity,runtime_source_hash:runtime.hash,files:environment.files,scope:'actual native canonical bootstrap and source preservation; no Web or formal workbench'},null,2));
});
