// The effective node graph, inherited properties and world transforms come from
// Godot's immutable source index. Only resolve the small leaf resources below.
import {readFileSync} from 'node:fs';
import {hash} from './schema.mjs';
import {nativeHasAutoload,nativeViewportSettings} from './native-project-settings.mjs';
import {nativeMatrix} from './native-view.mjs';

export const threeGameStarter=readFileSync(new URL('./templates/three-main.js',import.meta.url));
const starterHash=hash(threeGameStarter);

const passive=new Set(['Node','Node3D','Marker3D','Camera3D','AnimationPlayer','AudioStreamPlayer','AudioStreamPlayer3D',
  'StaticBody3D','RigidBody3D','CharacterBody3D','Area3D','CollisionShape3D','CollisionPolygon3D','AnimatableBody3D','CanvasLayer']);
// Animation, physics and native audio may run without attaching a script.
const staticGameNodes=new Set(['Node','Node3D','Marker3D','Camera3D','MeshInstance3D','WorldEnvironment',
  'DirectionalLight3D','OmniLight3D','SpotLight3D']);
const primitiveTypes={BoxMesh:'box',SphereMesh:'sphere',CylinderMesh:'cylinder',CapsuleMesh:'capsule',PlaneMesh:'plane',TorusMesh:'torus'};
const materialKeys=new Set(['albedo_color','roughness','metallic','transparency','emission_enabled','emission','emission_energy_multiplier','resource_name','resource_local_to_scene']);
const scalar=value=>typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value))?Number(value):null;
function tuple(value,type,count) {
  if(!value?.startsWith(type+'(')||!value.endsWith(')'))return null;
  const values=value.slice(type.length+1,-1).split(',').map(scalar);
  return values.length===count&&values.every(Number.isFinite)?values:null;
}

// Only isolated text subresources that we understand in full are eligible.
// Binary, scripted, external and unrecognized materials stay on the native path.
function readSections(bytes){
  const sections=new Map();let current=null;
  for(const line of bytes.toString('utf8').split(/\r?\n/)){
    if(line.startsWith('[')){
      current=null;
      if(line.startsWith('[sub_resource ')){
        const id=line.match(/\bid="([^"\\]+)"/)?.[1],type=line.match(/\btype="([^"\\]+)"/)?.[1];
        if(id&&type){current={type,fields:new Map()};sections.set(id,current);}
      }
    }else if(current&&line.trim()&&!line.trimStart().startsWith(';')){
      const equals=line.indexOf(' = ');if(equals<1){current.invalid=true;continue;}
      current.fields.set(line.slice(0,equals),line.slice(equals+3));
    }
  }
  return sections;
}

function projectMesh(properties,resolve){
  const reference=properties.get('mesh');if(!reference)return {};
  const mesh=resolve(reference.path);
  if(!mesh||mesh.invalid||mesh.type!==reference.class||!Object.hasOwn(primitiveTypes,mesh.type))return null;
  if(['visibility_range_begin','visibility_range_end','transparency','sorting_offset'].some(key=>properties.get(key)>0)||
     (properties.get('layers')??1)!==1)return null;
  const result={type:primitiveTypes[mesh.type]};
  const allowed={
    box:['size'],sphere:['radius','height','radial_segments','rings'],cylinder:['top_radius','bottom_radius','height','radial_segments','rings'],
    torus:['inner_radius','outer_radius','rings','ring_segments'],capsule:['radius','height','radial_segments','rings'],plane:['size']
  }[result.type];
  for(const [key,value] of mesh.fields){
    if(['material','resource_name','resource_local_to_scene'].includes(key))continue;
    if(!allowed.includes(key))return null;
    const pair=key==='size'&&result.type==='plane';
    const field=key==='size'?tuple(value,pair?'Vector2':'Vector3',pair?2:3):scalar(value);
    if(field===null||(Array.isArray(field)?field.some(size=>size<0):field<0))return null;
    if(['rings','ring_segments','radial_segments'].includes(key)&&(!Number.isInteger(field)||field>256))return null;
    result[key]=field;
  }
  const override=properties.get('material_override')??properties.get('surface_material_override/0');
  let material=null;
  if(override)material=resolve(override.path);
  else if(mesh.fields.has('material')){
    const id=mesh.fields.get('material').match(/^SubResource\("([^"\\]+)"\)$/)?.[1];
    if(id)material=resolve(reference.path.split('::')[0]+'::'+id);
  }
  if(override||mesh.fields.has('material')){
    if(material?.type!=='StandardMaterial3D'||material.invalid)return null;
    for(const [key,value] of material.fields){
      if(!materialKeys.has(key))return null;
      if(key==='albedo_color'){result.color=tuple(value,'Color',4);if(!result.color)return null;}
      if(key==='roughness'||key==='metallic'){result[key]=scalar(value);if(result[key]===null)return null;}
      if(key==='transparency'){if(!['0','1'].includes(value))return null;result.transparent=value==='1';}
      if(key==='emission_enabled'&&value==='true'){
        result.emission=material.fields.has('emission')?tuple(material.fields.get('emission'),'Color',4):[0,0,0,1];
        result.emission_energy=scalar(material.fields.get('emission_energy_multiplier')??'1');
        if(!result.emission||result.emission_energy===null)return null;
      }
    }
  }
  if(properties.get('material_overlay')||properties.get('skin')||properties.get('cast_shadow')===3)return null;
  return {mesh:result,cast_shadow:properties.get('cast_shadow')!==0};
}

function projectEnvironment(props,resolve){
  if(props.get('camera_attributes')||props.get('compositor'))return null;
  const resource=resolve(props.get('environment')?.path);
  if(!resource||resource.invalid||resource.type!=='Environment')return null;
  const f=resource.fields,allowed=new Set(['background_mode','background_color','background_energy_multiplier','ambient_light_source',
    'ambient_light_color','ambient_light_energy','reflected_light_source','tonemap_mode','tonemap_exposure','resource_name']);
  if([...f.keys()].some(key=>!allowed.has(key))||f.get('background_mode')!=='1')return null;
  const color=(key,defaultValue)=>f.has(key)?tuple(f.get(key),'Color',4):defaultValue;
  const background=color('background_color',[0,0,0,1]),ambient=color('ambient_light_color',[0,0,0,1]);
  if(!background||!ambient)return null;
  const environment={background,ambient,background_energy:scalar(f.get('background_energy_multiplier')??'1'),
    ambient_energy:f.get('ambient_light_source')==='1'?0:scalar(f.get('ambient_light_energy')??'1'),
    exposure:scalar(f.get('tonemap_exposure')??'1'),tone_mapper:scalar(f.get('tonemap_mode')??'0')};
  return Object.values(environment).includes(null)?null:environment;
}

export function threeSceneProjection(manifest,resourceId,readFile){
  const resource=manifest.resources?.[resourceId];
  if(!resource?.native_nodes?.length||resource.project_source_identity!==manifest.source_identity||
      manifest.index_source_identity!==manifest.source_identity)return null;
  const files=new Map();
  function resolve(path){
    if(typeof path!=='string')return null;
    const [file,id]=path.replace(/^res:\/\//,'').split('::');
    const entry=manifest.source_files[file];
    if(!entry||!id||!file.endsWith('.tscn')||entry.size>8*1024*1024)return null;
    if(!files.has(file))files.set(file,readSections(readFile(entry)));
    return files.get(file).get(id);
  }
  const nodes=[],visibility=new Map();let environment=null;
  for(const node of resource.native_nodes){
    const props=new Map(node.properties?.map(p=>[p.name,p.value]));
    const parent=node.path.includes('/')?node.path.slice(0,node.path.lastIndexOf('/')):'.';
    const visible=props.get('visible')!==false&&visibility.get(parent)!==false;
    visibility.set(node.path,visible);
    const row={path:node.path,type:node.type,world_matrix:nativeMatrix(node.world_transform),visible,...(props.get('top_level')?{top_level:true}:{})};
    if(node.type==='MeshInstance3D'){
      const projected=projectMesh(props,resolve);if(!projected)return null;Object.assign(row,projected);
    }else if(['DirectionalLight3D','OmniLight3D','SpotLight3D'].includes(node.type)){
      if(props.get('light_projector')||props.get('light_negative'))return null;
      row.light={color:props.get('light_color')?.value??[1,1,1,1],energy:props.get('light_energy')??1,
        shadow:props.get('shadow_enabled')??false,shadow_distance:props.get('directional_shadow_max_distance')??50,
        range:props.get('omni_range')??props.get('spot_range')??5,angle:props.get('spot_angle')??45};
    }else if(node.type==='WorldEnvironment'){
      if(environment)return null;
      environment=projectEnvironment(props,resolve);if(!environment)return null;
    }else if(node.type==='Camera3D'){
      if(props.get('projection')||props.get('environment')||props.get('attributes'))return null;
      row.camera={current:props.get('current')??false,fov:props.get('fov')??75,near:props.get('near')??0.05,far:props.get('far')??4000};
    }else if(!passive.has(node.type))return null;
    nodes.push(row);
  }
  const settings=manifest.source_files['project.godot'];
  const viewport=nativeViewportSettings(settings&&settings.size<1024*1024?readFile(settings).toString('utf8'):'');
  return {version:1,nodes,environment,...viewport};
}

export function usesThreeWeb(manifest,resourceId,readFile){
  const entry=manifest?.source_files?.['web/main.js'];
  if(!entry)return false;
  if(entry.hash!==starterHash)return true;
  // A newly added native behaviour should run even before an Agent has
  // ported it. The static starter can render only its source projection.
  if(Object.keys(manifest.source_files).some(path=>/\.(gd|cs|gdextension)$/.test(path)))return false;
  const resource=manifest.resources[resourceId];
  if(!resource?.native_nodes?.every(node=>staticGameNodes.has(node.type))||resource.native_connections?.length)return false;
  const settings=manifest.source_files['project.godot'];
  if(settings&&nativeHasAutoload(readFile(settings).toString('utf8')))return false;
  return Boolean(threeSceneProjection(manifest,resourceId,readFile));
}
