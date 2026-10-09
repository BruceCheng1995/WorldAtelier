// Actual browser, native PackedScene bake/export, canvas JPEG and localStorage.
// Uses only 48921 and an isolated data directory; never opens a desktop window.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';

test('native thumbnail cold capture survives browser reload with authorized source read and no new renderer or build',{timeout:600000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),base=join(root,'.local/creation-verification/native-thumbnail-cache');
  mkdirSync(base,{recursive:true});
  const data=mkdtempSync(join(base,'browser-')),origin='http://127.0.0.1:48921';
  const report={ok:false,scope:'real native prefab thumbnail capture and persistent cache after page reload; isolated browser harness, not full workbench acceptance',errors:[],stage:'initializing'};
  let service,browser;
  const server=createServer(async(req,res)=>{
    try{
      if(await service.request(req,res))return;
      if(service.builds.webRequest(req,res))return;
      const path=new URL(req.url,origin).pathname;
      if(['/native-preview.js','/preview-bridge.js','/client-platform.js','/workspace.css'].includes(path)){
        res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');
        res.end(readFileSync(join(root,'apps/creation-workspace',path.slice(1))));return;
      }
      if(path==='/harness'){
        res.setHeader('content-type','text/html');
        res.end('<!doctype html><html><head><link rel="stylesheet" href="/workspace.css"><style>body{display:block;padding:32px}#cards{width:384px;height:288px;overflow:auto}.prefab-picture{display:block;width:384px;height:288px}.prefab-picture img{width:100%;height:100%;object-fit:contain}</style></head><body><div id="cards"><button class="prefab-picture"><img alt="Native Box thumbnail" hidden><span class="prefab-preview-status">正在读取预览…</span></button></div></body></html>');return;
      }
      res.writeHead(404);res.end();
    }catch(error){res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  t.after(async()=>{
    await browser?.close();await service?.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log('NATIVE_THUMBNAIL_CACHE_EVIDENCE '+data);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(48921,'127.0.0.1',resolve);});
  const settings=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(key=>[key,process.env[key]]);
  for(const [key] of settings)process.env[key]='1';
  try{service=new CreationService({server,root,data,origin});}
  finally{for(const [key,value] of settings)if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const owner=service.store.register({name:'Thumbnail cache owner',password:'isolated-thumbnail-cache-password'});
  const created=await service.createProject(owner.user,{name:'Thumbnail cache isolated project'}),p=created.project.id;
  const texts={
    'project.godot':'config_version=5\n[application]\nconfig/name="Native thumbnail cache fixture"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    'box.tscn':'[gd_scene load_steps=3 format=3]\n[sub_resource type="StandardMaterial3D" id="mat"]\nalbedo_color=Color(0.95,0.2,0.1,1)\n[sub_resource type="BoxMesh" id="mesh"]\nmaterial=SubResource("mat")\n[node name="Box" type="Node3D"]\nmetadata/wa_node_id="box"\n[node name="Visual" type="MeshInstance3D" parent="."]\nmesh=SubResource("mesh")\n',
    'main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://box.tscn" id="1"]\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id="main"\n[node name="Box" parent="." instance=ExtResource("1")]\nmetadata/wa_instance_id="box-instance"\n'
  };
  const imported=await service.committed(owner.user,p,'main',{transaction_id:'thumbnail-import',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
  const resource=Object.values(imported.branch.manifest.resources).find(value=>value.kind==='prefab'&&value.path==='box.tscn');
  assert.ok(resource,'native import discovers Box as a prefab');
  const baseline={head:imported.revision,source_identity:imported.branch.manifest.source_identity,revisions:service.store.list('creator_revision').map(row=>row.id).sort(),builds:service.store.list('creator_build').length};
  assert.equal(baseline.builds,0);
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
  const page=await browser.newPage({viewport:{width:800,height:600}});
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&/SCRIPT ERROR|RuntimeError/.test(message.text()))report.errors.push(message.text());});
  const show=async()=>{
    await page.evaluate(async({token,userId,projectId,resource,revision})=>{
      const {PrefabThumbnails,prefabThumbnailKey}=await import('/preview-bridge.js');
      const {NativeGodotPreview}=await import('/native-preview.js');
      window.metrics={viewers:0,requests:[]};
      const request=async(path,options={})=>{
        metrics.requests.push({path,method:options.method??'GET'});
        const response=await fetch('/creation-api/'+path,{method:options.method??'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{}),signal:options.signal});
        const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data;
      };
      const entry={projectId,branchId:'main',resourceId:resource.id,revision,documentId:projectId+'/main/'+resource.id,key:prefabThumbnailKey(projectId,'main',resource,revision)};
      document.querySelector('.prefab-picture').dataset.thumbnailKey=entry.key;
      window.thumbnails=new PrefabThumbnails({cacheScope:()=>userId,
        loadScene:entry=>request(`projects/${encodeURIComponent(entry.projectId)}/branches/main/runtime-scene?resource_id=${encodeURIComponent(entry.resourceId)}&revision=${encodeURIComponent(entry.revision)}&thumbnail=1`),
        viewerFactory:(_scene,host)=>{metrics.viewers++;return new NativeGodotPreview(host,'object',()=>{},request);}});
      thumbnails.observe(document.querySelector('#cards'),[entry]);
      addEventListener('pagehide',()=>thumbnails.dispose(),{once:true});
    },{token:owner.token,userId:owner.user.id,projectId:p,resource,revision:imported.revision});
    await page.waitForFunction(()=>['ready','error'].includes(document.querySelector('.prefab-picture').dataset.previewState),{},{timeout:480000});
    return page.evaluate(()=>({state:document.querySelector('.prefab-picture').dataset.previewState,url:document.querySelector('.prefab-picture img').src,status:document.querySelector('.prefab-preview-status').textContent,metrics,cacheRows:JSON.parse(localStorage.getItem('wa-prefab-images-v1')??'[]').length}));
  };
  report.stage='cold native capture';console.log('NATIVE_THUMBNAIL_CACHE_STAGE cold native capture');
  await page.goto(origin+'/harness');
  const cold=await show();
  assert.equal(cold.state,'ready',cold.status);assert.equal(cold.metrics.viewers,1);assert.equal(cold.cacheRows,1);
  assert.match(cold.url,/^data:image\/jpeg;base64,/);
  const bytes=Buffer.from(cold.url.split(',')[1],'base64');assert.ok(bytes.length>1000);assert.equal(bytes.subarray(0,2).toString('hex'),'ffd8');
  writeFileSync(join(data,'box-thumbnail.jpg'),bytes);await page.screenshot({path:join(data,'cold.png')});
  const coldJobs=service.store.list('creator_build');assert.equal(coldJobs.length,1);assert.equal(coldJobs[0].purpose,'native_preview');assert.equal(coldJobs[0].status,'completed');
  assert.equal(cold.metrics.requests.filter(row=>row.path.endsWith('/native-preview-build')).length,1);
  assert.equal(cold.metrics.requests.filter(row=>row.path.endsWith('/access')).length,1);
  report.stage='reload cached thumbnail';console.log('NATIVE_THUMBNAIL_CACHE_STAGE reload cached thumbnail');
  await page.reload();const warm=await show();
  assert.equal(warm.state,'ready',warm.status);assert.equal(warm.url,cold.url);assert.equal(warm.cacheRows,1);assert.equal(warm.metrics.viewers,0);
  assert.equal(warm.metrics.requests.length,1);assert.match(warm.metrics.requests[0].path,/runtime-scene\?.*&thumbnail=1$/);
  assert.equal(warm.metrics.requests.filter(row=>/native-preview-build|\/access$/.test(row.path)).length,0);
  assert.deepEqual(service.store.list('creator_build').map(row=>row.id),coldJobs.map(row=>row.id));
  const current=service.store.branchView(owner.user,p,'main');assert.equal(current.head,baseline.head);assert.equal(current.manifest.source_identity,baseline.source_identity);
  assert.deepEqual(service.store.list('creator_revision').map(row=>row.id).sort(),baseline.revisions);
  await page.screenshot({path:join(data,'warm.png')});assert.deepEqual(report.errors,[]);
  const compact=value=>({state:value.state,metrics:value.metrics,cacheRows:value.cacheRows});
  Object.assign(report,{ok:true,stage:'complete',project_id:p,source_revision:baseline.head,source_identity:baseline.source_identity,thumbnail_sha256:createHash('sha256').update(bytes).digest('hex'),thumbnail_bytes:bytes.length,cold:compact(cold),warm:compact(warm),build_id:coldJobs[0].id,source_unchanged:true});
});
