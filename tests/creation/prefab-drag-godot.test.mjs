// Explicit independent GPU regression. Only a temporary copy of the editor
// runtime and synthetic objects are used; no browser, service or source database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {runNativeScene} from '../../tools/native-scene/invoke.mjs';

const exec=promisify(execFile);
for(const host of ['native_main'])test(`actual ${host} prefab ghost GPU and lifecycle`,{timeout:120000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),data=await mkdtemp(resolve(tmpdir(),'atelier-prefab-drag-'));
  const out=resolve(root,'.local/creation-verification/prefab-drag',new Date().toISOString().replaceAll(':','-')+'-'+host);
  await mkdir(out,{recursive:true});t.after(()=>rm(data,{recursive:true,force:true}));
  await cp(resolve(root,'runtimes/model-preview'),data,{recursive:true,filter:path=>!path.split('/').includes('.godot')});
  await cp(resolve(import.meta.dirname,'prefab-drag-probe.gd'),resolve(data,'prefab_drag_probe.gd'));
  const sources=[];
  for(const path of ['main.gd','native_main.gd','prefab_placement_preview.gd','remote_selection_overlay.gd','collaboration_overlay.gd','remote_selection_outline.gd','remote_selection_mask_layer.gd','remote_selection_outline.gdshader']){
    sources.push({path,sha256:createHash('sha256').update(await readFile(resolve(data,path))).digest('hex')});
  }
  const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
  const args=['--path',data,'--rendering-method','gl_compatibility','--resolution','900x600','--position','20,20','--script','res://prefab_drag_probe.gd','--',`--out=${out}`,`--host=${host}`];
  let log='',failure;
  try{
    const imported=await exec(godot,['--headless','--editor','--path',data,'--import'],{timeout:45000,maxBuffer:8*1024*1024});
    await writeFile(resolve(out,'import.log'),imported.stdout+imported.stderr);
    assert.doesNotMatch(imported.stdout+imported.stderr,/SCRIPT ERROR|Parse Error/);
    const result=await exec(godot,args,{timeout:60000,maxBuffer:8*1024*1024});log=result.stdout+result.stderr;
  }catch(error){log+=String(error.stdout??'')+String(error.stderr??'');failure=error;}
  finally{
    await writeFile(resolve(out,'godot.log'),log);
    await writeFile(resolve(out,'run.json'),JSON.stringify({sources,args,scope:'actual GPU ghost movement, native transforms, lifecycle and read-only editor state'},null,2));
    console.log('Prefab ghost evidence: '+out);
  }
  assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|SHADER ERROR/);
  const report=JSON.parse(await readFile(resolve(out,'result.json'),'utf8').catch(()=>{throw failure??new Error(log);}));
  assert.deepEqual(report.checks.filter(row=>!row.ok),[],log);
  assert.equal(report.ok,true);assert.match(log,/PREFAB_DRAG_COMPLETE/);
  if(failure)throw failure;
  // Compare the measured pivoted Control ghost to the real adapter's saved
  // instance, then independently reload its bytes in a native SceneTree.
  await writeFile(resolve(data,'placed-canvas.tscn'),'[gd_scene format=3]\n[node name="Root" type="Node2D"]\nposition=Vector2(30,-40)\nrotation=0.35\nscale=Vector2(2,3)\n');
  await runNativeScene({projectDirectory:data,request:{scene_path:'res://placed-canvas.tscn',action:'apply',ops:[{op:'instantiate',scene_path:'res://ghost-control.tscn',name:'Drop',instance_id:'drop',parent:{path:'.'},placement:{dimension:'2d',position:report.control_placement.position}}]}});
  await writeFile(resolve(data,'read-placement.gd'),`extends SceneTree
func _initialize(): call_deferred("verify")
func verify():
 var scene = load("res://placed-canvas.tscn").instantiate()
 root.add_child(scene)
 await process_frame
 await process_frame
 var node = scene.get_node("Drop")
 var transform = node.get_global_transform()
 print("CONTROL_ADAPTER_ORIGIN "+JSON.stringify([transform.x.x,transform.x.y,transform.y.x,transform.y.y,transform.origin.x,transform.origin.y]))
 scene.free()
 quit()
`);
  const readback=await exec(godot,['--headless','--path',data,'--script','res://read-placement.gd'],{timeout:20000,maxBuffer:4*1024*1024});
  assert.doesNotMatch(readback.stdout+readback.stderr,/SCRIPT ERROR|Parse Error|ERROR:/);
  const origin=JSON.parse(readback.stdout.split('\n').find(line=>line.startsWith('CONTROL_ADAPTER_ORIGIN ')).slice('CONTROL_ADAPTER_ORIGIN '.length));
  for(let i=0;i<6;i++)assert.ok(Math.abs(origin[i]-report.control_placement.world_transform[i])<.002,`adapter ${origin} differs from ghost ${report.control_placement.world_transform}`);
  await writeFile(resolve(out,'control-adapter-comparison.json'),JSON.stringify({ok:true,ghost:report.control_placement,adapter_saved_and_reloaded_world_transform:origin,tolerance:.002},null,2));
  await writeFile(resolve(data,'placed-model.tscn'),'[gd_scene format=3]\n[node name="Root" type="Node3D"]\ntransform=Transform3D(1.5,0,0.1,0.2,0.8,0,0,0.1,1.2,2,1,-3)\n');
  await runNativeScene({projectDirectory:data,request:{scene_path:'res://placed-model.tscn',action:'apply',ops:[['cube','Drop',report.model_placement],['top','Top',report.top_placement]].map(([file,name,pose])=>({op:'instantiate',scene_path:`res://ghost-${file}.tscn`,name,instance_id:name,parent:{path:'.'},placement:{dimension:'3d',position:pose.position}}))}});
  await writeFile(resolve(data,'read-model.gd'),`extends SceneTree
func _initialize(): call_deferred("verify")
func verify():
 var scene = load("res://placed-model.tscn").instantiate()
 scene.process_mode = Node.PROCESS_MODE_DISABLED
 root.add_child(scene)
 var result = {}
 for name in [".","Drop","Top"]:
  var m = scene.get_node(name).global_transform
  result[name] = [m.basis.x.x,m.basis.x.y,m.basis.x.z,0,m.basis.y.x,m.basis.y.y,m.basis.y.z,0,m.basis.z.x,m.basis.z.y,m.basis.z.z,0,m.origin.x,m.origin.y,m.origin.z,1]
 print("MODEL_ADAPTER_MATRIX "+JSON.stringify(result))
 scene.free()
 quit()
`);
  const modelReadback=await exec(godot,['--headless','--path',data,'--script','res://read-model.gd'],{timeout:20000,maxBuffer:4*1024*1024});
  assert.doesNotMatch(modelReadback.stdout+modelReadback.stderr,/SCRIPT ERROR|Parse Error|ERROR:/);
  const matrices=JSON.parse(modelReadback.stdout.split('\n').find(line=>line.startsWith('MODEL_ADAPTER_MATRIX ')).slice('MODEL_ADAPTER_MATRIX '.length));
  await writeFile(resolve(out,'model-debug.json'),JSON.stringify({matrices,source:await readFile(resolve(data,'placed-model.tscn'),'utf8'),prefab:await readFile(resolve(data,'ghost-cube.tscn'),'utf8')},null,2));
  for(const [name,expected]of [['Drop',report.model_placement],['Top',report.top_placement]])for(let i=0;i<16;i++)assert.ok(Math.abs(matrices[name][i]-expected.world_matrix[i])<.002,`${name} adapter differs from ghost at matrix ${i}: ${matrices[name]} / ${expected.world_matrix}`);
  await writeFile(resolve(out,'model-adapter-comparison.json'),JSON.stringify({ok:true,ghost:{Drop:report.model_placement,Top:report.top_placement},adapter_saved_and_reloaded_world_matrices:matrices,tolerance:.002},null,2));
});
