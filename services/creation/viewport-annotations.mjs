import {clone,fail,hash,id} from './schema.mjs';
import {nativeObjects} from './native-reference.mjs';
import {resolveScene} from './hierarchy.mjs';
import {captureAnnotationCamera,sourceAnnotationContext} from './annotation-context.mjs';
import {hierarchyObjectView} from './hierarchy-view.mjs';
import {annotationDraftText} from '../../packages/contracts/viewport-annotations.mjs';

const vector=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=1e6);
function capture(store,user,session,input){
  if(!input||typeof input!=='object')fail(422,'批注内容无效');
  const branch=store.branchFor(user,session.project_id,session.branch_id),revision=store.get('creator_revision',input.revision);
  if(!revision||revision.project_id!==session.project_id||!store.ancestor(revision.id,branch.head))fail(409,'批注源版本不属于当前分支');
  const doc=revision.manifest.resources[input.resource_id];if(!doc)fail(409,'批注场景不存在');
  if(!['object','objects','point','region'].includes(input.kind)||!['2d','3d'].includes(input.dimension)||!vector(input.position,input.dimension==='2d'?2:3))fail(422,'批注类型或坐标无效');
  if(typeof input.note!=='string'||!input.note.trim()||input.note.length>2000)fail(422,'批注描述需要 1–2000 个字符');
  if(!Array.isArray(input.object_ids)||input.object_ids.length>512||input.object_ids.some(v=>typeof v!=='string'))fail(422,'批注对象列表无效');
  const ids=[...new Set(input.object_ids)];if(input.kind==='object'&&ids.length!==1||input.kind==='point'&&ids.length||input.kind==='objects'&&!ids.length)fail(422,'批注对象与类型不匹配');
  const scope={project_id:session.project_id,branch_id:session.branch_id,resource_id:doc.id};
  const resolved=revision.manifest.schema==='creation-hierarchy-2'?resolveScene(revision.manifest,doc.id,scope):null;
  const rows=revision.manifest.schema==='creation-native-1'?nativeObjects(revision.manifest,scope):resolved?resolved.map(row=>hierarchyObjectView(row)):doc.objects;
  const members=ids.map(object_id=>{
    const target=rows.find(row=>row.id===object_id);if(!target)fail(409,'批注中有对象不属于固定场景');
    // Resolve only against the authorized immutable source. Capture context
    // without writing each member as a separate, ever-growing draft attachment.
    const row=resolved?.find(row=>row.key===target.hierarchy_key||row.address.definition_node_id===target.address?.definition_node_id&&JSON.stringify(row.address.instance_path)===JSON.stringify(target.address.instance_path));
    const context=sourceAnnotationContext({manifest:revision.manifest,scope,source_revision:revision.id,target,row,rows:resolved,camera:input.camera});
    return {object_id:target.id,name:target.name??object_id,address:context.address,object_version:target.object_version??target.version,node_version:target.node_version,source_revision:revision.id,resource_id:doc.id,resource_version:context.resource_version,definition_revision:context.definition_revision,dimension:context.dimension,source_pose:context.source_pose};
  });
  let geometry=null;
  if(input.kind==='objects'){
    if(!input.geometry||!['rect','brush'].includes(input.geometry.tool))fail(422,'对象集合的选择工具无效');
    geometry={shape:'objects',tool:input.geometry.tool,selection:'visible_projected_bounds'};
  }
  if(input.kind==='region'){
    const g=input.geometry,n=input.dimension==='2d'?2:3;
    if(g?.shape==='box'||g?.shape==='prism'){
      const normal={xz:1,xy:2,yz:0}[g.plane],positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>=.05&&x<=1e4;
      if(n!==3||normal===undefined||!vector(g.center,3)||g.center.some((x,i)=>Math.abs(x-input.position[i])>1e-4)||!Number.isFinite(g.offset)||Math.abs(g.offset)>1e6||!positive(g.depth)||Math.abs(g.center[normal]-g.offset-g.depth/2)>1e-4)fail(422,'空间区域的工作平面或中心无效');
      geometry={shape:g.shape,tool:g.shape==='box'?'volume':'brush',center:clone(g.center),plane:g.plane,offset:g.offset,depth:g.depth,selection:'world_aabb_intersection',membership:'client_world_selection_verified_against_fixed_source'};
      if(g.shape==='box'){
        if(g.tool!=='volume'||!vector(g.size,3)||!g.size.every(positive)||Math.abs(g.size[normal]-g.depth)>1e-4)fail(422,'三维区域尺寸无效');
        geometry.size=clone(g.size);
      }else{
        if(g.tool!=='brush'||!positive(g.radius)||!Array.isArray(g.world_points)||g.world_points.length<3||g.world_points.length>128||g.world_points.some(v=>!vector(v,3)||Math.abs(v[normal]-g.offset)>1e-4))fail(422,'空间笔刷轮廓无效');
        const axes=normal===0?[2,1]:normal===1?[0,2]:[0,1];
        let area=0;for(let i=0;i<g.world_points.length;i++){const a=g.world_points[i],b=g.world_points[(i+1)%g.world_points.length];area+=a[axes[0]]*b[axes[1]]-b[axes[0]]*a[axes[1]];}
        if(Math.abs(area)<1e-6)fail(422,'空间笔刷轮廓没有面积');
        geometry.radius=g.radius;geometry.world_points=clone(g.world_points);
      }
    }else{
      // Old immutable captures remain importable with their original view-selection semantics.
      if(!g||!['brush','rect'].includes(g.tool)||!Array.isArray(g.world_points)||g.world_points.length>128||g.world_points.some(v=>!vector(v,n))||!Array.isArray(g.screen_points)||g.screen_points.length>128||g.screen_points.some(v=>!vector(v,2)||v.some(x=>x<0||x>1))||!Number.isFinite(g.radius)||g.radius<8||g.radius>100)fail(422,'区域批注形状无效');
      geometry={tool:g.tool,world_points:clone(g.world_points),screen_points:clone(g.screen_points),radius:g.radius,outline_closed:g.outline_closed===true,selection:'visible_projected_bounds',membership:'client_viewport_selection_verified_against_fixed_source'};
    }
  }
  const space=doc.kind==='prefab'?'prefab_definition':input.dimension==='2d'?'scene_canvas':'scene_world',units=input.dimension==='2d'?'pixels':'metres';
  return {id:id('attachment'),kind:'viewport_annotation',annotation_kind:input.kind,...scope,session_id:session.id,revision:revision.id,source_revision:revision.id,resource_version:doc.version,resource_name:doc.name,resource_kind:doc.kind,document_schema:revision.manifest.schema,source_identity:revision.manifest.source_identity??null,
    name:input.kind==='region'?`空间区域 · ${members.length} 个对象`:input.kind==='objects'?`对象集合 · ${members.length} 个对象`:input.kind==='point'?'空间描点':members[0].name,note:input.note.trim(),position:clone(input.position),world_position:clone(input.position),dimension:input.dimension,space,units,coordinate_system:{dimension:input.dimension,units,origin:{resource_id:doc.id,source_revision:revision.id},basis:input.dimension==='2d'?'x_right_y_down':'right_handed_y_up'},camera:captureAnnotationCamera(input.camera,space),geometry,members,captured_at:Date.now(),domain:'source',context_version:4};
}
export function createAnnotationDraft(store,user,p,b,input,{sessionId=null}={}){
  store.projectFor(user,p,true);store.branchFor(user,p,b);
  if(typeof input.batch_id!=='string'||! /^[A-Za-z0-9_-]{1,180}$/.test(input.batch_id))fail(422,'缺少批注批次身份');
  if(!Array.isArray(input.annotations)||!input.annotations.length||input.annotations.length>64||input.annotations.reduce((n,a)=>n+(a?.object_ids?.length??0),0)>512)fail(422,'请保留 1–64 条批注，合计不超过 512 个对象');
  const key=hash([user.id,p,b,sessionId,input.batch_id]),fingerprint=hash(input),receipt=store.get('creator_annotation_batch',key);
  if(receipt){if(receipt.fingerprint!==fingerprint)fail(409,'此批次已保存，请重新进入批注模式');return store.sessionView(user,receipt.session_id);}
  return store.transaction(()=>{
    const session=sessionId?store.sessionFor(user,sessionId,true):store.createSession(user,p,b,{title:'视口批注',visibility:'shared'});
    if(session.project_id!==p||session.branch_id!==b)fail(409,'批注目标会话不属于当前分支');
    const previous=clone(session.draft_attachments),annotations=input.annotations.map(a=>capture(store,user,session,a));
    session.draft_attachments=[...previous,...annotations];session.draft=[session.draft,annotationDraftText(annotations,{tokens:true})].filter(Boolean).join('\n\n');
    if(session.draft.length>50000)fail(422,'批注草稿过长，请分批添加');
    session.updated_at=Date.now();store.put('creator_session',session);
    store.put('creator_annotation_batch',{id:key,session_id:session.id,owner_user_id:user.id,project_id:p,branch_id:b,fingerprint,created_at:Date.now()});
    return store.sessionView(user,session.id);
  });
}
export function annotationTargets(a,scope,targetFromAttachment){
  if(a.kind!=='viewport_annotation')return [targetFromAttachment(a,scope)];
  return [...a.members.map(member=>targetFromAttachment(member,scope)),{resource_id:a.resource_id,object_id:`annotation-${a.id}`,source_revision:a.source_revision,annotation_id:a.id,annotation_kind:a.annotation_kind,dimension:a.dimension,position:clone(a.position),geometry:clone(a.geometry)}];
}
