extends RefCounted
## Preview-only recording of observed visual properties. Never executes or
## rewinds gameplay callbacks, infers script expressions, or writes source files.
const DURATION = 3.0
const INTERVAL = 1.0 / 30.0
const MAX_TRACKS = 512
const MAX_VISITED = 4096
var root: Node
var tracks: Array = []
var player: AnimationPlayer
var elapsed = 0.0
var next_sample = 0.0
var grace = 0.0
var status = "idle"
var truncated = false
var visited = 0

func clear() -> void:
	if is_instance_valid(player):
		if player.get_parent() != null: player.get_parent().remove_child(player)
		player.queue_free()
	player = null
	tracks.clear()
	root = null
	status = "idle"

func begin(scene: Node) -> void:
	clear()
	root = scene
	elapsed = 0.0
	next_sample = 0.0
	grace = 0.0
	truncated = false
	status = "recording"

func observation() -> Dictionary:
	return {"status":status, "time":elapsed, "duration":DURATION, "truncated":truncated}

func valid() -> bool:
	if not is_instance_valid(root) or not root.is_inside_tree(): return false
	for row in tracks:
		if not is_instance_valid(row.node) or root.get_node_or_null(row.path) != row.node: return false
	return true

func update(delta: float, paused: bool) -> bool:
	if status == "ready" and (not valid() or not is_instance_valid(player) or not player.is_inside_tree()):
		clear()
		status = "invalidated"
		return true
	if status != "recording" or paused: return false
	if not is_instance_valid(root):
		clear()
		return true
	# Let deferred native initialization create its real subject before sampling.
	grace += delta
	if grace < 0.25: return false
	if tracks.is_empty() and elapsed == 0.0:
		var subject: Node = root.get_node_or_null("Subject")
		if root.has_method("atelier_preview_subject"):
			var declared = root.call("atelier_preview_subject")
			if declared is Node and is_instance_valid(declared) and (declared == root or root.is_ancestor_of(declared)): subject = declared
		visited = 0
		_scan(subject if is_instance_valid(subject) else root)
		_sample(0.0)
	if not valid():
		clear()
		status = "invalidated"
		return true
	elapsed = minf(elapsed + delta, DURATION)
	if elapsed >= next_sample or elapsed >= DURATION:
		_sample(elapsed)
		next_sample = elapsed + INTERVAL
	if elapsed < DURATION: return false
	_finish()
	return true

func _add(node: Node, property: String, kind: int = Animation.TYPE_VALUE, suffix: String = "") -> void:
	if tracks.size() >= MAX_TRACKS:
		truncated = true
		return
	tracks.append({"node":node, "path":root.get_path_to(node), "property":NodePath(property), "kind":kind, "suffix":suffix, "times":[], "values":[], "changed":false})

func _scan(node: Node) -> void:
	visited += 1
	if visited > MAX_VISITED:
		truncated = true
		return
	# Cameras, lights and UI are preview context, never subject animation tracks.
	if node is Control or node is CanvasLayer or node is Camera2D or node is Camera3D or node is Light3D or node is Light2D or node is WorldEnvironment: return
	if node is Node3D:
		if not node.is_visible_in_tree(): return
		_add(node, "transform")
		_add(node, "visible")
	elif node is Node2D:
		if not node.is_visible_in_tree(): return
		_add(node, "transform")
		_add(node, "modulate")
		_add(node, "visible")
	if node is Sprite2D or node is Sprite3D or node is AnimatedSprite2D or node is AnimatedSprite3D: _add(node, "frame")
	if node is Skeleton3D:
		for bone in range(mini(node.get_bone_count(), int(MAX_TRACKS / 3))):
			var suffix = ":" + node.get_bone_name(bone)
			_add(node, "bones/%d/position" % bone, Animation.TYPE_POSITION_3D, suffix)
			_add(node, "bones/%d/rotation" % bone, Animation.TYPE_ROTATION_3D, suffix)
			_add(node, "bones/%d/scale" % bone, Animation.TYPE_SCALE_3D, suffix)
	if node is MeshInstance3D:
		for shape in range(mini(node.get_blend_shape_count(), MAX_TRACKS)):
			_add(node, "blend_shapes/" + str(node.mesh.get_blend_shape_name(shape)), Animation.TYPE_BLEND_SHAPE, ":" + str(node.mesh.get_blend_shape_name(shape)))
	for child in node.get_children():
		if visited >= MAX_VISITED or tracks.size() >= MAX_TRACKS:
			truncated = true
			break
		_scan(child)

func _sample(time: float) -> void:
	for row in tracks:
		var value = row.node.get_indexed(row.property)
		if not row.values.is_empty():
			if not is_same(value, row.values[0]): row.changed = true
		row.times.append(time)
		row.values.append(value)

func _finish() -> void:
	var clip = Animation.new()
	clip.length = elapsed
	# A recording is not proof of a natural cycle; do not invent loop semantics.
	clip.loop_mode = Animation.LOOP_NONE
	var changed: Array = []
	for row in tracks:
		if not row.changed: continue
		changed.append(row)
		var index = clip.add_track(row.kind)
		var suffix = ":" + str(row.property) if row.kind == Animation.TYPE_VALUE else row.suffix
		clip.track_set_path(index, NodePath(str(row.path) + suffix))
		if row.values[0] is int or row.values[0] is bool: clip.track_set_interpolation_type(index, Animation.INTERPOLATION_NEAREST)
		for key in range(row.times.size()): clip.track_insert_key(index, row.times[key], row.values[key])
	tracks = changed
	if tracks.is_empty():
		status = "empty"
		return
	player = AnimationPlayer.new()
	player.name = "AtelierCapturedMotion"
	player.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL
	player.set_meta("atelier_procedural_capture", true)
	var library = AnimationLibrary.new()
	library.add_animation("程序动画 · 捕获", clip)
	player.add_animation_library("", library)
	root.add_child(player)
	status = "ready"
