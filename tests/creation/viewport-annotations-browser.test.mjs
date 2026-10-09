import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream,existsSync,mkdirSync,mkdtempSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {extname,join,resolve,sep} from 'node:path';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';

test('original workbench captures real Godot annotations into one unsent draft and pastes into another',{timeout:900000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),app=join(root,'apps/creation-workspace'),base=join(root,'.local/creation-verification/annotation-v2');mkdirSync(base,{recursive:true});
  const data=mkdtempSync(join(base,'browser-')),origin='http://127.0.0.1:48921',report={checks:[],errors:[],status:'running'};
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
  const check=name=>{report.checks.push(name);console.log('ANNOTATION_BROWSER_CHECK '+name);};
  t.after(async()=>{
    if(page&&!page.isClosed()){await page.screenshot({path:join(data,'final.png')}).catch(()=>{});report.annotation_state=await page.locator('.annotation-layer').evaluate(el=>({...el.dataset})).catch(()=>null);writeFileSync(join(data,'final-page.txt'),await page.locator('body').innerText().catch(()=>''));writeFileSync(join(data,'events.json'),JSON.stringify(await page.evaluate(()=>window.annotationEvents).catch(()=>[]),null,2));}
    await browser?.close();await service?.close();for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));
    writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2));console.log('ANNOTATION_BROWSER_EVIDENCE '+data);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(48921,'127.0.0.1',resolve);});
  const env=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(key=>[key,process.env[key]]);for(const [key]of env)process.env[key]='1';
  try{service=new CreationService({server,root,data,origin});}finally{for(const [key,value]of env)if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const owner=service.store.register({name:'Annotation browser owner',password:'isolated-annotation-browser-password'}),created=await service.createProject(owner.user,{name:'视口批注体验验证'}),p=created.project.id;
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Annotation browser fixture"\nrun/main_scene="res://canvas.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    'canvas.tscn':'[gd_scene format=3]\n[node name="Canvas" type="Node2D"]\nmetadata/wa_node_id="canvas-root"\n[node name="Garden" type="Polygon2D" parent="."]\nmetadata/wa_node_id="garden"\npolygon=PackedVector2Array(50,50,750,50,750,480,50,480)\ncolor=Color(0.11,0.24,0.2,1)\n[node name="Tower" type="Polygon2D" parent="."]\nmetadata/wa_node_id="tower"\npolygon=PackedVector2Array(150,170,270,170,270,340,150,340)\ncolor=Color(0.4,0.69,0.9,1)\n[node name="Gate" type="Polygon2D" parent="."]\nmetadata/wa_node_id="gate"\npolygon=PackedVector2Array(460,180,610,180,610,350,460,350)\ncolor=Color(0.9,0.68,0.36,1)\n',
    'world.tscn':'[gd_scene load_steps=4 format=3]\n[sub_resource type="StandardMaterial3D" id="mat"]\nalbedo_color=Color(0.3,0.65,0.8,1)\n[sub_resource type="BoxMesh" id="box"]\nmaterial=SubResource("mat")\nsize=Vector3(2,3,2)\n[sub_resource type="PlaneMesh" id="floor"]\nsize=Vector2(12,12)\n[node name="World" type="Node3D"]\nmetadata/wa_node_id="world-root"\n[node name="Tower" type="MeshInstance3D" parent="."]\nmetadata/wa_node_id="tower3d"\nposition=Vector3(0,1.5,0)\nmesh=SubResource("box")\n[node name="Ground" type="MeshInstance3D" parent="."]\nmetadata/wa_node_id="ground3d"\nmesh=SubResource("floor")\n'
  };
  const imported=await service.committed(owner.user,p,'main',{transaction_id:'annotation-fixture',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
  const rid=imported.branch.manifest.entry_scene_id,world=Object.values(imported.branch.manifest.resources).find(r=>r.path==='world.tscn');
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});const context=await browser.newContext({viewport:{width:1560,height:1000},permissions:['clipboard-read','clipboard-write']});
  await context.addInitScript(token=>{sessionStorage.setItem('world-atelier-creator-token',token);window.annotationEvents=[];window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.source==='world-atelier-preview'){if(e.data.type==='annotation_projection')window.lastAnnotationProjection=e.data;if(['loaded','camera','annotation_candidate','annotation_error','annotation_state','annotation_adjustment','transform'].includes(e.data.type))window.annotationEvents.push(e.data);}});},owner.token);
  page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/SCRIPT ERROR|RuntimeError/.test(m.text()))report.errors.push(m.text());});
  await page.goto(`${origin}/creation-workspace.html#/games/${p}/branches/main`);
  const ready=async resource=>page.waitForFunction(id=>{const h=document.querySelector('#mainPreview');return h?.dataset.loadedDocument===id&&!h.querySelector('.render-status')?.textContent;},`${p}/main/${resource}`,{timeout:300000});await ready(rid);
  await page.locator('#toggleAnnotations:not([disabled])').waitFor({timeout:30000});check('original workbench loads actual native 2D Web editor');
  const point=async(x,y)=>{await page.waitForFunction(()=>!document.querySelector('.annotation-layer')?.classList.contains('is-entering'));const box=await page.locator('#mainPreview iframe').boundingBox();await page.mouse.click(box.x+box.width*x,box.y+box.height*y);};
  const stroke=async(x,y,ex,ey)=>{await page.waitForFunction(()=>!document.querySelector('.annotation-layer')?.classList.contains('is-entering'));const b=await page.locator('#mainPreview iframe').boundingBox();await page.mouse.move(b.x+b.width*x,b.y+b.height*y);await page.mouse.down();await page.mouse.move(b.x+b.width*ex,b.y+b.height*ey,{steps:12});await page.mouse.up();};
  const writeNote=async note=>{await page.getByLabel('批注描述',{exact:true}).fill(note);await page.getByRole('button',{name:'保存批注',exact:true}).click();await page.locator('.annotation-bubble').waitFor({state:'hidden'});};
  const stableBubble=async()=>{
    await page.waitForFunction(()=>{const events=window.annotationEvents,last=events.filter(e=>e.type==='annotation_candidate').at(-1),projection=window.lastAnnotationProjection;return projection?.document_id===last?.document_id&&projection?.marks.some(m=>Math.hypot(m.screen[0]-last.screen[0],m.screen[1]-last.screen[1])<.001);});
    assert.equal(await page.locator('.annotation-bubble').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('.annotation-toolbar').getBoundingClientRect().top-8),true,'bubble leaves the bottom toolbar accessible');
  };
  await page.locator('#toggleAnnotations').click();await page.waitForFunction(()=>document.querySelector('.annotation-layer')?.dataset.engineEnabled==='true',null,{timeout:7000});await point(.28,.46);await writeNote('把这座塔的轮廓做得更清楚');
  await page.locator('[data-annotation-tool="rect"]').click();await stroke(.20,.30,.75,.72);await page.getByLabel('批注描述',{exact:true}).waitFor();await stableBubble();await page.screenshot({path:join(data,'2d-region-bubble.png')});await writeNote('这片区域补充路径和装饰');
  assert.equal(await page.locator('.annotation-list-row').count(),2);assert.equal(service.store.list('creator_session').length,0);check('point and rectangle collect real members without creating a session or source writes');
  await page.locator('[data-annotation-tool="point"][data-target="space"]').click();await point(.12,.22);await page.getByLabel('批注描述',{exact:true}).fill('取消这条');await page.getByLabel('批注描述',{exact:true}).press('Escape');assert.equal(await page.locator('.annotation-list-row').count(),2);
  await point(.12,.22);await writeNote('临时位置');await page.getByLabel('删除第 3 条批注',{exact:true}).click();assert.equal(await page.locator('.annotation-list-row').count(),2);check('cancel bubble and delete annotation leave source and batch intact');
  await page.locator('[data-annotation-finish]').click();await page.locator('#chatDrawer').waitFor({state:'visible'});await page.getByRole('button',{name:'复制批注',exact:true}).waitFor();
  const sessions=service.store.list('creator_session');assert.equal(sessions.length,1);const first=sessions[0];assert.equal(first.draft_attachments.length,2);assert.equal(first.draft_attachments[1].annotation_kind,'objects');assert.ok(first.draft_attachments[1].members.length>=2);assert.equal(service.store.list('creator_run').length,0);assert.equal(service.store.list('creator_message').length,0);check('exit saves exactly one persistent unsent Agent draft containing both notes and immutable members');
  await page.locator('#chatDrawer').evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});await page.screenshot({path:join(data,'draft-ready.png')});await page.locator('#copyViewportAnnotations').click();const clipboard=await page.evaluate(()=>navigator.clipboard.readText());assert.match(clipboard,/worldatelier-annotations/);assert.match(clipboard,/路径和装饰/);
  await page.locator('#quickNewSession').click();await page.waitForFunction(()=>document.querySelector('#sessionDraft')?.value==='');
  await page.locator('.reference-editor').click();await page.keyboard.press('Meta+V');await page.waitForFunction(()=>document.querySelector('#sessionDraft')?.value.includes('路径和装饰'));
  const second=service.store.list('creator_session').find(s=>s.id!==first.id);assert.equal(second.draft_attachments.length,2);assert.notEqual(second.draft_attachments[0].id,first.draft_attachments[0].id);assert.equal(second.draft_attachments[1].source_revision,first.draft_attachments[1].source_revision);check('clipboard paste reattaches source-verified context to another Agent without sending');
  await page.reload();await ready(rid);assert.equal(service.store.list('creator_session').length,2);check('refresh preserves the two unsent drafts');
  if(await page.locator('#closeChat').isVisible())await page.locator('#closeChat').click();await page.locator(`[data-resource="${world.id}"]`).first().click();await ready(world.id);await page.locator('#toggleAnnotations').click();await page.locator('[data-annotation-tool="brush"]').click();await stroke(.3,.4,.65,.65);await page.getByLabel('批注描述',{exact:true}).waitFor();await stableBubble();await page.screenshot({path:join(data,'3d-brush-bubble.png')});await writeNote('这一带增加灯光和入口指引');
  const candidate=await page.evaluate(()=>annotationEvents.filter(e=>e.type==='annotation_candidate').at(-1));assert.equal(candidate.dimension,'3d');assert.ok(candidate.object_ids.length>0);assert.equal(candidate.position.length,3);check('3D brush captures visible native members and world coordinates');
  const focusNote=async position=>{await page.locator('[data-annotation-focus]').click();await page.waitForFunction(value=>annotationEvents.filter(e=>e.type==='camera').at(-1)?.target.join(',')===value,position.join(','));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
  await page.locator('[data-annotation-tool="point"][data-target="space"]').click();
  await page.getByLabel('工作平面偏移',{exact:true}).fill('5');await page.getByLabel('工作平面偏移',{exact:true}).press('Tab');
  await page.locator('[data-annotation-center]').click();await page.getByLabel('批注位置 X',{exact:true}).waitFor();
  await page.getByLabel('批注位置 X',{exact:true}).fill('3');await page.getByLabel('批注位置 X',{exact:true}).press('Tab');
  await page.getByLabel('批注位置 Y',{exact:true}).fill('7');await page.getByLabel('批注位置 Y',{exact:true}).press('Tab');
  await page.getByLabel('批注位置 Z',{exact:true}).fill('-2');await page.getByLabel('批注位置 Z',{exact:true}).press('Tab');
  await page.waitForFunction(()=>annotationEvents.filter(e=>e.type==='annotation_adjustment'&&e.final).at(-1)?.position.join(',')==='3,7,-2');
  await focusNote([3,7,-2]);await page.screenshot({path:join(data,'3d-floating-point.png')});await writeNote('在空中这个坐标放一个引导标识');check('space point is created without a surface hit and edited to explicit XYZ');
  await page.locator('[data-annotation-tool="volume"]').click();await page.getByLabel('工作平面偏移',{exact:true}).fill('0');await page.getByLabel('工作平面偏移',{exact:true}).press('Tab');
  await page.locator('[data-annotation-center]').click();await page.getByLabel('区域尺寸 X',{exact:true}).waitFor();
  const updateNumber=async(label,value)=>{await page.getByLabel(label,{exact:true}).fill(String(value));await page.getByLabel(label,{exact:true}).press('Tab');await page.waitForFunction(()=>!document.querySelector('.annotation-bubble [type=submit]').disabled);};
  await updateNumber('批注位置 X',0);await updateNumber('批注位置 Y',2);await updateNumber('批注位置 Z',0);
  await updateNumber('区域尺寸 X',5);await updateNumber('区域尺寸 Y',4);await updateNumber('区域尺寸 Z',5);
  const boxBefore=await page.evaluate(()=>annotationEvents.filter(e=>e.type==='annotation_adjustment'&&e.final).at(-1));assert.ok(boxBefore.object_ids.length>0);assert.deepEqual(boxBefore.geometry.size,[5,4,5]);
  await focusNote([0,2,0]);await page.screenshot({path:join(data,'3d-volume-edit.png')});
  const orbitBefore=await page.evaluate(()=>annotationEvents.filter(e=>e.type==='camera').at(-1));const sceneBox=await page.locator('#mainPreview iframe').boundingBox();await page.mouse.move(sceneBox.x+sceneBox.width*.38,sceneBox.y+sceneBox.height*.4);await page.keyboard.down('Alt');await page.mouse.down();await page.mouse.move(sceneBox.x+sceneBox.width*.49,sceneBox.y+sceneBox.height*.49,{steps:12});await page.mouse.up();await page.keyboard.up('Alt');await page.waitForFunction(yaw=>Math.abs(annotationEvents.filter(e=>e.type==='camera').at(-1).yaw-yaw)>.01,orbitBefore.yaw);
  assert.deepEqual(await page.getByLabel('批注位置 X',{exact:true}).inputValue(),'0');assert.deepEqual(await page.getByLabel('区域尺寸 X',{exact:true}).inputValue(),'5');await writeNote('把这个三维空间设计成入口区域');check('3D box numeric dimensions and center remain fixed after real camera orbit');
  await page.locator('[data-annotation-tool="brush"]').click();await page.getByLabel('笔刷用途',{exact:true}).selectOption('space');await page.getByLabel('批注工作平面',{exact:true}).selectOption('xz');await page.locator('[data-annotation-align]').click();
  await page.waitForFunction(()=>annotationEvents.filter(e=>e.type==='camera').at(-1)?.view==='top');
  await point(.26,.35);await page.getByLabel('批注描述',{exact:true}).waitFor();const stamp=await page.evaluate(()=>annotationEvents.filter(e=>e.type==='annotation_candidate').at(-1));assert.equal(stamp.geometry.shape,'prism');assert.equal(stamp.geometry.world_points.length,24);await page.locator('[data-annotation-cancel]').click();check('single space-brush dab creates a circular world region and cancels cleanly');
  await stroke(.26,.35,.55,.50);await page.getByLabel('批注描述',{exact:true}).waitFor();
  const prism=await page.evaluate(()=>annotationEvents.filter(e=>e.type==='annotation_candidate').at(-1));assert.equal(prism.geometry.shape,'prism');assert.equal(prism.geometry.selection,'world_aabb_intersection');assert.ok(prism.geometry.world_points.length>=3);
  await updateNumber('调整区域厚度',6);await page.screenshot({path:join(data,'3d-spatial-brush.png')});await writeNote('沿这片空间布置光带');
  await page.locator('[data-annotation-finish]').click();await page.locator('#chatDrawer').waitFor({state:'visible'});
  const spatialSession=service.store.list('creator_session').find(s=>s.draft_attachments.some(a=>a.note==='沿这片空间布置光带'));
  assert.ok(spatialSession);assert.equal(spatialSession.draft_attachments.length,4);const floating=spatialSession.draft_attachments.find(a=>a.annotation_kind==='point');assert.deepEqual(floating.position,[3,7,-2]);assert.equal(floating.members.length,0);
  const volume=spatialSession.draft_attachments.find(a=>a.geometry?.shape==='box');assert.deepEqual(volume.geometry.size,[5,4,5]);assert.equal(volume.geometry.selection,'world_aabb_intersection');
  const brush=spatialSession.draft_attachments.find(a=>a.geometry?.shape==='prism');assert.equal(brush.geometry.depth,6);assert.match(spatialSession.draft,/尺寸 XYZ：5, 4, 5 m/);assert.match(spatialSession.draft,/厚度 6 m/);assert.equal(service.store.list('creator_run').length,0);check('objects, floating point, box and spatial brush persist together as one unsent Agent draft');
  await page.waitForFunction(()=>document.querySelector('#sessionDraft')?.value.includes('沿这片空间布置光带'));await page.locator('#chatDrawer').evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});await page.screenshot({path:join(data,'3d-spatial-draft.png')});await page.locator('#closeChat').click();
  await page.getByLabel('相机导航设置',{exact:true}).click();
  await page.getByLabel('相机移动速度',{exact:true}).fill('12');await page.getByLabel('相机移动速度',{exact:true}).press('Tab');
  await page.locator('#cameraResponse').selectOption('direct');
  await page.waitForFunction(()=>annotationEvents.filter(e=>e.type==='camera').at(-1)?.response==='direct');
  await page.getByLabel('相机导航设置',{exact:true}).click();
  const frame=page.frames().find(f=>f.url().includes('/index.html?nonce=')),box=await page.locator('#mainPreview iframe').boundingBox();
  assert.ok(frame,'actual Godot Web iframe is present');
  await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down({button:'right'});
  await frame.waitForFunction(()=>document.pointerLockElement===document.getElementById('canvas'));
  await page.waitForFunction(()=>annotationEvents.filter(e=>e.type==='camera').at(-1)?.navigation==='freelook');
  const beforeWheel=await page.evaluate(()=>annotationEvents.filter(e=>e.type==='camera').at(-1));
  await page.mouse.wheel(0,-120);
  await page.waitForFunction(speed=>annotationEvents.filter(e=>e.type==='camera').at(-1)?.camera_speed>speed,beforeWheel.camera_speed);
  const afterWheel=await page.evaluate(()=>annotationEvents.filter(e=>e.type==='camera').at(-1));
  assert.deepEqual(afterWheel.position,beforeWheel.position,'speed wheel does not dolly the eye');
  assert.deepEqual(afterWheel.target,beforeWheel.target,'speed wheel does not move the target');
  await page.locator('.navigation-hud').waitFor({state:'visible'});
  assert.match(await page.locator('.navigation-hud strong').innerText(),new RegExp(Number(afterWheel.camera_speed.toFixed(afterWheel.camera_speed<10?2:1)).toString()));
  assert.ok(await page.locator('.navigation-speed-track i').evaluate(el=>parseFloat(el.style.width)>0));
  await page.locator('.navigation-fps').waitFor({state:'visible'});assert.match(await page.locator('.navigation-fps').innerText(),/\d+ FPS/);
  await page.screenshot({path:join(data,'3d-navigation-speed-hud.png')});check('RMB captures pointer; wheel updates engine speed, visible scale and FPS without moving the camera');
  await page.keyboard.down('w');await page.keyboard.down('Shift');
  await page.waitForFunction(()=>annotationEvents.filter(e=>e.type==='camera').at(-1)?.speed_multiplier===3);
  assert.match(await page.locator('.navigation-hud small').innerText(),/×3/);
  await page.waitForFunction(eye=>{const now=annotationEvents.filter(e=>e.type==='camera').at(-1);return now&&Math.hypot(...now.position.map((x,i)=>x-eye[i]))>.2;},afterWheel.position);
  await page.keyboard.up('w');await page.keyboard.up('Shift');await page.mouse.up({button:'right'});
  await frame.waitForFunction(()=>!document.pointerLockElement);
  await page.waitForFunction(()=>annotationEvents.filter(e=>e.type==='camera').at(-1)?.navigation==='');
  await page.mouse.down({button:'right'});await frame.waitForFunction(()=>!!document.pointerLockElement);await page.keyboard.press('Escape');
  await frame.waitForFunction(()=>!document.pointerLockElement);await page.waitForFunction(()=>annotationEvents.filter(e=>e.type==='camera').at(-1)?.navigation==='');await page.mouse.up({button:'right'});
  check('real WASD moves the camera; Shift is visible; mouse-up and Escape release capture and navigation');
  report.navigation={speed_before:beforeWheel.camera_speed,speed_after:afterWheel.camera_speed,fps:await page.locator('.navigation-fps').innerText(),frame_timing:await page.locator('.navigation-fps').getAttribute('title')};
  assert.equal(service.store.branchFor(owner.user,p,'main').head,imported.revision);assert.equal(service.store.list('creator_run').length,0);assert.deepEqual(report.errors,[]);
  report.status='passed';report.source_revision=imported.revision;report.first_draft=first.id;report.second_draft=second.id;report.runtime_builds=service.store.list('creator_build').map(b=>({id:b.id,purpose:b.purpose,status:b.status}));
});
