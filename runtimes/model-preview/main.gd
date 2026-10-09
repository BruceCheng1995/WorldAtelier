extends Node3D

const Hierarchy = preload("res://hierarchy_scene.gd")
const HierarchyEditor = preload("res://hierarchy_editor.gd")
const Factory = preload("res://scene_factory.gd")
const Gizmo = preload("res://transform_gizmo.gd")
const Capabilities = preload("res://runtime_capabilities.gd")
const FONT = preload("res://fonts/CreatorUI.tres")
const VERSION = Capabilities.VERSION
const AXES = [Vector3.RIGHT, Vector3.UP, Vector3.BACK]
const AXIS_COLORS = [Color("#ff747c"), Color("#7cdda8"), Color("#6baaff")]

var hierarchy_editor = HierarchyEditor.new()
var camera: Camera3D
var editor_floor: MeshInstance3D
var scene_root: Node3D
var helpers: Node3D
var objects: Dictionary = {}
var definitions: Dictionary = {}
var asset_cache: Dictionary = {}
var active_assets: Array = []
var model_signature = ""
var nonce = ""
var mode = "main"
var editable = true
var origin = ""
var document_id = ""
var placement_revision = ""
var applied_seq = -1
var requested_seq = -1
var generation = 0
var selected_id = ""
var selected_ids: Array = []
var bridge: JavaScriptObject
var callback: JavaScriptObject
var target = Vector3(0, 1, 0)
var yaw = .65
var pitch = .48
var distance = 12.0
var camera_speed = 6.0
var editor_navigation = preload("res://editor_navigation.gd").new()
var performance_clock = 0.0
var performance_frames = 0
var performance_frame_times: Array[float] = []
var last_speed_multiplier = 1.0
var editor_annotations: Node
var scene_bounds = AABB(Vector3(-2, 0, -2), Vector3(4, 3, 4))
var button_down = 0
var pointer_start = Vector2.ZERO
var pointer_moved = false
var gizmo: Node3D
var selection_box: MeshInstance3D
var status_label: Label
var editor_tool = "move"
var snap_enabled = false
var navigation = ""
var orbit_pivot: Variant = null
var camera_view = "perspective"
var drag_handle = ""
var drag_tool = ""
var drag_id = ""
var drag_before: Dictionary = {}
var drag_original = Transform3D.IDENTITY
var drag_global_original = Transform3D.IDENTITY
var drag_start_pointer = Vector2.ZERO
var drag_origin = Vector3.ZERO
var drag_world_axis = Vector3.ZERO
var drag_plane_normal = Vector3.ZERO
var drag_plane_start = Vector3.ZERO
var drag_plane_valid = false
var drag_screen_axis = Vector2.ZERO
var drag_screen_length = 1.0
var drag_world_length = 1.0
var drag_angle_previous = 0.0
var drag_angle_accumulated = 0.0
var drag_rotation_tangent = Vector2.ZERO
var drag_hint = ""
var last_drag_emit = 0.0
var elapsed = 0.0
var ready_clock = 0.0
var last_camera_emit = 0.0
var cli_args: Dictionary = {}
var outbound_log: Array = []
var world_client: Node
var collaboration_overlay: Node3D
var latest_scene_editable = true
var branch_id = ""
var development_states: Array = []
var development_received = false
var development_clock = 0.0

func _enter_tree() -> void:
	# Creator UI may use default Label/Label3D fonts or draw with the fallback
	# directly. Install both before any scene or gameplay child enters the tree,
	# including CanvasLayers and controls with their own empty Theme.
	ThemeDB.fallback_font = FONT
	ThemeDB.get_default_theme().default_font = FONT

func _ready() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var parts = arg.substr(2).split("=", true, 1)
			cli_args[parts[0]] = parts[1] if parts.size() > 1 else "true"
	if cli_args.has("authority") or cli_args.has("validate-scene"):
		var worker = load("res://authority_worker.gd").new()
		add_child(worker)
		worker.start(cli_args)
		set_process(false)
		set_physics_process(false)
		set_process_input(false)
		return
	setup_environment()
	# Editor presentation has its own frame budget; author gameplay caps do not
	# constrain navigation in this separate runtime.
	if OS.has_feature("web"):
		Engine.max_fps=0
		OS.low_processor_usage_mode=false
	hierarchy_editor.setup(self)
	editor_annotations = preload("res://editor_annotations.gd").new()
	var annotation_layer = CanvasLayer.new()
	annotation_layer.layer = 10
	add_child(annotation_layer)
	annotation_layer.add_child(editor_annotations)
	editor_annotations.setup(self)
	world_client = load("res://world_client.gd").new()
	add_child(world_client)
	world_client.setup(self)
	collaboration_overlay = load("res://collaboration_overlay.gd").new()
	add_child(collaboration_overlay)
	get_viewport().size_changed.connect(_viewport_resized)
	if OS.has_feature("web"):
		var query = JSON.parse_string(str(JavaScriptBridge.eval("JSON.stringify(Object.fromEntries(new URLSearchParams(window.location.search)))")))
		nonce = str(query.get("nonce", ""))
		mode = str(query.get("mode", "main"))
		origin = str(JavaScriptBridge.eval("window.location.origin"))
		# Check the actual browser Window identity here, not GDScript wrapper identity.
		JavaScriptBridge.eval("window.__atelierPreviewBridge={listen:function(cb){this.handler=function(e){if(e.origin===window.location.origin&&e.source===window.parent)cb(JSON.stringify(e.data));};window.addEventListener('message',this.handler);},send:function(s){window.parent.postMessage(JSON.parse(s),window.location.origin);}}")
		bridge = JavaScriptBridge.get_interface("__atelierPreviewBridge")
		callback = JavaScriptBridge.create_callback(_on_browser_message)
		bridge.listen(callback)
	else:
		nonce = str(cli_args.get("nonce", "native-check"))
		origin = str(cli_args.get("origin", "http://127.0.0.1:48931"))
		mode = str(cli_args.get("mode", "main"))
	refresh_canvas_scale()
	update_camera()
	emit_ready()
	if cli_args.has("scene"):
		var packet = JSON.parse_string(FileAccess.get_file_as_string(cli_args.scene))
		if packet is Dictionary:
			packet.merge({"source": "world-atelier-workspace", "nonce": nonce, "type": "scene", "seq": 1}, false)
			receive(packet)

func setup_environment() -> void:
	var environment_node = WorldEnvironment.new()
	var environment = Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("#0e1723")
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color("#d2e0f5")
	environment.ambient_light_energy = .25
	environment.reflected_light_source = Environment.REFLECTION_SOURCE_DISABLED
	environment.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	environment_node.environment = environment
	add_child(environment_node)
	var sun = DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-48, -35, 0)
	sun.light_energy = .65
	sun.light_color = Color("#fff0d9")
	sun.shadow_enabled = true
	add_child(sun)
	var fill = DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(-22, 140, 0)
	fill.light_energy = .20
	fill.light_color = Color("#93bdff")
	add_child(fill)
	camera = Camera3D.new()
	camera.fov = 45
	camera.near = .02
	camera.far = 20000
	add_child(camera)
	camera.current = true
	var floor_mesh = MeshInstance3D.new()
	editor_floor=floor_mesh
	var plane = PlaneMesh.new()
	plane.size = Vector2(10000, 10000)
	floor_mesh.mesh = plane
	floor_mesh.position.y = -.025
	var shader = Shader.new()
	shader.code = "shader_type spatial; render_mode unshaded; varying vec3 wp; void vertex(){wp=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;} void fragment(){vec2 p=wp.xz;vec2 line=abs(fract(p-.5)-.5)/max(fwidth(p),vec2(.0001));float grid=1.0-min(min(line.x,line.y),1.0);float fade=1.0-smoothstep(18.0,70.0,length(p));ALBEDO=mix(vec3(.045,.071,.10),vec3(.115,.155,.19),grid*fade*.72);float axis=1.0-min(min(abs(p.x),abs(p.y))/.025,1.0);ALBEDO+=vec3(.035,.055,.067)*axis*fade;}"
	var material = ShaderMaterial.new()
	material.shader = shader
	floor_mesh.material_override = material
	add_child(floor_mesh)
	scene_root = Node3D.new()
	scene_root.name = "AuthoredScene"
	add_child(scene_root)
	helpers = Node3D.new()
	helpers.name = "EditorHelpers"
	add_child(helpers)
	selection_box = MeshInstance3D.new()
	selection_box.visible = false
	var outline = ImmediateMesh.new()
	outline.surface_begin(Mesh.PRIMITIVE_LINES)
	var box = AABB(Vector3.ZERO, Vector3.ONE)
	for i in range(8):
		for bit in [1,2,4]:
			if (i & bit) == 0:
				outline.surface_add_vertex(box.get_endpoint(i))
				outline.surface_add_vertex(box.get_endpoint(i | bit))
	outline.surface_end()
	selection_box.mesh = outline
	selection_box.material_override = helper_material(Color("69e7ed"))
	helpers.add_child(selection_box)
	gizmo = Gizmo.new()
	helpers.add_child(gizmo)
	var overlay = CanvasLayer.new()
	add_child(overlay)
	status_label = Label.new()
	status_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	status_label.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_LEFT)
	status_label.position = Vector2(14, -42)
	status_label.add_theme_font_size_override("font_size", 13)
	status_label.add_theme_color_override("font_color", Color("e5edf6"))
	status_label.add_theme_color_override("font_outline_color", Color("101722"))
	status_label.add_theme_constant_override("outline_size", 4)
	overlay.add_child(status_label)

func _on_browser_message(arguments: Array) -> void:
	if arguments.size() == 0: return
	var packet = JSON.parse_string(str(arguments[0]))
	if packet is Dictionary: receive(packet)

func receive(packet: Dictionary) -> void:
	if packet.get("source") != "world-atelier-workspace" or packet.get("nonce") != nonce: return
	match packet.get("type"):
		"world":
			if mode=="main": world_client.receive(packet)
		"presence":
			if not current_command(packet) or packet.get("branch_id",branch_id)!=branch_id or not packet.get("peers") is Array: return
			var local_peer = packet.get("local_peer")
			if local_peer != null and not local_peer is Dictionary: return
			collaboration_overlay.set_peers(packet.peers, local_peer if local_peer is Dictionary else {})
		"development":
			if not current_command(packet) or packet.get("branch_id",branch_id)!=branch_id or not packet.get("states") is Array: return
			development_states = packet.states.duplicate(true)
			development_received = true
			update_development_overlay()
		"display_settings":
			if not current_command(packet) or not packet.get("settings") is Dictionary: return
			collaboration_overlay.apply_display_settings(packet.settings)
		"scene":
			var seq_value = packet.get("seq")
			if not (seq_value is int or seq_value is float) or not is_finite(float(seq_value)) or float(seq_value) != floorf(float(seq_value)) or seq_value < 0 or seq_value > 9007199254740991:
				emit_error("invalid_sequence", "scene seq must be a nonnegative integer", -1)
				return
			var seq = int(seq_value)
			if seq <= requested_seq: return
			requested_seq = seq
			generation += 1
			cancel_drag()
			var error = Factory.validate(packet, origin)
			if not error.is_empty():
				emit_error("invalid_scene", error, seq)
				return
			load_scene(packet, generation)
		"annotation":
			if current_command(packet) and requested_seq == applied_seq: editor_annotations.configure(packet)
		"navigation_settings":
			if not current_command(packet): return
			var speed = packet.get("camera_speed")
			if (speed is int or speed is float) and is_finite(float(speed)):
				camera_speed = clampf(float(speed), .1, 1000)
			var sensitivity=packet.get("sensitivity")
			if (sensitivity is int or sensitivity is float) and is_finite(float(sensitivity)): editor_navigation.sensitivity=clampf(float(sensitivity),.0005,.01)
			if packet.get("response") in ["direct","smooth"]: editor_navigation.response=0.0 if packet.response=="direct" else .045
			emit_camera()
		"editor_preview":
			hierarchy_editor.receive_preview(packet)
		"placement":
			receive_placement(packet)
		"select":
			if packet.has("document_id") and packet.document_id != document_id: return
			if packet.has("seq") and packet.seq != applied_seq: return
			cancel_drag()
			select_objects(packet.get("ids", [packet.get("id", "")]), str(packet.get("id", "")), false)
		"editor":
			if not current_command(packet): return
			if packet.has("tool") and packet.tool not in ["select", "move", "rotate", "scale"]: return
			if packet.has("snap") and not packet.snap is bool: return
			cancel_drag()
			editor_tool = packet.get("tool", editor_tool)
			snap_enabled = packet.get("snap", snap_enabled)
			update_helpers()
			emit_editor_state()
		"camera":
			if not current_command(packet): return
			var action = packet.get("action", "")
			if action not in ["fit", "focus", "front", "top", "right", "perspective", "rotate"]: return
			cancel_drag()
			if action == "fit" or action == "focus":
				frame_scene(action == "focus")
			elif action == "rotate":
				var amount = packet.get("amount", .35)
				if not (amount is int or amount is float) or not is_finite(float(amount)): return
				camera_view = "perspective"
				camera.projection = Camera3D.PROJECTION_PERSPECTIVE
				yaw += clampf(float(amount), -TAU, TAU)
				update_camera()
				emit_camera()
			else:
				camera_view = action
				camera.projection = Camera3D.PROJECTION_PERSPECTIVE if action == "perspective" else Camera3D.PROJECTION_ORTHOGONAL
				frame_scene(true)

func current_command(packet: Dictionary) -> bool:
	return applied_seq >= 0 and packet.get("seq") == applied_seq and (not packet.has("document_id") or packet.document_id == document_id)

func receive_placement(packet: Dictionary) -> void:
	var reply = {"type":"placement", "request_id":packet.get("request_id"), "seq":applied_seq, "document_id":document_id}
	var seq = packet.get("seq")
	if not (seq is int or seq is float) or not current_command(packet) or packet.get("document_id") != document_id or requested_seq > applied_seq:
		reply["error"] = "stale_placement"
	elif mode != "main" or not editable or world_client == null or world_client.mode != "editing":
		reply["error"] = "placement_requires_editing"
	elif not packet.get("request_id") is String or packet.request_id.is_empty():
		reply["error"] = "invalid_request_id"
	else:
		var screen = packet.get("screen")
		var valid = screen is Array and screen.size() == 2
		if valid:
			for value in screen:
				if not (value is int or value is float) or not is_finite(float(value)) or value < 0 or value > 1: valid = false
		if not valid:
			reply["error"] = "invalid_placement_screen"
		else:
			# Browser coordinates cover the entire canvas, including viewport stretch.
			var size = get_viewport().get_visible_rect().size
			if not size.is_finite() or size.x <= 0 or size.y <= 0:
				reply["error"] = "invalid_placement_viewport"
			else:
				reply.merge(placement_at(Vector2(screen[0],screen[1]) * size))
	if not reply.has("error"): reply.merge(placement_source())
	emit(reply)

func placement_source() -> Dictionary:
	return {"source_revision":placement_revision}

func placement_meshes() -> Array:
	var result = []
	for id in objects:
		if hierarchy_editor.active() and not hierarchy_editor.shown(id): continue
		var row: Dictionary = definitions.get(id,{})
		# Synthetic anchor markers are editor affordances, not placement surfaces.
		if row.get("kind") == "anchor" and not row.has("model_hash"): continue
		if objects[id] is MeshInstance3D: result.append(objects[id])
		if objects[id] is Node3D: result.append_array(Hierarchy.owned_meshes(objects[id]))
	return result

func placement_at(screen: Vector2) -> Dictionary:
	if not is_instance_valid(camera): return {"error":"placement_camera_unavailable"}
	var ray_origin = camera.project_ray_origin(screen)
	var direction = camera.project_ray_normal(screen)
	if not ray_origin.is_finite() or not direction.is_finite() or direction.is_zero_approx(): return {"error":"invalid_placement_ray"}
	var best = INF
	var position = Vector3.ZERO
	var visited = {}
	for mesh in placement_meshes():
		if not is_instance_valid(mesh) or not mesh is MeshInstance3D or mesh.mesh == null: continue
		var key = mesh.get_instance_id()
		if visited.has(key): continue
		visited[key] = true
		if not mesh.is_visible_in_tree() or (mesh.layers & camera.cull_mask) == 0: continue
		if not mesh.global_transform.is_finite() or absf(mesh.global_basis.determinant()) < 0.00000001: continue
		var inverse = mesh.global_transform.affine_inverse()
		var local_origin = inverse * ray_origin
		var local_direction = (inverse.basis * direction).normalized()
		if mesh.get_aabb().intersects_ray(local_origin,local_direction) == null: continue
		var faces = mesh.mesh.get_faces()
		for i in range(0,faces.size()-2,3):
			var hit = Geometry3D.ray_intersects_triangle(local_origin,local_direction,faces[i],faces[i+1],faces[i+2])
			if hit == null: continue
			var world_hit: Vector3 = mesh.global_transform * hit
			var depth = (world_hit-ray_origin).dot(direction)
			if depth < best and placement_visible_point(world_hit) and depth >= 0:
				best = depth
				position = world_hit
	if best == INF:
		# No surrogate bounding-box surfaces. A forward, clipped ground hit only.
		if absf(direction.y) < 0.000001: return {"error":"placement_no_intersection"}
		var depth = -ray_origin.y / direction.y
		position = ray_origin + direction * depth
		if depth < 0 or not placement_visible_point(position): return {"error":"placement_no_intersection"}
	return {"dimension":"3d", "position":[position.x,position.y,position.z]}

func placement_visible_point(point: Vector3) -> bool:
	if not point.is_finite(): return false
	var depth = -(camera.global_transform.affine_inverse() * point).z
	return is_finite(depth) and depth >= camera.near and depth <= camera.far

func emit_editor_state() -> void:
	emit({"type": "editor_state", "seq": applied_seq, "document_id": document_id, "tool": editor_tool, "snap": snap_enabled, "editable": editable, "axis_space": {"move": "world", "rotate": "world", "scale": "local"}})

func signature(rows: Array) -> String:
	var values = []
	for object in rows:
		values.append([object.id, object.get("kind", "model"), object.get("model_url", ""), object.get("model_hash", "")])
	return JSON.stringify(values)

func load_scene(packet: Dictionary, token: int) -> void:
	if Hierarchy.enabled(packet):
		hierarchy_editor.load_scene(packet,token)
		return
	var next_signature = signature(packet.objects)
	if next_signature == model_signature and objects.size() == packet.objects.size():
		for object in packet.objects:
			apply_transform(objects[object.id], object)
			definitions[object.id] = object.duplicate(true)
		finish_scene(packet, false)
		return
	var candidate = Node3D.new()
	candidate.name = "AuthoredScene"
	var candidate_objects = {}
	var candidate_definitions = {}
	var candidate_assets = []
	for object in packet.objects:
		if token != generation:
			candidate.free()
			return
		var root = Node3D.new()
		root.name = "Object_" + str(candidate_objects.size())
		candidate.add_child(root)
		root.set_meta("object_id", object.id)
		apply_transform(root, object)
		if object.get("kind") == "anchor":
			create_anchor(root)
		else:
			var key = str(object.model_url) + "|" + str(object.get("model_hash", ""))
			var asset = asset_cache.get(key, {})
			if asset.is_empty():
				var response = await fetch_model(str(object.model_url))
				if token != generation:
					candidate.free()
					return
				if not response.ok:
					candidate.free()
					emit_error("asset_download", response.error, packet.seq, object.id)
					return
				asset = Factory.parse_glb(response.bytes, str(object.get("model_hash", "")))
				if not asset.ok:
					candidate.free()
					emit_error("asset_parse", asset.error, packet.seq, object.id)
					return
				asset_cache[key] = asset
				# Bound resources even when a later model fails or this candidate is cancelled.
				while asset_cache.size() > 32:
					asset_cache.erase(asset_cache.keys()[0])
			var imported = asset.scene.instantiate()
			strip_imported_cameras(imported)
			root.add_child(imported)
			candidate_assets.append({"id": object.id, "url": object.model_url, "hash": asset.hash, "bytes": asset.bytes, "mesh_count": asset.mesh_count})
		candidate_objects[object.id] = root
		candidate_definitions[object.id] = object.duplicate(true)
	if token != generation:
		candidate.free()
		return
	var previous = scene_root
	scene_root = candidate
	add_child(candidate)
	remove_child(previous)
	previous.queue_free()
	hierarchy_editor.clear()
	objects = candidate_objects
	definitions = candidate_definitions
	active_assets = candidate_assets
	model_signature = next_signature
	while asset_cache.size() > 32: asset_cache.erase(asset_cache.keys()[0])
	finish_scene(packet, true)

func fetch_model(url: String) -> Dictionary:
	var request = HTTPRequest.new()
	request.timeout = 25
	request.max_redirects = 0
	request.body_size_limit = Factory.MAX_ASSET_BYTES
	add_child(request)
	var address = origin + url if url.begins_with("/") else url
	var error = request.request(address)
	if error != OK:
		request.queue_free()
		return {"ok": false, "error": "HTTP request could not start: " + error_string(error)}
	var result = await request.request_completed
	request.queue_free()
	if result[0] != HTTPRequest.RESULT_SUCCESS or result[1] != 200:
		return {"ok": false, "error": "GLB request failed (result %d, HTTP %d)" % [result[0], result[1]]}
	return {"ok": true, "bytes": result[3]}

func strip_imported_cameras(node: Node) -> void:
	for child in node.get_children():
		if child is Camera3D or child is Light3D:
			node.remove_child(child)
			child.free()
		else:
			strip_imported_cameras(child)

func apply_transform(node: Node3D, object: Dictionary) -> void:
	node.position = Factory.vec(object.position)
	node.rotation_degrees = Factory.vec(object.get("rotation", [0,0,0]))
	node.scale = Factory.scale3(object.get("scale", 1))

func finish_scene(packet: Dictionary, rebuilt: bool) -> void:
	if document_id!=packet.document_id or branch_id!=str(packet.get("branch_id",branch_id)):
		collaboration_overlay.set_peers([])
		development_states.clear()
		development_received = false
	document_id = packet.document_id
	placement_revision = str(packet.get("source_revision",packet.get("scene_revision","")))
	applied_seq = int(packet.seq)
	latest_scene_editable = packet.get("editable",true)
	branch_id = str(packet.get("branch_id",branch_id))
	editable = latest_scene_editable and mode=="main" and world_client.mode=="editing"
	scene_root.visible = world_client.mode=="editing" or not world_client.projection.visible
	refresh_bounds()
	select_objects(packet.get("selected_ids", [packet.get("selected_id", "")]), str(packet.get("selected_id", "")), false)
	if packet.get("frame", false) and world_client.mode=="editing": frame_scene()
	var stats = telemetry()
	stats.merge({"type": "loaded", "seq": applied_seq, "rebuilt": rebuilt, "render_verified": false})
	emit(stats)
	emit_editor_state()
	world_client.document_loaded(packet)
	update_development_overlay()
	print("PREVIEW_LOADED " + JSON.stringify(stats))
	if cli_args.has("capture"):
		capture.call_deferred()
	elif cli_args.has("quit-on-loaded"):
		get_tree().quit(0)

func refresh_bounds() -> void:
	var got_bounds = false
	for id in objects:
		if hierarchy_editor.active() and not hierarchy_editor.shown(id):continue
		var bounds = object_bounds(id)
		scene_bounds = scene_bounds.merge(bounds) if got_bounds else bounds
		got_bounds = true
	if not got_bounds: scene_bounds = AABB(Vector3(-2,0,-2), Vector3(4,3,4))

func object_bounds(id: String) -> AABB:
	var result = Hierarchy.world_bounds(objects[id]) if hierarchy_editor.active() else Factory.measure(objects[id])
	return result.bounds if result.mesh_count else AABB(objects[id].global_position - Vector3.ONE * .2, Vector3.ONE * .4)

func telemetry() -> Dictionary:
	var rows = []
	var count = 0
	for id in objects:
		var is_anchor = definitions[id].get("kind") == "anchor" and not (hierarchy_editor.active() and definitions[id].has("model_hash"))
		if hierarchy_editor.active():
			var record=Hierarchy.observation(id,objects[id],definitions[id])
			var stats=Hierarchy.world_bounds(objects[id],true)
			record.merge({"kind":definitions[id].get("kind","model"),"mesh_count":stats.mesh_count if hierarchy_editor.shown(id) and not is_anchor else 0,"bounds":Factory.bounds_json(object_bounds(id)),"visible":hierarchy_editor.shown(id)})
			count+=record.mesh_count
			rows.append(record)
			continue
		var measured = Factory.measure(objects[id])
		if not is_anchor: count += measured.mesh_count
		rows.append({"id": id, "kind": "anchor" if is_anchor else "model", "mesh_count": 0 if is_anchor else measured.mesh_count, "bounds": Factory.bounds_json(object_bounds(id)), "position": Factory.array3(objects[id].position), "rotation": Factory.array3(objects[id].rotation_degrees), "scale": Factory.array3(objects[id].scale)})
	return {"document_id": document_id, "object_ids": objects.keys(), "objects": rows, "mesh_count": count, "bounds": Factory.bounds_json(scene_bounds), "assets": active_assets, "selected_id": selected_id,"selected_ids":selected_ids.duplicate(),"hierarchy_pack_hash":hierarchy_editor.source_scene.get("hierarchy_pack",{}).get("pack_hash",""),"mount_count":hierarchy_editor.graph.get("mounts",{}).size()}

func frame_scene(focus_selected: bool = false) -> void:
	refresh_bounds()
	var bounds = scene_bounds
	var current_objects = display_objects()
	if mode=="object" and hierarchy_editor.active() and objects.has(hierarchy_editor.preview_object_id):bounds=object_bounds(hierarchy_editor.preview_object_id)
	elif focus_selected and current_objects.has(selected_id): bounds = display_bounds(selected_id)
	elif current_objects!=objects:
		var first = true
		for id in current_objects:
			bounds = display_bounds(id) if first else bounds.merge(display_bounds(id))
			first = false
	target = bounds.get_center()
	var aspect = maxf(.05, get_viewport().get_visible_rect().size.x / maxf(1, get_viewport().get_visible_rect().size.y))
	var half_fov = minf(deg_to_rad(camera.fov) / 2, atan(tan(deg_to_rad(camera.fov) / 2) * aspect))
	var radius = maxf(.15, bounds.size.length() / 2)
	distance = clampf(radius / sin(half_fov) * 1.20, .4, 15000)
	camera.size = clampf(radius * 2 * 1.20 / minf(1, aspect), .3, 18000)
	update_camera()
	emit_camera()

func update_camera() -> void:
	pitch = clampf(pitch, -1.48, 1.48)
	var offset = Vector3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch))
	if camera_view == "front": offset = Vector3.BACK
	if camera_view == "right": offset = Vector3.RIGHT
	if camera_view == "top": offset = Vector3.UP
	camera.position = target + offset * distance
	camera.look_at(target, Vector3.BACK if camera_view == "top" else Vector3.UP)
	update_helpers(false)

func refresh_canvas_scale() -> void:
	if gizmo == null: return
	var ratio = 1.0
	if OS.has_feature("web"):
		var css_width = JavaScriptBridge.eval("(function(){var c=document.getElementById('canvas');return c?c.getBoundingClientRect().width:0;})()")
		if (css_width is float or css_width is int) and css_width > 0:
			ratio = clampf(get_viewport().get_visible_rect().size.x / float(css_width), .25, 8)
	gizmo.pixel_ratio = ratio
	status_label.add_theme_font_size_override("font_size", roundi(13 * ratio))
	status_label.add_theme_constant_override("outline_size", maxi(1, roundi(3 * ratio)))
	status_label.position = Vector2(14 * ratio, -56 * ratio)
	status_label.size.x = maxf(1, get_viewport().get_visible_rect().size.x - 28 * ratio)
	status_label.clip_text = true

func _viewport_resized() -> void:
	refresh_canvas_scale()
	cancel_drag()
	if mode == "object" and applied_seq >= 0: frame_scene()
	else: update_camera()

func _process(delta: float) -> void:
	if editor_navigation.capture_lost: cancel_drag()
	hierarchy_editor.advance()
	elapsed += delta
	development_clock += delta
	if development_clock>.15:
		development_clock = 0
		update_development_overlay()
	ready_clock += delta
	if applied_seq < 0 and ready_clock > 1:
		ready_clock = 0
		emit_ready()
	if button_down == MOUSE_BUTTON_RIGHT and navigation == "freelook" and (world_client==null or world_client.mode not in ["playing","entering_inspect"]):
		var direction = Vector3.ZERO
		if Input.is_physical_key_pressed(KEY_W): direction -= camera.global_basis.z
		if Input.is_physical_key_pressed(KEY_S): direction += camera.global_basis.z
		if Input.is_physical_key_pressed(KEY_A): direction -= camera.global_basis.x
		if Input.is_physical_key_pressed(KEY_D): direction += camera.global_basis.x
		if Input.is_physical_key_pressed(KEY_Q): direction -= Vector3.UP
		if Input.is_physical_key_pressed(KEY_E): direction += Vector3.UP
		var boost = 3.0 if Input.is_physical_key_pressed(KEY_SHIFT) else .2 if Input.is_physical_key_pressed(KEY_ALT) else 1.0
		var travel=editor_navigation.step(direction.normalized(),camera_speed*boost,delta)
		if not travel.is_zero_approx():
			target += travel
			editor_navigation.last_input_at=elapsed
			update_camera()
			if elapsed - last_camera_emit > .1: emit_camera()
		if boost!=last_speed_multiplier:
			last_speed_multiplier=boost
			emit_camera()
	performance_clock+=delta
	performance_frames+=1
	performance_frame_times.append(delta*1000)
	if performance_clock>=.5:
		performance_frame_times.sort()
		if applied_seq>=0: emit({"type":"viewport_performance","seq":applied_seq,"document_id":document_id,"fps":performance_frames/performance_clock,"frame_ms":performance_clock*1000/performance_frames,"p95_ms":performance_frame_times[mini(performance_frame_times.size()-1,int(performance_frame_times.size()*.95))],"navigating":navigation_active()})
		performance_clock=0
		performance_frames=0
		performance_frame_times.clear()
	if cli_args.has("quit-after") and elapsed > float(cli_args["quit-after"]): get_tree().quit(2 if applied_seq < 0 else 0)

func update_development_overlay() -> void:
	if collaboration_overlay==null: return
	var definitions_view=display_definitions()
	var values: Dictionary = {}
	if development_received:
		for state in development_states:
			if not state is Dictionary: continue
			var id = state.get("object_id",state.get("id",""))
			if definitions_view.has(id) and state.get("status") in ["editing","testing","delivered","failed"] and (not state.has("address") or state.address==definitions_view[id].get("address")):
				if not values.has(id): values[id]={"developments":[]}
				values[id].developments.append(state.duplicate(true))
	else:
		for id in definitions_view:
			if not definitions_view[id].get("developments",[]).is_empty(): values[id]={"developments":definitions_view[id].developments}
	collaboration_overlay.set_developments(values,display_objects())

func set_editor_tool(value: String) -> void:
	cancel_drag()
	editor_tool = value
	update_helpers()
	emit_editor_state()

func _input(event: InputEvent) -> void:
	if editor_annotations != null and editor_annotations.handle_input(event): return
	if world_client!=null and world_client.input(event): return
	if event is InputEventKey and event.pressed and not event.echo:
		var key = event.keycode if event.keycode else event.physical_keycode
		if (event.ctrl_pressed or event.meta_pressed) and (key == KEY_Z or key == KEY_Y):
			cancel_drag()
			if editable and applied_seq >= 0:
				emit({"type": "history", "action": "redo" if key == KEY_Y or event.shift_pressed else "undo", "seq": applied_seq, "document_id": document_id})
			get_viewport().set_input_as_handled()
			return
		if key == KEY_ESCAPE:
			cancel_drag()
			return
		if button_down != MOUSE_BUTTON_RIGHT:
			if key == KEY_F:
				cancel_drag()
				frame_scene(not event.shift_pressed)
			if editable and not event.ctrl_pressed and not event.meta_pressed and not event.alt_pressed:
				if key == KEY_Q: set_editor_tool("select")
				if key == KEY_W: set_editor_tool("move")
				if key == KEY_E: set_editor_tool("rotate")
				if key == KEY_R: set_editor_tool("scale")
	if event is InputEventPanGesture:
		if event.shift_pressed: pan_camera(event.delta * 16)
		else: rotate_camera(event.delta * 6, false)
		emit_camera()
		return
	if event is InputEventMagnifyGesture:
		zoom_camera(event.position, 1.0 / maxf(.01, event.factor))
		return
	if event is InputEventMouseButton:
		if event.button_index in [MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN] and event.pressed:
			var steps = maxf(.01, event.factor)
			var factor = exp((-.12 if event.button_index == MOUSE_BUTTON_WHEEL_UP else .12) * steps)
			if button_down == MOUSE_BUTTON_RIGHT and navigation == "freelook":
				camera_speed = clampf(camera_speed / factor, .1, 1000)
				emit_camera()
			else:
				cancel_drag()
				zoom_camera(event.position, factor)
		elif event.button_index in [MOUSE_BUTTON_LEFT, MOUSE_BUTTON_RIGHT, MOUSE_BUTTON_MIDDLE]:
			if event.pressed:
				if button_down: cancel_drag()
				button_down = event.button_index
				pointer_start = event.position
				pointer_moved = false
				navigation = ""
				if event.button_index == MOUSE_BUTTON_MIDDLE or event.button_index == MOUSE_BUTTON_LEFT and Input.is_physical_key_pressed(KEY_SPACE): navigation = "pan"
				elif event.button_index == MOUSE_BUTTON_RIGHT:
					navigation = "freelook"
					editor_navigation.begin_capture()
					emit_camera()
				elif event.button_index == MOUSE_BUTTON_LEFT and (event.alt_pressed or mode == "object"):
					navigation = "orbit"
					begin_orbit(event.alt_pressed)
				elif event.button_index == MOUSE_BUTTON_LEFT:
					if editable: begin_drag(event.position)
			elif event.button_index == button_down:
				if not drag_handle.is_empty():
					if pointer_moved:
						emit_transform("commit")
						clear_drag()
						refresh_bounds()
					else:
						cancel_drag()
						var hit = pick_object(event.position)
						if not hit.is_empty() and not (event.ctrl_pressed or event.meta_pressed or event.shift_pressed): select_pointer(hit, event)
				elif event.button_index == MOUSE_BUTTON_LEFT and not pointer_moved and not event.alt_pressed and (navigation != "orbit" or mode == "object"): select_pointer(pick_object(event.position), event)
				button_down = 0
				navigation = ""
				orbit_pivot = null
				editor_navigation.reset()
				last_speed_multiplier=1.0
				update_helpers()
				emit_camera()
	if event is InputEventMouseMotion:
		if button_down and (event.button_mask & (1 << (button_down - 1))) == 0:
			cancel_drag()
		if not button_down:
			gizmo.highlight(gizmo.hit_test(event.position))
			return
		if event.position.distance_to(pointer_start) > 3: pointer_moved = true
		if not drag_handle.is_empty():
			update_drag(event)
		elif navigation == "pan": pan_camera(event.relative)
		elif navigation in ["orbit", "freelook"]:
			# screen_relative avoids project stretch scaling in captured mode.
			var relative=event.screen_relative if navigation=="freelook" and not event.screen_relative.is_zero_approx() else event.relative
			rotate_camera(relative, navigation == "freelook")
		if elapsed - last_camera_emit > .05: emit_camera()

func pan_camera(relative: Vector2) -> void:
	editor_navigation.last_input_at=elapsed
	var units = camera.size if camera.projection == Camera3D.PROJECTION_ORTHOGONAL else distance * 2 * tan(deg_to_rad(camera.fov / 2))
	units /= maxf(1, get_viewport().get_visible_rect().size.y)
	var translation = (-camera.global_basis.x * relative.x + camera.global_basis.y * relative.y) * units
	target += translation
	camera.position += translation
	# Translate eye and focus together in the camera plane; do not rebuild its rotation.
	update_helpers(false)

func begin_orbit(use_selection: bool) -> void:
	orbit_pivot = null
	var selected = display_objects().get(selected_id)
	if not use_selection or not is_instance_valid(selected) or not selected is Node3D: return
	var center = display_bounds(selected_id).get_center()
	if center.is_finite() and camera.position.distance_squared_to(center) > .000001:
		# Resolve the primary selection once per gesture, without reframing the camera.
		orbit_pivot = center

func rotate_camera(relative: Vector2, freelook: bool) -> void:
	editor_navigation.last_input_at=elapsed
	var eye = camera.position
	if camera_view != "perspective":
		if camera_view == "front": yaw = 0; pitch = 0
		if camera_view == "right": yaw = PI / 2; pitch = 0
		if camera_view == "top": yaw = 0; pitch = 1.48
	camera_view = "perspective"
	camera.projection = Camera3D.PROJECTION_PERSPECTIVE
	var ratio = maxf(.25, gizmo.pixel_ratio)
	var sensitivity=editor_navigation.sensitivity if freelook else .004
	yaw -= relative.x * sensitivity / ratio
	pitch = clampf(pitch + relative.y * sensitivity / ratio, -1.48, 1.48)
	var offset = Vector3(sin(yaw)*cos(pitch),sin(pitch),cos(yaw)*cos(pitch))
	if freelook: target = eye - offset * distance
	elif orbit_pivot is Vector3:
		# Rotate the eye and viewing frame together around the selected object's
		# world-space center. Off-center selections stay at the same screen position.
		var turn = Basis.looking_at(-offset, Vector3.UP) * camera.basis.inverse()
		var next_eye: Vector3 = orbit_pivot + turn * (eye - orbit_pivot)
		target = next_eye - offset * distance
	update_camera()

func zoom_camera(screen: Vector2, factor: float) -> void:
	editor_navigation.last_input_at=elapsed
	# Preserve the point under the cursor on the current focus plane.
	var normal = camera.global_basis.z
	var before = ray_on_plane(screen, target, normal)
	distance = clampf(distance * factor, .05, 18000)
	camera.size = clampf(camera.size * factor, .05, 18000)
	update_camera()
	var after = ray_on_plane(screen, target, normal)
	if before != null and after != null:
		target += before - after
		update_camera()
	emit_camera()

func annotation_screen_rect(id: String) -> Rect2:
	return collaboration_overlay.remote_selections.project_bounds(display_bounds(id))

func annotation_position(screen: Vector2) -> Dictionary:
	var hit = placement_at(screen)
	if hit.has("error"):
		var point = ray_on_plane(screen, target, camera.global_basis.z)
		if point != null: return {"dimension":"3d", "position":Factory.array3(point), "surface":"view_plane"}
	return hit

func annotation_project(position: Array) -> Vector2:
	var point = Factory.vec(position)
	return Vector2(-10000,-10000) if camera.is_position_behind(point) else camera.unproject_position(point)

func display_objects() -> Dictionary:
	if world_client!=null and world_client.mode!="editing" and world_client.projection.visible: return world_client.projection.objects
	return objects

func display_definitions() -> Dictionary:
	if world_client!=null and world_client.mode!="editing" and world_client.projection.visible: return world_client.projection.definitions
	return definitions

func display_bounds(id: String) -> AABB:
	var nodes = display_objects()
	var result = Hierarchy.world_bounds(nodes[id])
	return result.bounds if result.mesh_count else AABB(nodes[id].global_position-Vector3.ONE*.2,Vector3.ONE*.4)

func pick_object(screen: Vector2) -> String:
	var ray_origin = camera.project_ray_origin(screen)
	var ray_direction = camera.project_ray_normal(screen)
	var best = INF
	var result = ""
	var nodes = display_objects()
	var rows = display_definitions()
	for id in nodes:
		if rows[id].get("kind")=="group":continue
		if nodes==objects and hierarchy_editor.active() and not hierarchy_editor.shown(id):continue
		var bounds = display_bounds(id)
		if bounds.intersects_ray(ray_origin, ray_direction) == null: continue
		if rows[id].get("kind") == "anchor" and not (rows[id].has("address") and rows[id].has("model_hash")):
			var hit = bounds.intersects_ray(ray_origin, ray_direction)
			var depth = ray_origin.distance_to(hit)
			if depth < best:
				best = depth
				result = id
			continue
		for mesh in Hierarchy.owned_meshes(nodes[id]):
			if mesh.mesh == null: continue
			var inverse = mesh.global_transform.affine_inverse()
			var local_origin = inverse * ray_origin
			var local_direction = (inverse.basis * ray_direction).normalized()
			if mesh.get_aabb().intersects_ray(local_origin, local_direction) == null: continue
			var faces = mesh.mesh.get_faces()
			for i in range(0, faces.size() - 2, 3):
				var hit = Geometry3D.ray_intersects_triangle(local_origin, local_direction, faces[i], faces[i+1], faces[i+2])
				if hit == null: continue
				var depth = ray_origin.distance_to(mesh.global_transform * hit)
				if depth < best:
					best = depth
					result = id
	return result

func select_object(id: String, notify_parent: bool) -> void:
	select_objects([id], id, notify_parent)

func select_objects(ids: Array, primary: String, notify_parent: bool) -> void:
	selected_ids.clear()
	for id in ids.slice(0,128):
		if id is String and display_objects().has(id) and not selected_ids.has(id): selected_ids.append(id)
	selected_id = primary if selected_ids.has(primary) else str(selected_ids.back()) if not selected_ids.is_empty() else ""
	update_helpers()
	if notify_parent:
		var packet = selection_packet()
		packet.merge({"type":"selected", "id":selected_id, "ids":selected_ids.duplicate(), "document_id":document_id, "seq":applied_seq},true)
		emit(packet)

func selection_packet() -> Dictionary:
	if display_objects().has(selected_id) and display_definitions()[selected_id].has("address"):
		return Hierarchy.observation(selected_id,display_objects()[selected_id],display_definitions()[selected_id])
	return {}

func pointer_selection_path(id: String) -> Array:
	# Only registered, visible authoring objects form selection levels. Engine
	# wrappers and imported mesh nodes remain part of their owning object.
	var nodes = display_objects()
	var path: Array = []
	if not nodes.has(id): return path
	var identities: Dictionary = {}
	for key in nodes: identities[nodes[key]] = key
	var node: Node = nodes[id]
	while node != null:
		if identities.has(node):
			var key: String = identities[node]
			if nodes != objects or not hierarchy_editor.active() or hierarchy_editor.shown(key): path.push_front(key)
		node = node.get_parent()
	return path

func pointer_selection_target(id: String) -> String:
	var path = pointer_selection_path(id)
	if path.is_empty(): return ""
	var level = path.find(selected_id) if selected_ids.size() == 1 else -1
	return path[mini(level + 1, path.size() - 1)]

func select_pointer(id: String, event: InputEventMouseButton) -> void:
	var ids = selected_ids.duplicate()
	if event.ctrl_pressed or event.meta_pressed:
		if id.is_empty(): return
		if ids.has(id): ids.erase(id)
		else: ids.append(id)
	elif event.shift_pressed:
		if id.is_empty(): return
		if not ids.has(id): ids.append(id)
	else:
		id = pointer_selection_target(id)
		ids = [id]
	select_objects(ids,id,true)

func line_mesh(parent: Node3D, points: Array, color: Color, width: float = .015) -> void:
	for i in range(0, points.size(), 2):
		var start: Vector3 = points[i]
		var end: Vector3 = points[i+1]
		var mesh = MeshInstance3D.new()
		var cylinder = CylinderMesh.new()
		cylinder.top_radius = width
		cylinder.bottom_radius = width
		cylinder.height = start.distance_to(end)
		cylinder.radial_segments = 6
		mesh.mesh = cylinder
		mesh.material_override = helper_material(color)
		parent.add_child(mesh)
		mesh.position = (start + end) / 2
		var normal = (end-start).normalized()
		var tangent = normal.cross(Vector3.UP if absf(normal.y) < .9 else Vector3.RIGHT).normalized()
		mesh.basis = Basis(tangent, normal, tangent.cross(normal))

func helper_material(color: Color) -> StandardMaterial3D:
	var material = StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.albedo_color = color
	material.no_depth_test = true
	return material

func create_anchor(root: Node3D) -> void:
	var sphere = MeshInstance3D.new()
	var mesh = SphereMesh.new()
	mesh.radius = .14
	mesh.height = .28
	mesh.radial_segments = 12
	mesh.rings = 6
	sphere.mesh = mesh
	sphere.material_override = helper_material(Color("#ffd089"))
	root.add_child(sphere)
	for axis in AXES:
		line_mesh(root, [-axis * .32, axis * .32], Color("#f5e3bd"), .012)

func update_helpers(remeasure: bool = true) -> void:
	if gizmo == null: return
	var nodes = display_objects()
	var has_selection = nodes.has(selected_id)
	# All selection feedback is a geometry contour; only transform handles remain.
	selection_box.visible = false
	if not has_selection or not manipulated_object(selected_id) is Node3D:
		gizmo.visible = false
		update_status()
		return
	if remeasure:
		var bounds = display_bounds(selected_id).grow(.035)
		selection_box.transform = Transform3D(Basis.from_scale(bounds.size.max(Vector3.ONE * .001)), bounds.position)
	var object: Node3D = manipulated_object(selected_id)
	var orientation = Hierarchy.direction_basis(object.global_basis) if editor_tool == "scale" else Basis.IDENTITY
	gizmo.configure(camera, object.global_position, orientation, editor_tool, editable and not (editor_annotations!=null and editor_annotations.enabled))
	gizmo.highlight(gizmo.hover, drag_handle)
	update_status()

func update_status() -> void:
	if status_label == null: return
	if not drag_handle.is_empty():
		status_label.visible = true
		status_label.text = "%s %s  %s\nEsc cancel  |  Ctrl snap  |  Shift fine" % [drag_tool.to_upper(), drag_handle.to_upper(), drag_hint]
	else:
		status_label.visible = false

func manipulated_object(id: String) -> Node:
	return objects.get(id)

func scene_observation(id: String) -> Dictionary:
	return Hierarchy.observation(id,objects[id],definitions[id]) if hierarchy_editor.active() else trs(manipulated_object(id))

func trs(object: Node3D) -> Dictionary:
	return {"position": Factory.array3(object.position), "rotation": Factory.array3(object.rotation_degrees), "scale": Factory.array3(object.scale)}

func ray_on_plane(screen: Vector2, at: Vector3, normal: Vector3) -> Variant:
	var direction = camera.project_ray_normal(screen)
	var start = camera.project_ray_origin(screen)
	var denominator = normal.dot(direction)
	if absf(denominator) < .08: return null
	var t = normal.dot(at - start) / denominator
	if t < 0: return null
	return start + direction * t

func begin_drag(screen: Vector2) -> void:
	if not editable or not objects.has(selected_id) or not manipulated_object(selected_id) is Node3D or editor_tool == "select": return
	var hit = gizmo.hit_test(screen)
	if hit.is_empty(): return
	if hierarchy_editor.active():
		if not hierarchy_editor.begin_source_drag():return
		update_helpers()
	drag_handle = hit
	drag_tool = editor_tool
	drag_id = selected_id
	drag_original = manipulated_object(drag_id).transform
	drag_global_original = manipulated_object(drag_id).global_transform
	drag_before = scene_observation(drag_id)
	drag_origin = manipulated_object(drag_id).global_position
	drag_start_pointer = screen
	drag_world_length = gizmo.world_size
	drag_plane_valid = false
	drag_hint = ""
	var handle = gizmo.handles[hit]
	if handle.has("axis"):
		drag_world_axis = (Hierarchy.direction_basis(drag_global_original.basis) * AXES[handle.axis]) if drag_tool == "scale" else AXES[handle.axis]
		var from = camera.unproject_position(drag_origin)
		var to = camera.unproject_position(drag_origin + drag_world_axis * drag_world_length)
		drag_screen_axis = (to - from).normalized()
		drag_screen_length = maxf(12 * gizmo.pixel_ratio, from.distance_to(to))
	if handle.kind == "plane" or drag_tool == "rotate":
		drag_plane_normal = AXES[handle.axes[0]].cross(AXES[handle.axes[1]]) if handle.kind == "plane" else drag_world_axis
		var point = ray_on_plane(screen, drag_origin, drag_plane_normal)
		if point != null:
			drag_plane_start = point
			drag_plane_valid = true
		if drag_tool == "rotate":
			drag_angle_previous = 0
			drag_angle_accumulated = 0
			# Edge-on ring fallback uses the screen tangent nearest to the hit.
			var best = INF
			for vertex in handle.points:
				var world_point: Vector3 = gizmo.global_transform * vertex
				var projected = camera.unproject_position(world_point)
				if projected.distance_to(screen) < best:
					best = projected.distance_to(screen)
					var tangent = drag_world_axis.cross(world_point - drag_origin).normalized()
					drag_rotation_tangent = (camera.unproject_position(world_point + tangent * drag_world_length * .1) - projected).normalized()
	if handle.kind == "plane" and not drag_plane_valid:
		clear_drag()
		return
	gizmo.highlight(hit, hit)
	update_status()
	emit_transform("start")

func update_drag(event: InputEventMouseMotion) -> void:
	if drag_handle.is_empty() or not objects.has(drag_id): return
	var object: Node3D = manipulated_object(drag_id)
	var handle = gizmo.handles[drag_handle]
	var fine = .1 if event.shift_pressed else 1.0
	var snap = snap_enabled != event.ctrl_pressed
	var screen_delta = event.position - drag_start_pointer
	var previous_transform = object.transform
	object.transform = drag_original
	if drag_tool == "move":
		var delta = Vector3.ZERO
		if handle.kind == "plane":
			var point = ray_on_plane(event.position, drag_origin, drag_plane_normal)
			if point == null:
				object.transform = previous_transform
				return
			var movement: Vector3 = (point - drag_plane_start) * fine
			for axis_index in handle.axes:
				var amount = movement.dot(AXES[axis_index])
				if snap: amount = snappedf(amount, .25)
				delta += AXES[axis_index] * amount
		else:
			var amount = screen_delta.dot(drag_screen_axis) / drag_screen_length * drag_world_length * fine
			if snap: amount = snappedf(amount, .25)
			delta = drag_world_axis * amount
		object.global_position = (drag_origin + delta).clamp(Vector3.ONE * (-Hierarchy.WORLD_LIMIT if hierarchy_editor.active() else -1000), Vector3.ONE * (Hierarchy.WORLD_LIMIT if hierarchy_editor.active() else 1000))
		drag_hint = "d=(%.2f, %.2f, %.2f)m" % [delta.x, delta.y, delta.z]
	elif drag_tool == "rotate":
		var angle = 0.0
		var point = ray_on_plane(event.position, drag_origin, drag_plane_normal) if drag_plane_valid else null
		if point != null and drag_plane_start.distance_to(drag_origin) > .00001:
			var a = (drag_plane_start - drag_origin).normalized()
			var b: Vector3 = (point - drag_origin).normalized()
			var raw = atan2(drag_world_axis.dot(a.cross(b)), a.dot(b))
			drag_angle_accumulated += wrapf(raw - drag_angle_previous, -PI, PI)
			drag_angle_previous = raw
			angle = drag_angle_accumulated * fine
		else:
			angle = screen_delta.dot(drag_rotation_tangent) / (Gizmo.PIXELS * gizmo.pixel_ratio) * fine
		if snap: angle = snappedf(angle, deg_to_rad(15))
		object.global_basis = Basis(drag_world_axis, angle) * drag_global_original.basis
		drag_hint = "d=%.1f deg" % rad_to_deg(angle)
	elif drag_tool == "scale":
		var amount = (screen_delta.x - screen_delta.y) / (Gizmo.PIXELS * gizmo.pixel_ratio) if handle.kind == "uniform" else screen_delta.dot(drag_screen_axis) / drag_screen_length
		var factor = maxf(.0001, 1 + amount * fine)
		if snap: factor = maxf(.1, snappedf(factor, .1))
		var previous = Factory.vec(drag_before.local_transform.scale if hierarchy_editor.active() else drag_before.get("local_transform",drag_before).scale)
		var minimum = .0001 if hierarchy_editor.active() else .1
		var maximum = 10000.0 if hierarchy_editor.active() else 5.0
		var next = previous
		if handle.kind == "uniform":
			# Clamp one shared factor to preserve all original component ratios.
			factor = clampf(factor, minimum / minf(previous.x, minf(previous.y, previous.z)), maximum / maxf(previous.x, maxf(previous.y, previous.z)))
			next *= factor
		else:
			next[handle.axis] = clampf(previous[handle.axis] * factor, minimum, maximum)
		object.basis = drag_original.basis.orthonormalized() * Basis.from_scale(next)
		drag_hint = "s=(%.2f, %.2f, %.2f)" % [next.x, next.y, next.z]
	update_helpers()
	if elapsed - last_drag_emit > .04: emit_transform("preview")

func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT or what == NOTIFICATION_WM_WINDOW_FOCUS_OUT:
		cancel_drag()
		if world_client!=null: world_client.set_focused(false)
	elif what == NOTIFICATION_APPLICATION_FOCUS_IN or what == NOTIFICATION_WM_WINDOW_FOCUS_IN:
		if world_client!=null: world_client.set_focused(true)

func emit_transform(phase: String) -> void:
	if not objects.has(drag_id): return
	last_drag_emit = elapsed
	var packet = scene_observation(drag_id)
	if hierarchy_editor.active() and phase=="commit":
		if packet.local_transform==null or not Hierarchy.valid_matrix(packet.world_matrix):
			manipulated_object(drag_id).transform=drag_original
			packet=Hierarchy.observation(drag_id,objects[drag_id],definitions[drag_id])
			phase="cancel"
			emit_error("local_trs_unrepresentable","The world rotation would require a sheared local transform; the source pose was retained.",applied_seq,drag_id)
		else:hierarchy_editor.record_commit(drag_id)
	packet.merge({"type": "transform", "phase": phase, "id": drag_id, "document_id": document_id, "seq": applied_seq, "before": drag_before.duplicate(true), "tool": drag_tool, "handle": drag_handle})
	emit(packet)

func clear_drag() -> void:
	drag_handle = ""
	drag_tool = ""
	drag_id = ""
	drag_before = {}
	drag_hint = ""
	if gizmo != null: gizmo.highlight("", "")

func cancel_drag() -> void:
	var was_navigating=not navigation.is_empty()
	editor_navigation.reset()
	last_speed_multiplier=1.0
	if not drag_handle.is_empty() and objects.has(drag_id):
		manipulated_object(drag_id).transform = drag_original
		emit_transform("cancel")
	clear_drag()
	button_down = 0
	navigation = ""
	orbit_pivot = null
	update_helpers()
	if was_navigating and applied_seq>=0: emit_camera()

func emit_camera() -> void:
	last_camera_emit = elapsed
	emit({"type": "camera", "document_id": document_id, "seq": applied_seq, "position": Factory.array3(camera.position), "target": Factory.array3(target), "camera_speed": camera_speed,"speed_multiplier":last_speed_multiplier,"navigation":navigation,"sensitivity":editor_navigation.sensitivity,"response":"smooth" if editor_navigation.response>0 else "direct", "dimension":"3d", "distance": distance, "yaw": yaw, "pitch": pitch, "view": camera_view, "projection": "orthographic" if camera.projection == Camera3D.PROJECTION_ORTHOGONAL else "perspective"})

func navigation_active() -> bool:
	return not navigation.is_empty() or editor_navigation.active(elapsed)

func emit_ready() -> void:
	emit({"type": "ready", "seq": applied_seq, "capabilities": ["glb", "xyz", "euler_degrees", "scale_xyz", "triangle_pick", "translate_gizmo", "plane_gizmo", "rotate_gizmo", "scale_gizmo", "editor_tools", "snap", "history", "orbit", "pan", "fly", "fit", "focus", "camera_presets"]+Capabilities.read().get("features",[]), "runtime_capabilities":Capabilities.read(), "runtime_version": VERSION, "mode": mode})

func emit_error(code: String, detail: String, seq: int, object_id: String = "") -> void:
	var packet = {"type": "error", "code": code, "error": detail, "seq": seq, "id": object_id, "document_id": document_id, "retained_seq": applied_seq, "recoverable": true}
	emit(packet)
	print("PREVIEW_REJECTED " + JSON.stringify(packet))
	if cli_args.has("quit-on-loaded"): get_tree().quit(2)

func emit(packet: Dictionary) -> void:
	packet.merge({"source": "world-atelier-preview", "nonce": nonce, "runtime_version": VERSION}, true)
	outbound_log.append(packet.duplicate(true))
	if outbound_log.size() > 100: outbound_log.pop_front()
	if bridge: bridge.send(JSON.stringify(packet))
	if cli_args.has("report"):
		var file = FileAccess.open(str(cli_args.report), FileAccess.WRITE)
		file.store_string(JSON.stringify(outbound_log, "\t"))

func capture() -> void:
	await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var code = get_viewport().get_texture().get_image().save_png(str(cli_args.capture))
	print("PREVIEW_CAPTURE " + error_string(code))
	if cli_args.has("quit-on-loaded"): get_tree().quit(0 if code == OK else 2)
