// Actual SQLite store and realtime handlers; synthetic source indexes and socket
// transport. No listening service, native engine, Agent or formal data is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationRealtime} from '../../services/creation/realtime.mjs';
import {NATIVE_SCHEMA} from '../../services/creation/native-source.mjs';
import {nativeObjects} from '../../services/creation/native-reference.mjs';
import {HIERARCHY_SCHEMA,emptyDocument,prepareManifest} from '../../services/creation/hierarchy.mjs';
import {identityTransform} from '../../packages/scene/transform.mjs';
import {LocalSelectionOrder,previewPeers} from '../../apps/creation-workspace/collaboration-client.js';

class FakeSocket extends EventEmitter {
  constructor(){super();this.readyState=1;this.packets=[];}
  send(bytes){this.packets.push(JSON.parse(bytes));}
  receive(packet){this.emit('message',Buffer.from(JSON.stringify(packet)));}
  close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
}
function fixture(t,schema=NATIVE_SCHEMA,count=3){
  const data=mkdtempSync(join(tmpdir(),'atelier-multi-selection-')),store=new CreationStore(join(data,'creation.sqlite'));
  store.publicPlay=false;
  const users=['a','b'].map((name,index)=>({id:`00000000-0000-4000-8000-00000000000${index}`,name}));
  users.forEach(user=>store.put('creator_user',user));
  const project=store.createProject(users[0],{name:'Isolated multi-selection'},{entry_scene_id:'room',resources:{room:{id:'room',kind:'scene',name:'Room',objects:[]}}}).project.id;
  store.setMember(users[0],project,users[1].id,'editor');
  const scope={project_id:project,branch_id:'main',resource_id:'room'};
  let manifest;
  if(schema===NATIVE_SCHEMA){
    const nodes=Array.from({length:count},(_,i)=>({addressable:true,node_id:'door',instance_ids:[`house-${i}`],path:`House${i}`,type:'Node',name:`Door ${i}`,metadata:{},properties:[],version:`node-${i}`,key:`key-${i}`}));
    manifest={schema,source_identity:'source-1',index_source_identity:'source-1',entry_scene_id:'room',resources:{room:{id:'room',kind:'scene',name:'Room',path:'room.tscn',version:'room-1',native_nodes:nodes},second:{id:'second',kind:'scene',name:'Second',path:'second.tscn',version:'second-1',native_nodes:[]}}};
  }else if(schema===HIERARCHY_SCHEMA){
    const room=emptyDocument('room'),house=emptyDocument('house','prefab');
    house.nodes.door={id:'door',name:'Door',parent_id:'root',kind:'anchor',color:'#74d5cd',solid:false,components:{},transform:identityTransform()};
    manifest=prepareManifest({schema,entry_scene_id:'room',resources:{room,house,second:emptyDocument('second')},prefab_revisions:{}},()=>true);
    for(let i=0;i<count;i++)manifest.resources.room.instances[`house-${i}`]={instance_id:`house-${i}`,prefab_id:'house',prefab_revision:manifest.resources.house.version,parent_id:'root',transform:identityTransform(),overrides:[]};
    manifest=prepareManifest(manifest,()=>true);
  }else{
    manifest={schema,entry_scene_id:'room',resources:{room:{id:'room',kind:'scene',name:'Room',objects:Array.from({length:count},(_,i)=>({id:`door-${i}`,version:`node-${i}`}))},second:{id:'second',kind:'scene',name:'Second',objects:[]}}};
  }
  const revision=store.writeRevision(project,[],manifest,users[0].id);
  store.put('creator_branch',{...store.get('creator_branch',`${project}:main`),head:revision.id});
  const realtime=new CreationRealtime({server:new EventEmitter(),store}),sockets=users.map(user=>{
    const ws=new FakeSocket();realtime.connect(ws,'http://fake.invalid');
    ws.receive({type:'auth',token:store.issueLogin(user).token});ws.receive({type:'subscribe',...scope,generation:1});return ws;
  });
  t.after(()=>{realtime.close();store.close();rmSync(data,{recursive:true,force:true});});
  const branch=()=>store.branchView(users[0],project,'main');
  const address=index=>({...scope,instance_path:schema==='creation-flat-1'?[]:[`house-${index}`],definition_node_id:schema==='creation-flat-1'?`door-${index}`:'door'});
  const object=index=>{const row=realtime.resolveTarget(scope,branch(),address(index));return {id:row.id,address:row.address};};
  const peer=index=>[...realtime.connections.values()].find(client=>client.ws===sockets[index]);
  const peers=()=>sockets[1].packets.findLast(packet=>packet.type==='presence').peers;
  const send=(fields={},index=0)=>sockets[index].receive({type:'presence',generation:1,mode:'editing',source_revision:branch().head,...(schema===NATIVE_SCHEMA?{source_identity:branch().manifest.source_identity}:{}),...fields});
  const commit=edit=>{
    const previous=branch(),next=structuredClone(previous.manifest);edit(next);
    const revision=store.writeRevision(project,[previous.head],next,users[0].id);
    store.put('creator_branch',{...store.get('creator_branch',`${project}:main`),head:revision.id});
    realtime.committed(project,'main',{branch:branch()});return branch();
  };
  return {store,realtime,sockets,scope,branch,address,object,peer,peers,send,commit};
}

for(const schema of [NATIVE_SCHEMA,HIERARCHY_SCHEMA,'creation-flat-1']){
  test(`${schema}: whole selection, exact addresses, legacy primary and preview projection`,t=>{
    const f=fixture(t,schema),a=f.object(0),b=f.object(1);
    f.send({selected_id:b.id,selected_address:b.address,selected_objects:[a,b]});
    const remote=f.peers().find(p=>p.peer_id===f.peer(0).id);
    assert.deepEqual(remote.selected_objects,[a,b]);assert.equal(remote.selected_id,b.id);assert.deepEqual(remote.selected_address,b.address);
    assert.equal(remote.selected_source_revision,f.branch().head);
    const projected=previewPeers(f.peers(),f.peer(1).id);assert.deepEqual(projected[0].selected_objects,[a,b]);
    projected[0].selected_objects[0].address.instance_path.push('mutated');assert.deepEqual(remote.selected_objects,[a,b]);
    f.send({selected_id:a.id});assert.deepEqual(f.peer(0).selected_objects,[a],'legacy id-only packet replaces the entire selection');
    f.send({selected_address:b.address});assert.deepEqual(f.peer(0).selected_objects,[b],'legacy address-only packet resolves its canonical id');
    f.send({selected_objects:[a,b,a]});assert.deepEqual(f.peer(0).selected_objects,[a,b]);assert.equal(f.peer(0).selected_id,a.id,'first object supplies omitted primary');
    f.send({selected_objects:[{id:b.id},{id:a.id}]});assert.deepEqual(f.peer(0).selected_objects,[b,a],'optional addresses are resolved against the fixed scope');
  });

  test(`${schema}: rejects any invalid member atomically, including secondary scope and id mismatches`,t=>{
    const f=fixture(t,schema),a=f.object(0),b=f.object(1),camera={position:[0,1,2],target:[0,0,0]};
    f.send({selected_objects:[a,b],selection_intent:7,camera});
    const invalids=[
      {selected_objects:null},{selected_objects:{}},{selected_objects:[a,null]},{selected_objects:[a,[]]},
      {selected_objects:[a,{address:b.address}]},{selected_objects:[a,{id:3}]},{selected_objects:[a,{id:''}]},
      {selected_objects:[a,{id:'x'.repeat(1025)}]},{selected_objects:[a,{id:'bad\u0000id'}]},
      {selected_objects:[a,{id:'missing'}]},{selected_objects:[a,{id:a.id,address:b.address}]},
      ...['project_id','branch_id','resource_id'].map(key=>({selected_objects:[a,{...b,address:{...b.address,[key]:'outside'}}]})),
      ...[false,[],{...b.address,instance_path:null},{...b.address,instance_path:Array(129).fill('x')},{...b.address,instance_path:[3]},{...b.address,definition_node_id:''}].map(address=>({selected_objects:[a,{...b,address}]})),
      {selected_id:b.id,selected_objects:[a]},{selected_id:a.id,selected_address:b.address,selected_objects:[a,b]},
    ];
    for(const fields of invalids){
      const packets=f.sockets[1].packets.length;
      f.send({...fields,selection_intent:99,camera:{position:[9,9,9],target:[0,0,0]}});
      assert.equal(f.sockets[0].packets.at(-1).type,'error',JSON.stringify(fields));
      assert.deepEqual(f.peer(0).selected_objects,[a,b]);assert.equal(f.peer(0).selection_intent,7);assert.deepEqual(f.peer(0).camera,camera);
      assert.equal(f.sockets[1].packets.length,packets,'rejected packet has no partial broadcast');
    }
  });

  test(`${schema}: secondary-only changes bypass camera throttle and explicit [] wins over stale primary`,t=>{
    const f=fixture(t,schema),a=f.object(0),b=f.object(1),c=f.object(2);
    f.send({selected_id:a.id,selected_objects:[a,b]});
    f.send({selected_id:a.id,selected_objects:[a,c]});assert.deepEqual(f.peer(0).selected_objects,[a,c]);
    f.send({selected_id:'deleted',selected_address:{resource_id:'old'},selected_objects:[],source_revision:'stale',source_identity:'stale'});
    assert.deepEqual(f.peer(0).selected_objects,[]);assert.equal(f.peer(0).selected_id,null);assert.equal(f.peer(0).selected_address,null);
    assert.equal(f.peer(0).selected_source_revision,null);assert.equal(f.peer(0).selected_source_identity,null);
    f.send({selected_objects:[a,b]});f.send({mode:'playing',selected_objects:[]});assert.equal(f.peer(0).mode,'playing');assert.deepEqual(f.peer(0).selected_objects,[]);
  });

  test(`${schema}: commit re-resolves all addresses, promotes surviving primary and clears removed resources`,t=>{
    const f=fixture(t,schema),a=f.object(0),b=f.object(1),c=f.object(2);
    f.send({selected_id:b.id,selected_objects:[a,b,c]});
    const next=f.commit(manifest=>{
      if(schema===NATIVE_SCHEMA){manifest.source_identity=manifest.index_source_identity='source-2';manifest.resources.room.native_nodes.splice(1,1);}
      else if(schema===HIERARCHY_SCHEMA)delete manifest.resources.room.instances['house-1'];
      else manifest.resources.room.objects.splice(1,1);
    });
    assert.deepEqual(f.peer(0).selected_objects,[a,c]);assert.equal(f.peer(0).selected_id,a.id);assert.equal(f.peer(0).selected_source_revision,next.head);
    assert.equal(f.peer(0).selected_source_identity,schema===NATIVE_SCHEMA?'source-2':null);
    assert.deepEqual(f.peers().find(p=>p.peer_id===f.peer(0).id).selected_objects,[a,c]);
    f.commit(manifest=>delete manifest.resources.room);
    assert.deepEqual(f.peer(0).selected_objects,[]);assert.equal(f.peer(0).selected_id,null);assert.equal(f.peer(0).selected_source_revision,null);
  });
}

test('native: accepts exactly 128 objects and rejects 129 before deduplication',t=>{
  const f=fixture(t,NATIVE_SCHEMA,128),objects=Array.from({length:128},(_,i)=>f.object(i));
  f.send({selected_objects:objects});assert.deepEqual(f.peer(0).selected_objects,objects);
  f.send({selected_objects:[...objects,objects[0]]});assert.equal(f.sockets[0].packets.at(-1).status,422);assert.deepEqual(f.peer(0).selected_objects,objects);
});

test('native: full selection requires current revision and rejects a mismatched supplied source identity',t=>{
  const f=fixture(t),a=f.object(0),b=f.object(1);f.send({selected_objects:[a],selection_intent:1});
  for(const fields of [{source_revision:undefined},{source_revision:'stale'},{source_identity:'stale'},{source_identity:3}]){
    f.send({selected_objects:[a,b],selection_intent:2,...fields});assert.equal(f.sockets[0].packets.at(-1).status,409);assert.deepEqual(f.peer(0).selected_objects,[a]);assert.equal(f.peer(0).selection_intent,1);
  }
  // Preserve the existing old-client contract: identity is optional, revision is not.
  f.send({selected_id:b.id,source_identity:undefined});assert.deepEqual(f.peer(0).selected_objects,[b]);
});

test('native: stale index invalidates the whole selection and old packets cannot restore deleted objects',t=>{
  const f=fixture(t),objects=[f.object(0),f.object(1)],head=f.branch().head;
  f.send({selected_objects:objects});
  f.commit(manifest=>{manifest.source_identity='source-2';});
  assert.deepEqual(f.peer(0).selected_objects,[]);
  f.send({selected_objects:objects,source_revision:head,source_identity:'source-1'});assert.equal(f.sockets[0].packets.at(-1).status,409);
  f.send({selected_objects:objects});assert.equal(f.sockets[0].packets.at(-1).status,409);assert.deepEqual(f.peer(0).selected_objects,[]);
});

test('native: commit follows full addresses through display ID changes without rebinding by old ID',t=>{
  const f=fixture(t);
  f.commit(manifest=>{for(const [i,node]of manifest.resources.room.native_nodes.entries())node.metadata={wa_legacy_flat_instance:true,wa_legacy_object_id:`legacy-${i}`};});
  const a=f.object(0),b=f.object(1);f.send({selected_objects:[a,b],selected_id:b.id});
  f.commit(manifest=>{manifest.resources.room.native_nodes[0].metadata.wa_legacy_object_id=b.id;manifest.resources.room.native_nodes[1].metadata.wa_legacy_object_id=a.id;});
  assert.deepEqual(f.peer(0).selected_objects,[f.object(0),f.object(1)]);assert.deepEqual(f.peer(0).selected_address,b.address);assert.equal(f.peer(0).selected_id,a.id);
});

test('native: 128-deep stable instance paths retain native address rules',t=>{
  const f=fixture(t);
  f.commit(manifest=>{manifest.resources.room.native_nodes[0].instance_ids=Array.from({length:128},(_,i)=>`原生实例 ${i}`);});
  const row=nativeObjects(f.branch().manifest,f.scope)[0],object={id:row.id,address:row.address};
  f.send({selected_objects:[object]});assert.deepEqual(f.peer(0).selected_objects,[object]);
  f.commit(manifest=>{manifest.source_identity=manifest.index_source_identity='source-2';});assert.deepEqual(f.peer(0).selected_objects,[object]);
});

test('subscription, generation, disconnect and heartbeat boundaries remove the full selection',t=>{
  const f=fixture(t),objects=[f.object(0),f.object(1)];f.send({selected_objects:objects});
  f.sockets[0].receive({type:'subscribe',...f.scope,generation:2});assert.deepEqual(f.peer(0).selected_objects,[]);assert.equal(f.peer(0).selection_intent,0);
  f.send({selected_objects:objects});assert.equal(f.sockets[0].packets.at(-1).status,409);
  f.send({selected_objects:objects,generation:2});assert.deepEqual(f.peer(0).selected_objects,objects);
  f.sockets[0].receive({type:'subscribe',...f.scope,resource_id:'second',generation:3});assert.deepEqual(f.peer(0).selected_objects,[]);assert.equal(f.peers().length,1);
  f.sockets[0].receive({type:'unsubscribe'});assert.equal(f.peer(0).scope,null);
  f.sockets[0].receive({type:'subscribe',...f.scope,generation:4});assert.deepEqual(f.peer(0).selected_objects,[]);
  f.send({selected_objects:objects,generation:4});f.sockets[0].close();assert.equal(f.peers().length,1);
  f.send({selected_objects:objects},1);f.peer(1).last_seen=Date.now()-36000;f.realtime.sweep();assert.equal(f.realtime.connections.size,0);
});

test('branch changes reset all selected objects and never broadcast them to another branch',t=>{
  const f=fixture(t),objects=[f.object(0),f.object(1)];
  f.store.fork(f.peer(0).user,f.scope.project_id,{from_branch:'main',expected_head:f.branch().head,branch_id:'other',name:'Other'});
  f.send({selected_objects:objects});
  f.sockets[0].receive({type:'subscribe',...f.scope,branch_id:'other',generation:2});
  assert.deepEqual(f.peer(0).selected_objects,[]);assert.equal(f.peers().length,1);
  f.send({generation:2,selected_objects:objects});assert.equal(f.sockets[0].packets.at(-1).status,409);
  const other=objects.map(object=>({...object,address:{...object.address,branch_id:'other'}}));
  f.send({generation:2,selected_objects:other});assert.deepEqual(f.peer(0).selected_objects,other);
  assert.equal(f.peers().length,1);assert.deepEqual(f.peers()[0].selected_objects,[]);
  f.commit(manifest=>{manifest.resources.room.native_nodes=[];});assert.deepEqual(f.peer(0).selected_objects,other,'main commit cannot re-resolve another branch');
});

test('secondary deletion keeps surviving primary, and camera broadcasts never take its local order',t=>{
  const f=fixture(t),objects=[f.object(0),f.object(1),f.object(2)],tracker=new LocalSelectionOrder();
  f.send({selected_objects:objects,selected_id:objects[2].id});
  f.commit(manifest=>{manifest.resources.room.native_nodes.splice(1,1);});
  assert.deepEqual(f.peer(0).selected_objects,[objects[0],objects[2]]);assert.equal(f.peer(0).selected_id,objects[2].id);
  const order=tracker.update(f.peers()).find(peer=>peer.peer_id===f.peer(0).id).selection_order;
  f.peer(0).last_presence=0;
  f.send({selected_objects:[objects[0],objects[2]],selected_id:objects[2].id,camera:{position:[3,4,5],target:[0,0,0]}});
  const projected=tracker.update(f.peers()).find(peer=>peer.peer_id===f.peer(0).id);
  assert.equal(projected.selection_order,order);assert.deepEqual(projected.camera.position,[3,4,5]);
});

test('whole-selection fingerprints rank secondary changes, keep camera updates stable and respect []',()=>{
  const tracker=new LocalSelectionOrder(),a={id:'a',address:{resource_id:'room',instance_path:['one'],definition_node_id:'door'}},b={id:'b',address:{resource_id:'room',instance_path:['two'],definition_node_id:'door'}};
  const peer={peer_id:'one',selected_id:a.id,selected_address:a.address,selected_objects:[a],selection_intent:1,mode:'editing'};
  let rank=tracker.update([peer])[0].selection_order;assert.ok(rank>0);
  const group={...peer,selected_objects:[a,b]};let next=tracker.update([group])[0].selection_order;assert.ok(next>rank);rank=next;
  next=tracker.update([{...group,camera:{position:[1,2,3]},last_seen:999,selected_source_revision:'next'}])[0].selection_order;assert.equal(next,rank);
  const addressChange={...group,selected_objects:[a,{...b,address:{...b.address,instance_path:['other']}}]};
  next=tracker.update([addressChange])[0].selection_order;assert.ok(next>rank);rank=next;
  next=tracker.update([{...addressChange,selection_intent:2}])[0].selection_order;assert.ok(next>rank);
  assert.equal(tracker.update([{...group,selected_objects:[]}])[0].selection_order,0);
  assert.ok(tracker.update([{...group,selected_id:null,selected_address:null}])[0].selection_order>0);
  assert.equal(tracker.update([{...group,mode:'playing'}])[0].selection_order,0);
  assert.ok(tracker.update([{...peer,selected_objects:undefined}])[0].selection_order>0);
  tracker.update([]);assert.equal(tracker.ranks.size,0);assert.equal(tracker.fingerprints.size,0);
});
