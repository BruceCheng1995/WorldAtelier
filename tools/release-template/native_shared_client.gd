extends Node
const Codec=preload("res://native_shared_codec.gd")
var runtime:Node
var is_client=true
var active=false
var frozen=false
var loading=false
var boot_ready=false
var latest:Dictionary={}
var pending_snapshot:Dictionary={}
var nodes:Dictionary={}
var spawns:Dictionary={}
var player_id=""
var world_id=""
var epoch=0
var control_generation=""
var input_sequence=0
var stop_sequence=0
var join_packet:Dictionary={}
var held:Dictionary={}
var key_bindings:Array=[]
var clock=0.0
var mode="resyncing"
var last_source_identity=""
func start(value:Node)->void:
	runtime=value
	process_mode=Node.PROCESS_MODE_ALWAYS
	load_entry.call_deferred()
func is_authority()->bool:return false
func load_entry()->void:
	await runtime.open_scene(runtime.launch_entry)
	if runtime.running:
		refresh()
		boot_ready=true
		runtime.debug.bootstrap_ready()
		print("NATIVE_SHARED_CLIENT_READY "+JSON.stringify({"source_identity":runtime.release.source_identity,"resource_id":runtime.current_scene_id,"native_scene_path":runtime.game_scene.scene_file_path}))
func key_for(node:Node)->String:
	for key in nodes:
		if nodes[key]==node:return str(key)
	return ""
func players()->Array:return latest.get("players",{}).values().duplicate(true)
func player(uid:String)->Dictionary:return latest.get("players",{}).get(uid,{}).duplicate(true)
func receive(packet:Dictionary)->void:
	match packet.get("action",""):
		"join":
			while not boot_ready or loading:await get_tree().process_frame
			var snapshot:Dictionary=packet.get("snapshot",{})
			if snapshot.get("scene_revision")!=runtime.release.revision or snapshot.get("source_identity")!=runtime.release.source_identity:return
			active=false;frozen=false;mode="resyncing"
			join_packet=packet.duplicate(true);player_id=str(packet.player_id);world_id=str(packet.world_id);epoch=int(packet.epoch)
			control_generation=str(packet.get("control_generation",""))
			runtime.debug.seq=maxi(1,int(packet.get("seq",runtime.debug.seq)))
			runtime.debug.request_id=str(packet.get("request_id",runtime.debug.request_id))
			runtime.debug.document_id=str(packet.get("document_id",runtime.debug.document_id))
			input_sequence=int(packet.get("input_seq_base",snapshot.get("players",{}).get(player_id,{}).get("last_input_seq",0)))
			runtime.debug.world_id=world_id;runtime.debug.epoch=epoch;runtime.debug.started=true
			await apply_snapshot(snapshot,true)
			if latest.get("sequence")!=snapshot.get("sequence"):return
			runtime.debug.emit({"type":"shared_ready","world_id":world_id,"epoch":epoch,"scene_revision":latest.scene_revision,"sequence":latest.sequence,"resource_id":latest.resource_id,"scene_generation":latest.scene_generation,"state_hash":packet.get("state_hash",""),"control_generation":control_generation,"source_identity":latest.source_identity})
		"active":
			if not boundary(packet):return
			active=true;mode="playing";emit_state()
		"snapshot":
			var snapshot:Dictionary=packet.get("snapshot",{})
			if not boundary(snapshot) or int(snapshot.get("sequence",-1))<=int(latest.get("sequence",-1)):return
			if frozen:pending_snapshot=snapshot.duplicate(true);emit_state();return
			await apply_snapshot(snapshot)
			if mode=="entering_inspect" and int(latest.get("players",{}).get(player_id,{}).get("last_input_seq",-1))>=stop_sequence:
				frozen=true;mode="inspecting";runtime.debug.enter_inspection();emit_state()
		"mode":
			runtime.debug.request_id=str(packet.get("request_id",""))
			if packet.get("mode") in ["inspect","inspecting"]:
				if not active or frozen:return
				held.clear();stop_sequence=send_inputs([]);mode="entering_inspect";emit_state()
			elif packet.get("mode") in ["play","playing"]:
				if not frozen:return
				mode="resyncing";runtime.debug.restore_inspection(true);frozen=false
				if not pending_snapshot.is_empty():await apply_snapshot(pending_snapshot);pending_snapshot={}
				mode="playing";emit_state()
		"inspection_ui":
			if frozen and packet.get("visible") is bool:
				runtime.debug.inspection_ui_visible=packet.visible;runtime.debug.show_ui();emit_state()
		"input_ack":
			if packet.get("ok",true)==false:runtime.debug.emit({"type":"error","code":"shared_input","message":packet.get("error","输入被拒绝")})
		"disconnect":
			active=false;held.clear();mode="resyncing";emit_state()
		"freeze":
			if packet.get("value",false):receive({"action":"mode","mode":"inspect","request_id":packet.get("request_id","")})
			else:receive({"action":"mode","mode":"play","request_id":packet.get("request_id","")})
func boundary(packet:Dictionary)->bool:
	return packet.get("world_id")==world_id and int(packet.get("epoch",-1))==epoch and packet.get("scene_revision")==runtime.release.revision and (not packet.has("scene_generation") or int(packet.scene_generation)>=int(latest.get("scene_generation",0))) and (not packet.has("control_generation") or packet.control_generation==control_generation)
func apply_snapshot(snapshot:Dictionary,initial:bool=false)->void:
	if loading or not Codec.valid(snapshot):return
	if snapshot.get("source_identity")!=runtime.release.source_identity:return
	loading=true
	var resource=str(snapshot.get("resource_id",runtime.launch_entry))
	if resource!=runtime.current_scene_id or (not latest.is_empty() and int(snapshot.get("scene_generation",0))!=int(latest.get("scene_generation",0))):
		spawns.clear()
		await runtime.open_scene(resource)
	if not runtime.running:loading=false;return
	refresh()
	for id in spawns.keys():
		if not snapshot.get("spawns",{}).has(id):
			if is_instance_valid(spawns[id]):spawns[id].get_parent().remove_child(spawns[id]);spawns[id].queue_free()
			spawns.erase(id)
	var pending:Dictionary=snapshot.get("spawns",{}).duplicate(true)
	while not pending.is_empty():
		var progress=false
		for id in pending.keys():
			if spawns.has(id):pending.erase(id);progress=true;continue
			var info:Dictionary=pending[id];var parent:Node=runtime.game_scene if str(info.parent_key).is_empty() else nodes.get(info.parent_key)
			if not is_instance_valid(parent):continue
			var path=str(runtime.release.native_shared.scenes.get(info.resource_id,""))
			if path.is_empty():loading=false;return
			var packed:PackedScene=load(path)
			if packed==null:loading=false;return
			var node=packed.instantiate();node.set_meta("wa_shared_spawn",str(id));node.set_meta("wa_shared_owner",str(info.owner_id))
			parent.add_child(node);spawns[id]=node;pending.erase(id);progress=true;refresh()
		if not progress:loading=false;return
	for key in snapshot.get("removed",[]):
		if nodes.has(key) and nodes[key]!=runtime.game_scene:
			var node:Node=nodes[key];node.get_parent().remove_child(node);node.queue_free()
	refresh()
	for key in snapshot.get("nodes",{}):
		var row:Dictionary=snapshot.nodes[key]
		if row.get("autoload",false):continue # state is retained below, no author Autoload executes here.
		if not nodes.has(key):loading=false;return
		var node:Node=nodes[key]
		if row.has("transform") and (node is Node2D or node is Node3D):node.transform=Codec.decode(row.transform)
		for property in row.get("state",{}):
			if has_property(node,property):node.set(property,Codec.coerce(row.state[property],node.get(property)))
		for property in row.get("display",{}):
			if has_property(node,property):node.set(property,Codec.coerce(row.display[property],node.get(property)))
	latest=snapshot.duplicate(true)
	runtime.world_client.latest=latest
	runtime.simulation.tick=int(latest.tick);runtime.simulation.scene_revision=str(latest.scene_revision)
	runtime.generation=int(latest.get("scene_generation",runtime.generation))
	last_source_identity=str(latest.source_identity)
	loading=false
	emit_state()
	if not initial:runtime.debug.emit({"type":"native_shared","packet":{"action":"applied","world_id":world_id,"epoch":epoch,"scene_revision":latest.scene_revision,"source_identity":latest.source_identity,"sequence":latest.sequence}})
func has_property(node:Node,property:String)->bool:
	if property in ["script","process_mode","owner","name"] or property.begins_with("metadata/"):return false
	for descriptor in node.get_property_list():
		if str(descriptor.name)==property:return true
	return false
func refresh()->void:
	nodes.clear();key_bindings.clear()
	if is_instance_valid(runtime.game_scene):walk(runtime.game_scene,[])
func walk(node:Node,chain:Array)->void:
	if node.has_meta("wa_shared_spawn"):
		chain=chain.duplicate();chain.append(str(node.get_meta("wa_shared_spawn")))
	elif node!=runtime.game_scene and node.has_meta("wa_instance_id"):
		chain=chain.duplicate();chain.append(str(node.get_meta("wa_instance_id")))
	var id=str(node.get_meta("wa_node_id",""));var key=JSON.stringify([chain,id])
	if not id.is_empty():nodes[key]=node
	for binding in node.get_meta("wa_shared_keys",[]):
		if binding is Dictionary:key_bindings.append({"key":key,"binding":binding})
	var binding:Variant=node.get_meta("wa_shared_bind",{})
	if node is BaseButton and binding is Dictionary and binding.has("action"):
		node.process_mode=Node.PROCESS_MODE_ALWAYS
		node.mouse_filter=Control.MOUSE_FILTER_STOP
		node.focus_mode=Control.FOCUS_ALL
		if not node.has_meta("wa_shared_button_connected"):
			node.set_meta("wa_shared_button_connected",true)
			node.pressed.connect(func():send_binding(key,binding))
	for child in node.get_children():walk(child,chain)
func resolve_target(target:String,fallback:String)->String:
	if target.is_empty():return fallback
	if target.begins_with("@owner:"):
		var id=target.trim_prefix("@owner:")
		for key in nodes:
			var node:Node=nodes[key]
			if str(node.get_meta("wa_node_id",""))!=id:continue
			var cursor:Node=node
			while cursor!=null and cursor!=runtime.game_scene:
				if cursor.get_meta("wa_shared_owner","")==player_id:return str(key)
				cursor=cursor.get_parent()
		return ""
	return target
func send_binding(key:String,binding:Dictionary,released:bool=false)->void:
	var target=resolve_target(str(binding.get("target_key","")),key)
	if target.is_empty():return
	if released and not binding.has("released_payload"):send_inputs([]);return
	send_inputs([{"target_key":target,"action":str(binding.get("action","")),"payload":binding.get("released_payload" if released else "payload",{})}])
func send_input(target_key:String,action:String,payload:Variant)->void:send_inputs([{"target_key":target_key,"action":action,"payload":payload}])
func send_inputs(inputs:Array)->int:
	if not active or frozen or not mode in ["playing","entering_inspect"]:return input_sequence
	input_sequence+=1
	runtime.debug.emit({"type":"native_shared","packet":{"action":"input","world_id":world_id,"epoch":epoch,"scene_revision":runtime.release.revision,"control_generation":control_generation,"input_seq":input_sequence,"resource_id":latest.get("resource_id",runtime.current_scene_id),"scene_generation":latest.get("scene_generation",runtime.generation),"inputs":inputs}})
	return input_sequence
func _input(event:InputEvent)->void:
	if not active or frozen or mode!="playing":return
	if event is InputEventKey and event.echo:return
	for item in key_bindings:
		var binding:Dictionary=item.binding;var action=str(binding.get("input_action",""))
		if not InputMap.has_action(action):continue
		var token=item.key+"/"+action
		if event.is_action_pressed(action):held[token]=item;send_binding(item.key,binding)
		elif event.is_action_released(action):held.erase(token);send_binding(item.key,binding,true)
func _process(delta:float)->void:
	clock+=delta
	if clock<0.1:return
	clock=0
	if active and not frozen and mode=="playing":
		for item in held.values():send_binding(item.key,item.binding)
func emit_state()->void:
	if not runtime.debug.started:return
	var state:Dictionary=latest
	var newest:Dictionary=pending_snapshot if not pending_snapshot.is_empty() else latest
	var packet={"type":"world_state","world_id":world_id,"epoch":epoch,"scene_revision":state.get("scene_revision",runtime.release.revision),"source_revision":runtime.release.revision,"resource_id":runtime.current_scene_id,"document_id":runtime.debug.document_id,"seq":runtime.debug.seq,"mode":mode,"request_id":runtime.debug.request_id,"mode_ack":mode in ["playing","inspecting"],"applied_sequence":state.get("sequence",0),"latest_sequence":newest.get("sequence",0),"latest_revision":newest.get("scene_revision",""),"control_ready":active and mode=="playing","runtime_ready":runtime.running,"session_kind":"shared_world","tick":state.get("tick",0),"latest_tick":newest.get("tick",0),"object_states":state.get("object_states",{}),"runtime_fault":state.get("runtime_fault",{}),"error":"","player_id":player_id,"inspection_ui_visible":runtime.debug.inspection_ui_visible if frozen else true}
	packet["native_observations"]=[]
	for key in nodes:
		var node:Node=nodes[key]
		if not is_instance_valid(node):continue
		var observed={"key":key,"native_type":node.get_class(),"state":{}}
		if node is Node2D or node is Node3D:observed["transform"]=Codec.encode(node.transform)
		if node is Node3D or node is CanvasItem:observed["visible"]=node.visible
		if node is Label:observed["text"]=node.text
		for property in latest.get("nodes",{}).get(key,{}).get("state",{}):
			if has_property(node,property):observed.state[property]=Codec.encode(node.get(property))
		packet.native_observations.append(observed)
	if frozen:
		packet.merge({"frozen_sequence":state.sequence,"frozen_tick":state.tick,"frozen_revision":state.scene_revision,"input_zero_seq":stop_sequence,"stop_ack_sequence":state.sequence,"input_stopped":int(state.get("players",{}).get(player_id,{}).get("last_input_seq",-1))>=stop_sequence,"inspection_objects":[]})
		for id in runtime.projection.objects:packet.inspection_objects.append(runtime.projection.observe(id))
	runtime.debug.emit(packet)
