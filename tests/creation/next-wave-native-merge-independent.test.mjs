/** Independent N/A evidence only: real source blobs and SQLite transactions.
 * inspectFiles is an explicit index fixture; no Godot/browser/gameplay claim.
 * Run only after the implementation is announced ready. Optional source root
 * selects an isolated developer checkout before main integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT} from './next-wave-test-support.mjs';

const subject = resolve(process.env.WORLD_ATELIER_NEXT_WAVE_SOURCE_ROOT ?? ROOT);
const load = name => import(pathToFileURL(join(subject, name)).href);
assert.ok(existsSync(join(subject, 'services/creation/native-merge-engine.mjs')), 'NOT_READY: fine-grained native merge implementation has not been integrated.');
const {mergeNativeFiles, nativeMergeBases} = await load('services/creation/native-merge-engine.mjs');
const {NativeSourceArchive, nativeSourceIdentity} = await load('services/creation/native-source.mjs');
const {NativeMerges} = await load('services/creation/native-merge.mjs');
const {NativeTransactions} = await load('services/creation/native-transactions.mjs');
const {CreationStore} = await load('services/creation/store.mjs');

function archiveFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'atelier-next-wave-merge-'));
  const cleanup=[];
  t.after(() => {for(const close of cleanup)close();rmSync(directory, {recursive:true, force:true});});
  const archive = new NativeSourceArchive(join(directory, 'blobs'));
  const files = texts => Object.fromEntries(Object.entries(texts).map(([path, text]) => [path, archive.put(Buffer.isBuffer(text) ? text : Buffer.from(text))]));
  const merge = (base, source, target, resolutions={}) => mergeNativeFiles({base:files(base), source:files(source), target:files(target), archive, resolutions, prefix:'independent'});
  const read = (result, path) => archive.read(result.files[path]);
  return {directory, archive, files, merge, read, cleanup};
}

const scene = `[gd_scene format=3]\r\n; exact author comment: untouched ; = []\r\n[node name="Root" type="Node3D"]\r\nmetadata/wa_node_id = "root"\r\nmetadata/opaque = {"unicode":"原样", "escaped":"a\\\"b"}\r\nposition = Vector3(0, 0, 0)\r\nrotation = Vector3(0, 0, 0)\r\nscale = Vector3(1, 1, 1)\r\nhealth = 10\r\nspeed = 2\r\n\r\n[node name="Child" type="Node3D" parent="."]\r\nmetadata/wa_node_id = "child"\r\nvisible = true\r\n`;

test('M01 independent properties preserve exact untouched native tokens and binary bytes', t => {
  const f=archiveFixture(t), untouched=Buffer.from([0,255,13,10,128,42]);
  const base={'scene.tscn':scene,'unknown/author.bin':untouched};
  const result=f.merge(base,{...base,'scene.tscn':scene.replace('health = 10','health = 18')},{...base,'scene.tscn':scene.replace('speed = 2','speed = 7')});
  assert.deepEqual(result.unresolved,[]);
  assert.equal(f.read(result,'scene.tscn').toString(),scene.replace('health = 10','health = 18').replace('speed = 2','speed = 7'));
  assert.deepEqual(f.read(result,'unknown/author.bin'),untouched);
});

test('M01 nonoverlapping script edits retain CRLF and both original edits',t=>{
  const f=archiveFixture(t),base='extends Node\r\n\r\nvar left = 1\r\n\r\nvar right = 1\r\n';
  const result=f.merge({'actor.gd':base},{'actor.gd':base.replace('left = 1','left = 2')},{'actor.gd':base.replace('right = 1','right = 3')});
  assert.equal(result.unresolved.length,0);
  assert.equal(f.read(result,'actor.gd').toString(),base.replace('left = 1','left = 2').replace('right = 1','right = 3'));
});

test('M01 distinct native properties inserted in the same original gap merge without an artificial ordering choice',t=>{
  const f=archiveFixture(t),base={'scene.tscn':scene};
  const source={'scene.tscn':scene.replace('health = 10','left_added = 11\r\nhealth = 10')},target={'scene.tscn':scene.replace('health = 10','right_added = 12\r\nhealth = 10')};
  const result=f.merge(base,source,target);assert.deepEqual(result.unresolved,[]);
  const bytes=f.read(result,'scene.tscn').toString();assert.match(bytes,/left_added = 11\r\n/);assert.match(bytes,/right_added = 12\r\n/);assert.ok(bytes.indexOf('left_added')<bytes.indexOf('health = 10'));assert.ok(bytes.indexOf('right_added')<bytes.indexOf('health = 10'));
  assert.equal(bytes.replace('left_added = 11\r\n','').replace('right_added = 12\r\n',''),scene,'Unknown original author bytes remain exact.');
});

test('M02 one shared newly added property cannot occupy opposite positions around an existing property silently',t=>{
  const f=archiveFixture(t),base={'scene.tscn':scene};
  const source={'scene.tscn':scene.replace('health = 10','shared_added = 11\r\nhealth = 10')},target={'scene.tscn':scene.replace('health = 10','health = 10\r\nshared_added = 11')};
  const result=f.merge(base,source,target);assert.ok(result.unresolved.some(row=>row.kind==='order'));
});

test('M02 opposite order of the same newly added properties still requires an explicit ordering choice',t=>{
  const f=archiveFixture(t),base={'scene.tscn':scene};
  const source={'scene.tscn':scene.replace('health = 10','left_added = 11\r\nright_added = 12\r\nhealth = 10')},target={'scene.tscn':scene.replace('health = 10','right_added = 12\r\nleft_added = 11\r\nhealth = 10')};
  const result=f.merge(base,source,target);assert.ok(result.unresolved.some(row=>row.kind==='order'));
});

test('M02 concurrent new sibling node sections retain their separate ordering conflict',t=>{
  const f=archiveFixture(t),base={'scene.tscn':scene},insert=name=>`[node name="${name}" type="Node3D" parent="."]\r\nmetadata/wa_node_id = "${name}"\r\n`;
  const source={'scene.tscn':scene.replace('[node name="Child"',insert('AddedLeft')+'[node name="Child"')},target={'scene.tscn':scene.replace('[node name="Child"',insert('AddedRight')+'[node name="Child"')};
  const result=f.merge(base,source,target);assert.ok(result.unresolved.some(row=>row.kind==='order'));
});

test('M02 same-property conflict is local, exact-input-bound and keeps independent changes',t=>{
  const f=archiveFixture(t),base={'scene.tscn':scene},source={'scene.tscn':scene.replace('health = 10','health = 18')},target={'scene.tscn':scene.replace('health = 10','health = 19').replace('speed = 2','speed = 7')};
  const first=f.merge(base,source,target);assert.equal(first.unresolved.length,1);
  const conflict=first.unresolved[0];assert.equal(conflict.property,'health');assert.match(conflict.fingerprint,/^[a-f0-9]{64}$/);
  const chosen=f.merge(base,source,target,{[conflict.key]:'source'});assert.equal(chosen.unresolved.length,0);
  assert.equal(f.read(chosen,'scene.tscn').toString(),scene.replace('health = 10','health = 18').replace('speed = 2','speed = 7'));
  const newer=f.merge(base,{'scene.tscn':scene.replace('health = 10','health = 20')},target,{[conflict.key]:'source'});
  assert.equal(newer.unresolved.length,1);assert.notEqual(newer.unresolved[0].key,conflict.key);
});

test('M02 delete versus edit and reset versus explicit value require a decision',t=>{
  const f=archiveFixture(t),base={'scene.tscn':scene};
  const reset={'scene.tscn':scene.replace('health = 10\r\n','')},changed={'scene.tscn':scene.replace('health = 10','health = 12')};
  assert.ok(f.merge(base,reset,changed).unresolved.length>0);
  const deleted={'scene.tscn':scene.slice(0,scene.indexOf('[node name="Child"'))},edited={'scene.tscn':scene.replace('visible = true','visible = false')};
  assert.ok(f.merge(base,deleted,edited).unresolved.some(c=>c.kind==='delete_modify'));
});

test('M03 split transform properties remain one concurrent transform choice',t=>{
  const f=archiveFixture(t),base={'scene.tscn':scene};
  const source={'scene.tscn':scene.replace('position = Vector3(0, 0, 0)','position = Vector3(3, 0, 0)')};
  const target={'scene.tscn':scene.replace('rotation = Vector3(0, 0, 0)','rotation = Vector3(0, 0.75, 0)')};
  const result=f.merge(base,source,target);
  assert.ok(result.unresolved.length>0,'Independent position/rotation edits must not silently invent a combined transform.');
});

test('M03 full matrices and invalid UTF-8 are never decomposed or decoded lossily',t=>{
  const f=archiveFixture(t),before='[gd_scene format=3]\n[node name="Root" type="Node3D"]\nmetadata/wa_node_id="root"\ntransform = Transform3D(-1,0,0,0.25,2,0,0,0,1,3,4,5)\n';
  const result=f.merge({'matrix.tscn':before},{'matrix.tscn':before.replace('0.25,2','0.5,2')},{'matrix.tscn':before.replace('3,4,5','7,4,5')});
  assert.ok(result.unresolved.length>0);
  const binary=f.merge({'raw.bin':Buffer.from([255,254,65])},{'raw.bin':Buffer.from([255,254,66])},{'raw.bin':Buffer.from([255,254,67])});
  assert.equal(binary.unresolved.length,1);assert.equal(binary.unresolved[0].kind,'binary');
  const chosen=f.merge({'raw.bin':Buffer.from([255,254,65])},{'raw.bin':Buffer.from([255,254,66])},{'raw.bin':Buffer.from([255,254,67])},{[binary.unresolved[0].key]:'source'});
  assert.deepEqual(f.read(chosen,'raw.bin'),Buffer.from([255,254,66]));
});

test('M02 reparenting plus another-side child property change cannot silently combine',t=>{
  const f=archiveFixture(t),before=scene+'[node name="Other" type="Node3D" parent="."]\r\nmetadata/wa_node_id = "other"\r\n';
  const source=before.replace('[node name="Child" type="Node3D" parent="."]','[node name="Child" type="Node3D" parent="Other"]');
  const target=before.replace('visible = true','visible = false');
  assert.ok(f.merge({'scene.tscn':before},{'scene.tscn':source},{'scene.tscn':target}).unresolved.length>0);
});

test('M02 external resource identity reuse conflicts instead of redirecting untouched references',t=>{
  const f=archiveFixture(t),before='[gd_scene load_steps=2 format=3]\n[ext_resource type="Material" path="res://red.tres" id="1"]\n[node name="Root" type="Node3D"]\nmetadata/wa_node_id="root"\nmaterial=ExtResource("1")\nvisible=true\n';
  const result=f.merge({'scene.tscn':before},{'scene.tscn':before.replace('red.tres','blue.tres')},{'scene.tscn':before.replace('visible=true','visible=false')});
  assert.ok(result.unresolved.some(c=>c.kind==='resource_identity'));
});

test('M01 identical internal node IDs in separate stable instance chains do not alias',t=>{
  const f=archiveFixture(t),before='[gd_scene format=3]\n[node name="Root" type="Node3D"]\nmetadata/wa_node_id="root"\n[node name="A" type="Node3D" parent="."]\nmetadata/wa_instance_id="instance-a"\n[node name="Part" type="Node3D" parent="A"]\nmetadata/wa_node_id="part"\nhealth=1\n[node name="B" type="Node3D" parent="."]\nmetadata/wa_instance_id="instance-b"\n[node name="Part" type="Node3D" parent="B"]\nmetadata/wa_node_id="part"\nhealth=1\n';
  const source=before.replace('health=1','health=2'),last=before.lastIndexOf('health=1'),target=before.slice(0,last)+'health=3'+before.slice(last+8);
  const result=f.merge({'scene.tscn':before},{'scene.tscn':source},{'scene.tscn':target});
  assert.equal(result.unresolved.length,0);const merged=f.read(result,'scene.tscn').toString();assert.match(merged,/parent="A"[\s\S]*?health=2/);assert.match(merged,/parent="B"[\s\S]*?health=3/);
});

test('M05 all best common ancestors are returned and invalid history is rejected',()=>{
  const rows=new Map(Object.entries({o:[],a:['o'],b:['o'],x:['a','b'],y:['b','a'],z:['x'],q:[]}).map(([id,parents])=>[id,{id,parents}]));
  const store={get:(_kind,id)=>rows.get(id)};
  assert.deepEqual(nativeMergeBases(store,['x'],['y']),['a','b']);
  assert.deepEqual(nativeMergeBases(store,['z'],['a']),['a']);
  assert.deepEqual(nativeMergeBases(store,['x'],['q']),[]);
  rows.set('cycle',{id:'cycle',parents:['cycle']});assert.throws(()=>nativeMergeBases(store,['cycle'],['o']),error=>error.details?.code==='native_merge_invalid_history');
  assert.throws(()=>nativeMergeBases(store,['missing'],['o']),error=>error.details?.code==='native_merge_missing_history');
});

function transactionFixture(t) {
  const f=archiveFixture(t),store=new CreationStore(join(f.directory,'creation.sqlite'));
  f.cleanup.push(()=>store.close());
  const owner=store.register({name:'Merge owner',password:'test-password-merge-20261023'}).user;
  const editor=store.register({name:'Merge editor',password:'test-password-merge-20261023'}).user;
  const manifest=files=>({schema:'creation-native-1',source_files:files,source_identity:nativeSourceIdentity(files),index_source_identity:nativeSourceIdentity(files),entry_scene_id:'entry',resources:{entry:{id:'entry',kind:'scene',name:'Index fixture only',path:'scene.tscn',native_nodes:[]}}});
  const initial=f.files({'scene.tscn':scene,'notes.txt':'alpha\nbeta\ngamma\n'}),created=store.createProject(owner,{name:'Independent transaction fixture'},manifest(initial)),p=created.project.id;
  const project=store.get('creator_project',p);project.members[editor.id]='editor';store.put('creator_project',project);
  const transactions=new NativeTransactions({store,archive:f.archive,prepare:()=>{throw Error('Unexpected prepare: this is not a Godot execution test.');}});
  const native={archive:f.archive,transactions,inspectFiles:async files=>manifest(files)};
  const merges=new NativeMerges({store,native});
  const fork=b=>store.fork(owner,p,{from_branch:'main',branch_id:b,name:b});
  const commit=(b,texts)=>{
    const branch=store.branchFor(owner,p,b,true),old=store.get('creator_revision',branch.head),files={...old.manifest.source_files};
    for(const [path,value] of Object.entries(texts)){if(value===null)delete files[path];else files[path]=f.archive.put(Buffer.isBuffer(value)?value:Buffer.from(value));}
    const revision=store.writeRevision(p,[branch.head],manifest(files),owner.id);store.put('creator_branch',{...branch,head:revision.id});return revision;
  };
  const text=(b,path)=>f.archive.read(store.get('creator_revision',store.branchFor(owner,p,b).head).manifest.source_files[path]).toString();
  return {...f,store,owner,editor,p,manifest,native,merges,fork,commit,text};
}

test('M04 real SQLite publishes exactly one multi-parent result and one replayable receipt',async t=>{
  const f=transactionFixture(t),old=f.store.branchFor(f.owner,f.p,'main').head;f.fork('art');f.fork('logic');
  const art=f.commit('art',{'scene.tscn':scene.replace('health = 10','health = 18')}),logic=f.commit('logic',{'scene.tscn':scene.replace('speed = 2','speed = 7')});
  const before=f.store.list('creator_revision').length,events=f.store.activity(f.p).length;
  const plan=f.merges.preview(f.owner,f.p,'main',{source_branch_ids:['art','logic']});
  assert.equal(f.store.branchFor(f.owner,f.p,'main').head,old);assert.equal(f.store.list('creator_revision').length,before);
  const result=await f.merges.merge(f.owner,f.p,'main',{preview_id:plan.id,resolutions:{}});
  assert.equal(f.store.list('creator_revision').length,before+1);
  assert.deepEqual(new Set(f.store.get('creator_revision',result.revision).parents),new Set([old,art.id,logic.id]));
  assert.equal(f.store.activity(f.p).length,events+1);
  assert.equal(f.store.list('creator_receipt').filter(row=>row.id===`merge:${f.p}:main:${plan.id}`).length,1);
  assert.equal(f.text('main','scene.tscn'),scene.replace('health = 10','health = 18').replace('speed = 2','speed = 7'));
  const replay=await f.merges.merge(f.owner,f.p,'main',{preview_id:plan.id,resolutions:{}});assert.equal(replay.replayed,true);assert.equal(replay.revision,result.revision);assert.equal(f.store.list('creator_revision').length,before+1);
  const again=f.merges.preview(f.owner,f.p,'main',{source_branch_ids:['art','logic']}),unchanged=await f.merges.merge(f.owner,f.p,'main',{preview_id:again.id});assert.equal(unchanged.unchanged,true);assert.equal(unchanged.revision,result.revision);
});

test('M04 a moved later source invalidates the whole plan without an intermediate commit',async t=>{
  const f=transactionFixture(t);f.fork('art');f.fork('logic');f.commit('art',{'notes.txt':'one\nbeta\ngamma\n'});f.commit('logic',{'scene.tscn':scene.replace('speed = 2','speed = 7')});
  const plan=f.merges.preview(f.owner,f.p,'main',{source_branch_ids:['art','logic']}),before=f.store.branchFor(f.owner,f.p,'main').head;
  f.commit('logic',{'scene.tscn':scene.replace('speed = 2','speed = 9')});const revisionCount=f.store.list('creator_revision').length;
  await assert.rejects(f.merges.merge(f.owner,f.p,'main',{preview_id:plan.id}),error=>error.details?.code==='native_merge_stale_plan');
  assert.equal(f.store.branchFor(f.owner,f.p,'main').head,before);assert.equal(f.store.list('creator_revision').length,revisionCount);assert.equal(f.store.list('creator_receipt').length,0);
});

test('M04 permission changes during asynchronous indexing prevent the SQLite commit',async t=>{
  const f=transactionFixture(t);f.fork('art');f.commit('art',{'notes.txt':'one\nbeta\ngamma\n'});
  const plan=f.merges.preview(f.editor,f.p,'main',{source_branch_ids:['art']}),before=f.store.branchFor(f.owner,f.p,'main').head;
  f.native.inspectFiles=async files=>{const project=f.store.get('creator_project',f.p);delete project.members[f.editor.id];f.store.put('creator_project',project);return f.manifest(files);};
  await assert.rejects(f.merges.merge(f.editor,f.p,'main',{preview_id:plan.id}),error=>error.status===403);
  assert.equal(f.store.branchFor(f.owner,f.p,'main').head,before);assert.equal(f.store.list('creator_receipt').length,0);
});

test('M04 receipt storage failure rolls back revision, branch and activity in real SQLite',async t=>{
  const f=transactionFixture(t);f.fork('art');f.commit('art',{'notes.txt':'one\nbeta\ngamma\n'});
  const plan=f.merges.preview(f.owner,f.p,'main',{source_branch_ids:['art']}),before=f.store.branchFor(f.owner,f.p,'main').head,count=f.store.list('creator_revision').length,activity=f.store.activity(f.p),put=f.store.put.bind(f.store);
  f.store.put=(kind,value)=>{if(kind==='creator_receipt')throw Error('Independent injected receipt storage failure');return put(kind,value);};
  await assert.rejects(f.merges.merge(f.owner,f.p,'main',{preview_id:plan.id}),/Independent injected receipt/);f.store.put=put;
  assert.equal(f.store.branchFor(f.owner,f.p,'main').head,before);assert.equal(f.store.list('creator_revision').length,count);assert.deepEqual(f.store.activity(f.p),activity);
});

test('M07 compensation preserves a collaborator edit made after the merge',async t=>{
  const f=transactionFixture(t);f.fork('art');f.commit('art',{'scene.tscn':scene.replace('health = 10','health = 18')});
  const plan=f.merges.preview(f.owner,f.p,'main',{source_branch_ids:['art']}),merged=await f.merges.merge(f.owner,f.p,'main',{preview_id:plan.id});
  const later=f.commit('main',{'scene.tscn':scene.replace('health = 10','health = 18').replace('speed = 2','speed = 7')});
  const undo=f.merges.revertPreview(f.owner,f.p,'main',{revision:merged.revision}),result=await f.merges.merge(f.owner,f.p,'main',{preview_id:undo.id});
  assert.notEqual(result.revision,later.id);assert.deepEqual(f.store.get('creator_revision',result.revision).parents,[later.id]);
  assert.equal(f.text('main','scene.tscn'),scene.replace('speed = 2','speed = 7'));
});

test('M07 compensation conflicts with a later same-property edit and leaves all source versions readable',async t=>{
  const f=transactionFixture(t);f.fork('art');f.commit('art',{'scene.tscn':scene.replace('health = 10','health = 18')});
  const plan=f.merges.preview(f.owner,f.p,'main',{source_branch_ids:['art']}),merged=await f.merges.merge(f.owner,f.p,'main',{preview_id:plan.id});
  const later=f.commit('main',{'scene.tscn':scene.replace('health = 10','health = 25')}),undo=f.merges.revertPreview(f.owner,f.p,'main',{revision:merged.revision});
  assert.ok(undo.unresolved_count>0);await assert.rejects(f.merges.merge(f.owner,f.p,'main',{preview_id:undo.id}),error=>error.details?.code==='native_merge_conflicts');
  assert.equal(f.store.branchFor(f.owner,f.p,'main').head,later.id);assert.ok(f.store.get('creator_revision',merged.revision));
  assert.equal(f.text('main','scene.tscn'),scene.replace('health = 10','health = 25'));
});
