import {AdminMarket} from './admin-market.mjs';
import {AiLimits} from './ai-limits.mjs';
import {randomBytes} from 'node:crypto';
import {hash, id, fail, clone, name, identifier} from './schema.mjs';
import {AdminMetrics} from './admin-metrics.mjs';
import {AdminTokenUsage} from './admin-token-usage.mjs';

const COOKIE='wa_admin',ACTIVE=new Set(['queued','starting','running','reviewing','waiting_input','cancelling']);
const fields=(input,allowed)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))fail(400,'不支持的管理参数');};
const page=(items,query)=>{const q=String(query.get('q')??'').trim().toLowerCase(),state=query.get('status'),limit=Math.min(100,Math.max(1,Number(query.get('limit'))||25));items=items.filter(x=>(!q||JSON.stringify(x).toLowerCase().includes(q))&&(!state||x.status===state||x.ext===state));const total=items.length,pages=Math.max(1,Math.ceil(total/limit)),current=Math.min(pages,Math.max(1,Number(query.get('page'))||1));return {items:items.slice((current-1)*limit,current*limit),total,page:current,pages,limit};};
const cookieValue=req=>String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);

export class CreationAdmin {
  constructor({service,server}){this.service=service;this.store=service.store;this.metrics=new AdminMetrics(service,server);this.market=new AdminMarket(this);this.tokenUsage=new AdminTokenUsage(this.store);}
  assert(user){if(!this.store.isAdmin(user))fail(403,'此页面仅对服务器管理员开放');return user;}
  cookieUser(req){
    const token=cookieValue(req),grant=token&&this.store.get('creator_admin_session',hash(token));
    const login=grant&&this.store.get('creator_login',grant.login_id);
    if(!grant||grant.expires_at<=Date.now()||!login||login.user_id!==grant.user_id||login.expires_at<=Date.now())fail(401,'请登录管理员账号');
    const user=this.store.get('creator_user',grant.user_id);this.assert(user);return this.store.publicUser(user);
  }
  auth(req){return req.headers.authorization?this.assert(this.service.auth(req)):this.cookieUser(req);}
  access(req,res){
    const user=this.assert(this.service.auth(req)),loginId=hash(String(req.headers.authorization).replace(/^Bearer /,'')),login=this.store.get('creator_login',loginId);
    const token=randomBytes(32).toString('base64url'),expires_at=Math.min(Date.now()+8*3600000,login.expires_at);
    this.store.put('creator_admin_session',{id:hash(token),user_id:user.id,login_id:loginId,expires_at});
    for(const g of this.store.list('creator_admin_session'))if(g.expires_at<Date.now())this.store.remove('creator_admin_session',g.id);
    res.setHeader('Set-Cookie',`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((expires_at-Date.now())/1000)}`);
    return {ok:true,user,expires_at};
  }
  logout(req,res){const token=cookieValue(req);if(token)this.store.remove('creator_admin_session',hash(token));res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);return {ok:true};}
  users(){
    const projects=this.store.list('creator_project'),logins=this.store.list('creator_login'),connections=[...this.service.realtime.connections.values()];
    return this.store.list('creator_user').map(u=>({...this.store.publicUser(u),status:u.disabled_at?'disabled':'active',version:u.admin_version??1,created_at:u.created_at,last_login_at:u.last_login_at??null,is_admin:this.store.isAdmin(u),creation_allowed:u.creation_allowed??null,can_create_project:this.store.canCreateProject(u),login_count:logins.filter(l=>l.user_id===u.id&&l.expires_at>Date.now()).length,online_connections:connections.filter(c=>c.user?.id===u.id).length,projects:projects.filter(p=>p.members[u.id]).map(p=>({id:p.id,name:p.name,role:p.members[u.id],status:p.archived_at?'archived':'active'}))})).sort((a,b)=>Number(b.is_admin)-Number(a.is_admin)||b.created_at-a.created_at);
  }
  worlds(){
    const live=[...(this.service.worlds?.worlds.values()??[])],stored=this.store.list('creator_world'),all=new Map(stored.map(w=>[w.id,w]));for(const w of live)all.set(w.id,w);
    return [...all.values()].map(w=>{const actual=live.find(x=>x.id===w.id);return {id:w.id,project_id:w.project_id,branch_id:w.branch_id,resource_id:w.resource_id,revision:w.revision,runtime_build_id:w.runtime_build_id,epoch:w.epoch,status:actual?(actual.ready&&!actual.failed?'running':'starting'):'checkpoint',players:actual?.clients?.size??0,pid:actual?.process?.pid??null,last_seen:actual?.last_seen??null,has_failure:Boolean(w.failure)};});
  }
  projects(){const branches=this.store.list('creator_branch'),worlds=this.worlds(),users=this.store.list('creator_user');return this.store.list('creator_project').map(p=>({id:p.id,name:p.name,status:p.archived_at?'archived':'active',created_at:p.created_at,version:p.permission_version??1,public_play:p.public_play??null,effective_public_play:!p.archived_at&&this.store.publicPlay&&p.public_play!==false,members:Object.entries(p.members).map(([uid,role])=>({...this.store.publicUser(users.find(u=>u.id===uid)??{id:uid,name:'账号不存在'}),role})),branches:branches.filter(b=>b.project_id===p.id).map(b=>({id:b.branch_id,name:b.name,source_head:b.head,updated_at:this.store.get('creator_revision',b.head)?.created_at??b.created_at,resource_count:Object.keys(this.store.get('creator_revision',b.head)?.manifest.resources??{}).length,worlds:worlds.filter(w=>w.project_id===p.id&&w.branch_id===b.branch_id)}))})).sort((a,b)=>b.created_at-a.created_at);}
  assetReferences(){
    const map=new Map(),projects=this.store.list('creator_project'),branches=this.store.list('creator_branch');
    const add=(digest,value)=>{if(!map.has(digest))map.set(digest,{current:[],historical_revisions:0});if(value)map.get(digest).current.push(value);else map.get(digest).historical_revisions++;};
    const digests=manifest=>new Set(JSON.stringify(manifest??{}).match(/[a-f0-9]{64}/g)??[]);
    for(const b of branches)for(const digest of digests(this.store.get('creator_revision',b.head)?.manifest))add(digest,{project_id:b.project_id,project_name:projects.find(p=>p.id===b.project_id)?.name??b.project_id,branch_id:b.branch_id,revision:b.head});
    for(const r of this.store.list('creator_revision'))for(const digest of digests(r.manifest))add(digest,null);
    return map;
  }
  assets(){const refs=this.assetReferences();return this.store.list('creator_asset').map(a=>({id:a.id,name:a.name,ext:a.ext,bytes:a.bytes,builtin:Boolean(a.builtin),status:a.quarantined_at?'quarantined':'active',version:a.admin_version??1,created_at:a.created_at??null,project_ids:a.project_ids??[],references:refs.get(a.id)??{current:[],historical_revisions:0}})).sort((a,b)=>b.bytes-a.bytes);}
  jobs(){const kinds=[['creator_run','development'],['creator_build','build'],['creator_export_build','build']];return kinds.flatMap(([kind,type])=>this.store.list(kind).map(j=>({id:j.id,type,status:j.status,project_id:j.project_id,branch_id:j.branch_id,resource_id:j.resource_id??null,actor_id:j.owner_user_id??j.actor_id??j.requested_by??null,created_at:j.created_at??j.started_at,updated_at:j.updated_at??j.finished_at??j.completed_at??j.created_at,revision:j.revision??j.source_revision??j.input_revision??null}))).sort((a,b)=>(b.created_at??0)-(a.created_at??0));}
  overview(){
    const users=this.users(),projects=this.projects(),assets=this.store.list('creator_asset'),jobs=this.jobs(),worlds=this.worlds();
    const issues=this.store.list('creator_inbox_item').filter(x=>x.status==='open'&&x.kind!=='decision'&&!['automatic_verification','automatic_completed','verification_request'].includes(x.code));
    return {at:Date.now(),counts:{users:users.length,online_users:users.filter(x=>x.online_connections>0).length,disabled_users:users.filter(x=>x.status==='disabled').length,projects:projects.length,active_projects:projects.filter(x=>x.status==='active').length,assets:assets.length,asset_bytes:assets.reduce((n,a)=>n+(a.bytes??0),0),running_worlds:worlds.filter(x=>x.status==='running').length,active_jobs:jobs.filter(x=>ACTIVE.has(x.status)).length,open_issues:issues.length},issues:issues.slice(0,8).map(x=>({id:x.id,source:x.source,kind:x.kind,severity:x.severity,project_id:x.project_id,updated_at:x.updated_at??x.occurred_at})),jobs:jobs.filter(x=>ACTIVE.has(x.status)).slice(0,8),worlds,audit:this.audit().slice(0,6),public_play:this.store.publicPlay};
  }
  audit(){return this.store.list('creator_admin_audit').sort((a,b)=>b.at-a.at);}
  mutate(user,action,target,input,fn){
    this.assert(user);identifier(input.request_id,'请求 ID');if(!Number.isSafeInteger(input.expected_version)||input.expected_version<1)fail(400,'需要当前对象版本');
    if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)fail(400,'请填写 1–500 字操作原因');
    const key=hash({user:user.id,request:input.request_id}),fingerprint=hash({action,target,input});
    return this.store.transaction(()=>{
      const previous=this.store.get('creator_admin_receipt',key);if(previous){if(previous.fingerprint!==fingerprint)fail(409,'请求 ID 已用于另一项操作');return {...clone(previous.result),replayed:true};}
      const result=fn();const audit={id:id('admin-event'),at:Date.now(),actor_id:user.id,actor_name:user.name,action,target_id:target,target_name:result.target_name,reason:input.reason.trim(),before:result.before,after:result.after,request_id:input.request_id};
      this.store.put('creator_admin_audit',audit);const response={ok:true,version:result.version,audit_id:audit.id,after:result.after};
      this.store.put('creator_admin_receipt',{id:key,fingerprint,result:response});return response;
    });
  }
  version(row,input,key='admin_version'){if((row[key]??1)!==input.expected_version)fail(409,'对象已变化，请刷新后重新检查操作');}
  revoke(uid){for(const kind of ['creator_login','creator_asset_cap','creator_admin_session','creator_build_access'])for(const row of this.store.list(kind))if(row.user_id===uid)this.store.remove(kind,row.id);}
  changedProjects(ids){for(const p of ids)this.service.observe(()=>this.service.collaborationChanged(p));}
  changeUser(user,uid,input){
    fields(input,['request_id','expected_version','reason','action','value']);
    const result=this.mutate(user,`user.${input.action}`,uid,input,()=>{
      const row=this.store.get('creator_user',uid);if(!row)fail(404,'账号不存在');this.version(row,input);
      if(input.action==='rename'){
        const before={name:row.name};this.store.renameAccount(row,input.value);
        return {target_name:row.name,before,after:{name:row.name},version:row.admin_version};
      }
      if(!['status','creation','revoke_sessions'].includes(input.action))fail(400,'未知账号操作');
      if(this.store.isAdmin(row))fail(409,'唯一管理员不能被禁用、限制或撤销登录');
      const before={status:row.disabled_at?'disabled':'active',creation_allowed:row.creation_allowed??null};
      if(input.action==='status'){if(!['active','disabled'].includes(input.value))fail(400,'账号状态无效');row.disabled_at=input.value==='disabled'?Date.now():null;if(row.disabled_at)this.revoke(uid);}
      if(input.action==='creation'){if(![true,false,null].includes(input.value))fail(400,'创作权限无效');row.creation_allowed=input.value;}
      if(input.action==='revoke_sessions')this.revoke(uid);
      row.admin_version=(row.admin_version??1)+1;this.store.put('creator_user',row);
      return {target_name:row.name,before,after:{status:row.disabled_at?'disabled':'active',creation_allowed:row.creation_allowed??null,...(input.action==='revoke_sessions'?{sessions_revoked:true}:{})},version:row.admin_version};
    });
    if(!result.replayed&&input.action==='rename')this.service.observe(()=>this.service.realtime.userUpdated(this.store.publicUser(this.store.get('creator_user',uid))));
    else if(!result.replayed){for(const c of this.service.realtime.connections.values())if(c.user?.id===uid){try{this.store.authenticate(c.token);}catch{c.ws.close(1008,'Authorization changed');}}this.changedProjects(this.store.list('creator_project').map(p=>p.id));}
    return result;
  }
  changeProject(user,pid,input){
    fields(input,['request_id','expected_version','reason','action','value','user_id']);
    const result=this.mutate(user,`project.${input.action}`,pid,input,()=>{
      const row=this.store.get('creator_project',pid);if(!row)fail(404,'游戏不存在');this.version(row,input,'permission_version');
      let before,after;
      if(input.action==='status'){if(!['active','archived'].includes(input.value))fail(400,'游戏状态无效');before={status:row.archived_at?'archived':'active'};row.archived_at=input.value==='archived'?Date.now():null;after={status:input.value};}
      else if(input.action==='public_play'){if(![true,false,null].includes(input.value))fail(400,'试玩权限无效');before={public_play:row.public_play??null};row.public_play=input.value;after={public_play:row.public_play};}
      else if(input.action==='name'){before={name:row.name};row.name=name(input.value);after={name:row.name};}
      else if(input.action==='member'){
        const uid=input.user_id,target=this.store.get('creator_user',uid);if(!target)fail(404,'账号不存在');
        if(target.disabled_at)fail(409,'请先恢复该账号');if(row.members[uid]==='owner')fail(409,'游戏拥有者受到保护，不能在此移除或降级');
        if(!['editor','viewer',null].includes(input.value))fail(400,'只能授予编辑、只读或移除成员');
        before={user_id:uid,role:row.members[uid]??null};
        if(input.value)row.members[uid]=input.value;else delete row.members[uid];
        if(input.value!=='editor')this.store.put('creator_permission_cutoff',{id:`${pid}:${uid}`,at:Date.now(),permission_version:(row.permission_version??1)+1});
        after={user_id:uid,role:input.value};
      }else fail(400,'未知游戏操作');
      row.permission_version=(row.permission_version??1)+1;this.store.put('creator_project',row);return {target_name:row.name,before,after,version:row.permission_version};
    });
    if(!result.replayed)this.changedProjects([pid]);return result;
  }
  changeAsset(user,aid,input){
    fields(input,['request_id','expected_version','reason','status']);
    const result=this.mutate(user,'asset.status',aid,input,()=>{
      const row=this.store.get('creator_asset',aid);if(!row)fail(404,'资产不存在');this.version(row,input);if(!['active','quarantined'].includes(input.status))fail(400,'资产状态无效');
      const before={status:row.quarantined_at?'quarantined':'active'};row.quarantined_at=input.status==='quarantined'?Date.now():null;row.admin_version=(row.admin_version??1)+1;this.store.put('creator_asset',row);
      return {target_name:row.name,before,after:{status:input.status},version:row.admin_version};
    });
    return result;
  }
  changeAi(user,target,input){
    fields(input,['request_id','expected_version','reason','limits']);
    const limits=new AiLimits(this.store);
    const result=this.mutate(user,'ai.limits',target,input,()=>{
      if(target!=='global'&&!this.store.get('creator_user',target))fail(404,'账号不存在');
      const before=limits.policy(target);if(before.version!==input.expected_version)fail(409,'限额已变化，请刷新后重试');
      const after={id:target,version:before.version+1,...limits.validate(input.limits)};this.store.put('creator_ai_policy',after);
      return {target_name:target==='global'?'全站 AI':this.store.get('creator_user',target).name,before,after,version:after.version};
    });
    this.service.agent?.enforceAiLimits();return result;
  }
  async request(req,res,path,body){
    if(path.length>3||path.some(x=>x.includes('/')))fail(404,'管理接口不存在');
    const [,area,target]=path;
    if(area==='access'&&req.method==='POST')return this.access(req,res);
    const user=this.auth(req);
    if(area==='logout'&&req.method==='POST')return this.logout(req,res);
    if(area==='session'&&req.method==='GET')return {user,sole_admin:true,market_admin_version:1,token_usage_version:1};
    if(area==='overview'&&req.method==='GET')return this.overview();
    const query=new URL(req.url,this.service.origin).searchParams;
    if(area==='token-usage'&&req.method==='GET'&&(!target||target==='overview'))return this.tokenUsage.view(query,Date.now(),target==='overview');
    if(area==='market')return this.market.request(req,target,query,user,body,page);
    if(area==='metrics'&&req.method==='GET')return this.metrics.view(query.get('range')??'1h');
    if(area==='ai'&&target&&req.method==='PATCH')return this.changeAi(user,target,await body());
    const readers={ai:()=>new AiLimits(this.store).rows(),users:()=>this.users(),projects:()=>this.projects(),assets:()=>this.assets(),jobs:()=>this.jobs(),audit:()=>this.audit(),worlds:()=>this.worlds()};
    if(Object.hasOwn(readers,area)&&req.method==='GET'){const rows=readers[area]();if(target){const item=rows.find(x=>x.id===target);if(!item)fail(404,'管理对象不存在');return {item};}return page(rows,query);}
    if(area==='users'&&target&&req.method==='PATCH')return this.changeUser(user,target,await body());
    if(area==='projects'&&target&&req.method==='PATCH')return this.changeProject(user,target,await body());
    if(area==='assets'&&target&&req.method==='PATCH')return this.changeAsset(user,target,await body());
    fail(404,'管理接口不存在');
  }
  close(){this.metrics.close();}
}
