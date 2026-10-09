/** Fake interaction/transport probes; no browser, Codex, Godot or live service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {CreationClient,SceneRevisionCache,WorldModeSequence,validWorldInput,validSessionPacket,previewPeers,withDevelopmentMetadata} from '../apps/creation-workspace/collaboration-client.js';

test('editing → inspect waits for matching playable control ACK, then requests inspect',()=>{
 const flow=new WorldModeSequence(),sent=[];
 const first=flow.begin('inspect',{mode:'editing'});sent.push(first);
 assert.equal(first.mode,'playing');
 assert.equal(flow.acknowledge({mode:'playing',control_ready:true,request_id:'old-request'}).next,null);
 assert.equal(flow.acknowledge({mode:'playing',control_ready:false,request_id:first.request_id}).complete,false);
 const ready=flow.acknowledge({mode:'playing',control_ready:true,request_id:first.request_id});sent.push(ready.next);
 assert.equal(ready.next.mode,'inspecting');assert.notEqual(ready.next.request_id,first.request_id);
 assert.equal(flow.acknowledge({mode:'playing',control_ready:true,request_id:first.request_id}).complete,false);
 assert.equal(flow.acknowledge({mode:'inspecting',request_id:ready.next.request_id}).complete,true);
 assert.deepEqual(sent.map(p=>p.mode),['playing','inspecting']);
});
test('existing confirmed playable session may inspect directly; cancelled request cannot ACK',()=>{
 const flow=new WorldModeSequence(),step=flow.begin('inspect',{mode:'playing',control_ready:true});assert.equal(step.mode,'inspecting');
 flow.clear();assert.equal(flow.acknowledge({mode:'inspecting',request_id:step.request_id}).complete,false);
});
test('new world publications keep frozen revision and at most eight immutable scene copies',()=>{
 const cache=new SceneRevisionCache(8),first={scene_revision:'r1',objects:[{id:'one',model_hash:'old',position:[1,0,0]}]};cache.put(first);cache.pin('r1');first.objects[0].position[0]=999;
 for(let i=2;i<=12;i++)cache.put({scene_revision:`r${i}`,objects:[{id:'one',model_hash:`new-${i}`}]});
 assert.equal(cache.scenes.size,8);assert.equal(cache.get('r1').objects[0].position[0],1);assert.equal(cache.get('r12').objects[0].model_hash,'new-12');
 const view=cache.get('r1');view.objects[0].model_hash='modified';assert.equal(cache.get('r1').objects[0].model_hash,'old');
 cache.pin(null);cache.put({scene_revision:'r13',objects:[]});assert.equal(cache.get('r1'),null);
});
test('disconnect, missing local world and different world epoch/revision reject old inputs',()=>{
 const world={world_id:'world-1',epoch:3,scene_revision:'r2'},input={...world,input_seq:20,move:[1,0]};
 assert.equal(validWorldInput(input,world,true,true),true);
 for(const [connected,enabled,bound]of [[false,true,world],[true,false,world],[true,true,null]])assert.equal(validWorldInput(input,bound,connected,enabled),false);
 for(const changed of [{epoch:2},{world_id:'old'},{scene_revision:'r1'}])assert.equal(validWorldInput({...input,...changed},world,true,true),false);
});
test('UI independently fences an old private-session packet even before subscription changes',()=>{
 const scope={project_id:'p',branch_id:'b'},session={id:'new',...scope};
 assert.equal(validSessionPacket({session_id:'old'},'new',session,scope),false);
 assert.equal(validSessionPacket({session_id:'new'},'new',{...session,branch_id:'other'},scope),false);
 assert.equal(validSessionPacket({session_id:'new'},'new',session,scope),true);
});
test('client session boundary drops old packets immediately while new history is loading',()=>{
 globalThis.sessionStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};globalThis.location={protocol:'http:',host:'fake.invalid'};
 class Socket{static OPEN=1;constructor(){this.readyState=1;this.sent=[];}send(text){this.sent.push(JSON.parse(text));}close(){this.readyState=3;}packet(p){this.onmessage({data:JSON.stringify(p)});}}
 globalThis.WebSocket=Socket;const client=new CreationClient(),events=[];client.addEventListener('packet',e=>events.push(e.detail));
 try{
  client.login('fake-token');client.ws.onopen();client.ws.packet({type:'authenticated',peer_id:'fake-peer'});
  client.subscribeSession('old',8);client.selectSessionBoundary('new');
  client.ws.packet({type:'session_event',session_id:'old',event:{cursor:90}});client.ws.packet({type:'session_event',session_id:'new',event:{cursor:91}});
  assert.equal(events.filter(e=>e.type==='session_event').length,0);assert.equal(client.after,0);
  client.subscribeSession('new',100);client.ws.packet({type:'session_event',session_id:'new',event:{cursor:101}});
  assert.equal(events.filter(e=>e.type==='session_event').length,1);
  client.selectSessionBoundary();client.ws.packet({type:'session_event',session_id:'new',event:{cursor:102}});assert.equal(client.after,0);
 }finally{client.logout();}
});
test('development metadata maps per object without changing canonical source or other resources',()=>{
 const scene={scene_revision:'source-r1',resource_id:'scene-a',objects:[{id:'one',version:'v1',position:[0,0,0]},{id:'two',version:'v2'}]},before=JSON.stringify(scene);
 const result=withDevelopmentMetadata(scene,[{resource_id:'scene-a',object_id:'one',execution:'running'},{resource_id:'different-scene',object_id:'two',execution:'completed'}]);
 assert.equal(JSON.stringify(scene),before);assert.equal(result.scene_revision,'source-r1');assert.equal(result.objects[0].version,'v1');assert.equal(result.objects[0].developments[0].status,'editing');assert.equal(result.objects[1].developments.length,0);assert.equal(result.developments,undefined);
});
test('presence uses per-window peer IDs and excludes the current viewport',()=>{
 const result=previewPeers([{id:'same-user',peer_id:'self'},{id:'same-user',peer_id:'second-window'},{id:'other',peer_id:'third-window'}],'self');
 assert.deepEqual(result.map(p=>p.id),['second-window','third-window']);
});


test('actual workspace disconnect lifecycle closes bridge control first and reconnect never rejoins',async()=>{
 const source=await readFile(new URL('../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
 const lifecycle=source.slice(source.indexOf('function leaveWorld(){'),source.indexOf('function armModeTimeout(){'));
 const status=source.slice(source.indexOf("api.addEventListener('status',"),source.indexOf("api.addEventListener('authorization',"));
 const runtime=vm.createContext({clearTimeout:()=>{}});
 vm.runInContext(`
  let calls=[],inputEnabled=true,joinGeneration=1,joinRequest={generation:1},worldLoadPending=true;
  let world={world_id:'w',epoch:2,scene_revision:'r1'},worldScene={},worldState={},frozenScene={},inspectionSentKey='old',inspectionRecord={},requestedMode='play',modePending=true,mode='play',modeTimer=null,connectionInterrupted=false;
  let peers=[{}],previews=new Map(),branch={branch_id:'main'},statusHandler;
  const collaborationAccess=null,user=null,project=null,inbox=null,diagnostics={setConnection:()=>{}},scheduleIssues=()=>{},refreshPermissions=async()=>{},report=()=>{};
  const ui={textContent:'',dataset:{}};const $=()=>ui,key=()=> 'p/main/scene';
  const worldScenes={clear:()=>calls.push({kind:'cache-clear'})},modeSequence={clear:()=>calls.push({kind:'mode-clear'})};
  const mainPreview={world:p=>calls.push({kind:'bridge',packet:p,inputEnabled}),presence:p=>calls.push({kind:'presence',packet:p})};
  const api={send:p=>calls.push({kind:'ws',packet:p}),addEventListener:(type,handler)=>{if(type==='status')statusHandler=handler;}};
  const renderStage=()=>{},renderInspector=()=>{},toast=()=>{};
  const restoreEditPreview=()=>calls.push({kind:'restore-edit-preview'});
  const renderTopbarAgents=()=>calls.push({kind:'roster',peerCount:peers.length}),cancelLocalEdit=()=>calls.push({kind:'cancel-edit'});
  const invalidateMainCamera=()=>calls.push({kind:'invalidate-camera'}),playControls={setEnabled:enabled=>calls.push({kind:'play-controls',enabled})};
  ${lifecycle}
  ${status}
  statusHandler({detail:{state:'disconnected'}});
  const stopped={inputEnabled,world,mode,joinRequest,connectionInterrupted};
  statusHandler({detail:{state:'connected'}});
  globalThis.result={stopped,calls,mode,world,connectionInterrupted};
 `,runtime);
 const result=JSON.parse(JSON.stringify(runtime.result));
 assert.equal(result.stopped.inputEnabled,false);assert.equal(result.stopped.world,null);assert.equal(result.mode,'edit');
 assert.equal(result.calls.find(c=>c.kind==='bridge').packet.action,'leave');assert.equal(result.calls.find(c=>c.kind==='bridge').inputEnabled,false);
 assert.equal(result.calls.filter(c=>c.kind==='roster').length,1);assert.equal(result.calls.find(c=>c.kind==='roster').peerCount,0,'disconnect clears online avatar state before redrawing the roster');
 assert.equal(result.calls.filter(c=>c.kind==='cancel-edit').length,1,'disconnect still cancels a transient edit');
 assert.equal(result.calls.find(c=>c.kind==='play-controls').enabled,false);assert.ok(result.calls.findIndex(c=>c.kind==='invalidate-camera')<result.calls.findIndex(c=>c.kind==='bridge'),'camera intent and control authority are invalidated before runtime leave');
 assert.equal(result.calls.filter(c=>c.kind==='ws'&&c.packet.type==='world_join').length,0);assert.equal(result.connectionInterrupted,false);
 assert.equal(result.calls.filter(c=>c.kind==='restore-edit-preview').length,1);
});
