import {numberedInstanceName} from './instance-names.mjs';
import {normalizeDesign,applyKnowledgeOperation} from './semantic-design.mjs';
import {clone,fail,hash,identifier,name,stable} from './schema.mjs';
import {HIERARCHY_SCHEMA,contentVersion,normalizeDocument,normalizeInstance,normalizeNode,normalizeOverride,overrideKey,prepareManifest,resolveScene,addressKey,nodeTarget,target} from './hierarchy.mjs';
import {upgradeInstance} from './hierarchy-prefabs.mjs';
import {decompose,inverse,matrix,multiply,normalizeTransform} from '../../packages/scene/transform.mjs';
const checkVersion=(actual,expected,current)=>{if((actual??null)!==(expected??null))fail(409,'目标已变化，请检查后重试',{current:current??null});};
function rowFor(manifest,rid,id){const row=resolveScene(manifest,rid).find(r=>addressKey(r.address)===addressKey(nodeTarget(id)));if(!row)fail(404,'节点不存在');return row;}
function checkAncestry(row,expected){if(!expected||row.ancestry_hash!==expected)fail(409,'祖先变换已变化，请重新换算',{current_ancestry_hash:row.ancestry_hash});}
const guardPatch=patch=>{if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>['id','version','parent_id','position','rotation','scale'].includes(k)))fail(422,'身份与父级须使用专用操作');};
export function applyHierarchyOps(original,ops,allowed,{source_revision=null}={}) {
  let manifest=clone(original);const changed=new Set(),inverseOps=[];
  for(const op of ops){
    if(['put_knowledge','delete_knowledge'].includes(op.type)){inverseOps.unshift(applyKnowledgeOperation(manifest,op));continue;}
    const rid=identifier(op.resource_id),doc=manifest.resources[rid];let undo;
    if(op.type==='create_resource'){
      if(doc)fail(409,'资源已存在');manifest.resources[rid]=normalizeDocument({...op.resource,id:rid},allowed);
      undo={type:'delete_resource',resource_id:rid,expected_version:manifest.resources[rid].version};
    }else if(op.type==='delete_resource'){
      checkVersion(doc?.version,op.expected_version,doc);if(!doc)fail(404,'资源不存在');
      if(manifest.entry_scene_id===rid)fail(422,'不能删除入口场景');delete manifest.resources[rid];
      undo={type:'create_resource',resource_id:rid,resource:doc};
    }else{
      if(!doc)fail(404,'资源不存在');
      if(op.type==='rename_resource'){
        checkVersion(doc.version,op.expected_version,doc);
        if(typeof op.name!=='string')fail(400,'名称须为 1–160 个字符');
        const previous=doc.name;doc.name=name(op.name);doc.version=contentVersion(doc);
        undo={type:'rename_resource',resource_id:rid,expected_version:doc.version,name:previous};
      }else if(op.type==='set_resource_design'){
        checkVersion(doc.version,op.expected_version,doc);const previous=clone(doc.design);
        if(op.design===null)delete doc.design;else doc.design=normalizeDesign(op.design);doc.version=contentVersion(doc);
        undo={type:'set_resource_design',resource_id:rid,expected_version:doc.version,design:previous??null};
      }else if(op.type==='restore_document'){
        checkVersion(doc.version,op.expected_version,doc);
        manifest.resources[rid]=normalizeDocument({...op.document,id:rid},allowed);
        undo={type:'restore_document',resource_id:rid,expected_version:manifest.resources[rid].version,document:doc};
      }else if(['put_node','patch_node','delete_node','reparent_node','set_node_world_transform'].includes(op.type)){
        const nid=identifier(op.node_id??op.node?.id),existing=doc.nodes[nid];checkVersion(existing?.version,op.expected_version,existing);
        if(op.type!=='put_node'&&!existing)fail(404,'节点不存在');
        const previous=clone(doc);
        if(op.type==='delete_node'){
          if(nid===doc.root_id)fail(422,'不能删除根节点');
          const deleting=new Set([nid]);let added=true;
          while(added){added=false;for(const node of Object.values(doc.nodes))if(deleting.has(node.parent_id)&&!deleting.has(node.id)){deleting.add(node.id);added=true;}}
          const childInstances=Object.values(doc.instances).filter(i=>deleting.has(i.parent_id));
          if((deleting.size>1||childInstances.length)&&op.cascade!==true)fail(409,'节点有子内容，删除须明确 cascade');
          for(const id of deleting)delete doc.nodes[id];for(const i of childInstances)delete doc.instances[i.instance_id];
          doc.version=contentVersion(doc);undo={type:'restore_document',resource_id:rid,expected_version:doc.version,document:previous};
        }else{
          let next;
          if(op.type==='put_node'){
            if(existing&&op.node.parent_id!==existing.parent_id)fail(422,'重挂须使用 reparent_node');
            next={...op.node,id:nid};
          }else if(op.type==='patch_node'){
            guardPatch(op.patch);next={...existing,...op.patch};
          }else if(op.type==='set_node_world_transform'){
            const row=rowFor(manifest,rid,nid);checkAncestry(row,op.expected_ancestry_hash);
            if(Boolean(op.world_transform)===Boolean(op.world_matrix))fail(422,'请提供唯一的世界 TRS 或矩阵');
            const parent=existing.parent_id?rowFor(manifest,rid,existing.parent_id):null;
            const world=op.world_matrix??matrix(op.world_transform);
            next={...existing,transform:decompose(parent?multiply(inverse(parent.world_matrix),world):world)};
          }else{
            if(nid===doc.root_id)fail(422,'不能重挂根节点');
            const row=rowFor(manifest,rid,nid),parent=rowFor(manifest,rid,identifier(op.parent_id));
            checkAncestry(row,op.expected_ancestry_hash);checkAncestry(parent,op.expected_parent_ancestry_hash);checkVersion(parent.node.version,op.expected_parent_version,parent.node);
            if(typeof op.keep_world!=='boolean')fail(422,'重挂须声明 keep_world');
            next={...existing,parent_id:op.parent_id,transform:op.keep_world?decompose(multiply(inverse(parent.world_matrix),row.world_matrix)):existing.transform};
          }
          doc.nodes[nid]=normalizeNode(next,allowed);doc.version=contentVersion(doc);
          // Topology undo checks the whole document, so it cannot accidentally detach a newly added child.
          undo=op.type==='reparent_node'?{type:'restore_document',resource_id:rid,expected_version:doc.version,document:previous}:existing?
            {type:'put_node',resource_id:rid,node_id:nid,expected_version:doc.nodes[nid].version,node:existing}:
            {type:'delete_node',resource_id:rid,node_id:nid,expected_version:doc.nodes[nid].version,cascade:false};
        }
      }else if(['instantiate_prefab','patch_instance','delete_instance','set_override','set_overrides','set_override_world_transform','remove_override','upgrade_instance','restore_instance','reparent_instance'].includes(op.type)){
        const iid=identifier(op.instance_id??op.instance?.instance_id),existing=doc.instances[iid];
        checkVersion(existing?.version,op.expected_version,existing);
        if(op.type!=='instantiate_prefab'&&!existing)fail(404,'实例不存在');
        if(op.type==='instantiate_prefab'&&existing)fail(409,'实例已存在');
        if(op.type==='delete_instance')delete doc.instances[iid];
        else{
          let next=clone(existing);
          if(op.type==='instantiate_prefab'){
            next={...op.instance,instance_id:iid};
            // Saved inverse payloads carry their original version and must keep
            // their exact name, including historical instances without a name.
            if(next.name===undefined&&next.version===undefined){
              const definition=manifest.prefab_revisions[next.prefab_revision];
              const names=[...Object.values(doc.nodes).map(node=>node.name),...Object.values(doc.instances).map(instance=>instance.name??manifest.prefab_revisions[instance.prefab_revision]?.name)];
              next.name=numberedInstanceName(definition?.name??next.prefab_id,names);
            }
          }
          else if(op.type==='restore_instance')next={...op.instance,instance_id:iid};
          else if(op.type==='patch_instance'){
            if(!op.patch||typeof op.patch!=='object'||Array.isArray(op.patch)||!Object.keys(op.patch).length||Object.keys(op.patch).some(k=>!['transform','name'].includes(k)))fail(422,'实例普通修改仅支持名称与挂载变换');
            if(Object.hasOwn(op.patch,'transform'))next.transform=normalizeTransform(op.patch.transform);
            if(Object.hasOwn(op.patch,'name')){
              next.name=op.patch.name;
              const root=manifest.prefab_revisions[existing.prefab_revision]?.root_id;
              next.overrides=next.overrides.filter(override=>!(override.target.instance_path.length===0&&override.target.definition_node_id===root&&override.path.length===1&&override.path[0]==='name'));
            }
          }else if(op.type==='reparent_instance'){
            const oldParent=rowFor(manifest,rid,existing.parent_id),newParent=rowFor(manifest,rid,identifier(op.parent_id));
            checkAncestry(oldParent,op.expected_ancestry_hash);checkVersion(oldParent.node.version,op.expected_old_parent_version,oldParent.node);
            checkAncestry(newParent,op.expected_parent_ancestry_hash);checkVersion(newParent.node.version,op.expected_parent_version,newParent.node);
            if(typeof op.keep_world!=='boolean')fail(422,'重挂须声明 keep_world');
            next.parent_id=op.parent_id;
            if(op.keep_world)next.transform=decompose(multiply(inverse(newParent.world_matrix),multiply(oldParent.world_matrix,matrix(existing.transform))));
          }else if(op.type==='set_override_world_transform'){
            const relative=target(op.target),address={instance_path:[iid,...relative.instance_path],definition_node_id:relative.definition_node_id};
            const row=resolveScene(manifest,rid).find(row=>addressKey(row.address)===addressKey(address));
            if(!row)fail(410,'实例内部节点已删除或路径失效');
            checkVersion(row.object_version,op.expected_object_version,row.node);checkAncestry(row,op.expected_ancestry_hash);
            if(Boolean(op.world_transform)===Boolean(op.world_matrix))fail(422,'请提供唯一的世界 TRS 或矩阵');
            const value=decompose(multiply(inverse(row.parent_world_matrix),op.world_matrix??matrix(op.world_transform)));
            const override={target:relative,path:['transform'],value},key=overrideKey(override);next.overrides=next.overrides.filter(item=>overrideKey(item)!==key);next.overrides.push(override);
          }else if(op.type==='upgrade_instance'){
            next=upgradeInstance(manifest,rid,iid,op.prefab_revision,{source_revision,expected_preview_hash:op.expected_preview_hash,resolutions:op.resolutions});
          }else{
            const overrides=op.type==='set_overrides'?op.overrides:[op.override];
            if(!Array.isArray(overrides)||!overrides.length||overrides.length>400)fail(422,'覆盖列表无效');
            for(const value of overrides){
              const override=op.type==='remove_override'?value:normalizeOverride(value);
              const key=overrideKey(override);next.overrides=next.overrides.filter(o=>overrideKey(o)!==key);
              if(op.type!=='remove_override')next.overrides.push(override);
            }
          }
          doc.instances[iid]=normalizeInstance(next);
        }
        doc.version=contentVersion(doc);
        undo=existing?{type:op.type==='delete_instance'?'instantiate_prefab':'restore_instance',resource_id:rid,instance_id:iid,expected_version:doc.instances[iid]?.version??null,instance:existing}:
          {type:'delete_instance',resource_id:rid,instance_id:iid,expected_version:doc.instances[iid].version};
      }else fail(422,'层级文档不支持此操作：'+op.type);
      if(manifest.resources[rid])manifest.resources[rid]=normalizeDocument(manifest.resources[rid],allowed);
    }
    // Register new definitions for later operations in the same transaction; never overwrite a prior key.
    const updated=manifest.resources[rid];
    if(updated?.kind==='prefab'){
      const existing=manifest.prefab_revisions[updated.version];
      if(existing&&stable(existing)!==stable(updated))fail(409,'预制件固定版本不可修改');
      manifest.prefab_revisions[updated.version]=clone(updated);
    }
    changed.add(rid);inverseOps.unshift(undo);
  }
  // One candidate validation before publishing: a bad late op cannot leave a partial revision.
  manifest=prepareManifest(manifest,allowed);
  return {manifest,changed:[...changed],inverse:inverseOps};
}
