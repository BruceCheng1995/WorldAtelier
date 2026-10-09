extends RefCounted
## Canonical hierarchy pack adapter shared by editing and authority/projection.
## Transport access URLs and UI metadata never mutate the canonical source pack.
const FORMAT = "creation-runtime-hierarchy-2"
const SCHEMA = "creation-hierarchy-2"
const Capabilities = preload("res://runtime_capabilities.gd")
const IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
const LIMIT = 1000
const WORLD_LIMIT = 10000.0

static func enabled(scene: Dictionary) -> bool:
	return scene.get("document_schema") == SCHEMA or scene.has("hierarchy_pack")

static func numbers(value: Variant, count: int, low: float = -1.0e100, high: float = 1.0e100) -> bool:
	if not value is Array or value.size()!=count:return false
	for n in value:
		if not (n is int or n is float) or not is_finite(float(n)) or n<low or n>high:return false
	return true

static func digest(value: Variant) -> bool:
	return value is String and RegEx.create_from_string("^[a-f0-9]{64}$").search(value)!=null

static func identity_id(value: Variant) -> bool:
	return value is String and RegEx.create_from_string("^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$").search(value)!=null and value not in ["constructor","prototype","__proto__"]

static func ref_key(value: Variant) -> String:
	if not value is Dictionary or value.get("kind") not in ["object","mount"] or not value.get("id") is String:return ""
	return str(value.kind)+":"+str(value.id)

static func matrix_from_trs(value: Dictionary) -> Array:
	var p: Array=value.position
	var q: Array=value.rotation
	var s: Array=value.scale
	var x: float=q[0];var y: float=q[1];var z: float=q[2];var w: float=q[3]
	return [(1-2*y*y-2*z*z)*s[0],(2*x*y+2*z*w)*s[0],(2*x*z-2*y*w)*s[0],0,
		(2*x*y-2*z*w)*s[1],(1-2*x*x-2*z*z)*s[1],(2*y*z+2*x*w)*s[1],0,
		(2*x*z+2*y*w)*s[2],(2*y*z-2*x*w)*s[2],(1-2*x*x-2*y*y)*s[2],0,p[0],p[1],p[2],1]

static func multiply(a: Array,b: Array) -> Array:
	var result=[]
	result.resize(16)
	for column in range(4):
		for row in range(4):
			var value=0.0
			for k in range(4):value+=float(a[k*4+row])*float(b[column*4+k])
			result[column*4+row]=value
	return result

static func close_matrix(a: Array,b: Array,tolerance: float = 1.0e-7) -> bool:
	if a.size()!=16 or b.size()!=16:return false
	for i in range(16):
		if absf(float(a[i])-float(b[i]))>tolerance*maxf(1,maxf(absf(float(a[i])),absf(float(b[i])))):return false
	return true

static func transform(value: Array) -> Transform3D:
	return Transform3D(Basis(Vector3(value[0],value[1],value[2]),Vector3(value[4],value[5],value[6]),Vector3(value[8],value[9],value[10])),Vector3(value[12],value[13],value[14]))

static func matrix(value: Transform3D) -> Array:
	return [value.basis.x.x,value.basis.x.y,value.basis.x.z,0,value.basis.y.x,value.basis.y.y,value.basis.y.z,0,value.basis.z.x,value.basis.z.y,value.basis.z.z,0,value.origin.x,value.origin.y,value.origin.z,1]

static func valid_trs(value: Variant) -> bool:
	if not value is Dictionary or not numbers(value.get("position"),3,-1.0e6,1.0e6) or not numbers(value.get("rotation"),4,-1,1) or not numbers(value.get("scale"),3,1.0e-4,1.0e4):return false
	var squared=0.0
	for n in value.rotation:squared+=float(n)*float(n)
	return absf(squared-1)<1.0e-7

static func valid_matrix(value: Variant, bounded_origin: bool = true) -> bool:
	if not numbers(value,16):return false
	if absf(value[3])+absf(value[7])+absf(value[11])+absf(value[15]-1)>1.0e-9:return false
	if bounded_origin and not numbers(value.slice(12,15),3,-WORLD_LIMIT,WORLD_LIMIT):return false
	var actual=transform(value)
	return actual.is_finite() and is_finite(actual.basis.determinant()) and actual.basis.determinant()>1.0e-30

static func address_valid(value: Variant,pack: Dictionary,mount: bool = false) -> bool:
	if not value is Dictionary:return false
	for key in ["project_id","branch_id","resource_id"]:
		if value.get(key)!=pack.get(key):return false
	if not value.get("instance_path") is Array or value.instance_path.size()>32:return false
	for id in value.instance_path:
		if not identity_id(id):return false
	return not value.has("definition_node_id") if mount else identity_id(value.get("definition_node_id"))

static func address_equal(a: Variant,b: Variant) -> bool:
	return a is Dictionary and b is Dictionary and a==b

static func authorized_url(value: Variant,origin: String,hash_value: String,extension: String) -> bool:
	if not value is String:return false
	var path=value.trim_prefix(origin) if not origin.is_empty() else value
	var prefix="/preview-assets/"+hash_value+"."+extension
	if not path.begins_with(prefix):return false
	return RegEx.create_from_string("^(?:\\?[A-Za-z0-9_.=&%-]*)?$").search(path.substr(prefix.length()))!=null

static func physics_error(row: Dictionary) -> String:
	var m: Array=row.world_matrix
	var lengths=[]
	var axes=[]
	for start in [0,4,8]:
		var length=sqrt(float(m[start])*m[start]+float(m[start+1])*m[start+1]+float(m[start+2])*m[start+2])
		if length<1.0e-15:return "singular physics transform"
		lengths.append(length)
		axes.append([m[start]/length,m[start+1]/length,m[start+2]/length])
	var orthogonal=true
	for pair in [[0,1],[0,2],[1,2]]:
		var dot=0.0
		for i in range(3):dot+=axes[pair[0]][i]*axes[pair[1]][i]
		orthogonal=orthogonal and absf(dot)<=1.0e-7
	var uniform=(float(lengths.max())-float(lengths.min()))/float(lengths.max())<=1.0e-7
	for kind in ["collider","trigger","interactable"]:
		if not row.node.get("components",{}).has(kind):continue
		var component=row.node.get("components",{})[kind]
		if not component is Dictionary:return "invalid physics component"
		var shape=component.get("shape","trimesh" if kind=="collider" else "sphere")
		if shape not in (["box","trimesh"] if kind=="collider" else ["box","sphere"]):return "unsupported component shape"
		if shape=="box" and not orthogonal:return "runtime_sheared_box_unsupported"
		if shape=="sphere" and (not orthogonal or not uniform):return "runtime_sphere_transform_unsupported"
		var offset=component.get("offset",[0,0,0])
		if not numbers(offset,3):return "invalid physics offset"
		for i in range(3):
			var center=float(m[i])*offset[0]+float(m[i+4])*offset[1]+float(m[i+8])*offset[2]+float(m[i+12])
			if not is_finite(center) or absf(center)>WORLD_LIMIT:return "runtime_world_bounds"
	return ""

static func validate(scene: Dictionary,origin: String) -> String:
	if scene.get("document_schema")!=SCHEMA or not scene.get("hierarchy_pack") is Dictionary:return "unknown hierarchy document format"
	var pack: Dictionary=scene.hierarchy_pack
	if pack.get("schema")!=2 or pack.get("format")!=FORMAT or pack.get("source_schema")!=SCHEMA:return "unsupported hierarchy pack format"
	for key in ["project_id","branch_id","resource_id","source_revision"]:
		if not identity_id(pack.get(key)):return "invalid hierarchy scope "+key
	for key in ["branch_id","resource_id"]:
		if scene.get(key)!=pack[key]:return "hierarchy scope mismatch "+key
	if scene.get("scene_revision")!=pack.source_revision:return "hierarchy source revision mismatch"
	if not digest(pack.get("pack_hash")) or not digest(pack.get("source_document_version")):return "invalid hierarchy version digest"
	var canonical=scene.get("hierarchy_pack_canonical")
	if not canonical is String or canonical.to_utf8_buffer().size()>16*1024*1024 or canonical.sha256_text()!=pack.pack_hash:return "hierarchy canonical SHA-256 mismatch"
	var unsigned=pack.duplicate(true)
	unsigned.erase("pack_hash")
	if JSON.parse_string(canonical)!=unsigned:return "hierarchy canonical payload mismatch"
	var required=pack.get("required_capabilities")
	var supported=Capabilities.read().get("features",[])
	if not required is Array or not supported is Array:return "unsupported hierarchy capabilities"
	for feature in required:
		if not feature is String or not supported.has(feature):return "unsupported hierarchy capabilities"
	if not pack.get("limits") is Dictionary or pack.limits.get("max_expanded_nodes")!=LIMIT or pack.limits.get("max_world_coordinate")!=WORLD_LIMIT or pack.limits.get("physics_policy")!="orthogonal-box-uniform-sphere-v1":return "unsupported hierarchy runtime limits"
	for key in ["objects","mounts","assembly_order","prefab_closure","asset_closure"]:
		if not pack.get(key) is Array:return "missing hierarchy array "+key
	if pack.objects.size()+pack.mounts.size()>LIMIT or pack.objects.is_empty():return "runtime_expansion_limit"
	var prefab_versions={}
	var previous_prefab=""
	for prefab in pack.prefab_closure:
		if not prefab is Dictionary or not identity_id(prefab.get("resource_id")) or not digest(prefab.get("revision")):return "invalid fixed prefab closure"
		var key=prefab.resource_id+":"+prefab.revision
		if prefab_versions.has(key) or (not previous_prefab.is_empty() and key<=previous_prefab):return "duplicate or unsorted prefab closure"
		prefab_versions[key]=true;previous_prefab=key
	var used_prefabs={}
	var closure={}
	for asset in pack.asset_closure:
		if not asset is Dictionary or not digest(asset.get("hash")) or asset.get("extension") not in ["glb","gd"]:return "invalid fixed asset closure"
		var key=asset.extension+":"+asset.hash
		if closure.has(key) or asset.get("url")!="/preview-assets/"+asset.hash+"."+asset.extension:return "noncanonical fixed asset closure"
		closure[key]=true
	var access={}
	if not scene.get("asset_access") is Array:return "hierarchy asset_access is required"
	for asset in scene.asset_access:
		if not asset is Dictionary or not digest(asset.get("hash")) or asset.get("extension") not in ["glb","gd"]:return "invalid asset access entry"
		var key=asset.extension+":"+asset.hash
		if not closure.has(key) or access.has(key) or not authorized_url(asset.get("url"),origin,asset.hash,asset.extension):return "invalid scoped asset access"
		access[key]=true
	if access.size()!=closure.size():return "incomplete asset access"
	var entries={}
	var addresses={}
	var used_assets={}
	for kind in ["object","mount"]:
		var previous=""
		for row in pack.objects if kind=="object" else pack.mounts:
			if not row is Dictionary or not row.get("id") is String or row.id.is_empty() or (not previous.is_empty() and row.id<=previous):return "invalid or unsorted hierarchy identity"
			previous=row.id
			if not address_valid(row.get("address"),pack,kind=="mount") or not valid_trs(row.get("local_transform")) or not valid_matrix(row.get("world_matrix")) or not valid_matrix(row.get("parent_world_matrix")):return "invalid hierarchy address or transform"
			var path: Array=row.address.instance_path
			var expected_id="mount-"+JSON.stringify(path).sha256_text() if kind=="mount" else (row.address.definition_node_id if path.is_empty() else "node-"+JSON.stringify([path,row.address.definition_node_id]).sha256_text())
			if row.id!=expected_id:return "hierarchy runtime identity mismatch"
			var key=kind+":"+row.id
			var address_key=JSON.stringify(row.address)
			if entries.has(key) or addresses.has(address_key):return "duplicate hierarchy identity"
			entries[key]=row;addresses[address_key]=true
			if not digest(row.get("ancestry_hash")):return "invalid ancestry version"
			if not close_matrix(row.world_matrix,multiply(row.parent_world_matrix,matrix_from_trs(row.local_transform))):return "hierarchy local/world matrix mismatch"
			if kind=="mount":
				if not row.get("parent") is Dictionary or row.parent.get("kind")!="object" or path.is_empty() or row.get("instance_id")!=path.back():return "invalid instance mount parent"
				if not identity_id(row.get("owner_resource_id")) or not identity_id(row.get("prefab_id")) or not prefab_versions.has(str(row.get("prefab_id"))+":"+str(row.get("prefab_revision"))):return "unresolved fixed prefab mount"
				used_prefabs[row.prefab_id+":"+row.prefab_revision]=true
				for field in ["owner_revision","prefab_revision","instance_version"]:
					if not digest(row.get(field)):return "invalid mount version"
			else:
				if not row.get("node") is Dictionary or row.node.get("id")!=row.address.definition_node_id or row.node.get("transform")!=row.local_transform:return "invalid effective hierarchy node"
				for field in ["definition_revision","definition_node_version","object_version"]:
					if not digest(row.get(field)):return "invalid hierarchy object version"
				if not row.node.get("components",{}) is Dictionary:return "invalid hierarchy components"
				if row.node.get("kind") not in ["group","anchor"] or row.node.has("model_hash") or row.node.has("model_url"):
					var hash_value=row.node.get("model_hash","")
					if not digest(hash_value) or row.node.get("model_url")!="/preview-assets/"+hash_value+".glb" or not closure.has("glb:"+hash_value):return "invalid hierarchy model closure"
					used_assets["glb:"+hash_value]=true
				if row.node.get("kind")=="group" and (row.node.get("solid",false) or not row.node.get("components",{}).is_empty() or row.node.has("model_hash")):return "group cannot carry model or behavior content"
				if not row.node.get("components",{}).get("behaviors",[]) is Array:return "invalid hierarchy behaviors"
				for behavior in row.node.get("components",{}).get("behaviors",[]):
					if not behavior is Dictionary:return "invalid hierarchy behavior"
					var hash_value=behavior.get("script_hash","")
					if not digest(hash_value) or behavior.get("script_url")!="/preview-assets/"+hash_value+".gd" or not closure.has("gd:"+hash_value):return "invalid hierarchy behavior closure"
					used_assets["gd:"+hash_value]=true
				var error=physics_error(row)
				if not error.is_empty():return error
	if used_prefabs.size()!=prefab_versions.size():return "unused fixed prefab closure entry"
	if used_assets.size()!=closure.size():return "unused fixed asset closure entry"
	var root_key=ref_key(pack.get("root"))
	if not entries.has(root_key) or pack.root.kind!="object":return "invalid hierarchy root"
	var assembled={}
	for ref in pack.assembly_order:
		var key=ref_key(ref)
		if not entries.has(key) or assembled.has(key):return "invalid assembly order"
		var row: Dictionary=entries[key]
		if row.get("parent")==null:
			if key!=root_key or row.node.get("kind")!="group" or not row.address.instance_path.is_empty() or not close_matrix(row.parent_world_matrix,IDENTITY):return "invalid hierarchy root parent"
		else:
			var parent=ref_key(row.parent)
			if not assembled.has(parent) or not close_matrix(row.parent_world_matrix,entries[parent].world_matrix):return "hierarchy parent matrix/order mismatch"
		assembled[key]=true
	if assembled.size()!=entries.size():return "incomplete assembly order"
	var preview_id=scene.get("preview_object_id","")
	if not preview_id is String or (not preview_id.is_empty() and not entries.has("object:"+preview_id)):return "invalid preview object identity"
	if scene.has("preview_observation") and scene.preview_observation!=null:
		var value=scene.preview_observation
		if not value is Dictionary or value.get("id")!=preview_id or not entries.has("object:"+preview_id):return "invalid preview observation identity"
		var row: Dictionary=entries["object:"+preview_id]
		if value.get("address")!=row.address or value.get("object_version",value.get("version"))!=row.object_version or not valid_matrix(value.get("world_matrix")):return "invalid preview observation version/matrix"
	return ""

static func effective_document(scene: Dictionary) -> Dictionary:
	var document=scene.duplicate(true)
	var access={}
	for asset in scene.asset_access:access[asset.extension+":"+asset.hash]=asset.url
	document.objects=[]
	for row in scene.hierarchy_pack.objects:
		var value: Dictionary=row.node.duplicate(true)
		value.id=row.id
		value.position=row.world_position.duplicate()
		value.address=row.address.duplicate(true)
		for field in ["object_version","ancestry_hash","definition_resource_id","definition_revision","definition_node_version","local_transform","world_matrix"]:value[field]=row[field].duplicate(true) if row[field] is Array or row[field] is Dictionary else row[field]
		value.source_revision=scene.hierarchy_pack.source_revision
		value.version=row.object_version
		if value.has("model_hash"):value.model_url=access["glb:"+value.model_hash]
		for behavior in value.get("components",{}).get("behaviors",[]):behavior.script_url=access["gd:"+behavior.script_hash]
		document.objects.append(value)
	return document

static func assemble(scene: Dictionary) -> Dictionary:
	var root=Node3D.new()
	root.name="HierarchyContent"
	var nodes={};var objects={};var mounts={};var rows={}
	for row in scene.hierarchy_pack.objects:rows["object:"+row.id]=row
	for row in scene.hierarchy_pack.mounts:rows["mount:"+row.id]=row
	for ref in scene.hierarchy_pack.assembly_order:
		var key=ref_key(ref)
		var row: Dictionary=rows[key]
		var node=Node3D.new()
		node.name=("Object_" if ref.kind=="object" else "Mount_")+str(nodes.size())
		node.transform=transform(matrix_from_trs(row.local_transform))
		node.set_meta("runtime_id",row.id)
		if ref.kind=="object":node.set_meta("object_id",row.id)
		node.set_meta("address",row.address.duplicate(true))
		node.set_meta("hierarchy_ref",ref.duplicate(true))
		node.set_meta("canonical_local",node.transform)
		var parent: Node3D=root if row.parent==null else nodes[ref_key(row.parent)]
		parent.add_child(node)
		nodes[key]=node
		if ref.kind=="object":objects[row.id]=node
		else:mounts[row.id]=node
	return {"root":root,"objects":objects,"mounts":mounts,"nodes":nodes,"rows":rows}

static func add_identity(packet: Dictionary,row: Dictionary) -> Dictionary:
	for key in ["address","source_revision","object_version","ancestry_hash","definition_revision","definition_node_version"]:
		if row.has(key):packet[key]=row[key].duplicate(true) if row[key] is Array or row[key] is Dictionary else row[key]
	return packet

static func local_trs(node: Node3D) -> Variant:
	var basis=node.basis
	var lengths=basis.get_scale()
	if minf(lengths.x,minf(lengths.y,lengths.z))<=0:return null
	var rotation=Basis(basis.x/lengths.x,basis.y/lengths.y,basis.z/lengths.z)
	if absf(rotation.x.dot(rotation.y))+absf(rotation.x.dot(rotation.z))+absf(rotation.y.dot(rotation.z))>2.0e-5:return null
	var q=rotation.get_rotation_quaternion().normalized()
	if q.w<0:q=-q
	return {"position":[node.position.x,node.position.y,node.position.z],"rotation":[q.x,q.y,q.z,q.w],"scale":[lengths.x,lengths.y,lengths.z]}

static func world_bounds(node: Node3D,model_only: bool = false) -> Dictionary:
	var bounds=AABB();var count=0
	for child in node.get_children():
		if model_only and child.has_meta("hierarchy_ref"):continue
		if child is MeshInstance3D and child.mesh!=null:
			var own_bounds: AABB=child.global_transform*child.get_aabb()
			bounds=bounds.merge(own_bounds) if count else own_bounds
			count+=1
		var nested=world_bounds(child,model_only) if child is Node3D else {"mesh_count":0}
		if nested.mesh_count:
			bounds=bounds.merge(nested.bounds) if count else nested.bounds
			count+=nested.mesh_count
	return {"bounds":bounds,"mesh_count":count}

static func owned_meshes(node: Node3D) -> Array:
	var result=[]
	for child in node.get_children():
		if child.has_meta("hierarchy_ref"):continue
		if child is MeshInstance3D and child.mesh!=null:result.append(child)
		if child is Node3D:result.append_array(owned_meshes(child))
	return result

static func restore(graph: Dictionary) -> void:
	for node in graph.get("nodes",{}).values():node.transform=node.get_meta("canonical_local")

static func observation(id: String,node: Node3D,row: Dictionary) -> Dictionary:
	var result={"id":id,"world_matrix":matrix(node.global_transform),"position":[node.global_position.x,node.global_position.y,node.global_position.z],"local_transform":local_trs(node),"version":row.get("object_version",row.get("version","")),"model_hash":row.get("model_hash","")}
	return add_identity(result,row)

static func direction_basis(basis: Basis) -> Basis:
	# Local scale axes are the actual world directions of the local basis,
	# which need not be perpendicular under a sheared ancestor transform.
	return Basis(basis.x.normalized(),basis.y.normalized(),basis.z.normalized())

static func geometry_error(row: Dictionary,bounds: AABB) -> String:
	var transformed: AABB=transform(row.world_matrix)*bounds
	for point in [transformed.position,transformed.end]:
		if not point.is_finite() or point.abs()[point.abs().max_axis_index()]>WORLD_LIMIT:return "runtime_model_world_bounds"
	return ""

static func graph_observation(graph: Dictionary,definitions: Dictionary,pack_hash: String) -> Dictionary:
	var result={"pack_hash":pack_hash,"objects":[],"mounts":[]}
	for id in graph.get("objects",{}):result.objects.append(observation(id,graph.objects[id],definitions[id]))
	for id in graph.get("mounts",{}):
		var row: Dictionary=graph.rows["mount:"+id]
		result.mounts.append({"id":id,"address":row.address.duplicate(true),"instance_version":row.instance_version,"ancestry_hash":row.ancestry_hash,"world_matrix":matrix(graph.mounts[id].global_transform),"local_transform":local_trs(graph.mounts[id])})
	return result
