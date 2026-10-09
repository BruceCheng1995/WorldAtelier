import {clone,fail,id} from './schema.mjs';
import {resolveNativeObject} from './native-reference.mjs';
import {sourceAnnotationContext} from './annotation-context.mjs';

export function attachNativeSource(store,user,sid,input){
  const session=store.sessionFor(user,sid,true),branch=store.branchFor(user,session.project_id,session.branch_id),revision=store.get('creator_revision',input.revision);
  if(!revision||revision.project_id!==session.project_id||!store.ancestor(revision.id,branch.head))fail(409,'附件的源版本无效');
  if(input.observation)fail(422,'检查快照附件必须由世界服务验证后建立');
  const resource_id=input.address?.resource_id??input.resource_id;
  if(input.resource_id!==undefined&&input.resource_id!==resource_id)fail(409,'附件资源与完整地址不一致');
  const scope={project_id:session.project_id,branch_id:session.branch_id,resource_id};
  const target=resolveNativeObject(revision.manifest,scope,input.address,input.object_id);
  if(!target||target.version!==input.expected_version)fail(409,'附件对象版本无效');
  if(input.expected_ancestry_hash!==undefined&&input.expected_ancestry_hash!==target.ancestry_hash)fail(409,'附件的对象父级版本不一致');
  const context=sourceAnnotationContext({manifest:revision.manifest,scope,source_revision:revision.id,target,camera:input.camera});
  const attachment={id:id('attachment'),...scope,session_id:sid,revision:revision.id,object_id:target.id,object_version:target.version,node_version:target.node_version,
    kind:target.kind==='anchor'?'spatial_anchor':'object',snapshot:clone(target),position:clone(context.world_position),captured_at:Date.now(),...context};
  session.draft_attachments.push(attachment);store.put('creator_session',session);return attachment;
}
