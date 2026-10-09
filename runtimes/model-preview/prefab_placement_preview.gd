extends RefCounted
## Ephemeral visual sibling of the authored scene. Never register it as content.
const TIMEOUT_MS = 10000
var ghost: Node
var mount: Node
var drag_id = ""
var prefab_path = ""
var context: Dictionary = {}
var retired: Dictionary = {}
var last_move_ms = 0

func editing(host: Node) -> bool:
	return host.native_active and host.mode == "main" and host.editable and host.world_client != null and host.world_client.mode == "editing" and host.applied_seq >= 0 and host.applied_seq == host.requested_seq

func current(host: Node) -> Dictionary:
	var result = host.placement_source().duplicate()
	result.merge({"seq":host.applied_seq,"document_id":host.document_id})
	return result

func reply(host: Node, id: String, status: String, extra: Dictionary = {}) -> void:
	var result = current(host)
	result.merge({"type":"prefab_drag","drag_id":id,"status":status})
	result.merge(extra)
	host.emit(result)

func clear(host: Node, id: String = "") -> void:
	if id == "": id = drag_id
	if id == "": return
	retired[id] = true
	if id == drag_id:
		if is_instance_valid(mount):
			if mount.get_parent() != null: mount.get_parent().remove_child(mount)
			mount.free()
		elif is_instance_valid(ghost): ghost.free()
		ghost = null
		mount = null
		drag_id = ""
		prefab_path = ""
		context = {}
		reply(host,id,"cleared")

func advance(host: Node) -> void:
	if drag_id != "" and (not editing(host) or context != current(host) or Time.get_ticks_msec()-last_move_ms > TIMEOUT_MS): clear(host)

func invalid(host: Node, id: String, reason: String) -> void:
	# An invalid location is recoverable during the same drag. Only terminal
	# clear/lifecycle expiry retires its id; leaving the viewport merely hides it.
	if id == drag_id and (ghost is Node3D or ghost is CanvasItem): ghost.visible = false
	reply(host,id,"invalid",{"error":reason})

func receive(host: Node, packet: Dictionary) -> void:
	var id = packet.get("drag_id")
	if not id is String or id.is_empty() or id.length() > 256: return
	# Retire even an unseen id: a late move after clear must never resurrect it.
	if packet.get("phase") == "clear":
		var was_active = id == drag_id
		clear(host,id)
		if not was_active: reply(host,id,"cleared")
		return
	advance(host)
	if packet.get("phase") == "hide":
		if id == drag_id:
			if ghost is Node3D or ghost is CanvasItem: ghost.visible = false
			last_move_ms = Time.get_ticks_msec()
		return
	if packet.get("phase") != "move" or retired.has(id):
		reply(host,id,"invalid",{"error":"retired_prefab_drag"})
		return
	if not editing(host) or not host.current_command(packet):
		invalid(host,id,"stale_prefab_drag")
		return
	for key in current(host):
		if packet.get(key) != current(host)[key]:
			invalid(host,id,"stale_prefab_drag")
			return
	var screen = packet.get("screen")
	if not screen is Array or screen.size() != 2:
		invalid(host,id,"invalid_prefab_screen")
		return
	for value in screen:
		if not (value is float or value is int) or not is_finite(float(value)) or value < 0 or value > 1:
			invalid(host,id,"invalid_prefab_screen")
			return
	var path = packet.get("prefab_path")
	var mapping = host.native_config.get("preview_scenes",{})
	if host.get("native_content_scenes") is Dictionary and not host.native_content_scenes.is_empty(): mapping=host.native_content_scenes
	if not path is String or not path.begins_with("res://") or not mapping is Dictionary or not mapping.has(path):
		invalid(host,id,"unavailable_prefab")
		return
	var size = host.get_viewport().get_visible_rect().size
	if not size.is_finite() or size.x <= 0 or size.y <= 0:
		invalid(host,id,"invalid_prefab_viewport")
		return
	var placement = host.placement_at(Vector2(screen[0],screen[1])*size)
	if placement.has("error"):
		invalid(host,id,str(placement.error))
		return
	if drag_id != id:
		clear(host)
		var mapped = mapping[path]
		if mapped is Dictionary: mapped = mapped.get("path","")
		if not mapped is PackedScene and (not mapped is String or not mapped.begins_with("res://") or not ResourceLoader.exists(mapped,"PackedScene")):
			invalid(host,id,"unavailable_prefab")
			return
		# Only the server's baked derivative is loadable. Validate before instantiate
		# (checking Node scripts afterwards would be too late for _init()).
		var packed = mapped if mapped is PackedScene else ResourceLoader.load(mapped,"PackedScene",ResourceLoader.CACHE_MODE_IGNORE_DEEP)
		if not packed is PackedScene or not safe_resource(packed,{}):
			invalid(host,id,"unsafe_prefab_preview")
			return
		var candidate: Node = packed.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED)
		if candidate == null:
			invalid(host,id,"unavailable_prefab")
			return
		if candidate is Control and host.authored_root is Container:
			candidate.free()
			invalid(host,id,"container_managed_layout")
			return
		if candidate is Node3D and host.canvas_mode or (candidate is Node2D or candidate is Control) and not host.canvas_mode:
			candidate.free()
			invalid(host,id,"prefab_dimension_mismatch")
			return
		ghost = candidate
		drag_id = id
		prefab_path = path
		context = current(host)
		if excluded(ghost) or not (ghost is Node3D or ghost is Node2D or ghost is Control):
			# Non-spatial roots are represented by the frontend's name/icon only.
			ghost.free()
			ghost = null
		else:
			sanitize(ghost)
			var parent = make_parent(host)
			parent.add_child(ghost)
	elif prefab_path != path:
		invalid(host,id,"prefab_changed_during_drag")
		return
	last_move_ms = Time.get_ticks_msec()
	if ghost is Node3D or ghost is CanvasItem: ghost.visible = true
	var p: Array = placement.position
	if ghost is Node3D: ghost.global_position = Vector3(p[0],p[1],p[2])
	elif ghost is Control:
		# Match adapter._place_instance: a rotated/scaled pivot offsets the
		# transform origin from Control.global_position (its layout rectangle).
		ghost.global_position += Vector2(p[0],p[1]) - ghost.get_global_transform().origin
	elif ghost is Node2D: ghost.global_position = Vector2(p[0],p[1])
	reply(host,id,"ready",{"position":p,"dimension":placement.dimension,"shape":"3d" if ghost is Node3D else "2d" if ghost is CanvasItem else "none"})

func make_parent(host: Node) -> Node:
	# Drop instantiates under the destination scene root. Mirror that parent's
	# native inheritance outside the authored tree, preserving shear and letting
	# Godot implement top_level instead of baking transforms into prefab bases.
	var destination: Node = host.authored_root
	if destination is Node3D:
		mount = Node3D.new()
		host.add_child(mount)
		mount.global_transform = destination.global_transform
	elif destination is CanvasItem:
		mount = Node2D.new()
		host.add_child(mount)
		mount.global_transform = destination.get_global_transform()
		if destination is Control:
			var area = Control.new()
			area.size = destination.size
			area.mouse_filter = Control.MOUSE_FILTER_IGNORE
			mount.add_child(area)
			return area
	else:
		mount = Node.new()
		host.add_child(mount)
	return mount

func safe_resource(value: Variant, seen: Dictionary) -> bool:
	if value is Script: return false
	if value is Resource:
		if seen.has(value.get_instance_id()): return true
		seen[value.get_instance_id()] = true
		if value.get_script() != null: return false
		if value is PackedScene:
			var state = value.get_state()
			for index in state.get_node_count():
				if not safe_resource(state.get_node_instance(index),seen): return false
				for property in state.get_node_property_count(index):
					if not safe_resource(state.get_node_property_value(index,property),seen): return false
			return true
		for property in value.get_property_list():
			if int(property.usage) & PROPERTY_USAGE_STORAGE and not safe_resource(value.get(property.name),seen): return false
	elif value is Array:
		for item in value:
			if not safe_resource(item,seen): return false
	elif value is Dictionary:
		for key in value:
			if not safe_resource(key,seen) or not safe_resource(value[key],seen): return false
	return true

func excluded(node: Node) -> bool:
	return node is Camera3D or node is Camera2D or node is WorldEnvironment or node is Light3D or node is Light2D or node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D or node is VideoStreamPlayer or node is Viewport or node is CanvasLayer or node is NavigationRegion3D or node is NavigationRegion2D or node is GPUParticles3D or node is GPUParticles2D or node is CPUParticles3D or node is CPUParticles2D

func sanitize(node: Node, tinted: bool = false) -> void:
	node.process_mode = Node.PROCESS_MODE_DISABLED
	for signal_info in node.get_signal_list():
		for connection in node.get_signal_connection_list(signal_info.name): node.disconnect(signal_info.name,connection.callable)
	if node is CollisionObject3D or node is CollisionObject2D:
		node.collision_layer = 0
		node.collision_mask = 0
		if node is CollisionObject3D: node.disable_mode = CollisionObject3D.DISABLE_MODE_REMOVE
		else: node.disable_mode = CollisionObject2D.DISABLE_MODE_REMOVE
	if node is RigidBody3D or node is RigidBody2D: node.freeze = true
	if node is Area3D or node is Area2D:
		node.monitoring = false
		node.monitorable = false
	if node is AnimationPlayer: node.autoplay = ""
	if node is AnimationTree: node.active = false
	if node is Timer: node.autostart = false
	if node is AnimatedSprite2D or node is AnimatedSprite3D: node.pause()
	if node is SpriteBase3D:
		node.modulate = Color(.78,.65,1,.48)
		node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	if node is MeshInstance3D:
		var material = StandardMaterial3D.new()
		material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		material.albedo_color = Color(.72,.58,1,.48)
		node.material_override = material
		node.material_overlay = null
		node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	if node is CanvasItem and not tinted:
		node.modulate = Color(.78,.65,1,.48)
		tinted = true
	if node is Control:
		node.mouse_filter = Control.MOUSE_FILTER_IGNORE
		node.focus_mode = Control.FOCUS_NONE
	for child in node.get_children():
		# These nodes can alter the host world/viewport merely by entering the tree.
		if excluded(child):
			node.remove_child(child)
			child.free()
		else: sanitize(child,tinted)
