import {build, version as esbuildVersion} from 'esbuild';
import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {join, posix, sep} from 'node:path';
import {writeFile, mkdir} from 'node:fs/promises';
import {hash} from './schema.mjs';
import {nativeScenePacket} from './native-view.mjs';
import {nativeViewportSettings} from './native-project-settings.mjs';
import {nativeSemanticDetail} from './native-semantic.mjs';
import {isPrefabTest,isPrefabTestPath} from './prefab-tests.mjs';
import {createFileIdentityCache} from './file-identity.mjs';

export const THREE_WEB_POLICY='world-atelier-three-web-1';
export const THREE_ENTRY='web/main.js';
const runtimePath='runtimes/three-game/player.js';
const playerModules=['inspection.js','hud.js','preview-clock.js'];
const projectedMaterialPath='apps/creation-workspace/three-native-materials.js';
const directLightPath='apps/creation-workspace/three-gles-direct.js';
const postPath='apps/creation-workspace/three-native-post.js';
const projectedNodePath='apps/creation-workspace/three-source-scene.js';
const canvasLayoutPath='apps/creation-workspace/three-control-layout.js';
const vendorFiles=['three.module.min.js','three.core.min.js'];
const addonEntries=new Set([
  'math/Capsule.js','math/Octree.js','utils/SkeletonUtils.js','loaders/GLTFLoader.js','controls/OrbitControls.js','postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js','postprocessing/ShaderPass.js','postprocessing/OutputPass.js','postprocessing/OutlinePass.js'
]);
const addonFiles=new Set([...addonEntries,'utils/BufferGeometryUtils.js','postprocessing/Pass.js','postprocessing/MaskPass.js','shaders/CopyShader.js','shaders/OutputShader.js']);
const fileIdentity=createFileIdentityCache();
function threeFile(root,path){
  const base=join(root,'node_modules/three'),file=join(base,path);
  if(!existsSync(file))return file;
  const actual=realpathSync(file);
  if(!actual.startsWith(realpathSync(base)+sep))throw Error('Three.js 官方模块路径位于锁定包外');
  return actual;
}
const assetLoaders=new Set(['.glb','.gltf','.bin','.png','.jpg','.jpeg','.webp','.svg','.gif','.wav','.ogg','.mp3','.woff2','.ttf']);
export function threeToolchain(root){
  return {policy:THREE_WEB_POLICY,compiler:esbuildVersion,renderer:vendorFiles.map(name=>({name,...fileIdentity(threeFile(root,'build/'+name))})),addons:[...addonFiles].map(name=>({name,...fileIdentity(threeFile(root,'examples/jsm/'+name))})),player:fileIdentity(join(root,runtimePath)),playerModules:playerModules.map(name=>({name,...fileIdentity(join(root,'runtimes/three-game',name))})),projection:fileIdentity(join(root,projectedNodePath)),canvasLayout:fileIdentity(join(root,canvasLayoutPath)),nativePost:fileIdentity(join(root,postPath)),surfaceMaterials:fileIdentity(join(root,projectedMaterialPath)),directLighting:fileIdentity(join(root,directLightPath)),sceneProjection:fileIdentity(join(root,'services/creation/three-scene-projection.mjs')),bundler:fileIdentity(join(root,'services/creation/three-web-build.mjs'))};
}
const loaders={'.js':'js','.mjs':'js','.json':'json','.txt':'text','.tscn':'text','.tres':'text','.gdshader':'text'};

// No author import reaches esbuild's host filesystem resolver. Materials are
// read through the fixed revision archive, which verifies each blob's digest.
function fixedModules({root,manifest,archive,toolchain}){
  const pinned=new Map([[runtimePath,toolchain.player],[projectedNodePath,toolchain.projection],[canvasLayoutPath,toolchain.canvasLayout],[postPath,toolchain.nativePost],[projectedMaterialPath,toolchain.surfaceMaterials],[directLightPath,toolchain.directLighting]]);
  for(const file of toolchain.playerModules)pinned.set('runtimes/three-game/'+file.name,file);
  for(const file of toolchain.renderer)pinned.set('build/'+file.name,file);
  for(const file of toolchain.addons)pinned.set('examples/jsm/'+file.name,file);
  // Check the exact bytes handed to the compiler as well as the queue's
  // pre/post toolchain checks. Never replace a pinned addon with a newer file.
  const trusted=(path,vendor=false)=>{
    const bytes=readFileSync(vendor?threeFile(root,path):join(root,path));
    if(hash(bytes)!==pinned.get(path)?.sha256)throw Error('Web 编译模块与固定构建不一致: '+path);
    return {contents:bytes,loader:'js'};
  };
  return {
    name:'fixed-three-project',
    setup(builder){
      builder.onResolve({filter:/.*/},args=>{
        const {path,importer,namespace,kind}=args;
        if(kind==='entry-point')return {path:runtimePath,namespace:'runtime'};
        if(namespace==='runtime'&&importer===runtimePath&&path==='./three-control-layout.js')return {path:canvasLayoutPath,namespace:'projector'};
        if(namespace==='projector'&&importer===projectedMaterialPath&&path==='./three-gles-direct.js')return {path:directLightPath,namespace:'projector'};
        if(namespace==='projector'&&[projectedNodePath,projectedMaterialPath].includes(importer)&&path==='./three-native-post.js')return {path:postPath,namespace:'projector'};
        if(namespace==='projector'&&importer===projectedNodePath&&path==='./three-control-layout.js')return {path:canvasLayoutPath,namespace:'projector'};
        if(namespace==='projector'&&importer===projectedNodePath&&path==='./three-native-materials.js')return {path:projectedMaterialPath,namespace:'projector'};
        if(namespace==='source'&&path==='@world-atelier/scene')return {path:projectedNodePath,namespace:'projector'};
        const addonPrefix=['three/addons/','three/examples/jsm/'].find(prefix=>path.startsWith(prefix));
        if(namespace==='source'&&addonPrefix&&addonEntries.has(path.slice(addonPrefix.length)))return {path:path.slice(addonPrefix.length),namespace:'addon'};
        if(namespace==='addon'&&/^\.{1,2}\//.test(path)&&!path.includes('\\')){
          const target=posix.join(posix.dirname(importer),path);
          if(addonFiles.has(target))return {path:target,namespace:'addon'};
        }
        if(path==='three')return {path:vendorFiles[0],namespace:'three'};
        if(namespace==='three'&&path==='./three.core.min.js')return {path:vendorFiles[1],namespace:'three'};
        if(namespace==='runtime'&&importer===runtimePath&&path.startsWith('./')&&playerModules.includes(path.slice(2)))return {path:'runtimes/three-game/'+path.slice(2),namespace:'runtime'};
        if(namespace==='runtime'&&path==='wa:game')return {path:THREE_ENTRY,namespace:'source'};
        if(namespace==='source'&&/^\.{1,2}\//.test(path)&&!path.includes('\\')){
          const target=posix.join(posix.dirname(importer),path);
          if(!isPrefabTestPath(target)&&Object.hasOwn(manifest.source_files,target))return {path:target,namespace:'source'};
        }
        throw Error('Web 导入必须指向固定工程的相对路径、three 或已支持的官方 addons: '+path);
      });
      builder.onLoad({filter:/.*/,namespace:'runtime'},args=>trusted(args.path));
      builder.onLoad({filter:/.*/,namespace:'projector'},args=>trusted(args.path));
      builder.onLoad({filter:/.*/,namespace:'three'},args=>trusted('build/'+args.path,true));
      builder.onLoad({filter:/.*/,namespace:'addon'},args=>trusted('examples/jsm/'+args.path,true));
      builder.onLoad({filter:/.*/,namespace:'source'},args=>{
        const ext=posix.extname(args.path).toLowerCase(),loader=loaders[ext]??(assetLoaders.has(ext)?'file':null);
        if(!loader)throw Error('未支持的 Web 模块类型: '+args.path);
        return {contents:archive.read(manifest.source_files[args.path]),loader};
      });
    }
  };
}

export async function buildThreeWeb({root, out, job, manifest, archive, projection}){
  if(!manifest.source_files[THREE_ENTRY]||job.game_identity.web_engine!=='three')throw Error('Three.js 游戏缺少固定入口');
  const result=await build({entryPoints:[runtimePath],plugins:[fixedModules({root,manifest,archive,toolchain:job.game_identity.toolchain?.three??threeToolchain(root)})],bundle:true,format:'iife',platform:'browser',target:'es2022',minify:true,write:false,logLevel:'silent',legalComments:'inline',outdir:out,entryNames:'index',assetNames:'asset-[hash]'});
  await mkdir(out,{recursive:true});
  const outputs=new Map(result.outputFiles.map(file=>[posix.basename(file.path),Buffer.from(file.contents)]));
  // Origins in edit projection resources must never be forwarded to games.
  const scenes=Object.create(null),prefabs=Object.create(null);
  const fixed={manifest,project_id:job.project_id,branch_id:job.branch_id,revision:job.source_revision};
  async function packetFor(resource){
    const packet=nativeScenePacket(manifest,resource.id,fixed);
    const properties=objectId=>nativeSemanticDetail(fixed,{resource_id:resource.id,...(objectId?{object_id:objectId}:{})}).properties;
    packet.exposed_properties=resource.design?.exposed_properties?.length?properties():[];
    const byPath=new Map(resource.native_nodes.map(node=>[node.path,node]));
    // Compatibility behaviours bind user-facing names to real, often nested
    // Godot properties. Include effective instance values even on non-selectable
    // controller components, so Web gameplay follows the inspector's edits.
    packet.behavior_parameters=resource.native_nodes.filter(node=>node.metadata?.wa_behavior_id).map(node=>{
      const values=Object.fromEntries(node.properties.filter(p=>p.exported).map(p=>[p.name,p.value]));
      const bindings=node.metadata.wa_property_bindings;
      return {path:node.path,node_id:node.node_id,kind:node.metadata.wa_behavior_id,properties:bindings?
        Object.fromEntries(Object.entries(bindings).map(([key,field])=>[key,values[field]])):values};
    });
    for(const object of packet.objects){
      const node=byPath.get(object.native_path);
      object.exported_properties=Object.fromEntries((node?.properties??[]).filter(property=>property.exported).map(property=>[property.name,property.value]));
      if(object.instance_root&&manifest.resources[object.definition_resource_id]?.design?.exposed_properties?.length)object.exposed_properties=properties(object.id);
    }
    packet.three_projection=await projection?.(manifest,resource.id,entry=>archive.read(entry),(asset,bytes)=>{
      const name='surface-'+asset.sha256+'.bin';
      if(!outputs.has(name))outputs.set(name,bytes);
      return name;
    })??null;
    if(resource.kind==='prefab')for(const node of packet.three_projection?.nodes??[])node.prefabPath=packet.native_scene_path;
    return packet;
  }
  const resources=Object.values(manifest.resources).filter(resource=>!isPrefabTest(resource)&&!isPrefabTestPath(resource.path));
  for(const resource of resources.filter(resource=>resource.kind==='scene'))scenes[resource.id]=await packetFor(resource);
  const definitions=resources.filter(resource=>resource.kind==='prefab');
  // Small projects load one prefab at a time. Group very large catalogs to fit
  // the same 1,000-file publication manifest as every other Web artifact.
  const shardsAvailable=1000-outputs.size-2;
  if(shardsAvailable<0||definitions.length&&shardsAvailable===0)throw Error('Web 资源数量超出发行文件上限');
  const perShard=Math.max(1,Math.ceil(definitions.length/Math.max(1,shardsAvailable)));
  for(let offset=0;offset<definitions.length;offset+=perShard){
    const packets=[];for(const resource of definitions.slice(offset,offset+perShard))packets.push(await packetFor(resource));
    const bytes=Buffer.from(JSON.stringify(packets)),name='prefabs-'+hash(bytes)+'.json';
    outputs.set(name,bytes);
    for(const packet of packets)prefabs[packet.resource_id]=name;
  }
  if(outputs.size+2>1000)throw Error('Web 资源数量超出发行文件上限');
  const project=manifest.source_files['project.godot'];
  const viewportSettings=nativeViewportSettings(project?archive.read(project).toString('utf8'):'');
  const content={identity:job.game_identity,scenes,prefabs,storage:job.storage,viewportSettings};
  const json=JSON.stringify(content).replaceAll('<','\\u003c');
  const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>世界工坊 · Web 游戏</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:white;font:16px system-ui}#surface{position:relative;width:100%;height:100%;contain:layout paint;overflow:hidden;background:#141923}#surface>canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}#ui{position:absolute;inset:0;pointer-events:none}#ui>*{pointer-events:auto}#ui[inert],#ui[inert] *{pointer-events:none}#error{position:absolute;inset:0;padding:1em;white-space:pre-wrap}#error:empty{display:none}</style></head><body><div id="surface"><canvas tabindex="0"></canvas><div id="ui"></div><div id="error" role="alert"></div></div><script type="application/json" id="wa-game">'+json+'</script><script src="index.js"></script></body></html>';
  const shell={policy:THREE_WEB_POLICY,content_key:job.canonical_identity,adapted_html_sha256:hash(Buffer.from(html)),engine:'three'};
  outputs.set('index.html',Buffer.from(html));
  outputs.set('game-identity.json',Buffer.from(JSON.stringify({...job.game_identity,storage:job.storage,shell})));
  for(const [name,bytes] of outputs)await writeFile(join(out,name),bytes);
  return {shell,files:[...outputs].map(([path,bytes])=>({path,size:bytes.length,sha256:hash(bytes)}))};
}
