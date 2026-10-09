extends Node3D
## The replaceable native SceneTree.current_scene; game services are Autoloads.
func _exit_tree() -> void:
	var runtime = get_node_or_null("/root/GameRuntime")
	if runtime != null: runtime.scene_detached(self)
