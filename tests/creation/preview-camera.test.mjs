// FAKE iframe postMessage/ACK regression. These tests do not run a browser or Godot.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {GodotPreview} from '../../apps/creation-workspace/preview-bridge.js';
const origin='http://fake-preview.invalid',saved={};
before(()=>{for(const [name,value]of Object.entries({location:{origin},window:{removeEventListener(){}}})){saved[name]=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,configurable:true});}});
after(()=>{for(const [name,descriptor]of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];});
function fixture(t,{ready=true}={}){
 const sent=[],events=[],sender={postMessage:packet=>sent.push(structuredClone(packet))};
 const bridge=Object.create(GodotPreview.prototype);Object.assign(bridge,{seq:0,loadedSeq:0,ready,nonce:'fake-nonce',status:{remove(){}},host:{dataset:{}},frame:{contentWindow:sender,remove(){}},worldQueue:new Map(),onEvent:event=>events.push(event)});
 const receive=packet=>bridge.receive({origin,source:sender,data:{source:'world-atelier-preview',nonce:'fake-nonce',...packet}});
 const loaded=(overrides={})=>receive({type:'loaded',seq:bridge.seq,document_id:bridge.sceneContext.document_id,selected_id:bridge.sceneContext.selected_id,...overrides});
 t.after(()=>bridge.dispose());return {bridge,sent,events,receive,loaded,cameras:()=>sent.filter(p=>p.type==='camera')};
}
const scene=(overrides={})=>({document_id:'project/main/scene',source_revision:'v1',scene_revision:'v1',selected_id:'door-A',objects:[],...overrides});

test('FAKE bridge: pending F focus survives runtime readiness and posts only after exact scene loaded',async t=>{
 const {bridge,sent,receive,loaded,cameras}=fixture(t,{ready:false}),pending=bridge.scene(scene());bridge.camera('focus');assert.equal(sent.length,0);
 receive({type:'ready'});assert.equal(sent.length,1);assert.equal(sent[0].type,'scene');assert.equal(cameras().length,0);
 loaded();await pending;assert.equal(cameras().length,1);assert.deepEqual(cameras()[0],{source:'world-atelier-workspace',nonce:'fake-nonce',type:'camera',seq:1,document_id:'project/main/scene',selected_id:'door-A',preview_object_id:null,action:'focus'});
 loaded();assert.equal(cameras().length,1,'duplicate loaded ACK must not replay focus');bridge.camera('fit');assert.equal(cameras().at(-1).action,'fit','already loaded camera remains immediate');
});

test('FAKE bridge: repeated camera requests keep only the newest action for the pending generation',async t=>{
 const {bridge,loaded,cameras}=fixture(t),pending=bridge.scene(scene());bridge.camera('focus');bridge.camera('top');bridge.camera('fit');
 const reused=bridge.scene(scene({frame:true}));assert.equal(reused,pending,'frame hint alone does not start another generation');loaded();await pending;assert.deepEqual(cameras().map(p=>p.action),['fit']);
});

test('FAKE bridge: next document generation discards the previous queued focus',async t=>{
 for(const next of [scene({document_id:'project/other/scene'}),scene({preview_object_id:'different-subtree'})]){
  const {bridge,receive,loaded,cameras}=fixture(t),oldScene=scene(),old=bridge.scene(oldScene),rejected=assert.rejects(old,/目标已切换/);bridge.camera('focus');
  const oldSeq=bridge.seq,current=bridge.scene(next);await rejected;
  receive({type:'loaded',seq:oldSeq,document_id:oldScene.document_id,selected_id:oldScene.selected_id});assert.equal(cameras().length,0);
  loaded();await current;assert.equal(cameras().length,0,'old focus never follows a new selection/document');bridge.dispose();
 }
});

test('FAKE bridge: queued newest-generation camera does not flush for wrong seq/document/selection',async t=>{
 const {bridge,receive,loaded,cameras}=fixture(t),pending=bridge.scene(scene());bridge.camera('focus');
 loaded({seq:0});loaded({document_id:'other-document'});assert.equal(bridge.loadedSeq,0);assert.equal(cameras().length,0);assert.ok(bridge.pendingCamera);
 loaded({selected_id:'unexpected-door'});await pending;assert.equal(cameras().length,0,'different actual selection cannot receive the requested focus');assert.equal(bridge.pendingCamera,null);
 receive({type:'loaded',seq:1,document_id:'project/main/scene',selected_id:'door-A'});assert.equal(cameras().length,0);
});

test('FAKE bridge: error drops pending camera; a late loaded packet cannot resurrect it',async t=>{
 const {bridge,receive,loaded,cameras}=fixture(t),pending=bridge.scene(scene()),rejected=assert.rejects(pending,/fake bad model/);bridge.camera('focus');
 receive({type:'error',seq:bridge.seq,document_id:bridge.sceneContext.document_id,message:'fake bad model'});await rejected;assert.equal(bridge.pendingCamera,null);
 loaded();bridge.camera('fit');assert.equal(cameras().length,0);const retry=bridge.scene(scene());loaded();await retry;assert.equal(cameras().length,0,'retry does not reuse failed camera intent');
});

test('FAKE bridge: timeout drops pending camera and explicit reopen does not reuse it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {bridge,loaded,cameras}=fixture(t),pending=bridge.scene(scene()),rejected=assert.rejects(pending,/加载超时/);bridge.camera('focus');
 t.mock.timers.tick(60000);await rejected;assert.equal(bridge.pendingCamera,null);const reopen=bridge.scene(scene());loaded();await reopen;assert.equal(cameras().length,0);
});

test('FAKE bridge: dispose synchronously clears queue and fences late ACK, camera and scene calls',async t=>{
 const {bridge,loaded,cameras,events}=fixture(t),pending=bridge.scene(scene()),rejected=assert.rejects(pending,/视口关闭/);bridge.camera('focus');bridge.dispose();await rejected;
 loaded();bridge.camera('fit');await assert.rejects(bridge.scene(scene()),/视口已关闭/);assert.equal(bridge.pendingCamera,null);assert.equal(cameras().length,0);assert.equal(events.length,0);
});

test('FAKE bridge: manifest failure rejects pending scene and camera instead of retaining an intent',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('FAKE manifest unavailable');});const {bridge,cameras}=fixture(t,{ready:false}),pending=bridge.scene(scene()),rejected=assert.rejects(pending,/manifest unavailable/);bridge.camera('focus');
 await assert.rejects(bridge.loadRuntime(),/manifest unavailable/);await rejected;assert.equal(bridge.pendingCamera,null);assert.equal(cameras().length,0);
});

test('FAKE bridge: root interaction_error behavior still preserves a successfully loaded scene',async t=>{
 const {bridge,receive,loaded,events}=fixture(t),pending=bridge.scene(scene());loaded();await pending;const key=bridge.key;
 receive({type:'error',seq:bridge.seq,document_id:bridge.sceneContext.document_id,code:'local_trs_unrepresentable'});
 assert.equal(events.at(-1).type,'interaction_error');assert.equal(bridge.key,key);assert.equal(bridge.loadedSeq,1);assert.equal(bridge.status.textContent,'');
});


test('FAKE bridge: multi-selection updates all outlines without loading another scene or retaining old focus',async t=>{
 const {bridge,sent,loaded,cameras}=fixture(t),pending=bridge.scene(scene());bridge.camera('focus');
 const reused=bridge.scene(scene({selected_id:'door-B',selected_ids:['door-A','door-B']}));
 assert.equal(reused,pending);assert.equal(bridge.seq,1);
 loaded({selected_id:'door-A'});await pending;
 assert.equal(cameras().length,0);
 const selections=()=>sent.filter(packet=>packet.type==='select');
 assert.deepEqual(selections().at(-1).ids,['door-A','door-B']);assert.equal(selections().at(-1).id,'door-B');
 await bridge.scene(scene({selected_id:'door-B',selected_ids:['door-B']}));
 assert.deepEqual(selections().at(-1).ids,['door-B']);assert.equal(sent.filter(packet=>packet.type==='scene').length,1);
 bridge.select('',[]);assert.deepEqual(selections().at(-1).ids,[]);assert.equal(selections().at(-1).id,'');
});

test('FAKE bridge: document switch discards a queued multi-selection',async t=>{
 const {bridge,sent,loaded}=fixture(t),pending=bridge.scene(scene()),rejected=assert.rejects(pending,/目标已切换/);
 bridge.select('door-B',['door-A','door-B']);
 const next=bridge.scene(scene({document_id:'project/main/other',selected_id:'',selected_ids:[]}));await rejected;loaded();await next;
 assert.equal(sent.filter(packet=>packet.type==='select').length,0);
});


test('FAKE bridge: engine group selection keeps camera context current without echoing a drag-cancelling selection',async t=>{
 const {bridge,sent,receive,loaded}=fixture(t),pending=bridge.scene(scene());loaded();await pending;
 receive({type:'selected',seq:bridge.seq,document_id:bridge.sceneContext.document_id,id:'door-B',ids:['door-A','door-B']});
 bridge.camera('focus');assert.equal(sent.at(-1).selected_id,'door-B');assert.deepEqual(bridge.sceneContext.selected_ids,['door-A','door-B']);
 assert.equal(sent.filter(packet=>packet.type==='select').length,0);
});

test('FAKE bridge: drop location is scoped to the loaded native source and cannot accept a late foreign reply',async t=>{
 const {bridge,sent,loaded,receive}=fixture(t),pending=bridge.scene(scene({source_identity:'native-source'}));loaded();await pending;
 const location=bridge.placement([.2,.7]),request=sent.at(-1);
 assert.equal(request.type,'placement');assert.deepEqual(request.screen,[.2,.7]);
 receive({...request,source:'world-atelier-preview',type:'placement',seq:0,dimension:'3d',position:[1,2,3],source_revision:'v1',source_identity:'native-source'});assert.ok(bridge.pendingPlacement);
 receive({...request,source:'world-atelier-preview',type:'placement',request_id:'foreign',dimension:'3d',position:[1,2,3],source_revision:'v1',source_identity:'native-source'});assert.ok(bridge.pendingPlacement);
 receive({...request,source:'world-atelier-preview',type:'placement',dimension:'3d',position:[1,2,3],source_revision:'v1',source_identity:'native-source'});
 assert.deepEqual(await location,{dimension:'3d',position:[1,2,3]});assert.equal(bridge.pendingPlacement,null);
});

test('FAKE bridge: scene changes, bad coordinates and mismatched drop source never return placement',async t=>{
 const {bridge,sent,loaded,receive}=fixture(t),pending=bridge.scene(scene({source_identity:'native-source'}));loaded();await pending;
 for(const screen of [[NaN,0],[1.01,0],[0],null])await assert.rejects(bridge.placement(screen),/视口内/);
 const invalid=bridge.placement([.5,.5]),invalidRejection=assert.rejects(invalid,/不匹配/),request=sent.at(-1);
 receive({...request,source:'world-atelier-preview',type:'placement',source_revision:'v1',source_identity:'other-source',dimension:'3d',position:[0,0,0]});await invalidRejection;
 const stale=bridge.placement([.5,.5]),staleRejection=assert.rejects(stale,/目标已切换/);
 const changed=bridge.scene(scene({document_id:'project/main/other'}));await staleRejection;loaded();await changed;
 assert.equal(bridge.pendingPlacement,null);
});

test('FAKE bridge: drop timeout, duplicate requests and readout errors do not create locations',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {bridge,sent,loaded,receive}=fixture(t),pending=bridge.scene(scene());loaded();await pending;
 const timed=bridge.placement([.5,.5]),timeout=assert.rejects(timed,/无法获取/);await assert.rejects(bridge.placement([.5,.5]),/稍候/);t.mock.timers.tick(5000);await timeout;
 const failed=bridge.placement([.5,.5]),failure=assert.rejects(failed,/没有可放置/);receive({...sent.at(-1),source:'world-atelier-preview',type:'placement',error:'placement_no_intersection'});await failure;
 assert.equal(bridge.pendingPlacement,null);
});

test('FAKE bridge: drag ghosts use the exact loaded source and never queue into a later scene',async t=>{
 const {bridge,sent,loaded}=fixture(t),pending=bridge.scene(scene({source_identity:'fixed-native'}));
 assert.equal(bridge.prefabDrag({phase:'move',drag_id:'drag',screen:[.3,.5]}),false);loaded();await pending;
 assert.equal(bridge.prefabDrag({phase:'move',drag_id:'drag',prefab_path:'res://box.tscn',screen:[.3,.5],seq:900,document_id:'other',source_identity:'forged'}),true);
 const packet=sent.at(-1);assert.equal(packet.type,'prefab_drag');assert.equal(packet.seq,bridge.seq);assert.equal(packet.document_id,'project/main/scene');assert.equal(packet.source_revision,'v1');assert.equal(packet.source_identity,'fixed-native');
 bridge.prefabDrag({phase:'hide',drag_id:'drag'});assert.equal(sent.at(-1).phase,'hide');
 bridge.prefabDrag({phase:'clear',drag_id:'drag'});assert.equal(sent.at(-1).phase,'clear');
 const next=bridge.scene(scene({document_id:'project/main/other'}));const count=sent.length;
 assert.equal(bridge.prefabDrag({phase:'move',drag_id:'drag',screen:[.2,.2]}),false);loaded();await next;assert.equal(sent.length,count);
});
