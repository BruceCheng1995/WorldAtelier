/** One human-authorized read-only continuation after the real quota stop.
 * Only this retained synthetic account is temporarily raised to 2,000,000
 * daily tokens through the normal admin API. Original limits are restored in
 * finally, with policy versions/audits retained. No direct database mutation. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {Evidence,IsolatedService,ORIGIN,request,waitFor,delay} from './next-wave-test-support.mjs';
assert.ok(process.argv[2],'Pass the prior quota-interruption evidence directory.');
const previous=resolve(process.argv[2]),beforeReport=JSON.parse(readFileSync(join(previous,'report.json'))),interrupted=JSON.parse(readFileSync(join(previous,'actual-quota-interruption.json')));
assert.equal(beforeReport.cases.find(row=>row.id==='XC01')?.status,'passed');assert.equal(interrupted.auto_resume_blocked_reason,'ai_limit_reached');
const data=beforeReport.retained_test_data,fixture=JSON.parse(readFileSync(join(data,'independent-test-state.json'))),{actor,project}=fixture;
assert.ok(actor.credentials.name.startsWith('next-wave-'));assert.match(interrupted.input_revision,/^src-[a-f0-9]{64}$/);
const evidence=new Evidence('continuation-resume-independent',{layers:['A','B','C'],scope:'One explicitly human-authorized read-only continuation in the original private target session; synthetic-account token limit temporarily 1m→2m through normal admin API and restored afterwards.'});
evidence.report.authorization={scope:'Only this existing isolated synthetic account; one read-only continuation; restore original quota; formal accounts/global policy unchanged',temporary_daily_tokens:2000000};
const service=new IsolatedService(evidence,{agent:true,worlds:false,data,environment:{WORLD_ATELIER_ADMIN_USER_ID:actor.user.id}});
const limits=row=>Object.fromEntries(['enabled','daily_runs','concurrent_runs','daily_tokens','max_run_minutes'].map(key=>[key,row[key]]));
const policy=row=>({id:row.id,version:row.version,...limits(row)});
const getPolicy=async target=>(await request('GET','/creation-api/admin/ai/'+target,{actor})).value.item;
const sessionRoute='/creation-api/sessions/'+interrupted.session_id,sourceRoute='/creation-api/sessions/'+fixture.session.id;
const change=async(row,value,reason)=>(await request('PATCH','/creation-api/admin/ai/'+actor.user.id,{actor,body:{request_id:randomUUID(),expected_version:row.version,reason,limits:value}})).value;
let browser,page,original,globalBefore,changed=false,completed=false,runId,stopRequested=false,targetBefore,sourceBefore,targetHead,sourceHead;
const logs=[];const onStop=()=>{stopRequested=true;};process.on('SIGINT',onStop);process.on('SIGTERM',onStop);
const check=async(id,text,fn)=>{console.log('NEXT_WAVE_CASE_START '+id+' '+text);await evidence.check(id,text,['A','B','C'],fn);console.log('NEXT_WAVE_CASE_PASS '+id);};
try{
 await service.start();original=await getPolicy(actor.user.id);globalBefore=await getPolicy('global');assert.equal(original.daily_tokens,1000000);assert.ok(original.usage.daily_tokens>=1000000);
 targetBefore=(await request('GET',sessionRoute,{actor})).value;sourceBefore=(await request('GET',sourceRoute,{actor})).value;
 assert.equal(targetBefore.visibility,'private');assert.equal(targetBefore.branch_id,interrupted.branch_id);assert.equal(targetBefore.executor_thread_id,interrupted.thread_id);assert.ok(targetBefore.runs.every(run=>['completed','failed','interrupted'].includes(run.status)));
 targetHead=(await request('GET',`/creation-api/projects/${project.id}/branches/${targetBefore.branch_id}`,{actor})).value.head;sourceHead=(await request('GET',`/creation-api/projects/${project.id}/branches/main`,{actor})).value.head;assert.equal(targetHead,interrupted.input_revision);
 const executor=(await request('GET','/creation-api/agent/status',{actor,timeout:60000})).value;assert.equal(executor.ready,true,executor.error);assert.equal(executor.authenticated,true);evidence.json('actual-executor-readiness.json',{ready:executor.ready,authenticated:executor.authenticated,default_model:executor.default_model});
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio','--enable-unsafe-swiftshader']});const context=await browser.newContext({viewport:{width:1600,height:1050}});page=await context.newPage();evidence.report.versions.chrome=browser.version();page.on('console',m=>logs.push({type:m.type(),text:m.text()}));
 await page.goto(ORIGIN+'/creation-workspace.html#/games');await page.locator('#authName').fill(actor.credentials.name);await page.locator('#authPassword').fill(actor.credentials.password);await page.locator('#authSubmit').click();await page.locator('#landing').waitFor({state:'visible'});await page.locator(`[data-quick-game="${project.id}"][data-quick-branch="${targetBefore.branch_id}"]`).click();await page.locator('#workbench').waitFor({state:'visible'});
 if(await page.locator('#chatDrawer').evaluate(el=>el.hidden))await page.locator('#agentsMenuButton').click();
 await waitFor('original branch conversation initialization',()=>page.locator('#sessionId').inputValue(),{timeout:20000});
 if(await page.locator('#sessionId').inputValue()!==targetBefore.id){await page.locator('#toggleSessions').click();await page.locator(`button[data-session="${targetBefore.id}"]`).click();}
 await page.waitForFunction(sid=>document.querySelector('#sessionId')?.value===sid,targetBefore.id);
 await page.waitForFunction(()=>document.querySelector('#agentStatus')?.textContent?.includes('Codex · 已连接'),{timeout:30000});
 const updated=await change(original,{...limits(original),daily_tokens:2000000},'用户明确授权：仅此隔离测试账号临时上调，完成一次跨分支只读续聊后恢复。');changed=true;assert.equal(updated.after.daily_tokens,2000000);assert.deepEqual(policy(await getPolicy('global')),policy(globalBefore));evidence.json('temporary-quota-change.json',{target_user_id:actor.user.id,before:policy(original),after:updated.after,audit_id:updated.audit_id,global_before:policy(globalBefore),usage_before:original.usage});
 await check('XCR01','Resume exactly one real turn in the original private target thread and read fixed history plus current source',async receipt=>{
  const prompt='继续完成刚才被隔离测试账号 token 日限额中止的只读核对。此次已获用户授权临时额度，仅完成这一次简短核对，不重新修复。先用 session_context_read 读取 summary，按需读取最后一条来源答复（messages cursor=4 limit=1）及所带试玩观察的摘要；再用 world_read 核对当前目标分支 JourneyA 根节点 allow_open，必要时只读开门脚本局部。请用简短最终回复说明：旧观察呈现什么、来源会话保存了什么修复、当前目标分支是什么状态，并明确这是不同于来源会话的新私有目标会话。历史观察不能当成新版本运行验收。不要修改任何文件、提交源、发布、启动引擎或接管其他窗口。';
  await page.getByRole('textbox',{name:'发送给选定会话的草稿',exact:true}).fill(prompt);await page.locator('#sendDraft').click();let printed=0;
  const done=await waitFor('one actual continued read-only turn',async()=>{
   if(stopRequested)throw Error('Independent continuation was requested to stop.');
   const value=(await request('GET',sessionRoute,{actor})).value,run=value.runs.find(row=>!targetBefore.runs.some(before=>before.id===row.id));if(!run)return null;runId=run.id;
   if(Date.now()-printed>15000){console.log('NEXT_WAVE_AUTHORIZED_CONTINUATION '+JSON.stringify({run_id:run.id,status:run.status,error:run.error??null}));printed=Date.now();}
   if(['failed','interrupted','waiting_input','uncertain'].includes(run.status))throw Error('Authorized read-only continuation stopped: '+run.status+' '+(run.error??''));return run.status==='completed'?value:null;
  },{timeout:600000,interval:1500});
  assert.equal(done.runs.length,targetBefore.runs.length+1);assert.equal(done.executor_thread_id,targetBefore.executor_thread_id);assert.notEqual(done.executor_thread_id,sourceBefore.executor_thread_id);
  const run=done.runs.find(row=>row.id===runId);assert.deepEqual(run.changes,[]);assert.deepEqual(run.deliveries,[]);assert.deepEqual(run.verifications,[]);
  let cursor=0,events=[];for(;;){const value=(await request('GET',sessionRoute+'/events?after='+cursor,{actor})).value;if(!value.events.length)break;events.push(...value.events);cursor=value.events.at(-1).cursor;if(value.events.length<500)break;}
  const currentTurnIds=new Set(run.turn_ids??[run.turn_id]),items=events.filter(event=>currentTurnIds.has(event.params?.turnId)&&event.method==='item/completed').map(event=>event.params.item);
  const tools=items.filter(item=>item.type==='dynamicToolCall');assert.ok(tools.some(item=>item.tool==='session_context_read'&&item.success===true));assert.ok(tools.some(item=>item.tool==='world_read'&&item.success===true));
  const forbidden=['world_apply','semantic_apply','branch_merge_apply','asset_publish','game_validate','world_validate','shared_world_validate','world_publish'];assert.equal(tools.some(item=>forbidden.includes(item.tool)),false);assert.equal(items.some(item=>item.type==='fileChange'),false);
  assert.equal((await request('GET',`/creation-api/projects/${project.id}/branches/${targetBefore.branch_id}`,{actor})).value.head,targetHead);assert.equal((await request('GET',`/creation-api/projects/${project.id}/branches/main`,{actor})).value.head,sourceHead);assert.deepEqual((await request('GET',sourceRoute,{actor})).value.runs,sourceBefore.runs);
  const reply=done.messages.filter(row=>row.role==='assistant'&&row.run_id===runId);assert.ok(reply.length);evidence.json('authorized-real-continuation-run.json',run);evidence.json('authorized-real-continuation-events.json',events);evidence.json('authorized-real-continuation-reply.json',reply.map(row=>({content:row.content,run_id:row.run_id})));
  receipt.run_id=run.id;receipt.thread_id=done.executor_thread_id;receipt.source_thread_id=sourceBefore.executor_thread_id;receipt.target_branch=targetBefore.branch_id;receipt.target_head=targetHead;receipt.source_head=sourceHead;receipt.dynamic_tools=tools.map(item=>({tool:item.tool,success:item.success}));receipt.source_changes=0;await page.screenshot({path:join(evidence.directory,'authorized-read-only-continuation-finished.png')});
 });completed=true;
}catch(error){evidence.report.errors.push({message:error.message,stack:error.stack});console.error(error.stack);process.exitCode=1;if(page&&!page.isClosed()){evidence.json('failure-ui-state.json',await page.evaluate(()=>({agent_status:document.querySelector('#agentStatus')?.textContent,session_id:document.querySelector('#sessionId')?.value,draft_length:document.querySelector('#sessionDraft')?.value?.length,send_disabled:document.querySelector('#sendDraft')?.disabled,recovery_hidden:document.querySelector('#sessionRecovery')?.hidden,recovery_text:document.querySelector('#sessionRecoveryText')?.textContent,draft_status:document.querySelector('#draftStatus')?.textContent})));await page.screenshot({path:join(evidence.directory,'failure.png')}).catch(()=>{});}}
finally{
 if(service.child&&runId){try{const value=(await request('GET',sessionRoute,{actor})).value,run=value.runs.find(row=>row.id===runId);if(run&&!['completed','failed','interrupted'].includes(run.status)){await request('POST',sessionRoute+'/interrupt',{actor,body:{}});await waitFor('owned continued turn cleanup',async()=>{const current=(await request('GET',sessionRoute,{actor})).value.runs.find(row=>row.id===runId);return ['completed','failed','interrupted'].includes(current.status)&&(!current.cleanup_status||current.cleanup_status==='verified');},{timeout:30000});}}catch(error){evidence.report.errors.push({phase:'owned-run-cleanup',message:error.message});}}
 if(changed){try{const current=await getPolicy(actor.user.id),result=await change(current,limits(original),'恢复用户授权的临时隔离测试额度：只读续聊复验已结束，恢复原限额并保留真实用量和审计。'),after=await getPolicy(actor.user.id),globalAfter=await getPolicy('global');assert.deepEqual(limits(after),limits(original));assert.deepEqual(policy(globalAfter),policy(globalBefore));evidence.json('restored-quota.json',{target_user_id:actor.user.id,original:policy(original),restored:policy(after),audit_id:result.audit_id,usage_after:after.usage,global_before:policy(globalBefore),global_after:policy(globalAfter)});evidence.report.quota_restored=true;}catch(error){evidence.report.quota_restored=false;evidence.report.errors.push({phase:'quota-restore',message:error.message});process.exitCode=1;}}
 evidence.json('browser-console.json',logs);await browser?.close();await service.stop().catch(error=>{evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;});process.off('SIGINT',onStop);process.off('SIGTERM',onStop);evidence.report.retained_test_data=service.data;evidence.finish({completed:completed&&evidence.report.quota_restored===true});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);
}
