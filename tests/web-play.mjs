import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const root=resolve('.'),port=48923,url=`http://127.0.0.1:${port}`,run=Date.now();
const evidence=join(root,'.local/evidence',`web-play-${run}`);await mkdir(evidence,{recursive:true});
const server=spawn(process.execPath,['services/control-plane/server.mjs'],{cwd:root,env:{...process.env,WORLD_ATELIER_PORT:String(port),WORLD_ATELIER_DATA:join(evidence,'data')},stdio:['ignore','pipe','pipe']});
let log='';server.stdout.on('data',b=>log+=b);server.stderr.on('data',b=>log+=b);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(label,fn,ms=120000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await wait(150);}throw Error('Timed out: '+label);}
let browser;const reports=[],errors=[],expectedErrors=[];let injectingDownloadFault=false;
try{
  await until('server',async()=>{try{return (await fetch(url+'/health')).ok;}catch{return false;}},15000);
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--enable-unsafe-swiftshader']});
  async function newUser(name){
    const context=await browser.newContext({viewport:{width:1600,height:1200},deviceScaleFactor:1,acceptDownloads:true});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'){if(injectingDownloadFault&&m.text().includes('游戏产物长度不匹配：web/index.wasm'))expectedErrors.push(m.text());else errors.push(m.text());}});
    await page.addInitScript(()=>{window.__gameTelemetry=[];window.addEventListener('message',event=>{if(event.data?.source==='world-atelier-game'&&event.data.type==='telemetry'&&[...document.querySelectorAll('iframe')].some(f=>f.contentWindow===event.source)){window.__gameTelemetry.push(event.data);if(window.__gameTelemetry.length>120)window.__gameTelemetry.shift();}});});
    await page.goto(url);await page.getByLabel('协作者名称').fill(name);await page.getByLabel('密码',{exact:true}).fill('WebPlayOnly2026!');await page.getByRole('button',{name:'创建账号，进入工坊'}).click();await page.getByRole('button',{name:'创建第一个工程'}).waitFor();return page;
  }
  const ownerName='web-owner-'+run,editorName='web-editor-'+run;
  const owner=await newUser(ownerName),editor=await newUser(editorName);
  await owner.getByRole('button',{name:'创建第一个工程'}).click();await owner.getByLabel('工程名称',{exact:true}).fill('星屿远征 · 真实网页联调');await owner.getByRole('button',{name:'创建并继续'}).click();await owner.getByRole('heading',{name:'现场检查器'}).waitFor();
  await owner.getByRole('button',{name:'协作工作台',exact:true}).click();await owner.getByRole('button',{name:'添加成员',exact:true}).click();await owner.getByLabel('已注册的协作者名称').fill(editorName);await owner.getByLabel('工程角色').selectOption('editor');await owner.getByRole('button',{name:'创建并继续'}).click();await owner.getByRole('dialog').waitFor({state:'hidden'});
  await editor.reload();await editor.getByRole('heading',{name:'现场检查器'}).waitFor();
  await owner.getByRole('button',{name:'现场世界',exact:true}).click();await owner.getByRole('button',{name:'构建首个可玩版本'}).click();
  await owner.getByRole('button',{name:'进入星屿',exact:true}).waitFor({timeout:120000});
  reports.push('Two registered browser accounts, real membership and Godot release build via UI');
  async function enter(page){await page.getByRole('button',{name:'进入世界',exact:true}).click();await expect(page.locator('.game-panel')).toHaveAttribute('data-game-active','true',{timeout:120000});await page.frameLocator('iframe[title="星屿远征 Godot 游戏"]').locator('canvas').waitFor();return page.evaluate(()=>window.__gameTelemetry.at(-1));}
  const a=await enter(owner);await editor.reload();const b=await enter(editor);assert.equal(a.world_id,b.world_id);assert.notEqual(a.user_id,b.user_id);reports.push('Two actual Godot Web WASM clients reached active in the same authoritative world');
  await owner.bringToFront();const canvas=owner.frameLocator('iframe[title="星屿远征 Godot 游戏"]').locator('canvas');await canvas.click({position:{x:60,y:80}});
  const before=await owner.evaluate(()=>window.__gameTelemetry.at(-1));await owner.keyboard.down('s');await wait(650);await owner.keyboard.up('s');
  const moved=await until('real keyboard movement',async()=>{const t=await owner.evaluate(()=>window.__gameTelemetry.at(-1));return Math.hypot(t.player.x-before.player.x,t.player.z-before.player.z)>1?t:null;});
  assert.ok(moved.tick>before.tick);reports.push('Native browser keyboard input moved the real Godot player; authoritative tick advanced');
  await owner.getByLabel('当前对象',{exact:true}).selectOption('starheart');await until('selection in Godot',async()=> (await owner.evaluate(()=>window.__gameTelemetry.at(-1)))?.selected==='starheart');
  await owner.locator('.game-panel').screenshot({path:join(evidence,'selection.png')});
  await owner.getByRole('button',{name:'为此对象发起开发任务'}).click();await owner.getByLabel('任务标题').fill('多人维护光圈真实验证');await owner.getByRole('button',{name:'创建并继续'}).click();await owner.getByRole('dialog').waitFor({state:'hidden'});
  await until('task on rendered client',async()=> (await owner.evaluate(()=>window.__gameTelemetry.at(-1)))?.tasks?.some(t=>t.object_id==='starheart'&&t.status==='editing'));
  await wait(600);await owner.locator('.game-panel').screenshot({path:join(evidence,'maintenance.png')});reports.push('Selection and real branch-scoped editing task reached the running Web client; screenshots captured for visual review');
  const ownerSession=await owner.evaluate(()=>JSON.parse(localStorage.getItem('world-atelier:session'))),editorSession=await editor.evaluate(()=>JSON.parse(localStorage.getItem('world-atelier:session')));
  async function api(session,path,body,method=body?'POST':'GET'){
    const response=await fetch(url+'/api'+path,{method,headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
  }
  const project=(await api(ownerSession,'/projects')).projects[0],projectPath='/projects/'+project.id;
  let details=await api(ownerSession,projectPath);const task=details.tasks.find(t=>t.object_id==='starheart');
  async function renderedStatus(status){await until('rendered task '+status,async()=>{const t=await owner.evaluate(()=>window.__gameTelemetry.at(-1));return t?.rendered_tasks?.some(x=>x.id===task.id&&x.status===status);});await wait(300);await owner.locator('.game-panel').screenshot({path:join(evidence,status+'.png')});}
  await api(editorSession,'/tasks/'+task.id,{status:'testing'},'PATCH');await renderedStatus('testing');
  const uploaded=await api(editorSession,projectPath+'/assets',{name:'真实远征者模型.glb',mime:'model/gltf-binary',data_base64:(await readFile(join(root,'runtimes/godot/assets/explorer.glb'))).toString('base64')});
  const draft=await api(editorSession,projectPath+'/branches/main/content');const modified=draft.content.objects.find(o=>o.id==='starheart');modified.name='协作更新的星核';modified.model_asset=uploaded.asset.hash;
  await api(editorSession,projectPath+'/branches/main/commit',{base_revision:draft.revision,content:draft.content,message:'协作者投递真实GLB并验证施工交付'});
  const build=(await api(editorSession,projectPath+'/branches/main/build',{})).build;
  await until('model build',async()=>{details=await api(editorSession,projectPath);const value=details.builds.find(x=>x.id===build.id);if(value.status==='failed')throw Error(value.error);return value.status==='passed';});
  const contentRelease=details.branches.find(x=>x.name==='main').playable_head;
  const beforeHot=await owner.evaluate(()=>window.__gameTelemetry.at(-1));
  await owner.getByRole('button',{name:'刷新工程',exact:true}).click();await owner.getByRole('button',{name:'应用最新可玩版本',exact:true}).click();
  await until('actual Web GLB application',async()=>{const t=await owner.evaluate(()=>window.__gameTelemetry.at(-1));return t.active&&t.release_id===contentRelease&&t.rendered_model_assets.includes(uploaded.asset.hash);});
  const afterHot=await owner.evaluate(()=>window.__gameTelemetry.at(-1));assert.equal(afterHot.world_id,beforeHot.world_id);assert.ok(afterHot.tick>beforeHot.tick);assert.equal(afterHot.player.crystals,beforeHot.player.crystals);
  await renderedStatus('delivered');reports.push('Second collaborator uploaded a real GLB, committed and built it; both running Web clients applied the release without recreating their world, preserving player progress');
  await api(editorSession,'/tasks/'+task.id,{status:'failed'},'PATCH');await renderedStatus('failed');
  reports.push('Actual renderer nodes and screenshots verified testing, server-confirmed delivered, and failed task states');
  await owner.getByRole('button',{name:'新建分支',exact:true}).click();await owner.getByLabel('分支名称',{exact:true}).fill('visual-review');await owner.getByRole('button',{name:'创建并继续'}).click();await owner.getByRole('dialog').waitFor({state:'hidden'});
  const sourceBeforeFailure=await owner.evaluate(()=>window.__gameTelemetry.at(-1));
  const corruptArtifact=route=>route.fulfill({status:200,contentType:'application/wasm',body:Buffer.from('intentionally truncated independent-test download')});
  injectingDownloadFault=true;await owner.route('**/artifacts/**/*.wasm',corruptArtifact);
  await owner.getByRole('button',{name:'进入所选世界',exact:true}).click();await expect(owner.getByRole('alert')).toContainText('长度不匹配',{timeout:120000});await owner.unroute('**/artifacts/**/*.wasm',corruptArtifact);injectingDownloadFault=false;assert.equal(expectedErrors.length,1,'Exactly the deliberately corrupted artifact should be rejected');
  const continued=await until('original client still playing after target failure',async()=>{const t=await owner.evaluate(()=>window.__gameTelemetry.at(-1));return t?.active&&t.world_id===a.world_id&&t.tick>sourceBeforeFailure.tick?t:null;});
  assert.equal(continued.world_id,a.world_id);reports.push('Injected a truncated target download; artifact verification rejected it while the original actual Web client kept playing');
  await owner.getByRole('button',{name:'进入所选世界',exact:true}).click();
  const branchClient=await until('real branch handoff',async()=>{const t=await owner.evaluate(()=>window.__gameTelemetry.at(-1));return t?.active&&t.world_id!==a.world_id?t:null;});
  assert.equal(branchClient.tasks.length,0,'Main branch construction must not leak into branch world');await owner.locator('.game-panel').screenshot({path:join(evidence,'branch-world.png')});
  await owner.getByLabel('当前分支',{exact:true}).selectOption('main');await owner.getByRole('button',{name:'进入所选世界',exact:true}).click();
  await until('return to authoritative main',async()=>{const t=await owner.evaluate(()=>window.__gameTelemetry.at(-1));return t?.active&&t.world_id===a.world_id&&t.tick>continued.tick;});
  reports.push('Actual Web runtime switched to independent branch world, verified task isolation, then returned to continuously advancing main world');
  await editor.bringToFront();await wait(3000);await owner.bringToFront();await wait(3000);reports.push('Both real browser clients resumed after backgrounding');
  await owner.screenshot({path:join(evidence,'portal-live.png'),fullPage:true});await editor.locator('.game-panel').screenshot({path:join(evidence,'second-player.png')});
  await writeFile(join(evidence,'report.json'),JSON.stringify({run,url,reports,errors,expectedErrors,before,moved,world_id:a.world_id,users:[a.user_id,b.user_id],scope:'Actual Web clients and UI, screenshots require inspection; campaign, offline and branches are separate acceptance'},null,2));
  console.log(JSON.stringify({evidence,reports,errors},null,2));
  assert.deepEqual(errors,[],'Real browser clients emitted errors; this run is not a pass');
}catch(error){await writeFile(join(evidence,'failure.txt'),String(error.stack));if(browser){for(const [i,page]of browser.contexts().flatMap(c=>c.pages()).entries())await page.screenshot({path:join(evidence,`failure-${i}.png`),fullPage:true}).catch(()=>{});}console.error(error);process.exitCode=1;}
finally{await browser?.close();server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),wait(5000)]);await writeFile(join(evidence,'server.log'),log);console.log('Evidence: '+evidence);}
