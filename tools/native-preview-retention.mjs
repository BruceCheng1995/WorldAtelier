import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {hash} from '../services/creation/schema.mjs';
import {NATIVE_SCHEMA,nativeFileMap} from '../services/creation/native-source.mjs';

const safe=path=>{if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('\\')||path.includes('\0')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe native preview retention path');return path;};
const ignored=name=>['.godot','.git'].includes(name);
const diagnostic=path=>path.split('/').some(part=>/^(?:execution|executions|checks)(?:-|$)/.test(part))||/\.(?:log|tmp)$/i.test(path);
function regular(root,path,{optional=false,directory=false}={}){
  let at=root;const base=lstatSync(at);if(base.isSymbolicLink()||!base.isDirectory())throw Error('Native preview storage root is not a regular directory');
  const parts=safe(path).split('/');
  for(let i=0;i<parts.length;i++){
    at=join(at,parts[i]);let stat;try{stat=lstatSync(at);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
    if(stat.isSymbolicLink()||!(i===parts.length-1&&!directory?stat.isFile():stat.isDirectory()))throw Error('Native preview symlink or special file rejected: '+path);
  }
  return at;
}
function fileIdentity(root,path){
  const actual=regular(root,path),fd=openSync(actual,constants.O_RDONLY|constants.O_NOFOLLOW),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let size=0;
  try{
    const before=fstatSync(fd,{bigint:true});for(;;){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;digest.update(buffer.subarray(0,count));size+=count;}
    const after=fstatSync(fd,{bigint:true}),pathAfter=lstatSync(regular(root,path),{bigint:true});if(before.ino!==pathAfter.ino||before.dev!==pathAfter.dev||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(size)!==after.size)throw Error('Native preview file changed during backup inventory: '+path);
    return{path,sha256:digest.digest('hex'),size};
  }finally{closeSync(fd);}
}
function tree(root,path){
  if(!regular(root,path,{optional:true,directory:true}))return[];
  const result=[];
  const walk=relative=>{
    const directory=regular(root,relative,{directory:true}),before=lstatSync(directory,{bigint:true});
    for(const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const child=relative+'/'+item.name;
      // A symlink is never silently hidden by an ignore rule.
      if(item.isSymbolicLink())throw Error('Native preview symlink rejected: '+child);
      if(ignored(item.name)||diagnostic(child.slice(path.length+1)))continue;
      if(item.isDirectory())walk(child);else if(item.isFile())result.push(fileIdentity(root,child));else throw Error('Native preview special file rejected: '+child);
    }
    const after=lstatSync(directory,{bigint:true});if(before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('Native preview directory changed during backup inventory: '+relative);
  };walk(path);return result;
}

/** Backup-only artifact closure. Nothing here imports or runs Godot/author code.
 * Pinned job inventories are verified first. Additional outputs are separately
 * retained as an unverified recovery scene, never as a completed build. */
export function nativePreviewRetention(job,revision,{storageRoot}={}){
  if(!storageRoot)throw Error('Native preview retention requires a fixed storage root');
  if(revision?.project_id!==job.project_id||revision.manifest?.schema!==NATIVE_SCHEMA)throw Error('Native preview fixed revision scope differs');
  if(!Array.isArray(job.runtime_sources)||!job.runtime_sources.length||hash(job.runtime_sources)!==job.runtime_source_hash)throw Error('Native preview trusted runtime inventory differs');
  const root=resolve(storageRoot),base=`builds/${job.id}`,files=new Map(),registered=new Set(),recovery=[];
  const add=(file,fixed=false)=>{
    const old=files.get(file.path);if(old&&(old.sha256!==file.sha256||old.size!==file.size))throw Error('Native preview file identities conflict: '+file.path);
    files.set(file.path,file);if(fixed)registered.add(file.path);
  };
  const pin=(prefix,entries)=>{
    const seen=new Set();for(const entry of entries??[]){const path=base+'/'+prefix+safe(entry.path??entry.filename);if(seen.has(path))throw Error('Duplicate native preview fixed file: '+path);seen.add(path);
      if(!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0)throw Error('Invalid native preview fixed file identity');
      const actual=fileIdentity(root,path);if(actual.sha256!==entry.sha256||actual.size!==entry.size)throw Error('Native preview fixed file changed: '+path);add(actual,true);
    }
  };
  pin('runtime/',job.runtime_sources);pin('project/',job.source_files);pin('web/',job.web_files);pin('',job.artifacts);
  if(job.native_preview_receipt){if(job.native_preview_receipt.path!=='native-preview-receipt.json')throw Error('Invalid native preview receipt path');pin('',[job.native_preview_receipt]);}
  if((job.status==='completed'||job.native_preview_receipt)&&!job.source_files?.length)throw Error('Registered native preview assembly lacks a display project inventory');
  const sourceFiles=nativeFileMap(revision.manifest.source_files),nativeRoot=regular(root,base+'/native-source',{optional:true,directory:true});let materialized=0;
  if(job.native_source_identity!=null&&job.native_source_identity!==revision.manifest.source_identity)throw Error('Native preview author source identity differs');
  if(nativeRoot)for(const [path,entry]of Object.entries(sourceFiles)){
    const relative=base+'/native-source/'+path;if(!regular(root,relative,{optional:true}))continue;
    const actual=fileIdentity(root,relative);if(actual.sha256!==entry.hash||actual.size!==entry.size)throw Error('Native preview materialized source differs: '+path);add(actual,true);materialized++;
  }
  if(job.native_preview_receipt&&materialized!==Object.keys(sourceFiles).length)throw Error('Registered native preview assembly lacks complete author source');
  for(const domain of ['runtime','project','web','native-source'])for(const file of tree(root,base+'/'+domain)){
    if(registered.has(file.path))continue;
    if(domain==='runtime')throw Error('Unregistered file in fixed native preview runtime: '+file.path);
    add(file);recovery.push({path:file.path,sha256:file.sha256,bytes:file.size,domain});
  }
  const receiptPath=base+'/native-preview-receipt.json';
  if(!registered.has(receiptPath)&&regular(root,receiptPath,{optional:true})){
    const file=fileIdentity(root,receiptPath);add(file);recovery.push({path:file.path,sha256:file.sha256,bytes:file.size,domain:'bake_receipt'});
  }
  return{files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path)),record:{id:job.id,purpose:'native_preview',artifact_kind:'static_editor_preview',source_revision:job.source_revision,status:job.status,content_key:job.content_key??null,
    native_source_identity:revision.manifest.source_identity,author_source_retention:'all_revision_file_objects_in_native_source_archive',author_source_materialized:materialized===Object.keys(sourceFiles).length?'complete':materialized?'partial':'absent',
    runtime_directory:base+'/runtime',runtime_source_hash:job.runtime_source_hash,runtime_file_count:job.runtime_sources.length,
    display_project_registered:Boolean(job.source_files?.length),display_project_file_count:job.source_files?.length??0,bake_receipt_registered:Boolean(job.native_preview_receipt),
    ...(recovery.length?{recovery_scene:{verified_editor_artifact:false,reason:'not_registered_in_fixed_job_inventory',files:recovery.sort((a,b)=>a.path.localeCompare(b.path))}}:{})}};
}
