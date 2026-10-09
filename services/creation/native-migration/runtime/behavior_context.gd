extends RefCounted
## API 1 context for trusted, immutable creator scripts. Authority owns state;
## presentation owns root/effects. This API is not an operating-system sandbox.
var role = "authority"
var object_id = ""
var component_id = ""
# Stable full identity is available in both roles; the authority root remains null.
var address: Dictionary = {}
var source_revision = ""
var object_version = ""
var ancestry_hash = ""
var source_world_matrix: Array = []
var properties: Dictionary = {}
var state: Dictionary = {}
var local: Dictionary = {}
var players: Array = []
var time = 0.0
var tick = 0
var root: Node3D
var events: Array = []
var tweens: Array[Tween] = []

func emit_event(kind: String, data: Dictionary = {}) -> void:
	var event = {"object_id":object_id,"component_id":component_id,"kind":kind,"data":data.duplicate(true)}
	if not address.is_empty(): event.merge({"address":address.duplicate(true),"source_revision":source_revision,"object_version":object_version,"ancestry_hash":ancestry_hash})
	events.append(event)

func create_tween() -> Tween:
	if root == null or not root.is_inside_tree(): return null
	var tween = root.create_tween()
	tweens.append(tween)
	return tween

func freeze(value: bool) -> void:
	for tween in tweens:
		if not is_instance_valid(tween) or not tween.is_valid(): continue
		if value: tween.pause()
		else: tween.play()

func player(id: String) -> Dictionary:
	for value in players:
		if value.get("id") == id: return value.duplicate(true)
	return {}
