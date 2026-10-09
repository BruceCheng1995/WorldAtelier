import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,unlinkSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CreationService} from '../../services/creation/service.mjs';
import {NATIVE_SCHEMA,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {assetFixturePNG} from './asset-test-fixtures.mjs';

// Real isolated HTTP, SQLite and content-addressed file checks. Import metrics
// use an explicit commit test double; this suite never claims engine execution,
// native scene validation, a runtime ACK, or production source changes.
const root=resolve(import.meta.dirname,'../..');
const uid=prefix=>`${prefix}-${randomUUID()}`;

async function fixture(t){
  const data=mkdtempSync(join(tmpdir(),'atelier-admin-market-'));
  const port=Number(process.env.WORLD_ATELIER_ADMIN_MARKET_TEST_PORT??48921);
  const origin=`http://127.0.0.1:${port}`;
  let service,server;
  async function start(){
    server=createServer((req,res)=>service.request(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}));
    const saved=Object.fromEntries(['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS','WORLD_ATELIER_ADMIN_USER_ID'].map(key=>[key,process.env[key]]));
    process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';delete process.env.WORLD_ATELIER_ADMIN_USER_ID;
    try{service=new CreationService({server,root,data,origin});}
    finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
    service.native.engine=async()=>{throw Error('This administrative suite must never invoke Godot');};
    service.native.importProject=async()=>{throw Error('This administrative suite must never import a Godot project');};
    await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
  }
  async function stop(){if(service)await service.close();if(server?.listening)await new Promise(ok=>server.close(ok));}
  t.after(async()=>{await stop();rmSync(data,{recursive:true,force:true});});
  await start();
  async function request(method,path,actor,input,expected=200){
    const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin,connection:'close','content-type':'application/json',...(actor?{authorization:'Bearer '+actor.token}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const body=await response.text();let value;try{value=JSON.parse(body);}catch{value=body;}
    assert.equal(response.status,expected,`${method} ${path}: ${body.slice(0,1500)}`);return value;
  }
  const owner=service.store.register({name:uid('Market admin'),password:uid('Password')});
  const other=service.store.register({name:uid('Market guest'),password:uid('Password')});
  service.store.put('creator_admin_settings',{id:'singleton',owner_user_id:owner.user.id});
  const image=service.market.archive.put(assetFixturePNG());
  const script=service.market.archive.put(Buffer.from('extends Node\n# independent administration fixture\n'));
  const input={id:'admin-market-fixture',name:'Market administration fixture',description:'Independent administration and real storage test asset.',category:'texture',dimension:'any',license:'CC0-1.0',source_url:'https://example.com/admin-market-fixture',screenshots:['cover.png'],preview:{type:'image',path:'cover.png'},files:{'cover.png':image,'fixture.gd':script},redistribution_confirmed:true};
  const asset=service.market.installOfficial(input).asset;
  // An explicit protocol fixture, not a Godot-derived scene index. It is only
  // used to reach the market permission/preparation/commit boundary below.
  const files={'project.godot':service.native.archive.put(Buffer.from('config_version=5\n'))};
  const identity=nativeSourceIdentity(files);
  const project=service.store.createProject(owner.user,{name:'Market metric protocol fixture'},{schema:NATIVE_SCHEMA,source_files:files,source_identity:identity,index_source_identity:identity,entry_scene_id:'main',resources:{main:{id:'main',name:'Protocol fixture',kind:'scene',native_nodes:[]}}});
  const branchRoute=`/projects/${project.project.id}/branches/main`;
  return {get service(){return service;},data,origin,owner,other,input,asset,image,script,project,branchRoute,request,
    detail:async id=>(await request('GET',`/admin/market/${id??asset.id}`,owner)).item,
    restart:async()=>{await stop();await start();},
    patch:async input=>request('PATCH',`/admin/market/${asset.id}`,owner,input),
  };
}

test('market administration requires the sole administrator and preserves audited visibility across official updates',async t=>{
  const f=await fixture(t),{request,owner,other,asset}=f;
  for(const path of ['/admin/market',`/admin/market/${asset.id}`]){
    await request('GET',path,null,undefined,401);await request('GET',path,other,undefined,403);
  }
  const before=await f.detail();assert.equal(before.status,'listed');assert.equal(before.asset_version,asset.version);assert.equal(before.version,1);
  const input={request_id:uid('unlist'),expected_version:before.version,reason:'Independent review of market visibility',status:'unlisted'};
  await request('PATCH',`/admin/market/${asset.id}`,other,input,403);
  const result=await f.patch(input);assert.equal(result.version,2);
  assert.equal((await f.patch(input)).replayed,true);
  await request('PATCH',`/admin/market/${asset.id}`,owner,{...input,status:'listed'},409);
  await request('PATCH',`/admin/market/${asset.id}`,owner,{...input,request_id:uid('stale')},409);
  await request('PATCH',`/admin/market/${asset.id}`,owner,{...input,request_id:uid('unknown'),expected_version:2,publisher:'official'},400);
  await request('PATCH',`/admin/market/${asset.id}`,owner,{...input,request_id:uid('reason'),expected_version:2,reason:''},400);
  const audit=(await request('GET','/admin/audit?limit=100',owner)).items.filter(x=>x.request_id===input.request_id);
  assert.equal(audit.length,1);assert.equal(audit[0].actor_id,owner.user.id);assert.equal(audit[0].id,result.audit_id);
  assert.equal(audit[0].before.status,'listed');assert.equal(audit[0].after.status,'unlisted');
  assert.equal((await request('GET','/market',null)).assets.some(x=>x.id===asset.id),false);
  for(const suffix of ['',`?version=${asset.version}`])await request('GET',`/market/${asset.id}${suffix}`,null,undefined,404);
  for(const method of ['GET','HEAD'])await request(method,`/market/${asset.id}/versions/${asset.version}/files/fixture.gd`,null,undefined,404);
  await request('POST',f.branchRoute+'/market-import',owner,{asset_id:asset.id,version:asset.version,base_revision:f.project.branch.head,transaction_id:uid('hidden-import')},404);
  const same=f.service.market.installOfficial(f.input);assert.equal(same.asset.version,asset.version);
  const changed=f.service.market.installOfficial({...f.input,description:'An official content update must preserve administrator unlisting.'});
  assert.notEqual(changed.asset.version,asset.version);assert.equal((await f.detail()).status,'unlisted');assert.equal((await f.detail()).version,3);
  assert.equal((await request('GET','/market',null)).assets.some(x=>x.id===asset.id),false);
  await f.restart();assert.equal((await f.detail()).status,'unlisted');assert.equal((await f.detail()).version,3);
  const page=await request('GET','/admin/market?status=unlisted&q=administration',owner);
  assert.equal(page.total,1);assert.equal(page.items[0].id,asset.id);
  await f.patch({request_id:uid('relist'),expected_version:3,reason:'Independent fixture restored',status:'listed'});
  assert.equal((await request('GET',`/market/${asset.id}`,null)).asset.version,changed.asset.version);
  assert.equal((await request('GET',`/market/${asset.id}?version=${asset.version}`,null)).asset.version,asset.version);
  assert.match(await request('GET',`/market/${asset.id}/versions/${asset.version}/files/fixture.gd`,null),/independent administration fixture/);
});

test('market traffic distinguishes public views, explicit file downloads and successful import receipts',async t=>{
  const f=await fixture(t),{asset,request,owner}=f;
  assert.deepEqual((await f.detail()).metrics,{downloads:0,views:0,file_downloads:0,views_7d:0,imports_7d:0,heat_7d:0,last_activity_at:null});
  f.service.market.detail(asset.id);f.service.market.list();
  await request('GET','/market',null);await request('GET','/market/missing',null,undefined,404);
  const file=`/market/${asset.id}/versions/${asset.version}/files/fixture.gd`;
  await request('GET',file,null);await request('HEAD',file+'?download=1',null);
  assert.equal((await f.detail()).metrics.views,0);assert.equal((await f.detail()).metrics.file_downloads,0);
  await request('GET',`/market/${asset.id}`,null);await request('GET',`/market/${asset.id}?version=${asset.version}`,null);
  await request('GET',file+'?download=1',null);
  let metrics=(await f.detail()).metrics;assert.equal(metrics.views,2);assert.equal(metrics.views_7d,2);assert.equal(metrics.file_downloads,1);assert.equal(metrics.downloads,0);
  const p=f.project.project.id,base_revision=f.project.branch.head;
  const input={asset_id:asset.id,version:asset.version,base_revision,transaction_id:uid('metric-commit')};
  // Only the commit receipt boundary is doubled. This is not a native source
  // commit or engine acknowledgement: its revision refers to our fixture.
  const commit=(user,p,b,transaction,origin)=>{
    const id=`${p}:${b}:${transaction.transaction_id}`,fingerprint=hash({user_id:user.id,input:transaction,origin});
    const old=f.service.store.get('creator_receipt',id);
    if(old){if(old.fingerprint!==fingerprint)throw Object.assign(Error('Fixture transaction identity conflict'),{status:409});return {...old.result,replayed:true};}
    const result={transaction_id:transaction.transaction_id,revision:base_revision};
    f.service.store.put('creator_receipt',{id,fingerprint,result});return result;
  };
  f.service.committed=commit;
  await request('POST',f.branchRoute+'/market-import',f.other,input,403);
  await request('POST',f.branchRoute+'/market-import',owner,input);
  const replay=await request('POST',f.branchRoute+'/market-import',owner,input);assert.equal(replay.result.replayed,true);
  metrics=(await f.detail()).metrics;assert.equal(metrics.downloads,1);assert.equal(metrics.imports_7d,1);assert.equal(metrics.heat_7d,7);
  f.service.committed=()=>{throw Object.assign(Error('Independent commit failure'),{status:409});};
  await request('POST',f.branchRoute+'/market-import',owner,{...input,transaction_id:uid('metric-failure')},409);
  assert.equal((await f.detail()).metrics.downloads,1);
  f.service.committed=()=>({revision:base_revision});
  await request('POST',f.branchRoute+'/market-import',owner,{...input,transaction_id:uid('no-receipt')});
  assert.equal((await f.detail()).metrics.downloads,1,'A returned success without a matching persisted receipt must not count');
  f.service.committed=commit;
  const different=f.service.market.installOfficial({...f.input,id:'other-metric-asset',description:'Different metric transaction identity'}).asset;
  await request('POST',f.branchRoute+'/market-import',owner,{...input,asset_id:different.id,version:different.version},409);
  assert.equal((await f.detail(different.id)).metrics.downloads,0);
  const DAY=86400000,today=Math.floor(Date.now()/DAY)*DAY;
  f.service.market.analytics.record(asset.id,'views',today-7*DAY+1);
  f.service.market.analytics.record(asset.id,'views',today-6*DAY+1);
  metrics=(await f.detail()).metrics;assert.equal(metrics.views,4);assert.equal(metrics.views_7d,3);assert.equal(metrics.heat_7d,8);
  const crashInput={...input,transaction_id:uid('committed-before-metric')};
  const prepared=f.service.market.importOperations(owner.user,p,'main',crashInput);
  const branch=f.service.store.branchFor(owner.user,p,'main',true);
  f.service.market.analytics.prepare(owner.user,branch,prepared,null);
  commit(owner.user,p,'main',prepared.transaction,null);
  assert.equal((await f.detail()).metrics.downloads,1,'Deferred accounting remains pending until reconciliation');
  await f.restart();
  metrics=(await f.detail()).metrics;assert.equal(metrics.downloads,2);assert.equal(metrics.imports_7d,2);assert.equal(metrics.views,4);assert.equal(metrics.file_downloads,1);assert.equal(metrics.heat_7d,13);
  const summary=(await request('GET','/admin/market',owner)).summary;
  assert.equal(summary.downloads,2);assert.equal(summary.views_7d,3);assert.equal(summary.imports_7d,2);assert.match(summary.heat_formula,/5/);
  await f.restart();assert.equal((await f.detail()).metrics.downloads,2,'A second restart cannot recount reconciled imports');
});

test('market storage measures unique archived bytes, historical and orphan objects, and missing files',async t=>{
  const f=await fixture(t),{asset,input}=f,market=f.service.market;
  const original=f.script,replacement=market.archive.put(Buffer.from('extends Node\n# second immutable version\n'));
  market.installOfficial({...input,id:'shared-object-fixture'});
  market.installOfficial({...input,files:{...input.files,'fixture.gd':replacement}});
  market.installOfficial({...input,id:'shared-object-fixture',files:{...input.files,'fixture.gd':replacement}});
  const orphan=market.archive.put(Buffer.from('Unreferenced upload that still occupies disk.'));
  const expectedCurrent=f.image.size+replacement.size,expectedAll=expectedCurrent+original.size;
  await f.service.admin.market.scan({force:true});
  let page=await f.request('GET','/admin/market',f.owner),storage=page.storage;
  assert.equal(storage.status,'ready');assert.ok(storage.sampled_at);assert.ok(storage.disk.total_bytes>0);assert.ok(storage.disk.available_bytes>=0);
  assert.equal(storage.current.bytes,expectedCurrent);assert.equal(storage.historical_only.bytes,original.size);
  assert.equal(storage.referenced.bytes,expectedAll);assert.equal(storage.unreferenced.bytes,orphan.size);
  assert.equal(storage.market_objects.bytes,expectedAll+orphan.size,'Repeated asset and version references cannot multiply physical bytes');
  assert.equal(storage.sections.find(x=>x.key==='market').bytes,expectedAll+orphan.size);
  assert.equal(storage.total_bytes,storage.sections.reduce((n,s)=>n+s.bytes,0));
  assert.equal(storage.current.missing_files,0);assert.equal(storage.referenced.missing_files,0);
  const expectedAllocated=[f.image,original,replacement,orphan].reduce((n,e)=>n+statSync(market.archive.path(e.hash)).blocks*512,0);
  assert.equal(storage.market_objects.allocated_bytes,expectedAllocated);
  const row=page.items.find(x=>x.id===asset.id);assert.equal(row.storage.current.bytes,expectedCurrent);assert.equal(row.storage.all_versions.bytes,expectedAll);
  const imagePath=market.archive.path(f.image.hash),bytes=readFileSync(imagePath);unlinkSync(imagePath);
  await f.service.admin.market.scan({force:true});storage=(await f.request('GET','/admin/market',f.owner)).storage;
  assert.equal(storage.market_objects.bytes,expectedAll+orphan.size-f.image.size);assert.equal(storage.current.missing_files,1);assert.equal(storage.referenced.missing_files,1);
  assert.equal((await f.detail()).storage.current.missing_files,1);
  await f.request('GET',`/market/${asset.id}/versions/${asset.version}/files/cover.png`,null,undefined,409);
  writeFileSync(imagePath,bytes);
  const outside=join(f.data,'external-do-not-follow.bin');writeFileSync(outside,Buffer.alloc(8192));
  const link=join(market.archive.directory,'external-link');symlinkSync(outside,link);
  await f.service.admin.market.scan({force:true});storage=(await f.request('GET','/admin/market',f.owner)).storage;
  assert.equal(storage.status,'partial');assert.equal(storage.sections.find(x=>x.key==='market').bytes,expectedAll+orphan.size,'Storage inspection cannot follow an external symlink');
  assert.equal(storage.current.complete,false);assert.equal(storage.current.missing_files,null,'An incomplete scan must not assert completeness');
  unlinkSync(link);
});

test('official updates invalidate administrator versions for historical records without explicit governance metadata',async t=>{
  const f=await fixture(t),legacy=f.service.store.get('market_asset',f.asset.id);delete legacy.admin_version;f.service.store.put('market_asset',legacy);
  assert.equal((await f.detail()).version,1);
  f.service.market.installOfficial({...f.input,description:'Updated historical record'});
  assert.equal((await f.detail()).version,2);
  await f.request('PATCH',`/admin/market/${f.asset.id}`,f.owner,{request_id:uid('historical-stale'),expected_version:1,reason:'A stale view must conflict after official content update',status:'unlisted'},409);
});
