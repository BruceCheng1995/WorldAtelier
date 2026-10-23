extends Node
## Passive, bounded observation of the actual authored game. Never invokes an
## author method, changes properties, injects input or writes source files.
const PROTOCOL = "wa-play-context-1"
const MAX_NODES = 256
const MAX_SCAN = 2048
const MAX_NODE_BYTES = 8192
const MAX_SNAPSHOT_BYTES = 192 * 1024
var runtime: Node
var debug: Node
var sequence = 0
var elapsed = 0.0
var last_motion_ms = 0
var last_text_ms = 0
var last_generation = -1
var last_mode = ""
var last_fault = ""
var enabled = false
var snapshot_busy = false
var safe_remaining = 0

func setup(owner_runtime: Node, owner_debug: Node) -> void:
	runtime = owner_runtime
	debug = owner_debug
	process_mode = Node.PROCESS_MODE_ALWAYS
	set_process_input(true)
	enabled = true

func _active() -> bool:
	return enabled and is_instance_valid(runtime) and is_instance_valid(debug) and debug.started and runtime.running

func _runtime_id() -> String:
	return str(debug.nonce) if not str(debug.nonce).is_empty() else str(debug.world_id)

func _node_id(node: Node) -> String:
	return "node-" + str(runtime.generation) + "-" + str(node.get_instance_id())

func _emit(kind: String, payload: Dictionary, request_id: String = "") -> void:
	if not _active(): return
	sequence += 1
	debug.emit({"type":"play_context", "protocol":PROTOCOL, "kind":kind, "request_id":request_id,
		"runtime_instance_id":_runtime_id(), "source_revision":runtime.release.get("revision", ""),
		"resource_id":runtime.current_scene_id, "scene_generation":runtime.generation,
		"document_id":debug.document_id, "seq":debug.seq, "sequence":sequence,
		"engine_time_ms":Time.get_ticks_msec(), "tick":runtime.simulation.tick if is_instance_valid(runtime.simulation) else 0,
		"payload":payload})

func _event(kind: String, payload: Dictionary, source: String = "user_input") -> void:
	_emit("event", {"kind":kind, "source":source, "payload":payload})

func _process(delta: float) -> void:
	if not _active(): return
	var mode = "inspect" if debug.inspecting else "play"
	if last_mode != mode:
		last_mode = mode
		_event("mode_changed", {"mode":mode}, "engine_observation")
	if last_generation != int(runtime.generation):
		last_generation = int(runtime.generation)
		_event("scene_changed", {"resource_id":runtime.current_scene_id}, "engine_observation")
		elapsed = 1.0
	var fault = str(runtime.failure).left(2000)
	if fault != last_fault:
		last_fault = fault
		if not fault.is_empty(): _event("runtime_fault", {"message":fault}, "engine_observation")
	elapsed += minf(delta, 1.0)
	if elapsed >= 1.0:
		elapsed = 0.0
		snapshot()

func receive(packet: Dictionary) -> void:
	if not _active() or packet.get("type") != "context_request": return
	if packet.get("scene_generation") != runtime.generation or packet.get("seq") != debug.seq or packet.get("document_id") != debug.document_id: return
	var request_id = str(packet.get("request_id", ""))
	if request_id.is_empty() or request_id.length() > 180: return
	if packet.get("action") == "snapshot": snapshot(request_id)

func _input(event: InputEvent) -> void:
	if not _active() or debug.inspecting: return
	var viewport_size = get_viewport().get_visible_rect().size
	var now = Time.get_ticks_msec()
	var focus = get_viewport().gui_get_focus_owner()
	if event is InputEventKey:
		if event.echo: return
		if focus is LineEdit or focus is TextEdit:
			# Record only the existence of text interaction, never typed characters,
			# key codes, clipboard text, composition buffers or field contents.
			if event.pressed and now - last_text_ms >= 1000:
				last_text_ms = now
				_event("text_input", {"field_type":focus.get_class(), "runtime_id":_node_id(focus), "redacted":true})
			return
		var code = event.physical_keycode if event.physical_keycode != 0 else event.keycode
		_event("key_down" if event.pressed else "key_up", {"key":OS.get_keycode_string(code).left(40), "shift":event.shift_pressed, "ctrl":event.ctrl_pressed, "alt":event.alt_pressed, "meta":event.meta_pressed})
	elif event is InputEventMouseButton:
		_event("pointer_down" if event.pressed else "pointer_up", {"button":event.button_index, "position":_normalized(event.position, viewport_size), "double_click":event.double_click})
	elif event is InputEventMouseMotion:
		if now - last_motion_ms < 100: return
		last_motion_ms = now
		_event("pointer_move", {"position":_normalized(event.position, viewport_size), "buttons":event.button_mask})
	elif event is InputEventScreenTouch:
		_event("pointer_down" if event.pressed else "pointer_up", {"touch_index":event.index, "position":_normalized(event.position, viewport_size)})
	elif event is InputEventScreenDrag:
		if now - last_motion_ms < 100: return
		last_motion_ms = now
		_event("pointer_move", {"touch_index":event.index, "position":_normalized(event.position, viewport_size)})

func _normalized(point: Vector2, size: Vector2) -> Array:
	return [clampf(point.x/maxf(size.x, 1.0), 0.0, 1.0), clampf(point.y/maxf(size.y, 1.0), 0.0, 1.0)]

func snapshot(request_id: String = "") -> void:
	if not _active() or snapshot_busy: return
	snapshot_busy = true
	var scene: Node = runtime.game_scene if is_instance_valid(runtime.game_scene) else get_tree().current_scene
	var objects: Array = []
	var indexed: Dictionary = {}
	var indexed_examined = 0
	var index_truncated = false
	if is_instance_valid(runtime.projection):
		for key in runtime.projection.objects:
			if indexed_examined >= MAX_SCAN:
				index_truncated = true
				break
			indexed_examined += 1
			var indexed_node = runtime.projection.objects[key]
			if is_instance_valid(indexed_node): indexed[indexed_node.get_instance_id()] = runtime.projection.definitions.get(key, {})
	var queue: Array = [{"node":scene, "prefab":""}] if is_instance_valid(scene) else []
	var scanned = 0
	var input_regions: Array = []
	var objects_truncated = false
	var scan_overflow = false
	var maximum_pending = queue.size()
	var observation_bytes = 0
	while not queue.is_empty() and scanned < MAX_SCAN:
		var entry: Dictionary = queue.pop_front()
		var node: Node = entry.node
		if not is_instance_valid(node) or not node.is_inside_tree(): continue
		scanned += 1
		var prefab: String = str(entry.prefab)
		if node != scene and not node.scene_file_path.is_empty(): prefab = node.scene_file_path
		if node is LineEdit or node is TextEdit:
			if node.is_visible_in_tree():
				var input_bounds = _screen_bounds(node)
				if not input_bounds.is_empty(): input_regions.append(input_bounds)
		if objects.size() < MAX_NODES and not objects_truncated:
			var observed = _observe_node(node, scene, indexed.get(node.get_instance_id(), {}), prefab)
			var bytes = JSON.stringify(observed).to_utf8_buffer().size()
			if bytes > MAX_NODE_BYTES:
				observed.erase("observed_values")
				observed["observation_truncated"] = true
				bytes = JSON.stringify(observed).to_utf8_buffer().size()
			if observation_bytes + bytes <= MAX_SNAPSHOT_BYTES:
				objects.append(observed)
				observation_bytes += bytes
			else: objects_truncated = true
		else: objects_truncated = true
		# A wide parent cannot allocate an unbounded temporary child queue. Inspect
		# at most the remaining scan budget using get_child(), not get_children().
		var room = maxi(0, MAX_SCAN - scanned - queue.size())
		var child_count = node.get_child_count()
		if child_count > room: scan_overflow = true
		for child_index in mini(child_count, room): queue.append({"node":node.get_child(child_index), "prefab":prefab})
		maximum_pending = maxi(maximum_pending, queue.size())
	var camera = get_viewport().get_camera_3d()
	var camera_data: Dictionary = {"dimension":"2d", "viewport_size":[get_viewport().get_visible_rect().size.x, get_viewport().get_visible_rect().size.y]}
	if is_instance_valid(camera):
		camera_data = {"dimension":"3d", "position":_vec3(camera.global_position), "projection":"perspective" if camera.projection == Camera3D.PROJECTION_PERSPECTIVE else "orthographic", "fov":camera.fov, "size":camera.size, "near":camera.near, "far":camera.far, "viewport_size":[get_viewport().get_visible_rect().size.x, get_viewport().get_visible_rect().size.y]}
	_emit("snapshot", {"objects":objects, "camera":camera_data, "truncated":objects_truncated or scan_overflow or not queue.is_empty(), "scanned_nodes":scanned,
		"maximum_pending_nodes":maximum_pending,"indexed_nodes":indexed.size(),"index_truncated":index_truncated,"observation_bytes":observation_bytes,
		"text_input_regions":input_regions.slice(0,64), "input_regions_complete":not scan_overflow and queue.is_empty() and input_regions.size() <= 64,
		"scene_generation":runtime.generation, "resource_id":runtime.current_scene_id, "mode":"inspect" if debug.inspecting else "play", "runtime_fault":str(runtime.failure).left(2000),
		"observation_policy":"Built-in spatial/UI values and explicit wa_observation metadata only; no arbitrary author methods or script-property getters."}, request_id)
	snapshot_busy = false

func _observe_node(node: Node, scene: Node, source: Dictionary, prefab: String) -> Dictionary:
	var result: Dictionary = {"runtime_id":_node_id(node), "name":str(node.name).left(160), "native_type":node.get_class(),
		"native_node_path":str(scene.get_path_to(node)).left(512), "parent_runtime_id":_node_id(node.get_parent()) if node != scene and is_instance_valid(node.get_parent()) else null,
		"source":{}, "mapping":"runtime_only", "visible":true}
	if not source.is_empty() and source.get("address") is Dictionary:
		var address = _bounded_address(source.address)
		if not address.is_empty():
			result.source = {"address":address, "object_version":str(source.get("object_version", source.get("version", ""))).left(180)}
			result.mapping = "exact_source"
		else: result.source_unavailable_reason = "source_address_budget"
	elif not prefab.is_empty() and prefab.length() <= 1024:
		result.source = {"prefab_path":prefab, "definition_node_id":str(node.get_meta("wa_node_id", "")).left(180)}
		result.mapping = "spawned_from_prefab"
	var script = node.get_script()
	if script is Script: result.script_path = str(script.resource_path).left(512)
	if node is Node3D:
		result.position = _vec3(node.global_position)
		result.world_matrix = _matrix(node.global_transform)
		result.dimension = "3d"
		result.visible = node.is_visible_in_tree()
	elif node is CanvasItem:
		var transform: Transform2D = node.get_global_transform_with_canvas()
		result.position = [transform.origin.x, transform.origin.y]
		result.canvas_transform = [transform.x.x, transform.x.y, transform.y.x, transform.y.y, transform.origin.x, transform.origin.y]
		result.dimension = "2d"
		result.visible = node.is_visible_in_tree()
	if node is Control:
		result.control = {"size":[node.size.x, node.size.y], "mouse_filter":node.mouse_filter, "has_focus":node.has_focus()}
		if node is BaseButton: result.control.disabled = node.disabled
		if node is Label or node is RichTextLabel or node is Button: result.control.text = str(node.text).left(500)
		if node is LineEdit or node is TextEdit: result.control.text = "[input content not captured]"
	var bounds = _screen_bounds(node)
	if not bounds.is_empty(): result.screen_bounds = bounds
	# This opt-in metadata is author-reported plain data, never evaluated code.
	# Reading arbitrary exported fields could execute custom getters, so do not.
	if node.has_meta("wa_observation"):
		safe_remaining = 128
		result.observed_values = _safe(node.get_meta("wa_observation"))
		result.observed_values_source = "author_reported"
	return result

func _screen_bounds(node: Node) -> Array:
	var viewport_size = get_viewport().get_visible_rect().size
	var rect = Rect2()
	var found = false
	if node is Control:
		rect = node.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, node.size)
		found = true
	elif node is Sprite2D:
		rect = node.get_global_transform_with_canvas() * node.get_rect()
		found = true
	elif node is MeshInstance3D and node.mesh != null:
		var camera = get_viewport().get_camera_3d()
		if is_instance_valid(camera):
			var bounds = node.get_aabb()
			for index in range(8):
				var point = node.global_transform * bounds.get_endpoint(index)
				if camera.is_position_behind(point): continue
				var projected = camera.unproject_position(point)
				rect = rect.expand(projected) if found else Rect2(projected, Vector2.ZERO)
				found = true
	if not found or viewport_size.x <= 0 or viewport_size.y <= 0: return []
	rect = rect.intersection(Rect2(Vector2.ZERO, viewport_size))
	if rect.size.x <= 0 or rect.size.y <= 0: return []
	return [rect.position.x/viewport_size.x, rect.position.y/viewport_size.y, rect.size.x/viewport_size.x, rect.size.y/viewport_size.y]

func _vec3(value: Vector3) -> Array: return [value.x, value.y, value.z]
func _bounded_address(value: Dictionary) -> Dictionary:
	var result: Dictionary = {}
	for key in ["project_id", "branch_id", "resource_id", "definition_node_id"]:
		if not value.get(key) is String or str(value[key]).length() > 180: return {}
		result[key] = value[key]
	var chain = value.get("instance_path")
	if not chain is Array or chain.size() > 32: return {}
	for entry in chain:
		if not entry is String or entry.length() > 180: return {}
	result.instance_path = chain.duplicate()
	return result if JSON.stringify(result).to_utf8_buffer().size() <= 4096 else {}
func _matrix(value: Transform3D) -> Array:
	return [value.basis.x.x,value.basis.x.y,value.basis.x.z,0,value.basis.y.x,value.basis.y.y,value.basis.y.z,0,value.basis.z.x,value.basis.z.y,value.basis.z.z,0,value.origin.x,value.origin.y,value.origin.z,1]

func _safe(value: Variant, depth: int = 0) -> Variant:
	if depth > 4 or safe_remaining <= 0: return null
	safe_remaining -= 1
	if value == null or value is bool or value is int: return value
	if value is float: return value if is_finite(value) and absf(value) <= 1.0e12 else null
	if value is String or value is StringName: return str(value).left(512)
	if value is Dictionary:
		var result: Dictionary = {}
		var key_count = 0
		for key in value:
			if safe_remaining <= 0 or key_count >= 32: break
			key_count += 1
			if str(key) in ["__proto__", "prototype", "constructor"]: continue
			result[str(key).left(128)] = _safe(value[key], depth+1)
		return result
	if value is Array:
		var result: Array = []
		for item in value.slice(0, 32):
			if safe_remaining <= 0: break
			result.append(_safe(item, depth+1))
		return result
	if value is Vector2: return [value.x, value.y]
	if value is Vector3: return _vec3(value)
	return null # Resources, Objects, packed arrays and functions stay in-engine.
