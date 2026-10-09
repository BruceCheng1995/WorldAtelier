extends RefCounted
## API 1 compatibility, driven solely by GameRuntime. Native scenes and exported
## properties are authoritative; this does not construct another scene graph.
const Registry = preload("res://atelier_legacy/behavior_registry.gd")
var authority = Registry.new()
var presentation = Registry.new()
var tick_count: int = 0
var error: String = ""
var roots: Dictionary = {}
var object_addresses: Dictionary = {}
var document: Dictionary = {}
var sources: Dictionary = {}
var hashes: Array = []
var scope: Dictionary = {}
var connected_areas: Array = []
var player_snapshots: Array = []

func initialize(scene_root: Node, context: Dictionary = {}) -> String:
	dispose()
	authority = Registry.new()
	presentation = Registry.new()
	scope = context.duplicate(true)
	tick_count = 0
	error = ""
	document = {"scene_revision":str(scope.get("source_revision", "")), "objects":[]}
	_collect(scene_root, [], scene_root)
	if not error.is_empty():
		return error
	error = authority.prepare(document, roots, sources, "authority")
	if not error.is_empty():
		return error
	error = presentation.prepare(document, roots, sources, "presentation", authority.snapshot())
	if not error.is_empty():
		return error
	presentation.apply_states(authority.snapshot())
	presentation.present({"kind":"snapshot", "initial":true, "tick":0})
	presentation.present({"kind":"snapshot", "initial":false, "tick":0})
	# Preserve canonical API1 ordering: initialize events are delivered with
	# the first authority step, after that step's state snapshot.
	hashes = authority.hashes.duplicate()
	return fault()

func _collect(node: Node, instances: Array, scene_root: Node) -> void:
	var chain = instances.duplicate()
	if node.has_meta("wa_instance_id"):
		chain.append(str(node.get_meta("wa_instance_id")))
	if node is Node3D and node.has_meta("wa_node_id"):
		var stable_id = str(node.get_meta("wa_node_id"))
		var address = {"project_id":scope.get("project_id"), "branch_id":scope.get("branch_id"), "resource_id":scope.get("resource_id", scene_root.get_meta("wa_resource_id", "")), "instance_path":chain.duplicate(), "definition_node_id":stable_id}
		var object_id = str(node.get_meta("wa_legacy_object_id", ""))
		if object_id.is_empty():
			object_id = stable_id if chain.is_empty() else "node-" + JSON.stringify([chain, stable_id]).sha256_text()
		# A flat legacy object can appear inside more than one native instance.
		# Definition metadata is not a globally unique runtime object address.
		if not chain.is_empty() and not node.get_meta("wa_legacy_flat_instance", false):
			object_id = "node-" + JSON.stringify([chain, stable_id]).sha256_text()
		node.set_meta("object_id", object_id)
		roots[object_id] = node
		object_addresses[object_id] = address
		var components: Array = []
		for child in node.get_children():
			if child.has_method("legacy_properties") and child.get("source_script") is Script:
				var script: Script = child.source_script
				var digest = str(child.script_hash)
				var source = FileAccess.get_file_as_string(script.resource_path)
				if source.sha256_text() != digest:
					error = "Legacy script SHA-256 mismatch: " + script.resource_path
					return
				sources[digest] = source
				components.append({"id":str(child.behavior_id), "api":1, "script_hash":digest, "properties":child.legacy_properties()})
			if child is Area3D and child.get_meta("wa_component", "") == "trigger":
				var entered = func(body): _body_trigger(object_id, body, true)
				var exited = func(body): _body_trigger(object_id, body, false)
				child.body_entered.connect(entered)
				child.body_exited.connect(exited)
				connected_areas.append({"area":child,"entered":entered,"exited":exited})
		var transform: Transform3D = node.global_transform
		var values = [transform.basis.x.x, transform.basis.x.y, transform.basis.x.z, 0, transform.basis.y.x, transform.basis.y.y, transform.basis.y.z, 0, transform.basis.z.x, transform.basis.z.y, transform.basis.z.z, 0, transform.origin.x, transform.origin.y, transform.origin.z, 1]
		document.objects.append({"id":object_id, "address":address, "source_revision":document.scene_revision, "object_version":str(node.get_meta("wa_source_version", "")), "ancestry_hash":JSON.stringify([chain, values]).sha256_text(), "world_matrix":values, "components":{"behaviors":components}})
	for child in node.get_children():
		# Imported models and component internals are retained engine structure,
		# not additional legacy object roots or instance identity segments.
		if child.get_meta("wa_component", "") != "" or child.get_meta("wa_asset_model", false):
			continue
		_collect(child, chain, scene_root)

func step(delta: float, players: Array = []) -> void:
	if not fault().is_empty():
		return
	tick_count += 1
	player_snapshots = players.duplicate(true)
	authority.update_contexts(players, tick_count)
	authority.tick(delta)
	presentation.update_contexts(players, tick_count)
	presentation.apply_states(authority.snapshot())
	presentation.present({"kind":"snapshot", "initial":false, "tick":tick_count})
	for event in authority.take_events():
		presentation.present(event)

func advance(delta: float) -> void:
	if fault().is_empty():
		presentation.tick(delta)

func snapshot() -> Dictionary:
	return authority.snapshot()

func interact(object_id: String, actor: Dictionary) -> void:
	authority.interact(object_id, actor)

func trigger(object_id: String, actor: Dictionary, entered: bool) -> void:
	authority.trigger(object_id, actor, entered)

func _body_trigger(object_id: String, body: Node3D, entered: bool) -> void:
	var player_id = str(body.get_meta("player_id", ""))
	if player_id.is_empty():
		return
	# The legacy authority only dispatched triggers for registered players.
	# Do not turn an arbitrary authored body into an implicit framework player.
	for actor in player_snapshots:
		if actor.get("id") == player_id:
			trigger(object_id, actor.duplicate(true), entered)
			return

func freeze(value: bool) -> void:
	authority.freeze(value)
	presentation.freeze(value)

func fault() -> String:
	if not error.is_empty():
		return error
	if not authority.fault.is_empty():
		return JSON.stringify(authority.fault)
	if not presentation.fault.is_empty():
		return JSON.stringify(presentation.fault)
	return ""

func dispose() -> void:
	for row in connected_areas:
		if is_instance_valid(row.area):
			row.area.body_entered.disconnect(row.entered)
			row.area.body_exited.disconnect(row.exited)
	connected_areas.clear()
	authority.dispose()
	presentation.dispose()
	roots.clear()
	object_addresses.clear()
	sources.clear()
	hashes.clear()
	player_snapshots.clear()
