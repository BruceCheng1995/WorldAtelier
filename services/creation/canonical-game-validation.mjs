import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,writeFileSync,cpSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {clone,fail,hash,id} from './schema.mjs';
import {snapshotProjectRuntime,verifyProjectFiles,GAME_PROJECT_CONTRACT} from './project-snapshot.mjs';
import {prepareVerificationProject} from './verification-project.mjs';
import {projectPolicyInventory} from './project-policy.mjs';
import {prepareExecutionEnvironment} from './execution-environment.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';
import {NATIVE_RUNTIME_DIRECTORY} from './native-snapshot.mjs';

export const GAME_VALIDATION_CONTRACT='world-atelier-canonical-game-validation-v1';
const SMOKE_TICKS=120;
const PROBE=`extends Node
var finished = false
var frames = 0
var observed_ticks = 0
var scene_ticks = {}
var observed_scenes = []
func _ready() -> void:
\tprocess_mode = Node.PROCESS_MODE_ALWAYS
func _process(_delta: float) -> void:
\tif finished: return
\tframes += 1
\tvar runtime = get_node_or_null("/root/GameRuntime")
\tif runtime == null:
\t\tfinish(false,"Canonical GameRuntime Autoload is missing",null)
\t\treturn
\tif not runtime.failure.is_empty():
\t\tfinish(false,runtime.failure,runtime)
\t\treturn
\tif runtime.running and is_instance_valid(runtime.simulation):
\t\tvar generation = str(runtime.generation)
\t\tvar current_tick = int(runtime.simulation.tick)
\t\tif not scene_ticks.has(generation):
\t\t\tobserved_scenes.append({"resource_id":runtime.current_scene_id,"scene_generation":runtime.generation})
\t\tobserved_ticks += maxi(0,current_tick-int(scene_ticks.get(generation,0)))
\t\tscene_ticks[generation] = current_tick
\t\tif observed_ticks >= ${SMOKE_TICKS}: finish(get_tree().current_scene==runtime.game_scene,"",runtime)
\telif frames >= 1800: finish(false,"Game initialization/tick observation timed out",runtime)
func finish(ok: bool, error: String, runtime: Node) -> void:
\tfinished = true
\tvar report = {"completed":true,"ok":ok,"error":error,"scope":"canonical Godot project startup, native SceneTree lifecycle and real local behavior ticks; no shared-world checkpoint or full gameplay assertion","observer_frames":frames,"observed_ticks":observed_ticks,"observed_scenes":observed_scenes}
\tif runtime != null:
\t\treport.telemetry = runtime.telemetry()
\t\treport.project_id = runtime.release.get("project_id")
\t\treport.branch_id = runtime.release.get("branch_id")
\t\treport.revision = runtime.release.get("revision")
\t\treport.runtime_source_hash = runtime.release.get("runtime_source_hash")
\t\treport.entry_resource_id = runtime.launch_entry
\t\treport.resource_id = runtime.current_scene_id
\t\treport.scene_generation = runtime.generation
\t\treport.runtime_entry = str(runtime.get_script().resource_path)
\t\treport.main_scene = str(get_tree().current_scene.scene_file_path) if get_tree().current_scene != null else ""
\t\treport.scene_count = runtime.list_scenes().size()
\t\treport.prefab_count = runtime.list_prefabs().size()
\t\tif runtime.simulation != null:
\t\t\treport.tick = runtime.simulation.tick
\t\t\treport.authority_fault = runtime.simulation.last_fault
\t\tif runtime.projection != null: report.presentation_fault = runtime.projection.behaviors.fault
\tvar output = FileAccess.open("user://canonical-validation-report.json",FileAccess.WRITE)
\tif output != null:
\t\toutput.store_string(JSON.stringify(report))
\t\toutput.close()
\tprint("CANONICAL_GAME_VALIDATION "+JSON.stringify(report))
\tget_tree().quit(0 if ok else 1)
`;
const jsonFile=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
function metadataTree(directory){return readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
 if(entry.name.startsWith('.')||['tests','README.md','export_presets.cfg','project-inventory.json'].includes(entry.name))return [];
 const path=join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Canonical runtime source contains a symlink');
 if(entry.isDirectory())return metadataTree(path);
 const stat=statSync(path);return [[path,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]];
});}
/** The default game validator. Explicit shared-world validation remains owned by
 * CreationWorlds; it has a different runtime, state baseline and report scope. */
export class CanonicalGameValidation {
 constructor({service}){
  this.service=service;this.store=service.store;this.root=service.root;this.directory=resolve(service.data,'canonical-validation');mkdirSync(this.directory,{recursive:true});
  this.godot=process.env.GODOT_BIN??service.worlds?.godotPath??'/Applications/Godot.app/Contents/MacOS/Godot';this.children=new Set();this.pending=new Set();this.closing=false;
 }
 identity(){
  if(!existsSync(this.godot))fail(503,'统一游戏检查缺少 Godot 可执行文件');
  const validatorFiles=['canonical-game-validation.mjs','verification-project.mjs','execution-environment.mjs','project-policy.mjs'].map(name=>resolve(this.root,'services/creation',name));
  const fileMetadata=path=>{const stat=statSync(path);return [realpathSync(path),stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs];};
  const common={godot:fileMetadata(this.godot),validator:validatorFiles.map(fileMetadata),runtime:metadataTree(resolve(this.root,'runtimes/model-preview')),template:metadataTree(resolve(this.root,'tools/release-template'))};
  if(this.cached){const signature=hash({...common,policy:this.cached.policyFiles.map(fileMetadata)});if(signature===this.cached.signature)return clone(this.cached.value);}
  // Discover converter imports again only after a tracked file changed. Inbox
  // polling must not repeatedly spawn esbuild or hash the Godot executable.
  const policy=projectPolicyInventory(this.root,{generatorOnly:true});
  const policyFiles=policy.files.map(file=>resolve(this.root,file.path));
  const signature=hash({...common,policy:policyFiles.map(fileMetadata)});
  const validatorPolicy=hash(validatorFiles.map(path=>({path:relative(this.root,path),sha256:hash(readFileSync(path))})));
  const godotStat=statSync(this.godot);
  const directory=mkdtempSync(resolve(this.directory,'identity-'));let snapshot;
  try{snapshot=snapshotProjectRuntime(this.root,directory);}finally{rmSync(directory,{recursive:true,force:true});}
  const identity={contract:GAME_VALIDATION_CONTRACT,game_project_contract:GAME_PROJECT_CONTRACT,runtime_source_hash:snapshot.hash,generator_policy_hash:policy.sha256,validator_policy_hash:validatorPolicy,godot_identity:{sha256:hash(readFileSync(this.godot)),size:godotStat.size},smoke_ticks:SMOKE_TICKS};
  const value={...identity,identity_hash:hash(identity)};this.cached={signature,value,policyFiles};return clone(value);
 }
 assertActive(user,p,b,input,identity){
  if(this.closing||input.signal?.aborted)fail(409,'统一游戏检查已经取消');
  input.guard?.();const branch=this.store.branchFor(user,p,b,true);
  if(input.revision&&!this.store.ancestor(input.revision,branch.head))fail(409,'检查候选已不属于当前分支');
  if(identity&&this.identity().identity_hash!==identity.identity_hash)fail(409,'统一游戏运行时或生成器已变化，请重新检查');
 }
 validate(user,p,b,input={}){
  const promise=this.execute(user,p,b,input);this.pending.add(promise);promise.finally(()=>this.pending.delete(promise)).catch(()=>{});return promise;
 }
 async execute(user,p,b,input){
  this.assertActive(user,p,b,input);const branch=this.store.branchFor(user,p,b,true),revision=input.revision??branch.head,fixed=this.store.get('creator_revision',revision),rid=input.resource_id??fixed?.manifest.entry_scene_id;
  if(!fixed||fixed.project_id!==p||!fixed.manifest.resources[rid])fail(404,'固定游戏检查资源不存在');
  if(input.job_id)fail(410,'会话自动检查流程已移除');
  const identity=this.identity(),job={id:id('game-check'),job_kind:'creator_game_verification',actor_id:user.id,project_id:p,branch_id:b,revision,resource_ids:[rid],session_id:input.origin?.session_id??null,run_id:input.origin?.run_id??null,game_validation_identity:identity,game_runtime_source_hash:identity.runtime_source_hash,status:'running',created_at:Date.now()};
  this.store.put('creator_game_verification',job);
  const reportId=id('verification'),directory=resolve(this.directory,reportId);mkdirSync(directory,{recursive:true});
  const record={id:reportId,project_id:p,branch_id:b,resource_id:rid,revision,actor_id:user.id,status:'running',started_at:Date.now(),validation_kind:'canonical_local_game',validation_contract:GAME_VALIDATION_CONTRACT,game_validation_identity:identity,runtime_source_hash:identity.runtime_source_hash,game_validation_job_id:job.id,...(input.origin?{origin:clone(input.origin)}:{})};
  this.store.put('creator_verification',record);let processes=[],prepared;
  try{
   prepared=await prepareVerificationProject({service:this.service,job});
   this.assertActive(user,p,b,{...input,revision},identity);
   if(prepared.manifest.runtime_source_hash!==identity.runtime_source_hash)fail(409,'固定工程与排队时统一运行时不匹配');
   Object.assign(record,{canonical_project_identity:prepared.manifest.canonical_identity,project_hash:prepared.manifest.project_hash,game_project_contract:GAME_PROJECT_CONTRACT});this.store.put('creator_verification',record);
   const work=resolve(directory,'runtime');cpSync(prepared.directory,work,{recursive:true});
   writeFileSync(resolve(work,'canonical_validation_observer.gd'),PROBE);
   const projectPath=resolve(work,'project.godot');writeFileSync(projectPath,readFileSync(projectPath,'utf8').replace('[autoload]','[autoload]\nCanonicalValidationObserver="*res://canonical_validation_observer.gd"'));
   const cache=resolve(work,'.godot');mkdirSync(cache,{recursive:true});
   const environment=prepareExecutionEnvironment({directory:resolve(directory,'execution'),readPaths:[work],writePaths:[cache],safeSavePaths:prepared.manifest.files.filter(f=>f.path.endsWith('.import')).map(f=>resolve(work,f.path))});
   const command=async(name,args)=>{this.assertActive(user,p,b,{...input,revision},identity);const invocation=environment.command(this.godot,args,{godot:true,projectPath:work,logName:name+'.log'});const result=await this.run(invocation,input.signal);processes.push({...result,name,command:this.godot,args});jsonFile(resolve(directory,name+'.json'),processes.at(-1));writeFileSync(resolve(directory,name+'.log'),result.output);this.assertActive(user,p,b,{...input,revision},identity);return result;};
   const imported=await command('import',['--headless','--editor','--path',work,'--import']);
   if(imported.code!==0||imported.had_error)throw Error('统一 Godot 工程导入失败：'+imported.output.slice(-3000));
   const result=await command('runtime',['--headless','--path',work,'--fixed-fps','60','--','--release-scene='+rid]);
   const line=result.output.split('\n').findLast(row=>row.startsWith('CANONICAL_GAME_VALIDATION '));let report;
   try{report=JSON.parse(line?.slice('CANONICAL_GAME_VALIDATION '.length));}catch{throw Error('Godot 未完成统一游戏实际运行观测：'+result.output.slice(-3000));}
   const native=fixed.manifest.schema===NATIVE_SCHEMA,resources=fixed.manifest.resources;
   const resource=Object.hasOwn(resources,report.resource_id)?resources[report.resource_id]:null;
   const nativePath=resource=>typeof resource?.path==='string'?'res://'+resource.path:null;
   const observations=report.observed_scenes;
   // Native projects keep the namespaced bootstrap as an Autoload while the
   // actual SceneTree current_scene is the author's PackedScene. Resolve that
   // scene against this fixed revision, including authored A-to-B transitions.
   const checks={
    runtime_entry:report.runtime_entry===(native?'res://'+NATIVE_RUNTIME_DIRECTORY+'/standalone.gd':'res://standalone.gd'),
    current_scene:Boolean(resource)&&report.main_scene===(native?nativePath(resource):'res://standalone.tscn'),
    entry_scene:!native||result.entry_ready?.native_scene_path===nativePath(resources[rid])&&result.entry_ready?.scene_generation===1,
    final_scene:result.last_scene_ready?.scene_id===report.resource_id&&(!native||result.last_scene_ready?.native_scene_path===nativePath(resource)&&result.last_scene_ready?.scene_generation===report.scene_generation),
    scene_generations:Number.isSafeInteger(report.scene_generation)&&report.scene_generation>=1&&result.scene_ready_count===report.scene_generation&&Array.isArray(observations)&&observations.length>0&&observations.every((scene,index)=>Object.hasOwn(resources,scene.resource_id)&&Number.isSafeInteger(scene.scene_generation)&&scene.scene_generation>=1&&(index===0||scene.scene_generation>observations[index-1].scene_generation))&&observations.at(-1).resource_id===report.resource_id&&observations.at(-1).scene_generation===report.scene_generation,
   };
   report.canonical_identity_checks=checks;
   const valid=result.code===0&&!result.had_error&&report.ok===true&&report.completed===true&&report.project_id===p&&report.branch_id===b&&report.revision===revision&&report.entry_resource_id===rid&&result.entry_ready?.scene_id===rid&&result.entry_ready?.project_id===p&&result.entry_ready?.branch_id===b&&result.entry_ready?.revision===revision&&report.runtime_source_hash===identity.runtime_source_hash&&Object.values(checks).every(Boolean)&&report.observed_ticks>=SMOKE_TICKS;
   verifyProjectFiles(prepared.directory,prepared.manifest.files);this.assertActive(user,p,b,{...input,revision},identity);
   const finished={...record,status:valid?'passed':'failed',completed_at:Date.now(),report,process:processes,evidence:{retention:'report_and_bounded_command_output_in_record',report:resolve(directory,'report.json'),log:resolve(directory,'runtime.log')},execution:{scope:'isolated_canonical_local_game',capabilities:environment.capabilities,directory:environment.directory}};
   jsonFile(finished.evidence.report,report);this.store.put('creator_verification',finished);
   this.store.put('creator_game_verification',{...job,status:finished.status,verification_id:finished.id,canonical_project_identity:finished.canonical_project_identity,completed_at:Date.now()});
   this.service.verificationFinished?.(finished);return finished;
  }catch(error){
   const failed={...record,status:'failed',completed_at:Date.now(),error:error.message,process:processes,evidence:{directory},report:{ok:false,completed:false,error:error.message,scope:'isolated canonical game validation'}};
   this.store.put('creator_verification',failed);this.store.put('creator_game_verification',{...job,status:'failed',verification_id:failed.id,error:error.message,completed_at:Date.now()});
   if(input.signal?.aborted)throw error;input.guard?.();this.service.verificationFinished?.(failed);return failed;
  }
 }
 run(invocation,signal){
  if(this.closing||signal?.aborted)return Promise.reject(Error('统一游戏检查已经取消'));
  return new Promise((done,reject)=>{
   const child=spawn(invocation.command,invocation.args,{...invocation.options,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});this.children.add(child);let output='',had_error=false,scan='',stdoutLine='',entry_ready=null,last_scene_ready=null,scene_ready_count=0,timed_out=false;
   const kill=()=>{try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}};
   const collect=bytes=>{const part=bytes.toString();had_error ||= /SCRIPT ERROR|Parse Error|ERROR:|STANDALONE_FAILED|STANDALONE_RUNTIME_FAULT/.test(scan+part);scan=(scan+part).slice(-64);output=(output+part).slice(-1024*1024);};
   child.stdout.on('data',bytes=>{collect(bytes);stdoutLine+=bytes.toString();const lines=stdoutLine.split('\n');stdoutLine=lines.pop().slice(-1024*1024);for(const line of lines)if(line.startsWith('STANDALONE_READY ')){try{const ready=JSON.parse(line.slice('STANDALONE_READY '.length));entry_ready??=ready;last_scene_ready=ready;scene_ready_count++;}catch{}}});child.stderr.on('data',collect);signal?.addEventListener('abort',kill,{once:true});
   const timer=setTimeout(()=>{timed_out=true;kill();},45000);
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',kill);this.children.delete(child);};
   child.once('error',error=>{cleanup();reject(error);});child.once('close',(code,exit_signal)=>{cleanup();done({code,signal:exit_signal,timed_out,had_error,entry_ready,last_scene_ready,scene_ready_count,output});});
  });
 }
 async close(){this.closing=true;for(const child of this.children)try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}await Promise.allSettled([...this.pending]);}
}
