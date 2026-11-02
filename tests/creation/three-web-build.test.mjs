import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm, mkdir, writeFile, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildThreeWeb,threeToolchain} from '../../services/creation/three-web-build.mjs';
import {hash} from '../../services/creation/schema.mjs';

const root=new URL('../../',import.meta.url).pathname;
const author=`import {count} from './count.json';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
export async function createGame({THREE,renderer,canvas,ui,source,entrySceneId,storage,getPrefab,loadScene,signal,timers}) {
  if(entrySceneId==='slow'){
    canvas.dataset.slowStarted='yes';await fetch('./late-asset');
    canvas.dataset.staleAborted=String(signal.aborted);timers.setInterval(()=>canvas.dataset.staleTimer='fired',25);
  }
  if(entrySceneId==='fast'){
    await Promise.resolve();setInterval(()=>canvas.dataset.fastTimer=String(Number(canvas.dataset.fastTimer||0)+1),25);
  }
  const scene=new THREE.Scene();
  scene.background=new THREE.Color(0x222831);
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial({color:0xff3366}));
  mesh.userData.nativePath='Mesh';mesh.name='render-instance';scene.add(mesh);
  const dynamic=new THREE.Group();dynamic.name='Mesh';scene.add(dynamic);
  const camera=new THREE.PerspectiveCamera(45,1,.1,20);camera.position.z=3;
  const model=await new GLTFLoader().parseAsync(JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'LoadedExample'}]}),'');
  canvas.dataset.gltf=String(model.scene.children[0].name==='LoadedExample');
  const orbit=new OrbitControls(camera,canvas);orbit.update();orbit.enabled=false;
  const composer=new EffectComposer(renderer);const pass=new RenderPass(scene,camera);composer.addPass(pass);
  ui.innerText=entrySceneId;
  const click=()=>{canvas.dataset.clicks=String(Number(canvas.dataset.clicks||0)+1)};
  canvas.addEventListener('click',click);
  return {scene,camera,render(dt){composer.render(dt);canvas.dataset.composed='yes'},resize(w,h){composer.setSize(w,h)},async control(packet){if(packet.control==='prefab'){
    const [a,b]=await Promise.all([getPrefab('segment'),getPrefab('segment')]);
    a.objects[0].exported_properties.length=999;
    canvas.dataset.prefabSize=String(b.objects[0].exported_properties.length);
    const spawned=new THREE.Group();spawned.name='spawned';spawned.userData.nativePath='Mesh';spawned.userData.prefabPath=b.native_scene_path;scene.add(spawned);
    try{await getPrefab('entry')}catch{canvas.dataset.rejectScene='yes'}
    try{await getPrefab('test')}catch{canvas.dataset.rejectTest='yes'}
    try{await loadScene('segment')}catch{canvas.dataset.rejectPrefabEntry='yes'}
  }if(packet.control==='change'){loadScene('slow').then(loaded=>canvas.dataset.superseded=String(loaded));setTimeout(()=>loadScene('fast'),20);setTimeout(()=>loadScene('entry'),160);}},update(dt){mesh.rotation.y+=dt;canvas.dataset.angle=String(mesh.rotation.y);canvas.dataset.count=String(count);},dispose(){canvas.removeEventListener('click',click);orbit.dispose();composer.dispose();pass.dispose();}};
}`;
const job={id:'build-test',canonical_identity:'abc',source_revision:'revision',project_id:'game',branch_id:'main',entry_scene_id:'entry',game_identity:{content_key:'abc',project_id:'game',branch_id:'main',source_revision:'revision',runtime_source_hash:'runtime',entry_scene_id:'entry',web_engine:'three'},storage:{namespace:'game/main'}};
async function fixture(t,main=author,fixedJob=job){
  const dir=await mkdtemp(join(tmpdir(),'wa-three-build-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bytes=new Map();
  const source_files=Object.fromEntries(Object.entries({'project.godot':'[display]\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=720\nwindow/stretch/mode="canvas_items"','web/main.js':main,'web/count.json':'{"count":12}'}).map(([path,text])=>{
    const contents=Buffer.from(text),digest=hash(contents);bytes.set(digest,contents);return [path,{hash:digest,size:contents.length}];
  }));
  const manifest={schema:'creation-native-1',source_identity:'fixed',source_files,resources:Object.fromEntries(['entry','slow','fast'].map(id=>[id,{id,kind:'scene',name:id,path:id+'.tscn',native_nodes:[
    {path:'Mesh',name:'Mesh',type:'MeshInstance3D',addressable:true,node_id:'authored-mesh',instance_ids:[],version:'v1',properties:[],metadata:{}}]}]))};
  for(const id of ['entry','slow','fast']){
    manifest.resources[id].native_nodes.push({path:'HUD',name:'HUD',type:'Control',addressable:true,node_id:'authored-hud',instance_ids:[],version:'ui-version',properties:[],metadata:{}});
  }
  manifest.resources.segment={id:'segment',kind:'prefab',name:'Body segment',path:'body.tscn',native_nodes:[{
    path:'.',name:'Body',node_id:'body-node',addressable:true,instance_ids:[],type:'Node3D',version:'v-body',properties:[
    {name:'length',type_name:'int',exported:true,usage:4102,value:7,inherited_value:2,overridden:true,version:'v-prop'}]}],design:{exposed_properties:[
    {id:'length',name:'Body length',type:'integer',binding:{node_id:'body-node',property:'length'}}]}};
  manifest.resources.test={id:'test',kind:'scene',purpose:'prefab_test',name:'Test',path:'test_scenes/test.tscn',native_nodes:[]};
  const result=await buildThreeWeb({root,out:dir,job:fixedJob,manifest,archive:{read:entry=>bytes.get(entry.hash)}});
  return {dir,...result};
}
test('bundles exact source files and the locked Three renderer',async t=>{
  const {dir,files,shell}=await fixture(t);const chunk=files.find(file=>file.path.startsWith('prefabs-'));assert.equal(chunk.path,'prefabs-'+chunk.sha256+'.json');
  assert.deepEqual(files.map(f=>f.path).sort(),['game-identity.json','index.html','index.js',chunk.path]);
  const [segment]=JSON.parse(await readFile(join(dir,chunk.path)));
  assert.equal(segment.kind,'prefab');assert.equal(segment.objects[0].address.definition_node_id,'body-node');assert.equal(segment.objects[0].exported_properties.length,7);
  assert.equal(segment.exposed_properties[0].value,7);assert.equal(segment.exposed_properties[0].inherited_value,2);assert.equal(segment.exposed_properties[0].overridden,true);
  const html=await readFile(join(dir,'index.html'),'utf8');assert.ok(!html.includes('Body length')&&!html.includes('test_scenes/'));
  for(const file of files)assert.equal(hash(await readFile(join(dir,file.path))),file.sha256);
  assert.equal(shell.content_key,job.canonical_identity);assert.equal(shell.engine,'three');
  const toolchain=threeToolchain(root);
  assert.ok(toolchain.sceneProjection.sha256&&toolchain.bundler.sha256);
  assert.ok(toolchain.addons.every(file=>file.size>0&&file.sha256.length===64));
  assert.ok(toolchain.renderer.every(file=>file.size>10000&&file.sha256.length===64));
});
test('changing the scene projector or bundler changes the Web identity',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wa-three-identity-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const files=join(dir,'services/creation');await mkdir(files,{recursive:true});
  const before=hash(threeToolchain(dir));
  await writeFile(join(files,'three-scene-projection.mjs'),'test projection');
  const projected=hash(threeToolchain(dir));assert.notEqual(projected,before);
  await writeFile(join(files,'three-web-build.mjs'),'test compiler');
  assert.notEqual(hash(threeToolchain(dir)),projected);
});
test('addon identities include transitive modules and cannot read through an escaped package symlink',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'wa-three-addons-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const utils=join(dir,'node_modules/three/examples/jsm/utils');await mkdir(utils,{recursive:true});
  const before=hash(threeToolchain(dir));await writeFile(join(utils,'SkeletonUtils.js'),'test pinned dependency');
  assert.notEqual(hash(threeToolchain(dir)),before);
  await symlink(import.meta.filename,join(utils,'BufferGeometryUtils.js'));
  assert.throws(()=>threeToolchain(dir),/官方模块路径位于锁定包外/);
  const changed=threeToolchain(root);
  changed.addons.find(file=>file.name==='utils/SkeletonUtils.js').sha256='0'.repeat(64);
  await assert.rejects(fixture(t,author,{...job,game_identity:{...job.game_identity,toolchain:{three:changed}}}),/编译模块与固定构建不一致/);
});
test('rejects imports outside the pinned source and renderer',async t=>{
  for(const path of ['/etc/passwd','node:fs','../package.json','esbuild','https://localhost/test.js','three/addons/controls/../controls/OrbitControls.js','three/examples/jsm/../../../../package.json','three/addons/modifiers/SimplifyModifier.js','three/addons/loaders/DRACOLoader.js','three/addons']){
    await assert.rejects(fixture(t,`import value from ${JSON.stringify(path)};export function createGame(){return value}`),/Web 导入必须/);
  }
});
test('Three iframe renders, accepts clicks, freezes its own update loop, and resumes', {skip:!process.env.WA_THREE_TEST_CHROME},async t=>{
  const {chromium}=await import('@playwright/test');
  const browser=await chromium.launch({headless:true,executablePath:process.env.WA_THREE_TEST_CHROME,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
  t.after(()=>browser.close());
  const {dir}=await fixture(t);
  const context=await browser.newContext({viewport:{width:480,height:300}});
  let prefabRequests=0;
  await context.route('http://three-test.invalid/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:'<script>window.events=[];addEventListener("message",e=>window.events.push(e.data))</script><iframe width="420" height="280" src="/index.html?launch=editor&wa_embedded=1&nonce=n"></iframe>'});
    if(path==='/late-asset'){await new Promise(resolve=>setTimeout(resolve,130));return route.fulfill({body:'finished'});}
    if(path.startsWith('/prefabs-'))prefabRequests++;
    await route.fulfill({contentType:path.endsWith('.js')?'application/javascript':path.endsWith('.json')?'application/json':'text/html',body:await readFile(join(dir,path.slice(1)))});
  });
  const page=await context.newPage();await page.goto('http://three-test.invalid/');
  const waitFor=(predicate,arg)=>page.waitForFunction(predicate,arg,{timeout:12000});
  const send=packet=>page.evaluate(packet=>document.querySelector('iframe').contentWindow.postMessage({source:'world-atelier-workspace',nonce:'n',seq:1,world_id:'w',epoch:1,...packet},location.origin),packet);
  await waitFor(()=>events.some(m=>m.type==='ready'));
  await send({type:'start',source_revision:'revision',document_id:'game/main/entry',request_id:'start'});
  await waitFor(()=>events.some(m=>m.type==='loaded'&&m.mesh_count===1)&&events.some(m=>m.type==='world_state'&&m.tick>1));
  const canvas=page.frameLocator('iframe').locator('canvas');assert.equal(await canvas.getAttribute('data-count'),'12');assert.equal(await canvas.getAttribute('data-gltf'),'true');assert.equal(await canvas.getAttribute('data-composed'),'yes');
  const bounds=await canvas.evaluate(node=>{
    const rect=node.getBoundingClientRect(),hud=document.querySelector('#ui').getBoundingClientRect();
    return [rect.x,rect.y,rect.width,rect.height,node.width,node.height,hud.x,hud.y,hud.width,hud.height];
  });
  assert.deepEqual(bounds,[0,22,420,236,420,236,0,22,420,236]);
  await canvas.click();assert.equal(await canvas.getAttribute('data-clicks'),'1');
  assert.equal(prefabRequests,0);
  await send({type:'world',action:'control',control:'prefab',scene_generation:1});
  await waitFor(()=>document.querySelector('iframe').contentDocument.querySelector('canvas').dataset.rejectPrefabEntry==='yes');
  assert.equal(prefabRequests,1);assert.equal(await canvas.getAttribute('data-prefab-size'),'7');
  assert.equal(await canvas.getAttribute('data-reject-scene'),'yes');assert.equal(await canvas.getAttribute('data-reject-test'),'yes');
  await send({type:'world',action:'mode',mode:'inspecting',request_id:'pause',scene_generation:1});
  await waitFor(()=>events.some(m=>m.request_id==='pause'&&m.mode==='inspecting'));
  const selectedSource=await page.evaluate(()=>events.find(m=>m.type==='world_state'&&m.mode==='inspecting').inspection_objects);
  assert.equal(selectedSource.length,1);assert.equal(selectedSource[0].id,'authored-mesh');assert.equal(selectedSource[0].world_matrix.length,16);
  const frozen=await canvas.getAttribute('data-angle');await canvas.click();assert.equal(await canvas.getAttribute('data-clicks'),'1');assert.equal(await canvas.getAttribute('data-angle'),frozen);
  await waitFor(()=>events.some(m=>m.type==='selected'&&m.address.definition_node_id==='authored-mesh'));
  await send({type:'select',id:'authored-mesh',document_id:'game/main/entry',scene_generation:1});
  await send({type:'camera',action:'focus',document_id:'game/main/entry',scene_generation:1});
  await send({type:'context_request',action:'snapshot',request_id:'inspect-snapshot',document_id:'game/main/entry',scene_generation:1});
  await waitFor(()=>events.some(m=>m.type==='play_context'&&m.request_id==='inspect-snapshot'));
  const observed=await page.evaluate(()=>events.find(m=>m.request_id==='inspect-snapshot').payload);
  const bound=observed.objects.find(obj=>obj.name==='render-instance');assert.equal(bound.mapping,'exact_source');assert.equal(bound.source.address.definition_node_id,'authored-mesh');assert.ok(bound.screen_bounds[2]>0);
  assert.equal(observed.objects.find(obj=>obj.name==='spawned').mapping,'spawned_from_prefab');
  assert.equal(observed.objects.find(obj=>obj.name==='spawned').source.prefab_path,'res://body.tscn');
  assert.equal(observed.objects.find(obj=>obj.name==='Mesh').mapping,'runtime_only');assert.equal(observed.mode,'inspect');
  assert.ok(await page.evaluate(()=>events.some(m=>m.type==='play_context'&&m.kind==='event'&&m.payload.kind==='pointer_down')));
  // The game is paused. A resize must redraw its inspection camera and buffer
  // even with no gameplay animation frames running.
  await page.locator('iframe').evaluate(node=>{node.width='500';node.height='180';});
  await waitFor(()=>document.querySelector('iframe').contentDocument.querySelector('canvas').width===320);
  assert.deepEqual(await canvas.evaluate(node=>[node.getBoundingClientRect().left,node.width,node.height]),[90,320,180]);
  await send({type:'capture_frame',document_id:'game/main/entry',scene_generation:1,request_id:'shot'});
  await waitFor(()=>events.some(m=>m.type==='captured_frame'&&m.data_url.startsWith('data:image/png;')));
  const hasMeshPixels=await page.evaluate(async()=>{
    const image=new Image();image.src=events.find(m=>m.type==='captured_frame').data_url;await image.decode();
    const copy=document.createElement('canvas');copy.width=image.width;copy.height=image.height;
    const ctx=copy.getContext('2d');ctx.drawImage(image,0,0);const pixel=ctx.getImageData(image.width/2,image.height/2,1,1).data;
    return pixel[0]>180&&pixel[1]<100;
  });
  assert.equal(hasMeshPixels,true);
  await send({type:'world',action:'mode',mode:'playing',request_id:'resume',scene_generation:1});
  await waitFor(()=>events.some(m=>m.request_id==='resume'&&m.mode==='playing'));
  await waitFor(angle=>document.querySelector('iframe').contentDocument.querySelector('canvas').dataset.angle!==angle,frozen);
  await send({type:'world',action:'control',control:'change',scene_generation:1});
  await waitFor(()=>events.some(m=>m.type==='loaded'&&m.resource_id==='fast'&&m.scene_generation===2));
  await send({type:'world',action:'mode',mode:'inspecting',request_id:'stale-mode',scene_generation:1});
  await page.waitForTimeout(280); // Both the slow factory and the old callback have now settled.
  assert.deepEqual(await page.evaluate(()=>events.filter(m=>m.type==='loaded').map(m=>m.resource_id)),['entry','fast']);
  assert.equal(await page.evaluate(()=>events.some(m=>m.request_id==='stale-mode')),false);
  assert.equal(await canvas.getAttribute('data-slow-started'),'yes');
  assert.ok(Number(await canvas.getAttribute('data-fast-timer'))>1);
  assert.equal(await canvas.getAttribute('data-superseded'),'false');
  assert.equal(await canvas.getAttribute('data-stale-aborted'),'true');
  assert.equal(await canvas.getAttribute('data-stale-timer'),null);
});

test('inspection preserves the visible HUD, private fields, timer state, fault and pointer focus at one tick', {skip:!process.env.WA_THREE_TEST_CHROME},async t=>{
  const {chromium}=await import('@playwright/test');
  const browser=await chromium.launch({headless:true,executablePath:process.env.WA_THREE_TEST_CHROME,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
  t.after(()=>browser.close());
  const recorded=author.replace('ui.innerText=entrySceneId;', `
    ui.style.cssText="position:absolute;inset:0";
    ui.innerHTML='<button style="position:absolute;left:8px;top:8px;width:110px;height:35px;background:#00ff00;color:black;border:0">Start game</button><span data-wa-native-path="HUD" style="position:absolute;right:0;top:0">Score</span><input style="position:absolute;top:55px;left:8px;background:#ff00ff" value="private-password"><div contenteditable style="position:absolute;left:8px;top:80px">private-notes</div>';
    setInterval(()=>canvas.dataset.timer=String(Number(canvas.dataset.timer||0)+1),20);
    window.addEventListener('keyup',e=>{if(e.code==='KeyW')canvas.dataset.released='yes'});
  `).replace("if(packet.control==='prefab')","if(packet.control==='fail'){throw Error('author boom')}if(packet.control==='prefab')");
  const {dir}=await fixture(t,recorded);
  const page=await browser.newPage({viewport:{width:480,height:300}});
  await page.route('http://hud.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:'<script>window.events=[];addEventListener("message",e=>events.push(e.data))</script><iframe width="420" height="280" src="/index.html?launch=editor&wa_embedded=1&nonce=n"></iframe>'});
    return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':'text/html',body:await readFile(join(dir,path.slice(1)))});
  });
  await page.goto('http://hud.test/');
  const waitFor=(fn,arg)=>page.waitForFunction(fn,arg,{timeout:10000});
  const send=packet=>page.evaluate(p=>document.querySelector('iframe').contentWindow.postMessage({source:'world-atelier-workspace',nonce:'n',seq:1,world_id:'w',epoch:1,scene_generation:1,document_id:'game/main/entry',...p},location.origin),packet);
  const message=async(type,request_id)=>{
    await waitFor(([type,id])=>events.some(m=>m.type===type&&m.request_id===id),[type,request_id]);
    return page.evaluate(([type,id])=>events.find(m=>m.type===type&&m.request_id===id),[type,request_id]);
  };
  const capture=async(id,entry=false)=>{
    await send({type:'capture_frame',request_id:id,inspection_entry:entry});const result=await message('captured_frame',id);assert.ok(!result.error,result.error);
    // Sample CSS points against pixels in the game surface, independent of letterbox/DPR.
    const pixel=await page.evaluate(async({url,width,height})=>{
      const image=new Image();image.src=url;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
      const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
      const at=(x,y)=>Array.from(ctx.getImageData(Math.floor(x*image.width/width),Math.floor(y*image.height/height),1,1).data);
      return [at(13,14),at(13,61)];
    },{url:result.data_url,width:420,height:236});
    return {pixel,result};
  };
  await waitFor(()=>events.some(e=>e.type==='ready'));await send({type:'start',source_revision:'revision',request_id:'start'});
  await waitFor(()=>events.some(e=>e.type==='loaded'));
  const canvas=page.frameLocator('iframe').locator('canvas').first();await canvas.focus();await page.keyboard.down('w');
  await waitFor(()=>Number(document.querySelector('iframe').contentDocument.querySelector('canvas').dataset.timer)>1);
  await send({type:'world',action:'mode',mode:'inspecting',request_id:'pause'});await message('world_state','pause');
  assert.equal(await canvas.getAttribute('data-released'),'yes');
  const timer=await canvas.getAttribute('data-timer');await page.waitForTimeout(180);assert.equal(await canvas.getAttribute('data-timer'),timer);
  const before=await capture('at-pause',true);
  assert.deepEqual(before.pixel,[[0,255,0,255],[18,37,27,255]]);
  const snapshot=before.result.frame_snapshot,button=snapshot.objects.find(row=>row.name==='Start game');
  const boundLabel=snapshot.objects.find(row=>row.name==='Score');
  assert.equal(boundLabel.mapping,'exact_source');assert.equal(boundLabel.source.address.definition_node_id,'authored-hud');
  assert.equal(button.mapping,'runtime_only');assert.ok(button.screen_bounds[2]>0);assert.equal(snapshot.tick,before.result.tick);
  assert.equal(snapshot.text_input_regions.length,2);assert.ok(!JSON.stringify(snapshot).includes('private-'));
  const hidden=await capture('hidden');assert.notDeepEqual(hidden.pixel[0],before.pixel[0]);
  await send({type:'world',action:'inspection_ui',visible:true});
  assert.deepEqual((await capture('shown')).pixel,before.pixel);
  await send({type:'camera',action:'top'});
  await waitFor(()=>events.some(e=>e.type==='camera'&&e.view==='top'&&e.projection==='orthographic'));
  await send({type:'world',action:'mode',mode:'playing',request_id:'resume'});await message('world_state','resume');
  await waitFor(t=>Number(document.querySelector('iframe').contentDocument.querySelector('canvas').dataset.timer)>Number(t),timer);
  await page.keyboard.up('w');
  await send({type:'world',action:'control',control:'fail'});
  await waitFor(()=>events.some(e=>e.mode==='inspecting'&&e.requires_restart&&e.runtime_fault?.error==='author boom'));
  assert.equal(await page.evaluate(()=>events.some(e=>e.type==='runtime_error')),false);
  const fault=await capture('fault');assert.equal(fault.result.frame_snapshot.runtime_fault.error,'author boom');
});

test('fixed Three Web build uses the worker, reuses its exact ZIP and publishes explicitly',async t=>{
  const {CreationStore}=await import('../../services/creation/store.mjs');
  const {CreationBuilds}=await import('../../services/creation/export-builds.mjs');
  const {NativeSourceArchive,nativeSourceIdentity}=await import('../../services/creation/native-source.mjs');
  const {NativeGameReleases}=await import('../../services/creation/native-game-releases.mjs');
  const data=await mkdtemp(join(tmpdir(),'wa-three-worker-'));
  const store=new CreationStore(join(data,'creation.sqlite')),archive=new NativeSourceArchive(join(data,'objects'));
  const source_files=Object.fromEntries(Object.entries({
    'project.godot':'config_version=5\n[application]\nconfig/name="Three Fixture"',
    '.atelier/catalog.json':JSON.stringify({entry_scene_id:'entry',resources:{entry:{id:'entry',kind:'scene',name:'Entry',path:'main.tscn'}}}),
    'main.tscn':'[gd_scene format=3]\n[node name="Main" type="Node3D"]\n',
    'segment.tscn':'[gd_scene format=3]\n[node name="Segment" type="Node3D"]\n',
    'web/main.js':author,'web/count.json':'{"count":12}'
  }).map(([path,content])=>[path,archive.put(content)]));
  const service={root,data,store,native:{archive}},builds=service.builds=new CreationBuilds({service});
  const releases=service.gameReleases=new NativeGameReleases({service});
  t.after(async()=>{await builds.close();store.close();await rm(data,{recursive:true,force:true});});
  builds.godot=join(data,'no-godot');builds.templates=join(data,'no-templates');
  const owner=store.register({name:'Owner',password:'three-worker-password'}).user;
  const source_identity=nativeSourceIdentity(source_files);
  const manifest={schema:'creation-native-1',source_files,source_identity,index_source_identity:source_identity,entry_scene_id:'entry',resources:{entry:{id:'entry',kind:'scene',name:'Entry',path:'main.tscn',native_nodes:[]},segment:{id:'segment',kind:'prefab',name:'Segment',path:'segment.tscn',native_nodes:[]}}};
  const created=store.createProject(owner,{name:'Web Worker'},manifest),p=created.project.id,source_revision=created.branch.head;
  const request={source_revision,entry_scene_id:'entry'};
  const first=builds.preparePlay(owner,p,'main',request).job;
  await builds.running;
  const job=store.get('creator_build',first.id);
  assert.equal(job.web_engine,'three');assert.equal(job.status,'completed',job.error);
  assert.equal(job.executor?.kind,'process');assert.ok(job.web_files.some(file=>file.path==='index.js'));
  const {execFileSync}=await import('node:child_process');
  const zipped=execFileSync('unzip',['-Z1',join(builds.directory,job.id,'web.zip')],{encoding:'utf8'}).split('\n');
  const chunk=job.web_files.find(file=>file.path.startsWith('prefabs-'));assert.ok(zipped.includes(chunk.path));
  assert.equal(releases.published(owner,p,'main'),null);
  const repeat=builds.create(owner,p,'main',{...request,targets:['web'],kind:'application',confirmed:true,request_id:'export-three'});
  assert.equal(repeat.job.id,job.id);assert.equal(repeat.reused,true);
  releases.publish(owner,p,'main',{...request,build_id:job.id,request_id:'publish-three',expected_pointer_version:null});
  assert.equal(releases.published(owner,p,'main')?.game_build_id,job.id);
  assert.equal(store.branchFor(owner,p,'main').head,source_revision);
  const mixed=builds.create(owner,p,'main',{...request,targets:['web','linux'],kind:'application',confirmed:true,request_id:'export-both'});
  await builds.running;
  const partial=store.get('creator_build',mixed.job.id);
  assert.equal(partial.status,'partial',JSON.stringify(partial));
  assert.equal(partial.target_results.find(r=>r.target==='linux').status,'failed');
  assert.ok(partial.artifacts.some(artifact=>artifact.target==='web'));
  assert.equal(releases.published(owner,p,'main')?.game_build_id,job.id);
});
