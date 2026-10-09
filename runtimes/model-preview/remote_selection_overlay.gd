extends Control
## Screen-space collaboration hints. Never intercept picking or mutate objects.
const FONT = preload("res://fonts/CreatorUI.tres")
var host: Node3D
var peers: Array = []
var drawn_selections: Array = []
var outline_renderer: Node3D
var show_remote_selections = true
var show_agent_outlines = true
var local_peer: Dictionary = {}
var drawn_canvas_selections: Array = []

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	outline_renderer = preload("res://remote_selection_outline.gd").new()
	outline_renderer.host = host
	host.collaboration_overlay.add_child(outline_renderer)

func _process(_delta: float) -> void:
	var rows = collect_display_selections().filter(func(row): return show_agent_outlines or row.get("kind", "user") != "agent")
	outline_renderer.sync(rows, host.gizmo.pixel_ratio if host.gizmo != null else 1.0)
	queue_redraw()

func collect_display_selections() -> Array:
	var rows = collect_selections()
	# Use the currently displayed object projection for local edit/inspection,
	# including the standalone object editor. Remote presence remains source-scoped.
	var ids = local_ids()
	if not ids.is_empty():
		var newest = 0
		for row in rows: newest = maxi(newest, int(row.get("selection_order", 0)))
		var acknowledged_ids: Array = []
		for selection in peer_objects(local_peer):
			if selection is Dictionary: acknowledged_ids.append(str(selection.get("id", "")))
		var acknowledged = local_peer.get("selected_id") == host.selected_id and acknowledged_ids == ids and local_peer.get("mode", "editing") == "editing"
		var order = valid_order(local_peer.get("selection_order")) if acknowledged else newest + 1
		for id in ids:
			var row = {"object_id":id, "user_id":str(local_peer.get("user_id", local_peer.get("id", ""))), "local":true, "selection_order":order, "color":Color.from_string(str(local_peer.get("color", "#69e7ed")), Color("69e7ed"))}
			if not str(local_peer.get("name", "")).is_empty():
				row.name = str(local_peer.name).replace("\n", " ").replace("\r", " ").left(40)
			rows.append(row)
	var displayed = host.display_objects()
	for row in host.collaboration_overlay.development_selections:
		if not displayed.has(row.object_id): continue
		var node = displayed[row.object_id]
		if node.has_method("is_visible_in_tree") and not node.is_visible_in_tree(): continue
		rows.append(row)
	return rows

func local_ids() -> Array:
	if not host.display_objects().has(host.selected_id): return []
	var ids = host.get("selected_ids")
	if not ids is Array or not ids.has(host.selected_id): return [host.selected_id]
	return ids.filter(func(id): return host.display_objects().has(id))

func peer_objects(peer: Dictionary) -> Array:
	if peer.get("selected_objects") is Array: return peer.selected_objects.slice(0,128)
	return [{"id":peer.get("selected_id", ""), "address":peer.get("selected_address")}]

func same_address(a: Dictionary, b: Dictionary) -> bool:
	for field in ["project_id", "branch_id", "resource_id", "instance_path", "definition_node_id"]:
		if not a.has(field) or not b.has(field) or a[field] != b[field]: return false
	return true

func valid_order(value: Variant) -> int:
	if (value is int or value is float) and is_finite(float(value)) and value >= 0 and value <= 9007199254740991 and float(value) == floorf(float(value)): return int(value)
	return 0

func collect_selections() -> Array:
	var rows: Array = []
	if not show_remote_selections: return rows
	if host == null or host.mode != "main" or host.camera == null: return rows
	if host.world_client != null and host.world_client.mode != "editing": return rows
	var by_identity = {}
	for peer in peers.slice(0,32):
		if not peer is Dictionary or peer.get("mode", "editing") != "editing": continue
		for selection in peer_objects(peer):
			if not selection is Dictionary: continue
			var id = str(selection.get("id", ""))
			if not host.objects.has(id) or (host.objects[id].has_method("is_visible_in_tree") and not host.objects[id].is_visible_in_tree()): continue
			var definition: Dictionary = host.definitions.get(id, {})
			var address = selection.get("address")
			if definition.has("address"):
				if not address is Dictionary or not same_address(address, definition.address): continue
			elif address is Dictionary:
				var parts = host.document_id.split("/")
				if parts.size() != 3 or not same_address(address, {"project_id":parts[0], "branch_id":parts[1], "resource_id":parts[2], "instance_path":[], "definition_node_id":id}): continue
			var user_id = str(peer.get("user_id", peer.get("id", "")))
			var identity = JSON.stringify([user_id, id])
			var row = {"object_id":id, "user_id":user_id, "selection_order":valid_order(peer.get("selection_order")), "name":str(peer.get("name", "协作者")).replace("\n", " ").replace("\r", " ").left(40), "color":Color.from_string(str(peer.get("color", "#82c9ff")), Color("82c9ff"))}
			if not by_identity.has(identity) or row.selection_order > by_identity[identity].selection_order: by_identity[identity] = row
	rows.assign(by_identity.values())
	rows.sort_custom(func(a,b): return a.user_id < b.user_id)
	return rows

func project_bounds(bounds: AABB) -> Rect2:
	var camera: Camera3D = host.camera
	if not host.collaboration_overlay.bounds_in_view(bounds, camera): return Rect2()
	var rect = Rect2()
	for i in range(8):
		var point = bounds.get_endpoint(i)
		# Do not project bounds through the near plane into enormous rectangles.
		if -camera.to_local(point).z <= camera.near: return Rect2()
		var screen = camera.unproject_position(point)
		if i == 0: rect = Rect2(screen, Vector2.ZERO)
		else: rect = rect.expand(screen)
	return rect

func selection_identity_key(row: Dictionary) -> String:
	return JSON.stringify([row.get("kind", "user"), row.get("selection_identity", row.get("user_id", ""))])

func collect_label_groups(rows: Array, viewport_rect: Rect2) -> Array:
	# Names belong to the selecting identity, not a mesh, Control or dimension.
	# Use one grouping path for 3D, 2D, and selections spanning both.
	var groups: Dictionary = {}
	var displayed = host.display_objects()
	for row in rows:
		if not row.has("name") or row.get("kind", "user") == "agent" and not show_agent_outlines: continue
		var node = displayed.get(row.object_id)
		if not is_instance_valid(node) or node.has_method("is_visible_in_tree") and not node.is_visible_in_tree(): continue
		var rect = host.selection_screen_rect(row.object_id) if host.has_method("selection_screen_rect") else project_bounds(host.display_bounds(row.object_id))
		if not rect.has_area() or not rect.intersects(viewport_rect): continue
		var identity = selection_identity_key(row)
		if not groups.has(identity):
			groups[identity] = row.merged({"rect":rect, "object_ids":[row.object_id]})
		else:
			var group: Dictionary = groups[identity]
			group.rect = group.rect.merge(rect)
			if not group.object_ids.has(row.object_id): group.object_ids.append(row.object_id)
			if row.selection_order > group.selection_order:
				group.selection_order = row.selection_order
				group.color = row.color
		groups[identity].name = row.get("canvas_name", row.name)
	return groups.values()

func _draw() -> void:
	drawn_selections.clear()
	drawn_canvas_selections.clear()
	var rows = collect_display_selections()
	if rows.is_empty(): return
	var ratio = host.gizmo.pixel_ratio if host.gizmo != null else 1.0
	draw_canvas_selections(rows, ratio)
	var viewport_rect = get_viewport_rect()
	var font_size = maxi(12, roundi(12 * ratio))
	var margin = 8 * ratio
	var height = 20 * ratio
	var occupied: Array[Rect2] = []
	for row in collect_label_groups(rows, viewport_rect):
		var rect: Rect2 = row.rect
		var text: String = row.name
		var max_width = minf(240 * ratio, viewport_rect.size.x - margin * 2)
		while text.length() > 1 and FONT.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x > max_width - 16 * ratio:
			text = text.left(text.length() - 2) + "…"
		var width = FONT.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x + 16 * ratio
		var at = Vector2(clampf(rect.position.x, margin, viewport_rect.end.x - width - margin), clampf(rect.position.y - height - 4 * ratio, margin, viewport_rect.end.y - height - margin))
		var pill = Rect2(at, Vector2(width, height))
		# Keep concurrent editors readable, including users selecting the same object.
		for attempt in range(32):
			var collision = false
			for previous in occupied:
				if pill.intersects(previous): collision = true; break
			if not collision: break
			pill.position.y += height + 3 * ratio
			if pill.end.y > viewport_rect.end.y - margin: pill.position.y = margin
		occupied.append(pill)
		var style = StyleBoxFlat.new()
		style.bg_color = Color(.04,.07,.09,.8)
		style.set_corner_radius_all(roundi(4 * ratio))
		draw_style_box(style, pill)
		draw_string(FONT, pill.position + Vector2(8 * ratio, (height - FONT.get_height(font_size)) / 2 + FONT.get_ascent(font_size)), text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, row.color)
		var drawn: Dictionary = row.duplicate()
		drawn.merge({"rect":rect, "label_rect":pill, "text":text})
		drawn_selections.append(drawn)

func draw_canvas_selections(rows: Array, ratio: float) -> void:
	drawn_canvas_selections.clear()
	var by_bounds: Dictionary = {}
	for group in collect_canvas_groups(rows):
		var key = str(group.rect)
		if not by_bounds.has(key): by_bounds[key] = []
		by_bounds[key].append(group)
	var width = outline_renderer.width * ratio
	for users in by_bounds.values():
		outline_renderer.sort_layers(users)
		for index in users.size():
			var row: Dictionary = users[index]
			var rect: Rect2 = row.rect.grow(width * (index + .5))
			var color = Color(row.color, outline_renderer.opacity)
			if row.get("kind", "user") == "agent": draw_agent_frame(rect, color, width, ratio)
			else: draw_rect(rect, color, false, width)
			drawn_canvas_selections.append(row.merged({"frame_rect":rect}))

func collect_canvas_groups(rows: Array) -> Array:
	if not host.has_method("selection_screen_rect"): return []
	var groups: Dictionary = {}
	var displayed = host.display_objects()
	for row in rows:
		if row.get("kind", "user") == "agent" and not show_agent_outlines: continue
		var node = displayed.get(row.object_id)
		if not node is CanvasItem or not node.is_visible_in_tree(): continue
		var rect = host.selection_screen_rect(row.object_id)
		if not rect.has_area(): continue
		var identity = selection_identity_key(row)
		if not groups.has(identity):
			groups[identity] = row.merged({"rect":rect, "object_ids":[row.object_id]})
		else:
			var group: Dictionary = groups[identity]
			group.rect = group.rect.merge(rect)
			if not group.object_ids.has(row.object_id): group.object_ids.append(row.object_id)
			if row.has("name"): group.name = row.name
			if row.selection_order > group.selection_order:
				group.selection_order = row.selection_order
				group.color = row.color
		if row.has("canvas_name"): groups[identity].name = row.canvas_name
	return groups.values()

func draw_agent_frame(rect: Rect2, color: Color, width: float, ratio: float) -> void:
	# Match the animated light/dark Agent band used by the 3D silhouette.
	draw_rect(rect, Color(color, color.a * .18), false, width)
	var corners = [rect.position, Vector2(rect.end.x, rect.position.y), rect.end, Vector2(rect.position.x, rect.end.y), rect.position]
	var period = 18.0 * ratio
	var phase = fmod(Time.get_ticks_msec() * .001 * .65 * period, period)
	var travelled = 0.0
	for edge in 4:
		var start: Vector2 = corners[edge]
		var delta: Vector2 = corners[edge + 1] - start
		var length = delta.length()
		var offset = -fposmod(travelled - phase, period)
		while offset < length:
			var a = maxf(0, offset)
			var b = minf(length, offset + period * .6)
			if b > a: draw_line(start + delta * (a / length), start + delta * (b / length), Color(color.lightened(.22), color.a), width)
			offset += period
		travelled += length
