extends SceneTree
var checks: Array=[]
var samples: Array=[]
var options={}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		var pair=arg.trim_prefix("--").split("=",true,1)
		if pair.size()==2:options[pair[0]]=pair[1]
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok:print("OVERLAY_LABEL_FAILED "+detail)

func run() -> void:
	create_timer(15).timeout.connect(func():print("OVERLAY_LABEL_TIMEOUT");quit(2))
	var view=SubViewport.new()
	view.own_world_3d=true
	view.render_target_update_mode=SubViewport.UPDATE_DISABLED
	root.add_child(view)
	var host=load("res://main.gd").new()
	view.add_child(host)
	host.set_process(false)
	host.set_physics_process(false)
	host.world_client.set_process(false)
	var overlay=host.collaboration_overlay
	overlay.set_process(false)
	var camera: Camera3D=host.camera
	camera.fov=55
	var bounds=AABB(Vector3(-.5,-.5,-.5),Vector3.ONE)
	var label: Label3D=overlay.label(overlay,"开发中 · 协作者正在开发一项名称较长的真实对象任务",Vector3(0,1.1,0),Color.WHITE,bounds)
	var label_id=label.get_instance_id()
	var original_pixel_size=label.pixel_size
	for width in [436,732]:
		for ratio in [1.0,2.0]:
			view.size=Vector2i(int(width*ratio),int(415*ratio))
			for projection in [Camera3D.PROJECTION_PERSPECTIVE,Camera3D.PROJECTION_ORTHOGONAL]:
				camera.projection=projection
				camera.size=6
				for distance in [1.2,5.0,30.0]:
					camera.position=Vector3(0,0,distance)
					camera.look_at(Vector3.ZERO)
					overlay.update_label(label,camera,ratio)
					await process_frame
					await process_frame
					var at=label.global_position
					var nominal_world=label.font_size*label.pixel_size*label.scale.y
					var css_font=camera.unproject_position(at).distance_to(camera.unproject_position(at+camera.global_basis.y*nominal_world))/ratio
					# Label3D's billboard render-culling AABB is deliberately a cube.
					# Its generated text triangle mesh retains the shaped text rect.
					var faces=label.generate_triangle_mesh().get_faces()
					var box=AABB(faces[0],Vector3.ZERO)
					for point in faces:box=box.expand(point)
					var half_width=box.size.x*label.scale.x*.5
					var half_height=box.size.y*label.scale.y*.5
					var left=camera.unproject_position(at-camera.global_basis.x*half_width)
					var right=camera.unproject_position(at+camera.global_basis.x*half_width)
					var top=camera.unproject_position(at+camera.global_basis.y*half_height)
					var bottom=camera.unproject_position(at-camera.global_basis.y*half_height)
					var projected_width=left.distance_to(right)/ratio
					var in_view=left.x>=7*ratio and right.x<=(width-7)*ratio and top.y>=7*ratio and bottom.y<=(415-7)*ratio
					var good=label.visible and absf(css_font-14)<.03 and projected_width<=240.1 and in_view
					var key=str(width)+"px DPR"+str(ratio)+" projection"+str(projection)+" depth"+str(distance)
					check(good,"font 14 CSS px, width <=240, shaped text rectangle stays inside viewport: "+key)
					samples.append({"case":key,"visible":label.visible,"css_font_size":css_font,"glyph_css_width":projected_width,"glyph_css_height":top.distance_to(bottom)/ratio,"in_view":in_view,"text":label.text})
	check(label.get_instance_id()==label_id and label.pixel_size==original_pixel_size,"near/far updates reuse Label3D and fixed glyph pixel_size rather than recreating nodes")
	check(label.get_meta("full_text")=="开发中 · 协作者正在开发一项名称较长的真实对象任务" and label.text.ends_with("…"),"visible long labels use ellipsis while the original collaborator/task text remains intact")
	camera.projection=Camera3D.PROJECTION_PERSPECTIVE
	camera.position=Vector3(0,0,5)
	label.set_meta("anchor",Vector3(200,1,0))
	label.set_meta("owner_bounds",AABB(Vector3(199.5,-.5,-.5),Vector3.ONE))
	overlay.update_label(label,camera,2)
	check(not label.visible,"fully offscreen owner hides its label instead of accumulating labels at viewport edges")
	label.set_meta("anchor",Vector3(0,0,8))
	label.set_meta("owner_bounds",AABB(Vector3(-.5,-.5,7.5),Vector3.ONE))
	overlay.update_label(label,camera,2)
	check(not label.visible,"label behind camera is hidden")
	label.set_meta("anchor",Vector3(0,0,4.6))
	label.set_meta("owner_bounds",AABB(Vector3(-.5,-.5,4.1),Vector3.ONE))
	overlay.update_label(label,camera,2)
	check(not label.visible,"very near label is hidden before crossing the camera clipping plane")
	var okay=true
	for item in checks:okay=okay and item.ok
	var report={"completed":true,"ok":okay,"checks":checks,"samples":samples,"scope":"actual Godot camera projections, Label3D shaped text triangle mesh and visibility, headless only; no GPU/screenshot claim"}
	if options.has("report"):
		var file=FileAccess.open(options.report,FileAccess.WRITE)
		file.store_string(JSON.stringify(report,"\t"))
	print("OVERLAY_LABEL_COMPLETE "+JSON.stringify(report))
	quit(0 if okay else 1)
