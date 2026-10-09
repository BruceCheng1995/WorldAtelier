import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {snapshotProjectRuntime,assembleProject} from '../../services/creation/project-snapshot.mjs';
const root=resolve(import.meta.dirname,'../..');

const proceduralScript=`extends Node3D
var ticks = 0
var clock = 0.0
var callbacks = 0
var replacements = 0
var motion: Tween
func _ready():
 motion = create_tween().set_loops()
 motion.tween_property($Bob, "position:x", 1.3, 1.0)
 motion.tween_callback(func(): callbacks += 1)
 motion.tween_property($Bob, "position:x", -1.3, 1.0)
 motion.tween_callback(func(): callbacks += 1)
func _process(delta):
 ticks += 1
 clock += delta
 if replacements == 0 and has_node("Rotor"): $Rotor.rotation.z = sin(clock * 2.1) * 0.45
func atelier_preview_capabilities():
 return {"actions":[{"id":"replace_later","label":"替换节点","scope":"scene","kind":"fixture"},{"id":"release_later","label":"释放节点","scope":"scene","kind":"fixture"}]}
func atelier_preview_action(id, _parameters):
 if id == "replace_later" or id == "release_later": replace_later(id == "replace_later")
 return {"ok":true}
func replace_later(replace: bool):
 await get_tree().create_timer(0.3, true).timeout
 motion.kill()
 replacements += 1
 if has_node("Rotor"):
  var old = $Rotor
  remove_child(old)
  old.queue_free()
 if has_node("Bob"): $Bob.queue_free()
 if replace:
  var replacement = MeshInstance3D.new()
  replacement.name = "Rotor"
  replacement.mesh = BoxMesh.new()
  replacement.rotation.z = 0.91
  replacement.position.x = 2.7
  add_child(replacement)
func atelier_preview_state():
 var rotor = get_node_or_null("Rotor")
 return {"ticks":ticks,"clock":clock,"callbacks":callbacks,"replacements":replacements,"rotor_id":rotor.get_instance_id() if rotor != null else 0,"rotation":rotor.rotation.z if rotor != null else 0.0,"rotor_x":rotor.position.x if rotor != null else 0.0,"bob_x":$Bob.position.x if has_node("Bob") else 0.0}
`;
function fixtureFiles(){return {
 'project.godot':'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.6", "GL Compatibility")\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
 'main.tscn':'[gd_scene format=3]\n[node name="Main" type="Node3D"]\n',
 'procedural.gd':proceduralScript,
 'procedural.tscn':'[gd_scene load_steps=5 format=3]\n[ext_resource type="Script" path="res://procedural.gd" id="1"]\n[sub_resource type="BoxMesh" id="rod"]\nsize=Vector3(0.4,2.4,0.4)\n[sub_resource type="SphereMesh" id="ball"]\nradius=0.35\nheight=0.7\n[sub_resource type="StandardMaterial3D" id="color"]\nalbedo_color=Color(0.1,0.8,0.35,1)\n[node name="Motion" type="Node3D"]\nscript=ExtResource("1")\n[node name="Rotor" type="MeshInstance3D" parent="."]\nposition=Vector3(0,1.2,0)\nmesh=SubResource("rod")\nmaterial_override=SubResource("color")\n[node name="Bob" type="MeshInstance3D" parent="."]\nposition=Vector3(-1.3,2.8,0)\nmesh=SubResource("ball")\nmaterial_override=SubResource("color")\n',
 'static.gd':'extends MeshInstance3D\nfunc _process(delta):\n $MovingLight.position.x += delta\n $MovingCamera.rotation.y += delta\n $MovingUi.position.x += delta\n',
 'static.tscn':'[gd_scene load_steps=3 format=3]\n[ext_resource type="Script" path="res://static.gd" id="script"]\n[sub_resource type="BoxMesh" id="1"]\n[node name="Static" type="MeshInstance3D"]\nmesh=SubResource("1")\nscript=ExtResource("script")\n[node name="MovingLight" type="PointLight2D" parent="."]\n[node name="MovingCamera" type="Camera3D" parent="."]\n[node name="MovingUi" type="Control" parent="."]\n', 
 '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',name:'Main',kind:'scene',path:'main.tscn'},motion:{id:'motion',name:'脚本与 Tween',kind:'prefab',path:'procedural.tscn'},static:{id:'static',name:'静止对象',kind:'prefab',path:'static.tscn'}}}),
};}
const compact=state=>({capture:state.capture,animations:state.animations.map(({kind,name,player,duration,loop,track_count})=>({kind,name,player,duration,loop,track_count})),current:state.current?.name,time:state.time,playing:state.playing,paused:state.paused,observations:state.observations});

async function mount(page,{token,projectId,revision,subject,scenarios=[],scenarioId}){
 await page.goto('http://127.0.0.1:48921/harness');
 await page.evaluate(async options=>{
  const{mountPrefabLab}=await import('/prefab-lab.js');window.previewState=null;window.previewErrors=[];window.results={};
  addEventListener('message',e=>{if(e.origin!==location.origin)return;if(e.data?.type==='prefab_test_state')window.previewState=e.data;if(e.data?.type==='prefab_test_result')results[e.data.request_id]=e.data;});
  const request=async(path,options={})=>{const r=await fetch('/creation-api/'+path,{...options,headers:{authorization:'Bearer '+window.authToken,'content-type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error||JSON.stringify(v));return v;};
  window.authToken=options.token;window.lab=mountPrefabLab(document.querySelector('#host'),{request,getContext:()=>({role:'owner',canWrite:true}),onError:e=>previewErrors.push(String(e))});
  lab.open({...options,branchId:'main'});
  // Send actual commands with the live engine identity and nonce. Responses come
  // only from the real canonical Godot iframe, never from a fixture ACK.
  window.sendRealCommand=command=>{const s=previewState,id=crypto.randomUUID();document.querySelector('.prefab-lab iframe').contentWindow.postMessage({source:'world-atelier-workspace',nonce:s.nonce,type:'prefab_test',seq:s.seq,source_revision:s.source_revision,scene_generation:s.scene_generation,document_id:s.document_id,command:{...command,request_id:id}},location.origin);return id;};
 },{token,projectId,revision,subject,scenarios,scenarioId});
 await page.waitForFunction(()=>previewState||previewErrors.length,null,{timeout:600000});assert.deepEqual(await page.evaluate(()=>previewErrors),[]);
}
async function command(page,value){const id=await page.evaluate(value=>sendRealCommand(value),value);await page.waitForFunction(id=>results[id],id,{timeout:15000});const result=await page.evaluate(id=>results[id],id);assert.equal(result.ok,true,JSON.stringify({error:result.error,action:value.action}));return result;}
async function waitCapture(page){await page.waitForFunction(()=>previewState.animations.some(a=>a.kind==='ProceduralCapture')||previewErrors.length,null,{timeout:20000});assert.deepEqual(await page.evaluate(()=>previewErrors),[]);return page.evaluate(()=>previewState.animations.find(a=>a.kind==='ProceduralCapture'));}
async function select(page,clip){await command(page,{action:'animation',player:clip.player,animation:clip.name,play:true});await command(page,{action:'animation_pause'});}
async function seekInput(page,time){const slider=page.getByRole('slider',{name:'动画播放位置'});await slider.evaluate((n,time)=>{n.value=String(time);n.dispatchEvent(new Event('input',{bubbles:true}));},time);await page.waitForFunction(time=>Math.abs(previewState.time-time)<.025&&!previewState.playing,time,{timeout:15000});return page.evaluate(()=>previewState.observations);}

test('script and Tween motion is captured visually without replaying business state or targeting replacement nodes',{timeout:900000},async t=>{
 const evidence=join(root,'.local/creation-verification/prefab-procedural-preview');mkdirSync(evidence,{recursive:true});const data=mkdtempSync(join(evidence,'case-')),origin='http://127.0.0.1:48921',report={ok:false,data};let service,browser;
 const server=createServer(async(req,res)=>{try{
  if(await service.request(req,res))return;if(service.builds.webRequest(req,res))return;
  const path=new URL(req.url,origin).pathname,file=/^\/[a-z][a-z0-9-]*\.(js|css)$/.test(path)?join(root,'apps/creation-workspace',path.slice(1)):path.startsWith('/packages/')?join(root,path.slice(1)):null;
  if(file&&existsSync(file)){res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(readFileSync(file));return;}
  if(path==='/harness'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/prefab-lab.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#host{position:relative;width:100vw;height:100vh}</style><div id="host"></div>');return;}res.writeHead(404);res.end();
 }catch(e){res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
 const settings=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(k=>[k,process.env[k]]);for(const[k]of settings)process.env[k]='1';try{service=new CreationService({server,root,data,origin,publicPlay:true});}finally{for(const[k,v]of settings)if(v===undefined)delete process.env[k];else process.env[k]=v;}
 await new Promise((yes,no)=>{server.once('error',no);server.listen(48921,'127.0.0.1',yes);});
 t.after(async()=>{await browser?.close();await service.close();await new Promise(yes=>server.close(yes));writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('PROCEDURAL_EVIDENCE '+data);});
 const owner=service.store.register({name:'Procedural preview tester',password:'Independent-procedural-check'});
 const files=Object.fromEntries(Object.entries(fixtureFiles()).map(([path,text])=>[path,service.native.archive.put(Buffer.from(text))]));
 const manifest=await service.native.inspectFiles(files,{assignIds:true}),created=service.store.createProject(owner.user,{name:'Actual procedural motion'},manifest),projectId=created.project.id,revision=created.branch.head;
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader','--mute-audio']});const page=await browser.newPage({viewport:{width:1512,height:1000}}),errors=report.errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/SCRIPT ERROR|Parse Error|RuntimeError|^ERROR:/.test(m.text())){errors.push(m.text());console.log('PROCEDURAL_ENGINE_ERROR '+m.text());}});
 await mount(page,{token:owner.token,projectId,revision,subject:{id:'motion',name:'脚本与 Tween',kind:'prefab'}});
 const clip=await waitCapture(page);assert.equal(clip.loop,false);assert.ok(clip.duration>1&&clip.duration<=3.2);assert.equal(await page.evaluate(()=>previewState.animations.some(a=>a.kind==='AnimationPlayer')),false);await select(page,clip);
 const before=await page.evaluate(()=>previewState.observations),slider=page.getByRole('slider',{name:'动画播放位置'});await slider.evaluate(n=>{window.changes=0;n.addEventListener('change',()=>changes++);});
 const poses=[];for(const[index,time]of [clip.duration*.2,clip.duration*.65].entries()){poses.push(await seekInput(page,time));assert.equal(await page.evaluate(()=>changes),0);await page.locator('.prefab-lab iframe').screenshot({path:join(data,`procedural-input-${index+1}.png`)});}
 for(const pose of poses){assert.equal(pose.ticks,before.ticks);assert.equal(pose.callbacks,before.callbacks);assert.equal(pose.clock,before.clock);}
 assert.ok(Math.abs(poses[0].rotation-poses[1].rotation)>.05);assert.ok(Math.abs(poses[0].bob_x-poses[1].bob_x)>.05);report.motion={clip:(( {tracks,...rest})=>rest)(clip),before,poses};
 await command(page,{action:'resume'});await page.waitForFunction(ticks=>previewState.observations.ticks>ticks+10,before.ticks);const resumed=await page.evaluate(()=>previewState.observations);assert.ok(resumed.clock>before.clock);assert.ok(resumed.callbacks>=before.callbacks&&resumed.callbacks<=before.callbacks+1);report.resumed=resumed;
 await command(page,{action:'action',action_id:'replace_later'});await select(page,clip);await page.waitForFunction(()=>previewState.observations.replacements===1);await page.waitForTimeout(700);const replaced=await page.evaluate(()=>previewState.observations);assert.notEqual(replaced.rotor_id,before.rotor_id);assert.ok(Math.abs(replaced.rotation-.91)<.00001);assert.ok(Math.abs(replaced.rotor_x-2.7)<.00001);report.replaced=replaced;
 await command(page,{action:'action',action_id:'release_later'});await page.waitForFunction(()=>previewState.observations.replacements===2);assert.equal(await page.evaluate(()=>previewState.observations.rotor_id),0);
 await mount(page,{token:owner.token,projectId,revision,subject:{id:'static',name:'静止对象',kind:'prefab'}});await page.waitForTimeout(5500);assert.deepEqual(await page.evaluate(()=>previewState.animations),[]);report.static=compact(await page.evaluate(()=>previewState));
 await page.getByRole('button',{name:'捕获脚本动画',exact:true}).click();await page.waitForFunction(()=>previewState.capture.status==='recording');const recordingButton=page.getByRole('button',{name:/^正在捕获脚本动画/});assert.equal(await recordingButton.isDisabled(),true);const firstLabel=await recordingButton.textContent();await page.waitForFunction(()=>previewState.capture.time>1);assert.notEqual(await recordingButton.textContent(),firstLabel);await page.waitForFunction(()=>previewState.capture.status==='empty',null,{timeout:10000});assert.equal(await page.getByText('本次未观察到姿态变化。可先触发动作，再重新捕获；依赖外部控制器时请选择对应测试场景。',{exact:true}).isVisible(),true);assert.deepEqual(await page.evaluate(()=>previewState.animations),[]);report.manual_capture_ui={recording_label:firstLabel,final_status:'empty',no_camera_light_ui_tracks:true};
 const baselinePath=join(root,'output/pea-native-animation/baseline-manifest.json');assert.ok(existsSync(baselinePath),'original real pea baseline is required');const baseline=JSON.parse(readFileSync(baselinePath));
 for(const entry of Object.values(baseline.source_files)){const bytes=readFileSync(join(root,'.local/model-preview/creation/native-source/objects',entry.hash.slice(0,2),entry.hash));assert.equal(hash(bytes),entry.hash);service.native.archive.put(bytes);}
 const pea=service.store.createProject(owner.user,{name:'Unmodified actual pea rules'},baseline),peaId=pea.project.id;const scenarios=await (await fetch(`${origin}/creation-api/projects/${peaId}/branches/main/prefab-tests`,{headers:{authorization:'Bearer '+owner.token}})).json();
 await mount(page,{token:owner.token,projectId:peaId,revision:pea.branch.head,subject:{id:'prefab-pea',name:'原始豌豆射手',kind:'prefab'},scenarios:scenarios.scenarios,scenarioId:'test-pvz-pea'});const peaClip=await waitCapture(page);await select(page,peaClip);
 for(const[index,time]of [.4,.65].entries()){await seekInput(page,time);await page.locator('.prefab-lab iframe').screenshot({path:join(data,`original-pea-input-${index+1}.png`)});}
 report.pea={revision:pea.branch.head,source_identity:baseline.source_identity,clip:(({tracks,...rest})=>({...rest,track_paths:tracks.map(t=>t.path)}))(peaClip),state:compact(await page.evaluate(()=>previewState))};assert.equal(service.store.branchFor(owner.user,peaId,'main').head,pea.branch.head);assert.equal(service.store.branchFor(owner.user,projectId,'main').head,revision);assert.deepEqual(errors,[]);
 const ordinary=join(data,'ordinary-game'),snapshot=snapshotProjectRuntime(root,ordinary);await assembleProject({service,user:owner.user,project_id:projectId,branch_id:'main',revision,entry_scene_id:'main',purpose:'game',directory:ordinary,runtime_source_hash:snapshot.hash});assert.equal(existsSync(join(ordinary,'atelier_runtime/procedural_animation_capture.gd')),false);report.ordinary_game_excludes_capture=true;report.ok=true;
});
