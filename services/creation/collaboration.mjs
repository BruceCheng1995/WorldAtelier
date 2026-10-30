import {clone, fail, hash, id, identifier} from './schema.mjs';

const REQUEST='creator_access_request', EVENT='creator_collaboration_event', OUTBOX='creator_collaboration_outbox';
const text=(value,label)=>{value??='';if(typeof value!=='string'||value.length>500)fail(400,`${label}限 500 字`);return value.trim();};
const fields=(input,allowed)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))fail(400,'协作参数含有不支持的字段');};
const roleLabel=role=>({owner:'拥有者',editor:'可编辑',viewer:'只读',player:'只读试玩'}[role]??'只读试玩');

/** Game-level authority. Membership, request state, audit and notification outbox
 * commit together. Inbox delivery is idempotent and recoverable after restart. */
export class CreationCollaboration {
  constructor({store,inbox,onChanged=()=>{},workspaceUrls=()=>[]}){this.store=store;this.inbox=inbox;this.onChanged=onChanged;this.workspaceUrls=workspaceUrls;this.drain();}
  owner(user,p){const project=this.store.projectFor(user,p);if(project.members[user.id]!=='owner')fail(403,'只有游戏拥有者可以管理协作权限');return project;}
  user(uid){const user=this.store.get('creator_user',uid);return user?this.store.publicUser(user):null;}
  requestView(row){return {...clone(row),requester:this.user(row.requester_user_id),reviewer:this.user(row.reviewer_user_id)};}
  inviteView(row){return {id:row.id,role:row.role,created_at:row.created_at??null,expires_at:row.expires_at,status:row.revoked_at?'revoked':row.used_by?'used':row.expires_at<=Date.now()?'expired':'active',used_by:row.used_by?this.user(row.used_by):null};}
  view(user,p){
    this.drain();const project=this.store.projectFor(user,p),manage=project.members[user.id]==='owner',canEdit=['owner','editor'].includes(this.store.roleFor(user,project));
    const all=this.store.list(REQUEST).filter(r=>r.project_id===p).sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id));
    const mine=all.find(r=>r.requester_user_id===user.id&&r.status==='pending')??all.find(r=>r.requester_user_id===user.id)??null;
    return {project:this.store.projectView(user,project),members:this.store.projectView(user,project).members,
      capabilities:{can_edit:canEdit,can_manage:manage,can_invite:manage,can_change_access:manage,can_request_edit:!canEdit&&Object.values(project.members).includes('owner')&&mine?.status!=='pending',can_create_project:this.store.canCreateProject(user)},
      my_request:mine?this.requestView(mine):null,requests:all.filter(r=>manage||r.requester_user_id===user.id).slice(0,100).map(r=>this.requestView(r)),
      pending_count:manage?all.filter(r=>r.status==='pending').length:0,
      invites:manage?this.store.list('creator_invite').filter(r=>r.project_id===p).sort((a,b)=>(b.created_at??0)-(a.created_at??0)).slice(0,100).map(r=>this.inviteView(r)):[],
      activity:this.store.list(EVENT).filter(r=>r.project_id===p&&(manage||r.subject_user_id===user.id||r.actor_user_id===user.id)).sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id)).slice(0,100).map(r=>({id:r.id,action:r.action,actor:this.user(r.actor_user_id),subject:this.user(r.subject_user_id),from_role:r.from_role,to_role:r.to_role,from_access:r.from_access,to_access:r.to_access,created_at:r.created_at})),
      general_access:this.store.publicPlay&&project.public_play!==false?'registered_readonly':'members_only',
      public_access_available:this.store.publicPlay===true,share_urls:this.workspaceUrls(),share_version:1};
  }
  version(project,input){if(!Number.isSafeInteger(input.expected_version)||input.expected_version<1)fail(400,'需要当前共享权限版本');if((project.permission_version??1)!==input.expected_version)fail(409,'共享权限已变化，请刷新后重试');}
  invitePeople(user,p,input){
    fields(input,['request_id','expected_version','names','role']);this.owner(user,p);
    if(!['viewer','editor'].includes(input.role))fail(400,'邀请权限只能为可查看或可编辑');
    if(!Array.isArray(input.names)||!input.names.length||input.names.length>10||input.names.some(value=>typeof value!=='string'||!value.trim()||value.length>160))fail(400,'请填写 1–10 个已注册的账号用户名');
    return this.mutate(user,p,'invite_people',input,()=>{
      const project=this.owner(user,p);this.version(project,input);
      const names=[...new Set(input.names.map(value=>value.trim().normalize('NFKC').toLowerCase()))];
      const users=this.store.list('creator_user'),targets=names.map(login=>users.find(candidate=>candidate.login===login&&!candidate.disabled_at));
      if(targets.some(target=>!target))fail(400,'部分账号不存在或不可用，请核对用户名；未注册的同事可使用邀请链接');
      const added=[];const rank={owner:3,editor:2,viewer:1};
      for(const target of targets){
        const current=this.owner(user,p),previous=current.members[target.id]??null;
        // Re-inviting never reduces an existing member's access.
        if((rank[previous]??0)>=rank[input.role])continue;
        this.store.setMember(user,p,target.id,input.role);added.push(target.id);
        const event=this.audit(user,p,previous?'member_role_changed':'member_added',target.id,{from_role:previous,to_role:input.role});
        this.notify(event,{title:'你已受邀协作',message:`${project.name} · ${user.name} 已授予你${roleLabel(input.role)}权限`,recipients:[target.id]});
        if(input.role==='editor')for(const row of this.store.list(REQUEST).filter(row=>row.project_id===p&&row.requester_user_id===target.id&&row.status==='pending'))this.finish(user,row,'approved','拥有者已邀请你编辑');
      }
      return {added,project:this.store.projectView(user,this.owner(user,p))};
    });
  }
  generalAccess(user,p,input){
    fields(input,['request_id','expected_version','general_access']);this.owner(user,p);
    if(!['registered_readonly','members_only'].includes(input.general_access))fail(400,'共享范围无效');
    if(input.general_access==='registered_readonly'&&!this.store.publicPlay)fail(403,'服务器未开放公共试玩，只能邀请成员');
    return this.mutate(user,p,'general_access',input,()=>{
      const project=this.owner(user,p);this.version(project,input);
      const previous=this.store.publicPlay&&project.public_play!==false?'registered_readonly':'members_only';
      if(previous!==input.general_access){
        project.public_play=input.general_access==='registered_readonly';project.permission_version=(project.permission_version??1)+1;this.store.put('creator_project',project);
        const event=this.audit(user,p,'general_access_changed',null,{from_access:previous,to_access:input.general_access});
        this.notify(event,{title:'游戏共享范围已更新',message:`${project.name} · ${project.public_play?'注册用户可查看和试玩，编辑仍需授权':'仅受邀成员可以访问'}`,recipients:Object.keys(project.members)});
      }
      return {general_access:input.general_access,project:this.store.projectView(user,project)};
    });
  }
  mutate(user,p,action,input,fn,{optionalId=false}={}){
    const requestId=input.request_id??(optionalId?id('request'):null);identifier(requestId,'请求 ID');
    const key=hash({user:user.id,requestId}),fingerprint=hash({p,action,input}),before=this.store.get('creator_project',p)?.permission_version??1;
    const result=this.store.transaction(()=>{
      const old=this.store.get('creator_collaboration_receipt',key);
      if(old){if(old.fingerprint!==fingerprint)fail(409,'同一请求 ID 不能使用不同内容');return {...old.result,replayed:true};}
      const value=fn();this.store.put('creator_collaboration_receipt',{id:key,fingerprint,result:clone(value),created_at:Date.now()});return {...value,replayed:false};
    });
    this.drain();try{this.onChanged(p,{permissionsChanged:before!==(this.store.get('creator_project',p)?.permission_version??1)});}catch{}return result;
  }
  audit(user,p,action,subject=null,extra={}){
    const row={id:id('collab'),project_id:p,actor_user_id:user.id,subject_user_id:subject,action,created_at:Date.now(),...extra};this.store.put(EVENT,row);return row;
  }
  notify(event,{title,message,recipients,decision=false}){
    event.recipient_user_ids=[...new Set(recipients)];this.store.put(EVENT,event);
    this.store.put(OUTBOX,{id:event.id,project_id:event.project_id,record:{event_id:event.id,dedupe_key:event.id,source:'collaboration',kind:decision?'decision':'notice',severity:'info',project_id:event.project_id,collaboration_id:event.id,title,message,recipient_user_ids:event.recipient_user_ids,actions:[{id:'collaboration',label:decision?'处理申请':'查看协作'}],occurred_at:event.created_at}});
  }
  drain(){
    if(!this.inbox)return;
    for(const delivery of this.store.list(OUTBOX).filter(r=>!r.delivered_at).sort((a,b)=>Number(!a.record)-Number(!b.record)||(a.record?.occurred_at??0)-(b.record?.occurred_at??0))){
      try{
        if(delivery.record)this.inbox.record(delivery.record);
        if(delivery.close_request_id){
          if(this.store.list(OUTBOX).some(row=>row.record&&!row.delivered_at&&this.store.get(EVENT,row.id)?.request_id===delivery.close_request_id))throw new Error('等待申请通知持久化');
          for(const item of this.store.list('creator_inbox_item')){
          const event=item.collaboration_id&&this.store.get(EVENT,item.collaboration_id);
          if(item.source==='collaboration'&&item.kind==='decision'&&event?.request_id===delivery.close_request_id&&item.status==='open')this.inbox.close(item.id,{status:'resolved',reason:delivery.reason});
          }
        }
        this.store.put(OUTBOX,{...delivery,delivered_at:Date.now()});
      }catch(error){this.lastDeliveryError={message:error.message,at:Date.now()};}
    }
  }
  finish(user,row,status,note=''){
    row.status=status;row.version++;row.updated_at=row.resolved_at=Date.now();row.reviewer_user_id=status==='cancelled'?null:user.id;row.decision_note=note;this.store.put(REQUEST,row);
    const labels={approved:'已批准编辑申请',rejected:'未批准编辑申请',cancelled:'已撤回编辑申请',superseded:'编辑申请已结束'};
    const event=this.audit(user,row.project_id,`request_${status}`,row.requester_user_id,{request_id:row.id});
    this.store.put(OUTBOX,{id:`close-${event.id}`,close_request_id:row.id,reason:labels[status]});
    const project=this.store.get('creator_project',row.project_id);
    const recipients=status==='cancelled'?Object.keys(project.members).filter(uid=>project.members[uid]==='owner'):[row.requester_user_id];
    this.notify(event,{title:labels[status],message:`${project.name} · ${labels[status]}${note?`：${note}`:''}`,recipients});
    return row;
  }
  request(user,p,input){
    fields(input,['request_id','reason']);const project=this.store.projectFor(user,p),reason=text(input.reason,'申请说明');
    if(!Object.values(project.members).includes('owner'))fail(403,'此默认工程供查看和试玩，不接受编辑申请');
    return this.mutate(user,p,'request',input,()=>{
      if(['owner','editor'].includes(this.store.roleFor(user,project)))fail(409,'你已拥有编辑权限');
      const pending=this.store.list(REQUEST).find(r=>r.project_id===p&&r.requester_user_id===user.id&&r.status==='pending');
      if(pending)return {request:this.requestView(pending)};
      const now=Date.now(),row={id:id('access'),project_id:p,requester_user_id:user.id,status:'pending',version:1,reason,decision_note:'',created_at:now,updated_at:now,resolved_at:null,reviewer_user_id:null};
      this.store.put(REQUEST,row);const event=this.audit(user,p,'request_created',user.id,{request_id:row.id});
      this.notify(event,{title:`${user.name} 申请编辑`,message:`${project.name}${reason?` · ${reason}`:' · 申请参与游戏创作'}`,recipients:Object.keys(project.members).filter(uid=>project.members[uid]==='owner'),decision:true});
      return {request:this.requestView(row)};
    });
  }
  resolve(user,p,rid,input,cancel=false){
    fields(input,cancel?['request_id','expected_version']:['request_id','expected_version','decision','note']);
    if(cancel)this.store.projectFor(user,p);else this.owner(user,p);
    const row=this.store.get(REQUEST,rid);if(!row||row.project_id!==p)fail(404,'申请不存在');
    if(cancel&&row.requester_user_id!==user.id)fail(403,'只能撤回自己的申请');
    if(!cancel&&!['approve','reject'].includes(input.decision))fail(400,'审批结果无效');
    const note=text(input.note,'处理说明');
    return this.mutate(user,p,`${cancel?'cancel':'decision'}:${rid}`,input,()=>{
      if(row.status!=='pending'||row.version!==input.expected_version)fail(409,'申请已处理或已变化，请查看最新状态');
      if(!cancel&&input.decision==='approve')this.store.setMember(user,p,row.requester_user_id,'editor');
      this.finish(user,row,cancel?'cancelled':input.decision==='approve'?'approved':'rejected',note);
      return {request:this.requestView(row)};
    });
  }
  member(user,p,uid,input){
    fields(input,['request_id','expected_version','role']);this.owner(user,p);
    const result=this.mutate(user,p,`member:${uid}`,input,()=>{
      const project=this.owner(user,p);if(input.expected_version!==undefined&&(project.permission_version??1)!==input.expected_version)fail(409,'成员权限已变化，请刷新后重试');
      const previous=project.members[uid]??null;const updated=this.store.setMember(user,p,uid,input.role);
      if(previous!==input.role){
        const event=this.audit(user,p,input.role===null?'member_removed':'member_role_changed',uid,{from_role:previous,to_role:input.role});
        this.notify(event,{title:input.role===null?'协作成员身份已移除':'协作权限已更新',message:`${project.name} · ${input.role===null?this.store.publicPlay&&project.public_play!==false?'已移除成员身份；仍可公共查看和试玩':'已移除成员身份；不再拥有此游戏的访问权限':`现在为${roleLabel(input.role)}`}`,recipients:[uid]});
        for(const row of this.store.list(REQUEST).filter(r=>r.project_id===p&&r.requester_user_id===uid&&r.status==='pending'))this.finish(user,row,input.role==='editor'?'approved':'superseded','拥有者已直接调整成员权限');
      }
      return {project:updated};
    },{optionalId:true});
    return {...this.store.projectView(user,this.owner(user,p)),replayed:result.replayed};
  }
  invite(user,p,input){
    fields(input,['request_id','role']);this.owner(user,p);
    return this.mutate(user,p,'invite',input,()=>{const invitation=this.store.invite(user,p,input.role??'editor');this.audit(user,p,'invite_created',null,{to_role:input.role??'editor'});return invitation;},{optionalId:true});
  }
  revokeInvite(user,p,iid,input){
    fields(input,['request_id']);this.owner(user,p);
    return this.mutate(user,p,`invite_revoke:${iid}`,input,()=>{
      const invite=this.store.get('creator_invite',iid);if(!invite||invite.project_id!==p)fail(404,'邀请不存在');
      if(!invite.revoked_at){invite.revoked_at=Date.now();this.store.put('creator_invite',invite);this.audit(user,p,'invite_revoked');}return {invite:this.inviteView(invite)};
    });
  }
  join(user,input){
    fields(input,['code','request_id']);if(typeof input.code!=='string'||input.code.length>200)fail(400,'邀请码无效');
    const invitation=this.store.get('creator_invite',hash(input.code));if(!invitation)fail(404,'邀请已失效');
    const p=invitation.project_id;
    this.mutate(user,p,`join:${invitation.id}`,input,()=>{
      const before=this.store.get('creator_project',p)?.members[user.id]??null,project=this.store.joinInvite(user,input.code),after=this.store.get('creator_project',p).members[user.id]??null;
      if(before!==after){
        const event=this.audit(user,p,'member_joined',user.id,{from_role:before,to_role:after});
        this.notify(event,{title:`${user.name} 已加入协作`,message:`${project.name} · ${roleLabel(after)}`,recipients:[user.id,...project.members.filter(m=>m.role==='owner').map(m=>m.id)]});
        if(after==='editor')for(const row of this.store.list(REQUEST).filter(r=>r.project_id===p&&r.requester_user_id===user.id&&r.status==='pending'))this.finish(this.user(invitation.created_by),row,'approved','已通过拥有者的邀请获得编辑权限');
      }
      return {project};
    },{optionalId:true});
    return this.store.projectView(user,this.store.projectFor(user,p));
  }
}
