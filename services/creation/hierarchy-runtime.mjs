import {clone,fail,hash,identifier} from './schema.mjs';
import {HIERARCHY_SCHEMA,addressKey,prepareManifest,resolveScene} from './hierarchy.mjs';
import {matrix,multiply,transformPoint} from '../../packages/scene/transform.mjs';

export const HIERARCHY_RUNTIME_FORMAT='creation-runtime-hierarchy-2';
const LIMITS={max_expanded_nodes:1000,max_world_coordinate:10000,physics_policy:'orthogonal-box-uniform-sphere-v1'};
const CAPABILITIES=['hierarchy-runtime-2','explicit-instance-mounts','quaternion-local-trs','world-matrix-observation','fixed-asset-closure'];
const insist=(ok,code,details)=>{if(!ok)fail(422,code,details);};
const compare=(a,b)=>a<b?-1:a>b?1:0;
const objectId=(path,nodeId)=>path.length?'node-'+hash([path,nodeId]):nodeId;
const mountId=path=>'mount-'+hash(path);
const refKey=ref=>ref.kind+':'+ref.id;

function checkJSON(value,ancestors=new Set()) {
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){insist(Number.isFinite(value),'runtime_non_json_input');return;}
  insist(value&&typeof value==='object'&&(Array.isArray(value)||[Object.prototype,null].includes(Object.getPrototypeOf(value))),'runtime_non_json_input');
  insist(!ancestors.has(value),'runtime_non_json_input');ancestors.add(value);
  for(const child of Array.isArray(value)?value:Object.values(value))checkJSON(child,ancestors);
  ancestors.delete(value);
}
function checkPoint(point,details) {
  insist(point.every(Number.isFinite),'runtime_matrix_nonfinite',details);
  insist(point.every(v=>Math.abs(v)<=LIMITS.max_world_coordinate),'runtime_world_bounds',details);
}
function checkWorld(world,details) {
  insist(world.length===16&&world.every(Number.isFinite),'runtime_matrix_nonfinite',details);
  checkPoint(world.slice(12,15),details);
}
function checkPhysics(row) {
  const world=row.world_matrix,axes=[0,4,8].map(i=>world.slice(i,i+3)),lengths=axes.map(v=>Math.hypot(...v));
  const unit=axes.map((v,i)=>v.map(x=>x/lengths[i]));
  const dot=(i,j)=>unit[i].reduce((sum,x,k)=>sum+x*unit[j][k],0);
  const orthogonal=Math.max(Math.abs(dot(0,1)),Math.abs(dot(0,2)),Math.abs(dot(1,2)))<=1e-7;
  const uniform=(Math.max(...lengths)-Math.min(...lengths))/Math.max(...lengths)<=1e-7;
  for(const kind of ['collider','trigger','interactable']) {
    const component=row.node.components[kind];if(!component)continue;
    const details={address:row.address,component:kind};
    checkPoint(transformPoint(world,component.offset??[0,0,0]),details);
    const shape=component.shape??(kind==='collider'?'trimesh':'sphere');
    insist((kind==='collider'?['box','trimesh']:['box','sphere']).includes(shape),'runtime_component_shape_unsupported',details);
    if(shape==='sphere')insist(orthogonal&&uniform,'runtime_sphere_transform_unsupported',details);
    if(shape==='box')insist(orthogonal,'runtime_sheared_box_unsupported',details);
  }
}

/** Build an immutable-content read model. No asset bytes, IO, runtime ACK or live state. */
export function packHierarchyRuntime(manifest,options={}) {
  const {project_id,branch_id,resource_id,source_revision,assetAllowed}=options;
  for(const value of [project_id,branch_id,resource_id,source_revision])identifier(value);
  insist(typeof assetAllowed==='function','runtime_asset_validator_required');
  checkJSON(manifest);
  // Validate all source syntax and pinned hashes. Access checks apply to effective reachable assets below.
  const normalized=prepareManifest(manifest,()=>true),source=normalized.resources[resource_id];
  insist(source,'missing_resource');
  const contexts=new Map(),mountSpecs=[],prefabs=new Map();let count=0;
  function expand(doc,path,owner=null) {
    count+=Object.keys(doc.nodes).length+(owner?1:0);
    insist(count<=LIMITS.max_expanded_nodes,'runtime_expansion_limit',{count,limit:LIMITS.max_expanded_nodes});
    const context={doc,path,owner};contexts.set(JSON.stringify(path),context);
    if(owner)mountSpecs.push(context);
    for(const instance of Object.values(doc.instances).sort((a,b)=>compare(a.instance_id,b.instance_id))) {
      const definition=normalized.prefab_revisions[instance.prefab_revision];
      prefabs.set(instance.prefab_revision,{resource_id:definition.id,revision:instance.prefab_revision});
      expand(definition,[...path,instance.instance_id],{context,instance});
    }
  }
  expand(source,[]);
  // Reject async/truthy access check results: the pure pack API requires a synchronous boolean permit.
  const permitted=(digest,extension)=>assetAllowed(digest,extension)===true;
  const rows=resolveScene(normalized,resource_id,{project_id,branch_id,assetAllowed:permitted});
  const byKey=new Map(rows.map(row=>[row.key,row])),ids=new Set(),assets=new Map();
  function addAsset(digest,extension,url,address) {
    insist(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest)&&url===`/preview-assets/${digest}.${extension}`,'runtime_asset_reference',{address});
    // resolveScene already authorizes these effective model and script references.
    assets.set(extension+':'+digest,{hash:digest,extension,url});
  }
  const objects=rows.map(row=>{
    const path=row.address.instance_path,context=contexts.get(JSON.stringify(path)),node=row.node;
    const id=objectId(path,node.id);insist(!ids.has(id),'runtime_id_collision',{id,address:row.address});ids.add(id);
    const parent=node.parent_id===null?(path.length?{kind:'mount',id:mountId(path)}:null):{kind:'object',id:objectId(path,node.parent_id)};
    checkWorld(row.world_matrix,{address:row.address});checkWorld(row.parent_world_matrix,{address:row.address});checkPhysics(row);
    if(node.model_url||node.model_hash)addAsset(node.model_hash,'glb',node.model_url,row.address);
    for(const behavior of node.components.behaviors??[])addAsset(behavior.script_hash,'gd',behavior.script_url,row.address);
    return {id,parent,...row,definition_node_version:context.doc.nodes[node.id].version};
  }).sort((a,b)=>compare(a.id,b.id));
  const mounts=mountSpecs.map(({doc,path,owner})=>{
    const {context,instance}=owner;
    const parentRow=byKey.get(addressKey({instance_path:context.path,definition_node_id:instance.parent_id}));
    const rootRow=byKey.get(addressKey({instance_path:path,definition_node_id:doc.root_id}));
    const world=multiply(parentRow.world_matrix,matrix(instance.transform));
    const address={project_id,branch_id,resource_id,instance_path:[...path]};checkWorld(world,{address});
    return {id:mountId(path),key:JSON.stringify(path),parent:{kind:'object',id:objectId(context.path,instance.parent_id)},address,
      instance_id:instance.instance_id,owner_resource_id:context.doc.id,owner_revision:context.doc.version,
      prefab_id:instance.prefab_id,prefab_revision:instance.prefab_revision,instance_version:instance.version,
      local_transform:clone(instance.transform),parent_world_matrix:clone(parentRow.world_matrix),world_matrix:world,
      world_position:world.slice(12,15),ancestry_hash:rootRow.ancestry_hash};
  }).sort((a,b)=>compare(a.id,b.id));
  const all=new Map();
  for(const [kind,list]of [['object',objects],['mount',mounts]])for(const entry of list) {
    const ref={kind,id:entry.id},key=refKey(ref);insist(!all.has(key),'runtime_id_collision',{ref});all.set(key,{ref,entry});
  }
  const assembly_order=[],visiting=new Set(),done=new Set();
  function visit(key) {
    if(done.has(key))return;
    insist(!visiting.has(key),'runtime_parent_cycle');visiting.add(key);
    const item=all.get(key);insist(item,'runtime_missing_parent',{key});
    if(item.entry.parent)visit(refKey(item.entry.parent));
    assembly_order.push(item.ref);visiting.delete(key);done.add(key);
  }
  [...all.keys()].sort(compare).forEach(visit);
  const pack={schema:2,format:HIERARCHY_RUNTIME_FORMAT,source_schema:HIERARCHY_SCHEMA,
    project_id,branch_id,resource_id,source_revision,source_document_version:source.version,
    root:{kind:'object',id:source.root_id},required_capabilities:[...CAPABILITIES],limits:{...LIMITS},
    objects,mounts,assembly_order,
    prefab_closure:[...prefabs.values()].sort((a,b)=>compare(a.resource_id,b.resource_id)||compare(a.revision,b.revision)),
    asset_closure:[...assets.values()].sort((a,b)=>compare(a.extension,b.extension)||compare(a.hash,b.hash))};
  return {...pack,pack_hash:hash(pack)};
}
