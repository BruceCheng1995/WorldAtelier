import {fail} from './schema.mjs';

export const AI_DEFAULTS=Object.freeze({enabled:true,daily_runs:50,concurrent_runs:2,daily_tokens:1000000,max_run_minutes:60});
const GLOBAL={...AI_DEFAULTS,daily_runs:500,concurrent_runs:6,daily_tokens:10000000};
const terminal=new Set(['completed','failed','interrupted']);
export const aiActive=r=>!terminal.has(r.status)||(r.cleanup_status&&r.cleanup_status!=='verified');
const day=at=>new Date(at).toISOString().slice(0,10);
export class AiLimits {
  constructor(store){this.store=store;}
  policy(target='global'){return this.store.get('creator_ai_policy',target)??{id:target,version:1,...(target==='global'?GLOBAL:AI_DEFAULTS)};}
  validate(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==Object.keys(AI_DEFAULTS).length||Object.keys(value).some(k=>!Object.hasOwn(AI_DEFAULTS,k)))fail(400,'AI 限额字段无效');
    if(typeof value.enabled!=='boolean')fail(400,'AI 开关无效');
    for(const key of ['daily_runs','concurrent_runs','daily_tokens','max_run_minutes'])if(!Number.isSafeInteger(value[key])||value[key]<1||value[key]>(key==='max_run_minutes'?1440:1000000000))fail(400,'AI 限额必须为有效正整数');
    return value;
  }
  usage(uid=null,at=Date.now()){
    const runs=this.store.list('creator_run').filter(r=>!uid||r.owner_user_id===uid),today=day(at);
    const rows=this.store.list('creator_ai_usage').filter(r=>r.day===today&&(!uid||r.user_id===uid));
    return {daily_runs:runs.filter(r=>day(r.created_at)===today).length,concurrent_runs:runs.filter(aiActive).length,daily_tokens:rows.reduce((n,r)=>n+r.tokens,0),report_count:rows.reduce((n,r)=>n+r.reports,0),limited_runs:runs.filter(r=>r.ai_limit_reason&&day(r.created_at)===today).length};
  }
  assertStart(uid){
    const labels={daily_runs:'每日启动次数',concurrent_runs:'并发运行数',daily_tokens:'每日 token 用量'};
    for(const target of ['global',uid]){
      const policy=this.policy(target),usage=this.usage(target==='global'?null:uid);
      const scope=target==='global'?'全站':`账号「${this.store.get('creator_user',uid)?.name??uid}」`;
      if(!policy.enabled)fail(429,`AI ${scope}已被管理员暂停`,{code:'AI_DISABLED',target});
      for(const key of ['daily_runs','concurrent_runs','daily_tokens'])if(usage[key]>=policy[key]){
        const resetAt=key==='concurrent_runs'?null:Date.parse(day(Date.now()))+86400000;
        fail(429,`AI ${scope}${labels[key]}已达上限：已用 ${usage[key].toLocaleString('zh-CN')} / 上限 ${policy[key].toLocaleString('zh-CN')}。请在管理后台调整${target==='global'?'全站':scope}的对应限额。全站与账号限额同时生效。`,{code:'AI_LIMIT_REACHED',target,limit:key,usage:usage[key],maximum:policy[key],reset_at:resetAt});
      }
    }
  }
  reason(run){for(const target of ['global',run.owner_user_id]){const policy=this.policy(target),usage=this.usage(target==='global'?null:target);if(!policy.enabled)return 'AI 已被管理员暂停';if(usage.daily_tokens>=policy.daily_tokens)return 'AI 今日 token 用量达到上限';if(Date.now()-run.created_at>=policy.max_run_minutes*60000)return 'AI 单次运行时长达到上限';}return null;}
  record(session,params){
    const total=params.tokenUsage?.total?.totalTokens,last=params.tokenUsage?.last?.totalTokens;
    if(!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(last)||last<0||last>total)return;
    const key=session.executor_thread_id,old=this.store.get('creator_ai_counter',key);
    // High water mark makes duplicate/out-of-order notifications idempotent.
    // First observation only attributes the last reported turn, not old thread history.
    const delta=old?Math.max(0,total-old.total):last;
    this.store.transaction(()=>{
      this.store.put('creator_ai_counter',{id:key,total:Math.max(old?.total??0,total)});
      if(!delta)return;
      const today=day(Date.now()),id=`${today}:${session.owner_user_id}:${session.project_id}`,row=this.store.get('creator_ai_usage',id)??{id,day:today,user_id:session.owner_user_id,project_id:session.project_id,tokens:0,reports:0};
      row.tokens+=delta;row.reports++;row.updated_at=Date.now();this.store.put('creator_ai_usage',row);
    });
  }
  rows(){return [{...this.policy(),name:'全站 AI 总额度',usage:this.usage()},...this.store.list('creator_user').map(u=>({...this.policy(u.id),name:u.name,usage:this.usage(u.id)}))];}
}
