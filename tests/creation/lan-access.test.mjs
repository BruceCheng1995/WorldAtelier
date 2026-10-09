/**
 * Independent LAN HTTP contract. Real preview service, SQLite, WebSocket and
 * Godot assets; no production state or paid Agent. Optional browser gate keeps
 * this same isolated service alive for an actual Chrome registration/Play run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir,networkInterfaces} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {WebSocket} from 'ws';

const root=resolve(import.meta.dirname,'../..'),port=48921;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const uid=prefix=>`${prefix}-${randomUUID()}`;
function lanAddress(){
  if(process.env.WORLD_ATELIER_TEST_LAN_ADDRESS)return process.env.WORLD_ATELIER_TEST_LAN_ADDRESS;
  for(const [name,items] of Object.entries(networkInterfaces()))if(!/^(utun|lo|bridge)/.test(name)){
    const match=items.find(item=>!item.internal&&item.family==='IPv4'&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address));if(match)return match.address;
  }
  throw Error('Independent LAN test requires an actual private IPv4 interface');
}
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});await new Promise(resolve=>server.close(resolve));}

test('LAN HTTP permits open registration, preserves same-origin boundaries and serves playable runtime',{timeout:720000},async t=>{
  await freePort();
  const address=lanAddress(),origin=`http://${address}:${port}`,data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-lan-access-')));
  const evidence=resolve(root,'.local/creation-verification/lan-access',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);mkdirSync(evidence,{recursive:true});
  const report={started_at:new Date().toISOString(),origin,data,evidence,scope:'actual non-loopback HTTP/SQLite/WebSocket; actual browser only when browser gate evidence is supplied; no production state or paid Agent',checks:[],completed:false};
  const sources=['services/preview/server.mjs','services/preview/network.mjs','services/creation/service.mjs','services/creation/store.mjs','services/creation/worlds.mjs','services/creation/realtime.mjs','apps/creation-workspace/client-platform.js','apps/creation-workspace/preview-bridge.js','apps/creation-workspace/workspace.js','tests/creation/lan-access.test.mjs'];
  report.source_hashes=Object.fromEntries(sources.map(file=>[file,hash(readFileSync(resolve(root,file)))]));
  const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_LAN:'1',WORLD_ATELIER_PUBLIC_PLAY:'1'};
  delete env.WORLD_ATELIER_DISABLE_WORLDS;delete env.WORLD_ATELIER_PREVIEW_HOST;
  const child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});report.service_pid=child.pid;let log='';
  child.stdout.on('data',bytes=>log+=bytes);child.stderr.on('data',bytes=>log+=bytes);const sockets=new Set();
  t.after(async()=>{
    for(const ws of sockets)ws.terminate();
    if(child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),12000);await closed;clearTimeout(timer);}
    await freePort();report.finished_at=new Date().toISOString();
    report.source_hashes_after=Object.fromEntries(sources.map(file=>[file,hash(readFileSync(resolve(root,file)))]));
    report.source_changed_during_run=sources.filter(file=>report.source_hashes[file]!==report.source_hashes_after[file]);
    writeFileSync(resolve(evidence,'server.log'),log);writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
    rmSync(data,{recursive:true,force:true});console.log('LAN_REPORT '+resolve(evidence,'report.json'));
  });
  let health;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw Error(log);
    try{const response=await fetch(origin+'/creation-api/health');if(response.ok){health=await response.json();break;}}catch{}
    await wait(50);
  }
  assert.equal(health?.service,'creation',log||'LAN service did not become reachable');assert.equal(health.agent_ready,false);assert.equal(health.worlds_ready,true);report.health=health;
  const networkHealth=await (await fetch(origin+'/preview-api/health')).json();assert.equal(networkHealth.lan_enabled,true);assert.equal(networkHealth.public_play,true);assert.equal(networkHealth.registration_open,true);assert.equal(networkHealth.listen_host,'0.0.0.0');report.network=networkHealth;
  const page=await fetch(origin+'/creation-workspace.html');assert.equal(page.status,200);assert.match(await page.text(),/id="authForm"/);
  // Native fetch normalizes Host back to the URL; raw HTTP is necessary to
  // actually put an unrelated authority on the wire for this negative case.
  const forgedHost=await new Promise((resolve,reject)=>{const request=httpRequest(origin+'/creation-api/health',{headers:{Host:`attacker.invalid:${port}`}},response=>{response.resume();response.once('end',()=>resolve({status:response.statusCode}));});request.once('error',reject);request.end();});assert.equal(forgedHost.status,403);
  const request=async(method,path,token,input,requestOrigin=origin)=>{
    const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin:requestOrigin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,value:await response.json()};
  };
  const authInput={name:uid('LAN HTTP owner'),password:uid('LAN-test-only')};
  const registered=await request('POST','/auth/register',null,authInput);assert.equal(registered.status,201,JSON.stringify(registered.value));
  const logged=await request('POST','/auth/login',null,authInput);assert.equal(logged.status,200);assert.equal(logged.value.user.id,registered.value.user.id);const auth=logged.value;
  const denied=await request('POST','/auth/register',null,{name:uid('cross-origin-rejected'),password:uid('not-created')},'http://other.invalid');assert.equal(denied.status,403);
  report.checks.push({case:'actual_lan_registration_and_login',user_id:auth.user.id,registration:registered.status,login:logged.status,cross_origin_write:denied.status});
  const made=await request('POST','/projects',auth.token,{name:'LAN independent browser playground',template:'harbor'});assert.equal(made.status,201,JSON.stringify(made.value));const project=made.value.project.id;
  const privateSession=await request('POST',`/projects/${project}/branches/main/sessions`,auth.token,{title:'Private owner conversation never shown publicly',visibility:'private'});assert.equal(privateSession.status,201);
  const sharedSession=await request('POST',`/projects/${project}/branches/main/sessions`,auth.token,{title:'Shared collaborator conversation never shown publicly',visibility:'shared'});assert.equal(sharedSession.status,201);
  const sharedId=sharedSession.value.id??sharedSession.value.session?.id;assert.ok(sharedId);
  const shared=await request('PATCH',`/sessions/${sharedId}`,auth.token,{visibility:'shared'});assert.equal(shared.status,200);assert.equal(shared.value.visibility,'shared');
  const readerInput={name:uid('LAN uninvited reader'),password:uid('LAN-test-only')},readerResponse=await request('POST','/auth/register',null,readerInput);assert.equal(readerResponse.status,201);const reader=readerResponse.value;
  const catalog=await request('GET','/bootstrap',reader.token);assert.equal(catalog.status,200);assert.equal(catalog.value.can_create_project,false);const visible=catalog.value.projects.find(game=>game.id===project);assert.ok(visible,'new uninvited account immediately sees existing games');assert.equal(visible.role,'player');
  assert.equal((await request('POST','/projects',reader.token,{name:'Public account cannot bypass creator authorization',template:'empty'})).status,403);
  const scene=await request('GET',`/projects/${project}/branches/main/runtime-scene?resource_id=scene-harbor`,reader.token);assert.equal(scene.status,200);
  const object=scene.value.objects.find(object=>object.model_url);assert.ok(object);
  const modelURL=new URL(object.model_url,origin);assert.equal(modelURL.origin,origin);const modelResponse=await fetch(modelURL);assert.equal(modelResponse.status,200);
  assert.equal(hash(Buffer.from(await modelResponse.arrayBuffer())),object.model_hash);
  const unauthorizedPatch=await request('POST',`/projects/${project}/branches/main/transactions`,reader.token,{transaction_id:uid('must-not-write'),base_revision:made.value.branch.head,ops:[{type:'patch_object',resource_id:'scene-harbor',object_id:object.id,expected_version:object.version,patch:{name:'FORBIDDEN PUBLIC EDIT'}}]});assert.equal(unauthorizedPatch.status,403);
  for(const action of ['validate','publish'])assert.equal((await request('POST',`/projects/${project}/branches/main/${action}`,reader.token,{revision:made.value.branch.head,resource_id:'scene-harbor'})).status,403);
  const privateId=privateSession.value.id??privateSession.value.session?.id;assert.ok(privateId);
  const visibleSessions=await request('GET',`/projects/${project}/branches/main/sessions`,reader.token);assert.equal(visibleSessions.status,200);assert.equal(JSON.stringify(visibleSessions.value).includes(privateId),false);
  assert.equal(JSON.stringify(visibleSessions.value).includes(sharedId),false);
  assert.equal((await request('GET',`/sessions/${privateId}`,reader.token)).status,403);
  assert.equal((await request('GET',`/sessions/${sharedId}`,reader.token)).status,403);
  assert.equal((await request('POST',`/projects/${project}/branches/main/sessions`,reader.token,{title:'Public player cannot start an Agent'})).status,403);
  const unchanged=await request('GET',`/projects/${project}/branches/main`,auth.token);assert.equal(unchanged.status,200);assert.equal(unchanged.value.head,made.value.branch.head);
  report.checks.push({case:'uninvited_public_play_scope',user_id:reader.user.id,role:visible.role,existing_game_visible:true,project_creation_denied:true,source_edit_denied:true,explicit_validation_publish_denied:true,private_session_hidden:true,private_session_direct_read_denied:true,shared_session_hidden:true,shared_session_direct_read_denied:true,session_creation_denied:true,source_unchanged:true});
  const manifestResponse=await fetch(origin+'/preview-runtime/manifest.json');assert.equal(manifestResponse.status,200);const runtime=await manifestResponse.json();assert.equal(runtime.single_threaded,true);
  for(const name of ['index.html','index.js','index.wasm','index.pck']){
    const entry=runtime.files.find(file=>file.path===name);assert.ok(entry);
    const response=await fetch(`${origin}/preview-builds/${runtime.build_id}/${name}`);assert.equal(response.status,200);assert.equal(hash(Buffer.from(await response.arrayBuffer())),entry.sha256);
  }
  report.runtime_build_id=runtime.build_id;report.project_id=project;report.source_revision=made.value.branch.head;
  report.checks.push({case:'same_origin_model_and_single_thread_runtime',model_hash:object.model_hash,runtime_build_id:runtime.build_id,asset_host:modelURL.host});
  const ws=new WebSocket(origin.replace(/^http/,'ws')+'/ws/creation',{origin}),messages=[];sockets.add(ws);ws.on('message',bytes=>messages.push(JSON.parse(bytes.toString())));ws.on('error',()=>{});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});ws.send(JSON.stringify({type:'auth',token:reader.token}));
  for(let i=0;i<100&&!messages.some(message=>message.type==='authenticated');i++)await wait(10);
  assert.equal(messages.find(message=>message.type==='authenticated')?.user.id,reader.user.id);ws.close();
  let foreignOpened=false;const foreign=new WebSocket(origin.replace(/^http/,'ws')+'/ws/creation',{origin:'http://other.invalid'});sockets.add(foreign);foreign.on('open',()=>{foreignOpened=true;foreign.close();});foreign.on('error',()=>{});await new Promise(resolve=>foreign.once('close',resolve));assert.equal(foreignOpened,false);
  let forgedOpened=false;const forged=new WebSocket(origin.replace(/^http/,'ws')+'/ws/creation',{origin:`http://attacker.invalid:${port}`,headers:{host:`attacker.invalid:${port}`}});sockets.add(forged);forged.on('open',()=>{forgedOpened=true;forged.close();});forged.on('error',()=>{});await new Promise(resolve=>forged.once('close',resolve));assert.equal(forgedOpened,false);
  report.checks.push({case:'lan_websocket_same_origin_authentication',authenticated:true,foreign_origin_opened:false,forged_host_http_status:forgedHost.status,forged_host_websocket_opened:false});
  if(process.env.WORLD_ATELIER_LAN_BROWSER_GATE==='1'){
    const gate=resolve(evidence,'browser-complete.json');
    writeFileSync(resolve(evidence,'browser-setup.json'),JSON.stringify({origin,project_id:project,project_name:made.value.project.name,invitations_created:0,cold_world:true,gate},null,2)+'\n');
    console.log('LAN_BROWSER_READY '+JSON.stringify({origin,setup:resolve(evidence,'browser-setup.json'),gate}));
    for(let i=0;i<600&&!existsSync(gate);i++)await wait(1000);
    assert.ok(existsSync(gate),'Actual browser verification was not completed');const browser=JSON.parse(readFileSync(gate,'utf8'));report.browser=browser;
    assert.equal(browser.passed,true);assert.equal(browser.origin,origin);assert.equal(browser.secure_context,false);assert.equal(browser.registered,true);assert.equal(browser.logged_in_again,true);assert.equal(browser.no_invite,true);assert.equal(browser.played,true);assert.ok(browser.world_id);assert.ok(browser.screenshot);assert.ok(existsSync(browser.screenshot));
    report.checks.push({case:'actual_insecure_http_browser_registration_login_play',passed:true});
    // Only after the browser has cold-started this world, move source ahead.
    // The public account must keep playing the existing applied revision.
    const advance=await request('POST',`/projects/${project}/branches/main/transactions`,auth.token,{transaction_id:uid('owner-unpublished-name'),base_revision:made.value.branch.head,ops:[{type:'patch_object',resource_id:'scene-harbor',object_id:object.id,expected_version:object.version,patch:{name:'Owner source name changed without publishing'}}]});assert.equal(advance.status,200,JSON.stringify(advance.value));
    assert.notEqual(advance.value.revision,made.value.branch.head);
    const playable=await request('GET',`/projects/${project}/branches/main/playable?resource_id=scene-harbor`,reader.token);assert.equal(playable.status,200);assert.equal(playable.value.source_revision,made.value.branch.head);assert.equal(playable.value.runtime_build_id,runtime.build_id);
    const peer=new WebSocket(origin.replace(/^http/,'ws')+'/ws/creation',{origin}),packets=[];sockets.add(peer);peer.on('message',bytes=>packets.push(JSON.parse(bytes.toString())));peer.on('error',()=>{});
    const packet=async(predicate,mark=0)=>{for(let i=0;i<1000;i++){const found=packets.slice(mark).find(predicate);if(found)return found;await wait(10);}throw Error('LAN public world response timed out: '+JSON.stringify(packets.slice(-2)));};
    await new Promise((resolve,reject)=>{peer.once('open',resolve);peer.once('error',reject);});peer.send(JSON.stringify({type:'auth',token:reader.token}));await packet(message=>message.type==='authenticated');
    peer.send(JSON.stringify({type:'subscribe',project_id:project,branch_id:'main',resource_id:'scene-harbor',generation:1}));await packet(message=>message.type==='baseline');
    const join={type:'world_join',project_id:project,branch_id:'main',resource_id:'scene-harbor',runtime_build_id:playable.value.runtime_build_id,source_revision:playable.value.source_revision};
    peer.send(JSON.stringify(join));const joined=await packet(message=>message.type==='world'&&message.packet.action==='join'||message.type==='error');assert.equal(joined.type,'world',JSON.stringify(joined));assert.equal(joined.packet.scene_revision,made.value.branch.head);assert.equal(joined.packet.world_id,browser.world_id);
    await packet(message=>message.type==='world'&&message.packet.action==='snapshot'&&message.packet.snapshot.players[reader.user.id]?.online===true);
    const mark=packets.length;peer.send(JSON.stringify({...join,source_revision:advance.value.revision}));const wrongVersion=await packet(message=>message.type==='error',mark);assert.equal(wrongVersion.status,409);
    const finalSource=await request('GET',`/projects/${project}/branches/main`,auth.token),finalPlayable=await request('GET',`/projects/${project}/branches/main/playable?resource_id=scene-harbor`,reader.token);assert.equal(finalSource.value.head,advance.value.revision);assert.equal(finalPlayable.value.source_revision,made.value.branch.head);
    report.checks.push({case:'public_play_stays_on_applied_revision_after_owner_source_edit',world_id:joined.packet.world_id,applied_revision:made.value.branch.head,unpublished_source_revision:advance.value.revision,public_join_revision:joined.packet.scene_revision,unpublished_join_rejected:wrongVersion.status,source_not_published:true});peer.close();
  }
  report.completed=true;
});
