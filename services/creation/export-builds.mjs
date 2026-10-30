import { projectPolicyInventory } from './project-policy.mjs';
import { prepareExecutionEnvironment } from './execution-environment.mjs';
import { spawn, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync, mkdirSync, cpSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { resolve, join, relative, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { clone, fail, hash, id, identifier } from './schema.mjs';
import { projectInventory as inventory, snapshotProjectRuntime, assembleProject, verifyProjectFiles, gameStorage, GAME_PROJECT_CONTRACT } from './project-snapshot.mjs';
import { adaptCanonicalGameWeb, CANONICAL_WEB_POLICY } from '../../tools/canonical-game-web.mjs';
import { adaptSingleThreadLocalHttp } from '../../tools/godot-web-compatibility.mjs';
import { NATIVE_SCHEMA } from './native-source.mjs';
import { scanNativeWorkspace } from './native-agent-workspace.mjs';
import {NATIVE_EDITOR_CONTRACT,editorToolIdentity,snapshotNativeEditorRuntime,assembleNativeEditorBuild} from './native-editor-build.mjs';
import {prepareNativeSharedBuild,authorizeNativeSharedBuild} from './native-shared-builds.mjs';
import {configureNativeSharedProject} from './native-shared-project.mjs';
import {createFileIdentityCache} from './file-identity.mjs';
import {snapshotImportedProject,verifyImportedFiles} from './build-import-snapshot.mjs';
import {closeNativeEditorContent} from './native-editor-content.mjs';
import {isPrefabTest,isPrefabPreviewEntry} from './prefab-tests.mjs';
import {linuxExecutionIdentity} from './linux-execution.mjs';
import {createGodotErrorScanner} from '../../tools/godot-diagnostics.mjs';

const KIND='creator_build';
const WEB_COMPATIBILITY_POLICY='world-atelier-single-thread-local-http-v1';
const fileIdentity=createFileIdentityCache();
const independentApplication=job=>job.kind==='application'&&(!job.purpose||job.purpose==='play');
function engineBundleIdentity(executable){
  if(process.platform!=='darwin'||!executable.includes('.app/'))return null;
  const directory=executable.slice(0,executable.indexOf('.app/')+4),files=[];
  const visit=path=>{for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const actual=join(path,entry.name);
    if(entry.isSymbolicLink())throw Error('Godot 工具链包包含未固定的符号链接');
    if(entry.isDirectory())visit(actual);else if(entry.isFile())files.push({path:relative(directory,actual),...fileIdentity(actual)});else throw Error('Godot 工具链包包含非普通文件');
  }};visit(directory);return {sha256:hash(files),files};
}
const ACTIVE=['queued','running'];
const TARGETS=[
  {id:'web',label:'Web',platform:'Web',template:'web_nothreads_release.zip',entry:'index.html',description:'在新页面运行固定版本'},
  {id:'windows',label:'Windows',platform:'Windows Desktop',template:'windows_release_x86_64.exe',entry:'Game.exe',description:'x86_64 应用 ZIP'},
  {id:'macos',label:'macOS',platform:'macOS',template:'macos.zip',entry:'Game.zip',description:'Apple Silicon / Intel 应用 ZIP（本地签名）'},
  {id:'linux',label:'Linux',platform:'Linux',template:'linux_release.x86_64',entry:'Game.x86_64',description:'x86_64 应用 ZIP'},
  {id:'android',label:'Android',platform:'Android',template:'android_release.apk',entry:'Game.apk',description:'签名 APK，需要 SDK、JDK 和发布密钥'},
  {id:'ios',label:'iOS',platform:'iOS',template:'ios.zip',entry:'Game.ipa',description:'签名 IPA，需要 macOS、Xcode 和描述文件'}
];
const quoted=v=>JSON.stringify(String(v));
const jsonFile=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
/** Persistent single-worker queue. Only complete, hashed artifact entries are exposed. */
export class CreationBuilds {
  constructor({service}){
    this.service=service;this.store=service.store;this.directory=resolve(service.data,'builds');
    this.godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
    this.templates=process.env.WORLD_ATELIER_EXPORT_TEMPLATES??join(homedir(),process.platform==='darwin'?'Library/Application Support/Godot/export_templates/4.6.stable':'.local/share/godot/export_templates/4.6.stable');
    mkdirSync(this.directory,{recursive:true});this.queue=[];this.closing=false;this.child=null;
    for(const job of this.store.list(KIND))if(ACTIVE.includes(job.status))this.update(job,{status:'interrupted',stage:'服务已重启，请重新提交',error:'上次后台执行中断，未将未完成文件标为成功',finished_at:Date.now()});
  }
  targets(){
    return TARGETS.map(t=>{
      const missing=[];
      if(!existsSync(this.godot))missing.push('Godot 4.6');
      if(!existsSync(join(this.templates,t.template)))missing.push('Godot 4.6 导出模板');
      if(t.id==='android'){
        const settings=join(homedir(),process.platform==='darwin'?'Library/Application Support/Godot/editor_settings-4.6.tres':'.config/godot/editor_settings-4.6.tres');
        const text=existsSync(settings)?readFileSync(settings,'utf8'):'';
        const configured=key=>{try{return JSON.parse(text.match(new RegExp('^export/android/'+key+' = (.+)$','m'))?.[1]??'""');}catch{return '';}};
        if(!existsSync(join(configured('android_sdk_path'),'platform-tools','adb')))missing.push('Godot 编辑器中的 Android SDK 配置');
        if(!existsSync(join(configured('java_sdk_path'),'bin','java')))missing.push('Godot 编辑器中的 JDK 配置');
        if(!process.env.GODOT_ANDROID_KEYSTORE_RELEASE_PATH||!existsSync(process.env.GODOT_ANDROID_KEYSTORE_RELEASE_PATH)||!process.env.GODOT_ANDROID_KEYSTORE_RELEASE_USER||!process.env.GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD)missing.push('Android 发布密钥环境变量');
      }
      if(t.id==='ios'){
        if(process.platform!=='darwin'||!existsSync('/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild'))missing.push('macOS / Xcode');
        if(!process.env.WORLD_ATELIER_IOS_TEAM_ID||!process.env.WORLD_ATELIER_IOS_PROFILE)missing.push('Apple Team ID / 发布描述文件');
      }
      return {id:t.id,label:t.label,available:!missing.length,reason:missing.length?'缺少 '+missing.join('、'):null,description:t.description,...(t.id==='web'?{web_compatibility_policy:WEB_COMPATIBILITY_POLICY,game_project_contract:GAME_PROJECT_CONTRACT,canonical_web_policy:CANONICAL_WEB_POLICY}:{})};
    });
  }
  update(job,patch){if(independentApplication(job))patch={...patch,authorized_actor_ids:[...new Set([...(this.store.get(KIND,job.id)?.authorized_actor_ids??[]),...(job.authorized_actor_ids??[]),...(patch.authorized_actor_ids??[])])]};Object.assign(job,patch,{updated_at:Date.now()});this.store.put(KIND,job);this.service.observe?.(()=>this.service.notices?.build(job));return job;}
  view(job){const {fingerprint,request_id,actor_id,authorized_actor_ids,web_files,source_files,...publicJob}=clone(job);return publicJob;}
  playableGame(user,p,b,entry){
    const branch=this.store.branchFor(user,p,b),project=this.store.projectFor(user,p),manifest=this.store.readRevision(branch.head).manifest;
    if(manifest.schema===NATIVE_SCHEMA){
      if(['owner','editor','viewer'].includes(this.store.roleFor(user,project)))return {source_revision:branch.head,resource_id:entry??manifest.entry_scene_id};
      const release=this.service.gameReleases?.published(user,p,b,entry);
      if(release)return release;
      // Previously published shared releases remain available during migration.
      const old=this.store.list('creator_world').find(world=>!world.native_shared&&world.project_id===p&&world.branch_id===b&&world.resource_id===(entry??manifest.entry_scene_id));
      if(!old)fail(422,'此游戏尚无已发布的试玩版本，请创作者发布完成的 Web 构建',{code:'game_release_unavailable'});
    }
    if(!this.service.worlds)fail(503,'可玩版本服务尚未就绪');
    return this.service.worlds.playable(user,p,b,entry??manifest.entry_scene_id);
  }
  authorizePlay(user,p,b,revision,entry){
    const branch=this.store.branchFor(user,p,b),project=this.store.projectFor(user,p);
    const role=this.store.roleFor(user,project),native=this.store.revisionMeta(revision)?.schema===NATIVE_SCHEMA;
    if(!['owner','editor'].includes(role)&&!(native&&role==='viewer')){
      const playable=this.playableGame(user,p,b,entry);
      if(playable.source_revision!==revision)fail(403,'此源版本尚未向试玩用户开放');
      if(native&&playable.game_build_id)return user;
    }
    if(!this.store.ancestor(revision,branch.head))fail(409,'固定版本不再属于此分支');
    return user;
  }
  executionUser(job){
    if(job.purpose==='prefab_test'){const user={id:job.actor_id};this.authorizeNativePreview(user,job.project_id,job.branch_id,job.source_revision);return user;}
    if(job.purpose==='native_shared')return authorizeNativeSharedBuild(this,{id:job.actor_id},job,{execution:true});
    if(job.purpose==='native_preview'){const user={id:job.actor_id};this.authorizeNativePreview(user,job.project_id,job.branch_id,job.source_revision);return user;}
    if(job.purpose!=='play'){
      for(const actor of [...new Set([job.actor_id,...job.authorized_actor_ids??[],...this.store.get(KIND,job.id)?.authorized_actor_ids??[]])]){
        try{const user={id:actor};this.store.projectFor(user,job.project_id,true);return user;}catch{}
      }
      fail(403,'导出构建已没有有效的请求者权限');
    }
    for(const actor of [...new Set([job.actor_id,...job.authorized_actor_ids??[],...this.store.get(KIND,job.id)?.authorized_actor_ids??[]])]){
      try{return this.authorizePlay({id:actor},job.project_id,job.branch_id,job.source_revision,job.entry_scene_id);}catch{}
    }
    fail(403,'试玩构建已没有有效的请求者权限');
  }
  forUser(user,jobId){
    const job=this.store.get(KIND,jobId);if(!job)fail(404,'导出任务不存在');
    if(job.purpose==='prefab_test'){this.authorizeNativePreview(user,job.project_id,job.branch_id,job.source_revision);return job;}
    if(job.purpose==='native_shared'){authorizeNativeSharedBuild(this,user,job);return job;}
    if(job.purpose==='native_preview'){this.authorizeNativePreview(user,job.project_id,job.branch_id,job.source_revision);return job;}
    const project=this.store.projectFor(user,job.project_id);
    const role=this.store.roleFor(user,project);
    if(!['owner','editor'].includes(role)){
      this.authorizePlay(user,job.project_id,job.branch_id,job.source_revision,job.entry_scene_id);
      if(role!=='viewer'&&this.store.revisionMeta(job.source_revision)?.schema===NATIVE_SCHEMA){
        if(!this.service.gameReleases)fail(503,'试玩发行服务尚未就绪');
        this.service.gameReleases.authorizeBuild(user,job);
      }
    }
    return job;
  }
  list(user,p,b){
    this.store.branchFor(user,p,b);
    return {targets:this.targets(),game_project_contract:GAME_PROJECT_CONTRACT,jobs:this.store.list(KIND).filter(j=>j.project_id===p&&j.branch_id===b).filter(j=>{try{this.forUser(user,j.id);return true;}catch{return false;}}).sort((a,b)=>b.created_at-a.created_at).slice(0,50).map(j=>this.view(j))};
  }
  policyIdentity(){
    return projectPolicyInventory(this.service.root).sha256;
  }
  toolchainIdentity(targets){
    return {godot:fileIdentity(this.godot),godot_bundle:engineBundleIdentity(this.godot),templates:Object.fromEntries(targets.map(target=>[target,fileIdentity(join(this.templates,TARGETS.find(t=>t.id===target).template))])),...(process.platform==='linux'?{execution:linuxExecutionIdentity()}:{})};
  }
  nativeThumbnailRendererIdentity(){
    // Read-only cache identity: never pin a job or export a project just to
    // discover that the browser already has this fixed-source picture.
    const root=this.service.root;
    return hash({contract:NATIVE_EDITOR_CONTRACT,runtime:inventory(join(root,'runtimes/model-preview')),
      bake:editorToolIdentity(root),policy:this.policyIdentity(),toolchain:this.toolchainIdentity(['web']),
      capture:['preview-bridge.js','native-preview.js'].map(path=>fileIdentity(join(root,'apps/creation-workspace',path)))});
  }
  pin(job){
    if(job.purpose==='native_preview'){
      const snapshot=snapshotNativeEditorRuntime(this.service.root,join(this.directory,job.id,'runtime'));
      job.runtime_sources=snapshot.files;job.runtime_source_hash=snapshot.hash;job.editor_bake_tool_hash=snapshot.bake_tool_hash;
      job.build_policy_hash=this.policyIdentity();job.toolchain_identity=this.toolchainIdentity(job.targets);
      job.content_key=hash({contract:NATIVE_EDITOR_CONTRACT,project_id:job.project_id,branch_id:job.branch_id,source_revision:job.source_revision,runtime:snapshot.hash,bake:snapshot.bake_tool_hash,policy:job.build_policy_hash,toolchain:job.toolchain_identity});
      job.canonical_identity=job.content_key;job.editor_contract=NATIVE_EDITOR_CONTRACT;return;
    }
    const source=join(this.directory,job.id,'project');
    const snapshot=snapshotProjectRuntime(this.service.root,source);
    job.runtime_sources=snapshot.files;job.runtime_source_hash=snapshot.hash;job.game_project_contract=GAME_PROJECT_CONTRACT;
    const storage=gameStorage(this.service,job.project_id,job.branch_id);
    job.storage={policy:storage.policy,namespace:storage.namespace,editor:storage.editor,standalone:storage.standalone,legacy_namespace_preserved:storage.legacy_namespace_preserved,legacy_namespaces:storage.legacy_namespaces};
    if(job.purpose==='prefab_test')job.storage={...job.storage,namespace:`prefab-test:${job.project_id}:${job.branch_id}:${job.entry_scene_id}`,standalone:'memory_only_per_run'};
    job.build_policy_hash=this.policyIdentity();job.toolchain_identity=this.toolchainIdentity(job.targets);
    const identity={format:1,contract:GAME_PROJECT_CONTRACT,...(job.purpose==='native_shared'?{native_shared_protocol:1,purpose:'native_shared'}:job.purpose==='prefab_test'?{purpose:'prefab_test',prefab_test_protocol:1}:{}),project_id:job.project_id,branch_id:job.branch_id,source_revision:job.source_revision,entry_scene_id:job.entry_scene_id,project_name:job.project_name,storage:job.storage,runtime_source_hash:job.runtime_source_hash,build_policy_hash:job.build_policy_hash,toolchain:job.targets.includes('web')?this.toolchainIdentity(['web']):job.toolchain_identity,web_compatibility_policy:WEB_COMPATIBILITY_POLICY,canonical_web_policy:CANONICAL_WEB_POLICY};
    job.content_key=hash(identity);job.canonical_identity=job.content_key;job.game_identity={...identity,content_key:job.content_key};
  }
  verifyToolchain(job){
    if(job.build_policy_hash!==this.policyIdentity()||hash(job.toolchain_identity)!==hash(this.toolchainIdentity(job.targets)))fail(409,'固定工具链或工程生成器已变化，请重新准备运行');
    if(job.purpose==='native_preview'&&job.editor_bake_tool_hash!==editorToolIdentity(this.service.root))fail(409,'原生编辑器生成器已变化，请重新准备预览');
  }
  authorizeNativePreview(user,p,b,revision){
    const branch=this.store.branchFor(user,p,b),project=this.store.projectFor(user,p);
    if(!['owner','editor','viewer'].includes(this.store.roleFor(user,project)))fail(403,'原生编辑预览需要源稿访问权限');
    if(!this.store.ancestor(revision,branch.head))fail(409,'预览源版本不再属于此分支');
    return branch;
  }
  prepareNativePreview(user,p,b,input={}){
    if(this.closing)fail(503,'构建服务正在关闭');
    const branch=this.store.branchFor(user,p,b),revision=input.source_revision??branch.head;
    this.authorizeNativePreview(user,p,b,revision);
    const fixed=this.store.readRevision(revision);
    if(!fixed||fixed.project_id!==p||fixed.manifest.schema!==NATIVE_SCHEMA||!fixed.manifest.resources[input.entry_scene_id??fixed.manifest.entry_scene_id])fail(422,'请选择此原生源版本的资源');
    if(input.request_id!=null)identifier(input.request_id,'请求 ID');
    const requestKey=input.request_id?hash({p,b,user:user.id,request_id:input.request_id}):null,fingerprint=hash(input),replay=requestKey&&this.store.get('creator_native_preview_request',requestKey);
    if(replay){if(replay.fingerprint!==fingerprint)fail(409,'同一请求 ID 不能修改预览参数');return {job:this.view(this.forUser(user,replay.job_id)),replayed:true};}
    const job={id:id('build'),kind:'application',purpose:'native_preview',project_id:p,project_name:this.store.projectFor(user,p).name,branch_id:b,source_revision:revision,entry_scene_id:fixed.manifest.entry_scene_id,targets:['web'],actor_id:user.id,status:'queued',progress:0,stage:'准备原生编辑视口',created_at:Date.now(),artifacts:[],target_results:[]};
    let selected=job,reused=false;
    try{
      this.pin(job);
      const previous=this.store.list(KIND).find(j=>j.purpose==='native_preview'&&j.content_key===job.content_key&&(this.validWeb(j)||ACTIVE.includes(j.status)));
      if(previous){selected=previous;reused=true;rm(join(this.directory,job.id),{recursive:true,force:true}).catch(()=>{});}
      else{if(this.store.list(KIND).filter(j=>ACTIVE.includes(j.status)).length>=12)fail(429,'后台构建队列已满，请稍后再试');this.update(job,{});}
    }catch(error){rm(join(this.directory,job.id),{recursive:true,force:true}).catch(()=>{});throw error;}
    if(requestKey)this.store.put('creator_native_preview_request',{id:requestKey,project_id:p,branch_id:b,user_id:user.id,job_id:selected.id,fingerprint,created_at:Date.now()});
    if(!reused){this.queue.push(job.id);this.pump();}
    return {job:this.view(selected),reused};
  }
  validWeb(job){
    if(!['completed','partial'].includes(job.status)||!job.web_files?.length||!job.artifacts?.some(a=>a.target==='web'))return false;
    return job.web_files.every(file=>{try{const actual=fileIdentity(join(this.directory,job.id,'web',file.path));return actual.sha256===file.sha256&&actual.size===file.size;}catch{return false;}});
  }
  reusableApplication(job,{download=false}={}){
    if(!independentApplication(job))return null;
    const candidates=this.store.list(KIND).filter(candidate=>independentApplication(candidate)&&candidate.project_id===job.project_id&&candidate.branch_id===job.branch_id&&candidate.content_key===job.content_key&&job.targets.every(target=>candidate.targets.includes(target)));
    const matchesToolchain=candidate=>job.targets.every(target=>{
      const wanted=job.toolchain_identity,actual=candidate.toolchain_identity;
      return wanted?.godot&&actual?.godot&&wanted.templates?.[target]&&actual.templates?.[target]&&hash(wanted.godot)===hash(actual.godot)&&hash(wanted.godot_bundle??null)===hash(actual.godot_bundle??null)&&hash(wanted.templates[target])===hash(actual.templates[target]);
    });
    const complete=candidate=>['completed','partial'].includes(candidate.status)&&job.targets.every(target=>{
      if(target==='web'&&!this.validWeb(candidate))return false;
      if(!download)return target==='web';
      const artifact=candidate.artifacts?.find(entry=>entry.target===target);
      if(!artifact?.filename)return false;
      try{const actual=fileIdentity(join(this.directory,candidate.id,artifact.filename));return actual.sha256===artifact.sha256&&actual.size===artifact.size;}catch{return false;}
    });
    // Prefer an already usable artifact over queued work. A Play request may
    // join another Play; an explicit export can also join an ordinary export.
    const matching=candidates.filter(matchesToolchain);
    return matching.find(complete)??matching.find(candidate=>{
      if(!ACTIVE.includes(candidate.status)||!download&&candidate.purpose!=='play')return false;
      // An in-flight multi-platform export still verifies every one of its
      // targets. Do not join a worker already invalidated by another template.
      try{this.verifyToolchain(candidate);return true;}catch{return false;}
    })??null;
  }
  prepareShared(user,p,b,input={}){return prepareNativeSharedBuild(this,user,p,b,input);}
  preparePrefabTest(user,p,b,input={}){
    if(this.closing)fail(503,'构建服务正在关闭');
    const branch=this.store.branchFor(user,p,b),revision=input.source_revision??branch.head;
    this.authorizeNativePreview(user,p,b,revision);
    const fixed=this.store.readRevision(revision),entry=input.entry_scene_id;
    if(fixed?.project_id!==p||fixed.manifest.schema!==NATIVE_SCHEMA||!isPrefabPreviewEntry(fixed.manifest.resources[entry]))fail(422,'请选择固定源版本中的预制件或能力预览场景');
    identifier(input.request_id,'请求 ID');
    const requestKey=hash({p,b,user:user.id,request_id:input.request_id}),fingerprint=hash(input),replay=this.store.get('creator_prefab_test_request',requestKey);
    if(replay){if(replay.fingerprint!==fingerprint)fail(409,'同一请求 ID 不能修改测试参数');return {job:this.view(this.forUser(user,replay.job_id)),replayed:true};}
    const job={id:id('build'),kind:'application',purpose:'prefab_test',project_id:p,project_name:this.store.projectFor(user,p).name,branch_id:b,source_revision:revision,entry_scene_id:entry,targets:['web'],actor_id:user.id,status:'queued',progress:0,stage:'准备预制件能力预览',created_at:Date.now(),artifacts:[],target_results:[]};
    let selected=job,reused=false;
    try{
      this.pin(job);
      const previous=this.store.list(KIND).find(candidate=>candidate.purpose==='prefab_test'&&candidate.actor_id===user.id&&candidate.content_key===job.content_key&&(this.validWeb(candidate)||ACTIVE.includes(candidate.status)));
      if(previous){selected=previous;reused=true;rm(join(this.directory,job.id),{recursive:true,force:true}).catch(()=>{});}
      else{if(this.store.list(KIND).filter(j=>ACTIVE.includes(j.status)).length>=12)fail(429,'后台构建队列已满，请稍后再试');this.update(job,{});}
    }catch(error){rm(join(this.directory,job.id),{recursive:true,force:true}).catch(()=>{});throw error;}
    this.store.put('creator_prefab_test_request',{id:requestKey,project_id:p,branch_id:b,user_id:user.id,job_id:selected.id,fingerprint,created_at:Date.now()});
    if(!reused){this.queue.push(job.id);this.pump();}
    return {job:this.view(selected),reused};
  }
  preparePlay(user,p,b,input={}){
    if(this.closing)fail(503,'构建服务正在关闭');
    const branch=this.store.branchFor(user,p,b),project=this.store.projectFor(user,p);
    if(input.request_id!=null)identifier(input.request_id,'请求 ID');
    const requestKey=input.request_id?hash({p,b,user:user.id,request_id:input.request_id}):null,fingerprint=hash(input);
    const replay=requestKey&&this.store.get('creator_play_request',requestKey);
    if(replay){if(replay.fingerprint!==fingerprint)fail(409,'同一请求 ID 不能修改试玩参数');return {job:this.view(this.forUser(user,replay.job_id)),reused:true,replayed:true};}
    const remember=job=>{if(requestKey)this.store.put('creator_play_request',{id:requestKey,project_id:p,branch_id:b,user_id:user.id,job_id:job.id,fingerprint,created_at:Date.now()});};
    const requested=this.store.readRevision(input.source_revision??branch.head);
    const entry=input.entry_scene_id??requested?.manifest.entry_scene_id;
    const role=this.store.roleFor(user,project),sourceReader=['owner','editor'].includes(role)||role==='viewer'&&requested?.manifest.schema===NATIVE_SCHEMA;
    const release=sourceReader?null:this.playableGame(user,p,b,entry);
    const sourceRevision=sourceReader?(input.source_revision??branch.head):release.source_revision;
    if(input.source_revision&&sourceRevision!==input.source_revision)fail(403,'此源版本尚未向试玩用户开放');
    const fixed=this.store.readRevision(sourceRevision);
    if(!fixed||fixed.project_id!==p||!release?.game_build_id&&!this.store.ancestor(sourceRevision,branch.head))fail(409,'请选择此分支可达的固定源版本');
    if(fixed.manifest.resources[entry]?.kind!=='scene')fail(422,'请选择有效入口场景');
    if(isPrefabTest(fixed.manifest.resources[entry]))fail(422,'请从预制件能力预览入口运行测试场景');
    this.authorizePlay(user,p,b,sourceRevision,entry);
    // Public readers consume the completed immutable release. Preparing Play
    // must not rebuild it with a newer editor toolchain or publish source edits.
    if(release?.game_build_id){const fixedJob=this.forUser(user,release.game_build_id);remember(fixedJob);return {job:this.view(fixedJob),reused:true};}
    const job={id:id('build'),kind:'application',purpose:'play',project_id:p,project_name:project.name,branch_id:b,source_revision:sourceRevision,entry_scene_id:entry,targets:['web'],actor_id:user.id,authorized_actor_ids:[user.id],status:'queued',progress:0,stage:'准备同一份游戏工程',created_at:Date.now(),artifacts:[],target_results:[],web_compatibility_policy:WEB_COMPATIBILITY_POLICY};
    try{
      this.pin(job);
      const reusable=this.reusableApplication(job);
      if(reusable){
        if(reusable.purpose==='play')this.update(reusable,{authorized_actor_ids:[...new Set([...(reusable.authorized_actor_ids??[reusable.actor_id]),user.id])]});
        rm(join(this.directory,job.id),{recursive:true,force:true}).catch(()=>{});
        remember(reusable);return {job:this.view(reusable),reused:true};
      }
      if(this.store.list(KIND).filter(j=>ACTIVE.includes(j.status)).length>=12)fail(429,'后台构建队列已满，请稍后再试');
      this.update(job,{});
    }catch(error){rm(join(this.directory,job.id),{recursive:true,force:true}).catch(()=>{});throw error;}
    remember(job);this.queue.push(job.id);this.pump();return {job:this.view(job),reused:false};
  }
  create(user,p,b,input){
    if(this.closing)fail(503,'构建服务正在关闭');
    const branch=this.store.branchFor(user,p,b,true),project=this.store.projectFor(user,p);
    if(input.confirmed!==true)fail(400,'请先二次确认导出或打包');
    identifier(input.request_id,'请求 ID');
    if(!['source','application'].includes(input.kind))fail(400,'未知导出类型');
    const targets=input.kind==='source'?[]:input.targets;
    if(!Array.isArray(targets)||input.kind==='application'&&(!targets.length||targets.length>6)||new Set(targets).size!==targets.length||targets.some(t=>!TARGETS.some(v=>v.id===t)))fail(400,'请选择有效且不重复的平台');
    const fingerprint=hash({p,b,user:user.id,input}),requestKey=hash({p,b,user:user.id,request_id:input.request_id});
    const replay=this.store.get('creator_export_request',requestKey),previous=replay??this.store.list(KIND).find(j=>j.actor_id===user.id&&j.project_id===p&&j.branch_id===b&&j.request_id===input.request_id);
    if(previous){if(previous.fingerprint!==fingerprint)fail(409,'同一请求 ID 不能修改打包参数');return {job:this.view(this.forUser(user,replay?.job_id??previous.id)),replayed:true,...(replay?{reused:replay.reused}: {})};}
    const remember=(selected,reused)=>this.store.put('creator_export_request',{id:requestKey,project_id:p,branch_id:b,user_id:user.id,job_id:selected.id,fingerprint,reused,created_at:Date.now()});
    const revision=this.store.readRevision(input.source_revision);
    if(!revision||revision.project_id!==p||!this.store.ancestor(revision.id,branch.head))fail(409,'请选择此分支可达的固定源版本');
    const entry=input.entry_scene_id??revision.manifest.entry_scene_id;
    if(revision.manifest.resources[entry]?.kind!=='scene')fail(422,'请选择有效入口场景');
    if(isPrefabTest(revision.manifest.resources[entry]))fail(422,'测试场景不能作为游戏导出入口');
    const job={id:id('build'),kind:input.kind,project_id:p,project_name:project.name,branch_id:b,source_revision:revision.id,entry_scene_id:entry,targets,request_id:input.request_id,fingerprint,actor_id:user.id,status:'queued',progress:0,stage:'等待后台执行',created_at:Date.now(),artifacts:[],target_results:[]};
    if(targets.includes('web'))job.web_compatibility_policy=WEB_COMPATIBILITY_POLICY;
    // Snapshot the small runtime source set before acknowledging, so queue delay
    // cannot silently change the program paired with the pinned content revision.
    const source=join(this.directory,job.id,'project');mkdirSync(source,{recursive:true});
    try{
      this.pin(job);
      const reusable=this.reusableApplication(job,{download:true});
      if(reusable){
        this.update(reusable,{authorized_actor_ids:[...new Set([...(reusable.authorized_actor_ids??[reusable.actor_id]),user.id])]});
        remember(reusable,true);
        rm(join(this.directory,job.id),{recursive:true,force:true}).catch(()=>{});
        return {job:this.view(reusable),reused:true};
      }
      if(this.store.list(KIND).filter(j=>ACTIVE.includes(j.status)).length>=12)fail(429,'后台构建队列已满，请稍后再试');
      this.update(job,{});
      remember(job,false);
    }catch(error){rm(join(this.directory,job.id),{recursive:true,force:true}).catch(()=>{});throw error;}
    this.queue.push(job.id);this.pump();return {job:this.view(job),reused:false};
  }
  pump(){
    if(this.running||this.closing||!this.queue.length)return;
    const job=this.store.get(KIND,this.queue.shift());
    // Native assembly includes synchronous source materialization, hashing and
    // engine copies. An async function alone does not isolate that CPU/IO work.
    const native=this.store.revisionMeta(job.source_revision)?.schema===NATIVE_SCHEMA;
    this.running=Promise.resolve().then(()=>{if(this.closing)throw Error('后台执行中断');return native?this.executeIsolated(job):this.execute(job);}).catch(error=>{
      this.update(job,{status:this.closing?'interrupted':'failed',stage:this.closing?'后台执行中断':'导出失败',error:this.cleanError(error.message),finished_at:Date.now()});
    }).finally(async()=>{await this.cleanupExecution(job);this.running=null;this.pump();});
  }
  executeIsolated(job){
    this.executionUser(job);
    const database=this.store.db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
    if(!database)throw Error('独立构建需要持久化的固定源数据库');
    return new Promise((done,reject)=>{
      const worker=this.worker=fork(new URL('./build-worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc'],detached:process.platform!=='win32',execArgv:[]});
      let failure=null,finished=false,enginePid=null,stderr='',stopTimer=null;
      const kill=(pid,signal='SIGKILL')=>{if(pid)try{process.kill(process.platform==='win32'?pid:-pid,signal);}catch{}};
      worker.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-4000);});
      worker.stop=()=>{kill(enginePid);kill(worker.pid,'SIGTERM');stopTimer??=setTimeout(()=>kill(worker.pid),5000);};
      worker.on('message',message=>{
        if(message.type==='engine'){enginePid=message.pid;return;}
        if(failure||this.closing)return;
        try{
          if(message.type==='update'){
            if(message.job.id!==job.id||message.job.source_revision!==job.source_revision||message.job.content_key!==job.content_key)throw Error('独立构建返回了不匹配的固定输入');
            if(['completed','partial'].includes(message.job.status))this.executionUser(job);
            this.update(job,message.job);
          }else if(message.type==='done')finished=true;
          else if(message.type==='failed'){failure=Error(message.error);worker.stop();}
        }catch(error){failure=error;worker.stop();}
      });
      worker.once('error',error=>{failure=error;});
      worker.once('close',(code,signal)=>{
        if(stopTimer)clearTimeout(stopTimer);kill(enginePid);kill(worker.pid);if(this.worker===worker)this.worker=null;
        if(failure)reject(failure);
        else if(this.closing||!finished||code!==0)reject(Error(this.closing?'后台执行中断':stderr||`独立构建执行器退出 ${signal??code}`));
        else done();
      });
      worker.send({job,root:this.service.root,data:this.service.data,database,archive:this.service.native.archive.directory,publicPlay:this.store.publicPlay,adminUserId:this.store.adminUserId,godot:this.godot,templates:this.templates});
    });
  }
  async cleanupExecution(job){
    // Fixed source inputs, Web artifacts, receipts and execution logs remain.
    // Engine copies and importer/export caches are disposable execution data.
    const base=join(this.directory,job.id),paths=['export-project','project/.godot','native-source/.godot','native-authority/.godot'];
    try{
      const checks=join(base,'checks');
      if(existsSync(checks))for(const entry of readdirSync(checks,{withFileTypes:true}))if(entry.isDirectory())paths.push('checks/'+entry.name+'/engine');
      const removed=[];for(const path of paths)if(existsSync(join(base,path))){await rm(join(base,path),{recursive:true,force:true});removed.push(path);}
      this.update(job,{execution_cleanup:{status:'completed',removed_paths:removed,at:Date.now()}});
    }catch(error){this.update(job,{execution_cleanup:{status:'failed',error:this.cleanError(error.message),at:Date.now()}});}
  }
  cleanError(message){
    let text=String(message);
    for(const value of [this.directory,this.service.root,homedir(),...Object.entries(process.env).filter(([k])=>/PASSWORD|TOKEN|SECRET|KEYSTORE/.test(k)).map(([,v])=>v)].filter(v=>v&&v.length>3).sort((a,b)=>b.length-a.length))text=text.split(value).join('[本机配置]');
    return text.slice(-1800);
  }
  async measure(job,phase,operation,details={}){
    const started=performance.now();let status='failed';
    try{const result=await operation();status='completed';return result;}
    finally{this.update(job,{timings:[...(job.timings??[]),{phase,...details,status,wall_ms:Math.round((performance.now()-started)*100)/100}]});}
  }
  async prepareImportedExport(job,source,sourceFiles){
    if(job.kind==='source')return null;
    const snapshot=snapshotImportedProject({source,destination:join(this.directory,job.id,'export-project'),sourceFiles});
    if(snapshot){
      const {directory,...receipt}=snapshot,bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');
      await writeFile(join(this.directory,job.id,'import-snapshot.json'),bytes);
      this.update(job,{import_snapshot:{policy:snapshot.policy,path:'import-snapshot.json',sha256:hash(bytes),cache_files:snapshot.cache_files,cache_bytes:snapshot.cache_bytes}});
    }
    return snapshot;
  }
  async command(job,bin,args,cwd,{allowEditorRidLeaks=false,timeout=600000,signing=false,isolatedProject=null,importing=false,readPaths=[],writePaths=[],selfContained=false,requiredMarker=null}={}){
    if(this.closing)throw Error('后台执行中断');
    this.executionUser(job);this.verifyToolchain(job);
    const allowed=['PATH','HOME','TMPDIR','LANG','LC_ALL','USER','LOGNAME','DISPLAY','XDG_RUNTIME_DIR'];
    if(signing)allowed.push('GODOT_ANDROID_KEYSTORE_RELEASE_PATH','GODOT_ANDROID_KEYSTORE_RELEASE_USER','GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD','JAVA_HOME','DEVELOPER_DIR');
    const env=Object.fromEntries(allowed.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
    let invocation={command:bin,args,options:{cwd,env}};
    if(isolatedProject){
      if(signing)throw Error('签名平台尚未配置受限构建环境，未启动导出');
      const directory=join(this.directory,job.id,'checks',id('execution')),cache=join(isolatedProject,'.godot');mkdirSync(cache,{recursive:true});
      let executable=bin,editorRead=[],editorWrite=[];
      if(selfContained){
        // macOS NSTemporaryDirectory ignores our child TMPDIR. A private copy
        // of the pinned engine enables Godot's native self-contained paths,
        // including editor_data/temp, without exposing the shared system tmp.
        const engineDirectory=join(directory,'engine'),editorData=join(engineDirectory,'editor_data');
        mkdirSync(editorData,{recursive:true});executable=join(engineDirectory,'Godot');
        if(process.platform==='darwin'&&bin.includes('.app/')){
          const app=bin.slice(0,bin.indexOf('.app/')+4),bundle=join(engineDirectory,app.split('/').pop());
          cpSync(app,bundle,{recursive:true});executable=join(bundle,bin.slice(app.length+1));
          const bundleIdentity=engineBundleIdentity(executable);
          if(bundleIdentity.sha256!==job.toolchain_identity.godot_bundle?.sha256)throw Error('隔离 Godot 工具链包与固定版本不一致');
          await writeFile(join(directory,'engine-bundle-inventory.json'),JSON.stringify(bundleIdentity,null,2));
        }else cpSync(bin,executable);
        const copied=readFileSync(executable),expected=job.toolchain_identity.godot;
        if(copied.length!==expected.size||hash(copied)!==expected.sha256)throw Error('隔离导出引擎与固定工具链不一致');
        await writeFile(join(engineDirectory,'_sc_'),'');
        editorRead=[engineDirectory];editorWrite=[editorData];
      }
      const environment=prepareExecutionEnvironment({directory,readPaths:[isolatedProject,...readPaths,...editorRead],writePaths:[...(importing?[cache]:[]),...writePaths,...editorWrite],safeSavePaths:importing?inventory(isolatedProject).filter(f=>f.path.endsWith('.import')).map(f=>join(isolatedProject,f.path)):[]});
      invocation=environment.command(executable,args,{godot:true,projectPath:isolatedProject});
    }
    return await new Promise((done,reject)=>{
      const child=this.child=spawn(invocation.command,invocation.args,{...invocation.options,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});this.onChild?.(child.pid);let log='',stdout='',scanTail='',markerObserved=false;const errors=createGodotErrorScanner({allowEditorRidLeaks});
      const collect=stream=>data=>{const text=data.toString();if(stream==='stdout')stdout=(stdout+text).slice(-32000);if(requiredMarker&&(scanTail+text).includes(requiredMarker))markerObserved=true;errors.push(text,stream);scanTail=(scanTail+text).slice(-32);log=(log+text).slice(-32000);};
      child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));
      const kill=()=>{try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}};
      const timer=setTimeout(kill,timeout);
      child.once('error',error=>{clearTimeout(timer);this.child=null;reject(error);});
      child.once('close',async(code,signal)=>{
        const hadError=errors.finish();
        clearTimeout(timer);this.child=null;this.onChild?.(null);
        await writeFile(join(this.directory,job.id,'worker.log'),this.cleanError(log),{flag:'a'}).catch(()=>{});
        if(code!==0||hadError)reject(Error(log||`执行器退出 ${signal??code}`));else if(requiredMarker&&!markerObserved)reject(Error('Godot 未确认固定场景加载成功：'+requiredMarker));else done(bin===this.godot&&args.length===1&&args[0]==='--version'?stdout:log);
      });
    });
  }
  presets(job,configured=false){
    const native=this.store.get('creator_revision',job.source_revision)?.manifest.schema===NATIVE_SCHEMA;
    return TARGETS.map((t,i)=>{
      const bundle='org.worldatelier.game'+hash(job.project_id).slice(0,16);
      const options={
        web:'variant/thread_support=false\nvariant/extensions_support=false\nprogressive_web_app/enabled=false\nvram_texture_compression/for_desktop=true\nvram_texture_compression/for_mobile=true\nhtml/export_icon=false\nhtml/canvas_resize_policy=2\nhtml/focus_canvas_on_start=true',
        windows:'binary_format/architecture="x86_64"\nbinary_format/embed_pck=true\napplication/modify_resources=false\ncodesign/enable=false',
        linux:'binary_format/architecture="x86_64"\nbinary_format/embed_pck=true',
        macos:`application/bundle_identifier=${quoted(bundle)}\ncodesign/codesign=1\nnotarization/notarization=0`,
        android:`gradle_build/use_gradle_build=false\npackage/unique_name=${quoted(bundle)}\npackage/signed=true\narchitectures/arm64-v8a=true\narchitectures/armeabi-v7a=false`,
        ios:`application/bundle_identifier=${quoted(bundle)}\napplication/app_store_team_id=${quoted(configured?process.env.WORLD_ATELIER_IOS_TEAM_ID??'':'')}\napplication/provisioning_profile_uuid_release=${quoted(configured?process.env.WORLD_ATELIER_IOS_PROFILE??'':'')}\napplication/export_method_release=2\napplication/code_sign_identity_release="Apple Distribution"`
      }[t.id];
      return `[preset.${i}]\nname=${quoted(t.label)}\nplatform=${quoted(t.platform)}\nrunnable=true\nexport_filter="all_resources"\ninclude_filter=${quoted(native?'*':'release.json,source-manifest.json,runtime_capabilities.json,bundled/*,resources/*.json')}\nexclude_filter="project-inventory.json"\nscript_export_mode=0\n\n[preset.${i}.options]\ncustom_template/release=${quoted(configured?join(this.templates,t.template):'')}\n${options}\n`;
    }).join('\n');
  }
  async assemble(job){
    if(job.purpose==='native_preview')return assembleNativeEditorBuild(this,job);
    if(job.runtime_sources)verifyProjectFiles(join(this.directory,job.id,'project'),job.runtime_sources);
    const source=await assembleProject({service:this.service,user:this.executionUser(job),readOnly:['play','prefab_test'].includes(job.purpose),purpose:job.kind==='source'?'authoring':job.purpose==='prefab_test'?'prefab_test':'game',storage:job.storage,game_identity:job.game_identity,project_id:job.project_id,branch_id:job.branch_id,revision:job.source_revision,entry_scene_id:job.entry_scene_id,directory:join(this.directory,job.id,'project'),runtime_source_hash:job.runtime_source_hash,project_name:job.project_name});
    if(job.purpose==='native_shared'){
      const shared=await configureNativeSharedProject({service:this.service,job,directory:source,godotPath:this.godot,run:(bin,args,cwd,options)=>this.command(job,bin,args,cwd,options)});
      this.update(job,{native_shared:shared.receipt});
    }
    await writeFile(join(source,'export_presets.cfg'),this.presets(job));
    if(job.purpose!=='native_shared'&&!this.store.get('creator_revision',job.source_revision)?.manifest.source_files?.['README.md'])await writeFile(join(source,'README.md'),`# ${job.project_name}\n\nGodot 4.6 固定游戏工程。打开 project.godot，按 F5 运行。GameRuntime Autoload 管理统一初始化，工作台 Play、Web 与各平台应用使用同一工程。\n\n固定分支：${job.branch_id}\n固定源版本：${job.source_revision}\n入口场景：${job.entry_scene_id}\n\n原生源文件保留原路径，框架启动文件和发行索引在 atelier_runtime/；旧格式工程的发行索引仍位于根目录 release.json。复制 workspace_prepare 工程到会话 work/ 后，可用 world_apply 的 submit_native_workspace 操作提交源文件差异；本地保存不会自动写回中央源稿。\n\n此包从初始状态独立运行，不连接在线房间或携带在线进度。角色、控制和相机由项目显式定义。export_presets.cfg 包含平台导出预设，移动应用出包需要相应 SDK 与签名配置。\n`);
    await jsonFile(join(source,'project-inventory.json'),{source_revision:job.source_revision,runtime_source_hash:job.runtime_source_hash,files:inventory(source)});
    return source;
  }
  async artifact(job,target,path,webFiles=null){
    const bytes=await readFile(path),filename=path.split('/').pop();
    const artifact={id:target,target,label:target==='source'?'Godot 工程':TARGETS.find(t=>t.id===target).label,filename,size:bytes.length,sha256:hash(bytes),download_url:`/creation-api/builds/${job.id}/artifacts/${target}`};
    if(webFiles){artifact.web_url=`/creation-releases/${job.id}/web/index.html`;job.web_files=webFiles;}
    job.artifacts.push(artifact);this.update(job,{});
  }
  async execute(job){
    const base=join(this.directory,job.id);this.update(job,{status:'running',progress:5,stage:'收集固定版本和全部资源',started_at:Date.now()});
    const source=await this.measure(job,'assemble',()=>this.assemble(job));
    const native=this.store.get('creator_revision',job.source_revision)?.manifest.schema===NATIVE_SCHEMA;
    const sourceFiles=native?Object.entries(scanNativeWorkspace(source).files).map(([path,entry])=>({path,sha256:entry.hash,size:entry.size})):[...inventory(source),...['README.md','export_presets.cfg','project-inventory.json'].map(path=>({path,sha256:hash(readFileSync(join(source,path))),size:statSync(join(source,path)).size}))];
    this.update(job,{source_files:sourceFiles});
    const verifyInputs=()=>{
      for(const file of sourceFiles){
        const path=join(source,file.path);
        if(!lstatSync(path).isFile()||!realpathSync(path).startsWith(realpathSync(source)+'/')||hash(readFileSync(path))!==file.sha256)throw Error('运行验证期间工程输入被修改，拒绝出包');
      }
    };
    const version=await this.command(job,this.godot,['--version'],base);
    if(!version.trim().startsWith('4.6.stable.'))throw Error('需要匹配 Godot 4.6 stable 工具链');
    this.update(job,{engine:version.trim(),progress:20,stage:'Godot 正在导入工程'});
    await this.measure(job,'import',()=>this.command(job,this.godot,['--headless','--editor','--path',source,'--import'],base,{isolatedProject:source,importing:true}));
    verifyInputs();
    const importedExport=await this.measure(job,'import_snapshot',()=>this.prepareImportedExport(job,source,sourceFiles));
    this.update(job,{progress:35,stage:job.purpose==='native_preview'?'验证原生编辑视口':job.purpose==='native_shared'?'验证共享世界显示端':'验证独立运行入口'});
    const manifest=this.store.get('creator_revision',job.source_revision).manifest;
    // Play boots the selected canonical entry. A prefab can rely on its parent
    // scene's services/InputMap and is not an independent executable. Keep the
    // full project import and dependency closure above; explicit prefab tests
    // still boot their selected authored test scene.
    const resources=['play','prefab_test'].includes(job.purpose)?[job.entry_scene_id]:Object.values(manifest.resources).filter(resource=>job.kind==='source'||job.purpose==='native_preview'||!isPrefabTest(resource)).map(resource=>resource.id);
    for(const [index,resourceId] of (job.purpose==='native_preview'?[job.entry_scene_id]:resources).entries()){
      this.update(job,{progress:35+Math.floor(index/resources.length*10),stage:`验证资源 ${index+1} / ${resources.length}`});
      // Fixed simulation steps remove real-time waiting; each checked entry
      // still runs all 180 iterations in a fresh save domain.
      await this.measure(job,'resource_check',()=>this.command(job,this.godot,['--headless','--path',source,'--fixed-fps','60','--quit-after','180','--','--release-scene='+resourceId],base,{isolatedProject:source,requiredMarker:job.purpose==='native_preview'?'PREVIEW_LOADED':job.purpose==='native_shared'?'NATIVE_SHARED_CLIENT_READY':'STANDALONE_READY'}),{resource_id:resourceId});
    }
    this.update(job,{progress:45,stage:job.kind==='source'?'正在压缩 Godot 工程':'准备平台导出'});
    verifyInputs();
    if(job.kind==='source'){
      const output=join(base,'Godot-project.zip');
      await this.measure(job,'archive',()=>this.command(job,'zip',['-q',output,...sourceFiles.map(file=>file.path)],source),{target:'source'});
      await this.artifact(job,'source',output);
    }else{
      // A clean import snapshot was captured before running author code. Export
      // itself scans/imports changed resources, without a redundant editor run.
      // If no reusable importer output exists, retain the original cold path.
      const exportSource=importedExport?.directory??join(base,'export-project');
      if(importedExport)verifyImportedFiles(exportSource,importedExport.files,{exact:true});
      else{
        await mkdir(exportSource,{recursive:true});
        for(const file of sourceFiles){const destination=join(exportSource,file.path);await mkdir(dirname(destination),{recursive:true});cpSync(join(source,file.path),destination);}
      }
      await writeFile(join(exportSource,'export_presets.cfg'),this.presets(job,true));
      if(!importedExport)await this.measure(job,'export_import',()=>this.command(job,this.godot,['--headless','--editor','--path',exportSource,'--import'],base,{isolatedProject:exportSource,importing:true}));
      for(const [index,target] of job.targets.entries()){
        const spec=TARGETS.find(t=>t.id===target),cap=this.targets().find(t=>t.id===target);
        this.update(job,{progress:45+Math.floor(index/job.targets.length*50),stage:`正在打包 ${spec.label}`});
        try{
          if(!cap.available)throw Error(cap.reason);
          const out=join(base,target);await mkdir(out,{recursive:true});
          await this.measure(job,'export',()=>this.command(job,this.godot,['--headless','--path',exportSource,'--export-release',spec.label,join(out,spec.entry)],base,{signing:target==='android'||target==='ios',isolatedProject:exportSource,importing:true,readPaths:[join(this.templates,spec.template)],writePaths:[out],selfContained:true}),{target});
          if(target==='web')for(const file of ['index.html','index.js','index.pck','index.wasm'])if(!existsSync(join(out,file)))throw Error('Web 产物缺失 '+file);
          if(!existsSync(join(out,spec.entry))||statSync(join(out,spec.entry)).size===0)throw Error('导出程序未产生目标文件');
          if(target==='linux')await chmod(join(out,spec.entry),0o755);
          if(target==='web'){
            // Reuse the checked, non-threaded preview adapter before recording
            // immutable artifact hashes. Old releases are never rewritten.
            const compatibility=await adaptSingleThreadLocalHttp({javascript:await readFile(join(out,'index.js'),'utf8'),html:await readFile(join(out,'index.html'),'utf8'),wasm:await readFile(join(out,'index.wasm')),presets:await readFile(join(exportSource,'export_presets.cfg'),'utf8'),engineVersion:version.trim()});
            if(compatibility.metadata.policy!==WEB_COMPATIBILITY_POLICY)throw Error('Web 兼容策略与当前构建服务不匹配');
            await writeFile(join(out,'index.js'),compatibility.javascript);
            const shell=job.purpose==='native_preview'?{html:compatibility.html,metadata:{contract:NATIVE_EDITOR_CONTRACT,preview_only:true}}:adaptCanonicalGameWeb({html:compatibility.html,identity:job.game_identity,storage:job.storage});
            await writeFile(join(out,'index.html'),shell.html);
            await jsonFile(join(out,'game-identity.json'),{...job.game_identity,storage:job.storage,shell:shell.metadata});
            job.canonical_web=shell.metadata;
            await jsonFile(join(out,'web-compatibility.json'),compatibility.metadata);
            job.web_compatibility=compatibility.metadata;
          }
          const webFiles=target==='web'?(await readdir(out)).filter(f=>statSync(join(out,f)).isFile()).map(path=>({path,size:statSync(join(out,path)).size,sha256:hash(readFileSync(join(out,path)))})):null;
          const output=join(base,target+'.zip');
          await this.measure(job,'archive',()=>this.command(job,'zip',['-q','-r',output,'.'],out),{target});
          await this.artifact(job,target,output,webFiles);
          job.target_results.push({target,status:'completed'});
        }catch(error){if(this.closing)throw error;job.target_results.push({target,status:'failed',error:this.cleanError(error.message)});}
        this.update(job,{});
      }
      await writeFile(join(exportSource,'export_presets.cfg'),this.presets(job));
    }
    this.executionUser(job);this.verifyToolchain(job);
    const failed=job.target_results.some(t=>t.status==='failed');
    this.update(job,{status:failed?(job.artifacts.length?'partial':'failed'):'completed',progress:100,stage:failed?'平台构建已结束，请查看各平台结果':'导出完成',finished_at:Date.now()});
    // Local SDK paths and signing metadata are never retained in the source ZIP.
    await writeFile(join(source,'export_presets.cfg'),this.presets(job));
  }
  download(user,jobId,artifactId,req,res){
    const job=this.forUser(user,jobId);this.store.projectFor(user,job.project_id,true);const artifact=job.artifacts.find(a=>a.id===artifactId);
    if(!artifact)fail(404,'构建产物尚未就绪');
    const path=join(this.directory,job.id,artifact.filename);this.stream(req,res,path,artifact,'application/zip',true);
  }
  stream(req,res,path,entry,type,attachment=false){
    if(!existsSync(path)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())fail(409,'产物校验失败，请重新构建');
    const identity=fileIdentity(path);
    if(identity.size!==entry.size||identity.sha256!==entry.sha256)fail(409,'产物校验失败，请重新构建');
    res.writeHead(200,{'Content-Type':type,'Content-Length':entry.size,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...(attachment?{'Content-Disposition':`attachment; filename="${entry.filename}"`}:{})});
    if(req.method==='HEAD')res.end();else createReadStream(path).pipe(res);
  }
  access(user,jobId,res,req){
    const job=this.forUser(user,jobId);if(!job.web_files?.length)fail(409,'此任务没有就绪的 Web 版本');
    if(job.purpose!=='native_preview')return this.service.runtimeAccess.issue(user,job,req);
    const token=randomBytes(32).toString('base64url'),expires_at=Date.now()+3600000;
    this.store.put('creator_build_access',{id:hash(token),job_id:job.id,user_id:user.id,expires_at});
    res.setHeader('Set-Cookie',`atelier_release=${token}; Path=/creation-releases/${job.id}/; HttpOnly; SameSite=Strict; Max-Age=3600`);
    return {web_url:`/creation-releases/${job.id}/web/index.html`,expires_at};
  }
  webRequest(req,res){
    const url=new URL(req.url,this.service.origin);if(!url.pathname.startsWith('/creation-releases/'))return false;
    const match=/^\/creation-releases\/(build-[a-f0-9-]+)\/web\/([\w.-]+)$/.exec(decodeURIComponent(url.pathname));
    if(!match||!['GET','HEAD'].includes(req.method))fail(404,'发行文件不存在');
    const token=String(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('atelier_release='))?.slice(16);
    const grant=token&&this.store.get('creator_build_access',hash(token));
    if(!grant||grant.job_id!==match[1]||grant.expires_at<Date.now())fail(403,'请从工作台重新打开此 Web 版本');
    const job=this.forUser({id:grant.user_id},match[1]),entry=job.web_files?.find(e=>e.path===match[2]);
    if(!entry)fail(404,'文件不在固定发行清单中');
    if(job.purpose!=='native_preview'){
      // Historical release cookies are not tied to an active creator login.
      // Never exchange them for a renewable author-code execution capability.
      fail(403,'此旧运行地址已改为隔离访问；请登录原工作台，重新打开这个固定 Web 版本');
    }
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.wasm':'application/wasm','.png':'image/png','.json':'application/json'};
    this.stream(req,res,join(this.directory,job.id,'web',entry.path),entry,types[extname(entry.path)]??'application/octet-stream');return true;
  }
  async close(){
    this.closing=true;
    const contentClosing=closeNativeEditorContent(this);
    for(const jobId of this.queue){const job=this.store.get(KIND,jobId);this.update(job,{status:'interrupted',stage:'服务关闭，等待重新提交',finished_at:Date.now()});}this.queue=[];
    if(this.child)try{process.platform==='win32'?this.child.kill('SIGKILL'):process.kill(-this.child.pid,'SIGKILL');}catch{}
    this.worker?.stop();
    await this.running;
    await contentClosing;
  }
}
