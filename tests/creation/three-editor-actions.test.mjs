// Real authored scene packets and the same editor bundle served by the workspace.
// Chromium and Godot are both unattended. No product service or source edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DefaultProjectBundle} from '../../services/creation/default-projects.mjs';
import {NativeSourceArchive} from '../../services/creation/native-source.mjs';
import {nativeScenePacket} from '../../services/creation/native-view.mjs';
import {threeSceneProjection} from '../../services/creation/three-scene-projection.mjs';
import {nativeVisualProjection,readVisualBytes} from '../../services/creation/three-native-visuals.mjs';
import {ThreeEditorPreview} from '../../apps/creation-workspace/three-editor-preview.js';
import {threeEditorBundle} from '../../services/preview/three-editor-bundle.mjs';

const root=resolve(import.meta.dirname,'../..');
test('a delayed fixed prefab cannot reappear after clear, and a hidden preview uses the latest cursor when shown',async()=>{
  let resolveLoad,requestedRoute;
  const packets=[],prefab={kind:'prefab',native_scene_path:'res://p.tscn',resource_id:'p',scene_revision:'r',source_identity:'s',three_projection:{nodes:[]}};
  const preview=Object.assign(Object.create(ThreeEditorPreview.prototype),{engine:'three',ready:true,loadedSeq:1,seq:1,
    sceneContext:{source_identity:'s',source_revision:'r',document_id:'doc'},
    latestScene:{project_id:'game',branch_id:'main',source_revision:'r',source_identity:'s',editable:true},
    post:packet=>packets.push(packet),request:route=>{requestedRoute=route;return new Promise(done=>{resolveLoad=done;});}});
  const move={phase:'move',drag_id:'a',prefab_path:'res://p.tscn',prefab_id:'p',screen:[.2,.3]};
  preview.prefabDrag(move);preview.prefabDrag({phase:'clear',drag_id:'a'});resolveLoad(prefab);
  await new Promise(setImmediate);assert.equal(packets.filter(p=>p.ghost).length,0);
  preview.prefabDrag({...move,drag_id:'b'});preview.prefabDrag({phase:'hide',drag_id:'b'});resolveLoad(prefab);
  await new Promise(setImmediate);assert.equal(packets.filter(p=>p.ghost).length,0);
  preview.prefabDrag({...move,drag_id:'b',screen:[.6,.8]});
  assert.equal(requestedRoute,'projects/game/branches/main/runtime-scene?prefab_ghost=1&resource_id=p&revision=r');
  assert.deepEqual(packets.at(-1).screen,[.6,.8]);assert.deepEqual(packets.at(-1).ghost,prefab);
  preview.cancelGhost();
});

test('Three editor applies and cancels Control drafts, renders fixed 2D and 3D prefab ghosts, and releases freelook',{
  skip:!process.env.WA_THREE_TEST_CHROME,timeout:180000
},async t=>{
  const {chromium}=await import('playwright');
  const scratch=realpathSync(mkdtempSync(join(tmpdir(),'wa-editor-actions-'))),archive=new NativeSourceArchive(join(scratch,'objects'));
  const bundle=new DefaultProjectBundle(join(root,'content/default-projects'));
  const binary=new Map(),editor=await threeEditorBundle(root).promise;
  async function fixed(name){
    const project=bundle.catalog.projects.find(p=>p.name===name),m=bundle.snapshot(project.branches.find(b=>b.id==='main'));
    for(const entry of Object.values(m.source_files))archive.put(bundle.readObject(entry.hash));
    const packet=async rid=>{
      const value=nativeScenePacket(m,rid,{project_id:project.id,branch_id:'main',revision:m.source_identity});
      Object.assign(value,{source_revision:m.source_identity,editable:true,frame:true});
      if(m.source_files['web/native-visuals.json']){
        const baked=await nativeVisualProjection({root,data:scratch,archive,godot:process.env.GODOT_BIN||'/Applications/Godot.app/Contents/MacOS/Godot'},m,rid);
        value.three_projection=baked.projection;
        if(baked.asset){const path='surface-'+baked.asset.sha256+'.bin';binary.set(path,await readVisualBytes(baked.asset));value.three_projection.binary={url:path,size:baked.asset.size,sha256:baked.asset.sha256};}
      }else value.three_projection=threeSceneProjection(m,rid,entry=>archive.read(entry));
      return value;
    };
    return {manifest:m,packet};
  }
  const browser=await chromium.launch({executablePath:process.env.WA_THREE_TEST_CHROME,headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
  try{
    const page=await browser.newPage({viewport:{width:960,height:640}});
    await page.route('http://edit-test.invalid/**',async request=>{
      const name=new URL(request.request().url()).pathname.slice(1);
      if(!name)return request.fulfill({contentType:'text/html',body:'<style>*{margin:0;border:0}iframe{width:100vw;height:100vh}</style><script>window.events=[];onmessage=e=>events.push(e.data)</script><iframe src="/three-editor.html?mode=main&nonce=n"></iframe>'});
      if(name==='three-editor-runtime.js')return request.fulfill({contentType:'application/javascript',body:Buffer.from(editor)});
      if(name==='three-editor.html')return request.fulfill({contentType:'text/html',body:readFileSync(join(root,'apps/creation-workspace',name))});
      if(name==='three-editor-font.ttf')return request.fulfill({contentType:'font/ttf',body:readFileSync(join(root,'runtimes/model-preview/fonts/NotoSansSC.ttf'))});
      return request.fulfill({status:binary.has(name)?200:404,body:binary.get(name)});
    });
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.goto('http://edit-test.invalid',{waitUntil:'domcontentloaded'});
    const wait=async(type,fields={},start=0)=>{
      const handle=await page.waitForFunction(({type,fields,start})=>events.slice(start).find(m=>m.type===type&&Object.entries(fields).every(([k,v])=>m[k]===v)),{type,fields,start});
      return handle.jsonValue();
    };
    await wait('ready');
    let seq=0,document_id='',source_identity='';
    const post=payload=>page.evaluate(p=>document.querySelector('iframe').contentWindow.postMessage({source:'world-atelier-workspace',nonce:'n',...p},location.origin),{seq,document_id,source_identity,...payload});
    const load=async packet=>{
      seq++;document_id=packet.document_id;source_identity=packet.source_identity;
      await post({...packet,type:'scene'});return wait('loaded',{seq});
    };
    const tetris=await fixed('俄罗斯方块'),tScene=await tetris.packet(tetris.manifest.entry_scene_id),tLoad=await load(tScene);
    const subject=tScene.objects.find(o=>o.source_node_id==='tetris-game'),id=subject.id;
    const before=tLoad.objects.find(o=>o.id===id).control_layout.values;
    assert.equal(before.position[0],0);
    await post({type:'editor_preview',objects:[{id,control_layout:{offsets:[100,0,120,0],rotation_degrees:15}}],observe_ids:[id]});
    const transient=await wait('native_transform_preview',{id});
    assert.equal(transient.control_layout.values.position[0],100);
    assert.equal(transient.control_layout.values.size[0],before.size[0]+20);
    assert.equal(transient.local_transform.rotation[2],15);
    await post({type:'editor_preview',objects:[],observe_ids:[]});
    const item=page.frameLocator('iframe').locator('canvas').first();
    await item.click({position:{x:450,y:310}});
    const reset=await wait('selected',{id});
    assert.deepEqual(reset.control_layout.values.position,before.position);
    await post({type:'editor',tool:'move',snap:false});
    const dragAt=await page.evaluate(()=>events.length);
    await page.mouse.move(450,315);await page.mouse.down();await page.mouse.move(510,315,{steps:5});
    const movedControl=await wait('transform',{id,phase:'preview'},dragAt);
    assert.ok(movedControl.position[0]>0);assert.equal(movedControl.world_matrix[12],movedControl.position[0]);
    await page.keyboard.press('Escape');await page.mouse.up();
    const canceled=await wait('transform',{id,phase:'cancel'},dragAt);
    assert.deepEqual(canceled.control_layout.values.position,before.position);
    assert.equal(await page.evaluate(({start,id})=>events.slice(start).some(e=>e.id===id&&e.phase==='commit'),{start:dragAt,id}),false);
    const ghost=async (project,prefabId,dimension)=>{
      const prefab=await project.packet(prefabId),drag_id='drag-'+dimension;
      const base={type:'prefab_drag',drag_id,prefab_id:prefabId,prefab_path:prefab.native_scene_path};
      const beforeImage=dimension==='3d'?await page.screenshot():null;
      await post({...base,phase:'move',screen:[.55,.55],ghost:prefab});
      const seen=await wait('prefab_drag',{drag_id,status:'ready',shape:dimension});
      assert.ok(seen.position.every(Number.isFinite));
      if(beforeImage){
        const withGhost=await page.screenshot();
        assert.ok(!withGhost.equals(beforeImage),'real prefab must draw into the viewport');
      }
      await post({...base,phase:'hide'});
      await post({...base,phase:'clear'});
      const length=await page.evaluate(()=>events.length);
      await post({...base,phase:'move',screen:[.5,.5],ghost:prefab});
      await page.evaluate(()=>new Promise(requestAnimationFrame));
      assert.equal(await page.evaluate(({start,id})=>events.slice(start).some(e=>e.drag_id===id&&e.status==='ready'),{start:length,id:drag_id}),false);
      return seen.position;
    };
    const tPrefab=Object.values(tetris.manifest.resources).find(r=>r.kind==='prefab'&&r.path==='prefabs/tetris.tscn');
    t.diagnostic('Control x='+transient.position[0]+' width='+transient.control_layout.values.size[0]+' restored x='+reset.position[0]+' 2D ghost '+(await ghost(tetris,tPrefab.id,'2d')).join(','));
    const snake=await fixed('贪吃蛇'),sScene=await snake.packet(snake.manifest.entry_scene_id);
    await load(sScene);
    const sPrefab=Object.values(snake.manifest.resources).find(r=>r.kind==='prefab'&&r.native_nodes.some(n=>n.type==='MeshInstance3D'));
    t.diagnostic('3D ghost '+sPrefab.name+' '+(await ghost(snake,sPrefab.id,'3d')).join(','));
    const tile=sScene.objects.find(o=>o.native_path.endsWith('/Tile_00_00'));
    const startX=tile.native_edit_world_matrix[12],canvas=page.frameLocator('iframe').locator('canvas').first();
    const rect=await canvas.boundingBox();
    async function moveX({shift=false,ctrl=false,snap=false}={}){
      await post({type:'editor_preview',objects:[]});
      await post({type:'select',id:tile.id});await post({type:'editor',tool:'move',snap});
      await post({type:'camera',action:'front'});
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      const start=await page.evaluate(()=>events.length),y=rect.y+rect.height*.5;
      if(shift)await page.keyboard.down('Shift');if(ctrl)await page.keyboard.down('Control');
      const x=rect.x+rect.width*.5+40;
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+57,y,{steps:8});await page.mouse.up();
      if(shift)await page.keyboard.up('Shift');if(ctrl)await page.keyboard.up('Control');
      const commit=await wait('transform',{phase:'commit',id:tile.id},start);
      return commit.world_matrix[12]-startX;
    }
    const plain=await moveX(),fine=await moveX({shift:true}),grid=await moveX({ctrl:true}),reverse=await moveX({snap:true,ctrl:true});
    assert.ok(Math.abs(plain)>.03);assert.ok(Math.abs(fine-plain*.1)<.001);
    assert.ok(Math.abs(grid-Math.round(plain/.25)*.25)<.001);
    assert.ok(Math.abs(reverse-plain)<.001);
    t.diagnostic('tile gizmo Δx='+[plain,fine,grid,reverse].map(n=>n.toFixed(4)).join(', '));
    await post({type:'navigation_settings',camera_speed:6,sensitivity:.0025,response:'smooth'});
    const cam=()=>page.evaluate(()=>events.filter(e=>e.type==='camera').at(-1));
    const atRest=await cam();
    await page.mouse.move(400,300);await page.mouse.down({button:'right'});
    const frame=page.frames().find(f=>f.url().includes('three-editor.html'));
    await frame.waitForFunction(()=>document.pointerLockElement===document.querySelector('canvas'));
    await page.keyboard.down('w');await page.waitForTimeout(310);await page.keyboard.up('w');
    await page.mouse.up({button:'right'});
    await frame.waitForFunction(()=>!document.pointerLockElement);
    const moved=await cam();assert.equal(moved.response,'smooth');
    const travel=Math.hypot(...moved.position.map((n,i)=>n-atRest.position[i]));assert.ok(travel>.15);
    t.diagnostic('free camera travel '+travel.toFixed(3)+' m; pointer lock released');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();rmSync(scratch,{recursive:true,force:true});}
});
