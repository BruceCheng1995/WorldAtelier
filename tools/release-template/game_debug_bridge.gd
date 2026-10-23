extends Node
signal packet_emitted(packet: Dictionary)
## Optional editor transport. It observes the same game and pauses only this
## isolated runtime; it never loads editor preview nodes or writes source data.
const Factory = preload("res://scene_factory.gd")
const Hierarchy = preload("res://hierarchy_scene.gd")
const PlayContext = preload("res://play_context_bridge.gd")
var runtime: Node
var embedded = false
var started = false
var inspecting = false
var nonce = ""
var bridge
var callback
var world_id = ""
var epoch = 1
var request_id = ""
var seq = 1
var document_id = ""
var selected_id = ""
var inspection_ui_visible = false
var outbound_log: Array = []
var camera: Camera3D
var game_camera: Camera3D
var camera2d: Camera2D
var game_camera2d: Camera2D
var inspecting_2d = false
var saved_canvas_transform = Transform2D.IDENTITY
var camera_target = Vector3.ZERO
var camera_yaw = 0.0
var camera_pitch = 0.0
var camera_distance = 10.0
var camera_view = "perspective"
var frozen_nodes: Array = []
var old_tree_paused = false
var game_mouse_mode = Input.MOUSE_MODE_VISIBLE
var mode_request_failed = false
var mode_error = ""
var fault_notice: CanvasLayer
var fault_panel: PanelContainer
var prefab_test: Node
var play_context: Node
var capture_busy = false

func setup(value: Node) -> void:
	runtime = value
	process_mode = Node.PROCESS_MODE_ALWAYS
	camera = Camera3D.new()
	camera.name = "InspectionCamera"
	camera.far = 3000
	add_child(camera)
	camera.current = false
	camera2d = Camera2D.new()
	camera2d.name = "InspectionCamera2D"
	camera2d.enabled = false
	add_child(camera2d)
	if OS.has_feature("web"):
		var query = JSON.parse_string(str(JavaScriptBridge.eval("JSON.stringify(Object.fromEntries(new URLSearchParams(window.location.search)))")))
		nonce = str(query.get("nonce",""))
		embedded = query.get("launch")=="editor" and query.get("wa_embedded")=="1" and nonce.length()>=16 and bool(JavaScriptBridge.eval("window.parent !== window"))
		if embedded:
			# Validate native Window identity before handing JSON into Godot. The
			# nonce then binds this iframe generation, never a user credential.
			JavaScriptBridge.eval("window.__atelierGameBridge={listen:function(cb){this.handler=function(e){if(e.origin===location.origin&&e.source===parent)cb(JSON.stringify(e.data));};addEventListener('message',this.handler);},send:function(s){parent.postMessage(JSON.parse(s),location.origin);},dispose:function(){removeEventListener('message',this.handler);}}")
			bridge = JavaScriptBridge.get_interface("__atelierGameBridge")
			callback = JavaScriptBridge.create_callback(_browser_message)
			bridge.listen(callback)
	play_context = PlayContext.new()
	add_child(play_context)
	play_context.setup(runtime, self)

func bootstrap_ready() -> void:
	var capabilities = ["independent-editor-play","canonical-game-runtime","local-inspection","readonly-inspection-ui","orbit","pan","fly","fit","focus","camera_presets","play-context-1","capture-frame-1"]
	var test_resources = runtime.release.get("prefab_test_resources", {})
	if not runtime.release.has("prefab_test") and test_resources is Dictionary and test_resources.get(runtime.launch_entry) is Dictionary:
		runtime.release.prefab_test = test_resources[runtime.launch_entry].duplicate(true)
	if runtime.release.get("prefab_test") is Dictionary and runtime.shared == null:
		# Dynamic path keeps formal releases independent of this development
		# script. The project assembler includes it only for prefab-test builds.
		var script_path = get_script().resource_path.get_base_dir().path_join("prefab_test_bridge.gd")
		if ResourceLoader.exists(script_path):
			var script = load(script_path)
			if script != null:
				prefab_test = script.new()
				add_child(prefab_test)
				prefab_test.setup(runtime, self)
				capabilities.append("prefab-test")
	emit({"type":"ready","capabilities":capabilities,"runtime_source_hash":runtime.release.get("runtime_source_hash",""),"source_revision":runtime.release.get("revision","")})

func _browser_message(args: Array) -> void:
	if args.is_empty(): return
	var data = JSON.parse_string(str(args[0]))
	if data is Dictionary: receive(data)

func receive(packet: Dictionary) -> void:
	if not embedded or packet.get("source")!="world-atelier-workspace" or packet.get("nonce")!=nonce: return
	var type = str(packet.get("type",""))
	if type == "context_request":
		if is_instance_valid(play_context): play_context.receive(packet)
		return
	if type == "capture_frame":
		capture_frame(packet)
		return
	if runtime.shared != null and runtime.shared.is_client:
		if type == "native_shared":
			runtime.shared.receive(packet.get("packet",{}))
			return
		if type == "world" and packet.get("action") in ["mode","inspection_ui"]:
			runtime.shared.receive(packet)
			return
	if type=="start":
		if started or runtime.loading or str(packet.get("world_id","")).is_empty(): return
		if packet.get("scene_revision")!=runtime.release.get("revision"): return
		if not packet.get("epoch") is float and not packet.get("epoch") is int: return
		world_id = str(packet.world_id)
		epoch = int(packet.epoch)
		request_id = str(packet.get("request_id",""))
		seq = int(packet.get("seq",1))
		document_id = str(packet.get("document_id",""))
		selected_id = str(packet.get("selected_id",""))
		started = true
		if runtime.shared == null: runtime.begin.call_deferred()
		return
	if not started or not runtime.running: return
	if type == "prefab_test":
		if is_instance_valid(prefab_test): prefab_test.receive(packet)
		return
	if packet.has("scene_generation") and packet.scene_generation!=runtime.generation: return
	if packet.has("document_id") and packet.document_id!=document_id: return
	if type=="world":
		if packet.get("world_id")!=world_id or packet.get("epoch")!=epoch or packet.get("scene_revision")!=runtime.simulation.scene_revision: return
		match packet.get("action"):
			"mode":
				request_id = str(packet.get("request_id",""))
				mode_request_failed = false
				mode_error = ""
				if packet.get("mode") in ["inspect","inspecting"]: enter_inspection()
				elif packet.get("mode") in ["play","playing"]:
					if not restore_inspection():
						mode_request_failed = true
						mode_error = "本次运行发生错误，请重新开始后继续。"
				runtime.publish_telemetry()
			"inspection_ui":
				if inspecting and packet.get("visible") is bool:
					inspection_ui_visible = packet.visible
					show_ui()
					runtime.publish_telemetry()
			"leave":
				restore_inspection(true)
				runtime.running = false
				runtime.simulation.active = false
	elif type=="camera" and inspecting:
		if packet.get("seq")!=seq or packet.get("document_id",document_id)!=document_id: return
		camera_command(packet)
	elif type=="editor" and inspecting:
		if packet.get("seq")!=seq: return
		if packet.has("selected_id"): select_object(str(packet.selected_id))
	elif type=="select" and inspecting:
		if packet.get("seq")!=seq: return
		select_object(str(packet.get("id","")))

func scene_loaded(document: Dictionary) -> void:
	document_id = "%s/%s/%s"%[runtime.release.get("project_id",""),runtime.release.get("branch_id",""),runtime.current_scene_id]
	var objects: Array = []
	var count = 0
	for id in runtime.projection.objects:
		var observation = observe(id)
		var stats = runtime.projection.world_bounds(runtime.projection.objects[id]) if runtime.native_mode else Hierarchy.world_bounds(runtime.projection.objects[id],true)
		observation.mesh_count = stats.mesh_count
		count += stats.mesh_count
		objects.append(observation)
	emit({"type":"loaded","seq":seq,"document_id":document_id,"resource_id":runtime.current_scene_id,"source_revision":runtime.release.revision,"scene_revision":runtime.simulation.scene_revision,"selected_id":selected_id,"mesh_count":count,"objects":objects,"assets":runtime.projection.asset_hashes,"runtime_source_hash":runtime.release.get("runtime_source_hash",""),"hierarchy_pack_hash":document.get("hierarchy_pack",{}).get("pack_hash","")})
	emit_state()
	emit_camera()
	if is_instance_valid(prefab_test): prefab_test.scene_loaded()

func emit(packet: Dictionary) -> void:
	packet.merge({"source":"world-atelier-game","nonce":nonce,"scene_generation":runtime.generation,"content_key":runtime.release.get("content_key",""),"canonical_identity":runtime.release.get("canonical_identity",""),"game_identity":runtime.release.get("game_identity",{})},true)
	var logged = packet.duplicate(true)
	if logged.has("data_url"):
		logged["image_bytes_omitted"] = str(logged.data_url).length()
		logged.erase("data_url")
	outbound_log.append(logged)
	while outbound_log.size()>100: outbound_log.pop_front()
	packet_emitted.emit(packet)
	if bridge: bridge.send(JSON.stringify(packet))

func observe(id: String) -> Dictionary:
	if runtime.native_mode: return runtime.projection.observe(id)
	var node: Node3D = runtime.projection.objects[id]
	return Hierarchy.observation(id,node,runtime.projection.definitions[id])

func capture_frame(packet: Dictionary) -> void:
	if not started or not runtime.running or capture_busy: return
	if packet.get("seq") != seq or packet.get("document_id") != document_id or packet.get("scene_generation") != runtime.generation: return
	var capture_request = str(packet.get("request_id", ""))
	if capture_request.is_empty() or capture_request.length() > 180: return
	var generation = runtime.generation
	var fixed_document = document_id
	var fixed_seq = seq
	if DisplayServer.get_name() == "headless":
		emit({"type":"captured_frame","request_id":capture_request,"error":"Headless runtime has no rendered frame","seq":fixed_seq,"document_id":fixed_document,"source_revision":runtime.release.revision})
		return
	capture_busy = true
	await RenderingServer.frame_post_draw
	if not is_instance_valid(runtime) or generation != runtime.generation or fixed_document != document_id or fixed_seq != seq:
		capture_busy = false
		return
	var image = get_viewport().get_texture().get_image()
	if image != null and not image.is_empty():
		var longest = maxi(image.get_width(), image.get_height())
		if longest > 1920:
			var ratio = 1920.0/float(longest)
			image.resize(maxi(1,roundi(image.get_width()*ratio)),maxi(1,roundi(image.get_height()*ratio)),Image.INTERPOLATE_BILINEAR)
		var bytes = image.save_png_to_buffer()
		if bytes.size() <= 8*1024*1024:
			emit({"type":"captured_frame","request_id":capture_request,"data_url":"data:image/png;base64,"+Marshalls.raw_to_base64(bytes),"width":image.get_width(),"height":image.get_height(),"seq":fixed_seq,"document_id":fixed_document,"source_revision":runtime.release.revision})
		else: emit({"type":"captured_frame","request_id":capture_request,"error":"Rendered frame exceeds capture budget","seq":fixed_seq,"document_id":fixed_document,"source_revision":runtime.release.revision})
	capture_busy = false

func emit_state() -> void:
	if runtime.shared != null and runtime.shared.is_client:
		runtime.shared.emit_state()
		return
	if not started: return
	var state: Dictionary = runtime.world_client.latest
	var fault: Dictionary = runtime.runtime_fault.duplicate(true)
	if fault.is_empty() and is_instance_valid(runtime.simulation): fault = runtime.simulation.last_fault
	if fault.is_empty() and is_instance_valid(runtime.projection): fault = runtime.projection.behaviors.fault
	var packet = {"type":"world_state","world_id":world_id,"epoch":epoch,"scene_revision":state.get("scene_revision",runtime.release.get("revision","")),"source_revision":runtime.release.get("revision",""),"resource_id":runtime.current_scene_id,"document_id":document_id,"seq":seq,"mode":"inspecting" if inspecting else "playing","request_id":request_id,"applied_sequence":state.get("sequence",0),"latest_sequence":state.get("sequence",0),"latest_revision":state.get("scene_revision",""),"control_ready":false,"runtime_ready":runtime.running and not inspecting and not runtime.faulted,"error":runtime.failure,"runtime_fault":fault,"session_kind":"local_preview","inspection_ui_visible":inspection_ui_visible if inspecting else true,"tick":state.get("tick",0),"latest_tick":state.get("tick",0),"object_states":state.get("object_states",{}),"runtime_source_hash":runtime.release.get("runtime_source_hash","")}
	packet.scene_name = runtime.release.get("scenes",{}).get(runtime.current_scene_id,{}).get("name",runtime.release.get("scenes",{}).get(runtime.current_scene_id,{}).get("title",runtime.current_scene_id))
	packet.requires_restart = runtime.faulted
	packet.mode_request_failed = mode_request_failed
	packet.mode_error = mode_error
	if inspecting:
		packet.frozen_tick = state.get("tick",0)
		packet.frozen_revision = state.get("scene_revision","")
		packet.frozen_sequence = state.get("sequence",0)
		packet.input_stopped = true
		packet.inspection_objects = []
		for id in runtime.projection.objects: packet.inspection_objects.append(observe(id))
		packet.frozen = {"sequence":state.get("sequence",0),"tick":state.get("tick",0),"scene_revision":state.get("scene_revision",""),"asset_hashes":runtime.projection.asset_hashes,"rendered_players":runtime.projection.rendered_players()}
	emit(packet)

func enter_inspection() -> void:
	if inspecting or not runtime.running: return
	if runtime.shared == null or not runtime.shared.is_client: runtime.world_client.latest = runtime.simulation.snapshot()
	game_mouse_mode = Input.mouse_mode
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	game_camera = get_viewport().get_camera_3d()
	if is_instance_valid(game_camera):
		camera.global_transform = game_camera.global_transform
		# Camera-local rendering overrides are part of the observed frame, not
		# just its pose. Keep the frozen game's exact resources read-only: using
		# the host WorldEnvironment would change background, tonemapping and
		# exposure as soon as the inspection camera becomes current.
		for property in ["keep_aspect","cull_mask","h_offset","v_offset","doppler_tracking","projection","fov","size","frustum_offset","near","far","environment","attributes","compositor"]:
			camera.set(property,game_camera.get(property))
		camera.reset_physics_interpolation()
	var back = camera.global_basis.z.normalized()
	camera_target = camera.global_position-back*camera_distance
	camera_yaw = atan2(back.x,back.z)
	camera_pitch = asin(clampf(back.y,-1,1))
	camera_view = "perspective"
	runtime.freeze_gameplay(true)
	inspecting_2d = runtime.native_mode and not runtime._contains_3d(runtime.game_scene)
	if inspecting_2d:
		saved_canvas_transform = get_viewport().get_canvas_transform()
		game_camera2d = get_viewport().get_camera_2d()
		if is_instance_valid(game_camera2d):
			camera2d.position = game_camera2d.get_screen_center_position()
			camera2d.zoom = game_camera2d.zoom
			camera2d.rotation = 0.0 if game_camera2d.ignore_rotation else game_camera2d.global_rotation
			camera2d.ignore_rotation = game_camera2d.ignore_rotation
			game_camera2d.enabled = false
		else:
			camera2d.position = get_viewport().get_canvas_transform().affine_inverse() * (get_viewport().get_visible_rect().size * .5)
			camera2d.zoom = Vector2.ONE
			camera2d.rotation = 0
		camera2d.enabled = true
		camera2d.make_current()
	frozen_nodes.clear()
	var nodes: Array = [runtime.game_scene]
	nodes.append_array(runtime.game_scene.find_children("*","",true,false))
	if runtime.native_mode:
		# Native games may keep gameplay in authored Autoloads, including nodes
		# explicitly set to ALWAYS. Freeze those too; canonical GameRuntime and
		# its inspection/transport subtree are the only host exception.
		for authored_root in get_tree().root.get_children():
			if authored_root == runtime or authored_root == runtime.game_scene: continue
			nodes.append(authored_root)
			nodes.append_array(authored_root.find_children("*","",true,false))
	for node in nodes:
		var record = {"node":node,"process_mode":node.process_mode}
		if node is Control or (not runtime.native_mode and (node is CanvasLayer or node is CanvasItem)) or (node is CanvasLayer and node.get_meta("wa_game_ui", false)): record.visible = node.visible
		if node is Control:
			record.mouse_filter = node.mouse_filter
			record.focus_mode = node.focus_mode
			node.release_focus()
			node.mouse_filter = Control.MOUSE_FILTER_IGNORE
			node.focus_mode = Control.FOCUS_NONE
		if node is GPUParticles3D or node is CPUParticles3D or node is GPUParticles2D or node is CPUParticles2D:
			record.speed_scale = node.speed_scale
			node.speed_scale = 0
		if node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D:
			record.stream_paused = node.stream_paused
			node.stream_paused = true
		frozen_nodes.append(record)
		node.process_mode = Node.PROCESS_MODE_DISABLED
	old_tree_paused = get_tree().paused
	if runtime.shared == null or not runtime.shared.is_client: get_tree().paused = true
	inspecting = true
	inspection_ui_visible = false
	show_ui()
	if not inspecting_2d: camera.make_current()
	emit_camera()

func show_ui() -> void:
	for record in frozen_nodes:
		if is_instance_valid(record.node) and record.has("visible"): record.node.visible = record.visible and inspection_ui_visible

func restore_inspection(force: bool = false) -> bool:
	if runtime.faulted and not force: return false
	if is_instance_valid(prefab_test): prefab_test.before_resume()
	if not inspecting: return true
	for record in frozen_nodes:
		var node = record.node
		if not is_instance_valid(node): continue
		node.process_mode = record.process_mode
		for key in ["visible","mouse_filter","focus_mode","speed_scale","stream_paused"]:
			if record.has(key): node.set(key,record[key])
	frozen_nodes.clear()
	get_tree().paused = old_tree_paused
	runtime.freeze_gameplay(false)
	if inspecting_2d:
		camera2d.enabled = false
		if is_instance_valid(game_camera2d):
			game_camera2d.enabled = true
			game_camera2d.make_current()
			game_camera2d.force_update_scroll()
		else:
			get_viewport().canvas_transform = saved_canvas_transform
		game_camera2d = null
	inspecting_2d = false
	inspecting = false
	Input.mouse_mode = game_mouse_mode
	if is_instance_valid(game_camera): game_camera.make_current()
	game_camera = null
	return true

func clear_fault_notice() -> void:
	mode_request_failed = false
	mode_error = ""
	if is_instance_valid(fault_notice):
		remove_child(fault_notice)
		fault_notice.queue_free()
	fault_notice = null
	fault_panel = null

func show_fault_notice(message: String) -> void:
	if embedded: return
	clear_fault_notice()
	# Standalone has no workbench toolbar. Keep its recovery affordance outside
	# the frozen game tree, so the same retained scene can be restarted.
	fault_notice = CanvasLayer.new()
	fault_notice.layer = 100
	add_child(fault_notice)
	fault_panel = PanelContainer.new()
	fault_panel.position = Vector2(16,16)
	fault_panel.size = Vector2(560,100)
	fault_notice.add_child(fault_panel)
	var stack = VBoxContainer.new()
	fault_panel.add_child(stack)
	var label = Label.new()
	label.text = "运行已暂停，可检查当前场景。\n"+message.left(200)
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.custom_minimum_size.x = 540
	stack.add_child(label)
	var restart = Button.new()
	restart.text = "重新开始"
	restart.pressed.connect(func(): runtime.open_scene(runtime.current_scene_id))
	stack.add_child(restart)

func _process(delta: float) -> void:
	if not inspecting: return
	if inspecting_2d: return
	var move = Vector3.ZERO
	if Input.is_mouse_button_pressed(MOUSE_BUTTON_RIGHT):
		move.x = float(Input.is_physical_key_pressed(KEY_D))-float(Input.is_physical_key_pressed(KEY_A))
		move.z = float(Input.is_physical_key_pressed(KEY_S))-float(Input.is_physical_key_pressed(KEY_W))
		move.y = float(Input.is_physical_key_pressed(KEY_E))-float(Input.is_physical_key_pressed(KEY_Q))
	if move.length_squared()>0:
		camera_target += (camera.global_basis*move.normalized())*delta*maxf(2,camera_distance*.6)
		update_camera()
		emit_camera()

func _input(event: InputEvent) -> void:
	if not inspecting: return
	if is_instance_valid(fault_panel) and event is InputEventMouse and fault_panel.get_global_rect().has_point(event.position): return
	if inspecting_2d:
		_inspection_input_2d(event)
		return
	if event is InputEventMouseMotion:
		if event.button_mask&MOUSE_BUTTON_MASK_RIGHT:
			camera_yaw -= event.relative.x*.004
			camera_pitch = clampf(camera_pitch+event.relative.y*.004,-1.55,1.55)
			camera_view = "perspective"
		elif event.button_mask&MOUSE_BUTTON_MASK_MIDDLE:
			var size = get_viewport().get_visible_rect().size
			var scale = (camera.size if camera.projection==Camera3D.PROJECTION_ORTHOGONAL else camera_distance)*2/maxf(1,size.y)
			camera_target += (-camera.global_basis.x*event.relative.x+camera.global_basis.y*event.relative.y)*scale
		else: return
		update_camera()
		emit_camera()
	elif event is InputEventMouseButton and event.pressed:
		if event.button_index in [MOUSE_BUTTON_WHEEL_UP,MOUSE_BUTTON_WHEEL_DOWN]:
			var factor = .85 if event.button_index==MOUSE_BUTTON_WHEEL_UP else 1/.85
			camera_distance = clampf(camera_distance*factor,.1,15000)
			camera.size = clampf(camera.size*factor,.1,18000)
			update_camera()
			emit_camera()
		elif event.button_index==MOUSE_BUTTON_LEFT: select_object(pick(event.position))
	get_viewport().set_input_as_handled()

func update_camera() -> void:
	var back = Vector3(sin(camera_yaw)*cos(camera_pitch),sin(camera_pitch),cos(camera_yaw)*cos(camera_pitch))
	if camera_view=="front": back = Vector3.BACK
	elif camera_view=="right": back = Vector3.RIGHT
	elif camera_view=="top": back = Vector3.UP
	camera.global_position = camera_target+back*camera_distance
	camera.look_at(camera_target,Vector3.FORWARD if absf(back.y)>.999 else Vector3.UP)

func camera_command(packet: Dictionary) -> void:
	if inspecting_2d:
		_camera_command_2d(packet)
		return
	var action = packet.get("action","")
	if action is Dictionary: action = action.get("view",action.get("action",""))
	if action in ["fit","focus","front","top","right","perspective"]:
		if action not in ["fit","focus"]:
			camera_view = action
			camera.projection = Camera3D.PROJECTION_PERSPECTIVE if action=="perspective" else Camera3D.PROJECTION_ORTHOGONAL
		var bounds = AABB(Vector3(-2,0,-2),Vector3(4,3,4))
		var first = true
		for id in runtime.projection.objects:
			if not runtime.projection.objects[id] is Node3D: continue
			if action=="focus" and runtime.projection.objects.has(selected_id) and id!=selected_id: continue
			var box = object_bounds(id)
			bounds = box if first else bounds.merge(box)
			first = false
		camera_target = bounds.get_center()
		var radius = maxf(.15,bounds.size.length()*.5)
		var size = get_viewport().get_visible_rect().size
		var aspect = maxf(.05,size.x/maxf(1,size.y))
		var half_fov = minf(deg_to_rad(camera.fov)*.5,atan(tan(deg_to_rad(camera.fov)*.5)*aspect))
		camera_distance = clampf(radius/sin(half_fov)*1.2,.4,15000)
		camera.size = clampf(radius*2.4/minf(1,aspect),.3,18000)
	elif action=="rotate":
		camera_yaw += .35
		camera_view = "perspective"
	else: return
	update_camera()
	emit_camera()

func object_bounds(id: String) -> AABB:
	if runtime.native_mode: return runtime.projection.world_bounds(runtime.projection.objects[id]).bounds
	var node: Node3D = runtime.projection.objects[id]
	var stats = Hierarchy.world_bounds(node)
	return stats.bounds if stats.mesh_count else AABB(node.global_position-Vector3.ONE*.2,Vector3.ONE*.4)

func pick(position: Vector2) -> String:
	var ray_origin = camera.project_ray_origin(position)
	var direction = camera.project_ray_normal(position)
	var best = INF
	var selected = ""
	for id in runtime.projection.objects:
		if not runtime.projection.objects[id] is Node3D: continue
		var node: Node3D = runtime.projection.objects[id]
		if not node.is_visible_in_tree(): continue
		var bounds = object_bounds(id)
		var bound_hit = bounds.intersects_ray(ray_origin,direction)
		if bound_hit==null: continue
		var row: Dictionary = runtime.projection.definitions[id]
		if row.get("kind")=="anchor" and not row.has("model_hash"):
			var depth = ray_origin.distance_to(bound_hit)
			if depth<best:
				best = depth
				selected = id
		for mesh in runtime.projection.owned_meshes(node) if runtime.native_mode else Hierarchy.owned_meshes(node):
			if mesh.mesh==null or not mesh.is_visible_in_tree(): continue
			var inverse = mesh.global_transform.affine_inverse()
			var local_origin = inverse*ray_origin
			var local_direction = (inverse.basis*direction).normalized()
			if mesh.get_aabb().intersects_ray(local_origin,local_direction)==null: continue
			var faces = mesh.mesh.get_faces()
			for index in range(0,faces.size()-2,3):
				var hit = Geometry3D.ray_intersects_triangle(local_origin,local_direction,faces[index],faces[index+1],faces[index+2])
				if hit==null: continue
				var depth = ray_origin.distance_to(mesh.global_transform*hit)
				if depth<best:
					best = depth
					selected = id
	return selected

func select_object(id: String) -> void:
	selected_id = id if runtime.projection.objects.has(id) else ""
	var packet = {"type":"selected","id":selected_id,"document_id":document_id,"resource_id":runtime.current_scene_id,"seq":seq}
	if not selected_id.is_empty(): packet.merge(observe(selected_id),true)
	emit(packet)

func emit_camera() -> void:
	if inspecting_2d:
		emit({"type":"camera","seq":seq,"document_id":document_id,"resource_id":runtime.current_scene_id,"position":[camera2d.position.x,camera2d.position.y,0],"target":[camera2d.position.x,camera2d.position.y,0],"distance":1/maxf(.001,camera2d.zoom.x),"yaw":0,"pitch":0,"view":"2d","projection":"orthographic","dimension":2,"zoom":[camera2d.zoom.x,camera2d.zoom.y]})
		return
	var current = camera if inspecting else get_viewport().get_camera_3d()
	if not is_instance_valid(current): return
	var target = camera_target if inspecting else current.global_position-current.global_basis.z*camera_distance
	emit({"type":"camera","seq":seq,"document_id":document_id,"resource_id":runtime.current_scene_id,"position":Factory.array3(current.global_position),"target":Factory.array3(target),"distance":camera_distance,"yaw":camera_yaw,"pitch":camera_pitch,"view":camera_view,"projection":"orthographic" if current.projection==Camera3D.PROJECTION_ORTHOGONAL else "perspective"})

func _exit_tree() -> void:
	if bridge: bridge.dispose()

func _inspection_input_2d(event: InputEvent) -> void:
	if event is InputEventMouseMotion and (event.button_mask & (MOUSE_BUTTON_MASK_RIGHT | MOUSE_BUTTON_MASK_MIDDLE)):
		camera2d.position -= event.relative / camera2d.zoom
		emit_camera()
	elif event is InputEventMouseButton and event.pressed:
		if event.button_index in [MOUSE_BUTTON_WHEEL_UP,MOUSE_BUTTON_WHEEL_DOWN]:
			camera2d.zoom = (camera2d.zoom * (1.15 if event.button_index == MOUSE_BUTTON_WHEEL_UP else 1/1.15)).clamp(Vector2(.01,.01),Vector2(100,100))
			emit_camera()
		elif event.button_index == MOUSE_BUTTON_LEFT:
			var point = get_viewport().get_canvas_transform().affine_inverse() * event.position
			var picked = ""
			for id in runtime.projection.objects:
				var node = runtime.projection.objects[id]
				if node is CanvasItem and node.is_visible_in_tree() and runtime.projection.canvas_bounds(node).has_point(point): picked = id
			select_object(picked)
	get_viewport().set_input_as_handled()

func _camera_command_2d(packet: Dictionary) -> void:
	var action = packet.get("action","")
	if action is Dictionary: action = action.get("view",action.get("action",""))
	if action not in ["fit","focus","front","top","right","perspective"]: return
	var bounds := Rect2()
	var first := true
	for id in runtime.projection.objects:
		var node = runtime.projection.objects[id]
		if not node is CanvasItem: continue
		if action == "focus" and runtime.projection.objects.has(selected_id) and id != selected_id: continue
		var box: Rect2 = runtime.projection.canvas_bounds(node)
		bounds = box if first else bounds.merge(box)
		first = false
	if not first:
		camera2d.position = bounds.get_center()
		var view = get_viewport().get_visible_rect().size
		var zoom = clampf(minf(view.x/maxf(bounds.size.x,32),view.y/maxf(bounds.size.y,32))*.8,.01,100)
		camera2d.zoom = Vector2(zoom,zoom)
	emit_camera()
