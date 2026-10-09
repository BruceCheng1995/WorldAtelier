// Real SQLite atomicity and coordinator state tests. They do not simulate a
// positive Godot ACK or claim an actual multiplayer runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeWorlds} from '../../services/creation/native-worlds.mjs';
const root=resolve('.local/creation-verification/native-framework/native-world-state');mkdirSync(root,{recursive:true});
function fixture(t){
 const data=mkdtempSync(join(root,'case-')),store=new CreationStore(join(data,'creation.sqlite'));t.after(()=>store.close());
 const manifest={schema:'creation-native-1',source_identity:'identity',resources:{A:{kind:'scene'},B:{kind:'scene'}}};store.put('creator_revision',{id:'revision',project_id:'project',manifest});
 const service={store},owner={store,service,persist:w=>store.put('creator_world',{id:w.id,project_id:w.project_id,revision:w.revision,snapshot:w.snapshot})};const native=new NativeWorlds(owner);
 const world={id:'world',key:'project/main/A/native',project_id:'project',branch_id:'main',resource_id:'A',revision:'revision',source_identity:'identity',epoch:1,runtime_build_id:'runtime',game_build_id:'build',activated:true,history:new Map(),clients:new Map()};
 const snapshot={schema:'wa-native-world-state-1',world_id:'world',epoch:1,scene_revision:'revision',source_identity:'identity',resource_id:'A',scene_generation:1,sequence:1,tick:1,players:{},nodes:{},spawns:{},removed:[]};
 world.snapshot=structuredClone(snapshot);world.history.set(1,world.snapshot);
 const verification={id:'verification',status:'passed'},input={publication:{requestKey:'request',requestId:'logical-request',fingerprint:'exact-input',user_id:'actor'}};
 return{store,native,world,snapshot,verification,input};
}
test('world, delivery, transition and idempotent request commit in one real SQLite transaction',t=>{
 const f=fixture(t),transition={id:'transition',status:'committed'};const result=f.native.commitPublication(f.world,f.verification,f.input,{same_process:false},transition);
 assert.deepEqual(f.store.get('creator_native_world_publication','request').result,result);assert.deepEqual(f.store.get('creator_delivery',result.delivery.id),result.delivery);assert.deepEqual(f.store.get('creator_world_transition','transition'),transition);assert.deepEqual(f.store.get('creator_world','world').snapshot,f.snapshot);
});
test('failed receipt write rolls back the actual SQLite world and delivery writes',t=>{
 const f=fixture(t);f.store.put('creator_world',{id:'world',revision:'previous'});const put=f.store.put.bind(f.store);f.store.put=(kind,value)=>{if(kind==='creator_native_world_publication')throw Error('injected receipt storage failure');return put(kind,value);};
 assert.throws(()=>f.native.commitPublication(f.world,f.verification,f.input,{}),/receipt storage failure/);
 assert.deepEqual(f.store.get('creator_world','world'),{id:'world',revision:'previous'});assert.equal(f.store.list('creator_delivery').length,0);assert.equal(f.store.list('creator_native_world_publication').length,0);
});
test('ACK ingestion fences A to B and same-scene generation changes exactly once',t=>{
 const f=fixture(t),transfers=[];f.native.transferClients=(w,fields)=>transfers.push({generation:w.snapshot.scene_generation,...fields});
 f.native.ingest(f.world,{...f.snapshot,sequence:2,resource_id:'B',scene_generation:2});assert.equal(transfers.length,1);assert.equal(f.world.snapshot.resource_id,'B');
 f.native.ingest(f.world,{...f.snapshot,sequence:1});assert.equal(transfers.length,1);assert.equal(f.world.snapshot.resource_id,'B');
 f.native.ingest(f.world,{...f.snapshot,sequence:3,resource_id:'B',scene_generation:3});assert.equal(transfers.length,2);
 f.native.ingest(f.world,{...f.snapshot,sequence:4,resource_id:'B',scene_generation:3});assert.equal(transfers.length,2);
});
test('ACK ingestion refuses source identity and unknown actual scene before replacing baseline',t=>{
 const f=fixture(t);for(const patch of [{resource_id:'outside-fixed-catalog'},{source_identity:'other'}])assert.throws(()=>f.native.ingest(f.world,{...f.snapshot,sequence:2,...patch}),e=>e.status===502);
 assert.deepEqual(f.world.snapshot,f.snapshot);
});
