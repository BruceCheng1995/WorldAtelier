extends SceneTree
func _initialize() -> void:
	call_deferred("start")
func bounds(node: Node3D) -> AABB:
	var result:=AABB()
	var initialized:=false
	for item in node.find_children("*","MeshInstance3D",true,false):
		if not item.mesh: continue
		var box: AABB=node.global_transform.affine_inverse()*item.global_transform*item.get_aabb()
		result=result.merge(box) if initialized else box
		initialized=true
	return result
func start() -> void:
	var args=OS.get_cmdline_user_args()
	var metadata: Array=JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var report: Dictionary={}
	var scene=Node3D.new()
	root.add_child(scene)
	var env=WorldEnvironment.new()
	env.environment=Environment.new()
	env.environment.background_mode=Environment.BG_COLOR
	env.environment.background_color=Color("e8ede5")
	env.environment.ambient_light_source=Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color=Color.WHITE
	env.environment.ambient_light_energy=0.7
	scene.add_child(env)
	var light=DirectionalLight3D.new()
	light.rotation_degrees=Vector3(-40,-30,0)
	light.light_energy=1.3
	scene.add_child(light)
	var camera=Camera3D.new()
	scene.add_child(camera)
	camera.fov=38
	camera.current=true
	for meta in metadata:
		if meta.dimension!="3d": continue
		var model=(load("res://"+meta.id+"/model.glb") as PackedScene).instantiate() as Node3D
		scene.add_child(model)
		var player=model.find_child("AnimationPlayer",true,false) as AnimationPlayer
		if player:
			var idle: String="Idle" if player.has_animation("Idle") else "idle"
			if player.has_animation(idle):
				player.play(idle)
				player.seek(0.3,true)
		var box=bounds(model)
		var center:=box.get_center()
		var radius: float=maxf(box.size.x*0.7,maxf(box.size.y,box.size.z*0.7))
		camera.position=center+Vector3(0.8,0.4,1.3).normalized()*radius*1.95
		camera.look_at(center)
		report[meta.id]={"position":[box.position.x,box.position.y,box.position.z],"size":[box.size.x,box.size.y,box.size.z],"animations":Array(player.get_animation_list()) if player else []}
		for i in range(12): await process_frame
		if DisplayServer.get_name()!="headless":
			await RenderingServer.frame_post_draw
			var output: String=args[1]+"/"+meta.id+"/cover.png"
			root.get_texture().get_image().save_png(output)
		model.queue_free()
		await process_frame
	var file=FileAccess.open(args[2],FileAccess.WRITE)
	file.store_string(JSON.stringify(report,"\t"))
	print("CATALOG_PREVIEWS_OK ",report.size())
	quit()
