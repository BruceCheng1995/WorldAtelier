import {readFileSync,mkdirSync,cpSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {hash,fail} from './schema.mjs';
import {projectInventory,verifyProjectFiles} from './project-snapshot.mjs';
import {nativeScenePacket} from './native-view.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';
import {scanNativeWorkspace} from './native-agent-workspace.mjs';
import {assembleNativeEditorProject} from '../../tools/native-editor/assemble-native-editor.mjs';
import {NATIVE_CONTENT_PROTOCOL} from './native-editor-content.mjs';

export const NATIVE_EDITOR_CONTRACT='world-atelier-native-editor-v1';
export function editorToolIdentity(root){return hash(readFileSync(join(root,'tools/native-editor/bake_preview.gd')));}
export function snapshotNativeEditorRuntime(root,directory){
  const source=join(root,'runtimes/model-preview'),files=projectInventory(source);
  for(const file of files){const out=join(directory,file.path);mkdirSync(dirname(out),{recursive:true});cpSync(join(source,file.path),out);}
  return {files,hash:hash(files),bake_tool_hash:editorToolIdentity(root)};
}
export async function assembleNativeEditorBuild(builds,job){
  const {service,store}=builds,user=builds.executionUser(job),branch=store.branchFor(user,job.project_id,job.branch_id);
  const fixed=store.get('creator_revision',job.source_revision);
  if(!fixed||fixed.project_id!==job.project_id||!store.ancestor(fixed.id,branch.head)||fixed.manifest.schema!==NATIVE_SCHEMA)fail(409,'原生预览源版本无效');
  const base=join(builds.directory,job.id),runtime=join(base,'runtime'),source=join(base,'native-source'),destination=join(base,'project');
  verifyProjectFiles(runtime,job.runtime_sources);
  service.native.archive.materialize(fixed.manifest.source_files,source);
  const scenes=Object.keys(fixed.manifest.resources).map(rid=>nativeScenePacket(fixed.manifest,rid,{project_id:job.project_id,branch_id:job.branch_id,revision:fixed.id}));
  const initialScene=scenes.find(scene=>scene.resource_id===job.entry_scene_id);
  const result=await assembleNativeEditorProject({sourceDirectory:source,destinationDirectory:destination,runtimeDirectory:runtime,
    runtimeFiles:job.runtime_sources.map(file=>file.path).filter(path=>/\.(gd|gdshader|gdshaderinc|tscn|tres|ttf|otf|json)$/.test(path)),
    initialScene,scenes,godotPath:builds.godot});
  const runtimePaths=new Set(job.runtime_sources.map(file=>file.path));
  for(const file of job.runtime_sources.filter(file=>file.path.endsWith('.import'))){
    const original=readFileSync(join(runtime,file.path),'utf8');
    let text=original.replace(/res:\/\/([^"'\s)]+)/g,(full,path)=>runtimePaths.has(path)?'res://atelier_editor/'+path:full);
    const before=original.match(/^source_file="([^"]+)"$/m)?.[1],after=text.match(/^source_file="([^"]+)"$/m)?.[1];
    if(before&&after&&before!==after){const md5=value=>createHash('md5').update(value).digest('hex');text=text.replaceAll('-'+md5(before)+'.','-'+md5(after)+'.');}
    await writeFile(join(destination,'atelier_editor',file.path),text);
  }
  builds.executionUser(job);builds.verifyToolchain(job);verifyProjectFiles(runtime,job.runtime_sources);
  // Both desktop and mobile textures are included in the common Web preset.
  let config=readFileSync(join(destination,'project.godot'),'utf8');
  config=config.replace(/^textures\/vram_compression\/import_(?:etc2_astc|s3tc_bptc)=.*$/mg,'');
  config=config.replace(/^\[rendering\]\s*$/m,'[rendering]\ntextures/vram_compression/import_etc2_astc=true\ntextures/vram_compression/import_s3tc_bptc=true');
  await writeFile(join(destination,'project.godot'),config);
  await writeFile(join(destination,'export_presets.cfg'),builds.presets(job));
  const receipt=Buffer.from(JSON.stringify({source_identity:fixed.manifest.source_identity,source_files:fixed.manifest.source_files,receipt:result.receipt,policy:result.config.policy},null,2)+'\n');
  await writeFile(join(base,'native-preview-receipt.json'),receipt);
  builds.update(job,{native_content_protocol:NATIVE_CONTENT_PROTOCOL,native_preview_receipt:{path:'native-preview-receipt.json',sha256:hash(receipt),size:receipt.length},native_source_identity:fixed.manifest.source_identity,
    source_files:Object.entries(scanNativeWorkspace(destination).files).map(([path,entry])=>({path,sha256:entry.hash,size:entry.size}))});
  return destination;
}
