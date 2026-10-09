extends Node3D
## A fixed release runs its own real simulation. No workbench, network session,
## online player state, or credentials participate in this local state domain.
const LocalLoader = preload("res://local_scene_loader.gd")
const Simulation = preload("res://world_simulation.gd")
const WorldView = preload("res://world_projection.gd")
const FONT = preload("res://fonts/CreatorUI.tres")
const DebugBridge = preload("res://game_debug_bridge.gd")
const GAME_SCENE = preload("res://standalone.tscn")
const SharedWorker = preload("res://native_shared_worker.gd")
const SharedClient = preload("res://native_shared_client.gd")
const NativeSession = preload("res://native_game_session.gd")

class LocalSession extends RefCounted:
	# WorldProjection uses these to reject superseded preparations. This is the
	# current snapshot produced by our actual local simulation, never an ACK.
	var latest: Dictionary = {}
	var wanted_play = true

var shared: Node
var game_scene: Node
var debug: Node
var launch_entry = ""
var origin = ""
var asset_cache: Dictionary = {}
var world_client = LocalSession.new()
var release: Dictionary = {}
var scene_ids: Array = []
var current_scene_id = ""
var simulation: Node
var projection: Node
var camera: Camera3D
var title_label: Label
var detail_label: Label
var status_label: Label
var scene_picker: OptionButton
var running = false
var loading = false
var generation = 0
var telemetry_elapsed = 0.0
var last_published_telemetry: Dictionary = {}
var failure = ""
var faulted = false
var runtime_fault: Dictionary = {}
var native_mode = false
var native_logger: RuntimeLogger
var pending_native_error: Dictionary = {}

class RuntimeLogger extends Logger:
	var owner_ref: WeakRef
	func _init(value: Node) -> void: owner_ref = weakref(value)
	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		if error_type == Logger.ERROR_TYPE_WARNING: return
		var owner = owner_ref.get_ref()
		if owner != null and owner.native_mode:
			if owner.shared != null and not owner.shared.is_client and owner.shared.error_transaction:
				owner.shared.transaction_errors.append({"error":rationale if rationale != "" else code,"file":file,"line":line})
				return
			owner.call_deferred("_native_error", {"role":"native","error":rationale if rationale != "" else code,"function":function,"file":file,"line":line,"scene_generation":owner.generation})


func _enter_tree() -> void:
	# Install before any child lifecycle and creator-owned Controls resolve fonts.
	ThemeDB.fallback_font = FONT
	ThemeDB.get_default_theme().default_font = FONT

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	native_logger = RuntimeLogger.new(self)
	OS.add_logger(native_logger)
	get_tree().scene_changed.connect(_external_scene_changed)
	debug = DebugBridge.new()
	add_child(debug)
	debug.setup(self)
	var file = FileAccess.open("res://release.json",FileAccess.READ)
	if file == null:
		show_error("无法读取 release.json。请重新导出完整的工程或应用。")
		return
	var json = JSON.new()
	var code = json.parse(file.get_as_text())
	file.close()
	if code != OK or not json.data is Dictionary:
		show_error("发行清单不是有效的 JSON："+json.get_error_message())
		return
	release = json.data
	if not release.get("scenes") is Dictionary or release.scenes.is_empty() or not release.get("assets") is Dictionary or not release.get("revision") is String:
		show_error("发行清单缺少 scenes、assets 或固定 revision。")
		return
	var entry = release.get("entry_scene_id","")
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--release-scene="):
			entry = argument.trim_prefix("--release-scene=")
	if not entry is String or not release.scenes.has(entry):
		show_error("发行清单没有有效的入口场景或指定验证资源："+str(entry))
		return
	DisplayServer.window_set_title(str(release.get("project_name","游戏")))
	for id in release.scenes:
		if not release.scenes[id] is Dictionary:
			show_error("发行清单中场景内容不合法："+str(id))
			return
		if release.scenes[id].get("kind","scene") == "scene":
			scene_ids.append(id)

	launch_entry = entry
	if release.has("native_shared"):
		shared = SharedClient.new() if release.native_shared.get("role") == "client" else SharedWorker.new()
		add_child(shared)
		shared.start(self)
		return
	debug.bootstrap_ready()
	if not debug.embedded: begin.call_deferred()

func begin() -> void:
	# The initial scene enters through Godot's configured main scene. The same
	# loader is then used by native F5, exports, scene picker and embedded Play.
	if get_tree().current_scene == null: await get_tree().process_frame
	await open_scene(launch_entry)

func receive(packet: Dictionary) -> void:
	debug.receive(packet)

func scene_detached(value: Node) -> void:
	if value != game_scene: return
	if is_instance_valid(simulation): simulation.behaviors.dispose()
	if is_instance_valid(projection) and projection != simulation: projection.behaviors.dispose()
	if is_instance_valid(simulation) and simulation.get_script() == NativeSession: simulation.queue_free()
	simulation = null
	projection = null
	running = false

func list_scenes() -> Array:
	return list_resources("scene")

func list_prefabs() -> Array:
	return list_resources("prefab")

func list_resources(kind: String) -> Array:
	var result: Array = []
	for id in release.get("scenes",{}):
		var document: Dictionary = release.scenes[id]
		if document.get("kind","scene")==kind:
			result.append({"id":id,"name":document.get("name",document.get("title",id)),"kind":kind,"revision":release.revision})
	return result

func setup_environment() -> void:
	var environment = WorldEnvironment.new()
	environment.environment = Environment.new()
	environment.environment.background_mode = Environment.BG_COLOR
	environment.environment.background_color = Color("17283b")
	environment.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.environment.ambient_light_color = Color("afc5e8")
	environment.environment.ambient_light_energy = .7
	game_scene.add_child(environment)
	var sun = DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-52,-25,0)
	sun.light_color = Color("fff0d9")
	sun.light_energy = 1.25
	sun.shadow_enabled = true
	game_scene.add_child(sun)
	var floor_mesh = MeshInstance3D.new()
	var plane = PlaneMesh.new()
	plane.size = Vector2(2000,2000)
	floor_mesh.mesh = plane
	var material = StandardMaterial3D.new()
	material.albedo_color = Color("263b49")
	material.roughness = .95
	floor_mesh.material_override = material
	floor_mesh.position.y = -.051
	game_scene.add_child(floor_mesh)
	# Static fallback only. Authored game cameras own their view and input.
	camera = Camera3D.new()
	camera.name = "FallbackCamera"
	camera.current = true
	camera.fov = 65
	camera.far = 3000
	game_scene.add_child(camera)
	camera.position = Vector3(0,7,11)
	camera.look_at(Vector3(0,1,0))

func setup_interface() -> void:
	var canvas = CanvasLayer.new()
	game_scene.add_child(canvas)
	var ui = Control.new()
	ui.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	ui.mouse_filter = Control.MOUSE_FILTER_IGNORE
	canvas.add_child(ui)
	var theme = Theme.new()
	theme.default_font = FONT
	theme.default_font_size = 17
	ui.theme = theme
	var margin = MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	for side in ["left","right","top","bottom"]: margin.add_theme_constant_override("margin_"+side,20)
	margin.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ui.add_child(margin)
	var stack = VBoxContainer.new()
	stack.mouse_filter = Control.MOUSE_FILTER_IGNORE
	margin.add_child(stack)
	var row = HBoxContainer.new()
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	stack.add_child(row)
	title_label = Label.new()
	title_label.text = str(release.get("project_name","游戏"))
	title_label.add_theme_font_size_override("font_size",24)
	title_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(title_label)
	scene_picker = OptionButton.new()
	for id in scene_ids:
		scene_picker.add_item(str(release.scenes[id].get("name",release.scenes[id].get("title",id))))
	scene_picker.visible = scene_ids.size()>1
	scene_picker.select(scene_ids.find(current_scene_id))
	scene_picker.focus_mode = Control.FOCUS_NONE
	scene_picker.item_selected.connect(func(index): open_scene(scene_ids[index]))
	row.add_child(scene_picker)
	var restart = Button.new()
	restart.text = "重新开始"
	restart.focus_mode = Control.FOCUS_NONE
	restart.pressed.connect(func():
		if not current_scene_id.is_empty(): open_scene(current_scene_id)
	)
	row.add_child(restart)
	detail_label = Label.new()
	detail_label.text = "%s · %s"%[release.get("branch_id",""),str(release.get("revision","")).left(12)]
	detail_label.modulate = Color("a8bed0")
	stack.add_child(detail_label)
	status_label = Label.new()
	status_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	stack.add_child(status_label)

func open_scene(id: String) -> void:
	if loading or not release.scenes.has(id): return
	debug.restore_inspection(true)
	debug.clear_fault_notice()
	faulted = false
	runtime_fault = {}
	loading = true
	running = false
	failure = ""
	generation += 1
	# Resolve and validate resources before replacing the current Godot scene.
	var loader = LocalLoader.new()
	loader.bundled_assets = release.assets
	loader.asset_cache = asset_cache
	var document: Dictionary = release.scenes[id].duplicate(true)
	if document.get("document_schema") == "creation-native-1" and document.has("native_scene_path"):
		await _open_native_scene(id, document)
		return
	native_mode = false
	var candidate = await loader.prepare(self,document,origin)
	if not candidate.ok:
		loading = false
		show_error(str(candidate.error))
		return
	if game_scene != null:
		# Godot removes/frees the old scene and runs the new scene's complete
		# enter-tree/ready lifecycle. The Autoload and immutable cache survive.
		var result = get_tree().change_scene_to_packed(GAME_SCENE)
		if result != OK:
			candidate.root.free()
			loading = false
			show_error("无法切换游戏场景："+error_string(result))
			return
		await get_tree().scene_changed
	game_scene = get_tree().current_scene
	current_scene_id = id
	setup_environment()
	setup_interface()
	var next_simulation = Simulation.new()
	next_simulation.name = "Simulation"
	next_simulation.visible = false
	next_simulation.world_id = debug.world_id if debug.started else "offline:"+str(release.get("project_id","game"))+":"+id
	next_simulation.epoch = debug.epoch if debug.started else generation
	next_simulation.scene_revision = str(document.get("scene_revision",release.revision))
	game_scene.add_child(next_simulation)
	simulation = next_simulation
	var problem: String = simulation.initialize(candidate)
	if not problem.is_empty():
		loading = false
		show_error(problem)
		return
	# Characters and controls belong to authored scene behaviors. Loading a
	# scene never joins a framework player or installs a gameplay InputMap.
	var state: Dictionary = simulation.snapshot()
	world_client.latest = state
	projection = WorldView.new()
	projection.name = "Presentation"
	projection.loader = LocalLoader.new()
	projection.loader.bundled_assets = release.assets
	game_scene.add_child(projection)
	var prepared: bool = await projection.prepare(document,state,self)
	if not prepared:
		loading = false
		show_error(projection.error)
		return
	asset_cache = loader.asset_cache
	loading = false
	running = true
	simulation.active = true
	status_label.text = ""
	print("STANDALONE_READY "+JSON.stringify({"project_id":release.get("project_id"),"branch_id":release.get("branch_id"),"revision":release.revision,"scene_id":id,"objects":simulation.objects.size(),"assets":simulation.assets.size(),"behavior_hashes":simulation.behaviors.hashes}))
	debug.scene_loaded(document)
	publish_telemetry()

func show_error(message: String) -> void:
	running = false
	failure = message
	if is_instance_valid(status_label):
		status_label.text = "游戏加载或运行失败\n"+message
		status_label.modulate = Color("ffa9a0")
	push_error("STANDALONE_FAILED "+message)
	if is_instance_valid(debug): debug.emit({"type":"error","code":"game_runtime","message":message,"document_id":debug.document_id,"seq":debug.seq})
	publish_telemetry()

func show_runtime_fault(message: String, detail: Dictionary = {}) -> void:
	# The initialized scene is still a useful observation. Preserve it and stop
	# execution once; only bootstrap/resource failures reject the whole iframe.
	if faulted: return
	faulted = true
	failure = message
	runtime_fault = detail.duplicate(true)
	if runtime_fault.is_empty(): runtime_fault = {"role":"runtime","error":message}
	debug.enter_inspection()
	debug.show_fault_notice(message)
	print("STANDALONE_RUNTIME_FAULT "+JSON.stringify(runtime_fault))
	publish_telemetry()

func _physics_process(delta: float) -> void:
	if shared != null and shared.is_client: return
	if not running or simulation == null or debug.inspecting or faulted: return
	if native_mode:
		if get_tree().paused: return
		simulation.step(delta)
		world_client.latest = simulation.snapshot(true)
		if not simulation.last_fault.is_empty(): show_runtime_fault("玩法脚本错误："+JSON.stringify(simulation.last_fault),simulation.last_fault)
		return
	simulation.step(delta)
	world_client.latest = simulation.snapshot(true)
	projection.apply_snapshot(world_client.latest)
	for event in simulation.take_events(): projection.apply_event(event)
	if not simulation.last_fault.is_empty():
		show_runtime_fault("玩法脚本错误："+JSON.stringify(simulation.last_fault),simulation.last_fault)
	elif not projection.behaviors.fault.is_empty():
		show_runtime_fault("表现脚本错误："+JSON.stringify(projection.behaviors.fault),projection.behaviors.fault)

func _process(delta: float) -> void:
	if shared != null and shared.is_client: return
	if not running or projection == null: return
	if not debug.inspecting and not faulted:
		if not native_mode or not get_tree().paused: projection.advance(delta)
		if not projection.behaviors.fault.is_empty():
			show_runtime_fault("表现脚本错误："+JSON.stringify(projection.behaviors.fault),projection.behaviors.fault)
			return
	# Observation is independent of gameplay processing. A paused/faulted run
	# still publishes the same current state to its parent and standalone JS.
	telemetry_elapsed += delta
	if telemetry_elapsed >= .25:
		telemetry_elapsed = 0
		publish_telemetry()

func telemetry() -> Dictionary:
	var result = {"source":"world-atelier-standalone","ready":running,"faulted":faulted,"runtime_fault":runtime_fault,"error":failure,"project_id":release.get("project_id"),"branch_id":release.get("branch_id"),"revision":release.get("revision"),"scene_id":current_scene_id,"tick":0,"runtime_source_hash":release.get("runtime_source_hash"),"inspecting":debug.inspecting if is_instance_valid(debug) else false,"content_key":release.get("content_key",""),"canonical_identity":release.get("canonical_identity",""),"game_identity":release.get("game_identity",{})}
	if simulation != null:
		result.tick = simulation.tick
		result.scene_revision = simulation.scene_revision
		result.object_states = simulation.behaviors.snapshot()
		result.rendered_players = projection.rendered_players() if projection != null else {}
	return result

func publish_telemetry() -> void:
	last_published_telemetry = telemetry()
	if is_instance_valid(debug): debug.emit_state()
	if OS.has_feature("web"):
		JavaScriptBridge.eval("window.worldAtelierRelease = "+JSON.stringify(last_published_telemetry)+";",true)

func _exit_tree() -> void:
	if native_logger != null: OS.remove_logger(native_logger)
	if is_instance_valid(simulation): simulation.behaviors.dispose()
	if is_instance_valid(projection) and projection != simulation: projection.behaviors.dispose()

func _open_native_scene(id: String, document: Dictionary) -> void:
	var native_path := str(document.get("native_scene_path", ""))
	if shared != null and shared.is_client: native_path = str(release.native_shared.scenes.get(id,""))
	if not native_path.begins_with("res://") or native_path.contains("..") or not (native_path.ends_with(".tscn") or native_path.ends_with(".scn")):
		loading = false
		show_error("原生场景路径无效："+native_path)
		return
	var packed: PackedScene = ResourceLoader.load(native_path, "PackedScene")
	if packed == null:
		loading = false
		show_error("无法加载原生游戏场景："+native_path)
		return
	# Dispose API1 before native nodes leave; the authored scene owns lifecycle.
	if game_scene != null: scene_detached(game_scene)
	native_mode = true
	pending_native_error = {}
	var defaults_callback=Callable()
	if shared != null and not shared.is_client:
		defaults_callback=shared.prepare_node_defaults.bind(id)
		get_tree().node_added.connect(defaults_callback)
	var result := get_tree().change_scene_to_packed(packed)
	if result != OK:
		if defaults_callback.is_valid():get_tree().node_added.disconnect(defaults_callback)
		loading = false
		show_error("无法切换原生游戏场景："+error_string(result))
		return
	await get_tree().scene_changed
	if defaults_callback.is_valid():get_tree().node_added.disconnect(defaults_callback)
	_finish_native_scene(id,document)

func _finish_native_scene(id: String, document: Dictionary) -> void:
	game_scene = get_tree().current_scene
	if game_scene == null:
		loading = false
		show_error("原生场景没有进入 SceneTree")
		return
	current_scene_id = id
	game_scene.tree_exiting.connect(scene_detached.bind(game_scene), CONNECT_ONE_SHOT)
	var session = NativeSession.new()
	session.name = "NativeGameObservation"
	add_child(session)
	simulation = session
	projection = session
	var problem: String = session.initialize(self,game_scene,document)
	if not problem.is_empty():
		loading = false
		show_error(problem)
		return
	if _contains_3d(game_scene) and (get_viewport().get_camera_3d() == null or get_viewport().get_camera_3d() == debug.camera):
		camera = Camera3D.new()
		camera.name = "FallbackCamera"
		game_scene.add_child(camera)
		camera.position = Vector3(0,7,11)
		camera.look_at(Vector3(0,1,0))
		camera.make_current()
	loading = false
	running = true
	session.active = true
	world_client.latest = session.snapshot()
	print("STANDALONE_READY "+JSON.stringify({"project_id":release.get("project_id"),"branch_id":release.get("branch_id"),"revision":release.revision,"scene_id":id,"native_scene_path":document.native_scene_path,"scene_generation":generation,"objects":session.objects.size(),"assets":session.assets.size(),"behavior_hashes":session.behaviors.hashes}))
	debug.scene_loaded(document)
	if not pending_native_error.is_empty():
		show_runtime_fault("原生玩法脚本错误："+str(pending_native_error.get("error","")),pending_native_error)
	publish_telemetry()

func _contains_3d(node: Node) -> bool:
	if node is Node3D: return true
	for child in node.get_children():
		if _contains_3d(child): return true
	return false

func _external_scene_changed() -> void:
	if loading or not native_mode or get_tree().current_scene == game_scene: return
	var actual := get_tree().current_scene
	if actual == null: return
	debug.restore_inspection(true)
	generation += 1
	for id in release.scenes:
		var document: Dictionary = release.scenes[id]
		if document.get("native_scene_path", "") == actual.scene_file_path:
			faulted = false
			failure = ""
			runtime_fault = {}
			pending_native_error = {}
			_finish_native_scene(str(id),document)
			return
	game_scene = actual
	current_scene_id = ""
	running = false
	show_error("当前场景不在固定工程的场景目录中："+actual.scene_file_path)

func _native_error(detail: Dictionary) -> void:
	if not native_mode or int(detail.get("scene_generation",-1)) != generation: return
	if str(detail.get("error","")).begins_with("STANDALONE_FAILED"): return
	pending_native_error = detail
	if running and not faulted: show_runtime_fault("原生玩法脚本错误："+str(detail.get("error","")),detail)

func freeze_gameplay(value: bool) -> void:
	if shared != null and shared.is_client: return
	if not is_instance_valid(simulation): return
	simulation.active = not value and not faulted
	if native_mode:
		simulation.freeze(value)
	else:
		simulation.behaviors.freeze(value)
		if is_instance_valid(projection): projection.behaviors.freeze(value)
