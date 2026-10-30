// Fresh deployment smoke test against the canonical service and actual Godot
// Web exports. No Agent, OS input, foreground engine or synthetic runtime ACKs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:90000});

const root=resolve(import.meta.dirname,'../..'),port=48921,origin=`http://127.0.0.1:${port}`;
const external=process.env.WORLD_ATELIER_TEST_EXTERNAL_ORIGIN;
if(external&&external!==origin)throw Error('External deployment checks require the isolated http://127.0.0.1:48921 origin');
const bootDelay=Number(process.env.WORLD_ATELIER_TEST_GAME_BOOT_DELAY_MS??0);
assert.ok(Number.isSafeInteger(bootDelay)&&bootDelay>=0&&bootDelay<=90000,'Game boot delay must be between 0 and 90000 ms');
const base=join(root,'.local/creation-verification/default-projects-browser');mkdirSync(base,{recursive:true});
const data=mkdtempSync(join(base,'run-')),report={data,origin,games:[],page_errors:[],http_errors:[],request_failures:[],completed:false,game_boot_delay_ms:bootDelay,browser_isolation:'context_per_case'};
const wait=ms=>new Promise(done=>setTimeout(done,ms));
let child,browser,log='';
const failedBuilds=new Map();
async function waitForEditor(page,{projectId,revision,documentId}){
  const deadline=Date.now()+600000;let observed;
  while(Date.now()<deadline){
    const failure=[...failedBuilds.values()].find(job=>job.project_id===projectId&&job.source_revision===revision&&job.purpose==='native_preview');
    if(failure)throw Error('Native editor build failed: '+JSON.stringify(failure.error));
    observed=await page.locator('#mainPreview').evaluate(node=>({state:node.dataset.previewState,document:node.dataset.loadedDocument,source:node.dataset.displayedSource,status:node.querySelector('.render-status')?.textContent}));
    if(observed.state==='ready'&&observed.document===documentId&&observed.source===revision)return observed;
    if(observed.state==='error')throw Error('Current project editor failed: '+JSON.stringify({projectId,revision,observed}));
    await wait(250);
  }
  throw Error('Pinned editor did not load: '+JSON.stringify({projectId,revision,documentId,observed}));
}
if(!external){const free=createServer();await new Promise((done,reject)=>{free.once('error',reject);free.listen(port,'127.0.0.1',done);});await new Promise(done=>free.close(done));}
console.log('DEFAULT_BROWSER_EVIDENCE '+data);
try{
  if(!external){
    child=spawn(process.execPath,['tools/start-workspace.mjs'],{cwd:root,env:{...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:join(data,'preview'),WORLD_ATELIER_CREATION_DATA:join(data,'creation'),WORLD_ATELIER_PUBLIC_PLAY:'1',WORLD_ATELIER_DEFAULT_PROJECTS:'1',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>{log+=bytes;});child.stderr.on('data',bytes=>{log+=bytes;});
  }
  report.external_service=Boolean(external);
  let healthy=false;
  for(let i=0;i<600;i++){
    if(child&&child.exitCode!==null)throw Error(log);
    try{const health=await fetch(origin+'/creation-api/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());if(health.ok){assert.equal(health.default_projects.count,9);healthy=true;break;}}catch{}
    await wait(250);
  }
  assert.ok(healthy,'Fresh deployment did not become ready: '+log);
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
  let context,page;
  const newPage=async evidence=>{
    await context?.close();
    context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();
    page.setDefaultTimeout(120000);
    await page.addInitScript(()=>{
      window.__defaultRuntimeEvidence=[];
      window.addEventListener('message',event=>{
        const packet=event.data;
        if(packet?.source!=='world-atelier-game'||!['ready','loaded','runtime_error','error'].includes(packet.type))return;
        const frame=document.querySelector('#mainPreview iframe[title="Godot 独立游戏"]'),url=frame?.src?new URL(frame.src,location.href):null;
        const current_frame=Boolean(frame&&event.source===frame.contentWindow&&event.origin===url?.origin&&packet.nonce===url?.searchParams.get('nonce'));
        if(window.__defaultRuntimeEvidence.length<40)window.__defaultRuntimeEvidence.push({at:new Date().toISOString(),type:packet.type,origin:event.origin,current_frame,source_revision:packet.source_revision,canonical_identity:packet.canonical_identity,document_id:packet.document_id,message:packet.message});
      });
    });
    if(evidence){
      evidence.console=[];evidence.runtime_assets=[];
      page.on('console',message=>{const text=message.text();if(evidence.console.length<80&&(['error','warning'].includes(message.type())||/Godot Engine|WebGL|WebAssembly/.test(text)))evidence.console.push({at:new Date().toISOString(),type:message.type(),text:text.slice(0,1600)});});
      const assets=new Map();
      page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/creation-runtime/')&&/\.(wasm|pck)$/.test(url.pathname)&&evidence.runtime_assets.length<20){const row={asset:url.pathname.split('/').at(-1),build_id:url.pathname.split('/')[3],started_at:new Date().toISOString(),status:'pending'};assets.set(request,row);evidence.runtime_assets.push(row);}});
      for(const event of ['requestfinished','requestfailed'])page.on(event,request=>{const row=assets.get(request);if(row)Object.assign(row,{status:event==='requestfinished'?'completed':'failed',finished_at:new Date().toISOString(),timing:request.timing(),error:request.failure()?.errorText});});
    }
    if(bootDelay)await page.route(/\/creation-runtime\/[^/]+\/build-[^/]+\/web\/index\.wasm(?:\?|$)/,async route=>{await wait(bootDelay);await route.continue().catch(()=>{});});
    page.on('pageerror',error=>report.page_errors.push(error.message));
    page.on('requestfailed',request=>{const url=new URL(request.url());report.request_failures.push({url:url.origin+url.pathname,error:request.failure()?.errorText});});
    page.on('response',async response=>{
      if(response.status()>=400&&response.url().includes('/creation-api/'))report.http_errors.push({status:response.status(),url:response.url()});
      if(/\/creation-api\/builds\/[^/]+$/.test(response.url()))try{const {job}=await response.json();if(job?.status==='failed')failedBuilds.set(job.id,{error:job.error,project_id:job.project_id,source_revision:job.source_revision,purpose:job.purpose});}catch{}
    });
  };
  await newPage();
  await page.goto(origin+'/creation-workspace.html');
  await page.locator('#authMode').selectOption(process.env.WORLD_ATELIER_TEST_REUSE_ACCOUNT==='1'?'login':'register');
  await page.locator('#authName').fill('默认工程部署检查');await page.locator('#authPassword').fill('default-project-isolated-password');await page.locator('#authSubmit').click();
  await expect(page.locator('#gameCards .game-card')).toHaveCount(9);
  await expect(page.locator('#gameCards .game-role').filter({hasText:'默认工程'})).toHaveCount(9);
  await page.screenshot({path:join(data,'library.png')});
  const bootstrap=await page.evaluate(async()=>fetch('/creation-api/bootstrap',{headers:{authorization:'Bearer '+sessionStorage.getItem('world-atelier-creator-token')}}).then(r=>r.json()));
  assert.equal(bootstrap.can_create_project,true);assert.ok(bootstrap.projects.every(project=>project.role==='viewer'&&project.members.length===0));
  const selected=process.env.WORLD_ATELIER_DEFAULT_TEST_GAMES?.split(',');
  const ordered=[...bootstrap.projects].filter(project=>!selected||selected.includes(project.name)).sort((a,b)=>['俄罗斯方块','兽人必须死','植物大战僵尸','贪吃蛇','坦克大战','TPS','小小梦魇','塔防游戏','小巷漫步'].indexOf(a.name)-['俄罗斯方块','兽人必须死','植物大战僵尸','贪吃蛇','坦克大战','TPS','小小梦魇','塔防游戏','小巷漫步'].indexOf(b.name));
  assert.ok(ordered.length>0,'No default projects matched the requested test selection');
  if(selected)assert.deepEqual(ordered.map(project=>project.name).sort(),[...new Set(selected)].sort());
  else assert.equal(ordered.length,9);
  for(const project of ordered){
    const row={name:project.name,id:project.id,started_at:new Date().toISOString()};report.games.push(row);console.log('DEFAULT_BROWSER_OPEN '+project.name);
    try{
      // Keep one browser process across the full deployment run, while each
      // visitor window starts with fresh auth/session state and game heaps.
      await newPage(row);await page.goto(origin+'/creation-workspace.html');
      await page.locator('#authMode').selectOption('login');await page.locator('#authName').fill('默认工程部署检查');await page.locator('#authPassword').fill('default-project-isolated-password');await page.locator('#authSubmit').click();
      await expect(page.locator('#gameLibrary')).toBeVisible();await expect(page.locator('#gameCards .game-card')).toHaveCount(9);
      const fixed=await page.evaluate(async projectId=>{
        const response=await fetch(`/creation-api/projects/${projectId}/branches/main/playable-game`,{headers:{authorization:'Bearer '+sessionStorage.getItem('world-atelier-creator-token')}});
        const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;
      },project.id);
      const pins={projectId:project.id,revision:fixed.source_revision,documentId:`${project.id}/main/${fixed.resource_id}`};row.expected=pins;
      assert.equal(pins.revision,project.branches.find(branch=>branch.branch_id==='main').head);
      await page.locator(`a.game-select[data-game="${project.id}"]`).click();
      await expect(page.locator('#selectedGameTitle')).toHaveText(project.name);
      await expect(page.locator('#projectLabel')).toContainText('默认工程');
      await page.locator('#gamePrimaryEntry').click();await expect(page.locator('#workbench')).toBeVisible();
      // Hash navigation keeps the viewport DOM. Its previous ready marker is
      // not evidence that this project's fixed source has finished loading.
      row.editor=await waitForEditor(page,pins);
      if(project.name==='俄罗斯方块'){
        await page.locator('#browsePrefabs').click();
        const prefab=page.locator('button.prefab-picture[data-resource]').first();await expect(prefab).toBeVisible();
        const prefabId=await prefab.getAttribute('data-resource');
        await prefab.click();await expect(page.locator('#currentDocumentKind')).toHaveText('定义');
        await waitForEditor(page,{...pins,documentId:`${project.id}/main/${prefabId}`});
        row.prefab_opened=await page.locator('#currentDocumentName').textContent();
        row.prefab_document=await page.locator('#mainPreview').getAttribute('data-loaded-document');
        assert.notEqual(row.prefab_document,row.editor.document);
        // Return through the real scene list before starting gameplay.
        await page.locator(`#sceneList [data-scene-resource="${fixed.resource_id}"]`).click();
        await expect(page.locator('#currentDocumentKind')).toHaveText('场景');
        await waitForEditor(page,pins);
      }
      await page.locator('[data-mode="play"]').click();
      const deadline=Date.now()+600000;let playing=false;row.mode_transitions=[];
      while(Date.now()<deadline){
        const ui=await page.evaluate(()=>({mode:document.querySelector('#stage').dataset.previewMode,status:document.querySelector('#workspaceStatus').textContent,render_status:document.querySelector('#mainPreview .render-status')?.textContent}));
        if(row.mode_transitions.at(-1)?.mode!==ui.mode)row.mode_transitions.push({...ui,at:new Date().toISOString()});
        if(ui.mode==='edit'&&row.mode_transitions.some(item=>item.mode==='preparing'))throw Error('Game returned to editing before startup: '+JSON.stringify(ui));
        const id=await page.locator('#mainPreview').getAttribute('data-game-build');
        if(id)row.attempted_build=id;
        if(failedBuilds.get(id)?.project_id===project.id)throw Error('Canonical Play build failed: '+JSON.stringify(failedBuilds.get(id).error));
        playing=await page.locator('#playControls').evaluate((node,revision)=>node.dataset.mode==='playing'&&node.dataset.displayRevision===revision&&Number(node.dataset.tick)>10,pins.revision);
        if(playing)break;await wait(1000);
      }
      assert.ok(playing,'Canonical game did not reach playing state');
      row.play=await page.locator('#playControls').evaluate(node=>({...node.dataset}));
      assert.equal(row.play.displayRevision,pins.revision);
      row.play_document=await page.locator('#mainPreview').getAttribute('data-loaded-document');
      assert.ok(row.play_document.startsWith(`${project.id}/main/`));
      row.build=await page.locator('#mainPreview').getAttribute('data-game-build');
      row.build_identity=await page.evaluate(async id=>{
        const response=await fetch(`/creation-api/builds/${id}`,{headers:{authorization:'Bearer '+sessionStorage.getItem('world-atelier-creator-token')}});
        const result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));
        const {project_id,branch_id,source_revision,entry_scene_id,canonical_identity,purpose,status,toolchain_identity}=result.job;
        return {project_id,branch_id,source_revision,entry_scene_id,canonical_identity,purpose,status,execution:toolchain_identity?.execution??null};
      },row.build);
      assert.equal(row.build_identity.project_id,project.id);assert.equal(row.build_identity.branch_id,'main');
      assert.equal(row.build_identity.source_revision,pins.revision);assert.equal(row.build_identity.entry_scene_id,fixed.resource_id);
      assert.equal(row.build_identity.purpose,'play');assert.equal(row.build_identity.status,'completed');
      assert.equal(await page.locator('#mainPreview').getAttribute('data-runtime-build'),row.build_identity.canonical_identity);
      await page.waitForFunction(({tick,revision,build})=>document.querySelector('#playControls')?.dataset.displayRevision===revision&&document.querySelector('#mainPreview')?.dataset.gameBuild===build&&Number(document.querySelector('#playControls').dataset.tick)>tick+20,{tick:Number(row.play.tick),revision:pins.revision,build:row.build},{timeout:30000});
      row.later_tick=Number(await page.locator('#playControls').getAttribute('data-tick'));
      await expect(page.locator('#playControls')).toHaveAttribute('data-display-revision',pins.revision);
      await expect(page.locator('#mainPreview')).toHaveAttribute('data-game-build',row.build);
      await page.screenshot({path:join(data,project.id+'-play.png')});
      if(project.name==='俄罗斯方块'||project.name==='兽人必须死'){
        await page.locator('[data-mode="inspect"]').click();
        await expect(page.locator('#previewModeTitle')).toHaveText('暂停观察');
        await expect(page.locator('#playControls')).toHaveAttribute('data-display-revision',pins.revision);
        await expect(page.locator('#mainPreview')).toHaveAttribute('data-game-build',row.build);
        row.inspection=await page.locator('#playControls').evaluate(node=>({mode:node.dataset.mode,tick:node.dataset.frozenTick}));
        await page.locator('[data-mode="play"]').click();await expect(page.locator('#previewModeTitle')).toHaveText('独立试玩');
        await expect(page.locator('#playControls')).toHaveAttribute('data-display-revision',pins.revision);
        await expect(page.locator('#mainPreview')).toHaveAttribute('data-game-build',row.build);
        row.resume=true;
      }
      row.runtime_events=await page.evaluate(()=>window.__defaultRuntimeEvidence);
      row.passed=true;console.log('DEFAULT_BROWSER_PLAYED '+project.name+' tick '+row.play.tick+' → '+row.later_tick);
    }catch(error){
      row.runtime_events=await page.evaluate(()=>window.__defaultRuntimeEvidence).catch(()=>null);
      row.failure_ui=await page.evaluate(()=>({mode:document.querySelector('#stage')?.dataset.previewMode,status:document.querySelector('#workspaceStatus')?.textContent,render_status:document.querySelector('#mainPreview .render-status')?.textContent,preview:{...document.querySelector('#mainPreview')?.dataset},play:{...document.querySelector('#playControls')?.dataset}})).catch(()=>null);
      row.passed=false;row.error=error.stack;await page.screenshot({path:join(data,project.id+'-failure.png'),timeout:15000}).catch(()=>{});console.log('DEFAULT_BROWSER_FAILED '+project.name+': '+error.message);
      const serviceAlive=await fetch(origin+'/creation-api/health',{signal:AbortSignal.timeout(5000)}).then(response=>response.ok).catch(()=>false);
      if(!serviceAlive){report.service_unreachable=true;break;}
    }
    writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');
  }
  assert.ok(report.games.every(game=>game.passed),JSON.stringify(report.games.filter(game=>!game.passed).map(game=>({name:game.name,error:game.error}))));
  assert.deepEqual(report.page_errors,[]);report.completed=true;
}finally{
  await browser?.close();
  if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('exit',done));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),30000);await closed;clearTimeout(timer);}
  writeFileSync(join(data,'server.log'),log);writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('DEFAULT_BROWSER_REPORT '+join(data,'report.json'));
}
