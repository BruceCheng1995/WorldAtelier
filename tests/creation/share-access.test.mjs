import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationCollaboration} from '../../services/creation/collaboration.mjs';

// Independent Share contract: temporary SQLite, real HTTP and authenticated WS.
// No production accounts, paid Agent, fabricated runtime ACKs or gameplay claim.
const root=process.env.WORLD_ATELIER_TEST_ROOT??resolve(import.meta.dirname,'../..');
const uid=p=>`${p}-${randomUUID()}`,wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=b=>createHash('sha256').update(b).digest('hex');
async function freePort(port){const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(port,'127.0.0.1',ok);});const selected=s.address().port;await new Promise(ok=>s.close(ok));return selected;}

test('Share independent HTTP, permissions and administrator consistency',{timeout:1000000},async t=>{
  const port=await freePort(Number(process.env.WORLD_ATELIER_SHARE_TEST_PORT??48921)),origin=`http://127.0.0.1:${port}`;
  const data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-share-'))),database=resolve(data,'creation/creation.sqlite');
  const evidence=resolve(root,'.local/share-redesign',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);mkdirSync(evidence,{recursive:true});
  const files=['services/creation/collaboration.mjs','services/creation/store.mjs','services/creation/service.mjs','services/creation/admin.mjs','services/creation/realtime.mjs','apps/creation-workspace/collaboration-access.js','apps/creation-workspace/collaboration-access.css'];
  const report={scope:'Isolated real HTTP / SQLite / WS; no paid Agent or gameplay claim',origin,evidence,started_at:new Date().toISOString(),cases:[],completed:false,source_hashes:Object.fromEntries(files.map(p=>[p,hash(readFileSync(resolve(root,p)))]))};
  const credentials={name:uid('Share Owner'),password:uid('Password')};
  const setup=new CreationStore(database),A={...setup.register(credentials),credentials};setup.put('creator_admin_settings',{id:'singleton',owner_user_id:A.user.id});setup.close();
  let child,log='';const peers=new Set();
  async function stop(){for(const p of peers)p.ws.terminate();peers.clear();if(child&&child.exitCode===null&&child.signalCode===null){const end=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),12000);await end;clearTimeout(timer);}await freePort(port);}
  async function start(){const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_PUBLIC_PLAY:'1',WORLD_ATELIER_LAN:'0'};delete env.WORLD_ATELIER_PREVIEW_HOST;delete env.WORLD_ATELIER_ADMIN_USER_ID;child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});report.service_pids??=[];report.service_pids.push(child.pid);child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(log);try{const h=await fetch(origin+'/creation-api/health').then(r=>r.json());if(h.ok){assert.equal(h.agent_ready,false);assert.equal(h.worlds_ready,false);return;}}catch{}await wait(30);}throw Error('Share isolated server failed to start: '+log);}
  t.after(async()=>{await stop();report.finished_at=new Date().toISOString();report.source_changed_during_run=files.filter(p=>report.source_hashes[p]!==hash(readFileSync(resolve(root,p))));rmSync(data,{recursive:true,force:true});report.temporary_data_removed=!existsSync(data);writeFileSync(resolve(evidence,'server.log'),log);writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('SHARE_REPORT '+resolve(evidence,'report.json'));});
  const request=async(method,path,actor,input)=>{const r=await fetch(origin+'/creation-api'+path,{method,headers:{origin,'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+actor.token}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,value:await r.json()};};
  const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.value));return r.value;};
  const register=async name=>{const credentials={name:uid(name),password:uid('Password')};return {...ok(await request('POST','/auth/register',null,credentials),201),credentials};};
  const path=p=>`/projects/${p}`,branch=p=>path(p)+'/branches/main';
  const view=async(actor,p)=>ok(await request('GET',path(p)+'/collaboration',actor));
  const inbox=async(actor)=>ok(await request('GET','/inbox?filter=all',actor)).items;
  const invite=async(actor,p,names,role='editor',extra={})=>request('POST',path(p)+'/share-invitations',actor,{request_id:uid('direct'),expected_version:(await view(A,p)).project.permission_version,names,role,...extra});
  const share=async(p,access,extra={})=>request('PATCH',path(p)+'/sharing',A,{request_id:uid('sharing'),expected_version:(await view(A,p)).project.permission_version,general_access:access,...extra});
  const member=async(p,actor,role)=>ok(await request('PATCH',path(p)+'/members/'+actor.user.id,A,{request_id:uid('member'),expected_version:(await view(A,p)).project.permission_version,role}));
  const admin=async(type,id,input)=>{const detail=ok(await request('GET',`/admin/${type}/${id}`,A)).item;return ok(await request('PATCH',`/admin/${type}/${id}`,A,{request_id:uid('admin'),expected_version:detail.version,reason:'Independent Share boundary verification',...input}));};
  async function connect(actor,p){const ws=new WebSocket(origin.replace('http:','ws:')+'/ws/creation',{origin}),peer={ws,messages:[],closed:false};peers.add(peer);ws.on('message',b=>peer.messages.push(JSON.parse(b.toString())));ws.on('close',()=>peer.closed=true);ws.on('error',()=>{});await new Promise((ok,no)=>{ws.once('open',ok);ws.once('error',no);});peer.send=m=>ws.send(JSON.stringify(m));peer.packet=async(type,condition=()=>true,mark=0)=>{for(let i=0;i<200;i++){const found=peer.messages.slice(mark).find(m=>m.type===type&&condition(m));if(found)return found;await wait(15);}throw Error('Missing WS '+type+': '+JSON.stringify(peer.messages.slice(mark)));};peer.send({type:'auth',token:actor.token});await peer.packet('authenticated');if(p){peer.send({type:'subscribe',project_id:p,branch_id:'main',resource_id:'scene-harbor',generation:1});await peer.packet('baseline');}return peer;}
  async function check(name,fn){const row={name,status:'running'};report.cases.push(row);try{row.observations=await fn();row.status='passed';console.log('SHARE_CASE '+name+' passed');}catch(e){row.status='failed';row.error=e.message;throw e;}}
  await start();
  const B=await register('Share Editor'),C=await register('Share Outsider'),D=await register('Share Viewer'),E=await register('Share Disabled'),F=await register('Share Invitee');
  const p=ok(await request('POST','/projects',A,{name:'Independent Share access game',template:'harbor'}),201).project.id;
  let directInput,privateInput,privateSession,usedInviteInput,unusedInvite;
  await check('view_and_atomic_direct_invitation',async()=>{
    const initial=await view(A,p);assert.equal(initial.share_version,1);assert.equal(initial.general_access,'registered_readonly');assert.equal(initial.public_access_available,true);assert.equal(initial.capabilities.can_invite,true);assert.equal(initial.capabilities.can_change_access,true);assert.ok(initial.share_urls.includes(origin+'/creation-workspace.html'));
    const outsider=await view(C,p);assert.equal(outsider.project.role,'player');assert.equal(outsider.capabilities.can_invite,false);assert.equal(outsider.capabilities.can_change_access,false);
    const pending=ok(await request('POST',path(p)+'/access-requests',B,{request_id:uid('pending'),reason:'Join via direct invite'}),201).request;
    const version=(await view(A,p)).project.permission_version;
    assert.equal((await invite(A,p,[B.user.name,uid('unknown')])).status,400);assert.equal((await view(B,p)).project.role,'player');assert.equal((await view(A,p)).project.permission_version,version);
    for(const names of [[],Array(11).fill(B.user.name),[null]])assert.equal((await invite(A,p,names)).status,400);
    assert.equal((await invite(A,p,[B.user.name],'owner')).status,400);
    directInput={request_id:uid('exact-direct'),expected_version:version,names:[B.user.name,` ${B.user.name.toUpperCase()} `],role:'editor'};
    const added=ok(await request('POST',path(p)+'/share-invitations',A,directInput),201);assert.deepEqual(added.added,[B.user.id]);assert.equal((await view(B,p)).project.role,'editor');assert.equal((await view(B,p)).my_request.status,'approved');
    const notifications=(await inbox(B)).length;assert.equal(ok(await request('POST',path(p)+'/share-invitations',A,directInput),201).replayed,true);assert.equal((await inbox(B)).length,notifications);
    assert.equal((await request('POST',path(p)+'/share-invitations',A,{...directInput,role:'viewer'})).status,409);
    assert.equal((await invite(B,p,[C.user.name])).status,403);assert.equal((await invite(C,p,[C.user.name])).status,403);
    assert.equal((await request('PATCH',path(p)+'/sharing',B,{request_id:uid('no-owner'),expected_version:2,general_access:'members_only'})).status,403);
    const noChange=(await view(A,p)).project.permission_version;assert.deepEqual(ok(await invite(A,p,[A.user.name,B.user.name],'viewer'),201).added,[]);assert.equal((await view(A,p)).project.permission_version,noChange);assert.equal((await view(B,p)).project.role,'editor');
    ok(await invite(A,p,[D.user.name],'viewer'),201);
    return {normalized_duplicate_once:true,pending_request:pending.id,request_approved:true,notification_replay_deduped:true,no_implicit_downgrade:true};
  });
  await check('version_guard_private_sessions_and_real_editor_write',async()=>{
    assert.equal((await invite(A,p,[C.user.name],'editor',{expected_version:1})).status,409);assert.equal((await invite(A,p,[C.user.name],'editor',{expected_version:null})).status,400);
    privateSession=ok(await request('POST',branch(p)+'/sessions',A,{title:'Owner private session'}),201);assert.equal((await request('GET','/sessions/'+privateSession.id,B)).status,403);
    const current=ok(await request('GET',branch(p),B)),target=current.manifest.resources['scene-harbor'].objects[0];
    const edited=ok(await request('POST',branch(p)+'/transactions',B,{transaction_id:uid('share-edit'),base_revision:current.head,ops:[{type:'patch_object',resource_id:'scene-harbor',object_id:target.id,expected_version:target.version,patch:{name:'Direct invited editor saved'}}]}));assert.notEqual(edited.revision,current.head);
    assert.equal((await request('POST',branch(p)+'/sessions',D,{})).status,403);assert.equal((await request('GET','/sessions/'+privateSession.id,C)).status,403);
    return {revision:edited.revision,private_sessions_isolated:true,viewer_cannot_create_session:true};
  });
  await check('scope_switch_revokes_public_live_access_preserves_members',async()=>{
    const outsiderPeer=await connect(C,p),editorPeer=await connect(B,p),m=outsiderPeer.messages.length;
    unusedInvite=ok(await request('POST',path(p)+'/invites',A,{request_id:uid('explicit-code'),role:'viewer'}),201);
    privateInput={request_id:uid('scope-private'),expected_version:(await view(A,p)).project.permission_version,general_access:'members_only'};
    ok(await request('PATCH',path(p)+'/sharing',A,privateInput));await outsiderPeer.packet('project_permissions',v=>v.project_id===p&&v.project===null,m);
    assert.equal((await request('GET',branch(p),C)).status,403);assert.equal((await request('GET',path(p)+'/collaboration',C)).status,403);
    assert.equal(ok(await request('GET','/bootstrap',C)).projects.some(v=>v.id===p),false);
    await editorPeer.packet('project_permissions',v=>v.project_id===p&&v.project?.role==='editor');assert.equal((await view(D,p)).project.role,'viewer');assert.equal((await view(A,p)).general_access,'members_only');
    usedInviteInput={request_id:uid('join-explicit'),code:unusedInvite.code};assert.equal(ok(await request('POST','/invites/join',F,usedInviteInput)).role,'viewer');
    await member(p,F,null);assert.equal((await request('POST','/invites/join',F,usedInviteInput)).status,403);assert.equal((await request('POST','/invites/join',F,{...usedInviteInput,request_id:uid('new-replay')})).status,403);
    return {outsider_catalog_and_http_revoked:true,ws_project_removed:true,members_preserved:true,explicit_invite_can_join_private:true,used_receipt_cannot_restore_removed_access:true};
  });
  await check('idempotent_replay_never_reverts_later_members_or_scope',async()=>{
    await member(p,B,'viewer');const v=(await view(A,p)).project.permission_version;
    assert.equal(ok(await request('POST',path(p)+'/share-invitations',A,directInput),201).replayed,true);assert.equal((await view(B,p)).project.role,'viewer');assert.equal((await view(A,p)).project.permission_version,v);
    assert.equal((await request('POST',branch(p)+'/sessions',B,{})).status,403);
    ok(await share(p,'registered_readonly'));const after=(await view(A,p)).project.permission_version;
    assert.equal(ok(await request('PATCH',path(p)+'/sharing',A,privateInput)).replayed,true);assert.equal((await view(C,p)).general_access,'registered_readonly');assert.equal((await view(A,p)).project.permission_version,after);
    assert.equal((await request('PATCH',path(p)+'/sharing',A,{...privateInput,general_access:'registered_readonly'})).status,409);
    const racedVersion=after;
    const raced=await Promise.all([share(p,'members_only',{expected_version:racedVersion}),invite(A,p,[C.user.name],'viewer',{expected_version:racedVersion})]);assert.equal(raced.filter(r=>[200,201].includes(r.status)).length,1);assert.equal(raced.filter(r=>r.status===409).length,1);
    ok(await share(p,'registered_readonly'));
    return {direct_grant_replay_no_regrant:true,scope_replay_no_rollback:true,concurrent_role_scope_one_winner:true};
  });
  await check('administrator_override_archive_and_disabled_accounts_are_consistent',async()=>{
    const stale=(await view(A,p)).project.permission_version;
    await admin('projects',p,{action:'public_play',value:false});assert.equal((await view(A,p)).general_access,'members_only');assert.equal((await request('GET',path(p)+'/collaboration',F)).status,403);
    assert.equal((await share(p,'registered_readonly',{expected_version:stale})).status,409);ok(await share(p,'registered_readonly'));
    const pending=ok(await request('POST',path(p)+'/access-requests',E,{request_id:uid('disabled-pending'),reason:'Pending before disabled'}),201).request;
    await admin('users',E.user.id,{action:'status',value:'disabled'});
    const version=(await view(A,p)).project.permission_version;
    assert.equal((await invite(A,p,[F.user.name,E.user.name])).status,400);assert.equal((await view(A,p)).project.permission_version,version);assert.equal((await view(F,p)).project.role,'player');
    assert.equal((await request('POST',`${path(p)}/access-requests/${pending.id}/decision`,A,{request_id:uid('disabled-approve'),expected_version:pending.version,decision:'approve'})).status,409);
    assert.equal((await request('PATCH',path(p)+'/members/'+E.user.id,A,{request_id:uid('disabled-member'),role:'viewer',expected_version:version})).status,409);
    assert.equal((await request('GET',path(p)+'/collaboration',E)).status,401);
    assert.equal((await view(A,p)).requests.find(r=>r.id===pending.id).status,'pending');
    const inviteBeforeArchive=ok(await request('POST',path(p)+'/invites',A,{request_id:uid('archive-code'),role:'viewer'}),201);
    await admin('projects',p,{action:'status',value:'archived'});
    for(const actor of [A,B,D,F])assert.equal((await request('GET',path(p)+'/collaboration',actor)).status,403);
    assert.equal((await request('POST','/invites/join',F,{request_id:uid('archived-join'),code:inviteBeforeArchive.code})).status,403);
    assert.equal((await request('POST',path(p)+'/share-invitations',A,directInput)).status,403);
    await admin('projects',p,{action:'status',value:'active'});assert.equal((await view(A,p)).general_access,'registered_readonly');assert.equal((await view(D,p)).project.role,'viewer');
    return {admin_private_view_matches_access:true,archive_blocks_all_members_and_replay:true,disabled_grant_atomic:true,disabled_approval_rejected:true,restoration_preserves_roles:true};
  });
  await check('durable_scope_members_and_notification_replay_after_restart',async()=>{
    const snapshot=await view(A,p),notifications=(await inbox(B)).length;await stop();await start();
    const restored=await view(A,p);assert.equal(restored.general_access,snapshot.general_access);assert.equal(restored.project.permission_version,snapshot.project.permission_version);assert.deepEqual(restored.members,snapshot.members);
    assert.equal(ok(await request('POST',path(p)+'/share-invitations',A,directInput),201).replayed,true);assert.equal((await view(B,p)).project.role,'viewer');assert.equal((await inbox(B)).length,notifications);
    assert.equal((await request('GET','/sessions/'+privateSession.id,B)).status,403);
    return {restart_preserved_permissions:true,replay_does_not_duplicate_notifications:true};
  });
  report.completed=true;
  if(process.env.WORLD_ATELIER_SHARE_BROWSER_GATE==='1'){
    const made=ok(await request('POST','/projects',A,{name:'Share browser approval playground',template:'harbor'}),201),gate=resolve(evidence,'browser-complete.json');
    writeFileSync(resolve(evidence,'browser-setup.json'),JSON.stringify({origin,owner:A.credentials,applicant:C.credentials,viewer:D.credentials,project:made.project,branch:made.branch,gate},null,2)+'\n',{mode:0o600});
    console.log('SHARE_BROWSER_READY '+JSON.stringify({origin,evidence,gate}));
    for(let i=0;i<900&&!existsSync(gate);i++)await wait(1000);assert.ok(existsSync(gate),'Browser evidence timeout');report.browser=JSON.parse(readFileSync(gate,'utf8'));assert.equal(report.browser.passed,true);
  }
});

test('Share disabled invite issuer and server-wide public access policy',{timeout:30000},()=>{
  const dir=mkdtempSync(resolve(tmpdir(),'atelier-share-store-')),store=new CreationStore(resolve(dir,'creation.sqlite'));store.publicPlay=true;
  try{
    const A=store.register({name:'Issuer',password:'Password-123'}).user,B=store.register({name:'Recipient',password:'Password-123'}).user;
    const manifest={schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]}}};
    const p=store.createProject(A,{name:'Private policy'},manifest).project.id,collaboration=new CreationCollaboration({store});
    const invite=collaboration.invite(A,p,{request_id:'create-before-disable',role:'editor'}),row=store.get('creator_user',A.id);row.disabled_at=Date.now();store.put('creator_user',row);
    assert.throws(()=>collaboration.join(B,{request_id:'join-disabled-owner',code:invite.code}),e=>e.status===404);assert.equal(store.get('creator_project',p).members[B.id],undefined);
    row.disabled_at=null;store.put('creator_user',row);store.publicPlay=false;
    assert.equal(collaboration.view(A,p).general_access,'members_only');assert.equal(collaboration.view(A,p).public_access_available,false);
    assert.throws(()=>collaboration.generalAccess(A,p,{request_id:'server-forbids-public',expected_version:1,general_access:'registered_readonly'}),e=>e.status===403);
    assert.throws(()=>collaboration.view(B,p),e=>e.status===403);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('Share stable links keep the target game and branch without invite query',async()=>{
  const {CollaborationAccess}=await import('../../apps/creation-workspace/collaboration-access.js');
  const link=(href,projectId='game-a',share_urls=[])=>CollaborationAccess.prototype.shareLink.call({document:{location:{href}},projectId,data:{share_urls}});
  assert.equal(link('http://127.0.0.1:48921/creation-workspace.html?invite=old-code#/games/game-a/branches/main?object=secret'),'http://127.0.0.1:48921/creation-workspace.html#/games/game-a/branches/main');
  assert.equal(link('http://127.0.0.1:48921/creation-workspace.html#/games/game-a/branches/main','game-b'),'http://127.0.0.1:48921/creation-workspace.html#/games/game-b');
  assert.equal(link('http://localhost:48921/creation-workspace.html?invite=old#/games/game-a/branches/main','game-a',['javascript:bad','http://127.0.0.1:48921/creation-workspace.html','http://10.0.0.25:48921/creation-workspace.html']),'http://10.0.0.25:48921/creation-workspace.html#/games/game-a/branches/main');
});
