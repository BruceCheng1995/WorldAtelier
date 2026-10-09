extends "res://scene_loader.gd"
## The original immutable asset URLs remain in scene documents so the shared
## validators still check the original contract. Only transport is replaced.
var bundled_assets: Dictionary = {}

func fetch(_parent: Node, _origin: String, path: String, maximum: int) -> Dictionary:
	if not bundled_assets.has(path):
		return {"ok":false,"error":"发行包缺少资源映射："+path}
	var local_path = bundled_assets[path]
	if not local_path is String or not RegEx.create_from_string("^res://bundled/[A-Za-z0-9_.-]+$").search(local_path):
		return {"ok":false,"error":"发行包资源路径不合法："+path}
	var file = FileAccess.open(local_path,FileAccess.READ)
	if file == null:
		return {"ok":false,"error":"无法读取发行包资源："+path}
	var length = file.get_length()
	if length > maximum:
		file.close()
		return {"ok":false,"error":"发行包资源超出大小限制："+path}
	var bytes = file.get_buffer(length)
	file.close()
	if bytes.size() != length:
		return {"ok":false,"error":"发行包资源读取不完整："+path}
	# The shared loader also checks model_hash/script_hash against these bytes.
	# Check immutable URL hashes here as well, including assets without model_hash.
	var match_hash = RegEx.create_from_string("^/preview-assets/([a-f0-9]{64})\\.(glb|gd)(?:\\?.*)?$").search(path)
	if match_hash != null:
		var hashing = HashingContext.new()
		hashing.start(HashingContext.HASH_SHA256)
		hashing.update(bytes)
		if hashing.finish().hex_encode() != match_hash.get_string(1):
			return {"ok":false,"error":"发行包资源 SHA-256 校验失败："+path}
	return {"ok":true,"bytes":bytes}
