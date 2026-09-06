extends Node3D
const Assets = preload("res://scripts/live_assets.gd")
var prepared_assets: Dictionary = {}

var game_root: Node
var camera: Camera3D
var terrain: Node3D
var actors: Node3D
var effects: Node3D
var objects: Dictionary = {}
var player_nodes: Dictionary = {}
var enemy_nodes: Dictionary = {}
var task_nodes: Dictionary = {}
var content: Dictionary = {}
var state: Dictionary = {}
var materials: Dictionary = {}
var time = 0.0
var last_event = 0
var selected = ""
var selection: Node3D
var camera_target = Vector3(0, 0, 6)
var outline_shader: Shader
var floor_shader: Shader
var hazard_material: ShaderMaterial
var effects_live: Array = []
var screen_shake = 0.0

func _ready() -> void:
	var environment = WorldEnvironment.new()
	var env = Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color("#0b1728")
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color("#90b8dc")
	env.ambient_light_energy = .36
	env.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	env.fog_enabled = true
	env.fog_light_color = Color("#172d42")
	env.fog_density = .0025
	environment.environment = env
	add_child(environment)
	var sunlight = DirectionalLight3D.new()
	sunlight.rotation_degrees = Vector3(-53, -31, 0)
	sunlight.light_color = Color("#ffedc9")
	sunlight.light_energy = .82
	sunlight.shadow_enabled = true
	sunlight.directional_shadow_max_distance = 105
	add_child(sunlight)
	var fill = DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(-25, 145, 0)
	fill.light_color = Color("#66a5cf")
	fill.light_energy = .24
	add_child(fill)
	camera = Camera3D.new()
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.size = 27
	camera.far = 280
	add_child(camera)
	camera.current = true
	actors = Node3D.new()
	add_child(actors)
	effects = Node3D.new()
	add_child(effects)
	var hazard_shader = Shader.new()
	hazard_shader.code = "shader_type spatial; render_mode unshaded; void fragment(){float stripe=step(0.5,fract((UV.x+UV.y*0.6)*5.0));ALBEDO=mix(vec3(0.01,0.015,0.025),vec3(1.0,0.68,0.025),stripe);}"
	hazard_material = ShaderMaterial.new()
	hazard_material.shader = hazard_shader
	floor_shader = Shader.new()
	floor_shader.code = "shader_type spatial; uniform vec4 stone_color : source_color; uniform float grid_strength = 0.16; varying vec3 world_pos; void vertex(){world_pos=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;} void fragment(){vec2 p=world_pos.xz*0.48;vec2 cell=abs(fract(p)-0.5);float grout=smoothstep(0.475,0.495,max(cell.x,cell.y));float variety=sin(floor(p.x)*13.4+floor(p.y)*41.7)*0.045;ALBEDO=stone_color.rgb*(0.95+variety)*(1.0-grout*grid_strength);ROUGHNESS=0.94;}"
	outline_shader = Shader.new()
	outline_shader.code = "shader_type spatial; render_mode unshaded,cull_front; uniform vec4 line_color : source_color = vec4(0.3,1.0,1.0,1.0); void vertex(){VERTEX += NORMAL * 0.035;} void fragment(){ALBEDO=line_color.rgb;EMISSION=line_color.rgb*0.8;}"

func mat(color: Color, emission: float = 0.0, metal: float = 0.0) -> StandardMaterial3D:
	var key = color.to_html() + str(emission) + str(metal)
	if materials.has(key):
		return materials[key]
	var material = StandardMaterial3D.new()
	material.albedo_color = color
	material.roughness = .78 - metal * .35
	material.metallic = metal
	if emission > 0:
		material.emission_enabled = true
		material.emission = color
		material.emission_energy_multiplier = emission
	if color.a < 1:
		material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	materials[key] = material
	return material

func mesh_node(parent: Node3D, mesh: Mesh, pos: Vector3, color: Color, emission: float = 0.0, metal: float = 0.0) -> MeshInstance3D:
	var node = MeshInstance3D.new()
	node.mesh = mesh
	node.position = pos
	node.material_override = mat(color, emission, metal)
	parent.add_child(node)
	return node

func box(parent: Node3D, pos: Vector3, size: Vector3, color: Color, emission: float = 0.0) -> MeshInstance3D:
	var mesh = BoxMesh.new()
	mesh.size = size
	return mesh_node(parent, mesh, pos, color, emission)

func cylinder(parent: Node3D, pos: Vector3, radius: float, height: float, color: Color, top: float = -1, segments: int = 12, emission: float = 0.0) -> MeshInstance3D:
	var mesh = CylinderMesh.new()
	mesh.bottom_radius = radius
	mesh.top_radius = radius if top < 0 else top
	mesh.height = height
	mesh.radial_segments = segments
	mesh.rings = 1
	return mesh_node(parent, mesh, pos, color, emission)

func orb(parent: Node3D, pos: Vector3, radius: float, color: Color, emission: float = 0.0) -> MeshInstance3D:
	var mesh = SphereMesh.new()
	mesh.radius = radius
	mesh.height = radius * 2
	mesh.radial_segments = 12
	mesh.rings = 5
	return mesh_node(parent, mesh, pos, color, emission)

func ring(parent: Node3D, pos: Vector3, radius: float, color: Color, thickness: float = .055) -> MeshInstance3D:
	var mesh = TorusMesh.new()
	mesh.inner_radius = radius - thickness
	mesh.outer_radius = radius + thickness
	mesh.rings = 40
	mesh.ring_segments = 6
	return mesh_node(parent, mesh, pos, color, 1)

func crystal(parent: Node3D, pos: Vector3, size: float, color: Color) -> Node3D:
	var root = Node3D.new()
	parent.add_child(root)
	root.position = pos
	cylinder(root, Vector3(0, size * .37, 0), size * .38, size * .75, color, 0, 5, .5)
	cylinder(root, Vector3(0, -size * .16, 0), 0, size * .32, color.darkened(.2), size * .38, 5, .2)
	return root

func label(parent: Node3D, text: String, pos: Vector3, color: Color, font_size: int = 28) -> Label3D:
	var node = Label3D.new()
	node.text = text
	node.font = load("res://assets/fonts/AtelierUI.tres")
	node.position = pos
	node.font_size = font_size * 2
	node.pixel_size = .009
	node.modulate = color
	node.outline_modulate = Color("#081724")
	node.outline_size = 4
	node.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	node.no_depth_test = true
	parent.add_child(node)
	return node

func build_world(candidate: Dictionary) -> String:
	var prepared = Assets.prepare(candidate)
	if not prepared.ok:
		return prepared.error
	prepared_assets = prepared.scenes
	content = candidate
	selected = ""
	if is_instance_valid(selection):
		selection.queue_free()
	selection = null
	if is_instance_valid(terrain):
		terrain.queue_free()
	terrain = Node3D.new()
	add_child(terrain)
	objects.clear()
	for node in task_nodes.values():
		node.queue_free()
	task_nodes.clear()
	for zone in content.zones:
		build_island(zone)
	for object in content.objects:
		build_object(object)
	# Suspended celestial debris creates depth below the four connected islands.
	var random = RandomNumberGenerator.new()
	random.seed = 92882
	for i in range(40):
		var root = Node3D.new()
		terrain.add_child(root)
		root.position = Vector3(random.randf_range(-95, 95), random.randf_range(-24, -10), random.randf_range(-100, 40))
		root.rotation = Vector3(random.randf(), random.randf(), random.randf())
		cylinder(root, Vector3.ZERO, random.randf_range(1, 4), random.randf_range(2, 7), Color("#25394d"), 0, 5)
	var title_anchor = Node3D.new()
	terrain.add_child(title_anchor)
	label(title_anchor, "S T A R P O R T", Vector3(0, .2, 20), Color("#a6d5d5"), 25)
	return ""

func build_island(zone: Dictionary) -> void:
	var root = Node3D.new()
	terrain.add_child(root)
	root.position = Vector3(zone.x, -.25, zone.z)
	var color = Color(zone.color)
	cylinder(root, Vector3(0, -4.7, 0), zone.radius * .60, 8.5, color.darkened(.62), zone.radius, 18)
	cylinder(root, Vector3(0, -.8, 0), zone.radius, 1.3, color.darkened(.24), zone.radius * .99, 56)
	var floor_mesh = cylinder(root, Vector3(0, -.06, 0), zone.radius * .99, .25, color, -1, 64)
	var floor_material = ShaderMaterial.new()
	floor_material.shader = floor_shader
	floor_material.set_shader_parameter("stone_color", color)
	floor_material.set_shader_parameter("grid_strength", .17 if zone.id in ["observatory", "citadel"] else .035)
	floor_mesh.material_override = floor_material
	ring(root, Vector3(0, .09, 0), zone.radius - .6, color.lightened(.25), .07)
	# Concentric inlaid architecture and radial pathway wedges.
	for rr in [6.0, 12.0]:
		ring(root, Vector3(0, .095, 0), rr, color.lightened(.13), .075)
	for i in range(12):
		var a = i * TAU / 12
		var tile = box(root, Vector3(cos(a) * 16, .08, sin(a) * 16), Vector3(2.0, .09, .62), color.lightened(.15))
		tile.rotation.y = -a
	# Dark green/gold rim facets and underside crystal veins.
	for i in range(16):
		var a = i * TAU / 16
		var vein = crystal(root, Vector3(cos(a) * (zone.radius - 2), -2.6, sin(a) * (zone.radius - 2)), 1.3, color.lightened(.3))
		vein.rotation.z = PI

func build_object(object: Dictionary) -> void:
	var root = Node3D.new()
	terrain.add_child(root)
	root.position = Vector3(object.x, 0, object.z)
	root.rotation.y = object.get("rotation", 0)
	root.scale = Vector3.ONE * object.get("scale", 1)
	root.set_meta("definition", object)
	objects[object.id] = root
	var color = Color(object.get("color", "#72dad2"))
	if object.has("model_asset") and prepared_assets.has(object.model_asset):
		var model = prepared_assets[object.model_asset].instantiate()
		root.add_child(model)
		model.name = "ContentModel"
		return
	match object.kind:
		"bridge":
			box(root, Vector3(0, -.25, 0), Vector3(object.length, .45, object.width), Color("#416369"))
			for zz in [-object.width / 2 + .25, object.width / 2 - .25]:
				box(root, Vector3(0, .12, zz), Vector3(object.length, .28, .24), Color("#8ea8a4"))
				box(root, Vector3(0, .32, zz), Vector3(object.length, .045, .06), Color("#68e5df"), .8)
			for i in range(int(object.length / 2)):
				box(root, Vector3(-object.length / 2 + i * 2 + 1, .01, 0), Vector3(.07, .02, object.width - .5), Color("#78938e"))
		"tree":
			cylinder(root, Vector3(0, 1, 0), .26, 2, Color("#534e48"), .17, 6)
			for i in range(3):
				var leaf = cylinder(root, Vector3(0, 1.9 + i * .65, 0), 1.7 - i * .32, 1.7, color.lightened(i * .045), .05, 6)
				leaf.rotation.y = i * .7
		"rock":
			var rock = cylinder(root, Vector3(0, .55, 0), 1.0, 1.5, color, .55, 5)
			rock.rotation = Vector3(.12, .2, .08)
			crystal(root, Vector3(.35, 1.1, -.1), 1, Color("#ffc16a"))
		"pillar":
			cylinder(root, Vector3(0, .18, 0), .8, .35, color.darkened(.2), -1, 6)
			cylinder(root, Vector3(0, 1.4, 0), .43, 2.4, color, .35, 6)
			cylinder(root, Vector3(0, 2.6, 0), .6, .22, color.lightened(.1), -1, 6)
			crystal(root, Vector3(0, 2.95, 0), .55, Color("#b3e9fb"))
		"crystal":
			ring(root, Vector3(0, .1, 0), .5, color.darkened(.35), .02)
			var gem = crystal(root, Vector3(0, .75, 0), 1.1, color)
			gem.name = "Float"
		"beacon":
			cylinder(root, Vector3(0, .18, 0), 1.8, .35, Color("#293e51"), -1, 8)
			cylinder(root, Vector3(0, .48, 0), 1.15, .35, Color("#879fad"), 1.0, 8)
			for i in range(3):
				var a = i * TAU / 3
				var prong = box(root, Vector3(cos(a) * .8, 1.3, sin(a) * .8), Vector3(.25, 1.6, .25), Color("#b9c9c4"))
				prong.rotation.z = .18
			var core = crystal(root, Vector3(0, 1.65, 0), 1.6, color)
			core.name = "Float"
			ring(root, Vector3(0, .09, 0), 2.1, color, .07)
			var beam = cylinder(root, Vector3(0, 6, 0), .24, 11, Color(color, .16), -1, 12, 1)
			beam.name = "BeaconBeam"
			beam.visible = false
			label(root, "LINK BEACON  [E]", Vector3(0, 3.3, 0), Color("#b4f5eb"), 23)
		"forge", "furnace":
			cylinder(root, Vector3(0, .35, 0), 1.5, .7, Color("#3a3949"), 1.3, 8)
			cylinder(root, Vector3(0, .9, 0), 1, .45, Color("#9b674d"), -1, 8)
			cylinder(root, Vector3(0, 1.18, 0), .7, .1, Color("#ffd08a"), -1, 12, 1.4)
			if object.kind == "forge":
				box(root, Vector3(0, 1.45, 0), Vector3(1.4, .35, .65), Color("#d3ada0"))
				label(root, "ATTUNE WEAPON  [Q]", Vector3(0, 2.6, 0), Color("#ffd9a2"), 21)
			else:
				for i in range(4):
					var a = i * PI / 2
					cylinder(root, Vector3(cos(a), 2, sin(a)), .18, 2.4, Color("#565366"), -1, 6)
				crystal(root, Vector3(0, 2, 0), 1.6, color)
		"supply":
			box(root, Vector3(0, .4, 0), Vector3(1.5, .8, 1.1), Color("#496b68"))
			box(root, Vector3(0, .85, 0), Vector3(1.6, .15, 1.2), Color("#b6d5bf"))
			box(root, Vector3(0, .95, 0), Vector3(.65, .04, .2), Color("#7effb8"), 1)
			box(root, Vector3(0, .96, 0), Vector3(.2, .04, .65), Color("#7effb8"), 1)
			label(root, "RESTORE  [E]", Vector3(0, 1.9, 0), Color("#bcf4cd"), 21)
		"monument":
			cylinder(root, Vector3(0, .22, 0), 2, .45, Color("#354756"), -1, 8)
			cylinder(root, Vector3(0, .62, 0), 1.5, .4, Color("#748b92"), 1.4, 8)
			var core = crystal(root, Vector3(0, 2, 0), 2.2, color)
			core.name = "Float"
			var orbit = ring(root, Vector3(0, 2, 0), 1.6, color, .065)
			orbit.rotation.z = .48
			orbit.name = "Orbit"
		"gate", "arch":
			for x in [-2.2, 2.2]:
				box(root, Vector3(x, 1.9, 0), Vector3(.8, 3.8, .8), color)
				box(root, Vector3(x, .25, 0), Vector3(1.2, .5, 1.2), color.darkened(.3))
			box(root, Vector3(0, 3.9, 0), Vector3(5.2, .75, 1), color)
			if object.kind == "gate":
				var screen = box(root, Vector3(0, 1.8, 0), Vector3(3.8, 3.6, .07), Color(.55, .42, .86, .35), .5)
				screen.name = "GateScreen"
				label(root, "ASTRAL CITADEL · 3 BEACONS", Vector3(0, 5, 0), Color("#d7caff"), 23)
		"flower":
			for i in range(7):
				var a = i * TAU / 7
				var petal = orb(root, Vector3(cos(a) * .75, .65, sin(a) * .75), .55, color)
				petal.scale = Vector3(.65, .25, 1)
				petal.rotation.y = -a
			crystal(root, Vector3(0, .85, 0), .7, Color("#e4fbbb"))
		"lamp":
			cylinder(root, Vector3(0, .2, 0), .28, .4, Color("#243e4a"), -1, 6)
			orb(root, Vector3(0, .5, 0), .23, Color("#aededa"), .7)
		"platform":
			cylinder(root, Vector3(0, -.05, 0), 2.5, .5, color, -1, 8)

func actor(player: bool, kind: String, color: Color) -> Node3D:
	var root = Node3D.new()
	actors.add_child(root)
	if player and ResourceLoader.exists("res://assets/explorer.glb"):
		var packed = load("res://assets/explorer.glb")
		var avatar = packed.instantiate()
		avatar.name = "Avatar"
		avatar.rotation.y = PI
		root.add_child(avatar)
		ring(root, Vector3(0, .08, 0), .72, color, .04)
		label(root, "EXPLORER", Vector3(0, 2.9, 0), Color("#e5f6ec"), 22).name = "NameLabel"
		var animations = avatar.find_children("*", "AnimationPlayer", true, false)
		if not animations.is_empty():
			root.set_meta("animation_player", animations[0])
			for animation_name in animations[0].get_animation_list():
				if str(animation_name) in ["Idle", "Walk"]:
					animations[0].get_animation(animation_name).loop_mode = Animation.LOOP_LINEAR
		return root
	if player:
		cylinder(root, Vector3(0, .06, 0), .7, .06, Color(.06, .13, .2, .5), -1, 16)
		ring(root, Vector3(0, .08, 0), .74, color, .045)
		var body = Node3D.new()
		body.name = "Body"
		root.add_child(body)
		box(body, Vector3(0, 1.2, 0), Vector3(.7, .83, .45), Color("#2c4654"))
		box(body, Vector3(0, 1.3, -.25), Vector3(.54, .5, .12), color)
		box(body, Vector3(0, 1.05, .26), Vector3(.7, .9, .13), Color("#ceaf8a"))
		box(body, Vector3(0, .85, 0), Vector3(.8, .16, .6), Color("#eee0b9"))
		orb(body, Vector3(0, 1.94, 0), .42, Color("#e1dfcf"))
		box(body, Vector3(0, 1.96, -.34), Vector3(.57, .22, .17), Color("#183d4c"))
		box(body, Vector3(0, 1.98, -.44), Vector3(.35, .045, .035), color, 1)
		for x in [-.52, .52]:
			orb(body, Vector3(x, 1.5, 0), .22, color)
			cylinder(body, Vector3(x, 1.12, -.05), .11, .62, Color("#e4d6bc"), -1, 6)
			var leg = box(root, Vector3(x * .45, .48, 0), Vector3(.25, .68, .28), Color("#263d4c"))
			leg.name = "LeftLeg" if x < 0 else "RightLeg"
			box(root, Vector3(x * .45, .15, -.10), Vector3(.3, .2, .46), Color("#d3c6a9"))
		var weapon = Node3D.new()
		weapon.name = "Weapon"
		body.add_child(weapon)
		weapon.position = Vector3(.64, 1.05, -.12)
		weapon.rotation.z = -.22
		cylinder(weapon, Vector3(0, .35, 0), .06, 2.1, Color("#b29c75"), -1, 6)
		crystal(weapon, Vector3(0, 1.5, 0), .7, color)
		label(root, "EXPLORER", Vector3(0, 2.9, 0), Color("#e5f6ec"), 22).name = "NameLabel"
	else:
		var size = {"sentinel": 1.0, "stalker": .72, "artillerist": .88, "brute": 1.42, "boss": 2.9}.get(kind, 1)
		root.scale = Vector3.ONE * size
		cylinder(root, Vector3(0, .1, 0), .75, .1, Color("#263345"), -1, 8)
		var body = Node3D.new()
		body.name = "Body"
		root.add_child(body)
		cylinder(body, Vector3(0, 1.0, 0), .65, 1.3, color.darkened(.28), .4, 6)
		orb(body, Vector3(0, 1.75, 0), .5, color)
		box(body, Vector3(0, 1.73, -.44), Vector3(.7, .15, .1), Color("#ffc998"), 1.3)
		crystal(body, Vector3(0, 1, -.55), .45, Color("#ffd898"))
		for sign_x in [-1, 1]:
			var shoulder = cylinder(body, Vector3(sign_x * .75, 1.25, 0), .3, .9, color, .2, 5)
			shoulder.rotation.z = sign_x * .35
			box(root, Vector3(sign_x * .3, .4, 0), Vector3(.3, .65, .4), color.darkened(.2))
		if kind in ["boss", "brute"]:
			for i in range(5):
				var spike = crystal(body, Vector3((i - 2) * .25, 2.15, .05), .8 - abs(i - 2) * .1, Color("#efb479"))
				spike.rotation.z = (i - 2) * -.17
		if kind == "artillerist":
			ring(body, Vector3(0, 2, 0), .75, Color("#ff9d93"), .05)
		var hp = box(root, Vector3(0, 2.6, 0), Vector3(1.1, .09, .06), Color("#ffb092"), .5)
		hp.name = "Health"
	return root

func update_world(new_state: Dictionary, local_user: String, delta: float) -> void:
	state = new_state
	time += delta
	var players = state.get("players", {})
	for id in players:
		var player = players[id]
		if not player_nodes.has(id):
			player_nodes[id] = actor(true, "", Color("#8cfff0") if id == local_user else Color("#e3bdff"))
		var node = player_nodes[id]
		if not player.get("online", false):
			node.visible = false
			continue
		var desired = Vector3(player.x, 0, player.z)
		var distance = node.position.distance_to(desired)
		if distance > 16:
			node.position = desired
		else:
			node.position = node.position.lerp(desired, minf(1, delta * 14))
		node.visible = player.hp > 0 or sin(time * 10) > 0
		var facing = Vector2(player.get("facing_x", 0), player.get("facing_z", -1))
		node.rotation.y = lerp_angle(node.rotation.y, atan2(-facing.x, -facing.y), delta * 15)
		var motion = clampf(distance * 5, 0, 1)
		var attacking = float(player.get("attack_until", 0)) > float(state.get("world_time", 0))
		if node.has_meta("animation_player"):
			var anim = node.get_meta("animation_player")
			var clip = "Walk" if motion > .13 else "Idle"
			if float(player.get("dash_until", 0)) > float(state.get("world_time", 0)):
				clip = "Dash"
			elif attacking:
				clip = "Strike"
			if anim.current_animation != clip and anim.has_animation(clip):
				anim.play(clip, .10)
		else:
			node.get_node("Body").position.y = sin(time * 14) * .07 * motion
			node.get_node("LeftLeg").rotation.x = sin(time * 14) * .45 * motion
			node.get_node("RightLeg").rotation.x = -sin(time * 14) * .45 * motion
			node.get_node("Body/Weapon").rotation.x = -.9 + sin(time * 28) * .8 if attacking else .08
		node.get_node("NameLabel").text = str(player.get("name", "Explorer")) + (" · YOU" if id == local_user else "")
		if id == local_user:
			camera_target = camera_target.lerp(desired, minf(1, delta * 5))
			var select_id = str(player.get("selected", ""))
			if select_id != selected:
				set_selection(select_id)
	for id in player_nodes.keys():
		if not players.has(id):
			player_nodes[id].queue_free()
			player_nodes.erase(id)
	for def in content.get("enemies", []):
		var enemy = state.get("enemies", {}).get(def.id, {})
		if enemy.is_empty():
			continue
		if not enemy_nodes.has(def.id):
			var colors = {"sentinel": "#9b6469", "stalker": "#a07698", "artillerist": "#ab677c", "brute": "#b67c61", "boss": "#907fba"}
			enemy_nodes[def.id] = actor(false, def.kind, Color(colors[def.kind]))
		var node = enemy_nodes[def.id]
		node.visible = enemy.hp > 0
		if not node.visible:
			continue
		var desired = Vector3(enemy.x, 0, enemy.z)
		if node.position.distance_to(desired) > 18:
			node.position = desired
		else:
			node.position = node.position.lerp(desired, minf(1, delta * 13))
		node.get_node("Body").position.y = sin(time * 3 + float(def.x)) * .10
		if enemy.get("telegraph", 0) > 0:
			node.get_node("Body").scale = Vector3.ONE * (1 + .06 * sin(time * 24))
		else:
			node.get_node("Body").scale = Vector3.ONE
		node.get_node("Health").scale.x = maxf(.001, enemy.hp / float(enemy.get("max_hp", def.hp)))
		var target_id = str(enemy.get("target", ""))
		if players.has(target_id):
			var target = players[target_id]
			node.rotation.y = lerp_angle(node.rotation.y, atan2(enemy.x - target.x, enemy.z - target.z), delta * 4)
	var current_enemies = {}
	for def in content.get("enemies", []):
		current_enemies[def.id] = true
	for id in enemy_nodes.keys():
		if not current_enemies.has(id):
			enemy_nodes[id].queue_free()
			enemy_nodes.erase(id)
	for id in objects:
		var node = objects[id]
		var object_state = state.get("objects", {}).get(id, {})
		node.visible = not object_state.get("collected", false)
		if node.has_node("Float"):
			var core = node.get_node("Float")
			core.rotation.y = time * .7
			var def = node.get_meta("definition")
			var base = .75 if def.kind == "crystal" else (1.65 if def.kind == "beacon" else 2.0)
			core.position.y = base + sin(time * 2 + node.position.x) * .13
		if node.has_node("Orbit"):
			node.get_node("Orbit").rotation.y = time * .4
		if node.has_node("BeaconBeam"):
			node.get_node("BeaconBeam").visible = object_state.get("activated", false)
		if node.has_node("GateScreen"):
			node.get_node("GateScreen").visible = not object_state.get("activated", false)
	update_tasks(state.get("tasks", []))
	if selection:
		selection.rotation.y = sin(time * .8) * .015
	for event in state.get("events", []):
		if int(event.id) > last_event:
			last_event = int(event.id)
			if float(state.get("world_time", 0)) - float(event.get("time", 0)) < 2:
				spawn_effect(event)
	for effect in effects_live.duplicate():
		effect.life -= delta
		if effect.life <= 0:
			effect.node.queue_free()
			effects_live.erase(effect)
		else:
			var progress = 1 - effect.life / effect.duration
			if effect.get("expand", false):
				effect.node.scale = Vector3.ONE * (.5 + progress * effect.get("radius", 2))
			if effect.get("rise", false):
				effect.node.position.y += delta * 1.8
	screen_shake = maxf(0, screen_shake - delta * 4)
	camera.position = camera_target + Vector3(26, 33, 26) + Vector3(sin(time * 90), cos(time * 83), 0) * screen_shake * .16
	camera.look_at(camera_target + Vector3(0, .5, 0))

func set_selection(id: String) -> void:
	selected = id
	if is_instance_valid(selection):
		selection.queue_free()
	selection = null
	if not objects.has(id):
		return
	var object = objects[id]
	selection = Node3D.new()
	add_child(selection)
	selection.position = object.position
	var def = object.get_meta("definition")
	var radius = maxf(1, float(def.get("radius", 1)) * float(def.get("scale", 1)) + .6)
	ring(selection, Vector3(0, .12, 0), radius, Color("#82ffff"), .045)
	# Real expanded mesh silhouettes plus 3D corner bounds, not just a flat ring.
	for child in object.find_children("*", "MeshInstance3D", true, false):
		var outline = MeshInstance3D.new()
		outline.mesh = child.mesh
		var material = ShaderMaterial.new()
		material.shader = outline_shader
		outline.material_override = material
		selection.add_child(outline)
		outline.global_transform = child.global_transform
	var height = 3.5 * float(def.get("scale", 1))
	for x in [-radius, radius]:
		for z in [-radius, radius]:
			for y in [.2, height]:
				var corner = Vector3(x, y, z)
				box(selection, corner + Vector3(-signf(x) * .25, 0, 0), Vector3(.5, .035, .035), Color("#8effff"), 1)
				box(selection, corner + Vector3(0, 0, -signf(z) * .25), Vector3(.035, .035, .5), Color("#8effff"), 1)
				box(selection, corner + Vector3(0, .25 if y < 1 else -.25, 0), Vector3(.035, .5, .035), Color("#8effff"), 1)
	label(selection, "SELECTED · " + str(id), Vector3(0, height + .4, 0), Color("#99ffff"), 23)

func update_tasks(tasks: Array) -> void:
	var keep = {}
	for task in tasks:
		var id = str(task.get("id", ""))
		var object_id = str(task.get("object_id", ""))
		if not objects.has(object_id):
			continue
		keep[id] = true
		var status = str(task.get("status", "editing"))
		if task_nodes.has(id) and task_nodes[id].get_meta("status") != status:
			task_nodes[id].queue_free()
			task_nodes.erase(id)
		if not task_nodes.has(id):
			var root = Node3D.new()
			add_child(root)
			root.set_meta("status", status)
			task_nodes[id] = root
			root.position = objects[object_id].position
			var def = objects[object_id].get_meta("definition")
			var extent = maxf(1.2, float(def.get("radius", 1.2)) * float(def.get("scale", 1)))
			var task_radius = maxf(2.7, extent + 1.3)
			var task_height = maxf(4.4, 3.5 * float(def.get("scale", 1)) + 1.0)
			var color = {"editing": Color("#ffbd58"), "testing": Color("#85bfff"), "delivered": Color("#8dffbd"), "failed": Color("#ff797c")}.get(status, Color("#ffbd58"))
			ring(root, Vector3(0, .19, 0), task_radius, color, .13)
			var orbit = ring(root, Vector3(0, .30, 0), task_radius + .38, color, .055)
			orbit.name = "MaintenanceOrbit"
			if status in ["editing", "testing"]:
				for i in range(4):
					var marker = Node3D.new()
					root.add_child(marker)
					marker.position = Vector3(cos(i * PI / 2 + PI / 4) * (task_radius + .35), .78, sin(i * PI / 2 + PI / 4) * (task_radius + .35))
					marker.rotation.y = -i * PI / 2 - PI / 4
					marker.scale = Vector3.ONE * 1.35
					var plate = box(marker, Vector3.ZERO, Vector3(1.15, .62, .15), Color("#ffd84e"))
					plate.material_override = hazard_material
					box(marker, Vector3(-.43, -.42, 0), Vector3(.07, .35, .1), Color("#5f6e75"))
					box(marker, Vector3(.43, -.42, 0), Vector3(.07, .35, .1), Color("#5f6e75"))
			var tag = status.to_upper() + " · " + str(task.get("author", "Collaborator"))
			label(root, tag, Vector3(0, task_height, 0), color, 25)
			if status in ["delivered", "failed"]:
				label(root, "✓ 已交付" if status == "delivered" else "! 验证失败", Vector3(0, task_height - .55, 0), color, 31)
			elif status == "editing":
				label(root, "施工中 · " + str(task.get("title", "")).left(24), Vector3(0, task_height - .55, 0), color, 24)
			else:
				label(root, "测试中 · " + str(task.get("title", "")).left(24), Vector3(0, task_height - .55, 0), color, 24)
		var node = task_nodes[id]
		node.get_node("MaintenanceOrbit").rotation = Vector3(sin(time) * .035, time * .3, cos(time) * .035)
	for id in task_nodes.keys():
		if not keep.has(id):
			task_nodes[id].queue_free()
			task_nodes.erase(id)

func spawn_effect(event: Dictionary) -> void:
	var kind = str(event.get("kind", ""))
	var root = Node3D.new()
	effects.add_child(root)
	root.position = Vector3(event.x, .3, event.z)
	var duration = .55
	var expand = true
	var radius = 2.0
	var rise = false
	match kind:
		"slash":
			var slash = ring(root, Vector3(0, .75, 0), 2.1, Color("#b7fff4"), .12)
			slash.rotation.x = .25
			root.rotation.y = atan2(event.get("fx", 0), event.get("fz", -1))
			duration = .20
			radius = .4
		"hit", "player_hit":
			var color = Color("#ffd898") if kind == "hit" else Color("#ff887c")
			label(root, str(event.get("damage", 0)), Vector3(0, 1.8, 0), color, 35)
			for i in range(5):
				crystal(root, Vector3(cos(i * 1.256) * .7, .8, sin(i * 1.256) * .7), .4, color)
			rise = true
			expand = false
			if kind == "player_hit":
				screen_shake = .6
		"telegraph":
			duration = float(event.get("duration", .8)) - maxf(0, float(state.get("world_time", 0)) - float(event.get("time", 0)))
			if duration <= 0:
				root.queue_free()
				return
			radius = float(event.get("radius", 3.4))
			if not event.has("radius"):
				# Compatibility for a short-lived warning already in a 0.1.0 checkpoint.
				var kind_before_upgrade = event.get("enemy_kind", "sentinel")
				radius = {"artillerist": 3.2, "brute": 4.5, "boss": 11.0 if event.get("phase", 1) == 2 else 8.0}.get(kind_before_upgrade, 3.4)
				if kind_before_upgrade == "artillerist":
					root.position.x = event.get("target_x", event.x)
					root.position.z = event.get("target_z", event.z)
			ring(root, Vector3.ZERO, radius, Color("#ff7964"), .07)
			root.set_meta("telegraph_area", {"x": root.position.x, "z": root.position.z, "radius": radius})
			expand = false
		"enemy_attack":
			radius = event.get("radius", 3)
			ring(root, Vector3.ZERO, 1, Color("#ff997d"), .11)
			duration = .45
		"collect", "enemy_defeated":
			label(root, "+" + str(event.get("reward", 2)), Vector3(0, 1.5, 0), Color("#ffe4a1"), 31)
			ring(root, Vector3.ZERO, .6, Color("#a4fff3"), .045)
			rise = true
			duration = .8
		"beacon", "upgrade", "heal", "gate", "content_applied", "respawn":
			ring(root, Vector3.ZERO, .7, Color("#a2fff0"), .14)
			duration = 1.2
			radius = 5
			for i in range(8):
				crystal(root, Vector3(cos(i * PI / 4), 1, sin(i * PI / 4)), .45, Color("#affff2"))
		"dash":
			ring(root, Vector3.ZERO, .6, Color("#d2fff7"), .08)
			duration = .35
		"victory":
			ring(root, Vector3.ZERO, 2, Color("#fff0ad"), .3)
			duration = 3
			radius = 10
		_:
			root.queue_free()
			return
	effects_live.append({"node": root, "duration": duration, "life": duration, "expand": expand, "radius": radius, "rise": rise})

func pick_object(screen: Vector2) -> String:
	var origin = camera.project_ray_origin(screen)
	var direction = camera.project_ray_normal(screen)
	if absf(direction.y) < .001:
		return ""
	var point = origin + direction * (-origin.y / direction.y)
	var closest = 3.0
	var result = ""
	for id in objects:
		var node = objects[id]
		if not node.visible or node.get_meta("definition").kind == "bridge":
			continue
		var distance = Vector2(point.x - node.position.x, point.z - node.position.z).length()
		if distance < closest:
			closest = distance
			result = id
	return result
