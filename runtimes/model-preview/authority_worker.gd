extends Node
const Capabilities = preload("res://runtime_capabilities.gd")
const Loader = preload("res://scene_loader.gd")
const Simulation = preload("res://world_simulation.gd")
const Factory = preload("res://scene_factory.gd")
const Registry = preload("res://behavior_registry.gd")
const ClientProjection = preload("res://world_projection.gd")
var loader = Loader.new()
var peer = WebSocketPeer.new()
var simulation: Node3D
var world_view: SubViewport
var prepared_generation = 0
var snapshot_clock = 0.0
var ever_connected = false
var authority_mode = true
var options: Dictionary = {}
var latest_request = ""
var validate_result: Dictionary = {}

func start(arguments: Dictionary) -> void:
	options = arguments
	if options.has("validate-scene"):
		authority_mode = false
		validate_file.call_deferred()
		return
	peer.inbound_buffer_size = 32*1024*1024
	peer.outbound_buffer_size = 32*1024*1024
	peer.handshake_headers = PackedStringArray(["Authorization: Bearer "+OS.get_environment("WA_WORKER_TOKEN")])
	var address = OS.get_environment("WA_WORKER_URL")
	if not address.begins_with("ws://127.0.0.1:") and not address.begins_with("ws://localhost:"):
		push_error("worker requires loopback WA_WORKER_URL")
		get_tree().quit(2)
		return
	var result = peer.connect_to_url(address)
	if result != OK:
		push_error("worker connection could not start")
		get_tree().quit(2)

func _process(_delta: float) -> void:
	if not authority_mode: return
	peer.poll()
	if peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		if not ever_connected:
			ever_connected = true
			send({"type":"worker_hello","protocol":1,"pid":OS.get_process_id(),"runtime_version":Capabilities.VERSION})
		while peer.get_available_packet_count()>0:
			var message = JSON.parse_string(peer.get_packet().get_string_from_utf8())
			if message is Dictionary: receive(message)
	elif peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
		# An unconnected worker must not continue an orphan authority timeline.
		get_tree().quit(0 if ever_connected else 2)

func _physics_process(delta: float) -> void:
	if simulation == null or not simulation.active: return
	simulation.step(delta)
	var events = simulation.take_events()
	if not events.is_empty(): send({"type":"world_events","events":events})
	snapshot_clock += delta
	if snapshot_clock>=.1:
		snapshot_clock = 0
		send({"type":"world_snapshot","snapshot":simulation.snapshot(true)})

func receive(packet: Dictionary) -> void:
	match packet.get("type"):
		"init", "apply_scene":
			prepared_generation += 1
			latest_request = str(packet.get("request_id",""))
			prepare_world(packet,prepared_generation)
		"join":
			if simulation != null:
				simulation.join(str(packet.get("player_id","")),str(packet.get("name","Creator")),str(packet.get("color","#70d2ff")))
		"leave":
			if simulation != null: simulation.leave(str(packet.get("player_id","")))
		"input":
			if simulation != null: simulation.accept_input(packet)
		"checkpoint":
			send({"type":"checkpoint","request_id":packet.get("request_id",""),"ok":simulation!=null,"snapshot":simulation.snapshot() if simulation!=null else {}})
		"shutdown":
			if simulation!=null: send({"type":"checkpoint","request_id":packet.get("request_id",""),"ok":true,"snapshot":simulation.snapshot()})
			get_tree().quit(0)

func new_world_view() -> SubViewport:
	var view = SubViewport.new()
	view.size = Vector2i(16,16)
	view.own_world_3d = true
	view.render_target_update_mode = SubViewport.UPDATE_DISABLED
	add_child(view)
	return view

func prepare_world(packet: Dictionary, generation: int) -> void:
	var type = "world_ready" if packet.type=="init" else "applied"
	var scene = packet.get("scene",{})
	var origin = scene.get("origin",packet.get("origin",""))
	var prepared = await loader.prepare(self,scene,origin)
	if generation != prepared_generation:
		if prepared.ok: prepared.root.free()
		return
	if not prepared.ok:
		send({"type":type,"request_id":packet.get("request_id",""),"ok":false,"error":prepared.error,"code":prepared.get("code",""),"snapshot":simulation.snapshot() if simulation!=null else {}})
		return
	var view = new_world_view()
	var candidate = Simulation.new()
	view.add_child(candidate)
	candidate.world_id = str(packet.get("world_id",simulation.world_id if simulation!=null else ""))
	candidate.epoch = int(packet.get("epoch",simulation.epoch if simulation!=null else 1))
	candidate.scene_revision = str(packet.get("scene_revision",""))
	var previous = simulation.snapshot() if simulation!=null else packet.get("state",{})
	var error = candidate.initialize(prepared,previous)
	if not error.is_empty():
		view.queue_free()
		send({"type":type,"request_id":packet.get("request_id",""),"ok":false,"error":error,"snapshot":simulation.snapshot() if simulation!=null else {}})
		return
	# Resources and each initialization callback have succeeded in an isolated
	# World3D. Root performs the standalone multi-frame candidate validation.
	if simulation!=null:
		for player in simulation.player_list(): candidate.join(player.id,player.name,player.color)
	var old_view = world_view
	if simulation!=null: simulation.active = false
	world_view = view
	simulation = candidate
	simulation.active = true
	if old_view!=null: old_view.queue_free()
	send({"type":type,"request_id":packet.get("request_id",""),"ok":true,"scene_revision":candidate.scene_revision,"scene_graph":candidate.scene_observation(),"assets":prepared.assets,"module_assets":candidate.behaviors.hashes,"snapshot":candidate.snapshot(true)})

func send(packet: Dictionary) -> void:
	if packet.get("type") in ["worker_hello","world_ready","applied"]:packet.runtime_capabilities=Capabilities.read()
	if authority_mode and peer.get_ready_state()==WebSocketPeer.STATE_OPEN:
		var code = peer.send_text(JSON.stringify(packet))
		if code!=OK:
			push_error("worker transport send failed")
			get_tree().quit(2)

func validate_file() -> void:
	get_tree().create_timer(30).timeout.connect(func(): finish_validation(false,"validation timeout"))
	var packet = JSON.parse_string(FileAccess.get_file_as_string(str(options["validate-scene"])))
	if not packet is Dictionary:
		finish_validation(false,"invalid candidate JSON")
		return
	var document = packet.get("scene",packet)
	var origin = document.get("origin",packet.get("origin",options.get("origin","")))
	var loaded = await loader.prepare(self,document,origin)
	if not loaded.ok:
		validate_result["code"]=loaded.get("code","")
		finish_validation(false,loaded.error)
		return
	var view = new_world_view()
	var candidate = Simulation.new()
	view.add_child(candidate)
	candidate.world_id = "isolated-validation"
	candidate.epoch = 1
	candidate.scene_revision = str(packet.get("scene_revision","candidate"))
	var error = candidate.initialize(loaded,packet.get("state",{}))
	if not error.is_empty():
		finish_validation(false,error)
		return
	for existing in packet.get("state",{}).get("players",{}).values():
		if existing.get("online",false): candidate.join(existing.id,existing.get("name","Creator"),existing.get("color","#80cdf6"))
	candidate.join("validation-player","Validation","#80cdf6")
	candidate.active = true
	for i in range(20):
		await get_tree().physics_frame
		candidate.accept_input({"player_id":"validation-player","epoch":1,"scene_revision":candidate.scene_revision,"input_seq":i+1,"move":[.25,0],"jump":false,"interact":i==10})
		candidate.step(1.0/60)
		if not candidate.behaviors.fault.is_empty():
			finish_validation(false,str(candidate.behaviors.fault))
			return
	# Exercise declared lifecycle signatures only in this isolated candidate.
	var actor = candidate.player_snapshot("validation-player")
	for object in candidate.document.objects:
		if object.get("components",{}).has("interactable"): candidate.behaviors.interact(object.id,actor)
		if object.get("components",{}).has("trigger"):
			candidate.behaviors.trigger(object.id,actor,true)
			candidate.behaviors.trigger(object.id,actor,false)
	if not candidate.behaviors.fault.is_empty():
		finish_validation(false,str(candidate.behaviors.fault))
		return
	var snapshot = candidate.snapshot(true)
	if not Factory.vector_array(snapshot.players["validation-player"].position,-candidate.world_limit,candidate.world_limit):
		finish_validation(false,"invalid physics position")
		return
	# Validate the second role against real, separate presentation nodes too.
	# A script that only fails in present()/freeze() must not pass publication
	# merely because its authority callbacks do not touch visual APIs.
	var presentation_view = new_world_view()
	var presentation = ClientProjection.new()
	presentation_view.add_child(presentation)
	var presentation_root: Node3D = loaded.root.duplicate()
	presentation.add_child(presentation_root)
	presentation.make_resources_private(presentation_root)
	var presentation_objects = {}
	for node in presentation_root.find_children("*","Node3D",true,false):
		if node.has_meta("object_id"): presentation_objects[node.get_meta("object_id")] = node
	var registry = Registry.new()
	error = registry.prepare(loaded.document,presentation_objects,loaded.sources,"presentation",snapshot.object_states)
	if not error.is_empty():
		finish_validation(false,"presentation: "+error)
		return
	registry.update_contexts(snapshot.players.values(),snapshot.tick)
	registry.present({"kind":"snapshot","initial":true,"tick":snapshot.tick})
	for event in candidate.take_events(): registry.present(event)
	for i in range(20):
		registry.tick(1.0/60)
		if not registry.fault.is_empty(): break
	registry.freeze(true)
	registry.freeze(false)
	registry.dispose()
	if not registry.fault.is_empty():
		finish_validation(false,"presentation: "+str(registry.fault))
		return
	validate_result = {"scene_graph":candidate.scene_observation(),"snapshot":snapshot,"assets":loaded.assets,"module_assets":candidate.behaviors.hashes,"checks":["schema_hash_http","real_gltf_nodes","real_collision_world","20_physics_frames","character_move_and_slide","declared_authority_callbacks","presentation_initialize_snapshot_events","20_presentation_ticks","presentation_freeze_resume_dispose"],"scope":"isolated Godot authority and presentation initialization/lifecycle validation; not browser/GPU/game acceptance"}
	finish_validation(true,"")

func finish_validation(ok: bool, error: String) -> void:
	if validate_result.get("completed",false): return
	validate_result.runtime_capabilities=Capabilities.read()
	validate_result.merge({"ok":ok,"completed":true,"error":error,"runtime_version":Capabilities.VERSION},true)
	if options.has("report"):
		var file = FileAccess.open(str(options.report),FileAccess.WRITE)
		if file: file.store_string(JSON.stringify(validate_result,"\t"))
	print("WORLD_VALIDATION_COMPLETE "+JSON.stringify(validate_result))
	get_tree().quit(0 if ok else 2)
