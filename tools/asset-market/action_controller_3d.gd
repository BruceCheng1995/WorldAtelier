extends CharacterBody3D
## CC0 adapter. Input and combat signals can be driven by the owning game / AI.
signal attack_started(kind: String)
signal attack_hit(target: Object, amount: float)
signal health_changed(value: float)
signal died
@export var movement_speed: float = 4.5
@export var sprint_multiplier: float = 1.6
@export var acceleration: float = 22.0
@export var gravity: float = 24.0
@export var jump_speed: float = 8.0
@export var keyboard_enabled: bool = true
@export var camera_enabled: bool = true
@export var input_prefix: String = "wa_action_"
@export var max_health: float = 100.0
@export var attack_damage: float = 20.0
@export var attack_cooldown: float = 0.5
@export var attack_range: float = 2.0
@export_flags_3d_physics var attack_mask: int = 1
@export_enum("Melee", "Ranged") var attack_mode: int = 0
@export var idle_animation: String = "Idle"
@export var run_animation: String = "Run"
@export var jump_animation: String = "Jump"
@export var attack_animation: String = "Punch"
@export var hit_animation: String = "HitReact"
@export var death_animation: String = "Death"
var move_input := Vector2.ZERO
var jump_requested := false
var sprint_requested := false
var animation_player: AnimationPlayer
var animation_state := ""
var health: float
var dead := false
var action_time := 0.0
var coyote_time := 0.0
var jump_buffer := 0.0

func _ready() -> void:
	health=max_health
	for pair in [["left",KEY_A,KEY_LEFT],["right",KEY_D,KEY_RIGHT],["up",KEY_W,KEY_UP],["down",KEY_S,KEY_DOWN],["jump",KEY_SPACE],["sprint",KEY_SHIFT],["attack",KEY_F]]:
		var action: String=input_prefix+pair[0]
		if InputMap.has_action(action): continue
		InputMap.add_action(action)
		for key in pair.slice(1):
			var event:=InputEventKey.new()
			event.physical_keycode=key
			InputMap.action_add_event(action,event)
	animation_player=$Visual.find_child("AnimationPlayer",true,false) as AnimationPlayer
	if animation_player:
		for animation in [idle_animation,run_animation]:
			if animation_player.has_animation(animation): animation_player.get_animation(animation).loop_mode=Animation.LOOP_LINEAR
	_play(idle_animation)
	$CameraRig/SpringArm3D/Camera3D.current=camera_enabled
	$CameraRig/SpringArm3D.add_excluded_object(get_rid())

func set_move_input(direction: Vector2,jump: bool=false,sprint: bool=false) -> void:
	move_input=direction.limit_length()
	jump_requested=jump
	sprint_requested=sprint

func _play(animation: String) -> void:
	if animation_state==animation: return
	animation_state=animation
	if animation_player and animation_player.has_animation(animation): animation_player.play(animation,0.12)

func trigger_primary() -> bool:
	if dead or action_time>0: return false
	action_time=maxf(0.05,attack_cooldown)
	_play(attack_animation)
	attack_started.emit("ranged" if attack_mode==1 else "melee")
	var origin:=global_position+Vector3.UP*1.1
	var direction: Vector3=$Visual.global_basis.z.normalized()
	var query:=PhysicsRayQueryParameters3D.create(origin,origin+direction*attack_range,attack_mask,[get_rid()])
	var hit:=get_world_3d().direct_space_state.intersect_ray(query)
	if not hit.is_empty():
		var target: Object=hit.collider
		if target.has_method("take_damage"): target.take_damage(attack_damage)
		attack_hit.emit(target,attack_damage)
	return true

func take_damage(amount: float) -> void:
	if dead: return
	health=clampf(health-maxf(0,amount),0,max_health)
	health_changed.emit(health)
	if health<=0:
		dead=true
		move_input=Vector2.ZERO
		_play(death_animation)
		died.emit()
	else:
		action_time=0.25
		_play(hit_animation)

func _physics_process(delta: float) -> void:
	action_time=maxf(0,action_time-delta)
	if keyboard_enabled and not dead:
		move_input=Input.get_vector(input_prefix+"left",input_prefix+"right",input_prefix+"up",input_prefix+"down")
		jump_requested=Input.is_action_just_pressed(input_prefix+"jump")
		sprint_requested=Input.is_action_pressed(input_prefix+"sprint")
		if Input.is_action_just_pressed(input_prefix+"attack"): trigger_primary()
	if dead: move_input=Vector2.ZERO
	var direction:=Vector3(move_input.x,0,move_input.y)
	var speed:=movement_speed*(sprint_multiplier if sprint_requested else 1.0)
	velocity.x=move_toward(velocity.x,direction.x*speed,acceleration*delta)
	velocity.z=move_toward(velocity.z,direction.z*speed,acceleration*delta)
	coyote_time=0.12 if is_on_floor() else maxf(0.0,coyote_time-delta)
	jump_buffer=0.12 if jump_requested and not dead else maxf(0.0,jump_buffer-delta)
	if not is_on_floor(): velocity.y-=gravity*delta
	if jump_buffer>0 and coyote_time>0:
		velocity.y=jump_speed
		jump_buffer=0
		coyote_time=0
	jump_requested=false
	move_and_slide()
	if direction.length()>0.05 and not dead: $Visual.rotation.y=lerp_angle($Visual.rotation.y,atan2(direction.x,direction.z),minf(1,delta*12))
	if action_time<=0 and not dead:
		_play(jump_animation if not is_on_floor() else run_animation if Vector2(velocity.x,velocity.z).length()>0.1 else idle_animation)
