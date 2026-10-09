import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationInbox} from '../../services/creation/inbox.mjs';
import {CreationNotifications} from '../../services/creation/notifications.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {nativeObjects} from '../../services/creation/native-reference.mjs';

// Permission-boundary tests: actual SQLite users/branches and real Godot source
// indexing. Client diagnostic claims and historical revision origins are test
// inputs, not evidence of a running browser, game or successful runtime ACK.
test('viewer client diagnostics stay within current membership and immutable native scope',{timeout:180000},async t=>{
  const base=process.env.WA_DIAGNOSTICS_EVIDENCE??tmpdir();mkdirSync(base,{recursive:true});
  const data=mkdtempSync(join(base,'viewer-diagnostics-')),store=new CreationStore(join(data,'creation.sqlite'));
  const native=new NativeProjects({store,data,enforceIsolation:true});
  t.after(async()=>{await native.close();store.close();if(!process.env.WA_DIAGNOSTICS_EVIDENCE)rmSync(data,{recursive:true,force:true});});
  const [owner,editor,viewer,viewer2,outsider]=['owner','editor','viewer','viewer-two','outsider'].map(name=>store.register({name:'diagnostics-'+name,password:'independent-diagnostics-password'}).user);
  const source={
    'project.godot':'config_version=5\n[application]\nconfig/name="Independent diagnostic permissions"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',path:'main.tscn'},unit:{id:'unit',kind:'prefab',name:'Unit',path:'unit.tscn'}}}),
    'unit.gd':'extends Node3D\n@export var attack: float = 10.0\n',
    'unit.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://unit.gd" id="1"]\n[node name="Unit" type="Node3D"]\nscript = ExtResource("1")\nmetadata/wa_node_id = "unit-root"\n',
    'main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://unit.tscn" id="1"]\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id = "main-root"\n[node name="A" parent="." instance=ExtResource("1")]\nattack = 17.0\nmetadata/wa_instance_id = "a"\n[node name="B" parent="." instance=ExtResource("1")]\nmetadata/wa_instance_id = "b"\n',
    'opaque.bin':Buffer.from([0,1,255,17]),
  };
  const manifest=await native.inspectFiles(Object.fromEntries(Object.entries(source).map(([path,bytes])=>[path,native.archive.put(bytes)])),{assignIds:true});
  const created=store.createProject(owner,{name:'Independent viewer diagnostics'},manifest),p=created.project.id,oldRevision=created.branch.head;
  const project=store.get('creator_project',p);Object.assign(project.members,{[editor.id]:'editor',[viewer.id]:'viewer',[viewer2.id]:'viewer'});store.put('creator_project',project);
  store.fork(owner,p,{from_branch:'main',branch_id:'side',name:'Side'});
  const side=store.branchFor(owner,p,'side');side.head=store.writeRevision(p,[side.head],manifest,owner.id,{test_case:'unreachable side revision'}).id;store.put('creator_branch',side);
  const branch=store.branchFor(owner,p,'main');branch.head=store.writeRevision(p,[branch.head],manifest,owner.id,{test_case:'reachable main revision'}).id;store.put('creator_branch',branch);
  const foreign=store.createProject(outsider,{name:'Foreign private source'},manifest);
  const service={store,data,root:process.cwd(),observe:fn=>fn()};service.inbox=new CreationInbox({store});
  const notices=new CreationNotifications({service}),scope={project_id:p,branch_id:'main',revision:branch.head,resource_id:'main',runtime_build_id:'fixed-native-build',client_id:'native-editor-window'};
  const rows=nativeObjects(manifest,scope),a=rows.find(row=>row.native_path==='A'),b=rows.find(row=>row.native_path==='B');
  assert.ok(a&&b);assert.notEqual(a.id,b.id);assert.deepEqual(a.address.instance_path,['a']);assert.deepEqual(b.address.instance_path,['b']);
  assert.equal(manifest.resources.main.native_nodes.find(row=>row.path==='A').properties.find(prop=>prop.name==='attack').value,17);
  assert.equal(manifest.resources.main.native_nodes.find(row=>row.path==='B').properties.find(prop=>prop.name==='attack').value,10);
  writeFileSync(join(data,'fixed-native-manifest.json'),JSON.stringify(manifest,null,2));
  const target=row=>({object_id:row.id,address:row.address});
  const claim=(user,extra={})=>notices.client(user,{...scope,code:'asset_load',event_id:crypto.randomUUID(),message:'Synthetic client claim for permission boundary',...extra}).item;
  const recover=(user,extra={})=>notices.clientRecovered(user,{...scope,code:'asset_load',...extra});
  const state=item=>store.get('creator_inbox_item',item.id).status;
  const bad=(fn,status)=>assert.throws(fn,error=>error.status===status);

  await t.test('viewer can receive, read and recover their own native editor object diagnostic',()=>{
    const extra={client_id:'editor-view',...target(a)},item=claim(viewer,extra);
    assert.equal(item.source,'godot_client');assert.deepEqual(item.recipient_user_ids,[viewer.id]);
    assert.equal(service.inbox.get(viewer,item.id).status,'open');
    assert.ok(service.inbox.list(viewer).items.some(value=>value.id===item.id));
    assert.equal(recover(viewer,extra).count,1);assert.equal(state(item),'resolved');
    bad(()=>service.inbox.get(viewer2,item.id),403);
  });
  await t.test('viewer canonical Play scope may report/recover without a shared world ID',()=>{
    const extra={code:'runtime_load',client_id:'independent-play-window',runtime_build_id:'canonical-content-identity'},item=claim(viewer,extra);
    assert.equal(item.world_id,null);assert.equal(service.inbox.get(viewer,item.id).code,'runtime_load');
    assert.equal(recover(viewer,extra).count,1);assert.equal(state(item),'resolved');
  });
  await t.test('document recovery matches user, nonce, revision, build and resource',()=>{
    const same={client_id:'nonce-isolation'},own=claim(viewer,{...same,...target(a)}),otherObject=claim(viewer,{...same,...target(b)});
    const protectedItems=[claim(viewer2,{...same,...target(a)}),claim(viewer,{client_id:'other-window',...target(a)}),claim(viewer,{...same,runtime_build_id:'other-build',...target(a)}),claim(viewer,{...same,revision:oldRevision,...target(a)}),claim(viewer,{...same,resource_id:'unit'})];
    assert.equal(recover(viewer,{...same,runtime_build_id:'wrong-build'}).count,0);
    assert.equal(recover(viewer,same).count,2);assert.equal(state(own),'resolved');assert.equal(state(otherObject),'resolved');
    for(const item of protectedItems)assert.equal(state(item),'open');
  });
  await t.test('target recovery cannot clear another instance of the same native definition',()=>{
    const extra={client_id:'target-isolation'},one=claim(viewer,{...extra,...target(a)}),two=claim(viewer,{...extra,...target(b)});
    assert.equal(recover(viewer,{...extra,...target(a)}).count,1);assert.equal(state(one),'resolved');assert.equal(state(two),'open');
  });
  await t.test('viewer must retain nonce and native full-address/ID/resource bindings',()=>{
    bad(()=>claim(viewer,{client_id:null}),400);bad(()=>recover(viewer,{client_id:null}),400);
    for(const extra of [
      {...target(a),address:{...a.address,project_id:foreign.project.id}},
      {...target(a),address:{...a.address,branch_id:'side'}},
      {...target(a),address:{...a.address,resource_id:'unit'}},
      {address:a.address,object_id:b.id},
      {address:{...a.address,instance_path:['missing-instance']}},
      {resource_id:'absent'},
    ]){bad(()=>claim(viewer,extra),409);bad(()=>recover(viewer,extra),409);}
    bad(()=>claim(viewer,{address:{...a.address,instance_path:['']}}),422);
    bad(()=>recover(viewer,{address:{...a.address,instance_path:['']}}),422);
  });
  await t.test('only reachable revisions of the authorized branch are valid',()=>{
    const old={client_id:'old-revision',revision:oldRevision},item=claim(viewer,old);
    assert.equal(recover(viewer,old).count,1);assert.equal(state(item),'resolved');
    for(const revision of [side.head,foreign.branch.head,'missing-revision']){bad(()=>claim(viewer,{revision}),409);bad(()=>recover(viewer,{revision}),409);}
    bad(()=>claim(viewer,{branch_id:'missing-branch'}),404);bad(()=>recover(viewer,{branch_id:'missing-branch'}),404);
  });
  await t.test('revocation, disabled account and archived project revoke diagnostic access immediately',()=>{
    const extra={client_id:'revocation'},item=claim(viewer2,extra),original=store.get('creator_project',p);
    const denied=()=>{bad(()=>claim(viewer2,extra),403);bad(()=>recover(viewer2,extra),403);bad(()=>service.inbox.get(viewer2,item.id),403);assert.equal(state(item),'open');};
    try{const changed=structuredClone(original);delete changed.members[viewer2.id];store.put('creator_project',changed);denied();}finally{store.put('creator_project',original);}
    const originalUser=store.get('creator_user',viewer2.id);
    try{store.put('creator_user',{...originalUser,disabled_at:Date.now()});denied();}finally{store.put('creator_user',originalUser);}
    try{store.put('creator_project',{...original,archived_at:Date.now()});denied();}finally{store.put('creator_project',original);}
    assert.equal(recover(viewer2,extra).count,1);
  });
  await t.test('public play access does not grant arbitrary source diagnostics or inbox access',()=>{
    store.publicPlay=true;
    try{
      assert.equal(store.roleFor(outsider,store.get('creator_project',p)),'player');
      bad(()=>claim(outsider),403);bad(()=>recover(outsider),403);bad(()=>claim(outsider,{...target(a)}),403);bad(()=>recover(outsider,{...target(a)}),403);
      const item=claim(viewer2,{client_id:'private-member'});bad(()=>service.inbox.get(outsider,item.id),403);
      assert.equal(service.inbox.list(outsider).items.filter(value=>value.project_id===p).length,0);
      const unscoped={code:'runtime_load',client_id:'public-shell',runtime_build_id:'public-build',event_id:crypto.randomUUID()};
      const shell=notices.client(outsider,unscoped).item;assert.equal(shell.project_id,null);
      assert.equal(notices.clientRecovered(outsider,unscoped).count,1);
    }finally{store.publicPlay=false;}
  });
  await t.test('read membership does not open other server producers or non-client decision scopes',()=>{
    const base={...scope,client_id:null,event_id:'server-'+crypto.randomUUID(),dedupe_key:crypto.randomUUID(),kind:'error',code:'private-server-error',title:'Server fixture',message:'Not a client diagnostic',recipient_user_ids:[viewer.id]};
    for(const source of ['backend','agent','godot_authority'])bad(()=>service.inbox.record({...base,source}),403);
    for(const input of [{code:'other-client-code'}, {kind:'decision',code:'asset_load'}, {code:'asset_load',recipient_user_ids:[viewer.id,viewer2.id]}, {code:'asset_load',client_id:null}]){
      bad(()=>service.inbox.record({...base,source:'godot_client',client_id:'nonce',...input}),403);
    }
    const session=store.createSession(owner,p,'main',{visibility:'private'});
    bad(()=>service.inbox.record({...base,source:'godot_client',client_id:'nonce',code:'asset_load',session_id:session.id}),403);
  });
  await t.test('existing owner/editor diagnostics keep legacy no-nonce recovery and head is untouched',()=>{
    for(const user of [owner,editor]){const extra={client_id:null,code:'runtime_load',runtime_build_id:'legacy-'+user.id};const item=claim(user,extra);assert.equal(recover(user,extra).count,1);assert.equal(state(item),'resolved');}
    assert.equal(store.branchFor(owner,p,'main').head,branch.head);
    assert.equal(store.branchFor(owner,p,'side').head,side.head);
    assert.deepEqual(store.branchView(owner,p,'main').manifest.source_files,JSON.parse(JSON.stringify(manifest.source_files)));
  });
});
