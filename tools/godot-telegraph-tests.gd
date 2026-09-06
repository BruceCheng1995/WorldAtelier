extends SceneTree
# Isolated boundary fixtures deliberately seed positions/phase. This is neither
# a campaign nor proof that a player reached these encounters through gameplay.
const Game = preload("res://scripts/game_state.gd")
const Visual = preload("res://scripts/world_visual.gd")
var output = ""
var render = false
var failures: Array = []
var observations: Array = []
func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--report-dir="): output = arg.substr(13)
		if arg == "--render": render = true
	run.call_deferred()
func check(ok: bool, detail: String) -> void:
	if not ok:
		failures.append(detail)
		printerr("FAIL " + detail)
func run() -> void:
	if not output.is_empty(): DirAccess.make_dir_recursive_absolute(output)
	for spec in [["sentinel",1,3.4],["stalker",1,3.4],["artillerist",1,3.2],["brute",1,4.5],["boss",1,8.0],["boss",2,11.0]]:
		var kind = spec[0]
		var phase = spec[1]
		var expected_radius = spec[2]
		var title = "%s-phase-%d" % [kind, phase]
		var content = JSON.parse_string(FileAccess.get_file_as_string("res://content/world.json"))
		content.objects = []
		content.zones = [{"id":"observatory","name":"Danger boundary fixture","x":0,"z":0,"radius":26,"color":"#35566d"}]
		content.spawn = {"x":6 if kind == "artillerist" else 2,"z":0}
		content.enemies = [{"id":"subject","kind":kind,"hp":1000,"x":0,"z":0,"zone_id":"observatory"}]
		var game = Game.new()
		check(game.initialize(content).is_empty(), title + " initializes")
		game.join("target", "TARGET")
		game.state.objectives.beacons = 3
		if phase == 2: game.state.enemies.subject.hp = 400
		game.step(1.0 / 30)
		var warning: Dictionary = {}
		for event in game.state.events:
			if event.kind == "telegraph": warning = event.duplicate(true)
		check(not warning.is_empty(), title + " actual AI emits warning")
		if warning.is_empty(): continue
		var area = game.state.enemies.subject.attack_area.duplicate(true)
		check(is_equal_approx(area.radius, expected_radius), title + " expected authoritative radius")
		check(is_equal_approx(area.x, 6.0 if kind == "artillerist" else 0.0) and area.z == 0, title + " correct authority center")
		check(warning.x == area.x and warning.z == area.z and warning.radius == area.radius, title + " event uses exact promised region")
		for id in ["inside", "outside"]: game.join(id, id.to_upper() + (" -0.05m" if id == "inside" else " +0.05m"))
		game.state.players.inside.x = area.x + area.radius - .05
		game.state.players.inside.z = area.z
		game.state.players.outside.x = area.x - area.radius - .05
		game.state.players.outside.z = area.z
		var scene = Visual.new()
		root.add_child(scene)
		check(scene.build_world(content).is_empty(), title + " actual Node3D scene builds")
		scene.camera.size = 36
		scene.camera_target = Vector3(area.x, 0, area.z)
		scene.update_world(game.snapshot(), "", 1.0 / 30)
		scene.update_world(game.snapshot(), "", .1)
		var actual = {}
		for effect in scene.effects_live:
			if effect.node.has_meta("telegraph_area"):
				actual = effect.node.get_meta("telegraph_area")
				var torus = effect.node.get_child(0).mesh
				check(is_equal_approx((torus.inner_radius + torus.outer_radius) / 2, area.radius), title + " actual TorusMesh boundary matches damage radius")
		check(not actual.is_empty() and is_equal_approx(actual.get("x", INF), area.x) and is_equal_approx(actual.get("z", INF), area.z) and is_equal_approx(actual.get("radius", INF), area.radius), title + " rendered origin/radius equals authority")
		if render:
			var canvas = CanvasLayer.new()
			var caption = Label.new()
			caption.position = Vector2(28,28)
			caption.text = "ISOLATED DANGER BOUNDARY FIXTURE / RUNTIME 0.1.1\n%s  |  center (%.1f, %.1f)  |  hurt radius %.2fm\nInside probe: R - 0.05m receives damage; outside probe: R + 0.05m remains safe.\nFixture positions and boss phase are seeded for boundary verification." % [title, area.x, area.z, area.radius]
			caption.add_theme_font_override("font", load("res://assets/fonts/AtelierUI.tres"))
			caption.add_theme_font_size_override("font_size",20)
			canvas.add_child(caption)
			root.add_child(canvas)
			for i in range(4): await process_frame
			await RenderingServer.frame_post_draw
			root.get_texture().get_image().save_png(output.path_join(title + ".png"))
			canvas.queue_free()
		# Move the original target after windup to ensure a mortar cannot chase it.
		game.state.players.target.x = -18
		game.state.players.target.z = -10
		var before_in = game.state.players.inside.hp
		var before_out = game.state.players.outside.hp
		for i in range(39): game.step_enemy("subject", 1.0 / 30)
		check(game.state.players.inside.hp < before_in, title + " inside promised boundary receives real damage")
		check(game.state.players.outside.hp == before_out, title + " outside promised boundary remains safe")
		var attack: Dictionary = {}
		for event in game.state.events:
			if event.kind == "enemy_attack": attack = event
		check(attack.get("x") == warning.x and attack.get("z") == warning.z and attack.get("radius") == warning.radius, title + " impact remains at locked warning after target moves")
		observations.append({"fixture":title,"warning":warning,"rendered_area":actual,"impact":attack,"inside_damage":before_in-game.state.players.inside.hp,"outside_damage":before_out-game.state.players.outside.hp})
		scene.queue_free()
		await process_frame
	var report = {"ok":failures.is_empty(),"scope":"isolated seeded authority and actual Node3D renderer fixtures, not campaign progression","rendered":render,"cases":observations,"failures":failures}
	if not output.is_empty():
		var file = FileAccess.open(output.path_join("report.json"),FileAccess.WRITE)
		file.store_string(JSON.stringify(report,"  "))
	print("TELEGRAPH_BOUNDARIES " + JSON.stringify(report))
	quit(0 if failures.is_empty() else 1)
