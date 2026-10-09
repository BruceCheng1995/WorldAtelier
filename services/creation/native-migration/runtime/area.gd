extends Area3D
@export var enabled: bool = true
@export_enum("trigger", "interactable") var component_kind: String = "trigger"
@export_enum("sphere", "box") var shape_kind: String = "sphere"
@export var radius: float = 1.0
@export var box_size: Vector3 = Vector3(2, 2, 2)
@export var shape_offset: Vector3 = Vector3.ZERO
@export var interaction_label: String = ""

func _ready() -> void:
	if Engine.is_editor_hint() or not enabled:
		collision_layer = 0
		monitoring = false
		return
	var original: Node3D = get_parent()
	var source_transform = original.global_transform
	var source_scale = source_transform.basis.get_scale()
	var shape: Shape3D
	if shape_kind == "box":
		shape = BoxShape3D.new()
		shape.size = box_size * source_scale
	else:
		shape = SphereShape3D.new()
		shape.radius = radius * maxf(source_scale.x, maxf(source_scale.y, source_scale.z))
	get_node("Shape").shape = shape
	top_level = true
	global_transform = Transform3D(source_transform.basis.orthonormalized(), source_transform * shape_offset)
	collision_layer = 4 if component_kind == "trigger" else 0
	collision_mask = 2
	monitoring = true
	monitorable = false
