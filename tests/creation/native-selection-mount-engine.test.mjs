import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
test('native selection and transform previews preserve wrapped instance poses',{timeout:90000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),directory=await mkdtemp(join(tmpdir(),'atelier-native-selection-mount-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await cp(join(root,'runtimes/model-preview'),directory,{recursive:true,filter:path=>!path.split('/').includes('.godot')});
  await cp(join(import.meta.dirname,'native-selection-mount-probe.gd'),join(directory,'selection_mount_probe.gd'));
  if(process.env.NATIVE_SELECTION_BASELINE)await cp(process.env.NATIVE_SELECTION_BASELINE,join(directory,'native_main.gd'));
  const engine=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
  await exec(engine,['--headless','--editor','--path',directory,'--import'],{timeout:30000});
  const result=await exec(engine,['--headless','--path',directory,'--script','res://selection_mount_probe.gd'],{timeout:30000}).catch(error=>error);
  const log=String(result.stdout??'')+String(result.stderr??'');
  const report=JSON.parse(await readFile(join(directory,'selection-mount-report.json'),'utf8'));
  assert.deepEqual(report.checks.filter(row=>!row.ok),[],log);
  assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error/);
  assert.equal(report.checks.length,38);
});
