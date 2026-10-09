import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,renameSync,statSync,utimesSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFileIdentityCache} from '../../services/creation/file-identity.mjs';
import {hash} from '../../services/creation/schema.mjs';

function fixture(t,capacity){
  const directory=mkdtempSync(join(tmpdir(),'atelier-file-identity-'));let reads=0;
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const identity=createFileIdentityCache({capacity,readFile(path){reads++;return readFileSync(path);}});
  return {directory,identity,get reads(){return reads;}};
}

test('repeated full Godot-sized inventories do not reread an unchanged toolchain',t=>{
  const f=fixture(t),paths=Array.from({length:81},(_,i)=>join(f.directory,'tool-'+i));
  for(const [i,path] of paths.entries())writeFileSync(path,'pinned bytes '+i);
  const expected=paths.map(path=>f.identity(path));
  for(let round=0;round<3;round++)assert.deepEqual(paths.map(path=>f.identity(path)),expected);
  assert.equal(f.reads,81,'all hot scans use cached digests');
  writeFileSync(paths[40],'new pinned bytes');
  assert.notEqual(f.identity(paths[40]).sha256,expected[40].sha256);
  paths.forEach(path=>f.identity(path));assert.equal(f.reads,82,'only changed file is reread');
});

test('same-size edits with restored mtime and atomic replacement invalidate cached digests',t=>{
  const f=fixture(t),path=join(f.directory,'engine');writeFileSync(path,'old!');
  const first=f.identity(path),before=statSync(path);
  writeFileSync(path,'new!');utimesSync(path,before.atime,before.mtime);
  assert.equal(f.identity(path).sha256,hash('new!'));assert.notEqual(first.sha256,f.identity(path).sha256);
  const replacement=join(f.directory,'replacement');writeFileSync(replacement,'swap');utimesSync(replacement,before.atime,before.mtime);renameSync(replacement,path);
  assert.equal(f.identity(path).sha256,hash('swap'));assert.equal(f.reads,3);
  rmSync(path);assert.deepEqual(f.identity(path),{missing:true});
  writeFileSync(path,'back');assert.equal(f.identity(path).sha256,hash('back'));assert.equal(f.reads,4);
});

test('bounded LRU evicts one old file while preserving recently used identities',t=>{
  const f=fixture(t,2),paths=['a','b','c'].map(name=>join(f.directory,name));paths.forEach(path=>writeFileSync(path,path));
  f.identity(paths[0]);f.identity(paths[1]);f.identity(paths[0]);f.identity(paths[2]);
  const reads=f.reads;f.identity(paths[0]);f.identity(paths[2]);assert.equal(f.reads,reads);
  f.identity(paths[1]);assert.equal(f.reads,reads+1);
});

test('real-path aliases share digests without returning mutable cache objects',t=>{
  const f=fixture(t),path=join(f.directory,'real'),alias=join(f.directory,'alias');writeFileSync(path,'pinned');symlinkSync(path,alias);
  const result=f.identity(path);result.sha256='mutated caller result';
  assert.equal(f.identity(alias).sha256,hash('pinned'));assert.equal(f.reads,1);
});
