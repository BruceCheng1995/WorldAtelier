extends SceneTree

var host: Node3D
var checks: Array = []
var failed = false
var options: Dictionary = {}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var parts = arg.substr(2).split("=", true, 1)
			options[parts[0]] = parts[1] if parts.size() > 1 else "true"
	run.call_deferred()

func check(condition: bool, detail: String) -> void:
	checks.append({"ok": condition, "detail": detail})
	if not condition:
		failed = true
		print("PROBE_CHECK_FAILED " + detail)

func packet(scene: Dictionary, seq: int) -> Dictionary:
	var result = scene.duplicate(true)
	result.merge({"source": "world-atelier-workspace", "nonce": host.nonce, "type": "scene", "seq": seq}, true)
	return result

func wait_for_seq(seq: int) -> bool:
	for i in range(500):
		if host.applied_seq == seq: return true
		await create_timer(.01).timeout
	return false

func run() -> void:
	# Fail closed if a VM error aborts this coroutine before the completion marker.
	create_timer(25).timeout.connect(func(): print("PREVIEW_PROBE_TIMEOUT"); quit(2))
	host = load("res://main.gd").new()
	root.add_child(host)
	var scene = JSON.parse_string(FileAccess.get_file_as_string(str(options.get("fixture", ""))))
	if not scene is Dictionary:
		print("PREVIEW_PROBE_BAD_FIXTURE")
		quit(2)
		return
	host.receive(packet(scene, 1))
	check(await wait_for_seq(1), "six GLBs load through real HTTP + GLTF parser")
	check(host.telemetry().mesh_count == 198 and host.active_assets.size() == 6, "actual six-asset mesh inventory is 198")
	check(host.objects.size() == 7, "six model objects and one independent anchor")
	var first_instance = host.objects["pf-beacon"].get_instance_id()
	var update = scene.duplicate(true)
	update.objects[0].position = [3,2,1]
	update.objects[0].rotation = [20,35,10]
	update.objects[0].scale = [1,2,1.5]
	update.frame = false
	var old_camera = host.camera.transform
	host.receive(packet(update, 2))
	check(host.applied_seq == 2 and host.objects["pf-beacon"].get_instance_id() == first_instance, "TRS-only scene update keeps existing model instance")
	check(host.objects["pf-beacon"].position.is_equal_approx(Vector3(3,2,1)), "full XYZ including Y updates")
	check(host.objects["pf-beacon"].scale.is_equal_approx(Vector3(1,2,1.5)), "nonuniform scale updates")
	check(host.camera.transform.is_equal_approx(old_camera), "frame false preserves camera")
	host.receive(packet(scene, 1))
	check(host.applied_seq == 2, "old scene seq is ignored")
	var invalid = scene.duplicate(true)
	invalid.objects[0].model_url = "https://example.invalid/preview-assets/model.glb"
	host.receive(packet(invalid, 3))
	check(host.applied_seq == 2 and host.objects["pf-beacon"].get_instance_id() == first_instance, "invalid URL candidate preserves complete current scene")
	invalid.objects[0].model_url = "/preview-assets/bad.glb"
	invalid.objects[0].erase("model_hash")
	host.receive(packet(invalid, 4))
	await create_timer(.2).timeout
	check(host.applied_seq == 2 and host.outbound_log.back().type == "error", "corrupt HTTP GLB rejected without losing previous scene")
	var valid = packet(scene, 5)
	host.receive(valid)
	check(await wait_for_seq(5), "valid candidate recovers after rejection")
	var model_hit = false
	for mesh in host.objects["pf-beacon"].find_children("*", "MeshInstance3D", true, false):
		var faces = mesh.mesh.get_faces()
		if faces.size() < 3: continue
		var face_center = mesh.global_transform * ((faces[0] + faces[1] + faces[2]) / 3)
		if host.pick_object(host.camera.unproject_position(face_center)) == "pf-beacon":
			model_hit = true
			break
	check(model_hit, "real GLB triangle picking resolves visible beacon geometry")
	host.select_object("anchor-point", false)
	var old_anchor = host.objects["anchor-point"].position
	check(host.pick_object(host.camera.unproject_position(old_anchor)) == "anchor-point", "3D anchor picking resolves authored ID")
	var axis = host.gizmo.screen_handles().y.points
	var start = (axis[0] + axis[1]) / 2
	var press = InputEventMouseButton.new()
	press.button_index = MOUSE_BUTTON_LEFT
	press.pressed = true
	press.position = start
	host._input(press)
	check(host.drag_handle == "y", "Y translation handle acquires drag")
	var move = InputEventMouseMotion.new()
	move.position = start + (axis[1]-axis[0]).normalized() * 35
	move.relative = move.position-start
	move.button_mask = MOUSE_BUTTON_MASK_LEFT
	host._input(move)
	var release = InputEventMouseButton.new()
	release.button_index = MOUSE_BUTTON_LEFT
	release.position = move.position
	host._input(release)
	var commits = host.outbound_log.filter(func(item): return item.type == "transform" and item.phase == "commit")
	var new_anchor = host.objects["anchor-point"].position
	check(commits.size() == 1 and new_anchor.y > old_anchor.y and is_equal_approx(new_anchor.x,old_anchor.x) and is_equal_approx(new_anchor.z,old_anchor.z), "mouse handler drag emits one commit and moves only Y")
	var readonly = scene.duplicate(true)
	readonly.editable = false
	readonly.selected_id = "anchor-point"
	host.receive(packet(readonly, 6))
	check(host.gizmo.screen_handles().is_empty() and not host.editable, "editable false removes transform handles")
	host.begin_drag(start)
	check(host.drag_handle.is_empty(), "read-only mode cannot start a transform")
	var before_assets = host.asset_cache.size()
	var superseded = scene.duplicate(true)
	superseded.objects[0].model_url = "/preview-assets/beacon.glb?v=new"
	host.receive(packet(superseded, 7))
	host.receive(packet(readonly, 8))
	check(await wait_for_seq(8), "newest scene applies while older HTTP load is in flight")
	await create_timer(.2).timeout
	check(host.applied_seq == 8 and host.asset_cache.size() == before_assets, "superseded HTTP candidate cannot exchange or pollute cache")
	var result = {"ok": not failed, "checks": checks, "scope": "real HTTP/GLTF + direct native InputEvent handler; not browser input/GPU evidence"}
	if options.has("probe-report"):
		var file = FileAccess.open(options["probe-report"], FileAccess.WRITE)
		file.store_string(JSON.stringify(result,"\t"))
	print("PREVIEW_PROBE_COMPLETE " + JSON.stringify(result))
	quit(1 if failed else 0)
