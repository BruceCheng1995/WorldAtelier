extends SceneTree
var character: Node
func _initialize() -> void:
	call_deferred("start")
func start() -> void:
	var args=OS.get_cmdline_user_args()
	var asset_id: String=args[0]
	var scene=Node3D.new()
	root.add_child(scene)
	var packed=load("res://"+asset_id+"/character.tscn") as PackedScene
	if not packed:
		push_error("Character scene failed to load")
		quit(1)
		return
	character=packed.instantiate()
	character.keyboard_enabled=false
	character.camera_enabled=false
	scene.add_child(character)
	character.set_physics_process(false)
	var environment=WorldEnvironment.new()
	environment.environment=Environment.new()
	environment.environment.background_mode=Environment.BG_COLOR
	environment.environment.background_color=Color("e8ede5")
	environment.environment.ambient_light_source=Environment.AMBIENT_SOURCE_COLOR
	environment.environment.ambient_light_color=Color.WHITE
	environment.environment.ambient_light_energy=0.65
	scene.add_child(environment)
	var light=DirectionalLight3D.new()
	light.rotation_degrees=Vector3(-40,-30,0)
	light.light_energy=1.3
	scene.add_child(light)
	var camera=Camera3D.new()
	scene.add_child(camera)
	camera.position=Vector3(3,1.8,4)
	camera.look_at(Vector3(0,1.0,0))
	camera.fov=33
	camera.current=true
	var player: AnimationPlayer=character.animation_player
	print("ANIMATIONS ",player.get_animation_list())
	player.play(args[2] if args.size()>2 else "idle")
	player.seek(0.5,true)
	for i in range(25):await process_frame
	if DisplayServer.get_name()!="headless":
		await RenderingServer.frame_post_draw
		root.get_texture().get_image().save_png(args[1])
	print("PREVIEW_OK ",asset_id)
	quit()
