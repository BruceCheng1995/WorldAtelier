import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {CreationService} from '../../services/creation/service.mjs';
import {CreationAgentRuns,CREATION_TOOLS} from '../../services/creation/agent-runs.mjs';
import {hash} from '../../services/creation/schema.mjs';

// Independent backend contract tests: real SQLite, native files, Godot indexing
// and canonical gameplay. Run identities below are explicit fixtures, not real
// Agent turns. No HTTP port, paid Agent, production data or outline scene is used.
const root=resolve(import.meta.dirname,'../..');
const evidenceRoot=resolve(root,'.local/creation-verification/ai-property-action');
const uid=prefix=>`${prefix}-${randomUUID()}`;
const clone=structuredClone;
const binding=property=>({node_id:'pea-root',property});
const property=(id,name,nativeProperty,extra={})=>({id,name,description:'Independent fixture parameter',type:'number',default:nativeProperty==='interval'?2:nativeProperty==='health'?100:10,instance_editable:true,binding:binding(nativeProperty),...extra});
const exportId=(f,name)=>detail(f).properties.find(p=>p.binding.property===name).id;
const damage=(f,extra)=>property(exportId(f,'attack'),'子弹伤害','attack',{unit:'点',min:0,max:100,step:1,...extra});
const interval=(f,extra)=>property(exportId(f,'interval'),'攻击间隔','interval',{unit:'秒',min:0,max:10,step:.25,...extra});
const initialDesign={description:'Preserve this design description',category:'object',relations:[{resource_id:'other',description:'Preserve this relation'}],exposed_properties:[property('health','生命值','health',{min:0,max:500,step:1})]};
const sourceTexts={
  'project.godot':'config_version=5\n[application]\nconfig/name="Independent AI property action"\nrun/main_scene="res://scenes/garden.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'garden',resources:{garden:{id:'garden',kind:'scene',name:'Independent garden',path:'scenes/garden.tscn'},pea:{id:'pea',kind:'prefab',name:'Independent pea',path:'prefabs/pea.tscn',design:initialDesign},other:{id:'other',kind:'prefab',name:'Other target',path:'prefabs/other.tscn'},nested:{id:'nested',kind:'prefab',name:'Nested pea',path:'prefabs/nested.tscn'}}}),
  'scripts/pea.gd':'extends Node2D\n@export var attack: float = 10.0\n@export var interval: float = 1.5\n@export var health: float = 100.0\n@export var unused_knob: float = 7.0\nfunc _ready():\n\tprint("AI_PROPERTY_CONSUMED "+JSON.stringify({"instance":str(name),"attack":attack,"interval":interval,"damage":attack * 2.0}))\n',
  'prefabs/pea.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/pea.gd" id="1"]\n[node name="Pea" type="Node2D"]\nscript = ExtResource("1")\ninterval = 2.0\nmetadata/wa_node_id = "pea-root"\nmetadata/unrecognized_editor = {"schema":99,"nested":["keep",7]}\n',
  'prefabs/other.tscn':'[gd_scene format=3]\n[node name="Other" type="Node2D"]\nmetadata/wa_node_id = "other-root"\nmetadata/private_fixture_marker = "UNRELATED_TARGET_CONTENT"\n',
  'prefabs/nested.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://prefabs/pea.tscn" id="1"]\n[node name="Nested" type="Node2D"]\nmetadata/wa_node_id = "nested-root"\n[node name="Inner" parent="." instance=ExtResource("1")]\nattack = 30.0\nmetadata/wa_instance_id = "inner"\n',
  'scenes/garden.tscn':'[gd_scene load_steps=3 format=3]\n[ext_resource type="PackedScene" path="res://prefabs/pea.tscn" id="1"]\n[ext_resource type="PackedScene" path="res://prefabs/nested.tscn" id="2"]\n[node name="Garden" type="Node2D"]\nmetadata/wa_node_id = "garden-root"\n[node name="A" parent="." instance=ExtResource("1")]\nattack = 20.0\nmetadata/wa_instance_id = "a"\n[node name="B" parent="." instance=ExtResource("1")]\nmetadata/wa_instance_id = "b"\n[node name="C" parent="." instance=ExtResource("2")]\nmetadata/wa_instance_id = "c"\n',
  'unknown/opaque.bin':Buffer.from([0,255,7,91,0,128]),
  'unknown/authored.tres':'[gd_resource type="Curve" format=3]\n[resource]\nmin_value = -3.0\nmax_value = 19.0\nmetadata/editor_unknown = {"keep":"exactly"}\n',
};
const sourceHashes=()=>Object.fromEntries(['tests/creation/ai-property-action.test.mjs','services/creation/authoring-actions.mjs','services/creation/store.mjs','services/creation/agent-runs.mjs','services/creation/native-semantic.mjs','services/creation/native-transactions.mjs'].filter(file=>existsSync(resolve(root,file))).map(file=>[file,hash(readFileSync(resolve(root,file)))]));
async function fixture(t){
  mkdirSync(evidenceRoot,{recursive:true});
  const data=mkdtempSync(join(evidenceRoot,'case-')),server=createServer();
  const previous=Object.fromEntries(['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(key=>[key,process.env[key]]));
  let service;
  try{
    process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';
    service=new CreationService({server,root,data,origin:'http://127.0.0.1:48921'});
  }finally{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
  const report={started_at:new Date().toISOString(),scope:'independent native/Godot backend only; synthetic run identities; no real Agent or UI',source_hashes:sourceHashes(),checks:[]};
  t.after(async()=>{await service.close();assert.equal(server.listening,false);report.finished_at=new Date().toISOString();report.final_source_hashes=sourceHashes();writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('AI_PROPERTY_ACTION_EVIDENCE '+data);});
  const files=Object.fromEntries(Object.entries(sourceTexts).map(([path,value])=>[path,service.native.archive.put(value)]));
  const initial=await service.native.inspectFiles(files,{assignIds:true});
  const user=service.store.register({name:uid('independent-author'),password:uid('test-password')}).user;
  const f={service,store:service.store,data,user,initial,report};
  f.project=()=>{
    const p=f.store.createProject(user,{name:uid('AI property fixture')},initial).project.id;
    const current=()=>f.store.branchView(user,p,'main');
    const input=()=>({type:'expose_properties',resource_id:'pea',revision:current().head,expected_version:current().manifest.resources.pea.version});
    const session=()=>f.store.createSession(user,p,'main',{execution_mode:'goal',authoring_action:input()});
    const run=s=>{const value={id:uid('fixture-run'),session_id:s.id,project_id:p,branch_id:'main',owner_user_id:user.id,status:'running',execution_mode:'goal',lease_generation:1,input_revision:current().head,authoring_action:clone(s.authoring_action),changes:[],targets:[],verifications:[],deliveries:[],created_at:Date.now()};f.store.put('creator_run',value);return value;};
    const request=properties=>({transaction_id:uid('expose'),base_revision:current().head,expected_version:current().manifest.resources.pea.version,properties});
    const manual=ops=>service.committed(user,p,'main',{transaction_id:uid('manual'),base_revision:current().head,ops});
    return {...f,p,current,input,session,run,request,manual};
  };
  return f;
}
function nativeProperty(manifest,rid,name,instanceIds=[]){
  const node=manifest.resources[rid].native_nodes.find(node=>node.node_id==='pea-root'&&JSON.stringify(node.instance_ids)===JSON.stringify(instanceIds));
  assert.ok(node,`missing actual native node ${rid}/${instanceIds.join('/')}`);
  const value=node.properties.find(property=>property.name===name);assert.ok(value,`missing actual native property ${name}`);return value;
}
const detail=f=>f.service.semantic.resources(f.user,f.p,'main',{resource_id:'pea'});
async function rejectUnchanged(f,operation,statuses=[400,403,409,410,422]){
  const head=f.current().head,count=f.store.list('creator_revision').length;
  await assert.rejects(async()=>operation(),error=>statuses.includes(error.status),`expected rejection with status ${statuses}`);
  assert.equal(f.current().head,head,'rejected action must not move source');
  assert.equal(f.store.list('creator_revision').length,count,'rejected batch must not save partial content');
}
async function caseCheck(t,f,name,body){
  await t.test(name,async()=>{try{await body();f.report.checks.push({name,status:'passed'});}catch(error){f.report.checks.push({name,status:'failed',error:error.stack});throw error;}});
}
const origin=run=>({run_id:run.id,session_id:run.session_id,lease_generation:run.lease_generation});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('native/Godot fixture preserves original exports, nested overrides and unknown bytes',{timeout:180000},async t=>{
  const f=await fixture(t),m=f.initial;
  assert.equal(nativeProperty(m,'pea','attack').value,10);
  assert.equal(nativeProperty(m,'pea','interval').value,2);
  assert.equal(nativeProperty(m,'garden','attack',['a']).value,20);
  assert.equal(nativeProperty(m,'garden','attack',['b']).value,10);
  assert.equal(nativeProperty(m,'garden','attack',['c','inner']).value,30);
  for(const path of ['unknown/opaque.bin','unknown/authored.tres'])assert.deepEqual(f.service.native.archive.read(m.source_files[path]),Buffer.from(sourceTexts[path]));
  f.report.checks.push({name:'real Godot original source fixture',status:'passed',source_identity:m.source_identity});
});

test('AI property action contract uses native authority and actual run attribution',{timeout:300000},async t=>{
  // Deliberately fail if the implementation is missing; never silently skip the
  // feature tests or replace its exports with a test implementation.
  const api=await import('../../services/creation/authoring-actions.mjs');
  for(const name of ['createAuthoringAction','propertyActionContext','exposeActionProperties','actionResult'])assert.equal(typeof api[name],'function',name);
  const shared=await fixture(t);
  const expose=(f,s,r,input)=>api.exposeActionProperties(f.service,f.user,s,r,input);

  await caseCheck(t,shared,'creation persists native definition action and keeps goal; stale/scene/legacy targets reject',async()=>{
    const f=shared.project(),input=f.input(),action=api.createAuthoringAction(f.store,f.user,f.p,'main',input);
    assert.equal(action.type,'expose_properties');assert.equal(action.resource_id,'pea');
    const s=f.session();assert.equal(s.execution_mode,'goal');assert.ok(s.authoring_action);
    assert.deepEqual(f.store.sessionView(f.user,s.id).authoring_action,s.authoring_action);
    input.resource_id='other';assert.equal(s.authoring_action.resource_id,'pea','caller object is not the persistent authority');
    for(const extra of [{resource_id:'garden',expected_version:f.current().manifest.resources.garden.version},{resource_id:'missing'},{expected_version:'stale'}])await rejectUnchanged(f,()=>api.createAuthoringAction(f.store,f.user,f.p,'main',{...f.input(),...extra}));
    const old=f.input();await f.manual([{type:'set_native_resource',resource_id:'other',expected_version:f.current().manifest.resources.other.version,name:'Changed independently'}]);
    await rejectUnchanged(f,()=>f.store.createSession(f.user,f.p,'main',{authoring_action:old}),[409]);
    const legacy=f.store.createProject(f.user,{name:'Legacy action rejection'},{entry_scene_id:'legacy',resources:{legacy:{id:'legacy',kind:'scene',name:'Legacy',objects:[]},pea:{id:'pea',kind:'prefab',name:'Pea',objects:[]}}});
    assert.throws(()=>api.createAuthoringAction(f.store,f.user,legacy.project.id,'main',{type:'expose_properties',resource_id:'pea',revision:legacy.branch.head,expected_version:legacy.branch.manifest?.resources.pea.version??'legacy'}),error=>[409,422].includes(error.status));
  });

  await caseCheck(t,shared,'context is fixed and compact, includes actual bindings without claiming unused export is consumed',async()=>{
    const f=shared.project(),s=f.session(),r=f.run(s),captured=f.current().head;
    const context=await api.propertyActionContext(f.service,s,r,{revision:captured}),text=JSON.stringify(context);
    assert.ok(text.includes(captured));assert.ok(text.includes('pea-root'));assert.ok(text.includes('attack'));assert.ok(text.includes('unused_knob'));
    assert.ok(text.includes('scripts/pea.gd'),'provide actual source location');
    assert.equal(context.nodes.find(node=>node.node_id==='pea-root').native_path,'.','raw native index path must reach the action context');
    assert.equal(text.includes('UNRELATED_TARGET_CONTENT'),false,'unrelated source bodies do not belong in a target context');
    assert.equal(Object.hasOwn(context,'manifest'),false,'do not return the full branch manifest');
    await f.manual([{type:'set_native_resource',resource_id:'other',expected_version:f.current().manifest.resources.other.version,name:'LATER_CONTEXT_MARKER'}]);
    const fixed=await api.propertyActionContext(f.service,s,r,{revision:captured});assert.deepEqual(fixed,context,'fixed revision context cannot float with branch head');
    writeFileSync(join(f.data,'fixed-context.json'),JSON.stringify(context,null,2)+'\n');
  });

  await caseCheck(t,shared,'dedicated tool routing keeps plan read-only and prepare_only yields guarded native ops without saving',async()=>{
    const f=shared.project(),s=f.session(),r=f.run(s);
    s.executor_thread_id=uid('fixture-thread');f.store.put('creator_session',s);
    r.thread_id=s.executor_thread_id;r.turn_id=uid('fixture-turn');f.store.put('creator_run',r);
    const manager=Object.create(CreationAgentRuns.prototype);
    Object.assign(manager,{service:f.service,store:f.store,turnBindings:new Map(),requests:new Map()});
    const call=(tool,args={})=>manager.dynamic({threadId:r.thread_id,turnId:r.turn_id,callId:uid('call'),scope:{sessionId:s.id,userId:f.user.id},signal:new AbortController().signal,tool,arguments:args});
    const tools=api.propertyActionTools(CREATION_TOOLS,s).map(tool=>tool.name);
    assert.ok(tools.includes('authoring_context'));assert.ok(tools.includes('properties_expose'));assert.ok(tools.includes('workspace_prepare'));assert.ok(tools.includes('world_apply'));
    assert.equal(tools.includes('world_publish'),false);assert.equal(tools.includes('shared_world_validate'),false);
    assert.deepEqual(api.propertyActionTools(CREATION_TOOLS,{}),CREATION_TOOLS,'ordinary sessions retain their original tools');
    const cwd=resolve(f.data,'workspaces',f.p,'main',f.user.id,s.id);mkdirSync(cwd,{recursive:true});
    const fixedContext=f.service.environments.context({session:s,run:r,cwd,objective:'Add readable metadata to existing attack'});
    const manifest=JSON.parse(readFileSync(fixedContext.manifest));assert.deepEqual(manifest.authoring_action,r.authoring_action);
    assert.equal(JSON.parse(readFileSync(manifest.property_action_context)).revision,r.input_revision);
    assert.match(readFileSync(manifest.property_action_guide,'utf8'),/\/goal/);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd,'workspace.json'))).tools.sort(),[...tools].sort());
    const request=f.request([damage(f)]),before=f.current().head;
    r.execution_mode='plan';f.store.put('creator_run',r);await call('authoring_context');
    await rejectUnchanged(f,()=>call('properties_expose',request),[403]);
    r.execution_mode='goal';f.store.put('creator_run',r);
    const response=await call('properties_expose',{...request,prepare_only:true}),prepared=JSON.parse(response.contentItems[0].text);
    assert.equal(prepared.prepared,true);assert.equal(prepared.base_revision,before);assert.equal(f.current().head,before);assert.equal(prepared.ops.length,1);assert.equal(prepared.ops[0].resource_id,'pea');
    assert.deepEqual(f.store.get('creator_run',r.id).changes,[],'preparation is not a saved change');
    await rejectUnchanged(f,()=>expose(f,s,r,{...request,resource_id:'other'}),[400,403]);
    // Combine prepared metadata with a real implementation-file change using the
    // original central transaction, not a second source authority.
    const path='scripts/pea.gd',source=f.current().manifest.source_files[path];
    const committed=await f.service.committed(f.user,f.p,'main',{transaction_id:uid('prepared-commit'),base_revision:prepared.base_revision,expected_head:prepared.base_revision,ops:[...prepared.ops,{type:'put_source_file',path,expected_hash:source.hash,text:f.service.native.archive.read(source).toString()+'\n# Atomic implementation and metadata change\n'}]},origin(r));
    assert.equal(committed.revision,f.current().head);assert.ok(detail(f).properties.some(p=>p.id===request.properties[0].id&&p.name==='子弹伤害'));
    assert.equal(f.store.list('creator_game_verification').length,0,'saving does not create an automatic game check');
    assert.deepEqual(f.store.get('creator_run',r.id).verifications,[]);
  });

  await caseCheck(t,shared,'batch exposure adds semantics to exports atomically, preserves values/design/files, and replays once',async()=>{
    const f=shared.project(),s=f.session(),r=f.run(s),before=f.current(),request=f.request([damage(f),interval(f)]);
    const result=await expose(f,s,r,request),after=f.current();assert.equal(result.revision,after.head);assert.notEqual(after.head,before.head);
    const revision=f.store.get('creator_revision',result.revision);assert.equal(revision.origin.run_id,r.id);
    assert.equal(after.manifest.schema,'creation-native-1');assert.equal(after.manifest.source_identity,after.manifest.index_source_identity);
    const design=after.manifest.resources.pea.design;assert.equal(design.description,initialDesign.description);assert.deepEqual(design.relations,initialDesign.relations);
    assert.deepEqual(design.exposed_properties.find(p=>p.id==='health'),initialDesign.exposed_properties[0]);
    const exposed=detail(f).properties;
    for(const [name,value]of [['attack',10],['interval',2]]){const matches=exposed.filter(p=>p.binding.property===name);assert.equal(matches.length,1,'automatic and explicit exports must not duplicate');assert.equal(matches[0].value,value);assert.equal(matches[0].binding_valid,true);}
    for(const [rid,instances,value]of [['garden',['a'],20],['garden',['b'],10],['garden',['c','inner'],30]])assert.equal(nativeProperty(after.manifest,rid,'attack',instances).value,value);
    for(const [path,entry]of Object.entries(before.manifest.source_files))if(path!=='.atelier/catalog.json')assert.deepEqual(after.manifest.source_files[path],entry,'metadata-only exposure preserves '+path);
    const count=f.store.list('creator_revision').length,replayed=await expose(f,s,r,request);
    assert.equal(replayed.revision,result.revision);assert.equal(f.store.list('creator_revision').length,count);
    await rejectUnchanged(f,()=>expose(f,s,r,{...request,properties:[damage(f,{name:'Different retry'})]}),[409]);
    const refreshed=f.request([damage(f,{description:'Updated label only'})]);await expose(f,s,r,refreshed);
    assert.deepEqual(f.current().manifest.resources.pea.design.exposed_properties.map(p=>p.id).sort(),[exportId(f,'attack'),'health',exportId(f,'interval')].sort());
  });

  await caseCheck(t,shared,'invalid binding/type/duplicate/range/step batches reject with no partial writes',async()=>{
    const f=shared.project(),s=f.session(),r=f.run(s);
    const invalid=[
      ['missing property',damage(f,{binding:binding('not_implemented')})],
      ['other target node',damage(f,{binding:{node_id:'other-root',property:'attack'}})],
      ['wrong native type',damage(f,{type:'boolean',default:true,min:undefined,max:undefined,step:undefined})],
      ['definition outside range',damage(f,{min:11,default:12})],
      ['direct instance outside range',damage(f,{max:15})],
      ['nested instance outside range',damage(f,{max:25})],
      ['existing interval off step',interval(f,{default:1.5,step:1.5})],
    ];
    for(const [name,bad]of invalid){try{await rejectUnchanged(f,()=>expose(f,s,r,f.request([property('health','生命值','health',{min:0,max:500,step:1}),bad])),[422]);}catch(error){error.message=name+': '+error.message;throw error;}}
    await rejectUnchanged(f,()=>expose(f,s,r,f.request([damage(f),damage(f,{name:'duplicate'})])),[422]);
    await rejectUnchanged(f,()=>expose(f,s,r,f.request([damage(f),damage(f,{id:'same-binding'})])),[422]);
    assert.deepEqual(f.current().manifest.resources.pea.design,shared.initial.resources.pea.design);
  });

  await caseCheck(t,shared,'stale submission, revoked writer, foreign session, and cancelled lease reject',async()=>{
    const f=shared.project(),s=f.session(),r=f.run(s),stale=f.request([damage(f)]);
    await f.manual([{type:'set_native_resource',resource_id:'other',expected_version:f.current().manifest.resources.other.version,name:'Concurrent change'}]);
    await rejectUnchanged(f,()=>expose(f,s,r,stale),[409]);
    await rejectUnchanged(f,()=>expose(f,s,r,{...f.request([damage(f)]),expected_version:'old-version'}),[409]);
    const foreign=f.session();await rejectUnchanged(f,()=>expose(f,foreign,r,f.request([damage(f)])),[403,409]);
    const editor=f.store.register({name:uid('editor'),password:uid('test-password')}).user;f.store.setMember(f.user,f.p,editor.id,'editor');
    const es=f.store.createSession(editor,f.p,'main',{authoring_action:f.input()}),er={...f.run(es),owner_user_id:editor.id};f.store.put('creator_run',er);
    f.store.setMember(f.user,f.p,editor.id,'viewer');await rejectUnchanged(f,()=>api.exposeActionProperties(f.service,editor,es,er,f.request([damage(f)])),[403]);
    f.store.put('creator_run',{...r,status:'interrupted',lease_generation:2});
    await rejectUnchanged(f,()=>expose(f,s,r,f.request([damage(f)])),[409]);
  });

  await caseCheck(t,shared,'late completed Godot candidate cannot commit after cancellation or lease replacement',async()=>{
    for(const status of ['interrupted','running']){
    const f=shared.project(),s=f.session(),r=f.run(s),started=deferred(),release=deferred();
    const coordinator=f.service.native.transactions,original=coordinator.prepare;
    coordinator.prepare=async input=>{const actual=await original(input);started.resolve();await release.promise;return actual;};
    const pending=Promise.resolve().then(()=>expose(f,s,r,f.request([damage(f)])));
    // Catch an early rejection as well, so a broken implementation cannot leave
    // the test waiting forever for a preparation stage it never reached.
    try{
      await Promise.race([started.promise,pending.then(()=>{throw Error('candidate did not wait');})]);
      const head=f.current().head;f.store.put('creator_run',{...r,status,lease_generation:2});release.resolve();
      await assert.rejects(pending,error=>error.status===409);assert.equal(f.current().head,head);
    }finally{release.resolve();coordinator.prepare=original;await pending.catch(()=>{});}
    }
  });

  await caseCheck(t,shared,'run result is immutable under later writers, ignores no-op/foreign revisions and unrelated resource edits',async()=>{
    const f=shared.project(),s=f.session(),r=f.run(s),request=f.request([damage(f)]);
    const committed=await expose(f,s,r,request);r.changes=[committed.revision];f.store.put('creator_run',r);
    const result=api.actionResult(f.store,r);assert.ok(result,'committed action has a result');
    assert.deepEqual(f.store.sessionView(f.user,s.id).runs.find(run=>run.id===r.id).authoring_result,result);
    assert.ok(JSON.stringify(result).includes(committed.revision));assert.ok(result.properties.some(p=>p.id===exportId(f,'attack')));
    const next=clone(f.current().manifest.resources.pea.design);next.exposed_properties[1].name='LATER_WRITER_LABEL';next.exposed_properties.push(interval(f));
    const later=await f.service.semantic.updateResource(f.user,f.p,'main',{action:'update_design',transaction_id:uid('later'),base_revision:f.current().head,expected_version:f.current().manifest.resources.pea.version,resource_id:'pea',design:next});
    assert.deepEqual(api.actionResult(f.store,r),result,'branch latest cannot change this run result');
    const clean=f.run(f.session());clean.changes=[later.revision];f.store.put('creator_run',clean);
    const foreignResult=api.actionResult(f.store,clean);assert.ok(!JSON.stringify(foreignResult??null).includes('LATER_WRITER_LABEL'),'a manually attributed foreign commit is not this run work');
    assert.ok(!foreignResult?.properties?.some(p=>p.id===exportId(f,'attack')),'no work result cannot inherit preexisting properties');
    const unrelated=await f.service.committed(f.user,f.p,'main',{transaction_id:uid('unrelated'),base_revision:f.current().head,ops:[{type:'set_native_resource',resource_id:'other',expected_version:f.current().manifest.resources.other.version,name:'Unrelated run edit'}]},origin(clean));
    clean.changes=[unrelated.revision];f.store.put('creator_run',clean);
    assert.equal(api.actionResult(f.store,clean),null,'own unrelated resource edit must not report the action target saved');
    const unrelatedSource=await f.service.committed(f.user,f.p,'main',{transaction_id:uid('unrelated-source'),base_revision:f.current().head,ops:[{type:'put_source_file',path:'unknown/unrelated.txt',expected_hash:null,text:'Unreferenced source belongs to a different task'}]},origin(clean));
    clean.changes=[unrelatedSource.revision];f.store.put('creator_run',clean);
    assert.equal(api.actionResult(f.store,clean),null,'whole-project source identity changes are not target changes');
    assert.equal(f.store.sessionView(f.user,clean.session_id).runs.find(run=>run.id===clean.id).authoring_result,null);
    const noChange=f.run(f.session()),same=f.request([damage(f,{name:'LATER_WRITER_LABEL'})]);
    const unchanged=await expose(f,f.store.get('creator_session',noChange.session_id),noChange,same);noChange.changes=[unchanged.revision];f.store.put('creator_run',noChange);
    const empty=api.actionResult(f.store,noChange);assert.ok(!empty?.properties?.some(p=>p.id===exportId(f,'attack')),'identical metadata is not a changed property');
    writeFileSync(join(f.data,'attributed-result.json'),JSON.stringify({result,later_revision:later.revision,foreignResult,empty},null,2)+'\n');
  });

  await caseCheck(t,shared,'actual canonical Godot consumes changed definition while preserving overridden and nested instances',async()=>{
    const f=shared.project(),s=f.session(),r=f.run(s);await expose(f,s,r,f.request([damage(f),interval(f)]));
    let panel=detail(f);
    await f.service.semantic.updateResource(f.user,f.p,'main',{action:'set_property',resource_id:'pea',property_id:exportId(f,'attack'),value:12,transaction_id:uid('tune'),base_revision:panel.revision,expected_version:panel.target.expected_version});
    const fixed=f.current();assert.equal(nativeProperty(fixed.manifest,'garden','attack',['a']).value,20);assert.equal(nativeProperty(fixed.manifest,'garden','attack',['b']).value,12);assert.equal(nativeProperty(fixed.manifest,'garden','attack',['c','inner']).value,30);
    assert.deepEqual(fixed.manifest.resources.pea.native_nodes.find(node=>node.node_id==='pea-root').metadata.unrecognized_editor,{schema:99,nested:['keep',7]},'native save retains fields outside semantic controls');
    const validation=await f.service.validator.validate(f.user,f.p,'main',{revision:fixed.head,resource_id:'garden'});
    writeFileSync(join(f.data,'canonical-validation.json'),JSON.stringify(validation,null,2)+'\n');assert.equal(validation.status,'passed',JSON.stringify(validation));
    const output=validation.process.filter(row=>row.name==='runtime').map(row=>row.output??'').join('\n');
    const observed=output.split('\n').filter(line=>line.startsWith('AI_PROPERTY_CONSUMED ')).map(line=>JSON.parse(line.slice('AI_PROPERTY_CONSUMED '.length)));
    for(const [instance,attack]of [['A',20],['B',12],['Inner',30]]){const item=observed.find(row=>row.instance===instance);assert.ok(item,'real author script output for '+instance);assert.equal(item.attack,attack);assert.equal(item.damage,attack*2);assert.equal(item.interval,2);}
    assert.equal(f.current().head,fixed.head,'technical validation never edits or publishes source');
    for(const path of ['unknown/opaque.bin','unknown/authored.tres'])assert.deepEqual(f.service.native.archive.read(fixed.manifest.source_files[path]),Buffer.from(sourceTexts[path]));
  });
});
