import {readFileSync,writeFileSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fail} from './schema.mjs';
import {nativeScenePacket} from './native-view.mjs';
import {projectPrefabTestScope,isPrefabTest} from './prefab-tests.mjs';

export const NATIVE_RUNTIME_DIRECTORY='atelier_runtime';
const quoted=value=>JSON.stringify(String(value));

/** Change only selected Godot settings, retaining author input, rendering and
 * additional Autoloads. Native content paths remain exactly as authored. */
export function nativeLaunchSettings(config,{namespace=null,runtimeDirectory=NATIVE_RUNTIME_DIRECTORY}={}){
  const autoload=config.match(/^\[autoload\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1]??'';
  const existing=autoload.match(/^GameRuntime\s*=\s*(.+)$/m)?.[1]?.trim();
  if(existing&&existing!==quoted('*res://'+runtimeDirectory+'/standalone.gd'))fail(422,'GameRuntime 是统一启动保留名称；请为现有 Autoload 使用其他名称');
  // Godot 4.6's text-to-binary export instantiates and repacks scenes. That
  // introduces computed Control layout aliases on inherited roots, whose
  // setters reset real offsets on the next load. Ship native scene resources
  // directly so desktop and exported games use the same authored PackedScene.
  const settings={application:{'run/main_scene':quoted('res://'+runtimeDirectory+'/standalone.tscn'),...(namespace?{'config/name':quoted(namespace)}:{})},autoload:{GameRuntime:quoted('*res://'+runtimeDirectory+'/standalone.gd')},editor:{'export/convert_text_resources_to_binary':'false'},rendering:{'textures/vram_compression/import_etc2_astc':'true','textures/vram_compression/import_s3tc_bptc':'true'}};
  for(const [section,values]of Object.entries(settings)){
    const pattern=new RegExp('(^\\['+section+'\\]\\s*\\n)([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))','m');
    const match=config.match(pattern);
    let body=match?.[2]??'';
    for(const [key,value]of Object.entries(values)){
      const field=new RegExp('^'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[ \\t]*=.*$','m');
      body=field.test(body)?body.replace(field,key+'='+value):body.trimEnd()+'\n'+key+'='+value+'\n';
    }
    config=match?config.replace(pattern,()=>match[1]+body+'\n'):config.trimEnd()+'\n\n['+section+']\n'+body+'\n';
  }
  return config;
}

/** The generated bootstrap is isolated from native author files. The only
 * generated override is the fixed project's launch settings; the source file
 * bytes and their original project.godot stay in the immutable source archive. */
export function assembleNativeProject({service,manifest,directory,runtimeFiles,project_id,branch_id,revision,entry_scene_id,project_name,storage,runtime_source_hash,game_identity,contract,purpose='authoring'}){
  manifest=projectPrefabTestScope(service,manifest,purpose,entry_scene_id);
  const runtime=new Map(runtimeFiles.map(file=>[file.path,readFileSync(join(directory,file.path))]));
  for(const path of Object.keys(manifest.source_files))if(path===NATIVE_RUNTIME_DIRECTORY||path.startsWith(NATIVE_RUNTIME_DIRECTORY+'/'))fail(422,'原生工程占用了框架运行目录',{path});
  // directory is the caller's verified runtime snapshot, not an arbitrary user
  // working tree. Clear only this copied input before source materialization.
  for(const name of readdirSync(directory))rmSync(join(directory,name),{recursive:true,force:true});
  service.native.archive.materialize(manifest.source_files,directory);
  const runtimeNames=new Set(runtime.keys());runtimeNames.add('release.json');
  for(const [path,bytes]of runtime){
    if(path==='project.godot')continue;
    if(['prefab_test_bridge.gd','procedural_animation_capture.gd','prefab_preview_stage.gd','prefab_preview_stage.tscn'].includes(path)&&purpose==='game')continue;
    let value=bytes;
    if(/\.(gd|tscn|tres|json|import)$/.test(path)){
      const original=bytes.toString('utf8');
      let text=original.replace(/res:\/\/([^"'\s)]+)/g,(full,resource)=>runtimeNames.has(resource)?'res://'+NATIVE_RUNTIME_DIRECTORY+'/'+resource:full);
      if(path.endsWith('.import')){
        // Godot's import destination includes MD5 of the res:// source path.
        // Fix both paths before recording immutable build inputs, so a real
        // import does not have to rewrite a supposedly fixed sidecar later.
        const before=original.match(/^source_file="([^"]+)"$/m)?.[1],after=text.match(/^source_file="([^"]+)"$/m)?.[1];
        if(before&&after&&before!==after){const md5=value=>createHash('md5').update(value).digest('hex');text=text.replaceAll('-'+md5(before)+'.','-'+md5(after)+'.');}
      }
      value=Buffer.from(text);
    }
    const target=join(directory,NATIVE_RUNTIME_DIRECTORY,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,value);
  }
  const scenes=Object.fromEntries(Object.values(manifest.resources).map(doc=>[doc.id,nativeScenePacket(manifest,doc.id,{project_id,branch_id,revision})]));
  const automaticPreview=purpose==='prefab_test'&&manifest.resources[entry_scene_id]?.kind==='prefab';
  if(automaticPreview){
    const subject=manifest.resources[entry_scene_id],path=`${NATIVE_RUNTIME_DIRECTORY}/prefab_preview.tscn`;
    // Only the target reference varies. Camera, lighting and mounting belong to
    // one reusable Godot scene, never a generated per-character test scene.
    writeFileSync(join(directory,path),`[gd_scene load_steps=3 format=3]\n[ext_resource type="PackedScene" path="res://${NATIVE_RUNTIME_DIRECTORY}/prefab_preview_stage.tscn" id="1"]\n[ext_resource type="PackedScene" path=${quoted('res://'+subject.path.replace(/^res:\/\//,''))} id="2"]\n[node name="PrefabPreview" instance=ExtResource("1")]\ntarget_scene = ExtResource("2")\n`);
    scenes[entry_scene_id]={...scenes[entry_scene_id],native_scene_path:'res://'+path,objects:scenes[entry_scene_id].objects.map(row=>({...row,native_path:row.native_path==='.'?'Subject':'Subject/'+row.native_path}))};
  }
  const release={format:3,...(automaticPreview?{prefab_test:{resource_id:entry_scene_id,subject_id:entry_scene_id,automatic:true}}:purpose!=='game'&&isPrefabTest(manifest.resources[entry_scene_id])?{prefab_test:{resource_id:entry_scene_id,subject_id:manifest.resources[entry_scene_id].subject_id}}:{}),...(purpose==='authoring'?{prefab_test_resources:Object.fromEntries(Object.values(manifest.resources).filter(isPrefabTest).map(resource=>[resource.id,{resource_id:resource.id,subject_id:resource.subject_id}]))}:{}),...(game_identity?{game_identity,content_key:game_identity.content_key,canonical_identity:game_identity.content_key}:{}),game_project_contract:contract,
    storage:{policy:storage.policy,namespace:storage.namespace,editor:storage.editor,standalone:storage.standalone},project_name,project_id,branch_id,revision,entry_scene_id,runtime_source_hash,source_identity:manifest.source_identity,
    // Migrated API1 script paths become ordinary editable native files. Pin
    // their current bytes, not the historic hash embedded in the scene node.
    native_script_files:Object.fromEntries(Object.entries(manifest.source_files).filter(([path])=>path.endsWith('.gd'))),scenes,assets:{}};
  writeFileSync(join(directory,NATIVE_RUNTIME_DIRECTORY,'release.json'),JSON.stringify(release,null,2)+'\n');
  writeFileSync(join(directory,NATIVE_RUNTIME_DIRECTORY,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  writeFileSync(join(directory,'project.godot'),nativeLaunchSettings(readFileSync(join(directory,'project.godot'),'utf8'),{namespace:storage.namespace}));
  return directory;
}
