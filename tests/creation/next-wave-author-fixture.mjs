// Authored content for the independent next-wave acceptance journey.
// Import through the ordinary native source transaction. These scenes produce
// actual user-input effects; no fixture emits a positive platform runtime ACK.

const rootKey = JSON.stringify([[], 'world-root']);
const field = value => JSON.stringify(value);
const bind = action => field({target_key: rootKey, action, payload: {}});

const project = `config_version=5
[application]
config/name="Next Wave Independent Journey"
run/main_scene="res://scenes/a.tscn"
[autoload]
JourneyLedger="*res://scripts/ledger.gd"
IsolationProbe="*res://scripts/isolation_probe.gd"
[display]
window/size/viewport_width=1000
window/size/viewport_height=700
window/stretch/mode="canvas_items"
[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
environment/defaults/default_clear_color=Color(0.035,0.06,0.10,1)
[input]
move_right={"deadzone":0.5,"events":[Object(InputEventKey,"physical_keycode":68)]}
move_left={"deadzone":0.5,"events":[Object(InputEventKey,"physical_keycode":65)]}
`;

const mainScript = `extends Node2D
@export var allow_open: bool = false
@export var counter_step: int = 1
var attempts: int = 0
var door_open: bool = false
var ticks: int = 0
var spawned: int = 0
var last_actor: String = ""
var joined_players: Array = []
var shared: Variant

func _ready() -> void:
\tvar runtime: Node = get_node_or_null("/root/GameRuntime")
\tif runtime != null and runtime.get("shared") != null:
\t\tshared = runtime.get("shared")
\t\tif shared.is_authority():
\t\t\tshared.player_joined.connect(_player_joined)
\t\t\tshared.scene_loaded.connect(_scene_loaded)
\telse:
\t\t$HUD/Door.pressed.connect(func(): interact("local", {}))
\t\t$HUD/Next.pressed.connect(func(): next_scene("local", {}))
\t\t$HUD/Spawn.pressed.connect(func(): spawn_marker("local", {}))
\t\t$HUD/Despawn.pressed.connect(func(): despawn_marker("local", {}))
\t\t$HUD/Save.pressed.connect(save_progress)
\t\t$HUD/Load.pressed.connect(load_progress)
\trefresh_label()

func _physics_process(_delta: float) -> void:
\tticks += counter_step
\trefresh_label()

func _input(event: InputEvent) -> void:
\tif event is InputEventKey and event.pressed and not event.echo and event.physical_keycode == KEY_W:
\t\tget_viewport().set_input_as_handled()
\t\tprint("NW_AUTHOR_CONSUMED_W")

func _unhandled_key_input(event: InputEvent) -> void:
\tif shared != null or not event is InputEventKey or not event.pressed or event.echo: return
\tif event.physical_keycode == KEY_E: interact("local", {})

func interact(player_id: String, _payload: Variant) -> void:
\tattempts += 1
\tlast_actor = player_id
\t# This intentionally broken author rule is repaired by the real creator Agent.
\tif allow_open and attempts >= 2: door_open = true
\tget_node("/root/JourneyLedger").total_interactions += 1
\trefresh_label()
\tprint("NW_AUTHOR_INTERACTION scene=", name, " attempts=", attempts, " open=", door_open)

func refresh_label() -> void:
\t$HUD/Counter.text = "%s | clicks=%d | open=%s | tick=%d | total=%d" % [name, attempts, str(door_open), ticks, get_node("/root/JourneyLedger").total_interactions]
\t$HUD/Door.text = "Door is open" if door_open else "Open door (click twice)"
\t$DoorVisual.color = Color(0.15,0.85,0.4,1) if door_open else Color(0.75,0.2,0.14,1)

func save_progress() -> void:
\tvar file: FileAccess = FileAccess.open("user://next-wave-progress.json", FileAccess.WRITE)
\tif file == null: push_error("NW_SAVE_FAILED"); return
\tfile.store_string(JSON.stringify({"attempts":attempts,"door_open":door_open,"total":get_node("/root/JourneyLedger").total_interactions}))
\tfile.close()
\tprint("NW_AUTHOR_SAVED clicks=", attempts)

func load_progress() -> void:
\tif not FileAccess.file_exists("user://next-wave-progress.json"):
\t\tprint("NW_AUTHOR_NO_SAVE")
\t\treturn
\tvar data: Variant = JSON.parse_string(FileAccess.get_file_as_string("user://next-wave-progress.json"))
\tif not data is Dictionary: push_error("NW_SAVE_INVALID"); return
\tattempts = int(data.get("attempts",0))
\tdoor_open = bool(data.get("door_open",false))
\tget_node("/root/JourneyLedger").total_interactions = int(data.get("total",0))
\trefresh_label()
\tprint("NW_AUTHOR_LOADED clicks=", attempts)

func next_scene(_player_id: String, _payload: Variant) -> void:
\tvar runtime: Node = get_node("/root/GameRuntime")
\truntime.open_scene("journey-b" if runtime.current_scene_id == "journey-a" else "journey-a")

func _scene_loaded(_resource_id: String, _generation: int) -> void:
\tif get_tree().current_scene != self or shared.restoring: return
\tfor player in shared.players():
\t\tif player.online: _player_joined(player)

func _player_joined(player: Dictionary) -> void:
\tif str(player.id) in joined_players: return
\tjoined_players.append(str(player.id))
\tvar actor: Node2D = shared.spawn("journey-actor", "player-" + str(player.id), shared.key_for(self), str(player.id), {}) as Node2D
\tif actor != null: actor.position = Vector2(140 + abs(str(player.id).hash()) % 300, 540)

func spawn_marker(player_id: String, _payload: Variant) -> void:
\tspawned += 1
\tif shared != null:
\t\tvar actor: Node2D = shared.spawn("journey-actor", "marker-" + str(spawned), shared.key_for(self), player_id, {}) as Node2D
\t\tif actor != null: actor.position = Vector2(120 + spawned * 90, 440)
\telse:
\t\tvar actor: Node2D = load("res://prefabs/actor.tscn").instantiate() as Node2D
\t\tactor.name = "EphemeralMarker" + str(spawned)
\t\tactor.position = Vector2(120 + spawned * 90, 440)
\t\tadd_child(actor)

func despawn_marker(_player_id: String, _payload: Variant) -> void:
\tif shared != null:
\t\tif spawned > 0: shared.despawn("marker-" + str(spawned))
\telse:
\t\tvar actor: Node = get_node_or_null("EphemeralMarker" + str(spawned))
\t\tif actor != null: actor.queue_free()
`;

const ledger = `extends Node
var total_interactions: int = 0
func _ready() -> void:
\tset_meta("wa_node_id", "journey-ledger")
\tset_meta("wa_shared", {"version":1,"state":["total_interactions"]})
`;

const actor = `extends Node2D
@export var speed: float = 130.0
var motion: float = 0.0
var distance: float = 0.0
var last_actor: String = ""
func _physics_process(delta: float) -> void:
\tposition.x += motion * speed * delta
\tdistance += abs(motion * speed * delta)
func move(player_id: String, payload: Variant) -> void:
\tlast_actor = player_id
\tmotion = clampf(float(payload.get("x",0)), -1, 1)
func stop(player_id: String) -> void:
\tlast_actor = player_id
\tmotion = 0.0
`;

// Only the independent service on 48921 is a permitted network target.
// Report booleans/statuses, never actual creator tokens or response contents.
const isolationProbe = `extends Node
func _ready() -> void:
\tif not OS.has_feature("web"): return
\tJavaScriptBridge.eval("""
(() => {
  let parameter = new URLSearchParams(location.search).get('nw_creator_origin');
  if (!parameter) try { parameter = JSON.parse(parent.document.querySelector('#runtime-config').textContent).parent_origin; } catch {}
  if (!parameter) return;
  const target = new URL(parameter);
  if (target.port !== '48921' || !['127.0.0.1', 'localhost'].includes(target.hostname)) return;
  const result = window.__nextWaveIsolation = {origin:location.origin, creator_origin:target.origin, secure_context:isSecureContext, at:Date.now()};
  for (const [name, read] of [
    ['parent_dom', () => top.document.body],
    ['parent_token', () => top.sessionStorage.getItem('world-atelier-creator-token')],
    ['own_creator_token', () => sessionStorage.getItem('world-atelier-creator-token')]
  ]) {
    try { result[name] = {readable:true,present:!!read()}; }
    catch (error) { result[name] = {readable:false,error:error.name}; }
  }
  const check = async (name, url) => {
    try { const r = await fetch(url, {credentials:'include',cache:'no-store'}); result[name] = {readable:true,status:r.status,ok:r.ok}; }
    catch (error) { result[name] = {readable:false,error:error.name}; }
  };
  Promise.all([
    check('creator_admin', target.origin + '/creation-api/admin/overview'),
    check('runtime_admin', location.origin + '/creation-api/admin/overview'),
    check('runtime_bootstrap', location.origin + '/creation-api/bootstrap')
  ]).then(() => { result.completed = true; console.log('NW_ISOLATION_PROBE ' + JSON.stringify(result)); });
})();
""")
`;

const actorScene = `[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://scripts/actor.gd" id="actor-script"]
[node name="Actor" type="Node2D"]
script = ExtResource("actor-script")
metadata/wa_node_id = "actor-root"
metadata/wa_shared = {"version":1,"state":["motion","distance","last_actor"],"defaults":["speed"],"inputs":{"move":{"method":"move","owner":true}},"input_stop":"stop"}
[node name="Shape" type="Polygon2D" parent="."]
polygon = PackedVector2Array(-18,-18,18,-18,18,18,-18,18)
color = Color(0.1,0.65,1,1)
metadata/wa_node_id = "actor-visual"
`;

function scene(name) {
  return `[gd_scene load_steps=3 format=3]
[ext_resource type="Script" path="res://scripts/main.gd" id="main-script"]
[ext_resource type="PackedScene" path="res://prefabs/actor.tscn" id="actor-scene"]

; Unknown-to-the-Web author content must survive merges byte-for-byte.
[node name="${name}" type="Node2D"]
script = ExtResource("main-script")
metadata/wa_node_id = "world-root"
metadata/wa_shared = {"version":1,"state":["attempts","door_open","ticks","spawned","last_actor","joined_players"],"defaults":["allow_open","counter_step"],"inputs":{"interact":{"method":"interact","owner":false},"next":{"method":"next_scene","owner":false},"spawn":{"method":"spawn_marker","owner":false},"despawn":{"method":"despawn_marker","owner":false}}}
metadata/wa_shared_keys = [{"input_action":"move_right","target_key":"@owner:actor-root","action":"move","payload":{"x":1},"released_payload":{"x":0}},{"input_action":"move_left","target_key":"@owner:actor-root","action":"move","payload":{"x":-1},"released_payload":{"x":0}}]
metadata/author_note = "Keep this author metadata, including quoted punctuation: a;b=c."

[node name="DoorVisual" type="Polygon2D" parent="."]
position = Vector2(500,300)
polygon = PackedVector2Array(-65,-95,65,-95,65,95,-65,95)
color = Color(0.75,0.2,0.14,1)
metadata/wa_node_id = "door-visual"
metadata/wa_shared = {"version":1,"state":["color"]}

[node name="SamePrefabLeft" parent="." instance=ExtResource("actor-scene")]
position = Vector2(250,350)
metadata/wa_instance_id = "static-left"
[node name="SamePrefabRight" parent="." instance=ExtResource("actor-scene")]
position = Vector2(750,350)
metadata/wa_instance_id = "static-right"

[node name="HUD" type="CanvasLayer" parent="."]
metadata/wa_node_id = "hud"
[node name="Counter" type="Label" parent="HUD"]
offset_left = 24.0
offset_top = 20.0
offset_right = 980.0
offset_bottom = 62.0
theme_override_font_sizes/font_size = 24
text = "${name} | initial"
metadata/wa_node_id = "counter-label"
metadata/wa_shared = {"version":1,"state":["text"]}
${button('Door', 'door-button', 'Open door (click twice)', 24, 90, 265, 145, 'interact')}
${button('Next', 'next-button', 'Next scene', 280, 90, 440, 145, 'next')}
${button('Spawn', 'spawn-button', 'Create marker', 455, 90, 625, 145, 'spawn')}
${button('Despawn', 'despawn-button', 'Remove marker', 640, 90, 825, 145, 'despawn')}
${button('Save', 'save-button', 'Save progress', 24, 610, 225, 665)}
${button('Load', 'load-button', 'Load progress', 240, 610, 440, 665)}
`;
}

function button(name, id, text, left, top, right, bottom, action = null) {
  return `[node name="${name}" type="Button" parent="HUD"]
offset_left = ${left}.0
offset_top = ${top}.0
offset_right = ${right}.0
offset_bottom = ${bottom}.0
text = ${field(text)}
metadata/wa_node_id = ${field(id)}
metadata/wa_shared = {"version":1,"state":["text"]}
${action ? `metadata/wa_shared_bind = ${bind(action)}` : ''}
`;
}

export function nextWaveAuthorFiles() {
  const catalog = {format:1, entry_scene_id:'journey-a', resources:{
    'journey-a':{id:'journey-a',kind:'scene',name:'Door Journey A',path:'scenes/a.tscn'},
    'journey-b':{id:'journey-b',kind:'scene',name:'Door Journey B',path:'scenes/b.tscn'},
    'journey-actor':{id:'journey-actor',kind:'prefab',name:'Owned marker',path:'prefabs/actor.tscn'},
  }};
  return new Map(Object.entries({
    'project.godot':project,
    '.atelier/catalog.json':JSON.stringify(catalog,null,2)+'\n',
    'scenes/a.tscn':scene('JourneyA'),
    'scenes/b.tscn':scene('JourneyB'),
    'prefabs/actor.tscn':actorScene,
    'scripts/main.gd':mainScript,
    'scripts/ledger.gd':ledger,
    'scripts/actor.gd':actor,
    'scripts/isolation_probe.gd':isolationProbe,
    'opaque/author-notes.txt':'Keep CRLF and unknown author bytes.\r\nSecond line = untouched.\r\n',
    'opaque/author.bin':Buffer.from([0,1,128,255,13,10,0,42]),
  }).map(([path,bytes])=>[path,Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes)]));
}

export function nativeImportFiles(files = nextWaveAuthorFiles()) {
  return [...files].map(([path,bytes])=>({path,data_base64:bytes.toString('base64')}));
}
