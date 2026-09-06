import {mkdir,readFile,cp,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicWrite,jsonFile,materialize,cleanSource} from './runtime.mjs';
const HERE=dirname(fileURLToPath(import.meta.url));
export async function createNativeEditor({directory,templateRoot,nodeBinary=process.execPath}){
  directory=resolve(directory);const editor=join(directory,'editor');
  try{await stat(editor);throw Error('editor already exists; retain its unsaved scene and export or copy it before generating another');}catch(e){if(e.code!=='ENOENT')throw e;}
  templateRoot??=join(HERE,'native-editor-template');
  try{await stat(templateRoot);}catch{templateRoot=resolve(HERE,'../../tools/native-editor/template');}
  const source=cleanSource(await jsonFile(join(directory,'content.json'))),workspace=await jsonFile(join(directory,'workspace.json'));
  const blobs={...workspace.play_content?.asset_blobs,...await jsonFile(join(directory,'source-assets.json'),{})};
  materialize(source,blobs);
  await cp(templateRoot,editor,{recursive:true});await mkdir(join(editor,'assets'),{recursive:true});
  for(const object of source.objects)if(object.model_asset)await atomicWrite(join(editor,'assets',object.model_asset+'.glb'),Buffer.from(blobs[object.model_asset].data_base64,'base64'));
  const project=`config_version=5\n[application]\nconfig/name="世界工坊 · 原生场景工作区"\nrun/main_scene="res://world.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0.05,0.075,0.12,1)\n[editor_plugins]\nenabled=PackedStringArray("res://addons/world_atelier/plugin.cfg")\n[world_atelier]\nnode_binary=${JSON.stringify(nodeBinary)}\n`;
  await atomicWrite(join(editor,'project.godot'),project);await atomicWrite(join(editor,'import-base.json'),source);
  const quote=v=>JSON.stringify(v),lines=['[gd_scene load_steps=3 format=3]','','[ext_resource type="Script" path="res://atelier_object.gd" id="1"]','[ext_resource type="Script" path="res://atelier_world.gd" id="2"]','','[node name="WorldAtelier" type="Node3D"]','script = ExtResource("2")',`source_json = ${quote(JSON.stringify(source))}`];
  for(const [index,o] of source.objects.entries()){
    const color=o.color??'#8db5ca',rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);
    lines.push('',`[node name="Object_${index}_${o.id.replace(/[^A-Za-z0-9_]/g,'_')}" type="Node3D" parent="."]`,'script = ExtResource("1")',`position = Vector3(${o.x}, 0, ${o.z})`,`scale = Vector3(${o.scale??1}, ${o.scale??1}, ${o.scale??1})`,`stable_id = ${quote(o.id)}`,`display_name = ${quote(o.name??o.id)}`,`object_kind = ${quote(o.kind)}`,`object_color = Color(${rgb.join(', ')}, 1)`,`solid = ${!!o.solid}`,`model_asset = ${quote(o.model_asset??'')}`,`source_json = ${quote(JSON.stringify(o))}`);
  }
  await atomicWrite(join(editor,'world.tscn'),lines.join('\n')+'\n');
  await atomicWrite(join(editor,'EDITOR-README.txt'),'Open project.godot in Godot 4.6. Edit real Node3D X/Z, uniform scale, Display Name, Object Color, Solid, or a verified Model Asset hash. Save world.tscn: editor plugin exports and three-way merges into ../content.json. Run launcher/workspace-cli.mjs watch to build/apply. Native scene export preserves unsupported source fields. Y, rotation and nonuniform scale are rejected because schema1 cannot represent them. Editor/source conflicts are preserved in native-export-conflicts.json; source is not overwritten. Full runtime code changes require a new runtime build.\n');
  return {editor,scene:join(editor,'world.tscn'),project:join(editor,'project.godot')};
}
