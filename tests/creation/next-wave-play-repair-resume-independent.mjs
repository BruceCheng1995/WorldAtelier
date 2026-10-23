/** Cross-driver continuation of an already completed real creator repair.
 * No second Agent repair is requested. The original immutable evidence and
 * source/build identities are verified before real input/restart verification. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {DatabaseSync} from 'node:sqlite';
import {Evidence,IsolatedService,ORIGIN,request,waitFor,sha256} from './next-wave-test-support.mjs';
const priorDirectory=resolve(process.argv[2]??'');assert.ok(process.argv[2],'Pass the preceding real Agent journey evidence directory');
const prior=JSON.parse(readFileSync(join(priorDirectory,'report.json'))),priorObservation=JSON.parse(readFileSync(join(priorDirectory,'sent-observation-summary.json'))),priorBuild=JSON.parse(readFileSync(join(priorDirectory,'actual-play-build.json'))),fixed=JSON.parse(readFileSync(join(priorDirectory,'final-source-manifest.json')));
assert.equal(prior.cases.find(row=>row.id==='J06')?.status,'passed','The real Agent repair must have already passed, including unchanged running build and immutable observation.');
const evidence=new Evidence('play-repair-resume-independent',{layers:['A','G','B'],scope:'Cross-driver continuation after a selector-only interruption. Reuse the actual Agent repair and original observation; verify fixed source with real canonical Web input and explicit UI restart. No new Agent repair.'});
evidence.report.preceding_evidence={directory:priorDirectory,report_sha256:sha256(readFileSync(join(priorDirectory,'report.json'))),real_agent_case:'J06',interruption:prior.cases.find(row=>row.id==='J07')?.error?.message};
const service=new IsolatedService(evidence,{agent:false,worlds:false,data:prior.retained_test_data??prior.service.data});
const state=JSON.parse(readFileSync(join(service.data,'independent-test-state.json'))),{actor,project,session}=state,route='/creation-api/projects/'+project.id+'/branches/main';
let browser,page,complete=false;const logs=[];
const snapshot=()=>page.evaluate(()=>[...(window.__nextWaveEvents??[])].reverse().find(row=>row.type==='play_context'&&row.kind==='snapshot')??null);
const counter=async()=>(await snapshot())?.payload?.objects?.find(row=>row.name==='Counter')?.control?.text??'';
const ui=()=>page.evaluate(()=>({mode:document.querySelector('#stage').dataset.previewMode,build:document.querySelector('#mainPreview').dataset.gameBuild,status:document.querySelector('#workspaceStatus').textContent}));
async function ready(){return waitFor('actual repaired Godot initial state',async()=>{const view=await ui();return view.mode==='play'&&/JourneyA.*clicks=0.*open=false/.test(await counter())&&view;},{timeout:240000,interval:250});}
async function press(){const frame=page.frames().find(frame=>frame.url().includes('/creation-runtime/')&&frame.url().includes('/web/index.html'));assert.ok(frame);await frame.locator('canvas').focus();await frame.locator('canvas').press('e');}
async function twoInputs(){await press();await waitFor('actual first E stays closed',async()=>/clicks=1.*open=false/.test(await counter()),{timeout:10000});await press();await waitFor('actual second E opens repaired door',async()=>/clicks=2.*open=true/.test(await counter()),{timeout:10000});return counter();}
const check=async(id,text,fn)=>{console.log('NEXT_WAVE_CASE_START '+id+' '+text);await evidence.check(id,text,['A','G','B'],fn);console.log('NEXT_WAVE_CASE_PASS '+id);};
try{
 await service.start();
 await check('JR01','The original real observation, build bytes and actual Agent source revision remain fixed',async receipt=>{
  const branch=(await request('GET',route,{actor})).value;assert.deepEqual(branch.manifest,fixed);assert.equal(branch.head,prior.cases.find(row=>row.id==='J06').new_source_revision);
  const observation=(await request('GET','/creation-api/sessions/'+session.id+'/play-context/observations/'+priorObservation.observation_id,{actor})).value;assert.equal(observation.sha256,priorObservation.sha256);
  const original=(await request('GET','/creation-api/builds/'+priorBuild.id,{actor})).value.job;assert.equal(original.canonical_identity,priorBuild.canonical_identity);assert.equal(original.source_revision,priorBuild.source_revision);
  const database=new DatabaseSync(join(service.creationData,'creation.sqlite'),{readOnly:true});let archived;try{archived=JSON.parse(database.prepare("SELECT body FROM documents WHERE kind='creator_build' AND id=?").get(original.id).body);}finally{database.close();}
  for(const file of archived.web_files)assert.equal(sha256(readFileSync(join(service.creationData,'builds',original.id,'web',file.path))),file.sha256);
  receipt.source_revision=branch.head;receipt.original_build_id=original.id;receipt.original_canonical_identity=original.canonical_identity;receipt.original_observation_id=priorObservation.observation_id;receipt.original_observation_sha256=observation.sha256;
 });
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio','--enable-unsafe-swiftshader']});const context=await browser.newContext({viewport:{width:1600,height:1050}});page=await context.newPage();evidence.report.versions.chrome=browser.version();
 await page.addInitScript(()=>{window.__nextWaveEvents=[];addEventListener('message',event=>{if(event.data?.source==='world-atelier-game'&&!event.data.data_url){window.__nextWaveEvents.push(event.data);if(window.__nextWaveEvents.length>1000)window.__nextWaveEvents.shift();}});});page.on('console',m=>logs.push({type:m.type(),text:m.text()}));
 await page.goto(ORIGIN+'/creation-workspace.html#/games');await page.locator('#authName').fill(actor.credentials.name);await page.locator('#authPassword').fill(actor.credentials.password);await page.locator('#authSubmit').click();await page.locator('#landing').waitFor({state:'visible'});await page.locator(`[data-quick-game="${project.id}"][data-quick-branch="main"]`).click();await page.locator('#workbench').waitFor({state:'visible'});
 await check('JR02','The actual repaired source opens after exactly two inputs and explicit restart resets this run',async receipt=>{
  await page.locator('[data-mode="play"]').click();const first=await ready();assert.notEqual(first.build,priorBuild.id);const build=(await request('GET','/creation-api/builds/'+first.build,{actor})).value.job;assert.equal(build.source_revision,prior.cases.find(row=>row.id==='J06').new_source_revision);assert.equal(build.status,'completed');
  receipt.first_actual_result=await twoInputs();await page.screenshot({path:join(evidence.directory,'actual-agent-repaired-door-open.png')});
  const instance=(await snapshot()).runtime_instance_id;
  if(!await page.locator('#chatDrawer').evaluate(el=>el.hidden))await page.locator('#closeChat').click();if(!await page.locator('#viewportMore').evaluate(el=>el.open))await page.locator('#viewportMore summary').click();await page.locator('#restartPlay').click();
  await ready();await waitFor('actual restarted instance differs',async()=>{const value=await snapshot();return value.runtime_instance_id!==instance;},{timeout:20000});receipt.restarted_actual_result=await twoInputs();
  const observation=(await request('GET','/creation-api/sessions/'+session.id+'/play-context/observations/'+priorObservation.observation_id,{actor})).value;assert.equal(observation.sha256,priorObservation.sha256);
  receipt.new_build_id=first.build;receipt.new_source_revision=build.source_revision;receipt.canonical_identity=build.canonical_identity;receipt.runtime_source_hash=build.runtime_source_hash;receipt.same_original_observation_sha256=observation.sha256;receipt.cross_driver_continuation=true;
  evidence.json('actual-repaired-build.json',build);await page.screenshot({path:join(evidence.directory,'actual-restarted-door-open.png')});
 });complete=true;
}catch(error){evidence.report.errors.push({message:error.message,stack:error.stack});console.error(error.stack);process.exitCode=1;if(page&&!page.isClosed()){evidence.json('failure-ui.json',await ui().catch(()=>({})));await page.screenshot({path:join(evidence.directory,'failure.png')}).catch(()=>{});}}
finally{evidence.json('browser-console.json',logs);if(page&&!page.isClosed())evidence.json('actual-received-events.json',await page.evaluate(()=>window.__nextWaveEvents));await browser?.close();await service.stop().catch(error=>{evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;});evidence.report.retained_test_data=service.data;evidence.finish({completed:complete});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);}
