extends RefCounted
const Graph = preload("res://hierarchy_scene.gd")
const Loader = preload("res://scene_loader.gd")
const Factory = preload("res://scene_factory.gd")
var host: Node3D
var loader = Loader.new()
var graph: Dictionary = {}
var source_scene: Dictionary = {}
var topology = ""
var previews: Array = []
var pending_local: Dictionary = {}
var preview_object_id = ""
var observation: Dictionary = {}

func setup(value: Node3D) -> void: host=value
func active() -> bool: return not graph.is_empty()
func signature(scene: Dictionary) -> String:
	var values=[]
	for kind in ["objects","mounts"]:
		for row in scene.hierarchy_pack[kind]:values.append([kind,row.id,row.parent,row.get("node",{}).get("kind",""),row.get("node",{}).get("model_hash","")])
	return JSON.stringify(values)

func load_scene(scene: Dictionary, token: int) -> void:
	var next_signature=signature(scene)
	var effective=Graph.effective_document(scene)
	var rebuilding=not active() or next_signature!=topology
	if rebuilding:
		for asset in host.asset_cache.values():loader.asset_cache[asset.hash]=asset
		var candidate=await loader.prepare(host,scene,host.origin)
		if token!=host.generation:
			if candidate.ok:candidate.root.free()
			return
		if not candidate.ok:
			host.emit_error("hierarchy_candidate",candidate.error,scene.seq)
			return
		var previous=host.scene_root
		host.scene_root=candidate.root
		host.add_child(host.scene_root)
		host.remove_child(previous)
		previous.queue_free()
		host.objects=candidate.objects
		graph=candidate.graph
		host.active_assets=candidate.assets
		for asset in loader.asset_cache.values():host.asset_cache[asset.hash]=asset
		while host.asset_cache.size()>32:host.asset_cache.erase(host.asset_cache.keys()[0])
		for row in effective.objects:
			if row.get("kind")=="anchor" and not row.has("model_hash"):host.create_anchor(host.objects[row.id])
	else:
		for row in effective.objects:
			if not row.has("model_hash"):continue
			var asset=loader.asset_cache.get(row.model_hash,host.asset_cache.get(row.model_hash,{}))
			# A model still held by the scene may have been evicted from the
			# bounded prototype cache; measure its private owned geometry.
			var bounds: AABB=asset.get("bounds",AABB())
			if asset.is_empty():
				var node: Node3D=host.objects[row.id]
				var inverse=node.global_transform.affine_inverse()
				var first=true
				for mesh in Graph.owned_meshes(node):
					var b: AABB=inverse*mesh.global_transform*mesh.get_aabb()
					bounds=b if first else bounds.merge(b);first=false
			var error=Graph.geometry_error(row,bounds)
			if not error.is_empty():host.emit_error("hierarchy_candidate",error,scene.seq,row.id);return
		graph.rows={}
		for kind in ["object","mount"]:
			for row in scene.hierarchy_pack.objects if kind=="object" else scene.hierarchy_pack.mounts:
				var key=kind+":"+row.id
				graph.rows[key]=row
				graph.nodes[key].set_meta("canonical_local",Graph.transform(Graph.matrix_from_trs(row.local_transform)))
		Graph.restore(graph)
	host.definitions={}
	for row in effective.objects:host.definitions[row.id]=row
	for asset in host.active_assets:Graph.add_identity(asset,host.definitions[asset.id])
	source_scene=scene.duplicate(true)
	topology=next_signature
	pending_local.clear();previews.clear()
	preview_object_id=str(scene.get("preview_object_id","")) if host.mode=="object" else ""
	observation={}
	var requested=scene.get("preview_observation")
	if requested is Dictionary and matches(requested) and Graph.valid_matrix(requested.get("world_matrix")):
		observation=requested.duplicate(true)
	apply_overrides()
	apply_visibility()
	host.model_signature="hierarchy:"+topology
	host.finish_scene(scene,rebuilding)

func clear() -> void:
	graph={};source_scene={};topology="";previews.clear();pending_local.clear();preview_object_id="";observation={}

func matches(value: Dictionary) -> bool:
	var id=value.get("id","")
	if not host.objects.has(id) or not host.definitions.has(id):return false
	var row: Dictionary=host.definitions[id]
	return Graph.address_equal(value.get("address"),row.address) and value.get("expected_object_version",value.get("object_version",value.get("version","")))==row.object_version and value.get("expected_ancestry_hash",value.get("ancestry_hash",row.ancestry_hash))==row.ancestry_hash

func receive_preview(packet: Dictionary) -> void:
	if not active() or not host.current_command(packet) or packet.get("source_revision")!=source_scene.scene_revision or host.world_client.mode!="editing" or not packet.get("previews") is Array:return
	if packet.previews.size()>1000:return
	var next=[]
	for value in packet.previews:
		if not value is Dictionary or not matches(value) or not Graph.valid_matrix(value.get("world_matrix")):return
		var expiry=value.get("expires_at",0)
		if not (expiry is int or expiry is float) or not is_finite(float(expiry)):return
		var copy=value.duplicate(true)
		copy.local_deadline=Time.get_ticks_msec()+10000
		next.append(copy)
	host.cancel_drag()
	if packet.get("reset_local",false)==true:pending_local.clear()
	previews=next
	apply_overrides()
	host.refresh_bounds();host.update_helpers()

func apply_overrides() -> void:
	if not active():return
	Graph.restore(graph)
	var overrides=pending_local.duplicate()
	if not observation.is_empty():overrides[observation.id]=Graph.transform(observation.world_matrix)
	for value in previews:overrides[value.id]=Graph.transform(value.world_matrix)
	# Ancestors first makes multiple concurrent world-space observations stable.
	for ref in source_scene.hierarchy_pack.assembly_order:
		if ref.kind=="object" and overrides.has(ref.id):host.objects[ref.id].global_transform=overrides[ref.id]

func advance() -> void:
	var keep=[]
	var now=Time.get_ticks_msec()
	var wall=Time.get_unix_time_from_system()*1000
	for value in previews:
		if now<value.local_deadline and (value.expires_at==0 or wall<float(value.expires_at)):keep.append(value)
	if keep.size()!=previews.size():
		previews=keep
		if host.drag_handle.is_empty():apply_overrides();host.refresh_bounds();host.update_helpers()

func record_commit(id: String) -> void:
	pending_local[id]=host.objects[id].global_transform

func apply_visibility() -> void:
	for id in host.objects:
		var node: Node3D=host.objects[id]
		var visible=preview_object_id.is_empty() or id==preview_object_id or (host.objects.has(preview_object_id) and host.objects[preview_object_id].is_ancestor_of(node))
		# Keep structural ancestors visible; hide only their model/helper children.
		for child in node.get_children():
			if child is Node3D and not child.has_meta("hierarchy_ref"):child.visible=visible

func shown(id: String) -> bool:
	return preview_object_id.is_empty() or id==preview_object_id or (host.objects.has(preview_object_id) and host.objects[preview_object_id].is_ancestor_of(host.objects[id]))

func begin_source_drag() -> bool:
	# Another user's transient pose is an observation, never a new source base.
	# A locally committed pose waits for the canonical scene ACK before another
	# transaction may reuse its version token.
	if not pending_local.is_empty():return false
	previews.clear()
	apply_overrides()
	return true
