extends SceneTree
var inventory_path="res://../../.local/prefab-scenes/inventory.json"
var report_dir=""
var render=false
var results: Array=[]
class ErrorCollector extends Logger:
	var errors: Array=[]
	var lock=Mutex.new()
	var fixture_id="startup"
	func _log_error(_function: String,_file: String,_line: int,code: String,rationale: String,_editor_notify: bool,error_type: int,_backtraces: Array[ScriptBacktrace]) -> void:
		if error_type==Logger.ERROR_TYPE_WARNING:return
		lock.lock();errors.append({"fixture":fixture_id,"error":code+" "+rationale});lock.unlock()
var collector=ErrorCollector.new()
func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--inventory="):inventory_path=arg.substr(12)
		if arg.begins_with("--report-dir="):report_dir=arg.substr(13)
		if arg=="--render":render=true
	OS.add_logger(collector)
	run.call_deferred()
func run() -> void:
	if not report_dir.is_empty():DirAccess.make_dir_recursive_absolute(report_dir)
	var inventory=JSON.parse_string(FileAccess.get_file_as_string(inventory_path))
	var photographed={}
	var failed=0
	for item in inventory.items:
		collector.fixture_id=item.id
		# The generated .tscn is actually loaded and instantiated for every entry.
		var packed=load(item.scene)
		if not packed is PackedScene:
			failed+=1;results.append({"id":item.id,"ok":false,"failures":["generated PackedScene failed to load"]});continue
		var scene=packed.instantiate();root.add_child(scene)
		await process_frame
		if scene.get_script()==null:
			failed+=1;results.append({"id":item.id,"ok":false,"failures":["scene script failed to load"]});scene.queue_free();continue
		var raw_result=scene.get("result")
		if not raw_result is Dictionary:
			failed+=1;results.append({"id":item.id,"ok":false,"failures":["scene omitted its verification result"]});scene.queue_free();continue
		var result=raw_result.duplicate(true)
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
	OS.remove_logger(collector)
	if not collector.errors.is_empty():failed+=1
	if results.size()!=int(inventory.counts.total):failed+=1
	var report={"ok":failed==0,"fixtures":results.size(),"failed":failed,"rendered_captures":photographed.size(),"scope":"actual independent PackedScene + Node3D and isolated seeded Game assertions; transport, live campaign and GLB triangle collision are separate","limits":inventory.limits,"engine_errors":collector.errors,"results":results}
	if not report_dir.is_empty():
		var file=FileAccess.open(report_dir.path_join("prefab-report.json"),FileAccess.WRITE);file.store_string(JSON.stringify(report,"  "))
	print("PREFAB_SCENE_RESULT fixtures=%d failed=%d captures=%d" % [results.size(),failed,photographed.size()])
	quit(0 if failed==0 else 1)
