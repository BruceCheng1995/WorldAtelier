extends SceneTree
# Feed normal Godot keyboard events to the real main scene. This is software
# injection through Input, not OS manual-keyboard evidence or direct game state.
func _initialize() -> void:
	run.call_deferred()
func key(code: Key, pressed: bool) -> void:
	var event=InputEventKey.new();event.physical_keycode=code;event.pressed=pressed
	Input.parse_input_event(event)
func run() -> void:
	var main=load("res://main.tscn").instantiate();root.add_child(main)
	await create_timer(.7).timeout
	key(KEY_SPACE,true)
	await create_timer(2.6).timeout
	key(KEY_SPACE,false)
	await create_timer(.4).timeout
	main.finish()
