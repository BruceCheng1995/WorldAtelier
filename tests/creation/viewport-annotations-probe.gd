extends SceneTree

var host: Node
var checks: Array = []
var out = ""
var scope = ""
var canvas = false

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--out="):out=arg.substr(6)
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":scope+": "+detail})
	if not ok: print("VIEWPORT_ANNOTATIONS_FAILED "+scope+": "+detail)

func events(type: String) -> Array:
	return host.outbound_log.filter(func(packet):return packet.get("type")==type)

func configure(extra: Dictionary = {}) -> void:
	var packet={"source":"world-atelier-workspace","nonce":host.nonce,"type":"annotation","seq":1,"document_id":host.document_id,"enabled":true,"tool":"point","target":"objects","plane":"xy","plane_offset":0}
	packet.merge(extra,true)
	host.receive(packet)

func button(at: Vector2, pressed: bool) -> void:
	var event=InputEventMouseButton.new()
	event.button_index=MOUSE_BUTTON_LEFT
	event.position=at
	event.pressed=pressed
	host._input(event)

func move(at: Vector2, delta: Vector2, held: bool = true) -> void:
	var event=InputEventMouseMotion.new()
	event.position=at
	event.relative=delta
	event.button_mask=MOUSE_BUTTON_MASK_LEFT if held else 0
	host._input(event)

func click(at: Vector2) -> void:
	button(at,true)
	button(at,false)

func gesture(from: Vector2, to: Vector2) -> void:
	button(from,true)
	move(to,to-from)
	button(to,false)

func register(node: Node, id: String, kind: String) -> Node:
	var row={"id":id,"name":id,"parent_id":null,"kind":kind,"version":"v1","native_path":str(host.scene_root.get_path_to(node)),"native_target":{"node_id":id,"instance_ids":[]},"dimension":"2d" if canvas else "3d"}
	host.objects[id]=node
	host.definitions[id]=row
	return node

func shape(id: String, at: Vector2) -> Node:
	if canvas:
		var node=ColorRect.new()
		host.scene_root.add_child(node)
		node.position=at
		node.size=Vector2(100,100)
		return register(node,id,"node")
	var node=MeshInstance3D.new()
	host.scene_root.add_child(node)
	node.mesh=BoxMesh.new()
	node.position=Vector3((at.x-500)/100.0,0,0)
	return register(node,id,"mesh")

func state() -> Dictionary:
	var poses={}
	for id in host.objects:poses[id]=host.objects[id].get_transform()
	return {"poses":poses,"definitions":host.definitions.duplicate(true),"selection":host.selected_ids.duplicate()}

func new_host(is_canvas: bool) -> void:
	canvas=is_canvas
	scope="native 2D" if canvas else "native 3D"
	host=load("res://native_main.gd").new()
	root.add_child(host)
	host.set_process(false)
	host.set_process_input(false)
	host.document_id="independent/main/annotations"
	host.applied_seq=1
	host.requested_seq=1
	host.placement_revision="annotation-source-v1"
	host.native_active=true
	host.native_document={"source_identity":"annotation-native-v1","source_revision":"annotation-source-v1"}
	host.authored_root=host.scene_root
	host.canvas_mode=canvas
	host.editor_tool="move"
	if canvas:
		host.canvas_center=Vector2(500,350)
		host.canvas_zoom=1
	else:
		host.target=Vector3.ZERO
		host.yaw=0
		host.pitch=.35
		host.distance=12
	host.update_camera()

func exercise(is_canvas: bool) -> void:
	new_host(is_canvas)
	var left=shape("left",Vector2(230,260))
	var right=shape("right",Vector2(570,260))
	var hidden=shape("hidden",Vector2(400,260))
	hidden.hide()
	host.refresh_bounds()
	host.select_object("left",false)
	await process_frame
	var left_rect: Rect2=host.annotation_screen_rect("left")
	var right_rect: Rect2=host.annotation_screen_rect("right")
	var left_at=left_rect.get_center()
	var right_at=right_rect.get_center()
	var source=state()
	var selection_count=events("selected").size()
	var transform_count=events("transform").size()
	configure({"seq":2})
	check(not host.editor_annotations.enabled,"foreign generation cannot enable annotation")
	configure({"document_id":"independent/other/annotations"})
	check(not host.editor_annotations.enabled,"foreign document cannot enable annotation")
	configure()
	check(host.editor_annotations.enabled,"loaded document can enter annotation mode")
	click(left_at)
	check(events("annotation_candidate").size()==1,"one click emits exactly one candidate")
	var object_event: Dictionary=events("annotation_candidate")[-1]
	check(object_event.kind=="object" and object_event.object_ids==["left"],"object click captures the precise hit object")
	check(object_event.seq==1 and object_event.document_id==host.document_id,"candidate binds its loaded document generation")
	check(object_event.source_revision=="annotation-source-v1" and object_event.source_identity=="annotation-native-v1","candidate carries the fixed native source identity")
	check(object_event.dimension==("2d" if canvas else "3d"),"candidate reports the real coordinate dimension")
	check(object_event.position.size()==(2 if canvas else 3),"candidate coordinate arity follows its dimension")
	var projected: Vector2=host.annotation_project(object_event.position)
	check(projected.distance_to(left_at)<.1,"captured world position projects back to the clicked pixel")
	var object_count=events("annotation_candidate").size()
	click(Vector2(20,20))
	check(events("annotation_candidate").size()==object_count,"object-target miss does not implicitly create a coordinate")
	configure({"target":"space"})
	click(Vector2(20,20))
	var point_event: Dictionary=events("annotation_candidate")[-1]
	check(point_event.kind=="point" and point_event.object_ids.is_empty(),"explicit space-target click yields a position without creating a source object")
	check(host.annotation_project(point_event.position).distance_to(Vector2(20,20))<.1,"explicit space point projects back to the requested screen coordinate")
	click(left_at)
	var independent_point: Dictionary=events("annotation_candidate")[-1]
	check(independent_point.kind=="point" and independent_point.object_ids.is_empty(),"explicit space target remains a coordinate even when clicking above a visible object")
	configure({"tool":"rect"})
	var rect=left_rect.merge(right_rect).grow(15)
	gesture(rect.position,rect.end)
	var rectangle: Dictionary=events("annotation_candidate")[-1]
	check(rectangle.kind=="objects","rectangle gesture creates an object collection")
	check(rectangle.object_ids.size()==2 and "left" in rectangle.object_ids and "right" in rectangle.object_ids,"rectangle includes all intersected visible objects once")
	check(not "hidden" in rectangle.object_ids,"rectangle excludes hidden objects")
	check(rectangle.geometry.shape=="objects" and rectangle.geometry.tool=="rect","rectangle identifies its object selection tool")
	check(not rectangle.geometry.has("world_points"),"rectangle does not invent a spatial region from a screen frame")
	check(rectangle.geometry.selection=="visible_projected_bounds","object selection declares its projected-bounds membership rule")
	configure({"tool":"brush","radius":8})
	gesture(left_at,right_at)
	var brush: Dictionary=events("annotation_candidate")[-1]
	check(brush.kind=="objects" and brush.object_ids.size()==2,"fast object brush includes objects between sparse pointer events")
	check(brush.geometry.shape=="objects" and brush.geometry.tool=="brush","object brush identifies its selection tool")
	check(not brush.geometry.has("world_points"),"object brush retains explicit membership without inventing a world volume")
	check(brush.geometry.selection=="visible_projected_bounds","object brush declares the same visible membership rule as rectangle selection")
	var edge_path: Array[Vector2]=[Vector2.ZERO,Vector2(100,0)]
	check(not host.editor_annotations.touches(Rect2(124,24,4,4),edge_path,28),"a projected bound outside the round brush cap is excluded from Agent members")
	check(host.editor_annotations.touches(Rect2(112,8,4,4),edge_path,28),"a projected bound inside the round brush cap is included")
	button(left_at,true)
	move(right_at,right_at-left_at)
	move(left_at,left_at-right_at)
	button(left_at,false)
	var loop: Dictionary=events("annotation_candidate")[-1]
	check(loop.kind=="objects" and "right" in loop.object_ids,"a brush returning to its starting point still captures its painted area")
	var before=events("annotation_candidate").size()
	button(left_at,true)
	var escape=InputEventKey.new()
	escape.keycode=KEY_ESCAPE
	escape.pressed=true
	host._input(escape)
	button(right_at,false)
	check(events("annotation_candidate").size()==before and not host.editor_annotations.drawing,"Escape cancels the current gesture without creating a candidate")
	host._input(escape)
	check(events("annotation_cancel").size()==1,"Escape after cancelling the gesture requests leaving annotation mode")
	button(left_at,true)
	move(right_at,right_at-left_at,false)
	button(right_at,false)
	check(events("annotation_candidate").size()==before,"lost mouse release cancels a brush gesture")
	button(left_at,true)
	host.document_id="independent/main/other"
	button(right_at,false)
	check(events("annotation_candidate").size()==before,"document switch cannot complete a stale gesture")
	host.document_id="independent/main/annotations"
	configure({"suspended":true})
	click(right_at)
	check(events("annotation_candidate").size()==before,"an open note bubble suspends further captures")
	configure({"suspended":false})
	button(left_at,true)
	host.editor_annotations._notification(NOTIFICATION_APPLICATION_FOCUS_OUT)
	button(right_at,false)
	check(events("annotation_candidate").size()==before,"focus loss cancels the in-progress annotation")
	var tool_before: String=host.editor_tool
	var edit_key=InputEventKey.new()
	edit_key.keycode=KEY_R
	edit_key.pressed=true
	host._input(edit_key)
	check(host.editor_tool==tool_before,"annotation mode suppresses edit shortcuts")
	check(events("selected").size()==selection_count,"annotation does not alter the user's selection")
	check(events("transform").size()==transform_count,"annotation input never starts or commits a transform")
	check(state()==source,"all annotation interactions preserve source nodes, properties and poses")
	configure({"marks":[{"id":"pin-1","dimension":object_event.dimension,"annotation_kind":object_event.kind,"object_ids":object_event.object_ids,"position":object_event.position,"geometry":object_event.geometry}]})
	host.editor_annotations._process(.1)
	var projection: Dictionary=events("annotation_projection")[-1]
	check(projection.marks.size()==1 and projection.marks[0].id=="pin-1","existing mark projection keeps its stable annotation ID")
	check(Vector2(projection.marks[0].screen[0]*1000,projection.marks[0].screen[1]*700).distance_to(left_at)<.1,"mark projection tracks the captured scene point")
	configure({"enabled":false})
	check(not host.editor_annotations.enabled and not host.editor_annotations.drawing,"leaving annotation mode clears gesture capture")
	host.free()
	root.canvas_transform=Transform2D.IDENTITY

func run() -> void:
	root.size=Vector2i(1000,700)
	scope="execution"
	check(DisplayServer.get_name()=="headless","uses headless display")
	check(AudioServer.get_driver_name()=="Dummy","uses Dummy audio")
	await exercise(false)
	await exercise(true)
	var ok=checks.all(func(row):return row.ok)
	FileAccess.open(out+"/result.json",FileAccess.WRITE).store_string(JSON.stringify({"ok":ok,"checks":checks},"\t"))
	print("VIEWPORT_ANNOTATIONS_COMPLETE "+str(checks.size()))
	quit(0 if ok else 1)
