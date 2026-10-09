import { readFileSync, readdirSync, statSync, lstatSync, realpathSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { projectPolicyInventory } from './project-policy.mjs';
import { clone, fail, hash } from './schema.mjs';
import { HIERARCHY_SCHEMA } from './hierarchy.mjs';
import { NATIVE_SCHEMA } from './native-source.mjs';
import { assembleNativeProject } from './native-snapshot.mjs';
export const GAME_PROJECT_CONTRACT='world-atelier-game-project-v1';
export const GAME_STORAGE_POLICY='world-atelier-game-storage-v1';
const SHARED_RUNTIME_FILES=new Set(['scene_loader.gd','world_simulation.gd','world_projection.gd','scene_factory.gd','behavior_registry.gd','behavior_context.gd','hierarchy_scene.gd','runtime_capabilities.gd','runtime_capabilities.json']);
const GAME_PROJECT_SETTINGS=`config_version=5

[application]
config/name="World Atelier Game"
run/main_scene="res://standalone.tscn"
config/features=PackedStringArray("4.6", "GL Compatibility")

[autoload]
GameRuntime="*res://standalone.gd"

[display]
window/size/viewport_width=1000
window/size/viewport_height=700
window/stretch/mode="canvas_items"
window/stretch/aspect="expand"

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
textures/default_filters/use_nearest_mipmap_filter=false
textures/vram_compression/import_etc2_astc=true
`;
/** Persist only a save-domain identity, never a save or source mutation. Existing
 * exported projects retain their original Godot config/name save namespace. */
export function gameStorage(service,project_id,branch_id){
  const key=project_id+':'+branch_id,existing=service.store.get('creator_game_storage',key);
  if(existing)return existing;
  const legacy=service.store.list('creator_build').filter(j=>j.project_id===project_id&&j.branch_id===branch_id&&!j.game_project_contract&&j.project_name).sort((a,b)=>b.created_at-a.created_at);
  const record={id:key,project_id,branch_id,policy:GAME_STORAGE_POLICY,namespace:legacy[0]?.project_name??key,legacy_namespaces:[...new Set(legacy.map(j=>j.project_name))],legacy_namespace_preserved:Boolean(legacy.length),editor:'memory_only_per_iframe',standalone:'godot_user_data',created_at:Date.now()};
  service.store.put('creator_game_storage',record);return record;
}
const quoted=v=>JSON.stringify(String(v));
const jsonFile=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
export function projectInventory(path,base=path){
  return readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    if(entry.name.startsWith('.')||['tests','README.md','export_presets.cfg','project-inventory.json'].includes(entry.name))return [];
    const full=join(path,entry.name);
    if(entry.isSymbolicLink())throw Error('构建源码不允许符号链接');
    return entry.isDirectory()?projectInventory(full,base):[{path:relative(base,full),sha256:hash(readFileSync(full)),size:statSync(full).size}];
  });
}
function stripCapabilities(value){
  const packet=clone(value),strip=url=>typeof url==='string'?url.split('?')[0]:url;
  for(const object of packet.objects??[]){
    if(object.model_url)object.model_url=strip(object.model_url);
    for(const behavior of object.components?.behaviors??[])behavior.script_url=strip(behavior.script_url);
  }
  for(const asset of packet.asset_access??[])asset.url=strip(asset.url);
  return packet;
}


/** Copy trusted runtime inputs once, before any asynchronous job work. */
export function snapshotProjectRuntime(root,directory){
  mkdirSync(directory,{recursive:true});
  if(readdirSync(directory).length)fail(409,'工程投影目标必须为空目录');
  for(const source of [join(root,'runtimes/model-preview'),join(root,'tools/release-template')]){
    for(const file of projectInventory(source)){
      if(source.endsWith('runtimes/model-preview')&&!SHARED_RUNTIME_FILES.has(file.path)&&!file.path.startsWith('fonts/'))continue;
      const target=join(directory,file.path);mkdirSync(dirname(target),{recursive:true});cpSync(join(source,file.path),target);
    }
  }
  writeFileSync(join(directory,'project.godot'),GAME_PROJECT_SETTINGS);
  writeFileSync(join(directory,'game-project.json'),JSON.stringify({format:1,contract:GAME_PROJECT_CONTRACT,generator:projectPolicyInventory(resolve(import.meta.dirname,'../..'),{generatorOnly:true}),entry:'res://standalone.tscn',autoload:'GameRuntime',source_authority:'central_source_service',editor_preview_host:false,storage_policy:GAME_STORAGE_POLICY},null,2)+'\n');
  const files=projectInventory(directory);return {files,hash:hash(files),contract:GAME_PROJECT_CONTRACT};
}
export function verifyProjectFiles(directory,files){
  const base=realpathSync(directory);
  for(const file of files){
    const target=resolve(base,file.path);
    if(!target.startsWith(base+sep)||!lstatSync(target).isFile()||!realpathSync(target).startsWith(base+sep)||hash(readFileSync(target))!==file.sha256)fail(409,'固定工程输入已变化，请重新准备环境');
  }
}
/** One pinned project projection for authoring, independent checks and export. */
export async function assembleProject({service,user,project_id,branch_id,revision,entry_scene_id,directory,runtime_source_hash,project_name,allowPrefab=false,readOnly=false,storage=null,game_identity=null,purpose='authoring'}){
  const branchNow=service.store.branchFor(user,project_id,branch_id,!readOnly);
  const fixed=service.store.get('creator_revision',revision);
  if(!fixed||fixed.project_id!==project_id||!service.store.ancestor(revision,branchNow.head))fail(409,'源版本不属于此分支');
  const manifest=fixed.manifest;
  entry_scene_id??=manifest.entry_scene_id;
  if(!manifest.resources[entry_scene_id]||!allowPrefab&&!(purpose==='prefab_test'&&manifest.schema===NATIVE_SCHEMA)&&manifest.resources[entry_scene_id].kind!=='scene')fail(422,'运行入口资源无效');
  project_name??=service.store.projectFor(user,project_id).name;
    storage??=gameStorage(service,project_id,branch_id);
    if(manifest.schema===NATIVE_SCHEMA)return assembleNativeProject({service,manifest,directory,runtimeFiles:projectInventory(directory),project_id,branch_id,revision,entry_scene_id,project_name,storage,runtime_source_hash,game_identity,contract:GAME_PROJECT_CONTRACT,purpose});
    const source=directory,scenes={},assets={};
    const capabilities=JSON.parse(await readFile(join(source,'runtime_capabilities.json'),'utf8'));
    const branch={branch_id:branch_id,head:revision,manifest};
    await mkdir(join(source,'bundled'),{recursive:true});await mkdir(join(source,'resources'),{recursive:true});
    const closure=new Map();
    const collectDefinitions=value=>{
      if(!value||typeof value!=='object')return;
      if(typeof value.model_hash==='string'&&/^[a-f0-9]{64}$/.test(value.model_hash))closure.set(value.model_hash,'glb');
      if(typeof value.script_hash==='string'&&/^[a-f0-9]{64}$/.test(value.script_hash))closure.set(value.script_hash,'gd');
      for(const child of Object.values(value))collectDefinitions(child);
    };
    collectDefinitions(manifest);
    // Resolve every resource, including unplaced prefabs, against the same source.
    for(const doc of Object.values(manifest.resources)){
      const packet=stripCapabilities(service.assets.scene(user,project_id,branch,doc.id,'',manifest.schema===HIERARCHY_SCHEMA?capabilities:{}));
      packet.name=doc.name;packet.kind=doc.kind;
      scenes[doc.id]=packet;
      await jsonFile(join(source,'resources',hash(doc.id)+'.json'),doc);
      for(const object of packet.objects??[]){
        if(object.model_hash)closure.set(object.model_hash,'glb');
        for(const behavior of object.components?.behaviors??[])closure.set(behavior.script_hash,'gd');
      }
      for(const asset of packet.asset_access??[])closure.set(asset.hash,asset.extension);
    }
    for(const [digest,ext] of closure){
      if(!service.store.assetAllowed(project_id,digest,ext))throw Error('构建依赖没有项目访问权限');
      const bytes=await readFile(join(service.assets.directory,`${digest}.${ext}`));
      if(hash(bytes)!==digest)throw Error('构建资产 SHA-256 校验失败');
      const filename=`${digest}.${ext}.${ext==='gd'?'txt':'bin'}`;
      await writeFile(join(source,'bundled',filename),bytes);assets[`/preview-assets/${digest}.${ext}`]=`res://bundled/${filename}`;
    }
    await jsonFile(join(source,'release.json'),{format:2,...(game_identity?{game_identity,content_key:game_identity.content_key,canonical_identity:game_identity.content_key}:{}),game_project_contract:GAME_PROJECT_CONTRACT,storage:{policy:storage.policy,namespace:storage.namespace,editor:storage.editor,standalone:storage.standalone},project_name:project_name,project_id:project_id,branch_id:branch_id,revision:revision,entry_scene_id:entry_scene_id,runtime_source_hash:runtime_source_hash,scenes,assets});
    await jsonFile(join(source,'source-manifest.json'),manifest);
    let config=await readFile(join(source,'project.godot'),'utf8');
    config=config.replace(/^config\/name=.*$/m,`config/name=${quoted(storage.namespace)}`).replace(/^run\/main_scene=.*$/m,'run/main_scene="res://standalone.tscn"');
    await writeFile(join(source,'project.godot'),config);
    return source;
}
