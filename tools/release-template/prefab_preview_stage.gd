extends Node
## One reusable preview scene. The caller supplies the actual fixed-source prefab.
@export var target_scene: PackedScene
var bounds = AABB()
var has_bounds = false
var bounds_2d = Rect2()
var has_bounds_2d = false

func _ready() -> void:
	if target_scene == null:
		push_error("预览场景缺少目标预制件")
		return
	var subject = target_scene.instantiate()
	subject.name = "Subject"
	add_child(subject)
	if $Subject is Node2D or $Subject is Control:
		_measure_2d($Subject)
		var camera = Camera2D.new()
		add_child(camera)
		camera.position = bounds_2d.get_center() if has_bounds_2d else $Subject.position
		_frame_2d(camera)
		get_viewport().size_changed.connect(_frame_2d.bind(camera))
		camera.make_current()
		return
	_measure($Subject)
	if not has_bounds: bounds = AABB(Vector3(-0.5, 0, -0.5), Vector3(1, 2, 1))
	var center = bounds.get_center()
	var radius = maxf(bounds.size.length() * 0.5, 0.25)
	var camera = Camera3D.new()
	add_child(camera)
	camera.position = center + Vector3(0.25, 0.12, 1).normalized() * radius * 2.8
	camera.near = maxf(0.001, radius * 0.005)
	camera.far = maxf(100.0, radius * 20.0)
	camera.look_at(center)
	camera.make_current()
	var light = DirectionalLight3D.new()
	light.rotation_degrees = Vector3(-35, -25, 0)
	add_child(light)
	var environment = WorldEnvironment.new()
	environment.environment = Environment.new()
	environment.environment.background_mode = Environment.BG_COLOR
	environment.environment.background_color = Color("202831")
	environment.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.environment.ambient_light_color = Color("dbe6ff")
	environment.environment.ambient_light_energy = 0.75
	add_child(environment)
	# Character controllers can resume on a real floor after clip inspection.
	var floor_body = StaticBody3D.new()
	var collision = CollisionShape3D.new()
	var shape = BoxShape3D.new()
	shape.size = Vector3(maxf(20, radius * 10), 0.1, maxf(20, radius * 10))
	collision.shape = shape
	floor_body.add_child(collision)
	add_child(floor_body)
	floor_body.position = Vector3(center.x, bounds.position.y - 0.05, center.z)

func _measure(node: Node) -> void:
	if node is MeshInstance3D and node.mesh != null:
		var box: AABB = node.global_transform * node.get_aabb()
		bounds = bounds.merge(box) if has_bounds else box
		has_bounds = true
	for child in node.get_children(): _measure(child)

func _measure_2d(node: Node) -> void:
	var rect = Rect2()
	if node is Sprite2D:
		rect = node.get_rect()
	elif node is AnimatedSprite2D and node.sprite_frames != null:
		var frames: SpriteFrames = node.sprite_frames
		if frames.has_animation(node.animation) and frames.get_frame_count(node.animation) > 0:
			var texture = frames.get_frame_texture(node.animation, 0)
			if texture != null:
				var size = texture.get_size()
				rect = Rect2(node.offset - size * 0.5 if node.centered else node.offset, size)
	elif node is Control:
		rect = Rect2(Vector2.ZERO, node.size)
	if rect.has_area():
		var world_rect: Rect2 = node.get_global_transform() * rect
		bounds_2d = bounds_2d.merge(world_rect) if has_bounds_2d else world_rect
		has_bounds_2d = true
	for child in node.get_children(): _measure_2d(child)

func _frame_2d(camera: Camera2D) -> void:
	if not has_bounds_2d: return
	var viewport_size = get_viewport().get_visible_rect().size
	var fit = minf(viewport_size.x / maxf(bounds_2d.size.x, 1), viewport_size.y / maxf(bounds_2d.size.y, 1)) * 0.6
	camera.zoom = Vector2.ONE * clampf(fit, 0.01, 20)
	# Clip inspection temporarily owns the viewport camera. Keep that camera
	# framed too when the timeline opens or the preview panel changes size.
	var active_camera = get_viewport().get_camera_2d()
	if active_camera != null and active_camera != camera:
		active_camera.zoom = camera.zoom

func atelier_preview_capabilities() -> Dictionary:
	if $Subject.has_method("atelier_preview_capabilities"):
		var value = $Subject.atelier_preview_capabilities()
		if value is Dictionary: return value
	return {}

func atelier_preview_selection() -> Dictionary:
	if $Subject.has_method("atelier_preview_selection"):
		var value = $Subject.atelier_preview_selection()
		if value is Dictionary: return value
	return {}

func atelier_preview_action(action_id: String, parameters: Dictionary) -> Dictionary:
	if $Subject.has_method("atelier_preview_action"):
		var value = $Subject.atelier_preview_action(action_id, parameters)
		return value if value is Dictionary else {"ok":true}
	return {"ok":false, "error":"预制件未声明此能力"}

func atelier_preview_state() -> Dictionary:
	if $Subject.has_method("atelier_preview_state"):
		var value = $Subject.atelier_preview_state()
		if value is Dictionary: return value
	return {"主体":$Subject.name}
