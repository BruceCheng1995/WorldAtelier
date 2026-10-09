import {inverse,worldTransform} from '../../packages/scene/transform.mjs';
import {clone,fail} from './schema.mjs';
import {HIERARCHY_SCHEMA,addressKey,migrateFlatManifest,resolveScene,target} from './hierarchy.mjs';

// Call only with an authorized, immutable manifest selected by the domain's owning service.
// This helper never reads the moving source head or an online world's latest state.
export function resolveObjectReference({manifest,source_revision,domain,project_id,branch_id,observation=null},address) {
  if(!['source','applied','frozen'].includes(domain)||!source_revision)fail(422,'引用必须声明固定版本和 source/applied/frozen 域');
  if(address.project_id!==project_id||address.branch_id!==branch_id)fail(409,'引用作用域不匹配');
  if(domain!=='source'&&(!observation||observation.source_revision!==source_revision||!observation.world_id||!observation.epoch||!Number.isSafeInteger(observation.sequence)))fail(409,'所见世界引用缺少匹配的不可变观察基线');
  if(domain==='source'&&observation)fail(422,'源稿引用不能带世界观察');
  if(domain==='frozen'&&!observation.inspection_id)fail(409,'冻结引用需要检查快照 ID');
  const requested=target(address),legacy=manifest.schema==='creation-flat-1';
  if(legacy&&requested.instance_path.length)fail(409,'旧文档没有可证明的嵌套实例路径');
  const graph=legacy?migrateFlatManifest(manifest,()=>true):manifest;
  const row=resolveScene(graph,address.resource_id,{project_id,branch_id}).find(row=>addressKey(row.address)===addressKey(requested));
  if(!row)fail(410,'引用节点已删除或实例路径失效');
  const original=legacy?manifest.resources[address.resource_id]?.objects.find(o=>o.id===address.definition_node_id):null;
  if(legacy&&!original)fail(410,'旧文档中不存在此对象');
  let observed_pose=null;
  if(domain!=='source'){
    const observed=observation.object_world_matrix;
    if(!Array.isArray(observed)||observed.length!==16)fail(409,'世界观察缺少此对象的实际变换');
    inverse(observed); // Validate a finite, invertible affine observation without converting it into source layout.
    observed_pose={world_matrix:clone(observed),world_position:observed.slice(12,15),world_transform:worldTransform(observed)};
  }
  const {world_matrix,world_position,world_transform,parent_world_matrix,local_transform,...identityFields}=row;
  return {...identityFields,source_pose:{world_matrix,world_position,world_transform,parent_world_matrix,local_transform},observed_pose,object_version:original?.version??row.object_version,source_revision,resource_version:manifest.resources[address.resource_id].version,
    document_schema:manifest.schema,domain,observation:clone(observation),snapshot:clone(original??row.node)};
}
export function assertHierarchyRuntimeCompatibility(manifest,capabilities={}) {
  if(manifest.schema===HIERARCHY_SCHEMA&&!capabilities.document_schemas?.includes(HIERARCHY_SCHEMA))fail(422,'当前客户端尚不支持此层级源稿，请等待匹配运行适配；已在线的旧版本继续运行',{code:'hierarchy_runtime_unavailable',required_schema:HIERARCHY_SCHEMA});
}
