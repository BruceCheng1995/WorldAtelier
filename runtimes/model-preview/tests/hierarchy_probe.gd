extends SceneTree
const Graph=preload("res://hierarchy_scene.gd")
const Factory=preload("res://scene_factory.gd")
const Loader=preload("res://scene_loader.gd")
const Simulation=preload("res://world_simulation.gd")
var options={};var checks=[];var fixtures={};var host: Node3D;var loader=Loader.new();var simulation: Node3D
var seq=0;var frames=0;var input_sequence=0
func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var parts=arg.substr(2).split("=",true,1);options[parts[0]]=parts[1]
	run.call_deferred()
func check(ok: bool,detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok:print("HIERARCHY_FAILED "+detail)
func view() -> SubViewport:
	var v=SubViewport.new();v.size=Vector2i(1000,750);v.own_world_3d=true;v.render_target_update_mode=SubViewport.UPDATE_DISABLED;root.add_child(v);return v
func send(type: String,value: Dictionary) -> void:
	var packet={"source":"world-atelier-workspace","nonce":host.nonce,"type":type,"seq":host.applied_seq,"document_id":host.document_id}
	packet.merge(value,true);host.receive(packet)
func scene(value: Dictionary) -> void:
	seq+=1;send("scene",merge(value,{"seq":seq,"frame":true}))
	for i in range(1000):
		if host.applied_seq==seq:return
		await create_timer(.005).timeout
	check(false,"editor candidate loaded")
func merge(a: Dictionary,b: Dictionary) -> Dictionary:
	var result=a.duplicate(true);result.merge(b,true);return result
func object_row(scene_value: Dictionary,path: Array,node_id: String) -> Dictionary:
	for row in scene_value.hierarchy_pack.objects:
		if row.address.instance_path==path and row.address.definition_node_id==node_id:return row
	return {}
func mouse(at: Vector2,down: bool) -> void:
	var e=InputEventMouseButton.new();e.position=at;e.button_index=MOUSE_BUTTON_LEFT;e.pressed=down;host._input(e)
func move_mouse(at: Vector2) -> void:
	var e=InputEventMouseMotion.new();e.position=at;e.button_mask=MOUSE_BUTTON_MASK_LEFT;host._input(e)
func point(handle: String) -> Vector2:
	var points=host.gizmo.screen_handles()[handle].points
	for p in points:
		if host.gizmo.hit_test(p)==handle:return p
	return points[0].lerp(points[-1],.75)
func relay(count: int,move: Vector2=Vector2.ZERO,interact: bool=false) -> void:
	for i in range(count):
		await physics_frame
		input_sequence=maxi(input_sequence,simulation.players.a.input_seq)+1
		simulation.accept_input({"player_id":"a","epoch":1,"scene_revision":simulation.scene_revision,"input_seq":input_sequence,"move":[move.x,move.y],"interact":interact and i==0})
		simulation.step(1.0/60);frames+=1
		if host!=null and not host.world_client.world_id.is_empty():
			send("world",{"action":"snapshot","snapshot":simulation.snapshot(true)})
		await process_frame
func run() -> void:
	create_timer(45).timeout.connect(func():print("HIERARCHY_TIMEOUT");quit(2))
	fixtures=JSON.parse_string(FileAccess.get_file_as_string(options.fixture))
	check(Factory.validate(fixtures.numeric,options.origin).is_empty(),"canonical exact bytes/hash and fixed fixture accepted")
	var loaded=await loader.prepare(root,fixtures.numeric,options.origin)
	check(loaded.ok,"actual hierarchy loader constructs asset-free candidate")
	if not loaded.ok:print(loaded);quit(2);return
	view().add_child(loaded.root)
	check(loaded.objects.size()==10 and loaded.graph.mounts.size()==4,"ten objects and four explicit mounts retained")
	for kind in ["object","mount"]:
		for row in fixtures.numeric.hierarchy_pack.objects if kind=="object" else fixtures.numeric.hierarchy_pack.mounts:
			var node=loaded.graph.nodes[kind+":"+row.id]
			check(Graph.close_matrix(Graph.matrix(node.global_transform),row.world_matrix,2e-5),"actual world matrix "+kind+":"+row.id)
			check(row.parent==null or node.get_parent()==loaded.graph.nodes[Graph.ref_key(row.parent)],"explicit parent "+kind+":"+row.id)
	loaded.root.queue_free()
	var malformed=fixtures.numeric.duplicate(true);malformed.hierarchy_pack.objects[0].world_matrix[12]+=1
	check(not Factory.validate(malformed,options.origin).is_empty(),"canonical packet mutation rejected before assembly")
	malformed=fixtures.numeric.duplicate(true);malformed.asset_access=[{"hash":fixtures.model_hash,"extension":"glb","url":"https://attacker.invalid/model.glb"}]
	check(not Factory.validate(malformed,options.origin).is_empty(),"unused foreign asset access rejected")
	var shear=await loader.prepare(root,fixtures.shear,options.origin)
	check(shear.ok,"visual world shear is accepted without a primitive collider")
	view().add_child(shear.root)
	var shear_row=object_row(fixtures.shear,["a"],"root")
	check(shear_row.world_transform==null and Graph.close_matrix(Graph.matrix(shear.objects[shear_row.id].global_transform),shear_row.world_matrix,2e-5),"nested nonuniform parent and rotation retain full sheared world matrix")
	var box=shear_row.duplicate(true);box.node.components={"collider":{"shape":"box"}}
	check(Graph.physics_error(box)=="runtime_sheared_box_unsupported","sheared box fails explicit policy")
	box.node.components={"trigger":{"shape":"sphere"}}
	check(Graph.physics_error(box)=="runtime_sphere_transform_unsupported","sheared sphere fails explicit policy")
	shear.root.queue_free()
	host=load("res://main.gd").new();view().add_child(host);host.origin=options.origin
	await scene(fixtures.playable)
	check(host.hierarchy_editor.active() and host.objects.size()==6 and host.hierarchy_editor.graph.mounts.size()==2,"editor derives six objects plus mounts from pack, ignores invalid outer UI geometry")
	check(host.active_assets.size()==2 and host.active_assets[0].hash==fixtures.model_hash,"real HTTP GLB parser reports verified asset hash in two fixed instances")
	var left=object_row(fixtures.playable,["left"],"device");var right=object_row(fixtures.playable,["right"],"device")
	var left_node=host.objects[left.id];var right_node=host.objects[right.id]
	check(left.id!=right.id and left_node.global_position.distance_to(right_node.global_position)>9,"same prefab definition has distinct full path identity and world position")
	host.select_object(left.id,true);host.frame_scene(true)
	var selected=host.outbound_log.filter(func(p):return p.type=="selected").back()
	check(selected.address==left.address and selected.object_version==left.object_version and selected.world_matrix.size()==16,"pick notification carries full address fixed version and actual matrix")
	var pixel=host.camera.unproject_position(left_node.global_position+Vector3.UP*.8)
	check(host.pick_object(pixel)==left.id,"real triangle pick returns owning nested object, not its ancestors")
	var old=left_node.global_transform;host.set_editor_tool("move");var p=point("x");mouse(p,true)
	check(host.drag_id==left.id and host.drag_before.address==left.address,"actual nested gizmo starts full-identity transaction")
	move_mouse(p+host.drag_screen_axis*30);mouse(p+host.drag_screen_axis*30,false)
	var changed=left_node.global_transform
	check(changed.origin.x>old.origin.x and absf(changed.origin.z-old.origin.z)<.001,"world-axis nested move changes intended axis")
	var commit=host.outbound_log.filter(func(q):return q.type=="transform" and q.phase=="commit").back()
	check(commit.world_matrix.size()==16 and commit.address==left.address and commit.before.world_matrix.size()==16 and not commit.has("rotation"),"hierarchy commit does not substitute Euler for full matrix")
	check(fixtures.playable.hierarchy_pack==host.hierarchy_editor.source_scene.hierarchy_pack,"gizmo does not modify canonical source pack")
	send("editor_preview",{"source_revision":fixtures.playable.scene_revision,"previews":[],"reset_local":true})
	check(left_node.global_transform.is_equal_approx(old),"explicit source rejection resets unacknowledged local commit")
	var preview=Graph.matrix(old);preview[13]+=3
	var value={"id":left.id,"address":left.address,"world_matrix":preview,"expected_object_version":left.object_version,"expected_ancestry_hash":left.ancestry_hash,"expires_at":0,"peer_id":"b"}
	send("editor_preview",{"source_revision":fixtures.playable.scene_revision,"previews":[value]})
	check(absf(left_node.global_position.y-old.origin.y-3)<.001,"version-fenced remote matrix preview updates only presentation")
	send("editor_preview",{"source_revision":"stale","previews":[]})
	check(absf(left_node.global_position.y-old.origin.y-3)<.001,"stale source revision cannot clear active preview")
	send("editor_preview",{"source_revision":fixtures.playable.scene_revision,"previews":[]})
	check(left_node.global_transform.is_equal_approx(old),"empty remote preview restores canonical local hierarchy")
	var retained_seq=host.applied_seq
	var retained_root=host.scene_root
	seq+=1;send("scene",merge(fixtures.bad_model,{"seq":seq}))
	for i in range(500):
		if host.outbound_log.any(func(v):return v.type=="error" and v.seq==seq):break
		await create_timer(.005).timeout
	check(host.scene_root==retained_root and host.applied_seq==retained_seq and left_node.global_transform.is_equal_approx(old),"hash-verified invalid GLB candidate leaves old editor tree and applied sequence intact")
	seq+=1;send("scene",merge(fixtures.bad_box,{"seq":seq}))
	check(host.scene_root==retained_root and host.applied_seq==retained_seq,"unsupported sheared collider is rejected before replacing current editing scene")
	var instance_id=left_node.get_instance_id();await scene(fixtures.playable)
	check(host.objects[left.id].get_instance_id()==instance_id,"same immutable models and topology reuse actual nodes")
	# Exercise local scale through a genuine nonorthogonal world basis.
	await scene(fixtures.shear)
	var leaf=object_row(fixtures.shear,["a"],"door")
	var leaf_node: Node3D=host.objects[leaf.id]
	host.select_object(leaf.id,false);host.frame_scene(true);host.set_editor_tool("scale")
	var before_local=leaf_node.transform
	var actual_axis=leaf_node.global_basis.x.normalized()
	var gx=point("x");mouse(gx,true)
	check(host.drag_handle=="x" and host.drag_world_axis.is_equal_approx(actual_axis),"scale handle uses actual transformed local X direction in a sheared parent chain")
	move_mouse(gx+host.drag_screen_axis*25);mouse(gx+host.drag_screen_axis*25,false)
	check(leaf_node.scale.x>before_local.basis.get_scale().x and is_equal_approx(leaf_node.scale.y,1.0) and is_equal_approx(leaf_node.scale.z,1.0),"local-axis scaling under inherited shear preserves untouched local scale components")
	check(leaf_node.position.is_equal_approx(before_local.origin),"local scale under inherited shear preserves local translation")
	send("editor_preview",{"source_revision":fixtures.shear.scene_revision,"previews":[],"reset_local":true})
	check(leaf_node.transform.is_equal_approx(before_local),"whole local quaternion/TRS restored after sheared-world scale cancel")
	host.set_editor_tool("rotate");var ry=point("y");mouse(ry,true)
	# A world-axis rotation that cannot be represented as local TRS is refused,
	# preserving the source, instead of silently orthogonalizing the parent.
	move_mouse(ry+Vector2(40,-25));mouse(ry+Vector2(40,-25),false)
	var rotation_result=host.outbound_log.filter(func(v):return v.type=="transform").back()
	check(rotation_result.phase=="cancel" and leaf_node.transform.is_equal_approx(before_local),"unrepresentable world rotation rejects local shear and restores original source")
	await scene(fixtures.playable)
	left_node=host.objects[left.id];right_node=host.objects[right.id]
	# The second iframe receives the intact pack and only changes its view filter.
	var object_host=load("res://main.gd").new();view().add_child(object_host);object_host.mode="object";object_host.origin=options.origin
	var observation=Graph.observation(left.id,left_node,host.definitions[left.id]);observation.world_matrix[13]+=4
	var preview_scene=merge(fixtures.playable,{"source":"world-atelier-workspace","nonce":object_host.nonce,"type":"scene","seq":1,"document_id":"main/scene/preview/"+left.id,"preview_object_id":left.id,"preview_observation":observation,"frame":true})
	object_host.receive(preview_scene)
	for i in range(500):
		if object_host.applied_seq==1:break
		await create_timer(.005).timeout
	check(object_host.applied_seq==1 and object_host.objects.size()==6 and object_host.telemetry().mesh_count==25,"independent object viewport retains complete canonical graph while displaying only selected actual model")
	check(absf(object_host.objects[left.id].global_position.y-4)<.001 and not object_host.editable,"object preview applies fixed observation matrix only to readonly presentation")
	check(object_host.hierarchy_editor.source_scene.hierarchy_pack==fixtures.playable.hierarchy_pack,"object preview does not rewrite pack topology or source transform")
	object_host.queue_free()
	var prepared=await loader.prepare(root,fixtures.playable,options.origin)
	simulation=Simulation.new();view().add_child(simulation);simulation.world_id="hierarchy-world";simulation.epoch=1;simulation.scene_revision=fixtures.playable.scene_revision
	var problem=simulation.initialize(prepared)
	check(problem.is_empty(),"real authority initializes nested collision and behavior graph: "+problem)
	if not problem.is_empty():quit(2);return
	simulation.active=true;simulation.join("a","A","#8acfff");await relay(15)
	check(simulation.behaviors.snapshot()[left.id].logic.address==left.address and simulation.behaviors.snapshot()[right.id].logic.address==right.address,"same script receives separate per-instance contexts and state")
	check(simulation.interaction_areas[left.id].position.is_equal_approx(left_node.global_position+Vector3.UP),"nested interaction sphere center uses complete world transform and local offset")
	await relay(1,Vector2.ZERO,true)
	check(simulation.behaviors.snapshot()[left.id].logic.interactions==1 and simulation.behaviors.snapshot()[right.id].logic.interactions==0,"real E input invokes only nearby nested instance authority behavior")
	var events=simulation.take_events();var matching=events.filter(func(e):return e.kind=="probe_interacted")
	check(matching.size()==1 and matching[0].address==left.address,"actual authority event carries full address and source identity")
	send("world",{"action":"join","world_id":simulation.world_id,"epoch":1,"player_id":"a","snapshot":simulation.snapshot(true)})
	await relay(25)
	check(host.world_client.mode=="playing" and host.world_client.projection.graph.mounts.size()==2,"real client projection enters same authority nested scene")
	check(host.world_client.projection.objects[left.id].get_meta("presented_address")==left.address,"actual dynamic presentation script receives owning nested Node3D")
	# Feed the actual client zero request to authority, preserving its sequence.
	send("world",{"action":"mode","mode":"inspecting","request_id":"inspect-hierarchy"})
	for msg in host.outbound_log:
		if msg.type=="player_input":simulation.accept_input(msg)
	await relay(5)
	check(host.world_client.projection.frozen,"personal projection freezes after actual zero-input acknowledgement")
	host.world_client.emit_state()
	var observed=host.outbound_log.filter(func(v):return v.type=="world_state").back()
	var records=observed.get("inspection_objects",[]).filter(func(v):return v.id==left.id)
	check(records.size()==1 and records[0].address==left.address and records[0].world_matrix.size()==16 and records[0].object_version==left.object_version,"frozen observation is full-address actual matrix with fixed version")
	var all_ok=true
	for row in checks:all_ok=all_ok and row.ok
	var file=FileAccess.open(options.report,FileAccess.WRITE);file.store_string(JSON.stringify({"completed":true,"ok":all_ok,"checks":checks,"scope":"real Godot headless nodes/HTTP parser/physics/input/projection; no browser or GPU claim"},"\t"))
	print("HIERARCHY_DONE "+str(checks.size())+" "+str(all_ok));quit(0 if all_ok else 1)
