import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,renameSync,lstatSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {hash} from '../services/creation/schema.mjs';
import {NATIVE_SCHEMA,nativeSourceIdentity} from '../services/creation/native-source.mjs';
import {DEFAULT_CATALOG_FORMAT,DefaultProjectBundle} from '../services/creation/default-projects.mjs';

/** Explicit author-maintained export. Reading a server never copies its users,
 * sessions or database into the distributable. Every branch is pinned in the
 * same read-only SQLite snapshot. Existing output must be replaced explicitly. */
export function exportDefaultProjects({data,out,projectIds=null}){
  data=resolve(data);out=resolve(out);
  if(existsSync(out)&&readdirSync(out).length)throw Error('分发目录必须为空；请先导出到新目录，再审查替换');
  const db=new DatabaseSync(join(data,'creation.sqlite'),{readOnly:true});
  const get=db.prepare('SELECT body FROM documents WHERE kind=? AND id=?');
  const list=kind=>db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY id').all(kind).map(row=>JSON.parse(row.body));
  const objects={},projects=[];const partBytes=16*1024*1024;
  const put=bytes=>{
    const key=hash(bytes);if(objects[key])return key;
    const compressed=gzipSync(bytes,{level:9}),parts=[];
    for(let offset=0;offset<compressed.length;offset+=partBytes){
      const part=compressed.subarray(offset,offset+partBytes),digest=hash(part),path=join(out,'objects',digest.slice(0,2),digest+'.gzpart');
      mkdirSync(dirname(path),{recursive:true});if(!existsSync(path))writeFileSync(path,part,{flag:'wx'});
      parts.push({hash:digest,size:part.length});
    }
    objects[key]={size:bytes.length,parts};return key;
  };
  const cover=target=>{
    const image=target.presentation?.images?.find(image=>image.id===target.presentation.cover_id);
    if(!image)return null;
    if(!/^[a-f0-9]{64}$/.test(image.id))throw Error('封面身份无效');
    const bytes=readFileSync(join(data,'project-media',image.id));if(hash(bytes)!==image.id)throw Error('封面字节校验失败');
    return {hash:put(bytes),mime:image.mime};
  };
  try{
    db.exec('BEGIN');
    const selected=list('creator_project').filter(project=>!project.archived_at&&(!projectIds||projectIds.includes(project.id)));
    if(!selected.length||projectIds&&selected.length!==new Set(projectIds).size)throw Error('请选择存在且未归档的工程');
    const branches=list('creator_branch');
    for(const project of selected){
      const item={id:project.id,name:project.name,branches:[],cover:cover(project)};
      for(const branch of branches.filter(branch=>branch.project_id===project.id)){
        const revision=JSON.parse(get.get('creator_revision',branch.head)?.body??'null'),source=revision?.manifest;
        if(source?.schema!==NATIVE_SCHEMA||source.source_identity!==nativeSourceIdentity(source.source_files)||source.index_source_identity!==source.source_identity)throw Error('工程必须是完整原生源稿：'+project.name);
        for(const entry of Object.values(source.source_files)){
          if(objects[entry.hash])continue;
          const path=join(data,'native-source/objects',entry.hash.slice(0,2),entry.hash);
          if(lstatSync(path).isSymbolicLink())throw Error('原生源对象不能是符号链接');
          const bytes=readFileSync(path);if(bytes.length!==entry.size||hash(bytes)!==entry.hash)throw Error('原生源文件校验失败');put(bytes);
        }
        // Explicit allowlist: revision actors/origins/parents and store records
        // cannot accidentally enter the content package through object spread.
        const manifest=Object.fromEntries(['schema','source_files','source_identity','index_source_identity','entry_scene_id','resources','knowledge'].filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
        item.branches.push({id:branch.branch_id,name:branch.name,source_identity:manifest.source_identity,snapshot:put(Buffer.from(JSON.stringify(manifest))),cover:cover(branch)});
      }
      projects.push(item);
    }
    db.exec('COMMIT');
    const catalog={format:DEFAULT_CATALOG_FORMAT,version:hash({projects,objects}),projects,objects};
    mkdirSync(out,{recursive:true});writeFileSync(join(out,'catalog.json.tmp'),JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});renameSync(join(out,'catalog.json.tmp'),join(out,'catalog.json'));
    const bundle=new DefaultProjectBundle(out);
    for(const project of projects){bundle.cover(project.cover);for(const branch of project.branches){bundle.snapshot(branch);bundle.cover(branch.cover);}}
    return {directory:out,version:catalog.version,projects:projects.map(p=>({id:p.id,name:p.name,branches:p.branches.length})),objects:Object.keys(objects).length,compressed_bytes:Object.values(objects).reduce((n,entry)=>n+entry.parts.reduce((n,p)=>n+p.size,0),0)};
  }finally{db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=key=>args.find(arg=>arg.startsWith(`--${key}=`))?.slice(key.length+3);
  if(!value('data')||!value('out')||args.some(arg=>!/^--(data|out|projects)=/.test(arg)))throw Error('用法：node tools/export-default-projects.mjs --data=创作数据目录 --out=新的分发目录 [--projects=工程ID,工程ID]');
  console.log(JSON.stringify(exportDefaultProjects({data:value('data'),out:value('out'),projectIds:value('projects')?.split(',')}),null,2));
}
