extends Node3D
## Values retained from the legacy document. Legacy color did not tint GLBs;
## preserving it must not change imported materials at migration time.
@export var author_color: Color = Color("74d5cd")
@export var author_kind: String = "anchor"

func _ready() -> void:
	var model = get_node_or_null("__Model")
	if model != null:
		_private_materials(model)

func _private_materials(node: Node) -> void:
	# Presentation previously duplicated material resources per object.
	if node is MeshInstance3D:
		if node.mesh != null:
			node.mesh = node.mesh.duplicate(true)
		if node.material_override != null:
			node.material_override = node.material_override.duplicate(true)
		for index in range(node.get_surface_override_material_count()):
			var material = node.get_active_material(index)
			if material != null:
				node.set_surface_override_material(index, material.duplicate(true))
	for child in node.get_children():
		if child is Camera3D or child is Light3D:
			node.remove_child(child)
			child.queue_free()
		else:
			_private_materials(child)
