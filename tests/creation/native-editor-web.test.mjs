import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';

test('native editor uses real authorized queue, sandbox export and original browser preview bridge',{timeout:600000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),base=join(root,'.local/creation-verification/native-framework');mkdirSync(base,{recursive:true});
  const data=mkdtempSync(join(base,'editor-web-')),origin='http://127.0.0.1:48921';
  const report={scope:'real native preview queue/export and original browser bridge; not full workbench interactions',ok:false,errors:[]};
  let service,browser;
  const server=createServer(async(req,res)=>{try{
    if(await service.request(req,res))return;if(service.builds.webRequest(req,res))return;
    const path=new URL(req.url,origin).pathname;
    if(['/native-preview.js','/preview-bridge.js','/client-platform.js'].includes(path)){res.setHeader('content-type','text/javascript');res.end(readFileSync(join(root,'apps/creation-workspace',path.slice(1))));return;}
    if(path==='/harness'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><style>html,body,#preview{margin:0;width:100%;height:100%;background:#0e1724}iframe{border:0;width:100%;height:100%}.render-status{position:absolute;top:12px;left:12px;color:white}</style></head><body><div id="preview"></div></body></html>');return;}
    res.writeHead(404);res.end();
  }catch(error){res.writeHead(error.status??500);res.end(JSON.stringify({error:error.message}));}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(48921,'127.0.0.1',yes);});
  const settings=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(key=>[key,process.env[key]]);
  for(const [key]of settings)process.env[key]='1';
  try{service=new CreationService({server,root,data,origin});}finally{for(const [key,value]of settings)if(value===undefined)delete process.env[key];else process.env[key]=value;}
  t.after(async()=>{await browser?.close();await service.close();await new Promise(yes=>server.close(yes));writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');});
  const owner=service.store.register({name:'Native preview owner',password:'native-preview-test-password'}),outsider=service.store.register({name:'Native preview outsider',password:'native-preview-test-password'});
  const created=await service.createProject(owner.user,{name:'Native preview game'}),p=created.project.id;
  assert.equal(created.branch.manifest.schema,'creation-native-1');
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Native editor Web fixture"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    'author.gd':'extends Node3D\n@export var attack: float = 10.0\nfunc _ready():\n\tpush_error("AUTHOR_GAMEPLAY_RAN_IN_EDITOR")\n',
    'box.tscn':'[gd_scene load_steps=4 format=3]\n[ext_resource type="Script" path="res://author.gd" id="1"]\n[sub_resource type="StandardMaterial3D" id="mat"]\nalbedo_color=Color(0.95,0.2,0.1,1)\n[sub_resource type="BoxMesh" id="mesh"]\nmaterial=SubResource("mat")\n[node name="Box" type="Node3D"]\nscript=ExtResource("1")\nmetadata/wa_node_id="box"\n[node name="Visual" type="MeshInstance3D" parent="."]\nmesh=SubResource("mesh")\n',
    'main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://box.tscn" id="1"]\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id="root"\n[node name="A" parent="." instance=ExtResource("1")]\nposition=Vector3(-1,0,0)\nattack=23.0\nmetadata/wa_instance_id="a"\n[node name="B" parent="." instance=ExtResource("1")]\nposition=Vector3(1,0,0)\nmetadata/wa_instance_id="b"\n'
  };
  const imported=await service.committed(owner.user,p,'main',{transaction_id:'import',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
  const rid=imported.branch.manifest.entry_scene_id,packet=service.assets.scene(owner.user,p,imported.branch,rid,origin);
  assert.throws(()=>service.builds.prepareNativePreview(outsider.user,p,'main',{source_revision:imported.revision,entry_scene_id:rid}),/权限/);
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1100,height:760}});
  page.on('pageerror',error=>report.errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&/SCRIPT ERROR|AUTHOR_GAMEPLAY|RuntimeError/.test(message.text()))report.errors.push(message.text());});
  await page.goto(origin+'/harness');
  const loaded=await page.evaluate(async({token,packet})=>{
    const {NativeGodotPreview}=await import('/native-preview.js');
    const request=async(path,options={})=>{const response=await fetch('/creation-api/'+path,{method:options.method??'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{}),signal:options.signal});const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data;};
    window.events=[];window.preview=new NativeGodotPreview(document.querySelector('#preview'),'main',event=>events.push(event),request);
    await preview.scene({...packet,frame:true,editable:true});
    return {loaded:preview.lastLoadedEvent,job:preview.runtimeManifest};
  },{token:owner.token,packet});
  assert.equal(loaded.job.purpose,'native_preview');assert.equal(loaded.job.status,'completed');assert.equal(loaded.loaded.document_id,packet.document_id);
  assert.equal(Number(loaded.loaded.mesh_count??loaded.loaded.meshes),2);
  const jobs=service.store.list('creator_build');assert.equal(jobs.length,1);
  assert.ok(jobs[0].toolchain_identity.godot_bundle.files.length>1);
  const other=Object.values(imported.branch.manifest.resources).find(resource=>resource.id!==rid),otherPacket=service.assets.scene(owner.user,p,imported.branch,other.id,origin);
  await page.evaluate(async packet=>{await preview.scene({...packet,frame:true,editable:true});},otherPacket);
  const later=await page.evaluate(()=>({loaded:preview.lastLoadedEvent,job:preview.runtimeManifest.id}));
  assert.equal(later.loaded.document_id,otherPacket.document_id);assert.equal(later.job,loaded.job.id);assert.equal(service.store.list('creator_build').length,1);
  if(service.builds.running)await service.builds.running;
  const cleaned=service.store.get('creator_build',jobs[0].id);
  assert.equal(cleaned.execution_cleanup?.status,'completed');
  assert.ok(cleaned.execution_cleanup.removed_paths.some(path=>path.endsWith('/engine')));
  for(const path of cleaned.execution_cleanup.removed_paths)assert.equal(existsSync(join(data,'builds',cleaned.id,path)),false);
  assert.ok(existsSync(join(data,'builds',cleaned.id,'project','project.godot')));
  assert.ok(existsSync(join(data,'builds',cleaned.id,'native-preview-receipt.json')));
  assert.equal(service.builds.validWeb(cleaned),true);
  await page.screenshot({path:join(data,'native-editor.png')});
  assert.deepEqual(report.errors,[]);assert.equal(service.store.branchFor(owner.user,p,'main').head,imported.revision);
  Object.assign(report,{ok:true,project_id:p,source_revision:imported.revision,source_identity:imported.branch.manifest.source_identity,job:service.builds.view(cleaned),first:loaded.loaded,second:later.loaded});
  console.log('NATIVE_EDITOR_WEB_EVIDENCE '+data);
});
