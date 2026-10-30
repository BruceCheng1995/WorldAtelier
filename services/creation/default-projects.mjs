import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {hash,identifier,fail} from './schema.mjs';
import {NATIVE_SCHEMA,nativeFileMap,nativeSourceIdentity} from './native-source.mjs';
import {emptyPresentation,inspectImage} from './project-media.mjs';

export const DEFAULT_PROJECT_FORMAT='world-atelier-default-project-1';
export const DEFAULT_CATALOG_FORMAT='world-atelier-default-projects-1';
const MAX_OBJECT_BYTES=256*1024*1024,MAX_PART_BYTES=16*1024*1024;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** A transport of fixed native source bytes and their engine-derived index.
 * No accounts, sessions, execution history, saves or exported runtimes belong
 * here. After installation the normal central source archive owns the files. */
export class DefaultProjectBundle {
  constructor(directory){
    this.directory=realpathSync(directory);
    this.catalog=JSON.parse(this.readFile('catalog.json').toString('utf8'));
    const c=this.catalog;
    if(c.format!==DEFAULT_CATALOG_FORMAT||!Array.isArray(c.projects)||!c.projects.length||c.projects.length>100||!c.objects||Array.isArray(c.objects)||c.version!==hash({projects:c.projects,objects:c.objects}))fail(422,'默认工程目录无效或校验失败');
    const ids=new Set();
    for(const project of c.projects){
      identifier(project.id,'默认工程 ID');
      if(ids.has(project.id)||typeof project.name!=='string'||!project.name.trim()||project.name.length>160||!Array.isArray(project.branches)||!project.branches.length||project.branches.length>100)fail(422,'默认工程条目无效');
      ids.add(project.id);const branches=new Set();
      for(const branch of project.branches){
        identifier(branch.id,'默认分支 ID');
        if(branches.has(branch.id)||typeof branch.name!=='string'||!branch.name.trim()||branch.name.length>160||!digest(branch.snapshot)||!digest(branch.source_identity))fail(422,'默认工程分支无效');
        branches.add(branch.id);
      }
      if(!branches.has('main'))fail(422,'默认工程缺少主干');
    }
  }
  readFile(path){
    const file=join(this.directory,path),actual=realpathSync(file);
    if(!actual.startsWith(this.directory+sep)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())fail(422,'默认工程文件必须位于分发目录内');
    return readFileSync(file);
  }
  readObject(key){
    const entry=this.catalog.objects[key];
    if(!digest(key)||!entry||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>MAX_OBJECT_BYTES||!Array.isArray(entry.parts)||!entry.parts.length||entry.parts.length>32)fail(422,'默认工程对象清单无效');
    const parts=entry.parts.map(part=>{
      if(!digest(part.hash)||!Number.isSafeInteger(part.size)||part.size<1||part.size>MAX_PART_BYTES)fail(422,'默认工程分片清单无效');
      const bytes=this.readFile(`objects/${part.hash.slice(0,2)}/${part.hash}.gzpart`);
      if(bytes.length!==part.size||hash(bytes)!==part.hash)fail(422,'默认工程分片校验失败');
      return bytes;
    });
    const bytes=gunzipSync(Buffer.concat(parts),{maxOutputLength:entry.size+1});
    if(bytes.length!==entry.size||hash(bytes)!==key)fail(422,'默认工程字节校验失败');
    return bytes;
  }
  snapshot(branch){
    const manifest=JSON.parse(this.readObject(branch.snapshot).toString('utf8'));
    if(Object.keys(manifest).some(key=>!['schema','source_files','source_identity','index_source_identity','entry_scene_id','resources','knowledge'].includes(key)))fail(422,'默认工程快照包含非源稿字段');
    const files=nativeFileMap(manifest.source_files),identity=nativeSourceIdentity(files);
    if(manifest.schema!==NATIVE_SCHEMA||manifest.source_identity!==identity||manifest.index_source_identity!==identity||branch.source_identity!==identity||!files['project.godot']||!files['.atelier/catalog.json']||manifest.resources?.[manifest.entry_scene_id]?.kind!=='scene')fail(422,'默认原生工程和查询索引不匹配');
    for(const [id,resource]of Object.entries(manifest.resources)){
      if(resource.id!==id||!['scene','prefab'].includes(resource.kind)||!files[resource.path]||resource.project_source_identity!==identity||!Array.isArray(resource.native_nodes))fail(422,'默认工程场景索引无效');
    }
    return manifest;
  }
  cover(reference){
    if(!reference)return null;
    const bytes=this.readObject(reference.hash),image=inspectImage({data_url:`data:${reference.mime};base64,${bytes.toString('base64')}`});
    return {...image,hash:reference.hash};
  }
}

/** Each complete project becomes visible in one SQLite transaction. Immutable
 * bytes may be staged beforehand; a failure never exposes a partial project.
 * Existing installations, edits, archives and access settings are never reset. */
export function installDefaultProjects({store,native,projectMedia,directory}){
  const bundle=new DefaultProjectBundle(directory),report={version:bundle.catalog.version,installed:[],adopted:[],existing:[],conflicts:[]};
  const sourceIdentity=store.db.prepare("SELECT json_extract(body,'$.manifest.source_identity') AS identity FROM documents WHERE kind='creator_revision' AND id=?");
  for(const item of bundle.catalog.projects){
    const existing=store.get('creator_project',item.id);
    if(existing?.default_project){report.existing.push(item.id);continue;}
    const metadata={format:DEFAULT_PROJECT_FORMAT,bundle_version:bundle.catalog.version,installed_at:Date.now()};
    if(existing){
      // The author's original workspace may already contain this exact project.
      // Recognize it without creating duplicate games or rewriting its history.
      const adopted=store.transaction(()=>{
        const current=store.get('creator_project',item.id),branches=store.list('creator_branch').filter(branch=>branch.project_id===item.id);
        if(!current||current.default_project||branches.length!==item.branches.length||!item.branches.every(branch=>sourceIdentity.get(branches.find(b=>b.branch_id===branch.id)?.head??'')?.identity===branch.source_identity))return false;
        store.put('creator_project',{...current,default_project:metadata});return true;
      });
      report[adopted?'adopted':'conflicts'].push(item.id);continue;
    }
    // Keep only one project's indices in memory; some real scenes have large
    // engine property projections even when their authored source is small.
    const prepared=[];
    for(const branch of item.branches){
      const manifest=bundle.snapshot(branch);
      for(const entry of Object.values(manifest.source_files)){
        const bytes=bundle.readObject(entry.hash);
        if(bytes.length!==entry.size)fail(422,'默认工程源文件大小不匹配');
        native.archive.put(bytes);
      }
      prepared.push({branch,manifest,cover:bundle.cover(branch.cover)});
    }
    const projectCover=bundle.cover(item.cover);
    const now=Date.now(),media=[];
    const presentation=cover=>{
      if(!cover)return {...emptyPresentation(),auto_update:false};
      const filename=resolve(projectMedia.directory,cover.hash);
      mkdirSync(projectMedia.directory,{recursive:true});
      if(existsSync(filename)){if(hash(readFileSync(filename))!==cover.hash)fail(409,'已有封面文件校验失败');}
      else writeFileSync(filename,cover.bytes,{flag:'wx'});
      const image={id:cover.hash,project_id:item.id,mime:cover.mime,width:cover.width,height:cover.height,name:'默认工程封面',created_at:now,url:`/creation-api/projects/${item.id}/media/${cover.hash}`};
      media.push({...image,id:`${item.id}:${cover.hash}`,image_id:cover.hash});
      return {...emptyPresentation(),version:1,cover_id:cover.hash,images:[image],auto_update:false};
    };
    const project={id:item.id,name:item.name,members:{},public_play:true,created_at:now,default_project:metadata,presentation:presentation(projectCover)};
    const branchPresentations=prepared.map(({cover})=>presentation(cover));
    store.transaction(()=>{
      if(store.get('creator_project',item.id))fail(409,'默认工程安装期间项目已存在');
      store.put('creator_project',project);
      for(const record of media)store.put('creator_project_media',record);
      for(const [index,{branch,manifest}]of prepared.entries()){
        const revision=store.writeRevision(item.id,[],manifest,null,{kind:'default_project',bundle_version:bundle.catalog.version});
        store.put('creator_branch',{id:`${item.id}:${branch.id}`,project_id:item.id,branch_id:branch.id,name:branch.name,head:revision.id,base_revision:revision.id,created_at:now,doc_sequences:Object.fromEntries(Object.keys(manifest.resources).map(id=>[id,1])),presentation:branchPresentations[index]});
      }
    });
    report.installed.push(item.id);
  }
  return report;
}
