extends SceneTree

var checks: Array = []
var player: Node
var dimension := ""
var output := ""

func _initialize() -> void:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--dimension="): dimension = argument.trim_prefix("--dimension=")
		if argument.begins_with("--out="): output = argument.trim_prefix("--out=")
	call_deferred("run")

func check(value: bool, description: String) -> void:
	checks.append({"ok":value,"name":description})
	if not value: push_error("MARKET_CHECK_FAILED " + description)

func frames(count: int) -> void:
	for index in range(count): await physics_frame

func run() -> void:
	check(DisplayServer.get_name() == "headless", "headless display")
	check(AudioServer.get_driver_name() == "Dummy", "silent audio")
	var packed = load("res://character.tscn") as PackedScene
	check(packed != null, "real PackedScene loads")
	if packed == null:
		finish()
		return
	player = packed.instantiate()
	player.keyboard_enabled = false
	player.camera_enabled = dimension == "3d"
	if dimension == "2d":
		var floor_body := StaticBody2D.new()
		var shape := CollisionShape2D.new()
		var rectangle := RectangleShape2D.new()
		rectangle.size = Vector2(20000,20)
		shape.shape = rectangle
		floor_body.position = Vector2(0,100)
		floor_body.add_child(shape)
		root.add_child(floor_body)
	else:
		var floor_body := StaticBody3D.new()
		var shape := CollisionShape3D.new()
		var rectangle := BoxShape3D.new()
		rectangle.size = Vector3(200,1,200)
		shape.shape = rectangle
		floor_body.position = Vector3(0,-0.5,0)
		floor_body.add_child(shape)
		root.add_child(floor_body)
	root.add_child(player)
	await frames(45)
	check(player.is_on_floor(), "character settles on actual collision floor")
	check(player.animation_state == "idle", "initial idle state")
	for suffix in ["left","right","up","down","jump","sprint"]:
		check(InputMap.has_action("wa_character_"+suffix), "input action " + suffix)
	if dimension == "2d":
		check(player.sprite.sprite_frames.get_frame_count("walk") >= 8, "eight genuine walk frames")
		check(not player.get_node("Camera2D").enabled, "optional 2D camera stays disabled")
	else:
		var arm: SpringArm3D = player.get_node("CameraRig/SpringArm3D")
		check(arm.get_node("Camera3D").current, "third person camera is active")
		check(arm.get_hit_length() > arm.spring_length * 0.9, "spring arm excludes its own collision capsule")
		check(player.animation_player != null, "real imported AnimationPlayer is bound")
		if player.animation_player:
			for name in ["idle","run","jump"]:
				check(player.animation_player.has_animation(name), "real skeleton clip " + name)
				if player.animation_player.has_animation(name): check(player.animation_player.get_animation(name).get_track_count() > 10, "bone animation tracks " + name)
	var initial_x: float = player.position.x
	player.set_move_input(Vector2.RIGHT)
	await frames(30)
	check(player.position.x > initial_x + (30 if dimension == "2d" else 1), "external movement changes actual position")
	check(player.animation_state == ("walk" if dimension == "2d" else "run"), "movement chooses actual locomotion animation")
	var walk_speed: float = player.velocity.x
	if dimension == "2d":
		var animation_frames: Dictionary = {}
		for index in range(15):
			await physics_frame
			animation_frames[player.sprite.frame] = true
		check(animation_frames.size() > 1, "AnimatedSprite2D advances real frames")
	else:
		if player.animation_player:
			check(player.animation_player.current_animation == "run", "AnimationPlayer runs movement clip")
			var start: float = player.animation_player.current_animation_position
			var skeletons: Array[Node] = player.find_children("*", "Skeleton3D", true, false)
			check(not skeletons.is_empty(), "real skeleton is present")
			var before_poses: Array = []
			if not skeletons.is_empty():
				for bone in range(skeletons[0].get_bone_count()): before_poses.append(skeletons[0].get_bone_pose(bone))
			await frames(5)
			var changed_bones := 0
			if not skeletons.is_empty():
				for bone in range(before_poses.size()):
					if not before_poses[bone].is_equal_approx(skeletons[0].get_bone_pose(bone)): changed_bones += 1
			check(changed_bones > 3, "locomotion changes real skeleton bone poses")
			check(absf(player.animation_player.current_animation_position-start)>0.001, "skeleton animation time progresses")
	player.set_move_input(Vector2.RIGHT,false,true)
	await frames(25)
	check(player.velocity.x > walk_speed * 1.2, "sprint increases actual movement speed")
	player.set_move_input(Vector2.ZERO)
	await frames(35)
	check(absf(player.velocity.x)<0.1, "release decelerates to rest")
	check(player.animation_state == "idle", "rest returns to idle animation")
	var grounded_y: float = player.position.y
	player.set_move_input(Vector2.ZERO,true)
	await frames(5)
	check(not player.is_on_floor(), "jump leaves collision floor")
	check(player.position.y < grounded_y if dimension == "2d" else player.position.y > grounded_y, "jump changes height in correct axis direction")
	check(player.animation_state == "jump", "jump selects jump animation")
	await frames(110)
	check(player.is_on_floor(), "jump returns to actual collision floor")
	check(player.animation_state == "idle", "landing returns to idle")
	player.keyboard_enabled = true
	initial_x = player.position.x
	Input.action_press("wa_character_right")
	Input.flush_buffered_events()
	await frames(25)
	Input.action_release("wa_character_right")
	Input.flush_buffered_events()
	check(player.position.x > initial_x + (20 if dimension == "2d" else 0.5), "registered keyboard action drives actual movement")
	await frames(35)
	check(player.animation_state == "idle", "keyboard release returns to idle")
	if dimension == "2d":
		player.keyboard_enabled = false
		player.movement_mode = 1
		player.motion_mode = CharacterBody2D.MOTION_MODE_FLOATING
		player.position = Vector2(0,-200)
		var top_y: float = player.position.y
		player.set_move_input(Vector2.UP)
		await frames(20)
		check(player.position.y < top_y-20, "top down mode accepts vertical movement")
	finish()

func finish() -> void:
	var result := {"dimension":dimension,"checks":checks,"ok":checks.all(func(row):return row.ok)}
	var file := FileAccess.open(output,FileAccess.WRITE)
	file.store_string(JSON.stringify(result,"  "))
	print("MARKET_CONTROLLER_RESULT ",JSON.stringify(result))
	quit(0 if result.ok else 1)
