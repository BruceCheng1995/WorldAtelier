import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream,existsSync,mkdirSync,mkdtempSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {extname,join,resolve,sep} from 'node:path';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';
import {nativeObjectViews} from '../../services/creation/native-view.mjs';

// PREPARE_ONLY imports the real fixture but does not queue any Web build.
// Normal execution uses unmodified workspace modules, actual HTML DnD mouse
// input, authorized native preview exports and actual source transactions.
test('prefab physical drag through original workbench creates atomic native instances',{timeout:1500000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),app=join(root,'apps/creation-workspace');
  const base=join(root,'.local/creation-verification/prefab-drag-browser');mkdirSync(base,{recursive:true});
  const ghostOnly=Boolean(process.env.PREFAB_DRAG_GHOST_DATA);
  const data=ghostOnly?resolve(process.env.PREFAB_DRAG_GHOST_DATA):mkdtempSync(join(base,'run-')),origin='http://127.0.0.1:48921';
  assert.ok(data.startsWith(base+sep),'only this test own isolated data may be reused');
  const evidence=ghostOnly?mkdtempSync(join(data,'ghost-')):data;
  const report={status:'preparing',scope:'isolated full original workspace + NativeGodotPreview + physical browser mouse + real PackedScene transactions',checks:[],errors:[],transactions:[],builds:[]};
  const save=()=>writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
  const check=(name,details={})=>{report.checks.push({name,...details});save();console.log('PREFAB_DRAG_CHECK '+name);};
  let service,browser,page;
  const sockets=new Set();
  const server=createServer(async(req,res)=>{try{
    if(!service){res.writeHead(503);res.end();return;}
    if(await service.request(req,res))return;
    if(service.builds.webRequest(req,res)||service.assetRequest(req,res))return;
    const path=decodeURIComponent(new URL(req.url,origin).pathname);
    if(path==='/preview-api/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,service:'model-preview',runtime_ready:false}));return;}
    if(path==='/preview-api/catalog'){res.setHeader('content-type','application/json');res.end(readFileSync(join(root,'content/model-preview/manifest.json')));return;}
    const file=path==='/creation-workspace.html'||path==='/'?join(app,'index.html'):
      ['/packages/contracts/authoring-references.mjs','/packages/scene/transform.mjs'].includes(path)?join(root,path.slice(1)):resolve(app,'.'+path);
    if(!file.startsWith(app+sep)&&!file.startsWith(join(root,'packages')+sep)||!existsSync(file)||!statSync(file).isFile()){res.writeHead(404);res.end();return;}
    const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
    res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream','Cache-Control':'no-store','Content-Length':statSync(file).size});createReadStream(file).pipe(res);
  }catch(error){if(!res.headersSent)res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  t.after(async()=>{
    if(report.status==='preparing')report.status='failed';
    if(service)report.builds=service.store.list('creator_build').map(job=>({id:job.id,status:job.status,purpose:job.purpose,source_revision:job.source_revision,canonical_identity:job.canonical_identity,error:job.error}));
    if(page&&!page.isClosed()){
      await page.screenshot({path:join(evidence,'final.png'),fullPage:true}).catch(()=>{});
      await page.locator('body').innerText().then(text=>writeFileSync(join(evidence,'final-page.txt'),text)).catch(()=>{});
      await page.evaluate(()=>window.__dragEvidence).then(evidence=>writeFileSync(join(evidence,'browser-events.json'),JSON.stringify(evidence,null,2))).catch(()=>{});
    }
    try{await browser?.close();}finally{try{await service?.close();}finally{for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(yes=>server.close(yes));report.cleanup={browser_closed:!browser?.isConnected(),server_closed:!server.listening};save();console.log('PREFAB_DRAG_BROWSER_EVIDENCE '+evidence);}}
  });
  // Binding itself is the race-free occupancy check. Never kill an occupier or
  // substitute a different port.
  await new Promise((yes,no)=>{server.once('error',no);server.listen(48921,'127.0.0.1',yes);});
  check('48921 acquired exclusively; production 48910 untouched');
  const settings=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(key=>[key,process.env[key]]);
  for(const [key]of settings)process.env[key]='1';
  try{service=new CreationService({server,root,data,origin});}finally{for(const [key,value]of settings)if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const owner=service.store[ghostOnly?'login':'register']({name:'Prefab drag owner',password:'isolated-prefab-drag-password'});
  const viewer=service.store[ghostOnly?'login':'register']({name:'Prefab drag viewer',password:'isolated-prefab-drag-password'});
  const existing=ghostOnly?JSON.parse(readFileSync(join(data,'fixture.json'))):null;
  const created=ghostOnly?null:await service.createProject(owner.user,{name:'Prefab drag acceptance'}),projectId=existing?.project_id??created.project.id;
  service.store.setMember(owner.user,projectId,viewer.user.id,'viewer');
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Prefab drag acceptance"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    'box.tscn':'[gd_scene load_steps=3 format=3]\n[sub_resource type="StandardMaterial3D" id="material"]\nalbedo_color=Color(1,0.2,0.06,1)\n[sub_resource type="BoxMesh" id="box"]\nmaterial=SubResource("material")\nsize=Vector3(1,1,1)\n[node name="Box" type="Node3D"]\nmetadata/wa_node_id="box-root"\n[node name="Visual" type="MeshInstance3D" parent="."]\nposition=Vector3(0,0.5,0)\nmesh=SubResource("box")\n',
    'main.tscn':'[gd_scene load_steps=4 format=3]\n[ext_resource type="PackedScene" path="res://box.tscn" id="box"]\n[sub_resource type="StandardMaterial3D" id="floor_material"]\nalbedo_color=Color(0.2,0.35,0.3,1)\n[sub_resource type="PlaneMesh" id="floor"]\nmaterial=SubResource("floor_material")\nsize=Vector2(12,12)\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id="main-root"\n[node name="Floor" type="MeshInstance3D" parent="."]\nmetadata/wa_node_id="floor"\nmesh=SubResource("floor")\n[node name="box" parent="." instance=ExtResource("box")]\nposition=Vector3(-2,0,-2)\nmetadata/wa_instance_id="original-box"\n'
  };
  const previous=ghostOnly?service.store.branchFor(owner.user,projectId,'main'):null;
  const imported=ghostOnly?{revision:previous.head,branch:{...previous,manifest:service.store.get('creator_revision',previous.head).manifest}}:await service.committed(owner.user,projectId,'main',{transaction_id:'fixture-import',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
  const rid=imported.branch.manifest.entry_scene_id,prefab=Object.values(imported.branch.manifest.resources).find(r=>r.path==='box.tscn');
  assert.equal(prefab.kind,'prefab');
  const branch=()=>{const value=service.store.branchFor(owner.user,projectId,'main');return {...value,manifest:service.store.get('creator_revision',value.head).manifest};};
  const rows=()=>nativeObjectViews(branch().manifest,rid,{project_id:projectId,branch_id:'main'});
  const instances=()=>rows().filter(row=>row.instance_root&&row.definition_resource_id===prefab.id);
  const source=()=>service.native.archive.read(branch().manifest.source_files['main.tscn']).toString();
  const revisionCount=()=>service.store.list('creator_revision').filter(r=>r.project_id===projectId).length;
  if(!ghostOnly)assert.equal(instances().length,1);else assert.ok(instances().length>=1);assert.match(source(),/instance=ExtResource/);
  writeFileSync(join(evidence,'fixture.json'),JSON.stringify({project_id:projectId,resource_id:rid,prefab_id:prefab.id,revision:imported.revision,texts},null,2));
  check('real native fixture imported and indexed', {resource_id:rid,prefab_id:prefab.id});
  if(process.env.PREFAB_DRAG_PREPARE_ONLY==='1'){assert.equal(service.store.list('creator_build').length,0);report.status='prepared-not-browser-validated';return;}
  browser=await chromium.launch({channel:'chrome',headless:true});
  const setup=async(account)=>{
    const context=await browser.newContext({viewport:{width:1560,height:1000}});
    await context.addInitScript(token=>{
      sessionStorage.setItem('world-atelier-creator-token',token);
      window.__dragEvidence={events:[],runtime:[],focus:[],toasts:[]};
      for(const name of ['blur','focus'])window.addEventListener(name,()=>window.__dragEvidence.focus.push({type:name,at:Date.now()}));
      document.addEventListener('DOMContentLoaded',()=>{new MutationObserver(()=>{const text=document.querySelector('#toast')?.textContent;if(text&&window.__dragEvidence.toasts.at(-1)!==text)window.__dragEvidence.toasts.push(text);}).observe(document.body,{subtree:true,childList:true,characterData:true});});
      for(const name of ['dragstart','dragover','drop','dragend'])document.addEventListener(name,event=>{
        if(name==='dragover'&&window.__dragEvidence.events.at(-1)?.type==='dragover')return;
        window.__dragEvidence.events.push({type:name,trusted:event.isTrusted,x:event.clientX,y:event.clientY,target:event.target.className,prefab:event.target.closest?.('[data-drag-prefab]')?.dataset.dragPrefab});
      },true);
      window.addEventListener('message',event=>{
        if(event.origin===location.origin&&event.data?.source==='world-atelier-preview'&&['loaded','placement','selected','error','prefab_drag'].includes(event.data.type))window.__dragEvidence.runtime.push(event.data);
      });
    },account.token);
    const page=await context.newPage();
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&/SCRIPT ERROR|RuntimeError|AUTHOR_GAMEPLAY/.test(message.text()))report.errors.push(message.text());});
    page.on('response',async response=>{if(response.url().endsWith('/transactions')){try{report.transactions.push({request:response.request().postDataJSON(),status:response.status(),response:await response.json()});}catch(error){report.errors.push(error.message);}}});
    await page.goto(`${origin}/creation-workspace.html#/games/${projectId}/branches/main`);
    await page.locator('#workbench').waitFor({state:'visible',timeout:60000});return page;
  };
  const ready=async(page,resource=rid,revision=branch().head)=>{
    await page.waitForFunction(({documentId,revision})=>{
      const host=document.querySelector('#mainPreview'),frame=host?.querySelector('iframe');
      if(!frame?.src||host.dataset.loadedDocument!==documentId||host.querySelector('.render-status')?.textContent)return false;
      const nonce=new URL(frame.src).searchParams.get('nonce');
      return window.__dragEvidence.runtime.some(m=>m.type==='loaded'&&m.nonce===nonce&&m.document_id===documentId&&m.source_revision===revision&&String(m.seq)===host.dataset.loadedSeq);
    },{documentId:`${projectId}/main/${resource}`,revision},{timeout:300000});
  };
  const showPrefabs=async(page)=>{await page.locator('[data-explorer="prefabs"]').click();await page.locator(`[data-drag-prefab="${prefab.id}"] img:not([hidden])`).waitFor({timeout:60000});await ready(page);await page.waitForTimeout(750);};
  const beginDrag=async(page,x=.66,y=.64,{expectOverlay=true}={})=>{
    const card=page.locator(`[data-drag-prefab="${prefab.id}"] .prefab-picture`);await card.scrollIntoViewIfNeeded();
    const from=await card.boundingBox(),to=await page.locator('#mainPreview iframe').boundingBox();assert.ok(from&&to);
    await page.mouse.move(from.x+from.width*.5,from.y+from.height*.5);await page.mouse.down();
    await page.mouse.move(from.x+from.width*.5+15,from.y+from.height*.5+10,{steps:5});
    await page.mouse.move(to.x+to.width*x,to.y+to.height*y,{steps:20});
    if(expectOverlay)await page.locator('.prefab-drop-target').waitFor({state:'visible',timeout:5000});
    return {x:to.x+to.width*x,y:to.y+to.height*y};
  };
  const noWrite=async(name,action)=>{const head=branch().head,count=revisionCount(),requests=report.transactions.length;await action();await new Promise(yes=>setTimeout(yes,1000));assert.equal(branch().head,head,name+' source unchanged');assert.equal(revisionCount(),count,name+' no revision');assert.equal(report.transactions.length,requests,name+' no transaction request');check(name);};
  page=await setup(owner);await ready(page);await showPrefabs(page);
  check('full original workspace loaded actual native Web runtime');
  if(ghostOnly){
    const head=branch().head,count=revisionCount();
    await page.screenshot({path:join(evidence,'before-ghost.png')});
    await beginDrag(page,.65,.63);
    const valid=()=>page.waitForFunction(()=>{const state=document.querySelector('.prefab-drop-target')?.dataset.ghostState;return state&&state!=='pending'&&state!=='invalid';},null,{timeout:15000});
    await valid();await page.screenshot({path:join(evidence,'ghost-at-a.png')});
    const firstGhost=await page.evaluate(()=>window.__dragEvidence.runtime.filter(m=>m.type==='prefab_drag'&&m.status==='ready').at(-1));
    assert.equal(firstGhost.shape,'3d');assert.equal(firstGhost.position.length,3);
    const beforeMove=await page.evaluate(()=>window.__dragEvidence.runtime.filter(m=>m.type==='prefab_drag').length);
    const frame=await page.locator('#mainPreview iframe').boundingBox();
    await page.mouse.move(frame.x+frame.width*.38,frame.y+frame.height*.68,{steps:15});
    await page.waitForFunction(n=>window.__dragEvidence.runtime.filter(m=>m.type==='prefab_drag').length>n,beforeMove,{timeout:15000});
    await valid();await page.screenshot({path:join(evidence,'ghost-at-b.png')});
    const packets=await page.evaluate(()=>window.__dragEvidence.runtime.filter(m=>m.type==='prefab_drag'));
    writeFileSync(join(evidence,'ghost-feedback.json'),JSON.stringify(packets,null,2));
    const lastGhost=packets.filter(m=>m.status==='ready').at(-1);
    assert.equal(lastGhost.drag_id,firstGhost.drag_id);assert.equal(lastGhost.source_revision,head);
    assert.ok(Math.hypot(...lastGhost.position.map((v,i)=>v-firstGhost.position[i]))>.1,'actual ghost world position follows cursor');
    assert.ok(packets.length>=2);assert.equal(await page.locator('.prefab-drop-target').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
    await page.keyboard.press('Escape');await page.mouse.up();await page.locator('.prefab-drop-target').waitFor({state:'hidden'});
    await page.waitForFunction(id=>window.__dragEvidence.runtime.some(m=>m.type==='prefab_drag'&&m.drag_id===id&&m.status==='cleared'),firstGhost.drag_id,{timeout:5000});
    await page.waitForTimeout(300);await page.screenshot({path:join(evidence,'ghost-cancelled.png')});
    assert.equal(branch().head,head);assert.equal(revisionCount(),count);assert.equal(report.transactions.length,0);
    check('real runtime ghost follows physical drag at two locations and Escape clears without writes',{feedback_count:packets.length});
    assert.deepEqual(report.errors,[]);report.status='passed';return;
  }
  await noWrite('Escape cancels physical drag',async()=>{await beginDrag(page);await page.keyboard.press('Escape');await page.mouse.up();await page.locator('.prefab-drop-target').waitFor({state:'hidden'});});
  await noWrite('drop outside viewport creates nothing',async()=>{await beginDrag(page);const target=await page.locator('#toggleSceneList').boundingBox();assert.ok(target);await page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:12});await page.mouse.up();});
  await noWrite('ordinary card click opens independent prefab editor',async()=>{
    await page.locator(`[data-resource="${prefab.id}"]`).click();await ready(page,prefab.id);
    assert.equal(await page.locator('#mainPreview').getAttribute('data-loaded-document'),`${projectId}/main/${prefab.id}`);
    await page.locator(`[data-scene-resource="${rid}"]`).click();await ready(page);await showPrefabs(page);
  });
  const viewerPage=await setup(viewer);await ready(viewerPage);await showPrefabs(viewerPage);
  await noWrite('read-only collaborator cannot drag-create',async()=>{assert.equal(await viewerPage.locator(`[data-drag-prefab="${prefab.id}"]`).getAttribute('draggable'),'false');await beginDrag(viewerPage,.6,.65,{expectOverlay:false});await viewerPage.mouse.up();assert.equal(await viewerPage.locator('.prefab-drop-target').isVisible(),false);});
  await viewerPage.context().close();
  const create=async(x,y)=>{
    const before=instances(),count=revisionCount(),requestCount=report.transactions.length;
    await beginDrag(page,x,y);await page.screenshot({path:join(data,`drag-${before.length}.png`)});await page.mouse.up();
    await page.waitForFunction(()=>!document.querySelector('.prefab-drop-target')||document.querySelector('.prefab-drop-target').hidden);
    const deadline=Date.now()+60000;while(instances().length===before.length&&Date.now()<deadline)await new Promise(yes=>setTimeout(yes,100));
    assert.equal(instances().length,before.length+1,'single drop creates exactly one native instance');
    assert.equal(revisionCount(),count+1,'placement and instantiation are one commit');
    const added=instances().find(row=>!before.some(old=>old.id===row.id));assert.ok(added);
    assert.ok(Math.hypot(...added.position)>.1,'physical off-center position is not origin');
    await ready(page);await page.getByRole('button',{name:`对象名称：${added.name}`,exact:true}).waitFor({timeout:30000});
    const transactions=report.transactions.slice(requestCount);assert.equal(transactions.length,1);assert.equal(transactions[0].status,200);
    const ops=transactions[0].request.ops;assert.equal(ops.length,1);assert.equal(ops[0].operation.op,'instantiate');assert.equal(ops[0].operation.placement.dimension,'3d');
    for(let n=0;n<3;n++)assert.ok(Math.abs(added.position[n]-ops[0].operation.placement.position[n])<.001,'committed world position agrees with engine projection');
    const evidence=await page.evaluate(()=>window.__dragEvidence);
    assert.ok(evidence.events.some(e=>e.type==='drop'&&e.trusted));assert.ok(evidence.events.some(e=>e.type==='dragstart'&&e.trusted));
    assert.ok(evidence.runtime.some(m=>m.type==='placement'&&!m.error),'real engine placement response observed');
    // Selected tree row is the persisted instance, even though the catalog is visible during drop.
    await page.locator('[data-explorer="scene"]').click();assert.equal(await page.locator(`[data-select="${added.id}"]`).getAttribute('aria-selected'),'true');
    await page.screenshot({path:join(data,`created-${before.length}.png`)});writeFileSync(join(data,`source-${before.length}.tscn`),source());
    assert.match(source(),new RegExp('\\[node name="'+added.name+'"[^\\n]*instance=ExtResource'));
    check('single physical drop creates, places and selects one PackedScene instance',{instance_name:added.name,id:added.id,position:added.position,revision:branch().head});
    await showPrefabs(page);return added;
  };
  const first=await create(.65,.63),second=await create(.36,.67);
  assert.equal(first.name,prefab.name+' 2');assert.equal(second.name,prefab.name+' 3');assert.notEqual(first.id,second.id);
  check('repeated prefab names receive distinct numbered names');
  if(process.env.PREFAB_DRAG_WAIT_UNDO==='1'){console.log('PREFAB_DRAG_WAITING_UNDO '+join(data,'allow-undo'));while(!existsSync(join(data,'allow-undo')))await new Promise(yes=>setTimeout(yes,500));}
  const beforeUndo=revisionCount();await page.locator('#undoTransform').click();
  const undoDeadline=Date.now()+60000;while(instances().some(row=>row.id===second.id)&&Date.now()<undoDeadline)await new Promise(yes=>setTimeout(yes,100));
  assert.equal(instances().length,2);assert.ok(instances().some(row=>row.id===first.id));assert.ok(!instances().some(row=>row.id===second.id));assert.equal(revisionCount(),beforeUndo+1);
  await ready(page);check('one Undo deletes the complete most recent instance');await showPrefabs(page);
  await beginDrag(page);
  const current=branch(),beforeStale=instances().length,requests=report.transactions.length;
  const changed=await service.committed(owner.user,projectId,'main',{transaction_id:'concurrent-source-change',base_revision:current.head,expected_head:current.head,ops:[{type:'put_source_file',path:'main.tscn',expected_hash:current.manifest.source_files['main.tscn'].hash,text:source()+'\n; Concurrent editor source change\n'}]});
  await page.locator('.prefab-drop-target').waitFor({state:'hidden',timeout:15000});await page.mouse.up();await new Promise(yes=>setTimeout(yes,1000));
  assert.equal(branch().head,changed.revision);assert.equal(instances().length,beforeStale);assert.equal(report.transactions.length,requests);
  check('source version change during drag cancels without submitting placement');
  assert.deepEqual(report.errors,[]);report.status='passed';
});
