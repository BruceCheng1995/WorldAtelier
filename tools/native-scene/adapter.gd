extends SceneTree
## Native scene source adapter. Every write targets an isolated candidate project.
## Godot's edit state and PackedScene serializer own instance inheritance.

const PROTOCOL = "wa-native-scene-1"
var errors: Array = []
var defaults: Dictionary = {}
var scene_root: Node
var source_scene: PackedScene
var request: Dictionary
var changed_files: Array = []
var native_logger: AdapterLogger
var index_state: SceneState
var project_info: Dictionary = {}
var batch_scenes: Array = []
var layout_viewport: SubViewport
var layout_root: Node
var layout_resources: Dictionary = {}
var authored_control_layout_aliases: Dictionary = {}

class AdapterLogger extends Logger:
	var failures: Array
	var lock := Mutex.new()
	var allow_orphan_cleanup = false
	var discarded_overrides: Array = []
	func _init(target: Array) -> void: failures = target
	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		var message := rationale if rationale != "" else code
		var orphaned := file.ends_with("packed_scene.cpp") and (message.contains("was modified from inside an instance, but it has vanished") or (message.contains("Parent path") and message.contains("has vanished")))
		if orphaned and allow_orphan_cleanup:
			lock.lock()
			discarded_overrides.append({"message":message,"file":file,"line":line})
			lock.unlock()
			return
		if error_type == Logger.ERROR_TYPE_WARNING and not orphaned: return
		lock.lock()
		failures.append({"code":"ORPHANED_SCENE_OVERRIDE" if orphaned else "GODOT_ERROR", "message":message, "function":function,"file":file,"line":line,"error_type":error_type})
		lock.unlock()

func _initialize() -> void:
	native_logger = AdapterLogger.new(errors)
	OS.add_logger(native_logger)
	call_deferred("_run")

func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input_path := ""
	var output_path := ""
	for i in range(args.size() - 1):
		if args[i] == "--request": input_path = args[i + 1]
		if args[i] == "--response": output_path = args[i + 1]
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(input_path))
	if not parsed is Dictionary:
		errors.append({"code":"INVALID_REQUEST", "message":"Request must be a JSON object"})
	else:
		request = parsed
		native_logger.allow_orphan_cleanup = request.get("action", "inspect") == "apply" and request.get("discard_removed_overrides", false) == true
		await _execute()
	var result := _scene_result()
	if request.get("action") == "inspect_many" and errors.is_empty(): result["scenes"] = batch_scenes
	if not native_logger.discarded_overrides.is_empty(): result["discarded_overrides"] = native_logger.discarded_overrides.duplicate(true)
	if output_path != "":
		var file := FileAccess.open(output_path, FileAccess.WRITE)
		if file: file.store_string(JSON.stringify(result, "\t") + "\n")
		else: push_error("Cannot write native scene response: " + output_path)
	print("WA_NATIVE_SCENE_RESULT " + JSON.stringify({"ok":result.ok,"scene_path":result.scene_path,"errors":errors}))
	_release_scene_state()
	OS.remove_logger(native_logger)
	quit(0 if errors.is_empty() else 1)

func _scene_result() -> Dictionary:
	var result := {"ok":errors.is_empty(), "protocol":PROTOCOL, "engine_version":Engine.get_version_info().string, "scene_path":request.get("scene_path", ""), "changed_files":changed_files.duplicate(), "errors":errors}
	if not project_info.is_empty(): result["project_info"] = project_info
	if scene_root != null and errors.is_empty(): result.merge(_index())
	result.ok = errors.is_empty()
	result.errors = errors.duplicate(true)
	return result

func _release_scene_state() -> void:
	_clear_layout()
	if is_instance_valid(scene_root): scene_root.free()
	scene_root = null
	for node in defaults.values():
		if is_instance_valid(node): node.free()
	defaults.clear()
	index_state = null
	source_scene = null
	authored_control_layout_aliases.clear()

func _inspect_many() -> void:
	var paths: Variant = request.get("scene_paths")
	if not paths is Array or paths.is_empty() or paths.size() > 512:
		_error("INVALID_BATCH_REQUEST", "scene_paths must contain 1–512 unique scene paths")
		return
	if request.has("ops") or request.has("assign_ids") or request.has("discard_removed_overrides"):
		_error("INVALID_BATCH_REQUEST", "inspect_many accepts only read-only scene inspection")
		return
	if _batch_has_native_extension("res://"):
		_error("BATCH_SCRIPT_ISOLATION_REQUIRED", "Native extensions require separate scene inspection processes")
		return
	var seen: Dictionary = {}
	for path in paths:
		if not path is String or not _valid_scene_path(path) or seen.has(path):
			_error("INVALID_BATCH_REQUEST", "scene_paths must contain unique project-local scene paths")
			return
		seen[path] = true
	if not errors.is_empty(): return
	var batch_request := request.duplicate(true)
	for path in paths:
		# The Logger holds this exact error array. Clear it rather than replacing
		# the reference; a failing scene aborts before the next scene can start.
		errors.clear()
		changed_files.clear()
		project_info.clear()
		native_logger.discarded_overrides.clear()
		request = batch_request.duplicate(true)
		request.action = "inspect"
		request.scene_path = path
		await _execute()
		# A single editor process cannot reset user Script static state or Engine
		# singletons. Discard the entire batch and let the caller use isolated
		# single-scene requests whenever loading can execute authored code.
		if errors.is_empty() and _batch_resource_requires_isolation(source_scene, {}):
			_error("BATCH_SCRIPT_ISOLATION_REQUIRED", "Executable scripts or scripted Resources require separate scene inspection processes")
		var response := _scene_result()
		_release_scene_state()
		if not errors.is_empty():
			for error in errors: error["scene_path"] = path
			batch_scenes.clear()
			break
		batch_scenes.append(response)
	request = batch_request


func _batch_has_native_extension(directory: String) -> bool:
	for filename in DirAccess.get_files_at(directory):
		if filename.ends_with(".gdextension"): return true
	for child in DirAccess.get_directories_at(directory):
		if child in [".godot", ".git"]: continue
		if _batch_has_native_extension(directory.path_join(child)): return true
	return false


func _batch_resource_requires_isolation(value: Variant, seen: Dictionary) -> bool:
	if value is Array:
		for item in value:
			if _batch_resource_requires_isolation(item, seen): return true
	elif value is Dictionary:
		for key in value:
			if _batch_resource_requires_isolation(key, seen) or _batch_resource_requires_isolation(value[key], seen): return true
	elif value is Resource:
		if seen.has(value.get_instance_id()): return false
		seen[value.get_instance_id()] = true
		if value is Script:
			# GDScript placeholders do not run ordinary Node methods in the
			# editor. Tool scripts and static initializers can run without tree
			# entry. A conservative token match also rejects comments mentioning
			# static; it never treats an executable initializer as isolated.
			if not value is GDScript or value.is_tool() or value.source_code.is_empty() or value.source_code.contains("static"): return true
			if value.get_instance_base_type() == "Resource" or ClassDB.is_parent_class(value.get_instance_base_type(), "Resource"): return true
			if _batch_resource_requires_isolation(value.get_base_script(), seen): return true
			if _batch_resource_requires_isolation(value.get_script_constant_map(), seen): return true
			for descriptor in value.get_script_property_list():
				if int(descriptor.usage) & PROPERTY_USAGE_STORAGE and _batch_resource_requires_isolation(value.get_property_default_value(descriptor.name), seen): return true
			return false
		# Custom Resource constructors/getters and local-to-scene setup can
		# execute even when every Node script is an editor placeholder.
		if value.get_script() != null: return true
		for descriptor in value.get_property_list():
			if int(descriptor.usage) & PROPERTY_USAGE_STORAGE and _batch_resource_requires_isolation(value.get(descriptor.name), seen): return true
	return false


func _error(code: String, message: String) -> bool:
	errors.append({"code":code,"message":message})
	return false

func _valid_scene_path(path: String) -> bool:
	return path.begins_with("res://") and (path.ends_with(".tscn") or path.ends_with(".scn")) and not path.contains("..") and not path.contains("\\")

func _execute() -> void:
	if request.get("protocol", PROTOCOL) != PROTOCOL:
		_error("INVALID_PROTOCOL", "Expected " + PROTOCOL)
		return
	if request.get("action") == "inspect_many":
		await _inspect_many()
		return
	if request.get("action", "inspect") == "project_info":
		var main := str(ProjectSettings.get_setting("application/run/main_scene", ""))
		if main.begins_with("uid://"):
			var uid := ResourceUID.text_to_id(main)
			if not ResourceUID.has_id(uid):
				_error("MAIN_SCENE_UID_MISSING", main)
				return
			main = ResourceUID.get_id_path(uid)
		project_info = {"main_scene":main, "name":str(ProjectSettings.get_setting("application/config/name", ""))}
		return
	var path := str(request.get("scene_path", ""))
	if not _valid_scene_path(path):
		_error("INVALID_SCENE_PATH", "scene_path must be a project-local res:// .tscn path")
		return
	var action := str(request.get("action", "inspect"))
	if action == "create_scene":
		if FileAccess.file_exists(path):
			_error("SCENE_EXISTS", path)
			return
		scene_root = _new_node(str(request.get("root_type", "Node3D")))
		if scene_root == null: return
		scene_root.name = str(request.get("name", path.get_file().get_basename()))
		scene_root.set_meta("wa_node_id", str(request.get("node_id", _uuid())))
	else:
		if not FileAccess.file_exists(path):
			_error("SCENE_NOT_FOUND", path)
			return
		source_scene = ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_REPLACE_DEEP)
		if source_scene == null:
			_error("SCENE_LOAD_FAILED", path)
			return
		scene_root = source_scene.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
		if scene_root == null:
			_error("SCENE_INSTANTIATE_FAILED", path)
			return
	_capture_control_layout_aliases()
	if action not in ["inspect", "apply", "create_scene"]:
		_error("INVALID_ACTION", action)
		return
	if action == "inspect":
		await _prepare_layout()
		return
	if request.get("assign_ids", true): _assign_ids(scene_root)
	for operation in request.get("ops", []):
		if operation is Dictionary and operation.get("op") == "control_layout": await _prepare_layout(operation.get("viewport_size", []))
		if not operation is Dictionary or not errors.is_empty() or not await _apply(operation): return
	if not errors.is_empty(): return
	var packed := PackedScene.new()
	var pack_error := _pack_source(packed)
	if pack_error != OK:
		_error("SCENE_PACK_FAILED", error_string(pack_error))
		return
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(path.get_base_dir()))
	var save_error := ResourceSaver.save(packed, path)
	if save_error != OK:
		_error("SCENE_SAVE_FAILED", error_string(save_error))
		return
	changed_files.append(path.trim_prefix("res://"))
	# Re-open bytes from disk: response describes the persisted result, not memory.
	scene_root.free()
	source_scene = ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_REPLACE_DEEP)
	scene_root = source_scene.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
	if scene_root == null: _error("SCENE_RELOAD_FAILED", path)
	else:
		_capture_control_layout_aliases()
		await _prepare_layout()

func _uuid() -> String:
	var bytes := Crypto.new().generate_random_bytes(16)
	bytes[6] = (bytes[6] & 15) | 64
	bytes[8] = (bytes[8] & 63) | 128
	var s := bytes.hex_encode()
	return "%s-%s-%s-%s-%s" % [s.substr(0,8),s.substr(8,4),s.substr(12,4),s.substr(16,4),s.substr(20,12)]

func _assign_ids(node: Node) -> void:
	if node == scene_root or node.owner == scene_root:
		if node != scene_root and node.scene_file_path != "":
			var mounted: bool = node.get_parent() != null and bool(node.get_parent().get_meta("wa_instance_mount", false))
			if not mounted and (not node.has_meta("wa_instance_id") or not _own_properties(_path(node)).has("metadata/wa_instance_id")):
				node.set_meta("wa_instance_id", _uuid())
		elif not node.has_meta("wa_node_id") and not node.get_meta("wa_instance_mount", false):
			node.set_meta("wa_node_id", _uuid())
	for child in node.get_children(true): _assign_ids(child)

func _path(node: Node) -> String:
	return str(scene_root.get_path_to(node))

func _all_nodes(node: Node, result: Array = []) -> Array:
	result.append(node)
	for child in node.get_children(true): _all_nodes(child, result)
	return result

func _instance_ids(node: Node) -> Array:
	var result: Array = []
	var at := node
	while at != null and at != scene_root:
		if (at.scene_file_path != "" or bool(at.get_meta("wa_instance_mount", false))) and str(at.get_meta("wa_instance_id", "")) != "":
			result.push_front(str(at.get_meta("wa_instance_id")))
		at = at.get_parent()
	return result

func _resolve(target: Variant) -> Node:
	if target is String: target = {"path":target}
	if not target is Dictionary:
		_error("INVALID_TARGET", "An explicit stable node address or path is required")
		return null
	var matches: Array = []
	for node in _all_nodes(scene_root):
		if target.has("node_id") and str(node.get_meta("wa_node_id", "")) != str(target.node_id): continue
		if target.has("instance_ids") and _instance_ids(node) != target.instance_ids: continue
		if target.has("path") and _path(node) != str(target.path): continue
		if target.get("mount", false) and not node.get_meta("wa_instance_mount", false): continue
		if not target.has("node_id") and not target.has("path") and not target.get("mount", false): continue
		matches.append(node)
	if matches.size() != 1:
		_error("TARGET_NOT_UNIQUE", "Target resolved to %d nodes" % matches.size())
		return null
	return matches[0]

func _new_node(type_name: String) -> Node:
	if not ClassDB.class_exists(type_name) or not ClassDB.can_instantiate(type_name) or not ClassDB.is_parent_class(type_name, "Node"):
		_error("INVALID_NODE_TYPE", type_name)
		return null
	return ClassDB.instantiate(type_name)

func _make_editable(node: Node) -> void:
	var at := node
	while at != null and at != scene_root:
		if at.scene_file_path != "": scene_root.set_editable_instance(at, true)
		at = at.get_parent()

func _locally_owned(node: Node) -> bool:
	if node == scene_root or node.owner == scene_root: return true
	return _error("INHERITED_STRUCTURE", "Edit this node's owning scene to rename, remove, or reparent inherited structure")

func _apply(op: Dictionary) -> bool:
	var kind := str(op.get("op", ""))
	if kind == "import_model":
		var parent := _resolve(op.get("parent", {"path":"."}))
		if parent == null: return false
		var model_path := str(op.get("scene_path", ""))
		if not model_path.begins_with("res://assets/") or not model_path.ends_with(".glb") or model_path.contains("..") or model_path.contains("\\"):
			return _error("INVALID_MODEL_PATH", model_path)
		var packed: PackedScene = ResourceLoader.load(model_path, "PackedScene")
		if packed == null: return _error("MODEL_LOAD_FAILED", model_path)
		var model := packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
		if model == null: return _error("MODEL_INSTANTIATE_FAILED", model_path)
		var wrapper := Node3D.new()
		wrapper.name = str(op.get("name", "Model"))
		if not _name_available(parent, str(wrapper.name), null):
			model.free()
			wrapper.free()
			return false
		wrapper.set_meta("wa_node_id", str(op.get("node_id", _uuid())))
		wrapper.set_meta("wa_label", str(op.get("name", "Model")))
		_make_editable(parent)
		parent.add_child(wrapper)
		wrapper.owner = scene_root
		model.name = "Model"
		model.set_meta("wa_asset_model", true)
		model.set_meta("wa_asset_hash", str(op.get("asset_hash", "")))
		wrapper.add_child(model)
		model.owner = scene_root
		return true
	if kind in ["instantiate", "create_node"]:
		var parent := _resolve(op.get("parent", {"path":"."}))
		if parent == null: return false
		var added: Node
		if kind == "instantiate":
			var path := str(op.get("scene_path", ""))
			if not _valid_scene_path(path): return _error("INVALID_SCENE_PATH", path)
			if path == request.scene_path or _depends_on(path, request.scene_path): return _error("SCENE_CYCLE", path)
			var packed: PackedScene = ResourceLoader.load(path, "PackedScene")
			if packed == null: return _error("SCENE_LOAD_FAILED", path)
			added = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
			if added == null: return _error("SCENE_INSTANTIATE_FAILED", path)
			added.set_meta("wa_instance_id", str(op.get("instance_id", _uuid())))
		else:
			added = _new_node(str(op.get("type", "Node3D")))
			if added == null: return false
			added.set_meta("wa_node_id", str(op.get("node_id", _uuid())))
			if op.get("author_kind", "") == "anchor": added.set_meta("wa_author_kind", "anchor")
		added.name = str(op.get("name", added.name))
		if not _name_available(parent, str(added.name), null):
			added.free()
			return false
		parent.add_child(added, true)
		added.owner = scene_root
		for prop in op.get("properties", {}):
			if not _set_property(added, prop, op.properties[prop]): return false
		if kind == "instantiate" and op.has("placement"):
			return await _place_instance(added, op.placement)
		return true
	var node := _resolve(op.get("target"))
	if node == null: return false
	match kind:
		"set_property":
			return _set_property(node, str(op.get("property", "")), op.get("value"))
		"reset_property":
			var prop := str(op.get("property", ""))
			if prop in ["name", "owner", "scene_file_path", "script"] or prop.begins_with("metadata/wa_"):
				return _error("STRUCTURAL_PROPERTY", "Stable identity and structural properties cannot be reset")
			var base := _baseline(node, prop)
			if not base.known: return _error("NO_PROPERTY_DEFAULT", prop)
			_make_editable(node)
			node.set(prop, base.value)
			if node is Control and prop in ["layout_mode", "anchors_preset"]:
				var aliases: Dictionary = authored_control_layout_aliases.get(node.get_instance_id(), {})
				aliases.erase(prop)
			var pins: Array = node.get_meta("_edit_pinned_properties_", [])
			pins.erase(prop)
			if pins.is_empty(): node.remove_meta("_edit_pinned_properties_")
			else: node.set_meta("_edit_pinned_properties_", pins)
			return true
		"rename":
			if not _locally_owned(node): return false
			var name_value := str(op.get("name", ""))
			if not _name_available(node.get_parent(), name_value, node): return false
			var references := _capture_references()
			node.name = name_value
			if node.has_meta("wa_label"): node.set_meta("wa_label", name_value)
			return _restore_references(references)
		"control_layout":
			return _apply_control_layout(node, op)
		"transform":
			if not (node is Node3D or node is Node2D): return _error("NOT_SPATIAL", _path(node))
			_make_editable(node)
			var value: Dictionary = op.get("value", op.get("transform", {}))
			if node is Node3D:
				if value.has("position"): node.position = _decode(value.position, TYPE_VECTOR3)
				if value.has("rotation_degrees"): node.rotation_degrees = _decode(value.rotation_degrees, TYPE_VECTOR3)
				elif value.has("rotation"): node.rotation = _decode(value.rotation, TYPE_VECTOR3)
				if value.has("scale"): node.scale = _decode(value.scale, TYPE_VECTOR3)
			else:
				if value.has("position"): node.position = _decode(value.position, TYPE_VECTOR2)
				if value.has("rotation_degrees"): node.rotation_degrees = float(value.rotation_degrees)
				elif value.has("rotation"): node.rotation = float(value.rotation)
				if value.has("scale"): node.scale = _decode(value.scale, TYPE_VECTOR2)
			return true
		"transform_world":
			if not node is Node3D: return _error("NOT_SPATIAL", "World gizmo transform requires a Node3D")
			var values: Variant = op.get("world_matrix")
			if not values is Array or values.size() != 16: return _error("INVALID_TRANSFORM", "A complete world matrix is required")
			for scalar in values:
				if not (scalar is int or scalar is float) or not is_finite(float(scalar)): return _error("INVALID_TRANSFORM", "World matrix must contain finite numbers")
			if values[3] != 0 or values[7] != 0 or values[11] != 0 or values[15] != 1: return _error("INVALID_TRANSFORM", "Expected affine world matrix")
			var desired := Transform3D(Basis(Vector3(values[0],values[1],values[2]),Vector3(values[4],values[5],values[6]),Vector3(values[8],values[9],values[10])),Vector3(values[12],values[13],values[14]))
			if op.has("reference_target"):
				var reference := _resolve(op.reference_target)
				if not reference is Node3D or reference != node and not node.is_ancestor_of(reference): return _error("INVALID_TRANSFORM", "Reference must belong to the selected instance")
				var reference_world: Transform3D = _world_transform(reference)
				if abs(reference_world.basis.determinant()) < 0.00000001: return _error("INVALID_TRANSFORM", "Reference transform is singular")
				desired = desired * reference_world.affine_inverse() * _world_transform(node)
			var parent := node.get_parent()
			if parent is Node3D and not node.top_level:
				var parent_world: Transform3D = _world_transform(parent)
				if abs(parent_world.basis.determinant()) < 0.00000001: return _error("INVALID_TRANSFORM", "Parent transform is singular")
				desired = parent_world.affine_inverse() * desired
			_make_editable(node)
			node.transform = desired
			return true
		"delete_node":
			if node == scene_root: return _error("ROOT_DELETE", "Remove a scene through the source transaction")
			if not _locally_owned(node): return false
			node.get_parent().remove_child(node)
			node.free()
			return true
		"reparent":
			if node == scene_root or not _locally_owned(node): return _error("INVALID_REPARENT", "Cannot reparent root or inherited structure")
			var parent := _resolve(op.get("parent"))
			if parent == null: return false
			if parent == node or node.is_ancestor_of(parent): return _error("PARENT_CYCLE", _path(node))
			if not _name_available(parent, str(node.name), node): return false
			var owned: Array = []
			for child in _all_nodes(node):
				if child.owner == scene_root: owned.append(child)
			# Keep global transform outside SceneTree by computing it explicitly.
			var prior: Variant = _world_transform(node)
			var references := _capture_references()
			node.reparent(parent, false)
			for child in owned: child.owner = scene_root
			if op.get("keep_global_transform", true):
				if node is Node3D:
					var parent_world: Transform3D = _world_transform(parent) if parent is Node3D and not node.top_level else Transform3D.IDENTITY
					node.transform = parent_world.affine_inverse() * prior
				elif node is Node2D:
					var parent_world: Transform2D = parent.get_global_transform() if parent is CanvasItem and not node.is_set_as_top_level() else Transform2D.IDENTITY
					node.transform = parent_world.affine_inverse() * prior
			return _restore_references(references)
		_: return _error("UNKNOWN_OPERATION", kind)

func _name_available(parent: Node, name_value: String, except: Node) -> bool:
	if name_value == "" or name_value.validate_node_name() != name_value:
		return _error("INVALID_NODE_NAME", name_value)
	if parent != null:
		for child in parent.get_children(true):
			if child != except and str(child.name) == name_value: return _error("NODE_NAME_CONFLICT", name_value)
	return true

func _capture_references() -> Array:
	var references: Array = []
	for node in _all_nodes(scene_root):
		for descriptor in node.get_property_list():
			if int(descriptor.type) != TYPE_NODE_PATH or not (int(descriptor.usage) & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)): continue
			var value: NodePath = node.get(descriptor.name)
			if value.is_empty(): continue
			var target: Node = node.get_node_or_null(NodePath(value.get_concatenated_names()))
			if target != null: references.append({"writer":node,"property":descriptor.name,"anchor":node,"target":target,"original":value,"subnames":value.get_concatenated_subnames()})
		if node is AnimationPlayer:
			var anchor: Node = node.get_node_or_null(node.root_node)
			if anchor == null: continue
			for name_value in node.get_animation_list():
				var animation: Animation = node.get_animation(name_value)
				for track in animation.get_track_count():
					var value: NodePath = animation.track_get_path(track)
					var target: Node = anchor.get_node_or_null(NodePath(value.get_concatenated_names()))
					if target != null: references.append({"writer":animation,"track":track,"anchor":anchor,"target":target,"original":value,"subnames":value.get_concatenated_subnames()})
	return references

func _restore_references(references: Array) -> bool:
	for reference in references:
		if not is_instance_valid(reference.anchor) or not is_instance_valid(reference.target): continue
		var value := str(reference.anchor.get_path_to(reference.target))
		if reference.subnames != "": value += ":" + str(reference.subnames)
		var updated := NodePath(value)
		if updated == reference.original: continue
		if reference.has("track"):
			var resource: Resource = reference.writer
			if resource.resource_path != "" and not resource.resource_path.begins_with(str(request.scene_path) + "::"):
				return _error("SHARED_ANIMATION_RETARGET", "Rename/reparent requires an explicit source transaction for external animation " + resource.resource_path)
			resource.track_set_path(reference.track,updated)
		else:
			_make_editable(reference.writer)
			reference.writer.set(reference.property,updated)
	return errors.is_empty()

func _set_property(node: Node, property: String, value: Variant) -> bool:
	if property in ["name", "owner", "scene_file_path", "script"] or property.begins_with("metadata/wa_"):
		return _error("STRUCTURAL_PROPERTY", "Use a structural operation or submit a native source file for " + property)
	for descriptor in node.get_property_list():
		if str(descriptor.name) != property: continue
		if not (int(descriptor.usage) & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)): return _error("NON_EDITABLE_PROPERTY", property)
		_make_editable(node)
		var decoded: Variant = _decode(value, int(descriptor.type))
		if not errors.is_empty(): return false
		node.set(property, decoded)
		if node is Control and property in ["layout_mode", "anchors_preset"]:
			if node.get(property) != decoded: return _error("CONTROL_LAYOUT_ALIAS_REJECTED", "Godot does not accept " + property + " in this layout context")
			var aliases: Dictionary = authored_control_layout_aliases.get(node.get_instance_id(), {})
			aliases[property] = true
			authored_control_layout_aliases[node.get_instance_id()] = aliases
		return true
	return _error("UNKNOWN_PROPERTY", property)

func _decode(value: Variant, type_id: int = TYPE_NIL) -> Variant:
	if value is Dictionary and value.has("$type"):
		match str(value["$type"]):
			"Resource":
				var resource_path := str(value.get("path", ""))
				if not resource_path.begins_with("res://") or resource_path.contains(".."):
					_error("INVALID_RESOURCE_PATH", resource_path)
					return null
				return ResourceLoader.load(resource_path)
			"NodePath": return NodePath(str(value.get("value", "")))
			"StringName": return StringName(str(value.get("value", "")))
			_: value = value.get("value", value)
	var vector_lengths := {TYPE_VECTOR2:2,TYPE_VECTOR2I:2,TYPE_VECTOR3:3,TYPE_VECTOR3I:3,TYPE_VECTOR4:4,TYPE_VECTOR4I:4,TYPE_QUATERNION:4,TYPE_COLOR:4}
	if vector_lengths.has(type_id):
		if not value is Array or (value.size() != vector_lengths[type_id] and not (type_id == TYPE_COLOR and value.size() == 3)):
			_error("INVALID_PROPERTY_VALUE", "Expected numeric %s array" % type_string(type_id))
			return null
		for item in value:
			if not (item is int or item is float):
				_error("INVALID_PROPERTY_VALUE", "Vector/color entries must be numbers")
				return null
	if value is Array:
		match type_id:
			TYPE_VECTOR2: return Vector2(float(value[0]),float(value[1]))
			TYPE_VECTOR2I: return Vector2i(int(value[0]),int(value[1]))
			TYPE_VECTOR3: return Vector3(float(value[0]),float(value[1]),float(value[2]))
			TYPE_VECTOR3I: return Vector3i(int(value[0]),int(value[1]),int(value[2]))
			TYPE_VECTOR4: return Vector4(float(value[0]),float(value[1]),float(value[2]),float(value[3]))
			TYPE_VECTOR4I: return Vector4i(int(value[0]),int(value[1]),int(value[2]),int(value[3]))
			TYPE_QUATERNION: return Quaternion(float(value[0]),float(value[1]),float(value[2]),float(value[3]))
			TYPE_COLOR: return Color(float(value[0]),float(value[1]),float(value[2]),float(value[3]) if value.size() > 3 else 1.0)
	match type_id:
		TYPE_INT, TYPE_FLOAT:
			if not (value is int or value is float):
				_error("INVALID_PROPERTY_VALUE", "Expected a numeric scalar")
				return null
			return int(value) if type_id == TYPE_INT else float(value)
		TYPE_BOOL:
			if not value is bool:
				_error("INVALID_PROPERTY_VALUE", "Expected a boolean")
				return null
		TYPE_STRING:
			if not value is String:
				_error("INVALID_PROPERTY_VALUE", "Expected a string")
				return null
		TYPE_STRING_NAME: return StringName(str(value))
		TYPE_NODE_PATH: return NodePath(str(value))
	return value

func _encode(value: Variant, depth: int = 0) -> Variant:
	if depth > 8: return {"$type":type_string(typeof(value)),"truncated":true}
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING: return value
		TYPE_STRING_NAME: return {"$type":"StringName","value":str(value)}
		TYPE_NODE_PATH: return {"$type":"NodePath","value":str(value)}
		TYPE_VECTOR2, TYPE_VECTOR2I: return {"$type":type_string(typeof(value)),"value":[value.x,value.y]}
		TYPE_VECTOR3, TYPE_VECTOR3I: return {"$type":type_string(typeof(value)),"value":[value.x,value.y,value.z]}
		TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_QUATERNION: return {"$type":type_string(typeof(value)),"value":[value.x,value.y,value.z,value.w]}
		TYPE_COLOR: return {"$type":"Color","value":[value.r,value.g,value.b,value.a]}
		TYPE_TRANSFORM3D: return {"$type":"Transform3D","basis":[_encode(value.basis.x),_encode(value.basis.y),_encode(value.basis.z)],"origin":_encode(value.origin)}
		TYPE_TRANSFORM2D: return {"$type":"Transform2D","x":_encode(value.x),"y":_encode(value.y),"origin":_encode(value.origin)}
		TYPE_BASIS: return {"$type":"Basis","value":[_encode(value.x),_encode(value.y),_encode(value.z)]}
		TYPE_ARRAY,TYPE_PACKED_BYTE_ARRAY,TYPE_PACKED_INT32_ARRAY,TYPE_PACKED_INT64_ARRAY,TYPE_PACKED_FLOAT32_ARRAY,TYPE_PACKED_FLOAT64_ARRAY,TYPE_PACKED_STRING_ARRAY,TYPE_PACKED_VECTOR2_ARRAY,TYPE_PACKED_VECTOR3_ARRAY,TYPE_PACKED_COLOR_ARRAY,TYPE_PACKED_VECTOR4_ARRAY:
			var result: Array = []
			for item in value: result.append(_encode(item, depth + 1))
			return result
		TYPE_DICTIONARY:
			var result: Dictionary = {}
			for key in value: result[str(key)] = _encode(value[key], depth + 1)
			return result
		TYPE_OBJECT:
			if value is Resource:
				var encoded_resource := {"$type":"Resource","class":value.get_class(),"path":value.resource_path,"local_to_scene":value.resource_local_to_scene}
				if request.get("include_runtime_ids", false): encoded_resource["instance_id"] = value.get_instance_id()
				return encoded_resource
			if value is Node: return {"$type":"Node","path":_path(value)}
			return null
		_: return {"$type":type_string(typeof(value)),"text":str(value),"read_only":true}

func _own_properties(path: String) -> Dictionary:
	var result: Dictionary = {}
	if source_scene == null: return result
	var state := index_state if index_state != null else source_scene.get_state()
	for i in state.get_node_count():
		if str(state.get_node_path(i)).trim_prefix("./") != path.trim_prefix("./"): continue
		for j in state.get_node_property_count(i):
			result[str(state.get_node_property_name(i,j))] = state.get_node_property_value(i,j)
	return result

func _baseline(node: Node, property: String) -> Dictionary:
	var chain: Array = []
	var at := node
	while at != scene_root and at != null:
		if at.scene_file_path != "": chain.push_front(at)
		at = at.get_parent()
	if not chain.is_empty():
		var anchor: Node = chain[0]
		var path := anchor.scene_file_path
		if not defaults.has(path):
			var packed: PackedScene = ResourceLoader.load(path, "PackedScene")
			defaults[path] = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE) if packed else null
		var base_root: Node = defaults[path]
		if base_root:
			var equivalent := base_root.get_node_or_null(anchor.get_path_to(node))
			if equivalent != null:
				for descriptor in equivalent.get_property_list():
					if str(descriptor.name) == property: return {"known":true,"value":equivalent.get(property),"source":path}
	if source_scene != null and source_scene.get_state().get_base_scene_state() != null:
		var path: String = source_scene.get_state().get_base_scene_state().get_path()
		if not defaults.has(path):
			var packed: PackedScene = ResourceLoader.load(path, "PackedScene")
			defaults[path] = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE) if packed else null
		var base_root: Node = defaults[path]
		if base_root:
			var equivalent := base_root.get_node_or_null(NodePath(_path(node)))
			if equivalent != null:
				for descriptor in equivalent.get_property_list():
					if str(descriptor.name) == property: return {"known":true,"value":equivalent.get(property),"source":path}
	var script: Script = node.get_script()
	if script != null:
		for descriptor in script.get_script_property_list():
			if str(descriptor.name) == property: return {"known":true,"value":script.get_property_default_value(property),"source":script.resource_path}
	for descriptor in ClassDB.class_get_property_list(node.get_class()):
		if str(descriptor.name) == property:
			return {"known":true,"value":ClassDB.class_get_property_default_value(node.get_class(),property),"source":node.get_class()}
	if node.property_can_revert(property):
		return {"known":true,"value":node.property_get_revert(property),"source":"custom_revert"}
	return {"known":false,"value":null,"source":""}

func _place_instance(node: Node, placement: Variant) -> bool:
	if not placement is Dictionary or placement.get("dimension") not in ["3d", "2d"]:
		return _error("INVALID_PLACEMENT", "Placement requires a 3d or 2d dimension")
	var values: Variant = placement.get("position")
	if not values is Array or values.size() != (3 if placement.dimension == "3d" else 2):
		return _error("INVALID_PLACEMENT", "Placement requires a complete position matching its dimension")
	for value in values:
		if not (value is int or value is float) or not is_finite(float(value)):
			return _error("INVALID_PLACEMENT", "Placement position must contain finite numbers")
	if node is Node3D:
		if placement.dimension != "3d": return _error("PLACEMENT_DIMENSION_MISMATCH", "Node3D requires a 3d placement")
		var parent := node.get_parent()
		var parent_world: Transform3D = _world_transform(parent) if parent is Node3D and not node.top_level else Transform3D.IDENTITY
		if not parent_world.is_finite() or abs(parent_world.basis.determinant()) < 0.00000001:
			return _error("INVALID_PLACEMENT", "Placement parent transform is singular or non-finite")
		var position := parent_world.affine_inverse() * Vector3(values[0], values[1], values[2])
		if not position.is_finite(): return _error("INVALID_PLACEMENT", "Placement position exceeds native precision")
		# Only move the origin; never decompose/rebuild the inherited basis.
		node.position = position
	elif node is CanvasItem:
		if placement.dimension != "2d": return _error("PLACEMENT_DIMENSION_MISMATCH", "CanvasItem requires a 2d placement")
		if not (node is Node2D or node is Control): return _error("INVALID_PLACEMENT", "CanvasItem root has no editable position")
		if node is Control and node.get_parent() is Container:
			return _error("CONTAINER_MANAGED_LAYOUT", "Parent Container owns this child's placement")
		# Measure against the same script-free native layout used by Control
		# edits. This includes anchors, non-unit roots and Control/Node2D parents.
		await _prepare_layout()
		if not errors.is_empty(): return false
		var display: CanvasItem = layout_root.get_node_or_null(NodePath(_path(node))) if layout_root else node
		if display == null: return _error("CONTROL_LAYOUT_UNAVAILABLE", _path(node))
		var parent := display.get_parent()
		var parent_world: Transform2D = _world_transform(parent) if parent is CanvasItem and not display.is_set_as_top_level() else Transform2D.IDENTITY
		if not parent_world.is_finite() or abs(parent_world.determinant()) < 0.00000001:
			return _error("INVALID_PLACEMENT", "Placement parent transform is singular or non-finite")
		var position := parent_world.affine_inverse() * Vector2(values[0], values[1])
		if not position.is_finite(): return _error("INVALID_PLACEMENT", "Placement position exceeds native precision")
		if node is Control:
			# A rotated/scaled Control's pivot shifts its transform origin away
			# from rect.position. Move by that delta, preserving anchors and size.
			display.set_position(display.position + position - display.get_transform().origin, false)
			for property in CONTROL_FIELDS.offsets: node.set(property, display.get(property))
		else:
			node.position = position
	# Non-spatial Node systems retain ordinary instantiation behavior.
	return errors.is_empty()

func _world_transform(node: Node) -> Variant:
	if node is Node3D:
		var result: Transform3D = node.transform
		var parent := node.get_parent()
		if parent is Node3D and not node.top_level:
			result = _world_transform(parent) * result
		if node.is_scale_disabled(): result.basis = result.basis.orthonormalized()
		return result
	# CanvasItem's getter works outside SceneTree and handles Control parents,
	# top_level and non-CanvasItem boundaries using Godot's native implementation.
	if node is CanvasItem: return node.get_global_transform()
	return Transform3D.IDENTITY

func _depends_on(path: String, target: String, seen: Dictionary = {}) -> bool:
	if seen.has(path): return false
	seen[path] = true
	for dep in ResourceLoader.get_dependencies(path):
		var actual := str(dep).split("::")[-1]
		if actual == target or _depends_on(actual,target,seen): return true
	return false

func _dependencies(path: String, result: Array = [], seen: Dictionary = {}) -> Array:
	if seen.has(path): return result
	seen[path] = true
	for dep in ResourceLoader.get_dependencies(path):
		var actual := str(dep).split("::")[-1]
		if actual not in result: result.append(actual)
		_dependencies(actual,result,seen)
	return result

func _capture_control_layout_aliases() -> void:
	authored_control_layout_aliases.clear()
	if source_scene == null: return
	# Capture by live identity before edits so a rename/reparent does not lose
	# an intentionally authored mode. Do not use the derived index state here.
	var state := source_scene.get_state()
	for i in state.get_node_count():
		var node := scene_root.get_node_or_null(state.get_node_path(i))
		if not node is Control: continue
		for j in state.get_node_property_count(i):
			var property := str(state.get_node_property_name(i,j))
			if property in ["layout_mode", "anchors_preset"]:
				var aliases: Dictionary = authored_control_layout_aliases.get(node.get_instance_id(), {})
				aliases[property] = true
				authored_control_layout_aliases[node.get_instance_id()] = aliases

func _pack_source(packed: PackedScene) -> Error:
	var result := packed.pack(scene_root)
	if result != OK: return result
	# Godot 4.6's Control getter computes layout_mode=0 under a Control parent,
	# even when the referenced scene root stores 3. Packing that computed alias
	# creates a new override whose setter resets inherited offsets on reload.
	# The computed anchors_preset alias likewise resets offsets/grow when loaded.
	# Remove only these two un-authored Control editor aliases from Godot's
	# native bundle. Keep every other word, variant/resource, ID and connection.
	var state := packed.get_state()
	var omit: Dictionary = {}
	for i in state.get_node_count():
		var node := scene_root.get_node_or_null(state.get_node_path(i))
		if node is Control:
			var aliases: Dictionary = authored_control_layout_aliases.get(node.get_instance_id(), {})
			omit[i] = {"layout_mode": not aliases.has("layout_mode"), "anchors_preset": not aliases.has("anchors_preset")}
	if omit.is_empty(): return OK
	var bundle: Dictionary = packed.get("_bundled")
	if int(bundle.get("version",0)) != 3: return ERR_UNAVAILABLE
	var names: PackedStringArray = bundle.names
	var words: PackedInt32Array = bundle.nodes
	var filtered := PackedInt32Array()
	var cursor := 0
	var removed := false
	for i in state.get_node_count():
		filtered.append_array(words.slice(cursor,cursor+5))
		cursor += 5
		var property_count := words[cursor]
		cursor += 1
		var properties := PackedInt32Array()
		for j in property_count:
			var name_index := words[cursor]
			if omit.has(i) and name_index >= 0 and name_index < names.size() and bool(omit[i].get(names[name_index], false)): removed = true
			else: properties.append_array(words.slice(cursor,cursor+2))
			cursor += 2
		filtered.append(properties.size()/2)
		filtered.append_array(properties)
		var group_count := words[cursor]
		filtered.append_array(words.slice(cursor,cursor+group_count+1))
		cursor += group_count+1
	if cursor != words.size(): return ERR_INVALID_DATA
	if removed:
		bundle.nodes = filtered
		packed.set("_bundled",bundle)
	return OK

func _index() -> Dictionary:
	# Repacking in memory asks Godot to normalize paths recovered through its own
	# persisted unique_id mechanism. This is read-only and never saves source.
	var normalized := PackedScene.new()
	if _pack_source(normalized) != OK:
		_error("SCENE_INDEX_FAILED", "Godot could not derive the stored scene state")
		return {}
	index_state = normalized.get_state()
	var nodes: Array = []
	for node in _all_nodes(scene_root):
		var own := _own_properties(_path(node))
		var display: Node = layout_root.get_node_or_null(NodePath(_path(node))) if layout_root != null else node
		if display == null: display = node
		var properties: Array = []
		# PlaceholderScriptInstance omits SCRIPT_VARIABLE in the Node list.
		# Read the Script resource without executing non-tool creator code.
		var exported_properties: Dictionary = {}
		var native_script: Script = node.get_script()
		while native_script != null:
			for script_property in native_script.get_script_property_list():
				if int(script_property.usage) & PROPERTY_USAGE_EDITOR and int(script_property.usage) & PROPERTY_USAGE_STORAGE:
					exported_properties[str(script_property.name)] = true
			native_script = native_script.get_base_script()
		for descriptor in node.get_property_list():
			if not (int(descriptor.usage) & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)): continue
			var prop := str(descriptor.name)
			var base := _baseline(node,prop)
			var instance_property: bool = not _instance_ids(node).is_empty() or (source_scene != null and source_scene.get_state().get_base_scene_state() != null)
			var storage_property := prop
			if node is Node3D and prop in ["position","rotation","rotation_degrees","quaternion","basis","scale"]: storage_property = "transform"
			elif (node is Node2D or node is Control) and prop == "rotation_degrees": storage_property = "rotation"
			properties.append({"name":prop,"type":int(descriptor.type),"type_name":type_string(int(descriptor.type)),"hint":int(descriptor.hint),"hint_string":str(descriptor.hint_string),"usage":int(descriptor.usage),"exported":exported_properties.has(prop),"value":_encode(display.get(prop) if node is Control and prop in ["position", "size"] else node.get(prop)),"inherited_value":_encode(base.value),"default_known":base.known,"default_source":base.source,"storage_property":storage_property,"overridden":own.has(storage_property) and instance_property,"stored_locally":own.has(storage_property)})
		if node is Control:
			for entry in properties:
				if entry.name not in ["position","size"]: continue
				entry["storage_property"] = null
				entry["storage_properties"] = CONTROL_FIELDS[entry.name]
				entry["stored_locally"] = own.has("offset_left") or own.has("offset_top") or own.has("offset_right") or own.has("offset_bottom")
				entry["overridden"] = entry.stored_locally and (not _instance_ids(node).is_empty() or (source_scene != null and source_scene.get_state().get_base_scene_state() != null))
				# A rect alias has no independent stored default. Reset its offset
				# group; deriving an inherited rect requires its own parent layout.
				entry["default_known"] = false
				entry["inherited_value"] = null
		var metadata: Dictionary = {}
		for key in node.get_meta_list(): metadata[str(key)] = _encode(node.get_meta(key))
		var row := {"path":_path(node),"node_id":str(node.get_meta("wa_node_id","")),"instance_ids":_instance_ids(node),"name":str(node.name),"type":node.get_class(),"owner_path":_path(node.owner) if node.owner != null else "","scene_file_path":node.scene_file_path,"metadata":metadata,"properties":properties,"local_transform":_encode(display.get_transform()) if node is Control else _encode(node.transform) if node is Node3D or node is Node2D else null,"world_transform":_encode(_world_transform(display)) if node is Node3D or node is CanvasItem else null}
		if node is Node3D: row["transform"] = {"position":[node.position.x,node.position.y,node.position.z],"rotation":[node.rotation_degrees.x,node.rotation_degrees.y,node.rotation_degrees.z],"scale":[node.scale.x,node.scale.y,node.scale.z]}
		elif node is Node2D: row["transform"] = {"position":[node.position.x,node.position.y,0],"rotation":[0,0,node.rotation_degrees],"scale":[node.scale.x,node.scale.y,1]}
		if node is Control:
			row["control_layout"] = _control_layout(node, display, own)
			row["transform"] = {"position":[display.position.x,display.position.y,0],"rotation":[0,0,display.rotation_degrees],"scale":[display.scale.x,display.scale.y,1]}
		nodes.append(row)
	var connections: Array = []
	if source_scene != null:
		var state := source_scene.get_state()
		for i in state.get_connection_count(): connections.append({"source":str(state.get_connection_source(i)),"target":str(state.get_connection_target(i)),"signal":str(state.get_connection_signal(i)),"method":str(state.get_connection_method(i)),"flags":state.get_connection_flags(i),"binds":_encode(state.get_connection_binds(i)),"unbinds":state.get_connection_unbinds(i)})
	return {"nodes":nodes,"dependencies":_dependencies(str(request.scene_path)),"connections":connections}

# Control setters depend on an actual parent rect. Only a detached, script-free
# copy enters this temporary viewport; the editable PackedScene graph is saved.
const CONTROL_FIELDS = {
	"anchors":["anchor_left","anchor_top","anchor_right","anchor_bottom"],
	"offsets":["offset_left","offset_top","offset_right","offset_bottom"],
	"position":["offset_left","offset_top","offset_right","offset_bottom"],
	"size":["offset_left","offset_top","offset_right","offset_bottom"],
	"pivot_offset":["pivot_offset"],"rotation_degrees":["rotation"],"scale":["scale"],
	"custom_minimum_size":["custom_minimum_size"],"grow_horizontal":["grow_horizontal"],"grow_vertical":["grow_vertical"],
	"size_flags_horizontal":["size_flags_horizontal"],"size_flags_vertical":["size_flags_vertical"],"size_flags_stretch_ratio":["size_flags_stretch_ratio"]}
const CONTAINER_FIELDS = ["custom_minimum_size","size_flags_horizontal","size_flags_vertical","size_flags_stretch_ratio"]
const CONTROL_PRESETS = {"top_left":0,"top_right":1,"bottom_left":2,"bottom_right":3,"center_left":4,"center_top":5,"center_right":6,"center_bottom":7,"center":8,"left_wide":9,"top_wide":10,"right_wide":11,"bottom_wide":12,"vcenter_wide":13,"hcenter_wide":14,"full_rect":15}

func _clear_layout() -> void:
	if is_instance_valid(layout_viewport): layout_viewport.free()
	layout_viewport = null
	layout_root = null
	layout_resources.clear()

func _layout_value(value: Variant) -> Variant:
	if value is Script or value is PackedScene: return null
	if value is Resource:
		var id: int = value.get_instance_id()
		if layout_resources.has(id): return layout_resources[id]
		var copy: Resource = value.duplicate(false)
		layout_resources[id] = copy
		copy.set_script(null)
		for prop in copy.get_property_list():
			if int(prop.usage) & PROPERTY_USAGE_STORAGE and str(prop.name) != "script":
				var nested: Variant = copy.get(prop.name)
				if nested is Resource or nested is Array or nested is Dictionary: copy.set(prop.name, _layout_value(nested))
		return copy
	if value is Array:
		var copy: Variant = value.duplicate()
		for i in copy.size(): copy[i] = _layout_value(copy[i])
		return copy
	if value is Dictionary:
		var copy: Variant = value.duplicate()
		for key in copy: copy[key] = _layout_value(copy[key])
		return copy
	return value

func _sanitize_layout(node: Node) -> void:
	node.set_script(null)
	node.process_mode = Node.PROCESS_MODE_DISABLED
	if node is Camera3D: node.current = false
	if node is Camera2D: node.enabled = false
	if node is AnimationPlayer: node.autoplay = ""
	if node is AnimationTree: node.active = false
	if node is AnimatedSprite2D or node is AnimatedSprite3D: node.pause()
	if node is Timer: node.autostart = false
	if node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D: node.autoplay = false
	if node is VideoStreamPlayer: node.autoplay = false
	if node is RigidBody2D or node is RigidBody3D: node.freeze = true
	if node is Area2D or node is Area3D:
		node.monitoring = false
		node.monitorable = false
	if node is GPUParticles2D or node is CPUParticles2D or node is GPUParticles3D or node is CPUParticles3D: node.speed_scale = 0
	for prop in node.get_property_list():
		if int(prop.usage) & PROPERTY_USAGE_STORAGE and str(prop.name) != "script":
			var value: Variant = node.get(prop.name)
			if value is Resource or value is Array or value is Dictionary: node.set(prop.name,_layout_value(value))
	for child in node.get_children(true): _sanitize_layout(child)

func _prepare_layout(viewport_size: Array = []) -> void:
	_clear_layout()
	var has_control := false
	for node in _all_nodes(scene_root):
		if node is Control: has_control = true
	if not has_control: return
	var size := Vector2i(int(ProjectSettings.get_setting("display/window/size/viewport_width",1152)),int(ProjectSettings.get_setting("display/window/size/viewport_height",648)))
	if not viewport_size.is_empty():
		if not _control_vector(viewport_size,2) or viewport_size[0] < 1 or viewport_size[1] < 1 or viewport_size[0] > 16384 or viewport_size[1] > 16384:
			_error("INVALID_CONTROL_LAYOUT", "Invalid reference viewport size")
			return
		size = Vector2i(viewport_size[0],viewport_size[1])
	layout_root = scene_root.duplicate(0)
	_sanitize_layout(layout_root)
	layout_viewport = SubViewport.new()
	layout_viewport.size = size.max(Vector2i.ONE)
	layout_viewport.disable_3d = true
	layout_viewport.render_target_update_mode = SubViewport.UPDATE_DISABLED
	root.add_child(layout_viewport)
	layout_viewport.add_child(layout_root)
	await process_frame
	await process_frame

func _control_vector(value: Variant, length: int) -> bool:
	if not value is Array or value.size() != length: return false
	for number in value:
		if not (number is int or number is float) or not is_finite(float(number)) or abs(float(number)) > 1000000: return false
	return true

func _control_values(node: Control) -> Dictionary:
	return {"anchors":[node.anchor_left,node.anchor_top,node.anchor_right,node.anchor_bottom],"offsets":[node.offset_left,node.offset_top,node.offset_right,node.offset_bottom],"position":[node.position.x,node.position.y],"size":[node.size.x,node.size.y],"pivot_offset":[node.pivot_offset.x,node.pivot_offset.y],"rotation_degrees":node.rotation_degrees,"scale":[node.scale.x,node.scale.y],"custom_minimum_size":[node.custom_minimum_size.x,node.custom_minimum_size.y],"grow_horizontal":node.grow_horizontal,"grow_vertical":node.grow_vertical,"size_flags_horizontal":node.size_flags_horizontal,"size_flags_vertical":node.size_flags_vertical,"size_flags_stretch_ratio":node.size_flags_stretch_ratio}

func _control_layout(node: Control, display: Control, own: Dictionary) -> Dictionary:
	var managed := node.get_parent() is Container
	var fields: Dictionary = {}
	var inherited := not _instance_ids(node).is_empty() or (source_scene != null and source_scene.get_state().get_base_scene_state() != null)
	for key in CONTROL_FIELDS:
		var stored := false
		var known := true
		for prop in CONTROL_FIELDS[key]:
			stored = stored or own.has(prop)
			known = known and _baseline(node,prop).known
		fields[key] = {"editable":not managed or key in CONTAINER_FIELDS,"stored_locally":stored,"overridden":stored and inherited,"resettable":known,"storage_properties":CONTROL_FIELDS[key]}
	var values := _control_values(node)
	values.position = [display.position.x,display.position.y]
	values.size = [display.size.x,display.size.y]
	return {"values":values,"fields":fields,"container_managed":managed,"parent_type":node.get_parent().get_class() if node.get_parent() else "Viewport","parent_path":_path(node.get_parent()) if node.get_parent() else "","parent_size":[display.get_parent_area_size().x,display.get_parent_area_size().y],"minimum_size":[display.get_combined_minimum_size().x,display.get_combined_minimum_size().y],"viewport_size":[layout_viewport.size.x,layout_viewport.size.y]}

func _apply_control_layout(node: Node, op: Dictionary) -> bool:
	if not node is Control: return _error("NOT_CONTROL", "Layout editing requires a Control")
	var display: Control = layout_root.get_node_or_null(NodePath(_path(node))) if layout_root else null
	if display == null: return _error("CONTROL_LAYOUT_UNAVAILABLE", _path(node))
	var value: Variant = op.get("value",{})
	var reset: Variant = op.get("reset",[])
	if not value is Dictionary or not reset is Array or value.is_empty() and reset.is_empty() and not op.has("preset"): return _error("INVALID_CONTROL_LAYOUT", "Provide layout values, reset fields or a preset")
	if not reset.is_empty() and (not value.is_empty() or op.has("preset")): return _error("INVALID_CONTROL_LAYOUT", "Reset is an independent atomic operation")
	var managed := node.get_parent() is Container
	for key in value.keys() + reset:
		if not CONTROL_FIELDS.has(key): return _error("INVALID_CONTROL_LAYOUT", "Unknown layout field: " + str(key))
		if managed and key not in CONTAINER_FIELDS: return _error("CONTAINER_MANAGED_LAYOUT", "Parent Container owns this child's geometry")
	if managed and op.has("preset"): return _error("CONTAINER_MANAGED_LAYOUT", "Parent Container owns anchors and offsets")
	if value.has("offsets") and (value.has("position") or value.has("size")): return _error("INVALID_CONTROL_LAYOUT", "Offsets and rect aliases cannot be assigned together")
	for key in value:
		var v: Variant = value[key]
		if key in ["anchors","offsets","position","size","pivot_offset","scale","custom_minimum_size"]:
			if not _control_vector(v,4 if key in ["anchors","offsets"] else 2): return _error("INVALID_CONTROL_LAYOUT", "Invalid layout vector: " + key)
			if key in ["size","custom_minimum_size"] and (v[0] < 0 or v[1] < 0): return _error("INVALID_CONTROL_LAYOUT", "Size cannot be negative")
			if key == "scale" and (abs(v[0]) < 0.00000001 or abs(v[1]) < 0.00000001): return _error("INVALID_CONTROL_LAYOUT", "Scale cannot be zero")
		elif not (v is int or v is float) or not is_finite(float(v)): return _error("INVALID_CONTROL_LAYOUT", "Invalid layout number")
		elif key == "rotation_degrees" and abs(v) > 36000: return _error("INVALID_CONTROL_LAYOUT", "Rotation exceeds supported range")
		elif key.begins_with("grow_") and (v != int(v) or v < 0 or v > 2): return _error("INVALID_CONTROL_LAYOUT", "Invalid grow direction")
		elif key.begins_with("size_flags_") and key != "size_flags_stretch_ratio" and (v != int(v) or v < 0 or v > 15): return _error("INVALID_CONTROL_LAYOUT", "Invalid size flags")
		elif key == "size_flags_stretch_ratio" and (v <= 0 or v > 1000000): return _error("INVALID_CONTROL_LAYOUT", "Stretch ratio must be positive")
	if op.has("preset") and not CONTROL_PRESETS.has(op.preset): return _error("INVALID_CONTROL_LAYOUT", "Unknown anchor preset")
	_make_editable(node)
	if not reset.is_empty():
		for key in reset:
			for prop in CONTROL_FIELDS[key]:
				var baseline := _baseline(node,prop)
				if not baseline.known: return _error("NO_PROPERTY_DEFAULT",prop)
				node.set(prop,baseline.value)
				var pins: Array = node.get_meta("_edit_pinned_properties_",[])
				pins.erase(prop)
				if pins.is_empty(): node.remove_meta("_edit_pinned_properties_")
				else: node.set_meta("_edit_pinned_properties_",pins)
		return true
	var before: Dictionary = {}
	for key in CONTROL_FIELDS:
		for prop in CONTROL_FIELDS[key]: before[prop] = display.get(prop)
	if op.has("preset"): display.set_anchors_and_offsets_preset(CONTROL_PRESETS[op.preset],Control.PRESET_MODE_KEEP_SIZE)
	# Apply anchors first; rect aliases are evaluated against the actual parent.
	for key in CONTROL_FIELDS:
		if not value.has(key): continue
		if key in ["anchors","offsets"]:
			for i in 4:
				if key == "anchors": display.set_anchor(i,float(value[key][i]),false,true)
				else: display.set_offset(i,float(value[key][i]))
		elif value[key] is Array: display.set(key,Vector2(value[key][0],value[key][1]))
		else: display.set(key,value[key])
	var assigned: Array = []
	for key in value:
		for prop in CONTROL_FIELDS[key]:
			if prop not in assigned: assigned.append(prop)
	if op.has("preset"):
		for key in ["anchors","offsets","grow_horizontal","grow_vertical"]:
			for prop in CONTROL_FIELDS[key]:
				if prop not in assigned: assigned.append(prop)
	var inherited := not _instance_ids(node).is_empty() or (source_scene != null and source_scene.get_state().get_base_scene_state() != null)
	var pins: Array = node.get_meta("_edit_pinned_properties_",[])
	for prop in before:
		if prop in assigned or display.get(prop) != before[prop]:
			node.set(prop,display.get(prop))
			if inherited and prop not in pins: pins.append(prop)
	if not pins.is_empty(): node.set_meta("_edit_pinned_properties_",pins)
	return true
