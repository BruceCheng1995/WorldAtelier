import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync,rmSync,renameSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {join,dirname,resolve,relative} from 'node:path';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {hash,stable,fail} from './schema.mjs';
import {nativeLaunchSettings} from './native-snapshot.mjs';
import {assembleNativeEditorProject} from '../../tools/native-editor/assemble-native-editor.mjs';
export const NATIVE_SHARED_CONTRACT='wa-native-world-state-1';
export function nativeSharedInventory(directory,base=directory){
 return readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(item=>{
  if(['.godot','.git'].includes(item.name))return [];
  const file=join(directory,item.name),stat=lstatSync(file);if(stat.isSymbolicLink())throw Error('Shared fixed project contains symlink');
  if(stat.isDirectory())return nativeSharedInventory(file,base);if(!stat.isFile())throw Error('Shared fixed project has non-file entry');
  const bytes=readFileSync(file),after=lstatSync(file);if(stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ino!==after.ino)throw Error('Shared project changed while snapshotting');
  return [{path:relative(base,file).split('\\').join('/'),sha256:hash(bytes),size:bytes.length}];
 });
}
/** Native authority source and a script-free client projection of the exact same
 * fixed input. Called only after ordinary canonical assembleProject. */
export async function configureNativeSharedProject({service,job,directory,godotPath='/Applications/Godot.app/Contents/MacOS/Godot',executionEnvironment,enforceIsolation=true,run}){
 directory=realpathSync(directory);
 const runtime=join(directory,'atelier_runtime'),release=JSON.parse(readFileSync(join(runtime,'release.json'))),manifest=JSON.parse(readFileSync(join(runtime,'source-manifest.json')));
 if(manifest.schema!=='creation-native-1'||release.revision!==job.source_revision||release.source_identity!==manifest.source_identity)fail(409,'Shared project fixed source mismatch');
 const authority_directory=join(dirname(directory),'native-authority');if(existsSync(authority_directory))fail(409,'Fixed authority directory already exists');
 cpSync(directory,authority_directory,{recursive:true,filter:path=>!path.split('/').includes('.godot')});
 const shared={protocol:1,native_client_protocol:1,contract:NATIVE_SHARED_CONTRACT,role:'authority',build_id:job.canonical_identity??job.id,source_identity:manifest.source_identity};
 writeFileSync(join(authority_directory,'atelier_runtime/release.json'),JSON.stringify({...release,native_shared:shared},null,2)+'\n');
 const temp=mkdtempSync(join(tmpdir(),'wa-shared-client-')),trusted=join(temp,'trusted'),projection=join(dirname(directory),'shared-projection-candidate');
 mkdirSync(trusted);writeFileSync(join(trusted,'native_main.gd'),'extends Node\n');writeFileSync(join(trusted,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://native_main.gd" id="1"]\n[node name="SharedPreview" type="Node"]\nscript=ExtResource("1")\n');
 const scenes=Object.values(release.scenes),initialScene=release.scenes[job.entry_scene_id??release.entry_scene_id];
 const before=nativeSharedInventory(authority_directory);
 try{
  const baked=await assembleNativeEditorProject({sourceDirectory:authority_directory,destinationDirectory:projection,runtimeDirectory:trusted,runtimeFiles:['native_main.gd','main.tscn'],initialScene,scenes,sourceIdentity:manifest.source_identity,godotPath,executionEnvironment,enforceIsolation,run});
  cpSync(join(authority_directory,'atelier_runtime'),join(projection,'atelier_runtime'),{recursive:true});
  const paths=Object.fromEntries(scenes.map(scene=>[scene.resource_id,baked.config.preview_scenes[scene.native_scene_path]]));
  writeFileSync(join(projection,'atelier_runtime/release.json'),JSON.stringify({...release,native_shared:{...shared,role:'client',scenes:paths}},null,2)+'\n');
  writeFileSync(join(projection,'project.godot'),nativeLaunchSettings(readFileSync(join(projection,'project.godot'),'utf8')));
  if(stable(before)!==stable(nativeSharedInventory(authority_directory)))throw Error('Fixed native authority project changed during projection build');
  const receipt={format:1,native_client_protocol:1,contract:NATIVE_SHARED_CONTRACT,source_revision:release.revision,source_identity:manifest.source_identity,build_id:shared.build_id,authority_directory,authority_files:before,projection_files:nativeSharedInventory(projection),state_config:{declaration:'metadata/wa_shared',state:'explicit_properties',defaults:'explicit_properties',dynamic:'GameRuntime.shared.spawn',inputs:'declared_actions_only'},bake:baked.receipt,policy:{...baked.config.policy,preview_only:false,gameplay:'central_authority_only',author_scripts_on_client:false}};
  rmSync(directory,{recursive:true});renameSync(projection,directory);
  return {directory,authority_directory,receipt};
 }catch(error){rmSync(projection,{recursive:true,force:true});throw error;}finally{rmSync(temp,{recursive:true,force:true});}
}
const metaValue=value=>value?.$type==='Dictionary'?value.value:value;
/** A strict fast path: only explicitly declared parameter properties may differ.
 * Any changed executable/media, topology, connection or state contract transfers
 * a fully fixed candidate process instead. */
export function classifyNativeSharedUpdate(previous,next,resource_id){
 const refuse=reason=>({compatible:false,updates:[],reason});
 if(previous.schema!=='creation-native-1'||next.schema!==previous.schema)return refuse('schema_change');
 if(stable(Object.keys(previous.resources).sort())!==stable(Object.keys(next.resources).sort()))return refuse('resource_catalog_change');
 const changed=[...new Set([...Object.keys(previous.source_files),...Object.keys(next.source_files)])].filter(path=>previous.source_files[path]?.hash!==next.source_files[path]?.hash);
 if(changed.some(path=>!path.endsWith('.tscn')&&path!=='.atelier/catalog.json'&&path!=='.atelier/migration.json'))return refuse('executable_or_dependency_change');
 const updates=[];
 for(const [rid,old]of Object.entries(previous.resources)){
  const current=next.resources[rid];
  if(old.path!==current.path||old.kind!==current.kind||stable(old.native_connections??[])!==stable(current.native_connections??[]))return refuse('resource_structure_change');
  const a=old.native_nodes??[],b=current.native_nodes??[];
  if(a.length!==b.length)return refuse('node_count_change');
  for(let i=0;i<a.length;i++){
   const left=a[i],right=b[i];
   for(const key of ['node_id','instance_ids','name','path','type','owner_path','scene_file_path','metadata'])if(stable(left[key])!==stable(right[key]))return refuse('node_structure_or_contract_change');
   const schema=metaValue(left.metadata?.wa_shared)??{},allowed=schema.defaults??[];
   const lp=new Map(left.properties.map(p=>[p.name,p])),rp=new Map(right.properties.map(p=>[p.name,p]));
   if(stable([...lp.keys()].sort())!==stable([...rp.keys()].sort()))return refuse('property_schema_change');
   for(const [name,l]of lp){const r=rp.get(name);if(stable(l.value)===stable(r.value))continue;
    if(!allowed.includes(name)||!l.exported||l.type!==r.type||schema.state?.includes(name))return refuse('non_parameter_property_change:'+name);
    updates.push({resource_id:rid,node_id:left.node_id,instance_ids:left.instance_ids,property:name,previous:l.value,value:r.value});
   }
  }
 }
 if(!next.resources[resource_id])return refuse('entry_removed');
 return {compatible:true,updates,reason:'declared_parameter_defaults_only'};
}
