import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,cpSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import {WebSocket} from 'ws';
import {userColor} from '../../apps/creation-workspace/client-platform.js';
import {clone,fail,hash,id} from './schema.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';
import {prepareExecutionEnvironment} from './execution-environment.mjs';
import {nativeScenePacket} from './native-view.mjs';
import {nativeWorldVersion,validateNativeInput,validateNativeReady,validateNativeSnapshot} from './native-world-protocol.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const liveStatus=new Set(['queued','running']);
const writer=role=>['owner','editor'].includes(role);

/** Native rooms use the existing coordinator's authenticated worker transport,
 * process ownership and central storage. They never enter the JSON simulator. */
export class NativeWorlds {
  constructor(owner){
    this.owner=owner;this.service=owner.service;this.store=owner.store;
    this.publishing=new Map();this.operations=new Map();
  }
  fixed(revision,p=null){
    const fixed=this.store.get('creator_revision',revision);
    if(!fixed||fixed.manifest.schema!==NATIVE_SCHEMA||p&&fixed.project_id!==p)fail(409,'共享世界需要固定原生工程');
    return fixed.manifest;
  }
  isNative(revision){return this.store.get('creator_revision',revision)?.manifest.schema===NATIVE_SCHEMA;}
  key(p,b,r){return this.owner.key(p,b,r)+'/native';}
  record(p,b,r){const key=this.key(p,b,r);return this.owner.worlds.get(key)??this.store.list('creator_world').find(world=>world.key===key);}
  authorizeBuild(user,job){
    this.store.branchFor(user,job.project_id,job.branch_id);
    const world=this.record(job.project_id,job.branch_id,job.entry_scene_id);
    if(!world?.native_shared||world.game_build_id!==job.id||world.revision!==job.source_revision||world.runtime_build_id!==job.canonical_identity)fail(403,'此构建不是当前共享世界的固定发行');
    return world;
  }
  authorizeSource(user,p,b,revision){
    this.store.branchFor(user,p,b);
    const world=this.store.list('creator_world').find(world=>world.native_shared&&world.project_id===p&&world.branch_id===b&&world.revision===revision);
    if(!world)fail(403,'此源版本不是当前共享世界的固定发行');
    this.verifyBuild(this.store.get('creator_build',world.game_build_id));return world;
  }
  scene(user,world,revision=world.revision){
    this.store.branchFor(user,world.project_id,world.branch_id);
    const manifest=this.fixed(revision,world.project_id);
    return nativeScenePacket(manifest,world.snapshot?.resource_id??world.resource_id,{project_id:world.project_id,branch_id:world.branch_id,revision});
  }
  view(user,p,b,r){
    const branch=this.store.branchFor(user,p,b),project=this.store.projectFor(user,p),resource=r??this.fixed(branch.head,p).entry_scene_id;
    const world=this.record(p,b,resource),key=this.key(p,b,resource),operation=this.operations.get(key);
    return {project_id:p,branch_id:b,resource_id:resource,can_publish:writer(this.store.roleFor(user,project)),source_revision:branch.head,
      world:world?{id:world.id,source_revision:world.revision,runtime_build_id:world.runtime_build_id,game_build_id:world.game_build_id,epoch:world.epoch,sequence:world.snapshot?.sequence,tick:world.snapshot?.tick,status:world.failure?'failed':world.ready?'running':'sleeping',version:nativeWorldVersion(world),native_shared:world.native_shared===true}:null,
      ...(operation?{operation:clone(operation)}:{})};
  }
  playable(user,p,b,r){
    this.store.branchFor(user,p,b);const world=this.record(p,b,r);
    if(!world?.native_shared)fail(422,'此场景尚未发布共享世界，请创作者启动共享世界',{code:'native_shared_release_unavailable'});
    const job=this.store.get('creator_build',world.game_build_id);this.verifyBuild(job);
    if(world.failure)fail(422,'共享世界已停止，请创作者处理故障后恢复',{world_id:world.id});
    return {source_revision:world.revision,resource_id:world.resource_id,world_id:world.id,epoch:world.epoch,runtime_build_id:world.runtime_build_id,game_build_id:world.game_build_id,canonical_identity:job.canonical_identity,native_shared:true,world_version:nativeWorldVersion(world)};
  }
  verifyBuild(job){
    if(!job||job.purpose!=='native_shared'||job.status!=='completed'||!job.native_shared?.authority_files?.length||!this.service.builds.validWeb(job))fail(409,'共享世界固定工程或 Web 产物不完整');
    const manifest=this.fixed(job.source_revision,job.project_id);
    if(manifest.resources[job.entry_scene_id]?.kind!=='scene'||job.native_shared.source_identity!==manifest.source_identity)fail(409,'共享世界工程与源身份不一致');
    const {content_key,...identity}=job.game_identity??{};
    if(content_key!==job.canonical_identity||content_key!==hash(identity)||identity.purpose!=='native_shared')fail(409,'共享构建身份已变化');
    const base=resolve(this.service.builds.directory,job.id,'native-authority');
    for(const file of job.native_shared.authority_files){
      const path=resolve(base,file.path);
      if(!path.startsWith(base+sep)||!existsSync(path)||!lstatSync(path).isFile()||!realpathSync(path).startsWith(realpathSync(base)+sep)||hash(readFileSync(path))!==file.sha256)fail(409,'共享权威固定源文件缺失或已变化',{path:file.path});
    }
    return job;
  }
  async waitBuild(user,p,b,prepared,onProgress=()=>{}){
    const deadline=Date.now()+15*60*1000,identity=prepared.job.canonical_identity;
    for(;;){
      if(this.owner.closing)fail(503,'共享世界服务正在关闭');
      this.store.branchFor(user,p,b,true);
      const job=this.store.get('creator_build',prepared.job.id);
      if(!job||job.canonical_identity!==identity)fail(409,'共享构建身份发生变化');onProgress(job);
      if(!liveStatus.has(job.status)){if(job.status!=='completed')fail(422,job.error??'共享固定工程构建未完成',{job_id:job.id,status:job.status});return this.verifyBuild(job);}
      if(Date.now()>deadline)fail(504,'共享工程仍在后台构建，请查看出包记录');
      await sleep(150);
    }
  }
  async prepareAuthority(job,directory){
    this.verifyBuild(job);
    if(hash(this.service.builds.toolchainIdentity(['web']))!==hash(job.toolchain_identity))fail(409,'当前工具链与共享世界固定版本不匹配');
    const source=join(this.service.builds.directory,job.id,'native-authority'),target=join(directory,'runtime');mkdirSync(target,{recursive:true});
    for(const file of job.native_shared.authority_files){const destination=join(target,file.path);mkdirSync(dirname(destination),{recursive:true});cpSync(join(source,file.path),destination);}
    const cache=join(target,'.godot');mkdirSync(cache,{recursive:true});
    const environment=prepareExecutionEnvironment({directory:join(directory,'import-environment'),readPaths:[target],writePaths:[cache],safeSavePaths:job.native_shared.authority_files.filter(file=>file.path.endsWith('.import')).map(file=>join(target,file.path))});
    let log='';const invocation=environment.command(this.owner.godotPath,['--headless','--editor','--path',target,'--import'],{godot:true,projectPath:target});
    const result=await this.owner.runIsolated(invocation,{timeoutMs:90000,collect:bytes=>{log=(log+bytes.toString()).slice(-1024*1024);}});
    writeFileSync(join(directory,'import.log'),log);
    if(result.code!==0||result.timedOut||/SCRIPT ERROR|Parse Error|ERROR:/.test(log))fail(422,'共享权威固定工程导入失败',{log:join(directory,'import.log')});
    for(const file of job.native_shared.authority_files)if(hash(readFileSync(join(target,file.path)))!==file.sha256)fail(409,'导入修改了固定共享工程输入');
    return {directory:target,runtime_build_id:job.canonical_identity,source_hash:hash(job.native_shared.authority_files)};
  }
  async spawn(job,{worldId=id('world'),epoch=1,state={},paused=false,ephemeral=true,assertCurrent=()=>{}}={}){
    const directory=join(this.owner.directory,'native-executions',id('authority'));mkdirSync(directory,{recursive:true});
    const runtime=await this.prepareAuthority(job,directory);assertCurrent();
    if(this.owner.closing)fail(503,'共享世界服务正在关闭');
    const world={id:worldId,key:this.key(job.project_id,job.branch_id,job.entry_scene_id),project_id:job.project_id,branch_id:job.branch_id,resource_id:job.entry_scene_id,
      revision:job.source_revision,source_identity:this.fixed(job.source_revision).source_identity,runtime_build_id:job.canonical_identity,game_build_id:job.id,native_shared:true,
      epoch,snapshot:null,initialState:clone(state),initialPaused:paused,ephemeral,activated:false,ready:false,assertCurrent,history:new Map(),clients:new Map(),pending:new Map(),last_seen:Date.now(),last_persist:0,log:'',failure_history:[]};
    const token=randomBytes(32).toString('base64url');world.token=token;
    const environment=prepareExecutionEnvironment({directory:join(directory,'execution-environment'),readPaths:[runtime.directory],networkOrigins:[this.service.origin],extraEnv:{WA_WORKER_URL:this.service.origin.replace(/^http/,'ws')+'/ws/world-worker',WA_WORKER_TOKEN:token}});
    world.execution={runtime,capabilities:environment.capabilities,directory:environment.directory};
    const invocation=environment.command(this.owner.godotPath,['--headless','--path',runtime.directory,'--','--native-shared-authority'],{godot:true,projectPath:runtime.directory});
    const ready=new Promise((resolveReady,rejectReady)=>{world.resolveReady=resolveReady;world.rejectReady=rejectReady;world.readyTimer=setTimeout(()=>rejectReady(Object.assign(Error('原生共享权威启动超时'),{status:504})),45000);});
    this.owner.tokens.set(token,world);
    world.process=spawn(invocation.command,invocation.args,{...invocation.options,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});world.process.executionProcessGroup=process.platform!=='win32';
    this.owner.workers.add(world);
    const collect=bytes=>{world.log=(world.log+bytes.toString()).slice(-1024*1024);};world.process.stdout.on('data',collect);world.process.stderr.on('data',collect);
    world.process.once('error',error=>this.failed(world,error));
    world.process.once('close',(code,signal)=>{world.processClosed=true;this.owner.workers.delete(world);writeFileSync(join(directory,'worker.log'),world.log);try{this.owner.signalProcess(world.process,'SIGKILL');}catch(error){world.cleanupError=error.message;}if(!world.retiring)this.failed(world,Error(`原生共享权威已停止 (${code??signal})`),{kind:['SIGINT','SIGTERM','SIGKILL'].includes(signal)?'infrastructure':'unknown'});});
    try{await ready;assertCurrent();return world;}catch(error){await this.retire(world);throw error;}
  }
  ingest(world,snapshot,{notify=true}={}){
    validateNativeSnapshot(snapshot,world,{allowNewRevision:Boolean(world.pendingRevision)});
    const manifest=this.fixed(snapshot.scene_revision,world.project_id);
    if(snapshot.source_identity!==manifest.source_identity||!manifest.resources[snapshot.resource_id])fail(502,'原生权威快照不属于固定工程的实际关卡');
    if(snapshot.runtime_fault&&Object.keys(snapshot.runtime_fault).length)throw Object.assign(Error('原生共享脚本运行失败'),{runtime_fault:snapshot.runtime_fault});
    if(world.pendingRevision&&snapshot.scene_revision===world.pendingRevision&&snapshot.scene_revision!==world.revision){world.pendingSnapshot=snapshot;return world.snapshot;}
    if(snapshot.scene_revision!==world.revision)return world.snapshot;
    if(world.snapshot&&snapshot.sequence<=world.snapshot.sequence)return world.snapshot;
    const changed=world.snapshot&&(world.snapshot.resource_id!==snapshot.resource_id||world.snapshot.scene_generation!==snapshot.scene_generation);
    world.snapshot=snapshot;world.history.set(snapshot.sequence,clone(snapshot));while(world.history.size>300)world.history.delete(world.history.keys().next().value);
    if(changed&&notify&&world.activated)this.transferClients(world,{previous_epoch:world.epoch,previous_revision:world.revision,same_process:true,scene_changed:true});
    return snapshot;
  }
  connected(world,ws){
    world.ws=ws;
    ws.on('message',async bytes=>{try{
      if(world.failed||world.retiring)return;
      const packet=JSON.parse(bytes.toString());world.last_seen=Date.now();
      if(packet.request_id&&world.pending.has(packet.request_id)){const pending=world.pending.get(packet.request_id);world.pending.delete(packet.request_id);clearTimeout(pending.timer);pending.resolve(packet);return;}
      if(packet.type==='worker_hello'){
        if(world.initializing||packet.native_shared!==true||packet.source_identity!==world.source_identity||packet.build_id!==world.runtime_build_id)fail(502,'原生权威实际启动身份不匹配');world.initializing=true;world.assertCurrent();
        const reply=await this.owner.command(world,{type:'init',world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:world.resource_id,source_identity:world.source_identity,build_id:world.runtime_build_id,state:world.initialState,paused:world.initialPaused});
        if(!reply.ok)fail(422,reply.error??'原生场景初始化或状态恢复失败');
        this.ingest(world,reply.snapshot,{notify:false});world.assertCurrent();world.ready=true;clearTimeout(world.readyTimer);world.resolveReady(world);return;
      }
      if(packet.type==='world_snapshot'){
        const before=world.snapshot?.sequence,snapshot=this.ingest(world,packet.snapshot);if(!snapshot||snapshot.sequence===before)return;
        if(world.activated&&!world.ephemeral&&this.owner.worlds.get(world.key)===world){this.owner.broadcast(world,{action:'snapshot',snapshot});if(Date.now()-world.last_persist>5000){this.owner.persist(world);world.last_persist=Date.now();}}
        return;
      }
      if(packet.type==='worker_error')throw Error(packet.error??'原生权威运行失败');
      if(packet.type==='world_events'&&world.activated)this.owner.broadcast(world,{action:'events',events:packet.events});
    }catch(error){this.failed(world,error,{kind:error.runtime_fault?'behavior':'unknown',runtime_fault:error.runtime_fault});}});
    ws.on('close',()=>{if(!world.retiring)this.failed(world,Error('Godot 权威连接中断'),{kind:'infrastructure'});});
  }
  failed(world,error,details={}){
    if(world.failed||world.retiring)return;
    if(world.activated&&!world.ephemeral){world.nativeFailureHandling=true;try{this.owner.failed(world,error,details);}finally{world.nativeFailureHandling=false;}return;}
    world.failed=true;world.ready=false;world.error=error;clearTimeout(world.readyTimer);world.rejectReady?.(error);
    for(const pending of world.pending.values()){clearTimeout(pending.timer);pending.reject(error);}world.pending.clear();this.owner.tokens.delete(world.token);world.ws?.close();this.owner.signalProcess(world.process,'SIGTERM');
  }
  async retire(world){
    if(!world)return;world.retiring=true;clearTimeout(world.readyTimer);this.owner.tokens.delete(world.token);
    try{if(world.ws?.readyState===WebSocket.OPEN)await this.owner.command(world,{type:'shutdown'},3000);}catch{}
    world.ws?.close();this.owner.signalProcess(world.process,'SIGTERM');await this.owner.reap(world);
  }
  async validate(user,p,b,input={}){
    const branch=this.store.branchFor(user,p,b,true),revision=input.revision??branch.head,manifest=this.fixed(revision,p),resource=input.resource_id??manifest.entry_scene_id;
    if(!this.store.ancestor(revision,branch.head))fail(409,'共享候选不属于此分支');
    const existing=this.record(p,b,resource),state=clone(existing?.snapshot??{}),verification={id:id('verification'),project_id:p,branch_id:b,resource_id:resource,revision,native_shared:true,state_hash:hash(state),status:'running',started_at:Date.now(),actor_id:user.id,...(input.origin?{origin:clone(input.origin)}:{})};
    this.store.put('creator_verification',verification);this.owner.validationJobs.set(verification.id,verification);
    let complete;const settled=new Promise(resolve=>{complete=resolve;});(this.owner.validationSettled??=new Set()).add(settled);
    let world;try{
      const prepared=this.service.builds.prepareShared(user,p,b,{source_revision:revision,entry_scene_id:resource});
      const job=await this.waitBuild(user,p,b,prepared,input.onProgress);
      Object.assign(verification,{runtime_build_id:job.canonical_identity,game_build_id:job.id});this.store.put('creator_verification',verification);
      world=await this.spawn(job,{worldId:existing?.id,state,epoch:(existing?.epoch??0)+1,assertCurrent:()=>this.store.branchFor(user,p,b,true)});
      const first=world.snapshot.tick,deadline=Date.now()+30000;
      while(world.snapshot.tick-first<120){if(world.failed)throw world.error??Error('共享候选运行失败');if(Date.now()>deadline)throw Error('共享候选没有持续推进真实 tick');if(this.owner.closing)throw Error('中央服务正在关闭');await sleep(50);}
      const report={ok:true,completed:true,first_tick:first,last_tick:world.snapshot.tick,observed_ticks:world.snapshot.tick-first,snapshot:clone(world.snapshot),source_identity:manifest.source_identity,game_build_id:job.id};
      const file=join(this.owner.directory,'verification',verification.id);mkdirSync(file,{recursive:true});writeFileSync(join(file,'report.json'),JSON.stringify(report,null,2));writeFileSync(join(file,'godot.log'),world.log);
      const finished={...verification,status:'passed',completed_at:Date.now(),report,evidence:{report:join(file,'report.json'),log:join(file,'godot.log')}};this.store.put('creator_verification',finished);this.service.verificationFinished?.(finished);return finished;
    }catch(error){const finished={...verification,status:'failed',completed_at:Date.now(),error:error.message};this.store.put('creator_verification',finished);this.service.verificationFinished?.(finished);return finished;}
    finally{try{await this.retire(world);}finally{this.owner.validationJobs.delete(verification.id);this.owner.validationSettled.delete(settled);complete();}}
  }
  async start(user,p,b,r){
    this.store.branchFor(user,p,b);const old=this.record(p,b,r);
    if(old?.ready)return old;
    if(!old?.native_shared)fail(422,'请创作者先显式启动共享世界',{code:'native_shared_release_unavailable'});
    if(old.failure)fail(422,'共享世界需要创作者显式恢复',{world_id:old.id,failure:old.failure});
    const job=this.verifyBuild(this.store.get('creator_build',old.game_build_id));
    const current=()=>{this.store.branchFor(user,p,b);const saved=this.store.get('creator_world',old.id);if(nativeWorldVersion(saved)!==nativeWorldVersion(old))fail(409,'共享世界已被另一个请求更新');};
    const world=await this.spawn(job,{worldId:old.id,epoch:old.epoch+1,state:old.snapshot,ephemeral:false,assertCurrent:current});
    try{current();world.failure_history=old.failure_history??[];this.owner.persist(world);world.activated=true;this.owner.worlds.set(world.key,world);return world;}catch(error){await this.retire(world);throw error;}
  }
  async publish(user,p,b,input={}){
    const branch=this.store.branchFor(user,p,b,true),revision=input.revision??branch.head,manifest=this.fixed(revision,p),resource=input.resource_id??manifest.entry_scene_id;
    const key=this.key(p,b,resource),requestId=input.request_id??id('publish'),requestKey=hash({p,b,user_id:user.id,request_id:requestId});
    const expected=Object.hasOwn(input,'expected_world_version')?input.expected_world_version:nativeWorldVersion(this.record(p,b,resource));
    const fingerprint=hash({revision,resource_id:resource,expected_world_version:Object.hasOwn(input,'expected_world_version')?input.expected_world_version:'resolve_at_start'});
    const receipt=this.store.get('creator_native_world_publication',requestKey);
    if(receipt){if(receipt.fingerprint!==fingerprint)fail(409,'同一请求 ID 不能修改共享发布参数');return {...clone(receipt.result),replayed:true};}
    if(revision!==branch.head)fail(409,'源稿已变化，请发布当前固定源版本');
    const pending=this.publishing.get(key);
    if(pending){if(pending.requestKey===requestKey&&pending.fingerprint===fingerprint)return pending.promise;fail(409,'此共享世界正在处理另一次发布');}
    if(expected!==nativeWorldVersion(this.record(p,b,resource)))fail(409,'共享世界版本已变化，请刷新后发布');
    const operation={id:requestId,source_revision:revision,resource_id:resource,status:'running',stage:'准备共享工程',started_at:Date.now()};this.operations.set(key,operation);
    const task=this.publishNow(user,p,b,{...input,revision,resource_id:resource,publication:{requestKey,requestId,fingerprint,user_id:user.id}},expected,operation).then(result=>{
      Object.assign(operation,{status:'completed',stage:'共享世界已应用',finished_at:Date.now()});return result;
    }).catch(error=>{Object.assign(operation,{status:'failed',stage:this.store.get('creator_native_world_publication',requestKey)?'共享版本已提交，需要恢复运行':'共享世界未应用候选',error:this.service.builds.cleanError(error.message),finished_at:Date.now()});throw error;}).finally(()=>this.publishing.delete(key));
    this.publishing.set(key,{requestKey,fingerprint,promise:task});return task;
  }
  async publishNow(user,p,b,input,expected,operation){
    const {revision,resource_id:resource}=input,key=this.key(p,b,resource),initial=this.record(p,b,resource);
    const assertCurrent=()=>{
      if(this.owner.closing)fail(503,'共享世界服务正在关闭');
      if(this.store.branchFor(user,p,b,true).head!==revision)fail(409,'准备期间源分支已变化，未应用陈旧候选');
      if(nativeWorldVersion(this.record(p,b,resource))!==expected)fail(409,'准备期间共享世界已变化');input.guard?.();
    };
    const verification=await this.validate(user,p,b,{...input,onProgress:job=>{operation.stage=job.stage;operation.game_build_id=job.id;operation.progress=job.progress;}});
    if(verification.status!=='passed')fail(422,'原生共享候选未通过实际运行，旧世界保持原发行',{verification});
    assertCurrent();const job=this.verifyBuild(this.store.get('creator_build',verification.game_build_id)),old=this.owner.worlds.get(key);
    if(old?.ready&&old.revision===revision&&old.game_build_id===job.id)return this.commitPublication(old,verification,input,{reused:true,same_process:true});
    let classification={compatible:false,updates:[]};
    if(old?.ready&&this.store.get('creator_build',old.game_build_id)?.runtime_source_hash===job.runtime_source_hash&&this.store.get('creator_build',old.game_build_id)?.build_policy_hash===job.build_policy_hash&&hash(this.store.get('creator_build',old.game_build_id)?.toolchain_identity)===hash(job.toolchain_identity)){
      const {classifyNativeSharedUpdate}=await import('./native-shared-project.mjs');
      classification=classifyNativeSharedUpdate(this.fixed(old.revision,p),this.fixed(revision,p),resource);
    }
    if(old?.ready&&classification.compatible){
      operation.stage='在当前权威进程应用兼容参数';
      const before={revision:old.revision,source_identity:old.source_identity,runtime_build_id:old.runtime_build_id,game_build_id:old.game_build_id,snapshot:clone(old.snapshot)};
      old.pendingRevision=revision;let committed=false,paused=false;
      try{
        assertCurrent();paused=true;const checkpoint=await this.owner.command(old,{type:'checkpoint',pause:true});if(!checkpoint.ok)fail(502,'原生权威未确认参数更新暂停');this.ingest(old,checkpoint.snapshot);
        const reply=await this.owner.command(old,{type:'apply_defaults',scene_revision:revision,source_identity:this.fixed(revision).source_identity,updates:classification.updates});
        if(!reply.ok)fail(422,reply.error??'原生参数候选被拒绝');
        validateNativeSnapshot(reply.snapshot,{...old,revision,source_identity:this.fixed(revision).source_identity});if(!this.fixed(revision).resources[reply.snapshot.resource_id])fail(502,'参数回执的实际关卡不属于固定工程');
        assertCurrent();
        Object.assign(old,{revision,source_identity:this.fixed(revision).source_identity,runtime_build_id:job.canonical_identity,game_build_id:job.id,snapshot:reply.snapshot});
        old.history.set(reply.snapshot.sequence,clone(reply.snapshot));const result=this.commitPublication(old,verification,input,{same_process:true,authority_pid:old.process.pid});committed=true;
        const resumed=await this.owner.command(old,{type:'resume'});if(!resumed.ok)throw Error('参数版本已提交，但权威未确认恢复运行');paused=false;this.ingest(old,resumed.snapshot,{notify:false});this.owner.persist(old);
        this.transferClients(old,{previous_epoch:old.epoch,previous_revision:before.revision,same_process:true});this.notifyPublication(old,result,input);return result;
      }catch(error){
        if(!committed){
          try{
            const observed=await this.owner.command(old,{type:'checkpoint',pause:false},10000);
            if(!observed.ok)throw Error('无法确认参数更新结果');
            let snapshot=observed.snapshot;
            if(snapshot.scene_revision===revision&&snapshot.source_identity===this.fixed(revision).source_identity){
              const rollback=await this.owner.command(old,{type:'apply_defaults',scene_revision:before.revision,source_identity:before.source_identity,updates:classification.updates.map(update=>({...update,value:update.previous,previous:update.value}))});
              if(!rollback.ok)throw Error(rollback.error??'权威拒绝恢复原参数');snapshot=rollback.snapshot;
            }
            validateNativeSnapshot(snapshot,{...old,revision:before.revision,source_identity:before.source_identity});
            Object.assign(old,{...before,snapshot});for(const [sequence,item]of old.history)if(item.scene_revision===revision&&revision!==before.revision)old.history.delete(sequence);old.history.set(snapshot.sequence,clone(snapshot));this.owner.persist(old);
          }catch(rollbackError){this.failed(old,Error('参数更新未提交且原状态无法确认：'+rollbackError.message),{kind:'precondition'});}
        }else this.failed(old,Error('已提交共享版本的运行恢复失败：'+error.message),{kind:'infrastructure'});throw error;
      }
      finally{delete old.pendingRevision;delete old.pendingSnapshot;if(paused&&!old.failed){try{const resumed=await this.owner.command(old,{type:'resume'});if(!resumed.ok)throw Error('权威未确认继续运行');this.ingest(old,resumed.snapshot,{notify:false});this.owner.persist(old);}catch(error){this.failed(old,error,{kind:'infrastructure'});}}}
    }
    operation.stage=old?.ready?'准备检查点与新权威实例':'启动原生共享权威';
    let candidate,checkpoint=clone(initial?.snapshot??{}),pausedOld=false;const audience=old?hash([...old.clients.keys()].sort()):null;
    const transition={id:id('world-transfer'),project_id:p,branch_id:b,resource_id:resource,from_world_id:initial?.id??null,from_revision:initial?.revision??null,to_revision:revision,game_build_id:job.id,status:'preparing',created_at:Date.now()};
    this.store.put('creator_world_transition',transition);
    try{
      assertCurrent();
      if(old?.ready){
        old.transitioning=true;pausedOld=true;const reply=await this.owner.command(old,{type:'checkpoint',pause:true});if(!reply.ok)fail(502,'旧权威未确认检查点暂停');
        checkpoint=this.ingest(old,reply.snapshot);old.snapshot=checkpoint;this.owner.persist(old);pausedOld=true;
      }
      transition.checkpoint=clone(checkpoint);transition.checkpoint_hash=hash(checkpoint);this.store.put('creator_world_transition',transition);
      candidate=await this.spawn(job,{worldId:initial?.id,epoch:(initial?.epoch??0)+1,state:checkpoint,paused:true,ephemeral:false,assertCurrent});
      assertCurrent();const resumed=await this.owner.command(candidate,{type:'resume'});if(!resumed.ok)fail(502,'候选权威未确认开始运行');
      this.ingest(candidate,resumed.snapshot,{notify:false});assertCurrent();
      if(old&&audience!==hash([...old.clients.keys()].sort()))fail(409,'切换期间玩家连接已变化，保留当前世界并重试更新');
      candidate.failure_history=[...(initial?.failure_history??[])];
      if(initial?.failure)candidate.failure_history.push(this.owner.archiveFailure(initial,initial.failure));
      transition.status='committed';transition.to_epoch=candidate.epoch;transition.applied_sequence=candidate.snapshot.sequence;transition.finished_at=Date.now();
      const result=this.commitPublication(candidate,verification,input,{same_process:false,transition_id:transition.id,authority_pid:candidate.process.pid},transition);
      candidate.activated=true;if(old){candidate.clients=old.clients;old.clients=new Map();old.activated=false;}this.owner.worlds.set(key,candidate);
      this.transferClients(candidate,{previous_epoch:initial?.epoch??null,previous_revision:initial?.revision??null,same_process:false});
      await this.retire(old);this.notifyPublication(candidate,result,input);return result;
    }catch(error){
      if(candidate?.activated&&this.owner.worlds.get(key)===candidate)throw error;
      await this.retire(candidate);
      if(pausedOld&&old&&!old.failed){
        const resumed=await this.owner.command(old,{type:'resume'});if(!resumed.ok){this.failed(old,Error('候选失败后旧权威未确认恢复'),{kind:'infrastructure'});}else{this.ingest(old,resumed.snapshot);this.owner.persist(old);}
      }
      Object.assign(transition,{status:'rolled_back',error:error.message,finished_at:Date.now()});this.store.put('creator_world_transition',transition);throw error;
    }finally{if(old)delete old.transitioning;}
  }
  commitPublication(world,verification,input,fields,transition=null){
    const delivery={id:id('delivery'),world_id:world.id,epoch:world.epoch,revision:world.revision,runtime_build_id:world.runtime_build_id,game_build_id:world.game_build_id,native_shared:true,applied_sequence:world.snapshot.sequence,verification_id:verification.id,created_at:Date.now(),...fields};
    const result={verification,delivery},publication=input.publication;
    if(!publication)throw Error('共享发布缺少请求身份');
    this.store.transaction(()=>{
      this.owner.persist(world);this.store.put('creator_delivery',delivery);
      if(transition)this.store.put('creator_world_transition',transition);
      this.store.put('creator_native_world_publication',{id:publication.requestKey,project_id:world.project_id,branch_id:world.branch_id,user_id:publication.user_id,request_id:publication.requestId,fingerprint:publication.fingerprint,result:clone(result),created_at:Date.now()});
    });return result;
  }
  notifyPublication(world,result,input){
    this.service.observe?.(()=>{this.service.deliveryFinished?.(result.delivery,input.origin);this.service.notices?.worldReady(world);});
  }
  transferClients(world,fields){
    for(const client of world.clients.values()){client.world_active=false;client.control_generation=null;client.world_barrier=null;client.last_input_seq=0;client.zeroInputs?.clear();}
    this.owner.broadcast(world,{action:'transfer',native_shared:true,...fields,manifest:this.clientManifest(world)});
  }
  clientManifest(world){return {runtime_build_id:world.runtime_build_id,game_build_id:world.game_build_id,source_revision:world.revision,resource_id:world.resource_id,current_scene_id:world.snapshot?.resource_id,scene_generation:world.snapshot?.scene_generation,world_id:world.id,epoch:world.epoch,native_shared:true};}
  async join(client,message){
    const scope=client.scope;
    if(!scope||scope.project_id!==message.project_id||scope.branch_id!==message.branch_id||scope.resource_id!==message.resource_id)fail(409,'请先订阅目标场景');
    this.store.branchFor(client.user,scope.project_id,scope.branch_id);
    const playable=this.playable(client.user,scope.project_id,scope.branch_id,scope.resource_id);
    if(message.source_revision!==playable.source_revision||message.runtime_build_id!==playable.runtime_build_id)fail(409,'共享世界版本已变化，请重新取得固定构建');
    const key=this.key(scope.project_id,scope.branch_id,scope.resource_id);
    let world=this.owner.worlds.get(key);
    if(!world?.ready){
      let preparation=this.owner.preparing.get(key);
      if(!preparation){preparation=this.start(client.user,scope.project_id,scope.branch_id,scope.resource_id).finally(()=>this.owner.preparing.delete(key));this.owner.preparing.set(key,preparation);}
      world=await preparation;
    }
    const current=()=>{this.store.branchFor(client.user,scope.project_id,scope.branch_id);if(client.scope!==scope||client.ws.readyState!==WebSocket.OPEN||this.owner.worlds.get(key)!==world||world.revision!==message.source_revision||world.runtime_build_id!==message.runtime_build_id)fail(409,'加入期间作用域或世界版本已变化');};
    current();if(world.pendingRevision||world.transitioning)fail(409,'共享世界正在切换版本，请稍后加入',{code:'native_world_updating'});world.joining??=new Map();
    if(world.joining.has(client.user.id)||[...world.clients.values()].some(other=>other.id!==client.id&&other.user.id===client.user.id))fail(409,'当前身份已在另一个窗口控制或准备此共享角色');
    world.joining.set(client.user.id,client.id);let joined=false;
    try{
      if(client.world_key&&client.world_key!==key)await this.owner.leave(client);current();
      if(!world.clients.has(client.id)||world.snapshot.players[client.user.id]?.online!==true){
        const reply=await this.owner.command(world,{type:'join',player_id:client.user.id,name:client.user.name,color:userColor(client.user)});if(!reply.ok)fail(422,reply.error??'共享角色加入失败');
        joined=true;current();if(reply.snapshot)this.ingest(world,reply.snapshot);
      }
      world.clients.set(client.id,client);client.world_key=key;client.world_scope=scope;client.world_active=false;client.control_generation=randomBytes(24).toString('base64url');client.last_input_seq=world.snapshot.players[client.user.id]?.last_input_seq??0;client.zeroInputs=new Set();client.inspection=null;
      const snapshot=clone(world.snapshot);world.history.set(snapshot.sequence,snapshot);client.world_barrier={sequence:snapshot.sequence,state_hash:hash(snapshot)};
      this.service.realtime.send(client,{type:'world',packet:{action:'join',native_shared:true,world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:snapshot.resource_id,scene_generation:snapshot.scene_generation,source_identity:world.source_identity,player_id:client.user.id,control_generation:client.control_generation,input_seq_base:client.last_input_seq,snapshot,state_hash:client.world_barrier.state_hash,scene:this.scene(client.user,world),manifest:this.clientManifest(world)}});
    }catch(error){if(joined&&!world.clients.has(client.id)){try{await this.owner.command(world,{type:'leave',player_id:client.user.id});}catch{}}throw error;}
    finally{world.joining.delete(client.user.id);}
  }
  async message(client,message){
    if(message.type==='world_join')return this.join(client,message);
    const world=this.owner.worlds.get(client.world_key);
    if(!world?.native_shared||!world.ready||!world.clients.has(client.id)||client.world_scope!==client.scope)fail(409,'尚未加入当前原生共享世界');
    this.store.branchFor(client.user,world.project_id,world.branch_id);
    if(message.type==='world_ready'){
      validateNativeReady(message,world,client);client.world_active=true;
      this.service.realtime.send(client,{type:'world',packet:{action:'active',native_shared:true,world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:world.snapshot.resource_id,scene_generation:world.snapshot.scene_generation,control_generation:client.control_generation,player_id:client.user.id,snapshot:clone(world.snapshot)}});return;
    }
    if(message.type==='world_input'){
      if(world.pendingRevision||world.transitioning)fail(409,'共享世界正在切换版本',{code:'native_world_updating'});
      const packet=validateNativeInput(message.input??message,world,client);client.last_input_seq=packet.input_seq;
      const reply=await this.owner.command(world,{type:'input',...packet},10000);
      if(!reply.ok)fail(422,reply.error??'原生权威拒绝玩法输入');
      if(this.owner.worlds.get(world.key)!==world||client.world_key!==world.key||client.control_generation!==(message.input??message).control_generation)fail(409,'输入确认期间控制权已变化');
      if(reply.snapshot){this.ingest(world,reply.snapshot);this.owner.persist(world);}
      if(!packet.inputs.length){client.zeroInputs.add(packet.input_seq);while(client.zeroInputs.size>64)client.zeroInputs.delete(client.zeroInputs.values().next().value);}
      this.service.realtime.send(client,{type:'world',packet:{action:'input_ack',native_shared:true,world_id:world.id,epoch:world.epoch,scene_revision:world.revision,input_seq:packet.input_seq,ok:true,snapshot:reply.snapshot??world.snapshot}});return;
    }
    fail(400,'未知原生共享世界命令');
  }
}
