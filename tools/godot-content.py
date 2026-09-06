#!/usr/bin/env python3
"""Deterministic authored Starfall Expedition content; no legacy assets."""
import json, math, pathlib, random
root=pathlib.Path(__file__).resolve().parents[1]
rng=random.Random(84107)
zones=[dict(id='observatory',name='星港观测站 · Starport',x=0,z=6,radius=24,color='#32686a'),dict(id='gardens',name='月露花园 · Moondew Gardens',x=-43,z=-21,radius=26,color='#337369'),dict(id='foundry',name='余烬铸炉 · Ember Foundry',x=43,z=-21,radius=26,color='#805148'),dict(id='citadel',name='失落星城 · Astral Citadel',x=0,z=-66,radius=28,color='#54557e')]
objects=[]
def obj(id,name,kind,x,z,zone,**kw):
    o=dict(id=id,name=name,kind=kind,x=round(x,3),z=round(z,3),scale=1,color='#72dad2',solid=False,zone_id=zone)
    o.update(kw);objects.append(o)
obj('starheart','星港核心 / STARHEART','monument',0,-1,'observatory',scale=2.0,color='#99f6f0',solid=True,radius=2.2)
obj('forge_hub','星铸工作台 / UPGRADE','forge',-7,6,'observatory',color='#ffaa55',solid=True,radius=1.6,interactable=True)
obj('supply_hub','远征补给 / RESTORE','supply',7,7,'observatory',color='#7ceeb4',interactable=True)
obj('launch_beacon','航路信标 / ACTIVATE','beacon',0,14,'observatory',color='#72eeff',interactable=True)
obj('garden_beacon','月露信标 / ACTIVATE','beacon',-43,-23,'gardens',color='#72efce',interactable=True)
obj('foundry_beacon','熔星信标 / ACTIVATE','beacon',43,-23,'foundry',color='#ffb44f',interactable=True)
obj('citadel_gate','星城封印 / 3 BEACONS','gate',0,-42,'citadel',scale=1.5,color='#c2a4ff',solid=False,interactable=True)
obj('garden_supply','月露疗愈站','supply',-32,-13,'gardens',interactable=True)
obj('foundry_forge','熔炉工作台','forge',33,-11,'foundry',color='#ffa355',solid=True,interactable=True)
obj('citadel_supply','遗迹医疗站','supply',-12,-53,'citadel',interactable=True)
# Route platforms provide broad readable traversal corridors.
for i,(a,b) in enumerate([((0,6),(-43,-21)),((0,6),(43,-21)),((-43,-21),(0,-66)),((43,-21),(0,-66))]):
    ax,az=a;bx,bz=b
    distance=math.hypot(bx-ax,bz-az);ux=(bx-ax)/distance;uz=(bz-az)/distance
    start_radius=21 if i<2 else 23;end_radius=23 if i<2 else 25
    ax+=ux*start_radius;az+=uz*start_radius;bx-=ux*end_radius;bz-=uz*end_radius
    obj('bridge_'+str(i),'星屿航桥','bridge',(ax+bx)/2,(az+bz)/2,'observatory',length=math.hypot(bx-ax,bz-az),width=7,rotation=-math.atan2(bz-az,bx-ax),color='#70938c')
for i in range(8):
    angle=i*math.tau/8
    obj('hub_column_'+str(i),'星港立柱','pillar',math.cos(angle)*18,6+math.sin(angle)*18,'observatory',scale=1.25,color='#6da7ad',solid=True,radius=.65)
for zone in zones:
    zid=zone['id'];cx=zone['x'];cz=zone['z']
    # Clear central play areas, layered perimeter silhouettes.
    for i in range(30 if zid!='observatory' else 22):
        a=i*math.tau/(30 if zid!='observatory' else 22)+rng.uniform(-.05,.05)
        rr=zone['radius']-rng.uniform(1.5,6)
        k='tree' if zid in ['gardens','observatory'] else ('rock' if zid=='foundry' else 'pillar')
        col=rng.choice(['#286b62','#438f7a','#76b58b']) if k=='tree' else (rng.choice(['#85525b','#b67b58','#694c62']) if k=='rock' else '#8292bd')
        obj(f'{zid}_scenery_{i}',{'tree':'星叶树','rock':'辉晶岩','pillar':'遗迹柱'}[k],k,cx+math.cos(a)*rr,cz+math.sin(a)*rr,zid,scale=round(rng.uniform(.7,1.8),2),color=col,solid=True,radius=.7)
    for i in range(10 if zid!='observatory' else 14):
        a=rng.random()*math.tau;rr=rng.uniform(6,17)
        obj(f'{zid}_crystal_{i}','星晶 / COLLECT','crystal',cx+math.cos(a)*rr,cz+math.sin(a)*rr,zid,scale=rng.uniform(.6,1),color='#a5f7f3' if zid!='foundry' else '#ffc46a',interactable=True)
    for i in range(8):
        a=i*math.tau/8
        obj(f'{zid}_lamp_{i}','导航光标','lamp',cx+math.cos(a)*11,cz+math.sin(a)*11,zid,scale=.6,color=zone['color'])
for i,(x,z) in enumerate([(2,6),(3,7),(4,5),(-2,8),(-3,9),(5,10)]):obj(f'landing_crystal_{i}','启程星晶 / COLLECT','crystal',x,z,'observatory',color='#a5f7f3',interactable=True)
# Architectural foundry apparatus, garden blossoms and citadel arches.
for i,(x,z) in enumerate([(35,-28),(49,-31),(50,-12)]):obj('furnace_'+str(i),'恒星熔炉','furnace',x,z,'foundry',scale=1.4,color='#f1a15e',solid=True,radius=1.6)
for i,(x,z) in enumerate([(-49,-32),(-33,-29),(-48,-12)]):obj('garden_flower_'+str(i),'月露莲','flower',x,z,'gardens',scale=2,color='#e2a9df')
for i,(x,z) in enumerate([(-11,-69),(11,-69),(-11,-79),(11,-79)]):obj('citadel_arch_'+str(i),'星城石门','arch',x,z,'citadel',scale=1.2,color='#9eabc8',solid=True,radius=1)
obj('astral_throne','天穹王座','monument',0,-81,'citadel',scale=2.4,color='#c5a6fc',solid=True,radius=2)
enemies=[]
for zid,cx,cz,count in [('gardens',-43,-21,15),('foundry',43,-21,16),('citadel',0,-66,14)]:
    for i in range(count):
        a=i*2.399;rr=7+(i%4)*3.1
        kind=['sentinel','stalker','artillerist','sentinel','brute'][i%5]
        enemies.append(dict(id=f'{zid}_enemy_{i}',kind=kind,x=round(cx+math.cos(a)*rr,3),z=round(cz+math.sin(a)*rr,3),hp={'sentinel':80,'stalker':55,'artillerist':65,'brute':160}[kind],zone_id=zid))
enemies.append(dict(id='boss_asterion',kind='boss',x=0,z=-71,hp=1400,zone_id='citadel',name='ASTERION · 碎星守望者'))
world=dict(schema=1,title='星屿远征 · Starfall Expedition',revision_label='FIRST LIGHT / 初光远征',spawn=dict(x=0,z=6),zones=zones,objects=objects,enemies=enemies,rules=dict(player_speed=8,attack_damage=34,enemy_damage=11,bounds=110,attack_range=4.5,attack_cooldown=.38,dash_cooldown=1.1),quests=[dict(id='gather',title='Ⅰ · 星晶勘探',description='收集 12 枚星晶，在工作台升级武器。',target=12),dict(id='beacons',title='Ⅱ · 重连星路',description='点亮星港、月露花园与余烬铸炉的 3 座信标。',target=3),dict(id='warden',title='Ⅲ · 碎星守望',description='击败星城的 ASTERION，重新点亮天穹。',target=1)])
for file in [root/'content/world.json',root/'runtimes/godot/content/world.json']:
    file.parent.mkdir(parents=True,exist_ok=True);file.write_text(json.dumps(world,ensure_ascii=False,indent=2)+'\n')
print(f'Authored {len(objects)} objects, {len(enemies)} enemies, {len(zones)} zones')
