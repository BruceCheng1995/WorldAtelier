"""Original World Atelier explorer model, weighted rig and four animation clips.
Run: Blender --background --python tools/godot-explorer-asset.py
"""
import bpy, math, pathlib
from mathutils import Vector
root=pathlib.Path(__file__).resolve().parents[1]
assets=root/'runtimes/godot/assets';assets.mkdir(parents=True,exist_ok=True)
source=assets/'source';source.mkdir(exist_ok=True);(source/'.gdignore').write_text('')
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
materials={}
for name,hexcol,metal in [('armor','D8D6BE',.32),('cloth','315765',0),('mint','88E4D0',.22),('dark','152C3D',.45),('gold','CCA875',.65),('leather','765845',.1),('cape','B58B64',0),('glow','AFF8E6',.1)]:
    c=tuple(int(hexcol[i:i+2],16)/255 for i in (0,2,4));mat=bpy.data.materials.new(name);mat.diffuse_color=(*c,1);mat.use_nodes=True
    bs=mat.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*c,1);bs.inputs['Metallic'].default_value=metal;bs.inputs['Roughness'].default_value=.45
    if name=='glow':bs.inputs['Emission Color'].default_value=(*c,1);bs.inputs['Emission Strength'].default_value=.7
    materials[name]=mat
armdata=bpy.data.armatures.new('ExplorerSkeleton');rig=bpy.data.objects.new('ExplorerRig',armdata);bpy.context.collection.objects.link(rig);bpy.context.view_layer.objects.active=rig;rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bones={
'Root':((0,0,0),(0,0,.35),None),'Hips':((0,0,.9),(0,0,1.15),'Root'),'Chest':((0,0,1.15),(0,0,1.7),'Hips'),'Head':((0,0,1.7),(0,0,2.15),'Chest'),
'UpperArm.L':((-.48,0,1.54),(-.67,0,1.13),'Chest'),'Forearm.L':((-.67,0,1.13),(-.71,-.03,.88),'UpperArm.L'),
'UpperArm.R':((.48,0,1.54),(.67,0,1.13),'Chest'),'Forearm.R':((.67,0,1.13),(.71,-.03,.88),'UpperArm.R'),'Staff':((.71,-.03,.88),(.71,-.03,1.5),'Forearm.R'),
'Thigh.L':((-.22,0,.91),(-.22,0,.51),'Hips'),'Shin.L':((-.22,0,.51),(-.22,0,.17),'Thigh.L'),
'Thigh.R':((.22,0,.91),(.22,0,.51),'Hips'),'Shin.R':((.22,0,.51),(.22,0,.17),'Thigh.R'),
'Cape.1':((0,.25,1.6),(0,.3,1.25),'Chest'),'Cape.2':((0,.3,1.25),(0,.37,.9),'Cape.1'),'Cape.3':((0,.37,.9),(0,.44,.58),'Cape.2')}
for name,(a,b,parent) in bones.items():
    bone=armdata.edit_bones.new(name);bone.head=a;bone.tail=b
    if parent:bone.parent=armdata.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT');rig.select_set(False)
def finish(obj,name,mat,bone,bevel=0):
    obj.name=name;obj.data.materials.append(materials[mat]);bpy.context.view_layer.objects.active=obj
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        mod=obj.modifiers.new('Crafted edges','BEVEL');mod.width=bevel;mod.segments=2;bpy.ops.object.modifier_apply(modifier=mod.name)
    group=obj.vertex_groups.new(name=bone);group.add(list(range(len(obj.data.vertices))),1,'REPLACE')
    mod=obj.modifiers.new('Explorer articulated skin','ARMATURE');mod.object=rig;obj.parent=rig
    return obj
def box(name,pos,size,mat,bone,bevel=.025):
    bpy.ops.mesh.primitive_cube_add(size=1,location=pos);obj=bpy.context.object;obj.scale=size;return finish(obj,name,mat,bone,bevel)
def sphere(name,pos,size,mat,bone):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=1,location=pos);obj=bpy.context.object;obj.scale=size;return finish(obj,name,mat,bone)
def cyl(name,pos,radius,depth,mat,bone,vertices=10):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=depth,location=pos);return finish(bpy.context.object,name,mat,bone,.01)
box('Layered coat', (0,0,1.25),(.68,.4,.74),'cloth','Chest',.07)
box('Breastplate',(0,-.24,1.40),(.58,.12,.41),'armor','Chest',.06)
box('Luminous chest sigil',(0,-.314,1.43),(.2,.018,.16),'glow','Chest',.025)
box('Utility belt',(0,-.01,.96),(.76,.47,.13),'gold','Hips')
for x in [-.31,.31]:box('Utility pouch',(x,-.25,1.0),(.16,.14,.2),'leather','Hips')
sphere('Helmet shell',(0,0,1.96),(.38,.33,.36),'armor','Head')
sphere('Inset visor',(0,-.29,1.98),(.30,.105,.15),'dark','Head')
for x in [-.13,.13]:box('Visor luminous eye',(x,-.39,1.985),(.12,.023,.037),'glow','Head',.008)
box('Helmet brow',(0,-.28,2.12),(.45,.20,.055),'gold','Head',.015)
box('Crown stripe',(0,0,2.267),(.1,.31,.035),'mint','Head',.012)
for side,x in [('L',-1),('R',1)]:
    sphere('Shoulder articulated cap.'+side,(x*.51,0,1.54),(.25,.27,.22),'mint','UpperArm.'+side)
    box('Shoulder gold rim.'+side,(x*.55,-.2,1.55),(.3,.055,.11),'gold','UpperArm.'+side)
    cyl('Upper arm.'+side,(x*.61,0,1.32),.095,.35,'dark','UpperArm.'+side)
    sphere('Elbow joint.'+side,(x*.67,0,1.13),(.11,.11,.11),'gold','Forearm.'+side)
    box('Forearm gauntlet.'+side,(x*.70,-.015,1.005),(.22,.24,.29),'armor','Forearm.'+side,.045)
    sphere('Gloved hand.'+side,(x*.71,-.035,.86),(.11,.10,.12),'dark','Forearm.'+side)
    box('Leg trouser.'+side,(x*.22,0,.72),(.25,.28,.40),'cloth','Thigh.'+side,.055)
    sphere('Knee guard.'+side,(x*.22,-.16,.5),(.15,.07,.13),'armor','Shin.'+side)
    box('Shin armor.'+side,(x*.22,-.01,.33),(.24,.26,.31),'dark','Shin.'+side,.035)
    box('Explorer boot.'+side,(x*.22,-.11,.13),(.29,.48,.23),'armor','Shin.'+side,.045)
    box('Boot sole.'+side,(x*.22,-.11,.045),(.30,.49,.06),'dark','Shin.'+side,.015)
for i,z in enumerate([1.43,1.09,.75]):
    box('Cape segmented panel.'+str(i),(0,.3+i*.065,z),(.65+i*.05,.045,.37),'cape','Cape.'+str(i+1),.018)
    box('Cape embroidered line.'+str(i),(.24,.327+i*.065,z),(.025,.008,.34),'gold','Cape.'+str(i+1),0)
# Staff is a true hand-bone attachment, including tip and counterweight.
cyl('Staff carved shaft',(.71,-.03,1.27),.046,1.8,'leather','Staff',10)
for z in [.48,.85,1.22,1.6,2.02]:cyl('Staff metal band',(.71,-.03,z),.068,.06,'gold','Staff',10)
cyl('Staff lower counterweight',(.71,-.03,.32),.09,.14,'gold','Staff',10)
sphere('Staff crystal socket',(.71,-.03,2.08),(.12,.12,.1),'gold','Staff')
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=1,location=(.71,-.03,2.32));obj=bpy.context.object;obj.scale=(.16,.16,.35);finish(obj,'Staff luminous star crystal','glow','Staff')
# Each animation changes the articulated rig while locomotion remains authoritative.
rig.animation_data_create()
for clip,frames in [('Idle',48),('Walk',24),('Strike',16),('Dash',16)]:
    action=bpy.data.actions.new(clip);rig.animation_data.action=action
    for frame in range(1,frames+1,2):
        t=(frame-1)/(frames-1);phase=t*math.tau
        for bone in rig.pose.bones:
            bone.rotation_mode='XYZ';bone.rotation_euler=(0,0,0);bone.location=(0,0,0)
        rig.pose.bones['Chest'].rotation_euler.x=math.sin(phase)*.025
        for i in range(3):rig.pose.bones['Cape.'+str(i+1)].rotation_euler.x=.06+math.sin(phase-i*.6)*.04
        if clip=='Walk':
            for side,sign in [('L',1),('R',-1)]:
                rig.pose.bones['Thigh.'+side].rotation_euler.x=math.sin(phase)*.5*sign
                rig.pose.bones['Shin.'+side].rotation_euler.x=max(0,-math.sin(phase)*sign)*.55
                rig.pose.bones['UpperArm.'+side].rotation_euler.x=-math.sin(phase)*.23*sign
            rig.pose.bones['Hips'].location.y=abs(math.sin(phase))*.035
        elif clip=='Strike':
            sweep=math.sin(t*math.pi)
            rig.pose.bones['Chest'].rotation_euler.y=-.5+1.15*t
            rig.pose.bones['UpperArm.R'].rotation_euler.x=-1.35*sweep
            rig.pose.bones['UpperArm.R'].rotation_euler.z=-.6*sweep
            rig.pose.bones['Forearm.R'].rotation_euler.x=-.55*sweep
            rig.pose.bones['Staff'].rotation_euler.z=-.6+1.6*t
            rig.pose.bones['UpperArm.L'].rotation_euler.x=.3*sweep
        elif clip=='Dash':
            rig.pose.bones['Chest'].rotation_euler.x=.45
            rig.pose.bones['Thigh.L'].rotation_euler.x=.5;rig.pose.bones['Thigh.R'].rotation_euler.x=-.45
            for i in range(3):rig.pose.bones['Cape.'+str(i+1)].rotation_euler.x=-.35+math.sin(phase-i)*.08
        for bone in rig.pose.bones:
            bone.keyframe_insert(data_path='rotation_euler',frame=frame,group=bone.name)
            bone.keyframe_insert(data_path='location',frame=frame,group=bone.name)
    # Export NLA strips provides explicit consistent clip names across Blender versions.
    track=rig.animation_data.nla_tracks.new();track.name=clip;strip=track.strips.new(clip,1,action);strip.name=clip
rig.animation_data.action=None
for track in rig.animation_data.nla_tracks:track.mute=True
bpy.context.scene.frame_set(1)
# Reset pose before bind export.
for bone in rig.pose.bones:bone.rotation_euler=(0,0,0);bone.location=(0,0,0)
bpy.ops.wm.save_as_mainfile(filepath=str(source/'explorer.blend'))
for track in rig.animation_data.nla_tracks:track.mute=False
bpy.ops.export_scene.gltf(filepath=str(assets/'explorer.glb'),export_format='GLB',export_animations=True,export_animation_mode='NLA_TRACKS',export_skins=True,export_yup=True,export_apply=False)
print('EXPLORER_EXPORTED',assets/'explorer.glb')
