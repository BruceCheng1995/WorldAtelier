import { clone, fail, hash, id } from './schema.mjs';
import {publicTargetResolver} from './hierarchy-agent.mjs';
import {HIERARCHY_SCHEMA, resolveScene} from './hierarchy.mjs';
import {hierarchyRuntimeId} from './hierarchy-view.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';
import {resolveNativeObject} from './native-reference.mjs';

const actions={locate:{id:'locate',label:'查看内容'},session:{id:'session',label:'查看 Agent 会话'},decision:{id:'decision',label:'处理请求'},build:{id:'build',label:'查看构建'}};
export class CreationNotifications {
  constructor({service}){this.service=service;this.store=service.store;this.clientRates=new Map();}
  clean(value,fallback='请打开对应记录查看实际结果。'){
    let result=String(value??'').replace(/([?&](?:cap|token)=)[^\s&#]+/gi,'$1[已隐藏]');
    for(const [path,label]of [[this.service.data,'[服务数据]'],[this.service.root,'[工程]']])if(typeof path==='string'&&path)result=result.split(path).join(label);
    return result.trim().slice(0,4000)||fallback;
  }
  record(input){return this.service.observe(()=>{
    const manifest=input.revision&&this.store.get('creator_revision',input.revision)?.manifest;
    // A deleted document has no current asset badge, but must not erase an
    // execution failure notification. Client claims are validated before here.
    const targets=manifest?(input.targets??[]).filter(t=>manifest.resources[t.resource_id??t.address?.resource_id]):input.targets;
    const resource_id=manifest&&input.resource_id&&!manifest.resources[input.resource_id]?null:input.resource_id;
    return this.service.inbox.record({...input,...(targets?{targets}:{}),...(resource_id!==undefined?{resource_id}:{}),title:this.clean(input.title,'需要查看的开发进展').slice(0,240),message:this.clean(input.message)});
  });}
  close(scope,reason,status='resolved'){return this.service.observe(()=>this.service.inbox.closeByScope(scope,{status,reason}));}
  closeMatching(scope,reason,status='resolved',predicate=()=>true){
    // A trusted producer sometimes has a session or recovery boundary rather
    // than one run ID. Expand it to exact existing item IDs and version guards;
    // never send unsupported selector keys or silently broaden closeByScope.
    return this.service.observe(()=>{
      if(!scope.source||!scope.kind)fail(400,'结束通知需明确来源和类别');
      const items=this.store.list('creator_inbox_item').filter(item=>item.status==='open'&&Object.entries(scope).every(([key,value])=>item[key]===value)&&predicate(item));
      return {items:items.map(item=>this.service.inbox.close(item.id,{expected_version:item.version,status,reason}).item),count:items.length};
    });
  }
  fixedTarget(scope,input={},strict=false){
    if(!scope.resource_id)return null;
    const base={resource_id:scope.resource_id},manifest=this.store.get('creator_revision',scope.revision)?.manifest;
    if(!manifest?.resources[scope.resource_id]){if(strict)fail(409,'观察文档不在固定版本中');return base;}
    if(!input.address&&!input.object_id)return base;
    try{
      if(manifest.schema===NATIVE_SCHEMA){
        const resolved=resolveNativeObject(manifest,scope,input.address,input.object_id);
        if(!resolved)fail(409,'观察对象不在固定原生版本中');
        return{...base,object_id:resolved.id,address:clone(resolved.address)};
      }
      let target=input;
      if(!input.address&&manifest.schema===HIERARCHY_SCHEMA){
        const row=resolveScene(manifest,scope.resource_id,{project_id:scope.project_id,branch_id:scope.branch_id}).find(row=>hierarchyRuntimeId(row.address)===input.object_id);
        if(!row)fail(409,'观察对象不在固定版本中');
        target={address:row.address};
      }
      const resolved=publicTargetResolver(manifest,scope)(target);
      if(!resolved)fail(409,'观察对象不在固定版本中');
      if(input.address&&input.object_id&&![resolved.runtimeId,resolved.address.definition_node_id].includes(input.object_id))fail(409,'客户端对象与地址不匹配');
      return {...base,object_id:resolved.runtimeId,address:resolved.address};
    }catch(error){if(strict)throw error;return base;}
  }
  runScope(run){return {project_id:run.project_id,branch_id:run.branch_id,session_id:run.session_id,run_id:run.id,revision:run.changes?.at(-1)??run.input_revision,targets:clone(run.targets??[])};}
  session(sid,event){
    const session=this.store.get('creator_session',sid);if(!session)return;
    if(event.kind==='run_state'){
      const run=event.run;if(!run)return;
      if(run.status==='completed'){this.close({source:'agent',kind:'error',code:'agent_execution',run_id:run.id},'真实执行器已确认本次开发成功结束');}
      if(['failed','uncertain'].includes(run.status)||run.cleanup_status==='uncertain')this.record({...this.runScope(run),source:'agent',kind:'error',code:run.cleanup_status==='uncertain'?'agent_cleanup':'agent_execution',event_id:hash(['run',run.id,run.status,run.cleanup_status,run.error]),dedupe_key:hash(['run',run.id,run.cleanup_status==='uncertain'?'cleanup':'execution']),title:run.cleanup_status==='uncertain'?'Agent 命令清理需要核对':run.status==='uncertain'?'Agent 执行结果尚未确认':'Agent 开发遇到问题',message:run.cleanup_status==='uncertain'?'后台命令尚未确认停止。打开原会话核对后可继续开发。':this.clean(run.error?.message??run.error??'打开原会话查看失败位置和实际执行结果。'),actions:[actions.session],recipient_user_ids:[run.owner_user_id]});
      if(run.cleanup_status==='verified')this.close({source:'agent',kind:'error',code:'agent_cleanup',run_id:run.id},'实际命令清理已确认');
      if(['completed','failed','interrupted'].includes(run.status))this.close({source:'agent',kind:'decision',code:'agent_request',run_id:run.id},'对应开发执行已结束','obsolete');
    }
    if(event.kind==='approval_request'){
      const run=event.params?.turnId?this.service.agent?.runForTurn(session.executor_thread_id,event.params.turnId):null;
      this.record({...(run?this.runScope(run):{project_id:session.project_id,branch_id:session.branch_id,session_id:sid}),source:'agent',kind:'decision',code:'agent_request',event_id:hash(['request',sid,event.request_key]),dedupe_key:hash(['request',sid,event.request_key]),request_key:event.request_key,title:event.method==='item/tool/requestUserInput'?'Agent 有一个问题需要你决定':'Agent 需要执行许可',message:'打开对应请求查看上下文并答复。关闭消息不会批准，也不会中止任务。',actions:[actions.decision],recipient_user_ids:[session.owner_user_id]});
    }
    if(event.kind==='notification'&&event.method==='serverRequest/resolved')this.close({source:'agent',kind:'decision',code:'agent_request',session_id:sid,request_key:`${event.epoch}:${String(event.params?.requestId)}`},'请求已由真实执行器结束');
    if(event.kind==='notification'&&['thread/closed','thread/deleted'].includes(event.method))this.closeMatching({source:'agent',kind:'decision',code:'agent_request',session_id:sid},'开发执行器会话已结束','obsolete');
    const item=event.params?.item;
    if(event.kind==='notification'&&event.method==='item/completed'&&item&&['commandExecution','dynamicToolCall','mcpToolCall'].includes(item.type)&&(item.status==='failed'||item.error||typeof item.exitCode==='number'&&item.exitCode!==0)){
      const run=this.service.agent?.runForTurn(session.executor_thread_id,event.params.turnId);if(!run)return;
      this.record({...this.runScope(run),source:'agent',kind:'error',code:'agent_tool',event_id:hash(['tool',run.id,item.id]),dedupe_key:hash(['tool',run.id,item.id]),title:'Agent 的一次工具执行未成功',message:'Agent 可能仍在修复。可打开会话查看实际错误和后续处理。',actions:[actions.session],recipient_user_ids:[run.owner_user_id]});
    }
  }
  requestClosed(sid,key){return this.close({source:'agent',kind:'decision',code:'agent_request',session_id:sid,request_key:key},'请求已答复');}
  verification(v){
    if(v.origin?.kind==='automatic'||!['passed','failed'].includes(v.status))return;
    const run=v.origin?.run_id&&this.store.get('creator_run',v.origin.run_id),scope={project_id:v.project_id,branch_id:v.branch_id,resource_id:v.resource_id,revision:v.revision,runtime_build_id:v.runtime_build_id??v.game_validation_identity?.identity_hash??null};
    if(v.status==='passed'){return this.close({...scope,source:'backend',kind:'validation',code:'godot_validation',run_id:run?.id??null},'相同固定内容已通过 Godot 检查');}
    return this.record({...scope,...(run?{session_id:run.session_id,run_id:run.id,recipient_user_ids:[run.owner_user_id]}:{}),source:'backend',kind:'validation',code:'godot_validation',event_id:v.id,dedupe_key:hash(['validate',scope]),targets:[{resource_id:v.resource_id}],title:'Godot 检查未通过',message:this.clean(v.error??v.report?.error??'Godot 加载或行为检查失败'),actions:[actions.locate,...(run?[actions.session]:[])]});
  }
  world(world,failure,{notify=true}={}){
    if(!notify||this.service.closing||this.service.worlds?.closing||failure.kind==='precondition')return;
    // Snapshots carry the fault itself; world_events wrap the same fault in data.
    const faults=(Array.isArray(failure.runtime_fault)?failure.runtime_fault:[failure.runtime_fault]).filter(Boolean).map(fault=>({...fault,...(fault.data&&typeof fault.data==='object'&&!Array.isArray(fault.data)?fault.data:{})}));
    const scope={project_id:world.project_id,branch_id:world.branch_id,resource_id:world.resource_id,revision:world.revision,runtime_build_id:world.runtime_build_id,world_id:world.id,epoch:world.epoch};
    const targets=faults.length?faults.slice(0,199).map(fault=>this.fixedTarget(scope,{object_id:fault.object_id??fault.id,address:fault.address})):[];
    if(!targets.length||faults.length>199)targets.push(this.fixedTarget(scope));
    const details=faults.map(fault=>typeof fault.error==='string'?fault.error:fault.error?.message).filter(Boolean);
    return this.record({...scope,source:'godot_authority',kind:'error',code:failure.kind==='behavior'?'world_behavior':'world_connection',event_id:failure.id,dedupe_key:hash([world.id,world.epoch,failure.kind,targets]),targets,title:failure.kind==='behavior'?'运行中的场景出现行为错误':'共享世界运行中断',message:this.clean([failure.message,...details].filter(Boolean).join('\n')),actions:[actions.locate]});
  }
  worldReady(world){return this.closeMatching({source:'godot_authority',kind:'error',project_id:world.project_id,branch_id:world.branch_id,world_id:world.id,resource_id:world.resource_id,code:'world_connection'},'Godot 已确认该世界恢复','resolved',item=>Number.isSafeInteger(item.epoch)&&item.epoch<=world.epoch);}
  build(job){
    if(!['completed','partial','failed','interrupted'].includes(job.status))return;
    if(job.status==='completed')this.close({source:'backend',kind:'error',project_id:job.project_id,branch_id:job.branch_id,job_id:job.id,code:'build_result'},'同一构建作业已实际完成');
    if(job.purpose==='native_preview'&&job.status==='completed')return;
    return this.record({project_id:job.project_id,branch_id:job.branch_id,revision:job.source_revision,job_id:job.id,source:'backend',kind:job.status==='completed'?'notice':'error',severity:job.status==='completed'?'info':'error',code:'build_result',event_id:hash(['build',job.id,job.status]),dedupe_key:hash(['build',job.id]),title:job.status==='completed'?'构建已完成':job.status==='partial'?'部分平台构建失败':'构建未完成',message:this.clean(job.error??job.target_results?.filter(t=>t.status==='failed').map(t=>`${t.target}: ${t.error}`).join('\n')??job.stage,job.status==='completed'?'构建产物已经生成，可在构建详情中查看。':'请打开构建记录查看对应平台的实际结果。'),recipient_user_ids:[job.actor_id],actions:[actions.build]});
  }
  sharedClientScope(user,input,scope){
    // This is a fixed public runtime observation, never a source permission.
    // Keep it recipient-only so neither targets nor source issue markers leak.
    if(typeof input.shared_build_id!=='string'||!input.shared_build_id.trim()||input.shared_build_id.length>160||!scope.client_id)fail(400,'共享客户端诊断需要固定构建和窗口身份');
    if(!['asset_load','runtime_load','runtime_fault','client_script','connection'].includes(input.code))fail(400,'共享客户端诊断类型无效');
    if(['object_id','address','world_id','epoch','session_id','run_id','goal_id','job_id','targets','recipient_user_ids','request_key','collaboration_id'].some(key=>input[key]!=null))fail(400,'共享客户端诊断不能引用源稿对象或其他通知范围');
    const job=this.store.get('creator_build',input.shared_build_id);
    if(!job||job.purpose!=='native_shared'||job.status!=='completed'||job.canonical_identity!==scope.runtime_build_id||job.project_id!==input.project_id||job.branch_id!==input.branch_id||job.source_revision!==input.revision||job.entry_scene_id!==input.resource_id)fail(403,'共享客户端诊断与固定发行不匹配');
    const fixed=this.store.get('creator_revision',job.source_revision);
    if(fixed?.project_id!==job.project_id||fixed.manifest?.schema!==NATIVE_SCHEMA||fixed.manifest.resources?.[job.entry_scene_id]?.kind!=='scene')fail(403,'共享客户端诊断缺少固定原生场景');
    if(!this.service.worlds?.native)fail(503,'共享世界服务尚未就绪');
    this.service.worlds.native.authorizeBuild(user,job);
    return {scope,target:null};
  }
  clientScope(user,input){
    const scope={};
    if(input.client_id!=null){if(typeof input.client_id!=='string'||!input.client_id.trim()||input.client_id.length>160)fail(400,'客户端身份无效');scope.client_id=input.client_id;}
    if(input.runtime_build_id!=null){if(typeof input.runtime_build_id!=='string'||!input.runtime_build_id.trim()||input.runtime_build_id.length>512)fail(400,'客户端运行构建无效');scope.runtime_build_id=input.runtime_build_id;}
    if(input.shared_build_id!=null)return this.sharedClientScope(user,input,scope);
    if(input.project_id){
      const project=this.store.projectFor(user,input.project_id);
      // Client observations do not edit source. Public play access alone does
      // not grant source diagnostics; read-only members retain their own nonce.
      if(!['owner','editor','viewer'].includes(project.members?.[user.id]))fail(403,'只有项目成员可提交源稿诊断');
      if(project.members[user.id]==='viewer'&&!scope.client_id)fail(400,'只读客户端诊断需要窗口身份');
      const branch=this.store.branchFor(user,input.project_id,input.branch_id),fixed=this.store.get('creator_revision',input.revision);
      if(!fixed||fixed.project_id!==input.project_id||!this.store.ancestor(input.revision,branch.head))fail(409,'客户端观察版本已失效');
      if(input.resource_id&&!fixed.manifest.resources[input.resource_id])fail(409,'观察资源不存在');
      Object.assign(scope,{project_id:input.project_id,branch_id:input.branch_id,revision:input.revision,resource_id:input.resource_id??null});
      if(input.world_id!=null){
        const world=this.store.get('creator_world',input.world_id);
        if(!world||world.project_id!==scope.project_id||world.branch_id!==scope.branch_id||world.resource_id!==scope.resource_id||!Number.isSafeInteger(input.epoch)||input.epoch<1||!scope.runtime_build_id)fail(409,'客户端观察世界范围不匹配');
        Object.assign(scope,{world_id:input.world_id,epoch:input.epoch});
      }
    }else if(input.branch_id||input.revision||input.resource_id||input.object_id||input.address||input.world_id)fail(400,'客户端资产观察必须属于明确项目');
    if((input.object_id||input.address)&&!scope.resource_id)fail(400,'客户端对象观察必须固定文档');
    return {scope,target:this.fixedTarget(scope,input,true)};
  }
  clientKey(user,input,scope,target){return hash(['client',user.id,scope,input.code,target,input.client_id??null,input.runtime_build_id??null]);}
  client(user,input){
    const accepted=['asset_load','runtime_load','runtime_fault','client_script','connection','operation_conflict'];if(!accepted.includes(input.code)||typeof input.event_id!=='string'||!input.event_id.trim()||input.event_id.length>160)fail(400,'客户端问题类型无效');
    const rate=this.clientRates.get(user.id)??[];const recent=rate.filter(t=>t>Date.now()-60000);if(recent.length>=40)fail(429,'重复客户端问题已合并，请稍后再试');recent.push(Date.now());this.clientRates.set(user.id,recent);
    const {scope,target}=this.clientScope(user,input);
    return this.record({...scope,source:'godot_client',kind:input.code==='connection'?'notice':'error',severity:input.code==='operation_conflict'?'warning':'error',code:input.code,event_id:hash(['client',user.id,input.event_id]),dedupe_key:this.clientKey(user,input,scope,target),title:{asset_load:'视口资源加载失败',runtime_load:'Godot 客户端未能启动',runtime_fault:'Godot 客户端运行出现问题',client_script:'工作台交互出现异常',connection:'工作台连接状态变化',operation_conflict:'一次编辑需要重新核对'}[input.code],message:this.clean(input.message||'请重新打开对应内容或查看连接状态。'),recipient_user_ids:[user.id],targets:target?[target]:[],actions:target?[actions.locate]:[]});
  }
  clientRecovered(user,input){
    if(!['asset_load','runtime_load'].includes(input.code))fail(400,'恢复类型无效');
    const {scope,target}=this.clientScope(user,input);
    if(target?.object_id||target?.address)return this.close({...scope,source:'godot_client',kind:'error',code:input.code,dedupe_key:this.clientKey(user,input,scope,target)},'同一用户客户端报告相同固定对象已加载');
    const exact=Object.fromEntries(['project_id','branch_id','revision','resource_id','runtime_build_id','world_id','epoch','client_id'].map(key=>[key,scope[key]??null]));
    // A real document-loaded event covers all its children, but only in this
    // user/client nonce and immutable candidate. It cannot clear another tab.
    return this.closeMatching({...exact,source:'godot_client',kind:'error',code:input.code},'同一用户客户端报告相同固定文档已加载','resolved',item=>item.recipient_user_ids.length===1&&item.recipient_user_ids[0]===user.id);
  }
  backend(user,scope,error){if(!user||!scope.project_id||![409,422,500,502,503,504].includes(error.status??500))return;try{this.store.branchFor(user,scope.project_id,scope.branch_id);}catch{return;}
    const content=[409,422].includes(error.status);this.record({...scope,source:'backend',kind:content?'notice':'error',severity:content?'warning':'error',code:content?'operation_rejected':'service_failure',event_id:id('service-event'),dedupe_key:hash([user.id,scope,error.status,this.clean(error.message)]),title:content?'操作未完成，原内容已保留':'服务器未能完成操作',message:this.clean(error.message),recipient_user_ids:[user.id],actions:scope.resource_id?[actions.locate]:[]});
  }
}
