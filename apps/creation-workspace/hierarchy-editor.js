import { randomUUID } from './client-platform.js';
// Thin source-editor adapter over A's resolved-row and column-major matrix contract.
// No renderer IDs, networking, optimistic canonical edits, or source/applied mixing.
import { inverse, normalizeTransform, quaternionFromEulerDegrees } from '../../packages/scene/transform.mjs';
const copy=value=>structuredClone(value);
const fail=(code,status=422)=>{throw Object.assign(new Error(code),{code,status});};
const id=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value)||['constructor','prototype','__proto__'].includes(value))fail('invalid_address');return value;};
// Native node/instance identities are opaque metadata, not H2 dictionary IDs.
// Match native-reference.mjs; do not normalize separators or Unicode in keys.
const nativeIdentity=value=>{if(typeof value!=='string'||!value.length||value.length>1024||/[\x00-\x1f\x7f]/.test(value))fail('invalid_address');return value;};
const version=value=>{if(typeof value!=='string'||!value)fail('missing_version');return value;};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
function address(value,{opaqueIdentity=false}={}){
  if(!value||!Array.isArray(value.instance_path)||value.instance_path.length>(opaqueIdentity?128:32))fail('invalid_address');
  const part=opaqueIdentity?nativeIdentity:id;
  return{project_id:id(value.project_id),branch_id:id(value.branch_id),resource_id:id(value.resource_id),instance_path:value.instance_path.map(part),definition_node_id:part(value.definition_node_id)};
}
// Display/lookup is shared by native and H2; H2 mutation capture below retains
// its strict ID and depth checks through address(value)'s default mode.
export function fullAddressKey(value){const a=address(value,{opaqueIdentity:true});return JSON.stringify([a.project_id,a.branch_id,a.resource_id,a.instance_path,a.definition_node_id]);}
export function lookupResolvedRow(rows,value){
  const wanted=fullAddressKey(value);let result=null;
  for(const row of rows){if(fullAddressKey(row.address)!==wanted)continue;if(result)fail('duplicate_resolved_address');result=row;}
  return result;
}
function worldMatrix(value){
  if(!Array.isArray(value)||value.length!==16||!value.every(Number.isFinite))fail('invalid_world_matrix');
  inverse(value); // Validate affine/invertible; do NOT decompose away world shear.
  return [...value];
}
function writable(readOnly){if(readOnly)fail('read_only',403);}
export function captureTransformTarget({scope,branch,row,readOnly=false}){
  writable(readOnly);const a=address(row?.address);
  if(a.project_id!==scope?.project_id||a.branch_id!==scope?.branch_id||a.resource_id!==scope?.resource_id)fail('address_scope_changed',409);
  if(branch.project_id!==a.project_id||branch.branch_id!==a.branch_id)fail('branch_scope_changed',409);
  if(branch.manifest?.schema!=='creation-hierarchy-2'||row.domain&&row.domain!=='source')fail('source_hierarchy_required');
  if(row.source_revision&&row.source_revision!==branch.head)fail('source_revision_changed',409);
  const doc=branch.manifest.resources[a.resource_id];if(!doc)fail('resource_missing',410);
  if(row.resource_version&&row.resource_version!==doc.version)fail('resource_version_changed',409);
  if(row.node?.id!==a.definition_node_id)fail('row_identity_mismatch',409);
  const inherited=a.instance_path.length>0,instance=inherited?doc.instances[a.instance_path[0]]:null;
  if(inherited){
    if(!instance)fail('instance_missing',410);
    // A rows intentionally omit the internal ancestry chain. Capture the outer
    // instance from this immutable branch snapshot; effective object_version
    // and ancestry_hash independently fence any mismatched/stale resolved row.
  }else if(doc.nodes[a.definition_node_id]?.version!==row.node.version)fail('node_version_changed',409);
  const pose=row.source_pose??row;
  return freeze({address:a,base_revision:version(branch.head),resource_version:version(doc.version),node_version:version(row.node.version),object_version:version(row.object_version),instance_version:inherited?version(instance.version):null,ancestry_hash:version(row.ancestry_hash),definition_revision:row.definition_revision??null,world_matrix:worldMatrix(pose.world_matrix),parent_world_matrix:worldMatrix(pose.parent_world_matrix),local_transform:copy(pose.local_transform),readOnly:false});
}
export function buildWorldTransformCommit(target,value,{readOnly=false,transactionId='hierarchy-'+randomUUID()}={}){
  writable(readOnly||target?.readOnly);const a=address(target.address),world_matrix=worldMatrix(value);
  if(typeof transactionId!=='string'||!transactionId)fail('missing_transaction_id');
  const shared={resource_id:a.resource_id,expected_ancestry_hash:version(target.ancestry_hash),world_matrix};
  const op=a.instance_path.length?{type:'set_override_world_transform',...shared,instance_id:a.instance_path[0],expected_version:version(target.instance_version),expected_object_version:version(target.object_version),target:{instance_path:a.instance_path.slice(1),definition_node_id:a.definition_node_id}}:{type:'set_node_world_transform',...shared,node_id:a.definition_node_id,expected_version:version(target.node_version)};
  return{transaction_id:transactionId,base_revision:version(target.base_revision),ops:[op]};
}
export function withWorldPosition(value,position){
  if(!Array.isArray(position)||position.length!==3||!position.every(Number.isFinite))fail('invalid_position');
  const result=worldMatrix(value);result.splice(12,3,...position);return result;
}
export function localTransformFromEuler({position,rotation_degrees,scale}){
  if(!Array.isArray(rotation_degrees)||rotation_degrees.length!==3||!rotation_degrees.every(Number.isFinite))fail('invalid_euler_degrees');
  return normalizeTransform({position,rotation:quaternionFromEulerDegrees(rotation_degrees),scale});
}
