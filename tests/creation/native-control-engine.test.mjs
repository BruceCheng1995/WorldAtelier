import test from 'node:test';
import {tmpdir} from 'node:os';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {runNativeScene} from '../../tools/native-scene/invoke.mjs';
test('Control layouts use native property groups and preserve instance defaults',{timeout:120000},async t=>{
const home=path.resolve(import.meta.dirname,'../..'),project=await mkdtemp(path.join(tmpdir(),'atelier-control-engine-'));t.after(()=>rm(project,{recursive:true,force:true}));
await writeFile(path.join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Control layout proof"\n[display]\nwindow/size/viewport_width=800\nwindow/size/viewport_height=600\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
await writeFile(path.join(project,'panel.tscn'),`[gd_scene format=3]
[node name="Panel" type="Control"]
layout_mode=3
anchors_preset=0
offset_right=400.0
offset_bottom=300.0
metadata/wa_node_id="panel"
[node name="Child" type="ColorRect" parent="."]
layout_mode=0
anchor_left=0.5
anchor_top=0.5
anchor_right=0.5
anchor_bottom=0.5
offset_left=-40.0
offset_top=-20.0
offset_right=40.0
offset_bottom=20.0
rotation=0.2
color=Color(0.2,0.5,0.8,1)
metadata/wa_node_id="child"
`);
await writeFile(path.join(project,'main.tscn'),`[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://panel.tscn" id="1"]
[node name="Root" type="Control"]
layout_mode=3
anchors_preset=15
anchor_right=1.0
anchor_bottom=1.0
grow_horizontal=2
grow_vertical=2
metadata/wa_node_id="root"
[node name="A" parent="." instance=ExtResource("1")]
metadata/wa_instance_id="a"
[node name="B" parent="." instance=ExtResource("1")]
offset_left=400.0
offset_right=800.0
metadata/wa_instance_id="b"
[node name="Box" type="HBoxContainer" parent="."]
offset_top=400.0
offset_right=400.0
offset_bottom=500.0
metadata/wa_node_id="box"
[node name="Item" type="ColorRect" parent="Box"]
custom_minimum_size=Vector2(30,20)
layout_mode=2
metadata/wa_node_id="item"
`);
const run=(scene,ops)=>runNativeScene({projectDirectory:project,adapterPath:path.join(home,'tools/native-scene/adapter.gd'),request:{scene_path:`res://${scene}.tscn`,action:ops?'apply':'inspect',...(ops?{ops}:{} )}});
const reports=[];const node=(r,p)=>r.nodes.find(n=>n.path===p);const target={node_id:'child',instance_ids:['a']};
await run('panel',[]); await run('main',[]);
let r=await run('main');assert.deepEqual(node(r,'A/Child').control_layout.values.position,[160,130]);assert.equal(node(r,'Box/Item').control_layout.container_managed,true);reports.push({case:'initial real parent rect',ok:true});
r=await run('main',[{op:'control_layout',target,value:{position:[120,90],size:[120,60]}}]);assert.deepEqual(node(r,'A/Child').control_layout.values.position,[120,90]);assert.deepEqual(node(r,'A/Child').control_layout.values.size,[120,60]);assert.deepEqual(node(r,'B/Child').control_layout.values.size,[80,40]);reports.push({case:'independent instance rect override',ok:true});
await run('panel',[{op:'control_layout',target:{node_id:'child',instance_ids:[]},value:{size:[100,50]}}]);r=await run('main');assert.deepEqual(node(r,'A/Child').control_layout.values.size,[120,60]);assert.deepEqual(node(r,'B/Child').control_layout.values.size,[100,50]);
r=await run('main',[{op:'control_layout',target,reset:['offsets']}]);assert.deepEqual(node(r,'A/Child').control_layout.values.size,[100,50]);assert.equal(node(r,'A/Child').control_layout.fields.offsets.overridden,false);reports.push({case:'definition follow and reset removes storage differences',ok:true});
r=await run('main',[{op:'control_layout',target,value:{pivot_offset:[20,10],rotation_degrees:35,scale:[-1,2]},preset:'full_rect'}]);assert.deepEqual(node(r,'A/Child').control_layout.values.size,[400,300]);assert.deepEqual(node(r,'A/Child').control_layout.values.anchors,[0,0,1,1]);reports.push({case:'real native full rect preset and pivot/rotation/scale',ok:true});
await assert.rejects(run('main',[{op:'control_layout',target:{node_id:'item',instance_ids:[]},value:{position:[30,40]}}]),e=>e.response?.errors?.some(x=>x.code==='CONTAINER_MANAGED_LAYOUT')||e.message.includes('Container'));reports.push({case:'container rejects managed position',ok:true});
r=await run('main',[{op:'control_layout',target:{node_id:'item',instance_ids:[]},value:{custom_minimum_size:[100,50],size_flags_horizontal:3,size_flags_stretch_ratio:2}}]);assert.deepEqual(node(r,'Box/Item').control_layout.values.size,[400,100]);reports.push({case:'container recalculates real rect from supported configuration',ok:true});
const src=await readFile(path.join(project,'main.tscn'),'utf8');assert.ok(src.includes('instance=ExtResource'));assert.ok((await readFile(path.join(project,'panel.tscn'),'utf8')).includes('color = Color'));reports.push({case:'native instances and unrelated material retained',ok:true});
assert.equal(reports.length,7);
});
