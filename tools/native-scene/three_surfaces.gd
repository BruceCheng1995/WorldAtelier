extends SceneTree
# Extract fixed native render resources off-tree. Native scene identities and
# edits still come from the ordinary engine index. No game _ready is dispatched.
var output: FileAccess
var shapes := {}
var textures := {}
var geometry_ids := {}
var texture_ids := {}
var notices := {}
var rows := {}
var origin: Node
var theme_view: SubViewport
var theme_controls: Dictionary
var theme_anchor: Control

func _initialize() -> void:
	run.call_deferred()

func run() -> void:
	var args := OS.get_cmdline_user_args()
	var input_path := str(args[args.find("--request")+1])
	var result_path := str(args[args.find("--response")+1])
	var task: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(input_path))
	if task.get("editor_font") is String:
		var font=load(task.editor_font) as Font
		if font!=null:
			ThemeDB.fallback_font=font
			ThemeDB.get_default_theme().default_font=font
	var result := {"protocol":"wa-native-scene-1","ok":false,"errors":[],"scenes":[]}
	for i in task.scene_paths.size():
		var packed = load(task.scene_paths[i]) as PackedScene
		if packed == null:
			result.errors.append({"message":"Cannot load fixed scene "+str(task.scene_paths[i])})
			break
		origin = packed.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED)
		if origin == null:
			result.errors.append({"message":"Cannot instantiate "+str(task.scene_paths[i])})
			break
		rows = {}
		shapes = {}
		textures = {}
		geometry_ids = {}
		texture_ids = {}
		notices = {}
		output = FileAccess.open(str(task.directory)+"/"+str(i)+".bin",FileAccess.WRITE)
		if output == null:
			result.errors.append({"message":"Cannot create fixed geometry output"})
			break
		theme_view=SubViewport.new()
		theme_view.disable_3d=true
		theme_view.render_target_update_mode=SubViewport.UPDATE_DISABLED
		root.add_child(theme_view)
		# The headless editor has its own ThemeContext. Explicitly attach the
		# game default so off-tree probes never inherit editor padding or fonts.
		theme_anchor=Control.new()
		theme_anchor.theme=ThemeDB.get_default_theme()
		theme_view.add_child(theme_anchor)
		theme_controls={}
		walk(origin)
		if not theme_controls.is_empty():
			await process_frame
			await process_frame
			for control in theme_controls:
				var probe: Control=theme_controls[control]
				var c: Dictionary=rows[str(origin.get_path_to(control))].canvas
				c.minimum_size=vector2(probe.get_combined_minimum_size())
				c.intrinsic_minimum_size=vector2(probe.get_minimum_size())
				if probe is Label or probe is Button:
					var font=probe.get_theme_font("font")
					var px=probe.get_theme_font_size("font_size")
					c.font_ascent=font.get_ascent(px)
					c.font_descent=font.get_descent(px)
					c.text_size=vector2(font.get_string_size(probe.text,HORIZONTAL_ALIGNMENT_LEFT,-1,px))
		theme_view.free()
		theme_controls.clear()
		var size = output.get_position()
		output.close()
		origin.free()
		var meta := FileAccess.open(str(task.directory)+"/"+str(i)+".json",FileAccess.WRITE)
		meta.store_string(JSON.stringify({"nodes":rows,"geometry":shapes,"images":textures,"differences":notices.keys()}))
		meta.close()
		result.scenes.append({"size":size})
	result.ok = result.errors.is_empty()
	var response := FileAccess.open(result_path,FileAccess.WRITE)
	response.store_string(JSON.stringify(result))
	response.close()
	quit(0 if result.ok else 1)

func write_bytes(data: PackedByteArray) -> Array:
	while output.get_position()%4 != 0: output.store_8(0)
	var start := output.get_position()
	output.store_buffer(data)
	return [start,data.size()]

func color(c: Color) -> Array:
	return [c.r,c.g,c.b,c.a]

func texture_id(texture: Texture2D) -> String:
	if texture == null: return ""
	var key = texture.get_instance_id()
	if texture_ids.has(key):return texture_ids[key]
	var image = texture.get_image()
	if image == null or image.is_empty():
		notices["unreadable_texture"]=true
		return ""
	if image.is_compressed() and image.decompress()!=OK:
		notices["compressed_texture"]=true
		return ""
	var id = str(textures.size())
	texture_ids[key]=id
	textures[id]=write_bytes(image.save_png_to_buffer())
	return id

func vector2(v: Vector2) -> Array:
	return [v.x,v.y]

# Detached Control nodes resolve the engine fallback theme. Build the theme
# owner chain out of script-free built-in Controls inside a private viewport.
func resolved_theme(node: Control) -> Control:
	var probe=ClassDB.instantiate(node.get_class()) as Control
	probe.process_mode=Node.PROCESS_MODE_DISABLED
	probe.custom_minimum_size=node.custom_minimum_size
	probe.visible=node.visible
	probe.size_flags_horizontal=node.size_flags_horizontal
	probe.size_flags_vertical=node.size_flags_vertical
	if probe is Label or probe is Button:probe.text=node.text
	if probe is Label:
		probe.clip_text=node.clip_text
		probe.text_overrun_behavior=node.text_overrun_behavior
		probe.autowrap_mode=node.autowrap_mode
	if probe is TextureRect:
		probe.texture=node.texture
		probe.expand_mode=node.expand_mode
		probe.stretch_mode=node.stretch_mode
	probe.theme=node.theme
	probe.theme_type_variation=node.theme_type_variation
	for key in node.get_property_list():
		var name: String=key.name
		if name.begins_with("theme_override") and node.get(name)!=null:probe.set(name,node.get(name))
	var parent: Node=theme_controls.get(node.get_parent(),theme_anchor)
	parent.add_child(probe)
	theme_controls[node]=probe
	return probe

func style_data(style: StyleBox) -> Dictionary:
	var sides=[SIDE_LEFT,SIDE_TOP,SIDE_RIGHT,SIDE_BOTTOM]
	var content: Array=[]
	for side in sides:content.append(style.get_margin(side))
	var result={"content":content}
	if style is StyleBoxTexture and style.texture!=null:
		result.kind="texture"
		result.texture=texture_id(style.texture)
		result.margins=[]
		result.expand=[]
		for side in sides:
			result.margins.append(style.get_texture_margin(side))
			result.expand.append(style.get_expand_margin(side))
		result.center=style.draw_center
		result.modulate=color(style.modulate_color)
		result.tile=[style.axis_stretch_horizontal,style.axis_stretch_vertical]
	elif style is StyleBoxFlat:
		result.kind="flat"
		result.background=color(style.bg_color)
		result.border=color(style.border_color)
		result.widths=[]
		result.radius=[]
		for side in sides:result.widths.append(style.get_border_width(side))
		for corner in [CORNER_TOP_LEFT,CORNER_TOP_RIGHT,CORNER_BOTTOM_RIGHT,CORNER_BOTTOM_LEFT]:result.radius.append(style.get_corner_radius(corner))
		result.center=style.draw_center
	return result

func material_data(mat: Material) -> Dictionary:
	var r := {}
	if mat is BaseMaterial3D:
		r={"color":color(mat.albedo_color),"roughness":mat.roughness,"metallic":mat.metallic,
			"texture":texture_id(mat.albedo_texture),"transparent":mat.transparency!=BaseMaterial3D.TRANSPARENCY_DISABLED,
			"unlit":mat.shading_mode==BaseMaterial3D.SHADING_MODE_UNSHADED,"double_sided":mat.cull_mode==BaseMaterial3D.CULL_DISABLED,
			"vertex_color":mat.vertex_color_use_as_albedo}
		if mat.emission_enabled:
			r.emission=color(mat.emission)
			r.emission_energy=mat.emission_energy_multiplier
		if mat.normal_enabled:r.normal_texture=texture_id(mat.normal_texture)
	elif mat is ShaderMaterial:
		r.shader=mat.shader.resource_path if mat.shader!=null else ""
		notices["shader:"+r.shader]=true
		if mat.shader!=null:
			for field in mat.shader.get_shader_uniform_list():
				var name: String = field.name
				var val=mat.get_shader_parameter(name)
				if name in ["base_color","tint","fabric_color","skin_color","portal_color","light_tint"] and val is Color:r.color=color(val)
				if name in ["roughness_value","surface_roughness","base_roughness"] and val is float:r.roughness=val
				if name in ["metalness","surface_metallic"] and val is float:r.metallic=val
				if val is Texture2D and name in ["albedo_texture","base_texture"]:r.texture=texture_id(val)
	if mat!=null:
		r.name=mat.resource_name
	if mat is ShaderMaterial and mat.shader!=null:
		r.shader_sha256=mat.shader.code.sha256_text()
		r.uniforms={}
		for field in mat.shader.get_shader_uniform_list():
			var key: String=field.name
			var v=mat.get_shader_parameter(key)
			if v is String or v is bool or v is float or v is int:r.uniforms[key]=v
			elif v is Vector2:r.uniforms[key]=[v.x,v.y]
			elif v is Vector3:r.uniforms[key]=[v.x,v.y,v.z]
			elif v is Color:r.uniforms[key]=color(v)
			elif v is Vector4:r.uniforms[key]=[v.x,v.y,v.z,v.w]
	return r

func posed_arrays(arrays: Array, node: MeshInstance3D, skeleton: Skeleton3D) -> void:
	var bones=arrays[Mesh.ARRAY_BONES]
	var weights=arrays[Mesh.ARRAY_WEIGHTS]
	if bones==null or weights==null or bones.size()==0:return
	var skin: Skin=node.skin if node.skin!=null else skeleton.create_skin_from_rest_transforms()
	var transforms: Array[Transform3D]=[]
	var normals: Array[Basis]=[]
	for i in skin.get_bind_count():
		var bone=skeleton.find_bone(skin.get_bind_name(i)) if skin.get_bind_name(i)!=&"" else skin.get_bind_bone(i)
		if bone<0 or bone>=skeleton.get_bone_count():
			notices["unmapped_skin_joint"]=true
			return
		var transform=skeleton.get_bone_global_pose(bone)*skin.get_bind_pose(i)
		transforms.append(transform)
		normals.append(transform.basis.orthonormalized())
	var vertices: PackedVector3Array=arrays[Mesh.ARRAY_VERTEX]
	var vectors=arrays[Mesh.ARRAY_NORMAL]
	var count=int(bones.size()/vertices.size())
	for i in vertices.size():
		var original=vertices[i]
		var point=original
		var normal=Vector3.ZERO if vectors==null else vectors[i]
		var vector=normal
		for k in count:
			var weight=weights[i*count+k]
			if weight<0.0000001:continue
			var bind=bones[i*count+k]
			if bind<0 or bind>=transforms.size():continue
			point+=(transforms[bind]*original-original)*weight
			vector+=(normals[bind]*normal-normal)*weight
		vertices[i]=point
		if vectors!=null:vectors[i]=vector.normalized()
	arrays[Mesh.ARRAY_VERTEX]=vertices
	if vectors!=null:arrays[Mesh.ARRAY_NORMAL]=vectors

func geometry_id(mesh: Mesh,surface: int,node: MeshInstance3D) -> String:
	var skeleton: Skeleton3D=node.get_node_or_null(node.skeleton) as Skeleton3D if node!=null and not node.skeleton.is_empty() else null
	var key = str(mesh.get_instance_id())+"/"+str(surface)
	if skeleton!=null:key+="/"+str(skeleton.get_instance_id())+"/"+str(node.skin.get_instance_id() if node.skin!=null else 0)
	if geometry_ids.has(key):return geometry_ids[key]
	var arrays := mesh.surface_get_arrays(surface)
	if arrays.is_empty() or not arrays[Mesh.ARRAY_VERTEX] is PackedVector3Array:
		notices["unavailable_surface"]=true
		return ""
	if mesh is ArrayMesh and mesh.surface_get_primitive_type(surface)!=Mesh.PRIMITIVE_TRIANGLES:
		notices["non_triangle_surface"]=true
		return ""
	if skeleton!=null:posed_arrays(arrays,node,skeleton)
	var entry := {}
	for attr in [["position",Mesh.ARRAY_VERTEX],["normal",Mesh.ARRAY_NORMAL],["uv",Mesh.ARRAY_TEX_UV],["color",Mesh.ARRAY_COLOR],["index",Mesh.ARRAY_INDEX]]:
		var values=arrays[attr[1]]
		if values != null and values.size()>0:
			entry[attr[0]]=write_bytes(values.to_byte_array())
	var id=str(shapes.size())
	geometry_ids[key]=id
	shapes[id]=entry
	return id

func surfaces(mesh: Mesh,node: MeshInstance3D=null) -> Array:
	var result := []
	if mesh==null:return result
	for i in mesh.get_surface_count():
		var mat=node.get_active_material(i) if node!=null else mesh.surface_get_material(i)
		var id=geometry_id(mesh,i,node)
		if id!="":result.append({"geometry":id,"material":material_data(mat)})
	return result

func matrix(t: Transform3D) -> Array:
	return [t.basis.x.x,t.basis.x.y,t.basis.x.z,0,t.basis.y.x,t.basis.y.y,t.basis.y.z,0,t.basis.z.x,t.basis.z.y,t.basis.z.z,0,t.origin.x,t.origin.y,t.origin.z,1]

func attachment_transform(node: Node) -> Variant:
	if not node is Node3D:return null
	if node is BoneAttachment3D and not node.override_pose and node.get_parent() is Skeleton3D and not node.get_use_external_skeleton():
		var skeleton: Skeleton3D=node.get_parent()
		var i=skeleton.find_bone(node.bone_name)
		if i>=0:return node_world(skeleton)*skeleton.get_bone_global_pose(i)
	var parent_pose=attachment_transform(node.get_parent()) if node.get_parent() is Node3D and not node.top_level else null
	return parent_pose*node.transform if parent_pose!=null else null

func node_world(node: Node3D) -> Transform3D:
	if node.get_parent() is Node3D and not node.top_level:return node_world(node.get_parent())*node.transform
	return node.transform

func walk(node: Node) -> void:
	var p=str(origin.get_path_to(node))
	var row := {}
	if node is MeshInstance3D and node.mesh!=null:
		var box=node.get_aabb()
		row.mesh={"type":"surfaces","surfaces":surfaces(node.mesh,node),"frame_bounds":[box.position.x,box.position.y,box.position.z,box.end.x,box.end.y,box.end.z]}
	elif node is MultiMeshInstance3D and node.multimesh!=null and node.multimesh.mesh!=null:
		var multi: MultiMesh=node.multimesh
		var instances: Array=[]
		var colors: Array=[]
		var count=multi.instance_count if multi.visible_instance_count<0 else multi.visible_instance_count
		for i in count:
			instances.append(matrix(multi.get_instance_transform(i)))
			if multi.use_colors:colors.append(color(multi.get_instance_color(i)))
		row.mesh={"type":"surfaces","surfaces":surfaces(multi.mesh),"instances":instances,"colors":colors}
	elif node is CollisionShape3D and node.shape!=null:
		var shape=node.shape
		row.collision={"type":shape.get_class(),"disabled":node.disabled}
		for key in ["size","radius","height"]:
			if key in shape:
				var v=shape.get(key)
				row.collision[key]=[v.x,v.y,v.z] if v is Vector3 else v
	elif node is Label3D:
		row.label={"text":node.text,"color":color(node.modulate),"pixel_size":node.pixel_size,"font_size":node.font_size,"billboard":node.billboard}
	elif node is Light3D:
		row.light={"color":color(node.light_color),"energy":node.light_energy,"shadow":node.shadow_enabled,
			"specular":node.light_specular,"bias":node.shadow_bias,"normal_bias":node.shadow_normal_bias,"shadow_opacity":node.shadow_opacity}
		if node is OmniLight3D:
			row.light.range=node.omni_range
			row.light.attenuation=node.omni_attenuation
		if node is SpotLight3D:
			row.light.range=node.spot_range
			row.light.angle=node.spot_angle
			row.light.attenuation=node.spot_attenuation
			row.light.spot_attenuation=node.spot_angle_attenuation
		if node is DirectionalLight3D:
			row.light.shadow_distance=node.directional_shadow_max_distance
			row.light.angular_diameter=node.light_angular_distance
			row.light.sky_mode=node.sky_mode
	elif node is Camera3D:
		row.camera={"current":node.current,"fov":node.fov,"near":node.near,"far":node.far,"projection":node.projection,"size":node.size}
	elif node is WorldEnvironment and node.environment!=null:
		var e=node.environment
		row.environment={"background_mode":e.background_mode,"ambient_source":e.ambient_light_source,"reflection_source":e.reflected_light_source,"sky_contribution":e.ambient_light_sky_contribution,"background":color(e.background_color),"ambient":color(e.ambient_light_color),"background_energy":e.background_energy_multiplier,"ambient_energy":e.ambient_light_energy,"tone_mapper":e.tonemap_mode,"white":e.tonemap_white,"exposure":e.tonemap_exposure}
		if e.fog_enabled:
			row.environment.fog={"color":color(e.fog_light_color),"density":e.fog_density,"energy":e.fog_light_energy,"height":e.fog_height,"height_density":e.fog_height_density,"mode":e.fog_mode,"begin":e.fog_depth_begin,"end":e.fog_depth_end,"curve":e.fog_depth_curve,"sun_scatter":e.fog_sun_scatter,"sky_affect":e.fog_sky_affect,"aerial":e.fog_aerial_perspective}
		if e.sky!=null and e.sky.sky_material is ProceduralSkyMaterial:
			var sky=e.sky.sky_material
			row.environment.sky={"top":color(sky.sky_top_color),"horizon":color(sky.sky_horizon_color),"ground":color(sky.ground_bottom_color),"ground_horizon":color(sky.ground_horizon_color),"curve":sky.sky_curve,"ground_curve":sky.ground_curve,"energy":sky.sky_energy_multiplier,"ground_energy":sky.ground_energy_multiplier,"sun_angle_max":sky.sun_angle_max,"sun_curve":sky.sun_curve}
			if sky.sky_cover!=null:notices["unsupported_sky_cover"]=true
		elif e.sky!=null:notices["unsupported_sky"]=true
	elif node is Control:
		var probe=resolved_theme(node)
		row.canvas={"type":node.get_class()}
		if node is BoxContainer:
			row.canvas.separation=probe.get_theme_constant("separation")
			row.canvas.alignment=node.alignment
		if node is TextureRect:row.canvas.texture=texture_id(node.texture)
		if node is ColorRect:row.canvas.color=color(node.color)
		if node is Label or node is Button:
			row.canvas.text=node.text
			row.canvas.font_size=probe.get_theme_font_size("font_size")
			row.canvas.font_color=color(probe.get_theme_color("font_color"))
			if node is Label:
				row.canvas.text_shadow={"color":color(probe.get_theme_color("font_shadow_color")),"offset":[probe.get_theme_constant("shadow_offset_x"),probe.get_theme_constant("shadow_offset_y")],"outline":probe.get_theme_constant("shadow_outline_size")}
			row.canvas.horizontal=node.horizontal_alignment if node is Label else node.alignment
			row.canvas.vertical=node.vertical_alignment if node is Label else VERTICAL_ALIGNMENT_CENTER
		if node is Panel or node is PanelContainer or node is Button:
			var style=probe.get_theme_stylebox("normal" if node is Button else "panel")
			row.canvas.style=style_data(style)
			if style is StyleBoxFlat:row.canvas.background=color(style.bg_color)
			if node is Button:
				row.canvas.styles={}
				for state in ["normal","hover","pressed","disabled","focus"]:
					row.canvas.styles[state]=style_data(probe.get_theme_stylebox(state))
		if node is TextureRect:row.canvas.stretch_mode=node.stretch_mode
	elif node is CPUParticles3D or node is GPUParticles3D:
		row.particles = true
		notices["particles"]=true
	elif (node is VisualInstance3D and not node is MeshInstance3D and not node is MultiMeshInstance3D) or node is Node2D:
		row.unsupported_visual=node.get_class()
	if node is Control and not node.get_class() in ["Control","Container","HBoxContainer","VBoxContainer","Panel","PanelContainer","Label","Button","TextureRect","ColorRect"]:
		row.unsupported_visual=node.get_class()
	if row.has("mesh") and row.mesh.surfaces.is_empty() and ((node is MeshInstance3D and node.mesh.get_surface_count()>0) or (node is MultiMeshInstance3D and node.multimesh.mesh.get_surface_count()>0)):
		row.unsupported_visual=node.get_class()

	var attached=attachment_transform(node)
	if attached!=null:row.posed_matrix=matrix(attached)
	if not row.is_empty():rows[p]=row
	for child in node.get_children():walk(child)
