// Direct both game targets to the same temporary branch revision after a real
// inspector transform (or Control layout) transaction. A read-only observer
// measures the rendered Three scene and the live native GameRuntime scene.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,realpath,readFile,open,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {DefaultProjectBundle} from '../../services/creation/default-projects.mjs';
import {nativeScenePacket} from '../../services/creation/native-view.mjs';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';
import {assembleProject} from '../../services/creation/project-snapshot.mjs';
import {nativeWorldTransformOperation,nativeControlOperation} from '../../apps/creation-workspace/native-authoring.js';
import {threeSceneProjection} from '../../services/creation/three-scene-projection.mjs';
import {buildThreeWeb} from '../../services/creation/three-web-build.mjs';
import {nativeVisualProjection,readVisualBytes} from '../../services/creation/three-native-visuals.mjs';
import {importNativeProject} from '../../tools/native-scene/invoke.mjs';
import {prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';

const cases=[
  ['小小梦魇','PushCrate/Wood'],
  ['贪吃蛇','SnakeGame/Board/Plinth'],
  ['坦克大战','Terrain/NorthRoad'],
  ['塔防游戏','Obstacles/Obstacle00'],
  ['兽人必须死','Architecture/GateVortex1/Membrane'],
  ['植物大战僵尸','Column','Column/StartGame'],
  ['小巷漫步','.',null,{name:'spawn_point',observe:'Walker'}],
  ['TPS','Hero']
];
const root=resolve(import.meta.dirname,'../..'),godot=process.env.GODOT_BIN||'/Applications/Godot.app/Contents/MacOS/Godot',exec=promisify(execFile);
const output=resolve(process.env.WA_EDIT_ACTION_OUTPUT??join(root,'.local/creation-verification/three-default-edit-actions'));
const bundle=new DefaultProjectBundle(join(root,'content/default-projects'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const write=async(file,obj)=>writeFile(file,JSON.stringify(obj,null,2)+'\n');

// Stream only inventory-verified bytes of this isolated build into the
// headless page. Large GLBs cannot fit in a single Playwright/CDP message.
async function serveLargeFiles(page,out,files){
  const inventory=Object.fromEntries(files.filter(file=>file.size>8*1024*1024).map(file=>[file.path,file.size]));
  if(!Object.keys(inventory).length)return;
  await page.exposeBinding('editActionChunk',async(source,{name,offset})=>{
    if(source.frame.url().split('/')[2]!=='edit.invalid'||!Object.hasOwn(inventory,name)||!Number.isInteger(offset)||offset<0||offset>=inventory[name])throw Error('invalid fixed file range');
    const fd=await open(join(out,name),'r'),buffer=Buffer.alloc(Math.min(1024*1024,inventory[name]-offset));
    try{const {bytesRead}=await fd.read(buffer,0,buffer.length,offset);assert.equal(bytesRead,buffer.length);return buffer.toString('base64');}
    finally{await fd.close();}
  });
  await page.addInitScript(inventory=>{
    const ordinary=window.fetch.bind(window);
    window.fetch=(input,init)=>{
      const req=new Request(input,init),url=new URL(req.url),name=url.pathname.slice(1);
      if(req.method!=='GET'||url.origin!==location.origin||!Object.hasOwn(inventory,name))return ordinary(input,init);
      let offset=0;
      return Promise.resolve(new Response(new ReadableStream({async pull(controller){
        req.signal.throwIfAborted();
        const text=atob(await window.editActionChunk({name,offset})),chunk=Uint8Array.from(text,l=>l.charCodeAt(0));
        offset+=chunk.length;controller.enqueue(chunk);if(offset===inventory[name])controller.close();
      }}),{headers:{'Content-Type':'application/octet-stream','Content-Length':String(inventory[name])}}));
    };
  },inventory);
}

function pin(builds,manifest,revision,projectId,engine){
  const job={id:'build-'+randomUUID(),kind:'application',purpose:'play',project_id:projectId,branch_id:'main',project_name:'edit-action',
    targets:['web'],source_revision:revision,entry_scene_id:manifest.entry_scene_id,godot_comparison:engine==='godot'};
  builds.pin(job);assert.equal(job.web_engine??'godot',engine);return job;
}
async function webValue({builds,native,dir,manifest,revision,phase,projectId,subject,child,binding}){
  const out=join(dir,phase+'-web'),entry=manifest.entry_scene_id,job=pin(builds,manifest,revision,projectId,'three');
  const artifacts=await buildThreeWeb({root,out,job,manifest,archive:native.archive,
    projection:async(m,id,read,emit)=>{
      if(!m.source_files['web/native-visuals.json'])return threeSceneProjection(m,id,read);
      const baked=await nativeVisualProjection({root,data:dir,archive:native.archive,godot},m,id);
      if(baked?.asset)baked.projection.binary={url:emit(baked.asset,await readVisualBytes(baked.asset)),size:baked.asset.size,sha256:baked.asset.sha256};
      return baked?.projection??null;
    }});
  const page=await browser.newPage({viewport:{width:1152,height:648}});
  try{
    await serveLargeFiles(page,out,artifacts.files);
    await page.addInitScript(()=>{
      const scenes=new Set();window.editActionScenes=scenes;
      const devtools=new EventTarget();window.__THREE_DEVTOOLS__=devtools;
      devtools.addEventListener('observe',event=>{
        const renderer=event.detail;if(!renderer?.isWebGLRenderer)return;
        const render=renderer.render;
        renderer.render=function(scene,camera){
          const result=render.call(this,scene,camera);
          if(scene?.isScene)scenes.add(scene);return result;
        };
      });
    });
    await page.route('http://edit.invalid/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/')return route.fulfill({contentType:'text/html',body:'<style>*{margin:0}iframe{width:100%;height:100%;border:0}</style><script>window.events=[];onmessage=e=>events.push(e.data)</script><iframe src="/index.html?launch=editor&wa_embedded=1&nonce=n"></iframe>'});
      const type=path.endsWith('.js')?'text/javascript':path.endsWith('.html')?'text/html':path.endsWith('.json')?'application/json':'application/octet-stream';
      try{return route.fulfill({contentType:type,body:await readFile(join(out,path.slice(1)))});}catch{return route.fulfill({status:404,body:''});}
    });
    await page.goto('http://edit.invalid/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>events.some(e=>e.type==='ready'),null,{timeout:30000});
    await page.evaluate(({revision,documentId})=>document.querySelector('iframe').contentWindow.postMessage({source:'world-atelier-workspace',type:'start',nonce:'n',seq:1,world_id:'edit',epoch:1,request_id:'start',source_revision:revision,document_id:documentId},location.origin),{revision,documentId:projectId+'/main/'+entry});
    await page.waitForFunction(()=>events.some(e=>e.type==='loaded'||e.type==='runtime_error'),null,{timeout:120000});
    const result=await page.evaluate(({subject,child,binding})=>{
      const frame=document.querySelector('iframe'),w=frame.contentWindow,doc=frame.contentDocument,loaded=events.find(e=>e.type==='loaded');
      if(!loaded)throw Error(events.find(e=>e.type==='runtime_error')?.message);
      const src=JSON.parse(doc.querySelector('#wa-game').textContent).scenes[loaded.resource_id];
      const dest=child||binding?.observe||subject,source=src.objects.find(row=>row.native_path===dest);
      if(binding)w.dispatchEvent(new w.KeyboardEvent('keydown',{code:'KeyR',key:'r',bubbles:true}));
      const hits=[];
      for(const scene of w.editActionScenes)scene.traverseVisible(node=>{
        if(node.userData.nativePath!==dest)return;
        node.updateWorldMatrix(true,false);let meshes=0;node.traverseVisible(n=>{if(n.isMesh)meshes++;});hits.push({name:node.name,type:node.type,meshes,x:node.matrixWorld.elements[12]});
      });
      if(child){
        const hud=doc.querySelector('[data-wa-native-path="'+CSS.escape(dest)+'"]');
        if(!hud)throw Error('No visible DOM Control '+dest);
        const surface=doc.querySelector('canvas').getBoundingClientRect(),rect=hud.getBoundingClientRect();
        return {value:(rect.left-surface.left)*1152/surface.width,width:rect.width*1152/surface.width,matches:hits,revision:loaded.source_revision,source_identity:src.source_identity};
      }
      if(!hits.some(hit=>hit.meshes>0)||hits.some(hit=>Math.abs(hit.x-hits[0].x)>.02))
        throw Error('No consistent visible mesh binding in renderer.render for '+dest+': '+JSON.stringify(hits));
      return {value:hits[0].x,matches:hits,revision:loaded.source_revision,source_identity:src.source_identity,source_value:source?.world_matrix?.[12]};
    },{subject,child,binding});
    assert.equal(result.source_identity,manifest.source_identity);assert.equal(result.revision,revision);
    assert.equal(await page.evaluate(()=>events.find(e=>e.type==='loaded').canonical_identity),job.canonical_identity);
    return {...result,build_id:job.id,canonical_identity:job.canonical_identity,runtime_source_hash:job.runtime_source_hash,
      bundle:artifacts.files.find(file=>file.path==='index.js')?.sha256};
  }finally{await page.close();}
}

async function godotValue({builds,store,native,user,dir,manifest,revision,phase,projectId,subject,child,binding}){
  const entry=manifest.entry_scene_id,service={root,data:dir,store,native},job=pin(builds,manifest,revision,projectId,'godot');
  const project=join(builds.directory,job.id,'project');
  await assembleProject({service,user,project_id:projectId,branch_id:'main',revision,entry_scene_id:entry,directory:project,
    project_name:job.project_name,storage:job.storage,game_identity:job.game_identity,purpose:'game',runtime_source_hash:job.runtime_source_hash});
  const target=child||binding?.observe||subject;
  await writeFile(join(project,'read-edit.gd'),`extends Node
func _ready():
  ${child?`get_tree().root.content_scale_mode=Window.CONTENT_SCALE_MODE_CANVAS_ITEMS
  get_tree().root.content_scale_size=Vector2i(1152,648)
  get_tree().root.content_scale_aspect=Window.CONTENT_SCALE_ASPECT_KEEP
  get_tree().root.size=Vector2i(1152,648)`:'pass'}
  for i in range(150):
    await get_tree().process_frame
    var rt=get_node_or_null("/root/GameRuntime")
    var scene=get_tree().current_scene
    if not is_instance_valid(rt) or not rt.running or rt.current_scene_id!=${JSON.stringify(entry)} or not is_instance_valid(scene):continue
    var target=scene.get_node_or_null(${JSON.stringify(target)})
    if target==null:continue
    ${binding?`Input.action_press("return_home")
    scene._physics_process(0.0)
    Input.action_release("return_home")`:'pass'}
    print("WA_EDIT_OBS "+JSON.stringify({"viewport":[target.get_viewport().get_visible_rect().size.x,target.get_viewport().get_visible_rect().size.y],"value":target.global_position.x,"width":target.size.x if target is Control else null,"canonical_identity":rt.release.canonical_identity,"runtime_source_hash":rt.release.runtime_source_hash,"revision":rt.release.revision,"source_identity":rt.release.source_identity,"entry":rt.current_scene_id,"node":str(scene.get_path_to(target))}))
    get_tree().quit();return
  print("WA_EDIT_MISSING "+str(get_tree().current_scene))
  get_tree().quit(1)
`);
  const cfg=join(project,'project.godot');await writeFile(cfg,(await readFile(cfg,'utf8')).replace('[autoload]','[autoload]\nReadParity="*res://read-edit.gd"'));
  await importNativeProject({projectDirectory:project,godotPath:godot,enforceIsolation:true});
  const env=prepareExecutionEnvironment({directory:join(dir,phase+'-exec'),readPaths:[await realpath(godot),project],writePaths:[project]});
  const cmd=env.command(godot,['--headless','--audio-driver','Dummy','--path',project,'--fixed-fps','60','--resolution','1152x648'],{godot:true,projectPath:project});
  const result=await exec(cmd.command,cmd.args,{...cmd.options,maxBuffer:5*1024*1024,timeout:55000});
  const line=result.stdout.split('\n').find(l=>l.startsWith('WA_EDIT_OBS '));
  assert.ok(line,result.stderr.slice(-1200)+result.stdout.slice(-600));const observation=JSON.parse(line.slice('WA_EDIT_OBS '.length));
  if(child)assert.deepEqual(observation.viewport,[1152,648]);
  assert.equal(observation.revision,revision);assert.equal(observation.source_identity,manifest.source_identity);assert.equal(observation.canonical_identity,job.canonical_identity);return {...observation,build_id:job.id};
}

async function run([name,subject,child,binding]){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'wa-edit-action-'))),store=new CreationStore(join(dir,'creation.sqlite'));
  const native=new NativeProjects({store,data:dir,godotPath:godot}),builds=new CreationBuilds({service:{root,data:dir,store,native}}),report={name,subject,child:child??null,binding:binding??null};
  try{
    const p=bundle.catalog.projects.find(p=>p.name===name),seed=bundle.snapshot(p.branches.find(b=>b.id==='main'));
    for(const file of Object.values(seed.source_files))native.archive.put(bundle.readObject(file.hash));
    const user=store.register({name:'Edit SelfTest',password:randomUUID()}).user,created=store.createProject(user,{name:name+' parity'},seed),projectId=created.project.id;
    const entry=seed.entry_scene_id,base=created.branch.head,context={manifest:seed,resourceId:entry};
    const obj=nativeScenePacket(seed,entry,{project_id:projectId,branch_id:'main',revision:base}).objects.find(o=>o.native_path===subject);
    assert.ok(obj,subject);
    report.baseRevision=base;report.baseIdentity=seed.source_identity;report.address=obj.address;
    if(binding)report.action='reset to authored spawn point (web KeyR, Godot return_home input processed before further physics)';
    const delta=child?32:1.25;let op;
    if(binding){
      const prop=seed.resources[entry].native_nodes.find(n=>n.path===subject).properties.find(p=>p.name===binding.name);
      const value=structuredClone(prop.value);value.value[0]+=delta;op={type:'set_native_property',resource_id:entry,target:obj.native_target,
        property:binding.name,value,expected_property_version:prop.version};
    }else if(child){const offsets=obj.control_layout.values.offsets.map((v,i)=>i%2===0?v+delta:v);op=nativeControlOperation(obj,{value:{offsets}},context);}
    else{const matrix=[...obj.world_matrix];matrix[12]+=delta;op=nativeWorldTransformOperation(obj,matrix,context);}
    const edit=await native.apply(user,projectId,'main',{transaction_id:randomUUID(),base_revision:base,ops:[op]});
    report.editedRevision=edit.revision;report.editedIdentity=edit.branch.manifest.source_identity;report.delta=delta;
    const fixed={builds,store,native,user,dir,subject,child,binding,projectId};
    for(const [phase,revision,manifest] of [['base',base,seed],['edit',edit.revision,edit.branch.manifest]]){
      const args={...fixed,phase,revision,manifest};
      let godot,web;
      if(binding){[godot]=await Promise.allSettled([godotValue(args)]);[web]=await Promise.allSettled([webValue(args)]);}
      else [godot,web]=await Promise.allSettled([godotValue(args),webValue(args)]);
      report[phase]={};for(const [engine,r] of [['godot',godot],['web',web]]){
        if(r.status==='fulfilled')report[phase][engine]=r.value;else report[phase][engine]={error:r.reason?.message?.slice(-2600)};
      }
      console.log(name,phase,JSON.stringify(report[phase]));
    }
    const undo=await native.apply(user,projectId,'main',{transaction_id:randomUUID(),base_revision:edit.revision,ops:edit.inverse});
    report.undoRevision=undo.revision;report.undoIdentity=undo.branch.manifest.source_identity;
    assert.equal(report.undoIdentity,seed.source_identity,'native undo must restore original fixed bytes');
    for(const engine of ['web','godot']){
      const actual=report.edit[engine].value-report.base[engine].value;
      assert.ok(Number.isFinite(actual)&&Math.abs(actual-delta)<.02,engine+' live change '+actual+' expected '+delta);
    }
    report.engineDifference=report.edit.web.value-report.edit.godot.value;assert.ok(Math.abs(report.engineDifference)<.1,'actual engines differ');
    report.passed=true;
  }catch(error){report.error=String(error.stack).slice(0,2600);}
  finally{await write(join(output,name+'.json'),report);await builds.close();await native.close();store.close();await rm(dir,{recursive:true,force:true});}
  console.log(name,report.passed?'PASS':'FAIL '+report.error?.split('\n')[0]);return report.passed;
}
try{
  await mkdir(output,{recursive:true});const selected=process.argv.slice(2),items=cases.filter(c=>!selected.length||selected.includes(c[0]));
  assert.ok(items.length,'unknown default game');for(const item of items)if(!await run(item))process.exitCode=1;
}finally{await browser.close();}
