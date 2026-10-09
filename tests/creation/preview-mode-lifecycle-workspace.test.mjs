// FAKE DOM/iframe/API test doubles around the real workspace mode functions.
// This verifies orchestration boundaries; see independent CUA/real Godot evidence
// for gameplay UI removal and continuing authoritative snapshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {GodotPreview} from '../../apps/creation-workspace/preview-bridge.js';
import {WorldModeSequence} from '../../apps/creation-workspace/collaboration-client.js';

const source=await readFile(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const between=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,`${start} still has an explicit production boundary`);return source.slice(a,b);};
const implementation=[between('function ensurePreviews(){','async function sourceScene('),between('function leaveWorld(){','function suspendWorld(reason){'),between('async function setMode(next){','async function receiveWorld(packet){')].join('\n');
const manifest={id:'build-fixed',source_revision:'source-v1',canonical_identity:'a'.repeat(64)};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

function fixture({native=false,role='owner',resourceId='scene-A',entrySceneId='scene-A',prepareRuntime=false}={}){
 const events=[],previews=[],runtimeQueue=[],elements=new Map(),scenes=new Map();let generation=0;
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,open:false,dataset:{}});return elements.get(id);};
 class FakePreview{
  constructor(host,mode,onEvent=()=>{}){this.id=previews.length;this.host=host;this.mode=mode;this.onEvent=onEvent;this.disposed=false;this.loadedSeq=0;this.frame={hidden:false,addEventListener(){}};this.status={hidden:false};this.runtimeReady=runtimeQueue.shift()??Promise.resolve(manifest);this.runtimeBuildId='fixture-fixed-build';previews.push(this);events.push(['create',this.id,mode]);}
  world(packet){events.push(['runtime',this.id,packet.action,packet]);}
  camera(){}
  dispose(){this.disposed=true;events.push(['dispose',this.id]);this.onEvent({type:'late-dispose-event'});}
 }
 class FakeNativePreview extends FakePreview {}
 class FakeGamePlay extends FakePreview {
  constructor(host,prepare,onEvent){super(host,'game',onEvent);if(prepareRuntime)this.runtimeReady=Promise.resolve().then(()=>prepare({signal:new AbortController().signal,onProgress(){}})).then(result=>result.job);}
  async start(scene,packet){events.push(['runtime',this.id,'start',{...packet,scene}]);}
 }
 const localDocuments=new Map();
 const sandbox={GodotPreview:FakePreview,NativeGodotPreview:FakeNativePreview,GamePlay:FakeGamePlay,isNative:()=>native,applyViewportDisplay(){},$:element,document:{querySelector:()=>null},onPreviewEvent:message=>events.push(['event',message.type]),closeChat(){},
  // Mode lifecycle cases begin without an active prefab placement controller.
  prefabPlacement:null,closePrefabLab(){},
  mainPreview:null,editorPreview:null,objectPreview:null,mainDocument:null,objectDocument:null,loadedSourceScene:null,sceneGeneration:0,mode:'edit',modePending:false,branch:{head:'source-v1',branch_id:'main',manifest:{entry_scene_id:entrySceneId}},doc:()=>({kind:'scene'}),project:{id:'project-A',role},resourceId,key:()=> 'project-A/main/'+resourceId,
  user:{id:'user-A',name:'Verifier A'},userColor:()=> '#abcd12',uuid:()=> 'local-'+(++generation),sourceScene:async(revision,targetResource=resourceId)=>{events.push(['source-scene',revision,targetResource]);return {scene_revision:revision,resource_id:targetResource,document_id:'project-A/main/'+targetResource,objects:[]};},
  branchRoute:(projectId,branchId)=>`projects/${projectId}/branches/${branchId}`,prepareGamePlay:async options=>{events.push(['prepare-game',options]);return {job:{...manifest,source_revision:options.revision,entry_scene_id:options.entrySceneId}};},
  selectedId:null,annotationView:null,inspectionRecord:null,sceneCache:{},world:null,worldScene:null,worldState:null,frozenScene:null,requestedMode:null,inspectionSentKey:null,inputEnabled:false,joinGeneration:0,joinRequest:null,worldLoadPending:false,modeTimer:null,
  localSceneDocuments:localDocuments,localDocumentRequest:null,localSceneDocument:(revision,documentId)=>localDocuments.get(`${documentId}/${revision}`),trackLocalScene(){},
  worldScenes:{clear:()=>{scenes.clear();events.push(['clear-scenes']);},put:scene=>scenes.set(scene.scene_revision,scene),get:revision=>scenes.get(revision)},modeSequence:{clear:()=>events.push(['clear-mode-sequence']),begin:()=>({request_id:'request-'+(++generation)})},playControls:{setEnabled:value=>events.push(['controls',value])},
  api:{ready:true,send:packet=>events.push(['server',packet.type,packet]),api:()=>Promise.reject(Error('unexpected API fixture call'))},
  invalidateMainCamera:()=>events.push(['invalidate-camera']),cancelLocalEdit(){},sendPresence(){},sendDevelopment(){},renderAll(){},renderStage(){},renderInspector(){},clearTimeout(){},armModeTimeout(){},toast(){},
  requestWorldMode:target=>events.push(['mode-request',target]),loadWorldScene:()=>Promise.resolve(true),suspendWorld:reason=>events.push(['suspend',reason]),errorText:error=>error.message,
 };
 const context=vm.createContext(sandbox);vm.runInContext(implementation,context);context.ensurePreviews();
 return {context,events,previews,runtimeQueue};
}

function faultEventFixture(){
 const f=fixture();
 Object.assign(f.context,{modeShort:{editing:'edit',playing:'play',inspecting:'inspect'},copy:structuredClone,short:value=>value.slice(0,12),connectionInterrupted:false,
  modeSequence:new WorldModeSequence(),renderPlayControls:()=>f.events.push(['render-play-controls'])});
 f.context.worldScenes.pin=revision=>f.events.push(['pin-scene',revision]);
 // Production handler, suspension, and request/ack orchestration; runtime
 // events remain explicit test doubles, not evidence of real Godot execution.
 vm.runInContext([
  between('function suspendWorld(reason){','function armModeTimeout(){'),
  between('function issueModePhase(packet){','async function loadWorldScene('),
  between('async function onPreviewEvent(message){','  if(message.document_id&&message.document_id!==viewedDocumentKey())return;')+'\n}',
 ].join('\n'),f.context);
 return f;
}

test('FAKE workspace: each Run owns a disposable engine and returns the same authored editor',()=>{
 const f=fixture(),editor=f.context.mainPreview,object=f.context.objectPreview;
 for(let cycle=0;cycle<3;cycle++){
  f.context.beginPlayPreview();const playing=f.context.mainPreview;
  assert.notEqual(playing,editor);assert.equal(editor.frame.hidden,true);assert.equal(f.context.objectPreview,object);
  f.context.beginPlayPreview();assert.equal(f.context.mainPreview,playing,'repeated begin does not create another engine');
  f.context.restoreEditPreview();assert.equal(playing.disposed,true);assert.equal(f.context.mainPreview,editor);assert.equal(editor.frame.hidden,false);assert.equal(editor.status.hidden,false);assert.equal(editor.disposed,false);
 }
 assert.equal(f.previews.length,5,'one editor, one object preview, three disposable runs');
});

test('FAKE workspace: parked and disposed preview callbacks cannot mutate the current view',()=>{
 const f=fixture(),editor=f.context.mainPreview;f.context.beginPlayPreview();const playing=f.context.mainPreview;
 editor.onEvent({type:'parked-camera'});playing.onEvent({type:'active-world'});f.context.restoreEditPreview();playing.onEvent({type:'late-world'});editor.onEvent({type:'restored-camera'});
 assert.deepEqual(f.events.filter(row=>row[0]==='event'),[['event','active-world'],['event','restored-camera']]);
});

test('FAKE workspace: restoring editor reports only its matching loaded camera observation',()=>{
 const f=fixture(),editor=f.context.mainPreview;
 editor.loadedSeq=4;editor.lastCameraEvent={type:'camera',seq:4,view:'top',position:[0,15,0],target:[0,0,0]};
 f.context.beginPlayPreview();f.context.mainPreview.lastCameraEvent={type:'camera',seq:1,view:'perspective'};f.context.restoreEditPreview();
 assert.deepEqual(JSON.parse(editor.host.dataset.camera),{position:[0,15,0],target:[0,0,0],view:'top',seq:4});
 assert.equal(f.events.filter(row=>row[0]==='event'&&row[1]==='camera').length,1);
 editor.loadedSeq=5;f.context.beginPlayPreview();f.context.restoreEditPreview();
 assert.equal(f.events.filter(row=>row[0]==='event'&&row[1]==='camera').length,1,'stale camera is not replayed across a new loaded generation');
});

test('FAKE workspace: legacy shared Stop releases only current player before disposing its runtime',async()=>{
 const f=fixture(),editor=f.context.mainPreview;f.context.beginPlayPreview();const playing=f.context.mainPreview;
 Object.assign(f.context,{mode:'inspect',world:{world_id:'owned-world',epoch:7,scene_revision:'fixed-v1'},modePending:true,inputEnabled:true});
 await f.context.setMode('edit');
 const leave=f.events.findIndex(row=>row[0]==='server'&&row[1]==='world_leave'),dispose=f.events.findIndex(row=>row[0]==='dispose'&&row[1]===playing.id);
 assert.ok(leave>=0&&leave<dispose);assert.ok(f.events.some(row=>row[0]==='runtime'&&row[2]==='leave'));
 assert.equal(f.context.mainPreview,editor);assert.equal(f.context.mode,'edit');assert.equal(f.context.modePending,false);assert.equal(f.context.world,null);assert.equal(f.context.inputEnabled,false);
 assert.deepEqual(f.events.filter(row=>row[0]==='server').map(row=>row[1]),['world_leave'],'no world sleep/freeze/replacement request');
});

test('FAKE workspace: Stop during pending runtime prevents a late local start and permits a fresh Run',async()=>{
 const f=fixture(),pending=deferred(),editor=f.context.mainPreview;f.runtimeQueue.push(pending.promise);
 const running=f.context.setMode('play');assert.equal(f.context.modePending,true);const abandoned=f.context.mainPreview;
 await f.context.setMode('edit');assert.equal(abandoned.disposed,true);assert.equal(f.context.mainPreview,editor);
 pending.resolve(manifest);await running;assert.equal(f.events.filter(row=>row[0]==='runtime'&&row[2]==='start').length,0);
 await f.context.setMode('play');assert.notEqual(f.context.mainPreview,abandoned);assert.equal(f.events.filter(row=>row[0]==='runtime'&&row[2]==='start').length,1);
});

test('FAKE workspace: rapid repeated Run cannot duplicate local start or engine creation',async()=>{
 const f=fixture(),pending=deferred();f.runtimeQueue.push(pending.promise);const first=f.context.setMode('play');await f.context.setMode('play');
 assert.equal(f.previews.length,3);pending.resolve(manifest);await first;
 assert.equal(f.events.filter(row=>row[0]==='runtime'&&row[2]==='start').length,1);
});

test('FAKE workspace: personal inspection and resume preserve the play iframe',async()=>{
 const f=fixture();f.context.beginPlayPreview();const playing=f.context.mainPreview;
 Object.assign(f.context,{mode:'play',world:{session_kind:'local_preview',world_id:'preview:A',epoch:1}});await f.context.setMode('inspect');
 f.context.mode='inspect';await f.context.setMode('play');
 assert.equal(f.context.mainPreview,playing);assert.equal(playing.disposed,false);assert.equal(f.previews.length,3);
 assert.deepEqual(f.events.filter(row=>row[0]==='mode-request'),[['mode-request','inspect'],['mode-request','play']]);assert.equal(f.events.filter(row=>row[0]==='server').length,0);
});

test('FAKE workspace: restarting local Play creates a fresh session and keeps the source immutable',async()=>{
 const f=fixture(),editor=f.context.mainPreview;await f.context.setMode('play');
 const first=f.context.mainPreview,firstWorld=f.context.world.world_id;
 Object.assign(f.context,{mode:'play',modePending:false});await f.context.restartPlay();
 assert.equal(first.disposed,true);assert.equal(f.context.editorPreview,editor);assert.notEqual(f.context.mainPreview,first);assert.notEqual(f.context.world.world_id,firstWorld);
 const starts=f.events.filter(row=>row[0]==='runtime'&&row[2]==='start').map(row=>row[3]);
 assert.equal(starts.length,2);assert.equal(starts[0].scene.scene_revision,'source-v1');assert.equal(starts[1].scene.scene_revision,'source-v1');for(const packet of starts)for(const field of ['player_id','player_name','player_color'])assert.equal(Object.hasOwn(packet,field),false);
 assert.equal(f.events.filter(row=>row[0]==='server').length,0,'local start/restart does not join or leave shared authority');
});

test('FAKE workspace: failed canonical build is rejected before starting a local simulation',async()=>{
 const f=fixture();f.runtimeQueue.push(Promise.reject(Error('canonical build failed')));await f.context.setMode('play');
 assert.equal(f.context.world,null);assert.equal(f.events.filter(row=>row[0]==='runtime'&&row[2]==='start').length,0);assert.equal(f.events.filter(row=>row[0]==='suspend').length,1);
});

test('FAKE workspace: initial local start error disposes the failed run and restores editing',async()=>{
 const f=faultEventFixture(),editor=f.context.mainPreview;await f.context.setMode('play');
 const failed=f.context.mainPreview,world=f.context.world;
 assert.equal(f.context.mode,'edit');assert.equal(f.context.modePending,true);
 await f.context.onPreviewEvent({type:'world_state',world_id:world.world_id,epoch:world.epoch,scene_revision:'source-v1',mode:'editing',control_ready:false,error:'fixture script failed during initialize'});
 assert.equal(f.context.mode,'edit');assert.equal(f.context.modePending,false);assert.equal(f.context.world,null);assert.equal(f.context.inputEnabled,false);
 assert.equal(f.context.mainPreview,editor);assert.equal(failed.disposed,true);assert.equal(editor.frame.hidden,false);
 assert.match(f.context.$('#workspaceStatus').textContent,/独立试玩未能启动.*initialize/);
 assert.equal(f.events.filter(row=>row[0]==='runtime'&&row[2]==='leave').length,1);
});

test('FAKE workspace: running script fault preserves its session through a pending inspection acknowledgement',async()=>{
 const f=faultEventFixture();await f.context.setMode('play');
 const playing=f.context.mainPreview,world=f.context.world;
 const start=f.events.find(row=>row[0]==='runtime'&&row[2]==='start')[3];
 const state={type:'world_state',world_id:world.world_id,epoch:world.epoch,scene_revision:'source-v1',mode:'playing',request_id:start.request_id,session_kind:'local_preview',runtime_ready:true,control_ready:false,sequence:14,tick:14};
 await f.context.onPreviewEvent(state);assert.equal(f.context.mode,'play');assert.equal(f.context.modePending,false);
 const error='fixture tick fault at state 14';
 await f.context.onPreviewEvent({...state,error});
 assert.equal(f.context.mainPreview,playing);assert.equal(f.context.world,world);assert.equal(playing.disposed,false);assert.equal(f.context.$('#workspaceStatus').textContent,error);
 await f.context.setMode('inspect');assert.equal(f.context.modePending,true);
 const inspect=f.events.findLast(row=>row[0]==='runtime'&&row[2]==='mode')[3];
 await f.context.onPreviewEvent({...state,mode:'inspecting',request_id:inspect.request_id,runtime_ready:false,control_ready:false,error,frozen_revision:'source-v1',frozen_sequence:14,frozen_tick:14,stop_ack_sequence:14,inspection_ui_visible:false});
 assert.equal(f.context.mode,'inspect');assert.equal(f.context.modePending,false);assert.equal(f.context.mainPreview,playing);assert.equal(f.context.world,world);assert.equal(playing.disposed,false);
 assert.equal(f.context.frozenScene.scene_revision,'source-v1');assert.equal(f.context.worldState.tick,14);assert.equal(f.context.worldState.inspection_ui_visible,false);assert.equal(f.context.$('#workspaceStatus').textContent,error);
 assert.equal(f.events.filter(row=>row[0]==='runtime'&&row[2]==='leave').length,0,'no disposal or shared-authority action destroys the faulting debugging session');
 assert.equal(f.events.filter(row=>row[0]==='server').length,0);
});

for(const scenario of [
 {name:'native public default uses the published entry even when source default changed',native:true,role:'player',resourceId:'scene-A',entrySceneId:'scene-A',publishedEntry:'scene-published',expectedRoute:'projects/project-A/branches/main/playable-game'},
 {name:'native public explicit scene keeps its resource filter',native:true,role:'player',resourceId:'scene-B',entrySceneId:'scene-A',publishedEntry:'scene-B',expectedRoute:'projects/project-A/branches/main/playable-game?resource_id=scene-B'},
 {name:'legacy public default keeps the existing explicit resource filter',native:false,role:'player',resourceId:'scene-A',entrySceneId:'scene-A',publishedEntry:'scene-A',expectedRoute:'projects/project-A/branches/main/playable-game?resource_id=scene-A'},
 {name:'native author runs the current source entry without consulting public release',native:true,role:'owner',resourceId:'scene-A',entrySceneId:'scene-A',publishedEntry:null,expectedRoute:null},
])test('FAKE workspace: '+scenario.name,async()=>{
 const f=fixture({...scenario,prepareRuntime:true}),editor=f.context.mainPreview;
 f.context.api.api=async(route,options)=>{
  f.events.push(['api',route,options]);assert.equal(route,scenario.expectedRoute);
  return {source_revision:'published-v0',resource_id:scenario.publishedEntry};
 };
 await f.context.setMode('play');
 assert.equal(f.events.filter(row=>row[0]==='suspend').length,0);
 assert.deepEqual(f.events.filter(row=>row[0]==='api').map(row=>row[1]),scenario.expectedRoute?[scenario.expectedRoute]:[]);
 const revision=scenario.role==='player'?'published-v0':'source-v1',entry=scenario.publishedEntry??scenario.resourceId;
 const prepare=f.events.find(row=>row[0]==='prepare-game')?.[1];assert.ok(prepare,'the production prepare callback was actually invoked by this orchestration double');
 assert.equal(prepare.projectId,'project-A');assert.equal(prepare.branchId,'main');assert.equal(prepare.revision,revision);assert.equal(prepare.entrySceneId,entry);
 assert.deepEqual(f.events.filter(row=>row[0]==='source-scene'),[['source-scene',revision,entry]],'the fixed job entry selects source metadata, not the current editor resource');
 const start=f.events.find(row=>row[0]==='runtime'&&row[2]==='start')?.[3];assert.ok(start);
 assert.equal(start.scene.scene_revision,revision);assert.equal(start.scene.resource_id,entry);assert.equal(start.scene.document_id,`project-A/main/${entry}`);
 assert.equal(f.context.worldScene.document_id,start.scene.document_id);assert.equal(f.context.localSceneDocuments.get(`${start.scene.document_id}/${revision}`).resource_id,entry);
 assert.equal(f.context.resourceId,scenario.resourceId);assert.equal(f.context.branch.head,'source-v1');assert.equal(f.context.editorPreview,editor,'playing the published entry keeps the current source editor parked');
 assert.equal(f.events.filter(row=>row[0]==='server').length,0,'public local Play does not join shared authority');
});

test('FAKE bridge: deferred manifest cannot navigate or notify after dispose',async t=>{
 const pending=deferred(),events=[],host={dataset:{}},frame={src:'',remove(){events.push('frame-remove');}},status={remove(){events.push('status-remove');}};
 t.mock.method(globalThis,'fetch',()=>pending.promise);
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:{removeEventListener(){}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;});
 const bridge=Object.create(GodotPreview.prototype);Object.assign(bridge,{host,frame,status,worldQueue:new Map(),onEvent:()=>events.push('unexpected-event'),disposed:false});
 const loading=bridge.loadRuntime();bridge.dispose();assert.equal(frame.src,'about:blank');
 pending.resolve({ok:true,json:async()=>({build_id:'a'.repeat(64)})});await loading;
 assert.equal(frame.src,'about:blank');assert.deepEqual(host.dataset,{});assert.deepEqual(events,['frame-remove','status-remove']);
});
