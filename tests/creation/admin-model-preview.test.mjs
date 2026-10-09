import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';

const root=process.env.WORLD_ATELIER_TEST_ROOT??resolve(import.meta.dirname,'../..');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),uid=p=>`${p}-${randomUUID()}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function availablePort(port){const server=createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});const chosen=server.address().port;await new Promise(ok=>server.close(ok));return chosen;}

// A real self-contained GLB with unchanged geometry and unique JSON metadata.
// Upload still passes through the actual service GLB validator.
function privateGLB(original){
  const length=original.readUInt32LE(12),json=JSON.parse(original.subarray(20,20+length).toString());
  json.extras={...json.extras,independent_admin_preview:uid('private-asset')};
  const raw=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(Math.ceil(raw.length/4)*4,0x20);raw.copy(padded);
  const next=Buffer.alloc(20+padded.length+original.length-20-length);original.copy(next,0,0,12);next.writeUInt32LE(next.length,8);next.writeUInt32LE(padded.length,12);next.writeUInt32LE(0x4e4f534a,16);padded.copy(next,20);original.copy(next,20+padded.length,20+length);return next;
}

test('admin model preview: isolated authorization, immutable GLB and bundled module',{timeout:120000},async t=>{
  const port=await availablePort(Number(process.env.WORLD_ATELIER_ADMIN_MODEL_TEST_PORT??48921)),origin=`http://127.0.0.1:${port}`;
  const data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-admin-model-'))),database=resolve(data,'creation/creation.sqlite');
  const evidence=resolve(root,'.local/creation-verification/admin-model-preview',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);mkdirSync(evidence,{recursive:true});
  const sources=['services/preview/server.mjs','services/creation/admin.mjs','services/creation/admin-model-preview.mjs','services/creation/assets.mjs','apps/creation-workspace/admin.html','apps/creation-workspace/admin.css','apps/creation-workspace/admin.js','apps/creation-workspace/admin-login.html','apps/creation-workspace/admin-login.js','apps/creation-workspace/admin-model-preview.js','package.json','package-lock.json'].filter(f=>existsSync(resolve(root,f)));
  const report={scope:'actual isolated HTTP / SQLite / GLB byte checks; no WebGL rendering, GPU, interaction or animation claim',origin,evidence,started_at:new Date().toISOString(),cases:[],source_hashes:Object.fromEntries(sources.map(f=>[f,hash(readFileSync(resolve(root,f)))])),completed:false};
  const ownerCredentials={name:uid('Model administrator'),password:uid('Password')};
  const initial=new CreationStore(database);let A={...initial.register(ownerCredentials),credentials:ownerCredentials};initial.put('creator_admin_settings',{id:'singleton',owner_user_id:A.user.id});initial.close();
  let child=null,log='',cookie=null;
  async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const ended=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),12000);await ended;clearTimeout(timer);}await availablePort(port);}
  async function start(){
    const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_PUBLIC_PLAY:'1',WORLD_ATELIER_LAN:'0'};delete env.WORLD_ATELIER_ADMIN_USER_ID;delete env.WORLD_ATELIER_PREVIEW_HOST;
    child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});report.service_pids??=[];report.service_pids.push(child.pid);child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
    for(let i=0;i<250;i++){if(child.exitCode!==null)throw Error('Isolated preview exited: '+log);try{const r=await fetch(origin+'/creation-api/health');if(r.ok){const h=await r.json();assert.equal(h.agent_ready,false);assert.equal(h.worlds_ready,false);return;}}catch{}await wait(30);}throw Error('Isolated preview did not start');
  }
  t.after(async()=>{await stop();report.finished_at=new Date().toISOString();report.source_changed_during_run=sources.filter(f=>report.source_hashes[f]!==hash(readFileSync(resolve(root,f))));rmSync(data,{recursive:true,force:true});report.temporary_data_removed=!existsSync(data);writeFileSync(resolve(evidence,'server.log'),log);writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('ADMIN_MODEL_REPORT '+resolve(evidence,'report.json'));});
  async function request(method,path,actor,input,headers={}){
    const r=await fetch(origin+path,{method,redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json',...(actor?.token?{Authorization:'Bearer '+actor.token}:{}),...(actor?.cookie?{Cookie:actor.cookie}:{}),...headers},...(input===undefined?{}:{body:Buffer.isBuffer(input)?input:JSON.stringify(input)})});
    const bytes=Buffer.from(await r.arrayBuffer());let value;try{value=JSON.parse(bytes);}catch{value=bytes.toString();}return {status:r.status,headers:r.headers,bytes,value};
  }
  const api=(method,path,actor,input,headers)=>request(method,'/creation-api'+path,actor,input,headers);
  const ok=(r,status=200)=>{assert.equal(r.status,status,typeof r.value==='string'?r.value.slice(0,160):JSON.stringify(r.value));return r.value;};
  const dbRead=fn=>{const db=new DatabaseSync(database,{readOnly:true});try{return fn(db);}finally{db.close();}};
  const countKind=kind=>dbRead(db=>db.prepare('SELECT COUNT(*) AS total FROM documents WHERE kind=?').get(kind).total);
  const model=id=>'/admin-models/'+id+'.glb',modulePath='/admin-assets/admin-model-preview.js';
  const adminCookie=async()=>{const r=await api('POST','/admin/access',A,{});ok(r);cookie={cookie:r.headers.get('set-cookie').split(';')[0]};return cookie;};
  async function status(id,value){const item=ok(await api('GET','/admin/assets/'+id,A)).item;return ok(await api('PATCH','/admin/assets/'+id,A,{request_id:uid('model-status'),expected_version:item.version,reason:'Independent model preview verification',status:value}));}
  async function check(name,fn){await t.test(name,async()=>{const row={name,status:'running'};report.cases.push(row);try{row.observations=await fn();row.status='passed';}catch(e){row.status='failed';row.error=e.message;throw e;}});}
  await start();
  const credentials={name:uid('Private project owner'),password:uid('Password')},B=ok(await api('POST','/auth/register',null,credentials),201);await adminCookie();
  const account=ok(await api('GET','/admin/users/'+B.user.id,A)).item;ok(await api('PATCH','/admin/users/'+B.user.id,A,{request_id:uid('creation-grant'),expected_version:account.version,reason:'Create isolated private fixture',action:'creation',value:true}));
  const made=ok(await api('POST','/projects',B,{name:'Private model preview fixture',template:'empty'}),201),projectId=made.project.id;
  const builtin=JSON.parse(readFileSync(resolve(root,'content/model-preview/manifest.json'))).assets[0],builtinBytes=readFileSync(resolve(root,'content/model-preview',builtin.file)),privateBytes=privateGLB(builtinBytes);
  const asset=ok(await api('POST',`/projects/${projectId}/assets`,B,privateBytes,{'Content-Type':'application/octet-stream','x-asset-name':'private-admin-preview.glb'}),201);
  const script=ok(await api('POST',`/projects/${projectId}/assets`,B,Buffer.from('extends Node\n# '+uid('gd-not-model')+'\n'),{'Content-Type':'application/octet-stream','x-asset-name':'non-model.gd'}),201);

  await check('only the sole admin may read models even when a guest owns the project',async()=>{
    assert.equal(made.project.role,'owner');assert.equal(made.project.members.some(x=>x.id===A.user.id),false);assert.equal(asset.builtin??false,false);
    for(const path of [model(builtin.sha256),model(asset.id)])for(const method of ['GET','HEAD']){
      assert.equal((await request(method,path,null)).status,401);assert.equal((await request(method,path,B)).status,403);assert.equal((await request(method,path,{token:'invalid'})).status,401);
      assert.equal((await request(method,path,{token:B.token,cookie:cookie.cookie})).status,403);
    }
    assert.equal((await request('GET',asset.url,null)).status,403,'A private model must remain private through the original asset route');
    return {admin_is_not_private_project_member:true,ordinary_project_owner_denied:true};
  });
  await check('cookie and bearer return exact immutable bytes with private response headers',async()=>{
    for(const [id,bytes]of [[builtin.sha256,builtinBytes],[asset.id,privateBytes]])for(const actor of [A,cookie]){
      const r=await request('GET',model(id),actor);ok(r);assert.equal(hash(r.bytes),id);assert.deepEqual(r.bytes,bytes);assert.match(r.headers.get('content-type'),/^model\/gltf-binary/);assert.match(r.headers.get('cache-control'),/private/);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(Number(r.headers.get('content-length')),bytes.length);assert.equal(r.headers.get('cross-origin-resource-policy'),'same-origin');assert.equal(r.headers.get('access-control-allow-origin'),null);
      const head=await request('HEAD',model(id),actor);ok(head);assert.equal(head.bytes.length,0);assert.equal(Number(head.headers.get('content-length')),bytes.length);
    }
    return {builtin_sha256:builtin.sha256,private_sha256:asset.id,private_bytes:privateBytes.length};
  });
  await check('preview reads never grant project access or mint transferable asset capabilities',async()=>{
    const before={caps:countKind('creator_asset_cap'),audits:countKind('creator_admin_audit'),head:ok(await api('GET',`/projects/${projectId}/branches/main`,B)).head};
    for(let i=0;i<3;i++)ok(await request('GET',model(asset.id),cookie));
    assert.equal(countKind('creator_asset_cap'),before.caps);assert.equal(countKind('creator_admin_audit'),before.audits);assert.equal(ok(await api('GET',`/projects/${projectId}/branches/main`,B)).head,before.head);assert.equal(ok(await api('GET','/admin/projects/'+projectId,A)).item.members.some(x=>x.id===A.user.id),false);
  });
  await check('quarantine blocks normal encoded and HEAD paths until explicit recovery',async()=>{
    await status(asset.id,'quarantined');const paths=[model(asset.id),`/admin-models/${asset.id}%2eglb`,`/admin%2dmodels/${asset.id}.glb`];
    for(const path of paths)for(const actor of [A,cookie])for(const method of ['GET','HEAD'])assert.equal((await request(method,path,actor)).status,403);
    await stop();await start();assert.equal((await request('GET',model(asset.id),cookie)).status,403);await status(asset.id,'active');const restored=await request('GET',model(asset.id),cookie);ok(restored);assert.equal(hash(restored.bytes),asset.id);
    await status(builtin.sha256,'quarantined');assert.equal((await request('GET',model(builtin.sha256),A)).status,403);await status(builtin.sha256,'active');ok(await request('GET',model(builtin.sha256),cookie));
    return {quarantine_persists_after_restart:true,restored_bytes_unchanged:true};
  });
  await check('unknown scripts aliases extra paths and filesystem traversal cannot resolve a model',async()=>{
    for(const path of [model('f'.repeat(64)),model(script.id),'/admin-models/'+builtin.file,'/admin-models/'+asset.id+'.gd','/admin-models/'+asset.id+'.glb/extra','/admin-models/'+asset.id+'%2fextra.glb','/admin-models/%2F'+resolve(root,'apps/creation-workspace/admin.html').slice(1)]){
      const r=await request('GET',path,A);assert.ok([400,403,404].includes(r.status),'Unexpected path served: '+path);assert.equal(r.headers.get('content-type')?.includes('model/gltf-binary'),false);
    }
    const before=hash((await request('GET',model(asset.id),A)).bytes);for(const method of ['POST','PUT','DELETE'])assert.equal((await request(method,model(asset.id),A,{})).status,405);assert.equal(hash((await request('GET',model(asset.id),A)).bytes),before);
  });
  await check('model preview module is a protected local bundle without open vendor routes',async()=>{
    assert.equal((await request('GET',modulePath,null)).status,401);assert.equal((await request('GET',modulePath,B)).status,401);
    const r=await request('GET',modulePath,cookie);ok(r);assert.match(r.headers.get('content-type'),/(?:text|application)\/javascript/);assert.match(r.headers.get('cache-control'),/no-store/);assert.ok(r.bytes.length>10000,'The Three dependency closure must actually be bundled');
    assert.doesNotMatch(r.value,/(?:import|export)\s[^;]*?\bfrom\s*['"](?:three|https?:\/\/)/);assert.doesNotMatch(r.value,/import\s*\(\s*['"](?:three|https?:\/\/)/);
    for(const path of ['/admin-assets/vendor/three/package.json','/admin-assets/three/package.json','/node_modules/three/package.json','/admin-assets/admin-model-preview.js.map','/admin-assets/package.json'])assert.notEqual((await request('GET',path,cookie)).status,200);
    return {bundle_bytes:r.bytes.length,bundle_sha256:hash(r.bytes),cdn_not_required:true};
  });
  await check('locking and original login expiry revoke model and module cookies',async()=>{
    const old=cookie;ok(await api('POST','/admin/logout',old,{}));assert.equal((await request('GET',model(asset.id),old)).status,401);assert.equal((await request('GET',modulePath,old)).status,401);ok(await request('GET',model(asset.id),A));
    await adminCookie();const bound=cookie;ok(await api('POST','/auth/logout',A,{}));assert.equal((await request('GET',model(asset.id),bound)).status,401);assert.equal((await request('GET',modulePath,bound)).status,401);assert.equal((await request('GET',model(asset.id),A)).status,401);
    A={...ok(await api('POST','/auth/login',null,A.credentials)),credentials:A.credentials};await adminCookie();ok(await request('GET',model(asset.id),cookie));
  });
  await check('corrupt stored bytes reject their immutable identity and recovery preserves the asset',async()=>{
    const file=resolve(data,'creation/assets',asset.id+'.glb');await stop();const corrupt=Buffer.from(privateBytes);corrupt[corrupt.length-1]^=1;writeFileSync(file,corrupt);await start();
    try{for(const method of ['GET','HEAD'])assert.equal((await request(method,model(asset.id),cookie)).status,409);}finally{await stop();writeFileSync(file,privateBytes);await start();}
    const r=await request('GET',model(asset.id),cookie);ok(r);assert.equal(hash(r.bytes),asset.id);assert.equal(ok(await api('GET','/admin/assets/'+asset.id,A)).item.status,'active');return {simulated_corruption_rejected:true,original_bytes_restored:true};
  });
  report.completed=report.cases.every(c=>c.status==='passed');
});
