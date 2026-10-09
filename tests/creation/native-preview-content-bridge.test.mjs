// Protocol regression with explicit fake DOM/ACKs, not runtime visual evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeGodotPreview} from '../../apps/creation-workspace/native-preview.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const packet=revision=>({project_id:'p',branch_id:'main',resource_id:'main',document_id:'p/main/main',document_schema:'creation-native-1',native_scene_path:'res://main.tscn',source_identity:revision,source_revision:revision,scene_revision:revision,objects:[],frame:false});
function fixture(t,request){
  const saved=new Map(['location','window'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  Object.defineProperty(globalThis,'location',{value:{origin:'http://fake.invalid'},configurable:true});
  Object.defineProperty(globalThis,'window',{value:{removeEventListener(){}},configurable:true});
  const sent=[],bridge=Object.create(NativeGodotPreview.prototype);
  Object.assign(bridge,{host:{dataset:{}},status:{textContent:'',remove(){}},frame:{src:'resident-editor',style:{},contentWindow:{postMessage:m=>sent.push(m)},remove(){}},
    nonce:'resident',seq:0,loadedSeq:0,ready:true,nativeGeneration:0,worldQueue:new Map(),onEvent(){},request,
    runtimeManifest:{id:'base',project_id:'p',branch_id:'main',source_revision:'r0',native_content_protocol:'wa-native-editor-content-1'}});
  t.after(()=>{bridge.dispose();for(const [k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}});
  const ack=()=>bridge.receive({origin:location.origin,source:bridge.frame.contentWindow,data:{source:'world-atelier-preview',nonce:bridge.nonce,type:'loaded',seq:bridge.seq,document_id:bridge.sceneContext.document_id}});
  return {bridge,sent,ack};
}
async function until(predicate){for(let n=0;n<200;n++){if(predicate())return;await tick();}throw Error('fake bridge did not reach expected state');}
test('native content reload preserves resident iframe and waits for exact loaded before ready',async t=>{
  const calls=[];const {bridge,sent,ack}=fixture(t,async(route,options)=>{calls.push(route);return {compatible:true,content:{sha256:'digest',source_revision:options.body.source_revision}};});
  const first=bridge.scene(packet('r1'));await until(()=>sent.length>0);
  assert.equal(bridge.frame.src,'resident-editor');assert.equal(bridge.nonce,'resident');assert.equal(bridge.host.dataset.previewState,'updating');
  assert.ok(sent[0].native_preview_content);assert.equal(calls.length,1);assert.match(calls[0],/native-preview-content$/);
  ack();await first;assert.equal(bridge.host.dataset.previewState,'ready');assert.equal(bridge.host.dataset.displayedSource,'r1');assert.equal(bridge.frame.style.pointerEvents,'');
  await bridge.scene({...packet('r1'),selected_id:'selected'});assert.equal(calls.length,1,'selection does not prepare scene content again');
});
test('rapid revisions discard the obsolete preparation before any content request',async t=>{
  const calls=[];const {bridge,ack,sent}=fixture(t,async(route,options)=>{calls.push(options.body.source_revision);return {compatible:true,content:{sha256:'digest'}};});
  const a=bridge.scene(packet('r1'));const rejected=assert.rejects(a,{name:'AbortError'});
  const b=bridge.scene(packet('r2'));await rejected;await until(()=>sent.length>0);ack();await b;
  assert.deepEqual(calls,['r2']);assert.equal(bridge.host.dataset.displayedSource,'r2');
});
test('failed content refresh reports failure and can retry without exporting a game',async t=>{
  let attempts=0;const {bridge,sent,ack}=fixture(t,async()=>{if(++attempts===1)throw Error('engine failed');return {compatible:true,content:{sha256:'digest'}};});
  await assert.rejects(bridge.scene(packet('r1')),/engine failed/);assert.equal(bridge.host.dataset.previewState,'error');assert.equal(bridge.frame.src,'resident-editor');
  const retry=bridge.scene(packet('r1'));await until(()=>sent.length>0);ack();await retry;assert.equal(attempts,2);
});
