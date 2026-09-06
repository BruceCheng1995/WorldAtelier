extends SceneTree
const Game = preload("res://scripts/game_state.gd")
var passed = 0
var failed = 0
func check(condition: bool, title: String) -> void:
	if not condition:
		printerr("FAIL " + title)
		failed += 1
		return
	passed += 1
	print("PASS " + title)
func _initialize() -> void:
	var content = JSON.parse_string(FileAccess.get_file_as_string("res://content/world.json"))
	var game = Game.new()
	check(game.initialize(content).is_empty(), "authored content initializes with legal spawn")
	game.join("alice", "Alice")
	game.join("bob", "Bob")
	check(game.command("alice", "interact", {"object_id": "landing_crystal_0"}).ok, "normal nearby interact collects crystal")
	check(game.state.players.alice.crystals == 2, "reward from authority")
	check(not game.command("bob", "interact", {"object_id": "landing_crystal_0"}).ok, "second player cannot duplicate shared reward")
	check(game.state.players.bob.crystals == 0, "failed duplicate does not reward")
	check(not game.command("alice", "move", {"x": 999, "z": 0}).ok, "invalid move input refused")
	check(not game.command("alice", "interact", {"object_id": "garden_beacon"}).ok, "remote interaction refused")
	game.command("alice", "select", {"object_id": "landing_crystal_1"})
	var candidate = content.duplicate(true)
	candidate.rules.player_speed = 12
	check(game.apply_content(candidate).is_empty(), "candidate content exchanges successfully")
	check(game.state.players.alice.crystals == 2 and game.state.objects.landing_crystal_0.collected, "hot update keeps rewards and shared collection")
	game.command("alice", "move", {"x": 0, "z": 1})
	for i in range(9): game.step(1.0 / 30)
	check(absf(game.state.players.alice.z - 9.6) < .05, "new speed executes in authoritative simulation")
	var before = JSON.stringify(game.snapshot())
	var invalid = candidate.duplicate(true)
	invalid.objects.append({"id": "blocked_spawn", "kind": "rock", "name": "Bad", "x": 0, "z": 6, "scale": 2, "radius": 2, "solid": true, "zone_id": "observatory"})
	check(not game.apply_content(invalid).is_empty(), "candidate invalid spawn rejected after isolated initialization")
	check(JSON.stringify(game.snapshot()) == before and game.content.rules.player_speed == 12, "failed candidate leaves active state and content exactly intact")
	var removed = candidate.duplicate(true)
	removed.objects = removed.objects.filter(func(o): return o.id != "landing_crystal_1")
	removed.enemies = removed.enemies.filter(func(e): return e.id != "gardens_enemy_0")
	check(game.apply_content(removed).is_empty(), "content removal applies")
	check(not game.state.objects.has("landing_crystal_1") and not game.state.enemies.has("gardens_enemy_0") and game.state.players.alice.selected == "", "removed entities and selection cleanly migrate")
	var restore = Game.new()
	check(restore.initialize(removed, game.snapshot()).is_empty(), "saved snapshot restores")
	restore.join("alice", "Alice rejoined")
	check(restore.state.players.alice.crystals == 2 and restore.state.players.alice.z == game.state.players.alice.z, "join preserves seeded progress and position")
	invalid = content.duplicate(true)
	invalid.objects[0].solid = "yes"
	check(not Game.validate(invalid).is_empty(), "malformed collision flag rejected")
	for omitted in [["length"], ["width"], ["length", "width"]]:
		invalid = content.duplicate(true)
		for object in invalid.objects:
			if object.kind == "bridge":
				for field in omitted: object.erase(field)
				break
		check(Game.validate(invalid) == "bridge requires length and width", "bridge rejects missing " + ", ".join(omitted))
	print("GAME_STATE_TESTS passed=%d failed=%d" % [passed, failed])
	quit(0 if failed == 0 else 1)
