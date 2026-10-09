import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import {DatabaseSync} from 'node:sqlite';
import {CreationStore} from '../../services/creation/store.mjs';

// Independent HTTP / SQLite / WebSocket checks. Only the initial account and
// administrator binding are fixture setup; every governance change uses HTTP.
// This suite does not claim paid Agent execution or Godot gameplay coverage.
const root=process.env.WORLD_ATELIER_TEST_ROOT??resolve(import.meta.dirname,'../..');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),uid=prefix=>`${prefix}-${randomUUID()}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function availablePort(port){const server=createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});const chosen=server.address().port;await new Promise(ok=>server.close(ok));return chosen;}

test('administrator independent governance and confidentiality',{timeout:1000000},async t=>{
  const port=await availablePort(Number(process.env.WORLD_ATELIER_ADMIN_TEST_PORT??48921)),origin=`http://127.0.0.1:${port}`;
  const data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-admin-independent-'))),database=resolve(data,'creation/creation.sqlite');
  const evidence=resolve(root,'.local/creation-verification/admin-independent',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);mkdirSync(evidence,{recursive:true});
  const sources=['services/creation/admin.mjs','services/creation/admin-metrics.mjs','services/creation/store.mjs','services/creation/service.mjs','services/creation/assets.mjs','services/creation/realtime.mjs','services/preview/server.mjs','apps/creation-workspace/admin.html','apps/creation-workspace/admin.css','apps/creation-workspace/admin.js','apps/creation-workspace/admin-login.html','apps/creation-workspace/admin-login.js'].filter(f=>existsSync(resolve(root,f)));
  const report={scope:'real isolated HTTP / SQLite / WS; no paid Agent or Godot gameplay claim',origin,evidence,started_at:new Date().toISOString(),cases:[],source_hashes:Object.fromEntries(sources.map(file=>[file,hash(readFileSync(resolve(root,file)))])),completed:false};
  const ownerCredentials={name:uid('Independent owner'),password:uid('Password')};
  const fixture=new CreationStore(database);let A={...fixture.register(ownerCredentials),credentials:ownerCredentials};fixture.close();
  let child=null,log='';const peers=new Set();
  async function stop(){for(const peer of peers)peer.ws.terminate();peers.clear();if(child&&child.exitCode===null&&child.signalCode===null){const ended=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),12000);await ended;clearTimeout(timer);}await availablePort(port);}
  async function start(){
    const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_PUBLIC_PLAY:'1',WORLD_ATELIER_LAN:'0'};
    delete env.WORLD_ATELIER_ADMIN_USER_ID;delete env.WORLD_ATELIER_PREVIEW_HOST;
    child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});report.service_pids??=[];report.service_pids.push(child.pid);child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
    for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(log);try{const r=await fetch(origin+'/creation-api/health');if(r.ok){const h=await r.json();assert.equal(h.agent_ready,false);assert.equal(h.worlds_ready,false);return;}}catch{}await wait(30);}throw Error('Isolated service failed to start');
  }
  t.after(async()=>{await stop();report.finished_at=new Date().toISOString();report.source_changed_during_run=sources.filter(f=>report.source_hashes[f]!==hash(readFileSync(resolve(root,f))));rmSync(data,{recursive:true,force:true});report.temporary_data_removed=!existsSync(data);writeFileSync(resolve(evidence,'server.log'),log);writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('ADMIN_INDEPENDENT_REPORT '+resolve(evidence,'report.json'));});
  async function request(method,path,actor,input,extra={}){
    const response=await fetch(origin+path,{method,redirect:'manual',headers:{origin,'Content-Type':'application/json',...(actor?.token?{Authorization:'Bearer '+actor.token}:{}),...(actor?.cookie?{Cookie:actor.cookie}:{}),...extra.headers},...(input===undefined?{}:{body:Buffer.isBuffer(input)?input:JSON.stringify(input)})});
    const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
    return {status:response.status,value,headers:response.headers};
  }
  const api=(method,path,actor,input,extra)=>request(method,'/creation-api'+path,actor,input,extra);
  const ok=(r,status=200)=>{assert.equal(r.status,status,typeof r.value==='string'?r.value.slice(0,200):JSON.stringify(r.value));return r.value;};
  const register=async label=>{const credentials={name:uid(label),password:uid('Password')};return {...ok(await api('POST','/auth/register',null,{...credentials,is_admin:true,role:'admin',creation_allowed:true}),201),credentials};};
  const detail=async(type,id)=>(ok(await api('GET',`/admin/${type}/${id}`,A))).item;
  const patch=async(type,id,input,version)=>api('PATCH',`/admin/${type}/${id}`,A,{request_id:uid('govern'),expected_version:version??(await detail(type,id)).version,reason:'Independent verification',...input});
  const project=async(name='Independent governance game',actor=A)=>ok(await api('POST','/projects',actor,{name,template:'harbor'}),201);
  const route=p=>`/projects/${p}/branches/main`;
  async function connect(actor,p){const ws=new WebSocket(origin.replace('http:','ws:')+'/ws/creation',{origin}),peer={ws,messages:[],closed:false};peers.add(peer);ws.on('message',b=>peer.messages.push(JSON.parse(b.toString())));ws.on('error',()=>{});ws.on('close',()=>peer.closed=true);await new Promise((ok,no)=>{ws.once('open',ok);ws.once('error',no);});peer.send=m=>ws.send(JSON.stringify(m));peer.packet=async(type)=>{for(let i=0;i<150;i++){const m=peer.messages.find(m=>m.type===type);if(m)return m;await wait(20);}throw Error('WebSocket '+type+' missing');};peer.send({type:'auth',token:actor.token});await peer.packet('authenticated');if(p){peer.send({type:'subscribe',project_id:p,branch_id:'main',resource_id:'scene-harbor',generation:1});await peer.packet('baseline');}return peer;}
  async function closed(peer){for(let i=0;i<100&&!peer.closed;i++)await wait(20);assert.equal(peer.closed,true,'Existing authenticated socket must close');}
  async function check(name,fn){await t.test(name,async()=>{const row={name,status:'running'};report.cases.push(row);try{row.observations=await fn();row.status='passed';}catch(error){row.status='failed';row.error=error.message;throw error;}});}
  await start();
  await check('unconfigured service grants nobody admin access',async()=>{assert.equal(ok(await api('GET','/bootstrap',A)).can_admin,false);assert.equal((await api('GET','/admin/session',A)).status,403);assert.equal((await api('POST','/admin/access',A,{})).status,403);});
  await stop();const setup=new CreationStore(database);setup.put('creator_admin_settings',{id:'singleton',owner_user_id:A.user.id});setup.close();await start();
  const B=await register('Registered guest'),C=await register('Independent collaborator');
  await check('sole owner and admin API authentication cannot be spoofed',async()=>{
    assert.equal(ok(await api('GET','/bootstrap',A)).can_admin,true);for(const actor of [B,C])assert.equal(ok(await api('GET','/bootstrap',actor)).can_admin,false);
    for(const endpoint of ['session','overview','metrics','users','projects','assets','jobs','audit','worlds']){assert.equal((await api('GET','/admin/'+endpoint,null)).status,401);assert.equal((await api('GET','/admin/'+endpoint,B)).status,403);ok(await api('GET','/admin/'+endpoint,A));}
    assert.equal((await api('PATCH','/admin/users/'+A.user.id,B,{request_id:uid('spoof'),expected_version:1,reason:'no',action:'status',value:'disabled'})).status,403);
    for(const path of ['/admin/missing','/admin/__proto__','/admin/constructor'])assert.equal((await api('GET',path,B)).status,403);
    for(const path of ['/creation-api/%61dmin/users','/creation-api/admin%2fusers','/creation-api/admin/users/../../admin/users'])assert.notEqual((await request('GET',path,B)).status,200);
  });
  await check('cookie access is private, same origin and bound to original login',async()=>{
    assert.equal((await api('POST','/admin/access',B,{})).status,403);
    const response=await api('POST','/admin/access',A,{});ok(response);const set=response.headers.get('set-cookie');assert.match(set,/HttpOnly/);assert.match(set,/SameSite=Strict/);const cookie={cookie:set.split(';')[0]};ok(await api('GET','/admin/session',cookie));
    assert.equal((await api('PATCH','/admin/users/'+B.user.id,cookie,{request_id:uid('csrf'),expected_version:1,reason:'bad origin',action:'status',value:'disabled'},{headers:{origin:'http://evil.invalid'}})).status,403);
    const before=await detail('users',B.user.id);assert.equal(before.status,'active');
    ok(await api('POST','/auth/logout',A,{}));assert.equal((await api('GET','/admin/session',cookie)).status,401);assert.equal((await api('GET','/admin/session',A)).status,401);
    A={...ok(await api('POST','/auth/login',null,A.credentials)),credentials:A.credentials};const next=await api('POST','/admin/access',A,{});ok(next);const nextCookie={cookie:next.headers.get('set-cookie').split(';')[0]};ok(await api('POST','/admin/logout',nextCookie,{}));assert.equal((await api('GET','/admin/session',nextCookie)).status,401);ok(await api('GET','/admin/session',A));
  });
  await check('owner protection, version conflicts, request identity and audit',async()=>{
    for(const input of [{action:'status',value:'disabled'},{action:'creation',value:false},{action:'revoke_sessions'}])assert.equal((await patch('users',A.user.id,input)).status,409);
    const before=await detail('users',B.user.id),input={request_id:uid('idempotent'),expected_version:before.version,reason:'Grant temporary creation',action:'creation',value:true};const result=ok(await api('PATCH','/admin/users/'+B.user.id,A,input));
    assert.equal(ok(await api('PATCH','/admin/users/'+B.user.id,A,input)).replayed,true);assert.equal((await api('PATCH','/admin/users/'+B.user.id,A,{...input,value:false})).status,409);assert.equal((await patch('users',B.user.id,{action:'creation',value:false},before.version)).status,409);
    assert.equal((await patch('users',B.user.id,{action:'creation',value:false,owner_user_id:B.user.id})).status,400);assert.equal((await patch('users',B.user.id,{action:'creation',value:false,reason:''})).status,400);
    const audit=ok(await api('GET','/admin/audit?limit=100',A)).items.filter(x=>x.request_id===input.request_id);assert.equal(audit.length,1);assert.equal(audit[0].actor_id,A.user.id);assert.equal(audit[0].before.creation_allowed,null);assert.equal(audit[0].after.creation_allowed,true);assert.equal(audit[0].id,result.audit_id);
    const version=(await detail('users',B.user.id)).version;const race=await Promise.all([false,null].map(value=>patch('users',B.user.id,{action:'creation',value},version)));assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
    ok(await patch('users',B.user.id,{action:'creation',value:true}));const own=await project('Guest owned game',B);assert.equal(own.project.role,'owner');assert.equal((await api('GET','/admin/overview',B)).status,403);
    ok(await patch('users',B.user.id,{action:'creation',value:false}));assert.equal(ok(await api('GET','/bootstrap',B)).can_create_project,false);assert.equal((await api('POST','/projects',B,{name:'Denied creation',template:'empty'})).status,403);ok(await api('GET',route(own.project.id),B));ok(await patch('users',B.user.id,{action:'creation',value:true}));return {audit_id:result.audit_id,concurrent_statuses:race.map(x=>x.status)};
  });
  await check('account disable revokes sockets tokens and existing asset capabilities',async()=>{
    const made=await project('Disabled account scope'),p=made.project.id;ok(await patch('projects',p,{action:'member',user_id:C.user.id,value:'editor'}));
    const bytes=Buffer.from('extends Node\n# '+uid('private-script')+'\n');const asset=ok(await api('POST',`/projects/${p}/assets`,C,bytes,{headers:{'content-type':'application/octet-stream','x-asset-name':'independent.gd'}}),201);
    const preview=ok(await api('GET',route(p)+'/runtime-scene?resource_id=scene-harbor',C));const cap=new URL(preview.objects.find(x=>x.model_url)?.model_url,origin).searchParams.get('cap');assert.ok(cap);
    const assetUrl=asset.url+'?cap='+encodeURIComponent(cap);ok(await request('GET',assetUrl));const peer=await connect(C,p);
    const disabled=ok(await patch('users',C.user.id,{action:'status',value:'disabled'}));await closed(peer);assert.equal((await api('GET','/bootstrap',C)).status,401);assert.equal((await api('POST','/auth/login',null,C.credentials)).status,403);assert.equal((await request('GET',assetUrl)).status,403);
    ok(await patch('users',C.user.id,{action:'status',value:'active'}));assert.equal((await api('GET','/bootstrap',C)).status,401);C.token=ok(await api('POST','/auth/login',null,C.credentials)).token;assert.equal(ok(await api('GET',route(p),C)).head,made.branch.head);assert.equal((await request('GET',assetUrl)).status,403);
    const refreshed=ok(await api('GET',route(p)+'/runtime-scene?resource_id=scene-harbor',C)),nextCap=new URL(refreshed.objects.find(x=>x.model_url)?.model_url,origin).searchParams.get('cap');assert.notEqual(nextCap,cap);ok(await request('GET',asset.url+'?cap='+nextCap));
    const again=await connect(C,p);ok(await patch('users',C.user.id,{action:'revoke_sessions'}));await closed(again);assert.equal((await api('GET','/bootstrap',C)).status,401);C.token=ok(await api('POST','/auth/login',null,C.credentials)).token;return {disabled_version:disabled.version,old_capability_stays_revoked:true};
  });
  await check('archived projects deny direct access edits invites and retain sources',async()=>{
    const made=await project('Archived project scope'),p=made.project.id;const invite=ok(await api('POST',`/projects/${p}/invites`,A,{request_id:uid('invite'),role:'editor'}),201);const peer=await connect(B,p);
    ok(await patch('projects',p,{action:'status',value:'archived'}));await closed(peer);for(const actor of [A,B]){assert.equal(ok(await api('GET','/bootstrap',actor)).projects.some(x=>x.id===p),false);assert.equal((await api('GET',route(p),actor)).status,403);assert.equal((await api('POST',route(p)+'/sessions',actor,{})).status,403);}
    const rejected=await api('POST','/invites/join',C,{request_id:uid('archived-invite'),code:invite.code});assert.ok([403,404,409,410].includes(rejected.status),'Archived invite must reject without adding members');assert.equal((await detail('projects',p)).members.some(m=>m.id===C.user.id),false);
    assert.equal((await detail('projects',p)).branches[0].source_head,made.branch.head);ok(await patch('projects',p,{action:'status',value:'active'}));assert.equal(ok(await api('GET',route(p),A)).head,made.branch.head);assert.equal(ok(await api('GET','/bootstrap',B)).projects.some(x=>x.id===p),true);return {source_head:made.branch.head};
  });
  await check('per game public play and member authority applies immediately',async()=>{
    const made=await project('Public play policy scope'),p=made.project.id;ok(await api('GET',route(p),B));ok(await patch('projects',p,{action:'public_play',value:false}));assert.equal((await api('GET',route(p),B)).status,403);
    ok(await patch('projects',p,{action:'member',user_id:B.user.id,value:'editor'}));const branch=ok(await api('GET',route(p),B)),object=branch.manifest.resources['scene-harbor'].objects[0];const transaction={transaction_id:uid('real-edit'),base_revision:branch.head,ops:[{type:'patch_object',resource_id:'scene-harbor',object_id:object.id,expected_version:object.version,patch:{name:'Independent edited object'}}]};ok(await api('POST',route(p)+'/transactions',B,transaction));
    ok(await patch('projects',p,{action:'member',user_id:B.user.id,value:'viewer'}));assert.equal((await api('POST',route(p)+'/transactions',B,transaction)).status,403);ok(await patch('projects',p,{action:'member',user_id:B.user.id,value:null}));assert.equal((await api('GET',route(p),B)).status,403);
    assert.equal((await patch('projects',p,{action:'member',user_id:A.user.id,value:null})).status,409);ok(await patch('projects',p,{action:'public_play',value:null}));assert.equal(ok(await api('GET','/bootstrap',B)).projects.find(x=>x.id===p).role,'player');
  });
  await check('quarantine denies hashed aliases encoded downloads and repeated uploads',async()=>{
    const made=await project('Asset quarantine scope'),p=made.project.id,builtin=JSON.parse(readFileSync(resolve(root,'content/model-preview/manifest.json'))).assets[0];const bytes=readFileSync(resolve(root,'content/model-preview',builtin.file));
    // Also populate the historical preview upload path, ensuring fallback cannot bypass governance.
    ok(await request('POST','/preview-api/assets',A,bytes,{headers:{'Content-Type':'application/octet-stream','x-model-name':'builtin.glb'}}),201);
    ok(await patch('assets',builtin.sha256,{status:'quarantined'}));
    const paths=[`/preview-assets/${builtin.sha256}.glb`,`/preview-assets/${builtin.file}`,`/preview-assets/${builtin.sha256}%2eglb`,`/preview-assets/%${builtin.file.charCodeAt(0).toString(16)}${builtin.file.slice(1)}`,`/preview%2dassets/${builtin.file}`];
    const results=[];for(const path of paths){for(const method of ['GET','HEAD']){const response=await request(method,path);results.push({method,path,status:response.status});assert.equal(response.status,403,'Quarantined download '+method+' '+path);}}
    assert.equal((await api('POST',`/projects/${p}/assets`,A,bytes,{headers:{'Content-Type':'application/octet-stream','x-asset-name':'reupload.glb'}})).status,403);
    assert.equal((await request('POST','/preview-api/assets',A,bytes,{headers:{'Content-Type':'application/octet-stream','x-model-name':'reupload.glb'}})).status,403);
    const b=ok(await api('GET',route(p),A)),o=b.manifest.resources['scene-harbor'].objects[0];assert.equal((await api('POST',route(p)+'/transactions',A,{transaction_id:uid('isolated-ref'),base_revision:b.head,ops:[{type:'patch_object',resource_id:'scene-harbor',object_id:o.id,expected_version:o.version,patch:{model_url:`/preview-assets/${builtin.sha256}.glb`,model_hash:builtin.sha256}}]})).status,403);
    await stop();await start();assert.equal((await detail('assets',builtin.sha256)).status,'quarantined');assert.equal((await request('GET',`/preview-assets/${builtin.file}`)).status,403);ok(await patch('assets',builtin.sha256,{status:'active'}));ok(await request('GET',`/preview-assets/${builtin.sha256}.glb`));return {downloads:results,preserved_across_restart:true};
  });
  await check('build browser capability records are permanently revoked by disable and logout reset',async()=>{
    const actor=await register('Build capability account');
    // Explicit authorization-record fixtures only: no build-completed record,
    // exported program, runtime acknowledgement or playable result is fabricated.
    const grantIds=[hash(uid('short-lived-cap')),hash(uid('short-lived-cap'))],control=hash(uid('other-user-cap'));
    const count=id=>{const db=new DatabaseSync(database,{readOnly:true});try{return db.prepare("SELECT COUNT(*) AS total FROM documents WHERE kind='creator_build_access' AND id=?").get(id).total;}finally{db.close();}};
    async function prepareGrants(){
      await stop();const store=new CreationStore(database);
      for(const id of grantIds)store.put('creator_build_access',{id,job_id:'build-'+randomUUID(),user_id:actor.user.id,expires_at:Date.now()+60000});
      store.put('creator_build_access',{id:control,job_id:'build-'+randomUUID(),user_id:A.user.id,expires_at:Date.now()+60000});store.close();await start();
      assert.deepEqual(grantIds.map(count),[1,1]);
    }
    await prepareGrants();ok(await patch('users',actor.user.id,{action:'status',value:'disabled'}));assert.deepEqual(grantIds.map(count),[0,0]);assert.equal(count(control),1);
    ok(await patch('users',actor.user.id,{action:'status',value:'active'}));assert.deepEqual(grantIds.map(count),[0,0]);assert.equal((await api('GET','/bootstrap',actor)).status,401);
    await prepareGrants();ok(await patch('users',actor.user.id,{action:'revoke_sessions'}));assert.deepEqual(grantIds.map(count),[0,0]);assert.equal(count(control),1);
    await stop();await start();assert.deepEqual(grantIds.map(count),[0,0]);assert.equal(count(control),1);
    return {scope:'explicit short-lived capability record fixtures + real admin HTTP + read-only SQLite; no real export/gameplay claim',disabled_removes_grants:true,restore_does_not_revive:true,revoke_all_removes_grants:true,unrelated_user_preserved:true,durable_after_restart:true};
  });
  await check('metrics are measured and admin projections do not expose secrets',async()=>{
    let metrics;for(let i=0;i<90;i++){metrics=ok(await api('GET','/admin/metrics?range=15m',A));if(metrics.latest&&metrics.processes.status!=='pending')break;await wait(100);}
    assert.ok(metrics.latest);assert.ok(metrics.latest.at>=Date.now()-15000);assert.ok(metrics.latest.window_ms>0);assert.ok(metrics.latest.process_memory_bytes>0);assert.ok(metrics.latest.host_cpu_percent>=0&&metrics.latest.host_cpu_percent<=100);assert.ok(metrics.latest.response_bytes_per_second>0,'Actual JSON/body traffic must be counted');assert.ok(metrics.samples.length);assert.equal(metrics.service.pid,child.pid);assert.ok(metrics.storage.sampled_at);assert.ok(['ready','partial'].includes(metrics.storage.status));
    const view=JSON.stringify([metrics,ok(await api('GET','/admin/users?limit=100',A)),ok(await api('GET','/admin/projects',A)),ok(await api('GET','/admin/jobs',A)),ok(await api('GET','/admin/audit?limit=100',A))]);for(const sentinel of [A.token,B.token,C.token,A.credentials.password,B.credentials.password,C.credentials.password,'"salt":','"password":','"login_id":','"command":','"argv":'])assert.equal(view.includes(sentinel),false,'Sensitive field exposed');
    const before=metrics.samples.map(x=>x.at);await stop();await start();const restarted=ok(await api('GET','/admin/metrics?range=24h',A));assert.ok(restarted.samples.some(x=>before.includes(x.at)),'Durable metrics history missing');assert.equal(ok(await api('GET','/bootstrap',A)).can_admin,true);return {samples:before.length,durable_history:true};
  });
  await check('admin document and resources are gated including encoded paths',async()=>{
    for(const path of ['/admin','/admin/','/admin.html','/%61dmin','/admin-assets/admin.js','/admin-assets/admin.css','/%61dmin-assets/admin.js']){const r=await request('GET',path,B);assert.notEqual(r.status,200,'Non-admin can load '+path);}
    const access=await api('POST','/admin/access',A,{});ok(access);const cookie={cookie:access.headers.get('set-cookie').split(';')[0]};const page=await request('GET','/admin',cookie);ok(page);assert.match(page.value,/html/i);assert.match(page.headers.get('cache-control'),/no-store/);
    for(const path of ['/admin-assets/admin.js','/admin-assets/admin.css'])ok(await request('GET',path,cookie));
    const wrong={cookie:cookie.cookie,token:B.token};assert.equal((await api('GET','/admin/session',wrong)).status,403,'Explicit wrong bearer cannot use another cookie for API authorization');
  });
  await check('runtime absolute paths and ambiguous admin routes cannot bypass boundaries',async()=>{
    const document=resolve(root,'apps/creation-workspace/admin.html');
    for(const path of ['/preview-runtime/'+document,'/preview-runtime/%2F'+document.slice(1),'/preview-runtime/%252F'+document.slice(1)]){
      for(const actor of [null,B])for(const method of ['GET','HEAD'])assert.equal((await request(method,path,actor)).status,400,'Absolute filesystem path was accepted: '+path);
    }
    const before=await detail('users',B.user.id),input={request_id:uid('extra-route'),expected_version:before.version,reason:'Ambiguous route must not mutate',action:'status',value:'disabled'};
    for(const path of [`/admin/users/${B.user.id}/extra`,`/admin/users/${B.user.id}%2Fextra`,`/admin/users%2F${B.user.id}`]){
      assert.equal((await api('GET',path,A)).status,404);assert.equal((await api('PATCH',path,A,input)).status,404);
    }
    assert.equal((await detail('users',B.user.id)).version,before.version);assert.equal((await detail('users',B.user.id)).status,'active');
    return {absolute_paths_denied:true,ambiguous_route_mutations_denied:true};
  });
  report.completed=report.cases.every(x=>x.status==='passed');
  if(process.env.WORLD_ATELIER_ADMIN_BROWSER_GATE==='1'&&report.completed){
    const gate=resolve(evidence,'browser-complete.json'),setupPath=resolve(evidence,'browser-setup.json');
    writeFileSync(setupPath,JSON.stringify({origin,owner_credentials:A.credentials,ordinary_credentials:B.credentials,gate,service_pid:child.pid},null,2)+'\n',{mode:0o600});
    writeFileSync(resolve(evidence,'report.json'),JSON.stringify({...report,browser_service_held:true},null,2)+'\n');
    console.log('ADMIN_BROWSER_READY '+JSON.stringify({origin,setup:setupPath,gate}));
    for(let i=0;i<900&&!existsSync(gate);i++)await wait(1000);
    assert.ok(existsSync(gate),'Browser handoff was not released');
    report.browser_handoff=JSON.parse(readFileSync(gate,'utf8'));
    rmSync(setupPath,{force:true});
  }
});
