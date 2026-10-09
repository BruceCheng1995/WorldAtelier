extends RefCounted

const Hierarchy = preload("res://hierarchy_scene.gd")
const Behaviors = preload("res://behavior_registry.gd")
const MAX_OBJECTS = 400
const MAX_ASSET_BYTES = 24 * 1024 * 1024

static func vector_array(value: Variant, low: float = -100000, high: float = 100000) -> bool:
	if not value is Array or value.size() != 3:
		return false
	for n in value:
		if not (n is int or n is float) or not is_finite(float(n)) or n < low or n > high:
			return false
	return true

static func vec(value: Array) -> Vector3:
	return Vector3(float(value[0]), float(value[1]), float(value[2]))

static func array3(value: Vector3) -> Array:
	return [value.x, value.y, value.z]

static func scale3(value: Variant) -> Vector3:
	return vec(value) if value is Array else Vector3.ONE * float(value)

static func validate(message: Dictionary, origin: String) -> String:
	if Hierarchy.enabled(message):
		var problem = Hierarchy.validate(message,origin)
		if not problem.is_empty(): return problem
		if not message.get("document_id") is String or message.document_id.is_empty(): return "document_id is required"
		if message.has("editable") and not message.editable is bool: return "editable must be boolean"
		for row in Hierarchy.effective_document(message).objects:
			if row.has("solid") and not row.solid is bool: return "solid must be boolean"
			problem = validate_components(row.get("components",{}),origin)
			if not problem.is_empty(): return problem + " for " + row.id
		return ""
	if message.has("editable") and not message.editable is bool:
		return "editable must be boolean"
	if not message.get("document_id") is String or message.document_id.is_empty():
		return "document_id is required"
	if not message.get("objects") is Array or message.objects.size() > MAX_OBJECTS:
		return "objects must be an array of at most 400 entries"
	var ids = {}
	for object in message.objects:
		if not object is Dictionary or not object.get("id") is String or object.id.is_empty() or object.id.length() > 160 or ids.has(object.id):
			return "objects require unique nonempty IDs"
		ids[object.id] = true
		if object.get("parent_id") != null: return "parented objects are not yet supported; refusing to flatten " + object.id
		if object.has("solid") and not object.solid is bool: return "solid must be boolean"
		var component_error = validate_components(object.get("components",{}),origin)
		if not component_error.is_empty(): return component_error + " for " + object.id
		if not object.get("developments",[]) is Array or object.get("developments",[]).size()>32: return "invalid developments"
		for development in object.get("developments",[]):
			if not development is Dictionary or development.get("status") not in ["editing","testing","delivered","failed"] or not development.get("id") is String: return "invalid development state"
		if not vector_array(object.get("position"), -1000, 1000) or not vector_array(object.get("rotation", [0,0,0]), -36000, 36000):
			return "invalid position/rotation for " + object.id
		var size = object.get("scale", 1)
		if size is Array:
			if not vector_array(size, .1, 5): return "invalid scale for " + object.id
		elif not (size is float or size is int) or not is_finite(float(size)) or size < .1 or size > 5:
			return "invalid scale for " + object.id
		if object.get("kind") != "anchor":
			if not valid_model_url(object.get("model_url"), origin):
				return "model_url must be a same-origin /preview-assets/*.glb for " + object.id
			var hash = object.get("model_hash", "")
			if not hash is String or (not hash.is_empty() and not RegEx.create_from_string("^[a-f0-9]{64}$").search(hash)):
				return "invalid model_hash for " + object.id
	return ""

static func valid_model_url(value: Variant, origin: String) -> bool:
	if not value is String: return false
	var path = value.trim_prefix(origin) if not origin.is_empty() else value
	return RegEx.create_from_string("^/preview-assets/[A-Za-z0-9_-]+\\.glb(?:\\?[A-Za-z0-9_.=&%-]*)?$").search(path) != null

static func parse_glb(bytes: PackedByteArray, expected_hash: String = "") -> Dictionary:
	if bytes.size() > MAX_ASSET_BYTES or bytes.size() < 24 or bytes.decode_u32(0) != 0x46546c67 or bytes.decode_u32(4) != 2 or bytes.decode_u32(8) != bytes.size():
		return {"ok": false, "error": "invalid GLB header or size"}
	var hashing = HashingContext.new()
	hashing.start(HashingContext.HASH_SHA256)
	hashing.update(bytes)
	var actual_hash = hashing.finish().hex_encode()
	if not expected_hash.is_empty() and actual_hash != expected_hash:
		return {"ok": false, "error": "GLB SHA-256 mismatch"}
	var json_size = bytes.decode_u32(12)
	if bytes.decode_u32(16) != 0x4e4f534a or json_size > bytes.size() - 20:
		return {"ok": false, "error": "invalid GLB JSON chunk"}
	var data = JSON.parse_string(bytes.slice(20, 20 + json_size).get_string_from_utf8())
	if not data is Dictionary: return {"ok": false, "error": "invalid GLB JSON"}
	for key in ["buffers", "images", "nodes", "meshes"]:
		if data.has(key) and not data[key] is Array:
			return {"ok": false, "error": "invalid GLB array: " + key}
	for key in ["buffers", "images"]:
		for item in data.get(key, []):
			if not item is Dictionary:
				return {"ok": false, "error": "invalid GLB dependency"}
			if item.has("uri") and (not item.uri is String or not item.uri.begins_with("data:")):
				return {"ok": false, "error": "external GLB dependencies are not supported"}
	if data.get("nodes", []).size() > 4000 or data.get("meshes", []).size() > 1000:
		return {"ok": false, "error": "GLB scene capacity exceeded"}
	var gltf = GLTFState.new()
	var document = GLTFDocument.new()
	var code = document.append_from_buffer(bytes, "", gltf)
	if code != OK: return {"ok": false, "error": "GLB parser rejected: " + error_string(code)}
	var scene = document.generate_scene(gltf)
	if scene == null: return {"ok": false, "error": "GLB scene generation failed"}
	var stats = measure(scene)
	if stats.mesh_count == 0:
		scene.free()
		return {"ok": false, "error": "GLB has no renderable meshes"}
	var packed = PackedScene.new()
	code = packed.pack(scene)
	scene.free()
	if code != OK: return {"ok": false, "error": "GLB packing failed"}
	return {"ok": true, "scene": packed, "hash": actual_hash, "bytes": bytes.size(), "mesh_count": stats.mesh_count, "bounds": stats.bounds}

static func measure(node: Node, parent_transform: Transform3D = Transform3D.IDENTITY) -> Dictionary:
	var transform = parent_transform * node.transform if node is Node3D else parent_transform
	var bounds = AABB()
	var count = 0
	if node is MeshInstance3D and node.mesh != null:
		bounds = transform * node.get_aabb()
		count = 1
	for child in node.get_children():
		var child_stats = measure(child, transform)
		if child_stats.mesh_count:
			bounds = bounds.merge(child_stats.bounds) if count else child_stats.bounds
			count += child_stats.mesh_count
	return {"mesh_count": count, "bounds": bounds}

static func bounds_json(bounds: AABB) -> Dictionary:
	return {"min": array3(bounds.position), "max": array3(bounds.end), "size": array3(bounds.size), "center": array3(bounds.get_center())}

static func validate_components(components: Variant, origin: String) -> String:
	if not components is Dictionary: return "components must be an object"
	for key in components:
		if key not in ["collider","interactable","trigger","behaviors"]: return "unknown component " + str(key)
	for key in ["collider","interactable","trigger"]:
		if components.has(key) and not components[key] is Dictionary: return "invalid " + key
	if components.has("collider"):
		var collider = components.collider
		if collider.get("shape","trimesh") not in ["trimesh","box"]: return "unsupported collider shape"
		if collider.has("size") and not vector_array(collider.size,.01,1000): return "invalid collider size"
		if collider.has("offset") and not vector_array(collider.offset,-1000,1000): return "invalid collider offset"
	if components.has("interactable"):
		var item = components.interactable
		if item.get("shape","sphere") not in ["sphere","box"]: return "unsupported interaction shape"
		if item.has("size") and not vector_array(item.size,.01,1000): return "invalid interaction size"
		if item.has("offset") and not vector_array(item.offset,-1000,1000): return "invalid interaction offset"
		if not (item.get("radius",2) is int or item.get("radius",2) is float) or not is_finite(float(item.get("radius",2))) or item.get("radius",2)<.1 or item.get("radius",2)>20: return "invalid interaction radius"
		if item.has("label") and (not item.label is String or item.label.length()>120): return "invalid interaction label"
	if components.has("trigger"):
		var item = components.trigger
		if item.get("shape","sphere") not in ["sphere","box"]: return "unsupported trigger shape"
		if not (item.get("radius",1) is int or item.get("radius",1) is float) or not is_finite(float(item.get("radius",1))) or item.get("radius",1)<.1 or item.get("radius",1)>100: return "invalid trigger radius"
		if item.has("size") and not vector_array(item.size,.1,1000): return "invalid trigger size"
		if item.has("offset") and not vector_array(item.offset,-1000,1000): return "invalid trigger offset"
	var ids = {}
	if not components.get("behaviors",[]) is Array or components.get("behaviors",[]).size()>16: return "invalid behavior list"
	for item in components.get("behaviors",[]):
		if not item is Dictionary or not item.get("id") is String or item.id.is_empty() or ids.has(item.id) or item.get("api") != 1: return "invalid behavior identity/API"
		ids[item.id] = true
		if not item.get("script_hash") is String or not RegEx.create_from_string("^[a-f0-9]{64}$").search(item.script_hash): return "behavior SHA-256 required"
		if not item.get("script_url") is String: return "behavior URL required"
		var path = item.script_url.trim_prefix(origin) if not origin.is_empty() else item.script_url
		if not RegEx.create_from_string("^/preview-assets/"+item.script_hash+"\\.gd(?:\\?[A-Za-z0-9_.=&%-]*)?$").search(path): return "behavior URL must use immutable hash filename"
		if not item.get("properties",{}) is Dictionary or not Behaviors.json_value(item.get("properties",{})) or JSON.stringify(item.get("properties",{})).length()>32768: return "invalid behavior properties"
	return ""
