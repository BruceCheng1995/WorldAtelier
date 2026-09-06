class_name ExpeditionState
extends RefCounted
const Assets = preload("res://scripts/live_assets.gd")
const LiveModules = preload("res://scripts/live_modules.gd")
var module_manager = LiveModules.new()
var previous_module_manager: RefCounted
var module_base_rules: Dictionary = {}
var previous_base_rules: Dictionary = {}
var effective_rules: Dictionary = {}
var module_disabled = false

var content: Dictionary = {}
var state: Dictionary = {}
var object_defs: Dictionary = {}
var enemy_defs: Dictionary = {}
var move_inputs: Dictionary = {}
var event_serial: int = 0

static func validate(candidate: Variant) -> String:
	if not candidate is Dictionary:
		return "content must be an object"
	if candidate.get("schema") != 1:
		return "unsupported content schema"
	if not candidate.get("title") is String or candidate.title.length() > 160:
		return "invalid title"
	for key in ["zones", "objects", "enemies", "quests"]:
		if not candidate.get(key) is Array:
			return "missing array: " + key
	if candidate.zones.size() < 1 or candidate.zones.size() > 32 or candidate.objects.size() > 3000 or candidate.enemies.size() > 300:
		return "content capacity exceeded"
	if not candidate.get("spawn") is Dictionary or not valid_point(candidate.spawn):
		return "invalid spawn"
	var zones = {}
	for zone in candidate.zones:
		if not zone is Dictionary or not valid_id(zone.get("id")) or not valid_point(zone):
			return "invalid zone"
		if zones.has(zone.id) or not number_between(zone.get("radius"), 4, 100):
			return "invalid or duplicate zone radius/id"
		if not valid_color(zone.get("color")):
			return "invalid zone color"
		zones[zone.id] = true
	var ids = {}
	for object in candidate.objects:
		if not object is Dictionary or not valid_id(object.get("id")) or not valid_point(object):
			return "invalid object"
		if ids.has(object.id) or not zones.has(object.get("zone_id")):
			return "duplicate object id or unknown zone: " + str(object.id)
		if not object.get("kind") in ["beacon", "crystal", "supply", "gate", "forge", "monument", "tree", "rock", "pillar", "platform", "bridge", "lamp", "flower", "furnace", "arch"]:
			return "unsupported object kind"
		for key in ["solid", "interactable"]:
			if object.has(key) and not object[key] is bool:
				return "object " + key + " must be boolean"
		if object.has("name") and (not object.name is String or object.name.length() > 160):
			return "invalid object name"
		if not number_between(object.get("scale", 1), 0.1, 8) or not valid_color(object.get("color", "#72dad2")):
			return "invalid object scale/color: " + str(object.id)
		for key in ["radius", "height", "length", "width"]:
			if object.has(key) and not number_between(object[key], 0.1, 160):
				return "invalid object dimension: " + key
		if object.has("rotation") and not number_between(object.rotation, -100, 100):
			return "invalid object rotation"
		ids[object.id] = true
	ids.clear()
	for enemy in candidate.enemies:
		if not enemy is Dictionary or not valid_id(enemy.get("id")) or not valid_point(enemy):
			return "invalid enemy"
		if ids.has(enemy.id) or not zones.has(enemy.get("zone_id")):
			return "duplicate enemy id or unknown zone"
		if not enemy.get("kind") in ["sentinel", "stalker", "artillerist", "brute", "boss"] or not number_between(enemy.get("hp"), 1, 100000):
			return "invalid enemy kind/hp"
		ids[enemy.id] = true
	if not candidate.get("rules") is Dictionary:
		return "missing rules"
	for key in ["player_speed", "attack_damage", "enemy_damage"]:
		if not number_between(candidate.rules.get(key), 0.1, 200):
			return "invalid rule: " + key
	for key in ["attack_range", "attack_cooldown", "dash_cooldown", "bounds"]:
		if candidate.rules.has(key) and not number_between(candidate.rules[key], 0.05, 200):
			return "invalid optional rule: " + key
	for quest in candidate.quests:
		if not quest is Dictionary or not valid_id(quest.get("id")) or not quest.get("title") is String or not quest.get("description") is String or not number_between(quest.get("target"), 1, 100000):
			return "invalid quest"
	return ""

static func number_between(value: Variant, low: float, high: float) -> bool:
	return (value is float or value is int) and is_finite(float(value)) and value >= low and value <= high

static func valid_point(value: Dictionary) -> bool:
	return number_between(value.get("x"), -200, 200) and number_between(value.get("z"), -200, 200)

static func valid_id(value: Variant) -> bool:
	if not value is String or value.length() < 1 or value.length() > 96:
		return false
	for c in value:
		if not c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-":
			return false
	return true

static func valid_color(value: Variant) -> bool:
	return value is String and value.length() <= 16 and Color.html_is_valid(value)

func initialize(candidate: Dictionary, saved: Variant = null, preserve_presence: bool = false) -> String:
	var error = validate(candidate)
	if not error.is_empty():
		return error
	var prepared_assets = Assets.prepare(candidate)
	if not prepared_assets.ok:
		return prepared_assets.error
	var module_error = module_manager.prepare(candidate)
	if not module_error.is_empty():
		return module_error
	module_base_rules = candidate.rules.duplicate(true)
	effective_rules = module_manager.last_good.duplicate(true)
	content = candidate.duplicate(true)
	state = {"schema": 1, "tick": 0, "world_time": 0.0, "players": {}, "enemies": {}, "objects": {}, "events": [], "tasks": [], "objectives": {"beacons": 0, "boss_defeated": false}, "event_serial": 0}
	if saved is Dictionary and saved.get("schema", 1) == 1:
		for key in ["tick", "world_time", "players", "enemies", "objects", "events", "tasks", "objectives", "event_serial"]:
			if saved.has(key):
				state[key] = saved[key]
		event_serial = int(state.get("event_serial", 0))
	reconcile_content()
	for player in state.players.values():
		if not preserve_presence:
			player.online = false
	if not refresh_rules("initialize"):
		return state.runtime_fault.error
	if not is_walkable(Vector2(content.spawn.x, content.spawn.z)):
		return "spawn must be on traversable land and clear of solid objects"
	return ""

func reconcile_content() -> void:
	object_defs.clear()
	enemy_defs.clear()
	for object in content.objects:
		object_defs[object.id] = object
		if not state.objects.has(object.id):
			state.objects[object.id] = {"collected": false, "activated": false}
	for enemy in content.enemies:
		enemy_defs[enemy.id] = enemy
		if not state.enemies.has(enemy.id):
			state.enemies[enemy.id] = {"kind": enemy.kind, "x": enemy.x, "z": enemy.z, "hp": enemy.hp, "max_hp": enemy.hp, "cooldown": 0.0, "telegraph": 0.0, "target": "", "dead": false, "phase": 1}
		else:
			var old = state.enemies[enemy.id]
			old.hp = clampf(float(old.hp), 0, enemy.hp)
			old.max_hp = enemy.hp
			old.kind = enemy.kind
	for id in state.objects.keys():
		if not object_defs.has(id):
			state.objects.erase(id)
	for id in state.enemies.keys():
		if not enemy_defs.has(id):
			state.enemies.erase(id)
	for player in state.players.values():
		if not object_defs.has(player.get("selected", "")):
			player.selected = ""
		if not is_walkable(Vector2(player.x, player.z)):
			player.x = content.spawn.x
			player.z = content.spawn.z

func apply_content(candidate: Dictionary) -> String:
	var error = validate(candidate)
	if not error.is_empty():
		return error
	# Candidate state/resources are isolated. The active world is only exchanged after
	# complete initialization and migration, at this main-thread frame boundary.
	var prepared = get_script().new()
	error = prepared.initialize(candidate, snapshot(), true)
	if not error.is_empty():
		return error
	previous_module_manager = module_manager
	previous_base_rules = module_base_rules
	module_manager = prepared.module_manager
	module_base_rules = prepared.module_base_rules
	effective_rules = prepared.effective_rules
	module_disabled = false
	content = prepared.content
	state = prepared.state
	object_defs = prepared.object_defs
	enemy_defs = prepared.enemy_defs
	event_serial = prepared.event_serial
	push_event("content_applied", Vector2(content.spawn.x, content.spawn.z), {"label": content.get("revision_label", "new release")})
	return ""

func join(user_id: String, player_name: String) -> void:
	if state.players.has(user_id):
		state.players[user_id].name = player_name.left(40)
		state.players[user_id].online = true
		return
	state.players[user_id] = {"online": true, "name": player_name.left(40), "x": content.spawn.x, "z": content.spawn.z, "hp": 100, "max_hp": 100, "stamina": 100.0, "crystals": 0, "collected": 0, "level": 1, "kills": 0, "quest_stage": 0, "facing_x": 0.0, "facing_z": -1.0, "attack_until": 0.0, "dash_until": 0.0, "attack_cooldown": 0.0, "dash_cooldown": 0.0, "selected": "", "respawn_at": 0.0, "upgrades": 0}
	push_event("join", Vector2(content.spawn.x, content.spawn.z), {"name": player_name})

func command(user_id: String, action: String, payload: Variant) -> Dictionary:
	if not state.players.has(user_id):
		return {"ok": false, "error": "player not joined"}
	if not payload is Dictionary:
		return {"ok": false, "error": "invalid payload"}
	var player = state.players[user_id]
	if not player.get("online", false):
		return {"ok": false, "error": "player is not connected"}
	refresh_rules(action)
	if action == "select":
		var selected = str(payload.get("object_id", ""))
		if not selected.is_empty() and not object_defs.has(selected):
			return {"ok": false, "error": "object not found"}
		player.selected = selected
		return {"ok": true}
	if player.hp <= 0:
		return {"ok": false, "error": "recovering at starport"}
	match action:
		"move":
			if not number_between(payload.get("x"), -1, 1) or not number_between(payload.get("z"), -1, 1):
				return {"ok": false, "error": "invalid movement"}
			var direction = Vector2(float(payload.x), float(payload.z)).limit_length(1)
			move_inputs[user_id] = {"x": direction.x, "z": direction.y, "expires": state.world_time + 0.4}
			if direction.length() > .05:
				player.facing_x = direction.x
				player.facing_z = direction.y
		"attack":
			if player.attack_cooldown > 0:
				return {"ok": false, "error": "attack cooling down"}
			player.attack_cooldown = effective_rules.get("attack_cooldown", .38)
			player.attack_until = state.world_time + .22
			var pos = Vector2(player.x, player.z)
			push_event("slash", pos, {"user_id": user_id, "fx": player.facing_x, "fz": player.facing_z})
			for id in enemy_defs:
				var enemy = state.enemies[id]
				var offset = Vector2(enemy.x, enemy.z) - pos
				if enemy.hp <= 0 or offset.length() > effective_rules.get("attack_range", 4.5):
					continue
				if offset.length() > 1.2 and offset.normalized().dot(Vector2(player.facing_x, player.facing_z)) < -.25:
					continue
				var damage = int(effective_rules.attack_damage + player.upgrades * 9)
				enemy.hp = maxf(0, enemy.hp - damage)
				push_event("hit", Vector2(enemy.x, enemy.z), {"damage": damage, "enemy_kind": enemy.kind})
				if enemy.hp <= 0:
					enemy.dead = true
					player.kills += 1
					var reward = 4 if enemy.kind != "boss" else 80
					player.crystals += reward
					player.level = 1 + int(player.kills / 6)
					push_event("enemy_defeated", Vector2(enemy.x, enemy.z), {"reward": reward, "enemy_kind": enemy.kind})
					if enemy.kind == "boss":
						state.objectives.boss_defeated = true
						push_event("victory", Vector2(enemy.x, enemy.z))
		"dash":
			if player.dash_cooldown > 0 or player.stamina < 28:
				return {"ok": false, "error": "dash not ready"}
			player.stamina -= 28
			player.dash_cooldown = effective_rules.get("dash_cooldown", 1.1)
			player.dash_until = state.world_time + .22
			push_event("dash", Vector2(player.x, player.z), {"user_id": user_id})
		"interact":
			return interact(user_id, str(payload.get("object_id", "")))
		"upgrade":
			for object in object_defs.values():
				if object.kind == "forge" and Vector2(object.x - player.x, object.z - player.z).length() <= 5:
					return buy_upgrade(player)
			return {"ok": false, "error": "approach a forge to upgrade"}
		_:
			return {"ok": false, "error": "unsupported action"}
	update_quests(player)
	return {"ok": true}

func interact(user_id: String, id: String) -> Dictionary:
	var player = state.players[user_id]
	var nearest = 5.5
	if id.is_empty():
		for object in object_defs.values():
			if not object.get("interactable", false) or state.objects[object.id].collected:
				continue
			var distance = Vector2(object.x - player.x, object.z - player.z).length()
			if distance < nearest:
				nearest = distance
				id = object.id
	if not object_defs.has(id):
		return {"ok": false, "error": "no interactable nearby"}
	var object = object_defs[id]
	if Vector2(object.x - player.x, object.z - player.z).length() > 5.5:
		return {"ok": false, "error": "object out of reach"}
	var object_state = state.objects[id]
	match object.kind:
		"crystal":
			if object_state.collected:
				return {"ok": false, "error": "already collected"}
			object_state.collected = true
			player.crystals += 2
			player.collected += 1
			push_event("collect", Vector2(object.x, object.z), {"user_id": user_id, "reward": 2})
		"beacon":
			if object_state.activated:
				return {"ok": false, "error": "beacon already linked"}
			for eid in enemy_defs:
				var enemy = state.enemies[eid]
				if enemy.hp > 0 and Vector2(enemy.x - object.x, enemy.z - object.z).length() < 8:
					return {"ok": false, "error": "clear guardians near the beacon"}
			object_state.activated = true
			state.objectives.beacons += 1
			player.crystals += 10
			push_event("beacon", Vector2(object.x, object.z), {"object_id": id})
		"supply":
			player.hp = player.max_hp
			player.stamina = 100
			push_event("heal", Vector2(player.x, player.z))
		"forge":
			return buy_upgrade(player)
		"gate":
			if state.objectives.beacons < 3:
				return {"ok": false, "error": "link all three beacons to open the citadel"}
			object_state.activated = true
			push_event("gate", Vector2(object.x, object.z))
		_:
			return {"ok": false, "error": "object is scenery"}
	for p in state.players.values():
		update_quests(p)
	return {"ok": true}

func buy_upgrade(player: Dictionary) -> Dictionary:
	var cost = 12 + player.upgrades * 8
	if player.upgrades >= 8:
		return {"ok": false, "error": "weapon fully attuned"}
	if player.crystals < cost:
		return {"ok": false, "error": "upgrade needs " + str(cost) + " crystals"}
	player.crystals -= cost
	player.upgrades += 1
	player.max_hp += 12
	player.hp = player.max_hp
	push_event("upgrade", Vector2(player.x, player.z), {"level": player.upgrades})
	return {"ok": true}

func update_quests(player: Dictionary) -> void:
	player.quest_stage = 0
	if player.collected >= 12 or player.upgrades > 0:
		player.quest_stage = 1
	if state.objectives.beacons >= 3:
		player.quest_stage = 2
	if state.objectives.boss_defeated:
		player.quest_stage = 3

func step(delta: float) -> void:
	refresh_rules("step")
	state.tick += 1
	state.world_time += delta
	for user_id in state.players:
		var player = state.players[user_id]
		if not player.get("online", false):
			continue
		if player.hp <= 0:
			if state.world_time >= player.respawn_at:
				player.x = content.spawn.x
				player.z = content.spawn.z
				player.hp = player.max_hp
				player.stamina = 100
				push_event("respawn", Vector2(player.x, player.z))
			continue
		player.attack_cooldown = maxf(0, player.attack_cooldown - delta)
		player.dash_cooldown = maxf(0, player.dash_cooldown - delta)
		player.stamina = minf(100, player.stamina + delta * 19)
		var input = move_inputs.get(user_id, {})
		var direction = Vector2.ZERO
		if input.get("expires", 0) > state.world_time:
			direction = Vector2(input.x, input.z)
		var speed = effective_rules.player_speed
		if player.dash_until > state.world_time:
			direction = Vector2(player.facing_x, player.facing_z)
			speed *= 3.0
		var pos = Vector2(player.x, player.z)
		var next = pos + direction * speed * delta
		if is_walkable(next):
			player.x = next.x
			player.z = next.y
		else:
			if is_walkable(Vector2(next.x, pos.y)):
				player.x = next.x
			if is_walkable(Vector2(player.x, next.y)):
				player.z = next.y
	for id in enemy_defs:
		step_enemy(id, delta)
	state.event_serial = event_serial
	while state.events.size() > 80:
		state.events.pop_front()

func step_enemy(id: String, delta: float) -> void:
	var enemy = state.enemies[id]
	if enemy.hp <= 0:
		return
	if enemy.kind == "boss" and state.objectives.beacons < 3:
		return
	var target_id = ""
	var distance = 17.0 if enemy.kind != "boss" else 23.0
	var pos = Vector2(enemy.x, enemy.z)
	for uid in state.players:
		var player = state.players[uid]
		if player.hp <= 0 or not player.get("online", false):
			continue
		var d = pos.distance_to(Vector2(player.x, player.z))
		if d < distance:
			distance = d
			target_id = uid
	enemy.cooldown = maxf(0, enemy.cooldown - delta)
	if enemy.telegraph > 0:
		enemy.telegraph -= delta
		if enemy.telegraph <= 0:
			resolve_enemy_attack(enemy)
		return
	if target_id.is_empty():
		var home = Vector2(enemy_defs[id].x, enemy_defs[id].z)
		if pos.distance_to(home) > 1:
			pos = pos.move_toward(home, delta * 1.8)
			enemy.x = pos.x
			enemy.z = pos.y
		return
	var target = state.players[target_id]
	var target_pos = Vector2(target.x, target.z)
	var reach = 2.8
	if enemy.kind == "artillerist":
		reach = 12
	elif enemy.kind == "boss":
		reach = 6.5
	elif enemy.kind == "brute":
		reach = 3.6
	if distance > reach:
		var speed = {"sentinel": 3.0, "stalker": 5.2, "artillerist": 2.0, "brute": 2.0, "boss": 2.2}[enemy.kind]
		pos = pos.move_toward(target_pos, delta * speed)
		enemy.x = pos.x
		enemy.z = pos.y
	elif enemy.cooldown <= 0:
		enemy.telegraph = .8 if enemy.kind != "boss" else 1.25
		enemy.cooldown = 1.7 if enemy.kind != "boss" else 2.6
		enemy.target = target_id
		enemy.target_x = target.x
		enemy.target_z = target.z
		enemy.phase = 2 if enemy.kind == "boss" and enemy.hp < enemy.max_hp / 2 else 1
		push_event("telegraph", pos, {"enemy_kind": enemy.kind, "target_x": target.x, "target_z": target.z, "duration": enemy.telegraph})

func resolve_enemy_attack(enemy: Dictionary) -> void:
	var origin = Vector2(enemy.x, enemy.z)
	var radius = 3.4
	if enemy.kind == "artillerist":
		origin = Vector2(enemy.get("target_x", enemy.x), enemy.get("target_z", enemy.z))
		radius = 3.2
	elif enemy.kind == "brute":
		radius = 4.5
	elif enemy.kind == "boss":
		radius = 8 if enemy.phase == 1 else 11
	push_event("enemy_attack", origin, {"enemy_kind": enemy.kind, "radius": radius})
	for player in state.players.values():
		if player.hp <= 0 or not player.get("online", false) or player.dash_until > state.world_time:
			continue
		if Vector2(player.x, player.z).distance_to(origin) < radius:
			var mult = {"sentinel": 1, "stalker": .8, "artillerist": 1.3, "brute": 1.8, "boss": 2.3}[enemy.kind]
			var damage = int(effective_rules.enemy_damage * mult)
			player.hp = maxf(0, player.hp - damage)
			push_event("player_hit", Vector2(player.x, player.z), {"damage": damage})
			if player.hp <= 0:
				player.respawn_at = state.world_time + 3.5
				player.crystals = maxi(0, player.crystals - 4)
				push_event("downed", Vector2(player.x, player.z))

func is_walkable(point: Vector2) -> bool:
	var land = false
	for zone in content.zones:
		if point.distance_to(Vector2(zone.x, zone.z)) < zone.radius - .5:
			land = true
	if not land:
		for object in content.objects:
			if object.kind == "bridge":
				var local = (point - Vector2(object.x, object.z)).rotated(float(object.get("rotation", 0)))
				if absf(local.x) < object.get("length", 1) / 2 and absf(local.y) < object.get("width", 7) / 2 - .4:
					land = true
	if not land:
		return false
	for object in object_defs.values():
		if object.get("solid", false) and point.distance_to(Vector2(object.x, object.z)) < float(object.get("radius", .7)) * float(object.get("scale", 1)) + .3:
			return false
	return true

func push_event(kind: String, pos: Vector2, extra: Dictionary = {}) -> void:
	event_serial += 1
	var event = {"id": event_serial, "kind": kind, "x": pos.x, "z": pos.y, "time": state.world_time}
	event.merge(extra)
	state.events.append(event)
	state.event_serial = event_serial

func snapshot() -> Dictionary:
	return state.duplicate(true)

func leave(user_id: String) -> void:
	if state.players.has(user_id):
		state.players[user_id].online = false
	move_inputs.erase(user_id)

func refresh_rules(action: String) -> bool:
	if module_disabled:
		return false
	var online_count = 0
	for player in state.get("players", {}).values():
		if player.get("online", false):
			online_count += 1
	var context = {"rules": module_base_rules, "player_count": online_count, "world_time": state.get("world_time", 0), "action": action}
	var result = module_manager.evaluate(context)
	if result.ok:
		effective_rules = result.rules
		state.module_assets = module_manager.hashes.duplicate()
		state.effective_rules = effective_rules.duplicate(true)
		return true
	state.runtime_fault = {"error": result.get("error", "module evaluation failed"), "asset_hash": result.get("asset_hash", ""), "tick": state.get("tick", 0), "action": action, "fallback": "last_good_rules"}
	if previous_module_manager != null:
		module_manager = previous_module_manager
		module_base_rules = previous_base_rules
		previous_module_manager = null
		context.rules = module_base_rules
		var fallback = module_manager.evaluate(context)
		if fallback.ok:
			effective_rules = fallback.rules
			state.runtime_fault.fallback = "previous_module"
		else:
			module_disabled = true
	else:
		module_disabled = true
	state.module_assets = module_manager.hashes.duplicate() if not module_disabled else []
	state.effective_rules = effective_rules.duplicate(true)
	return false
