extends Node
## Development-only controls over native prefab and authored preview scenes.
## Actions are declared locally; procedural capture records visual properties.
## This bridge never accepts an arbitrary remote Node method.
const SPEEDS = [0.25, 0.5, 1.0, 2.0]
const MAX_EVENTS = 100
const MAX_ANIMATIONS = 512
const MotionCapture = preload("procedural_animation_capture.gd")
var motion_capture = MotionCapture.new()
var runtime: Node
var debug: Node
var subject_id = ""
var resource_id = ""
var generation = -1
var scene_root: Node
var animations: Array = []
var actions: Array = []
var capabilities: Dictionary = {}
var players: Dictionary = {}
var events: Array = []
var event_sequence = 0
var speed = 1.0
var animation_speed = 1.0
var current: Dictionary = {}
var animation_time = 0.0
var animation_playing = false
var animation_direction = 1.0
var saved_player: Dictionary = {}
var saved_pose: Array = []
var last_usec = 0
var emit_elapsed = 0.0
var step_phase = 0
var step_request = ""
var step_start_tick = 0
var action_pending = false
var completed: Dictionary = {}
var catalog_truncated = false
var animation_catalog_elapsed = 0.0
var animation_catalog_sources: Array = []
var animation_catalog_dirty = true
var watched_animation_resources: Array = []
var automatic_animation_started = false
var plan_path = ""
var plan_report_path = ""
var plan_steps: Array = []
var plan_results: Array = []
var plan_error = ""
var plan_running = false
var plan_finished = false
var plan_started_usec = 0

func setup(value: Node, transport: Node) -> void:
	runtime = value
	debug = transport
	process_mode = Node.PROCESS_MODE_ALWAYS
	resource_id = str(runtime.release.prefab_test.get("resource_id", ""))
	subject_id = str(runtime.release.prefab_test.get("subject_id", ""))
	last_usec = Time.get_ticks_usec()
	get_tree().physics_frame.connect(_physics_boundary)
	_prepare_plan()

func scene_loaded() -> void:
	_end_animation(false)
	motion_capture.clear()
	_clear_animation_watches()
	automatic_animation_started = false
	step_phase = 0
	action_pending = false
	completed.clear()
	events.clear()
	event_sequence = 0
	generation = runtime.generation
	scene_root = runtime.game_scene
	if not _active(): return
	if scene_root.has_signal("atelier_preview_event"):
		var listener = Callable(self, "_scene_event")
		if not scene_root.is_connected("atelier_preview_event", listener): scene_root.connect("atelier_preview_event", listener)
	_catalog()
	_start_automatic_animation()
	if animations.is_empty(): motion_capture.begin(scene_root)
	_event({"kind":"lifecycle", "name":"ready"})
	emit_state()
	if not plan_path.is_empty() and not plan_running and not plan_finished: _run_plan.call_deferred()

func _active() -> bool:
	return is_instance_valid(runtime) and runtime.native_mode and runtime.shared == null and runtime.running and is_instance_valid(scene_root) and runtime.current_scene_id == resource_id and runtime.generation == generation and scene_root == runtime.game_scene

func _start_automatic_animation() -> void:
	if automatic_animation_started or not runtime.release.prefab_test.get("automatic", false): return
	var selected: Dictionary = {}
	for row in animations:
		if row.name == "RESET" or float(row.duration) <= 0.0: continue
		if selected.is_empty(): selected = row
		if "idle" in str(row.name).to_lower():
			selected = row
			break
	if selected.is_empty(): return
	automatic_animation_started = _select_animation({"player":selected.player, "animation":selected.name, "play":true})

func receive(packet: Dictionary) -> void:
	# No optional identity fields: a stale source, iframe/document or scene must
	# not turn a button press into an action against another live prefab.
	if not debug.started or not _active(): return
	if packet.get("source_revision") != runtime.release.get("revision") or packet.get("scene_generation") != generation or packet.get("seq") != debug.seq or packet.get("document_id") != debug.document_id: return
	var command = packet.get("command")
	if not command is Dictionary: return
	var request = str(command.get("request_id", command.get("id", packet.get("request_id", "")))).left(200)
	if not request.is_empty() and completed.has(request):
		debug.emit(completed[request].duplicate(true))
		return
	var action = str(command.get("action", ""))
	if action_pending or step_phase != 0:
		_result(request, false, "测试动作正在执行，请等待回执。", {}, false)
		return
	if runtime.faulted and action != "catalog":
		_result(request, false, "本次运行发生错误，请重新开始。")
		return
	match action:
		"capture_animation":
			_end_animation()
			debug.restore_inspection()
			motion_capture.begin(scene_root)
			_refresh_animations(true)
			_result(request, true)
		"catalog":
			_catalog()
			_result(request, true)
		"pause":
			debug.enter_inspection()
			_result(request, true)
		"resume":
			_end_animation()
			var resumed: bool = debug.restore_inspection()
			_result(request, resumed, "无法恢复运行。" if not resumed else "")
		"step":
			_end_animation()
			debug.enter_inspection()
			step_request = request
			step_start_tick = runtime.simulation.tick
			step_phase = 1
		"speed":
			var requested = command.get("speed")
			if not _valid_speed(requested):
				_result(request, false, "运行速度仅支持 0.25、0.5、1、2。")
				return
			speed = float(requested)
			Engine.time_scale = speed
			_result(request, true)
		"action":
			_run_action(request, command)
		"animation":
			_refresh_animations()
			var selected = _select_animation(command)
			_result(request, selected, "" if selected else "动画不存在，请刷新目录。")
		"seek":
			var value = command.get("time")
			if not _finite_number(value) or current.is_empty():
				_result(request, false, "请选择动画并提供有效的时间。")
				return
			animation_playing = false
			animation_direction = 1.0
			animation_time = clampf(float(value), 0.0, float(current.duration))
			_sample()
			_result(request, true)
		"animation_play":
			if current.is_empty():
				_result(request, false, "请先选择动画。")
				return
			if command.has("speed"):
				if not _valid_speed(command.speed):
					_result(request, false, "动画速度仅支持 0.25、0.5、1、2。")
					return
				animation_speed = float(command.speed)
			debug.enter_inspection()
			if animation_time >= float(current.duration): animation_time = 0.0
			animation_playing = true
			_result(request, true)
		"animation_pause":
			animation_playing = false
			_result(request, true)
		_:
			_result(request, false, "不支持的预制件测试命令。")

func _run_action(request: String, command: Dictionary) -> void:
	var id = str(command.get("action_id", ""))
	var declared = false
	for row in actions:
		if row.id == id: declared = true
	var parameters = command.get("parameters", {})
	if not declared or not scene_root.has_method("atelier_preview_action"):
		_result(request, false, "场景没有声明此测试动作。")
		return
	if not parameters is Dictionary or JSON.stringify(parameters).length() > 16384:
		_result(request, false, "动作参数必须是大小受限的对象。")
		return
	if scene_root.has_method("atelier_preview_selection"):
		var selection = scene_root.call("atelier_preview_selection")
		var blocked = selection.get("blocked_actions", {}) if selection is Dictionary else {}
		if blocked is Dictionary and blocked.get(id) is String and not blocked[id].is_empty():
			_result(request, false, str(blocked[id]).left(500))
			return
	_end_animation()
	action_pending = true
	var issued_generation = generation
	var result = scene_root.call("atelier_preview_action", id, parameters.duplicate(true))
	_event({"kind":"action", "name":id, "parameters":parameters})
	# Native runtime Logger reports script failures on the deferred queue.
	# Inspect that real failure before acknowledging the scene's return value.
	await get_tree().process_frame
	if not _active() or generation != issued_generation: return
	action_pending = false
	var ok = not runtime.faulted and not (result is Dictionary and result.get("ok") == false)
	var error = runtime.failure if runtime.faulted else str(result.get("error", "动作执行失败。")) if not ok and result is Dictionary else ""
	_result(request, ok, error, {"action_id":id, "value":_safe(result)})

func _physics_boundary() -> void:
	if step_phase == 0: return
	if not _active() or runtime.faulted:
		step_phase = 0
		return
	if step_phase == 1:
		# physics_frame is emitted before Godot processes native physics nodes.
		# Resume at this boundary and freeze at the next: one real solver tick,
		# including authored physics callbacks, timers and collision handling.
		debug.restore_inspection()
		step_phase = 2
		return
	debug.enter_inspection()
	step_phase = 0
	_event({"kind":"lifecycle", "name":"step", "ticks":runtime.simulation.tick - step_start_tick})
	_result(step_request, true, "", {"ticks":runtime.simulation.tick - step_start_tick})

func _catalog() -> void:
	actions.clear()
	capabilities.clear()
	if scene_root.has_method("atelier_preview_capabilities"):
		var declared = scene_root.call("atelier_preview_capabilities")
		if declared is Dictionary:
			for key in ["title", "description", "animation_note"]:
				if declared.get(key) is String: capabilities[key] = declared[key].left(2000)
		var entries = declared.get("actions", []) if declared is Dictionary else declared
		if entries is Array:
			var seen = {}
			for row in entries.slice(0, 64):
				if not row is Dictionary or not row.get("id") is String or row.id.is_empty() or seen.has(row.id): continue
				seen[row.id] = true
				var entry: Dictionary = _safe(row)
				# Legacy flat actions stay callable in scene tools. We cannot infer
				# intrinsic behavior from a label: damage and fixtures used this list too.
				var classified = entry.get("scope") in ["subject", "scene"] and entry.get("kind") in ["animation", "ability", "state", "controller", "passive", "fixture"]
				entry.legacy = not classified
				entry.kind = str(entry.get("kind", "fixture")) if classified else "fixture"
				entry.scope = "subject" if classified and entry.get("scope") == "subject" and not entry.kind in ["passive", "fixture"] else "scene"
				entry.mode = "select" if entry.get("mode") == "select" else "trigger"
				actions.append(entry)
	_refresh_animations(true)

func _animation_sources(node: Node, sources: Array) -> void:
	# Compare compact native identities; only rebuild track/key metadata when
	# the catalog changes, not for every moving projectile or playback frame.
	if node is AnimationPlayer:
		var path = str(scene_root.get_path_to(node))
		for name_value in node.get_animation_list():
			sources.append([node.get_instance_id(), path, str(name_value), node.get_animation(name_value).get_instance_id()])
	elif (node is AnimatedSprite2D or node is AnimatedSprite3D) and node.sprite_frames != null:
		var frames: SpriteFrames = node.sprite_frames
		var path = str(scene_root.get_path_to(node))
		# SpriteFrames name/speed/loop setters do not emit Resource.changed.
		for name_value in frames.get_animation_names():
			sources.append([node.get_instance_id(), path, frames.get_instance_id(), str(name_value), frames.get_animation_speed(name_value), frames.get_animation_loop(name_value)])
	for child in node.get_children(): _animation_sources(child, sources)

func _mark_animation_catalog_dirty() -> void:
	animation_catalog_dirty = true

func _watch_animation_resource(resource: Resource) -> void:
	if resource in watched_animation_resources: return
	resource.changed.connect(_mark_animation_catalog_dirty)
	watched_animation_resources.append(resource)

func _clear_animation_watches() -> void:
	for resource in watched_animation_resources:
		resource.changed.disconnect(_mark_animation_catalog_dirty)
	watched_animation_resources.clear()

func _refresh_animations(force: bool = false) -> void:
	var sources: Array = []
	_animation_sources(scene_root, sources)
	if not force and not animation_catalog_dirty and sources == animation_catalog_sources: return
	_clear_animation_watches()
	animation_catalog_sources = sources
	animation_catalog_dirty = false
	animations.clear()
	players.clear()
	catalog_truncated = false
	_scan(scene_root)
	if not current.is_empty():
		var found = false
		for row in animations:
			if row.player == current.player and row.name == current.name and row == current and _animation_target_valid(): found = true
		if not found: _end_animation()

func _scan(node: Node) -> void:
	if node is AnimationPlayer or node is AnimatedSprite2D or node is AnimatedSprite3D:
		var path = str(scene_root.get_path_to(node))
		players[path] = node
		if node is AnimationPlayer:
			for name_value in node.get_animation_list():
				if animations.size() >= MAX_ANIMATIONS:
					catalog_truncated = true
					break
				var clip: Animation = node.get_animation(name_value)
				_watch_animation_resource(clip)
				var tracks: Array = []
				for index in range(mini(clip.get_track_count(), 128)):
					var keys: Array = []
					for key in range(mini(clip.track_get_key_count(index), 256)): keys.append(clip.track_get_key_time(index, key))
					tracks.append({"index":index, "path":str(clip.track_get_path(index)), "type":clip.track_get_type(index), "enabled":clip.track_is_enabled(index), "key_count":clip.track_get_key_count(index), "keys":keys})
				animations.append({"player":path, "node_path":path, "kind":"ProceduralCapture" if node.get_meta("atelier_procedural_capture", false) else "AnimationPlayer", "name":str(name_value), "animation":str(name_value), "duration":clip.length, "loop":clip.loop_mode != Animation.LOOP_NONE, "loop_mode":clip.loop_mode, "track_count":clip.get_track_count(), "tracks":tracks})
		elif node.sprite_frames != null:
			var frames: SpriteFrames = node.sprite_frames
			_watch_animation_resource(frames)
			for name_value in frames.get_animation_names():
				if animations.size() >= MAX_ANIMATIONS:
					catalog_truncated = true
					break
				var fps = frames.get_animation_speed(name_value)
				var duration = 0.0
				var keys: Array = []
				for index in range(frames.get_frame_count(name_value)):
					if keys.size() < 256: keys.append(duration)
					duration += frames.get_frame_duration(name_value, index) / maxf(fps, 0.0001)
				animations.append({"player":path, "node_path":path, "kind":node.get_class(), "name":str(name_value), "animation":str(name_value), "duration":duration, "loop":frames.get_animation_loop(name_value), "loop_mode":1 if frames.get_animation_loop(name_value) else 0, "track_count":1, "tracks":[{"index":0, "path":path+":frame", "type":"frames", "enabled":true, "key_count":frames.get_frame_count(name_value), "keys":keys}]})
	for child in node.get_children(): _scan(child)

func _select_animation(command: Dictionary) -> bool:
	var wanted: Dictionary = {}
	for row in animations:
		if row.player == str(command.get("player", "")) and row.animation == str(command.get("animation", "")):
			wanted = row
			break
	if wanted.is_empty() or not is_instance_valid(players.get(wanted.player)): return false
	_end_animation()
	debug.enter_inspection()
	current = wanted.duplicate(true)
	animation_time = 0.0
	animation_playing = command.get("play", false) == true
	animation_direction = 1.0
	var node: Node = players[current.player]
	if node is AnimationPlayer:
		var assigned = str(node.assigned_animation)
		saved_player = {"node":node, "resource":node.get_animation(current.animation), "animation":assigned, "time":node.current_animation_position if node.is_animation_active() else 0.0, "playing":node.is_playing(), "active":node.active}
		_capture_pose(node, node.get_animation(current.animation))
	else:
		saved_player = {"node":node, "resource":node.sprite_frames, "animation":node.animation, "frame":node.frame, "progress":node.frame_progress, "playing":node.is_playing()}
	_sample()
	return true

func _animation_target_valid() -> bool:
	if current.is_empty(): return false
	if current.get("kind") == "ProceduralCapture" and not motion_capture.valid(): return false
	var node = players.get(current.player)
	if not is_instance_valid(node) or node != saved_player.get("node") or not node.is_inside_tree(): return false
	if scene_root.get_node_or_null(NodePath(current.player)) != node: return false
	if node is AnimationPlayer: return node.has_animation(current.animation) and node.get_animation(current.animation) == saved_player.get("resource")
	return node.sprite_frames != null and node.sprite_frames == saved_player.get("resource") and node.sprite_frames.has_animation(current.animation)

func _sample() -> void:
	if current.is_empty(): return
	var node = players.get(current.player)
	if not _animation_target_valid():
		_end_animation()
		return
	var was_blocked: bool = node.is_blocking_signals()
	node.set_block_signals(true)
	if node is AnimationPlayer:
		node.active = true
		node.pause()
		node.assigned_animation = current.animation
		# Godot 4.6 update_only explicitly skips method, audio and animation
		# playback tracks. Never call advance(), which can execute skill keys.
		node.seek(animation_time, true, true)
	else:
		node.pause()
		node.animation = current.animation
		var frames: SpriteFrames = node.sprite_frames
		var remaining = animation_time
		var count = frames.get_frame_count(current.animation)
		for index in range(count):
			var duration = frames.get_frame_duration(current.animation, index) / maxf(frames.get_animation_speed(current.animation), 0.0001)
			if remaining <= duration or index == count - 1:
				node.set_frame_and_progress(index, clampf(remaining / maxf(duration, 0.0001), 0.0, 1.0))
				break
			remaining -= duration
	node.set_block_signals(was_blocked)

func _capture_pose(player: AnimationPlayer, clip: Animation) -> void:
	var base = player.get_node_or_null(player.root_node)
	if base == null: return
	for index in range(clip.get_track_count()):
		if not clip.track_is_enabled(index): continue
		var kind = clip.track_get_type(index)
		if kind in [Animation.TYPE_METHOD, Animation.TYPE_AUDIO, Animation.TYPE_ANIMATION]: continue
		var path = clip.track_get_path(index)
		# Bone/blend-shape subnames are engine track identities, not Object
		# properties. Resolve their node first, preserving the native subname.
		var node = base.get_node_or_null(path)
		if node == null: continue
		if kind in [Animation.TYPE_POSITION_3D, Animation.TYPE_ROTATION_3D, Animation.TYPE_SCALE_3D]:
			if node is Skeleton3D and path.get_subname_count() > 0:
				var bone = node.find_bone(str(path.get_subname(0)))
				if bone >= 0: saved_pose.append({"node":node, "bone":bone, "value":node.get_bone_pose(bone)})
			elif node is Node3D: saved_pose.append({"node":node, "property":NodePath("transform"), "value":node.transform})
		elif kind == Animation.TYPE_BLEND_SHAPE and node is MeshInstance3D and path.get_subname_count() > 0:
			var shape = node.find_blend_shape_by_name(path.get_subname(0))
			if shape >= 0: saved_pose.append({"node":node, "shape":shape, "value":node.get_blend_shape_value(shape)})
		elif kind == Animation.TYPE_VALUE or kind == Animation.TYPE_BEZIER:
			var resolved = base.get_node_and_resource(path)
			if resolved[0] == null: continue
			var target = resolved[1] if resolved[1] != null else node
			var property: NodePath = resolved[2]
			if not property.is_empty(): saved_pose.append({"node":target, "property":property, "value":target.get_indexed(property)})

func _end_animation(restore: bool = true) -> void:
	animation_playing = false
	# Captured players are disposable record buffers, not authored controllers.
	# They may already be detached after invalidation: never seek their old paths
	# while restoring, since those paths could now belong to replacement nodes.
	if restore and current.get("kind") != "ProceduralCapture" and not saved_player.is_empty() and is_instance_valid(saved_player.node):
		var node = saved_player.node
		var was_blocked: bool = node.is_blocking_signals()
		node.set_block_signals(true)
		if node is AnimationPlayer:
			node.active = true
			if not str(saved_player.animation).is_empty() and node.has_animation(saved_player.animation):
				node.assigned_animation = saved_player.animation
				node.seek(saved_player.time, true, true)
				if saved_player.playing: node.play(saved_player.animation)
				else: node.pause()
			else: node.stop(true)
			node.active = saved_player.active
		else:
			if node.sprite_frames != null and node.sprite_frames.has_animation(saved_player.animation):
				node.animation = saved_player.animation
				node.set_frame_and_progress(saved_player.frame, saved_player.progress)
				if saved_player.playing: node.play(saved_player.animation)
				else: node.pause()
			else: node.pause()
		node.set_block_signals(was_blocked)
	if restore:
		for record in saved_pose:
			if not is_instance_valid(record.node): continue
			if record.has("bone"): record.node.set_bone_pose(record.bone, record.value)
			elif record.has("shape"): record.node.set_blend_shape_value(record.shape, record.value)
			else: record.node.set_indexed(record.property, record.value)
	saved_player.clear()
	saved_pose.clear()
	current.clear()
	animation_time = 0.0

func before_resume() -> void:
	_end_animation()

func _process(_delta: float) -> void:
	var now = Time.get_ticks_usec()
	var elapsed = minf(float(now - last_usec) / 1000000.0, 0.25)
	last_usec = now
	if not plan_path.is_empty() and not plan_finished:
		if runtime.faulted or (not runtime.loading and not str(runtime.failure).is_empty()):
			_finish_plan(false, runtime.failure)
			return
		if now - plan_started_usec > 45000000:
			_finish_plan(false, "测试计划超过 45 秒。")
			return
	if not _active() or not debug.started: return
	_advance_capture.call_deferred(_delta)
	animation_catalog_elapsed += elapsed
	if animation_catalog_elapsed >= 0.5:
		animation_catalog_elapsed = 0.0
		_refresh_animations()
		_start_automatic_animation()
	if animation_playing and not current.is_empty():
		animation_time += elapsed * animation_speed * animation_direction
		var duration = float(current.duration)
		if duration <= 0.0: animation_playing = false
		elif int(current.get("loop_mode", 0)) == Animation.LOOP_PINGPONG:
			while animation_time > duration or animation_time < 0.0:
				if animation_time > duration:
					animation_time = duration * 2.0 - animation_time
					animation_direction = -1.0
				elif animation_time < 0.0:
					animation_time = -animation_time
					animation_direction = 1.0
		elif animation_time >= duration:
			if current.loop: animation_time = fposmod(animation_time, duration)
			else:
				animation_time = duration
				animation_playing = false
		_sample()
	emit_elapsed += elapsed
	if emit_elapsed >= 0.1:
		emit_elapsed = 0.0
		emit_state()

func _advance_capture(delta: float) -> void:
	if not _active() or not debug.started: return
	if motion_capture.update(maxf(delta, 0.0), debug.inspecting):
		_refresh_animations(true)
		if motion_capture.status == "ready" and current.is_empty():
			for row in animations:
				if row.kind == "ProceduralCapture":
					_select_animation({"player":row.player, "animation":row.name, "play":true})
					break

func state() -> Dictionary:
	var observation = scene_root.call("atelier_preview_state") if is_instance_valid(scene_root) and scene_root.has_method("atelier_preview_state") else {}
	var selection: Dictionary = {"action_ids":[], "status":"", "blocked_actions":{}}
	if is_instance_valid(scene_root) and scene_root.has_method("atelier_preview_selection"):
		var selected = scene_root.call("atelier_preview_selection")
		if selected is Dictionary:
			selection.status = str(selected.get("status", "")).left(500)
			var ids = selected.get("action_ids", [])
			if ids is Array:
				for row in actions:
					if row.id in ids and row.mode == "select": selection.action_ids.append(row.id)
			var blocked = selected.get("blocked_actions", {})
			if blocked is Dictionary:
				for row in actions:
					if blocked.get(row.id) is String and not blocked[row.id].is_empty(): selection.blocked_actions[row.id] = blocked[row.id].left(500)
	return {"resource_id":resource_id, "subject_id":subject_id, "source_revision":runtime.release.get("revision"), "document_id":debug.document_id, "seq":debug.seq, "scene_generation":generation, "actions":actions, "capabilities":capabilities, "selection":selection, "animations":animations, "capture":motion_capture.observation(), "catalog_truncated":catalog_truncated, "current":current, "time":animation_time, "duration":current.get("duration", 0.0), "playing":animation_playing, "paused":debug.inspecting, "speed":speed, "animation_speed":animation_speed, "tick":runtime.simulation.tick if is_instance_valid(runtime.simulation) else 0, "observations":_safe(observation), "events":events, "event_sequence":event_sequence, "faulted":runtime.faulted, "error":runtime.failure}

func emit_state(request: String = "") -> void:
	if not debug.started or not _active(): return
	var packet = state()
	packet.type = "prefab_test_state"
	packet.request_id = request
	debug.emit(packet)

func _result(request: String, ok: bool, error: String = "", result: Dictionary = {}, remember: bool = true) -> void:
	var packet = {"type":"prefab_test_result", "request_id":request, "ok":ok, "error":error, "result":_safe(result), "resource_id":resource_id, "subject_id":subject_id, "source_revision":runtime.release.get("revision"), "document_id":debug.document_id, "seq":debug.seq}
	if remember and not request.is_empty():
		completed[request] = packet.duplicate(true)
		while completed.size() > 100: completed.erase(completed.keys()[0])
	debug.emit(packet)
	emit_state(request)

func _scene_event(value: Dictionary) -> void:
	if _active(): _event(value)

func _event(value: Dictionary) -> void:
	event_sequence += 1
	var entry = _safe(value)
	entry.merge({"sequence":event_sequence, "tick":runtime.simulation.tick if is_instance_valid(runtime.simulation) else 0, "time_ms":Time.get_ticks_msec()}, true)
	events.append(entry)
	while events.size() > MAX_EVENTS: events.pop_front()

func _finite_number(value: Variant) -> bool:
	return (value is int or value is float) and is_finite(float(value))

func _valid_speed(value: Variant) -> bool:
	return _finite_number(value) and float(value) in SPEEDS

func _prepare_plan() -> void:
	if OS.has_feature("web"): return
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--prefab-test-plan="): plan_path = argument.trim_prefix("--prefab-test-plan=")
		if argument.begins_with("--prefab-test-report="): plan_report_path = argument.trim_prefix("--prefab-test-report=")
	if plan_path.is_empty(): return
	plan_started_usec = Time.get_ticks_usec()
	# A local plan establishes a local command session, then uses the same
	# strict receive() path as the Web controls. It never invents engine ACKs.
	debug.started = true
	debug.world_id = "prefab-test:" + str(runtime.release.get("revision", "")) + ":" + resource_id
	debug.epoch = 1
	debug.seq = 1
	if not plan_path.begins_with("res://test_scenes/") or plan_path.contains("..") or plan_path.contains("\\") or not plan_path.ends_with(".json"):
		plan_error = "测试计划必须是 res://test_scenes/ 下的 JSON 文件。"
	elif plan_report_path.is_empty() or not plan_report_path.is_absolute_path() or plan_report_path.begins_with("res://") or plan_report_path.begins_with("user://"):
		plan_error = "测试报告需要显式的绝对输出路径。"
	elif not FileAccess.file_exists(plan_path):
		plan_error = "测试计划文件不存在。"
	else:
		var file = FileAccess.open(plan_path, FileAccess.READ)
		if file == null or file.get_length() > 262144:
			plan_error = "无法读取测试计划或文件超过 256 KB。"
		else:
			var parsed = JSON.parse_string(file.get_as_text())
			file.close()
			if not parsed is Dictionary or not parsed.get("steps") is Array or parsed.steps.is_empty() or parsed.steps.size() > 256:
				plan_error = "测试计划需要 1 到 256 个 steps。"
			else:
				var total_frames = 0
				for entry in parsed.steps:
					if not entry is Dictionary or entry.size() != 1:
						plan_error = "每一步必须仅包含 command、wait_frames 或 expect。"
						break
					if entry.has("wait_frames"):
						var count = entry.wait_frames
						if not _finite_number(count) or float(count) != floorf(float(count)) or int(count) < 0 or int(count) > 600:
							plan_error = "wait_frames 必须是 0 到 600 的整数。"
							break
						total_frames += int(count)
					elif entry.has("command"):
						if not entry.command is Dictionary:
							plan_error = "command 必须是对象。"
							break
					elif entry.has("expect"):
						if not entry.expect is Dictionary or not entry.expect.get("path") is String or not entry.expect.has("equals"):
							plan_error = "expect 必须包含 path 和 equals。"
							break
						if entry.expect.has("tolerance") and (not _finite_number(entry.expect.tolerance) or float(entry.expect.tolerance) < 0.0 or not _finite_number(entry.expect.equals)):
							plan_error = "数值比较 tolerance 必须是非负的有限数。"
							break
					else:
						plan_error = "不支持的测试计划步骤。"
						break
				if total_frames > 1800: plan_error = "测试计划合计不能超过 1800 帧。"
				if plan_error.is_empty(): plan_steps = parsed.steps
	if not plan_error.is_empty(): _finish_plan.call_deferred(false, plan_error)

func _run_plan() -> void:
	if plan_finished or not plan_error.is_empty(): return
	plan_running = true
	var bound_generation = generation
	for index in range(plan_steps.size()):
		if plan_finished: return
		if not _active() or generation != bound_generation or runtime.faulted:
			_finish_plan(false, runtime.failure if runtime.faulted else "测试场景在计划执行期间改变。")
			return
		var entry: Dictionary = plan_steps[index]
		var record = {"index":index, "step":entry.duplicate(true), "tick_before":runtime.simulation.tick, "ok":true}
		if entry.has("command"):
			var command: Dictionary = entry.command.duplicate(true)
			var request = "plan-" + str(index)
			command.request_id = request
			receive({"source_revision":runtime.release.get("revision"), "scene_generation":generation, "seq":debug.seq, "document_id":debug.document_id, "command":command})
			while not completed.has(request) and not plan_finished and _active() and not runtime.faulted:
				await get_tree().process_frame
			if plan_finished: return
			var response: Dictionary = completed.get(request, {"ok":false, "error":runtime.failure if runtime.faulted else "动作没有返回结果。"})
			record.result = response
			record.ok = response.get("ok", false)
		elif entry.has("wait_frames"):
			for frame in range(int(entry.wait_frames)):
				await get_tree().physics_frame
				if plan_finished: return
			# Observe after the last requested frame's native callbacks/solver.
			await get_tree().process_frame
		else:
			var actual = _state_path(state(), entry.expect.path)
			record.actual = _safe(actual.value)
			record.path_found = actual.found
			record.ok = actual.found and actual.value == entry.expect.equals
			if actual.found and entry.expect.has("tolerance") and _finite_number(actual.value): record.ok = absf(float(actual.value) - float(entry.expect.equals)) <= float(entry.expect.tolerance)
			if not record.ok: record.error = "观察值不符合预期：" + entry.expect.path
		if plan_finished: return
		record.tick_after = runtime.simulation.tick if is_instance_valid(runtime.simulation) else -1
		record.observations = state().observations if _active() else {}
		plan_results.append(record)
		if not record.ok:
			_finish_plan(false, str(record.get("error", record.get("result", {}).get("error", "测试步骤失败。"))))
			return
	# Let runtime Logger deliver errors raised by the final observation too.
	await get_tree().process_frame
	await get_tree().process_frame
	if plan_finished: return
	_finish_plan(not runtime.faulted and _active(), runtime.failure if runtime.faulted else "" if _active() else "测试场景已改变。")

func _state_path(snapshot: Dictionary, path: String) -> Dictionary:
	var value: Variant = snapshot
	if path.is_empty() or path.length() > 512: return {"found":false, "value":null}
	for part in path.split("."):
		if value is Dictionary and value.has(part): value = value[part]
		elif value is Array and part.is_valid_int() and int(part) >= 0 and int(part) < value.size(): value = value[int(part)]
		else: return {"found":false, "value":null}
	return {"found":true, "value":value}

func _finish_plan(ok: bool, error: String = "") -> void:
	if plan_finished: return
	plan_finished = true
	plan_running = false
	var report = {"format":"world-atelier-prefab-test-report-1", "ok":ok, "error":error, "source_revision":runtime.release.get("revision"), "runtime_source_hash":runtime.release.get("runtime_source_hash"), "entry_scene_id":runtime.launch_entry, "actual_scene_id":runtime.current_scene_id, "resource_id":resource_id, "subject_id":subject_id, "scene_generation":runtime.generation, "plan":plan_path, "steps":plan_results, "state":state() if _active() else {}, "runtime_fault":runtime.runtime_fault, "elapsed_ms":(Time.get_ticks_usec() - plan_started_usec) / 1000 if plan_started_usec > 0 else 0}
	if plan_report_path.is_absolute_path() and not plan_report_path.begins_with("res://") and not plan_report_path.begins_with("user://"):
		var parent_result = DirAccess.make_dir_recursive_absolute(plan_report_path.get_base_dir())
		var file = FileAccess.open(plan_report_path + ".tmp", FileAccess.WRITE) if parent_result == OK else null
		if file != null:
			file.store_string(JSON.stringify(report, "\t") + "\n")
			file.close()
			if DirAccess.rename_absolute(plan_report_path + ".tmp", plan_report_path) != OK:
				report.ok = false
				report.error = "无法保存测试报告。"
		else:
			report.ok = false
			report.error = "无法写入测试报告输出目录。"
	else:
		report.ok = false
		if str(report.error).is_empty(): report.error = "测试报告输出路径无效。"
	print("PREFAB_TEST_REPORT " + JSON.stringify(report))
	get_tree().quit(0 if report.ok else 1)

func _safe(value: Variant, depth: int = 0) -> Variant:
	if depth > 6: return null
	if value == null or value is bool or value is int: return value
	if value is float: return value if is_finite(value) else null
	if value is String or value is StringName: return str(value).left(4096)
	if value is Dictionary:
		var result = {}
		for key in value.keys().slice(0, 64): result[str(key).left(128)] = _safe(value[key], depth + 1)
		return result
	if value is Array:
		var result: Array = []
		for item in value.slice(0, 128): result.append(_safe(item, depth + 1))
		return result
	if value is Vector2: return [value.x, value.y]
	if value is Vector3: return [value.x, value.y, value.z]
	if value is Color: return [value.r, value.g, value.b, value.a]
	return str(value).left(512)

func _exit_tree() -> void:
	Engine.time_scale = 1.0
