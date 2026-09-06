"""Generate independent real Godot scenes for all authored objects and systems.
Outputs go to an ignored directory; runtime source and live state are untouched.
"""
import argparse, pathlib, json, copy, hashlib, base64, collections
repo=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--output',type=pathlib.Path,default=repo/'runtimes/godot/.local/prefab-scenes');args=parser.parse_args()
output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
world=json.loads((repo/'content/world.json').read_text());items=[]

def base():
    c=copy.deepcopy(world);c['objects']=[];c['enemies']=[]
    c['zones']=[{'id':'observatory','name':'Isolated prefab fixture','x':0,'z':0,'radius':40,'color':'#35566d'}]
    c['spawn']={'x':3,'z':0}
    return c

def obj(kind):
    result=copy.deepcopy(next(o for o in world['objects'] if o['kind']==kind));result.update(x=0,z=0,zone_id='observatory');return result

def add(key,category,kind,content,subject='',source=''):
    document={'id':key,'category':category,'kind':kind,'subject_id':subject,'source_id':source,'content':content,'scope':'Isolated fixture; controlled starting positions/resources/phase are explicit, never a live world mutation.'}
    config=output/(key+'.json');config.write_text(json.dumps(document,ensure_ascii=False,indent=2)+'\n')
    scene=output/(key+'.tscn')
    scene.write_text('[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://tests/prefab_fixture.gd" id="1"]\n\n[node name="IsolatedPrefab" type="Node3D"]\nscript = ExtResource("1")\nfixture_json = '+json.dumps(str(config))+'\n')
    items.append({'id':key,'category':category,'kind':kind,'source_id':source,'scene':str(scene),'config':str(config)})

for original in world['objects']:
    c=base();o=copy.deepcopy(original);o.update(x=0,z=0,zone_id='observatory');c['objects']=[o]
    c['spawn']['x']=max(3,o.get('radius',.7)*o.get('scale',1)+.8) if o.get('solid') else 3
    add('object-'+o['id'],'object',o['kind'],c,o['id'],original['id'])
# Platform is supported by the runtime but not placed in the current campaign.
c=base();c['objects']=[{'id':'supported_platform','kind':'platform','name':'Supported platform prefab','x':0,'z':0,'zone_id':'observatory','scale':1,'radius':2.5,'solid':False,'color':'#72dad2'}]
add('object-supported_platform','object','platform',c,'supported_platform','supported-but-unplaced')
for original in world['enemies']:
    c=base();e=copy.deepcopy(original);e.update(x=0,z=0,zone_id='observatory');c['enemies']=[e];c['spawn']['x']=2
    add('enemy-'+e['id'],'enemy',e['kind'],c,e['id'],original['id'])

systems=['selection','editing','testing','delivered','failed','move_and_dash','combat','death_respawn','collection_reward','beacon_progress','upgrade_and_healing','collision','content_replacement','offline_restore','player_avatar','model_binding']
for system in systems:
    c=base();subject=''
    kind={'collection_reward':'crystal','beacon_progress':'beacon','upgrade_and_healing':'forge','collision':'rock','content_replacement':'crystal','offline_restore':'crystal'}.get(system,'monument')
    o=obj(kind);o['scale']=1;c['objects']=[o];subject=o['id'];c['spawn']['x']=max(3,o.get('radius',.7)+.8)
    if system in ['combat','death_respawn']:
        c['objects']=[];e=copy.deepcopy(next(e for e in world['enemies'] if e['kind']=='brute'));e.update(x=0,z=0,zone_id='observatory');c['enemies']=[e];subject=e['id'];c['spawn']['x']=2
    if system=='move_and_dash':c['objects']=[]
    if system=='upgrade_and_healing':
        supply=obj('supply');supply.update(x=3,z=2,scale=1);c['objects'].append(supply)
    if system=='collision':
        c['zones'][0]['radius']=8;b=obj('bridge');b.update(x=12,z=0,rotation=0,length=12,width=4,solid=False);c['objects'].append(b)
    if system=='model_binding':
        binary=(repo/'runtimes/godot/assets/source/live_pipeline/sunforge_relay.glb').read_bytes();h=hashlib.sha256(binary).hexdigest();o['model_asset']=h;c['asset_blobs']={h:{'mime':'model/gltf-binary','data_base64':base64.b64encode(binary).decode()}}
    add('system-'+system,'system',system,c,subject)
inventory={'source_content_sha256':hashlib.sha256((repo/'content/world.json').read_bytes()).hexdigest(),'counts':{'objects':len(world['objects']),'extra_supported_prefabs':1,'enemies':len(world['enemies']),'systems':len(systems),'total':len(items)},'object_kinds':dict(collections.Counter(o['kind'] for o in world['objects'])),'enemy_kinds':dict(collections.Counter(e['kind'] for e in world['enemies'])),'items':items,'limits':['Fixtures seed controlled initial state; this is independent from campaign, central service and Web transport acceptance.','Collision is current authoritative XZ circle/bridge/island geometry, not GLB triangle collision.','Headless verification constructs actual Node3D scenes; only --render captures prove rendered output.','No scene is claimed visually reviewed until its image is inspected.']}
(output/'inventory.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'output':str(output),'counts':inventory['counts'],'object_kinds':inventory['object_kinds'],'enemy_kinds':inventory['enemy_kinds']},ensure_ascii=False))
