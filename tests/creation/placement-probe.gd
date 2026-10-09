extends SceneTree
## Real Camera3D and viewport projection, isolated from services and authored files.
var host: Node
var checks: Array = []
var options: Dictionary = {}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var pair = arg.substr(2).split("=",true,1)
			options[pair[0]] = pair[1] if pair.size()>1 else "true"
	run.call_deferred()

func check(ok: bool, detail: String, evidence: Dictionary = {}) -> void:
	checks.append({"ok":ok,"detail":detail,"evidence":evidence})
	if not ok: print("PLACEMENT_FAILED "+detail+" "+JSON.stringify(evidence))

func query(screen: Variant = [0.5,0.5], extra: Dictionary = {}) -> Dictionary:
	var packet = {"source":"world-atelier-workspace","nonce":host.nonce,"type":"placement","request_id":"drop-123","seq":7,"document_id":"placement/scene","screen":screen}
	packet.merge(extra,true)
	host.outbound_log.clear()
	var before = state()
	host.receive(packet)
	check(state()==before,"every query including rejection preserves editor and source state")
	if host.outbound_log.is_empty(): return {}
	check(host.outbound_log.size()==1,"query emits only one result")
	var reply: Dictionary = host.outbound_log.back()
	check(reply.type=="placement" and reply.request_id==packet.request_id,"response correlates request")
	return reply

func point(at: Vector3) -> Array:
	var screen = host.camera.unproject_position(at) / host.get_viewport().get_visible_rect().size
	return [screen.x,screen.y]

func near3(reply: Dictionary, expected: Vector3) -> bool:
	var p = reply.get("position",[])
	return reply.get("dimension")=="3d" and p.size()==3 and Vector3(p[0],p[1],p[2]).distance_to(expected)<0.002

func near2(reply: Dictionary, expected: Vector2) -> bool:
	var p = reply.get("position",[])
	return reply.get("dimension")=="2d" and p.size()==2 and Vector2(p[0],p[1]).distance_to(expected)<0.002

func fixture(id: String, at: Vector3) -> MeshInstance3D:
	var mesh = MeshInstance3D.new()
	mesh.mesh = BoxMesh.new()
	mesh.mesh.size = Vector3(4,2,4)
	host.scene_root.add_child(mesh)
	mesh.position = at
	host.objects[id] = mesh
	host.definitions[id] = {"id":id,"kind":"model","position":[at.x,at.y,at.z]}
	return mesh

func state() -> Dictionary:
	var transforms = {}
	for id in host.objects: transforms[id] = host.objects[id].transform
	return {"native_document":host.native_document.duplicate(true) if options.host=="native_main" else {},"source_scene":host.hierarchy_editor.source_scene.duplicate(true),"definitions":host.definitions.duplicate(true),"transforms":transforms,"selected_id":host.selected_id,"selected_ids":host.selected_ids.duplicate(),"camera":host.camera.transform,"projection":host.camera.projection,"size":host.camera.size,"canvas":root.canvas_transform,"target":host.target,"yaw":host.yaw,"pitch":host.pitch,"distance":host.distance,"document":host.document_id,"seq":host.applied_seq,"requested":host.requested_seq,"drag":host.drag_handle,"revision":host.placement_source().duplicate(true)}

func run() -> void:
	root.size=Vector2i(1200,800)
	host=load("res://"+options.host+".gd").new()
	root.add_child(host)
	host.set_process(false)
	host.editor_tool="select"
	host.requested_seq=7
	host.finish_scene({"document_id":"placement/scene","seq":7,"source_revision":"fixture-revision","editable":true,"frame":false},false)
	if options.host=="native_main":
		host.native_active=true
		host.native_document={"source_revision":"native-revision","source_identity":"native-identity"}
		host.authored_root=host.scene_root
	var low=fixture("low",Vector3(0,0,0))
	var high=fixture("high",Vector3(0,2,0))
	# Alias intentionally duplicates the mesh in the base host's object index.
	host.objects["alias"]=high
	host.definitions["alias"]={"id":"alias","kind":"model"}
	host.select_objects(["high","low"],"high",false)
	host.drag_handle="x"
	await process_frame
	for projection in [Camera3D.PROJECTION_PERSPECTIVE,Camera3D.PROJECTION_ORTHOGONAL]:
		host.camera.projection=projection
		host.camera.size=20
		host.camera.position=Vector3(0,10,10)
		host.camera.look_at(Vector3(0,1,0))
		var before=state()
		var hit=query(point(Vector3(.7,3,.3)))
		check(near3(hit,Vector3(.7,3,.3)),"nearest actual surface, projection "+str(projection),hit)
		check(hit.get("source_revision")==("native-revision" if options.host=="native_main" else "fixture-revision"),"revision belongs to applied scene",hit)
		check(not hit.has("source_identity") if options.host=="main" else hit.get("source_identity")=="native-identity","native identity contract",hit)
		check(state()==before,"surface query preserves source, multi-selection, drag and camera")
		high.visible=false
		check(near3(query(point(Vector3(0,1,0))),Vector3(0,1,0)),"hidden surface excluded")
		high.visible=true
		high.layers=2
		host.camera.cull_mask=1
		check(near3(query(point(Vector3(0,1,0))),Vector3(0,1,0)),"camera-hidden layers excluded")
		high.layers=1
		high.scale=Vector3.ZERO
		check(near3(query(point(Vector3(0,1,0))),Vector3(0,1,0)),"singular mesh excluded")
		high.scale=Vector3.ONE
		high.visible=false;low.visible=false
		check(near3(query(point(Vector3(3,0,1))),Vector3(3,0,1)),"no mesh falls back to ground")
		high.visible=true;low.visible=true
	# A triangle's bounding box contains (1,2,1), but its face does not.
	high.visible=false;low.visible=false
	var triangle=fixture("triangle",Vector3.ZERO)
	var arrays=[];arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX]=PackedVector3Array([Vector3(-2,2,-2),Vector3(-2,2,2),Vector3(2,2,-2)])
	var triangle_mesh=ArrayMesh.new()
	triangle_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES,arrays)
	triangle.mesh=triangle_mesh
	host.camera.position=Vector3(0,10,0)
	host.camera.look_at(Vector3.ZERO,Vector3.FORWARD)
	check(near3(query(point(Vector3(1,0,1))),Vector3(1,0,1)),"AABB-only hit rejected")
	check(near3(query(point(Vector3(-1,2,-1))),Vector3(-1,2,-1)),"actual triangle hit")
	triangle.position=Vector3(3,1,0)
	triangle.scale=Vector3(2,1.5,.5)
	triangle.rotation.y=.4
	var transformed=triangle.global_transform*Vector3(-1,2,-1)
	check(near3(query(point(transformed)),transformed),"transformed nonuniform triangle uses world coordinates")
	triangle.visible=false
	host.camera.position=Vector3(0,5,10)
	host.camera.look_at(Vector3(0,5,0))
	check(query().get("error")=="placement_no_intersection","parallel ground ray fails")
	host.camera.look_at(Vector3(0,10,0))
	check(query().has("error"),"ground behind ray fails")
	host.camera.look_at(Vector3.ZERO)
	host.camera.far=2
	check(query().has("error"),"ground beyond far clip fails")
	host.camera.far=4000
	for bad in [null,[],[0.5],[0.5,0.5,0.5],[-.01,.5],[.5,1.01],[NAN,.5],[INF,.5],[true,.5],["0.5",.5]]:
		check(query(bad).get("error")=="invalid_placement_screen","invalid coordinates fail")
	for extra in [{"seq":6},{"seq":8},{"seq":null},{"seq":true},{"document_id":"other"},{"document_id":null}]:
		check(query([.5,.5],extra).get("error")=="stale_placement","document and sequence fenced")
	host.requested_seq=8
	check(query().get("error")=="stale_placement","pending newer scene fenced")
	host.requested_seq=7
	check(query([.5,.5],{"request_id":""}).has("error"),"missing correlation fails")
	host.editable=false
	check(query().get("error")=="placement_requires_editing","read-only mode rejected")
	host.editable=true
	host.mode="object"
	check(query().get("error")=="placement_requires_editing","object preview rejected")
	host.mode="main"
	host.world_client.mode="inspecting"
	check(query().get("error")=="placement_requires_editing","inspection rejected")
	host.world_client.mode="playing"
	check(query().get("error")=="placement_requires_editing","play rejected")
	host.world_client.mode="editing"
	check(query([.5,.5],{"nonce":"foreign"}).is_empty(),"foreign bridge ignored")
	var before=state()
	check(near3(query(point(Vector3(0,0,0))),Vector3.ZERO),"valid request recovers after errors")
	check(state()==before,"errors and successful query retain source and selection")
	if options.host=="native_main":
		host.canvas_mode=true
		for zoom in [.25,1.0,3.5]:
			host.canvas_center=Vector2(240,-70)
			host.canvas_zoom=zoom
			host.update_camera()
			var expected=host.canvas_center+Vector2(32,-17)
			var screen=root.canvas_transform*expected/root.get_visible_rect().size
			before=state()
			check(near2(query([screen.x,screen.y]),expected),"scaled panned canvas inverse "+str(zoom))
			check(state()==before,"2D query preserves state")
		root.canvas_transform=Transform2D(.3,Vector2(30,-80)).scaled(Vector2(2,3))
		var expected=Vector2(160,150)
		var screen=root.canvas_transform*expected/root.get_visible_rect().size
		check(near2(query([screen.x,screen.y]),expected),"rotated nonuniform canvas inverse")
		root.canvas_transform=Transform2D(Vector2.ZERO,Vector2.ZERO,Vector2.ZERO)
		check(query().get("error")=="invalid_placement_canvas","singular canvas fails")
	var report={"ok":checks.all(func(row):return row.ok),"host":options.host,"checks":checks}
	var file=FileAccess.open(options.out+"/result.json",FileAccess.WRITE)
	file.store_string(JSON.stringify(report,"\t"));file.close()
	print("PLACEMENT_COMPLETE "+JSON.stringify(report))
	quit(0 if report.ok else 1)
