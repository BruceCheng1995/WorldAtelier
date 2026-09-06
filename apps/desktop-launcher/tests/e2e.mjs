import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {launch} from '../launch.mjs';
import {checkoutWorkspace,pushWorkspace,prepareOffline,playOffline,resolveWorkspace} from '../workspace.mjs';
import {atomicWrite,jsonFile,hash,pause,createApi} from '../runtime.mjs';
const execute=promisify(execFile),HERE=dirname(fileURLToPath(import.meta.url));
const ROOT=resolve(process.env.WORLD_ATELIER_ROOT??join(HERE,'../../..'));
const EVIDENCE=resolve(process.env.DESKTOP_EVIDENCE??join(ROOT,'.local/desktop-e2e',String(Date.now())));
const PORT=Number(process.env.DESKTOP_TEST_PORT??48933),SERVER=`http://127.0.0.1:${PORT}`;
await mkdir(EVIDENCE,{recursive:true});
let service=null,relay=null,serverLog='';const assertions=[];
async function until(label,fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch{}await pause(100);}throw Error(`Timeout: ${label}`);}
async function start(){service=spawn(process.execPath,[join(ROOT,'services/control-plane/server.mjs')],{cwd:ROOT,env:{...process.env,WORLD_ATELIER_PORT:String(PORT),WORLD_ATELIER_DATA:join(EVIDENCE,'server-data')},detached:true,stdio:['ignore','pipe','pipe']});service.stdout.on('data',b=>serverLog+=b);service.stderr.on('data',b=>serverLog+=b);await until('isolated service',async()=>(await fetch(SERVER+'/health')).ok);}
async function stop(){if(service){const pid=service.pid;try{process.kill(-pid,'SIGTERM');}catch{}await until('service stopped',()=>service.exitCode!==null||service.signalCode!==null,10000);service=null;}await atomicWrite(join(EVIDENCE,'server.log'),serverLog);}
async function register(name){const r=await fetch(SERVER+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,password:'DesktopValidation2026'})});assert.equal(r.status,201);return r.json();}
async function publish(api,project){let build=(await api(`/api/projects/${project}/branches/main/build`,{})).build;await until('actual exported Godot build',async()=>{build=(await api(`/api/projects/${project}`)).builds.find(b=>b.id===build.id);return ['passed','failed','superseded'].includes(build.status);},90000);assert.equal(build.status,'passed',build.error||build.log);return build;}
async function content(api,project){return api(`/api/projects/${project}/branches/main/content`);}
const input=join(EVIDENCE,'online-input.json');
try{
  await start();
  const owner=await register('desktop-owner-'+Date.now()),collaborator=await register('desktop-editor-'+Date.now());
  const api=createApi({server:SERVER,token:owner.token,journalDir:join(EVIDENCE,'owner-operations')});
  const editorApi=createApi({server:SERVER,token:collaborator.token,journalDir:join(EVIDENCE,'editor-operations')});
  const project=(await api('/api/projects',{name:'星屿远征 · 原生离线端到端验收'})).project;
  await api(`/api/projects/${project.id}/members`,{name:collaborator.user.name,role:'editor'});
  const build=await publish(api,project.id);const world=(await api(`/api/projects/${project.id}/worlds`,{branch:'main',name:'原生离线基线世界'})).world;
  await atomicWrite(input,[{at:1,action:'select',payload:{object_id:'landing_crystal_0'}},{at:1.3,action:'interact',payload:{object_id:'landing_crystal_0'}},{at:2,action:'move',payload:{x:0,z:1},duration:.35}]);
  process.env.WORLD_ATELIER_TOKEN=owner.token;
  const online=await launch({server:SERVER,project:project.id,world:world.id,cache:join(EVIDENCE,'online-cache'),'input-script':input,'quit-after-seconds':4,'log-dir':join(EVIDENCE,'native-online'),capture:join(EVIDENCE,'native-online.png'),'capture-after':3,resolution:'1440x960'});
  assert.equal(online.active_confirmed,true);assert.equal(online.latest.world_id,world.id);assert.equal(online.latest.release_id,build.release_id);assert.equal(online.latest.user_id,owner.user.id);assert.ok(online.latest.player.crystals>=2);assert.ok(online.latest.tick>0);
  assertions.push('Real macOS export downloaded with SHA-256 verification, graphical native online client loaded matching world/release/account and processed ordinary scripted collect/move inputs');
  const source=await content(api,project.id);const code='extends RefCounted\nfunc evaluate(context: Dictionary) -> Dictionary:\n    return {"attack_damage": 45.0}\n';
  const asset=(await api(`/api/projects/${project.id}/assets`,{name:'offline-rule.gd',mime:'text/x-gdscript',data_base64:Buffer.from(code).toString('base64')})).asset;
  const modelBytes=await readFile(join(ROOT,'runtimes/godot/assets/explorer.glb'));
  const model=(await api(`/api/projects/${project.id}/assets`,{name:'offline-explorer.glb',mime:'model/gltf-binary',data_base64:modelBytes.toString('base64')})).asset;
  source.content.objects.find(o=>o.id==='forge_hub').model_asset=model.hash;
  source.content.behaviors=[{id:'offline-rule',asset_hash:asset.hash,api:1}];await api(`/api/projects/${project.id}/branches/main/commit`,{base_revision:source.revision,content:source.content,message:'未发布的离线源码候选'});
  const directory=join(EVIDENCE,'portable-workspace');const workspace=await checkoutWorkspace({directory,server:SERVER,token:owner.token,project:project.id});
  assert.equal(workspace.source_ahead_of_playable,true);assert.equal(workspace.play_revision,source.revision);assert.notEqual(workspace.base_revision,workspace.play_revision);assert.equal(workspace.state_seed_release,build.release_id);assert.ok(workspace.source_assets[asset.hash]);assert.equal(hash(Buffer.from(workspace.source_assets[model.hash].data_base64,'base64')),model.hash);assert.equal(workspace.play_content.behaviors?.length??0,0);
  assert.equal(hash(await readFile(join(directory,workspace.local.runtime_archive))),workspace.local.runtime_sha256);
  assertions.push('Complete offline package pins verified playable content/checkpoint separately from newer source, includes real GLB and GDScript source blobs and full native archive');
  // Real import request is forwarded unchanged; its real response is deliberately held
  // so an external editor can save another revision while the upload is in flight.
  let imported,releaseReply;
  let importedPromise=new Promise(r=>imported=r),gate=new Promise(r=>releaseReply=r),seenBody;
  relay=createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks);const upstream=await fetch(SERVER+req.url,{method:req.method,headers:{Authorization:req.headers.authorization,'Content-Type':'application/json','Idempotency-Key':req.headers['idempotency-key']??randomUUID()},body:['GET','HEAD'].includes(req.method)?undefined:body});const bytes=Buffer.from(await upstream.arrayBuffer());if(req.url.endsWith('/import')){seenBody=JSON.parse(body);imported();await gate;}res.writeHead(upstream.status,{'Content-Type':'application/json'});res.end(bytes);});await new Promise(r=>relay.listen(PORT+1,'127.0.0.1',r));
  let remote=await content(editorApi,project.id);remote.content.objects[2].name='同伴在远端提交的名字';await editorApi(`/api/projects/${project.id}/branches/main/commit`,{base_revision:remote.revision,content:remote.content});
  let local=await jsonFile(join(directory,'content.json'));local.objects[1].color='#cc8855';await atomicWrite(join(directory,'content.json'),local);
  const pushing=pushWorkspace({directory,server:`http://127.0.0.1:${PORT+1}`,token:owner.token,build:false});await importedPromise;
  local=await jsonFile(join(directory,'content.json'));local.objects[3].x+=.75;await atomicWrite(join(directory,'content.json'),local);releaseReply();await pushing;
  const rebased=await jsonFile(join(directory,'content.json')),base=await jsonFile(join(directory,'workspace.json'));
  assert.equal(rebased.objects[2].name,'同伴在远端提交的名字');assert.equal(rebased.objects[3].x,local.objects[3].x);assert.notEqual(base.content.objects[3].x,local.objects[3].x);
  assert.deepEqual(Object.keys(seenBody).sort(),['base_revision','branch','content','format','message','project_id'].sort());assert.ok(!seenBody.content.asset_blobs);assert.ok(!seenBody.state_seed);
  await pushWorkspace({directory,server:SERVER,token:owner.token,build:false});assert.equal((await content(api,project.id)).content.objects[2].name,'同伴在远端提交的名字');
  assertions.push('Real concurrent upload replays local edits made in flight over server merge, updates content.json/base atomically, preserves remote fields on next push, and sends no runtime asset blobs or gameplay state');
  importedPromise=new Promise(r=>imported=r);gate=new Promise(r=>releaseReply=r);
  remote=await content(editorApi,project.id);remote.content.objects[4].name='远端冲突名字';await editorApi(`/api/projects/${project.id}/branches/main/commit`,{base_revision:remote.revision,content:remote.content});
  local=await jsonFile(join(directory,'content.json'));local.objects[1].color='#44aa88';await atomicWrite(join(directory,'content.json'),local);
  const conflictPush=pushWorkspace({directory,server:`http://127.0.0.1:${PORT+1}`,token:owner.token,build:false}).then(()=>null,e=>e);await importedPromise;
  local=await jsonFile(join(directory,'content.json'));local.objects[4].name='上传期间本机冲突名字';await atomicWrite(join(directory,'content.json'),local);releaseReply();assert.ok(await conflictPush);
  assert.equal((await jsonFile(join(directory,'content.json'))).objects[4].name,'上传期间本机冲突名字');assert.ok((await jsonFile(join(directory,'local-conflicts.json'))).conflicts.length);await assert.rejects(pushWorkspace({directory,server:SERVER,token:owner.token,build:false}),/Unresolved/);
  assertions.push('A conflict arising after server acceptance preserves newer local file and records full merge evidence; subsequent push is blocked until explicit resolution');
  await new Promise(r=>relay.close(r));relay=null;
  const otherDirectory=join(EVIDENCE,'second-user-workspace');
  const otherWorkspace=await checkoutWorkspace({directory:otherDirectory,server:SERVER,token:collaborator.token,project:project.id,log:()=>{}});
  assert.equal(otherWorkspace.user_id,collaborator.user.id);assert.notEqual(otherWorkspace.workspace_id,workspace.workspace_id);
  await stop();await assert.rejects(fetch(SERVER+'/health'));
  delete process.env.WORLD_ATELIER_TOKEN;
  const offlineInput=join(EVIDENCE,'offline-input.json');await atomicWrite(offlineInput,[{at:.7,action:'interact',payload:{object_id:'landing_crystal_1'}}]);
  // Copy to a new folder: no original repo, cache, token or service is needed by .command.
  const moved=join(EVIDENCE,'relocated-complete-package');await cp(directory,moved,{recursive:true});
  const offlineTelemetry=join(EVIDENCE,'portable-telemetry.json');
  const played=await execute('/bin/sh',[join(moved,'Play offline.command'),`--telemetry-file=${offlineTelemetry}`,`--input-script=${offlineInput}`,'--quit-after-seconds=2.5',`--capture=${join(EVIDENCE,'offline-portable.png')}`,'--capture-after=1.8'],{cwd:'/tmp',timeout:30000,maxBuffer:3_000_000,env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME}});
  await atomicWrite(join(EVIDENCE,'portable-shell.log'),played.stdout+'\n'+played.stderr);
  const portablePacket=await jsonFile(offlineTelemetry);assert.equal(portablePacket.active,true);assert.equal(portablePacket.user_id,owner.user.id);assert.ok(portablePacket.player.crystals>=4);assert.ok(portablePacket.status.includes('OFFLINE'));
  assertions.push('Relocated complete package runs graphical native offline with only /usr/bin:/bin PATH, central service stopped, no token, no Node or repository; ordinary collect input advances local progress');
  const prepared=await prepareOffline({file:join(moved,'workspace.json'),options:{headless:true},log:()=>{}});const saved=await jsonFile(prepared.save);assert.ok(saved.players[owner.user.id].crystals>=4);
  const originalSource=await readFile(join(moved,'content.json'),'utf8');
  const restarted=await playOffline({file:join(moved,'workspace.json'),options:{headless:true,'quit-after-seconds':1.5,'log-dir':join(EVIDENCE,'offline-restart')},log:()=>{}});
  assert.equal(restarted.save,prepared.save);assert.equal(restarted.latest.player.crystals,saved.players[owner.user.id].crystals);assert.ok(restarted.latest.tick>saved.tick);assert.equal(await readFile(join(moved,'content.json'),'utf8'),originalSource);
  const otherUser=await playOffline({file:join(otherDirectory,'workspace.json'),options:{headless:true,'quit-after-seconds':1.5,'log-dir':join(EVIDENCE,'second-user-offline')},log:()=>{}});
  assert.equal(otherUser.latest.user_id,collaborator.user.id);assert.equal(otherUser.latest.player.crystals,0);
  const otherIdentity=await jsonFile(join(dirname(otherUser.save),'identity.json'));assert.equal(otherIdentity.user,collaborator.user.id);assert.notEqual(otherIdentity.workspace,workspace.workspace_id);
  assertions.push('A second real authenticated collaborator gets a distinct workspace/user/save identity and starts with their own inventory while the first offline inventory remains intact');
  assertions.push('Offline restart without service resumes the same user/workspace/state-domain save, advances tick and never overwrites editable content.json');
  const binaryBefore=hash(await readFile(prepared.runtime.binary));await writeFile(prepared.runtime.binary,Buffer.from('corrupted application'));
  const repaired=await prepareOffline({file:join(moved,'workspace.json'),options:{headless:true},log:()=>{}});assert.equal(hash(await readFile(repaired.runtime.binary)),binaryBefore);
  assertions.push('Corrupt extracted executable is detected and staging-rebuilt from verified local ZIP with no download');
  const invalid=await jsonFile(join(moved,'content.json'));invalid.objects[0].color='#invalid';await atomicWrite(join(moved,'content.json'),invalid);const saveBefore=hash(await readFile(prepared.save));
  await assert.rejects(prepareOffline({file:join(moved,'workspace.json'),edited:true,options:{headless:true},log:()=>{}}),/rejected/);assert.equal(hash(await readFile(prepared.save)),saveBefore);
  await atomicWrite(join(moved,'content.json'),JSON.parse(originalSource));
  const edited=await playOffline({file:join(moved,'workspace.json'),edited:true,options:{headless:true,'quit-after-seconds':1.5,'log-dir':join(EVIDENCE,'offline-edited')},log:()=>{}});
  assert.notEqual(edited.save,prepared.save);assert.equal(edited.latest.player.crystals,0);assert.equal(hash(await readFile(prepared.save)),saveBefore);
  const editedIdentity=await jsonFile(join(dirname(edited.save),'identity.json'));assert.equal(editedIdentity.validation.passed,true);
  const standalone=await execute(process.execPath,[join(moved,'launcher/launch.mjs'),`--offline=${join(moved,'workspace.json')}`,'--edited','--headless','--quit-after-seconds=1.2',`--log-dir=${join(EVIDENCE,'standalone-edited-cli')}`],{cwd:'/tmp',timeout:35000,maxBuffer:3_000_000});
  await atomicWrite(join(EVIDENCE,'standalone-edited-cli.log'),standalone.stdout+'\n'+standalone.stderr);
  assert.equal((await jsonFile(join(EVIDENCE,'standalone-edited-cli/launch-receipt.json'))).active_confirmed,true);
  assertions.push('Local source with materialized real GLB and GDScript assets is validated by downloaded Godot before running in a separate save; invalid candidate leaves playable content/save untouched');
  const corruptArchive=await readFile(prepared.runtime.archive);await writeFile(prepared.runtime.archive,Buffer.from('broken zip'));await assert.rejects(prepareOffline({file:join(moved,'workspace.json'),options:{headless:true},log:()=>{}}),/missing or corrupt/);await atomicWrite(prepared.runtime.archive,corruptArchive);
  assertions.push('Offline missing/corrupt ZIP fails explicitly instead of attempting a hidden network download or trusting existing .app');
  await start();
  await resolveWorkspace(moved);
  const pushed=await pushWorkspace({directory:moved,server:SERVER,token:owner.token,world:world.id,runtimeHash:workspace.release.runtime_hash});
  assert.equal(pushed.build.status,'passed');assert.equal(pushed.applied.world.release_id,pushed.build.release_id);
  process.env.WORLD_ATELIER_TOKEN=owner.token;
  const rejoined=await launch({server:SERVER,project:project.id,world:world.id,cache:join(EVIDENCE,'online-cache'),headless:true,'quit-after-seconds':1.8,'log-dir':join(EVIDENCE,'native-rejoined')});
  assert.equal(rejoined.latest.release_id,pushed.build.release_id);assert.equal(rejoined.latest.player.crystals,online.latest.player.crystals);
  assertions.push('After real central-service restart, the relocated package resolves local conflict, imports source only, builds with actual pinned Godot, applies the exact release and native client rejoins without importing offline inventory');
  await atomicWrite(join(EVIDENCE,'report.json'),{time:new Date().toISOString(),assertions,project_id:project.id,world_id:world.id,release_id:build.release_id,runtime_hash:workspace.release.runtime_hash,source_revision:workspace.base_revision,play_revision:workspace.play_revision,native_online:{receipt:online.output_file,capture:join(EVIDENCE,'native-online.png')},offline:{packet:offlineTelemetry,capture:join(EVIDENCE,'offline-portable.png'),save:prepared.save,edited_save:edited.save},state:'passed'});
  console.log(JSON.stringify({passed:assertions.length,evidence:EVIDENCE,assertions},null,2));
}catch(error){await atomicWrite(join(EVIDENCE,'failure.json'),{error:error.message,stack:error.stack,assertions});throw error;}finally{if(relay)await new Promise(r=>relay.close(r));await stop();}
