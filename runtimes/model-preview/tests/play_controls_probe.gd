extends SceneTree
const Loader = preload("res://scene_loader.gd")
const Simulation = preload("res://world_simulation.gd")
var options = {}
var checks = []
var host: Node3D
var simulation: Node3D
var sent = 0
var frames = 0
var document = {"document_id":"probe/main","branch_id":"probe","scene_revision":"controls-v1","objects":[{"id":"device","kind":"anchor","position":[1,0,0],"scale":1,"components":{"interactable":{"radius":5}}},{"id":"floor","kind":"anchor","position":[0,-.2,0],"scale":1,"components":{"collider":{"shape":"box","size":[20,.3,20]}}}],"spawn_position":[0,.2,1]}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var pair=arg.substr(2).split("=",true,1)
			options[pair[0]]=pair[1] if pair.size()>1 else "true"
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok: print("PLAY_CONTROLS_FAILED "+detail)

func view() -> SubViewport:
	var result=SubViewport.new()
	result.size=Vector2i(900,700)
	result.own_world_3d=true
	result.render_target_update_mode=SubViewport.UPDATE_DISABLED
	root.add_child(result)
	return result

func packet(type: String, body: Dictionary) -> Dictionary:
	var result={"source":"world-atelier-workspace","nonce":host.nonce,"type":type,"seq":host.applied_seq,"document_id":document.document_id,"branch_id":"probe"}
	result.merge(body,true)
	return result

func control(direction: String, kind: String = "tap", extra: Dictionary = {}) -> void:
	var message={"action":"control","world_id":"control-world","epoch":1,"scene_revision":document.scene_revision,"control":direction,"kind":kind}
	message.merge(extra,true)
	host.receive(packet("world",message))

func step(count: int) -> void:
	for i in range(count):
		await physics_frame
		for message in host.outbound_log:
			if message.type=="player_input" and message.input_seq>sent:
				sent=message.input_seq
				simulation.accept_input(message)
		simulation.step(1.0/60)
		frames+=1
		if frames%3==0:host.receive(packet("world",{"action":"snapshot","snapshot":simulation.snapshot(true)}))
		await process_frame

func run() -> void:
	create_timer(20).timeout.connect(func():print("PLAY_CONTROLS_TIMEOUT");quit(2))
	var prepared=await Loader.new().prepare(root,document,"http://127.0.0.1:48931")
	simulation=Simulation.new()
	view().add_child(simulation)
	simulation.world_id="control-world";simulation.epoch=1;simulation.scene_revision=document.scene_revision
	check(simulation.initialize(prepared).is_empty(),"real Godot collision world initializes")
	simulation.active=true;simulation.join("player","Probe player","#8acfff")
	host=load("res://main.gd").new();view().add_child(host)
	host.origin="http://127.0.0.1:48931"
	host.receive(packet("scene",dict_merge(document,{"seq":1,"frame":true,"editable":true})))
	await step(20)
	host.receive(packet("world",{"action":"join","world_id":"control-world","epoch":1,"player_id":"player","snapshot":simulation.snapshot(true)}))
	await step(25)
	check(host.world_client.mode=="playing","projection receives genuine authority snapshot and becomes playing")
	var before: Vector3=simulation.players.player.body.position
	control("right")
	await step(20)
	var after: Vector3=simulation.players.player.body.position
	check(after.distance_to(before)>.2 and after.distance_to(before)<.9,"DOM tap intent produces a bounded physics step through player_input relay")
	await step(12)
	check(simulation.players.player.body.position.distance_to(after)<.03,"short step ends with zero and does not drift")
	before=simulation.players.player.body.position
	for i in range(6):control("forward","start");await step(5)
	check(simulation.players.player.body.position.distance_to(before)>1.8,"renewed hold intent produces continuous actual movement")
	control("forward","end");await step(3)
	check(Vector2(simulation.players.player.body.velocity.x,simulation.players.player.body.velocity.z).length()<.001,"release yields actual authority zero velocity")
	control("left","start");await step(30)
	check(Vector2(simulation.players.player.body.velocity.x,simulation.players.player.body.velocity.z).length()<.001,"unrenewed UI hold expires through its lease")
	host.world_client.set_focused(false)
	before=simulation.players.player.body.position
	control("backward");await step(20)
	check(simulation.players.player.body.position.distance_to(before)>.2,"focused parent DOM can move while iframe keyboard focus is absent")
	control("right","start");await step(6);host.world_client.set_focused(false);await step(3)
	check(host.world_client.ui_held.is_empty() and simulation.players.player.body.velocity.x==0,"focus loss clears UI hold and sends stop")
	var previous_seq=host.world_client.input_seq
	control("forward","tap",{"epoch":2});control("forward","tap",{"scene_revision":"stale"})
	check(host.world_client.input_seq==previous_seq and host.world_client.ui_pulses.is_empty(),"wrong epoch/revision UI commands are fenced")
	control("jump");await step(6)
	check(simulation.players.player.body.velocity.y>0,"Jump button intent performs actual CharacterBody jump")
	await step(50)
	control("interact");await step(5)
	check(simulation.players.player.interactions==1,"Interact button reaches a real authority Area3D through normal player input")
	host.world_client.change_mode("inspecting","probe-inspect");await step(6)
	previous_seq=host.world_client.input_seq;control("forward");control("jump");control("interact")
	check(host.world_client.mode=="inspecting" and host.world_client.input_seq==previous_seq and host.world_client.ui_pulses.is_empty(),"inspection waits for stop ACK and rejects all movement/action buttons")
	host.world_client.emit_state()
	var telemetry:Dictionary=host.outbound_log.back()
	check(telemetry.has("player_position") and telemetry.has("tick") and telemetry.latest_tick>=telemetry.frozen_tick and telemetry.frozen_sequence==telemetry.applied_sequence,"position/view tick/frozen tick/latest tick come from the real projection and authority")
	# Presentation fixtures below inspect production marker placement; they are
	# not gameplay progress or server-authoritative document edits.
	host.world_client.projection.objects.device.position=Vector3(6,0,0)
	var seq=host.applied_seq
	host.receive(packet("development",{"states":[{"object_id":"device","status":"editing","label":"Fixture task"}]}))
	var overlay=host.collaboration_overlay
	check(overlay.development_selections.size()==1 and overlay.development_selections[0].object_id=="device","development selection targets the current inspected object")
	check(host.applied_seq==seq and host.world_client.projection.scene_revision==document.scene_revision and host.objects.device.position.x==1,"development metadata does not reload scene or alter canonical/playing revision or source TRS")
	host.world_client.projection.objects.device.position.y=-4;host.update_development_overlay()
	check(overlay.remote_selections.collect_display_selections().any(func(row): return row.object_id=="device" and row.get("kind")=="agent"),"development status uses the shared selection presentation after projection movement")
	host.receive(packet("development",{"seq":seq-1,"states":[]}))
	check(overlay.development_selections.size()==1,"stale development packet is ignored")
	host.receive(packet("development",{"states":[]}))
	check(overlay.development_selections.is_empty(),"empty current development metadata removes old markers")
	var visible_position=host.camera.to_global(Vector3(0,0,-5))
	var peer={"id":"peer","mode":"playing","name":"Peer","camera":{"position":[visible_position.x,visible_position.y,visible_position.z],"target":[6,0,0]}}
	host.receive(packet("presence",{"peers":[peer]}));overlay._process(.016)
	check(overlay.peer_nodes.peer.visible,"inspection retains visible distant peer camera marker")
	host.world_client.mode="playing";overlay._process(.016)
	check(not overlay.peer_nodes.peer.visible,"playing hides other playing follow-camera geometry while player avatars remain separate")
	host.world_client.mode="inspecting";peer.camera.position=[host.camera.position.x,host.camera.position.y,host.camera.position.z]
	host.receive(packet("presence",{"peers":[peer]}));overlay._process(.016)
	check(not overlay.peer_nodes.peer.visible,"near-camera marker is hidden before it can cross the near clipping plane")
	host.world_client.change_mode("editing");previous_seq=host.world_client.input_seq;control("right")
	check(host.world_client.input_seq==previous_seq,"editing rejects gameplay UI intents")
	var okay=true
	for item in checks:okay=okay and item.ok
	var result={"ok":okay,"completed":true,"checks":checks,"scope":"actual headless Godot UI-intent handler, real physics/relay/snapshots and marker nodes; no browser gesture/GPU assertion"}
	var file=FileAccess.open(options.report,FileAccess.WRITE);file.store_string(JSON.stringify(result,"\t"))
	print("PLAY_CONTROLS_PROBE_COMPLETE "+JSON.stringify(result));quit(0 if okay else 1)

func dict_merge(a: Dictionary,b: Dictionary) -> Dictionary:
	var result=a.duplicate(true);result.merge(b,true);return result
