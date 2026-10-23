import {buildSync} from 'esbuild';
import {builtinModules} from 'node:module';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {hash} from './schema.mjs';

/** Identity of the actual portable assembler and its engine adapter. */
export function nativeOfflinePolicy(root){
  const base=realpathSync(root),entry='tools/native-workspace-cli.mjs',scan=buildSync({absWorkingDir:base,entryPoints:[entry],bundle:true,write:false,metafile:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'}),builtins=new Set(builtinModules.map(name=>name.replace(/^node:/,'')));
  for(const input of Object.values(scan.metafile.inputs))for(const dependency of input.imports)if(dependency.external&&!builtins.has(dependency.path.replace(/^node:/,'')))throw Error('Portable offline client has an unfixed dependency: '+dependency.path);
  const files=[...new Set([...Object.keys(scan.metafile.inputs),'tools/native-scene/adapter.gd'])].map(path=>{
    const full=realpathSync(resolve(base,path)),local=relative(base,full).split(sep).join('/');if(!full.startsWith(base+sep)||! /^(tools|services|packages)\/.+\.(mjs|js|gd)$/.test(local)||local.split('/').some(part=>part.startsWith('.')))throw Error('Offline policy source lies outside fixed code roots');const bytes=readFileSync(full);return {path:local,hash:hash(bytes),size:bytes.length};
  }).sort((a,b)=>a.path.localeCompare(b.path));
  const body={format:1,contract:'world-atelier-native-offline-canonical-1',entry,files};return{...body,sha256:hash(body)};
}
