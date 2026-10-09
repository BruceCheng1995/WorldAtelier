import {fail,hash,identifier} from './schema.mjs';
import {NATIVE_SCHEMA,NATIVE_CATALOG} from './native-source.mjs';

export const PREFAB_TEST_DIRECTORY='test_scenes';
export const isPrefabTest=resource=>resource?.purpose==='prefab_test';
export const isPrefabPreviewEntry=resource=>isPrefabTest(resource)||resource?.kind==='prefab';
export const isPrefabTestPath=path=>String(path).replace(/^res:\/\//,'').toLowerCase().startsWith(PREFAB_TEST_DIRECTORY+'/');

// Classification is semantic metadata over real PackedScenes. Test code and
// test-only assets must stay in this directory so exclusion is auditable.
export function validatePrefabTests(catalog){
  for(const resource of Object.values(catalog.resources)){
    if(resource.purpose!==undefined&&!isPrefabTest(resource))fail(422,'未知场景用途',{resource_id:resource.id});
    if(isPrefabTest(resource)){
      if(resource.kind!=='scene'||!isPrefabTestPath(resource.path)||catalog.resources[resource.subject_id]?.kind!=='prefab')fail(422,'能力预览需要 test_scenes/ 中的场景及真实预制件引用',{resource_id:resource.id});
      if(resource.id===catalog.entry_scene_id)fail(422,'能力预览不能作为正式游戏入口');
    }else if(isPrefabTestPath(resource.path))fail(422,'test_scenes/ 场景必须登记 purpose: prefab_test 和 subject_id',{resource_id:resource.id});
  }
}

/** A runtime projection; the authoritative source manifest is never changed. */
export function projectPrefabTestScope(service,manifest,purpose,entry){
  if(!['authoring','game','prefab_test'].includes(purpose))fail(422,'未知工程用途');
  if(purpose==='prefab_test'&&!isPrefabPreviewEntry(manifest.resources[entry]))fail(422,'请选择原生预制件或已登记的能力预览场景');
  if(purpose==='game'&&isPrefabTest(manifest.resources[entry]))fail(422,'能力预览请从预制件测试入口运行');
  if(purpose!=='game')return manifest;
  const source_files=Object.fromEntries(Object.entries(manifest.source_files).filter(([path])=>!isPrefabTestPath(path)));
  const resources=Object.fromEntries(Object.entries(manifest.resources).filter(([,resource])=>!isPrefabTest(resource)));
  // Reject an authored dependency in the wrong direction instead of shipping a
  // missing scene or silently including a test in a public game.
  for(const [path,file] of Object.entries(source_files)){
    if(path===NATIVE_CATALOG)continue;
    if(/\.(gd|tscn|tres|godot|cfg|json|import)$/i.test(path)&&/res:\/\/test_scenes\//i.test(service.native.archive.read(file).toString('utf8')))fail(422,'正式内容引用了测试专用目录，请将共用能力移到正式预制件',{path});
  }
  for(const resource of Object.values(resources))if((resource.native_dependencies??[]).some(isPrefabTestPath))fail(422,'正式场景依赖测试专用资源',{resource_id:resource.id});
  const catalog=JSON.parse(service.native.archive.read(manifest.source_files[NATIVE_CATALOG]));
  catalog.resources=Object.fromEntries(Object.entries(catalog.resources).filter(([,resource])=>!isPrefabTest(resource)));
  if(catalog.archived_scene_paths)catalog.archived_scene_paths=catalog.archived_scene_paths.filter(path=>!isPrefabTestPath(path));
  source_files[NATIVE_CATALOG]=service.native.archive.put(JSON.stringify(catalog,null,2)+'\n');
  return {...manifest,source_files,resources};
}

export function prefabTestList(service,user,p,b,{revision,subject_id}={}){
  const branch=service.builds.authorizeNativePreview(user,p,b,revision??service.store.branchFor(user,p,b).head);
  const fixed=service.store.readRevision(revision??branch.head);
  if(fixed?.project_id!==p||fixed.manifest.schema!==NATIVE_SCHEMA)fail(422,'能力预览需要原生 Godot 工程');
  return {revision:fixed.id,scenarios:Object.values(fixed.manifest.resources).filter(resource=>isPrefabTest(resource)&&(!subject_id||resource.subject_id===subject_id)).map(({native_nodes,native_connections,...resource})=>resource)};
}

export async function createPrefabTest(service,user,p,b,input){
  const branch=service.store.branchFor(user,p,b,true);
  identifier(input.request_id,'请求 ID');identifier(input.subject_id,'预制件 ID');identifier(input.base_revision,'源版本');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>160||input.description!==undefined&&(typeof input.description!=='string'||input.description.length>4000))fail(422,'请输入测试场景名称和有效描述');
  const fixed=service.store.readRevision(input.base_revision);
  if(fixed?.project_id!==p||!service.store.ancestor(fixed.id,branch.head)||fixed.manifest.schema!==NATIVE_SCHEMA)fail(409,'请重新读取当前原生源版本');
  const manifest=fixed.manifest,subject=manifest.resources[input.subject_id],target=input.target_id?manifest.resources[input.target_id]:null;
  if(subject?.kind!=='prefab'||input.target_id&&target?.kind!=='prefab')fail(422,'请选择真实预制件作为主体和靶子');
  const rid='prefab-test-'+hash({p,b,user:user.id,request:input.request_id}).slice(0,32),directory=PREFAB_TEST_DIRECTORY+'/'+rid;
  const catalog=JSON.parse(service.native.archive.read(manifest.source_files[NATIVE_CATALOG]));
  catalog.resources[rid]={id:rid,kind:'scene',purpose:'prefab_test',subject_id:subject.id,name:input.name.trim(),path:directory+'/scene.tscn',design:{description:input.description??''}};
  const root=subject.native_nodes?.find(node=>node.path==='.')??subject.native_nodes?.[0];
  const twoD=root?.world_transform?.$type==='Transform2D'||root?.dimension==='2d'||/2D$|Control|Container|Rect|Label|Button/.test(root?.type??root?.class??'')||(root?.properties??[]).some(property=>property.name==='position'&&property.value?.$type==='Vector2');
  const type=twoD?'Node2D':'Node3D';
  const tscn=`[gd_scene load_steps=${target?4:3} format=3]\n\n[ext_resource type="Script" path="res://${directory}/preview.gd" id="1"]\n[ext_resource type="PackedScene" path=${JSON.stringify('res://'+subject.path)} id="2"]\n${target?`[ext_resource type="PackedScene" path=${JSON.stringify('res://'+target.path)} id="3"]\n`:''}\n[node name="CapabilityPreview" type="${type}"]\nscript = ExtResource("1")\nmetadata/wa_node_id = "${rid}-root"\n${target?'target_scene = ExtResource("3")\n':''}\n[node name="Subject" parent="." instance=ExtResource("2")]\nmetadata/wa_instance_id = "${rid}-subject"\n`;
  const script=starterScript(twoD);
  const ops=[{type:'put_source_file',path:NATIVE_CATALOG,expected_hash:manifest.source_files[NATIVE_CATALOG].hash,text:JSON.stringify(catalog,null,2)+'\n'},...[[directory+'/scene.tscn',tscn],[directory+'/preview.gd',script]].map(([path,text])=>({type:'put_source_file',path,expected_hash:null,text}))];
  const result=await service.committed(user,p,b,{transaction_id:input.request_id,base_revision:input.base_revision,expected_head:input.base_revision,ops});
  return {...result,resource_id:rid};
}

function starterScript(twoD){return `extends ${twoD?'Node2D':'Node3D'}
## Development-only scene. Extend this adapter to call the actual prefab API.
## AnimationPlayer / AnimatedSprite animations are discovered by the runtime.
signal atelier_preview_event(event: Dictionary)
@export var target_scene: PackedScene
var target: Node

func _ready() -> void:
${twoD?`\tvar camera = Camera2D.new()
\tcamera.position = Vector2(150, 0)
\tadd_child(camera)
`:`\tvar camera = Camera3D.new()
\tadd_child(camera)
\tcamera.position = Vector3(5, 4, 8)
\tcamera.look_at(Vector3(1.5, 0.5, 0))
\tvar light = DirectionalLight3D.new()
\tlight.rotation_degrees = Vector3(-45, -30, 0)
\tadd_child(light)
\tvar environment = WorldEnvironment.new()
\tenvironment.environment = Environment.new()
\tenvironment.environment.background_mode = Environment.BG_COLOR
\tenvironment.environment.background_color = Color("202831")
\tenvironment.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
\tenvironment.environment.ambient_light_energy = 0.7
\tadd_child(environment)
`}\treset_target()

func reset_target() -> void:
\tif is_instance_valid(target):
\t\tremove_child(target)
\t\ttarget.queue_free()
\tif target_scene == null: return
\ttarget = target_scene.instantiate()
\ttarget.name = "Target"
\tadd_child(target)
\tif target is ${twoD?'Node2D':'Node3D'}: target.position = ${twoD?'Vector2(300, 0)':'Vector3(3, 0, 0)'}
\tatelier_preview_event.emit({"label":"靶子已重置"})

func atelier_preview_capabilities() -> Dictionary:
\tvar actions: Array = []
\tvar result: Dictionary = {}
\tif $Subject.has_method("atelier_preview_capabilities"):
\t\tvar capabilities = $Subject.atelier_preview_capabilities()
\t\tif capabilities is Dictionary:
\t\t\tactions = capabilities.get("actions", []).duplicate(true)
\t\t\tfor key in ["title", "description", "animation_note"]:
\t\t\t\tif capabilities.get(key) is String: result[key] = capabilities[key]
\tif target_scene != null: actions.append({"id":"preview.reset_target", "label":"重置靶子", "group":"靶子", "scope":"scene", "kind":"fixture"})
\tresult.actions = actions
\treturn result

func atelier_preview_selection() -> Dictionary:
\tif $Subject.has_method("atelier_preview_selection"):
\t\tvar selected = $Subject.atelier_preview_selection()
\t\tif selected is Dictionary: return selected
\treturn {}

func atelier_preview_action(action_id: String, parameters: Dictionary) -> Dictionary:
\tif action_id == "preview.reset_target":
\t\treset_target()
\t\treturn {"ok":true}
\tif $Subject.has_method("atelier_preview_action"):
\t\tvar result = $Subject.atelier_preview_action(action_id, parameters)
\t\treturn result if result is Dictionary else {"ok":true}
\treturn {"ok":false, "error":"请在测试适配器中接入预制件真实技能"}

func atelier_preview_state() -> Dictionary:
\tvar result = {"主体":$Subject.name, "靶子":"已放置" if is_instance_valid(target) else "未放置"}
\tif $Subject.has_method("atelier_preview_state"): result["主体状态"] = $Subject.atelier_preview_state()
\treturn result
`;}
