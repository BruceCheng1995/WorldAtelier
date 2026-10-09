extends Node
## Migration-only API 1 behavior adapter. Every creator property is an
## independent exported property in the generated subclass, never one bundle.
@export var behavior_id: String = ""
@export var source_script: Script
@export var script_hash: String = ""

func legacy_properties() -> Dictionary:
	return {}
