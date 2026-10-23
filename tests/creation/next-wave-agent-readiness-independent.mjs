/** Real response timing regression for the original composer. Delay only the
 * actual agent/status response, type before it arrives, then forward unchanged.
 * This test NEVER sends a chat message or starts a model turn. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {Evidence,IsolatedService,ORIGIN,request,waitFor,delay,sha256} from './next-wave-test-support.mjs';
assert.ok(process.argv[2],'Pass the retained isolated creator fixture directory');
const data=resolve(process.argv[2]),fixture=JSON.parse(readFileSync(join(data,'independent-test-state.json'))),{actor,project}=fixture;
const evidence=new Evidence('agent-readiness-independent',{layers:['A','B'],scope:'Real original composer with the actual successful agent/status response delayed; previously typed draft enables on readiness without another input event. No message, model turn or source change.'});
const service=new IsolatedService(evidence,{agent:true,worlds:false,data});
let browser,page,session,completed=false,releaseStatus,actualStatus=null;
const released=new Promise(done=>releaseStatus=done),pendingRoutes=[],writes=[],consoleErrors=[];
const draft='仅用于独立就绪时序检查的未发送草稿。此测试不发送消息、不运行模型、不修改源稿。';
try{
 await service.start();const branch=(await request('GET',`/creation-api/projects/${project.id}/branches/main`,{actor})).value;
 const status=(await request('GET','/creation-api/agent/status',{actor,timeout:60000})).value;assert.equal(status.ready,true);assert.equal(status.authenticated,true);
 session=(await request('POST',`/creation-api/projects/${project.id}/branches/main/sessions`,{actor,body:{title:'Independent delayed readiness - never sent',visibility:'private'},expected:201})).value;
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio','--enable-unsafe-swiftshader']});const context=await browser.newContext({viewport:{width:1600,height:1050}});page=await context.newPage();evidence.report.versions.chrome=browser.version();
 await page.addInitScript(()=>{window.__readinessInputCount=0;document.addEventListener('input',event=>{if(event.target.matches?.('#sessionDraft,.reference-editor'))window.__readinessInputCount++;},true);});
 page.on('request',r=>{if(r.method()!=='GET'&&new URL(r.url()).pathname.startsWith('/creation-api/'))writes.push({method:r.method(),path:new URL(r.url()).pathname});});page.on('pageerror',e=>consoleErrors.push(e.message));
 await page.route('**/creation-api/agent/status',route=>{
  const job=(async()=>{const response=await route.fetch(),bytes=await response.body(),value=JSON.parse(bytes);assert.equal(response.status(),200);assert.equal(value.ready,true);assert.equal(value.authenticated,true);actualStatus={status:response.status(),ready:value.ready,authenticated:value.authenticated,body_sha256:sha256(bytes)};await released;await route.fulfill({response});})();pendingRoutes.push(job);return job;
 });
 await page.goto(ORIGIN+'/creation-workspace.html#/games');await page.locator('#authName').fill(actor.credentials.name);await page.locator('#authPassword').fill(actor.credentials.password);await page.locator('#authSubmit').click();await page.locator('#landing').waitFor({state:'visible'});await page.locator(`[data-quick-game="${project.id}"][data-quick-branch="main"]`).click();await page.locator('#workbench').waitFor({state:'visible'});
 if(await page.locator('#chatDrawer').evaluate(el=>el.hidden))await page.locator('#agentsMenuButton').click();await waitFor('original branch session initialization',()=>page.locator('#sessionId').inputValue(),{timeout:20000});
 if(await page.locator('#sessionId').inputValue()!==session.id){await page.locator('#toggleSessions').click();await page.locator(`button[data-session="${session.id}"]`).click();}await page.waitForFunction(id=>document.querySelector('#sessionId')?.value===id,session.id);
 await evidence.check('READY01','A genuine delayed ready response enables an already-entered original UI draft without another keystroke',['A','B'],async receipt=>{
  await waitFor('actual successful status response is held',()=>actualStatus,{timeout:30000});assert.doesNotMatch(await page.locator('#agentStatus').textContent(),/Codex · 已连接/);
  await page.getByRole('textbox',{name:'发送给选定会话的草稿',exact:true}).fill(draft);await delay(200);assert.equal(await page.locator('#sendDraft').isDisabled(),true);
  const beforeCount=await page.evaluate(()=>window.__readinessInputCount),beforeDraft=await page.locator('#sessionDraft').inputValue();assert.equal(beforeDraft,draft);await page.screenshot({path:join(evidence.directory,'draft-before-real-readiness.png')});
  releaseStatus();await Promise.all(pendingRoutes);await waitFor('original composer enables from real readiness alone',async()=>!await page.locator('#sendDraft').isDisabled(),{timeout:10000});
  const afterCount=await page.evaluate(()=>window.__readinessInputCount);assert.equal(afterCount,beforeCount);assert.equal(await page.locator('#sessionDraft').inputValue(),draft);assert.match(await page.locator('#agentStatus').textContent(),/Codex · 已连接/);
  const current=(await request('GET','/creation-api/sessions/'+session.id,{actor})).value;assert.deepEqual(current.runs,[]);assert.deepEqual(current.messages,[]);assert.equal((await request('GET',`/creation-api/projects/${project.id}/branches/main`,{actor})).value.head,branch.head);assert.equal(writes.some(row=>/\/sessions\/[^/]+\/messages$/.test(row.path)),false);
  receipt.actual_response=actualStatus;receipt.input_events_before=beforeCount;receipt.input_events_after=afterCount;receipt.source_revision=branch.head;receipt.started_model_turns=0;receipt.sent_messages=0;receipt.session_id=session.id;await page.screenshot({path:join(evidence.directory,'draft-after-real-readiness.png')});
 });completed=true;
}catch(error){evidence.report.errors.push({message:error.message,stack:error.stack});console.error(error.stack);process.exitCode=1;if(page&&!page.isClosed()){evidence.json('failure-ui.json',await page.evaluate(()=>({agent_status:document.querySelector('#agentStatus')?.textContent,session_id:document.querySelector('#sessionId')?.value,send_disabled:document.querySelector('#sendDraft')?.disabled,draft_length:document.querySelector('#sessionDraft')?.value?.length})));await page.screenshot({path:join(evidence.directory,'failure.png')}).catch(()=>{});}}
finally{releaseStatus();await Promise.allSettled(pendingRoutes);evidence.json('actual-http-writes.json',writes);evidence.json('browser-errors.json',consoleErrors);await browser?.close();await service.stop().catch(error=>{evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;});evidence.report.retained_test_data=service.data;evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);}
