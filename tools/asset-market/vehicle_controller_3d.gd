extends CharacterBody3D
## CC0 arcade driving adapter, +Z is forward. Not a suspension simulator.
@export var max_speed: float = 16.0
@export var reverse_speed: float = 6.0
@export var acceleration: float = 9.0
@export var brake_force: float = 22.0
@export var steering_speed: float = 1.8
@export var gravity: float = 24.0
@export var keyboard_enabled: bool = true
@export var camera_enabled: bool = true
@export var input_prefix: String = "wa_vehicle_"
var throttle := 0.0
var steering := 0.0
var braking := false
var speed := 0.0
func _ready() -> void:
	for pair in [["left",KEY_A,KEY_LEFT],["right",KEY_D,KEY_RIGHT],["forward",KEY_W,KEY_UP],["reverse",KEY_S,KEY_DOWN],["brake",KEY_SPACE]]:
		var action: String=input_prefix+pair[0]
		if InputMap.has_action(action): continue
		InputMap.add_action(action)
		for key in pair.slice(1):
			var event:=InputEventKey.new()
			event.physical_keycode=key
			InputMap.action_add_event(action,event)
	$CameraRig/SpringArm3D/Camera3D.current=camera_enabled
	$CameraRig/SpringArm3D.add_excluded_object(get_rid())
func set_drive_input(accelerate: float,turn: float,brake: bool=false) -> void:
	throttle=clampf(accelerate,-1,1)
	steering=clampf(turn,-1,1)
	braking=brake
func _physics_process(delta: float) -> void:
	if keyboard_enabled:
		throttle=Input.get_axis(input_prefix+"reverse",input_prefix+"forward")
		steering=Input.get_axis(input_prefix+"right",input_prefix+"left")
		braking=Input.is_action_pressed(input_prefix+"brake")
	var target:=throttle*(max_speed if throttle>=0 else reverse_speed)
	speed=move_toward(speed,0 if braking else target,(brake_force if braking else acceleration)*delta)
	if absf(speed)>0.1: rotate_y(steering*steering_speed*clampf(speed/max_speed,-1,1)*delta)
	var direction:=global_basis.z.normalized()
	velocity.x=direction.x*speed
	velocity.z=direction.z*speed
	if not is_on_floor(): velocity.y-=gravity*delta
	move_and_slide()
	if get_slide_collision_count()>0: speed=Vector2(velocity.x,velocity.z).length()*signf(speed)
