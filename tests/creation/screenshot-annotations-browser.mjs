/** Independent screenshot editor checks: real HTML Canvas/PointerEvents and PNG
 * exports in headless Chrome, explicit fixed image and save callback doubles.
 * Only port 48921; no Godot, model execution, service data or product source writes.
 * Full HTTP/SQLite/Agent-image routing is covered by image-attachments-browser.mjs.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {extname,resolve,sep} from 'node:path';
import {chromium} from '@playwright/test';

const root=resolve(import.meta.dirname,'../..'),app=resolve(root,'apps/creation-workspace'),origin='http://127.0.0.1:48921';
const evidence=resolve(root,'.local/creation-verification/screenshot-annotations',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(evidence,{recursive:true});
const report={scope:'Real screenshot editor, pointer drawing and exported PNG pixels; explicitly synthetic source image and save callbacks. No model or Godot.',cases:[],page_errors:[]};
const harness=`<!doctype html><meta charset="utf-8"><title>Independent screenshot annotation check</title><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/viewport-annotations.css"><button id="open">Open screenshot editor</button><script type="module">
import {editScreenshot} from '/image-attachments.js';
const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');ctx.fillStyle='#e9eff5';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#496785';ctx.fillRect(60,500,1160,120);ctx.fillStyle='#95b886';ctx.fillRect(880,80,260,260);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1280,12);
window.fixture=canvas.toDataURL('image/png');window.saved=[];window.saveMode='success';window.saveCalls=0;
window.openEditor=()=>{window.result=undefined;window.editorError=null;window.editorPromise=editScreenshot({dataUrl:window.fixture,subtitle:'固定场景 / main / revision-fixture <img src=x onerror=alert(1)>',onSave:async packet=>{
window.saveCalls++;if(window.saveMode==='error'){window.saveMode='success';throw Error('独立上传失败夹具');}
if(window.saveMode==='pending')await new Promise(resolve=>window.resolveSave=resolve);
const image=await createImageBitmap(packet.blob),out=document.createElement('canvas');out.width=image.width;out.height=image.height;const output=out.getContext('2d');output.drawImage(image,0,0);image.close();
window.saved.push({note:packet.note,strokeCount:packet.strokeCount,width:packet.width,height:packet.height,mime:packet.blob.type,bytes:packet.blob.size,image:out.toDataURL('image/png')});
}}).then(result=>window.result=result).catch(error=>window.editorError=error.message);};document.querySelector('#open').onclick=window.openEditor;
</script>`;
const server=createServer((req,res)=>{
  const path=new URL(req.url,origin).pathname;
  if(path==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(harness);return;}
  const file=resolve(app,'.'+path);
  if(!file.startsWith(app+sep)||!existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});res.end(readFileSync(file));
});
let browser,page;
const check=async(name,fn)=>{await fn();report.cases.push(name);console.log('SCREENSHOT_ANNOTATION_PASS '+name);};
try{
  // listen fails on conflicts; never stop or reuse another test process.
  await new Promise((yes,no)=>{server.once('error',no);server.listen(48921,'127.0.0.1',yes);});
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2});page=await context.newPage();page.on('pageerror',e=>report.page_errors.push(e.message));
  await page.goto(origin);await page.waitForFunction(()=>typeof window.openEditor==='function');
  const dialog=page.locator('.screenshot-annotation-editor'),canvas=page.getByLabel('截图划线画布',{exact:true}),action=name=>dialog.locator(`[data-markup-action="${name}"]`).last();
  const open=async()=>{await page.locator('#open').click();await dialog.waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('canvas[aria-label="截图划线画布"]')?.width===1280);};
  const pixels=()=>canvas.evaluate(el=>el.toDataURL('image/png'));
  const stroke=async(tool,from,to)=>{await dialog.locator(`[data-markup-tool="${tool}"]`).click();const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*from[0],box.y+box.height*from[1]);await page.mouse.down();await page.mouse.move(box.x+box.width*to[0],box.y+box.height*to[1],{steps:14});await page.mouse.up();};
  const closed=async value=>{await page.waitForFunction(value=>window.result===value,value);assert.equal(await dialog.count(),0);assert.equal(await page.evaluate(()=>window.editorError),null);};
  await check('DPR 2 scaled drawing, undo/redo and pen/arrow/rectangle alter actual image pixels',async()=>{
    await open();assert.equal(await dialog.locator('img[src=x]').count(),0);assert.equal(await action('save').isEnabled(),false);
    const original=await pixels();await stroke('pen',[.15,.25],[.45,.25]);const pen=await pixels();assert.notEqual(pen,original);
    const bounds=await canvas.evaluate(async(el,url)=>{const original=new Image();original.src=url;await original.decode();const old=document.createElement('canvas');old.width=el.width;old.height=el.height;old.getContext('2d').drawImage(original,0,0);const a=old.getContext('2d').getImageData(0,0,el.width,el.height).data,b=el.getContext('2d').getImageData(0,0,el.width,el.height).data;let minX=el.width,maxX=0,minY=el.height,maxY=0,count=0;for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]){const n=i/4,x=n%el.width,y=Math.floor(n/el.width);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);count++;}return{minX,maxX,minY,maxY,count};},original);
    assert.ok(bounds.count>300);assert.ok(Math.abs(bounds.minX-1280*.15)<20&&Math.abs(bounds.maxX-1280*.45)<20,JSON.stringify(bounds));assert.ok(Math.abs(bounds.minY-720*.25)<20&&Math.abs(bounds.maxY-720*.25)<20,JSON.stringify(bounds));report.drawing_bounds=bounds;
    await action('undo').click();assert.equal(await pixels(),original);await action('redo').click();assert.equal(await pixels(),pen);
    await stroke('arrow',[.2,.55],[.55,.65]);await stroke('rect',[.68,.15],[.9,.46]);assert.notEqual(await pixels(),pen);
    await page.screenshot({path:resolve(evidence,'editor-dpr2.png')});
  });
  await check('save exports rendered marks and note at original dimensions; resolves once and removes editor',async()=>{
    await page.getByLabel('截图批注说明',{exact:true}).fill('沿划线路径延伸，箭头所指的位置增加入口。');const expected=await pixels();await action('save').click();await closed(true);
    const saved=await page.evaluate(()=>window.saved.at(-1));assert.equal(saved.image,expected);assert.equal(saved.width,1280);assert.equal(saved.height,720);assert.equal(saved.strokeCount,3);assert.equal(saved.note,'沿划线路径延伸，箭头所指的位置增加入口。');assert.equal(saved.mime,'image/png');assert.ok(saved.bytes>0&&saved.bytes<=5*1024*1024);writeFileSync(resolve(evidence,'marked-export.png'),Buffer.from(saved.image.split(',')[1],'base64'));
  });
  await check('clear removes marks and cancel/Escape leave save callbacks untouched',async()=>{
    const saves=await page.evaluate(()=>window.saveCalls);await open();const initial=await pixels();await stroke('pen',[.15,.2],[.4,.3]);const beforeClear=await pixels();await action('clear').click();assert.equal(await pixels(),initial);await action('undo').click();assert.equal(await pixels(),beforeClear);await action('redo').click();assert.equal(await pixels(),initial);await action('cancel').click();await closed(false);assert.equal(await page.evaluate(()=>window.saveCalls),saves);
    await open();await stroke('pen',[.2,.3],[.4,.35]);await page.keyboard.press('Escape');await closed(false);assert.equal(await page.evaluate(()=>window.saveCalls),saves);
  });
  await check('failed save retains drawing and note for retry without duplicate successful export',async()=>{
    await page.evaluate(()=>window.saveMode='error');await open();await stroke('arrow',[.2,.3],[.5,.4]);await page.getByLabel('截图批注说明',{exact:true}).fill('失败后保留的说明');const before=await pixels();await action('save').click();await dialog.getByText('独立上传失败夹具',{exact:true}).waitFor();assert.equal(await pixels(),before);assert.equal(await page.getByLabel('截图批注说明',{exact:true}).inputValue(),'失败后保留的说明');assert.equal(await action('save').isEnabled(),true);await action('save').click();await closed(true);assert.equal(await page.evaluate(()=>window.saved.at(-1).image),before);
  });
  await check('pending save blocks duplicate commit and Escape, then releases editor on success',async()=>{
    await page.evaluate(()=>window.saveMode='pending');await open();await stroke('pen',[.1,.15],[.3,.18]);const count=await page.evaluate(()=>window.saveCalls);await action('save').click();await page.waitForFunction(()=>typeof window.resolveSave==='function');assert.equal(await action('save').isEnabled(),false);await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true);assert.equal(await page.evaluate(()=>window.saveCalls),count+1);await page.evaluate(()=>window.resolveSave());await closed(true);await page.evaluate(()=>window.saveMode='success');
  });
  await check('compact desktop viewport fits editor controls and exports without scaling coordinates',async()=>{
    await page.setViewportSize({width:820,height:700});await open();const box=await dialog.boundingBox(),can=await canvas.boundingBox();assert.ok(box.x>=-1&&box.y>=-1&&box.x+box.width<=821&&box.y+box.height<=701,JSON.stringify(box));assert.ok(can.width>200&&can.height>100);assert.equal(await action('save').isVisible(),true);await stroke('rect',[.2,.2],[.8,.75]);await page.screenshot({path:resolve(evidence,'editor-compact.png')});await action('save').click();await closed(true);assert.equal(await page.evaluate(()=>window.saved.at(-1).width),1280);
  });
  assert.deepEqual(report.page_errors,[]);report.completed=true;
}catch(error){report.error=error.stack;if(page){report.visible=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});}throw error;
}finally{await browser?.close();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));console.log('REPORT '+resolve(evidence,'report.json'));}
