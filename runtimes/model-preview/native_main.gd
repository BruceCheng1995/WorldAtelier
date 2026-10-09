extends "res://main.gd"
## Static native display only. Gameplay remains GameRuntime + standalone.tscn.
# The editor backdrop is presentation; authored environments and Play keep their own lighting.
func setup_environment() -> void:
	super.setup_environment()
	for child in get_children():
		if child is WorldEnvironment:
			child.environment.background_color = Color("#d5d4ce")

var native_config: Dictionary = {}
var native_active = false
var native_scene_generation=0
var native_document: Dictionary = {}
var native_content_scenes: Dictionary = {}
var authored_root: Node
var canvas_mode = false
var canvas_center = Vector2.ZERO
var canvas_zoom = 1.0
var canvas_drag = false
var canvas_pointer_active = false
var canvas_click_pending = false
var canvas_click_id = ""
var canvas_drag_before = Transform2D.IDENTITY
var canvas_drag_pointer = Vector2.ZERO
var canvas_drag_packet: Dictionary = {}
var control_drag_values: Dictionary = {}
var control_resize_handle = -1
var control_overlay: Node2D
var control_preview_generation = 0
var prefab_preview = preload("res://prefab_placement_preview.gd").new()

func _process(delta: float) -> void:
	super._process(delta)
	prefab_preview.advance(self)

func _ready() -> void:
	var config_path = "res://native-editor.json"
	if FileAccess.file_exists(config_path):
		var value = JSON.parse_string(FileAccess.get_file_as_string(config_path))
		if value is Dictionary: native_config=value
	super._ready()
	var layer := CanvasLayer.new()
	layer.layer = 100
	add_child(layer)
	control_overlay = load("res://control_layout_overlay.gd").new()
	control_overlay.host = self
	layer.add_child(control_overlay)
	if not cli_args.has("scene") and native_config.get("initial_scene") is Dictionary:
		var packet: Dictionary=native_config.initial_scene.duplicate(true)
		packet.merge({"source":"world-atelier-workspace","nonce":nonce,"type":"scene","seq":maxi(0,requested_seq+1)},true)
		receive(packet)

func receive(packet: Dictionary) -> void:
	if packet.get("source")!="world-atelier-workspace" or packet.get("nonce")!=nonce:return
	if packet.get("type")=="prefab_drag":
		prefab_preview.receive(self,packet)
		return
	if packet.get("type")=="scene" and packet.get("document_schema")=="creation-native-1":
		var seq=packet.get("seq")
		if not (seq is int or seq is float) or not is_finite(float(seq)) or seq<0 or seq!=floorf(float(seq)) or seq>9007199254740991:
			emit_error("invalid_sequence","scene seq must be a nonnegative integer",-1)
			return
		if seq<=requested_seq:return
		prefab_preview.clear(self)
		requested_seq=int(seq)
		generation+=1
		cancel_drag()
		load_native(packet)
		return
	if native_active:
		if packet.get("type")=="world":
			emit_error("native_editor_only","Play must use the canonical game build",applied_seq)
			return
		if packet.get("type")=="editor_preview":
			apply_native_preview(packet)
			return
	super.receive(packet)

func load_scene(packet: Dictionary, token: int) -> void:
	prefab_preview.clear(self)
	native_active=false
	canvas_mode=false
	authored_root=null
	get_viewport().canvas_transform=Transform2D.IDENTITY
	if editor_floor!=null:editor_floor.visible=true
	super.load_scene(packet,token)

func load_native(packet: Dictionary) -> void:
	prefab_preview.clear(self)
	var source_path=str(packet.get("native_scene_path",""))
	var mapped=native_config.get("preview_scenes",{}).get(source_path,"")
	if mapped is Dictionary: mapped=mapped.get("path","")
	var content=packet.get("native_preview_content")
	var packed: PackedScene
	var updated_scenes: Dictionary = {}
	if content is Dictionary:
		if content.get("resource_id")!=packet.get("resource_id") or content.get("native_scene_path")!=source_path:
			emit_error("native_content_mismatch","Updated scene does not match its requested resource",packet.seq)
			return
		var related=content.get("related_scenes",[])
		if not related is Array or related.size()>512:
			emit_error("native_content_mismatch","Updated scene closure is invalid",packet.seq)
			return
		for item in [content]+related:
			if not item is Dictionary:
				emit_error("native_content_mismatch","Updated scene closure is invalid",packet.seq)
				return
			var resource=updated_native_scene(item,packet)
			if resource==null:return
			var item_path=str(item.get("native_scene_path",""))
			if updated_scenes.has(item_path):
				emit_error("native_content_mismatch","Updated scene closure contains duplicate paths",packet.seq)
				return
			updated_scenes[item_path]=resource
		packed=updated_scenes[source_path]
	else:
		if mapped=="" or native_config.has("source_identity") and packet.get("source_identity")!=native_config.source_identity:
			emit_error("native_source_mismatch","This preview is pinned to another source identity",packet.seq)
			return
		packed=ResourceLoader.load(mapped,"PackedScene",ResourceLoader.CACHE_MODE_IGNORE_DEEP)
	if not packet.get("objects") is Array or not packet.get("document_id") is String:
		emit_error("invalid_native_scene","Native scene index is missing",packet.seq)
		return
	if not packed is PackedScene:
		emit_error("native_scene_load","Static native PackedScene failed to load",packet.seq)
		return
	var source: Node=packed.instantiate()
	if source==null:return
	if not scripts_absent(source):
		source.free()
		emit_error("native_preview_script","Preview cache unexpectedly contains an executable Node script",packet.seq)
		return
	var next_objects={}
	var next_definitions={}
	for row in packet.objects:
		if not row is Dictionary or not row.get("id") is String or not row.get("native_path") is String or next_objects.has(row.id):
			source.free()
			emit_error("invalid_native_index","Native object index is invalid",packet.seq)
			return
		var path_text: String=row.native_path
		if path_text.begins_with("/") or ".." in path_text.split("/"):
			source.free()
			emit_error("invalid_native_index","Native object path escapes its scene",packet.seq)
			return
		var node=source if path_text=="." else source.get_node_or_null(NodePath(path_text))
		if node==null:
			source.free()
			emit_error("native_index_mismatch","Indexed native node is absent: "+path_text,packet.seq,row.id)
			return
		next_objects[row.id]=node
		next_definitions[row.id]=row.duplicate(true)
	var stage=Node3D.new()
	stage.name="AuthoredScene"
	stage.add_child(source)
	var previous=scene_root
	scene_root=stage
	add_child(stage)
	remove_child(previous)
	previous.queue_free()
	hierarchy_editor.clear()
	objects=next_objects
	definitions=next_definitions
	authored_root=source
	native_document=packet.duplicate(true)
	native_document.erase("native_preview_content")
	native_content_scenes=updated_scenes
	native_active=true
	native_scene_generation+=1
	# A model-viewer ground plane must not occlude original geometry below y=0.
	if editor_floor!=null:editor_floor.visible=false
	active_assets=[]
	model_signature="native:"+source_path+":"+str(packet.get("source_identity",""))
	var preview_id=str(packet.get("preview_object_id",""))
	if mode=="object" and objects.has(preview_id):filter_preview(source,objects[preview_id])
	canvas_mode=has_canvas(source) and meshes(source).is_empty()
	var observed=packet.get("preview_observation",{})
	if objects.has(preview_id) and observed is Dictionary and Hierarchy.valid_matrix(observed.get("world_matrix")):
		var shown: Node=objects[preview_id]
		if shown is Node3D:shown.global_transform=Hierarchy.transform(observed.world_matrix)
		elif shown is Node2D:
			var m: Array=observed.world_matrix
			shown.global_transform=Transform2D(Vector2(m[0],m[1]),Vector2(m[4],m[5]),Vector2(m[12],m[13]))
	get_viewport().canvas_transform=Transform2D.IDENTITY
	var native_token = generation
	await get_tree().process_frame
	await get_tree().process_frame
	if native_token != generation: return
	finish_scene(packet,true)

func updated_native_scene(content: Dictionary, packet: Dictionary) -> PackedScene:
	var source_path=str(content.get("native_scene_path",""))
	if content.get("protocol")!="wa-native-editor-content-1" or content.get("base_source_identity")!=native_config.get("source_identity") or content.get("source_identity")!=packet.get("source_identity") or content.get("source_revision")!=packet.get("source_revision",packet.get("scene_revision")) or not source_path.begins_with("res://") or ".." in source_path.split("/"):
		emit_error("native_content_mismatch","Updated scene does not match this editor and source",packet.seq)
		return null
	var bytes=Marshalls.base64_to_raw(str(content.get("data_base64","")))
	var digest=HashingContext.new()
	digest.start(HashingContext.HASH_SHA256)
	digest.update(bytes)
	var actual=digest.finish().hex_encode()
	if bytes.is_empty() or bytes.size()>16*1024*1024 or bytes.size()!=content.get("size") or actual!=content.get("sha256"):
		emit_error("native_content_hash","Updated native scene bytes failed verification",packet.seq)
		return null
	var temporary_path="user://wa-editor-"+actual+".scn"
	var file=FileAccess.open(temporary_path,FileAccess.WRITE)
	if file==null:
		emit_error("native_content_write","Unable to load updated native scene",packet.seq)
		return null
	file.store_buffer(bytes)
	file.close()
	var packed=ResourceLoader.load(temporary_path,"PackedScene",ResourceLoader.CACHE_MODE_IGNORE_DEEP)
	DirAccess.remove_absolute(temporary_path)
	if not packed is PackedScene or not prefab_preview.safe_resource(packed,{}):
		emit_error("native_content_load","Updated scene is not a safe static PackedScene",packet.seq)
		return null
	return packed

func filter_preview(node: Node, focus: Node) -> void:
	var inside=node==focus or focus.is_ancestor_of(node)
	var ancestor=node.is_ancestor_of(focus)
	if not inside:
		if ancestor:
			# Hide only an ancestor's own drawable; descendants retain authored
			# parent transforms and inherited visibility/material state.
			if node is VisualInstance3D:node.layers=0
			if node is CanvasItem:node.self_modulate.a=0
		elif node is Node3D or node is CanvasItem or node is CanvasLayer:node.visible=false
	for child in node.get_children():filter_preview(child,focus)

func scripts_absent(node: Node) -> bool:
	if node.get_script()!=null:return false
	for child in node.get_children():
		if not scripts_absent(child):return false
	return true

func has_canvas(node: Node) -> bool:
	if node is CanvasItem:return true
	for child in node.get_children():
		if has_canvas(child):return true
	return false

func finish_scene(packet: Dictionary, rebuilt: bool) -> void:
	if not native_active:
		super.finish_scene(packet,rebuilt)
		return
	if document_id!=packet.document_id or branch_id!=str(packet.get("branch_id",branch_id)):
		collaboration_overlay.set_peers([])
		development_states.clear()
		development_received=false
	document_id=packet.document_id
	branch_id=str(packet.get("branch_id",branch_id))
	applied_seq=int(packet.seq)
	latest_scene_editable=packet.get("editable",true)
	editable=latest_scene_editable and mode=="main"
	scene_root.visible=true
	refresh_bounds()
	select_objects(packet.get("selected_ids",[packet.get("selected_id","")]),str(packet.get("selected_id","")),false)
	if packet.get("frame",true):frame_scene()
	elif canvas_mode:update_camera()
	var stats=telemetry()
	stats.merge({"type":"loaded","seq":applied_seq,"rebuilt":rebuilt,"render_verified":false})
	emit(stats)
	emit_editor_state()
	update_development_overlay()
	print("PREVIEW_LOADED "+JSON.stringify(stats))
	if cli_args.has("capture"):capture.call_deferred()
	elif cli_args.has("quit-on-loaded"):get_tree().quit(0)

func meshes(node: Node, owned: bool=false, root_node: Node=null) -> Array:
	var result=[]
	if root_node==null:root_node=node
	if owned and node!=root_node and node in objects.values():return result
	if node is MeshInstance3D and node.mesh!=null and node.layers!=0 and node.is_visible_in_tree():result.append(node)
	for child in node.get_children():result.append_array(meshes(child,owned,root_node))
	return result

func object_bounds(id: String) -> AABB:
	if not native_active:return super.object_bounds(id)
	var node: Node=objects[id]
	var measured=meshes(node)
	var bounds=AABB()
	for mesh in measured:
		var box: AABB=mesh.global_transform*mesh.get_aabb()
		bounds=box if bounds.size==Vector3.ZERO else bounds.merge(box)
	if not measured.is_empty():return bounds
	return AABB((node.global_position if node is Node3D else Vector3.ZERO)-Vector3.ONE*.2,Vector3.ONE*.4)

func display_bounds(id: String) -> AABB:
	return object_bounds(id) if native_active else super.display_bounds(id)

func manipulated_object(id: String) -> Node:
	var node: Node=objects.get(id)
	if native_active and node!=null and definitions.get(id,{}).has("native_mount_target"):
		# The visible node can sit below a definition root, not directly below
		# its placement mount. Resolve the complete instance address so canonical
		# mount poses never overwrite the authored transform of the visible node.
		var expected: Array=definitions[id].native_mount_target.get("instance_ids",[])
		var parent=node.get_parent()
		while parent!=null and parent!=authored_root:
			if parent.get_meta("wa_instance_mount",false):
				var instance_ids: Array=[]
				var ancestor=parent
				while ancestor!=null and ancestor!=authored_root:
					var instance_id=str(ancestor.get_meta("wa_instance_id",""))
					if instance_id!="":instance_ids.push_front(instance_id)
					ancestor=ancestor.get_parent()
				if instance_ids==expected:return parent
			parent=parent.get_parent()
		return null
	return node

func scene_observation(id: String) -> Dictionary:
	if not native_active:return super.scene_observation(id)
	var node: Node=objects[id]
	var subject=manipulated_object(id)
	var row: Dictionary=definitions[id].duplicate(true)
	row.merge({"id":id,"scene_generation":native_scene_generation,"document_schema":"creation-native-1","source_revision":native_document.get("source_revision",native_document.get("scene_revision","")),"source_identity":native_document.get("source_identity",""),"version":row.get("version",""),"object_version":row.get("version","")},true)
	if row.has("native_mount_target"):
		row["display_native_target"]=row.get("native_target")
		row["native_target"]=row.native_mount_target
		row["transform_target"]=row.native_mount_target
	if subject is Node3D:
		row.merge({"position":Factory.array3(subject.global_position),"rotation":Factory.array3(subject.global_rotation_degrees),"scale":Factory.array3(subject.global_basis.get_scale()),"world_matrix":Hierarchy.matrix(subject.global_transform),"local_transform":trs(subject),"dimension":"3d"},true)
	elif subject is Node2D:
		row.merge({"position":[subject.global_position.x,subject.global_position.y,0],"rotation":[0,0,subject.global_rotation_degrees],"scale":[subject.global_scale.x,subject.global_scale.y,1],"local_transform":{"position":[subject.position.x,subject.position.y,0],"rotation":[0,0,subject.rotation_degrees],"scale":[subject.scale.x,subject.scale.y,1]},"local_transform_2d":matrix2(subject.transform),"world_transform_2d":matrix2(subject.global_transform),"dimension":"2d"},true)
	elif subject is Control:
		var global = subject.get_global_transform()
		row.merge({"position":[global.origin.x,global.origin.y,0],"rotation":[0,0,rad_to_deg(global.get_rotation())],"scale":[global.get_scale().x,global.get_scale().y,1],"local_transform":{"position":[subject.position.x,subject.position.y,0],"rotation":[0,0,subject.rotation_degrees],"scale":[subject.scale.x,subject.scale.y,1]},"local_transform_2d":matrix2(subject.get_transform()),"world_transform_2d":matrix2(global),"dimension":"2d"},true)
		var layout: Dictionary = row.get("control_layout",{}).duplicate(true)
		layout["values"] = control_values(subject)
		layout["needs_measurement"] = false
		layout["minimum_size"] = [subject.get_combined_minimum_size().x,subject.get_combined_minimum_size().y]
		layout["viewport_size"] = [get_viewport().get_visible_rect().size.x,get_viewport().get_visible_rect().size.y]
		layout["parent_size"] = [subject.get_parent_area_size().x,subject.get_parent_area_size().y]
		row["control_layout"] = layout
	elif subject is CanvasItem:
		row["world_transform_2d"]=matrix2(subject.get_global_transform())
		row["dimension"]="2d"
	else:row["dimension"]=null
	row["transform_editable"]=editable and (subject is Node3D or subject is Node2D or subject is Control and not subject.get_parent() is Container)
	return row

func matrix2(value: Transform2D) -> Array:
	return [value.x.x,value.x.y,value.y.x,value.y.y,value.origin.x,value.origin.y]

func telemetry() -> Dictionary:
	if not native_active:return super.telemetry()
	var rows=[]
	for id in objects:
		var row=scene_observation(id)
		row["mesh_count"]=meshes(objects[id],true).size()
		row["visible"]=objects[id].is_visible_in_tree() if objects[id].has_method("is_visible_in_tree") else true
		rows.append(row)
	return {"document_id":document_id,"document_schema":"creation-native-1","source_revision":native_document.get("source_revision",native_document.get("scene_revision","")),"source_identity":native_document.get("source_identity",""),"native_scene_path":native_document.get("native_scene_path",""),"scene_generation":native_scene_generation,"object_ids":objects.keys(),"objects":rows,"mesh_count":meshes(authored_root).size(),"bounds":Factory.bounds_json(scene_bounds),"assets":[],"selected_id":selected_id,"selected_ids":selected_ids.duplicate(),"static_preview":true,"preview_policy":native_config.get("policy",{}),"dimension":"2d" if canvas_mode else "3d"}

func selection_packet() -> Dictionary:
	if not native_active: return super.selection_packet()
	return scene_observation(selected_id) if selected_id != "" else {}

func placement_source() -> Dictionary:
	if not native_active: return super.placement_source()
	return {"source_revision":native_document.get("source_revision",native_document.get("scene_revision","")), "source_identity":native_document.get("source_identity","")}

func placement_meshes() -> Array:
	if not native_active: return super.placement_meshes()
	return meshes(authored_root) if is_instance_valid(authored_root) else []

func placement_at(screen: Vector2) -> Dictionary:
	if not native_active or not canvas_mode: return super.placement_at(screen)
	var transform = get_viewport().canvas_transform
	if not transform.is_finite() or absf(transform.determinant()) < 0.00000001: return {"error":"invalid_placement_canvas"}
	var position = transform.affine_inverse() * screen
	if not position.is_finite(): return {"error":"invalid_placement_canvas"}
	return {"dimension":"2d", "position":[position.x,position.y]}

func canvas_rect(node: Node) -> Rect2:
	var rect=Rect2()
	if node is Control:rect=Rect2(Vector2.ZERO,node.size)
	elif node is Sprite2D:rect=node.get_rect()
	elif node is Polygon2D:
		for p in node.polygon:rect=Rect2(p,Vector2.ZERO) if rect==Rect2() else rect.expand(p)
	elif node is Node2D:rect=Rect2(Vector2(-8,-8),Vector2(16,16))
	if not node is CanvasItem:return Rect2()
	var transform: Transform2D=node.get_global_transform_with_canvas()
	return transform*rect

func selection_screen_rect(id: String) -> Rect2:
	if not native_active or not objects[id] is CanvasItem:
		return collaboration_overlay.remote_selections.project_bounds(display_bounds(id))
	return canvas_rect(objects[id])

func pick_object(screen: Vector2) -> String:
	if not native_active:return super.pick_object(screen)
	var ordered=objects.keys()
	ordered.reverse()
	for id in ordered:
		var node: Node=objects[id]
		if node is Control and node.is_visible_in_tree():
			var transform = node.get_global_transform_with_canvas()
			if abs(transform.determinant()) > 0.00000001 and Rect2(Vector2.ZERO,node.size).has_point(transform.affine_inverse()*screen): return id
		elif node is CanvasItem and node.is_visible_in_tree() and canvas_rect(node).has_point(screen):return id
	var ray_origin=camera.project_ray_origin(screen)
	var direction=camera.project_ray_normal(screen)
	var best=INF
	var selected=""
	for id in objects:
		for mesh in meshes(objects[id],true):
			if not mesh.is_visible_in_tree() or absf(mesh.global_basis.determinant()) < 0.00000001: continue
			var inverse=mesh.global_transform.affine_inverse()
			var local_origin=inverse*ray_origin
			var local_direction=(inverse.basis*direction).normalized()
			if mesh.get_aabb().intersects_ray(local_origin,local_direction)==null:continue
			var faces=mesh.mesh.get_faces()
			for i in range(0,faces.size()-2,3):
				var hit=Geometry3D.ray_intersects_triangle(local_origin,local_direction,faces[i],faces[i+1],faces[i+2])
				if hit==null:continue
				var depth=ray_origin.distance_to(mesh.global_transform*hit)
				if depth<best:
					best=depth
					selected=id
	return selected

func pointer_selection_path(id: String) -> Array:
	var path = super.pointer_selection_path(id)
	if not native_active: return path
	var preview_id = str(native_document.get("preview_object_id", "")) if mode == "object" else ""
	if objects.has(preview_id):
		var start = path.find(preview_id)
		return path.slice(start) if start >= 0 else []
	# The open document is the canvas, rather than an extra click before every
	# top-level object. Its own geometry remains selectable when hit directly.
	if path.size() > 1 and definitions[path[0]].get("native_path") == ".": path.pop_front()
	return path

func frame_scene(focus_selected: bool=false) -> void:
	var preview_id=str(native_document.get("preview_object_id","")) if native_active and mode=="object" else ""
	if not canvas_mode and objects.has(preview_id):
		var previous=selected_id
		selected_id=preview_id
		super.frame_scene(true)
		selected_id=previous
		update_helpers()
		return
	if not native_active or not canvas_mode:
		super.frame_scene(focus_selected)
		return
	get_viewport().canvas_transform=Transform2D.IDENTITY
	var bounds=Rect2()
	for id in objects:
		var focus_id=preview_id if objects.has(preview_id) else selected_id if focus_selected else ""
		if objects.has(focus_id) and id!=focus_id and not objects[focus_id].is_ancestor_of(objects[id]):continue
		if not objects[id] is CanvasItem:continue
		var rect=canvas_rect(objects[id])
		if rect.has_area():bounds=rect if not bounds.has_area() else bounds.merge(rect)
	if bounds.has_area():
		canvas_center=bounds.get_center()
		var viewport=get_viewport().get_visible_rect().size
		canvas_zoom=clampf(minf(viewport.x/maxf(1,bounds.size.x),viewport.y/maxf(1,bounds.size.y))*.8,.001,1000)
	update_camera()
	emit_camera()

func update_camera() -> void:
	if native_active and canvas_mode:
		get_viewport().canvas_transform=Transform2D(Vector2(canvas_zoom,0),Vector2(0,canvas_zoom),get_viewport().get_visible_rect().size*.5-canvas_center*canvas_zoom)
		update_helpers(false)
	else:super.update_camera()

func emit_camera() -> void:
	if native_active and canvas_mode:
		emit({"type":"camera","document_id":document_id,"seq":applied_seq,"dimension":"2d","position":[canvas_center.x,canvas_center.y,100],"target":[canvas_center.x,canvas_center.y,0],"zoom":canvas_zoom,"view":"front","projection":"orthographic"})
	else:super.emit_camera()

func _input(event: InputEvent) -> void:
	if editor_annotations != null and editor_annotations.handle_input(event): return
	var canvas_input = canvas_mode or canvas_drag or canvas_pointer_active
	if native_active and not canvas_input:
		if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
			canvas_input = control_handle_at(event.position) >= 0 or objects.get(pick_object(event.position)) is Control
		elif event is InputEventKey: canvas_input = manipulated_object(selected_id) is Control
	if not native_active or not canvas_input:
		super._input(event)
		return
	if event is InputEventKey and event.pressed:
		if event.ctrl_pressed or event.meta_pressed:
			super._input(event)
			return
		if event.keycode==KEY_ESCAPE:cancel_drag()
		elif event.keycode==KEY_F:frame_scene(not event.shift_pressed)
		elif event.keycode==KEY_Q:set_editor_tool("select")
		elif event.keycode==KEY_W:set_editor_tool("move")
		elif event.keycode==KEY_E:set_editor_tool("rotate")
		elif event.keycode==KEY_R:set_editor_tool("scale")
		return
	if event is InputEventPanGesture:
		canvas_center += event.delta * 16 / canvas_zoom
		update_camera()
		emit_camera()
		return
	if event is InputEventMagnifyGesture:
		zoom_canvas(event.position, event.factor)
		return
	if event is InputEventMouseButton:
		if event.pressed and event.button_index in [MOUSE_BUTTON_WHEEL_DOWN,MOUSE_BUTTON_WHEEL_UP]:
			if canvas_drag: cancel_drag()
			zoom_canvas(event.position, exp((.12 if event.button_index==MOUSE_BUTTON_WHEEL_UP else -.12)*maxf(.01,event.factor)))
		elif event.button_index in [MOUSE_BUTTON_LEFT,MOUSE_BUTTON_MIDDLE,MOUSE_BUTTON_RIGHT]:
			if event.pressed:
				button_down=event.button_index
				pointer_start=event.position
				pointer_moved=false
				if event.button_index==MOUSE_BUTTON_LEFT and Input.is_physical_key_pressed(KEY_SPACE):
					navigation="pan"
				elif event.button_index==MOUSE_BUTTON_LEFT:
					canvas_pointer_active=true
					canvas_click_pending=false
					var multi_select = event.ctrl_pressed or event.meta_pressed or event.shift_pressed
					control_resize_handle = -1 if multi_select else control_handle_at(event.position)
					if control_resize_handle < 0:
						var hit = pick_object(event.position)
						# Keep a selected parent as the drag target. Only a completed
						# click enters its child; moving the pointer must not drill.
						canvas_click_pending = not multi_select and selected_ids.size() == 1 and selected_id in pointer_selection_path(hit)
						if canvas_click_pending: canvas_click_id = pointer_selection_target(hit)
						else: select_pointer(hit,event)
					var node=manipulated_object(selected_id)
					if editable and not multi_select and (node is Node2D or node is Control and not node.get_parent() is Container) and (editor_tool!="select" or control_resize_handle>=0):
						canvas_drag=true
						canvas_drag_before=node.get_transform()
						control_drag_values=control_values(node) if node is Control else {}
						canvas_drag_pointer=event.position
						canvas_drag_packet=scene_observation(selected_id)
						emit_canvas_transform("start")
			elif event.button_index==button_down:
				var click_id = canvas_click_id
				var complete_click = canvas_click_pending and not pointer_moved
				if canvas_drag:
					if pointer_moved: emit_canvas_transform("commit")
					else: cancel_drag()
				canvas_drag=false
				canvas_pointer_active=false
				canvas_click_pending=false
				control_resize_handle=-1
				button_down=0
				navigation=""
				if complete_click: select_object(click_id,true)
	elif event is InputEventMouseMotion:
		if button_down and (event.button_mask & (1 << (button_down - 1))) == 0:
			cancel_drag()
			return
		if button_down and event.position.distance_to(pointer_start) > 3: pointer_moved=true
		if canvas_drag:
			if not pointer_moved: return
			var node=manipulated_object(selected_id)
			var delta=event.position-canvas_drag_pointer
			if node is Control: apply_control_values(node,control_drag_values)
			else: node.transform=canvas_drag_before
			if node is Control and control_resize_handle >= 0:
				resize_control(node,delta)
			elif editor_tool=="move":
				var local = node.get_transform()
				if abs(local.determinant()) < 0.00000001: return
				var parent_canvas = node.get_global_transform_with_canvas() * local.affine_inverse()
				if abs(parent_canvas.determinant()) < 0.00000001: return
				node.position+=parent_canvas.affine_inverse().basis_xform(delta)
			elif editor_tool=="rotate":node.rotation+=delta.x*.01
			elif editor_tool=="scale":node.scale*=maxf(.001,1+(delta.x-delta.y)*.01)
			emit_canvas_transform("preview")
		elif button_down in [MOUSE_BUTTON_MIDDLE,MOUSE_BUTTON_RIGHT] or button_down==MOUSE_BUTTON_LEFT and navigation=="pan":
			canvas_center-=event.relative/canvas_zoom
			update_camera()
			emit_camera()

func zoom_canvas(screen: Vector2, factor: float) -> void:
	var before = get_viewport().canvas_transform.affine_inverse() * screen
	canvas_zoom = clampf(canvas_zoom * factor, .001, 1000)
	canvas_center = before - (screen - get_viewport().get_visible_rect().size*.5) / canvas_zoom
	update_camera()
	emit_camera()

func annotation_screen_rect(id: String) -> Rect2:
	return selection_screen_rect(id) if native_active else super.annotation_screen_rect(id)

func annotation_project(position: Array) -> Vector2:
	if canvas_mode: return get_viewport().canvas_transform * Vector2(position[0],position[1])
	return super.annotation_project(position)

func emit_canvas_transform(phase: String) -> void:
	var packet=scene_observation(selected_id)
	packet.merge({"type":"transform","phase":phase,"id":selected_id,"document_id":document_id,"seq":applied_seq,"before":canvas_drag_packet.duplicate(true),"tool":editor_tool,"handle":"resize_"+str(control_resize_handle) if control_resize_handle>=0 else "xy"},true)
	if manipulated_object(selected_id) is Control:
		var values: Dictionary=packet.control_layout.values
		var field="offsets" if control_resize_handle>=0 or editor_tool=="move" else "rotation_degrees" if editor_tool=="rotate" else "scale"
		packet["control_changed"]={field:values[field]}
	emit(packet)

func cancel_drag() -> void:
	if canvas_drag and manipulated_object(selected_id) is Node2D:
		manipulated_object(selected_id).transform=canvas_drag_before
		emit_canvas_transform("cancel")
	if canvas_drag and manipulated_object(selected_id) is Control:
		apply_control_values(manipulated_object(selected_id),control_drag_values)
		emit_canvas_transform("cancel")
	canvas_drag=false
	canvas_pointer_active=false
	canvas_click_pending=false
	canvas_click_id=""
	control_resize_handle=-1
	super.cancel_drag()

func apply_native_preview(packet: Dictionary) -> void:
	if not current_command(packet) or packet.get("source_identity",native_document.get("source_identity"))!=native_document.get("source_identity"):return
	# Restore canonical poses before applying active targets. Resetting children
	# after a moved parent would incorrectly cancel the parent's live preview.
	control_preview_generation += 1
	var preview_generation = control_preview_generation
	var needs_layout_settle = false
	var rows: Array=packet.get("canonical_objects",[]).duplicate()
	rows.append_array(packet.get("objects",[]))
	for row in rows:
		var id=str(row.get("id",""))
		if not objects.has(id) or row.get("native_target")!=scene_observation(id).get("native_target"):continue
		var node=manipulated_object(id)
		if node is Node3D and Hierarchy.valid_matrix(row.get("world_matrix")):
			node.global_transform=Hierarchy.transform(row.world_matrix)
			continue
		if node is Control and row.get("control_layout") is Dictionary:
			apply_control_values(node,row.control_layout)
			needs_layout_settle = needs_layout_settle or node.get_parent() is Container
			continue
		var value=row.get("local_transform_patch",row.get("local_transform"))
		if not value is Dictionary:continue
		if node is Node3D:
			if value.has("position"):node.position=Vector3(value.position[0],value.position[1],value.position[2])
			if value.has("rotation"):node.rotation_degrees=Vector3(value.rotation[0],value.rotation[1],value.rotation[2])
			if value.has("scale"):node.scale=Vector3(value.scale[0],value.scale[1],value.scale[2])
		elif node is Node2D:
			if value.has("position"):node.position=Vector2(value.position[0],value.position[1])
			if value.has("rotation"):node.rotation_degrees=value.rotation[2]
			if value.has("scale"):node.scale=Vector2(value.scale[0],value.scale[1])
	if needs_layout_settle:
		await get_tree().process_frame
		await get_tree().process_frame
		if preview_generation != control_preview_generation or not current_command(packet): return
	update_helpers()
	for id in packet.get("observe_ids",[]):
		if not objects.has(id):continue
		var observed=scene_observation(id)
		observed.merge({"type":"native_transform_preview","document_id":document_id,"seq":applied_seq},true)
		emit(observed)

func control_values(node: Control) -> Dictionary:
	return {"anchors":[node.anchor_left,node.anchor_top,node.anchor_right,node.anchor_bottom],"offsets":[node.offset_left,node.offset_top,node.offset_right,node.offset_bottom],"position":[node.position.x,node.position.y],"size":[node.size.x,node.size.y],"pivot_offset":[node.pivot_offset.x,node.pivot_offset.y],"rotation_degrees":node.rotation_degrees,"scale":[node.scale.x,node.scale.y],"custom_minimum_size":[node.custom_minimum_size.x,node.custom_minimum_size.y],"grow_horizontal":node.grow_horizontal,"grow_vertical":node.grow_vertical,"size_flags_horizontal":node.size_flags_horizontal,"size_flags_vertical":node.size_flags_vertical,"size_flags_stretch_ratio":node.size_flags_stretch_ratio}

func apply_control_values(node: Control, value: Dictionary) -> void:
	var managed = node.get_parent() is Container
	for key in ["anchors","offsets","position","size","pivot_offset","rotation_degrees","scale","custom_minimum_size","grow_horizontal","grow_vertical","size_flags_horizontal","size_flags_vertical","size_flags_stretch_ratio"]:
		if not value.has(key) or managed and key not in ["custom_minimum_size","size_flags_horizontal","size_flags_vertical","size_flags_stretch_ratio"]: continue
		if key in ["anchors","offsets"]:
			for i in 4:
				if key == "anchors": node.set_anchor(i,float(value[key][i]),false,true)
				else: node.set_offset(i,float(value[key][i]))
		elif value[key] is Array: node.set(key,Vector2(value[key][0],value[key][1]))
		else: node.set(key,value[key])

func control_handle_points() -> PackedVector2Array:
	if selected_ids.size() > 1: return PackedVector2Array()
	var node = manipulated_object(selected_id)
	if not native_active or not editable or not node is Control or node.get_parent() is Container or not node.is_visible_in_tree(): return PackedVector2Array()
	var result = PackedVector2Array()
	var transform = node.get_global_transform_with_canvas()
	for unit in [Vector2(0,0),Vector2(.5,0),Vector2(1,0),Vector2(1,.5),Vector2(1,1),Vector2(.5,1),Vector2(0,1),Vector2(0,.5)]: result.append(transform*(unit*node.size))
	return result

func control_handle_at(screen: Vector2) -> int:
	var points = control_handle_points()
	for i in points.size():
		if screen.distance_to(points[i]) <= 7: return i
	return -1

func resize_control(node: Control, screen_delta: Vector2) -> void:
	var transform = node.get_global_transform_with_canvas()
	if abs(transform.determinant()) < 0.00000001: return
	var delta = transform.affine_inverse().basis_xform(screen_delta)
	var old_size = Vector2(control_drag_values.size[0],control_drag_values.size[1])
	var old_position = Vector2(control_drag_values.position[0],control_drag_values.position[1])
	var left = control_resize_handle in [0,6,7]
	var right = control_resize_handle in [2,3,4]
	var top = control_resize_handle in [0,1,2]
	var bottom = control_resize_handle in [4,5,6]
	node.size = Vector2(maxf(0,old_size.x + (delta.x if right else -delta.x if left else 0)),maxf(0,old_size.y + (delta.y if bottom else -delta.y if top else 0)))
	var shift = Vector2(old_size.x-node.size.x if left else 0,old_size.y-node.size.y if top else 0)
	node.position = old_position + canvas_drag_before.basis_xform(shift)
