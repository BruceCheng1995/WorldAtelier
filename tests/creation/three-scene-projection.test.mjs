import test from 'node:test';
import assert from 'node:assert/strict';
import {DefaultProjectBundle} from '../../services/creation/default-projects.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {threeGameStarter,threeSceneProjection,usesThreeWeb} from '../../services/creation/three-scene-projection.mjs';

const bundle=new DefaultProjectBundle(new URL('../../content/default-projects',import.meta.url));
const project=name=>bundle.snapshot(bundle.catalog.projects.find(game=>game.name===name).branches[0]);
const read=entry=>bundle.readObject(entry.hash);

test('the shipped Snake editor uses the fixed scene including its inherited technical meshes',()=>{
  const manifest=project('贪吃蛇'),entry=manifest.entry_scene_id,projection=threeSceneProjection(manifest,entry,read);
  assert.equal(projection.aspect_ratio,1.6);
  assert.equal(projection.nodes.filter(node=>node.mesh).length,291);
  assert.equal(projection.nodes.length,manifest.resources[entry].native_nodes.length);
  assert.ok(projection.nodes.some(node=>node.mesh?.type==='torus'&&node.mesh.emission));
  assert.ok(projection.nodes.some(node=>node.light?.shadow));
  const node=projection.nodes.find(node=>node.mesh);
  assert.ok(node.path && node.world_matrix.length===16);
  assert.equal(usesThreeWeb(manifest,entry,read),true);

  const stale={...manifest,index_source_identity:'different revision'};
  assert.equal(threeSceneProjection(stale,entry,read),null);
});

test('nonprojectable Controls and unported native logic retain their working native paths',()=>{
  const tetris=project('俄罗斯方块');
  assert.equal(threeSceneProjection(tetris,tetris.entry_scene_id,read),null);
  assert.equal(usesThreeWeb(tetris,tetris.entry_scene_id,read),true);
  const old={...tetris,source_files:{...tetris.source_files}};delete old.source_files['web/main.js'];
  assert.equal(usesThreeWeb(old,old.entry_scene_id,read),false);
  const snake=project('贪吃蛇');
  const starterOnly={...snake,source_files:{...snake.source_files,'web/main.js':{hash:hash(threeGameStarter),size:threeGameStarter.length}}};
  assert.equal(usesThreeWeb(starterOnly,snake.entry_scene_id,read),false);
});

test('static editor eligibility does not replace script-free native simulation in Play',()=>{
  const base={source_identity:'fixed',index_source_identity:'fixed',
    source_files:{'web/main.js':{hash:hash(threeGameStarter),size:threeGameStarter.length}},
    resources:{entry:{project_source_identity:'fixed',native_nodes:[{type:'RigidBody3D',path:'.',properties:[]}]}}};
  assert.ok(threeSceneProjection(base,'entry',()=>Buffer.alloc(0)));
  assert.equal(usesThreeWeb(base,'entry',()=>Buffer.alloc(0)),false);
});
