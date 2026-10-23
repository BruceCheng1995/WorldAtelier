import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeSourceArchive,NATIVE_SCHEMA,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {NativeTransactions} from '../../services/creation/native-transactions.mjs';
import {NativeMerges} from '../../services/creation/native-merge.mjs';
import {BRANCH_MERGE_TOOLS,BRANCH_MERGE_READ_TOOLS,dispatchBranchMergeTool,createBranchMergeDraft} from '../../services/creation/native-merge-agent.mjs';

const scene='[gd_scene format=3]\n[node name="Root" type="Node3D"]\nmetadata/wa_node_id = "root"\nvisible = true\nprocess_priority = 0\n';
function fixture(t){
  const data=mkdtempSync(join(tmpdir(),'wa-merge-agent-')),store=new CreationStore(join(data,'creation.sqlite')),archive=new NativeSourceArchive(join(data,'objects'));t.after(()=>{store.close();rmSync(data,{recursive:true,force:true});});
  const user=store.register({name:'merge-agent-owner',password:'test-password'}).user,p=store.createProject(user,{name:'Agent merge'},{entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]}}}).project.id;
  const candidate=files=>{const identity=nativeSourceIdentity(files);return{schema:NATIVE_SCHEMA,source_files:files,source_identity:identity,index_source_identity:identity,entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',version:identity,native_nodes:[]}}};};
  const write=(branchId,values)=>{const branch=store.branchFor(user,p,branchId),files={...(store.get('creator_revision',branch.head).manifest.source_files??{})};for(const [path,value]of Object.entries(values))if(value===null)delete files[path];else files[path]=archive.put(value);branch.head=store.writeRevision(p,[branch.head],candidate(files),user.id).id;store.put('creator_branch',branch);return branch.head;};
  write('main',{'project.godot':'config_version=5\n','scene.tscn':scene});store.fork(user,p,{from_branch:'main',branch_id:'source'});store.fork(user,p,{from_branch:'main',branch_id:'other'});
  const session=store.createSession(user,p,'main',{visibility:'private'}),run={id:'run-agent-merge',session_id:session.id,project_id:p,branch_id:'main',owner_user_id:user.id,status:'running',lease_generation:1,execution_mode:'default',changes:[]};store.put('creator_run',run);
  const native={archive,inspectFiles:async files=>candidate(files)};native.transactions=new NativeTransactions({store,archive,prepare:()=>{throw Error('Not used');}});const events=[],service={store,native,nativeMerges:new NativeMerges({store,native}),realtime:{committed:(...args)=>events.push(args)}};
  const signal=new AbortController(),context={service,user,session,run,signal:signal.signal},call=(tool,args)=>dispatchBranchMergeTool({...context,tool,args});
  return{data,store,archive,user,p,write,session,run,native,service,context,call,events,signal};
}
const head=f=>f.store.branchFor(f.user,f.p,'main').head;
const preview=f=>f.call('branch_merge_preview',{expected_head:head(f),source_branch_ids:['source']});
const apply=(f,plan,resolutions={})=>f.call('branch_merge_apply',{preview_id:plan.preview_id,plan_identity:plan.plan_identity,expected_head:plan.target_revision,resolutions});

test('Agent preview/review are compact candidates, while explicit fragments are bounded source data',async t=>{
  const f=fixture(t);f.write('source',{'scene.tscn':scene.replace('process_priority = 0','process_priority = 5\n# untrusted-source-text')} );f.write('main',{'scene.tscn':scene.replace('process_priority = 0','process_priority = 9')});const before=head(f),count=f.store.list('creator_revision').length,plan=await preview(f);
  assert.equal(plan.conflict_count,1);assert.ok(!JSON.stringify(plan).includes('untrusted-source-text'));const conflicts=await f.call('branch_merge_read',{preview_id:plan.preview_id,section:'conflicts',limit:1});assert.equal(conflicts.items.length,1);
  const fragment=await f.call('branch_merge_read',{preview_id:plan.preview_id,section:'fragment',conflict_key:plan.conflicts[0].key,side:'source',length:8});assert.equal(fragment.text.length,8);assert.equal(fragment.data_only,true);
  const reviewed=await f.call('branch_merge_review',{preview_id:plan.preview_id,resolutions:{[plan.conflicts[0].key]:'source'}});assert.equal(reviewed.unresolved_count,0);assert.equal(reviewed.source_saved,false);assert.equal(head(f),before);assert.equal(f.store.list('creator_revision').length,count);
});

test('Agent apply records one source commit and current run causality, and retries replay exactly once',async t=>{
  const f=fixture(t);f.write('source',{'scene.tscn':scene.replace('visible = true','visible = false')});const plan=await preview(f),count=f.store.list('creator_revision').length,result=await apply(f,plan);
  assert.equal(result.source_saved,true);assert.equal(f.store.list('creator_revision').length,count+1);assert.deepEqual(f.store.get('creator_run',f.run.id).changes,[result.revision]);const revision=f.store.get('creator_revision',result.revision);assert.equal(revision.origin.run_id,f.run.id);assert.equal(revision.origin.lease_generation,1);assert.equal(f.events.length,1);
  const retry=await apply(f,plan);assert.equal(retry.replayed,true);assert.equal(retry.revision,result.revision);assert.equal(f.events.length,1);assert.equal(f.store.list('creator_revision').length,count+1);
});

test('Agent tools cannot select another target branch, escape session scope, or apply in plan mode',async t=>{
  const f=fixture(t);f.write('source',{'changed.txt':'change'});const plan=await preview(f),before=head(f);
  await assert.rejects(f.call('branch_merge_preview',{expected_head:before,source_branch_ids:['source'],target_branch_id:'other'}),error=>error.status===422);
  const other=f.service.nativeMerges.preview(f.user,f.p,'other',{source_branch_ids:['source']});await assert.rejects(f.call('branch_merge_read',{preview_id:other.id}),error=>error.status===404);
  const run=f.store.get('creator_run',f.run.id);run.execution_mode='plan';f.store.put('creator_run',run);assert.ok(await f.call('branch_merge_review',{preview_id:plan.preview_id}));await assert.rejects(apply(f,plan),error=>error.status===403);assert.equal(head(f),before);
  assert.deepEqual(BRANCH_MERGE_READ_TOOLS,BRANCH_MERGE_TOOLS.map(tool=>tool.name).filter(name=>name!=='branch_merge_apply'));
});

test('stale plans remain explainable, but review and apply reject moved heads until a fresh preview',async t=>{
  const f=fixture(t);f.write('source',{'changed.txt':'first'});const plan=await preview(f);f.write('source',{'changed.txt':'later'});const before=head(f);
  assert.equal((await f.call('branch_merge_read',{preview_id:plan.preview_id})).stale,true);await assert.rejects(f.call('branch_merge_review',{preview_id:plan.preview_id}),error=>error.details?.code==='native_merge_stale_plan');await assert.rejects(apply(f,plan),error=>error.details?.code==='native_merge_stale_plan');assert.equal(head(f),before);
  const fresh=await preview(f);assert.notEqual(fresh.plan_identity,plan.plan_identity);assert.equal((await apply(f,fresh)).source_saved,true);
});

test('cancelled execution cannot publish a candidate that finishes after its lease ends',async t=>{
  const f=fixture(t);f.write('source',{'changed.txt':'value'});const plan=await preview(f),before=head(f);let started,release;const begun=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>release=resolve),inspect=f.native.inspectFiles;f.native.inspectFiles=async files=>{started();await wait;return inspect(files);};
  const pending=apply(f,plan);await begun;const run=f.store.get('creator_run',f.run.id);run.status='interrupted';run.lease_generation++;f.store.put('creator_run',run);release();await assert.rejects(pending,error=>error.status===409);assert.equal(head(f),before);assert.deepEqual(f.store.get('creator_run',f.run.id).changes,[]);
});

test('revert preview and apply use the same target/run guards and preserve later independent edits',async t=>{
  const f=fixture(t);f.write('source',{'scene.tscn':scene.replace('visible = true','visible = false')});const merged=await apply(f,await preview(f));const after=f.archive.read(f.store.get('creator_revision',merged.revision).manifest.source_files['scene.tscn']).toString();f.write('main',{'scene.tscn':after.replace('process_priority = 0','process_priority = 7')});
  const revert=await f.call('branch_merge_preview',{expected_head:head(f),revert_revision:merged.revision});assert.equal(revert.kind,'revert');const result=await apply(f,revert),text=f.archive.read(f.store.get('creator_revision',result.revision).manifest.source_files['scene.tscn']).toString();assert.match(text,/visible = true/);assert.match(text,/process_priority = 7/);
});

test('merge discussion attachment is immutable, scoped and draft-only, without a new Agent turn',async t=>{
  const f=fixture(t);f.write('source',{'changed.txt':'first'});const plan=await preview(f),count=f.store.list('creator_run').length,attached=createBranchMergeDraft(f.service,f.user,f.session.id,{preview_id:plan.preview_id,note:'解释冲突后再讨论',request_id:'attach-one'});
  assert.equal(attached.draft_only,true);assert.equal(attached.attachment.role,'reference');assert.equal(f.store.list('creator_message').length,0);assert.equal(f.store.list('creator_run').length,count);assert.equal(f.store.sessionFor(f.user,f.session.id).draft_attachments.length,1);
  const frozen=structuredClone(attached.attachment);f.write('source',{'changed.txt':'later'});const replay=createBranchMergeDraft(f.service,f.user,f.session.id,{preview_id:plan.preview_id,note:'解释冲突后再讨论',request_id:'attach-one'});assert.deepEqual(replay.attachment,frozen);assert.equal(f.store.sessionFor(f.user,f.session.id).draft_attachments.length,1);
  const another=f.store.createSession(f.user,f.p,'other',{visibility:'private'});assert.throws(()=>createBranchMergeDraft(f.service,f.user,another.id,{preview_id:plan.preview_id}),error=>error.status===409);
});

test('binary conflict reads expose references, not inline asset bytes',async t=>{
  const f=fixture(t);f.write('source',{'asset.bin':Buffer.from([0,1,2])});f.write('main',{'asset.bin':Buffer.from([0,4,5])});const plan=await preview(f),read=await f.call('branch_merge_read',{preview_id:plan.preview_id,section:'fragment',conflict_key:plan.conflicts[0].key,side:'source'});
  assert.equal(read.encoding,'asset-reference');assert.equal(read.source.size,3);assert.ok(!Object.hasOwn(read,'text'));assert.ok(!Object.hasOwn(read,'data_base64'));
});
