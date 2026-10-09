extends Node3D
const Factory = preload("res://scene_factory.gd")
const FONT = preload("res://fonts/CreatorUI.tres")
const LABEL_CSS_FONT_SIZE = 14.0
const LABEL_CSS_MAX_WIDTH = 240.0
const LABEL_CSS_MARGIN = 8.0
var peer_nodes: Dictionary = {}
var development_selections: Array = []
var screen_labels: Array[Label3D] = []
var remote_selections: Control
var show_peer_cameras = true

func apply_display_settings(settings: Dictionary) -> void:
	if settings.get("show_cameras") is bool: show_peer_cameras = settings.show_cameras
	if settings.get("show_selections") is bool: remote_selections.show_remote_selections = settings.show_selections
	if settings.get("show_agents") is bool: remote_selections.show_agent_outlines = settings.show_agents
	for field in ["width", "opacity"]:
		var value = settings.get(field)
		if (value is float or value is int) and is_finite(float(value)):
			if field == "width": remote_selections.outline_renderer.width = clampf(value, .5, 8.0)
			else: remote_selections.outline_renderer.opacity = clampf(value, 0.0, 1.0)

func _ready() -> void:
	var layer = CanvasLayer.new()
	layer.layer = 2
	add_child(layer)
	remote_selections = preload("res://remote_selection_overlay.gd").new()
	remote_selections.host = get_parent()
	layer.add_child(remote_selections)

func mat(color: Color) -> StandardMaterial3D:
	var material = StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.albedo_color = color
	return material

func line(parent: Node3D, a: Vector3, b: Vector3, color: Color, width: float = .018) -> void:
	var mesh = CylinderMesh.new()
	mesh.top_radius = width
	mesh.bottom_radius = width
	mesh.height = a.distance_to(b)
	mesh.radial_segments = 6
	var node = MeshInstance3D.new()
	node.mesh = mesh
	node.material_override = mat(color)
	parent.add_child(node)
	node.position = (a+b)/2
	var axis = (b-a).normalized()
	var tangent = axis.cross(Vector3.UP if absf(axis.y)<.9 else Vector3.RIGHT).normalized()
	node.basis = Basis(tangent,axis,tangent.cross(axis))

func label(parent: Node3D, text: String, at: Vector3, color: Color, owner_bounds: AABB = AABB()) -> Label3D:
	var node = Label3D.new()
	node.font = FONT
	node.font_size = 48
	node.pixel_size = .006
	node.text = text
	node.modulate = color
	node.outline_modulate = Color("10131e")
	node.outline_size = 4
	node.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	node.no_depth_test = true
	parent.add_child(node)
	node.position = at
	node.set_meta("anchor",at)
	node.set_meta("full_text",text)
	node.set_meta("width_budget",-1.0)
	node.set_meta("owner_bounds",owner_bounds if owner_bounds.size.length_squared()>0 else AABB(at-Vector3.ONE*.05,Vector3.ONE*.1))
	screen_labels.append(node)
	return node

func bounds_in_view(bounds: AABB, camera: Camera3D) -> bool:
	for plane in camera.get_frustum():
		var outside = true
		for i in range(8):
			if not plane.is_point_over(bounds.get_endpoint(i)):
				outside=false
				break
		if outside:return false
	return true

func update_label(node: Label3D, camera: Camera3D, pixel_ratio: float) -> void:
	var anchor: Vector3 = node.get_parent().to_global(node.get_meta("anchor"))
	var depth = -camera.to_local(anchor).z
	var owner_bounds: AABB=node.get_parent().global_transform*node.get_meta("owner_bounds")
	node.visible = depth >= maxf(.75,camera.near*2) and not camera.is_position_behind(anchor) and bounds_in_view(owner_bounds,camera)
	if not node.visible: return
	var rect = camera.get_viewport().get_visible_rect()
	if rect.size.x<=0 or rect.size.y<=0: node.visible=false;return
	var screen = camera.unproject_position(anchor)
	# Sampling camera-up at the same depth also handles orthographic views,
	# camera keep_aspect and the actual render viewport dimensions.
	var pixels_per_meter = screen.distance_to(camera.unproject_position(anchor+camera.global_basis.y))
	if pixels_per_meter<.0001: node.visible=false;return
	var source_to_css = LABEL_CSS_FONT_SIZE/node.font_size
	var budget = minf(LABEL_CSS_MAX_WIDTH,maxf(20,rect.size.x/pixel_ratio-LABEL_CSS_MARGIN*2))
	if not is_equal_approx(float(node.get_meta("width_budget")),budget):
		var text: String = node.get_meta("full_text")
		var full_text = text
		while text.length()>1 and FONT.get_string_size(text,HORIZONTAL_ALIGNMENT_LEFT,-1,node.font_size).x*source_to_css>budget:
			full_text=full_text.left(full_text.length()-1)
			text=full_text+"…"
		node.text=text
		node.set_meta("width_budget",budget)
		node.set_meta("text_css_size",FONT.get_string_size(text,HORIZONTAL_ALIGNMENT_LEFT,-1,node.font_size)*source_to_css)
	# Keep the glyph mesh cached; changing pixel_size every frame would rebuild
	# it. Uniform node scale is preserved by the Label3D billboard shader.
	var world_scale = LABEL_CSS_FONT_SIZE*pixel_ratio/(node.font_size*node.pixel_size*pixels_per_meter)
	node.scale=Vector3.ONE*world_scale
	var half_size: Vector2=node.get_meta("text_css_size")*pixel_ratio*.5
	var margin=Vector2.ONE*LABEL_CSS_MARGIN*pixel_ratio
	var min_position=rect.position+half_size+margin
	var max_position=rect.end-half_size-margin
	var clamped=Vector2(clampf(screen.x,min_position.x,max_position.x),clampf(screen.y,min_position.y,max_position.y))
	# Reposition only the label at equal camera depth. Its source anchor and
	# the object's actual transform stays intact.
	node.global_position=camera.project_position(clamped,depth)
	node.set_meta("css_font_size",node.font_size*node.pixel_size*world_scale*pixels_per_meter/pixel_ratio)

func set_peers(peers: Array, local_peer: Dictionary = {}) -> void:
	remote_selections.peers = peers.duplicate(true)
	remote_selections.local_peer = local_peer.duplicate(true)
	remote_selections.queue_redraw()
	var keep = {}
	for peer in peers.slice(0,32):
		if not peer is Dictionary or not peer.get("id") is String or not peer.get("camera") is Dictionary: continue
		if not Factory.vector_array(peer.camera.get("position")) or not Factory.vector_array(peer.camera.get("target")): continue
		var id: String = peer.id
		keep[id] = true
		if not peer_nodes.has(id):
			var node = Node3D.new()
			add_child(node)
			peer_nodes[id] = node
			var color = Color.from_string(str(peer.get("color","#82c9ff")),Color("82c9ff"))
			var points = [Vector3(-.35,-.22,-.7),Vector3(.35,-.22,-.7),Vector3(.35,.22,-.7),Vector3(-.35,.22,-.7)]
			for i in range(4):
				line(node,Vector3.ZERO,points[i],color)
				line(node,points[i],points[(i+1)%4],color)
			label(node,str(peer.get("name","协作者")).left(40),Vector3(0,.45,0),color,AABB(Vector3(-.35,-.22,-.7),Vector3(.7,.67,.7)))
		var node: Node3D = peer_nodes[id]
		node.set_meta("mode",str(peer.get("mode","editing")))
		node.position = Factory.vec(peer.camera.position)
		var target = Factory.vec(peer.camera.target)
		if node.position.distance_to(target)>.01:
			var direction = (target-node.position).normalized()
			node.look_at(target,Vector3.BACK if absf(direction.y)>.98 else Vector3.UP)
	for id in peer_nodes.keys():
		if not keep.has(id):
			peer_nodes[id].queue_free()
			peer_nodes.erase(id)

func _process(_delta: float) -> void:
	var host = get_parent()
	if host==null or host.camera==null: return
	var playing = host.world_client!=null and host.world_client.mode in ["playing","entering_inspect"]
	for node in peer_nodes.values():
		# Nearby follow cameras can cross the near plane and project their
		# frustum cylinders into enormous stripes. Players already have avatars
		# and names; keep camera markers for collaboration in edit/inspect.
		node.visible = show_peer_cameras and not (playing and node.get_meta("mode","editing")=="playing") and host.camera.global_position.distance_to(node.global_position)>=1.5 and not host.camera.is_position_behind(node.global_position)
	var pixel_ratio = host.gizmo.pixel_ratio if host.gizmo!=null else 1.0
	for i in range(screen_labels.size()-1,-1,-1):
		var node=screen_labels[i]
		if not is_instance_valid(node) or node.is_queued_for_deletion() or not node.is_inside_tree():
			screen_labels.remove_at(i)
			continue
		update_label(node,host.camera,pixel_ratio)

func set_developments(definitions: Dictionary, objects: Dictionary) -> void:
	development_selections.clear()
	for id in definitions:
		if not objects.has(id): continue
		var jobs: Array = definitions[id].get("developments",[])
		if jobs.is_empty(): continue
		var newest: Dictionary = jobs.back()
		var status: String = newest.get("status","editing")
		var color = Color("ffb73e")
		if status == "testing": color = Color("ffd466")
		if status == "delivered": color = Color("74e0a3")
		if status == "failed": color = Color("ff775f")
		# Feed the same silhouette masks as user selection. Keep one status
		# layer per object even when several Agent runs are aggregated here.
		var detail = str(newest.get("label",newest.get("actor",""))).replace("\n"," ").replace("\r"," ").strip_edges().left(46)
		var text = detail if not detail.is_empty() else "Agent"
		var run_ids: Array = []
		for run in newest.get("runs", []):
			if run is Dictionary and run.has("run_id"): run_ids.append(str(run.run_id))
		run_ids.sort()
		var identity = "development:" + (JSON.stringify(run_ids) if not run_ids.is_empty() else str(newest.get("session_id", newest.get("run_id", id))))
		development_selections.append({"object_id":id,"user_id":"development:"+str(id),"selection_identity":identity,"selection_order":0,"color":color,"kind":"agent","name":text,"canvas_name":detail if not detail.is_empty() else "Agent"})
