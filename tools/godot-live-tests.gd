extends SceneTree
const Game = preload("res://scripts/game_state.gd")
var passed = 0
var failed = 0
func check(condition: bool, title: String) -> void:
	if condition:
		passed += 1
		print("PASS " + title)
	else:
		failed += 1
		printerr("FAIL " + title)
func module_content(base: Dictionary, source: String) -> Dictionary:
	var result = base.duplicate(true)
	var bytes = source.to_utf8_buffer()
	var hash_context = HashingContext.new()
	hash_context.start(HashingContext.HASH_SHA256)
	hash_context.update(bytes)
	var hash = hash_context.finish().hex_encode()
	result.behaviors = [{"id": "movement", "asset_hash": hash, "api": 1}]
	result.asset_blobs = {hash: {"mime": "text/x-gdscript", "data_base64": Marshalls.raw_to_base64(bytes)}}
	return result
func _initialize() -> void:
	var content = JSON.parse_string(FileAccess.get_file_as_string("res://content/world.json"))
	var game = Game.new()
	check(game.initialize(content).is_empty(), "baseline initialized")
	game.join("alice", "Alice")
	game.command("alice", "interact", {"object_id": "landing_crystal_0"})
	var mod_a = module_content(content, "extends RefCounted\nfunc evaluate(context):\n\treturn {\"player_speed\": 9.5}\n")
	check(game.apply_content(mod_a).is_empty(), "fresh GDScript behavior compiles and exchanges")
	check(game.state.players.alice.online and game.state.players.alice.crystals == 2, "module change preserves online presence and inventory")
	game.command("alice", "move", {"x": 0, "z": 1})
	for i in range(6): game.step(1.0 / 30)
	check(absf(game.state.players.alice.z - 7.9) < .02, "new GDScript rule governs actual movement")
	var old_hashes = game.state.module_assets.duplicate()
	var mod_b = module_content(content, "extends RefCounted\nfunc evaluate(context):\n\tif context.get(\"action\") == \"attack\":\n\t\tvar absent = {}\n\t\treturn {\"player_speed\": absent[\"missing\"]}\n\treturn {\"player_speed\": 13.0}\n")
	check(game.apply_content(mod_b).is_empty(), "conditional candidate passes preparation probes")
	# This deliberately triggers a real GDScript VM error; Logger must catch it.
	game.command("alice", "attack", {})
	check(game.state.has("runtime_fault"), "late VM failure is observable, never a false success")
	check(game.state.runtime_fault.fallback == "previous_module", "previous module instance retained for recovery")
	check(game.state.module_assets == old_hashes and game.effective_rules.player_speed == 9.5, "actual module identity and rules return to last good behavior")
	var before = JSON.stringify(game.snapshot())
	var bad = module_content(content, "extends RefCounted\nfunc evaluate(context):\n\treturn {\"player_speed\": \"bad\"}\n")
	check(not game.apply_content(bad).is_empty() and JSON.stringify(game.snapshot()) == before, "invalid module output fails before active mutation")
	var model = content.duplicate(true)
	var bytes = FileAccess.get_file_as_bytes("res://assets/explorer.glb")
	var hashing = HashingContext.new()
	hashing.start(HashingContext.HASH_SHA256)
	hashing.update(bytes)
	var hash = hashing.finish().hex_encode()
	model.objects[0].model_asset = hash
	model.asset_blobs = {hash: {"mime": "model/gltf-binary", "data_base64": Marshalls.raw_to_base64(bytes)}}
	check(game.apply_content(model).is_empty(), "real embedded GLB candidate parses and applies")
	check(game.state.players.alice.crystals == 2, "GLB replacement preserves gameplay")
	before = JSON.stringify(game.snapshot())
	model.asset_blobs[hash].data_base64 = Marshalls.raw_to_base64("not a glb".to_utf8_buffer())
	check(not game.apply_content(model).is_empty() and JSON.stringify(game.snapshot()) == before, "corrupt GLB hash rejects without altering the active state")
	game.leave("alice")
	check(not game.state.players.alice.online and not game.command("alice", "attack", {}).ok, "disconnected player retains save but cannot issue actions")
	var saved = game.snapshot()
	var restored = Game.new()
	check(restored.initialize(game.content, saved).is_empty(), "world with authored assets restores")
	check(not restored.state.players.alice.online, "restored presence awaits a real join")
	restored.join("alice", "Alice")
	check(restored.state.players.alice.crystals == 2 and restored.state.players.alice.online, "rejoin restores control eligibility without resetting progress")
	print("LIVE_MODULE_ASSET_TESTS passed=%d failed=%d" % [passed, failed])
	quit(0 if failed == 0 else 1)
