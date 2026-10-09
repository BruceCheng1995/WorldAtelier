import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runNativeScene,importNativeProject} from '../../tools/native-scene/invoke.mjs';

// Actual Godot import/GEN_EDIT_STATE_MAIN/PackedScene save/reload. Neither a
// runtime ACK nor a reconstructed JSON scene supplies these values or flags.
test('Control normalization retains native inherited layout, explicit overrides and unrelated same-name properties',{timeout:180000},async t=>{
 const directory=mkdtempSync(join(process.env.WA_CONTROL_IMPORT_EVIDENCE??tmpdir(),'control-import-'));
 t.after(()=>{if(!process.env.WA_CONTROL_IMPORT_EVIDENCE)rmSync(directory,{recursive:true,force:true});});
 const adapterPath=process.env.WA_CONTROL_IMPORT_ADAPTER??resolve(import.meta.dirname,'../../tools/native-scene/adapter.gd');
 const files={
  'project.godot':'config_version=5\n[application]\nconfig/name="Control inheritance regression"\n[display]\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=720\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  'same_name.gd':'extends Node\n@export var layout_mode: int = 7\n@export var offset_left: float = 9.0\n@export var anchors_preset: int = 4\n',
  'card.tscn':'[gd_scene format=3]\n[node name="Card" type="Control"]\nlayout_mode=3\noffset_left=20.0\noffset_top=25.0\noffset_right=260.0\noffset_bottom=165.0\nmetadata/wa_node_id="card"\nmetadata/unknown={"keep":"opaque"}\n[node name="Face" type="ColorRect" parent="."]\nlayout_mode=1\nanchor_right=1.0\nanchor_bottom=1.0\ncolor=Color(0.12,0.55,0.78,1)\nmetadata/wa_node_id="face"\n',
  'main.tscn':'[gd_scene load_steps=3 format=3]\n[ext_resource type="PackedScene" path="res://card.tscn" id="card"]\n[ext_resource type="Script" path="res://same_name.gd" id="script"]\n[node name="Main" type="Control"]\nlayout_mode=3\nanchor_right=1.0\nanchor_bottom=1.0\nmetadata/wa_node_id="main"\n[node name="Parent" type="Control" parent="."]\noffset_left=80.0\noffset_top=70.0\noffset_right=620.0\noffset_bottom=380.0\nrotation=0.12\nscale=Vector2(1.1,0.9)\nmetadata/wa_node_id="parent"\n[node name="A" parent="Parent" instance=ExtResource("card")]\nmetadata/wa_instance_id="a"\n[node name="B" parent="Parent" instance=ExtResource("card")]\nmetadata/wa_instance_id="b"\n[node name="Explicit" parent="Parent" instance=ExtResource("card")]\nlayout_mode=1\noffset_left=110.0\noffset_top=120.0\noffset_right=510.0\noffset_bottom=320.0\nmetadata/wa_instance_id="explicit"\n[node name="SameName" type="Node" parent="."]\nscript=ExtResource("script")\nlayout_mode=11\noffset_left=12.0\nanchors_preset=5\nmetadata/wa_node_id="same-name"\n',
 };
 for(const [path,text]of Object.entries(files))writeFileSync(join(directory,path),text.replaceAll('\\n','\n'));
 await importNativeProject({projectDirectory:directory,enforceIsolation:true});
 const reports=[];
 const run=async request=>{const response=await runNativeScene({projectDirectory:directory,adapterPath,enforceIsolation:true,request});reports.push({request,nodes:response.nodes?.map(n=>({path:n.path,layout:n.control_layout,properties:n.properties?.filter(p=>['layout_mode','anchors_preset','grow_horizontal','grow_vertical'].includes(p.name)||p.name.startsWith('offset_'))}))});return response;};
 const apply=(path,ops=[])=>run({action:'apply',scene_path:'res://'+path,assign_ids:true,ops});
 const read=()=>run({action:'inspect',scene_path:'res://main.tscn'});
 const props=(response,path)=>Object.fromEntries(response.nodes.find(n=>n.path===path).properties.map(p=>[p.name,p]));
 const offsets=(response,path)=>['offset_left','offset_top','offset_right','offset_bottom'].map(k=>props(response,path)[k].value);
 const block=(text,name)=>text.match(new RegExp('\\[node name="'+name+'"[^\\n]*\\n([\\s\\S]*?)(?=\\n\\[|$)'))?.[1]??'';
 const noOverrides=response=>{for(const name of ['A','B']){assert.deepEqual(offsets(response,'Parent/'+name),[20,25,260,165]);const properties=props(response,'Parent/'+name);for(const key of ['layout_mode','offset_left','offset_top','offset_right','offset_bottom'])assert.equal(properties[key].stored_locally,false,name+' '+key);assert.doesNotMatch(block(readFileSync(join(directory,'main.tscn'),'utf8'),name),/layout_mode\s*=|offset_(?:left|top|right|bottom)\s*=/);}};
 await apply('card.tscn');
 noOverrides(await apply('main.tscn'));const first=readFileSync(join(directory,'main.tscn'),'utf8'),explicit=block(first,'Explicit');assert.doesNotMatch(block(first,'Main'),/anchors_preset\s*=/);
 noOverrides(await apply('main.tscn'));const second=readFileSync(join(directory,'main.tscn'),'utf8');assert.equal(second,first,'second normalization preserves canonical source bytes, including grow directions');assert.equal(block(second,'Explicit'),explicit);
 let result=await read();assert.equal(props(result,'.').grow_horizontal.value,1);assert.equal(props(result,'.').grow_vertical.value,1);assert.equal(props(result,'SameName').anchors_preset.value,5);assert.deepEqual(offsets(result,'Parent/Explicit'),[110,120,510,320]);assert.equal(props(result,'Parent/Explicit').layout_mode.value,1);assert.equal(props(result,'SameName').layout_mode.value,11);assert.equal(props(result,'SameName').offset_left.value,12);
 await apply('card.tscn',[{op:'control_layout',target:{node_id:'card',instance_ids:[]},value:{offsets:[40,45,320,205]}}]);
 result=await read();for(const name of ['A','B']){assert.deepEqual(offsets(result,'Parent/'+name),[40,45,320,205]);for(const prop of ['offset_left','offset_top','offset_right','offset_bottom'])assert.equal(props(result,'Parent/'+name)[prop].stored_locally,false);}
 assert.deepEqual(offsets(result,'Parent/Explicit'),[110,120,510,320]);
 await apply('main.tscn');assert.equal(block(readFileSync(join(directory,'main.tscn'),'utf8'),'Explicit'),explicit);
 // Explicit intent in this very transaction must survive even though the old
 // source had no layout_mode property at A. Generic set/reset use the same path.
 result=await apply('main.tscn',[{op:'set_property',target:{node_id:'card',instance_ids:['a']},property:'layout_mode',value:1}]);
 assert.equal(props(result,'Parent/A').layout_mode.stored_locally,true);assert.equal(props(result,'Parent/A').layout_mode.value,1);
 await apply('main.tscn');assert.match(block(readFileSync(join(directory,'main.tscn'),'utf8'),'A'),/layout_mode\s*=\s*1/);
 result=await apply('main.tscn',[{op:'reset_property',target:{node_id:'card',instance_ids:['a']},property:'layout_mode'}]);assert.equal(props(result,'Parent/A').layout_mode.stored_locally,false);assert.deepEqual(offsets(result,'Parent/A'),[40,45,320,205]);
 result=await apply('main.tscn',[{op:'control_layout',target:{node_id:'card',instance_ids:['explicit']},reset:['offsets']}]);assert.deepEqual(offsets(result,'Parent/Explicit'),[40,45,320,205]);for(const prop of ['offset_left','offset_top','offset_right','offset_bottom'])assert.equal(props(result,'Parent/Explicit')[prop].stored_locally,false);
 assert.equal(props(result,'Parent/Explicit').layout_mode.value,1);assert.equal(props(result,'SameName').layout_mode.value,11);
 // An explicit editor preset setter must remain present; its real Godot
 // anchors/offsets/grow result must survive another independent engine load.
 result=await apply('main.tscn',[{op:'set_property',target:{node_id:'card',instance_ids:['a']},property:'layout_mode',value:1},{op:'set_property',target:{node_id:'card',instance_ids:['a']},property:'anchors_preset',value:15}]);
 assert.equal(props(result,'Parent/A').anchors_preset.stored_locally,true);assert.equal(props(result,'Parent/A').anchors_preset.value,15);assert.equal(props(result,'Parent/A').grow_horizontal.value,2);assert.equal(props(result,'Parent/A').grow_vertical.value,2);assert.deepEqual(offsets(result,'Parent/A'),[0,0,0,0]);
 const presetBlock=block(readFileSync(join(directory,'main.tscn'),'utf8'),'A');await apply('main.tscn');assert.equal(block(readFileSync(join(directory,'main.tscn'),'utf8'),'A'),presetBlock);
 // The supported atomic preset operation writes real layout properties; a
 // synthetic editor alias must not modify those values on the next load.
 result=await apply('main.tscn',[{op:'control_layout',target:{node_id:'card',instance_ids:['b']},preset:'full_rect'}]);const presetLayout=result.nodes.find(n=>n.path==='Parent/B').control_layout;
 result=await apply('main.tscn');assert.deepEqual(result.nodes.find(n=>n.path==='Parent/B').control_layout,presetLayout);
 const beforeRejected=readFileSync(join(directory,'main.tscn'),'utf8');
 await assert.rejects(()=>apply('main.tscn',[{op:'set_property',target:{node_id:'main',instance_ids:[]},property:'layout_mode',value:0}]),error=>error.result?.errors?.some(e=>e.code==='CONTROL_LAYOUT_ALIAS_REJECTED'));
 assert.equal(readFileSync(join(directory,'main.tscn'),'utf8'),beforeRejected,'a setter Godot rejects cannot be acknowledged or save source');
 writeFileSync(join(directory,'report.json'),JSON.stringify({ok:true,adapterPath,reports},null,2));
 console.log('CONTROL_IMPORT_EVIDENCE '+directory);
});
