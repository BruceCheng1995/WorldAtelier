/** Continue the previously completed real Agent door journey through the
 * original UI into a new branch and actual new read-only Codex conversation. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {Evidence,IsolatedService,ORIGIN,request,waitFor} from './next-wave-test-support.mjs';
const previous=resolve(process.argv[2]??'');assert.ok(process.argv[2],'Pass the private retained test-data directory from the successful actual door journey.');
const state=JSON.parse(readFileSync(join(previous,'independent-test-state.json'))),{actor,project,session}=state;
const evidence=new Evidence('continuation-journey-independent',{layers:['A','B','C'],scope:'Actual original UI branch continuation of a completed real creator conversation and its immutable actual Godot observation, then a new actual Codex read-only turn.'});
const service=new IsolatedService(evidence,{agent:true,worlds:false,data:previous});
let browser,page,source,target,newBranch,cutoff,observationId,completed=false;
const logs=[],errors=[];const base='/creation-api/projects/'+project.id+'/branches/';
const check=async(id,text,fn)=>{console.log('NEXT_WAVE_CASE_START '+id+' '+text);await evidence.check(id,text,['A','B','C'],fn);console.log('NEXT_WAVE_CASE_PASS '+id);};
try{
 await service.start();source=(await request('GET','/creation-api/sessions/'+session.id,{actor})).value;
 assert.ok(source.runs.some(row=>row.status==='completed'),'The real source turn must have completed first.');
 observationId=source.messages.flatMap(row=>row.attachments??[]).find(row=>row.kind==='play_observation')?.observation_id;assert.ok(observationId);cutoff=source.messages.at(-1);
 const branch=(await request('GET',base+'main',{actor})).value;
 newBranch=(await request('POST','/creation-api/projects/'+project.id+'/branches',{actor,body:{from_branch:'main',branch_id:'continued-'+randomUUID().slice(0,6),name:'Independent continued branch',expected_head:branch.head},expected:201})).value;
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio','--enable-unsafe-swiftshader']});const context=await browser.newContext({viewport:{width:1600,height:1050}});page=await context.newPage();evidence.report.versions.chrome=browser.version();
 page.on('console',m=>logs.push({type:m.type(),text:m.text()}));page.on('pageerror',e=>errors.push(e.message));
 await page.goto(ORIGIN+'/creation-workspace.html#/games');await page.locator('#authName').fill(actor.credentials.name);await page.locator('#authPassword').fill(actor.credentials.password);await page.locator('#authSubmit').click();await page.locator('#landing').waitFor({state:'visible'});
 await page.locator(`[data-quick-game="${project.id}"][data-quick-branch="main"]`).click();await page.locator('#workbench').waitFor({state:'visible'});await page.locator('#agentsMenuButton').click();await page.locator('#toggleSessions').click();await page.locator(`button[data-session="${session.id}"]`).click();await page.waitForFunction(sid=>document.querySelector('#sessionId')?.value===sid,session.id);
 const objective='请只读延续这个问题：先用 session_context_read 看来源会话的固定摘要、已发送消息和那份试玩观察，再用 world_read 核对当前目标分支源稿。说明来源观察为什么显示门没有打开、来源会话后来做了什么修复，以及目标分支现在是什么状态。必须区分旧运行证据和当前源版本。不修改文件、不提交源稿、不发布、不运行验证，也不接管来源窗口。最后明确你在这个新会话工作。';
 await check('XC01','Original UI fixes the cutoff/evidence and creates a distinct private branch conversation',async receipt=>{
  await page.locator('#chatSettings summary').first().click();await page.locator('#continueSession').click();await page.locator('[data-session-continuation]').waitFor();
  await page.locator('[data-continuation-branch]').selectOption(newBranch.branch_id);await page.locator('[data-continuation-cutoff]').selectOption(cutoff.id);assert.equal(await page.locator('[data-continuation-evidence]').isChecked(),true);await page.locator('[data-continuation-objective]').fill(objective);await page.locator('[data-continuation-submit]').click();
  await page.locator('[data-session-continuation]').waitFor({state:'detached'});const sid=await waitFor('actual new conversation selected',async()=>{const sid=await page.locator('#sessionId').inputValue();return sid&&sid!==session.id&&sid;},{timeout:20000});
  target=(await request('GET','/creation-api/sessions/'+sid,{actor})).value;assert.equal(target.branch_id,newBranch.branch_id);assert.equal(target.visibility,'private');assert.equal(target.executor_thread_id,null);assert.deepEqual(target.runs,[]);assert.equal(target.draft,objective);
  const fixed=(await request('GET','/creation-api/sessions/'+sid+'/continued-context',{actor})).value;assert.equal(fixed.cutoff_message_id,cutoff.id);assert.deepEqual(fixed.observation_ids,[observationId]);assert.equal(fixed.target_head_at_creation,newBranch.head);
  const sourceAfter=(await request('GET','/creation-api/sessions/'+session.id,{actor})).value;assert.equal(sourceAfter.executor_thread_id,source.executor_thread_id);assert.deepEqual(sourceAfter.runs,source.runs);assert.equal(sourceAfter.branch_id,'main');
  receipt.target_session_id=sid;receipt.fixed_context=fixed;receipt.source_thread_id=source.executor_thread_id;await page.screenshot({path:join(evidence.directory,'created-private-continuation.png')});
 });
 await check('XC02','A real new Codex turn reads fixed historical evidence and current target without source mutation',async receipt=>{
  await page.locator('#sendDraft').click();let last=0;
  const finished=await waitFor('actual read-only continued Agent turn',async()=>{const value=(await request('GET','/creation-api/sessions/'+target.id,{actor})).value,run=value.runs.at(-1);if(!run)return null;if(Date.now()-last>15000){console.log('NEXT_WAVE_CONTINUED_AGENT '+JSON.stringify({status:run.status,run_id:run.id}));last=Date.now();}if(['failed','interrupted','waiting_input','uncertain'].includes(run.status))throw Error('Continued Agent '+run.status+': '+run.error);return run.status==='completed'?value:null;},{timeout:600000,interval:1500});
  assert.equal(finished.runs.length,1);assert.ok(finished.executor_thread_id);assert.notEqual(finished.executor_thread_id,source.executor_thread_id);assert.equal(finished.branch_id,newBranch.branch_id);assert.equal((await request('GET',base+newBranch.branch_id,{actor})).value.head,newBranch.head);
  let cursor=0,events=[];for(;;){const result=(await request('GET','/creation-api/sessions/'+target.id+'/events?after='+cursor,{actor})).value;if(!result.events.length)break;events.push(...result.events);cursor=result.events.at(-1).cursor;if(result.events.length<500)break;}
  const text=JSON.stringify(events);assert.match(text,/session_context_read/);assert.match(text,/world_read/);assert.equal(finished.runs[0].changes?.length??0,0);
  evidence.json('continued-agent-events.json',events);evidence.json('continued-agent-run.json',finished.runs[0]);evidence.json('continued-agent-reply.json',finished.messages.filter(row=>row.role==='assistant').map(row=>row.content));
  receipt.target_thread_id=finished.executor_thread_id;receipt.source_thread_id=source.executor_thread_id;receipt.target_head=newBranch.head;receipt.source_mutations=0;await page.screenshot({path:join(evidence.directory,'actual-continued-agent-finished.png')});
 });
 completed=true;
}catch(error){evidence.report.errors.push({message:error.message,stack:error.stack});console.error(error.stack);process.exitCode=1;if(page&&!page.isClosed())await page.screenshot({path:join(evidence.directory,'failure.png')}).catch(()=>{});}
finally{evidence.json('browser-console.json',logs);evidence.json('browser-errors.json',errors);await browser?.close();await service.stop().catch(error=>{evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;});evidence.report.retained_test_data=service.data;evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);}
