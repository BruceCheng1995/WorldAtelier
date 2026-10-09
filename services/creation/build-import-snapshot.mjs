import {constants,cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {hash} from './schema.mjs';

export const IMPORT_SNAPSHOT_POLICY='world-atelier-build-import-snapshot-v1';

function regularFile(directory,path){
  const root=realpathSync(directory),parts=path.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||part.includes('\\'))||resolve(root,path)===root)throw Error('导入快照路径无效');
  let file=root;
  for(const part of parts){file=join(file,part);if(lstatSync(file).isSymbolicLink())throw Error('导入快照包含符号链接');}
  if(!file.startsWith(root+sep)||!lstatSync(file).isFile())throw Error('导入快照包含非普通文件');
  return file;
}

export function verifyImportedFiles(directory,files,{exact=false}={}){
  if(exact){
    const expected=new Set(files.map(file=>file.path));
    const visit=(path='')=>{
      for(const entry of readdirSync(join(directory,path),{withFileTypes:true})){
        const local=path?path+'/'+entry.name:entry.name;
        if(entry.isSymbolicLink())throw Error('导入快照包含符号链接');
        if(entry.isDirectory())visit(local);
        else if(!entry.isFile()||!expected.has(local))throw Error('导入快照包含未固定文件，拒绝出包');
      }
    };visit();
  }
  for(const entry of files){
    const bytes=readFileSync(regularFile(directory,entry.path));
    if(bytes.length!==entry.size||hash(bytes)!==entry.sha256)throw Error('导入快照字节已变化，拒绝出包');
  }
}

/** Capture BEFORE any runtime check. Only this job's exact fixed sources and
 * its successful importer output are eligible; never use a checkout cache or
 * copy files created by a running game. Copies have independent file inodes.
 * Preserve mtimes so Godot's export-time scan can reuse imported resources.
 */
export function snapshotImportedProject({source,destination,sourceFiles}){
  const cache=join(source,'.godot');
  if(!existsSync(cache))return null;
  const cachedFiles=[];
  const visit=path=>{
    const file=join(source,path),stat=lstatSync(file);
    if(stat.isSymbolicLink())throw Error('导入缓存包含符号链接');
    if(stat.isDirectory())for(const entry of readdirSync(file).sort())visit(path+'/'+entry);
    else if(stat.isFile()){const bytes=readFileSync(file);cachedFiles.push({path,size:bytes.length,sha256:hash(bytes)});}
    else throw Error('导入缓存包含非普通文件');
  };
  visit('.godot');
  if(!cachedFiles.length)return null;
  if(existsSync(destination))throw Error('导入快照目标必须为新目录');
  const files=[...sourceFiles,...cachedFiles];
  verifyImportedFiles(source,files);
  mkdirSync(destination,{recursive:true});
  for(const entry of files){
    const target=join(destination,entry.path);mkdirSync(dirname(target),{recursive:true});
    cpSync(regularFile(source,entry.path),target,{preserveTimestamps:true,mode:constants.COPYFILE_FICLONE});
  }
  verifyImportedFiles(destination,files,{exact:true});
  return {directory:destination,files,policy:IMPORT_SNAPSHOT_POLICY,cache_files:cachedFiles.length,cache_bytes:cachedFiles.reduce((sum,file)=>sum+file.size,0)};
}
