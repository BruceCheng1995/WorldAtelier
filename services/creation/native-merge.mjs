import {clone,fail,hash,id,stable} from './schema.mjs';
import {NATIVE_SCHEMA,nativeFileMap,nativeFileChanges,nativeSourceIdentity} from './native-source.mjs';
import {NATIVE_MERGE_ALGORITHM,mergeNativeFiles,nativeMergeBases} from './native-merge-engine.mjs';

function sourceFiles(manifest){
  if(manifest?.schema!==NATIVE_SCHEMA)fail(409,'原生文件合并需要共同的原生源版本，请先从同一个已迁移版本建立分支',{code:'native_merge_schema_mismatch'});
  const files=nativeFileMap(manifest.source_files);
  if(nativeSourceIdentity(files)!==manifest.source_identity)fail(409,'原生源版本的文件身份不一致');
  return files;
}

/** Compatibility summary. New plans resolve a changed file below this layer. */
export function nativeMergeChanges(base,source,target){
  [base,source,target]=[base,source,target].map(files=>nativeFileMap(files));
  const changes=[];
  for(const path of [...new Set([...Object.keys(base),...Object.keys(source),...Object.keys(target)])].sort()){
    const original=base[path]??null,from=source[path]??null,to=target[path]??null;
    if(stable(from)===stable(original))continue;
    changes.push({key:'file/'+path,path,base:original,source:from,target:to,conflict:stable(to)!==stable(original)&&stable(to)!==stable(from)});
  }
  return changes;
}

function resolutionsOf(input){const resolutions=input.resolutions??{};if(!resolutions||typeof resolutions!=='object'||Array.isArray(resolutions)||Object.keys(resolutions).length>20000)fail(422,'合并冲突决议格式无效');return resolutions;}
const fixedHash=plan=>hash({algorithm:plan.algorithm,kind:plan.kind,project_id:plan.project_id,target_branch_id:plan.target_branch_id,target_revision:plan.target_revision,sources:plan.sources,revert_revision:plan.revert_revision??null,external:plan.external??null});

export class NativeMerges{
  constructor({store,native}){this.store=store;this.native=native;}
  revision(p,revision){const row=this.store.get('creator_revision',revision);if(!row||row.project_id!==p)fail(409,'合并固定源版本不存在或不属于此项目');sourceFiles(row.manifest);return row;}
  guardPlan(user,p,b,plan,origin=null,{heads=true}={}){
    const target=this.native.transactions.guard(user,p,b,origin);
    if(!plan||plan.project_id!==p||plan.target_branch_id!==b||plan.schema!==NATIVE_SCHEMA)fail(404,'原生合并预览不存在');
    if(plan.algorithm!==NATIVE_MERGE_ALGORITHM||plan.plan_identity!==fixedHash(plan))fail(409,'合并算法或固定输入已变化，请重新比较',{code:'native_merge_plan_changed'});
    for(const source of plan.sources??[]){const current=this.store.branchFor(user,p,source.branch_id);if(heads&&current.head!==source.revision)fail(409,'预览后来源分支已变化，请重新比较',{code:'native_merge_stale_plan',branch_id:source.branch_id});}
    if(heads&&target.head!==plan.target_revision)fail(409,'预览后目标分支已变化，请重新比较',{code:'native_merge_stale_plan',branch_id:b});
    return target;
  }
  newPlan(user,p,b,fields){
    const target=this.native.transactions.guard(user,p,b,null);this.revision(p,target.head);
    const plan={id:id('merge'),schema:NATIVE_SCHEMA,algorithm:NATIVE_MERGE_ALGORITHM,project_id:p,target_branch_id:b,target_revision:target.head,created_by:user.id,created_at:Date.now(),sources:[],...fields};
    plan.plan_identity=fixedHash(plan);const computed=this.compute(plan,{});Object.assign(plan,this.summary(computed));this.store.put('creator_merge_preview',plan);return clone(plan);
  }
  preview(user,p,b,input={}){
    const target=this.native.transactions.guard(user,p,b,null);
    if(input.expected_head!==undefined&&input.expected_head!==target.head)fail(409,'目标分支已变化，请重新比较');
    const selected=input.source_branch_ids??[input.source_branch_id];
    if(!Array.isArray(selected)||!selected.length||selected.length>16||selected.some(value=>typeof value!=='string'||!value)||new Set(selected).size!==selected.length)fail(422,'请选择 1–16 条不同的来源分支');
    const sources=selected.map(branchId=>{const branch=this.store.branchFor(user,p,branchId);if(branch.id===target.id)fail(400,'来源分支不能包含目标分支');this.revision(p,branch.head);return{branch_id:branch.branch_id,revision:branch.head};});
    return this.newPlan(user,p,b,{kind:'branches',sources,...(sources.length===1?{source_branch_id:sources[0].branch_id,source_revision:sources[0].revision}:{})});
  }
  revertPreview(user,p,b,input={}){
    const target=this.native.transactions.guard(user,p,b,null),revision=this.revision(p,input.revision);
    if(!this.store.ancestor(revision.id,target.head)||!revision.parents?.length||!revision.origin?.native_merge&&!revision.origin?.merge_preview_id)fail(409,'请选择当前分支历史中的原生合并提交',{code:'native_merge_invalid_revert'});
    const original=this.store.get('creator_merge_preview',revision.origin.merge_preview_id);
    if(original&&(original.project_id!==p||original.target_branch_id!==b))fail(409,'不能撤回其他分支的合并');
    return this.newPlan(user,p,b,{kind:'revert',revert_revision:revision.id});
  }
  /** Offline callers provide only already-authorized, immutable source objects.
   * Their registered workspace permission is checked again around commit. */
  externalPreview(user,p,b,{base_revision,source_files,workspace_id,request_id}){
    const target=this.native.transactions.guard(user,p,b,null);this.revision(p,base_revision);
    if(!this.store.ancestor(base_revision,target.head))fail(409,'工作区基线不是当前分支祖先，请保留本地内容并显式选择导入',{code:'native_merge_unrelated_workspace'});
    const files=nativeFileMap(source_files);this.native.archive.verify(files);
    return this.newPlan(user,p,b,{kind:'workspace',external:{base_revision,source_files:files,source_identity:nativeSourceIdentity(files),workspace_id,request_id}});
  }
  compute(plan,resolutions={},options={}){
    const p=plan.project_id,target=this.revision(p,plan.target_revision),original=sourceFiles(target.manifest);let files=original;
    const steps=[],changes=[],conflicts=[],used=new Set(),statistics={files_considered:0,hash_fast_paths:0,text_merges:0,native_merges:0,binary_conflicts:0,bytes_read:0};
    const execute=(base,source,label,info)=>{
      const result=mergeNativeFiles({base,source,target:files,archive:this.native.archive,resolutions,prefix:label,onConflict:options.onConflict});
      steps.push({...info,target_source_identity:nativeSourceIdentity(files),result_source_identity:result.source_identity,conflict_keys:result.conflicts.map(item=>item.key)});files=result.files;
      changes.push(...result.changes.map(change=>({...change,step:label})));conflicts.push(...result.conflicts);for(const key of result.used_resolutions)used.add(key);for(const key of Object.keys(statistics))statistics[key]+=result.statistics[key];
    };
    if(plan.kind==='revert'){
      const revision=this.revision(p,plan.revert_revision);if(!this.store.ancestor(revision.id,target.id)||!revision.parents?.length)fail(409,'待撤回提交不在目标分支历史中');
      execute(sourceFiles(revision.manifest),sourceFiles(this.revision(p,revision.parents[0]).manifest),'revert/'+revision.id,{kind:'revert',base_revision:revision.id,source_revision:revision.parents[0]});
    }else if(plan.kind==='workspace'){
      if(!this.store.ancestor(plan.external.base_revision,target.id))fail(409,'工作区基线不再属于目标分支');
      if(nativeSourceIdentity(plan.external.source_files)!==plan.external.source_identity)fail(409,'工作区固定源身份不一致');
      execute(sourceFiles(this.revision(p,plan.external.base_revision).manifest),plan.external.source_files,'workspace/'+plan.external.workspace_id,{kind:'workspace',base_revision:plan.external.base_revision,source_identity:plan.external.source_identity});
    }else if(plan.kind==='branches'){
      const parents=[target.id];
      for(const source of plan.sources){
        const revision=this.revision(p,source.revision);
        if(parents.some(parent=>this.store.ancestor(revision.id,parent))){steps.push({...source,skipped:true,reason:'already_merged'});continue;}
        const bases=nativeMergeBases(this.store,[revision.id],parents);
        if(!bases.length)fail(409,'没有共同原生源版本，请使用明确的导入流程',{code:'native_merge_unrelated_history',source_branch_id:source.branch_id});
        if(bases.length!==1)fail(409,'交叉合并历史有多个最优基线，无法安全自动选择；请先形成明确的共同基线',{code:'native_merge_ambiguous_base',source_branch_id:source.branch_id,base_revisions:bases});
        execute(sourceFiles(this.revision(p,bases[0]).manifest),sourceFiles(revision.manifest),'branch/'+source.branch_id,{...source,base_revision:bases[0]});parents.push(revision.id);
      }
    }else fail(409,'未知原生合并计划');
    return {files,source_identity:nativeSourceIdentity(files),steps,changes,conflicts,unresolved:conflicts.filter(item=>!item.resolved),used_resolutions:[...used],unused_resolutions:Object.keys(resolutions).filter(key=>!used.has(key)),statistics};
  }
  summary(result){return {steps:result.steps,changes:result.changes,conflicts:result.conflicts,unresolved_count:result.unresolved.length,source_identity:result.source_identity,statistics:result.statistics,...(result.steps.length===1&&result.steps[0].base_revision?{base_revision:result.steps[0].base_revision}:{}),unused_resolutions:result.unused_resolutions};}
  review(user,p,b,input){
    const plan=this.store.get('creator_merge_preview',input.preview_id);this.guardPlan(user,p,b,plan);
    if(plan.kind==='workspace'&&plan.created_by!==user.id)fail(403,'工作区合并仅由工作区拥有者处理');
    return {...clone(plan),...this.summary(this.compute(plan,resolutionsOf(input)))};
  }
  merge(user,p,b,input,origin=null,options={}){
    this.native.transactions.guard(user,p,b,origin);const request=clone(input),actor=clone(user),lease=clone(origin);
    return this.native.transactions.enqueue(`${p}:${b}`,()=>this.mergeOnce(actor,p,b,request,lease,options));
  }
  async mergeOnce(user,p,b,input,origin,{guard=()=>{},onCommit=null,allowWorkspace=false}={}){
    const plan=this.store.get('creator_merge_preview',input.preview_id);this.guardPlan(user,p,b,plan,origin,{heads:false});guard();
    if(plan.kind==='workspace'&&!allowWorkspace)fail(403,'工作区合并必须通过已登记工作区提交');
    const resolutions=resolutionsOf(input),receiptId=`merge:${p}:${b}:${plan.id}`,fingerprint=hash({user_id:user.id,resolutions,...(origin?{origin}:{})});
    const replay=()=>{const receipt=this.store.get('creator_receipt',receiptId);if(!receipt)return null;if(receipt.fingerprint!==fingerprint)fail(409,'相同合并 ID 不能使用不同冲突决议');return{...receipt.result,replayed:true};};
    const prior=replay();if(prior)return prior;
    this.guardPlan(user,p,b,plan,origin);const result=this.compute(plan,resolutions);
    if(result.unresolved.length||result.unused_resolutions.length)fail(409,result.unresolved.length?'请先解决全部局部合并冲突':'部分决议不再适用于本次输入，请重新核对',{code:'native_merge_conflicts',preview:{...clone(plan),...this.summary(result)}});
    const before=this.revision(p,plan.target_revision).manifest;
    const mergedFiles=nativeFileMap(result.files),manifest=await this.native.inspectFiles(mergedFiles),source_identity=nativeSourceIdentity(mergedFiles);
    if(manifest?.schema!==NATIVE_SCHEMA||manifest.source_identity!==source_identity||manifest.index_source_identity!==source_identity||nativeSourceIdentity(manifest.source_files)!==source_identity)fail(500,'合并后的原生文件与引擎索引身份不一致');
    this.native.archive.verify(manifest.source_files);
    if(manifest.resources?.[manifest.entry_scene_id]?.kind!=='scene')fail(422,'合并不能删除入口场景');
    const lost=[];
    for(const [rid,document]of Object.entries(before.resources??{})){
      const after=new Set((manifest.resources[rid]?.native_nodes??[]).map(node=>node.key));
      for(const node of document.native_nodes??[])if((node.instance_ids??[]).length&&!after.has(node.key)){
        const properties=(node.properties??[]).filter(property=>property.stored_locally&&property.overridden&&!property.name.startsWith('metadata/')).map(property=>property.name);
        if(properties.length)lost.push({resource_id:rid,key:node.key,path:node.path,properties});
      }
    }
    if(lost.length)fail(409,'合并会移除目标分支上的实例覆盖，请先在来源中保留或明确处理这些实例',{code:'native_merge_override_loss',removed_overrides:lost});
    const changed=Object.keys({...before.resources,...manifest.resources}).filter(rid=>stable(before.resources[rid]??null)!==stable(manifest.resources[rid]??null)),fileChanges=nativeFileChanges(before.source_files,manifest.source_files);
    return this.store.transaction(()=>{
      const current=this.guardPlan(user,p,b,plan,origin);guard();const existing=replay();if(existing)return existing;
      const parents=plan.kind==='branches'?[plan.target_revision,...plan.sources.filter(source=>!this.store.ancestor(source.revision,plan.target_revision)).map(source=>source.revision)]:[plan.target_revision];
      const unchanged=!fileChanges.length&&parents.length===1;
      const revision=unchanged?this.revision(p,plan.target_revision):this.store.writeRevision(p,[...new Set(parents)],manifest,user.id,{...(origin??{}),native_merge:NATIVE_MERGE_ALGORITHM,merge_preview_id:plan.id,...(plan.kind==='revert'?{revert_of:plan.revert_revision}:{})});
      current.head=revision.id;current.doc_sequences??={};for(const rid of changed)current.doc_sequences[rid]=(current.doc_sequences[rid]??0)+1;
      if(!unchanged)this.store.put('creator_branch',current);
      const committed={transaction_id:plan.id,revision:revision.id,actor:user,changed_resources:changed,changed_files:fileChanges.map(change=>change.path),inverse:[],revert:unchanged?null:{revision:revision.id},unchanged,merge_plan_id:plan.id,merge_statistics:result.statistics,branch:{...current,manifest}};
      this.store.put('creator_receipt',{id:receiptId,fingerprint,result:committed});
      if(!unchanged)this.store.event(p,{type:'creation_merged',branch_id:b,source_branch_id:plan.source_branch_id,source_branch_ids:plan.sources.map(source=>source.branch_id),revision:revision.id,actor:user,resource_ids:changed,source_files:committed.changed_files,...(plan.kind==='revert'?{revert_of:plan.revert_revision}:{})});
      onCommit?.(committed);return committed;
    });
  }
}
