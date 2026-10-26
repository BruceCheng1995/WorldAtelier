/** Independent HTTP/browser verification with disposable data, no paid AI or Godot. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';

const root=resolve(import.meta.dirname,'../..'),port=48921,origin=`http://127.0.0.1:${port}`;
const probe=createServer();await new Promise((ok,no)=>{probe.once('error',no);probe.listen(port,'127.0.0.1',ok);});await new Promise(ok=>probe.close(ok));
const data=mkdtempSync(resolve(tmpdir(),'atelier-token-browser-')),evidence=resolve(root,'.local/creation-verification/admin-token-usage-browser',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(evidence,{recursive:true});
const store=new CreationStore(resolve(data,'creation/creation.sqlite')),credentials={name:'独立用量检查员',password:randomUUID()},owner=store.register(credentials),guest=store.register({name:'无管理权限',password:randomUUID()});
store.put('creator_admin_settings',{id:'singleton',owner_user_id:owner.user.id});
const now=Date.now(),DAY=86400000,day=at=>new Date(at).toISOString().slice(0,10);
for(const [id,name]of [['p1','甲游戏：独立核对'],['p2','乙游戏：历史未知'],['empty-game','无报告游戏']])store.put('creator_project',{id,name,members:{[owner.user.id]:'owner'},created_at:now});
function record(i,extra=0){
  const total=100+i+extra,at=Date.now();
  store.put('creator_session',{id:'s'+i,project_id:'p1',branch_id:'main',owner_user_id:owner.user.id,title:i===0?'PRIVATE_TITLE_SENTINEL':'独立会话 '+i,visibility:i===0?'private':'shared',executor_thread_id:'thread'+i,created_at:now,updated_at:now});
  store.put('creator_run',{id:'r'+i,session_id:'s'+i,thread_id:'thread'+i,turn_id:'turn'+i,turn_ids:['turn'+i],project_id:'p1',owner_user_id:owner.user.id,branch_id:'main',created_at:now,status:'completed',model:'independent-fixture',executor_goal_objective:'PRIVATE_OBJECTIVE_SENTINEL'});
  store.db.prepare('INSERT INTO events(project_id,body) VALUES(?,?)').run('session:s'+i,JSON.stringify({kind:'notification',method:'thread/tokenUsage/updated',at,params:{threadId:'thread'+i,turnId:'turn'+i,tokenUsage:{total:{totalTokens:total,inputTokens:90+i+extra,cachedInputTokens:70,outputTokens:10,reasoningOutputTokens:3},last:{totalTokens:extra||total,inputTokens:extra||90+i,cachedInputTokens:extra?0:70,outputTokens:extra?0:10,reasoningOutputTokens:extra?0:3}}}}));
}
for(let i=0;i<27;i++)record(i);
const ledger=(p,u,tokens,reports,at=now)=>store.put('creator_ai_usage',{id:`${day(at)}:${u}:${p}`,day:day(at),user_id:u,project_id:p,tokens,reports,updated_at:at});
ledger('p1',owner.user.id,3051,27);ledger('p2',guest.user.id,900,1);ledger('p1',owner.user.id,1000,1,now-7*DAY);
const report={origin,scope:'Independent Chrome headless + real isolated HTTP/SQLite. Explicit token/run fixtures only; no paid AI or Godot execution.',cases:[],console_errors:[],completed:false};
let child,browser,page,serverLog='';const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function api(path,actor=owner){const res=await fetch(origin+'/creation-api'+path,{headers:actor?{Authorization:'Bearer '+actor.token}:{}});const value=await res.json();return {status:res.status,value};}
async function check(name,fn){await fn();report.cases.push({name,status:'passed'});console.log('PASS '+name);}
async function changed(action){const got=page.waitForResponse(r=>r.url().startsWith(origin+'/creation-api/admin/token-usage?')&&r.ok());await action();await got;await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);}
async function refresh(){await changed(()=>page.getByRole('button',{name:'刷新数据',exact:true}).click());}
try{
  const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'};delete env.WORLD_ATELIER_ADMIN_USER_ID;
  child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>serverLog+=b);child.stderr.on('data',b=>serverLog+=b);
  for(let i=0;i<160;i++){if(child.exitCode!==null)throw Error(serverLog);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  await check('real endpoints reject anonymous and ordinary accounts and gate the frontend module',async()=>{
    for(const suffix of ['', '/overview']){assert.equal((await api('/admin/token-usage'+suffix,null)).status,401);assert.equal((await api('/admin/token-usage'+suffix,guest)).status,403);assert.equal((await api('/admin/token-usage'+suffix)).status,200);}
    assert.ok([401,403].includes((await fetch(origin+'/admin-assets/admin-token-usage.js')).status));assert.equal((await api('/admin/token-usage?dimension=bad')).status,400);assert.equal((await api('/admin/session')).value.token_usage_version,1);
  });
  browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();const context=await browser.newContext({viewport:{width:1440,height:1100}});page=await context.newPage();page.on('pageerror',e=>report.console_errors.push(e.message));
  await page.goto(origin+'/admin');await page.getByLabel('账号名称').fill(credentials.name);await page.getByLabel('密码',{exact:true}).fill(credentials.password);await page.getByRole('button',{name:'登录管理后台'}).click();await page.locator('.token-recent').waitFor();
  await check('overview shows recent sum, comparison, lifetime, ranks and trend from real endpoint',async()=>{
    const v=(await api('/admin/token-usage/overview')).value;assert.equal(v.recent.total_tokens,3951);assert.equal(v.lifetime.total_tokens,4951);assert.equal(v.recent.previous_tokens,1000);assert.equal(v.recent.change_percent,295.1);
    assert.equal(await page.locator('.token-recent-main > strong').innerText(),'3,951');assert.match(await page.locator('.token-recent-main').innerText(),/4,951/);assert.match(await page.locator('.token-recent-main').innerText(),/295.1%/);assert.equal(await page.locator('.token-recent .token-bars button').count(),7);assert.match(await page.locator('.token-recent').innerText(),/甲游戏/);await page.screenshot({path:resolve(evidence,'overview-desktop.png'),fullPage:true});
    for(const width of [390,360]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,width+'px overview overflow');await page.screenshot({path:resolve(evidence,`overview-${width}px.png`),fullPage:true});}await page.setViewportSize({width:1440,height:1100});
  });
  await changed(()=>page.locator('#tokenOverviewLink').click());
  await check('all four independent dimensions reconcile and exact cache/output fields remain readable',async()=>{
    for(const [dimension,label]of [['game','游戏'],['user','用户'],['session','会话'],['task','任务']]){
      if(dimension!=='game')await changed(()=>page.getByRole('button',{name:'按'+label,exact:true}).click());
      const v=(await api('/admin/token-usage?range=7d&limit=100&dimension='+dimension)).value;assert.equal(v.summary.total_tokens,3951);assert.equal(v.items.reduce((n,r)=>n+r.total_tokens,0),3951);assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'3,951');
      assert.match(await page.locator('.token-dashboard').innerText(),/900 token 缺少分类明细/);assert.equal(await page.getByRole('button',{name:'按'+label,exact:true}).getAttribute('aria-pressed'),'true');
      const text=JSON.stringify(v);assert.equal(text.includes('PRIVATE_TITLE_SENTINEL'),false);assert.equal(text.includes('PRIVATE_OBJECTIVE_SENTINEL'),false);
    }
    assert.equal(await page.locator('.token-table tbody tr').count(),25);assert.match(await page.locator('.pagination').innerText(),/28 条/);await changed(()=>page.getByRole('button',{name:'下一页',exact:true}).click());assert.equal(await page.locator('.token-table tbody tr').count(),3);assert.match(await page.locator('.pagination').innerText(),/2 \/ 2/);
  });
  await check('filter and drilldown select game, user, session and task without double counting',async()=>{
    await changed(()=>page.getByRole('button',{name:'按游戏',exact:true}).click());await changed(()=>page.locator('tr').filter({hasText:'甲游戏：独立核对'}).getByRole('button',{name:'查看会话 →'}).click());
    assert.equal(await page.locator('#tokenGame').inputValue(),'p1');assert.equal(await page.getByRole('button',{name:'按会话',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'3,051');
    await changed(()=>page.locator('#tokenUser').selectOption(owner.user.id));await changed(()=>page.locator('#search').fill('s26'));assert.equal(await page.locator('.token-table tbody tr').count(),1);assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'3,051');
    await changed(()=>page.getByRole('button',{name:'查看任务 →',exact:true}).click());assert.match(await page.locator('.token-filter-chip').innerText(),/s26/);assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'126');assert.equal(await page.locator('.token-table tbody tr').count(),1);assert.match(await page.locator('.token-table tbody').innerText(),/r26/);
    await changed(()=>page.getByRole('button',{name:'清除筛选',exact:true}).click());await changed(()=>page.locator('#tokenRange').selectOption('all'));assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'4,951');assert.equal(await page.locator('.token-bars button').count(),30);
  });
  await check('empty scope and no-match search clearly separate absent reports from zero usage',async()=>{
    await changed(()=>page.getByRole('button',{name:'按游戏',exact:true}).click());await changed(()=>page.locator('#tokenGame').selectOption('empty-game'));assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'暂无报告');assert.match(await page.locator('.token-table tbody').innerText(),/无报告游戏/);assert.match(await page.locator('.token-table tbody').innerText(),/暂无报告/);
    await changed(()=>page.locator('#search').fill('does-not-exist'));assert.match(await page.locator('.token-table tbody').innerText(),/没有匹配的记录/);assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'暂无报告');
    await changed(()=>page.getByRole('button',{name:'清除筛选',exact:true}).click());await changed(()=>page.locator('#tokenRange').selectOption('7d'));
  });
  await check('refresh observes a newly persisted cumulative report without duplicate counting',async()=>{
    record(26,100);ledger('p1',owner.user.id,3151,28);await refresh();assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'4,051');await refresh();assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'4,051');
    assert.equal((await api('/admin/token-usage?range=7d&dimension=task&session=s26')).value.summary.total_tokens,226);await page.screenshot({path:resolve(evidence,'detail-desktop.png'),fullPage:true});
  });
  await check('isolated service restart rebuilds the same dimensions from persisted events and ledger',async()=>{
    const before=(await api('/admin/token-usage?range=all&dimension=task&limit=100')).value;
    const stopped=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');await stopped;
    child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>serverLog+=b);child.stderr.on('data',b=>serverLog+=b);
    for(let i=0;i<160;i++){if(child.exitCode!==null)throw Error(serverLog);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
    const after=(await api('/admin/token-usage?range=all&dimension=task&limit=100')).value;assert.deepEqual(after.summary,before.summary);assert.deepEqual(after.items,before.items);
    await page.reload();await page.locator('.token-dashboard').waitFor();assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'4,051');
  });
  await check('keyboard trend inspection and mobile layout preserve content without page overflow',async()=>{
    await page.locator('.token-bar').last().focus();assert.match(await page.locator('.token-bar').last().getAttribute('aria-label'),/4,051 token/);
    for(const width of [390,360]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,width+'px document overflow');assert.equal(await page.locator('.token-table').evaluate(el=>el.parentElement.scrollWidth>el.parentElement.clientWidth),true);await page.screenshot({path:resolve(evidence,`detail-${width}px.png`),fullPage:true});}
    await page.setViewportSize({width:1440,height:1100});
  });
  await check('overview ranking links reach the matching detailed filter',async()=>{
    await page.goto(origin+'/admin#/overview');await page.locator('.token-recent').waitFor();await changed(()=>page.locator('.token-recent [data-token-drill="game"][data-token-id="p1"]').click());assert.equal(await page.locator('#tokenGame').inputValue(),'p1');assert.equal(await page.getByRole('button',{name:'按会话',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.token-stats .stat-value').first().innerText(),'3,151');
  });
  await check('overview with no retained usage reports stays unknown instead of claiming zero',async()=>{
    for(const row of store.list('creator_ai_usage'))store.remove('creator_ai_usage',row.id);
    await page.goto(origin+'/admin#/overview');await page.locator('.token-recent').waitFor();assert.equal(await page.locator('.token-recent-main > strong').innerText(),'暂无报告');assert.match(await page.locator('.token-recent-main').innerText(),/近期无报告，暂不计算变化/);assert.equal(await page.locator('.token-recent .token-bar.reported').count(),0);
  });
  assert.deepEqual(report.console_errors,[]);report.completed=true;
}catch(error){report.error=error.stack;throw error;}
finally{await browser?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');for(let i=0;i<100&&child.exitCode===null;i++)await wait(30);if(child.exitCode===null)child.kill('SIGKILL');}store.close();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));writeFileSync(resolve(evidence,'server.log'),serverLog);rmSync(data,{recursive:true,force:true});console.log('Evidence '+evidence);}
