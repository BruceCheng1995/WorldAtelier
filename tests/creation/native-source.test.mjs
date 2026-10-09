import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeSourceArchive,nativeFileMap,nativeSourceIdentity,nativeSourcePath} from '../../services/creation/native-source.mjs';

// File archive/storage checks only. These do not claim Godot scene semantics.
function fixture(t){const root=mkdtempSync(join(tmpdir(),'atelier-native-source-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return{root,archive:new NativeSourceArchive(join(root,'objects'))};}

test('native source retains exact arbitrary resource bytes and immutable historical snapshots',t=>{
  const {root,archive}=fixture(t),project=join(root,'project');mkdirSync(join(project,'.atelier'),{recursive:true});mkdirSync(join(project,'assets'));
  writeFileSync(join(project,'project.godot'),'config_version=5\n');
  writeFileSync(join(project,'.atelier/catalog.json'),'{}\n');
  writeFileSync(join(project,'assets','陌生资源.tres'),Buffer.from([0,1,255,13,10,0]));
  const before=archive.capture(project),identity=nativeSourceIdentity(before);
  writeFileSync(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Changed"\n');
  const after=archive.capture(project);assert.notEqual(nativeSourceIdentity(after),identity);
  const restored=archive.materialize(before,join(root,'historical'));
  assert.equal(readFileSync(join(restored,'project.godot'),'utf8'),'config_version=5\n');
  assert.deepEqual(readFileSync(join(restored,'assets','陌生资源.tres')),Buffer.from([0,1,255,13,10,0]));
  assert.throws(()=>archive.materialize(before,restored),/空目录/);
});

test('native source refuses traversal, platform aliases, file-directory collisions and symlink imports',t=>{
  const {root,archive}=fixture(t);
  for(const path of ['../secret','res://x','/tmp/x','a\\b','a/../b','a//b','.git/config','.env','a/NUL.txt','a.','e\u0301.tscn',...['?','*','<','>','|','"'].map(char=>'scene'+char+'.tscn')])assert.throws(()=>nativeSourcePath(path),/路径|目录/);
  const entry=archive.put('scene');
  assert.throws(()=>nativeFileMap({'A.tscn':entry,'a.tscn':entry}),/大小写/);
  assert.throws(()=>nativeFileMap({'scene':entry,'scene/a.tscn':entry}),/文件与目录/);
  const source=join(root,'project');mkdirSync(source);symlinkSync(join(root,'objects'),join(source,'assets'));
  assert.throws(()=>archive.capture(source),/符号链接/);
  assert.equal(nativeSourcePath('.atelier/catalog.json'),'.atelier/catalog.json');
});

test('guarded file changes reject stale writes and undo cannot overwrite a collaborator',t=>{
  const {archive}=fixture(t),first=archive.put('one'),files={'scene.tscn':first};
  const second=archive.applyFiles(files,[{type:'put_source_file',path:'scene.tscn',expected_hash:first.hash,text:'two'}]);
  const third=archive.applyFiles(second.files,[{type:'put_source_file',path:'scene.tscn',expected_hash:second.files['scene.tscn'].hash,text:'three'}]);
  assert.throws(()=>archive.applyFiles(third.files,second.inverse),/已被修改/);
  assert.throws(()=>archive.applyFiles(third.files,[{type:'put_source_file',path:'scene.tscn',expected_hash:first.hash,text:'stale'}]),/已被修改/);
  const undone=archive.applyFiles(second.files,second.inverse);assert.equal(archive.read(undone.files['scene.tscn']).toString(),'one');
  assert.equal(archive.read(first).toString(),'one');
  const reserved=archive.applyFiles({},[{type:'put_source_file',path:'__proto__',expected_hash:null,text:'safe file'}]);
  assert.equal(Object.keys(reserved.files)[0],'__proto__');assert.equal(archive.read(reserved.files.__proto__).toString(),'safe file');
});

test('corrupt or missing immutable source bytes fail before a project is accepted',t=>{
  const {archive}=fixture(t),entry=archive.put('expected');writeFileSync(archive.path(entry.hash),'corrupt');
  assert.throws(()=>archive.verify({'scene.tscn':entry}),/字节校验失败/);
  assert.throws(()=>archive.put('expected'),/字节校验失败/);
  assert.throws(()=>archive.verify({'scene.tscn':{hash:'f'.repeat(64),size:8}}),/缺失/);
});

test('source capture excludes Godot import caches while retaining original resources',t=>{
  const {root,archive}=fixture(t),project=join(root,'project');mkdirSync(join(project,'.godot'),{recursive:true});
  writeFileSync(join(project,'.godot','uid_cache.bin'),'local cache');writeFileSync(join(project,'scene.tscn'),'[gd_scene format=3]\n');
  const files=archive.capture(project);assert.deepEqual(Object.keys(files),['scene.tscn']);
});

test('multi-megabyte binary submissions preserve exact bytes for every base64 padding length',t=>{
  const {archive}=fixture(t),bytes=Buffer.alloc(6*1024*1024+2);
  for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
  for(const tail of [0,1,2]){
    const original=bytes.subarray(0,6*1024*1024+tail),path=`assets/large-${tail}.glb`;
    const applied=archive.applyFiles({},[{type:'put_source_file',path,expected_hash:null,data_base64:original.toString('base64')}]);
    assert.equal(applied.files[path].size,original.length);
    assert.deepEqual(archive.read(applied.files[path]),original);
    assert.deepEqual(Object.keys(archive.applyFiles(applied.files,applied.inverse).files),[]);
  }
});

test('binary submissions reject invalid alphabet, interior padding and incomplete base64 groups',t=>{
  const {archive}=fixture(t);
  for(const value of ['Zm?v','Zm-v','Zm_v','Z=g=','Zg==AAAA','====','A===','AAA','AAAAA','Zg==\n','Zm9v ']){
    assert.throws(()=>archive.applyFiles({},[{type:'put_source_file',path:'assets/invalid.bin',expected_hash:null,data_base64:value}]),{status:422,message:'源文件字节编码无效'},JSON.stringify(value));
  }
  const empty=archive.applyFiles({},[{type:'put_source_file',path:'assets/empty.bin',expected_hash:null,data_base64:''}]);
  assert.equal(archive.read(empty.files['assets/empty.bin']).length,0);
});

test('base64 validation preserves per-file and total native archive size limits',t=>{
  const {root,archive}=fixture(t);
  assert.equal(archive.limits.fileBytes,128*1024*1024);
  assert.equal(archive.limits.totalBytes,512*1024*1024);
  const bounded=new NativeSourceArchive(join(root,'bounded'),{limits:{files:3,fileBytes:7,totalBytes:10}});
  const submit=(files,path,size)=>bounded.applyFiles(files,[{type:'put_source_file',path,expected_hash:null,data_base64:Buffer.alloc(size,255).toString('base64')}]);
  const first=submit({},'assets/first.bin',7);
  assert.equal(bounded.read(first.files['assets/first.bin']).length,7);
  assert.throws(()=>submit({},'assets/oversize.bin',8),{status:413,message:'原生源文件过大'});
  const full=submit(first.files,'assets/second.bin',3);
  assert.equal(Object.values(full.files).reduce((sum,file)=>sum+file.size,0),10);
  assert.throws(()=>submit(full.files,'assets/overflow.bin',1),{status:413,message:'原生工程总大小超出范围'});
  assert.deepEqual(bounded.read(first.files['assets/first.bin']),Buffer.alloc(7,255));
});
