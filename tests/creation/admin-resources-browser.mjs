import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';

// This is a disposable browser fixture, never production identity or content.
const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(resolve(tmpdir(),'atelier-admin-resources-browser-'));
const evidence=resolve(root,'.local/creation-verification/admin-resources-browser',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(evidence,{recursive:true});
const probe=createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
const origin='http://127.0.0.1:'+port,credentials={name:'资源监控检查员',password:randomUUID()};
const store=new CreationStore(resolve(data,'creation/creation.sqlite')),owner=store.register(credentials);store.put('creator_admin_settings',{id:'singleton',owner_user_id:owner.user.id});store.close();
const report={origin,scope:'Isolated Chrome resource comparisons; real OS samples plus explicitly labelled deterministic edge-case display fixtures',cases:[],completed:false};
let child,browser,activePage,serverLog='';
const hash=b=>createHash('sha256').update(b).digest('hex'),wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function api(method,path,input){const res=await fetch(origin+'/creation-api'+path,{method,headers:{Origin:origin,Authorization:'Bearer '+owner.token,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});assert.equal(res.ok,true,await res.clone().text());return res.json();}
async function check(name,fn){await fn();report.cases.push({name,status:'passed'});console.log('PASS '+name);}
try{
  const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'};delete env.WORLD_ATELIER_ADMIN_USER_ID;
  child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>serverLog+=b);child.stderr.on('data',b=>serverLog+=b);
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(serverLog);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1500,height:1100}}),page=await context.newPage(),errors=[];activePage=page;report.console_errors=errors;
  page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error'&&!msg.location().url.endsWith('/favicon.ico'))errors.push(msg.text());});
  await page.goto(origin+'/admin#/resources');await page.getByLabel('账号名称').fill(credentials.name);await page.getByLabel('密码',{exact:true}).fill(credentials.password);await page.getByRole('button',{name:'登录管理后台'}).click();await page.locator('[data-resource="cpu"]').waitFor();
  let live;
  await check('three capacity cards and four charts load real resource samples',async()=>{
    for(let i=0;i<20;i++){live=await api('GET','/admin/metrics?range=1h');if(live.latest)break;await wait(500);}assert.ok(live.latest);await page.getByRole('button',{name:'刷新数据',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[data-resource="cpu"] .capacity-value').textContent.includes('—'));
    assert.equal(await page.locator('.capacity-card').count(),3);assert.equal(await page.locator('[data-resource-chart]').count(),4);
    for(const name of ['总算力','总容量','系统空闲','预留 / 不可用'])assert.ok(await page.getByText(name,{exact:true}).count());
    assert.ok(live.latest.logical_cores>0);assert.equal(live.latest.host_memory_bytes+live.latest.host_memory_free_bytes,live.latest.host_memory_total);
    assert.equal(live.latest.disk.used_bytes+live.latest.disk.available_bytes+live.latest.disk.reserved_bytes,live.latest.disk.total_bytes);
    await page.screenshot({path:resolve(evidence,'real-samples-desktop.png'),fullPage:true});
  });
  await check('automatic refresh preserves keyboard chart focus and inspected sample',async()=>{
    const canvas=page.locator('[data-resource-chart="comparison"]');await canvas.focus();await page.keyboard.press('Home');
    const inspected=await canvas.getAttribute('data-selected-at');const previous=await page.locator('#updated').innerText();
    await page.waitForFunction(previous=>document.querySelector('#updated').textContent!==previous,previous,{timeout:10000});
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.resourceChart),'comparison');assert.equal(await canvas.getAttribute('data-selected-at'),inspected);
  });
  await check('unit switch renders amount axes and all time ranges fetch matching history',async()=>{
    await page.getByRole('button',{name:'实际用量',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-resource-chart="memory"]').getAttribute('aria-label').includes('字节'));
    assert.match(await page.locator('[data-chart-reading="cpu"]').innerText(),/核/);assert.match(await page.locator('[data-chart-reading="memory"]').innerText(),/(GB|MB)/);
    for(const [key,label]of [['15m','15 分钟'],['24h','24 小时'],['1h','1 小时']]){const response=page.waitForResponse(r=>r.url().includes('/admin/metrics?range='+key)&&r.ok());await page.getByRole('button',{name:label,exact:true}).click();await response;await page.waitForFunction(label=>document.querySelector('[aria-label="资源统计时段"] .active')?.textContent===label,label);}
    await page.getByRole('button',{name:'占用率',exact:true}).click();assert.match(await page.locator('[data-resource-chart="memory"]').getAttribute('aria-label'),/百分比/);
  });
  // Explicit display fixture: fixed measured-like numbers to inspect nonempty
  // history/gaps deterministically. It is never stored or delivered as real data.
  const end=Date.now(),GB=1024**3;
  function point(at,index){return {at,logical_cores:8,host_cpu_percent:20+index%7*9,process_cpu_percent:80,host_memory_total:32*GB,host_memory_bytes:(18+index%5)*GB,process_memory_bytes:GB/2,disk:{total_bytes:1000*GB,used_bytes:(600+index/10)*GB,available_bytes:(350-index/10)*GB,reserved_bytes:50*GB}};}
  const sampleFixture={...live,range:'1h',latest:point(end,60),samples:Array.from({length:61},(_,index)=>point(end-(60-index)*60000,index)).filter((_,index)=>index<23||index>29),host:{...live.host,logical_cores:8,total_memory_bytes:32*GB}};
  await page.route('**/creation-api/admin/metrics?*',route=>route.fulfill({json:sampleFixture}));
  await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-resource="memory"] .capacity-facts').textContent.includes('32 GB'));
  await check('historical comparison fixture displays matching capacities and sampled readouts',async()=>{
    const cpu=page.locator('[data-resource="cpu"]'),disk=page.locator('[data-resource="disk"]');assert.match(await cpu.innerText(),/8 核/);assert.match(await disk.innerText(),/50 GB/);
    await page.locator('[data-resource-chart="comparison"]').focus();await page.keyboard.press('Home');assert.match(await page.locator('[data-chart-reading="comparison"]').innerText(),/CPU 已用 20%/);await page.keyboard.press('End');assert.match(await page.locator('[data-chart-reading="comparison"]').innerText(),/CPU 已用 56%/);
    const canvas=page.locator('[data-resource-chart="memory"]'),box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.5);assert.match(await page.locator('[data-chart-reading="memory"]').innerText(),/本服务进程 1.6%/);
    await page.screenshot({path:resolve(evidence,'comparison-fixture-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'实际用量',exact:true}).click();await page.screenshot({path:resolve(evidence,'amount-fixture-desktop.png'),fullPage:true});
  });
  await check('390px view keeps cards controls chart readouts within viewport',async()=>{
    await page.setViewportSize({width:390,height:844});await wait(100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    for(const canvas of await page.locator('[data-resource-chart]').all())assert.ok((await canvas.boundingBox()).width>280);
    await page.screenshot({path:resolve(evidence,'comparison-fixture-mobile.png'),fullPage:true});await page.setViewportSize({width:1500,height:1100});
  });
  await check('empty histories and missing disk stay unavailable without fake zeros',async()=>{
    await page.unroute('**/creation-api/admin/metrics?*');await page.route('**/creation-api/admin/metrics?*',route=>route.fulfill({json:{...live,latest:null,samples:[]}}));await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-resource="cpu"] .capacity-value').textContent.includes('—'));
    for(const card of await page.locator('.capacity-card').all())assert.match(await card.locator('.capacity-value').innerText(),/—/);
    assert.match(await page.locator('[data-chart-reading="disk"]').innerText(),/尚无有效采样/);
    await page.unroute('**/creation-api/admin/metrics?*');await page.route('**/creation-api/admin/metrics?*',route=>route.fulfill({json:{...live,latest:{...live.latest,disk:null},samples:[{...live.latest,disk:null}]}}));await page.getByRole('button',{name:'刷新数据',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-resource="cpu"] .capacity-value').textContent.includes('—'));assert.match(await page.locator('[data-resource="disk"] .capacity-value').innerText(),/—/);assert.match(await page.locator('[data-resource="cpu"] .capacity-trend').innerText(),/等待更多采样/);
  });
  await check('return to assets retains existing model preview entry',async()=>{await page.getByRole('link',{name:'资产管理'}).click();await page.getByRole('button',{name:'预览模型'}).first().waitFor();});
  assert.deepEqual(errors.filter(error=>!error.includes('401 (Unauthorized)')),[]);report.completed=true;
}catch(error){report.error=error.stack;if(activePage){report.visible_text=await activePage.locator('body').innerText().catch(()=>null);await activePage.screenshot({path:resolve(evidence,'failure.png'),fullPage:true}).catch(()=>{});}throw error;}
finally{
  await browser?.close();if(child&&child.exitCode===null){const exited=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);await exited;clearTimeout(timeout);}
  rmSync(data,{recursive:true,force:true});report.temporary_data_removed=true;report.finished_at=new Date().toISOString();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));writeFileSync(resolve(evidence,'server.log'),serverLog);console.log('BROWSER_REPORT '+resolve(evidence,'report.json'));
}
