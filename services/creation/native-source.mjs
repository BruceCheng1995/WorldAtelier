import {mkdirSync,readFileSync,writeFileSync,readdirSync,lstatSync,realpathSync,linkSync,unlinkSync} from 'node:fs';
import {resolve,dirname,join,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {clone,fail,hash,stable} from './schema.mjs';

export const NATIVE_SCHEMA='creation-native-1';
export const NATIVE_CATALOG='.atelier/catalog.json';
export const NATIVE_LIMITS=Object.freeze({files:20000,fileBytes:128*1024*1024,totalBytes:512*1024*1024});
const ignored=new Set(['.godot','.git','.DS_Store','node_modules']);
const sourceDotFiles=new Set(['.gitignore','.gitattributes','.gdignore','.editorconfig']);
const windowsReserved=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

// Repeating a four-character capture across large assets exhausts V8's RegExp
// stack. Validate the alphabet in one flat scan, with padding checked separately.
function validBase64(value){
  if(typeof value!=='string'||value.length%4!==0)return false;
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;
  return !/[^A-Za-z0-9+/]/.test(padding?value.slice(0,-padding):value);
}

/** Paths describe portable project source, never host filesystem locations. */
export function nativeSourcePath(value){
  if(typeof value!=='string'||!value||value.length>1024||value!==value.normalize('NFC')||value.includes('\\')||/[\x00-\x1f\x7f:?*<>|\"]/.test(value))fail(422,'原生工程文件路径无效');
  const parts=value.split('/');
  if(parts.some((part,i)=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||windowsReserved.test(part)||part.startsWith('.')&&!(i===0&&part==='.atelier')&&!(i===parts.length-1&&sourceDotFiles.has(part))))fail(422,'原生工程路径必须是项目内的可移植相对路径',{path:value});
  if(parts.some(part=>ignored.has(part)))fail(422,'导入缓存和运行目录不能成为游戏源稿',{path:value});
  return value;
}

export function nativeFileMap(value,{limits=NATIVE_LIMITS}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(422,'需要完整原生源文件清单');
  const files=Object.create(null),portable=new Set();let total=0;
  const entries=Object.entries(value).sort(([a],[b])=>a.localeCompare(b));
  if(entries.length>limits.files)fail(413,'原生工程文件数量超出范围');
  for(const [raw,item]of entries){
    const path=nativeSourcePath(raw),key=path.toLocaleLowerCase('en-US');
    if(portable.has(key))fail(422,'工程包含大小写冲突的文件路径',{path});portable.add(key);
    if(!item||Object.keys(item).some(k=>!['hash','size'].includes(k))||! /^[a-f0-9]{64}$/.test(item.hash)||!Number.isSafeInteger(item.size)||item.size<0||item.size>limits.fileBytes)fail(422,'原生源文件哈希或大小无效',{path});
    total+=item.size;if(total>limits.totalBytes)fail(413,'原生工程总大小超出范围');
    files[path]={hash:item.hash,size:item.size};
  }
  for(const path of Object.keys(files)){const parts=path.split('/');for(let i=1;i<parts.length;i++)if(portable.has(parts.slice(0,i).join('/').toLocaleLowerCase('en-US')))fail(422,'工程文件与目录路径冲突',{path});}
  return files;
}

export function nativeSourceIdentity(files){return hash({format:1,files:nativeFileMap(files)});}

/** Immutable file objects live next to the existing central database. Revision
 * references grant access; this archive deliberately exposes no public hash API. */
export class NativeSourceArchive{
  constructor(directory,{limits=NATIVE_LIMITS}={}){this.directory=resolve(directory);this.limits=limits;mkdirSync(this.directory,{recursive:true});}
  path(digest){if(! /^[a-f0-9]{64}$/.test(digest))fail(422,'原生源文件哈希无效');return join(this.directory,digest.slice(0,2),digest);}
  put(bytes){
    bytes=Buffer.from(bytes);if(bytes.length>this.limits.fileBytes)fail(413,'原生源文件过大');
    const entry={hash:hash(bytes),size:bytes.length},path=this.path(entry.hash);mkdirSync(dirname(path),{recursive:true});
    const temporary=path+'.'+randomUUID()+'.tmp';writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});
    try{try{linkSync(temporary,path);}catch(error){if(error.code!=='EEXIST')throw error;}this.read(entry);}finally{unlinkSync(temporary);}
    return entry;
  }
  read(entry){
    const path=this.path(entry.hash);let bytes;
    try{if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())fail(409,'原生源文件存储类型异常');bytes=readFileSync(path);}catch(error){if(error.status)throw error;fail(409,'原生源文件缺失',{hash:entry.hash});}
    if(bytes.length!==entry.size||hash(bytes)!==entry.hash)fail(409,'原生源文件字节校验失败',{hash:entry.hash});return bytes;
  }
  verify(files){const normalized=nativeFileMap(files,{limits:this.limits});for(const entry of Object.values(normalized))this.read(entry);return normalized;}
  materialize(files,directory){
    files=nativeFileMap(files,{limits:this.limits});mkdirSync(directory,{recursive:true});
    if(lstatSync(directory).isSymbolicLink()||readdirSync(directory).length)fail(409,'原生工程物化目标必须为空目录');
    const base=realpathSync(directory);
    for(const [path,entry]of Object.entries(files)){const destination=resolve(base,path);if(!destination.startsWith(base+sep))fail(422,'原生工程路径超出目标目录');mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,this.read(entry),{flag:'wx'});}
    return base;
  }
  capture(directory){
    if(lstatSync(directory).isSymbolicLink())fail(422,'原生工程不能是符号链接');
    const base=realpathSync(directory),files=Object.create(null);let total=0,count=0;
    const visit=(path,relative='')=>{
      for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        if(ignored.has(entry.name))continue;
        const local=relative?relative+'/'+entry.name:entry.name,actual=join(path,entry.name);
        nativeSourcePath(local);
        if(entry.isSymbolicLink())fail(422,'原生工程源文件不允许符号链接',{path:local});
        if(entry.isDirectory()){visit(actual,local);continue;}
        if(!entry.isFile())fail(422,'原生工程包含非普通源文件',{path:local});
        const size=lstatSync(actual).size;total+=size;count++;
        if(size>this.limits.fileBytes||total>this.limits.totalBytes||count>this.limits.files)fail(413,'原生工程超过源文件容量限制');
        files[local]=this.put(readFileSync(actual));
      }
    };
    visit(base);return nativeFileMap(files,{limits:this.limits});
  }
  applyFiles(files,ops){
    const result=Object.assign(Object.create(null),nativeFileMap(files,{limits:this.limits})),inverse=[];
    for(const op of ops){
      const path=nativeSourcePath(op.path),previous=result[path]??null;
      if(!Object.hasOwn(op,'expected_hash')||(previous?.hash??null)!==op.expected_hash)fail(409,'源文件已被修改，请保留输入并比较差异',{path,current_hash:previous?.hash??null});
      if(op.type==='put_source_file'){
        if(typeof op.text!=='string'&&typeof op.data_base64!=='string')fail(422,'源文件提交需要文本或字节');
        if(typeof op.text==='string'&&typeof op.data_base64==='string')fail(422,'源文件不能同时提交文本和字节');
        if(op.data_base64!==undefined&&!validBase64(op.data_base64))fail(422,'源文件字节编码无效');
        result[path]=this.put(op.text!==undefined?Buffer.from(op.text,'utf8'):Buffer.from(op.data_base64,'base64'));
      }else if(op.type==='delete_source_file'){
        if(!previous)fail(410,'源文件已删除',{path});delete result[path];
      }else if(op.type==='restore_source_file'){
        if(op.entry===null)delete result[path];else{this.read(op.entry);result[path]={hash:op.entry.hash,size:op.entry.size};}
      }else fail(422,'未知原生源文件操作');
      inverse.unshift({type:'restore_source_file',path,expected_hash:result[path]?.hash??null,entry:previous});
    }
    return {files:nativeFileMap(result,{limits:this.limits}),inverse};
  }
}

export function nativeFileChanges(before,after){
  const changes=[];for(const path of new Set([...Object.keys(before),...Object.keys(after)]))if(stable(before[path]??null)!==stable(after[path]??null))changes.push({path,before:before[path]??null,after:after[path]??null});return changes.sort((a,b)=>a.path.localeCompare(b.path));
}
