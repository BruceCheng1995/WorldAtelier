extends Node3D

const Game = preload("res://scripts/game_state.gd")
const Visual = preload("res://scripts/world_visual.gd")
const Overlay = preload("res://scripts/hud.gd")
const Soundscape = preload("res://scripts/audio.gd")
var soundscape: Node
var game = Game.new()
var visual: Node3D
var hud: Control
var socket = WebSocketPeer.new()
var args: Dictionary = {}
var role = "offline"
var runtime_version = str(ProjectSettings.get_setting("application/config/version", "unversioned"))
var content: Dictionary = {}
var state: Dictionary = {}
var user_id = "offline-explorer"
var world_id = "offline"
var release_id = "local"
var epoch = 0
var control_generation = 0
var active = false
var initialized = false
var sent_hello = false
var connection_status = "PREPARING EXPEDITION"
var request_serial = 0
var session_nonce = Crypto.new().generate_random_bytes(12).hex_encode()
var send_clock = 0.0
var snapshot_clock = 0.0
var telemetry_clock = 0.0
var save_clock = 0.0
var elapsed = 0.0
var input_script: Array = []
var scripted_index = 0
var bridge_callback: JavaScriptObject
var external_move = Vector2.ZERO
var external_move_until = 0.0
var last_move = Vector2.ZERO
var log_message = "WASD to explore · E to interact · Space to strike · Shift to dash"
var log_until = 9.0
var last_sequence = -1
var pending_snapshot_ack: Dictionary = {}
var captured = false
var reported_runtime_fault = ""
var authority_frozen = false
var frozen_snapshot: Dictionary = {}
var upgrade_target: Dictionary = {}
var quitting = false
var attack_pending_id = ""
var attack_wait_sequence = -1
var attack_gate_until = 0.0
var next_attack_at = 0.0

func _ready() -> void:
	get_tree().auto_accept_quit = false
	# A single immutable GLB release may exceed the 64 KiB engine default.
	socket.inbound_buffer_size = 32 * 1024 * 1024
	socket.outbound_buffer_size = 32 * 1024 * 1024
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var pair = arg.substr(2).split("=", true, 1)
			args[pair[0]] = pair[1] if pair.size() > 1 else "true"
	if OS.has_feature("web"):
		var query = JavaScriptBridge.eval("JSON.stringify(Object.fromEntries(new URLSearchParams(window.location.search)))")
		var web_args = JSON.parse_string(str(query))
		if web_args is Dictionary:
			args.merge(web_args, true)
	role = str(args.get("role", "client" if args.has("ticket") else "offline"))
	if role == "validate":
		var candidate = load_json(str(args.get("content", "res://content/world.json")))
		var error = Game.validate(candidate)
		if error.is_empty():
			error = game.initialize(candidate)
		if error.is_empty():
			game.join("validation-explorer", "Validation Explorer")
			game.command("validation-explorer", "move", {"x": 0, "z": 0})
			for i in range(6):
				game.step(1.0 / 30)
			if game.state.has("runtime_fault"):
				error = game.state.runtime_fault.error
		if not error.is_empty():
			printerr("CONTENT_REJECTED: " + error)
			get_tree().quit(2)
		else:
			print("CONTENT_VALIDATED objects=%d enemies=%d zones=%d" % [candidate.objects.size(), candidate.enemies.size(), candidate.zones.size()])
			get_tree().quit(0)
		return
	if args.has("input-script"):
		var script = load_json(args["input-script"])
		if script is Array:
			input_script = script
	if DisplayServer.get_name() != "headless" and role != "authority":
		soundscape = Soundscape.new()
		add_child(soundscape)
		visual = Visual.new()
		add_child(visual)
		hud = Overlay.new()
		var canvas = CanvasLayer.new()
		add_child(canvas)
		canvas.add_child(hud)
		hud.game_root = self
		visual.game_root = self
		if args.has("camera-size"):
			visual.camera.size = clampf(float(args["camera-size"]), 12, 45)
	if role == "offline":
		user_id = str(args.get("offline-user", "offline-explorer"))
		var candidate = load_json(str(args.get("content", "res://content/world.json")))
		var saved = load_json(str(args.get("save", ""))) if args.has("save") else null
		var error = game.initialize(candidate if candidate is Dictionary else {}, saved)
		if not error.is_empty():
			fail(error)
			return
		game.join(user_id, str(args.get("name", "Explorer")))
		content = game.content
		state = game.snapshot()
		initialized = true
		active = true
		connection_status = "OFFLINE WORKSPACE"
		if visual:
			visual.build_world(content)
		print("OFFLINE_READY objects=%d enemies=%d" % [content.objects.size(), content.enemies.size()])
	else:
		var server = str(args.get("server", "ws://127.0.0.1:48900")).trim_suffix("/")
		var endpoint = "/host" if role == "authority" else "/play"
		if not server.ends_with(endpoint):
			server += endpoint
		var error = socket.connect_to_url(server)
		if error != OK:
			fail("Connection failed: " + error_string(error))
	if OS.has_feature("web"):
		bridge_callback = JavaScriptBridge.create_callback(_on_browser_message)
		JavaScriptBridge.get_interface("window").addEventListener("message", bridge_callback)

func load_json(path: String) -> Variant:
	if path.is_empty() or not FileAccess.file_exists(path):
		return null
	return JSON.parse_string(FileAccess.get_file_as_string(path))

func _process(delta: float) -> void:
	if quitting:
		return
	elapsed += delta
	if role in ["client", "authority"]:
		socket.poll()
		var status = socket.get_ready_state()
		if status == WebSocketPeer.STATE_OPEN:
			if not sent_hello:
				sent_hello = true
				if role == "authority":
					send({"type": "host_hello", "world_id": args.get("world", ""), "host_key": args.get("host-key", "")})
				else:
					send({"type": "hello", "ticket": args.get("ticket", ""), "snapshot_ack": true})
			while socket.get_available_packet_count() > 0:
				var packet = JSON.parse_string(socket.get_packet().get_string_from_utf8())
				if packet is Dictionary:
					receive(packet)
		elif status == WebSocketPeer.STATE_CLOSED:
			if role == "authority":
				printerr("AUTHORITY_DISCONNECTED; exiting without further simulation")
				get_tree().quit(3)
				return
			if active or connection_status == "PREPARING EXPEDITION":
				active = false
				connection_status = "DISCONNECTED · REJOIN FROM PROJECT"
				print("CONNECTION_CLOSED code=%s reason=%s" % [socket.get_close_code(), socket.get_close_reason()])
	if role == "validate":
		return
	if active and role != "authority":
		process_controls(delta)
		while scripted_index < input_script.size() and float(input_script[scripted_index].get("at", 0)) <= elapsed:
			var command = input_script[scripted_index]
			if command.get("action") == "move":
				external_move = Vector2(command.get("payload", {}).get("x", 0), command.get("payload", {}).get("z", 0)).limit_length(1)
				external_move_until = elapsed + float(command.get("duration", .1))
			issue_command(str(command.get("action", "")), command.get("payload", {}))
			scripted_index += 1
	if visual and initialized:
		visual.update_world(state, user_id, delta)
		soundscape.update_state(state, user_id)
	if not pending_snapshot_ack.is_empty():
		send(pending_snapshot_ack)
		pending_snapshot_ack = {}
	if hud:
		hud.queue_redraw()
	telemetry_clock += delta
	if telemetry_clock >= .25:
		telemetry_clock = 0
		emit_telemetry()
	if args.has("capture") and not captured and elapsed > float(args.get("capture-after", 2)) and visual:
		captured = true
		capture.call_deferred()
	if args.has("quit-after-seconds") and elapsed >= float(args["quit-after-seconds"]):
		finish()

func _physics_process(delta: float) -> void:
	if not initialized or not role in ["authority", "offline"] or authority_frozen:
		return
	game.step(delta)
	state = game.state
	if role == "authority" and state.has("runtime_fault"):
		var fault_key = JSON.stringify(state.runtime_fault)
		if reported_runtime_fault != fault_key:
			reported_runtime_fault = fault_key
			send({"type": "runtime_fault", "release_id": release_id, "error": state.runtime_fault.error, "fault": state.runtime_fault, "state": game.snapshot()})
	snapshot_clock += delta
	if snapshot_clock >= .1:
		snapshot_clock = 0
		if role == "authority":
			send({"type": "snapshot", "state": game.snapshot()})
	save_clock += delta
	if save_clock >= 2:
		save_clock = 0
		save_offline()

func receive(packet: Dictionary) -> void:
	match str(packet.get("type", "")):
		"init":
			authority_frozen = false
			frozen_snapshot = {}
			world_id = packet.get("world_id", "")
			epoch = int(packet.get("epoch", 0))
			release_id = str(packet.get("release_id", ""))
			var error = game.initialize(packet.get("content", {}), packet.get("state"))
			if not error.is_empty():
				send({"type": "error", "error": error})
				fail(error)
				return
			content = game.content
			state = game.state
			initialized = true
			send({"type": "ready", "release_id": release_id, "epoch": epoch, "state": game.snapshot(), "runtime_version": runtime_version})
			print("AUTHORITY_READY world=%s release=%s epoch=%s" % [world_id, release_id, epoch])
		"freeze":
			if role != "authority" or not initialized:
				return
			if not authority_frozen:
				authority_frozen = true
				frozen_snapshot = game.snapshot()
			send({"type": "frozen", "request_id": packet.get("request_id", ""), "ok": true, "state": frozen_snapshot})
		"join":
			if authority_frozen:
				return
			game.join(str(packet.user_id), str(packet.get("name", "Explorer")))
		"leave":
			if authority_frozen:
				return
			game.leave(str(packet.get("user_id", "")))
		"command":
			if role != "authority" or not initialized:
				return
			if authority_frozen:
				send({"type": "result", "request_id": packet.get("request_id", ""), "ok": false, "error": "world is frozen for runtime upgrade", "state": frozen_snapshot})
				return
			var result = game.command(str(packet.get("user_id", "")), str(packet.get("action", "")), packet.get("payload", {}))
			result.merge({"type": "result", "request_id": packet.get("request_id", ""), "state": game.snapshot()})
			send(result)
		"apply_content":
			if role != "authority":
				return
			if authority_frozen:
				send({"type": "applied", "request_id": packet.get("request_id", ""), "ok": false, "error": "world is frozen for runtime upgrade", "release_id": release_id, "state": frozen_snapshot})
				return
			var error = Game.validate(packet.get("content"))
			if error.is_empty():
				error = game.apply_content(packet.content)
			if error.is_empty():
				content = game.content
				release_id = str(packet.release_id)
			send({"type": "applied", "request_id": packet.get("request_id", ""), "ok": error.is_empty(), "error": error, "release_id": release_id, "state": game.snapshot()})
		"tasks":
			if role == "authority" and not authority_frozen:
				game.state.tasks = packet.get("tasks", []).duplicate(true)
		"welcome":
			user_id = str(packet.get("user_id", ""))
			world_id = str(packet.get("world_id", ""))
			epoch = int(packet.get("epoch", 0))
			release_id = str(packet.get("release_id", ""))
			control_generation = int(packet.get("control_generation", 0))
			var error = Game.validate(packet.get("content"))
			if not error.is_empty():
				fail(error)
				return
			content = packet.content
			state = packet.get("state", {})
			if state == null:
				state = {}
			initialized = true
			connection_status = "SYNCHRONIZING WORLD"
			if visual:
				error = visual.build_world(content)
				if not error.is_empty():
					fail("Client asset preparation failed: " + error)
					return
			send({"type": "loaded", "release_id": release_id})
		"active":
			active = true
			attack_pending_id = ""
			attack_wait_sequence = -1
			epoch = int(packet.get("epoch", epoch))
			control_generation = int(packet.get("control_generation", control_generation))
			release_id = str(packet.get("release_id", release_id))
			connection_status = "LIVE · CENTRAL AUTHORITY"
			print("CLIENT_ACTIVE world=%s release=%s user=%s" % [world_id, release_id, user_id])
		"snapshot":
			if int(packet.get("epoch", epoch)) < epoch:
				return
			if str(packet.get("release_id", release_id)) != release_id:
				active = false
				return
			state = packet.get("state", {})
			last_sequence = int(packet.get("sequence", last_sequence))
			pending_snapshot_ack = {"type": "snapshot_ack", "sequence": packet.get("sequence", -1), "release_id": packet.get("release_id", release_id), "epoch": packet.get("epoch", epoch)}
		"content":
			pending_snapshot_ack = {}
			active = false
			var candidate = packet.get("content")
			var error = Game.validate(candidate)
			if error.is_empty() and visual:
				error = visual.build_world(candidate)
			if not error.is_empty():
				send({"type": "content_rejected", "release_id": packet.get("release_id", ""), "error": error})
				connection_status = "UPDATE REJECTED · PREVIOUS VIEW"
				show_log("Content rejected; previous view preserved: " + error)
				return
			active = false
			content = candidate
			release_id = str(packet.release_id)
			send({"type": "loaded", "release_id": release_id})
			show_log("WORLD UPDATED · your expedition continues")
		"ack":
			if str(packet.get("request_id", "")) == attack_pending_id:
				attack_pending_id = ""
				attack_wait_sequence = int(packet.get("sequence", -1)) if packet.get("ok", false) else -1
				if not packet.get("ok", false):
					next_attack_at = maxf(next_attack_at, elapsed + .1)
			if not packet.get("ok", false) and not str(packet.get("error", "")).contains("cooling"):
				show_log(str(packet.get("error", "Action rejected")))
		"runtime_upgrade":
			active = false
			pending_snapshot_ack = {}
			upgrade_target = {"release_id": packet.get("release_id", ""), "epoch": packet.get("epoch", 0)}
			connection_status = "CLIENT UPDATE READY · ENTER FROM PROJECT"
			show_log("Matching client update is ready. Return to the project to enter.")
			emit_telemetry()
		"runtime_fault":
			connection_status = "DEGRADED · LAST GOOD RULES"
			show_log(str(packet.get("error", "Behavior recovered to last good rules")))
		"revoked":
			active = false
			connection_status = "CONTROL TRANSFERRED"
			show_log(str(packet.get("reason", "This session is now read-only")))
		"error":
			if str(packet.get("request_id", "")) == attack_pending_id:
				attack_pending_id = ""
				attack_wait_sequence = -1
				next_attack_at = maxf(next_attack_at, elapsed + .15)
			if packet.get("recoverable", false):
				show_log(str(packet.get("error", "Command rejected")))
			else:
				fail(str(packet.get("error", "Connection error")))

func send(packet: Dictionary) -> void:
	if socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		socket.send_text(JSON.stringify(packet))

func issue_command(action: String, payload: Dictionary = {}) -> void:
	if not active:
		return
	if action == "attack":
		# A 10 Hz cooldown snapshot can remain zero for several rendered frames.
		# Wait for this attempt's ACK and consumed snapshot before trying again.
		# A bounded timeout/backoff recovers from a lost ACK without flooding.
		if elapsed < next_attack_at:
			return
		if elapsed < attack_gate_until and (not attack_pending_id.is_empty() or attack_wait_sequence > last_sequence):
			return
		next_attack_at = elapsed + .05
	if soundscape and action != "move":
		soundscape.activate()
	request_serial += 1
	if role == "offline":
		var result = game.command(user_id, action, payload)
		if not result.ok and not str(result.get("error", "")).contains("cooling"):
			show_log(result.get("error", "Action rejected"))
		if action != "move":
			save_offline()
	else:
		var request_id = "g-" + session_nonce + "-" + str(request_serial)
		if action == "attack":
			attack_pending_id = request_id
			attack_wait_sequence = -1
			attack_gate_until = elapsed + .75
		send({"type": "command", "request_id": request_id, "epoch": epoch, "release_id": release_id, "control_generation": control_generation, "action": action, "payload": payload})

func process_controls(delta: float) -> void:
	var direction = Vector2.ZERO
	if Input.is_physical_key_pressed(KEY_W) or Input.is_physical_key_pressed(KEY_UP):
		direction.y -= 1
	if Input.is_physical_key_pressed(KEY_S) or Input.is_physical_key_pressed(KEY_DOWN):
		direction.y += 1
	if Input.is_physical_key_pressed(KEY_A) or Input.is_physical_key_pressed(KEY_LEFT):
		direction.x -= 1
	if Input.is_physical_key_pressed(KEY_D) or Input.is_physical_key_pressed(KEY_RIGHT):
		direction.x += 1
	# Camera-aligned controls: screen up points away from camera across the islands.
	if direction.length() > 0:
		direction = direction.normalized().rotated(-PI / 4)
	if external_move_until > elapsed:
		direction = external_move
	send_clock += delta
	if direction.distance_to(last_move) > .001 or (direction != Vector2.ZERO and send_clock > .09):
		send_clock = 0
		issue_command("move", {"x": direction.x, "z": direction.y})
		last_move = direction
	if Input.is_physical_key_pressed(KEY_SPACE):
		var player = state.get("players", {}).get(user_id, {})
		if player.get("attack_cooldown", 1) <= 0:
			issue_command("attack")

func _unhandled_input(event: InputEvent) -> void:
	if soundscape and (event is InputEventKey or event is InputEventMouseButton):
		soundscape.activate()
	if not active:
		return
	if event is InputEventKey and event.pressed and not event.echo:
		match event.physical_keycode:
			KEY_E:
				issue_command("interact")
			KEY_SHIFT:
				issue_command("dash")
			KEY_Q:
				issue_command("upgrade")
			KEY_TAB:
				if hud:
					hud.map_expanded = not hud.map_expanded
			KEY_F:
				DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_FULLSCREEN if DisplayServer.window_get_mode() != DisplayServer.WINDOW_MODE_FULLSCREEN else DisplayServer.WINDOW_MODE_WINDOWED)
	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_LEFT and visual:
			var id = visual.pick_object(event.position)
			issue_command("select", {"object_id": id})
		elif event.button_index == MOUSE_BUTTON_RIGHT:
			issue_command("attack")
		elif event.button_index == MOUSE_BUTTON_WHEEL_UP and visual:
			visual.camera.size = maxf(14, visual.camera.size - 2)
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN and visual:
			visual.camera.size = minf(42, visual.camera.size + 2)

func _on_browser_message(arguments: Array) -> void:
	if arguments.is_empty():
		return
	var event = arguments[0]
	var window = JavaScriptBridge.get_interface("window")
	if str(event.origin) != str(window.location.origin):
		return
	var raw = JavaScriptBridge.get_interface("JSON").stringify(event.data)
	var packet = JSON.parse_string(str(raw))
	if not packet is Dictionary or packet.get("source") != "world-atelier-portal" or packet.get("type") != "command":
		return
	var action = str(packet.get("action", ""))
	var payload = packet.get("payload", {})
	if not payload is Dictionary:
		return
	if action == "move":
		if Game.number_between(payload.get("x"), -1, 1) and Game.number_between(payload.get("z"), -1, 1):
			external_move = Vector2(payload.x, payload.z).limit_length(1)
			external_move_until = elapsed + .35
		return # The regular control loop sends changes/keepalive once, avoiding duplicate move floods.
	if action in ["attack", "dash", "interact", "select", "upgrade"]:
		if external_move_until > elapsed and external_move.distance_to(last_move) > .001:
			issue_command("move", {"x": external_move.x, "z": external_move.y})
			last_move = external_move
			send_clock = 0
		issue_command(action, payload)

func emit_telemetry() -> void:
	var player = state.get("players", {}).get(user_id, {})
	var packet = {"source": "world-atelier-game", "type": "telemetry", "world_id": world_id, "release_id": release_id, "epoch": epoch, "tick": state.get("tick", 0), "user_id": user_id, "active": active, "selected": player.get("selected", ""), "player": player, "sequence": last_sequence, "object_count": content.get("objects", []).size(), "enemy_count": content.get("enemies", []).size(), "tasks": state.get("tasks", []), "status": connection_status}
	packet.runtime_version = runtime_version
	packet.upgrade_target = upgrade_target
	packet.fps = Engine.get_frames_per_second()
	packet.module_assets = state.get("module_assets", [])
	packet.runtime_fault = state.get("runtime_fault", null)
	if visual:
		packet.rendered_model_assets = visual.prepared_assets.keys()
		packet.selection_bounds = is_instance_valid(visual.selection)
		packet.rendered_tasks = []
		for task_id in visual.task_nodes:
			packet.rendered_tasks.append({"id": task_id, "status": visual.task_nodes[task_id].get_meta("status")})
		var actor_node = visual.player_nodes.get(user_id)
		if actor_node != null and actor_node.has_meta("animation_player"):
			packet.avatar_animation = actor_node.get_meta("animation_player").current_animation
	if OS.has_feature("web"):
		var window = JavaScriptBridge.get_interface("window")
		window.parent.postMessage(JavaScriptBridge.get_interface("JSON").parse(JSON.stringify(packet)), window.location.origin)
	if args.has("telemetry-file"):
		var file = FileAccess.open(args["telemetry-file"], FileAccess.WRITE)
		if file:
			file.store_string(JSON.stringify(packet))

func save_offline() -> void:
	if role != "offline" or not initialized or not args.has("save"):
		return
	var path = str(args["save"])
	var file = FileAccess.open(path + ".tmp", FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(game.snapshot()))
		file.close()
		DirAccess.rename_absolute(path + ".tmp", path)

func show_log(message: String) -> void:
	log_message = message
	log_until = elapsed + 4

func fail(message: String) -> void:
	active = false
	connection_status = "ERROR · " + message
	show_log(message)
	printerr(message)
	if DisplayServer.get_name() == "headless":
		get_tree().quit(2)

func capture() -> void:
	await RenderingServer.frame_post_draw
	var image = get_viewport().get_texture().get_image()
	var error = image.save_png(str(args.capture))
	print("CAPTURE_RESULT %s %s" % [error, args.capture])

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		finish()

func finish() -> void:
	if quitting:
		return
	quitting = true
	active = false
	save_offline()
	if soundscape:
		soundscape.shutdown()
		# Give the audio mixer time to release streaming playback before teardown.
		await get_tree().create_timer(.08).timeout
	get_tree().quit()
