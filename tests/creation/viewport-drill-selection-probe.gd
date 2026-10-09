extends SceneTree

var host: Node
var checks: Array = []
var out = ""
var native = false
var scope = ""

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--out="): out = arg.substr(6)
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":scope+": "+detail})
	if not ok: print("VIEWPORT_DRILL_FAILED "+scope+": "+detail)

func register(id: String, node: Node, parent_id: Variant, kind: String = "node") -> Node:
	var row = {"id":id,"name":id,"parent_id":parent_id,"kind":kind,"version":"v1"}
	if native:
		row.merge({"native_path":"." if node==host.authored_root else str(host.authored_root.get_path_to(node)),"native_target":{"node_id":id,"instance_ids":[]},"dimension":"2d" if node is CanvasItem else "3d"})
	else:
		node.set_meta("hierarchy_ref",{"kind":"object","id":id})
	host.objects[id]=node
	host.definitions[id]=row
	return node

func branch3(parent: Node, id: String, parent_id: Variant, at: Vector3 = Vector3.ZERO) -> Node3D:
	var node=Node3D.new()
	node.name=id
	parent.add_child(node)
	node.position=at
	return register(id,node,parent_id,"group")

func leaf3(parent: Node, id: String, parent_id: String, at: Vector3 = Vector3.ZERO) -> Node3D:
	var node=branch3(parent,id,parent_id,at)
	host.definitions[id].kind="mesh"
	var mesh=MeshInstance3D.new()
	mesh.mesh=BoxMesh.new()
	node.add_child(mesh)
	return node

func control(parent: Node, id: String, parent_id: Variant, at: Vector2, size: Vector2) -> Control:
	var node=ColorRect.new()
	node.name=id
	parent.add_child(node)
	node.position=at
	node.size=size
	return register(id,node,parent_id)

func event_at(screen: Vector2, pressed: bool, modifiers: String = "", double_click: bool = false) -> InputEventMouseButton:
	var event=InputEventMouseButton.new()
	event.button_index=MOUSE_BUTTON_LEFT
	event.position=screen
	event.pressed=pressed
	event.double_click=double_click
	event.ctrl_pressed=modifiers=="ctrl"
	event.meta_pressed=modifiers=="meta"
	event.shift_pressed=modifiers=="shift"
	event.alt_pressed=modifiers=="alt"
	return event

func selected_events() -> int:
	return host.outbound_log.filter(func(packet):return packet.get("type")=="selected").size()

func transform_commits() -> int:
	return host.outbound_log.filter(func(packet):return packet.get("type")=="transform" and packet.get("phase")=="commit").size()

func click(screen: Vector2, expected: String, detail: String, modifiers: String = "", double_click: bool = false) -> void:
	var before=selected_events()
	host._input(event_at(screen,true,modifiers,double_click))
	host._input(event_at(screen,false,modifiers))
	check(host.selected_id==expected,detail+"; selected="+host.selected_id)
	if modifiers!="alt": check(selected_events()-before==1,detail+" emits one selection for one physical click")

func reset_selection() -> void:
	host.select_objects([],"",false)
	host.cancel_drag()

func new_host(is_native: bool, name: String) -> void:
	native=is_native
	scope=name
	host=load("res://native_main.gd" if native else "res://main.gd").new()
	root.add_child(host)
	host.set_process(false)
	host.document_id="independent/main/scene"
	host.applied_seq=1
	host.editor_tool="select"
	if native:
		host.native_active=true
		host.native_document={"source_identity":"independent-v1","source_revision":"independent-v1"}
		host.authored_root=host.scene_root
		register("document",host.scene_root,null)

func common_clicks(a: Vector2, side: Vector2, b: Vector2) -> void:
	check(host.pick_object(a)=="leaf","raw geometry pick remains the leaf")
	click(a,"a","first click selects outer source object")
	click(a,"middle","second click selects the next source layer")
	var camera_before=host.camera.transform
	click(a,"leaf","double-click event advances exactly one layer","",true)
	check(host.camera.transform.is_equal_approx(camera_before),"double click does not reframe the camera")
	click(a,"leaf","clicking the smallest object stays there")
	click(b,"b","clicking a different root starts at that root")
	click(b,"other_leaf","second click enters the other root")
	host.select_object("a",false)
	click(side,"side","next layer follows the child beneath the pointer")
	click(side,"side_leaf","selected pointer branch continues to its leaf")
	click(Vector2(-1000,-1000),"","empty click clears selection")
	click(a,"leaf","Ctrl selects the geometric leaf directly","ctrl")
	click(b,"other_leaf","Shift adds the geometric leaf directly","shift")
	check(host.selected_ids==["leaf","other_leaf"],"modified clicks preserve multiple selected leaves")
	click(a,"other_leaf","Meta toggles the hit leaf without drilling","meta")
	check(host.selected_ids==["other_leaf"],"Meta removes only the requested member")
	reset_selection()

func exercise3(is_native: bool) -> void:
	new_host(is_native,"native 3D" if is_native else "legacy 3D")
	var doc_parent: Variant="document" if native else null
	var a=branch3(host.scene_root,"a",doc_parent,Vector3(-2,0,0))
	# An engine wrapper is deliberately absent from the addressable source index.
	var wrapper=Node3D.new()
	wrapper.name="InternalMountWrapper"
	a.add_child(wrapper)
	var middle=branch3(wrapper,"middle","a")
	var leaf=leaf3(middle,"leaf","middle")
	var side=branch3(a,"side","a",Vector3(0,2,0))
	var side_leaf=leaf3(side,"side_leaf","side")
	var b=branch3(host.scene_root,"b",doc_parent,Vector3(2,0,0))
	var other=leaf3(b,"other_leaf","b")
	host.camera.position=Vector3(0,0,12)
	host.camera.look_at(Vector3.ZERO)
	host.target=Vector3.ZERO
	host.distance=12
	host.refresh_bounds()
	await process_frame
	var at=host.camera.unproject_position(leaf.global_position)
	var side_at=host.camera.unproject_position(side_leaf.global_position)
	var other_at=host.camera.unproject_position(other.global_position)
	common_clicks(at,side_at,other_at)
	host.select_object("a",false)
	var selected_before=selected_events()
	click(at,"a","Alt click keeps the selection","alt")
	check(selected_events()==selected_before,"Alt navigation does not emit a selection")
	host._input(event_at(at,true))
	var motion=InputEventMouseMotion.new()
	motion.position=at+Vector2(30,5)
	motion.relative=Vector2(30,5)
	motion.button_mask=MOUSE_BUTTON_MASK_LEFT
	host._input(motion)
	host._input(event_at(motion.position,false))
	check(host.selected_id=="a","pointer drag is not counted as a drilling click")
	# Existing transform handles still take priority over source drilling.
	host.editor_tool="move"
	host.select_object("leaf",false)
	var original=leaf.transform
	host.update_helpers()
	var gizmo_at=host.camera.unproject_position(host.gizmo.global_transform*Vector3(.7,0,0))
	host._input(event_at(gizmo_at,true))
	check(host.drag_id=="leaf" and not host.drag_handle.is_empty(),"actual gizmo press begins a transform")
	check(host.selected_id=="leaf","gizmo press does not alter selection depth")
	host.cancel_drag()
	check(leaf.transform.is_equal_approx(original),"cancel preserves the authored pose")
	host.select_object("a",false)
	host.update_helpers()
	var commits_before=transform_commits()
	var selected_before_click=selected_events()
	# The geometry and a center gizmo overlap at this ray. A press without a drag
	# is still an ordinary click and must not consume the next selection layer.
	host._input(event_at(at,true))
	host._input(event_at(at,false))
	check(host.selected_id=="middle" and selected_events()-selected_before_click==1,"gizmo overlap does not swallow an unmoved drilling click")
	check(transform_commits()==commits_before,"unmoved gizmo click does not commit a transform")
	host.editor_tool="select"
	if native:
		host.mode="object"
		host.editable=false
		host.native_document.preview_object_id="middle"
		reset_selection()
		click(at,"middle","independent object view starts at its preview root")
		click(at,"leaf","independent object view can enter its nested child")
		click(other_at,"","independent object view rejects objects outside its preview root")
		host.select_object("leaf",false)
		var yaw_before: float=host.yaw
		host._input(event_at(at,true))
		host._input(motion)
		host._input(event_at(motion.position,false))
		check(host.yaw!=yaw_before and host.selected_id=="leaf","object-view left drag still orbits without drilling")
	host.free()

func exercise_canvas(mixed: bool) -> void:
	new_host(true,"mixed 3D and Control" if mixed else "native 2D Control")
	host.canvas_mode=not mixed
	var a=control(host.scene_root,"a","document",Vector2(100,100),Vector2(240,260))
	var middle=control(a,"middle","a",Vector2(20,20),Vector2(120,100))
	var leaf=control(middle,"leaf","middle",Vector2(20,20),Vector2(40,40))
	var side=control(a,"side","a",Vector2(20,150),Vector2(120,80))
	var side_leaf=control(side,"side_leaf","side",Vector2(20,20),Vector2(40,40))
	var b=control(host.scene_root,"b","document",Vector2(500,100),Vector2(180,140))
	var other=control(b,"other_leaf","b",Vector2(30,30),Vector2(60,60))
	await process_frame
	var at=leaf.get_global_transform_with_canvas()*(leaf.size*.5)
	var side_at=side_leaf.get_global_transform_with_canvas()*(side_leaf.size*.5)
	var other_at=other.get_global_transform_with_canvas()*(other.size*.5)
	common_clicks(at,side_at,other_at)
	# Move is the initial editor tool. Repeated clicks should remain selection
	# operations, with no no-op source transactions or accidental child movement.
	host.editor_tool="move"
	var commits_before=transform_commits()
	var a_before=a.position
	var middle_before=middle.position
	click(at,"a","default move tool first click selects the outer source layer")
	click(at,"middle","default move tool second click enters one child")
	check(transform_commits()==commits_before,"ordinary default-tool clicks do not commit unchanged transforms")
	check(a.position.is_equal_approx(a_before) and middle.position.is_equal_approx(middle_before),"repeated default-tool clicks preserve source geometry")
	host.select_object("a",false)
	host._input(event_at(at,true))
	var drag=InputEventMouseMotion.new()
	drag.position=at+Vector2(25,15)
	drag.relative=Vector2(25,15)
	drag.button_mask=MOUSE_BUTTON_MASK_LEFT
	host._input(drag)
	check(host.selected_id=="a" and not a.position.is_equal_approx(a_before),"dragging an already selected parent moves that parent without drilling")
	check(middle.position.is_equal_approx(middle_before),"parent drag preserves its child's local transform")
	host.cancel_drag()
	# Restore fixture geometry even after a failed assertion so later checks stay
	# independent and still expose resize/routing regressions.
	a.position=a_before
	middle.position=middle_before
	host.editor_tool="select"
	# Control resize handles keep their existing native operation and must not drill.
	host.select_object("middle",false)
	var original_size=middle.size
	var original_position=middle.position
	var handle_at=middle.get_global_transform_with_canvas()*middle.size
	var before=selected_events()
	host._input(event_at(handle_at,true))
	check(host.canvas_drag and host.control_resize_handle>=0,"Control corner starts native resize")
	check(host.selected_id=="middle" and selected_events()==before,"resize keeps the selected layer")
	var motion=InputEventMouseMotion.new()
	motion.position=handle_at+Vector2(25,15)
	motion.relative=Vector2(25,15)
	motion.button_mask=MOUSE_BUTTON_MASK_LEFT
	host._input(motion)
	check(not middle.size.is_equal_approx(original_size),"resize changes native Control size")
	host.cancel_drag()
	check(middle.size.is_equal_approx(original_size) and middle.position.is_equal_approx(original_position),"resize cancel restores authored Control geometry")
	# A non-Canvas source ancestor exercises mixed-mode press/release routing.
	if mixed:
		host.select_object("a",false)
		host._input(event_at(at,true))
		var outside=InputEventMouseMotion.new()
		outside.position=Vector2(980,680)
		outside.relative=outside.position-at
		outside.button_mask=MOUSE_BUTTON_MASK_LEFT
		host._input(outside)
		host._input(event_at(outside.position,false))
		check(host.selected_id=="a" and not host.canvas_pointer_active and host.button_down==0,"mixed release outside Control ends the original pointer gesture without drilling")
		click(at,"middle","next click works after leaving the Control during a gesture")
		host.select_object("a",false)
		host._input(event_at(at,true))
		outside.button_mask=0
		host._input(outside)
		check(host.selected_id=="a" and not host.canvas_click_pending and not host.canvas_pointer_active,"lost mouse release cancels pending drilling")
		var logic=Node.new()
		logic.name="logic"
		host.scene_root.add_child(logic)
		register("logic",logic,"document")
		var child=control(logic,"logic_child","logic",Vector2(750,400),Vector2(80,60))
		reset_selection()
		var child_at=child.get_global_transform_with_canvas()*(child.size*.5)
		click(child_at,"logic","Control hit first selects its non-Canvas source ancestor")
		click(child_at,"logic_child","mixed input routes the next Control hit exactly once")
	host.free()

func exercise_node2d() -> void:
	new_host(true,"native Node2D")
	host.canvas_mode=true
	var a=Node2D.new()
	host.scene_root.add_child(a)
	a.position=Vector2(200,200)
	register("a",a,"document")
	var middle=Node2D.new()
	a.add_child(middle)
	middle.position=Vector2(50,0)
	register("middle",middle,"a")
	var leaf=Polygon2D.new()
	middle.add_child(leaf)
	leaf.polygon=PackedVector2Array([Vector2(-20,-20),Vector2(20,-20),Vector2(20,20),Vector2(-20,20)])
	register("leaf",leaf,"middle")
	await process_frame
	var at=leaf.get_global_transform_with_canvas().origin
	check(host.pick_object(at)=="leaf","polygon hit remains the raw leaf")
	host.editor_tool="move"
	var commits_before=transform_commits()
	click(at,"a","first polygon click selects its outer Node2D")
	click(at,"middle","second polygon click enters one registered Node2D")
	click(at,"leaf","third polygon click reaches the polygon")
	click(at,"leaf","polygon leaf remains selected")
	check(transform_commits()==commits_before,"Node2D selection clicks do not commit transforms")
	host.select_object("a",false)
	var original=a.transform
	var local_before=middle.transform
	host._input(event_at(at,true))
	var motion=InputEventMouseMotion.new()
	motion.position=at+Vector2(30,15)
	motion.relative=Vector2(30,15)
	motion.button_mask=MOUSE_BUTTON_MASK_LEFT
	host._input(motion)
	check(host.selected_id=="a" and not a.transform.is_equal_approx(original),"Node2D parent drag keeps its selected layer")
	check(middle.transform.is_equal_approx(local_before),"Node2D parent drag preserves child local transform")
	host.cancel_drag()
	check(a.transform.is_equal_approx(original) and not host.canvas_click_pending,"Node2D cancel restores pose and clears pending click")
	host.free()

func run() -> void:
	root.size=Vector2i(1000,700)
	scope="execution"
	check(DisplayServer.get_name()=="headless","uses headless display")
	check(AudioServer.get_driver_name()=="Dummy","uses Dummy audio")
	await exercise3(false)
	await exercise3(true)
	await exercise_canvas(false)
	await exercise_canvas(true)
	await exercise_node2d()
	var ok=checks.all(func(row):return row.ok)
	FileAccess.open(out+"/result.json",FileAccess.WRITE).store_string(JSON.stringify({"ok":ok,"checks":checks},"\t"))
	print("VIEWPORT_DRILL_COMPLETE "+str(checks.size()))
	quit(0 if ok else 1)
