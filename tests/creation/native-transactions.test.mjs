import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeSourceArchive,NATIVE_SCHEMA,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {NativeTransactions} from '../../services/creation/native-transactions.mjs';

// Actual SQLite/file transactions with a controllable scene-preparation fixture.
// Engine serialization and native scene correctness require separate Godot tests.
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'atelier-native-transactions-')),store=new CreationStore(join(root,'creation.sqlite'));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const user=store.register({name:'native-owner',password:'test-password'}).user;
  const project=store.createProject(user,{name:'Native transactions'},{entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]}}});
  const p=project.project.id,archive=new NativeSourceArchive(join(root,'source-objects'));
  const files={'project.godot':archive.put('config_version=5\n'),'scene.tscn':archive.put('[gd_scene format=3]\n[node name="Root" type="Node"]\n')};
  const candidate=files=>{const identity=nativeSourceIdentity(files);return{schema:NATIVE_SCHEMA,source_files:files,source_identity:identity,index_source_identity:identity,entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',version:identity,objects:[]}}};};
  const branch=store.branchFor(user,p,'main');branch.head=store.writeRevision(p,[branch.head],candidate(files),user.id).id;store.put('creator_branch',branch);
  const prepare=async({manifest,input})=>{const changed=archive.applyFiles(manifest.source_files,input.ops);return{manifest:candidate(changed.files),inverse:changed.inverse};};
  const coordinator=new NativeTransactions({store,archive,prepare});
  const request=(id,ops)=>({transaction_id:id,base_revision:store.branchFor(user,p,'main').head,ops});
  return{root,store,user,p,archive,files,candidate,prepare,coordinator,request};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};

test('native transactions serialize independent writes, preserve history, replay once and guard inverse receipts',async t=>{
  const f=fixture(t),{coordinator,store,user,p,request,files,archive}=f;
  const first=request('first',[{type:'put_source_file',path:'scene.tscn',expected_hash:files['scene.tscn'].hash,text:'first change'}]);
  const second=request('second',[{type:'put_source_file',path:'project.godot',expected_hash:files['project.godot'].hash,text:'independent settings change'}]);
  const [a,b]=await Promise.all([coordinator.apply(user,p,'main',first),coordinator.apply(user,p,'main',second)]);
  assert.equal(archive.read(b.branch.manifest.source_files['scene.tscn']).toString(),'first change');
  assert.equal(archive.read(store.get('creator_revision',first.base_revision).manifest.source_files['scene.tscn']).toString(),'[gd_scene format=3]\n[node name="Root" type="Node"]\n');
  const count=store.list('creator_revision').length;
  assert.equal((await coordinator.apply(user,p,'main',first)).replayed,true);assert.equal(store.list('creator_revision').length,count);
  await assert.rejects(coordinator.apply(user,p,'main',{...first,ops:[{...first.ops[0],text:'reuse different payload'}]}),/同一个事务/);
  const forged=request('forged',[{...a.inverse[0],entry:files['project.godot']}]);await assert.rejects(coordinator.apply(user,p,'main',forged),/原始逆操作/);
  const undone=await coordinator.apply(user,p,'main',request('undo',a.inverse));
  assert.equal(undone.branch.manifest.source_files['scene.tscn'].hash,files['scene.tscn'].hash);
  assert.equal(archive.read(undone.branch.manifest.source_files['project.godot']).toString(),'independent settings change');
});

test('failed multi-file preparation publishes neither partial source nor receipt',async t=>{
  const f=fixture(t),{store,user,p,archive,request}=f,head=store.branchFor(user,p,'main').head;
  const coordinator=new NativeTransactions({store,archive,prepare:async ctx=>{await f.prepare(ctx);throw Error('actual preparation rejected candidate');}});
  await assert.rejects(coordinator.apply(user,p,'main',request('rejected',[{type:'put_source_file',path:'scene.tscn',expected_hash:f.files['scene.tscn'].hash,text:'candidate'}])),/rejected candidate/);
  assert.equal(store.branchFor(user,p,'main').head,head);assert.equal(store.get('creator_receipt',`${p}:main:rejected`),null);
});

test('permission is checked again after asynchronous Godot preparation and before receipt replay',async t=>{
  const f=fixture(t),started=deferred(),release=deferred(),head=f.store.branchFor(f.user,f.p,'main').head;
  const coordinator=new NativeTransactions({...f,prepare:async ctx=>{started.resolve();await release.promise;return f.prepare(ctx);}});
  const promise=coordinator.apply(f.user,f.p,'main',f.request('pending',[{type:'put_source_file',path:'scene.tscn',expected_hash:f.files['scene.tscn'].hash,text:'candidate'}]));
  await started.promise;const account=f.store.get('creator_user',f.user.id);account.disabled_at=Date.now();f.store.put('creator_user',account);release.resolve();
  await assert.rejects(promise,/权限/);assert.equal(f.store.get('creator_branch',`${f.p}:main`).head,head);
});

test('cancelled Agent and moved branch head cannot publish a completed native candidate',async t=>{
  for(const reason of ['cancel','head']){
    const f=fixture(t),started=deferred(),release=deferred();
    const origin={run_id:'run-native',lease_generation:1};
    f.store.put('creator_run',{id:origin.run_id,status:'running',lease_generation:1,owner_user_id:f.user.id,project_id:f.p,branch_id:'main'});
    const coordinator=new NativeTransactions({...f,prepare:async ctx=>{started.resolve();await release.promise;return f.prepare(ctx);}});
    const promise=coordinator.apply(f.user,f.p,'main',f.request('pending',[{type:'put_source_file',path:'scene.tscn',expected_hash:f.files['scene.tscn'].hash,text:'candidate'}]),origin);
    await started.promise;
    if(reason==='cancel'){const run=f.store.get('creator_run',origin.run_id);run.status='interrupted';f.store.put('creator_run',run);}
    else{const branch=f.store.branchFor(f.user,f.p,'main');branch.head=f.store.writeRevision(f.p,[branch.head],f.candidate(f.files),f.user.id).id;f.store.put('creator_branch',branch);}
    const head=f.store.branchFor(f.user,f.p,'main').head;release.resolve();await assert.rejects(promise,reason==='cancel'?/租约/:/源版本已变化/);assert.equal(f.store.branchFor(f.user,f.p,'main').head,head);
  }
});

test('native source read requires project membership and verifies retained bytes',async t=>{
  const f=fixture(t),stranger=f.store.register({name:'native-player',password:'test-password'}).user;f.store.publicPlay=true;
  assert.throws(()=>f.coordinator.source(stranger,f.p,'main'),/仅供项目协作者/);
  const read=f.coordinator.source(f.user,f.p,'main',{path:'scene.tscn'});assert.equal(Buffer.from(read.data_base64,'base64').toString(),'[gd_scene format=3]\n[node name="Root" type="Node"]\n');
});
