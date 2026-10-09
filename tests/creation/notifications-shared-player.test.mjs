import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationInbox} from '../../services/creation/inbox.mjs';
import {CreationNotifications} from '../../services/creation/notifications.mjs';
import {NativeWorlds} from '../../services/creation/native-worlds.mjs';
import {nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {NativeSharedPlay} from '../../apps/creation-workspace/native-shared-play.js';

// Authorization tests use real SQLite and the actual NativeWorlds.authorizeBuild.
// Stored publication/build inputs are fixtures; no Godot process or runtime ACK
// is simulated, and these tests do not claim a successful game startup.
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'atelier-shared-diagnostics-')),store=new CreationStore(join(dir,'db.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const owner={id:'owner',name:'Owner'},player={id:'player',name:'Player'},other={id:'other',name:'Other'};
  for(const user of [owner,player,other])store.put('creator_user',user);
  const source_files={'main.tscn':{hash:hash(Buffer.from('[gd_scene format=3]\n[node name="Main" type="Node3D"]\n')),size:60}},source_identity=nativeSourceIdentity(source_files);
  const manifest={schema:'creation-native-1',source_files,source_identity,index_source_identity:source_identity,entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',path:'main.tscn',version:'main-version',native_nodes:[]},second:{id:'second',kind:'scene',name:'Second',path:'second.tscn',version:'second-version',native_nodes:[]},private:{id:'private',kind:'prefab',name:'Private',path:'private.tscn',version:'private-version',native_nodes:[]}}};
  const {project,branch}=store.createProject(owner,{name:'Shared diagnostic authority'},manifest);
  store.publicPlay=true;
  const service={store,root:'/project',data:dir,observe:fn=>fn()};
  service.inbox=new CreationInbox({store});service.worlds={service,store,worlds:new Map(),key:(p,b,r)=>`${p}/${b}/${r}`};service.worlds.native=new NativeWorlds(service.worlds);
  const notices=new CreationNotifications({service});
  function publication(suffix,entry='main'){
    const job={id:'shared-'+suffix,purpose:'native_shared',status:'completed',project_id:project.id,branch_id:'main',source_revision:branch.head,entry_scene_id:entry,canonical_identity:hash(['native-shared',suffix])};
    const world={id:'world-'+suffix,key:service.worlds.native.key(project.id,'main',entry),project_id:project.id,branch_id:'main',resource_id:entry,revision:branch.head,native_shared:true,game_build_id:job.id,runtime_build_id:job.canonical_identity,epoch:1};
    store.put('creator_build',job);store.put('creator_world',world);return{job,world};
  }
  const {job,world}=publication('one'),second=publication('two','second');
  const input={shared_build_id:job.id,project_id:project.id,branch_id:'main',revision:branch.head,resource_id:'main',runtime_build_id:job.canonical_identity,client_id:'iframe-a',code:'asset_load'};
  const claim=(user=player,extra={})=>notices.client(user,{...input,event_id:crypto.randomUUID(),message:'Client observation only',...extra}).item;
  const recover=(user=player,extra={})=>notices.clientRecovered(user,{...input,...extra});
  const status=item=>store.get('creator_inbox_item',item.id).status;
  return{store,service,notices,owner,player,other,project,branch,job,world,second,input,claim,recover,status};
}
const bad=(fn,status)=>assert.throws(fn,error=>error.status===status);

test('public shared player reports and recovers only recipient-local fixed-build diagnostics',t=>{
  const f=fixture(t),before=f.store.get('creator_revision',f.branch.head),item=f.claim();
  assert.equal(f.store.roleFor(f.player,f.store.get('creator_project',f.project.id)),'player');
  assert.equal(item.project_id,null);assert.equal(item.revision,null);assert.equal(item.resource_id,null);assert.equal(item.world_id,null);
  assert.equal(item.runtime_build_id,f.job.canonical_identity);assert.equal(item.client_id,'iframe-a');assert.deepEqual(item.targets,[]);assert.deepEqual(item.actions,[]);
  assert.deepEqual(item.recipient_user_ids,[f.player.id]);assert.equal(f.service.inbox.get(f.player,item.id).status,'open');
  bad(()=>f.service.inbox.get(f.other,item.id),403);assert.equal(f.recover().count,1);assert.equal(f.status(item),'resolved');
  assert.equal(f.store.branchFor(f.owner,f.project.id,'main').head,f.branch.head);assert.deepEqual(f.store.get('creator_revision',f.branch.head),before);
});

test('shared recovery cannot clear another user, window, build or source-scoped error',t=>{
  const f=fixture(t),own=f.claim(),protectedItems=[f.claim(f.other),f.claim(f.player,{client_id:'iframe-b'}),f.claim(f.player,{shared_build_id:f.second.job.id,resource_id:'second',runtime_build_id:f.second.job.canonical_identity})];
  const source={...f.input,shared_build_id:undefined};
  protectedItems.push(f.notices.client(f.owner,{...source,event_id:'owner-source'}).item);
  const project=f.store.get('creator_project',f.project.id);project.members[f.player.id]='viewer';f.store.put('creator_project',project);
  protectedItems.push(f.notices.client(f.player,{...source,event_id:'former-member-source'}).item);
  delete project.members[f.player.id];f.store.put('creator_project',project);
  assert.equal(f.recover().count,1);assert.equal(f.status(own),'resolved');for(const item of protectedItems)assert.equal(f.status(item),'open');
  bad(()=>f.claim(f.player,{shared_build_id:undefined}),403);bad(()=>f.recover(f.player,{shared_build_id:undefined}),403);
  bad(()=>f.service.inbox.get(f.player,protectedItems.at(-1).id),403);
});

test('public claim and recovery reject forged pins and private source selectors before target resolution',t=>{
  const f=fixture(t),item=f.claim();
  for(const extra of [{shared_build_id:'missing'},{runtime_build_id:'wrong'},{project_id:'other'},{branch_id:'side'},{revision:'other'},{resource_id:'private'}]){
    bad(()=>f.claim(f.player,extra),403);bad(()=>f.recover(f.player,extra),403);
  }
  for(const extra of [{client_id:null},{object_id:'secret'},{address:{definition_node_id:'secret'}},{world_id:f.world.id},{epoch:1},{session_id:'private-session'},{targets:[]},{recipient_user_ids:[f.other.id]}]){
    bad(()=>f.claim(f.player,extra),400);bad(()=>f.recover(f.player,extra),400);
  }
  assert.equal(f.status(item),'open');
});

test('shared authorization is rechecked on every claim and recovery, including release replacement and revocation',t=>{
  const f=fixture(t),item=f.claim(),denied=()=>{bad(()=>f.claim(),403);bad(()=>f.recover(),403);assert.equal(f.status(item),'open');};
  for(const patch of [{purpose:'native_preview'},{purpose:'play'},{status:'running'},{status:'failed'}]){
    f.store.put('creator_build',{...f.job,...patch});denied();f.store.put('creator_build',f.job);
  }
  for(const patch of [{game_build_id:'replacement'},{revision:'replacement'},{runtime_build_id:'replacement'},{native_shared:false}]){
    f.store.put('creator_world',{...f.world,...patch});denied();f.store.put('creator_world',f.world);
  }
  const project=f.store.get('creator_project',f.project.id);
  for(const patch of [{public_play:false},{archived_at:Date.now()}]){f.store.put('creator_project',{...project,...patch});denied();f.store.put('creator_project',project);}
  f.store.publicPlay=false;denied();f.store.publicPlay=true;
  f.store.put('creator_user',{...f.player,disabled_at:Date.now()});denied();f.store.put('creator_user',f.player);
  assert.equal(f.recover().count,1);
});

test('native shared diagnostic dispatch binds errors and recovery to the completed job, stripping source targets',t=>{
  const previous=globalThis.window,events=[];globalThis.window={dispatchEvent:event=>events.push(event.detail)};t.after(()=>{globalThis.window=previous;});
  const preview=Object.assign(Object.create(NativeSharedPlay.prototype),{disposed:false,nonce:'own-nonce',runtimeBuildId:'canonical',sceneContext:{document_id:'private-project/private-branch/private-object',source_revision:'private-revision'},job:{id:'job',purpose:'native_shared',status:'completed',project_id:'public-project',branch_id:'main',source_revision:'published',entry_scene_id:'entry',canonical_identity:'canonical'}});
  // Direct producer calls, not fabricated loaded/Godot ACK envelopes.
  for(const recovered of [false,true])preview.diagnostic('runtime_load','Observed client result',{recovered,object_id:'private-node',world_id:'private-world',project_id:'injected'});
  assert.equal(events.length,2);assert.equal(events[1].recovered,true);
  for(const event of events){assert.equal(event.shared_build_id,'job');assert.equal(event.project_id,'public-project');assert.equal(event.revision,'published');assert.equal(event.resource_id,'entry');assert.equal(event.runtime_build_id,'canonical');assert.equal(event.client_id,'own-nonce');for(const key of ['object_id','address','world_id','epoch'])assert.equal(event[key],undefined);}
  for(const job of [null,{...preview.job,status:'running'},{...preview.job,purpose:'play'}]){
    preview.job=job;preview.diagnostic('runtime_load','No fixed job yet',{object_id:'private-node'});const event=events.at(-1);assert.equal(event.shared_build_id,undefined);assert.equal(event.project_id,undefined);assert.equal(event.object_id,undefined);
  }
});
