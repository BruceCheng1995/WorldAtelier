extends SceneTree
const Simulation = preload("res://world_simulation.gd")
const SOURCE = """extends RefCounted
func initialize(ctx):
	if not ctx.state.has("inside"): ctx.state["inside"]=[]
	if not ctx.state.has("activations"): ctx.state["activations"]=0
	return {"ok":true}
func trigger(ctx,actor,entered):
	if entered and not actor.id in ctx.state.inside:
		ctx.state.inside.append(actor.id)
		ctx.state["activations"]+=1
	elif not entered: ctx.state.inside.erase(actor.id)
	return {"ok":true}
func tick(ctx,_delta):
	if ctx.properties.get("prune_offline",false):
		var online=[]
		for actor in ctx.players:
			if actor.get("online",false): online.append(actor.id)
		for id in ctx.state.inside.duplicate():
			if not id in online: ctx.state.inside.erase(id)
	return {"ok":true}
"""
var options = {}
var checks: Array = []
var signals: Array = []
var frames = 0
var simulation: Node3D
var generation = 0
var input_sequence = 0
var prune_offline = false

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		var pair=arg.trim_prefix("--").split("=",true,1)
		if pair.size()==2:options[pair[0]]=pair[1]
	run.call_deferred()

func check(ok: bool, detail: String) -> void:
	checks.append({"ok":ok,"detail":detail})
	if not ok: print("TRIGGER_LIFECYCLE_FAILED "+detail)

func replace_world(state: Dictionary, ids: Array, spawn = [0,2,3]) -> void:
	var view=SubViewport.new()
	view.own_world_3d=true
	view.size=Vector2i(16,16)
	view.render_target_update_mode=SubViewport.UPDATE_DISABLED
	root.add_child(view)
	var candidate=Simulation.new()
	view.add_child(candidate)
	candidate.scene_revision="trigger-lifecycle"
	var content=Node3D.new()
	var anchor=Node3D.new()
	anchor.position=Vector3(0,1.25,0)
	content.add_child(anchor)
	var hash=SOURCE.sha256_text()
	var sources={}
	sources[hash]=SOURCE
	var document={"spawn_position":spawn,"objects":[{"id":"probe-area","position":[0,1.25,0],"scale":1,"components":{"trigger":{"shape":"sphere","radius":1.35},"behaviors":[{"id":"counter","script_hash":hash,"properties":{"prune_offline":prune_offline}}]}}]}
	var error=candidate.initialize({"document":document,"root":content,"objects":{"probe-area":anchor},"assets":[],"sources":sources},state)
	check(error.is_empty(),"candidate "+str(generation)+" initializes actual physics and SHA-256 checked generic fixture behavior")
	if not error.is_empty(): print(error);quit(2);return
	var area: Area3D=candidate.triggers["probe-area"]
	var current_generation=generation
	for entered in [true,false]:
		var callback=func(body):
			signals.append({"generation":current_generation,"frame":frames,"entered":entered,"id":body.get_meta("player_id"),"position":[body.position.x,body.position.y,body.position.z]})
		if entered: area.body_entered.connect(callback)
		else: area.body_exited.connect(callback)
	for id in ids: candidate.join(id,id,"#8acfff")
	if simulation!=null:
		simulation.active=false
		simulation.get_parent().queue_free()
	simulation=candidate
	simulation.scene_revision="trigger-lifecycle"
	simulation.active=true
	generation+=1

func step(count: int, direction = Vector2.ZERO) -> void:
	for index in range(count):
		await physics_frame
		if simulation.players.has("a"):
			input_sequence+=1
			simulation.accept_input({"player_id":"a","epoch":0,"scene_revision":"trigger-lifecycle","input_seq":input_sequence,"move":[direction.x,direction.y]})
		simulation.step(1.0/60)
		frames+=1
		await process_frame

func state() -> Dictionary:
	return simulation.snapshot().object_states["probe-area"].counter

func run() -> void:
	create_timer(20).timeout.connect(func():print("TRIGGER_LIFECYCLE_TIMEOUT");quit(2))
	var saved={"players":{"a":{"position":[0,.314886868,3]},"b":{"position":[0,.314886868,3]}}}
	for index in range(3):
		replace_world(saved,["a","b"])
		await step(12)
		check(signals.is_empty() and state().activations==0 and state().inside.is_empty(),"stationary outside players produce no enter/exit across candidate "+str(index))
		saved=simulation.snapshot()
	check(is_equal_approx(simulation.players.a.body.position.z,3) and is_equal_approx(simulation.players.b.body.position.z,3),"zero input preserves both players horizontal position across candidate migration")
	await step(24,Vector2(0,-1))
	await step(4)
	check(state().activations==1 and state().inside==["a"],"real normal input moves A into actual sphere and activates exactly once while B remains outside")
	await step(20)
	check(state().activations==1 and state().inside==["a"],"remaining physically inside does not repeatedly activate")
	var previous_signal_count=signals.size()
	replace_world(simulation.snapshot(),["a","b"])
	await step(12)
	var correct_signals=true
	for signal_row in signals.slice(previous_signal_count):
		# Retired world's raw exit during queue_free is expected; active=false
		# already prevents it reaching behaviors. Only inspect the new world.
		if signal_row.generation!=generation-1:continue
		correct_signals=correct_signals and signal_row.id=="a" and signal_row.entered
	check(correct_signals and state().activations==1 and state().inside==["a"],"rebuilding with an inside player preserves membership and produces no phantom exit or outside-player entry")
	await step(36,Vector2(0,1))
	await step(4)
	check(state().activations==1 and state().inside.is_empty(),"real movement out of trigger emits exit")
	await step(36,Vector2(0,-1))
	await step(4)
	check(state().activations==2 and state().inside==["a"],"real reentry activates a second time")
	replace_world({"players":{"a":{"position":[0,.2,0]}}},["a"])
	await step(12)
	check(state().activations==1 and state().inside==["a"],"restored initial position inside trigger is not suppressed by a blanket first-frame gate")
	replace_world({},[],[0,.2,0])
	await step(4)
	simulation.join("new-player","New player","#fff")
	await step(12)
	check(state().activations==1 and state().inside==["new-player"],"fresh player spawning inside an already running trigger also enters normally")
	var okay=true
	for item in checks:okay=okay and item.ok
	var report={"ok":okay,"completed":true,"checks":checks,"signals":signals,"scope":"actual isolated Godot physics, registry-compiled generic counter fixture and normal accept_input; no production behavior modified and no browser assertion"}
	if options.has("report"):
		var file=FileAccess.open(options.report,FileAccess.WRITE)
		file.store_string(JSON.stringify(report,"\t"))
	print("TRIGGER_LIFECYCLE_COMPLETE "+JSON.stringify(report))
	quit(0 if okay else 1)
