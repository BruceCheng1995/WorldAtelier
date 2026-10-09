extends Node3D
const Loader = preload("res://scene_loader.gd")
const Registry = preload("res://behavior_registry.gd")
const Factory = preload("res://scene_factory.gd")
const FONT = preload("res://fonts/CreatorUI.tres")
var loader = Loader.new()
var graph: Dictionary = {}
var content_root: Node3D
var objects: Dictionary = {}
var definitions: Dictionary = {}
var behaviors = Registry.new()
var avatars: Dictionary = {}
var snapshot: Dictionary = {}
var scene_revision = ""
var frozen = false
var time_since_snapshot = 0.0
var preparation = 0
var error = ""
var asset_hashes: Array = []
var frozen_particles: Array = []
var frozen_process_modes: Array = []
var inspection_canvas: Array = []
var inspection_controls: Array = []

func prepare(document: Dictionary, state: Dictionary, host: Node) -> bool:
	preparation += 1
	var token = preparation
	# Share already verified immutable PackedScene prototypes, never mutable
	# material instances from another projection.
	for asset in host.asset_cache.values(): loader.asset_cache[asset.hash] = asset
	var candidate = await loader.prepare(self,document,host.origin)
	if token!=preparation:
		if candidate.ok: candidate.root.free()
		return false
	if not candidate.ok:
		error = candidate.error
		return false
	var root: Node3D = candidate.root
	root.visible = false
	add_child(root)
	make_resources_private(root)
	var registry = Registry.new()
	var problem = registry.prepare(candidate.document,candidate.objects,candidate.sources,"presentation",state.get("object_states",{}))
	if problem.is_empty():
		registry.update_contexts(state.get("players",{}).values(),int(state.get("tick",0)))
		registry.present({"kind":"snapshot","initial":true,"tick":state.get("tick",0)})
		if not registry.fault.is_empty(): problem = str(registry.fault)
	if not problem.is_empty():
		registry.dispose()
		root.queue_free()
		error = problem
		return false
	if host.world_client.latest.get("world_id")!=state.get("world_id") or host.world_client.latest.get("epoch")!=state.get("epoch") or host.world_client.latest.get("scene_revision")!=state.get("scene_revision") or not host.world_client.wanted_play:
		registry.dispose()
		root.queue_free()
		error = "superseded"
		return false
	if content_root!=null:
		behaviors.dispose()
		remove_child(content_root)
		content_root.queue_free()
	content_root = root
	objects = candidate.objects
	graph = candidate.graph
	definitions = {}
	for row in candidate.document.objects: definitions[row.id] = row.duplicate(true)
	behaviors = registry
	asset_hashes = []
	for asset in candidate.assets: asset_hashes.append(asset.hash)
	scene_revision = str(document.get("scene_revision",state.get("scene_revision","")))
	content_root.visible = true
	error = ""
	apply_snapshot(state,true)
	return true

func make_resources_private(node: Node) -> void:
	if node is MeshInstance3D and node.mesh!=null:
		node.mesh = node.mesh.duplicate(true)
		if node.material_override!=null: node.material_override = node.material_override.duplicate(true)
		for index in range(node.mesh.get_surface_count()):
			var material = node.get_active_material(index)
			if material!=null: node.set_surface_override_material(index,material.duplicate(true))
	for child in node.get_children(): make_resources_private(child)

func apply_snapshot(value: Dictionary, force: bool = false) -> void:
	if frozen and not force: return
	if value.get("scene_revision")!=scene_revision: return
	snapshot = value.duplicate(true)
	time_since_snapshot = 0
	behaviors.apply_states(value.get("object_states",{}))
	behaviors.update_contexts(value.get("players",{}).values(),int(value.get("tick",0)))
	behaviors.present({"kind":"snapshot","initial":false,"tick":value.get("tick",0)})
	var keep = {}
	for id in value.get("players",{}):
		var player = value.players[id]
		if not player.get("online",false): continue
		keep[id] = true
		if not avatars.has(id):
			avatars[id] = create_avatar(player)
			avatars[id].position = Factory.vec(player.position)
		elif force: avatars[id].position = Factory.vec(player.position)
	for id in avatars.keys():
		if not keep.has(id):
			avatars[id].queue_free()
			avatars.erase(id)

func material(color: Color) -> StandardMaterial3D:
	var mat = StandardMaterial3D.new()
	mat.albedo_color = color
	mat.roughness = .8
	return mat

func mesh_part(parent: Node3D, mesh: Mesh, color: Color, at: Vector3) -> MeshInstance3D:
	var part = MeshInstance3D.new()
	part.mesh = mesh
	part.material_override = material(color)
	parent.add_child(part)
	part.position = at
	return part

func create_avatar(player: Dictionary) -> Node3D:
	var avatar = Node3D.new()
	avatar.name = "Avatar_"+str(avatars.size())
	add_child(avatar)
	var body = Node3D.new()
	body.name = "Body"
	avatar.add_child(body)
	var color = Color.from_string(str(player.get("color","#80caff")),Color("80caff"))
	var torso = CapsuleMesh.new()
	torso.radius = .27
	torso.height = .78
	mesh_part(body,torso,color,Vector3(0,1,0))
	var head = SphereMesh.new()
	head.radius = .22
	head.height = .44
	head.radial_segments = 16
	head.rings = 8
	mesh_part(body,head,Color("ffe1bf"),Vector3(0,1.57,0))
	var visor = BoxMesh.new()
	visor.size = Vector3(.30,.08,.06)
	mesh_part(body,visor,Color("142436"),Vector3(0,1.6,.20))
	var legs = []
	for side in [-1,1]:
		var joint = Node3D.new()
		body.add_child(joint)
		joint.position = Vector3(side*.15,.65,0)
		var limb = CapsuleMesh.new()
		limb.radius = .09
		limb.height = .55
		mesh_part(joint,limb,Color("283a55"),Vector3(0,-.25,0))
		legs.append(joint)
		var arm = CapsuleMesh.new()
		arm.radius = .085
		arm.height = .58
		var part = mesh_part(body,arm,color.darkened(.1),Vector3(side*.34,1,0))
		part.rotation.z = side*-.12
	avatar.set_meta("legs",legs)
	var label = Label3D.new()
	label.font = FONT
	label.text = str(player.get("name","Creator")).left(40)
	label.font_size = 44
	label.pixel_size = .005
	label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	label.outline_size = 10
	label.modulate = color.lightened(.3)
	label.no_depth_test = true
	avatar.add_child(label)
	label.position.y = 2.0
	return avatar

func advance(delta: float) -> void:
	if frozen: return
	time_since_snapshot += delta
	behaviors.tick(delta)
	for id in avatars:
		if not snapshot.get("players",{}).has(id): continue
		var player = snapshot.players[id]
		var avatar: Node3D = avatars[id]
		var velocity = Factory.vec(player.get("velocity",[0,0,0]))
		var at = Factory.vec(player.position)+velocity*minf(time_since_snapshot,.1)
		avatar.position = avatar.position.lerp(at,1-exp(-18*delta))
		avatar.get_node("Body").rotation.y = lerp_angle(avatar.get_node("Body").rotation.y,float(player.get("yaw",0)),1-exp(-16*delta))
		var speed = Vector2(velocity.x,velocity.z).length()
		var phase = (float(snapshot.get("tick",0))/60+time_since_snapshot)*10
		var legs: Array = avatar.get_meta("legs")
		for i in range(legs.size()): legs[i].rotation.x = sin(phase+i*PI)*.55*minf(speed/5,1)

func apply_event(event: Dictionary) -> void:
	if frozen or event.get("scene_revision")!=scene_revision: return
	behaviors.present(event)

func freeze(value: bool) -> void:
	if frozen==value: return
	frozen = value
	behaviors.freeze(value)
	if content_root==null: return
	content_root.process_mode = Node.PROCESS_MODE_DISABLED if value else Node.PROCESS_MODE_INHERIT
	if value:
		frozen_particles.clear()
		frozen_process_modes.clear()
		inspection_canvas.clear()
		inspection_controls.clear()
		for node in content_root.find_children("*","",true,false):
			# Preserve animation playback position, speed, section and queue.
			# pause()/play() would restart callbacks and reset custom playback
			# options. Disabling processing also covers a child using ALWAYS.
			if node is CanvasLayer or node is CanvasItem:
				inspection_canvas.append({"node":node,"visible":node.visible})
			if node is Control:
				inspection_controls.append({"node":node,"mouse_filter":node.mouse_filter,"focus_mode":node.focus_mode})
				node.release_focus()
				node.mouse_filter = Control.MOUSE_FILTER_IGNORE
				node.focus_mode = Control.FOCUS_NONE
			frozen_process_modes.append({"node":node,"mode":node.process_mode})
			node.process_mode = Node.PROCESS_MODE_DISABLED
			if node is CPUParticles3D or node is GPUParticles3D:
				frozen_particles.append({"node":node,"speed":node.speed_scale})
				node.speed_scale = 0
	else:
		show_inspection_ui(true)
		for item in inspection_controls:
			if is_instance_valid(item.node):
				item.node.mouse_filter = item.mouse_filter
				item.node.focus_mode = item.focus_mode
		inspection_controls.clear()
		inspection_canvas.clear()
		for item in frozen_process_modes:
			if is_instance_valid(item.node): item.node.process_mode = item.mode
		frozen_process_modes.clear()
		for item in frozen_particles:
			if is_instance_valid(item.node): item.node.speed_scale = item.speed
		frozen_particles.clear()

func show_inspection_ui(value: bool) -> void:
	# Restore each original value, including controls intentionally hidden by the
	# game. Showing the inspection UI is read-only and never re-enables input.
	for item in inspection_canvas:
		if is_instance_valid(item.node): item.node.visible = value and item.visible

func rendered_players() -> Dictionary:
	var result = {}
	for id in avatars: result[id] = Factory.array3(avatars[id].position)
	return result
