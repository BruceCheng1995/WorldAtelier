import {normalizeDesign,normalizeKnowledge,validateDesignBindings,validateDesignRelations,validatePropertyValue} from './semantic-design.mjs';
import {clone,fail,hash,identifier,name,object,stable} from './schema.mjs';
import {identity,identityTransform,normalizeTransform,matrix,multiply,worldTransform,quaternionFromEulerDegrees} from '../../packages/scene/transform.mjs';

export const HIERARCHY_SCHEMA='creation-hierarchy-2';
const MAX_NODES=400,MAX_EXPANDED=4000,MAX_DEPTH=32;
const own=(o,k)=>Object.hasOwn(o,k);
const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
const insist=(ok,code,details)=>{if(!ok)fail(422,code,details);};
// Local lookup key only; cross-resource caches must use scopedAddressKey.
export const scopedAddressKey=address=>JSON.stringify([identifier(address.project_id),identifier(address.branch_id),identifier(address.resource_id),target(address).instance_path,address.definition_node_id]);
export const addressKey=address=>JSON.stringify([...(address.instance_path??[]),address.definition_node_id]);
export const nodeTarget=id=>({instance_path:[],definition_node_id:id});
export function target(value) {
  insist(record(value)&&Array.isArray(value.instance_path)&&value.instance_path.length<=MAX_DEPTH,'invalid_object_address');
  return {instance_path:value.instance_path.map(v=>identifier(v,'实例路径')),definition_node_id:identifier(value.definition_node_id,'定义节点')};
}
const withoutVersion=value=>{const result=clone(value);delete result.version;return result;};
export const contentVersion=value=>hash(withoutVersion(value));
export function normalizeNode(value,allowed=()=>false) {
  insist(record(value),'invalid_node');
  insist(!['children','matrix','world_matrix','position','rotation','scale'].some(key=>own(value,key)),'unsupported_node_structure');
  const t=normalizeTransform(value.transform);
  const parent=value.parent_id===null?null:identifier(value.parent_id,'父节点');
  let node;
  if(value.kind==='group') {
    insist(!value.model_hash&&!value.model_url&&!value.solid&&Object.keys(value.components??{}).length===0,'unsupported_group_content');
    node={...clone(value),id:identifier(value.id),name:name(value.name),kind:'group',components:{},solid:false};
  } else {
    // Keep the existing asset and behavior validator, without treating local TRS as legacy Euler values.
    node=object({...value,parent_id:null,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]},allowed);
  }
  if(value.color!==undefined)insist(/^#[0-9a-fA-F]{6}$/.test(value.color),'invalid_color');
  delete node.position;delete node.rotation;delete node.scale;delete node.version;
  node.parent_id=parent;node.transform=t;node.version=contentVersion(node);return node;
}
export function overrideKey(value) {return stable([target(value.target),value.path]);}
export function normalizeOverride(value) {
  insist(record(value)&&Array.isArray(value.path)&&value.path.length>0&&value.path.length<=8,'invalid_override');
  const path=value.path;
  insist(path.every(v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)),'invalid_override_path');
  insist(['transform','name','color','solid','model_hash','model_url','components'].includes(path[0]),'unsupported_override_field');
  insist(path[0]==='components'?path.length>=2:path.length===1,'atomic_override_field');
  insist(!(path[0]==='components'&&path[1]==='behaviors')||path.length===2,'behavior_list_is_atomic');
  insist(own(value,'value')&&stable(value.value)!==undefined,'missing_override_value');
  return {target:target(value.target),path:[...path],value:clone(value.value)};
}
export function normalizeInstance(value) {
  insist(record(value),'invalid_instance');
  insist(Object.keys(value).every(key=>['instance_id','name','prefab_id','prefab_revision','parent_id','transform','overrides','version'].includes(key)),'unsupported_instance_structure');
  const instance={instance_id:identifier(value.instance_id),prefab_id:identifier(value.prefab_id),prefab_revision:value.prefab_revision,parent_id:identifier(value.parent_id),transform:normalizeTransform(value.transform),overrides:[]};
  if(value.name!==undefined)instance.name=name(value.name);
  insist(typeof value.prefab_revision==='string'&&/^[a-f0-9]{64}$/.test(value.prefab_revision),'invalid_prefab_revision');
  insist(Array.isArray(value.overrides)&&value.overrides.length<=400,'invalid_overrides');
  const seen=new Set();
  instance.overrides=value.overrides.map(o=>{const result=normalizeOverride(o),key=overrideKey(result);insist(!seen.has(key),'duplicate_override');seen.add(key);return result;}).sort((a,b)=>overrideKey(a).localeCompare(overrideKey(b)));
  // Overlapping paths would give order-dependent semantics; require one atomic override instead.
  for(let i=0;i<instance.overrides.length;i++)for(let j=i+1;j<instance.overrides.length;j++){
    const a=instance.overrides[i],b=instance.overrides[j];
    insist(addressKey(a.target)!==addressKey(b.target)||!a.path.every((v,k)=>v===b.path[k])&&!b.path.every((v,k)=>v===a.path[k]),'overlapping_overrides');
  }
  instance.version=contentVersion(instance);return instance;
}
export function normalizeDocument(value,allowed) {
  insist(record(value)&&value.schema===2&&['scene','prefab'].includes(value.kind),'invalid_hierarchy_document');
  const doc={...clone(value),id:identifier(value.id),kind:value.kind,name:name(value.name),root_id:identifier(value.root_id),nodes:{},instances:{}};
  delete doc.objects;delete doc.version;
  if(value.design!==undefined)doc.design=normalizeDesign(value.design);
  insist(!own(value,'objects'),'mixed_flat_hierarchy_document');
  insist(record(value.nodes)&&record(value.instances),'invalid_hierarchy_maps');
  insist(Object.keys(value.nodes).length-1+Object.keys(value.instances).length<=MAX_NODES,'too_many_local_nodes');
  for(const [key,node]of Object.entries(value.nodes)){identifier(key);insist(key===node.id,'node_key_mismatch');doc.nodes[key]=normalizeNode(node,allowed);}
  for(const [key,instance]of Object.entries(value.instances)){identifier(key);insist(key===instance.instance_id&&!own(doc.nodes,key),'instance_key_mismatch');doc.instances[key]=normalizeInstance(instance);}
  insist(doc.nodes[doc.root_id]?.parent_id===null&&doc.nodes[doc.root_id].kind==='group','invalid_root');
  const visiting=new Set(),done=new Map();
  const walk=(id,depth=0)=>{
    insist(depth<=MAX_DEPTH,'hierarchy_depth_exceeded');if(done.has(id))return done.get(id);
    insist(!visiting.has(id),'hierarchy_cycle');const node=doc.nodes[id];insist(node,'missing_parent',{node_id:id});visiting.add(id);
    let distance=0;
    if(id!==doc.root_id){insist(node.parent_id!==null,'multiple_roots');distance=1+walk(node.parent_id,depth+1);}
    insist(distance<=MAX_DEPTH,'hierarchy_depth_exceeded');visiting.delete(id);done.set(id,distance);return distance;
  };
  for(const id of Object.keys(doc.nodes))walk(id);
  for(const instance of Object.values(doc.instances))insist(own(doc.nodes,instance.parent_id),'missing_instance_parent');
  doc.version=contentVersion(doc);return doc;
}
export function emptyDocument(id,kind='scene',label='新场景') {
  const root='root';return {schema:2,id,kind,name:label,root_id:root,nodes:{[root]:{id:root,name:label,kind:'group',parent_id:null,transform:identityTransform(),components:{},solid:false}},instances:{}};
}
function getPath(value,path) {
  let next=value;
  for(const key of path){if(!record(next)||!own(next,key))return {exists:false};next=next[key];}
  return {exists:true,value:next};
}
export {getPath};
const valueType=value=>Array.isArray(value)?'array':value===null?'null':typeof value;
export function writeOverride(node,override) {
  const found=getPath(node,override.path);
  insist(found.exists,'override_field_missing',{override});
  insist(valueType(found.value)===valueType(override.value),'override_type_changed',{override});
  let cursor=node;for(const key of override.path.slice(0,-1))cursor=cursor[key];cursor[override.path.at(-1)]=clone(override.value);
}
export function resolveScene(manifest,resourceId,{project_id=null,branch_id=null,assetAllowed=()=>true}={}) {
  insist(manifest.schema===HIERARCHY_SCHEMA,'hierarchy_schema_required');
  const source=manifest.resources[resourceId];insist(source,'missing_resource');
  const rows=[],byAddress=new Map(),used=new Set(),expected=new Set();
  function expand(doc,path,parentWorld,parentKey,chain,prefabStack,layers,depth) {
    insist(depth<=MAX_DEPTH,'instance_depth_exceeded');
    const nodes=new Map();
    function visit(id) {
      if(nodes.has(id))return nodes.get(id);
      const original=doc.nodes[id];insist(original,'missing_definition_node');
      const parent=id===doc.root_id?null:visit(original.parent_id);
      let node=clone(original);
      const mount=layers.at(-1);
      if(id===doc.root_id&&mount?.instance.name!==undefined)node.name=mount.instance.name;
      for(const layer of [...layers].reverse())for(const [i,override]of layer.instance.overrides.entries()){
        const wanted=[...layer.path,...override.target.instance_path];
        if(stable(wanted)===stable(path)&&override.target.definition_node_id===id){writeOverride(node,override);used.add(layer.key+':'+i);}
      }
      node=normalizeNode(node,assetAllowed);
      const address={project_id,branch_id,resource_id:resourceId,instance_path:[...path],definition_node_id:id};
      const key=addressKey(address),ancestry=parent?parent.chain:chain;
      const localChain=[...ancestry,{address:target(address),parent_id:node.parent_id,transform:node.transform}];
      const world=multiply(parent?.world_matrix??parentWorld,matrix(node.transform));
      insist(world.every(Number.isFinite),'world_transform_overflow');
      const row={address,key,parent_key:parent?.key??parentKey,node,definition_resource_id:doc.id,definition_revision:doc.version,
        local_transform:node.transform,parent_world_matrix:parent?.world_matrix??parentWorld,world_matrix:world,world_transform:worldTransform(world),world_position:world.slice(12,15),
        object_version:hash({node:withoutVersion(node),dependencies:layers.map(l=>({path:l.path,revision:l.instance.prefab_revision,version:l.instance.version}))}),
        ancestry_hash:hash(ancestry),chain:localChain};
      insist(!byAddress.has(key),'duplicate_resolved_address');rows.push(row);byAddress.set(key,row);nodes.set(id,row);
      insist(rows.length<=MAX_EXPANDED,'expanded_node_limit');return row;
    }
    Object.keys(doc.nodes).forEach(visit);
    for(const instance of Object.values(doc.instances)) {
      const definition=manifest.prefab_revisions[instance.prefab_revision];
      insist(definition&&definition.kind==='prefab'&&definition.id===instance.prefab_id&&definition.version===instance.prefab_revision,'missing_pinned_prefab',{instance_id:instance.instance_id});
      insist(!prefabStack.includes(instance.prefab_id),'prefab_cycle',{prefab_id:instance.prefab_id});
      const parent=visit(instance.parent_id),nextPath=[...path,instance.instance_id];
      const key=stable(nextPath),layer={instance,path:nextPath,key};
      instance.overrides.forEach((_,i)=>expected.add(key+':'+i));
      expand(definition,nextPath,multiply(parent.world_matrix,matrix(instance.transform)),parent.key,
        [...parent.chain,{instance_path:nextPath,prefab_id:instance.prefab_id,prefab_revision:instance.prefab_revision,version:instance.version,transform:instance.transform}],
        [...prefabStack,instance.prefab_id],[...layers,layer],depth+1);
    }
  }
  expand(source,[],identity(),null,[],source.kind==='prefab'?[source.id]:[],[],0);
  for(const key of expected)insist(used.has(key),'override_target_missing',{override_key:key});
  return rows.map(({chain,...row})=>row);
}
export function prepareManifest(value,allowed=()=>false) {
  insist(value?.schema===HIERARCHY_SCHEMA&&record(value.resources)&&record(value.prefab_revisions),'invalid_hierarchy_manifest');
  const manifest={...clone(value),resources:{},prefab_revisions:{}};
  if(value.knowledge!==undefined)manifest.knowledge=normalizeKnowledge(value.knowledge);
  insist(Object.keys(value.resources).length<=200&&Object.keys(value.prefab_revisions).length<=4000,'resource_limit');
  for(const [rev,doc]of Object.entries(value.prefab_revisions)){
    const normalized=normalizeDocument(doc,allowed);insist(doc.kind==='prefab'&&normalized.version===rev,'immutable_prefab_hash_mismatch');manifest.prefab_revisions[rev]=normalized;
  }
  for(const [rid,doc]of Object.entries(value.resources)){
    insist(rid===doc.id,'resource_key_mismatch');manifest.resources[rid]=normalizeDocument(doc,allowed);
    if(doc.kind==='prefab')manifest.prefab_revisions[manifest.resources[rid].version]=clone(manifest.resources[rid]);
  }
  insist(manifest.resources[manifest.entry_scene_id]?.kind==='scene','entry_scene_missing');
  for(const document of Object.values(manifest.resources))validateDesignBindings(document);
  validateDesignRelations(manifest);
  for(const rid of Object.keys(manifest.resources)){
    const rows=resolveScene(manifest,rid,{assetAllowed:allowed});
    for(const row of rows){const definition=manifest.prefab_revisions[row.definition_revision]??manifest.resources[row.definition_resource_id];for(const property of definition?.design?.exposed_properties??[])if(property.binding.node_id===row.node.id){const behavior=row.node.components?.behaviors?.find(b=>b.id===property.binding.behavior_id);validatePropertyValue(property,behavior?.properties?.[property.binding.property_key]);}}
  }
  // Historical definitions remain independently valid, including dependencies no longer in the active directory.
  for(const doc of Object.values(manifest.prefab_revisions)){validateDesignBindings(doc);resolveScene({...manifest,resources:{...manifest.resources,[doc.id]:doc}},doc.id,{assetAllowed:allowed});}
  return manifest;
}
export function migrateFlatManifest(flat,allowed=()=>false) {
  insist(flat?.schema==='creation-flat-1','migration_requires_flat');
  const manifest={...clone(flat),schema:HIERARCHY_SCHEMA,entry_scene_id:flat.entry_scene_id,resources:{},prefab_revisions:{}};
  for(const old of Object.values(flat.resources)){
    const stem='hierarchy-root-'+hash(old.id).slice(0,24);let root=stem,counter=0;const ids=new Set(old.objects.map(o=>o.id));while(ids.has(root))root=stem+'-'+(++counter);
    const metadata=clone(old);delete metadata.objects;delete metadata.version;
    const doc={...metadata,...emptyDocument(old.id,old.kind,old.name),...(old.design!==undefined?{design:clone(old.design)}:{}),root_id:root,nodes:{},migration:{from_schema:'creation-flat-1',resource_version:old.version}};
    doc.nodes[root]={id:root,name:old.name,kind:'group',parent_id:null,transform:identityTransform(),components:{},solid:false};
    for(const object of old.objects){
      insist(object.parent_id==null,'flat_parent_unsupported');
      const node={...clone(object),parent_id:root,transform:{position:clone(object.position),rotation:quaternionFromEulerDegrees(object.rotation??[0,0,0]),scale:clone(object.scale??[1,1,1])}};
      delete node.position;delete node.rotation;delete node.scale;
      if(node.prefab){node.legacy_prefab={prefab_id:node.prefab,meaning:'unversioned_flat_copy'};delete node.prefab;}
      doc.nodes[node.id]=node;
    }
    manifest.resources[doc.id]=doc;
  }
  return prepareManifest(manifest,allowed);
}
