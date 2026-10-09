import {buildSync} from 'esbuild';
import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {inspectGLB} from '../preview/glb.mjs';
import {fail} from './schema.mjs';

// Bundle lazily and keep it in memory. Refreshing source needs no extra build
// command, and only the authenticated entry point exposes the dependency code.
let cached;
export function adminPreviewBundle(root) {
  const entry=resolve(root,'apps/creation-workspace/admin-model-preview.js');
  const modified=statSync(entry).mtimeMs;
  if(cached?.entry!==entry||cached.modified!==modified){
    const result=buildSync({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'inline',logLevel:'silent'});
    cached={entry,modified,bytes:result.outputFiles[0].contents};
  }
  return cached.bytes;
}

export function adminModelBytes(creation,req,path) {
  creation.admin.auth(req);
  const match=/^\/admin-models\/([a-f0-9]{64})\.glb$/.exec(path);
  if(!match)fail(404,'模型预览地址不存在');
  const asset=creation.store.get('creator_asset',match[1]);
  if(!asset||asset.ext!=='glb')fail(404,'模型资产不存在');
  if(asset.quarantined_at)fail(403,'此模型已隔离，请先恢复资产再预览');
  let bytes;
  try{bytes=readFileSync(resolve(creation.assets.directory,asset.id+'.glb'));}
  catch(error){if(error.code==='ENOENT')fail(404,'模型文件不存在');throw error;}
  let inspected;
  try{inspected=inspectGLB(bytes);}catch{fail(409,'模型文件无效，无法预览');}
  if(inspected.hash!==asset.id)fail(409,'模型文件与资产哈希不一致，拒绝预览');
  return bytes;
}
