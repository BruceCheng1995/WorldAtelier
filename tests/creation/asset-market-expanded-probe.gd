extends SceneTree

class DamageTarget extends StaticBody3D:
	var health := 500.0
	func take_damage(amount: float) -> void: health -= maxf(0.0,amount)

var checks: Array = []
var kind := "action"
var entry := "character.tscn"
var output := ""
var expected_enemy := false
var actor: Node3D

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--kind="): kind=arg.trim_prefix("--kind=")
		if arg.begins_with("--entry="): entry=arg.trim_prefix("--entry=")
		if arg.begins_with("--out="): output=arg.trim_prefix("--out=")
		if arg=="--enemy": expected_enemy=true
	call_deferred("run")

func check(value: bool, label: String) -> void:
	checks.append({"name":label,"ok":value})
	if not value: push_error("EXPANDED_MARKET_CHECK_FAILED "+label)

func frames(count: int) -> void:
	for index in range(count): await physics_frame

func target_at(position: Vector3) -> DamageTarget:
	var target:=DamageTarget.new()
	var collision:=CollisionShape3D.new()
	var shape:=SphereShape3D.new()
	shape.radius=0.35
	collision.shape=shape
	target.add_child(collision)
	target.position=position
	root.add_child(target)
	return target

func run() -> void:
	check(DisplayServer.get_name()=="headless","headless display")
	check(AudioServer.get_driver_name()=="Dummy","silent audio")
	var packed=load("res://"+entry) as PackedScene
	check(packed!=null,"actual entry PackedScene loads")
	if packed==null:
		finish()
		return
	actor=packed.instantiate()
	check(not actor.find_children("*","MeshInstance3D",true,false).is_empty(),"real imported model mesh is present")
	if kind!="weapon":
		if expected_enemy:
			check(not actor.keyboard_enabled,"enemy keyboard defaults off")
			check(not actor.camera_enabled,"enemy camera defaults off")
		actor.keyboard_enabled=false
		actor.camera_enabled=false
		var ground:=StaticBody3D.new()
		var collision:=CollisionShape3D.new()
		var shape:=BoxShape3D.new()
		shape.size=Vector3(500,1,500)
		collision.shape=shape
		ground.position.y=-0.5
		ground.add_child(collision)
		root.add_child(ground)
	root.add_child(actor)
	await frames(25)
	if kind=="action": await action_checks()
	elif kind=="vehicle": await vehicle_checks()
	else: await weapon_checks()
	finish()

func action_checks() -> void:
	check(actor.is_on_floor(),"character rests on physical floor")
	check(actor.health==actor.max_health,"health initializes from exported maximum")
	check(actor.animation_player!=null,"imported AnimationPlayer is bound")
	if actor.animation_player==null: return
	for name in [actor.idle_animation,actor.run_animation,actor.attack_animation,actor.hit_animation,actor.death_animation]:
		check(actor.animation_player.has_animation(name),"bound animation exists: "+name)
	var start_x: float=actor.position.x
	actor.set_move_input(Vector2.RIGHT)
	await frames(25)
	check(actor.position.x>start_x+0.5,"script movement changes real position")
	check(actor.animation_state==actor.run_animation,"moving enters configured locomotion clip")
	var skeletons: Array[Node]=actor.find_children("*","Skeleton3D",true,false)
	check(not skeletons.is_empty(),"real skeleton is present")
	var before: Array=[]
	if not skeletons.is_empty():
		for bone in range(skeletons[0].get_bone_count()): before.append(skeletons[0].get_bone_pose(bone))
	await frames(7)
	var changed:=0
	if not skeletons.is_empty():
		for bone in range(before.size()):
			if not before[bone].is_equal_approx(skeletons[0].get_bone_pose(bone)): changed+=1
	check(changed>0,"locomotion changes real bone poses")
	actor.set_move_input(Vector2.ZERO)
	await frames(20)
	check(actor.animation_state==actor.idle_animation,"release returns to configured idle")
	actor.keyboard_enabled=true
	start_x=actor.position.x
	Input.action_press(actor.input_prefix+"right")
	Input.flush_buffered_events()
	await frames(18)
	Input.action_release(actor.input_prefix+"right")
	Input.flush_buffered_events()
	check(actor.position.x>start_x+0.2,"actual registered keyboard action moves character")
	actor.keyboard_enabled=false
	actor.set_move_input(Vector2.ZERO)
	await frames(20)
	var forward: Vector3=actor.get_node("Visual").global_basis.z.normalized()
	var target:=target_at(actor.global_position+Vector3.UP*1.1+forward*minf(actor.attack_range*0.5,4.0))
	await frames(2)
	var signals={"started":0,"hit":0,"died":0}
	actor.attack_started.connect(func(_mode):signals.started+=1)
	actor.attack_hit.connect(func(_target,_damage):signals.hit+=1)
	actor.died.connect(func():signals.died+=1)
	var health_before: float=target.health
	check(actor.trigger_primary(),"primary attack is accepted")
	check(actor.animation_state==actor.attack_animation,"attack enters actual attack clip")
	check(is_equal_approx(target.health,health_before-actor.attack_damage),"forward ray applies exported damage to real collider")
	check(signals.started==1 and signals.hit==1,"attack signals correspond to actual hit")
	check(not actor.trigger_primary(),"cooldown rejects immediate duplicate attack")
	check(signals.started==1 and is_equal_approx(target.health,health_before-actor.attack_damage),"rejected attack adds neither damage nor signals")
	await frames(ceili(actor.attack_cooldown*60)+3)
	check(actor.trigger_primary(),"attack becomes available after cooldown")
	target.queue_free()
	var original: float=actor.health
	actor.take_damage(-10)
	check(actor.health==original,"negative damage cannot heal character")
	actor.take_damage(10)
	check(actor.health==original-10,"incoming damage reduces current health")
	check(actor.animation_state==actor.hit_animation,"damage selects actual hit clip")
	actor.take_damage(actor.max_health+1)
	check(actor.dead and actor.health==0,"lethal damage clamps health and marks death")
	check(actor.animation_state==actor.death_animation,"death selects actual death clip")
	check(signals.died==1,"death signal occurs once")
	actor.take_damage(10)
	check(signals.died==1 and actor.health==0,"additional damage does not repeat death")
	check(not actor.trigger_primary(),"dead characters cannot attack")
	actor.set_move_input(Vector2.RIGHT,true)
	await frames(25)
	check(Vector2(actor.velocity.x,actor.velocity.z).length()<0.1,"dead character rejects further movement input")
	check(actor.animation_state==actor.death_animation,"death is not replaced by idle")

func vehicle_checks() -> void:
	check(actor.is_on_floor(),"vehicle rests on physical floor")
	var initial: Vector3=actor.position
	actor.set_drive_input(1,0)
	await frames(40)
	check(actor.position.z>initial.z+0.8,"positive throttle moves along +Z")
	check(actor.speed>1 and actor.speed<=actor.max_speed,"acceleration respects configured forward speed")
	var yaw: float=actor.rotation.y
	actor.set_drive_input(1,1)
	await frames(30)
	check(actor.rotation.y>yaw+0.02,"steering changes actual heading")
	var travel_direction: Vector3=actor.global_basis.z
	check(travel_direction.x>0.01,"positive steering rotates forward toward +X")
	actor.set_drive_input(1,0,true)
	await frames(45)
	check(absf(actor.speed)<0.01,"brake overrides throttle and stops speed")
	actor.set_drive_input(-1,0)
	initial=actor.position
	await frames(35)
	check(actor.speed< -1 and absf(actor.speed)<=actor.reverse_speed,"reverse respects reverse speed limit")
	check((actor.position-initial).dot(travel_direction)< -0.3,"reverse physically moves backward")
	actor.set_drive_input(0,0,true)
	await frames(25)
	actor.keyboard_enabled=true
	initial=actor.position
	Input.action_press(actor.input_prefix+"forward")
	Input.flush_buffered_events()
	await frames(25)
	Input.action_release(actor.input_prefix+"forward")
	Input.action_press(actor.input_prefix+"brake")
	Input.flush_buffered_events()
	check((actor.position-initial).dot(travel_direction)>0.2,"registered keyboard forward action drives vehicle")
	await frames(25)
	Input.action_release(actor.input_prefix+"brake")
	Input.flush_buffered_events()
	check(absf(actor.speed)<0.01,"registered keyboard brake stops vehicle")

func weapon_checks() -> void:
	check(actor.has_node("Muzzle"),"weapon has native muzzle marker")
	var muzzle: Vector3=actor.get_node("Muzzle").global_position
	var target:=target_at(muzzle+Vector3(0,0,4))
	await frames(2)
	var signals={"shots":0,"hit":{}}
	actor.fired.connect(func(hit):signals.shots+=1;signals.hit=hit)
	check(actor.fire(),"first shot succeeds")
	check(is_equal_approx(target.health,500-actor.damage),"shot damages actual collider along +Z")
	check(signals.shots==1 and not signals.hit.is_empty(),"fired signal contains real ray hit")
	check(not actor.fire(),"fire cooldown rejects duplicate shot")
	check(signals.shots==1 and is_equal_approx(target.health,500-actor.damage),"cooldown prevents extra signal and damage")
	await frames(ceili(actor.fire_interval*60)+3)
	check(actor.fire(),"weapon fires again after cooldown")
	check(is_equal_approx(target.health,500-actor.damage*2),"second permitted shot applies damage once")
	await frames(ceili(actor.fire_interval*60)+3)
	var exclusion: Array[RID]=[target.get_rid()]
	check(actor.fire(exclusion),"shot supports caller exclusion list")
	check(signals.hit.is_empty() and is_equal_approx(target.health,500-actor.damage*2),"excluded collider receives no damage")

func finish() -> void:
	var result={"kind":kind,"entry":entry,"checks":checks,"ok":checks.all(func(row):return row.ok)}
	var file:=FileAccess.open(output,FileAccess.WRITE)
	file.store_string(JSON.stringify(result,"  "))
	print("EXPANDED_MARKET_RESULT ",JSON.stringify(result))
	quit(0 if result.ok else 1)
