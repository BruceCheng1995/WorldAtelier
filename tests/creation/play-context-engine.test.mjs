// Actual canonical native game, scripted in-process inputs, headless + Dummy.
// No desktop window, listening service, paid Agent, screenshots or synthetic ACK.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {snapshotProjectRuntime,assembleProject} from '../../services/creation/project-snapshot.mjs';
import {importNativeProject} from '../../tools/native-scene/invoke.mjs';
const exec=promisify(execFile),root=resolve(import.meta.dirname,'../..'),godot=process.env.GODOT_BIN||'/Applications/Godot.app/Contents/MacOS/Godot';

test('canonical play observes dynamic native nodes and real inputs without reading author getters or altering source',{timeout:120000},async t=>{
  const data=mkdtempSync(join(tmpdir(),'wa-context-engine-')),store=new CreationStore(join(data,'creation.sqlite')),native=new NativeProjects({store,data});
  t.after(async()=>{await native.close();store.close();rmSync(data,{recursive:true,force:true});});
  const user=store.register({name:'Context engine',password:'isolated-context-password'}).user;
  const created=store.createProject(user,{name:'Context engine'},{entry_scene_id:'main',resources:{main:{id:'main',name:'Main',kind:'scene',objects:[]}}}),p=created.project.id;
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Context engine"\n[display]\nwindow/size/viewport_width=800\nwindow/size/viewport_height=600\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',name:'Main',kind:'scene',path:'main.tscn'},actor:{id:'actor',name:'Actor',kind:'prefab',path:'actor.tscn'}}}),
    'actor.gd':'extends Node3D\nvar getter_reads = 0\n@export var private_value: int:\n\tget:\n\t\tgetter_reads += 1\n\t\treturn 7\nfunc _ready():\n\tset_meta("wa_observation", {"health":12,"payload":PackedByteArray([1,2,3])})\nfunc _input(event):\n\tif event is InputEventKey and event.physical_keycode==KEY_W:\n\t\tset_meta("input_consumed", true)\n\t\tget_viewport().set_input_as_handled()\n',
    'actor.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://actor.gd" id="1"]\n[node name="Actor" type="Node3D"]\nscript=ExtResource("1")\nmetadata/wa_node_id="actor"\n',
    'main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://actor.tscn" id="1"]\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id="main"\n[node name="Fixed" parent="." instance=ExtResource("1")]\nmetadata/wa_instance_id="fixed"\n[node name="Input" type="LineEdit" parent="."]\nmetadata/wa_node_id="input"\noffset_right=100.0\noffset_bottom=30.0\n'
  };
  const imported=await native.apply(user,p,'main',{transaction_id:'context-import',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,value])=>({path,text:value}))}]});
  const directory=join(data,'project'),runtime=snapshotProjectRuntime(root,directory);
  await assembleProject({service:{store,native},user,project_id:p,branch_id:'main',revision:imported.revision,directory,runtime_source_hash:runtime.hash});
  const config=readFileSync(join(directory,'project.godot'),'utf8');
  writeFileSync(join(directory,'context_probe.gd'),`extends Node
var checks = 0
func check(ok: bool, text: String):
\tchecks += 1
\tif not ok:
\t\tpush_error("PLAY_CONTEXT_FAILED "+text)
\t\tget_tree().quit(1)
func snapshot(runtime):
\truntime.debug.play_context.snapshot("probe")
\tfor packet in runtime.debug.outbound_log.duplicate().slice(0).filter(func(p): return p.get("type")=="play_context" and p.get("kind")=="snapshot"):
\t\tif packet.request_id == "probe": return packet
\treturn {}
func _ready():
\tprocess_mode = Node.PROCESS_MODE_ALWAYS
\tvar runtime = get_tree().root.get_node("GameRuntime")
\tfor i in 400:
\t\tawait get_tree().process_frame
\t\tif runtime.running: break
\tcheck(runtime.running,"canonical game started")
\tcheck(AudioServer.get_driver_name()=="Dummy","silent driver")
\truntime.debug.started = true
\truntime.debug.nonce = "headless-context-probe"
\truntime.debug.world_id = "test-local-run"
\tvar scene = get_tree().current_scene
\tvar spawned = load("res://actor.tscn").instantiate()
\tspawned.name = "Dynamic"
\tscene.add_child(spawned)
\tspawned.position = Vector3(3,0,0)
\tvar only = Node3D.new()
\tonly.name = "Ephemeral"
\tscene.add_child(only)
\tawait get_tree().process_frame
\truntime.debug.outbound_log.clear()
\tvar first = snapshot(runtime)
\tcheck(not first.is_empty(),"real observation packet")
\tcheck(first.runtime_instance_id=="headless-context-probe","runtime identity")
\tvar fixed_row = first.payload.objects.filter(func(o): return o.name=="Fixed")[0]
\tvar dynamic_row = first.payload.objects.filter(func(o): return o.name=="Dynamic")[0]
\tvar runtime_row = first.payload.objects.filter(func(o): return o.name=="Ephemeral")[0]
\tcheck(fixed_row.mapping=="exact_source","fixed exact source mapping")
\tcheck(dynamic_row.mapping=="spawned_from_prefab" and dynamic_row.source.prefab_path=="res://actor.tscn","dynamic prefab origin")
\tcheck(runtime_row.mapping=="runtime_only","unmapped is explicit")
\tcheck(dynamic_row.observed_values.health==12 and dynamic_row.observed_values.payload==null,"bounded primitive metadata")
\tcheck(spawned.getter_reads==0,"custom getter never evaluated")
\tvar before_position = spawned.position
\tvar before_children = scene.get_child_count()
\tvar key = InputEventKey.new()
\tkey.physical_keycode = KEY_W
\tkey.pressed = true
\tInput.parse_input_event(key)
\tawait get_tree().process_frame
\tcheck(spawned.get_meta("input_consumed",false) or scene.get_node("Fixed").get_meta("input_consumed",false),"author script consumed the real gameplay key")
\tcheck(runtime.debug.outbound_log.filter(func(e): return e.get("type")=="play_context" and e.get("kind")=="event" and e.payload.kind=="key_down").size()==1,"consumed gameplay input observed exactly once")
\tvar window = get_window()
\twindow.size = Vector2i(800,600)
\twindow.content_scale_size = Vector2i(400,300)
\twindow.content_scale_mode = Window.CONTENT_SCALE_MODE_VIEWPORT
\tawait get_tree().process_frame
\truntime.debug.outbound_log.clear()
\tvar click = InputEventMouseButton.new()
\tclick.button_index = MOUSE_BUTTON_LEFT
\tclick.pressed = true
\tclick.position = Vector2(400,300)
\tInput.parse_input_event(click)
\tawait get_tree().process_frame
\tvar pointers = runtime.debug.outbound_log.filter(func(e): return e.get("type")=="play_context" and e.get("kind")=="event" and e.payload.kind=="pointer_down")
\tcheck(pointers.size()==1 and absf(pointers[0].payload.payload.position[0]-.5)<.001 and absf(pointers[0].payload.payload.position[1]-.5)<.001,"pre-input window coordinates match logical viewport scaling")
\tvar field = scene.get_node("Input")
\tfield.grab_focus()
\tawait get_tree().process_frame
\truntime.debug.play_context.last_text_ms = -2000
\truntime.debug.outbound_log.clear()
\tvar typed = InputEventKey.new()
\ttyped.keycode = KEY_A
\ttyped.unicode = 97
\ttyped.pressed = true
\tInput.parse_input_event(typed)
\tawait get_tree().process_frame
\tvar inputs = runtime.debug.outbound_log.filter(func(e): return e.get("type")=="play_context" and e.get("kind")=="event")
\tcheck(inputs.any(func(e): return e.payload.kind=="text_input" and e.payload.payload.redacted),"text interaction redacted")
\tcheck(not inputs.any(func(e): return e.payload.kind=="key_down"),"no typed key leaked")
\tcheck(spawned.position==before_position and scene.get_child_count()==before_children,"observation did not mutate game")
\tvar count = runtime.debug.outbound_log.size()
\truntime.debug.play_context.receive({"type":"context_request","action":"snapshot","request_id":"stale","seq":runtime.debug.seq,"document_id":runtime.debug.document_id,"scene_generation":runtime.generation-1})
\tcheck(runtime.debug.outbound_log.size()==count,"stale generation rejected")
\truntime.debug.capture_frame({"type":"capture_frame","request_id":"headless","seq":runtime.debug.seq,"document_id":runtime.debug.document_id,"scene_generation":runtime.generation})
\tcheck(runtime.debug.outbound_log.any(func(e): return e.get("type")=="captured_frame" and e.has("error")),"headless capture fails without hanging")
\t# Actual wide live tree: the observer must never enqueue all children first.
\tvar wide = Node.new()
\twide.name = "WideRuntimeSubtree"
\tscene.add_child(wide)
\tfor index in 6000:
\t\tvar child = Node.new()
\t\tchild.name = "Child"+str(index)
\t\twide.add_child(child)
\tvar metadata = {}
\tfor index in 1000: metadata["field"+str(index)] = "x".repeat(1000)
\tspawned.set_meta("wa_observation", metadata)
\t# These extra facade entries are a budget fixture referencing real nodes;
\t# they do not claim source identity or fabricate runtime/authority ACKs.
\tvar original_objects = runtime.projection.objects.duplicate()
\tvar original_definitions = runtime.projection.definitions.duplicate()
\tfor index in 3000:
\t\tvar index_key = "budget-probe-"+str(index)
\t\truntime.projection.objects[index_key] = wide.get_child(index)
\t\truntime.projection.definitions[index_key] = {}
\truntime.debug.outbound_log.clear()
\tvar bounded = snapshot(runtime)
\tcheck(bounded.payload.scanned_nodes<=2048 and bounded.payload.maximum_pending_nodes<=2048,"wide tree queue and scan stay bounded")
\tcheck(bounded.payload.indexed_nodes<=2048 and bounded.payload.index_truncated,"source facade indexing stays bounded")
\tcheck(bounded.payload.objects.size()<=256 and bounded.payload.truncated,"node observation budget explicit")
\tcheck(not bounded.payload.input_regions_complete,"incomplete text mask scan rejects automatic screenshots")
\tcheck(bounded.payload.observation_bytes<=192*1024 and JSON.stringify(bounded.payload).to_utf8_buffer().size()<208*1024,"payload and metadata budgets")
\tcheck(spawned.getter_reads==0,"wide observation still never invokes script getters")
\truntime.projection.objects=original_objects
\truntime.projection.definitions=original_definitions
\tprint("PLAY_CONTEXT_ENGINE_OK "+JSON.stringify({"checks":checks,"source_revision":runtime.release.revision,"runtime_source_hash":runtime.release.runtime_source_hash,"objects":first.payload.objects.size()}))
\tget_tree().quit(0)
`);
  writeFileSync(join(directory,'project.godot'),config.replace('[autoload]','[autoload]\nContextProbe="*res://context_probe.gd"'));
  await importNativeProject({projectDirectory:directory,godotPath:godot,enforceIsolation:true});
  const run=await exec(godot,['--headless','--audio-driver','Dummy','--path',directory],{timeout:30000,maxBuffer:4*1024*1024});
  const output=run.stdout+run.stderr;assert.doesNotMatch(output,/SCRIPT ERROR|ERROR:/);assert.match(output,/PLAY_CONTEXT_ENGINE_OK/);
  assert.equal(store.branchFor(user,p,'main').head,imported.revision);
  for(const [path,entry]of Object.entries(imported.branch.manifest.source_files))if(path!=='project.godot')assert.deepEqual(readFileSync(join(directory,path)),native.archive.read(entry));
});
