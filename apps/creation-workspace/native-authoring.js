export const NATIVE_SCHEMA='creation-native-1';
const clone=structuredClone;
const finiteVector=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
export const nativeEditTarget=target=>target?.native_mount_target??target?.native_target;
export function nativeTargetKey(target){
  if(!target||!Array.isArray(target.instance_ids)||target.instance_ids.some(id=>typeof id!=='string')||!target.mount&&typeof target.node_id!=='string')throw Error('缺少原生对象地址');
  return JSON.stringify([target.mount?'mount':'node',target.instance_ids,target.mount?null:target.node_id]);
}
export function nativeOperation(ctx,operation,extra={}){
  const resource=ctx.manifest.resources[ctx.resourceId];
  if(!resource?.version)throw Error('缺少固定原生场景版本');
  return {type:'native_scene_operation',resource_id:ctx.resourceId,expected_version:resource.version,operation:clone(operation),...extra};
}
export function nativeTransformFields(target){
  const value=target?.native_edit_transform;
  if(!value||!['position','rotation','scale'].every(key=>finiteVector(value[key],3)))return null;
  return clone(value);
}
export function nativePatchOperations(target,patch,ctx){
  nativeTargetKey(target.native_target);
  if(Object.keys(patch).some(key=>!['name','position','rotation','scale'].includes(key)))throw Error('请通过原生源文件或绑定参数修改这个属性');
  const operations=[];
  if(Object.hasOwn(patch,'name'))operations.push(nativeOperation(ctx,{op:'rename',target:nativeEditTarget(target),name:patch.name}));
  const fields=['position','rotation','scale'].filter(key=>Object.hasOwn(patch,key));
  if(fields.length){
    if(!nativeTransformFields(target))throw Error('此对象没有可编辑的空间变换');
    const value={};
    for(const key of fields){
      if(!finiteVector(patch[key],3))throw Error('空间变换必须是完整且有效的坐标');
      const name=key==='rotation'?'rotation_degrees':key;
      value[name]=target.dimension==='2d'?(key==='rotation'?patch[key][2]:patch[key].slice(0,2)):clone(patch[key]);
    }
    // Only changed native properties are assigned. Moving does not decompose
    // and rewrite an existing sheared basis or unrelated CanvasItem settings.
    operations.push(nativeOperation(ctx,{op:target.control_layout?'control_layout':'transform',target:nativeEditTarget(target),value,...(target.control_layout?{viewport_size:clone(target.control_layout.viewport_size)}:{})}));
  }
  if(!operations.length)throw Error('没有可提交的修改');return operations;
}
export function nativeWorldTransformOperation(target,worldMatrix,ctx,{matrixTarget='display'}={}){
  if(target.dimension!=='3d'||!finiteVector(worldMatrix,16))throw Error('缺少完整的原生三维变换');
  return nativeOperation(ctx,{op:'transform_world',target:nativeEditTarget(target),...(target.native_mount_target&&matrixTarget==='display'?{reference_target:target.native_target}:{}),world_matrix:clone(worldMatrix)});
}
export function nativeDeleteOperation(target,ctx){
  if(target.native_path==='.'||target.native_can_edit_structure===false)throw Error('请打开此对象的来源定义修改结构');
  return nativeOperation(ctx,{op:'delete_node',target:nativeEditTarget(target)});
}
export function nativeInstantiateOperation(prefabId,ctx,{instanceId,name,parent,placement}={}){
  const prefab=ctx.manifest.resources[prefabId];
  if(prefab?.kind!=='prefab'||prefabId===ctx.resourceId)throw Error('请选择其他预制件定义');
  if(placement!==undefined&&(!placement||!['3d','2d'].includes(placement.dimension)||!finiteVector(placement.position,placement.dimension==='3d'?3:2)))throw Error('实例放置需要匹配维度的完整有效坐标');
  return nativeOperation(ctx,{op:'instantiate',instance_id:instanceId,...(name?{name}:{}),...(parent?{parent:clone(parent)}:{}),...(placement!==undefined?{placement:clone(placement)}:{})},{prefab_id:prefabId});
}
export function nativeCreateResourceOperation(id,kind,name,rootType='Node3D'){
  return {type:'create_native_resource',resource_id:id,kind,name,root_type:rootType};
}
export function nativeMatchesEvent(message,target,ctx){
  try{
    const address=target.address,actual=message.address;
    return message.id===target.id&&message.source_revision===ctx.base&&message.source_identity===ctx.manifest.source_identity&&message.object_version===target.version&&message.dimension===target.dimension&&message.ancestry_hash===target.ancestry_hash&&
      ['project_id','branch_id','resource_id','definition_node_id'].every(key=>actual?.[key]===address?.[key])&&JSON.stringify(actual.instance_path)===JSON.stringify(address.instance_path)&&
      nativeTargetKey(message.native_target)===nativeTargetKey(nativeEditTarget(target))&&
      (target.dimension==='3d'?finiteVector(message.world_matrix,16):target.dimension==='2d'&&['position','rotation','scale'].every(key=>finiteVector(message.local_transform?.[key],3)));
  }catch{return false;}
}
export function nativePreviewRows(scene,values,{selfId,now=Date.now(),localEdit=null}={}){
  const canonical=[],active=[];
  for(const target of scene.objects){
    const fields=nativeTransformFields(target);if(!fields&&!target.control_layout)continue;
    const row={id:target.id,native_target:clone(nativeEditTarget(target)),local_transform:fields,...(target.control_layout?{control_layout:nativeControlStorage(target.control_layout.values)}:{})};
    const world=target.native_edit_world_matrix??(!target.native_mount_target?target.world_matrix:null);
    if(target.dimension==='3d'&&finiteVector(world,16))row.world_matrix=clone(world);
    canonical.push(row);
    for(const value of values){
      const message={...value,id:value.object_id,object_version:value.expected_version,ancestry_hash:value.expected_ancestry_hash};
      if(value.peer_id===selfId||value.expires_at<=now||!nativeMatchesEvent(message,target,{base:scene.source_revision??scene.scene_revision,manifest:{source_identity:scene.source_identity}}))continue;
      active.push({id:target.id,native_target:clone(nativeEditTarget(target)),local_transform:clone(value.local_transform),...(target.dimension==='3d'?{world_matrix:clone(value.world_matrix)}:{}),...(value.control_layout?{control_layout:clone(value.control_layout)}:{})});
    }
    if(localEdit?.control&&localEdit.objectId===target.id){active.push({id:target.id,native_target:clone(nativeEditTarget(target)),control_layout:clone(localEdit.next)});continue;}
    if(localEdit?.objectId===target.id){const patch=Object.fromEntries(Object.entries(localEdit.next).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(fields[key])));active.push({id:target.id,native_target:clone(nativeEditTarget(target)),local_transform_patch:clone(patch)});}
  }
  // Reset the fixed scene first, then apply live targets. A later canonical
  // child must not cancel its parent's active transform preview.
  return {canonical,active};
}

export function nativeControlStorage(values){
  return Object.fromEntries(Object.entries(clone(values)).filter(([key])=>!['position','size'].includes(key)));
}
export function nativeControlOperation(target,edit,ctx){
  if(!target.control_layout)throw Error('此对象没有 Control 布局');
  const fields=Object.keys(edit.value??{}).concat(edit.reset??[]);
  if(fields.some(key=>!target.control_layout.fields[key]?.editable)||edit.preset&&target.control_layout.container_managed)throw Error('父容器管理此对象的布局，请调整最小尺寸和填充配置');
  return nativeOperation(ctx,{op:'control_layout',target:nativeEditTarget(target),viewport_size:clone(target.control_layout.viewport_size),...clone(edit)});
}

/** Fill only missing window-local measurements from the actual native host.
 * Identity, version guards and Godot's recorded default/override flags remain
 * the fixed source projection. No source or immutable manifest is mutated. */
export function measureLegacyControl(target,observation,ctx){
  if(!target.control_layout?.needs_measurement||!nativeMatchesEvent(observation,target,ctx)||observation.control_layout?.needs_measurement!==false)return false;
  const actual=observation.control_layout;
  if(!finiteVector(actual.values?.position,2)||!finiteVector(actual.values?.size,2)||!finiteVector(actual.viewport_size,2)||actual.viewport_size.some(v=>v<=0))return false;
  target.control_layout={...clone(target.control_layout),needs_measurement:false,values:{...clone(target.control_layout.values),position:clone(actual.values.position),size:clone(actual.values.size)},viewport_size:clone(actual.viewport_size),parent_size:clone(actual.parent_size),minimum_size:clone(actual.minimum_size)};
  target.native_edit_transform=clone(observation.local_transform);
  return true;
}

/** Retain a real host measurement for one edit's cancellation. Never derive a
 * viewport rect from source anchors, offsets or a previous transient value. */
export function nativeControlObservation(target,ctx,...observations){
  if(!target?.control_layout)return null;
  for(const observation of observations){
    const layout=observation?.control_layout;
    if(layout?.needs_measurement===false&&finiteVector(layout.values?.position,2)&&finiteVector(layout.values?.size,2)&&finiteVector(layout.viewport_size,2)&&layout.viewport_size.every(value=>value>0)&&nativeMatchesEvent(observation,target,ctx))return clone(observation);
  }
  return null;
}
