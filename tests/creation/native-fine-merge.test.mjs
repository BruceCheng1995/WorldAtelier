import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeSourceArchive,NATIVE_SCHEMA,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {mergeNativeFiles,nativeMergeBases,nativeTextHunks,parseNativeText} from '../../services/creation/native-merge-engine.mjs';
import {NativeMerges} from '../../services/creation/native-merge.mjs';
import {NativeTransactions} from '../../services/creation/native-transactions.mjs';
import {CreationStore} from '../../services/creation/store.mjs';

const scene='[gd_scene format=3]\n\n[node name="Root" type="Node3D"]\nmetadata/wa_node_id = "root"\nposition = Vector3(1, 2, 3)\nunknown_future_property = {\n"preserve": [1, 2, 3]\n}\nvisible = true\n\n[node name="Other" type="Node3D" parent="."]\nmetadata/wa_node_id = "other"\nposition = Vector3(0, 0, 0)\n';
function archiveFixture(t){const root=mkdtempSync(join(tmpdir(),'wa-fine-merge-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const archive=new NativeSourceArchive(join(root,'objects'));const manifest=values=>Object.fromEntries(Object.entries(values).map(([path,value])=>[path,archive.put(value)]));return{root,archive,manifest};}
const resultText=(archive,result,path='scene.tscn')=>archive.read(result.files[path]).toString();

test('native lossless view preserves every byte including unknown multiline properties',()=>{
  const parsed=parseNativeText(scene);assert.ok(parsed);assert.equal(parsed.prefix+parsed.sections.map(s=>s.raw).join(''),scene);assert.equal(parsed.sections[1].key,'node/[[],"root"]');
  const withString=scene.replace('visible = true','custom = "first\n[node not_a_section]\nlast"\nvisible = true');assert.ok(parseNativeText(withString));assert.equal(parseNativeText(withString).sections.length,3);
});

test('stable instance chains include mount ancestors omitted by inherited scene serialization',()=>{
  const text='[gd_scene format=3]\n[node name="Root" type="Node3D"]\nmetadata/wa_node_id = "root"\n[node name="A" type="Node3D" parent="."]\nmetadata/wa_instance_id = "instance-a"\n[node name="Leaf" type="Node3D" parent="A/InheritedParent"]\nmetadata/wa_node_id = "shared-leaf"\n[node name="B" type="Node3D" parent="."]\nmetadata/wa_instance_id = "instance-b"\n[node name="Leaf" type="Node3D" parent="B/InheritedParent"]\nmetadata/wa_node_id = "shared-leaf"\n';
  const parsed=parseNativeText(text);assert.ok(parsed);assert.ok(parsed.byKey.has('node/[["instance-a"],"shared-leaf"]'));assert.ok(parsed.byKey.has('node/[["instance-b"],"shared-leaf"]'));
});

test('different native properties merge without serializing unknown source or flattening inheritance',t=>{
  const {archive,manifest}=archiveFixture(t),base=manifest({'scene.tscn':scene,'unknown.bin':Buffer.from([0,255,2])});
  const source=manifest({'scene.tscn':scene.replace('position = Vector3(1, 2, 3)','position = Vector3(-1, 2, 3)'),'unknown.bin':Buffer.from([0,255,2])});
  const target=manifest({'scene.tscn':scene.replace('visible = true','visible = false'),'unknown.bin':Buffer.from([0,255,2])});
  const result=mergeNativeFiles({base,source,target,archive});assert.equal(result.unresolved.length,0);assert.equal(result.statistics.native_merges,1);
  assert.equal(resultText(archive,result),scene.replace('position = Vector3(1, 2, 3)','position = Vector3(-1, 2, 3)').replace('visible = true','visible = false'));
  assert.deepEqual(result.files['unknown.bin'],base['unknown.bin']);
});

test('same native property creates local stable conflict; resolving it retains unrelated edits',t=>{
  const {archive,manifest}=archiveFixture(t),base=manifest({'scene.tscn':scene}),source=manifest({'scene.tscn':scene.replace('Vector3(1, 2, 3)','Vector3(8, 2, 3)').replace('visible = true','visible = false')}),target=manifest({'scene.tscn':scene.replace('Vector3(1, 2, 3)','Vector3(9, 2, 3)').replace('Vector3(0, 0, 0)','Vector3(0, 4, 0)')});
  const first=mergeNativeFiles({base,source,target,archive,prefix:'source/a'});assert.equal(first.unresolved.length,1);const conflict=first.unresolved[0];assert.equal(conflict.kind,'transform');assert.equal(conflict.property,'transform');
  const merged=mergeNativeFiles({base,source,target,archive,prefix:'source/a',resolutions:{[conflict.key]:'source'}});assert.equal(merged.unresolved.length,0);assert.match(resultText(archive,merged),/Vector3\(8, 2, 3\)/);assert.match(resultText(archive,merged),/Vector3\(0, 4, 0\)/);assert.match(resultText(archive,merged),/visible = false/);
});

test('removed explicit override differs from an explicit default and transform values remain atomic',t=>{
  const {archive,manifest}=archiveFixture(t),base=manifest({'scene.tscn':scene}),source=manifest({'scene.tscn':scene.replace('position = Vector3(1, 2, 3)\n','')}),target=manifest({'scene.tscn':scene.replace('Vector3(1, 2, 3)','Vector3(0, 0, 0)')});
  const result=mergeNativeFiles({base,source,target,archive});assert.equal(result.unresolved.length,1);assert.equal(result.unresolved[0].source,'');
});

test('separately serialized position and rotation are still one atomic transform conflict',t=>{
  const {archive,manifest}=archiveFixture(t),text=scene.replace('visible = true','rotation = Vector3(0, 0, 0)\nvisible = true');
  const result=mergeNativeFiles({base:manifest({'scene.tscn':text}),source:manifest({'scene.tscn':text.replace('Vector3(1, 2, 3)','Vector3(4, 2, 3)')}),target:manifest({'scene.tscn':text.replace('rotation = Vector3(0, 0, 0)','rotation = Vector3(0, 1, 0)')}),archive});
  assert.equal(result.unresolved.length,1);assert.equal(result.unresolved[0].kind,'transform');assert.deepEqual(result.unresolved[0].properties,['position','rotation']);
});

test('delete versus edit, binary changes and unknown native syntax preserve three originals',t=>{
  const {archive,manifest}=archiveFixture(t),base=manifest({'scene.tscn':scene,'asset.bin':Buffer.from([0,1])}),source=manifest({'asset.bin':Buffer.from([0,2])}),target=manifest({'scene.tscn':scene.replace('visible = true','visible = false'),'asset.bin':Buffer.from([0,3])});
  const result=mergeNativeFiles({base,source,target,archive});assert.equal(result.unresolved.length,2);assert.deepEqual(new Set(result.unresolved.map(c=>c.kind)),new Set(['delete_modify','binary']));
  for(const entry of Object.values(base))assert.ok(archive.read(entry));
  const invalid=manifest({'scene.tscn':'[gd_scene format=3]\nUNRECOGNIZED source\n'}),other=manifest({'scene.tscn':'[gd_scene format=3]\nUNRECOGNIZED target\n'});const unknown=mergeNativeFiles({base:{'scene.tscn':base['scene.tscn']},source:invalid,target:other,archive});assert.equal(unknown.unresolved[0].kind,'native_unparsed');
});

test('renaming/reparenting with other-side properties is an explicit structure conflict',t=>{
  const {archive,manifest}=archiveFixture(t),base=manifest({'scene.tscn':scene}),source=manifest({'scene.tscn':scene.replace('name="Other"','name="Renamed"')}),target=manifest({'scene.tscn':scene.replace('Vector3(0, 0, 0)','Vector3(2, 0, 0)')});
  const result=mergeNativeFiles({base,source,target,archive});assert.equal(result.unresolved[0].kind,'structure_with_edits');
});

test('disjoint text changes preserve CRLF and inserted lines; conflicts are bounded hunks',t=>{
  const {archive,manifest}=archiveFixture(t),text='first\r\nsecond\r\nthird\r\nfourth\r\n',base=manifest({'code.gd':text}),source=manifest({'code.gd':text.replace('first','FIRST')}),target=manifest({'code.gd':text.replace('fourth','FOURTH')});
  const result=mergeNativeFiles({base,source,target,archive});assert.equal(result.unresolved.length,0);assert.equal(resultText(archive,result,'code.gd'),'FIRST\r\nsecond\r\nthird\r\nFOURTH\r\n');
  const conflict=mergeNativeFiles({base,source,target:manifest({'code.gd':text.replace('first','another')}),archive});assert.equal(conflict.unresolved.length,1);assert.equal(conflict.unresolved[0].line_start,1);
});

test('text files added on both sides allow one explicit combined result while binary extensions stay opaque',t=>{
  const {archive,manifest}=archiveFixture(t),base={},source=manifest({'new.gd':'source code\n','opaque.bin':'ascii source'}),target=manifest({'new.gd':'target code\n','opaque.bin':'ascii target'}),plan=mergeNativeFiles({base,source,target,archive}),text=plan.conflicts.find(item=>item.path==='new.gd'),binary=plan.conflicts.find(item=>item.path==='opaque.bin');
  assert.ok(text.choices.includes('manual'));assert.ok(!binary.choices.includes('manual'));const result=mergeNativeFiles({base,source,target,archive,resolutions:{[text.key]:{choice:'manual',text:'combined code\n'},[binary.key]:'target'}});assert.equal(result.unresolved.length,0);assert.equal(resultText(archive,result,'new.gd'),'combined code\n');assert.equal(result.files['opaque.bin'].hash,target['opaque.bin'].hash);
});

test('text hunk reconstruction is exact for repeated lines, insertions, deletions and deterministic random edits',()=>{
  let seed=97531;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let trial=0;trial<200;trial++){const base=Array.from({length:random(25)},()=>String(random(7))+'\n'),other=[...base];for(let i=0;i<8;i++)other.splice(random(other.length+1),random(3),...Array.from({length:random(3)},()=>String(random(7))+'\n'));const hunks=nativeTextHunks(base,other);let cursor=0,result=[];for(const hunk of hunks){result.push(...base.slice(cursor,hunk.start),...hunk.lines);cursor=hunk.end;}result.push(...base.slice(cursor));assert.deepEqual(result,other);}
});

function storeFixture(t){
  const f=archiveFixture(t),store=new CreationStore(join(f.root,'creation.sqlite'));t.after(()=>store.close());const user=store.register({name:'merge-owner',password:'test-password'}).user;
  const created=store.createProject(user,{name:'Native merge'},{entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]}}}),p=created.project.id;
  const candidate=files=>{const identity=nativeSourceIdentity(files);return{schema:NATIVE_SCHEMA,source_files:files,source_identity:identity,index_source_identity:identity,entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',version:identity,native_nodes:[]}}};};
  const write=(branchId,values)=>{const branch=store.branchFor(user,p,branchId),previous=store.get('creator_revision',branch.head).manifest.source_files??{},files={...previous,...f.manifest(values)};branch.head=store.writeRevision(p,[branch.head],candidate(files),user.id).id;store.put('creator_branch',branch);return branch.head;};
  write('main',{'project.godot':'config_version=5\n','scene.tscn':scene});
  const native={archive:f.archive,inspectFiles:async files=>candidate(files)};native.transactions=new NativeTransactions({store,archive:f.archive,prepare:()=>{throw Error('Not used');}});
  const merges=new NativeMerges({store,native});const fork=name=>store.fork(user,p,{from_branch:'main',branch_id:name});
  return{...f,store,user,p,candidate,write,native,merges,fork};
}

test('multi-source merge is one final SQLite revision and event, with fixed parents and retry receipt',async t=>{
  const f=storeFixture(t);f.fork('art');f.fork('logic');const target=f.write('main',{'scene.tscn':scene.replace('Vector3(0, 0, 0)','Vector3(0, 9, 0)')}),a=f.write('art',{'scene.tscn':scene.replace('visible = true','visible = false')}),b=f.write('logic',{'scene.tscn':scene.replace('Vector3(1, 2, 3)','Vector3(5, 2, 3)')});
  const plan=f.merges.preview(f.user,f.p,'main',{source_branch_ids:['art','logic']});assert.equal(plan.unresolved_count,0);const revisions=f.store.list('creator_revision').length;
  const result=await f.merges.merge(f.user,f.p,'main',{preview_id:plan.id});assert.equal(f.store.list('creator_revision').length,revisions+1);assert.deepEqual(f.store.get('creator_revision',result.revision).parents,[target,a,b]);
  const merged=f.archive.read(result.branch.manifest.source_files['scene.tscn']).toString();assert.match(merged,/visible = false/);assert.match(merged,/Vector3\(5, 2, 3\)/);assert.match(merged,/Vector3\(0, 9, 0\)/);
  assert.equal((await f.merges.merge(f.user,f.p,'main',{preview_id:plan.id})).replayed,true);assert.equal(f.store.list('creator_revision').length,revisions+1);
  const repeated=f.merges.preview(f.user,f.p,'main',{source_branch_ids:['art','logic']});const unchanged=await f.merges.merge(f.user,f.p,'main',{preview_id:repeated.id});assert.equal(unchanged.unchanged,true);assert.equal(f.store.list('creator_revision').length,revisions+1);
});

test('later sources cannot silently win; missing decisions publish nothing',async t=>{
  const f=storeFixture(t);f.fork('one');f.fork('two');f.write('one',{'scene.tscn':scene.replace('Vector3(1, 2, 3)','Vector3(4, 2, 3)')});f.write('two',{'scene.tscn':scene.replace('Vector3(1, 2, 3)','Vector3(7, 2, 3)')});const head=f.store.branchFor(f.user,f.p,'main').head;
  const plan=f.merges.preview(f.user,f.p,'main',{source_branch_ids:['one','two']});assert.equal(plan.unresolved_count,1);await assert.rejects(f.merges.merge(f.user,f.p,'main',{preview_id:plan.id}),error=>error.details?.code==='native_merge_conflicts');assert.equal(f.store.branchFor(f.user,f.p,'main').head,head);
  const result=await f.merges.merge(f.user,f.p,'main',{preview_id:plan.id,resolutions:{[plan.conflicts[0].key]:'target'}});assert.match(f.archive.read(result.branch.manifest.source_files['scene.tscn']).toString(),/Vector3\(4, 2, 3\)/);
});

test('moved source, target and revoked authority are checked after asynchronous preparation',async t=>{
  for(const reason of ['source','target','permission']){
    const f=storeFixture(t);f.fork('source');f.write('source',{'change.txt':'source'});const plan=f.merges.preview(f.user,f.p,'main',{source_branch_id:'source'});let ready,release;const started=new Promise(r=>ready=r),waiting=new Promise(r=>release=r);f.native.inspectFiles=async files=>{ready();await waiting;return f.candidate(files);};
    const pending=f.merges.merge(f.user,f.p,'main',{preview_id:plan.id});await started;
    if(reason==='permission'){const account=f.store.get('creator_user',f.user.id);account.disabled_at=Date.now();f.store.put('creator_user',account);}else f.write(reason==='source'?'source':'main',{'late.txt':'changed'});
    const head=f.store.get('creator_branch',f.p+':main').head;release();await assert.rejects(pending);assert.equal(f.store.get('creator_branch',f.p+':main').head,head);
  }
});

test('compensating merge revert keeps later edits and conflicts only on changed imported properties',async t=>{
  const f=storeFixture(t);f.fork('source');f.write('source',{'scene.tscn':scene.replace('visible = true','visible = false')});const plan=f.merges.preview(f.user,f.p,'main',{source_branch_id:'source'}),merged=await f.merges.merge(f.user,f.p,'main',{preview_id:plan.id});
  f.write('main',{'scene.tscn':f.archive.read(merged.branch.manifest.source_files['scene.tscn']).toString().replace('Vector3(0, 0, 0)','Vector3(0, 6, 0)')});
  const undo=f.merges.revertPreview(f.user,f.p,'main',{revision:merged.revision});assert.equal(undo.unresolved_count,0);const reverted=await f.merges.merge(f.user,f.p,'main',{preview_id:undo.id});const text=f.archive.read(reverted.branch.manifest.source_files['scene.tscn']).toString();assert.match(text,/visible = true/);assert.match(text,/Vector3\(0, 6, 0\)/);assert.equal(f.store.get('creator_revision',reverted.revision).origin.revert_of,merged.revision);
});

test('best ancestors reject criss-cross ambiguity and unrelated native history',t=>{
  const f=storeFixture(t),base=f.store.branchFor(f.user,f.p,'main').head,manifest=f.store.get('creator_revision',base).manifest;
  const a=f.store.writeRevision(f.p,[base],manifest,f.user.id,{tag:'a'}),b=f.store.writeRevision(f.p,[base],manifest,f.user.id,{tag:'b'}),ab=f.store.writeRevision(f.p,[a.id,b.id],manifest,f.user.id,{tag:'ab'}),ba=f.store.writeRevision(f.p,[b.id,a.id],manifest,f.user.id,{tag:'ba'});
  assert.deepEqual(nativeMergeBases(f.store,[ab.id],[ba.id]),[a.id,b.id].sort());f.fork('other');const main=f.store.branchFor(f.user,f.p,'main'),other=f.store.branchFor(f.user,f.p,'other');main.head=ab.id;other.head=ba.id;f.store.put('creator_branch',main);f.store.put('creator_branch',other);
  assert.throws(()=>f.merges.preview(f.user,f.p,'main',{source_branch_id:'other'}),error=>error.details?.code==='native_merge_ambiguous_base');
  other.head=f.store.writeRevision(f.p,[],manifest,f.user.id).id;f.store.put('creator_branch',other);assert.throws(()=>f.merges.preview(f.user,f.p,'main',{source_branch_id:'other'}),error=>error.details?.code==='native_merge_unrelated_history');
});
