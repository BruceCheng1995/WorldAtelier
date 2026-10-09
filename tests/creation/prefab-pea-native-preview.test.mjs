import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {snapshotProjectRuntime,assembleProject} from '../../services/creation/project-snapshot.mjs';
const root=resolve(import.meta.dirname,'../..'),exec=promisify(execFile);
const inputPath=join(root,'output/pea-native-animation/transaction.json'),baselinePath=join(root,'output/pea-native-animation/baseline-manifest.json');

// The probe observes the actual canonical session and invokes its real presentation
// script against its real plant state. Only isolated runtime speed/clock values change.
const nativeProbe=`extends Node
func require_ok(value: bool, message: String) -> bool:
 if not value:
  push_error("PEA_PROBE_FAILED " + message)
  get_tree().quit(1)
 return value
func _ready():
 process_mode = Node.PROCESS_MODE_ALWAYS
 var runtime = get_tree().root.get_node("GameRuntime")
 for i in range(1200):
  await get_tree().process_frame
  if runtime.running or runtime.faulted: break
 if not require_ok(runtime.running and not runtime.faulted, "runtime not running " + runtime.failure): return
 if not require_ok(runtime.current_scene_id == "scene-harbor", "wrong real scene"): return
 var prefab = load("res://prefabs/prefab-pea.tscn").instantiate()
 add_child(prefab)
 var model = prefab.get_node("N_template_pea_54dd75/__Model")
 var clone = model.duplicate()
 add_child(clone)
 var player = clone.get_node("PeaAnimations")
 if not require_ok(player.has_animation("idle") and player.callback_mode_process == 2, "clone lost manual idle"): return
 player.play("idle")
 var length = player.get_animation("idle").length
 player.seek(length * 0.25, true, true)
 if not require_ok(abs(clone.rotation.z - 0.035) < 0.0001, "positive native pose"): return
 player.seek(length * 0.75, true, true)
 if not require_ok(abs(clone.rotation.z + 0.035) < 0.0001, "negative native pose"): return
 clone.queue_free()
 prefab.queue_free()
 print("PEA_NATIVE_CLONE_OK")
 var entry
 for item in runtime.simulation.legacy.presentation.entries.values():
  if item.context.local.has("entities") and item.context.state.has("plants"):
   entry = item
   break
 if not require_ok(entry != null, "presentation context missing"): return
 var c = entry.context
 var legacy = runtime.simulation.legacy
 var sequence = 1
 legacy.interact(c.object_id, {"sequence":sequence,"action":"board","code":181})
 for i in range(31 * 60):
  legacy.step(1.0 / 60.0)
  var state = legacy.authority.entries[c.object_id + ":" + c.component_id].context.state
  for drop in state.drops.duplicate():
   sequence += 1
   legacy.interact(c.object_id, {"sequence":sequence,"action":"collect","drop_id":drop.id})
 sequence += 1
 legacy.interact(c.object_id, {"sequence":sequence,"action":"board","code":1})
 sequence += 1
 legacy.interact(c.object_id, {"sequence":sequence,"action":"board","code":47})
 legacy.step(1.0 / 60.0)
 legacy.advance(1.0 / 60.0)
 entry.instance.plant_defs(c)
 var definition = entry.instance.definition_nodes.get("template-pea__behavior__definition")
 if not require_ok(definition != null, "actual pea definition missing"): return
 var checks = []
 for speed in [0.0, 1.0, 2.0, 5.0]:
  definition.animation_speed = speed
  for clock in [0.0, 0.37, 0.89]:
   c.local.clock = clock
   entry.instance.render_view(c, 0.0)
   var count = 0
   var max_error = 0.0
   for p in c.state.plants:
    var n = c.local.entities.get("p%d" % int(p.id))
    if p.kind != "pea":
     if not require_ok(abs(n.rotation.z - sin(clock * 2.5 * float(entry.instance.plant_defs(c)[p.kind].get("animation_speed", 1.0)) + int(p.id)) * 0.035) < 0.00001, "other plant fallback changed"): return
     continue
    count += 1
    var actual = n.get_node("__Model/PeaAnimations")
    var phase = fposmod(clock * speed + float(p.id) / 2.5, length)
    var error = abs(n.get_node("__Model").rotation.z - sin(clock * 2.5 * speed + int(p.id)) * 0.035)
    max_error = max(max_error, error)
    if not require_ok(actual.assigned_animation == "idle", "real render did not play idle"): return
    if not require_ok(abs(actual.current_animation_position - phase) < 0.00001, "speed or phase changed"): return
    if not require_ok(abs(n.rotation.z) < 0.000001, "double sway on outer container"): return
    if not require_ok(abs(n.get_node("__Model").rotation.z) <= 0.03501 and error < 0.00006, "native sway mismatch"): return
   if not require_ok(count == 1 and c.state.plants.size() == 2, "real board input must plant pea and sunflower"): return
   checks.append({"speed":speed,"clock":clock,"peas":count,"max_error":max_error})
 print("PEA_GARDEN_OK " + JSON.stringify(checks))
 get_tree().quit(0)
`;

test('real pea source transaction exposes native idle and preserves actual garden sway', {skip:!existsSync(baselinePath),timeout:900000},async t=>{
 const evidence=join(root,'.local/creation-verification/prefab-pea-native');mkdirSync(evidence,{recursive:true});
 const data=mkdtempSync(join(evidence,'case-')),origin='http://127.0.0.1:48921',report={ok:false,data};
 let service,browser;
 const server=createServer(async(req,res)=>{try{
  if(await service.request(req,res))return;
  if(service.builds.webRequest(req,res))return;
  const path=new URL(req.url,origin).pathname;
  const file=/^\/[a-z][a-z0-9-]*\.(js|css)$/.test(path)?join(root,'apps/creation-workspace',path.slice(1)):path.startsWith('/packages/')?join(root,path.slice(1)):null;
  if(file&&existsSync(file)){res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(readFileSync(file));return;}
  if(path==='/harness'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/prefab-lab.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#host{position:relative;width:100vw;height:100vh}</style><div id="host"></div>');return;}
  res.writeHead(404);res.end();
 }catch(error){res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
 const keys=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'],saved=keys.map(k=>[k,process.env[k]]);for(const k of keys)process.env[k]='1';
 try{service=new CreationService({server,root,data,origin,publicPlay:true});}finally{for(const[k,v]of saved)if(v===undefined)delete process.env[k];else process.env[k]=v;}
 await new Promise((yes,no)=>{server.once('error',no);server.listen(48921,'127.0.0.1',yes);});
 t.after(async()=>{await browser?.close();await service.close();await new Promise(yes=>server.close(yes));writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('PEA_EVIDENCE '+data);});
 const baseline=JSON.parse(readFileSync(baselinePath)),input=JSON.parse(readFileSync(inputPath));
 report.baseline_identity=baseline.source_identity;report.candidate_hash=hash(input);
 for(const entry of Object.values(baseline.source_files)){
  const bytes=readFileSync(join(root,'.local/model-preview/creation/native-source/objects',entry.hash.slice(0,2),entry.hash));
  assert.equal(hash(bytes),entry.hash);assert.equal(bytes.length,entry.size);service.native.archive.put(bytes);
 }
 const owner=service.store.register({name:'Pea independent test',password:'Independent-pea-native-test'});
 const created=service.store.createProject(owner.user,{name:'Isolated actual pea source'},baseline),projectId=created.project.id;
 const result=await service.committed(owner.user,projectId,'main',{...input,transaction_id:'isolated-pea-native',base_revision:created.branch.head,expected_head:created.branch.head});
 report.revision=result.revision;report.changed_files=result.changed_files;
 console.log('PEA_APPLY_OK '+JSON.stringify({revision:result.revision,changed_files:result.changed_files}));
 const directory=join(data,'garden-canonical'),snapshot=snapshotProjectRuntime(root,directory);
 await assembleProject({service,user:owner.user,project_id:projectId,branch_id:'main',revision:result.revision,entry_scene_id:'scene-harbor',directory,runtime_source_hash:snapshot.hash});
 writeFileSync(join(directory,'pea_probe.gd'),nativeProbe);
 const config=readFileSync(join(directory,'project.godot'),'utf8');writeFileSync(join(directory,'project.godot'),config.replace('[autoload]','[autoload]\nPeaProbe="*res://pea_probe.gd"'));
 const home=join(data,'godot-home');mkdirSync(home);const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),XDG_CACHE_HOME:join(home,'cache')},args=['--headless','--audio-driver','Dummy','--path',directory],godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';let log='';
 try{
  const imported=await exec(godot,[...args,'--editor','--import','--quit'],{env,timeout:120000,maxBuffer:16*1024*1024});log+=imported.stdout+imported.stderr;
  const played=await exec(godot,args,{env,timeout:90000,maxBuffer:16*1024*1024});log+=played.stdout+played.stderr;
  assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|PEA_PROBE_FAILED/);assert.match(log,/PEA_NATIVE_CLONE_OK/);assert.match(log,/PEA_GARDEN_OK/);
  report.native=JSON.parse(log.match(/PEA_GARDEN_OK (.+)/)[1]);console.log('PEA_NATIVE_AND_GARDEN_OK '+JSON.stringify(report.native));
 }catch(error){log+=String(error.stdout??'')+String(error.stderr??'');throw error;}finally{writeFileSync(join(data,'native.log'),log);}
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader','--mute-audio']});
 const page=await browser.newPage({viewport:{width:1512,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/SCRIPT ERROR|Parse Error|RuntimeError/.test(m.text()))errors.push(m.text());});
 await page.goto(origin+'/harness');
 await page.evaluate(async({token,projectId,revision})=>{
  const{mountPrefabLab}=await import('/prefab-lab.js');window.previewState=null;window.previewErrors=[];
  addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='prefab_test_state')window.previewState=e.data;});
  const request=async(path,options={})=>{const r=await fetch('/creation-api/'+path,{...options,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error||JSON.stringify(v));return v;};
  window.lab=mountPrefabLab(document.querySelector('#host'),{request,getContext:()=>({role:'owner',canWrite:true}),onError:e=>previewErrors.push(String(e))});
  lab.open({subject:{id:'prefab-pea',name:'豌豆射手',kind:'prefab'},scenarios:[],revision,projectId,branchId:'main'});
 },{token:owner.token,projectId,revision:result.revision});
 await page.waitForFunction(()=>previewState?.animations?.length||previewErrors.length,null,{timeout:600000});assert.deepEqual(await page.evaluate(()=>previewErrors),[]);
 const initial=await page.evaluate(()=>previewState);assert.equal(initial.current.name,'idle');assert.equal(initial.playing,true);report.web_initial={current:initial.current.name,player:initial.current.player,duration:initial.duration,playing:initial.playing};console.log('PEA_WEB_IDLE_OK '+JSON.stringify(report.web_initial));
 await page.getByRole('button',{name:'暂停动画',exact:true}).click();await page.waitForFunction(()=>!previewState.playing);
 const slider=page.getByRole('slider',{name:'动画播放位置'});await slider.evaluate(n=>{window.changes=0;n.addEventListener('change',()=>changes++);});report.web_drag=[];
 for(const[index,time]of [.628,1.885].entries()){
  await slider.evaluate((n,time)=>{n.value=String(time);n.dispatchEvent(new Event('input',{bubbles:true}));},time);
  await page.waitForFunction(time=>Math.abs(previewState.time-time)<.003&&!previewState.playing,time,{timeout:15000});assert.equal(await page.evaluate(()=>changes),0);
  await page.screenshot({path:join(data,`pea-input-${index+1}.png`)});report.web_drag.push({time:await page.evaluate(()=>previewState.time),change_events:0});
 }
 assert.equal(await page.locator('.animation-key,.animation-track,.animation-ticks').count(),0);assert.deepEqual(errors,[]);
 assert.equal(service.store.branchView(owner.user,projectId,'main').head,result.revision);report.ok=true;
});
