extends RefCounted
const Context = preload("res://behavior_context.gd")
const MAX_SCRIPT_BYTES = 256 * 1024
class ErrorCollector extends Logger:
	var errors: Array = []
	func _log_error(_function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _backtraces: Array[ScriptBacktrace]) -> void:
		if error_type != Logger.ERROR_TYPE_WARNING: errors.append({"file":file,"line":line,"message":code+" "+rationale})
var entries: Dictionary = {}
var hashes: Array = []
var fault: Dictionary = {}
var role = "authority"

static func json_value(value: Variant, depth: int = 0) -> bool:
	if depth > 12: return false
	if value == null or value is bool or value is String: return true
	if value is int or value is float: return is_finite(float(value))
	if value is Array:
		if value.size() > 2048: return false
		for item in value:
			if not json_value(item,depth+1): return false
		return true
	if value is Dictionary:
		if value.size() > 256: return false
		for key in value:
			if not key is String or not json_value(value[key],depth+1): return false
		return true
	return false

func prepare(document: Dictionary, roots: Dictionary, sources: Dictionary, mode: String, states: Dictionary = {}) -> String:
	role = mode
	var compiled: Dictionary = {}
	for row in document.objects:
		for component in row.get("components",{}).get("behaviors",[]):
			var hash: String = component.script_hash
			if not sources.has(hash): return "missing behavior source " + hash
			var source: String = sources[hash]
			if source.to_utf8_buffer().size() > MAX_SCRIPT_BYTES: return "behavior exceeds 256 KiB"
			if source.sha256_text() != hash: return "behavior SHA-256 mismatch"
			var collector = ErrorCollector.new()
			OS.add_logger(collector)
			var script: GDScript = compiled.get(hash)
			var error = OK
			if script == null:
				script = GDScript.new()
				script.resource_path = "res://creator_behaviors/"+hash+"-"+str(get_instance_id())+".gd"
				script.source_code = source
				error = script.reload()
			var instance = script.new() if error == OK else null
			OS.remove_logger(collector)
			if error != OK or not collector.errors.is_empty() or instance == null:
				return "behavior compile/instantiate failed: " + str(collector.errors)
			if not instance is RefCounted:
				if instance is Node: instance.free()
				return "behavior must extend RefCounted"
			compiled[hash] = script
			var context = Context.new()
			context.role = role
			context.object_id = row.id
			context.component_id = component.id
			context.address = row.get("address",{}).duplicate(true)
			context.source_revision = row.get("source_revision",document.get("scene_revision",""))
			context.object_version = row.get("object_version","")
			context.ancestry_hash = row.get("ancestry_hash","")
			context.source_world_matrix = row.get("world_matrix",[]).duplicate()
			context.properties = component.get("properties",{}).duplicate(true)
			context.state = states.get(row.id,{}).get(component.id,{}).duplicate(true)
			context.root = roots.get(row.id) if role == "presentation" else null
			var key = row.id+":"+component.id
			entries[key] = {"instance":instance,"context":context,"hash":hash,"disabled":false}
			if not hash in hashes: hashes.append(hash)
			var result = invoke(key,"initialize",[context])
			if not result.ok: return result.error
	return ""

func invoke(key: String, method: String, arguments: Array) -> Dictionary:
	var entry = entries[key]
	if entry.disabled: return {"ok":false,"error":"behavior disabled after runtime failure"}
	if not entry.instance.has_method(method): return {"ok":true}
	var previous: Dictionary = entry.context.state.duplicate(true)
	var previous_events: Array = entry.context.events.duplicate(true)
	var collector = ErrorCollector.new()
	OS.add_logger(collector)
	var result = entry.instance.callv(method,arguments)
	OS.remove_logger(collector)
	var error = ""
	if not collector.errors.is_empty(): error = str(collector.errors)
	elif not result is Dictionary or result.get("ok") != true: error = "callback must return {ok:true}: " + method
	elif not json_value(entry.context.state) or JSON.stringify(entry.context.state).length() > 65536: error = "behavior state must be bounded JSON"
	elif not json_value(entry.context.events) or entry.context.events.size() > 64: error = "behavior emitted invalid/excess events"
	if not error.is_empty():
		entry.context.state = previous
		entry.context.events = previous_events
		entry.disabled = true
		fault = {"object_id":entry.context.object_id,"component_id":entry.context.component_id,"script_hash":entry.hash,"method":method,"error":error}
		if not entry.context.address.is_empty(): fault.merge({"address":entry.context.address.duplicate(true),"source_revision":entry.context.source_revision,"object_version":entry.context.object_version,"ancestry_hash":entry.context.ancestry_hash})
		return {"ok":false,"error":error}
	return {"ok":true}

func update_contexts(players: Array, tick: int) -> void:
	for entry in entries.values():
		entry.context.players = players.duplicate(true)
		entry.context.tick = tick
		entry.context.time = tick/60.0

func tick(delta: float) -> void:
	for key in entries:
		var entry = entries[key]
		if not entry.disabled: invoke(key,"tick",[entry.context,delta])

func interact(object_id: String, actor: Dictionary) -> void:
	for key in entries:
		var entry = entries[key]
		if entry.context.object_id == object_id and not entry.disabled: invoke(key,"interact",[entry.context,actor.duplicate(true)])

func trigger(object_id: String, actor: Dictionary, entered: bool) -> void:
	for key in entries:
		var entry = entries[key]
		if entry.context.object_id == object_id and not entry.disabled: invoke(key,"trigger",[entry.context,actor.duplicate(true),entered])

func present(event: Dictionary) -> void:
	for key in entries:
		var entry = entries[key]
		if entry.disabled: continue
		if event.has("object_id") and event.object_id != entry.context.object_id: continue
		if event.has("component_id") and event.component_id != entry.context.component_id: continue
		invoke(key,"present",[entry.context,event.duplicate(true)])

func apply_states(states: Dictionary) -> void:
	for entry in entries.values(): entry.context.state = states.get(entry.context.object_id,{}).get(entry.context.component_id,{}).duplicate(true)

func snapshot() -> Dictionary:
	var result = {}
	for entry in entries.values():
		if not result.has(entry.context.object_id): result[entry.context.object_id] = {}
		result[entry.context.object_id][entry.context.component_id] = entry.context.state.duplicate(true)
	return result

func take_events() -> Array:
	var result = []
	for entry in entries.values():
		result.append_array(entry.context.events)
		entry.context.events.clear()
	return result

func freeze(value: bool) -> void:
	for key in entries:
		var entry = entries[key]
		entry.context.freeze(value)
		if not entry.disabled: invoke(key,"freeze",[entry.context,value])

func dispose() -> void:
	for key in entries:
		var entry = entries[key]
		if not entry.disabled: invoke(key,"dispose",[entry.context])
	entries.clear()
