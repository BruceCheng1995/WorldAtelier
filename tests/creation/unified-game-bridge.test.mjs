// Transport/DOM doubles only; real Godot/Web evidence is recorded separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {WorldModeSequence} from '../../apps/creation-workspace/collaboration-client.js';
import {GamePlay} from '../../apps/creation-workspace/game-play.js';

function bridge(t) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'http://localhost:48921'}});
  t.after(()=>previous?Object.defineProperty(globalThis,'location',previous):delete globalThis.location);
  const seen=[],sent=[],errors=[],preview=Object.create(GamePlay.prototype),frame={contentWindow:{}};
  Object.assign(preview,{frame,disposed:false,runtimeOrigin:'http://[::ffff:7f00:1]:48921',nonce:'unique-iframe-nonce',seq:1,commandSeq:1,loadedSeq:1,sceneGeneration:1,runtimeBuildId:'a'.repeat(64),job:{source_revision:'source',runtime_source_hash:'b'.repeat(64)},worldContext:{world_id:'preview:one',epoch:1},sceneContext:{document_id:'project/main/A'},host:{dataset:{}},status:{textContent:''},post:packet=>sent.push(packet),onEvent:packet=>seen.push(packet),diagnostic(){},fail:error=>errors.push(error)});
  const emit=(message,patch={})=>preview.receive({origin:preview.runtimeOrigin,source:frame.contentWindow,data:{source:'world-atelier-game',nonce:preview.nonce,canonical_identity:preview.runtimeBuildId,seq:1,scene_generation:1,...message},...patch});
  return {preview,seen,sent,errors,emit};
}

test('game bridge rejects foreign windows, origins, nonces and mismatched boot identities',t=>{
  const f=bridge(t),ready={type:'ready',source_revision:'source',runtime_source_hash:'b'.repeat(64),capabilities:['canonical-game-runtime']};
  f.emit(ready,{origin:location.origin});f.emit(ready,{origin:'http://other.invalid'});f.emit(ready,{source:{}});f.emit({...ready,nonce:'old'});assert.equal(f.preview.ready,undefined);
  f.emit({...ready,source_revision:'old'});assert.equal(f.errors.length,1);assert.equal(f.preview.ready,undefined);
  f.emit(ready);assert.equal(f.preview.ready,true);
  f.emit({type:'world_state',canonical_identity:'c'.repeat(64)});assert.equal(f.errors.length,2);assert.equal(f.seen.length,0);
});

test('old scene packets cannot become current observations after a scene switch',t=>{
  const f=bridge(t);
  f.emit({type:'world_state',world_id:'preview:one',epoch:1,scene_revision:'source',document_id:'project/main/B',scene_generation:2});
  assert.equal(f.seen.length,1);assert.equal(f.preview.sceneGeneration,2);
  f.emit({type:'camera',document_id:'project/main/A',position:[0,1,2],scene_generation:1});
  f.emit({type:'selected',id:'old-selection',scene_generation:1});
  f.emit({type:'world_state',world_id:'preview:old',epoch:1,scene_generation:2});
  f.emit({type:'camera',seq:0,scene_generation:2});
  assert.equal(f.seen.length,1);assert.equal(f.preview.lastCameraEvent,null);
  f.preview.bindScene({document_id:'project/main/B',scene_revision:'source'},2);f.preview.ready=true;
  f.preview.select('box');f.preview.camera('front');
  assert.deepEqual(f.sent.map(p=>[p.type,p.document_id,p.seq,p.scene_generation]),[['select','project/main/B',1,2],['camera','project/main/B',1,2]]);
});

test('workspace inspection UI commands carry fixed world identity and reject stale callers',t=>{
  const f=bridge(t);
  // The real UI toggle omits scene_revision; the transport owns that fixed identity.
  f.preview.world({action:'inspection_ui',world_id:'preview:one',epoch:1,visible:true});
  assert.deepEqual(f.sent,[{world_id:'preview:one',epoch:1,scene_revision:'source',action:'inspection_ui',visible:true,type:'world',seq:1,scene_generation:1}]);
  for(const stale of [{world_id:'preview:old'},{epoch:0},{scene_revision:'old-source'}])f.preview.world({action:'inspection_ui',visible:false,...stale});
  assert.equal(f.sent.length,1);
});

test('cached A to B to A rebinds the real document and clears old selection without another read',async()=>{
  const source=await readFile(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
  const start=source.indexOf('function trackLocalScene(message){'),end=source.indexOf('\nconst modeLong=',start);
  assert.ok(start>=0&&end>start);
  const scenes=new Map(['A','B'].map(id=>[`project/main/${id}/source`,{document_id:`project/main/${id}`,resource_id:id,scene_revision:'source'}]));
  const bindings=[];const sandbox={world:{session_kind:'local_preview',world_id:'preview:1'},project:{id:'project'},branch:{branch_id:'main'},mode:'play',localDocumentRequest:null,worldScene:scenes.values().next().value,worldState:{},annotationView:{old:true},selectedId:'old',joinGeneration:1,
    localSceneDocument:(revision,id)=>scenes.get(`${id}/${revision}`),localSceneDocuments:scenes,
    mainPreview:{sceneContext:{document_id:'project/main/A'},boundSceneGeneration:1,bindScene(scene,generation){this.sceneContext=scene;this.boundSceneGeneration=generation;bindings.push([scene.document_id,generation]);}},
    invalidateMainCamera(){},renderExplorer(){},renderStage(){},renderInspector(){},suspendWorld:error=>assert.fail(error),sourceScene:()=>assert.fail('Cached fixed document must not be refetched'),errorText:error=>error.message};
  vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);
  sandbox.trackLocalScene({document_id:'project/main/B',scene_revision:'source',scene_generation:2});
  sandbox.selectedId='box-in-B';sandbox.trackLocalScene({document_id:'project/main/A',scene_revision:'source',scene_generation:3});
  assert.deepEqual(bindings,[['project/main/B',2],['project/main/A',3]]);assert.equal(sandbox.selectedId,null);assert.equal(sandbox.annotationView,null);assert.equal(sandbox.worldScene.resource_id,'A');
});


test('local Play shows runtime status without assuming a character or offering default controls',async()=>{
  const source=await readFile(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
  const start=source.indexOf('function renderPlayControls(){'),end=source.indexOf('\nlet conversationFrame=',start);
  assert.ok(start>=0&&end>start);
  const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{dataset:{}});return elements.get(id);};
  let enabled;
  const sandbox={$:element,playControls:{setEnabled(value){enabled=value;}},world:{session_kind:'local_preview'},worldState:{mode:'playing',tick:12,control_ready:true},mode:'play',modePending:false,inputEnabled:true,api:{ready:true},renderInspectionUi(){},short:v=>v??'',fmt:String};
  vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);sandbox.renderPlayControls();
  assert.equal(enabled,false);assert.equal(element('#playControlActions').hidden,true);
  assert.equal(element('#playerPosition').hidden,true);assert.equal(element('#worldPlayerDetail').hidden,true);
  assert.equal(element('#playControls').hidden,false);assert.equal(element('#worldTick').textContent,'本局时刻 #12');
  assert.equal(element('#playControlsTitle').textContent,'试玩运行状态');
  sandbox.mode='inspect';sandbox.renderPlayControls();assert.equal(enabled,false);assert.equal(element('#playControlActions').hidden,true);
  sandbox.world={session_kind:'shared_world'};sandbox.mode='play';sandbox.renderPlayControls();
  assert.equal(enabled,true);assert.equal(element('#playControlActions').hidden,false);assert.equal(element('#playerPosition').hidden,false);
});


test('local startup, direct inspection and resume use runtime readiness without a player control slot',()=>{
  const mode=new WorldModeSequence();
  const state={session_kind:'local_preview',mode:'playing',runtime_ready:true,control_ready:false};
  const start=mode.begin('play',null);
  assert.equal(mode.acknowledge({...state,runtime_ready:false,request_id:start.request_id}).complete,false);
  assert.equal(mode.acknowledge({...state,request_id:start.request_id}).complete,true);
  const inspect=mode.begin('inspect',state);assert.equal(inspect.mode,'inspecting');
  assert.equal(mode.acknowledge({...state,mode:'inspecting',runtime_ready:false,request_id:inspect.request_id}).complete,true);
  const resume=mode.begin('play',{...state,mode:'inspecting',runtime_ready:false});
  assert.equal(mode.acknowledge({...state,request_id:resume.request_id}).complete,true);
  const fromEdit=mode.begin('inspect',null);assert.equal(fromEdit.mode,'playing');
  const next=mode.acknowledge({...state,request_id:fromEdit.request_id});assert.equal(next.complete,false);assert.equal(next.next.mode,'inspecting');
  assert.equal(mode.acknowledge({...state,mode:'inspecting',runtime_ready:false,request_id:next.next.request_id}).complete,true);
});

test('runtime readiness cannot bypass shared-world control authority',()=>{
  const mode=new WorldModeSequence(),start=mode.begin('play',null);
  const state={session_kind:'shared_world',mode:'playing',runtime_ready:true,control_ready:false,request_id:start.request_id};
  assert.equal(mode.acknowledge(state).complete,false);
  assert.equal(mode.acknowledge({...state,control_ready:true}).complete,true);
});
