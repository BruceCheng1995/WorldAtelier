extends SceneTree
var inventory_path="res://../../.local/prefab-scenes/inventory.json"
var report_dir=""
var render=false
var results: Array=[]
func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--inventory="):inventory_path=arg.substr(12)
		if arg.begins_with("--report-dir="):report_dir=arg.substr(13)
		if arg=="--render":render=true
	run.call_deferred()
func run() -> void:
	if not report_dir.is_empty():DirAccess.make_dir_recursive_absolute(report_dir)
	var inventory=JSON.parse_string(FileAccess.get_file_as_string(inventory_path))
	var photographed={}
	var failed=0
	for item in inventory.items:
		# The generated .tscn is actually loaded and instantiated for every entry.
		var packed=load(item.scene)
		if not packed is PackedScene:
			failed+=1;results.append({"id":item.id,"ok":false,"failures":["generated PackedScene failed to load"]});continue
		var scene=packed.instantiate();root.add_child(scene)
		await process_frame
		if scene.get_script()==null:
			failed+=1;results.append({"id":item.id,"ok":false,"failures":["scene script failed to load"]});scene.queue_free();continue
		var result=scene.result.duplicate(true)
		if not result.get("completed",false):
			result.ok=false;result.failures.append("scene assertions did not complete")
		if not result.ok:failed+=1
		var photo_key=item.category+"-"+item.kind
		if render and not photographed.has(photo_key):
			for i in range(3):await process_frame
			await RenderingServer.frame_post_draw
			var path=report_dir.path_join(photo_key+".png")
			root.get_texture().get_image().save_png(path)
			result.capture=path;photographed[photo_key]=true
		results.append(result)
		scene.queue_free();await process_frame
	var report={"ok":failed==0,"fixtures":results.size(),"failed":failed,"rendered_captures":photographed.size(),"scope":"actual independent PackedScene + Node3D and isolated seeded Game assertions; transport, live campaign and GLB triangle collision are separate","limits":inventory.limits,"results":results}
	if not report_dir.is_empty():
		var file=FileAccess.open(report_dir.path_join("prefab-report.json"),FileAccess.WRITE);file.store_string(JSON.stringify(report,"  "))
	print("PREFAB_SCENE_RESULT fixtures=%d failed=%d captures=%d" % [results.size(),failed,photographed.size()])
	quit(0 if failed==0 else 1)
