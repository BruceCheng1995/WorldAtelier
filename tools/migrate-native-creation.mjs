import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,basename,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import net from 'node:net';
import {CreationStore} from '../services/creation/store.mjs';
import {NativeProjects} from '../services/creation/native-project.mjs';
import {convertLegacyManifest} from '../services/creation/native-migration/legacy-converter.mjs';
import {gameStorage} from '../services/creation/project-snapshot.mjs';
import {NATIVE_SCHEMA} from '../services/creation/native-source.mjs';
import {hash,fail} from '../services/creation/schema.mjs';
import {verifyCreationBackup} from './backup-creation.mjs';
import {DatabaseSync} from 'node:sqlite';

const listening=port=>new Promise((yes,no)=>{const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();yes(true);});socket.once('error',error=>error.code==='ECONNREFUSED'?yes(false):no(error));socket.once('timeout',()=>{socket.destroy();yes(true);});});
const idle=store=>{
  const runs=store.list('creator_run').filter(run=>['queued','starting','running','waiting_input','waiting_approval','reconciling','stopping','cancelling'].includes(run.status)||['pending','uncertain'].includes(run.cleanup_status));
  const builds=store.list('creator_build').filter(job=>['queued','running'].includes(job.status));
  if(runs.length||builds.length)fail(409,'迁移需要停止创作与构建任务',{runs:runs.map(run=>run.id),builds:builds.map(job=>job.id)});
};

/** Offline maintenance only. Every branch uses the same native transaction
 * coordinator as the web/Agent path. Existing rows and source revisions remain
 * immutable. After a partial failure, take a new complete backup before resuming;
 * the next run skips native branches without rewriting their migration record. */
export async function migrateNativeCreation(options){
  const root=realpathSync(options.root),data=realpathSync(options.data),backup=realpathSync(options.backup),out=join(realpathSync(dirname(resolve(options.out))),basename(options.out)),locks=[];
  const overlaps=(a,b)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
  if(overlaps(data,backup)||out===backup||out.startsWith(backup+sep))throw Error('迁移工作库和证据目录不能覆盖固定备份');
  const formal=data===realpathSync(resolve(root,'.local/model-preview/creation'));
  try{
    for(const path of [join(data,'.native-migration.lock'),...(formal?[resolve(root,'.local/workspace-48910.start.lock')]:[])]){
      const bytes=JSON.stringify({pid:process.pid,purpose:'native_migration',data,created_at:Date.now()});
      const fd=openSync(path,'wx',0o600);writeFileSync(fd,bytes);closeSync(fd);locks.push({path,bytes});
    }
    return await migrateUnlocked({...options,root,data,backup,out,formal});
  }finally{for(const lock of locks.reverse())if(existsSync(lock.path)&&readFileSync(lock.path,'utf8')===lock.bytes)unlinkSync(lock.path);}
}
async function migrateUnlocked({root,data,backup,out,formal,onProgress=()=>{}}){
  root=resolve(root);data=resolve(data);backup=resolve(backup);out=resolve(out);
  if(!existsSync(join(data,'creation.sqlite')))throw Error('创作数据库不存在');
  if(existsSync(out))throw Error('迁移证据目录必须是新目录');
  const checkOffline=async()=>{if(formal&&await listening(48910))throw Error('正式迁移前须受控关闭已确认的 48910 工作台服务');};
  await checkOffline();await verifyCreationBackup({from:backup});
  const fixed=new DatabaseSync(join(backup,'data/creation.sqlite'),{readOnly:true});
  let fixedRows,fixedEvents;try{fixedRows=fixed.prepare('SELECT kind,id,body FROM documents ORDER BY kind,id').all();fixedEvents=fixed.prepare('SELECT sequence,project_id,body FROM events ORDER BY sequence').all();}finally{fixed.close();}
  mkdirSync(out,{recursive:true,mode:0o700});
  const store=new CreationStore(join(data,'creation.sqlite'));
  const report={format:'world-atelier-native-migration-1',started_at:Date.now(),status:'running',data,backup,branches:[]};
  const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  let native;
  try{
    idle(store);
    const before=store.db.prepare('SELECT kind,id,body FROM documents ORDER BY kind,id').all();
    if(hash(before)!==hash(fixedRows)||hash(store.db.prepare('SELECT sequence,project_id,body FROM events ORDER BY sequence').all())!==hash(fixedEvents))throw Error('数据库与备份不一致；关闭服务后重新备份再迁移，以保留最新会话、权限和消息');
    const branches=store.list('creator_branch');
    // Validate all actors and all fixed heads before preparing the first scene.
    const actors=new Map();
    for(const branch of branches){
      const revision=store.get('creator_revision',branch.head);
      if(revision.manifest.schema===NATIVE_SCHEMA)continue;
      const project=store.get('creator_project',branch.project_id);
      const actor=Object.entries(project.members).filter(([,role])=>role==='owner').map(([uid])=>store.get('creator_user',uid)).find(user=>user&&!user.disabled_at);
      if(!actor)throw Error('项目没有可用拥有者：'+project.id);
      store.branchFor(actor,branch.project_id,branch.branch_id,true);actors.set(branch.id,store.publicUser(actor));
    }
    const originalRows=before.filter(row=>row.kind!=='creator_branch').map(row=>({kind:row.kind,id:row.id,sha256:hash(Buffer.from(row.body))}));
    writeFileSync(join(out,'retained-rows.json'),JSON.stringify(originalRows,null,2)+'\n',{mode:0o600});
    native=new NativeProjects({store,data,convertLegacy:({manifest,project_id,branch_id})=>convertLegacyManifest({
      manifest,projectName:gameStorage({store},project_id,branch_id).namespace,
      readLegacyRuntimeFile:path=>{
        if(!['fonts/CreatorUI.tres','fonts/NotoSansSC.ttf','fonts/OFL.txt'].includes(path))throw Error('未知旧字体依赖');
        return readFileSync(resolve(root,'runtimes/model-preview',path));
      },
      readAsset:(digest,extension)=>{
        if(!store.assetAllowed(project_id,digest,extension))throw Error('迁移资产无项目权限');
        return readFileSync(resolve(data,'assets',digest+'.'+extension));
      }
    })});
    for(const branch of branches){
      await checkOffline();idle(store);
      const beforeManifest=store.get('creator_revision',branch.head).manifest;
      if(beforeManifest.schema===NATIVE_SCHEMA){report.branches.push({id:branch.id,status:'already_native',revision:branch.head});save();continue;}
      onProgress({phase:'converting',project_id:branch.project_id,branch_id:branch.branch_id,resources:Object.keys(beforeManifest.resources).length});
      const result=await native.apply(actors.get(branch.id),branch.project_id,branch.branch_id,{transaction_id:'native-migration-'+hash(branch.head).slice(0,32),base_revision:branch.head,expected_head:branch.head,ops:[{type:'migrate_native'}]});
      native.archive.verify(result.branch.manifest.source_files);
      const record={id:branch.id,status:'migrated',from_revision:branch.head,to_revision:result.revision,source_identity:result.branch.manifest.source_identity,resources:Object.keys(result.branch.manifest.resources).length,source_files:Object.keys(result.branch.manifest.source_files).length,mapping:result.migration};
      report.branches.push(record);save();onProgress({phase:'committed',id:record.id,from_revision:record.from_revision,to_revision:record.to_revision,resources:record.resources,source_files:record.source_files});
    }
    for(const row of originalRows){const current=store.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(row.kind,row.id);if(!current||hash(Buffer.from(current.body))!==row.sha256)throw Error('迁移修改了既有记录：'+row.kind+'/'+row.id);}
    const retainedEvents=store.db.prepare('SELECT sequence,project_id,body FROM events WHERE sequence<=? ORDER BY sequence').all(fixedEvents.at(-1)?.sequence??0);if(hash(retainedEvents)!==hash(fixedEvents))throw Error('迁移修改了既有事件记录');
    report.retained_rows=originalRows.length;report.retained_source_revisions=before.filter(row=>row.kind==='creator_revision').length;
    report.retained_sessions=before.filter(row=>row.kind==='creator_session').length;
    report.status='completed';report.completed_at=Date.now();save();return report;
  }catch(error){report.status='failed';report.error=error.message;save();throw error;}
  finally{await native?.close();store.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args={};for(const value of process.argv.slice(2)){const match=/^--(data|backup|out)=(.+)$/.exec(value);if(!match||args[match[1]])throw Error('使用 --data=PATH --backup=PATH --out=NEW_DIRECTORY');args[match[1]]=match[2];}
  if(!args.data||!args.backup||!args.out)throw Error('使用 --data=PATH --backup=PATH --out=NEW_DIRECTORY');
  migrateNativeCreation({root:resolve(import.meta.dirname,'..'),...args,onProgress:record=>console.log(JSON.stringify(record))}).then(report=>console.log(JSON.stringify({ok:true,status:report.status,branches:report.branches.length,retained_source_revisions:report.retained_source_revisions,retained_sessions:report.retained_sessions}))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
