extends StaticBody3D
## Preserve legacy world-space concave collision, including nonuniform scale
## and natural world shear, using the actual native model node geometry.
@export var enabled: bool = true
@export_enum("trimesh", "box") var shape_kind: String = "trimesh"
@export var box_size: Vector3 = Vector3.ONE
@export var shape_offset: Vector3 = Vector3.ZERO

func _ready() -> void:
	if Engine.is_editor_hint() or not enabled:
		collision_layer = 0
		return
	var original: Node3D = get_parent()
	var faces = PackedVector3Array()
	if shape_kind == "box":
		var mesh = BoxMesh.new()
		mesh.size = box_size
		var source_transform = original.global_transform.translated_local(shape_offset)
		for vertex in mesh.get_faces():
			faces.append(source_transform * vertex)
	else:
		var model = original.get_node_or_null("__Model")
		if model != null:
			_collect_faces(model, faces)
	top_level = true
	global_transform = Transform3D.IDENTITY
	if faces.is_empty():
		collision_layer = 0
		return
	var shape = ConcavePolygonShape3D.new()
	shape.set_faces(faces)
	var collision: CollisionShape3D = get_node("Shape")
	collision.shape = shape
	collision_layer = 1

func _collect_faces(node: Node, faces: PackedVector3Array) -> void:
	if node is MeshInstance3D and node.mesh != null:
		for vertex in node.mesh.get_faces():
			faces.append(node.global_transform * vertex)
	for child in node.get_children():
		_collect_faces(child, faces)
