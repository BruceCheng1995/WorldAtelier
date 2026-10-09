import {nativePreviewRetention} from './native-preview-retention.mjs';
import { hash } from '../services/creation/schema.mjs';
import { NATIVE_SCHEMA,nativeFileMap } from '../services/creation/native-source.mjs';
/** Immutable, server-indexed game projects and applications. Mutable session
 * work folders and execution scratch are intentionally outside this closure. */
export function canonicalGameRetention(rows,{includeVerification=true,storageRoot=null}={}){
  const list=kind=>rows.filter(row=>row.kind===kind).map(row=>row.value),files=[],builds=[],environments=[],nativePreviews=[];
  const revisions=new Map(list('creator_revision').map(revision=>[revision.id,revision]));
  const safe=path=>{if(typeof path!=='string'||!path||path.startsWith('/')||path.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')||path.includes('\\'))throw Error('Invalid canonical game retention path');return path;};
  const add=(path,entry)=>{
    safe(path);if(!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0)throw Error('Invalid canonical game file identity');
    files.push({path,sha256:entry.sha256,bytes:entry.size});
  };
  const completeNativeInputs=(record,inputs,assembled=true)=>{
    const revision=revisions.get(record.source_revision);
    if(revision?.manifest?.schema!==NATIVE_SCHEMA||!assembled)return{files:inputs,extra:{}};
    if(revision.project_id!==record.project_id)throw Error('Native fixed project revision scope differs');
    const entries=new Map(),supplement=[];
    for(const file of inputs){safe(file.path);if(entries.has(file.path))throw Error('Duplicate native fixed project file');entries.set(file.path,file);}
    // Older generic inventories skipped .atelier, README and tests. Their
    // authoritative unchanged bytes can be recovered from the pinned source
    // graph, and must actually exist in the fixed project during backup.
    for(const [path,entry]of Object.entries(nativeFileMap(revision.manifest.source_files))){
      const actual=entries.get(path);
      if(path==='project.godot'){if(!actual)throw Error('Native fixed project has no generated project.godot');continue;}
      if(actual&&(actual.sha256!==entry.hash||actual.size!==entry.size))throw Error('Native fixed project differs from pinned source: '+path);
      if(!actual){entries.set(path,{path,sha256:entry.hash,size:entry.size});supplement.push(path);}
    }
    return{files:[...entries.values()].sort((a,b)=>a.path.localeCompare(b.path)),extra:{native_source_identity:revision.manifest.source_identity,...(supplement.length?{native_source_inventory_supplement:supplement.sort()}:{})}};
  };
  for(const job of list('creator_build')){
    if(!/^build-[a-f0-9-]+$/.test(job.id))throw Error('Invalid canonical build ID');
    if(job.purpose==='native_preview'){
      const retained=nativePreviewRetention(job,revisions.get(job.source_revision),{storageRoot});
      for(const file of retained.files)add(file.path,file);nativePreviews.push(retained.record);continue;
    }
    const shared=job.purpose==='native_shared';
    if(shared&&job.native_shared){
      const receipt=job.native_shared,revision=revisions.get(job.source_revision);
      if(receipt.contract!=='wa-native-world-state-1'||receipt.build_id!==job.canonical_identity||receipt.source_identity!==revision?.manifest?.source_identity)throw Error('Native shared fixed receipt identity differs');
      const authority=completeNativeInputs(job,receipt.authority_files);
      for(const file of authority.files)add(`builds/${job.id}/native-authority/${safe(file.path)}`,file);
      if(!job.source_files?.length&&job.status==='completed')throw Error('Native shared display inventory is absent');
    }else if(shared&&job.status==='completed')throw Error('Completed native shared build lacks authority inventory');
    const fixed=shared?{files:job.source_files??job.native_shared?.projection_files??(['queued','running'].includes(job.status)?job.runtime_sources:[])??[],extra:{native_shared:true,native_source_identity:revisions.get(job.source_revision)?.manifest.source_identity,authority_file_count:job.native_shared?.authority_files?.length??0}}:completeNativeInputs(job,job.source_files??(['queued','running'].includes(job.status)?job.runtime_sources:[])??[],Array.isArray(job.source_files)),inputs=fixed.files;
    for(const file of inputs)add(`builds/${job.id}/project/${safe(file.path)}`,file);
    for(const artifact of job.artifacts??[])add(`builds/${job.id}/${safe(artifact.filename)}`,artifact);
    for(const file of job.web_files??[])add(`builds/${job.id}/web/${safe(file.path)}`,file);
    if(inputs.length||job.artifacts?.length||job.web_files?.length)builds.push({id:job.id,source_revision:job.source_revision,runtime_source_hash:job.runtime_source_hash,content_key:job.content_key??null,status:job.status,...fixed.extra});
  }
  for(const environment of list('creator_environment')){
    if(!/^env-[a-f0-9-]+$/.test(environment.id))throw Error('Invalid canonical environment ID');
    const fixed=completeNativeInputs(environment,environment.files??[]);
    for(const file of fixed.files)add(`environments/${environment.id}/project/${safe(file.path)}`,file);
    environments.push({id:environment.id,source_revision:environment.source_revision,runtime_source_hash:environment.runtime_source_hash,project_hash:environment.project_hash,...fixed.extra});
  }
  const verificationProjects=[],unregistered=[];
  if(includeVerification){
    const jobs=new Map(['creator_auto_verification','creator_game_verification'].flatMap(kind=>list(kind).map(job=>[kind+':'+job.id,{kind,job}]))),registered=new Set();
    for(const project of list('creator_verification_project')){
      const jobKind=project.job_kind??'creator_auto_verification',key=jobKind+':'+project.job_id,job=jobs.get(key)?.job,revision=revisions.get(project.source_revision);
      if(!job||project.id!==project.job_id||project.project_id!==job.project_id||project.branch_id!==job.branch_id||project.source_revision!==job.revision||(project.session_id??null)!==(job.session_id??null)||(project.run_id??null)!==(job.run_id??null)||!revision||revision.project_id!==project.project_id)throw Error('Invalid retained independent verification project scope');
      if(!Array.isArray(project.files)||!project.files.length||hash(project.files)!==project.project_hash||!/^[a-f0-9]{64}$/.test(project.runtime_source_hash))throw Error('Invalid retained independent verification project identity');
      if(job.game_runtime_source_hash&&job.game_runtime_source_hash!==project.runtime_source_hash||project.canonical_identity!==hash({contract:project.game_project_contract,project_id:project.project_id,branch_id:project.branch_id,source_revision:project.source_revision,runtime_source_hash:project.runtime_source_hash,project_hash:project.project_hash}))throw Error('Independent verification project does not match its canonical identity');
      const directory=safe(project.directory);
      if(directory!==`automatic-checks/${safe(project.job_id)}/runtime`)throw Error('Invalid retained independent verification project directory');
      const paths=new Set(),fixed=completeNativeInputs(project,project.files);
      for(const file of fixed.files){if(paths.has(file.path))throw Error('Duplicate independent verification project file');paths.add(file.path);add(`${directory}/${safe(file.path)}`,file);}
      const prefix=revision.manifest?.schema===NATIVE_SCHEMA&&paths.has('atelier_runtime/standalone.gd')?'atelier_runtime/':'';
      for(const required of ['project.godot',...['standalone.gd','standalone.tscn','release.json','source-manifest.json'].map(path=>prefix+path)])if(!paths.has(required))throw Error('Incomplete independent verification project inventory');
      registered.add(key);verificationProjects.push({id:project.id,job_kind:jobKind,job_id:job.id,source_revision:project.source_revision,runtime_source_hash:project.runtime_source_hash,project_hash:project.project_hash,directory,...fixed.extra});
    }
    for(const [key,{kind,job}]of jobs)if((kind==='creator_game_verification'||job.run_id)&&job.resource_ids?.length&&!registered.has(key))unregistered.push({job_id:job.id,job_kind:kind,status:job.status,exact_project_retained:false,reason:'not_prepared_or_legacy_without_fixed_project_inventory'});
  }
  return {policy:includeVerification?'immutable_indexed_game_projects_and_artifacts_v2':'immutable_indexed_game_projects_and_artifacts_v1',builds,environments,...(nativePreviews.length?{native_previews:nativePreviews}:{}),...(includeVerification?{verification_projects:verificationProjects,unregistered_verification_jobs:unregistered}:{}),storage_domains:list('creator_game_storage').map(s=>({id:s.id,namespace:s.namespace,policy:s.policy})),files:files.sort((a,b)=>a.path.localeCompare(b.path))};
}
