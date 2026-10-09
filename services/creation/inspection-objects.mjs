import {clone,fail,id} from './schema.mjs';
import {HIERARCHY_SCHEMA,resolveScene,scopedAddressKey} from './hierarchy.mjs';
import {hierarchyRuntimeId} from './hierarchy-view.mjs';
import {inverse} from '../../packages/scene/transform.mjs';
import {sourceAnnotationContext,observedAnnotationContext} from './annotation-context.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';
import {nativeAddressKey,nativeMatrix} from './native-view.mjs';
import {nativeObjects,resolveNativeObject} from './native-reference.mjs';

// This validates a client's rendered observation, never an authoritative pose.
// Its caller must first verify the real world, frozen sequence and stop ACK.
export function inspectionObjects(manifest,scope,objects) {
  if(!Array.isArray(objects)||objects.length>1000)fail(400,'检查对象数据无效');
  const doc=manifest.resources[scope.resource_id];if(!doc)fail(404,'检查资源不存在');
  const hierarchy=manifest.schema===HIERARCHY_SCHEMA,native=manifest.schema===NATIVE_SCHEMA;
  const nativeRows=native?nativeObjects(manifest,scope):[];
  const rows=hierarchy?resolveScene(manifest,scope.resource_id,scope):[];
  const byAddress=new Map(rows.map(row=>[scopedAddressKey(row.address),row])),seen=new Set();
  return objects.map(o=>{
    if(!o||typeof o!=='object'||Array.isArray(o))fail(400,'检查对象数据无效');
    if(seen.has(o.id))fail(400,'检查对象重复');seen.add(o.id);
    if(native){
      if(!o.address)fail(409,'原生检查对象需要完整地址');
      const target=resolveNativeObject(manifest,scope,o.address,o.id,nativeRows);
      if(!target||(o.object_version??o.version)!==target.version||o.source_identity!=null&&o.source_identity!==manifest.source_identity)fail(409,'检查对象与固定原生源版本不一致');
      const observation={id:target.id,address:clone(target.address),object_version:target.version,source_identity:manifest.source_identity,dimension:target.dimension};
      if(o.dimension!=null&&o.dimension!==target.dimension)fail(409,'原生检查坐标维度与固定对象不一致');
      if(target.dimension==='2d'){
        // Canonical NativeGameSession observations call this actual global
        // Transform2D canvas_transform; the editor host uses world_transform_2d.
        // Normalize both wire shapes with the same matrix and scope checks.
        const value=o.world_transform_2d??o.canvas_transform;
        if(o.world_transform_2d!=null&&o.canvas_transform!=null&&JSON.stringify(o.world_transform_2d)!==JSON.stringify(o.canvas_transform))fail(422,'二维检查矩阵字段不一致');
        if(!Array.isArray(value)||value.length!==6||value.some(number=>!Number.isFinite(number)||Math.abs(number)>1e6))fail(422,'二维检查需要完整原生 Transform2D');
        const native_world_transform={$type:'Transform2D',x:value.slice(0,2),y:value.slice(2,4),origin:value.slice(4)};
        const matrix=nativeMatrix(native_world_transform);inverse(matrix);
        if(value.slice(4).some(number=>Math.abs(number)>10000))fail(422,'检查变换超出空间范围');
        Object.assign(observation,{world_transform_2d:clone(value),native_world_transform,position:[...value.slice(4),0]});
      }else if(target.dimension==='3d'){
        inverse(o.world_matrix);
        if(o.world_matrix.some(number=>Math.abs(number)>1e6)||o.world_matrix.slice(12,15).some(number=>Math.abs(number)>10000))fail(422,'检查变换超出空间范围');
        Object.assign(observation,{world_matrix:clone(o.world_matrix),position:o.world_matrix.slice(12,15)});
      }else observation.position=null;
      return observation;
    }
    if(hierarchy){
      if(!o.address||['project_id','branch_id','resource_id'].some(k=>o.address[k]!==scope[k]))fail(409,'检查对象地址不属于冻结场景');
      const row=byAddress.get(scopedAddressKey(o.address));
      if(!row||hierarchyRuntimeId(row.address)!==o.id||(o.object_version??o.version)!==row.object_version)fail(409,'检查对象与固定源版本不一致');
      inverse(o.world_matrix);
      if(o.world_matrix.slice(12,15).some(v=>Math.abs(v)>10000))fail(400,'检查变换超出空间范围');
      return{id:o.id,address:clone(row.address),object_version:row.object_version,world_matrix:clone(o.world_matrix),position:o.world_matrix.slice(12,15),model_hash:row.node.model_hash??null};
    }
    if(!doc.objects.some(n=>n.id===o.id))fail(400,'检查对象不在所见资源版本中');
    for(const key of ['position','rotation','scale'])if(!Array.isArray(o[key])||o[key].length!==3||!o[key].every(n=>Number.isFinite(n)&&Math.abs(n)<=36000))fail(400,'检查变换无效');
    return{id:o.id,position:clone(o.position),rotation:clone(o.rotation),scale:clone(o.scale),model_hash:o.model_hash};
  });
}

export function inspectionAttachment(manifest,inspection,input) {
  const scope={project_id:inspection.project_id,branch_id:inspection.branch_id,resource_id:inspection.resource_id};
  const doc=manifest.resources[scope.resource_id],hierarchy=manifest.schema===HIERARCHY_SCHEMA,native=manifest.schema===NATIVE_SCHEMA;
  let target,observed,extra={},row=null,rows=[];
  if(native){
    target=resolveNativeObject(manifest,scope,input.address,input.object_id);
    observed=target&&inspection.observations.find(value=>value.address&&nativeAddressKey(value.address)===nativeAddressKey(target.address));
    if(!target||!observed||observed.object_version!==target.version)fail(404,'检查记录中没有此原生实例对象');
    if(input.expected_version!==undefined&&input.expected_version!==target.version)fail(409,'检查附件版本已变化');
    if(input.expected_ancestry_hash!==undefined&&input.expected_ancestry_hash!==target.ancestry_hash)fail(409,'检查附件父级版本已变化');
    extra={node_version:target.node_version};
  }else if(hierarchy){
    if(!input.address||['project_id','branch_id','resource_id'].some(k=>input.address[k]!==scope[k]))fail(409,'检查附件需要固定的完整地址');
    const key=scopedAddressKey(input.address);rows=resolveScene(manifest,scope.resource_id,scope);row=rows.find(r=>scopedAddressKey(r.address)===key);
    observed=inspection.observations.find(o=>o.address&&scopedAddressKey(o.address)===key);
    if(!row||!observed||observed.object_version!==row.object_version)fail(404,'检查记录中没有此实例对象');
    if(input.expected_version&&input.expected_version!==row.object_version)fail(409,'检查附件版本已变化');
    target={...row.node,id:row.address.instance_path.length?null:row.node.id,version:row.object_version};
    extra={address:clone(row.address),resource_version:doc.version,definition_revision:row.definition_revision,node_version:row.node.version,
      local_transform:clone(row.local_transform),world_matrix:clone(observed.world_matrix),source_world_matrix:clone(row.world_matrix),ancestry_hash:row.ancestry_hash};
  }else{
    target=doc?.objects.find(o=>o.id===input.object_id);observed=inspection.observations.find(o=>o.id===input.object_id);
    if(!target||!observed)fail(404,'检查记录中没有该对象');
    if(input.expected_version&&input.expected_version!==target.version)fail(409,'检查附件版本已变化');
  }
  const context=sourceAnnotationContext({manifest,scope,source_revision:inspection.revision,target,row,rows,camera:input.camera});
  return{id:id('attachment'),...scope,revision:inspection.revision,source_revision:inspection.revision,object_id:target.id,object_version:target.version,...extra,
    kind:'object_observation',snapshot:clone(target),captured_at:Date.now(),...observedAnnotationContext(context,observed),
    observation:{source_revision:inspection.revision,world_id:inspection.world_id,epoch:inspection.epoch,sequence:inspection.sequence,runtime_build_id:inspection.runtime_build_id??null,state_hash:inspection.state_hash,
      inspection_id:inspection.id,stop_ack_sequence:inspection.stop_ack_sequence,input_zero_seq:inspection.input_zero_seq,rendered_transform:clone(observed),source:'client rendered observation; world boundary and stop acknowledgement verified'}};
}
