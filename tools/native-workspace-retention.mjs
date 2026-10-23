import {nativeFileMap,nativeSourceIdentity,NATIVE_SCHEMA} from '../services/creation/native-source.mjs';

/** Pending uploads and cached canonical inputs are retention roots even before
 * they become a public source revision. Missing, not-yet-uploaded blobs are not. */
export function nativeWorkspaceRetention(rows){
  const list=kind=>rows.filter(row=>row.kind===kind).map(row=>row.value),workspaces=new Map(list('creator_native_workspace').map(workspace=>[workspace.id,workspace])),revisions=new Map(list('creator_revision').map(revision=>[revision.id,revision]));
  const objects=new Map(),uploads=[],runtimes=[],plans=[];
  const add=files=>{for(const entry of Object.values(nativeFileMap(files))){const path=`native-source/objects/${entry.hash.slice(0,2)}/${entry.hash}`,previous=objects.get(path);if(previous&&previous.bytes!==entry.size)throw Error('Native workspace object sizes disagree');objects.set(path,{path,sha256:entry.hash,bytes:entry.size});}};
  const scope=(workspaceId,owner)=>{const workspace=workspaces.get(workspaceId);if(!workspace||owner&&workspace.owner_user_id!==owner)throw Error('Native workspace retention scope is missing');const revision=revisions.get(workspace.base_revision);if(!revision||revision.project_id!==workspace.project_id||revision.manifest?.schema!==NATIVE_SCHEMA)throw Error('Native workspace retained baseline is invalid');return workspace;};
  for(const workspace of workspaces.values())scope(workspace.id,workspace.owner_user_id);
  for(const upload of list('creator_native_workspace_upload')){
    scope(upload.workspace_id,upload.owner_user_id);const source=nativeFileMap(upload.source_files);
    if(nativeSourceIdentity(source)!==upload.source_identity)throw Error('Native workspace upload source identity differs');
    const expected=new Map(Object.values(source).map(entry=>[entry.hash,entry]));
    for(const entries of [upload.accepted??{},upload.received??{}]){const files=nativeFileMap(entries);for(const [digest,entry]of Object.entries(files)){const valid=expected.get(digest);if(digest!==entry.hash||valid?.size!==entry.size)throw Error('Native workspace uploaded blob is outside its fixed manifest');}add(files);}
    if(upload.normalized_files)add(upload.normalized_files);
    if(upload.status==='committed'&&(!upload.result_snapshot||upload.result_snapshot.revision!==upload.result?.revision||upload.result_snapshot.source_identity!==nativeSourceIdentity(upload.result_snapshot.files)))throw Error('Native workspace committed receipt is incomplete');
    uploads.push({id:upload.id,workspace_id:upload.workspace_id,status:upload.status,source_identity:upload.source_identity,received_hashes:Object.keys(upload.received??{}).sort(),accepted_hashes:Object.keys(upload.accepted??{}).sort(),...(upload.normalized_files?{normalized_source_identity:nativeSourceIdentity(upload.normalized_files)}:{})});
  }
  for(const runtime of list('creator_native_workspace_runtime')){
    scope(runtime.workspace_id);add(runtime.files);if(runtime.template_files)add(runtime.template_files);if(runtime.adapter_files)add(runtime.adapter_files);
    runtimes.push({id:runtime.id,workspace_id:runtime.workspace_id,revision:runtime.revision,runtime_hash:runtime.runtime_hash,assembler:runtime.policy?.sha256??null,template_available:Boolean(runtime.template_files)});
  }
  for(const plan of list('creator_merge_preview'))if(plan.kind==='workspace'&&plan.external){scope(plan.external.workspace_id,plan.created_by);add(plan.external.source_files);if(nativeSourceIdentity(plan.external.source_files)!==plan.external.source_identity)throw Error('Native workspace merge plan identity differs');plans.push({id:plan.id,workspace_id:plan.external.workspace_id,source_identity:plan.external.source_identity});}
  if(!workspaces.size&&!uploads.length&&!runtimes.length&&!plans.length)return null;
  return {policy:'registered_native_workspace_inputs_v1',workspaces:[...workspaces.values()].map(workspace=>({id:workspace.id,project_id:workspace.project_id,branch_id:workspace.branch_id,base_revision:workspace.base_revision,version:workspace.version,revoked:Boolean(workspace.revoked_at)})).sort((a,b)=>a.id.localeCompare(b.id)),uploads:uploads.sort((a,b)=>a.id.localeCompare(b.id)),runtimes:runtimes.sort((a,b)=>a.id.localeCompare(b.id)),plans:plans.sort((a,b)=>a.id.localeCompare(b.id)),objects:[...objects.values()].sort((a,b)=>a.path.localeCompare(b.path))};
}
