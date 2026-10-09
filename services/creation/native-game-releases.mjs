import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {clone,fail,hash,identifier} from './schema.mjs';
import {NATIVE_SCHEMA,nativeSourceIdentity} from './native-source.mjs';
import {GAME_PROJECT_CONTRACT} from './project-snapshot.mjs';
import {CANONICAL_WEB_POLICY} from '../../tools/canonical-game-web.mjs';
import {isPrefabTest} from './prefab-tests.mjs';

export const NATIVE_GAME_RELEASE_FORMAT='world-atelier-native-game-release-v1';
const RELEASE='creator_native_game_release',POINTER='creator_native_game_pointer',REQUEST='creator_native_game_release_request';
const WEB_POLICY='world-atelier-single-thread-local-http-v1',digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const entryValid=file=>file&&typeof file.path==='string'&&/^[\w.-]+$/.test(file.path)&&!['.','..'].includes(file.path)&&digest(file.sha256)&&Number.isSafeInteger(file.size)&&file.size>=0;
const pointerId=(p,b,entry)=>hash({project_id:p,branch_id:b,entry_scene_id:entry});
const editor=role=>['owner','editor'].includes(role);
const newestPointer=(a,b)=>(b.publication_sequence??0)-(a.publication_sequence??0)||b.updated_at-a.updated_at||b.id.localeCompare(a.id);

/** Independent game publication. Finished builds never write these records.
 * Source heads, previous releases and shared world releases are not mutated. */
export class NativeGameReleases {
  constructor({service}){this.service=service;this.store=service.store;this.directory=resolve(service.data,'builds');this.verifiedFiles=new Map();}
  pointer(p,b,entry){return this.store.get(POINTER,pointerId(p,b,entry));}
  buildSnapshot(job,p,b,sourceRevision,entry,{reachable=true,branch=null}={}){
    if(!job||job.project_id!==p||job.branch_id!==b||job.source_revision!==sourceRevision||job.entry_scene_id!==entry)fail(409,'构建与所选项目、源版本或入口不一致');
    if(job.status!=='completed'||job.kind!=='application'||job.purpose&&job.purpose!=='play'||job.game_project_contract!==GAME_PROJECT_CONTRACT||!job.target_results?.some(result=>result.target==='web'&&result.status==='completed'))fail(422,'请先完成真实游戏的 Web 构建',{code:'native_game_build_not_publishable'});
    if(this.store.revisionMeta(sourceRevision)?.schema!==NATIVE_SCHEMA)fail(422,'发行需要已固定的原生游戏场景');
    const fixed=this.store.readRevision(sourceRevision),manifest=fixed?.manifest;
    if(isPrefabTest(manifest?.resources?.[entry]))fail(422,'能力预览场景不能发布为游戏');
    if(fixed?.project_id!==p||manifest?.schema!==NATIVE_SCHEMA||manifest.resources?.[entry]?.kind!=='scene'||manifest.source_identity!==nativeSourceIdentity(manifest.source_files))fail(422,'发行需要已固定的原生游戏场景');
    if(reachable&&!this.store.ancestor(sourceRevision,(branch??this.store.get('creator_branch',p+':'+b))?.head))fail(409,'发行源版本不属于此分支');
    const identity=job.game_identity,{content_key,...identityInput}=identity??{};
    if(!digest(content_key)||content_key!==job.canonical_identity||content_key!==job.content_key||hash(identityInput)!==content_key||identity.contract!==GAME_PROJECT_CONTRACT||identity.project_id!==p||identity.branch_id!==b||identity.source_revision!==sourceRevision||identity.entry_scene_id!==entry||identity.runtime_source_hash!==job.runtime_source_hash)fail(409,'固定游戏构建身份不完整或已变化');
    if(job.canonical_web?.policy!==CANONICAL_WEB_POLICY||job.canonical_web.content_key!==content_key||job.web_compatibility?.policy!==WEB_POLICY)fail(422,'构建没有统一游戏 Web 启动记录');
    const files=clone(job.web_files??[]).sort((a,b)=>String(a.path).localeCompare(String(b.path))),paths=new Set(files.map(file=>file.path));
    if(!files.length||files.length>1000||files.some(file=>!entryValid(file))||paths.size!==files.length||['index.html','index.js','index.pck','index.wasm'].some(path=>!paths.has(path)))fail(409,'Web 构建缺少完整固定文件清单');
    if(files.find(file=>file.path==='index.html').sha256!==job.canonical_web.adapted_html_sha256)fail(409,'Web 入口与统一启动记录不一致');
    const artifact=job.artifacts?.find(artifact=>artifact.target==='web');
    if(!artifact||!entryValid({path:artifact.filename,sha256:artifact.sha256,size:artifact.size}))fail(409,'Web 构建缺少固定下载产物');
    const sourcePaths=new Set((job.source_files??[]).map(file=>file.path));
    if(['project.godot','atelier_runtime/standalone.gd','atelier_runtime/standalone.tscn','atelier_runtime/release.json','atelier_runtime/source-manifest.json'].some(path=>!sourcePaths.has(path))||!job.runtime_sources?.length||!digest(job.runtime_source_hash))fail(409,'构建没有完整固定游戏工程输入');
    return {build_id:job.id,source_revision:sourceRevision,source_identity:manifest.source_identity,entry_scene_id:entry,entry_scene_name:manifest.resources[entry].name,canonical_identity:content_key,game_project_contract:GAME_PROJECT_CONTRACT,runtime_source_hash:job.runtime_source_hash,source_files_hash:hash(job.source_files),runtime_sources_hash:hash(job.runtime_sources),web_files:files,web_artifact:{id:artifact.id,filename:artifact.filename,sha256:artifact.sha256,size:artifact.size},canonical_web:clone(job.canonical_web),web_compatibility:clone(job.web_compatibility)};
  }
  verifyFile(path,entry){
    try{
      const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==entry.size)throw Error('file shape');
      const key=[path,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,entry.sha256].join(':');
      if(!this.verifiedFiles.has(key)){
        const bytes=readFileSync(path),after=lstatSync(path);
        if(hash(bytes)!==entry.sha256||[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].some((value,i)=>value!==[after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs][i]))throw Error('file changed');
        if(this.verifiedFiles.size>=256)this.verifiedFiles.clear();this.verifiedFiles.set(key,true);
      }
    }catch{fail(409,'发行构建文件缺失、已变化或不是固定普通文件',{path:entry.path??entry.filename});}
  }
  verifyBytes(snapshot){
    identifier(snapshot.build_id,'构建 ID');
    const base=join(this.directory,snapshot.build_id),web=join(base,'web');
    try{for(const path of [this.directory,base,web])if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())throw Error('directory shape');if(!realpathSync(web).startsWith(realpathSync(this.directory)+sep))throw Error('outside build');}catch{fail(409,'发行构建目录缺失或不是固定目录');}
    for(const entry of snapshot.web_files)this.verifyFile(join(web,entry.path),entry);
    this.verifyFile(join(base,snapshot.web_artifact.filename),snapshot.web_artifact);
  }
  view(release){if(!release)return null;const {web_files,web_artifact,canonical_web,web_compatibility,source_files_hash,runtime_sources_hash,...result}=clone(release);return result;}
  published(user,p,b,entry=null){
    this.store.branchFor(user,p,b);
    const pointer=entry==null?this.store.list(POINTER).filter(pointer=>pointer.project_id===p&&pointer.branch_id===b).sort(newestPointer)[0]:this.pointer(p,b,entry);
    if(!pointer)return null;entry=pointer.entry_scene_id;
    const release=this.store.get(RELEASE,pointer.release_id);
    if(!release||pointer.project_id!==p||pointer.branch_id!==b||release.project_id!==p||release.branch_id!==b||release.entry_scene_id!==entry||pointer.publication_sequence!==release.publication_sequence||pointer.version!==hash({release_id:release.id,build_snapshot_hash:release.build_snapshot_hash,previous_version:pointer.previous_version}))fail(409,'试玩发行指针不完整');
    const snapshot=this.buildSnapshot(this.store.get('creator_build',release.build_id),p,b,release.source_revision,entry,{reachable:false});
    if(hash(snapshot)!==release.build_snapshot_hash||hash(Object.fromEntries(Object.keys(snapshot).map(key=>[key,release[key]])))!==release.build_snapshot_hash)fail(409,'已发行构建与固定发行记录不一致');this.verifyBytes(snapshot);
    return {source_revision:release.source_revision,source_identity:release.source_identity,resource_id:entry,game_build_id:release.build_id,canonical_identity:release.canonical_identity,game_release_id:release.id,pointer_version:pointer.version};
  }
  authorizeBuild(user,job){
    const release=this.published(user,job.project_id,job.branch_id,job.entry_scene_id);
    if(!release||release.game_build_id!==job.id)fail(403,'此构建不是当前已发布的试玩版本');return release;
  }
  authorizeSource(user,p,b,revision){
    this.store.branchFor(user,p,b);
    for(const pointer of this.store.list(POINTER)){
      if(pointer.project_id!==p||pointer.branch_id!==b)continue;
      const fixed=this.store.get(RELEASE,pointer.release_id);
      if(fixed?.source_revision===revision)return this.published(user,p,b,pointer.entry_scene_id);
    }
    fail(403,'此固定源版本不是当前已发布的试玩版本');
  }
  list(user,p,b){
    const branch=this.store.branchFor(user,p,b),project=this.store.projectFor(user,p),canPublish=editor(this.store.roleFor(user,project));
    const pointers=this.store.list(POINTER).filter(pointer=>pointer.project_id===p&&pointer.branch_id===b).sort((a,b)=>a.entry_scene_id.localeCompare(b.entry_scene_id));
    if(!canPublish)for(const pointer of pointers)this.published(user,p,b,pointer.entry_scene_id);
    const currentIds=new Set(pointers.map(pointer=>pointer.release_id));
    const releases=this.store.list(RELEASE).filter(release=>release.project_id===p&&release.branch_id===b&&(canPublish||currentIds.has(release.id))).sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id)).map(release=>this.view(release));
    const publishable_build_ids=canPublish?this.store.list('creator_build').filter(job=>job.project_id===p&&job.branch_id===b).filter(job=>{try{this.buildSnapshot(job,p,b,job.source_revision,job.entry_scene_id,{branch});return true;}catch{return false;}}).map(job=>job.id):[];
    return {project_id:p,branch_id:b,native_source:this.store.revisionMeta(branch.head)?.schema===NATIVE_SCHEMA,can_publish:canPublish,pointers,releases,publishable_build_ids};
  }
  publish(user,p,b,input){
    this.store.branchFor(user,p,b,true);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['request_id','build_id','source_revision','entry_scene_id','expected_pointer_version'].includes(key)))fail(400,'试玩发行请求格式无效');
    for(const [key,label]of [['request_id','请求 ID'],['build_id','构建 ID'],['source_revision','源版本'],['entry_scene_id','入口场景']])identifier(input[key],label);
    if(!Object.hasOwn(input,'expected_pointer_version')||input.expected_pointer_version!==null&&!digest(input.expected_pointer_version))fail(400,'请提供当前试玩发行指针版本');
    const requestKey=hash({p,b,user_id:user.id,request_id:input.request_id}),fingerprint=hash({p,b,user_id:user.id,input});
    const replay=()=>{const receipt=this.store.get(REQUEST,requestKey);if(!receipt)return null;if(receipt.fingerprint!==fingerprint)fail(409,'同一请求 ID 不能修改发行参数');return {...clone(receipt.result),replayed:true};};
    const previous=replay();if(previous)return previous;
    const snapshot=this.buildSnapshot(this.store.get('creator_build',input.build_id),p,b,input.source_revision,input.entry_scene_id);this.verifyBytes(snapshot);
    return this.store.transaction(()=>{
      const branch=this.store.branchFor(user,p,b,true),repeated=replay();if(repeated)return repeated;
      const currentSnapshot=this.buildSnapshot(this.store.get('creator_build',input.build_id),p,b,input.source_revision,input.entry_scene_id,{branch});
      if(hash(currentSnapshot)!==hash(snapshot))fail(409,'发布准备期间构建记录已变化');this.verifyBytes(snapshot);
      const current=this.pointer(p,b,input.entry_scene_id);if((current?.version??null)!==input.expected_pointer_version)fail(409,'试玩发行已被更新，请刷新后重新发布',{code:'native_game_release_conflict',current_pointer:current});
      const publication_sequence=1+this.store.list(RELEASE).filter(release=>release.project_id===p&&release.branch_id===b).reduce((latest,release)=>Math.max(latest,release.publication_sequence??0),0);
      const now=Date.now(),release={format:NATIVE_GAME_RELEASE_FORMAT,id:'game-release-'+requestKey.slice(0,48),project_id:p,branch_id:b,...snapshot,build_snapshot_hash:hash(snapshot),previous_release_id:current?.release_id??null,published_by:user.id,publication_sequence,created_at:now};
      const pointer={id:pointerId(p,b,input.entry_scene_id),project_id:p,branch_id:b,entry_scene_id:input.entry_scene_id,release_id:release.id,previous_version:current?.version??null,publication_sequence,updated_at:now};
      pointer.version=hash({release_id:release.id,build_snapshot_hash:release.build_snapshot_hash,previous_version:pointer.previous_version});
      const result={release:this.view(release),pointer:clone(pointer),replayed:false};
      this.store.put(RELEASE,release);this.store.put(POINTER,pointer);this.store.put(REQUEST,{id:requestKey,project_id:p,branch_id:b,user_id:user.id,request_id:input.request_id,fingerprint,result:clone(result),created_at:now});
      this.store.event(p,{type:'native_game_release_published',branch_id:b,entry_scene_id:input.entry_scene_id,release_id:release.id,build_id:input.build_id,source_revision:input.source_revision,actor_id:user.id});return result;
    });
  }
}
