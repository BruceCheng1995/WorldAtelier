extends CharacterBody2D
## Self-contained controller. Input actions are installed only on instantiation.
## For AI/network control disable keyboard_enabled and call set_move_input.
@export_enum("Platformer", "Top down") var movement_mode: int = 0
@export var movement_speed: float = 260.0
@export var sprint_multiplier: float = 1.45
@export var acceleration: float = 1800.0
@export var gravity: float = 1500.0
@export var jump_speed: float = 580.0
@export var keyboard_enabled: bool = true
@export var camera_enabled: bool = true
@export var input_prefix: String = "wa_character_"
@onready var sprite: AnimatedSprite2D = $Visual
var move_input := Vector2.ZERO
var jump_requested := false
var sprint_requested := false
var animation_state := "idle"
var coyote_time := 0.0
var jump_buffer := 0.0

func _ready() -> void:
	for pair in [["left",KEY_A,KEY_LEFT],["right",KEY_D,KEY_RIGHT],["up",KEY_W,KEY_UP],["down",KEY_S,KEY_DOWN],["jump",KEY_SPACE],["sprint",KEY_SHIFT]]:
		var action: String = input_prefix + pair[0]
		if InputMap.has_action(action): continue
		InputMap.add_action(action)
		for key in pair.slice(1):
			var event := InputEventKey.new()
			event.physical_keycode = key
			InputMap.action_add_event(action,event)
	$Camera2D.enabled = camera_enabled
	if movement_mode == 1: motion_mode = CharacterBody2D.MOTION_MODE_FLOATING
	sprite.play("idle")

func set_move_input(direction: Vector2, jump: bool = false, sprint: bool = false) -> void:
	move_input = direction.limit_length()
	jump_requested = jump
	sprint_requested = sprint

func _physics_process(delta: float) -> void:
	if keyboard_enabled:
		move_input = Input.get_vector(input_prefix+"left",input_prefix+"right",input_prefix+"up",input_prefix+"down")
		jump_requested = Input.is_action_just_pressed(input_prefix+"jump")
		sprint_requested = Input.is_action_pressed(input_prefix+"sprint")
	var speed := movement_speed * (sprint_multiplier if sprint_requested else 1.0)
	if movement_mode == 1:
		velocity = velocity.move_toward(move_input * speed, acceleration * delta)
	else:
		coyote_time = 0.12 if is_on_floor() else maxf(0.0,coyote_time-delta)
		jump_buffer = 0.12 if jump_requested else maxf(0.0,jump_buffer-delta)
		velocity.x = move_toward(velocity.x,move_input.x*speed,acceleration*delta)
		if not is_on_floor(): velocity.y += gravity * delta
		if coyote_time > 0.0 and jump_buffer > 0.0:
			velocity.y = -jump_speed
			coyote_time = 0.0
			jump_buffer = 0.0
	jump_requested = false
	move_and_slide()
	if absf(move_input.x)>0.05: sprite.flip_h = move_input.x < 0.0
	var moving := velocity.length()>10.0 if movement_mode==1 else absf(velocity.x)>10.0
	animation_state = ("run" if sprint_requested else "walk") if moving else "idle"
	if movement_mode==0 and not is_on_floor(): animation_state="jump" if velocity.y<0 else "fall"
	if sprite.animation!=animation_state: sprite.play(animation_state)
