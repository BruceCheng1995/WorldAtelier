/** Development-authored acceptance candidate. Independent reviewer must inspect
 * and execute it before reporting independent results. Actual canonical Godot
 * writes user:// through ordinary authored key inputs; no IDB writes or runtime
 * success ACKs are injected by this driver. Test-only browser routing serves
 * the exact immutable Web bytes at the former creator origin to create a real
 * legacy save. No product route or archived build is altered. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from '@playwright/test';
import {Evidence,IsolatedService,ROOT,ORIGIN,PORT,request,registerActor,waitFor,delay,sha256} from './next-wave-test-support.mjs';
import {nextWaveAuthorFiles,nativeImportFiles} from './next-wave-author-fixture.mjs';

const evidence=new Evidence('standalone-lan-candidate',{layers:['A','G','B'],scope:'Developer-authored candidate for independent review: actual Godot user:// saves, explicit legacy migration/export, standalone refresh/version continuity, embedded reset, and actual LAN runtime origin.'});
evidence.report.authorship='development integration role; execution/review attribution must be recorded independently';
const service=new IsolatedService(evidence,{agent:false,worlds:false,lan:true});
let browser,context,creator,legacy,popup,lanPage,lanPopup,actor,project,route,source,job,access,complete=false;
const pages=new Map(),files=nextWaveAuthorFiles();
// These extra ordinary keys expose the fixture's existing authored save/load
// buttons to deterministic browser keyboard input. They do not alter outcomes.
files.set('scripts/main.gd',Buffer.from(files.get('scripts/main.gd').toString().replace(
  '\tif event.physical_keycode == KEY_E: interact("local", {})',
  '\tif event.physical_keycode == KEY_E: interact("local", {})\n\tif event.physical_keycode == KEY_S: save_progress()\n\tif event.physical_keycode == KEY_L: load_progress()')));

function observe(page,label){
  if(pages.has(page))return pages.get(page);
  const logs=[];pages.set(page,{label,logs});
  page.on('console',message=>logs.push({type:message.type(),text:message.text(),at:Date.now()}));
  page.on('pageerror',error=>logs.push({type:'pageerror',text:error.message,at:Date.now()}));
  return pages.get(page);
}
const messages=page=>pages.get(page)?.logs??[];
async function frame(page){return waitFor('actual game frame',()=>page.frames().find(value=>value.url().includes('/web/index.html')||value.url().includes('/__next-wave-legacy/index.html')),{timeout:150000,interval:250});}
async function ready(page,after=0){await waitFor('actual STANDALONE_READY',()=>messages(page).slice(after).find(row=>row.text.startsWith('STANDALONE_READY ')),{timeout:150000,interval:250});const game=await frame(page);await game.locator('canvas').waitFor({state:'visible'});return game;}
async function key(page,value,expected){
  const start=messages(page).length,game=await frame(page),canvas=game.locator('canvas');
  await canvas.focus();await canvas.press(value);
  return waitFor('authored input effect '+value,()=>messages(page).slice(start).find(row=>expected.test(row.text)),{timeout:15000,interval:100});
}
async function saveRows(page,domain){
  return page.evaluate(async domain=>{
    const {readSaveDomain}=await import('/runtime-storage.js');const record=await readSaveDomain(domain);
    return {available:record.available,reason:record.reason,entries:record.entries.map(row=>({key:row.key,mode:row.value.mode,bytes:row.value.contents?Array.from(row.value.contents):null}))};
  },domain);
}
function saved(rows){const entry=rows.entries.find(row=>row.key.endsWith('/next-wave-progress.json'));return entry&&entry.bytes?{entry,value:JSON.parse(Buffer.from(entry.bytes).toString())}:null;}
async function inspectActualIDB(page,domain){
  return page.evaluate(async domain=>{
    const db=await new Promise((done,reject)=>{const r=indexedDB.open(domain.database);r.onsuccess=()=>done(r.result);r.onerror=()=>reject(r.error);});
    try{return await new Promise((done,reject)=>{const tx=db.transaction('FILE_DATA','readonly'),request=tx.objectStore('FILE_DATA').openCursor(),rows=[];request.onsuccess=()=>{const row=request.result;if(!row)return;const value=row.value;if(String(row.key).startsWith(domain.prefix))rows.push({key:row.key,mode:value.mode,fields:Object.keys(value),contents_type:Object.prototype.toString.call(value.contents),contents_constructor:value.contents?.constructor?.name,is_array:Array.isArray(value.contents),is_u8:value.contents instanceof Uint8Array,is_buffer:value.contents instanceof ArrayBuffer,contents_length:value.contents?.length,contents_bytes:value.contents?.byteLength});row.continue();};tx.oncomplete=()=>done(rows);tx.onerror=()=>reject(tx.error);});}finally{db.close();}
  },domain);
}
async function prepare(head){
  const prepared=(await request('POST',route+'/play-build',{actor,body:{request_id:randomUUID(),source_revision:head,entry_scene_id:'journey-a'},expected:202,timeout:120000})).value;
  return waitFor('actual fixed Web build',async()=>{const value=(await request('GET','/creation-api/builds/'+prepared.job.id,{actor})).value.job;if(['failed','interrupted'].includes(value.status))throw Error(value.error??value.stage);return value.status==='completed'&&value;},{timeout:240000,interval:500});
}
async function login(page,origin){
  await page.goto(origin+'/creation-workspace.html#/games');
  await waitFor('original authentication or landing view',async()=>await page.locator('#authName').isVisible()||await page.locator('#landing').isVisible(),{timeout:30000});
  if(await page.locator('#authName').isVisible()){await page.locator('#authName').fill(actor.credentials.name);await page.locator('#authPassword').fill(actor.credentials.password);await page.locator('#authSubmit').click();}
  await page.locator('#landing').waitFor({state:'visible'});
  await page.locator(`[data-quick-game="${project.id}"][data-quick-branch="main"]`).click();await page.locator('#workbench').waitFor({state:'visible'});
}
async function openStandalone(page,label){
  if(!await page.locator('#viewportMore').evaluate(element=>element.open))await page.locator('#viewportMore summary').click();
  const opened=context.waitForEvent('page');await page.locator('#playWebButton').click();const result=await opened;observe(result,label);
  // The original launch action keeps the build-history dialog open while its
  // popup runs independently. Dismiss it through the normal visible control.
  if(await page.locator('#releaseBuildDialog').evaluate(element=>element.open))await page.getByRole('button',{name:'关闭导出与打包',exact:true}).click();
  return result;
}
async function check(id,text,fn){console.log('NEXT_WAVE_CASE_START '+id+' '+text);await evidence.check(id,text,['A','G','B'],fn);console.log('NEXT_WAVE_CASE_PASS '+id);}

try{
  await service.start();actor=await registerActor('standalone-lan');
  await check('SL01','Build a real canonical native game with ordinary authored save/load controls',async receipt=>{
    const created=(await request('POST','/creation-api/projects',{actor,body:{name:'Independent storage journey '+randomUUID().slice(0,6),template:'empty'},expected:201,timeout:120000})).value;
    project=created.project;route=`/creation-api/projects/${project.id}/branches/main`;
    source=(await request('POST',route+'/transactions',{actor,body:{transaction_id:randomUUID(),base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:nativeImportFiles(files)}]},timeout:120000})).value;
    job=await prepare(source.revision);access=(await request('POST','/creation-api/builds/'+job.id+'/access',{actor,body:{}})).value;
    assert.ok(access.storage?.prefix);evidence.json('storage-fixed-build.json',job);receipt.project_id=project.id;receipt.source_revision=source.revision;receipt.build_id=job.id;receipt.storage=access.storage;
  });
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio','--enable-unsafe-swiftshader']});context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
  context.on('page',page=>observe(page,'page-'+pages.size));
  evidence.report.versions.chrome=browser.version();
  const database=new DatabaseSync(join(service.creationData,'creation.sqlite'),{readOnly:true});
  let fixedJob;try{fixedJob=JSON.parse(database.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get('creator_build',job.id).body);}finally{database.close();}
  assert.equal(fixedJob.status,'completed');assert.equal(fixedJob.canonical_identity,job.canonical_identity);
  const webRoot=join(service.creationData,'builds',job.id,'web'),fixedFiles=new Map(fixedJob.web_files.map(file=>[file.path,file]));
  evidence.json('actual-fixed-web-inventory.json',fixedJob.web_files);
  await context.route(ORIGIN+'/__next-wave-legacy/**',async intercepted=>{
    const path=decodeURIComponent(new URL(intercepted.request().url()).pathname.slice('/__next-wave-legacy/'.length)),entry=fixedFiles.get(path);
    if(!entry){await intercepted.abort();return;}
    const bytes=readFileSync(join(webRoot,path));assert.equal(sha256(bytes),entry.sha256);
    const type=path.endsWith('.html')?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.wasm')?'application/wasm':'application/octet-stream';
    await intercepted.fulfill({status:200,contentType:type,body:bytes});
  });
  let originalSave;
  await check('SL02','Actual legacy-origin Godot inputs create a persisted user:// save without driver IDB writes',async receipt=>{
    legacy=await context.newPage();observe(legacy,'legacy-real-game');await legacy.goto(ORIGIN+'/__next-wave-legacy/index.html');await ready(legacy);
    for(let count=1;count<=4;count++)await key(legacy,'e',new RegExp('NW_AUTHOR_INTERACTION.*attempts='+count+'(?: |$)'));
    await key(legacy,'s',/NW_AUTHOR_SAVED clicks=4/);
    originalSave=await waitFor('Godot flushed real legacy IDBFS',async()=>{const rows=await saveRows(legacy,access.storage);evidence.json('actual-legacy-storage-read.json',rows);evidence.json('actual-legacy-idb-types.json',await inspectActualIDB(legacy,access.storage));const result=saved(rows);return result?.value.attempts===4&&result;},{timeout:30000,interval:500});
    receipt.attempts=originalSave.value.attempts;receipt.file_key=originalSave.entry.key;receipt.sha256=sha256(Buffer.from(originalSave.entry.bytes));receipt.source='actual FileAccess write from authored S input';
    await legacy.screenshot({path:join(evidence.directory,'legacy-real-save.png')});await legacy.close();
  });
  await check('SL03','Original new-page UI explicitly exports and migrates the genuine legacy save; old bytes stay intact',async receipt=>{
    creator=await context.newPage();observe(creator,'creator');await login(creator,ORIGIN);popup=await openStandalone(creator,'migrated-standalone');
    await popup.getByRole('button',{name:'迁移存档并打开',exact:true}).waitFor({state:'visible',timeout:180000});
    const downloadPromise=popup.waitForEvent('download');await popup.getByRole('button',{name:'导出旧存档备份',exact:true}).click();const download=await downloadPromise;
    const exportedPath=join(evidence.directory,'actual-legacy-save-export.json');await download.saveAs(exportedPath);
    const exported=JSON.parse(readFileSync(exportedPath)),file=exported.entries.find(row=>row.key===originalSave.entry.key);assert.deepEqual(Buffer.from(file.value.base64,'base64'),Buffer.from(originalSave.entry.bytes));
    await popup.getByRole('button',{name:'迁移存档并打开',exact:true}).click();await ready(popup);
    assert.notEqual(new URL(popup.url()).origin,ORIGIN);assert.equal(await popup.evaluate(()=>opener===null),true);
    const game=await frame(popup);assert.equal(await game.evaluate(()=>sessionStorage.getItem('world-atelier-creator-token')===null),true);
    await key(popup,'l',/NW_AUTHOR_LOADED clicks=4/);
    const old=saved(await saveRows(creator,access.storage));assert.deepEqual(old.entry.bytes,originalSave.entry.bytes);
    receipt.runtime_origin=new URL(popup.url()).origin;receipt.restored_attempts=4;receipt.original_save_sha256=sha256(Buffer.from(old.entry.bytes));receipt.export_sha256=sha256(readFileSync(exportedPath));
    await popup.screenshot({path:join(evidence.directory,'migrated-real-save.png')});
  });
  await check('SL04','Standalone saves survive refresh while embedded Play starts with a separate memory-only user://',async receipt=>{
    await key(popup,'e',/NW_AUTHOR_INTERACTION.*attempts=5(?: |$)/);await key(popup,'s',/NW_AUTHOR_SAVED clicks=5/);
    // Storage reads are evidence only. The isolated shell serves the same
    // bounded read module as storage.js; the driver never writes the database.
    await waitFor('isolated Godot save flush',async()=>{
      return popup.evaluate(async domain=>{const {readSaveDomain}=await import(new URL('storage.js',location.href).href);const r=await readSaveDomain(domain);const file=r.entries.find(row=>row.key.endsWith('/next-wave-progress.json'));return file&&JSON.parse(new TextDecoder().decode(file.value.contents)).attempts===5;},access.storage);
    },{timeout:30000,interval:500});
    const start=messages(popup).length;await popup.reload();await ready(popup,start);await key(popup,'l',/NW_AUTHOR_LOADED clicks=5/);
    await creator.locator('[data-mode="play"]').click();await waitFor('embedded play UI',()=>creator.locator('#stage').getAttribute('data-preview-mode').then(value=>value==='play'),{timeout:240000,interval:500});
    await key(creator,'l',/NW_AUTHOR_NO_SAVE/);await key(creator,'e',/NW_AUTHOR_INTERACTION.*attempts=1(?: |$)/);
    receipt.standalone_refreshed_attempts=5;receipt.embedded_no_save=true;receipt.embedded_first_interaction=1;
    await creator.screenshot({path:join(evidence.directory,'embedded-independent-initial-state.png')});
  });
  await check('SL05','An explicit source version change keeps the stable standalone save domain',async receipt=>{
    const head=(await request('GET',route,{actor})).value.head;
    files.set('scripts/main.gd',Buffer.from(files.get('scripts/main.gd').toString()+'\n# Storage-continuity version change; authored behavior unchanged.\n'));
    const update=(await request('POST',route+'/transactions',{actor,body:{transaction_id:randomUUID(),base_revision:head,expected_head:head,ops:[{type:'import_native_project',files:nativeImportFiles(files)}]},timeout:120000})).value;
    const upgraded=await prepare(update.revision),nextAccess=(await request('POST','/creation-api/builds/'+upgraded.id+'/access',{actor,body:{}})).value;assert.notEqual(upgraded.id,job.id);assert.equal(nextAccess.storage.prefix,access.storage.prefix);
    await popup.close();await login(creator,ORIGIN);popup=await openStandalone(creator,'version-upgraded-standalone');await ready(popup);await key(popup,'l',/NW_AUTHOR_LOADED clicks=5/);
    receipt.old_build=job.id;receipt.new_build=upgraded.id;receipt.source_revision=update.revision;receipt.restored_attempts=5;receipt.storage_prefix=nextAccess.storage.prefix;
    job=upgraded;source=update;evidence.json('storage-upgraded-build.json',job);
  });
  await check('SL06','Actual LAN creator address opens an isolated mapped-IP Godot game and real input works',async receipt=>{
    const ips=Object.entries(networkInterfaces()).filter(([name])=>! /^(utun|tun|tap)/.test(name)).flatMap(([,rows])=>rows.filter(row=>row.family==='IPv4'&&!row.internal).map(row=>row.address));
    assert.ok(ips.length,'No actual LAN IPv4 interface; this gate is not passed without it');const origin='http://'+ips[0]+':'+PORT;
    lanPage=await context.newPage();observe(lanPage,'lan-creator');await login(lanPage,origin);lanPopup=await openStandalone(lanPage,'lan-runtime');await ready(lanPopup);
    const runtimeOrigin=new URL(lanPopup.url()).origin;assert.notEqual(runtimeOrigin,origin);assert.match(new URL(runtimeOrigin).hostname,/^\[::ffff:/);
    const game=await frame(lanPopup);await key(lanPopup,'e',/NW_AUTHOR_INTERACTION.*attempts=1(?: |$)/);
    const boundary=await game.evaluate(async creatorOrigin=>{
      let readable;try{const result=await fetch(creatorOrigin+'/creation-api/admin/overview',{credentials:'include'});readable={readable:true,status:result.status};}catch(error){readable={readable:false,error:error.name};}
      return {origin:location.origin,secure_context:isSecureContext,creator_token_present:!!sessionStorage.getItem('world-atelier-creator-token'),creator_admin:readable};
    },origin);
    assert.equal(boundary.creator_token_present,false);assert.equal(boundary.creator_admin.readable,false);
    receipt.creator_origin=origin;receipt.runtime_origin=runtimeOrigin;receipt.boundary=boundary;receipt.build_id=job.id;receipt.actual_interactions=1;receipt.scope='Actual LAN interface on this host; no claim of a separate physical client device';
    await lanPopup.screenshot({path:join(evidence.directory,'actual-lan-godot.png')});
  });
  complete=true;
}catch(error){evidence.report.errors.push({message:error.message,stack:error.stack});process.exitCode=1;console.error(error.stack);}
finally{
  for(const [page,record]of pages){evidence.json(record.label.replace(/[^a-z0-9-]/gi,'-')+'-console.json',record.logs);if(!page.isClosed())await page.screenshot({path:join(evidence.directory,record.label.replace(/[^a-z0-9-]/gi,'-')+'-final.png')}).catch(()=>{});}
  await browser?.close();try{await service.stop();}catch(error){evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;}
  evidence.report.retained_test_data=service.data;evidence.finish({completed:complete});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);
}
