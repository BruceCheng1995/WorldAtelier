extends Node
var runtime: Node
var checks: Array = []
func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	run.call_deferred()
func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	print("UNIFIED_CHECK "+JSON.stringify(checks.back()))
func frames(count: int) -> void:
	for i in range(count): await get_tree().process_frame
func packet(action: String, extra: Dictionary = {}) -> void:
	var value = {"source":"world-atelier-workspace","nonce":runtime.debug.nonce,"type":"world","world_id":runtime.debug.world_id,"epoch":runtime.debug.epoch,"scene_revision":runtime.simulation.scene_revision,"action":action}
	value.merge(extra,true)
	runtime.receive(value)
func ui(name: String) -> Node:
	return runtime.game_scene.find_child(name,true,false)
func interactions() -> int:
	return runtime.simulation.behaviors.snapshot().get("independent-preview-device",{}).get("independent-preview-counter",{}).get("interactions",-1)
func drag(button: int, mask: int, delta: Vector2) -> void:
	var mouse = InputEventMouseMotion.new()
	mouse.position = Vector2(200,150)
	mouse.relative = delta
	mouse.button_mask = mask
	get_viewport().push_input(mouse)
	await frames(2)
func key_tap(key: int) -> void:
	var press = InputEventKey.new()
	press.physical_keycode = key
	press.keycode = key
	press.pressed = true
	Input.parse_input_event(press)
	await frames(3)
	var release_event = InputEventKey.new()
	release_event.physical_keycode = key
	release_event.keycode = key
	release_event.pressed = false
	Input.parse_input_event(release_event)
	await frames(3)
func run() -> void:
	runtime = get_node("/root/GameRuntime")
	for i in range(100):
		if runtime.running: break
		await frames(1)
	check(runtime.running,"native configured main scene starts actual shared simulation")
	if not runtime.running:
		get_tree().quit(2)
		return
	# Enable only the transport in this native probe. It observes and controls
	# the existing simulation; no world snapshots or success ACKs are injected.
	if not runtime.debug.embedded:
		runtime.debug.embedded = true
		runtime.debug.started = true
		runtime.debug.world_id = runtime.simulation.world_id
		runtime.debug.epoch = runtime.simulation.epoch
		runtime.debug.nonce = "native-unified-probe"
	await frames(15)
	check(get_tree().current_scene==runtime.game_scene and not runtime.is_ancestor_of(runtime.game_scene),"game is native current_scene while game services remain Autoload siblings")
	check(runtime.list_scenes().size()==3 and runtime.list_prefabs().size()==1,"all scenes and unplaced prefab definitions are discoverable")
	check(runtime.current_scene_id=="empty" and runtime.simulation.objects.is_empty(),"canonical native startup opens the actual empty authored scene")
	check(runtime.simulation.players.is_empty() and runtime.projection.rendered_players().is_empty(),"empty scene creates neither simulation player nor rendered avatar")
	check(runtime.game_scene.find_children("*","CharacterBody3D",true,false).is_empty(),"empty scene contains no injected character or player collider")
	check(runtime.game_scene.find_children("*","TouchScreenButton",true,false).is_empty(),"empty scene contains no injected mobile gameplay buttons")
	var defaults_absent = true
	for action in ["release_left","release_right","release_forward","release_back","release_jump","release_interact"]:
		defaults_absent = defaults_absent and not InputMap.has_action(action)
	check(defaults_absent,"host registers no default movement, jump, or interaction actions")
	var empty_camera = get_viewport().get_camera_3d()
	var empty_camera_pose: Transform3D = empty_camera.global_transform
	var initial_tick: int = runtime.simulation.tick
	if OS.has_feature("web"):
		JavaScriptBridge.eval("window.noDefaultPlayerReady=true")
		for i in range(3000):
			if bool(JavaScriptBridge.eval("window.noDefaultPlayerKeyboardDone===true")): break
			await frames(1)
		check(bool(JavaScriptBridge.eval("window.noDefaultPlayerKeyboardDone===true")),"browser delivered real WASD, arrow, Space and E keys to the exported Godot canvas")
	for key in [KEY_W,KEY_A,KEY_S,KEY_D,KEY_UP,KEY_DOWN,KEY_LEFT,KEY_RIGHT,KEY_SPACE,KEY_E]:
		await key_tap(key)
	for action in ["forward","backward","left","right","jump","interact"]:
		packet("control",{"control":action,"kind":"tap"})
	await frames(15)
	check(runtime.simulation.tick>initial_tick and not runtime.faulted,"empty scene keeps simulating normally after keyboard and obsolete bridge input")
	check(runtime.simulation.players.is_empty() and runtime.projection.rendered_players().is_empty() and runtime.simulation.behaviors.snapshot().is_empty(),"WASD, arrows, Space, E and obsolete bridge controls create no player or gameplay state")
	check(empty_camera.global_transform.is_equal_approx(empty_camera_pose),"unconfigured gameplay keys do not move the fallback camera")
	packet("mode",{"mode":"inspecting","request_id":"empty-inspect"})
	var empty_tick: int = runtime.simulation.tick
	await frames(15)
	check(runtime.debug.inspecting and runtime.simulation.tick==empty_tick,"empty scene can pause without requiring a player")
	packet("mode",{"mode":"playing","request_id":"empty-resume"})
	await frames(15)
	check(not runtime.debug.inspecting and runtime.simulation.tick>empty_tick and not runtime.faulted,"empty scene resumes without injected player input")
	await runtime.open_scene("scene-a")
	await frames(15)
	check(runtime.simulation.players.is_empty(),"authored behavior scene also remains player-free")

	check(ui("CreatorGameCamera")!=null and get_viewport().get_camera_3d()==ui("CreatorGameCamera"),"creator's actual gameplay camera controls the view")
	check(ThemeDB.fallback_font.has_char("晨".unicode_at(0)) and ThemeDB.get_default_theme().default_font.has_char("豌".unicode_at(0)),"bundled CJK is both engine default and fallback before gameplay lifecycle")
	await key_tap(KEY_F)
	await frames(16)
	check(interactions()==1,"authored F binding invokes real local behavior interaction")
	var original_scene = weakref(runtime.game_scene)
	var original_camera = ui("CreatorGameCamera")
	var original_transform: Transform3D = original_camera.global_transform
	packet("mode",{"mode":"inspecting","request_id":"inspect-one"})
	var tick: int = runtime.simulation.tick
	check(runtime.last_published_telemetry.get("inspecting")==true and runtime.last_published_telemetry.get("tick")==tick,"pause immediately publishes the actual mode and frozen tick used by standalone JS")
	var paused_publication: Dictionary = runtime.last_published_telemetry
	await frames(30)
	check(not is_same(paused_publication,runtime.last_published_telemetry) and runtime.last_published_telemetry.get("inspecting")==true and runtime.last_published_telemetry.get("tick")==tick,"paused observation continues publishing while actual simulation tick stays frozen")
	check(runtime.debug.inspecting and runtime.simulation.tick==tick,"inspection pauses actual simulation without resetting state")
	check(get_viewport().get_camera_3d()==runtime.debug.camera and runtime.debug.camera.global_transform.is_equal_approx(original_transform),"inspection begins at exact actual gameplay camera transform")
	check(runtime.debug.camera.environment==original_camera.environment and runtime.debug.camera.attributes==original_camera.attributes and runtime.debug.camera.compositor==original_camera.compositor,"inspection preserves actual creator camera environment, exposure attributes and compositor resources")
	check(runtime.debug.camera.keep_aspect==original_camera.keep_aspect and runtime.debug.camera.cull_mask==original_camera.cull_mask and runtime.debug.camera.h_offset==original_camera.h_offset and runtime.debug.camera.v_offset==original_camera.v_offset and runtime.debug.camera.frustum_offset==original_camera.frustum_offset,"inspection preserves camera framing, layer mask and all projection offsets")
	var projections_equal = true
	for column in range(4): projections_equal = projections_equal and runtime.debug.camera.get_camera_projection()[column].is_equal_approx(original_camera.get_camera_projection()[column])
	check(projections_equal and runtime.debug.camera.get_camera_transform().is_equal_approx(original_camera.get_camera_transform()),"actual engine camera projection and render transform match before inspection movement")

	check(not ui("InteractionCount").is_visible_in_tree(),"game UI is hidden on inspection entry")
	var before: Transform3D = runtime.debug.camera.global_transform
	await drag(MOUSE_BUTTON_RIGHT,MOUSE_BUTTON_MASK_RIGHT,Vector2(55,20))
	check(not before.is_equal_approx(runtime.debug.camera.global_transform),"real Viewport mouse motion moves inspection camera while paused")
	var before_target: Vector3 = runtime.debug.camera_target
	await drag(MOUSE_BUTTON_MIDDLE,MOUSE_BUTTON_MASK_MIDDLE,Vector2(30,-20))
	check(not before_target.is_equal_approx(runtime.debug.camera_target),"real Viewport middle drag pans inspection camera")
	packet("inspection_ui",{"visible":true})
	check(ui("InteractionCount").is_visible_in_tree() and not ui("MustRemainHidden").visible,"UI reveal restores only originally visible nodes")
	check(ui("FullScreenInputBlocker").mouse_filter==Control.MOUSE_FILTER_IGNORE and ui("FullScreenInputBlocker").focus_mode==Control.FOCUS_NONE,"shown UI remains readonly and does not capture camera input")
	await key_tap(KEY_F)
	await frames(10)
	check(interactions()==1,"paused authored keyboard input cannot mutate game state")
	packet("inspection_ui",{"visible":false,"world_id":"wrong-world"})
	check(runtime.debug.inspection_ui_visible,"stale world commands are rejected")
	packet("mode",{"mode":"playing","request_id":"resume-one"})
	check(runtime.last_published_telemetry.get("inspecting")==false,"resume immediately publishes playing observation without waiting for gameplay ticks")
	await frames(20)
	check(runtime.simulation.tick>tick and interactions()==1,"resume advances same simulation and keeps prior progress")
	check(get_viewport().get_camera_3d()==original_camera and original_camera.global_transform.is_equal_approx(original_transform),"resume restores actual creator camera without copying inspection movements into it")
	check(original_camera.environment.background_color==Color("29493f") and is_equal_approx(original_camera.environment.tonemap_exposure,.55) and is_equal_approx(original_camera.attributes.exposure_multiplier,.48),"inspection and resume leave creator background and exposure resources unchanged")

	check(ui("FullScreenInputBlocker").mouse_filter==Control.MOUSE_FILTER_STOP and ui("InteractionCount").is_visible_in_tree(),"resume restores original UI interaction and visibility policies")
	await runtime.open_scene("scene-b")
	await frames(15)
	check(original_scene.get_ref()==null and get_tree().current_scene==runtime.game_scene,"Godot scene switch actually frees previous native current_scene")
	check(runtime.current_scene_id=="scene-b" and interactions()==0,"scene switch enters new initial gameplay state")
	check(runtime.debug.document_id=="unified-project/main/scene-b","actual scene transition emits correct immutable document identity")
	await key_tap(KEY_F)
	await frames(15)
	check(interactions()==1,"new scene accepts authored controls after native lifecycle switch")
	var second = weakref(runtime.game_scene)
	await runtime.open_scene("scene-b")
	await frames(10)
	check(second.get_ref()==null and interactions()==0,"restart re-enters same scene from initial state and frees old content")
	await key_tap(KEY_F)
	await frames(10)
	check(interactions()==1 and not runtime.faulted,"fault fixture starts healthy and its first real interaction succeeds")
	var fault_scene = weakref(runtime.game_scene)
	await key_tap(KEY_F)
	await frames(10)
	check(runtime.running and runtime.faulted and runtime.debug.inspecting and fault_scene.get_ref()==runtime.game_scene,"real second interaction failure retains loaded scene and enters readonly inspection")
	var failure_tick: int = runtime.simulation.tick
	var fault_count = runtime.debug.outbound_log.filter(func(row): return row.get("type")=="error").size()
	await frames(20)
	check(runtime.simulation.tick==failure_tick and interactions()==1 and fault_count==0,"fault stops actual physics once, retains safe state and never emits fatal load error")
	before = runtime.debug.camera.global_transform
	await drag(MOUSE_BUTTON_RIGHT,MOUSE_BUTTON_MASK_RIGHT,Vector2(30,15))
	check(not before.is_equal_approx(runtime.debug.camera.global_transform),"failed game's retained scene remains inspectable with actual free camera input")
	packet("inspection_ui",{"visible":true})
	check(ui("InteractionCount").is_visible_in_tree() and ui("FullScreenInputBlocker").mouse_filter==Control.MOUSE_FILTER_IGNORE,"failed game UI can be revealed readonly")
	packet("mode",{"mode":"playing","request_id":"rejected-fault-resume"})
	await frames(2)
	var rejection: Dictionary = runtime.debug.outbound_log.back()
	check(runtime.debug.inspecting and rejection.get("request_id")=="rejected-fault-resume" and rejection.get("mode_request_failed")==true and rejection.get("requires_restart")==true,"fault resume emits matching explicit rejection while preserving inspection")
	check(rejection.get("scene_name")=="故障保留测试场景" and not rejection.get("runtime_fault",{}).is_empty(),"fault telemetry exposes actual scene name and captured callback fault")
	await runtime.open_scene("scene-b")
	await frames(10)
	check(fault_scene.get_ref()==null and runtime.running and not runtime.faulted and not runtime.debug.inspecting and interactions()==0,"explicit restart releases failed scene and initializes a clean playable run")
	var failed = checks.any(func(row): return not row.ok)
	print("UNIFIED_RUNTIME_COMPLETE "+JSON.stringify({"ok":not failed,"checks":checks}))
	# The browser harness owns Web teardown; keep the final game available for a screenshot.
	if not OS.has_feature("web"): get_tree().quit(1 if failed else 0)
