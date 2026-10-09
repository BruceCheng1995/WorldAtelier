// Isolated actual Godot projection regression. Only a temporary copy of the editor
// runtime and synthetic objects are used; no browser, service or source database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec=promisify(execFile);
for(const host of ['main','native_main'])test(`actual ${host} placement projections and read-only protocol`,{timeout:120000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),data=await mkdtemp(resolve(tmpdir(),'atelier-placement-'));
  const out=resolve(root,'.local/creation-verification/placement',new Date().toISOString().replaceAll(':','-')+'-'+host);
  await mkdir(out,{recursive:true});t.after(()=>rm(data,{recursive:true,force:true}));
  await cp(resolve(root,'runtimes/model-preview'),data,{recursive:true,filter:path=>!path.split('/').includes('.godot')});
  await cp(resolve(import.meta.dirname,'placement-probe.gd'),resolve(data,'placement_probe.gd'));
  const sources=[];
  for(const path of ['main.gd','native_main.gd']){
    sources.push({path,sha256:createHash('sha256').update(await readFile(resolve(data,path))).digest('hex')});
  }
  const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
  const args=['--headless','--path',data,'--rendering-method','gl_compatibility','--resolution','900x600','--position','20,20','--script','res://placement_probe.gd','--',`--out=${out}`,`--host=${host}`];
  let log='',failure;
  try{
    const imported=await exec(godot,['--headless','--editor','--path',data,'--import'],{timeout:45000,maxBuffer:8*1024*1024});
    await writeFile(resolve(out,'import.log'),imported.stdout+imported.stderr);
    assert.doesNotMatch(imported.stdout+imported.stderr,/SCRIPT ERROR|Parse Error/);
    const result=await exec(godot,args,{timeout:60000,maxBuffer:8*1024*1024});log=result.stdout+result.stderr;
  }catch(error){log+=String(error.stdout??'')+String(error.stderr??'');failure=error;}
  finally{
    await writeFile(resolve(out,'godot.log'),log);
    await writeFile(resolve(out,'run.json'),JSON.stringify({sources,args,scope:'actual Godot Camera3D and canvas projection in isolated synthetic editor scene'},null,2));
    console.log('Independent placement evidence: '+out);
  }
  assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|SHADER ERROR/);
  const report=JSON.parse(await readFile(resolve(out,'result.json'),'utf8').catch(()=>{throw failure??new Error(log);}));
  assert.deepEqual(report.checks.filter(row=>!row.ok),[],log);
  assert.equal(report.ok,true);assert.match(log,/PLACEMENT_COMPLETE/);
  for(const source of sources)assert.equal(createHash('sha256').update(await readFile(resolve(data,source.path))).digest('hex'),source.sha256,'probe leaves copied runtime source intact');
  if(failure)throw failure;
});
