// Independent actual SQLite/domain/realtime checks with explicitly FAKE socket transport.
// No listening service, browser, Agent, or production source document is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import vm from 'node:vm';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationRealtime} from '../../services/creation/realtime.mjs';
import {HIERARCHY_SCHEMA,emptyDocument,prepareManifest} from '../../services/creation/hierarchy.mjs';
import {identityTransform} from '../../packages/scene/transform.mjs';
import {previewPeers,userColor,LocalSelectionOrder} from '../../apps/creation-workspace/collaboration-client.js';
import {nextSemanticSelection} from '../../apps/creation-workspace/semantic-workspace-context.js';

class FakeSocket extends EventEmitter {
  constructor(){super();this.readyState=1;this.packets=[];}
  send(bytes){this.packets.push(JSON.parse(bytes));}
  receive(packet){this.emit('message',Buffer.from(JSON.stringify(packet)));}
  close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
}
function fixture(t){
  const data=mkdtempSync(resolve(tmpdir(),'atelier-remote-selection-')),store=new CreationStore(resolve(data,'creation.sqlite'));
  store.publicPlay=false;
  const users=['owner','other','third'].map((id,i)=>({id:`00000000-0000-4000-8000-00000000000${i}`,name:`FAKE ${id}`,color:'#ffffff'}));
  users.forEach(user=>store.put('creator_user',user));
  const scene=emptyDocument('room'),second=emptyDocument('second'),prefab=emptyDocument('house','prefab');
  prefab.nodes.door={id:'door',name:'door',parent_id:'root',kind:'anchor',color:'#74d5cd',solid:false,components:{},transform:identityTransform()};
  let manifest=prepareManifest({schema:HIERARCHY_SCHEMA,entry_scene_id:'room',resources:{room:scene,second,house:prefab},prefab_revisions:{}},()=>true);
  for(const id of ['a','b'])manifest.resources.room.instances[id]={instance_id:id,prefab_id:'house',prefab_revision:manifest.resources.house.version,parent_id:'root',transform:identityTransform(),overrides:[]};
  manifest=prepareManifest(manifest,()=>true);
  const project=store.createProject(users[0],{name:'Independent remote selection'},{entry_scene_id:'room',resources:{room:{id:'room',kind:'scene',name:'Room',objects:[]}}}).project.id;
  const revision=store.writeRevision(project,[],manifest,users[0].id);
  store.put('creator_branch',{...store.get('creator_branch',`${project}:main`),head:revision.id});
  for(const user of users.slice(1))store.setMember(users[0],project,user.id,'editor');
  const main=store.branchView(users[0],project,'main');
  store.fork(users[0],project,{from_branch:'main',expected_head:main.head,branch_id:'other',name:'Other'});
  const realtime=new CreationRealtime({server:new EventEmitter(),store}),sockets=users.map(user=>{
    const ws=new FakeSocket();realtime.connect(ws,'http://fake.invalid');ws.receive({type:'auth',token:store.issueLogin(user).token});
    ws.receive({type:'subscribe',project_id:project,branch_id:'main',resource_id:'room',generation:1});return ws;
  });
  t.after(()=>{realtime.close();store.close();rmSync(data,{recursive:true,force:true});});
  const address=(path=['a'],extra={})=>({project_id:project,branch_id:'main',resource_id:'room',instance_path:path,definition_node_id:'door',...extra});
  const send=(index,fields={})=>sockets[index].receive({type:'presence',generation:1,mode:'editing',selected_address:address(),...fields});
  const peers=(index=0)=>sockets[index].packets.findLast(packet=>packet.type==='presence').peers;
  const peer=index=>[...realtime.connections.values()].find(client=>client.ws===sockets[index]);
  return {store,realtime,project,users,sockets,address,send,peers,peer};
}

test('remote selection broadcasts exact hierarchy instance and multiple editors on one object',t=>{
  const f=fixture(t);f.send(1);f.send(2);
  const selected=f.peers().filter(peer=>peer.selected_address);
  assert.equal(selected.length,2);assert.deepEqual(selected.map(peer=>peer.selected_address),[f.address(),f.address()]);
  assert.equal(selected[0].selected_id,selected[1].selected_id);
  f.send(1,{selected_address:f.address(['b'])});
  assert.notEqual(f.peer(1).selected_id,f.peer(2).selected_id,'identical definition node in another instance must have another runtime id');
  assert.deepEqual(f.peer(1).selected_address,f.address(['b']));
});

test('rapid selection, deselection and Play transitions never lose the final selection state',t=>{
  const f=fixture(t);f.send(1);assert.ok(f.peer(1).selected_id);
  f.send(1,{selected_address:null,selected_id:null});assert.equal(f.peer(1).selected_id,null,'immediate clear is semantic state, not droppable camera traffic');
  f.send(1);f.send(1,{mode:'playing',selected_address:null,selected_id:null});
  assert.equal(f.peer(1).mode,'playing');assert.equal(f.peer(1).selected_id,null);
  f.send(1,{mode:'inspecting',selected_address:null,selected_id:null});assert.equal(f.peer(1).mode,'inspecting');
  f.send(1);assert.equal(f.peer(1).mode,'editing');assert.deepEqual(f.peer(1).selected_address,f.address());
});

test('document, branch, generation, disconnect and heartbeat boundaries remove remote selections',t=>{
  const f=fixture(t);f.send(1);
  const subscribe=(branch,resource,generation)=>f.sockets[1].receive({type:'subscribe',project_id:f.project,branch_id:branch,resource_id:resource,generation});
  subscribe('main','second',2);assert.equal(f.peers().some(peer=>peer.peer_id===f.peer(1).id),false);assert.equal(f.peer(1).selected_id,null);
  f.sockets[1].receive({type:'presence',generation:1,selected_address:f.address(),mode:'editing'});
  assert.equal(f.sockets[1].packets.at(-1).status,409);assert.equal(f.peer(1).selected_id,null);
  subscribe('other','room',3);assert.equal(f.peers().some(peer=>peer.peer_id===f.peer(1).id),false);
  subscribe('main','room',4);assert.equal(f.peer(1).selected_id,null);
  f.sockets[1].close();assert.equal(f.peers().some(peer=>peer.id===f.users[1].id),false);
  f.send(2);f.peer(2).last_seen=Date.now()-36000;f.realtime.sweep();assert.equal(f.peers().some(peer=>peer.id===f.users[2].id),false);
});

test('wrong-scope address is rejected and identity colors ignore peer id and supplied color',t=>{
  const f=fixture(t);f.send(1,{selected_address:f.address(['a'],{branch_id:'other'})});
  assert.equal(f.sockets[1].packets.at(-1).status,409);assert.equal(f.peer(1).selected_id,null);
  f.send(2);const outgoing=previewPeers(f.peers(),f.peer(0).id);
  assert.equal(outgoing.some(peer=>peer.id===f.peer(0).id),false);
  const target=outgoing.find(peer=>peer.user_id===f.users[2].id);
  assert.equal(target.color,userColor(f.users[2]));assert.notEqual(target.color,'#ffffff');
  assert.equal(userColor({...target,id:'another-window',color:'#000000'}),target.color);
});

test('same-document resubscription republishes identical selected address without a camera event',t=>{
  const f=fixture(t);f.send(1);assert.ok(f.peer(1).selected_id);
  f.sockets[1].receive({type:'subscribe',project_id:f.project,branch_id:'main',resource_id:'room',generation:2});
  assert.equal(f.peer(1).selected_id,null);
  f.send(1,{generation:2});assert.deepEqual(f.peer(1).selected_address,f.address());
});

test('server only relays client intent; each browser ranks observed selection changes locally',t=>{
  const f=fixture(t),tracker=new LocalSelectionOrder();
  const observe=()=>tracker.update(f.peers()),winner=rows=>rows.filter(peer=>peer.selected_id&&peer.mode==='editing').sort((a,b)=>b.selection_order-a.selection_order)[0]?.id;
  f.send(1,{selection_intent:400});let rows=observe();const aOrder=rows.find(peer=>peer.id===f.users[1].id).selection_order;
  f.send(2,{selection_intent:42});rows=observe();assert.equal(winner(rows),f.users[2].id,'local arrival order wins, not token numeric magnitude');
  assert.equal('selectionOrder' in f.realtime,false);assert.ok(f.peers().every(peer=>!('selection_order' in peer)));
  assert.equal(f.peers().find(peer=>peer.id===f.users[1].id).selection_intent,400);assert.equal(f.peers().find(peer=>peer.id===f.users[2].id).selection_intent,42);
  f.peer(1).last_presence=0;f.send(1,{selection_intent:400,camera:{position:[0,0,4],target:[0,0,0]},selection_order:Number.MAX_SAFE_INTEGER});
  rows=observe();assert.equal(rows.find(peer=>peer.id===f.users[1].id).selection_order,aOrder);assert.equal(winner(rows),f.users[2].id);assert.ok(f.peers().every(peer=>!('selection_order' in peer)));
  f.send(2,{selected_address:null,selected_id:null,selection_intent:43});assert.equal(winner(observe()),f.users[1].id,'B clear restores still-selected A locally');
  f.send(2,{selection_intent:44});assert.equal(winner(observe()),f.users[2].id);
  f.send(1,{selection_intent:401});assert.equal(winner(observe()),f.users[1].id,'same-object reclick changes local observed fingerprint');
});

test('invalid address cannot update relay intent and another branch does not leak selections',t=>{
  const f=fixture(t);f.send(1,{selection_intent:5});const selected=f.peer(1).selected_id;
  f.send(1,{selection_intent:6,selected_address:f.address(['a'],{branch_id:'other'})});
  assert.equal(f.sockets[1].packets.at(-1).status,409);assert.equal(f.peer(1).selection_intent,5);assert.equal(f.peer(1).selected_id,selected);
  f.sockets[2].receive({type:'subscribe',project_id:f.project,branch_id:'other',resource_id:'room',generation:2});
  f.send(2,{generation:2,selected_address:f.address(['a'],{branch_id:'other'})});
  assert.equal('selection_order' in f.peer(2),false);assert.equal(f.peers(0).some(peer=>peer.id===f.users[2].id),false);
  assert.equal(f.peers(2).some(peer=>peer.id===f.users[1].id),false);
});

function clientPresenceFixture(){
  const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
  const start=source.indexOf('function clearPresence()'),end=source.indexOf('function renderInspectionUi()',start);
  assert.ok(start>=0&&end>start,'presence extraction ends at renderInspectionUi after clearPresence');
  const functions=source.slice(start,end);
  assert.ok(functions.includes('function sendPresence('));
  const selectionStart=source.indexOf('function selectedSemanticObjects()'),selectionEnd=source.indexOf('export function orderExplorerRows(',selectionStart);
  const selectStart=source.indexOf('function selectObject('),selectEnd=source.indexOf('function disposeHierarchyPanel()',selectStart);
  assert.ok(selectionStart>=0&&selectionEnd>selectionStart&&selectStart>=0&&selectEnd>selectStart,'extract complete actual multi-selection functions');
  const queue=new Map(),sent=[],overlay=[],inspector={scrollTop:0};let serial=0;
  const state={branch:{branch_id:'main',head:'v1'},project:{id:'project'},resourceId:'room',mode:'edit',selectedId:'a',selectionIntent:0,selectionOrderTracker:new LocalSelectionOrder(),presenceTimer:null,presenceCamera:null,lastPresence:0,peers:[],modeLong:{edit:'editing',play:'playing',inspect:'inspecting'},
    Date:{now:()=>1000},setTimeout:fn=>{queue.set(++serial,fn);return serial;},clearTimeout:id=>queue.delete(id),
    semanticSelection:{key:null,ids:[],primary:null,anchor:null},nextSemanticSelection,inspectorTab:'object',isNative:()=>false,
    localEdit:null,invalidateMainCamera(){},renderExplorer(){},renderStage(){},renderInspector(){},report(){},
    $:selector=>{assert.equal(selector,'.inspector','only the inspector scroll boundary is faked');return inspector;},
    mainPreview:{presence:packet=>overlay.push(packet),select(){}},api:{ready:true,scope:{project_id:'project',branch_id:'main',resource_id:'room'},scoped:(type,packet)=>sent.push(JSON.parse(JSON.stringify({type,...packet})))}};
  state.key=()=>`${state.project?.id}/${state.branch?.branch_id}/${state.resourceId}`;
  state.viewedDocumentKey=state.key;
  state.docObjects=()=>['a','b','c','d'].map(id=>({id,address:{project_id:state.project.id,branch_id:state.branch.branch_id,resource_id:state.resourceId,instance_path:[],definition_node_id:id}}));
  state.object=()=>state.docObjects().find(object=>object.id===state.selectedId)??null;
  vm.runInNewContext(functions,state);
  vm.runInNewContext(source.slice(selectionStart,selectionEnd),state);
  vm.runInNewContext(source.slice(selectStart,selectEnd),state);
  const flush=()=>{const tasks=[...queue.values()];queue.clear();tasks.forEach(fn=>fn());};
  return {state,sent,overlay,queue,flush};
}

test('actual workspace presence coalesces rapid changes and sends the final clear or Play state',()=>{
  const f=clientPresenceFixture();f.state.sendPresence();f.state.selectedId='b';f.state.sendPresence();f.state.selectedId=null;f.state.sendPresence();
  assert.equal(f.queue.size,1);f.flush();assert.equal(f.sent.length,1);assert.equal(f.sent[0].selected_id,null);
  f.state.selectedId='a';f.state.sendPresence();f.state.mode='play';f.flush();
  assert.equal(f.sent.at(-1).mode,'playing');assert.equal(f.sent.at(-1).selected_id,null);assert.equal(f.sent.at(-1).selected_address,null);
  assert.deepEqual(f.sent[0].selected_objects,[]);assert.deepEqual(f.sent.at(-1).selected_objects,[]);
});

test('actual workspace presence coalesces same-primary secondary changes into the final whole selection',()=>{
  const f=clientPresenceFixture();
  for(const ids of [['b','a'],['c','a'],['d','c','a']]){
    f.state.selectObject('a',{ids});
    assert.equal(f.state.selectedId,'a');assert.equal(f.queue.size,1);assert.equal(f.sent.length,0);
  }
  f.flush();assert.equal(f.queue.size,0);assert.equal(f.sent.length,1);
  const packet=f.sent[0],expected=['d','c','a'].map(id=>f.state.docObjects().find(object=>object.id===id));
  assert.equal(packet.selected_id,'a');assert.deepEqual(packet.selected_address,expected.at(-1).address);
  assert.deepEqual(packet.selected_objects,expected);assert.equal(packet.selection_intent,3);
  assert.equal(packet.source_revision,'v1');assert.equal(packet.mode,'editing');
});

test('actual workspace presence sends a final empty selection after rapid same-primary secondary changes',()=>{
  const f=clientPresenceFixture();f.state.selectObject('a',{ids:['b','a']});f.flush();
  assert.equal(f.sent[0].selected_objects.length,2);
  f.state.selectObject('a',{ids:['c','a']});f.state.selectObject('a',{ids:['d','a']});
  assert.equal(f.state.selectedId,'a');assert.equal(f.sent.length,1);
  f.state.selectObject(null,{ids:[]});assert.equal(f.queue.size,1);f.flush();
  assert.equal(f.sent.length,2);assert.equal(f.queue.size,0);
  const packet=f.sent.at(-1);
  assert.equal(packet.selected_id,null);assert.equal(packet.selected_address,null);assert.deepEqual(packet.selected_objects,[]);
  assert.equal(packet.selection_intent,4);assert.equal(packet.mode,'editing');
  f.flush();assert.equal(f.sent.length,2,'no delayed non-empty selection survives the final clear');
});

test('actual workspace presence clears delayed old-document camera and rejects an unsubscribed scope',()=>{
  const f=clientPresenceFixture();f.state.sendPresence({position:[1,2,3],target:[0,0,0]});f.state.clearPresence();f.flush();
  assert.equal(f.sent.length,0);assert.equal(f.overlay.at(-1).peers.length,0);
  f.state.sendPresence({position:[1,2,3],target:[0,0,0]});f.state.resourceId='other';f.flush();assert.equal(f.sent.length,0);
  f.state.api.scope.resource_id='other';f.state.sendPresence();f.flush();assert.equal(f.sent.length,1);assert.equal(f.sent[0].camera,undefined);
  f.state.sendPresence();f.state.api.ready=false;f.flush();assert.equal(f.sent.length,1,'disconnect cannot send stale presence');
});

test('coalesced A-to-other-to-A and repeated clicks preserve tokens for browser-local ordering',t=>{
  const server=fixture(t),client=clientPresenceFixture(),tracker=new LocalSelectionOrder(),observe=()=>tracker.update(server.peers());
  server.send(1,{selection_intent:0});observe();server.send(2,{selection_intent:1});const bOrder=observe().find(peer=>peer.id===server.users[2].id).selection_order;
  client.state.selectObject('b');client.state.selectObject('a');assert.equal(client.queue.size,1);
  client.flush();assert.equal(client.sent.length,1);assert.equal(client.sent[0].selected_id,'a');assert.equal(client.sent[0].selection_intent,2);
  server.send(1,{selection_intent:client.sent[0].selection_intent});const first=observe().find(peer=>peer.id===server.users[1].id).selection_order;assert.ok(first>bOrder);
  client.state.selectObject('a');client.flush();assert.equal(client.sent.at(-1).selection_intent,3);
  server.send(1,{selection_intent:client.sent.at(-1).selection_intent});const second=observe().find(peer=>peer.id===server.users[1].id).selection_order;assert.ok(second>first,'same-object click is a new locally observed intent');server.peer(1).last_presence=0;
  server.send(1,{selection_intent:3,camera:{position:[1,2,3],target:[0,0,0]}});assert.equal(observe().find(peer=>peer.id===server.users[1].id).selection_order,second);
  assert.equal(server.peers(0).find(peer=>peer.id===server.users[1].id).selection_intent,3,'relay preserves exact client intent');
  server.send(1,{selection_intent:4,selected_address:server.address(['a'],{branch_id:'wrong'})});
  assert.equal(server.peer(1).selection_intent,3,'invalid address cannot replace a relayed intent');assert.equal('selectionOrder' in server.realtime,false);
});

test('local initial snapshots stay stable through reordering and retain each users newest window',()=>{
  const tracker=new LocalSelectionOrder(),a={peer_id:'a-one',user_id:'a',selected_id:'object',mode:'editing',selection_intent:1},b={peer_id:'b-one',user_id:'b',selected_id:'object',mode:'editing',selection_intent:1};
  const first=tracker.update([a,b]),orders=Object.fromEntries(first.map(peer=>[peer.peer_id,peer.selection_order]));
  const repeated=tracker.update([b,{...a,camera:{position:[4,5,6]}}]);assert.deepEqual(Object.fromEntries(repeated.map(peer=>[peer.peer_id,peer.selection_order])),orders);
  const secondWindow={...a,peer_id:'a-two',selection_intent:2};let rows=tracker.update([a,b,secondWindow]);assert.ok(rows.find(peer=>peer.peer_id==='a-two').selection_order>orders['b-one']);
  rows=tracker.update([{...a,selection_intent:3},b,secondWindow]);assert.equal(rows.sort((x,y)=>y.selection_order-x.selection_order)[0].peer_id,'a-one');
  tracker.update([b]);assert.equal(tracker.ranks.has('a-one'),false);assert.equal(tracker.ranks.has('a-two'),false);
  tracker.clear();assert.equal(tracker.next,0);assert.equal(tracker.ranks.size,0);
  assert.deepEqual(tracker.update([a,b]),new LocalSelectionOrder().update([a,b]),'new viewers initialize reproducibly from the same snapshot without claiming earlier chronology');
});
