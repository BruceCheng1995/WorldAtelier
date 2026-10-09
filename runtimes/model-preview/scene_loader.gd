extends RefCounted
const Hierarchy = preload("res://hierarchy_scene.gd")
const Factory = preload("res://scene_factory.gd")
const Behaviors = preload("res://behavior_registry.gd")
var asset_cache: Dictionary = {}
var source_cache: Dictionary = {}

func fetch(parent: Node, origin: String, path: String, maximum: int) -> Dictionary:
	var request = HTTPRequest.new()
	request.timeout = 20
	request.max_redirects = 0
	request.body_size_limit = maximum
	parent.add_child(request)
	var url = origin+path if path.begins_with("/") else path
	var error = request.request(url)
	if error != OK:
		request.queue_free()
		return {"ok":false,"error":"resource request failed: "+error_string(error)}
	var result = await request.request_completed
	request.queue_free()
	if result[0] != HTTPRequest.RESULT_SUCCESS or result[1] != 200:
		return {"ok":false,"error":"resource HTTP failed result=%s status=%s"%[result[0],result[1]]}
	return {"ok":true,"bytes":result[3]}

func sources(parent: Node, document: Dictionary, origin: String) -> Dictionary:
	var result = {}
	for object in document.objects:
		for component in object.get("components",{}).get("behaviors",[]):
			var hash: String = component.script_hash
			if not source_cache.has(hash):
				var response = await fetch(parent,origin,component.script_url,Behaviors.MAX_SCRIPT_BYTES)
				if not response.ok: return response
				var bytes: PackedByteArray = response.bytes
				var source = bytes.get_string_from_utf8()
				if source.sha256_text()!=hash: return {"ok":false,"error":"behavior SHA-256/UTF-8 validation failed"}
				source_cache[hash] = source
				while source_cache.size()>64: source_cache.erase(source_cache.keys()[0])
			result[hash] = source_cache[hash]
	return {"ok":true,"sources":result}

func prepare(parent: Node, document: Dictionary, origin: String) -> Dictionary:
	# Native scene indexes are observations, never inputs to this legacy JSON
	# authority/presentation assembler. Reject even empty or anchor-only indexes.
	if document.get("document_schema")=="creation-native-1":
		return {"ok":false,"code":"native_shared_runtime_unavailable","error":"native_shared_runtime_unavailable: Native PackedScene shared authority is not implemented"}
	var error = Factory.validate(document,origin)
	if not error.is_empty(): return {"ok":false,"error":error}
	var hierarchy = Hierarchy.enabled(document)
	var effective = Hierarchy.effective_document(document) if hierarchy else document.duplicate(true)
	var loaded_sources = await sources(parent,effective,origin)
	if not loaded_sources.ok: return loaded_sources
	var graph = Hierarchy.assemble(document) if hierarchy else {}
	var root: Node3D = graph.root if hierarchy else Node3D.new()
	root.name = "WorldContent"
	var objects: Dictionary = graph.objects if hierarchy else {}
	var assets = []
	for object in effective.objects:
		var node: Node3D = objects[object.id] if hierarchy else Node3D.new()
		if not hierarchy:
			node.name = "Object_"+str(objects.size())
			node.position = Factory.vec(object.position)
			node.rotation_degrees = Factory.vec(object.get("rotation",[0,0,0]))
			node.scale = Factory.scale3(object.get("scale",1))
			root.add_child(node)
		node.set_meta("object_id",object.id)
		objects[object.id] = node
		if object.get("kind")=="group" or (object.get("kind")=="anchor" and (not hierarchy or not object.has("model_hash"))): continue
		var key: String = object.get("model_hash","") if not object.get("model_hash","").is_empty() else object.model_url
		if not asset_cache.has(key):
			var response = await fetch(parent,origin,object.model_url,Factory.MAX_ASSET_BYTES)
			if not response.ok:
				root.free()
				return response
			var asset = Factory.parse_glb(response.bytes,object.get("model_hash",""))
			if not asset.ok:
				root.free()
				return asset
			asset_cache[key] = asset
			while asset_cache.size()>32: asset_cache.erase(asset_cache.keys()[0])
		var asset = asset_cache[key]
		var model = asset.scene.instantiate()
		strip_unwanted(model)
		model.set_meta("model_owner",object.id)
		node.add_child(model)
		var record = {"id":object.id,"hash":asset.hash,"url":object.model_url,"bytes":asset.bytes,"mesh_count":asset.mesh_count}
		if hierarchy:
			# Bound imported geometry with the full world matrix, including shear.
			var geometry_error=Hierarchy.geometry_error(object,asset.bounds)
			if not geometry_error.is_empty():
				root.free()
				return {"ok":false,"error":geometry_error}
			Hierarchy.add_identity(record,object)
		assets.append(record)
	return {"ok":true,"root":root,"objects":objects,"assets":assets,"sources":loaded_sources.sources,"document":effective,"graph":graph,"source_scene":document.duplicate(true)}

func strip_unwanted(node: Node) -> void:
	for child in node.get_children():
		if child is Camera3D or child is Light3D:
			node.remove_child(child)
			child.free()
		else: strip_unwanted(child)
