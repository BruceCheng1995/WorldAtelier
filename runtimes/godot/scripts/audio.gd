extends Node
var music: AudioStreamPlayer
var last_event = 0
var enabled = false
var streams: Dictionary = {}
func _ready() -> void:
	for name in ["strike", "hit", "dash", "collect", "beacon", "heal", "danger", "first_light"]:
		streams[name] = load("res://assets/audio/" + name + ".wav")
	music = AudioStreamPlayer.new()
	music.stream = streams.first_light
	music.volume_db = -17
	add_child(music)
	music.finished.connect(func():
		if enabled: music.play())
func activate() -> void:
	if not enabled:
		enabled = true
		music.play()
func update_state(state: Dictionary, user_id: String) -> void:
	var player = state.get("players", {}).get(user_id, {})
	for event in state.get("events", []):
		if int(event.id) <= last_event:
			continue
		last_event = int(event.id)
		if not enabled or player.is_empty() or float(state.get("world_time", 0)) - float(event.get("time", 0)) > 1:
			continue
		if Vector2(player.x - event.x, player.z - event.z).length() > 23:
			continue
		var cue = {"slash": "strike", "hit": "hit", "player_hit": "hit", "dash": "dash", "collect": "collect", "beacon": "beacon", "upgrade": "beacon", "victory": "beacon", "heal": "heal", "enemy_attack": "danger"}.get(event.kind, "")
		if cue.is_empty():
			continue
		var voice = AudioStreamPlayer.new()
		voice.stream = streams[cue]
		voice.volume_db = -13 if cue != "hit" else -18
		add_child(voice)
		voice.finished.connect(voice.queue_free)
		voice.play()
