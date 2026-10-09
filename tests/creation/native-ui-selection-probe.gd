extends SceneTree
var host: Node
var overlay: Control
var checks: Array = []
var out = ""
var samples: Dictionary = {}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--out="): out = arg.substr(6)
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok: print("NATIVE_UI_SELECTION_FAILED "+detail)

func capture(name: String) -> Image:
	for i in 3:
		await process_frame
		await RenderingServer.frame_post_draw
	var image = root.get_texture().get_image()
	image.save_png(out+"/"+name+".png")
	return image

func state() -> Array:
	var geometry = {}
	for id in host.objects:
		var node = host.objects[id]
		if node is Control: geometry[id] = [node.get_global_transform(),node.size,node.position,node.pivot_offset]
	return [host.objects.duplicate(),host.definitions.duplicate(true),host.native_document.duplicate(true),host.selected_ids.duplicate(),host.selected_id,host.scene_bounds,host.camera.transform,host.drag_handle,host.gizmo.transform,root.canvas_transform,geometry]

func send(kind: String, fields: Dictionary) -> void:
	var before = state()
	var packet = {"source":"world-atelier-workspace","nonce":host.nonce,"type":kind,"seq":7,"document_id":"ui/main/scene","branch_id":"main"}
	packet.merge(fields,true)
	host.receive(packet)
	check(state()==before,"overlay message preserves selection, camera, source and Control geometry: "+kind)

func peer(id: String, name: String, color: String, ids: Array, order: int) -> Dictionary:
	return {"id":id+"-window","user_id":id,"name":name,"color":color,"mode":"editing","selection_order":order,"selected_id":ids.back() if not ids.is_empty() else "","selected_objects":ids.map(func(value): return {"id":value})}

func expected_rect(ids: Array) -> Rect2:
	var result = Rect2()
	for id in ids:
		var node: Control = host.objects[id]
		var transform = node.get_global_transform_with_canvas()
		# Independently transform all four authored Control corners.
		for unit in [Vector2.ZERO,Vector2(1,0),Vector2.ONE,Vector2(0,1)]:
			var point = transform*(node.size*unit)
			result = Rect2(point,Vector2.ZERO) if result==Rect2() else result.expand(point)
	return result

func changed_in(a: Image, b: Image, area: Rect2) -> int:
	var bounds = Rect2i(area).intersection(Rect2i(Vector2i.ZERO,a.get_size()))
	var count = 0
	for y in range(bounds.position.y,bounds.end.y):
		for x in range(bounds.position.x,bounds.end.x):
			var p = a.get_pixel(x,y)
			var q = b.get_pixel(x,y)
			if absf(p.r-q.r)+absf(p.g-q.g)+absf(p.b-q.b) > .08: count += 1
	return count

func labels(expected: Dictionary, stage: String) -> void:
	var drawn: Array = overlay.drawn_selections
	var frames: Array = overlay.drawn_canvas_selections
	check(frames.size()==expected.size(),stage+": exactly one outer frame per selecting identity")
	for frame in frames:
		check(frame.rect.is_equal_approx(expected_rect(frame.object_ids)),stage+": frame equals union of transformed native Control bounds")
		check(frame.frame_rect.encloses(frame.rect),stage+": frame grows outside union, never inward")
	check(drawn.size()==expected.size(),stage+": exactly one label per selecting identity")
	var occupied: Array = []
	for name in expected:
		var matches = drawn.filter(func(row): return row.get("text")==name)
		check(matches.size()==1,stage+": name appears once without status suffix: "+name)
		if matches.size()!=1: continue
		var row: Dictionary = matches[0]
		check(row.rect.is_equal_approx(expected_rect(expected[name])),stage+": name anchored to outer union rect: "+name)
		check(row.object_ids.size()==expected[name].size(),stage+": selected members deduplicated: "+name)
		for previous in occupied: check(not row.label_rect.intersects(previous),stage+": labels avoid collision")
		occupied.append(row.label_rect)
	samples[stage] = {"labels":drawn.duplicate(true),"frames":frames.duplicate(true)}

func run() -> void:
	root.size = Vector2i(1000,700)
	host = load("res://native_main.gd").new()
	root.add_child(host)
	host.set_process(false)
	host.native_config = {"preview_scenes":{"res://ui-fixture.tscn":"res://ui-fixture.tscn"}}
	var indexed = []
	for path in [".","A","A/Child","B","B/Child","Nested","Nested/Inner","Nested/Inner/Child"]:
		indexed.append({"id":path,"native_path":path})
	host.receive({"source":"world-atelier-workspace","nonce":host.nonce,"type":"scene","seq":7,"document_schema":"creation-native-1","document_id":"ui/main/scene","branch_id":"main","source_revision":"isolated-ui-source","source_identity":"isolated-ui-identity","native_scene_path":"res://ui-fixture.tscn","objects":indexed,"selected_ids":[],"editable":true,"frame":false})
	for i in 5: await process_frame
	check(host.native_active and host.canvas_mode and host.applied_seq==7,"actual native PackedScene loaded as Canvas UI")
	overlay = host.collaboration_overlay.remote_selections
	var baseline = await capture("empty")
	var local_ids = ["A","A/Child","B"]
	var remote_ids = ["A/Child","Nested/Inner/Child"]
	var agent_ids = ["A/Child","B/Child","Nested/Inner/Child"]
	var local = peer("alice","Alice","#ef759a",local_ids,2)
	var remote = peer("bob","Bob","#6bdd98",remote_ids,3)
	host.select_objects(local_ids,"A/Child",false)
	send("presence",{"peers":[],"local_peer":local})
	var selected_state = state()
	var local_image = await capture("local-nested-aggregate")
	labels({"Alice":local_ids},"local")
	check(state()==selected_state,"render frames do not mutate local selection or authoring state")
	var inner = expected_rect(["A/Child"])
	check(changed_in(baseline,local_image,Rect2(inner.position+Vector2(12,-4),Vector2(inner.size.x-24,8)))==0,"GPU has no selected child inner top frame or duplicate blue Control outline")
	check(changed_in(baseline,local_image,Rect2(inner.position+Vector2(-4,10),Vector2(8,inner.size.y-20)))==0,"GPU has no selected child inner side frame")
	var outer = expected_rect(local_ids)
	check(changed_in(baseline,local_image,Rect2(outer.position+Vector2(18,-10),Vector2(outer.size.x-36,15)))>50,"GPU paints aggregate outer edge")
	send("presence",{"peers":[remote,remote.duplicate(true)],"local_peer":local})
	var human_image = await capture("two-users")
	labels({"Alice":local_ids,"Bob":remote_ids},"humans")
	var jobs = []
	for id in agent_ids:
		jobs.append({"object_id":id,"session_id":"agent-session-1","actor":"Builder","label":"Builder","status":"editing"})
	jobs.append(jobs[0].duplicate(true))
	send("development",{"states":jobs})
	var agents_image = await capture("users-and-agent-session")
	labels({"Alice":local_ids,"Bob":remote_ids,"Builder":agent_ids},"agent")
	check(changed_in(human_image,agents_image,Rect2(Vector2.ZERO,root.get_visible_rect().size))>50,"GPU displays Agent group")
	send("display_settings",{"settings":{"show_agents":false}})
	var hidden_image = await capture("agent-hidden")
	labels({"Alice":local_ids,"Bob":remote_ids},"hidden-agent")
	check(changed_in(human_image,hidden_image,Rect2(Vector2.ZERO,root.get_visible_rect().size))==0,"hide-agent restores exact human-only GPU pixels")
	send("display_settings",{"settings":{"show_agents":true}})
	await capture("agent-restored")
	labels({"Alice":local_ids,"Bob":remote_ids,"Builder":agent_ids},"restored-agent")
	check(state()==selected_state,"complete overlay lifecycle preserves selection, camera and source")
	var ok = checks.all(func(row): return row.ok)
	FileAccess.open(out+"/result.json",FileAccess.WRITE).store_string(JSON.stringify({"ok":ok,"checks":checks,"drawn":samples},"\t"))
	print("NATIVE_UI_SELECTION_COMPLETE "+str(checks.size()))
	host.free()
	quit(0 if ok else 1)
