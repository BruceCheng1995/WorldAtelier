// Real temporary SQLite and the real service router/store/target projection.
// Native indexes and HTTP streams are explicit synthetic fixtures; no formal
// service, paid Agent, Web render or game content is used by this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationService} from '../../services/creation/service.mjs';
import {CreationAgentRuns} from '../../services/creation/agent-runs.mjs';
import {nativeObjects} from '../../services/creation/native-reference.mjs';
import {targetFromAttachment} from '../../services/creation/hierarchy-agent.mjs';
import {createAnnotationDraft,annotationTargets} from '../../services/creation/viewport-annotations.mjs';
import {annotationInput,portableAnnotations,parsePortableAnnotations} from '../../packages/contracts/viewport-annotations.mjs';

const camera={position:[12,8,20],target:[0,0,0],view:'perspective',projection:'perspective'};
const transform=(position,dimension)=>dimension==='2d'?{$type:'Transform2D',x:[1,0],y:[0,1],origin:position}:{$type:'Transform3D',basis:[[1,0,0],[0,1,0],[0,0,1]],origin:position};
function nativeScene(id,dimension,kind='scene'){
  const node=(node_id,path,position,instances=[])=>({node_id,path,name:path==='.'?'Root':path,instance_ids:instances,addressable:true,type:dimension==='2d'?'Node2D':'Node3D',version:`${id}-${path}-v1`,key:`${id}-${path}`,metadata:{},properties:[],local_transform:transform(position,dimension),world_transform:transform(position,dimension)});
  const zero=dimension==='2d'?[0,0]:[0,0,0],a=dimension==='2d'?[20,30]:[2,3,4],b=dimension==='2d'?[60,70]:[6,7,8];
  return {id,kind,name:id,path:`${id}.tscn`,version:`${id}-v1`,native_nodes:[node('root','.',zero),node('door','Left',a,['house-left']),node('door','Right',b,['house-right'])]};
}
function fixture(t){
  const data=mkdtempSync(join(tmpdir(),'atelier-annotation-drafts-')),file=join(data,'creation.sqlite');let store=new CreationStore(file);
  const owner={id:'annotation-owner',name:'Owner'},editor={id:'annotation-editor',name:'Editor'},viewer={id:'annotation-viewer',name:'Viewer'},outsider={id:'annotation-outsider',name:'Outsider'};
  [owner,editor,viewer,outsider].forEach(user=>store.put('creator_user',user));
  const p=store.createProject(owner,{name:'Isolated annotation drafts'},{entry_scene_id:'room',resources:{room:{id:'room',kind:'scene',name:'Room',objects:[]}}}).project.id;
  store.setMember(owner,p,editor.id,'editor');store.setMember(owner,p,viewer.id,'viewer');
  const manifest={schema:'creation-native-1',source_identity:'source-1',index_source_identity:'source-1',source_files:{},entry_scene_id:'room',resources:{room:nativeScene('room','3d'),canvas:nativeScene('canvas','2d'),prefab:nativeScene('prefab','3d','prefab')}};
  const revision=store.writeRevision(p,[],manifest,owner.id);
  store.put('creator_branch',{...store.get('creator_branch',`${p}:main`),head:revision.id});
  t.after(()=>{store.close();rmSync(data,{recursive:true,force:true});});
  let serial=0;
  const scope=rid=>({project_id:p,branch_id:'main',resource_id:rid});
  const rows=(rid='room')=>nativeObjects(revision.manifest,scope(rid));
  const object=(extra={})=>({revision:revision.id,resource_id:'room',kind:'object',object_ids:[rows()[1].id],dimension:'3d',position:[2,3,4],note:'Move this object',camera,...extra});
  const point=(extra={})=>object({kind:'point',object_ids:[],position:[12,2,-3],note:'Create here',...extra});
  const region=(extra={})=>object({kind:'region',object_ids:[rows()[1].id,rows()[2].id],note:'Adjust this area',geometry:{tool:'rect',world_points:[[0,0,0],[4,0,0],[4,0,4],[0,0,4],[0,0,0]],screen_points:[[.1,.1],[.8,.1],[.8,.8],[.1,.8],[.1,.1]],radius:28},...extra});
  const batch=annotations=>({batch_id:`independent-batch-${++serial}`,annotations});
  const create=(input,user=owner,options)=>createAnnotationDraft(store,user,p,'main',input,options);
  const counts=()=>Object.fromEntries(['creator_session','creator_annotation_batch','creator_run','creator_message','creator_revision'].map(kind=>[kind,store.list(kind).length]));
  const router=async(path,body,user=owner)=>{
    const service=Object.assign(Object.create(CreationService.prototype),{store,origin:'http://127.0.0.1:48921',observe:fn=>fn()});
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:`/creation-api/${path}`,method:'POST',headers:{host:'127.0.0.1:48921',origin:'http://127.0.0.1:48921',authorization:`Bearer ${store.issueLogin(user).token}`}});
    let status,value;const res={writeHead(code){status=code;},end(text){value=JSON.parse(text);}};
    assert.equal(await service.request(req,res),true);return {status,value};
  };
  return {owner,editor,viewer,outsider,p,revision,scope,rows,object,point,region,batch,create,counts,router,get store(){return store;},reopen(){store.close();store=new CreationStore(file);}};
}

test('an annotation batch atomically creates one unsent Agent draft with only immutable annotation attachments',t=>{
  const f=fixture(t),before=f.counts(),input=f.batch([f.object(),f.point(),f.region()]);
  const session=f.create(input);
  assert.equal(f.counts().creator_session,before.creator_session+1);assert.equal(f.counts().creator_annotation_batch,1);
  assert.equal(f.counts().creator_run,before.creator_run);assert.equal(f.counts().creator_message,before.creator_message);
  assert.equal(f.counts().creator_revision,before.creator_revision);assert.equal(session.executor_thread_id,null);
  assert.equal(session.draft_attachments.length,3,'member captures never leak separate object attachments into the draft');
  assert.ok(session.draft_attachments.every(a=>a.kind==='viewport_annotation'&&a.session_id===session.id));
  assert.match(session.draft,/Move this object/);assert.match(session.draft,/Create here/);assert.match(session.draft,/Adjust this area/);
  assert.ok(session.draft_attachments.every(a=>session.draft.includes(`[[ref:${a.id}]]`)));
  assert.deepEqual(session.messages,[]);assert.deepEqual(session.runs,[]);
  assert.equal(f.store.branchFor(f.owner,f.p,'main').head,f.revision.id);
});

test('retry reuses the exact batch receipt and changed input cannot append or create a second draft',t=>{
  const f=fixture(t),input=f.batch([f.region()]),first=f.create(input),counts=f.counts();
  const repeated=f.create(structuredClone(input));assert.equal(repeated.id,first.id);assert.deepEqual(repeated.draft_attachments,first.draft_attachments);assert.deepEqual(f.counts(),counts);
  assert.throws(()=>f.create({...input,annotations:[f.region({note:'Changed request'})]}),{status:409});assert.deepEqual(f.counts(),counts);
  f.reopen();assert.deepEqual(f.create(input),first,'receipt and immutable capture survive database reopen');
});

test('any invalid annotation rolls back new sessions, prior member captures and receipts',t=>{
  const f=fixture(t),before=f.counts();
  const bad=[f.point({position:[NaN,2,3]}),f.point({note:' '}),f.region({object_ids:[f.rows()[1].id,'missing']}),f.region({geometry:{tool:'rect',world_points:[[0,0,0]],screen_points:[[1.1,.2]],radius:28}}),f.object({camera:{position:[0,Infinity,2],target:[0,0,0]}}),f.object({revision:'foreign'}),f.object({resource_id:'missing'})];
  for(const annotation of bad){assert.throws(()=>f.create(f.batch([f.object(),annotation])));assert.deepEqual(f.counts(),before);}
  for(const annotations of [[],Array.from({length:65},()=>f.point()),Array.from({length:64},()=>f.point({note:'x'.repeat(1999)}))]){
    assert.throws(()=>f.create(f.batch(annotations)));assert.deepEqual(f.counts(),before);
  }
});

test('native members keep separate nested addresses, exact versions and old poses after source changes',t=>{
  const f=fixture(t),session=f.create(f.batch([f.region()])),fixed=structuredClone(session.draft_attachments[0]);
  assert.deepEqual(fixed.members.map(m=>m.address.instance_path),[['house-left'],['house-right']]);
  assert.ok(fixed.members.every(m=>m.address.definition_node_id==='door'&&m.source_revision===f.revision.id));
  assert.deepEqual(fixed.members.map(m=>m.object_version),['room-Left-v1','room-Right-v1']);
  assert.deepEqual(fixed.members.map(m=>m.source_pose.world_position),[[2,3,4],[6,7,8]]);
  const next=structuredClone(f.revision.manifest);next.source_identity=next.index_source_identity='source-2';next.resources.room.version='room-v2';next.resources.room.native_nodes[1].name='Renamed';next.resources.room.native_nodes[1].world_transform.origin=[90,80,70];
  const revision=f.store.writeRevision(f.p,[f.revision.id],next,f.owner.id);f.store.put('creator_branch',{...f.store.get('creator_branch',`${f.p}:main`),head:revision.id});
  assert.deepEqual(f.store.sessionView(f.owner,session.id).draft_attachments[0],fixed);
  assert.deepEqual(f.create(f.batch([f.region()])).draft_attachments[0].members,fixed.members,'explicit historical capture never rebinds to the moving head');
});

test('2D canvas and independent prefab annotations retain their coordinate units and origins',t=>{
  const f=fixture(t),canvas=f.create(f.batch([f.object({resource_id:'canvas',object_ids:[f.rows('canvas')[1].id],dimension:'2d',position:[20,30]})])).draft_attachments[0];
  assert.equal(canvas.units,'pixels');assert.equal(canvas.coordinate_system.basis,'x_right_y_down');assert.deepEqual(canvas.position,[20,30]);assert.equal(canvas.members[0].dimension,'2d');
  assert.equal(canvas.coordinate_system.origin.resource_id,'canvas');
  const prefab=f.create(f.batch([f.point({resource_id:'prefab'})])).draft_attachments[0];
  assert.equal(prefab.space,'prefab_definition');assert.equal(prefab.units,'metres');assert.equal(prefab.coordinate_system.origin.resource_id,'prefab');
});

test('portable annotations append to a different owned session and keep existing unsent work',async t=>{
  const f=fixture(t),source=f.create(f.batch([f.object(),f.point(),f.region()]));
  const portable=portableAnnotations(source.draft_attachments,f.scope('room')),parsed=parsePortableAnnotations(portable);
  assert.equal(parsed.version,1);assert.equal(parsed.project_id,f.p);assert.equal(parsed.branch_id,'main');
  assert.deepEqual(parsed.annotations,source.draft_attachments.map(annotationInput));
  const destination=f.store.createSession(f.owner,f.p,'main',{draft:'unused'});f.store.updateSession(f.owner,destination.id,{draft:'Existing unsent work'});
  const body={...parsed,batch_id:'paste-stable'};
  const result=await f.router(`sessions/${destination.id}/annotation-imports`,body);
  assert.equal(result.status,200);assert.equal(result.value.id,destination.id);assert.match(result.value.draft,/^Existing unsent work/);
  assert.equal(result.value.draft_attachments.length,3);assert.equal(result.value.messages.length,0);assert.equal(result.value.runs.length,0);
  assert.notEqual(result.value.draft_attachments[0].id,source.draft_attachments[0].id,'destination owns new immutable references');
  assert.deepEqual(result.value.draft_attachments.map(a=>a.members),source.draft_attachments.map(a=>a.members));
  const replay=await f.router(`sessions/${destination.id}/annotation-imports`,body);assert.deepEqual(replay,result);
});

test('actual import route rejects foreign scopes and unauthorized users without changing their target draft',async t=>{
  const f=fixture(t),destination=f.store.createSession(f.owner,f.p,'main',{visibility:'private'}),before=f.store.sessionView(f.owner,destination.id);
  const body={...f.batch([f.point()]),project_id:f.p,branch_id:'main'};
  for(const changed of [{project_id:'foreign'},{branch_id:'other'}]){
    const reply=await f.router(`sessions/${destination.id}/annotation-imports`,{...body,...changed});assert.equal(reply.status,409);assert.deepEqual(f.store.sessionView(f.owner,destination.id),before);
  }
  for(const user of [f.editor,f.viewer,f.outsider]){
    const reply=await f.router(`sessions/${destination.id}/annotation-imports`,body,user);assert.equal(reply.status,403);assert.deepEqual(f.store.sessionView(f.owner,destination.id),before);
  }
  for(const user of [f.viewer,f.outsider])assert.throws(()=>f.create(f.batch([f.point()]),user),{status:403});
  const valid=await f.router(`projects/${f.p}/branches/main/annotation-drafts`,f.batch([f.point()]),f.editor);assert.equal(valid.status,201);assert.equal(valid.value.owner_user_id,f.editor.id);
});

test('failed paste is atomic and deleting a draft annotation leaves other annotations and source intact',t=>{
  const f=fixture(t),session=f.create(f.batch([f.object(),f.point()])),before=f.store.sessionView(f.owner,session.id),counts=f.counts();
  assert.throws(()=>f.create(f.batch([f.region(),f.point({note:''})]),f.owner,{sessionId:session.id}));
  assert.deepEqual(f.store.sessionView(f.owner,session.id),before);assert.deepEqual(f.counts(),counts);
  const removed=f.store.removeAttachment(f.owner,session.id,session.draft_attachments[0].id);
  assert.deepEqual(removed.draft_attachments,[session.draft_attachments[1]]);assert.equal(f.store.branchFor(f.owner,f.p,'main').head,f.revision.id);
});

test('active Agent projection includes member outlines and spatial marks without private notes, then clears terminal runs',t=>{
  const f=fixture(t),session=f.create(f.batch([f.region({note:'PRIVATE-ANNOTATION-TEXT'}),f.point({note:'PRIVATE-POINT-TEXT'})]));
  f.store.updateSession(f.owner,session.id,{visibility:'private'});
  const targets=session.draft_attachments.flatMap(a=>annotationTargets(a,f.scope(a.resource_id),targetFromAttachment));
  assert.equal(targets.length,4);assert.equal(targets.filter(t=>t.annotation_id).length,2);assert.equal(targets.filter(t=>t.address).length,2);
  assert.ok(targets.every(target=>target.source_revision===f.revision.id));assert.doesNotMatch(JSON.stringify(targets),/PRIVATE-|note|draft/);
  const run={id:'annotation-test-run',project_id:f.p,branch_id:'main',session_id:session.id,owner_user_id:f.owner.id,status:'running',targets,created_at:1};
  f.store.put('creator_run',run);
  const broadcasts=[],manager=Object.assign(Object.create(CreationAgentRuns.prototype),{store:f.store,requests:new Map(),service:{realtime:{development:(p,b,states)=>broadcasts.push({p,b,states}),developmentFailed(){}}}});
  const states=manager.publicState(f.p,'main');
  assert.equal(states.length,4,manager.lastProjectionError?.message);assert.equal(states.filter(s=>s.annotation_id).length,2);
  assert.doesNotMatch(JSON.stringify(states),/PRIVATE-|note|session_id|draft/);
  assert.ok(states.every(s=>s.run_id===run.id&&s.status==='editing'&&s.actor.id===f.owner.id));
  assert.deepEqual(states.filter(s=>s.address).map(s=>s.address.instance_path),[['house-left'],['house-right']]);
  f.store.put('creator_run',{...run,status:'uncertain'});
  assert.ok(manager.publicState(f.p,'main').every(s=>s.execution==='uncertain'&&s.label==='执行结果待核对'),'spatial and object marks report the same real execution state');
  for(const status of ['completed','failed','interrupted']){
    f.store.put('creator_run',{...run,status,...(status==='interrupted'?{cancel_requested_at:1,cleanup_status:'verified'}:{})});
    assert.deepEqual(manager.publicState(f.p,'main'),[]);assert.deepEqual(broadcasts.at(-1).states,[]);
  }
});


test('spatial v2 boxes, prisms and object collections keep exact geometry in portable unsent drafts',t=>{
  const f=fixture(t),box={shape:'box',tool:'volume',plane:'xz',center:[2,3,4],size:[8,6,10],offset:0,depth:6};
  const prism={shape:'prism',tool:'brush',plane:'xz',center:[2,3,4],offset:0,depth:6,radius:1,world_points:[[0,0,0],[4,0,0],[4,0,8],[0,0,8]]};
  const set=f.region({kind:'objects',geometry:{shape:'objects',tool:'rect'}});
  const session=f.create(f.batch([set,f.region({geometry:box}),f.region({geometry:prism})]));
  const [objects,volume,brush]=session.draft_attachments;
  assert.equal(objects.annotation_kind,'objects');assert.equal(objects.geometry.shape,'objects');assert.equal(volume.context_version,4);
  assert.deepEqual(volume.geometry.size,[8,6,10]);assert.deepEqual(brush.geometry.world_points,prism.world_points);
  assert.equal(volume.geometry.selection,'world_aabb_intersection');assert.equal(brush.geometry.selection,'world_aabb_intersection');
  assert.match(session.draft,/尺寸 XYZ：8, 6, 10 m/);assert.match(session.draft,/厚度 6 m/);assert.match(session.draft,/对象集合/);
  const copied=parsePortableAnnotations(portableAnnotations(session.draft_attachments,f.scope('room')));
  const destination=f.store.createSession(f.owner,f.p,'main',{}),pasted=f.create({...copied,batch_id:'spatial-v2-paste'},f.owner,{sessionId:destination.id});
  assert.deepEqual(pasted.draft_attachments.map(a=>a.geometry),session.draft_attachments.map(a=>a.geometry));
  assert.equal(f.store.list('creator_run').length,0);assert.equal(f.store.list('creator_message').length,0);
  for(const malformed of [{...box,size:[8,0,10]},{...box,center:[8,9,0]},{...box,depth:2},{...box,plane:'camera'},{...prism,world_points:[[0,2,0],[4,0,0],[4,0,8]]},{...prism,world_points:[[0,0,0],[1,0,1],[2,0,2]]}]){
    const counts=f.counts();assert.throws(()=>f.create(f.batch([set,f.region({geometry:malformed})])),{status:422});assert.deepEqual(f.counts(),counts);
  }
  assert.throws(()=>f.create(f.batch([f.point({kind:'objects',geometry:{tool:'rect'}})])),{status:422});
});
