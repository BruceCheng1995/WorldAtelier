import {annotationTargets} from './viewport-annotations.mjs';
import {AiLimits,aiActive} from './ai-limits.mjs';
import {GODOT_TEST_GUIDANCE,GODOT_TEST_REMINDER} from './godot-test-policy.mjs';
import {AutomaticSessionResume} from './automatic-session-resume.mjs';
import {encodeAgentToolResult,replayAgentToolResult} from './agent-tool-result.mjs';
import {assertAgentSourceOperations} from './agent-text-context.mjs';
import {AGENT_ASSET_GUIDANCE,AGENT_ASSET_REMINDER} from './agent-asset-policy.mjs';
import {AGENT_PREFAB_REMINDER} from './agent-prefab-policy.mjs';
import {projectGameAssetSkill} from './agent-skills.mjs';
import {referenceIds,expandReferenceText} from '../../packages/contracts/authoring-references.mjs';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CreationEnvironments, writeWorkspaceFile } from './environments.mjs';
import { CodexAgent } from './codex-agent.mjs';
import { drainCancelledTurn } from './cancel-cleanup.mjs';
import { describeElicitation, validateElicitationResult } from './elicitation.mjs';
import { clone, fail, hash, id, identifier } from './schema.mjs';
import { targetFromAttachment, targetsForOperations, publicTargetResolver, worldApiGuide } from './hierarchy-agent.mjs';
import { HIERARCHY_SCHEMA, resolveScene, scopedAddressKey } from './hierarchy.mjs';
import { hierarchyPreview } from './hierarchy-store.mjs';
import { designKnowledgeIndex, SEMANTIC_AUTHORING_GUIDE } from './semantic-context.mjs';
import {nativeWorldApiGuide,nativeSemanticAuthoringGuide,readNativeAgentSource,commitNativeWorkspaceApply,nativeTargetsForOperations} from './native-agent-workspace.mjs';
import {nativeObjectViews,nativeAddressKey} from './native-view.mjs';
import {propertyActionTools,propertyActionContext,exposeActionProperties} from './authoring-actions.mjs';

const creatorWorldApiGuide=manifest=>nativeWorldApiGuide(manifest)||worldApiGuide(manifest);
const creatorTargetKey=target=>{
  const address=target.address??target;
  return JSON.stringify([address.project_id,address.branch_id,address.resource_id,nativeAddressKey(address)]);
};

const terminal=new Set(['completed','interrupted','failed']);
const tool=(name,description,properties={},required=[])=>({type:'function',name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const string={type:'string'};
export const CREATION_TOOLS=[
  tool('asset_catalog','Discover asset market filter values, labels, sort options and search syntax. Use before searching unfamiliar asset categories.',{}),
  tool('asset_search','Search free official and developer assets with Chinese/English aliases and combined filters. For an unspecified controllable human protagonist, filter publisher=official, role=humanoid, capability=controllable,animated. Returns compact metadata and fixed IDs/versions. Use asset_detail for actual animation names and usage.',{q:string,dimension:string,category:string,publisher:string,role:string,genre:string,style:string,license:string,capability:string,sort:{type:'string',enum:['relevance','newest','updated','name','size','animations']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:60}}),
  tool('asset_detail','Read a fixed market asset description, capabilities, license, preview references and file manifest. No binary payloads.',{asset_id:string,version:string},['asset_id']),
  tool('asset_import','Copy a fixed market asset into this game through a guarded native source transaction. Registers its controller scene as a prefab. Use before editing local files; after importing reconcile your editable workspace with the new source without discarding unsubmitted work, then instance the returned prefab in your game scene. Originals remain immutable. Does not build or publish the game.',{asset_id:string,version:string,base_revision:string,transaction_id:string},['asset_id','version','base_revision','transaction_id']),
  tool('semantic_read','Read game design units, descriptions and exposed properties, including model-free systems. Returns actual bound values; query without resource_id for the complete directory.',{resource_id:string,revision:string,object_id:string,address:{type:'object',additionalProperties:true}}),
  tool('semantic_apply','Edit game descriptions and actual adjustable parameters. Native bindings use node_id,property,optional instance_ids; legacy bindings use node_id,behavior_id,property_key. set_property/reset_property use current version guards. Read SEMANTIC-AUTHORING.md for the active source schema.',{action:{type:'string',enum:['update_design','set_property','reset_property','create_resource']},transaction_id:string,base_revision:string,expected_version:{type:['string','null']},resource_id:string,design:{type:'object',additionalProperties:true},property_id:string,value:{},object_id:string,address:{type:'object',additionalProperties:true},name:string,category:string},['action','transaction_id','base_revision','resource_id']),
  tool('knowledge_search','Search shared project/branch design knowledge by keyword. Returns versioned indices and excerpts, not private conversations.',{q:string,revision:string,limit:{type:'integer',minimum:1,maximum:50}}),
  tool('knowledge_read','Read the full content of a shared design knowledge entry at the selected branch revision.',{id:string,revision:string},['id']),
  tool('knowledge_write','Save or remove shared game design knowledge, keeping immutable revisions and conflicts. Use knowledge_search/read first.',{action:{type:'string',enum:['put','delete']},transaction_id:string,base_revision:string,expected_version:{type:['string','null']},knowledge_id:string,entry:{type:'object',additionalProperties:true}},['action','transaction_id','base_revision','knowledge_id']),
  tool('world_read','Read current authoritative source and engine object/property versions. Native projects expose the complete source file index; source_path returns only the requested file (at most 256 KiB) and fixed revision identity, without full scene indices. Use resource_id without source_path for object/property versions. Always read current versions before editing.',{resource_id:string,source_path:string,revision:string}),
  tool('workspace_prepare','Materialize the complete fixed canonical Godot game project, including every scene, prefab and native source file. For native projects the host already prepares editable_project_directory; edit native files and download/generate/import assets there; submit all file changes with world_apply submit_native_workspace. Asset bytes stay on disk; context uses references. Read WORLD-API.md first.',{revision:string,resource_id:string}),
  tool('workspace_test','Run actual isolated Godot import and canonical GameRuntime startup smoke checks (the same project used by editor Play, standalone Web and native exports) on an environment returned by workspace_prepare. Returns engine, input hashes, logs and actual outcome. This does not prove the gameplay goal or publish to a live world.',{environment_id:string,resource_id:string},['environment_id']),
  tool('world_apply','Atomically edit the current source schema. Native projects support native properties, exact source file changes, or one submit_native_workspace operation containing environment_id and path under work/. A receipt means source saved. Read WORLD-API.md.',{transaction_id:string,base_revision:string,expected_head:string,inverse_transaction_id:string,ops:{type:'array',items:{type:'object',additionalProperties:true}}},['transaction_id','base_revision','ops']),
  tool('world_hierarchy_preview','Read-only fixed-head prefab impact or instance upgrade preview. Supply prefab_id and prefab_revision for impact, or resource_id, instance_id and prefab_revision for one instance upgrade. Read the current manifest and WORLD-API.md first. This does not mutate source or runtime.',{expected_head:string,resource_id:string,instance_id:string,prefab_id:string,prefab_revision:string},['expected_head','prefab_revision']),
  tool('asset_publish','Register a local GLB model or UTF-8 GDScript by workspace path; returns hash and metadata, never bytes. For native projects and other asset formats (PNG, textures, audio, etc.), put files in the editable Godot project and use world_apply submit_native_workspace.',{path:string},['path']),
  tool('game_validate','Validate a fixed game source revision through the canonical GameRuntime project used by editor Play, standalone Web and native exports. Runs real isolated Godot and records technical evidence. This does not publish or prove the gameplay goal.',{resource_id:string,revision:string}),
  tool('world_validate','Compatibility name for game_validate, retained for existing creator sessions. Validates the canonical game project; this does not validate or apply a shared-world checkpoint.',{resource_id:string,revision:string}),
  tool('shared_world_validate','Validate compatibility with the separate shared authoritative world service. Use only for an explicitly shared-world task; ordinary game development uses game_validate.',{resource_id:string,revision:string}),
  tool('world_publish','For an explicitly shared-world task, validate and apply compatible content to the running authoritative world and wait for the real Godot applied receipt. This is not required to play or export a saved game. The source head must still match.',{resource_id:string,revision:string})
];

export class CreationAgentRuns {
  constructor({service,codexPath,adapter,cleanupOptions={},autoResumeOptions={}}) {
    this.service=service;this.store=service.store;this.directory=resolve(service.data,'workspaces');mkdirSync(this.directory,{recursive:true});
    this.environments=service.environments??new CreationEnvironments({service});
    this.adapter=adapter??new CodexAgent({workspaceRoot:this.directory,...(codexPath?{codexPath}:{}),networkAccess:true});
    this.aiLimits=new AiLimits(this.store);this.limitTimer=setInterval(()=>this.enforceAiLimits(),1000);this.limitTimer.unref();
    this.starting=null;this.models=null;this.account=null;this.requests=new Map();this.sending=new Set();this.bindings=new Map();this.turnBindings=new Map();this.cleanups=new Map();this.goalPauses=new Map();this.cleanupOptions=cleanupOptions;this.closing=false;
    this.autoResume=new AutomaticSessionResume(this,autoResumeOptions);
    this.adapter.on('event',event=>this.event(event));
    this.adapter.on('request',event=>this.request(event));
    this.adapter.on('terminal',event=>this.finished(event));
    this.adapter.on('disconnected',event=>{
      this.requests.clear();
      for(const run of this.store.list('creator_run'))if(['starting','running','cancelling'].includes(run.status)||run.cleanup_status==='pending'){
        this.autoResume.capture(run,'executor_disconnected');
        run.executor_disconnect={at:Date.now(),epoch:event?.epoch,code:event?.code,signal:event?.signal,cause:event?.cause??null};
        if(!terminal.has(run.status))run.status='uncertain';
        if(this.cancelled(run)){run.cleanup_status='uncertain';run.cleanup_error='executor_disconnected';}
        run.lease_generation++;this.store.put('creator_run',run);this.service.sessionEvent(run.session_id,{kind:'run_state',run});this.publicState(run.project_id,run.branch_id);
        this.autoResume.schedule(run.id);
      }
    });
    // Restart only schedules reconciliation. An unknown turn is never replayed.
    for(const run of this.store.list('creator_run')){
      const unfinished=['starting','running','cancelling'].includes(run.status),cancelled=this.cancelled(run);
      if(unfinished)this.autoResume.capture(run,'host_restart');
      if(unfinished)run.status='uncertain';
      // A completed cleanup is durable evidence, not a connection flag. New
      // command events still reopen its generation through queueCleanup.
      const stopped=terminal.has(run.status)&&run.cleanup_status==='verified'&&run.cleanup_result?.status==='verified';
      if(cancelled&&!stopped){run.cancel_requested_at??=run.completed_at??Date.now();run.cleanup_status='uncertain';run.cleanup_error='host_restart_reconcile_required';}
      if(unfinished||cancelled){run.lease_generation++;this.store.put('creator_run',run);}
      this.autoResume.schedule(run.id);
    }
  }
  async start() {
    if(this.starting)return this.starting;
    if(this.adapter.connected&&this.models)return;
    this.starting=(async()=>{await this.adapter.start();const results=await Promise.all([this.adapter.listModels(),this.adapter.accountStatus()]);this.models=results[0].data??[];this.account=results[1].account;})().finally(()=>this.starting=null);
    return this.starting;
  }
  async status() {
    try{await this.start();return {ready:true,connected:true,executor:'local-codex-app-server',account_type:this.account?.type??null,authenticated:Boolean(this.account),default_model:this.models.find(m=>m.isDefault)?.model??this.models[0]?.model,models:this.models.map(m=>({id:m.id,model:m.model,displayName:m.displayName,description:m.description,isDefault:m.isDefault,supportedReasoningEfforts:m.supportedReasoningEfforts}))};}
    catch(error){return{ready:false,connected:false,error:error.message};}
  }
  sessionForThread(threadId){return this.store.list('creator_session').find(s=>s.executor_thread_id===threadId);}
  runForSession(sid){return this.store.list('creator_run').filter(r=>r.session_id===sid).sort((a,b)=>b.created_at-a.created_at)[0];}
  runForTurn(threadId,turnId){return turnId?this.store.list('creator_run').find(r=>r.thread_id===threadId&&(r.turn_id===turnId||r.turn_ids?.includes(turnId))):null;}
  pendingForRun(run){return [...this.requests.values()].some(r=>r.params?.threadId===run.thread_id&&r.params?.turnId===run.turn_id&&Boolean(run.turn_id));}
  continueGoal(session,input) {
    if(!input.goal_id){if(input.expected_run_id)fail(400,'继续运行必须指定目标');return null;}
    const goal=this.store.get('creator_goal',input.goal_id);
    if(!goal||goal.session_id!==session.id)fail(404,'此会话没有该目标');
    if(goal.run_id!==input.expected_run_id)fail(409,'目标已开始新的运行，请刷新后继续');
    const old=this.store.get('creator_run',goal.run_id);
    if(!old||!terminal.has(old.status)||this.pendingForRun(old))fail(409,'目标执行尚未结束或仍在等待输入');
    return goal;
  }
  cancelled(run){return Boolean(run&&(run.cancel_requested_at||run.cleanup_status||run.status==='interrupted'||run.status==='cancelling'));}
  cleanupBlocked(sid){return this.store.list('creator_run').filter(r=>r.session_id===sid&&this.cancelled(r)&&r.cleanup_status!=='verified');}
  assertCleanupReady(sid){const runs=this.cleanupBlocked(sid);if(runs.length)fail(409,'此前取消任务的命令尚未确认停止，请先核对清理结果',{runs,cleanup_status:runs[0].cleanup_status??'uncertain'});}
  commandEvidence(run,turnId=null) {
    const turnIds=new Set(turnId?[turnId]:[...(run.turn_ids??[]),run.turn_id]);
    const items=new Map((run.command_items??[]).filter(item=>!turnId||!item.turn_id&&run.turn_id===turnId||item.turn_id===turnId).map(item=>[item.id,item]));
    // Trusted private event history only. No client-supplied process or item IDs.
    for(const row of this.store.db.prepare('SELECT body FROM events WHERE project_id=? ORDER BY sequence').all(`session:${run.session_id}`)){
      const event=JSON.parse(row.body),p=event.params;
      if(event.kind!=='notification'||p?.threadId!==run.thread_id||!turnIds.has(p.turnId)||!['item/started','item/completed'].includes(event.method)||p.item?.type!=='commandExecution')continue;
      const old=items.get(p.item.id);if(!old||event.method==='item/completed'||old.status==='inProgress')items.set(p.item.id,{...clone(p.item),turn_id:p.turnId});
    }
    return [...items.values()];
  }
  markCleanup(runId,reason) {
    const run=this.store.get('creator_run',runId);if(!run)return;
    run.cancel_requested_at??=Date.now();run.cleanup_status='pending';run.cleanup_error=null;run.cleanup_generation=(run.cleanup_generation??0)+1;run.cleanup_reason=reason;run.lease_generation++;
    this.store.put('creator_run',run);this.service.sessionEvent(run.session_id,{kind:'run_state',run});this.publicState(run.project_id,run.branch_id);return run;
  }
  queueCleanup(runId,{reset=false,reason='cancel_requested'}={}) {
    let run=this.store.get('creator_run',runId);if(!run||!this.cancelled(run))return Promise.resolve(null);
    if(reset||run.cleanup_status!=='pending')run=this.markCleanup(runId,reason);
    if(this.cleanups.has(runId))return this.cleanups.get(runId);
    if(this.closing||!this.adapter.connected){run.cleanup_status='uncertain';run.cleanup_error='executor_not_connected';this.store.put('creator_run',run);this.service.sessionEvent(run.session_id,{kind:'run_state',run});return Promise.resolve(null);}
    const pending=this.drainCleanup(runId).catch(error=>{
      const latest=this.store.get('creator_run',runId);latest.cleanup_status='uncertain';latest.cleanup_error=error.message;this.store.put('creator_run',latest);this.service.sessionEvent(latest.session_id,{kind:'run_state',run:latest});return{status:'uncertain',reason:error.message};
    }).finally(()=>this.cleanups.delete(runId));
    this.cleanups.set(runId,pending);return pending;
  }
  async drainCleanup(runId) {
    await this.pauseRunGoal(runId);
    for(let attempt=0;attempt<3;attempt++){
      let run=this.store.get('creator_run',runId);if(!run.turn_id)throw Error('cancelled_turn_id_unconfirmed');
      const generation=run.cleanup_generation,items=this.commandEvidence(run);
      run.command_items=items;this.store.put('creator_run',run);
      const results=[];
      for(const turnId of new Set([...(run.turn_ids??[]),run.turn_id])){
      const turnItems=this.commandEvidence(run,turnId);
      results.push(await drainCancelledTurn(this.adapter,{...this.cleanupOptions,threadId:run.thread_id,turnId,
        knownItemIds:turnItems.map(item=>item.id),knownItems:turnItems,knownTerminations:[...(run.cleanup_result?.commands??[]),...(run.cleanup_confirmed_terminations??[])],
        onEvent:event=>{
          if(event.action==='termination_result'&&event.terminated===true){
            const current=this.store.get('creator_run',runId),proofs=current.cleanup_confirmed_terminations??[];
            if(!proofs.some(proof=>proof.itemId===event.itemId&&proof.processId===event.processId))proofs.push({itemId:event.itemId,processId:event.processId,terminationConfirmed:true,at:event.at});
            current.cleanup_confirmed_terminations=proofs;this.store.put('creator_run',current);
          }
          return this.service.sessionEvent(run.session_id,{...event,run_id:runId});
        }}));
      }
      const result=results.length===1?results[0]:{status:results.every(result=>result.status==='verified')?'verified':'uncertain',threadId:run.thread_id,turnId:run.turn_id,turns:results,commands:results.flatMap(result=>result.commands),reason:results.find(result=>result.status!=='verified')?.reason??'all_turn_terminals_stopped_and_rechecked'};
      run=this.store.get('creator_run',runId);
      // A command can arrive after a previous helper's quiet window. Do not let
      // that helper overwrite a newer persisted pending generation.
      if(run.cleanup_generation!==generation)continue;
      run.cleanup_status=result.status;run.cleanup_result=result;run.cleanup_error=result.status==='verified'?null:result.reason;run.cleanup_checked_at=Date.now();
      this.store.put('creator_run',run);this.service.sessionEvent(run.session_id,{kind:'run_state',run});this.publicState(run.project_id,run.branch_id);return result;
    }
    throw Error('late_command_cleanup_needs_reconciliation');
  }
  scope(session){return{projectId:session.project_id,branchId:session.branch_id,userId:session.owner_user_id,sessionId:session.id};}
  workspace(session) {
    const path=resolve(this.directory,session.project_id,session.branch_id,session.owner_user_id,session.id);this.environments.session(session,path);projectGameAssetSkill(path);writeWorkspaceFile(path,'inputs/.workspace-inputs','Service-managed inputs. Read current versions using world_read.\n');
    const branch=this.store.branchView({id:session.owner_user_id},session.project_id,session.branch_id);
    const contract=`# World Atelier creator workspace\n\nThis is a real Codex execution workspace, bound to one developer, project and branch. Use the world tools for authoritative shared edits. Normal text editing and optional Godot tests are available. Files alone are not delivery. Never fabricate tool results.\n\n- Read workspace.json, context/current.json when present, WORLD-API.md and inputs/behavior-context.gd before implementing gameplay. This workspace is a game creator environment; parent platform engineering instructions do not govern this project.
- Use workspace_prepare for the canonical fixed Godot game project shared by editor Play, standalone Web and native exports (all scenes, unplaced and nested prefabs, historical instance dependencies and referenced assets). Start through GameRuntime Autoload + standalone.tscn using workspace.json engine.executable with --path; use -- --release-scene=<resource_id> to target a bundled scene or prefab. Never initialize gameplay from the model editor host, and do not bypass the shared startup in a substitute test scene. Use workspace_test for isolated technical smoke checks. Use the prepared editable Godot directory; keep outputs in outputs/. Never construct an unrelated substitute runtime or claim local files have updated the central source.\n- GDScript is trusted project code and follows the provided behavior API. Do not run arbitrary code inside the central Node service.\n- Read current object/version with world_read; immutable conversation attachments retain their captured coordinates.\n- Download or generate assets inside this server workspace; keep binary bytes on disk and use res:// references plus concise metadata in context. Read .agents/skills/game-assets/SKILL.md for asset collection and authoring.\n- Submit source file changes through world_apply; use game_validate (or world_validate, its compatibility name for existing sessions) when a technical check is useful. Editor Play and exports consume that fixed source directly. Use shared_world_validate/world_publish only for an explicitly requested shared authoritative-world task; their authority compatibility result is separate from canonical game validation. Distinguish source persistence, any technical checks you perform, and runtime application. Previous conversation requirements for mandatory checks, an independent verification Agent or waiting for acceptance are retired. Decide which tests are appropriate for the requested work and report their actual results and any untested behavior. Saved source is consumed directly by Play without an additional review gate.\n- Do not edit other developer/session workspaces or server files. Do not expose credentials or private files in world data.\n`;
    const executionGuidance=`\n${GODOT_TEST_GUIDANCE}\n## Local execution\n\n- For actual Godot commands, pass --log-file with an absolute writable path inside this creator session workspace (for example ${resolve(path,'godot-validation.log')}). The default user://logs location may be unwritable in the command sandbox; a failed process is not validation success.\n- Godot geometry, Python/Pillow and background Blender may create or convert assets inside this workspace; summarize outputs without dumping their bytes.\n- Use local test scenes or screenshots when visual checks help the requested work. Clearly report any untested behavior or missing capability. Do not open or operate the shared browser as part of an unrequested extra check.\n`;
    writeWorkspaceFile(path,'AGENTS.md',(branch.manifest.schema==='creation-native-1'?`# World Atelier native creator workspace\n\nThis real persistent session is bound to one developer, project and branch. Read workspace.json godot_project and use that actual Godot project as your working directory. Edit native source and asset files; represent assets as references in model context. Read context/current.json. Files alone are not shared changes; report actual tool receipts and tests. Do not modify fixed inputs, platform files, other sessions or private credentials.\n\n${nativeWorldApiGuide(branch.manifest)}`:contract)+executionGuidance+AGENT_ASSET_GUIDANCE);
    writeWorkspaceFile(path,'WORLD-API.md',creatorWorldApiGuide(branch.manifest)+`\nWorld origin: ${this.service.origin}\n`+executionGuidance+AGENT_ASSET_GUIDANCE);
    writeWorkspaceFile(path,'SEMANTIC-AUTHORING.md',nativeSemanticAuthoringGuide(branch.manifest)||SEMANTIC_AUTHORING_GUIDE);
    this.environments.session(session,path);
    return path;
  }
  async bind(session,{reconcile=false}={}) {
    if(this.bindings.has(session.id))return this.bindings.get(session.id);
    const pending=this.bindOnce(this.store.get('creator_session',session.id),{reconcile}).finally(()=>this.bindings.delete(session.id));
    this.bindings.set(session.id,pending);return pending;
  }
  async bindOnce(session,{reconcile=false}={}) {
    await this.start();const cwd=this.workspace(session),options={cwd,accessMode:session.access_mode??'workspace-write',scope:this.scope(session),dynamicTools:propertyActionTools(CREATION_TOOLS,session),onDynamicTool:request=>this.dynamic(request)};
    if(!session.executor_thread_id) {
      session.model??=this.models.find(m=>m.isDefault)?.model??this.models[0]?.model;
      const response=await this.adapter.createThread({...options,model:session.model});session.executor_thread_id=response.thread.id;this.store.put('creator_session',session);return response;
    }
    const bound=this.adapter.threads.get(session.executor_thread_id);if(bound?.loaded&&!reconcile)return {reconciliation:{canSend:!bound.busy&&!bound.uncertain}};
    const run=this.runForSession(session.id),uncertain=run&&(['uncertain','running','cancelling','starting'].includes(run.status)||run.auto_resume?.status==='pending');
    const response=await this.adapter.resumeThread({...options,threadId:session.executor_thread_id,...(uncertain?{expectedTurnId:run.turn_id||undefined,...(!run.turn_id||!run.turn_ids?.length||run.turn_id===run.turn_ids[0]?{expectedClientUserMessageId:run.client_user_message_id}:{})}:{})});
    if(uncertain&&response.reconciliation?.matchedTurnId){
      // Resume matched the persisted client message ID (and known turn ID when
      // available). This is the second authoritative binding path after RPC.
      const turn=response.thread.turns.find(t=>t.id===response.reconciliation.matchedTurnId);
      if(turn){
        // Resume is another delayed binding path. Preserve any revocation that
        // occurred after this request started, including an unknown-turn cancel.
        let latest=this.store.get('creator_run',run.id);
        latest.turn_id=turn.id;latest.turn_ids=[...new Set([...(latest.turn_ids??[]),turn.id])];if(turn.status==='inProgress'&&!this.cancelled(latest))latest.status='running';this.store.put('creator_run',latest);
        try{this.store.sessionFor({id:session.owner_user_id},session.id,true);}catch{latest=this.cancelRun(run.id,'permission_revoked');}
        if(terminal.has(turn.status))this.finished({threadId:session.executor_thread_id,turn});
        else if(this.cancelled(latest)){void this.queueCleanup(latest.id);void this.adapter.interrupt(latest.thread_id,latest.turn_id).catch(()=>{});}
      }
    }
    for(const turn of response.thread.turns??[]){const owner=this.runForTurn(session.executor_thread_id,turn.id);if(owner)this.restoreAssistantMessages(session,turn,owner);}
    if(run?.execution_mode==='goal'&&this.adapter.getGoal){
      const native=await this.adapter.getGoal(session.executor_thread_id);this.recordExecutorGoal(session,native.goal);
      const latest=this.store.get('creator_run',run.id);
      // Reconciliation never silently starts a new goal. Stop scheduling when
      // the persisted run cannot be safely rebound to an executor turn.
      if(native.goal?.status==='active'&&(this.cancelled(latest)||response.reconciliation?.uncertain||terminal.has(latest.status))){
        const paused=await this.adapter.setGoal(session.executor_thread_id,{status:'paused'});this.recordExecutorGoal(session,paused.goal);
      }
    }
    return response;
  }
  async reconcile(user,sid,{internal=false}={}){
    if(this.sending.has(sid)&&!internal)fail(409,'消息正在提交，请等待实际执行确认后再核对');
    const session=this.store.sessionFor(user,sid,true),result=await this.bind(session,{reconcile:true});
    for(const run of this.cleanupBlocked(sid))await this.queueCleanup(run.id,{reason:'explicit_reconciliation'});
    // Historical question cards are not replyable after their executor
    // connection disappears. Record the live request set without fake replies.
    const requestKeys=[...this.requests].filter(([,request])=>request.session_id===sid&&this.adapter.pendingRequests(session.executor_thread_id).some(item=>item.key===request.requestKey)).map(([key])=>key);
    this.service.sessionEvent(sid,{kind:'requests_reconciled',request_keys:requestKeys});
    const blocked=this.cleanupBlocked(sid),reconciliation={...result.reconciliation,canSend:Boolean(result.reconciliation?.canSend)&&!blocked.length,
      uncertain:Boolean(result.reconciliation?.uncertain)||blocked.length>0,cleanup:blocked.map(run=>({run_id:run.id,status:run.cleanup_status,error:run.cleanup_error}))};
    return{reconciliation,session:this.store.sessionView(user,sid)};
  }
  async validateSettings(model,effort) {
    await this.start();
    const selected=this.models.find(m=>m.model===(model??this.models.find(m=>m.isDefault)?.model??this.models[0]?.model));
    if(!selected)fail(400,'模型不在实际 Codex 目录中');
    if(effort!=null&&!selected.supportedReasoningEfforts?.some(e=>(typeof e==='string'?e:e.reasoningEffort)===effort))fail(400,'此模型不支持所选思考强度');
  }
  async send(user,sid,input,options={}) {
    if(this.sending.has(sid))fail(409,'该会话正在提交一条消息，请等待确认');
    this.sending.add(sid);
    try{return await this.sendOnce(user,sid,input,options);}finally{this.sending.delete(sid);}
  }
  async sendOnce(user,sid,input,{autoResumeFrom=null}={}) {
    let session=this.store.sessionFor(user,sid,true);
    const messageId=identifier(input.client_user_message_id||id('user-message'),'消息 ID');
    let text=String(input.text??session.draft).trim();
    const command=/^\/(plan|goal)(?:\s+|$)/.exec(text),executionMode=input.execution_mode??command?.[1]??'default';
    if(!['default','plan','goal'].includes(executionMode))fail(400,'执行模式无效');
    if(command){if(input.execution_mode&&input.execution_mode!==command[1])fail(400,'命令与执行模式不一致');text=text.slice(command[0].length).trim();}
    const previous=this.store.list('creator_run').find(r=>r.session_id===sid&&r.client_user_message_id===messageId);
    if(text.length>50000||(!text&&!session.draft_attachments?.some(a=>a.kind==='image')&&!previous))fail(400,'请输入创作消息或添加图片');
    const effort=input.effort!==undefined?input.effort:previous?previous.effort??null:session.effort??null;
    const accessMode=input.access_mode!==undefined?input.access_mode:previous?previous.access_mode??'workspace-write':session.access_mode??'workspace-write';
    if(!['workspace-write','full-access'].includes(accessMode))fail(400,'执行权限无效');
    const fingerprint=hash({text,model:input.model??null,...(executionMode!=='default'?{execution_mode:executionMode}:{}),...(accessMode==='full-access'?{access_mode:accessMode}:{}),...(effort!=null?{effort}:{}),...(input.goal_id?{goal_id:input.goal_id,expected_run_id:input.expected_run_id}:{})});
    if(previous){if(previous.input_hash!==fingerprint)fail(409,'同一个消息 ID 不能改写内容');return {run:previous,session:this.store.sessionView(user,sid),replayed:true};}
    if(referenceIds(text).some(id=>!session.draft_attachments?.some(a=>a.id===id)))fail(400,'引用已失效，请重新选择后发送');
    this.assertCleanupReady(sid);
    this.aiLimits.assertStart(user.id);
    this.continueGoal(session,input);
    let current=this.runForSession(sid);
    if(current&&['running','starting','cancelling','uncertain'].includes(current.status)){
      if(current.status==='uncertain')await this.reconcile(user,sid,{internal:true});
      current=this.runForSession(sid);if(!terminal.has(current.status))fail(409,'当前会话仍在执行或等待结果核对，不能重复启动',{run:current});
    }
    await this.bind(session);session=this.store.sessionFor(user,sid,true);
    this.assertCleanupReady(sid);
    await this.validateSettings(input.model??session.model,effort);
    // Re-read after asynchronous catalog access, preserving newly saved drafts.
    session=this.store.sessionFor(user,sid,true);
    if(autoResumeFrom)this.autoResume.assertCurrent(autoResumeFrom);
    if(referenceIds(text).some(id=>!session.draft_attachments?.some(a=>a.id===id)))fail(400,'引用已移除，请重新选择后发送');
    if(!text&&!session.draft_attachments?.some(a=>a.kind==='image'))fail(400,'图片已移除，请重新添加后发送');
    const executionText=expandReferenceText(text,session.draft_attachments??[],{includeIdentity:true})||'请查看所附图片。';
    if(input.model)session.model=input.model;
    session.effort=effort;session.access_mode=accessMode;session.execution_mode=executionMode;
    const continued=this.continueGoal(session,input),attachments=autoResumeFrom?[]:clone(session.draft_attachments),run={id:id('run'),goal_id:continued?.id??id('goal'),session_id:sid,project_id:session.project_id,branch_id:session.branch_id,owner_user_id:user.id,client_user_message_id:messageId,input_hash:fingerprint,status:'starting',lease_generation:1,thread_id:session.executor_thread_id,model:session.model,input_revision:this.store.branchFor(user,session.project_id,session.branch_id).head,targets:attachments.filter(a=>!['prefab','knowledge'].includes(a.kind)&&a.role!=='reference').flatMap(a=>annotationTargets(a,{project_id:session.project_id,branch_id:session.branch_id,resource_id:a.resource_id},targetFromAttachment)),changes:[],verifications:[],deliveries:[],created_at:Date.now()};
    if(autoResumeFrom){run.auto_resume_count=1;run.auto_resume_from=autoResumeFrom;}
    if(session.authoring_action)run.authoring_action=clone(session.authoring_action);
    run.effort=effort;run.access_mode=accessMode;run.execution_mode=executionMode;run.turn_ids=[];run.goal_initializing=executionMode==='goal';if(executionMode==='goal')run.executor_goal_objective=executionText;
    if(continued){const inherited=this.store.get('creator_run',continued.run_id).targets??[],targets=new Map();for(const t of [...inherited,...run.targets])targets.set(JSON.stringify(t.address??[t.resource_id,t.object_id]),clone(t));run.targets=[...targets.values()];run.previous_run_id=continued.run_id;}
    this.store.transaction(()=>{
      this.aiLimits.assertStart(user.id);
      this.continueGoal(session,input);
      if(autoResumeFrom){this.autoResume.assertCurrent(autoResumeFrom);const old=this.store.get('creator_run',autoResumeFrom);old.auto_resume={...old.auto_resume,status:'continued',next_run_id:run.id,updated_at:Date.now()};this.store.put('creator_run',old);}
      this.store.put('creator_run',run);this.store.put('creator_goal',continued?{...continued,run_id:run.id,run_ids:[...new Set([...(continued.run_ids??[]),continued.run_id,run.id])],status:'running',updated_at:Date.now()}:{id:run.goal_id,session_id:sid,run_id:run.id,run_ids:[run.id],objective:executionText,status:'running',created_at:Date.now()});
      this.store.appendMessage(sid,{role:'user',content:text,attachments,execution_mode:executionMode,run_id:run.id,client_user_message_id:messageId,...(autoResumeFrom?{automatic_resume:true}:{})});
      if(!autoResumeFrom){session.draft='';session.draft_attachments=[];}this.store.put('creator_session',session);
    });
    this.service.sessionEvent(sid,{kind:'run_state',run});
    let submitted=false;
    const assertSubmission=status=>{
      this.store.sessionFor(user,sid,true);
      const latest=this.store.get('creator_run',run.id);
      if(this.closing||this.cancelled(latest)||latest.status!==status||latest.lease_generation!==run.lease_generation)fail(409,'消息提交所属执行已取消或发生变化');
      return latest;
    };
    let confirmTurn;const confirmed=new Promise(resolve=>confirmTurn=resolve);this.turnBindings.set(sid,confirmed);
    try{
      // Re-read before promotion: a permission callback may have cancelled the
      // persisted starting run while its initial state was being announced.
      const active=assertSubmission('starting');active.status='running';this.store.put('creator_run',active);this.publicState(run.project_id,run.branch_id);
      const currentCwd=this.workspace(session);
      if(this.store.get('creator_revision',run.input_revision)?.manifest.schema==='creation-native-1'&&this.service.native?.archive?.materialize){
        const project=await this.environments.prepareForRun({session,run,cwd:currentCwd,input:{revision:run.input_revision},guard:()=>assertSubmission('running')});
        const latest=this.store.get('creator_run',run.id);latest.editable_project_directory=project.editable_project_directory;latest.environment_id=project.id;this.store.put('creator_run',latest);
      }
      const context=this.environments.context({session,run,cwd:this.workspace(session),attachments,objective:executionText});
      const images=attachments.some(a=>a.kind==='image')?this.service.sessionImages.materialize(user,sid,attachments,currentCwd):[];
      assertSubmission('running');submitted=true;
      const response=await this.adapter.sendTurn(session.executor_thread_id,{text:executionText+(context.action_prompt??'')+`\n\n[执行环境] 先读 workspace.json 和 ${context.manifest}，固定上下文 SHA-256: ${context.sha256}。需要可运行工程时使用 workspace_prepare；本地检查可按需使用 workspace_test。此前历史上下文中的强制检查、独立验证 Agent 和等待验收要求已取消；由你自行判断是否测试，world_apply 保存的结果直接供试玩使用，不等待额外检查。\n${AGENT_PREFAB_REMINDER}\n${GODOT_TEST_REMINDER}\n${AGENT_ASSET_REMINDER}`,attachments,images,clientUserMessageId:messageId,model:session.model,accessMode,executionMode,goalObjective:executionText,...(effort!=null?{effort}:{})});
      let latest=this.store.get('creator_run',run.id);latest.turn_id=response.turn.id;latest.turn_ids=[response.turn.id];this.store.put('creator_run',latest);
      if(executionMode==='goal'){
        assertSubmission('running');
        // Initial turn is now durably bound. A goal update can schedule its
        // next turn before the activation RPC returns; notifications may bind it.
        latest.goal_activation_requested=latest.executor_goal?.status!=='complete';this.store.put('creator_run',latest);
        const native=latest.goal_activation_requested?await this.adapter.setGoal(session.executor_thread_id,{status:'active'}):{goal:latest.executor_goal};
        latest=this.store.get('creator_run',run.id);latest.goal_initializing=false;this.store.put('creator_run',latest);
        this.recordExecutorGoal(session,native.goal);
      }
      // Revocation can precede the RPC response, when its exact turn is unknown.
      // Keep that durable intent even if access was restored in the meantime.
      try{this.store.sessionFor(user,sid,true);}catch{this.cancelRun(run.id,'permission_revoked');}
      latest=this.store.get('creator_run',run.id);
      if(this.closing||this.cancelled(latest)||executionMode!=='goal'&&(latest.status!=='running'||latest.lease_generation!==run.lease_generation)){
        latest=this.cancelRun(run.id,this.closing?'host_closing':'submission_lease_invalidated');
        void this.queueCleanup(latest.id);
        const observed=this.adapter.turns?.get(`${latest.thread_id}/${latest.turn_id}`)??response.turn;
        if(!terminal.has(observed.status))void this.adapter.interrupt(latest.thread_id,latest.turn_id).catch(()=>{});
      }
      confirmTurn(response.turn.id);
      // RPC response binds the submitted message to its actual turn. Notifications
      // arriving before it are retained, then attributed by that exact turn only.
      for(const row of this.store.db.prepare('SELECT body FROM events WHERE project_id=? ORDER BY sequence').all(`session:${sid}`)){
        const event=JSON.parse(row.body);if(event.params?.threadId===latest.thread_id&&latest.turn_ids?.includes(event.params?.turnId)&&event.method==='item/completed'&&['agentMessage','plan'].includes(event.params.item?.type))this.appendAssistant(session,event.params.item,latest,event.params.turnId);
      }
      const observed=this.adapter.turns?.get(`${latest.thread_id}/${latest.turn_id}`)??(latest.turn_id===response.turn.id?response.turn:null);
      if(terminal.has(observed?.status))this.finished({threadId:latest.thread_id,turn:observed});
      return {run:this.store.get('creator_run',run.id),session:this.store.sessionView(user,sid)};
    }catch(error){
      // turn/start may already have succeeded when goal activation fails. Revoke
      // its lease and stop that exact executor turn instead of leaving it live.
      let failed=this.store.get('creator_run',run.id);
      if(executionMode==='goal'&&failed.turn_id&&!terminal.has(failed.status)){
        failed=this.cancelRun(run.id,'goal_activation_failed');
        try{await this.pauseRunGoal(run.id);}catch(pauseError){failed=this.store.get('creator_run',run.id);failed.cleanup_error=pauseError.message;this.store.put('creator_run',failed);}
        try{await this.adapter.interrupt(failed.thread_id,failed.turn_id);}catch{}
        void this.queueCleanup(run.id);
      }
      try{this.store.sessionFor(user,sid,true);}catch{this.cancelRun(run.id,'permission_revoked');}
      const latest=this.store.get('creator_run',run.id);
      if(this.cancelled(latest)){
        if(!submitted){
          // Local proof only: no turn/start was invoked, so no executor turn or
          // command needs an invented terminal event to close this cancellation.
          latest.status='interrupted';latest.completed_at=Date.now();latest.cleanup_status='verified';latest.cleanup_error=null;latest.cleanup_checked_at=Date.now();latest.cleanup_result={status:'verified',reason:'turn_not_submitted',commands:[]};
          const goal=this.store.list('creator_goal').find(g=>g.run_id===run.id);if(goal){goal.status='cancelled';this.store.put('creator_goal',goal);}
        }else if(!latest.turn_id){latest.cleanup_status='uncertain';latest.cleanup_error='cancelled_turn_id_unconfirmed';}
        this.store.put('creator_run',latest);this.service.sessionEvent(sid,{kind:'run_state',run:latest});this.publicState(run.project_id,run.branch_id);
      }else if(!terminal.has(latest.status)){latest.status=error.uncertain?'uncertain':'failed';latest.error=error.message;latest.lease_generation++;this.store.put('creator_run',latest);this.service.sessionEvent(sid,{kind:'run_state',run:latest});this.publicState(run.project_id,run.branch_id);}throw error;
    }finally{confirmTurn(null);if(this.turnBindings.get(sid)===confirmed)this.turnBindings.delete(sid);}
  }
  appendAssistant(session,item,run,turnId=run?.turn_id){if(run&&!this.store.list('creator_message').some(m=>m.session_id===session.id&&m.executor_item_id===item.id&&(!m.executor_turn_id||m.executor_turn_id===turnId)))this.store.appendMessage(session.id,{role:'assistant',content:item.text||'',run_id:run.id,executor_item_id:item.id,executor_turn_id:turnId,...(item.type==='plan'?{content_type:'plan'}:{})});}
  restoreAssistantMessages(session,turn,run){
    // App Server history can rename live msg_* IDs to item-N. Match each
    // occurrence within its exact turn, preserving identical text in other
    // turns and repeated messages within this one.
    const eventTurns=new Map();
    for(const row of this.store.db.prepare('SELECT body FROM events WHERE project_id=? ORDER BY sequence').all(`session:${session.id}`)){
      const event=JSON.parse(row.body),p=event.params;if(p?.threadId===run.thread_id&&p?.item?.id&&p.turnId)eventTurns.set(p.item.id,p.turnId);
    }
    const messages=this.store.list('creator_message').filter(m=>m.session_id===session.id&&m.run_id===run.id&&m.role==='assistant');
    const remaining=messages.filter(m=>(m.executor_turn_id??eventTurns.get(m.executor_item_id)??((run.turn_ids?.length??0)<=1?run.turn_id:null))===turn.id);
    for(const item of turn.items??[])if(['agentMessage','plan'].includes(item.type)){
      const content=item.text||'',type=item.type==='plan'?'plan':'agentMessage';
      const index=remaining.findIndex(m=>(m.content_type??'agentMessage')===type&&m.content===content);
      if(index>=0){remaining.splice(index,1);continue;}
      this.appendAssistant(session,item,run,turn.id);
    }
  }
  event(event) {
    // Connection diagnostics have no threadId. Keep bounded server-only metadata
    // instead of silently discarding the reason every active session stopped.
    if(['transportStarted','protocolError','disconnected'].includes(event.kind)){
      this.store.put('creator_executor_diagnostic',{id:event.epoch??'unknown',updated_at:Date.now(),event:{kind:event.kind,sequence:event.sequence,pid:event.pid,code:event.code,signal:event.signal,message:String(event.message??'').slice(0,2000),cause:event.cause??null,observed_bytes:event.observed_bytes,max_bytes:event.max_bytes}});
    }
    if(event.kind==='notification'&&event.method==='serverRequest/resolved'){
      const key=`${event.epoch}:${String(event.params?.requestId)}`,request=this.requests.get(key);
      if(request?.params?.threadId===event.params?.threadId)this.requests.delete(key);
    }
    if(event.kind==='notification'&&['thread/closed','thread/deleted'].includes(event.method)){
      for(const [key,request] of this.requests)if(request.params?.threadId===event.params?.threadId)this.requests.delete(key);
    }
    const threadId=event.threadId??event.params?.threadId,session=threadId?this.sessionForThread(threadId):event.scope?.sessionId&&this.store.get('creator_session',event.scope.sessionId);
    if(!session)return;
    if(event.kind==='notification'&&['serverRequest/resolved','thread/closed','thread/deleted'].includes(event.method))this.updateAwaitingUser(session);
    this.service.sessionEvent(session.id,event);
    if(event.kind==='notification'&&event.method==='thread/tokenUsage/updated'){this.aiLimits.record(session,event.params);this.enforceAiLimits();}
    if(event.kind==='notification'&&event.method==='thread/goal/updated')this.recordExecutorGoal(session,event.params.goal);
    if(event.kind==='notification'&&event.method==='turn/started'){
      const run=this.runForSession(session.id),turn=event.params.turn;
      if(run?.ai_limit_reason&&run.execution_mode==='goal'&&turn?.id){
        run.turn_ids=[...new Set([...(run.turn_ids??[]),run.turn_id,turn.id].filter(Boolean))];run.turn_id=turn.id;run.goal_pause_confirmed=false;this.store.put('creator_run',run);
        void this.queueCleanup(run.id,{reset:true,reason:'ai_limit_late_turn'});
        void this.pauseRunGoal(run.id).catch(()=>{}).then(()=>this.adapter.interrupt(threadId,turn.id)).catch(()=>{});
        return;
      }
      if(run?.execution_mode==='goal'&&run.status==='running'&&!this.cancelled(run)&&(run.goal_activation_requested||run.executor_goal?.status==='active')&&run.turn_id&&turn?.id&&run.turn_id!==turn.id&&!run.turn_ids?.includes(turn.id)){
        run.turn_ids=[...new Set([...(run.turn_ids??[]),run.turn_id,turn.id].filter(Boolean))];run.turn_id=turn.id;run.last_turn_status=null;run.lease_generation++;this.store.put('creator_run',run);
        this.service.sessionEvent(session.id,{kind:'run_state',run});
      }
    }
    if(event.kind==='notification'&&['serverRequest/resolved','thread/closed','thread/deleted'].includes(event.method)&&session.project_id)this.publicState(session.project_id,session.branch_id);
    if(event.kind==='notification'&&['item/started','item/completed'].includes(event.method)&&event.params.item?.type==='commandExecution'){
      const run=this.runForTurn(threadId,event.params.turnId);
      if(run){
        const item=event.params.item,items=new Map((run.command_items??[]).map(i=>[i.id,i])),old=items.get(item.id);
        if(!old||event.method==='item/completed'||old.status==='inProgress')items.set(item.id,{...clone(item),turn_id:event.params.turnId});
        run.command_items=[...items.values()];this.store.put('creator_run',run);
        if(this.cancelled(run)&&((event.method==='item/started'&&(!old||old.processId!==item.processId))||event.method==='item/completed'&&run.cleanup_status==='uncertain')){
          void this.queueCleanup(run.id,{reset:true,reason:'late_cancelled_turn_command'});
        }
      }
    }
    if(event.kind==='notification'&&event.method==='item/completed'&&['agentMessage','plan'].includes(event.params.item?.type)) {
      this.appendAssistant(session,event.params.item,this.runForTurn(threadId,event.params.turnId),event.params.turnId);
    }
  }
  request(event) {
    const session=this.sessionForThread(event.params?.threadId);if(!session)return;
    if(event.params?.turnId&&this.store.list('creator_run').some(run=>run.thread_id===event.params.threadId&&run.turn_id===event.params.turnId&&terminal.has(run.status)))return;
    this.requests.set(event.requestKey,{...event,session_id:session.id});
    this.updateAwaitingUser(session);
    this.service.sessionEvent(session.id,{kind:'approval_request',request_key:event.requestKey,category:event.category,method:event.method,params:event.params,
      ...(event.method==='mcpServer/elicitation/request'?{elicitation:describeElicitation(event.params)}:{})});
    if(session.project_id)this.publicState(session.project_id,session.branch_id);
  }
  async reply(user,sid,key,input) {
    const session=this.store.sessionFor(user,sid,true),request=this.requests.get(key);
    if(!request||request.session_id!==sid)fail(409,'审批或输入请求已失效');
    const bound=this.adapter.threads.get(request.params?.threadId),pending=this.adapter.pendingRequests(request.params?.threadId).some(item=>item.key===key);
    if(session.executor_thread_id!==request.params?.threadId||!bound?.loaded||!pending){this.requests.delete(key);fail(409,'审批或输入请求已失效，请读取当前会话状态');}
    const run=this.runForSession(sid);
    if(request.method==='item/tool/requestUserInput'&&(!run||!['starting','running'].includes(run.status)||run.thread_id!==request.params?.threadId||(!request.params?.turnId||run.turn_id!==request.params.turnId))){this.requests.delete(key);fail(409,'此问题所属运行已结束或发生变化');}
    if(run?.ai_limit_reason)fail(429,run.ai_limit_reason);
    let result=input.result;
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','execCommandApproval','applyPatchApproval'].includes(request.method)){
      if(!result||Object.keys(result).length!==1||!['accept','acceptForSession','decline','cancel'].includes(result.decision))fail(400,'审批响应无效');
    }else if(request.method==='item/tool/requestUserInput') {
      const questions=request.params.questions??[];
      if(!questions.length||!result||Object.keys(result).length!==1||!result.answers||Array.isArray(result.answers)||Object.keys(result.answers).length!==questions.length||questions.some(q=>!Object.hasOwn(result.answers,q.id)||!Array.isArray(result.answers[q.id]?.answers)||!result.answers[q.id].answers.length||!result.answers[q.id].answers.every(a=>typeof a==='string'&&a.trim().length>0&&a.length<=10000)))fail(400,'请提供所有问题的真实答案');
    }else if(request.method==='mcpServer/elicitation/request')result=validateElicitationResult(request.params,result);
    else fail(422,'此类审批尚无专用交互，请保留等待或中断任务');
    this.adapter.replyRequest(key,result);this.requests.delete(key);this.updateAwaitingUser(session);this.service.observe?.(()=>this.service.notices?.requestClosed(sid,key));if(session.project_id)this.publicState(session.project_id,session.branch_id);return{ok:true};
  }
  updateAwaitingUser(session) {
    const run=this.runForSession(session.id);if(!run)return;
    run.awaiting_user=[...this.requests.values()].some(request=>request.session_id===session.id);this.store.put('creator_run',run);
    if(run.awaiting_user&&run.auto_resume?.status==='pending')this.autoResume.cancel(run.id,'waiting_for_user');
  }
  async interrupt(user,sid) {
    const session=this.store.sessionFor(user,sid,true),run=this.runForSession(sid);
    if(!run)return{run};
    this.autoResume.cancel(run.id,'user_cancel');
    if(terminal.has(run.status)){
      if(this.cancelled(run)&&run.cleanup_status!=='verified'){
        await this.bind(session,{reconcile:true});void this.queueCleanup(run.id,{reason:'repeated_cancel_cleanup'});
      }
      return{run:this.store.get('creator_run',run.id)};
    }
    if(!this.adapter.connected||!this.adapter.threads.get(session.executor_thread_id)?.loaded)await this.bind(session,{reconcile:true});
    if(!run.turn_id){await this.reconcile(user,sid);if(!this.runForSession(sid).turn_id)fail(409,'尚未确认执行轮次，不能猜测中断对象');}
    const current=this.runForSession(sid);if(terminal.has(current.status))return{run:current};
    current.status='cancelling';this.store.put('creator_run',current);this.markCleanup(current.id,'user_cancel');
    await this.pauseRunGoal(current.id);
    void this.queueCleanup(current.id);
    try{await this.adapter.interrupt(session.executor_thread_id,current.turn_id);}catch(error){
      const latest=this.store.get('creator_run',current.id);if(!terminal.has(latest.status)){latest.status='uncertain';latest.error=error.message;this.store.put('creator_run',latest);this.service.sessionEvent(sid,{kind:'run_state',run:latest});}
    }
    return{run:this.store.get('creator_run',current.id)};
  }
  finished({threadId,turn}) {
    // An MCP elicitation may have turnId=null. Only actual resolved or thread
    // unbinding can close such requests; never assign them to the latest turn.
    for(const [key,request] of this.requests)if(request.params?.threadId===threadId&&request.params?.turnId===turn.id)this.requests.delete(key);
    const session=this.sessionForThread(threadId);if(!session)return;
    const run=this.runForTurn(threadId,turn.id);if(!run)return;
    if(run.turn_id!==turn.id)return; // An earlier goal turn cannot finish its successor.
    if(run.execution_mode==='goal'&&turn.status==='completed'&&!this.cancelled(run)){
      run.last_turn_status=turn.status;this.store.put('creator_run',run);
      if(run.goal_initializing||run.executor_goal?.status==='active'){
        if(!run.goal_initializing)void this.adapter.getGoal(threadId).then(result=>this.recordExecutorGoal(session,result.goal)).catch(error=>{
          const latest=this.store.get('creator_run',run.id);if(latest?.status==='running'&&latest.turn_id===turn.id){latest.status='uncertain';latest.error=error.message;this.store.put('creator_run',latest);this.service.sessionEvent(session.id,{kind:'run_state',run:latest});}
        });
        return;
      }
    }
    this.completeRun(session,run,turn);
  }
  recordExecutorGoal(session,goal){
    if(!goal)return;
    if(goal.threadId&&goal.threadId!==session.executor_thread_id)return;
    const run=this.runForSession(session.id);
    if(run?.execution_mode==='goal'&&run.executor_goal_objective&&goal.objective!==run.executor_goal_objective)return;
    // RPC reads can settle after a newer terminal notification. A single run
    // never reactivates a goal that the executor has already stopped.
    if(run?.goal_terminal_observed&&goal.status==='active')return;
    const fresh=this.store.get('creator_session',session.id);fresh.executor_goal=clone(goal);this.store.put('creator_session',fresh);
    if(!run||run.execution_mode!=='goal')return;
    if(goal.status==='active')run.goal_activation_confirmed=true;
    if(goal.status==='active')run.goal_pause_confirmed=false;
    else if(run.goal_activation_confirmed||goal.status==='complete')run.goal_terminal_observed=true;
    run.executor_goal=clone(goal);this.store.put('creator_run',run);
    this.service.sessionEvent(session.id,{kind:'executor_goal',goal,run_id:run.id});
    if(!run.goal_initializing&&run.last_turn_status==='completed'&&['running','uncertain'].includes(run.status)&&!this.cancelled(run)&&goal.status!=='active')this.completeRun(fresh,run,{id:run.turn_id,status:'completed'});
  }
  completeRun(session,run,turn){
    if(terminal.has(run.status))return;
    run.turn_id=turn.id;run.status=turn.status;run.error=turn.error??null;run.completed_at=Date.now();run.lease_generation++;
    if(this.cancelled(run)){
      run.cancel_requested_at??=Date.now();run.cleanup_status??='pending';run.cleanup_generation??=1;
      const items=new Map((run.command_items??[]).map(item=>[item.id,item]));
      for(const item of turn.items??[])if(item.type==='commandExecution')items.set(item.id,{...clone(item),turn_id:turn.id});
      run.command_items=[...items.values()];
    }
    this.store.put('creator_run',run);
    const goal=this.store.list('creator_goal').find(g=>g.run_id===run.id);if(goal){goal.status=turn.status==='completed'?(run.execution_mode==='plan'?'planned':run.executor_goal&&run.executor_goal.status!=='complete'?run.executor_goal.status:'completed'):turn.status==='interrupted'?'cancelled':'failed';this.store.put('creator_goal',goal);}
    this.service.sessionEvent(session.id,{kind:'run_state',run});this.publicState(run.project_id,run.branch_id);
    if(this.cancelled(run)&&run.cleanup_status!=='verified')void this.queueCleanup(run.id,{reason:'interrupted_turn_terminal'});
  }
  assertRun(request) {
    if(request.signal.aborted)fail(409,'工具所属执行已结束');
    const session=this.store.get('creator_session',request.scope.sessionId),user=this.store.publicUser(this.store.get('creator_user',request.scope.userId));
    this.store.sessionFor(user,session.id,true);const run=this.runForTurn(session.executor_thread_id,request.turnId);
    this.assertCleanupReady(session.id);
    if(!run||run.status!=='running'||run.turn_id!==request.turnId)fail(409,'Agent 写入租约已失效');
    return {session,user,run};
  }
  async dynamic(request) {
    if(!this.runForTurn(request.threadId,request.turnId)&&this.turnBindings.has(request.scope.sessionId))await this.turnBindings.get(request.scope.sessionId);
    const {session,user,run}=this.assertRun(request),args=request.arguments??{},p=session.project_id,b=session.branch_id;
    if(run.execution_mode==='plan'&&!['world_read','world_hierarchy_preview','knowledge_search','knowledge_read','semantic_read','authoring_context','asset_catalog','asset_search','asset_detail'].includes(request.tool))fail(403,'当前为规划模式，只允许读取游戏资料；开始实施后才能修改或构建。');
    const receiptId=`${run.id}:${request.callId}`,old=this.store.get('creator_tool_receipt',receiptId);
    if(old){
      // Old receipts may predate the wire budget; replay their result, never effects.
      if(old.result.success&&old.result.contentItems?.length===1&&old.result.contentItems[0].type==='inputText')return replayAgentToolResult({cwd:request.cwd,value:JSON.parse(old.result.contentItems[0].text)});
      return old.result;
    }
    if(request.tool==='world_apply'){
      const branch=this.store.branchView(user,p,b);
      assertAgentSourceOperations(args.ops,{sourceFiles:branch.manifest.source_files,readOriginal:entry=>this.service.native.archive.read(entry)});
    }
    let value;
    if(request.tool==='authoring_context')value=propertyActionContext(this.service,session,run,args);
    else if(request.tool==='properties_expose'){
      value=await exposeActionProperties(this.service,user,session,run,args);
      if(value.revision){const latest=this.store.get('creator_run',run.id);if(!latest.changes.includes(value.revision))latest.changes.push(value.revision);this.store.put('creator_run',latest);this.publicState(p,b);}
    }
    else if(request.tool==='semantic_read')value=this.service.semantic.resources(user,p,b,args);
    else if(request.tool==='knowledge_search'||request.tool==='knowledge_read')value=this.service.semantic.knowledge(user,p,b,args);
    else if(request.tool==='semantic_apply'||request.tool==='knowledge_write'){
      const origin={run_id:run.id,lease_generation:run.lease_generation,session_id:session.id};
      value=await this.service.semantic[request.tool==='semantic_apply'?'updateResource':'updateKnowledge'](user,p,b,args,origin);
      const latest=this.store.get('creator_run',run.id);if(!latest.changes.includes(value.revision))latest.changes.push(value.revision);
      const grouped=new Map();
      for(const op of value.committed_ops){
        if(['put_knowledge','delete_knowledge'].includes(op.type))continue;
        const group=grouped.get(op.resource_id)??[];group.push(op);grouped.set(op.resource_id,group);
      }
      const native=value.branch.manifest.schema==='creation-native-1';
      const added=native?nativeTargetsForOperations(value.branch.manifest,{project_id:p,branch_id:b},value.committed_ops,value.revision,{changed_resources:value.changed_resources}):[...grouped].flatMap(([resource_id,ops])=>targetsForOperations(value.branch.manifest,{project_id:p,branch_id:b,resource_id},ops,value.revision));
      const targets=new Map((latest.targets??[]).map(t=>[creatorTargetKey(t.address??{project_id:p,branch_id:b,resource_id:t.resource_id,instance_path:[],definition_node_id:t.object_id}),t]));
      for(const target of added)targets.set(creatorTargetKey(target.address),target);latest.targets=[...targets.values()];
      this.store.put('creator_run',latest);this.publicState(p,b);
    }
    else if(request.tool==='world_read') {
      const branch=this.store.branchView(user,p,b),assets=[];
      if(branch.manifest.schema==='creation-native-1'){
        const source=readNativeAgentSource({service:this.service,user,project_id:p,branch_id:b,input:args});
        const fixed=args.revision?this.store.get('creator_revision',source.revision).manifest:branch.manifest;
        const resourceId=args.resource_id??fixed.entry_scene_id;if(!fixed.resources[resourceId])fail(404,'资源不存在');
        writeWorkspaceFile(request.cwd,'WORLD-API.md',creatorWorldApiGuide(fixed)+`\nWorld origin: ${this.service.origin}\n`);
        writeWorkspaceFile(request.cwd,'SEMANTIC-AUTHORING.md',nativeSemanticAuthoringGuide(fixed));
        writeWorkspaceFile(request.cwd,'inputs/native-source-index.json',JSON.stringify({revision:source.revision,source_identity:fixed.source_identity,source_files:fixed.source_files},null,2));
        const environment=this.environments.session(session,request.cwd);
        if(args.source_path){
          const {manifest,...metadata}=branch;
          value={...metadata,head:source.revision,source_identity:fixed.source_identity,projection:'native-source-file',environment,source,source_index:resolve(request.cwd,'inputs/native-source-index.json'),documentation:resolve(request.cwd,'WORLD-API.md'),usage:'当前仅返回所请求文件。需要对象与属性版本时使用 world_read resource_id（不传 source_path）；完整可运行工程使用 workspace_prepare。'};
        }else{
          const {manifest,...metadata}=branch;
          value={...metadata,head:source.revision,source_identity:fixed.source_identity,projection:'native-resource',environment,source,
            source_index:resolve(request.cwd,'inputs/native-source-index.json'),documentation:resolve(request.cwd,'WORLD-API.md'),
            resources:Object.values(fixed.resources).map(({id,kind,name,path,version})=>({id,kind,name,path,version})),
            resource:fixed.resources[resourceId],resolved_resource:{revision:source.revision,resource_id:resourceId},
            usage:'当前只返回所选资源的节点和版本，resources 为完整场景与预制件目录。使用 world_read resource_id 读取其他资源，source_path 读取源文件；workspace_prepare 取得完整可运行工程。'};
        }
      }else{
      for(const asset of this.store.list('creator_asset').filter(a=>a.builtin||a.project_ids?.includes(p))) {
        assets.push({id:asset.id,name:asset.name,url:`/preview-assets/${asset.id}.${asset.ext}`,resource_path:`res://assets/${asset.id}.${asset.ext}`,ext:asset.ext,read_only:true});
      }
      for(const file of ['behavior_context.gd','behavior_registry.gd']){const source=resolve(this.service.root,'runtimes/model-preview',file);if(existsSync(source))writeWorkspaceFile(request.cwd,'inputs/'+file.replaceAll('_','-'),readFileSync(source));}
      const behaviorDoc=resolve(this.service.root,'runtimes/model-preview/PLAY-BEHAVIORS.md');if(existsSync(behaviorDoc))writeWorkspaceFile(request.cwd,'inputs/PLAY-BEHAVIORS.md',readFileSync(behaviorDoc));
      writeWorkspaceFile(request.cwd,'WORLD-API.md',creatorWorldApiGuide(branch.manifest)+`\nWorld origin: ${this.service.origin}\n`);
      writeWorkspaceFile(request.cwd,'inputs/design-knowledge-index.json',JSON.stringify(designKnowledgeIndex(branch.manifest,{project_id:p,branch_id:b,revision:branch.head}),null,2));
      const resourceId=args.resource_id??branch.manifest.entry_scene_id;
      if(!branch.manifest.resources[resourceId])fail(404,'资源不存在');
      const resolved=branch.manifest.schema===HIERARCHY_SCHEMA?resolveScene(branch.manifest,resourceId,{project_id:p,branch_id:b}):null;
      const environment=this.environments.session(session,request.cwd);
      value={...branch,environment,design_knowledge_index:resolve(request.cwd,'inputs/design-knowledge-index.json'),semantic_guide:resolve(request.cwd,'SEMANTIC-AUTHORING.md'),...(resolved?{resolved_resource:{revision:branch.head,resource_id:resourceId,rows:resolved}}:{}),assets,behavior_api_file:resolve(request.cwd,'inputs/behavior-context.gd'),behavior_guide:resolve(request.cwd,'inputs/PLAY-BEHAVIORS.md'),documentation:resolve(request.cwd,'WORLD-API.md'),...(args.resource_id?{resource:branch.manifest.resources[args.resource_id]}:{})};
      }
    }else if(request.tool==='asset_catalog')value=this.service.market.catalog();
    else if(request.tool==='asset_search')value=this.service.market.list(args);
    else if(request.tool==='asset_detail')value=this.service.market.detail(args.asset_id,args.version);
    else if(request.tool==='asset_import'){
      this.assertRun(request);const imported=await this.service.market.importToProject(user,p,b,args,{run_id:run.id,lease_generation:run.lease_generation,session_id:session.id});
      const latest=this.store.get('creator_run',run.id);if(!latest.changes.includes(imported.result.revision))latest.changes.push(imported.result.revision);this.store.put('creator_run',latest);this.publicState(p,b);
      value={import:imported.import,revision:imported.result.revision,changed_files:imported.result.changed_files,replayed:imported.result.replayed??false,next:'Read current source and reconcile the editable workspace. Instance the returned prefab in the intended scene; configure movement, camera and collision for this game. Preserve unsubmitted work.'};
    }else if(request.tool==='workspace_prepare'||request.tool==='workspace_test')value=await this.environments[request.tool==='workspace_prepare'?'prepare':'test']({session,run,cwd:request.cwd,input:args,guard:()=>this.assertRun(request),signal:request.signal});
    else if(request.tool==='world_hierarchy_preview')value=hierarchyPreview(this.store,user,p,b,args);
    else if(request.tool==='asset_publish'){
      if(typeof args.path!=='string')fail(422,'asset_publish 需要本会话内 GLB 或 GDScript 文件路径；其他资产使用 submit_native_workspace');
      // The asset service performs the workspace realpath/symlink/size checks.
      value=this.service.assets.publishFile(user,p,request.cwd,args.path);
    }
    else if(request.tool==='world_apply') {
      const before=this.store.branchView(user,p,b);
      if(before.manifest.schema==='creation-native-1'||args.ops?.some(op=>['migrate_native','import_native_project'].includes(op.type))){
        const applied=await commitNativeWorkspaceApply({service:this.service,user,session,run,cwd:request.cwd,input:args,guard:()=>this.assertRun(request),signal:request.signal});
        value={...applied.result,...(applied.workspace_submission?{workspace_submission:applied.workspace_submission}:{})};
        const latest=this.store.get('creator_run',run.id);if(!latest.changes.includes(value.revision))latest.changes.push(value.revision);
        const targets=nativeTargetsForOperations(before.manifest,{project_id:p,branch_id:b},applied.expanded_input.ops,before.head,{changed_resources:value.changed_resources}).concat(nativeTargetsForOperations(value.branch.manifest,{project_id:p,branch_id:b},applied.expanded_input.ops,value.revision,{changed_resources:value.changed_resources}));
        const byAddress=new Map((latest.targets??[]).map(target=>[creatorTargetKey(target.address??{project_id:p,branch_id:b,resource_id:target.resource_id,instance_path:[],definition_node_id:target.object_id}),target]));
        for(const target of targets)byAddress.set(creatorTargetKey(target.address),target);latest.targets=[...byAddress.values()];
        this.store.put('creator_run',latest);this.publicState(p,b);
      }else{
      // Derive all affected addresses before mutation so an unsupported operation
      // cannot leave source saved but its tool result rejected afterwards.
      const collect=(manifest,revision)=>{
        const grouped=new Map();
        for(const op of args.ops??[]){if(['put_knowledge','delete_knowledge'].includes(op.type))continue;const resources=op.type==='migrate_hierarchy'?Object.keys(manifest.resources):[op.resource_id];for(const r of resources){const group=grouped.get(r)??[];group.push(op);grouped.set(r,group);}}
        return [...grouped].flatMap(([r,ops])=>targetsForOperations(manifest,{project_id:p,branch_id:b,resource_id:r},ops,revision));
      };
      const beforeTargets=collect(before.manifest,before.head);
      value=await this.service.committed(user,p,b,args,{run_id:run.id,lease_generation:run.lease_generation,session_id:session.id});
      const afterTargets=collect(value.branch.manifest,value.revision),latest=this.store.get('creator_run',run.id);
      if(!latest.changes.includes(value.revision))latest.changes.push(value.revision);
      const byAddress=new Map((latest.targets??[]).map(t=>[scopedAddressKey(t.address??{project_id:p,branch_id:b,resource_id:t.resource_id,instance_path:[],definition_node_id:t.object_id}),t]));
      for(const target of [...beforeTargets,...afterTargets])if(!byAddress.has(scopedAddressKey(target.address)))byAddress.set(scopedAddressKey(target.address),target);
      latest.targets=[...byAddress.values()];
      this.store.put('creator_run',latest);this.publicState(p,b);
      }
    } else if(['game_validate','world_validate','shared_world_validate','world_publish'].includes(request.tool)) {
      const canonical=['game_validate','world_validate'].includes(request.tool),executor=canonical?this.service.validator:this.service.worlds;
      if(!executor)fail(503,canonical?'统一游戏验证器尚未就绪':'Godot 世界执行器尚未就绪');
      this.service.sessionEvent(session.id,{kind:'verification_started',run_id:run.id,resource_id:args.resource_id,revision:args.revision});
      value=await executor[request.tool==='world_publish'?'publish':'validate'](user,p,b,{...args,origin:{run_id:run.id,session_id:session.id},guard:()=>this.assertRun(request),signal:request.signal});
      const latest=this.store.get('creator_run',run.id);
      if(request.tool!=='world_publish'){if(!latest.verifications.includes(value.id))latest.verifications.push(value.id);}else{if(!latest.verifications.includes(value.verification.id))latest.verifications.push(value.verification.id);if(!latest.deliveries.includes(value.delivery.id))latest.deliveries.push(value.delivery.id??value.delivery);}
      this.store.put('creator_run',latest);this.publicState(p,b);
    }else fail(400,'未声明的创作工具');
    const result=encodeAgentToolResult({cwd:request.cwd,value});
    this.store.put('creator_tool_receipt',{id:receiptId,result});return result;
  }
  publicState(p,b) {
    try{return this.projectDevelopment(p,b);}catch(error){
      // An auxiliary status failure must never turn an already committed edit,
      // verified runtime receipt or live authority into a false failure.
      this.service.realtime.developmentFailed?.(p,b);this.lastProjectionError={project_id:p,branch_id:b,message:error.message,at:Date.now()};return [];
    }
  }
  projectDevelopment(p,b) {
    const runs=this.store.list('creator_run').filter(r=>r.project_id===p&&r.branch_id===b).sort((a,b)=>b.created_at-a.created_at),seen=new Set(),states=[];
    if(!runs.some(run=>(this.cancelled(run)&&run.cleanup_status!=='verified'||['starting','running','cancelling','uncertain'].includes(run.status))&&(run.targets??[]).length)){this.service.realtime.development(p,b,states);return states;}
    const branch=this.store.get('creator_branch',`${p}:${b}`),manifest=branch&&this.store.readRevision(branch.head)?.manifest;
    if(!manifest)return states;
    this.publicTargetResolvers??=new Map();
    const resolveFixed=(revision,scope,target)=>{
      const cacheKey=JSON.stringify([p,b,scope.resource_id,revision]);
      if(!this.publicTargetResolvers.has(cacheKey)){
        const fixed=this.store.readRevision(revision)?.manifest;if(!fixed)return null;
        if(fixed.schema==='creation-native-1'){
          const objects=new Map(nativeObjectViews(fixed,scope.resource_id,scope).map(object=>[nativeAddressKey(object.address),object]));
          this.publicTargetResolvers.set(cacheKey,target=>{const object=objects.get(nativeAddressKey(target.address??target));return object?{runtimeId:object.id,address:object.address,contentFingerprint:object.version}:null;});
        }else this.publicTargetResolvers.set(cacheKey,publicTargetResolver(fixed,scope));
        while(this.publicTargetResolvers.size>12)this.publicTargetResolvers.delete(this.publicTargetResolvers.keys().next().value);
      }
      return this.publicTargetResolvers.get(cacheKey)(target);
    };
    for(const run of runs){
      const cleanupActive=this.cancelled(run)&&run.cleanup_status!=='verified';
      if(!cleanupActive&&!['starting','running','cancelling','uncertain'].includes(run.status))continue;
      for(const target of run.targets??[]){
        const scope={project_id:p,branch_id:b,resource_id:target.resource_id};
        const actor=this.store.publicUser(this.store.get('creator_user',run.owner_user_id)),execution=this.pendingForRun(run)?'waiting_input':run.status;
        const label=cleanupActive?(run.cleanup_status==='uncertain'?'命令清理待核对':'等待命令停止'):execution==='waiting_input'?'Agent 需要决定':run.status==='uncertain'?'执行结果待核对':run.status==='cancelling'?'等待中断确认':'Agent 正在开发';
        if(target.annotation_id){
          if(manifest.resources[target.resource_id])states.push({...target,project_id:p,branch_id:b,id:target.object_id,run_id:run.id,actor,execution,status:'editing',label});
          continue;
        }
        const current=resolveFixed(branch.head,scope,target);if(!current)continue;
        const key=`${run.id}/${creatorTargetKey(current.address)}`;if(seen.has(key))continue;
        seen.add(key);
        states.push({...target,run_id:run.id,address:current.address,id:current.runtimeId,actor,execution,status:'editing',label});
      }
    }
    this.service.realtime.development(p,b,states);return states;
  }
  cancelRun(runId,reason) {
    this.autoResume.cancel(runId,reason);
    const run=this.store.get('creator_run',runId);
    if(!this.cancelled(run)){
      if(!terminal.has(run.status))run.status='cancelling';
      this.store.put('creator_run',run);return this.markCleanup(run.id,reason);
    }
    return run;
  }
  pauseRunGoal(runId){
    const run=this.store.get('creator_run',runId);
    if(run?.execution_mode!=='goal')return Promise.resolve(null);
    if(run.goal_pause_confirmed&&run.executor_goal?.status!=='active')return Promise.resolve(null);
    if(this.goalPauses.has(runId))return this.goalPauses.get(runId);
    const pending=(async()=>{
      if(!this.adapter.connected)throw Error('goal_pause_executor_disconnected');
      const result=await this.adapter.setGoal(run.thread_id,{status:'paused'});
      if(result.goal?.status==='active')throw Error('goal_pause_unconfirmed');
      const session=this.store.get('creator_session',run.session_id);this.recordExecutorGoal(session,result.goal);
      const latest=this.store.get('creator_run',runId);latest.goal_pause_confirmed=true;this.store.put('creator_run',latest);
      return result;
    })().finally(()=>this.goalPauses.delete(runId));
    this.goalPauses.set(runId,pending);return pending;
  }
  permissionsChanged(p) {
    for(const run of this.store.list('creator_run').filter(r=>r.project_id===p&&(['starting','running','uncertain'].includes(r.status)||r.auto_resume?.status==='pending'))){
      try{this.store.projectFor({id:run.owner_user_id},p,true);}catch{const current=this.cancelRun(run.id,'permission_revoked');if(current.turn_id){void this.queueCleanup(current.id);void this.pauseRunGoal(current.id).catch(()=>{}).then(()=>this.adapter.interrupt(current.thread_id,current.turn_id)).catch(()=>{});}}
    }
  }
  enforceAiLimits(){
    if(this.closing)return;
    for(const run of this.store.list('creator_run').filter(aiActive)){
      const reason=this.aiLimits.reason(run);if(!reason||run.ai_limit_reason)continue;
      run.ai_limit_reason=reason;this.store.put('creator_run',run);
      const current=this.cancelRun(run.id,'ai_limit_reached');
      if(current.turn_id){void this.queueCleanup(current.id);void this.pauseRunGoal(current.id).catch(()=>{}).then(()=>this.adapter.interrupt(current.thread_id,current.turn_id)).catch(()=>{});}
    }
  }
  async close(){clearInterval(this.limitTimer);this.closing=true;await this.adapter.stop();await this.autoResume.close();await Promise.allSettled([...this.cleanups.values()]);}
}
