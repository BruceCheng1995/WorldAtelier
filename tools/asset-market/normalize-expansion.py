from pathlib import Path
import json,re
root=Path(__file__).resolve().parents[2];w=root/'.local/asset-market';stats=json.loads((w/'model-stats.json').read_text());metadata=json.loads((w/'package-metadata.json').read_text())
for meta in metadata:
 id=meta['id']
 if id not in stats or id in ['official-3d-skaterMaleA','official-3d-skaterFemaleA','official-3d-cyborgFemaleA']:continue
 p=w/'packages'/id/meta['entry_path'];s=p.read_text();v=stats[id];x,y,z=v['size'];px,py,pz=v['position'];role=meta['role']
 if role=='weapon':
  # Original gun barrels point along -X; rotate to the adapter's +Z firing axis.
  s=s.replace('[node name="Muzzle"', 'rotation = Vector3(0, 1.5707963, 0)\n[node name="Muzzle"');s=s.replace('Vector3(0, 0.05, 0.65)','Vector3(0, 0.05, '+str(round(-px,4))+')')
 elif role=='vehicle':
  scale=3.8/z;size=[round(x*scale,4),round(y*scale,4),3.8];center=[round((px+x/2)*scale,4),round((py+y/2)*scale,4),round((pz+z/2)*scale,4)]
  s=s.replace('size = Vector3(1.8, 1.1, 3.4)','size = Vector3('+', '.join(map(str,size))+')').replace('position = Vector3(0, 0.75, 0)','position = Vector3('+', '.join(map(str,center))+')')
  s=s.replace('[node name="CollisionShape3D"',f'scale = Vector3({scale}, {scale}, {scale})\n[node name="CollisionShape3D"')
 else:
  height=1.0 if id.endswith('zombie-ribcage') else 1.2 if id.endswith('monster-blob') else 2.2 if role=='monster' else 1.8
  scale=height/y;radius=0.45 if role=='monster' else 0.32
  s=s.replace('scale = Vector3(1, 1, 1)',f'scale = Vector3({scale}, {scale}, {scale})\nposition = Vector3(0, {-py*scale}, 0)')
  s=s.replace('height = 1.8',f'height = {height}').replace('radius = 0.32',f'radius = {radius}').replace('position = Vector3(0, 0.9, 0)',f'position = Vector3(0, {height/2}, 0)')
  meta['usage']+=f' 适配器角色高度约 {height} 米；可修改 Visual/Model 缩放与碰撞体匹配游戏。'
 p.write_text(s)
 (p.parent/'README.txt').write_text(meta['usage']+'\n\n'+(p.parent/'SOURCE.txt').read_text())
(w/'package-metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
