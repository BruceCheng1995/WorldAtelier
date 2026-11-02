// The exact distributed author's game, not a second implementation of Tetris.
// Set WA_THREE_TEST_CHROME and GODOT_BIN to run the full source-edit regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import * as T from 'three';
import {bindProjectedControls} from '../../apps/creation-workspace/three-control-layout.js';
import {DefaultProjectBundle} from '../../services/creation/default-projects.mjs';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {buildThreeWeb} from '../../services/creation/three-web-build.mjs';
import {nativeVisualProjection,readVisualBytes} from '../../services/creation/three-native-visuals.mjs';
import {importNativeProject} from '../../tools/native-scene/invoke.mjs';
import {prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';

const root=resolve(import.meta.dirname,'../..');
test('native Control binds drawn content and HTML to the same local pixel space through resize and rotation',()=>{
  const pose=new T.Matrix4().makeRotationZ(Math.PI/2).setPosition(20,30,0);
  const projection={viewport:[100,100],stretch_mode:'canvas_items',nodes:[{
    path:'Panel',world_matrix:pose.toArray(),canvas:{size:[10,20],layout:{position:[20,30],anchors:[0,0,0,0],offsets:[20,30,30,50]}}
  }]};
  const node=new T.Group(),parent=new T.Group(),element={dataset:{},style:{}};
  parent.position.set(4,9,0);parent.add(node);
  const resize=bindProjectedControls(T,projection,[{path:'Panel',object:node,element}]);
  resize(200,200);
  const corners=[new T.Vector3(0,0,0),new T.Vector3(10,20,0)];
  const css=element.style.transform.slice(7,-1).split(',').map(Number);
  for(const point of corners){
    const world=node.localToWorld(point.clone());
    assert.ok(Math.abs(world.x*2-(css[0]*point.x+css[2]*point.y+css[4]))<1e-6);
    assert.ok(Math.abs(world.y*2-(css[1]*point.x+css[3]*point.y+css[5]))<1e-6);
  }
  assert.equal(element.dataset.waNativePath,node.userData.nativePath);
});

async function webGame(t,{scratch,manifest,revision,project,context,browser},expected){
  const out=join(scratch,'web-'+revision),entry=manifest.entry_scene_id;
  const identity={content_key:manifest.source_identity,project_id:project,branch_id:'main',source_revision:revision,runtime_source_hash:'regression',entry_scene_id:entry,web_engine:'three'};
  await buildThreeWeb({root,out,manifest,archive:context.archive,job:{canonical_identity:manifest.source_identity,project_id:project,branch_id:'main',source_revision:revision,
    entry_scene_id:entry,storage:{namespace:'regression'},game_identity:identity},projection:async(m,r,read,emit)=>{
    const {projection,asset}=await nativeVisualProjection(context,m,r);
    if(asset)projection.binary={url:emit(asset,await readVisualBytes(asset)),sha256:asset.sha256,size:asset.size};
    return projection;
  }});
  const page=await browser.newPage({viewport:{width:1120,height:800}});
  try{
    await page.route('http://control-test.invalid/**',async request=>{
      const file=new URL(request.request().url()).pathname.slice(1);
      if(!file)return request.fulfill({contentType:'text/html',body:'<style>*{border:0;margin:0}</style><script>window.events=[];onmessage=e=>events.push(e.data)</script><iframe width="1120" height="800" src="/index.html?launch=editor&wa_embedded=1&nonce=n"></iframe>'});
      return request.fulfill({contentType: file.endsWith('.js')?'application/javascript':file.endsWith('.html')?'text/html':file.endsWith('.ttf')?'font/ttf':'application/octet-stream',body:readFileSync(join(out,file))});
    });
    await page.goto('http://control-test.invalid');
    await page.waitForFunction(()=>events.some(m=>m.type==='ready'));
    const document_id=project+'/main/'+entry;
    const send=packet=>page.evaluate(packet=>document.querySelector('iframe').contentWindow.postMessage({source:'world-atelier-workspace',nonce:'n',world_id:'w',epoch:1,seq:1,...packet},location.origin),packet);
    await send({type:'start',source_revision:revision,document_id,request_id:'start'});
    await page.waitForFunction(()=>events.some(m=>m.type==='loaded'));
    await send({type:'context_request',action:'snapshot',request_id:'layout',scene_generation:1,document_id});
    await page.waitForFunction(()=>events.some(m=>m.request_id==='layout'));
    const frame=page.frames().find(f=>f.url().includes('/index.html'));
    const button=frame.locator('[data-control=main]'),bounds=await button.boundingBox();
    assert.equal(bounds.x,414+expected);assert.equal(bounds.y,405);
    const mesh=await page.evaluate(()=>events.find(e=>e.request_id==='layout').payload.objects.find(o=>o.native_type==='Mesh'));
    assert.equal(mesh.world_matrix[12],expected);
    assert.ok(Math.abs(mesh.screen_bounds[0]*1120-expected)<0.01);
    const image=(await page.screenshot()).toString('base64');
    const scorePixels=await page.evaluate(async ({image,x})=>{
      const bitmap=await createImageBitmap(await (await fetch('data:image/png;base64,'+image)).blob());
      const crop=document.createElement('canvas');crop.width=128;crop.height=80;
      const ctx=crop.getContext('2d');ctx.drawImage(bitmap,x+96,170,128,80,0,0,128,80);bitmap.close();
      return Array.from(ctx.getImageData(0,0,128,80).data);
    },{image,x:expected});
    assert.ok(new Set(scorePixels).size>20,'score panel was drawn into the game viewport');
    if(expected){
      await page.mouse.click(420,420);
      assert.equal(await frame.locator('[data-state]').getAttribute('data-state'),'ready');
    }
    await page.mouse.click(420+expected,420);
    await frame.locator('[data-state="playing"]').waitFor({state:'attached'});
    t.diagnostic('Three '+revision+' board='+mesh.world_matrix[12]+' button='+bounds.x+' clickable');
    return scorePixels;
  }finally{await page.close();}
}

async function nativeGame(t,{scratch,manifest,revision,context},expected){
  const project=join(scratch,'godot-'+revision),godot=context.godot;
  context.archive.materialize(manifest.source_files,project);
  writeFileSync(join(project,'layout_probe.gd'),[
    'extends Node','func _ready():',' for i in range(8): await get_tree().process_frame',' var game=get_tree().get_first_node_in_group("tetris_game")',
    ' print("NATIVE_LAYOUT ", JSON.stringify([game.global_position.x,game.main_button.global_position.x,game.main_button.global_position.y]))',' get_tree().quit()'
  ].join('\n')+'\n');
  const config=join(project,'project.godot');
  writeFileSync(config,readFileSync(config,'utf8').replace('[autoload]','[autoload]\nLayoutProbe="*res://layout_probe.gd"'));
  await importNativeProject({projectDirectory:project,godotPath:godot,enforceIsolation:true});
  const environment=prepareExecutionEnvironment({directory:join(scratch,'env-'+revision),readPaths:[realpathSync(godot),project],writePaths:[project]});
  const command=environment.command(godot,['--headless','--audio-driver','Dummy','--path',project],{godot:true,projectPath:project,logName:'probe.log'});
  const output=execFileSync(command.command,command.args,{...command.options,encoding:'utf8',timeout:30000});
  const observed=JSON.parse(output.match(/^NATIVE_LAYOUT (\[.*\])$/m)[1]);
  assert.deepEqual(observed,[expected,414+expected,405]);t.diagnostic('Godot '+revision+' '+JSON.stringify(observed));
}

test('distributed Tetris moves board and start hit region after a source edit, then restores both on undo',{
  skip:!process.env.WA_THREE_TEST_CHROME,timeout:300000
},async t=>{
  const scratch=realpathSync(mkdtempSync(join(tmpdir(),'wa-control-regression-')));
  const store=new CreationStore(join(scratch,'creation.sqlite')),godot=process.env.GODOT_BIN||'/Applications/Godot.app/Contents/MacOS/Godot';
  const native=new NativeProjects({store,data:scratch,godotPath:godot});
  t.after(async()=>{await native.close();store.close();rmSync(scratch,{recursive:true,force:true});});
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({executablePath:process.env.WA_THREE_TEST_CHROME,headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
  t.after(()=>browser.close());
  const bundle=new DefaultProjectBundle(join(root,'content/default-projects')),sample=bundle.catalog.projects.find(p=>p.name==='俄罗斯方块');
  const manifest=bundle.snapshot(sample.branches.find(b=>b.id==='main'));
  for(const entry of Object.values(manifest.source_files))native.archive.put(bundle.readObject(entry.hash));
  const user=store.register({name:'Layout',password:randomUUID()}).user;
  const created=store.createProject(user,{name:'Tetris'},manifest),project=created.project.id;
  let baselinePixels;
  const verify=async (revision,source,expected)=>{
    const params={scratch,browser,manifest:source,project,revision,context:{root,data:scratch,archive:native.archive,godot}};
    const pixels=await webGame(t,params,expected);
    if(!baselinePixels)baselinePixels=pixels;
    const changed=pixels.reduce((sum,value,i)=>sum+Math.abs(value-baselinePixels[i]),0);
    assert.ok(changed/pixels.length<0.5,'translated score panel retains its rendered content');
    await nativeGame(t,params,expected);
  };
  await verify(created.branch.head,manifest,0);
  const resource=manifest.resources[manifest.entry_scene_id],node=resource.native_nodes.find(n=>n.node_id==='tetris-game');
  const edit=await native.apply(user,project,'main',{transaction_id:randomUUID(),base_revision:created.branch.head,ops:[{type:'native_scene_operation',
    resource_id:resource.id,expected_version:resource.version,operation:{op:'control_layout',target:{node_id:node.node_id,instance_ids:node.instance_ids},value:{offsets:[100,0,100,0]}}}]});
  await verify(edit.revision,edit.branch.manifest,100);
  const undo=await native.apply(user,project,'main',{transaction_id:randomUUID(),base_revision:edit.revision,ops:edit.inverse});
  await verify(undo.revision,undo.branch.manifest,0);
});
