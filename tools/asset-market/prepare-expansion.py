"""Curated CC0 packages. Source bytes stay in .local; GLTF dependencies become GLB."""
from pathlib import Path
import json,struct,base64,shutil,mimetypes,hashlib
root=Path(__file__).resolve().parents[2];work=root/'.local/asset-market';staging=work/'staging';packages=work/'packages'
def glb(source,target):
 original_binary=None
 if source.suffix=='.glb':
  raw=source.read_bytes();length=struct.unpack_from('<I',raw,12)[0];d=json.loads(raw[20:20+length]);original_binary=raw[28+length:]
 else:d=json.loads(source.read_text())
 binary=bytearray();offsets=[]
 def append(b):
  while len(binary)%4:binary.append(0)
  start=len(binary);binary.extend(b);return start
 def read(uri):
  if uri.startswith('data:'):return base64.b64decode(uri.split(',',1)[1])
  path=(source.parent/uri).resolve();assert path.is_relative_to(source.parent.resolve());return path.read_bytes()
 for buf in d.get('buffers',[]):offsets.append(append(read(buf['uri']) if 'uri' in buf else original_binary))
 for view in d.get('bufferViews',[]):view['byteOffset']=offsets[view['buffer']]+view.get('byteOffset',0);view['buffer']=0
 for image in d.get('images',[]):
  if 'uri' not in image:continue
  uri=image.pop('uri');b=read(uri);image['mimeType']=uri[5:].split(';')[0] if uri.startswith('data:') else mimetypes.guess_type(uri)[0];image['bufferView']=len(d['bufferViews']);d['bufferViews'].append({'buffer':0,'byteOffset':append(b),'byteLength':len(b)})
 d['buffers']=[{'byteLength':len(binary)}];j=json.dumps(d,separators=(',',':')).encode();j+=b' '*((-len(j))%4);binary.extend(b'\0'*((-len(binary))%4))
 target.write_bytes(struct.pack('<III',0x46546c67,2,12+8+len(j)+8+len(binary))+struct.pack('<II',len(j),0x4e4f534a)+j+struct.pack('<II',len(binary),0x004e4942)+binary)
def glbjson(p):
 b=p.read_bytes();return json.loads(b[20:20+struct.unpack_from('<I',b,12)[0]])
kay=next((staging/'kaykit-adventures').glob('*/addons/kaykit_character_pack_adventures'))
entries=[]
for key,name in [('Knight','白银骑士'),('Barbarian','荒野战士'),('Mage','秘法师'),('Rogue','游侠刺客')]:entries.append(dict(key='kaykit-'+key.lower(),name='3D '+name,source=kay/'Characters/gltf'/f'{key}.glb',page='https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0',author='Kay Lousberg / KayKit',license=kay/'LICENSE.txt',role='humanoid',genres=['action','adventure','fantasy'],idle='Idle',run='Running_A',jump='Jump_Idle',attack='1H_Melee_Attack_Slice_Horizontal' if key!='Mage' else 'Spellcast_Shoot',hit='Hit_A',death='Death_A'))
for key,name,role,genres,attack in [('soldier','突击士兵','humanoid',['shooter','action'],'Idle_Shoot'),('hazmat','防化枪手','humanoid',['shooter','survival'],'Idle_Shoot'),('zombie-basic','感染者','zombie',['survival','action'],'Idle_Attack'),('zombie-chubby','重型僵尸','zombie',['survival','action'],'Idle_Attack'),('zombie-ribcage','残躯爬行者','zombie',['survival'],'Crawl'),('monster-demon','赤焰恶魔','monster',['fantasy','action'],'Punch'),('monster-orc','重装兽人','monster',['fantasy','action'],'Punch'),('monster-blob','绿沼史莱姆','monster',['fantasy','adventure'],'Bite_Front')]:
 page='toonshootergamekit' if key in ['soldier','hazmat'] else 'zombieapocalypsekit' if key.startswith('zombie') else 'ultimatemonsters'
 entries.append(dict(key=key,name='3D '+name,source=staging/'expansion'/f'{key}.gltf',page=f'https://quaternius.com/packs/{page}.html',author='Quaternius',license=staging/'expansion'/('zombie-license.txt' if key.startswith('zombie') else 'monster-license.txt'),role=role,genres=genres,idle='Idle',run='Walk' if key=='monster-blob' else 'Crawl' if key=='zombie-ribcage' else 'Run',jump='Jump',attack=attack,hit='HitRecieve' if key=='monster-blob' else 'HitReact',death='Death',ranged=key in ['soldier','hazmat']))
for key,name in [('suv','越野车'),('race','赛道跑车'),('police','巡逻警车'),('truck','运输卡车')]:entries.append(dict(key='vehicle-'+key,name='3D '+name,source=staging/'car-kit/Models/GLB format'/f'{key}.glb',page='https://kenney.nl/assets/car-kit',author='Kenney',license=staging/'car-kit/License.txt',role='vehicle',genres=['racing','survival']))
for key,name in [('rifle','突击步枪'),('shotgun','霰弹枪')]:entries.append(dict(key='weapon-'+key,name='3D '+name,source=staging/'expansion'/f'{key}.gltf',page='https://quaternius.com/packs/toonshootergamekit.html',author='Quaternius',license=staging/'expansion/monster-license.txt',role='weapon',genres=['shooter','action']))
metadata=json.loads((work/'package-metadata.json').read_text());metadata=[m for m in metadata if m['id'] not in ['official-3d-'+e['key'] for e in entries]]
for e in entries:
 id='official-3d-'+e['key'];out=packages/id;out.mkdir(exist_ok=True);glb(e['source'],out/'model.glb');data=glbjson(out/'model.glb');animations=[a['name'] for a in data.get('animations',[])];role=e['role'];vehicle=role=='vehicle';weapon=role=='weapon';entry='vehicle.tscn' if vehicle else 'weapon.tscn' if weapon else 'character.tscn'
 meta=dict(id=id,name=e['name'],dimension='3d',category='vehicle' if vehicle else 'weapon' if weapon else 'character',role=role,genres=e['genres'],styles=['low-poly','toon'],author=e['author'],source_url=e['page'],license='CC0-1.0',redistribution_confirmed=True,entry_path=entry,screenshots=['cover.png'],preview={'type':'model','path':'model.glb'},animations=animations,tags=[e['key'],e['name'],'GLB','Godot'],capabilities=['drive','controllable','ai-input'] if vehicle else ['ranged'] if weapon else ['controllable','animated','rigged','jump','ai-input']+([] if e['key']=='zombie-ribcage' else ['ranged' if e.get('ranged') else 'melee']))
 if vehicle:
  script='vehicle_controller_3d.gd';meta.update(description='轮廓清晰、材质齐全的'+e['name'][3:]+'，封装为 Godot 街机驾驶预制件，可接玩家或 AI 的油门、转向与刹车输入。',features=['原生碰撞、前进 / 倒车、加速、转向与刹车','跟随镜头，WASD / 方向键驾驶，空格刹车','set_drive_input(throttle, steering, brake) 接口'],usage='实例化 vehicle.tscn 并放在地面。默认 +Z 前进，max_speed / reverse_speed / acceleration / brake_force 可调。已有相机时关闭 camera_enabled，AI 驾驶关闭 keyboard_enabled 后调用 set_drive_input。这是街机运动控制器，不含悬架模拟、轮胎滚动动画、乘员或上下车系统。')
  scene='''[gd_scene load_steps=4 format=3]
[ext_resource type="Script" path="res://controller.gd" id="1"]
[ext_resource type="PackedScene" path="res://model.glb" id="2"]
[sub_resource type="BoxShape3D" id="shape"]
size = Vector3(1.8, 1.1, 3.4)
[node name="Vehicle" type="CharacterBody3D"]
script = ExtResource("1")
floor_snap_length = 0.3
[node name="Visual" type="Node3D" parent="."]
[node name="Model" parent="Visual" instance=ExtResource("2")]
[node name="CollisionShape3D" type="CollisionShape3D" parent="."]
position = Vector3(0, 0.75, 0)
shape = SubResource("shape")
[node name="CameraRig" type="Node3D" parent="."]
position = Vector3(0, 1.8, 0)
rotation = Vector3(-0.3, 3.14159, 0)
[node name="SpringArm3D" type="SpringArm3D" parent="CameraRig"]
spring_length = 7.0
[node name="Camera3D" type="Camera3D" parent="CameraRig/SpringArm3D"]
current = true
'''
 elif weapon:
  script='weapon_3d.gd';meta.update(description='适合卡通射击游戏的独立'+e['name'][3:]+'模型，附可配置射线命中组件，可装配到角色手部或第一人称武器节点。',features=['独立 GLB 和原生武器预制件','fire(exclude) 冷却 / 射线检测 / 伤害接口','fired(hit) 信号用于接枪口特效、弹痕与音效'],usage='将 weapon.tscn 挂到角色手部 BoneAttachment3D 或相机武器节点，并按模型调位置。调用 fire([持有者.get_rid()]) 排除自身；局部 +Z 为射线方向。被击中对象可实现 take_damage(amount)。damage / fire_interval / max_range / hit_mask 可调。本包不含武器动画、弹药、装填、散射、声音或枪口特效；霰弹枪当前同为单射线组件，由游戏自行扩展散射。')
  scene='''[gd_scene load_steps=3 format=3]
[ext_resource type="Script" path="res://controller.gd" id="1"]
[ext_resource type="PackedScene" path="res://model.glb" id="2"]
[node name="Weapon" type="Node3D"]
script = ExtResource("1")
[node name="Model" parent="." instance=ExtResource("2")]
[node name="Muzzle" type="Marker3D" parent="."]
position = Vector3(0, 0.05, 0.65)
'''
 else:
  script='action_controller_3d.gd';meta.update(description=f"{e['name'][3:]}，包含 {len(animations)} 个实际骨骼动画：待机、移动及动作。已封装碰撞、移动、跳跃、受伤 / 死亡与可配置动作接口。",features=[f'{len(animations)} 个骨骼动画，可在预览中逐个播放','WASD 移动、空格跳跃、Shift 奔跑、F 触发动作','生命值、受伤、死亡状态与事件','可切换键盘控制 / set_move_input AI 输入']+(['射线射击、冷却、命中与 take_damage 伤害接口'] if e.get('ranged') else [] if e['key']=='zombie-ribcage' else ['近战前向短射线、冷却与伤害接口']),usage='将 character.tscn 放在地面。movement_speed / jump_speed / max_health 可调。'+('默认键盘与相机开启。' if role=='humanoid' else '默认关闭键盘与镜头，方便作为敌人；开启两者即可玩家控制。需由游戏 AI 调用 set_move_input 和 trigger_primary，本包不自动追敌。')+' F / trigger_primary() 触发映射动作；attack_hit、health_changed、died 可接战斗规则，take_damage(amount) 扣血。'+('射击沿角色正前方单射线，默认80米。' if e.get('ranged') else '近战为正前方短射线，按游戏调整 attack_range。')+' 动画库中的翻滚、施法等额外动作仅提供动画，不代表已经实现技能。不包含武器切换、弹药、自动寻路、音效和特效系统。模型包保持原作者文件中的全部动画。')
  if e['key']=='zombie-ribcage':meta['usage']+=' 此残躯仅提供爬行移动，trigger_primary 映射爬行姿态，默认 attack_damage=0；需要攻击的僵尸请选感染者或重型僵尸。'
  scene=(packages/'official-3d-skaterMaleA/character.tscn').read_text().replace('scale = Vector3(0.48, 0.48, 0.48)','scale = Vector3(1, 1, 1)')
  opts='\n'.join(f'{k}_animation = "{e[k]}"' for k in ['idle','run','jump','attack','hit','death'])+'\nkeyboard_enabled = '+('true' if role=='humanoid' else 'false')+'\ncamera_enabled = '+('true' if role=='humanoid' else 'false')+'\nattack_mode = '+('1' if e.get('ranged') else '0')+'\nattack_range = '+('80.0' if e.get('ranged') else '2.0')+'\n'
  if e['key']=='zombie-ribcage':opts+='attack_damage = 0.0\n'
  scene=scene.replace('floor_snap_length = 0.25','floor_snap_length = 0.25\n'+opts)
 shutil.copy(root/'tools/asset-market'/script,out/'controller.gd');(out/entry).write_text(scene)
 shutil.copy(e['license'],out/'LICENSE.txt');
 if 'toonshootergamekit' in e['page']:(out/'LICENSE.txt').write_text('Toon Shooter Game Kit by Quaternius. Licensed CC0 1.0 Universal, as stated on the author page: '+e['page']+'\nhttps://creativecommons.org/publicdomain/zero/1.0/\n')
 (out/'SOURCE.txt').write_text('Original art: '+e['author']+'\nSource: '+e['page']+'\nLicense verified on original author page: CC0 1.0\nRetrieved 2026-09-10\nSource file SHA256: '+hashlib.sha256(e['source'].read_bytes()).hexdigest()+'\n')
 (out/'README.txt').write_text(meta['usage']+'\n\n'+(out/'SOURCE.txt').read_text());shutil.copy(packages/'official-3d-skaterMaleA/CONTROLLER-LICENSE.txt',out/'CONTROLLER-LICENSE.txt');metadata.append(meta)
(work/'package-metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2));print('Packages:',len(metadata))
