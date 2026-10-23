extends Node
## Game-only native transport for the same fixed shared display project.
## No creator login, file editing, Agent invocation or arbitrary server calls.
var runtime: Node
var peer = WebSocketPeer.new()
var configuration: Dictionary = {}
var connected = false
var hello_sent = false
var active = false
var finished = false
var phase = "loading"
var elapsed = 0.0
var heartbeat = 0.0
var telemetry_clock = 0.0
var pending_control: Dictionary = {}

func start(value: Node) -> void:
	runtime = value
	process_mode = Node.PROCESS_MODE_ALWAYS
	var path = OS.get_environment("WA_NATIVE_CLIENT_CONFIG")
	if path.is_empty():
		set_process(false)
		return
	var file = FileAccess.open(path, FileAccess.READ)
	if file == null:
		stop_with_error("无法读取客户端接续配置")
		return
	var parsed = JSON.parse_string(file.get_as_text())
	file.close()
	if not parsed is Dictionary or parsed.get("format") != "wa-native-client-launch-1":
		stop_with_error("客户端接续配置格式无效")
		return
	configuration = parsed
	if str(configuration.get("ticket", "")).length() != 43 or not str(configuration.get("websocket_url", "")).begins_with("ws"):
		stop_with_error("客户端接续票据无效")
		return
	runtime.debug.nonce = str(configuration.get("runtime_instance_id", "native"))
	runtime.debug.packet_emitted.connect(game_packet)
	var result = peer.connect_to_url(str(configuration.websocket_url))
	if result != OK:
		stop_with_error("无法连接共享世界")

func send(packet: Dictionary) -> void:
	if peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		peer.send_text(JSON.stringify(packet))

func boundary_packet(packet: Dictionary) -> Dictionary:
	var result: Dictionary = {}
	for key in ["world_id", "epoch", "scene_revision", "source_identity", "resource_id", "scene_generation", "control_generation", "sequence", "state_hash"]:
		if packet.has(key): result[key] = packet[key]
	return result

func report(status: String, detail: Dictionary = {}) -> void:
	var output = {"status":status, "source_revision":runtime.release.get("revision", ""), "runtime_build_id":runtime.release.get("native_shared", {}).get("build_id", ""), "resource_id":runtime.current_scene_id}
	output.merge(detail, true)
	print("NATIVE_CLIENT_STATUS " + JSON.stringify(output))

func stop_with_error(message: String) -> void:
	if finished: return
	finished = true
	report("failed", {"error":message})
	peer.close()
	get_tree().quit(3)

func _process(delta: float) -> void:
	if finished: return
	elapsed += delta
	peer.poll()
	var state = peer.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN:
		connected = true
		if not hello_sent and runtime.shared.boot_ready:
			hello_sent = true
			phase = "preparing"
			send({"type":"hello", "ticket":configuration.ticket, "runtime_build_id":runtime.release.native_shared.build_id, "source_revision":runtime.release.revision, "source_identity":runtime.release.source_identity, "resource_id":runtime.current_scene_id})
			configuration.erase("ticket")
			OS.unset_environment("WA_NATIVE_CLIENT_CONFIG")
		while peer.get_available_packet_count() > 0:
			var packet = JSON.parse_string(peer.get_packet().get_string_from_utf8())
			if packet is Dictionary: receive(packet)
		heartbeat += delta
		if heartbeat >= 5.0:
			heartbeat = 0.0
			send({"type":"ping"})
	elif state == WebSocketPeer.STATE_CLOSED:
		if connected:
			active = false
			runtime.shared.receive({"action":"disconnect"})
			stop_with_error("共享连接已断开；服务器保留世界进度，请重新接续")
		elif elapsed > 15.0: stop_with_error("共享世界连接超时")
	if not active and phase in ["loading", "preparing", "prepare", "commit", "activating"] and elapsed > 90.0:
		stop_with_error("客户端准备超时，未声明已接管控制")
	telemetry_clock += delta
	if active and telemetry_clock >= 1.0:
		telemetry_clock = 0.0
		var snapshot: Dictionary = runtime.shared.latest
		var detail = {"world_id":runtime.shared.world_id, "epoch":runtime.shared.epoch, "tick":snapshot.get("tick", 0), "sequence":snapshot.get("sequence", 0), "scene_generation":snapshot.get("scene_generation", 0), "players":snapshot.get("players", {})}
		var nodes: Dictionary = snapshot.get("nodes", {})
		if JSON.stringify(nodes).length() < 48000: detail.nodes = nodes
		else: detail.nodes_truncated = true
		report("active", detail)

func receive(message: Dictionary) -> void:
	if message.get("type") == "native_client_error":
		if active: report("input_rejected", {"error":str(message.get("error", "输入被拒绝"))})
		else: stop_with_error(str(message.get("error", "接续失败")))
		return
	if message.get("type") != "world": return
	var packet: Dictionary = message.get("packet", {})
	match packet.get("action", ""):
		"join":
			active = false
			elapsed = 0.0
			phase = str(packet.get("native_client_phase", "restore"))
			report("applying_baseline", {"phase":phase, "world_id":packet.world_id, "epoch":packet.epoch, "sequence":packet.snapshot.sequence})
			runtime.shared.receive(packet)
		"active":
			runtime.shared.receive(packet)
			if runtime.shared.active:
				pending_control = packet.duplicate(true)
				phase = "activating"
				active = false
				send({"type":"active_applied", "packet":boundary_packet(packet)})
		"control_confirmed":
			if pending_control.get("control_generation") != packet.get("control_generation") or pending_control.get("world_id") != packet.get("world_id") or pending_control.get("epoch") != packet.get("epoch") or pending_control.get("scene_revision") != packet.get("scene_revision"): return
			active = runtime.shared.active
			if active:
				phase = "active"
				report("active", {"world_id":packet.world_id, "epoch":packet.epoch, "sequence":runtime.shared.latest.get("sequence", 0), "scene_generation":runtime.generation})
		"snapshot", "input_ack": runtime.shared.receive(packet)
		"control_pending":
			active = false
			phase = "handoff_pending"
			runtime.shared.receive({"action":"disconnect"})
			report("handoff_pending")
		"control_transferred":
			active = false
			phase = "transferred"
			runtime.shared.receive({"action":"disconnect"})
			report("transferred", {"transfer_id":packet.get("transfer_id", "")})
		"transfer":
			active = false
			phase = "upgrade_required"
			runtime.shared.receive({"action":"disconnect"})
			report("upgrade_required", {"manifest":packet.get("manifest", {})})
		"error": stop_with_error(str(packet.get("error", "共享世界需要恢复")))

func game_packet(packet: Dictionary) -> void:
	if packet.get("type") == "shared_ready":
		# Emitted only after NativeSharedClient applies the actual snapshot.
		send({"type":"native_ready", "packet":boundary_packet(packet)})
	elif packet.get("type") == "native_shared":
		var input: Dictionary = packet.get("packet", {})
		if input.get("action") == "input" and active:
			send({"type":"world_input", "input":input})
		elif input.get("action") == "applied": send({"type":"applied", "packet":input})

func _exit_tree() -> void:
	finished = true
	peer.close()
