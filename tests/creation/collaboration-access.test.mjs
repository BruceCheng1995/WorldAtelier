import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {WebSocket} from 'ws';

// Independent real HTTP, SQLite and authenticated WebSocket verification.
// Agents/world authority are disabled. Browser evidence is an explicit optional
// gate on the same isolated data; no production accounts or fabricated ACKs.
const root=process.env.WORLD_ATELIER_TEST_ROOT??resolve(import.meta.dirname,'../..');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),uid=prefix=>`${prefix}-${randomUUID()}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function availablePort(port){const server=createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});const selected=server.address().port;await new Promise(ok=>server.close(ok));return selected;}

test('collaboration access: real approval, invitations, role revocation, inbox and restart',{timeout:1000000},async t=>{
  const port=await availablePort(Number(process.env.WORLD_ATELIER_COLLAB_TEST_PORT??48921)),origin=`http://127.0.0.1:${port}`;
  const data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-collaboration-access-')));
  const evidence=resolve(root,'.local/creation-verification/collaboration-access',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);mkdirSync(evidence,{recursive:true});
  const sources=['services/creation/collaboration.mjs','services/creation/store.mjs','services/creation/service.mjs','services/creation/realtime.mjs','services/creation/inbox.mjs'];
  const report={scope:'real isolated HTTP/SQLite/WS; no paid Agent or gameplay claim',origin,data,evidence,started_at:new Date().toISOString(),cases:[],completed:false,source_hashes:Object.fromEntries(sources.map(file=>[file,hash(readFileSync(resolve(root,file)))]))};
  let child=null,log='';const peers=new Set();
  async function stop(){for(const peer of peers)peer.ws.terminate();peers.clear();if(child&&child.exitCode===null&&child.signalCode===null){const ended=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),12000);await ended;clearTimeout(timer);}await availablePort(port);}
  async function start(){
    const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_PUBLIC_PLAY:'1',WORLD_ATELIER_LAN:'0'};
    delete env.WORLD_ATELIER_PREVIEW_HOST;
    child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});report.service_pids??=[];report.service_pids.push(child.pid);child.stdout.on('data',bytes=>log+=bytes);child.stderr.on('data',bytes=>log+=bytes);
    for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(log);try{const response=await fetch(origin+'/creation-api/health');if(response.ok){const health=await response.json();assert.equal(health.collaboration_access,true);assert.equal(health.agent_ready,false);assert.equal(health.worlds_ready,false);return health;}}catch{}await wait(30);}throw Error('Isolated service did not start: '+log);
  }
  t.after(async()=>{await stop();report.finished_at=new Date().toISOString();report.source_changed_during_run=sources.filter(file=>report.source_hashes[file]!==hash(readFileSync(resolve(root,file))));rmSync(data,{recursive:true,force:true});report.temporary_data_removed=!existsSync(data);writeFileSync(resolve(evidence,'server.log'),log);writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('COLLABORATION_REPORT '+resolve(evidence,'report.json'));});
  const request=async(method,path,actor,input)=>{const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin,'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+actor.token}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,value:await response.json()};};
  const ok=(response,status=200)=>{assert.equal(response.status,status,JSON.stringify(response.value));return response.value;};
  const route=p=>`/projects/${p}`,branch=p=>`${route(p)}/branches/main`;
  const view=async(actor,p)=>ok(await request('GET',route(p)+'/collaboration',actor));
  const inbox=async(actor)=>ok(await request('GET','/inbox?filter=all',actor));
  const register=async label=>{const credentials={name:uid(label),password:uid('isolated-password')};return {...ok(await request('POST','/auth/register',null,credentials),201),credentials};};
  async function connect(actor){const ws=new WebSocket(origin.replace('http:','ws:')+'/ws/creation',{origin}),peer={ws,messages:[],closed:false};peers.add(peer);ws.on('message',bytes=>peer.messages.push(JSON.parse(bytes.toString())));ws.on('error',()=>{});ws.on('close',()=>peer.closed=true);await new Promise((ok,no)=>{ws.once('open',ok);ws.once('error',no);});peer.send=packet=>ws.send(JSON.stringify(packet));peer.packet=async(type,predicate=()=>true,mark=0)=>{for(let i=0;i<400;i++){const result=peer.messages.slice(mark).find(message=>message.type===type&&predicate(message));if(result)return result;await wait(10);}throw Error(`WS ${type} timed out: ${JSON.stringify(peer.messages.slice(mark))}`);};peer.send({type:'auth',token:actor.token});await peer.packet('authenticated');return peer;}
  async function check(name,fn){const row={name,status:'running'};report.cases.push(row);try{row.observations=await fn();row.status='passed';console.log('COLLABORATION_CASE '+name+' passed');}catch(error){row.status='failed';row.error=error.message;throw error;}}
  await start();
  const A=await register('Collaboration owner'),B=await register('Collaboration applicant'),C=await register('Collaboration stranger'),D=await register('Collaboration fourth');
  const made=ok(await request('POST','/projects',A,{name:'Independent collaboration approval',template:'harbor'}),201),p=made.project.id;
  const foreign=ok(await request('POST','/projects',A,{name:'Foreign scope',template:'empty'}),201).project.id;
  const ownerPeer=await connect(A),applicantPeer=await connect(B),strangerPeer=await connect(C);
  let pending,decisionInput,decisionItem,privateSession,sharedSession,bSession,originalInvite;

  await check('request_identity_dedupe_and_owner_notification',async()=>{
    const initial=await view(B,p);assert.equal(initial.project.role,'player');assert.equal(initial.capabilities.can_request_edit,true);assert.equal(initial.capabilities.can_manage,false);
    const input={request_id:uid('request'),reason:'I want to help edit this game.'},mark=ownerPeer.messages.length;
    pending=ok(await request('POST',route(p)+'/access-requests',B,input),201).request;assert.equal(pending.requester_user_id,B.user.id);assert.equal(pending.status,'pending');assert.equal(pending.version,1);
    assert.equal(ok(await request('POST',route(p)+'/access-requests',B,input),201).replayed,true);
    assert.equal(ok(await request('POST',route(p)+'/access-requests',B,{...input,request_id:uid('double-click')}),201).request.id,pending.id);
    assert.equal((await request('POST',route(p)+'/access-requests',B,{...input,reason:'changed payload'})).status,409);
    assert.equal((await request('POST',route(p)+'/access-requests',B,{request_id:uid('spoof'),requester_user_id:C.user.id,reason:'spoof'})).status,400);
    const state=await view(A,p);assert.equal(state.pending_count,1);assert.equal(state.requests.filter(r=>r.id===pending.id).length,1);
    const notices=(await inbox(A)).items.filter(item=>item.access_request_id===pending.id);assert.equal(notices.length,1);decisionItem=notices[0];assert.equal(decisionItem.kind,'decision');assert.equal(decisionItem.status,'open');assert.deepEqual(decisionItem.actions.map(a=>a.id),['collaboration']);
    await ownerPeer.packet('inbox_changed',()=>true,mark);await ownerPeer.packet('project_permissions',m=>m.project_id===p,mark);
    ok(await request('POST',`/inbox/${decisionItem.id}/read`,A,{request_id:uid('read'),expected_version:decisionItem.version}));assert.equal((await view(B,p)).project.role,'player');assert.equal((await view(A,p)).my_request,null);
    assert.equal((await request('GET',`/inbox/${decisionItem.id}`,B)).status,403);assert.equal((await request('GET',`/inbox/${decisionItem.id}`,C)).status,403);assert.equal((await view(C,p)).requests.length,0);
    return {request_id:pending.id,inbox_item_id:decisionItem.id,one_pending:true,read_does_not_approve:true,catalog_ws_notified:true};
  });

  await check('owner_only_approval_version_and_exact_retry',async()=>{
    decisionInput={request_id:uid('approve'),expected_version:pending.version,decision:'approve',note:'Welcome to editing.'};
    for(const actor of [B,C])assert.equal((await request('POST',`${route(p)}/access-requests/${pending.id}/decision`,actor,decisionInput)).status,403);
    assert.equal((await request('POST',`${route(foreign)}/access-requests/${pending.id}/decision`,A,decisionInput)).status,404);
    assert.equal((await request('POST',`${route(p)}/access-requests/${pending.id}/decision`,A,{...decisionInput,request_id:uid('stale'),expected_version:99})).status,409);
    const mark=applicantPeer.messages.length,approved=ok(await request('POST',`${route(p)}/access-requests/${pending.id}/decision`,A,decisionInput));assert.equal(approved.request.status,'approved');assert.equal(approved.request.reviewer_user_id,A.user.id);
    assert.equal(ok(await request('POST',`${route(p)}/access-requests/${pending.id}/decision`,A,decisionInput)).replayed,true);
    assert.equal((await request('POST',`${route(p)}/access-requests/${pending.id}/decision`,A,{...decisionInput,decision:'reject'})).status,409);
    assert.equal((await request('POST',`${route(p)}/access-requests/${pending.id}/decision`,A,{...decisionInput,request_id:uid('different-decision'),decision:'reject'})).status,409);
    const refreshed=await applicantPeer.packet('project_permissions',m=>m.project_id===p&&m.project?.role==='editor',mark);assert.equal(refreshed.can_create_project,true);assert.ok(refreshed.project.permission_version>1);
    const resultNotice=(await inbox(B)).items.find(item=>item.access_request_id===pending.id);assert.ok(resultNotice);assert.equal(resultNotice.kind,'notice');assert.equal(ok(await request('GET',`/inbox/${decisionItem.id}`,A)).item.status,'resolved');
    assert.equal((await request('POST',route(p)+'/invites',B,{request_id:uid('bad-invite'),role:'editor'})).status,403);
    assert.equal((await request('PATCH',`${route(p)}/members/${C.user.id}`,B,{request_id:uid('bad-member'),role:'editor'})).status,403);
    assert.equal((await request('PATCH',`${route(p)}/members/${A.user.id}`,A,{request_id:uid('owner-change'),role:'viewer'})).status,403);
    return {role:refreshed.project.role,permission_version:refreshed.project.permission_version,private_result_notification:true};
  });

  await check('approved_editor_real_write_and_private_session_boundary',async()=>{
    const before=ok(await request('GET',branch(p),B)),target=before.manifest.resources['scene-harbor'].objects[0];
    const write=ok(await request('POST',branch(p)+'/transactions',B,{transaction_id:uid('approved-edit'),base_revision:before.head,ops:[{type:'patch_object',resource_id:'scene-harbor',object_id:target.id,expected_version:target.version,patch:{name:'Collaborator approved real edit'}}]}));assert.notEqual(write.revision,before.head);
    privateSession=ok(await request('POST',branch(p)+'/sessions',A,{title:'Owner private sentinel',visibility:'private'}),201);sharedSession=ok(await request('POST',branch(p)+'/sessions',A,{title:'Explicitly shared owner session'}),201);ok(await request('PATCH',`/sessions/${sharedSession.id}`,A,{visibility:'shared',draft:'shared-read-only'}));
    assert.equal((await request('GET',`/sessions/${privateSession.id}`,B)).status,403);ok(await request('GET',`/sessions/${sharedSession.id}`,B));assert.equal((await request('PATCH',`/sessions/${sharedSession.id}`,B,{draft:'forbidden'})).status,403);
    bSession=ok(await request('POST',branch(p)+'/sessions',B,{title:'Applicant private retained draft'}),201);ok(await request('PATCH',`/sessions/${bSession.id}`,B,{draft:'retain while read-only'}));
    assert.equal((await request('GET',`/sessions/${bSession.id}`,A)).status,403);
    originalInvite=ok(await request('POST',route(p)+'/invites',A,{request_id:uid('before-demotion'),role:'editor'}),201);
    return {revision:write.revision,private_sessions_isolated:true};
  });

  await check('revoke_current_write_and_session_subscription_authority',async()=>{
    const scenePeer=await connect(B),sessionOnlyPeer=await connect(B);scenePeer.send({type:'subscribe',project_id:p,branch_id:'main',resource_id:'scene-harbor',generation:1});await scenePeer.packet('baseline');
    sessionOnlyPeer.send({type:'session_subscribe',session_id:bSession.id,after:0});await sessionOnlyPeer.packet('session_events');
    const before=ok(await request('GET',branch(p),B)),target=before.manifest.resources['scene-harbor'].objects[0];
    const drag={type:'drag_preview',generation:1,source_revision:before.head,object_id:target.id,expected_version:target.version,position:[1,2,3],rotation:[0,0,0],scale:[1,1,1]};scenePeer.send(drag);await scenePeer.packet('drag_preview');
    const preserveMark=scenePeer.messages.length,unrelated=ok(await request('POST',route(p)+'/access-requests',C,{request_id:uid('unrelated-request'),reason:'This request must not end another editor drag.'}),201).request;
    await scenePeer.packet('project_permissions',m=>m.project_id===p,preserveMark);
    assert.equal(scenePeer.messages.slice(preserveMark).some(m=>m.type==='drag_end'),false,'read-only access request must preserve active editor drag');
    ok(await request('POST',`${route(p)}/access-requests/${unrelated.id}/cancel`,C,{request_id:uid('unrelated-cancel'),expected_version:unrelated.version}));
    const version=(await view(A,p)).project.permission_version,mark=scenePeer.messages.length;
    const demoted=ok(await request('PATCH',`${route(p)}/members/${B.user.id}`,A,{request_id:uid('demote'),expected_version:version,role:'viewer'}));assert.equal(demoted.members.find(m=>m.id===B.user.id).role,'viewer');
    await scenePeer.packet('drag_end',()=>true,mark);await scenePeer.packet('project_permissions',m=>m.project?.role==='viewer',mark);
    assert.equal((await request('PATCH',`${route(p)}/members/${C.user.id}`,A,{request_id:uid('stale-role'),expected_version:version,role:'editor'})).status,409);
    for(const [path,input] of [[branch(p)+'/transactions',{transaction_id:uid('revoked-edit'),base_revision:before.head,ops:[]}],[branch(p)+'/sessions',{}],[`/sessions/${bSession.id}/attachments`,{}]])assert.equal((await request('POST',path,B,input)).status,403);
    assert.equal((await request('PATCH',`/sessions/${bSession.id}`,B,{draft:'forbidden after downgrade'})).status,403);
    assert.equal(ok(await request('GET',`/sessions/${bSession.id}`,B)).draft,'retain while read-only');
    const deniedMark=scenePeer.messages.length;scenePeer.send(drag);assert.equal((await scenePeer.packet('error',()=>true,deniedMark)).status,403);
    assert.equal((await request('POST','/invites/join',B,{request_id:uid('old-code'),code:originalInvite.code})).status,403);
    const sessionMark=sessionOnlyPeer.messages.length;ok(await request('PATCH',`${route(p)}/members/${B.user.id}`,A,{request_id:uid('remove'),role:null}));
    await sessionOnlyPeer.packet('session_access_revoked',m=>m.session_id===bSession.id,sessionMark);await sessionOnlyPeer.packet('project_permissions',m=>m.project?.role==='player',sessionMark);
    for(const sid of [privateSession.id,sharedSession.id,bSession.id])assert.equal((await request('GET',`/sessions/${sid}`,B)).status,403);
    assert.deepEqual(ok(await request('GET',branch(p)+'/sessions',B)).sessions,[]);
    // Exact old approval may return its historical receipt, but must not grant again.
    assert.equal(ok(await request('POST',`${route(p)}/access-requests/${pending.id}/decision`,A,decisionInput)).replayed,true);assert.equal((await view(B,p)).project.role,'player');
    assert.equal(ok(await request('GET',branch(p),A)).head,before.head);
    return {downgrade_stops_writes:true,drag_cleared:true,session_only_subscription_revoked:true,old_approval_cannot_regrant:true,old_invitation_rejected:true};
  });

  await check('rejection_cancel_reapply_and_competing_decisions',async()=>{
    const asked=ok(await request('POST',route(p)+'/access-requests',B,{request_id:uid('again'),reason:'Second request'}),201).request;
    ok(await request('POST',`${route(p)}/access-requests/${asked.id}/decision`,A,{request_id:uid('reject'),expected_version:asked.version,decision:'reject',note:'Please use read-only for now.'}));assert.equal((await view(B,p)).project.role,'player');assert.equal((await view(B,p)).my_request.status,'rejected');assert.ok((await inbox(B)).items.some(item=>item.access_request_id===asked.id&&item.kind==='notice'));
    const cancelled=ok(await request('POST',route(p)+'/access-requests',B,{request_id:uid('cancel-later'),reason:'Withdraw this'}),201).request;
    assert.equal((await request('POST',`${route(p)}/access-requests/${cancelled.id}/cancel`,C,{request_id:uid('foreign-cancel'),expected_version:1})).status,403);
    ok(await request('POST',`${route(p)}/access-requests/${cancelled.id}/cancel`,B,{request_id:uid('cancel'),expected_version:cancelled.version}));assert.equal((await view(B,p)).my_request.status,'cancelled');
    const final=ok(await request('POST',route(p)+'/access-requests',B,{request_id:uid('compete'),reason:'Resolve once'}),201).request;
    const results=await Promise.all(['approve','reject'].map(decision=>request('POST',`${route(p)}/access-requests/${final.id}/decision`,A,{request_id:uid('race-'+decision),expected_version:final.version,decision})));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await view(A,p)).pending_count,0);
    const resolved=(await view(B,p)).my_request;assert.equal(resolved.version,2);assert.ok(['approved','rejected'].includes(resolved.status));
    return {rejected_request:asked.id,cancelled_request:cancelled.id,competing_statuses:results.map(r=>r.status),single_final_version:resolved.version};
  });

  await check('single_use_invite_revocation_and_role_monotonicity',async()=>{
    const invitation=ok(await request('POST',route(p)+'/invites',A,{request_id:uid('invite-c'),role:'viewer'}),201);
    assert.equal((await request('POST',`${route(p)}/invites/${invitation.id}/revoke`,C,{request_id:uid('bad-revoke')})).status,403);
    const joined=ok(await request('POST','/invites/join',C,{request_id:uid('join-c'),code:invitation.code}));assert.equal(joined.role,'viewer');
    assert.equal(ok(await request('POST','/invites/join',C,{request_id:uid('retry-new-id'),code:invitation.code})).role,'viewer');assert.equal((await request('POST','/invites/join',D,{request_id:uid('reuse-by-other'),code:invitation.code})).status,410);
    const unused=ok(await request('POST',route(p)+'/invites',A,{request_id:uid('unused'),role:'editor'}),201);ok(await request('POST',`${route(p)}/invites/${unused.id}/revoke`,A,{request_id:uid('revoke-unused')}));assert.equal((await request('POST','/invites/join',D,{request_id:uid('revoked-join'),code:unused.code})).status,404);
    const upgrade=ok(await request('POST',route(p)+'/invites',A,{request_id:uid('upgrade'),role:'editor'}),201);assert.equal(ok(await request('POST','/invites/join',C,{request_id:uid('upgrade-join'),code:upgrade.code})).role,'editor');
    const lower=ok(await request('POST',route(p)+'/invites',A,{request_id:uid('lower'),role:'viewer'}),201);assert.equal(ok(await request('POST','/invites/join',C,{request_id:uid('lower-attempt'),code:lower.code})).role,'editor');assert.equal((await request('POST','/invites/join',A,{request_id:uid('consumed-lower-attempt'),code:lower.code})).status,410);
    const ownerInvite=ok(await request('POST',route(p)+'/invites',A,{request_id:uid('owner-invite'),role:'viewer'}),201);assert.equal(ok(await request('POST','/invites/join',A,{request_id:uid('owner-attempt'),code:ownerInvite.code})).role,'owner');
    assert.equal((await request('POST',route(p)+'/invites',A,{request_id:uid('invalid-owner'),role:'owner'})).status,400);
    const catalog=(await view(A,p)).invites;assert.equal(catalog.find(i=>i.id===invitation.id).status,'used');assert.equal(catalog.find(i=>i.id===unused.id).status,'revoked');assert.equal(JSON.stringify(catalog).includes(invitation.code),false);
    assert.deepEqual((await view(C,p)).invites,[]);assert.equal((await request('GET',`/inbox/${decisionItem.id}`,C)).status,403);
    return {single_use:true,revocation:true,no_role_downgrade:true,invite_codes_not_in_listing:true};
  });

  await check('approval_ledger_and_private_state_survive_service_restart',async()=>{
    const prior=await view(A,p),bBefore=await view(B,p),cBefore=await view(C,p),beforeInbox=(await inbox(B)).items.filter(item=>item.source==='collaboration').map(item=>({id:item.id,status:item.status,version:item.version}));
    await stop();await start();
    assert.deepEqual(await view(A,p),prior);assert.deepEqual(await view(B,p),bBefore);assert.deepEqual(await view(C,p),cBefore);
    assert.deepEqual((await inbox(B)).items.filter(item=>item.source==='collaboration').map(item=>({id:item.id,status:item.status,version:item.version})),beforeInbox);
    assert.equal((await request('GET',`/sessions/${privateSession.id}`,C)).status,403);
    return {request_and_audit_persisted:true,inbox_not_duplicated:true,service_pids:report.service_pids};
  });

  if(process.env.WORLD_ATELIER_COLLAB_BROWSER_GATE==='1'){
    const browserProject=ok(await request('POST','/projects',A,{name:'Collaboration browser approval playground',template:'harbor'}),201),gate=resolve(evidence,'browser-complete.json');
    writeFileSync(resolve(evidence,'browser-setup.json'),JSON.stringify({origin,project_id:browserProject.project.id,project_name:browserProject.project.name,owner_credentials:A.credentials,gate},null,2)+'\n');
    console.log('COLLABORATION_BROWSER_READY '+JSON.stringify({origin,setup:resolve(evidence,'browser-setup.json'),gate}));
    for(let i=0;i<900&&!existsSync(gate);i++)await wait(1000);
    assert.ok(existsSync(gate),'Actual two-account browser verification was not supplied');report.browser=JSON.parse(readFileSync(gate,'utf8'));
    assert.equal(report.browser.passed,true);assert.equal(report.browser.origin,origin);assert.equal(report.browser.owner_and_applicant_isolated,true);assert.equal(report.browser.approval_without_reload,true);assert.equal(report.browser.actual_edit_confirmed,true);assert.equal(report.browser.revocation_without_reload,true);
    for(const screenshot of report.browser.screenshots??[])assert.ok(existsSync(screenshot));assert.ok(report.browser.screenshots?.length);
  }
  report.completed=true;
});

test('collaboration store: expired invites and durable failed-notification recovery',async t=>{
  const [{CreationStore},{CreationInbox},{CreationCollaboration}]=await Promise.all(['store','inbox','collaboration'].map(file=>import(resolve(root,`services/creation/${file}.mjs`))));
  const data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-collaboration-outbox-'))),file=resolve(data,'creation.sqlite');
  let store=new CreationStore(file);store.publicPlay=true;
  t.after(()=>{store.close();rmSync(data,{recursive:true,force:true});});
  const A=store.register({name:uid('outbox-owner'),password:uid('outbox-password')}).user,B=store.register({name:uid('outbox-applicant'),password:uid('outbox-password')}).user,C=store.register({name:uid('outbox-other'),password:uid('outbox-password')}).user;
  const p=store.createProject(A,{name:'Local durable notification fixture'},{entry_scene_id:'room',resources:{room:{id:'room',kind:'scene',name:'Room',objects:[]}}}).project.id;
  // Fault injection is limited to notification delivery. Real membership and
  // request transactions persist through the same production service classes.
  let inbox=new CreationInbox({store}),collaboration=new CreationCollaboration({store,inbox:{record(){throw new Error('independent transient inbox failure');}}});
  const input={request_id:uid('durable-request'),reason:'Recover this actual request after a delivery failure.'};
  const pending=collaboration.request(B,p,input).request;assert.equal(pending.status,'pending');assert.equal(store.list('creator_inbox_item').length,0);assert.ok(store.list('creator_collaboration_outbox').some(item=>!item.delivered_at));
  store.close();store=new CreationStore(file);store.publicPlay=true;inbox=new CreationInbox({store});collaboration=new CreationCollaboration({store,inbox});
  const notices=inbox.list(A).items.filter(item=>item.access_request_id===pending.id);assert.equal(notices.length,1);assert.equal(collaboration.request(B,p,input).replayed,true);collaboration.drain();assert.equal(inbox.list(A).items.length,1);
  const event=store.list('creator_collaboration_event').find(item=>item.request_id===pending.id),notice={event_id:uid('forgery'),dedupe_key:uid('forgery-dedupe'),source:'collaboration',kind:'notice',severity:'info',project_id:p,collaboration_id:event.id,title:'Forged private body',message:'Never broaden original recipients',recipient_user_ids:[C.id],actions:[{id:'collaboration',label:'View'}]};
  assert.throws(()=>inbox.record(notice),error=>error.status===403);
  const secret=store.createSession(A,p,'main',{title:'Private notification fixture',visibility:'private'});
  assert.throws(()=>inbox.record({...notice,event_id:uid('session-forgery'),recipient_user_ids:[A.id],session_id:secret.id}),error=>error.status===403);
  assert.throws(()=>inbox.record({...notice,event_id:uid('backend-forgery'),source:'backend',collaboration_id:undefined,recipient_user_ids:[B.id],actions:[]}),error=>[400,403].includes(error.status));
  collaboration.resolve(A,p,pending.id,{request_id:uid('durable-reject'),expected_version:1,decision:'reject',note:'Result must reach the still-public player.'});
  assert.equal(store.roleFor(B,store.get('creator_project',p)),'player');assert.equal(inbox.list(B).items.filter(item=>item.access_request_id===pending.id).length,1);assert.equal(inbox.get(A,notices[0].id).status,'resolved');
  const expired=collaboration.invite(A,p,{request_id:uid('expiry'),role:'editor'}),row=store.get('creator_invite',expired.id);row.expires_at=Date.now()-1;store.put('creator_invite',row);
  assert.throws(()=>collaboration.join(B,{request_id:uid('expired-join'),code:expired.code}),error=>error.status===404);assert.equal(collaboration.view(A,p).invites.find(item=>item.id===expired.id).status,'expired');assert.equal(store.roleFor(B,store.get('creator_project',p)),'player');
  // Millisecond timestamps alone cannot distinguish an old authorization from
  // an owner issuing a genuinely new invitation just after revocation.
  const originalNow=Date.now,fixedNow=originalNow();
  try{
    Date.now=()=>fixedNow;
    collaboration.member(A,p,B.id,{request_id:uid('same-ms-editor'),role:'editor'});
    const old=collaboration.invite(A,p,{request_id:uid('same-ms-old'),role:'editor'});
    collaboration.member(A,p,B.id,{request_id:uid('same-ms-viewer'),role:'viewer'});
    const fresh=collaboration.invite(A,p,{request_id:uid('same-ms-new'),role:'editor'});
    assert.equal(store.get('creator_invite',old.id).created_at,store.get('creator_invite',fresh.id).created_at);
    assert.throws(()=>collaboration.join(B,{request_id:uid('same-ms-denied'),code:old.code}),error=>error.status===403);
    assert.equal(collaboration.join(B,{request_id:uid('same-ms-allowed'),code:fresh.code}).role,'editor');
  }finally{Date.now=originalNow;}
});
