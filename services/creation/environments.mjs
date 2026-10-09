import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, realpathSync, cpSync, lstatSync, rmSync, chmodSync, constants } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fail, hash, id } from './schema.mjs';
import { HIERARCHY_SCHEMA } from './hierarchy.mjs';
import { designKnowledgeIndex, SEMANTIC_AUTHORING_GUIDE } from './semantic-context.mjs';
import { projectInventory, snapshotProjectRuntime, assembleProject, verifyProjectFiles, GAME_PROJECT_CONTRACT, GAME_STORAGE_POLICY } from './project-snapshot.mjs';
import { prepareExecutionEnvironment, executionCapabilities } from './execution-environment.mjs';
import {nativeEnvironmentFields,nativeWorkspaceContext,nativeSemanticAuthoringGuide,scanNativeWorkspace} from './native-agent-workspace.mjs';
import {PROPERTY_ACTION_GUIDE,propertyActionContext,propertyActionTools} from './authoring-actions.mjs';
import {attachmentReferences} from './agent-attachment-references.mjs';
import {agentTextContext} from './agent-text-context.mjs';

const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,mode:0o600});
function safeDirectory(root,path){
  let current=realpathSync(root);
  const parts=relative(resolve(root),resolve(path)).split(sep);
  if(parts.some(p=>p==='..')||parts.some(p=>!p))fail(403,'环境目录越界');
  for(const part of parts){current=join(current,part);try{const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail(403,'环境目录不允许符号链接');}catch(error){if(error.code!=='ENOENT')throw error;mkdirSync(current);}}
  return current;
}
export function writeWorkspaceFile(cwd,file,content){
  const target=resolve(cwd,file);
  if(!target.startsWith(resolve(cwd)+sep))fail(403,'上下文文件越界');
  if(dirname(target)!==resolve(cwd))safeDirectory(cwd,dirname(target));
  writeFileSync(target,content,{flag:constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,mode:0o600});
}
const scope=session=>({project_id:session.project_id,branch_id:session.branch_id,user_id:session.owner_user_id,session_id:session.id});
const kill=child=>{try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}};

/** Persistent conversations own files; fixed projections and executions have separate identities. */
export class CreationEnvironments {
  constructor({service}){
    this.service=service;this.store=service.store;this.directory=resolve(service.data,'environments');
    this.godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
    mkdirSync(this.directory,{recursive:true});this.children=new Set();this.active=new Set();this.pending=new Set();this.closing=false;
    for(const test of this.store.list('creator_environment_test'))if(test.status==='running')this.store.put('creator_environment_test',{...test,status:'interrupted',finished_at:Date.now()});
  }
  session(session,cwd){
    this.store.sessionFor({id:session.owner_user_id},session.id,true);
    const expected=resolve(this.service.data,'workspaces',session.project_id,session.branch_id,session.owner_user_id,session.id);
    safeDirectory(this.service.data,expected);
    if(realpathSync(cwd)!==realpathSync(expected))fail(403,'会话环境目录不匹配');
    // Existing session cwd and arbitrary authored files survive this additive migration.
    for(const dir of ['context','work','outputs','.execution'])safeDirectory(cwd,join(cwd,dir));
    const launcher=join(cwd,'.execution','godot'),runner=join(cwd,'.execution','godot-test-runner.mjs');
    const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
    writeWorkspaceFile(cwd,'.execution/godot-test-runner.mjs',readFileSync(new URL('./godot-test-runner.mjs',import.meta.url)));
    writeWorkspaceFile(cwd,'.execution/godot-test.json',JSON.stringify({executable:this.godot,sessionRoot:cwd})+'\n');
    writeWorkspaceFile(cwd,'.execution/godot',`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(runner)} "$@"\n`);
    chmodSync(launcher,0o700);
    const manifest={version:1,...scope(session),cwd,authority:'central_source_service',game_project_contract:GAME_PROJECT_CONTRACT,runtime_entry:{main_scene:'res://standalone.tscn',autoload:'GameRuntime',run:'Godot F5 or --path project',shared_with:['editor_play','standalone_web','native_exports']},storage_policy:GAME_STORAGE_POLICY,paths:{context:join(cwd,'context'),work:join(cwd,'work'),outputs:join(cwd,'outputs')},tools:['semantic_read','semantic_apply','knowledge_search','knowledge_read','knowledge_write','world_read','workspace_prepare','workspace_test','asset_catalog','asset_search','asset_detail','asset_import','asset_publish','world_apply','game_validate','world_validate','shared_world_validate','world_publish'],engine:{family:'Godot',required:'4.6.stable',executable:this.godot},isolation:executionCapabilities(),note:'工程是中央源稿的固定投影，与编辑器 Play 和独立游戏共用 GameRuntime 原生入口。所有场景、未摆放预制件、嵌套定义与版本依赖都包含在内。修改在 work/ 副本中进行，通过 asset_publish/world_apply 提交后重新生成；不改 runtime/ 固定输入，不把模型编辑器宿主带入游戏。测试使用独立 user://，不连接在线世界。'};
    manifest.skills=[{name:'game-assets',path:join(cwd,'.agents/skills/game-assets/SKILL.md'),description:'搜集、下载、制作和导入游戏资产；上下文仅保留引用与摘要。'}];
    manifest.asset_workflow={server_downloads:true,file_authoring:true,context:'references_and_metadata',native_submission:'submit_native_workspace',legacy_publication:['glb','gd'],network:'creator command network policy; isolation below describes Godot execution'};
    manifest.engine.executable=launcher;
    manifest.engine.test_policy={default_mode:'headless',visual_flag:'--wa-render',audio:'Dummy',desktop_input:'forbidden',background_renderer:process.platform==='darwin'?'embedded':'unavailable',render_timeout_seconds:120,render_fps_limit:30};
    const branch=this.store.get('creator_branch',`${session.project_id}:${session.branch_id}`),source=branch&&this.store.get('creator_revision',branch.head)?.manifest;
    if(source?.schema==='creation-native-1')Object.assign(manifest,nativeWorkspaceContext(source),{note:'中央源稿是完整原生 Godot 工程。平台准备 godot_project 指定的可编辑工程，可在服务器工作区下载、导入资产，并使用 Godot 内建几何、Pillow 或已安装的 Blender 生成文件。允许本工程文件读取、增加、替换和删除；资产在场景中使用 res:// 路径。使用 world_apply submit_native_workspace 原子提交真实文件差异。上下文仅保留引用、哈希与必要摘要，不输出原始字节、base64 或完整资源对象。测试由 Agent 自行选择。'});
    for(const file of ['workspace.json']){try{if(lstatSync(join(cwd,file)).isSymbolicLink())fail(403,'环境清单不允许符号链接');}catch(error){if(error.code!=='ENOENT')throw error;}}
    manifest.tools=propertyActionTools(manifest.tools.map(name=>({name})),session).map(tool=>tool.name);
    const editing=this.store.get('creator_editable_project',session.id);
    if(editing)manifest.godot_project={environment_id:editing.environment_id,project_directory:editing.directory,source_revision:editing.source_revision,submit_path:relative(realpathSync(cwd),realpathSync(editing.directory)),asset_policy:'workspace_file_io',asset_context:'references_and_bounded_metadata_only',editing:'native_files'};
    json(join(cwd,'workspace.json'),manifest);return manifest;
  }
  context({session,run,cwd,attachments=[],objective=''}){
    this.session(session,cwd);
    const revision=run.input_revision,fixed=this.store.get('creator_revision',revision);
    if(!fixed||fixed.project_id!==session.project_id)fail(409,'执行输入源版本无效');
    const directory=safeDirectory(cwd,join(cwd,'context',run.id));
    const manifest={version:1,...scope(session),run_id:run.id,source_revision:revision,source_schema:fixed.manifest.schema??'creation-flat-1',game_project_contract:GAME_PROJECT_CONTRACT,runtime_entry:{main_scene:'res://standalone.tscn',autoload:'GameRuntime'},storage_policy:GAME_STORAGE_POLICY,objective,attachments,resources:Object.values(fixed.manifest.resources).map(r=>({id:r.id,kind:r.kind,name:r.name,version:r.version??null})),coordinate_system:{handedness:'right',up_axis:'Y',units:'metres',local_transform:'T*R*S',rotation:fixed.manifest.schema===HIERARCHY_SCHEMA?'quaternion_xyzw':'degrees_YXZ',world_matrix:'column_major_4x4'},authority:'Attachments preserve their captured source and observed poses. Read current versions before shared edits; never relabel an old observation as the moving head.'};
    if(fixed.manifest.schema==='creation-native-1'){
      Object.assign(manifest,nativeWorkspaceContext(fixed.manifest));
      manifest.coordinate_system={handedness:'right',up_axis:'Y',units:'metres',local_transform:'native Godot Transform3D',rotation:'native_property_encoding',world_matrix:'column_major_4x4'};
      manifest.resources=Object.values(fixed.manifest.resources).map(r=>({id:r.id,kind:r.kind,name:r.name,path:r.path,version:r.version??null}));
    }
    manifest.attachments=attachmentReferences({cwd,attachments});
    const editing=this.store.get('creator_editable_project',session.id);
    if(editing)manifest.godot_project={environment_id:editing.environment_id,project_directory:editing.directory,source_revision:editing.source_revision,submit_path:relative(realpathSync(cwd),realpathSync(editing.directory)),editing:'native_files',assets:'workspace_files',asset_context:'references_and_bounded_metadata_only'};
    manifest.attachment_usage='引用链接只标识捕获时的对象；需要观察细节时按 snapshot_file 读取所需字段，不要展开整个快照。编辑前通过 world_read 核对当前源版本。';
    json(join(directory,'manifest.json'),manifest);json(join(directory,'source-manifest.json'),agentTextContext(fixed.manifest));
    json(join(directory,'design-knowledge-index.json'),designKnowledgeIndex(fixed.manifest,{...scope(session),revision}));
    writeWorkspaceFile(cwd,'SEMANTIC-AUTHORING.md',nativeSemanticAuthoringGuide(fixed.manifest)||SEMANTIC_AUTHORING_GUIDE);
    manifest.design_knowledge_index=join(directory,'design-knowledge-index.json');manifest.semantic_authoring_guide=join(cwd,'SEMANTIC-AUTHORING.md');manifest.execution_mode=run.execution_mode??'default';
    if(run.authoring_action){
      manifest.authoring_action=structuredClone(run.authoring_action);
      manifest.property_action_context=join(directory,'property-action.json');
      manifest.property_action_guide=join(directory,'PROPERTY-ACTION.md');
      let context;
      try{context=propertyActionContext(this.service,session,run,{revision});}
      catch(error){context={action:run.authoring_action,target_unavailable:true,error:error.message,note:'保持原目标；不要根据名称猜测另一个对象。可先与用户讨论。'};}
      json(manifest.property_action_context,agentTextContext(context));
      writeWorkspaceFile(cwd,`context/${run.id}/PROPERTY-ACTION.md`,PROPERTY_ACTION_GUIDE);
    }
    json(join(directory,'manifest.json'),manifest);
    json(join(cwd,'context','current.json'),{run_id:run.id,manifest:join(directory,'manifest.json')});
    return {manifest:join(directory,'manifest.json'),sha256:hash(readFileSync(join(directory,'manifest.json'))),...(run.authoring_action?{action_prompt:`\n[AI 添加属性] 目标为预制件定义 ${JSON.stringify(run.authoring_action.name)}。优先读取 ${manifest.property_action_guide} 和 ${manifest.property_action_context}；用 authoring_context 重读当前参数，properties_expose 批量公开已有参数。`}:{})};
  }
  check({session,run,cwd,guard}){
    if(this.closing)fail(503,'执行环境服务正在关闭');
    guard?.();this.store.sessionFor({id:session.owner_user_id},session.id,true);
    const expected=resolve(this.service.data,'workspaces',session.project_id,session.branch_id,session.owner_user_id,session.id);
    safeDirectory(this.service.data,expected);
    if(realpathSync(cwd)!==realpathSync(expected))fail(403,'会话环境目录不匹配');
    const current=this.store.get('creator_run',run.id);
    if(!current||current.status!=='running'||current.lease_generation!==run.lease_generation||current.session_id!==session.id||current.project_id!==session.project_id||current.branch_id!==session.branch_id||current.owner_user_id!==session.owner_user_id)fail(409,'环境操作所属执行租约已失效');
  }
  track(action){const promise=action();this.pending.add(promise);promise.then(()=>this.pending.delete(promise),()=>this.pending.delete(promise));return promise;}
  async prepareForRun(options){
    const {session,run,cwd}=options;this.check(options);
    const old=this.store.get('creator_editable_project',session.id),previous=old&&this.store.get('creator_environment',old.environment_id);
    if(previous?.native_workspace_files){
      const local=scanNativeWorkspace(old.directory,{retainBytes:Boolean(old.last_submission),guard:()=>this.check(options)});
      if(old.last_submission){
        const pending=Object.keys({...old.last_submission.files,...local.files}).filter(path=>hash(local.files[path]??null)!==hash(old.last_submission.files[path]??null));
        if(!pending.length)return this.prepare(options);
        // Rebase only edits made after the successful submission onto that exact
        // committed source. Keep the old directory intact throughout preparation.
        for(const path of pending){
          if(path.startsWith('atelier_runtime/'))fail(422,'生成运行文件发生修改，请恢复后继续',{path});
        }
        const next=await this.prepare({...options,input:{...options.input,revision:old.last_submission.revision}});
        const workspaceRoot=realpathSync(cwd);
        for(const path of pending){this.check(options);const target=join(next.editable_project_directory,path);if(local.files[path])writeWorkspaceFile(workspaceRoot,relative(workspaceRoot,target),local.contents.get(path));else{safeDirectory(workspaceRoot,dirname(target));rmSync(target,{force:true});}}
        return {...next,retained_local_edits:true};
      }
      if(hash(local.files)!==hash(previous.native_workspace_files)){
        // Preserve unfinished native files, including binary assets, across turns.
        // Rebind the original fixed
        // baseline; central version guards still reject conflicting commits.
        const branch=this.store.branchFor({id:session.owner_user_id},session.project_id,session.branch_id,true);
        if(!this.store.ancestor(previous.source_revision,branch.head))fail(409,'未提交 Godot 工程的基线已不属于当前分支，请先处理工作区分歧');
        const rebound={...previous,id:id('env'),run_id:run.id,lease_generation:run.lease_generation,created_at:Date.now(),retained_local_edits:true};
        this.store.put('creator_environment',rebound);this.store.put('creator_editable_project',{...old,environment_id:rebound.id});
        this.session(session,cwd);return {...rebound,editable_project_directory:old.directory,submit_path:relative(realpathSync(cwd),realpathSync(old.directory)),usage:'保留了上一回合未提交的原生文件与资产改动。工程基线仍为 source_revision；请先对照 world_read 当前源稿，提交时保留版本冲突检查。资产字节继续留在工作区文件中。'};
      }
    }
    return this.prepare(options);
  }
  prepare(options){return this.track(()=>this.prepareOnce(options));}
  async prepareOnce({session,run,cwd,input={},guard}){
    const context={session,run,cwd,guard};this.check(context);this.session(session,cwd);
    const branch=this.store.branchFor({id:session.owner_user_id},session.project_id,session.branch_id,true);
    const revision=input.revision??branch.head,fixed=this.store.get('creator_revision',revision);
    if(!fixed||fixed.project_id!==session.project_id||!this.store.ancestor(revision,branch.head))fail(409,'请选择此分支可达的源版本');
    const resource=input.resource_id??fixed.manifest.entry_scene_id;
    if(!fixed.manifest.resources[resource])fail(404,'运行资源不存在');
    const existing=this.store.list('creator_environment').filter(e=>e.run_id===run.id);
    const reusable=existing.find(e=>e.editable_project_directory&&e.source_revision===revision&&e.entry_resource_id===resource&&e.lease_generation===run.lease_generation);
    if(reusable){this.session(session,cwd);return {...reusable,submit_path:relative(realpathSync(cwd),realpathSync(reusable.editable_project_directory)),usage:'Godot 工程已经准备好；直接编辑 editable_project_directory 中的原生文件，可下载、生成、复制或替换资产并使用 res:// 引用。通过 submit_native_workspace 提交；资产字节留在文件中，向对话仅返回路径、哈希与必要摘要。'};}
    if(existing.length>=12)fail(429,'单次执行最多准备 12 个固定环境');
    const envId=id('env'),base=join(this.directory,envId),project=join(base,'project');
    try{
      const runtime=snapshotProjectRuntime(this.service.root,project);
      await assembleProject({service:this.service,user:{id:session.owner_user_id},project_id:session.project_id,branch_id:session.branch_id,revision,entry_scene_id:resource,directory:project,runtime_source_hash:runtime.hash,allowPrefab:true});
      this.check(context);
      if(fixed.manifest.schema==='creation-native-1')json(join(project,'atelier_runtime','source-manifest.json'),agentTextContext(fixed.manifest));
      const nativeFields=nativeEnvironmentFields(fixed.manifest,project,{guard:()=>this.check(context)});
      const files=nativeFields.files??projectInventory(project);
      if(files.reduce((sum,f)=>sum+f.size,0)>512*1024*1024)fail(413,'固定环境超过本机 512 MiB 上限');
      const manifest={version:1,id:envId,...scope(session),run_id:run.id,lease_generation:run.lease_generation,source_revision:revision,runtime_source_hash:runtime.hash,game_project_contract:GAME_PROJECT_CONTRACT,storage_policy:GAME_STORAGE_POLICY,engine:{family:'Godot',required:'4.6.stable'},entry_resource_id:resource,resource_ids:Object.keys(fixed.manifest.resources),project_directory:project,files,project_hash:hash(files),created_at:Date.now()};
      Object.assign(manifest,nativeFields);
      if(fixed.manifest.schema==='creation-native-1'){
        const editable=safeDirectory(cwd,join(cwd,'work',envId));
        for(const file of files){this.check(context);const target=join(editable,file.path);mkdirSync(dirname(target),{recursive:true});cpSync(join(project,file.path),target);}
        manifest.editable_project_directory=editable;
        this.store.put('creator_editable_project',{id:session.id,environment_id:envId,directory:editable,source_revision:revision});
      }
      json(join(base,'manifest.json'),manifest);this.store.put('creator_environment',manifest);
      this.session(session,cwd);
      return {...manifest,manifest_file:join(base,'manifest.json'),...(manifest.editable_project_directory?{submit_path:relative(realpathSync(cwd),realpathSync(manifest.editable_project_directory))}:{}),usage:fixed.manifest.schema==='creation-native-1'?'Godot 工程已经准备好，直接在 editable_project_directory 运行命令，编辑原生脚本、场景、资源并在服务器下载、导入或生成资产文件。可用 Godot 内建几何、Pillow、已安装的 Blender 做本工作区文件 IO。资产字节不进入对话，仅返回路径、哈希和必要摘要。通过 world_apply submit_native_workspace 提交，environment_id 使用 id，path 使用 submit_path，base_revision 使用 source_revision。固定 project_directory 只作服务器基线。':'固定 Godot 工程已准备好，资产由引擎加载，只编辑文本配置并引用资源路径。'};
    }catch(error){await rm(base,{recursive:true,force:true});throw error;}
  }
  async command(environment,args,{context,signal,project,logName}){
    this.check(context);if(signal?.aborted)fail(409,'环境执行已取消');
    const command=environment.command(this.godot,args,{godot:true,projectPath:project,logName});
    return await new Promise((done,reject)=>{
      const child=spawn(command.command,command.args,{...command.options,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});this.children.add(child);
      let output='',invalid=null,hadError=false,scanTail='',pendingLine='',ready=[];const collect=data=>{const text=data.toString();hadError ||= /SCRIPT ERROR|Parse Error|ERROR:/.test(scanTail+text);scanTail=(scanTail+text).slice(-32);output=(output+text).slice(-64000);pendingLine+=text;let end;while((end=pendingLine.indexOf('\n'))>=0){const line=pendingLine.slice(0,end);pendingLine=pendingLine.slice(end+1);if(line.startsWith('STANDALONE_READY '))try{ready.push(JSON.parse(line.slice(17)));ready=ready.slice(-12);}catch{}}pendingLine=pendingLine.slice(-64000);};child.stdout.on('data',collect);child.stderr.on('data',collect);
      const abort=()=>{invalid=Error('环境执行已取消');kill(child);};signal?.addEventListener('abort',abort,{once:true});
      const deadline=setTimeout(()=>{invalid=Error('环境执行超过 60 秒');kill(child);},60000);
      const lease=setInterval(()=>{try{this.check(context);}catch(error){invalid=error;kill(child);}},500);lease.unref?.();
      const clean=()=>{clearTimeout(deadline);clearInterval(lease);signal?.removeEventListener('abort',abort);this.children.delete(child);};
      child.once('error',error=>{clean();reject(error);});
      child.once('close',(code,signalName)=>{clean();json(join(environment.directories.logs,logName+'.receipt.json'),{executable:this.godot,args,exit_code:code,signal:signalName,output});if(invalid||code!==0||hadError)reject(Object.assign(invalid??Error(output||`Godot 退出 ${code??signalName}`),{output,exit_code:code}));else done({output,exit_code:code,ready});});
    });
  }
  test(options){return this.track(()=>this.testOnce(options));}
  async testOnce({session,run,cwd,input={},guard,signal}){
    const context={session,run,cwd,guard};this.check(context);
    const prepared=this.store.get('creator_environment',input.environment_id);
    if(!prepared||prepared.session_id!==session.id||prepared.project_id!==session.project_id||prepared.branch_id!==session.branch_id||prepared.user_id!==session.owner_user_id||prepared.run_id!==run.id||prepared.lease_generation!==run.lease_generation)fail(403,'环境不属于当前会话执行');
    const resource=input.resource_id??prepared.entry_resource_id;
    if(!prepared.resource_ids.includes(resource))fail(404,'固定环境不包含此资源');
    if(this.active.size>=2)fail(429,'本机独立 Godot 测试已达到并发上限');
    const task=id('envtest'),base=join(this.directory,prepared.id,'tests',task),project=join(base,'project');
    const record={id:task,environment_id:prepared.id,...scope(session),run_id:run.id,source_revision:prepared.source_revision,runtime_source_hash:prepared.runtime_source_hash,project_hash:prepared.project_hash,resource_id:resource,status:'running',created_at:Date.now(),claim:'technical_standalone_smoke_only'};
    this.active.add(task);this.store.put('creator_environment_test',record);
    try{
      verifyProjectFiles(prepared.project_directory,prepared.files);mkdirSync(project,{recursive:true});
      for(const file of prepared.files){const target=join(project,file.path);mkdirSync(dirname(target),{recursive:true});cpSync(join(prepared.project_directory,file.path),target);}
      mkdirSync(join(project,'.godot'),{recursive:true});
      const writableImports=prepared.files.filter(f=>f.path.endsWith('.import')).map(f=>join(project,f.path));
      const executionDirectory=join(base,'execution');
      const importer=prepareExecutionEnvironment({directory:executionDirectory,readPaths:[project],writePaths:[join(project,'.godot')],safeSavePaths:writableImports});
      const version=await this.command(importer,['--version'],{context,signal,project,logName:'version.log'});
      record.engine=version.output.trim();if(!record.engine.startsWith('4.6.stable.'))fail(422,'需要匹配 Godot 4.6 stable 工具链');
      await this.command(importer,['--headless','--editor','--path',project,'--import'],{context,signal,project,logName:'import.log'});
      verifyProjectFiles(project,prepared.files);
      const runtime=prepareExecutionEnvironment({directory:executionDirectory,readPaths:[project]});
      const result=await this.command(runtime,['--headless','--path',project,'--quit-after','180','--','--release-scene='+resource],{context,signal,project,logName:'runtime.log'});
      if(!result.ready.some(r=>r.project_id===session.project_id&&r.branch_id===session.branch_id&&r.revision===prepared.source_revision&&r.scene_id===resource))fail(422,'Godot 未确认此固定版本和资源的独立加载');
      verifyProjectFiles(project,prepared.files);verifyProjectFiles(prepared.project_directory,prepared.files);this.check(context);
      Object.assign(record,{status:'passed',exit_code:result.exit_code,output:result.output,execution_directory:executionDirectory,isolation:runtime.capabilities,user_data_home:runtime.directories.home});
    }catch(error){Object.assign(record,{status:signal?.aborted?'cancelled':'failed',error:error.message,output:error.output??'',exit_code:error.exit_code??null});}
    finally{
      this.active.delete(task);record.finished_at=Date.now();this.store.put('creator_environment_test',record);
      const output=safeDirectory(cwd,join(cwd,'outputs',task));json(join(output,'receipt.json'),record);record.receipt_file=join(output,'receipt.json');
    }
    return record;
  }
  async close(){this.closing=true;for(const child of this.children)kill(child);await Promise.all([...this.children].map(child=>new Promise(resolve=>child.once('close',resolve))));await Promise.allSettled([...this.pending]);}
}
