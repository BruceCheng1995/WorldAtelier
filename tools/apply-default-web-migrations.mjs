// Explicit local maintenance of exact, installed sample mains. Normal startup
// retains its no-upgrade policy. Clients cannot invoke this operation over HTTP.
import {DatabaseSync,backup} from 'node:sqlite';
import {writeFileSync,mkdirSync,realpathSync,unlinkSync,existsSync,chmodSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {DefaultProjectBundle,DEFAULT_PROJECT_FORMAT} from '../services/creation/default-projects.mjs';
import {NATIVE_SCHEMA,nativeSourceIdentity,NativeSourceArchive} from '../services/creation/native-source.mjs';
import {hash} from '../services/creation/schema.mjs';
import {CreationStore} from '../services/creation/store.mjs';

const root=resolve(import.meta.dirname,'..');
function definitionHash(resource){
  // Strip only engine-generated top-level/node/property versions. Properties
  // named "version" inside user-authored dictionaries must remain significant.
  const {version,project_source_identity,native_nodes,...definition}=resource;
  return hash({...definition,native_nodes:native_nodes.map(({version,properties,...node})=>({...node,
    properties:properties.map(({version,...property})=>property)}))});
}
function candidate(db,bundle,id,previousBundle){
  const read=db.prepare('SELECT body FROM documents WHERE kind=? AND id=?');
  const get=(kind,key)=>JSON.parse(read.get(kind,key)?.body??'null');
  const project=get('creator_project',id),branch=get('creator_branch',id+':main');
  if(!branch||!project||project.archived_at||project.default_project?.format!==DEFAULT_PROJECT_FORMAT)throw Error('工程未登记为可用的默认工程 '+id);
  const item=bundle.catalog.projects.find(p=>p.id===id),entry=item?.branches.find(b=>b.id==='main');
  if(!entry)throw Error('分发包没有对应主干 '+id);
  const before=get('creator_revision',branch.head)?.manifest,next=bundle.snapshot(entry);
  if(before?.schema!==NATIVE_SCHEMA||before.source_identity!==nativeSourceIdentity(before.source_files)||before.index_source_identity!==before.source_identity||
     !next.source_files['web/main.js'])throw Error('主干缺少有效的固定源稿或 Web 入口 '+id);
  const additions=Object.keys(next.source_files).filter(path=>!Object.hasOwn(before.source_files,path));
  const replacements=Object.keys(before.source_files).filter(path=>next.source_files[path]&&before.source_files[path].hash!==next.source_files[path].hash);
  if(additions.concat(replacements).some(path=>!path.startsWith('web/'))||Object.keys(before.source_files).some(path=>!next.source_files[path]))throw Error('已有文件不同，须在实际分支上单独迁移 '+project.name);
  if(replacements.length){
    const previous=previousBundle?.catalog.projects.find(p=>p.id===id)?.branches.find(b=>b.id==='main');
    if(previous?.source_identity!==before.source_identity||previousBundle.snapshot(previous).source_identity!==before.source_identity)
      throw Error('更新已有 Web 文件需要与当前主干完全一致的上一份固定分发包 '+project.name);
  }
  const ids=Object.keys(before.resources);
  if(before.entry_scene_id!==next.entry_scene_id||ids.length!==Object.keys(next.resources).length||
    hash(before.knowledge??[])!==hash(next.knowledge??[])||ids.some(rid=>!next.resources[rid]||definitionHash(before.resources[rid])!==definitionHash(next.resources[rid]))){
    throw Error('已有资源、属性或知识与分发版本不同 '+project.name);
  }
  return {manifest:next,plan:{project:id,name:project.name,head:branch.head,source_identity:before.source_identity,target:next.source_identity,additions,replacements}};
}
async function listening(){
  return new Promise((done,reject)=>{const socket=net.connect({host:'127.0.0.1',port:48910});socket.setTimeout(2000);
    socket.once('connect',()=>{socket.destroy();done(true);});socket.once('error',e=>e.code==='ECONNREFUSED'?done(false):reject(e));
    socket.once('timeout',()=>{socket.destroy();done(true);});});
}
function assertIdle(db){
  const jobs=db.prepare("SELECT kind,id FROM documents WHERE (kind='creator_build' AND json_extract(body,'$.status') IN ('queued','running')) OR (kind='creator_run' AND (json_extract(body,'$.status') IN ('queued','starting','running','waiting_input','waiting_approval','reconciling','stopping','cancelling') OR json_extract(body,'$.cleanup_status') IN ('pending','uncertain'))) LIMIT 1").get();
  if(jobs)throw Error('迁移需要等待现有任务结束 '+jobs.id);
}
export async function applyDefaultWebMigrations({data,projects,applyPlan,evidence,bundleDirectory=resolve(root,'content/default-projects'),previousBundleDirectory=null,awaitOffline=false}){
  data=realpathSync(data);
  if(!projects?.length||new Set(projects).size!==projects.length)throw Error('请明确指定不重复的默认工程 ID');
  const bundle=new DefaultProjectBundle(bundleDirectory),database=join(data,'creation.sqlite'),inspect=db=>projects.map(id=>candidate(db,bundle,id,previousBundle).plan);
  const previousBundle=previousBundleDirectory?new DefaultProjectBundle(previousBundleDirectory):null;
  const reader=new DatabaseSync(database,{readOnly:true});
  let plan,planHash;
  try{plan=inspect(reader);planHash=hash({bundle:bundle.catalog.version,plan});}finally{reader.close();}
  if(!applyPlan)return {bundle_version:bundle.catalog.version,planHash,plan};
  if(planHash!==applyPlan||!evidence)throw Error('需要与当前主干完全匹配的计划哈希及新的备份目录');
  const out=resolve(evidence),lock=join(data,'.native-migration.lock'),product=resolve(root,'.local/model-preview/creation');
  if(out===data||out.startsWith(data+sep)||existsSync(out))throw Error('备份目录必须是工作库以外的新目录');
  mkdirSync(dirname(out),{recursive:true});mkdirSync(out,{mode:0o700});
  writeFileSync(lock,JSON.stringify({pid:process.pid,purpose:'default_web_migration',planHash}),{flag:'wx',mode:0o600});
  let store;
  try{
    if(existsSync(product)&&data===realpathSync(product)){
      const deadline=Date.now()+(awaitOffline?90000:0);
      while(await listening()){if(Date.now()>=deadline)throw Error('请受控关闭正式 48910 服务后再提交');await new Promise(done=>setTimeout(done,500));}
    }
    const source=new DatabaseSync(database,{readOnly:true});
    try{assertIdle(source);if(hash({bundle:bundle.catalog.version,plan:inspect(source)})!==planHash)throw Error('主干在准备期间发生变化');
      // Only the database changes. Previously referenced immutable blobs remain
      // in place. Verify every referenced source byte before committing.
      await backup(source,join(out,'creation-before.sqlite'));chmodSync(join(out,'creation-before.sqlite'),0o600);
    }finally{source.close();}
    const saved=new DatabaseSync(join(out,'creation-before.sqlite'),{readOnly:true});
    try{if(hash({bundle:bundle.catalog.version,plan:inspect(saved)})!==planHash)throw Error('固定备份与主干不匹配');}finally{saved.close();}
    const archive=new NativeSourceArchive(join(data,'native-source','objects'));
    for(const item of plan){
      const {manifest}=candidateReadonly(database,bundle,item.project,previousBundle);
      for(const path of [...item.additions,...item.replacements]){const file=manifest.source_files[path],entry=archive.put(bundle.readObject(file.hash));if(entry.hash!==file.hash||entry.size!==file.size)throw Error('新增文件校验失败');}
      archive.verify(manifest.source_files);
    }
    store=new CreationStore(database);
    const results=store.transaction(()=>{
      assertIdle(store.db);
      return plan.map(item=>{
        const {manifest,plan:current}=candidate(store.db,bundle,item.project,previousBundle);
        if(hash(current)!==hash(item))throw Error('迁移目标已变化，批次已取消');
        if(!item.additions.length&&!item.replacements.length)return {...item,revision:item.head,reused:true};
        const branch=store.get('creator_branch',item.project+':main');
        const origin={kind:'default_web_migration',bundle_version:bundle.catalog.version,base_revision:item.head,added_files:item.additions,updated_files:item.replacements};
        // A maintainer-installed version has the same system provenance as
        // default installation. Never impersonate an owner or grant membership.
        const revision=store.writeRevision(item.project,[item.head],manifest,null,origin);
        branch.head=revision.id;
        for(const rid of Object.keys(manifest.resources))branch.doc_sequences[rid]=(branch.doc_sequences[rid]??0)+1;
        store.put('creator_branch',branch);
        store.event(item.project,{type:'default_web_migrated',branch_id:'main',revision:revision.id,...origin});
        return {...item,revision:revision.id};
      });
    });
    const receipt={planHash,bundle_version:bundle.catalog.version,results};writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
    return receipt;
  }finally{store?.close();unlinkSync(lock);}
}
function candidateReadonly(database,bundle,id,previousBundle){
  const db=new DatabaseSync(database,{readOnly:true});
  try{return candidate(db,bundle,id,previousBundle);}finally{db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=Object.fromEntries(process.argv.slice(2).map(v=>{const m=/^--(data|projects|apply-plan|evidence|await-offline|previous-bundle)=(.+)$/.exec(v);if(!m)throw Error('未知参数');return [m[1],m[2]];}));
  if(!args.data||!args.projects)throw Error('用法：--data=创作库 --projects=默认工程ID列表 [--apply-plan=计划哈希 --evidence=新备份目录]');
  applyDefaultWebMigrations({data:args.data,projects:args.projects.split(','),applyPlan:args['apply-plan'],evidence:args.evidence,previousBundleDirectory:args['previous-bundle'],awaitOffline:args['await-offline']==='1'}).then(result=>console.log(JSON.stringify(result,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
