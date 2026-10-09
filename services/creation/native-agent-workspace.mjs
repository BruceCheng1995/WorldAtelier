import {constants,lstatSync,openSync,closeSync,fstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {join,resolve,relative,sep} from 'node:path';
import {NATIVE_SCHEMA,NATIVE_LIMITS,nativeFileMap,nativeSourceIdentity,nativeSourcePath} from './native-source.mjs';
import {clone,fail,hash,stable} from './schema.mjs';
import {nativeSourceSettingsFromWorkspace} from './native-project-settings.mjs';
import {agentAssetPath,agentText} from './agent-text-context.mjs';
import {AGENT_PREFAB_GUIDANCE} from './agent-prefab-policy.mjs';

const EXCLUDED_NAMES=new Set(['.godot','.git','.DS_Store','node_modules']);
const SOURCE_READ_BYTES=256*1024;
const originOf=(run,session)=>({run_id:run.id,lease_generation:run.lease_generation,session_id:session.id});
const sameEntry=(a,b)=>a?.hash===b?.hash&&a?.size===b?.size;

/** Inspect all source-shaped files. There is deliberately no extension filter:
 * animations, resources, import settings and unknown author files roundtrip.
 * Only named engine/VCS/package caches are omitted, with an explicit report. */
export function scanNativeWorkspace(directory,{limits=NATIVE_LIMITS,guard=()=>{},retainBytes=false}={}){
  guard();if(lstatSync(directory).isSymbolicLink()||!lstatSync(directory).isDirectory())fail(403,'工程目录必须是普通目录');
  const root=realpathSync(directory),files=Object.create(null),contents=new Map(),excluded=[];let count=0,total=0;
  function visit(absolute,prefix=''){
    guard();
    for(const entry of readdirSync(absolute,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const path=prefix?prefix+'/'+entry.name:entry.name,target=join(absolute,entry.name);
      if(EXCLUDED_NAMES.has(entry.name)){excluded.push(path);continue;}
      nativeSourcePath(path);
      const before=lstatSync(target);if(before.isSymbolicLink())fail(403,'工程源文件不允许符号链接',{path});
      if(before.isDirectory()){visit(target,path);continue;}
      if(!before.isFile())fail(422,'工程包含非普通文件',{path});
      if(++count>limits.files||before.size>limits.fileBytes||(total+=before.size)>limits.totalBytes)fail(413,'工程超过原生源文件容量限制');
      // O_NOFOLLOW closes the final-component symlink race. The parent chain is
      // rechecked after reading, and byte snapshots are captured before await.
      const fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW);
      let bytes,opened,after;
      try{opened=fstatSync(fd);if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino)fail(409,'读取时源文件已替换',{path});bytes=readFileSync(fd);after=fstatSync(fd);}finally{closeSync(fd);}
      const current=lstatSync(target),actual=realpathSync(target);
      if(!actual.startsWith(root+sep)||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||opened.size!==after.size||opened.mtimeMs!==after.mtimeMs||bytes.length!==before.size)fail(409,'读取时工程源文件发生变化',{path});
      files[path]={hash:hash(bytes),size:bytes.length};if(retainBytes)contents.set(path,bytes);
    }
  }
  visit(root);guard();return {directory:root,files:nativeFileMap(files,{limits}),contents,excluded};
}

/** Called after canonical assembleProject and before creator_environment is
 * persisted. These are server-owned baselines, never values read from an
 * Agent-editable manifest.json. Keep the complete project inventory, including
 * .atelier metadata, so a runtime overlay is distinguishable from source. */
export function nativeEnvironmentFields(sourceManifest,projectDirectory,{guard}={}){
  if(sourceManifest.schema!==NATIVE_SCHEMA)return {};
  const sourceFiles=nativeFileMap(sourceManifest.source_files),captured=scanNativeWorkspace(projectDirectory,{guard});
  for(const path of Object.keys(sourceFiles))if(!captured.files[path])fail(409,'固定工程丢失原生源文件',{path});
  return {source_schema:NATIVE_SCHEMA,native_source_identity:nativeSourceIdentity(sourceFiles),
    native_source_files:sourceFiles,native_workspace_files:captured.files,
    files:Object.entries(captured.files).map(([path,entry])=>({path,sha256:entry.hash,size:entry.size})),
    native_workspace_excluded:captured.excluded,
    native_submission:{tool:'world_apply',operation:'submit_native_workspace',path_root:'work/',baseline:'environment_id',managed_files:Object.keys(captured.files).filter(path=>!sourceFiles[path]),managed_directories:['atelier_runtime'],preserve_unknown_files:true}};
}

export function nativeWorkspaceContext(manifest){
  if(manifest.schema!==NATIVE_SCHEMA)return {};
  return {source_authority:'native_godot_files',source_schema:NATIVE_SCHEMA,source_identity:manifest.source_identity,
    runtime_entry:{main_scene:'res://atelier_runtime/standalone.tscn',autoload:'GameRuntime',source_main_scene:'project.godot application/run/main_scene'},
    source_files:clone(manifest.source_files),catalog_path:'.atelier/catalog.json',
    coordinates:{handedness:'right',up_axis:'Y',units:'metres',transform:'native Godot Transform3D; use engine property encodings and current property versions'},
    instance_policy:'Current prefab paths inherit through PackedScene. Store only actual per-property instance overrides. Whole source revisions pin builds.',
    editing:'native_files',assets:'workspace_files',asset_context:'references_and_bounded_metadata_only',
    asset_io:{directory:'workspace.json godot_project.project_directory',download:true,generate:true,read:true,replace:true,delete:true,tools:['Godot native geometry','Pillow','Blender when installed'],boundary:'Asset bytes stay in server workspace files; tool responses and conversation use paths, hashes and bounded metadata.'},
    submit:{tool:'world_apply',operation:'submit_native_workspace',project:'workspace.json godot_project',requires:['transaction_id','base_revision','environment_id','path']}};
}

export function nativeSemanticAuthoringGuide(manifest){
  if(manifest.schema!==NATIVE_SCHEMA)return '';
  return `# Native game design descriptions and adjustable properties

The user authors game concepts, objects and systems. Implement the real native
Godot behavior, then expose useful existing properties with clear names, units,
ranges and descriptions. Description is intent, not evidence of implementation.
Never replace the user's requested behavior to conceal an implementation failure.

Read semantic_read for the complete resource directory or actual values on a
resource/object. New native @export properties are discoverable directly; you
can attach game-facing descriptions through semantic_apply update_design.
The design object contains description, category ('object'|'system'), relations
and exposed_properties. Every property declares id,name,type,default,
instance_editable and binding:{node_id,property,instance_ids?}. Use stable IDs
and an actual engine property. Optional fields include description,unit,min,max,
step and enum options. Supported semantic types: number,integer,boolean,string,
color,enum. The binding's property is the real native property name; it is not
a legacy behavior list or a JSON component path.

semantic_apply set_property/reset_property uses transaction_id,base_revision,
resource_id,expected_version,property_id,value where needed, and object_id or
the full address for a selected instance. Read semantic_read before writing.
The response includes actual inherited value, override status and property
version. Reset removes the native override so future prefab changes follow.
Changing a prefab definition updates unmodified instance values in the editing
branch. A fixed whole-project source revision pins Play and export content.

For migrated API1 content, exposed properties may point to generated behavior
wrapper nodes. Each wrapper property is still independent. Preserve its actual
binding from semantic_read; do not replace the whole behaviors array.

First read the context design-knowledge-index.json and use knowledge_search/read
for relevant shared architecture and prefab decisions; verify them against current
source. Use knowledge_write after saving structural decisions. Do not copy
private conversation history into shared files. Preserve immutable attachment
versions and complete instance addresses. Scene structure, scripts, animations
and source file work use WORLD-API.md and the native workspace submission flow.

Tests are chosen by the Agent. Keep /goal continuous execution, and do not add
automatic verification, an independent testing Agent, or an acceptance gate.
`;
}

export function nativeWorldApiGuide(manifest){
  if(manifest.schema!==NATIVE_SCHEMA)return '';
  return `# WORLD-API: creation-native-1

Native Godot source files are the only game source authority. native_nodes and
semantic values returned by world_read are engine-generated indices of those
files, not another editable scene schema. Scenes/prefabs use real .tscn/.scn references
and per-property overrides. .atelier/catalog.json is the complete scene/prefab
directory and semantic description map. Keep unknown native nodes, resources,
animations, connections and source files when saving.

${AGENT_PREFAB_GUIDANCE}

## Read and edit

Read world_read before changing shared source. It includes source_files hashes,
resource/native_nodes indices, stable node_id + full instance_ids, and property
versions. For a native scalar edit, world_apply accepts:
{type:"set_native_property", resource_id, target:{node_id,instance_ids:[]},
 property, expected_property_version, value}.
Reset an instance override with reset_native_property and the same guards.
Use the engine-returned value encoding for vectors, transforms and resources.
Do not convert a full Transform3D to legacy flat Euler values.
Editor aliases without STORAGE usage cannot be set independently. Use
native_scene_operation transform for complete local TRS, or transform_world
for a complete 3D world matrix, with the current resource expected_version.
Use the actual native_mount_target for an instance placement when supplied.

## Native Control layout

Control layout is editable through real Godot layout and .tscn storage. Read the
node's control_layout values/fields and current resource version, then submit:
{type:"native_scene_operation",resource_id,expected_version,
 operation:{op:"control_layout",target:{node_id,instance_ids:[]},
 viewport_size:[1280,720],value:{size:[320,180],pivot_offset:[160,90]}}}.
value supports anchors/offsets [left,top,right,bottom], position/size/pivot_offset/
scale/custom_minimum_size [x,y], rotation_degrees, grow_horizontal/vertical,
size_flags_horizontal/vertical and positive size_flags_stretch_ratio. Size is
nonnegative and scale nonzero. Do not mix offsets with position/size in one edit.
Use operation.preset:"full_rect" (also top_left/center/top_right/bottom_left/
bottom_right and stretch presets), or operation.reset:["offsets"] independently
of value/preset. Position/size both store offsets; they are not separate overrides.
Use editable/resettable/storage_properties from the engine. A parent Container
owns its direct Control children's geometry: only custom_minimum_size, size flags
and stretch ratio are editable there. Re-read after a resource-version conflict;
never replace Container layout with guessed transforms or legacy JSON geometry.

The platform prepares an editable Godot project before your turn. Read
workspace.json godot_project and use its project_directory as the command cwd.
Edit native scripts, scenes, configuration and asset files there. workspace_prepare
can explicitly prepare another fixed revision and its editable_project_directory.
The server workspace supports downloading public assets and importing the actual
files, including PNG, GLB and other native formats. Godot native geometry, Pillow
image generation and Blender modeling may read/write files within this workspace
when those tools are available. Use background/bounded execution and the declared
Godot launcher. Save downloaded/generated assets in the editable project and refer
to their res:// paths from scenes and scripts. Keep acquisition sources, licenses,
attribution and necessary texture/model dependencies alongside the assets.

Asset reference receipts are a context-size policy, not read-only asset permission.
Programs may read, copy, generate, replace and delete workspace asset files. Keep
raw bytes, base64, embedded images and whole Resource objects out of tool arguments,
tool output and conversation. Return file paths, hashes, sizes, license references
and only the metadata needed for the current step; inspect selected details on demand.
Keep .atelier metadata and preserve the fixed baseline. Run through GameRuntime Autoload
and atelier_runtime/standalone.tscn; do not start gameplay from the model-editor host.

Submit that local copy through the already-declared world_apply tool:
{
 "transaction_id":"<new stable transaction ID>",
 "base_revision":"<workspace_prepare.source_revision>",
 "ops":[{"type":"submit_native_workspace", "environment_id":"<prepared id>",
          "path":"work/<edited project>"}]
}
The host compares against the server's fixed environment, reads exact file bytes
from disk and commits native put_source_file/delete_source_file operations
atomically. This includes asset additions, replacement and deletion; the host
constructs any binary transport internally and returns only a compact file receipt.
Unchanged runtime overlays are not written back. Changes to generated files in
atelier_runtime/ are rejected with their paths. Original author files keep their
paths even when named release.json. Unchanged framework-injected launch settings
are removed when submitting an edited project.godot; actual author settings survive.
Unknown new author files are retained or explicitly
rejected by the source-path policy. Engine/VCS/package caches are excluded and
listed. More than 100 changed source files use one complete import guarded by
the original source head; rebase first if collaborators changed that head.

To submit a small exact file change directly, world_apply accepts
{type:"put_source_file",path,text:<UTF-8 string>,expected_hash:<current hash|null>}
delete_source_file requires expected_hash. For asset changes, use local file IO
and submit_native_workspace. Do not inline binary payloads in world_apply or
import_native_project; the workspace submission handles their transport internally.
If a local edit conflicts, keep it in work/, read current source, and merge it.
Do not claim a local file or a release.json edit updated central source.

## Game implementation and testing

### Prefab capability previews

When capability previews are useful or requested, create reusable scenarios in
test_scenes/<scenario-id>/ using real
PackedScene instances of the subject and targets. Register each .tscn in
.atelier/catalog.json resources with id,kind:"scene",purpose:"prefab_test",
subject_id:<actual prefab id>,name,path and optional design.description.
Every scene in test_scenes/ must be registered this way. Keep helper scripts,
test-only resources and automated check plans in test_scenes/ as well. These
files remain in shared versioned source and authoring workspaces, and are
excluded from game applications/Play/public releases. A game scene or script
must never depend on test_scenes/. Do not change the project's main scene.

The workbench's prefab "能力预览" entry launches the registered scene through
the same GameRuntime and standalone.tscn. In a workspace use workspace_prepare
resource_id:<scenario id> and F5/--path, or -- --release-scene=<scenario id>.
Actual AnimationPlayer and AnimatedSprite2D/3D clips are discovered at runtime;
the timeline samples pose only, without replaying damage, audio or method tracks.
For procedural effects expose explicit actions with kind:"animation" and
animation_kind:"procedural" in the test adapter; explain when they trigger real
skill effects. Never invent animation clips or duplicate combat implementation.
Keep the subject prominent in its own game's visual setting. Separate intrinsic
subject animation/abilities/states/controllers from external targets, damage,
health presets and simulated player inputs. Do not silently create a target in
an active skill: expose target setup separately and report its missing dependency.

The test scene root may expose these native functions:
func atelier_preview_capabilities() -> Dictionary:
    return {"title":"主体名", "animation_note":"真实动画说明", "actions":[
        {"id":"fire","label":"发射一次","scope":"subject","kind":"ability"},
        {"id":"target","label":"放置靶子","scope":"scene","kind":"fixture"}]}
func atelier_preview_action(action_id:String,parameters:Dictionary) -> Dictionary:
    # Call the subject's real skill here. Validate parameters explicitly.
    return {"ok":true}
func atelier_preview_state() -> Dictionary:
    return {"target_hp":100} # Read actual state, never fabricate test evidence.
func atelier_preview_selection() -> Dictionary:
    # Return current observed selection and unmet action prerequisites.
    return {"action_ids":[], "status":"待机", "blocked_actions":{}}
signal atelier_preview_event(event:Dictionary)

Actions must be declared IDs. The browser cannot call arbitrary node methods.
Each action declares scope:"subject" or "scene", kind:"animation"/"ability"/
"state"/"controller"/"passive"/"fixture", description, and mode:"trigger" or
"select". Only sustained native modes belong in selection.action_ids; return
these from runtime state, not from the most recently clicked button. External
passive/fixture actions always belong to scene scope. A missing target can be
returned as selection.blocked_actions:{"fire":"需要前方僵尸靶子"}. Flat legacy
actions remain callable in scene tools with legacy:true; the workbench never
guesses which unclassified actions are intrinsic subject behavior.
Emit concise actual hit/drop/state events and expose useful observation values.
Include target reset, representative states and skill examples when appropriate.
Manual tests and explicitly requested Agent/automation tests share this scene;
none run automatically after edits or Agent completion. Keep /goal execution.
For explicit automated checks, save a JSON plan under test_scenes/. Example:
{"steps":[{"command":{"action":"action","action_id":"fire","parameters":{}}},
{"wait_frames":60},{"expect":{"path":"observations.target_hp","equals":75}}]}
Run the registered canonical project with Godot --headless --path <project> --
--release-scene=<scenario-id> --prefab-test-plan=res://test_scenes/<id>/checks.json
--prefab-test-report=<absolute-session-output.json>. The report binds the actual
engine results to the fixed source and scenario; failed checks exit nonzero.
Plans are bounded to 256 steps, 600 frames per wait and 1800 total frames.
Assertion failure is a test result, never a source-save gate.

New native scripts may extend real Node/Resource classes and use normal Godot
lifecycle. API 1 RefCounted behavior wrappers are for migrated legacy content;
their independent exported fields participate in native instance overrides.
asset_publish only supports legacy GDScript text publication. Native projects
submit scripts, scenes, resources and downloaded/generated asset files together
through submit_native_workspace. A legacy tool limitation is not an asset import
restriction on the native Godot project.

## Explicit native shared-authority games

Shared games run the fixed real PackedScene and author scripts on one central
Godot authority. Clients use a script-free PackedScene projection plus trusted
input bindings. Add declarations to real scene metadata, for example:
metadata/wa_node_id="actor-root"
metadata/wa_shared={"version":1,"state":["score","velocity"],"defaults":["speed"],
 "inputs":{"move":{"method":"shared_move","owner":true}},"input_stop":"shared_stop"}
In the author script, use @export var speed=160.0; state variables need not be
@export. shared_move(player_id:String,payload:Variant) handles validated intent;
shared_stop(player_id:String) must clear held movement/actions. Validate gameplay
payload values yourself. Empty inputs, leave and a 750ms timeout invoke real stop
logic for that player's owned entities and ownerless global nodes. owner:true
rejects other players; owner:false explicitly declares a global action. Clients
cannot arbitrarily set authority properties.

state and defaults must be disjoint. Declare all required private/Autoload state;
finite JSON, vectors, Color and Transform2D/3D are supported. Node/Resource/
Callable/RID and arbitrary unregistered runtime memory are not transferable.
Stable Node2D/Node3D transforms preserve full matrices. Declare changing Label
text/Control position/size as state; client private state is a shadow, not a Node
script. State version changes require shared_migrate_state(previous_version,state)
to return a serializable Dictionary; missing nodes/types/migration reject restore.

GameRuntime.shared.spawn(resource_id,spawn_id,parent_key="",owner_id="",initial_state={})
creates a fixed native resource; despawn(spawn_id), key_for(node), player(id),
players() and is_authority() are available. Use spawn for replicated dynamic nodes
and unique stable spawn IDs. Keys are JSON.stringify([full_instance_ids,node_id]).
Signals: player_joined(player Dictionary with id/name/color/online/last_input_seq),
player_left(player_id), player_input_stopped(player_id), initialized, and
scene_loaded(resource_id,scene_generation). GameRuntime.open_scene(resource_id)
loads another fixed scene. New scenes can enumerate online players on scene_loaded;
player_joined is not replayed on every scene switch. Check shared.restoring to avoid
duplicate _ready spawns during checkpoint restore. Autoload declarations use stable
wa_node_id/wa_shared metadata and retain only their declared state. In independent
Play, GameRuntime.shared is null; guard shared-only hooks and implement local play
explicitly when the game supports both modes.

Bind real InputMap/Control input through scene metadata:
metadata/wa_shared_keys=[{input_action:"move_right",action:"move",
 target_key:"@owner:actor-root",payload:{x:1},released_payload:{x:0}}]
metadata/wa_shared_bind={action:"fire",target_key:"@owner:actor-root",payload:{}}
wa_shared_bind is for native Buttons; input_action names the project's InputMap.
Target defaults to the binding node's full key. The framework waits for a real
snapshot-applied ACK before control and fences world/epoch/source/scene generation
and input sequence. Shared inspection sends zero input, waits for authority ACK,
then freezes only that client's presentation; other players and authority continue.

Keep compatible exported-default changes separate from declared runtime state:
explicit shared publication can apply them in the same authority process with
state retained and rollback on failure. New spawns/scenes see committed defaults
before _ready. Script/structure changes use validated checkpoint process transfer;
new fixed source defaults replace old-process overlays. Never promise arbitrary
script-memory migration or describe process transfer as in-process hot reload.
Source receipts and completed builds do not publish or upgrade a shared room.
Use shared_world_validate/world_publish only for explicitly requested shared work.
Normal editor Play is independent per browser, starts from initial state, and its
inspection pauses only that local run. Independent public game releases use their
separate explicit publication flow; world_publish is not an independent Play or
ordinary source-save operation. Keep validation optional; do not add a gate.

Keep project/branch/session scope and immutable attachment identities. The host
rechecks membership, run lease, source/file/property versions and idempotency
before publication of a candidate. A receipt means source saved. Editor Play,
standalone Web and native exports consume a fixed canonical game snapshot.
Tests are your choice: workspace_test/game_validate are optional technical
checks, never an automatic acceptance gate. shared_world_validate/world_publish
remain reserved for an explicit shared-authority task. Keep native /goal.
`;
}

export function readNativeAgentSource({service,user,project_id,branch_id,input={},maxBytes=SOURCE_READ_BYTES}){
  if(input.source_path){
    const listing=service.native.source(user,project_id,branch_id,{revision:input.revision}),entry=listing.files[input.source_path];
    if(!entry)fail(404,'源文件不存在');
    if(agentAssetPath(input.source_path))return nativeAssetReference({revision:listing.revision,source_identity:listing.source_identity,path:input.source_path,...entry},input.source_path);
    if(entry.size>Math.min(SOURCE_READ_BYTES,maxBytes))fail(413,'源文件超过工具内联读取上限；请用 workspace_prepare 读取完整工程',{path:input.source_path,size:entry.size,max_bytes:Math.min(SOURCE_READ_BYTES,maxBytes)});
    input={...input,revision:listing.revision};
  }
  const value=service.native.source(user,project_id,branch_id,{revision:input.revision,...(input.source_path?{path:input.source_path}:{})});
  if(!input.source_path)return value;
  const bytes=Buffer.from(value.data_base64,'base64');
  if(bytes.length>maxBytes)fail(413,'源文件超过工具内联读取上限；请用 workspace_prepare 读取完整工程',{path:input.source_path,size:bytes.length,max_bytes:maxBytes});
  const {data_base64,...metadata}=value,text=agentText(bytes,input.source_path);
  return text===null?nativeAssetReference(metadata,input.source_path):{...metadata,text,encoding:'utf8'};
}

function nativeAssetReference(metadata,path){
  return {...metadata,resource_path:'res://'+path,encoding:'resource-reference',context_only:true,editable_via:'submit_native_workspace',usage:'这里只返回上下文引用；允许服务器工具在可编辑工程中下载、生成、读取、替换或删除资产文件，再通过 submit_native_workspace 提交。不要把原始字节、base64 或完整资源对象放进对话。'};
}

function workDirectory(cwd,inputPath){
  if(typeof inputPath!=='string'||!inputPath||inputPath.includes('\0'))fail(422,'提交需要 work/ 内的工程路径');
  const base=realpathSync(cwd),wanted=resolve(base,inputPath),parts=relative(base,wanted).split(sep);
  if(parts[0]!=='work'||parts.length<2||parts.some(part=>!part||part==='..'||part==='.'))fail(403,'只能提交本会话 work/ 中的工程副本');
  let cursor=base;
  for(const part of parts){cursor=join(cursor,part);const stat=lstatSync(cursor);if(stat.isSymbolicLink()||!stat.isDirectory())fail(403,'工程目录不允许符号链接');}
  if(realpathSync(cursor)!==wanted)fail(403,'工程目录发生替换');return wanted;
}

/** Expand only the host convenience operation. Permission, revision merge,
 * run lease and receipts stay in the existing central service.committed path.
 * The input is captured before that asynchronous central preparation begins. */
export function expandNativeWorkspaceApply({service,user,session,run,cwd,input,guard=()=>{},signal}){
  if(!input.ops?.some(op=>op.type==='submit_native_workspace'))return {input,summary:null};
  if(input.ops.length!==1)fail(422,'工程副本提交必须作为独立原子事务');
  guard();if(signal?.aborted)fail(409,'工具所属执行已结束');
  const op=input.ops[0],prepared=service.store.get('creator_environment',op.environment_id);
  if(!prepared||prepared.session_id!==session.id||prepared.project_id!==session.project_id||prepared.branch_id!==session.branch_id||prepared.user_id!==session.owner_user_id||prepared.run_id!==run.id||prepared.lease_generation!==run.lease_generation)fail(403,'固定工程不属于当前会话和执行租约');
  service.store.sessionFor(user,session.id,true);
  const branch=service.store.branchFor(user,session.project_id,session.branch_id,true),fixed=service.store.get('creator_revision',prepared.source_revision);
  if(!fixed||fixed.project_id!==session.project_id||fixed.manifest.schema!==NATIVE_SCHEMA||!service.store.ancestor(fixed.id,branch.head))fail(409,'固定原生源版本不属于当前分支');
  if(input.base_revision!==prepared.source_revision)fail(409,'工程提交的 base_revision 必须与固定工程基线一致');
  if(prepared.source_schema!==NATIVE_SCHEMA||!prepared.native_workspace_files||prepared.native_source_identity!==nativeSourceIdentity(fixed.manifest.source_files)||stable(prepared.native_source_files)!==stable(fixed.manifest.source_files))fail(409,'固定工程缺少可信原生往返基线；请重新 workspace_prepare');
  const source=nativeFileMap(fixed.manifest.source_files),baseline=nativeFileMap(prepared.native_workspace_files);
  const candidate=scanNativeWorkspace(workDirectory(cwd,op.path),{retainBytes:true,guard:()=>{guard();if(signal?.aborted)fail(409,'工具所属执行已结束');}});
  const operations=[],changes=[],managedChanged=[];
  for(const path of new Set([...Object.keys(source),...Object.keys(baseline),...Object.keys(candidate.files)])){
    const before=source[path],preparedFile=baseline[path],after=candidate.files[path];
    if(preparedFile&&!before){
      if(!sameEntry(preparedFile,after))managedChanged.push(path);
      continue;
    }
    if(!before&&!preparedFile&&path.startsWith('atelier_runtime/')){
      if(path.endsWith('.gd.uid')){candidate.excluded.push(path);continue;}
      fail(422,'新源文件不能放入框架运行目录',{path});
    }
    if(before&&!after){operations.push({type:'delete_source_file',path,expected_hash:before.hash});changes.push({path,kind:'delete',before,after:null});continue;}
    if(!after||sameEntry(preparedFile??before,after))continue;
    let bytes=candidate.contents.get(path);
    // Context projections omit binary payloads; they do not limit author files.
    // The trusted host captured these bytes from the scoped workspace, never
    // from model-supplied base64 or a context resource object.
    if(path==='project.godot'&&before&&preparedFile){
      const fixedBytes=readFileSync(join(prepared.project_directory,path));
      if(hash(fixedBytes)!==preparedFile.hash)fail(409,'固定工程设置已变化，请重新准备环境');
      const original=service.native.archive.read(before);
      bytes=Buffer.from(nativeSourceSettingsFromWorkspace(original.toString('utf8'),fixedBytes.toString('utf8'),bytes.toString('utf8')));
      if(hash(bytes)===before.hash)continue;
    }
    operations.push({type:'put_source_file',path,expected_hash:before?.hash??null,data_base64:bytes.toString('base64')});
    changes.push({path,kind:before?'modify':'add',before:before??null,after:{hash:hash(bytes),size:bytes.length}});
  }
  if(managedChanged.length)fail(422,'生成运行文件发生修改；请保留真实源文件修改并恢复这些生成文件',{paths:managedChanged.sort()});
  if(!operations.length)fail(422,'工程副本没有源文件修改',{excluded:candidate.excluded});
  operations.sort((a,b)=>a.path.localeCompare(b.path));changes.sort((a,b)=>a.path.localeCompare(b.path));
  let expanded={...clone(input),ops:operations},mode='file_differences';
  if(operations.length>100){
    // Central operation limit is 100. Preserve atomicity with one full native
    // import and a strict baseline head, not a sequence of partial commits.
    if(branch.head!==input.base_revision||input.expected_head!==undefined&&input.expected_head!==input.base_revision)fail(409,'超过 100 个文件的原子工程提交需要先合并到当前源版本');
    const complete=new Map();
    for(const path of Object.keys(source)){
      const original=service.native.source(user,session.project_id,session.branch_id,{revision:fixed.id,path});
      complete.set(path,{path,data_base64:original.data_base64});
    }
    for(const operation of operations)if(operation.type==='delete_source_file')complete.delete(operation.path);else complete.set(operation.path,{path:operation.path,data_base64:operation.data_base64});
    expanded={...clone(input),expected_head:input.base_revision,ops:[{type:'import_native_project',files:[...complete.values()].sort((a,b)=>a.path.localeCompare(b.path))}]};mode='complete_native_import';
  }
  guard();return{input:expanded,workspace_snapshot:{directory:candidate.directory,files:candidate.files},summary:{environment_id:prepared.id,base_revision:prepared.source_revision,source_identity:prepared.native_source_identity,mode,changed_files:changes,excluded:candidate.excluded,origin:originOf(run,session)}};
}

export async function commitNativeWorkspaceApply(options){
  const {service,user,session,run}=options,expanded=expandNativeWorkspaceApply(options);
  const result=await service.committed(user,session.project_id,session.branch_id,expanded.input,originOf(run,session));
  const editing=service.store.get('creator_editable_project',session.id);
  if(expanded.workspace_snapshot&&editing&&realpathSync(editing.directory)===expanded.workspace_snapshot.directory){
    service.store.put('creator_editable_project',{...editing,last_submission:{revision:result.revision,files:expanded.workspace_snapshot.files}});
  }
  return {result,expanded_input:expanded.input,...(expanded.summary?{workspace_submission:expanded.summary}:{})};
}

export function nativeTargetsForOperations(manifest,scope,ops,revision,{changed_resources=[]}={}){
  if(manifest.schema!==NATIVE_SCHEMA)return [];
  const resources=new Set(changed_resources),explicit=[];
  for(const op of ops??[]){if(op.resource_id)resources.add(op.resource_id);if(op.target&&op.resource_id)explicit.push([op.resource_id,op.target]);}
  const targets=new Map();
  const add=(resourceId,node)=>{
    if(!node?.node_id||node.addressable===false||(node.instance_ids??[]).some(id=>!id))return;
    const address={project_id:scope.project_id,branch_id:scope.branch_id,resource_id:resourceId,instance_path:clone(node.instance_ids??[]),definition_node_id:node.node_id};
    const value={address,resource_id:resourceId,object_id:address.instance_path.length?null:node.node_id,source_revision:revision,object_version:node.version??null,resource_version:manifest.resources[resourceId]?.version??null,definition_revision:null};
    targets.set(stable(address),value);
  };
  for(const resourceId of resources)for(const node of manifest.resources[resourceId]?.native_nodes??[])add(resourceId,node);
  for(const [resourceId,target]of explicit){const node=manifest.resources[resourceId]?.native_nodes?.find(node=>node.node_id===(target.node_id??target.definition_node_id)&&stable(node.instance_ids??[])===stable(target.instance_ids??target.instance_path??[]));if(node)add(resourceId,node);}
  return [...targets.values()];
}
