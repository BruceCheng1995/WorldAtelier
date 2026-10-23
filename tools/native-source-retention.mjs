import {NATIVE_SCHEMA,nativeFileMap,nativeSourceIdentity} from '../services/creation/native-source.mjs';
import {nativeWorkspaceRetention} from './native-workspace-retention.mjs';

/** Every persisted revision is a retention root, including unreachable history.
 * Migration records stay in the SQLite snapshot; restoration never runs code. */
export function nativeSourceRetention(rows){
  const list=kind=>rows.filter(row=>row.kind===kind).map(row=>row.value);
  const all=new Map(list('creator_revision').map(revision=>[revision.id,revision])),revisions=[],objects=new Map();
  for(const revision of all.values()){
    const manifest=revision.manifest;
    if(manifest?.schema!==NATIVE_SCHEMA){if(manifest?.source_files!==undefined)throw Error('Native source files have an unsupported revision schema');continue;}
    const files=nativeFileMap(manifest.source_files),identity=nativeSourceIdentity(files);
    if(identity!==manifest.source_identity)throw Error('Native revision source identity mismatch');
    for(const entry of Object.values(files)){
      const path=`native-source/objects/${entry.hash.slice(0,2)}/${entry.hash}`,old=objects.get(path);
      if(old&&old.bytes!==entry.size)throw Error('Native source object size differs between revisions');
      objects.set(path,{path,sha256:entry.hash,bytes:entry.size});
    }
    revisions.push({revision_id:revision.id,project_id:revision.project_id,source_identity:identity,files});
  }
  const migrations=list('creator_native_migration').map(record=>{
    const from=all.get(record.from_revision),to=all.get(record.to_revision);
    if(!from||!to||record.id!==to.id||from.project_id!==record.project_id||to.project_id!==record.project_id||to.manifest.schema!==NATIVE_SCHEMA||!to.parents?.includes(from.id))throw Error('Native migration revision closure is invalid');
    return{id:record.id,project_id:record.project_id,branch_id:record.branch_id,from_revision:from.id,to_revision:to.id};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const offline=nativeWorkspaceRetention(rows);
  for(const file of offline?.objects??[]){const old=objects.get(file.path);if(old&&old.bytes!==file.bytes)throw Error('Offline workspace object size differs from native source');objects.set(file.path,file);}
  if(!revisions.length&&!migrations.length&&!offline)return null;
  return{policy:'all_persisted_native_source_file_objects_v1',revisions:revisions.sort((a,b)=>a.revision_id.localeCompare(b.revision_id)),migrations,...(offline?{offline_workspaces:offline}:{}),objects:[...objects.values()].sort((a,b)=>a.path.localeCompare(b.path))};
}
