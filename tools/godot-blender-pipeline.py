"""Fresh, original Sunforge Relay model for Blender -> GLB -> live upload evidence.
Run Blender --background --python tools/godot-blender-pipeline.py [-- --output=/abs]
No existing GLB or .blend is used. Camera/lights are excluded from the export.
"""
import bpy, math, pathlib, sys, json, hashlib, datetime, struct
from mathutils import Vector
repo = pathlib.Path(__file__).resolve().parents[1]
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
output = pathlib.Path(next((a[9:] for a in args if a.startswith('--output=')), str(repo/'runtimes/godot/assets/source/live_pipeline')))
output.mkdir(parents=True, exist_ok=True)
(output/'.gdignore').write_text('')
bpy.ops.wm.read_factory_settings(use_empty=True)
materials = {}
for name, color, metal, glow in [
    ('Obsidian chassis','182D46',.6,0),('Brushed copper','D98C4F',.72,0),
    ('Sunfire ceramic','FFBD4A',.2,0),('Luminous reactor','76FFE3',.1,.20),
    ('Ivory inscription','DDEAD7',.1,0),('Construction yellow','FDCF3F',0,0),
    ('Construction black','121925',0,0)]:
    rgb = [int(color[i:i+2],16)/255 for i in (0,2,4)]
    mat = bpy.data.materials.new(name);mat.diffuse_color=(*rgb,1);mat.use_nodes=True
    bs = mat.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value=(*rgb,1);bs.inputs['Metallic'].default_value=metal;bs.inputs['Roughness'].default_value=.34
    bs.inputs['Emission Color'].default_value=(*rgb,1);bs.inputs['Emission Strength'].default_value=glow
    materials[name]=mat
models=[]
def finish(obj,name,material,bevel=0):
    obj.name=name;obj.data.materials.append(materials[material]);models.append(obj)
    bpy.context.view_layer.objects.active=obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod=obj.modifiers.new('Manufactured bevel','BEVEL');mod.width=bevel;mod.segments=2
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj

def cylinder(name,z,radius,depth,material,vertices=12):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=depth,location=(0,0,z))
    return finish(bpy.context.object,name,material,.025)

def box(name,location,scale,material,bevel=.025):
    bpy.ops.mesh.primitive_cube_add(size=1,location=location);bpy.context.object.scale=scale
    return finish(bpy.context.object,name,material,bevel)

cylinder('Hexagonal foundation',.18,2.3,.36,'Obsidian chassis',6)
cylinder('Copper lower collar',.45,1.7,.20,'Brushed copper',12)
cylinder('Solar ceramic upper step',.61,1.4,.18,'Sunfire ceramic',12)
cylinder('Reactor plinth',1.0,.74,.64,'Obsidian chassis')
cylinder('Inner luminous support',1.8,.22,1.6,'Luminous reactor',8)
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=1,location=(0,0,2.45))
bpy.context.object.scale=(.66,.66,1.05)
finish(bpy.context.object,'Suspended sunstone','Luminous reactor')
for side in range(3):
    angle=side*math.tau/3
    x,y=math.cos(angle),math.sin(angle)
    beam=box('Radial copper support %d'%side,(x*1.4,y*1.4,1.48),(.24,.34,2.25),'Brushed copper')
    beam.rotation_euler=(y*-.25,x*.25,angle)
    foot=box('Luminous service pedestal %d'%side,(x*1.45,y*1.45,.66),(.42,.42,.26),'Sunfire ceramic')
    top=box('Upper stabilizer %d'%side,(x*.95,y*.95,3.24),(.2,.2,.68),'Sunfire ceramic')
    top.rotation_euler.y=.35
for band,(z,radius,tilt) in enumerate([(1.83,1.22,.24),(2.72,1.28,-.34),(3.26,.95,.10)]):
    bpy.ops.mesh.primitive_torus_add(major_segments=48,minor_segments=8,location=(0,0,z),major_radius=radius,minor_radius=.055)
    obj=finish(bpy.context.object,'Copper orbital halo %d'%band,'Brushed copper')
    obj.rotation_euler=(tilt,.15*band,0)
    for index in range(8):
        a=index*math.tau/8
        fin=box('Radiant fin %d %d'%(band,index),(math.cos(a)*radius,math.sin(a)*radius,z),(.17,.24,.10),'Sunfire ceramic',.01)
        fin.rotation_euler.z=a
# A prominent physical maintenance plate, with modeled alternating diagonal bars.
plate=box('Yellow engineering service plate',(0,-1.96,.96),(1.5,.10,.58),'Construction yellow',.035)
for i in range(5):
    stripe=box('Black caution stripe %d'%i,(-.56+i*.28,-2.021,.96),(.11,.022,.48),'Construction black',0)
    stripe.rotation_euler.y=-.4
for x in [-.55,.55]:box('Service plate leg',(x,-1.92,.48),(.09,.10,.55),'Obsidian chassis')
# Explicit statistics include zero animations: this asset is an architectural prop.
blend_path=output/'sunforge_relay.blend';glb_path=output/'sunforge_relay.glb'
bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
bpy.ops.object.select_all(action='DESELECT')
for obj in models: obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(glb_path),export_format='GLB',use_selection=True,export_animations=False,export_yup=True,export_apply=True)
raw=glb_path.read_bytes();json_len,kind=struct.unpack_from('<II',raw,12);gltf=json.loads(raw[20:20+json_len])
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
report={
    'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'blender_binary':bpy.app.binary_path,'blender_version':bpy.app.version_string,
    'blender_build_hash':bpy.app.build_hash.decode(),
    'source_mode':'factory empty scene; original geometry authored by this script, no GLB or blend input',
    'script':str(pathlib.Path(__file__).resolve()),'script_sha256':sha(pathlib.Path(__file__).resolve()),
    'blend':str(blend_path),'blend_sha256':sha(blend_path),'blend_bytes':blend_path.stat().st_size,
    'glb':str(glb_path),'glb_sha256':sha(glb_path),'glb_bytes':len(raw),
    'blender_mesh_objects':len(models),'blender_vertices':sum(len(o.data.vertices) for o in models),
    'gltf_meshes':len(gltf.get('meshes',[])),'gltf_materials':len(gltf.get('materials',[])),
    'gltf_nodes':len(gltf.get('nodes',[])),'gltf_animations':len(gltf.get('animations',[])),
    'animation_scope':'static architecture prop; original playable explorer has a separate 4-clip rig',
    'visible_change':'three copper orbital halos, mint sunstone, amber stabilizer fins and physical yellow-black service plate'
}
(output/'pipeline-report.json').write_text(json.dumps(report,indent=2)+'\n')
print('BLENDER_LIVE_PIPELINE '+json.dumps(report))
