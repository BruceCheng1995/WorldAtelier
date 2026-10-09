extends Node
const Session=preload("res://native_shared_session.gd")
signal player_joined(player:Dictionary)
signal player_left(player_id:String)
signal player_input_stopped(player_id:String)
signal initialized
signal scene_loaded(resource_id:String,scene_generation:int)
var restoring=false
var error_transaction=false
var transaction_errors:Array=[]
var runtime:Node
var session:RefCounted
var peer=WebSocketPeer.new()
var connected=false
var active=false
var paused=false
var clock=0.0
var initializing=false
var is_client=false
var baseline:Dictionary={}
var observed_generation=0
var last_heartbeat=0
var reported_fault=false
var validation_options:Dictionary={}
func start(value:Node)->void:
	runtime=value
	process_mode=Node.PROCESS_MODE_ALWAYS
	process_physics_priority=100000
	session=Session.new()
	pause(true)
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--native-shared-validate="):validation_options=JSON.parse_string(FileAccess.get_file_as_string(argument.trim_prefix("--native-shared-validate=")))
	if not validation_options.is_empty():validate.call_deferred();return
	peer.inbound_buffer_size=32*1024*1024;peer.outbound_buffer_size=32*1024*1024
	peer.handshake_headers=PackedStringArray(["Authorization: Bearer "+OS.get_environment("WA_WORKER_TOKEN")])
	var url=OS.get_environment("WA_WORKER_URL")
	if not url.begins_with("ws://127.0.0.1:") and not url.begins_with("ws://localhost:"):push_error("Native worker requires loopback transport");get_tree().quit(2);return
	if peer.connect_to_url(url)!=OK:get_tree().quit(2)
func is_authority()->bool:return true
func key_for(node:Node)->String:return session.key_for(node)
func players()->Array:return session.players.values().duplicate(true)
func player(player_id:String)->Dictionary:return session.player(player_id)
func spawn(resource_id:String,spawn_id:String,parent_key:String="",owner_id:String="",initial_state:Dictionary={})->Node:
	if error_transaction:transaction_errors.append({"error":"Spawn is not allowed during a parameter transaction"});return null
	return session.spawn(resource_id,spawn_id,parent_key,owner_id,initial_state)
func despawn(spawn_id:String)->void:
	if error_transaction:transaction_errors.append({"error":"Despawn is not allowed during a parameter transaction"});return
	session.despawn(spawn_id)
func prepare_node_defaults(node:Node,resource:String)->void:
	# SceneTree emits node_added before the authored _ready lifecycle. The root
	# may not yet be current_scene, so resolve its actual parent chain directly.
	var chain:Array=[]
	var cursor:Node=node
	while cursor.get_parent()!=null and cursor.get_parent()!=get_tree().root:
		if cursor.has_meta("wa_shared_spawn"):return # spawn applies before add_child.
		if cursor.has_meta("wa_instance_id"):chain.push_front(str(cursor.get_meta("wa_instance_id")))
		cursor=cursor.get_parent()
	if cursor==runtime or cursor.has_meta("wa_shared_spawn"):return
	session.apply_node_parameters(node,resource,chain)
func _process(_delta:float)->void:
	if not validation_options.is_empty():return
	synchronize_scene()
	if active and not runtime.loading and not reported_fault and (runtime.faulted or not runtime.failure.is_empty()):
		reported_fault=true;pause(true);send({"type":"worker_error","error":runtime.failure,"snapshot":session.snapshot()})
	peer.poll()
	if peer.get_ready_state()==WebSocketPeer.STATE_OPEN:
		if not connected:
			connected=true
			send({"type":"worker_hello","protocol":1,"native_shared":true,"pid":OS.get_process_id(),"source_identity":runtime.release.source_identity,"build_id":runtime.release.native_shared.get("build_id","")})
		if Time.get_ticks_msec()-last_heartbeat>=1000:
			last_heartbeat=Time.get_ticks_msec();send({"type":"worker_heartbeat","paused":paused})
		while peer.get_available_packet_count()>0:
			var packet=JSON.parse_string(peer.get_packet().get_string_from_utf8())
			if packet is Dictionary:receive(packet)
	elif peer.get_ready_state()==WebSocketPeer.STATE_CLOSED:get_tree().quit(0 if connected else 2)
func _physics_process(delta:float)->void:
	if not active or paused or runtime.loading or not runtime.running:return
	session.advance()
	clock+=delta
	if clock>=0.1:
		clock=0
		send({"type":"world_snapshot","snapshot":session.snapshot()})
func receive(packet:Dictionary)->void:
	match packet.get("type",""):
		"init":initialize(packet)
		"join":
			if not active:return
			session.join(str(packet.player_id),str(packet.get("name","")),str(packet.get("color","#80cdf6")))
			player_joined.emit(session.player(str(packet.player_id)))
			send({"type":"joined","request_id":packet.get("request_id",""),"ok":session.error.is_empty(),"error":session.error,"snapshot":session.snapshot()})
		"leave":
			if not active:return
			session.leave(str(packet.player_id));player_left.emit(str(packet.player_id))
			send({"type":"left","request_id":packet.get("request_id",""),"ok":true,"snapshot":session.snapshot()})
		"input":
			var problem="WORLD_NOT_ACTIVE" if not active or paused or runtime.loading or not runtime.running else session.input(packet)
			if problem.is_empty():await settle_scene()
			send({"type":"input_ack","request_id":packet.get("request_id",""),"ok":problem.is_empty(),"error":problem,"input_seq":packet.get("input_seq",0),"snapshot":session.snapshot() if active else {}})
		"checkpoint":
			await settle_scene()
			if packet.get("pause",false):pause(true)
			send({"type":"checkpoint","request_id":packet.get("request_id",""),"ok":active,"snapshot":session.snapshot() if active else {}})
		"resume":
			pause(false);send({"type":"resumed","request_id":packet.get("request_id",""),"ok":active,"snapshot":session.snapshot() if active else {}})
		"apply_defaults":
			await settle_scene()
			var was_paused=paused;pause(true)
			var problem="WORLD_NOT_ACTIVE" if not active else session.apply_defaults(packet)
			pause(was_paused)
			send({"type":"applied","request_id":packet.get("request_id",""),"ok":problem.is_empty(),"error":problem,"snapshot":session.snapshot()})
		"shutdown":
			pause(true);send({"type":"checkpoint","request_id":packet.get("request_id",""),"ok":active,"snapshot":session.snapshot() if active else {}})
			get_tree().quit(0)
func initialize(packet:Dictionary)->void:
	if initializing or active:send({"type":"world_ready","request_id":packet.get("request_id",""),"ok":false,"error":"Already initialized"});return
	initializing=true
	var problem=""
	if packet.get("scene_revision")!=runtime.release.revision or packet.get("source_identity")!=runtime.release.source_identity or (packet.has("build_id") and packet.build_id!=runtime.release.native_shared.build_id):problem="FIXED_SOURCE_MISMATCH"
	var state:Dictionary=packet.get("state",{})
	restoring=not state.is_empty()
	var resource=str(state.get("resource_id",packet.get("resource_id",runtime.launch_entry)))
	if not runtime.release.scenes.has(resource):problem="FIXED_SCENE_MISSING"
	if problem.is_empty():
		pause(true)
		await runtime.open_scene(resource)
		if not runtime.running or runtime.faulted:problem=runtime.failure
	if problem.is_empty():problem=session.configure(runtime,packet)
	if problem.is_empty():problem=session.restore(state)
	if problem.is_empty():
		active=true;restoring=false;observed_generation=runtime.generation;baseline=session.snapshot();initialized.emit();scene_loaded.emit(runtime.current_scene_id,runtime.generation)
		await settle_scene()
		pause(bool(packet.get("paused",false)))
	initializing=false
	send({"type":"world_ready","request_id":packet.get("request_id",""),"ok":problem.is_empty(),"error":problem,"snapshot":session.snapshot() if active else {}})
func pause(value:bool)->void:
	paused=value
	get_tree().paused=value
	# Authored ALWAYS Autoloads must freeze too. Framework transport stays live.
	var authored:Array=[]
	for root in get_tree().root.get_children():
		if root==runtime:continue
		authored.append(root);authored.append_array(root.find_children("*","",true,false))
	for node in authored:
		if value:
			if not node.has_meta("wa_shared_process_mode"):node.set_meta("wa_shared_process_mode",node.process_mode)
			node.process_mode=Node.PROCESS_MODE_DISABLED
		elif node.has_meta("wa_shared_process_mode"):
			node.process_mode=int(node.get_meta("wa_shared_process_mode"));node.remove_meta("wa_shared_process_mode")
func send(packet:Dictionary)->void:
	if peer.get_ready_state()==WebSocketPeer.STATE_OPEN:peer.send_text(JSON.stringify(packet))
func validate()->void:
	await initialize(validation_options.get("init",{}))
	var problem="" if active else "Native authority initialization failed"
	if active:
		pause(false)
		for i in range(120):
			await get_tree().physics_frame
			if runtime.faulted or not session.error.is_empty():problem=runtime.failure+session.error;break
		pause(true)
	var report={"ok":problem.is_empty(),"completed":true,"error":problem,"snapshot":session.snapshot() if active else {},"pid":OS.get_process_id(),"runtime_entry":runtime.get_script().resource_path,"actual_scene":get_tree().current_scene.scene_file_path}
	var file=FileAccess.open(str(validation_options.report),FileAccess.WRITE)
	file.store_string(JSON.stringify(report,"\t"))
	print("NATIVE_SHARED_VALIDATION "+JSON.stringify(report))
	get_tree().quit(0 if problem.is_empty() else 2)

func synchronize_scene()->void:
	if active and runtime.running and not runtime.loading and (runtime.current_scene_id!=session.resource_id or runtime.generation!=observed_generation):
		session.resource_id=runtime.current_scene_id;observed_generation=runtime.generation
		session.refresh();session.initial_keys=session.nodes.keys()
		scene_loaded.emit(runtime.current_scene_id,runtime.generation)
func settle_scene()->void:
	for frame in range(180):
		if not runtime.loading:break
		await get_tree().process_frame
	synchronize_scene()
