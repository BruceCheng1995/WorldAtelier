import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,renameSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {hash} from '../services/creation/schema.mjs';
import {nativeSourceIdentity,nativeFileMap} from '../services/creation/native-source.mjs';
import {NativeProjects} from '../services/creation/native-project.mjs';
import {assembleNativeProject} from '../services/creation/native-snapshot.mjs';
import {prepareExecutionEnvironment} from '../services/creation/execution-environment.mjs';
import {runNativeScene,importNativeProject} from './native-scene/invoke.mjs';

export const NATIVE_OFFLINE_RUNTIME_CONTRACT='world-atelier-native-offline-canonical-1';
const GAME_CONTRACT='world-atelier-game-project-v1';

export function verifyOfflineAssembler(policy){
  const {sha256,...body}=policy??{};
  if(body.contract!==NATIVE_OFFLINE_RUNTIME_CONTRACT||sha256!==hash(body))throw Error('离线装配器身份不完整，请联网更新工作区运行支持');
  if(typeof globalThis.__WA_NATIVE_OFFLINE_POLICY__==='string'){
    if(globalThis.__WA_NATIVE_OFFLINE_POLICY__!==sha256)throw Error('同步工具与缓存的规范装配器版本不匹配，请下载对应同步工具或刷新运行支持');return true;
  }
  // Development invocation uses the same checked source closure. Portable
  // clients carry this identity in their generated bundle instead.
  const root=resolve(import.meta.dirname,'..');
  for(const file of body.files??[]){const path=resolve(root,file.path);if(!path.startsWith(root+sep)||! /^(tools|services|packages)\/.+\.(mjs|js|gd)$/.test(file.path)||file.path.split('/').some(part=>part.startsWith('.')))throw Error('离线装配器清单路径无效');const bytes=readFileSync(path);if(bytes.length!==file.size||hash(bytes)!==file.hash)throw Error('当前工具源码与缓存装配器不匹配，请刷新运行支持');}
  return true;
}

function audioEnvironment(options){
  const environment=prepareExecutionEnvironment(options);
  return {...environment,command(executable,args,metadata){const copy=[...args];if(metadata?.godot&&!copy.includes('--audio-driver')){const split=copy.indexOf('--');copy.splice(split<0?copy.length:split,0,'--audio-driver','Dummy');}return environment.command(executable,copy,metadata);}};
}

/** Offline author files are inspected by the real engine in a disposable copy,
 * then passed to the existing canonical assembler. No cached scene index is
 * treated as the content authority, and no source file is overwritten. */
export async function prepareNativeOfflinePlay({state,files,archive,metadata,descriptor,godotPath,log=()=>{}}){
  verifyOfflineAssembler(descriptor.policy);files=nativeFileMap(files);archive.verify(files);
  const engine=resolve(godotPath??process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot');
  if(!existsSync(engine))throw Error('本机未找到固定 Godot 4.6，请用 --godot=绝对路径指定');
  const engineBytes=readFileSync(engine),engineIdentity={hash:hash(engineBytes),size:engineBytes.length};
  if(!descriptor.engine?.hash||descriptor.engine.hash!==engineIdentity.hash||descriptor.engine.size!==engineIdentity.size)throw Error('本机 Godot 程序与工作区固定工具链不同，请使用匹配程序或联网刷新运行支持');
  archive.verify(descriptor.template_files);archive.verify(descriptor.adapter_files);
  const sourceIdentity=nativeSourceIdentity(files),identity=hash({sourceIdentity,runtime:descriptor.runtime_hash,assembler:descriptor.policy.sha256,engine:engineIdentity,storage:descriptor.storage,project_id:state.project_id,branch_id:state.branch_id});
  const base=join(metadata,'play'),directory=join(base,'local-'+identity),receiptPath=join(directory,'offline-play-receipt.json');mkdirSync(base,{recursive:true,mode:0o700});
  if(existsSync(receiptPath)){
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));let valid=receipt.identity===identity;
    for(const [path,entry]of Object.entries(receipt.project_files??{})){try{const bytes=readFileSync(join(directory,'project',path));if(bytes.length!==entry.size||hash(bytes)!==entry.hash)valid=false;}catch{valid=false;}}
    if(valid){try{valid=nativeSourceIdentity(archive.capture(join(directory,'project')))===nativeSourceIdentity(receipt.project_files);}catch{valid=false;}}
    if(valid)return {...receipt,directory:join(directory,'project'),project:join(directory,'project','project.godot'),reused:true};
  }
  const work=mkdtempSync(join(base,'preparing-')),source=join(work,'source'),runtime=join(work,'project'),adapterDirectory=join(work,'adapter'),diagnostics=join(work,'diagnostics');mkdirSync(diagnostics,{recursive:true});
  let count=0;const observedEngineVersions=new Set();
  const record=(kind,result)=>{if(result?.engine_version)observedEngineVersions.add(String(result.engine_version));const path=join(diagnostics,String(++count).padStart(3,'0')+'-'+kind+'.log');writeFileSync(path,(result?.diagnostics?.stdout??'')+'\n'+(result?.diagnostics?.stderr??''));return result;};
  let native;
  try{
    archive.materialize(files,source);archive.materialize(descriptor.adapter_files,adapterDirectory);
    native=new NativeProjects({store:{},archive,data:join(work,'native-data'),godotPath:engine,enforceIsolation:true,
      engine:async options=>record('index',await runNativeScene({...options,adapterPath:join(adapterDirectory,'adapter.gd'),executionEnvironment:audioEnvironment})),
      importProject:async options=>record('import',await importNativeProject({...options,executionEnvironment:audioEnvironment}))});
    log({stage:'offline_native_import',source_identity:sourceIdentity});
    const manifest=await native.indexDirectory(source,{assignIds:true,previousFiles:state.base_files});
    if(!observedEngineVersions.size||[...observedEngineVersions].some(version=>!/^4\.6(?:[.\s-]|$)/.test(version)))throw Error('离线规范装配只接受已支持的 Godot 4.6 引擎');
    archive.materialize(descriptor.template_files,runtime);
    const runtimeFiles=Object.entries(descriptor.template_files).map(([path,entry])=>({path,sha256:entry.hash,size:entry.size})),revision='offline-'+sourceIdentity;
    assembleNativeProject({service:{native:{archive}},manifest,directory:runtime,runtimeFiles,project_id:state.project_id,branch_id:state.branch_id,revision,entry_scene_id:manifest.entry_scene_id,project_name:descriptor.project_name??state.project_id,storage:descriptor.storage,runtime_source_hash:descriptor.runtime_hash,contract:GAME_CONTRACT,purpose:'authoring'});
    // Validate the actual assembled canonical project as well as source import.
    record('canonical-import',await importNativeProject({projectDirectory:runtime,godotPath:engine,enforceIsolation:true,executionEnvironment:audioEnvironment}));
    const projectFiles=archive.capture(runtime),receipt={format:1,identity,contract:GAME_CONTRACT,offline_contract:NATIVE_OFFLINE_RUNTIME_CONTRACT,project_id:state.project_id,branch_id:state.branch_id,base_revision:state.base_revision,revision,source_identity:sourceIdentity,normalized_source_identity:manifest.source_identity,input_source_files:files,normalized_source_files:manifest.source_files,project_files:projectFiles,entry:'res://atelier_runtime/standalone.tscn',entry_scene_id:manifest.entry_scene_id,scenes:Object.values(manifest.resources).map(resource=>({id:resource.id,path:resource.path,kind:resource.kind})),engine:engineIdentity,engine_versions:[...observedEngineVersions],assembler:descriptor.policy.sha256,runtime_hash:descriptor.runtime_hash,storage:descriptor.storage,local_edits_included:true,network_required:false,source_modified:false,created_at:Date.now()};
    writeFileSync(join(work,'offline-play-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    // A changed previous play project may contain the user's diagnostics. Keep
    // it instead of destroying it when rebuilding the same fixed identity.
    if(existsSync(directory))renameSync(directory,directory+'-retained-'+Date.now());renameSync(work,directory);log({stage:'offline_play_ready',directory:join(directory,'project'),revision});
    return {...receipt,directory:join(directory,'project'),project:join(directory,'project','project.godot'),reused:false};
  }catch(error){writeFileSync(join(work,'failure.json'),JSON.stringify({message:error.message,details:error.details,source_identity:sourceIdentity},null,2)+'\n');error.details={...(error.details??{}),retained_candidate:work};throw error;}
  finally{await native?.close();}
}
