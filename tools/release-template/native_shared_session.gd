extends RefCounted
const Codec=preload("res://native_shared_codec.gd")
var runtime:Node
var world_id=""
var epoch=1
var revision=""
var source_identity=""
var resource_id=""
var sequence=0
var tick_count=0
var last_input_usec:Dictionary={}
var stopped:Dictionary={}
var observed_scene:Node
var players:Dictionary={}
var nodes:Dictionary={}
var declarations:Dictionary={}
var spawns:Dictionary={}
var spawn_nodes:Dictionary={}
var removed:Array=[]
var initial_keys:Array=[]
var parameter_overrides:Array=[]
var error=""
var restoring=false

func configure(owner_runtime:Node,packet:Dictionary)->String:
	runtime=owner_runtime
	world_id=str(packet.world_id);epoch=int(packet.epoch)
	revision=str(packet.scene_revision);source_identity=str(packet.source_identity)
	resource_id=runtime.current_scene_id
	refresh()
	initial_keys=nodes.keys()
	return error
func key_for(node:Node)->String:
	for key in nodes:
		if nodes[key]==node:return str(key)
	return ""
func refresh()->void:
	if not is_instance_valid(runtime.game_scene):return
	nodes.clear();declarations.clear()
	if observed_scene!=runtime.game_scene:
		observed_scene=runtime.game_scene;removed.clear();initial_keys.clear()
		for spawn_id in spawn_nodes.keys():
			if not is_instance_valid(spawn_nodes[spawn_id]) or not spawn_nodes[spawn_id].is_inside_tree():spawn_nodes.erase(spawn_id);spawns.erase(spawn_id)
	_walk(runtime.game_scene,[],"")
	for root in runtime.get_tree().root.get_children():
		if root!=runtime and root!=runtime.game_scene and root.has_meta("wa_node_id"):_walk(root,["@autoload",str(root.name)],"")
func _walk(node:Node,chain:Array,dynamic_id:String,dynamic_prefix:int=0)->void:
	if node.has_meta("wa_shared_spawn"):
		dynamic_id=str(node.get_meta("wa_shared_spawn"));chain=chain.duplicate();chain.append(dynamic_id);dynamic_prefix=chain.size()
	elif node!=runtime.game_scene and node.has_meta("wa_instance_id"):
		chain=chain.duplicate();chain.append(str(node.get_meta("wa_instance_id")))
	var id=str(node.get_meta("wa_node_id",""))
	if not id.is_empty():
		var key=JSON.stringify([chain,id])
		if nodes.has(key):error="Duplicate shared node identity: "+key;return
		nodes[key]=node
		var declared:Variant=node.get_meta("wa_shared",{})
		if not declared is Dictionary:error="wa_shared must be a Dictionary";return
		var schema:Dictionary=declared.duplicate(true)
		if not schema.get("state",[]) is Array or not schema.get("defaults",[]) is Array or not schema.get("inputs",{}) is Dictionary:error="Malformed shared state contract";return
		schema["dynamic_id"]=dynamic_id;schema["dynamic_prefix"]=dynamic_prefix
		schema["node_id"]=id;schema["instance_ids"]=chain.duplicate()
		for property in schema.get("state",[])+schema.get("defaults",[]):
			if not property is String or property in ["script","owner","name","process_mode"] or property.begins_with("metadata/") or not _has_property(node,property):error="Invalid shared property: "+str(property);return
			if schema.get("state",[]).has(property) and schema.get("defaults",[]).has(property):error="Shared state/defaults overlap: "+property;return
			if not Codec.valid(Codec.encode(node.get(property))):error="Unsupported shared value: "+property;return
		declarations[key]=schema
	for child in node.get_children():_walk(child,chain,dynamic_id,dynamic_prefix)
func _has_property(node:Node,property:String)->bool:
	for descriptor in node.get_property_list():
		if str(descriptor.name)==property:return true
	return false
func player(player_id:String)->Dictionary:return players.get(player_id,{}).duplicate(true)
func join(player_id:String,name:String,color:String)->void:
	var value:Dictionary=players.get(player_id,{"id":player_id,"last_input_seq":0})
	value.merge({"name":name,"color":color,"online":true},true);players[player_id]=value
	for node in nodes.values():
		if node.has_method("shared_player_joined"):node.call("shared_player_joined",value.duplicate(true))
func leave(player_id:String)->void:
	if not players.has(player_id):return
	stop_input(player_id)
	players[player_id].online=false
	for node in nodes.values():
		if node.has_method("shared_player_left"):node.call("shared_player_left",player_id)
func input(packet:Dictionary)->String:
	if packet.get("world_id")!=world_id or int(packet.get("epoch",-1))!=epoch or packet.get("scene_revision")!=revision:return "STALE_WORLD_INPUT"
	if packet.get("resource_id")!=runtime.current_scene_id or int(packet.get("scene_generation",-1))!=runtime.generation:return "STALE_SCENE_INPUT"
	var uid=str(packet.get("player_id",""));var seq=int(packet.get("input_seq",0))
	if not players.has(uid) or not players[uid].online:return "PLAYER_NOT_JOINED"
	if seq<=int(players[uid].last_input_seq):return "STALE_INPUT_SEQUENCE"
	var inputs:Variant=packet.get("inputs",[])
	if not inputs is Array or inputs.size()>32 or not Codec.valid(inputs):return "INVALID_INPUTS"
	refresh()
	var calls:Array=[]
	for command in inputs:
		if not command is Dictionary:return "INVALID_INPUT"
		var key=str(command.get("target_key",""));var action=str(command.get("action",""))
		if not nodes.has(key):return "UNKNOWN_INPUT_TARGET"
		var declaration:Dictionary=declarations[key]
		var contract:Variant=declaration.get("inputs",{}).get(action)
		if not contract is Dictionary:return "UNDECLARED_INPUT_ACTION"
		var method=str(contract.get("method",""))
		if method.is_empty() or not nodes[key].has_method(method):return "MISSING_INPUT_METHOD"
		var owner=str(nodes[key].get_meta("wa_shared_owner",spawns.get(declaration.dynamic_id,{}).get("owner_id","")))
		if contract.get("owner",true) and owner!=uid:return "INPUT_OWNER_MISMATCH"
		calls.append({"node":nodes[key],"method":method,"payload":command.get("payload",{})})
	players[uid].last_input_seq=seq
	last_input_usec[uid]=Time.get_ticks_usec();stopped[uid]=false
	if inputs.is_empty():stop_input(uid)
	# All authority boundaries checked before any authored callback executes.
	for call in calls:call.node.call(call.method,uid,call.payload)
	return ""
func spawn(resource:String,spawn_id:String,parent_key:String="",owner_id:String="",initial_state:Dictionary={})->Node:
	if spawn_id.is_empty() or spawn_id.length()>128 or spawns.has(spawn_id):error="Duplicate/invalid spawn ID";return null
	var doc:Dictionary=runtime.release.scenes.get(resource,{})
	if doc.is_empty():error="Spawn resource is outside fixed project";return null
	var parent:Node=runtime.game_scene if parent_key.is_empty() else nodes.get(parent_key)
	if not is_instance_valid(parent):error="Spawn parent is missing";return null
	var packed:PackedScene=load(str(doc.get("native_scene_path","")))
	if packed==null:error="Spawn PackedScene failed";return null
	var instance=packed.instantiate()
	instance.set_meta("wa_shared_spawn",spawn_id)
	instance.set_meta("wa_shared_owner",owner_id)
	spawns[spawn_id]={"resource_id":resource,"parent_key":parent_key,"owner_id":owner_id}
	spawn_nodes[spawn_id]=instance
	apply_template_parameters(instance,resource)
	parent.add_child(instance)
	refresh()
	if not initial_state.is_empty():
		var key=key_for(instance)
		if not key.is_empty():
			var problem=_restore_node(key,{"version":declarations[key].get("version",1),"state":initial_state})
			if not problem.is_empty():error=problem;despawn(spawn_id);return null
	return instance
func despawn(spawn_id:String)->void:
	if not spawn_nodes.has(spawn_id):return
	var node:Node=spawn_nodes[spawn_id]
	if is_instance_valid(node):node.get_parent().remove_child(node);node.queue_free()
	spawn_nodes.erase(spawn_id);spawns.erase(spawn_id);refresh()
func snapshot()->Dictionary:
	refresh()
	sequence+=1
	var values:Dictionary={}
	for key in nodes:
		var node:Node=nodes[key];var declaration:Dictionary=declarations[key];var state:Dictionary={}
		for property in declaration.get("state",[]):state[property]=Codec.encode(node.get(property))
		var row={"node_id":declaration.node_id,"instance_ids":declaration.instance_ids,"version":declaration.get("version",1),"state":state,"kind":node.get_class(),"path":str(runtime.game_scene.get_path_to(node)) if runtime.game_scene.is_ancestor_of(node) or node==runtime.game_scene else "", "autoload":declaration.instance_ids.has("@autoload")}
		if node is Node3D or node is Node2D:row["transform"]=Codec.encode(node.transform)
		var display:Dictionary={}
		if node is Node3D or node is CanvasItem:display["visible"]=node.visible
		if node is Camera3D:display["current"]=node.current
		if node is Camera2D:display["enabled"]=node.enabled
		row["display"]=display
		# Built-in presentation values can be declared state without a second logic script.
		values[key]=row
	for key in initial_keys:
		if not nodes.has(key) and not removed.has(key):removed.append(key)
	var legacy:Dictionary={}
	if is_instance_valid(runtime.simulation) and runtime.simulation.legacy!=null:legacy=runtime.simulation.legacy.snapshot()
	var result={"schema":"wa-native-world-state-1","world_id":world_id,"epoch":epoch,"scene_revision":revision,"source_identity":source_identity,"resource_id":runtime.current_scene_id,"sequence":sequence,"tick":tick_count,"scene_generation":runtime.generation,"players":players.duplicate(true),"nodes":values,"spawns":spawns.duplicate(true),"removed":removed.duplicate(),"parameter_overrides":parameter_overrides.duplicate(true),"object_states":legacy,"runtime_fault":runtime.runtime_fault.duplicate(true)}
	if not error.is_empty():result.runtime_fault={"role":"native_shared","error":error}
	if not Codec.valid(result):result.runtime_fault={"role":"native_shared","error":"State serialization rejected"}
	return result
func restore(previous:Dictionary)->String:
	if previous.is_empty():return ""
	if previous.get("schema")!="wa-native-world-state-1" or not Codec.valid(previous):return "INVALID_NATIVE_CHECKPOINT"
	restoring=true
	players=previous.get("players",{}).duplicate(true)
	for player_id in players:
		players[player_id].online=false
		last_input_usec[player_id]=Time.get_ticks_usec()-750001;stopped[player_id]=false
	sequence=int(previous.get("sequence",0));tick_count=int(previous.get("tick",0))
	# A new fixed source already carries its own defaults. Old-process overlays
	# only describe the same source identity and must not override a new build.
	parameter_overrides=previous.get("parameter_overrides",[]).duplicate(true) if previous.get("source_identity")==source_identity else []
	var pending:Dictionary=previous.get("spawns",{}).duplicate(true)
	while not pending.is_empty():
		var progress=false
		for spawn_id in pending.keys():
			var info:Dictionary=pending[spawn_id]
			if not str(info.parent_key).is_empty() and not nodes.has(info.parent_key):continue
			if spawn(str(info.resource_id),str(spawn_id),str(info.parent_key),str(info.owner_id))==null:return error
			pending.erase(spawn_id);progress=true
		if not progress:return "CHECKPOINT_SPAWN_PARENT_MISSING"
	for key in previous.get("removed",[]):
		if nodes.has(key):
			var node:Node=nodes[key]
			if node==runtime.game_scene:return "CHECKPOINT_REMOVES_SCENE_ROOT"
			node.get_parent().remove_child(node);node.queue_free()
	removed=previous.get("removed",[]).duplicate()
	refresh()
	for key in previous.get("nodes",{}):
		if not nodes.has(key):return "CHECKPOINT_NODE_MISSING: "+str(key)
		var problem=_restore_node(key,previous.nodes[key])
		if not problem.is_empty():return problem
	if runtime.simulation.legacy!=null:
		runtime.simulation.legacy.authority.apply_states(previous.get("object_states",{}))
		runtime.simulation.legacy.presentation.apply_states(previous.get("object_states",{}))
	restoring=false
	return ""
func _restore_node(key:String,row:Dictionary)->String:
	var node:Node=nodes[key];var declaration:Dictionary=declarations[key]
	var state:Dictionary=row.get("state",{}).duplicate(true)
	if int(row.get("version",1))!=int(declaration.get("version",1)):
		if not node.has_method("shared_migrate_state"):return "STATE_VERSION_MIGRATION_REQUIRED: "+key
		var migrated:Variant=node.call("shared_migrate_state",int(row.get("version",1)),state.duplicate(true))
		if not migrated is Dictionary or not Codec.valid(migrated):return "INVALID_MIGRATED_STATE: "+key
		state=migrated
	for property in state:
		if not declaration.get("state",[]).has(property):return "CHECKPOINT_STATE_REMOVED: "+key+"/"+property
		var value:Variant=Codec.coerce(state[property],node.get(property))
		if typeof(value)!=typeof(node.get(property)):return "CHECKPOINT_STATE_TYPE_MISMATCH"
		node.set(property,value)
	if row.has("transform") and (node is Node3D or node is Node2D):node.transform=Codec.decode(row.transform)
	return ""
func apply_defaults(packet:Dictionary)->String:
	var updates:Variant=packet.get("updates",[])
	if not updates is Array or not Codec.valid(updates):return "INVALID_DEFAULT_UPDATES"
	refresh()
	var changes:Array=[]
	for update in updates:
		if str(update.get("resource_id"))!=resource_id:continue # Other prefab templates are applied to dynamic instances below.
		var key=JSON.stringify([update.get("instance_ids",[]),str(update.get("node_id",""))])
		if not nodes.has(key):return "DEFAULT_TARGET_MISSING: "+key
		var problem=_default_change(key,update,changes)
		if not problem.is_empty():return problem
	for key in nodes:
		var declaration:Dictionary=declarations[key];var dynamic_id=str(declaration.dynamic_id)
		if dynamic_id.is_empty():continue
		for update in updates:
			if spawns[dynamic_id].resource_id==update.get("resource_id") and str(update.get("node_id"))==declaration.node_id and declaration.instance_ids.slice(declaration.dynamic_prefix)==update.get("instance_ids",[]):
				var problem=_default_change(key,update,changes)
				if not problem.is_empty():return problem
	var checkpoint=snapshot()
	runtime.shared.error_transaction=true;runtime.shared.transaction_errors=[]
	for change in changes:change.node.set(change.property,change.value)
	var problem=""
	for change in changes:
		if change.node.has_method("shared_validate_defaults"):
			var result:Variant=change.node.call("shared_validate_defaults")
			if result is String and not result.is_empty():problem=result;break
	if not runtime.shared.transaction_errors.is_empty():problem=str(runtime.shared.transaction_errors)
	if not problem.is_empty():
		for change in changes:change.node.set(change.property,change.previous)
		for key in checkpoint.nodes:
			if nodes.has(key) and is_instance_valid(nodes[key]):_restore_node(key,checkpoint.nodes[key])
		runtime.shared.error_transaction=false
		return "DEFAULT_UPDATE_ROLLED_BACK: "+problem
	runtime.shared.error_transaction=false
	parameter_overrides.append_array(updates.duplicate(true))
	revision=str(packet.scene_revision);source_identity=str(packet.source_identity)
	runtime.release.revision=revision;runtime.release.source_identity=source_identity
	if is_instance_valid(runtime.simulation):runtime.simulation.scene_revision=revision
	return ""
func _default_change(key:String,update:Dictionary,changes:Array)->String:
	var node:Node=nodes[key];var prop=str(update.get("property",""))
	if not declarations[key].get("defaults",[]).has(prop):return "UNDECLARED_DEFAULT: "+prop
	var previous:Variant=node.get(prop);var value:Variant=Codec.coerce(update.get("value"),previous)
	if typeof(value)!=typeof(previous):return "DEFAULT_TYPE_MISMATCH"
	if update.has("previous") and Codec.encode(previous)!=update.previous:return "DEFAULT_BASE_MISMATCH"
	changes.append({"node":node,"property":prop,"previous":previous,"value":value})
	return ""
func apply_template_parameters(node:Node,resource:String,chain:Array=[],root:bool=true)->void:
	if not root and node.has_meta("wa_instance_id"):
		chain=chain.duplicate();chain.append(str(node.get_meta("wa_instance_id")))
	apply_node_parameters(node,resource,chain)
	for child in node.get_children():apply_template_parameters(child,resource,chain,false)
func apply_node_parameters(node:Node,resource:String,chain:Array)->void:
	var id=str(node.get_meta("wa_node_id",""))
	var declared:Variant=node.get_meta("wa_shared",{})
	if id.is_empty() or not declared is Dictionary:return
	var latest:Dictionary={}
	for update in parameter_overrides:
		if update.get("resource_id")==resource and update.get("node_id")==id and update.get("instance_ids",[])==chain:latest[str(update.property)]=update.value
	for property in latest:
		if not declared.get("defaults",[]).has(property) or not _has_property(node,property):error="COMMITTED_DEFAULT_TARGET_CHANGED";return
		var value:Variant=Codec.coerce(latest[property],node.get(property))
		if typeof(value)!=typeof(node.get(property)):error="COMMITTED_DEFAULT_TYPE_CHANGED";return
		node.set(property,value)

func stop_input(player_id:String)->void:
	if stopped.get(player_id,false):return
	stopped[player_id]=true
	for key in nodes:
		var declaration:Dictionary=declarations[key]
		var method=str(declaration.get("input_stop",""))
		var owner=str(nodes[key].get_meta("wa_shared_owner",spawns.get(declaration.dynamic_id,{}).get("owner_id","")))
		if (owner.is_empty() or owner==player_id) and not method.is_empty() and nodes[key].has_method(method):nodes[key].call(method,player_id)
	runtime.shared.player_input_stopped.emit(player_id)
func advance()->void:
	tick_count+=1
	for uid in last_input_usec:
		if Time.get_ticks_usec()-int(last_input_usec[uid])>750000:stop_input(uid)
