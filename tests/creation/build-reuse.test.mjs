import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';
import {projectPolicyInventory} from '../../services/creation/project-policy.mjs';
import {hash} from '../../services/creation/schema.mjs';

const root=resolve(import.meta.dirname,'../..');
// These private fixtures exercise actual storage, authorization and file hashes.
// Artifact bytes and tools are deliberately inert; this is not Godot execution.
function fixture(t){
  const base=mkdtempSync(join(tmpdir(),'atelier-build-reuse-')),source=join(base,'source'),data=join(base,'data');
  for(const file of projectPolicyInventory(root).files){const out=join(source,file.path);mkdirSync(dirname(out),{recursive:true});cpSync(join(root,file.path),out);}
  for(const directory of ['runtimes/model-preview','tools/release-template'])mkdirSync(join(source,directory),{recursive:true});
  for(const file of ['scene_loader.gd','runtime_capabilities.json'])writeFileSync(join(source,'runtimes/model-preview',file),file.endsWith('.json')?'{}':'# inert scene loader');
  writeFileSync(join(source,'tools/release-template/standalone.gd'),'# inert fixed runtime');
  const store=new CreationStore(join(data,'creation.sqlite')),owner={id:'owner'},editor={id:'editor'},player={id:'player'};
  for(const user of [owner,editor,player])store.put('creator_user',{...user,name:user.id});
  const project=store.createProject(owner,{name:'Build reuse fixture'},{entry_scene_id:'first',resources:{first:{id:'first',kind:'scene',name:'First',objects:[]},second:{id:'second',kind:'scene',name:'Second',objects:[]}}}).project.id;
  const p=store.get('creator_project',project);p.members.editor='editor';store.put('creator_project',p);
  const revision=store.branchFor(owner,project,'main').head;
  const service={root:source,data,origin:'http://127.0.0.1:48921',store};
  const builds=new CreationBuilds({service});builds.pump=()=>{};
  builds.godot=join(base,'inert-godot');writeFileSync(builds.godot,'NOT AN EXECUTABLE');
  builds.templates=join(base,'templates');mkdirSync(builds.templates);
  writeFileSync(join(builds.templates,'web_nothreads_release.zip'),'INERT WEB TEMPLATE');
  writeFileSync(join(builds.templates,'windows_release_x86_64.exe'),'INERT WINDOWS TEMPLATE');
  t.after(async()=>{await builds.close();store.close();rmSync(base,{recursive:true,force:true});});
  return {base,source,data,store,owner,editor,player,project,revision,service,builds};
}
function play(f,user=f.owner){return f.builds.preparePlay(user,f.project,'main',{source_revision:f.revision,entry_scene_id:'first'});}
function input(f,request='export',patch={}){return {confirmed:true,kind:'application',request_id:request,source_revision:f.revision,entry_scene_id:'first',targets:['web'],...patch};}
function create(f,request='export',patch={},user=f.owner){return f.builds.create(user,f.project,'main',input(f,request,patch));}
function complete(f,id,targets=['web'],status='completed'){
  const job=f.store.get('creator_build',id),base=join(f.builds.directory,id);job.status=status;job.artifacts=[];job.target_results=[];
  for(const target of targets){
    const bytes=Buffer.from('INERT ARCHIVE '+target),filename=target+'.zip';writeFileSync(join(base,filename),bytes);
    job.artifacts.push({id:target,target,filename,size:bytes.length,sha256:hash(bytes),download_url:`/creation-api/builds/${id}/artifacts/${target}`});
    job.target_results.push({target,status:'completed'});
    if(target==='web'){
      const directory=join(base,'web');mkdirSync(directory,{recursive:true});
      job.web_files=['index.html','index.js','index.pck','index.wasm'].map(path=>{const bytes=Buffer.from('INERT WEB '+path);writeFileSync(join(directory,path),bytes);return {path,size:bytes.length,sha256:hash(bytes)};});
    }
  }
  f.store.put('creator_build',job);f.builds.queue=f.builds.queue.filter(value=>value!==id);return job;
}
function revoke(f,user){f.store.put('creator_user',{...f.store.get('creator_user',user.id),disabled_at:Date.now()});}

test('completed Play is reused by explicit Web packaging without another queued build',t=>{
  const f=fixture(t),first=play(f);complete(f,first.job.id);
  const before=f.store.list('creator_build').length,result=create(f);
  assert.equal(result.reused,true);assert.equal(result.job.id,first.job.id);
  assert.equal(f.store.list('creator_build').length,before);assert.deepEqual(f.builds.queue,[]);
});
for(const status of ['queued','running'])test(`${status} Play is reused and retains a newly authorized export requester`,t=>{
  const f=fixture(t),first=play(f),worker=f.store.get('creator_build',first.job.id);
  f.builds.update(worker,{status});const before=[...f.builds.queue],result=create(f,'editor-export',{},f.editor);
  assert.equal(result.reused,true);assert.equal(result.job.id,first.job.id);assert.deepEqual(f.builds.queue,before);
  // The running worker can hold a stale object when a new requester joins.
  f.builds.update(worker,{progress:35});revoke(f,f.owner);
  assert.equal(f.builds.executionUser(worker).id,f.editor.id);
  revoke(f,f.editor);assert.throws(()=>f.builds.executionUser(worker),{status:403});
});
test('ordinary Web export reuses completed and in-flight ordinary export jobs',t=>{
  const f=fixture(t),first=create(f,'first'),pending=create(f,'second');
  assert.equal(pending.reused,true);assert.equal(pending.job.id,first.job.id);
  complete(f,first.job.id);const finished=create(f,'third');assert.equal(finished.reused,true);assert.equal(finished.job.id,first.job.id);
});
test('an in-flight ordinary export keeps another editor after its original requester is revoked',t=>{
  const f=fixture(t),first=create(f,'first'),worker=f.store.get('creator_build',first.job.id);
  f.builds.update(worker,{status:'running'});const other=create(f,'other',{},f.editor);
  assert.equal(other.reused,true);assert.equal(other.job.id,first.job.id);
  f.builds.update(worker,{progress:45});revoke(f,f.owner);
  assert.equal(f.builds.executionUser(worker).id,f.editor.id);
  revoke(f,f.editor);assert.throws(()=>f.builds.executionUser(worker),{status:403});
});
test('reused export request replay remains pinned after the runtime changes and rejects changed parameters',t=>{
  const f=fixture(t),first=play(f);complete(f,first.job.id);const result=create(f,'replay');
  assert.equal(result.job.id,first.job.id);
  writeFileSync(join(f.source,'tools/release-template/standalone.gd'),'# newer runtime');
  const again=create(f,'replay');assert.equal(again.replayed,true);assert.equal(again.job.id,result.job.id);
  assert.throws(()=>create(f,'replay',{entry_scene_id:'second'}),{status:409});
  assert.throws(()=>create(f,'replay',{targets:['windows']}),{status:409});
  assert.notEqual(create(f,'new-request').job.id,result.job.id);
});
test('reused export request replay checks current editor permission',t=>{
  const f=fixture(t),first=play(f);complete(f,first.job.id);create(f,'editor-request',{},f.editor);
  const project=f.store.get('creator_project',f.project);project.members.editor='viewer';f.store.put('creator_project',project);
  assert.throws(()=>create(f,'editor-request',{},f.editor),{status:403});
  assert.throws(()=>create(f,'new-editor-request',{},f.editor),{status:403});
  assert.throws(()=>create(f,'player-request',{},f.player),{status:403});
});
test('different users can use the same request ID without sharing their idempotency parameters',t=>{
  const f=fixture(t),first=play(f);complete(f,first.job.id);create(f,'same-name');
  const other=create(f,'same-name',{entry_scene_id:'second'},f.editor);
  assert.notEqual(other.job.id,first.job.id);
  assert.equal(create(f,'same-name',{entry_scene_id:'second'},f.editor).job.id,other.job.id);
});
for(const damage of ['zip-missing','zip-same-size-corrupt','web-missing','web-same-size-corrupt'])test(`completed Play with ${damage} cannot satisfy a new export`,t=>{
  const f=fixture(t),first=play(f);complete(f,first.job.id);
  const path=join(f.builds.directory,first.job.id,damage.startsWith('zip')?'web.zip':'web/index.pck');
  if(damage.endsWith('missing'))rmSync(path);else{const bytes=readFileSync(path);bytes[0]^=1;writeFileSync(path,bytes);}
  const result=create(f);assert.notEqual(result.job.id,first.job.id);assert.notEqual(result.reused,true);assert.equal(result.job.status,'queued');
});
test('a Web-only candidate cannot satisfy a multi-platform export',t=>{
  const f=fixture(t),first=play(f);complete(f,first.job.id);
  const result=create(f,'both',{targets:['web','windows']});assert.notEqual(result.job.id,first.job.id);
  assert.deepEqual(result.job.targets,['web','windows']);
});
test('multi-platform reuse compares each requested template despite the shared Web content key',t=>{
  const f=fixture(t),first=create(f,'first',{targets:['web','windows']});complete(f,first.job.id,['web','windows']);
  const same=create(f,'same',{targets:['web','windows']});assert.equal(same.reused,true);assert.equal(same.job.id,first.job.id);
  writeFileSync(join(f.builds.templates,'windows_release_x86_64.exe'),'CHANGED WINDOWS TEMPLATE');
  const changed=create(f,'changed',{targets:['web','windows']});
  assert.equal(changed.job.content_key,first.job.content_key,'Web identity intentionally does not include the Windows template');
  assert.notEqual(changed.job.id,first.job.id,'Windows output must match its current pinned template');
});
test('Web export does not join an active multi-platform worker invalidated by another target template',t=>{
  const f=fixture(t),first=create(f,'first',{targets:['web','windows']});
  const worker=f.store.get('creator_build',first.job.id);f.builds.update(worker,{status:'running'});
  writeFileSync(join(f.builds.templates,'windows_release_x86_64.exe'),'CHANGED WINDOWS TEMPLATE');
  assert.throws(()=>f.builds.verifyToolchain(worker),{status:409});
  const next=create(f,'web-only');
  assert.equal(next.job.content_key,first.job.content_key);
  assert.notEqual(next.job.id,first.job.id,'do not join a worker whose own execution contract is already invalid');
});
test('completed multi-platform Web remains reusable when only another target template changes',t=>{
  const f=fixture(t),first=create(f,'first',{targets:['web','windows']});complete(f,first.job.id,['web','windows']);
  writeFileSync(join(f.builds.templates,'windows_release_x86_64.exe'),'CHANGED WINDOWS TEMPLATE');
  const next=create(f,'web-only');assert.equal(next.reused,true);assert.equal(next.job.id,first.job.id);
});
test('public Play does not grant a viewer execution authority for an active ordinary multi-platform export',t=>{
  const f=fixture(t);f.store.publicPlay=true;f.service.worlds={playable:()=>({source_revision:f.revision})};
  const first=create(f,'first',{targets:['web','windows']}),worker=f.store.get('creator_build',first.job.id);
  const viewerPlay=play(f,f.player);assert.notEqual(viewerPlay.job.id,first.job.id);
  assert.throws(()=>create(f,'player-export',{},f.player),{status:403});
  assert.ok(!f.store.get('creator_build',first.job.id).authorized_actor_ids?.includes(f.player.id));
  revoke(f,f.owner);assert.throws(()=>f.builds.executionUser(worker),{status:403});
});
test('partial multi-platform output cannot satisfy targets whose archive never completed',t=>{
  const f=fixture(t),first=create(f,'first',{targets:['web','windows']});complete(f,first.job.id,['web'],'partial');
  const result=create(f,'both',{targets:['web','windows']});assert.notEqual(result.job.id,first.job.id);
});
for(const purpose of ['native_preview','native_shared'])test(`${purpose} is excluded even if a candidate claims the same game key`,t=>{
  const f=fixture(t),first=play(f),job=complete(f,first.job.id);job.purpose=purpose;f.store.put('creator_build',job);
  const result=create(f);assert.notEqual(result.job.id,first.job.id);assert.notEqual(result.reused,true);
});
test('source archive requests retain independent jobs and their own replay identity',t=>{
  const f=fixture(t),first=create(f,'source-one',{kind:'source',targets:[]}),other=create(f,'source-two',{kind:'source',targets:[]});
  assert.notEqual(other.job.id,first.job.id);assert.equal(create(f,'source-one',{kind:'source',targets:[]}).job.id,first.job.id);
});
