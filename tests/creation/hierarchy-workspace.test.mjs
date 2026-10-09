// Pure operation + FAKE bridge boundary tests. No browser, runtime, server or ACK evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GodotPreview} from '../../apps/creation-workspace/preview-bridge.js';
import {fullAddressKey,lookupResolvedRow,captureTransformTarget,buildWorldTransformCommit,withWorldPosition,localTransformFromEuler} from '../../apps/creation-workspace/hierarchy-editor.js';
import {matrix,multiply,identityTransform,quaternionFromEulerDegrees} from '../../packages/scene/transform.mjs';
import {HIERARCHY_SCHEMA,emptyDocument,prepareManifest,resolveScene} from '../../services/creation/hierarchy.mjs';
import {hierarchyObjectView} from '../../services/creation/hierarchy-view.mjs';
import {applyHierarchyOps} from '../../services/creation/hierarchy-operations.mjs';
const source=await readFile(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const pure=source.split('// HIERARCHY_PURE_START\n')[1].split('// HIERARCHY_PURE_END')[0];
const helpers=Function('copy','matrix','fullAddressKey','localTransformFromEuler',`${pure};return {scopeFor,assertEditContext,sourcePatchOperations,newResourceOperation,newNodeOperation,fixedSourceAttachment,matchesTransformEvent,hierarchyPreviewList,localEulerFields};`)(structuredClone,matrix,fullAddressKey,localTransformFromEuler);
const {assertEditContext,sourcePatchOperations,newResourceOperation,newNodeOperation,fixedSourceAttachment,matchesTransformEvent,hierarchyPreviewList,localEulerFields}=helpers;
const scope={project_id:'p',branch_id:'main',resource_id:'scene'},hash='a'.repeat(64),otherHash='b'.repeat(64);
const trs=(position=[0,0,0],rotation=[0,0,0],scale=[1,1,1])=>({position,rotation:quaternionFromEulerDegrees(rotation),scale});
const node=(id,parent_id='root',transform=identityTransform(),kind='anchor')=>({id,name:'同名门',kind,parent_id,transform,solid:false,components:{},color:'#74d5cd',...(kind==='model'?{model_hash:hash,model_url:`/preview-assets/${hash}.glb`}:{})});
function fixture(){
  const scene=emptyDocument('scene'),house=emptyDocument('house','prefab'),door=emptyDocument('door','prefab');
  scene.nodes.parent=node('parent','root',trs([1,3,0],[0,0,0],[2,1,1]));scene.nodes.sheared=node('sheared','parent',trs([0,2,0],[0,45,0]));door.nodes.door=node('door','root',identityTransform(),'model');
  let manifest=prepareManifest({schema:HIERARCHY_SCHEMA,entry_scene_id:'scene',resources:{scene,house,door},prefab_revisions:{}},()=>true);
  const mount=(instance_id,prefab)=>({instance_id,prefab_id:prefab,prefab_revision:manifest.resources[prefab].version,parent_id:'root',transform:identityTransform(),overrides:[]});
  manifest.resources.house.instances.inner=mount('inner','door');manifest=prepareManifest(manifest,()=>true);
  manifest.resources.scene.instances.left=mount('left','house');manifest.resources.scene.instances.right=mount('right','house');manifest=prepareManifest(manifest,()=>true);
  const branch={...scope,head:'source-fixed',manifest},rows=resolveScene(manifest,'scene',scope),ctx={projectId:'p',branchId:'main',resourceId:'scene',key:'p/main/scene',base:branch.head,schema:HIERARCHY_SCHEMA,manifest:structuredClone(manifest)};
  return{branch,manifest,rows,ctx};
}
const at=(rows,path,id)=>lookupResolvedRow(rows,{...scope,instance_path:path,definition_node_id:id});
const near=(a,b)=>a.forEach((x,i)=>assert.ok(Math.abs(x-b[i])<1e-7,`${i}: ${x} != ${b[i]}`));
test('real pure ops: nested edits address only one same-name door and pin outer instance version',()=>{
  const {manifest,rows,ctx}=fixture(),left=hierarchyObjectView(at(rows,['left','inner'],'door')),right=at(rows,['right','inner'],'door');
  const ops=sourcePatchOperations(left,{name:'新左门'},ctx);assert.equal(ops[0].type,'set_overrides');assert.equal(ops[0].expected_version,manifest.resources.scene.instances.left.version);assert.deepEqual(ops[0].overrides[0].target,{instance_path:['inner'],definition_node_id:'door'});
  const next=applyHierarchyOps(manifest,ops,()=>true).manifest,out=resolveScene(next,'scene',scope);assert.equal(at(out,['left','inner'],'door').node.name,'新左门');assert.deepEqual(at(out,['right','inner'],'door'),right);assert.deepEqual(next.prefab_revisions,manifest.prefab_revisions);
});
test('real pure ops: model replacement atomically updates immutable hash/url pair, keeps definition and sibling',()=>{
  const {manifest,rows,ctx}=fixture(),left=hierarchyObjectView(at(rows,['left','inner'],'door'));
  const ops=sourcePatchOperations(left,{model_hash:otherHash,model_url:`/preview-assets/${otherHash}.glb`},ctx);assert.equal(ops.length,1);assert.equal(ops[0].overrides.length,2);
  const next=applyHierarchyOps(manifest,ops,()=>true).manifest,out=resolveScene(next,'scene',scope);assert.equal(at(out,['left','inner'],'door').node.model_hash,otherHash);assert.equal(at(out,['right','inner'],'door').node.model_hash,hash);assert.equal(next.resources.door.nodes.door.model_hash,hash);
  assert.throws(()=>sourcePatchOperations(left,{kind:'anchor'},ctx),/定义/);assert.throws(()=>sourcePatchOperations(left,{model:otherHash},ctx),/定义/);assert.throws(()=>sourcePatchOperations(left,{position:[4,5,6]},ctx),/完整矩阵/);
});
test('real pure ops: ordinary node patch and source field conversion keep complete local quaternion',()=>{
  const {manifest,rows,ctx}=fixture(),target=hierarchyObjectView(at(rows,[],'sheared')),transform=localTransformFromEuler({position:[4,5,6],rotation_degrees:[23,46,71],scale:[.5,2,3]});
  const ops=sourcePatchOperations(target,{transform},ctx);assert.equal(ops[0].type,'patch_node');assert.equal(ops[0].expected_version,target.node_version);
  const next=applyHierarchyOps(manifest,ops,()=>true).manifest;near(matrix(next.resources.scene.nodes.sheared.transform),matrix(transform));
  const angles=localEulerFields(transform);near(matrix(localTransformFromEuler({position:angles.position,rotation_degrees:angles.rotation,scale:angles.scale})),matrix(transform));
});
test('real pure ops: new h2 independent document has root group and added anchor/model uses local node protocol',()=>{
  const {manifest,ctx}=fixture(),op=newResourceOperation('new-prefab','prefab','新定义',true);let next=applyHierarchyOps(manifest,[op],()=>true).manifest;
  assert.equal(next.resources['new-prefab'].nodes.root.kind,'group');assert.equal(next.resources['new-prefab'].objects,undefined);
  const c={...ctx,resourceId:'new-prefab',manifest:next},anchor={id:'anchor',name:'锚点',kind:'anchor',position:[1,2,3],rotation:[20,40,60],scale:[1,2,3],components:{},solid:false};
  const anchorOp=newNodeOperation(anchor,c);next=applyHierarchyOps(next,[anchorOp],()=>true).manifest;assert.equal(next.resources['new-prefab'].nodes.anchor.parent_id,'root');assert.equal(next.resources['new-prefab'].nodes.anchor.transform.rotation.length,4);
  const modelOp=newNodeOperation({...anchor,id:'model',kind:'model',model:hash,model_hash:hash,model_url:`/preview-assets/${hash}.glb`},{...c,manifest:next},'anchor');assert.equal(modelOp.node.model,undefined);assert.equal(modelOp.node.parent_id,'anchor');assert.equal(modelOp.node.position,undefined);assert.doesNotThrow(()=>applyHierarchyOps(next,[modelOp],()=>true));
});
test('flat adapters preserve prior transaction and document/attachment semantics',()=>{
  const ctx={...fixture().ctx,schema:'creation-flat-1'},target={id:'same-id',version:'opaque-v',name:'旧对象',position:[1,2,3]};
  assert.deepEqual(sourcePatchOperations(target,{position:[9,2,3]},ctx),[{type:'patch_object',resource_id:'scene',object_id:'same-id',expected_version:'opaque-v',patch:{position:[9,2,3]}}]);
  assert.deepEqual(newResourceOperation('r','scene','n',false).resource,{id:'r',kind:'scene',name:'n',objects:[]});assert.equal(newNodeOperation(target,ctx).object.version,'opaque-v');assert.deepEqual(fixedSourceAttachment(target,ctx),{revision:'source-fixed',resource_id:'scene',expected_version:'opaque-v',object_id:'same-id'});
});
test('fixed hierarchy attachments never fall back to renderer id or moving head',()=>{
  const {rows,ctx}=fixture(),target=hierarchyObjectView(at(rows,['left','inner'],'door')),body=fixedSourceAttachment(target,ctx);assert.equal(body.object_id,undefined);assert.deepEqual(body.address,target.address);assert.equal(body.expected_version,target.version);
  target.address.instance_path[0]='right';ctx.base='later-head';assert.equal(body.address.instance_path[0],'left');assert.equal(body.revision,'source-fixed');assert.throws(()=>fixedSourceAttachment({...target,address:{...target.address,branch_id:'wrong'}},ctx),/完整地址/);
});
test('captured edit context blocks readonly, branch/resource switching before and after async upload',()=>{
  const {ctx}=fixture();assert.doesNotThrow(()=>assertEditContext(ctx,{...ctx,base:'later-source'},false)); // object versions guard, unrelated objects may advance head.
  assert.throws(()=>assertEditContext(ctx,ctx,true),/只读/);for(const delta of [{projectId:'p2'},{branchId:'b2'},{key:'p/main/other'}])assert.throws(()=>assertEditContext(ctx,{...ctx,...delta},false),/切换/);
  assert.match(source,/assertCurrentEdit\(ctx\);const file=/);assert.match(source,/assertCurrentEdit\(ctx\);const hash=asset/);
});
test('gizmo fixed start identity + full world matrix survives shear; mismatched late events cannot commit',()=>{
  const {branch,rows}=fixture(),row=at(rows,[],'sheared'),capture=captureTransformTarget({scope,branch,row});assert.equal(row.world_transform,null);
  const desired=withWorldPosition(capture.world_matrix,[10,20,30]),message={id:'sheared',address:structuredClone(capture.address),source_revision:capture.base_revision,object_version:capture.object_version,ancestry_hash:capture.ancestry_hash,world_matrix:desired};
  assert.equal(matchesTransformEvent(message,capture,'sheared'),true);for(const delta of [{id:'other'},{source_revision:'new-source'},{object_version:'changed'},{ancestry_hash:'changed'},{address:{...capture.address,instance_path:['left']}},{world_matrix:[1,2,3]}])assert.equal(matchesTransformEvent({...message,...delta},capture,'sheared'),false);
  const payload=buildWorldTransformCommit(capture,message.world_matrix),next=applyHierarchyOps(branch.manifest,payload.ops,()=>true).manifest;near(at(resolveScene(next,'scene',scope),[],'sheared').world_matrix,desired);assert.deepEqual(desired.slice(0,12),row.world_matrix.slice(0,12));
});
test('remote previews require exact source/object/ancestry/address and never mutate canonical pack or objects',()=>{
  const {rows}=fixture(),object=hierarchyObjectView(at(rows,['left','inner'],'door')),scene={source_revision:'pinned',objects:[object],hierarchy_pack:{signed:'untouched'},hierarchy_pack_canonical:'canonical exact bytes'};
  const before=structuredClone(scene),p={object_id:object.id,address:object.address,source_revision:'pinned',expected_version:object.version,expected_ancestry_hash:object.ancestry_hash,world_matrix:withWorldPosition(object.world_matrix,[3,4,5]),peer_id:'other',expires_at:2000};
  assert.equal(hierarchyPreviewList(scene,[p],'self',1000).length,1);
  for(const delta of [{source_revision:'old'},{expected_version:'old'},{expected_ancestry_hash:'old'},{peer_id:'self'},{expires_at:999},{address:{...p.address,instance_path:['right','inner']}}])assert.equal(hierarchyPreviewList(scene,[{...p,...delta}],'self',1000).length,0);
  assert.deepEqual(scene,before);assert.deepEqual(hierarchyPreviewList(scene,[],'self',1000),[]);
});
test('FAKE bridge: independent object preview preserves full pack/canonical and transient packets are fenced by loaded document/revision',async()=>{
  const sent=[],bridge=Object.create(GodotPreview.prototype);Object.assign(bridge,{seq:0,loadedSeq:0,ready:true,status:{},post:p=>sent.push(structuredClone(p))});
  const scene={document_id:'p/main/scene/preview/door',scene_revision:'fixed',source_revision:'fixed',hierarchy_pack:{scope,objects:[{id:'door'},{id:'other'}]},hierarchy_pack_canonical:'exact canonical',preview_object_id:'door',objects:[],frame:true};
  const pending=bridge.scene(scene);assert.deepEqual(sent[0].hierarchy_pack,scene.hierarchy_pack);assert.equal(sent[0].hierarchy_pack_canonical,'exact canonical');assert.equal(sent[0].preview_object_id,'door');
  assert.equal(bridge.transient({document_id:'wrong',source_revision:'fixed',previews:[]}),false);assert.equal(bridge.transient({document_id:scene.document_id,source_revision:'old',previews:[]}),false);
  clearTimeout(bridge.pending.timer);bridge.loadedSeq=bridge.seq;bridge.pending.resolve();bridge.pending=null;await pending;
  assert.equal(bridge.transient({document_id:scene.document_id,source_revision:'fixed',previews:[],reset_local:true}),true);assert.equal(sent.at(-1).type,'editor_preview');assert.equal(sent.at(-1).reset_local,true);assert.equal(sent.at(-1).seq,1);assert.deepEqual(scene.hierarchy_pack.objects,[{id:'door'},{id:'other'}]);
});
test('fixed source loader rejects moving-head or corrupted envelope; does not fabricate a new baseline',async()=>{
  const block=source.slice(source.indexOf('async function sourceScene('),source.indexOf('\nlet loadedSourceScene='));const calls=[],ctx=fixture().ctx;
  const create=(result)=>Function('context','branchRoute','api','sceneCache','resourceId',`${block};return sourceScene;`)(()=>ctx,(p,b)=>`projects/${p}/branches/${b}`,{api:async route=>{calls.push(route);return result;}},null,ctx.resourceId);
  await assert.rejects(create({scene_revision:'different',document_id:ctx.key})(),/固定版本/);assert.match(calls[0],/revision=source-fixed/);
  await assert.rejects(create({scene_revision:ctx.base,source_revision:ctx.base,document_id:ctx.key,hierarchy_pack:{source_revision:ctx.base}})(),/规范校验/);
  const scene={scene_revision:ctx.base,source_revision:ctx.base,document_id:ctx.key,hierarchy_pack:{source_revision:ctx.base},hierarchy_pack_canonical:'signed'};assert.deepEqual(await create(scene)(),scene);
  const playable={scene_revision:'older-playable',source_revision:'older-playable',document_id:ctx.key};assert.deepEqual(await create(playable)('older-playable'),playable);assert.match(calls.at(-1),/revision=older-playable/);assert.equal(ctx.base,'source-fixed','fixed player release does not mutate the current editor context');
});
test('FAKE bridge: rejected local transform preserves the loaded scene and reports an interaction error',()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{value:{origin:'http://fake-bridge.invalid'},configurable:true});
  try{
    const events=[],sender={},bridge=Object.create(GodotPreview.prototype);
    Object.assign(bridge,{nonce:'fixture',frame:{contentWindow:sender},seq:4,loadedSeq:4,pending:null,key:'unchanged-source',status:{textContent:''},onEvent:e=>events.push(e)});
    const event={origin:location.origin,source:sender,data:{source:'world-atelier-preview',nonce:'fixture',seq:4,type:'error',code:'local_trs_unrepresentable',document_id:'p/main/scene',error:'unrepresentable fixture'}};
    bridge.receive(event);
    assert.equal(events[0].type,'interaction_error');assert.match(events[0].message,/恢复原状/);assert.equal(events[0].document_id,'p/main/scene');
    assert.equal(bridge.key,'unchanged-source');assert.equal(bridge.loadedSeq,4);assert.equal(bridge.status.textContent,'');
    bridge.receive({...event,data:{...event.data,seq:3}});assert.equal(events.length,1,'stale input error is ignored');
  }finally{if(previous)Object.defineProperty(globalThis,'location',previous);else delete globalThis.location;}
});
test('FAKE fields: Tab does not capture an old version; successive axes wait for source ACK and resolved fields',async()=>{
  const block=source.slice(source.indexOf('function startLocalEdit(target){'),source.indexOf('\nfunction cancelLocalEdit(){'));
  const inputs=['rotation','scale'].flatMap(field=>[0,1,2].map(axis=>({dataset:{transform:field,axis:String(axis)},value:field==='scale'?'1':'0',disabled:false,checkValidity:()=>true,setCustomValidity(){}})));
  let releaseCommit,releaseResolve;const commit=new Promise(r=>releaseCommit=r),resolved=new Promise(r=>releaseResolve=r),calls=[];
  const initial={id:'node',node_version:'before',local_transform:trs()};
  const create=Function('copy','localEulerFields','localTransformFromEuler','matrix','multiply','inputs','initial','commit','resolved','calls',`
    let localEdit=null,localCommitPending=false,localCommit=null,selectedId='node',target=initial,base='source-before';
    const editable=()=>true,key=()=>'p/main/scene',$$=()=>inputs,context=()=>({key:key(),base,schema:'creation-hierarchy-2'}),hierarchyTarget=()=>({parent_world_matrix:matrix(${JSON.stringify(identityTransform())})});
    const api={scoped(){}},syncHierarchyPreviews=()=>{},syncMainPreview=async()=>{},sendDragPreview=()=>{},updateSelection=()=>{},updateEditorControls=()=>{},report=e=>{throw e;},toast=()=>{};
    async function patchObject(t,patch,label,ctx){calls.push({target:copy(t),patch:copy(patch),ctx:copy(ctx)});await commit;target={...target,node_version:'after',local_transform:copy(patch.transform)};base='source-after';}
    const loadHierarchyDocument=()=>resolved;
    function renderInspector(){const fields=localEulerFields(target.local_transform);for(const input of inputs){input.disabled=false;input.value=String(fields[input.dataset.transform][Number(input.dataset.axis)]);}bindTransformFields(target);}
    ${block}
    return {bind:()=>bindTransformFields(target),finish:finishLocalEdit,pending:()=>localCommitPending,editing:()=>localEdit};
  `);
  const harness=create(structuredClone,localEulerFields,localTransformFromEuler,matrix,multiply,inputs,initial,commit,resolved,calls);harness.bind();
  assert.equal(inputs[1].onfocus,undefined,'focus alone does not pin source data');
  inputs[0].value='15';inputs[0].oninput();const saving=harness.finish();
  assert.equal(harness.pending(),true);assert.ok(inputs.every(i=>i.disabled));
  inputs[1].value='30';inputs[1].oninput();assert.equal(harness.editing(),null,'a second edit cannot start against the in-flight baseline');
  releaseCommit();await Promise.resolve();assert.equal(harness.pending(),true,'wait for resolved source fields as well as transaction ACK');
  releaseResolve();await saving;assert.equal(harness.pending(),false);assert.ok(inputs.every(i=>!i.disabled));
  inputs[1].value='30';inputs[1].oninput();await harness.finish();
  assert.equal(calls[1].target.node_version,'after');assert.equal(calls[1].ctx.base,'source-after');
  near(matrix(calls[1].patch.transform),matrix(trs([0,0,0],[15,30,0])));
});
test('FAKE preview transport: self echo and peer observations cannot cancel an active local gizmo',()=>{
  const block=source.slice(source.indexOf('function syncHierarchyPreviews(resetLocal=false){'),source.indexOf('\nasync function syncMainPreview(){'));
  const packets=[],scene={document_id:'p/main/scene',source_revision:'source',hierarchy_pack:{},objects:[]};
  const create=Function('scene','packets',`
    let drag={hierarchy:true},localEdit=null,mode='edit',modePending=false,branch={head:'source'};
    const loadedSourceScene=scene,mainPreview={transient:p=>packets.push(p)},key=()=>scene.document_id,previews=new Map(),api={peerId:'self'},hierarchyPreviewList=(_scene,values)=>values;
    ${block}
    return {sync:syncHierarchyPreviews,observe:p=>previews.set('peer',p),end:()=>drag=null};
  `),h=create(scene,packets);
  h.sync();assert.equal(packets.length,0,'empty self-echo list must not restore/cancel the drag');
  h.observe({id:'peer-object'});h.sync();assert.equal(packets.length,0,'peer observations are buffered without touching our gesture');
  h.end();h.sync();assert.deepEqual(packets[0].previews,[{id:'peer-object'}]);
  h.sync(true);assert.equal(packets.at(-1).reset_local,true,'explicit cancellation still restores canonical state');
});
