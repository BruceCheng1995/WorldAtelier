import test from 'node:test';
import assert from 'node:assert/strict';
import {PlayContextBuffer,projectedFocusCandidates} from '../../apps/creation-workspace/play-context-buffer.js';
import {PLAY_CONTEXT_PROTOCOL,normalizePlayCapture} from '../../packages/contracts/play-context.mjs';

const scope={project_id:'p',branch_id:'main',source_revision:'src-one',build_id:'build-one',runtime_instance_id:'run-one',resource_id:'room',scene_generation:1};
const packet=(sequence,extra={})=>({type:'play_context',protocol:PLAY_CONTEXT_PROTOCOL,...scope,sequence,kind:'event',payload:{kind:'pointer_down',source:'user_input',payload:{button:1,position:[.1,.2]}},...extra});
function fixture(options={}){let time=0;const buffer=new PlayContextBuffer({now:()=>time,wallNow:()=>100000+time,...options});buffer.bind(scope);return {buffer,set(value){time=value;}};}

test('default history is the bounded last 60 seconds and an explicit extension cannot restore discarded input',()=>{
  const {buffer,set}=fixture();set(1000);buffer.accept(packet(1));set(61001);buffer.accept(packet(2));
  assert.equal(buffer.events.length,1);assert.equal(buffer.events[0].sequence,2);buffer.extend(300);set(62000);
  const capture=buffer.freeze({requestId:'test'});assert.equal(capture.window.requested_seconds,300);assert.equal(capture.events.length,1);assert.ok(capture.gaps.some(g=>g.reason==='recording_started'));
});
test('motion is coalesced and count/byte caps report loss instead of growing indefinitely',()=>{
  const {buffer,set}=fixture({limits:{events:3,localBytes:2000}});
  for(let i=1;i<50;i++){set(i*20);buffer.record({kind:'pointer_move',payload:{position:[i/100,.5]}});}assert.equal(buffer.events.length,1);assert.ok(buffer.events[0].payload.coalesced>1);
  for(let i=1;i<9;i++){set(1000+i);buffer.record({kind:'pointer_down',payload:{button:1}});}assert.ok(buffer.events.length<=3);assert.ok(buffer.bytes<=2000);assert.ok(buffer.gaps.some(g=>g.reason==='local_budget'));
});
test('other runs and old generations cannot contaminate history; scene changes retain scoped evidence',()=>{
  const {buffer,set}=fixture();set(100);assert.equal(buffer.accept(packet(1,{runtime_instance_id:'another'})),false);assert.equal(buffer.events.length,0);
  assert.equal(buffer.accept(packet(1)),true);set(200);assert.equal(buffer.accept(packet(2,{scene_generation:2,resource_id:'indoor'})),true);
  assert.equal(buffer.accept(packet(3,{scene_generation:1})),false);assert.ok(buffer.events.some(e=>e.kind==='scene_changed'));assert.equal(buffer.events[0].resource_id,'room');assert.equal(buffer.scope.resource_id,'indoor');
  buffer.bind({...scope,runtime_instance_id:'new-run'});assert.equal(buffer.events.length,0);
});
test('snapshot differences are bounded and sequence gaps are visible',()=>{
  const {buffer,set}=fixture();set(10);buffer.accept(packet(1,{kind:'snapshot',payload:{objects:[{runtime_id:'a',position:[0,0,0]}]}}));
  set(1000);buffer.accept(packet(4,{kind:'snapshot',payload:{objects:[{runtime_id:'a',position:[1,0,0]},{runtime_id:'b',position:[0,0,0]}]}}));
  const event=buffer.events.at(-1);assert.equal(event.kind,'state_changed');assert.deepEqual(event.payload.changed,['a']);assert.deepEqual(event.payload.added,['b']);assert.ok(buffer.gaps.some(g=>g.reason==='runtime_sequence_gap'));
});
test('empty screen regions remain valid intent and freezing never follows later changes',()=>{
  const {buffer,set}=fixture();set(300);buffer.setFocus({kind:'screen_region',rect:[.1,.2,.3,.4],runtime_ids:[]});
  const captured=buffer.freeze({requestId:'immutable'});buffer.setFocus({kind:'objects',runtime_ids:['x']});
  assert.deepEqual(captured.focus.runtime_ids,[]);assert.deepEqual(captured.focus.rect,[.1,.2,.3,.4]);assert.equal(captured.focus.world_position,undefined);
  const normalized=normalizePlayCapture(captured);assert.equal(normalized.focus.coordinates,'normalized_screen');
});
test('closing a window clears local frames and input and prevents default reattachment',()=>{
  const {buffer}=fixture();buffer.accept(packet(1));buffer.close();assert.equal(buffer.events.length,0);assert.equal(buffer.frames.length,0);assert.throws(()=>buffer.freeze({requestId:'closed'}),/关闭|切换/);
});
test('wire validation rejects oversized, nonfinite, executable and reversed observations',()=>{
  const {buffer,set}=fixture();set(10);buffer.accept(packet(1));set(20);const capture=buffer.freeze({requestId:'valid'});
  assert.throws(()=>normalizePlayCapture({...capture,scope:{...scope,scene_generation:NaN}}));
  assert.throws(()=>normalizePlayCapture({...capture,snapshot:{objects:[],evil:()=>{}}}));
  assert.throws(()=>normalizePlayCapture({...capture,focus:{kind:'screen_region',rect:[.9,0,.5,.5]}}));
  assert.throws(()=>normalizePlayCapture({...capture,events:[{...capture.events[0],at_ms:19},{...capture.events[0],at_ms:12}]}));
});
test('a single oversized event or snapshot is rejected or trimmed before it can exceed the local budget',()=>{
  const {buffer,set}=fixture({limits:{localBytes:600,captureBytes:1800}});set(10);
  assert.equal(buffer.record({kind:'huge',payload:{text:'x'.repeat(1900)}}),false);assert.equal(buffer.events.length,0);assert.ok(buffer.bytes<=600);
  buffer.accept(packet(1,{kind:'snapshot',payload:{objects:[{runtime_id:'one',name:'x'.repeat(1900)}]}}));assert.ok(buffer.bytes<=600);assert.ok(buffer.snapshot.objects.length===0);
  assert.equal(buffer.accept(packet(2,{kind:'snapshot',payload:{objects:[{runtime_id:'one',name:'x'.repeat(5000)}]}})),false);assert.ok(buffer.bytes<=600);
  const capture=buffer.freeze({requestId:'bounded'});assert.ok(new TextEncoder().encode(JSON.stringify(capture)).length<=1800);
});
test('shared authority epoch change discards the prior authority buffer even if the iframe and scene remain',()=>{
  const {buffer,set}=fixture();buffer.bind({...scope,world_id:'world-one',epoch:1,session_kind:'shared_world'});set(10);buffer.record({kind:'pointer_down',payload:{}});
  buffer.bind({...scope,world_id:'world-one',epoch:2,session_kind:'shared_world'});assert.equal(buffer.events.length,0);assert.equal(buffer.scope.epoch,2);
});
test('focusing a historical frame uses its fixed projection even when objects later move or disappear',()=>{
  const {buffer,set}=fixture();set(100);buffer.accept(packet(1,{kind:'snapshot',tick:4,payload:{objects:[{runtime_id:'moving',name:'Door',visible:true,screen_bounds:[.1,.1,.2,.2]}],mode:'inspect'}}));
  set(120);const frame=buffer.addFrame({data_url:'data:image/png;base64,YQ==',mode:'inspect'});assert.equal(frame.projection.synchronized,true);
  set(1000);buffer.accept(packet(2,{kind:'snapshot',tick:8,payload:{objects:[{runtime_id:'new-object',visible:true,screen_bounds:[.1,.1,.2,.2]},{runtime_id:'moving',visible:true,screen_bounds:[.7,.7,.2,.2]}],mode:'play'}}));
  assert.deepEqual(projectedFocusCandidates(frame,{point:[.2,.2]}).map(row=>row.runtime_id),['moving']);assert.deepEqual(projectedFocusCandidates(frame,{point:[.8,.8]}),[]);
  assert.equal(frame.projection.objects.length,1,'new nodes never appear in old frame metadata');
});
test('unsynchronized live and delayed frames keep screen intent without guessing node identity',()=>{
  const {buffer,set}=fixture();set(100);buffer.accept(packet(1,{kind:'snapshot',tick:4,payload:{objects:[{runtime_id:'moving',visible:true,screen_bounds:[.1,.1,.2,.2]}],mode:'play'}}));
  set(120);const live=buffer.addFrame({data_url:'data:image/png;base64,YQ==',mode:'play'});assert.equal(live.projection.synchronized,false);assert.deepEqual(projectedFocusCandidates(live,{point:[.2,.2]}),[]);
  const matched=buffer.addFrame({data_url:'data:image/png;base64,YQ==',mode:'play',tick:4});assert.equal(matched.projection.synchronized,true);
  set(900);const late=buffer.addFrame({data_url:'data:image/png;base64,YQ==',mode:'play',tick:4});assert.equal(late.projection.synchronized,false);
});
