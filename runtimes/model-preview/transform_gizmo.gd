extends Node3D
## Runtime editor handles. Geometry is cached until the tool changes; camera/hover
## updates only change transforms/material colors. Screen metadata is also used by
## the real hit test, and is exposed for deterministic input probes.
const AXES = [Vector3.RIGHT, Vector3.UP, Vector3.BACK]
const COLORS = [Color("ff747c"), Color("7cdda8"), Color("6baaff")]
const YELLOW = Color("ffe36c")
const PIXELS = 80.0
const HIT_PIXELS = 13.0
var tool = ""
var handles: Dictionary = {}
var camera: Camera3D
var world_size = 1.0
var pixel_ratio = 1.0
var hover = ""
var active = ""

func material(color: Color, translucent: bool = false) -> StandardMaterial3D:
	var value = StandardMaterial3D.new()
	value.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	value.no_depth_test = true
	value.cull_mode = BaseMaterial3D.CULL_DISABLED
	value.albedo_color = color
	if translucent:
		value.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		value.albedo_color.a = .38
	return value

func add_mesh(mesh: Mesh, mat: Material, at: Vector3 = Vector3.ZERO) -> MeshInstance3D:
	var node = MeshInstance3D.new()
	node.mesh = mesh
	node.material_override = mat
	add_child(node)
	node.position = at
	return node

func shaft(start: Vector3, end: Vector3, radius: float, mat: Material) -> void:
	var mesh = CylinderMesh.new()
	mesh.top_radius = radius
	mesh.bottom_radius = radius
	mesh.height = start.distance_to(end)
	mesh.radial_segments = 8
	var node = add_mesh(mesh, mat, (start + end) / 2)
	orient_y(node, (end - start).normalized())

func orient_y(node: Node3D, axis: Vector3) -> void:
	var tangent = axis.cross(Vector3.UP if absf(axis.y) < .9 else Vector3.RIGHT).normalized()
	node.basis = Basis(tangent, axis, tangent.cross(axis))

func set_tool(value: String) -> void:
	if tool == value: return
	tool = value
	hover = ""
	active = ""
	handles.clear()
	for child in get_children():
		remove_child(child)
		child.queue_free()
	if tool == "select": return
	for i in range(3):
		var id = ["x", "y", "z"][i]
		var axis: Vector3 = AXES[i]
		var mat = material(COLORS[i])
		var entry = {"kind": "axis", "axis": i, "material": mat, "color": COLORS[i], "points": [axis * .18, axis]}
		if tool == "rotate":
			entry.kind = "ring"
			entry.points = []
			var a: Vector3 = AXES[(i + 1) % 3]
			var b: Vector3 = AXES[(i + 2) % 3]
			for index in range(65):
				var angle = TAU * index / 64.0
				entry.points.append(a * cos(angle) + b * sin(angle))
			var ring = TorusMesh.new()
			ring.inner_radius = .984
			ring.outer_radius = 1.016
			ring.rings = 64
			ring.ring_segments = 8
			orient_y(add_mesh(ring, mat), axis)
		else:
			shaft(axis * .12, axis * .91, .018, mat)
			if tool == "move":
				var cone = CylinderMesh.new()
				cone.top_radius = 0
				cone.bottom_radius = .065
				cone.height = .19
				cone.radial_segments = 12
				orient_y(add_mesh(cone, mat, axis), axis)
			else:
				var box = BoxMesh.new()
				box.size = Vector3.ONE * .13
				add_mesh(box, mat, axis)
		handles[id] = entry
	if tool == "move":
		for pair in [[0,1,"xy",2], [0,2,"xz",1], [1,2,"yz",0]]:
			var a: Vector3 = AXES[pair[0]]
			var b: Vector3 = AXES[pair[1]]
			var points = [a*.24+b*.24, a*.47+b*.24, a*.47+b*.47, a*.24+b*.47]
			var mat = material(COLORS[pair[3]], true)
			var surface = SurfaceTool.new()
			surface.begin(Mesh.PRIMITIVE_TRIANGLES)
			for index in [0,1,2,0,2,3]: surface.add_vertex(points[index])
			add_mesh(surface.commit(), mat)
			for index in range(4): shaft(points[index], points[(index+1)%4], .009, mat)
			handles[pair[2]] = {"kind": "plane", "axes": [pair[0],pair[1]], "points": points, "material": mat, "color": COLORS[pair[3]]}
	if tool == "scale":
		var mat = material(Color("e5edf6"))
		var box = BoxMesh.new()
		box.size = Vector3.ONE * .15
		add_mesh(box, mat)
		handles.uniform = {"kind": "uniform", "points": [Vector3.ZERO], "material": mat, "color": Color("e5edf6")}

func configure(view: Camera3D, at: Vector3, orientation: Basis, value: String, enabled: bool) -> void:
	camera = view
	set_tool(value)
	visible = enabled and value != "select" and not camera.is_position_behind(at)
	if not visible: return
	var height = maxf(1, camera.get_viewport().get_visible_rect().size.y)
	var depth = maxf(.02, -camera.to_local(at).z)
	world_size = camera.size / height * PIXELS * pixel_ratio if camera.projection == Camera3D.PROJECTION_ORTHOGONAL else 2 * depth * tan(deg_to_rad(camera.fov) / 2) / height * PIXELS * pixel_ratio
	global_transform = Transform3D(orientation * Basis.from_scale(Vector3.ONE * world_size), at)

func screen_handles() -> Dictionary:
	var result = {}
	if not visible or camera == null: return result
	for id in handles:
		var handle = handles[id]
		var points = PackedVector2Array()
		for point in handle.points: points.append(camera.unproject_position(global_transform * point))
		result[id] = {"kind": handle.kind, "points": points}
		if handle.has("axis"): result[id].axis = handle.axis
		if handle.has("axes"): result[id].axes = handle.axes
	return result

func hit_test(screen: Vector2) -> String:
	var projected = screen_handles()
	if projected.has("uniform") and projected.uniform.points[0].distance_to(screen) <= HIT_PIXELS * pixel_ratio: return "uniform"
	for id in projected:
		var handle = projected[id]
		if handle.kind == "plane" and absf(polygon_area(handle.points)) > 18 * pixel_ratio * pixel_ratio and Geometry2D.is_point_in_polygon(screen, handle.points): return id
	var best = HIT_PIXELS * pixel_ratio
	var result = ""
	for id in projected:
		var handle = projected[id]
		if handle.kind == "uniform": continue
		var points = handle.points
		if handle.kind == "plane": continue # Edges do not steal axis clicks.
		if handle.kind == "axis" and points[0].distance_to(points[1]) < 12 * pixel_ratio: continue
		for i in range(points.size()-1):
			var d = Geometry2D.get_closest_point_to_segment(screen, points[i], points[i+1]).distance_to(screen)
			if d < best:
				best = d
				result = id
	return result

func polygon_area(points: PackedVector2Array) -> float:
	var area = 0.0
	for i in range(points.size()): area += points[i].cross(points[(i+1)%points.size()])
	return area / 2

func highlight(over: String, dragging: String = "") -> void:
	if over == hover and dragging == active: return
	hover = over
	active = dragging
	for id in handles:
		var entry = handles[id]
		var color: Color = YELLOW if id == active or (active.is_empty() and id == hover) else entry.color
		if entry.kind == "plane": color.a = .7 if id == active or id == hover else .38
		entry.material.albedo_color = color
