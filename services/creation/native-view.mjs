import {clone,fail,hash,stable} from './schema.mjs';
import {worldTransform} from '../../packages/scene/transform.mjs';
import {eulerDegrees,hierarchyRuntimeId} from './hierarchy-view.mjs';
import {nativeControlLayout} from './native-control-compat.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';

export const nativeTarget=node=>node.metadata?.wa_instance_mount
  ?{mount:true,instance_ids:clone(node.instance_ids??[])}
  :{node_id:node.node_id,instance_ids:clone(node.instance_ids??[])};
export const nativeAddressKey=target=>stable(target.mount||target.metadata?.wa_instance_mount
  ?['mount',target.instance_ids??target.instance_path??[]]
  :['node',target.instance_ids??target.instance_path??[],target.node_id??target.definition_node_id]);
const parentPath=path=>path==='.'?null:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.';
const property=(node,name)=>node.properties?.find(p=>p.name===name)?.value;
export function nativeMatrix(value){
  const v=entry=>entry?.value??entry;
  if(value?.$type==='Transform3D'){
    const [x,y,z]=value.basis.map(v),p=v(value.origin);
    return [...x,0,...y,0,...z,0,...p,1];
  }
  if(value?.$type==='Transform2D'){
    const x=v(value.x),y=v(value.y),p=v(value.origin);
    return [x[0],x[1],0,0,y[0],y[1],0,0,0,0,1,0,p[0],p[1],0,1];
  }
  return null;
}

/** Read-only engine projection shared by the explorer, attachments and debug
 * bridge. No nodes, inheritance, resources or transforms are reconstructed for
 * gameplay from these rows; runtime resolves native_path on the actual scene. */
export function nativeObjectViews(manifest,rid,{project_id,branch_id}={}){
  const doc=manifest.resources[rid];if(!doc)fail(404,'原生资源不存在');
  const nodes=doc.native_nodes??[],byPath=new Map(nodes.map(n=>[n.path,n])),visible=new Map(),result=[];
  const resourceByPath=new Map(Object.values(manifest.resources).map(r=>['res://'+r.path.replace(/^res:\/\//,''),r.id]));
  const technical=node=>Boolean(node.metadata?.wa_component||node.metadata?.wa_asset_model);
  for(const node of nodes){
    if(!node.addressable||node.metadata?.wa_instance_mount)continue;
    let at=node,hidden=false,definition=rid;
    while(at){
      if(technical(at)){hidden=true;break;}
      if(definition===rid&&at.scene_file_path&&resourceByPath.has(at.scene_file_path))definition=resourceByPath.get(at.scene_file_path);
      at=byPath.get(parentPath(at.path));
    }
    if(hidden)continue;
    const parent=byPath.get(parentPath(node.path));let mount=parent?.metadata?.wa_instance_mount?parent:null;
    if(!mount&&node.metadata?.wa_legacy_object_id){let ancestor=parent;while(ancestor){if(ancestor.metadata?.wa_instance_mount&&ancestor.metadata.wa_legacy_object_id===node.metadata.wa_legacy_object_id){mount=ancestor;break;}ancestor=byPath.get(parentPath(ancestor.path));}}
    if(mount?.metadata?.wa_legacy_object_id&&!node.metadata?.wa_legacy_object_id&&nodes.some(child=>child.path.startsWith(node.path+'/')&&child.metadata?.wa_legacy_object_id===mount.metadata.wa_legacy_object_id))continue;
    const instance=node.instance_ids?.length>0,target=nativeTarget(node);
    const id=String(instance&&!node.metadata?.wa_legacy_flat_instance?hierarchyRuntimeId({instance_path:node.instance_ids,definition_node_id:node.node_id}):node.metadata?.wa_legacy_object_id??node.node_id);
    if(result.some(row=>row.id===id))fail(422,'原生对象展示身份重复',{resource_id:rid,object_id:id});
    const matrix=nativeMatrix(node.world_transform),localMatrix=nativeMatrix(node.local_transform),controlLayout=nativeControlLayout(node,parent);
    let world=null,local=null;try{if(matrix)world=worldTransform(matrix);if(localMatrix)local=worldTransform(localMatrix);}catch{}
    const address={...(project_id?{project_id}:{}),...(branch_id?{branch_id}:{}),resource_id:rid,instance_path:clone(target.instance_ids),definition_node_id:node.node_id};
    const object={id,name:String(mount?.metadata?.wa_label??node.metadata?.wa_label??node.name),type:node.type,
      kind:node.metadata?.wa_author_kind??property(node,'author_kind')??'node',version:node.version,node_version:node.version,
      source_node_id:node.node_id,native_path:node.path,native_target:target,address,
      ...(mount?{native_mount_target:nativeTarget(mount)}:{}),definition_resource_id:definition,
      ...(instance?{prefab:definition,instance_root:Boolean(mount||node.scene_file_path)}:{}),
      dimension:controlLayout?'2d':node.world_transform?.$type==='Transform3D'?'3d':node.world_transform?.$type==='Transform2D'?'2d':null,
      position:world?.position??matrix?.slice(12,15)??[0,0,0],rotation:world?eulerDegrees(world.rotation):[0,0,0],scale:world?.scale??[1,1,1],
      world_matrix:matrix,local_transform:local,native_local_transform:clone(node.local_transform),has_world_shear:Boolean(matrix&&!world),
      native_edit_transform:controlLayout?.container_managed?null:clone(mount?.transform??node.transform??null),
      ...(controlLayout?{control_layout:controlLayout}:{}),
      native_edit_world_matrix:nativeMatrix((mount??node).world_transform),
      native_can_edit_structure:node.path!=='.'&&(mount?.owner_path??node.owner_path)==='.',
      ancestry_hash:hash({key:node.key,world_matrix:matrix,source:doc.version}),
      components:{},solid:false,parent_id:null};
    visible.set(node.path,object);result.push(object);
  }
  for(const row of result){let path=parentPath(row.native_path);while(path!==null&&!visible.has(path))path=parentPath(path);row.parent_id=visible.get(path)?.id??null;}
  return result;
}

export function nativeScenePacket(manifest,rid,{project_id,branch_id,revision,origin=''}={}){
  const doc=manifest.resources[rid];if(!doc)fail(404,'原生场景不存在');
  return {origin,document_id:`${project_id}/${branch_id}/${rid}`,project_id,branch_id,resource_id:rid,name:doc.name,kind:doc.kind,
    scene_revision:revision,document_schema:NATIVE_SCHEMA,native_scene_path:'res://'+doc.path.replace(/^res:\/\//,''),
    source_identity:manifest.source_identity,objects:nativeObjectViews(manifest,rid,{project_id,branch_id})};
}
