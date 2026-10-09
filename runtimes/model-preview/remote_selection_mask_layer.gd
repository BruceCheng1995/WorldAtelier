extends Node3D
## Rasterize visible coverage, extract each connected outer boundary in native
## BitMap code, and fill it. The extracted exterior ignores enclosed holes but
## preserves open concavities. Offset those 2D masks in physical screen pixels.
const MASK_SHADER = preload("res://remote_selection_mask.gdshader")
const COMPOSITE_SHADER = preload("res://remote_selection_outline.gdshader")
var mask_viewport: SubViewport
var mask_camera: Camera3D
var filled_viewport: SubViewport
var color_viewport: SubViewport
var agent_viewport: SubViewport
var filled_root: Node2D
var color_root: Node2D
var agent_root: Node2D
var composite: ColorRect
var mask_meshes: Dictionary = {}
var layers: Array = []
var polygons: Array[PackedVector2Array] = []
var _sources: Dictionary = {}
var _selected: Dictionary = {}
var _width = 4.0
var _opacity = .85
var _signature: Array = []
var _raster_pending = false
var _force_raster = true
var raster_count = 0
var extraction_usec = 0
var _raster_scale = 1.0
var _selection_membership: Dictionary = {}

func _ready() -> void:
	mask_viewport = _viewport(false)
	mask_viewport.own_world_3d = true
	mask_camera = Camera3D.new()
	mask_viewport.add_child(mask_camera)
	mask_camera.current = true
	var environment = Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color.BLACK
	mask_camera.environment = environment
	filled_viewport = _viewport(true)
	filled_root = Node2D.new()
	filled_viewport.add_child(filled_root)
	color_viewport = _viewport(true)
	color_root = Node2D.new()
	color_viewport.add_child(color_root)
	agent_viewport = _viewport(true)
	agent_root = Node2D.new()
	agent_viewport.add_child(agent_root)
	var canvas = CanvasLayer.new()
	canvas.layer = -1
	add_child(canvas)
	composite = ColorRect.new()
	composite.mouse_filter = Control.MOUSE_FILTER_IGNORE
	composite.material = ShaderMaterial.new()
	composite.material.shader = COMPOSITE_SHADER
	composite.material.set_shader_parameter("filled_mask", filled_viewport.get_texture())
	composite.material.set_shader_parameter("layer_masks", color_viewport.get_texture())
	composite.material.set_shader_parameter("agent_masks", agent_viewport.get_texture())
	canvas.add_child(composite)
	RenderingServer.frame_post_draw.connect(_finish_mask)

func _viewport(canvas_only: bool) -> SubViewport:
	var viewport = SubViewport.new()
	viewport.disable_3d = canvas_only
	viewport.transparent_bg = true
	viewport.gui_disable_input = true
	viewport.render_target_clear_mode = SubViewport.CLEAR_MODE_ALWAYS
	viewport.render_target_update_mode = SubViewport.UPDATE_DISABLED
	add_child(viewport)
	return viewport

func sync(selected: Dictionary, sources: Dictionary, users: Array, width_pixels: float, alpha: float) -> void:
	if _selected != selected: _force_raster = true
	_selected = selected
	_sources = sources
	for id in mask_meshes.keys():
		if not sources.has(id):
			mask_viewport.remove_child(mask_meshes[id])
			mask_meshes[id].queue_free()
			mask_meshes.erase(id)
			_selection_membership.erase(id)
			_force_raster = true
	for id in sources:
		if not mask_meshes.has(id):
			var copy = MeshInstance3D.new()
			copy.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			copy.gi_mode = GeometryInstance3D.GI_MODE_DISABLED
			copy.material_override = ShaderMaterial.new()
			copy.material_override.shader = MASK_SHADER
			mask_viewport.add_child(copy)
			mask_meshes[id] = copy
			_force_raster = true
		var copy: MeshInstance3D = mask_meshes[id]
		if not _selection_membership.has(id) or _selection_membership[id]!=selected.has(id):
			copy.material_override.set_shader_parameter("selected", selected.has(id))
			# Transparent black occluders write depth before selected coverage.
			copy.material_override.render_priority = 0 if selected.has(id) else -100
			_selection_membership[id]=selected.has(id)
	if layers != users or not is_equal_approx(_width, width_pixels):
		layers = users.duplicate(true)
		_width = width_pixels
		_compose_layers()
	_opacity = alpha
	composite.material.set_shader_parameter("opacity", alpha)

func _exit_tree() -> void:
	if RenderingServer.frame_post_draw.is_connected(_finish_mask): RenderingServer.frame_post_draw.disconnect(_finish_mask)

func _process(_delta: float) -> void:
	# Transform notifications must flush before RenderingServer starts drawing.
	_prepare_frame()

func _prepare_frame() -> void:
	var camera = get_viewport().get_camera_3d()
	if camera == null or _selected.is_empty():
		composite.visible = false
		return
	var size = Vector2i(get_viewport().get_visible_rect().size)
	# Only coverage masks use a bounded sampling budget. The scene and labels
	# keep their native resolution; width is converted back to screen pixels.
	var editor=get_parent().host
	var ratio=maxf(1.0,editor.gizmo.pixel_ratio)
	var budget=196608.0 if editor.navigation_active() else 786432.0
	var next_scale=minf(1.0/ratio,sqrt(budget/maxf(1.0,float(size.x)*size.y)))
	var raster_size=Vector2i(maxi(16,ceili(size.x*next_scale)),maxi(16,ceili(size.y*next_scale)))
	var signature: Array = [size, raster_size, camera.global_transform, camera.projection, camera.fov, camera.size, camera.near, camera.far, camera.keep_aspect, camera.frustum_offset, camera.h_offset, camera.v_offset, camera.cull_mask]
	for id in _sources:
		var source: MeshInstance3D = _sources[id]
		if not is_instance_valid(source):
			mask_meshes[id].visible = false
			continue
		var copy: MeshInstance3D = mask_meshes[id]
		if copy.mesh!=source.mesh: copy.mesh = source.mesh
		if copy.skin!=source.skin: copy.skin = source.skin
		if copy.global_transform!=source.global_transform: copy.global_transform = source.global_transform
		var visible_now=source.is_visible_in_tree() and (source.layers & camera.cull_mask) != 0
		if copy.visible!=visible_now: copy.visible = visible_now
		signature.append_array([id, source.mesh, source.global_transform, copy.visible])
		var skeleton = source.get_node_or_null(source.skeleton)
		var skeleton_path=skeleton.get_path() if skeleton is Skeleton3D else NodePath()
		if copy.skeleton!=skeleton_path: copy.skeleton = skeleton_path
		if skeleton is Skeleton3D:
			for bone in range(skeleton.get_bone_count()): signature.append(skeleton.get_bone_global_pose(bone))
		for i in range(source.get_blend_shape_count()):
			var value = source.get_blend_shape_value(i)
			if copy.get_blend_shape_value(i)!=value: copy.set_blend_shape_value(i, value)
			signature.append(value)
	composite.visible = not polygons.is_empty() and _opacity > 0
	if not _force_raster and signature == _signature: return
	_signature = signature
	_force_raster = false
	_raster_scale=next_scale
	mask_viewport.size = raster_size
	filled_viewport.size = raster_size
	color_viewport.size = raster_size
	agent_viewport.size = raster_size
	composite.size = Vector2(size)
	mask_camera.global_transform = camera.global_transform
	mask_camera.projection = camera.projection
	mask_camera.fov = camera.fov
	mask_camera.size = camera.size
	mask_camera.near = camera.near
	mask_camera.far = camera.far
	mask_camera.keep_aspect = camera.keep_aspect
	mask_camera.frustum_offset = camera.frustum_offset
	mask_camera.h_offset = camera.h_offset
	mask_camera.v_offset = camera.v_offset
	mask_viewport.render_target_update_mode = SubViewport.UPDATE_ONCE
	_raster_pending = true

func _finish_mask() -> void:
	if not _raster_pending: return
	_raster_pending = false
	var started = Time.get_ticks_usec()
	var image = mask_viewport.get_texture().get_image()
	if image == null or image.is_empty(): return
	polygons.clear()
	var rect = image.get_used_rect()
	if rect.has_area():
		# Crop before native contour extraction. Static frames reuse the result;
		# multiple users selecting the same object share this one GPU readback.
		rect = rect.grow(1).intersection(Rect2i(Vector2i.ZERO, image.get_size()))
		var bitmap = BitMap.new()
		bitmap.create_from_image_alpha(image.get_region(rect), .5)
		for polygon in bitmap.opaque_to_polygons(Rect2i(Vector2i.ZERO, rect.size), .25):
			polygons.append(Transform2D(0.0, Vector2(rect.position)) * polygon)
	_clear(filled_root)
	for polygon in polygons: _polygon(filled_root, polygon, Color.WHITE)
	filled_viewport.render_target_update_mode = SubViewport.UPDATE_ONCE
	_compose_layers()
	composite.visible = not polygons.is_empty() and _opacity > 0
	raster_count += 1
	extraction_usec = Time.get_ticks_usec() - started

func _compose_layers() -> void:
	if color_root == null: return
	_clear(color_root)
	_clear(agent_root)
	# Render opaque masks outermost first; apply opacity only after compositing
	# so inner colors never blend with the users beneath them.
	for index in range(layers.size() - 1, -1, -1):
		var user_mask = Node2D.new()
		user_mask.name = "UserMask_" + str(index)
		user_mask.set_meta("user_id", layers[index].user_id)
		color_root.add_child(user_mask)
		for polygon in polygons:
			for expanded in Geometry2D.offset_polygon(polygon, _width * _raster_scale * (index + 1), Geometry2D.JOIN_ROUND):
				_polygon(user_mask, expanded, Color(layers[index].color, 1.0))
				# Share layer ownership while varying only the final Agent style.
				_polygon(agent_root, expanded, Color.WHITE if layers[index].get("kind", "user") == "agent" else Color.BLACK)
	color_viewport.render_target_update_mode = SubViewport.UPDATE_ONCE
	agent_viewport.render_target_update_mode = SubViewport.UPDATE_ONCE

func _polygon(parent: Node2D, points: PackedVector2Array, color: Color) -> void:
	var node = Polygon2D.new()
	node.polygon = points
	node.color = color
	parent.add_child(node)

func _clear(parent: Node2D) -> void:
	for child in parent.get_children():
		parent.remove_child(child)
		child.queue_free()
