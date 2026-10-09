import {clone,fail,hash,stable} from './schema.mjs';
import {addressKey,contentVersion,getPath,HIERARCHY_SCHEMA,normalizeDocument,resolveScene,overrideKey} from './hierarchy.mjs';
import {identityTransform} from '../../packages/scene/transform.mjs';
const type=v=>Array.isArray(v)?'array':v===null?'null':typeof v;
function incompatibleShape(oldValue,newValue) {
  if(type(oldValue)!==type(newValue))return true;
  if(oldValue&&type(oldValue)==='object')return Object.keys(oldValue).some(key=>!Object.hasOwn(newValue,key)||incompatibleShape(oldValue[key],newValue[key]));
  return false;
}
function instanceRows(manifest,doc,instance) {
  const root='preview-root';
  const preview=normalizeDocument({schema:2,id:doc.id,kind:'scene',name:'升级预览',root_id:root,nodes:{[root]:{id:root,kind:'group',name:'预览根',parent_id:null,transform:identityTransform(),components:{},solid:false}},instances:{[instance.instance_id]:{...instance,parent_id:root,overrides:[]}}},()=>true);
  return resolveScene({...manifest,resources:{...manifest.resources,[doc.id]:preview}},doc.id);
}
export function previewInstanceUpgrade(manifest,resourceId,instanceId,toRevision,{source_revision=null}={}) {
  const doc=manifest.resources[resourceId],instance=doc?.instances[instanceId];
  if(!instance)fail(404,'预制件实例不存在');
  const definition=manifest.prefab_revisions[toRevision];
  if(!definition||definition.id!==instance.prefab_id)fail(422,'升级目标不是此预制件的固定版本');
  const oldRows=instanceRows(manifest,doc,instance),newRows=instanceRows(manifest,doc,{...instance,prefab_revision:toRevision});
  const before=new Map(oldRows.map(row=>[addressKey(row.address),row]));
  const after=new Map(newRows.map(row=>[addressKey(row.address),row]));
  const conflicts=[],retained=[];
  for(const override of instance.overrides){
    const address={instance_path:[instanceId,...override.target.instance_path],definition_node_id:override.target.definition_node_id},key=addressKey(address);
    const oldNode=before.get(key)?.node,newNode=after.get(key)?.node;
    const oldField=oldNode&&getPath(oldNode,override.path),newField=newNode&&getPath(newNode,override.path);
    let reason=!newNode?'node_or_instance_path_deleted':!newField?.exists?'override_field_deleted':incompatibleShape(oldField?.value,newField.value)?'override_type_changed':null;
    // Component variants are semantic types, even when their JSON representation is unchanged.
    if(!reason&&override.path[0]==='components'){
      const component=override.path[1];
      const oldComponent=oldNode.components?.[component],newComponent=newNode.components?.[component];
      if(oldComponent?.shape!==newComponent?.shape)reason='component_variant_changed';
      if(component==='behaviors'&&stable((oldComponent??[]).map(b=>[b.id,b.api,b.script_hash]))!==stable((newComponent??[]).map(b=>[b.id,b.api,b.script_hash])))reason='behavior_definition_changed';
    }
    const item={override_key:overrideKey(override),target:clone(override.target),path:clone(override.path),old_default:oldField?.value??null,new_default:newField?.value??null,override:clone(override)};
    if(reason)conflicts.push({...item,reason});else retained.push(item);
  }
  const changes=[];
  for(const key of new Set([...before.keys(),...after.keys()])){
    const old=before.get(key),next=after.get(key);
    if(old?.node.version!==next?.node.version||stable(old?.world_matrix)!==stable(next?.world_matrix))changes.push({address:clone((next??old).address),name:(next??old).node.name,kind:!old?'added':!next?'deleted':'changed',changed_fields:Object.keys({...old?.node,...next?.node}).filter(field=>field!=='version'&&stable(old?.node[field])!==stable(next?.node[field])),world_transform_changed:stable(old?.world_matrix)!==stable(next?.world_matrix)});
  }
  const preview={source_revision,resource_id:resourceId,resource_name:doc.name,instance_name:instance.name??definition.name,resource_version:doc.version,instance_id:instanceId,instance_version:instance.version,prefab_id:instance.prefab_id,from_revision:instance.prefab_revision,to_revision:toRevision,conflicts,retained,changes};
  preview.preview_hash=hash(preview);return preview;
}
export function upgradeInstance(manifest,resourceId,instanceId,toRevision,{source_revision=null,expected_preview_hash,resolutions={}}={}) {
  const preview=previewInstanceUpgrade(manifest,resourceId,instanceId,toRevision,{source_revision});
  if(expected_preview_hash!==preview.preview_hash)fail(409,'升级预览已变化，请重新检查影响',{preview});
  const conflictKeys=new Set(preview.conflicts.map(c=>c.override_key));
  if(Object.keys(resolutions).some(key=>!conflictKeys.has(key)))fail(422,'冲突决议包含未知覆盖');
  for(const conflict of preview.conflicts)if(resolutions[conflict.override_key]!=='drop_override')fail(409,'升级存在未解决的覆盖冲突',{preview});
  const result=clone(manifest.resources[resourceId].instances[instanceId]);
  result.prefab_revision=toRevision;result.overrides=result.overrides.filter(o=>!conflictKeys.has(overrideKey(o)));result.version=contentVersion(result);return result;
}
export function prefabImpact(manifest,prefabId,toRevision,{source_revision=null}={}) {
  if(manifest.schema!==HIERARCHY_SCHEMA)fail(422,'需要层级文档');
  if(manifest.prefab_revisions[toRevision]?.id!==prefabId)fail(422,'预制件版本不存在');
  const direct=[],nested=[];
  for(const doc of Object.values(manifest.resources)){
    for(const instance of Object.values(doc.instances))if(instance.prefab_id===prefabId&&instance.prefab_revision!==toRevision)direct.push(previewInstanceUpgrade(manifest,doc.id,instance.instance_id,toRevision,{source_revision}));
    const seen=new Set();
    for(const row of resolveScene(manifest,doc.id))if(row.definition_resource_id===prefabId&&row.address.instance_path.length>1){
      const key=stable(row.address.instance_path);if(seen.has(key))continue;seen.add(key);
      nested.push({resource_id:doc.id,instance_path:row.address.instance_path,from_revision:row.definition_revision,to_revision:toRevision,status:'upgrade_parent_definition_first'});
    }
  }
  return {source_revision,prefab_id:prefabId,to_revision:toRevision,direct,nested};
}
