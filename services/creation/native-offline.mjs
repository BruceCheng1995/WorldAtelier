import {mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {clone,fail,hash,id,identifier,stable} from './schema.mjs';
import {NATIVE_LIMITS,NATIVE_SCHEMA,nativeFileMap,nativeSourceIdentity} from './native-source.mjs';
import {snapshotProjectRuntime,assembleProject,gameStorage,GAME_PROJECT_CONTRACT} from './project-snapshot.mjs';
import {nativeOfflinePolicy} from './native-offline-policy.mjs';

const WORKSPACE='creator_native_workspace',UPLOAD='creator_native_workspace_upload',ADVANCE='creator_native_workspace_advance',RUNTIME='creator_native_workspace_runtime';
const same=(a,b)=>a?.hash===b?.hash&&a?.size===b?.size;
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function read(req,max=NATIVE_LIMITS.fileBytes,raw=false){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'离线工作区请求过大');chunks.push(chunk);}const bytes=Buffer.concat(chunks);if(raw)return bytes;try{return bytes.length?JSON.parse(bytes):{};}catch{fail(400,'JSON 格式无效');}}

/** Registered user workspaces, distinct from Agent sessions and leases.
 * A blob's existence is never authorization to read or submit it. */
export class NativeOffline{
  constructor({service}){this.service=service;this.store=service.store;this.native=service.native;this.merges=service.nativeMerges;this.preparing=new Map();this.committing=new Map();this.directory=resolve(service.data,'native-workspaces');mkdirSync(this.directory,{recursive:true});}
  fixed(workspace,revision){
    const fixed=this.store.get('creator_revision',revision);
    if(!fixed||fixed.project_id!==workspace.project_id||fixed.manifest.schema!==NATIVE_SCHEMA)fail(409,'工作区需要此项目的固定原生源版本');
    const files=nativeFileMap(fixed.manifest.source_files);if(nativeSourceIdentity(files)!==fixed.manifest.source_identity)fail(409,'工作区源身份不一致');return fixed;
  }
  workspace(user,workspaceId){
    if(this.closing)fail(503,'离线工作区服务正在关闭');
    const workspace=this.store.get(WORKSPACE,workspaceId);if(!workspace||workspace.owner_user_id!==user.id)fail(404,'原生工作区不存在');
    this.store.branchFor(user,workspace.project_id,workspace.branch_id,true);if(workspace.revoked_at)fail(403,'此原生工作区已撤销');return workspace;
  }
  uploadFor(user,workspaceId,uploadId){
    const workspace=this.workspace(user,workspaceId),upload=this.store.get(UPLOAD,uploadId);
    if(!upload||upload.workspace_id!==workspace.id||upload.owner_user_id!==user.id)fail(404,'工作区上传不存在');return {workspace,upload};
  }
  assertBaseline(workspace,upload){if(workspace.version!==upload.workspace_version||workspace.base_revision!==upload.base_revision)fail(409,'此工作区已在另一处同步，请恢复原操作或重新拉取基线',{code:'native_workspace_moved',workspace_version:workspace.version,base_revision:workspace.base_revision});}
  snapshot(workspace,revision=workspace.base_revision){const fixed=this.fixed(workspace,revision);return{workspace_id:workspace.id,project_id:workspace.project_id,branch_id:workspace.branch_id,workspace_version:workspace.version,base_revision:workspace.base_revision,revision:fixed.id,source_identity:fixed.manifest.source_identity,files:clone(fixed.manifest.source_files),schema:NATIVE_SCHEMA,storage:{source:'project/',local:'outside_project',progress:'not_uploaded',shared_world:'server_authority'},created_at:workspace.created_at};}
  create(user,input){
    identifier(input.request_id,'工作区请求 ID');const branch=this.store.branchFor(user,input.project_id,input.branch_id??'main',true),revision=input.revision??branch.head;
    const fingerprint=hash({project_id:branch.project_id,branch_id:branch.branch_id,revision:input.revision??null}),key='workspace-'+hash({user_id:user.id,request_id:input.request_id}),old=this.store.get(WORKSPACE,key);
    if(old){this.workspace(user,key);if(old.fingerprint!==fingerprint)fail(409,'同一工作区请求不能改变参数');return this.snapshot(old);}
    if(!this.store.ancestor(revision,branch.head))fail(409,'工作区基线不属于此分支');
    const workspace={id:key,owner_user_id:user.id,project_id:branch.project_id,branch_id:branch.branch_id,base_revision:revision,initial_revision:revision,version:1,created_at:Date.now(),fingerprint};this.fixed(workspace,revision);this.store.put(WORKSPACE,workspace);return this.snapshot(workspace);
  }
  list(user,input={}){return this.store.list(WORKSPACE).filter(workspace=>workspace.owner_user_id===user.id&&!workspace.revoked_at&&(!input.project_id||workspace.project_id===input.project_id)).flatMap(workspace=>{try{this.workspace(user,workspace.id);return[{workspace_id:workspace.id,project_id:workspace.project_id,branch_id:workspace.branch_id,base_revision:workspace.base_revision,workspace_version:workspace.version,created_at:workspace.created_at}];}catch{return[];}});}
  view(user,workspaceId,{revision}={}){
    const workspace=this.workspace(user,workspaceId),branch=this.store.branchFor(user,workspace.project_id,workspace.branch_id,true),requested=revision??branch.head;
    if(requested!==workspace.base_revision&&requested!==workspace.initial_revision&&!this.store.ancestor(requested,branch.head))fail(409,'请选择当前分支可达的固定源版本');return this.snapshot(workspace,requested);
  }
  revoke(user,workspaceId){const workspace=this.workspace(user,workspaceId);workspace.revoked_at=Date.now();this.store.put(WORKSPACE,workspace);return {workspace_id:workspace.id,revoked:true};}
  beginUpload(user,workspaceId,input){
    identifier(input.request_id,'上传请求 ID');const workspace=this.workspace(user,workspaceId),files=nativeFileMap(input.files),source_identity=nativeSourceIdentity(files);
    if(input.source_identity!==undefined&&input.source_identity!==source_identity)fail(409,'本地快照身份不一致');
    const fingerprint=hash({base_revision:input.base_revision,workspace_version:input.workspace_version,files}),key='upload-'+hash({workspace_id:workspaceId,request_id:input.request_id}),old=this.store.get(UPLOAD,key);
    if(old){if(old.fingerprint!==fingerprint)fail(409,'同一上传请求不能改变本地快照');return this.uploadView(user,workspaceId,key);}
    const upload={id:key,workspace_id:workspace.id,owner_user_id:user.id,request_id:input.request_id,base_revision:input.base_revision,workspace_version:input.workspace_version,source_files:files,source_identity,fingerprint,status:'uploading',created_at:Date.now(),received:{},accepted:{}};
    this.assertBaseline(workspace,upload);const branch=this.store.branchFor(user,workspace.project_id,workspace.branch_id,true);
    if(!this.store.ancestor(upload.base_revision,branch.head))fail(409,'工作区基线不再属于目标分支，请保留本地内容并明确导入',{code:'native_merge_unrelated_workspace'});
    // Only files already readable through this workspace/project, never any
    // globally existing digest supplied by the caller, can skip upload.
    const known=new Map([workspace.base_revision,branch.head].flatMap(revision=>Object.values(this.fixed(workspace,revision).manifest.source_files).map(entry=>[entry.hash,entry])));
    for(const entry of Object.values(files))if(same(known.get(entry.hash),entry))upload.accepted[entry.hash]=entry;
    this.store.put(UPLOAD,upload);return this.uploadView(user,workspaceId,key);
  }
  missing(upload){return [...new Map(Object.values(upload.source_files).filter(entry=>!same(upload.accepted[entry.hash]??upload.received[entry.hash],entry)).map(entry=>[entry.hash,entry])).values()];}
  uploadView(user,workspaceId,uploadId){const {upload}=this.uploadFor(user,workspaceId,uploadId);return{upload_id:upload.id,workspace_id:workspaceId,status:upload.status,base_revision:upload.base_revision,workspace_version:upload.workspace_version,source_identity:upload.source_identity,missing:this.missing(upload),...(upload.preview_id?{preview_id:upload.preview_id}:{}),...(upload.result?{result:clone(upload.result),snapshot:clone(upload.result_snapshot)}:{}),...(upload.normalized_files?{normalized_source_identity:nativeSourceIdentity(upload.normalized_files)}:{})};}
  putBlob(user,workspaceId,uploadId,digest,bytes){
    const {workspace,upload}=this.uploadFor(user,workspaceId,uploadId);this.assertBaseline(workspace,upload);
    if(upload.status==='committed')fail(409,'上传已提交');const expected=Object.values(upload.source_files).find(entry=>entry.hash===digest);
    if(!expected||bytes.length!==expected.size||hash(bytes)!==digest)fail(422,'上传字节与固定本地快照不一致');
    const entry=this.native.archive.put(bytes);upload.received[digest]=entry;this.store.put(UPLOAD,upload);return{hash:digest,size:entry.size,remaining:this.missing(upload).length};
  }
  blob(user,workspaceId,digest,{revision,upload_id,runtime_id}={}){
    const workspace=this.workspace(user,workspaceId);let entries;
    if(runtime_id){const runtime=this.store.get(RUNTIME,runtime_id);if(!runtime||runtime.workspace_id!==workspaceId)fail(404,'工作区固定运行工程不存在');entries=[...Object.values(runtime.files),...Object.values(runtime.template_files??{}),...Object.values(runtime.adapter_files??{})];}
    else if(upload_id){const {upload}=this.uploadFor(user,workspaceId,upload_id);entries=[...Object.values(upload.accepted),...Object.values(upload.received),...Object.values(upload.normalized_files??{}),...Object.values(upload.result_snapshot?.files??{})];}
    else{const snapshot=this.view(user,workspaceId,{revision});entries=Object.values(snapshot.files);}
    const entry=entries.find(entry=>entry.hash===digest);if(!entry)fail(403,'此文件不属于已授权的固定工作区');return this.native.archive.read(entry);
  }
  async normalize(workspace,upload){
    const files=nativeFileMap(upload.source_files);this.native.archive.verify(files);
    const work=mkdtempSync(join(this.directory,'normalize-')),directory=join(work,'project');
    try{
      if(this.native.indexDirectory){this.native.archive.materialize(files,directory);return await this.native.indexDirectory(directory,{assignIds:true,previousFiles:this.fixed(workspace,upload.base_revision).manifest.source_files});}
      return await this.native.inspectFiles(files,{assignIds:true,previousFiles:this.fixed(workspace,upload.base_revision).manifest.source_files});
    }finally{rmSync(work,{recursive:true,force:true});}
  }
  prepare(user,workspaceId,uploadId,input={}){
    this.uploadFor(user,workspaceId,uploadId);const key=workspaceId+'/'+uploadId,fingerprint=hash(input),existing=this.preparing.get(key);if(existing){if(existing.fingerprint!==fingerprint)fail(409,'工作区正在准备另一份冲突决议');return existing.promise;}
    const task=this.prepareOnce(user,workspaceId,uploadId,input).finally(()=>this.preparing.delete(key));this.preparing.set(key,{fingerprint,promise:task});return task;
  }
  async prepareOnce(user,workspaceId,uploadId,input){
    let {workspace,upload}=this.uploadFor(user,workspaceId,uploadId);if(upload.status==='committed')return this.uploadView(user,workspaceId,uploadId);this.assertBaseline(workspace,upload);
    const missing=this.missing(upload);if(missing.length)fail(409,'请先补齐固定快照的缺失文件',{code:'native_workspace_missing_blobs',missing});
    if(!upload.normalized_files){
      const manifest=await this.normalize(workspace,upload);({workspace,upload}=this.uploadFor(user,workspaceId,uploadId));this.assertBaseline(workspace,upload);
      if(manifest.schema!==NATIVE_SCHEMA||manifest.source_identity!==nativeSourceIdentity(manifest.source_files))fail(500,'规范化源身份不一致');
      upload.normalized_files=manifest.source_files;upload.normalized_at=Date.now();this.store.put(UPLOAD,upload);
    }
    let preview=upload.preview_id&&this.store.get('creator_merge_preview',upload.preview_id);
    if(!preview||input.replan===true){
      preview=this.merges.externalPreview(user,workspace.project_id,workspace.branch_id,{base_revision:upload.base_revision,source_files:upload.normalized_files,workspace_id:workspace.id,request_id:upload.request_id});
      upload.preview_id=preview.id;upload.status='prepared';this.store.put(UPLOAD,upload);
    }
    const review=this.merges.review(user,workspace.project_id,workspace.branch_id,{preview_id:preview.id,resolutions:input.resolutions??{}});
    return {...this.uploadView(user,workspaceId,uploadId),preview:review};
  }
  commit(user,workspaceId,uploadId,input={}){
    this.uploadFor(user,workspaceId,uploadId);const key=workspaceId+'/'+uploadId,fingerprint=hash(input),existing=this.committing.get(key);if(existing){if(existing.fingerprint!==fingerprint)fail(409,'工作区正在提交另一份冲突决议');return existing.promise;}
    const task=this.commitOnce(user,workspaceId,uploadId,input).finally(()=>this.committing.delete(key));this.committing.set(key,{fingerprint,promise:task});return task;
  }
  async commitOnce(user,workspaceId,uploadId,input={}){
    let {workspace,upload}=this.uploadFor(user,workspaceId,uploadId);const fingerprint=hash({resolutions:input.resolutions??{},preview_id:input.preview_id??upload.preview_id});
    if(upload.status==='committed'){if(upload.commit_fingerprint!==fingerprint)fail(409,'同一上传提交不能改变冲突决议');return{...this.uploadView(user,workspaceId,uploadId),replayed:true};}
    this.assertBaseline(workspace,upload);if(!upload.preview_id||input.preview_id&&input.preview_id!==upload.preview_id)fail(409,'请先准备并核对当前上传的合并计划');
    const guard=()=>{({workspace,upload}=this.uploadFor(user,workspaceId,uploadId));this.assertBaseline(workspace,upload);if(upload.status==='committed')fail(409,'上传已经由另一提交完成，请查询原回执');};
    const result=await this.merges.merge(user,workspace.project_id,workspace.branch_id,{preview_id:upload.preview_id,resolutions:input.resolutions??{}},null,{allowWorkspace:true,guard,onCommit:committed=>{
      upload.status='committed';upload.result=clone(committed);upload.commit_fingerprint=fingerprint;upload.committed_at=Date.now();workspace.base_revision=committed.revision;workspace.version++;workspace.updated_at=Date.now();upload.result_snapshot=this.snapshot(workspace);this.store.put(UPLOAD,upload);this.store.put(WORKSPACE,workspace);
    }});
    if(!result.replayed&&!result.unchanged){this.service.realtime?.committed(workspace.project_id,workspace.branch_id,result);this.service.agent?.publicState(workspace.project_id,workspace.branch_id);}
    return this.uploadView(user,workspaceId,uploadId);
  }
  advance(user,workspaceId,input){
    identifier(input.request_id,'基线同步请求 ID');const workspace=this.workspace(user,workspaceId),key='advance-'+hash({workspace_id:workspaceId,request_id:input.request_id}),fingerprint=hash({base_revision:input.base_revision,workspace_version:input.workspace_version,revision:input.revision}),old=this.store.get(ADVANCE,key);
    if(old){if(old.fingerprint!==fingerprint)fail(409,'同一基线请求不能改变参数');return{...clone(old.result),replayed:true};}
    this.assertBaseline(workspace,{base_revision:input.base_revision,workspace_version:input.workspace_version});const branch=this.store.branchFor(user,workspace.project_id,workspace.branch_id,true);
    if(!this.store.ancestor(input.revision,branch.head)||!this.store.ancestor(workspace.base_revision,input.revision))fail(409,'拉取目标不属于此工作区的前向历史');this.fixed(workspace,input.revision);
    return this.store.transaction(()=>{const current=this.workspace(user,workspaceId);this.assertBaseline(current,{base_revision:input.base_revision,workspace_version:input.workspace_version});current.base_revision=input.revision;current.version++;current.updated_at=Date.now();this.store.put(WORKSPACE,current);const result=this.snapshot(current);this.store.put(ADVANCE,{id:key,workspace_id:workspaceId,fingerprint,result,created_at:Date.now()});return result;});
  }
  async runtime(user,workspaceId,input={}){
    const workspace=this.workspace(user,workspaceId),snapshot=this.view(user,workspaceId,{revision:input.revision}),work=mkdtempSync(join(this.directory,'runtime-')),directory=join(work,'project');
    try{
      const policy=nativeOfflinePolicy(this.service.root),runtime=snapshotProjectRuntime(this.service.root,directory),template_files=this.native.archive.capture(directory),adapter_files={'adapter.gd':this.native.archive.put(readFileSync(join(this.service.root,'tools/native-scene/adapter.gd')))},storage={...gameStorage(this.service,workspace.project_id,workspace.branch_id),namespace:'WorldAtelier-offline-'+workspace.id};
      const enginePath=this.native.godotPath??this.service.builds?.godot??'/Applications/Godot.app/Contents/MacOS/Godot',engineBytes=existsSync(enginePath)?readFileSync(enginePath):null,engine=engineBytes?{hash:hash(engineBytes),size:engineBytes.length}:null;
      await assembleProject({service:this.service,user,project_id:workspace.project_id,branch_id:workspace.branch_id,revision:snapshot.revision,directory,runtime_source_hash:runtime.hash,storage,purpose:'authoring'});this.workspace(user,workspaceId);
      if(nativeOfflinePolicy(this.service.root).sha256!==policy.sha256)fail(409,'准备期间离线装配器源码变化，请重试');
      const files=this.native.archive.capture(directory),runtimeId='workspace-runtime-'+hash({workspace_id:workspaceId,revision:snapshot.revision,source_identity:snapshot.source_identity,runtime_hash:runtime.hash,policy:policy.sha256,engine,files});
      const record={id:runtimeId,workspace_id:workspaceId,project_name:this.store.projectFor(user,workspace.project_id).name,revision:snapshot.revision,source_identity:snapshot.source_identity,runtime_hash:runtime.hash,files,template_files,adapter_files,policy,engine,contract:GAME_PROJECT_CONTRACT,storage,created_at:Date.now()};this.store.put(RUNTIME,record);return{runtime_id:runtimeId,...record,entry:'res://atelier_runtime/standalone.tscn',source_submission:false};
    }finally{rmSync(work,{recursive:true,force:true});}
  }
  async request(user,req,res,url){
    const parts=url.pathname.slice('/creation-api/'.length).split('/').map(decodeURIComponent);if(parts[0]!=='native-workspaces')return false;
    const [,workspaceId,action,uploadId,operation,digest]=parts,method=req.method;
    if(workspaceId==='client.mjs'&&!action&&method==='GET'){
      const policy=nativeOfflinePolicy(this.service.root),{build}=await import('esbuild'),result=await build({entryPoints:[join(this.service.root,'tools/native-workspace-cli.mjs')],bundle:true,platform:'node',format:'esm',target:'node24',write:false,logLevel:'silent',banner:{js:'globalThis.__WA_NATIVE_OFFLINE_POLICY__ = '+JSON.stringify(policy.sha256)+';'}});
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="world-atelier-native-workspace.mjs"'});res.end(result.outputFiles[0].contents);return true;
    }
    if(!workspaceId&&method==='POST'){json(res,201,this.create(user,await read(req,8*1024*1024)));return true;}
    if(!workspaceId&&method==='GET'){json(res,200,{workspaces:this.list(user,Object.fromEntries(url.searchParams))});return true;}
    if(workspaceId&&!action&&method==='GET'){json(res,200,this.view(user,workspaceId,Object.fromEntries(url.searchParams)));return true;}
    if(workspaceId&&!action&&method==='DELETE'){json(res,200,this.revoke(user,workspaceId));return true;}
    if(action==='blobs'&&uploadId&&['GET','HEAD'].includes(method)){const bytes=this.blob(user,workspaceId,uploadId,Object.fromEntries(url.searchParams));res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'private, no-store','ETag':'"'+uploadId+'"'});res.end(method==='HEAD'?undefined:bytes);return true;}
    if(action==='uploads'&&!uploadId&&method==='POST'){json(res,201,this.beginUpload(user,workspaceId,await read(req,8*1024*1024)));return true;}
    if(action==='uploads'&&uploadId&&!operation&&method==='GET'){json(res,200,this.uploadView(user,workspaceId,uploadId));return true;}
    if(action==='uploads'&&operation==='blobs'&&digest&&method==='PUT'){this.uploadFor(user,workspaceId,uploadId);json(res,200,this.putBlob(user,workspaceId,uploadId,digest,await read(req,NATIVE_LIMITS.fileBytes,true)));return true;}
    if(action==='uploads'&&operation==='prepare'&&method==='POST'){json(res,200,await this.prepare(user,workspaceId,uploadId,await read(req,8*1024*1024)));return true;}
    if(action==='uploads'&&operation==='commit'&&method==='POST'){json(res,200,await this.commit(user,workspaceId,uploadId,await read(req,8*1024*1024)));return true;}
    if(action==='advance'&&method==='POST'){json(res,200,this.advance(user,workspaceId,await read(req,8*1024*1024)));return true;}
    if(action==='runtime'&&method==='POST'){json(res,200,await this.runtime(user,workspaceId,await read(req,8*1024*1024)));return true;}
    fail(404,'原生工作区接口不存在');
  }
  async close(){this.closing=true;await Promise.allSettled([...this.preparing.values(),...this.committing.values()].map(item=>item.promise));}
}
