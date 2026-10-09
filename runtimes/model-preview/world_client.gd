extends Node
const WorldProjection = preload("res://world_projection.gd")
const Simulation = preload("res://world_simulation.gd")
const SceneLoader = preload("res://scene_loader.gd")
const Hierarchy = preload("res://hierarchy_scene.gd")
const Factory = preload("res://scene_factory.gd")
const FONT = preload("res://fonts/CreatorUI.tres")
var local_preview = false
var local_simulation: Node3D
var local_generation = 0
var inspection_ui_visible = false
var play_camera: Camera3D
var play_camera_settings: Dictionary = {}
var host: Node3D
var projection: Node3D
var mode = "editing"
var player_id = ""
var world_id = ""
var epoch = 0
var latest: Dictionary = {}
var documents: Dictionary = {}
var document_order: Array = []
var input_seq = 0
var input_clock = 0.0
var last_move = Vector2(INF,INF)
var jump_pending = false
var interact_pending = false
var stop_seq = 0
var stop_ack_sequence = 0
var mode_request = ""
var preparing = false
var wanted_play = false
var state_clock = 0.0
var last_event_sequence = 0
var original_camera: Dictionary = {}
var hud: Label
var loaded_generation = 0
var stop_clock = 0.0
var focused = true
var suppress_until_release = false
var ui_held: Dictionary = {}
var ui_pulses: Dictionary = {}
const UI_DIRECTIONS = {"forward":Vector2(0,-1),"backward":Vector2(0,1),"left":Vector2(-1,0),"right":Vector2(1,0)}

func setup(parent: Node3D) -> void:
	host = parent
	projection = WorldProjection.new()
	host.add_child(projection)
	projection.visible = false
	var overlay = CanvasLayer.new()
	add_child(overlay)
	hud = Label.new()
	hud.add_theme_font_override("font",FONT)
	hud.add_theme_font_size_override("font_size",16)
	hud.add_theme_color_override("font_color",Color("e6f4ff"))
	hud.add_theme_color_override("font_outline_color",Color("0d1520"))
	hud.add_theme_constant_override("outline_size",4)
	hud.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hud.position = Vector2(16,16)
	hud.visible = false
	overlay.add_child(hud)

func document_loaded(packet: Dictionary) -> void:
	var revision = str(packet.get("scene_revision",""))
	if revision.is_empty(): return
	documents[revision] = packet.duplicate(true)
	if not revision in document_order: document_order.append(revision)
	while document_order.size()>8:
		var oldest = document_order.pop_front()
		if oldest != projection.scene_revision: documents.erase(oldest)
	for revision_key in documents.keys():
		if revision_key not in document_order and revision_key!=projection.scene_revision: documents.erase(revision_key)
	if wanted_play and not latest.is_empty(): try_play()

func receive(packet: Dictionary) -> void:
	match packet.get("action"):
		"local_start":
			start_local(packet)
		"inspection_ui":
			if mode=="inspecting" and packet.get("world_id")==world_id and packet.get("epoch")==epoch and packet.get("visible") is bool:
				inspection_ui_visible = packet.visible
				projection.show_inspection_ui(inspection_ui_visible)
				emit_state()
		"control":
			receive_ui_control(packet)
		"join":
			dispose_local()
			local_preview = false
			if not packet.get("snapshot") is Dictionary: return
			host.cancel_drag()
			clear_ui_controls()
			world_id = str(packet.get("world_id",packet.snapshot.get("world_id","")))
			epoch = int(packet.get("epoch",packet.snapshot.get("epoch",0)))
			player_id = str(packet.get("player_id",""))
			latest = {}
			if packet.get("scene") is Dictionary: document_loaded(packet.scene)
			original_camera = {"target":host.target,"yaw":host.yaw,"pitch":host.pitch,"distance":host.distance,"view":host.camera_view,"projection":host.camera.projection,"size":host.camera.size}
			wanted_play = true
			mode = "preparing_play"
			receive_snapshot(packet.snapshot)
			emit_state()
		"snapshot":
			if local_preview: return
			if packet.get("snapshot") is Dictionary: receive_snapshot(packet.snapshot)
		"events":
			if local_preview: return
			for event in packet.get("events",[]):
				if event.get("world_id")!=world_id or event.get("epoch")!=epoch or int(event.get("sequence",0))<=last_event_sequence: continue
				last_event_sequence = int(event.sequence)
				if mode=="playing": projection.apply_event(event)
		"mode":
			if packet.has("world_id") and packet.world_id!=world_id: return
			if packet.has("epoch") and packet.epoch!=epoch: return
			change_mode(str(packet.get("mode","")),str(packet.get("request_id","")))
		"leave":
			change_mode("editing",str(packet.get("request_id","")))
			dispose_local()
			world_id = ""
			player_id = ""
			latest = {}
			wanted_play = false

# Each editor run owns fresh physics, behavior state and input sequencing. It
# never restores a shared checkpoint or sends gameplay input to the service.
func start_local(packet: Dictionary) -> void:
	if not packet.get("scene") is Dictionary or str(packet.get("world_id","")).is_empty(): return
	dispose_local()
	local_preview = true
	local_generation += 1
	var generation = local_generation
	host.cancel_drag()
	clear_ui_controls()
	world_id = str(packet.world_id)
	epoch = int(packet.get("epoch",1))
	player_id = str(packet.get("player_id","local-player"))
	mode_request = str(packet.get("request_id",""))
	original_camera = {"target":host.target,"yaw":host.yaw,"pitch":host.pitch,"distance":host.distance,"view":host.camera_view,"projection":host.camera.projection,"size":host.camera.size}
	latest = {}
	input_seq = 0
	last_event_sequence = 0
	mode = "preparing_play"
	wanted_play = true
	emit_state()
	var loader = SceneLoader.new()
	for asset in host.asset_cache.values(): loader.asset_cache[asset.hash] = asset
	var candidate = await loader.prepare(self,packet.scene,host.origin)
	if generation!=local_generation:
		if candidate.ok: candidate.root.free()
		return
	if not candidate.ok:
		wanted_play = false
		emit_state(str(candidate.error))
		return
	local_simulation = Simulation.new()
	local_simulation.visible = false
	local_simulation.world_id = world_id
	local_simulation.epoch = epoch
	local_simulation.scene_revision = str(packet.scene.scene_revision)
	add_child(local_simulation)
	var problem: String = local_simulation.initialize(candidate)
	if not problem.is_empty():
		dispose_local()
		wanted_play = false
		emit_state(problem)
		return
	local_simulation.join(player_id,str(packet.get("player_name","玩家")),str(packet.get("player_color","#80caff")))
	projection.loader.asset_cache = loader.asset_cache
	projection.loader.source_cache = loader.source_cache
	document_loaded(packet.scene)
	receive_snapshot(local_simulation.snapshot())

func dispose_local() -> void:
	local_generation += 1
	if local_simulation!=null:
		local_simulation.active = false
		local_simulation.behaviors.dispose()
		remove_child(local_simulation)
		local_simulation.queue_free()
		local_simulation = null

func _physics_process(delta: float) -> void:
	if local_simulation==null or not local_simulation.active: return
	local_simulation.step(delta)
	receive_snapshot(local_simulation.snapshot(true))
	for event in local_simulation.take_events():
		if mode=="playing": projection.apply_event(event)

func enter_inspection() -> void:
	play_camera = host.get_viewport().get_camera_3d()
	play_camera_settings = {"target":host.target,"yaw":host.yaw,"pitch":host.pitch,"distance":host.distance,"view":host.camera_view,"projection":host.camera.projection,"size":host.camera.size,"fov":host.camera.fov}
	projection.freeze(true)
	if local_simulation!=null:
		local_simulation.active = false
		local_simulation.process_mode = Node.PROCESS_MODE_DISABLED
	inspection_ui_visible = false
	projection.show_inspection_ui(false)
	# Creator scripts can install a current Camera3D. Explicitly transfer that
	# view to the editor camera; moving a non-current camera has no visible effect.
	if is_instance_valid(play_camera) and play_camera!=host.camera:
		host.camera.global_transform = play_camera.global_transform
		host.camera.projection = play_camera.projection
		host.camera.size = play_camera.size
		host.camera.fov = play_camera.fov
		var back: Vector3 = play_camera.global_basis.z.normalized()
		host.distance = maxf(.25,host.distance)
		host.target = play_camera.global_position-back*host.distance
		host.yaw = atan2(back.x,back.z)
		host.pitch = asin(clampf(back.y,-1,1))
		host.camera_view = "top" if back.y>.9999 else "perspective"
	host.camera.make_current()
	host.emit_camera()

func restore_play_camera() -> void:
	if local_simulation!=null: local_simulation.process_mode = Node.PROCESS_MODE_INHERIT
	if not play_camera_settings.is_empty():
		host.target = play_camera_settings.target
		host.yaw = play_camera_settings.yaw
		host.pitch = play_camera_settings.pitch
		host.distance = play_camera_settings.distance
		host.camera_view = play_camera_settings.view
		host.camera.projection = play_camera_settings.projection
		host.camera.size = play_camera_settings.size
		host.camera.fov = play_camera_settings.fov
		host.update_camera()
	if is_instance_valid(play_camera): play_camera.make_current()
	play_camera = null
	play_camera_settings.clear()

func valid_snapshot(value: Dictionary) -> bool:
	if value.get("world_id")!=world_id or not value.get("players") is Dictionary: return false
	if value.get("epoch")!=epoch: return false
	if not value.get("scene_revision") is String: return false
	var sequence = value.get("sequence")
	if not (sequence is int or sequence is float) or not is_finite(float(sequence)) or sequence<0: return false
	for player in value.players.values():
		if not player is Dictionary or not Factory.vector_array(player.get("position"),-Hierarchy.WORLD_LIMIT,Hierarchy.WORLD_LIMIT) or not Factory.vector_array(player.get("velocity",[0,0,0])): return false
	return true

func receive_snapshot(value: Dictionary) -> void:
	if not valid_snapshot(value): return
	if not latest.is_empty() and value.sequence<=latest.sequence: return
	latest = value.duplicate(true)
	var me: Dictionary = latest.players.get(player_id,{})
	input_seq = maxi(input_seq,int(me.get("last_input_seq",0)))
	if mode=="playing" or mode=="entering_inspect":
		if projection.scene_revision==latest.scene_revision: projection.apply_snapshot(latest)
		elif mode=="playing":
			wanted_play = true
			mode = "resyncing"
			last_move = Vector2(INF,INF)
			try_play()
		if mode=="entering_inspect" and int(me.get("last_input_seq",-1))>=stop_seq:
			stop_ack_sequence = int(latest.sequence)
			enter_inspection()
			mode = "inspecting"
			host.helpers.visible = true
			host.update_helpers()
			emit_state()
	elif wanted_play: try_play()

func change_mode(value: String, request_id: String = "") -> void:
	if value not in ["playing","inspecting","editing"]: return
	host.cancel_drag()
	clear_ui_controls()
	mode_request = request_id
	jump_pending = false
	interact_pending = false
	if value=="inspecting":
		if mode=="playing":
			wanted_play = false
			mode = "entering_inspect"
			stop_clock = 0
			stop_seq = send_input(Vector2.ZERO,false,false)
			emit_state()
		elif mode=="inspecting": emit_state()
	elif value=="playing":
		if latest.is_empty(): return
		wanted_play = true
		mode = "resyncing" if projection.frozen else "preparing_play"
		emit_state()
		try_play()
	else:
		if not world_id.is_empty(): send_input(Vector2.ZERO,false,false)
		wanted_play = false
		loaded_generation += 1
		mode = "editing"
		projection.visible = false
		host.scene_root.visible = true
		host.editable = host.latest_scene_editable and host.mode=="main"
		host.helpers.visible = true
		host.update_helpers()
		if not original_camera.is_empty():
			host.target = original_camera.target
			host.yaw = original_camera.yaw
			host.pitch = original_camera.pitch
			host.distance = original_camera.distance
			host.camera_view = original_camera.view
			host.camera.projection = original_camera.projection
			host.camera.size = original_camera.size
			host.update_camera()
		emit_state()

func try_play() -> void:
	if not wanted_play or preparing or latest.is_empty(): return
	var revision: String = latest.scene_revision
	if not documents.has(revision):
		emit_state("Waiting for matching playable scene resources")
		return
	preparing = true
	loaded_generation += 1
	var generation = loaded_generation
	var okay = true
	if projection.scene_revision!=revision:
		okay = await projection.prepare(documents[revision],latest,host)
	if generation!=loaded_generation:
		preparing = false
		return
	if not okay:
		preparing = false
		if projection.error=="superseded":
			if wanted_play: try_play()
			return
		wanted_play = false
		mode = "inspecting" if projection.content_root!=null else "editing"
		if mode=="inspecting": projection.freeze(true)
		host.helpers.visible = true
		emit_state(projection.error)
		return
	if revision!=latest.scene_revision:
		preparing = false
		try_play()
		return
	var was_frozen = projection.frozen
	projection.freeze(false)
	projection.apply_snapshot(latest,true)
	projection.visible = true
	host.scene_root.visible = false
	host.editable = false
	host.helpers.visible = false
	mode = "playing"
	wanted_play = false
	preparing = false
	last_move = Vector2(INF,INF)
	if was_frozen:
		suppress_until_release = true
		restore_play_camera()
	if local_simulation!=null: local_simulation.active = true
	host.camera_view = "perspective"
	host.camera.projection = Camera3D.PROJECTION_PERSPECTIVE
	host.distance = 7
	host.pitch = .4
	last_event_sequence = int(latest.get("event_sequence",0))
	send_input(Vector2.ZERO,false,false)
	emit_state()

func send_input(move: Vector2, jump: bool, interact: bool) -> int:
	if world_id.is_empty() or latest.is_empty(): return input_seq
	input_seq += 1
	var packet = {"type":"player_input","world_id":world_id,"epoch":epoch,"scene_revision":latest.scene_revision,"player_id":player_id,"input_seq":input_seq,"move":[move.x,move.y],"jump":jump,"interact":interact}
	if local_preview:
		if local_simulation!=null: local_simulation.accept_input(packet)
	else: host.emit(packet)
	last_move = move
	input_clock = 0
	return input_seq

func clear_ui_controls() -> void:
	ui_held.clear()
	ui_pulses.clear()

func receive_ui_control(packet: Dictionary) -> void:
	# Parent DOM controls are normal player intents. They never set transforms
	# or bypass authority. A hidden/unfocused iframe may receive accessible UI
	# intents, so keyboard focus and this explicit parent intent are separate.
	if mode!="playing" or packet.get("world_id")!=world_id or packet.get("epoch")!=epoch or packet.get("scene_revision")!=latest.get("scene_revision"): return
	var control: String = str(packet.get("control",""))
	var kind: String = str(packet.get("kind",""))
	if kind not in ["tap","start","end","cancel"]: return
	if control=="stop" or kind=="cancel":
		clear_ui_controls()
		suppress_until_release = true
		jump_pending = false
		interact_pending = false
		send_input(Vector2.ZERO,false,false)
	elif UI_DIRECTIONS.has(control):
		if kind=="end":
			ui_held.erase(control)
			ui_pulses.erase(control)
			send_input(Vector2.ZERO,false,false)
		elif kind=="tap": ui_pulses[control] = .12
		elif kind=="start": ui_held[control] = .4
	elif kind=="tap":
		if control=="jump": jump_pending = true
		elif control=="interact": interact_pending = true

func ui_direction(delta: float) -> Vector2:
	var direction = Vector2.ZERO
	for collection in [ui_held,ui_pulses]:
		for control in collection.keys():
			collection[control] -= delta
			if collection[control]<=0: collection.erase(control)
			else: direction += UI_DIRECTIONS[control]
	return direction.limit_length(1)

func _process(delta: float) -> void:
	if host==null: return
	input_clock += delta
	state_clock += delta
	if mode=="entering_inspect": stop_clock += delta
	if mode=="playing" or mode=="entering_inspect":
		projection.advance(delta)
		if projection.avatars.has(player_id):
			var previous_camera: Vector3 = host.camera.position
			var at: Vector3 = projection.avatars[player_id].position+Vector3.UP*1.1
			host.target = host.target.lerp(at,1-exp(-12*delta))
			host.update_camera()
			if host.elapsed-host.last_camera_emit>.1 and host.camera.position.distance_squared_to(previous_camera)>.000001:
				host.emit_camera()
	if mode=="playing":
		var input = Vector2.ZERO
		if Input.is_physical_key_pressed(KEY_W): input.y -= 1
		if Input.is_physical_key_pressed(KEY_S): input.y += 1
		if Input.is_physical_key_pressed(KEY_A): input.x -= 1
		if Input.is_physical_key_pressed(KEY_D): input.x += 1
		if suppress_until_release and input==Vector2.ZERO: suppress_until_release = false
		if not focused or suppress_until_release: input = Vector2.ZERO
		input = (input+ui_direction(delta)).limit_length(1)
		var forward = -host.camera.global_basis.z
		forward.y = 0
		forward = forward.normalized()
		var right = host.camera.global_basis.x
		right.y = 0
		right = right.normalized()
		var movement = (right*input.x-forward*input.y).limit_length(1)
		var move = Vector2(movement.x,movement.z)
		if move!=last_move or (move.length_squared()>0 and input_clock>.1) or jump_pending or interact_pending:
			send_input(move,jump_pending,interact_pending)
			jump_pending = false
			interact_pending = false
	if mode=="entering_inspect" and stop_clock>3 and state_clock>.25:
		emit_state("Waiting for authority to acknowledge stopped input")
	if state_clock>.25 and mode!="editing": emit_state()
	update_hud()

func input(event: InputEvent) -> bool:
	if mode!="playing" and mode!="entering_inspect": return false
	if event is InputEventKey:
		if event.pressed and not event.echo:
			var key = event.physical_keycode if event.physical_keycode else event.keycode
			if key==KEY_SPACE: jump_pending = true
			if key==KEY_E: interact_pending = true
		return true
	# Forward camera pointer gestures through the existing validated editor
	# camera path; no transform tool is enabled during play.
	return false

func set_focused(value: bool) -> void:
	focused = value
	if not value:
		clear_ui_controls()
		suppress_until_release = true
		jump_pending = false
		interact_pending = false
		if mode=="playing": send_input(Vector2.ZERO,false,false)

func update_hud() -> void:
	hud.visible = mode!="editing" and mode!="inspecting"
	if not hud.visible: return
	var ratio = host.gizmo.pixel_ratio
	hud.add_theme_font_size_override("font_size",roundi(14*ratio))
	hud.position = Vector2(14,14)*ratio
	if mode=="playing":
		var interaction = ""
		if projection.avatars.has(player_id):
			var at: Vector3 = projection.avatars[player_id].position
			for id in projection.definitions:
				var component: Dictionary = projection.definitions[id].get("components",{}).get("interactable",{})
				if not component.is_empty() and at.distance_to(projection.objects[id].global_position)<float(component.get("radius",2))+.7:
					interaction = "\nE · "+str(component.get("label","交互"))
					break
		hud.text = "WASD 移动 · 空格跳跃 · 右键转向"+interaction
	elif mode=="inspecting": hud.text = "个人检查 · 世界仍在运行\n冻结 #%s / 最新 #%s"%[projection.snapshot.get("sequence",0),latest.get("sequence",0)]
	else: hud.text = "正在同步世界…"
	var fault = observed_fault()
	if not fault.is_empty():
		hud.text += "\n行为错误 · "+str(fault.get("object_id",""))+" / "+str(fault.get("component_id",""))

func observed_fault() -> Dictionary:
	if not projection.behaviors.fault.is_empty():
		var fault: Dictionary = projection.behaviors.fault.duplicate(true)
		fault.role = "presentation"
		return fault
	if not latest.get("runtime_fault",{}).is_empty():
		var fault: Dictionary = latest.runtime_fault.duplicate(true)
		fault.role = "authority"
		return fault
	return {}

func emit_state(error: String = "") -> void:
	state_clock = 0
	var fault = observed_fault()
	if error.is_empty() and not fault.is_empty(): error = str(fault.role)+" behavior failed: "+str(fault.get("error","")).left(500)
	var packet = {"type":"world_state","world_id":world_id,"epoch":epoch,"scene_revision":projection.scene_revision,"mode":mode,"request_id":mode_request,"player_id":player_id,"applied_sequence":projection.snapshot.get("sequence",0),"latest_sequence":latest.get("sequence",0),"latest_revision":latest.get("scene_revision",""),"control_ready":mode=="playing","error":error,"runtime_fault":fault}
	packet.session_kind = "local_preview" if local_preview else "shared_world"
	packet.inspection_ui_visible = inspection_ui_visible if mode=="inspecting" else true
	if local_preview: packet.object_states = projection.snapshot.get("object_states",{})
	packet.tick = projection.snapshot.get("tick",0)
	packet.latest_tick = latest.get("tick",0)
	packet.player_position = Factory.array3(projection.avatars[player_id].position) if projection.avatars.has(player_id) else projection.snapshot.get("players",{}).get(player_id,{}).get("position",null)
	packet.authoritative_player_position = latest.get("players",{}).get(player_id,{}).get("position",null)
	if projection.frozen:
		packet.frozen_tick = projection.snapshot.get("tick",0)
		packet.frozen_revision = projection.scene_revision
		packet.frozen_sequence = projection.snapshot.get("sequence",0)
		packet.input_zero_seq = stop_seq
		packet.stop_ack_sequence = stop_ack_sequence
		packet.inspection_objects = []
		for id in projection.objects:
			var node: Node3D = projection.objects[id]
			if not projection.graph.is_empty():
				packet.inspection_objects.append(Hierarchy.observation(id,node,projection.definitions[id]))
				continue
			packet.inspection_objects.append({"id":id,"position":Factory.array3(node.position),"rotation":Factory.array3(node.rotation_degrees),"scale":Factory.array3(node.scale),"model_hash":projection.definitions[id].get("model_hash","")})
		packet.frozen = {"sequence":projection.snapshot.get("sequence",0),"tick":projection.snapshot.get("tick",0),"scene_revision":projection.scene_revision,"asset_hashes":projection.asset_hashes,"rendered_players":projection.rendered_players()}
	host.emit(packet)
