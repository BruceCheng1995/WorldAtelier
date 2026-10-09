extends Control

const Spatial = preload("res://annotation_spatial.gd")
const Visuals = preload("res://annotation_visuals.gd")
var host: Node
var spatial = Spatial.new()
var visuals: Node3D
var enabled = false
var suspended = false
var tool = "point"
var target_mode = "objects"
var plane = "xz"
var plane_offset = 0.0
var depth = 2.0
var radius = 28.0
var world_radius = 1.0
var drawing = false
var points: Array[Vector2] = []
var world_path: Array[Vector3] = []
var cursor = Vector2(-1000,-1000)
var marks: Array = []
var edit: Dictionary = {}
var edit_drag: Dictionary = {}
var clock = 0.0
var capture_document = ""
var capture_seq = -1
var camera_key: Array = []
var projection_dirty = true
var plane_dirty = true
var render_dirty = true
var redraws = 0
var projection_emits = 0

func setup(value: Node) -> void:
	host=value
	spatial.setup(host)
	visuals=Visuals.new()
	host.add_child(visuals)
	visuals.setup(host)
	mouse_filter=Control.MOUSE_FILTER_IGNORE
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

func canvas_mode() -> bool:
	return host.get("canvas_mode")==true

func scoped_emit(type: String, payload: Dictionary={}) -> void:
	payload.merge({"type":type,"seq":host.applied_seq,"document_id":host.document_id,"source_revision":host.placement_source().get("source_revision"),"source_identity":host.placement_source().get("source_identity")},true)
	host.emit(payload)

func configure(packet: Dictionary) -> void:
	var was_enabled=enabled
	var old_controls=[tool,target_mode,plane,plane_offset,depth,world_radius,radius]
	var next_tool=packet.get("tool",tool)
	var next_target=packet.get("target",target_mode)
	if next_tool in ["point","brush","rect","volume"]: tool=next_tool
	if next_target in ["objects","space"]: target_mode=next_target
	if tool=="rect": target_mode="objects"
	if tool=="volume": target_mode="space"
	if packet.has("enabled"): enabled=packet.enabled==true
	if enabled!=was_enabled:
		cancel_gesture()
		host.cancel_drag()
		host.update_helpers(false)
		plane_dirty=true
	var old_plane=[plane,plane_offset,depth]
	if packet.get("plane") in ["xz","xy","yz"]: plane=packet.plane
	for field in ["plane_offset","depth","world_radius","radius"]:
		var number=packet.get(field)
		if (number is float or number is int) and is_finite(number):
			set(field,clampf(number,-1e6,1e6) if field=="plane_offset" else clampf(number,.05,1e4) if field!="radius" else clampf(number,8,100))
	if old_plane!=[plane,plane_offset,depth]: plane_dirty=true
	if old_controls!=[tool,target_mode,plane,plane_offset,depth,world_radius,radius]:
		if drawing or not edit_drag.is_empty(): cancel_gesture()
		plane_dirty=true
	suspended=packet.get("suspended",false)==true
	var incoming: Array=packet.get("marks",[])
	if incoming!=marks:
		marks=incoming.duplicate(true)
		render_dirty=true
		projection_dirty=true
	var incoming_edit: Dictionary=packet.edit if packet.get("edit") is Dictionary else {}
	if incoming_edit.get("id","")!=edit.get("id","") and not edit_drag.is_empty(): cancel_gesture()
	if incoming_edit!=edit and edit_drag.is_empty():
		edit=incoming_edit.duplicate(true)
		render_dirty=true
		projection_dirty=true
	if packet.get("adjust",false) and not edit.is_empty(): adjust_edit(edit.position,edit.get("geometry",{}),true)
	refresh_visuals()
	if packet.get("action")=="align_plane" and not canvas_mode():
		host.camera_view={"xz":"top","xy":"front","yz":"right"}[plane]
		host.camera.projection=Camera3D.PROJECTION_ORTHOGONAL
		host.target[Spatial.axes(plane)[2]]=plane_offset
		host.update_camera()
		host.emit_camera()
	if packet.get("action")=="focus_edit" and not canvas_mode() and not edit.is_empty():
		host.target=Spatial.vec(edit.position)
		if edit.get("geometry",{}).get("shape")=="box": host.distance=maxf(3,Spatial.vec(edit.geometry.size).length()*1.5)
		host.update_camera()
		host.emit_camera()
	if packet.get("action")=="create_center" and not canvas_mode():
		var point: Vector3=host.target
		point[Spatial.axes(plane)[2]]=plane_offset
		if tool=="volume":
			var a=point-Vector3.ONE
			var b=point+Vector3.ONE
			var geometry=Spatial.box_geometry(a,b,plane,plane_offset,depth)
			candidate("region",spatial.world_members(geometry),geometry.center,geometry)
		else: candidate("point",[],Spatial.array3(point),{})
	scoped_emit("annotation_state",{"enabled":enabled,"suspended":suspended,"tool":tool,"target":target_mode,"protocol":2})

func cancel_gesture() -> void:
	drawing=false
	points.clear()
	world_path.clear()
	if not edit_drag.is_empty():
		edit=edit_drag.original
		edit_drag.clear()
		adjust_edit(edit.position,edit.get("geometry",{}),true)
	render_dirty=true
	queue_redraw()

func handle_input(event: InputEvent) -> bool:
	if not enabled or host.applied_seq!=host.requested_seq: return false
	if event is InputEventKey:
		var key=event.keycode if event.keycode else event.physical_keycode
		if event.pressed and key==KEY_ESCAPE:
			if drawing or not edit_drag.is_empty(): cancel_gesture()
			else: scoped_emit("annotation_cancel")
			return true
		return not key in [KEY_SPACE,KEY_F,KEY_W,KEY_A,KEY_S,KEY_D,KEY_Q,KEY_E,KEY_SHIFT,KEY_ALT] or host.button_down!=MOUSE_BUTTON_RIGHT and key!=KEY_F and key!=KEY_SPACE
	if event is InputEventMouseButton and event.button_index in [MOUSE_BUTTON_RIGHT,MOUSE_BUTTON_MIDDLE] and event.pressed:
		if drawing or not edit_drag.is_empty(): cancel_gesture()
		return false
	if event is InputEventMouseButton and event.button_index==MOUSE_BUTTON_LEFT:
		if event.alt_pressed or Input.is_physical_key_pressed(KEY_SPACE): return false
		if event.pressed and begin_edit_drag(event.position): return true
		if not edit_drag.is_empty():
			if not event.pressed:
				edit_drag.clear()
				adjust_edit(edit.position,edit.get("geometry",{}),true)
			return true
		if suspended: return true
		if event.pressed:
			drawing=true
			capture_document=host.document_id
			capture_seq=host.applied_seq
			points=[event.position]
			cursor=event.position
			world_path.clear()
			if target_mode=="space" and not canvas_mode():
				var at=spatial.plane_point(event.position,plane,plane_offset)
				if at==null:
					drawing=false
					scoped_emit("annotation_error",{"message":"视线接近平行工作平面，请切换平面或点击「正对平面」"})
				else: world_path.append(at)
		elif drawing:
			drawing=false
			if capture_document==host.document_id and capture_seq==host.applied_seq:
				append_point(event.position)
				finish(event.position)
			points.clear()
			world_path.clear()
			render_dirty=true
		queue_redraw()
		return true
	if event is InputEventMouseMotion:
		cursor=event.position
		if not edit_drag.is_empty():
			if not event.button_mask & MOUSE_BUTTON_MASK_LEFT: cancel_gesture()
			else: move_edit_drag(event)
			return true
		if drawing:
			if not event.button_mask & MOUSE_BUTTON_MASK_LEFT: cancel_gesture()
			elif points[-1].distance_to(cursor)>4:
				if points.size()>=512:
					cancel_gesture()
					scoped_emit("annotation_error",{"message":"笔刷轨迹过长，请分成几条批注"})
				else: append_point(cursor)
		if not edit.is_empty() and not canvas_mode(): visuals.gizmo.highlight(visuals.hit_handle(cursor))
		if drawing or tool=="brush": queue_redraw()
		return drawing
	return false

func append_point(screen: Vector2) -> void:
	if points.is_empty() or points[-1].distance_to(screen)>.5: points.append(screen)
	if target_mode=="space" and not canvas_mode():
		var point=spatial.plane_point(screen,plane,plane_offset)
		if point!=null and (world_path.is_empty() or world_path[-1].distance_to(point)>.005): world_path.append(point)

func screen_bounds() -> Dictionary:
	var result={}
	if canvas_mode():
		for id in host.objects:
			var node=host.objects[id]
			if node is CanvasItem and node.is_visible_in_tree():
				var rect: Rect2=host.annotation_screen_rect(id)
				if rect.size.x>0 and rect.size.y>0: result[id]=rect
	else:
		var bounds=spatial.object_bounds()
		for id in bounds: result[id]=host.collaboration_overlay.remote_selections.project_bounds(bounds[id])
	return result

func visible_rect(id: String) -> Rect2:
	return screen_bounds().get(id,Rect2())

func brush_outline(path: Array[Vector2], width: float) -> PackedVector2Array:
	return Spatial.brush_polygon(PackedVector2Array(path),width)

func touches(rect: Rect2,path: Array[Vector2],width: float,outline: PackedVector2Array=PackedVector2Array()) -> bool:
	if rect.size.x<=0 or rect.size.y<=0: return false
	if outline.is_empty(): outline=brush_outline(path,width)
	var bounds=PackedVector2Array([rect.position,Vector2(rect.end.x,rect.position.y),rect.end,Vector2(rect.position.x,rect.end.y)])
	return not Geometry2D.intersect_polygons(bounds,outline).is_empty()

func finish(screen: Vector2) -> void:
	if points.is_empty(): return
	var gesture=tool in ["rect","brush","volume"] and points.any(func(point):return point.distance_to(points[0])>4)
	if target_mode=="space" and not canvas_mode():
		if world_path.is_empty(): return
		if tool=="point":
			candidate("point",[],Spatial.array3(world_path[-1]),{})
			return
		if tool=="volume" and (not gesture or world_path.size()<2): return
		var geometry=Spatial.box_geometry(world_path[0],world_path[-1],plane,plane_offset,depth) if tool=="volume" else Spatial.prism_geometry(world_path,world_radius,plane,plane_offset,depth)
		if geometry.is_empty(): return
		candidate("region",spatial.world_members(geometry),geometry.center,geometry)
		return
	if tool=="point" or tool=="brush" and not gesture:
		var hit={}
		if canvas_mode():
			if target_mode=="space":
				candidate("point",[],host.annotation_position(screen).position,{})
				return
			var id=host.pick_object(screen)
			if not id.is_empty(): hit={"object_id":id,"position":host.annotation_position(screen).position}
			elif target_mode=="space":
				candidate("point",[],host.annotation_position(screen).position,{})
				return
		else: hit=spatial.ray_pick(screen)
		if hit.is_empty():
			scoped_emit("annotation_error",{"message":"未点中对象。要标记空中坐标，请切换「空间描点」"})
			return
		candidate("object",[hit.object_id],hit.position,{})
		return
	if not gesture: return
	var viewport_size=get_viewport().get_visible_rect().size
	var rect=Rect2(points[0],screen-points[0]).abs()
	var polygon=brush_outline(points,radius*host.gizmo.pixel_ratio) if tool=="brush" else PackedVector2Array()
	var ids=[]
	var bounds=screen_bounds()
	for id in bounds:
		var visible: Rect2=bounds[id].intersection(Rect2(Vector2.ZERO,viewport_size))
		if visible.size.x<=0 or visible.size.y<=0: continue
		if rect.intersects(visible) if tool=="rect" else touches(visible,points,radius*host.gizmo.pixel_ratio,polygon): ids.append(id)
	if ids.is_empty():
		scoped_emit("annotation_error",{"message":"范围内没有对象；框选仅用于选对象"})
		return
	var position=[]
	if canvas_mode(): position=host.annotation_position(screen).position
	else:
		var all_bounds=spatial.object_bounds()
		var center=Vector3.ZERO
		for id in ids: center+=all_bounds[id].get_center()
		position=Spatial.array3(center/ids.size())
	candidate("objects",ids,position,{"shape":"objects","tool":tool,"selection":"visible_projected_bounds"})

func candidate(kind: String,ids: Array,position: Array,geometry: Dictionary) -> void:
	if ids.size()>512:
		scoped_emit("annotation_error",{"message":"范围包含超过 512 个对象，请缩小范围"})
		return
	var screen=host.annotation_project(position)
	var viewport_size=get_viewport().get_visible_rect().size
	scoped_emit("annotation_candidate",{"kind":kind,"object_ids":ids,"position":position,"dimension":"2d" if canvas_mode() else "3d","geometry":geometry,"screen":[screen.x/viewport_size.x,screen.y/viewport_size.y]})

func adjust_edit(position: Array,geometry: Dictionary,final: bool) -> void:
	if edit.is_empty(): return
	edit.position=position.duplicate()
	edit.geometry=geometry.duplicate(true)
	if final and geometry.get("shape") in ["box","prism"]:
		var ids=spatial.world_members(geometry)
		if ids.size()>512:
			edit.object_ids=[]
			scoped_emit("annotation_adjustment",{"id":edit.id,"position":edit.position,"geometry":edit.geometry,"object_ids":[],"final":true,"valid":false})
			scoped_emit("annotation_error",{"message":"范围包含超过 512 个对象，请缩小范围后保存"})
			render_dirty=true
			refresh_visuals()
			return
		edit.object_ids=ids
	render_dirty=true
	projection_dirty=true
	refresh_visuals()
	scoped_emit("annotation_adjustment",{"id":edit.id,"position":edit.position,"geometry":edit.geometry,"object_ids":edit.get("object_ids",[]),"final":final})

func begin_edit_drag(screen: Vector2) -> bool:
	if canvas_mode() or edit.is_empty(): return false
	var hit=visuals.hit_handle(screen)
	if hit.is_empty(): return false
	var origin=Spatial.vec(edit.position)
	edit_drag={"handle":hit,"start":screen,"origin":origin,"original":edit.duplicate(true),"world_size":visuals.gizmo.world_size}
	if hit in ["xy","xz","yz"]:
		var normal=Vector3.ZERO
		normal[Spatial.axes(hit)[2]]=1
		var start=host.ray_on_plane(screen,origin,normal)
		if start==null: edit_drag.clear(); return false
		edit_drag.plane_start=start
		edit_drag.normal=normal
	else:
		var axis=int(hit.trim_prefix("face-"))/2 if hit.begins_with("face-") else ["x","y","z"].find(hit)
		if axis<0: edit_drag.clear(); return false
		var direction=Vector3.ZERO
		direction[axis]=1
		var a=host.camera.unproject_position(origin)
		var b=host.camera.unproject_position(origin+direction*visuals.gizmo.world_size)
		if a.distance_to(b)<8*host.gizmo.pixel_ratio: edit_drag.clear(); return false
		edit_drag.axis=axis
		edit_drag.screen_axis=(b-a).normalized()
		edit_drag.screen_length=a.distance_to(b)
	return true

func move_edit_drag(event: InputEventMouseMotion) -> void:
	var original: Dictionary=edit_drag.original
	var delta=Vector3.ZERO
	var fine=.1 if event.shift_pressed else 1.0
	if edit_drag.has("normal"):
		var point=host.ray_on_plane(event.position,edit_drag.origin,edit_drag.normal)
		if point==null: return
		delta=(point-edit_drag.plane_start)*fine
	else:
		delta[edit_drag.axis]=(event.position-edit_drag.start).dot(edit_drag.screen_axis)/edit_drag.screen_length*edit_drag.world_size*fine
	if event.ctrl_pressed: delta=delta.snapped(Vector3.ONE*.25)
	var center=Spatial.vec(original.position)+delta
	var geometry: Dictionary=original.get("geometry",{})
	if edit_drag.handle.begins_with("face-"):
		var face=int(edit_drag.handle.trim_prefix("face-"))
		var axis=face/2
		var size=Spatial.vec(geometry.size)
		var amount=delta[axis]
		var changed=clampf(size[axis]+amount*(1 if face%2 else -1),.05,1e4)
		amount=(changed-size[axis])*(1 if face%2 else -1)
		size[axis]=changed
		center=Spatial.vec(original.position)
		center[axis]+=amount*.5
		geometry=Spatial.moved_geometry(geometry,Spatial.array3(center),Spatial.array3(size))
	elif geometry.get("shape") in ["box","prism"]: geometry=Spatial.moved_geometry(geometry,Spatial.array3(center))
	adjust_edit(Spatial.array3(center),geometry,false)

func refresh_visuals() -> void:
	if visuals==null: return
	visuals.visible=not canvas_mode() and (enabled or not marks.is_empty())
	if render_dirty:
		render_dirty=false
		var values=marks.duplicate()
		if not edit.is_empty():
			values=values.filter(func(mark):return mark.id!=edit.id)
			values.append(edit)
		if not values.is_empty() and not canvas_mode():
			spatial.ensure_index()
			if spatial.last_bounds.is_empty(): spatial.object_bounds()
		visuals.set_marks(values,spatial.last_bounds if not canvas_mode() else {})
		queue_redraw()
	if plane_dirty:
		plane_dirty=false
		visuals.set_plane(plane,plane_offset,host.target,enabled and target_mode=="space" and not canvas_mode())
	visuals.update_handles(edit,enabled and not canvas_mode())

func _notification(what: int) -> void:
	if what==NOTIFICATION_APPLICATION_FOCUS_OUT or what==NOTIFICATION_WM_WINDOW_FOCUS_OUT:
		cancel_gesture()

func _process(delta: float) -> void:
	if host==null or not enabled and marks.is_empty(): return
	if drawing and (capture_document!=host.document_id or capture_seq!=host.applied_seq): cancel_gesture()
	var key=[host.camera.global_transform,host.camera.projection,host.camera.size,get_viewport().canvas_transform,get_viewport().get_visible_rect().size]
	if key!=camera_key:
		camera_key=key
		projection_dirty=true
		visuals.update_handles(edit,enabled and not canvas_mode())
		if canvas_mode(): queue_redraw()
	refresh_visuals_if_dirty()
	clock+=delta
	if projection_dirty and clock>=.05:
		clock=0
		projection_dirty=false
		var projections=[]
		var viewport_size=get_viewport().get_visible_rect().size
		var projected=marks.duplicate()
		if not edit.is_empty():
			projected=projected.filter(func(mark):return mark.id!=edit.id)
			projected.append(edit)
		for mark in projected:
			if not mark.get("position") is Array: continue
			var point=host.annotation_project(mark.position)
			projections.append({"id":mark.id,"screen":[point.x/viewport_size.x,point.y/viewport_size.y]})
		if not projections.is_empty():
			projection_emits+=1
			scoped_emit("annotation_projection",{"marks":projections})

func refresh_visuals_if_dirty() -> void:
	if render_dirty or plane_dirty: refresh_visuals()

func _draw() -> void:
	if host==null: return
	redraws+=1
	var color=Color("80baff")
	if enabled and not suspended and tool=="brush" and target_mode=="objects": draw_arc(cursor,radius*host.gizmo.pixel_ratio,0,TAU,48,color,1.5,true)
	if drawing and not points.is_empty():
		if target_mode=="space" and not canvas_mode():
			if world_path.size()>1 or tool=="brush" and not world_path.is_empty():
				var geometry=Spatial.box_geometry(world_path[0],world_path[-1],plane,plane_offset,depth) if tool=="volume" else Spatial.prism_geometry(world_path,world_radius,plane,plane_offset,depth)
				draw_spatial_preview(geometry,color)
		elif tool=="rect":
			var rect=Rect2(points[0],cursor-points[0]).abs()
			draw_rect(rect,Color(color,.1))
			draw_rect(rect,color,false,1.5)
		elif tool=="brush":
			var outline=brush_outline(points,radius*host.gizmo.pixel_ratio)
			if outline.size()>2:
				draw_colored_polygon(outline,Color(color,.1))
				outline.append(outline[0])
				draw_polyline(outline,color,1.5,true)
	if canvas_mode():
		for mark in marks:
			for id in mark.get("object_ids",[]):
				if host.objects.has(id): draw_rect(host.annotation_screen_rect(id),color,false,1.5)

func draw_spatial_preview(geometry: Dictionary,color: Color) -> void:
	if geometry.is_empty(): return
	var segments=[]
	if geometry.shape=="box":
		var size=Spatial.vec(geometry.size)
		var box=AABB(Spatial.vec(geometry.center)-size*.5,size)
		for i in 8:
			for bit in [1,2,4]:
				if (i&bit)==0: segments.append([box.get_endpoint(i),box.get_endpoint(i|bit)])
	else:
		var normal=Vector3.ZERO
		normal[Spatial.axes(geometry.plane)[2]]=geometry.depth
		for i in geometry.world_points.size():
			var a=Spatial.vec(geometry.world_points[i])
			var b=Spatial.vec(geometry.world_points[(i+1)%geometry.world_points.size()])
			segments.append([a,b])
			segments.append([a+normal,b+normal])
	for edge in segments:
		if not host.camera.is_position_behind(edge[0]) and not host.camera.is_position_behind(edge[1]): draw_line(host.camera.unproject_position(edge[0]),host.camera.unproject_position(edge[1]),color,1.5,true)
