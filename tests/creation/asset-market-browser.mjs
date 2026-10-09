import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';
import {AssetMarket} from '../../services/creation/asset-market.mjs';
import {assetFixturePNG} from './asset-test-fixtures.mjs';

const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(join(tmpdir(),'atelier-market-browser-'));
const port=Number(process.env.WORLD_ATELIER_MARKET_TEST_PORT??48921),origin=`http://127.0.0.1:${port}`;
const evidence=join(root,'.local/creation-verification/asset-market','browser-'+randomUUID());mkdirSync(evidence,{recursive:true});
const report={scope:'Real isolated browser, HTTP, upload and native copy import; fixture assets, not official character visual acceptance',origin,cases:[],errors:[],completed:false};
const credentials={name:'市场浏览器测试者',password:randomUUID()},creationData=join(data,'creation');
const store=new CreationStore(join(creationData,'creation.sqlite')),owner=store.register(credentials);
const market=new AssetMarket({service:{store,data:creationData}});
const png=assetFixturePNG(),image=market.archive.put(png),scene=market.archive.put(Buffer.from('[gd_scene format=3]\n[node name="MarketFixture" type="CharacterBody2D"]\n'));
const official=market.installOfficial({id:'official-browser-fixture',name:'官方界面测试角色',description:'用于独立界面测试的图片与原生角色预制件。',category:'character',dimension:'2d',license:'CC0-1.0',screenshots:['cover.png'],preview:{type:'image',path:'cover.png'},files:{'cover.png':image,'character.tscn':scene},entry_path:'character.tscn',features:['原生角色预制件'],usage:'独立测试夹具。',tags:['browser-fixture'],redistribution_confirmed:true}).asset;
const modelAsset=market.installOfficial({id:'official-browser-model',name:'真实 GLB 界面测试',description:'用于独立 WebGL 预览检查的固定模型。',category:'model',dimension:'3d',license:'CC0-1.0',screenshots:['cover.png'],preview:{type:'model',path:'model.glb'},files:{'cover.png':image,'model.glb':market.archive.put(readFileSync(join(root,'content/model-preview/beacon.glb')))},features:['可旋转模型'],redistribution_confirmed:true}).asset;store.close();
const uploadScene=join(data,'uploaded-character.tscn'),uploadCover=join(data,'cover.png');writeFileSync(uploadScene,'[gd_scene format=3]\n[node name="UploadedCharacter" type="CharacterBody2D"]\n');writeFileSync(uploadCover,png);
let server,browser,page,log='';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(method,path,input){const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin,authorization:'Bearer '+owner.token,'content-type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});const value=await response.json();assert.equal(response.ok,true,JSON.stringify(value));return value;}
async function check(name,fn){const result=await fn();report.cases.push({name,status:'passed',result});console.log('MARKET_BROWSER_PASS '+name);}
try {
  const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:creationData,WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'};
  delete env.WORLD_ATELIER_ADMIN_USER_ID;
  server=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});server.stdout.on('data',bytes=>log+=bytes);server.stderr.on('data',bytes=>log+=bytes);
  for(let i=0;i<200;i++){if(server.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  const created=await api('POST','/projects',{name:'市场导入接收游戏',template:'empty'}),projectId=created.project.id,branchRoute=`/projects/${projectId}/branches/main`;
  await api('POST',branchRoute+'/transactions',{transaction_id:'browser-native-setup',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:[{path:'project.godot',text:'config_version=5\n[application]\nconfig/name="Market UI fixture"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'},{path:'.atelier/catalog.json',text:JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',path:'main.tscn'}}})},{path:'main.tscn',text:'[gd_scene format=3]\n[node name="Main" type="Node2D"]\n'}]}]});
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  await check('anonymous external navigation catalog filters and fixed detail URL',async()=>{
    await page.goto(origin+'/market');await page.locator('[data-asset="'+official.id+'"]').waitFor();
    assert.equal(await page.getByRole('link',{name:'我的游戏',exact:true}).getAttribute('href'),'/creation-workspace.html#/games');
    await page.getByLabel('资源维度').selectOption('3d');await page.locator('[data-asset="'+modelAsset.id+'"]').waitFor();assert.equal(await page.locator('[data-asset="'+official.id+'"]').count(),0);
    await page.getByLabel('资源维度').selectOption('2d');await page.getByLabel('搜索资源').fill('browser-fixture');await page.locator('[data-asset="'+official.id+'"]').waitFor();
    await page.getByLabel('资源来源').selectOption('official');await page.locator('[data-asset="'+official.id+'"]').click();
    await page.getByRole('heading',{name:official.name,exact:true}).waitFor();await page.locator('[data-preview] img').evaluate(img=>img.decode());
    await page.screenshot({path:join(evidence,'anonymous-detail.png')});
    await page.goto(origin+official.version_url);await page.getByRole('heading',{name:official.name,exact:true}).waitFor();
    await page.getByRole('button',{name:'选择游戏并添加'}).click();await page.getByText('请先通过「我的游戏」登录，再回来添加资源。').waitFor();
    return {id:official.id,url:official.version_url,image_decoded:true};
  });
  await check('real GLB preview renders rotates and keeps media within layout',async()=>{
    await page.goto(origin+modelAsset.version_url);await page.locator('[data-preview][data-preview-state=ready]').waitFor({timeout:45000});const stage=page.locator('.model-stage');
    assert.match(await page.locator('.model-stats').innerText(),/三角面/);
    const before=createHash('sha256').update(await stage.screenshot()).digest('hex');await page.getByRole('button',{name:'自动旋转',exact:true}).click();await wait(500);const after=createHash('sha256').update(await stage.screenshot()).digest('hex');assert.notEqual(before,after);await page.getByRole('button',{name:'自动旋转',exact:true}).click();
    const modelBox=await page.locator('.model-preview').boundingBox(),shotsBox=await page.locator('.market-screenshots').boundingBox();assert.ok(shotsBox.y>=modelBox.y+modelBox.height,'screenshots follow model controls without overlap');await page.screenshot({path:join(evidence,'model-preview.png')});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'standalone market fits mobile width');await page.screenshot({path:join(evidence,'model-mobile.png')});await page.setViewportSize({width:1440,height:1000});
    return {real_glb:true,rotated_pixels:true,media_no_overlap:true,mobile_no_overflow:true};
  });
  await check('real login and upload form publish public developer asset',async()=>{
    await page.getByRole('link',{name:'我的游戏',exact:true}).click();await page.locator('#authName').fill(credentials.name);await page.locator('#authPassword').fill(credentials.password);await page.locator('#authSubmit').click();await page.locator('#landing').waitFor({state:'visible'});
    await page.goto(origin+'/market');await page.locator('[data-upload]').click();await page.locator('input[name=name]').fill('浏览器真实上传角色');await page.locator('textarea[name=description]').fill('通过真实文件选择器上传，供独立资源市场流程验证。');await page.locator('select[name=dimension]').selectOption('2d');await page.locator('textarea[name=features]').fill('原生 CharacterBody2D\n独立副本');await page.locator('input[name=entry_path]').fill('uploaded-character.tscn');
    await page.locator('[data-files]').setInputFiles(uploadScene);await page.locator('[data-cover]').setInputFiles(uploadCover);await page.locator('input[name=redistribution_confirmed]').check();await page.getByRole('button',{name:'发布到资源市场'}).click();await page.getByRole('heading',{name:'浏览器真实上传角色',exact:true}).waitFor({timeout:30000});
    const list=await api('GET','/market?q='+encodeURIComponent('浏览器真实上传角色'));assert.equal(list.total,1);assert.equal(list.assets[0].publisher,'developer');report.uploaded_asset_id=list.assets[0].id;
    await page.locator('[data-preview] img').evaluate(img=>img.decode());await page.screenshot({path:join(evidence,'uploaded-detail.png')});return {id:list.assets[0].id};
  });
  await check('external picker imports an actual independent native prefab copy',async()=>{
    const before=await api('GET',branchRoute);await page.getByRole('button',{name:'选择游戏并添加'}).click();await page.getByRole('dialog').waitFor();await page.getByLabel('目标游戏').selectOption(projectId);await page.getByLabel('目标分支').selectOption('main');await page.getByRole('button',{name:'添加副本',exact:true}).click();await page.getByText(/已添加独立副本/).waitFor({timeout:90000});
    const after=await api('GET',branchRoute);assert.notEqual(after.head,before.head);const prefab=Object.values(after.manifest.resources).find(value=>value.kind==='prefab'&&value.name==='浏览器真实上传角色');assert.ok(prefab);report.imported_resource_id=prefab.id;await page.screenshot({path:join(evidence,'external-imported.png')});return {revision:after.head,prefab_id:prefab.id};
  });
  await check('workbench market is peer to prefab shelf and opens actual market overlay',async()=>{
    await page.goto(origin+`/creation-workspace.html#/games/${projectId}/branches/main`);await page.locator('#workbench').waitFor({state:'visible'});await page.locator('#toggleMarketShelf').waitFor();
    assert.equal(await page.locator('#marketShelf').evaluate(el=>el.parentElement===document.querySelector('#prefabShelf').parentElement),true);
    await page.locator('#toggleMarketShelf').click();assert.equal(await page.locator('#toggleMarketShelf').getAttribute('aria-expanded'),'true');await page.locator('[data-market-asset="'+official.id+'"]').waitFor();
    await page.locator('[data-market-asset="'+official.id+'"]').click();await page.locator('.market-overlay').waitFor();await page.getByRole('heading',{name:official.name,exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'添加到当前游戏'}).isVisible(),true);await page.screenshot({path:join(evidence,'workbench-market.png')});
    await page.locator('.market-overlay [data-close]').click();assert.equal(await page.locator('.market-overlay').count(),0);await page.locator('#toggleMarketShelf').click();assert.equal(await page.locator('#marketShelfList').isVisible(),false);
    return {same_parent:true,expanded_and_closed:true};
  });
  assert.deepEqual(report.errors,[]);report.completed=true;
}catch(error){report.error=error.stack;if(page){report.visible_text=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});}throw error;}
finally {
  await browser?.close();if(server&&server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');const timeout=setTimeout(()=>server.kill('SIGKILL'),12000);await exited;clearTimeout(timeout);}
  rmSync(data,{recursive:true,force:true});report.finished_at=new Date().toISOString();report.temporary_data_removed=true;writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(join(evidence,'server.log'),log);console.log('MARKET_BROWSER_EVIDENCE '+evidence);
}
