extends Node3D
# An actual isolated playable/inspectable scene. Assertions operate on a second
# Game instance so checking pickup/destruction never erases the preview prefab.
const Game = preload("res://scripts/game_state.gd")
const Visual = preload("res://scripts/world_visual.gd")
@export var fixture_json = ""
var fixture: Dictionary = {}
var game = Game.new()
var visual: Node3D
var result: Dictionary = {"ok":true,"completed":false,"checks":[],"failures":[]}
var elapsed = 0.0
var playing = false
var capture_path = ""
var capture_done = false
var quit_after = 0.0
var user_id = "fixture-explorer"
func check(ok: bool, detail: String) -> void:
	result.checks.append({"ok":ok,"detail":detail})
	if not ok:
		result.ok = false
		result.failures.append(detail)
		printerr("PREFAB_FAIL " + str(fixture.get("id","")) + " " + detail)
func initialize_game(instance: RefCounted) -> String:
	var error = instance.initialize(fixture.content)
	if error.is_empty():
		instance.join(user_id,"Fixture explorer")
		instance.state.objectives.beacons = 3 # Allow isolated enemy/gate/beacon systems to execute.
	return error
func _ready() -> void:
	fixture = JSON.parse_string(FileAccess.get_file_as_string(fixture_json))
	result.id = fixture.id
	check(initialize_game(game).is_empty(),"content initializes and a real player joins")
	visual = Visual.new()
	add_child(visual)
	check(visual.build_world(fixture.content).is_empty(),"actual Node3D world builds")
	visual.camera_target = Vector3(0,0,0)
	visual.camera.size = 23
	if fixture.category == "object" and fixture.kind == "bridge": visual.camera.size = 42
	for arg in OS.get_cmdline_user_args():
		if arg == "--play": playing = true
		if arg.begins_with("--capture="): capture_path = arg.substr(10)
		if arg.begins_with("--quit-after-seconds="): quit_after = float(arg.substr(21))
	if fixture.kind in ["selection","editing","testing","delivered","failed"]:
		game.command(user_id,"select",{"object_id":fixture.subject_id})
		if fixture.kind != "selection": game.state.tasks=[{"id":"fixture-task","object_id":fixture.subject_id,"status":fixture.kind,"author":"场景测试","title":"独立预制件状态验证"}]
	visual.update_world(game.snapshot(),user_id,1.0/30)
	visual.update_world(game.snapshot(),user_id,.1)
	verify()
	if DisplayServer.get_name() != "headless":
		var canvas=CanvasLayer.new();var caption=Label.new()
		caption.position=Vector2(24,22)
		caption.text="ISOLATED PREFAB / " + str(fixture.id) + "\n" + ("PASS " if result.ok else "FAIL ") + str(result.checks.size()) + " checks · controlled fixture, separate from campaign\nRun with --play for WASD / Space / Shift / E / Q input."
		caption.add_theme_font_override("font",load("res://assets/fonts/AtelierUI.tres"));caption.add_theme_font_size_override("font_size",18)
		canvas.add_child(caption);add_child(canvas)
func verify() -> void:
	var test=Game.new();check(initialize_game(test).is_empty(),"independent gameplay fixture initializes")
	var subject=str(fixture.subject_id);var kind=str(fixture.kind)
	if fixture.category == "object":
		check(visual.objects.has(subject),"authored object has its own actual scene node")
		check(visual.objects[subject].find_children("*","MeshInstance3D",true,false).size()>0,"prefab contains real mesh geometry")
		var definition=test.object_defs[subject]
		if definition.get("solid",false):check(not test.is_walkable(Vector2.ZERO),"XZ solid collider blocks the prefab center")
		check(test.command(user_id,"select",{"object_id":subject}).ok,"normal selection resolves authored object")
		if kind=="crystal":
			check(test.command(user_id,"interact",{"object_id":subject}).ok and test.state.players[user_id].crystals==2,"crystal grants authoritative reward")
		elif kind=="beacon":check(test.command(user_id,"interact",{"object_id":subject}).ok and test.state.objects[subject].activated,"beacon actually activates in isolated scene")
		elif kind=="gate":check(test.command(user_id,"interact",{"object_id":subject}).ok and test.state.objects[subject].activated,"gate opens with required beacons")
		elif kind=="supply":
			test.state.players[user_id].hp=50
			check(test.command(user_id,"interact",{"object_id":subject}).ok and test.state.players[user_id].hp==test.state.players[user_id].max_hp,"supply restores seeded injury")
		elif kind=="forge":
			test.state.players[user_id].crystals=12
			check(test.command(user_id,"upgrade",{}).ok and test.state.players[user_id].upgrades==1,"forge spends seeded budget and upgrades")
	elif fixture.category=="enemy":
		check(visual.enemy_nodes.has(subject) and visual.enemy_nodes[subject].find_children("*","MeshInstance3D",true,false).size()>0,"authored enemy has actual mesh scene")
		var before=test.state.enemies[subject].hp
		test.command(user_id,"move",{"x":-1,"z":0})
		check(test.command(user_id,"attack",{}).ok and test.state.enemies[subject].hp<before,"normal attack damages the enemy authority")
		test.command(user_id,"move",{"x":0,"z":0})
		for i in range(42):test.step(1.0/30)
		check(test.state.players[user_id].hp<100,"enemy actual telegraphed attack hurts nearby player")
	else:
		match kind:
			"selection", "editing", "testing", "delivered", "failed":
				check(is_instance_valid(visual.selection),"normal selection creates actual silhouette and bounds")
				check(visual.selection.find_children("*","MeshInstance3D",true,false).size()>24,"selection contains expanded meshes and 3D corner bounds")
				if kind!="selection":
					check(visual.task_nodes.has("fixture-task") and visual.task_nodes["fixture-task"].get_meta("status")==kind,"task state creates correct independent rendered marker")
					check(visual.task_nodes["fixture-task"].has_node("MaintenanceOrbit"),"status has physical orbit node")
			"move_and_dash":
				var start=test.state.players[user_id].x
				test.command(user_id,"move",{"x":1,"z":0})
				for i in range(3):test.step(1.0/30)
				check(test.state.players[user_id].x>start,"normal held movement changes authoritative position")
				check(test.command(user_id,"dash",{}).ok and test.state.players[user_id].stamina<100 and test.state.players[user_id].dash_until>test.state.world_time,"dash consumes stamina and grants timed invulnerability")
			"combat":
				var before=test.state.enemies[subject].hp
				test.command(user_id,"move",{"x":-1,"z":0});test.command(user_id,"attack",{});test.command(user_id,"move",{"x":0,"z":0})
				check(test.state.enemies[subject].hp<before,"normal strike damages enemy")
				for i in range(35):test.step(1.0/30)
				check(test.state.players[user_id].hp<100,"enemy telegraph resolves to actual damage")
			"death_respawn":
				test.state.players[user_id].hp=1;test.state.players[user_id].collected=7
				var downed=false;var recovered=false
				for i in range(240):
					test.step(1.0/30)
					if test.state.players[user_id].hp==0:downed=true
					elif downed:recovered=true;break
				check(downed and recovered and test.state.players[user_id].collected==7,"actual lethal hit and timed respawn preserve collected progress")
			"collection_reward", "offline_restore":
				check(test.command(user_id,"interact",{"object_id":subject}).ok,"normal nearby collection succeeds")
				check(not test.command(user_id,"interact",{"object_id":subject}).ok and test.state.players[user_id].crystals==2,"shared crystal cannot award twice")
				if kind=="offline_restore":
					var restored=Game.new();check(restored.initialize(fixture.content,test.snapshot()).is_empty(),"isolated snapshot initializes restored world")
					restored.join(user_id,"Rejoined fixture")
					check(restored.state.players[user_id].crystals==2 and restored.state.objects[subject].collected,"restore and join keep reward and consumed object")
			"beacon_progress":
				test.state.objectives.beacons=0
				check(test.command(user_id,"interact",{"object_id":subject}).ok and test.state.objectives.beacons==1,"normal interaction advances shared beacon objective")
			"upgrade_and_healing":
				test.state.players[user_id].crystals=12
				check(test.command(user_id,"upgrade",{}).ok and test.state.players[user_id].upgrades==1 and test.state.players[user_id].crystals==0,"upgrade spends exact seeded crystal budget")
				test.state.players[user_id].hp=1
				var supply=fixture.content.objects[1].id
				check(test.command(user_id,"interact",{"object_id":supply}).ok and test.state.players[user_id].hp==test.state.players[user_id].max_hp,"normal supply action heals seeded injury")
			"collision":
				check(not test.is_walkable(Vector2.ZERO),"solid object's XZ circle blocks center")
				check(test.is_walkable(Vector2(14,0)) and not test.is_walkable(Vector2(14,3)),"bridge rectangle supports travel beyond island and rejects lateral void")
				test.command(user_id,"move",{"x":-1,"z":0})
				for i in range(10):test.step(1.0/30)
				check(test.state.players[user_id].x>=float(test.object_defs[subject].get("radius",.7))+.3 and test.state.players[user_id].x<fixture.content.spawn.x,"normal movement cannot cross collider")
			"content_replacement":
				test.command(user_id,"interact",{"object_id":subject})
				var candidate=fixture.content.duplicate(true);candidate.rules.player_speed=12
				check(test.apply_content(candidate).is_empty() and test.state.players[user_id].crystals==2,"candidate swap preserves earned state")
				var before=JSON.stringify(test.snapshot());candidate.objects[0].solid="bad"
				check(not test.apply_content(candidate).is_empty() and JSON.stringify(test.snapshot())==before,"failed replacement retains exact previous authority state")
			"player_avatar":
				var actor=visual.player_nodes[user_id]
				check(actor.has_meta("animation_player"),"actual imported explorer has AnimationPlayer")
				if actor.has_meta("animation_player"):
					var animations=actor.get_meta("animation_player")
					for clip in ["Idle","Walk","Strike","Dash"]:check(animations.has_animation(clip),"rig contains "+clip+" clip")
				var skeletons=actor.find_children("*","Skeleton3D",true,false)
				check(skeletons.size()>0 and skeletons[0].get_bone_count()==16,"actual 16-bone skinned character imports")
			"model_binding":
				var node=visual.objects[subject]
				check(node.has_node("ContentModel") and node.find_children("*","MeshInstance3D",true,false).size()==50,"fresh Blender GLB binds and instantiates 50 real meshes")
				var candidate=fixture.content.duplicate(true);candidate.asset_blobs.values()[0].data_base64="YmFk"
				check(not test.apply_content(candidate).is_empty(),"corrupt immutable asset is rejected by authority")
				check(not visual.build_world(candidate).is_empty() and visual.objects[subject]==node,"corrupt GLB retains previous rendered scene instance")
	result.completed=true # Only reached after the entire verifier returns normally.
func _physics_process(delta: float) -> void:
	if not playing:return
	var direction=Vector2(Input.get_axis("ui_left","ui_right"),Input.get_axis("ui_up","ui_down"))
	if Input.is_physical_key_pressed(KEY_W):direction.y-=1
	if Input.is_physical_key_pressed(KEY_S):direction.y+=1
	if Input.is_physical_key_pressed(KEY_A):direction.x-=1
	if Input.is_physical_key_pressed(KEY_D):direction.x+=1
	direction=direction.limit_length(1)
	game.command(user_id,"move",{"x":direction.x,"z":direction.y});game.step(delta)
func _process(delta: float) -> void:
	elapsed+=delta
	if playing:visual.update_world(game.snapshot(),"",delta)
	if not capture_path.is_empty() and not capture_done and elapsed>.5:
		capture_done=true;capture.call_deferred()
	if quit_after>0 and elapsed>quit_after:get_tree().quit(0 if result.ok else 1)
func capture() -> void:
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png(capture_path)
func _unhandled_input(event: InputEvent) -> void:
	if not playing or not event is InputEventKey or not event.pressed or event.echo:return
	var action={KEY_SPACE:"attack",KEY_SHIFT:"dash",KEY_E:"interact",KEY_Q:"upgrade"}.get(event.physical_keycode,"")
	if not action.is_empty():game.command(user_id,action,{})
