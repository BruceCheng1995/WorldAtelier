"""Original Starport prefab assets, authored from empty scenes with Blender.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender --background \
      --python tools/generate-preview-models.py
  ... --python tools/generate-preview-models.py -- --render

GLBs and their manifest: content/model-preview/ (small source assets).
Blender sources, rendered contact sheet, inspection report: .local/model-preview-assets/.
No external assets, textures or earlier RuntimeAtelier files are read.
Authoring: Blender Z-up; export: standard glTF Y-up, 1 unit = 1 metre.
The mesh bounds sit on Y=0 after export. These are static visual assets only:
no fabricated prefab behavior, physics or Agent execution is included.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import struct
import sys

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
args = argparse.ArgumentParser()
args.add_argument('--render', action='store_true', help='Render a Blender contact sheet after exporting')
args.add_argument('--only', choices=['beacon', 'platform', 'arch', 'tree', 'boat', 'station'])
args.add_argument('--output', type=Path, default=ROOT / 'content/model-preview')
args.add_argument('--local', type=Path, default=ROOT / '.local/model-preview-assets')
OPTIONS = args.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
OPTIONS.output.mkdir(parents=True, exist_ok=True)
OPTIONS.local.mkdir(parents=True, exist_ok=True)
random.seed(9427)

MATS = {}
PARTS = []


def srgb(c):
    n = c / 255
    return n / 12.92 if n < .04045 else ((n + .055) / 1.055) ** 2.4


def material(name, color, metal=0, rough=.5, emission=0):
    rgb = tuple(srgb(int(color[i:i + 2], 16)) for i in (0, 2, 4))
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    bs = m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*rgb, 1)
    bs.inputs['Metallic'].default_value = metal
    bs.inputs['Roughness'].default_value = rough
    if emission:
        bs.inputs['Emission Color'].default_value = (*rgb, 1)
        bs.inputs['Emission Strength'].default_value = emission
    MATS[name] = m
    return m


def reset():
    global PARTS, MATS
    bpy.ops.wm.read_factory_settings(use_empty=True)
    PARTS, MATS = [], {}
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0
    for spec in [
        ('Harbor basalt', '334D58', .08, .8),
        ('Cut slate', '58717A', .05, .74),
        ('Pale limestone', 'B9C6B4', .03, .75),
        ('Deep teal enamel', '25595D', .35, .35),
        ('Seaglass enamel', '6CA59D', .22, .37),
        ('Aged brass', 'C79851', .65, .34),
        ('Warm ivory', 'E7D7AF', .05, .48),
        ('Mint crystal', '8BE9D2', .1, .28, .65),
        ('Amber signal', 'F2BE63', .15, .33, .3),
        ('Dark gaskets', '1D2C35', .04, .68),
        ('Coral jade', '65A897', .05, .7),
        ('Coral sage', '9CBC9B', .02, .8),
        ('Coral gold tips', 'D1B274', .1, .7),
        ('Warm timber', '956946', .03, .77),
        ('Pale timber', 'BC9262', .03, .72),
        ('Instrument glass', '6B96B1', .38, .3),
    ]:
        material(*spec)


def finish(obj, name, mat, bevel=0):
    obj.name = name
    obj.data.materials.append(MATS[mat])
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new('Small crafted edge', 'BEVEL')
        mod.width, mod.segments = bevel, 1
        bpy.ops.object.modifier_apply(modifier=mod.name)
    PARTS.append(obj)
    return obj


def box(name, xyz, size, mat, bevel=.015, rotation=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=xyz)
    obj = bpy.context.object
    obj.scale = size
    obj = finish(obj, name, mat, bevel)
    if rotation:
        obj.rotation_euler = rotation
    return obj


def cylinder(name, xyz, radius, depth, mat, vertices=12, rotation=None, bevel=.008):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=xyz)
    obj = finish(bpy.context.object, name, mat, bevel)
    if rotation:
        obj.rotation_euler = rotation
    return obj


def cone(name, xyz, radius1, radius2, depth, mat, vertices=8, rotation=None):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius1, radius2=radius2,
                                  depth=depth, location=xyz)
    obj = finish(bpy.context.object, name, mat)
    if rotation:
        obj.rotation_euler = rotation
    return obj


def ring(name, xyz, radius, tube, mat, rotation=None, segments=32):
    bpy.ops.mesh.primitive_torus_add(major_segments=segments, minor_segments=6,
        major_radius=radius, minor_radius=tube, location=xyz)
    obj = finish(bpy.context.object, name, mat)
    if rotation:
        obj.rotation_euler = rotation
    return obj


def rod(name, a, b, radius, mat, radius2=None, vertices=8):
    a, b = Vector(a), Vector(b)
    delta = b - a
    obj = cone(name, (a + b) * .5, radius, radius if radius2 is None else radius2,
               delta.length, mat, vertices)
    obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
    return obj


def mesh(name, vertices, faces, mat, extra_materials=None, face_materials=None):
    data = bpy.data.meshes.new(name + 'Mesh')
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(MATS[mat])
    for m in extra_materials or []:
        obj.data.materials.append(MATS[m])
    if face_materials:
        for f, i in zip(data.polygons, face_materials):
            f.material_index = i
    PARTS.append(obj)
    return obj


def bevel_strip(name, a, b, width, thickness, mat):
    a, b = Vector(a), Vector(b)
    obj = box(name, (a+b)*.5, (width, thickness, (b-a).length), mat, .008)
    obj.rotation_euler = (b-a).to_track_quat('Z', 'Y').to_euler()
    return obj


def build_beacon():
    cylinder('Octagonal stone foot', (0, 0, .07), .36, .14, 'Harbor basalt', 8)
    cylinder('Upper inset limestone step', (0, 0, .16), .295, .075, 'Pale limestone', 8)
    cylinder('Brass socket', (0, 0, .235), .21, .09, 'Aged brass', 8)
    cone('Tapered enameled column', (0, 0, .665), .13, .095, .78, 'Deep teal enamel', 8)
    for angle in [0, math.pi/2, math.pi, 3*math.pi/2]:
        x,y=math.cos(angle),math.sin(angle)
        rod('Column gold vertical seam', (x*.122,y*.122,.31), (x*.09,y*.09,1.02), .016,'Aged brass',vertices=6)
    cylinder('Lower lantern collar', (0,0,1.10), .25,.105,'Aged brass',8)
    cylinder('Dark lantern gasket',(0,0,1.165),.212,.04,'Dark gaskets',8)
    cone('Lantern crystal lower cut',(0,0,1.30),.07,.205,.26,'Mint crystal',8)
    cone('Lantern crystal upper cut',(0,0,1.55),.205,.045,.24,'Mint crystal',8)
    cylinder('Upper lantern cap',(0,0,1.68),.15,.05,'Aged brass',8)
    cone('Pointed ceramic roof',(0,0,1.745),.18,.025,.11,'Deep teal enamel',8)
    for i in range(4):
        a=i*math.tau/4+.35
        rod('Open lantern brass cage',(.23*math.cos(a),.23*math.sin(a),1.13),
            (.14*math.cos(a),.14*math.sin(a),1.68),.016,'Aged brass',vertices=6)
    ring('Horizontal navigation halo',(0,0,1.41),.355,.022,'Aged brass')
    for i in range(4):
        a=i*math.tau/4
        obj=box('Cardinal signal vane',(.35*math.cos(a),.35*math.sin(a),1.41),(.15,.07,.04),'Amber signal',.01)
        obj.rotation_euler.z=a
    for x in [-.115,.115]:
        cylinder('Foundation fastener',(x,-.18,.21),.025,.025,'Aged brass',6)


def build_platform():
    # One six-metre slab. Real inlays and tiered stone surfaces; no stacked meters-thick pedestal.
    cylinder('Dodecagonal basalt slab',(0,0,.105),3,.21,'Harbor basalt',12,bevel=.03)
    cylinder('Chamfered pale stone cap',(0,0,.27),2.95,.12,'Pale limestone',12,bevel=.022)
    cylinder('Slate central medallion',(0,0,.339),.82,.018,'Cut slate',12,bevel=.004)
    ring('Gold inset compass ring',(0,0,.34),.96,.012,'Aged brass',segments=48)
    for i in range(12):
        a=i*math.tau/12
        # Side blocks and fine gold top radial separators.
        obj=box('Inset teal slab side %02d'%i,(2.9*math.cos(a),2.9*math.sin(a),.12),(.10,.73,.11),'Deep teal enamel',.015)
        obj.rotation_euler.z=a
        rod('Fine radial top seam %02d'%i,(1.12*math.cos(a),1.12*math.sin(a),.338),
            (2.68*math.cos(a),2.68*math.sin(a),.338),.009,'Aged brass',vertices=4)
    for i in range(4):
        a=i*math.tau/4
        vertices=[(0,0,.35),(.13,0,.35),(0,.63,.35),(-.13,0,.35)]
        vertices=[(x*math.cos(a)-y*math.sin(a),x*math.sin(a)+y*math.cos(a),z)for x,y,z in vertices]
        mesh('Gold compass pointer %02d'%i,vertices,[(0,1,2,3)],'Aged brass')
    cylinder('Compass center brass rivet',(0,0,.348),.055,.008,'Aged brass',8,bevel=0)
    for i in range(8):
        a=i*math.tau/8
        cylinder('Edge mint light %02d'%i,(2.69*math.cos(a),2.69*math.sin(a),.342),.055,.012,'Mint crystal',8,bevel=0)


def build_arch():
    for side in [-1,1]:
        x=side*1.53
        box('Gate stone foundation '+str(side),(x,0,.12),(.77,.95,.24),'Harbor basalt',.05)
        box('Brass foot inset '+str(side),(x,0,.265),(.59,.71,.075),'Aged brass',.02)
        box('Pale carved upright '+str(side),(x,0,1.56),(.46,.50,2.50),'Pale limestone',.045)
        box('Teal upright front panel '+str(side),(x,-.264,1.62),(.25,.055,2.03),'Deep teal enamel',.018)
    # Lintel lower face is exactly 3 m above ground, leaving 2.60 m between columns.
    box('Stone top lintel',(0,0,3.24),(3.52,.64,.48),'Pale limestone',.065)
    box('Teal lintel face',(0,-.341,3.24),(2.95,.055,.23),'Deep teal enamel',.015)
    box('Brass lintel underline',(0,-.35,3.075),(3.17,.07,.035),'Aged brass',.008)
    for side in [-1,1]:
        x=side*1.53
        box('Inner mint navigation strip '+str(side),(x-side*.20,-.295,1.6),(.025,.027,2.30),'Mint crystal',.004)
        for z in [.65,1.14,2.30,2.77]:
            box('Upright decorative brass joint',(x,-.303,z),(.31,.035,.035),'Aged brass',.005)
        box('Bracket shoulder '+str(side),(x,0,2.95),(.66,.66,.13),'Aged brass',.018)
        cone('Stone crown '+str(side),(x,0,3.58),.20,.10,.20,'Harbor basalt',4,rotation=(0,0,math.pi/4))
    # An open gate, not a filled portal pane: the silhouette and passage remain visible.
    obj=cylinder('Central brass seal',(0,-.385,3.27),.195,.055,'Aged brass',12,rotation=(math.pi/2,0,0))
    cylinder('Mint seal core',(0,-.423,3.27),.107,.035,'Mint crystal',6,rotation=(math.pi/2,0,0))
    for x in [-.87,-.5,.5,.87]:
        obj=box('Inlaid lintel rune',(x,-.38,3.24),(.09,.03,.095),'Aged brass',.005)
        obj.rotation_euler.y=math.pi/4


def build_tree():
    cylinder('Coral root mound',(0,0,.08),.43,.16,'Harbor basalt',9,bevel=.04)
    paths=[
      ([(0,0,.09),(.02,.03,.59),(-.10,0,1.08),(.01,.02,1.54),(.04,.01,1.90)],.13),
      ([(-.01,.02,.52),(-.34,.02,.84),(-.48,.06,1.22),(-.45,.04,1.49)],.09),
      ([(-.08,0,.95),(.35,-.01,1.21),(.51,-.02,1.56),(.60,-.02,1.73)],.085),
      ([(-.10,0,1.13),(-.40,-.26,1.40),(-.63,-.36,1.59)],.07),
      ([(0,.02,.72),(.18,.34,1.04),(.24,.45,1.44)],.08),
      ([(.35,-.01,1.21),(.61,.18,1.35),(.83,.20,1.52)],.062),
      ([(-.34,.02,.84),(-.69,.08,.97),(-.83,.07,1.19)],.065),
    ]
    for idx,(points,width) in enumerate(paths):
        for n,(a,b)in enumerate(zip(points,points[1:])):
            r=width*(1-n/(len(points)+1))
            rod('Faceted coral branch %d-%d'%(idx,n),a,b,r,'Coral jade' if idx%2==0 else 'Coral sage',r*.72,7)
        p=Vector(points[-1]);bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=width*1.20,location=p)
        obj=bpy.context.object;obj.scale=(1,1,1.5)
        finish(obj,'Pale coral growth tip %d'%idx,'Coral gold tips' if idx%3==0 else 'Coral sage')
    for a in [0,1.7,3.6,5.0]:
        rod('Exposed coral root',(0,0,.24),(.36*math.cos(a),.36*math.sin(a),.075),.10,'Coral jade',.035)
    # Small distinct sea-glass nodules, keeping branches readable instead of a generic leaf blob.
    for i,p in enumerate([(-.39,.05,1.12),(.35,.00,1.22),(.20,.37,1.09)]):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=.08,location=p)
        finish(bpy.context.object,'Sea glass growth nodule %d'%i,'Mint crystal')


def build_boat():
    # Length along Blender Y / glTF Z. Layered eight-sided open hull, built as original mesh.
    rings=[
      [(-.21,-1.53,.17),(.21,-1.53,.17),(.54,-.99,.15),(.62,.94,.15),(.29,1.64,.17),(-.29,1.64,.17),(-.62,.94,.15),(-.54,-.99,.15)],
      [(-.38,-1.65,.63),(.38,-1.65,.63),(.79,-.97,.58),(.83,.97,.60),(.28,1.75,.78),(-.28,1.75,.78),(-.83,.97,.60),(-.79,-.97,.58)],
      [(-.31,-1.48,.63),(.31,-1.48,.63),(.66,-.92,.58),(.69,.93,.60),(.19,1.57,.74),(-.19,1.57,.74),(-.69,.93,.60),(-.66,-.92,.58)],
      [(-.17,-1.35,.25),(.17,-1.35,.25),(.46,-.84,.25),(.49,.81,.25),(.16,1.39,.28),(-.16,1.39,.28),(-.49,.81,.25),(-.46,-.84,.25)]
    ]
    verts=sum(rings,[]);faces=[];mids=[]
    faces.append(tuple(range(7,-1,-1)));mids.append(0)
    for level in range(3):
        for i in range(8):
            j=(i+1)%8;faces.append((level*8+i,level*8+j,(level+1)*8+j,(level+1)*8+i));mids.append([0,1,2][level])
    faces.append(tuple(range(24,32)));mids.append(2)
    hull=mesh('Open double-seat exploration hull',verts,faces,'Deep teal enamel',['Aged brass','Warm timber'],mids)
    # Planked deck with visible gaps, two pale padded seats, side rails and a physical rudder.
    for x in [-.39,-.20,0,.20,.39]:
        box('Long timber deck plank',(x,0,.29),(.18,2.05,.055),'Pale timber',.012)
    for y in [-.72,.48]:
        box('Transverse timber seat base',(0,y,.49),(1.37,.37,.10),'Warm timber',.02)
        box('Ivory padded bench',(0,y,.57),(1.20,.33,.085),'Warm ivory',.028)
        for x in [-.50,.50]:
            box('Bench enameled end cap',(x,y,.61),(.08,.37,.05),'Deep teal enamel',.015)
    for side in [-1,1]:
        for y in [-.65,.80]:
            cylinder('Brass oarlock socket',(side*.81,y,.67),.048,.13,'Aged brass',8)
        rod('Long slender outrigger rail',(side*.85,-1.0,.70),(side*.90,.99,.72),.037,'Aged brass')
        for y in [-.94,.94]:
            rod('Side rail brace',(side*.80,y,.57),(side*.89,y,.70),.024,'Aged brass')
        # Gold hull waterline strips are real separate geometry.
        rod('Hull side gold waterline',(side*.70,-.90,.43),(side*.74,.88,.44),.018,'Aged brass')
    rod('Short stern tiller',(0,-1.55,.38),(0,-1.78,.55),.035,'Aged brass')
    box('Rudder blade',(0,-1.72,.23),(.06,.30,.45),'Deep teal enamel',.015)
    # Forward navigation light and deck instrument.
    cylinder('Bow light plinth',(0,1.34,.78),.11,.12,'Aged brass',8)
    cone('Bow navigation crystal',(0,1.34,.96),.085,.035,.24,'Mint crystal',6)
    box('Deck compass housing',(0,.99,.55),(.33,.25,.22),'Deep teal enamel',.035)
    cylinder('Deck compass face',(0,.99,.675),.10,.022,'Instrument glass',12)
    box('Stern luggage locker',(0,-1.24,.56),(.50,.23,.25),'Deep teal enamel',.025)
    box('Luggage brass latch',(0,-1.368,.58),(.09,.025,.08),'Aged brass',.007)


def build_station():
    cylinder('Instrument foundation',(0,0,.055),.40,.11,'Harbor basalt',6)
    cylinder('Brass central pedestal',(0,0,.20),.09,.29,'Aged brass',8)
    for i in range(3):
        a=i*math.tau/3
        rod('Tripod leg %d'%i,(.34*math.cos(a),.34*math.sin(a),.09),(.06*math.cos(a),.06*math.sin(a),.62),.035,'Seaglass enamel')
        cylinder('Tripod brass foot %d'%i,(.34*math.cos(a),.34*math.sin(a),.09),.065,.06,'Aged brass',8)
    rod('Upper weather mast',(0,0,.26),(0,0,1.43),.045,'Aged brass')
    box('Weather instrument body',(0,-.055,.91),(.44,.31,.47),'Deep teal enamel',.045)
    box('Ivory face border',(0,-.223,.94),(.34,.035,.30),'Warm ivory',.018)
    cylinder('Round mechanical instrument face',(-.05,-.252,.98),.091,.020,'Instrument glass',16,rotation=(math.pi/2,0,0),bevel=.003)
    rod('Weather gauge needle',(-.05,-.27,.98),(-.015,-.27,1.035),.008,'Amber signal',vertices=4)
    for x in [-.08,.035,.135]:
        cylinder('Colored instrument toggle',(x,-.265,.85),.021,.035,'Amber signal' if x<0 else 'Mint crystal',8,rotation=(math.pi/2,0,0),bevel=.002)
    for z in [.79,.85,.91, .97]:
        box('Side louver',( .236,0,z),(.025,.18,.022),'Aged brass',.003)
    # Physical wind vane and three cup anemometer distinguish it from the beacon.
    rod('Anemometer crossbar',(-.28,0,1.38),(.28,0,1.38),.018,'Aged brass')
    for i in range(3):
        a=i*math.tau/3
        rod('Wind cup arm %d'%i,(0,0,1.38),(.26*math.cos(a),.26*math.sin(a),1.38),.014,'Aged brass',vertices=6)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=5, radius=.068,location=(.28*math.cos(a),.28*math.sin(a),1.38))
        finish(bpy.context.object,'Faceted wind sensor cup %d'%i,'Seaglass enamel')
    rod('Wind direction arrow shaft',(-.24,.0,1.49),(.23,0,1.49),.011,'Aged brass',vertices=6)
    mesh('Wind direction arrowhead',[(.32,0,1.49),(.16,-.085,1.49),(.16,.085,1.49)],[(0,1,2)],'Amber signal')
    box('Wind vane tail',(-.20,0,1.49),(.1,.11,.025),'Seaglass enamel',.005)
    # A side-mounted small solar panel.
    panel=box('Side solar panel',(.36,.03,1.11),(.30,.25,.045),'Instrument glass',.01,rotation=(0,-.35,0))
    for y in [-.055,.03,.115]:
        rod('Panel cell separator',(.21,y,1.075),(.49,y,1.178),.006,'Warm ivory',vertices=4)


SPECS = [
    ('beacon','导航信标',build_beacon,1.8, 'Brass-caged mint crystal lantern, compass halo and carved octagonal foot.'),
    ('platform','浮空石台',build_platform,.35,'Six-metre twelve-sided stone platform, compass inlay and teal side panels.'),
    ('arch','星门框架',build_arch,None,'Open stone and enamel star gate; 2.60 m passage width, lintel starts 3 m above floor.'),
    ('tree','珊瑚树',build_tree,2.0,'Seven distinct faceted coral growth paths, exposed roots and sea-glass nodules.'),
    ('boat','双人探索艇',build_boat,None,'Open planked exploration boat, two seats, rails, rudder, compass and bow lantern.'),
    ('station','气候观测仪',build_station,1.5,'Tripod weather instrument with gauge, louvers, wind cups, vane and solar panel.'),
]


def bounds_world(objects):
    coords = [obj.matrix_world @ Vector(v) for obj in objects for v in obj.bound_box]
    return [min(v[i] for v in coords) for i in range(3)], [max(v[i] for v in coords) for i in range(3)]


def ground_and_size(target_height=None):
    bpy.context.view_layer.update()
    lo,hi=bounds_world(PARTS)
    scale=target_height/(hi[2]-lo[2]) if target_height else 1
    center=[(lo[i]+hi[i])/2 for i in range(2)]
    for obj in PARTS:
        obj.location.x-=center[0]
        obj.location.y-=center[1]
        obj.location.z-=lo[2]
        obj.location*=scale
        obj.scale*=scale
    bpy.context.view_layer.update()
    return bounds_world(PARTS)


def glb_info(path):
    data=path.read_bytes()
    magic,version,length=struct.unpack_from('<4sII',data)
    if magic!=b'glTF' or version!=2 or length!=len(data):
        raise ValueError('Invalid GLB header: '+str(path))
    json_length,chunk=struct.unpack_from('<II',data,12)
    if chunk!=0x4E4F534A:
        raise ValueError('Missing GLB JSON')
    doc=json.loads(data[20:20+json_length])
    if any('uri' in b for b in doc.get('buffers',[])) or any('uri' in im for im in doc.get('images',[])):
        raise ValueError('GLB must be self-contained')
    triangles=sum(doc['accessors'][p['indices']]['count']//3 for m in doc.get('meshes',[]) for p in m['primitives'])
    return doc,{'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'meshes':len(doc.get('meshes',[])),
                'materials':len(doc.get('materials',[])),'triangles':triangles,'self_contained':True}


def export_asset(name,label,build,height,description):
    reset()
    build()
    lo,hi=ground_and_size(height)
    root=bpy.data.objects.new('pf-'+name,None)
    bpy.context.collection.objects.link(root)
    for obj in PARTS:
        obj.parent=root
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for obj in PARTS:obj.select_set(True)
    bpy.context.view_layer.objects.active=root
    blend=OPTIONS.local/(name+'.blend')
    bpy.ops.wm.save_as_mainfile(filepath=str(blend))
    path=OPTIONS.output/(name+'.glb')
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,
        export_animations=False,export_yup=True,export_apply=True,export_cameras=False,export_lights=False)
    doc,info=glb_info(path)
    if info['bytes']>=1024*1024:
        raise ValueError('Asset exceeds one MiB: '+name)
    # Blender Z-up -> standard glTF Y-up: X stays X, glTF Y=Z, glTF Z=-Y.
    minimum=[lo[0],lo[2],-hi[1]];maximum=[hi[0],hi[2],-lo[1]]
    asset={'id':'pf-'+name,'name':label,'slug':name,'file':name+'.glb','url':'/preview-assets/'+name+'.glb',
        **info,'bounds':{'min':[round(v,6)for v in minimum],'max':[round(v,6)for v in maximum],
                      'size':[round(b-a,6)for a,b in zip(minimum,maximum)],'unit':'metre','up_axis':'Y'},
        'origin':'bottom-center; minimum Y = 0','description':description,
        'source':{'type':'original-procedural-blender','script':'tools/generate-preview-models.py',
                  'blender':bpy.app.version_string,'external_assets':False,'source_blend':'.local/model-preview-assets/'+name+'.blend'},
        'scope':'static visual mesh; no gameplay logic or collision shapes embedded'}
    print('PREVIEW_ASSET_EXPORTED '+json.dumps(asset,ensure_ascii=False),flush=True)
    return asset


def render_contact(assets):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.samples=32
    scene.cycles.use_denoising=True
    scene.cycles.device='CPU'
    scene.render.resolution_x=1800
    scene.render.resolution_y=1280
    scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'
    scene.render.film_transparent=False
    scene.world=bpy.data.worlds.new('Studio world')
    scene.world.use_nodes=True
    bg=scene.world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value=(.14,.20,.22,1)
    bg.inputs['Strength'].default_value=.45
    scene.view_settings.view_transform='AgX'
    # Orthographic studio sheet: every model is actually imported from its exported GLB.
    scene_units=[]
    centers=[(-3.4,2.0),(0,2.0),(3.4,2.0),(-3.4,-2.4),(0,-2.4),(3.4,-2.4)]
    for i,asset in enumerate(assets):
        before=set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(OPTIONS.output/asset['file']))
        imported=[o for o in bpy.data.objects if o not in before]
        meshes=[o for o in imported if o.type=='MESH']
        lo,hi=bounds_world(meshes)
        dims=[hi[k]-lo[k]for k in range(3)]
        display_scale=min(2.55/max(dims[0],dims[1]),2.45/dims[2])
        group=bpy.data.objects.new('Sheet '+asset['slug'],None)
        scene.collection.objects.link(group)
        for obj in imported:
            if obj.parent is None:obj.parent=group
        group.scale=(display_scale,)*3
        x,y=centers[i]
        group.location=(x,y,.055)
        # Label the sheet in world-space, aligned with the camera's horizontal axis.
        textdata=bpy.data.curves.new('Label '+asset['slug'],'FONT')
        textdata.body=f"{i+1:02d}  {asset['slug'].upper()}"
        textdata.align_x='CENTER';textdata.size=.17;textdata.extrude=.001
        label=bpy.data.objects.new('Label '+asset['slug'],textdata);scene.collection.objects.link(label)
        label.location=(x,y-1.46,.06);label.rotation_euler=(0,0,0)
        textmat=bpy.data.materials.get('Contact label')
        if textmat is None:
            textmat=bpy.data.materials.new('Contact label');textmat.diffuse_color=(.45,.65,.65,1);textmat.use_nodes=True
            textmat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.45,.65,.65,1)
        textdata.materials.append(textmat)
    # Neutral raised tiles and dark studio ground are render environment, never exported.
    for i,(x,y) in enumerate(centers):
        bpy.ops.mesh.primitive_cube_add(size=1,location=(x,y-.06,-.065))
        tile=bpy.context.object;tile.name='Render-only tile';tile.scale=(3.13,3.0,.12)
        tilemat=bpy.data.materials.get('Studio slate')
        if tilemat is None:
            tilemat=bpy.data.materials.new('Studio slate');tilemat.diffuse_color=(.038,.074,.085,1);tilemat.use_nodes=True
            tilemat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.038,.074,.085,1)
            tilemat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.85
        tile.data.materials.append(tilemat)
        bpy.context.view_layer.objects.active=tile;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        mod=tile.modifiers.new('Render tile bevel','BEVEL');mod.width=.045;mod.segments=2
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.14))
    ground=bpy.context.object;ground.name='Render-only ground'
    groundmat=bpy.data.materials.new('Studio navy');groundmat.diffuse_color=(.013,.027,.036,1);groundmat.use_nodes=True
    groundmat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.013,.027,.036,1)
    groundmat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.9
    ground.data.materials.append(groundmat)
    bpy.ops.object.camera_add(location=(.2,-10.5,14.4))
    cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,.65))-cam.location).to_track_quat('-Z','Y').to_euler()
    cam.data.type='ORTHO';cam.data.ortho_scale=11.45;scene.camera=cam
    for name,xyz,power,size,color in [('Key',(-5,-4,10),1800,7,(1,.91,.76)),('Fill',(5,2,8),1400,6,(.65,.86,1)),('Top',(0,6,9),1600,5,(.70,1,.91))]:
        bpy.ops.object.light_add(type='AREA',location=xyz);light=bpy.context.object;light.name='Render '+name
        light.data.energy=power;light.data.shape='DISK';light.data.size=size;light.data.color=color
        light.rotation_euler=(Vector((0,0,0))-light.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.wm.save_as_mainfile(filepath=str(OPTIONS.local/'contact-sheet.blend'))
    scene.render.filepath=str(OPTIONS.local/'contact-sheet.png')
    bpy.ops.render.render(write_still=True)
    print('PREVIEW_CONTACT_SHEET '+scene.render.filepath,flush=True)


def validate_roundtrip(asset):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(OPTIONS.output/asset['file']))
    bpy.context.view_layer.update()
    meshes=[o for o in bpy.data.objects if o.type=='MESH']
    lo,hi=bounds_world(meshes)
    actual=[lo[0],lo[2],-hi[1],hi[0],hi[2],-lo[1]]
    expected=asset['bounds']['min']+asset['bounds']['max']
    error=max(abs(a-b)for a,b in zip(actual,expected))
    if error>2e-5:raise ValueError('Roundtrip bounds mismatch: '+asset['id']+' '+str(error))
    if abs(lo[2])>2e-5:raise ValueError('Ground origin mismatch: '+asset['id'])
    if abs(lo[0]+hi[0])>2e-5 or abs(lo[1]+hi[1])>2e-5:raise ValueError('Horizontal origin not centered')
    if len(meshes)<4:raise ValueError('Missing recognizable model parts')
    asset['validation']={'blender_glb_reimport':'passed','imported_meshes':len(meshes),'bounds_max_error_m':round(error,8),'ground_origin_verified':True}
    print('PREVIEW_ROUNDTRIP_VALIDATED '+asset['id'],flush=True)


def main():
    assets=[]
    for spec in SPECS:
        if OPTIONS.only and OPTIONS.only!=spec[0]:continue
        assets.append(export_asset(*spec))
    for asset in assets:validate_roundtrip(asset)
    script_hash=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    manifest={'format':1,'title':'世界工坊 · 星港创作预制件模型','units':'metres','up_axis':'Y',
        'generator':'Blender '+bpy.app.version_string,'source_script':'tools/generate-preview-models.py',
        'source_script_sha256':script_hash,'external_assets':False,'assets':assets}
    (OPTIONS.output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    (OPTIONS.local/'validation.json').write_text(json.dumps({'result':'GLB export/header/size/material checks passed',
        'assets':[{k:a[k]for k in ['id','bytes','sha256','meshes','materials','triangles','bounds','validation']}for a in assets]},ensure_ascii=False,indent=2)+'\n')
    if OPTIONS.render:render_contact(assets)


if __name__=='__main__':
    main()
