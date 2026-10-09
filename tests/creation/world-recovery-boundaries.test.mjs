// FAKE control-boundary unit probes. No Godot, HTTP service, browser or real ACK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { CreationWorlds } from '../../services/creation/worlds.mjs';
import { hash } from '../../services/creation/schema.mjs';
const user={id:'u'}, key='p/b/r';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(failure={message:'Godot 权威连接中断',at:1}){
  const records=new Map(), branch={head:'rev'};
  const old={id:'world',key,project_id:'p',branch_id:'b',resource_id:'r',revision:'rev',runtime_build_id:'build',epoch:3,snapshot:{world_id:'world',epoch:3,scene_revision:'rev',sequence:99,players:{u:{position:[1,2,3]}}},failure};
  records.set('creator_world/world',structuredClone(old));
  const manager=Object.create(CreationWorlds.prototype);
  Object.assign(manager,{store:{get:(t,k)=>records.get(`${t}/${k}`),put:(t,o)=>records.set(`${t}/${o.id}`,structuredClone(o)),list:t=>[...records.entries()].filter(([k])=>k.startsWith(t+'/')).map(([,v])=>structuredClone(v)),branchFor:()=>branch},worlds:new Map(),workers:new Set(),preparing:new Map(),tokens:new Map(),service:{realtime:{send(){}}},wss:{close(){}},validationJobs:new Map()});
  records.set('creator_revision/rev',{manifest:{entry_scene_id:'r'}});
  const verification={id:'v',status:'passed',project_id:'p',branch_id:'b',resource_id:'r',revision:'rev',runtime_build_id:'build',state_hash:hash(old.snapshot)};
  manager.validate=async()=>structuredClone(verification);manager.runtimeManifest=()=>({build_id:'build'});
  return{manager,records,old,branch,verification};
}
function fakeWorld(old={}){return{...old,key,id:'world',project_id:'p',branch_id:'b',resource_id:'r',revision:'rev',runtime_build_id:'build',epoch:4,snapshot:{world_id:'world',epoch:4,scene_revision:'rev',sequence:100},failure_history:[],pending:new Map(),clients:new Map(),history:new Map(),ready:true,activated:true,token:'token',...old};}
const status=n=>e=>e.status===n;

test('FAKE: automatic joins never retry persisted faults, even after source head moves',async()=>{
  for(const failure of [{message:'Godot 权威连接中断'}, {kind:'behavior',message:'broken'}]){
    const{manager,branch}=fixture(failure);let validations=0;manager.validate=()=>{validations++;throw Error('must not validate');};
    for(let n=0;n<3;n++){branch.head=n?'rev-next':'rev';await assert.rejects(manager.startWorld(user,'p','b','r',key),status(422));}
    assert.equal(validations,0);assert.equal(manager.worlds.size,0);
  }
});
test('FAKE: recovery proof pins scope, state, head, runtime build and permission before any spawn',async()=>{
  const cases=[['scope',(f)=>f.verification.branch_id='other',422],['state',(f)=>f.verification.state_hash='other',409],['head',(f)=>f.branch.head='later',409],['build',(f)=>f.manager.runtimeManifest=()=>({build_id:'later'}),409],['guard',()=>{},403]];
  for(const[label,change,code]of cases){const f=fixture();change(f);let guard=()=>{};if(label==='guard')guard=()=>{throw Object.assign(Error('lease revoked'),{status:403});};
    await assert.rejects(f.manager.startWorld(user,'p','b','r',key,{recovery:{revision:'rev',verification:f.verification,guard}}),status(code));assert.equal(f.manager.worlds.size,0,label);
  }
});
test('FAKE: behavior and unknown failures cannot re-run identical source+runtime, even with passed validation',async()=>{
  for(const failure of [{kind:'behavior',message:'fault'}, {message:'unknown'}]){const f=fixture(failure);await assert.rejects(f.manager.startWorld(user,'p','b','r',key,{recovery:{revision:'rev',verification:f.verification}}),status(422));assert.equal(f.manager.worlds.size,0);}
});
test('FAKE: shared preparing lock does not leak explicit recovery permission to auto join',async()=>{
  const{manager}=fixture();const gate=deferred();let calls=0;manager.startWorld=()=>{calls++;return gate.promise;};
  const recovery=manager.ensure(user,'p','b','r',{recovery:{revision:'rev'}});
  await assert.rejects(manager.ensure(user,'p','b','r'),status(409));await assert.rejects(manager.ensure(user,'p','b','r',{recovery:{revision:'rev'}}),status(409));
  gate.resolve('ready');assert.equal(await recovery,'ready');assert.equal(calls,1);assert.equal(manager.preparing.size,0);
});
test('FAKE: concurrent ordinary join may share ordinary prepare; explicit publish may not take it over',async()=>{
  const{manager}=fixture();const gate=deferred();let calls=0;manager.startWorld=()=>{calls++;return gate.promise;};const a=manager.ensure(user,'p','b','r'),b=manager.ensure(user,'p','b','r');
  await assert.rejects(manager.ensure(user,'p','b','r',{recovery:{}}),status(409));gate.resolve('ready');assert.deepEqual(await Promise.all([a,b]),['ready','ready']);assert.equal(calls,1);
});
test('FAKE: publish recovery passes exact validation and guard to ensure, stores only ACK-backed delivery',async()=>{
  const{manager,records,verification}=fixture();let validates=0,guards=0;const guard=()=>guards++;manager.validate=async()=>{validates++;return verification;};
  manager.ensure=async(_u,_p,_b,_r,{recovery})=>{assert.equal(recovery.verification,verification);assert.equal(recovery.revision,'rev');assert.equal(recovery.guard,guard);assert.equal(records.size,2);return{id:'world',epoch:4,revision:'rev',snapshot:{sequence:101}};};
  const result=await manager.publish(user,'p','b',{guard});assert.equal(validates,1);assert.equal(guards,2);assert.equal(result.delivery.applied_sequence,101);assert.equal(records.get('creator_delivery/'+result.delivery.id).verification_id,'v');
});
test('FAKE: failures retain confirmed baseline and immutable failure history rather than a rejected candidate',()=>{
  const{manager,old,records}=fixture();const legacy=manager.archiveFailure(old,old.failure);assert.equal(manager.archiveFailure(old,old.failure),legacy);
  const world=fakeWorld({...old,revision:'candidate',runtime_build_id:'new-build',epoch:4,activated:false,previous_record:old,failure_history:[legacy]});manager.worlds.set(key,world);
  manager.failed(world,Error('init failed'));const saved=records.get('creator_world/world');assert.equal(saved.revision,'rev');assert.equal(saved.epoch,3);assert.equal(saved.runtime_build_id,'build');assert.deepEqual(saved.snapshot,old.snapshot);assert.equal(saved.failure.revision,'candidate');assert.equal(saved.failure_history.length,2);assert.equal(manager.store.list('creator_world_failure').length,2);assert.equal(manager.store.get('creator_world_failure',legacy).kind,'infrastructure');
});
test('FAKE: lease revoked while init awaits ACK rejects activation and preserves old checkpoint',async()=>{
  const{manager,old,records}=fixture();const ack=deferred(), world=fakeWorld({...old,epoch:4,activated:false,ready:false,previous_record:old});let revoked=false;world.assertStart=()=>{if(revoked)throw Object.assign(Error('lease revoked'),{status:403,world_start_precondition:true});};manager.command=()=>ack.promise;manager.worlds.set(key,world);
  const ws=new EventEmitter();ws.close=()=>{};manager.workerConnected(world,ws);ws.emit('message',Buffer.from('{"type":"worker_hello"}'));revoked=true;ack.resolve({ok:true,snapshot:{world_id:'world',epoch:4,scene_revision:'rev',sequence:100}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(world.activated,false);assert.equal(records.get('creator_world/world').snapshot.sequence,99);assert.equal(records.get('creator_world/world').failure.message,'lease revoked');assert.equal(records.get('creator_world/world').failure.kind,'precondition');
});
test('FAKE: close marker prevents late worker disconnect persisting a false failure',async()=>{
  const{manager,records}=fixture(null),world=fakeWorld();manager.worlds.set(key,world);manager.beginClose();assert.equal(manager.closing,true);assert.equal(records.get('creator_world/world').snapshot.sequence,100);
  manager.failed(world,Error('Godot 权威连接中断'),{kind:'infrastructure'});await manager.close();assert.equal(records.get('creator_world/world').failure,undefined);assert.equal(manager.store.list('creator_world_failure').length,0);await assert.rejects(manager.ensure(user,'p','b','r'),status(503));
});
test('FAKE: reaper signals only owned child and does not treat SIGKILL send as exit',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const{manager}=fixture();const child=new EventEmitter(),signals=[];child.kill=s=>signals.push(s);const world={process:child};let finished=false;const reap=manager.reap(world).then(()=>finished=true);
  t.mock.timers.tick(1500);assert.deepEqual(signals,['SIGTERM']);t.mock.timers.tick(500);await Promise.resolve();assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(finished,false);
  child.emit('close',null,'SIGKILL');await reap;assert.equal(finished,true);
});
test('FAKE: unconfirmed child close rejects cleanup, never success',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const{manager}=fixture();const child=new EventEmitter();child.kill=()=>true;const reaped=assert.rejects(manager.reap({process:child}),/未确认退出/);t.mock.timers.tick(1500);t.mock.timers.tick(500);t.mock.timers.tick(2000);await reaped;
});
test('FAKE: service close marks worlds synchronously, starts both closes, closes store after both',async()=>{
  const source=readFileSync(new URL('../../services/creation/service.mjs',import.meta.url),'utf8');const method=source.slice(source.lastIndexOf('\n  close(){')+3,source.lastIndexOf('\n}')).trim();const target=Function(`return ({${method}})`)(),a=deferred(),b=deferred(),order=[];
  Object.assign(target,{worlds:{beginClose(){order.push('mark');},close(){order.push('world-close');return a.promise;}},agent:{close(){order.push('agent-close');return b.promise;}},realtime:{close(){order.push('realtime-close');}},store:{close(){order.push('store-close');}}});
  const result=target.close();assert.deepEqual(order,['mark','realtime-close','world-close','agent-close']);assert.equal(target.close(),result);a.resolve();await Promise.resolve();assert.equal(order.includes('store-close'),false);b.resolve();await result;assert.equal(order.at(-1),'store-close');
});
test('FAKE: known process kill signals are infrastructure even if child close precedes websocket close',()=>{
  for(const signal of ['SIGINT','SIGTERM','SIGKILL']){const{manager,records}=fixture();const world=fakeWorld();manager.worlds.set(key,world);manager.processFailed(world,null,signal);manager.failed(world,Error('Godot 权威连接中断'),{kind:'infrastructure'});const failure=records.get('creator_world/world').failure;assert.equal(failure.kind,'infrastructure');assert.deepEqual(failure.process_exit,{code:null,signal});assert.equal(manager.store.list('creator_world_failure').length,1);}
  const{manager,records}=fixture();manager.processFailed(fakeWorld(),2,null);assert.equal(records.get('creator_world/world').failure.kind,'unknown');
});
test('FAKE: final shutdown ACK checkpoint survives a concurrent websocket close callback',async()=>{
  const{manager,records}=fixture(null),world=fakeWorld();manager.worlds.set(key,world);manager.command=async()=>{manager.failed(world,Error('Godot 权威连接中断'),{kind:'infrastructure'});return{ok:true,snapshot:{...world.snapshot,sequence:105}};};
  await manager.close();const saved=records.get('creator_world/world');assert.equal(saved.snapshot.sequence,105);assert.equal(saved.failure,undefined);assert.equal(manager.store.list('creator_world_failure').length,0);
});

test('FAKE: only marked startup preconditions receive retry classification, arbitrary worker statuses do not',()=>{
  for(const marked of [false,true]){const{manager,records}=fixture();manager.failed(fakeWorld({activated:false}),Object.assign(Error('denied'),{status:403,...(marked?{world_start_precondition:true}:{})}));assert.equal(records.get('creator_world/world').failure.kind,marked?'precondition':'unknown');}
});
