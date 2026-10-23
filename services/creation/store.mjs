import {flatPrefabInstanceName} from './instance-names.mjs';
import {normalizeDesign,normalizeKnowledge,applyKnowledgeOperation,validateDesignBindings,validateDesignRelations} from './semantic-design.mjs';
import { presentationOf } from './project-media.mjs';
import { HIERARCHY_SCHEMA, migrateFlatManifest } from './hierarchy.mjs';
import { applyHierarchyTransaction, hierarchyMergeEntries, mergeHierarchy, attachHierarchySource } from './hierarchy-store.mjs';
import {sourceAnnotationContext} from './annotation-context.mjs';
import {attachNativeSource} from './native-attachments.mjs';
import {NATIVE_SCHEMA,nativeSourceIdentity} from './native-source.mjs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Storage } from '../control-plane/storage.mjs';
import {RevisionReads} from './revision-reads.mjs';
import {COMPACT_EVENT_LIMIT,TOOL_EVENT_SQL,TOOL_EVENT_PATHS} from './session-event-view.mjs';
import {createAuthoringAction,actionResult} from './authoring-actions.mjs';
import { clone, fail, hash, id, identifier, name, object, resource, stable } from './schema.mjs';

export class CreationStore extends Storage {
  revisionReader(){return this.revisionReads??=new RevisionReads(this);}
  readRevision(id){return this.revisionReader().read(id);}
  revisionMeta(id){return this.revisionReader().meta(id);}
  revisionResourceSignature(id,resourceId){return this.revisionReader().resourceSignature(id,resourceId);}
  put(kind,item){const result=super.put(kind,item);if(kind==='creator_revision')this.revisionReads?.invalidate(item.id);return result;}
  remove(kind,id){const result=super.remove(kind,id);if(kind==='creator_revision')this.revisionReads?.invalidate(id);return result;}
  transaction(fn){try{return super.transaction(fn);}catch(error){this.revisionReads?.clear();throw error;}}
  isAdmin(user) {
    const uid=this.adminUserId??this.get('creator_admin_settings','singleton')?.owner_user_id;
    const current=user?.id&&this.get('creator_user',user.id);
    return Boolean(uid&&current&&!current.disabled_at&&current.id===uid);
  }
  roleFor(user,project) {
    const current=user?.id&&this.get('creator_user',user.id);
    if(!current||current.disabled_at||project?.archived_at)return null;
    return project?.members[user.id]||(this.publicPlay&&project&&project.public_play!==false?'player':null);
  }
  publicUser(user) {return {id:user.id,name:user.name,color:user.color};}
  accountName(value,exceptId=null) {
    if(typeof value!=='string')fail(400,'请输入账号名称');
    const label=name(value),login=label.normalize('NFKC').toLowerCase();
    if(/[\p{Cc}\p{Cf}]/u.test(label))fail(400,'账号名称不能包含控制或隐藏字符');
    if(this.list('creator_user').some(u=>u.id!==exceptId&&u.login===login))fail(409,'该账号名称已存在，请使用其他名称');
    return {name:label,login};
  }
  renameAccount(row,value) {
    Object.assign(row,this.accountName(value,row.id));
    row.admin_version=(row.admin_version??1)+1;
    this.put('creator_user',row);return row;
  }
  updateProfile(user,input) {
    if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['name','expected_name'].includes(k))||typeof input.expected_name!=='string')fail(400,'需要当前账号名称和新名称');
    return this.transaction(()=>{
      const row=this.get('creator_user',user.id);
      if(!row||row.disabled_at)fail(401,'请登录工作台');
      if(row.name!==input.expected_name)fail(409,'账号名称已更新，请重新打开改名窗口');
      return {user:this.publicUser(this.renameAccount(row,input.name))};
    });
  }
  register(input) {
    const {name:label,login:key}=this.accountName(input.name);
    if(typeof input.password!=='string'||input.password.length<8||input.password.length>200)fail(400,'密码须为 8–200 个字符');
    const salt=randomBytes(16).toString('hex');
    const user={id:id('user'),login:key,name:label,salt,password:scryptSync(input.password,salt,64).toString('hex'),color:['#75d7d0','#ebb665','#b59bed','#8cb4ee'][this.list('creator_user').length%4],created_at:Date.now()};
    this.put('creator_user',user);return this.issueLogin(user);
  }
  login(input) {
    const user=this.list('creator_user').find(u=>u.login===String(input.name??'').trim().normalize('NFKC').toLowerCase());
    const salt=user?.salt??'invalid-login-salt';
    const candidate=scryptSync(String(input.password??'').slice(0,200),salt,64);
    if(!user||!timingSafeEqual(candidate,Buffer.from(user.password,'hex')))fail(401,'名称或密码不正确');
    return this.issueLogin(user);
  }
  issueLogin(user) {
    if(user.disabled_at)fail(403,'账号已停用，请联系服务器管理员');
    const token=randomBytes(32).toString('base64url');
    user.last_login_at=Date.now();this.put('creator_user',user);
    this.put('creator_login',{id:hash(token),user_id:user.id,expires_at:Date.now()+7*86400000});
    return {token,user:this.publicUser(user)};
  }
  authenticate(token) {
    const login=token&&this.get('creator_login',hash(token));
    const user=login&&login.expires_at>Date.now()&&this.get('creator_user',login.user_id);
    if(!user||user.disabled_at)fail(401,'请登录工作台');return this.publicUser(user);
  }
  projectFor(user,projectId,write=false) {
    const project=this.get('creator_project',projectId),role=this.roleFor(user,project);
    if(!role||write&&!['owner','editor'].includes(role))fail(403,'没有此项目的'+(write?'编辑':'访问')+'权限');
    return project;
  }
  branchFor(user,projectId,branchId,write=false) {
    this.projectFor(user,projectId,write);
    const branch=this.get('creator_branch',`${projectId}:${branchId}`);
    if(!branch)fail(404,'分支不存在');return branch;
  }
  assetAllowed(projectId,assetHash,ext) {
    const asset=this.get('creator_asset',assetHash);
    return Boolean(asset&&!asset.quarantined_at&&asset.ext===ext&&(asset.builtin||asset.project_ids?.includes(projectId)));
  }
  canCreateProject(user) {
    const current=user?.id&&this.get('creator_user',user.id);
    if(!current||current.disabled_at)return false;
    if(this.isAdmin(current))return true;
    if(typeof current.creation_allowed==='boolean')return current.creation_allowed;
    if(!this.publicPlay)return true;
    const projects=this.list('creator_project');
    return projects.some(p=>p.members[user.id]==='owner'||!p.archived_at&&p.members[user.id]==='editor')||(!projects.length&&this.list('creator_user').sort((a,b)=>a.created_at-b.created_at)[0]?.id===user.id);
  }
  createProject(user,input,manifest) {
    if(!this.canCreateProject(user))fail(403,'当前账号可试玩游戏，可在现有游戏中申请编辑，由拥有者批准后创作');
    const projectId=id('game'),allowed=(h,e)=>this.assetAllowed(projectId,h,e);
    let normalized;
    if(manifest.schema===NATIVE_SCHEMA){
      if(manifest.source_identity!==nativeSourceIdentity(manifest.source_files)||manifest.index_source_identity!==manifest.source_identity||manifest.resources?.[manifest.entry_scene_id]?.kind!=='scene')fail(422,'初始原生工程与引擎索引不匹配');
      normalized=clone(manifest);
    }else normalized={...clone(manifest),schema:'creation-flat-1',...(manifest.knowledge!==undefined?{knowledge:normalizeKnowledge(manifest.knowledge)}:{}),entry_scene_id:manifest.entry_scene_id,resources:Object.fromEntries(Object.entries(manifest.resources).map(([k,v])=>[k,resource(v,allowed)]))};
    const project={id:projectId,name:name(input.name,'新的游戏'),members:{[user.id]:'owner'},created_at:Date.now()};
    return this.transaction(()=>{
      this.put('creator_project',project);
      const revision=this.writeRevision(projectId,[],normalized,user.id);
      this.put('creator_branch',{id:`${projectId}:main`,project_id:projectId,branch_id:'main',name:project.name,head:revision.id,base_revision:revision.id,created_at:Date.now(),doc_sequences:Object.fromEntries(Object.keys(normalized.resources).map(k=>[k,1]))});
      return {project:this.projectView(user,project),branch:this.branchView(user,projectId,'main')};
    });
  }
  projectView(user,project) {
    return {...clone(project),permission_version:project.permission_version??1,presentation:presentationOf(project.presentation),members:Object.entries(project.members).map(([uid,role])=>({...this.publicUser(this.get('creator_user',uid)),role})),role:this.roleFor(user,project)};
  }
  updateProject(user,projectId,input) {
    return this.transaction(()=>{
      const project=this.get('creator_project',projectId),current=user?.id&&this.get('creator_user',user.id);
      // Archived projects deliberately have no ordinary read/write role. Only their
      // existing owner can change this metadata or restore access.
      if(!current||current.disabled_at||project?.members[user.id]!=='owner')fail(403,'只有工程拥有者可以重命名、归档或恢复工程');
      if(!input||Object.keys(input).some(k=>!['expected_version','name','archived'].includes(k))||Object.hasOwn(input,'name')===Object.hasOwn(input,'archived'))fail(400,'请单独提交工程名称或归档状态');
      if(!Number.isSafeInteger(input.expected_version))fail(400,'需要工程资料版本');
      if(input.expected_version!==(project.permission_version??1))fail(409,'工程资料已更新，请刷新后重试');
      if(Object.hasOwn(input,'name')){if(typeof input.name!=='string'||!input.name.trim())fail(400,'请输入工程名称');project.name=name(input.name);}
      else {if(typeof input.archived!=='boolean')fail(400,'归档状态必须为布尔值');project.archived_at=input.archived?(project.archived_at??Date.now()):null;}
      project.permission_version=(project.permission_version??1)+1;
      this.put('creator_project',project);
      return {project:{id:project.id,name:project.name,archived_at:project.archived_at??null,permission_version:project.permission_version}};
    });
  }
  bootstrap(user) {
    const all=this.list('creator_project'),branches=this.list('creator_branch');
    return {user,can_admin:this.isAdmin(user),can_create_project:this.canCreateProject(user),archived_projects:all.filter(p=>p.archived_at&&p.members[user.id]==='owner').map(p=>({id:p.id,name:p.name,role:'owner',created_at:p.created_at,archived_at:p.archived_at,permission_version:p.permission_version??1,branch_count:branches.filter(b=>b.project_id===p.id).length})),projects:all.filter(p=>this.roleFor(user,p)).map(p=>({...this.projectView(user,p),branches:branches.filter(b=>b.project_id===p.id).map(b=>({...b,presentation:presentationOf(b.presentation),updated_at:this.revisionMeta(b.head)?.created_at??b.created_at}))}))};
  }
  writeRevision(projectId,parents,manifest,actorId,origin=null) {
    const revision={project_id:projectId,parents,manifest:clone(manifest),actor_id:actorId,origin,created_at:Date.now()};
    revision.id=`src-${hash(revision)}`;this.put('creator_revision',revision);return revision;
  }
  branchView(user,p,b) {
    const branch=this.branchFor(user,p,b);
    return {...branch,presentation:presentationOf(branch.presentation),manifest:this.get('creator_revision',branch.head).manifest};
  }
  ancestor(ancestor,head) {
    const pending=[head],seen=new Set();
    while(pending.length){const next=pending.pop();if(next===ancestor)return true;if(seen.has(next))continue;seen.add(next);pending.push(...(this.revisionMeta(next)?.parents??[]));}
    return false;
  }
  fork(user,p,input) {
    const source=this.branchFor(user,p,input.from_branch,true),branchId=identifier(input.branch_id,'分支 ID');
    if(this.get('creator_branch',`${p}:${branchId}`))fail(409,'分支 ID 已存在');
    if(input.expected_head&&source.head!==input.expected_head)fail(409,'来源分支已更新，请重新选择源版本');
    const branch={...source,id:`${p}:${branchId}`,branch_id:branchId,name:name(input.name,branchId),base_revision:source.head,parent_branch:source.branch_id,created_at:Date.now()};
    this.put('creator_branch',branch);return this.branchView(user,p,branchId);
  }
  commonAncestor(a,b) {
    const seen=new Set(),queue=[a];while(queue.length){const current=queue.shift();if(seen.has(current))continue;seen.add(current);queue.push(...(this.get('creator_revision',current)?.parents??[]));}
    const other=[b],visited=new Set();while(other.length){const current=other.shift();if(seen.has(current))return current;if(visited.has(current))continue;visited.add(current);other.push(...(this.get('creator_revision',current)?.parents??[]));}return null;
  }
  mergeEntries(manifest) {
    if(manifest.schema===HIERARCHY_SCHEMA)return hierarchyMergeEntries(manifest);
    const entries={'entry-scene':manifest.entry_scene_id};
    for(const [kid,entry]of Object.entries(manifest.knowledge??{}))entries[`knowledge/${kid}`]=clone(entry);
    for(const doc of Object.values(manifest.resources)){
      const metadata=clone(doc);delete metadata.objects;delete metadata.version;entries[`resource/${doc.id}`]=metadata;
      for(const object of doc.objects){const value=clone(object);delete value.version;entries[`object/${doc.id}/${object.id}`]=value;}
    }
    return entries;
  }
  mergePreview(user,p,b,input) {
    const target=this.branchFor(user,p,b,true),source=this.branchFor(user,p,input.source_branch_id);
    if(source.id===target.id)fail(400,'请选择另一条来源分支');
    const base=this.commonAncestor(source.head,target.head);if(!base)fail(409,'没有共同源版本');
    const manifests=[base,source.head,target.head].map(r=>this.get('creator_revision',r).manifest);
    // Both branch heads must opt in. An old common ancestor can be compared through the deterministic migration adapter.
    if(manifests[1].schema===HIERARCHY_SCHEMA&&manifests[2].schema===HIERARCHY_SCHEMA&&manifests[0].schema==='creation-flat-1')manifests[0]=migrateFlatManifest(manifests[0],(h,e)=>this.assetAllowed(p,h,e));
    if(manifests.some(m=>m.schema!==manifests[0].schema))fail(409,'合并双方需先显式迁移到同一文档协议');
    const [baseEntries,sourceEntries,targetEntries]=manifests.map(m=>this.mergeEntries(m));
    const changes=[],conflicts=[];
    for(const key of new Set([...Object.keys(baseEntries),...Object.keys(sourceEntries),...Object.keys(targetEntries)])){
      const original=baseEntries[key]??null,from=sourceEntries[key]??null,to=targetEntries[key]??null;
      if(stable(from)===stable(original))continue;
      const conflict=stable(to)!==stable(original)&&stable(to)!==stable(from);
      const entry={key,base:original,source:from,target:to,conflict};changes.push(entry);if(conflict)conflicts.push(entry);
    }
    const preview={id:id('merge'),project_id:p,target_branch_id:b,source_branch_id:source.branch_id,base_revision:base,source_revision:source.head,target_revision:target.head,changes,conflicts,created_by:user.id,created_at:Date.now()};
    this.put('creator_merge_preview',preview);return preview;
  }
  merge(user,p,b,input) {
    const current=this.branchFor(user,p,b,true);
    if(this.get('creator_revision',current.head).manifest.schema===HIERARCHY_SCHEMA)return mergeHierarchy(this,user,p,b,input);
    const target=this.branchFor(user,p,b,true),preview=this.get('creator_merge_preview',input.preview_id);
    if(!preview||preview.project_id!==p||preview.target_branch_id!==b)fail(404,'合并预览不存在');
    this.branchFor(user,p,preview.source_branch_id);
    const receiptId=`merge:${p}:${b}:${preview.id}`,fingerprint=hash({user_id:user.id,resolutions:input.resolutions??{}}),receipt=this.get('creator_receipt',receiptId);
    if(receipt){if(receipt.fingerprint!==fingerprint)fail(409,'相同合并 ID 不能使用不同冲突决议');return {...receipt.result,replayed:true};}
    if(target.head!==preview.target_revision||this.branchFor(user,p,preview.source_branch_id).head!==preview.source_revision)fail(409,'预览后分支已变化，请重新比较');
    const entries=this.mergeEntries(this.get('creator_revision',target.head).manifest),choices=input.resolutions??{};
    for(const change of preview.changes){
      const choice=change.conflict?choices[change.key]:'source';
      if(!['source','target'].includes(choice))fail(409,'请逐项解决合并冲突',{key:change.key});
      const value=change[choice];if(value===null)delete entries[change.key];else entries[change.key]=value;
    }
    const manifest={schema:'creation-flat-1',entry_scene_id:entries['entry-scene'],resources:{}};
    for(const [key,value]of Object.entries(entries))if(key.startsWith('resource/'))manifest.resources[value.id]={...value,objects:[]};
    for(const [key,value]of Object.entries(entries))if(key.startsWith('object/')){
      const rid=key.split('/')[1];if(!manifest.resources[rid])fail(409,'删除资源与保留内部对象冲突，请调整来源后重新比较',{resource_id:rid});manifest.resources[rid].objects.push(value);
    }
    for(const [key,value]of Object.entries(entries))if(key.startsWith('knowledge/')){manifest.knowledge??={};manifest.knowledge[key.slice(10)]=value;}
    if(manifest.resources[manifest.entry_scene_id]?.kind!=='scene')fail(422,'合并不能删除入口场景');
    const allowed=(h,e)=>this.assetAllowed(p,h,e);
    for(const [rid,doc]of Object.entries(manifest.resources))manifest.resources[rid]=resource(doc,allowed);
    for(const doc of Object.values(manifest.resources))validateDesignBindings(doc);validateDesignRelations(manifest);
    for(const doc of Object.values(manifest.resources))for(const o of doc.objects)if(o.prefab&&manifest.resources[o.prefab]?.kind!=='prefab')fail(422,'合并缺失预制件依赖');
    return this.transaction(()=>{
      const revision=this.writeRevision(p,[target.head,preview.source_revision],manifest,user.id,{merge_preview_id:preview.id});
      target.head=revision.id;for(const rid of new Set([...Object.keys(target.doc_sequences),...Object.keys(manifest.resources)]))target.doc_sequences[rid]=(target.doc_sequences[rid]??0)+1;
      this.put('creator_branch',target);this.event(p,{type:'creation_merged',branch_id:b,source_branch_id:preview.source_branch_id,revision:revision.id,actor:user});
      const result={transaction_id:preview.id,revision:revision.id,actor:user,changed_resources:Object.keys(target.doc_sequences),inverse:[],branch:{...target,manifest}};
      this.put('creator_receipt',{id:receiptId,fingerprint,result});return result;
    });
  }
  apply(user,p,b,input,origin=null) {
    const current=this.branchFor(user,p,b,true);
    if(this.get('creator_revision',current.head).manifest.schema===HIERARCHY_SCHEMA||input.ops?.some(o=>o.type==='migrate_hierarchy'))return applyHierarchyTransaction(this,user,p,b,input,origin);
    const branch=this.branchFor(user,p,b,true); // Permission check precedes receipt replay.
    if(origin){const run=this.get('creator_run',origin.run_id);if(!run||run.status!=='running'||run.lease_generation!==origin.lease_generation||run.owner_user_id!==user.id||run.project_id!==p||run.branch_id!==b)fail(409,'Agent 运行已取消、失联或失去写入租约');}
    identifier(input.transaction_id,'事务 ID');
    if(!Array.isArray(input.ops)||!input.ops.length||input.ops.length>100)fail(400,'事务需包含 1–100 个操作');
    const receiptId=`${branch.id}:${input.transaction_id}`,fingerprint=hash({user_id:user.id,input,origin});
    const old=this.get('creator_receipt',receiptId);
    if(old){if(old.fingerprint!==fingerprint)fail(409,'同一个事务 ID 不能使用不同内容');return {...old.result,replayed:true};}
    const base=this.get('creator_revision',input.base_revision);
    if(!base||base.project_id!==p||!this.ancestor(base.id,branch.head))fail(409,'缺少此分支的有效源基线');
    const manifest=clone(this.get('creator_revision',branch.head).manifest),changed=new Set(),inverse=[];
    const allowed=(h,e)=>this.assetAllowed(p,h,e);
    for(const op of input.ops) {
      if(['put_knowledge','delete_knowledge'].includes(op.type)){inverse.unshift(applyKnowledgeOperation(manifest,op));continue;}
      const rid=identifier(op.resource_id,'资源 ID'),doc=manifest.resources[rid];
      if(op.type==='create_resource') {
        if(doc)fail(409,'资源已存在',{resource_id:rid});
        manifest.resources[rid]=resource({...op.resource,id:rid},allowed);inverse.unshift({type:'delete_resource',resource_id:rid,expected_version:manifest.resources[rid].version});
      } else if(op.type==='delete_resource') {
        if(!doc||doc.version!==op.expected_version)fail(409,'资源已变化',{resource_id:rid,current:doc});
        if(manifest.entry_scene_id===rid)fail(422,'不能删除入口场景');
        delete manifest.resources[rid];inverse.unshift({type:'create_resource',resource_id:rid,resource:doc});
      } else if(op.type==='rename_resource'){
        if(!doc||doc.version!==op.expected_version)fail(409,'资源已变化，请刷新后重试',{resource_id:rid,current:doc});
        if(typeof op.name!=='string')fail(400,'名称须为 1–160 个字符');
        const previous=doc.name;doc.name=name(op.name);doc.version=resource(doc,allowed).version;
        inverse.unshift({type:'rename_resource',resource_id:rid,expected_version:doc.version,name:previous});
      } else if(op.type==='set_resource_design'){
        if(!doc||doc.version!==op.expected_version)fail(409,'设计资源已变化，请刷新后重试');const previous=clone(doc.design);
        if(op.design===null)delete doc.design;else doc.design=normalizeDesign(op.design);doc.version=resource(doc,allowed).version;
        inverse.unshift({type:'set_resource_design',resource_id:rid,expected_version:doc.version,design:previous??null});
      } else if(['put_object','patch_object','delete_object'].includes(op.type)) {
        if(!doc)fail(404,'目标资源不存在');
        const oid=identifier(op.object_id||op.object?.id,'对象 ID'),index=doc.objects.findIndex(o=>o.id===oid),existing=doc.objects[index];
        if((existing?.version??null)!==(op.expected_version??null))fail(409,'对象已被其他修改更新，请检查差异后重试',{resource_id:rid,object_id:oid,current:existing??null});
        if(op.type!=='put_object'&&!existing)fail(404,'对象不存在');
        if(op.type==='delete_object'){doc.objects.splice(index,1);inverse.unshift({type:'put_object',resource_id:rid,object_id:oid,expected_version:null,object:existing});}
        else {
          if(op.type==='patch_object'&&(!op.patch||typeof op.patch!=='object'||Array.isArray(op.patch)))fail(400,'对象修改格式无效');
          const value=op.type==='put_object'?{...op.object,id:oid}:{...existing,...op.patch,id:oid};
          if(op.type==='put_object'&&!existing&&value.prefab)value.name=flatPrefabInstanceName(value,manifest.resources[value.prefab],doc.objects);
          const next=object(value,allowed);
          if(index<0)doc.objects.push(next);else doc.objects[index]=next;
          inverse.unshift(existing?{type:'put_object',resource_id:rid,object_id:oid,expected_version:next.version,object:existing}:{type:'delete_object',resource_id:rid,object_id:oid,expected_version:next.version});
        }
        doc.version=resource(doc,allowed).version;
      } else fail(422,'不支持的事务操作：'+op.type);
      changed.add(rid);
    }
    for(const doc of Object.values(manifest.resources))validateDesignBindings(doc);validateDesignRelations(manifest);
    for(const doc of Object.values(manifest.resources))for(const o of doc.objects)if(o.prefab&&manifest.resources[o.prefab]?.kind!=='prefab')fail(422,'预制件依赖不存在：'+o.prefab);
    return this.transaction(()=>{
      // Synchronous transaction: no pending awaits can interleave head/version mutation.
      const revision=this.writeRevision(p,[branch.head],manifest,user.id,origin);
      branch.head=revision.id;for(const rid of changed)branch.doc_sequences[rid]=(branch.doc_sequences[rid]||0)+1;
      this.put('creator_branch',branch);
      const result={transaction_id:input.transaction_id,revision:revision.id,actor:user,changed_resources:[...changed],inverse,branch:{...branch,manifest}};
      this.put('creator_receipt',{id:receiptId,fingerprint,result});
      this.event(p,{type:'creation_committed',branch_id:b,revision:revision.id,transaction_id:input.transaction_id,actor:user,resource_ids:[...changed]});
      return result;
    });
  }
  invite(user,p,role='editor') {
    const project=this.projectFor(user,p,true);if(project.members[user.id]!=='owner')fail(403,'只有项目所有者可以邀请协作者');
    if(!['editor','viewer'].includes(role))fail(400,'邀请角色无效');
    const code=randomBytes(18).toString('base64url'),created_at=Date.now(),invitation={id:hash(code),project_id:p,role,created_by:user.id,created_at,permission_version:project.permission_version??1,expires_at:created_at+86400000};this.put('creator_invite',invitation);return{id:invitation.id,code,expires_at:invitation.expires_at,expires_in:86400};
  }
  joinInvite(user,code) {
    const invitation=this.get('creator_invite',hash(String(code))),project=invitation&&this.get('creator_project',invitation.project_id);
    if(!project||invitation.expires_at<=Date.now()||invitation.revoked_at||project.members[invitation.created_by]!=='owner'||this.get('creator_user',invitation.created_by)?.disabled_at)fail(404,'邀请已失效');
    const current=this.get('creator_user',user?.id);
    if(project.archived_at||!current||current.disabled_at)fail(403,'此账号或游戏已停用，无法加入');
    if(invitation.used_by){if(invitation.used_by===user.id)return this.projectView(user,this.projectFor(user,project.id));fail(410,'此邀请已被使用，请向拥有者索取新邀请');}
    const cutoff=this.get('creator_permission_cutoff',`${project.id}:${user.id}`);
    if(cutoff&&(Number.isSafeInteger(invitation.permission_version)&&Number.isSafeInteger(cutoff.permission_version)?invitation.permission_version<cutoff.permission_version:(invitation.created_at??0)<=cutoff.at))fail(403,'权限已被调整，请申请编辑或使用拥有者新建的邀请');
    const rank={owner:3,editor:2,viewer:1};
    if((rank[project.members[user.id]]??0)<rank[invitation.role]){project.members[user.id]=invitation.role;project.permission_version=(project.permission_version??1)+1;this.put('creator_project',project);}
    invitation.used_by=user.id;invitation.used_at=Date.now();this.put('creator_invite',invitation);return this.projectView(user,project);
  }
  setMember(user,p,uid,role) {
    const project=this.projectFor(user,p,true);
    if(project.members[user.id]!=='owner'||project.members[uid]==='owner')fail(403,'只能由所有者修改其他协作者权限，拥有者身份不可变更');
    if(!['editor','viewer',null].includes(role))fail(400,'角色无效');
    if(!this.get('creator_user',uid))fail(404,'协作者身份不存在');
    if(role!==null&&this.get('creator_user',uid).disabled_at)fail(409,'账号已停用，无法授予权限');
    if((project.members[uid]??null)===role)return this.projectView(user,project);
    if(role!=='editor')this.put('creator_permission_cutoff',{id:`${p}:${uid}`,at:Date.now(),permission_version:(project.permission_version??1)+1});
    if(role)project.members[uid]=role;else delete project.members[uid];project.permission_version=(project.permission_version??1)+1;this.put('creator_project',project);return this.projectView(user,project);
  }
  createSession(user,p,b,input={}) {
    this.branchFor(user,p,b,true);
    if(input.visibility!==undefined&&!['private','shared'].includes(input.visibility))fail(400,'共享范围无效');
    const authoringAction=createAuthoringAction(this,user,p,b,input.authoring_action);
    if(input.access_mode!==undefined&&!['workspace-write','full-access'].includes(input.access_mode))fail(400,'执行权限无效');
    if(input.execution_mode!==undefined&&!['default','plan','goal'].includes(input.execution_mode))fail(400,'执行模式无效');
    if(input.effort!=null&&(typeof input.effort!=='string'||input.effort.length>32))fail(400,'思考强度无效');
    return this.put('creator_session',{id:id('session'),project_id:p,branch_id:b,owner_user_id:user.id,title:name(input.title,authoringAction?`${authoringAction.name} · AI 添加属性`:'新的创作会话'),visibility:input.visibility??'shared',executor_thread_id:null,model:input.model??null,effort:input.effort===undefined?'medium':input.effort,access_mode:input.access_mode??'full-access',execution_mode:input.execution_mode??'default',draft:'',draft_attachments:[],...(authoringAction?{authoring_action:authoringAction}:{}),created_at:Date.now(),updated_at:Date.now()});
  }
  sessionFor(user,sid,write=false) {
    const session=this.get('creator_session',sid);if(!session)fail(404,'会话不存在');
    const project=this.projectFor(user,session.project_id,write);
    if(!project.members[user.id])fail(403,'试玩账号不能查看项目会话');
    if(session.owner_user_id!==user.id&&(write||session.visibility!=='shared'))fail(403,'此会话为私人会话');
    return session;
  }
  sessions(user,p,b) {
    this.branchFor(user,p,b);
    if(!this.projectFor(user,p).members[user.id])return [];
    return this.list('creator_session').filter(s=>s.project_id===p&&s.branch_id===b&&(s.owner_user_id===user.id||s.visibility==='shared'));
  }
  sessionView(user,sid) {
    const session=this.sessionFor(user,sid);
    const items=kind=>this.db.prepare("SELECT body FROM documents WHERE kind=? AND json_extract(body,'$.session_id')=?").all(kind,sid).map(row=>JSON.parse(row.body));
    return {...session,messages:items('creator_message').sort((a,b)=>a.sequence-b.sequence),runs:items('creator_run').map(run=>{
      if(!run.authoring_action)return run;
      try{return {...run,authoring_result:actionResult(this,run)};}catch{return {...run,authoring_result:null};}
    }),goals:items('creator_goal')};
  }
  updateSession(user,sid,input) {
    const session=this.sessionFor(user,sid,true);
    if(input.access_mode!==undefined){if(!['workspace-write','full-access'].includes(input.access_mode))fail(400,'执行权限无效');session.access_mode=input.access_mode;}
    if(input.execution_mode!==undefined){if(!['default','plan','goal'].includes(input.execution_mode))fail(400,'执行模式无效');session.execution_mode=input.execution_mode;}
    if(input.title!==undefined)session.title=name(input.title);
    if(input.draft!==undefined){if(typeof input.draft!=='string'||input.draft.length>50000)fail(400,'草稿长度无效');session.draft=input.draft;}
    if(input.model!==undefined)session.model=input.model;
    if(input.effort!==undefined){if(input.effort!==null&&(typeof input.effort!=='string'||input.effort.length>32))fail(400,'思考强度无效');session.effort=input.effort;}
    if(input.visibility!==undefined){if(!['private','shared'].includes(input.visibility))fail(400,'共享范围无效');session.visibility=input.visibility;}
    session.updated_at=Date.now();return this.put('creator_session',session);
  }
  removeAttachment(user,sid,attachmentId) {
    const session=this.sessionFor(user,sid,true);
    const selected=session.draft_attachments.find(a=>a.id===attachmentId),observation=selected?.kind==='play_observation'?selected.observation_id:null;
    session.draft_attachments=session.draft_attachments.filter(a=>a.id!==attachmentId&&(!observation||a.observation_id!==observation));
    session.updated_at=Date.now();return this.put('creator_session',session);
  }
  attach(user,sid,input) {
    const requested=this.get('creator_revision',input.revision);
    if(requested?.manifest.schema===NATIVE_SCHEMA)return attachNativeSource(this,user,sid,input);
    if(requested?.manifest.schema===HIERARCHY_SCHEMA)return attachHierarchySource(this,user,sid,input);
    const session=this.sessionFor(user,sid,true),branch=this.branchFor(user,session.project_id,session.branch_id);
    const revision=this.get('creator_revision',input.revision);
    if(!revision||revision.project_id!==session.project_id||!this.ancestor(revision.id,branch.head))fail(409,'附件的源版本无效');
    const doc=revision.manifest.resources[input.resource_id],target=doc?.objects.find(o=>o.id===input.object_id);
    if(!target||input.expected_version!==target.version)fail(409,'附件对象版本无效');
    const scope={project_id:session.project_id,branch_id:session.branch_id,resource_id:doc.id};
    const attachment={id:id('attachment'),...scope,session_id:sid,revision:revision.id,object_id:target.id,object_version:target.version,
      kind:target.kind==='anchor'?'spatial_anchor':'object',snapshot:clone(target),position:clone(target.position),captured_at:Date.now(),
      ...sourceAnnotationContext({manifest:revision.manifest,scope,source_revision:revision.id,target,camera:input.camera})};
    if(input.observation)fail(422,'检查快照附件必须由世界服务验证后建立');
    session.draft_attachments.push(attachment);this.put('creator_session',session);return attachment;
  }
  appendMessage(sid,message) {
    const sequence=this.list('creator_message').filter(m=>m.session_id===sid).length+1;
    return this.put('creator_message',{id:id('message'),session_id:sid,sequence,created_at:Date.now(),...message});
  }
  appendSessionEvent(sid,event) {
    const result=this.db.prepare('INSERT INTO events(project_id,body) VALUES(?,?)').run(`session:${sid}`,JSON.stringify({...event,at:Date.now()}));
    return {...event,cursor:Number(result.lastInsertRowid)};
  }
  sessionEvents(user,sid,after=0,{compact=false}={}) {
    this.sessionFor(user,sid);
    const body=compact?`CASE WHEN length(body)>${COMPACT_EVENT_LIMIT} AND ${TOOL_EVENT_SQL} THEN json_set(json_remove(body,${TOOL_EVENT_PATHS.map(path=>"'"+path+"'").join(',')}),'$.details_available',json('true')) ELSE body END`:'body';
    return this.db.prepare(`SELECT sequence,${body} AS body FROM events WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT 500`).all(`session:${sid}`,after).map(r=>({...JSON.parse(r.body),cursor:r.sequence}));
  }
  sessionEventDetail(user,sid,cursor){
    this.sessionFor(user,sid);
    const row=this.db.prepare('SELECT body FROM events WHERE project_id=? AND sequence=?').get(`session:${sid}`,cursor);
    if(!row)fail(404,'会话事件不存在');return {...JSON.parse(row.body),cursor};
  }
}
