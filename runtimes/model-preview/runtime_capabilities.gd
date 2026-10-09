extends RefCounted
const VERSION = "0.3.0"
static var data: Dictionary = {}
static func read() -> Dictionary:
	if data.is_empty():
		var decoded=JSON.parse_string(FileAccess.get_file_as_string("res://runtime_capabilities.json"))
		if decoded is Dictionary:data=decoded
	return data.duplicate(true)
