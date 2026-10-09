// Control-boundary unit tests. Fixtures model checkpoints/transports; no real
// shared world, socket listener, gameplay acceptance or runtime ACK is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CreationWorlds} from '../../services/creation/worlds.mjs';
import {hash} from '../../services/creation/schema.mjs';
const user={id:'u'},scope={project_id:'p',branch_id:'b',resource_id:'r'},key='p/b/r';
const nativeError=e=>e.status===422&&e.details?.code==='native_shared_runtime_unavailable';
function fixture({head='native',room=null}={}){
 const records=new Map(),branch={head},calls=[];
 for(const [id,schema]of [['legacy','creation-flat-1'],['hierarchy','creation-hierarchy-2'],['native','creation-native-1'],['native-next','creation-native-1']])records.set('creator_revision/'+id,{id,project_id:'p',manifest:{schema,entry_scene_id:'r',resources:{r:{id:'r',kind:'scene',objects:[]}}}});
 const store={get:(t,id)=>records.get(t+'/'+id),put:(t,o)=>records.set(t+'/'+o.id,structuredClone(o)),list:t=>[...records].filter(([k])=>k.startsWith(t+'/')).map(([,v])=>v),branchFor:()=>branch,ancestor:()=>true,projectFor:()=>({id:'p'}),roleFor:()=> 'editor'};
 const manager=Object.create(CreationWorlds.prototype);
 Object.assign(manager,{store,worlds:new Map(),preparing:new Map(),validationJobs:new Map(),directory:'/not-used',service:{origin:'http://127.0.0.1:48921',assets:{scene:()=>{calls.push('scene');return {document_id:key};}},realtime:{send:(_c,p)=>calls.push(p)}},runtimeManifest:()=>{calls.push('runtime');return {build_id:'build',capabilities:{document_schemas:['creation-flat-1','creation-hierarchy-2']}}}});
 if(room){const w={id:'world',key,...scope,revision:room,runtime_build_id:'build',epoch:2,snapshot:{world_id:'world',epoch:2,scene_revision:room,sequence:9},ready:true,clients:new Map()};manager.worlds.set(key,w);records.set('creator_world/world',structuredClone(w));}
 return {manager,records,branch,calls};
}
const client=()=>({id:'client',user,scope,ws:{readyState:1}});
const join=(revision)=>({type:'world_join',...scope,runtime_build_id:'build',...(revision===undefined?{}:{source_revision:revision})});
const stop=Error('test stopped before process preparation');
test('native validate rejects before runtime lookup, candidate directory or verification record',async()=>{
 const f=fixture();f.manager.runtimeManifest=()=>{throw Error('must not inspect legacy runtime');};await assert.rejects(f.manager.validate(user,'p','b',{}),nativeError);assert.equal(f.manager.validationJobs.size,0);assert.equal(f.records.size,4);
});
test('native publish rejection preserves an existing legacy world and never starts validation',async()=>{
 const f=fixture({room:'legacy'}),world=f.manager.worlds.get(key),before=structuredClone(world);f.manager.validate=()=>{throw Error('must not validate');};await assert.rejects(f.manager.publish(user,'p','b'),nativeError);assert.deepEqual(world,before);assert.equal(f.records.size,5);
});
test('playable rejects native first-start but reports an existing legacy release under native head',()=>{
 const native=fixture();assert.throws(()=>native.manager.playable(user,'p','b','r'),nativeError);assert.deepEqual(native.calls,[]);
 for(const room of ['legacy','hierarchy']){const f=fixture({room});assert.equal(f.manager.playable(user,'p','b','r').source_revision,room);assert.deepEqual(f.calls,[]);}
});
test('ensure rejects native first-start and native recovery without taking a preparation lock',async()=>{
 const f=fixture();f.manager.startWorld=()=>{throw Error('must not start');};await assert.rejects(f.manager.ensure(user,'p','b','r'),nativeError);assert.equal(f.manager.preparing.size,0);
 const old=fixture({room:'legacy'});await assert.rejects(old.manager.ensure(user,'p','b','r',{recovery:{revision:'native'}}),nativeError);assert.equal(old.manager.worlds.get(key).ready,true);
});
test('ensure and scene retain a running legacy world when source head is native',async()=>{
 const f=fixture({room:'legacy'}),world=f.manager.worlds.get(key);assert.equal(await f.manager.ensure(user,'p','b','r'),world);f.manager.scene(user,world);assert.deepEqual(f.calls,['scene']);assert.throws(()=>f.manager.scene(user,world,'native'),nativeError);
});
test('pending legacy preparation stays pinned while the branch head migrates',async()=>{
 const f=fixture({head:'legacy'});let resolve;f.manager.startWorld=()=>new Promise(r=>resolve=r);
 const first=f.manager.ensure(user,'p','b','r');assert.equal(f.manager.preparing.get(key).sourceRevision,'legacy');f.branch.head='native';const second=f.manager.ensure(user,'p','b','r');resolve('legacy-ready');assert.deepEqual(await Promise.all([first,second]),['legacy-ready','legacy-ready']);assert.equal(f.manager.preparing.size,0);
});
test('startWorld rejects native target before validator or fixed runtime work',async()=>{
 const f=fixture();f.manager.validate=()=>{throw Error('must not validate');};await assert.rejects(f.manager.startWorld(user,'p','b','r',key),nativeError);assert.deepEqual(f.calls,[]);
});
test('automatic restore validates the old applied release under native head',async()=>{
 const f=fixture({room:'legacy'});f.manager.worlds.clear();let input;f.manager.validate=async(_u,_p,_b,value)=>{input=value;throw stop;};await assert.rejects(f.manager.startWorld(user,'p','b','r',key),e=>e===stop);assert.equal(input.revision,'legacy');assert.equal(f.records.get('creator_world/world').snapshot.sequence,9);
});
test('explicit recovery of the old applied release retains proof and unchanged migration-head guards',async()=>{
 const f=fixture({room:'legacy'});f.manager.worlds.clear();const old=f.records.get('creator_world/world');old.failure={kind:'infrastructure',message:'transport lost'};
 const verification={id:'v',status:'passed',...scope,revision:'legacy',runtime_build_id:'build',state_hash:hash(old.snapshot)};
 let guards=0;f.manager.prepareRuntime=async()=>{throw stop;};await assert.rejects(f.manager.startWorld(user,'p','b','r',key,{recovery:{revision:'legacy',verification,guard:()=>guards++}}),e=>e===stop);assert.equal(guards,1);
 f.manager.prepareRuntime=async()=>{f.branch.head='native-next';return {};};await assert.rejects(f.manager.startWorld(user,'p','b','r',key,{recovery:{revision:'legacy',verification}}),e=>e.status===409&&e.world_start_precondition);assert.equal(f.manager.worlds.size,0);
});
test('native boundary does not weaken recovery state, lease or previously applied revision guards',async()=>{
 for(const variant of ['state','lease','unapplied']){const f=fixture({room:'legacy'});f.manager.worlds.clear();const old=f.records.get('creator_world/world'),revision=variant==='unapplied'?'hierarchy':'legacy',verification={id:'v',status:'passed',...scope,revision,runtime_build_id:'build',state_hash:variant==='state'?'bad':hash(old.snapshot)};f.manager.prepareRuntime=async()=>{throw Error('must not prepare');};await assert.rejects(f.manager.startWorld(user,'p','b','r',key,{recovery:{revision,verification,guard:()=>{if(variant==='lease')throw Object.assign(Error('revoked'),{status:403});}}}),e=>e.status===(variant==='lease'?403:409));}
});
test('world_join rejects native with or without explicit revision before ensure or transport',async()=>{
 for(const revision of [undefined,'native']){const f=fixture();f.manager.ensure=()=>{throw Error('must not ensure');};await assert.rejects(f.manager.message(client(),join(revision)),nativeError);assert.deepEqual(f.calls,[]);}
});
test('native-head legacy room joins accept omitted or exact applied revision without touching source',async()=>{
 for(const revision of [undefined,'legacy']){const f=fixture({room:'legacy'}),world=f.manager.worlds.get(key);f.manager.leave=async()=>{};f.manager.tell=(_w,p)=>f.calls.push(p);await f.manager.message(client(),join(revision));assert.equal(world.clients.size,1);assert.equal(f.calls.find(x=>x.type==='world')?.packet.scene_revision,'legacy');assert.equal(f.branch.head,'native');assert.equal(f.records.size,5);}
});
test('native-head legacy join refuses native source and invalid revisions without stopping old room',async()=>{
 for(const revision of ['native','foreign',{},'']){const f=fixture({room:'legacy'});await assert.rejects(f.manager.message(client(),join(revision)),revision==='native'?nativeError:e=>e.status===409);assert.equal(f.manager.worlds.get(key).ready,true);assert.equal(f.manager.worlds.get(key).clients.size,0);assert.deepEqual(f.calls,[]);}
});
test('legacy-only branches keep their existing explicit moving-head join check',async()=>{
 const f=fixture({head:'hierarchy',room:'legacy'});await assert.rejects(f.manager.message(client(),join('legacy')),e=>e.status===409);assert.equal(f.manager.worlds.get(key).clients.size,0);
});
