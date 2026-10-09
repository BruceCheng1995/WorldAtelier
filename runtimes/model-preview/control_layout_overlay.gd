extends Node2D
var host: Node
func _process(_delta: float) -> void: queue_redraw()
func _draw() -> void:
	if host == null: return
	var points: PackedVector2Array = host.control_handle_points()
	if points.size() != 8: return
	# The shared selection overlay owns the only frame. These are resize
	# handles for a single editable Control, never another selection outline.
	var color = Color.from_string(str(host.collaboration_overlay.remote_selections.local_peer.get("color", "#69e7ed")), Color("69e7ed"))
	for point in points:
		draw_rect(Rect2(point-Vector2(3,3),Vector2(6,6)),Color.WHITE)
		draw_rect(Rect2(point-Vector2(3,3),Vector2(6,6)),color,false,1.0)
