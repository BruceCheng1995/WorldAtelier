@tool
extends Node3D

@export var stable_id: String = ""
@export var display_name: String = "Object":
	set(value):
		display_name = value
		refresh.call_deferred()
@export var object_kind: String = "rock"
@export var object_color: Color = Color("8db5ca"):
	set(value):
		object_color = value
		refresh.call_deferred()
@export var solid: bool = true:
	set(value):
		solid = value
		refresh.call_deferred()
@export var model_asset: String = "":
	set(value):
		model_asset = value
		refresh.call_deferred()
@export_storage var source_json: String = "{}"

func _ready() -> void:
	refresh()

func refresh() -> void:
	if not is_inside_tree(): return
	for child in get_children():
		remove_child(child)
		child.queue_free()
	var mesh := MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = Vector3(1.0, 1.5, 1.0)
	mesh.mesh = box
	mesh.position.y = 0.75
	var material := StandardMaterial3D.new()
	material.albedo_color = object_color
	mesh.material_override = material
	add_child(mesh, false, Node.INTERNAL_MODE_BACK)
	if not model_asset.is_empty() and ResourceLoader.exists("res://assets/" + model_asset + ".glb"):
		var model = load("res://assets/" + model_asset + ".glb").instantiate()
		add_child(model, false, Node.INTERNAL_MODE_BACK)
		mesh.visible = false
	if solid:
		var body := StaticBody3D.new()
		var shape := CollisionShape3D.new()
		var bounds := BoxShape3D.new()
		bounds.size = Vector3(1.0, 1.5, 1.0)
		shape.shape = bounds
		shape.position.y = 0.75
		body.add_child(shape)
		add_child(body, false, Node.INTERNAL_MODE_BACK)
	var label := Label3D.new()
	label.text = display_name + "\n" + stable_id
	label.font_size = 32
	label.pixel_size = 0.012
	label.position.y = 2.0
	label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	add_child(label, false, Node.INTERNAL_MODE_BACK)
