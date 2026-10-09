extends SceneTree

const Spatial = preload("res://annotation_spatial.gd")

var host: Node
var checks: Array = []
var metrics: Array = []
var out = ""
var scope = "execution"

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--out="): out=arg.substr(6)
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":scope+": "+detail})
	if not ok: print("ANNOTATION_SPATIAL_FAILED "+scope+": "+detail)

func events(type: String) -> Array:
	return host.outbound_log.filter(func(packet): return packet.get("type")==type)

func configure(extra: Dictionary = {}) -> void:
	var packet={"source":"world-atelier-workspace","nonce":host.nonce,"type":"annotation","seq":host.applied_seq,"document_id":host.document_id,"enabled":true,"suspended":false,"tool":"point","target":"objects","plane":"xz","plane_offset":0.0,"depth":2.0}
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

func register(node: Node, id: String, kind: String = "mesh") -> Node:
	var row={"id":id,"name":id,"parent_id":null,"kind":kind,"version":"v1","native_path":str(host.scene_root.get_path_to(node)),"native_target":{"node_id":id,"instance_ids":[]},"dimension":"3d"}
	host.objects[id]=node
	host.definitions[id]=row
	return node

func mesh(id: String, at: Vector3, size: Vector3 = Vector3.ONE, parent: Node = null) -> MeshInstance3D:
	var node=MeshInstance3D.new()
	(parent if parent!=null else host.scene_root).add_child(node)
	var box=BoxMesh.new()
	box.size=size
	node.mesh=box
	node.position=at
	register(node,id)
	return node

func state() -> Dictionary:
	var poses={}
	for id in host.objects: poses[id]=host.objects[id].get_transform()
	return {"poses":poses,"definitions":host.definitions.duplicate(true),"selection":host.selected_ids.duplicate()}

func new_host() -> void:
	host=load("res://native_main.gd").new()
	root.add_child(host)
	host.set_process(false)
	host.set_process_input(false)
	host.document_id="independent/main/spatial-annotations"
	host.applied_seq=1
	host.requested_seq=1
	host.placement_revision="spatial-source-v1"
	host.native_active=true
	host.native_document={"source_identity":"spatial-native-v1","source_revision":"spatial-source-v1"}
	host.authored_root=host.scene_root
	host.canvas_mode=false
	host.editor_tool="move"
	host.target=Vector3.ZERO
	host.yaw=0
	host.pitch=.5
	host.distance=15
	host.update_camera()

func sample(name: String, operation: Callable, count: int = 40) -> void:
	var times=[]
	for i in count:
		var began=Time.get_ticks_usec()
		operation.call()
		times.append(float(Time.get_ticks_usec()-began)/1000.0)
	times.sort()
	metrics.append({"name":name,"count":count,"p50_ms":times[count/2],"p95_ms":times[mini(count-1,int(count*.95))],"max_ms":times[-1]})

func near3(a: Array, b: Vector3, tolerance: float = .001) -> bool:
	return Spatial.vec(a).distance_to(b)<tolerance

func selected(ids: Array) -> Array:
	var sorted=ids.duplicate()
	sorted.sort()
	return sorted

func rectangle3(a: Vector3, b: Vector3, plane: String, offset: float, depth: float) -> Dictionary:
	return Spatial.box_geometry(a,b,plane,offset,depth)

func exercise_geometry() -> void:
	scope="world geometry"
	new_host()
	var spatial=Spatial.new()
	spatial.setup(host)
	var left=mesh("left",Vector3(-2,1,0))
	var right=mesh("right",Vector3(2,1,0))
	var upper=mesh("upper",Vector3(-2,5,0))
	var hidden=mesh("hidden",Vector3(-2,1,0))
	hidden.hide()
	var nested=Node3D.new()
	host.scene_root.add_child(nested)
	nested.position=Vector3(5,0,0)
	nested.scale=Vector3(2,1,.5)
	register(nested,"parent","node")
	var child=mesh("child",Vector3(0,1,0),Vector3.ONE,nested)
	var shared=mesh("shared",Vector3(8,1,0))
	shared.mesh=left.mesh
	host.refresh_bounds()
	await process_frame
	var source=state()
	var bounds=spatial.object_bounds()
	check(bounds.has("left") and bounds.has("right") and bounds.has("child"),"native mesh owners enter the spatial index")
	check(not bounds.has("hidden"),"hidden native mesh is excluded")
	check(not bounds.has("parent"),"an addressable parent does not duplicate its addressable child's mesh")
	check(bounds.child.size.is_equal_approx(Vector3(2,1,.5)),"spatial bounds preserve inherited non-uniform scale")
	var box=rectangle3(Vector3(-3,0,-1),Vector3(-1,0,1),"xz",0,2)
	check(box.shape=="box" and box.size==[2.0,2.0,2.0],"box creation stores all three dimensions")
	check(near3(box.center,Vector3(-2,1,0)),"box center is in world coordinates")
	check(spatial.world_members(box)==["left"],"world box selects only intersecting visible objects")
	var ids=spatial.world_members(box)
	host.yaw=1.3
	host.pitch=.2
	host.update_camera()
	check(spatial.world_members(box)==ids,"world box membership is invariant under camera movement")
	check(spatial.stats.index_builds==1,"camera movement does not rebuild the spatial mesh index")
	var raised=Spatial.moved_geometry(box,[-2.0,5.0,0.0])
	check(near3(raised.center,Vector3(-2,5,0)) and raised.offset==4.0,"XYZ box movement updates its center and lower plane")
	check(spatial.world_members(raised)==["upper"],"moving the volume recomputes its real world member set")
	var enlarged=Spatial.moved_geometry(box,[0.0,1.0,0.0],[6.0,2.0,2.0])
	check(selected(spatial.world_members(enlarged))==["left","right"],"box resize includes newly intersecting objects")
	check(box.center==[-2.0,1.0,0.0] and box.size==[2.0,2.0,2.0],"moving and resizing retain the original geometry unchanged")
	for plane in ["xz","xy","yz"]:
		var basis_axes=Spatial.axes(plane)
		var a=Vector3.ZERO
		var b=Vector3.ZERO
		a[basis_axes[0]]=-1
		a[basis_axes[1]]=-2
		b[basis_axes[0]]=1
		b[basis_axes[1]]=2
		var volume=rectangle3(a,b,plane,3,4)
		check(volume.center[basis_axes[2]]==5 and volume.size[basis_axes[2]]==4,plane+" volume extrudes along its declared normal")
		check(volume.center[basis_axes[0]]==0 and volume.center[basis_axes[1]]==0,plane+" volume uses the correct two plane axes")
	var path: Array[Vector3]=[Vector3(-3,0,0),Vector3(3,0,0)]
	var prism=Spatial.prism_geometry(path,.65,"xz",0,2)
	check(prism.shape=="prism" and prism.world_points.size()>=4,"spatial brush records a finite world-space polygon")
	check(prism.world_points.size()<=96,"spatial brush bounds immutable polygon complexity")
	check(prism.world_points.all(func(point): return absf(point[1])<.001),"all brush boundary vertices lie on the fixed work plane")
	check(selected(spatial.world_members(prism))==["left","right"],"extruded brush footprint determines world members")
	var raised_prism=Spatial.moved_geometry(prism,[prism.center[0],5.0,prism.center[2]],[],3)
	check(raised_prism.depth==3 and raised_prism.offset==3.5,"prism movement and depth are represented exactly")
	check(raised_prism.world_points.all(func(point): return absf(point[1]-3.5)<.001),"moving brush depth keeps its boundary on the new lower plane")
	check(spatial.world_members(raised_prism)==["upper"],"prism depth and world position change membership")
	check(prism.offset==0 and prism.depth==2,"prism adjustment does not mutate captured original geometry")
	check(state()==source,"spatial indexing, geometry and membership never change authored source or selection")
	host.free()

func exercise_picking() -> void:
	scope="precise picking and cache"
	new_host()
	host.pitch=0
	host.update_camera()
	var back=mesh("back",Vector3.ZERO,Vector3(2,2,2))
	var front=mesh("front",Vector3(0,0,3),Vector3.ONE)
	var hidden=mesh("hidden",Vector3(0,0,5),Vector3(3,3,1))
	hidden.hide()
	var twin=mesh("twin",Vector3(3,0,3),Vector3.ONE)
	twin.mesh=front.mesh
	var zero=mesh("singular",Vector3(0,0,7),Vector3(3,3,1))
	zero.scale=Vector3.ZERO
	var separated=MeshInstance3D.new()
	host.scene_root.add_child(separated)
	separated.position=Vector3(0,0,6)
	var array_mesh=ArrayMesh.new()
	var arrays=[]
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX]=PackedVector3Array([Vector3(-3,-1,0),Vector3(-2,1,0),Vector3(-2,-1,0),Vector3(2,-1,0),Vector3(2,1,0),Vector3(3,-1,0)])
	array_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES,arrays)
	separated.mesh=array_mesh
	register(separated,"disconnected")
	host.refresh_bounds()
	await process_frame
	var spatial=Spatial.new()
	spatial.setup(host)
	var source=state()
	var center=host.camera.unproject_position(Vector3.ZERO)
	var hit=spatial.ray_pick(center)
	check(hit.get("object_id")=="front","ray selects the nearest exact visible surface, excluding hidden and singular meshes")
	check(hit.get("object_id")!="disconnected","a ray through an empty mesh AABB gap does not select disconnected triangles")
	check(near3(hit.get("position",[]),Vector3(0,0,3.5)),"precise pick returns the actual triangle surface point")
	check(spatial.stats.index_builds==1,"first pick builds the ownership index once")
	var builds=spatial.stats.bvh_builds
	for i in 8: spatial.ray_pick(center)
	check(spatial.stats.bvh_builds==builds,"repeated exact picks reuse mesh triangle BVHs")
	spatial.ray_pick(host.camera.unproject_position(twin.global_position))
	check(spatial.stats.bvh_builds==builds,"instances of the same Mesh resource reuse a single BVH")
	front.hide()
	var behind=spatial.ray_pick(center)
	check(behind.get("object_id")=="back","visibility changes affect the current cache without a rebuild")
	check(near3(behind.get("position",[]),Vector3(0,0,1)),"occluded object's true front surface is retained")
	front.show()
	front.layers=0
	check(spatial.ray_pick(center).get("object_id")=="back","camera layer filtering excludes non-rendered mesh")
	front.layers=1
	front.scale=Vector3(2,.5,3)
	check(near3(spatial.ray_pick(center).get("position",[]),Vector3(0,0,4.5)),"precise surface placement accounts for non-uniform scale")
	front.scale=Vector3.ONE
	check(spatial.ray_pick(Vector2(20,20)).is_empty(),"empty viewport ray returns no fabricated object")
	var position=spatial.plane_point(center,"xy",6)
	check(position!=null and position.distance_to(Vector3(0,0,6))<.001,"explicit work plane creates a point before any visible object surface")
	check(spatial.plane_point(center,"xz",1)==null,"parallel work plane does not fall back to a camera-dependent position")
	var index_builds=spatial.stats.index_builds
	host.yaw=.1
	host.update_camera()
	spatial.ray_pick(host.camera.unproject_position(Vector3.ZERO))
	check(spatial.stats.index_builds==index_builds,"camera rotation never rebuilds the scene index")
	host.applied_seq+=1
	spatial.ray_pick(host.camera.unproject_position(Vector3.ZERO))
	check(spatial.stats.index_builds==index_builds+1,"new applied source generation invalidates the index")
	check(state()==source,"precision queries preserve authored transforms, definitions and selection")
	sample("warm nearest ray, 6 meshes",func(): spatial.ray_pick(center))
	host.free()

func exercise_input() -> void:
	scope="real spatial input"
	new_host()
	var left=mesh("left",Vector3(-2,1,0))
	var right=mesh("right",Vector3(2,1,0))
	var center=mesh("center",Vector3(0,1,0),Vector3(.5,.5,.5))
	var offscreen=mesh("offscreen",Vector3(100,1,0))
	var hidden=mesh("hidden",Vector3(0,1,0))
	hidden.hide()
	host.refresh_bounds()
	host.select_object("left",false)
	await process_frame
	var source=state()
	var annotations=host.editor_annotations
	configure({"seq":2})
	check(not annotations.enabled,"foreign generation cannot enable spatial annotation")
	configure({"document_id":"foreign"})
	check(not annotations.enabled,"foreign resource cannot enable spatial annotation")
	configure()
	check(annotations.enabled,"current scope enables annotation tools")
	click(host.camera.unproject_position(left.global_position))
	var object_event: Dictionary=events("annotation_candidate")[-1]
	check(object_event.kind=="object" and object_event.object_ids==["left"],"objects point tool selects exactly the visible hit")
	check(object_event.source_revision=="spatial-source-v1" and object_event.source_identity=="spatial-native-v1","candidate binds immutable native source identities")
	var before=events("annotation_candidate").size()
	click(Vector2(20,20))
	check(events("annotation_candidate").size()==before,"an object-mode miss never silently creates a space point")
	configure({"target":"space","plane":"xz","plane_offset":6})
	click(host.camera.unproject_position(Vector3(1,6,0)))
	var point: Dictionary=events("annotation_candidate")[-1]
	check(point.kind=="point" and point.object_ids.is_empty(),"space mode creates a free coordinate with no source object")
	check(near3(point.position,Vector3(1,6,0)),"space point lies on the explicitly selected plane")
	var ray_queries=annotations.spatial.stats.ray_queries
	for i in 3: click(host.camera.unproject_position(Vector3(1,6,0)))
	check(annotations.spatial.stats.ray_queries==ray_queries,"free coordinate placement never ray-tests scene triangle meshes")
	configure({"target":"space","plane":"xz","plane_offset":4,"action":"create_center"})
	var created: Dictionary=events("annotation_candidate")[-1]
	check(created.kind=="point" and absf(created.position[1]-4)<.001,"create-center reliably creates a point in otherwise empty space")
	configure({"target":"space","plane":"xz","plane_offset":0,"action":"align_plane"})
	check(host.camera.projection==Camera3D.PROJECTION_ORTHOGONAL and host.camera_view=="top","align-plane gives a precise orthographic construction view")
	host.camera.size=10
	host.update_camera()
	configure({"tool":"rect","target":"space"})
	check(annotations.target_mode=="objects","rectangle ignores the requested space target and only selects objects")
	var left_at=host.camera.unproject_position(Vector3(-3,0,-1))
	var right_at=host.camera.unproject_position(Vector3(3,0,1))
	gesture(left_at,right_at)
	var rectangle: Dictionary=events("annotation_candidate")[-1]
	check(rectangle.kind=="objects" and selected(rectangle.object_ids)==["center","left","right"],"rectangle emits a real visible object collection")
	check(rectangle.geometry.shape=="objects" and not rectangle.geometry.has("world_points"),"object-only rectangle cannot become a spatial region")
	gesture(Vector2.ZERO,Vector2(1000,700))
	var full_rectangle: Dictionary=events("annotation_candidate")[-1]
	check(not "offscreen" in full_rectangle.object_ids,"viewport rectangle never selects an offscreen object's empty projected rectangle")
	before=events("annotation_candidate").size()
	gesture(Vector2(5,5),Vector2(35,35))
	check(events("annotation_candidate").size()==before,"empty rectangle produces no point or region")
	configure({"tool":"brush","target":"objects","radius":12})
	gesture(host.camera.unproject_position(left.global_position),host.camera.unproject_position(right.global_position))
	var brush: Dictionary=events("annotation_candidate")[-1]
	check(brush.kind=="objects" and selected(brush.object_ids)==["center","left","right"],"object brush collects crossed objects between sparse input samples: "+JSON.stringify(brush))
	configure({"tool":"volume","target":"objects","plane":"xz","plane_offset":0,"depth":2})
	check(annotations.target_mode=="space","volume tool always records world space")
	gesture(host.camera.unproject_position(Vector3(-3,0,-1)),host.camera.unproject_position(Vector3(-1,0,1)))
	var volume: Dictionary=events("annotation_candidate")[-1]
	check(volume.kind=="region" and volume.geometry.shape=="box","3D volume gesture creates a spatial box")
	check(near3(volume.geometry.center,Vector3(-2,1,0)),"volume gesture stores its center in world coordinates")
	check(volume.object_ids==["left"],"volume candidate carries intersecting native objects")
	configure({"tool":"volume","target":"space","action":"create_center"})
	var center_volume: Dictionary=events("annotation_candidate")[-1]
	check(center_volume.geometry.shape=="box" and center_volume.object_ids==["center"],"center-created volume includes objects already inside its bounds: "+JSON.stringify(center_volume))
	configure({"tool":"brush","target":"space","world_radius":.65,"plane_offset":0,"depth":2})
	ray_queries=annotations.spatial.stats.ray_queries
	gesture(host.camera.unproject_position(Vector3(-3,0,0)),host.camera.unproject_position(Vector3(3,0,0)))
	var prism: Dictionary=events("annotation_candidate")[-1]
	check(prism.kind=="region" and prism.geometry.shape=="prism","space brush creates an extruded footprint")
	check(selected(prism.object_ids)==["center","left","right"],"space brush includes its exact world member list")
	check(annotations.spatial.stats.ray_queries==ray_queries,"space brush vertices use plane math without repeating triangle raycasts")
	before=events("annotation_candidate").size()
	button(host.camera.unproject_position(Vector3(-3,0,0)),true)
	configure({"tool":"brush","target":"space","plane":"xy","plane_offset":4})
	button(host.camera.unproject_position(Vector3(3,0,0)),false)
	check(events("annotation_candidate").size()==before,"changing the work plane cancels an in-progress world brush")
	configure({"tool":"point","target":"space","plane":"xz","plane_offset":2})
	var edit={"id":"adjustable-point","annotation_kind":"point","dimension":"3d","position":[0.0,2.0,0.0],"geometry":{},"object_ids":[]}
	configure({"target":"space","suspended":true,"edit":edit})
	var changed=edit.duplicate(true)
	changed.position=[1.0,3.0,-2.0]
	configure({"target":"space","suspended":true,"edit":changed,"adjust":true})
	var adjustment: Dictionary=events("annotation_adjustment")[-1]
	check(adjustment.id==edit.id and adjustment.final and near3(adjustment.position,Vector3(1,3,-2)),"numeric coordinate edit produces an exact final adjustment")
	check(adjustment.object_ids.is_empty(),"moving a point does not select or create source objects")
	host.camera_view="perspective"
	host.camera.projection=Camera3D.PROJECTION_PERSPECTIVE
	host.yaw=.3
	host.pitch=.45
	host.update_camera()
	annotations._process(.1)
	var rebuilds=annotations.visuals.rebuilds
	var projected=annotations.projection_emits
	for i in 120: annotations._process(1.0/60)
	check(annotations.projection_emits==projected,"a stationary edited point emits no repeated projection messages")
	check(annotations.visuals.rebuilds==rebuilds,"stationary marks do not rebuild persistent Godot meshes")
	host.yaw+=.3
	host.update_camera()
	annotations._process(.1)
	check(near3(annotations.edit.position,Vector3(1,3,-2)),"camera rotation cannot change the edited world coordinate")
	check(annotations.visuals.rebuilds==rebuilds,"camera rotation reprojects pins without rebuilding annotation meshes")
	var axis_origin=Spatial.vec(annotations.edit.position)
	var gizmo=annotations.visuals.gizmo
	var axis_at=host.camera.unproject_position(axis_origin+Vector3.RIGHT*gizmo.world_size*.72)
	var handle=annotations.visuals.hit_handle(axis_at)
	check(handle=="x","point adjustment exposes the real Godot world X handle")
	if handle=="x":
		var start=annotations.edit.position.duplicate()
		var count=events("annotation_adjustment").size()
		button(axis_at,true)
		move(axis_at+Vector2(50,0),Vector2(50,0))
		button(axis_at+Vector2(50,0),false)
		var drag_events=events("annotation_adjustment").slice(count)
		check(drag_events.any(func(row): return not row.final) and drag_events[-1].final,"axis drag emits an in-progress update followed by a final member receipt")
		check(annotations.edit.position[0]!=start[0] and annotations.edit.position[1]==start[1] and annotations.edit.position[2]==start[2],"X axis drag changes only the annotation's world X coordinate")
		axis_origin=Spatial.vec(annotations.edit.position)
		axis_at=host.camera.unproject_position(axis_origin+Vector3.RIGHT*gizmo.world_size*.72)
		start=annotations.edit.position.duplicate()
		button(axis_at,true)
		move(axis_at+Vector2(25,0),Vector2(25,0))
		var escape=InputEventKey.new()
		escape.keycode=KEY_ESCAPE
		escape.pressed=true
		host._input(escape)
		button(axis_at+Vector2(25,0),false)
		check(annotations.edit.position==start,"Escape rolls an in-progress annotation drag back to its starting point")
	axis_origin=Spatial.vec(annotations.edit.position)
	axis_at=host.camera.unproject_position(axis_origin+Vector3.RIGHT*gizmo.world_size*.72)
	button(axis_at,true)
	move(axis_at+Vector2(15,0),Vector2(15,0))
	check(not annotations.edit_drag.is_empty(),"cancel-boundary probe starts a real annotation axis drag")
	configure({"target":"space","suspended":false,"edit":{}})
	check(annotations.edit_drag.is_empty() and annotations.edit.is_empty(),"clearing the Web bubble clears its in-progress engine drag and operation handles")
	button(axis_at+Vector2(15,0),false)
	check(annotations.edit.is_empty(),"a late mouse release cannot resurrect a cancelled annotation edit")
	var box_edit={"id":"adjustable-volume","annotation_kind":"region","dimension":"3d","position":volume.position,"geometry":volume.geometry,"object_ids":volume.object_ids}
	configure({"tool":"volume","target":"space","suspended":true,"edit":box_edit})
	var next_geometry=Spatial.moved_geometry(volume.geometry,[2.0,1.0,0.0])
	box_edit.position=next_geometry.center
	box_edit.geometry=next_geometry
	configure({"tool":"volume","target":"space","suspended":true,"edit":box_edit,"adjust":true})
	adjustment=events("annotation_adjustment")[-1]
	check(adjustment.id=="adjustable-volume" and adjustment.object_ids==["right"],"numeric volume adjustment recomputes native members on final receipt")
	var face_position=annotations.visuals.face_handles[1].global_position
	var face_at=host.camera.unproject_position(face_position)
	check(annotations.visuals.hit_handle(face_at)=="face-1","box exposes a real positive X face handle")
	var before_center=Spatial.vec(annotations.edit.position)
	var before_size=Spatial.vec(annotations.edit.geometry.size)
	button(face_at,true)
	move(face_at+Vector2(40,0),Vector2(40,0))
	button(face_at+Vector2(40,0),false)
	var after_center=Spatial.vec(annotations.edit.position)
	var after_size=Spatial.vec(annotations.edit.geometry.size)
	check(not is_equal_approx(before_size.x,after_size.x),"dragging a volume face changes its width")
	check(is_equal_approx(before_center.x-before_size.x*.5,after_center.x-after_size.x*.5),"resizing one volume face keeps the opposite world-space face fixed")
	check(is_equal_approx(before_size.y,after_size.y) and is_equal_approx(before_size.z,after_size.z),"one-axis face resize preserves the other two world dimensions")
	check(state()==source,"all annotation inputs, coordinate changes and handles preserve authored source and normal selection")
	configure({"enabled":false})
	check(not annotations.enabled and not annotations.drawing and annotations.edit_drag.is_empty(),"exiting annotation mode releases gesture capture")
	host.free()

func exercise_scale() -> void:
	scope="CPU diagnostic and bounded cache"
	new_host()
	host.pitch=0
	host.update_camera()
	var shared_mesh=BoxMesh.new()
	shared_mesh.size=Vector3.ONE*.4
	for i in 1000:
		var node=MeshInstance3D.new()
		host.scene_root.add_child(node)
		node.mesh=shared_mesh
		node.position=Vector3((i%50-25)*1.5,(i/50-10)*1.5,0)
		register(node,"mesh-"+str(i))
	var spatial=Spatial.new()
	spatial.setup(host)
	var start=Time.get_ticks_usec()
	spatial.ensure_index()
	metrics.append({"name":"1000 mesh cold ownership index","elapsed_ms":float(Time.get_ticks_usec()-start)/1000.0})
	check(spatial.records.size()==1000,"spatial index contains each of 1000 native mesh owners once")
	var screen=host.camera.unproject_position(Vector3.ZERO)
	spatial.ray_pick(screen)
	var builds=spatial.stats.bvh_builds
	sample("1000 meshes warm exact object pick",func(): spatial.ray_pick(screen),40)
	check(spatial.stats.bvh_builds==builds and builds==1,"1000 repeated instances retain one cached triangle BVH")
	var box=Spatial.box_geometry(Vector3(-3,-3,0),Vector3(3,3,0),"xy",-.5,1)
	var members=spatial.world_members(box)
	sample("1000 meshes world box membership",func(): spatial.world_members(box),40)
	check(members.size()==25,"world box query includes all 25 intersecting grid objects")
	check(spatial.stats.index_builds==1,"high-count repeated world queries never rebuild the ownership index")
	var valid_edit={"id":"bounded-region","annotation_kind":"region","dimension":"3d","position":box.center,"geometry":box,"object_ids":members}
	configure({"tool":"volume","target":"space","plane":"xy","plane_offset":-.5,"suspended":true,"edit":valid_edit})
	var oversized=valid_edit.duplicate(true)
	oversized.geometry=Spatial.moved_geometry(box,box.center,[200.0,200.0,200.0])
	var error_count=events("annotation_error").size()
	configure({"tool":"volume","target":"space","plane":"xy","plane_offset":-.5,"suspended":true,"edit":oversized,"adjust":true})
	var invalid_receipt: Dictionary=events("annotation_adjustment")[-1]
	check(invalid_receipt.id==valid_edit.id and invalid_receipt.final and invalid_receipt.get("valid",true)==false,"an over-limit adjustment emits an explicit invalid final receipt")
	check(invalid_receipt.object_ids.is_empty(),"an over-limit receipt never pairs new geometry with the old object's member list")
	check(invalid_receipt.geometry==oversized.geometry,"the invalid oversized region remains visible for correction")
	check(events("annotation_error").size()==error_count+1,"over-limit adjustment tells the editor why saving must stay disabled")
	configure({"tool":"volume","target":"space","plane":"xy","plane_offset":-.5,"suspended":true,"edit":valid_edit,"adjust":true})
	var recovered: Dictionary=events("annotation_adjustment")[-1]
	check(recovered.final and recovered.get("valid",true)!=false and recovered.object_ids==members,"shrinking an invalid volume returns a valid final receipt and fresh native members")
	check(recovered.geometry==box,"recovering from oversize keeps the corrected world geometry")
	host.free()

func exercise_dense_mesh() -> void:
	scope="high triangle CPU diagnostic"
	new_host()
	host.pitch=0
	host.update_camera()
	var node=MeshInstance3D.new()
	host.scene_root.add_child(node)
	var sphere=SphereMesh.new()
	sphere.radial_segments=128
	sphere.rings=64
	node.mesh=sphere
	register(node,"detailed-mesh")
	var triangles=sphere.surface_get_arrays(0)[Mesh.ARRAY_INDEX].size()/3
	var spatial=Spatial.new()
	spatial.setup(host)
	var screen=host.camera.unproject_position(Vector3.ZERO)
	var began=Time.get_ticks_usec()
	var hit=spatial.ray_pick(screen)
	metrics.append({"name":"dense mesh cold BVH exact pick","triangles":triangles,"elapsed_ms":float(Time.get_ticks_usec()-began)/1000.0})
	check(triangles>16000 and hit.get("object_id")=="detailed-mesh","exact BVH pick resolves a real high-triangle native mesh")
	check(host.pick_object(screen)==hit.object_id,"cached annotation picker agrees with the original native triangle picker")
	sample("dense mesh warmed BVH pick",func(): spatial.ray_pick(screen),40)
	sample("dense mesh existing uncached native triangle picker",func(): host.pick_object(screen),20)
	check(spatial.stats.bvh_builds==1,"high-triangle repeated picks retain one BVH build")
	host.free()

func exercise_focus_and_dabs() -> void:
	scope="focus and spatial brush dabs"
	new_host()
	var inside=mesh("dab-inside",Vector3(3,1,2))
	var outside=mesh("dab-outside",Vector3(6,1,2))
	host.refresh_bounds()
	await process_frame
	var source=state()
	var annotations=host.editor_annotations
	configure({"tool":"brush","target":"space","plane":"xz","plane_offset":0,"depth":3,"world_radius":.8})
	var start=events("annotation_candidate").size()
	var ray_queries=annotations.spatial.stats.ray_queries
	var screen=host.camera.unproject_position(Vector3(3,0,2))
	click(screen)
	check(events("annotation_candidate").size()==start+1,"single spatial brush click emits exactly one annotation candidate")
	var dab: Dictionary=events("annotation_candidate")[-1]
	check(dab.kind=="region" and dab.geometry.shape=="prism","single brush dab creates a world-space prism rather than a point")
	check(dab.geometry.world_points.size()>=16 and dab.geometry.world_points.size()<=96,"brush dab uses a bounded polygon with a circular footprint")
	check(dab.geometry.world_points.all(func(point): return is_equal_approx(Vector2(point[0]-3,point[2]-2).length(),.8)),"all dab boundary vertices follow the configured world-space radius")
	check(dab.geometry.world_points.all(func(point): return absf(point[1])<.001) and dab.geometry.depth==3,"single dab records the fixed work plane and extrusion depth")
	check(near3(dab.position,Vector3(3,1.5,2)),"single dab center includes half its world-space thickness")
	check(dab.object_ids==["dab-inside"],"single spatial dab returns exactly the native objects inside its footprint and height")
	check(annotations.spatial.stats.ray_queries==ray_queries,"single spatial dab avoids scene triangle raycasts")
	for plane in ["xy","yz"]:
		var origin=Vector3(2,3,4)
		var normal=Spatial.axes(plane)[2]
		var one_point: Array[Vector3]=[origin]
		var footprint=Spatial.prism_geometry(one_point,.5,plane,origin[normal],2)
		var axes=Spatial.axes(plane)
		check(footprint.world_points.all(func(point): return is_equal_approx(Vector2(point[axes[0]]-origin[axes[0]],point[axes[1]]-origin[axes[1]]).length(),.5)),plane+" single dab keeps a circular footprint in its declared plane")
		check(footprint.center[normal]==origin[normal]+1,plane+" single dab extrudes along the correct world axis")
	var point_edit={"id":"focus-point","annotation_kind":"point","dimension":"3d","position":[20.0,10.0,-25.0],"geometry":{},"object_ids":[]}
	var camera_count=events("camera").size()
	configure({"tool":"point","target":"space","suspended":true,"edit":point_edit,"action":"focus_edit"})
	check(host.target.is_equal_approx(Vector3(20,10,-25)),"focus-edit moves the camera target to an offscreen annotation point")
	check(annotations.edit.position==point_edit.position and annotations.edit.geometry==point_edit.geometry,"focusing a free point never changes its world coordinates")
	check(host.annotation_project(point_edit.position).distance_to(Vector2(500,350))<.1,"focused point is centered in the real camera projection")
	check(events("camera").size()==camera_count+1,"focus-edit emits one real camera state receipt")
	var box=Spatial.box_geometry(Vector3(2,0,1),Vector3(4,0,3),"xz",0,3)
	var box_edit={"id":"focus-box","annotation_kind":"region","dimension":"3d","position":box.center,"geometry":box,"object_ids":["dab-inside"]}
	configure({"tool":"volume","target":"space","suspended":true,"edit":box_edit,"action":"focus_edit"})
	check(host.target.is_equal_approx(Spatial.vec(box.center)),"focus-edit moves the camera target to a 3D volume center")
	check(annotations.edit.position==box_edit.position and annotations.edit.geometry==box,"focusing a volume does not move or resize its world geometry")
	check(host.annotation_project(box.center).distance_to(Vector2(500,350))<.1,"focused volume center is at the real viewport center")
	var prism_edit={"id":"focus-dab","annotation_kind":"region","dimension":"3d","position":dab.position,"geometry":dab.geometry,"object_ids":dab.object_ids}
	configure({"tool":"brush","target":"space","suspended":true,"edit":prism_edit,"action":"focus_edit"})
	check(host.target.is_equal_approx(Spatial.vec(dab.position)) and annotations.edit.geometry==dab.geometry,"focusing a brushed region preserves its footprint, depth and world position")
	check(state()==source,"dabs and all focus actions leave authored source and normal object selection unchanged")
	host.free()

func exercise() -> void:
	await exercise_geometry()
	await exercise_picking()
	await exercise_input()
	await exercise_scale()
	await exercise_dense_mesh()
	await exercise_focus_and_dabs()

func run() -> void:
	root.size=Vector2i(1000,700)
	check(DisplayServer.get_name()=="headless","uses headless display")
	check(AudioServer.get_driver_name()=="Dummy","uses Dummy audio")
	await exercise()
	var ok=checks.all(func(row): return row.ok)
	FileAccess.open(out+"/result.json",FileAccess.WRITE).store_string(JSON.stringify({"ok":ok,"checks":checks,"cpu_metrics":metrics},"\t"))
	print("ANNOTATION_SPATIAL_COMPLETE "+str(checks.size()))
	quit(0 if ok else 1)
