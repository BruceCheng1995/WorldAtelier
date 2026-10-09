/** Real workbench + HTTP/SQLite with explicit FAKE executor. Headless Chrome,
 * temporary data, port 48921; no model or Godot execution. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';
import {CreationAgentRuns} from '../../services/creation/agent-runs.mjs';

const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(resolve(tmpdir(),'atelier-image-browser-')),origin='http://127.0.0.1:48921';
const evidence=resolve(root,'.local/creation-verification/image-attachments',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(evidence,{recursive:true});
// Deterministic visible fixture: red square, green circle, blue triangle.
function referenceImage(){
  const w=480,h=240,raw=Buffer.alloc(h*(1+w*3));
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let color=[245,247,250];
    if(x>=35&&x<125&&y>=75&&y<165)color=[226,56,58];
    else if((x-240)**2+(y-120)**2<50**2)color=[40,169,96];
    else if(y>=65&&y<175&&Math.abs(x-400)<(y-65)*.55)color=[47,100,220];
    const offset=y*(1+w*3)+1+x*3;raw.set(color,offset);
  }
  const chunk=(type,data)=>{const payload=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of payload){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,payload,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const png=referenceImage();
class FakeExecutor extends EventEmitter{
  constructor(){super();this.connected=true;this.threads=new Map();this.turns=new Map();this.inputs=[];}
  async start(){} async listModels(){return {data:[{model:'FAKE-image-browser',displayName:'Explicit test executor',isDefault:true,supportedReasoningEfforts:[]}]};} async accountStatus(){return {account:{type:'FAKE-no-account'}};}
  async createThread(input){this.threads.set('FAKE-thread',{...input,loaded:true,busy:false,uncertain:false});return {thread:{id:'FAKE-thread',turns:[]}};}
  async sendTurn(threadId,input){this.inputs.push(structuredClone(input));const turn={id:'FAKE-turn-'+this.inputs.length,status:'completed',items:[]};this.turns.set(`${threadId}/${turn.id}`,turn);return {turn};} async stop(){}
}
let service,browser,page;
const report={scope:'Real browser and attachment persistence; explicitly fake executor, no model or Godot.',cases:[],page_errors:[]};
const server=createServer(async(req,res)=>{
  try{
    if(await service.request(req,res))return;
    const path=new URL(req.url,origin).pathname;
    let file=path==='/creation-workspace.html'?resolve(root,'apps/creation-workspace/index.html'):path.startsWith('/packages/')?resolve(root,path.slice(1)):resolve(root,'apps/creation-workspace',path.slice(1));
    if(!file.startsWith(root+'/')||!existsSync(file)){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]??'application/octet-stream'});res.end(readFileSync(file));
  }catch(e){if(!res.headersSent){res.writeHead(500);res.end(e.message);}else res.destroy();}
});
const saved=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(k=>[k,process.env[k]]);for(const [k]of saved)process.env[k]='1';
try{service=new CreationService({server,root,data,origin});}finally{for(const [k,v]of saved)v===undefined?delete process.env[k]:process.env[k]=v;}
const auth=service.store.register({name:'Image browser owner',password:'test-password'});
const project=service.store.createProject(auth.user,{name:'图片输入测试'},{schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',name:'测试空场景',kind:'scene',objects:[]}}}).project;
const session=service.store.createSession(auth.user,project.id,'main',{title:'图片附件输入',visibility:'private',effort:null}),other=service.store.createSession(auth.user,project.id,'main',{title:'另一个会话',visibility:'private',effort:null});
const executor=new FakeExecutor();service.agent=new CreationAgentRuns({service,adapter:executor});
const snapshot=()=>service.store.sessionView(auth.user,session.id);
const waitUntil=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,40));}throw Error('Browser state timed out');};
const chooseSession=async id=>{if(!await page.locator('#chatDrawer').isVisible())await page.locator('#agentsMenuButton').click();if(!await page.locator('#chatSessions').isVisible())await page.locator('#toggleSessions').click();await page.locator(`#sessionList [data-session="${id}"]`).click();await page.waitForFunction(id=>document.querySelector("#sessionDraft")?.dataset.session===id&&!document.querySelector("#attachImage").disabled,id);};
const check=async(name,fn)=>{await fn();report.cases.push(name);console.log('PASS '+name);};
try{
  await new Promise((yes,no)=>{server.once('error',no);server.listen(48921,'127.0.0.1',yes);});
  browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(token=>sessionStorage.setItem('world-atelier-creator-token',token),auth.token);page=await context.newPage();page.on('pageerror',e=>report.page_errors.push(e.message));
  await page.goto(origin+`/creation-workspace.html#/games/${project.id}/branches/main`);await page.locator('#workbench').waitFor({state:'visible'});await chooseSession(session.id);await page.locator('.reference-editor').waitFor({state:'visible'});
  const input=page.locator('#imageAttachmentInput'),thumbs=page.locator('#draftAttachments img[data-image-attachment]');
  await check('file picker upload renders authenticated thumbnail and preview; image-only composer can send',async()=>{
    await input.setInputFiles({name:'参考图.png',mimeType:'image/png',buffer:png});await waitUntil(()=>snapshot().draft_attachments.length===1);await page.waitForFunction(()=>document.querySelector('#draftAttachments img')?.naturalWidth>0);assert.equal(await page.locator('#sendDraft').isEnabled(),true);assert.equal(await page.locator('#sessionDraft').inputValue(),'');
    await thumbs.click();await page.locator('.attachment-full-image').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('.attachment-full-image')?.naturalWidth>0);await page.screenshot({path:resolve(evidence,'image-preview.png')});await page.locator('#modal').evaluate(el=>el.close());
  });
  await check('clipboard paste targets the real rich editor and preserves draft text',async()=>{
    await page.locator('.reference-editor').fill('请参考这些图片');
    await page.locator('.reference-editor').evaluate((el,base64)=>{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([bytes],'剪贴板.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},png.toString('base64'));
    await waitUntil(()=>snapshot().draft_attachments.length===2);assert.equal(await page.locator('#sessionDraft').inputValue(),'请参考这些图片');
  });
  await check('drop adds image and remove releases only the chosen attachment',async()=>{
    await page.locator('.composer-input').evaluate((el,base64)=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],'拖入.png',{type:'image/png'}));el.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));},png.toString('base64'));
    await waitUntil(()=>snapshot().draft_attachments.length===3);await page.locator('#draftAttachments [data-remove-reference]').last().click();await waitUntil(()=>snapshot().draft_attachments.length===2);
  });
  await check('switch and reload retain each session attachments without showing them in another session',async()=>{
    await chooseSession(other.id);assert.equal(await thumbs.count(),0);await chooseSession(session.id);await waitUntil(async()=>await thumbs.count()===2);
    await page.reload();await chooseSession(session.id);await waitUntil(async()=>await thumbs.count()===2);await page.waitForFunction(()=>[...document.querySelectorAll('#draftAttachments img')].every(i=>i.naturalWidth>0));await page.screenshot({path:resolve(evidence,'image-draft.png')});
  });
  await check('real send archives images and routes exact local files to the explicit fake executor',async()=>{
    await page.locator('.reference-editor').fill('');await page.locator('#sendDraft').click();await waitUntil(()=>executor.inputs.length===1);await waitUntil(()=>snapshot().messages.length===1);assert.equal(snapshot().messages[0].content,'');assert.equal(snapshot().messages[0].attachments.length,2);assert.equal(executor.inputs[0].images.length,2);for(const image of executor.inputs[0].images)assert.deepEqual(readFileSync(image.path),png);await page.waitForFunction(()=>document.querySelector('.sent-attachments img')?.naturalWidth>0);await page.screenshot({path:resolve(evidence,'image-sent.png')});
  });
  assert.deepEqual(report.page_errors,[]);report.completed=true;
}catch(error){report.error=error.message;report.visible=await page?.locator('body').innerText();console.log(report.visible);await page?.screenshot({path:resolve(evidence,'failure.png')});throw error;}finally{
  await browser?.close();await service.close();server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));rmSync(data,{recursive:true,force:true});writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));console.log('REPORT '+resolve(evidence,'report.json'));
}
