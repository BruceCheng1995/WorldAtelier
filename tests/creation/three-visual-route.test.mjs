import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable,Writable} from 'node:stream';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {readFileSync,realpathSync,mkdtempSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';
import {DefaultProjectBundle} from '../../services/creation/default-projects.mjs';
import {editorVisualRoute} from '../../apps/creation-workspace/three-editor-preview.js';
import {ReleaseBuilds} from '../../apps/creation-workspace/release-builds.js';
import {PrefabGameScenes} from '../../apps/creation-workspace/prefab-lab.js';

test('visible unsupported art selects Godot while a mesh scene reports its approximate effects',()=>{
  const scene={three_projection:{nodes:[{path:'Model',mesh:{}},{path:'Sparks',particles:true},{path:'Sign',unsupported_visual:'Sprite3D',visible:false}]}};
  let route=editorVisualRoute(scene,{unsupportedShader:true});
  assert.equal(route.engine,'three');assert.match(route.detail,/粒子/);assert.match(route.detail,/着色器/);
  scene.three_projection.nodes[2].visible=true;
  route=editorVisualRoute(scene);assert.equal(route.engine,'godot');assert.match(route.detail,/Sprite3D/);
  scene.preview_object_id='model';scene.objects=[{id:'model',native_path:'Model'}];
  assert.equal(editorVisualRoute(scene).engine,'three');
});

test('a prefab scene suggestion distinguishes authored and observed instances and scopes observations to one revision',()=>{
  const usage=new PrefabGameScenes(),subject={path:'prefabs/effect.tscn'},path='res://'+subject.path;
  const manifest={entry_scene_id:'home',resources:{home:{kind:'scene',id:'home'},static:{kind:'scene',id:'static',native_nodes:[{scene_file_path:path}]},
    battle:{kind:'scene',id:'battle'},fixture:{kind:'scene',id:'fixture',purpose:'prefab_test'}}};
  usage.record('account/project/main/revision','battle',[{mapping:'spawned_from_prefab',source:{prefab_path:path}}]);
  assert.deepEqual(usage.choices('account/project/main/revision',manifest,subject).map(r=>r.id),['battle','static','home']);
  assert.deepEqual(usage.choices('account/project/main/new',manifest,subject).map(r=>r.id),['static','home','battle']);
});

test('a prefab launch refuses a stale revision and an account without source access before opening a game',async()=>{
  const fixed={projectId:'p',branchId:'main',revision:'r',actorId:'viewer',role:'viewer'};
  const controller={key:'scope',context:{project_id:'p',branch_id:'main',source_revision:'next',user_id:'viewer',role:'viewer'}};
  await assert.rejects(()=>ReleaseBuilds.prototype.playWeb.call(controller,'entry',null,fixed),/版本或访问权限/);
  Object.assign(controller.context,{source_revision:'r',role:'player'});
  await assert.rejects(()=>ReleaseBuilds.prototype.playWeb.call(controller,'entry',null,{...fixed,role:'player'}),/访问权限/);
});

// Intercept browser network at its HTTP boundary, using the real authenticated
// service, build queue, runtime grant and file responses. No port is bound.
const root=resolve(import.meta.dirname,'../..'),origin='http://127.0.0.1:48921';
async function dispatch(route,service){
  const request=route.request(),url=new URL(request.url()),file=url.pathname;
  if(url.origin===origin&&file==='/harness')return route.fulfill({contentType:'text/html',body:`<!doctype html><style>body{margin:0}#host{width:980px;height:720px;position:relative}iframe{width:100%;height:100%;border:0}</style>
    <link rel="stylesheet" href="/prefab-lab.css"><div id="host"></div><div id="releaseBuildActions"><button id="exportProjectButton"></button><button id="packageProjectButton"></button><button id="releaseBuildProgress"><span class="release-build-progress-label"></span><i class="release-build-progress-track"><span></span></i></button></div>`});
  if(url.origin===origin&&/^\/[\w-]+\.(?:css|js)$/.test(file)){
    return route.fulfill({contentType:file.endsWith('js')?'application/javascript':'text/css',body:readFileSync(join(root,'apps/creation-workspace',file.slice(1)))});
  }
  const data=request.postDataBuffer(),req=Readable.from(data?[data]:[]);
  Object.assign(req,{method:request.method(),url:url.pathname+url.search,headers:{...await request.allHeaders(),host:url.host},socket:{remoteAddress:'127.0.0.1'}});
  const chunks=[],headers={};
  const res=new Writable({write(chunk,encoding,done){chunks.push(Buffer.from(chunk));done();}});
  let status=200;
  res.setHeader=(k,v)=>{headers[k.toLowerCase()]=v;};
  res.writeHead=(s,h={})=>{status=s;for(const [k,v]of Object.entries(h))res.setHeader(k,v);};
  const finished=new Promise((yes,no)=>{res.once('finish',yes);res.once('error',no);});
  if(!await service.request(req,res)&&!service.builds.webRequest(req,res)){res.writeHead(404);res.end();}
  await finished;await route.fulfill({status,headers,body:Buffer.concat(chunks)});
}

test('member sees fixed native sprite editor and launches real Tetris from its prefab lab in a Godot comparison window',{
  skip:!process.env.WA_THREE_TEST_CHROME,timeout:600000
},async t=>{
  const data=realpathSync(mkdtempSync(join(tmpdir(),'wa-visual-route-'))),server=createServer();
  const oldAgent=process.env.WORLD_ATELIER_DISABLE_AGENT,oldWorlds=process.env.WORLD_ATELIER_DISABLE_WORLDS;
  process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';
  let service,browser;
  try{
    service=new CreationService({server,root,data,origin});
  }finally{
    for(const [key,val]of [['WORLD_ATELIER_DISABLE_AGENT',oldAgent],['WORLD_ATELIER_DISABLE_WORLDS',oldWorlds]]){
      if(val===undefined)delete process.env[key];else process.env[key]=val;
    }
  }
  t.after(async()=>{await browser?.close();await service.close();rmSync(data,{recursive:true,force:true});});
  const owner=service.store.register({name:'Source owner',password:randomUUID()});
  const viewer=service.store.register({name:'Source viewer',password:randomUUID()});
  function grantRead(p){
    const project=service.store.get('creator_project',p);
    service.store.put('creator_project',{...project,members:{...project.members,[viewer.user.id]:'viewer'}});
  }
  const empty=await service.createProject(owner.user,{name:'原生精灵'});
  const texts={'project.godot':'config_version=5\n[application]\nconfig/name="Sprite"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    'marker.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64"><rect width="128" height="64" fill="#d64798"/></svg>',
    'main.tscn':'[gd_scene load_steps=3 format=3]\n[ext_resource type="Texture2D" path="res://marker.svg" id="1"]\n[sub_resource type="SpriteFrames" id="f"]\nanimations=[{"frames":[{"duration":1.0,"texture":ExtResource("1")}],"loop":true,"name":&"default","speed":1.0}]\n[node name="Root" type="Node"]\n[node name="Static" type="Sprite2D" parent="."]\ntexture=ExtResource("1")\nposition=Vector2(100,100)\n[node name="Animated" type="AnimatedSprite2D" parent="."]\nsprite_frames=SubResource("f")\nposition=Vector2(300,100)\n',
    'web/native-visuals.json':'{"format":"wa-native-surfaces-1"}'};
  const project=empty.project.id,base=empty.branch.head;
  const edit=await service.committed(owner.user,project,'main',{transaction_id:'sprites',base_revision:base,expected_head:base,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
  grantRead(project);
  browser=await chromium.launch({executablePath:process.env.WA_THREE_TEST_CHROME,headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
  const browserContext=await browser.newContext({viewport:{width:1000,height:760}}),page=await browserContext.newPage();
  await browserContext.route('**/*',route=>dispatch(route,service));
  await page.goto(origin+'/harness');
  async function connect(){
    await page.evaluate(token=>{window.call=async(path,options={})=>{
      const res=await fetch('/creation-api/'+path,{method:options.method??'GET',body:options.body===undefined?undefined:JSON.stringify(options.body),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:options.signal});
      const value=await res.json();if(!res.ok)throw Error(value.error?.message??value.error??res.status);return value;
    };},viewer.token);
  }
  await connect();
  const rendered=await page.evaluate(async({project,revision,entry})=>{
    const {ThreeEditorPreview}=await import('/three-editor-preview.js');
    const scene=await call('projects/'+project+'/branches/main/runtime-scene?resource_id='+entry+'&revision='+revision);
    const preview=new ThreeEditorPreview(document.querySelector('#host'),'main',()=>{},call);
    window.preview=preview;await preview.scene({...scene,frame:true,editable:false});
    return {engine:preview.engine,detail:preview.host.dataset.editorRouteDetail,revision:preview.lastLoadedEvent.source_revision,objects:preview.lastLoadedEvent.objects,types:scene.three_projection.nodes.filter(n=>n.unsupported_visual).map(n=>n.unsupported_visual)};
  },{project,revision:edit.revision,entry:edit.branch.manifest.entry_scene_id});
  assert.equal(rendered.engine,'godot');assert.match(rendered.detail,/Sprite2D/);
  assert.deepEqual(rendered.types,['Sprite2D','AnimatedSprite2D']);assert.equal(rendered.revision,edit.revision);
  assert.ok(rendered.objects.filter(o=>o.dimension==='2d').length>=2);
  t.diagnostic('Godot Web loaded both native sprites at '+rendered.revision);
  await page.evaluate(()=>preview.dispose());

  const bundle=new DefaultProjectBundle(join(root,'content/default-projects')),sample=bundle.catalog.projects.find(p=>p.name==='俄罗斯方块');
  const manifest=bundle.snapshot(sample.branches.find(b=>b.id==='main'));for(const file of Object.values(manifest.source_files))service.native.archive.put(bundle.readObject(file.hash));
  const tetris=service.store.createProject(owner.user,{name:sample.name},manifest);grantRead(tetris.project.id);
  const subject=Object.values(manifest.resources).find(r=>r.path==='prefabs/tetris.tscn');
  await page.goto(origin+'/harness?engine=godot');await connect();
  await page.evaluate(async ({manifest,subjectId,projectId,actorId,revision})=>{
    const {mountPrefabLab,PrefabGameScenes}=await import('/prefab-lab.js'),{ReleaseBuilds}=await import('/release-builds.js');
    const builds=new ReleaseBuilds({request:call,download:()=>{}});
    const resources=Object.values(manifest.resources).map(({id,name,kind,purpose})=>({id,name,kind,purpose}));
    builds.setContext({user_id:actorId,role:'viewer',project_id:projectId,project_name:'Tetris',branch_id:'main',source_revision:revision,schema:manifest.schema,entry_scene_id:manifest.entry_scene_id,resources});
    const subject=manifest.resources[subjectId],gameScenes=new PrefabGameScenes().choices('fixed',manifest,subject);
    const lab=mountPrefabLab(document.querySelector('#host'),{request:call,getContext:()=>({role:'viewer',canWrite:false}),onPlayGame:(id,trigger,fixed)=>builds.playWeb(id,trigger,fixed)});
    lab.open({projectId,branchId:'main',actorId,role:'viewer',revision,subject,gameScenes,scenarios:[],autoStart:false});
  },{manifest,subjectId:subject.id,projectId:tetris.project.id,revision:tetris.branch.head,actorId:viewer.user.id});
  await page.getByRole('button',{name:'用 Web 游戏核对'}).click();
  const option=await page.getByRole('combobox',{name:'游戏关卡'}).locator('option:checked').innerText();
  assert.match(option,/场景中有此实例/);
  const [game]=await Promise.all([browserContext.waitForEvent('page'),page.getByRole('button',{name:'新页面试玩'}).click()]);
  await game.waitForURL(url=>url.hostname==='wa-runtime.localhost',{timeout:90000});
  const frame=game.frameLocator('#game');
  await frame.locator('[data-control="main"]').click({timeout:30000});
  await frame.locator('[data-state="playing"]').waitFor({state:'attached'});
  const job=service.store.list('creator_build').find(j=>j.project_id===tetris.project.id&&j.web_engine==='three');
  assert.equal(job.source_revision,tetris.branch.head);assert.equal(job.entry_scene_id,manifest.entry_scene_id);assert.equal(job.status,'completed');
  t.diagnostic('viewer launched Three Tetris from its prefab in a Godot comparison window; playing at '+job.source_revision);
});
