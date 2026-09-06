import {digest} from '../control-plane/content.mjs';
import {releaseContent} from '../control-plane/assets.mjs';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,createWriteStream} from 'node:fs';
import {join} from 'node:path';

export class Worlds extends EventEmitter {
  constructor({store,root,data,port,godot}) {super();Object.assign(this,{store,root,data,port,godot});this.hosts=new Map();this.pending=new Map();this.chains=new Map();this.stopping=false;}
  async start(world) {
    if(this.hosts.has(world.id)) return this.waitReady(world.id);
    world=this.store.get('world',world.id);world.epoch++;world.status='starting';this.store.put('world',world);
    const key=randomUUID()+randomUUID();
    mkdirSync(join(this.data,'logs'),{recursive:true});
    const log=createWriteStream(join(this.data,'logs',world.id+'.log'),{flags:'a'});
    const release=this.store.get('release',world.release_id);
    const binary=join(this.root,'.local/artifacts',release.runtime_hash,release.authority_binary);
    const child=spawn(binary,['--headless','--','--role=authority',`--server=ws://127.0.0.1:${this.port}`,`--world=${world.id}`,`--host-key=${key}`],{stdio:['ignore','pipe','pipe']});
    const host={key,child,log,epoch:world.epoch,socket:null};this.hosts.set(world.id,host);
    child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
    child.on('error',e=>this.fail(world.id,e.message));
    child.on('close',(code,signal)=>{log.end();if(this.hosts.get(world.id)===host){this.hosts.delete(world.id);if(!this.stopping)this.fail(world.id,`Authority exited ${code??signal}`);}});
    try{return await this.waitReady(world.id);}catch(error){await this.stopHost(world.id);throw error;}
  }
  async recover(world) {
    const receipt=world.upgrade_id?this.store.get('upgrade',world.upgrade_id):null;
    let ready;
    try{ready=await this.start(world);}
    catch(error){
      if(!receipt||world.release_id===receipt.source_release)throw error;
      await this.stopHost(world.id);world=this.store.get('world',world.id);world.release_id=receipt.source_release;const checkpoint=this.store.get('checkpoint',receipt.checkpoint_id);if(!checkpoint||digest(checkpoint.state)!==checkpoint.state_hash)throw Error('Upgrade recovery checkpoint missing or corrupt');world.state=structuredClone(checkpoint.state);world.status='starting';this.store.put('world',world);
      receipt.error=error.message;
      try{ready=await this.start(world);}catch(recovery){receipt.status='recovery-required';receipt.recovery_error=recovery.message;this.store.put('upgrade',receipt);throw recovery;}
    }
    if(receipt&&['freezing','starting'].includes(receipt.status)){
      receipt.status=ready.release_id===receipt.target_release?'complete':'rolled-back';receipt.recovered_after_restart=true;receipt.target_epoch=ready.epoch;receipt.target_watermark=ready.durable_sequence;receipt.finished_at=Date.now();
      delete ready.upgrade_id;this.store.transaction(()=>{this.store.put('upgrade',receipt);this.store.put('world',ready);});
    }
    return ready;
  }
  waitReady(id,timeout=20000) {return new Promise((resolve,reject)=>{const start=Date.now();const t=setInterval(()=>{const w=this.store.get('world',id);if(w.status==='running'){clearInterval(t);resolve(w);}else if(w.status==='failed'||Date.now()-start>timeout){clearInterval(t);reject(Error(w.error??'Authority preparation timed out'));}},40);});}
  fail(id,error) {const w=this.store.get('world',id);if(!w)return;w.status='failed';w.error=error;this.store.put('world',w);this.emit('failure',{world_id:id,error});for(const [key,p] of this.pending)if(p.world_id===id){clearTimeout(p.timer);p.reject(Error(error));this.pending.delete(key);}}
  attach(socket,hello) {
    const h=this.hosts.get(hello.world_id);
    if(!h||hello.host_key!==h.key||h.socket) {socket.close(1008,'Invalid authority');return;}
    h.socket=socket;socket.world_id=hello.world_id;socket.authority_epoch=h.epoch;
    const w=this.store.get('world',hello.world_id),release=this.store.get('release',w.release_id),revision=this.store.get('revision',release.revision);
    socket.send(JSON.stringify({type:'init',world_id:w.id,epoch:w.epoch,release_id:w.release_id,content:releaseContent(this.data,release),state:w.state??null}));
    socket.on('close',()=>{if(this.hosts.get(w.id)===h&&!this.stopping)this.fail(w.id,'Authority connection lost');});
  }
  receive(socket,msg) {
    const w=this.store.get('world',socket.world_id),host=this.hosts.get(socket.world_id);
    if(!w||host?.socket!==socket||w.epoch!==socket.authority_epoch)return socket.close(1008,'Fenced authority');
    if(msg.type==='error')return this.fail(w.id,String(msg.error??'Authority initialization failed'));
    if(msg.type==='ready') {
      if(msg.release_id!==w.release_id)return this.fail(w.id,'Authority loaded incorrect release');
      if(msg.state){
        if(!msg.state.players||!Number.isFinite(msg.state.tick)||w.state&&msg.state.tick<w.state.tick)return this.fail(w.id,'Restored authority snapshot regressed');
        w.state=msg.state;w.sequence++;w.durable_sequence=w.sequence;w.updated_at=Date.now();
      }
      w.status='running';delete w.error;this.store.put('world',w);this.tasks(w.id);this.emit('ready',w);return;
    }
    if(msg.type==='runtime_fault'){
      if(msg.release_id&&msg.release_id!==w.release_id)return;
      w.health=w.previous_release?'recovering':'degraded';w.runtime_fault={error:msg.error??msg.fault?.error??'Behavior execution failed',asset_hash:msg.asset_hash??msg.fault?.asset_hash,at:Date.now()};this.store.put('world',w);
      this.store.event(w.project_id,{kind:'runtime_fault',title:w.runtime_fault.error,world_id:w.id,release_id:w.release_id});
      for(const task of this.store.list('task').filter(t=>t.project_id===w.project_id&&t.branch===w.branch&&['testing','delivered'].includes(t.status))){task.status='failed';task.error=w.runtime_fault.error;this.store.put('task',task);}
      this.tasks(w.id);this.emit('runtime_fault',w);
      const rejected=this.store.get('release',w.release_id);rejected.status='quarantined';rejected.runtime_error=w.runtime_fault.error;this.store.put('release',rejected);
      const fallback=this.store.get('release',w.previous_release);
      if(fallback&&fallback.id!==w.release_id&&fallback.status==='ready'){
        const failedRelease=w.release_id;
        this.apply(w.id,fallback).then(result=>{
          const actual=this.store.get('world',w.id);
          if(!result.ok){actual.health='degraded';this.store.put('world',actual);return;}
          actual.health='recovered';actual.failed_release=failedRelease;this.store.put('world',actual);
          const branch=this.store.get('branch',actual.project_id+':'+actual.branch);
          if(branch.playable_head===failedRelease){branch.playable_head=fallback.id;branch.publish_generation++;this.store.put('branch',branch);}
          this.store.event(actual.project_id,{kind:'runtime_rollback',title:'行为故障：已恢复上一发行，保留当前玩家进度',world_id:w.id,failed_release:failedRelease,release_id:fallback.id,sequence:result.sequence});
        }).catch(error=>{const actual=this.store.get('world',w.id);actual.health='degraded';actual.recovery_error=error.message;this.store.put('world',actual);});
      }
      return;
    }
    if(!['snapshot','result','applied','frozen'].includes(msg.type))return;
    const pending=msg.request_id?this.pending.get(msg.request_id):null;
    if(msg.type==='applied'&&msg.ok) {
      if(!pending||pending.release_id!==msg.release_id)return this.fail(w.id,'Unexpected content application');
      if(w.release_id!==msg.release_id)w.previous_release=w.release_id;
      w.release_id=msg.release_id;w.health='healthy';delete w.runtime_fault;
    }
    if(msg.state) {
      if(typeof msg.state!=='object'||!Number.isFinite(msg.state.tick)||!msg.state.players)return this.fail(w.id,'Invalid authority snapshot');
      if(w.state&&msg.state.tick<w.state.tick)return this.fail(w.id,'Authority snapshot regressed');
      w.state=msg.state;w.sequence=(w.sequence??0)+1;w.durable_sequence=w.sequence;w.updated_at=Date.now();
      this.store.put('world',w);
    }
    if(msg.type==='applied'&&msg.ok)this.emit('content',w);
    if(msg.state)this.emit('snapshot',w);
    if(pending) {clearTimeout(pending.timer);this.pending.delete(msg.request_id);pending.resolve({...msg,sequence:w.sequence});}
  }
  send(id,msg,extra={}) {
    const h=this.hosts.get(id),w=this.store.get('world',id);
    if(!h?.socket||h.socket.readyState!==1||w.status!=='running')return Promise.reject(Error('World is not ready'));
    const request_id=randomUUID();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(request_id);reject(Error('Authority response timed out; inspect operation status'));},10000);this.pending.set(request_id,{world_id:id,resolve,reject,timer,...extra});h.socket.send(JSON.stringify({...msg,request_id}));});
  }
  command(id,user_id,action,payload={},guard=()=>{}) {return this.serial(id,()=>{guard();return this.send(id,{type:'command',user_id,action,payload});});}
  serial(id,fn) {const p=(this.chains.get(id)??Promise.resolve()).catch(()=>{}).then(fn);this.chains.set(id,p);return p;}
  join(id,user) {const h=this.hosts.get(id);if(!h?.socket||h.socket.readyState!==1)throw Error('World is not ready');h.socket.send(JSON.stringify({type:'join',user_id:user.id,name:user.name}));}
  apply(id,release) {return this.serial(id,()=>this.send(id,{type:'apply_content',release_id:release.id,content:releaseContent(this.data,release)},{release_id:release.id}));}
  async stopHost(id) {
    const h=this.hosts.get(id);if(!h)return;
    // Remove the authority identity before closing its socket: late packets and
    // exit callbacks from this process can no longer mutate the new generation.
    this.hosts.delete(id);h.socket?.close();h.child.kill('SIGTERM');
    await new Promise(resolve=>{if(h.child.exitCode!==null)return resolve();const timer=setTimeout(()=>{h.child.kill('SIGKILL');resolve();},1500);h.child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
  sleep(id) {return this.serial(id,async()=>{
    let world=this.store.get('world',id);if(world.status==='sleeping')return {ok:true,world,sequence:world.durable_sequence};
    const final=await this.send(id,{type:'freeze'});if(!final.ok)throw Error(final.error??'World refused final checkpoint');
    world=this.store.get('world',id);world.status='sleeping';world.slept_at=Date.now();this.store.put('world',world);
    this.emit('sleeping',world);await this.stopHost(id);
    this.store.event(world.project_id,{kind:'world_sleep',title:'世界已保存最终检查点并休眠',world_id:id,sequence:world.durable_sequence});
    return {ok:true,world,sequence:world.durable_sequence};
  });}
  upgrade(id,release) {return this.serial(id,async()=>{
    let world=this.store.get('world',id);
    const previous=this.store.get('release',world.release_id);
    if(previous.runtime_hash===release.runtime_hash)return this.send(id,{type:'apply_content',release_id:release.id,content:releaseContent(this.data,release)},{release_id:release.id});
    if(release.status!=='ready'||release.schema!==previous.schema)throw Error('No declared compatible state schema for runtime upgrade');
    // Capture and persist a final snapshot only after the old Godot authority
    // has stopped all simulation. A periodic checkpoint is not a handoff fence.
    const receipt={id:'upgrade_'+randomUUID(),world_id:id,source_release:previous.id,target_release:release.id,status:'freezing',created_at:Date.now()};
    this.store.put('upgrade',receipt);
    let frozen;
    try{frozen=await this.send(id,{type:'freeze'});if(!frozen.ok)throw Error(frozen.error??'Authority refused final checkpoint');}
    catch(error){receipt.status='failed';receipt.error=error.message;this.store.put('upgrade',receipt);throw error;}
    world=this.store.get('world',id);
    const checkpoint={id:'checkpoint_'+randomUUID(),world_id:id,release_id:previous.id,epoch:world.epoch,sequence:world.durable_sequence,state:structuredClone(world.state),state_hash:digest(world.state),created_at:Date.now()};
    this.store.put('checkpoint',checkpoint);receipt.checkpoint_id=checkpoint.id;receipt.source_epoch=world.epoch;receipt.source_watermark=world.durable_sequence;receipt.status='starting';
    world.status='upgrading';world.upgrade_id=receipt.id;
    this.store.transaction(()=>{this.store.put('upgrade',receipt);this.store.put('world',world);});
    this.emit('upgrading',world);
    await this.stopHost(id);
    world.release_id=release.id;world.previous_release=previous.id;this.store.put('world',world);
    try{
      await this.start(world);world=this.store.get('world',id);receipt.status='complete';receipt.target_epoch=world.epoch;receipt.target_watermark=world.durable_sequence;receipt.finished_at=Date.now();world.health='healthy';delete world.upgrade_id;
      this.store.transaction(()=>{this.store.put('upgrade',receipt);this.store.put('world',world);});
      this.store.event(world.project_id,{kind:'runtime_upgraded',title:'匹配的新客户端已就绪，世界从最终检查点接续',world_id:id,upgrade_id:receipt.id,release_id:release.id});
      this.emit('runtime_upgrade',world);return {ok:true,sequence:world.sequence,upgrade:receipt,requires_client_upgrade:true};
    }catch(error){
      // Candidate startup failed after the fence: resume the exact old release
      // at a NEW epoch, preserving the final durable world checkpoint.
      await this.stopHost(id);world=this.store.get('world',id);world.release_id=previous.id;world.state=structuredClone(checkpoint.state);world.status='starting';this.store.put('world',world);
      receipt.error=error.message;
      try{await this.start(world);receipt.status='rolled-back';world=this.store.get('world',id);delete world.upgrade_id;world.health='recovered';this.store.put('world',world);this.emit('runtime_upgrade',world);}
      catch(recovery){receipt.status='recovery-required';receipt.recovery_error=recovery.message;}
      receipt.finished_at=Date.now();this.store.put('upgrade',receipt);throw Error('Runtime upgrade failed: '+error.message+'; '+receipt.status);
    }
  });}
  leave(id,user_id) {const h=this.hosts.get(id);if(h?.socket?.readyState===1)h.socket.send(JSON.stringify({type:'leave',user_id}));}
  tasks(id) {const w=this.store.get('world',id),h=this.hosts.get(id);if(!w||!h?.socket||h.socket.readyState!==1)return;h.socket.send(JSON.stringify({type:'tasks',tasks:this.store.list('task').filter(t=>t.project_id===w.project_id&&t.branch===w.branch)}));}
  async stop() {this.stopping=true;const children=[...this.hosts.values()];for(const h of children){h.socket?.close();h.child.kill('SIGTERM');}await Promise.all(children.map(h=>new Promise(r=>{if(h.child.exitCode!==null)return r();h.child.once('exit',r);setTimeout(()=>{h.child.kill('SIGKILL');r();},1500).unref();})));}
}
