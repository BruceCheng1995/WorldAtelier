import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';
import {snapshotProjectRuntime,assembleProject} from '../../services/creation/project-snapshot.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {projectPrefabTestScope} from '../../services/creation/prefab-tests.mjs';
import {importNativeProject} from '../../tools/native-scene/invoke.mjs';

const root=resolve(import.meta.dirname,'../..'),exec=promisify(execFile);
const subjectId='pea',testId='pea-lab',mainId='main';

import {prefabLabFixture} from './prefab-lab-fixture.mjs';
export {prefabLabFixture};

function disabledService(options){
  const settings=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(key=>[key,process.env[key]]);
  for(const [key]of settings)process.env[key]='1';
  try{return new CreationService(options);}finally{for(const [key,value]of settings)if(value===undefined)delete process.env[key];else process.env[key]=value;}
}

async function inspectPack(godot,pck,directory){
  mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,'project.godot'),'config_version=5\n');
  writeFileSync(join(directory,'inspect.gd'),String.raw`extends SceneTree
var files: Array = []
func walk(path: String):
	for name in DirAccess.get_files_at(path): files.append(path.path_join(name))
	for name in DirAccess.get_directories_at(path):
		if name != ".godot": walk(path.path_join(name))
func _initialize():
	if not ProjectSettings.load_resource_pack(OS.get_cmdline_user_args()[0]):
		push_error("PCK_LOAD_FAILED")
		quit(1)
		return
	walk("res://")
	var release = JSON.parse_string(FileAccess.get_file_as_string("res://atelier_runtime/release.json"))
	print("PREFAB_LAB_PACK "+JSON.stringify({"files":files,"release":release}))
	quit(0)
`);
  const {stdout,stderr}=await exec(godot,['--headless','--path',directory,'--script',join(directory,'inspect.gd'),'--',pck],{timeout:30000,maxBuffer:8*1024*1024});
  const log=stdout+stderr;writeFileSync(join(directory,'inspect.log'),log);assert.doesNotMatch(log,/SCRIPT ERROR|PCK_LOAD_FAILED/);
  const line=stdout.split('\n').find(row=>row.startsWith('PREFAB_LAB_PACK '));assert.ok(line,log);return JSON.parse(line.slice('PREFAB_LAB_PACK '.length));
}

test('prefab labs preserve native authoring, isolate real runtime effects and stay out of game packages',{timeout:900000},async t=>{
  const evidence=join(root,'.local/creation-verification/prefab-lab-independent');mkdirSync(evidence,{recursive:true});
  const data=mkdtempSync(join(evidence,'case-')),origin='http://127.0.0.1:48921',report={ok:false,scope:'Real native source transactions, purpose projections, authenticated build queue, Godot PCK and two isolated Chrome game runtimes; no real Agent or full workspace UX',checks:[],errors:[],data};
  let service,browser;
  const server=createServer(async(req,res)=>{try{
    if(await service.request(req,res))return;if(service.builds.webRequest(req,res))return;
    const path=new URL(req.url,origin).pathname;
    if(/^\/[a-z][a-z0-9-]*\.(js|css)$/.test(path)&&existsSync(join(root,'apps/creation-workspace',path.slice(1)))){res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(readFileSync(join(root,'apps/creation-workspace',path.slice(1))));return;}
    if(['/packages/scene/transform.mjs','/packages/contracts/authoring-references.mjs','/packages/contracts/viewport-annotations.mjs'].includes(path)){res.setHeader('content-type','text/javascript');res.end(readFileSync(join(root,path.slice(1))));return;}
    if(path==='/creation-workspace.html'||path==='/prefab-preview.html'){res.setHeader('content-type','text/html');res.end(readFileSync(join(root,'apps/creation-workspace',path==='/creation-workspace.html'?'index.html':'prefab-preview.html')));return;}
    if(path==='/harness'){res.setHeader('content-type','text/html');res.end('<!doctype html><style>html,body,#host{margin:0;width:100%;height:100%;background:#142b29}iframe{width:100%;height:100%;border:0}.render-status{position:absolute;top:8px;left:8px;color:white}</style><div id="host"></div>');return;}
    res.writeHead(404);res.end();
  }catch(error){res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(48921,'127.0.0.1',yes);});
  service=disabledService({server,root,data,origin,publicPlay:true});
  t.after(async()=>{await browser?.close();await service.close();await new Promise(yes=>server.close(yes));report.finished_at=new Date().toISOString();writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('PREFAB_LAB_EVIDENCE '+data);});
  const owner=service.store.register({name:'Lab owner',password:'prefab-lab-isolated-password'}),viewer=service.store.register({name:'Lab viewer',password:'prefab-lab-isolated-password'}),player=service.store.register({name:'Public player',password:'prefab-lab-isolated-password'});
  async function request(method,path,user,payload,expected=200){
    const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin,...(user?{authorization:'Bearer '+user.token}:{}),'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
    const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
  }
  const created=await service.createProject(owner.user,{name:'Prefab laboratory acceptance'}),p=created.project.id,route=`/projects/${p}/branches/main`;
  const invite=await request('POST',`/projects/${p}/invites`,owner,{role:'viewer'},201);await request('POST','/invites/join',viewer,{code:invite.code});
  const texts=prefabLabFixture();
  const imported=await service.committed(owner.user,p,'main',{transaction_id:'lab-import',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,value])=>({path,data_base64:Buffer.from(value).toString('base64')}))}]});
  const manifest=imported.branch.manifest;assert.equal(manifest.resources[testId].purpose,'prefab_test');assert.equal(manifest.resources[testId].subject_id,subjectId);
  report.project_id=p;report.source_revision=imported.revision;report.source_identity=manifest.source_identity;
  report.checks.push('Godot imports and indexes native preview metadata, real AnimationPlayer and direct PackedScene subject');
  for(const [name,change]of [
    ['missing subject',catalog=>catalog.resources[testId].subject_id='missing'],
    ['ordinary scene inside test directory',catalog=>delete catalog.resources[testId].purpose],
    ['test used as game entry',catalog=>catalog.entry_scene_id=testId],
    ['test outside reserved directory',catalog=>catalog.resources[mainId]={...catalog.resources[mainId],purpose:'prefab_test',subject_id:subjectId}],
  ]){
    const catalog=JSON.parse(texts['.atelier/catalog.json']);change(catalog);
    await assert.rejects(service.committed(owner.user,p,'main',{transaction_id:'invalid-'+name.replaceAll(' ','-'),base_revision:imported.revision,ops:[{type:'put_source_file',path:'.atelier/catalog.json',expected_hash:manifest.source_files['.atelier/catalog.json'].hash,text:JSON.stringify(catalog)}]}),error=>error.status===422,name);
    assert.equal(service.store.branchFor(owner.user,p,'main').head,imported.revision,name+' preserves source head');
  }
  report.checks.push('invalid subjects, unclassified test scenes, game entry and misplaced tests are rejected without source changes');
  for(const purpose of ['authoring','game','prefab_test']){
    const directory=join(data,'projection-'+purpose),runtime=snapshotProjectRuntime(root,directory);
    await assembleProject({service,user:owner.user,project_id:p,branch_id:'main',revision:imported.revision,entry_scene_id:purpose==='prefab_test'?testId:mainId,directory,runtime_source_hash:runtime.hash,purpose});
    const release=JSON.parse(readFileSync(join(directory,'atelier_runtime/release.json')));
    assert.deepEqual(readFileSync(join(directory,'custom/unknown.bin')),Buffer.from(texts['custom/unknown.bin']));
    if(purpose==='game'){
      assert.equal(existsSync(join(directory,'test_scenes')),false,'game projection physically excludes test directory');
      assert.equal(release.scenes[testId],undefined);assert.equal(release.prefab_test,undefined);
      assert.doesNotMatch(readFileSync(join(directory,'atelier_runtime/source-manifest.json'),'utf8'),/test_scenes\/|"prefab_test"/);
    }else{
      for(const [path,entry]of Object.entries(manifest.source_files))if(path!=='project.godot')assert.equal(hash(readFileSync(join(directory,path))),entry.hash,purpose+' preserves '+path);
      if(purpose==='prefab_test')assert.deepEqual(release.prefab_test,{resource_id:testId,subject_id:subjectId});
    }
  }
  report.checks.push('authoring and preview preserve native bytes; game projection removes test files, resource entries and metadata');
  const dependencyManifest=structuredClone(manifest);
  dependencyManifest.source_files['scripts/invalid_game_dependency.gd']=service.native.archive.put('extends Node\nconst Lab = preload("res://test_scenes/pea-lab/scene.tscn")\n');
  assert.throws(()=>projectPrefabTestScope(service,dependencyManifest,'game',mainId),error=>error.status===422&&error.details?.path==='scripts/invalid_game_dependency.gd');
  assert.equal(hash(service.store.readRevision(imported.revision).manifest),hash(manifest),'projection must not rewrite authoritative manifest');
  report.checks.push('game-to-test preload dependency is rejected before export; original authoritative manifest is immutable');
  await request('POST',route+'/play-build',owner,{source_revision:imported.revision,entry_scene_id:testId,request_id:'wrong-play-entry'},422);
  await request('POST',route+'/prefab-test-build',player,{source_revision:imported.revision,entry_scene_id:testId,request_id:'public-denied'},403);
  await request('POST',route+'/prefab-test-build',owner,{source_revision:imported.revision,entry_scene_id:mainId,request_id:'wrong-lab-entry'},422);
  report.checks.push('ordinary Play rejects preview entry, preview build rejects ordinary entry and public player');

  const listed=await request('GET',route+'/prefab-tests',viewer);assert.equal(listed.revision,imported.revision);assert.deepEqual(listed.scenarios.map(row=>row.id),[testId]);
  await request('GET',route+'/prefab-tests',player,undefined,403);
  const createInput={request_id:'create-native-lab',base_revision:imported.revision,subject_id:subjectId,name:'Generated native ability preview'};
  await request('POST',route+'/prefab-tests',viewer,createInput,403);
  const generated=await request('POST',route+'/prefab-tests',owner,createInput);
  assert.equal(generated.branch.manifest.resources[generated.resource_id].subject_id,subjectId);
  assert.equal(generated.branch.manifest.resources[generated.resource_id].purpose,'prefab_test');
  const generatedScene=service.native.archive.read(generated.branch.manifest.source_files[generated.branch.manifest.resources[generated.resource_id].path]).toString();
  assert.match(generatedScene,/path="res:\/\/prefabs\/pea\.tscn"/);assert.match(generatedScene,/instance=ExtResource\("2"\)/);
  const replay=await request('POST',route+'/prefab-tests',owner,createInput);assert.equal(replay.revision,generated.revision);assert.equal(replay.resource_id,generated.resource_id);
  await request('POST',route+'/prefab-tests',owner,{...createInput,request_id:'new-stale-lab'},409);
  const finalHead=service.store.branchFor(owner.user,p,'main').head;
  report.checks.push('member viewer reads tests; creation requires editor, persists actual PackedScene, replays exactly and rejects stale source');
  if(process.env.PREFAB_LAB_PHASE==='source'){
    report.scope='Real Godot source import and catalog rejection, source projection and authenticated HTTP creation/permissions; Web/runtime/export not run';report.ok=true;return;
  }

  const nativeDirectory=join(data,'projection-prefab_test');
  await importNativeProject({projectDirectory:nativeDirectory,godotPath:service.builds.godot,enforceIsolation:true});
  for(const [plan,expectedCode]of [['plan',0],['failing-plan',1]]){
    const target=join(data,plan+'-report.json');let result;
    try{result=await exec(service.builds.godot,['--headless','--path',nativeDirectory,'--fixed-fps','60','--','--prefab-test-plan=res://test_scenes/pea-lab/'+plan+'.json','--prefab-test-report='+target],{timeout:45000,maxBuffer:8*1024*1024});assert.equal(expectedCode,0,'failing plan must use nonzero exit');}
    catch(error){if(expectedCode===0)throw error;assert.equal(error.code,expectedCode);result=error;}
    writeFileSync(join(data,plan+'-runtime.log'),(result.stdout??'')+(result.stderr??''));
    const actual=JSON.parse(readFileSync(target));assert.equal(actual.ok,expectedCode===0);assert.equal(actual.source_revision,imported.revision);assert.equal(actual.resource_id,testId);
    if(expectedCode===0){assert.equal(actual.steps.length,12);assert.equal(actual.state.observations.target_hp,75);assert.equal(actual.state.observations.method_calls,0);report.native_plan=actual;}
    else assert.match(actual.error,/target_hp/);
  }
  report.checks.push('canonical native CLI plan drives actual shot/collision, drop, pose and physics step; deliberately wrong expectation fails with source-bound report and nonzero exit');
  if(process.env.PREFAB_LAB_PHASE==='native'){
    report.scope='Real Godot source/API checks and canonical native success/failure plans; Web/runtime UX and packaged PCK not run';report.ok=true;return;
  }

  async function completeBuild(user,operation,entry,id){
    let {job}=await request('POST',route+'/'+operation,user,{source_revision:imported.revision,entry_scene_id:entry,request_id:id},202);
    const fixed={id:job.id,canonical_identity:job.canonical_identity};
    for(const deadline=Date.now()+600000;!['completed','failed','partial','interrupted'].includes(job.status);){
      assert.ok(Date.now()<deadline,'actual build exceeded 10 minutes');await new Promise(yes=>setTimeout(yes,700));
      ({job}=await request('GET','/builds/'+fixed.id,user));assert.equal(job.canonical_identity,fixed.canonical_identity);
    }
    assert.equal(job.status,'completed',JSON.stringify(job));assert.ok(job.artifacts.some(artifact=>artifact.target==='web'));return job;
  }
  const previewJob=await completeBuild(owner,'prefab-test-build',testId,'preview-owner');assert.equal(previewJob.purpose,'prefab_test');
  const reused=await request('POST',route+'/prefab-test-build',owner,{source_revision:imported.revision,entry_scene_id:testId,request_id:'preview-owner'},202);assert.equal(reused.job.id,previewJob.id);
  const viewerBuild=await request('GET','/builds/'+previewJob.id,viewer);assert.equal(viewerBuild.job.id,previewJob.id);
  await request('POST',route+'/game-releases',owner,{request_id:'cannot-publish-preview',build_id:previewJob.id,source_revision:imported.revision,entry_scene_id:testId,expected_pointer_version:null},422);
  report.preview_job=previewJob;
  report.checks.push('actual immutable preview Web build reused by authorized viewer and rejected by public release');

  browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  async function openRun(user,label,existingPage=null){
    const context=existingPage?.context()??await browser.newContext({viewport:{width:1000,height:700}}),page=existingPage??await context.newPage();
    if(!existingPage){page.on('pageerror',error=>report.errors.push(label+': '+error.message));
    page.on('console',message=>{if(/SCRIPT ERROR|Parse Error|RuntimeError|PREFAB_LAB_FAILED/.test(message.text()))report.errors.push(label+': '+message.text());});}
    await page.goto(origin+'/harness');
    await page.evaluate(async({token,job,p,rid,label})=>{
      const response=await fetch('/creation-api/builds/'+job.id+'/access',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'});
      const access=await response.json();if(!response.ok)throw Error(JSON.stringify(access));
      const {GamePlay}=await import('/game-play.js');window.events=[];
      window.preview=new GamePlay(document.querySelector('#host'),async()=>({job,url:new URL(access.web_url,location.origin).href}),message=>{events.push(message);if(message.type==='prefab_test_state')window.labState=message;});
      await preview.runtimeReady;
      await preview.start({document_id:p+'/main/'+rid,scene_revision:job.source_revision,source_revision:job.source_revision},{world_id:'preview:'+label,epoch:1,scene_revision:job.source_revision,request_id:'start-'+label});
    },{token:user.token,job:previewJob,p,rid:testId,label});
    await page.waitForFunction(()=>window.labState?.actions?.length===9,{},{timeout:60000});return page;
  }
  const pageA=await openRun(owner,'owner'),pageB=await openRun(viewer,'viewer');
  const snapshot=page=>page.evaluate(()=>structuredClone(window.labState));
  async function command(page,action,extra={},expected=true,requestId=null){
    const request_id=requestId??crypto.randomUUID();
    await page.evaluate(({action,extra,request_id})=>preview.post({type:'prefab_test',source_revision:preview.job.source_revision,scene_generation:preview.sceneGeneration,seq:preview.commandSeq,document_id:preview.sceneContext.document_id,command:{request_id,action,...extra}}),{action,extra,request_id});
    await page.waitForFunction(request_id=>events.some(event=>event.type==='prefab_test_result'&&event.request_id===request_id),request_id,{timeout:10000});
    const result=await page.evaluate(request_id=>events.find(event=>event.type==='prefab_test_result'&&event.request_id===request_id),request_id);
    assert.equal(result.ok,expected,JSON.stringify(result));return result;
  }
  const initial=await snapshot(pageA);assert.deepEqual(initial.animations.map(animation=>animation.name).sort(),['idle','shoot']);assert.equal(initial.observations.target_hp,100);
  const declared=Object.fromEntries(initial.actions.map(row=>[row.id,row]));
  assert.equal(declared.shoot.scope,'subject');assert.equal(declared.shoot.kind,'ability');
  assert.equal(declared.angry.kind,'state');assert.equal(declared.idle_on.kind,'controller');
  assert.equal(declared.hurt_subject.scope,'scene');assert.equal(declared.hurt_subject.kind,'passive');
  assert.equal(declared.legacy_fixture.scope,'scene');assert.equal(declared.legacy_fixture.legacy,true);
  assert.equal(initial.capabilities.title,'Pea active preview');assert.deepEqual(initial.selection.action_ids,['idle_off']);
  report.checks.push('scene-declared active abilities, states and controllers stay distinct from passive, fixture and unclassified legacy actions');
  const shoot=initial.animations.find(animation=>animation.name==='shoot');assert.equal(shoot.track_count,2);assert.ok(shoot.tracks.some(track=>track.keys.some(time=>Math.abs(time-.2)<.00001)));
  await command(pageA,'animation',{player:shoot.player,animation:shoot.name});await command(pageA,'seek',{time:.25});
  await pageA.waitForFunction(()=>labState.current?.name==='shoot'&&Math.abs(labState.time-.25)<.01);
  const sought=await snapshot(pageA);assert.equal(sought.observations.method_calls,0);assert.notEqual(sought.observations.subject_scale[0],1);assert.equal(sought.paused,true);
  await command(pageA,'animation_play',{speed:.5});await pageA.waitForFunction(()=>labState.time>.27);await command(pageA,'animation_pause');
  const held=await snapshot(pageA);await pageA.waitForTimeout(220);assert.equal((await snapshot(pageA)).time,held.time);assert.equal((await snapshot(pageA)).observations.method_calls,0);
  await command(pageA,'pause');const beforeStep=await snapshot(pageA),step=await command(pageA,'step');assert.equal(step.result.ticks,1);
  await pageA.waitForFunction(tick=>labState.tick===tick+1&&labState.paused,beforeStep.tick);
  await command(pageA,'speed',{speed:2});assert.equal((await snapshot(pageA)).speed,2);await command(pageA,'speed',{speed:1});
  report.checks.push('real native animation clips and tracks enumerate, seek changes pose without method callbacks, clip play/pause and one physics tick work');
  const shotRequest=crypto.randomUUID();
  await command(pageA,'action',{action_id:'shoot',parameters:{}},true,shotRequest);assert.equal((await snapshot(pageA)).observations.shots,1);
  await command(pageA,'action',{action_id:'shoot',parameters:{}},true,shotRequest);
  assert.equal((await snapshot(pageA)).observations.target_hp,100);assert.equal((await snapshot(pageB)).observations.shots,0);
  await command(pageA,'resume');await pageA.waitForFunction(()=>labState.observations.target_hp===75,{},{timeout:10000});
  await command(pageA,'action',{action_id:'drop',parameters:{}});await command(pageA,'action',{action_id:'angry',parameters:{}});
  await pageA.waitForFunction(()=>labState.observations.drops===1&&labState.observations.stance==='angry');
  const effective=await snapshot(pageA),untouched=await snapshot(pageB);assert.equal(untouched.observations.target_hp,100);assert.equal(untouched.observations.drops,0);
  assert.ok(effective.selection.action_ids.includes('angry'));assert.equal(effective.selection.status,'angry');
  assert.ok(effective.events.some(event=>JSON.stringify(event).includes('hit')));assert.ok(effective.events.some(event=>JSON.stringify(event).includes('drop')));
  await command(pageA,'action',{action_id:'unregistered-method',parameters:{}},false);
  const staleIds=[];
  for(const field of ['source_revision','scene_generation','seq','document_id']){
    const request_id=crypto.randomUUID();staleIds.push(request_id);
    await pageA.evaluate(({request_id,field})=>{
      const packet={type:'prefab_test',source_revision:preview.job.source_revision,scene_generation:preview.sceneGeneration,seq:preview.commandSeq,document_id:preview.sceneContext.document_id,command:{request_id,action:'action',action_id:'shoot',parameters:{}}};
      packet[field]=typeof packet[field]==='number'?packet[field]-1:'stale';preview.post(packet);
    },{request_id,field});
  }
  await pageA.waitForTimeout(250);assert.equal((await snapshot(pageA)).observations.shots,1);
  for(const staleId of staleIds)assert.equal(await pageA.evaluate(id=>events.some(event=>event.request_id===id),staleId),false);
  await pageA.screenshot({path:join(data,'abilities-after-hit-and-drop.png')});await pageB.screenshot({path:join(data,'viewer-independent-initial.png')});
  writeFileSync(join(data,'runtime-observations.json'),JSON.stringify({owner:effective,viewer:untouched},null,2)+'\n');
  report.checks.push('real projectile collision causes damage, dropped sun and state changes are visible; second authenticated runtime remains independent; stale and unknown actions cannot execute');
  const pageFresh=await openRun(owner,'restart',pageA);assert.equal((await snapshot(pageFresh)).observations.target_hp,100);assert.equal((await snapshot(pageFresh)).observations.shots,0);assert.equal((await snapshot(pageFresh)).observations.drops,0);
  await command(pageFresh,'action',{action_id:'remove_target',parameters:{}});
  assert.equal((await snapshot(pageFresh)).selection.blocked_actions.shoot,'Place a target before firing.');
  await command(pageFresh,'action',{action_id:'shoot',parameters:{}},false);assert.equal((await snapshot(pageFresh)).observations.shots,0);
  await command(pageFresh,'action',{action_id:'restore_target',parameters:{}});
  assert.deepEqual((await snapshot(pageFresh)).selection.blocked_actions,{});
  report.checks.push('real target removal exposes a dynamic blocked reason, prevented shot has no effect, and target restoration clears the block');
  await pageA.close();await pageB.close();
  assert.deepEqual(report.errors,[]);

  const workspaceContext=await browser.newContext({viewport:{width:1512,height:1000}});
  await workspaceContext.addInitScript(token=>sessionStorage.setItem('world-atelier-creator-token',token),owner.token);
  const workspace=await workspaceContext.newPage(),workspaceFailures=[];
  report.workspace={source_revision:finalHead,failures:workspaceFailures};
  workspace.on('pageerror',error=>workspaceFailures.push(error.message));
  workspace.on('response',response=>{if(response.status()>=400)workspaceFailures.push(response.status()+' '+new URL(response.url()).pathname);});
  await workspace.addInitScript(()=>{window.workspaceLabPackets=[];addEventListener('message',event=>{if(event.data?.type==='prefab_test_state'){workspaceLabPackets.push(event.data);window.workspaceLabState=event.data;}});});
  await workspace.goto(origin+'/creation-workspace.html#/games/'+p+'/branches/main');
  try{await workspace.locator('#workbench').waitFor({state:'visible',timeout:45000});}
  catch(error){await workspace.screenshot({path:join(data,'workspace-load-failure.png')});writeFileSync(join(data,'workspace-load-failure.html'),await workspace.content());throw error;}
  await workspace.locator('[data-explorer="prefabs"]').click();
  await workspace.locator('[data-prefab-lab="'+subjectId+'"]').waitFor({state:'visible'});
  await workspace.locator('[data-prefab-lab="'+subjectId+'"]').click();
  await workspace.locator('#prefabLabHost .prefab-lab').waitFor({state:'visible'});
  await workspace.getByRole('tab',{name:'技能',exact:true}).click();
  await workspace.getByRole('button',{name:'Fire pea',exact:true}).waitFor({state:'visible',timeout:180000});
  await workspace.getByRole('button',{name:'Fire pea',exact:true}).click();
  await workspace.waitForFunction(()=>workspaceLabState?.observations?.target_hp===75,{},{timeout:12000});
  await workspace.getByRole('button',{name:'Drop sun',exact:true}).click();
  await workspace.waitForFunction(()=>workspaceLabState?.observations?.drops===1);
  await workspace.getByRole('tab',{name:'动画',exact:true}).click();
  await workspace.getByRole('button',{name:'播放动画 idle',exact:true}).click();
  await workspace.waitForFunction(()=>workspaceLabState?.current?.name==='idle'&&workspaceLabState?.playing&&workspaceLabState.time>.05);
  await workspace.getByRole('combobox',{name:'动画',exact:true}).selectOption('shoot');
  await workspace.waitForFunction(()=>workspaceLabState?.current?.name==='shoot'&&workspaceLabState?.playing);
  await workspace.getByLabel('动画时间（秒）',{exact:true}).fill('0.25');
  await workspace.getByLabel('动画时间（秒）',{exact:true}).press('Tab');
  await workspace.waitForFunction(()=>Math.abs(workspaceLabState?.time-.25)<.01&&workspaceLabState?.paused);
  assert.equal(await workspace.evaluate(()=>workspaceLabState.observations.method_calls),0);
  assert.equal(await workspace.locator('.animation-tracks .animation-track').count(),2);
  await workspace.getByRole('button',{name:'播放动画',exact:true}).click();
  await workspace.waitForFunction(()=>workspaceLabState?.playing===true&&workspaceLabState.time>.26);
  await workspace.getByRole('button',{name:'暂停动画',exact:true}).click();
  await workspace.screenshot({path:join(data,'workspace-prefab-ability-timeline.png')});
  const observedUi=await workspace.evaluate(()=>workspaceLabState);assert.equal(observedUi.source_revision,finalHead);
  const uiBeforeStep=observedUi.tick;
  await workspace.getByRole('button',{name:'单帧',exact:true}).click();
  await workspace.waitForFunction(tick=>workspaceLabState?.tick===tick+1&&workspaceLabState?.paused,uiBeforeStep);
  await workspace.getByRole('button',{name:'重置',exact:true}).click();
  await workspace.waitForFunction(()=>workspaceLabState?.observations?.target_hp===100&&workspaceLabState.observations.shots===0&&workspaceLabState.observations.drops===0,{},{timeout:90000});
  await workspace.getByRole('button',{name:'返回编辑',exact:true}).click();
  await workspace.locator('#prefabLabHost').waitFor({state:'hidden'});assert.equal(await workspace.locator('#prefabLabHost iframe').count(),0);
  assert.equal(await workspace.locator('[data-prefab-lab="'+subjectId+'"]').isVisible(),true);
  await workspace.screenshot({path:join(data,'workspace-returned-to-editor.png')});
  report.workspace={source_revision:finalHead,observed:observedUi,failures:workspaceFailures};
  assert.equal(workspaceFailures.some(error=>error.includes('prefab-lab')||error.includes('animation-timeline')||!/^\d{3} /.test(error)),false,JSON.stringify(workspaceFailures));
  await workspace.close();await browser.close();browser=null;
  report.scope='Real native source/API/CLI, two authenticated Chrome runtimes, original creation-workspace UI ability entry/action/timeline/reset/exit and actual Godot PCK';
  report.checks.push('original creation-workspace opens prefab ability entry, real attack/drop and animation timeline, clip transport, one physics tick, reset and return to editor');

  const gameJob=await completeBuild(owner,'play-build',mainId,'ordinary-game');assert.notEqual(gameJob.id,previewJob.id);
  const pack=await inspectPack(service.builds.godot,join(data,'builds',gameJob.id,'web/index.pck'),join(data,'pack-inspection'));
  assert.ok(pack.files.includes('res://prefabs/pea.tscn'));assert.equal(pack.files.some(path=>path.startsWith('res://test_scenes/')),false);assert.equal(pack.release.scenes[testId],undefined);assert.equal(pack.release.prefab_test,undefined);
  assert.equal(pack.files.includes('res://atelier_runtime/prefab_test_bridge.gd'),false,'development bridge is physically absent from final PCK');
  const packaged=await exec(service.builds.godot,['--headless','--main-pack',join(data,'builds',gameJob.id,'web/index.pck'),'--quit-after','90'],{timeout:30000,maxBuffer:4*1024*1024});
  const packagedLog=packaged.stdout+packaged.stderr;writeFileSync(join(data,'packaged-game-startup.log'),packagedLog);assert.match(packagedLog,/STANDALONE_READY/);assert.doesNotMatch(packagedLog,/SCRIPT ERROR|Parse Error|^ERROR:/m);
  assert.equal(service.store.branchFor(owner.user,p,'main').head,finalHead,'runtime commands, builds and pack inspection never edit source');
  assert.equal(service.gameReleases.list(owner.user,p,'main').releases.length,0,'neither build implicitly publishes');
  report.game_job=gameJob;report.pack=pack;report.checks.push('fresh runtime restores initial state; ordinary game PCK contains prefab but no preview directory or test registration; source and publication pointer remain unchanged');
  report.ok=true;
});
