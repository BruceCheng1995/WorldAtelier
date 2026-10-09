import {clone, hash} from './schema.mjs';
import {matrix} from '../../packages/scene/transform.mjs';

// Stable only inside one resource. Wire references additionally carry full address.
export const hierarchyRuntimeId=address=>address.instance_path.length?'node-'+hash([address.instance_path,address.definition_node_id]):address.definition_node_id;

export function eulerDegrees(quaternion) {
  const m=matrix({position:[0,0,0],rotation:quaternion,scale:[1,1,1]});
  const x=Math.asin(Math.max(-1,Math.min(1,-m[9])));
  const y=Math.abs(Math.cos(x))>1e-7?Math.atan2(m[8],m[10]):Math.atan2(-m[2],m[0]);
  const z=Math.abs(Math.cos(x))>1e-7?Math.atan2(m[1],m[5]):0;
  return [x,y,z].map(v=>v*180/Math.PI);
}

// Presentation metadata, never a source document or a runtime graph substitute.
export function hierarchyObjectView(row) {
  return {...clone(row.node),id:row.id??hierarchyRuntimeId(row.address),source_node_id:row.node.id,
    address:clone(row.address),version:row.object_version,node_version:row.node.version,
    definition_resource_id:row.definition_resource_id,definition_revision:row.definition_revision,
    local_transform:clone(row.local_transform),world_matrix:clone(row.world_matrix),
    parent_world_matrix:clone(row.parent_world_matrix),ancestry_hash:row.ancestry_hash,
    position:clone(row.world_position),rotation:row.world_transform?eulerDegrees(row.world_transform.rotation):null,
    scale:row.world_transform?clone(row.world_transform.scale):null,has_world_shear:row.world_transform===null};
}
