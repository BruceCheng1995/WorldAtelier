import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('flattened native Control preview preserves actual layout and growth across viewport sizes',{timeout:120000},t=>{
 const root=resolve(import.meta.dirname,'../..'),directory=mkdtempSync(join(tmpdir(),'native-control-bake-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 cpSync(join(root,'tests/fixtures/native-control-bake'),directory,{recursive:true});
 const names=['project.godot','main.tscn','panel.tscn','nested.tscn'],original=Object.fromEntries(names.map(name=>[name,readFileSync(join(directory,name))]));
 writeFileSync(join(directory,'request.json'),JSON.stringify({scenes:[{source:'res://main.tscn',output:'res://baked.scn'}]}));
 writeFileSync(join(directory,'probe.gd'),`extends SceneTree
var report={}
func _initialize(): run.call_deferred()
func inspect(node: Node, base: Node, rows: Dictionary):
 if node is Control:
  rows[str(base.get_path_to(node))]={"anchors":[node.anchor_left,node.anchor_top,node.anchor_right,node.anchor_bottom],"offsets":[node.offset_left,node.offset_top,node.offset_right,node.offset_bottom],"position":[node.position.x,node.position.y],"size":[node.size.x,node.size.y],"grow":[node.grow_horizontal,node.grow_vertical],"scale":[node.scale.x,node.scale.y],"rotation":node.rotation}
 for child in node.get_children(): inspect(child,base,rows)
func run():
 for dimensions in [Vector2i(1280,720),Vector2i(640,360)]:
  var results={}
  for kind in ["source","baked"]:
   var packed: PackedScene=load("res://main.tscn" if kind=="source" else "res://baked.scn")
   var tree=packed.instantiate()
   var viewport=SubViewport.new()
   viewport.size=dimensions
   root.add_child(viewport)
   viewport.add_child(tree)
   await process_frame
   await process_frame
   var rows={}
   inspect(tree,tree,rows)
   results[kind]=rows
   viewport.free()
  report[str(dimensions)]=results
 FileAccess.open("res://comparison.json",FileAccess.WRITE).store_string(JSON.stringify(report))
 quit()
`);
 const engine=process.env.GODOT_PATH??'/opt/homebrew/bin/godot';
 function run(args){const result=spawnSync(engine,['--headless','--path',directory,...args],{cwd:directory,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});assert.ifError(result.error);assert.equal(result.status,0,result.stderr);const errors=result.stderr.split('\n').filter(line=>/^(SCRIPT ERROR|ERROR):/.test(line)&&!/^ERROR: \d+ RID allocations .* were leaked at exit\.$/.test(line));assert.deepEqual(errors,[],result.stderr);}
 run(['--editor','--script',join(root,'tools/native-editor/bake_preview.gd'),'--',join(directory,'request.json'),join(directory,'receipt.json')]);
 assert.equal(JSON.parse(readFileSync(join(directory,'receipt.json'))).ok,true);
 run(['--script','res://probe.gd']);
 const comparison=JSON.parse(readFileSync(join(directory,'comparison.json')));
 assert.equal(Object.keys(comparison).length,2);
 for(const {source,baked} of Object.values(comparison)){assert.equal(Object.keys(source).length,8);assert.deepEqual(baked,source,'Actual native transforms, anchors, offsets and grow must survive baking and reload');assert.deepEqual(baked.A.grow,[1,1]);}
 for(const name of names)assert.deepEqual(readFileSync(join(directory,name)),original[name],name+' author bytes remain untouched');
});
