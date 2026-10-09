// Explicit regression request: name grouping across 3D objects and Canvas UI.
// Manual only; no product service, real account, source transaction or broad suite.
// node tests/creation/native-selection-names-gpu.mjs
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec=promisify(execFile), root=resolve(import.meta.dirname,'../..');
const data=await mkdtemp(resolve(tmpdir(),'atelier-selection-names-'));
const out=resolve(root,'.local/creation-verification/native-selection-names',new Date().toISOString().replaceAll(':','-'));
const fixture=`[gd_scene load_steps=3 format=3]
[sub_resource type="StandardMaterial3D" id="Material"]
shading_mode = 0
albedo_color = Color(0.24, 0.29, 0.33, 1)
[sub_resource type="BoxMesh" id="Box"]
material = SubResource("Material")
size = Vector3(1.4, 1.4, 1.4)
[node name="Mixed" type="Node3D"]
[node name="A" type="MeshInstance3D" parent="."]
position = Vector3(-2.5, 0, 0)
mesh = SubResource("Box")
[node name="B" type="MeshInstance3D" parent="."]
mesh = SubResource("Box")
[node name="C" type="MeshInstance3D" parent="."]
position = Vector3(2.5, 0, 0)
mesh = SubResource("Box")
[node name="Unselected" type="MeshInstance3D" parent="."]
position = Vector3(0, -2.5, 0)
mesh = SubResource("Box")
[node name="HUD" type="ColorRect" parent="."]
offset_left = 160.0
offset_top = 110.0
offset_right = 340.0
offset_bottom = 180.0
mouse_filter = 2
color = Color(0.25, 0.30, 0.35, 1)
`;
await mkdir(out,{recursive:true});
try {
  await cp(resolve(root,'runtimes/model-preview'),data,{recursive:true,filter:path=>!path.split('/').includes('.godot')});
  await writeFile(resolve(data,'names-fixture.tscn'),fixture);
  await cp(resolve(import.meta.dirname,'native-selection-names-probe.gd'),resolve(data,'names_probe.gd'));
  const sources=await Promise.all(['main.gd','native_main.gd','remote_selection_overlay.gd','collaboration_overlay.gd','remote_selection_outline.gd','remote_selection_mask_layer.gd','remote_selection_outline.gdshader','names-fixture.tscn','names_probe.gd'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(resolve(data,path))).digest('hex')})));
  const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
  const imported=await exec(godot,['--headless','--editor','--path',data,'--import'],{timeout:45000,maxBuffer:8*1024*1024});
  await writeFile(resolve(out,'import.log'),imported.stdout+imported.stderr);
  assert.doesNotMatch(imported.stdout+imported.stderr,/SCRIPT ERROR|Parse Error/);
  const args=['--path',data,'--rendering-method','gl_compatibility','--resolution','1000x700','--position','20,20','--script','res://names_probe.gd','--',`--out=${out}`];
  let log='',failure;
  try {const result=await exec(godot,args,{timeout:45000,maxBuffer:8*1024*1024});log=result.stdout+result.stderr;}
  catch(error){log=String(error.stdout??'')+String(error.stderr??'');failure=error;}
  await writeFile(resolve(out,'godot.log'),log);
  await writeFile(resolve(out,'run.json'),JSON.stringify({sources,args,scope:'Actual native Godot GPU: identity labels across 3D/Canvas, independent 3D silhouettes, deselection and Agent switch'},null,2));
  assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|SHADER ERROR/);
  const report=JSON.parse(await readFile(resolve(out,'result.json'),'utf8').catch(()=>{throw failure??new Error(log);}));
  assert.deepEqual(report.checks.filter(row=>!row.ok),[],log);
  assert.equal(report.ok,true);
  assert.match(log,/NATIVE_SELECTION_NAMES_COMPLETE/);
  for(const source of sources)assert.equal(createHash('sha256').update(await readFile(resolve(data,source.path))).digest('hex'),source.sha256,`source bytes changed: ${source.path}`);
  if(failure)throw failure;
  console.log(`${report.checks.length}/${report.checks.length} checks passed`);
} finally {console.log('Selection name evidence: '+out);await rm(data,{recursive:true,force:true});}
