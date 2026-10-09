"""Package downloaded Kenney CC0 art and our native controllers. Pillow required."""
from pathlib import Path
import json, shutil, struct, hashlib
from PIL import Image
root=Path(__file__).resolve().parents[2]
work=root/'.local/asset-market';packages=work/'packages';packages.mkdir(exist_ok=True)
metadata=[]
def common(asset_id,name,dimension,source,author='Kenney'):
    return dict(id=asset_id,name=name,dimension=dimension,category='character',author=author,source_url=source,license='CC0-1.0',redistribution_confirmed=True,entry_path='character.tscn',screenshots=['cover.png'],tags=['主角','人形','可操控','动画',dimension],engine='Godot 4.6')
animations={'idle':['idle'],'walk':[f'walk{i}' for i in range(8)],'run':['run0','run1'],'jump':['jump'],'fall':['fall'],'climb':['climb0','climb1'],'hurt':['hurt'],'attack':['attack0','attack1','attack2']}
for folder,key,title in [('Male adventurer','maleAdventurer','2D 探险家 · 男'),('Female adventurer','femaleAdventurer','2D 探险家 · 女'),('Female person','femalePerson','2D 城市女孩'),('Zombie','zombie','2D 僵尸行者'),('Robot','robot','2D 战斗机器人')]:
    asset_id='official-2d-'+key;out=packages/asset_id;out.mkdir(exist_ok=True)
    source=work/'staging/toon'/folder/'PNG/Poses HD'
    names=list(dict.fromkeys(n for values in animations.values() for n in values));w,h=192,256;columns=8
    atlas=Image.new('RGBA',(w*columns,h*((len(names)+columns-1)//columns)))
    for i,name in enumerate(names):atlas.paste(Image.open(source/f'character_{key}_{name}.png').convert('RGBA'),((i%columns)*w,(i//columns)*h))
    atlas.save(out/'sprites.png')
    cover=Image.new('RGBA',(720,540),'#e9ece5')
    for i,name in enumerate(['idle','walk2','jump']):
        frame=Image.open(source/f'character_{key}_{name}.png').convert('RGBA');frame=frame.resize((230,307),Image.Resampling.LANCZOS);cover.alpha_composite(frame,(12+i*236,116))
    cover.convert('RGB').save(out/'cover.png')
    text='[gd_resource type="SpriteFrames" load_steps='+str(len(names)+2)+' format=3]\n\n[ext_resource type="Texture2D" path="res://sprites.png" id="1"]\n'
    for i,name in enumerate(names):text+=f'\n[sub_resource type="AtlasTexture" id="frame_{i}"]\natlas = ExtResource("1")\nregion = Rect2({i%columns*w}, {i//columns*h}, {w}, {h})\n'
    text+='\n[resource]\nanimations = [\n'+',\n'.join('{"name": &"'+name+'", "speed": '+str(12 if name=='run' else 9)+'.0, "loop": '+('true' if name in ['idle','walk','run','climb'] else 'false')+', "frames": ['+', '.join('{"duration": 1.0, "texture": SubResource("frame_'+str(names.index(frame))+'")} ' for frame in frames)+']}' for name,frames in animations.items())+'\n]\n'
    (out/'frames.tres').write_text(text)
    shutil.copy(root/'tools/asset-market/controller_2d.gd',out/'controller.gd')
    (out/'character.tscn').write_text('''[gd_scene load_steps=4 format=3]
[ext_resource type="Script" path="res://controller.gd" id="1"]
[ext_resource type="SpriteFrames" path="res://frames.tres" id="2"]
[sub_resource type="CapsuleShape2D" id="shape"]
radius = 22.0
height = 100.0
[node name="Character" type="CharacterBody2D"]
script = ExtResource("1")
[node name="Visual" type="AnimatedSprite2D" parent="."]
position = Vector2(0, -64)
scale = Vector2(0.5, 0.5)
sprite_frames = ExtResource("2")
animation = &"idle"
[node name="CollisionShape2D" type="CollisionShape2D" parent="."]
position = Vector2(0, -50)
shape = SubResource("shape")
[node name="Camera2D" type="Camera2D" parent="."]
position = Vector2(0, -80)
position_smoothing_enabled = true
''')
    shutil.copy(work/'staging/toon/License.txt',out/'LICENSE.txt')
    meta=common(asset_id,title,'2d','https://kenney.nl/assets/toon-characters')
    meta.update(description='清晰的卡通人形角色，包含 8 帧行走、跑步、跳跃、攀爬与攻击动作。原生 CharacterBody2D 控制器适用于横版和俯视冒险。',features=['8 帧行走循环，跑步与跳跃动作','原生碰撞、加减速、跳跃缓冲与土狼时间','横版 / 俯视模式可切换','WASD / 方向键移动，空格跳跃，Shift 跑步','可关闭键盘输入，用 set_move_input 驱动 AI 或触屏'],usage='将 character.tscn 实例化到场景并放到地面上。movement_mode=0 为横版，=1 为俯视；俯视沿用侧身美术，并非四方向角色。movement_speed / jump_speed 可调。角色约 128 像素高。已有相机时关闭 camera_enabled；按需实现攻击伤害，动画不自带战斗规则。输入动作在角色实例化时才注册，使用 wa_character_ 前缀。',preview={'type':'sprite','path':'sprites.png','width':w,'height':h,'columns':columns,'animations':{name:{'frames':[names.index(n) for n in frames],'fps':12 if name=='run' else 9} for name,frames in animations.items()}})
    meta.update(role='zombie' if key=='zombie' else 'robot' if key=='robot' else 'humanoid',genres=['survival','action'] if key=='zombie' else ['scifi','shooter','action'] if key=='robot' else ['adventure','platformer'],styles=['toon'],capabilities=['controllable','animated','jump','ai-input'],animations=list(animations))
    if key in ['zombie','robot']:
        meta['tags']=[title,'可操控','动画','2d'];meta['description']='带待机、移动、跳跃、受伤和攻击姿势的卡通'+('僵尸' if key=='zombie' else '机器人')+'，可作为玩家或由游戏 AI 输入驱动。自带横版 / 俯视移动控制器。'
    metadata.append(meta)
for skin,title in [('skaterMaleA','3D 滑板青年 · 男'),('skaterFemaleA','3D 滑板青年 · 女'),('cyborgFemaleA','3D 机械冒险家')]:
    asset_id='official-3d-'+skin;out=packages/asset_id
    if not (out/'model.glb').exists():continue
    shutil.copy(root/'tools/asset-market/controller_3d.gd',out/'controller.gd');shutil.copy(work/'staging/protagonists/License.txt',out/'LICENSE.txt')
    (out/'character.tscn').write_text('''[gd_scene load_steps=4 format=3]
[ext_resource type="Script" path="res://controller.gd" id="1"]
[ext_resource type="PackedScene" path="res://model.glb" id="2"]
[sub_resource type="CapsuleShape3D" id="shape"]
radius = 0.32
height = 1.8
[node name="Character" type="CharacterBody3D"]
script = ExtResource("1")
floor_snap_length = 0.25
[node name="Visual" type="Node3D" parent="."]
[node name="Model" parent="Visual" instance=ExtResource("2")]
scale = Vector3(0.48, 0.48, 0.48)
[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
position = Vector3(0, 0.9, 0)
shape = SubResource("shape")
[node name="CameraRig" type="Node3D" parent="."]
position = Vector3(0, 1.4, 0)
rotation = Vector3(-0.32, 0, 0)
[node name="SpringArm3D" type="SpringArm3D" parent="CameraRig"]
spring_length = 5.0
margin = 0.2
[node name="Camera3D" type="Camera3D" parent="CameraRig/SpringArm3D"]
current = true
fov = 55.0
''')
    meta=common(asset_id,title,'3d','https://kenney.nl/assets/animated-characters-protagonists')
    meta.update(description='低多边形人形主角，内置真实待机、奔跑与跳跃骨骼动画。独立 GLB 材质与原生 CharacterBody3D 控制器可直接加入游戏。',features=['待机 / 奔跑 / 跳跃骨骼动画与状态切换','胶囊碰撞、加减速与跳跃缓冲','第三人称 / 俯视固定跟随镜头','WASD / 方向键移动，空格跳跃，Shift 奔跑','支持关闭键盘和相机，接入游戏自己的输入与镜头'],usage='将 character.tscn 预制件放在地面。默认约 1.8 米高，朝移动方向转身；camera_mode=1 为俯视镜头。movement_speed、gravity、jump_speed 可调。已有相机时关闭 camera_enabled。set_move_input(Vector2, jump, sprint) 可接 AI / 虚拟摇杆；关闭 keyboard_enabled 后生效。角色包不自动创建地形或战斗规则。',preview={'type':'model','path':'model.glb'})
    meta.update(role='humanoid',genres=['adventure','action'],styles=['low-poly','toon'],capabilities=['controllable','animated','rigged','jump','ai-input'],animations=['idle','run','jump'])
    metadata.append(meta)
for meta in metadata:
    out=packages/meta['id']
    (out/'README.txt').write_text(meta['usage']+'\n\nSource: '+meta['source_url']+'\nArt: Kenney, CC0. Controller adapter: World Atelier, CC0.\n')
    (out/'CONTROLLER-LICENSE.txt').write_text('World Atelier dedicates the controller adapter scripts and scenes to the public domain under CC0 1.0 Universal. https://creativecommons.org/publicdomain/zero/1.0/\nOriginal art license remains in LICENSE.txt.\n')
(work/'package-metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
print(json.dumps({'packages':len(metadata),'directory':str(packages)}))
