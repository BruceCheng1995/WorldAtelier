/** N/A only: actual SQLite/files and product access classes; Web bytes are an
 * explicitly synthetic authorization fixture, no Godot or browser execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationService} from '../../services/creation/service.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {mappedRuntimeOrigin,workspaceNetwork} from '../../services/preview/network.mjs';
import {runtimeSaveDomain} from '../../services/creation/runtime-access.mjs';
import {seedRuntimeFixture} from './next-wave-runtime-fixture.mjs';
import {ROOT,ORIGIN,PORT} from './next-wave-test-support.mjs';

function fixture(t){
  const data=mkdtempSync(join(tmpdir(),'atelier-next-wave-runtime-unit-')),creation=join(data,'creation'),seed=seedRuntimeFixture(creation),server=createServer();
  const saved={agent:process.env.WORLD_ATELIER_DISABLE_AGENT,worlds:process.env.WORLD_ATELIER_DISABLE_WORLDS};let service;
  try{process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';service=new CreationService({server,root:ROOT,data:creation,origin:ORIGIN,publicPlay:true});}
  finally{for(const [name,value] of [['WORLD_ATELIER_DISABLE_AGENT',saved.agent],['WORLD_ATELIER_DISABLE_WORLDS',saved.worlds]])if(value===undefined)delete process.env[name];else process.env[name]=value;}
  t.after(async()=>{await service.close();server.close();rmSync(data,{recursive:true,force:true});});
  const creatorRequest=(actor=seed.accounts.owner)=>({method:'POST',url:`/creation-api/builds/${seed.job.id}/access`,headers:{host:`127.0.0.1:${PORT}`,origin:ORIGIN,authorization:`Bearer ${actor.token}`},socket:{localAddress:'127.0.0.1'}});
  const response=()=>({headers:{},setHeader(name,value){this.headers[name.toLowerCase()]=value;},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);},end(value){this.body=value;}});
  const issue=(actor=seed.accounts.owner)=>service.builds.access(actor.user,seed.job.id,response(),creatorRequest(actor));
  const runtimeRequest=access=>({method:'GET',url:new URL(access.web_url).pathname,headers:{host:new URL(access.runtime_origin).host},socket:{localAddress:'127.0.0.1'}});
  const token=access=>new URL(access.web_url).pathname.split('/')[2];
  return {...seed,data,service,creatorRequest,runtimeRequest,response,issue,token};
}

test('I01 loopback uses a dedicated secure origin and mapped addresses remain runtime-only',()=>{
  const network=workspaceNetwork(PORT,{WORLD_ATELIER_LAN:'0'}),mapped=mappedRuntimeOrigin(ORIGIN,'127.0.0.1');
  assert.equal(mapped,`http://[::ffff:7f00:1]:${PORT}`);assert.notEqual(mapped,ORIGIN);
  const creator={headers:{host:`127.0.0.1:${PORT}`},socket:{localAddress:'127.0.0.1'}},runtime={headers:{host:new URL(mapped).host}};
  assert.equal(network.requestOrigin(creator),ORIGIN);assert.equal(network.runtimeOriginFor(creator),`http://wa-runtime.localhost:${PORT}`);
  assert.equal(network.requestOrigin({headers:{host:`wa-runtime.localhost:${PORT}`}}),null);assert.equal(network.runtimeRequestOrigin({headers:{host:`wa-runtime.localhost:${PORT}`}}),`http://wa-runtime.localhost:${PORT}`);
  assert.equal(network.requestOrigin(runtime),null);assert.equal(network.runtimeRequestOrigin(runtime),mapped);
  for(const host of [`127.0.0.1:${PORT}`,`[::ffff:c000:201]:${PORT}`,`[::ffff:7f00:1]:48910`,`user@127.0.0.1:${PORT}`,`[::ffff:7f00:1]:${PORT}/creation-api`])assert.equal(network.runtimeRequestOrigin({headers:{host}}),null);
});

test('I03 launch is exact-build, login-bound, time-bounded and carries no creator token',t=>{
  const f=fixture(t),access=f.issue(),grant=f.service.store.get('creator_runtime_access',hash(f.token(access)));
  assert.equal(access.policy,'wa-runtime-origin-1');assert.equal(access.build_id,f.job.id);assert.equal(access.parent_origin,ORIGIN);
  assert.equal(access.runtime_origin,`http://wa-runtime.localhost:${PORT}`);assert.equal(grant.login_id,hash(f.accounts.owner.token));
  assert.ok(grant.expires_at>grant.created_at&&grant.expires_at<=grant.created_at+10*60*1000);
  assert.equal(grant.job_id,f.job.id);assert.equal(grant.source_revision,f.job.source_revision);assert.equal(grant.canonical_identity,f.job.canonical_identity);
  assert.ok(!JSON.stringify(access).includes(f.accounts.owner.token));assert.equal(f.service.runtimeAccess.authorize(f.token(access),f.runtimeRequest(access)).job.id,f.job.id);
});

test('I02 every non-runtime route remains denied under the runtime Host even with creator credentials',t=>{
  const f=fixture(t),access=f.issue();
  for(const path of ['/creation-api/bootstrap','/creation-api/admin/overview','/admin','/creation-workspace.html','/preview-assets/secret.glb','/ws/creation']){
    const req={...f.runtimeRequest(access),url:path,headers:{...f.runtimeRequest(access).headers,authorization:`Bearer ${f.accounts.owner.token}`,cookie:'wa_admin=synthetic'}};
    assert.throws(()=>f.service.runtimeAccess.request(req,f.response()),error=>error.status===403,path);
  }
});

test('I03 wrong runtime origin, token, URL build and source identity cannot reuse a grant',t=>{
  const f=fixture(t),access=f.issue(),req=f.runtimeRequest(access);
  assert.throws(()=>f.service.runtimeAccess.authorize('invalid',req),error=>error.status===403);
  assert.throws(()=>f.service.runtimeAccess.authorize(f.token(access),{...req,headers:{host:`127.0.0.1:${PORT}`}}),error=>error.status===403);
  assert.throws(()=>f.service.runtimeAccess.request({...req,url:req.url.replace(f.job.id,'build-00000000-0000-0000-0000-000000000000')},f.response()),error=>error.status===403);
  const job=f.service.store.get('creator_build',f.job.id);job.source_revision='src-other';f.service.store.put('creator_build',job);
  assert.throws(()=>f.service.runtimeAccess.authorize(f.token(access),req),error=>error.status===409);
});

test('I03 expired and logged-out grants reject before resource access and renewal',t=>{
  const f=fixture(t),expired=f.issue(),grant=f.service.store.get('creator_runtime_access',hash(f.token(expired)));
  grant.expires_at=Date.now()-1;f.service.store.put('creator_runtime_access',grant);
  assert.throws(()=>f.service.runtimeAccess.authorize(f.token(expired),f.runtimeRequest(expired)),error=>error.status===403);
  const logged=f.issue();f.service.store.remove('creator_login',hash(f.accounts.owner.token));
  assert.throws(()=>f.service.runtimeAccess.authorize(f.token(logged),f.runtimeRequest(logged)),error=>error.status===403);
});

test('I03 membership is rechecked on every resource request, not only at access issuance',t=>{
  const f=fixture(t),access=f.issue(f.accounts.editor),project=f.service.store.get('creator_project',f.project_id);
  delete project.members[f.accounts.editor.user.id];project.public_play=false;f.service.store.put('creator_project',project);
  assert.throws(()=>f.service.runtimeAccess.authorize(f.token(access),f.runtimeRequest(access)),error=>error.status===403);
});

test('I03 viewer may launch readable private source; player cannot launch an unpublished build',t=>{
  const f=fixture(t);assert.equal(f.issue(f.accounts.viewer).build_id,f.job.id);
  assert.throws(()=>f.issue(f.accounts.player),error=>error.status===403||error.status===422);
});

test('I04 unlisted paths and static-preview purpose cannot receive executable-game grants',t=>{
  const f=fixture(t),access=f.issue();
  assert.throws(()=>f.service.runtimeAccess.request({...f.runtimeRequest(access),url:new URL(access.web_url).pathname.replace('launch.html','web/unlisted.js')},f.response()),error=>error.status===404);
  assert.throws(()=>f.service.runtimeAccess.issue(f.accounts.owner.user,{...f.job,purpose:'native_preview'},f.creatorRequest()),error=>error.status===400);
});

test('I03 renewal accepts only the bound runtime Origin and does not alter fixed identity',t=>{
  const f=fixture(t),access=f.issue(),req=f.runtimeRequest(access),url=req.url.replace('launch.html','renew');
  assert.throws(()=>f.service.runtimeAccess.request({...req,method:'POST',url,headers:{...req.headers,origin:ORIGIN}},f.response()),error=>error.status===403);
  const res=f.response();f.service.runtimeAccess.request({...req,method:'POST',url,headers:{...req.headers,origin:access.runtime_origin}},res);assert.equal(res.status,200);
  const grant=f.service.store.get('creator_runtime_access',hash(f.token(access)));assert.equal(grant.canonical_identity,f.job.canonical_identity);assert.equal(grant.launch_nonce,access.launch_nonce);
});

test('S02 normal and custom Godot save prefixes derive only from fixed project bytes',t=>{
  const f=fixture(t),domain=runtimeSaveDomain(f.service.builds,f.job);
  assert.equal(domain.database,'/userfs');assert.equal(domain.prefix,'/userfs/godot/app_userdata/Independent origin fixture');
  const path=join(f.creationData,'builds',f.job.id,'project/project.godot');
  const custom='config_version=5\n[application]\nconfig/name="Different name"\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="games/example"\n';
  writeFileSync(path,custom);assert.equal(runtimeSaveDomain(f.service.builds,f.job),null,'Changed bytes must not reinterpret a pinned grant.');
  const pinned={...f.job,source_files:[{path:'project.godot',sha256:hash(custom),size:Buffer.byteLength(custom)}]};assert.equal(runtimeSaveDomain(f.service.builds,pinned).prefix,'/userfs/games/example');
});

test('I03 legacy creator-origin URL cannot mint a login-unbound grant after logout',t=>{
  const f=fixture(t);f.service.store.remove('creator_login',hash(f.accounts.owner.token));
  const req={method:'GET',url:`/creation-releases/${f.job.id}/web/index.html`,headers:{host:`127.0.0.1:${PORT}`,cookie:`atelier_release=${f.legacyToken}`},socket:{localAddress:'127.0.0.1'}};
  assert.throws(()=>f.service.builds.webRequest(req,f.response()),error=>[401,403].includes(error.status),'Historical bearer cookies must require fresh creator authorization instead of minting an unbound grant.');
});
