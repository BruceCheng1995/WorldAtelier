import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {nativeLaunchSettings} from '../../services/creation/native-snapshot.mjs';

test('real Web resource pack preserves native inherited Control layout and author scene bytes',{timeout:120000},t=>{
  const base=mkdtempSync(join(tmpdir(),'native-control-export-')),project=join(base,'project'),runner=join(base,'runner');
  t.after(()=>rmSync(base,{recursive:true,force:true}));mkdirSync(project);mkdirSync(runner);
  const files={
    'panel.tscn':'[gd_scene format=3]\n[node name="Panel" type="Control"]\nlayout_mode=3\noffset_left=20.0\noffset_top=25.0\noffset_right=300.0\noffset_bottom=165.0\n',
    'nested.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://panel.tscn" id="panel"]\n[node name="Nested" type="Control"]\nlayout_mode=3\noffset_left=60.0\noffset_top=70.0\noffset_right=660.0\noffset_bottom=470.0\n[node name="Inner" parent="." instance=ExtResource("panel")]\n',
    'main.tscn':'[gd_scene load_steps=3 format=3]\n[ext_resource type="PackedScene" path="res://panel.tscn" id="panel"]\n[ext_resource type="PackedScene" path="res://nested.tscn" id="nested"]\n[node name="Main" type="Control"]\nlayout_mode=3\nanchor_right=1.0\nanchor_bottom=1.0\n[node name="A" parent="." instance=ExtResource("panel")]\n[node name="B" parent="." instance=ExtResource("panel")]\noffset_left=100.0\noffset_top=120.0\noffset_right=380.0\noffset_bottom=260.0\n[node name="Nested" parent="." instance=ExtResource("nested")]\nrotation=0.2\nscale=Vector2(-1.1,0.9)\n',
  };
  for(const [name,value]of Object.entries(files))writeFileSync(join(project,name),value);
  // Exercise the production overlay and real exporter. The tiny bootstrap is
  // intentionally inert: this regression isolates native resource conversion,
  // while the independent browser suite boots the full canonical GameRuntime.
  mkdirSync(join(project,'atelier_runtime'));
  writeFileSync(join(project,'atelier_runtime/standalone.gd'),'extends Node\n');
  writeFileSync(join(project,'atelier_runtime/standalone.tscn'),'[gd_scene format=3]\n[node name="Bootstrap" type="Node"]\n');
  writeFileSync(join(project,'project.godot'),nativeLaunchSettings('config_version=5\n[application]\nconfig/name="NativeControlExport"\n[display]\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=720\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'));
  writeFileSync(join(project,'export_presets.cfg'),'[preset.0]\nname="Web"\nplatform="Web"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter="*.gd"\nexclude_filter=""\nscript_export_mode=0\n[preset.0.options]\nvariant/extensions_support=false\nvariant/thread_support=false\n');
  writeFileSync(join(project,'probe.gd'),`extends SceneTree
func _initialize(): run.call_deferred()
func inspect(node: Node, base: Node, rows: Dictionary):
 if node is Control:
  rows[str(base.get_path_to(node))]={"anchors":[node.anchor_left,node.anchor_top,node.anchor_right,node.anchor_bottom],"offsets":[node.offset_left,node.offset_top,node.offset_right,node.offset_bottom],"position":[node.position.x,node.position.y],"size":[node.size.x,node.size.y],"grow":[node.grow_horizontal,node.grow_vertical],"scale":[node.scale.x,node.scale.y],"rotation":node.rotation}
 for child in node.get_children(): inspect(child,base,rows)
func run():
 var report={"scenes":{},"source":{}}
 for name in ["main.tscn","panel.tscn","nested.tscn"]:
  report.source[name]=FileAccess.get_file_as_string("res://"+name)
 for dimensions in [Vector2i(1280,720),Vector2i(640,360)]:
  var viewport=SubViewport.new()
  viewport.size=dimensions
  root.add_child(viewport)
  var scene=load("res://main.tscn").instantiate()
  viewport.add_child(scene)
  await process_frame
  await process_frame
  var rows={}
  inspect(scene,scene,rows)
  report.scenes[str(dimensions)]=rows
  viewport.free()
 print("CONTROL_EXPORT_PROBE "+JSON.stringify(report))
 quit()
`);
  const engine=process.env.GODOT_PATH??'/opt/homebrew/bin/godot';
  function run(directory,args){
    const result=spawnSync(engine,['--headless','--path',directory,...args],{cwd:directory,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
    assert.doesNotMatch(result.stderr,/^(?:SCRIPT ERROR|ERROR):/m,result.stderr);
    return result.stdout;
  }
  const decode=output=>JSON.parse(output.split('\n').find(line=>line.startsWith('CONTROL_EXPORT_PROBE '))?.slice('CONTROL_EXPORT_PROBE '.length)??'null');
  const source=decode(run(project,['--script','res://probe.gd']));
  const pack=resolve(base,'game.pck');run(project,['--export-pack','Web',pack]);
  // A fresh directory has no loose authored files to accidentally load if a
  // resource pack path or remapping is broken.
  const exported=decode(run(runner,['--main-pack',pack,'--script','res://probe.gd']));
  assert.deepEqual(exported,source);
  assert.deepEqual(exported.source,files);
  for(const rows of Object.values(exported.scenes)){
    assert.equal(Object.keys(rows).length,5);
    assert.deepEqual(rows.A.offsets,[20,25,300,165]);
    assert.deepEqual(rows.B.offsets,[100,120,380,260]);
    assert.deepEqual(rows['Nested/Inner'].offsets,[20,25,300,165]);
    assert.deepEqual(rows['.'].grow,[1,1]);
  }
  for(const [name,value]of Object.entries(files))assert.equal(readFileSync(join(project,name),'utf8'),value);
});
