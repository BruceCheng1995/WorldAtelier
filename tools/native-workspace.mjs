import {constants,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,lstatSync,existsSync,realpathSync,openSync,closeSync,fsyncSync,linkSync,copyFileSync,rmSync,rmdirSync} from 'node:fs';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NativeSourceArchive,nativeFileMap,nativeSourceIdentity,nativeSourcePath} from '../services/creation/native-source.mjs';
import {scanNativeWorkspace} from '../services/creation/native-agent-workspace.mjs';
import {mergeNativeFiles} from '../services/creation/native-merge-engine.mjs';
import {hash} from '../services/creation/schema.mjs';
import {prepareNativeOfflinePlay,verifyOfflineAssembler} from './native-workspace-runtime.mjs';

export const NATIVE_WORKSPACE_FORMAT='world-atelier-native-workspace-1';
const same=(a,b)=>a?.hash===b?.hash&&a?.size===b?.size;
const jsonFile=(path,fallback=null)=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
function atomicJson(path,value){mkdirSync(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);}
function entry(path){try{const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile())throw Error('同步目标必须是普通文件：'+path);const bytes=readFileSync(path);return {hash:hash(bytes),size:bytes.length};}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function safeDirectory(path){mkdirSync(path,{recursive:true,mode:0o700});if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())throw Error('工作区目录不能是符号链接：'+path);}
function safeParents(base,path){
  const local=relative(base,path);if(local==='..'||local.startsWith('..'+sep)||resolve(base,local)!==path)throw Error('工作区路径越界');
  let cursor=base;for(const part of local.split(sep).slice(0,-1)){cursor=join(cursor,part);safeDirectory(cursor);}if(realpathSync(dirname(path))!==dirname(path))throw Error('工作区父路径包含符号链接');
}
function conflictError(message,details){const error=Error(message);error.code='NATIVE_WORKSPACE_CONFLICT';error.details=details;return error;}

/** Uses only an in-memory token. Credentials are never written into a checkout,
 * a cached blob, a journal, a manifest or an exported client bundle. */
export function nativeWorkspaceApi({server,token,fetch:fetcher=globalThis.fetch}){
  const url=new URL(server);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('服务器地址必须是无凭据的 HTTP(S) 来源');const origin=url.origin;
  return async(path,{method='GET',body,raw=false}={})=>{
    if(typeof token!=='string'||!token)throw Error('请通过 WORLD_ATELIER_TOKEN 提供登录令牌');
    if(!path.startsWith('/creation-api/'))throw Error('工作区客户端只能调用固定创作 API');
    const headers={Origin:origin,Authorization:'Bearer '+token};if(body!==undefined)headers['Content-Type']=Buffer.isBuffer(body)||body instanceof Uint8Array?'application/octet-stream':'application/json';
    const response=await fetcher(origin+path,{method,headers,body:body===undefined?undefined:Buffer.isBuffer(body)||body instanceof Uint8Array?body:JSON.stringify(body),redirect:'error'});
    if(!response.ok){let data;try{data=await response.json();}catch{data={message:'HTTP '+response.status};}const error=Error(data.message??data.error??'HTTP '+response.status);error.status=response.status;error.details=data.details??data;throw error;}
    return raw?Buffer.from(await response.arrayBuffer()):response.json();
  };
}

export class NativeWorkspaceClient{
  constructor({directory,server,token,api,fetch,log=()=>{},hooks={}}){
    this.directory=resolve(directory);this.metadata=join(this.directory,'.wa-workspace');this.project=join(this.directory,'project');this.statePath=join(this.metadata,'state.json');this.operationPath=join(this.metadata,'operation.json');this.conflictsPath=join(this.metadata,'conflicts.json');this.server=server;this.token=token;this.apiOverride=api;this.fetch=fetch;this.log=log;this.hooks=hooks;
  }
  initialize(){safeDirectory(this.directory);this.directory=realpathSync(this.directory);this.metadata=join(this.directory,'.wa-workspace');this.project=join(this.directory,'project');this.statePath=join(this.metadata,'state.json');this.operationPath=join(this.metadata,'operation.json');this.conflictsPath=join(this.metadata,'conflicts.json');safeDirectory(this.metadata);this.archive??=new NativeSourceArchive(join(this.metadata,'objects'));}
  state(){const state=jsonFile(this.statePath);if(!state||state.format!==NATIVE_WORKSPACE_FORMAT)throw Error('不是原生工作区，请先 checkout');if(this.server&&new URL(this.server).origin!==state.server)throw Error('工作区绑定了另一服务器，不能静默切换');return state;}
  api(state=null){return this.apiOverride??nativeWorkspaceApi({server:state?.server??this.server,token:this.token,fetch:this.fetch});}
  route(state){return '/creation-api/native-workspaces/'+encodeURIComponent(state.workspace_id);}
  saveOperation(operation){atomicJson(this.operationPath,operation);}
  snapshot(){if(!existsSync(this.project))return{};const snapshot=scanNativeWorkspace(this.project,{retainBytes:true});for(const bytes of snapshot.contents.values())this.archive.put(bytes);return snapshot.files;}
  async lock(action){
    this.initialize();const path=join(this.metadata,'lock');
    try{mkdirSync(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;const owner=jsonFile(join(path,'owner.json'));let alive=false;try{if(owner?.pid){process.kill(owner.pid,0);alive=true;}}catch(error){if(error.code==='EPERM')alive=true;}if(alive||!owner&&Date.now()-lstatSync(path).mtimeMs<30000)throw Error('此工作区已有同步命令，等待其结束后重试');rmSync(path,{recursive:true});mkdirSync(path,{mode:0o700});}
    atomicJson(join(path,'owner.json'),{pid:process.pid,started_at:Date.now()});try{return await action();}finally{rmSync(path,{recursive:true,force:true});}
  }
  async download(files,api,route,query=''){
    const entries=[...new Map(Object.values(nativeFileMap(files)).map(value=>[value.hash,value])).values()];let downloaded=0,reused=0,position=0;
    await Promise.all(Array.from({length:Math.min(4,entries.length)},async()=>{for(;;){const index=position++;if(index>=entries.length)return;const expected=entries[index];try{this.archive.read(expected);reused++;continue;}catch{}const bytes=await api(route+'/blobs/'+expected.hash+query,{raw:true});if(bytes.length!==expected.size||hash(bytes)!==expected.hash)throw Error('下载文件哈希不匹配：'+expected.hash);this.archive.put(bytes);downloaded+=bytes.length;}}));
    this.log({stage:'downloaded',bytes:downloaded,cached_files:reused});return {downloaded_bytes:downloaded,cached_files:reused};
  }
  stateFrom(snapshot,server){return{format:NATIVE_WORKSPACE_FORMAT,server:new URL(server).origin,workspace_id:snapshot.workspace_id,project_id:snapshot.project_id,branch_id:snapshot.branch_id,base_revision:snapshot.revision,workspace_version:snapshot.workspace_version,base_files:nativeFileMap(snapshot.files),source_identity:snapshot.source_identity,created_at:snapshot.created_at,updated_at:Date.now(),source_directory:'project',progress_policy:'never_sync'};}
  async cacheRuntime(snapshot,api){
    const route=this.route(snapshot),runtime=await api(route+'/runtime',{method:'POST',body:{revision:snapshot.revision??snapshot.base_revision}});verifyOfflineAssembler(runtime.policy);
    await this.download(runtime.template_files,api,route,'?runtime_id='+encodeURIComponent(runtime.runtime_id));await this.download(runtime.adapter_files,api,route,'?runtime_id='+encodeURIComponent(runtime.runtime_id));atomicJson(join(this.metadata,'runtime.json'),runtime);return runtime;
  }
  async checkout({project_id,branch_id='main',revision,request_id}={}){
    if(existsSync(this.directory)&&!existsSync(this.operationPath))throw Error('目标目录已存在；请选择新目录以保留原文件');
    return this.lock(async()=>{
      let operation=jsonFile(this.operationPath);if(operation&&operation.kind!=='checkout')throw Error('此目录有未完成操作，请 recover');
      if(operation?.phase==='applying')return this.applyJournal(operation);
      if(!operation){operation={id:request_id??randomUUID(),kind:'checkout',phase:'create',server:new URL(this.server).origin,request:{request_id:request_id??randomUUID(),project_id,branch_id,...(revision?{revision}:{})},created_at:Date.now()};this.saveOperation(operation);}
      const api=this.api({server:operation.server});
      if(!operation.server_snapshot){operation.server_snapshot=await api('/creation-api/native-workspaces',{method:'POST',body:operation.request});this.saveOperation(operation);}
      const snapshot=operation.server_snapshot,route=this.route(snapshot);await this.download(snapshot.files,api,route,'?revision='+encodeURIComponent(snapshot.revision));
      if(!operation.runtime_cached){await this.cacheRuntime(snapshot,api);operation.runtime_cached=true;this.saveOperation(operation);}
      return this.planApply(operation,{},snapshot.files,this.stateFrom(snapshot,operation.server));
    });
  }
  writeConflicts(operation,result,stage){operation.phase=stage;operation.conflicts=result.conflicts;this.saveOperation(operation);atomicJson(this.conflictsPath,{operation_id:operation.id,stage,conflicts:result.conflicts,unresolved_count:result.unresolved?.length??result.unresolved_count,resolutions:operation.resolutions??{}});throw conflictError('工作区有需要处理的局部冲突，源文件与三方版本均已保留。使用 conflicts 查看，再用 resolve 提交决议。',{conflicts:this.conflictsPath,stage});}
  async planApply(operation,base,source,nextState,resolutions=operation.local_resolutions??{}){
    const current=this.snapshot(),result=mergeNativeFiles({base,source,target:current,archive:this.archive,prefix:'local/'+operation.id,resolutions});
    operation.replay={base,source,next_state:nextState};operation.local_resolutions=resolutions;
    if(result.unresolved.length)return this.writeConflicts(operation,result,'local_conflicts');
    operation.apply={before:current,desired:result.files,next_state:nextState,generation:(operation.apply?.generation??0)+1};operation.phase='applying';this.saveOperation(operation);return this.applyJournal(operation);
  }
  async applyJournal(operation){
    const saved=jsonFile(this.statePath);if(saved?.last_operation_id===operation.id){rmSync(this.operationPath,{force:true});rmSync(this.conflictsPath,{force:true});return saved;}
    safeDirectory(this.project);const apply=operation.apply,backupRoot=join(this.metadata,'history',operation.id,String(apply.generation),'before');safeDirectory(backupRoot);
    try{
      const paths=[...new Set([...Object.keys(apply.before),...Object.keys(apply.desired)])].sort((a,b)=>{
        const ad=!apply.desired[a],bd=!apply.desired[b];if(ad!==bd)return ad?-1:1;return ad?b.split('/').length-a.split('/').length||a.localeCompare(b):a.split('/').length-b.split('/').length||a.localeCompare(b);
      });
      for(const path of paths){
        const before=apply.before[path]??null,after=apply.desired[path]??null;if(same(before,after))continue;nativeSourcePath(path);const target=join(this.project,path),backup=join(backupRoot,hash(path)+'.source');safeParents(this.project,target);safeParents(backupRoot,backup);
        if(!before&&after&&existsSync(target)&&lstatSync(target).isDirectory()){try{rmdirSync(target);}catch{throw conflictError('本地目录仍有内容，不能替换为文件：'+path,{path});}}
        await this.hooks.beforeApplyFile?.({path,operation:operation.id});let current=entry(target),retained=entry(backup);
        if(before&&!retained){
          if(same(current,after))continue;
          if(!same(current,before))throw conflictError('写入前本地文件又发生变化：'+path,{path});
          renameSync(target,backup);retained=entry(backup);current=entry(target);
          if(!same(retained,before)){
            this.archive.put(readFileSync(backup));if(!current)copyFileSync(backup,target,constants.COPYFILE_EXCL);throw conflictError('文件在交接瞬间发生变化，已保留实际字节：'+path,{path,backup});
          }
        }
        if(retained&&!same(retained,before))throw conflictError('原文件在编辑器旧句柄中继续变化，备份已保留：'+path,{path,backup});
        if(!after){if(current)throw conflictError('删除交接后出现新本地文件，未覆盖：'+path,{path,backup});let parent=dirname(target);while(parent!==this.project){try{rmdirSync(parent);}catch{break;}parent=dirname(parent);}continue;}
        if(current){if(same(current,after))continue;throw conflictError('目标出现新的本地内容，未覆盖：'+path,{path,backup});}
        const temporary=target+'.wa-'+randomUUID()+'.tmp';writeFileSync(temporary,this.archive.read(after),{flag:'wx',mode:0o600});
        try{linkSync(temporary,target);}catch(error){if(error.code==='EEXIST')throw conflictError('文件在写入时被编辑器重新创建，未覆盖：'+path,{path,backup});throw error;}finally{unlinkSync(temporary);}
        await this.hooks.afterApplyFile?.({path,operation:operation.id});
      }
      const next={...apply.next_state,last_operation_id:operation.id};atomicJson(join(this.metadata,'history',operation.id,'applied.json'),{id:operation.id,kind:operation.kind,generation:apply.generation,before_files:apply.before,desired_files:apply.desired,base_revision:next.base_revision,backup_names:'sha256(relative source path).source'});atomicJson(this.statePath,next);rmSync(this.operationPath,{force:true});rmSync(this.conflictsPath,{force:true});this.log({stage:'workspace_ready',revision:next.base_revision,project:this.project});return next;
    }catch(error){if(error.code==='NATIVE_WORKSPACE_CONFLICT'){operation.phase='apply_changed';operation.apply_error=error.details;this.saveOperation(operation);}throw error;}
  }
  async synchronize({resolutions={},replan=false}={}){
    return this.lock(async()=>{
      let operation=jsonFile(this.operationPath);if(operation&&operation.kind!=='sync')return this.resumeLocked(operation,{resolutions,replan});const state=this.state(),api=this.api(state),route=this.route(state);
      if(operation&&['applying','apply_changed','local_conflicts'].includes(operation.phase))return this.resumeLocked(operation,{resolutions,replan});
      if(!operation){operation={id:randomUUID(),kind:'sync',phase:'upload',created_at:Date.now(),state,submitted_files:this.snapshot(),request_id:randomUUID(),resolutions:{}};this.saveOperation(operation);}
      operation.resolutions={...operation.resolutions,...resolutions};this.saveOperation(operation);
      if(!operation.upload_id){const prepared=await api(route+'/uploads',{method:'POST',body:{request_id:operation.request_id,base_revision:operation.state.base_revision,workspace_version:operation.state.workspace_version,files:operation.submitted_files,source_identity:nativeSourceIdentity(operation.submitted_files)}});operation.upload_id=prepared.upload_id;this.saveOperation(operation);}
      let upload=await api(route+'/uploads/'+operation.upload_id);
      if(upload.status!=='committed'){
        for(const entry of upload.missing){await api(route+'/uploads/'+operation.upload_id+'/blobs/'+entry.hash,{method:'PUT',body:this.archive.read(entry)});this.log({stage:'uploaded',bytes:entry.size});}
        let prepared;
        try{prepared=await api(route+'/uploads/'+operation.upload_id+'/prepare',{method:'POST',body:{resolutions:operation.resolutions,...(replan?{replan:true}:{})}});}
        catch(error){if(error.details?.code!=='native_merge_stale_plan')throw error;prepared=await api(route+'/uploads/'+operation.upload_id+'/prepare',{method:'POST',body:{resolutions:operation.resolutions,replan:true}});}
        if(prepared.status==='committed')upload=prepared;
        else{
        const preview=prepared.preview;operation.preview_id=preview.id;
        const validKeys=new Set(preview.conflicts.map(conflict=>conflict.key));operation.resolutions=Object.fromEntries(Object.entries(operation.resolutions).filter(([key])=>validKeys.has(key)));this.saveOperation(operation);
        const remote=await api(route+'?revision='+encodeURIComponent(preview.target_revision));await this.download(remote.files,api,route,'?revision='+encodeURIComponent(remote.revision));
        if(preview.external?.source_files)await this.download(preview.external.source_files,api,route,'?upload_id='+encodeURIComponent(operation.upload_id));
        if(preview.unresolved_count){operation.phase='remote_conflicts';operation.conflicts=preview.conflicts;this.saveOperation(operation);atomicJson(this.conflictsPath,{operation_id:operation.id,stage:operation.phase,conflicts:preview.conflicts,resolutions:operation.resolutions});throw conflictError('中央合并存在局部冲突；本地快照与工作文件保持不变。',{conflicts:this.conflictsPath});}
        operation.phase='committing';this.saveOperation(operation);upload=await api(route+'/uploads/'+operation.upload_id+'/commit',{method:'POST',body:{preview_id:preview.id,resolutions:operation.resolutions}});
        }
      }
      operation.server_snapshot=upload.snapshot;operation.server_result=upload.result;operation.phase='replaying';this.saveOperation(operation);await this.hooks.afterServerCommit?.({operation,upload});
      await this.download(upload.snapshot.files,api,route,'?upload_id='+encodeURIComponent(operation.upload_id));
      return this.planApply(operation,operation.submitted_files,upload.snapshot.files,this.stateFrom(upload.snapshot,state.server));
    });
  }
  async pull({resolutions={}}={}){
    const result=await this.lock(async()=>{
      let operation=jsonFile(this.operationPath);if(operation)return this.resumeLocked(operation,{resolutions});const state=this.state(),api=this.api(state),route=this.route(state),remote=await api(route);
      operation={id:randomUUID(),kind:'pull',phase:'pulling',created_at:Date.now(),state,server_snapshot:remote,request_id:randomUUID(),local_resolutions:resolutions};this.saveOperation(operation);return this.finishPull(operation,resolutions);
    });return result?.resume_sync?this.synchronize({resolutions}):result;
  }
  async finishPull(operation,resolutions={}){
    const {state}=operation,api=this.api(state),route=this.route(state),snapshot=operation.server_snapshot;await this.download(snapshot.files,api,route,'?revision='+encodeURIComponent(snapshot.revision));
    const current=this.snapshot(),result=mergeNativeFiles({base:state.base_files,source:snapshot.files,target:current,archive:this.archive,prefix:'local/'+operation.id,resolutions});
    operation.local_resolutions=resolutions;operation.replay={base:state.base_files,source:snapshot.files,next_state:this.stateFrom(snapshot,state.server)};
    if(result.unresolved.length)return this.writeConflicts(operation,result,'pull_conflicts');
    if(!operation.advanced){operation.advanced=await api(route+'/advance',{method:'POST',body:{request_id:operation.request_id,base_revision:snapshot.base_revision,workspace_version:snapshot.workspace_version,revision:snapshot.revision}});this.saveOperation(operation);}
    return this.planApply(operation,current,result.files,this.stateFrom(operation.advanced,state.server));
  }
  async resumeLocked(operation,{resolutions={},replan=false}={}){
    if(operation.phase==='applying')return this.applyJournal(operation);
    if(operation.phase==='apply_changed')return this.planApply(operation,operation.apply.before,operation.apply.desired,operation.apply.next_state,resolutions);
    if(operation.phase==='local_conflicts')return this.planApply(operation,operation.replay.base,operation.replay.source,operation.replay.next_state,{...operation.local_resolutions,...resolutions});
    if(operation.kind==='pull')return this.finishPull(operation,{...operation.local_resolutions,...resolutions});
    if(operation.kind==='checkout'){
      const api=this.api({server:operation.server});if(!operation.server_snapshot){operation.server_snapshot=await api('/creation-api/native-workspaces',{method:'POST',body:operation.request});this.saveOperation(operation);}const snapshot=operation.server_snapshot;await this.download(snapshot.files,api,this.route(snapshot),'?revision='+encodeURIComponent(snapshot.revision));if(!operation.runtime_cached){await this.cacheRuntime(snapshot,api);operation.runtime_cached=true;this.saveOperation(operation);}return this.planApply(operation,{},snapshot.files,this.stateFrom(snapshot,operation.server),resolutions);
    }
    if(operation.kind==='sync')return {resume_sync:true};
    throw Error('未知未完成工作区操作');
  }
  async recover(options={}){
    const result=await this.lock(async()=>{const operation=jsonFile(this.operationPath);if(!operation)return this.state();return this.resumeLocked(operation,options);});return result?.resume_sync?this.synchronize(options):result;
  }
  async abort(){return this.lock(async()=>{const operation=jsonFile(this.operationPath);if(!operation)return{aborted:false};if(operation.server_snapshot&&operation.kind==='sync'||operation.advanced||['applying','apply_changed','local_conflicts'].includes(operation.phase))throw Error('服务器已确认或本地正在回放，请 recover 完成，不能丢弃已提交回执');if(operation.upload_id){const state=this.state(),upload=await this.api(state)(this.route(state)+'/uploads/'+operation.upload_id);if(upload.status==='committed')throw Error('服务器已经提交，请 recover 取得原回执');}atomicJson(join(this.metadata,'history',operation.id,'aborted.json'),operation);rmSync(this.operationPath,{force:true});rmSync(this.conflictsPath,{force:true});return{aborted:true,local_files_preserved:true};});}
  status(){this.initialize();const state=this.state(),current=this.snapshot(),changes=[];for(const path of new Set([...Object.keys(state.base_files),...Object.keys(current)]))if(!same(state.base_files[path],current[path]))changes.push({path,kind:!state.base_files[path]?'add':!current[path]?'delete':'modify'});const operation=jsonFile(this.operationPath);return{workspace_id:state.workspace_id,project_id:state.project_id,branch_id:state.branch_id,base_revision:state.base_revision,changes,pending:operation?{id:operation.id,kind:operation.kind,phase:operation.phase}:null,source_directory:this.project,note:'只包含已落盘文件；编辑器尚未保存的缓冲区不在同步范围内。'};}
  conflicts({exportDirectory}={}){
    this.initialize();const record=jsonFile(this.conflictsPath);if(!record)throw Error('此工作区没有待处理冲突');if(exportDirectory){const output=resolve(exportDirectory);if(existsSync(output))throw Error('冲突导出目录已存在');safeDirectory(output);const resolutions={};record.conflicts.forEach((conflict,index)=>{const folder=join(output,String(index+1).padStart(3,'0'));safeDirectory(folder);atomicJson(join(folder,'conflict.json'),conflict);for(const side of ['base','source','target']){const value=conflict[side];if(typeof value==='string')writeFileSync(join(folder,side+'.txt'),value,{mode:0o600});else if(value?.hash)writeFileSync(join(folder,side+'.bin'),this.archive.read(value),{mode:0o600});}resolutions[conflict.key]=conflict.resolution??'';});atomicJson(join(output,'resolutions.json'),resolutions);return{...record,export_directory:output};}return record;
  }
  async refreshRuntime(){return this.lock(async()=>{if(jsonFile(this.operationPath))throw Error('请先恢复当前同步操作');const state=this.state(),runtime=await this.cacheRuntime({...state,revision:state.base_revision},this.api(state));return{runtime_id:runtime.runtime_id,assembler:runtime.policy.sha256,engine:runtime.engine,offline_ready:true};});}
  async preparePlay({godotPath}={}){return this.lock(async()=>{if(jsonFile(this.operationPath))throw Error('请先恢复当前同步操作');const state=this.state(),descriptor=jsonFile(join(this.metadata,'runtime.json'));if(!descriptor)throw Error('工作区缺少固定运行支持，请先联网执行 refresh-runtime');return prepareNativeOfflinePlay({state,files:this.snapshot(),archive:this.archive,metadata:this.metadata,descriptor,godotPath,log:this.log});});}
}
