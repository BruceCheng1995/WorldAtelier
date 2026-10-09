"""Run with Blender --background --python. Convert downloaded CC0 FBX to GLB.
All bytes remain under .local; no third party art is committed to Git.
"""
import bpy, pathlib, sys, json
root=pathlib.Path(__file__).resolve().parents[2]
source=root/'.local/asset-market/staging/protagonists'
out=root/'.local/asset-market/packages'
for skin in ['skaterMaleA','skaterFemaleA','cyborgFemaleA']:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(source/'Model/characterMedium.fbx'))
    rig=next(o for o in bpy.data.objects if o.type=='ARMATURE')
    mesh=next(o for o in bpy.data.objects if o.type=='MESH')
    model_objects=[rig,mesh]
    rig.animation_data_create()
    for animation in ['idle','run','jump']:
        before=set(bpy.data.objects)
        actions=set(bpy.data.actions)
        bpy.ops.import_scene.fbx(filepath=str(source/f'Animations/{animation}.fbx'))
        imported=set(bpy.data.objects)-before
        clips=[a for a in bpy.data.actions if a not in actions and a.frame_range[1]-a.frame_range[0]>2]
        if not clips: raise RuntimeError('No animation: '+animation)
        source_clip=max(clips,key=lambda a:a.frame_range[1]-a.frame_range[0])
        source_rig=next(o for o in imported if o.type=='ARMATURE')
        source_rig.animation_data.action=source_clip
        source_rig.animation_data.action_slot=source_clip.slots[0]
        for track in rig.animation_data.nla_tracks: track.mute=True
        clip=bpy.data.actions.new(animation)
        rig.animation_data.action=clip
        bones=sorted(rig.pose.bones,key=lambda b:len(b.parent_recursive))
        for frame in range(int(source_clip.frame_range[0]),int(source_clip.frame_range[1])+1):
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            matrices={bone.name:source_rig.pose.bones[bone.name].matrix.copy() for bone in bones if bone.name in source_rig.pose.bones}
            for bone in bones:
                if bone.name not in matrices: continue
                bone.rotation_mode='QUATERNION'
                bone.matrix=matrices[bone.name]
                bpy.context.view_layer.update()
                for prop in ['location','rotation_quaternion','scale']:bone.keyframe_insert(prop,frame=frame)
        rig.animation_data.action=None
        track=rig.animation_data.nla_tracks.new();track.name=animation
        strip=track.strips.new(animation,int(source_clip.frame_range[0]),clip)
        if hasattr(strip,'action_slot') and clip.slots: strip.action_slot=clip.slots[0]
        for obj in imported:bpy.data.objects.remove(obj,do_unlink=True)
    for track in rig.animation_data.nla_tracks: track.mute=False
    mat=bpy.data.materials.new('Kenney '+skin);mat.use_nodes=True
    bsdf=mat.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Roughness'].default_value=.85
    image=bpy.data.images.load(str(source/f'Skins/{skin}.png'));image.pack()
    tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image;tex.interpolation='Closest'
    mat.node_tree.links.new(tex.outputs['Color'],bsdf.inputs['Base Color'])
    mesh.data.materials.clear();mesh.data.materials.append(mat)
    bpy.context.scene.render.fps=24
    bpy.ops.object.select_all(action='DESELECT')
    for obj in model_objects:obj.select_set(True)
    bpy.context.view_layer.objects.active=rig
    path=out/('official-3d-'+skin);path.mkdir(parents=True,exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(path/'model.glb'),export_format='GLB',use_selection=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_optimize_animation_size=False)
    print('CONVERTED',skin,[(a.name,list(a.frame_range)) for a in bpy.data.actions])
