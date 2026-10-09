import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CreationService} from '../../services/creation/service.mjs';
import {CreationStore} from '../../services/creation/store.mjs';
import {AssetMarket} from '../../services/creation/asset-market.mjs';
import {assetFixturePNG} from './asset-test-fixtures.mjs';

// Independent HTTP / SQLite / native-engine checks. No production identities,
// source, services, paid Agents, desktop windows, or fabricated runtime ACKs.
test('asset market preserves attribution, permissions, fixed versions and independent native copies', {timeout:240000}, async t => {
  const root=resolve(import.meta.dirname,'../..'), data=mkdtempSync(join(tmpdir(),'atelier-market-independent-'));
  const port=Number(process.env.WORLD_ATELIER_MARKET_TEST_PORT??48921), origin=`http://127.0.0.1:${port}`;
  const evidence=join(root,'.local/creation-verification/asset-market',randomUUID());
  mkdirSync(evidence,{recursive:true});
  const report={scope:'Real isolated market HTTP, SQLite, native Godot import and copy editing; not browser or visual acceptance',origin,cases:[],completed:false};
  let service;
  const server=createServer((req,res)=>service.request(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}));
  const envKeys=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'];
  const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
  for(const key of envKeys)process.env[key]='1';
  try {service=new CreationService({server,root,data,origin});}
  finally {for(const key of envKeys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
  t.after(async()=>{
    await service.close();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    report.finished_at=new Date().toISOString();
    writeFileSync(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
    rmSync(data,{recursive:true,force:true});
    console.log('ASSET_MARKET_EVIDENCE '+evidence);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  async function request(method,path,actor,input,expected=200,raw=false) {
    const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin,...(actor?{authorization:'Bearer '+actor.token}:{}),'content-type':raw?'application/octet-stream':'application/json',...(raw?{'x-asset-name':'fixture.bin'}:{})},...(input===undefined?{}:{body:raw?input:JSON.stringify(input)})});
    const text=await response.text(); let value; try {value=JSON.parse(text);} catch {value=text;}
    assert.equal(response.status,expected,`${method} ${path}: ${text.slice(0,2000)}`);return value;
  }
  const register=name=>request('POST','/auth/register',null,{name,password:'Independent-test-password'},201);
  const owner=await register('Market owner'),other=await register('Market other'),viewer=await register('Market viewer');
  const nativeFiles={
    'project.godot':'config_version=5\n[application]\nconfig/name="Independent market game"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',path:'main.tscn'}}}),
    'main.tscn':'[gd_scene format=3]\n[node name="Main" type="Node2D"]\nmetadata/wa_node_id="main"\n',
    'keep.txt':'Existing game source stays untouched.\n',
  };
  const created=await request('POST','/projects',owner,{name:'Market copy isolation',template:'empty'},201);
  const projectId=created.project.id,branchRoute=`/projects/${projectId}/branches/main`;
  await request('POST',branchRoute+'/transactions',owner,{transaction_id:'native-source-setup',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(nativeFiles).map(([path,text])=>({path,text}))}]});
  const invitation=await request('POST',`/projects/${projectId}/invites`,owner,{role:'viewer'},201);
  await request('POST','/invites/join',viewer,{code:invitation.code});
  const packageFiles={
    'hero.tscn':Buffer.from('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://hero.gd" id="1"]\n[node name="MarketHero" type="CharacterBody2D"]\nscript=ExtResource("1")\n'),
    'hero.gd':Buffer.from('extends CharacterBody2D\n@export var movement_speed: float = 180.0\n'),
    'cover.png':assetFixturePNG(),
    'LICENSE.txt':Buffer.from('CC0 1.0. Independent test fixture created for this test.\n'),
  };
  const files={};
  for(const [path,bytes] of Object.entries(packageFiles))files[path]=await request('POST','/market/files',owner,bytes,201,true);
  const input={name:'Independent test character',description:'A fixture character for checking native package copying and permission boundaries.',category:'character',dimension:'2d',license:'CC0-1.0',source_url:'https://example.com/independent-market-test',files,entry_path:'hero.tscn',screenshots:['cover.png'],preview:{type:'image',path:'cover.png'},tags:['independent-test','character'],features:['Editable movement speed'],redistribution_confirmed:true};
  await request('POST','/market/files',null,Buffer.from('denied'),401,true);
  await request('POST','/market',null,input,401);
  await request('POST','/market',other,input,403);
  await request('POST','/market',owner,{...input,redistribution_confirmed:false},422);
  await request('POST','/market',owner,{...input,files:{...files,'project.godot':files['hero.gd']}},422);
  const {asset}=await request('POST','/market',owner,{...input,publisher:'official',owner_user_id:other.user.id},201);
  assert.ok(asset.id);assert.equal(asset.publisher,'developer');
  assert.equal(asset.owner_user_id,owner.user.id,'publisher ownership cannot be spoofed');
  assert.ok(asset.version,'a published asset must identify its immutable version');
  assert.ok(asset.detail_url,'every asset has a stable public detail URL');
  assert.ok(asset.detail_url.includes(encodeURIComponent(asset.id))||asset.detail_url.includes(asset.id));
  report.cases.push({name:'authenticated uploader owns developer publication; no official impersonation',asset_id:asset.id,version:asset.version});
  const {asset:detail}=await request('GET',`/market/${asset.id}`,null);
  assert.equal(detail.id,asset.id);assert.equal(detail.version,asset.version);assert.equal(detail.license,input.license);
  const listed=await request('GET','/market?q=independent-test&dimension=2d&publisher=developer',null);
  assert.ok(listed.assets.some(item=>item.id===asset.id),'published asset is discoverable anonymously');
  assert.equal(JSON.stringify(listed).includes(packageFiles['cover.png'].toString('base64')),false,'list contains compact media references, not raw assets');
  const fileRoute=`/market/${asset.id}/versions/${asset.version}/files/hero.gd`;
  const sourceURL=origin+'/creation-api'+fileRoute;
  assert.deepEqual(Buffer.from(await (await fetch(sourceURL)).arrayBuffer()),packageFiles['hero.gd']);
  for(const badPath of ['../escape.gd','/absolute.gd','dir/../../escape.gd'])await request('POST','/market',owner,{...input,files:{...files,[badPath]:files['hero.gd']}},422);
  await request('POST','/market',owner,{...input,screenshots:['missing.png']},422);
  report.cases.push({name:'anonymous discovery, fixed source bytes, valid screenshots and confined package paths'});
  const before=await request('GET',branchRoute,owner), importInput={asset_id:asset.id,version:asset.version,base_revision:before.head,transaction_id:'market-copy-one'};
  await request('POST',branchRoute+'/market-import',viewer,importInput,403);
  await request('POST',branchRoute+'/market-import',other,importInput,403);
  const first=await request('POST',branchRoute+'/market-import',owner,importInput);
  assert.equal(first.import.asset_id,asset.id);assert.equal(first.import.version,asset.version);assert.ok(first.import.resource_id);
  let branch=await request('GET',branchRoute,owner);
  assert.notEqual(branch.head,before.head);assert.equal(branch.manifest.source_files['project.godot'].hash,before.manifest.source_files['project.godot'].hash);
  assert.deepEqual(branch.manifest.source_files['keep.txt'],before.manifest.source_files['keep.txt']);
  const firstDirectory=first.import.directory.replace(/^res:\/\//,'').replace(/\/$/,''),firstScript=firstDirectory+'/hero.gd';
  assert.ok(branch.manifest.source_files[firstScript]);
  const readSource=async path=>{
    const value=await request('GET',branchRoute+'/native-source?path='+encodeURIComponent(path),owner);
    return value.text??Buffer.from(value.data_base64,'base64').toString();
  };
  assert.match(await readSource(firstDirectory+'/hero.tscn'),new RegExp('res://'+firstDirectory+'/hero\\.gd'));
  assert.ok(branch.manifest.resources[first.import.resource_id],'imported scene is a discoverable prefab');
  const replay=await request('POST',branchRoute+'/market-import',owner,importInput);
  assert.equal(replay.import.directory,first.import.directory);assert.equal((await request('GET',branchRoute,owner)).head,branch.head);
  const second=await request('POST',branchRoute+'/market-import',owner,{...importInput,base_revision:branch.head,transaction_id:'market-copy-two'});
  assert.notEqual(second.import.directory,first.import.directory);assert.notEqual(second.import.resource_id,first.import.resource_id);
  branch=await request('GET',branchRoute,owner);
  const secondDirectory=second.import.directory.replace(/^res:\/\//,'').replace(/\/$/,''),secondScript=secondDirectory+'/hero.gd';
  assert.equal(branch.manifest.source_files[firstScript].hash,branch.manifest.source_files[secondScript].hash);
  const copiedHash=branch.manifest.source_files[firstScript].hash;
  await request('POST',branchRoute+'/transactions',owner,{transaction_id:'edit-first-market-copy',base_revision:branch.head,ops:[{type:'put_source_file',path:firstScript,expected_hash:copiedHash,text:'extends CharacterBody2D\n@export var movement_speed: float = 333.0\n'}]});
  const edited=await request('GET',branchRoute,owner);
  assert.notEqual(edited.manifest.source_files[firstScript].hash,copiedHash);
  assert.equal(edited.manifest.source_files[secondScript].hash,copiedHash);
  assert.deepEqual(Buffer.from(await (await fetch(sourceURL)).arrayBuffer()),packageFiles['hero.gd']);
  assert.equal((await request('GET',`/market/${asset.id}?version=${asset.version}`,null)).asset.version,asset.version);
  report.cases.push({name:'two independent prefab copies, native reference remapping, idempotent import and unchanged market original',copies:[first.import,second.import],revision:edited.head});
  const incompleteFile=await request('POST','/market/files',owner,Buffer.from('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://private/missing.gd" id="1"]\n[node name="Broken" type="Node2D"]\nscript=ExtResource("1")\n'),201,true);
  const {asset:incomplete}=await request('POST','/market',owner,{...input,files:{...files,'hero.tscn':incompleteFile}},201);
  await request('POST',branchRoute+'/market-import',owner,{asset_id:incomplete.id,version:incomplete.version,base_revision:edited.head,transaction_id:'reject-incomplete-dependency'},422);
  assert.equal((await request('GET',branchRoute,owner)).head,edited.head,'missing dependency rejection leaves current source intact');
  report.cases.push({name:'unpackaged absolute dependency rejects import without a partial commit'});
  report.completed=true;
});

test('official asset updates retain immutable prior versions and independently archived bytes', t => {
  const data=mkdtempSync(join(tmpdir(),'atelier-market-version-')),store=new CreationStore(join(data,'creation.sqlite'));
  t.after(()=>{store.close();rmSync(data,{recursive:true,force:true});});
  const market=new AssetMarket({service:{store,data}}),image=market.archive.put(assetFixturePNG()),original=market.archive.put(Buffer.from('original texture metadata'));
  const input={id:'official-version-fixture',name:'Official version fixture',description:'Immutable official asset version fixture',category:'texture',dimension:'any',license:'CC0-1.0',source_url:'https://example.com/source',screenshots:['cover.png'],preview:{type:'image',path:'cover.png'},files:{'cover.png':image,'meta.txt':original},redistribution_confirmed:true};
  const first=market.installOfficial(input).asset;
  const replacement=market.archive.put(Buffer.from('replacement texture metadata'));
  const second=market.installOfficial({...input,description:'Updated description',files:{...input.files,'meta.txt':replacement}}).asset;
  assert.equal(first.id,second.id);assert.equal(first.detail_url,second.detail_url);assert.notEqual(first.version,second.version);
  assert.equal(market.detail(first.id).asset.version,second.version);
  assert.deepEqual(market.detail(first.id,first.version).asset.files['meta.txt'],original);
  assert.equal(market.archive.read(original).toString(),'original texture metadata');
  assert.equal(market.archive.read(replacement).toString(),'replacement texture metadata');
  assert.equal(market.list({publisher:'official'}).total,1,'only the current official asset appears in discovery');
  assert.throws(()=>market.detail(first.id,'missing-version'),error=>error.status===404);
});
