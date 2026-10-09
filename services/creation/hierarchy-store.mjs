import {clone,fail,hash,id,identifier,stable} from './schema.mjs';
import {HIERARCHY_SCHEMA,migrateFlatManifest,prepareManifest,resolveScene,addressKey,nodeTarget} from './hierarchy.mjs';
import {applyHierarchyOps} from './hierarchy-operations.mjs';
import {prefabImpact,previewInstanceUpgrade} from './hierarchy-prefabs.mjs';
import {sourceAnnotationContext} from './annotation-context.mjs';

function immutableArchive(previous,next) {
  for(const [rev,doc]of Object.entries(previous.prefab_revisions??{}))if(!next.prefab_revisions?.[rev]||stable(next.prefab_revisions[rev])!==stable(doc))fail(409,'预制件历史版本不可变',{prefab_revision:rev});
}
export function applyHierarchyTransaction(store,user,p,b,input,origin=null) {
  const branch=store.branchFor(user,p,b,true);
  if(origin){const run=store.get('creator_run',origin.run_id);if(!run||run.status!=='running'||run.lease_generation!==origin.lease_generation||run.owner_user_id!==user.id||run.project_id!==p||run.branch_id!==b)fail(409,'Agent 运行已取消、失联或失去写入租约');}
  identifier(input.transaction_id,'事务 ID');
  if(!Array.isArray(input.ops)||input.ops.length<1||input.ops.length>100)fail(400,'事务需包含 1–100 个操作');
  const receiptId=`${branch.id}:${input.transaction_id}`,fingerprint=hash({user_id:user.id,input,origin}),receipt=store.get('creator_receipt',receiptId);
  if(receipt){if(receipt.fingerprint!==fingerprint)fail(409,'同一事务 ID 不能使用不同内容');return {...receipt.result,replayed:true};}
  const base=store.get('creator_revision',input.base_revision);
  if(!base||base.project_id!==p||!store.ancestor(base.id,branch.head))fail(409,'缺少此分支的有效源基线');
  for(const op of input.ops)if(['restore_instance','restore_document'].includes(op.type)){
    const proof=store.get('creator_receipt',`${branch.id}:${op.inverse_transaction_id}`);
    if(!proof||proof.result.actor.id!==user.id||!proof.result.inverse.some(inverse=>stable(inverse)===stable(op)))fail(403,'恢复操作须使用本人已提交事务的原始逆操作');
  }
  const before=store.get('creator_revision',branch.head).manifest,allowed=(h,e)=>store.assetAllowed(p,h,e);
  let candidate;
  if(input.ops.some(o=>o.type==='migrate_hierarchy')){
    if(input.ops.length!==1||input.expected_head!==branch.head)fail(409,'迁移须独立提交并固定当前源版本');
    const manifest=migrateFlatManifest(before,allowed);candidate={manifest,changed:Object.keys(manifest.resources),inverse:[]};
  }else{
    if(before.schema!==HIERARCHY_SCHEMA||base.manifest.schema!==HIERARCHY_SCHEMA)fail(409,'协议基线已变化，请重新读取文档');
    if(input.ops.some(o=>o.type==='upgrade_instance')&&input.expected_head!==branch.head)fail(409,'升级影响预览已过期，请重新查看');
    candidate=applyHierarchyOps(before,input.ops,allowed,{source_revision:branch.head});
  }
  immutableArchive(before,candidate.manifest);
  candidate.inverse=candidate.inverse.map(op=>({...op,inverse_transaction_id:input.transaction_id}));
  return store.transaction(()=>{
    // All computation is synchronous; compare again immediately before publication.
    if(store.get('creator_branch',branch.id).head!==branch.head)fail(409,'提交前源版本变化');
    const revision=store.writeRevision(p,[branch.head],candidate.manifest,user.id,origin);
    branch.head=revision.id;for(const rid of candidate.changed)branch.doc_sequences[rid]=(branch.doc_sequences[rid]??0)+1;
    store.put('creator_branch',branch);
    const result={transaction_id:input.transaction_id,revision:revision.id,actor:user,changed_resources:candidate.changed,inverse:candidate.inverse,branch:{...branch,manifest:candidate.manifest}};
    store.put('creator_receipt',{id:receiptId,fingerprint,result});
    store.event(p,{type:'creation_committed',branch_id:b,revision:revision.id,transaction_id:input.transaction_id,actor:user,resource_ids:candidate.changed});return result;
  });
}
export function hierarchyMergeEntries(manifest) {
  const entries={'entry-scene':manifest.entry_scene_id};
  for(const [kid,entry]of Object.entries(manifest.knowledge??{}))entries[`knowledge/${kid}`]=clone(entry);
  for(const doc of Object.values(manifest.resources)){
    const meta=clone(doc);delete meta.nodes;delete meta.instances;delete meta.version;entries[`resource/${doc.id}`]=meta;
    for(const [nid,node]of Object.entries(doc.nodes)){const value=clone(node);delete value.version;entries[`node/${doc.id}/${nid}`]=value;}
    for(const [iid,instance]of Object.entries(doc.instances)){const value=clone(instance);delete value.version;entries[`instance/${doc.id}/${iid}`]=value;}
  }
  for(const [rev,doc]of Object.entries(manifest.prefab_revisions))entries[`prefab-revision/${rev}`]=doc;
  return entries;
}
export function mergeHierarchy(store,user,p,b,input) {
  const branch=store.branchFor(user,p,b,true),preview=store.get('creator_merge_preview',input.preview_id);
  if(!preview||preview.project_id!==p||preview.target_branch_id!==b)fail(404,'合并预览不存在');
  const source=store.branchFor(user,p,preview.source_branch_id);
  const receiptId=`merge:${p}:${b}:${preview.id}`,fingerprint=hash({user_id:user.id,resolutions:input.resolutions??{}}),receipt=store.get('creator_receipt',receiptId);
  if(receipt){if(receipt.fingerprint!==fingerprint)fail(409,'相同合并 ID 不能使用不同冲突决议');return {...receipt.result,replayed:true};}
  if(branch.head!==preview.target_revision||source.head!==preview.source_revision)fail(409,'预览后分支已变化，请重新比较');
  const previous=store.get('creator_revision',branch.head).manifest,sourceManifest=store.get('creator_revision',source.head).manifest;
  if(previous.schema!==HIERARCHY_SCHEMA||sourceManifest.schema!==HIERARCHY_SCHEMA)fail(409,'双方需先显式迁移到同一协议');
  const entries=hierarchyMergeEntries(previous),choices=input.resolutions??{};
  for(const change of preview.changes){
    const choice=change.conflict?choices[change.key]:'source';if(!['source','target'].includes(choice))fail(409,'请逐项解决合并冲突',{key:change.key});
    const value=change[choice];if(value===null)delete entries[change.key];else entries[change.key]=clone(value);
  }
  const manifest={schema:HIERARCHY_SCHEMA,entry_scene_id:entries['entry-scene'],resources:{},prefab_revisions:{}};
  for(const [key,value]of Object.entries(entries))if(key.startsWith('resource/'))manifest.resources[value.id]={...value,nodes:{},instances:{}};
  for(const [key,value]of Object.entries(entries)){
    const [kind,rid,nid]=key.split('/');
    if(['node','instance'].includes(kind)){
      const doc=manifest.resources[rid];if(!doc)fail(409,'删除资源与保留内部对象冲突',{resource_id:rid});
      doc[kind==='node'?'nodes':'instances'][nid]=value;
    }else if(kind==='knowledge'){manifest.knowledge??={};manifest.knowledge[rid]=value;}else if(kind==='prefab-revision')manifest.prefab_revisions[rid]=value;
  }
  immutableArchive(previous,manifest);immutableArchive(sourceManifest,manifest);
  const normalized=prepareManifest(manifest,(h,e)=>store.assetAllowed(p,h,e));
  return store.transaction(()=>{
    const revision=store.writeRevision(p,[branch.head,source.head],normalized,user.id,{merge_preview_id:preview.id});
    const changed=Object.keys({...previous.resources,...normalized.resources}).filter(rid=>previous.resources[rid]?.version!==normalized.resources[rid]?.version);
    branch.head=revision.id;for(const rid of changed)branch.doc_sequences[rid]=(branch.doc_sequences[rid]??0)+1;store.put('creator_branch',branch);
    const result={transaction_id:preview.id,revision:revision.id,actor:user,changed_resources:changed,inverse:[],branch:{...branch,manifest:normalized}};
    store.put('creator_receipt',{id:receiptId,fingerprint,result});store.event(p,{type:'creation_merged',branch_id:b,source_branch_id:source.branch_id,revision:revision.id,actor:user});return result;
  });
}
export function hierarchyPreview(store,user,p,b,input) {
  const branch=store.branchFor(user,p,b),manifest=store.get('creator_revision',branch.head).manifest;
  if(input.expected_head!==branch.head)fail(409,'预览需要固定当前源版本，请刷新后重试');
  if(input.instance_id)return previewInstanceUpgrade(manifest,input.resource_id,input.instance_id,input.prefab_revision,{source_revision:branch.head});
  return prefabImpact(manifest,input.prefab_id,input.prefab_revision,{source_revision:branch.head});
}
export function attachHierarchySource(store,user,sid,input) {
  const session=store.sessionFor(user,sid,true),branch=store.branchFor(user,session.project_id,session.branch_id),revision=store.get('creator_revision',input.revision);
  if(!revision||revision.project_id!==session.project_id||!store.ancestor(revision.id,branch.head))fail(409,'附件的源版本无效');
  if(input.observation)fail(422,'检查快照附件必须由世界服务验证后建立');
  const address=input.address??{resource_id:input.resource_id,...nodeTarget(input.object_id)};
  if((address.project_id&&address.project_id!==session.project_id)||(address.branch_id&&address.branch_id!==session.branch_id))fail(409,'附件作用域与会话不匹配');
  const rows=resolveScene(revision.manifest,address.resource_id,{project_id:session.project_id,branch_id:session.branch_id});
  const row=rows.find(r=>addressKey(r.address)===addressKey(address));
  if(!row||row.object_version!==input.expected_version)fail(409,'附件对象版本无效');
  const attachment={id:id('attachment'),project_id:session.project_id,branch_id:session.branch_id,resource_id:address.resource_id,revision:revision.id,
    address:row.address,instance_path:row.address.instance_path,definition_node_id:row.address.definition_node_id,object_id:row.address.instance_path.length?null:row.node.id,
    object_version:row.object_version,resource_version:revision.manifest.resources[address.resource_id].version,definition_revision:row.definition_revision,
    kind:row.node.kind==='anchor'?'spatial_anchor':'object',space:'scene_world',units:'metres',basis:'right_handed_y_up',snapshot:clone(row.node),
    position:row.world_position,captured_at:Date.now(),session_id:sid,
    ...sourceAnnotationContext({manifest:revision.manifest,scope:{project_id:session.project_id,branch_id:session.branch_id,resource_id:address.resource_id},source_revision:revision.id,target:row.node,row,rows,camera:input.camera})};
  session.draft_attachments.push(attachment);store.put('creator_session',session);return attachment;
}
