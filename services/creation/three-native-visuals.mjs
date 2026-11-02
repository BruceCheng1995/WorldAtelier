// Content-addressed derivative of immutable native source. A failed or canceled
// import never changes the branch, the old editor or a previously built game.
import {mkdir,mkdtemp,readFile,writeFile,rename,rm,lstat,realpath,copyFile} from 'node:fs/promises';
import {basename,join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeMatrix} from './native-view.mjs';
import {hash} from './schema.mjs';
import {createFileIdentityCache} from './file-identity.mjs';
import {nativeViewportSettings} from './native-project-settings.mjs';
import {importNativeProject,runNativeScene} from '../../tools/native-scene/invoke.mjs';
import {isPrefabTest,isPrefabTestPath} from './prefab-tests.mjs';

const identify=createFileIdentityCache();
const jobs=new Map();
let preparation=Promise.resolve();
const budget=384*1024*1024;
export const surfaceAdapter='tools/native-scene/three_surfaces.gd';
export function visualCompilerIdentity(root,godot){
  return {adapter:identify(join(root,surfaceAdapter)),engine:identify(godot),font:identify(join(root,'runtimes/model-preview/fonts/NotoSansSC.ttf')),
    fontTheme:identify(join(root,'runtimes/model-preview/fonts/CreatorUI.tres'))};
}
const resourcesOf=m=>Object.values(m.resources).filter(r=>!isPrefabTest(r)&&!isPrefabTestPath(r.path));
const validFile=async(dir,file,max)=>{
  const name=join(dir,file),info=await lstat(name);
  if(!info.isFile()||info.size>max||!((await realpath(name)).startsWith((await realpath(dir))+sep)))throw Error('无效的原生渲染派生文件');
  return readFile(name);
};
function inputs(manifest){
  // JS belongs to the isolated Web game. No cached descriptor includes
  // executable source, scene transforms or authored property values from JS.
  return Object.fromEntries(Object.entries(manifest.source_files).filter(([name])=>!/^web\/.*\.(?:m?js)$/.test(name)));
}
async function bake(context,manifest,key,target){
  const {godot,root,archive}=context,base=resolve(context.data,'three-native-visuals');
  await mkdir(base,{recursive:true});
  const work=await mkdtemp(join(base,'preparing-')),project=join(work,'project');
  try{
    archive.materialize(inputs(manifest),project);
    // Use the editor host's actual font during Control measurement. A project
    // imported by the native editor otherwise inherits the host OS font metrics.
    let editorFont;
    if(resourcesOf(manifest).some(r=>r.native_nodes.some(n=>n.control_layout))){
      const fontDir=await mkdtemp(join(project,'wa-render-font-')),fontRoot=join(root,'runtimes/model-preview/fonts');
      editorFont='res://'+basename(fontDir)+'/CreatorUI.tres';
      await copyFile(join(fontRoot,'NotoSansSC.ttf'),join(fontDir,'NotoSansSC.ttf'));
      await writeFile(join(fontDir,'CreatorUI.tres'),(await readFile(join(fontRoot,'CreatorUI.tres'),'utf8')).replace('res://fonts/', 'res://'+basename(fontDir)+'/'));
    }
    await importNativeProject({projectDirectory:project,godotPath:godot,enforceIsolation:true,timeoutMs:180000});
    const destination=join(project,'.godot','wa-three-surfaces');
    if(!(await realpath(join(project,'.godot'))).startsWith((await realpath(project))+sep))throw Error('无效的原生导入目录');
    await mkdir(destination);
    const checkedDestination=await realpath(destination);
    if(!checkedDestination.startsWith((await realpath(project))+sep))throw Error('无效的渲染派生目录');
    const resources=resourcesOf(manifest);
    const paths=resources.map(r=>'res://'+r.path.replace(/^res:\/\//,''));
    const result=await runNativeScene({projectDirectory:project,request:{action:'inspect_many',scene_paths:paths,directory:destination,editor_font:editorFont},
      godotPath:godot,adapterPath:join(root,surfaceAdapter),enforceIsolation:true,timeoutMs:180000});
    if(await realpath(destination)!==checkedDestination)throw Error('渲染派生目录在提取中发生变化');
    if(result.scenes?.length!==resources.length)throw Error('原生渲染资源提取不完整');
    const out=join(work,'ready');await mkdir(out);
    const inventory={key,resources:{}};
    for(const [i,resource] of resources.entries()){
      const meta=await validFile(destination,i+'.json',32*1024*1024);
      const binary=await validFile(destination,i+'.bin',budget);
      if(binary.length!==result.scenes[i].size)throw Error('渲染资源大小不一致');
      const entry={index:i,sha256:hash(binary),size:binary.length,meta_hash:hash(meta)};
      await writeFile(join(out,i+'.json'),meta);await writeFile(join(out,i+'.bin'),binary);
      inventory.resources[resource.id]=entry;
    }
    await writeFile(join(out,'inventory.json'),JSON.stringify(inventory));
    try{await rename(out,target);}catch(error){if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
  }finally{await rm(work,{recursive:true,force:true});}
}
async function cached(context,manifest){
  const key=hash({files:inputs(manifest),resources:resourcesOf(manifest).map(r=>[r.id,r.path]),compiler:visualCompilerIdentity(context.root,context.godot)});
  const target=join(context.data,'three-native-visuals',key),inventory=join(target,'inventory.json');
  let bytes;
  try{bytes=await readFile(inventory);}catch(error){
    if(error.code!=='ENOENT')throw error;
    if(!jobs.has(target)){
      const job=preparation.then(()=>bake(context,manifest,key,target)).finally(()=>jobs.delete(target));
      jobs.set(target,job);preparation=job.catch(()=>{});
    }
    await jobs.get(target);bytes=await readFile(inventory);
  }
  const catalog=JSON.parse(bytes);
  if(catalog.key!==key)throw Error('渲染资源缓存身份不匹配');
  return {catalog,target};
}
export async function nativeVisualProjection(context,manifest,resourceId){
  const {catalog,target}=await cached(context,manifest),entry=catalog.resources[resourceId];
  if(!entry)return null;
  const meta=await validFile(target,entry.index+'.json',32*1024*1024);
  if(hash(meta)!==entry.meta_hash)throw Error('渲染资源索引校验失败');
  const data=JSON.parse(meta),resource=manifest.resources[resourceId],visibility=new Map();
  const projectText=context.archive.read(manifest.source_files['project.godot']).toString('utf8');
  let environment=null;
  const nodes=resource.native_nodes.map(node=>{
    const props=new Map(node.properties.map(p=>[p.name,p.value])),visual=data.nodes[node.path]??{};
    const parent=node.path.includes('/')?node.path.slice(0,node.path.lastIndexOf('/')):'.';
    const visible=props.get('visible')!==false&&visibility.get(parent)!==false;
    visibility.set(node.path,visible);
    if(visual.environment)environment=visual.environment;
    const row={...visual,path:node.path,type:node.type,world_matrix:visual.posed_matrix??nativeMatrix(node.world_transform),visible,...(props.get('top_level')?{top_level:true}:{})};
    if(row.canvas){
      row.canvas={...row.canvas,size:props.get('size')?.value??[0,0],modulate:props.get('modulate')?.value,minimum_size:row.canvas.minimum_size??node.control_layout?.minimum_size,layout:node.control_layout?.values};
    }
    return row;
  });
  const projection={version:1,nodes,environment,...nativeViewportSettings(projectText),
    dimension:nodes.some(n=>n.mesh||n.label)?'3d':nodes.some(n=>n.canvas)?'2d':'3d',
    geometry:data.geometry,images:data.images,differences:data.differences};
  const asset=entry.size?{path:join(target,entry.index+'.bin'),size:entry.size,sha256:entry.sha256}:null;
  return {projection,asset};
}
export async function readVisualBytes(asset){
  const bytes=await readFile(asset.path);
  if(bytes.length!==asset.size||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('固定渲染资源校验失败');
  return bytes;
}
