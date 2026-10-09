import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';

// This is a disposable browser fixture, never production identity or content.
const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(resolve(tmpdir(),'atelier-admin-model-browser-'));
const evidence=resolve(root,'.local/creation-verification/admin-model-browser',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(evidence,{recursive:true});
const probe=createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
const origin='http://127.0.0.1:'+port,credentials={name:'模型预览检查员',password:randomUUID()};
const store=new CreationStore(resolve(data,'creation/creation.sqlite')),owner=store.register(credentials);store.put('creator_admin_settings',{id:'singleton',owner_user_id:owner.user.id});store.close();
const report={origin,scope:'Isolated Chrome WebGL rendering and user interaction; fixture account/data, no Godot gameplay claim',cases:[],completed:false};
let child,browser,activePage,serverLog='';
const hash=b=>createHash('sha256').update(b).digest('hex'),wait=ms=>new Promise(ok=>setTimeout(ok,ms));
async function api(method,path,input){const res=await fetch(origin+'/creation-api'+path,{method,headers:{Origin:origin,Authorization:'Bearer '+owner.token,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});assert.equal(res.ok,true,await res.clone().text());return res.json();}
async function patchAsset(id,status){const {item}=await api('GET','/admin/assets/'+id);return api('PATCH','/admin/assets/'+id,{request_id:randomUUID(),expected_version:item.version,reason:'Isolated model browser check',status});}
async function check(name,fn){await fn();report.cases.push({name,status:'passed'});console.log('PASS '+name);}
function png(){
  function chunk(type,body){const bytes=Buffer.concat([Buffer.from(type),body]);let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=crc>>>1^((crc&1)?0xedb88320:0);}const out=Buffer.alloc(12+body.length);out.writeUInt32BE(body.length);bytes.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;}
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,235,120,50,255]))),chunk('IEND',Buffer.alloc(0))]);
}
function animatedTexturedGLB(){
  const raw=readFileSync(resolve(root,'content/model-preview/beacon.glb')),length=raw.readUInt32LE(12),doc=JSON.parse(raw.subarray(20,20+length).toString()),bin=raw.subarray(28+length);
  let binary=Buffer.from(bin);
  const append=bytes=>{const offset=binary.length;binary=Buffer.concat([binary,bytes,Buffer.alloc((4-bytes.length%4)%4)]);doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:bytes.length});return doc.bufferViews.length-1;};
  const times=append(Buffer.from(new Float32Array([0,1,2]).buffer)),start=doc.nodes[0].translation??[0,0,0],poses=append(Buffer.from(new Float32Array([...start,start[0]+1,start[1]+.4,start[2],...start]).buffer));
  const input=doc.accessors.push({bufferView:times,componentType:5126,count:3,type:'SCALAR',min:[0],max:[2]})-1;
  const output=doc.accessors.push({bufferView:poses,componentType:5126,count:3,type:'VEC3'})-1;
  doc.animations=[{name:'测试位移动画',samplers:[{input,output,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:0,path:'translation'}}]}];
  doc.images=[{bufferView:append(png()),mimeType:'image/png'}];doc.textures=[{source:0}];doc.materials[0].pbrMetallicRoughness??={};doc.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};
  doc.buffers[0].byteLength=binary.length;const json=Buffer.from(JSON.stringify(doc)),padded=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const out=Buffer.alloc(28+padded.length+binary.length);out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);out.writeUInt32LE(binary.length,20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);binary.copy(out,28+padded.length);return out;
}
try{
  const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'};delete env.WORLD_ATELIER_ADMIN_USER_ID;
  child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>serverLog+=b);child.stderr.on('data',b=>serverLog+=b);
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(serverLog);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  const project=await api('POST','/projects',{name:'隔离预览测试',template:'empty'}),assetBytes=animatedTexturedGLB();
  const uploaded=await fetch(origin+'/creation-api/projects/'+project.project.id+'/assets',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+owner.token,'Content-Type':'application/octet-stream','X-Asset-Name':'animated-textured-fixture.glb'},body:assetBytes});assert.equal(uploaded.status,201);const animated=await uploaded.json();
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage(),errors=[],blocked=[];activePage=page;report.console_errors=errors;
  page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error'&&!msg.location().url.endsWith('/favicon.ico'))errors.push(msg.text());});page.on('request',req=>{if(!req.url().startsWith(origin)&&!req.url().startsWith('blob:'))blocked.push(req.url());});
  await page.goto(origin+'/admin#/assets');await page.getByLabel('账号名称').fill(credentials.name);await page.getByLabel('密码',{exact:true}).fill(credentials.password);await page.getByRole('button',{name:'登录管理后台'}).click();await page.locator('[data-page="assets"]').click();
  async function open(name){const row=page.getByRole('row').filter({has:page.locator('.name',{hasText:name})});await row.getByRole('button',{name:'预览模型'}).click();await page.locator('#assetModelPreview[data-preview-state="ready"]').waitFor({timeout:30000});await wait(250);}
  const stage=page.locator('.model-stage'),canvas=page.locator('.model-stage canvas');
  await check('actual built-in model renders with real mesh statistics',async()=>{await open('双人探索艇');assert.match(await page.locator('.model-stats').innerText(),/1,632 个三角面/);await page.screenshot({path:resolve(evidence,'model-desktop.png')});});
  await check('drag rotates and wheel zoom changes rendered pixels',async()=>{const before=hash(await stage.screenshot()),box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.72,box.y+box.height*.6,{steps:12});await page.mouse.up();await wait(500);const rotated=hash(await stage.screenshot());assert.notEqual(rotated,before);await page.mouse.wheel(0,-220);await wait(400);assert.notEqual(hash(await stage.screenshot()),rotated);});
  await check('reset wireframe auto rotation and grid controls affect render',async()=>{await page.getByRole('button',{name:'复位视角'}).click();await wait(450);const normal=hash(await stage.screenshot());await page.getByRole('button',{name:'线框',exact:true}).click();assert.equal(await page.getByRole('button',{name:'线框',exact:true}).getAttribute('aria-pressed'),'true');await wait(100);assert.notEqual(hash(await stage.screenshot()),normal);await page.getByRole('button',{name:'线框',exact:true}).click();await page.getByRole('button',{name:'自动旋转'}).click();const before=hash(await stage.screenshot());await wait(450);assert.notEqual(hash(await stage.screenshot()),before);await page.getByRole('button',{name:'自动旋转'}).click();await page.getByRole('button',{name:'网格',exact:true}).click();assert.equal(await page.getByRole('button',{name:'网格',exact:true}).getAttribute('aria-pressed'),'false');});
  await check('expanded and mobile preview keep usable canvas without document overflow',async()=>{await page.getByRole('button',{name:'放大预览'}).click();assert.ok((await stage.boundingBox()).width>800);await page.getByRole('button',{name:'收起预览'}).click();await page.setViewportSize({width:390,height:844});await wait(200);assert.ok((await canvas.boundingBox()).width>300);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve(evidence,'model-mobile.png')});await page.setViewportSize({width:1440,height:1050});});
  await check('close while loading cancels late view and repeated reopen works',async()=>{await page.getByRole('button',{name:'关闭详情'}).click();await open('导航信标');await page.getByRole('button',{name:'关闭详情'}).click();assert.equal(await page.locator('#assetModelPreview').getAttribute('data-preview-state'),'disposed');await page.route('**/admin-models/*.glb',async route=>{await wait(250);await route.continue().catch(()=>{});});await page.getByRole('row').filter({has:page.locator('.name',{hasText:'珊瑚树'})}).getByRole('button',{name:'预览模型'}).click();await page.getByRole('button',{name:'关闭详情'}).click();await wait(400);assert.equal(await page.locator('#detail').evaluate(el=>el.open),false);await page.unroute('**/admin-models/*.glb');});
  await check('embedded texture loads locally and real animation plays and pauses',async()=>{await open('animated-textured-fixture.glb');assert.match(await page.locator('.model-stats').innerText(),/1 段动画/);assert.equal(await page.getByLabel('选择模型动画').inputValue(),'0');await page.getByRole('button',{name:'播放动画'}).click();const before=hash(await stage.screenshot());await wait(500);assert.notEqual(hash(await stage.screenshot()),before);await page.getByRole('button',{name:'暂停动画'}).click();const paused=hash(await stage.screenshot());await wait(250);assert.equal(hash(await stage.screenshot()),paused);await page.screenshot({path:resolve(evidence,'animated-texture.png')});});
  await check('quarantine clears existing preview and restores with retry',async()=>{await patchAsset(animated.id,'quarantined');await page.locator('#assetModelPreview[data-preview-state="error"]').waitFor({timeout:12000});assert.match(await page.locator('.model-message').innerText(),/隔离/);assert.equal(await canvas.isVisible(),false);await patchAsset(animated.id,'active');await page.getByRole('button',{name:'重新加载'}).click();await page.locator('#assetModelPreview[data-preview-state="ready"]').waitFor({timeout:30000});});
  await check('expired administrator session removes model and locks dashboard',async()=>{const tokens=new CreationStore(resolve(data,'creation/creation.sqlite'));for(const grant of tokens.list('creator_admin_session'))tokens.remove('creator_admin_session',grant.id);tokens.close();await page.locator('#bootError').waitFor({state:'visible',timeout:12000});assert.equal(await page.locator('#detail').evaluate(el=>el.open),false);assert.equal(await page.locator('#assetModelPreview').getAttribute('data-preview-state'),'disposed');});
  assert.deepEqual(blocked,[]);const unexpected=errors.filter(error=>!error.includes('401 (Unauthorized)'));assert.deepEqual(unexpected,[]);report.console_errors=errors;report.external_requests=blocked;report.completed=true;
}catch(error){report.error=error.stack;if(activePage){report.visible_text=await activePage.locator('body').innerText().catch(()=>null);await activePage.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});}throw error;}
finally{
  await browser?.close();if(child&&child.exitCode===null){const exited=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);await exited;clearTimeout(timeout);}
  rmSync(data,{recursive:true,force:true});report.temporary_data_removed=true;report.finished_at=new Date().toISOString();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));writeFileSync(resolve(evidence,'server.log'),serverLog);console.log('BROWSER_REPORT '+resolve(evidence,'report.json'));
}
