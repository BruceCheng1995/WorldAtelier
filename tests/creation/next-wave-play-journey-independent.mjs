/** Actual original workbench + canonical Godot Web + real Codex creation turn.
 * No runtime ACK, accepted message, source repair or result is fabricated.
 * Own 48921/temp data only. Retain fixed inputs and reports for later review. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {Evidence,IsolatedService,ORIGIN,request,registerActor,waitFor,delay} from './next-wave-test-support.mjs';
import {nativeImportFiles} from './next-wave-author-fixture.mjs';

const evidence=new Evidence('play-journey-independent',{layers:['A','G','B','C'],scope:'Original workbench, actual canonical Godot Web, real input/capture/default60s/focus and real Codex source repair. Only the explicitly executed steps count.'});
const service=new IsolatedService(evidence,{agent:true,worlds:false,publicPlay:true});
let browser,context,page,actor,project,source,session,branchRoute,buildId,firstUrl,observationId,runId,lastPlayJob,completed=false;
const logs=[],httpWrites=[],pageErrors=[],responses=[];
const state=()=>page.evaluate(()=>({mode:document.querySelector('#stage')?.dataset.previewMode,dataset:{...document.querySelector('#mainPreview')?.dataset},build:document.querySelector('#mainPreview')?.dataset.gameBuild,scene_generation:document.querySelector('#mainPreview')?.dataset.sceneGeneration,status:document.querySelector('#workspaceStatus')?.textContent,render:[...document.querySelectorAll('#mainPreview .render-status')].map(el=>el.textContent)}));
const currentSnapshot=()=>page.evaluate(()=>[...(window.__nextWaveEvents??[])].reverse().find(row=>row.data.type==='play_context'&&row.data.kind==='snapshot')?.data??null);
const counterText=async()=>{const snapshot=await currentSnapshot();return snapshot?.payload?.objects?.find(row=>row.name==='Counter')?.control?.text??'';};
async function gameFrame(){return waitFor('actual isolated Godot game frame',()=>page.frames().find(frame=>frame.url().includes('/creation-runtime/')&&frame.url().includes('/web/index.html')),{timeout:120000,interval:250});}
async function mode(expected,{differentBuild=null}={}){
  await waitFor('original UI mode '+expected,async()=>{
    const actual=await state();
    if(lastPlayJob){const job=(await request('GET',`/creation-api/builds/${lastPlayJob}`,{actor})).value.job;if(['failed','interrupted'].includes(job.status))throw Error('Actual fixed Play build '+job.id+' '+job.status+': '+(job.error??job.stage));}
    if(actual.mode==='edit'&&/超时|运行失败|准备失败/.test(actual.status??''))throw Error('Original UI returned to source: '+actual.status);
    return actual.mode===expected&&actual.build&&(!differentBuild||actual.build!==differentBuild)&&actual;
  },{timeout:240000,interval:500});
}
async function selectSession(){
  if(await page.locator('#chatDrawer').evaluate(el=>el.hidden))await page.locator('#agentsMenuButton').click();
  if(await page.locator('#sessionId').inputValue()!==session.id){await page.locator('#toggleSessions').click();await page.locator(`button[data-session="${session.id}"]`).click();}
  await page.waitForFunction(sid=>document.querySelector('#sessionId')?.value===sid,session.id);
}
async function pressE(){const frame=await gameFrame(),canvas=frame.locator('canvas');const box=await canvas.boundingBox();assert.ok(box);await canvas.click({position:{x:box.width*.5,y:box.height*.5}});await canvas.press('e');}
async function check(id,description,layers,fn){console.log('NEXT_WAVE_CASE_START '+id+' '+description);await evidence.check(id,description,layers,fn);console.log('NEXT_WAVE_CASE_PASS '+id);}

try {
  await service.start();
  await check('J01','Actual actor, native import and available real executor',['A','G'],async receipt=>{
    actor=await registerActor('journey-owner');
    const created=(await request('POST','/creation-api/projects',{actor,body:{name:'Independent Door Journey '+randomUUID().slice(0,6),template:'empty'},expected:201,timeout:120000})).value;project=created.project;branchRoute=`/creation-api/projects/${project.id}/branches/main`;
    const imported=(await request('POST',branchRoute+'/transactions',{actor,body:{transaction_id:'independent-fixture-'+randomUUID(),base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:nativeImportFiles()}]},timeout:120000})).value;source=imported;
    assert.equal(imported.branch.manifest.entry_scene_id,'journey-a');assert.equal(imported.branch.manifest.schema,'creation-native-1');
    session=(await request('POST',branchRoute+'/sessions',{actor,body:{title:'Door failure from actual play',visibility:'private',access_mode:'workspace-write'},expected:201})).value;
    const executor=(await request('GET','/creation-api/agent/status',{actor,timeout:45000})).value;assert.equal(executor.ready,true,executor.error);assert.equal(executor.authenticated,true);assert.ok(executor.default_model);
    receipt.project_id=project.id;receipt.source_revision=imported.revision;receipt.source_identity=imported.branch.manifest.source_identity;receipt.session_id=session.id;receipt.executor={ready:executor.ready,authenticated:executor.authenticated,default_model:executor.default_model};
    evidence.json('initial-source-manifest.json',imported.branch.manifest);
    writeFileSync(join(service.data,'independent-test-state.json'),JSON.stringify({actor,project,session,source_revision:source.revision})+'\n',{mode:0o600});
  });

  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio','--enable-unsafe-swiftshader']});
  evidence.report.versions.chrome=browser.version();context=await browser.newContext({viewport:{width:1600,height:1050}});
  page=await context.newPage();
  await page.addInitScript(()=>{
    window.__nextWaveEvents=[];
    addEventListener('message',event=>{
      const data=event.data;if(!data||data.source!=='world-atelier-game'||event.source===window)return;
      const value=structuredClone(data);if(value.data_url){value.image_length=value.data_url.length;delete value.data_url;}
      window.__nextWaveEvents.push({at:performance.now(),origin:event.origin,data:value});if(window.__nextWaveEvents.length>1200)window.__nextWaveEvents.splice(0,200);
    });
  });
  page.on('console',message=>{const text=message.text();logs.push({type:message.type(),text});if(text.startsWith('NW_AUTHOR_'))console.log(text);});
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('request',r=>{if(r.method()!=='GET'&&new URL(r.url()).pathname.startsWith('/creation-api/'))httpWrites.push({at:Date.now(),method:r.method(),path:new URL(r.url()).pathname});});
  page.on('response',r=>{const path=new URL(r.url()).pathname;if(path.endsWith('/play-build')||path.endsWith('/native-preview-build')){const task=r.json().then(value=>{if(value.job){if(value.job.purpose==='play')lastPlayJob=value.job.id;console.log('NEXT_WAVE_BUILD '+JSON.stringify({id:value.job.id,purpose:value.job.purpose,status:value.job.status,revision:value.job.source_revision}));}}).catch(()=>{});responses.push(task);}});
  await page.goto(ORIGIN+'/creation-workspace.html#/games');await page.locator('#authName').fill(actor.credentials.name);await page.locator('#authPassword').fill(actor.credentials.password);await page.locator('#authSubmit').click();await page.locator('#landing').waitFor({state:'visible'});

  await check('J02','Original workbench starts the actual fixed Godot game and isolates author JavaScript',['A','G','B'],async receipt=>{
    await page.locator(`[data-quick-game="${project.id}"][data-quick-branch="main"]`).click();await page.locator('#workbench').waitFor({state:'visible'});await selectSession();await page.locator('#closeChat').click();
    await page.locator('[data-mode="play"]').click();await mode('play');
    const frame=await gameFrame();await waitFor('actual native author Counter observation',async()=>/JourneyA.*clicks=0.*open=false/.test(await counterText()),{timeout:45000,interval:250});
    buildId=(await state()).build;firstUrl=frame.url();const job=(await request('GET',`/creation-api/builds/${buildId}`,{actor})).value.job;
    assert.equal(job.purpose,'play');assert.equal(job.status,'completed');assert.equal(job.source_revision,source.revision);evidence.json('actual-play-build.json',job);
    await frame.waitForFunction(()=>window.__nextWaveIsolation?.completed,{timeout:15000});const isolation=await frame.evaluate(()=>window.__nextWaveIsolation);
    assert.equal(isolation.parent_dom.readable,false);assert.equal(isolation.parent_token.readable,false);assert.equal(isolation.own_creator_token.present,false);assert.equal(isolation.runtime_admin.status,403);assert.equal(isolation.creator_admin.readable,false);
    receipt.build_id=buildId;receipt.canonical_identity=job.canonical_identity;receipt.runtime_source_hash=job.runtime_source_hash;receipt.source_revision=job.source_revision;receipt.isolation=isolation;
    await page.screenshot({path:join(evidence.directory,'actual-game-initial.png')});
  });

  let earlyEventAt,lastInputsAt;
  await check('J03','Real input and an actual browser interval cross the default sixty-second boundary without uploads',['G','B'],async receipt=>{
    await pressE();await waitFor('first actual E interaction',async()=>/clicks=1.*open=false/.test(await counterText()),{timeout:15000});earlyEventAt=Date.now();
    const oldCaptures=httpWrites.filter(row=>row.path.endsWith('/play-context/captures')).length;
    for(let part=0;part<13;part++){await delay(5000);if(part%3===2)console.log('NEXT_WAVE_RECORDING_SECONDS '+Math.round((Date.now()-earlyEventAt)/1000));}
    const active=await gameFrame();await active.locator('canvas').press('w');
    await pressE();await pressE();lastInputsAt=Date.now();await waitFor('two recent actual E interactions still fail to open door',async()=>/clicks=3.*open=false/.test(await counterText()),{timeout:15000});
    assert.equal(logs.filter(row=>row.text.includes('NW_AUTHOR_CONSUMED_W')).length,1,'The authored _input must really consume W once.');
    assert.equal(httpWrites.filter(row=>row.path.endsWith('/play-context/captures')).length,oldCaptures,'Unsent local recording must not upload captures.');
    receipt.elapsed_ms=lastInputsAt-earlyEventAt;assert.ok(receipt.elapsed_ms>=65000);receipt.counter=await counterText();receipt.unsent_capture_posts=0;
    await page.screenshot({path:join(evidence.directory,'actual-door-still-closed.png')});
  });

  await check('J04','Pointing at the game pauses only this local run, captures a real frame and keeps source fixed',['G','B'],async receipt=>{
    await page.locator('[data-play-context-focus]').click();await mode('inspect');await page.locator('.play-context-focus-layer').waitFor({state:'visible'});
    const layer=page.locator('.play-context-focus-layer'),box=await layer.boundingBox();assert.ok(box);
    await page.mouse.move(box.x+box.width*.40,box.y+box.height*.24);await page.mouse.down();await page.mouse.move(box.x+box.width*.63,box.y+box.height*.63,{steps:6});await page.mouse.up();await layer.waitFor({state:'detached'});
    // A pre-inspection UI capture is intentionally preserved at its earlier
    // tick. Wait for a genuine inspection snapshot before testing the pause.
    const before=await waitFor('actual inspection snapshot',async()=>{const value=await currentSnapshot();return value?.payload?.mode==='inspect'&&value;},{timeout:5000});await delay(2000);const after=await currentSnapshot();assert.equal(after.tick,before.tick,'Local inspection must freeze actual game ticks.');
    assert.equal((await request('GET',branchRoute,{actor})).value.head,source.revision);
    await selectSession();assert.equal(await page.locator('[data-play-context-range]').inputValue(),'60');assert.equal(await page.locator('[data-play-context-include]').isChecked(),true);
    receipt.frozen_tick=after.tick;receipt.source_head=source.revision;receipt.focus_status=await page.locator('.play-context-status').innerText();
    await page.screenshot({path:join(evidence.directory,'actual-focus-and-composer.png')});
  });

  await check('J05','Normal UI send attaches real recent process/focus/images and starts one real Codex turn',['A','B','C'],async receipt=>{
    const prompt='刚才我在这局里按了两次 E，门还是没有打开。请结合随消息附带的最近 60 秒试玩过程和我框出的画面，查明原因并修复：保持原本“两次交互后打开”的规则，保留关卡、输入和存档结构。请先用 play_context_read 读取所附观察和按需画面，再读当前源稿并把修复保存到中央原生工程。不要发布游戏，也不要重启我正在检查的这一局；最后说明具体改动和实际检查范围。';
    await page.getByRole('textbox',{name:'发送给选定会话的草稿',exact:true}).fill(prompt);await page.locator('#sendDraft').click();
    const started=await waitFor('real user message and creator run',async()=>{const value=(await request('GET',`/creation-api/sessions/${session.id}`,{actor})).value;return value.runs.length&&value.messages.some(m=>m.role==='user')?value:null;},{timeout:90000,interval:500});
    assert.equal(started.runs.length,1);const message=started.messages.find(m=>m.role==='user'),attachment=message.attachments.find(a=>a.kind==='play_observation');assert.ok(attachment);observationId=attachment.observation_id;runId=started.runs[0].id;
    assert.ok(message.attachments.some(a=>a.kind==='image'),'At least one actual rendered keyframe must reach the real message.');
    const events=(await request('GET',`/creation-api/sessions/${session.id}/play-context/observations/${observationId}?section=events&limit=100`,{actor})).value;
    const eKeys=events.items.filter(event=>event.kind==='key_down'&&event.payload.key==='E');assert.equal(eKeys.length,2,'The early E beyond 60s must be absent, while both recent real inputs remain.');
    assert.equal(events.items.filter(event=>event.kind==='key_down'&&event.payload.key==='W').length,1,'The observer must record one W even when author code handles the input.');
    const observation=(await request('GET',`/creation-api/sessions/${session.id}/play-context/observations/${observationId}`,{actor})).value;
    assert.equal(observation.summary.requested_seconds,60);assert.ok(observation.summary.duration_seconds<=60.1);assert.equal(observation.focus.kind,'screen_region');assert.equal(observation.scope.source_revision,source.revision);assert.equal(observation.scope.build_id,buildId);
    const frames=(await request('GET',`/creation-api/sessions/${session.id}/play-context/observations/${observationId}?section=frames`,{actor})).value;assert.ok(frames.items.length>0);
    for(const entry of frames.items){const response=await fetch(ORIGIN+entry.url,{headers:{authorization:'Bearer '+actor.token}});assert.equal(response.status,200);writeFileSync(join(evidence.directory,'captured-'+entry.id+'.'+(entry.mime==='image/jpeg'?'jpg':'png')),Buffer.from(await response.arrayBuffer()));}
    evidence.json('sent-observation-summary.json',observation);evidence.json('sent-observation-events.json',events);evidence.json('sent-observation-frames.json',frames);
    receipt.run_id=runId;receipt.observation_id=observationId;receipt.real_recent_E_events=eKeys.length;receipt.attachment_kinds=message.attachments.map(a=>a.kind);receipt.frame_count=frames.items.length;receipt.source_revision=observation.scope.source_revision;
  });

  let fixedObservationHash,finishedSession,newHead;
  await check('J06','The real Agent reads the observation and saves a repair while the existing runtime stays pinned',['A','B','C'],async receipt=>{
    fixedObservationHash=(await request('GET',`/creation-api/sessions/${session.id}/play-context/observations/${observationId}`,{actor})).value.sha256;
    let lastStatus='',lastProgress=0;
    finishedSession=await waitFor('real Codex turn completion',async()=>{
      const value=(await request('GET',`/creation-api/sessions/${session.id}`,{actor})).value,run=value.runs.find(run=>run.id===runId);
      if(run.status!==lastStatus||Date.now()-lastProgress>15000){console.log('NEXT_WAVE_REAL_AGENT '+JSON.stringify({run_id:run.id,status:run.status,tools:run.tools?.length??null,error:run.error??null}));lastStatus=run.status;lastProgress=Date.now();}
      if(['failed','interrupted','uncertain','waiting_input'].includes(run.status))throw Error('Real Agent did not complete autonomously: '+JSON.stringify({status:run.status,error:run.error??null}));
      return run.status==='completed'?value:null;
    },{timeout:10*60*1000,interval:1500});
    const run=finishedSession.runs.find(run=>run.id===runId);const branch=(await request('GET',branchRoute,{actor})).value;newHead=branch.head;assert.notEqual(newHead,source.revision,'The real Agent must save actual central source changes.');
    let cursor=0,events=[];for(;;){const response=(await request('GET',`/creation-api/sessions/${session.id}/events?after=${cursor}`,{actor})).value;if(!response.events.length)break;events.push(...response.events);cursor=response.events.at(-1).cursor;if(response.events.length<500)break;}
    const eventText=JSON.stringify(events);assert.match(eventText,/play_context_read/);assert.match(eventText,/world_apply|semantic_apply/);
    assert.equal((await state()).build,buildId);assert.equal((await gameFrame()).url(),firstUrl);assert.equal((await request('GET',`/creation-api/sessions/${session.id}/play-context/observations/${observationId}`,{actor})).value.sha256,fixedObservationHash);
    for(const path of ['opaque/author.bin','opaque/author-notes.txt'])assert.deepEqual(branch.manifest.source_files[path],source.branch.manifest.source_files[path]);
    receipt.run_id=run.id;receipt.thread_id=finishedSession.executor_thread_id;receipt.status=run.status;receipt.new_source_revision=newHead;receipt.original_build_still_running=buildId;receipt.fixed_observation_sha256=fixedObservationHash;
    evidence.json('real-agent-run.json',run);evidence.json('real-agent-events.json',events);evidence.json('final-source-manifest.json',branch.manifest);
    evidence.json('agent-reply.json',finishedSession.messages.filter(message=>message.role==='assistant').map(message=>({content:message.content,run_id:message.run_id})));
    await page.screenshot({path:join(evidence.directory,'actual-agent-finished-old-run-preserved.png')});
  });

  await check('J07','An explicit restart loads the repaired source and actual two-input gameplay opens the door',['A','G','B'],async receipt=>{
    // The real conversation drawer overlays the viewport toolbar at this
    // viewport width. Close it through its ordinary control before restarting.
    if(!await page.locator('#chatDrawer').evaluate(el=>el.hidden))await page.locator('#closeChat').click();
    if(!await page.locator('#viewportMore').evaluate(el=>el.open))await page.locator('#viewportMore summary').click();
    await page.locator('#restartPlay').click();await mode('play',{differentBuild:buildId});
    const nextBuild=(await state()).build;await waitFor('new runtime initial door state',async()=>/JourneyA.*clicks=0.*open=false/.test(await counterText()),{timeout:45000,interval:250});
    await pressE();await waitFor('one actual interaction remains closed',async()=>/clicks=1.*open=false/.test(await counterText()),{timeout:10000});await pressE();await waitFor('second actual interaction opens repaired door',async()=>/clicks=2.*open=true/.test(await counterText()),{timeout:10000});
    const job=(await request('GET',`/creation-api/builds/${nextBuild}`,{actor})).value.job;assert.equal(job.source_revision,newHead);assert.notEqual(job.id,buildId);
    receipt.build_id=nextBuild;receipt.source_revision=job.source_revision;receipt.actual_counter=await counterText();receipt.runtime_source_hash=job.runtime_source_hash;
    assert.equal((await request('GET',`/creation-api/sessions/${session.id}/play-context/observations/${observationId}`,{actor})).value.sha256,fixedObservationHash);
    await page.screenshot({path:join(evidence.directory,'actual-repaired-door-open.png')});evidence.json('repaired-play-build.json',job);
  });
  completed=true;
}catch(error){
  evidence.report.errors.push({message:error.message,stack:error.stack});console.error(error.stack);process.exitCode=1;
  if(page&&!page.isClosed()){evidence.json('failure-ui.json',await state().catch(()=>({})));evidence.json('failure-frames.json',page.frames().map(frame=>({url:frame.url(),parent:frame.parentFrame()?.url()??null})));await page.screenshot({path:join(evidence.directory,'failure.png')}).catch(()=>{});evidence.json('actual-received-events.json',await page.evaluate(()=>window.__nextWaveEvents??[]).catch(()=>[]));}
}finally{
  await Promise.allSettled(responses);evidence.json('browser-console.json',logs);evidence.json('browser-errors.json',pageErrors);evidence.json('actual-http-writes.json',httpWrites);
  if(page&&!page.isClosed())evidence.json('actual-received-events.json',await page.evaluate(()=>window.__nextWaveEvents??[]).catch(()=>[]));
  await browser?.close();
  try{await service.stop();}catch(error){evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;}
  evidence.report.retained_test_data=service.data;evidence.report.credentials='Only synthetic test account credentials are retained in the private temp-data state file, never in this report.';
  evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);
}
