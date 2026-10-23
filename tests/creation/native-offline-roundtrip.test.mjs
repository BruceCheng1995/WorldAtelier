import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeSourceArchive,NATIVE_SCHEMA,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {NativeTransactions} from '../../services/creation/native-transactions.mjs';
import {NativeMerges} from '../../services/creation/native-merge.mjs';
import {NativeOffline} from '../../services/creation/native-offline.mjs';
import {NativeWorkspaceClient,nativeWorkspaceApi} from '../../tools/native-workspace.mjs';
import {prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';
import {nativeWorkspaceRetention} from '../../tools/native-workspace-retention.mjs';

const ROOT=resolve(import.meta.dirname,'../..'),PORT=49031;
const scene='[gd_scene format=3]\n\n[node name="Root" type="Node3D"]\nmetadata/wa_node_id = "root"\nvisible = true\nprocess_priority = 0\n\n[node name="Child" type="Node3D" parent="."]\nmetadata/wa_node_id = "child"\nvisible = true\n';

// Real HTTP, SQLite, immutable blobs and filesystem recovery. The controllable
// native preparation fixture is not evidence of Godot import or gameplay.
async function fixture(t){
  const data=mkdtempSync(join(tmpdir(),'wa-offline-e2e-')),store=new CreationStore(join(data,'creation.sqlite')),archive=new NativeSourceArchive(join(data,'objects'));
  const account=store.register({name:'offline-owner',password:'test-password'}),other=store.register({name:'offline-other',password:'test-password'}),user=account.user;
  const created=store.createProject(user,{name:'Offline native'},{entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]}}}),p=created.project.id;
  const files=values=>Object.fromEntries(Object.entries(values).map(([path,bytes])=>[path,archive.put(bytes)]));
  const manifest=files=>{const identity=nativeSourceIdentity(files);return{schema:NATIVE_SCHEMA,source_files:files,source_identity:identity,index_source_identity:identity,entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',path:'scene.tscn',name:'Scene',version:identity,native_nodes:[],native_connections:[],native_dependencies:[]}}};};
  const write=values=>{const branch=store.branchFor(user,p,'main'),previous=store.get('creator_revision',branch.head).manifest.source_files??{},merged={...previous};for(const [path,value]of Object.entries(values))if(value===null)delete merged[path];else merged[path]=archive.put(value);branch.head=store.writeRevision(p,[branch.head],manifest(merged),user.id).id;store.put('creator_branch',branch);return branch.head;};
  write({'project.godot':'config_version=5\n\n[application]\nconfig/name="Offline game"\nrun/main_scene="res://scene.tscn"\n','scene.tscn':scene,'unknown.bin':Buffer.from([0,42,255]),'.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',path:'scene.tscn'}}})+'\n'});
  const native={archive,inspectFiles:async files=>manifest(files)};native.transactions=new NativeTransactions({store,archive,prepare:()=>{throw Error('Unexpected transaction path');}});
  const events=[],service={root:ROOT,data,store,native,nativeMerges:new NativeMerges({store,native}),realtime:{committed:(...args)=>events.push(args)},agent:null};
  const offline=new NativeOffline({service}),origin='http://127.0.0.1:'+PORT;
  const server=createServer(async(req,res)=>{res.setHeader('Connection','close');try{if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin){res.writeHead(403);res.end('{}');return;}const actor=store.authenticate(String(req.headers.authorization??'').replace(/^Bearer /,''));if(!await offline.request(actor,req,res,new URL(req.url,origin))){res.writeHead(404);res.end('{}');}}catch(error){res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({message:error.message,details:error.details}));}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(PORT,'127.0.0.1',yes);});
  t.after(async()=>{await offline.close();await new Promise(yes=>server.close(yes));store.close();rmSync(data,{recursive:true,force:true});});
  const api=nativeWorkspaceApi({server:origin,token:account.token}),client=(name='checkout',options={})=>new NativeWorkspaceClient({directory:join(data,name),server:origin,token:account.token,...options});
  const createClient=async(name,options={})=>{const c=client(name,options);await c.checkout({project_id:p});return c;};
  return {data,store,archive,user,account,other,p,files,manifest,write,native,service,offline,origin,api,client,createClient,events};
}

test('registered native checkout/sync transfers only missing blobs and preserves unrelated remote files',{timeout:30000},async t=>{
  const f=await fixture(t),log=[],c=await f.createClient('basic',{log:event=>log.push(event)});assert.equal(readFileSync(join(c.project,'scene.tscn'),'utf8'),scene);
  writeFileSync(join(c.project,'scene.tscn'),scene.replace('process_priority = 0','process_priority = 5'));f.write({'remote-only.txt':'remote bytes'});
  const before=f.store.list('creator_revision').length,next=await c.synchronize();assert.equal(f.store.list('creator_revision').length,before+1);assert.equal(readFileSync(join(c.project,'remote-only.txt'),'utf8'),'remote bytes');assert.match(readFileSync(join(c.project,'scene.tscn'),'utf8'),/process_priority = 5/);
  assert.equal(log.filter(event=>event.stage==='uploaded').length,1);assert.deepEqual(readFileSync(join(c.project,'unknown.bin')),Buffer.from([0,42,255]));assert.equal(c.status().changes.length,0);assert.equal(next.base_revision,f.store.branchFor(f.user,f.p,'main').head);
  const stateBytes=readFileSync(c.statePath,'utf8');assert.ok(!stateBytes.includes(f.account.token));assert.equal(f.events.length,1);
});

test('edits made while upload commits are replayed as local work, not silently overwritten or submitted',{timeout:30000},async t=>{
  const f=await fixture(t),c=await f.createClient('continued');writeFileSync(join(c.project,'scene.tscn'),scene.replace('process_priority = 0','process_priority = 5'));
  c.hooks.afterServerCommit=()=>writeFileSync(join(c.project,'scene.tscn'),readFileSync(join(c.project,'scene.tscn'),'utf8').replace('visible = true','visible = false'));
  const next=await c.synchronize(),saved=f.archive.read(next.base_files['scene.tscn']).toString();assert.match(saved,/visible = true/);assert.match(readFileSync(join(c.project,'scene.tscn'),'utf8'),/visible = false/);assert.equal(c.status().changes.length,1);
});

test('remote same-property conflict is resumable and keeps both original files',{timeout:30000},async t=>{
  const f=await fixture(t),c=await f.createClient('conflict');writeFileSync(join(c.project,'scene.tscn'),scene.replace('process_priority = 0','process_priority = 5'));const remote=f.write({'scene.tscn':scene.replace('process_priority = 0','process_priority = 9')});
  await assert.rejects(c.synchronize(),error=>error.code==='NATIVE_WORKSPACE_CONFLICT');assert.equal(f.store.branchFor(f.user,f.p,'main').head,remote);assert.match(readFileSync(join(c.project,'scene.tscn'),'utf8'),/process_priority = 5/);
  const record=c.conflicts({exportDirectory:join(f.data,'conflicts-export')}),key=record.conflicts.find(conflict=>!conflict.resolved).key;assert.ok(existsSync(join(f.data,'conflicts-export','001','base.txt')));
  await c.recover({resolutions:{[key]:'source'}});assert.match(readFileSync(join(c.project,'scene.tscn'),'utf8'),/process_priority = 5/);assert.equal(c.status().pending,null);
});

test('lost commit response recovers the original receipt and never creates a second revision',{timeout:30000},async t=>{
  const f=await fixture(t);let drop=true;const c=await f.createClient('lost-response',{api:async(path,options)=>{const result=await f.api(path,options);if(drop&&path.endsWith('/commit')){drop=false;throw Error('simulated connection lost after server commit');}return result;}});
  writeFileSync(join(c.project,'new.txt'),'uploaded once');await assert.rejects(c.synchronize(),/connection lost/);const count=f.store.list('creator_revision').length,head=f.store.branchFor(f.user,f.p,'main').head;
  await c.recover();assert.equal(f.store.list('creator_revision').length,count);assert.equal(c.state().base_revision,head);assert.equal(c.status().pending,null);assert.equal(f.events.length,1);
});

test('pull retains local changes without publishing them and never includes progress storage',{timeout:30000},async t=>{
  const f=await fixture(t),c=await f.createClient('pull');writeFileSync(join(c.project,'scene.tscn'),scene.replace('process_priority = 0','process_priority = 5'));mkdirSync(join(c.metadata,'saves'));writeFileSync(join(c.metadata,'saves','progress.json'),'{"coins":777}');
  const head=f.write({'remote.txt':'remote'}),count=f.store.list('creator_revision').length;await c.pull();assert.equal(f.store.list('creator_revision').length,count);assert.equal(c.state().base_revision,head);assert.match(readFileSync(join(c.project,'scene.tscn'),'utf8'),/process_priority = 5/);assert.equal(readFileSync(join(c.metadata,'saves','progress.json'),'utf8'),'{"coins":777}');assert.equal(f.store.list('creator_native_workspace_upload').length,0);
});

test('interrupted batch application recovers and preserves edits made before recovery',{timeout:30000},async t=>{
  const f=await fixture(t),c=await f.createClient('journal');f.write({'a.txt':'remote A','b.txt':'remote B'});let crash=true;c.hooks.afterApplyFile=({path})=>{if(crash&&path==='a.txt'){crash=false;throw Error('simulated interruption after first installed file');}};
  await assert.rejects(c.pull(),/interruption/);assert.equal(c.status().pending.phase,'applying');writeFileSync(join(c.project,'a.txt'),'local edit after interrupted apply');
  await assert.rejects(c.recover(),error=>error.code==='NATIVE_WORKSPACE_CONFLICT');assert.equal(readFileSync(join(c.project,'a.txt'),'utf8'),'local edit after interrupted apply');
  await assert.rejects(c.recover(),error=>error.code==='NATIVE_WORKSPACE_CONFLICT');const conflict=c.conflicts().conflicts.find(item=>!item.resolved);await c.recover({resolutions:{[conflict.key]:'target'}});
  assert.equal(readFileSync(join(c.project,'a.txt'),'utf8'),'local edit after interrupted apply');assert.equal(readFileSync(join(c.project,'b.txt'),'utf8'),'remote B');assert.equal(c.status().changes.length,1);
});

test('file-directory replacements preserve originals without backup path collisions',{timeout:30000},async t=>{
  const f=await fixture(t);f.write({'slot':'original file'});const c=await f.createClient('paths');f.write({'slot':null,'slot/child.txt':'new child'});await c.pull();assert.equal(readFileSync(join(c.project,'slot','child.txt'),'utf8'),'new child');
  f.write({'slot/child.txt':null,'slot':'new file'});await c.pull();assert.equal(readFileSync(join(c.project,'slot'),'utf8'),'new file');
});

test('foreign workspace/blob references and revoked accounts cannot read, upload or reuse preparation',{timeout:30000},async t=>{
  const f=await fixture(t),c=await f.createClient('auth'),state=c.state(),secret=f.archive.put('private unrelated bytes'),fakeFiles={...state.base_files,'leak.txt':secret};
  const upload=f.offline.beginUpload(f.user,state.workspace_id,{request_id:'foreign-hash',base_revision:state.base_revision,workspace_version:state.workspace_version,files:fakeFiles});assert.ok(upload.missing.some(entry=>entry.hash===secret.hash));assert.throws(()=>f.offline.blob(f.user,state.workspace_id,secret.hash,{upload_id:upload.upload_id}),error=>error.status===403);
  await assert.rejects(f.offline.prepare(f.user,state.workspace_id,upload.upload_id),error=>error.details?.code==='native_workspace_missing_blobs');assert.throws(()=>f.offline.view(f.other.user,state.workspace_id),error=>error.status===404);
  const account=f.store.get('creator_user',f.user.id);account.disabled_at=Date.now();f.store.put('creator_user',account);assert.throws(()=>f.offline.view(f.user,state.workspace_id),error=>error.status===403);
});

test('ordinary clients cannot bypass registered workspace commit through generic merge API',{timeout:30000},async t=>{
  const f=await fixture(t),c=await f.createClient('scope'),state=c.state(),newFiles={...state.base_files,'new.txt':f.archive.put('new')};
  const upload=f.offline.beginUpload(f.user,state.workspace_id,{request_id:'scoped',base_revision:state.base_revision,workspace_version:state.workspace_version,files:newFiles});for(const entry of upload.missing)f.offline.putBlob(f.user,state.workspace_id,upload.upload_id,entry.hash,f.archive.read(entry));const prepared=await f.offline.prepare(f.user,state.workspace_id,upload.upload_id);
  await assert.rejects(f.service.nativeMerges.merge(f.user,f.p,'main',{preview_id:prepared.preview.id}),error=>error.status===403);
  const [a,b]=await Promise.all([f.offline.commit(f.user,state.workspace_id,upload.upload_id,{preview_id:prepared.preview.id}),f.offline.commit(f.user,state.workspace_id,upload.upload_id,{preview_id:prepared.preview.id})]);assert.equal(a.result.revision,b.result.revision);
});

test('local scan refuses symlinks and fixed canonical package remains outside synchronized source',{timeout:30000},async t=>{
  const f=await fixture(t),c=await f.createClient('canonical');symlinkSync(join(f.data,'creation.sqlite'),join(c.project,'link'));assert.throws(()=>c.status(),/符号链接/);rmSync(join(c.project,'link'));
  c.apiOverride=()=>{throw Error('Network disabled after checkout');};const runtime=await c.preparePlay();assert.equal(runtime.contract,'world-atelier-game-project-v1');assert.match(readFileSync(runtime.project,'utf8'),/GameRuntime="\*res:\/\/atelier_runtime\/standalone.gd"/);assert.equal(runtime.local_edits_included,true);assert.equal(runtime.network_required,false);assert.ok(!c.status().changes.length);assert.ok(!Object.keys(c.state().base_files).some(path=>path.startsWith('atelier_runtime/')));
});

test('offline changed entry and newly authored scene run the actual canonical GameRuntime without network or source writes',{timeout:45000},async t=>{
  const f=await fixture(t),c=await f.createClient('offline-game'),originalCatalog=readFileSync(join(c.project,'.atelier/catalog.json'));
  writeFileSync(join(c.project,'project.godot'),readFileSync(join(c.project,'project.godot'),'utf8').replace('res://scene.tscn','res://added.tscn'));
  writeFileSync(join(c.project,'added.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://added.gd" id="1"]\n[node name="OfflineNewScene" type="Node"]\nscript = ExtResource("1")\nvalue = 47\n');
  writeFileSync(join(c.project,'added.gd'),'extends Node\n@export var value: int = 7\nfunc _ready():\n\tcall_deferred("verify_offline")\nfunc verify_offline():\n\tvar runtime = get_node("/root/GameRuntime")\n\tprint("OFFLINE_CANONICAL_PROBE ", JSON.stringify({"value": value, "scene": runtime.current_scene_id, "entry": runtime.release.entry_scene_id, "token": OS.get_environment("WORLD_ATELIER_TOKEN")}))\n\tget_tree().quit(0)\n');
  const before=c.snapshot();c.apiOverride=()=>{throw Error('All client network disabled');};const prepared=await c.preparePlay();assert.equal(prepared.local_edits_included,true);assert.equal(prepared.network_required,false);assert.ok(prepared.scenes.some(resource=>resource.path==='added.tscn'&&resource.id===prepared.entry_scene_id));assert.deepEqual(c.snapshot(),before);assert.deepEqual(readFileSync(join(c.project,'.atelier/catalog.json')),originalCatalog);
  const environment=prepareExecutionEnvironment({directory:join(f.data,'offline-run'),readPaths:[prepared.directory],writePaths:[prepared.directory]}),command=environment.command('/Applications/Godot.app/Contents/MacOS/Godot',['--headless','--audio-driver','Dummy','--path',prepared.directory,'--quit-after','120'],{godot:true,projectPath:prepared.directory});
  const output=execFileSync(command.command,command.args,{...command.options,encoding:'utf8',timeout:20000});const packet=JSON.parse(output.split('\n').find(line=>line.startsWith('OFFLINE_CANONICAL_PROBE ')).slice('OFFLINE_CANONICAL_PROBE '.length));assert.equal(packet.value,47);assert.equal(packet.scene,prepared.entry_scene_id);assert.equal(packet.entry,prepared.entry_scene_id);assert.equal(packet.token,'');assert.deepEqual(c.snapshot(),before);assert.equal(f.store.branchFor(f.user,f.p,'main').head,c.state().base_revision);
  const reused=await c.preparePlay();assert.equal(reused.reused,true);assert.equal(reused.directory,prepared.directory);
});

test('downloadable client is a runnable single Node module and embeds no account token',{timeout:30000},async t=>{
  const f=await fixture(t),bytes=await f.api('/creation-api/native-workspaces/client.mjs',{raw:true}),path=join(f.data,'portable.mjs');writeFileSync(path,bytes);assert.ok(!bytes.toString().includes(f.account.token));const output=execFileSync(process.execPath,[path,'help'],{encoding:'utf8'});assert.match(output,/checkout\|status\|sync/);
});

test('retention includes received pending blobs and offline templates but excludes not-yet-uploaded files',{timeout:30000},async t=>{
  const f=await fixture(t),c=await f.createClient('retention'),state=c.state(),added=f.archive.put(Buffer.from([0,9,8,7])),upload=f.offline.beginUpload(f.user,state.workspace_id,{request_id:'pending-retention',base_revision:state.base_revision,workspace_version:state.workspace_version,files:{...state.base_files,'pending.bin':added}});
  const rows=()=>f.store.db.prepare('SELECT kind,body FROM documents').all().map(row=>({kind:row.kind,value:JSON.parse(row.body)}));
  const before=nativeWorkspaceRetention(rows());assert.ok(!before.objects.some(file=>file.sha256===added.hash));assert.equal(before.workspaces.length,1);assert.ok(before.runtimes.length);
  f.offline.putBlob(f.user,state.workspace_id,upload.upload_id,added.hash,f.archive.read(added));const after=nativeWorkspaceRetention(rows());assert.ok(after.objects.some(file=>file.sha256===added.hash));
  const runtime=f.store.list('creator_native_workspace_runtime')[0];assert.ok(after.objects.some(file=>file.sha256===runtime.template_files['standalone.gd'].hash));
});
