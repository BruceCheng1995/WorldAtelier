import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { CreationStore } from '../../services/creation/store.mjs';
import { CreationBuilds } from '../../services/creation/export-builds.mjs';
import { projectPolicyInventory } from '../../services/creation/project-policy.mjs';
import { gameStorage,snapshotProjectRuntime } from '../../services/creation/project-snapshot.mjs';
import { hash } from '../../services/creation/schema.mjs';
import { adaptCanonicalGameWeb } from '../../tools/canonical-game-web.mjs';
import { createCreationBackup,verifyCreationBackup,restoreCreationBackup } from '../../tools/backup-creation.mjs';
const root=resolve(import.meta.dirname,'../..');
// These fixtures exercise real storage/hash/authorization mechanisms. Their tiny
// template/executable files are not runnable Godot and are not runtime evidence.
function fixture(t){
  const base=mkdtempSync(join(tmpdir(),'atelier-canonical-project-')),source=join(base,'source'),data=join(base,'data');
  for(const directory of ['runtimes/model-preview/fonts','tools/release-template','services/creation'])mkdirSync(join(source,directory),{recursive:true});
  for(const file of projectPolicyInventory(root).files){const target=join(source,file.path);mkdirSync(resolve(target,'..'),{recursive:true});cpSync(join(root,file.path),target);}
  for(const file of ['project-snapshot.mjs','export-builds.mjs'])cpSync(join(root,'services/creation',file),join(source,'services/creation',file));
  for(const file of ['godot-web-compatibility.mjs','canonical-game-web.mjs'])cpSync(join(root,'tools',file),join(source,'tools',file));
  for(const file of ['scene_loader.gd','runtime_capabilities.json','main.gd','world_client.gd'])writeFileSync(join(source,'runtimes/model-preview',file),file==='runtime_capabilities.json'?'{}':'# explicit inert fixture '+file);
  writeFileSync(join(source,'tools/release-template/standalone.gd'),'# explicit inert canonical template');
  const store=new CreationStore(join(data,'creation.sqlite'));
  const owner={id:'owner'},editor={id:'editor'},player={id:'player'};
  for(const user of [owner,editor,player])store.put('creator_user',{...user,name:user.id});
  const project=store.createProject(owner,{name:'Original Game'},{entry_scene_id:'first',resources:{first:{id:'first',kind:'scene',name:'First',objects:[]},second:{id:'second',kind:'scene',name:'Second',objects:[]}}}).project.id;
  const p=store.get('creator_project',project);p.members.editor='editor';store.put('creator_project',p);store.publicPlay=true;
  let playable=store.branchFor(owner,project,'main').head;
  const service={root:source,data,origin:'http://127.0.0.1:48921',store,worlds:{playable(){return {source_revision:playable};}}};
  const builds=new CreationBuilds({service});builds.pump=()=>{};
  builds.godot=join(base,'fixture-godot');writeFileSync(builds.godot,'FAKE NOT EXECUTABLE GODOT');builds.templates=join(base,'templates');mkdirSync(builds.templates);writeFileSync(join(builds.templates,'web_nothreads_release.zip'),'FAKE NOT A GODOT TEMPLATE');
  t.after(async()=>{await builds.close();store.close();rmSync(base,{recursive:true,force:true});});
  return {base,source,data,store,owner,editor,player,project,service,builds,revision:playable,setPlayable(value){playable=value;}};
}
function prepare(f,user=f.owner,input={}){return f.builds.preparePlay(user,f.project,'main',{source_revision:f.revision,entry_scene_id:'first',...input});}
function completedWeb(f,id){
  const job=f.store.get('creator_build',id),dir=join(f.builds.directory,id,'web');mkdirSync(dir,{recursive:true});
  const bytes=Buffer.from('EXPLICIT FAKE ARTIFACT FOR CACHE INTEGRITY TEST');writeFileSync(join(dir,'index.html'),bytes);
  job.status='completed';job.web_files=[{path:'index.html',size:bytes.length,sha256:hash(bytes)}];job.artifacts=[{target:'web',id:'web'}];f.store.put('creator_build',job);return job;
}

test('canonical snapshot excludes editor host and pins one native startup with shared dependencies',t=>{
  const f=fixture(t),directory=join(f.base,'snapshot'),snapshot=snapshotProjectRuntime(f.source,directory),paths=snapshot.files.map(f=>f.path);
  assert.ok(paths.includes('standalone.gd'));assert.ok(paths.includes('scene_loader.gd'));assert.ok(!paths.includes('main.gd'));assert.ok(!paths.includes('world_client.gd'));
  const config=readFileSync(join(directory,'project.godot'),'utf8');assert.match(config,/GameRuntime="\*res:\/\/standalone.gd"/);assert.match(config,/run\/main_scene="res:\/\/standalone.tscn"/);
});
test('one immutable full key reuses queued and complete Web across authorized users',t=>{
  const f=fixture(t),one=prepare(f),two=prepare(f,f.editor);assert.equal(two.reused,true);assert.equal(two.job.id,one.job.id);assert.equal(one.job.content_key,one.job.canonical_identity);assert.equal(one.job.content_key,one.job.game_identity.content_key);
  completedWeb(f,one.job.id);const three=prepare(f,f.player);assert.equal(three.reused,true);assert.equal(three.job.id,one.job.id);
});
test('same source cannot reuse changed runtime, actual template, generator policy or entry',t=>{
  const f=fixture(t),ids=new Set();ids.add(prepare(f).job.id);
  writeFileSync(join(f.source,'tools/release-template/standalone.gd'),'# changed runtime');ids.add(prepare(f).job.id);
  writeFileSync(join(f.builds.templates,'web_nothreads_release.zip'),'different template bytes');ids.add(prepare(f).job.id);
  writeFileSync(join(f.source,'tools/canonical-game-web.mjs'),'// changed transform policy');ids.add(prepare(f).job.id);
  ids.add(prepare(f,f.owner,{entry_scene_id:'second'}).job.id);assert.equal(ids.size,5);
});
test('corrupt retained Web artifact is rejected for reuse even with an exact metadata key',t=>{
  const f=fixture(t),one=prepare(f);completedWeb(f,one.job.id);writeFileSync(join(f.builds.directory,one.job.id,'web/index.html'),'changed');const two=prepare(f);assert.equal(two.reused,false);assert.notEqual(two.job.id,one.job.id);
});
test('player can prepare only authorized playable source and cannot create or download exports',t=>{
  const f=fixture(t),branch=f.store.branchFor(f.owner,f.project,'main'),next=f.store.writeRevision(f.project,[branch.head],f.store.get('creator_revision',branch.head).manifest,f.owner.id);f.store.put('creator_branch',{...branch,head:next.id});
  assert.throws(()=>prepare(f,f.player,{source_revision:next.id}),{status:403});
  const play=prepare(f,f.player);assert.equal(play.job.source_revision,f.revision);
  assert.throws(()=>f.builds.create(f.player,f.project,'main',{confirmed:true,kind:'source',request_id:'export',source_revision:f.revision}),{status:403});
  assert.throws(()=>f.builds.download(f.player,play.job.id,'web',{},{}),{status:403});
  f.setPlayable(next.id);assert.throws(()=>f.builds.forUser(f.player,play.job.id),{status:403});
});
// Permission/cache fixtures above are explicitly inert; these assert no native
// scene execution. Actual canonical Web execution has separate Godot evidence.
test('native public Play requires an explicit release and authorizes its exact fixed build',t=>{
  const f=fixture(t),branch=f.store.branchFor(f.owner,f.project,'main'),old=f.store.get('creator_revision',branch.head);
  const next=f.store.writeRevision(f.project,[old.id],{...old.manifest,schema:'creation-native-1'},f.owner.id);f.store.put('creator_branch',{...branch,head:next.id});f.revision=next.id;
  f.service.worlds.playable=()=>{throw Error('must not enter shared engine');};
  assert.throws(()=>prepare(f,f.player),e=>e.status===422&&e.details?.code==='game_release_unavailable');
  const first=prepare(f),completed=completedWeb(f,first.job.id);
  assert.throws(()=>prepare(f,f.player),e=>e.status===422&&e.details?.code==='game_release_unavailable');
  // Explicit orchestration fixture only. NativeGameReleases tests cover the
  // actual publication transaction, fixed source closure and real Web bytes.
  let published={source_revision:next.id,resource_id:'first',game_build_id:completed.id,canonical_identity:completed.canonical_identity};
  f.service.gameReleases={published:()=>published,authorizeBuild(user,job){if(job.id!==published.game_build_id)throw Object.assign(Error('not published'),{status:403});return published;}};
  assert.equal(f.builds.playableGame(f.player,f.project,'main','first').game_build_id,completed.id);
  writeFileSync(join(f.source,'tools/canonical-game-web.mjs'),'// later editor toolchain');
  assert.equal(prepare(f,f.player).job.id,completed.id);
  const latest=f.store.writeRevision(f.project,[next.id],next.manifest,f.owner.id);f.store.put('creator_branch',{...branch,head:latest.id});
  assert.equal(f.builds.playableGame(f.player,f.project,'main','first').source_revision,next.id);
  assert.throws(()=>prepare(f,f.player,{source_revision:latest.id}),{status:403});
  assert.throws(()=>f.builds.authorizeNativePreview(f.player,f.project,'main',next.id),{status:403});
  assert.equal(f.builds.forUser(f.player,completed.id).id,completed.id);
  const sibling=prepare(f),other=completedWeb(f,sibling.job.id);
  assert.notEqual(other.id,completed.id);
  assert.throws(()=>f.builds.forUser(f.player,other.id),{status:403});
  published={...published,game_build_id:other.id,canonical_identity:other.canonical_identity};
  assert.throws(()=>f.builds.forUser(f.player,completed.id),{status:403});
  assert.equal(f.builds.forUser(f.player,other.id).id,other.id);
  const reset=f.store.writeRevision(f.project,[],latest.manifest,f.owner.id);f.store.put('creator_branch',{...branch,head:reset.id});
  assert.equal(f.store.ancestor(next.id,reset.id),false);
  assert.equal(prepare(f,f.player).job.id,other.id);
});
test('native source viewer can prepare an independent run while export writes remain forbidden',t=>{
  const f=fixture(t),branch=f.store.branchFor(f.owner,f.project,'main'),old=f.store.get('creator_revision',branch.head);
  const next=f.store.writeRevision(f.project,[old.id],{...old.manifest,schema:'creation-native-1'},f.owner.id);f.store.put('creator_branch',{...branch,head:next.id});f.revision=next.id;
  const project=f.store.get('creator_project',f.project);project.members.player='viewer';f.store.put('creator_project',project);
  f.service.worlds.playable=()=>{throw Error('must not enter shared engine');};
  assert.equal(prepare(f,f.player).job.source_revision,next.id);
  assert.throws(()=>f.builds.create(f.player,f.project,'main',{confirmed:true,kind:'source',request_id:'viewer-export',source_revision:next.id}),{status:403});
});
test('deduped Play execution rechecks requester permissions and stops after all are revoked',t=>{
  const f=fixture(t),first=prepare(f);prepare(f,f.player);const user=f.store.get('creator_user',f.owner.id);f.store.put('creator_user',{...user,disabled_at:Date.now()});
  const job=f.store.get('creator_build',first.job.id);assert.equal(f.builds.executionUser(job).id,f.player.id);
  f.store.put('creator_user',{...f.store.get('creator_user',f.player.id),disabled_at:Date.now()});assert.throws(()=>f.builds.executionUser(job),{status:403});
});
test('save domain survives rename, preserves legacy exported namespace and leaves old records untouched',t=>{
  const f=fixture(t),legacy={id:'build-11111111',project_id:f.project,branch_id:'main',project_name:'Already Saved Game',status:'completed',created_at:1};f.store.put('creator_build',legacy);
  const storage=gameStorage(f.service,f.project,'main');assert.equal(storage.namespace,'Already Saved Game');
  f.store.put('creator_project',{...f.store.get('creator_project',f.project),name:'Renamed Game'});
  assert.deepEqual(gameStorage(f.service,f.project,'main'),storage);assert.deepEqual(f.store.get('creator_build',legacy.id),legacy);
});
test('same Web HTML selects memory-only persistence before Engine only for explicit embedded launches',()=>{
  const html='const engine = new Engine(GODOT_CONFIG);',identity={content_key:'a'.repeat(64)},storage={namespace:'game-identity'};
  const adapted=adaptCanonicalGameWeb({html,identity,storage});
  const run=({search,embedded})=>{const window={location:{search}};window.parent=embedded?{}:window;let config;vm.runInNewContext(adapted.html,{window,URLSearchParams,GODOT_CONFIG:{persistentPaths:['/userfs']},Engine:function(value){config=value;}});return {config,launch:window.worldAtelierLaunch};};
  const inEditor=run({search:'?launch=editor&wa_embedded=1&nonce=unique',embedded:true});assert.deepEqual([...inEditor.config.persistentPaths],[]);assert.equal(inEditor.launch.persistence,'memory_only_per_iframe');
  for(const mode of [{search:'',embedded:false},{search:'?launch=editor&wa_embedded=1&nonce=unique',embedded:false},{search:'?launch=editor&wa_embedded=1',embedded:true}])assert.deepEqual([...run(mode).config.persistentPaths],['/userfs']);
});
test('backup retains immutable generated inputs, applications and environment files and restores active jobs interrupted',async t=>{
  const f=fixture(t),pending=prepare(f),job=f.store.get('creator_build',pending.job.id);const bytes=Buffer.from('EXPLICIT INERT ENVIRONMENT PROJECT'),envId='env-22222222',envDir=join(f.data,'environments',envId,'project');mkdirSync(envDir,{recursive:true});writeFileSync(join(envDir,'project.godot'),bytes);
  f.store.put('creator_environment',{id:envId,source_revision:f.revision,runtime_source_hash:hash(bytes),project_hash:hash(bytes),files:[{path:'project.godot',sha256:hash(bytes),size:bytes.length}]});
  const out=join(f.base,'backup');await createCreationBackup({data:f.data,out});await verifyCreationBackup({from:out});
  assert.ok(existsSync(join(out,'data/builds',job.id,'project/standalone.gd')));assert.equal(readFileSync(join(out,'data/environments',envId,'project/project.godot'),'utf8'),bytes.toString());
  const restored=join(f.base,'restored');await restoreCreationBackup({from:out,out:restored});const store=new CreationStore(join(restored,'data/creation.sqlite'));try{assert.equal(store.get('creator_build',job.id).status,'interrupted');assert.equal(store.get('creator_environment',envId).project_directory,join(restored,'data/environments',envId,'project')); assert.equal(store.get('creator_branch',f.project+':main').head,f.revision);}finally{store.close();}
});

test('uncertain Play request replays its fixed job and rejects changed parameters',t=>{
  const f=fixture(t),one=prepare(f,f.owner,{request_id:'reconcile-play'});
  writeFileSync(join(f.source,'tools/release-template/standalone.gd'),'# runtime advanced after first request');
  const again=prepare(f,f.owner,{request_id:'reconcile-play'});assert.equal(again.replayed,true);assert.equal(again.job.id,one.job.id);
  assert.throws(()=>prepare(f,f.owner,{request_id:'reconcile-play',entry_scene_id:'second'}),{status:409});
});

test('running worker retains a new deduped requester across progress writes and permission rechecks',t=>{
  const f=fixture(t),first=prepare(f),workerJob=f.store.get('creator_build',first.job.id);workerJob.status='running';f.store.put('creator_build',workerJob);
  prepare(f,f.player);f.builds.update(workerJob,{progress:35});
  f.store.put('creator_user',{...f.store.get('creator_user',f.owner.id),disabled_at:Date.now()});
  assert.equal(f.builds.executionUser(workerJob).id,f.player.id);assert.ok(f.store.get('creator_build',workerJob.id).authorized_actor_ids.includes(f.player.id));
});

test('compiler dependencies invalidate the game key while docs, tests and local state do not',t=>{
  const f=fixture(t),keys=[prepare(f).job.content_key];
  for(const file of ['services/creation/assets.mjs','services/creation/hierarchy-runtime.mjs','services/creation/hierarchy.mjs','services/creation/hierarchy-view.mjs','packages/scene/transform.mjs','tools/native-editor/bake_preview.gd']){
    writeFileSync(join(f.source,file),readFileSync(join(f.source,file),'utf8')+'\n// compiler revision probe '+file+'\n');
    keys.push(prepare(f).job.content_key);
  }
  assert.equal(new Set(keys).size,7);
  const before=projectPolicyInventory(f.source),paths=before.files.map(file=>file.path);
  for(const file of ['docs/notes.md','tests/fixture.test.mjs','.local/private.json']){const path=join(f.source,file);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,'not compiler input');}
  assert.equal(projectPolicyInventory(f.source).sha256,before.sha256);assert.ok(paths.includes('packages/scene/transform.mjs'));
  assert.ok(paths.every(path=>!path.startsWith('docs/')&&!path.startsWith('tests/')&&!path.startsWith('.local/')));
});
test('compiler dependency graph includes newly imported local modules automatically',t=>{
  const f=fixture(t),file=join(f.source,'services/creation/hierarchy-runtime.mjs'),before=projectPolicyInventory(f.source).sha256;
  writeFileSync(join(f.source,'services/creation/fixture-extra-transform.mjs'),'export const identity = 1;\n');
  writeFileSync(file,"import './fixture-extra-transform.mjs';\n"+readFileSync(file,'utf8'));
  const after=projectPolicyInventory(f.source);assert.notEqual(after.sha256,before);assert.ok(after.files.some(entry=>entry.path==='services/creation/fixture-extra-transform.mjs'));
});

test('actual command runtime fault marker rejects a successful process even after log truncation',async t=>{
  const f=fixture(t),result=prepare(f),job=f.store.get('creator_build',result.job.id);
  await assert.rejects(f.builds.command(job,process.execPath,['-e',"process.stdout.write('STANDALONE_RUNTIME_FAULT explicit failure marker test\\n'+'later output\\n'.repeat(6000))"],join(f.builds.directory,job.id)));
});
