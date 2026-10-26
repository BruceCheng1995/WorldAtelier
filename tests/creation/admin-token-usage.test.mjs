/** Independent accounting checks: disposable SQLite; no real Agent/Godot execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {AdminTokenUsage} from '../../services/creation/admin-token-usage.mjs';
import {AiLimits} from '../../services/creation/ai-limits.mjs';

const NOW=Date.parse('2026-10-26T04:00:00Z'),DAY=86400000;
const detail=(input,cache,output,reasoning=0)=>({totalTokens:input+output,inputTokens:input,cachedInputTokens:cache,outputTokens:output,reasoningOutputTokens:reasoning});
function fixture(t){
  const data=mkdtempSync(resolve(tmpdir(),'atelier-token-unit-')),store=new CreationStore(resolve(data,'state.sqlite'));
  t.after(()=>{store.close();rmSync(data,{recursive:true,force:true});});
  for(const [id,name]of [['u1','独立用户甲'],['u2','独立用户乙'],['empty-user','无报告用户']])store.put('creator_user',{id,name,created_at:NOW-2*DAY,password:'SECRET_PASSWORD'});
  for(const [id,name]of [['p1','独立游戏甲'],['p2','独立游戏乙'],['empty-game','无报告游戏']])store.put('creator_project',{id,name,members:{u1:'owner'},created_at:NOW-2*DAY});
  const session=(id,p='p1',u='u1',visibility='shared')=>store.put('creator_session',{id,project_id:p,owner_user_id:u,branch_id:'main',title:visibility==='private'?'SECRET_PRIVATE_TITLE':'创作会话 '+id,visibility,created_at:NOW-2*DAY});
  const run=(id,sid,thread,turns,p='p1',u='u1')=>store.put('creator_run',{id,session_id:sid,thread_id:thread,turn_id:turns.at(-1),turn_ids:turns,project_id:p,owner_user_id:u,branch_id:'main',status:'completed',created_at:NOW-2*DAY,model:'test-model',executor_goal_objective:'SECRET_PRIVATE_OBJECTIVE'});
  const event=(sid,thread,turn,total,last=total,at=NOW)=>store.db.prepare('INSERT INTO events(project_id,body) VALUES(?,?)').run('session:'+sid,JSON.stringify({kind:'notification',method:'thread/tokenUsage/updated',at,params:{threadId:thread,turnId:turn,tokenUsage:{total,last}}}));
  const ledger=(tokens,reports=1,p='p1',u='u1',at=NOW)=>{const day=new Date(at).toISOString().slice(0,10);return store.put('creator_ai_usage',{id:`${day}:${u}:${p}`,project_id:p,user_id:u,day,tokens,reports,updated_at:at});};
  const stats=new AdminTokenUsage(store),view=(params={})=>stats.view(new URLSearchParams({range:'all',limit:'100',...params}),NOW);
  return {data,store,session,run,event,ledger,stats,view};
}
test('four dimensions reconcile exactly; cache and reasoning are subsets, not extra charges',t=>{
  const f=fixture(t);f.session('s1');f.session('s2','p2','u2','private');f.run('r1','s1','t1',['a']);f.run('r2','s1','t1',['b','c']);f.run('r3','s2','t2',['a'],'p2','u2');
  f.event('s1','t1','a',detail(90,70,10,4));f.event('s1','t1','b',detail(260,200,40,12),detail(170,130,30,8));f.event('s1','t1','c',detail(340,260,60,18),detail(80,60,20,6));
  f.event('s2','t2','a',detail(450,300,50,20));f.ledger(400,3);f.ledger(500,1,'p2','u2');
  for(const dimension of ['game','user','session','task']){const v=f.view({dimension});assert.equal(v.summary.total_tokens,900);assert.equal(v.items.reduce((n,r)=>n+r.total_tokens,0),900);assert.equal(v.summary.reports,4);assert.equal(v.summary.non_cached_input_tokens,230);assert.equal(v.summary.cached_input_tokens,560);assert.equal(v.summary.output_tokens,110);assert.equal(v.summary.reasoning_output_tokens,38);assert.equal(v.summary.unknown_detail_tokens,0);assert.equal(v.summary.unassigned_task_tokens,0);}
  const tasks=f.view({dimension:'task'}).items;assert.equal(tasks.find(x=>x.id==='r1').total_tokens,100);assert.equal(tasks.find(x=>x.id==='r2').total_tokens,300);assert.equal(tasks.find(x=>x.id==='r2').reports,2);
  const text=JSON.stringify(f.view({dimension:'session'}));for(const secret of ['SECRET_PRIVATE_TITLE','SECRET_PASSWORD','SECRET_PRIVATE_OBJECTIVE'])assert.equal(text.includes(secret),false);assert.equal(f.view({dimension:'session'}).items.find(x=>x.id==='s2').name,'私有会话');
});
test('duplicate, stale, invalid and zero reports do not inflate the durable quota ledger',t=>{
  const f=fixture(t),session={...f.session('s1'),executor_thread_id:'t1'};f.run('r1','s1','t1',['a']);const limits=new AiLimits(f.store);
  for(const [total,last]of [[detail(900,500,100),detail(90,50,10)],[detail(900,500,100),detail(90,50,10)],[detail(800,400,100),detail(70,30,10)],[detail(990,550,110),detail(90,50,10)]]){f.event('s1','t1','a',total,last,Date.now());limits.record(session,{tokenUsage:{total,last}});}
  f.event('s1','t1','a',{totalTokens:-1},{totalTokens:1},Date.now());
  const v=f.stats.view(new URLSearchParams({range:'all'}));assert.equal(limits.usage().daily_tokens,200);assert.equal(v.summary.total_tokens,200);assert.equal(v.summary.non_cached_input_tokens,80);assert.equal(v.summary.reports,2);assert.equal(v.summary.unknown_detail_tokens,0);
});
test('history remainder stays unknown and all four dimensions preserve recorded totals',t=>{
  const f=fixture(t);f.session('s1');f.run('r1','s1','t1',['a']);f.event('s1','t1','a',detail(90,70,10));f.ledger(175,2);
  for(const dimension of ['game','user','session','task']){const v=f.view({dimension});assert.equal(v.summary.total_tokens,175);assert.equal(v.summary.detail_tokens,100);assert.equal(v.summary.unknown_detail_tokens,75);assert.equal(v.items.reduce((n,r)=>n+r.total_tokens,0),175);}
  const unknown=f.view({dimension:'task'}).items.find(x=>x.id==='unassigned');assert.equal(unknown.total_tokens,75);assert.equal(unknown.reports,1);
});
test('when event sums or report counts exceed ledger, whole bucket is unattributed',t=>{
  for(const [tokens,reports]of [[99,1],[100,0]]){const f=fixture(t);f.session('s1');f.run('r1','s1','t1',['a']);f.event('s1','t1','a',detail(90,70,10));f.ledger(tokens,reports);const v=f.view({dimension:'task'});assert.equal(v.summary.total_tokens,tokens);assert.equal(v.summary.unknown_detail_tokens,tokens);assert.equal(v.summary.unassigned_task_tokens,tokens);assert.equal(v.coverage.mismatched_buckets,1);assert.equal(v.items.find(x=>x.id==='r1').has_reports,false);}
});
test('missing classification is unknown; contradictory detailed counters never invent values',t=>{
  const f=fixture(t);f.session('s1');f.run('r1','s1','t1',['a']);f.event('s1','t1','a',{totalTokens:100},{totalTokens:100});f.event('s1','t1','a',{...detail(180,500,20),totalTokens:200},{...detail(90,70,10),reasoningOutputTokens:99});f.ledger(200,2);const v=f.view();assert.equal(v.summary.total_tokens,200);assert.equal(v.summary.detail_tokens,0);assert.equal(v.summary.unknown_detail_tokens,200);
});
test('a cross-task notification gap assigns only the known last amount to the new task',t=>{
  const f=fixture(t);f.session('s1');f.run('r1','s1','t1',['a']);f.run('r2','s1','t1',['b']);f.event('s1','t1','a',detail(90,70,10));f.event('s1','t1','b',detail(360,280,40),detail(90,70,10));f.ledger(400,2);const v=f.view({dimension:'task'});assert.equal(v.items.find(x=>x.id==='r1').total_tokens,100);assert.equal(v.items.find(x=>x.id==='r2').total_tokens,100);assert.equal(v.items.find(x=>x.id==='unassigned').total_tokens,200);assert.equal(v.summary.unassigned_task_tokens,200);assert.equal(v.summary.unknown_detail_tokens,0);
});
test('ambiguous or missing task identity never falls back to the latest run',t=>{
  const f=fixture(t);f.session('s1');f.run('r1','s1','t1',['a']);f.run('r2','s1','t1',['a']);f.event('s1','t1','a',detail(90,70,10));f.ledger(100);const v=f.view({dimension:'task'});assert.equal(v.items.find(x=>x.id==='unassigned').total_tokens,100);assert.equal(v.items.find(x=>x.id==='r2').has_reports,false);assert.equal(v.summary.unassigned_session_tokens,0);
});
test('UTC day boundary and recent comparison distinguish missing reports from zero',t=>{
  const f=fixture(t);f.ledger(200,1,'p1','u1',Date.parse('2026-10-25T23:59:59Z'));f.ledger(300,1,'p1','u1',Date.parse('2026-10-26T00:00:00Z'));f.ledger(100,1,'p1','u1',NOW-7*DAY);
  assert.equal(f.view({range:'today'}).summary.total_tokens,300);assert.equal(f.view({range:'7d'}).summary.total_tokens,500);assert.equal(f.view().recent.previous_tokens,100);assert.equal(f.view().recent.change_percent,400);assert.equal(f.view({range:'7d'}).trend.length,7);assert.equal(f.view({range:'all'}).trend.length,30);
  const later=f.stats.view(new URLSearchParams({range:'7d'}),NOW+7*DAY,true);assert.equal(later.recent.total_tokens,0);assert.equal(later.recent.reports,0);assert.equal(later.recent.change_percent,null);assert.equal(later.options,undefined);
});
test('combined scope filters, text search, pagination and ordering retain honest summaries',t=>{
  const f=fixture(t);for(let i=0;i<27;i++){f.session('s'+i);f.run('r'+i,'s'+i,'t'+i,['a']);f.event('s'+i,'t'+i,'a',detail(90+i,70,10));}f.ledger(27*100+26*27/2,27);
  const page=f.view({dimension:'session',game:'p1',user:'u1',limit:'10',page:'2'});assert.equal(page.items.length,10);assert.equal(page.total,27);assert.equal(page.pages,3);assert.equal(page.summary.total_tokens,3051);
  const searched=f.view({dimension:'session',q:'s26'});assert.equal(searched.items.length,1);assert.equal(searched.summary.total_tokens,3051);assert.equal(searched.items[0].total_tokens,126);
  const task=f.view({dimension:'task',session:'s26',game:'p1',user:'u1'});assert.equal(task.summary.total_tokens,126);assert.equal(task.items.length,1);assert.equal(task.items[0].id,'r26');
  for(const params of [{dimension:'bad'},{range:'bad'},{sort:'bad'}])assert.throws(()=>f.view(params),e=>e.status===400);
});
test('no reports remain distinguishable from reported zero and late task bindings can resolve',t=>{
  const f=fixture(t);f.session('s1');assert.equal(f.view().items.find(x=>x.id==='empty-game').has_reports,false);assert.equal(f.view().summary.last_report_at,null);
  f.event('s1','t1','a',detail(90,70,10));f.ledger(100);assert.equal(f.view({dimension:'task'}).summary.unassigned_task_tokens,100);f.run('r1','s1','t1',['a']);assert.equal(f.view({dimension:'task'}).summary.unassigned_task_tokens,0);
});
test('read-only projection is incremental, restart-stable, and never rewrites the quota ledger',t=>{
  const f=fixture(t);f.session('s1');f.run('r1','s1','t1',['a']);f.event('s1','t1','a',detail(90,70,10));f.ledger(100);f.view();
  f.event('s1','t1','a',detail(180,140,20),detail(90,70,10));f.ledger(200,2);const before=f.store.db.prepare('SELECT kind,id,body FROM documents ORDER BY kind,id').all();const expected=f.view();assert.equal(expected.summary.total_tokens,200);assert.deepEqual(f.view(),expected);
  const fresh=new AdminTokenUsage(f.store).view(new URLSearchParams({range:'all',limit:'100'}),NOW);assert.deepEqual(fresh,expected);assert.deepEqual(f.store.db.prepare('SELECT kind,id,body FROM documents ORDER BY kind,id').all(),before);
});
