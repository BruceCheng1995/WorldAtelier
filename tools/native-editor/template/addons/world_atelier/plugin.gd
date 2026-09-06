@tool
extends EditorPlugin
var exporting := false
var test_recipe: Dictionary = {}

func _enter_tree() -> void:
	scene_saved.connect(_scene_saved)
	add_tool_menu_item("World Atelier: Export scene to workspace", _export_scene)
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--atelier-edit-recipe="):
			test_recipe = JSON.parse_string(FileAccess.get_file_as_string(arg.trim_prefix("--atelier-edit-recipe=")))
	if not test_recipe.is_empty(): _test_save.call_deferred()

func _exit_tree() -> void:
	remove_tool_menu_item("World Atelier: Export scene to workspace")

func _scene_saved(path: String) -> void:
	if path == "res://world.tscn": _export_scene()

func _export_scene() -> void:
	if exporting: return
	exporting = true
	var world := EditorInterface.get_edited_scene_root()
	if world == null or world.get_script() != load("res://atelier_world.gd"):
		push_error("Open world.tscn before exporting")
		exporting = false
		return
	var source: Dictionary = JSON.parse_string(world.source_json)
	var objects: Array = []
	var ids: Dictionary = {}
	for child in world.get_children():
		if child.get_script() != load("res://atelier_object.gd"): continue
		if child.stable_id.is_empty() or ids.has(child.stable_id) or absf(child.position.y) > 0.0001 or child.rotation.length() > 0.0001 or absf(child.scale.x-child.scale.y) > 0.0001 or absf(child.scale.x-child.scale.z) > 0.0001:
			push_error("Unsupported native transform or duplicate/empty stable ID: " + child.name)
			exporting = false
			return
		ids[child.stable_id] = true
		var object: Dictionary = JSON.parse_string(child.source_json)
		object.merge({"id":child.stable_id,"name":child.display_name,"kind":child.object_kind,"x":snappedf(child.position.x,0.00001),"z":snappedf(child.position.z,0.00001),"scale":snappedf(child.scale.x,0.00001),"color":"#"+child.object_color.to_html(false),"solid":child.solid},true)
		if child.model_asset.is_empty(): object.erase("model_asset")
		else: object.model_asset = child.model_asset
		objects.append(object)
	source.objects = objects
	var file := FileAccess.open("res://scene-export.json", FileAccess.WRITE)
	file.store_string(JSON.stringify(source,"\t"))
	file.close()
	var output: Array = []
	var code := OS.execute(ProjectSettings.get_setting("world_atelier/node_binary","node"),[ProjectSettings.globalize_path("res://export.mjs")],output,true)
	for line in output: print(line)
	if code != 0: push_error("Source export failed; scene is saved, workspace retained; inspect native-export-conflicts.json or console")
	exporting = false

# Automation exercises EditorInterface.save_scene and its real scene_saved signal.
# It edits scene Nodes, never a running game's state or an authority acknowledgment.
func _test_save() -> void:
	for attempt in range(120):
		await get_tree().create_timer(0.25).timeout
		var world := EditorInterface.get_edited_scene_root()
		if world == null: continue
		for child in world.get_children():
			if child.get_script() != load("res://atelier_object.gd") or child.stable_id != test_recipe.object_id: continue
			child.position.x = test_recipe.x
			child.object_color = Color(test_recipe.color)
			child.solid = test_recipe.solid
			child.display_name = test_recipe.name
			EditorInterface.set_main_screen_editor("3D")
			EditorInterface.get_selection().clear()
			EditorInterface.get_selection().add_node(child)
			EditorInterface.inspect_object(child)
			EditorInterface.mark_scene_as_unsaved()
			var result := EditorInterface.save_scene()
			print("NATIVE_EDITOR_SCENE_SAVED ", result)
			await get_tree().create_timer(0.6).timeout
			if test_recipe.has("capture") and DisplayServer.get_name() != "headless":
				var surface = EditorInterface.get_editor_viewport_3d(0).get_parent().get_parent().get_child(1)
				surface.grab_focus()
				var focus_key := InputEventKey.new()
				focus_key.keycode = KEY_F
				focus_key.pressed = true
				Input.parse_input_event(focus_key)
				await get_tree().create_timer(0.6).timeout
				EditorInterface.get_base_control().get_viewport().get_texture().get_image().save_png(test_recipe.capture)
			get_tree().quit(result)
			return
	push_error("Native scene edit recipe timed out")
	get_tree().quit(1)
