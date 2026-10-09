extends Node3D
## Batched, persistent editor geometry. Camera motion never rebuilds these meshes.
const Spatial = preload("res://annotation_spatial.gd")
const Gizmo = preload("res://transform_gizmo.gd")
var host: Node
var lines: MeshInstance3D
var xray: MeshInstance3D
var plane_lines: MeshInstance3D
var gizmo: Node3D
var face_handles: Array = []
var vertices=PackedVector3Array()
var colors=PackedColorArray()
var rebuilds=0

func setup(value: Node) -> void:
	host=value
	lines=make_lines(false)
	xray=make_lines(true)
	plane_lines=make_lines(false)
	gizmo=Gizmo.new()
	add_child(gizmo)
	for i in 6:
		var handle=MeshInstance3D.new()
		var mesh=BoxMesh.new()
		mesh.size=Vector3.ONE
		handle.mesh=mesh
		handle.material_override=gizmo.material(Gizmo.COLORS[i/2])
		handle.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(handle)
		face_handles.append(handle)
		handle.visible=false

func make_lines(through: bool) -> MeshInstance3D:
	var node=MeshInstance3D.new()
	var mat=StandardMaterial3D.new()
	mat.shading_mode=BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.vertex_color_use_as_albedo=true
	mat.transparency=BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.no_depth_test=through
	mat.albedo_color=Color(1,1,1,.16 if through else 1)
	mat.render_priority=2 if through else 3
	node.material_override=mat
	node.cast_shadow=GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(node)
	return node

func segment(a: Vector3,b: Vector3,color: Color) -> void:
	vertices.append(a)
	vertices.append(b)
	colors.append(color)
	colors.append(color)

func box_lines(box: AABB,color: Color) -> void:
	for i in 8:
		for bit in [1,2,4]:
			if (i & bit)==0: segment(box.get_endpoint(i),box.get_endpoint(i|bit),color)

func commit(node: MeshInstance3D) -> void:
	if vertices.is_empty(): node.mesh=null; return
	var arrays=[]
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX]=vertices
	arrays[Mesh.ARRAY_COLOR]=colors
	var mesh=ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_LINES,arrays)
	node.mesh=mesh

func set_marks(marks: Array, bounds: Dictionary) -> void:
	rebuilds+=1
	vertices.clear()
	colors.clear()
	var outlined={}
	for mark in marks:
		if mark.get("dimension","3d")!="3d": continue
		var color=Color("e9b965") if mark.get("processing",false) else Color("7bb9ff")
		var geometry: Dictionary=mark.get("geometry",{}) if mark.get("geometry") is Dictionary else {}
		if geometry.get("shape")=="box":
			var size=Spatial.vec(geometry.size)
			box_lines(AABB(Spatial.vec(geometry.center)-size*.5,size),color)
		elif geometry.get("shape")=="prism":
			var normal=Vector3.ZERO
			normal[Spatial.axes(geometry.plane)[2]]=geometry.depth
			var points: Array=geometry.world_points
			for i in points.size():
				var a=Spatial.vec(points[i])
				var b=Spatial.vec(points[(i+1)%points.size()])
				segment(a,b,color)
				segment(a+normal,b+normal,color)
				# A few depth edges communicate the volume without a dense cage.
				if i%maxi(1,ceili(points.size()/12.0))==0: segment(a,a+normal,color)
		elif geometry.get("world_points") is Array:
			var points: Array=geometry.world_points
			for i in range(1,points.size()):
				if points[i].size()==3: segment(Spatial.vec(points[i-1]),Spatial.vec(points[i]),color)
		if mark.get("annotation_kind",mark.get("kind"))=="point":
			var point=Spatial.vec(mark.position)
			for axis in [Vector3.RIGHT,Vector3.UP,Vector3.BACK]: segment(point-axis*.12,point+axis*.12,color)
		for id in mark.get("object_ids",[]):
			if bounds.has(id) and not outlined.has(id):
				outlined[id]=true
				box_lines(bounds[id],Color(color,.62))
	commit(lines)
	xray.mesh=lines.mesh

func set_plane(name: String,offset: float,at: Vector3,enabled: bool) -> void:
	plane_lines.visible=enabled
	if not enabled: return
	vertices.clear()
	colors.clear()
	var axes=Spatial.axes(name)
	var center=at
	center[axes[2]]=offset
	var spacing=pow(10,floor(log(maxf(1,host.distance*.1))/log(10)))
	center[axes[0]]=snappedf(center[axes[0]],spacing)
	center[axes[1]]=snappedf(center[axes[1]],spacing)
	for i in range(-10,11):
		for dimension in 2:
			var a=center
			var b=center
			a[axes[dimension]]-=spacing*10
			b[axes[dimension]]+=spacing*10
			a[axes[1-dimension]]+=spacing*i
			b[axes[1-dimension]]+=spacing*i
			segment(a,b,Color(Color("72a8d0"),.5 if i==0 else .16))
	commit(plane_lines)

func update_handles(edit: Dictionary,enabled: bool) -> void:
	gizmo.pixel_ratio=host.gizmo.pixel_ratio
	gizmo.visible=false
	for handle in face_handles: handle.visible=false
	if not enabled or edit.is_empty() or edit.get("dimension")!="3d": return
	var kind=edit.get("annotation_kind",edit.get("kind"))
	if kind not in ["point","region"]: return
	var at=Spatial.vec(edit.position)
	gizmo.configure(host.camera,at,Basis.IDENTITY,"move",true)
	var geometry=edit.get("geometry")
	if not geometry is Dictionary or geometry.get("shape")!="box": return
	var size=Spatial.vec(geometry.size)
	for i in 6:
		var handle=face_handles[i]
		var point=at
		point[i/2]+=size[i/2]*(.5 if i%2 else -.5)
		handle.position=point
		handle.scale=Vector3.ONE*gizmo.world_size*.095
		handle.visible=not host.camera.is_position_behind(point)

func hit_handle(screen: Vector2) -> String:
	for i in 6:
		var handle=face_handles[i]
		if handle.visible and host.camera.unproject_position(handle.global_position).distance_to(screen)<10*host.gizmo.pixel_ratio: return "face-"+str(i)
	return gizmo.hit_test(screen)
