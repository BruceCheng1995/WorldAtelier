extends "res://tests/interaction_probe.gd"
## Cross-tool regression. Read committed values, round-trip them through the
## parent scene envelope, then verify the runtime's actual installed scene.
## This does not substitute for waiting on an asynchronous browser loaded event.
var loaded_commits = 0

func last_commit() -> Dictionary:
	var packets = host.outbound_log.filter(func(p): return p.type == "transform" and p.phase == "commit")
	return packets.back() if not packets.is_empty() else {}

func confirm_commit() -> void:
	var commit = last_commit()
	check(not commit.is_empty(), "actual mouse release produced transform commit")
	if commit.is_empty(): return
	for field in ["position", "rotation", "scale"]:
		fixture.objects[0][field] = commit[field].duplicate()
	# JSON transport preserves the exact committed channel values.
	fixture = JSON.parse_string(JSON.stringify(fixture))
	await reset_scene()
	var loaded = host.outbound_log.filter(func(p): return p.type == "loaded" and p.seq == host.applied_seq)
	check(not loaded.is_empty(), "real runtime loaded current confirmation sequence")
	if loaded.is_empty(): return
	var row = loaded.back().objects.filter(func(o):return o.id=="pf-beacon")[0]
	for field in ["position","rotation","scale"]:
		check(host.Factory.vec(row[field]).is_equal_approx(host.Factory.vec(commit[field])), "installed loaded " + field + " matches committed value")
	loaded_commits += 1

func scale_axis(id: String, factor: float) -> void:
	send("editor", {"tool":"scale", "snap":false})
	host.frame_scene(true)
	var object = host.objects["pf-beacon"]
	var previous = host.trs(object)
	var initial_basis: Basis = object.basis.orthonormalized()
	var start = point(id)
	button(start,true)
	check(host.drag_handle == id, "actual local scale " + id + " handle acquired")
	var delta: Vector2 = host.drag_screen_axis * host.drag_screen_length * (factor-1)
	motion(start+delta,delta)
	button(start+delta,false)
	var commit = last_commit()
	var expected_scale = host.Factory.vec(previous.scale)
	expected_scale[["x","y","z"].find(id)] *= factor
	check(host.Factory.vec(commit.rotation).is_equal_approx(host.Factory.vec(previous.rotation)), "local scale " + id + " preserves committed Euler rotation")
	check(object.basis.orthonormalized().is_equal_approx(initial_basis), "local scale " + id + " preserves actual orientation")
	check(host.Factory.vec(commit.scale).is_equal_approx(expected_scale), "local scale " + id + " changes only its component")
	check(host.Factory.vec(commit.position).is_equal_approx(host.Factory.vec(previous.position)), "local scale " + id + " preserves position")
	await confirm_commit()

func rotate_axis(id: String, degrees: float) -> void:
	send("editor", {"tool":"rotate", "snap":false})
	host.frame_scene(true)
	var object = host.objects["pf-beacon"]
	var previous = host.trs(object)
	var initial_basis: Basis = object.basis.orthonormalized()
	var start = point(id)
	button(start,true)
	check(host.drag_handle == id and host.drag_plane_valid, "actual world rotate " + id + " ring acquired")
	var axis: Vector3 = host.AXES[["x","y","z"].find(id)]
	var endpoint = host.drag_origin + Basis(axis, deg_to_rad(degrees)) * (host.drag_plane_start-host.drag_origin)
	var screen: Vector2 = host.camera.unproject_position(endpoint)
	motion(screen,screen-start)
	button(screen,false)
	var commit = last_commit()
	check(host.Factory.vec(commit.scale).is_equal_approx(host.Factory.vec(previous.scale)), "world rotation " + id + " preserves nonuniform scale vector")
	check(object.basis.orthonormalized().is_equal_approx(Basis(axis,deg_to_rad(degrees))*initial_basis), "world rotation " + id + " matches intended orientation")
	check(host.Factory.vec(commit.position).is_equal_approx(host.Factory.vec(previous.position)), "world rotation " + id + " preserves position")
	await confirm_commit()

func run() -> void:
	create_timer(35).timeout.connect(func():print("TRS_PROBE_TIMEOUT");quit(2))
	host = load("res://main.gd").new()
	root.add_child(host)
	fixture = JSON.parse_string(FileAccess.get_file_as_string(options.fixture))
	fixture.selected_id = "pf-beacon"
	fixture.objects[0].rotation = [0,0,0]
	fixture.objects[0].scale = [1,1,1]
	await reset_scene()
	check(host.active_assets.size()==6 and host.telemetry().mesh_count==198, "cross-tool test uses six actual HTTP GLBs")
	await rotate_axis("y", -50.8305)
	await scale_axis("x", 1.58211)
	await rotate_axis("z", 33.5)
	await scale_axis("y", 1.27)
	await rotate_axis("x", -41.25)
	await scale_axis("z", .63)
	await rotate_axis("y", 21.75)
	await scale_axis("x", .82)
	check(loaded_commits==8, "all eight consecutive transforms are committed and installed before next tool")
	var result = {"ok":failures==0,"checks":checks,"loaded_commits":loaded_commits,"scope":"real HTTP/GLTF and actual input commit plus scene confirmation; not asynchronous browser input"}
	if options.has("probe-report"):
		var file=FileAccess.open(options["probe-report"],FileAccess.WRITE)
		file.store_string(JSON.stringify(result,"\t"))
	print("TRS_PROBE_COMPLETE " + JSON.stringify(result))
	quit(1 if failures else 0)
