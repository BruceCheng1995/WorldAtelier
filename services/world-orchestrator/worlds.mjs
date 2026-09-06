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
    child.stdout.pipe(log);child.stderr.pipe(log);
    child.on('error',e=>this.fail(world.id,e.message));
    child.on('exit',(code,signal)=>{log.end();if(this.hosts.get(world.id)===host){this.hosts.delete(world.id);if(!this.stopping)this.fail(world.id,`Authority exited ${code??signal}`);}});
    return this.waitReady(world.id);
  }
  waitReady(id,timeout=20000) {return new Promise((resolve,reject)=>{const start=Date.now();const t=setInterval(()=>{const w=this.store.get('world',id);if(w.status==='running'){clearInterval(t);resolve(w);}else if(w.status==='failed'||Date.now()-start>timeout){clearInterval(t);reject(Error(w.error??'Authority preparation timed out'));}},40);});}
  fail(id,error) {const w=this.store.get('world',id);if(!w)return;w.status='failed';w.error=error;this.store.put('world',w);this.emit('failure',{world_id:id,error});for(const [key,p] of this.pending)if(p.world_id===id){clearTimeout(p.timer);p.reject(Error(error));this.pending.delete(key);}}
  attach(socket,hello) {
    const h=this.hosts.get(hello.world_id);
    if(!h||hello.host_key!==h.key||h.socket) {socket.close(1008,'Invalid authority');return;}
    h.socket=socket;socket.world_id=hello.world_id;socket.authority_epoch=h.epoch;
    const w=this.store.get('world',hello.world_id),release=this.store.get('release',w.release_id),revision=this.store.get('revision',release.revision);
    socket.send(JSON.stringify({type:'init',world_id:w.id,epoch:w.epoch,release_id:w.release_id,content:revision.content,state:w.state??null}));
    socket.on('close',()=>{if(this.hosts.get(w.id)===h&&!this.stopping)this.fail(w.id,'Authority connection lost');});
  }
  receive(socket,msg) {
    const w=this.store.get('world',socket.world_id),host=this.hosts.get(socket.world_id);
    if(!w||host?.socket!==socket||w.epoch!==socket.authority_epoch)return socket.close(1008,'Fenced authority');
    if(msg.type==='ready') {
      if(msg.release_id!==w.release_id)return this.fail(w.id,'Authority loaded incorrect release');
      w.status='running';delete w.error;this.store.put('world',w);this.tasks(w.id);this.emit('ready',w);return;
    }
    if(!['snapshot','result','applied'].includes(msg.type))return;
    const pending=msg.request_id?this.pending.get(msg.request_id):null;
    if(msg.type==='applied'&&msg.ok) {
      if(!pending||pending.release_id!==msg.release_id)return this.fail(w.id,'Unexpected content application');
      w.release_id=msg.release_id;
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
  command(id,user_id,action,payload={}) {return this.serial(id,()=>this.send(id,{type:'command',user_id,action,payload}));}
  serial(id,fn) {const p=(this.chains.get(id)??Promise.resolve()).catch(()=>{}).then(fn);this.chains.set(id,p);return p;}
  join(id,user) {const h=this.hosts.get(id);if(!h?.socket||h.socket.readyState!==1)throw Error('World is not ready');h.socket.send(JSON.stringify({type:'join',user_id:user.id,name:user.name}));}
  apply(id,release) {return this.serial(id,()=>this.send(id,{type:'apply_content',release_id:release.id,content:this.store.get('revision',release.revision).content},{release_id:release.id}));}
  tasks(id) {const w=this.store.get('world',id),h=this.hosts.get(id);if(!w||!h?.socket||h.socket.readyState!==1)return;h.socket.send(JSON.stringify({type:'tasks',tasks:this.store.list('task').filter(t=>t.project_id===w.project_id&&t.branch===w.branch)}));}
  async stop() {this.stopping=true;const children=[...this.hosts.values()];for(const h of children){h.socket?.close();h.child.kill('SIGTERM');}await Promise.all(children.map(h=>new Promise(r=>{if(h.child.exitCode!==null)return r();h.child.once('exit',r);setTimeout(()=>{h.child.kill('SIGKILL');r();},1500).unref();})));}
}
