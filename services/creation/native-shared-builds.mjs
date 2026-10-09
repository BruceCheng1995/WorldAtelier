import {join} from 'node:path';
import {rm} from 'node:fs/promises';
import {fail,hash,id,identifier} from './schema.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';

const active=job=>['queued','running'].includes(job.status);
export function prepareNativeSharedBuild(builds,user,p,b,input={}){
  if(builds.closing)fail(503,'构建服务正在关闭');
  const branch=builds.store.branchFor(user,p,b,true),revision=input.source_revision??branch.head;
  const fixed=builds.store.get('creator_revision',revision),entry=input.entry_scene_id??fixed?.manifest.entry_scene_id;
  if(!fixed||fixed.project_id!==p||fixed.manifest.schema!==NATIVE_SCHEMA||fixed.manifest.resources[entry]?.kind!=='scene'||fixed.manifest.resources[entry]?.purpose==='prefab_test'||!builds.store.ancestor(revision,branch.head))fail(409,'共享运行需要此分支的固定正式原生场景');
  if(input.request_id!==undefined)identifier(input.request_id,'请求 ID');
  const requestKey=input.request_id?hash({p,b,actor_id:user.id,request_id:input.request_id}):null,fingerprint=hash(input);
  const replay=requestKey&&builds.store.get('creator_shared_build_request',requestKey);
  if(replay){if(replay.fingerprint!==fingerprint)fail(409,'同一请求 ID 不能修改共享构建参数');return {job:builds.view(builds.forUser(user,replay.job_id)),replayed:true,reused:true};}
  const job={id:id('build'),kind:'application',purpose:'native_shared',native_shared_protocol:1,project_id:p,project_name:builds.store.projectFor(user,p).name,branch_id:b,source_revision:revision,entry_scene_id:entry,targets:['web'],actor_id:user.id,status:'queued',progress:0,stage:'准备共享世界的固定工程',created_at:Date.now(),artifacts:[],target_results:[]};
  let selected=job,reused=false;
  try{
    builds.pin(job);
    const previous=builds.store.list('creator_build').filter(value=>value.purpose==='native_shared'&&value.content_key===job.content_key).find(value=>builds.validWeb(value)||active(value));
    if(previous){selected=previous;reused=true;rm(join(builds.directory,job.id),{recursive:true,force:true}).catch(()=>{});}
    else{
      if(builds.store.list('creator_build').filter(active).length>=12)fail(429,'后台构建队列已满，请稍后再试');
      builds.update(job,{});
    }
  }catch(error){rm(join(builds.directory,job.id),{recursive:true,force:true}).catch(()=>{});throw error;}
  if(requestKey)builds.store.put('creator_shared_build_request',{id:requestKey,project_id:p,branch_id:b,user_id:user.id,job_id:selected.id,fingerprint,created_at:Date.now()});
  if(!reused){builds.queue.push(job.id);builds.pump();}
  return {job:builds.view(selected),reused};
}

export function authorizeNativeSharedBuild(builds,user,job,{execution=false}={}){
  const branch=builds.store.branchFor(user,job.project_id,job.branch_id,execution),project=builds.store.projectFor(user,job.project_id);
  if(['owner','editor'].includes(builds.store.roleFor(user,project))&&builds.store.ancestor(job.source_revision,branch.head))return user;
  if(execution)fail(403,'共享构建执行者已失去源版本访问权限');
  if(!builds.service.worlds?.native)fail(503,'原生共享世界服务尚未就绪');
  builds.service.worlds.native.authorizeBuild(user,job);
  return user;
}
