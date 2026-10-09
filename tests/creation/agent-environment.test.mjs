/**
 * Independent Agent environment integration contracts. Store, asset collection,
 * project assembly and Godot processes are real; only Codex execution/RPC is an
 * explicit FAKE adapter. All state, projects, test scripts and reports are in
 * private temporary directories. No production service or paid Agent is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,readdirSync,cpSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,relative,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationAssets} from '../../services/creation/assets.mjs';
import {CreationAgentRuns,CREATION_TOOLS} from '../../services/creation/agent-runs.mjs';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';
import {snapshotProjectRuntime,assembleProject} from '../../services/creation/project-snapshot.mjs';
import {CreationEnvironments} from '../../services/creation/environments.mjs';
import {prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';
import {emptyDocument} from '../../services/creation/hierarchy.mjs';
import {identityTransform} from '../../packages/scene/transform.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {registerVerificationProject,prepareVerificationProject} from '../../services/creation/verification-project.mjs';
import {createCreationBackup,verifyCreationBackup,restoreCreationBackup} from '../../tools/backup-creation.mjs';

const root=resolve(import.meta.dirname,'../..');
const uid=prefix=>`${prefix}-${randomUUID()}`,clone=structuredClone;
const logicMarker='INDEPENDENT_ENVIRONMENT_REAL_LOGIC_TICK';
const logic=`extends RefCounted\nfunc initialize(context) -> Dictionary:\n\tcontext.state["ticks"] = 0\n\tif context.role == "authority":\n\t\tprint("ENV_USER_STATE "+JSON.stringify({"path":ProjectSettings.globalize_path("user://"),"before":FileAccess.file_exists("user://environment-test.txt")}))\n\t\tvar file=FileAccess.open("user://environment-test.txt",FileAccess.WRITE)\n\t\tif file == null:\n\t\t\treturn {"ok":false,"error":"isolated test save is not writable"}\n\t\tfile.store_string("independent actual user data probe")\n\t\tfile.close()\n\treturn {"ok":true}\nfunc tick(context, _delta: float) -> Dictionary:\n\tif context.role == "authority":\n\t\tcontext.state["ticks"] += 1\n\t\tif context.state["ticks"] == 5:\n\t\t\tprint("${logicMarker}")\n\treturn {"ok":true}\n`;

function allFiles(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{const path=join(directory,entry.name);return entry.isDirectory()?allFiles(path):entry.isFile()?[path]:[];});}
function rawInventory(directory){return Object.fromEntries(allFiles(directory).filter(file=>!relative(directory,file).split('/').some(p=>p.startsWith('.'))).map(file=>[relative(directory,file),hash(readFileSync(file))]));}
function retainExecution(report,receipt,label){
  const retained=resolve(report.evidence,label);mkdirSync(retained);
  cpSync(resolve(receipt.execution_directory,'logs'),resolve(retained,'logs'),{recursive:true});
  writeFileSync(resolve(retained,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  for(const file of allFiles(resolve(retained,'logs')).filter(path=>path.endsWith('.receipt.json'))){
    report.commands.push({label:label+'/'+relative(retained,file),...JSON.parse(readFileSync(file,'utf8'))});
  }
}

class ExplicitFakeExecutor extends EventEmitter{
  constructor(){super();this.connected=true;this.threads=new Map();this.turns=new Map();this.created=[];this.resumed=[];this.inputs=[];}
  async start(){}
  async listModels(){return {data:[{model:'FAKE-environment-model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};}
  async accountStatus(){return {account:{type:'FAKE-no-model-account'}};}
  async createThread(input){const id=uid('FAKE-thread');this.created.push(input);this.threads.set(id,{...input,loaded:true,busy:false,uncertain:false});return {thread:{id,cwd:input.cwd,turns:[]}};}
  async resumeThread(input){this.resumed.push(input);this.threads.set(input.threadId,{...input,loaded:true,busy:false,uncertain:false});return {thread:{id:input.threadId,cwd:input.cwd,turns:[]},reconciliation:{canSend:true}};}
  async sendTurn(threadId,input){this.inputs.push(clone(input));const turn={id:uid('FAKE-turn'),status:'inProgress',items:[]};this.turns.set(`${threadId}/${turn.id}`,turn);return {turn};}
  async stop(){}
}

function fixture(t){
  const data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-agent-environment-'))),store=new CreationStore(resolve(data,'creation.sqlite'));
  const evidence=resolve(root,'.local/creation-verification/agent-environment',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);mkdirSync(evidence,{recursive:true});
  const source_hashes=Object.fromEntries(['services/creation/project-snapshot.mjs','services/creation/environments.mjs','services/creation/execution-environment.mjs','services/creation/agent-runs.mjs','services/creation/export-builds.mjs','tests/creation/agent-environment.test.mjs'].map(file=>[file,hash(readFileSync(resolve(root,file)))]));
  const report={started_at:new Date().toISOString(),scope:'actual temporary SQLite/assets/project snapshots/Godot; explicit FAKE Codex adapter; no live rooms or paid Agent',data,evidence,source_hashes,commands:[],checks:[],completed:false};
  const service={root,data,origin:'http://127.0.0.1:48921',store,hierarchyEditing:true,worlds:null,realtime:{development(){},committed(){}},sessionEvent(sid,event){store.appendSessionEvent(sid,event);},observe(fn){return fn();}};
  service.assets=new CreationAssets({store,root,data});service.environments=new CreationEnvironments({service});
  const executor=new ExplicitFakeExecutor(),manager=new CreationAgentRuns({service,adapter:executor});service.agent=manager;
  const owner=store.register({name:uid('environment-owner'),password:uid('private-password')}).user;
  const manifest={schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Fixed environment scene',objects:[]}}};
  const project=store.createProject(owner,{name:'Independent environment project'},manifest).project.id;
  const behavior=service.assets.publish(owner,project,Buffer.from(logic),'environment-behavior.gd');
  let serial=0;
  const current=(b='main')=>store.branchView(owner,project,b);
  const apply=(ops,b='main',extra={})=>store.apply(owner,project,b,{transaction_id:`environment-${++serial}`,base_revision:current(b).head,ops,...extra});
  apply([{type:'put_object',resource_id:'scene',object_id:'logic',expected_version:null,object:{id:'logic',name:'Pinned BEFORE later head',kind:'anchor',position:[0,0,3],rotation:[0,0,0],scale:[1,1,1],solid:false,color:'#74d5cd',components:{behaviors:[{id:'environment-counter',api:1,script_hash:behavior.id,script_url:behavior.url,properties:{}}]}}}]);
  service.committed=(user,p,b,input,origin)=>store.apply(user,p,b,input,origin);
  t.after(async()=>{await manager.close();await service.environments.close?.();if(store.db.isOpen)store.close();report.completed_at=new Date().toISOString();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');rmSync(data,{recursive:true,force:true});});
  const session=()=>store.createSession(owner,project,'main',{title:'PRIVATE session not in project snapshot',visibility:'private'});
  const start=async(s=session(),actor=owner)=>{const result=await manager.send(actor,s.id,{text:'FAKE executor lease for actual environment contract only',client_user_message_id:uid('message')});return {session:store.sessionFor(actor,s.id),run:result.run,cwd:executor.created.find(input=>input.scope.sessionId===s.id)?.cwd??executor.threads.get(result.run.thread_id)?.cwd};};
  const request=(binding,tool,args={})=>({threadId:binding.run.thread_id,turnId:binding.run.turn_id,callId:uid('tool'),tool,arguments:args,cwd:binding.cwd,scope:manager.scope(binding.session),signal:new AbortController().signal});
  return {data,store,service,executor,manager,owner,project,behavior,report,current,apply,session,start,request};
}

test('FAKE validator routing: game_validate records a game check without invoking shared authority or publishing',async t=>{
  const f=fixture(t),binding=await f.start(),calls=[];
  f.service.worlds={validate:()=>assert.fail('A canonical game check must not use the shared-world host'),publish:()=>assert.fail('Validation must not publish')};
  f.service.validator={async validate(user,p,b,input){
    input.guard();calls.push({user,p,b,input});
    const result={id:uid('FAKE-canonical-verification'),project_id:p,branch_id:b,resource_id:input.resource_id,revision:input.revision,status:'passed',validation_kind:'canonical_game'};
    f.store.put('creator_verification',result);return result;
  }};
  const request=f.request(binding,'game_validate',{resource_id:'scene',revision:f.current().head});
  const first=await f.manager.dynamic(request),replayed=await f.manager.dynamic(request);
  assert.deepEqual(replayed,first);assert.equal(calls.length,1);assert.equal(calls[0].input.signal,request.signal);
  assert.equal(calls[0].p,f.project);assert.equal(calls[0].input.revision,f.current().head);
  await f.manager.dynamic(f.request(binding,'world_validate',{resource_id:'scene',revision:f.current().head}));
  assert.equal(calls.length,2,'existing sessions use the same validator through their persisted tool name');
  const run=f.store.get('creator_run',binding.run.id);assert.equal(run.verifications.length,2);assert.equal(run.deliveries.length,0);
  assert.ok(CREATION_TOOLS.some(tool=>tool.name==='game_validate'));
  assert.match(readFileSync(resolve(binding.cwd,'AGENTS.md'),'utf8'),/use game_validate/);
  f.report.completed=true;
});

function addPrefabs(f){
  const previous=f.current();f.apply([{type:'migrate_hierarchy'}],'main',{expected_head:previous.head});
  const model=f.store.list('creator_asset').find(asset=>asset.builtin&&asset.ext==='glb');assert.ok(model);
  const door=emptyDocument('door','prefab','Unplaced door definition');
  door.nodes.mesh={id:'mesh',name:'Door mesh',kind:'model',parent_id:'root',transform:identityTransform(),solid:false,color:'#aabbcc',components:{},model_hash:model.id,model_url:`/preview-assets/${model.id}.glb`};
  const house=emptyDocument('house','prefab','Nested house definition'),unplaced=emptyDocument('unused','prefab','Unplaced empty definition');
  f.apply([{type:'create_resource',resource_id:'door',resource:door},{type:'create_resource',resource_id:'house',resource:house},{type:'create_resource',resource_id:'unused',resource:unplaced}]);
  f.apply([{type:'instantiate_prefab',resource_id:'house',instance_id:'inside',expected_version:null,instance:{instance_id:'inside',prefab_id:'door',prefab_revision:f.current().manifest.resources.door.version,parent_id:'root',transform:identityTransform(),overrides:[]}}]);
  f.apply([{type:'instantiate_prefab',resource_id:'scene',instance_id:'placed',expected_version:null,instance:{instance_id:'placed',prefab_id:'house',prefab_revision:f.current().manifest.resources.house.version,parent_id:f.current().manifest.resources.scene.root_id,transform:{...identityTransform(),position:[6,0,0]},overrides:[]}}]);
  return {model};
}

test('shared assembler pins runtime and content and keeps nested and unplaced prefab definitions',async t=>{
  const f=fixture(t),{model}=addPrefabs(f),fixed=f.current(),session=f.session(),secret=uid('PRIVATE-context-never-export');
  f.store.updateSession(f.owner,session.id,{draft:secret});
  const isolatedRoot=resolve(f.data,'mutable-runtime-source'),directory=resolve(f.data,'assembled-project');
  for(const part of ['runtimes/model-preview','tools/release-template'])cpSync(resolve(root,part),resolve(isolatedRoot,part),{recursive:true,filter:path=>!relative(resolve(root,part),path).split('/').some(p=>p.startsWith('.')||p==='tests')});
  const runtime=snapshotProjectRuntime(isolatedRoot,directory);assert.ok(runtime.files.length);assert.match(runtime.hash,/^[a-f0-9]{64}$/);
  writeFileSync(resolve(isolatedRoot,'runtimes/model-preview/late-runtime-marker.txt'),'LATE_SOURCE_MUST_NOT_ENTER_SNAPSHOT');
  f.apply([{type:'patch_node',resource_id:'scene',node_id:'logic',expected_version:fixed.manifest.resources.scene.nodes.logic.version,patch:{name:'AFTER snapshot head'}}]);
  assert.notEqual(f.current().head,fixed.head);
  const actual=await assembleProject({service:f.service,user:f.owner,project_id:f.project,branch_id:'main',revision:fixed.head,entry_scene_id:'scene',directory,runtime_source_hash:runtime.hash,project_name:'Fixed independent project'});
  assert.equal(actual,directory);assert.equal(existsSync(resolve(directory,'late-runtime-marker.txt')),false);
  const release=JSON.parse(readFileSync(resolve(directory,'release.json'))),manifest=JSON.parse(readFileSync(resolve(directory,'source-manifest.json')));
  assert.equal(release.revision,fixed.head);assert.equal(release.runtime_source_hash,runtime.hash);assert.deepEqual(manifest,fixed.manifest);
  assert.deepEqual(Object.keys(release.scenes).sort(),['door','house','scene','unused']);
  const nested=release.scenes.scene.hierarchy_pack.objects.find(object=>object.address?.definition_node_id==='mesh');assert.deepEqual(nested.address.instance_path,['placed','inside']);
  assert.equal(release.scenes.unused.kind,'prefab');assert.equal(release.scenes.door.kind,'prefab');
  for(const asset of [model.id,f.behavior.id])assert.ok(Object.keys(release.assets).some(path=>path.includes(asset)));
  const text=allFiles(directory).filter(path=>/\.(?:gd|tscn|json|cfg|godot|txt|md)$/.test(path)).map(path=>readFileSync(path,'utf8')).join('\n');
  assert.equal(text.includes(secret),false);assert.equal(text.includes('AFTER snapshot head'),false);assert.doesNotMatch(JSON.stringify(release),/[?&]cap=/);
  for(const capability of f.service.assets.capabilities.values())assert.equal(text.includes(capability.token),false,'actual private asset capability is absent');
  assert.ok(existsSync(resolve(directory,'standalone.tscn')));assert.match(readFileSync(resolve(directory,'project.godot'),'utf8'),/run\/main_scene="res:\/\/standalone.tscn"/);
  f.report.checks.push({case:'fixed_runtime_content_prefab_closure',revision:fixed.head,later_head:f.current().head,runtime_hash:runtime.hash,resources:Object.keys(release.scenes),asset_count:Object.keys(release.assets).length});f.report.completed=true;
});

test('export assemble and creator assembler share the same fixed scene and prefab payloads',async t=>{
  const f=fixture(t);addPrefabs(f);const fixed=f.current(),builds=new CreationBuilds({service:f.service});t.after(()=>builds.close());
  const creatorDirectory=resolve(f.data,'creator-assembled'),creatorRuntime=snapshotProjectRuntime(root,creatorDirectory);
  await assembleProject({service:f.service,user:f.owner,project_id:f.project,branch_id:'main',revision:fixed.head,entry_scene_id:'scene',directory:creatorDirectory,runtime_source_hash:creatorRuntime.hash,project_name:'Same fixed content'});
  const job={id:uid('build'),actor_id:f.owner.id,project_id:f.project,project_name:'Same fixed content',branch_id:'main',source_revision:fixed.head,entry_scene_id:'scene'};
  const exportDirectory=resolve(builds.directory,job.id,'project'),exportRuntime=snapshotProjectRuntime(root,exportDirectory);job.runtime_source_hash=exportRuntime.hash;job.runtime_sources=exportRuntime.files;
  const assembledExport=await builds.assemble(job);assert.equal(assembledExport,exportDirectory);
  const creator=JSON.parse(readFileSync(resolve(creatorDirectory,'release.json'))),exported=JSON.parse(readFileSync(resolve(exportDirectory,'release.json')));
  assert.deepEqual(exported.scenes,creator.scenes);assert.deepEqual(exported.assets,creator.assets);assert.equal(exported.revision,creator.revision);
  assert.deepEqual(JSON.parse(readFileSync(resolve(exportDirectory,'source-manifest.json'))),fixed.manifest);
  assert.deepEqual(rawInventory(resolve(exportDirectory,'bundled')),rawInventory(resolve(creatorDirectory,'bundled')));
  f.report.checks.push({case:'export_creator_shared_payload',source_revision:fixed.head,resources:Object.keys(exported.scenes)});f.report.completed=true;
});

test('existing session preparation and resume preserve cwd, authored files and fixed context',async t=>{
  const f=fixture(t),session=f.session(),cwd=f.manager.workspace(session),authored=resolve(cwd,'my-existing-behavior.gd'),text='extends RefCounted\n# User-authored file survives environment upgrade\n';
  writeFileSync(authored,text);
  const descriptor=f.service.environments.session(session,cwd);assert.equal(descriptor.version,1);assert.equal(descriptor.cwd,cwd);assert.equal(descriptor.session_id,session.id);assert.ok(descriptor.tools.includes('workspace_prepare'));
  const binding=await f.start(session),fixedContext=f.service.environments.context({...binding,attachments:[{id:'immutable-old-annotation',source_revision:'older-observation',world_position:[12.5,3,-8.25]}],objective:'Fixed test context'});
  const context=JSON.parse(readFileSync(fixedContext.manifest));assert.equal(context.source_revision,binding.run.input_revision);assert.equal(context.attachments[0].source_revision,'older-observation');
  assert.equal(context.attachments[0].href,'attachment:immutable-old-annotation');assert.equal('world_position' in context.attachments[0],false);
  assert.deepEqual(JSON.parse(readFileSync(context.attachments[0].snapshot_file,'utf8')).world_position,[12.5,3,-8.25]);
  const before=readFileSync(fixedContext.manifest,'utf8');
  const target=f.current().manifest.resources.scene.objects[0];f.apply([{type:'patch_object',resource_id:'scene',object_id:target.id,expected_version:target.version,patch:{name:'Later head after context capture'}}]);
  f.executor.threads.clear();await f.manager.bind(f.store.sessionFor(f.owner,session.id));
  assert.equal(f.executor.resumed.at(-1).threadId,binding.run.thread_id);assert.equal(f.executor.resumed.at(-1).cwd,cwd);assert.equal(readFileSync(authored,'utf8'),text);assert.equal(readFileSync(fixedContext.manifest,'utf8'),before);
  f.report.checks.push({case:'existing_session_resumption',session_id:session.id,source_revision:context.source_revision,cwd_preserved:true,authored_file_preserved:true});f.report.completed=true;
});

test('environment preparation retains a chosen ancestor version and rejects foreign revision, scope and expired leases',async t=>{
  const f=fixture(t),binding=await f.start(),fixed=f.current();
  const target=fixed.manifest.resources.scene.objects[0];f.apply([{type:'patch_object',resource_id:'scene',object_id:target.id,expected_version:target.version,patch:{name:'New head is not the requested snapshot'}}]);
  const prepared=await f.service.environments.prepare({...binding,input:{revision:fixed.head,resource_id:'scene'}});
  assert.equal(prepared.source_revision,fixed.head);assert.equal(prepared.run_id,binding.run.id);assert.equal(prepared.session_id,binding.session.id);assert.equal(prepared.lease_generation,binding.run.lease_generation);
  assert.equal(JSON.parse(readFileSync(resolve(prepared.project_directory,'release.json'))).revision,fixed.head);
  assert.equal(JSON.parse(readFileSync(resolve(prepared.project_directory,'source-manifest.json'))).resources.scene.objects[0].name,'Pinned BEFORE later head');
  await assert.rejects(f.service.environments.prepare({...binding,input:{revision:'missing-source'}}),{status:409});
  await assert.rejects(f.service.environments.prepare({...binding,run:{...binding.run,lease_generation:binding.run.lease_generation+1}}),{status:409});
  await assert.rejects(f.service.environments.prepare({...binding,cwd:f.data}),{status:403});
  f.store.fork(f.owner,f.project,{from_branch:'main',branch_id:'other',expected_head:f.current().head});
  const forkTarget=f.current('other').manifest.resources.scene.objects[0];const forkOnly=f.apply([{type:'patch_object',resource_id:'scene',object_id:forkTarget.id,expected_version:forkTarget.version,patch:{name:'Fork-only revision'}}],'other');
  await assert.rejects(f.service.environments.prepare({...binding,input:{revision:forkOnly.revision}}),{status:409});
  const second=await f.start();await assert.rejects(f.service.environments.test({...second,input:{environment_id:prepared.id}}),{status:403});
  await assert.rejects(f.service.environments.test({...binding,input:{environment_id:prepared.id,resource_id:'absent'}}),{status:404});
  f.report.checks.push({case:'fixed_scope_version_lease',environment_id:prepared.id,source_revision:prepared.source_revision,rejected:['missing-source','changed-lease','wrong-cwd','fork-only-revision','other-session','absent-resource']});f.report.completed=true;
});

test('revoked editor permission prevents environment preparation and existing environment execution',async t=>{
  const f=fixture(t),editor=f.store.register({name:uid('environment-editor'),password:uid('private-password')}).user;
  f.store.setMember(f.owner,f.project,editor.id,'editor');const session=f.store.createSession(editor,f.project,'main'),binding=await f.start(session,editor);
  const prepared=await f.service.environments.prepare(binding);f.store.setMember(f.owner,f.project,editor.id,null);
  await assert.rejects(f.service.environments.prepare(binding),{status:403});await assert.rejects(f.service.environments.test({...binding,input:{environment_id:prepared.id}}),{status:403});
  f.report.checks.push({case:'revoked_project_access',environment_id:prepared.id});f.report.completed=true;
});

test('changed fixed project input fails before launching a Godot test',async t=>{
  const f=fixture(t),binding=await f.start(),prepared=await f.service.environments.prepare(binding),config=resolve(prepared.project_directory,'release.json');
  writeFileSync(config,readFileSync(config,'utf8')+'\n');
  const tested=await f.service.environments.test({...binding,input:{environment_id:prepared.id}});
  assert.equal(tested.status,'failed');assert.match(tested.error,/固定工程输入已变化/);assert.equal(tested.exit_code,null);assert.equal(f.service.environments.children.size,0);
  const saved=f.store.get('creator_environment_test',tested.id);assert.equal(saved.status,'failed');assert.ok(existsSync(tested.receipt_file));
  f.report.checks.push({case:'tampered_fixed_input',test_id:tested.id,status:tested.status});f.report.completed=true;
});

test('context current symlink cannot overwrite a target outside the creator workspace',async t=>{
  const f=fixture(t),binding=await f.start(),outside=resolve(f.data,'private-outside-current.json'),sentinel='independent outside target remains unchanged\n';
  writeFileSync(outside,sentinel);const current=resolve(binding.cwd,'context/current.json');rmSync(current);symlinkSync(outside,current);
  assert.throws(()=>f.service.environments.context({...binding,objective:'Attempt linked current pointer'}),{code:'ELOOP'});
  assert.equal(readFileSync(outside,'utf8'),sentinel);
  f.report.checks.push({case:'context_symlink_no_follow',outside_target_preserved:true});f.report.completed=true;
});

test('real Godot early error remains rejected after more than 64 KB of later output',{timeout:90000},async t=>{
  const f=fixture(t),binding=await f.start(),project=resolve(f.data,'actual-error-project');mkdirSync(project);
  writeFileSync(resolve(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Independent error tail probe"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  writeFileSync(resolve(project,'error-probe.gd'),'extends SceneTree\nfunc _initialize():\n\tcall_deferred("probe")\nfunc probe():\n\tpush_error("INDEPENDENT_EARLY_ERROR")\n\tawait create_timer(0.05).timeout\n\tfor i in range(160):\n\t\tprint("ENV_LATE_LOG "+"x".repeat(1024))\n\tprint("INDEPENDENT_LATE_LOG_COMPLETE")\n\tquit(0)\n');
  const execution=prepareExecutionEnvironment({directory:resolve(f.data,'error-execution'),readPaths:[project]});
  let rejected;
  await assert.rejects(f.service.environments.command(execution,['--headless','--path',project,'--script','res://error-probe.gd'],{context:binding,project,logName:'early-error.log'}),error=>{
    rejected=error;assert.equal(error.exit_code,0);assert.equal(error.output.length,64000);assert.ok(error.output.includes('INDEPENDENT_LATE_LOG_COMPLETE'));assert.equal(error.output.includes('INDEPENDENT_EARLY_ERROR'),false);return true;
  });
  const receipt=JSON.parse(readFileSync(resolve(execution.directories.logs,'early-error.log.receipt.json'),'utf8'));
  f.report.commands.push({label:'actual_early_error_discarded_from_output_tail',...receipt});
  f.report.checks.push({case:'real_godot_error_before_output_tail',rejected:true,exit_code:rejected.exit_code,retained_output_bytes:rejected.output.length});f.report.completed=true;
});

test('closing environments waits for deferred preparation and leaves no work after database close',async t=>{
  const f=fixture(t),binding=await f.start(),environments=f.service.environments,actualPrepare=environments.prepareOnce.bind(environments);
  let entered,release;const atPrepare=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  environments.prepareOnce=async options=>{entered();await gate;return actualPrepare(options);};
  let writesAfterClose=0;const actualPut=f.store.put.bind(f.store);
  f.store.put=(...args)=>{if(!f.store.db.isOpen)writesAfterClose++;return actualPut(...args);};
  const preparing=environments.prepare(binding),rejected=assert.rejects(preparing,{status:503,message:'执行环境服务正在关闭'});await atPrepare;
  let closed=false,closing;
  try{
    closing=environments.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closed,false,'close remains pending until deferred preparation has settled');assert.equal(environments.pending.size,1);assert.equal(f.store.db.isOpen,true);
  }finally{release();}
  await rejected;await closing;
  assert.equal(environments.pending.size,0);assert.equal(environments.active.size,0);assert.equal(environments.children.size,0);assert.equal(f.store.list('creator_environment').length,0);
  await f.manager.close();f.store.close();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writesAfterClose,0);assert.equal(environments.pending.size,0);
  f.report.checks.push({case:'environment_close_during_prepare',preparation_status:503,close_waited:true,pending_after_close:environments.pending.size,writes_after_database_close:writesAfterClose});f.report.completed=true;
});

test('real Godot imports and executes fixed environments with distinct user data and actual original behavior',{timeout:240000},async t=>{
  const f=fixture(t);addPrefabs(f);const binding=await f.start(),fixed=f.current();
  const prepareResponse=await f.manager.dynamic(f.request(binding,'workspace_prepare',{revision:fixed.head,resource_id:'scene'}));
  assert.equal(prepareResponse.success,true);const prepared=JSON.parse(prepareResponse.contentItems[0].text);
  const receipts=[];
  for(let i=0;i<2;i++){
    const response=await f.manager.dynamic(f.request(binding,'workspace_test',{environment_id:prepared.id,resource_id:'scene'}));assert.equal(response.success,true);
    const receipt=JSON.parse(response.contentItems[0].text);receipts.push(receipt);assert.equal(receipt.status,'passed',JSON.stringify(receipt));assert.equal(receipt.claim,'technical_standalone_smoke_only');assert.equal(receipt.source_revision,fixed.head);
    assert.match(receipt.engine,/^4\.6\.stable\./);assert.ok(receipt.output.includes(logicMarker),'actual original behavior executed');
    const ready=receipt.output.split('\n').find(line=>line.startsWith('STANDALONE_READY '));assert.ok(ready);assert.equal(JSON.parse(ready.slice('STANDALONE_READY '.length)).revision,fixed.head);
    const line=receipt.output.split('\n').find(line=>line.startsWith('ENV_USER_STATE '));assert.ok(line,'real Godot user path probe ran');const state=JSON.parse(line.slice('ENV_USER_STATE '.length));
    assert.equal(state.before,false,'each independent test starts without another task save');assert.ok(realpathSync(state.path).startsWith(realpathSync(receipt.user_data_home)+'/'));
    assert.equal(readFileSync(resolve(state.path,'environment-test.txt'),'utf8'),'independent actual user data probe');
    retainExecution(f.report,receipt,'godot-test-'+i);
    f.report.checks.push({case:'actual_standalone_behavior_and_user_data',test_id:receipt.id,source_revision:receipt.source_revision,engine:receipt.engine,actual_user_path:state.path,previous_save:state.before,output:receipt.output});
  }
  assert.notEqual(receipts[0].user_data_home,receipts[1].user_data_home);assert.notEqual(receipts[0].execution_directory,receipts[1].execution_directory);
  const prefabResponse=await f.manager.dynamic(f.request(binding,'workspace_test',{environment_id:prepared.id,resource_id:'house'}));
  const prefabTest=JSON.parse(prefabResponse.contentItems[0].text);assert.equal(prefabTest.status,'passed',JSON.stringify(prefabTest));assert.ok(prefabTest.output.includes('STANDALONE_READY'));
  retainExecution(f.report,prefabTest,'godot-prefab-house');
  f.report.checks.push({case:'actual_nested_prefab_standalone',test_id:prefabTest.id,source_revision:prefabTest.source_revision,resource_id:'house',engine:prefabTest.engine,output:prefabTest.output});
  assert.equal(f.store.list('creator_world').length,0);assert.equal(f.current().head,fixed.head,'test never mutates source');f.report.completed=true;
});

test('manual game validation registers the exact canonical project and backup restores those bytes',async t=>{
  const f=fixture(t);addPrefabs(f);const binding=await f.start(),fixed=f.current(),job={id:uid('game-check'),job_kind:'creator_game_verification',project_id:f.project,branch_id:'main',actor_id:f.owner.id,session_id:binding.session.id,run_id:binding.run.id,revision:fixed.head,resource_ids:['scene','house'],reports:[],checks:[],status:'running'};
  f.store.put('creator_game_verification',job);
  const prepared=await prepareVerificationProject({service:f.service,job}),project=prepared.manifest,directory=prepared.directory;
  assert.equal(project.job_kind,'creator_game_verification');assert.equal(project.project_hash,hash(project.files));assert.equal(project.source_revision,fixed.head);
  assert.ok(project.files.some(file=>file.path==='standalone.gd'));assert.ok(project.files.some(file=>file.path==='source-manifest.json'));assert.ok(project.files.some(file=>file.path.startsWith('bundled/')));
  assert.deepEqual(registerVerificationProject({service:f.service,job,directory,runtime_source_hash:project.runtime_source_hash}),project);
  await assert.rejects(prepareVerificationProject({service:f.service,job:{...job,game_runtime_source_hash:'0'.repeat(64)}}),{status:409});
  const out=f.data+'-canonical-backup',restored=f.data+'-canonical-restore';t.after(()=>{rmSync(out,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});});
  await createCreationBackup({data:f.data,out});await verifyCreationBackup({from:out});
  const retention=JSON.parse(readFileSync(join(out,'retention.json'))).canonical_game;assert.equal(retention.verification_projects.length,1);assert.deepEqual(retention.unregistered_verification_jobs,[]);
  await restoreCreationBackup({from:out,out:restored});
  const recovered=new CreationStore(join(restored,'data/creation.sqlite'));try{assert.equal(recovered.get('creator_game_verification',job.id).status,'interrupted');assert.deepEqual(recovered.get('creator_verification_project',job.id),project);}finally{recovered.close();}
  for(const file of project.files){const bytes=readFileSync(join(restored,'data',project.directory,file.path));assert.equal(hash(bytes),file.sha256);}
  const target=join(directory,'standalone.gd');writeFileSync(target,readFileSync(target,'utf8')+'\n# deliberate corruption after exact snapshot\n');
  assert.throws(()=>registerVerificationProject({service:f.service,job,directory,runtime_source_hash:project.runtime_source_hash}),{status:409});
  const damaged=f.data+'-corrupted-canonical-backup';t.after(()=>rmSync(damaged,{recursive:true,force:true}));await assert.rejects(createCreationBackup({data:f.data,out:damaged}));assert.ok(!existsSync(damaged));
  f.report.checks.push({case:'exact_manual_validation_project_backup_restore',job_id:job.id,project_hash:project.project_hash,files:project.files.length,source_revision:fixed.head});f.report.completed=true;
});

test('legacy unregistered independent checks keep historical results and explicit missing-project boundary',async t=>{
  const f=fixture(t),fixed=f.current(),job={id:uid('auto-check'),project_id:f.project,branch_id:'main',actor_id:f.owner.id,session_id:'historical-session',run_id:'historical-run',revision:fixed.head,resource_ids:['scene'],reports:[],checks:[],status:'passed',review_thread_id:'historical-thread',summary:'Historical result retained unchanged'};
  f.store.put('creator_auto_verification',job);const out=f.data+'-legacy-backup';t.after(()=>rmSync(out,{recursive:true,force:true}));
  await createCreationBackup({data:f.data,out});await verifyCreationBackup({from:out});
  const retention=JSON.parse(readFileSync(join(out,'retention.json'))).canonical_game;assert.deepEqual(retention.verification_projects,[]);assert.equal(retention.unregistered_verification_jobs[0].job_id,job.id);assert.equal(retention.unregistered_verification_jobs[0].exact_project_retained,false);
  assert.deepEqual(f.store.get('creator_auto_verification',job.id),job);assert.equal(f.store.list('creator_verification_project').length,0);f.report.completed=true;
});
