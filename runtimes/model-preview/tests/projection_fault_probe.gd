extends SceneTree
var options = {}

func _initialize() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var pair=arg.substr(2).split("=",true,1)
			options[pair[0]]=pair[1] if pair.size()>1 else "true"
	run.call_deferred()

func run() -> void:
	create_timer(8).timeout.connect(func():print("FAULT_PROBE_TIMEOUT");quit(2))
	var host = load("res://main.gd").new()
	root.add_child(host)
	var client = host.world_client
	var source = "extends RefCounted\nfunc initialize(ctx):\n\treturn {\"ok\":true}\nfunc tick(ctx,delta):\n\treturn {\"ok\":false,\"error\":\"probe late tick failure\"}\n"
	var hash = source.sha256_text()
	var object = Node3D.new()
	client.projection.add_child(object)
	var error = client.projection.behaviors.prepare({"objects":[{"id":"probe-object","components":{"behaviors":[{"id":"probe-component","script_hash":hash,"properties":{}}]}}]},{"probe-object":object},{hash:source},"presentation")
	client.mode = "playing"
	client.world_id = "probe-world"
	client.epoch = 1
	client.latest = {"scene_revision":"probe-revision","runtime_fault":{}}
	client.projection.advance(.016)
	client.emit_state()
	client.update_hud()
	var packet: Dictionary = host.outbound_log.back()
	var checks = [
		{"ok":error.is_empty() and not client.projection.behaviors.fault.is_empty(),"detail":"actual compiled presentation tick failure is captured after successful initialization"},
		{"ok":packet.type=="world_state" and packet.runtime_fault.get("role")=="presentation" and packet.runtime_fault.get("object_id")=="probe-object" and not packet.error.is_empty(),"detail":"world_state exposes actual role/object/component fault instead of reporting silent success"},
		{"ok":client.hud.text.contains("行为错误") and client.hud.text.contains("probe-component"),"detail":"runtime HUD identifies the failed component"}
	]
	var ok = true
	for check in checks: ok = ok and check.ok
	var result = {"ok":ok,"completed":true,"checks":checks,"scope":"real GDScript compilation/callback and production projection fault reporting; component-level headless probe, not transport or GPU acceptance"}
	if options.has("report"):
		var file=FileAccess.open(options.report,FileAccess.WRITE)
		file.store_string(JSON.stringify(result,"\t"))
	print("PROJECTION_FAULT_PROBE_COMPLETE "+JSON.stringify(result))
	quit(0 if ok else 1)
