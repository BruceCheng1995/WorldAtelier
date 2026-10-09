/** Independent real Chrome/Godot thumbnail regression on actual LAN HTTP.
 * The account, source edits, SQLite, service port and browser context are disposable.
 * This checks rendered thumbnails and their cache, not shared-world gameplay.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,networkInterfaces} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from '@playwright/test';

const root=resolve(import.meta.dirname,'../..');
const data=mkdtempSync(resolve(tmpdir(),'atelier-prefab-thumbnail-lan-'));
const evidence=resolve(root,'.local/creation-verification/prefab-thumbnail-lan',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(evidence,{recursive:true});
const address=Object.entries(networkInterfaces()).filter(([name])=>!/^utun|lo|bridge|tun|tap/.test(name)).flatMap(([,rows])=>rows).find(row=>row.family==='IPv4'&&!row.internal)?.address;
assert.ok(address,'Actual LAN IPv4 is required; localhost does not test insecure HTTP');
const probe=createServer();await new Promise((ok,no)=>{probe.once('error',no);probe.listen(0,'0.0.0.0',ok);});const port=probe.address().port;await new Promise(ok=>probe.close(ok));
const origin=`http://${address}:${port}`,wait=ms=>new Promise(ok=>setTimeout(ok,ms));
const sources=['apps/creation-workspace/prefab-preview.html','apps/creation-workspace/preview-bridge.js','apps/creation-workspace/workspace.js'];
const hashes=()=>Object.fromEntries(sources.map(file=>[file,createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex')]));
const report={origin,scope:'Actual LAN HTTP on host NIC, Chrome WebGL/Godot pixels and browser localStorage. No second physical computer or gameplay claim.',source_hashes:hashes(),cases:[],completed:false};
let child,browser,page,serverLog='',auth;
async function api(method,path,body){const response=await fetch(origin+'/creation-api'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();assert.ok(response.ok,JSON.stringify({status:response.status,result}));return result;}
async function check(name,run){const detail=await run();report.cases.push({name,status:'passed',...detail});console.log('PASS '+name);}
try{
  child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env:{...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:resolve(data,'preview'),WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_LAN:'1',WORLD_ATELIER_PUBLIC_PLAY:'1'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>serverLog+=b);child.stderr.on('data',b=>serverLog+=b);
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(serverLog);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  auth=await api('POST','/auth/register',{name:'缩略图隔离检查员 '+randomUUID(),password:randomUUID()});
  const fixture=await api('POST','/projects',{name:'局域网预制件缩略图验证',template:'harbor'}),project=fixture.project.id;
  report.project_id=project;report.source_revision=fixture.branch.head;report.user_id=auth.user.id;
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(token=>sessionStorage.setItem('world-atelier-creator-token',token),auth.token);
  page=await context.newPage();const requests=[],errors=[];
  page.on('request',request=>requests.push(request.url()));page.on('pageerror',error=>errors.push(error.message));report.page_errors=errors;
  const url=origin+'/creation-workspace.html#/games/'+project+'/branches/main';
  async function catalog(){
    await page.locator('[data-explorer="prefabs"]').click();
    const cards=page.locator('[data-thumbnail-key]');assert.equal(await cards.count(),6);
    for(let i=0;i<6;i++){await cards.nth(i).scrollIntoViewIfNeeded();await cards.nth(i).and(page.locator('[data-preview-state="ready"]')).waitFor({timeout:75000});}
    await page.locator('[data-resource="pf-beacon"]').scrollIntoViewIfNeeded();await page.locator('[data-resource="pf-beacon"] img').evaluate(img=>img.decode());
  }
  const picture=()=>page.locator('[data-resource="pf-beacon"]');
  let firstURL,firstKey;
  await check('LAN HTTP renders actual prefab pixels and stores a versioned JPEG',async()=>{
    await page.goto(url);assert.equal(await page.evaluate(()=>isSecureContext),false);await catalog();
    firstURL=await picture().locator('img').getAttribute('src');firstKey=await picture().getAttribute('data-thumbnail-key');assert.match(firstURL,/^data:image\/jpeg;base64,/);
    const pixels=await picture().locator('img').evaluate(img=>{const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const bytes=ctx.getImageData(0,0,canvas.width,canvas.height).data,colors=new Set();let bright=0;for(let i=0;i<bytes.length;i+=4){colors.add([bytes[i]>>4,bytes[i+1]>>4,bytes[i+2]>>4].join(','));if(bytes[i]+bytes[i+1]+bytes[i+2]>180)bright++;}return {width:canvas.width,height:canvas.height,quantized_colors:colors.size,bright_pixels:bright};});
    assert.equal(pixels.width,384);assert.equal(pixels.height,288);assert.ok(pixels.quantized_colors>30,JSON.stringify(pixels));assert.ok(pixels.bright_pixels>300,JSON.stringify(pixels));
    const rows=await page.evaluate(()=>JSON.parse(localStorage.getItem('wa-prefab-images-v1')||'[]'));assert.ok(rows.some(row=>row.url===firstURL&&row.key.includes(auth.user.id)));
    await page.screenshot({path:resolve(evidence,'lan-prefab-cold.png')});await picture().screenshot({path:resolve(evidence,'beacon-cold.png')});return {pixels,cache_rows:rows.length,thumbnail_key:firstKey};
  });
  await check('refresh authorizes exact source then reuses JPEG without a thumbnail engine',async()=>{
    const start=requests.length;await page.reload();await catalog();assert.equal(await picture().locator('img').getAttribute('src'),firstURL);
    const recent=requests.slice(start);report.refresh_requests=recent;report.refresh_cache=await page.evaluate(()=>JSON.parse(localStorage.getItem('wa-prefab-images-v1')||'[]').map(({key})=>key));assert.ok(recent.some(url=>url.includes('runtime-scene?resource_id=pf-beacon')),'A cache hit still reads authorized source');assert.equal(recent.filter(url=>url.includes('/prefab-preview.html')).length,0);
    await page.screenshot({path:resolve(evidence,'lan-prefab-cached.png')});return {thumbnail_engine_requests:0,authorized_source_requests:recent.filter(url=>url.includes('runtime-scene?resource_id=pf-beacon')).length};
  });
  await check('actual source transaction invalidates cached key and changes rendered pixels',async()=>{
    const before=await api('GET',`/projects/${project}/branches/main`),resource=before.manifest.resources['pf-beacon'],object=resource.objects[0],start=requests.length;
    const changed=await api('POST',`/projects/${project}/branches/main/transactions`,{transaction_id:randomUUID(),base_revision:before.head,ops:[{type:'patch_object',resource_id:'pf-beacon',object_id:object.id,expected_version:object.version,patch:{rotation:[0,65,0],color:'#ed552e'}}]});
    assert.notEqual(changed.revision,before.head);
    await page.waitForFunction(old=>document.querySelector('[data-resource="pf-beacon"]')?.dataset.thumbnailKey!==old,firstKey);
    await picture().and(page.locator('[data-preview-state="ready"]')).waitFor({timeout:75000});await picture().locator('img').evaluate(img=>img.decode());
    const nextKey=await picture().getAttribute('data-thumbnail-key'),nextURL=await picture().locator('img').getAttribute('src');assert.notEqual(nextKey,firstKey);assert.notEqual(nextURL,firstURL);assert.ok(requests.slice(start).some(url=>url.includes('/prefab-preview.html')));
    await picture().screenshot({path:resolve(evidence,'beacon-changed.png')});return {old_revision:before.head,new_revision:changed.revision,thumbnail_key:nextKey};
  });
  assert.deepEqual(errors,[]);report.completed=true;
}catch(error){report.error=error.stack;if(page){report.visible_text=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});}throw error;}
finally{
  await browser?.close();if(child&&child.exitCode===null){const exited=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);await exited;clearTimeout(timer);}
  rmSync(data,{recursive:true,force:true});report.temporary_data_removed=true;report.source_hashes_after=hashes();report.source_changed_during_run=sources.filter(file=>report.source_hashes[file]!==report.source_hashes_after[file]);report.finished_at=new Date().toISOString();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));writeFileSync(resolve(evidence,'server.log'),serverLog);console.log('BROWSER_REPORT '+resolve(evidence,'report.json'));
}
