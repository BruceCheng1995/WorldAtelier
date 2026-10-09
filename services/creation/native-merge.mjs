import {clone,fail,hash,id,stable} from './schema.mjs';
import {NATIVE_SCHEMA,nativeFileMap,nativeFileChanges,nativeSourceIdentity} from './native-source.mjs';

function sourceFiles(manifest){
  if(manifest?.schema!==NATIVE_SCHEMA)fail(409,'原生文件合并需要共同的原生源版本，请先从同一个已迁移版本建立分支');
  const files=nativeFileMap(manifest.source_files);
  if(nativeSourceIdentity(files)!==manifest.source_identity)fail(409,'原生源版本的文件身份不一致');
  return files;
}

/** Three-way comparison uses only immutable file identities. Engine indexes,
 * resources, design and knowledge are rebuilt from the resulting source files. */
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

export class NativeMerges{
  constructor({store,native}){this.store=store;this.native=native;}
  preview(user,p,b,input){
    const target=this.native.transactions.guard(user,p,b,null),source=this.store.branchFor(user,p,input.source_branch_id);
    if(source.id===target.id)fail(400,'请选择另一条来源分支');
    const base=this.store.commonAncestor(source.head,target.head);if(!base)fail(409,'没有共同源版本');
    const [original,from,to]=[base,source.head,target.head].map(r=>sourceFiles(this.store.get('creator_revision',r)?.manifest));
    const changes=nativeMergeChanges(original,from,to);
    const preview={id:id('merge'),schema:NATIVE_SCHEMA,project_id:p,target_branch_id:b,source_branch_id:source.branch_id,base_revision:base,source_revision:source.head,target_revision:target.head,base_source_identity:nativeSourceIdentity(original),source_identity:nativeSourceIdentity(from),target_source_identity:nativeSourceIdentity(to),changes,conflicts:changes.filter(change=>change.conflict),created_by:user.id,created_at:Date.now()};
    this.store.put('creator_merge_preview',preview);return preview;
  }
  merge(user,p,b,input,origin=null){
    this.native.transactions.guard(user,p,b,origin);const request=clone(input),actor=clone(user),lease=clone(origin);
    return this.native.transactions.enqueue(`${p}:${b}`,()=>this.mergeOnce(actor,p,b,request,lease));
  }
  async mergeOnce(user,p,b,input,origin){
    const target=this.native.transactions.guard(user,p,b,origin),preview=this.store.get('creator_merge_preview',input.preview_id);
    if(!preview||preview.project_id!==p||preview.target_branch_id!==b||preview.schema!==NATIVE_SCHEMA)fail(404,'原生合并预览不存在');
    this.store.branchFor(user,p,preview.source_branch_id);
    const resolutions=input.resolutions??{};
    if(!resolutions||typeof resolutions!=='object'||Array.isArray(resolutions))fail(422,'合并冲突决议格式无效');
    const receiptId=`merge:${p}:${b}:${preview.id}`,fingerprint=hash({user_id:user.id,resolutions,...(origin?{origin}:{})});
    const replay=()=>{const receipt=this.store.get('creator_receipt',receiptId);if(!receipt)return null;if(receipt.fingerprint!==fingerprint)fail(409,'相同合并 ID 不能使用不同冲突决议');return{...receipt.result,replayed:true};};
    const old=replay();if(old)return old;
    const guardHeads=()=>{
      const current=this.native.transactions.guard(user,p,b,origin),source=this.store.branchFor(user,p,preview.source_branch_id);
      if(current.head!==preview.target_revision||source.head!==preview.source_revision)fail(409,'预览后分支已变化，请重新比较');
      return current;
    };
    guardHeads();
    const [base,from,before]=[preview.base_revision,preview.source_revision,preview.target_revision].map(r=>this.store.get('creator_revision',r)?.manifest);
    const [original,source,to]=[base,from,before].map(sourceFiles),changes=nativeMergeChanges(original,source,to);
    // Recompute the preview from fixed revisions; persisted derived indexes and
    // caller-provided file values are never a source authority.
    if(stable(changes)!==stable(preview.changes))fail(409,'合并预览与固定源版本不一致');
    const files=Object.assign(Object.create(null),to);
    for(const change of changes){
      const choice=change.conflict?resolutions[change.key]:'source';
      if(!['source','target'].includes(choice))fail(409,'请逐项解决合并冲突',{key:change.key,path:change.path});
      const value=change[choice];if(value===null)delete files[change.path];else files[change.path]=clone(value);
    }
    const merged=nativeFileMap(files),source_identity=nativeSourceIdentity(merged);
    const manifest=await this.native.inspectFiles(merged);
    if(manifest?.schema!==NATIVE_SCHEMA||manifest.source_identity!==source_identity||manifest.index_source_identity!==source_identity||nativeSourceIdentity(manifest.source_files)!==source_identity)fail(500,'合并后的原生文件与引擎索引身份不一致');
    this.native.archive.verify(manifest.source_files);
    if(manifest.resources?.[manifest.entry_scene_id]?.kind!=='scene')fail(422,'合并不能删除入口场景');
    const changed=Object.keys({...before.resources,...manifest.resources}).filter(rid=>stable(before.resources[rid]??null)!==stable(manifest.resources[rid]??null));
    const fileChanges=nativeFileChanges(to,manifest.source_files);
    return this.store.transaction(()=>{
      // Inspecting a Godot project is asynchronous. Repeat actor authority,
      // run lease, both branch heads and receipt checks in the commit boundary.
      const current=guardHeads(),existing=replay();if(existing)return existing;
      const revision=this.store.writeRevision(p,[target.head,preview.source_revision],manifest,user.id,{...(origin??{}),merge_preview_id:preview.id});
      current.head=revision.id;current.doc_sequences??={};for(const rid of changed)current.doc_sequences[rid]=(current.doc_sequences[rid]??0)+1;
      this.store.put('creator_branch',current);
      const result={transaction_id:preview.id,revision:revision.id,actor:user,changed_resources:changed,changed_files:fileChanges.map(change=>change.path),inverse:[],branch:{...current,manifest}};
      this.store.put('creator_receipt',{id:receiptId,fingerprint,result});
      this.store.event(p,{type:'creation_merged',branch_id:b,source_branch_id:preview.source_branch_id,revision:revision.id,actor:user,resource_ids:changed,source_files:result.changed_files});
      return result;
    });
  }
}
