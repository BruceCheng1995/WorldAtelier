// Runs against an isolated copy of the shipped game. Each page logs in as its
// own user and runs an actual browser engine on the existing workbench route.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeSourceArchive} from '../../services/creation/native-source.mjs';
import {DefaultProjectBundle} from '../../services/creation/default-projects.mjs';
import {nativeObjectViews} from '../../services/creation/native-view.mjs';
import {Evidence,IsolatedService,ORIGIN,request,waitFor} from './next-wave-test-support.mjs';

const evidence=new Evidence('three-workbench-journeys',{layers:['browser','native source transaction','two accounts']});
const liveAgent=process.env.WA_PARITY_LIVE_AGENT==='1';
const service=new IsolatedService(evidence,{agent:liveAgent,environment:{WORLD_ATELIER_DEFAULT_PROJECTS:'0'}});
const bundle=new DefaultProjectBundle(join(evidence.root,'content/default-projects'));
const sample=bundle.catalog.projects.find(project=>project.name==='俄罗斯方块');
const manifest=bundle.snapshot(sample.branches.find(branch=>branch.id==='main'));
const entry=manifest.entry_scene_id;
mkdirSync(service.creationData,{recursive:true});
const store=new CreationStore(join(service.creationData,'creation.sqlite'));
const archive=new NativeSourceArchive(join(service.creationData,'native-source','objects'));
for(const file of Object.values(manifest.source_files))archive.put(bundle.readObject(file.hash));
const alice=store.register({name:'对照 A',password:randomUUID()}),bob=store.register({name:'对照 B',password:randomUUID()});
const {project,branch}=store.createProject(alice.user,{name:'俄罗斯方块 · 双端回归'},manifest);
const record=store.projectFor(alice.user,project.id);
record.members[bob.user.id]='editor';store.put('creator_project',record);store.close();
const object=nativeObjectViews(manifest,entry,{project_id:project.id,branch_id:'main'}).find(o=>o.source_node_id==='tetris-game');
const path='/creation-api/projects/'+project.id+'/branches/main',workbench=ORIGIN+'/creation-workspace.html#/games/'+project.id+'/branches/main';
let browser,a,b;
const peerPackets=new WeakMap();
const observed={input:manifest.source_identity,project:project.id,base:branch.head};
evidence.report.journeys=observed;
async function open(actor,url){
  const context=await browser.newContext({viewport:{width:1480,height:940}});
  await context.addInitScript(({token,origin})=>{if(location.origin===origin)sessionStorage.setItem('world-atelier-creator-token',token);},{token:actor.token,origin:ORIGIN});
  const page=await context.newPage();page.setDefaultTimeout(30000);
  peerPackets.set(page,[]);
  page.on('websocket',ws=>ws.on('framereceived',frame=>{
    try{const value=JSON.parse(frame.payload);if(value.type==='presence')peerPackets.get(page).push(value.peers);}catch{}
  }));
  page.on('pageerror',error=>{evidence.report.errors.push({page:error.message});evidence.save();});
  await page.goto(url);return page;
}
async function editor(page,head,engine){
  await page.waitForFunction(({head,engine})=>{
    const data=document.querySelector('#mainPreview')?.dataset;
    return data?.previewState==='ready'&&data.displayedSource===head&&data.editorEngine===engine;
  },{head,engine},{timeout:180000});
}
async function run(page,engine){
  await page.locator('[data-mode="play"]').click();
  await page.waitForFunction(engine=>document.querySelector('#mainPreview').dataset.gameEngine===engine&&document.querySelector('#playControls').dataset.mode==='playing',engine,{timeout:240000});
  return page.locator('#playControls').evaluate(node=>({revision:node.dataset.displayRevision,tick:Number(node.dataset.tick),world:node.dataset.worldId}));
}
try{
  await service.start();
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio','--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  a=await open(alice,workbench);
  await editor(a,branch.head,'three');
  const parent=a.locator('#explorerList [data-select]').filter({hasText:'GameUI'}).first();
  if(await parent.getAttribute('aria-expanded')==='false')await parent.locator('[data-tree-fold]').click();
  await a.locator('#explorerList [data-select]').evaluateAll((rows,id)=>{const row=rows.find(el=>el.dataset.select===id);if(!row)throw Error('missing Tetris control');row.click();},object.id);
  const x=a.locator('[data-control-field="position"][data-control-axis="0"]');
  assert.equal(await x.inputValue({timeout:10000}),'0');
  await x.fill('100');await x.press('Enter');
  const head=await waitFor('real edited revision',async()=>{
    const value=(await request('GET',path,{actor:alice})).value;
    return value.head!==branch.head&&value.head;
  });
  observed.edited=head;evidence.save();console.log('source edit',head);await editor(a,head,'three');
  if(liveAgent){
    await a.locator('#agentsMenuButton').click();
    await a.waitForFunction(()=>Boolean(document.querySelector('#sessionDraft')?.dataset.session));
  }
  // Use a non-default viewpoint so a renderer reset cannot pass unnoticed.
  const area=await a.frameLocator('#mainPreview iframe').locator('canvas').first().boundingBox();
  await a.mouse.move(area.x+area.width*.28,area.y+area.height*.32);await a.mouse.wheel(0,-180);
  await a.waitForFunction(()=>Math.abs(JSON.parse(document.querySelector('#mainPreview').dataset.camera).target[0]-560)>1);
  const target=await a.locator('#mainPreview').evaluate(node=>JSON.parse(node.dataset.camera).target);
  for(const engine of ['godot','three']){
    await a.locator('#toggleAnnotations').click();await editor(a,head,engine);
    await a.waitForFunction(t=>JSON.parse(document.querySelector('#mainPreview').dataset.camera).target.every((x,i)=>Math.abs(x-t[i])<.05),target);
  }
  observed.annotationCamera=target;
  const before=await run(a,'three');assert.equal(before.revision,head);observed.firstRun=before;evidence.save();console.log('Three running',head);
  const game=await waitFor('Three authored HUD',async()=>a.frames().find(f=>/\/web\/index.html/.test(f.url())&&f.url().includes('nonce=')));
  const start=game.locator('[data-control="main"]');await start.waitFor({state:'visible'});
  const point=await start.evaluate(el=>{
    const b=el.getBoundingClientRect(),c=document.querySelector('canvas').getBoundingClientRect();
    return [(b.left+b.width/2-c.left)/c.width,(b.top+b.height/2-c.top)/c.height];
  });
  observed.startButton=point;await a.locator('#viewport').screenshot({path:join(evidence.directory,'three-edited-play.png')});
  await a.locator('[data-mode="inspect"]').click();await a.waitForFunction(()=>document.querySelector('#playControls').dataset.mode==='inspecting');
  if(liveAgent){
    await a.locator('.play-context-entry-button').click();
    const surface=a.locator('.play-context-focus-surface');await surface.waitFor();
    await surface.locator('img').evaluate(img=>img.decode());
    await surface.screenshot({path:join(evidence.directory,'paused-entry-agent.png')});
    const rect=await surface.boundingBox();await a.mouse.click(rect.x+point[0]*rect.width,rect.y+point[1]*rect.height);
    const draft=a.locator('#sessionDraft');
    if(!await a.locator('.reference-editor').isVisible())await a.locator('#agentsMenuButton').click();
    await a.locator('.reference-editor').fill('请读取本条消息附带的试玩过程与关注画面。用一句话回答我指出的按钮文字，以及它来自哪款游戏。只观察，不修改工程。');
    const captured=a.waitForResponse(r=>r.url().includes('/play-context/captures')&&r.request().method()==='POST');
    await a.locator('#sendDraft').click();
    const response=await captured;
    assert.equal(response.status(),201);const sent=response.request().postDataJSON();
    const frame=sent.frames.find(f=>f.id===sent.focus.frame_id);assert.ok(frame?.projection?.synchronized);
    const hits=frame.projection.objects.filter(o=>sent.focus.runtime_ids.includes(o.runtime_id));
    assert.ok(hits.some(o=>/开始游戏/.test(o.name)),JSON.stringify(hits));
    observed.agentFocus={session:await draft.getAttribute('data-session'),hits:hits.map(o=>o.name),revision:sent.scope.source_revision};
    evidence.save();
  }
  if(await a.locator('#chatClose').isVisible())await a.locator('#chatClose').click();
  await a.locator('[data-mode="edit"]').click();await editor(a,head,'three');
  await a.locator('#viewportMore summary').click();
  const popupEvent=a.waitForEvent('popup');await a.locator('#compareEngine').click();
  const popup=await popupEvent;await popup.waitForURL(url=>url.searchParams.has('compareRevision'));
  const link=popup.url();await popup.close();assert.equal(new URL(link).searchParams.get('compareRevision'),head);
  if(liveAgent)await request('POST',path+'/sessions',{actor:bob,body:{title:'Godot 对照观察',visibility:'private'},expected:201});
  b=await open(bob,link);await editor(b,head,'godot');
  assert.equal(await b.locator('#sourceBadge').getAttribute('title'),head);
  assert.equal(new URL(link).searchParams.get('compareSelection'),object.id);
  const bookmark=JSON.parse(new URL(link).searchParams.get('compareCamera'));
  if(bookmark)await b.waitForFunction(target=>{
    const current=JSON.parse(document.querySelector('#mainPreview').dataset.camera??'null');
    return current?.target?.every((n,i)=>Math.abs(n-target[i])<.01);
  },bookmark.target);
  observed.comparisonCamera=bookmark;await b.screenshot({path:join(evidence.directory,'second-account-godot.png')});
  // B signs in independently. A real later commit must never retarget either comparison page.
  const result=await request('POST',path+'/transactions',{actor:bob,body:{transaction_id:randomUUID(),base_revision:head,ops:[{type:'native_scene_operation',resource_id:entry,expected_version:(await request('GET',path,{actor:bob})).value.manifest.resources[entry].version,operation:{op:'control_layout',target:object.native_target,value:{offsets:[160,0,160,0]}}}]}});
  assert.notEqual(result.value.branch.head,head);
  for(const page of [a,b]){
    await page.waitForFunction(()=>document.querySelector('#sourceStatus').textContent.includes('分支有更新'));
    assert.equal(await page.locator('#sourceBadge').getAttribute('title'),head);
  }
  observed.later=result.value.branch.head;
  // The branch advanced, yet both pinned clients still select the same older address.
  const peers=await waitFor('two pinned selections',async()=>peerPackets.get(a).at(-1)?.filter(p=>p.selected_source_revision===head&&p.selected_id===object.id).length===2);
  observed.pinnedSelections=peers;
  evidence.save();
  observed.comparison=await Promise.all([run(a,'three'),run(b,'godot')]);
  assert.ok(observed.comparison.every(r=>r.revision===head));assert.notEqual(observed.comparison[0].world,observed.comparison[1].world);
  if(liveAgent){
    const session=(await request('GET','/creation-api/sessions/'+observed.agentFocus.session,{actor:alice})).value;
    const completed=await waitFor('real Agent read-only reply',async()=>{
      const value=(await request('GET','/creation-api/sessions/'+session.id,{actor:alice})).value;
      if(value.runs?.some(run=>['failed','interrupted','waiting_input'].includes(run.status)))throw Error('Agent stopped: '+JSON.stringify(value.runs.map(r=>({status:r.status,error:r.error}))));
      return value.runs?.some(run=>run.status==='completed')&&value;
    },{timeout:180000});
    observed.agentReply=completed.messages.filter(m=>m.role==='assistant').map(m=>m.text??m.content);
    assert.ok(observed.agentReply.some(msg=>JSON.stringify(msg).includes('开始')),JSON.stringify(observed.agentReply));
  }
  if(liveAgent){
    await b.locator('[data-mode="inspect"]').click();
    await b.locator('.play-context-entry-button').click();
    const picture=b.locator('.play-context-focus-surface img');await picture.evaluate(img=>img.decode());
    const box=await picture.boundingBox();await b.mouse.click(box.x+point[0]*box.width,box.y+point[1]*box.height);
    assert.match(await b.locator('.play-context-status').innerText(),/个可能相关对象/);
    observed.godotEntryFocus=true;
  }
  await b.locator('[data-mode="edit"]').click();await editor(b,head,'godot');
  const memberPath='/creation-api/projects/'+project.id+'/members/'+bob.user.id;
  await request('PATCH',memberPath,{actor:alice,body:{role:'viewer',request_id:randomUUID()}});
  await request('PATCH',memberPath,{actor:alice,body:{role:null,request_id:randomUUID()}});
  await b.waitForFunction(()=>!location.search.includes('compareRevision')&&document.querySelector('#workbench').hidden);
  await request('GET',path+'?revision='+head,{actor:bob,expected:403});
  observed.revoked=true;
  evidence.report.completed=true;
}catch(error){
  for(const [name,page] of [['a',a],['b',b]])if(page){
    evidence.json(name+'-status.json',await page.evaluate(()=>({status:document.querySelector('#workspaceStatus')?.textContent,source:document.querySelector('#sourceStatus')?.textContent,preview:{...document.querySelector('#mainPreview')?.dataset},toast:document.querySelector('#toast')?.textContent})).catch(()=>null));
    await page.screenshot({path:join(evidence.directory,name+'-failure.png')}).catch(()=>{});
  }
  evidence.report.errors.push({error:String(error.stack??error)});throw error;
}finally{
  await browser?.close();await service.stop();service.removeData();evidence.save();console.log(evidence.directory);
}
