import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import * as THREE from 'three';
import {DefaultProjectBundle,DEFAULT_PROJECT_FORMAT} from '../../services/creation/default-projects.mjs';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeSourceArchive,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {applyDefaultWebMigrations} from '../../tools/apply-default-web-migrations.mjs';
import {SceneObservation} from '../../runtimes/three-game/inspection.js';

// Exercise a real install snapshot, and a small temporary central database.
// This test covers storage/permissions and does not stand in for browser Play.
test('explicit sample upgrade appends Web files and one child revision, retaining its owners, releases and previous source',async t=>{
  const root=mkdtempSync(join(tmpdir(),'wa-default-upgrade-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const data=join(root,'data'),bundle=new DefaultProjectBundle(new URL('../../content/default-projects',import.meta.url));
  const project=bundle.catalog.projects.find(p=>p.name==='贪吃蛇'),target=bundle.snapshot(project.branches[0]);
  const archive=new NativeSourceArchive(join(data,'native-source','objects')),prior=structuredClone(target);
  for(const [path,file] of Object.entries(prior.source_files)){
    if(path.startsWith('web/'))delete prior.source_files[path];
    else archive.put(bundle.readObject(file.hash));
  }
  prior.source_identity=prior.index_source_identity=nativeSourceIdentity(prior.source_files);
  for(const r of Object.values(prior.resources))r.project_source_identity=prior.source_identity;
  const store=new CreationStore(join(data,'creation.sqlite'));
  const members={'existing-owner':'owner'};
  store.put('creator_project',{id:project.id,name:project.name,members,default_project:{format:DEFAULT_PROJECT_FORMAT}});
  const base=store.writeRevision(project.id,[],prior,null,{kind:'seed'});
  const bid=project.id+':main';
  store.put('creator_branch',{id:bid,project_id:project.id,branch_id:'main',head:base.id,doc_sequences:{}});
  store.put('creator_native_game_pointer',{id:'an-existing-release',build_id:'previous-build'});
  store.close();
  const args={data,projects:[project.id]},plan=await applyDefaultWebMigrations(args);
  const result=await applyDefaultWebMigrations({...args,applyPlan:plan.planHash,evidence:join(root,'backup')});
  const after=new CreationStore(join(data,'creation.sqlite'));
  const record=after.get('creator_revision',result.results[0].revision);
  assert.equal(after.get('creator_branch',bid).head,record.id);assert.deepEqual(record.parents,[base.id]);assert.equal(record.actor_id,null);
  assert.deepEqual(after.get('creator_project',project.id).members,members);assert.equal(after.get('creator_native_game_pointer','an-existing-release').build_id,'previous-build');
  assert.equal(after.get('creator_revision',base.id).manifest.source_identity,prior.source_identity);
  assert.deepEqual(record.manifest.source_files['web/main.js'],target.source_files['web/main.js']);
  const saved=new DatabaseSync(join(root,'backup','creation-before.sqlite'),{readOnly:true});
  assert.equal(saved.prepare("SELECT json_extract(body,'$.head') AS head FROM documents WHERE kind='creator_branch' AND id=?").get(bid).head,base.id);
  saved.close();after.close();
  assert.equal((await applyDefaultWebMigrations(args)).plan[0].additions.length,0);
  await assert.rejects(applyDefaultWebMigrations({...args,applyPlan:plan.planHash,evidence:join(root,'stale')}),/计划哈希/);
  assert.equal(JSON.parse(readFileSync(join(root,'backup','receipt.json'))).planHash,plan.planHash);
});

test('large render graphs retain unique native bindings beyond the context limit',()=>{
  const scene=new THREE.Scene(),nodes=Array.from({length:2150},()=>new THREE.Group());
  scene.add(...nodes);
  nodes[2100].userData.nativePath='Character';
  const row={id:'hero',native_path:'Character',type:'CharacterBody3D',address:{definition_node_id:'player'}};
  const observations=new SceneObservation(scene,{objects:[row]},1,new Set());
  assert.equal(observations.ids.get('hero'),nodes[2100]);
  assert.equal(observations.fixedRows('revision')[0].id,'hero');
  nodes[2149].userData.nativePath='Character';observations.refresh();
  assert.equal(observations.ids.has('hero'),false);
});

test('captured screen objects include the source owner of late meshes in dense scenes',()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,.1,100);
  scene.add(...Array.from({length:700},()=>new THREE.Group()));
  const character=new THREE.Group();character.userData.nativePath='Hero';
  character.position.z=-3;
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
  character.add(mesh);scene.add(character);
  const row={id:'hero',native_path:'Hero',address:{definition_node_id:'hero'},version:'fixed'};
  const snapshot=new SceneObservation(scene,{objects:[row]},1,new Set()).snapshot(camera);
  const captured=snapshot.objects.slice(0,128).find(item=>item.mapping==='exact_source');
  assert.equal(snapshot.scanned_nodes,703);assert.equal(snapshot.truncated,true);
  assert.deepEqual(captured.source.address,row.address);
  const [x,y,w,h]=captured.screen_bounds;
  assert.ok(x<.5&&y<.5&&x+w>.5&&y+h>.5);
  mesh.geometry.dispose();mesh.material.dispose();
});
