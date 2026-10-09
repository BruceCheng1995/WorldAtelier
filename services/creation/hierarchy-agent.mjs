// Pure adapters. Callers supply authorized, immutable manifests/scopes; no DB,
// current-head lookup, runtime publication, or private conversation projection.
import { clone,fail,hash,identifier } from './schema.mjs';
import { HIERARCHY_SCHEMA,target as localTarget,scopedAddressKey,resolveScene } from './hierarchy.mjs';
import { hierarchyRuntimeId } from './hierarchy-view.mjs';
const FLAT='creation-flat-1';
function scoped(scope){return{project_id:identifier(scope?.project_id),branch_id:identifier(scope?.branch_id),resource_id:identifier(scope?.resource_id)};}
function canonical(value,scope){
  const s=scoped(scope),a={...s,...value,...localTarget(value)};
  if(['project_id','branch_id','resource_id'].some(k=>a[k]!==s[k]))fail(409,'目标地址不属于明确的项目/分支/资源作用域');
  return{...s,instance_path:a.instance_path,definition_node_id:a.definition_node_id};
}
function addressOf(value,scope){
  if(value?.address)return canonical(value.address,scope);
  if(value?.definition_node_id)return canonical(value,scope);
  return canonical({project_id:value?.project_id??scope.project_id,branch_id:value?.branch_id??scope.branch_id,resource_id:value?.resource_id??scope.resource_id,instance_path:[],definition_node_id:identifier(value?.object_id)},scope);
}
const withoutVersion=value=>{const result=clone(value);delete result.version;return result;};
const schema=manifest=>{if(![FLAT,HIERARCHY_SCHEMA].includes(manifest?.schema))fail(422,'不支持的固定文档协议');return manifest.schema;};
const fixedRevision=value=>{if(typeof value!=='string'||!value)fail(422,'需要固定源版本');return value;};
function pinned(address,sourceRevision,fields={}){
  return{address:clone(address),resource_id:address.resource_id,object_id:address.instance_path.length?null:address.definition_node_id,
    source_revision:sourceRevision,object_version:fields.object_version??null,resource_version:fields.resource_version??null,definition_revision:fields.definition_revision??null,
    ...(fields.node_version!==undefined?{node_version:fields.node_version}:{}),...(fields.missing?{missing:true}:{})};
}
export function targetFromAttachment(attachment,scope){
  if(!attachment||typeof attachment!=='object')fail(422,'附件无效');
  // These are captured values only. Missing legacy metadata stays null; a
  // supplied scope completes legacy addresses but cannot supply new versions.
  const address=addressOf(attachment,scope);
  if(['project_id','branch_id','resource_id'].some(k=>attachment[k]!=null&&attachment[k]!==address[k]))fail(409,'附件身份与完整地址不一致');
  return pinned(address,attachment.source_revision??attachment.revision??null,{
    object_version:attachment.object_version,resource_version:attachment.resource_version,definition_revision:attachment.definition_revision,node_version:attachment.node_version});
}
function fromRow(row,doc,sourceRevision){return pinned(row.address,sourceRevision,{object_version:row.object_version,node_version:row.node.version,resource_version:doc.version,definition_revision:row.definition_revision});}
export function targetsForOperations(manifest,scope,ops,sourceRevision){
  const s=scoped(scope),kind=schema(manifest),revision=fixedRevision(sourceRevision);
  if(!Array.isArray(ops))fail(422,'操作列表无效');
  const doc=manifest.resources[s.resource_id],rows=kind===HIERARCHY_SCHEMA&&doc?resolveScene(manifest,s.resource_id,s):[],children=new Map(),found=new Map();
  for(const row of rows){const list=children.get(row.parent_key)??[];list.push(row);children.set(row.parent_key,list);}
  const addRow=row=>found.set(scopedAddressKey(row.address),fromRow(row,doc,revision));
  const addAddress=(a,descendants=false)=>{
    if(kind===FLAT){const object=doc?.objects.find(o=>o.id===a.definition_node_id);found.set(scopedAddressKey(a),pinned(a,revision,{object_version:object?.version,resource_version:doc?.version,missing:!object}));return;}
    const row=rows.find(r=>scopedAddressKey(r.address)===scopedAddressKey(a));
    if(!row){found.set(scopedAddressKey(a),pinned(a,revision,{resource_version:doc?.version,missing:true}));return;}
    const queue=[row];for(let i=0;i<queue.length;i++){addRow(queue[i]);if(descendants)queue.push(...(children.get(queue[i].key)??[]));}
  };
  const all=()=>{if(kind===FLAT)for(const object of doc?.objects??[])addAddress(canonical({instance_path:[],definition_node_id:object.id},s));else rows.forEach(addRow);};
  for(const op of ops){
    if(op.type!=='migrate_hierarchy'&&op.resource_id!==s.resource_id)fail(409,'先按明确资源分组操作再提取目标');
    if(['migrate_hierarchy','create_resource','delete_resource','restore_document','set_resource_design'].includes(op.type)){all();continue;}
    if(kind===FLAT){
      if(!['put_object','patch_object','delete_object'].includes(op.type))fail(422,'旧平级文档不支持此操作');
      addAddress(canonical({instance_path:[],definition_node_id:op.object_id??op.object?.id},s));continue;
    }
    if(['put_node','patch_node','delete_node','reparent_node','set_node_world_transform'].includes(op.type)){
      const descendants=op.type!=='patch_node'||Object.hasOwn(op.patch??{},'transform');
      addAddress(canonical({instance_path:[],definition_node_id:op.node_id??op.node?.id},s),descendants);continue;
    }
    if(['instantiate_prefab','patch_instance','delete_instance','reparent_instance','upgrade_instance','restore_instance'].includes(op.type)){
      const iid=identifier(op.instance_id??op.instance?.instance_id);rows.filter(r=>r.address.instance_path[0]===iid).forEach(addRow);continue;
    }
    if(['set_override','set_overrides','remove_override','set_override_world_transform'].includes(op.type)){
      const iid=identifier(op.instance_id),items=op.type==='set_overrides'?op.overrides:op.type==='set_override_world_transform'?[{target:op.target,path:['transform']}]:[op.override];
      if(!Array.isArray(items)||items.some(o=>!o?.target||!Array.isArray(o.path)))fail(422,'覆盖目标无效');
      for(const item of items){const t=localTarget(item.target);addAddress(canonical({instance_path:[iid,...t.instance_path],definition_node_id:t.definition_node_id},s),item.path[0]==='transform');}continue;
    }
    fail(422,'无法提取未知层级操作的目标');
  }
  return [...found.values()];
}
export function resolvePublicTarget(manifest,scope,target){
  return publicTargetResolver(manifest,scope)(target);
}
export function publicTargetResolver(manifest,scope){
  const s=scoped(scope),kind=schema(manifest),doc=manifest.resources[s.resource_id];
  const rows=kind===HIERARCHY_SCHEMA&&doc?new Map(resolveScene(manifest,s.resource_id,s).map(row=>[scopedAddressKey(row.address),row])):null;
  return target=>resolvePublicTargetIn(manifest,s,target,rows);
}
function resolvePublicTargetIn(manifest,scope,target,rows){
  const s=scoped(scope),kind=schema(manifest),address=addressOf(target,s),doc=manifest.resources[s.resource_id];if(!doc)return null;
  if(kind===FLAT){
    if(address.instance_path.length)return null;
    const object=doc.objects.find(o=>o.id===address.definition_node_id);if(!object)return null;
    return{runtimeId:object.id,address,contentFingerprint:hash(withoutVersion(object))};
  }
  const key=scopedAddressKey(address),row=rows.get(key);if(!row)return null;
  const dependencies=[];let definition=doc;
  for(let index=0;index<address.instance_path.length;index++){
    const instance=definition.instances[address.instance_path[index]];
    dependencies.push({instance_path:address.instance_path.slice(0,index+1),prefab_id:instance.prefab_id,prefab_revision:instance.prefab_revision});
    definition=manifest.prefab_revisions[instance.prefab_revision];
  }
  return{runtimeId:hierarchyRuntimeId(address),address,contentFingerprint:hash({schema:HIERARCHY_SCHEMA,node:withoutVersion(row.node),world_matrix:row.world_matrix,dependencies})};
}
export function worldApiGuide(manifest){
  const kind=schema(manifest);
  const common=`\nAll scopes are explicit project/branch/resource. Read world_read before edits. Conversation attachments are immutable historical references; never replace captured versions/coordinates with the moving head. Canonical full address is {project_id,branch_id,resource_id,instance_path:[outer...inner],definition_node_id}. Renderer runtime IDs are not source node IDs.\n\nworld_apply uses {transaction_id:<new UUID>,base_revision:<fixed read head>,ops:[...]}; after an uncertain response retry the exact payload/ID, not a newly generated mutation. A 409 requires explicit conflict reconciliation. Source persistence, actual Godot technical validation, world application and player acceptance are separate facts. Use asset_publish for actual workspace GLB/GDScript files; reference immutable canonical URLs and hashes, never query credentials. Existing collider/interactable/trigger/behaviors components remain supported; read the actual behavior API before writing GDScript. Use --log-file <absolute writable session path> for actual Godot commands. Blender initialization may require real command approval; a crash is not success. The primary integrator controls the shared production browser unless this task separately authorizes browser work.\n`;
  if(kind===FLAT)return `# WORLD-API: creation-flat-1\nRight-handed Y-up metres. Resources contain objects[]. Local position/rotation/scale are XYZ arrays; rotation values are degrees interpreted using Godot default YXZ order. Submit the complete TRS group. parent_id hierarchy is unavailable in this schema.\nOperations: create_resource, put_object {resource_id,object_id,expected_version:null|current,object}, patch_object {resource_id,object_id,expected_version,patch}, delete_object {resource_id,object_id,expected_version}, delete_resource {resource_id,expected_version}.\nExplicit hierarchy migration is a separate sole-op transaction [{type:'migrate_hierarchy'}] with expected_head and base_revision fixed to current head. Never migrate merely to reinterpret an old attachment or claim that migration publishes a runtime.\n${common}`;
  return `# WORLD-API: creation-hierarchy-2\nRight-handed Y-up metres. Resources are {schema:2,id,kind,name,version,root_id,nodes,instances}; prefab_revisions maps immutable fixed versions to full definitions. Nodes use parent_id within one document and transform:{position:[x,y,z],rotation:[x,y,z,w],scale:[x,y,z]}; rotation is a normalized quaternion, local TRS is T*R*S. Instances have instance_id,optional local name,prefab_id,prefab_revision,parent_id,transform,overrides,version. Do not use old put_object/patch_object operations or renderer IDs.\n\nResource operations: create_resource {resource_id,resource:{schema:2,kind:'scene'|'prefab',name,root_id,nodes,instances}}, delete_resource {resource_id,expected_version}. The root is a model-free group with parent_id:null.\n\nOrdinary node writes: put_node/patch_node/delete_node with resource_id,node_id,expected_version (null only for creation). Whole local transform is atomic. set_node_world_transform additionally needs expected_ancestry_hash and exactly one world_matrix or world_transform. World matrices are column-major full 4x4 and may contain natural world shear; do not decompose them to Euler TRS. Server converts through the actual complete parent matrix and rejects unrepresentable local shear.\n\nInstance operations: instantiate_prefab, patch_instance (local name and/or mount transform), delete_instance, reparent_instance, upgrade_instance. New unnamed instances receive an available numbered name in their document. Explicit names are preserved. patch_instance {patch:{name}} renames this mount only and clears its old root name override; prefab definitions stay unchanged. Nested content uses set_override/remove_override or set_overrides: outer instance_id + expected_version, each override {target:{instance_path:[relative inner ids],definition_node_id},path:[field...],value}. For world gizmo edits use set_override_world_transform {resource_id,instance_id,expected_version:<outer instance>,expected_object_version:<resolved object>,expected_ancestry_hash,target,world_matrix}. Do not collapse two same-name doors to one bare node ID. Editing an internal root is a node override; editing the whole mount is an explicit instance transform.\n\nParent topology changes use reparent_node/reparent_instance and full old/new ancestor and node version guards. Keep-world conversion can reject shear, preserving source. Deleting subtrees requires explicit cascade; undo uses server-issued guarded inverse ops and inverse_transaction_id, never fabricated restore operations. Saving a prefab definition does not update existing instances. Preview fixed-head upgrade impact, resolve override conflicts explicitly, and submit upgrade_instance with expected_version,expected_preview_hash,prefab_revision plus transaction expected_head. Nested dependencies upgrade from inside outward; never rewrite prefab_revisions or flatten derived rows into source. Only play/apply with actual matching runtime support; document conversion is not runtime success.\n${common}`;
}
