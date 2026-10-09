// Protocol rejection tests; these do not claim a real Godot/client ACK.
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWorldVersion,validateNativeInput,validateNativeReady,validateNativeSnapshot} from '../../services/creation/native-world-protocol.mjs';
const world={id:'world',key:'p/b/s',epoch:3,revision:'rev',runtime_build_id:'build',snapshot:{resource_id:'scene-one',scene_generation:2}};
const client=()=>({user:{id:'alice'},world_key:world.key,world_active:true,control_generation:'control-new',last_input_seq:4,world_barrier:{sequence:10,state_hash:'fixed-snapshot'}});
const envelope=()=>({world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:world.snapshot.resource_id,scene_generation:world.snapshot.scene_generation,control_generation:'control-new'});
const input=()=>({...envelope(),input_seq:5,inputs:[{target_key:JSON.stringify([['spawn-alice'],'body']),action:'move',payload:{axis:[1,0]}}]});
test('publication CAS is stable across ticks and changes on revision, runtime or authority',()=>{
 const version=nativeWorldVersion(world);assert.equal(version,nativeWorldVersion({...world,snapshot:{tick:100}}));assert.equal(nativeWorldVersion(null),null);
 for(const field of ['id','epoch','revision','runtime_build_id'])assert.notEqual(version,nativeWorldVersion({...world,[field]:String(world[field])+'-new'}));
});
test('inputs retain full nested instance identity and derive the player from the authenticated connection',()=>{
 const packet=input(),result=validateNativeInput(packet,world,client());assert.equal(result.player_id,'alice');assert.deepEqual(result.inputs,packet.inputs);packet.inputs[0].payload.axis[0]=0;assert.equal(result.inputs[0].payload.axis[0],1);
});
test('not yet applied, superseded controller, old epoch, old source and replayed sequence cannot write',()=>{
 assert.throws(()=>validateNativeInput(input(),world,{...client(),world_active:false}),e=>e.status===409);
 for(const field of ['world_id','epoch','scene_revision','resource_id','scene_generation','control_generation'])assert.throws(()=>validateNativeInput({...input(),[field]:'old'},world,client()),e=>e.status===409);
 assert.throws(()=>validateNativeInput({...input(),input_seq:4},world,client()),e=>e.status===409);
 assert.throws(()=>validateNativeInput({...input(),player_id:'bob'},world,client()),e=>e.status===403);
});
test('empty input is a valid stop intent with the same sequence and authority fences',()=>{assert.deepEqual(validateNativeInput({...input(),inputs:[]},world,client()).inputs,[]);});
test('arbitrary target aliases, method injection and malformed actions are rejected',()=>{
 for(const change of [{target_key:'node-name'},{target_key:'[[],null]'},{target_key:'[[],"body","extra"]'},{action:'../../set'},{method:'set'}])assert.throws(()=>validateNativeInput({...input(),inputs:[{...input().inputs[0],...change}]},world,client()),e=>e.status===400);
});
test('input payload rejects nonfinite numbers, prototype keys, cycles and oversized batches',()=>{
 const cycle={};cycle.self=cycle;
 for(const payload of [NaN,Infinity,{x:1e13},JSON.parse('{"__proto__":{}}'),cycle])assert.throws(()=>validateNativeInput({...input(),inputs:[{...input().inputs[0],payload}]},world,client()),e=>e.status===400);
 assert.throws(()=>validateNativeInput({...input(),inputs:Array(33).fill(input().inputs[0])},world,client()),e=>e.status===400);
});
test('applied ACK must match the actual pending baseline hash and controller',()=>{
 const ready={...envelope(),sequence:10,state_hash:'fixed-snapshot'};assert.equal(validateNativeReady(ready,world,client()),true);
 for(const field of Object.keys(ready))assert.throws(()=>validateNativeReady({...ready,[field]:'wrong'},world,client()),e=>e.status===409);
 assert.throws(()=>validateNativeReady(ready,world,{...client(),world_barrier:null}),e=>e.status===409);
});
test('native authority snapshot requires a complete matching envelope',()=>{
 const snapshot={schema:'wa-native-world-state-1',world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:'scene-one',scene_generation:2,sequence:10,tick:40,players:{},nodes:{},spawns:{},removed:[]};assert.equal(validateNativeSnapshot(snapshot,world),snapshot);
 for(const change of [{schema:'legacy'},{world_id:'other'},{epoch:2},{scene_revision:'other'},{resource_id:null},{scene_generation:0},{sequence:-1},{tick:Infinity},{nodes:[]},{players:null},{spawns:[]},{removed:{}}])assert.throws(()=>validateNativeSnapshot({...snapshot,...change},world),e=>e.status===502);
});
