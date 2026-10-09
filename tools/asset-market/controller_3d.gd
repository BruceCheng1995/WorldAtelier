extends CharacterBody3D
## Local independent character; adjust properties on the game-owned prefab.
@export var movement_speed: float = 4.5
@export var sprint_multiplier: float = 1.6
@export var acceleration: float = 22.0
@export var gravity: float = 24.0
@export var jump_speed: float = 8.0
@export var keyboard_enabled: bool = true
@export var camera_enabled: bool = true
@export_enum("Third person", "Top down") var camera_mode: int = 0
@export var input_prefix: String = "wa_character_"
var move_input := Vector2.ZERO
var jump_requested := false
var sprint_requested := false
var animation_state := "idle"
var animation_player: AnimationPlayer
var coyote_time := 0.0
var jump_buffer := 0.0

func _ready() -> void:
	for pair in [["left",KEY_A,KEY_LEFT],["right",KEY_D,KEY_RIGHT],["up",KEY_W,KEY_UP],["down",KEY_S,KEY_DOWN],["jump",KEY_SPACE],["sprint",KEY_SHIFT]]:
		var action: String=input_prefix+pair[0]
		if InputMap.has_action(action): continue
		InputMap.add_action(action)
		for key in pair.slice(1):
			var event:=InputEventKey.new()
			event.physical_keycode=key
			InputMap.action_add_event(action,event)
	animation_player=$Visual.find_child("AnimationPlayer",true,false) as AnimationPlayer
	if animation_player:
		for animation in animation_player.get_animation_list():
			if animation in ["idle","run"]: animation_player.get_animation(animation).loop_mode=Animation.LOOP_LINEAR
		animation_player.play("idle")
	$CameraRig/SpringArm3D/Camera3D.current=camera_enabled
	$CameraRig/SpringArm3D.add_excluded_object(get_rid())
	if camera_mode==1:
		$CameraRig.rotation.x=deg_to_rad(-65.0)
		$CameraRig/SpringArm3D.spring_length=9.0

func set_move_input(direction: Vector2,jump: bool=false,sprint: bool=false) -> void:
	move_input=direction.limit_length()
	jump_requested=jump
	sprint_requested=sprint

func _physics_process(delta: float) -> void:
	if keyboard_enabled:
		move_input=Input.get_vector(input_prefix+"left",input_prefix+"right",input_prefix+"up",input_prefix+"down")
		jump_requested=Input.is_action_just_pressed(input_prefix+"jump")
		sprint_requested=Input.is_action_pressed(input_prefix+"sprint")
	var direction:=Vector3(move_input.x,0,move_input.y)
	var speed:=movement_speed*(sprint_multiplier if sprint_requested else 1.0)
	velocity.x=move_toward(velocity.x,direction.x*speed,acceleration*delta)
	velocity.z=move_toward(velocity.z,direction.z*speed,acceleration*delta)
	coyote_time=0.12 if is_on_floor() else maxf(0.0,coyote_time-delta)
	jump_buffer=0.12 if jump_requested else maxf(0.0,jump_buffer-delta)
	if not is_on_floor(): velocity.y-=gravity*delta
	if jump_buffer>0 and coyote_time>0:
		velocity.y=jump_speed
		jump_buffer=0
		coyote_time=0
	jump_requested=false
	move_and_slide()
	if direction.length()>0.05:
		$Visual.rotation.y=lerp_angle($Visual.rotation.y,atan2(direction.x,direction.z),minf(1,delta*12))
	var next: String="run" if Vector2(velocity.x,velocity.z).length()>0.1 else "idle"
	if not is_on_floor(): next="jump"
	if next!=animation_state:
		animation_state=next
		if animation_player and animation_player.has_animation(next): animation_player.play(next,0.16)
	if animation_player: animation_player.speed_scale=(1.4 if sprint_requested else 1.0) if next=="run" else 1.0
