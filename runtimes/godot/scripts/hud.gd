extends Control

var game_root: Node
var map_expanded = false
var font: Font
const INK = Color("#0a1828")
const CREAM = Color("#e9f1df")
const MINT = Color("#87e7d1")
const MUTED = Color("#8faab6")
const GOLD = Color("#edc789")

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	font = load("res://assets/fonts/NotoSansSC.ttf")

func panel(rect: Rect2, border: Color = Color("#456777"), fill: Color = Color(.025, .065, .105, .92)) -> void:
	var style = StyleBoxFlat.new()
	style.bg_color = fill
	style.border_color = border
	style.set_border_width_all(1)
	style.set_corner_radius_all(9)
	draw_style_box(style, rect)

func text(value: String, pos: Vector2, size: int = 18, color: Color = CREAM) -> void:
	draw_string(font, pos, value, HORIZONTAL_ALIGNMENT_LEFT, -1, size, color)

func rule(a: Vector2, b: Vector2, color: Color = Color("#3b5766")) -> void:
	draw_line(a, b, color, 1, true)

func bar(rect: Rect2, amount: float, color: Color) -> void:
	draw_style_box(flat(Color("#142e3c")), rect)
	draw_style_box(flat(color), Rect2(rect.position, Vector2(rect.size.x * clampf(amount, 0, 1), rect.size.y)))

func flat(color: Color) -> StyleBoxFlat:
	var result = StyleBoxFlat.new()
	result.bg_color = color
	result.set_corner_radius_all(3)
	return result

func _draw() -> void:
	if not game_root:
		return
	var w = get_viewport_rect().size.x
	var h = get_viewport_rect().size.y
	var state = game_root.state
	var player = state.get("players", {}).get(game_root.user_id, {})
	var online_count = 0
	for p in state.get("players", {}).values():
		if p.get("online", false): online_count += 1
	var small = w < 1000
	# Header is quiet and compact so the world stays the main surface.
	panel(Rect2(24, 22, 352 if not small else 290, 99))
	text("W O R L D   A T E L I E R", Vector2(42, 46), 12, MINT)
	text("STARFALL EXPEDITION", Vector2(41, 76), 25 if not small else 21)
	var status = game_root.connection_status
	var status_color = MINT if game_root.active else GOLD
	draw_circle(Vector2(45, 102), 3, status_color)
	text(status.left(43), Vector2(57, 106), 12, status_color)
	var zone_name = "STARPORT OBSERVATORY"
	var zone_id = "observatory"
	if not player.is_empty():
		var nearest = 9999.0
		for zone in game_root.content.get("zones", []):
			var d = Vector2(player.x - zone.x, player.z - zone.z).length()
			if d < nearest:
				nearest = d
				zone_id = zone.id
		zone_name = {"observatory": "STARPORT OBSERVATORY", "gardens": "MOONDEW GARDENS", "foundry": "EMBER FOUNDRY", "citadel": "ASTRAL CITADEL"}.get(zone_id, "EXPEDITION ROUTE")
	text(zone_name, Vector2(42, 148), 14, CREAM)
	text("04 ISLANDS  /  ONE SHARED EXPEDITION", Vector2(42, 168), 10, MUTED)
	# Expedition objectives: completed state comes only from authority.
	var qx = w - (298 if not small else 242)
	var qw = 274 if not small else 218
	panel(Rect2(qx, 22, qw, 199))
	text("EXPEDITION LOG", Vector2(qx + 17, 48), 13, GOLD)
	text("A sky worth rebuilding.", Vector2(qx + 17, 70), 12, MUTED)
	rule(Vector2(qx + 17, 82), Vector2(qx + qw - 17, 82))
	var objectives = state.get("objectives", {})
	var entries = [["Gather star crystals", str(player.get("collected", 0)) + " / 12", player.get("collected", 0) >= 12], ["Reconnect beacons", str(objectives.get("beacons", 0)) + " / 3", objectives.get("beacons", 0) >= 3], ["Defeat Asterion", "COMPLETE" if objectives.get("boss_defeated", false) else "SEALED", objectives.get("boss_defeated", false)]]
	for i in range(entries.size()):
		var y = 106 + i * 37
		var done = entries[i][2]
		draw_circle(Vector2(qx + 23, y - 4), 5, MINT if done else Color("#334f60"))
		text(entries[i][0], Vector2(qx + 37, y), 12, MINT if done else CREAM)
		text(entries[i][1], Vector2(qx + 37, y + 15), 10, MUTED)
	# Selection + branch task handoff are visible inside the running game.
	var selected = str(player.get("selected", ""))
	if not selected.is_empty():
		panel(Rect2(24, 193, 280, 101), Color("#83d9d7"))
		text("SELECTED OBJECT", Vector2(41, 218), 11, MINT)
		text(selected.left(30), Vector2(41, 243), 16)
		text("Cyan silhouette + spatial bounds", Vector2(41, 267), 11, MUTED)
		text("Click another object to inspect", Vector2(41, 284), 10, MUTED)
	var tasks = state.get("tasks", [])
	if tasks.size() > 0:
		var ty = 312 if not selected.is_empty() else 194
		var shown = mini(tasks.size(), 3)
		panel(Rect2(24, ty, 280, 41 + shown * 47), Color("#9b784b"))
		text("LIVE COLLABORATION", Vector2(41, ty + 25), 11, GOLD)
		for i in range(shown):
			var task = tasks[i]
			var status_task = str(task.get("status", "editing"))
			var color = {"editing": GOLD, "testing": Color("#9bc9ff"), "delivered": MINT, "failed": Color("#ff9899")}.get(status_task, GOLD)
			text(status_task.to_upper() + " / " + str(task.get("object_id", "")).left(22), Vector2(41, ty + 49 + i * 47), 11, color)
			text(str(task.get("title", "")).left(33), Vector2(41, ty + 67 + i * 47), 12, CREAM)
	# Player HUD.
	if not player.is_empty():
		var bw = minf(596, w - 64)
		var bx = (w - bw) / 2
		var by = h - 118
		panel(Rect2(bx, by, bw, 92))
		text("EXPLORER  " + str(player.get("name", "")).left(20), Vector2(bx + 18, by + 24), 12, CREAM)
		text("LV " + str(player.get("level", 1)) + "   /   ATTUNE +" + str(player.get("upgrades", 0)), Vector2(bx + bw - 170, by + 24), 11, GOLD)
		bar(Rect2(bx + 18, by + 38, bw - 150, 10), float(player.get("hp", 0)) / maxf(1, float(player.get("max_hp", 100))), MINT)
		text(str(int(player.get("hp", 0))) + " / " + str(int(player.get("max_hp", 100))), Vector2(bx + bw - 115, by + 48), 12, CREAM)
		bar(Rect2(bx + 18, by + 57, bw - 150, 4), float(player.get("stamina", 0)) / 100, GOLD)
		text("WASD  MOVE     SPACE  STRIKE     SHIFT  DASH     E  INTERACT", Vector2(bx + 18, by + 80), 10, MUTED)
		panel(Rect2(24, h - 115, 143, 71))
		text("STAR CRYSTALS", Vector2(40, h - 92), 10, GOLD)
		text(str(player.get("crystals", 0)), Vector2(40, h - 62), 28, CREAM)
		text("" + str(player.get("kills", 0)) + " foes", Vector2(92, h - 64), 11, MUTED)
		if player.hp <= 0:
			panel(Rect2(w / 2 - 190, h / 2 - 47, 380, 94), Color("#e6a58d"))
			text("RETURNING TO STARPORT", Vector2(w / 2 - 153, h / 2 - 8), 20, GOLD)
			text("Your expedition progress is preserved.", Vector2(w / 2 - 144, h / 2 + 20), 13, CREAM)
	# Live world map: actual objects and every connected player.
	var map_size = 210.0 if not small else 154.0
	var map_rect = Rect2(w - map_size - 24, h - map_size - 148, map_size, map_size)
	if map_expanded:
		map_size = minf(h - 180, 580)
		map_rect = Rect2((w - map_size) / 2, (h - map_size) / 2, map_size, map_size)
	panel(map_rect)
	text("WORLD MAP  [TAB]", map_rect.position + Vector2(14, 23), 10, MUTED)
	var scale = (map_size - 34) / 152
	var origin = map_rect.position + Vector2(map_size / 2, map_size * .70)
	for zone in game_root.content.get("zones", []):
		var pos = origin + Vector2(zone.x, zone.z) * scale
		draw_circle(pos, zone.radius * scale, Color(zone.color).darkened(.13))
		draw_arc(pos, zone.radius * scale, 0, TAU, 40, Color(zone.color).lightened(.24), 1, true)
	for object in game_root.content.get("objects", []):
		if object.kind == "bridge":
			var a = float(object.get("rotation", 0))
			var offset = Vector2(cos(a), -sin(a)) * object.length * scale / 2
			var pos = origin + Vector2(object.x, object.z) * scale
			draw_line(pos - offset, pos + offset, Color("#628d91"), 3, true)
		if object.kind == "beacon":
			var pos = origin + Vector2(object.x, object.z) * scale
			draw_circle(pos, 3, MINT if state.get("objects", {}).get(object.id, {}).get("activated", false) else GOLD)
	for id in state.get("players", {}):
		var p = state.players[id]
		if not p.get("online", false):
			continue
		var pos = origin + Vector2(p.x, p.z) * scale
		draw_circle(pos, 4.5 if id == game_root.user_id else 3.5, CREAM if id == game_root.user_id else Color("#d6afff"))
	for enemy in state.get("enemies", {}).values():
		if enemy.get("kind") == "boss" and enemy.get("hp", 0) > 0:
			draw_circle(origin + Vector2(enemy.x, enemy.z) * scale, 4, Color("#f69b8e"))
	text(str(online_count) + " EXPLORERS CONNECTED", Vector2(w - map_size - 20, h - 133), 9, MUTED)
	# Feed messages and final objective reward are authority backed.
	if game_root.log_until > game_root.elapsed:
		var message = str(game_root.log_message).left(94)
		var width = minf(w - 70, font.get_string_size(message, HORIZONTAL_ALIGNMENT_LEFT, -1, 13).x + 34)
		panel(Rect2((w - width) / 2, h - 160, width, 29), Color("#477775"))
		text(message, Vector2((w - width) / 2 + 17, h - 140), 13, CREAM)
	if objectives.get("boss_defeated", false):
		panel(Rect2(w / 2 - 240, 30, 480, 76), GOLD)
		text("THE SKY IS OURS AGAIN", Vector2(w / 2 - 191, 64), 25, GOLD)
		text("EXPEDITION COMPLETE · keep building this world together", Vector2(w / 2 - 207, 88), 11, CREAM)
	elif not player.is_empty():
		var boss = state.get("enemies", {}).get("boss_asterion", {})
		if not boss.is_empty() and zone_id == "citadel" and objectives.get("beacons", 0) >= 3 and boss.hp > 0:
			var width = 420.0
			panel(Rect2(w / 2 - width / 2, 30, width, 64), Color("#b28891"))
			text("ASTERION  /  THE SHATTERED WARDEN", Vector2(w / 2 - width / 2 + 20, 55), 13, Color("#f6cdb8"))
			bar(Rect2(w / 2 - width / 2 + 20, 68, width - 40, 8), boss.hp / float(boss.max_hp), Color("#db937f"))
