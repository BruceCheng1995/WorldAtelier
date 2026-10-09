extends SceneTree
## Build-time, read-only native preview derivation. Run with --editor in the
## existing enforced candidate sandbox. Original source scenes are never saved.
var report = {"ok":false,"scenes":{},"errors":[],"policy":{"editor_hint":false,"native_packed_scene":true,"scripts_removed":true,"game_ready":false,"source_unchanged":true}}
var resources_seen: Dictionary = {}
var logger: BakeLogger
class BakeLogger extends Logger:
	var errors: Array
	var mutex := Mutex.new()
	func _init(value: Array): errors=value
	func _log_error(_function: String,file: String,line: int,code: String,rationale: String,_editor_notify: bool,type: int,_backtraces: Array[ScriptBacktrace]):
		if type==Logger.ERROR_TYPE_WARNING: return
		mutex.lock()
		errors.append({"file":file,"line":line,"message":rationale if rationale!="" else code})
		mutex.unlock()
func _initialize():
	logger=BakeLogger.new(report.errors)
	OS.add_logger(logger)
	run.call_deferred()
func run():
	var args=OS.get_cmdline_user_args()
	var request=JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	report.policy.editor_hint=Engine.is_editor_hint()
	if not Engine.is_editor_hint(): report.errors.append({"message":"Native preview bake requires Godot --editor"})
	for item in request.get("scenes",[]):
		if not report.errors.is_empty(): break
		var source_path: String=item.source
		var target_path: String=item.output
		var packed: PackedScene=ResourceLoader.load(source_path,"PackedScene",ResourceLoader.CACHE_MODE_IGNORE_DEEP)
		if packed==null:
			report.errors.append({"message":"Native preview scene failed to load: "+source_path})
			break
		var node: Node=packed.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED)
		if node==null:
			report.errors.append({"message":"Native preview scene failed to instantiate: "+source_path})
			break
		resources_seen.clear()
		var statistics={"nodes":0,"node_scripts":0,"resource_scripts":0}
		strip_node(node,node,statistics)
		var preview=PackedScene.new()
		var packed_error=preview.pack(node)
		if packed_error==OK: packed_error=strip_control_editor_aliases(preview,node)
		if packed_error==OK:
			DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(target_path.get_base_dir()))
			packed_error=ResourceSaver.save(preview,target_path)
		if packed_error!=OK: report.errors.append({"message":"Native preview pack/save failed: "+error_string(packed_error)})
		node.free()
		report.scenes[source_path]={"path":target_path,"statistics":statistics,"dependencies":Array(ResourceLoader.get_dependencies(target_path))}
	report.ok=report.errors.is_empty()
	var output=FileAccess.open(args[1],FileAccess.WRITE)
	output.store_string(JSON.stringify(report,"\t"))
	print("NATIVE_PREVIEW_BAKE "+JSON.stringify(report))
	OS.remove_logger(logger)
	quit(0 if report.ok else 1)
func strip_control_editor_aliases(packed: PackedScene, scene_root: Node) -> Error:
	# This derivative is already flattened. The loaded nodes' real anchors,
	# offsets and grow directions are the canonical display properties. Godot's
	# computed editor aliases can reset those properties on the next load, so
	# remove the aliases regardless of how the author originally selected them.
	var state:=packed.get_state()
	var controls: Dictionary={}
	for i in state.get_node_count():
		if scene_root.get_node_or_null(state.get_node_path(i)) is Control: controls[i]=true
	if controls.is_empty(): return OK
	var bundle: Dictionary=packed.get("_bundled")
	if int(bundle.get("version",0))!=3: return ERR_UNAVAILABLE
	var names: PackedStringArray=bundle.names
	var words: PackedInt32Array=bundle.nodes
	var filtered:=PackedInt32Array()
	var cursor:=0
	var removed:=false
	for i in state.get_node_count():
		filtered.append_array(words.slice(cursor,cursor+5))
		cursor+=5
		var property_count:=words[cursor]
		cursor+=1
		var properties:=PackedInt32Array()
		for j in property_count:
			var name_index:=words[cursor]
			if controls.has(i) and name_index>=0 and name_index<names.size() and names[name_index] in ["layout_mode","anchors_preset"]: removed=true
			else: properties.append_array(words.slice(cursor,cursor+2))
			cursor+=2
		filtered.append(properties.size()/2)
		filtered.append_array(properties)
		var group_count:=words[cursor]
		filtered.append_array(words.slice(cursor,cursor+group_count+1))
		cursor+=group_count+1
	if cursor!=words.size(): return ERR_INVALID_DATA
	if removed:
		bundle.nodes=filtered
		packed.set("_bundled",bundle)
	return OK
func strip_node(node: Node, owner_root: Node, statistics: Dictionary):
	statistics.nodes+=1
	node.process_mode=Node.PROCESS_MODE_DISABLED
	if node.get_script()!=null:
		statistics.node_scripts+=1
		node.set_script(null)
	# Static preview never dispatches source connections, including built-in UI.
	for signal_info in node.get_signal_list():
		for connection in node.get_signal_connection_list(signal_info.name):
			if int(connection.flags) & Object.CONNECT_PERSIST: node.disconnect(signal_info.name,connection.callable)
	node.scene_file_path=""
	if node!=owner_root: node.owner=owner_root
	if node is Camera3D: node.current=false
	if node is Camera2D: node.enabled=false
	if node is AnimationPlayer: node.autoplay=""
	if node is AnimationTree: node.active=false
	if node is AnimatedSprite2D or node is AnimatedSprite3D: node.pause()
	if node is Control:
		node.mouse_filter=Control.MOUSE_FILTER_IGNORE
		node.focus_mode=Control.FOCUS_NONE
	if node is VideoStreamPlayer:
		node.autoplay=false
		node.paused=true
	if node is Timer: node.autostart=false
	if node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D:
		node.autoplay=false
		node.stream_paused=true
	if node is RigidBody3D or node is RigidBody2D: node.freeze=true
	if node is CollisionObject3D or node is CollisionObject2D:
		node.collision_layer=0
		node.collision_mask=0
	if node is Area3D or node is Area2D:
		node.monitoring=false
		node.monitorable=false
	if node is GPUParticles3D or node is CPUParticles3D or node is GPUParticles2D or node is CPUParticles2D: node.speed_scale=0
	for property in node.get_property_list():
		if not (int(property.usage)&PROPERTY_USAGE_STORAGE): continue
		var value=node.get(property.name)
		if value is Resource or value is Array or value is Dictionary:
			var clean=strip_value(value,statistics)
			if clean!=value: node.set(property.name,clean)
	for child in node.get_children(): strip_node(child,owner_root,statistics)
func strip_value(value: Variant, statistics: Dictionary) -> Variant:
	if value is Script: return null
	if value is PackedScene: return null
	if value is Resource:
		if resources_seen.has(value.get_instance_id()): return value
		resources_seen[value.get_instance_id()]=true
		# Save engine resources inside the derivative. Keep imported media paths:
		# CompressedTexture and AudioStream data refer to their import artifacts.
		var external_extension=str(value.resource_path).get_extension().to_lower()
		if external_extension in ["tres","res","tscn","scn"] or "::" in value.resource_path:
			value.resource_path=""
		if value.get_script()!=null:
			statistics.resource_scripts+=1
			value.set_script(null)
			value.resource_path=""
		for property in value.get_property_list():
			if not (int(property.usage)&PROPERTY_USAGE_STORAGE) or str(property.name)=="script": continue
			var nested=value.get(property.name)
			if nested is Resource or nested is Array or nested is Dictionary:
				var clean=strip_value(nested,statistics)
				if clean!=nested:
					value.set(property.name,clean)
					value.resource_path=""
		return value
	if value is Array:
		var copy=value.duplicate()
		for index in copy.size(): copy[index]=strip_value(copy[index],statistics)
		return copy
	if value is Dictionary:
		var copy=value.duplicate()
		for key in copy: copy[key]=strip_value(copy[key],statistics)
		return copy
	return value
