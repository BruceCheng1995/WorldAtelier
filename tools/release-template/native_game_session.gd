extends Node
## Observation facade over the actual current_scene. This never assembles nodes
## from JSON. Native scripts keep their own ordinary Godot lifecycle.
const Hierarchy = preload("res://hierarchy_scene.gd")
var runtime: Node
var scene_root: Node
var legacy: RefCounted
var document: Dictionary = {}
var objects: Dictionary = {}
var definitions: Dictionary = {}
var assets: Dictionary = {}
var asset_hashes: Array = []
var scene_revision = ""
var world_id = ""
var epoch = 1
var tick = 0
var active = false
var last_fault: Dictionary = {}
var behaviors: ObservedBehaviors
var disposed = false

class ObservedBehaviors extends RefCounted:
	var session: Node
	var hashes: Array = []
	var fault: Dictionary:
		get: return session.last_fault if is_instance_valid(session) else {}
	func _init(value: Node) -> void: session = value
	func snapshot() -> Dictionary: return session.legacy.snapshot() if is_instance_valid(session) and session.legacy != null else {}
	func freeze(value: bool) -> void:
		if is_instance_valid(session): session.freeze(value)
	func dispose() -> void:
		if is_instance_valid(session): session.dispose()

func initialize(owner_runtime: Node, actual_scene: Node, source_document: Dictionary) -> String:
	runtime = owner_runtime
	scene_root = actual_scene
	document = source_document.duplicate(true)
	scene_revision = str(document.get("scene_revision", runtime.release.revision))
	world_id = runtime.debug.world_id if runtime.debug.started else "offline:"+str(runtime.release.get("project_id","game"))+":"+runtime.current_scene_id
	epoch = runtime.debug.epoch if runtime.debug.started else runtime.generation
	assets = runtime.release.get("assets", {}).duplicate(true)
	behaviors = ObservedBehaviors.new(self)
	if _has_legacy_behavior(scene_root) and ResourceLoader.exists("res://atelier_legacy/runtime.gd"):
		var script_files = runtime.release.get("native_script_files")
		if not script_files is Dictionary: return "固定原生工程缺少兼容脚本文件清单，请重新构建"
		var identity_error := _bind_legacy_sources(scene_root, script_files, {})
		if not identity_error.is_empty(): return identity_error
		var bridge_script: Script = load("res://atelier_legacy/runtime.gd")
		if bridge_script == null: return "无法加载原生场景的旧玩法兼容脚本"
		legacy = bridge_script.new()
		var problem: String = legacy.initialize(scene_root,{"project_id":runtime.release.get("project_id"),"branch_id":runtime.release.get("branch_id"),"resource_id":runtime.current_scene_id,"source_revision":scene_revision})
		if not problem.is_empty(): return problem
		behaviors.hashes = legacy.hashes.duplicate()
	elif _has_legacy_behavior(scene_root):
		return "原生场景包含旧玩法节点，但固定工程缺少兼容脚本"
	var indexed: Dictionary = {}
	_collect(scene_root, [], indexed)
	for source_row in document.get("objects", []):
		if not source_row is Dictionary: continue
		var row: Dictionary = source_row.duplicate(true)
		var address: Dictionary = row.get("address", {})
		var node_id := str(address.get("definition_node_id",row.get("node_id","")))
		var chain: Array = address.get("instance_path",row.get("instance_ids",[]))
		var node: Node = scene_root.get_node_or_null(NodePath(str(row.get("native_path",row.get("native_node_path",""))))) if row.has("native_path") or row.has("native_node_path") else null
		# The source index supplies the exact engine path; IDs are protocol data,
		# never node names. A creator's _ready may legitimately remove that node.
		if node != null and not node_id.is_empty() and str(node.get_meta("wa_node_id","")) != node_id: return "原生运行节点身份与固定索引不符："+str(row.get("native_path",""))
		if node == null: continue # Script may intentionally remove source nodes in _ready.
		var id := str(row.get("id",node_id))
		if id.is_empty() or objects.has(id): return "重复的原生运行对象身份："+id
		objects[id] = node
		definitions[id] = row
	return ""

func _bind_legacy_sources(node: Node, files: Dictionary, verified: Dictionary) -> String:
	if node.get_meta("wa_asset_model",false): return ""
	if node.get_meta("wa_component","") == "behavior" and node.has_method("legacy_properties") and node.get("source_script") is Script:
		var script: Script = node.get("source_script")
		var path: String = script.resource_path
		if not path.begins_with("res://"): return "原生兼容脚本不属于固定工程：" + path
		if not verified.has(path):
			var entry = files.get(path.trim_prefix("res://"))
			if not entry is Dictionary or not entry.get("hash") is String or not entry.has("size"):
				return "原生兼容脚本不在固定源清单中：" + path
			var file := FileAccess.open(path,FileAccess.READ)
			if file == null: return "无法读取固定原生兼容脚本：" + path
			var bytes := file.get_buffer(file.get_length())
			file.close()
			var digest := HashingContext.new()
			digest.start(HashingContext.HASH_SHA256)
			digest.update(bytes)
			if bytes.size() != int(entry.size) or digest.finish().hex_encode() != entry.hash:
				return "原生兼容脚本与固定源 SHA-256 不匹配：" + path
			# The legacy registry hashes decoded GDScript text again. Its key is
			# derived only after exact archived bytes have passed verification.
			verified[path] = bytes.get_string_from_utf8().sha256_text()
		# Only this runtime instance changes; PackedScene defaults, overrides,
		# the native source archive and historical releases remain untouched.
		node.set("script_hash",verified[path])
	for child in node.get_children():
		var problem := _bind_legacy_sources(child,files,verified)
		if not problem.is_empty(): return problem
	return ""

func _has_legacy_behavior(node: Node) -> bool:
	if node.get_meta("wa_asset_model",false): return false
	if node.get_meta("wa_component","") == "behavior" and node.has_method("legacy_properties") and node.get("source_script") is Script: return true
	for child in node.get_children():
		if _has_legacy_behavior(child): return true
	return false

func _collect(node: Node, instances: Array, indexed: Dictionary) -> void:
	var chain := instances.duplicate()
	if node != scene_root and node.has_meta("wa_instance_id"): chain.append(str(node.get_meta("wa_instance_id")))
	var node_id := str(node.get_meta("wa_node_id",""))
	if not node_id.is_empty(): indexed[JSON.stringify([chain,node_id])] = node
	for child in node.get_children(): _collect(child,chain,indexed)

func step(delta: float) -> void:
	if not active or disposed: return
	tick += 1
	if legacy != null:
		legacy.step(delta)
		_check_fault()
	_prune_removed()

func advance(delta: float) -> void:
	if not active or disposed: return
	if legacy != null:
		legacy.advance(delta)
		_check_fault()

func _check_fault() -> void:
	if legacy != null and not legacy.fault().is_empty(): last_fault = {"role":"legacy","error":legacy.fault()}

func _prune_removed() -> void:
	for id in objects.keys():
		if not is_instance_valid(objects[id]) or not objects[id].is_inside_tree():
			objects.erase(id)
			definitions.erase(id)

func snapshot(_compact: bool = false) -> Dictionary:
	_prune_removed()
	return {"world_id":world_id,"epoch":epoch,"scene_revision":scene_revision,"sequence":tick,"tick":tick,"object_states":behaviors.snapshot() if behaviors != null else {},"players":[],"asset_hashes":asset_hashes.duplicate()}

func rendered_players() -> Dictionary: return {}

func freeze(value: bool) -> void:
	active = not value
	if legacy != null: legacy.freeze(value)

func dispose() -> void:
	if disposed: return
	disposed = true
	active = false
	if legacy != null: legacy.dispose()
	legacy = null
	objects.clear()
	definitions.clear()

func observe(id: String) -> Dictionary:
	if not objects.has(id) or not is_instance_valid(objects[id]): return {}
	var node: Node = objects[id]
	var row: Dictionary = definitions[id]
	var result := {"id":id,"version":row.get("object_version",row.get("version","")),"address":row.get("address",{}).duplicate(true),"source_revision":scene_revision,"native_node_path":str(scene_root.get_path_to(node)),"native_type":node.get_class(),"model_hash":row.get("model_hash","")}
	for key in ["ancestry_hash","definition_revision","definition_node_version","object_version"]:
		if row.has(key): result[key] = row[key]
	if node is Node3D:
		result.position = [node.global_position.x,node.global_position.y,node.global_position.z]
		result.world_matrix = Hierarchy.matrix(node.global_transform)
		result.local_transform = Hierarchy.local_trs(node)
		result.dimension = "3d"
	elif node is CanvasItem:
		var transform: Transform2D = node.get_global_transform()
		result.position = [transform.origin.x,transform.origin.y,0]
		result.world_matrix = [transform.x.x,transform.x.y,0,0,transform.y.x,transform.y.y,0,0,0,0,1,0,transform.origin.x,transform.origin.y,0,1]
		result.canvas_transform = [transform.x.x,transform.x.y,transform.y.x,transform.y.y,transform.origin.x,transform.origin.y]
		result.dimension = "2d"
		result.local_transform = {"position":[node.position.x,node.position.y,0],"rotation":[0,0,sin(node.rotation*.5),cos(node.rotation*.5)],"scale":[node.scale.x,node.scale.y,1]} if node is Node2D or node is Control else null
	else:
		result.dimension = null
		result.local_transform = null
	if node is Control:
		var layout: Dictionary = row.get("control_layout",{}).duplicate(true)
		layout["needs_measurement"] = false
		layout["values"] = {"anchors":[node.anchor_left,node.anchor_top,node.anchor_right,node.anchor_bottom],"offsets":[node.offset_left,node.offset_top,node.offset_right,node.offset_bottom],"position":[node.position.x,node.position.y],"size":[node.size.x,node.size.y],"pivot_offset":[node.pivot_offset.x,node.pivot_offset.y],"rotation_degrees":node.rotation_degrees,"scale":[node.scale.x,node.scale.y],"custom_minimum_size":[node.custom_minimum_size.x,node.custom_minimum_size.y],"grow_horizontal":node.grow_horizontal,"grow_vertical":node.grow_vertical,"size_flags_horizontal":node.size_flags_horizontal,"size_flags_vertical":node.size_flags_vertical,"size_flags_stretch_ratio":node.size_flags_stretch_ratio}
		layout["viewport_size"] = [node.get_viewport_rect().size.x,node.get_viewport_rect().size.y]
		layout["parent_size"] = [node.get_parent_area_size().x,node.get_parent_area_size().y]
		result["control_layout"] = layout
	return result

func owned_meshes(node: Node, root: Node = null) -> Array:
	if root == null: root = node
	var found: Array = []
	if node != root and objects.values().has(node): return found
	if node is MeshInstance3D and node.mesh != null: found.append(node)
	for child in node.get_children(): found.append_array(owned_meshes(child,root))
	return found

func world_bounds(node: Node) -> Dictionary:
	var box := AABB()
	var count := 0
	for mesh in owned_meshes(node):
		var own: AABB = mesh.global_transform * mesh.get_aabb()
		box = box.merge(own) if count else own
		count += 1
	if count == 0 and node is Node3D: box = AABB(node.global_position-Vector3.ONE*.2,Vector3.ONE*.4)
	return {"bounds":box,"mesh_count":count}

func canvas_bounds(node: CanvasItem) -> Rect2:
	var local := Rect2(Vector2(-16,-16),Vector2(32,32))
	if node is Control: local = Rect2(Vector2.ZERO,node.size)
	elif node.has_method("get_rect"): local = node.get_rect()
	var transform: Transform2D = node.get_global_transform()
	var result := Rect2(transform * local.position,Vector2.ZERO)
	for corner in [local.position+Vector2(local.size.x,0),local.end,local.position+Vector2(0,local.size.y)]: result = result.expand(transform * corner)
	return result
