import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { clone, fail, hash, id } from './schema.mjs';
import { assertHierarchyRuntimeCompatibility } from './hierarchy-references.mjs';
import { inspectionObjects, inspectionAttachment } from './inspection-objects.mjs';
import { prepareExecutionEnvironment, snapshotRuntime, verifyRuntimeSnapshot, verifyRuntimeSources } from './execution-environment.mjs';
import { NativeWorlds } from './native-worlds.mjs';

export class CreationWorlds {
  constructor({service,server,godotPath='/Applications/Godot.app/Contents/MacOS/Godot'}) {
    this.service=service;this.store=service.store;this.godotPath=godotPath;
    this.runtime=resolve(service.root,'runtimes/model-preview');this.directory=resolve(service.data,'worlds');mkdirSync(this.directory,{recursive:true});
    this.worlds=new Map();this.workers=new Set();this.tokens=new Map();this.preparing=new Map();this.validationJobs=new Map();this.validationProcesses=new Set();
    this.native=new NativeWorlds(this);
    this.wss=new WebSocketServer({noServer:true,maxPayload:8*1024*1024});
    server.on('upgrade',(req,socket,head)=>{
      if(new URL(req.url,'http://localhost').pathname!=='/ws/world-worker')return;
      if(socket.destroyed||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||(service.requestOrigin&&!service.requestOrigin(req))){socket.destroy();return;}
      const token=String(req.headers.authorization??'').replace(/^Bearer /,''),world=this.tokens.get(token);
      if(!world||world.ws){socket.destroy();return;}
      this.wss.handleUpgrade(req,socket,head,ws=>this.workerConnected(world,ws));
    });
    this.timer=setInterval(()=>this.watchdog(),2000);this.timer.unref();
  }
  key(p,b,r){return `${p}/${b}/${r}`;}
  assertSharedSource(revision) {
    const manifest=this.store.get('creator_revision',revision)?.manifest;
    if(!manifest)fail(409,'共享世界固定源版本不存在');
    if(manifest.schema==='creation-native-1')fail(422,'原生工程尚未接入共享权威世界；请使用独立 Play 或导出运行',{code:'native_shared_runtime_unavailable',source_revision:revision,document_schema:manifest.schema});
    return manifest;
  }
  nativeHead(branch){return this.store.get('creator_revision',branch.head)?.manifest?.schema==='creation-native-1';}
  runtimeManifest() {
    let manifest;try{manifest=JSON.parse(readFileSync(resolve(this.service.runtimeBuild,'manifest.json')));}catch{fail(503,'Godot 客户端尚未构建');}
    verifyRuntimeSources({directory:this.runtime,manifest});
    if(manifest.capabilities){
      const entry=manifest.sources.find(file=>file.path==='runtime_capabilities.json');
      if(!entry||hash(manifest.capabilities)!==hash(JSON.parse(readFileSync(resolve(this.runtime,entry.path)))))fail(503,'运行能力与固定构建源码不匹配');
    }
    return manifest;
  }
  signalProcess(child,signal) {
    if(!child)return;
    if(child.executionProcessGroup&&Number.isInteger(child.pid)&&child.pid>1){
      try{return process.kill(-child.pid,signal);}catch(error){if(error.code==='ESRCH')return false;throw error;}
    }
    return child.kill(signal);
  }
  async runIsolated(invocation,{timeoutMs=45000,collect=()=>{}}={}) {
    if(this.closing)fail(503,'中央服务正在关闭');
    return new Promise((resolveRun,reject)=>{
      const child=spawn(invocation.command,invocation.args,{...invocation.options,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
      child.executionProcessGroup=process.platform!=='win32';
      (this.validationProcesses??=new Set()).add(child);
      let timedOut=false;const timer=setTimeout(()=>{timedOut=true;this.signalProcess(child,'SIGKILL');},timeoutMs);
      child.stdout.on('data',collect);child.stderr.on('data',collect);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',(code,signal)=>{clearTimeout(timer);this.validationProcesses.delete(child);try{this.signalProcess(child,'SIGKILL');}catch(error){reject(error);return;}resolveRun({code,signal,timedOut});});
    });
  }
  async prepareRuntime(manifest,directory) {
    if(this.closing)fail(503,'中央服务正在关闭');
    const snapshot=snapshotRuntime({sourceDirectory:this.runtime,destination:resolve(directory,'runtime'),manifest});
    const cache=resolve(snapshot.directory,'.godot');mkdirSync(cache,{recursive:true});
    // Godot imports need a private generated cache and safe-save sidecars for
    // existing .import metadata. No script, project setting or source directory
    // is writable. Recheck all fixed source bytes after the editor exits.
    const metadata=manifest.sources.filter(file=>file.path.endsWith('.import')).map(file=>resolve(snapshot.directory,file.path));
    const environment=prepareExecutionEnvironment({directory:resolve(directory,'import-environment'),readPaths:[snapshot.directory],writePaths:[cache],safeSavePaths:metadata});
    const invocation=environment.command(this.godotPath,['--headless','--editor','--path',snapshot.directory,'--import'],{godot:true,projectPath:snapshot.directory,logName:'import.log'});
    let output='',hadError=false,errorTail='';const result=await this.runIsolated(invocation,{collect:chunk=>{const bytes=chunk.toString();hadError ||= /SCRIPT ERROR|Parse Error|ERROR:/.test(errorTail+bytes);errorTail=(errorTail+bytes).slice(-32);output=(output+bytes).slice(-1024*1024);}});
    writeFileSync(resolve(directory,'import.log'),output);
    verifyRuntimeSnapshot({directory:snapshot.directory,manifest});
    if(result.code!==0||result.timedOut||hadError)fail(503,'固定 Godot 环境导入失败',{process:result,log:resolve(directory,'import.log')});
    return {...snapshot,import_process:result};
  }
  record(world){return{id:world.id,key:world.key,project_id:world.project_id,branch_id:world.branch_id,resource_id:world.resource_id,revision:world.revision,runtime_build_id:world.runtime_build_id,...(world.native_shared?{native_shared:true,game_build_id:world.game_build_id,source_identity:world.source_identity}:{}),epoch:world.epoch,snapshot:world.snapshot,failure_history:world.failure_history??[],...(world.execution?{execution:clone(world.execution)}:{}),updated_at:Date.now()};}
  persist(world){if(world.snapshot)this.store.put('creator_world',this.record(world));}
  failureKind(failure){
    if(failure?.kind)return failure.kind;
    // Compatibility with persisted pre-classification records. An empty fault
    // snapshot alone does not prove infrastructure failure: only known messages.
    return /^(Godot 权威连接中断|Godot 权威心跳超时)/.test(failure?.message??'')?'infrastructure':'unknown';
  }
  archiveFailure(world,failure){
    const entry={...clone(failure),id:failure.id??`world-failure-${hash({world_id:world.id,epoch:world.epoch,failure})}`,
      world_id:world.id,epoch:failure.epoch??world.epoch,revision:failure.revision??world.revision,runtime_build_id:failure.runtime_build_id??world.runtime_build_id,snapshot_hash:hash(world.snapshot??{}),kind:this.failureKind(failure)};
    if(!this.store.get('creator_world_failure',entry.id))this.store.put('creator_world_failure',entry);
    return entry.id;
  }
  command(world,packet,timeout=40000) {
    if(world.ws?.readyState!==WebSocket.OPEN)return Promise.reject(Object.assign(new Error('世界连接未就绪'),{status:503}));
    const request_id=id('request');
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{world.pending.delete(request_id);reject(Object.assign(new Error('Godot 世界确认超时'),{status:504}));},timeout);
      world.pending.set(request_id,{resolve,reject,timer});world.ws.send(JSON.stringify({...packet,request_id}));
    });
  }
  tell(world,packet){if(world.ws?.readyState===WebSocket.OPEN)world.ws.send(JSON.stringify(packet));}
  scene(user,world,revision=world.revision,origin=this.service.origin) {
    if(world.native_shared)return this.native.scene(user,world,revision);
    const branch=this.store.branchFor(user,world.project_id,world.branch_id),manifest=this.assertSharedSource(revision);
    return this.service.assets.scene(user,world.project_id,{...branch,head:revision,manifest},world.resource_id,origin,manifest.schema==='creation-hierarchy-2'?this.runtimeManifest().capabilities??{}:{});
  }
  playable(user,p,b,resourceId) {
    const branch=this.store.branchFor(user,p,b),key=this.key(p,b,resourceId);
    const world=this.worlds.get(key)??this.store.list('creator_world').find(w=>w.key===key);
    if(!world&&this.native?.isNative(branch.head))return this.native.playable(user,p,b,resourceId);
    const revision=world?.revision??branch.head,fixed=this.store.get('creator_revision',revision);
    if(!fixed||fixed.project_id!==p||!this.store.ancestor(revision,branch.head)||!fixed.manifest.resources[resourceId])fail(409,'当前没有此场景可进入的固定版本');
    this.assertSharedSource(revision);
    if(world?.failure)fail(422,'此世界需要编辑者处理故障后再开放试玩');
    return {source_revision:revision,resource_id:resourceId,world_id:world?.id??null,runtime_build_id:world?.ready?world.runtime_build_id:this.runtimeManifest().build_id};
  }
  async validate(user,p,b,input={}, {forJoin=false}={}) {
    if(this.closing)fail(503,'中央服务正在关闭');
    const branch=this.store.branchFor(user,p,b,!forJoin),revision=input.revision||branch.head;
    if(this.native?.isNative(revision))return this.native.validate(user,p,b,input);
    if(!this.store.ancestor(revision,branch.head))fail(409,'候选必须是当前分支的源版本');
    const manifest=this.assertSharedSource(revision),document=manifest.resources[input.resource_id||manifest.entry_scene_id];
    if(!document)fail(404,'候选资源不存在');
    const runtimeManifest=this.runtimeManifest();
    const world=this.worlds.get(this.key(p,b,document.id));
    const jobId=id('verification'),dir=resolve(this.directory,'verification',jobId);mkdirSync(dir,{recursive:true});
    const scene=this.service.assets.scene(user,p,{...branch,head:revision,manifest:this.store.get('creator_revision',revision).manifest},document.id,this.service.origin,runtimeManifest.capabilities??{});
    const persisted=this.store.list('creator_world').find(w=>w.key===this.key(p,b,document.id));
    const state=clone(world?.snapshot??persisted?.snapshot??{}),stateHash=hash(state),file=resolve(dir,'candidate.json'),reportFile=resolve(dir,'report.json');
    writeFileSync(file,JSON.stringify({scene,scene_revision:revision,state}));
    const verification={id:jobId,project_id:p,branch_id:b,resource_id:document.id,revision,runtime_build_id:runtimeManifest.build_id,state_hash:stateHash,status:'running',started_at:Date.now(),actor_id:user.id,...(input.origin?{origin:clone(input.origin)}:{})};
    this.store.put('creator_verification',verification);this.validationJobs.set(jobId,verification);
    let output='',hadError=false,errorTail='';const logFile=resolve(dir,'godot.log');
    let complete;const completion=new Promise(resolveComplete=>{complete=resolveComplete;});(this.validationSettled??=new Set()).add(completion);
    try{
      const runtime=await this.prepareRuntime(runtimeManifest,dir);
      const environment=prepareExecutionEnvironment({directory:resolve(dir,'execution-environment'),readPaths:[runtime.directory,file],safeSavePaths:[reportFile],networkOrigins:[this.service.origin]});
      verification.execution={runtime,capabilities:environment.capabilities,directory:environment.directory};this.store.put('creator_verification',verification);
      const invocation=environment.command(this.godotPath,['--headless','--path',runtime.directory,'--',`--validate-scene=${file}`,`--report=${reportFile}`],{godot:true,projectPath:runtime.directory});
      const result=await this.runIsolated(invocation,{collect:chunk=>{const bytes=chunk.toString();hadError ||= /SCRIPT ERROR|Parse Error|ERROR:/.test(errorTail+bytes);errorTail=(errorTail+bytes).slice(-32);output=(output+bytes).slice(-1024*1024);}});
      verifyRuntimeSnapshot({directory:runtime.directory,manifest:runtimeManifest});
      writeFileSync(logFile,output);
      let report;try{report=JSON.parse(readFileSync(reportFile));}catch{report={ok:false,error:'Godot 未写入验证报告'};}
      const ok=result.code===0&&!result.timedOut&&!hadError&&report.ok===true&&report.completed===true;
      const finished={...verification,status:ok?'passed':'failed',completed_at:Date.now(),report,process:result,evidence:{report:reportFile,log:logFile}};
      this.store.put('creator_verification',finished);this.service.verificationFinished?.(finished);return finished;
    }catch(error){writeFileSync(logFile,output);const failed={...verification,status:'failed',completed_at:Date.now(),error:error.message};this.store.put('creator_verification',failed);this.service.verificationFinished?.(failed);return failed;}
    finally{this.validationJobs.delete(jobId);this.validationSettled.delete(completion);complete();}
  }
  async ensure(user,p,b,r,{recovery=null}={}) {
    if(this.closing)fail(503,'中央服务正在关闭');
    const branch=this.store.branchFor(user,p,b),resourceId=r||this.store.get('creator_revision',branch.head).manifest.entry_scene_id,key=this.key(p,b,resourceId);
    const pending=this.preparing.get(key),existing=this.worlds.get(key),old=this.store.list('creator_world').find(w=>w.key===key);
    const revision=recovery?.revision??existing?.revision??pending?.sourceRevision??old?.revision??branch.head;
    if(this.native?.isNative(revision))return this.native.start(user,p,b,resourceId);
    this.assertSharedSource(revision);
    if(pending){if(recovery||pending.explicitRecovery)fail(409,'世界正在准备或显式恢复，请等待完成后重新进入');return pending;}
    if(existing?.ready){if(recovery)fail(409,'世界已由另一个请求启动，请重新核对并发布');return existing;}
    const task=this.startWorld(user,p,b,resourceId,key,{recovery}).finally(()=>{if(this.preparing.get(key)===task)this.preparing.delete(key);});
    task.explicitRecovery=Boolean(recovery);task.sourceRevision=revision;this.preparing.set(key,task);return task;
  }
  async startWorld(user,p,b,r,key,{recovery=null}={}) {
    const branch=this.store.branchFor(user,p,b),old=this.store.list('creator_world').find(w=>w.key===key);
    // A room restarts its last applied release/checkpoint, not a moving source head.
    const revision=recovery?.revision??old?.revision??branch.head;
    if(this.native?.isNative(revision))return this.native.start(user,p,b,r);
    this.assertSharedSource(revision);
    if(old?.failure&&!recovery)fail(422,'此前世界已停止，请显式验证并应用源稿后恢复',{world_id:old.id,revision:old.revision,failure:old.failure});
    // A migrated branch can explicitly recover its previously applied legacy
    // release, using the same proof/permission checks and unchanged source head.
    const migratedRecovery=Boolean(recovery&&old?.revision===revision&&this.nativeHead(branch));
    const recoveryHead=branch.head;
    const verification=recovery?.verification??await this.validate(user,p,b,{revision,resource_id:r},{forJoin:true});
    if(verification.status!=='passed'||verification.project_id!==p||verification.branch_id!==b||verification.resource_id!==r||verification.revision!==revision)fail(422,'Godot 候选验证结果与恢复目标不匹配',{verification});
    if(recovery&&verification.state_hash!==hash(old?.snapshot??{}))fail(409,'验证后的检查点已变化，请重新验证恢复');
    if(old?.failure&&!['infrastructure','precondition'].includes(this.failureKind(old.failure))&&revision===(old.failure.revision??old.revision)&&verification.runtime_build_id===(old.failure.runtime_build_id??old.runtime_build_id))fail(422,'此内容与运行时已经发生行为或未知故障，请修复内容或升级运行时后重新验证',{failure:old.failure});
    const assertStart=()=>{try{
      if(this.closing)fail(503,'中央服务正在关闭');
      const current=this.store.branchFor(user,p,b,Boolean(recovery));
      if(recovery&&current.head!==revision&&!(migratedRecovery&&current.head===recoveryHead))fail(409,'恢复期间源分支已更新，未启动陈旧候选');
      if(this.runtimeManifest().build_id!==verification.runtime_build_id)fail(409,'恢复期间客户端版本已变化，请重新验证');
      recovery?.guard?.();
    }catch(error){if([403,409,503].includes(error.status))error.world_start_precondition=true;throw error;}};
    assertStart();
    const executionDirectory=resolve(this.directory,'executions',id('authority'));
    const runtime=await this.prepareRuntime(this.runtimeManifest(),executionDirectory);
    assertStart();
    const failureHistory=[...(old?.failure_history??[])];if(old?.failure){const reference=this.archiveFailure(old,old.failure);if(!failureHistory.includes(reference))failureHistory.push(reference);}
    const world={id:old?.id||id('world'),key,project_id:p,branch_id:b,resource_id:r,revision,runtime_build_id:verification.runtime_build_id,epoch:(old?.epoch??0)+1,snapshot:old?.snapshot??null,failure_history:failureHistory,previous_record:old,assertStart,history:new Map(),clients:new Map(),pending:new Map(),ready:false,activated:false,last_seen:Date.now(),last_persist:0,log:''};
    world.initialScene=this.scene(user,world);
    const token=randomBytes(32).toString('base64url');
    const workerURL=this.service.origin.replace(/^http/,'ws')+'/ws/world-worker';
    // Keep terminal Ctrl-C out of the worker group. Its own child handle remains
    // referenced and close() still waits/reaps it. WebSocket loss makes the
    // authority worker quit, including after an ungraceful parent death.
    const environment=prepareExecutionEnvironment({directory:resolve(executionDirectory,'execution-environment'),readPaths:[runtime.directory],networkOrigins:[this.service.origin],extraEnv:{WA_WORKER_URL:workerURL,WA_WORKER_TOKEN:token}});
    world.execution={runtime,capabilities:environment.capabilities,directory:environment.directory};
    const invocation=environment.command(this.godotPath,['--headless','--path',runtime.directory,'--','--authority'],{godot:true,projectPath:runtime.directory});
    this.worlds.set(key,world);this.tokens.set(token,world);world.token=token;
    const ready=new Promise((resolveReady,reject)=>{world.resolveReady=resolveReady;world.rejectReady=reject;world.readyTimer=setTimeout(()=>reject(new Error('Godot 权威启动超时')),40000);});
    world.process=spawn(invocation.command,invocation.args,{...invocation.options,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    world.process.executionProcessGroup=process.platform!=='win32';
    const collect=bytes=>{world.log=(world.log+bytes.toString()).slice(-512000);};world.process.stdout.on('data',collect);world.process.stderr.on('data',collect);
    this.workers.add(world);
    world.process.once('error',error=>this.failed(world,error));world.process.once('close',(code,signal)=>{world.processClosed=true;this.workers.delete(world);try{this.signalProcess(world.process,'SIGKILL');}catch(error){world.cleanupError=error.message;}writeFileSync(resolve(this.directory,`${world.id}.log`),world.log);this.processFailed(world,code,signal);});
    try{await ready;assertStart();return world;}catch(error){this.failed(world,error);this.signalProcess(world.process,'SIGKILL');await this.reap(world);if(this.worlds.get(key)===world)this.worlds.delete(key);throw error;}
  }
  workerConnected(world,ws) {
    if(world.native_shared)return this.native.connected(world,ws);
    world.ws=ws;
    ws.on('message',async bytes=>{try{
      if(world.failed)return;
      const packet=JSON.parse(bytes.toString());world.last_seen=Date.now();
      if(packet.type==='worker_hello') {
        world.assertStart?.();
        const applied=await this.command(world,{type:'init',world_id:world.id,epoch:world.epoch,scene_revision:world.revision,scene:world.initialScene,state:world.snapshot??{}});
        if(!applied.ok)throw new Error(applied.error||'Godot 初始化失败');
        world.assertStart?.();
        if(world.failed||this.worlds.get(world.key)!==world)throw new Error('世界启动已失效');
        if(applied.snapshot?.world_id!==world.id||applied.snapshot?.epoch!==world.epoch||applied.snapshot?.scene_revision!==world.revision)throw new Error('Godot 恢复确认边界不匹配');
        world.snapshot=applied.snapshot;world.ready=true;world.activated=true;clearTimeout(world.readyTimer);this.persist(world);this.service.observe?.(()=>this.service.notices?.worldReady(world));world.resolveReady(world);this.service.agent?.publicState(world.project_id,world.branch_id);return;
      }
      if(packet.request_id&&world.pending.has(packet.request_id)) {
        const pending=world.pending.get(packet.request_id);world.pending.delete(packet.request_id);clearTimeout(pending.timer);pending.resolve(packet);return;
      }
      if(packet.type==='world_snapshot') {
        const snapshot=packet.snapshot;if(snapshot.world_id!==world.id||snapshot.epoch!==world.epoch)return;
        if(snapshot.runtime_fault&&Object.keys(snapshot.runtime_fault).length){this.failed(world,new Error('运行中的行为发生错误，需要修复候选后恢复'),{kind:'behavior',runtime_fault:snapshot.runtime_fault});return;}
        if(world.snapshot&&snapshot.sequence<world.snapshot.sequence)return;
        world.snapshot=snapshot;world.history.set(snapshot.sequence,clone(snapshot));while(world.history.size>150)world.history.delete(world.history.keys().next().value);this.broadcast(world,{action:'snapshot',snapshot});
        if(Date.now()-world.last_persist>5000){this.persist(world);world.last_persist=Date.now();}return;
      }
      if(packet.type==='world_events'){if(packet.events.some(e=>e.kind==='runtime_fault')){this.failed(world,new Error('运行中的行为发生错误，需要修复候选后恢复'),{kind:'behavior',runtime_fault:packet.events.filter(e=>e.kind==='runtime_fault')});return;}this.broadcast(world,{action:'events',events:packet.events});return;}
      if(packet.type==='worker_error')this.failed(world,new Error(packet.error||'Godot 行为执行失败'));
    }catch(error){this.failed(world,error);}});
    ws.on('close',()=>this.failed(world,new Error('Godot 权威连接中断'),{kind:'infrastructure'}));
  }
  broadcast(world,packet) {
    for(const client of world.clients.values()) {
      if(client.world_scope!==client.scope||client.world_key!==world.key){this.leave(client);continue;}
      try{this.store.authenticate(client.token);this.store.projectFor(client.user,world.project_id);this.service.realtime.send(client,{type:'world',packet:{world_id:world.id,epoch:world.epoch,scene_revision:world.revision,...packet}});}catch{client.ws.close(1008,'Authorization changed');}
    }
  }
  async publish(user,p,b,input={}) {
    if(this.closing)fail(503,'中央服务正在关闭');
    const branch=this.store.branchFor(user,p,b,true),revision=input.revision||branch.head;
    if(this.native?.isNative(revision))return this.native.publish(user,p,b,input);
    if(revision!==branch.head)fail(409,'源分支已更新，请重新验证当前版本');
    const manifest=this.assertSharedSource(revision),resourceId=input.resource_id||manifest.entry_scene_id;
    const world=this.worlds.get(this.key(p,b,resourceId));
    if(world?.publishing)fail(409,'此世界正在应用另一个候选');
    if(world)world.publishing=true;
    try{
      const verification=await this.validate(user,p,b,{revision,resource_id:resourceId,origin:input.origin});
      if(verification.status!=='passed')fail(422,'候选验证失败，当前世界保持原发行',{verification});
      if(world&&world.runtime_build_id!==verification.runtime_build_id)fail(409,'候选需要新的 Godot 客户端，请先完成客户端升级与世界恢复');
      const latest=this.store.branchFor(user,p,b,true);if(latest.head!==revision)fail(409,'验证期间源分支已变化，未发布陈旧候选');
      input.guard?.();
      if(!world){const started=await this.ensure(user,p,b,resourceId,{recovery:{revision,verification,guard:input.guard}});input.guard?.();const delivery={id:id('delivery'),world_id:started.id,epoch:started.epoch,revision:started.revision,applied_sequence:started.snapshot.sequence,verification_id:verification.id,created_at:Date.now()};this.store.put('creator_delivery',delivery);this.service.deliveryFinished?.(delivery,input.origin);return {verification,delivery};}
      const scene=this.scene(user,world,revision),applied=await this.command(world,{type:'apply_scene',scene_revision:revision,scene});
      if(!applied.ok)fail(422,'运行世界拒绝候选，保持原发行',{error:applied.error,verification});
      if(applied.snapshot?.scene_revision!==revision)fail(502,'Godot 确认版本不匹配');
      world.revision=revision;world.snapshot=applied.snapshot;this.persist(world);
      for(const client of world.clients.values())this.service.realtime.send(client,{type:'world_scene',world_id:world.id,epoch:world.epoch,scene_revision:revision,scene:this.scene(client.user,world,world.revision,client.origin??this.service.origin)});
      this.broadcast(world,{action:'snapshot',snapshot:world.snapshot});
      const delivery={id:id('delivery'),world_id:world.id,epoch:world.epoch,revision,applied_sequence:world.snapshot.sequence,verification_id:verification.id,created_at:Date.now()};this.store.put('creator_delivery',delivery);this.service.deliveryFinished?.(delivery,input.origin);return {verification,delivery};
    }finally{if(world)world.publishing=false;}
  }
  async message(client,message) {
    if(this.native&&message.type==='world_join'&&(message.native_shared===true||this.native.isNative(message.source_revision)))return this.native.message(client,message);
    if(this.worlds.get(client.world_key)?.native_shared&&['world_input','world_ready'].includes(message.type))return this.native.message(client,message);
    if(message.type==='world_join') {
      const scope=client.scope;if(!scope||scope.project_id!==message.project_id||scope.branch_id!==message.branch_id||scope.resource_id!==message.resource_id)fail(409,'先订阅目标场景再进入试玩');
      this.store.projectFor(client.user,scope.project_id);
      const requestedRevision=message.source_revision;
      const assertRequested=()=>{
        const branch=this.store.branchFor(client.user,scope.project_id,scope.branch_id);
        const key=this.key(scope.project_id,scope.branch_id,scope.resource_id);
        const live=this.worlds.get(key)??this.store.list('creator_world').find(w=>w.key===key);
        const roomRevision=live?.revision??this.preparing.get(key)?.sourceRevision;
        if(requestedRevision!==undefined&&(typeof requestedRevision!=='string'||![branch.head,roomRevision].includes(requestedRevision)))fail(409,'共享世界固定版本与当前源稿或房间不匹配');
        // Omitted revision means the existing room's applied release, not the
        // branch's newer source. This also guards pre-versioned clients.
        const manifest=this.assertSharedSource(requestedRevision??roomRevision??branch.head);
        if(requestedRevision===undefined)return;
        const player=this.store.roleFor(client.user,this.store.projectFor(client.user,scope.project_id))==='player';
        const target=player?this.playable(client.user,scope.project_id,scope.branch_id,scope.resource_id).source_revision:roomRevision&&this.nativeHead(branch)?roomRevision:branch.head;
        if(typeof requestedRevision!=='string'||requestedRevision!==target)fail(409,player?'可玩版本已变化，请重新进入试玩':'源稿已经变化，请读取当前版本后再试玩');
        assertHierarchyRuntimeCompatibility(manifest,this.runtimeManifest().capabilities??{});
        if(live&&live.revision!==requestedRevision)fail(409,'当前运行世界尚未应用这份源稿，请先验证并应用后再试玩',{required_source_revision:requestedRevision,live_revision:live.revision});
      };
      assertRequested();
      const world=await this.ensure(client.user,scope.project_id,scope.branch_id,scope.resource_id);
      // Permissions and subscription may change while candidate preparation awaits.
      this.store.projectFor(client.user,scope.project_id);if(client.scope!==scope||client.ws.readyState!==WebSocket.OPEN)fail(409,'准备期间工作台已切换');
      assertRequested();
      if(message.runtime_build_id!==world.runtime_build_id)fail(409,'Godot 客户端与世界版本不同，请刷新工作台后重新进入',{required_runtime_build_id:world.runtime_build_id});
      if([...world.clients.values()].some(c=>c.user.id===client.user.id&&c.id!==client.id))fail(409,'当前身份已在另一个视口控制角色');
      await this.leave(client);
      // leave yields; a concurrent join or subscription change may have won meanwhile.
      this.store.projectFor(client.user,scope.project_id);
      if(client.scope!==scope||client.ws.readyState!==WebSocket.OPEN)fail(409,'加入期间工作台已切换');
      if([...world.clients.values()].some(c=>c.user.id===client.user.id&&c.id!==client.id))fail(409,'当前身份已在另一个视口控制角色');
      world.clients.set(client.id,client);client.world_key=world.key;client.world_scope=scope;
      this.tell(world,{type:'join',player_id:client.user.id,name:client.user.name,color:client.user.color});
      this.service.realtime.send(client,{type:'world',packet:{action:'join',world_id:world.id,epoch:world.epoch,scene_revision:world.revision,player_id:client.user.id,scene:this.scene(client.user,world,world.revision,client.origin??this.service.origin),snapshot:world.snapshot,manifest:{runtime_build_id:world.runtime_build_id,runtime_url:`/preview-builds/${world.runtime_build_id}/index.html`,source_revision:world.revision,resource_id:world.resource_id,world_id:world.id,epoch:world.epoch,state_sequence:world.snapshot.sequence,state_hash:hash(world.snapshot)}}});return;
    }
    if(message.type==='world_leave'||message.type==='world_disconnect'){await this.leave(client);return;}
    const world=this.worlds.get(client.world_key);if(!world?.ready||!world.clients.has(client.id)||client.world_scope!==client.scope||client.scope?.project_id!==world.project_id||client.scope?.branch_id!==world.branch_id||client.scope?.resource_id!==world.resource_id)fail(409,'尚未加入当前场景的可玩世界');
    this.store.projectFor(client.user,world.project_id);
    if(message.type==='world_inspection') {
      const state=message.state;
      if(state?.mode!=='inspecting'||state.world_id!==world.id||state.epoch!==world.epoch||state.player_id!==client.user.id)fail(409,'检查视图不属于当前角色与世界');
      const frozen=world.history.get(state.frozen_sequence),stopped=world.history.get(state.stop_ack_sequence);
      if(!frozen||!stopped||frozen.scene_revision!==state.frozen_revision||!Number.isSafeInteger(state.input_zero_seq)||!client.zeroInputs?.has(state.input_zero_seq)||(stopped.players[client.user.id]?.last_input_seq??-1)<state.input_zero_seq)fail(409,'检查快照或停止输入确认已过期，请重新进入检查');
      const manifest=this.store.get('creator_revision',state.frozen_revision)?.manifest;if(!manifest)fail(409,'冻结源版本不可用');
      const resourceId=world.native_shared?frozen.resource_id:world.resource_id;
      if(world.native_shared&&(state.resource_id!==resourceId||state.scene_generation!==frozen.scene_generation))fail(409,'检查对象与实际冻结关卡不一致');
      const observations=inspectionObjects(manifest,{project_id:world.project_id,branch_id:world.branch_id,resource_id:resourceId},state.inspection_objects);
      client.inspection={id:id('inspection'),project_id:world.project_id,branch_id:world.branch_id,resource_id:resourceId,world_id:world.id,epoch:world.epoch,runtime_build_id:world.runtime_build_id,player_id:client.user.id,sequence:frozen.sequence,revision:frozen.scene_revision,state_hash:hash(frozen),snapshot:clone(frozen),stop_ack_sequence:stopped.sequence,input_zero_seq:state.input_zero_seq,observations,captured_at:Date.now()};
      this.store.put('creator_inspection',{...client.inspection,owner_user_id:client.user.id});
      this.service.realtime.send(client,{type:'inspection_recorded',inspection_id:client.inspection.id,sequence:frozen.sequence,revision:frozen.scene_revision});return;
    }
    if(message.type==='world_input') {
      const packet=message.input??message;
      if(packet.world_id!==world.id||packet.epoch!==world.epoch||packet.scene_revision!==world.revision)fail(409,'玩法输入的世界版本已过期');
      if(!Number.isSafeInteger(packet.input_seq)||packet.input_seq<1||!Array.isArray(packet.move)||packet.move.length!==2||!packet.move.every(n=>Number.isFinite(n)&&Math.abs(n)<=1))fail(400,'玩法输入无效');
      if(packet.move.every(n=>n===0)&&!packet.jump&&!packet.interact){client.zeroInputs??=new Set();client.zeroInputs.add(packet.input_seq);while(client.zeroInputs.size>64)client.zeroInputs.delete(client.zeroInputs.values().next().value);}
      this.tell(world,{type:'input',player_id:client.user.id,input_seq:packet.input_seq,move:packet.move,jump:packet.jump===true,interact:packet.interact===true,epoch:world.epoch,scene_revision:world.revision});return;
    }
    fail(400,'未知世界命令');
  }
  async leave(client){const world=this.worlds.get(client.world_key);if(world?.clients.delete(client.id))this.tell(world,{type:'leave',player_id:client.user.id});client.world_active=false;client.control_generation=null;client.world_barrier=null;client.world_key=null;client.world_scope=null;client.zeroInputs?.clear();client.inspection=null;}
  attachInspection(user,sid,input) {
    const session=this.store.sessionFor(user,sid,true),inspection=this.store.get('creator_inspection',input.inspection_id);
    if(!inspection||inspection.owner_user_id!==user.id||inspection.project_id!==session.project_id||inspection.branch_id!==session.branch_id)fail(403,'检查记录不属于此会话与开发者');
    if(input.world_id!==inspection.world_id||input.epoch!==inspection.epoch||input.sequence!==inspection.sequence||input.resource_id!==inspection.resource_id)fail(409,'检查附件的世界边界不匹配');
    const attachment={...inspectionAttachment(this.store.get('creator_revision',inspection.revision).manifest,inspection,input),session_id:sid};
    session.draft_attachments.push(attachment);this.store.put('creator_session',session);return attachment;
  }
  processFailed(world,code,signal){
    this.failed(world,new Error(`Godot 权威已停止 (${code??signal})`),{kind:['SIGINT','SIGTERM','SIGKILL'].includes(signal)?'infrastructure':'unknown',process_exit:{code,signal}});
  }
  failed(world,error,{kind='unknown',runtime_fault=null,process_exit=null}={}) {
    if(world.native_shared&&!world.nativeFailureHandling)return this.native.failed(world,error,{kind,runtime_fault,process_exit});
    if(world.failed)return;world.failed=true;world.ready=false;clearTimeout(world.readyTimer);world.rejectReady?.(error);
    // Only assertStart marks these known permission/version/closing rejections.
    // A worker's own error/status can never grant retry permission.
    if(error.world_start_precondition===true)kind='precondition';
    if(!this.closing){
      const failure={id:id('world-failure'),kind,message:error.message,at:Date.now(),epoch:world.epoch,revision:world.revision,runtime_build_id:world.runtime_build_id,...(runtime_fault?{runtime_fault:clone(runtime_fault)}:{}),...(process_exit?{process_exit:clone(process_exit)}:{})};
      const reference=this.archiveFailure(world,failure);world.failure_history??=[];world.failure_history.push(reference);
      // A rejected startup must not replace the last confirmed checkpoint with
      // a candidate revision/build whose init ACK never became authoritative.
      const baseline=!world.activated&&world.previous_record?world.previous_record:this.record(world);
      this.store.put('creator_world',{...baseline,failure_history:world.failure_history,failure});
      this.service.observe?.(()=>this.service.notices?.world(world,failure));
    }
    for(const pending of world.pending.values()){clearTimeout(pending.timer);pending.reject(error);}world.pending.clear();
    if(!this.closing)this.broadcast(world,{action:'error',error:error.message});for(const client of world.clients.values())client.world_key=null;world.clients.clear();
    this.tokens.delete(world.token);if(this.worlds.get(world.key)===world)this.worlds.delete(world.key);world.ws?.close();this.signalProcess(world.process,'SIGTERM');
    if(!this.closing)this.service.agent?.publicState(world.project_id,world.branch_id);
    if(world.process)void this.reap(world).catch(error=>{world.cleanup_error=error.message;});
  }
  reap(world){
    if(world.processClosed||!world.process)return world.cleanupError?Promise.reject(new Error(world.cleanupError)):Promise.resolve();
    if(world.reapPromise)return world.reapPromise;
    world.reapPromise=new Promise((resolveReap,reject)=>{
      let timer;const finish=error=>{clearTimeout(timer);world.process.removeListener('close',closed);error?reject(error):resolveReap();},closed=()=>finish(world.cleanupError?new Error(world.cleanupError):undefined);
      world.process.once('close',closed);
      timer=setTimeout(()=>{this.signalProcess(world.process,'SIGTERM');timer=setTimeout(()=>{
        this.signalProcess(world.process,'SIGKILL');
        // Sending a signal is not proof of process exit/reaping. Keep the owned
        // ChildProcess referenced and require its real close event.
        timer=setTimeout(()=>finish(new Error('自有 Godot 进程未确认退出')),2000);
      },500);},1500);
    });
    return world.reapPromise;
  }
  watchdog(){for(const world of this.worlds.values())if(world.ready&&Date.now()-world.last_seen>8000)this.failed(world,new Error('Godot 权威心跳超时；保留最后显示，重新加入后恢复检查点'),{kind:'infrastructure'});}
  beginClose(){
    if(this.closing)return;
    this.closing=true;for(const child of this.validationProcesses??[])this.signalProcess(child,'SIGKILL');clearInterval(this.timer);this.closingWorlds=[...new Set([...this.worlds.values(),...this.workers])];
    // Capture last confirmed state synchronously before any other subsystem await.
    for(const world of this.closingWorlds){world.closeCheckpointEligible=world.activated&&!world.failed;if(world.closeCheckpointEligible)this.persist(world);}
  }
  close(){
    if(this.closePromise)return this.closePromise;
    this.beginClose();this.closePromise=this.closeWorlds();return this.closePromise;
  }
  async closeWorlds(){
    await Promise.all(this.closingWorlds.map(async world=>{
      try{
        if(!world.failed){const ack=await this.command(world,{type:'shutdown'},3000);
        if(ack.ok&&ack.snapshot?.world_id===world.id&&ack.snapshot.epoch===world.epoch&&ack.snapshot.scene_revision===world.revision)world.snapshot=ack.snapshot;}
      }catch{/* A crashed worker can only recover its last confirmed checkpoint. */}
      if(world.closeCheckpointEligible)this.persist(world);
      await this.reap(world);
    }));
    // Confirm validation/import shutdown before the owner closes its database.
    await Promise.allSettled([...(this.validationSettled??[]),...this.preparing.values()]);
    await Promise.allSettled([...(this.native?.publishing.values()??[])].map(value=>value.promise));
    this.wss.close();
  }
}
