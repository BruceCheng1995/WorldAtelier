// Browser transport boundary only. Actual Godot applied ACK is tested separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeSharedPlay,prepareNativeSharedPlay} from '../../apps/creation-workspace/native-shared-play.js';
function bridge(t){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'http://localhost:48921'}});t.after(()=>previous?Object.defineProperty(globalThis,'location',previous):delete globalThis.location);
 const preview=Object.create(NativeSharedPlay.prototype),seen=[],sent=[],errors=[];
 Object.assign(preview,{disposed:false,runtimeOrigin:'http://[::ffff:7f00:1]:48921',frame:{contentWindow:{}},nonce:'iframe',seq:1,commandSeq:1,job:{source_revision:'source',runtime_source_hash:'runtime'},runtimeBuildId:'build',host:{dataset:{}},status:{},sceneContext:{document_id:'p/main/scene'},worldContext:{world_id:'world',epoch:2,scene_revision:'source',resource_id:'scene',scene_generation:4,control_generation:'controller'},onEvent:p=>seen.push(p),post:p=>sent.push(p),fail:e=>errors.push(e)});
 const emit=(data,changes={})=>preview.receive({origin:preview.runtimeOrigin,source:preview.frame.contentWindow,data:{source:'world-atelier-game',nonce:'iframe',canonical_identity:'build',...data},...changes});return{preview,seen,sent,errors,emit};
}
test('only exact real-engine ready envelope reaches the host baseline barrier',t=>{
 const f=bridge(t),packet={...f.preview.worldContext,type:'shared_ready',sequence:12,state_hash:'actual-snapshot',source_identity:'source-hash'};
 for(const field of ['world_id','epoch','scene_revision','resource_id','scene_generation','control_generation'])f.emit({...packet,[field]:'stale'});
 f.emit(packet,{origin:location.origin});f.emit(packet,{origin:'http://wrong'});f.emit(packet,{source:{}});f.emit({...packet,nonce:'previous-iframe'});assert.equal(f.seen.length,0);
 f.emit(packet);assert.equal(f.seen.length,1);assert.equal(f.seen[0].type,'shared_ready');assert.equal(f.seen[0].state_hash,'actual-snapshot');assert.equal(f.preview.loadedSeq,1);
 f.emit({type:'native_shared',packet:{...packet,type:undefined,action:'applied',control_generation:undefined}});assert.equal(f.seen.length,1,'periodic projection ACK is not a join ACK');
});
test('native input bridge preserves full target identity and rejects superseded controller',t=>{
 const f=bridge(t),packet={...f.preview.worldContext,action:'input',input_seq:9,inputs:[{target_key:'[["player","nested"],"actor"]',action:'move',payload:{x:1}}]};
 f.emit({type:'native_shared',packet:{...packet,control_generation:'old'}});assert.equal(f.seen.length,0);
 f.emit({type:'native_shared',packet});assert.equal(f.seen[0].type,'native_shared_input');assert.deepEqual(f.seen[0].inputs,packet.inputs);
});
test('inspection toggle gains the current shared identity and ignores other worlds and revisions',t=>{
 const f=bridge(t);f.preview.world({world_id:'world',epoch:2,action:'inspection_ui',visible:true});assert.deepEqual(f.sent[0],{type:'native_shared',packet:{...f.preview.worldContext,action:'inspection_ui',visible:true,seq:1}});
 for(const patch of [{world_id:'old'},{epoch:1},{scene_revision:'previous'}])f.preview.world({world_id:'world',epoch:2,action:'inspection_ui',...patch});assert.equal(f.sent.length,1);
});
test('shared resolution cannot consume an independent or unpublished build',async t=>{
 bridge(t);const fixed={native_shared:true,resource_id:'scene',game_build_id:'build-one',source_revision:'source',runtime_build_id:'canonical'},job={id:'build-one',purpose:'native_shared',status:'completed',project_id:'p',branch_id:'main',entry_scene_id:'scene',source_revision:'source',canonical_identity:'canonical'};
 for(const patch of [{purpose:'play'},{purpose:'native_preview'},{status:'running'},{project_id:'other'},{canonical_identity:'other'}])await assert.rejects(prepareNativeSharedPlay({projectId:'p',branchId:'main',resourceId:'scene',fixed,request:async()=>({job:{...job,...patch}})}));
 let access=false;await assert.rejects(prepareNativeSharedPlay({projectId:'p',branchId:'main',resourceId:'scene',fixed,request:async(route)=>route.endsWith('/access')?(access=true,{web_url:'https://other.invalid/index.html'}):{job}}));assert.equal(access,true);
});
test('temporary projection scene generations cannot poison the pinned actual mode acknowledgement',t=>{
 const f=bridge(t);f.preview.sceneGeneration=4;
 const state={...f.preview.worldContext,type:'world_state',document_id:'p/main/scene',mode:'playing',control_ready:true,runtime_ready:true,seq:1,request_id:'actual-mode-request'};
 f.emit({...state,scene_generation:5,mode:'resyncing'});f.emit({...state,resource_id:'temporary-entry'});f.emit({...state,document_id:'p/main/other'});
 assert.equal(f.seen.length,0);assert.equal(f.preview.sceneGeneration,4);
 f.emit(state);assert.equal(f.seen.length,1);assert.equal(f.seen[0].request_id,'actual-mode-request');assert.equal(f.seen[0].mode,'playing');
 f.preview.worldContext=null;f.emit({...state,scene_generation:9});assert.equal(f.preview.sceneGeneration,4);
});
test('only the matching pending shared application emits one runtime recovery',t=>{
 const f=bridge(t),recoveries=[];f.preview.diagnostic=(...values)=>recoveries.push(values);f.preview.pending={timer:null,resolve:()=>{}};
 const packet={...f.preview.worldContext,type:'shared_ready',sequence:12,state_hash:'actual-snapshot',source_identity:'source-hash'};
 f.emit({...packet,scene_generation:9});assert.equal(recoveries.length,0);
 f.emit(packet);f.emit(packet);assert.equal(recoveries.length,1);assert.deepEqual(recoveries[0],['runtime_load','共享场景已实际加载',{recovered:true}]);assert.equal(f.preview.pending,null);
});
