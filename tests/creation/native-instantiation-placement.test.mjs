import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runNativeScene} from '../../tools/native-scene/invoke.mjs';
import {nativeInstantiateOperation} from '../../apps/creation-workspace/native-authoring.js';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {execFileSync} from 'node:child_process';

const files={
 'project.godot':'config_version=5\n[application]\nconfig/name="Placement test"\n[display]\nwindow/size/viewport_width=800\nwindow/size/viewport_height=600\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
 'main.tscn':`[gd_scene format=3]
[node name="Root" type="Node3D"]
transform = Transform3D(0, 0, -2, 0.3, 3, 0, 4, 0, 0, 10, 20, 30)
metadata/wa_node_id = "root"
[node name="Parent" type="Node3D" parent="."]
transform = Transform3D(1, 0.2, 0, 0, 2, 0, 0, 0, 3, 3, -5, 7)
metadata/wa_node_id = "parent"
[node name="Boundary" type="Node" parent="Parent"]
metadata/wa_node_id = "boundary"
[node name="Singular" type="Node3D" parent="."]
scale = Vector3(0, 1, 1)
metadata/wa_node_id = "singular"
`,
 'prop.tscn':`[gd_scene format=3]
[node name="Prop" type="Node3D"]
transform = Transform3D(0, 0, -2, 0.3, 3, 0, 4, 0, 0, 6, 7, 8)
visibility_parent = NodePath("")
metadata/wa_node_id = "prop"
metadata/custom_payload = {"unknown": [1, "retained"]}
[node name="Child" type="Node3D" parent="."]
position = Vector3(1, 2, 3)
metadata/wa_node_id = "child"
`,
 'canvas.tscn':`[gd_scene format=3]
[node name="Root" type="Node2D"]
position = Vector2(30, -40)
rotation = 0.35
scale = Vector2(2, 3)
metadata/wa_node_id = "root"
[node name="Parent" type="Node2D" parent="."]
position = Vector2(100, 200)
rotation = -0.6
scale = Vector2(-1, 2)
skew = 0.25
metadata/wa_node_id = "parent"
[node name="Panel" type="Control" parent="."]
offset_left = 30.0
offset_top = 40.0
offset_right = 430.0
offset_bottom = 340.0
rotation = 0.2
scale = Vector2(1.5, 0.8)
pivot_offset = Vector2(50, 30)
metadata/wa_node_id = "panel"
[node name="Box" type="HBoxContainer" parent="."]
offset_right = 400.0
offset_bottom = 300.0
metadata/wa_node_id = "box"
[node name="Singular" type="Node2D" parent="."]
scale = Vector2(0, 0)
metadata/wa_node_id = "singular"
`,
 'sprite.tscn':`[gd_scene format=3]
[node name="Sprite" type="Node2D"]
position = Vector2(25, 35)
rotation = 0.3
scale = Vector2(2, 0.75)
skew = 0.2
modulate = Color(0.3, 0.4, 0.5, 1)
metadata/wa_node_id = "sprite"
`,
 'control.tscn':`[gd_scene format=3]
[node name="Control" type="Control"]
layout_mode = 3
anchor_left = 0.5
anchor_top = 0.5
anchor_right = 0.5
anchor_bottom = 0.5
offset_left = -50.0
offset_top = -25.0
offset_right = 50.0
offset_bottom = 25.0
rotation = 0.4
scale = Vector2(1.2, 0.8)
pivot_offset = Vector2(17, 11)
mouse_filter = 2
metadata/wa_node_id = "control"
`,
 'system.tscn':'[gd_scene format=3]\n[node name="System" type="Node"]\nmetadata/wa_node_id="system"\nmetadata/logic="preserved"\n',
};
const near=(actual,expected)=>{assert.equal(actual.length,expected.length);actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<0.002,`${actual} != ${expected}`));};
const row=(result,path)=>{const value=result.nodes.find(n=>n.path===path);assert.ok(value,`missing ${path}`);return value;};
const property=(node,name)=>node.properties.find(p=>p.name===name);
const op=(scene,name,position,dimension='3d',parent='Parent')=>({op:'instantiate',scene_path:`res://${scene}.tscn`,name,instance_id:name,parent:{path:parent},...(position===undefined?{}:{placement:{dimension,position}})});
async function fixture(t){
 const project=await mkdtemp(join(tmpdir(),'atelier-placement-'));
 t.after(()=>rm(project,{recursive:true,force:true}));
 for(const [path,text]of Object.entries(files))await writeFile(join(project,path),text);
 const run=(scene,ops)=>runNativeScene({projectDirectory:project,request:{scene_path:`res://${scene}.tscn`,action:ops?'apply':'inspect',...(ops?{ops}:{})}});
 return {project,run};
}

// Independent of the adapter's transform/index helpers: load saved bytes into
// an actual game SceneTree and observe Godot's native global transform getters.
async function runtimePositions(project,scene,paths){
 await writeFile(join(project,'placement_readback.gd'),`extends SceneTree
func _initialize():
 call_deferred("verify")
func verify():
 var scene = load("res://${scene}.tscn").instantiate()
 root.add_child(scene)
 await process_frame
 await process_frame
 var positions = {}
 for path in ${JSON.stringify(paths)}:
  var node = scene.get_node(path)
  var origin = node.global_transform.origin if node is Node3D else node.get_global_transform().origin
  positions[path] = [origin.x, origin.y, origin.z] if node is Node3D else [origin.x, origin.y]
 print("PLACEMENT_POSITIONS " + JSON.stringify(positions))
 scene.free()
 quit()
`);
 const stdout=execFileSync('/opt/homebrew/bin/godot',['--headless','--path',project,'--script','res://placement_readback.gd'],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
 const line=stdout.split('\n').find(line=>line.startsWith('PLACEMENT_POSITIONS '));assert.ok(line,stdout);return JSON.parse(line.slice('PLACEMENT_POSITIONS '.length));
}

test('placement frontend validates dimensions and finite vectors, clones options and preserves legacy request',()=>{
 const ctx={resourceId:'main',manifest:{resources:{main:{version:'fixed'},prop:{kind:'prefab'}}}};
 const placement={dimension:'3d',position:[3,4,5]},parent={node_id:'parent',instance_ids:[]};
 const actual=nativeInstantiateOperation('prop',ctx,{instanceId:'drop',parent,placement});
 assert.deepEqual(actual.operation.placement,placement);assert.equal(actual.expected_version,'fixed');assert.equal(actual.prefab_id,'prop');
 placement.position[0]=99;parent.node_id='other';assert.equal(actual.operation.placement.position[0],3);assert.equal(actual.operation.parent.node_id,'parent');
 assert.ok(!Object.hasOwn(nativeInstantiateOperation('prop',ctx).operation,'placement'));
 assert.deepEqual(nativeInstantiateOperation('prop',ctx,{placement:{dimension:'2d',position:[0,-4]}}).operation.placement.position,[0,-4]);
 for(const placement of [null,[],{}, {dimension:'4d',position:[1,2,3]}, {dimension:'3d',position:[1,2]}, {dimension:'2d',position:[1,2,3]}, {dimension:'3d',position:[1,'2',3]}, {dimension:'3d',position:[1,NaN,3]}, {dimension:'3d',position:[1,Infinity,3]}])assert.throws(()=>nativeInstantiateOperation('prop',ctx,{placement}),/坐标/);
});

test('real PackedScene placement preserves local basis, unknown properties and definition inheritance across save/reload',{timeout:120000},async t=>{
 const {project,run}=await fixture(t),definition=row(await run('prop'),'.');
 const positions=[[75,-22,41],[-18,7,81],[3,4,5]];
 await run('main',[op('prop','Drop',positions[0]),op('prop','AtRoot',positions[1],'3d','.'),op('prop','BoundaryDrop',positions[2],'3d','Parent/Boundary'),op('prop','Legacy')]);
 let result=await run('main');
 for(const [index,path]of ['Parent/Drop','AtRoot','Parent/Boundary/BoundaryDrop'].entries()){
  const node=row(result,path);near(node.world_transform.origin.value,positions[index]);assert.deepEqual(node.local_transform.basis,definition.local_transform.basis);
  assert.equal(node.scene_file_path,'res://prop.tscn');assert.deepEqual(node.metadata.custom_payload,definition.metadata.custom_payload);
  assert.equal(property(node,'metadata/custom_payload').overridden,false);
 }
 assert.deepEqual(row(result,'Parent/Legacy').local_transform,definition.local_transform);
 const saved=await readFile(join(project,'main.tscn'),'utf8');assert.match(saved,/instance=ExtResource/);assert.equal(await readFile(join(project,'prop.tscn'),'utf8'),files['prop.tscn']);
 await writeFile(join(project,'prop.tscn'),files['prop.tscn'].replace('"retained"','"updated"').replace('Vector3(1, 2, 3)','Vector3(8, 9, 10)'));
 result=await run('main');near(row(result,'Parent/Drop').world_transform.origin.value,positions[0]);assert.equal(row(result,'Parent/Drop').metadata.custom_payload.unknown[1],'updated');near(row(result,'Parent/Drop/Child').local_transform.origin.value,[8,9,10]);
 await writeFile(join(project,'top.tscn'),files['prop.tscn'].replace('visibility_parent = NodePath("")','top_level = true'));
 await run('main',[op('top','Top',[21,22,23])]);near(row(await run('main'),'Parent/Top').world_transform.origin.value,[21,22,23]);
 const runtime=await runtimePositions(project,'main',['Parent/Drop','AtRoot','Parent/Boundary/BoundaryDrop','Parent/Top']);
 ['Parent/Drop','AtRoot','Parent/Boundary/BoundaryDrop','Parent/Top'].forEach((path,index)=>near(runtime[path],[...positions,[21,22,23]][index]));
});

test('real 2D and Control placement uses native canvas transforms and retains anchors, size, pivot and basis',{timeout:120000},async t=>{
 const {project,run}=await fixture(t),sprite=row(await run('sprite'),'.'),control=row(await run('control'),'.');
 await run('canvas',[op('sprite','Sprite',[300,400],'2d'),op('sprite','NestedSprite',[350,-40],'2d','Panel'),op('control','UI',[420,270],'2d','Panel'),op('control','Under2D',[120,170],'2d','Parent')]);
 const result=await run('canvas');
 for(const [path,position]of [['Parent/Sprite',[300,400]],['Panel/NestedSprite',[350,-40]],['Panel/UI',[420,270]],['Parent/Under2D',[120,170]]]){
  const node=row(result,path);near(node.world_transform.origin.value,position);
  const original=node.type==='Node2D'?sprite:control;
  near(node.local_transform.x.value,original.local_transform.x.value);near(node.local_transform.y.value,original.local_transform.y.value);
  if(node.type==='Control'){
   for(const key of ['anchors','size','pivot_offset','scale'])near(node.control_layout.values[key],control.control_layout.values[key]);
   assert.equal(property(node,'mouse_filter').overridden,false);
   assert.equal(node.control_layout.fields.anchors.overridden,false);
  }
 }
 const runtime=await runtimePositions(project,'canvas',['Parent/Sprite','Panel/NestedSprite','Panel/UI','Parent/Under2D']);
 for(const [path,position]of [['Parent/Sprite',[300,400]],['Panel/NestedSprite',[350,-40]],['Panel/UI',[420,270]],['Parent/Under2D',[120,170]]])near(runtime[path],position);
 await writeFile(join(project,'simple.tscn'),`[gd_scene format=3]
[node name="Root" type="Node2D"]
position = Vector2(30, 40)
rotation = 0.5
scale = Vector2(2, 3)
[node name="Boundary" type="Node" parent="."]
`);
 await writeFile(join(project,'top2d.tscn'),files['sprite.tscn'].replace('position = Vector2(25, 35)','top_level = true\nposition = Vector2(25, 35)'));
 await run('simple',[op('sprite','Plain',[60,70],'2d','.'),op('sprite','BoundaryDrop',[80,90],'2d','Boundary'),op('top2d','Top',[100,110],'2d','.')]);
 const plain=await runtimePositions(project,'simple',['Plain','Boundary/BoundaryDrop','Top']);
 near(plain.Plain,[60,70]);near(plain['Boundary/BoundaryDrop'],[80,90]);near(plain.Top,[100,110]);
});

test('bad placement, dimension mismatch, singular parents and later operation failures save no partial instance',{timeout:120000},async t=>{
 const {project,run}=await fixture(t);
 for(const placement of [null,[],{}, {dimension:'bad',position:[1,2,3]}, {dimension:'3d',position:[1,2]}, {dimension:'3d',position:[1,'2',3]}, {dimension:'3d',position:[true,2,3]}, {dimension:'3d',position:[1e100,2,3]}, {dimension:'2d',position:[1,2]}]){
  const before=await readFile(join(project,'main.tscn'),'utf8');
  await assert.rejects(run('main',[op('prop','ValidBefore',[1,2,3]),{...op('prop','Invalid',[1,2,3]),placement}]),e=>e.result?.errors.some(x=>['INVALID_PLACEMENT','PLACEMENT_DIMENSION_MISMATCH'].includes(x.code)));
  assert.equal(await readFile(join(project,'main.tscn'),'utf8'),before);
 }
 for(const [scene,operation,code]of [
  ['main',op('prop','Singular',[1,2,3],'3d','Singular'),'INVALID_PLACEMENT'],
  ['canvas',op('sprite','Singular',[1,2],'2d','Singular'),'INVALID_PLACEMENT'],
  ['canvas',op('sprite','Wrong',[1,2,3],'3d'),'PLACEMENT_DIMENSION_MISMATCH'],
  ['canvas',op('control','Wrong',[1,2,3],'3d','Panel'),'PLACEMENT_DIMENSION_MISMATCH'],
  ['canvas',op('control','Managed',[1,2],'2d','Box'),'CONTAINER_MANAGED_LAYOUT'],
 ]){
  const before=await readFile(join(project,`${scene}.tscn`),'utf8');
  await assert.rejects(run(scene,[operation]),e=>e.result?.errors.some(x=>x.code===code),`${scene}: ${operation.name}`);assert.equal(await readFile(join(project,`${scene}.tscn`),'utf8'),before);
 }
 const before=await readFile(join(project,'main.tscn'),'utf8');
 await assert.rejects(run('main',[op('prop','Drop',[1,2,3]),{op:'rename',target:{path:'Missing'},name:'Failure'}]));assert.equal(await readFile(join(project,'main.tscn'),'utf8'),before);
 await run('main',[op('system','Logic',[1,2,3])]);assert.equal(row(await run('main'),'Parent/Logic').metadata.logic,'preserved');
});

test('native domain atomically commits placed instance, restores exact bytes on undo and rejects whole failed transaction',{timeout:180000},async t=>{
 const data=await mkdtemp(join(tmpdir(),'atelier-placement-domain-')),store=new CreationStore(join(data,'creation.sqlite')),native=new NativeProjects({store,data,enforceIsolation:true});
 t.after(async()=>{await native.close();store.close();await rm(data,{recursive:true,force:true});});
 const user=store.register({name:'placement-author',password:'placement-test-password'}).user;
 const p=store.createProject(user,{name:'Placement'},{entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',objects:[]}}}).project.id;
 const texts=Object.fromEntries(['project.godot','main.tscn','prop.tscn'].map(path=>[path,files[path]]));
 texts['.atelier/catalog.json']=JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',path:'main.tscn'},prop:{id:'prop',kind:'prefab',name:'Prop',path:'prop.tscn'}}});
 const initial=await native.inspectFiles(Object.fromEntries(Object.entries(texts).map(([path,text])=>[path,native.archive.put(text)])),{assignIds:true});
 const branch=store.branchFor(user,p,'main');branch.head=store.writeRevision(p,[branch.head],initial,user.id).id;store.put('creator_branch',branch);
 const current=()=>store.branchView(user,p,'main'),request=ops=>({transaction_id:crypto.randomUUID(),base_revision:current().head,ops});
 const instantiate=(name,dimension='3d')=>nativeInstantiateOperation('prop',{resourceId:'main',manifest:current().manifest},{instanceId:name,name,parent:{node_id:'parent',instance_ids:[]},placement:{dimension,position:dimension==='3d'?[30,40,50]:[30,40]}});
 const count=store.list('creator_revision').length;
 const placed=await native.apply(user,p,'main',request([instantiate('Drop')]));
 assert.equal(store.list('creator_revision').length,count+1,'creation and positioning produce exactly one revision');
 const reloaded=await native.inspectFiles(placed.branch.manifest.source_files);
 near(row({nodes:reloaded.resources.main.native_nodes},'Parent/Drop').world_transform.origin.value,[30,40,50]);
 assert.equal(placed.branch.manifest.source_files['prop.tscn'].hash,initial.source_files['prop.tscn'].hash);
 // The existing domain requires explicit acknowledgement when a file inverse
 // removes a placed instance with a transform override. Respect that guard.
 await assert.rejects(native.apply(user,p,'main',request(placed.inverse)),e=>e.details?.code==='native_removed_overrides');
 const inserted=placed.branch.manifest.resources.main.native_nodes.find(node=>node.path==='Parent/Drop');
 const undone=await native.apply(user,p,'main',{...request(placed.inverse),discard_removed_overrides:[{resource_id:'main',target:{node_id:inserted.node_id,instance_ids:inserted.instance_ids},expected_node_version:inserted.version}]});
 assert.deepEqual({...undone.branch.manifest.source_files},{...initial.source_files});
 const head=current().head,beforeCount=store.list('creator_revision').length,bad=request([instantiate('First'),instantiate('Wrong','2d')]);
 await assert.rejects(native.apply(user,p,'main',bad));assert.equal(current().head,head);assert.equal(store.list('creator_revision').length,beforeCount);assert.equal(store.get('creator_receipt',`${p}:main:${bad.transaction_id}`),null);
 assert.deepEqual({...current().manifest.source_files},{...initial.source_files});
});
