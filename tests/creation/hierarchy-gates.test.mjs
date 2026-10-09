// Explicit FAKE transport probes: no Godot process, browser or fabricated acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {CreationWorlds} from '../../services/creation/worlds.mjs';
import {CreationService} from '../../services/creation/service.mjs';

function fixture(schema='creation-flat-1') {
  const branch={head:'new-source'},scope={project_id:'project',branch_id:'main',resource_id:'scene'};
  const client={id:'client',scope,user:{id:'user'},ws:{readyState:1}};
  const live={key:'project/main/scene',id:'world',project_id:'project',branch_id:'main',resource_id:'scene',revision:'old-source',runtime_build_id:'build',epoch:2,ready:true,clients:new Map(),snapshot:{sequence:12}};
  const messages=[],commands=[],manager=Object.create(CreationWorlds.prototype);
  let ensured=0;
  Object.assign(manager,{store:{branchFor:()=>branch,projectFor(){},roleFor:()=>'owner',ancestor:()=>true,get:kind=>kind==='creator_revision'?{project_id:'project',manifest:{schema,resources:{scene:{id:'scene'}}}}:null,list:()=>[]},worlds:new Map([[live.key,live]]),service:{realtime:{send:(_c,p)=>messages.push(p)}},runtimeManifest:()=>({build_id:'build',capabilities:{document_schemas:['creation-flat-1']}}),ensure:async()=>{ensured++;return live;},leave:async()=>{},scene:()=>({document_id:'project/main/scene'}),tell:(_w,p)=>commands.push(p)});
  const join={type:'world_join',...scope,runtime_build_id:'build'};
  return {manager,client,live,branch,messages,commands,join,ensured:()=>ensured};
}
test('FAKE: Play of fixed unsupported hierarchy rejects before borrowing the old live world',async()=>{
  const f=fixture('creation-hierarchy-2');
  await assert.rejects(f.manager.message(f.client,{...f.join,source_revision:'new-source'}),e=>e.status===422&&e.details.code==='hierarchy_runtime_unavailable');
  assert.equal(f.ensured(),0);assert.equal(f.commands.length,0);assert.equal(f.live.ready,true);
});
test('FAKE: fixed Play never silently joins a different applied revision',async()=>{
  const f=fixture();await assert.rejects(f.manager.message(f.client,{...f.join,source_revision:'new-source'}),e=>e.status===409);
  assert.equal(f.ensured(),0);assert.equal(f.live.revision,'old-source');
});
test('FAKE: a legacy live client can still rejoin its fixed flat world after source migration',async()=>{
  const f=fixture('creation-hierarchy-2');await f.manager.message(f.client,f.join);
  assert.equal(f.ensured(),1);assert.equal(f.commands[0].type,'join');assert.equal(f.messages[0].packet.scene_revision,'old-source');
  assert.equal(f.client.world_scope,f.client.scope);
});
test('FAKE: source changes during preparation fence the pending fixed Play request',async()=>{
  const f=fixture();f.live.revision='new-source';f.manager.ensure=async()=>{f.branch.head='later-source';return f.live;};
  await assert.rejects(f.manager.message(f.client,{...f.join,source_revision:'new-source'}),e=>e.status===409);
  assert.equal(f.commands.length,0);assert.equal(f.live.clients.size,0);
});
test('FAKE: migration remains unavailable until its complete editor is enabled',()=>{
  const service=Object.create(CreationService.prototype);let applied=0;
  Object.assign(service,{hierarchyEditing:false,store:{branchFor:()=>({head:'flat'}),get:()=>({manifest:{schema:'creation-flat-1'}}),apply:()=>{applied++;return{};}}});
  assert.throws(()=>service.committed({id:'u'},'p','b',{ops:[{type:'migrate_hierarchy'}]}),e=>e.status===422&&e.details.code==='hierarchy_editor_unavailable');
  assert.equal(applied,0);
});


test('FAKE: public player resolves and joins applied content while unpublished source moves',async()=>{
  const f=fixture();f.manager.store.roleFor=()=> 'player';
  const resolved=f.manager.playable(f.client.user,'project','main','scene');
  assert.equal(resolved.source_revision,'old-source');
  await f.manager.message(f.client,{...f.join,source_revision:resolved.source_revision});
  assert.equal(f.messages[0].packet.scene_revision,'old-source');assert.equal(f.branch.head,'new-source');
});
test('FAKE: player cannot request unpublished source or join an applied version that changed during preparation',async()=>{
  const f=fixture();f.manager.store.roleFor=()=> 'player';
  await assert.rejects(f.manager.message(f.client,{...f.join,source_revision:'new-source'}),e=>e.status===409);
  assert.equal(f.ensured(),0);
  f.manager.ensure=async()=>{f.live.revision='later-release';return f.live;};
  await assert.rejects(f.manager.message(f.client,{...f.join,source_revision:'old-source'}),e=>e.status===409);
  assert.equal(f.commands.length,0);
});
