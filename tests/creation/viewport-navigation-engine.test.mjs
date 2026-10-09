import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec=promisify(execFile);
test('real editor input navigates 3D and 2D without moving authored objects',{timeout:90000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),temporary=await mkdtemp(join(tmpdir(),'atelier-viewport-navigation-'));
  t.after(()=>rm(temporary,{recursive:true,force:true}));
  const project=join(temporary,'project'),home=join(temporary,'home'),scratch=join(temporary,'tmp');
  const out=join(root,'.local/creation-verification/viewport-annotation',temporary.split('/').at(-1));
  await Promise.all([mkdir(home,{recursive:true}),mkdir(scratch,{recursive:true}),mkdir(out,{recursive:true})]);
  await cp(join(root,'runtimes/model-preview'),project,{recursive:true,filter:path=>!path.split('/').includes('.godot')});
  await cp(join(import.meta.dirname,'viewport-navigation-probe.gd'),join(project,'viewport_navigation_probe.gd'));
  const sources=[];
  for(const path of ['main.gd','native_main.gd','editor_navigation.gd'])sources.push({path,sha256:createHash('sha256').update(await readFile(join(project,path))).digest('hex')});
  const engine=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
  const env={...process.env,HOME:home,TMPDIR:scratch,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),XDG_CACHE_HOME:join(home,'cache')};
  const common=['--headless','--audio-driver','Dummy','--path',project];
  let log='',failure;
  try{
    const imported=await exec(engine,[...common,'--editor','--import','--quit'],{env,timeout:30000,maxBuffer:8*1024*1024});
    await writeFile(join(out,'import.log'),imported.stdout+imported.stderr);
    assert.doesNotMatch(imported.stdout+imported.stderr,/SCRIPT ERROR|Parse Error/);
    const result=await exec(engine,[...common,'--script','res://viewport_navigation_probe.gd','--',`--out=${out}`],{env,timeout:30000,maxBuffer:8*1024*1024});
    log=result.stdout+result.stderr;
  }catch(error){log+=String(error.stdout??'')+String(error.stderr??'');failure=error;}
  finally{
    await writeFile(join(out,'godot.log'),log);
    await writeFile(join(out,'run.json'),JSON.stringify({sources,display:'headless',audio:'Dummy',scope:'real input events and camera/canvas geometry in an isolated editor runtime; no GPU or visual acceptance'},null,2));
    console.log('Independent viewport navigation evidence: '+out);
  }
  assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error/);
  const report=JSON.parse(await readFile(join(out,'result.json'),'utf8').catch(()=>{throw failure??new Error(log);}));
  assert.deepEqual(report.checks.filter(row=>!row.ok),[],log);
  assert.equal(report.ok,true);
  assert.match(log,/VIEWPORT_NAVIGATION_COMPLETE/);
  assert.ok(report.checks.length>=45);
  for(const source of sources)assert.equal(createHash('sha256').update(await readFile(join(project,source.path))).digest('hex'),source.sha256,'probe preserves copied editor source');
  if(failure)throw failure;
});
