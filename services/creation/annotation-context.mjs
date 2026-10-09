import {clone,fail,hash} from './schema.mjs';
import {identity,matrix,quaternionFromEulerDegrees} from '../../packages/scene/transform.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';
import {nativeAnnotationContext} from './native-reference.mjs';
import {nativeMatrix} from './native-view.mjs';

const flatTransform=object=>({position:clone(object.position),rotation:quaternionFromEulerDegrees(object.rotation),scale:clone(object.scale)});

// Camera data is a client observation, never an authoritative object transform.
export function captureAnnotationCamera(value,space) {
  if(value==null)return null;
  const vector=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e6);
  if(!vector(value.position)||!vector(value.target))fail(400,'批注相机需要有限的三轴位置和观察目标');
  if(value.view!=null&&!['perspective','top','front','right'].includes(value.view))fail(400,'批注相机视图无效');
  if(value.projection!=null&&!['perspective','orthographic'].includes(value.projection))fail(400,'批注相机投影无效');
  return {position:clone(value.position),target:clone(value.target),view:value.view??null,projection:value.projection??null,space,source:'client_viewport'};
}

// All object and frame data comes from the already authorized immutable manifest.
// A prefab editor has its own origin; it does not identify a placed scene instance.
export function sourceAnnotationContext({manifest,scope,source_revision,target,row=null,rows=[],camera=null}) {
  if(manifest.schema===NATIVE_SCHEMA){const context=nativeAnnotationContext({manifest,scope,source_revision,target});return{...context,camera:captureAnnotationCamera(camera,context.space)};}
  const doc=manifest.resources[scope.resource_id],space=doc.kind==='prefab'?'prefab_definition':'scene_world';
  const address=row?.address??{...scope,instance_path:[],definition_node_id:target.id};
  const local_transform=clone(row?.local_transform??flatTransform(target));
  const world_matrix=clone(row?.world_matrix??matrix(local_transform));
  const parent_world_matrix=clone(row?.parent_world_matrix??identity());
  const byKey=new Map(rows.map(r=>[r.key,r])),ancestor_chain=[];
  let parent=row?.parent_key?byKey.get(row.parent_key):null;
  const parent_address=clone(parent?.address??null),parent_version=parent?.object_version??null;
  while(parent){
    ancestor_chain.unshift({address:clone(parent.address),object_version:parent.object_version,definition_revision:parent.definition_revision,
      local_transform:clone(parent.local_transform),world_matrix:clone(parent.world_matrix)});
    parent=parent.parent_key?byKey.get(parent.parent_key):null;
  }
  const prefab_instances=[];
  let definition=doc,path=[];
  for(const instanceId of address.instance_path){
    const instance=definition.instances[instanceId];path=[...path,instanceId];
    prefab_instances.push({instance_path:[...path],prefab_id:instance.prefab_id,prefab_revision:instance.prefab_revision,
      instance_version:instance.version,parent_id:instance.parent_id,transform:clone(instance.transform)});
    definition=manifest.prefab_revisions[instance.prefab_revision];
  }
  const source_pose={space,local_transform,parent_world_matrix,world_matrix,world_position:world_matrix.slice(12,15)};
  return clone({context_version:1,domain:'source',source_revision,resource_version:doc.version,resource_name:doc.name,resource_kind:doc.kind,
    address,instance_path:address.instance_path,definition_node_id:address.definition_node_id,
    definition_resource_id:row?.definition_resource_id??doc.id,definition_revision:row?.definition_revision??doc.version,
    space,units:'metres',basis:'right_handed_y_up',world_position:source_pose.world_position,world_matrix,local_transform,parent_world_matrix,
    parent_address,parent_version,ancestry_hash:row?.ancestry_hash??hash([]),ancestor_chain,prefab_instances,
    prefab_reference:target.prefab??null,source_pose,observed_pose:null,camera:captureAnnotationCamera(camera,space),
    coordinate_system:{space,units:'metres',basis:'right_handed_y_up',rotation_format:'quaternion_xyzw',matrix_layout:'column_major',
      snapshot_rotation_format:row?'quaternion_xyzw':'euler_degrees_YXZ',origin:{resource_id:doc.id,resource_version:doc.version,source_revision}}});
}

export function observedAnnotationContext(context,observed) {
  if(context.document_schema===NATIVE_SCHEMA){
    const world_matrix=clone(observed.world_matrix??nativeMatrix(observed.native_world_transform));
    const world_position=world_matrix?.slice(12,15)??null;
    const observed_pose={space:context.space,dimension:context.dimension,world_matrix,world_position,
      ...(observed.native_world_transform?{native_world_transform:clone(observed.native_world_transform),world_transform_2d:clone(observed.world_transform_2d)}:{})};
    return{...context,domain:'frozen',position:world_position,world_position,world_matrix,source_world_matrix:clone(context.source_pose.world_matrix),observed_pose};
  }
  const world_matrix=clone(observed.world_matrix??matrix(flatTransform(observed)));
  return {...context,domain:'frozen',position:world_matrix.slice(12,15),world_position:world_matrix.slice(12,15),world_matrix,
    source_world_matrix:clone(context.source_pose.world_matrix),observed_pose:{space:context.space,world_matrix:clone(world_matrix),world_position:world_matrix.slice(12,15)}};
}
