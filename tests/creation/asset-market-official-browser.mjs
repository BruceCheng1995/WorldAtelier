import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';
import {AssetMarket} from '../../services/creation/asset-market.mjs';

const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(join(tmpdir(),'atelier-official-market-browser-'));
const port=Number(process.env.WORLD_ATELIER_MARKET_TEST_PORT??48921),origin=`http://127.0.0.1:${port}`,creationData=join(data,'creation');
const evidence=join(root,'.local/creation-verification/asset-market','official-browser-'+randomUUID());mkdirSync(evidence,{recursive:true});
const packages=resolve(process.env.WORLD_ATELIER_OFFICIAL_ASSET_ROOT??join(root,'.local/asset-market/packages'));
// Stable original-six regression; expanded catalog and all models have a separate browser test.
const regressionIds=new Set(['official-2d-maleAdventurer','official-2d-femaleAdventurer','official-2d-femalePerson','official-3d-skaterMaleA','official-3d-skaterFemaleA','official-3d-cyborgFemaleA']);
const metadata=JSON.parse(readFileSync(resolve(packages,'../package-metadata.json'),'utf8')).filter(item=>regressionIds.has(item.id));
assert.equal(metadata.length,6);
const store=new CreationStore(join(creationData,'creation.sqlite')),market=new AssetMarket({service:{store,data:creationData}});
const assets=metadata.map(item=>market.installOfficial({...item,files:market.archive.capture(join(packages,item.id))}).asset);store.close();
const report={scope:'Actual six official packages served from an isolated archive and rendered with sprite/WebGL animation in headless Chrome; no publication or Godot gameplay claim',assets:[],errors:[],completed:false};
let server,browser,page,log='';const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try {
  const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:creationData,WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'};delete env.WORLD_ATELIER_ADMIN_USER_ID;
  server=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});server.stdout.on('data',bytes=>log+=bytes);server.stderr.on('data',bytes=>log+=bytes);
  for(let i=0;i<200;i++){if(server.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(origin+'/market');await page.locator('.market-card').first().waitFor();assert.equal(await page.locator('.market-card').count(),6);await page.locator('.market-card img').evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode())));await page.screenshot({path:join(evidence,'official-catalog.png')});
  for(const asset of assets){
    await page.goto(origin+asset.version_url);await page.getByRole('heading',{name:asset.name,exact:true}).waitFor();const record={id:asset.id,version:asset.version,dimension:asset.dimension};report.assets.push(record);
    if(asset.dimension==='2d'){
      const canvas=page.locator('[data-preview] canvas');await page.getByLabel('选择角色动画').selectOption('walk');await wait(180);const before=hash(await canvas.screenshot());await wait(250);assert.notEqual(hash(await canvas.screenshot()),before,'real sprite animation changes pixels');
      const pause=await page.evaluate(async()=>{const canvas=document.querySelector('[data-preview] canvas'),button=document.querySelector('[data-pause]');const before=canvas.toDataURL();button.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {before,after:canvas.toDataURL()};});assert.equal(pause.after===pause.before,true,'sprite pause preserves the currently displayed frame');
      const paused=hash(await canvas.screenshot());await wait(200);assert.equal(hash(await canvas.screenshot()),paused);record.animated_and_paused=true;
    }else{
      await page.locator('[data-preview][data-preview-state=ready]').waitFor({timeout:45000});assert.match(await page.locator('.model-stats').innerText(),/3 段动画/);await page.getByLabel('选择模型动画').selectOption({label:'run'});await page.getByRole('button',{name:'播放动画',exact:true}).click();const stage=page.locator('.model-stage');const before=hash(await stage.screenshot());await wait(350);assert.notEqual(hash(await stage.screenshot()),before,'real skeletal animation changes WebGL pixels');await page.getByRole('button',{name:'暂停动画',exact:true}).click();await wait(100);const paused=hash(await stage.screenshot());await wait(200);assert.equal(hash(await stage.screenshot()),paused);record.animated_and_paused=true;
    }
    const screenshot=join(evidence,asset.id+'.png');await page.screenshot({path:screenshot});record.screenshot=screenshot;console.log('OFFICIAL_MARKET_BROWSER_PASS '+asset.id);
  }
  assert.deepEqual(report.errors,[]);report.completed=true;
}catch(error){report.error=error.stack;if(page)await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});throw error;}
finally {await browser?.close();if(server&&server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');const timeout=setTimeout(()=>server.kill('SIGKILL'),12000);await exited;clearTimeout(timeout);}rmSync(data,{recursive:true,force:true});report.finished_at=new Date().toISOString();writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(join(evidence,'server.log'),log);console.log('OFFICIAL_MARKET_BROWSER_EVIDENCE '+evidence);}
