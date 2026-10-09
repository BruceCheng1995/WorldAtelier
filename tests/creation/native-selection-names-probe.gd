extends SceneTree
# The real native preview receives normal selection/presence/development packets.
# No substituted renderer, drawing implementation, source writes or runtime ACKs.
var host: Node
var overlay: Control
var checks: Array = []
var samples: Dictionary = {}
var out = ""

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--out="): out = arg.substr(6)
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok: print("NATIVE_SELECTION_NAMES_FAILED " + detail)

func capture(name: String) -> Image:
	for i in 5:
		await process_frame
		await RenderingServer.frame_post_draw
	var image = root.get_texture().get_image()
	image.save_png(out + "/" + name + ".png")
	return image

func state() -> Array:
	var transforms = {}
	for id in host.objects:
		var node = host.objects[id]
		if node is Node3D: transforms[id] = node.global_transform
		elif node is Control: transforms[id] = [node.get_global_transform(),node.size]
	return [host.objects.duplicate(),host.native_document.duplicate(true),host.selected_ids.duplicate(),host.selected_id,host.camera.global_transform,host.scene_bounds,root.canvas_transform,transforms]

func send(kind: String, fields: Dictionary) -> void:
	var before = state()
	var packet = {"source":"world-atelier-workspace","nonce":host.nonce,"type":kind,"seq":11,"document_id":"names/main/scene","branch_id":"main"}
	packet.merge(fields,true)
	host.receive(packet)
	check(state()==before,kind+": preserves selection, camera, original source and geometry")

func peer(id: String, name: String, ids: Array, order: int = 2) -> Dictionary:
	return {"id":id+"-window","user_id":id,"name":name,"color":"#ef759a" if id=="alice" else "#6bdd98","mode":"editing","selection_order":order,"selected_id":ids.back() if not ids.is_empty() else "","selected_objects":ids.map(func(value): return {"id":value})}

func bound(ids: Array) -> Rect2:
	var result = Rect2()
	for id in ids:
		var node = host.objects[id]
		if node is Control:
			for unit in [Vector2.ZERO,Vector2(1,0),Vector2.ONE,Vector2(0,1)]:
				var point = node.get_global_transform_with_canvas()*(node.size*unit)
				result = Rect2(point,Vector2.ZERO) if result==Rect2() else result.expand(point)
		elif node is MeshInstance3D:
			var box: AABB = node.global_transform*node.get_aabb()
			for index in 8:
				var point = host.camera.unproject_position(box.get_endpoint(index))
				result = Rect2(point,Vector2.ZERO) if result==Rect2() else result.expand(point)
	return result

func expected(kind: String, id: String, name: String, ids: Array) -> Dictionary:
	return {"kind":kind,"id":id,"name":name,"ids":ids}

func labels(wanted: Array, stage: String) -> void:
	var drawn: Array = overlay.drawn_selections
	check(drawn.size()==wanted.size(),stage+": one name per identity, no names on other objects")
	var occupied: Array = []
	for item in wanted:
		var matches = drawn.filter(func(row): return row.get("kind","user")==item.kind and (row.get("user_id")==item.id if item.kind=="user" else row.get("selection_identity")==item.id))
		check(matches.size()==1,stage+": exactly one label for "+item.kind+" "+item.id)
		if matches.size()!=1: continue
		var row: Dictionary = matches[0]
		check(row.text==item.name,stage+": pure name without editing/status prefix: "+item.name)
		var ids: Array = row.object_ids.duplicate()
		var wanted_ids: Array = item.ids.duplicate()
		ids.sort(); wanted_ids.sort()
		check(ids==wanted_ids,stage+": all selected members deduplicated for "+item.id)
		check(row.rect.is_equal_approx(bound(item.ids)),stage+": label anchors to outer screen union for "+item.id)
		for other in occupied: check(not row.label_rect.intersects(other),stage+": identity labels avoid overlap")
		occupied.append(row.label_rect)
	samples[stage] = drawn.duplicate(true)

func changed_in(a: Image, b: Image, area: Rect2) -> int:
	var bounds = Rect2i(area).intersection(Rect2i(Vector2i.ZERO,a.get_size()))
	var count = 0
	for y in range(bounds.position.y,bounds.end.y):
		for x in range(bounds.position.x,bounds.end.x):
			var p = a.get_pixel(x,y)
			var q = b.get_pixel(x,y)
			if absf(p.r-q.r)+absf(p.g-q.g)+absf(p.b-q.b)>.08: count += 1
	return count

func visible_label_pixels(image: Image, stage: String) -> void:
	var rows = overlay.drawn_selections.duplicate(true)
	overlay.hide()
	var without = await capture(stage+"-labels-hidden")
	overlay.show()
	await capture(stage+"-labels-restored")
	for row in rows:
		check(changed_in(image,without,row.label_rect)>25,stage+": actual GPU paints name: "+row.text)

func individual_masks(ids: Array, stage: String) -> void:
	var renderer = overlay.outline_renderer
	check(renderer.groups.size()==ids.size(),stage+": individual 3D silhouette groups remain separate")
	for id in ids:
		var mesh_id = host.objects[id].get_instance_id()
		var groups = renderer.groups.values().filter(func(group): return group._selected.has(mesh_id))
		check(groups.size()==1,stage+": exactly one raster group for object "+id)
		if groups.size()==1:
			check(groups[0]._selected.size()==1 and not groups[0].polygons.is_empty(),stage+": GPU extracted independent visible silhouette for "+id)

func jobs(ids: Array) -> Array:
	var result = []
	for id in ids:
		result.append({"object_id":id,"session_id":"builder-session","run_id":"builder-run","actor":"Builder","label":"Builder","status":"editing"})
	result.append(result[0].duplicate(true))
	return result

func run() -> void:
	root.size = Vector2i(1000,700)
	host = load("res://native_main.gd").new()
	root.add_child(host)
	host.set_process(false)
	host.native_config = {"preview_scenes":{"res://names-fixture.tscn":"res://names-fixture.tscn"}}
	var indexed = []
	for path in [".","A","B","C","Unselected","HUD"]: indexed.append({"id":path,"native_path":path})
	host.receive({"source":"world-atelier-workspace","nonce":host.nonce,"type":"scene","seq":11,"document_schema":"creation-native-1","document_id":"names/main/scene","branch_id":"main","source_revision":"isolated-names-source","source_identity":"isolated-names-identity","native_scene_path":"res://names-fixture.tscn","objects":indexed,"selected_ids":[],"editable":true,"frame":false})
	for i in 5: await process_frame
	host.camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	host.camera.size = 10
	host.camera.position = Vector3(0,0,14)
	host.camera.look_at(Vector3.ZERO)
	check(host.native_active and not host.canvas_mode and host.applied_seq==11,"real native mixed PackedScene loaded in 3D viewport")
	overlay = host.collaboration_overlay.remote_selections
	await capture("empty")
	labels([],"empty")
	var ids = ["A","B","C"]
	var local = peer("alice","Alice",ids)
	host.select_objects(ids,"C",false)
	send("presence",{"peers":[],"local_peer":local})
	var local_image = await capture("local-3d")
	labels([expected("user","alice","Alice",ids)],"local-3d")
	individual_masks(ids,"local-3d")
	await visible_label_pixels(local_image,"local-3d")
	var duplicate_window = local.duplicate(true)
	duplicate_window.id = "alice-other-window"
	send("presence",{"peers":[duplicate_window],"local_peer":local})
	await capture("same-account-two-windows")
	labels([expected("user","alice","Alice",ids)],"same-account-two-windows")
	host.select_objects([],"",false)
	var remote = peer("bob","Bob",ids,3)
	send("presence",{"peers":[remote,remote.duplicate(true)],"local_peer":peer("alice","Alice",[])})
	var remote_image = await capture("remote-3d")
	labels([expected("user","bob","Bob",ids)],"remote-3d")
	individual_masks(ids,"remote-3d")
	await visible_label_pixels(remote_image,"remote-3d")
	send("development",{"states":jobs(ids)})
	var agent_image = await capture("remote-and-agent-3d")
	labels([expected("user","bob","Bob",ids),expected("agent","development:builder-session","Builder",ids)],"remote-and-agent-3d")
	individual_masks(ids,"remote-and-agent-3d")
	await visible_label_pixels(agent_image,"remote-and-agent-3d")
	send("display_settings",{"settings":{"show_agents":false}})
	var hidden_image = await capture("agents-hidden-3d")
	labels([expected("user","bob","Bob",ids)],"agents-hidden-3d")
	check(changed_in(remote_image,hidden_image,Rect2(Vector2.ZERO,Vector2(1000,700)))==0,"Agent switch restores exact human-only GPU image")
	individual_masks(ids,"agents-hidden-3d")
	send("display_settings",{"settings":{"show_agents":true}})
	await capture("agents-restored-3d")
	labels([expected("user","bob","Bob",ids),expected("agent","development:builder-session","Builder",ids)],"agents-restored-3d")
	send("development",{"states":[]})
	var mixed = ["A","C","HUD"]
	send("presence",{"peers":[peer("bob","Bob",mixed)],"local_peer":peer("alice","Alice",[])})
	await capture("remote-mixed-canvas-3d")
	labels([expected("user","bob","Bob",mixed)],"remote-mixed-canvas-3d")
	host.select_objects(mixed,"A",false)
	send("presence",{"peers":[],"local_peer":peer("alice","Alice",mixed)})
	await capture("local-mixed-canvas-3d")
	labels([expected("user","alice","Alice",mixed)],"local-mixed-canvas-3d")
	send("development",{"states":jobs(mixed)})
	await capture("agent-mixed-canvas-3d")
	labels([expected("user","alice","Alice",mixed),expected("agent","development:builder-session","Builder",mixed)],"agent-mixed-canvas-3d")
	send("development",{"states":[]})
	send("presence",{"peers":[peer("bob","Alex",mixed)],"local_peer":peer("alice","Alex",mixed)})
	await capture("same-display-name-distinct-users")
	labels([expected("user","alice","Alex",mixed),expected("user","bob","Alex",mixed)],"same-display-name-distinct-users")
	host.select_objects([],"",false)
	send("presence",{"peers":[],"local_peer":peer("alice","Alice",[])})
	await capture("deselected")
	labels([],"deselected")
	check(overlay.outline_renderer.groups.is_empty() and overlay.drawn_canvas_selections.is_empty(),"deselect clears all silhouettes, UI frames and names")
	var ok = checks.all(func(row): return row.ok)
	FileAccess.open(out+"/result.json",FileAccess.WRITE).store_string(JSON.stringify({"ok":ok,"checks":checks,"drawn":samples},"\t"))
	print("NATIVE_SELECTION_NAMES_COMPLETE "+str(checks.size()))
	host.free()
	quit(0 if ok else 1)
