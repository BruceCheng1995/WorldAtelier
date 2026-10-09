extends SceneTree
var checks: Array = []
var host: Node

func _initialize() -> void:
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok: print("MOUNT_SELECTION_FAILED " + detail)

func branch(parent: Node, title: String, at: Vector3 = Vector3.ZERO, mount_id: String = "") -> Node3D:
	var node = Node3D.new()
	node.name = title
	parent.add_child(node)
	node.position = at
	if mount_id != "":
		node.set_meta("wa_instance_mount",true)
		node.set_meta("wa_instance_id",mount_id)
	return node

func register(id: String, node: Node3D, path: Array, edit: Node3D) -> void:
	var target={"node_id":id,"instance_ids":path}
	var row={"id":id,"name":id,"native_target":target,"version":"v1","dimension":"3d"}
	if edit != node: row["native_mount_target"]={"mount":true,"instance_ids":path}
	host.objects[id]=node
	host.definitions[id]=row
	var visual=MeshInstance3D.new()
	visual.mesh=BoxMesh.new()
	node.add_child(visual)

func probe(id: String, node: Node3D, edit: Node3D) -> void:
	var original_node=node.transform
	var original_world=node.global_transform
	var original_edit=edit.transform
	check(host.manipulated_object(id)==edit,id+": resolves exact native edit target")
	host.select_object(id,true)
	check(node.global_transform.is_equal_approx(original_world),id+": clicking preserves authored world pose")
	var observation=host.scene_observation(id)
	check(observation.world_matrix==host.Hierarchy.matrix(edit.global_transform),id+": observation belongs to the selected edit target")
	var row={"id":id,"native_target":host.definitions[id].get("native_mount_target",host.definitions[id].native_target),"world_matrix":host.Hierarchy.matrix(edit.global_transform)}
	host.apply_native_preview({"document_id":host.document_id,"seq":host.applied_seq,"source_identity":"source-v1","canonical_objects":[row],"objects":[]})
	check(node.global_transform.is_equal_approx(original_world),id+": canonical preview reset preserves instance location")
	# Restore this independent fixture so a failing reset cannot obscure drag checks.
	node.transform=original_node
	edit.transform=original_edit
	host.select_object(id,false)
	host.update_helpers()
	var screen=host.camera.unproject_position(host.gizmo.global_transform * Vector3(.7,0,0))
	host.begin_drag(screen)
	check(host.drag_id==id and not host.drag_handle.is_empty(),id+": real gizmo input starts drag")
	var motion=InputEventMouseMotion.new()
	motion.position=screen+Vector2(40,-10)
	host.update_drag(motion)
	check(not edit.transform.is_equal_approx(original_edit),id+": drag changes native edit target")
	check(edit==node or node.transform.is_equal_approx(original_node),id+": drag preserves prefab content local transform")
	host.cancel_drag()
	check(edit.transform.is_equal_approx(original_edit) and node.global_transform.is_equal_approx(original_world),id+": cancel restores exact original instance pose")

func modifier_gizmo_probe(id: String, node: Node3D) -> void:
	# Route actual press/motion events through native_main -> main._input. Calling
	# begin_drag directly would miss a modifier guard that blocks gizmo picking.
	var original=node.transform
	for modifier in ["plain","ctrl","shift"]:
		host.select_objects(["pea",id],id,false)
		host.snap_enabled=false
		host.update_helpers()
		var screen=host.camera.unproject_position(host.gizmo.global_transform * Vector3(.7,0,0))
		var press=InputEventMouseButton.new()
		press.button_index=MOUSE_BUTTON_LEFT
		press.pressed=true
		press.position=screen
		press.ctrl_pressed=modifier=="ctrl"
		press.shift_pressed=modifier=="shift"
		host._input(press)
		var started=host.drag_id==id and not host.drag_handle.is_empty()
		check(started,modifier+": actual modified mouse press still hits the gizmo and starts drag")
		var origin=node.global_position
		var axis: Vector3=host.drag_world_axis
		var motion=InputEventMouseMotion.new()
		motion.button_mask=MOUSE_BUTTON_MASK_LEFT
		motion.ctrl_pressed=press.ctrl_pressed
		motion.shift_pressed=press.shift_pressed
		motion.position=screen+host.drag_screen_axis*(.63*host.drag_screen_length/maxf(.00001,host.drag_world_length))
		host._input(motion)
		var expected=.75 if modifier=="ctrl" else .063 if modifier=="shift" else .63
		check(started and node.global_position.is_equal_approx(origin+axis*expected),modifier+": input motion preserves Ctrl quarter-unit snap and Shift tenth-speed fine adjustment")
		check(host.selected_ids==["pea",id] and host.selected_id==id,modifier+": dragging a gizmo does not toggle the multi-selection")
		host.cancel_drag()
		check(node.transform.is_equal_approx(original),modifier+": cancel restores the exact authored transform")

func run() -> void:
	root.size=Vector2i(1200,800)
	host=load("res://native_main.gd").new()
	root.add_child(host)
	host.native_active=true
	host.document_id="test/main/scene"
	host.applied_seq=1
	host.native_document={"source_identity":"source-v1","source_revision":"revision-v1"}
	host.editable=true
	host.native_scene_generation=1
	host.authored_root=host.scene_root
	var mount=branch(host.scene_root,"I_template_pea",Vector3.ZERO,"template-pea")
	var wrapper=branch(mount,"__Definition")
	var pea=branch(wrapper,"N_template_pea",Vector3(-4.8,.33,5.65))
	register("pea",pea,["template-pea"],mount)
	var outer=branch(host.scene_root,"Outer",Vector3(3,0,0),"outer")
	var inner=branch(branch(outer,"__Definition"),"Inner",Vector3(1,0,0),"inner")
	var nested=branch(branch(inner,"__Definition"),"Nested",Vector3(0,1,0))
	register("nested",nested,["outer","inner"],inner)
	var direct=branch(host.scene_root,"Direct",Vector3(-2,1,-3))
	register("direct",direct,[],direct)
	host.refresh_bounds()
	host.frame_scene()
	for i in range(3): await process_frame
	probe("pea",pea,mount)
	probe("nested",nested,inner)
	probe("direct",direct,direct)
	modifier_gizmo_probe("direct",direct)
	host.definitions.nested.native_mount_target.instance_ids=["wrong-outer","inner"]
	check(host.manipulated_object("nested")==null,"nested: same leaf instance id with wrong ancestry cannot select a mount")
	host.definitions.nested.native_mount_target.instance_ids=["outer"]
	check(host.manipulated_object("nested")==outer,"nested: exact ancestor address wins over the nearest mount")
	host.definitions.nested.native_mount_target.instance_ids=["outer","inner"]
	var file=FileAccess.open("res://selection-mount-report.json",FileAccess.WRITE)
	file.store_string(JSON.stringify({"checks":checks}))
	file.close()
	quit(0 if checks.all(func(row):return row.ok) else 1)
