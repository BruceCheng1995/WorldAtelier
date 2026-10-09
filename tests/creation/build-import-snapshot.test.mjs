import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,statSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from '../../services/creation/schema.mjs';
import {snapshotImportedProject,verifyImportedFiles} from '../../services/creation/build-import-snapshot.mjs';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';

function fixture(t){
  const base=mkdtempSync(join(tmpdir(),'wa-import-snapshot-')),source=join(base,'source'),destination=join(base,'export');
  t.after(()=>rmSync(base,{recursive:true,force:true}));mkdirSync(source);
  const texts={'project.godot':'config_version=5\n','.atelier/catalog.json':'{}','model.glb.import':'fixed import settings','unknown.bin':Buffer.from([0,255,33])};
  const sourceFiles=Object.entries(texts).map(([path,content])=>{
    const bytes=Buffer.from(content),file=join(source,path);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,bytes);
    return {path,size:bytes.length,sha256:hash(bytes)};
  });
  mkdirSync(join(source,'.godot/imported'),{recursive:true});writeFileSync(join(source,'.godot/imported/model.scn'),'engine output');
  writeFileSync(join(source,'not-in-fixed-input.txt'),'exclude me');
  return {base,source,destination,sourceFiles};
}
test('pre-runtime snapshot preserves exact unknown sources and independent importer bytes, excluding unlisted files',t=>{
  const f=fixture(t),snapshot=snapshotImportedProject(f),sourceCache=join(f.source,'.godot/imported/model.scn'),exportCache=join(f.destination,'.godot/imported/model.scn');
  assert.equal(snapshot.cache_files,1);assert.equal(snapshot.cache_bytes,13);
  assert.ok(!existsSync(join(f.destination,'not-in-fixed-input.txt')));
  assert.notEqual(statSync(sourceCache).ino,statSync(exportCache).ino,'never hardlink writable cache');
  assert.ok(Math.abs(statSync(sourceCache).mtimeMs-statSync(exportCache).mtimeMs)<1,'preserve importer mtime');
  writeFileSync(sourceCache,'runtime pollution');writeFileSync(join(f.source,'.godot/injected.gd'),'extends Node');
  verifyImportedFiles(f.destination,snapshot.files);
  assert.equal(readFileSync(exportCache,'utf8'),'engine output');assert.ok(!existsSync(join(f.destination,'.godot/injected.gd')));
  assert.deepEqual(readFileSync(join(f.destination,'unknown.bin')),Buffer.from([0,255,33]));
});
test('modified input and damaged export cache are rejected',t=>{
  const f=fixture(t),snapshot=snapshotImportedProject(f);
  writeFileSync(join(f.destination,'.godot/imported/model.scn'),'corrupted');
  assert.throws(()=>verifyImportedFiles(f.destination,snapshot.files),/字节已变化/);
  writeFileSync(join(f.source,'unknown.bin'),'changed');
  assert.throws(()=>snapshotImportedProject({...f,destination:join(f.base,'second')}),/字节已变化/);
});
test('unexpected files in the export snapshot are rejected before export',t=>{
  const f=fixture(t),snapshot=snapshotImportedProject(f);
  writeFileSync(join(f.destination,'.godot/injected.gd'),'extends Node');
  assert.throws(()=>verifyImportedFiles(f.destination,snapshot.files,{exact:true}),/未固定文件/);
});
test('cache and intermediate-directory symbolic links are rejected',t=>{
  const f=fixture(t);symlinkSync(join(f.source,'unknown.bin'),join(f.source,'.godot/imported/linked'));
  assert.throws(()=>snapshotImportedProject(f),/符号链接/);
  rmSync(join(f.source,'.godot/imported/linked'));const snapshot=snapshotImportedProject(f);
  rmSync(join(f.destination,'.godot/imported'),{recursive:true});symlinkSync(join(f.source,'.godot/imported'),join(f.destination,'.godot/imported'));
  assert.throws(()=>verifyImportedFiles(f.destination,snapshot.files),/符号链接/);
});
test('absent or empty importer cache falls back without making a partial export project',t=>{
  const f=fixture(t);rmSync(join(f.source,'.godot'),{recursive:true});
  assert.equal(snapshotImportedProject(f),null);mkdirSync(join(f.source,'.godot'));
  assert.equal(snapshotImportedProject(f),null);assert.ok(!existsSync(f.destination));
});
test('timings retain failures and do not turn a failed operation into success',async()=>{
  const runner={update(job,patch){Object.assign(job,patch);}},job={};
  await assert.rejects(CreationBuilds.prototype.measure.call(runner,job,'resource_check',async()=>{throw Error('runtime fault');},{resource_id:'unused'}),/runtime fault/);
  assert.equal(job.timings[0].status,'failed');assert.equal(job.timings[0].resource_id,'unused');assert.ok(job.timings[0].wall_ms>=0);
  assert.equal(await CreationBuilds.prototype.measure.call(runner,job,'import',async()=>42),42);
  assert.equal(job.timings.length,2);assert.equal(job.timings[1].status,'completed');
});
