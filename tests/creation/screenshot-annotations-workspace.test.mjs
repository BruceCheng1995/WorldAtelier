/** Independent product flow: actual original workbench, native Web Godot,
 * HTTP/SQLite and immutable image bytes. Explicit lost-response injections only;
 * no Agent execution, formal-service access, or desktop Godot/CUA input. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream,existsSync,mkdirSync,mkdtempSync,statSync,writeFileSync} from 'node:fs';
import {extname,join,resolve,sep} from 'node:path';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';

test('real native viewport screenshots merge marked images into unsent drafts and safely retry lost upload/PATCH replies',{timeout:600000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),app=join(root,'apps/creation-workspace'),base=join(root,'.local/creation-verification/screenshot-workspace');mkdirSync(base,{recursive:true});
  const data=mkdtempSync(join(base,'browser-')),origin='http://127.0.0.1:48921',report={scope:'Real native 2D/3D Web Godot capture, screenshot marks, unsent drafts and persistence; only response loss is injected. No model execution.',checks:[],errors:[],status:'running'};
  let service,browser,page;
  const sockets=new Set(),server=createServer(async(req,res)=>{try{
    if(await service.request(req,res)||service.builds.webRequest(req,res)||service.assetRequest(req,res))return;
    const path=decodeURIComponent(new URL(req.url,origin).pathname);
    if(path==='/preview-api/health'||path==='/preview-api/catalog'){res.setHeader('content-type','application/json');res.end(JSON.stringify(path.endsWith('health')?{ok:true,service:'model-preview',runtime_ready:false}:{models:[]}));return;}
    const file=path==='/creation-workspace.html'?join(app,'index.html'):path.startsWith('/packages/')?resolve(root,'.'+path):resolve(app,'.'+path);
    if(!file.startsWith(app+sep)&&!file.startsWith(join(root,'packages')+sep)||!existsSync(file)||!statSync(file).isFile()){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});createReadStream(file).pipe(res);
  }catch(error){if(!res.headersSent)res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  const check=name=>{report.checks.push(name);console.log('SCREENSHOT_WORKSPACE_PASS '+name);};
  t.after(async()=>{
    if(page&&!page.isClosed()){await page.screenshot({path:join(data,'final.png')}).catch(()=>{});report.annotation_state=await page.locator('.annotation-layer').evaluate(el=>({...el.dataset})).catch(()=>null);writeFileSync(join(data,'final-page.txt'),await page.locator('body').innerText().catch(()=>''));}
    await browser?.close();await service?.close();for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));
    writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2));console.log('SCREENSHOT_WORKSPACE_EVIDENCE '+data);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(48921,'127.0.0.1',resolve);});
  const env=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(key=>[key,process.env[key]]);for(const [key]of env)process.env[key]='1';
  try{service=new CreationService({server,root,data,origin});}finally{for(const [key,value]of env)if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const owner=service.store.register({name:'Screenshot browser owner',password:'isolated-screenshot-browser-password'}),created=await service.createProject(owner.user,{name:'截图划线独立验证'}),p=created.project.id;
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Screenshot browser fixture"\nrun/main_scene="res://canvas.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    'canvas.tscn':'[gd_scene format=3]\n[node name="Canvas" type="Node2D"]\nmetadata/wa_node_id="canvas-root"\n[node name="Garden" type="Polygon2D" parent="."]\nmetadata/wa_node_id="garden"\npolygon=PackedVector2Array(50,50,750,50,750,480,50,480)\ncolor=Color(0.11,0.24,0.2,1)\n[node name="Tower" type="Polygon2D" parent="."]\nmetadata/wa_node_id="tower"\npolygon=PackedVector2Array(150,170,270,170,270,340,150,340)\ncolor=Color(0.4,0.69,0.9,1)\n[node name="Gate" type="Polygon2D" parent="."]\nmetadata/wa_node_id="gate"\npolygon=PackedVector2Array(460,180,610,180,610,350,460,350)\ncolor=Color(0.9,0.68,0.36,1)\n',
    'world.tscn':'[gd_scene load_steps=4 format=3]\n[sub_resource type="StandardMaterial3D" id="mat"]\nalbedo_color=Color(0.3,0.65,0.8,1)\n[sub_resource type="BoxMesh" id="box"]\nmaterial=SubResource("mat")\nsize=Vector3(2,3,2)\n[sub_resource type="PlaneMesh" id="floor"]\nsize=Vector2(12,12)\n[node name="World" type="Node3D"]\nmetadata/wa_node_id="world-root"\n[node name="Tower" type="MeshInstance3D" parent="."]\nmetadata/wa_node_id="tower3d"\nposition=Vector3(0,1.5,0)\nmesh=SubResource("box")\n[node name="Ground" type="MeshInstance3D" parent="."]\nmetadata/wa_node_id="ground3d"\nmesh=SubResource("floor")\n'
  };
  const imported=await service.committed(owner.user,p,'main',{transaction_id:'screenshot-fixture',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
  const rid=imported.branch.manifest.entry_scene_id,world=Object.values(imported.branch.manifest.resources).find(r=>r.path==='world.tscn'),sourceHead=imported.branch.head;
  const original=service.store.createSession(owner.user,p,'main',{title:'保留旧会话草稿',visibility:'private',effort:null});service.store.updateSession(owner.user,original.id,{draft:'不要覆盖这段旧会话的未发送文字。'});
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});const context=await browser.newContext({viewport:{width:1560,height:1000}});
  await context.addInitScript(token=>sessionStorage.setItem('world-atelier-creator-token',token),owner.token);
  page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/SCRIPT ERROR|RuntimeError/.test(m.text()))report.errors.push(m.text());});
  await page.goto(`${origin}/creation-workspace.html#/games/${p}/branches/main`);
  const ready=async resource=>page.waitForFunction(id=>{const h=document.querySelector('#mainPreview');return h?.dataset.loadedDocument===id&&!h.querySelector('.render-status')?.textContent;},`${p}/main/${resource}`,{timeout:300000});await ready(rid);
  await page.locator('#toggleAnnotations:not([disabled])').waitFor({timeout:30000});check('original workbench renders actual native 2D Web editor');
  const session=id=>service.store.sessionView(owner.user,id),sessions=()=>service.store.list('creator_session');
  const chooseSession=async id=>{if(!await page.locator('#chatDrawer').isVisible())await page.locator('#agentsMenuButton').click();if(!await page.locator('#chatSessions').isVisible())await page.locator('#toggleSessions').click();await page.locator(`#sessionList [data-session="${id}"]`).click();await page.waitForFunction(id=>document.querySelector('#sessionDraft')?.dataset.session===id,id);};
  const closeChat=async()=>{if(await page.locator('#closeChat').isVisible())await page.locator('#closeChat').click();};
  const enter=async()=>{await closeChat();if(await page.locator('#toggleAnnotations').getAttribute('aria-pressed')!=='true')await page.locator('#toggleAnnotations').click();await page.waitForFunction(()=>!document.querySelector('.annotation-layer')?.classList.contains('is-entering'));};
  const openScreenshot=async()=>{await page.locator('[data-annotation-screenshot]').click();await page.locator('.screenshot-annotation-editor').waitFor({state:'visible',timeout:10000});};
  const canvas=page.getByLabel('截图划线画布',{exact:true}),dialog=page.locator('.screenshot-annotation-editor'),save=dialog.locator('[data-markup-action=save]');
  const draw=async tool=>{await dialog.locator(`[data-markup-tool="${tool}"]`).click();const b=await canvas.boundingBox();await page.mouse.move(b.x+b.width*.20,b.y+b.height*.30);await page.mouse.down();await page.mouse.move(b.x+b.width*.70,b.y+b.height*.65,{steps:18});await page.mouse.up();};
  await chooseSession(original.id);await page.locator('.reference-editor').fill('旧草稿已继续编辑，还不能发送。');await closeChat();
  await enter();await openScreenshot();await page.screenshot({path:join(data,'2d-captured-cancel.png')});await dialog.locator('[data-markup-action=cancel]').last().click();await dialog.waitFor({state:'hidden'});
  assert.equal(sessions().length,1);assert.equal(await page.locator('#toggleAnnotations').getAttribute('aria-pressed'),'true');check('cancel real screenshot creates no session and resumes annotation mode');
  await page.locator('[data-annotation-tool=point][data-target=space]').click();await page.waitForFunction(()=>!document.querySelector('.annotation-layer')?.classList.contains('is-entering'));
  const view=await page.locator('#mainPreview iframe').boundingBox();await page.mouse.click(view.x+view.width*.20,view.y+view.height*.35);await page.getByLabel('批注描述',{exact:true}).fill('在这个固定空间点布置入口。');await page.getByRole('button',{name:'保存批注',exact:true}).click();await page.locator('.annotation-bubble').waitFor({state:'hidden'});assert.equal(await page.locator('.annotation-list-row').count(),1);
  await openScreenshot();await draw('pen');await page.getByLabel('截图批注说明',{exact:true}).fill('沿红线铺一条路，连接空间批注标出的入口。');const marked=await canvas.evaluate(el=>el.toDataURL('image/png'));await page.screenshot({path:join(data,'2d-marked.png')});
  let uploads=0,lostUploads=0,lostDrafts=0;
  await page.route('**/creation-api/sessions/*/image-attachments?*',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}uploads++;const response=await route.fetch();if(lostUploads++===0){assert.equal(response.status(),201);await route.abort('failed');}else await route.fulfill({response});});
  await page.route('**/creation-api/sessions/*',async route=>{const request=route.request();if(request.method()!=='PATCH'||!request.postDataJSON()?.draft?.includes('截图划线批注')){await route.continue();return;}const response=await route.fetch();if(lostDrafts++===0){assert.equal(response.status(),200);await route.abort('failed');}else await route.fulfill({response});});
  const saveError=()=>page.waitForFunction(()=>Boolean(document.querySelector('.screenshot-error')?.textContent));
  await save.click();await saveError();assert.equal(lostUploads,1);assert.equal(sessions().length,2);const combined=sessions().find(s=>s.id!==original.id);assert.equal(session(combined.id).draft_attachments.filter(a=>a.kind==='image').length,1);
  await save.click();await saveError();assert.equal(lostDrafts,1);assert.equal(sessions().length,2);assert.equal(uploads,1);assert.match(session(combined.id).draft,/沿红线铺一条路/);
  await save.click();await dialog.waitFor({state:'hidden'});await page.waitForFunction(id=>document.querySelector('#sessionDraft')?.dataset.session===id,combined.id);
  assert.equal(sessions().length,2);assert.equal(uploads,1);const combinedView=session(combined.id),combinedImage=combinedView.draft_attachments.find(a=>a.kind==='image'),spatial=combinedView.draft_attachments.find(a=>a.kind==='viewport_annotation');
  assert.equal(combinedView.draft_attachments.length,2);assert.equal(spatial.annotation_kind,'point');assert.equal(spatial.source_revision,sourceHead);assert.match(combinedView.draft,/截图划线批注（1 笔）/);assert.match(combinedView.draft,/固定空间点/);assert.match(combinedView.draft,new RegExp(sourceHead));assert.match(combinedView.draft,/屏幕标记/);assert.match(combinedView.draft,/截图相机/);assert.deepEqual(service.sessionImages.bytes(combinedImage),Buffer.from(marked.split(',')[1],'base64'));assert.equal(await page.locator('.annotation-list-row').count(),0);assert.equal(await page.locator('#toggleAnnotations').getAttribute('aria-pressed'),'false');
  await page.waitForFunction(()=>document.querySelector('#draftAttachments img')?.naturalWidth>0);await page.locator('#chatDrawer').evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));});await page.screenshot({path:join(data,'combined-draft.png')});writeFileSync(join(data,'combined-image.png'),service.sessionImages.bytes(combinedImage));check('lost upload and PATCH replies safely retry one merged spatial/image draft with exact marked pixels and fixed context');
  assert.equal(session(original.id).draft,'旧草稿已继续编辑，还不能发送。');assert.deepEqual(session(original.id).draft_attachments,[]);check('previous selected session keeps its unsent text and attachments');
  await page.unrouteAll({behavior:'wait'});await closeChat();await page.locator(`[data-resource="${world.id}"]`).first().click();await ready(world.id);await enter();await openScreenshot();await draw('arrow');await page.getByLabel('截图批注说明',{exact:true}).fill('把箭头尽头做成更明显的入口。');await page.screenshot({path:join(data,'3d-marked.png')});await save.click();await dialog.waitFor({state:'hidden'});
  assert.equal(sessions().length,3);const standalone=sessions().find(s=>![original.id,combined.id].includes(s.id));await page.waitForFunction(id=>document.querySelector('#sessionDraft')?.dataset.session===id,standalone.id);const standaloneView=session(standalone.id);assert.equal(standaloneView.draft_attachments.length,1);assert.equal(standaloneView.draft_attachments[0].kind,'image');assert.match(standaloneView.draft,/把箭头尽头/);assert.match(standaloneView.draft,new RegExp(world.id));assert.equal(session(combined.id).draft_attachments.length,2);check('actual native 3D screenshot alone creates one new unsent image draft without changing earlier draft');
  await page.reload();await page.locator('#workbench').waitFor({state:'visible'});await chooseSession(combined.id);await page.waitForFunction(()=>document.querySelector('#draftAttachments img')?.naturalWidth>0);assert.match(await page.locator('#sessionDraft').inputValue(),/沿红线铺一条路/);await chooseSession(standalone.id);await page.waitForFunction(()=>document.querySelector('#draftAttachments img')?.naturalWidth>0);assert.match(await page.locator('#sessionDraft').inputValue(),/把箭头尽头/);await chooseSession(original.id);assert.equal(await page.locator('#sessionDraft').inputValue(),'旧草稿已继续编辑，还不能发送。');assert.equal(await page.locator('#draftAttachments img').count(),0);check('reload and session switching preserve each separate image/spatial/text draft');
  assert.equal(service.store.branchFor(owner.user,p,'main').head,sourceHead);assert.equal(service.store.list('creator_run').length,0);assert.equal(service.store.list('creator_message').length,0);assert.deepEqual(report.errors,[]);report.source_head=sourceHead;report.sessions=[original.id,combined.id,standalone.id];report.upload_requests=uploads;report.status='passed';check('source head remains fixed and no Agent run or sent message is created');
});
