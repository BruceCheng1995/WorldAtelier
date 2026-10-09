import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';
import {AssetMarket} from '../../services/creation/asset-market.mjs';
import {assetFixturePNG} from './asset-test-fixtures.mjs';
const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(resolve(tmpdir(),'atelier-market-admin-browser-'));
const evidence=resolve(root,'.local/creation-verification/admin-market-browser',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(evidence,{recursive:true});
const probe=createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
const origin=`http://127.0.0.1:${port}`,credentials={name:'资源运营检查员',password:randomUUID()},store=new CreationStore(resolve(data,'creation/creation.sqlite'));
const owner=store.register(credentials);store.put('creator_admin_settings',{id:'singleton',owner_user_id:owner.user.id});
const market=new AssetMarket({service:{store,data:resolve(data,'creation')}}),cover=market.archive.put(assetFixturePNG());
for(let i=0;i<28;i++){
  const asset=market.installOfficial({id:`browser-market-${i}`,name:i===0?'星际战士 · 角色资源包':`测试资源 ${String(i).padStart(2,'0')}`,description:'隔离浏览器检查资源',category:'character',dimension:'3d',license:'CC0-1.0',screenshots:['cover.png'],files:{'cover.png':cover},redistribution_confirmed:true}).asset;
  for(let n=0;n<28-i;n++)market.analytics.record(asset.id,'views');
}
store.close();
let child,browser,page,log='';const errors=[],report={scope:'Isolated real admin UI, persistence and market visibility; no Godot or production edits',cases:[]};
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function check(name,fn){await fn();report.cases.push(name);console.log('PASS '+name);}
try{
  const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'};delete env.WORLD_ATELIER_ADMIN_USER_ID;
  child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/admin#/market');await page.getByLabel('账号名称').fill(credentials.name);await page.getByLabel('密码',{exact:true}).fill(credentials.password);await page.getByRole('button',{name:'登录管理后台'}).click();await page.locator('[data-page="market"]').click();
  await check('market metrics and real disk snapshot render in original dashboard',async()=>{await page.getByRole('button',{name:'管理资源'}).first().waitFor();assert.match(await page.locator('#view').innerText(),/累计下载/);assert.match(await page.locator('#view').innerText(),/市场原件与历史版本/);assert.equal(await page.locator('tbody tr').count(),25);await page.screenshot({path:resolve(evidence,'desktop.png'),fullPage:true});});
  await check('pagination search status and sorting work',async()=>{await page.getByRole('button',{name:'下一页'}).click();await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===3);await page.getByRole('button',{name:'上一页'}).click();await page.getByLabel('搜索资源市场').fill('星际战士');await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===1);await page.getByLabel('资源排序').selectOption('downloads');await page.waitForResponse(r=>r.url().includes('sort=downloads')&&r.status()===200);});
  await check('audited unlist hides public asset and stays manageable',async()=>{await page.getByRole('button',{name:'管理资源'}).click();await page.getByRole('button',{name:'下架资源',exact:true}).click();await page.getByLabel('操作原因').fill('独立浏览器检查下架');await page.getByRole('button',{name:'确认保存'}).click();await page.waitForFunction(()=>!document.querySelector('#confirm').open);await page.getByRole('button',{name:'上架资源',exact:true}).waitFor();assert.equal((await fetch(origin+'/creation-api/market/browser-market-0')).status,404);await page.screenshot({path:resolve(evidence,'unlisted-detail.png')});await page.getByRole('button',{name:'关闭详情'}).click();await page.getByLabel('状态筛选').selectOption('unlisted');await page.waitForResponse(r=>r.url().includes('status=unlisted')&&r.status()===200);assert.equal(await page.locator('tbody tr').count(),1);});
  await check('relist restores the exact asset and audit row',async()=>{await page.getByRole('button',{name:'管理资源'}).click();await page.getByRole('button',{name:'上架资源',exact:true}).click();await page.getByLabel('操作原因').fill('独立浏览器检查恢复');await page.getByRole('button',{name:'确认保存'}).click();await page.getByRole('button',{name:'下架资源',exact:true}).waitFor();assert.equal((await fetch(origin+'/creation-api/market/browser-market-0')).status,200);await page.getByRole('button',{name:'关闭详情'}).click();await page.locator('[data-page="activity"]').click();await page.getByRole('button',{name:'管理审计',exact:true}).click();await page.getByRole('button',{name:'查看记录'}).first().waitFor();assert.match(await page.locator('#view').innerText(),/资源市场上下架/);});
  await check('mobile fits screen and tables scroll inside their container',async()=>{await page.locator('[data-page="market"]').click();await page.getByRole('button',{name:'管理资源'}).first().waitFor();await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve(evidence,'mobile.png'),fullPage:true});});
  assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.error=error.stack;if(page){report.text=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:resolve(evidence,'failure.png'),fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();if(child&&child.exitCode===null){const exited=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);await exited;clearTimeout(timer);}rmSync(data,{recursive:true,force:true});writeFileSync(resolve(evidence,'report.json'),JSON.stringify({...report,errors},null,2));writeFileSync(resolve(evidence,'server.log'),log);console.log('REPORT '+resolve(evidence,'report.json'));}
