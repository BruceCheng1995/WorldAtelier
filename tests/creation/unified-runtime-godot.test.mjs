import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from '@playwright/test';
import {snapshotProjectRuntime,verifyProjectFiles} from '../../services/creation/project-snapshot.mjs';
import {adaptCanonicalGameWeb} from '../../tools/canonical-game-web.mjs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {independentPreviewBehavior,independentPreviewObject} from './independent-preview-fixture.mjs';
const root=resolve(import.meta.dirname,'../..');
test('canonical native and Web runtime omit default player while authored gameplay and inspection work',{timeout:180000},async()=>{
 const evidenceRoot=resolve(root,'.local/creation-verification/no-default-player');
 await mkdir(evidenceRoot,{recursive:true});
 const directory=await mkdtemp(resolve(evidenceRoot,'native-'));
 const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
 const runtimeSnapshot=snapshotProjectRuntime(root,directory);
 verifyProjectFiles(directory,runtimeSnapshot.files);
 await writeFile(resolve(directory,'runtime-inputs.json'),JSON.stringify(runtimeSnapshot,null,2));
 await cp(resolve(root,'tests/creation/unified-runtime-probe.gd'),resolve(directory,'unified_runtime_probe.gd'));
 await mkdir(resolve(directory,'bundled'),{recursive:true});
 let behavior=independentPreviewBehavior.replace('func interact(ctx,_actor) -> Dictionary:\n','func interact(ctx,_actor) -> Dictionary:\n\tif ctx.role == \"authority\" and ctx.properties.get(\"fail_on_second_interaction\",false) and int(ctx.state.get(\"interactions\",0))>=1: return {\"ok\":false}\n');
 behavior=behavior.replace('\t\tgame_camera.make_current()','\t\tgame_camera.keep_aspect = Camera3D.KEEP_WIDTH\n\t\tgame_camera.cull_mask = 5\n\t\tgame_camera.h_offset = .3\n\t\tgame_camera.v_offset = -.2\n\t\tgame_camera.frustum_offset = Vector2(.07,-.09)\n\t\tvar camera_environment = Environment.new()\n\t\tcamera_environment.background_mode = Environment.BG_COLOR\n\t\tcamera_environment.background_color = Color("29493f")\n\t\tcamera_environment.ambient_light_energy = .45\n\t\tcamera_environment.tonemap_mode = Environment.TONE_MAPPER_FILMIC\n\t\tcamera_environment.tonemap_exposure = .55\n\t\tgame_camera.environment = camera_environment\n\t\tgame_camera.attributes = CameraAttributesPractical.new()\n\t\tgame_camera.attributes.exposure_multiplier = .48\n\t\tgame_camera.compositor = Compositor.new()\n\t\tgame_camera.make_current()');
 behavior=behavior.replace('func initialize(ctx) -> Dictionary:\n','func initialize(ctx) -> Dictionary:\n\tif ctx.role == \"authority\" and not InputMap.has_action(\"creator_test_interact\"):\n\t\tInputMap.add_action(\"creator_test_interact\")\n\t\tvar event = InputEventKey.new()\n\t\tevent.physical_keycode = KEY_F\n\t\tInputMap.action_add_event(\"creator_test_interact\",event)\n');
 behavior=behavior.replace('func tick(ctx,_delta) -> Dictionary:\n','func tick(ctx,_delta) -> Dictionary:\n\tif ctx.role == \"authority\" and Input.is_action_just_pressed(\"creator_test_interact\"):\n\t\tvar result = interact(ctx,{})\n\t\tif not result.get(\"ok\",false): return result\n');
 behavior=behavior.replace('E / Interact changes only this test session.','F / Authored action changes only this test session.');
 const behaviorHash=createHash('sha256').update(behavior).digest('hex');
 await writeFile(resolve(directory,'bundled/fixture.gd.txt'),behavior);
 const asset={id:behaviorHash,url:`/preview-assets/${behaviorHash}.gd`};
 const faultObject=independentPreviewObject(asset);faultObject.components.behaviors[0].properties.fail_on_second_interaction=true;
 const document={branch_id:'main',scene_revision:'unified-fixed-v1',objects:[independentPreviewObject(asset)],spawn_position:[0,.2,3],editable:false};
 await writeFile(resolve(directory,'release.json'),JSON.stringify({format:1,project_id:'unified-project',project_name:'统一运行测试',branch_id:'main',revision:'unified-fixed-v1',entry_scene_id:'empty',runtime_source_hash:runtimeSnapshot.hash,canonical_identity:runtimeSnapshot.hash,assets:{[asset.url]:'res://bundled/fixture.gd.txt'},scenes:{'empty':{...document,objects:[],document_id:'unified-project/main/empty',kind:'scene'},'scene-a':{...document,document_id:'unified-project/main/scene-a',kind:'scene'},'scene-b':{...document,objects:[faultObject],name:'故障保留测试场景',document_id:'unified-project/main/scene-b',kind:'scene'},'unplaced-prefab':{...document,document_id:'unified-project/main/unplaced-prefab',kind:'prefab'}}}));
 const projectSettings=await readFile(resolve(directory,'project.godot'),'utf8');
 assert.match(projectSettings,/run\/main_scene="res:\/\/standalone.tscn"/);assert.match(projectSettings,/GameRuntime="\*res:\/\/standalone.gd"/);
 await writeFile(resolve(directory,'project.godot'),projectSettings.replace('config/name="World Atelier Game"','config/name="No default player isolated verification"').replace('GameRuntime="*res://standalone.gd"','GameRuntime="*res://standalone.gd"\nProbe="*res://unified_runtime_probe.gd"'));

 const run=args=>{const result=spawnSync(godot,args,{encoding:'utf8',timeout:45000,stdio:['ignore','pipe','pipe']});const log=result.stdout+result.stderr;assert.equal(result.status,0,log);assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|^ERROR:/m);return log;};
 const imports=run(['--headless','--editor','--path',directory,'--import']);
 const output=run(['--headless','--path',directory,'--fixed-fps','60','--quit-after','600']);
 await writeFile(resolve(directory,'verification.log'),imports+'\n'+output);
 assert.doesNotMatch(output,/SCRIPT ERROR|Parse Error|^ERROR:/m);
 const result=output.split('\n').find(row=>row.startsWith('UNIFIED_RUNTIME_COMPLETE '));
 assert.ok(result,output);assert.equal(JSON.parse(result.slice('UNIFIED_RUNTIME_COMPLETE '.length)).ok,true,output);
 console.log('Unified native runtime evidence: '+directory);
 const outputDirectory=resolve(directory,'web');await mkdir(outputDirectory,{recursive:true});
 await writeFile(resolve(directory,'export_presets.cfg'),'[preset.0]\nname="Web"\nplatform="Web"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter="release.json,runtime_capabilities.json,bundled/*"\nexclude_filter="web/*"\nscript_export_mode=0\n[preset.0.options]\nvariant/thread_support=false\nvariant/extensions_support=false\nprogressive_web_app/enabled=false\nhtml/export_icon=false\nhtml/focus_canvas_on_start=true\n');
 const exportLog=run(['--headless','--path',directory,'--export-release','Web',resolve(outputDirectory,'index.html')]);
 await writeFile(resolve(directory,'web-export.log'),exportLog);
 const adapted=adaptCanonicalGameWeb({html:await readFile(resolve(outputDirectory,'index.html'),'utf8'),identity:{content_key:'no-default-player-independent'},storage:{namespace:'no-default-player-independent'}});
 await writeFile(resolve(outputDirectory,'index.html'),adapted.html);
 const embeddedHost=`<!doctype html><style>body{margin:0;background:#17283b}iframe{border:0;width:1000px;height:700px}.render-status{color:white}</style><div id="host"></div><script type="module">
 import {GamePlay} from '/client/game-play.js';import {WorldModeSequence} from '/client/collaboration-client.js';
 const sequence=new WorldModeSequence();window.modeAcks=[];window.runtimeMessages=[];
 const preview=window.preview=new GamePlay(document.querySelector('#host'),async()=>({job:{id:'independent-no-default-player',canonical_identity:${JSON.stringify(runtimeSnapshot.hash)},source_revision:'unified-fixed-v1',runtime_source_hash:${JSON.stringify(runtimeSnapshot.hash)}},url:location.origin+'/index.html'}),message=>{
  window.runtimeMessages.push(message);if(message.type==='world_state'){window.runtimeState=message;const ack=sequence.acknowledge(message);if(ack.complete)window.modeAcks.push(message.mode);if(ack.next)preview.world({action:'mode',...ack.next});}
 });
 window.requestMode=target=>preview.world({action:'mode',...sequence.begin(target,window.runtimeState)});
 const first=sequence.begin('play',{session_kind:'local_preview'});
 await preview.runtimeReady;await preview.start({document_id:'unified-project/main/empty',scene_revision:'unified-fixed-v1'}, {world_id:'preview:independent-browser',epoch:1,scene_revision:'unified-fixed-v1',...first});
 window.embeddedStarted=true;
 </script>`;
 await writeFile(resolve(outputDirectory,'embedded.html'),embeddedHost);
 const server=createServer(async(req,res)=>{
  try {const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const client=path.startsWith('/client/');const base=client?resolve(root,'apps/creation-workspace'):outputDirectory;const file=resolve(base,client?path.slice('/client/'.length):'.'+(path==='/'?'/index.html':path));if(!file.startsWith(base+'/'))throw Error('path');const data=await readFile(file);res.writeHead(200,{'content-type':file.endsWith('.wasm')?'application/wasm':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream','cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp'});res.end(data);}catch{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;const browserLog=[];
 try {
  browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  const page=await browser.newPage({viewport:{width:1000,height:700}});page.on('console',message=>browserLog.push(message.text()));page.on('pageerror',error=>browserLog.push('PAGE_ERROR '+error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  await page.waitForFunction(()=>window.noDefaultPlayerReady===true,{},{timeout:45000});
  await page.locator('canvas').click({position:{x:500,y:350}});
  for(const key of ['w','a','s','d','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','e']){await page.keyboard.down(key);await page.waitForTimeout(70);await page.keyboard.up(key);}
  await page.screenshot({path:resolve(directory,'web-empty-after-keyboard.png')});
  await page.evaluate(()=>window.noDefaultPlayerKeyboardDone=true);
  const deadline=Date.now()+45000;
  while(!browserLog.some(row=>row.startsWith('UNIFIED_RUNTIME_COMPLETE '))&&Date.now()<deadline)await page.waitForTimeout(100);
  const completion=browserLog.find(row=>row.startsWith('UNIFIED_RUNTIME_COMPLETE '));assert.ok(completion,browserLog.join('\n'));
  assert.equal(JSON.parse(completion.slice('UNIFIED_RUNTIME_COMPLETE '.length)).ok,true,browserLog.join('\n'));
  await page.screenshot({path:resolve(directory,'web-authored-gameplay.png')});
  assert.doesNotMatch(browserLog.join('\n'),/SCRIPT ERROR|Parse Error|^ERROR:|PAGE_ERROR/m);
  console.log('Unified Web runtime evidence: '+directory);
  await page.goto('http://127.0.0.1:'+server.address().port+'/embedded.html');
  await page.waitForFunction(()=>window.embeddedStarted&&window.modeAcks?.join(',')==='playing',{},{timeout:45000});
  const frame=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());assert.ok(frame);
  await frame.waitForFunction(()=>window.noDefaultPlayerReady===true);
  await frame.locator('canvas').click({position:{x:500,y:350}});await page.keyboard.press('w');await page.keyboard.press('Space');await page.keyboard.press('e');
  const state=await page.evaluate(()=>window.runtimeState);assert.equal(state.session_kind,'local_preview');assert.equal(state.control_ready,false);assert.equal(state.runtime_ready,true);
  assert.equal(Object.hasOwn(state,'player_id'),false);assert.equal(Object.hasOwn(state,'authoritative_player_position'),false);
  await page.evaluate(()=>window.requestMode('inspect'));
  await page.waitForFunction(()=>window.modeAcks?.join(',')==='playing,inspecting');
  const frozen=await page.evaluate(()=>window.runtimeState.tick);await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>window.runtimeState.tick),frozen);
  await page.evaluate(()=>window.requestMode('play'));
  await page.waitForFunction(()=>window.modeAcks?.join(',')==='playing,inspecting,playing'&&window.runtimeState.tick>0);
  await page.screenshot({path:resolve(directory,'web-embedded-empty.png')});
  await writeFile(resolve(directory,'embedded-mode-messages.json'),JSON.stringify(await page.evaluate(()=>({acks:window.modeAcks,messages:window.runtimeMessages})),null,2));
  assert.doesNotMatch(browserLog.join('\n'),/SCRIPT ERROR|Parse Error|^ERROR:|PAGE_ERROR/m);
  console.log('Actual GamePlay iframe and WorldModeSequence evidence: '+directory);

 }finally{await writeFile(resolve(directory,'web-verification.log'),browserLog.join('\n'));await browser?.close();await new Promise(resolve=>server.close(resolve));}

});
