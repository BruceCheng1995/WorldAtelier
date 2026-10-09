extends Node3D
## CC0 hitscan weapon adapter. Aim along local +Z. The owning game sets teams/VFX.
signal fired(hit: Dictionary)
@export var damage: float = 20.0
@export var fire_interval: float = 0.2
@export var max_range: float = 80.0
@export_flags_3d_physics var hit_mask: int = 1
var cooldown := 0.0
func _physics_process(delta: float) -> void:
	cooldown=maxf(0,cooldown-delta)
func fire(exclude: Array[RID]=[]) -> bool:
	if cooldown>0: return false
	cooldown=maxf(0.01,fire_interval)
	var origin: Vector3=$Muzzle.global_position
	var query:=PhysicsRayQueryParameters3D.create(origin,origin+global_basis.z*max_range,hit_mask,exclude)
	var hit:=get_world_3d().direct_space_state.intersect_ray(query)
	if not hit.is_empty() and hit.collider.has_method("take_damage"): hit.collider.take_damage(damage)
	fired.emit(hit)
	return true
