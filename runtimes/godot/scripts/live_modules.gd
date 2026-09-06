extends RefCounted
## Versioned, cooperative GDScript rule modules. This API is a restricted
## development contract, not a security sandbox for arbitrary hostile code.

class ErrorCollector extends Logger:
	var lock = Mutex.new()
	var errors: Array[String] = []
	func _log_error(_function: String, _file: String, _line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _backtraces: Array[ScriptBacktrace]) -> void:
		if error_type == Logger.ERROR_TYPE_WARNING:
			return
		lock.lock()
		errors.append((code + " " + rationale).left(1200))
		lock.unlock()
	func first_error() -> String:
		lock.lock()
		var result = errors[0] if not errors.is_empty() else ""
		lock.unlock()
		return result

const RULE_LIMITS = {
	"player_speed": Vector2(0.1, 60), "attack_damage": Vector2(0.1, 200),
	"enemy_damage": Vector2(0.1, 200), "attack_range": Vector2(0.1, 20),
	"attack_cooldown": Vector2(0.05, 10), "dash_cooldown": Vector2(0.1, 20)
}
var instances: Array = []
var hashes: Array[String] = []
var last_good: Dictionary = {}

func prepare(candidate: Dictionary) -> String:
	var prepared: Array = []
	var prepared_hashes: Array[String] = []
	var definitions = candidate.get("behaviors", [])
	if not definitions is Array or definitions.size() > 8:
		return "invalid behavior list"
	for definition in definitions:
		if not definition is Dictionary or definition.get("api") != 1 or not definition.get("asset_hash") is String:
			return "behavior API must be 1 and reference a SHA256 asset"
		var asset_hash: String = definition.asset_hash
		var blob = candidate.get("asset_blobs", {}).get(asset_hash, {})
		if blob.get("mime") != "text/x-gdscript" or not blob.get("data_base64") is String:
			return "behavior source asset missing"
		var bytes = Marshalls.base64_to_raw(blob.data_base64)
		var hash_context = HashingContext.new()
		hash_context.start(HashingContext.HASH_SHA256)
		hash_context.update(bytes)
		if hash_context.finish().hex_encode() != asset_hash or bytes.size() > 32000:
			return "behavior source hash/size mismatch"
		var source = bytes.get_string_from_utf8()
		var contract_error = validate_source(source)
		if not contract_error.is_empty():
			return contract_error
		var collector = ErrorCollector.new()
		OS.add_logger(collector)
		var script = GDScript.new()
		script.source_code = source
		var compiled = script.reload()
		var instance = script.new() if compiled == OK else null
		OS.remove_logger(collector)
		if compiled != OK or instance == null or not collector.first_error().is_empty():
			return "behavior compilation rejected: " + collector.first_error()
		prepared.append(instance)
		prepared_hashes.append(asset_hash)
	instances = prepared
	hashes = prepared_hashes
	for player_count in [0, 1, 3]:
		var probe = evaluate({"rules": candidate.rules.duplicate(true), "player_count": player_count, "world_time": float(player_count) * 10.0, "action": "validate"})
		if not probe.ok:
			return probe.error
	return ""

static func validate_source(source: String) -> String:
	if not source.strip_edges().begins_with("extends RefCounted"):
		return "behavior must extend RefCounted"
	var disallowed = RegEx.new()
	disallowed.compile("\\b(while|for|await|static|class_name|signal|OS|Engine|FileAccess|DirAccess|ResourceLoader|ResourceSaver|ClassDB|JavaScriptBridge|Thread|WorkerThreadPool|RenderingServer|PhysicsServer3D|SceneTree|load|preload)\\b")
	if disallowed.search(source):
		return "behavior exceeds the pure rule module contract"
	var functions = RegEx.new()
	functions.compile("\\bfunc\\s+([A-Za-z_][A-Za-z0-9_]*)")
	var declarations = functions.search_all(source)
	if declarations.size() != 1 or declarations[0].get_string(1) != "evaluate":
		return "behavior must declare only evaluate(context)"
	var calls = RegEx.new()
	calls.compile("([A-Za-z_][A-Za-z0-9_]*)\\s*\\(")
	var evaluate_calls = 0
	for call_match in calls.search_all(source):
		var method = call_match.get_string(1)
		if method == "evaluate":
			evaluate_calls += 1
		if not method in ["evaluate", "get", "has", "float", "int", "bool", "absf", "clampf", "minf", "maxf", "lerpf", "is_finite"]:
			return "behavior call not available: " + method
	if evaluate_calls != 1:
		return "recursive behavior calls are unsupported"
	return ""

func evaluate(context: Dictionary) -> Dictionary:
	var rules = context.get("rules", {}).duplicate(true)
	for index in instances.size():
		var collector = ErrorCollector.new()
		OS.add_logger(collector)
		var result = instances[index].evaluate(context.duplicate(true))
		OS.remove_logger(collector)
		var error = collector.first_error()
		if not error.is_empty() or not result is Dictionary:
			return {"ok": false, "error": "behavior execution rejected: " + error, "asset_hash": hashes[index], "rules": last_good.duplicate(true)}
		for key in result:
			if not RULE_LIMITS.has(key):
				return {"ok": false, "error": "unsupported behavior output: " + str(key), "asset_hash": hashes[index], "rules": last_good.duplicate(true)}
			var value = result[key]
			var limits: Vector2 = RULE_LIMITS[key]
			if not (value is float or value is int) or not is_finite(float(value)) or value < limits.x or value > limits.y:
				return {"ok": false, "error": "invalid behavior output: " + str(key), "asset_hash": hashes[index], "rules": last_good.duplicate(true)}
			rules[key] = value
	last_good = rules.duplicate(true)
	return {"ok": true, "rules": rules, "asset_hashes": hashes.duplicate()}
