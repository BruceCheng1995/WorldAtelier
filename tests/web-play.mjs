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
let browser;const reports=[],errors=[];
try{
  await until('server',async()=>{try{return (await fetch(url+'/health')).ok;}catch{return false;}},15000);
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--enable-unsafe-swiftshader']});
  async function newUser(name){
    const context=await browser.newContext({viewport:{width:1600,height:1200},deviceScaleFactor:1,acceptDownloads:true});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
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
  await editor.bringToFront();await wait(3000);await owner.bringToFront();await wait(3000);reports.push('Both real browser clients resumed after backgrounding');
  await owner.screenshot({path:join(evidence,'portal-live.png'),fullPage:true});await editor.locator('.game-panel').screenshot({path:join(evidence,'second-player.png')});
  await writeFile(join(evidence,'report.json'),JSON.stringify({run,url,reports,errors,before,moved,world_id:a.world_id,users:[a.user_id,b.user_id],scope:'Actual Web clients and UI, screenshots require inspection; campaign, offline and branches are separate acceptance'},null,2));
  console.log(JSON.stringify({evidence,reports,errors},null,2));
  assert.deepEqual(errors,[],'Real browser clients emitted errors; this run is not a pass');
}catch(error){await writeFile(join(evidence,'failure.txt'),String(error.stack));if(browser){for(const [i,page]of browser.contexts().flatMap(c=>c.pages()).entries())await page.screenshot({path:join(evidence,`failure-${i}.png`),fullPage:true}).catch(()=>{});}console.error(error);process.exitCode=1;}
finally{await browser?.close();server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('exit',r)),wait(5000)]);await writeFile(join(evidence,'server.log'),log);console.log('Evidence: '+evidence);}
