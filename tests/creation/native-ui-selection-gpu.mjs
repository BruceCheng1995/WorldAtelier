// Explicit, focused check requested for aggregate native UI selection frames.
// Run manually: node tests/creation/native-ui-selection-gpu.mjs
// Reuses the existing native Control fixture; never opens a product service.
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec=promisify(execFile),root=resolve(import.meta.dirname,'../..');
const data=await mkdtemp(resolve(tmpdir(),'atelier-native-ui-selection-'));
const out=resolve(root,'.local/creation-verification/native-ui-selection',new Date().toISOString().replaceAll(':','-'));
await mkdir(out,{recursive:true});
const sources=[];
try{
  await cp(resolve(root,'runtimes/model-preview'),data,{recursive:true,filter:path=>!path.split('/').includes('.godot')});
  for(const name of ['main.tscn','panel.tscn','nested.tscn'])await cp(resolve(root,'tests/fixtures/native-control-bake',name),resolve(data,name==='main.tscn'?'ui-fixture.tscn':name));
  await cp(resolve(import.meta.dirname,'native-ui-selection-probe.gd'),resolve(data,'native_ui_selection_probe.gd'));
  for(const path of ['main.gd','native_main.gd','remote_selection_overlay.gd','control_layout_overlay.gd','collaboration_overlay.gd','remote_selection_outline.gd','ui-fixture.tscn','panel.tscn','nested.tscn'])sources.push({path,sha256:createHash('sha256').update(await readFile(resolve(data,path))).digest('hex')});
  const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
  const imported=await exec(godot,['--headless','--editor','--path',data,'--import'],{timeout:45000,maxBuffer:8*1024*1024});
  await writeFile(resolve(out,'import.log'),imported.stdout+imported.stderr);
  assert.doesNotMatch(imported.stdout+imported.stderr,/SCRIPT ERROR|Parse Error/);
  const args=['--path',data,'--rendering-method','gl_compatibility','--resolution','1000x700','--position','20,20','--script','res://native_ui_selection_probe.gd','--',`--out=${out}`];
  let log='',failure;
  try{const result=await exec(godot,args,{timeout:45000,maxBuffer:8*1024*1024});log=result.stdout+result.stderr;}
  catch(error){log=String(error.stdout??'')+String(error.stderr??'');failure=error;}
  await writeFile(resolve(out,'godot.log'),log);
  await writeFile(resolve(out,'run.json'),JSON.stringify({sources,args,scope:'native nested Control fixture, aggregate per-identity 2D frames and labels, GPU pixels and read-only state'},null,2));
  assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|SHADER ERROR/);
  const report=JSON.parse(await readFile(resolve(out,'result.json'),'utf8').catch(()=>{throw failure??new Error(log);}));
  assert.deepEqual(report.checks.filter(row=>!row.ok),[],log);
  assert.equal(report.ok,true);assert.match(log,/NATIVE_UI_SELECTION_COMPLETE/);
  for(const source of sources)assert.equal(createHash('sha256').update(await readFile(resolve(data,source.path))).digest('hex'),source.sha256,`source bytes changed: ${source.path}`);
  if(failure)throw failure;
  console.log(`${report.checks.length}/${report.checks.length} checks passed`);
}finally{console.log('Native UI selection evidence: '+out);await rm(data,{recursive:true,force:true});}
