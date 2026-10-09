extends SceneTree

var host: Node
var checks: Array = []
var out = ""
var scope = ""

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--out="): out=arg.substr(6)
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":scope+": "+detail})
	if not ok: print("VIEWPORT_NAVIGATION_FAILED "+scope+": "+detail)

func button(at: Vector2, index: int, pressed: bool, modifiers: String = "", factor: float = 1.0) -> void:
	var event=InputEventMouseButton.new()
	event.button_index=index
	event.pressed=pressed
	event.position=at
	event.factor=factor
	event.shift_pressed=modifiers=="shift"
	event.alt_pressed=modifiers=="alt"
	host._input(event)

func motion(at: Vector2, delta: Vector2, index: int, modifiers: String = "") -> void:
	var event=InputEventMouseMotion.new()
	event.position=at
	event.relative=delta
	event.button_mask=1 << (index-1) if index else 0
	event.shift_pressed=modifiers=="shift"
	event.alt_pressed=modifiers=="alt"
	host._input(event)

func key(code: int, pressed: bool) -> void:
	var event=InputEventKey.new()
	event.keycode=code
	event.physical_keycode=code
	event.pressed=pressed
	Input.parse_input_event(event)
	Input.flush_buffered_events()
	host._input(event)

func release_keys() -> void:
	for code in [KEY_W,KEY_A,KEY_S,KEY_D,KEY_Q,KEY_E,KEY_SHIFT,KEY_ALT,KEY_SPACE]: key(code,false)

func commits() -> int:
	return host.outbound_log.filter(func(packet):return packet.get("type")=="transform" and packet.get("phase")=="commit").size()

func selections() -> int:
	return host.outbound_log.filter(func(packet):return packet.get("type")=="selected").size()

func new_host(native: bool, canvas: bool = false) -> void:
	host=load("res://native_main.gd" if native else "res://main.gd").new()
	root.add_child(host)
	host.set_process(false)
	host.set_process_input(false)
	host.document_id="independent/main/navigation"
	host.applied_seq=1
	host.requested_seq=1
	host.editor_tool="move"
	if native:
		host.native_active=true
		host.native_document={"source_identity":"navigation-fixed-v1","source_revision":"navigation-fixed-v1"}
		host.authored_root=host.scene_root
		host.canvas_mode=canvas
	host.update_camera()

func settings(speed: Variant, extra: Dictionary = {}) -> void:
	var packet={"source":"world-atelier-workspace","nonce":host.nonce,"type":"navigation_settings","seq":1,"document_id":host.document_id,"camera_speed":speed}
	packet.merge(extra,true)
	host.receive(packet)

func reset3(distance: float = 12.0) -> void:
	host.cancel_drag()
	release_keys()
	host.target=Vector3(2,3,-4)
	host.yaw=.65
	host.pitch=.48
	host.distance=distance
	host.camera_view="perspective"
	host.camera.projection=Camera3D.PROJECTION_PERSPECTIVE
	host.update_camera()

func drag(at: Vector2, delta: Vector2, index: int, modifiers: String = "") -> void:
	button(at,index,true,modifiers)
	motion(at+delta,delta,index,modifiers)
	button(at+delta,index,false,modifiers)

func fly_for(speed: float, distance: float = 12.0, modifier: int = 0) -> float:
	reset3(distance)
	host.camera_speed=speed
	button(Vector2(500,350),MOUSE_BUTTON_RIGHT,true)
	if modifier: key(modifier,true)
	key(KEY_W,true)
	var before: Vector3=host.camera.position
	host._process(.1)
	var travelled: float=before.distance_to(host.camera.position)
	key(KEY_W,false)
	if modifier:key(modifier,false)
	button(Vector2(500,350),MOUSE_BUTTON_RIGHT,false)
	return travelled

func controller_travel(steps: int) -> Vector3:
	var controller=load("res://editor_navigation.gd").new()
	var result=Vector3.ZERO
	for i in steps: result+=controller.step(Vector3.FORWARD,6.0,1.0/steps)
	return result

func exercise_response() -> void:
	scope="navigation response"
	var controller=load("res://editor_navigation.gd").new()
	var sixty=controller_travel(60)
	check(sixty.distance_to(controller_travel(30))<.00001,"30 and 60 FPS integrate the same one-second travel")
	check(sixty.distance_to(controller_travel(144))<.00001,"144 FPS integrates the same one-second travel")
	check(absf(sixty.length()-5.73)<.00001,"45 ms response reaches the analytically expected one-second distance")
	var diagonal=controller.step(Vector3(1,0,-1),6.0,1.0/60.0)
	controller.reset()
	check(absf(diagonal.length()-controller.step(Vector3.FORWARD,6.0,1.0/60.0).length())<.000001,"diagonal input never increases movement speed")
	controller.reset()
	for i in 60: controller.step(Vector3.FORWARD,6.0,1.0/60.0)
	var released=Vector3.ZERO
	for i in 60: released+=controller.step(Vector3.ZERO,6.0,1.0/60.0)
	check(released.length()<=.120001,"release drift is bounded by 20 ms at the previous 6 m/s speed")
	check(controller.velocity.is_zero_approx(),"released movement settles fully to rest")
	controller.response=0
	check(controller.step(Vector3.FORWARD,6,.025).is_equal_approx(Vector3.FORWARD*.15),"direct response applies requested travel in the same frame")
	check(controller.step(Vector3.ZERO,6,.025).is_zero_approx(),"direct response stops in the release frame")
	check(controller.step(Vector3.FORWARD,6,-1).is_zero_approx(),"negative delta produces no travel")
	check(controller.step(Vector3.FORWARD,6,1).is_equal_approx(Vector3.FORWARD*.6),"long hitch movement is capped at 100 ms")
	controller.reset()
	controller.begin_capture()
	check(not controller.captured and Input.mouse_mode==Input.MOUSE_MODE_VISIBLE,"headless native navigation never captures the desktop pointer")
	controller.captured=true
	controller._pointer_lock_changed([true,false])
	check(controller.lock_confirmed,"confirmed browser capture is recorded")
	controller._pointer_lock_changed([false,false])
	check(controller.capture_lost,"browser consumed Escape still signals capture loss")
	controller.reset()
	check(not controller.capture_lost and not controller.lock_confirmed,"capture reset clears old browser acknowledgements")
	controller.captured=true
	controller._pointer_lock_changed([false,true])
	check(controller.capture_lost,"denied capture signals exit even without an earlier lock grant")
	controller.reset()
	controller._pointer_lock_changed([true,false])
	check(not controller.captured and Input.mouse_mode==Input.MOUSE_MODE_VISIBLE,"a late capture grant after release is cancelled")

func exercise_middle_pan(view: String, orthographic: bool = false, modifiers: String = "") -> void:
	reset3()
	if view!="perspective":
		host.receive({"source":"world-atelier-workspace","nonce":host.nonce,"type":"camera","seq":1,"document_id":host.document_id,"action":view})
	elif orthographic:
		host.camera.projection=Camera3D.PROJECTION_ORTHOGONAL
		host.camera.size=9.25
		host.update_camera()
	var name=("Shift-middle" if modifiers=="shift" else "middle")+" "+view+(" orthographic" if orthographic else "")
	var at=Vector2(460,300)
	var delta=Vector2(60,-25)
	var eye: Vector3=host.camera.position
	var pivot: Vector3=host.target
	var basis: Basis=host.camera.basis
	var previous_yaw: float=host.yaw
	var previous_pitch: float=host.pitch
	var projection: int=host.camera.projection
	var distance: float=host.distance
	var size: float=host.camera.size
	var projected_before: Vector2=host.camera.unproject_position(pivot)
	button(at,MOUSE_BUTTON_MIDDLE,true,modifiers)
	check(host.navigation=="pan",name+" enters camera pan")
	motion(at+delta,delta,MOUSE_BUTTON_MIDDLE,modifiers)
	var travel: Vector3=host.camera.position-eye
	check(travel.length()>.00001,name+" translates the camera")
	check(travel.distance_to(host.target-pivot)<.00001,name+" translates eye and target equally")
	check(absf(travel.dot(basis.z))<.00001,name+" stays in the original camera image plane")
	check(host.camera.unproject_position(pivot).distance_to(projected_before+delta)<.001,name+" moves a fixed focus-plane point by the exact pointer delta")
	check(host.camera.basis==basis,name+" exactly preserves viewing rotation")
	check(host.yaw==previous_yaw and host.pitch==previous_pitch,name+" exactly preserves yaw and pitch")
	check(host.camera.projection==projection and host.camera_view==view,name+" preserves projection and preset view")
	check(host.distance==distance and host.camera.size==size,name+" exactly preserves focus distance and orthographic scale")
	button(at+delta,MOUSE_BUTTON_MIDDLE,false,modifiers)
	check(host.button_down==0 and host.navigation.is_empty(),name+" release exits pan")
	drag(at+delta,-delta,MOUSE_BUTTON_MIDDLE,modifiers)
	check(host.camera.position.distance_to(eye)<.00001 and host.target.distance_to(pivot)<.00001,name+" reversed drag restores eye and target")

func exercise3(native: bool) -> void:
	scope="native 3D" if native else "legacy 3D"
	new_host(native)
	check(is_equal_approx(host.camera_speed,6.0),"initial fly speed is 6 metres per second")
	settings(24)
	check(is_equal_approx(host.camera_speed,24),"scoped navigation settings update fly speed")
	check(host.outbound_log[-1].get("camera_speed")==24,"camera receipt reports the configured speed")
	settings(70,{"seq":2})
	settings(70,{"document_id":"independent/other/navigation"})
	check(is_equal_approx(host.camera_speed,24),"foreign scene and generation settings are ignored")
	for value in [NAN,INF,"12"]: settings(value)
	check(is_equal_approx(host.camera_speed,24),"nonfinite and nonnumeric settings preserve valid speed")
	settings(-1)
	check(is_equal_approx(host.camera_speed,.1),"speed is clamped to a positive minimum")
	settings(1200)
	check(is_equal_approx(host.camera_speed,1000),"speed is clamped to the supported maximum")
	settings(6)
	var authored=Node3D.new()
	host.scene_root.add_child(authored)
	authored.position=Vector3(8,9,10)
	var source_pose=authored.transform
	var start_commits=commits()
	var start_selection=selections()
	var at=Vector2(460,300)
	reset3()
	var eye: Vector3=host.camera.position
	var basis: Basis=host.camera.basis
	drag(at,Vector2(60,-25),MOUSE_BUTTON_RIGHT)
	check(host.camera.position.is_equal_approx(eye),"right-drag freelook keeps the eye stationary")
	check(not host.camera.basis.is_equal_approx(basis),"right-drag changes the viewing direction")
	check(host.button_down==0,"right release ends navigation")
	for view in ["perspective","front","top","right"]: exercise_middle_pan(view)
	exercise_middle_pan("perspective",true)
	exercise_middle_pan("perspective",false,"shift")
	reset3()
	var pivot: Vector3=host.target
	eye=host.camera.position
	basis=host.camera.basis
	var radius: float=eye.distance_to(pivot)
	button(at,MOUSE_BUTTON_LEFT,true,"alt")
	check(host.navigation=="orbit","Alt-left retains orbit gesture")
	motion(at+Vector2(-40,20),Vector2(-40,20),MOUSE_BUTTON_LEFT,"alt")
	check(host.target.is_equal_approx(pivot),"Alt-left orbit preserves the pivot")
	check(not host.camera.position.is_equal_approx(eye) and not host.camera.basis.is_equal_approx(basis),"Alt-left orbit changes eye position and viewing rotation")
	check(is_equal_approx(host.camera.position.distance_to(pivot),radius),"Alt-left orbit preserves distance to the pivot")
	button(at+Vector2(-40,20),MOUSE_BUTTON_LEFT,false,"alt")
	check(host.button_down==0 and host.navigation.is_empty(),"Alt-left release exits orbit")
	reset3()
	radius=host.distance
	button(at,MOUSE_BUTTON_WHEEL_UP,true)
	check(host.distance<radius,"ordinary wheel zoom moves toward the pivot")
	button(at,MOUSE_BUTTON_WHEEL_DOWN,true)
	check(is_equal_approx(host.distance,radius),"opposite wheel steps have reciprocal zoom")
	reset3()
	host.camera_speed=6
	button(at,MOUSE_BUTTON_RIGHT,true)
	eye=host.camera.position
	radius=host.distance
	button(at,MOUSE_BUTTON_WHEEL_UP,true)
	check(host.camera_speed>6,"wheel while right held increases fly speed")
	check(host.camera.position.is_equal_approx(eye) and is_equal_approx(host.distance,radius),"changing fly speed does not zoom the camera")
	check(host.button_down==MOUSE_BUTTON_RIGHT,"speed adjustment keeps right-button navigation active")
	button(at,MOUSE_BUTTON_RIGHT,false)
	var normal=fly_for(6)
	check(normal>0,"physical W moves the camera while right held")
	var twice=fly_for(12)
	check(is_equal_approx(twice,normal*2),"doubling configured speed doubles travelled distance")
	check(is_equal_approx(fly_for(6,120),normal),"fly speed is independent of orbit distance")
	check(fly_for(6,12,KEY_SHIFT)>normal,"Shift accelerates fly movement")
	check(fly_for(6,12,KEY_ALT)<normal,"Alt slows fly movement")
	reset3()
	button(at,MOUSE_BUTTON_RIGHT,true)
	key(KEY_W,true)
	host._notification(NOTIFICATION_APPLICATION_FOCUS_OUT)
	eye=host.camera.position
	host._process(.1)
	check(host.camera.position.is_equal_approx(eye) and host.button_down==0,"focus loss stops held-key flight")
	release_keys()
	for exit_kind in ["release","escape","window-focus-out","lost-button","pointer-lock-lost"]:
		reset3()
		button(at,MOUSE_BUTTON_RIGHT,true)
		key(KEY_W,true)
		host._process(.08)
		check(host.editor_navigation.velocity.length()>0,exit_kind+" begins with active velocity")
		# Exercise reset state without ever requesting native pointer capture.
		host.editor_navigation.captured=true
		if exit_kind=="release":button(at,MOUSE_BUTTON_RIGHT,false)
		elif exit_kind=="escape":key(KEY_ESCAPE,true);key(KEY_ESCAPE,false)
		elif exit_kind=="window-focus-out":host._notification(Node.NOTIFICATION_WM_WINDOW_FOCUS_OUT)
		elif exit_kind=="pointer-lock-lost":
			host.editor_navigation._pointer_lock_changed([true,false])
			host.editor_navigation._pointer_lock_changed([false,false])
			host._process(.016)
		else:motion(at,Vector2.ZERO,0)
		eye=host.camera.position
		host._process(.08)
		check(host.camera.position.is_equal_approx(eye),exit_kind+" leaves no residual movement even while W remains physically down")
		check(host.button_down==0 and host.navigation.is_empty() and host.editor_navigation.velocity.is_zero_approx(),exit_kind+" clears navigation and velocity")
		check(not host.editor_navigation.captured and Input.mouse_mode==Input.MOUSE_MODE_VISIBLE,exit_kind+" clears captured state and restores visible mode")
		release_keys()
	check(authored.transform.is_equal_approx(source_pose),"all navigation preserves authored transforms")
	check(commits()==start_commits,"navigation never emits a source transform commit")
	check(selections()==start_selection,"navigation never changes object selection")
	host.free()

func orbit_mesh(id: String, center: Vector3, native: bool) -> MeshInstance3D:
	var box=BoxMesh.new()
	box.size=Vector3(2,1.6,1.2)
	var arrays=box.get_mesh_arrays()
	var vertices: PackedVector3Array=arrays[Mesh.ARRAY_VERTEX]
	var geometry_offset=Vector3(1.1,.8,-.3)
	for index in vertices.size(): vertices[index]+=geometry_offset
	arrays[Mesh.ARRAY_VERTEX]=vertices
	var node=MeshInstance3D.new()
	node.name=id
	node.mesh=ArrayMesh.new()
	node.mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES,arrays)
	var indexed: Node3D=node
	if not native:
		# Legacy GLB objects have a transform root whose children own geometry.
		indexed=Node3D.new()
		indexed.name=id
		node.name="Geometry"
		indexed.add_child(node)
	host.scene_root.add_child(indexed)
	indexed.position=center-geometry_offset
	host.objects[id]=indexed
	host.definitions[id]={"id":id,"name":id,"parent_id":null,"kind":"mesh","version":"v1","native_path":str(host.scene_root.get_path_to(indexed)),"native_target":{"node_id":id,"instance_ids":[]},"dimension":"3d"}
	return node

func exercise_selection_orbit(native: bool) -> void:
	scope="native selected-object orbit" if native else "legacy selected-object orbit"
	new_host(native)
	reset3()
	var old_target: Vector3=host.target
	var desired_center=old_target+host.camera.basis.x*2.4+host.camera.basis.y*.8+host.camera.basis.z*1.5
	var chosen=orbit_mesh("chosen",desired_center,native)
	var other=orbit_mesh("other",old_target-host.camera.basis.x*4.0,native)
	host.select_objects(["other","chosen"],"chosen",false)
	var center: Vector3=chosen.global_transform*chosen.get_aabb().get_center()
	check(center.distance_to(old_target)>2 and center.distance_to(chosen.global_position)>1,"fixture bounds center differs from both observation focus and node origin")
	check(host.display_bounds("chosen").get_center().distance_to(center)<.00001,"engine display bounds resolve the actual offset Mesh geometry")
	var selected_before: Array=host.selected_ids.duplicate()
	var definitions_before: Dictionary=host.definitions.duplicate(true)
	var chosen_pose: Transform3D=host.objects.chosen.transform
	var other_pose: Transform3D=host.objects.other.transform
	var mesh_pose: Transform3D=chosen.transform
	var geometry_before: PackedVector3Array=chosen.mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX].duplicate()
	var source_events=host.outbound_log.filter(func(packet):return packet.get("type")=="transform").size()
	var selection_events=selections()
	var before: Transform3D=host.camera.global_transform
	var projected_before: Vector2=host.camera.unproject_position(center)
	var local_before: Vector3=before.affine_inverse()*center
	var radius: float=before.origin.distance_to(center)
	var previous_focus_radius: float=before.origin.distance_to(old_target)
	var at=projected_before
	button(at,MOUSE_BUTTON_LEFT,true,"alt")
	check(host.camera.global_transform==before and host.target==old_target,"Alt-left press does not jump or recenter the camera")
	check(host.camera.unproject_position(center).distance_to(projected_before)<.001,"Alt-left press preserves the selected object's screen position")
	check(host.orbit_pivot!=null and host.orbit_pivot.distance_to(center)<.00001,"gesture fixes the primary selected Mesh bounds center as its pivot")
	motion(at+Vector2(44,-18),Vector2(44,-18),MOUSE_BUTTON_LEFT,"alt")
	check(not host.camera.position.is_equal_approx(before.origin) and not host.camera.basis.is_equal_approx(before.basis),"selected-object orbit changes both camera position and orientation")
	check(absf(host.camera.position.distance_to(center)-radius)<.0001,"selected-object orbit preserves eye-to-object radius")
	check((host.camera.global_transform.affine_inverse()*center).distance_to(local_before)<.0001,"selected center retains its full camera-local coordinate")
	check(host.camera.unproject_position(center).distance_to(projected_before)<.005,"selected center remains at the same screen position throughout orbit")
	check(absf(host.camera.position.distance_to(old_target)-previous_focus_radius)>.01,"camera no longer revolves around the previous observation focus")
	button(at+Vector2(44,-18),MOUSE_BUTTON_LEFT,false,"alt")
	check(host.orbit_pivot==null and host.navigation.is_empty() and host.button_down==0,"release clears the selected-object orbit pivot")
	var released: Transform3D=host.camera.global_transform
	motion(at+Vector2(60,-24),Vector2(16,-6),MOUSE_BUTTON_LEFT,"alt")
	check(host.camera.global_transform==released,"motion after release cannot continue an old orbit")
	button(at,MOUSE_BUTTON_LEFT,true,"alt")
	motion(at+Vector2(-12,8),Vector2(-12,8),MOUSE_BUTTON_LEFT,"alt")
	key(KEY_ESCAPE,true)
	key(KEY_ESCAPE,false)
	check(host.orbit_pivot==null and host.navigation.is_empty() and host.button_down==0,"Escape clears the selected-object orbit pivot")
	var cancelled: Transform3D=host.camera.global_transform
	motion(at+Vector2(20,20),Vector2(20,20),MOUSE_BUTTON_LEFT,"alt")
	check(host.camera.global_transform==cancelled,"motion after cancellation cannot continue an old orbit")
	check(host.objects.chosen.transform==chosen_pose and host.objects.other.transform==other_pose and chosen.transform==mesh_pose,"selected-object orbit preserves every authored transform")
	check(chosen.mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX]==geometry_before and host.definitions==definitions_before,"selected-object orbit preserves Mesh vertices and source definitions")
	check(host.selected_id=="chosen" and host.selected_ids==selected_before and selections()==selection_events,"selected-object orbit preserves primary and multi-selection without selection events")
	check(host.outbound_log.filter(func(packet):return packet.get("type")=="transform").size()==source_events,"selected-object orbit emits no source transform events")
	button(at,MOUSE_BUTTON_LEFT,true,"alt")
	var fixed_radius: float=host.camera.position.distance_to(center)
	var fixed_screen: Vector2=host.camera.unproject_position(center)
	# A collaborator/UI selection update must not move an already active pivot.
	host.select_object("other",false)
	motion(at+Vector2(18,-7),Vector2(18,-7),MOUSE_BUTTON_LEFT,"alt")
	check(host.orbit_pivot!=null and host.orbit_pivot.distance_to(center)<.00001,"an active gesture retains its initial primary pivot after selection changes")
	check(absf(host.camera.position.distance_to(center)-fixed_radius)<.0001 and host.camera.unproject_position(center).distance_to(fixed_screen)<.005,"the initial pivot retains its radius and screen position after selection changes")
	button(at+Vector2(18,-7),MOUSE_BUTTON_LEFT,false,"alt")
	host.select_objects(selected_before,"chosen",false)
	check(host.orbit_pivot==null,"selection changes do not prevent release from clearing the pivot")
	# Camera gestures continue to work with the same selected Mesh after orbit.
	exercise_middle_pan("perspective")
	check(host.objects.chosen.transform==chosen_pose and host.selected_ids==selected_before,"middle pan after selected-object orbit preserves content and selection")
	host.select_objects([],"",false)
	reset3()
	var focus: Vector3=host.target
	var focus_radius: float=host.camera.position.distance_to(focus)
	button(at,MOUSE_BUTTON_LEFT,true,"alt")
	check(host.orbit_pivot==null and host.navigation=="orbit","with no selection orbit uses the existing observation-focus path")
	motion(at+Vector2(25,10),Vector2(25,10),MOUSE_BUTTON_LEFT,"alt")
	check(host.target.distance_to(focus)<.0001 and absf(host.camera.position.distance_to(focus)-focus_radius)<.0001,"unselected orbit preserves its focus and radius")
	button(at+Vector2(25,10),MOUSE_BUTTON_LEFT,false,"alt")
	check(host.orbit_pivot==null,"unselected orbit also releases its pivot")
	host.free()

func canvas_point(at: Vector2) -> Vector2:
	return root.canvas_transform.affine_inverse()*at

func exercise2() -> void:
	scope="native 2D"
	new_host(true,true)
	host.canvas_center=Vector2(220,-90)
	host.canvas_zoom=1.7
	host.update_camera()
	var authored=Polygon2D.new()
	host.scene_root.add_child(authored)
	authored.position=host.canvas_center
	authored.polygon=PackedVector2Array([Vector2(-60,-60),Vector2(60,-60),Vector2(60,60),Vector2(-60,60)])
	host.objects.sentinel=authored
	host.definitions.sentinel={"id":"sentinel","name":"Sentinel","parent_id":null,"kind":"node","dimension":"2d","native_path":str(host.scene_root.get_path_to(authored)),"native_target":{"node_id":"sentinel","instance_ids":[]},"version":"v1"}
	host.select_object("sentinel",false)
	var source_pose=authored.transform
	var start_commits=commits()
	var start_selection=selections()
	var at=Vector2(175,190)
	var point=canvas_point(at)
	var before_zoom: float=host.canvas_zoom
	button(at,MOUSE_BUTTON_WHEEL_UP,true)
	check(host.canvas_zoom>before_zoom,"wheel up zooms in")
	check(canvas_point(at).is_equal_approx(point),"wheel keeps the world point beneath the cursor fixed")
	button(at,MOUSE_BUTTON_WHEEL_DOWN,true)
	check(is_equal_approx(host.canvas_zoom,before_zoom),"opposite wheel steps return to the original scale")
	check(canvas_point(at).is_equal_approx(point),"wheel round trip restores cursor coordinates")
	button(at,MOUSE_BUTTON_WHEEL_UP,true,"",.25)
	var fractional: float=host.canvas_zoom/before_zoom
	button(at,MOUSE_BUTTON_WHEEL_DOWN,true,"",.25)
	button(at,MOUSE_BUTTON_WHEEL_UP,true)
	check(fractional>1 and fractional<host.canvas_zoom/before_zoom,"fractional wheel factors produce smaller smooth zoom increments")
	point=canvas_point(at)
	var magnify=InputEventMagnifyGesture.new()
	magnify.position=at
	magnify.factor=1.3
	before_zoom=host.canvas_zoom
	host._input(magnify)
	check(host.canvas_zoom>before_zoom,"trackpad magnification zooms the canvas")
	check(canvas_point(at).is_equal_approx(point),"trackpad magnification anchors at its cursor")
	var before_center: Vector2=host.canvas_center
	var pan=InputEventPanGesture.new()
	pan.position=at
	pan.delta=Vector2(1.25,-.75)
	host._input(pan)
	check(not host.canvas_center.is_equal_approx(before_center),"trackpad pan translates the canvas")
	var transform: Transform2D=root.canvas_transform
	var canvas_world=canvas_point(at)
	var delta=Vector2(70,-30)
	drag(at,delta,MOUSE_BUTTON_MIDDLE)
	check((root.canvas_transform*canvas_world).is_equal_approx(at+delta),"middle drag follows the pointer by the exact screen displacement")
	check(root.canvas_transform.x.is_equal_approx(transform.x) and root.canvas_transform.y.is_equal_approx(transform.y),"middle drag preserves canvas scale")
	at=authored.get_global_transform_with_canvas().origin
	canvas_world=canvas_point(at)
	key(KEY_SPACE,true)
	drag(at,delta,MOUSE_BUTTON_LEFT)
	key(KEY_SPACE,false)
	check((root.canvas_transform*canvas_world).is_equal_approx(at+delta),"Space-left drag pans even when it begins on the selected object")
	check(not host.canvas_drag and host.button_down==0,"Space-left release clears the navigation gesture")
	button(at,MOUSE_BUTTON_MIDDLE,true)
	host._notification(NOTIFICATION_APPLICATION_FOCUS_OUT)
	before_center=host.canvas_center
	motion(at+delta,delta,MOUSE_BUTTON_MIDDLE)
	check(host.canvas_center.is_equal_approx(before_center),"focus loss cancels canvas panning")
	check(authored.transform.is_equal_approx(source_pose),"canvas navigation preserves authored geometry")
	check(commits()==start_commits,"canvas navigation emits no source transform commits")
	check(selections()==start_selection and host.selected_id=="sentinel","canvas navigation preserves object selection")
	release_keys()
	host.free()
	root.canvas_transform=Transform2D.IDENTITY

func run() -> void:
	root.size=Vector2i(1000,700)
	scope="execution"
	check(DisplayServer.get_name()=="headless","uses headless display")
	check(AudioServer.get_driver_name()=="Dummy","uses Dummy audio")
	exercise_response()
	exercise3(false)
	exercise3(true)
	exercise_selection_orbit(false)
	exercise_selection_orbit(true)
	exercise2()
	var ok=checks.all(func(row):return row.ok)
	FileAccess.open(out+"/result.json",FileAccess.WRITE).store_string(JSON.stringify({"ok":ok,"checks":checks},"\t"))
	print("VIEWPORT_NAVIGATION_COMPLETE "+str(checks.size()))
	quit(0 if ok else 1)
