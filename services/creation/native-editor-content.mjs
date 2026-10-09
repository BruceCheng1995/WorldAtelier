import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {hash,fail} from './schema.mjs';
import {NATIVE_SCHEMA,NATIVE_CATALOG} from './native-source.mjs';
import {nativeScenePacket} from './native-view.mjs';
import {verifyProjectFiles} from './project-snapshot.mjs';
import {assembleNativeEditorProject} from '../../tools/native-editor/assemble-native-editor.mjs';

export const NATIVE_CONTENT_PROTOCOL='wa-native-editor-content-1';
const states=new WeakMap();
const editableSource=path=>path===NATIVE_CATALOG||/\.(tscn|scn|tres|res|gd|cs)$/.test(path)||/\.(gd|cs)\.uid$/.test(path);

// Source containers are re-read by Godot, never reconstructed from the query
// index. Media and project settings must still match the resident editor pack.
export function nativeContentCompatible(before,after){
  if(before?.schema!==NATIVE_SCHEMA||after?.schema!==NATIVE_SCHEMA)return false;
  for(const path of new Set([...Object.keys(before.source_files),...Object.keys(after.source_files)])){
    if(before.source_files[path]?.hash!==after.source_files[path]?.hash&&!editableSource(path))return false;
  }
  return true;
}
function authorize(builds,user,p,b,input){
  if(builds.closing)fail(503,'编辑器正在关闭');
  const job=builds.forUser(user,input.build_id);
  if(job.purpose!=='native_preview'||job.project_id!==p||job.branch_id!==b)fail(409,'编辑器不属于当前分支');
  builds.authorizeNativePreview(user,p,b,input.source_revision);
  const fixed=builds.store.get('creator_revision',input.source_revision);
  if(!fixed||fixed.project_id!==p||fixed.manifest.schema!==NATIVE_SCHEMA||!fixed.manifest.resources[input.resource_id])fail(404,'固定原生场景不存在');
  return {job,fixed};
}
export async function prepareNativeEditorContent(builds,user,p,b,input){
  const {job,fixed}=authorize(builds,user,p,b,input);
  if(job.native_content_protocol!==NATIVE_CONTENT_PROTOCOL)return {compatible:false,reason:'editor_upgrade'};
  try{builds.verifyToolchain(job);}catch{return {compatible:false,reason:'editor_upgrade'};}
  const base=builds.store.get('creator_revision',job.source_revision);
  if(!nativeContentCompatible(base?.manifest,fixed.manifest))return {compatible:false,reason:'media_or_settings_changed'};
  let state=states.get(builds);
  if(!state){state={tail:Promise.resolve(),cache:new Map(),controller:new AbortController()};states.set(builds,state);}
  const key=hash([job.id,input.source_revision]);
  let pending=state.cache.get(key);
  if(!pending){
    // One isolated content preparation at a time; identical viewport/object/
    // thumbnail requests share the actual engine work.
    if(state.cache.size>=16)fail(429,'场景更新较多，请稍后重试');
    pending=state.tail.catch(()=>{}).then(async()=>{
      authorize(builds,user,p,b,input);
      const work=await mkdtemp(join(builds.directory,'editor-content-'));
      try{
        const source=join(work,'source'),destination=join(work,'preview');
        verifyProjectFiles(join(builds.directory,job.id,'runtime'),job.runtime_sources);
        builds.service.native.archive.materialize(fixed.manifest.source_files,source);
        const scenes=Object.keys(fixed.manifest.resources).map(rid=>nativeScenePacket(fixed.manifest,rid,{project_id:p,branch_id:b,revision:fixed.id}));
        const packet=scenes.find(scene=>scene.resource_id===input.resource_id);
        const result=await assembleNativeEditorProject({sourceDirectory:source,destinationDirectory:destination,
          runtimeDirectory:join(builds.directory,job.id,'runtime'),
          runtimeFiles:job.runtime_sources.map(file=>file.path).filter(path=>/\.(gd|gdshader|gdshaderinc|tscn|tres|ttf|otf|json)$/.test(path)),
          initialScene:packet,scenes,godotPath:builds.godot,signal:state.controller.signal});
        const receiptBytes=await readFile(join(builds.directory,job.id,'native-preview-receipt.json'));
        if(hash(receiptBytes)!==job.native_preview_receipt?.sha256)fail(409,'编辑器资源回执校验失败');
        const baseReceipt=JSON.parse(receiptBytes);
        const dependencies=receipt=>Object.values(receipt.scenes).flatMap(scene=>scene.dependencies??[]).map(value=>value.split('::').at(-1));
        const available=new Set(dependencies(baseReceipt.receipt));
        if(dependencies(result.receipt).some(path=>!available.has(path)))return {compatible:false,reason:'new_media_dependency'};
        const contents={};let total=0;
        for(const scene of scenes){
          const path=result.config.preview_scenes[scene.native_scene_path];
          const bytes=await readFile(join(destination,path.slice(6)));total+=bytes.length;
          if(bytes.length>16*1024*1024||total>48*1024*1024)return {compatible:false,reason:'large_scene'};
          contents[scene.resource_id]={protocol:NATIVE_CONTENT_PROTOCOL,base_source_identity:base.manifest.source_identity,
            source_identity:fixed.manifest.source_identity,source_revision:fixed.id,resource_id:scene.resource_id,
            native_scene_path:scene.native_scene_path,sha256:hash(bytes),size:bytes.length,data_base64:bytes.toString('base64')};
        }
        builds.verifyToolchain(job);
        verifyProjectFiles(join(builds.directory,job.id,'runtime'),job.runtime_sources);
        return {compatible:true,contents};
      }finally{await rm(work,{recursive:true,force:true});}
    });
    state.cache.set(key,pending);state.tail=pending;
    // Keep only a few completed scene payloads in memory. In-flight requests
    // remain registered so another consumer cannot duplicate the engine job.
    pending.then(()=>{for(const [old,entry]of state.cache){if(state.cache.size<=4)break;if(entry.done)state.cache.delete(old);}pending.done=true;},()=>{state.cache.delete(key);});
  }
  const result=await pending;
  authorize(builds,user,p,b,input); // Permissions may change during preparation.
  builds.verifyToolchain(job);
  return result.compatible?{compatible:true,content:{...result.contents[input.resource_id],related_scenes:Object.values(result.contents).filter(scene=>scene.resource_id!==input.resource_id)}}:result;
}
export async function closeNativeEditorContent(builds){
  const state=states.get(builds);if(!state)return;
  state.controller.abort();await state.tail.catch(()=>{});state.cache.clear();
}
