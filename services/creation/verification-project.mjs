import { resolve,relative,sep } from 'node:path';
import { projectInventory,verifyProjectFiles,snapshotProjectRuntime,assembleProject,GAME_PROJECT_CONTRACT } from './project-snapshot.mjs';
import { hash,fail } from './schema.mjs';
/** Immutable identity of the exact canonical project handed to an independent
 * verifier. It is separate from the historical check result and editor runtime. */
export function registerVerificationProject({service,job,directory,runtime_source_hash}){
  const expected=resolve(service.data,'automatic-checks',job.id,'runtime');
  if(resolve(directory)!==expected||!expected.startsWith(resolve(service.data)+sep))fail(403,'独立验证工程目录不匹配');
  const files=projectInventory(directory),project_hash=hash(files);
  const canonical_identity=hash({contract:GAME_PROJECT_CONTRACT,project_id:job.project_id,branch_id:job.branch_id,source_revision:job.revision,runtime_source_hash,project_hash});
  const job_kind=job.job_kind??'creator_auto_verification';
  if(!['creator_auto_verification','creator_game_verification'].includes(job_kind))fail(422,'未知的游戏验证任务类型');
  const manifest={format:1,canonical_identity,job_kind,id:job.id,job_id:job.id,project_id:job.project_id,branch_id:job.branch_id,source_revision:job.revision,session_id:job.session_id??null,run_id:job.run_id??null,game_project_contract:GAME_PROJECT_CONTRACT,runtime_source_hash,project_hash,directory:relative(resolve(service.data),expected).split(sep).join('/'),files,created_at:Date.now()};
  const previous=service.store.get('creator_verification_project',job.id);
  if(previous){
    for(const key of ['job_kind','job_id','project_id','branch_id','source_revision','session_id','run_id','runtime_source_hash','project_hash','directory'])if(previous[key]!==manifest[key])fail(409,'已登记的独立验证工程不可改写');
    verifyProjectFiles(directory,previous.files);return previous;
  }
  service.store.put('creator_verification_project',manifest);return manifest;
}

/** Technical checks and the following independent Agent read the same immutable
 * project. A later runtime/compiler update cannot replace this job's candidate. */
export async function prepareVerificationProject({service,job}){
  const user={id:job.actor_id},branch=service.store.branchFor(user,job.project_id,job.branch_id,true);
  const fixed=service.store.get('creator_revision',job.revision);
  if(!fixed||fixed.project_id!==job.project_id||!service.store.ancestor(job.revision,branch.head))fail(409,'独立验证的固定源版本无效');
  const directory=resolve(service.data,'automatic-checks',job.id,'runtime');
  const existing=service.store.get('creator_verification_project',job.id);
  if(existing){
    if((existing.job_kind??'creator_auto_verification')!==(job.job_kind??'creator_auto_verification')||existing.project_id!==job.project_id||existing.branch_id!==job.branch_id||existing.source_revision!==job.revision||(existing.session_id??null)!==(job.session_id??null)||(existing.run_id??null)!==(job.run_id??null)||existing.directory!==relative(resolve(service.data),directory).split(sep).join('/'))fail(409,'独立验证工程作用域不匹配');
    if(job.game_runtime_source_hash&&job.game_runtime_source_hash!==existing.runtime_source_hash)fail(409,'已登记验证工程与排队运行身份不匹配');
    verifyProjectFiles(directory,existing.files);return {directory,manifest:existing};
  }
  const snapshot=snapshotProjectRuntime(service.root,directory);
  if(job.game_runtime_source_hash&&job.game_runtime_source_hash!==snapshot.hash)fail(409,'运行代码在排队后已变化，请重新准备检查');
  await assembleProject({service,user,project_id:job.project_id,branch_id:job.branch_id,revision:job.revision,entry_scene_id:job.resource_ids[0]??fixed.manifest.entry_scene_id,directory,runtime_source_hash:snapshot.hash,allowPrefab:true});
  const manifest=registerVerificationProject({service,job,directory,runtime_source_hash:snapshot.hash});
  return {directory,manifest};
}
