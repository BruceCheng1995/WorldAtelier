/** Actual HTTP + headless Chrome, with an explicitly synthetic HTML game.
 * Proves browser/transport/storage boundaries, never Godot startup or gameplay. */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {Evidence,IsolatedService,ORIGIN,request,delay,runtimeFetch} from './next-wave-test-support.mjs';
import {seedRuntimeFixture} from './next-wave-runtime-fixture.mjs';

const evidence=new Evidence('runtime-browser-independent',{layers:['A','B'],scope:'Original HTTP service, actual RuntimeAccess/GamePlay wrappers and Chrome origin/IDB boundaries. All exported Web bytes are explicit synthetic probes, NOT Godot.'});
const service=new IsolatedService(evidence,{worlds:false,agent:false,publicPlay:true});
const fixture=seedRuntimeFixture(service.creationData,{name:'browser-origin'});
service.settings.environment.WORLD_ATELIER_ADMIN_USER_ID=fixture.accounts.owner.user.id;
let browser,context,page,access,frame,wrapper,completed=false;
const runtimeRequests=[],headerChecks=[];
const accessRoute=`/creation-api/builds/${fixture.job.id}/access`;
const prefix='/userfs/godot/app_userdata/Independent origin fixture';
const domain={policy:'godot-idbfs-save-domain-1',database:'/userfs',prefix,project_id:fixture.project_id,branch_id:'main'};
try {
  await service.start();
  await evidence.check('I-HTTP-01','Actual API permits private viewer, rejects unpublished player and old cookie URL',['A'],async receipt=>{
    const owner=await request('POST',accessRoute,{actor:fixture.accounts.owner,body:{}});access=owner.value;
    receipt.launch={policy:access.policy,runtime_origin:access.runtime_origin,parent_origin:access.parent_origin,build_id:access.build_id};
    assert.notEqual(access.runtime_origin,ORIGIN);assert.equal(owner.headers.get('set-cookie'),null);
    await request('POST',accessRoute,{actor:fixture.accounts.viewer,body:{}});
    await request('POST',accessRoute,{actor:fixture.accounts.player,body:{},expected:[403,422]});
    const legacy=await fetch(`${ORIGIN}/creation-releases/${fixture.job.id}/web/index.html`,{headers:{cookie:`atelier_release=${fixture.legacyToken}`},redirect:'manual'});assert.equal(legacy.status,403);
    const runtimePage=await runtimeFetch(access.web_url);assert.equal(runtimePage.status,200);assert.equal(runtimePage.headers.get('referrer-policy'),'no-referrer');
    for(const path of ['/creation-api/bootstrap','/creation-api/admin/overview','/admin','/creation-workspace.html']){
      const denied=await runtimeFetch(access.runtime_origin+path,{headers:{authorization:'Bearer '+fixture.accounts.owner.token,cookie:'wa_admin=synthetic'}});assert.equal(denied.status,403,path);
    }
  });

  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
  evidence.report.versions.chrome=browser.version();
  context=await browser.newContext({viewport:{width:1280,height:900}});
  context.on('request',r=>{
    if(new URL(r.url()).origin!==access.runtime_origin)return;
    const check=r.allHeaders().then(headers=>runtimeRequests.push({path:new URL(r.url()).pathname.replace(/\/creation-runtime\/[^/]+\//,'/creation-runtime/[grant]/'),has_admin_cookie:/\bwa_admin=/.test(headers.cookie??''),has_creator_authorization:Boolean(headers.authorization)}));headerChecks.push(check);
  });
  page=await context.newPage();
  evidence.report.browser_console=[];evidence.report.browser_request_failures=[];
  page.on('console',message=>evidence.report.browser_console.push({type:message.type(),text:message.text()}));
  page.on('pageerror',error=>evidence.report.browser_console.push({type:'pageerror',text:error.message}));
  page.on('requestfailed',r=>evidence.report.browser_request_failures.push({url:r.url(),error:r.failure()?.errorText}));
  await page.goto(ORIGIN+'/creation-workspace.html#/games');
  await page.locator('#authName').fill(fixture.accounts.owner.credentials.name);await page.locator('#authPassword').fill(fixture.accounts.owner.credentials.password);await page.locator('#authSubmit').click();await page.locator('#landing').waitFor({state:'visible'});
  await page.evaluate(()=>{localStorage.setItem('next-wave-private-marker','isolated-creator-only');});
  const adminStatus=await page.evaluate(async()=>{const r=await fetch('/creation-api/admin/access',{method:'POST',headers:{Authorization:'Bearer '+sessionStorage.getItem('world-atelier-creator-token')}});return r.status;});assert.equal(adminStatus,200);
  assert.ok((await context.cookies()).some(cookie=>cookie.name==='wa_admin'&&cookie.domain==='127.0.0.1'));

  await evidence.check('I-BROWSER-01','Actual nested author frame cannot read creator DOM/storage or use administrator Cookie',['A','B'],async receipt=>{
    access=await page.evaluate(async route=>{const r=await fetch(route,{method:'POST',headers:{Authorization:'Bearer '+sessionStorage.getItem('world-atelier-creator-token'),'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw Error('Access failed '+r.status);return r.json();},accessRoute);
    await page.evaluate(async({job,access})=>{
      const {GamePlay}=await import('/game-play.js');const host=document.createElement('div');host.id='next-wave-probe-host';host.style.cssText='position:fixed;inset:100px 20px 20px;z-index:9999;background:#111';document.body.append(host);
      window.__nextWaveBridgeEvents=[];window.__nextWaveGame=new GamePlay(host,async()=>({job,url:access.web_url,access}),packet=>window.__nextWaveBridgeEvents.push({type:packet.type}));await window.__nextWaveGame.runtimeReady;
    },{job:fixture.job,access});
    await page.waitForFunction(()=>document.querySelector('#next-wave-probe-host iframe')?.src.includes('/creation-runtime/'));
    for(let i=0;i<100;i++){frame=page.frames().find(f=>f.url().includes('/web/index.html'));if(frame)break;await delay(50);}
    if(!frame)receipt.frame_urls=page.frames().map(f=>f.url());
    assert.ok(frame);await frame.waitForFunction(()=>window.__nextWaveThinProbe?.completed);
    const result=await frame.evaluate(()=>window.__nextWaveThinProbe);receipt.probe=result;assert.equal(result.secure_context,true,'Loopback runtime must preserve real browser secure-context capabilities.');
    for(const key of ['creator_dom','creator_session','creator_local'])assert.equal(result[key].readable,false,key);
    assert.equal(result.own_session.present,false);assert.equal(result.runtime_api.status,403);assert.equal(result.runtime_admin.status,403);assert.equal(result.creator_admin.readable,false);
    assert.equal(result.runtime_wrapper_readable,true,'The test must acknowledge that author and runtime shell share an origin.');
    await Promise.all(headerChecks);assert.equal(runtimeRequests.some(r=>r.has_admin_cookie||r.has_creator_authorization),false);
    receipt.runtime_requests=runtimeRequests;await page.screenshot({path:evidence.directory+'/origin-probe.png'});
  });

  await evidence.check('I-BROWSER-02','Compromised same-runtime shell cannot turn forbidden messages into creator actions',['B'],async receipt=>{
    wrapper=page.frames().find(f=>f.url().includes('/launch.html'));assert.ok(wrapper);
    await wrapper.waitForFunction(()=>window.__nextWaveWrapperCompromised===true);
    await delay(150);const events=await page.evaluate(()=>window.__nextWaveBridgeEvents);
    assert.deepEqual(events,[],'Creator-side bridge must reject history/transform/fetch even when the runtime wrapper sends them.');
    receipt.wrapper_compromised=true;receipt.accepted_forbidden_events=events;
  });

  await evidence.check('S-BROWSER-01','Real IndexedDB import is prefix-bound, idempotent and atomically refuses conflicts',['B'],async receipt=>{
    const result=await wrapper.evaluate(async domain=>{
      const storage=await import(new URL('storage.js',location.href));const mode=0o100666,now=new Date();
      const packet={format:'wa-godot-save-transfer-1',prefix:domain.prefix,entries:[{key:domain.prefix,value:{mode:0o40777,timestamp:now}},{key:domain.prefix+'/progress.dat',value:{mode,timestamp:now,contents:new Uint8Array([1,2,3])}}]};
      const first=await storage.importSaveDomain(domain,packet),replay=await storage.importSaveDomain(domain,packet),negative=[];
      for(const key of ['/userfs/another-game/secret','/userfs/godot/app_userdata/../secret',domain.prefix+'//bad']){
        try{await storage.importSaveDomain(domain,{...packet,entries:[{key,value:{mode,timestamp:now,contents:new Uint8Array([9])}}]});negative.push({key,rejected:false});}catch(error){negative.push({key,rejected:true});}
      }
      let conflictRejected=false;
      try{await storage.importSaveDomain(domain,{...packet,entries:[{key:domain.prefix+'/partial.dat',value:{mode,timestamp:now,contents:new Uint8Array([4])}},{key:domain.prefix+'/progress.dat',value:{mode,timestamp:now,contents:new Uint8Array([9])}}]});}catch{conflictRejected=true;}
      const after=await storage.readSaveDomain(domain);
      return{first,replay,negative,conflictRejected,after:{available:after.available,entries:after.entries.map(row=>({key:row.key,mode:row.value.mode,bytes:row.value.contents?Array.from(row.value.contents):null}))}};
    },domain);
    assert.equal(result.first.imported,2);assert.equal(result.replay.imported,0);assert.ok(result.negative.every(v=>v.rejected));assert.equal(result.conflictRejected,true);
    assert.equal(result.after.entries.some(row=>row.key.endsWith('/partial.dat')),false);assert.deepEqual(result.after.entries.find(row=>row.key.endsWith('/progress.dat')).bytes,[1,2,3]);receipt.result=result;
  });

  await evidence.check('S-BROWSER-03','Signed nonzero-offset Godot byte views remain exact and unknown file formats fail explicitly',['B'],async receipt=>{
    const result=await wrapper.evaluate(async domain=>{
      const storage=await import(new URL('storage.js',location.href)),now=new Date(),mode=0o100666;
      const open=()=>new Promise((done,reject)=>{const r=indexedDB.open(domain.database);r.onsuccess=()=>done(r.result);r.onerror=()=>reject(r.error);});
      const write=async(key,value)=>{const db=await open();try{await new Promise((done,reject)=>{const tx=db.transaction('FILE_DATA','readwrite');value===null?tx.objectStore('FILE_DATA').delete(key):tx.objectStore('FILE_DATA').put(value,key);tx.oncomplete=done;tx.onerror=()=>reject(tx.error);});}finally{db.close();}};
      const buffer=new Uint8Array([11,128,255,0,127,22]).buffer,signed=new Int8Array(buffer,1,4),key=domain.prefix+'/signed-view.dat',unknown=domain.prefix+'/unsupported-format.dat';
      // These are explicit byte-format fixtures in the thin-browser layer,
      // independent of the separate real Godot storage journey.
      await write(key,{mode,timestamp:now,contents:signed});
      const read=await storage.readSaveDomain(domain),entry=read.entries.find(row=>row.key===key),serialized=JSON.parse(storage.serializeSave(domain,[entry]));
      const replay=await storage.importSaveDomain(domain,{format:'wa-godot-save-transfer-1',prefix:domain.prefix,entries:[{key,value:{mode,timestamp:now,contents:signed}}]});
      await write(unknown,{mode,timestamp:now,contents:{unsupported:true}});let error=null;try{await storage.readSaveDomain(domain);}catch(reason){error=reason.message;}
      const db=await open();let stillPresent;try{stillPresent=await new Promise((done,reject)=>{const r=db.transaction('FILE_DATA','readonly').objectStore('FILE_DATA').get(unknown);r.onsuccess=()=>done(r.result?.contents?.unsupported===true);r.onerror=()=>reject(r.error);});}finally{db.close();}
      await write(unknown,null);
      return {signed_values:Array.from(signed),byte_offset:signed.byteOffset,bytes:Array.from(entry.value.contents),export_base64:serialized.entries[0].value.base64,replay,unknown_error:error,unknown_original_retained:stillPresent};
    },domain);
    assert.deepEqual(result.signed_values,[-128,-1,0,127]);assert.equal(result.byte_offset,1);assert.deepEqual(result.bytes,[128,255,0,127]);assert.deepEqual(Buffer.from(result.export_base64,'base64'),Buffer.from([128,255,0,127]));assert.equal(result.replay.imported,0);assert.equal(result.replay.already_present,1);assert.ok(result.unknown_error);assert.equal(result.unknown_original_retained,true);receipt.result=result;
  });

  await evidence.check('S-BROWSER-02','Actual standalone migration UI preserves the old IDB data and clears copied creator sessionStorage',['A','B'],async receipt=>{
    await page.evaluate(async domain=>{
      const storage=await import('/runtime-storage.js'),now=new Date(),mode=0o100666;
      await storage.importSaveDomain(domain,{format:'wa-godot-save-transfer-1',prefix:domain.prefix,entries:[{key:domain.prefix,value:{mode:0o40777,timestamp:now}},{key:domain.prefix+'/progress.dat',value:{mode,timestamp:now,contents:new Uint8Array([1,2,3])}},{key:domain.prefix+'/migration-proof.dat',value:{mode,timestamp:now,contents:new Uint8Array([7,8,9])}}]});
    },domain);
    await page.evaluate(async({jobId})=>{
      const module=await import('/runtime-access.js'),button=document.createElement('button');button.id='next-wave-standalone';button.textContent='Open isolated standalone';button.style.cssText='position:fixed;top:20px;left:20px;z-index:10000';document.body.append(button);
      button.onclick=async()=>{
        const popup=module.openRuntimePlaceholder('Independent storage migration');window.__nextWavePopup=popup;
        window.__nextWavePopupBefore={creator_token:popup.sessionStorage.getItem('world-atelier-creator-token'),opener_present:popup.opener!==null};
        const r=await fetch('/creation-api/builds/'+jobId+'/access',{method:'POST',headers:{Authorization:'Bearer '+sessionStorage.getItem('world-atelier-creator-token'),'Content-Type':'application/json'},body:'{}'});
        const access=await r.json();try{window.__nextWaveNavigateResult=await module.navigateStandaloneRuntime(popup,access);}catch(error){window.__nextWaveNavigateError=error.message;}
      };
    },{jobId:fixture.job.id});
    const popupPromise=page.waitForEvent('popup');await page.locator('#next-wave-standalone').click();const popup=await popupPromise;
    await popup.getByRole('button',{name:'迁移存档并打开',exact:true}).waitFor();await popup.screenshot({path:evidence.directory+'/migration-choice.png'});
    assert.deepEqual(await page.evaluate(()=>window.__nextWavePopupBefore),{creator_token:null,opener_present:false});
    await popup.getByRole('button',{name:'迁移存档并打开',exact:true}).click();
    await popup.waitForURL(url=>url.origin===access.runtime_origin,{timeout:30000});
    const destination=await popup.evaluate(async domain=>{const storage=await import(new URL('storage.js',location.href)),value=await storage.readSaveDomain(domain);return{opener:opener!==null,own_token:sessionStorage.getItem('world-atelier-creator-token'),keys:value.entries.map(row=>row.key),bytes:Array.from(value.entries.find(row=>row.key.endsWith('/migration-proof.dat')).value.contents)};},domain);
    const old=await page.evaluate(async domain=>{const storage=await import('/runtime-storage.js'),value=await storage.readSaveDomain(domain);return Array.from(value.entries.find(row=>row.key.endsWith('/migration-proof.dat')).value.contents);},domain);
    assert.equal(destination.opener,false);assert.equal(destination.own_token,null);assert.deepEqual(destination.bytes,[7,8,9]);assert.deepEqual(old,[7,8,9]);receipt.destination=destination;receipt.original_bytes_retained=old;
    await popup.close();
  });

  await evidence.check('I-HTTP-02','Real browser logout invalidates the existing launch grant',['A','B'],async receipt=>{
    const status=await page.evaluate(async()=>{const r=await fetch('/creation-api/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+sessionStorage.getItem('world-atelier-creator-token')}});return r.status;});assert.equal(status,200);
    const resource=await runtimeFetch(access.web_url);assert.equal(resource.status,403);receipt.logged_out_status=status;receipt.old_launch_status=resource.status;
  });
  completed=true;
} catch(error) {
  evidence.report.errors.push({message:error.message,stack:error.stack});process.exitCode=1;
  if(page&&!page.isClosed())await page.screenshot({path:evidence.directory+'/failure.png'}).catch(()=>{});
  console.error(error.stack);
} finally {
  await browser?.close();await Promise.allSettled(headerChecks);
  try{await service.stop();service.removeData();}catch(error){evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;}
  evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);
}
