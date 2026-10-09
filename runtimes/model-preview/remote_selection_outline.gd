extends Node3D
## Each distinct selected silhouette owns independent, ordered user masks.
## Geometry is never expanded and authored materials are never replaced.
const MASK_LAYER = preload("res://remote_selection_mask_layer.gd")
var host: Node3D
var groups: Dictionary = {}
var outlines: Dictionary = {}
var width = 4.0
var opacity = .85

func meshes_under(node: Node, result: Dictionary, visited: Dictionary = {}) -> void:
	var node_id=node.get_instance_id()
	if visited.has(node_id): return
	visited[node_id]=true
	if node is MeshInstance3D and node.mesh != null and node.is_visible_in_tree(): result[node.get_instance_id()] = node
	for child in node.get_children(): meshes_under(child, result, visited)

func row_order(row: Dictionary) -> int:
	var value = row.get("selection_order")
	if (value is int or value is float) and is_finite(float(value)) and value >= 0 and value <= 9007199254740991 and float(value) == floorf(float(value)): return int(value)
	return 0

func sort_layers(users: Array) -> void:
	users.sort_custom(func(a, b):
		if (a.get("kind", "user") == "agent") != (b.get("kind", "user") == "agent"): return b.get("kind", "user") == "agent"
		return a.selection_order > b.selection_order if a.selection_order != b.selection_order else a.user_id < b.user_id)

func sync(rows: Array, pixel_ratio: float) -> void:
	var displayed: Dictionary = host.display_objects()
	var requested = {}
	var all_meshes = {}
	# Avoid maintaining offscreen render trees when nothing is selected.
	if not rows.is_empty() and opacity > 0:
		var visited={}
		for node in displayed.values(): meshes_under(node, all_meshes, visited)
		for row in rows:
			if not displayed.has(row.object_id): continue
			var sources = {}
			meshes_under(displayed[row.object_id], sources)
			if sources.is_empty(): continue
			var ids = sources.keys()
			ids.sort()
			# Identical geometry shares the rasterization, not ownership: every
			# selecting account retains a separate outward mask/color layer.
			var key = str(ids)
			if not requested.has(key): requested[key] = {"sources":sources, "users":{}}
			var user_id = str(row.get("user_id", ""))
			var user = {"user_id":user_id, "selection_order":row_order(row), "color":row.color, "kind":row.get("kind", "user")}
			var users: Dictionary = requested[key].users
			if not users.has(user_id) or user.selection_order > users[user_id].selection_order: users[user_id] = user
	for key in groups.keys():
		if not requested.has(key):
			remove_child(groups[key])
			groups[key].queue_free()
			groups.erase(key)
	outlines.clear()
	var ordered_keys = requested.keys()
	ordered_keys.sort()
	for key in ordered_keys:
		if not groups.has(key):
			var group = MASK_LAYER.new()
			group.name = "SelectionScreenMask"
			add_child(group)
			groups[key] = group
		var users: Array = requested[key].users.values()
		sort_layers(users)
		groups[key].sync(requested[key].sources, all_meshes, users, width * pixel_ratio, opacity)
		groups[key].composite.material.set_shader_parameter("pixel_ratio", pixel_ratio)
		for id in requested[key].sources: outlines[id] = groups[key].mask_meshes[id]
		# Stable canvas composition also for different overlapping objects.
		move_child(groups[key], get_child_count() - 1)
