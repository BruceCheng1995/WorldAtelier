// Negative bridge envelopes only. This file never claims a positive real
// engine response, canvas, input or scene transition.
import test from 'node:test';
import assert from 'node:assert/strict';
import {GamePlay} from '../../apps/creation-workspace/game-play.js';

function fixture(){
  const preview=Object.create(GamePlay.prototype),seen=[],errors=[],rejected=[];
  const inner={},context={document_id:'p/main/A',source_revision:'source'};
  Object.assign(preview,{disposed:false,runtimeOrigin:'http://[::ffff:7f00:1]:48921',frame:{contentWindow:inner},nonce:'independent-launch',runtimeBuildId:'canonical',job:{source_revision:'source',runtime_source_hash:'runtime'},sceneGeneration:4,seq:8,commandSeq:8,loadedSeq:8,sceneContext:context,worldContext:{world_id:'run',epoch:1},captures:new Map(),host:{dataset:{}},onEvent:packet=>seen.push(packet),fail:message=>errors.push(message),diagnostic:()=>{}});
  const emit=(packet,patch={})=>preview.receive({origin:preview.runtimeOrigin,source:inner,data:{source:'world-atelier-game',nonce:preview.nonce,canonical_identity:'canonical',source_revision:'source',...packet},...patch});
  return{preview,seen,errors,rejected,emit,context};
}

test('I05 forbidden creator actions and wrong-origin/window messages have no bridge side effect',()=>{
  const f=fixture();
  for(const type of ['history','transform','fetch','read_creator_secret','write_source','publish'])f.emit({type,scene_generation:999});
  f.emit({type:'play_context',scene_generation:999},{origin:'http://127.0.0.1:48921'});
  f.emit({type:'play_context',scene_generation:999},{source:{}});
  f.emit({type:'play_context',nonce:'old-launch',scene_generation:999});
  assert.deepEqual(f.seen,[]);assert.deepEqual(f.errors,[]);assert.equal(f.preview.sceneGeneration,4);
});

test('I05 an unsolicited screenshot response cannot advance the runtime scene generation',()=>{
  const f=fixture();f.emit({type:'captured_frame',request_id:'not-pending',scene_generation:999,document_id:'p/main/other'});
  assert.equal(f.preview.sceneGeneration,4);assert.deepEqual(f.seen,[]);assert.equal(f.preview.captures.size,0);
});

test('O06 read-only observation telemetry cannot advance GamePlay scene identity',()=>{
  const f=fixture();f.emit({type:'play_context',protocol:'wa-play-context-1',runtime_instance_id:'run',scene_generation:999,resource_id:'other',kind:'snapshot',payload:{objects:[]}});
  assert.equal(f.preview.sceneGeneration,4);assert.equal(f.preview.host.dataset.sceneGeneration,undefined);
});

test('I06 a pending screenshot with another document is rejected without changing the current scene',()=>{
  const f=fixture();let rejection=null,accepted=false;
  f.preview.captures.set('pending',{timer:null,seq:8,generation:4,context:f.context,reject:error=>{rejection=error;},resolve:()=>{accepted=true;}});
  f.emit({type:'captured_frame',request_id:'pending',seq:8,scene_generation:4,document_id:'p/main/other',data_url:'data:image/png;base64,eA=='});
  assert.equal(accepted,false);assert.ok(rejection instanceof Error);assert.equal(f.preview.sceneGeneration,4);assert.equal(f.preview.captures.size,0);
});
