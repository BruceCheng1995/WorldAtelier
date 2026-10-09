extends RefCounted
## Bounded, JSON-safe Godot values. No Objects, Resources or executable values.
static func encode(value: Variant, depth: int = 0) -> Variant:
	if depth > 12: return {"$invalid":"value nesting limit"}
	match typeof(value):
		TYPE_NIL,TYPE_BOOL,TYPE_INT,TYPE_STRING: return value
		TYPE_FLOAT: return value if is_finite(value) else {"$invalid":"non-finite number"}
		TYPE_STRING_NAME: return {"$type":"StringName","value":str(value)}
		TYPE_VECTOR2,TYPE_VECTOR2I: return {"$type":type_string(typeof(value)),"value":[value.x,value.y]}
		TYPE_VECTOR3,TYPE_VECTOR3I: return {"$type":type_string(typeof(value)),"value":[value.x,value.y,value.z]}
		TYPE_VECTOR4,TYPE_VECTOR4I,TYPE_QUATERNION: return {"$type":type_string(typeof(value)),"value":[value.x,value.y,value.z,value.w]}
		TYPE_COLOR: return {"$type":"Color","value":[value.r,value.g,value.b,value.a]}
		TYPE_TRANSFORM2D: return {"$type":"Transform2D","value":[value.x.x,value.x.y,value.y.x,value.y.y,value.origin.x,value.origin.y]}
		TYPE_TRANSFORM3D: return {"$type":"Transform3D","value":[value.basis.x.x,value.basis.x.y,value.basis.x.z,value.basis.y.x,value.basis.y.y,value.basis.y.z,value.basis.z.x,value.basis.z.y,value.basis.z.z,value.origin.x,value.origin.y,value.origin.z]}
		TYPE_ARRAY:
			if value.size()>4096:return {"$invalid":"array limit"}
			var result:Array=[]
			for item in value:result.append(encode(item,depth+1))
			return result
		TYPE_DICTIONARY:
			if value.size()>4096:return {"$invalid":"dictionary limit"}
			var result:Dictionary={}
			for key in value:
				if not key is String or str(key).begins_with("$"):return {"$invalid":"reserved or non-string key"}
				result[key]=encode(value[key],depth+1)
			return result
		_:return {"$invalid":"unsupported "+type_string(typeof(value))}
static func valid(value:Variant,depth:int=0)->bool:
	if depth>14:return false
	if value is float:return is_finite(value)
	if value is String:return value.length()<=65536
	if value is Array:
		if value.size()>4096:return false
		for item in value:
			if not valid(item,depth+1):return false
	elif value is Dictionary:
		if value.size()>4096 or value.has("$invalid"):return false
		if value.has("$type"):
			var type=str(value["$type"])
			if type=="StringName":return value.get("value") is String
			var sizes={"Vector2":2,"Vector2i":2,"Vector3":3,"Vector3i":3,"Vector4":4,"Vector4i":4,"Quaternion":4,"Color":4,"Transform2D":6,"Transform3D":12}
			if not sizes.has(type) or not value.get("value") is Array or value.value.size()!=sizes[type]:return false
			for number in value.value:
				if not (number is int or number is float) or not is_finite(number):return false
			return true
		for key in value:
			if not key is String or not valid(value[key],depth+1):return false
	return true
static func decode(value:Variant)->Variant:
	if value is Array:
		var result:Array=[]
		for item in value:result.append(decode(item))
		return result
	if not value is Dictionary:return value
	if value.has("$type"):
		var v:Variant=value.get("value",[])
		match str(value["$type"]):
			"StringName":return StringName(str(v))
			"Vector2":return Vector2(v[0],v[1])
			"Vector2i":return Vector2i(v[0],v[1])
			"Vector3":return Vector3(v[0],v[1],v[2])
			"Vector3i":return Vector3i(v[0],v[1],v[2])
			"Vector4":return Vector4(v[0],v[1],v[2],v[3])
			"Vector4i":return Vector4i(v[0],v[1],v[2],v[3])
			"Quaternion":return Quaternion(v[0],v[1],v[2],v[3])
			"Color":return Color(v[0],v[1],v[2],v[3])
			"Transform2D":return Transform2D(Vector2(v[0],v[1]),Vector2(v[2],v[3]),Vector2(v[4],v[5]))
			"Transform3D":return Transform3D(Basis(Vector3(v[0],v[1],v[2]),Vector3(v[3],v[4],v[5]),Vector3(v[6],v[7],v[8])),Vector3(v[9],v[10],v[11]))
			_:return null
	var result:Dictionary={}
	for key in value:result[key]=decode(value[key])
	return result
static func coerce(value:Variant,previous:Variant)->Variant:
	var decoded:Variant=decode(value)
	if previous is int and (decoded is float or decoded is int):return int(decoded)
	if previous is float and (decoded is float or decoded is int):return float(decoded)
	return decoded
