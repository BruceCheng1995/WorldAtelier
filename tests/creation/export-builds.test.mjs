/** Independent integration acceptance for creation exports and application builds.
 * Real HTTP service, private temporary state, actual Godot processes and Chromium.
 * No production mutation, injected success rows, fabricated runtime ACKs, or
 * platform launch claims for platforms unavailable on this host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, relative, extname} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {chromium} from '@playwright/test';

const root=resolve(import.meta.dirname,'../..'),port=Number(process.env.WORLD_ATELIER_EXPORT_TEST_PORT??48921),origin=`http://127.0.0.1:${port}`;
assert.ok(Number.isInteger(port)&&port>1024&&port<65536&&![48900,48910].includes(port),'use an explicit isolated test port');
const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const uid=prefix=>`${prefix}-${randomUUID()}`;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const terminal=new Set(['completed','partial','failed','interrupted']);
const privateMarker=uid('PRIVATE-SESSION-DO-NOT-EXPORT');
const beforeName='Independent fixed export marker BEFORE branch edit';
const afterName='Independent later edit must NEVER enter previous build';
const logicMarker='INDEPENDENT_EXPORT_REAL_LOGIC_TICK';
const logic=`extends RefCounted\nfunc initialize(context) -> Dictionary:\n\tcontext.state["ticks"] = 0\n\tif OS.has_feature("editor"):\n\t\tvar side_effect = FileAccess.open("res://runtime-created-private.txt",FileAccess.WRITE)\n\t\tif side_effect != null:\n\t\t\tside_effect.store_string("BENIGN_RUNTIME_SIDE_EFFECT_MUST_NOT_BE_ARCHIVED")\n\t\t\tside_effect.close()\n\treturn {"ok":true}\nfunc tick(context, _delta: float) -> Dictionary:\n\tif context.role == "authority":\n\t\tcontext.state["ticks"] += 1\n\t\tif context.state["ticks"] == 10:\n\t\t\tprint("${logicMarker}")\n\treturn {"ok":true}\n`;
async function freePort(){const server=createServer();await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});await new Promise(done=>server.close(done));}
async function files(directory){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile())result.push(path);}return result;}

test('exports: authenticated fixed builds, clean Godot source, real applications and isolated Web play',{timeout:1200000},async t=>{
  await freePort();
  const data=await mkdtemp(resolve(tmpdir(),'atelier-export-independent-'));
  const out=resolve(root,'.local/creation-verification/export-builds',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
  await mkdir(out,{recursive:true});
  const report={started_at:new Date().toISOString(),root,data,port,node:process.version,godot:execFileSync(godot,['--version'],{encoding:'utf8'}).trim(),scope:'real isolated HTTP/Godot/Chromium; no external deployment or cross-platform launch claim',cases:[],processes:[],progress:[],source_hashes:{},completed:false};
  let child,browser,serverLog='',owner,viewer,outsider,project,fixed,sourceJob,webJob,sourceRoot;
  const save=()=>writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  async function start(){
    await freePort();
    const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_ENABLE_HIERARCHY:'1'};
    child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    const record={pid:child.pid,started_at:Date.now()};report.processes.push(record);
    child.stdout.on('data',b=>{serverLog+=`[${record.pid}] ${b}`;});child.stderr.on('data',b=>{serverLog+=`[${record.pid}] ${b}`;});
    child.once('exit',(code,signal)=>Object.assign(record,{code,signal,stopped_at:Date.now()}));
    for(let i=0;i<200;i++){if(child.exitCode!==null||child.signalCode!==null)throw Error(serverLog);try{const r=await fetch(origin+'/creation-api/health');if(r.ok)return await r.json();}catch{}await wait(50);}throw Error('Independent export service did not start');
  }
  async function stop(){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const own=child,closed=new Promise(done=>own.once('exit',done));own.kill('SIGTERM');const timeout=setTimeout(()=>own.kill('SIGKILL'),15000);await closed;clearTimeout(timeout);await freePort();
  }
  async function request(method,path,user=owner,input){
    const response=await fetch(origin+'/creation-api/'+path,{method,headers:{origin,'content-type':'application/json',...(user?{authorization:`Bearer ${user.token}`}:{})},body:input===undefined?undefined:JSON.stringify(input)});
    const text=await response.text();let value;try{value=JSON.parse(text);}catch{value={text:text.slice(0,500)};}return {status:response.status,value,headers:response.headers};
  }
  const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.value));return r.value;};
  const path=(suffix='',branch='main')=>`projects/${project.id}/branches/${branch}${suffix}`;
  const buildInput=(kind,extra={})=>({kind,targets:kind==='application'?['web']:[],source_revision:fixed,entry_scene_id:'scene-harbor',request_id:uid('build-request'),confirmed:true,...extra});
  async function enqueue(input,user=owner){const result=await request('POST',path('/builds'),user,input);assert.ok([200,201,202].includes(result.status),JSON.stringify(result.value));assert.ok(result.value.job?.id);return result.value.job;}
  async function job(id,user=owner){return ok(await request('GET',`builds/${id}`,user)).job;}
  async function finished(id,timeout=420000){
    const end=Date.now()+timeout;let previous=-1;
    while(Date.now()<end){const row=await job(id);assert.ok(Number.isFinite(row.progress)&&row.progress>=0&&row.progress<=100);assert.ok(row.progress>=previous,`progress regressed for ${id}`);previous=row.progress;report.progress.push({id,status:row.status,progress:row.progress,stage:row.stage,at:Date.now()});if(terminal.has(row.status))return row;await wait(180);}
    throw Error('Build timeout '+id);
  }
  async function download(artifact,name){
    const response=await fetch(new URL(artifact.download_url,origin),{headers:{authorization:`Bearer ${owner.token}`}});assert.equal(response.status,200);assert.match(response.headers.get('content-disposition')??'',/attachment/);
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,artifact.size);assert.equal(digest(bytes),artifact.sha256);
    const zip=resolve(out,name);await writeFile(zip,bytes);
    const inventory=execFileSync('unzip',['-Z1',zip],{encoding:'utf8'}).trim().split('\n');
    assert.ok(inventory.length>0);assert.equal(inventory.some(n=>n.startsWith('/')||n.split('/').includes('..')||n.includes('\\')),false,'archive paths stay inside extraction root');
    return {zip,inventory,sha256:artifact.sha256,bytes:bytes.length};
  }
  async function extract(zip,label){const directory=resolve(data,label);await mkdir(directory,{recursive:true});execFileSync('unzip',['-q',zip,'-d',directory]);return directory;}
  async function runGodot(args,label,timeout=90000,executable=godot){
    const result=await new Promise((done,reject)=>{const proc=spawn(executable,args,{cwd:root,stdio:['ignore','pipe','pipe']});let log='';const timer=setTimeout(()=>{proc.kill('SIGKILL');reject(Error('Godot timeout: '+label));},timeout);proc.stdout.on('data',b=>{log+=b;});proc.stderr.on('data',b=>{log+=b;});proc.once('error',error=>{clearTimeout(timer);reject(error);});proc.once('exit',(code,signal)=>{clearTimeout(timer);done({code,signal,log});});});
    await writeFile(resolve(out,label+'.log'),result.log);assert.equal(result.code,0,result.log);assert.doesNotMatch(result.log,/SCRIPT ERROR|Parse Error|ERROR:|Export failed/);return result;
  }
  async function step(id,title,fn){const row={id,title,status:'running',started_at:Date.now(),observations:{}};report.cases.push(row);await t.test(`${id} ${title}`,async()=>{try{await fn(row.observations);row.status='passed';}catch(error){row.status='failed';row.error={message:error.message,stack:error.stack};throw error;}finally{row.finished_at=Date.now();await save();console.log(`EXPORT_CASE ${id} ${row.status}`);}});if(row.status!=='passed')throw Error('Cannot continue safely after '+id);}
  try{
    for(const name of ['services/creation/export-builds.mjs','services/creation/service.mjs','services/preview/server.mjs'])report.source_hashes[name]=digest(await readFile(resolve(root,name)));
    report.health=await start();
    owner=ok(await request('POST','auth/register',null,{name:uid('export-owner'),password:uid('private-password')}),201);
    viewer=ok(await request('POST','auth/register',null,{name:uid('export-viewer'),password:uid('private-password')}),201);
    outsider=ok(await request('POST','auth/register',null,{name:uid('export-outsider'),password:uid('private-password')}),201);
    const created=ok(await request('POST','projects',owner,{name:'Independent export acceptance',template:'harbor'}),201);project=created.project;
    const invite=ok(await request('POST',`projects/${project.id}/invites`,owner,{role:'viewer'}),201);ok(await request('POST','invites/join',viewer,{code:invite.code}));
    ok(await request('POST',path('/sessions'),owner,{title:privateMarker}),201);
    const response=await fetch(origin+`/creation-api/projects/${project.id}/assets`,{method:'POST',headers:{origin,authorization:`Bearer ${owner.token}`,'content-type':'application/octet-stream','x-asset-name':'independent-build-behavior.gd'},body:logic});assert.equal(response.status,201);const module=await response.json();
    fixed=ok(await request('POST',path('/transactions'),owner,{transaction_id:uid('tx'),base_revision:created.branch.head,ops:[{type:'put_object',resource_id:'scene-harbor',object_id:'independent-export-behavior',expected_version:null,object:{id:'independent-export-behavior',name:beforeName,kind:'anchor',position:[0,0,3],rotation:[0,0,0],scale:[1,1,1],components:{behaviors:[{id:'build-counter',api:1,script_hash:module.id,script_url:module.url,properties:{}}]}}}]})).revision;
    report.project_id=project.id;report.fixed_source_revision=fixed;report.script_sha256=module.id;

    await step('EX01','confirmation, roles, target catalog and idempotency prerequisites',async o=>{
      const catalog=ok(await request('GET',path('/builds')));assert.ok(Array.isArray(catalog.jobs)&&Array.isArray(catalog.targets));
      assert.deepEqual(catalog.targets.map(x=>x.id).sort(),['android','ios','linux','macos','web','windows']);
      for(const target of catalog.targets)if(!target.available)assert.ok(target.reason,'unavailable target explains missing tooling');o.targets=catalog.targets;
      assert.equal((await request('GET',path('/builds'),outsider)).status,403);
      assert.equal((await request('POST',path('/builds'),viewer,buildInput('source'))).status,403);
      const unconfirmed=await request('POST',path('/builds'),owner,buildInput('source',{confirmed:false}));assert.ok([400,409].includes(unconfirmed.status));
      const bad=await request('POST',path('/builds'),owner,buildInput('application',{targets:['../outside']}));assert.ok([400,422].includes(bad.status));
      assert.equal(ok(await request('GET',path('/builds'))).jobs.length,0,'rejected requests never enqueue jobs');
    });

    await step('EX02','source job pins content while branch advances and request replay stays one job',async o=>{
      const input=buildInput('source');sourceJob=await enqueue(input);const replay=await enqueue(input);assert.equal(replay.id,sourceJob.id);
      const current=ok(await request('GET',path())),object=current.manifest.resources['scene-harbor'].objects.find(o=>o.id==='independent-export-behavior');
      const changed=ok(await request('POST',path('/transactions'),owner,{transaction_id:uid('tx'),base_revision:current.head,ops:[{type:'patch_object',resource_id:'scene-harbor',object_id:object.id,expected_version:object.version,patch:{name:afterName}}]}));assert.notEqual(changed.revision,fixed);
      sourceJob=await finished(sourceJob.id);assert.equal(sourceJob.status,'completed',JSON.stringify(sourceJob));assert.equal(sourceJob.progress,100);assert.equal(sourceJob.source_revision,fixed);
      assert.equal((await request('GET',`builds/${sourceJob.id}`,outsider)).status,403);
      assert.equal((await request('POST',path('/builds'),owner,{...input,entry_scene_id:'not-the-same-request'})).status,409);
      o.job=sourceJob;o.later_revision=changed.revision;
    });

    await step('EX03','downloaded Godot project includes fixed resources and local assets without private workbench data',async o=>{
      const artifact=sourceJob.artifacts.find(a=>a.target==='source')??sourceJob.artifacts[0];assert.ok(artifact);
      const denied=await fetch(new URL(artifact.download_url,origin),{headers:{authorization:`Bearer ${outsider.token}`}});assert.equal(denied.status,403);
      const authorized=await fetch(new URL(artifact.download_url,origin),{headers:{authorization:`Bearer ${viewer.token}`}});assert.equal(authorized.status,200);await authorized.body.cancel();
      const result=await download(artifact,'godot-source.zip');
      assert.equal(result.inventory.some(n=>/(^|\/)(\.git|\.godot|\.local|node_modules)(\/|$)|\.sqlite(?:-|$)|(?:^|\/)\.env(?:\.|$)/.test(n)),false);
      assert.equal(result.inventory.some(n=>n.endsWith('runtime-created-private.txt')),false,'validator-created files never enter the source archive');
      const directory=await extract(result.zip,'source-extracted'),all=await files(directory),projects=all.filter(p=>p.endsWith('/project.godot'));assert.equal(projects.length,1);sourceRoot=dirname(projects[0]);
      const textFiles=all.filter(p=>['.gd','.godot','.tscn','.json','.cfg','.md','.txt'].includes(extname(p))),contents=await Promise.all(textFiles.map(p=>readFile(p,'utf8'))),allText=contents.join('\n');
      for(const secret of [owner.token,viewer.token,outsider.token,privateMarker,invite.code,data])assert.equal(allText.includes(secret),false,'private state is absent');
      assert.doesNotMatch(allText,/[?&]cap=[A-Za-z0-9_-]{20,}/);assert.ok(allText.includes(fixed));assert.ok(allText.includes(beforeName));assert.equal(allText.includes(afterName),false);assert.ok(allText.includes(logicMarker));
      const glbs=all.filter(p=>p.endsWith('.glb')||p.endsWith('.glb.bin'));assert.ok(glbs.length>=4,'all catalog prefab definitions retain actual asset bytes');assert.ok(all.some(p=>p.endsWith(module.id+'.gd')||p.endsWith(module.id+'.gd.txt')));
      await runGodot(['--headless','--editor','--path',sourceRoot,'--import'],'source-import');
      const boot=await runGodot(['--headless','--path',sourceRoot,'--fixed-fps','60','--quit-after','90'],'source-boot');assert.ok(boot.log.includes(logicMarker),'unchanged downloaded game executes its embedded behavior');
      const receiptLine=boot.log.split('\n').find(line=>line.startsWith('STANDALONE_READY '));assert.ok(receiptLine,'actual standalone runtime ready receipt');const receipt=JSON.parse(receiptLine.slice('STANDALONE_READY '.length));assert.equal(receipt.revision,fixed);assert.equal(receipt.project_id,project.id);assert.ok(receipt.behavior_hashes.includes(module.id));
      o.archive={sha256:result.sha256,bytes:result.bytes,entries:result.inventory.length};o.project_path=relative(directory,sourceRoot);o.glbs=glbs.length;o.actual_logic_observed=true;
    });

    await step('EX04','restart preserves finished downloads and marks actual in-flight work interrupted',async o=>{
      const pending=await enqueue(buildInput('application'));assert.ok(['queued','running'].includes(pending.status));await stop();await start();
      const recovered=await job(pending.id);assert.equal(recovered.status,'interrupted',JSON.stringify(recovered));assert.ok(recovered.error||recovered.message,'interruption explains recovery state');
      const retained=await job(sourceJob.id);assert.equal(retained.status,'completed');assert.deepEqual(retained.artifacts,sourceJob.artifacts);o.interrupted=recovered;o.retained_job_id=retained.id;
    });

    await step('EX05','real Web and desktop exports, explicit mobile tooling outcomes, fixed source version',async o=>{
      const catalog=ok(await request('GET',path('/builds')));const targets=['web','macos','windows','linux','android','ios'];
      webJob=await enqueue(buildInput('application',{targets}));webJob=await finished(webJob.id,600000);
      assert.ok(['completed','partial'].includes(webJob.status),JSON.stringify(webJob));assert.equal(webJob.source_revision,fixed);assert.equal(webJob.progress,100);
      const results=new Map(webJob.target_results.map(row=>[row.target,row]));for(const target of targets){assert.ok(results.has(target));if(catalog.targets.find(t=>t.id===target).available)assert.equal(results.get(target).status,'completed',JSON.stringify(results.get(target)));else assert.ok(['completed','blocked','failed','unavailable'].includes(results.get(target).status));}
      o.native_artifacts=[];
      for(const target of ['web','macos','windows','linux']){
        if(results.get(target).status!=='completed')continue;const artifact=webJob.artifacts.find(a=>a.target===target);assert.ok(artifact,'actual artifact '+target);assert.ok(artifact.size>1000000);assert.match(artifact.sha256,/^[a-f0-9]{64}$/);
        if(target==='web')continue;
        const archive=await download(artifact,target+'-application.zip'),directory=await extract(archive.zip,target+'-extracted');let all=await files(directory);
        if(target==='macos'&&!all.some(p=>p.includes('/Contents/MacOS/'))){const bundle=all.find(p=>p.endsWith('.zip'));assert.ok(bundle,'macOS Godot app archive');execFileSync('unzip',['-q',bundle,'-d',directory]);all=await files(directory);}
        const executable=target==='macos'?all.find(p=>p.includes('/Contents/MacOS/')):target==='windows'?all.find(p=>p.endsWith('.exe')):all.find(p=>p.endsWith('.x86_64')||p.endsWith('/game'));
        assert.ok(executable,'native executable in '+target+' archive');const executableBytes=await readFile(executable),magic=executableBytes.subarray(0,4).toString('hex');
        if(target==='windows'){assert.equal(executableBytes.subarray(0,2).toString(),'MZ');const offset=executableBytes.readUInt32LE(0x3c);assert.equal(executableBytes.subarray(offset,offset+4).toString('hex'),'50450000','actual PE header');}
        else assert.ok((target==='macos'?['cafebabe','cffaedfe','cefaedfe']:['7f454c46']).includes(magic),'actual '+target+' executable magic '+magic);
        const observation={target,sha256:archive.sha256,bytes:archive.bytes,executable:relative(directory,executable),magic,launched:false};
        if(target==='macos'){const boot=await runGodot(['--headless','--fixed-fps','60','--quit-after','90'],'macos-application-boot',90000,executable);assert.ok(boot.log.includes(logicMarker));assert.ok(boot.log.includes(fixed));observation.launched=true;}
        o.native_artifacts.push(observation);
      }
      const web=webJob.artifacts.find(a=>a.target==='web'),downloaded=await download(web,'web-application.zip');assert.ok(downloaded.inventory.some(p=>p.endsWith('.wasm')));assert.ok(downloaded.inventory.some(p=>p.endsWith('.pck')));assert.ok(downloaded.inventory.some(p=>p.endsWith('index.html')));
      o.job=webJob;o.web_archive={bytes:downloaded.bytes,sha256:downloaded.sha256,entries:downloaded.inventory.length};
    });

    await step('EX06','fixed Web access is separate from the editor, authenticated, revocable and actually runs Godot',async o=>{
      const access=await request('POST',`builds/${webJob.id}/access`,owner,{});const body=ok(access);assert.match(body.web_url,new RegExp(`/creation-releases/${webJob.id}/`));assert.match(access.headers.get('set-cookie')??'',/HttpOnly/i);
      const unauthenticated=await fetch(new URL(body.web_url,origin));assert.ok([401,403].includes(unauthenticated.status));
      browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-webgl','--use-angle=swiftshader']});
      const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage(),messages=[],errors=[];page.on('console',msg=>messages.push(msg.text()));page.on('pageerror',e=>errors.push(e.message));
      const granted=await context.request.post(origin+`/creation-api/builds/${webJob.id}/access`,{headers:{origin,authorization:`Bearer ${owner.token}`},data:{}});assert.equal(granted.status(),200);const address=(await granted.json()).web_url;
      const response=await page.goto(new URL(address,origin).href);assert.equal(response.status(),200);await page.locator('canvas').waitFor();
      const deadline=Date.now()+100000;while(Date.now()<deadline&&!messages.some(v=>v.includes(logicMarker)))await wait(200);
      assert.ok(messages.some(v=>v.includes(logicMarker)),'actual packaged Web runs the authored logic');assert.equal(errors.length,0,errors.join('\n'));assert.equal(await page.locator('#chatFeed,#sceneTree,#projectMenu').count(),0,'package opens outside the editor');
      await page.waitForFunction(()=>window.worldAtelierRelease?.ready===true);const before=await page.evaluate(()=>window.worldAtelierRelease);assert.equal(before.revision,fixed);assert.equal(before.project_id,project.id);assert.ok(before.object_states['independent-export-behavior']['build-counter'].ticks>=10);
      await page.locator('canvas').click({position:{x:600,y:400}});await page.keyboard.down('KeyD');await wait(1200);await page.keyboard.up('KeyD');await wait(300);
      const after=await page.evaluate(()=>window.worldAtelierRelease);assert.equal(after.ready,true);assert.ok(after.tick>before.tick);assert.equal(Object.hasOwn(before,'player'),false,'packaged host has no implicit player');assert.equal(Object.hasOwn(after,'player'),false,'keyboard input does not inject a player');assert.ok(after.object_states['independent-export-behavior']['build-counter'].ticks>before.object_states['independent-export-behavior']['build-counter'].ticks,'authored behavior keeps advancing without default player');assert.equal(after.revision,fixed);
      await page.screenshot({path:resolve(out,'web-package.png')});o.page_url=new URL(address,origin).pathname;o.actual_logic_observed=true;o.browser_errors=errors;o.before=before;o.after=after;
      const pckPath=resolve(data,'creation','builds',webJob.id,'web','index.pck'),pck=await readFile(pckPath),pckUrl=new URL('index.pck',new URL(address,origin));
      try{await writeFile(pckPath,Buffer.concat([pck,Buffer.from([0])]));const corrupt=await context.request.get(pckUrl.href);assert.equal(corrupt.status(),409,'tampered immutable package is refused');o.corruption_rejected=true;}finally{await writeFile(pckPath,pck);}
      const viewerContext=await browser.newContext(),grant=await viewerContext.request.post(origin+`/creation-api/builds/${webJob.id}/access`,{headers:{origin,authorization:`Bearer ${viewer.token}`},data:{}});assert.equal(grant.status(),200);const viewerURL=(await grant.json()).web_url;
      ok(await request('PATCH',`projects/${project.id}/members/${viewer.user.id}`,owner,{role:null}));const revoked=await viewerContext.request.get(new URL(viewerURL,origin).href);assert.equal(revoked.status(),403,'cookie never overrides revoked membership');
      await viewerContext.close();await context.close();
    });
    await step('EX07','canonical workbench controls confirm before enqueue, show persisted progress, download and open a new Web page',async o=>{
      const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
      await context.addInitScript(({token})=>sessionStorage.setItem('world-atelier-creator-token',token),{token:owner.token});
      const page=await context.newPage(),writes=[];page.on('request',request=>{if(request.method()==='POST'&&/\/branches\/[^/]+\/builds$/.test(new URL(request.url()).pathname))writes.push(request.postDataJSON());});
      await page.goto(origin+'/creation-workspace.html');await page.locator('[data-enter="main"]').click();await page.locator('#exportProjectButton').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#exportProjectButton').disabled);
      const projectBox=await page.locator('#topbarProject').boundingBox(),exportBox=await page.locator('#exportProjectButton').boundingBox();assert.ok(exportBox.x>=projectBox.x+projectBox.width,'export entrance is right of project name');
      await page.locator('#exportProjectButton').click();await page.getByRole('heading',{name:'确认导出 Godot 工程',exact:true}).waitFor();assert.equal(writes.length,0);await page.getByRole('button',{name:'关闭导出与打包',exact:true}).click();assert.equal(writes.length,0,'cancel confirmation causes no background work');
      await page.locator('#packageProjectButton').click();await page.getByRole('heading',{name:'打包应用',exact:true}).waitFor();await page.locator('.release-target input[value="web"]').check();await page.getByRole('button',{name:'下一步：确认打包',exact:true}).click();await page.getByRole('heading',{name:'确认打包应用',exact:true}).waitFor();assert.equal(writes.length,0);await page.getByRole('button',{name:'关闭导出与打包',exact:true}).click();assert.equal(writes.length,0);
      const oldIds=new Set(ok(await request('GET',path('/builds'))).jobs.map(j=>j.id));
      await page.locator('#exportProjectButton').click();await page.getByRole('button',{name:'确认导出',exact:true}).click();
      const deadline=Date.now()+10000;let created;while(Date.now()<deadline&&!created){created=ok(await request('GET',path('/builds'))).jobs.find(j=>!oldIds.has(j.id));if(!created)await wait(80);}assert.ok(created);assert.equal(writes.length,1);assert.equal(writes[0].confirmed,true);assert.equal(writes[0].source_revision,ok(await request('GET',path())).head);
      await page.locator(`[data-release-job="${created.id}"] progress`).waitFor();const progress=await page.locator(`[data-release-job="${created.id}"] progress`).getAttribute('value');assert.ok(Number(progress)>=0&&Number(progress)<=100);await page.screenshot({path:resolve(out,'workbench-progress.png')});
      await page.reload();await page.locator('[data-enter="main"]').click();await page.locator('#releaseBuildProgress').waitFor({state:'visible'});await page.locator('#releaseBuildProgress').click();await page.locator(`[data-release-job="${created.id}"]`).waitFor();const complete=await finished(created.id);assert.equal(complete.status,'completed');
      await page.waitForFunction(id=>document.querySelector(`[data-release-job="${id}"] progress`)?.value===100,created.id);const row=page.locator(`[data-release-job="${created.id}"]`),downloadEvent=page.waitForEvent('download');await row.getByRole('button',{name:'下载',exact:true}).click();const download=await downloadEvent;assert.match(download.suggestedFilename(),/\.zip$/i);await download.cancel();
      const popupEvent=page.waitForEvent('popup');await page.locator(`[data-release-job="${webJob.id}"]`).getByRole('button',{name:'新页面打开 Web ↗',exact:true}).click();const popup=await popupEvent;await popup.waitForURL(url=>url.pathname.startsWith(`/creation-releases/${webJob.id}/`));await popup.locator('canvas').waitFor();assert.equal(page.url(),origin+'/creation-workspace.html');
      await page.screenshot({path:resolve(out,'workbench-build-history.png')});o.created_job_id=created.id;o.confirmed_requests=writes.length;o.popup_path=new URL(popup.url()).pathname;o.download_filename=download.suggestedFilename();
      await page.getByRole('button',{name:'关闭导出与打包',exact:true}).click();await page.setViewportSize({width:390,height:844});
      o.mobile_buttons={};for(const id of ['exportProjectButton','packageProjectButton','accountMenuButton']){const box=await page.locator('#'+id).boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=391,'mobile button stays visible: '+id);o.mobile_buttons[id]=box;}
      await page.screenshot({path:resolve(out,'workbench-mobile.png')});await context.close();
    });
    await step('EX08','hierarchy project export retains assets referenced only by an old unplaced prefab revision',async o=>{
      const branchId='independent-hierarchy-export',main=ok(await request('GET',path()));
      const fork=ok(await request('POST',`projects/${project.id}/branches`,owner,{from_branch:'main',expected_head:main.head,branch_id:branchId,name:'Independent hierarchy export'}),201);
      let current=ok(await request('POST',path('/transactions',branchId),owner,{transaction_id:uid('migration'),base_revision:fork.head,expected_head:fork.head,ops:[{type:'migrate_hierarchy'}]})).branch;
      assert.equal(current.manifest.schema,'creation-hierarchy-2');
      const source='extends RefCounted\n# Unique dependency retained only by archived unplaced prefab\nfunc initialize(_context) -> Dictionary:\n\treturn {"ok":true}\n';
      const response=await fetch(origin+`/creation-api/projects/${project.id}/assets`,{method:'POST',headers:{origin,authorization:`Bearer ${owner.token}`,'content-type':'application/octet-stream','x-asset-name':'archived-prefab-only.gd'},body:source});assert.equal(response.status,201);const asset=await response.json();
      const prefab=Object.values(current.manifest.resources).find(resource=>resource.kind==='prefab'&&resource.id==='pf-tree'),node=Object.values(prefab.nodes).find(n=>n.id!==prefab.root_id);assert.ok(node);
      current=ok(await request('POST',path('/transactions',branchId),owner,{transaction_id:uid('prefab-history'),base_revision:current.head,ops:[{type:'patch_node',resource_id:prefab.id,node_id:node.id,expected_version:node.version,patch:{components:{...node.components,behaviors:[{id:'archived-only',api:1,script_hash:asset.id,script_url:asset.url,properties:{}}]}}}]})).branch;
      const historicalVersion=current.manifest.resources[prefab.id].version,patched=current.manifest.resources[prefab.id].nodes[node.id];
      current=ok(await request('POST',path('/transactions',branchId),owner,{transaction_id:uid('prefab-remove'),base_revision:current.head,ops:[{type:'patch_node',resource_id:prefab.id,node_id:node.id,expected_version:patched.version,patch:{components:node.components}}]})).branch;
      assert.ok(JSON.stringify(current.manifest.prefab_revisions[historicalVersion]).includes(asset.id));assert.equal(JSON.stringify(current.manifest.resources).includes(asset.id),false,'dependency is absent from every current resource');
      const started=await request('POST',path('/builds',branchId),owner,buildInput('source',{source_revision:current.head}));assert.ok([200,201,202].includes(started.status));const result=await finished(started.value.job.id);assert.equal(result.status,'completed',JSON.stringify(result));
      const archive=await download(result.artifacts[0],'hierarchy-source.zip'),directory=await extract(archive.zip,'hierarchy-source-extracted'),all=await files(directory),projectPath=all.find(p=>p.endsWith('/project.godot'));assert.ok(projectPath);const sourceManifest=JSON.parse(await readFile(resolve(dirname(projectPath),'source-manifest.json'),'utf8'));
      assert.ok(sourceManifest.prefab_revisions[historicalVersion]);const archivedAsset=all.find(p=>p.endsWith(asset.id+'.gd.txt')||p.endsWith(asset.id+'.gd'));assert.ok(archivedAsset,'historical dependency bytes survive source export');assert.equal(digest(await readFile(archivedAsset)),asset.id);
      await runGodot(['--headless','--editor','--path',dirname(projectPath),'--import'],'hierarchy-source-import');const boot=await runGodot(['--headless','--path',dirname(projectPath),'--fixed-fps','60','--quit-after','90'],'hierarchy-source-boot');assert.ok(boot.log.includes('STANDALONE_READY'));assert.ok(boot.log.includes(current.head));
      o.source_revision=current.head;o.prefab_revision=historicalVersion;o.historical_asset_sha256=asset.id;o.archive={bytes:archive.bytes,sha256:archive.sha256};
    });
    report.completed=true;
  }finally{
    await browser?.close();await stop();await writeFile(resolve(out,'server.log'),serverLog);report.finished_at=new Date().toISOString();await save();console.log('EXPORT_REPORT '+resolve(out,'report.json'));
  }
});
