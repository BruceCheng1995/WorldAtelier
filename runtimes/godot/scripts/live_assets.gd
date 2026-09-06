class_name ExpeditionAssets
extends RefCounted

# Remote assets are immutable embedded GLBs. Each candidate uses fresh GLTF state
# and PackedScene instances; no ResourceLoader REPLACE or shared-path overwrite.
static func prepare(content: Dictionary) -> Dictionary:
	var scenes = {}
	var blobs = content.get("asset_blobs", {})
	if not blobs is Dictionary:
		return {"ok": false, "error": "asset_blobs must be a dictionary"}
	var needed = {}
	for object in content.get("objects", []):
		if object.has("model_asset"):
			if not object.model_asset is String or object.model_asset.length() != 64:
				return {"ok": false, "error": "invalid model_asset hash"}
			needed[object.model_asset] = true
	for hash in needed:
		var blob = blobs.get(hash)
		if not blob is Dictionary or blob.get("mime") != "model/gltf-binary" or not blob.get("data_base64") is String:
			return {"ok": false, "error": "missing GLB asset: " + str(hash)}
		if blob.data_base64.length() > 24 * 1024 * 1024:
			return {"ok": false, "error": "GLB exceeds 18 MB runtime limit"}
		var bytes = Marshalls.base64_to_raw(blob.data_base64)
		var hashing = HashingContext.new()
		hashing.start(HashingContext.HASH_SHA256)
		hashing.update(bytes)
		if hashing.finish().hex_encode() != hash:
			return {"ok": false, "error": "GLB hash mismatch"}
		var error = validate_glb(bytes)
		if not error.is_empty():
			return {"ok": false, "error": error}
		var document = GLTFDocument.new()
		var gltf = GLTFState.new()
		var code = document.append_from_buffer(bytes, "", gltf)
		if code != OK:
			return {"ok": false, "error": "GLB parse failed: " + error_string(code)}
		var scene = document.generate_scene(gltf)
		if scene == null:
			return {"ok": false, "error": "GLB scene generation failed"}
		var packed = PackedScene.new()
		code = packed.pack(scene)
		scene.free()
		if code != OK:
			return {"ok": false, "error": "GLB scene packing failed"}
		scenes[hash] = packed
	return {"ok": true, "scenes": scenes}

static func validate_glb(bytes: PackedByteArray) -> String:
	if bytes.size() < 24 or bytes.decode_u32(0) != 0x46546c67 or bytes.decode_u32(4) != 2 or bytes.decode_u32(8) != bytes.size():
		return "invalid GLB header"
	var json_length = bytes.decode_u32(12)
	if bytes.decode_u32(16) != 0x4e4f534a or json_length > bytes.size() - 20:
		return "invalid GLB JSON chunk"
	var document = JSON.parse_string(bytes.slice(20, 20 + json_length).get_string_from_utf8())
	if not document is Dictionary:
		return "invalid GLB JSON"
	for key in ["buffers", "images"]:
		for item in document.get(key, []):
			if item.has("uri") and not str(item.uri).begins_with("data:"):
				return "external GLB resources are not permitted; embed them in the GLB"
	if document.get("nodes", []).size() > 2000 or document.get("meshes", []).size() > 500:
		return "GLB scene capacity exceeded"
	return ""
