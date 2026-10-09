import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';
import {AiLimits} from '../../services/creation/ai-limits.mjs';

// Disposable SQLite fixtures are read through the real admin HTTP endpoint.
// No production identities/data, Agent execution, or Godot process is used.
const root=resolve(import.meta.dirname,'../..'),port=48921,origin=`http://127.0.0.1:${port}`;
const probe=createServer();await new Promise((ok,no)=>{probe.once('error',no);probe.listen(port,'127.0.0.1',ok);});await new Promise(ok=>probe.close(ok));
const data=mkdtempSync(resolve(tmpdir(),'atelier-admin-overview-tokens-'));
const evidence=resolve(root,'.local/creation-verification/admin-overview-tokens-browser',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(evidence,{recursive:true});
const database=resolve(data,'creation/creation.sqlite'),credentials={name:'Token 总览检查员',password:randomUUID()};
const store=new CreationStore(database),owner=store.register(credentials);store.put('creator_admin_settings',{id:'singleton',owner_user_id:owner.user.id});
const baseline={enabled:true,daily_runs:10,concurrent_runs:2,daily_tokens:1000000,max_run_minutes:60};
const report={origin,scope:'Independent headless Chrome; real admin HTTP/SQLite integration with explicitly seeded disposable token/run fixtures. No paid AI or Godot execution.',cases:[],completed:false};
let child,browser,page,serverLog='',policyVersion=0;
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function api(path){const res=await fetch(origin+'/creation-api'+path,{headers:{Authorization:'Bearer '+owner.token}});assert.equal(res.ok,true,await res.clone().text());return res.json();}
function seed({tokens=null,reports=1,runs=1,active=0,limited=0,policy={}}={}){
  store.transaction(()=>{
    for(const kind of ['creator_ai_usage','creator_ai_counter','creator_run'])for(const row of store.list(kind))store.remove(kind,row.id);
    store.put('creator_ai_policy',{id:'global',version:++policyVersion,...baseline,...policy});
    for(let i=0;i<runs;i++)store.put('creator_run',{id:'fixture-run-'+i,owner_user_id:owner.user.id,project_id:'test-project',branch_id:'main',created_at:Date.now(),status:i<active?'running':'completed',cleanup_status:'verified',...(i<limited?{ai_limit_reason:'Independent token limit fixture'}:{})});
  });
  if(tokens!==null)new AiLimits(store).record({executor_thread_id:'test-thread',owner_user_id:owner.user.id,project_id:'test-project'},{tokenUsage:{total:{totalTokens:tokens},last:{totalTokens:tokens}}});
  for(const row of store.list('creator_ai_usage'))store.put('creator_ai_usage',{...row,reports});
}
async function check(name,fn){await fn();report.cases.push({name,status:'passed'});console.log('PASS '+name);}
async function refresh(){const response=page.waitForResponse(r=>r.url()===origin+'/creation-api/admin/ai/global'&&r.ok());await page.getByRole('button',{name:'刷新数据',exact:true}).click();await response;await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);}
try{
  seed({runs:0});
  const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'};delete env.WORLD_ATELIER_ADMIN_USER_ID;
  child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>serverLog+=b);child.stderr.on('data',b=>serverLog+=b);
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(serverLog);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1500,height:1100}});page=await context.newPage();const errors=[];report.console_errors=errors;
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/admin');await page.getByLabel('账号名称').fill(credentials.name);await page.getByLabel('密码',{exact:true}).fill(credentials.password);await page.getByRole('button',{name:'登录管理后台'}).click();
  await page.locator('.ai-overview').waitFor();const panel=page.locator('.ai-overview');
  await check('real endpoint with no reports shows unknown usage and remaining capacity',async()=>{
    const {item}=await api('/admin/ai/global');assert.equal(item.usage.report_count,0);assert.equal(item.usage.daily_tokens,0);
    assert.equal(await panel.locator('.ai-token-value').innerText(),'暂无报告');assert.equal(await panel.getByRole('progressbar').count(),0);
    assert.equal(await panel.locator('.ai-token-facts dd').first().innerText(),'—');assert.match(await panel.innerText(),/暂无报告不代表零用量/);assert.match(await panel.locator('.ai-startup').innerText(),/全站允许启动/);
    await page.screenshot({path:resolve(evidence,'no-reports-desktop.png'),fullPage:true});
  });
  await check('normal usage matches persisted reports and actual admin HTTP values',async()=>{
    seed({tokens:123456,reports:3,runs:3,active:1,limited:1});await refresh();const {item}=await api('/admin/ai/global');report.normal_api=item;
    assert.equal(item.usage.daily_tokens,123456);assert.equal(item.usage.report_count,3);assert.match(await panel.locator('.ai-token-value').innerText(),/123,456/);
    assert.match(await panel.locator('.ai-token-facts').innerText(),/876,544/);assert.match(await panel.locator('.ai-token-facts').innerText(),/3\s*次/);
    assert.match(await panel.innerText(),/额度充足/);assert.match(await panel.innerText(),/北京时间 08:00/);assert.match(await panel.innerText(),/含缓存输入/);
    assert.match(await panel.getByRole('progressbar').getAttribute('aria-valuetext'),/12.3%/);
    await page.screenshot({path:resolve(evidence,'normal-desktop.png'),fullPage:true});
  });
  await check('token warning boundary and exact/over-limit states retain honest totals',async()=>{
    for(const [tokens,label]of [[799999,'额度充足'],[800000,'接近上限'],[1000000,'已达上限'],[1250000,'已达上限']]){
      seed({tokens});await refresh();assert.match(await panel.locator('.ai-token-heading').first().innerText(),new RegExp(label));
      assert.equal(await panel.getByRole('progressbar').getAttribute('aria-valuenow'),String(Math.min(100,tokens/1000000*100)));
      if(tokens>=1000000){assert.match(await panel.locator('.ai-startup').innerText(),/新任务受限/);assert.match(await panel.locator('.ai-startup').innerText(),/token 已达上限/);assert.equal(await panel.locator('.ai-token-facts dd').first().innerText(),'0');}
      else assert.match(await panel.locator('.ai-startup').innerText(),/全站允许启动/);
      assert.equal((await panel.locator('.ai-token-facts').innerText()).includes('超出上限'),tokens>1000000);
    }
    assert.match(await panel.locator('.ai-token-facts').innerText(),/250,000/);assert.match(await panel.getByRole('progressbar').getAttribute('aria-valuetext'),/125.0%/);
    await page.screenshot({path:resolve(evidence,'over-limit-desktop.png'),fullPage:true});
  });
  await check('pause concurrency and daily starts explain every blocker even without reports',async()=>{
    for(const [input,reason]of [[{policy:{enabled:false}},'AI 已暂停'],[{runs:2,active:2},'并发已满'],[{runs:10},'今日启动次数已达上限']]){
      seed(input);await refresh();assert.match(await panel.locator('.ai-startup').innerText(),/新任务受限/);assert.match(await panel.locator('.ai-startup').innerText(),new RegExp(reason));assert.equal(await panel.locator('.ai-token-value').innerText(),'暂无报告');
    }
    seed({tokens:1250000,runs:10,active:2,limited:2,policy:{enabled:false}});await refresh();
    for(const reason of ['AI 已暂停','token 已达上限','今日启动次数已达上限','并发已满'])assert.match(await panel.locator('.ai-startup').innerText(),new RegExp(reason));
    assert.match(await panel.locator('.ai-runtime-note').innerText(),/今日触发限额 2 次/);
  });
  await check('automatic refresh updates persisted usage and preserves keyboard link focus',async()=>{
    seed({tokens:222222});await panel.locator('#aiOverviewLink').focus();
    await page.waitForFunction(()=>document.querySelector('.ai-token-value')?.textContent.includes('222,222'),{},{timeout:10000});assert.equal(await page.evaluate(()=>document.activeElement.id),'aiOverviewLink');
  });
  await check('390px and 360px display fit including billion-token values and large limits',async()=>{
    seed({tokens:1234567890,runs:2,active:1,policy:{daily_tokens:1000000000,daily_runs:1000000000,concurrent_runs:1000000000}});await refresh();
    for(const width of [390,360]){
      await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px document overflow`);
      const overflow=await panel.evaluate(el=>[...el.querySelectorAll('*')].filter(e=>{const b=e.getBoundingClientRect();return b.width&&b.right>innerWidth+1;}).map(e=>({tag:e.tagName,class:e.className,text:e.textContent.slice(0,80)})));assert.deepEqual(overflow,[]);
      assert.match(await panel.locator('.ai-token-value').innerText(),/1,234,567,890/);await page.screenshot({path:resolve(evidence,`over-limit-${width}px.png`),fullPage:true});
    }
    await page.setViewportSize({width:1500,height:1100});
  });
  await check('overview entry reaches real all-account limits and global detail',async()=>{
    await panel.locator('#aiOverviewLink').click();await page.getByRole('button',{name:'调整限额'}).first().waitFor();assert.equal(new URL(page.url()).hash,'#/ai');
    assert.match(await page.locator('#view').innerText(),/全站 AI 总额度/);await page.locator('[data-open="ai"][data-id="global"]').click();await page.locator('#detail[open]').waitFor();assert.match(await page.locator('#detail').innerText(),/1,234,567,890/);
    await page.keyboard.press('Escape');await page.locator('nav [data-page="overview"]').click();await panel.waitFor();
  });
  await check('injected AI HTTP 503 hides stale quotas while other overview panels survive and retry recovers',async()=>{
    await page.route('**/creation-api/admin/ai/global',route=>route.fulfill({status:503,json:{error:'Independent test: AI endpoint temporarily unavailable'}}));
    await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ai-overview')?.textContent.includes('AI 用量暂不可用'));
    assert.equal(await panel.locator('.ai-token-value').count(),0);assert.equal(await page.locator('#cpuChart').count(),1);assert.equal(await page.locator('#shell').isVisible(),true);
    await page.screenshot({path:resolve(evidence,'ai-unavailable-desktop.png'),fullPage:true});await page.unroute('**/creation-api/admin/ai/global');await refresh();assert.match(await panel.locator('.ai-token-value').innerText(),/1,234,567,890/);
  });
  await check('injected AI authorization failure locks the complete admin page',async()=>{
    await page.route('**/creation-api/admin/ai/global',route=>route.fulfill({status:403,json:{error:'Independent test: admin grant revoked'}}));await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.locator('#bootError').waitFor();
    assert.equal(await page.locator('#shell').isVisible(),false);assert.equal(await page.locator('.ai-overview').count(),0);assert.match(await page.locator('#bootError').innerText(),/admin grant revoked/);
  });
  assert.deepEqual(errors,[]);report.completed=true;
}catch(error){report.error=error.stack;if(page){report.visible_text=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:resolve(evidence,'failure.png'),fullPage:true}).catch(()=>{});}throw error;}
finally{
  await browser?.close();if(child&&child.exitCode===null){const exited=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);await exited;clearTimeout(timeout);}
  store.close();rmSync(data,{recursive:true,force:true});report.temporary_data_removed=true;report.finished_at=new Date().toISOString();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));writeFileSync(resolve(evidence,'server.log'),serverLog);console.log('BROWSER_REPORT '+resolve(evidence,'report.json'));
}
