extends Node3D
const Hierarchy = preload("res://hierarchy_scene.gd")
const Factory = preload("res://scene_factory.gd")
const Registry = preload("res://behavior_registry.gd")
const PLAYER_SPEED = 5.0
const GRAVITY = 20.0
var document: Dictionary = {}
var graph: Dictionary = {}
var world_limit = 1000.0
var definitions: Dictionary = {}
var objects: Dictionary = {}
var behaviors = Registry.new()
var players: Dictionary = {}
var saved_players: Dictionary = {}
var triggers: Dictionary = {}
var interaction_areas: Dictionary = {}
# Physical contact identity survives a disconnected/recreated CharacterBody3D.
# Creator-owned JSON membership may intentionally track only online players.
var trigger_contacts: Dictionary = {}
var legacy_contact_players: Array = []
var contact_reconcile_pending = false
var pending_trigger_signals: Array = []
var world_id = ""
var epoch = 0
var scene_revision = ""
var tick = 0
var sequence = 0
var event_sequence = 0
var pending_events: Array = []
var active = false
var assets: Array = []
var last_fault: Dictionary = {}

func initialize(prepared: Dictionary, state: Dictionary = {}) -> String:
	document = prepared.document
	graph = prepared.get("graph",{})
	world_limit = Hierarchy.WORLD_LIMIT if Hierarchy.enabled(document) else 1000.0
	for row in document.objects: definitions[row.id] = row
	objects = prepared.objects
	assets = prepared.assets
	add_child(prepared.root)
	tick = int(state.get("tick",0))
	sequence = int(state.get("sequence",0))
	event_sequence = int(state.get("event_sequence",0))
	saved_players = state.get("players",{}).duplicate(true)
	# Connection presence belongs to this authority incarnation. Restored
	# coordinates/progress/contact identity do not imply a current connection.
	for id in saved_players:
		saved_players[id].online = false
	var ground = StaticBody3D.new()
	ground.name = "WorldGround"
	ground.collision_layer = 1
	var floor_shape = CollisionShape3D.new()
	var floor_box = BoxShape3D.new()
	floor_box.size = Vector3(world_limit*2,.1,world_limit*2)
	floor_shape.shape = floor_box
	ground.add_child(floor_shape)
	ground.position.y = -.1
	add_child(ground)
	for row in document.objects:
		if row.get("solid",false) or row.get("components",{}).has("collider"): create_collider(row)
		if row.get("components",{}).has("trigger"): create_area(row,"trigger")
		if row.get("components",{}).has("interactable"): create_area(row,"interactable")
	var contact_error = restore_trigger_contacts(state)
	if not contact_error.is_empty(): return contact_error
	var error = behaviors.prepare(document,objects,prepared.sources,"authority",state.get("object_states",{}))
	if not error.is_empty(): return error
	return ""

func create_collider(row: Dictionary) -> void:
	var node: Node3D = objects[row.id]
	var component = row.get("components",{}).get("collider",{})
	var faces = PackedVector3Array()
	if component.get("shape","trimesh") == "box":
		var box = BoxMesh.new()
		box.size = Factory.vec(component.get("size",[1,1,1]))
		var transform = (global_transform.affine_inverse()*node.global_transform).translated_local(Factory.vec(component.get("offset",[0,0,0])))
		for vertex in box.get_faces(): faces.append(transform * vertex)
	else:
		for child in Hierarchy.owned_meshes(node):
			if child.mesh == null: continue
			# Bake the complete model/object TRS into vertices. Collision bodies
			# remain identity-scaled, including nonuniform imported transforms.
			var transform: Transform3D = global_transform.affine_inverse() * child.global_transform
			for vertex in child.mesh.get_faces(): faces.append(transform * vertex)
	if faces.is_empty(): return
	var body = StaticBody3D.new()
	body.name = "Collider_"+str(get_child_count())
	body.set_meta("object_id",row.id)
	body.collision_layer = 1
	var collision = CollisionShape3D.new()
	var shape = ConcavePolygonShape3D.new()
	shape.set_faces(faces)
	collision.shape = shape
	body.add_child(collision)
	add_child(body)

func create_area(row: Dictionary, kind: String) -> void:
	var data: Dictionary = row.components[kind]
	var object_transform: Transform3D = global_transform.affine_inverse()*objects[row.id].global_transform
	var object_scale = object_transform.basis.get_scale()
	var area = Area3D.new()
	area.name = "Area_"+str(get_child_count())
	# Layer 4 is query-only for restored capsule/trigger contact baselines.
	# Player bodies still collide solely with solid layer 1.
	area.collision_layer = 4 if kind == "trigger" else 0
	area.collision_mask = 2
	area.monitoring = true
	area.monitorable = false
	area.set_meta("object_id",row.id)
	var shape_node = CollisionShape3D.new()
	var shape: Shape3D
	if data.get("shape","sphere") == "box":
		shape = BoxShape3D.new()
		shape.size = Factory.vec(data.get("size",[2,2,2])) * object_scale
	else:
		shape = SphereShape3D.new()
		shape.radius = float(data.get("radius",2 if kind=="interactable" else 1)) * maxf(object_scale.x,maxf(object_scale.y,object_scale.z))
	shape_node.shape = shape
	area.add_child(shape_node)
	area.position = object_transform * Factory.vec(data.get("offset",[0,0,0]))
	area.basis = object_transform.basis.orthonormalized()
	add_child(area)
	if kind == "trigger":
		triggers[row.id] = area
		area.body_entered.connect(func(body): on_trigger(row.id,body,true))
		area.body_exited.connect(func(body): on_trigger(row.id,body,false))
	else: interaction_areas[row.id] = area

func on_trigger(object_id: String, body: Node3D, entered: bool) -> void:
	if not active or not body.has_meta("player_id"): return
	var id: String = body.get_meta("player_id")
	if players.has(id) and players[id].body == body:
		pending_trigger_signals.append({"object_id":object_id,"player_id":id,"body_id":body.get_instance_id(),"entered":entered})

func restore_trigger_contacts(state: Dictionary) -> String:
	var saved = state.get("trigger_contacts")
	if saved == null:
		# Old checkpoints have no platform contact ledger. A resume of exactly
		# that fixed scene may seed contacts from its saved capsule positions.
		# A fresh player or a different source revision is never inferred inside.
		if state.get("scene_revision","") == scene_revision and not scene_revision.is_empty():
			legacy_contact_players = saved_players.keys()
	else:
		if not saved is Dictionary or saved.get("schema") != 1 or not saved.get("members") is Dictionary or not saved.get("legacy_pending",[]) is Array:
			return "invalid trigger contact checkpoint"
		for object_id in saved.members:
			if not object_id is String or not saved.members[object_id] is Array: return "invalid trigger contact members"
			if not triggers.has(object_id): continue
			var members = []
			for id in saved.members[object_id]:
				if not id is String: return "invalid trigger contact player"
				if saved_players.has(id) and not id in members: members.append(id)
			trigger_contacts[object_id] = members
		for id in saved.get("legacy_pending",[]):
			if not id is String: return "invalid pending trigger contact player"
			if saved_players.has(id) and not id in legacy_contact_players and state.get("scene_revision","") == scene_revision:
				legacy_contact_players.append(id)
	contact_reconcile_pending = true
	return ""

func contacts_at(position: Vector3) -> Array:
	if triggers.is_empty(): return []
	var capsule = CapsuleShape3D.new()
	capsule.radius = .3
	capsule.height = 1.7
	var query = PhysicsShapeQueryParameters3D.new()
	query.shape = capsule
	query.transform = global_transform * Transform3D(Basis.IDENTITY,position+Vector3.UP*.85)
	query.collision_mask = 4
	query.collide_with_areas = true
	query.collide_with_bodies = false
	var result = []
	for hit in get_world_3d().direct_space_state.intersect_shape(query,triggers.size()):
		var area = hit.collider
		if area is Area3D and area.has_meta("object_id"):
			var id: String = area.get_meta("object_id")
			if triggers.get(id) == area: result.append(id)
	return result

func reconcile_trigger_contacts() -> void:
	# Called at an actual physics boundary, after the space has synchronized
	# shapes, before queued Area signals or creator tick callbacks are consumed.
	if contact_reconcile_pending:
		for id in saved_players:
			var previous = saved_players[id]
			if not Factory.vector_array(previous.get("position"),-world_limit,world_limit): continue
			var at = players[id].body.position if players.has(id) else Factory.vec(previous.position)
			var actual = contacts_at(at)
			for object_id in trigger_contacts:
				if id in trigger_contacts[object_id] and not object_id in actual:
					trigger_contacts[object_id].erase(id)
					if players.has(id): behaviors.trigger(object_id,player_snapshot(id),false)
			if id in legacy_contact_players:
				for object_id in actual:
					if not trigger_contacts.has(object_id): trigger_contacts[object_id] = []
					if not id in trigger_contacts[object_id]: trigger_contacts[object_id].append(id)
		legacy_contact_players.clear()
		contact_reconcile_pending = false
	for signal_row in pending_trigger_signals:
		var id: String = signal_row.player_id
		if not players.has(id) or players[id].body.get_instance_id()!=signal_row.body_id: continue
		var object_id: String = signal_row.object_id
		if not trigger_contacts.has(object_id): trigger_contacts[object_id] = []
		var inside = id in trigger_contacts[object_id]
		if inside == signal_row.entered: continue
		if signal_row.entered: trigger_contacts[object_id].append(id)
		else: trigger_contacts[object_id].erase(id)
		behaviors.trigger(object_id,player_snapshot(id),signal_row.entered)
	pending_trigger_signals.clear()

func spawn_position() -> Vector3:
	if Factory.vector_array(document.get("spawn_position"),-world_limit,world_limit): return Factory.vec(document.spawn_position)
	return Vector3(0,2,3)

func join(id: String, name_value: String, color: String) -> void:
	if players.has(id):
		players[id].name = name_value
		players[id].color = color
		return
	var body = CharacterBody3D.new()
	body.name = "Player_"+str(players.size())
	body.set_meta("player_id",id)
	body.collision_layer = 2
	body.collision_mask = 1
	body.floor_snap_length = .3
	body.floor_max_angle = deg_to_rad(48)
	var capsule = CapsuleShape3D.new()
	capsule.radius = .3
	capsule.height = 1.7
	var collider = CollisionShape3D.new()
	collider.shape = capsule
	collider.position.y = .85
	body.add_child(collider)
	var previous = saved_players.get(id,{})
	body.position = Factory.vec(previous.position) if Factory.vector_array(previous.get("position"),-world_limit,world_limit) else spawn_position()+Vector3(players.size()*.7,0,0)
	# CollisionObject3D registers its transform with the physics space when it
	# enters the tree. Register at the restored/spawn position: adding at the
	# origin first can queue an Area3D enter even when the body has moved away
	# before the signal is delivered. Do not suppress genuine first overlaps.
	add_child(body)
	players[id] = {"body":body,"name":name_value,"color":color,"move":Vector2.ZERO,"jump":false,"interact":false,"input_seq":int(previous.get("last_input_seq",0)),"last_input_seq":int(previous.get("last_input_seq",0)),"input_age":0.0,"yaw":float(previous.get("yaw",0)),"interactions":int(previous.get("interactions",0))}
	if saved_players.has(id): contact_reconcile_pending = true

func leave(id: String) -> void:
	if not players.has(id): return
	saved_players[id] = player_snapshot(id)
	saved_players[id].online = false
	players[id].body.queue_free()
	players.erase(id)

func accept_input(packet: Dictionary) -> bool:
	var id = packet.get("player_id","")
	if not players.has(id) or packet.get("epoch")!=epoch or packet.get("scene_revision")!=scene_revision: return false
	var seq_value = packet.get("input_seq")
	if not (seq_value is int or seq_value is float) or not is_finite(float(seq_value)) or seq_value != floorf(seq_value) or seq_value <= players[id].input_seq: return false
	var move = packet.get("move")
	if not move is Array or move.size()!=2: return false
	for n in move:
		if not (n is int or n is float) or not is_finite(float(n)): return false
	players[id].move = Vector2(move[0],move[1]).limit_length(1)
	players[id].jump = players[id].jump or packet.get("jump",false)==true
	players[id].interact = players[id].interact or packet.get("interact",false)==true
	players[id].input_seq = int(seq_value)
	players[id].input_age = 0.0
	return true

func step(delta: float) -> void:
	if not active: return
	tick += 1
	behaviors.update_contexts(player_list(),tick)
	reconcile_trigger_contacts()
	for id in players:
		var data = players[id]
		var body: CharacterBody3D = data.body
		data.input_age += delta
		if data.input_age>.4: data.move = Vector2.ZERO
		var direction: Vector2 = data.move
		body.velocity.x = direction.x*PLAYER_SPEED
		body.velocity.z = direction.y*PLAYER_SPEED
		if not body.is_on_floor(): body.velocity.y -= GRAVITY*delta
		elif data.jump: body.velocity.y = 8
		else: body.velocity.y = -.5
		data.jump = false
		body.move_and_slide()
		if body.position.y < -30 or absf(body.position.x)>world_limit or absf(body.position.z)>world_limit:
			body.position = spawn_position()
			body.velocity = Vector3.ZERO
		if direction.length_squared()>.001: data.yaw = atan2(direction.x,direction.y)
		data.last_input_seq = data.input_seq
		if data.interact:
			data.interact = false
			var nearest = nearest_interaction(body)
			if not nearest.is_empty():
				data.interactions += 1
				behaviors.interact(nearest,player_snapshot(id))
				pending_events.append({"kind":"interaction","object_id":nearest,"player_id":id,"data":{}})
	behaviors.tick(delta)
	pending_events.append_array(behaviors.take_events())
	if not behaviors.fault.is_empty() and behaviors.fault != last_fault:
		last_fault = behaviors.fault.duplicate(true)
		pending_events.append({"kind":"runtime_fault","data":last_fault})

func nearest_interaction(body: CharacterBody3D) -> String:
	var best = INF
	var result = ""
	for id in interaction_areas:
		var area: Area3D = interaction_areas[id]
		if not area.get_overlapping_bodies().has(body): continue
		var distance = area.position.distance_to(body.position+Vector3.UP*.85)
		if distance<best:
			best = distance
			result = id
	return result

func player_snapshot(id: String) -> Dictionary:
	var data = players[id]
	return {"id":id,"name":data.name,"color":data.color,"position":Factory.array3(data.body.position),"velocity":Factory.array3(data.body.velocity),"yaw":data.yaw,"online":true,"last_input_seq":data.last_input_seq,"interactions":data.interactions,"grounded":data.body.is_on_floor()}

func player_list() -> Array:
	var result = []
	for id in players: result.append(player_snapshot(id))
	return result

func snapshot(advance: bool = false) -> Dictionary:
	if advance: sequence += 1
	var all_players = saved_players.duplicate(true)
	for id in players: all_players[id] = player_snapshot(id)
	return {"world_id":world_id,"epoch":epoch,"scene_revision":scene_revision,"sequence":sequence,"tick":tick,"event_sequence":event_sequence,"players":all_players,"object_states":behaviors.snapshot(),"trigger_contacts":{"schema":1,"members":trigger_contacts.duplicate(true),"legacy_pending":legacy_contact_players.duplicate()},"module_assets":behaviors.hashes,"runtime_fault":last_fault}

func take_events() -> Array:
	var events = []
	for value in pending_events:
		event_sequence += 1
		var event: Dictionary = value.duplicate(true)
		if definitions.has(event.get("object_id","")): Hierarchy.add_identity(event,definitions[event.object_id])
		event.merge({"world_id":world_id,"epoch":epoch,"scene_revision":scene_revision,"sequence":event_sequence,"tick":tick},true)
		events.append(event)
	pending_events.clear()
	return events

func scene_observation() -> Dictionary:
	if graph.is_empty():return {}
	var result=Hierarchy.graph_observation(graph,definitions,document.hierarchy_pack.pack_hash)
	result.physics=[]
	for kind in ["trigger","interactable"]:
		for id in triggers if kind=="trigger" else interaction_areas:
			var area: Area3D=triggers[id] if kind=="trigger" else interaction_areas[id]
			var shape: Shape3D=area.get_child(0).shape
			var row={"id":id,"address":definitions[id].address.duplicate(true),"kind":kind,"world_matrix":Hierarchy.matrix(area.global_transform),"shape":"box" if shape is BoxShape3D else "sphere"}
			if shape is BoxShape3D:row.size=Factory.array3(shape.size)
			else:row.radius=shape.radius
			result.physics.append(row)
	for child in get_children():
		if child is StaticBody3D and child.has_meta("object_id"):
			var id: String=child.get_meta("object_id")
			result.physics.append({"id":id,"address":definitions[id].address.duplicate(true),"kind":"collider","shape":"baked_trimesh","world_matrix":Hierarchy.matrix(child.global_transform),"faces":child.get_child(0).shape.get_faces().size()/3})
	return result
