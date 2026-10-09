const subjectId='pea',testId='pea-lab',mainId='main';

/** Real author content. Bullet motion/collision, damage, drops and method-track
 * callbacks come from Godot; tests never manufacture runtime acknowledgements. */
export function prefabLabFixture(){
  const catalog={format:1,entry_scene_id:mainId,resources:{
    [mainId]:{id:mainId,name:'Game entry',kind:'scene',path:'scenes/main.tscn'},
    [subjectId]:{id:subjectId,name:'Pea shooter',kind:'prefab',path:'prefabs/pea.tscn'},
    [testId]:{id:testId,name:'Pea abilities',kind:'scene',purpose:'prefab_test',subject_id:subjectId,path:'test_scenes/pea-lab/scene.tscn'},
  }};
  return {
    'project.godot':'config_version=5\n[application]\nconfig/name="Independent prefab lab"\nrun/main_scene="res://scenes/main.tscn"\n[display]\nwindow/size/viewport_width=1000\nwindow/size/viewport_height=700\nwindow/stretch/mode="canvas_items"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '.atelier/catalog.json':JSON.stringify(catalog,null,2)+'\n',
    'scenes/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://prefabs/pea.tscn" id="1"]\n[node name="Game" type="Node2D"]\nmetadata/wa_node_id="game-root"\n[node name="Pea" parent="." instance=ExtResource("1")]\nposition=Vector2(150,350)\nmetadata/wa_instance_id="game-pea"\n',
    'prefabs/pea.gd':String.raw`extends Node2D
signal fired
var shots = 0
var method_calls = 0
var hp = 100
func _draw():
	draw_circle(Vector2.ZERO, 38, Color("6bd85b"))
	draw_rect(Rect2(18,-14,42,28), Color("3caa53"))
	draw_circle(Vector2(8,-13), 5, Color("153025"))
	draw_line(Vector2(0,35),Vector2(0,75),Color("2f9150"),9)
func fire():
	var projectile = Area2D.new()
	projectile.set_script(load("res://prefabs/projectile.gd"))
	get_parent().add_child(projectile)
	projectile.global_position = global_position + Vector2(65,0)
	shots += 1
	fired.emit()
func animation_marker():
	method_calls += 1
func hurt(damage):
	hp = maxi(0, hp - damage)
	modulate = Color("e59279") if hp < 100 else Color.WHITE
`,
    'prefabs/projectile.gd':String.raw`extends Area2D
var age = 0.0
func _ready():
	add_to_group("lab_projectiles")
	collision_layer = 2
	collision_mask = 4
	var shape = CollisionShape2D.new()
	var circle = CircleShape2D.new()
	circle.radius = 9
	shape.shape = circle
	add_child(shape)
	body_entered.connect(_hit)
func _draw():
	draw_circle(Vector2.ZERO, 9, Color("b0ef6a"))
func _physics_process(delta):
	position.x += delta * 400
	age += delta
	if age > 3: queue_free()
func _hit(body):
	if body.has_method("hurt"):
		body.hurt(25)
		queue_free()
`,
    'prefabs/pea.tscn':String.raw`[gd_scene load_steps=5 format=3]
[ext_resource type="Script" path="res://prefabs/pea.gd" id="1"]
[sub_resource type="Animation" id="idle"]
resource_name = "idle"
length = 0.8
loop_mode = 1
tracks/0/type = "value"
tracks/0/path = NodePath(".:rotation")
tracks/0/interp = 1
tracks/0/keys = {"times":PackedFloat32Array(0,0.4,0.8),"transitions":PackedFloat32Array(1,1,1),"update":0,"values":[0.0,0.08,0.0]}
[sub_resource type="Animation" id="shoot"]
resource_name = "shoot"
length = 0.5
tracks/0/type = "value"
tracks/0/path = NodePath(".:scale")
tracks/0/interp = 1
tracks/0/keys = {"times":PackedFloat32Array(0,0.2,0.5),"transitions":PackedFloat32Array(1,1,1),"update":0,"values":[Vector2(1,1),Vector2(1.3,0.8),Vector2(1,1)]}
tracks/1/type = "method"
tracks/1/path = NodePath(".")
tracks/1/keys = {"times":PackedFloat32Array(0.2),"transitions":PackedFloat32Array(1),"values":[{"method":&"animation_marker","args":[]}]}
[sub_resource type="AnimationLibrary" id="library"]
_data = {"idle":SubResource("idle"),"shoot":SubResource("shoot")}
[node name="Pea" type="Node2D"]
script = ExtResource("1")
metadata/wa_node_id = "pea-root"
[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
libraries = {&"":SubResource("library")}
`,
    'test_scenes/pea-lab/target.gd':String.raw`extends StaticBody2D
var hp = 100
signal damaged(value)
func _ready():
	collision_layer = 4
	collision_mask = 2
func _draw():
	draw_rect(Rect2(-30,-45,60,90),Color("799386"))
	draw_rect(Rect2(-32,-70,64*float(hp)/100.0,8),Color("dd7669"))
func hurt(damage):
	hp = maxi(0,hp-damage)
	queue_redraw()
	damaged.emit(hp)
`,
    'test_scenes/pea-lab/lab.gd':String.raw`extends Node2D
signal atelier_preview_event(event: Dictionary)
var drops = 0
var stance = "idle"
var controller_mode = "manual"
var legacy_fixture_calls = 0
func _ready():
	$Target.damaged.connect(func(hp): atelier_preview_event.emit({"kind":"hit","target_hp":hp}))
	$Subject.fired.connect(func(): atelier_preview_event.emit({"kind":"shot","shots":$Subject.shots}))
	queue_redraw()
func _draw():
	draw_rect(Rect2(0,0,1000,700),Color("142b29"))
	draw_line(Vector2(60,430),Vector2(940,430),Color("365b49"),3)
func atelier_preview_capabilities() -> Dictionary:
	return {"title":"Pea active preview","description":"Native animation, abilities and states with separate scene fixtures.","actions":[
		{"id":"shoot","label":"Fire pea","scope":"subject","kind":"ability","description":"Fire one real projectile."},
		{"id":"drop","label":"Drop sun","scope":"subject","kind":"ability"},
		{"id":"angry","label":"Angry state","scope":"subject","kind":"state","mode":"select"},
		{"id":"idle_on","label":"Idle controller on","scope":"subject","kind":"controller","mode":"select"},
		{"id":"idle_off","label":"Idle controller off","scope":"subject","kind":"controller","mode":"select"},
		{"id":"hurt_subject","label":"External damage","scope":"scene","kind":"passive"},
		{"id":"remove_target","label":"Remove target","scope":"scene","kind":"fixture"},
		{"id":"restore_target","label":"Restore target","scope":"scene","kind":"fixture"},
		{"id":"legacy_fixture","label":"Unclassified legacy action"}
	]}
func atelier_preview_action(id: String, _parameters: Dictionary) -> Dictionary:
	if id == "shoot" and $Target.hp <= 0: return {"ok":false,"error":"Place a target before firing."}
	match id:
		"shoot": $Subject.fire()
		"drop":
			drops += 1
			var sun = Polygon2D.new()
			sun.polygon = PackedVector2Array([Vector2(0,-15),Vector2(15,0),Vector2(0,15),Vector2(-15,0)])
			sun.color = Color("ffe16c")
			sun.position = Vector2(400+drops*40,300)
			add_child(sun)
			atelier_preview_event.emit({"kind":"drop","drops":drops})
		"angry":
			stance = "angry"
			$Subject.modulate = Color("ffbb88")
			atelier_preview_event.emit({"kind":"state","state":stance})
		"idle_on":
			controller_mode = "automatic"
			$Subject/AnimationPlayer.play("idle")
		"idle_off":
			controller_mode = "manual"
			$Subject/AnimationPlayer.pause()
		"hurt_subject": $Subject.hurt(25)
		"remove_target": $Target.hurt(100)
		"restore_target":
			$Target.hp = 100
			$Target.queue_redraw()
		"legacy_fixture": legacy_fixture_calls += 1
		_: return {"ok":false,"error":"Unknown fixture action"}
	return {"ok":true}
func atelier_preview_state() -> Dictionary:
	return {"shots":$Subject.shots,"method_calls":$Subject.method_calls,"target_hp":$Target.hp,"subject_hp":$Subject.hp,"drops":drops,"stance":stance,"controller_mode":controller_mode,"legacy_fixture_calls":legacy_fixture_calls,"projectiles":get_tree().get_nodes_in_group("lab_projectiles").size(),"subject_scale":[$Subject.scale.x,$Subject.scale.y]}
func atelier_preview_selection() -> Dictionary:
	var ids: Array = ["idle_on" if controller_mode == "automatic" else "idle_off"]
	if stance == "angry": ids.append("angry")
	return {"action_ids":ids,"status":stance,"blocked_actions":{"shoot":"Place a target before firing."} if $Target.hp <= 0 else {}}
`,
    'test_scenes/pea-lab/scene.tscn':String.raw`[gd_scene load_steps=5 format=3]
[ext_resource type="Script" path="res://test_scenes/pea-lab/lab.gd" id="1"]
[ext_resource type="PackedScene" path="res://prefabs/pea.tscn" id="2"]
[ext_resource type="Script" path="res://test_scenes/pea-lab/target.gd" id="3"]
[sub_resource type="RectangleShape2D" id="target_shape"]
size = Vector2(60,90)
[node name="PeaLab" type="Node2D"]
script = ExtResource("1")
metadata/wa_node_id = "lab-root"
[node name="Subject" parent="." instance=ExtResource("2")]
position = Vector2(200,350)
metadata/wa_instance_id = "lab-subject"
[node name="Target" type="StaticBody2D" parent="."]
position = Vector2(680,350)
script = ExtResource("3")
[node name="Collision" type="CollisionShape2D" parent="Target"]
shape = SubResource("target_shape")
`,
    'test_scenes/pea-lab/evidence-only.txt':'LAB_DEVELOPMENT_ONLY_MARKER_9d2c\n',
    'test_scenes/pea-lab/plan.json':JSON.stringify({steps:[
      {expect:{path:'observations.target_hp',equals:100}},
      {command:{action:'action',action_id:'shoot',parameters:{}}},
      {wait_frames:120},
      {expect:{path:'observations.shots',equals:1}},
      {expect:{path:'observations.target_hp',equals:75}},
      {command:{action:'action',action_id:'drop',parameters:{}}},
      {expect:{path:'observations.drops',equals:1}},
      {command:{action:'animation',player:'Subject/AnimationPlayer',animation:'shoot'}},
      {command:{action:'seek',time:.25}},
      {expect:{path:'observations.method_calls',equals:0}},
      {expect:{path:'paused',equals:true}},
      {command:{action:'step'}},
    ]}),
    'test_scenes/pea-lab/failing-plan.json':JSON.stringify({steps:[{expect:{path:'observations.target_hp',equals:101}}]}),
    'custom/unknown.bin':Buffer.from([0,255,1,128]),
  };
}
