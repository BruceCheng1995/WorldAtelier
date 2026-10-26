import {fail} from './schema.mjs';

const DAY=86400000,day=at=>new Date(at).toISOString().slice(0,10);
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const detailKeys=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'];
const counterKeys=['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'];
const blank=()=>({total_tokens:0,input_tokens:0,cached_input_tokens:0,non_cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,detail_tokens:0,unknown_detail_tokens:0,reports:0,unassigned_session_tokens:0,unassigned_task_tokens:0,last_report_at:null});
function breakdown(value,total){
  if(!value||!counterKeys.every(k=>valid(value[k]))||value.inputTokens+value.outputTokens!==total||value.cachedInputTokens>value.inputTokens||value.reasoningOutputTokens>value.outputTokens)return null;
  return Object.fromEntries(detailKeys.map((k,i)=>[k,value[counterKeys[i]]]));
}
function subtract(a,b,total){
  if(!a||!b)return null;
  const result=Object.fromEntries(detailKeys.map(k=>[k,a[k]-b[k]]));
  return breakdown(Object.fromEntries(counterKeys.map((k,i)=>[k,result[detailKeys[i]]])),total);
}
function add(to,row){
  to.total_tokens+=row.tokens;to.reports+=row.reports;
  if(row.details){for(const key of detailKeys)to[key]+=row.details[key];to.non_cached_input_tokens+=row.details.input_tokens-row.details.cached_input_tokens;to.detail_tokens+=row.tokens;}
  else to.unknown_detail_tokens+=row.tokens;
  if(!row.session_id)to.unassigned_session_tokens+=row.tokens;
  if(!row.task_id)to.unassigned_task_tokens+=row.tokens;
  to.last_report_at=Math.max(to.last_report_at??0,row.at??0)||null;
}
const sum=rows=>{const result=blank();for(const row of rows)add(result,row);return result;};
const keyOf=row=>JSON.stringify([row.day,row.user_id,row.project_id]);
const mapById=rows=>new Map(rows.map(r=>[r.id,r]));
function metadata(store,kind,keys){
  return store.db.prepare(`SELECT ${keys.map(k=>`json_extract(body,'$.${k}') AS ${k}`).join(',')} FROM documents WHERE kind=?`).all(kind).map(row=>({...row,...(row.turn_ids?{turn_ids:JSON.parse(row.turn_ids)}:{})}));
}

// Read-only projection. The quota ledger remains the source of recorded totals.
// Retained notifications supply detail; absent or inconsistent history is visible
// as an unattributed remainder, never charged again or guessed from the latest run.
export class AdminTokenUsage {
  constructor(store){this.store=store;this.cursor=0;this.counters=new Map();this.increments=[];}
  readEvents(){
    const end=this.store.db.prepare('SELECT MAX(sequence) AS value FROM events').get().value??0;
    if(end<this.cursor){this.cursor=0;this.counters.clear();this.increments=[];}
    if(end===this.cursor)return;
    const rows=this.store.db.prepare(`SELECT sequence,project_id,body FROM events WHERE sequence>? AND sequence<=? AND instr(body,'"thread/tokenUsage/updated"')>0 ORDER BY sequence`).iterate(this.cursor,end);
    for(const row of rows){
      const event=JSON.parse(row.body),p=event.params,u=p?.tokenUsage,total=u?.total?.totalTokens,last=u?.last?.totalTokens;
      if(event.method!=='thread/tokenUsage/updated'||event.kind!=='notification'||!p.threadId||!valid(total)||!valid(last)||last>total||!valid(event.at)||!row.project_id.startsWith('session:'))continue;
      const old=this.counters.get(p.threadId),delta=old?Math.max(0,total-old.total):last;
      if(old&&total<=old.total)continue;
      const full=breakdown(u.total,total),lastDetails=breakdown(u.last,last);
      const details=!old?lastDetails:subtract(full,old.details,delta)??(delta===last?lastDetails:null);
      this.counters.set(p.threadId,{total,details:full,turn_id:p.turnId,session_id:row.project_id.slice(8)});
      if(delta)this.increments.push({at:event.at,day:day(event.at),session_id:row.project_id.slice(8),thread_id:p.threadId,turn_id:p.turnId,previous_turn_id:old?.turn_id,previous_session_id:old?.session_id,tokens:delta,last_tokens:last,details,last_details:lastDetails,reports:1});
    }
    this.cursor=end;
  }
  snapshot(){
    this.readEvents();
    const projects=metadata(this.store,'creator_project',['id','name','created_at']);
    const users=metadata(this.store,'creator_user',['id','name','created_at']);
    const sessions=metadata(this.store,'creator_session',['id','project_id','branch_id','owner_user_id','title','visibility','created_at']);
    const runs=metadata(this.store,'creator_run',['id','project_id','branch_id','owner_user_id','session_id','thread_id','turn_id','turn_ids','status','model','execution_mode','created_at']);
    const sessionMap=mapById(sessions),turns=new Map();
    for(const run of runs)for(const turn of new Set([run.turn_id,...(run.turn_ids??[])].filter(Boolean))){const key=JSON.stringify([run.thread_id,turn]);turns.set(key,turns.has(key)?null:run);}
    const buckets=new Map();
    for(const e of this.increments){
      const session=sessionMap.get(e.session_id);if(!session)continue;
      const run=turns.get(JSON.stringify([e.thread_id,e.turn_id]));
      const matched=run?.session_id===session.id&&run.project_id===session.project_id&&run.owner_user_id===session.owner_user_id?run:null;
      const previous=turns.get(JSON.stringify([e.thread_id,e.previous_turn_id]));
      const base={...e,project_id:session.project_id,user_id:session.owner_user_id,task_id:null};
      const key=keyOf(base);if(!buckets.has(key))buckets.set(key,[]);const bucket=buckets.get(key);
      if(matched&&(e.tokens===e.last_tokens||previous?.id===matched.id&&e.previous_session_id===e.session_id))bucket.push({...base,task_id:matched.id});
      else if(matched&&e.last_tokens>0&&e.last_tokens<e.tokens){
        bucket.push({...base,tokens:e.last_tokens,details:e.last_details,task_id:matched.id});
        bucket.push({...base,tokens:e.tokens-e.last_tokens,details:subtract(e.details,e.last_details,e.tokens-e.last_tokens),reports:0});
      }else bucket.push(base);
    }
    const entries=[];let mismatchedBuckets=0;
    for(const ledger of this.store.list('creator_ai_usage')){
      if(!valid(ledger.tokens)||!/^\d{4}-\d{2}-\d{2}$/.test(ledger.day))continue;
      const candidates=buckets.get(keyOf(ledger))??[],known=candidates.reduce((n,e)=>n+e.tokens,0);
      // A missing prefix or changed history cannot be allocated proportionally.
      // Keep the complete ledger bucket unattributed if reconstruction exceeds it.
      const consistent=known<=ledger.tokens&&candidates.reduce((n,e)=>n+e.reports,0)<=(ledger.reports??0);if(!consistent)mismatchedBuckets++;
      if(consistent)entries.push(...candidates);
      const remainder=ledger.tokens-(consistent?known:0),reports=Math.max(0,(ledger.reports??0)-(consistent?candidates.reduce((n,e)=>n+e.reports,0):0));
      if(remainder||reports)entries.push({day:ledger.day,project_id:ledger.project_id,user_id:ledger.user_id,session_id:null,task_id:null,tokens:remainder,details:null,reports,at:ledger.updated_at??null});
    }
    return {entries,projects,users,sessions,runs,mismatchedBuckets};
  }
  groups(snapshot,entries,dimension,filters={}){
    const {projects,users,sessions,runs}=snapshot,p=mapById(projects),u=mapById(users),s=mapById(sessions),r=mapById(runs);
    const sessionName=session=>session?.visibility==='private'?'私有会话':session?.title??'会话记录已缺失';
    const nameFor=(id,map,fallback)=>map.get(id)?.name??fallback;
    const field={game:'project_id',user:'user_id',session:'session_id',task:'task_id'}[dimension];
    const groups=new Map(),get=(id)=>{
      const key=id??'unassigned';if(groups.has(key))return groups.get(key);
      const entity={game:p,user:u,session:s,task:r}[dimension].get(id);
      const item={id:key,name:id?dimension==='game'?nameFor(id,p,'游戏记录已缺失'):dimension==='user'?nameFor(id,u,'账号记录已缺失'):dimension==='session'?sessionName(entity):'创作任务 '+id:'未归属'+({game:'游戏',user:'用户',session:'会话',task:'任务'}[dimension]),...blank(),project_id:entity?.project_id??null,user_id:entity?.owner_user_id??null,session_id:dimension==='session'?id:entity?.session_id??null,branch_id:entity?.branch_id??null,status:entity?.status??null,model:entity?.model??null,created_at:entity?.created_at??null,games:new Set(),users:new Set(),sessions:new Set(),tasks:new Set()};
      groups.set(key,item);return item;
    };
    for(const row of entries){const item=get(row[field]);add(item,row);for(const [key,field]of [['games','project_id'],['users','user_id'],['sessions','session_id'],['tasks','task_id']])if(row[field])item[key].add(row[field]);}
    // Include real entities without reports. A missing report is not zero usage.
    for(const entity of {game:projects,user:users,session:sessions,task:runs}[dimension]){
      const matches=(!filters.game||(dimension==='game'?entity.id===filters.game:entity.project_id===filters.game))&&(!filters.user||(dimension==='user'?entity.id===filters.user:entity.owner_user_id===filters.user))&&(!filters.session||(dimension==='session'?entity.id===filters.session:entity.session_id===filters.session));
      if(matches)get(entity.id);
    }
    return [...groups.values()].map(item=>({...item,project_name:item.project_id?nameFor(item.project_id,p,'游戏记录已缺失'):null,user_name:item.user_id?nameFor(item.user_id,u,'账号记录已缺失'):null,session_name:item.session_id?sessionName(s.get(item.session_id)):null,...Object.fromEntries(['games','users','sessions','tasks'].map(key=>[key+'_count',item[key].size])),games:undefined,users:undefined,sessions:undefined,tasks:undefined,has_reports:item.reports>0||item.total_tokens>0}));
  }
  view(query=new URLSearchParams(),now=Date.now(),overview=false){
    const dimension=query.get('dimension')??'game',range=query.get('range')??'7d';
    if(!['game','user','session','task'].includes(dimension)||!['today','7d','30d','all'].includes(range))fail(400,'用量统计维度或时段无效');
    const snapshot=this.snapshot(),today=Date.parse(day(now)),days={today:1,'7d':7,'30d':30,all:Infinity}[range];
    const filters=Object.fromEntries(['game','user','session'].map(key=>[key,query.get(key)??'']));
    const entries=snapshot.entries.filter(e=>(!filters.game||e.project_id===filters.game)&&(!filters.user||e.user_id===filters.user)&&(!filters.session||e.session_id===filters.session));
    const selected=entries.filter(e=>e.day>=day(Number.isFinite(days)?today-(days-1)*DAY:0)&&e.day<=day(now));
    const periodSummary=sum(selected),lifetime=sum(entries),last7=entries.filter(e=>e.day>=day(today-6*DAY)&&e.day<=day(now)),previous7=entries.filter(e=>e.day>=day(today-13*DAY)&&e.day<day(today-6*DAY));
    const recent=sum(last7),previous=sum(previous7);
    const trendDays=Number.isFinite(days)?days:30,trend=[];
    for(let i=trendDays-1;i>=0;i--){const date=day(today-i*DAY);trend.push({day:date,...sum(entries.filter(e=>e.day===date))});}
    const rank=dim=>this.groups(snapshot,last7,dim,filters).filter(x=>x.has_reports).sort((a,b)=>b.total_tokens-a.total_tokens||a.id.localeCompare(b.id)).slice(0,3);
    const result={at:now,dimension,range,filters,summary:periodSummary,lifetime,recent:{...recent,previous_tokens:previous.total_tokens,previous_reports:previous.reports,change_percent:previous.total_tokens>0&&(recent.reports>0||recent.total_tokens>0)?(recent.total_tokens-previous.total_tokens)/previous.total_tokens*100:null,top_games:rank('game'),top_users:rank('user')},trend,coverage:{first_day:entries.map(e=>e.day).sort()[0]??null,mismatched_buckets:snapshot.mismatchedBuckets},options:{games:snapshot.projects.map(p=>({id:p.id,name:p.name})),users:snapshot.users.map(u=>({id:u.id,name:u.name}))}};
    if(overview)return {...result,options:undefined};
    const sort=query.get('sort')??'total_tokens',allowed=['total_tokens','non_cached_input_tokens','cached_input_tokens','output_tokens','last_report_at'];if(!allowed.includes(sort))fail(400,'用量排序无效');
    const q=(query.get('q')??'').trim().toLowerCase();
    let rows=this.groups(snapshot,selected,dimension,filters);if(q)rows=rows.filter(r=>[r.id,r.name,r.project_name,r.project_id,r.user_name,r.user_id,r.session_name,r.session_id,r.branch_id].some(v=>String(v??'').toLowerCase().includes(q)));
    rows.sort((a,b)=>(b[sort]??0)-(a[sort]??0)||a.id.localeCompare(b.id));
    const limit=Math.min(100,Math.max(1,Math.floor(Number(query.get('limit'))||25))),pages=Math.max(1,Math.ceil(rows.length/limit)),page=Math.min(pages,Math.max(1,Math.floor(Number(query.get('page'))||1)));
    return {...result,sort,total:rows.length,page,pages,limit,items:rows.slice((page-1)*limit,page*limit)};
  }
}
