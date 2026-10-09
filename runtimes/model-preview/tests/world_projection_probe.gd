extends SceneTree
const Loader = preload("res://scene_loader.gd")
const Simulation = preload("res://world_simulation.gd")
var options = {}
var checks = []
var failed = false
var simulation: Node3D
var authority_view: SubViewport
var hosts: Array = []
var sent = {}
var loader = Loader.new()
var scenes: Array = []
var frame = 0

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var part=arg.substr(2).split("=",true,1)
			options[part[0]]=part[1] if part.size()>1 else "true"
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok: failed=true;print("WORLD_PROBE_CHECK_FAILED "+detail)

func viewport() -> SubViewport:
	var view=SubViewport.new()
	view.size=Vector2i(1000,700)
	view.own_world_3d=true
	view.render_target_update_mode=SubViewport.UPDATE_DISABLED
	root.add_child(view)
	return view

func install(scene: Dictionary) -> bool:
	var prepared = await loader.prepare(root,scene,options.origin)
	if not prepared.ok: return false
	var view=viewport()
	var candidate=Simulation.new()
	view.add_child(candidate)
	candidate.world_id="probe-world"
	candidate.epoch=1
	candidate.scene_revision=scene.scene_revision
	var error=candidate.initialize(prepared,simulation.snapshot() if simulation!=null else {})
	if not error.is_empty():
		view.queue_free()
		return false
	if simulation!=null:
		for player in simulation.player_list(): candidate.join(player.id,player.name,player.color)
		simulation.active=false
		authority_view.queue_free()
	authority_view=view
	simulation=candidate
	simulation.active=true
	return true

func envelope(host: Node, type: String, extra: Dictionary) -> Dictionary:
	var packet={"source":"world-atelier-workspace","nonce":host.nonce,"type":type}
	packet.merge(extra,true)
	return packet

func send_scene(host: Node, scene: Dictionary, sequence: int) -> void:
	var packet=scene.duplicate(true)
	packet.seq=sequence
	packet.frame=true
	host.receive(envelope(host,"scene",packet))

func step(frames: int) -> void:
	for i in range(frames):
		await physics_frame
		for host in hosts:
			for packet in host.outbound_log:
				if packet.type=="player_input" and packet.input_seq>sent.get(host,0):
					sent[host]=packet.input_seq
					var command=packet.duplicate(true)
					command.type="input"
					simulation.accept_input(command)
		simulation.step(1.0/60)
		var events=simulation.take_events()
		for host in hosts:
			if not events.is_empty(): host.receive(envelope(host,"world",{"action":"events","events":events}))
		frame+=1
		if frame%6==0:
			var snapshot=simulation.snapshot(true)
			for host in hosts: host.receive(envelope(host,"world",{"action":"snapshot","snapshot":snapshot}))
		await process_frame

func key(code: int, pressed: bool) -> void:
	var event=InputEventKey.new()
	event.physical_keycode=code
	event.keycode=code
	event.pressed=pressed
	Input.parse_input_event(event)
	for host in hosts: host.get_viewport().push_input(event)

func run() -> void:
	create_timer(40).timeout.connect(func():print("WORLD_PROBE_TIMEOUT");quit(2))
	scenes=JSON.parse_string(FileAccess.get_file_as_string(options.fixture))
	check(await install(scenes[0]),"initial authority scene compiles and constructs real physics")
	for id in ["A","B"]:
		var view=viewport()
		var host=load("res://main.gd").new()
		view.add_child(host)
		host.origin=options.origin
		hosts.append(host)
		simulation.join(id,"协作者 "+id,"#81cbff" if id=="A" else "#e8ad83")
		send_scene(host,scenes[0],1)
	await step(30)
	for i in range(hosts.size()):
		hosts[i].receive(envelope(hosts[i],"world",{"action":"join","world_id":"probe-world","epoch":1,"player_id":["A","B"][i],"snapshot":simulation.snapshot(true)}))
	await step(45)
	check(hosts[0].world_client.mode=="playing" and hosts[1].world_client.mode=="playing","two independent projections join the same authority")
	check(simulation.players.A.body.is_on_floor() and simulation.players.B.body.is_on_floor(),"actual CharacterBody3D collide with ground/box floor")
	check(hosts[0].world_client.projection.avatars.size()==2,"both real authority players are projected")
	key(KEY_E,true)
	await step(2)
	key(KEY_E,false)
	await step(12)
	var count=simulation.behaviors.snapshot()["device"]["counter"].get("count",0)
	check(count>=1,"normal E input reaches generic authority interaction behavior")
	var inspect=hosts[0].world_client
	inspect.change_mode("inspecting","inspect-request")
	await step(12)
	check(inspect.mode=="inspecting" and inspect.stop_ack_sequence>0,"inspection waits for actual zero-input snapshot acknowledgement")
	var frozen_sequence=inspect.projection.snapshot.sequence
	var frozen_revision=inspect.projection.scene_revision
	var frozen_players=inspect.projection.rendered_players()
	var before_B=simulation.players.B.body.position
	var camera_messages_before = hosts[1].outbound_log.filter(func(packet): return packet.type=="camera").size()
	key(KEY_D,true)
	await step(35)
	key(KEY_D,false)
	await step(7)
	check(simulation.players.B.body.position.distance_to(before_B)>.5,"other player continues actual authority movement during inspection")
	check(hosts[1].outbound_log.filter(func(packet): return packet.type=="camera").size()>camera_messages_before,"moving play camera emits actual presence updates")
	check(inspect.latest.sequence>frozen_sequence and inspect.projection.snapshot.sequence==frozen_sequence,"network latest sequence advances while inspected sequence stays fixed")
	check(inspect.projection.rendered_players()==frozen_players,"frozen avatars retain their exact displayed positions")
	var old_camera=hosts[0].camera.transform
	hosts[0].receive(envelope(hosts[0],"camera",{"seq":hosts[0].applied_seq,"action":"rotate","amount":.4}))
	check(not hosts[0].camera.transform.is_equal_approx(old_camera),"inspection camera remains independent and movable")
	var previous_tick=simulation.tick
	var previous_position=simulation.players.B.body.position
	check(not await install(scenes[2]),"bad behavior candidate is rejected before authority exchange")
	check(simulation.scene_revision==scenes[0].scene_revision and simulation.players.B.body.position.is_equal_approx(previous_position),"bad candidate retains entire prior world and player state")
	await step(10)
	check(simulation.tick>previous_tick,"retained authority continues stepping after candidate failure")
	check(await install(scenes[1]),"compatible replacement behavior and model prepare successfully")
	check(simulation.behaviors.snapshot().device.counter.count==count,"behavior state survives real candidate initialization")
	for host in hosts: send_scene(host,scenes[1],2)
	await step(45)
	check(inspect.mode=="inspecting" and inspect.projection.scene_revision==frozen_revision,"inspection keeps old resource revision through live publication")
	check(hosts[1].world_client.projection.scene_revision==scenes[1].scene_revision,"playing client applies new matching resources and snapshots")
	inspect.change_mode("playing","resume-request")
	await step(35)
	check(inspect.mode=="playing" and inspect.projection.scene_revision==scenes[1].scene_revision,"resume swaps to latest verified revision")
	check(inspect.projection.snapshot.sequence>frozen_sequence and not inspect.projection.frozen,"resume adopts live sequence without restoring frozen state")
	check(simulation.behaviors.hashes.has(scenes[1].objects[0].components.behaviors[0].script_hash),"actual new GDScript hash is authoritative")
	var result={"ok":not failed,"checks":checks,"tick":simulation.tick,"scope":"real headless Godot physics, HTTP GLTF/GDScript, two projections, real Input.parse_input_event; in-process transport harness, not browser or central-service ACK evidence"}
	var output=FileAccess.open(options.report,FileAccess.WRITE)
	output.store_string(JSON.stringify(result,"\t"))
	print("WORLD_PROJECTION_PROBE_COMPLETE "+JSON.stringify(result))
	quit(1 if failed else 0)
