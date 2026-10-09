import {extname} from 'node:path';
import {fail} from './schema.mjs';

const assets=new Set(['.bin','.tif','.tiff','.avif','.psd','.aseprite','.dae','.glb','.gltf','.png','.jpg','.jpeg','.webp','.gif','.bmp','.tga','.exr','.hdr','.ico','.ktx','.dds','.svg','.ttf','.otf','.woff','.woff2','.wav','.ogg','.mp3','.flac','.mp4','.webm','.blend','.fbx','.obj','.res','.scn','.pck','.zip','.wasm','.dll','.so','.dylib']);
export const agentAssetPath=path=>assets.has(extname(String(path)).toLowerCase());
export function agentText(bytes,path){
  if(agentAssetPath(path))return null;
  try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)?null:text;}catch{return null;}
}
export function assertAgentText(bytes,path){if(agentText(bytes,path)===null)fail(422,'工具内联内容只接受文本；资产请下载或生成到可编辑 Godot 工程，再用 submit_native_workspace 按文件路径提交',{path});}

const byteFields=new Set(['data_base64','base64','raw_bytes','binary_data','data_uri']);
const resourceKeys=['$type','class','path','uid','local_to_scene'];
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
const directory=r=>pick(r,['id','kind','name','path','version']);
/** Agent-only projection. Engine/storage snapshots remain complete and immutable. */
export function agentTextContext(value,key=''){
  if(value===null||value===undefined)return value;
  if(Buffer.isBuffer(value)||ArrayBuffer.isView(value))return {data_omitted:true,byte_length:value.byteLength};
  if(typeof value==='string')return /^data:[^,]*;base64,/i.test(value)?{data_omitted:true,reference_required:true}:value;
  if(typeof value!=='object')return value;
  if(Array.isArray(value)){
    if(value.length>64&&value.every(v=>typeof v==='number'))return {data_omitted:true,element_count:value.length,reference_required:true};
    return value.map(v=>agentTextContext(v,key));
  }
  if(value.$type==='Resource')return pick(value,resourceKeys);
  if(key==='native_node_snapshot')return pick(value,['node_id','instance_ids','path','type','version']);
  if(value.schema==='creation-native-1'&&value.resources)return {...pick(value,['schema','source_identity','index_source_identity','entry_scene_id','source_files']),resources:Object.fromEntries(Object.entries(value.resources).map(([id,r])=>[id,directory(r)]))};
  const out={};
  for(const[k,v]of Object.entries(value)){
    if(byteFields.has(k)){out.data_omitted=true;continue;}
    if((k==='value'||k==='inherited_value')&&/^Packed.*Array$/.test(value.type_name??'')&&Array.isArray(v)){out[k]={data_omitted:true,type:value.type_name,element_count:v.length,reference_required:true};continue;}
    out[k]=agentTextContext(v,k);
  }
  return out;
}

export function assertAgentSourceOperations(ops=[],{sourceFiles={},readOriginal}={}){
  for(const op of ops){
    if(op.type==='put_source_file'&&sourceFiles[op.path]&&readOriginal)assertAgentText(readOriginal(sourceFiles[op.path]),op.path);
    if(op.type==='put_source_file'){
      if(op.data_base64!==undefined||typeof op.text!=='string')fail(422,'禁止在工具参数中内联资产字节；请将文件写入可编辑 Godot 工程并用 submit_native_workspace 提交');
      assertAgentText(Buffer.from(op.text),op.path);
    }
    if(['import_native_project','migrate_native','restore_source_file'].includes(op.type))fail(422,'请通过 submit_native_workspace 导入原生工程文件；不要在工具参数中传入资产字节或自拟归档引用');
  }
}
