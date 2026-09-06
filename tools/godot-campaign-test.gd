extends SceneTree
const Game = preload("res://scripts/game_state.gd")
var game = Game.new()
var nav = AStarGrid2D.new()
var actors = ["campaign-alice", "campaign-bob"]
var paths: Dictionary = {}
var path_goals: Dictionary = {}
var deaths: Dictionary = {}
var target: Dictionary = {}
var phase = 0
var phase_start = 0.0
var phases: Array = []
var trace: Array = []
var output = ""
func _initialize() -> void:
	var content = JSON.parse_string(FileAccess.get_file_as_string("res://content/world.json"))
	var error = game.initialize(content)
	if not error.is_empty():
		printerr(error); quit(1); return
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--report="): output = arg.substr(9)
	for id in actors:
		game.join(id, id)
		deaths[id] = 0
	nav.region = Rect2i(-80, -104, 161, 140)
	nav.cell_size = Vector2(1, 1)
	nav.diagonal_mode = AStarGrid2D.DIAGONAL_MODE_ONLY_IF_NO_OBSTACLES
	nav.update()
	for x in range(-80, 81):
		for z in range(-104, 36):
			nav.set_point_solid(Vector2i(x, z), not safe_cell(Vector2(x, z)))
	for object in content.objects:
		if object.kind == "crystal" and object.zone_id == "observatory":
			phases.append({"kind": "interact", "object_id": object.id})
	phases.append({"kind": "upgrade", "object_id": "forge_hub"})
	phases.append({"kind": "interact", "object_id": "launch_beacon"})
	phases.append({"kind": "clear", "zone": "gardens", "object_id": "garden_beacon"})
	phases.append({"kind": "interact", "object_id": "garden_beacon"})
	phases.append({"kind": "clear", "zone": "foundry", "object_id": "foundry_beacon"})
	phases.append({"kind": "interact", "object_id": "foundry_beacon"})
	phases.append({"kind": "upgrade", "object_id": "forge_hub"})
	phases.append({"kind": "interact", "object_id": "supply_hub"})
	phases.append({"kind": "clear", "zone": "citadel", "object_id": "astral_throne"})
	var max_steps = 36000
	for step in range(max_steps):
		if phase >= phases.size(): break
		target = phases[phase]
		if phase_done():
			print("CAMPAIGN phase=%d/%d elapsed=%.1fs %s" % [phase + 1, phases.size(), game.state.world_time, target])
			trace.append({"phase": phase, "objective": target, "world_time": game.state.world_time})
			phase += 1; phase_start = game.state.world_time; paths.clear()
			continue
		for id in actors:
			bot(id, step)
		game.step(1.0 / 30)
		if game.state.world_time - phase_start > 240:
			printerr("CAMPAIGN_STALLED " + JSON.stringify(target))
			break
	var success = phase == phases.size() and game.state.objectives.boss_defeated and game.state.objectives.beacons == 3
	var report = {"ok": success, "tick": game.state.tick, "seconds": game.state.world_time, "phases_complete": phase, "phases_total": phases.size(), "objectives": game.state.objectives, "players": game.state.players, "deaths": deaths, "trace": trace}
	report.recovery = verify_recovery(content)
	success = success and report.recovery.ok
	report.ok = success
	if not output.is_empty():
		var file = FileAccess.open(output, FileAccess.WRITE)
		if file: file.store_string(JSON.stringify(report, "  "))
	print("CAMPAIGN_RESULT " + JSON.stringify(report))
	quit(0 if success else 1)
func safe_cell(pos: Vector2) -> bool:
	for offset in [Vector2.ZERO, Vector2(.2,.2),Vector2(-.2,.2),Vector2(.2,-.2),Vector2(-.2,-.2)]:
		if not game.is_walkable(pos+offset): return false
	return true
func phase_done() -> bool:
	if target.kind == "clear":
		for id in game.enemy_defs:
			if game.enemy_defs[id].zone_id == target.zone and game.state.enemies[id].hp > 0: return false
		return true
	var object = game.object_defs[target.object_id]
	if target.kind == "upgrade":
		for id in actors:
			var p = game.state.players[id]
			if p.crystals >= 12 + p.upgrades * 8 and p.upgrades < 8: return false
		return true
	if object.kind == "crystal": return game.state.objects[object.id].collected
	if object.kind == "beacon": return game.state.objects[object.id].activated
	if object.kind == "supply":
		for id in actors:
			if game.state.players[id].hp < game.state.players[id].max_hp: return false
		return true
	return false
func bot(id: String, step: int) -> void:
	var player = game.state.players[id]
	if player.hp <= 0:
		if not paths.get(id, []).is_empty(): deaths[id] += 1
		paths[id] = []
		return
	var pos = Vector2(player.x, player.z)
	var object = game.object_defs[target.object_id]
	var goal = Vector2(object.x, object.z)
	var enemy_id = ""
	var nearest = 19.0
	for eid in game.enemy_defs:
		var enemy = game.state.enemies[eid]
		if enemy.hp <= 0 or (enemy.kind == "boss" and game.state.objectives.beacons < 3): continue
		var d = pos.distance_to(Vector2(enemy.x, enemy.z))
		if d < nearest:
			nearest = d; enemy_id = eid
	if target.kind == "clear" and enemy_id.is_empty():
		nearest = 999
		for eid in game.enemy_defs:
			if game.enemy_defs[eid].zone_id != target.zone or game.state.enemies[eid].hp <= 0: continue
			var enemy = game.state.enemies[eid]
			var d = pos.distance_to(Vector2(enemy.x, enemy.z))
			if d < nearest:
				nearest = d; enemy_id = eid
	if not enemy_id.is_empty():
		var enemy = game.state.enemies[enemy_id]
		goal = Vector2(enemy.x, enemy.z)
		var face = (goal - pos).normalized()
		if nearest < game.effective_rules.get("attack_range", 4.5) and player.attack_cooldown <= 0:
			game.command(id, "move", {"x": face.x, "z": face.y})
			game.command(id, "attack", {})
		if nearest <= 3.8: goal = pos
	var direction = navigate(id, pos, goal, step)
	# Dodge only through the same stamina/cooldown/invulnerability command as users.
	for enemy in game.state.enemies.values():
		if enemy.hp <= 0 or enemy.get("telegraph", 0) <= 0: continue
		var origin = Vector2(enemy.x, enemy.z)
		var radius = 3.4
		if enemy.kind == "artillerist":
			origin = Vector2(enemy.get("target_x", enemy.x), enemy.get("target_z", enemy.z)); radius = 3.2
		if enemy.kind == "brute": radius = 4.5
		if enemy.kind == "boss": radius = 8 if enemy.phase == 1 else 11
		if pos.distance_to(origin) < radius + 1.5:
			var away = (pos - origin).normalized()
			if away.length() < .1: away = Vector2(1, 0)
			if enemy.telegraph < .18 and player.dash_cooldown <= 0 and player.stamina >= 28:
				game.command(id, "move", {"x": away.x, "z": away.y})
				game.command(id, "dash", {})
			elif enemy.telegraph > .22: direction = away
			break
	game.command(id, "move", {"x": direction.x, "z": direction.y})
	if pos.distance_to(Vector2(object.x, object.z)) < 5.4:
		if target.kind == "interact": game.command(id, "interact", {"object_id": object.id})
		if target.kind == "upgrade": game.command(id, "upgrade", {})
func nearest_cell(pos: Vector2) -> Vector2i:
	var cell = Vector2i(roundi(pos.x), roundi(pos.y))
	var best = cell; var distance = INF
	for x in range(cell.x - 3, cell.x + 4):
		for z in range(cell.y - 3, cell.y + 4):
			var point = Vector2i(x, z)
			if nav.region.has_point(point) and not nav.is_point_solid(point):
				var d = pos.distance_to(Vector2(x, z))
				if d < distance: distance = d; best = point
	return best
func navigate(id: String, pos: Vector2, goal: Vector2, step: int) -> Vector2:
	if pos.distance_to(goal) < 1.2: return Vector2.ZERO
	if step % 30 == 0 or not paths.has(id) or Vector2(path_goals.get(id, Vector2.INF)).distance_to(goal) > 3:
		paths[id] = Array(nav.get_point_path(nearest_cell(pos), nearest_cell(goal)))
		path_goals[id] = goal
	var path = paths.get(id, [])
	while not path.is_empty() and pos.distance_to(path[0]) < .38: path.pop_front()
	if path.is_empty(): return (goal - pos).normalized()
	return (Vector2(path[0]) - pos).normalized()

func verify_recovery(content: Dictionary) -> Dictionary:
	game = Game.new()
	if not game.initialize(content).is_empty(): return {"ok": false}
	game.join("recovery-explorer", "Recovery Explorer")
	game.command("recovery-explorer", "interact", {"object_id": "landing_crystal_0"})
	paths.clear(); path_goals.clear()
	var down_tick = -1
	for step in range(2700):
		var player = game.state.players["recovery-explorer"]
		if player.hp <= 0 and down_tick < 0: down_tick = game.state.tick
		if down_tick >= 0 and player.hp > 0:
			var result = {"ok": player.collected == 1 and player.hp == player.max_hp and Vector2(player.x, player.z).distance_to(Vector2(content.spawn.x, content.spawn.z)) < .01, "down_tick": down_tick, "respawn_tick": game.state.tick, "retained_collection": player.collected, "hp": player.hp, "crystals": player.crystals}
			print("RECOVERY_RESULT " + JSON.stringify(result))
			return result
		if player.hp > 0:
			var direction = navigate("recovery-explorer", Vector2(player.x, player.z), Vector2(-40, -20), step)
			game.command("recovery-explorer", "move", {"x": direction.x, "z": direction.y})
		game.step(1.0 / 30)
	return {"ok": false, "error": "recovery scenario did not reach death and respawn"}
