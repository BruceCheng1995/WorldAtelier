extends SceneTree
const ProjectionHost = preload("res://world_projection.gd")
const BehaviorContext = preload("res://behavior_context.gd")
var checks: Array = []
var options: Dictionary = {}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var pair = arg.substr(2).split("=",true,1)
			options[pair[0]] = pair[1] if pair.size()>1 else "true"
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok: print("FREEZE_PROBE_FAILED "+detail)

func run() -> void:
	create_timer(10).timeout.connect(func(): print("FREEZE_PROBE_TIMEOUT");quit(2))
	var projection = ProjectionHost.new()
	root.add_child(projection)
	projection.content_root = Node3D.new()
	projection.add_child(projection.content_root)
	var model = Node3D.new()
	model.name = "Model"
	projection.content_root.add_child(model)
	var animation_player = AnimationPlayer.new()
	animation_player.process_mode = Node.PROCESS_MODE_ALWAYS
	model.add_child(animation_player)
	var library = AnimationLibrary.new()
	var animation = Animation.new()
	animation.length = 2
	animation.loop_mode = Animation.LOOP_LINEAR
	var track = animation.add_track(Animation.TYPE_VALUE)
	animation.track_set_path(track,NodePath(".:position:x"))
	animation.track_insert_key(track,0,0.0)
	animation.track_insert_key(track,2,2.0)
	library.add_animation("motion",animation)
	library.add_animation("queued",animation.duplicate())
	animation_player.add_animation_library("",library)
	animation_player.speed_scale = .7
	animation_player.play_section("motion",.1,1.8,0,1.7)
	animation_player.queue("queued")
	var particle = CPUParticles3D.new()
	particle.speed_scale = 2.5
	model.add_child(particle)
	var context = BehaviorContext.new()
	context.root = model
	context.create_tween().tween_property(model,"position:z",2.0,2.0)
	# The registry uses this same context API for creator-owned tweens.
	projection.behaviors.entries.fixture = {"instance":RefCounted.new(),"context":context,"disabled":false}
	await create_timer(.15).timeout
	check(animation_player.current_animation_position>.1 and model.position.z>0,"actual AnimationPlayer and owned Tween advance before inspection")
	var speed = animation_player.get_playing_speed()
	var queued = animation_player.get_queue()
	projection.freeze(true)
	var held_time = animation_player.current_animation_position
	var held_position = model.position
	await create_timer(.18).timeout
	check(animation_player.current_animation_position==held_time and model.position==held_position,"personal freeze holds animation/Tween exact state including ALWAYS child")
	check(particle.speed_scale==0,"particle simulation speed is frozen")
	projection.freeze(false)
	check(animation_player.process_mode==Node.PROCESS_MODE_ALWAYS and is_equal_approx(animation_player.get_playing_speed(),speed),"resume restores process policy and custom playback speed")
	check(animation_player.get_queue()==queued and is_equal_approx(animation_player.get_section_start_time(),.1) and is_equal_approx(animation_player.get_section_end_time(),1.8),"resume preserves animation section and queued animation")
	check(is_equal_approx(particle.speed_scale,2.5),"resume restores particle speed")
	await create_timer(.15).timeout
	check(animation_player.current_animation_position>held_time and model.position.z>held_position.z,"same-revision resume actually advances animation and owned Tween")
	var ok = true
	for item in checks: ok = ok and item.ok
	var result = {"ok":ok,"completed":true,"checks":checks,"scope":"actual headless AnimationPlayer/Node processing/Tween/CPUParticles state; no GPU frame assertion"}
	if options.has("report"):
		var file = FileAccess.open(options.report,FileAccess.WRITE)
		file.store_string(JSON.stringify(result,"\t"))
	print("PROJECTION_FREEZE_PROBE_COMPLETE "+JSON.stringify(result))
	quit(0 if ok else 1)
