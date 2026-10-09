extends SceneTree
## Real HTTP models and the runtime's real input handler. This is not a browser
## or GPU probe. Watchdog and caller log scan must both pass.
var host: Node3D
var checks = []
var options = {}
var fixture: Dictionary
var next_seq = 0
var failures = 0

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var parts = arg.substr(2).split("=", true, 1)
			options[parts[0]] = parts[1] if parts.size() > 1 else "true"
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok": ok, "detail": detail})
	if not ok: failures += 1; print("INTERACTION_CHECK_FAILED " + detail)

func send(type: String, extra: Dictionary = {}) -> void:
	var p = {"source": "world-atelier-workspace", "nonce": host.nonce, "seq": host.applied_seq, "type": type, "document_id": host.document_id}
	p.merge(extra, true)
	host.receive(p)

func reset_scene() -> void:
	next_seq += 1
	var p = fixture.duplicate(true)
	p.merge({"source":"world-atelier-workspace", "nonce":host.nonce,"seq":next_seq,"type":"scene","frame":true}, true)
	host.receive(p)
	for i in range(500):
		if host.applied_seq == next_seq: return
		await create_timer(.01).timeout
	check(false, "scene apply timeout")

func point(id: String, fraction: float = .7) -> Vector2:
	var points = host.gizmo.screen_handles()[id].points
	if points.size() == 1: return points[0]
	if points.size() == 2: return points[0].lerp(points[1], fraction)
	if points.size() == 4: return (points[0]+points[1]+points[2]+points[3])/4
	for p in points:
		if host.gizmo.hit_test(p) == id: return p
	return points[0]

func button(at: Vector2, down: bool, index: int = MOUSE_BUTTON_LEFT, shift: bool = false, alt: bool = false) -> void:
	var e = InputEventMouseButton.new()
	e.button_index = index
	e.pressed = down
	e.position = at
	e.shift_pressed = shift
	e.alt_pressed = alt
	host._input(e)

func motion(at: Vector2, relative: Vector2, ctrl: bool = false, shift: bool = false) -> void:
	var e = InputEventMouseMotion.new()
	e.position = at
	e.relative = relative
	e.ctrl_pressed = ctrl
	e.shift_pressed = shift
	e.button_mask = (1 << (host.button_down - 1)) if host.button_down else 0
	host._input(e)

func key(code: int, ctrl: bool = false, shift: bool = false, meta: bool = false) -> void:
	var e = InputEventKey.new()
	e.keycode = code
	e.pressed = true
	e.ctrl_pressed = ctrl
	e.shift_pressed = shift
	e.meta_pressed = meta
	host._input(e)

func run() -> void:
	create_timer(35).timeout.connect(func(): print("INTERACTION_PROBE_TIMEOUT"); quit(2))
	host = load("res://main.gd").new()
	root.add_child(host)
	fixture = JSON.parse_string(FileAccess.get_file_as_string(options.fixture))
	fixture.selected_id = "pf-beacon"
	fixture.objects[0].rotation = [12, 25, 7]
	fixture.objects[0].scale = [1, 1.5, .8]
	await reset_scene()
	check(host.active_assets.size() == 6 and host.telemetry().mesh_count == 198, "real HTTP GLBs parsed with 198 meshes")
	var selected = host.objects["pf-beacon"]
	var initial: Transform3D = selected.transform
	key(KEY_Q)
	check(host.editor_tool == "select" and not host.gizmo.visible, "Q selection tool hides handles")
	key(KEY_W)
	check(host.editor_tool == "move" and host.gizmo.handles.size() == 6, "W move exposes three axes and three planes")
	var before_nodes = host.gizmo.get_child_count()
	var y = point("y")
	motion(y, Vector2.ZERO)
	check(host.gizmo.hover == "y" and host.gizmo.handles.y.material.albedo_color.is_equal_approx(Color("ffe36c")), "actual hover hit changes handle to yellow")
	for i in range(20): motion(y + Vector2(i*.1,0),Vector2(.1,0))
	check(host.gizmo.get_child_count() == before_nodes, "hover does not recreate handle geometry")
	var old_world_size = host.gizmo.world_size
	host.distance *= 2
	host.update_camera()
	check(host.gizmo.world_size > old_world_size * 1.5, "gizmo world size tracks camera depth for stable pixels")
	host.frame_scene(true)
	y = point("y")
	button(y, true)
	check(host.drag_handle == "y" and host.outbound_log.back().phase == "start" and host.outbound_log.back().before.scale.size() == 3, "drag start carries complete before TRS")
	var axis: Vector2 = host.drag_screen_axis
	motion(y + axis * 31, axis*31, true)
	var delta: Vector3 = selected.position - initial.origin
	check(is_equal_approx(delta.y / .25, roundf(delta.y / .25)) and delta.y > 0 and absf(delta.x) < .0001, "Ctrl move snaps Y delta to .25m")
	key(KEY_ESCAPE)
	check(selected.transform.is_equal_approx(initial) and host.outbound_log.back().phase == "cancel", "Escape restores full original TRS")
	button(y, true)
	motion(y + axis * 30, axis*30)
	var full_delta: Vector3 = selected.position-initial.origin
	key(KEY_ESCAPE)
	button(y, true)
	motion(y + axis * 30, axis*30, false, true)
	check((selected.position-initial.origin).is_equal_approx(full_delta*.1), "Shift move uses one tenth precision")
	key(KEY_ESCAPE)
	var plane = point("xz")
	button(plane, true)
	check(host.drag_handle == "xz", "XZ plane handles acquire actual mouse drag")
	motion(plane+Vector2(25,15),Vector2(25,15))
	delta = selected.position - initial.origin
	check(absf(delta.y) < .0001 and absf(delta.x) + absf(delta.z) > .01, "plane movement preserves normal coordinate")
	host._notification(Node.NOTIFICATION_APPLICATION_FOCUS_OUT)
	check(selected.transform.is_equal_approx(initial) and host.drag_handle.is_empty(), "focus loss restores whole TRS")
	key(KEY_E)
	check(host.editor_tool == "rotate" and host.gizmo.handles.size() == 3, "E rotate creates three ring handles")
	var ring = point("y")
	button(ring, true)
	check(host.drag_handle == "y", "Y rotation ring acquired via real hit test")
	var origin: Vector3 = host.drag_origin
	var a: Vector3 = (host.drag_plane_start-origin).normalized()
	var rotation_world_size: float = host.drag_world_length
	var previous_basis: Basis = selected.basis.orthonormalized()
	var smooth = true
	for i in range(1, 81):
		var angle = TAU * i / 72.0
		var world_point = origin + Basis(Vector3.UP, angle) * a * rotation_world_size
		var screen: Vector2 = host.camera.unproject_position(world_point)
		motion(screen, Vector2.ZERO)
		var current_basis: Basis = selected.basis.orthonormalized()
		if previous_basis.get_rotation_quaternion().angle_to(current_basis.get_rotation_quaternion()) > .2: smooth = false
		previous_basis = current_basis
	check(smooth and host.drag_angle_accumulated > TAU, "rotation crosses complete circle continuously without angle wrap jump")
	key(KEY_ESCAPE)
	check(selected.transform.is_equal_approx(initial), "rotation cancel restores original basis and nonuniform scale")
	button(point("z"), true)
	var rotate_from = host.drag_plane_start - host.drag_origin
	var rotate_screen = host.camera.unproject_position(host.drag_origin + Basis(Vector3.BACK, deg_to_rad(22)) * rotate_from)
	motion(rotate_screen,Vector2.ZERO,true)
	var actual_angle = initial.basis.orthonormalized().get_rotation_quaternion().angle_to(selected.basis.orthonormalized().get_rotation_quaternion())
	check(absf(actual_angle-deg_to_rad(15)) < .001, "Ctrl rotation snaps angle to 15 degrees")
	key(KEY_ESCAPE)
	key(KEY_R)
	check(host.editor_tool == "scale" and host.gizmo.handles.size() == 4, "R scale creates local axes and uniform center")
	var x = point("x")
	button(x,true)
	axis = host.drag_screen_axis
	motion(x+axis*25,axis*25,true)
	check(selected.scale.x > 1 and is_equal_approx(selected.scale.y,1.5) and is_equal_approx(selected.scale.z,.8), "local axis scaling preserves other vector components")
	key(KEY_ESCAPE)
	var center = point("uniform")
	button(center,true)
	motion(center+Vector2(1000,-1000),Vector2(1000,-1000))
	check(is_equal_approx(selected.scale.y,5) and is_equal_approx(selected.scale.x/selected.scale.z,1/.8), "uniform scale clamps shared factor preserving nonuniform ratios")
	key(KEY_ESCAPE)
	button(center,true)
	motion(center+Vector2(30,-10),Vector2(30,-10))
	key(KEY_Z,true)
	check(selected.transform.is_equal_approx(initial) and host.outbound_log.back().type == "history" and host.outbound_log.back().action == "undo", "undo cancels pending full TRS then asks parent history")
	key(KEY_Z,false,true,true)
	check(host.outbound_log.back().type == "history" and host.outbound_log.back().action == "redo", "Cmd Shift Z sends redo")
	var camera_before: Transform3D = host.camera.transform
	send("editor",{"seq":host.applied_seq-1,"tool":"select","snap":true})
	send("camera",{"seq":host.applied_seq-1,"action":"front"})
	check(host.editor_tool == "scale" and not host.snap_enabled and host.camera.transform.is_equal_approx(camera_before), "stale editor/camera packets cannot affect current scene")
	button(center,true)
	motion(center+Vector2(30,-10),Vector2(30,-10))
	send("editor",{"tool":"move","snap":true})
	check(selected.transform.is_equal_approx(initial) and host.snap_enabled and host.drag_handle.is_empty(), "current editor command cancels drag and changes persistent snap")
	key(KEY_F)
	check(host.target.is_equal_approx(host.object_bounds("pf-beacon").get_center()), "F focuses actual selected transformed AABB")
	key(KEY_F,false,true)
	check(host.target.is_equal_approx(host.scene_bounds.get_center()), "Shift F frames whole scene")
	for view in ["front","top","right","perspective"]:
		send("camera",{"action":view})
		check(host.camera_view == view and selected.transform.is_equal_approx(initial), "camera " + view + " changes only camera")
	var camera_original: Transform3D = host.camera.transform
	button(Vector2(3,3),true)
	motion(Vector2(30,30),Vector2(27,27))
	button(Vector2(30,30),false)
	check(host.camera.transform.is_equal_approx(camera_original), "main left drag on empty canvas never orbits")
	button(Vector2(30,30),true,MOUSE_BUTTON_RIGHT)
	key(KEY_R)
	check(host.editor_tool == "move", "RMB navigation suppresses editor hotkeys")
	motion(Vector2(50,30),Vector2(20,0))
	button(Vector2(50,30),false,MOUSE_BUTTON_RIGHT)
	check(not host.camera.transform.is_equal_approx(camera_original), "RMB drag orbits")
	# A lost release is a cancel, not a delayed commit when the pointer returns.
	key(KEY_R)
	center = point("uniform")
	button(center,true)
	motion(center+Vector2(20,-10),Vector2(20,-10))
	var lost = InputEventMouseMotion.new()
	lost.position = center+Vector2(30,-10)
	lost.button_mask = 0
	host._input(lost)
	check(selected.transform.is_equal_approx(initial) and host.drag_handle.is_empty(), "missing physical mouse button mask cancels whole TRS")
	key(KEY_W)
	send("editor",{"snap":true})
	y = point("y")
	button(y,true)
	axis = host.drag_screen_axis
	motion(y+axis*17.3,axis*17.3,true)
	delta = selected.position-initial.origin
	check(absf(delta.y/.25-roundf(delta.y/.25)) > .01, "Ctrl temporarily disables persistent snap")
	key(KEY_ESCAPE)
	# An edge-on XY plane cannot launch an unbounded ray intersection.
	send("camera",{"action":"right"})
	var edge = point("xy")
	button(edge,true)
	check(host.drag_handle != "xy", "edge-on plane cannot acquire unstable plane drag")
	key(KEY_ESCAPE)
	fixture.editable = false
	await reset_scene()
	send("editor",{"tool":"scale"})
	check(not host.gizmo.visible and host.gizmo.screen_handles().is_empty(), "readonly scene never exposes transform handles")
	host.begin_drag(Vector2(100,100))
	check(host.drag_handle.is_empty(), "readonly rejects direct begin drag")
	var history_count = host.outbound_log.filter(func(p):return p.type=="history").size()
	key(KEY_Z,true)
	key(KEY_Y,true)
	check(host.outbound_log.filter(func(p):return p.type=="history").size()==history_count, "readonly undo and redo do not emit writes")
	var result = {"ok":failures==0,"checks":checks,"scope":"real HTTP + GLTF parse + actual native InputEvent handlers; no browser/GPU claim"}
	if options.has("probe-report"):
		var output = FileAccess.open(options["probe-report"],FileAccess.WRITE)
		output.store_string(JSON.stringify(result,"\t"))
	print("INTERACTION_PROBE_COMPLETE " + JSON.stringify(result))
	quit(1 if failures else 0)
