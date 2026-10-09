// Real isolated Node build worker, Godot source build, native edit transaction,
// SQLite and ZIP bytes. No formal service, browser, live room or Agent is used.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
import {CreationStore} from '../../services/creation/store.mjs';import {NativeProjects} from '../../services/creation/native-project.mjs';import {CreationBuilds} from '../../services/creation/export-builds.mjs';
const root=resolve(import.meta.dirname,'../..');
const waitFor=async(fn,timeout=180000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out waiting for independent build stage');};
test('native source build pins R1 while another editor commits R2 and controller stays responsive',{timeout:240000},async t=>{
 const data=mkdtempSync(join(tmpdir(),'wa-build-worker-')),store=new CreationStore(join(data,'creation.sqlite')),native=new NativeProjects({store,data});let builds,timer;
 t.after(async()=>{clearInterval(timer);await builds?.close();await native.close();store.close();rmSync(data,{recursive:true,force:true});});
 const owner=store.register({name:'Build owner',password:'independent-worker-password'}).user,editor=store.register({name:'Editing collaborator',password:'independent-worker-password'}).user;
 const created=store.createProject(owner,{name:'Build snapshot isolation'},{entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',objects:[]}}}),p=created.project.id;store.setMember(owner,p,editor.id,'editor');
 const beforeScript='extends Node3D\n@export var authored_value: int = 11\n',afterScript='extends Node3D\n@export var authored_value: int = 29\n';
 const texts={
  'project.godot':'config_version=5\n[application]\nconfig/name="Worker snapshot"\nrun/main_scene="res://scenes/main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',path:'scenes/main.tscn'},unused:{id:'unused',kind:'prefab',name:'Unplaced prefab',path:'prefabs/unused.tscn'}}}),
  'scripts/main.gd':beforeScript,
  'scenes/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/main.gd" id="1"]\n[node name="Main" type="Node3D"]\nscript = ExtResource("1")\nmetadata/wa_node_id = "main-root"\n',
  'prefabs/unused.tscn':'[gd_scene format=3]\n[node name="Unplaced" type="Node3D"]\nmetadata/wa_node_id = "unused-root"\n',
  'custom/unknown.bin':Buffer.from([0,255,4,5,16,128]),
 };
 const imported=await native.apply(owner,p,'main',{transaction_id:'initial-native-import',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,value])=>({path,data_base64:Buffer.from(value).toString('base64')}))}]}),r1=imported.revision;
 const service={root,data,origin:'http://isolated.invalid',store,native,observe:fn=>fn()};builds=new CreationBuilds({service});
 const observations=[],originalUpdate=builds.update.bind(builds);builds.update=(job,patch)=>{const result=originalUpdate(job,patch);observations.push({at:Date.now(),status:result.status,stage:result.stage,worker_pid:result.executor?.pid??builds.worker?.pid??null});return result;};
 const gaps=[];let last=performance.now();timer=setInterval(()=>{const now=performance.now();gaps.push(now-last);last=now;},20);
 const started=performance.now(),response=builds.create(owner,p,'main',{confirmed:true,kind:'source',request_id:'source-R1',source_revision:r1,entry_scene_id:'main',targets:[]}),ackMs=performance.now()-started,id=response.job.id;
 assert.equal(response.job.source_revision,r1);
 await waitFor(()=>store.get('creator_build',id)?.status==='running');const workerPid=store.get('creator_build',id)?.executor?.pid??builds.worker?.pid;assert.ok(workerPid&&workerPid!==process.pid,'native build runs in an independent Node process');
 // Hold the real executor at its pinned R1 boundary. The faster 180-step
 // checks can now finish before Godot finishes indexing R2; wall-clock races
 // must not decide whether the concurrent source-isolation assertion runs.
 process.kill(workerPid,'SIGSTOP');
 const atEditStart=Date.now(),editStartPulse=gaps.length;let edit,editFinishedAt,statusAtEditCommit;
 try{
  edit=await native.apply(editor,p,'main',{transaction_id:'collaborator-R2',base_revision:r1,ops:[{type:'put_source_file',path:'scripts/main.gd',expected_hash:imported.branch.manifest.source_files['scripts/main.gd'].hash,text:afterScript}]});
  editFinishedAt=Date.now();statusAtEditCommit=store.get('creator_build',id).status;
 }finally{process.kill(workerPid,'SIGCONT');}
 assert.notEqual(edit.revision,r1);assert.equal(store.branchFor(editor,p,'main').head,edit.revision);assert.ok(gaps.length-editStartPulse>5,'controller heartbeat continues while source edit and build execute');
 assert.equal(statusAtEditCommit,'running','collaborator commits while the pinned worker is held');const result=await waitFor(()=>{const job=store.get('creator_build',id);return ['completed','failed','partial','interrupted'].includes(job?.status)&&job;});
 assert.equal(result.status,'completed',JSON.stringify(result.error));await waitFor(()=>!builds.running);clearInterval(timer);
 const project=join(data,'builds',id,'project'),zip=join(data,'builds',id,result.artifacts.find(a=>a.target==='source').filename);
 assert.equal(readFileSync(join(project,'scripts/main.gd'),'utf8'),beforeScript);assert.equal(execFileSync('unzip',['-p',zip,'scripts/main.gd'],{encoding:'utf8'}),beforeScript);
 assert.equal(execFileSync('unzip',['-p',zip,'prefabs/unused.tscn'],{encoding:'utf8'}),native.archive.read(imported.branch.manifest.source_files['prefabs/unused.tscn']).toString());assert.deepEqual(execFileSync('unzip',['-p',zip,'custom/unknown.bin']),texts['custom/unknown.bin']);
 const release=JSON.parse(readFileSync(join(project,'atelier_runtime/release.json'),'utf8'));assert.equal(release.source_revision??release.revision,r1);assert.ok(release.scenes.unused,'unplaced prefab is part of the fixed project closure');
 assert.equal(result.source_revision,r1);assert.equal(store.branchFor(owner,p,'main').head,edit.revision);assert.equal(native.archive.read(edit.branch.manifest.source_files['scripts/main.gd']).toString(),afterScript);
 for(const kind of ['creator_native_game_release','creator_native_game_pointer','creator_world'])assert.equal(store.list(kind).length,0,kind+' is unchanged');
 const evidence={at:new Date().toISOString(),job_id:id,source_revision:r1,head_after_edit:edit.revision,ack_ms:ackMs,edit_started_at:atEditStart,edit_finished_at:editFinishedAt,status_at_edit_commit:statusAtEditCommit,worker_pid:workerPid,controller_pid:process.pid,heartbeat_samples:gaps.length,max_heartbeat_gap_ms:Math.max(...gaps),worker_observations:observations,artifact_sha256:result.artifacts[0].sha256};
 const out=join(root,'.local/performance-20260909/independent');mkdirSync(out,{recursive:true});writeFileSync(join(out,'build-worker-isolation.json'),JSON.stringify(evidence,null,2));
 const submit=(actor,request)=>builds.create(actor,p,'main',{confirmed:true,kind:'source',request_id:request,source_revision:edit.revision,entry_scene_id:'main',targets:[]}).job.id;
 const terminal=id=>waitFor(()=>{const job=store.get('creator_build',id);return ['completed','failed','partial','interrupted'].includes(job?.status)&&job;});
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
 const importingEngine=async id=>{const worker=builds.worker;let enginePid=null;const onMessage=message=>{if(message.type==='engine')enginePid=message.pid;};worker.on('message',onMessage);try{return await waitFor(()=>enginePid&&store.get('creator_build',id).stage==='Godot 正在导入工程'&&enginePid);}finally{worker.off('message',onMessage);}};
 const boundaryEvidence=[];
 await t.test('a real running worker cannot complete after its only requester loses edit permission',async()=>{
  const revokedId=submit(editor,'worker-revocation');
  await waitFor(()=>store.get('creator_build',revokedId)?.status==='running');
  const revokedPid=builds.worker.pid,enginePid=await importingEngine(revokedId);assert.ok(alive(enginePid));store.setMember(owner,p,editor.id,'viewer');
  assert.throws(()=>store.projectFor(editor,p,true));
  const revoked=await terminal(revokedId);await waitFor(()=>!builds.running);
  assert.equal(revoked.status,'failed');assert.match(revoked.error,/权限/);
  assert.equal(observations.filter(row=>row.worker_pid===revokedPid&&['completed','partial'].includes(row.status)).length,0);
  await waitFor(()=>!alive(revokedPid)&&!alive(enginePid));
  boundaryEvidence.push({case:'permission-revoked',job_id:revokedId,engine_pid:enginePid,status:revoked.status,error:revoked.error});
 });
 await t.test('SIGKILL fails the real worker, advances the queue, and close stops the replacement worker',async()=>{
  const killedId=submit(owner,'worker-crash');
  await waitFor(()=>store.get('creator_build',killedId)?.status==='running');
  const killedPid=builds.worker.pid,enginePid=await importingEngine(killedId),nextId=submit(owner,'worker-after-crash');assert.ok(alive(enginePid));
  assert.equal(store.get('creator_build',nextId).status,'queued');
  process.kill(killedPid,'SIGKILL');
  const killed=await terminal(killedId);assert.equal(killed.status,'failed');assert.match(killed.error,/SIGKILL|退出/);
  await waitFor(()=>store.get('creator_build',nextId)?.status==='running');
  const nextPid=builds.worker.pid;assert.notEqual(nextPid,killedPid);
  const closeStarted=performance.now();await builds.close();const closeMs=performance.now()-closeStarted;
  assert.ok(closeMs<7000,'closing the actual replacement worker is bounded');
  assert.equal(store.get('creator_build',nextId).status,'interrupted');assert.equal(builds.running,null);assert.equal(builds.worker,null);
  await waitFor(()=>!alive(killedPid)&&!alive(nextPid)&&!alive(enginePid));
  boundaryEvidence.push({case:'worker-kill-and-queue',killed_pid:killedPid,engine_pid:enginePid,next_pid:nextPid,killed_status:killed.status,next_status:store.get('creator_build',nextId).status,close_ms:closeMs});
 });
 await t.test('create then close in the same tick never launches its pending worker',async()=>{
  builds=new CreationBuilds({service});let launches=0;const executeIsolated=builds.executeIsolated.bind(builds);builds.executeIsolated=(...args)=>{launches++;return executeIsolated(...args);};
  const closingId=submit(owner,'worker-immediate-close');await builds.close();
  assert.equal(launches,0);assert.equal(store.get('creator_build',closingId).status,'interrupted');assert.equal(builds.running,null);assert.ok(!builds.worker);
  boundaryEvidence.push({case:'same-tick-close',launches,status:store.get('creator_build',closingId).status});
 });
 writeFileSync(join(out,'build-worker-boundaries.json'),JSON.stringify({at:new Date().toISOString(),cases:boundaryEvidence},null,2));
});
