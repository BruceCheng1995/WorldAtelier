import {clone,fail,stable} from './schema.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';
import {nativeObjectViews,nativeAddressKey,nativeTarget,nativeMatrix} from './native-view.mjs';
import {identity,inverse} from '../../packages/scene/transform.mjs';

const parentPath=path=>path==='.'?null:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.';
const identityPart=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x1f\x7f]/.test(value);
export function nativeObjects(manifest,scope){
  if(manifest?.schema!==NATIVE_SCHEMA||manifest.index_source_identity!==manifest.source_identity)fail(409,'原生源版本与对象索引不一致');
  if(!manifest.resources?.[scope.resource_id])fail(404,'原生资源不存在');
  return nativeObjectViews(manifest,scope.resource_id,scope);
}

/** An explicit address always wins and is never repaired by guessing a legacy
 * ID. ID-only calls support the unique display IDs retained by migration. */
export function resolveNativeObject(manifest,scope,address,legacyId,objects=null){
  const rows=objects??nativeObjects(manifest,scope);
  if(address!=null){
    if(!address||typeof address!=='object'||Array.isArray(address)||['project_id','branch_id','resource_id'].some(key=>address[key]!==scope[key]))fail(409,'对象地址不属于当前场景');
    if(!identityPart(address.definition_node_id)||!Array.isArray(address.instance_path)||address.instance_path.length>128||address.instance_path.some(id=>!identityPart(id)))fail(422,'原生对象需要完整稳定地址');
    const key=nativeAddressKey(address),row=rows.find(row=>nativeAddressKey(row.address)===key);
    if(legacyId!=null&&row&&legacyId!==row.id)fail(409,'对象 ID 与完整地址不一致');
    return row??null;
  }
  if(legacyId==null)return null;
  if(!identityPart(legacyId))fail(422,'对象 ID 无效');
  const matches=rows.filter(row=>row.id===legacyId);
  if(matches.length>1)fail(409,'旧对象 ID 对应多个实例，需要完整地址');
  return matches[0]??null;
}

/** 3D uses the exact affine world matrix, retaining parent shear. 2D uses
 * engine local TRS in pixels/degrees, never a fabricated 3D world pose. */
export function nativePreviewTransform(target,message){
  if(!target.dimension||message.dimension!==target.dimension)fail(422,'原生拖动维度与固定对象不一致');
  const editTarget=target.native_mount_target??target.native_target;
  if(stable(message.native_target)!==stable(editTarget))fail(409,'原生拖动编辑目标已变化');
  if(message.expected_ancestry_hash!==target.ancestry_hash)fail(409,'拖动的父级变换已变化');
  const local=message.local_transform;
  if(!local||typeof local!=='object'||Array.isArray(local))fail(422,'原生拖动需要完整局部位置、旋转和缩放');
  for(const key of ['position','rotation','scale']){
    const limit=key==='position'?(target.control_layout?1e6:10000):key==='rotation'?36000:1e6;
    if(!Array.isArray(local[key])||local[key].length!==3||local[key].some(value=>!Number.isFinite(value)||Math.abs(value)>limit))fail(422,'原生拖动需要完整有限的局部变换');
  }
  if(local.scale.some(value=>Math.abs(value)<1e-8))fail(422,'原生拖动缩放不能为零');
  const transform={dimension:target.dimension,native_target:clone(editTarget),local_transform:clone(local),expected_ancestry_hash:target.ancestry_hash};
  if(target.dimension==='2d'){
    if(local.position[2]!==0||local.rotation[0]!==0||local.rotation[1]!==0||local.scale[2]!==1)fail(422,'二维拖动必须使用二维局部坐标');
  }else{
    const value=message.world_matrix;inverse(value);
    if(value.some(number=>Math.abs(number)>1e6)||value.slice(12,15).some(number=>Math.abs(number)>10000))fail(422,'拖动变换超出当前运行范围');
    transform.world_matrix=clone(value);
  }
  if(target.control_layout){
    const value=message.control_layout;
    if(!value||typeof value!=='object'||Array.isArray(value))fail(422,'Control 拖动必须携带实际原生布局');
    const lengths={anchors:4,offsets:4,pivot_offset:2,scale:2,custom_minimum_size:2};
    const required=target.control_layout.container_managed?['custom_minimum_size','size_flags_horizontal','size_flags_vertical','size_flags_stretch_ratio']:['anchors','offsets','pivot_offset','rotation_degrees','scale'];
    for(const key of required)if(!Object.hasOwn(value,key))fail(422,'Control 拖动缺少布局字段');
    for(const [key,field]of Object.entries(value)){
      if(!target.control_layout.fields[key]?.editable||['position','size'].includes(key))fail(422,'父容器管理此布局字段或字段不是原生存储属性');
      if(lengths[key]? !Array.isArray(field)||field.length!==lengths[key]||field.some(v=>!Number.isFinite(v)||Math.abs(v)>1e6):!Number.isFinite(field)||Math.abs(field)>1e6)fail(422,'Control 布局数值无效');
      if(['size_flags_horizontal','size_flags_vertical'].includes(key)&&(!Number.isInteger(field)||field<0||field>15)||key.startsWith('grow_')&&(!Number.isInteger(field)||field<0||field>2)||key==='size_flags_stretch_ratio'&&field<=0)fail(422,'Control 布局配置无效');
      if(key==='custom_minimum_size'&&field.some(v=>v<0)||key==='scale'&&field.some(v=>Math.abs(v)<1e-8))fail(422,'Control 尺寸或缩放无效');
    }
    if(!target.control_layout.container_managed&&(Math.abs(value.rotation_degrees-local.rotation[2])>1e-5||value.scale.some((v,i)=>Math.abs(v-local.scale[i])>1e-5)))fail(422,'Control 布局与局部变换不一致');
    transform.control_layout=clone(value);
  }
  return transform;
}

export function nativeAnnotationContext({manifest,scope,source_revision,target}){
  const doc=manifest.resources[scope.resource_id],byPath=new Map(doc.native_nodes.map(node=>[node.path,node]));
  const node=byPath.get(target.native_path);if(!node||nativeAddressKey(node)!==nativeAddressKey(target.address))fail(409,'附件对象与固定原生索引不一致');
  const paths=[];let at=parentPath(node.path);while(at!==null){const parent=byPath.get(at);if(!parent)fail(409,'原生附件缺少实际父级索引');paths.unshift(parent);at=parentPath(at);}
  const addressOf=value=>value.metadata?.wa_instance_mount?null:identityPart(value.node_id)?{...scope,instance_path:clone(value.instance_ids??[]),definition_node_id:value.node_id}:null;
  const row=value=>({address:addressOf(value),native_target:nativeTarget(value),native_path:value.path,node_version:value.version,object_version:value.version,
    native_local_transform:clone(value.local_transform),local_matrix:nativeMatrix(value.local_transform),world_matrix:nativeMatrix(value.world_transform)});
  const parent=paths.at(-1)??null;
  // The nearest spatial ancestor defines global transforms; ordinary Node
  // containers have no invented transform or coordinate unit.
  const parentMatrix=[...paths].reverse().map(value=>nativeMatrix(value.world_transform)).find(Boolean)??(target.dimension?identity():null);
  const world_matrix=nativeMatrix(node.world_transform),local_matrix=nativeMatrix(node.local_transform);
  const instances=new Map(),resourcePaths=new Map(Object.values(manifest.resources).map(resource=>['res://'+resource.path.replace(/^res:\/\//,''),resource]));
  for(const value of [...paths,node]){
    const chain=value.instance_ids??[];if(!chain.length||!value.scene_file_path&&!value.metadata?.wa_instance_mount)continue;
    const key=stable(chain),entry=instances.get(key)??{instance_path:clone(chain),source_revision};
    if(value.metadata?.wa_instance_mount)Object.assign(entry,{native_mount_target:nativeTarget(value),mount_version:value.version,mount_transform:clone(value.local_transform)});
    if(value.scene_file_path){const path=value.scene_file_path.replace(/^res:\/\//,''),file=manifest.source_files[path];Object.assign(entry,{native_scene_path:value.scene_file_path,scene_file_hash:file?.hash??null,prefab_id:resourcePaths.get(value.scene_file_path)?.id??null,instance_version:value.version});}
    instances.set(key,entry);
  }
  const dimension=target.dimension,space=doc.kind==='prefab'?'prefab_definition':dimension==='2d'?'scene_canvas':'scene_world';
  const units=dimension==='2d'?'pixels':dimension==='3d'?'metres':null,basis=dimension==='2d'?'x_right_y_down':dimension==='3d'?'right_handed_y_up':null;
  const source_pose={space,dimension,local_transform:clone(target.local_transform),native_local_transform:clone(node.local_transform),local_matrix,parent_world_matrix:parentMatrix,world_matrix,world_position:world_matrix?.slice(12,15)??null};
  return clone({context_version:2,document_schema:NATIVE_SCHEMA,domain:'source',source_revision,source_identity:manifest.source_identity,resource_version:doc.version,resource_name:doc.name,resource_kind:doc.kind,
    native_node_snapshot:node,native_component_snapshots:doc.native_nodes.filter(value=>parentPath(value.path)===node.path&&value.metadata?.wa_component),
    ...(target.native_mount_target?{native_mount_snapshot:doc.native_nodes.find(value=>nativeAddressKey(value)===nativeAddressKey(target.native_mount_target))??null}:{}),
    address:target.address,instance_path:target.address.instance_path,definition_node_id:target.address.definition_node_id,definition_resource_id:target.definition_resource_id,
    definition_revision:manifest.resources[target.definition_resource_id]?.version??doc.version,native_path:node.path,native_target:target.native_target,...(target.native_mount_target?{native_mount_target:target.native_mount_target}:{}),
    space,dimension,units,basis,world_position:source_pose.world_position,world_matrix,local_matrix,local_transform:source_pose.local_transform,native_local_transform:source_pose.native_local_transform,parent_world_matrix:parentMatrix,
    parent_address:parent?addressOf(parent):null,parent_native_target:parent?nativeTarget(parent):null,parent_version:parent?.version??null,ancestry_hash:target.ancestry_hash,
    ancestor_chain:paths.map(row),prefab_instances:[...instances.values()],prefab_reference:target.prefab??null,source_pose,observed_pose:null,
    coordinate_system:{space,dimension,units,basis,rotation_format:'native_variant',matrix_layout:'column_major',snapshot_rotation_format:'euler_degrees_YXZ',origin:{resource_id:doc.id,resource_version:doc.version,source_revision}}});
}
