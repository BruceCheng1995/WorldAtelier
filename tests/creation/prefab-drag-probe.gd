extends SceneTree
var host: Node
var checks: Array = []
var out = ""
var control_placement: Dictionary = {}
var model_placement: Dictionary = {}
var top_placement: Dictionary = {}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--out="): out = arg.substr(6)
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok: print("PREFAB_DRAG_FAILED "+detail)

func capture(title: String) -> Image:
	for i in 3:
		await process_frame
		await RenderingServer.frame_post_draw
	var image = root.get_texture().get_image()
	image.save_png(out+"/"+title+".png")
	return image

func changed(a: Image, b: Image) -> int:
	var count = 0
	for y in a.get_height():
		for x in a.get_width():
			var p = a.get_pixel(x,y)
			var q = b.get_pixel(x,y)
			if absf(p.r-q.r)+absf(p.g-q.g)+absf(p.b-q.b) > .08: count += 1
	return count

func state() -> Array:
	return [host.objects.duplicate(),host.definitions.duplicate(true),host.native_document.duplicate(true),host.selected_ids.duplicate(),host.selected_id,host.scene_bounds,host.camera.transform,host.drag_handle,host.gizmo.transform,root.canvas_transform]

func send(id: String, phase: String = "move", extra: Dictionary = {}) -> Dictionary:
	var packet = {"source":"world-atelier-workspace","nonce":host.nonce,"type":"prefab_drag","phase":phase,"drag_id":id,"seq":7,"document_id":"ghost/scene","source_revision":"ghost-revision","source_identity":"ghost-identity","prefab_path":"res://cube.tscn","screen":[.5,.5]}
	packet.merge(extra,true)
	var before = state()
	host.outbound_log.clear()
	host.receive(packet)
	check(before==state(),"protocol preserves content, selection, bounds, camera and handles: "+phase)
	if host.outbound_log.is_empty(): return {}
	var result: Dictionary = host.outbound_log.back()
	check(result.type=="prefab_drag" and result.drag_id==id,"correlated response "+phase)
	return result

func save_scene(node: Node, path: String) -> void:
	node.name = node.get_class()
	for child in node.get_children(): child.owner = node
	var packed = PackedScene.new()
	check(packed.pack(node)==OK and ResourceSaver.save(packed,path)==OK,"save fixture "+path)
	node.free()

func run() -> void:
	root.size = Vector2i(900,600)
	host = load("res://native_main.gd").new()
	root.add_child(host)
	host.set_process(false)
	host.requested_seq = 7
	host.finish_scene({"document_id":"ghost/scene","seq":7,"source_revision":"ghost-revision","editable":true,"frame":false},false)
	host.native_active = true
	host.native_document = {"source_revision":"ghost-revision","source_identity":"ghost-identity"}
	host.authored_root = host.scene_root
	host.authored_root.transform = Transform3D(Basis(Vector3(1.5,.2,0),Vector3(0,.8,.1),Vector3(.1,0,1.2)),Vector3(2,1,-3))
	host.editor_floor.visible = false
	host.camera.position = Vector3(6,6,8)
	host.camera.look_at(Vector3.ZERO)
	var model = Node3D.new()
	model.rotation = Vector3(.1,.3,0)
	model.scale = Vector3(1.4,.8,1.1)
	var basis = model.basis
	var mesh = MeshInstance3D.new()
	mesh.mesh = BoxMesh.new()
	model.add_child(mesh)
	model.add_child(Camera3D.new())
	var audio = AudioStreamPlayer3D.new()
	audio.autoplay = true
	model.add_child(audio)
	var body = RigidBody3D.new()
	body.name = "Physics"
	model.add_child(body)
	save_scene(model,"res://ghost-cube.tscn")
	var polygon = Polygon2D.new()
	polygon.polygon = PackedVector2Array([Vector2(-35,-30),Vector2(35,-30),Vector2(35,30),Vector2(-35,30)])
	polygon.rotation = .2
	polygon.scale = Vector2(1.3,.8)
	var transform2 = polygon.transform
	save_scene(polygon,"res://ghost-polygon.tscn")
	var control = ColorRect.new()
	control.size = Vector2(100,60)
	control.rotation = .12
	control.scale = Vector2(1.1,.9)
	control.pivot_offset = Vector2(17,11)
	save_scene(control,"res://ghost-control.tscn")
	save_scene(Node.new(),"res://ghost-node.tscn")
	host.native_config = {"preview_scenes":{"res://cube.tscn":{"path":"res://ghost-cube.tscn"},"res://polygon.tscn":"res://ghost-polygon.tscn","res://control.tscn":"res://ghost-control.tscn","res://node.tscn":"res://ghost-node.tscn"}}
	var helper = host.prefab_preview
	var cached: PackedScene = load("res://ghost-cube.tscn")
	var bytes = FileAccess.get_file_as_bytes("res://ghost-cube.tscn")
	var empty = await capture("3d-empty")
	check(send("a").get("status")=="ready","3D ready")
	var ghost_id = helper.ghost.get_instance_id()
	check(helper.ghost.basis.is_equal_approx(basis),"root rotation and scale preserved")
	check(helper.mount.get_parent()==host and not host.authored_root.is_ancestor_of(helper.ghost),"ghost is outside authored scene")
	check(helper.ghost.global_basis.is_equal_approx(host.authored_root.global_basis*basis),"3D world basis inherits nonidentity destination root including shear")
	var world3 = helper.ghost.global_transform
	model_placement = {"position":[world3.origin.x,world3.origin.y,world3.origin.z],"world_matrix":host.Hierarchy.matrix(world3)}
	check(helper.ghost.get_child_count()==2 and helper.ghost.get_node("Physics").freeze and helper.ghost.get_node("Physics").collision_layer==0 and helper.ghost.process_mode==Node.PROCESS_MODE_DISABLED,"no camera, audio or physics in ghost")
	check(host.placement_meshes().is_empty() and host.pick_object(Vector2(450,300))=="","ghost cannot occlude placement or be selected")
	var displayed = await capture("3d-ghost")
	check(changed(empty,displayed)>500,"GPU shows actual translucent 3D shape")
	check(send("a","move",{"screen":[.62,.5]}).get("status")=="ready" and helper.ghost.get_instance_id()==ghost_id,"move reuses one instance")
	check(changed(displayed,await capture("3d-moved"))>500,"GPU follows pointer movement")
	send("a","hide")
	check(not helper.ghost.visible and not helper.retired.has("a"),"hide is nonterminal")
	check(changed(empty,await capture("3d-hidden"))==0,"hide removes ghost pixels")
	check(send("a").get("status")=="ready" and helper.ghost.visible and helper.ghost.get_instance_id()==ghost_id,"same drag resumes same ghost")
	check(send("a","move",{"screen":[-1,.5]}).get("status")=="invalid" and not helper.ghost.visible,"invalid location hides shape")
	check(send("a").get("status")=="ready","valid location recovers same drag")
	send("other","clear")
	check(is_instance_valid(helper.ghost),"unrelated clear preserves active ghost")
	check(send("other").get("status")=="invalid","clear before move prevents resurrection")
	send("a","clear")
	check(not is_instance_valid(helper.ghost) and send("a").get("status")=="invalid","clear frees and retires")
	check(changed(empty,await capture("3d-cleared"))==0,"clear restores exact pixels")
	check(FileAccess.get_file_as_bytes("res://ghost-cube.tscn")==bytes and cached==load("res://ghost-cube.tscn"),"packed file and existing resource cache unchanged")
	var original: Node = cached.instantiate()
	check(original.get_child_count()==4 and original.get_child(0).material_override==null,"preview mutations never leak to cached source")
	original.free()
	var top = cached.instantiate()
	top.top_level = true
	save_scene(top,"res://ghost-top.tscn")
	host.native_config.preview_scenes["res://top.tscn"] = "res://ghost-top.tscn"
	check(send("top","move",{"prefab_path":"res://top.tscn"}).get("status")=="ready" and helper.ghost.global_basis.is_equal_approx(basis),"3D top_level ignores destination parent basis")
	var top_world = helper.ghost.global_transform
	top_placement = {"position":[top_world.origin.x,top_world.origin.y,top_world.origin.z],"world_matrix":host.Hierarchy.matrix(top_world)}
	send("top","clear")
	for invalid in [{"seq":6},{"document_id":"other"},{"source_revision":"stale"},{"source_identity":"stale"},{"prefab_path":"res://not-mapped.tscn"},{"screen":[NAN,.5]}]:
		check(send("bad","move",invalid).get("status")=="invalid" and not is_instance_valid(helper.ghost),"reject malformed/stale move "+str(invalid))
	FileAccess.open("res://author-fixture.gd",FileAccess.WRITE).store_string("extends Node3D\nfunc _init():\n\tFileAccess.open(\"user://author-executed\",FileAccess.WRITE).store_string(\"ran\")\n")
	FileAccess.open("res://unsafe-fixture.tscn",FileAccess.WRITE).store_string("[gd_scene load_steps=2 format=3]\n[ext_resource type=\"Script\" path=\"res://author-fixture.gd\" id=\"script\"]\n[node name=\"Unsafe\" type=\"Node3D\"]\nscript = ExtResource(\"script\")\n")
	host.native_config.preview_scenes["res://unsafe.tscn"] = "res://unsafe-fixture.tscn"
	check(send("unsafe","move",{"prefab_path":"res://unsafe.tscn"}).get("error")=="unsafe_prefab_preview" and not FileAccess.file_exists("user://author-executed"),"reject Node script before constructor executes")
	check(send("replaced").get("status")=="ready" and send("replacement").get("status")=="ready","new drag replaces existing ghost")
	check(send("replaced").get("status")=="invalid" and helper.drag_id=="replacement","late superseded move cannot replace current drag")
	send("replacement","clear")
	send("timeout")
	helper.last_move_ms -= helper.TIMEOUT_MS+1
	helper.advance(host)
	check(not is_instance_valid(helper.ghost) and send("timeout").get("status")=="invalid","timeout clears and retires")
	send("mode")
	host.mode = "object"
	helper.advance(host)
	check(not is_instance_valid(helper.ghost),"mode exit clears")
	host.mode = "main"
	send("source")
	host.native_document.source_revision = "new"
	helper.advance(host)
	check(not is_instance_valid(helper.ghost),"source transition clears")
	host.native_document.source_revision = "ghost-revision"
	send("pending-scene")
	host.requested_seq = 8
	helper.advance(host)
	check(not is_instance_valid(helper.ghost),"pending scene clears before asynchronous load finishes")
	host.requested_seq = 7
	host.canvas_mode = true
	var destination = Node2D.new()
	destination.position = Vector2(30,-40)
	destination.rotation = .35
	destination.scale = Vector2(2,3)
	host.scene_root.add_child(destination)
	host.authored_root = destination
	root.canvas_transform = Transform2D(Vector2(1.7,0),Vector2(0,1.7),Vector2(120,65))
	var canvas_empty = await capture("2d-empty")
	for kind in ["polygon","control"]:
		var response = send(kind,"move",{"prefab_path":"res://"+kind+".tscn"})
		check(response.get("shape")=="2d" and response.get("status")=="ready","2D ready "+kind)
		var expected = root.canvas_transform.affine_inverse()*(root.get_visible_rect().size*.5)
		check(helper.ghost.get_global_transform().origin.is_equal_approx(expected),"actual canvas transform origin maps pointer "+kind)
		if kind=="polygon": check(helper.ghost.transform.x.is_equal_approx(transform2.x) and helper.ghost.transform.y.is_equal_approx(transform2.y),"2D basis preserved")
		else: check(helper.ghost.size.is_equal_approx(Vector2(100,60)) and helper.ghost.scale.is_equal_approx(Vector2(1.1,.9)),"Control size and scale preserved")
		if kind=="control":
			var origin = helper.ghost.get_global_transform().origin
			control_placement = {"position":response.position,"world_origin":[origin.x,origin.y],"pivot":[helper.ghost.pivot_offset.x,helper.ghost.pivot_offset.y],"world_transform":host.matrix2(helper.ghost.get_global_transform())}
		check(changed(canvas_empty,await capture("2d-"+kind))>1000,"GPU real canvas shape "+kind)
		var identity = helper.ghost.get_instance_id()
		send(kind,"hide")
		send(kind,"move",{"prefab_path":"res://"+kind+".tscn","screen":[.6,.5]})
		check(helper.ghost.get_instance_id()==identity and helper.ghost.visible,"2D hide resumes same instance "+kind)
		send(kind,"clear")
		check(changed(canvas_empty,await capture("2d-"+kind+"-cleared"))==0,"2D clear removes every pixel "+kind)
	check(send("node","move",{"prefab_path":"res://node.tscn"}).get("shape")=="none" and not is_instance_valid(helper.ghost),"nonspatial root returns icon-only response")
	send("node","clear")
	send("scope","move",{"prefab_path":"res://control.tscn"})
	host.receive({"source":"world-atelier-workspace","nonce":host.nonce,"type":"scene","seq":8,"document_schema":"creation-native-1","document_id":"ghost/other-scene","source_revision":"next-revision","source_identity":"next-identity","native_scene_path":"res://polygon.tscn","objects":[{"id":"polygon","native_path":"."}],"frame":false})
	check(not is_instance_valid(helper.ghost),"actual scene receive clears ghost synchronously")
	for i in 3: await process_frame
	check(host.document_id=="ghost/other-scene" and host.applied_seq==8,"new scope finishes loading")
	check(send("scope","move",{"prefab_path":"res://control.tscn"}).get("status")=="invalid" and not is_instance_valid(helper.ghost),"late move from old scope stays cleared")
	var ok = checks.all(func(row): return row.ok)
	FileAccess.open(out+"/result.json",FileAccess.WRITE).store_string(JSON.stringify({"ok":ok,"checks":checks,"control_placement":control_placement,"model_placement":model_placement,"top_placement":top_placement},"\t"))
	print("PREFAB_DRAG_COMPLETE "+str(checks.size()))
	host.free()
	quit(0 if ok else 1)
