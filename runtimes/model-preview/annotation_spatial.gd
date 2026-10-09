extends RefCounted
## Read-only editor index. Mesh BVHs are cached by resource, never rebuilt by
## camera movement or by the vertices of a painted region.
var host: Node
var records: Array = []
var indexed_seq = -1
var indexed_document = ""
var triangles: Dictionary = {}
var last_bounds: Dictionary = {}
var stats = {"index_builds":0,"bvh_builds":0,"ray_queries":0,"triangle_queries":0,"world_queries":0}

func setup(value: Node) -> void:
	host=value

func invalidate() -> void:
	indexed_seq=-1

func ensure_index() -> void:
	if indexed_seq==host.applied_seq and indexed_document==host.document_id: return
	records.clear()
	triangles.clear()
	last_bounds.clear()
	indexed_seq=host.applied_seq
	indexed_document=host.document_id
	stats.index_builds+=1
	var owners={}
	for id in host.objects: owners[host.objects[id].get_instance_id()]=id
	var stack: Array=[[host.scene_root,""]]
	while not stack.is_empty():
		var item=stack.pop_back()
		var node: Node=item[0]
		var owner_id: String=owners.get(node.get_instance_id(),item[1])
		if node is MeshInstance3D and node.mesh!=null and not owner_id.is_empty():
			records.append({"node":node,"id":owner_id,"mesh":node.mesh,"local_bounds":node.get_aabb()})
		for child in node.get_children(): stack.append([child,owner_id])

func visible(record: Dictionary) -> bool:
	return is_instance_valid(record.node) and record.node.is_visible_in_tree() and (record.node.layers & host.camera.cull_mask)!=0 and absf(record.node.global_basis.determinant())>1e-8

func ray_pick(screen: Vector2) -> Dictionary:
	ensure_index()
	stats.ray_queries+=1
	var origin=host.camera.project_ray_origin(screen)
	var direction=host.camera.project_ray_normal(screen)
	var best=INF
	var result={}
	for record in records:
		if not visible(record): continue
		var transform: Transform3D=record.node.global_transform
		var inverse=transform.affine_inverse()
		var local_origin=inverse*origin
		var local_direction=(inverse.basis*direction).normalized()
		if record.local_bounds.intersects_ray(local_origin,local_direction)==null: continue
		var key=record.mesh.get_instance_id()
		if not triangles.has(key):
			triangles[key]=record.mesh.generate_triangle_mesh()
			stats.bvh_builds+=1
		if triangles[key]==null: continue
		stats.triangle_queries+=1
		var hit: Dictionary=triangles[key].intersect_ray(local_origin,local_direction)
		if hit.is_empty(): continue
		var position: Vector3=transform*hit.position
		var depth=(position-origin).dot(direction)
		if depth>=0 and depth<best and host.placement_visible_point(position):
			best=depth
			result={"object_id":record.id,"position":array3(position),"dimension":"3d"}
	return result

func object_bounds() -> Dictionary:
	ensure_index()
	var bounds={}
	for record in records:
		if not visible(record): continue
		var box: AABB=record.node.global_transform*record.local_bounds
		bounds[record.id]=bounds[record.id].merge(box) if bounds.has(record.id) else box
	last_bounds=bounds
	return bounds

static func axes(plane: String) -> Array:
	return [0,1,2] if plane=="xy" else [2,1,0] if plane=="yz" else [0,2,1]

static func array3(value: Vector3) -> Array:
	return [value.x,value.y,value.z]

static func vec(value: Array) -> Vector3:
	return Vector3(value[0],value[1],value[2])

func plane_point(screen: Vector2, plane: String, offset: float) -> Variant:
	var normal=Vector3.ZERO
	normal[axes(plane)[2]]=1
	var point=host.ray_on_plane(screen,normal*offset,normal)
	return point if point!=null and point.is_finite() and host.placement_visible_point(point) else null

static func box_geometry(a: Vector3, b: Vector3, plane: String, offset: float, depth: float) -> Dictionary:
	var normal=axes(plane)[2]
	var low=a.min(b)
	var size=(a-b).abs().max(Vector3.ONE*.05)
	low[normal]=offset
	size[normal]=maxf(.05,depth)
	return {"shape":"box","tool":"volume","center":array3(low+size*.5),"size":array3(size),"plane":plane,"offset":offset,"depth":size[normal],"selection":"world_aabb_intersection"}

static func brush_polygon(path: PackedVector2Array, radius: float) -> PackedVector2Array:
	var polygons=Geometry2D.offset_polyline(path,radius,Geometry2D.JOIN_ROUND,Geometry2D.END_ROUND)
	var outline=PackedVector2Array()
	var largest=0.0
	for polygon in polygons:
		var area=0.0
		for i in polygon.size(): area+=polygon[i].cross(polygon[(i+1)%polygon.size()])
		if absf(area)>largest:
			largest=absf(area)
			outline=polygon
	return outline

static func prism_geometry(path: Array[Vector3], radius: float, plane: String, offset: float, depth: float) -> Dictionary:
	var basis_axes=axes(plane)
	var flat=PackedVector2Array()
	for point in path: flat.append(Vector2(point[basis_axes[0]],point[basis_axes[1]]))
	var outline=PackedVector2Array()
	if flat.size()==1:
		for i in 24: outline.append(flat[0]+Vector2(cos(TAU*i/24),sin(TAU*i/24))*radius)
	else: outline=brush_polygon(flat,radius)
	if outline.size()<3: return {}
	# A bounded immutable shape; the same reduced polygon drives membership.
	var vertices=[]
	var bounds=Rect2(outline[0],Vector2.ZERO)
	var stride=maxi(1,ceili(outline.size()/96.0))
	for i in range(0,outline.size(),stride):
		var point=Vector3.ZERO
		point[basis_axes[0]]=outline[i].x
		point[basis_axes[1]]=outline[i].y
		point[basis_axes[2]]=offset
		vertices.append(array3(point))
		bounds=bounds.expand(outline[i])
	var center=Vector3.ZERO
	center[basis_axes[0]]=bounds.get_center().x
	center[basis_axes[1]]=bounds.get_center().y
	center[basis_axes[2]]=offset+depth*.5
	return {"shape":"prism","tool":"brush","center":array3(center),"plane":plane,"offset":offset,"depth":maxf(.05,depth),"radius":radius,"world_points":vertices,"selection":"world_aabb_intersection"}

static func moved_geometry(geometry: Dictionary, center: Array, size: Array=[], depth: float=-1) -> Dictionary:
	var next=geometry.duplicate(true)
	var delta=vec(center)-vec(geometry.center)
	var normal=axes(next.plane)[2]
	next.center=center.duplicate()
	if next.shape=="box":
		if size.size()==3: next.size=size.duplicate()
		next.depth=next.size[normal]
		next.offset=center[normal]-next.depth*.5
	else:
		var old_depth=next.depth
		if depth>0: next.depth=depth
		next.offset=center[normal]-next.depth*.5
		delta[normal]-=(next.depth-old_depth)*.5
		for i in next.world_points.size(): next.world_points[i]=array3(vec(next.world_points[i])+delta)
	return next

func world_members(geometry: Dictionary) -> Array:
	stats.world_queries+=1
	var selected=[]
	var bounds=object_bounds()
	var normal=axes(geometry.plane)[2]
	var footprint=PackedVector2Array()
	var basis_axes=axes(geometry.plane)
	if geometry.shape=="prism":
		for point in geometry.world_points: footprint.append(Vector2(point[basis_axes[0]],point[basis_axes[1]]))
	for id in bounds:
		var box: AABB=bounds[id]
		if geometry.shape=="box":
			var size=vec(geometry.size)
			if AABB(vec(geometry.center)-size*.5,size).grow(.00001).intersects(box): selected.append(id)
		else:
			if box.end[normal]<geometry.offset or box.position[normal]>geometry.offset+geometry.depth: continue
			var low=Vector2(box.position[basis_axes[0]],box.position[basis_axes[1]])
			var high=Vector2(box.end[basis_axes[0]],box.end[basis_axes[1]])
			var rect=PackedVector2Array([low,Vector2(high.x,low.y),high,Vector2(low.x,high.y)])
			if not Geometry2D.intersect_polygons(rect,footprint).is_empty(): selected.append(id)
	return selected
