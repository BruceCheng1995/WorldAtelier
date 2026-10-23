/** Independent N/A evidence: real SQLite, source blobs and local filesystem.
 * Request/response adapters and native-index generation are explicit fixtures;
 * no network, Godot, offline gameplay or browser acceptance is claimed here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,ORIGIN} from './next-wave-test-support.mjs';

const subject=resolve(process.env.WORLD_ATELIER_NEXT_WAVE_SOURCE_ROOT??ROOT),load=path=>import(pathToFileURL(join(subject,path)).href);
assert.ok(existsSync(join(subject,'services/creation/native-offline.mjs')),'NOT_READY: native offline implementation not integrated.');
const {NativeSourceArchive,nativeSourceIdentity}=await load('services/creation/native-source.mjs');
const {NativeTransactions}=await load('services/creation/native-transactions.mjs');
const {NativeMerges}=await load('services/creation/native-merge.mjs');
const {NativeOffline}=await load('services/creation/native-offline.mjs');
const {NativeWorkspaceClient}=await load('tools/native-workspace.mjs');
const {CreationStore}=await load('services/creation/store.mjs');
const {hash}=await load('services/creation/schema.mjs');

function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'atelier-next-wave-offline-')),data=join(directory,'server');mkdirSync(data);
  const store=new CreationStore(join(data,'creation.sqlite')),archive=new NativeSourceArchive(join(data,'native-source/objects'));
  const account=store.register({name:'Offline author',password:'independent-offline-password'}),other=store.register({name:'Other author',password:'independent-offline-password'}),owner=account.user;
  const manifest=files=>({schema:'creation-native-1',source_files:files,source_identity:nativeSourceIdentity(files),index_source_identity:nativeSourceIdentity(files),entry_scene_id:'entry',resources:{entry:{id:'entry',kind:'scene',name:'Index fixture only',path:'scene.tscn',native_nodes:[]}}});
  const original={'project.godot':'config_version=5\n[application]\nconfig/name="Independent Offline"\nrun/main_scene="res://scene.tscn"\n','scene.tscn':'[gd_scene format=3]\n[node name="Root" type="Node2D"]\nmetadata/wa_node_id="root"\n','notes.txt':'first=1\n\nlast=1\n','opaque.bin':Buffer.from([0,1,128,255])};
  const files=Object.fromEntries(Object.entries(original).map(([path,bytes])=>[path,archive.put(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes))]));
  const created=store.createProject(owner,{name:'Independent offline'},manifest(files)),p=created.project.id;
  const native={archive,inspectFiles:async files=>manifest(files)};native.transactions=new NativeTransactions({store,archive,prepare:()=>{throw Error('No real Godot in this layer.');}});
  const service={store,native,root:subject,data,nativeMerges:new NativeMerges({store,native}),realtime:{committed(){}}},offline=new NativeOffline({service});
  const requests=[];let fault=null;
  const api=async(path,options={})=>{
    const method=options.method??'GET',body=options.body,bytes=body===undefined?null:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    const req=Readable.from(bytes?[bytes]:[]);Object.assign(req,{url:path,method,headers:{host:'127.0.0.1:48921',origin:ORIGIN,authorization:'Bearer '+account.token}});
    const res={status:200,writeHead(status){this.status=status;},end(value){this.bytes=Buffer.from(value??'');}};
    let failure=null;try{assert.equal(await offline.request(store.authenticate(account.token),req,res,new URL(path,ORIGIN)),true);}catch(error){failure=error;}
    requests.push({path,method,bytes:bytes?.length??0,status:failure?.status??res.status});
    if(failure)throw failure;
    const result=options.raw?res.bytes:JSON.parse(res.bytes.toString());if(fault)await fault(path,options,result);return result;
  };
  const directoryOf=name=>join(directory,'local-'+name);
  const client=(name='one',hooks={})=>new NativeWorkspaceClient({directory:directoryOf(name),server:ORIGIN,token:account.token,api,hooks});
  const commit=texts=>{
    const branch=store.branchFor(owner,p,'main',true),before=store.get('creator_revision',branch.head),next={...before.manifest.source_files};
    for(const [path,value]of Object.entries(texts)){if(value===null)delete next[path];else next[path]=archive.put(Buffer.isBuffer(value)?value:Buffer.from(value));}
    const revision=store.writeRevision(p,[branch.head],manifest(next),owner.id);store.put('creator_branch',{...branch,head:revision.id});return revision;
  };
  const serverText=path=>archive.read(store.get('creator_revision',store.branchFor(owner,p,'main').head).manifest.source_files[path]).toString();
  t.after(async()=>{await offline.close?.();await native.transactions.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return{directory,data,store,archive,manifest,original,files,account,owner,other,p,service,offline,requests,api,client,commit,serverText,setFault:value=>{fault=value;}};
}

test('F01 checkout preserves binary/source bytes and never hardlinks editable files to content cache',async t=>{
  const f=fixture(t),client=f.client(),state=await client.checkout({project_id:f.p,branch_id:'main'});
  for(const [path,bytes]of Object.entries(f.original))assert.deepEqual(readFileSync(join(client.project,path)),Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes));
  const file=join(client.project,'opaque.bin'),entry=state.base_files['opaque.bin'];
  const cache=join(client.metadata,'objects',entry.hash.slice(0,2),entry.hash);assert.ok(existsSync(cache));assert.notEqual(statSync(file).ino,statSync(cache).ino);
  writeFileSync(file,Buffer.from([4,5,6]));assert.deepEqual(readFileSync(cache),Buffer.from([0,1,128,255]));
  const stateText=readFileSync(client.statePath,'utf8');assert.ok(!stateText.includes(f.account.token));assert.equal(JSON.parse(stateText).progress_policy,'never_sync');
});

test('F02 unchanged synchronization uploads no blobs and a one-file change uploads only that file',async t=>{
  const f=fixture(t),client=f.client();await client.checkout({project_id:f.p});
  f.requests.length=0;const head=f.store.branchFor(f.owner,f.p,'main').head;await client.synchronize();
  assert.equal(f.requests.filter(r=>r.method==='PUT').length,0);assert.equal(f.store.branchFor(f.owner,f.p,'main').head,head);
  f.requests.length=0;writeFileSync(join(client.project,'notes.txt'),'first=2\n\nlast=1\n');await client.synchronize();
  const uploads=f.requests.filter(r=>r.method==='PUT');assert.equal(uploads.length,1);assert.equal(uploads[0].bytes,Buffer.byteLength('first=2\n\nlast=1\n'));assert.equal(f.serverText('notes.txt'),'first=2\n\nlast=1\n');
});

test('F03 lost commit response recovers its actual receipt without another source revision',async t=>{
  const f=fixture(t),client=f.client();await client.checkout({project_id:f.p});writeFileSync(join(client.project,'notes.txt'),'first=2\n\nlast=1\n');
  let lost=false;f.setFault((path)=>{if(path.endsWith('/commit')&&!lost){lost=true;throw Error('Independent simulated response lost after server commit');}});
  await assert.rejects(client.synchronize(),/response lost/);const committed=f.store.branchFor(f.owner,f.p,'main').head,count=f.store.list('creator_revision').length;
  f.setFault(null);const recovered=await client.recover();assert.equal(recovered.base_revision,committed);assert.equal(f.store.list('creator_revision').length,count);assert.equal(f.serverText('notes.txt'),'first=2\n\nlast=1\n');assert.equal(client.status().pending,null);
});

test('F03 lost blob response reuses server-received bytes instead of retransmitting them',async t=>{
  const f=fixture(t),client=f.client();await client.checkout({project_id:f.p});writeFileSync(join(client.project,'notes.txt'),'first=2\n\nlast=1\n');
  let lost=false;f.setFault((path,options)=>{if(options.method==='PUT'&&!lost){lost=true;throw Error('Independent upload acknowledgement loss');}});
  await assert.rejects(client.synchronize(),/acknowledgement loss/);const before=f.requests.filter(r=>r.method==='PUT').length;
  f.setFault(null);await client.recover();assert.equal(f.requests.filter(r=>r.method==='PUT').length,before);assert.equal(client.status().pending,null);
});

test('F04 edits made after the fixed upload snapshot survive the remote merge and local replay',async t=>{
  const f=fixture(t);let changed=false;const client=f.client('one',{afterServerCommit(){if(!changed){changed=true;writeFileSync(join(client.project,'notes.txt'),'first=3\n\nlast=1\n');}}});
  await client.checkout({project_id:f.p});writeFileSync(join(client.project,'notes.txt'),'first=2\n\nlast=1\n');f.commit({'notes.txt':'first=1\n\nlast=9\n'});
  await client.synchronize();assert.equal(f.serverText('notes.txt'),'first=2\n\nlast=9\n');assert.equal(readFileSync(join(client.project,'notes.txt'),'utf8'),'first=3\n\nlast=9\n');assert.ok(client.status().changes.some(c=>c.path==='notes.txt'));
  await client.synchronize();assert.equal(f.serverText('notes.txt'),'first=3\n\nlast=9\n');
});

test('F04 pull keeps local work and does not commit it to the server',async t=>{
  const f=fixture(t),client=f.client();await client.checkout({project_id:f.p});writeFileSync(join(client.project,'notes.txt'),'first=4\n\nlast=1\n');const remote=f.commit({'notes.txt':'first=1\n\nlast=8\n'}),count=f.store.list('creator_revision').length;
  await client.pull();assert.equal(f.store.branchFor(f.owner,f.p,'main').head,remote.id);assert.equal(f.store.list('creator_revision').length,count);assert.equal(f.serverText('notes.txt'),'first=1\n\nlast=8\n');assert.equal(readFileSync(join(client.project,'notes.txt'),'utf8'),'first=4\n\nlast=8\n');
});

test('F05 interrupted multi-file journal resumes without overwriting a post-interruption edit',async t=>{
  const f=fixture(t);let fail=false;const client=f.client('one',{afterApplyFile({path}){if(fail&&path==='notes.txt'){fail=false;throw Error('Independent journal interruption');}}});
  await client.checkout({project_id:f.p});f.commit({'notes.txt':'first=1\n\nlast=8\n','opaque.bin':Buffer.from([9,8,7,6])});fail=true;
  await assert.rejects(client.pull(),/journal interruption/);writeFileSync(join(client.project,'notes.txt'),'first=6\n\nlast=8\n');
  try{await client.recover();}catch(error){assert.equal(error.code,'NATIVE_WORKSPACE_CONFLICT');}
  assert.equal(readFileSync(join(client.project,'notes.txt'),'utf8'),'first=6\n\nlast=8\n');
  await client.recover();assert.equal(readFileSync(join(client.project,'notes.txt'),'utf8'),'first=6\n\nlast=8\n');assert.deepEqual(readFileSync(join(client.project,'opaque.bin')),Buffer.from([9,8,7,6]));assert.equal(client.status().pending,null);
});

test('F03 unknown/corrupted bytes cannot be submitted just because their hash exists elsewhere',async t=>{
  const f=fixture(t),client=f.client(),state=await client.checkout({project_id:f.p}),secret=Buffer.from('outside-project-private-bytes'),foreign=f.archive.put(secret);
  const outsideFiles={...f.files,'secret.bin':foreign};f.store.createProject(f.other.user,{name:'Outside project'},f.manifest(outsideFiles));
  assert.throws(()=>f.offline.blob(f.owner,state.workspace_id,foreign.hash),error=>error.status===403);
  const upload=f.offline.beginUpload(f.owner,state.workspace_id,{request_id:'foreign-reference',workspace_version:state.workspace_version,base_revision:state.base_revision,files:{...state.base_files,'injected.bin':foreign}});
  assert.ok(upload.missing.some(row=>row.hash===foreign.hash));assert.throws(()=>f.offline.blob(f.owner,state.workspace_id,foreign.hash,{upload_id:upload.upload_id}),error=>error.status===403);
  await assert.rejects(f.offline.prepare(f.owner,state.workspace_id,upload.upload_id),error=>error.details?.code==='native_workspace_missing_blobs');
  assert.throws(()=>f.offline.putBlob(f.owner,state.workspace_id,upload.upload_id,foreign.hash,Buffer.from('wrong')),error=>error.status===422);
});

test('F02 local metadata and cached files contain no creator credential; unsafe links are rejected',async t=>{
  const f=fixture(t),client=f.client();await client.checkout({project_id:f.p});
  const visit=directory=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?visit(join(directory,entry.name)):[join(directory,entry.name)]);
  for(const file of visit(client.directory))assert.ok(!readFileSync(file).includes(Buffer.from(f.account.token)),file);
  symlinkSync(join(f.directory,'server'),join(client.project,'foreign-link'));assert.throws(()=>client.status(),/链接|link|符号/i);
});

test('F05 workspace ownership and later project revocation deny reads and commits without deleting local files',async t=>{
  const f=fixture(t),client=f.client(),state=await client.checkout({project_id:f.p});
  assert.throws(()=>f.offline.view(f.other.user,state.workspace_id),error=>error.status===404);
  writeFileSync(join(client.project,'notes.txt'),'first=2\n\nlast=1\n');const project=f.store.get('creator_project',f.p);project.members[f.owner.id]='viewer';f.store.put('creator_project',project);
  await assert.rejects(client.synchronize(),error=>error.status===403);assert.equal(readFileSync(join(client.project,'notes.txt'),'utf8'),'first=2\n\nlast=1\n');assert.equal(f.serverText('notes.txt'),'first=1\n\nlast=1\n');
});
