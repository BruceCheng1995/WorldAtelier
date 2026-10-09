import {clone,fail,hash,identifier,stable} from './schema.mjs';
import {NATIVE_SCHEMA,nativeFileChanges,nativeSourceIdentity,nativeSourcePath} from './native-source.mjs';

/** Godot work happens outside SQLite transactions. Only this coordinator may
 * publish its completed candidate, after fresh permission, lease and head checks. */
export class NativeTransactions{
  constructor({store,archive,prepare}){this.store=store;this.archive=archive;this.prepare=prepare;this.queues=new Map();this.closing=false;}
  guard(user,p,b,origin){
    const branch=this.store.branchFor(user,p,b,true);
    if(this.closing)fail(503,'原生编辑服务正在关闭');
    if(origin){const run=this.store.get('creator_run',origin.run_id);if(!run||run.status!=='running'||run.lease_generation!==origin.lease_generation||run.owner_user_id!==user.id||run.project_id!==p||run.branch_id!==b)fail(409,'Agent 运行已取消、失联或失去写入租约');}
    return branch;
  }
  enqueue(key,action){
    const previous=this.queues.get(key)??Promise.resolve();
    const promise=previous.catch(()=>{}).then(action);this.queues.set(key,promise);
    const cleanup=()=>{if(this.queues.get(key)===promise)this.queues.delete(key);};promise.then(cleanup,cleanup);return promise;
  }
  apply(user,p,b,input,origin=null){
    this.guard(user,p,b,origin);const request=clone(input);
    return this.enqueue(`${p}:${b}`,()=>this.applyOnce(user,p,b,request,origin));
  }
  async applyOnce(user,p,b,input,origin){
    const branch=this.guard(user,p,b,origin);identifier(input.transaction_id,'事务 ID');
    if(!Array.isArray(input.ops)||input.ops.length<1||input.ops.length>100)fail(400,'事务需包含 1–100 个操作');
    if(input.ops.some(op=>!op||typeof op.type!=='string'))fail(422,'原生事务操作格式无效');
    const receiptId=`${branch.id}:${input.transaction_id}`,fingerprint=hash({user_id:user.id,input,origin}),old=this.store.get('creator_receipt',receiptId);
    if(old){if(old.fingerprint!==fingerprint)fail(409,'同一个事务 ID 不能使用不同内容');return {...old.result,replayed:true};}
    const base=this.store.get('creator_revision',input.base_revision);
    if(!base||base.project_id!==p||!this.store.ancestor(base.id,branch.head))fail(409,'缺少此分支的有效源基线');
    if(input.expected_head!==undefined&&input.expected_head!==branch.head)fail(409,'源版本已变化，请重新读取');
    const before=this.store.get('creator_revision',branch.head).manifest;
    for(const op of input.ops)if(op.type.startsWith('restore_native_')||op.type==='restore_source_file'){
      const proof=this.store.get('creator_receipt',`${branch.id}:${op.inverse_transaction_id}`);
      if(!proof||proof.result.actor.id!==user.id||!proof.result.inverse.some(item=>stable(item)===stable(op)))fail(403,'恢复操作须使用本人已提交事务的原始逆操作');
    }
    const candidate=await this.prepare({user,project_id:p,branch_id:b,base:clone(base),head:branch.head,manifest:clone(before),input:clone(input),origin:clone(origin)});
    const manifest=candidate.manifest;
    if(manifest?.schema!==NATIVE_SCHEMA||manifest.source_identity!==nativeSourceIdentity(manifest.source_files)||manifest.index_source_identity!==manifest.source_identity)fail(500,'原生源稿与引擎索引身份不一致');
    this.archive.verify(manifest.source_files);
    if(!manifest.resources||manifest.resources[manifest.entry_scene_id]?.kind!=='scene')fail(422,'原生工程缺少入口场景');
    const changed=Object.keys({...before.resources,...manifest.resources}).filter(rid=>stable(before.resources[rid]??null)!==stable(manifest.resources[rid]??null));
    const fileChanges=nativeFileChanges(before.source_files??{},manifest.source_files);
    const inverse=(candidate.inverse??[]).map(op=>({...op,inverse_transaction_id:input.transaction_id}));
    return this.store.transaction(()=>{
      // All actor and authority checks repeat after asynchronous native work.
      const current=this.guard(user,p,b,origin);
      if(current.head!==branch.head)fail(409,'处理原生场景期间源版本已变化；候选未发布');
      const revision=this.store.writeRevision(p,[branch.head],manifest,user.id,origin);
      current.head=revision.id;for(const rid of changed)current.doc_sequences[rid]=(current.doc_sequences[rid]??0)+1;
      this.store.put('creator_branch',current);
      const result={transaction_id:input.transaction_id,revision:revision.id,actor:user,changed_resources:changed,changed_files:fileChanges.map(item=>item.path),inverse,branch:{...current,manifest},...(candidate.migration?{migration:candidate.migration}:{}),...(candidate.discarded_overrides?{discarded_overrides:candidate.discarded_overrides}:{})};
      this.store.put('creator_receipt',{id:receiptId,fingerprint,result});
      if(candidate.migration)this.store.put('creator_native_migration',{id:revision.id,project_id:p,branch_id:b,from_revision:branch.head,to_revision:revision.id,...candidate.migration});
      this.store.event(p,{type:'creation_committed',branch_id:b,revision:revision.id,transaction_id:input.transaction_id,actor:user,resource_ids:changed,source_files:result.changed_files});
      return result;
    });
  }
  source(user,p,b,input={}){
    const branch=this.store.branchFor(user,p,b),revision=input.revision??branch.head;
    const fixed=this.store.get('creator_revision',revision);
    if(!fixed||fixed.project_id!==p||!this.store.ancestor(revision,branch.head))fail(409,'请选择此分支可达的原生源版本');
    if(fixed.manifest.schema!==NATIVE_SCHEMA)fail(409,'此源版本尚未迁移为原生工程');
    // Public playable access does not grant raw script/source download.
    const project=this.store.projectFor(user,p);if(!['owner','editor','viewer'].includes(project.members[user.id]))fail(403,'原生源稿仅供项目协作者访问');
    if(input.path){
      const path=nativeSourcePath(input.path),entry=fixed.manifest.source_files[path];
      if(!entry)fail(404,'源文件不存在');const bytes=this.archive.read(entry);
      return {revision,source_identity:fixed.manifest.source_identity,path,...entry,data_base64:bytes.toString('base64')};
    }
    return {revision,source_identity:fixed.manifest.source_identity,files:clone(fixed.manifest.source_files)};
  }
  async close(){this.closing=true;await Promise.allSettled([...this.queues.values()]);}
}
