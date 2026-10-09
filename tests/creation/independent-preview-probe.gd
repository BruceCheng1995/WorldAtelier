extends SceneTree
# Actual local_start execution in two independent Godot client trees. No fake
# world snapshots, ACKs, or direct assignments to gameplay state are used.
var options: Dictionary = {}
var checks: Array = []
var views: Array = []
var scene: Dictionary = {}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var pair = arg.substr(2).split("=",true,1)
			options[pair[0]] = pair[1] if pair.size()>1 else "true"
	run.call_deferred()

func check(ok: bool, detail: String, evidence: Dictionary = {}) -> bool:
	checks.append({"ok":ok,"detail":detail,"evidence":evidence})
	if not ok: print("INDEPENDENT_PREVIEW_FAILED "+detail)
	return ok

func step(frames: int) -> void:
	for i in range(frames):
		await physics_frame
		await process_frame

func packet(host: Node, action: String, extra: Dictionary = {}) -> void:
	var current = latest(host)
	var value = {"source":"world-atelier-workspace","nonce":host.nonce,"type":"world","action":action,"world_id":current.get("world_id",""),"epoch":current.get("epoch",1),"scene_revision":scene.scene_revision}
	value.merge(extra,true)
	host.receive(value)

func latest(host: Node) -> Dictionary:
	for index in range(host.outbound_log.size()-1,-1,-1):
		var value = host.outbound_log[index]
		if value.type=="world_state": return value.duplicate(true)
	return {}

func count(host: Node) -> int:
	var state = latest(host).get("object_states",{})
	return int(state.get("independent-preview-device",{}).get("independent-preview-counter",{}).get("interactions",-1))

func wait_mode(host: Node, wanted: String, maximum: int = 150) -> bool:
	for i in range(maximum):
		if latest(host).get("mode")==wanted: return true
		await step(1)
	return false

func host_new() -> Node:
	var view = SubViewport.new()
	view.size = Vector2i(1000,700)
	view.own_world_3d = true
	view.render_target_update_mode = SubViewport.UPDATE_DISABLED
	root.add_child(view)
	views.append(view)
	var host = load("res://main.gd").new()
	view.add_child(host)
	host.origin = options.origin
	return host

func start(host: Node, id: String, user: String) -> void:
	packet(host,"local_start",{"world_id":"preview:"+id,"epoch":1,"player_id":user,"player_name":user,"player_color":"#9a78d5","scene":scene.duplicate(true),"request_id":"start-"+id})

func control(host: Node, name: String, kind: String = "tap") -> void:
	packet(host,"control",{"control":name,"kind":kind})

func ui(host: Node, node_name: String) -> Node:
	return host.find_child(node_name,true,false)

func mouse(host: Node, button: int, pressed: bool, at: Vector2) -> void:
	var event = InputEventMouseButton.new()
	event.position = at
	event.global_position = at
	event.button_index = button
	event.pressed = pressed
	event.button_mask = 1<<(button-1) if pressed else 0
	host.get_viewport().push_input(event)

func drag_camera(host: Node, button: int, relative: Vector2) -> void:
	var at = Vector2(220,170)
	mouse(host,button,true,at)
	var motion = InputEventMouseMotion.new()
	motion.position = at+relative
	motion.global_position = at+relative
	motion.relative = relative
	motion.button_mask = 1<<(button-1)
	host.get_viewport().push_input(motion)
	mouse(host,button,false,at+relative)
	await step(2)

func finish() -> void:
	var ok = true
	for row in checks: ok = ok and row.ok
	var report = {"ok":ok,"completed":true,"checks":checks,"scope":"actual headless Godot main.gd local_start, two independent client trees, real control intents/simulations, UI nodes and Viewport input; no browser/GPU assertion"}
	var output = FileAccess.open(options.report,FileAccess.WRITE)
	output.store_string(JSON.stringify(report,"\t"))
	print("INDEPENDENT_PREVIEW_COMPLETE "+JSON.stringify(report))
	for view in views:
		if is_instance_valid(view): view.queue_free()
	await process_frame
	quit(0 if ok else 1)

func run() -> void:
	create_timer(35).timeout.connect(func():print("INDEPENDENT_PREVIEW_TIMEOUT");quit(2))
	scene = JSON.parse_string(FileAccess.get_file_as_string(options.fixture))
	var a = host_new()
	var b = host_new()
	start(a,"A-1","user-A")
	start(b,"B-1","user-B")
	if not check(await wait_mode(a,"playing") and await wait_mode(b,"playing"),"two local_start commands reach actual playing mode"):
		await finish()
		return
	await step(24)
	var initial_a = latest(a)
	var initial_b = latest(b)
	check(initial_a.get("session_kind")=="local_preview" and initial_b.get("session_kind")=="local_preview" and initial_a.world_id!=initial_b.world_id,"client telemetry identifies two independent preview sessions",{"a":initial_a,"b":initial_b})
	check(count(a)==0 and count(b)==0,"both independent simulations begin with untouched interaction state")
	control(a,"interact")
	await step(20)
	check(count(a)==1 and count(b)==0,"normal A interaction affects A alone",{"a":count(a),"b":count(b)})
	control(b,"interact")
	await step(20)
	control(b,"interact")
	await step(20)
	check(count(a)==1 and count(b)==2,"two normal B interactions do not change A",{"a":count(a),"b":count(b)})
	control(a,"right","start")
	await step(9)
	control(a,"right","end")
	await step(20)
	var moved_a = latest(a)
	var moved_b = latest(b)
	check(Vector3(moved_a.player_position[0],0,moved_a.player_position[2]).distance_to(Vector3(initial_a.player_position[0],0,initial_a.player_position[2]))>.3,"A moves through its normal local control intent")
	check(Vector3(moved_b.player_position[0],0,moved_b.player_position[2]).distance_to(Vector3(initial_b.player_position[0],0,initial_b.player_position[2]))<.01,"A movement cannot alter B's player position")
	var game_camera = ui(a,"CreatorGameCamera")
	check(game_camera!=null,"real presentation creates a custom gameplay Camera3D")
	packet(a,"mode",{"mode":"inspecting","request_id":"inspect-A"})
	if not check(await wait_mode(a,"inspecting"),"A enters local inspection"):
		await finish()
		return
	var frozen = latest(a)
	var before_b = latest(b)
	await step(24)
	check(latest(a).get("latest_tick")==frozen.get("latest_tick") and latest(b).get("latest_tick",0)>before_b.get("latest_tick",0),"pausing A freezes its actual simulation while B continues",{"a_before":frozen.get("latest_tick"),"a_after":latest(a).get("latest_tick"),"b_before":before_b.get("latest_tick"),"b_after":latest(b).get("latest_tick")})
	check(latest(a).get("inspection_ui_visible")==false and not ui(a,"InteractionCount").is_visible_in_tree(),"inspection hides actual gameplay CanvasLayer UI by default")
	check(a.get_viewport().get_camera_3d()==a.camera,"inspection makes the editor camera current over the creator camera")
	var before_camera: Transform3D = a.camera.transform
	await drag_camera(a,MOUSE_BUTTON_RIGHT,Vector2(70,30))
	check(not before_camera.is_equal_approx(a.camera.transform),"actual Viewport right-drag changes the inspection camera in the old UI-covered area")
	var before_target: Vector3 = a.target
	await drag_camera(a,MOUSE_BUTTON_MIDDLE,Vector2(45,-20))
	check(not before_target.is_equal_approx(a.target),"actual Viewport middle-drag freely pans the inspection camera")
	var before_distance: float = a.distance
	mouse(a,MOUSE_BUTTON_WHEEL_UP,true,Vector2(220,170))
	await step(2)
	check(a.distance<before_distance,"actual Viewport wheel zoom remains available while paused")
	packet(a,"inspection_ui",{"visible":true})
	await step(18)
	check(latest(a).get("inspection_ui_visible")==true and ui(a,"InteractionCount").is_visible_in_tree(),"inspection UI toggle reveals the existing gameplay UI")
	check(ui(a,"FullScreenInputBlocker").mouse_filter==Control.MOUSE_FILTER_IGNORE,"shown inspection UI cannot intercept camera gestures or trigger gameplay controls")
	check(not ui(a,"MustRemainHidden").visible,"UI toggle preserves controls that were originally hidden")
	before_camera = a.camera.transform
	await drag_camera(a,MOUSE_BUTTON_RIGHT,Vector2(-45,20))
	check(not before_camera.is_equal_approx(a.camera.transform),"camera also moves when paused game UI is visible")
	packet(a,"inspection_ui",{"visible":false,"world_id":"preview:not-A"})
	await step(4)
	check(latest(a).get("inspection_ui_visible")==true,"wrong-world UI toggle is rejected")
	packet(a,"inspection_ui",{"visible":false})
	await step(18)
	check(not ui(a,"InteractionCount").is_visible_in_tree() and count(a)==1 and count(b)==2,"UI off preserves both independent gameplay states")
	packet(a,"mode",{"mode":"playing","request_id":"resume-A"})
	check(await wait_mode(a,"playing"),"resume continues the same A session")
	await step(18)
	check(latest(a).world_id==frozen.world_id and latest(a).latest_tick>frozen.latest_tick and count(a)==1,"resume advances prior A simulation without resetting progress")
	check(ui(a,"InteractionCount").is_visible_in_tree() and ui(a,"FullScreenInputBlocker").mouse_filter==Control.MOUSE_FILTER_STOP,"resume restores original game UI visibility and interaction policy")
	check(a.get_viewport().get_camera_3d()==game_camera,"resume restores the creator's original current gameplay camera")
	# Browser restart destroys this isolated iframe. Recreate the real client tree
	# to verify fresh initialization without sending saved gameplay state.
	var b_before_restart = latest(b)
	var old_a = weakref(a)
	a.get_viewport().queue_free()
	await step(3)
	a = host_new()
	start(a,"A-2","user-A")
	check(await wait_mode(a,"playing"),"fresh A iframe-equivalent client starts after restart")
	await step(18)
	check(old_a.get_ref()==null and count(a)==0 and latest(a).world_id=="preview:A-2","A restart frees old client and initializes counter zero in a new session")
	check(latest(b).world_id==b_before_restart.world_id and count(b)==2 and latest(b).latest_tick>b_before_restart.latest_tick,"A restart neither replaces nor resets B")
	check(Vector3(latest(a).player_position[0],0,latest(a).player_position[2]).distance_to(Vector3(initial_a.player_position[0],0,initial_a.player_position[2]))<.01,"A restart restores initial spawn position")
	var cancelled = host_new()
	start(cancelled,"cancelled-1","user-C")
	packet(cancelled,"leave")
	await step(30)
	check(latest(cancelled).get("mode")=="editing" and ui(cancelled,"IndependentPreviewGameUI")==null,"leave during delayed local_start cannot resurrect gameplay UI")
	start(cancelled,"cancelled-2","user-C")
	check(await wait_mode(cancelled,"playing"),"a cancelled local_start does not prevent the next explicit play")
	await finish()
