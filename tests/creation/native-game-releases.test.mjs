import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeGameReleases} from '../../services/creation/native-game-releases.mjs';
import {NativeSourceArchive,NATIVE_SCHEMA,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {GAME_PROJECT_CONTRACT} from '../../services/creation/project-snapshot.mjs';
import {CANONICAL_WEB_POLICY} from '../../tools/canonical-game-web.mjs';
import {hash} from '../../services/creation/schema.mjs';
const evidence=resolve(import.meta.dirname,'../../.local/creation-verification/native-framework/native-game-releases');mkdirSync(evidence,{recursive:true});
const releaseKind='creator_native_game_release',pointerKind='creator_native_game_pointer',requestKind='creator_native_game_release_request';
function fixture(t){
 const data=mkdtempSync(join(evidence,'sqlite-')),store=new CreationStore(join(data,'creation.sqlite'));t.after(()=>store.close());
 const owner=store.register({name:'Owner',password:'native-release-password'}).user,editor=store.register({name:'Editor',password:'native-release-password'}).user,viewer=store.register({name:'Viewer',password:'native-release-password'}).user,player=store.register({name:'Player',password:'native-release-password'}).user;
 const archive=new NativeSourceArchive(join(data,'native-source/objects'));
 const source_files={'project.godot':archive.put('config_version=5\n'),'world.tscn':archive.put('[gd_scene format=3]\n[node name="World" type="Node3D"]\n')};
 const source_identity=nativeSourceIdentity(source_files),manifest={schema:NATIVE_SCHEMA,source_files,source_identity,index_source_identity:source_identity,entry_scene_id:'world',resources:{world:{id:'world',kind:'scene',name:'World',path:'world.tscn',native_nodes:[]},other:{id:'other',kind:'scene',name:'Other',path:'world.tscn',native_nodes:[]}}};
 const created=store.createProject(owner,{name:'Native release fixture'},manifest),p=created.project.id,b='main';
 const project=store.get('creator_project',p);project.members[editor.id]='editor';project.members[viewer.id]='viewer';store.put('creator_project',project);store.publicPlay=true;
 const service={store,data,native:{archive}},releases=new NativeGameReleases({service});
 const advance=()=>{const old=store.branchFor(owner,p,b),revision=store.writeRevision(p,[old.head],manifest,owner.id);store.put('creator_branch',{...old,head:revision.id});return revision.id;};
 const makeJob=(patch={})=>{
  const id='build-'+randomUUID(),source_revision=patch.source_revision??store.branchFor(owner,p,b).head,entry_scene_id=patch.entry_scene_id??'world';
  const base=join(data,'builds',id);mkdirSync(join(base,'web'),{recursive:true});
  const contents={'index.html':'<html>fixed build '+id+'</html>','index.js':'// fixture js','index.pck':'fixture pck','index.wasm':'fixture wasm'};
  const web_files=Object.entries(contents).map(([path,content])=>{const bytes=Buffer.from(content);writeFileSync(join(base,'web',path),bytes);return {path,sha256:hash(bytes),size:bytes.length};});
  const artifact=Buffer.from('synthetic byte fixture archive '+id);writeFileSync(join(base,'web.zip'),artifact);
  const runtime_sources=[{path:'standalone.gd',sha256:hash('runtime'),size:7}],runtime_source_hash=hash(runtime_sources);
  const identity={format:1,contract:GAME_PROJECT_CONTRACT,project_id:p,branch_id:b,source_revision,entry_scene_id,runtime_source_hash};const content_key=hash(identity);
  const job={id,kind:'application',purpose:'play',project_id:p,branch_id:b,source_revision,entry_scene_id,actor_id:owner.id,status:'completed',created_at:Date.now(),game_project_contract:GAME_PROJECT_CONTRACT,game_identity:{...identity,content_key},content_key,canonical_identity:content_key,runtime_sources,runtime_source_hash,source_files:['project.godot','atelier_runtime/standalone.gd','atelier_runtime/standalone.tscn','atelier_runtime/release.json','atelier_runtime/source-manifest.json'].map(path=>({path,sha256:hash(path),size:path.length})),web_files,artifacts:[{id:'web',target:'web',filename:'web.zip',sha256:hash(artifact),size:artifact.length}],target_results:[{target:'web',status:'completed'}],canonical_web:{policy:CANONICAL_WEB_POLICY,content_key,adapted_html_sha256:web_files.find(f=>f.path==='index.html').sha256},web_compatibility:{policy:'world-atelier-single-thread-local-http-v1'},...patch};
  store.put('creator_build',job);return job;
 };
 const request=(job,extra={})=>({request_id:'publish-'+randomUUID(),build_id:job.id,source_revision:job.source_revision,entry_scene_id:job.entry_scene_id,expected_pointer_version:releases.pointer(p,b,job.entry_scene_id)?.version??null,...extra});
 return {data,store,owner,editor,viewer,player,manifest,p,b,releases,makeJob,request,advance};
}
const status=code=>error=>error.status===code;

test('completed builds are private until explicit owner/editor publication and player sees only current release',t=>{
 const f=fixture(t),job=f.makeJob(),input=f.request(job),head=f.store.branchFor(f.owner,f.p,f.b).head;
 assert.equal(f.releases.published(f.player,f.p,f.b,'world'),null);assert.deepEqual(f.releases.list(f.player,f.p,f.b).releases,[]);assert.throws(()=>f.releases.authorizeBuild(f.player,job),status(403));
 for(const user of [f.viewer,f.player])assert.throws(()=>f.releases.publish(user,f.p,f.b,input),status(403));
 assert.ok(f.releases.list(f.owner,f.p,f.b).publishable_build_ids.includes(job.id));
 const result=f.releases.publish(f.editor,f.p,f.b,input);assert.equal(result.release.build_id,job.id);assert.equal(f.releases.published(f.player,f.p,f.b,'world').game_build_id,job.id);assert.equal(f.releases.authorizeBuild(f.player,job).game_build_id,job.id);
 assert.equal(f.store.branchFor(f.owner,f.p,f.b).head,head);assert.equal(f.store.list(releaseKind).length,1);assert.equal(f.store.list(requestKind).length,1);
 const publicList=f.releases.list(f.player,f.p,f.b);assert.equal(publicList.can_publish,false);assert.deepEqual(publicList.publishable_build_ids,[]);assert.equal(publicList.releases.length,1);assert.equal(publicList.releases[0].web_files,undefined);
});

test('publication fixes exact build identity, preserves old history and does not follow source or later successful builds',t=>{
 const f=fixture(t),first=f.makeJob(),input=f.request(first),r1=f.releases.publish(f.owner,f.p,f.b,input),raw1=f.store.get(releaseKind,r1.release.id);
 f.advance();const unpublished=f.makeJob(),sameSourceOther=f.makeJob({source_revision:first.source_revision});
 assert.equal(f.releases.published(f.player,f.p,f.b,'world').game_build_id,first.id);for(const job of [unpublished,sameSourceOther])assert.throws(()=>f.releases.authorizeBuild(f.player,job),status(403));
 const second=f.releases.publish(f.editor,f.p,f.b,f.request(unpublished));assert.equal(f.releases.published(f.player,f.p,f.b,'world').game_build_id,unpublished.id);assert.throws(()=>f.releases.authorizeBuild(f.player,first),status(403));
 assert.deepEqual(f.store.get(releaseKind,raw1.id),raw1);assert.equal(f.releases.list(f.owner,f.p,f.b).releases.length,2);assert.equal(f.releases.list(f.player,f.p,f.b).releases.length,1);assert.equal(second.release.previous_release_id,raw1.id);
 const replay=f.releases.publish(f.owner,f.p,f.b,input);assert.equal(replay.replayed,true);assert.equal(replay.release.id,r1.release.id);assert.equal(f.releases.published(f.player,f.p,f.b,'world').game_build_id,unpublished.id);assert.equal(f.store.list(releaseKind).length,2);
});

test('idempotency is actor-scoped and exact; current permission is checked before replay',t=>{
 const f=fixture(t),job=f.makeJob(),input=f.request(job);const result=f.releases.publish(f.owner,f.p,f.b,input);
 assert.equal(f.releases.publish(f.owner,f.p,f.b,input).release.id,result.release.id);assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,{...input,expected_pointer_version:result.pointer.version}),status(409));
 assert.throws(()=>f.releases.publish(f.editor,f.p,f.b,input),status(409));
 const p=f.store.get('creator_project',f.p);delete p.members[f.owner.id];f.store.put('creator_project',p);assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,input),status(403));
});

test('competing pointer updates reject stale confirmation and independent entries have independent versions',t=>{
 const f=fixture(t),a=f.makeJob(),b=f.makeJob(),aInput=f.request(a),bInput=f.request(b);f.releases.publish(f.owner,f.p,f.b,aInput);
 assert.throws(()=>f.releases.publish(f.editor,f.p,f.b,bInput),error=>error.status===409&&error.details.code==='native_game_release_conflict');
 const other=f.makeJob({entry_scene_id:'other'});f.releases.publish(f.editor,f.p,f.b,f.request(other));assert.equal(f.releases.list(f.player,f.p,f.b).pointers.length,2);assert.equal(f.releases.published(f.player,f.p,f.b,'world').game_build_id,a.id);
});

test('failed, partial, queued, source, preview and noncanonical builds cannot be published',t=>{
 const f=fixture(t);
 for(const patch of [{status:'failed'},{status:'partial'},{status:'queued'},{kind:'source'},{purpose:'native_preview'},{purpose:'native_shared'},{canonical_web:{policy:'preview'}},{game_project_contract:'old-model-preview'},{target_results:[{target:'web',status:'failed'}]},{web_files:[]}]){const job=f.makeJob(patch);assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,f.request(job)));}
 assert.equal(f.store.list(releaseKind).length,0);assert.equal(f.store.list(pointerKind).length,0);assert.equal(f.store.list(requestKind).length,0);
});

test('wrong source, entry, scope, source schema and game identity are rejected',t=>{
 const f=fixture(t),job=f.makeJob();
 for(const extra of [{source_revision:'src-wrong'},{entry_scene_id:'other'},{expected_pointer_version:'invalid'}])assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,f.request(job,extra)));
 const outside=f.makeJob({branch_id:'other'});assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,f.request(outside)),status(409));
 const altered=f.makeJob();altered.game_identity.entry_scene_id='other';f.store.put('creator_build',altered);assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,f.request(altered)),status(409));
 const fixed=f.store.get('creator_revision',job.source_revision);fixed.manifest.schema='creation-flat-1';f.store.put('creator_revision',fixed);assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,f.request(job)),status(422));
});

test('actual changed, missing and symlink Web bytes reject publication and published access',t=>{
 const f=fixture(t),job=f.makeJob(),path=join(f.data,'builds',job.id,'web/index.pck'),bytes=readFileSync(path),input=f.request(job);
 writeFileSync(path,'changed');assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,input),status(409));writeFileSync(path,bytes);
 const result=f.releases.publish(f.owner,f.p,f.b,input);assert.ok(result.release);
 writeFileSync(path,Buffer.alloc(bytes.length));assert.throws(()=>f.releases.published(f.player,f.p,f.b,'world'),status(409));writeFileSync(path,bytes);
 unlinkSync(path);symlinkSync(join(f.data,'builds',job.id,'web/index.js'),path);assert.throws(()=>f.releases.published(f.player,f.p,f.b,'world'),status(409));unlinkSync(path);assert.throws(()=>f.releases.published(f.player,f.p,f.b,'world'),status(409));
});

test('post-publication mutable job identity cannot replace fixed release contents',t=>{
 const f=fixture(t),job=f.makeJob();f.releases.publish(f.owner,f.p,f.b,f.request(job));
 job.source_files[0].sha256=hash('changed');f.store.put('creator_build',job);assert.throws(()=>f.releases.published(f.player,f.p,f.b,'world'),status(409));
});

test('receipt, immutable release, pointer and activity commit atomically',t=>{
 const f=fixture(t),job=f.makeJob(),before=f.store.activity(f.p),put=f.store.put.bind(f.store);f.store.put=(kind,item)=>{if(kind===requestKind)throw Error('isolated receipt write failure');return put(kind,item);};
 assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,f.request(job)),/receipt write failure/);f.store.put=put;
 for(const kind of [releaseKind,pointerKind,requestKind])assert.equal(f.store.list(kind).length,0);assert.deepEqual(f.store.activity(f.p),before);
});

test('permission and branch reachability are rechecked after byte verification before commit',t=>{
 const f=fixture(t),job=f.makeJob(),verify=f.releases.verifyBytes.bind(f.releases);f.releases.verifyBytes=snapshot=>{verify(snapshot);const p=f.store.get('creator_project',f.p);delete p.members[f.editor.id];f.store.put('creator_project',p);};
 assert.throws(()=>f.releases.publish(f.editor,f.p,f.b,f.request(job)),status(403));assert.equal(f.store.list(releaseKind).length,0);
 f.releases.verifyBytes=snapshot=>{verify(snapshot);const branch=f.store.branchFor(f.owner,f.p,f.b);const unrelated=f.store.writeRevision(f.p,[],f.manifest,f.owner.id);f.store.put('creator_branch',{...branch,head:unrelated.id});};
 assert.throws(()=>f.releases.publish(f.owner,f.p,f.b,f.request(job)),status(409));assert.equal(f.store.list(releaseKind).length,0);
});

test('public access rechecks account and project permissions without altering old shared-world records',t=>{
 const f=fixture(t),job=f.makeJob(),legacy={id:'retained-world',project_id:f.p,branch_id:f.b,resource_id:'legacy',release_id:'legacy-shared-release'};f.store.put('creator_world',legacy);f.store.put('creator_release',{id:'legacy-shared-release',marker:'unchanged'});
 f.releases.publish(f.owner,f.p,f.b,f.request(job));const p=f.store.get('creator_project',f.p);p.public_play=false;f.store.put('creator_project',p);assert.throws(()=>f.releases.published(f.player,f.p,f.b,'world'),status(403));assert.deepEqual(f.store.get('creator_world',legacy.id),legacy);assert.deepEqual(f.store.get('creator_release','legacy-shared-release'),{id:'legacy-shared-release',marker:'unchanged'});
});

test('default public entry follows only the newest explicit publication, even when unpublished source deletes the old default',t=>{
 const f=fixture(t),first=f.makeJob();f.releases.publish(f.owner,f.p,f.b,f.request(first));
 const branch=f.store.branchFor(f.owner,f.p,f.b),manifest=structuredClone(f.manifest);manifest.entry_scene_id='other';delete manifest.resources.world;
 const revision=f.store.writeRevision(f.p,[branch.head],manifest,f.owner.id);f.store.put('creator_branch',{...branch,head:revision.id});
 assert.equal(f.releases.published(f.player,f.p,f.b,null).resource_id,'world');assert.equal(f.releases.published(f.player,f.p,f.b,null).source_revision,first.source_revision);
 assert.equal(f.releases.published(f.player,f.p,f.b,'world').game_build_id,first.id);assert.equal(f.releases.published(f.player,f.p,f.b,'other'),null);
 const second=f.makeJob({entry_scene_id:'other'});assert.equal(f.releases.published(f.player,f.p,f.b,null).game_build_id,first.id);
 const published=f.releases.publish(f.editor,f.p,f.b,f.request(second));assert.equal(published.pointer.publication_sequence,2);assert.equal(f.releases.published(f.player,f.p,f.b,null).game_build_id,second.id);assert.equal(f.releases.published(f.player,f.p,f.b,'world').game_build_id,first.id);
});

test('stored release metadata cannot contradict its fixed snapshot hash',t=>{
 const f=fixture(t),job=f.makeJob(),result=f.releases.publish(f.owner,f.p,f.b,f.request(job)),stored=f.store.get(releaseKind,result.release.id);stored.canonical_identity=hash('tampered');f.store.put(releaseKind,stored);assert.throws(()=>f.releases.published(f.player,f.p,f.b,null),status(409));
});

test('published fixed source remains readable after a branch reset and is revoked by a new publication',t=>{
 const f=fixture(t),first=f.makeJob();f.releases.publish(f.owner,f.p,f.b,f.request(first));
 const branch=f.store.branchFor(f.owner,f.p,f.b),reset=f.store.writeRevision(f.p,[],f.manifest,f.owner.id);f.store.put('creator_branch',{...branch,head:reset.id});
 assert.equal(f.store.ancestor(first.source_revision,reset.id),false);
 assert.equal(f.releases.authorizeSource(f.player,f.p,f.b,first.source_revision).game_build_id,first.id);
 assert.throws(()=>f.releases.authorizeSource(f.player,f.p,f.b,reset.id),status(403));
 const second=f.makeJob(),input=f.request(second);input.expected_pointer_version=f.releases.pointer(f.p,f.b,'world').version;f.releases.publish(f.owner,f.p,f.b,input);
 assert.throws(()=>f.releases.authorizeSource(f.player,f.p,f.b,first.source_revision),status(403));
 assert.equal(f.releases.authorizeSource(f.player,f.p,f.b,reset.id).game_build_id,second.id);
});

test('GET and explicit POST game-releases dispatch through real auth and isolated SQLite without a listening port',async t=>{
 const {CreationService}=await import('../../services/creation/service.mjs'),{Readable}=await import('node:stream');const f=fixture(t),job=f.makeJob(),service=Object.create(CreationService.prototype);Object.assign(service,{store:f.store,gameReleases:f.releases,origin:'http://isolated.test'});
 // These unrelated dispatchers were added after this narrow router fixture.
 // Keep real auth/publication behavior while explicitly declining their routes.
 Object.assign(service,{runtimeAccess:{network:{runtimeRequestOrigin:()=>null}},nativeClients:{request:()=>false},observations:{request:()=>false},continuations:{request:()=>false}});
 const tokens=new Map([f.owner,f.player].map(user=>[user.id,f.store.issueLogin(f.store.get('creator_user',user.id)).token]));
 const request=async(method,user,input)=>{const req=Readable.from(input?[Buffer.from(JSON.stringify(input))]:[]);Object.assign(req,{method,url:'/creation-api/projects/'+f.p+'/branches/main/game-releases',headers:{authorization:'Bearer '+tokens.get(user.id),host:'isolated.test',origin:'http://isolated.test'}});const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(text){this.body=JSON.parse(text);}};assert.equal(await service.request(req,res),true);return res;};
 assert.equal((await request('GET',f.player)).body.releases.length,0);const input=f.request(job);assert.equal((await request('POST',f.player,input)).status,403);const published=await request('POST',f.owner,input);assert.equal(published.status,201);assert.equal((await request('POST',f.owner,input)).status,200);const current=await request('GET',f.player);assert.equal(current.status,200);assert.equal(current.body.releases[0].build_id,job.id);
});
