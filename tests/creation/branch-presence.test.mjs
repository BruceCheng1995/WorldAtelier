import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationRealtime} from '../../services/creation/realtime.mjs';

// Real temporary SQLite and real subscription handlers; in-memory sockets only.
class Socket extends EventEmitter {
  constructor(){super();this.readyState=1;this.packets=[];}
  send(bytes){this.packets.push(JSON.parse(bytes));}
  receive(packet){this.emit('message',Buffer.from(JSON.stringify(packet)));}
  close(code){if(this.readyState===3)return;this.code=code;this.readyState=3;this.emit('close');}
  latest(type='branch_presence'){return this.packets.findLast(p=>p.type===type);}
}
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'wa-branch-presence-')),store=new CreationStore(join(directory,'creation.sqlite'));
  const users=['owner','editor','third','foreign'].map(id=>({id,name:id}));for(const user of users)store.put('creator_user',user);
  const manifest={entry_scene_id:'a',resources:Object.fromEntries(['a','b'].map(id=>[id,{id,name:id,kind:'scene',objects:[]}]))};
  const project=store.createProject(users[0],{name:'Presence'},manifest).project.id;
  for(const user of users.slice(1))store.setMember(users[0],project,user.id,'editor');
  store.fork(users[0],project,{from_branch:'main',branch_id:'side'});
  const other=store.createProject(users[3],{name:'Other'},manifest).project.id;
  const realtime=new CreationRealtime({server:new EventEmitter(),store}),sockets=[];
  const connect=(user,resource_id='a',branch_id='main',project_id=project)=>{
    const ws=new Socket();sockets.push(ws);realtime.connect(ws,'http://isolated.invalid');ws.receive({type:'auth',token:store.issueLogin(user).token});
    ws.subscribe=(resource=resource_id,branch=branch_id,generation=1,p=project_id)=>ws.receive({type:'subscribe',project_id:p,branch_id:branch,resource_id:resource,generation});ws.subscribe();
    assert.equal(ws.latest('error'),undefined);return ws;
  };
  t.after(()=>{realtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,users,project,other,realtime,connect};
}
const ids=ws=>ws.latest().peers.map(p=>p.id).sort();

test('branch identities cross scenes, isolate branches/projects, deduplicate windows and omit scene details',t=>{
  const f=fixture(t),a=f.connect(f.users[0]),b=f.connect(f.users[1],'b');
  const second=f.connect(f.users[1],'a'),side=f.connect(f.users[2],'a','side'),other=f.connect(f.users[3],'a','main',f.other);
  assert.deepEqual(ids(a),['editor','owner']);assert.deepEqual(ids(b),ids(a));assert.deepEqual(ids(side),['third']);assert.deepEqual(ids(other),['foreign']);
  assert.deepEqual(a.latest().peers.map(p=>Object.keys(p).sort()),[['id','name'],['id','name']]);
  assert.equal(a.latest().resource_id,'a');assert.equal(b.latest().resource_id,'b');
  assert.deepEqual(b.latest('presence').peers.map(p=>p.id),['editor'],'scene presence remains isolated');
  const packets=a.packets.filter(p=>p.type==='branch_presence').length;
  f.realtime.presence({project_id:f.project,branch_id:'main',resource_id:'b'});
  assert.equal(a.packets.filter(p=>p.type==='branch_presence').length,packets,'unchanged identity projection is not broadcast again');
  second.close();assert.deepEqual(ids(a),['editor','owner'],'one remaining window keeps user online');
  b.receive({type:'unsubscribe'});assert.deepEqual(ids(a),['owner']);
});

test('resubscription sends receiver generation and moves identity between branches; stale subscriptions fail',t=>{
  const f=fixture(t),a=f.connect(f.users[0]),b=f.connect(f.users[1],'b'),side=f.connect(f.users[2],'a','side');
  b.subscribe('a','main',2);assert.equal(b.latest().generation,2);assert.equal(b.latest().resource_id,'a');
  b.subscribe('b','side',3);assert.deepEqual(ids(a),['owner']);assert.deepEqual(ids(side),['editor','third']);
  assert.equal(b.latest().generation,3);assert.equal(b.latest().branch_id,'side');assert.equal(b.latest().resource_id,'b');
  const before=b.latest();b.subscribe('a','main',2);assert.equal(b.latest('error').status,409);assert.deepEqual(b.latest(),before);assert.deepEqual(ids(a),['owner']);
  b.close();assert.deepEqual(ids(side),['third']);
});

test('membership revocation removes all user windows and never exposes revoked identity to remaining peers',t=>{
  const f=fixture(t),a=f.connect(f.users[0]),b=f.connect(f.users[1],'b'),second=f.connect(f.users[1]);
  f.store.setMember(f.users[0],f.project,f.users[1].id,null);f.realtime.permissionsChanged(f.project);
  assert.equal(b.readyState,3);assert.equal(second.readyState,3);assert.equal(b.code,1008);assert.deepEqual(ids(a),['owner']);
});
