// Actual DOM/pointer/canvas + real HTTP/SQLite observation routes. The game
// packets and images are explicit transport fixtures; no Godot/Agent claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {chromium} from '@playwright/test';
import {contextFixture} from './play-context-fixture.mjs';

test('focused play feedback freezes real browser frames, can be removed, retries once and continues privately',{timeout:60000},async t=>{
  const f=contextFixture(t,{liveTimeout:5000}),root=resolve(import.meta.dirname,'../..'),origin='http://127.0.0.1:49032',auth=f.store.issueLogin(f.owner).token;
  f.store.fork(f.owner,f.p,{from_branch:'main',branch_id:'night',name:'Night',expected_head:f.revision.id});
  let dropCaptureResponse=false;
  const harness=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/play-context.css"><style>body{font:14px system-ui;margin:20px}#viewport{position:relative;width:800px;height:500px;background:#486859}#composer{width:800px}button{padding:8px}canvas{width:100%;height:100%}</style><div id="viewport"><canvas id="frame" width="800" height="500"></canvas></div><div id="composer"></div><button id="send">Save observation</button><button id="continue">Continue branch</button><div id="status"></div><script type="module">
import {PlayContextController} from '/play-context.js';
import {openSessionContinuation} from '/session-continuation.js';
const session=${JSON.stringify(f.store.sessionView(f.owner,f.session.id))},scope=${JSON.stringify(f.scope)},job=${JSON.stringify(f.build)};
let sequence=0;const canvas=document.querySelector('#frame'),paint=canvas.getContext('2d');paint.fillStyle='#74aa82';paint.fillRect(0,0,800,500);paint.fillStyle='#e0c975';paint.fillRect(400,250,80,50);
const context=window.ctx={user_id:${JSON.stringify(f.owner.id)},project_id:scope.project_id,branch_id:'main',session_id:session.id,session_generation:1,can_write:true,mode:'play',mode_pending:false,session};
const request=window.request=async(path,options={})=>{const response=await fetch('/creation-api/'+path,{method:options.method??'GET',headers:{Authorization:'Bearer '+${JSON.stringify(auth)},'Content-Type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})});const body=await response.json();if(!response.ok)throw Object.assign(Error(body.error),{status:response.status});return body;};
const preview=window.preview={job,nonce:scope.runtime_instance_id,sceneGeneration:1,commandSeq:1,seq:1,ready:true,host:document.querySelector('#viewport'),sceneContext:{document_id:scope.project_id+'/main/room',source_revision:scope.source_revision},
captureFrame:async()=>({data_url:canvas.toDataURL('image/png'),source_revision:scope.source_revision,scene_generation:1,document_id:scope.project_id+'/main/room'}),
post:packet=>{if(packet.type==='context_request'){const deliver=()=>controller.accept({type:'play_context',protocol:'wa-play-context-1',runtime_instance_id:scope.runtime_instance_id,source_revision:scope.source_revision,resource_id:'room',scene_generation:1,sequence:++sequence,kind:'snapshot',request_id:packet.request_id,payload:{objects:[{runtime_id:'one',name:'Door',screen_bounds:[.1,.1,.2,.2],visible:true,source:{address:${JSON.stringify(f.row.address)},object_version:${JSON.stringify(f.row.version)}}}],mode:context.mode,text_input_regions:[[.5,.5,.1,.1]],input_regions_complete:true}});if(window.delaySnapshot)window.deliverSnapshot=deliver;else queueMicrotask(deliver);}}
};
const controller=window.controller=new PlayContextController({composer:document.querySelector('#composer'),viewport:document.querySelector('#viewport'),request,getContext:()=>context,preview:()=>preview,requestInspect:async()=>{context.mode='inspect';controller.update();},onSession:value=>context.session=value,onError:error=>window.uiError=error.message});
controller.update();window.emitInput=()=>controller.accept({type:'play_context',protocol:'wa-play-context-1',runtime_instance_id:scope.runtime_instance_id,source_revision:scope.source_revision,resource_id:'room',scene_generation:1,sequence:++sequence,kind:'event',payload:{kind:'pointer_down',source:'user_input',payload:{button:1,position:[.6,.4]}}});window.emitInput();
document.querySelector('#send').onclick=async()=>{window.sentResult=null;window.uiError=null;try{window.sentResult=await controller.beforeSend();document.querySelector('#status').textContent='saved';}catch(error){window.uiError=error.message;document.querySelector('#status').textContent='failed';}};
document.querySelector('#continue').onclick=()=>openSessionContinuation({session:context.session,branches:${JSON.stringify(f.store.list('creator_branch').filter(branch=>branch.project_id===f.p))},request,getContext:()=>context,onCreated:result=>window.continued=result,onError:error=>window.uiError=error.message});
</script>`;
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,origin),path=url.pathname;
      if(path==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(harness);return;}
      if(path.startsWith('/creation-api/')){
        if(req.method!=='GET'&&req.headers.origin!==origin)throw Object.assign(Error('Origin'),{status:403});
        const user=f.store.authenticate(String(req.headers.authorization??'').replace(/^Bearer /,'')),parts=path.slice('/creation-api/'.length).split('/').map(decodeURIComponent);
        const body=async(max=4*1024*1024)=>{const chunks=[];let size=0;for await(const bytes of req){size+=bytes.length;if(size>max)throw Error('large');chunks.push(bytes);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');};
        if(dropCaptureResponse&&parts[2]==='play-context'&&parts[3]==='captures'){dropCaptureResponse=false;f.service.observations.capture(user,parts[1],await body());res.writeHead(200,{'Content-Type':'application/json'});res.end('{"interrupted_response":');return;}
        if(await f.service.observations.request(req,res,user,parts,body))return;
        if(await f.service.continuations.request(req,res,user,parts,body))return;
        let value;
        if(parts[0]==='sessions'&&parts.length===2&&req.method==='GET')value=f.store.sessionView(user,parts[1]);
        else if(parts[0]==='sessions'&&parts[2]==='attachments'&&req.method==='DELETE')value=f.store.removeAttachment(user,parts[1],parts[3]);
        else throw Object.assign(Error('not found'),{status:404});
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));return;
      }
      const file=path.startsWith('/packages/contracts/')?resolve(root,'.'+path):resolve(root,'apps/creation-workspace','.'+path);
      const allowed=new Set(['play-context.js','play-context-buffer.js','play-context.css','session-continuation.js','client-platform.js','play-context.mjs']);
      if(!file.startsWith(root+'/')||!allowed.has(file.split('/').at(-1))||!existsSync(file))throw Object.assign(Error('not found'),{status:404});
      res.writeHead(200,{'Content-Type':extname(file)==='.css'?'text/css':'text/javascript'});res.end(readFileSync(file));
    }catch(error){if(!res.headersSent)res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  let browser;
  try{
    await new Promise((yes,no)=>{server.once('error',no);server.listen(49032,'127.0.0.1',yes);});
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.waitForFunction(()=>window.controller?.runtime);assert.equal(f.store.list('creator_play_observation').length,0,'unsent local buffer is not uploaded');
    console.log('PLAY_CONTEXT_UI ready');
    assert.equal(await page.locator('[data-play-context-range]').inputValue(),'60');
    await page.locator('[data-play-context-focus]').click();const layer=page.locator('.play-context-focus-layer');await layer.waitFor({state:'visible'});const box=await layer.boundingBox();
    await page.mouse.move(box.x+box.width*.7,box.y+box.height*.1);await page.mouse.down();await page.mouse.move(box.x+box.width*.9,box.y+box.height*.25,{steps:5});await page.mouse.up();await layer.waitFor({state:'hidden'});
    console.log('PLAY_CONTEXT_UI focus fixed');
    await page.locator('#send').click();await page.waitForFunction(()=>window.sentResult!==null||window.uiError);assert.equal(await page.evaluate(()=>window.uiError),null);
    let stored=f.store.list('creator_play_observation');assert.equal(stored.length,1);assert.equal(stored[0].focus.kind,'screen_region');assert.deepEqual(stored[0].focus.runtime_ids,[],'empty canvas remains valid focus');
    console.log('PLAY_CONTEXT_UI first capture saved');
    const frame=f.service.observations.image(f.owner,f.session.id,stored[0].id,stored[0].frames.at(-1).id);
    const pixel=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);return [...canvas.getContext('2d').getImageData(440,270,1,1).data];},`data:${frame.frame.mime};base64,${frame.bytes.toString('base64')}`);
    assert.ok(pixel[0]<50&&pixel[1]<60&&pixel[2]<50,'text input area is obscured in automatic keyframes');
    await page.locator('[data-play-context-include]').uncheck();await page.waitForFunction(()=>window.ctx.session.draft_attachments.length===0);assert.equal(f.store.sessionFor(f.owner,f.session.id).draft_attachments.length,0,'removal also removes related frame visual inputs');
    console.log('PLAY_CONTEXT_UI removed');
    await page.locator('[data-play-context-include]').check();await page.locator('[data-play-context-range]').selectOption('180');
    dropCaptureResponse=true;await page.locator('#send').click();await page.waitForFunction(()=>window.uiError);const count=f.store.list('creator_play_observation').length;assert.equal(count,2,'lost response happened after durable capture');
    await page.locator('#send').click();await page.waitForFunction(()=>window.sentResult!==null);assert.equal(f.store.list('creator_play_observation').length,count,'retry preserves original immutable request');
    console.log('PLAY_CONTEXT_UI retry recovered');
    const source=f.store.sessionView(f.owner,f.session.id),message=f.store.appendMessage(f.session.id,{role:'user',content:'Continue this captured problem',attachments:source.draft_attachments});
    await page.evaluate(async()=>{window.ctx.session=await window.request('sessions/'+window.ctx.session_id);});await page.locator('#continue').click();await page.locator('[data-continuation-evidence]').uncheck();await page.locator('[data-continuation-objective]').fill('Continue in night branch');await page.locator('[data-continuation-submit]').click();await page.waitForFunction(()=>window.continued);
    const continued=await page.evaluate(()=>window.continued);assert.equal(continued.session.visibility,'private');assert.equal(continued.context.cutoff_message_id,message.id);assert.deepEqual(continued.context.observation_ids,[]);assert.equal(continued.session.executor_thread_id,null);
    const alternate=f.store.createSession(f.owner,f.p,'main',{title:'Another existing session',visibility:'private'});
    await page.evaluate(session=>{window.ctx.session_id=session.id;window.ctx.session=session;window.ctx.session_generation++;window.controller.update();},f.store.sessionView(f.owner,alternate.id));
    assert.equal(await page.locator('[data-play-context-include]').isChecked(),false,'switching existing sessions requires an explicit opt-in');
    const beforeSwitch=f.store.list('creator_play_observation').length;assert.equal(await page.evaluate(()=>window.controller.beforeSend()),null);assert.equal(f.store.list('creator_play_observation').length,beforeSwitch);
    await page.evaluate(old=>window.controller.sent({session_id:old}),f.session.id);assert.equal(await page.locator('[data-play-context-include]').isChecked(),false,'late prior send does not opt in the new session');
    await page.locator('[data-play-context-include]').check();await page.locator('#send').click();await page.waitForFunction(()=>window.sentResult!==null);assert.equal(f.store.list('creator_play_observation').filter(row=>row.session_id===alternate.id).length,1);
    assert.deepEqual(errors,[]);await page.evaluate(()=>window.controller.dispose());
  }finally{await browser?.close();await new Promise(resolveClose=>server.close(resolveClose));}
});
