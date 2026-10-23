import {randomBytes} from 'node:crypto';
import {createReadStream,lstatSync,realpathSync,readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {WebSocket,WebSocketServer} from 'ws';
import {clone,fail,hash,id} from './schema.mjs';
import {createFileIdentityCache} from './file-identity.mjs';
import {validateNativeReady} from './native-world-protocol.mjs';
import {userColor} from '../../apps/creation-workspace/client-platform.js';

const CHECKOUT='creator_native_client_checkout',TICKET='creator_native_client_ticket',TRANSFER='creator_client_transfer';
const fileIdentity=createFileIdentityCache();
const fixedFields=['project_id','branch_id','resource_id','source_revision','runtime_build_id','game_build_id','world_id'];
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'});res.end(JSON.stringify(value));};
const validRequest=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(value);
const readJson=async req=>{let size=0,parts=[];for await(const part of req){size+=part.length;if(size>32768)fail(413,'客户端请求过大');parts.push(part);}try{return JSON.parse(Buffer.concat(parts).toString()||'{}');}catch{fail(400,'JSON 格式无效');}};

/** Fixed native display projects and a game-only transport. Creator credentials
 * stay in the launcher; the Godot process never receives a creator login token. */
export class NativeClients{
  constructor({service,server}){
    this.service=service;this.store=service.store;this.clients=new Map();this.ticketClients=new Map();this.pending=new Set();this.closed=false;
    this.wss=new WebSocketServer({noServer:true,maxPayload:64*1024});
    server.on('upgrade',(req,socket,head)=>{
      if(new URL(req.url,'http://localhost').pathname!=='/ws/native-client')return;
      const origin=service.requestOrigin?.(req);
      if(this.closed||!origin||req.headers.origin&&req.headers.origin!==origin){socket.destroy();return;}
      this.wss.handleUpgrade(req,socket,head,ws=>this.connect(ws,origin));
    });
    for(const transfer of this.store.list(TRANSFER))if(['preparing','fencing','synchronizing','activating','active','restoring_previous'].includes(transfer.status))this.store.put(TRANSFER,{...transfer,status:'interrupted',error:'服务重启，需重新解析当前世界并接续',updated_at:Date.now()});
    this.timer=setInterval(()=>{for(const client of this.clients.values())if(Date.now()-client.last_seen>35000)client.ws.close(1001,'Heartbeat expired');},5000);this.timer.unref();
  }
  owner(){if(!this.service.worlds?.native)fail(503,'原生共享世界服务尚未就绪');return this.service.worlds;}
  controlVersion(worldId,userId){return this.store.get('creator_player_control_version',hash([worldId,userId]))?.version??0;}
  advanceControl(world,userId,clientId,reason){
    const key=hash([world.id,userId]),previous=this.store.get('creator_player_control_version',key);
    const value={id:key,world_id:world.id,user_id:userId,version:(previous?.version??0)+1,client_id:clientId,epoch:world.epoch,source_revision:world.revision,reason,updated_at:Date.now()};this.store.put('creator_player_control_version',value);return value.version;
  }
  checkout(user,input){
    if(!validRequest(input.request_id)||!input.project_id||!input.branch_id||!input.resource_id)fail(400,'客户端接续需要明确游戏、分支和场景');
    this.store.branchFor(user,input.project_id,input.branch_id,true);
    const owner=this.owner(),playable=owner.native.playable(user,input.project_id,input.branch_id,input.resource_id),key=hash([user.id,input.request_id]),fingerprint=hash(input);
    const existing=this.store.get('creator_native_client_request',key);
    if(existing){if(existing.fingerprint!==fingerprint)fail(409,'相同接续请求不能更改目标');return this.view(user,existing.checkout_id);}
    const job=this.service.builds.forUser(user,playable.game_build_id);
    if(job.purpose!=='native_shared'||job.status!=='completed'||!job.source_files?.length)fail(409,'共享世界没有固定原生显示工程');
    if(job.native_shared?.native_client_protocol!==1)fail(422,'此固定共享版本尚未包含本机接续协议，请拥有者明确更新共享世界；现有 Web 运行和世界进度保留');
    const world=owner.native.record(input.project_id,input.branch_id,input.resource_id);
    const previous=[...(world?.clients?.values()??[])].find(client=>client.user.id===user.id);
    const record={id:id('native-checkout'),user_id:user.id,project_id:input.project_id,branch_id:input.branch_id,...playable,
      expected_previous_client:previous?.id??null,controller_version:this.controlVersion(world.id,user.id),source_identity:world.source_identity,files:clone(job.source_files),manifest_hash:hash(job.source_files),created_at:Date.now(),status:'downloadable',engine:job.engine??'4.6.stable',engine_identity:clone(job.toolchain_identity?.godot??null),engine_bundle:clone(job.toolchain_identity?.godot_bundle??null)};
    this.store.transaction(()=>{this.store.put(CHECKOUT,record);this.store.put('creator_native_client_request',{id:key,fingerprint,checkout_id:record.id});});
    return this.view(user,record.id);
  }
  get(user,checkoutId){
    const value=this.store.get(CHECKOUT,checkoutId);if(!value||value.user_id!==user.id)fail(404,'客户端准备记录不存在');
    this.store.branchFor(user,value.project_id,value.branch_id,true);return value;
  }
  view(user,checkoutId){const value=this.get(user,checkoutId);return {...clone(value),protocol:'wa-native-client-1',entry:'project.godot',source_authority:'fixed-canonical-native-shared-display',gameplay:'central_shared_authority',file_base:`/creation-api/native-clients/checkouts/${value.id}/files/`,transfer:this.store.get(TRANSFER,value.id)??null};}
  access(user,checkoutId,req){
    const value=this.get(user,checkoutId),current=this.owner().native.playable(user,value.project_id,value.branch_id,value.resource_id);
    if(value.controller_version!==this.controlVersion(value.world_id,user.id)||this.store.get(TRANSFER,checkoutId))fail(409,'此准备意图已使用或控制代次已变化，请重新解析客户端');
    if(fixedFields.some(field=>value[field]!==undefined&&current[field]!==undefined&&value[field]!==current[field]))fail(409,'下载期间共享世界已更新，请重新解析客户端');
    const loginToken=String(req.headers.authorization??'').replace(/^Bearer /,'');if(this.store.authenticate(loginToken).id!==user.id)fail(403,'接续授权需要当前登录');
    const ticket=randomBytes(32).toString('base64url'),record={id:hash(ticket),checkout_id:checkoutId,user_id:user.id,login_id:hash(loginToken),created_at:Date.now(),expires_at:Date.now()+15*60*1000};
    this.store.put(TICKET,record);
    const origin=this.service.requestOrigin(req);if(!origin)fail(403,'客户端地址无效');
    return {protocol:'wa-native-client-1',ticket,expires_at:record.expires_at,websocket_url:origin.replace(/^http/,'ws')+'/ws/native-client',checkout:this.view(user,checkoutId)};
  }
  file(user,checkoutId,path,req,res){
    const value=this.get(user,checkoutId);this.service.builds.forUser(user,value.game_build_id);
    const entry=value.files.find(file=>file.path===path);if(!entry)fail(404,'文件不在固定客户端清单中');
    const root=realpathSync(join(this.service.builds.directory,value.game_build_id,'project')),file=resolve(root,path);
    if(!file.startsWith(root+sep)||!realpathSync(file).startsWith(root+sep)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())fail(409,'固定客户端路径无效');
    const fixed=fileIdentity(file);if(fixed.sha256!==entry.sha256||fixed.size!==entry.size)fail(409,'固定客户端文件发生变化，拒绝下载');
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':entry.size,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
  }
  authenticate(client){
    const ticket=this.store.get(TICKET,client.native_ticket_id),checkout=ticket&&this.store.get(CHECKOUT,ticket.checkout_id),login=ticket&&this.store.get('creator_login',ticket.login_id);
    if(!ticket||ticket.revoked_at||!checkout||!login||login.expires_at<=Date.now()||login.user_id!==ticket.user_id||checkout.user_id!==ticket.user_id||ticket.expires_at<=Date.now())fail(403,'客户端登录授权已失效');
    const user=this.store.get('creator_user',ticket.user_id);this.store.projectFor(user,checkout.project_id);return this.store.publicUser(user);
  }
  send(client,packet){if(client.ws.readyState===WebSocket.OPEN)client.ws.send(JSON.stringify(packet));}
  rejectFencedInput(client,input){
    const handoff=this.clients.get(client.handoff_target_client);
    if(client.world_active||!client.world||!client.native_control_transferred&&!(handoff?.world===client.world&&(['fencing','synchronizing','activating'].includes(handoff.phase)||handoff.rolling_back)))return false;
    this.send(client,{type:'world',packet:{action:'input_ack',native_shared:true,ok:false,code:client.native_control_transferred?'CONTROL_TRANSFERRED':'CONTROL_FENCED',world_id:client.world.id,epoch:client.world.epoch,scene_revision:client.world.revision,...(Number.isSafeInteger(input?.input_seq)?{input_seq:input.input_seq}:{}),error:'此输入的控制代次已封口，等待当前接续结果'}});return true;
  }
  connect(ws,origin){
    const client={id:id('native-peer'),ws,origin,last_seen:Date.now(),world_active:false,scope:null,phase:'hello'};this.clients.set(client.id,client);
    client.timer=setTimeout(()=>ws.close(1008,'Client preparation timed out'),90000);
    let tail=Promise.resolve();
    ws.on('message',bytes=>{tail=tail.then(async()=>{
      if(ws.readyState!==WebSocket.OPEN)return;const message=JSON.parse(bytes.toString());client.last_seen=Date.now();
      if(client.phase==='hello')return this.hello(client,message);
      client.user=this.authenticate(client);
      if(message.type==='ping'){
        const ticket=this.store.get(TICKET,client.native_ticket_id);ticket.expires_at=Date.now()+15*60*1000;this.store.put(TICKET,ticket);this.send(client,{type:'pong'});return;
      }
      if(message.type==='native_ready')return this.ready(client,message.packet);
      if(message.type==='active_applied')return this.confirmActive(client,message.packet);
      if(message.type==='world_input'&&client.phase==='active'){
        // A real input can arrive before the fence and finish after it. Both
        // boundaries keep the old endpoint recoverable; other errors propagate.
        if(this.rejectFencedInput(client,message.input))return;
        try{return await this.owner().native.message(client,{type:'world_input',input:message.input});}
        catch(error){if(error.status===409&&this.rejectFencedInput(client,message.input))return;throw error;}
      }
      if(message.type==='applied'&&client.phase==='active')return; // Display progress is not a control grant.
      fail(403,'客户端票据不允许此操作');
    }).catch(async error=>{this.send(client,{type:'native_client_error',error:String(error.message).slice(0,800),status:error.status??400});if(client.phase!=='active'){await this.rollback(client,error.message);ws.close(1008,'Preparation failed');}});});
    ws.on('close',()=>{clearTimeout(client.timer);client.closing=true;const finished=tail.finally(()=>this.disconnected(client)).catch(()=>{});this.pending.add(finished);void finished.finally(()=>{this.pending.delete(finished);this.clients.delete(client.id);if(client.native_ticket_id){this.ticketClients.delete(client.native_ticket_id);const ticket=this.store.get(TICKET,client.native_ticket_id);if(ticket)this.store.put(TICKET,{...ticket,revoked_at:Date.now()});}});});
    ws.on('error',()=>{});
  }
  async hello(client,message){
    if(message.type!=='hello'||typeof message.ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(message.ticket))fail(403,'缺少原生游戏接续票据');
    const ticket=this.store.get(TICKET,hash(message.ticket));if(!ticket||ticket.consumed_at||ticket.revoked_at||this.ticketClients.has(ticket.id))fail(403,'接续票据无效或已被另一个连接使用');
    client.native_ticket_id=ticket.id;client.user=this.authenticate(client);const checkout=this.get(client.user,ticket.checkout_id);
    if(checkout.controller_version!==this.controlVersion(checkout.world_id,client.user.id)||this.store.get(TRANSFER,checkout.id))fail(409,'准备期间角色控制代次已变化，请重新解析客户端');
    if(message.runtime_build_id!==checkout.runtime_build_id||message.source_revision!==checkout.source_revision||message.source_identity!==checkout.source_identity)fail(409,'原生客户端实际加载的工程与固定清单不一致');
    this.store.put(TICKET,{...ticket,consumed_at:Date.now(),connection_id:client.id});this.ticketClients.set(ticket.id,client.id);client.checkout=checkout;
    client.scope={project_id:checkout.project_id,branch_id:checkout.branch_id,resource_id:checkout.resource_id,generation:1};
    const owner=this.owner(),key=owner.native.key(checkout.project_id,checkout.branch_id,checkout.resource_id);
    let world=owner.worlds.get(key);if(!world?.ready){
      let preparing=owner.preparing.get(key);if(!preparing){preparing=owner.native.start(client.user,checkout.project_id,checkout.branch_id,checkout.resource_id).finally(()=>owner.preparing.delete(key));owner.preparing.set(key,preparing);}world=await preparing;
    }
    this.assertWorld(client,world);
    const previous=[...world.clients.values()].find(other=>other.user.id===client.user.id);
    if(previous&&checkout.expected_previous_client!==previous.id)fail(409,'准备期间角色已经换到其他客户端，请重新发起接续');
    world.joining??=new Map();if(world.joining.has(client.user.id))fail(409,'此角色已有另一个接续请求');world.joining.set(client.user.id,client.id);
    client.world=world;client.previous=previous??null;client.phase='preparing';client.control_generation=randomBytes(24).toString('base64url');
    this.transition(client,'preparing');this.baseline(client,{standby:true});
  }
  assertWorld(client,world=client.world){
    const checkout=client.checkout;this.authenticate(client);
    if(client.phase!=='active'&&checkout.controller_version!==this.controlVersion(checkout.world_id,client.user.id))fail(409,'角色控制代次已改变，旧准备意图不能接管');
    if(client.ws.readyState!==WebSocket.OPEN||!world||!world.ready||world.failed||world.pendingRevision||world.transitioning||this.owner().worlds.get(world.key)!==world||world.id!==checkout.world_id||world.revision!==checkout.source_revision||world.runtime_build_id!==checkout.runtime_build_id)fail(409,'连接或共享世界在准备期间改变，请重新解析后接续');
  }
  transition(client,status,fields={}){
    const previous=this.store.get(TRANSFER,client.checkout.id);
    const record={...previous,id:client.checkout.id,user_id:client.user.id,project_id:client.checkout.project_id,branch_id:client.checkout.branch_id,world_id:client.world?.id,epoch:client.world?.epoch,source_revision:client.checkout.source_revision,runtime_build_id:client.checkout.runtime_build_id,previous_client_id:client.previous?.id??null,new_client_id:client.id,status,updated_at:Date.now(),...fields};
    this.store.put(TRANSFER,record);return record;
  }
  baseline(client,{standby=false}={}){
    const world=client.world,snapshot=clone(world.snapshot);world.history.set(snapshot.sequence,snapshot);
    client.world_barrier={sequence:snapshot.sequence,state_hash:hash(snapshot),resource_id:snapshot.resource_id,scene_generation:snapshot.scene_generation};
    this.send(client,{type:'world',packet:{action:'join',native_shared:true,native_client_phase:standby?'prepare':'commit',world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:snapshot.resource_id,scene_generation:snapshot.scene_generation,source_identity:world.source_identity,player_id:client.user.id,control_generation:client.control_generation,input_seq_base:snapshot.players[client.user.id]?.last_input_seq??0,snapshot,state_hash:client.world_barrier.state_hash,scene:this.owner().native.scene(client.user,world),manifest:this.owner().native.clientManifest(world)}});
  }
  verifyPrepared(client,packet){
    const world=client.world,barrier=client.world_barrier;
    for(const [field,value]of Object.entries({world_id:world.id,epoch:world.epoch,scene_revision:world.revision,source_identity:world.source_identity,control_generation:client.control_generation,sequence:barrier.sequence,state_hash:barrier.state_hash,resource_id:barrier.resource_id,scene_generation:barrier.scene_generation}))if(packet?.[field]!==value)fail(409,'客户端没有实际确认对应准备基线',{field});
  }
  async ready(client,packet){
    this.assertWorld(client);this.verifyPrepared(client,packet);
    const owner=this.owner(),world=client.world;
    if(client.phase==='active'){
      validateNativeReady(packet,world,client);client.world_active=false;
      this.sendActive(client);return;
    }
    if(client.phase==='preparing'){
      const old=client.previous,current=[...world.clients.values()].find(other=>other.user.id===client.user.id);
      if(current&&current!==old)fail(409,'角色控制者在准备期间改变');
      client.phase='fencing';this.transition(client,'fencing');
      if(old&&world.clients.get(old.id)===old){
        old.handoff_target_client=client.id;
        old.world_active=false;old.control_generation=null;
        owner.service.realtime.send(old,{type:'world',packet:{action:'control_pending',native_shared:true,world_id:world.id,epoch:world.epoch,scene_revision:world.revision}});
        if(world.snapshot.players[client.user.id]?.online===true){
          const sequence=Math.max(old.last_input_seq??0,world.snapshot.players[client.user.id]?.last_input_seq??0)+1;
          old.last_input_seq=sequence;
          const reply=await owner.command(world,{type:'input',world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:world.snapshot.resource_id,scene_generation:world.snapshot.scene_generation,player_id:client.user.id,input_seq:sequence,inputs:[]});
          if(!reply.ok||reply.input_seq!==sequence||!reply.snapshot||reply.snapshot.players[client.user.id]?.last_input_seq!==sequence)fail(502,'原生权威未确认旧输入封口');
          owner.native.ingest(world,reply.snapshot);owner.persist(world);client.stop_input_seq=sequence;
        }else{
          // Restored authorities intentionally mark players offline even while
          // old display sockets remain. Establish actual presence in this epoch.
          const reply=await owner.command(world,{type:'join',player_id:client.user.id,name:client.user.name,color:userColor(client.user)});
          if(!reply.ok||!reply.snapshot||reply.snapshot.players[client.user.id]?.online!==true)fail(502,'新权威未确认角色接续');
          owner.native.ingest(world,reply.snapshot);owner.persist(world);client.created_player=true;
        }
      }else{
        // A previous leave may still be in flight. A real ordered join, rather
        // than a stale snapshot's online flag, establishes this new presence.
        const reply=await owner.command(world,{type:'join',player_id:client.user.id,name:client.user.name,color:userColor(client.user)});
        if(!reply.ok||!reply.snapshot)fail(502,reply.error??'原生权威未确认角色加入');
        owner.native.ingest(world,reply.snapshot);owner.persist(world);client.created_player=true;
      }
      this.assertWorld(client);client.phase='synchronizing';client.control_generation=randomBytes(24).toString('base64url');
      this.transition(client,'synchronizing',{stop_input_seq:client.stop_input_seq??null,fenced_sequence:world.snapshot.sequence});this.baseline(client);return;
    }
    if(client.phase!=='synchronizing')fail(409,'没有待接管的客户端基线');
    client.world_key=world.key;client.world_scope=client.scope;client.native_runtime_build_id=world.runtime_build_id;
    try{validateNativeReady(packet,world,client);}catch(error){
      client.world_key=null;client.world_scope=null;
      if((client.resyncs??0)<3&&packet.scene_generation!==world.snapshot.scene_generation){client.resyncs=(client.resyncs??0)+1;this.baseline(client);return;}
      throw error;
    }
    // Keep the old fenced endpoint recoverable until the real native runtime
    // acknowledges the control message. An undelivered grant is not success.
    this.transition(client,'activating',{applied_sequence:packet.sequence,state_hash:packet.state_hash,control_generation:client.control_generation});
    world.clients.set(client.id,client);client.last_input_seq=world.snapshot.players[client.user.id]?.last_input_seq??0;client.zeroInputs=new Set();client.world_active=false;client.phase='activating';
    this.sendActive(client);
  }
  confirmActive(client,packet){
    this.assertWorld(client);
    if(!['activating','active'].includes(client.phase))fail(409,'没有待确认的控制权交接');
    this.verifyPrepared(client,packet);validateNativeReady(packet,client.world,client);
    if(client.phase==='activating'){
      const world=client.world,old=client.previous;
      this.store.transaction(()=>{
        const version=this.advanceControl(world,client.user.id,client.id,'native_handoff');
        this.transition(client,'active',{control_confirmed_at:Date.now(),controller_version:version});client.controller_version=version;
      });
      if(old&&world.clients.get(old.id)===old){world.clients.delete(old.id);old.world_key=null;old.world_scope=null;old.world_active=false;old.control_generation=null;old.world_barrier=null;old.native_control_transferred=true;delete old.handoff_target_client;}
      client.world_active=true;client.phase='active';world.joining.delete(client.user.id);clearTimeout(client.timer);
      if(old)this.service.realtime.send(old,{type:'world',packet:{action:'control_transferred',native_shared:true,world_id:world.id,epoch:world.epoch,scene_revision:world.revision,transfer_id:client.checkout.id}});
    }
    client.world_active=true;this.recovered(client);
    this.sendActive(client,true);
  }
  sendActive(client,confirmed=false){const world=client.world;this.send(client,{type:'world',packet:{action:confirmed?'control_confirmed':'active',native_shared:true,world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:world.snapshot.resource_id,scene_generation:world.snapshot.scene_generation,control_generation:client.control_generation,player_id:client.user.id,sequence:client.world_barrier.sequence,state_hash:client.world_barrier.state_hash,source_identity:world.source_identity,snapshot:clone(world.snapshot)}});}
  holdPlayerOnLeave(previous,world){
    if(previous.pending_restore_transfer_id){
      const recovery=this.store.get(TRANSFER,previous.pending_restore_transfer_id);
      if(recovery?.status==='restoring_previous')this.store.put(TRANSFER,{...recovery,status:'failed',recovery_error:'旧客户端在实际恢复控制之前离开；共享进度保留，请重新接续',updated_at:Date.now()});
      delete previous.pending_restore_transfer_id;
    }
    const target=this.clients.get(previous.handoff_target_client);
    if(target&&target.world===world&&(['fencing','synchronizing','activating'].includes(target.phase)||target.rolling_back)){
      target.previous_departed=true;return true;
    }
    return false;
  }
  recovered(client){
    const transferId=client.pending_restore_transfer_id;if(!transferId||!client.world_active)return;
    const transfer=this.store.get(TRANSFER,transferId);if(transfer?.status==='restoring_previous')this.store.put(TRANSFER,{...transfer,status:'failed_recovered',recovered_sequence:client.world_barrier?.sequence,updated_at:Date.now()});delete client.pending_restore_transfer_id;
  }
  async rollback(client,reason){
    if(!client.checkout||!client.world||client.phase==='active'||client.phase==='failed')return;
    const world=client.world,old=client.previous,phase=client.phase;client.rolling_back=true;client.phase='failed';world.joining?.delete(client.user?.id);
    if(world.clients.get(client.id)===client)world.clients.delete(client.id);
    let restored=false;
    if(['fencing','synchronizing','activating'].includes(phase)&&old?.ws.readyState===WebSocket.OPEN&&old.native_runtime_build_id===world.runtime_build_id&&this.owner().worlds.get(world.key)===world&&world.ready&&!world.pendingRevision&&!world.transitioning&&world.clients.get(old.id)===old){
      try{
        if(old.native_ticket_id)this.authenticate(old);else this.store.authenticate(old.token);
        this.store.branchFor(old.user,world.project_id,world.branch_id);
        old.controller_version=this.advanceControl(world,old.user.id,old.id,'handoff_recovery');old.control_generation=randomBytes(24).toString('base64url');old.world_active=false;old.world_key=world.key;old.world_scope=old.scope;
        delete old.handoff_target_client;
        const snapshot=clone(world.snapshot);old.world_barrier={sequence:snapshot.sequence,state_hash:hash(snapshot),resource_id:snapshot.resource_id,scene_generation:snapshot.scene_generation};old.last_input_seq=snapshot.players[old.user.id]?.last_input_seq??0;old.zeroInputs=new Set();old.pending_restore_transfer_id=client.checkout.id;world.history.set(snapshot.sequence,snapshot);
        this.service.realtime.send(old,{type:'world',packet:{action:'join',control_restore:true,native_shared:true,world_id:world.id,epoch:world.epoch,scene_revision:world.revision,resource_id:snapshot.resource_id,scene_generation:snapshot.scene_generation,source_identity:world.source_identity,player_id:old.user.id,control_generation:old.control_generation,input_seq_base:old.last_input_seq,snapshot,state_hash:old.world_barrier.state_hash,scene:this.owner().native.scene(old.user,world),manifest:this.owner().native.clientManifest(world)}});restored=true;
      }catch{}
    }
    if(!restored&&(client.created_player||client.previous_departed||['fencing','synchronizing','activating'].includes(phase))){
      if(old&&world.clients.get(old.id)===old&&!old.world_active){world.clients.delete(old.id);old.world_key=null;old.world_scope=null;delete old.handoff_target_client;}
      const controlling=[...world.clients.values()].some(value=>value.user.id===client.user.id&&value.ws.readyState===WebSocket.OPEN);
      if(!controlling)try{const reply=await this.owner().command(world,{type:'leave',player_id:client.user.id});if(reply.snapshot&&this.owner().worlds.get(world.key)===world){this.owner().native.ingest(world,reply.snapshot);this.owner().persist(world);}}catch{}
      if(old?.ws.readyState===WebSocket.OPEN)this.service.realtime.send(old,{type:'world',packet:{action:'error',native_shared:true,world_id:world.id,epoch:world.epoch,scene_revision:world.revision,error:'客户端接续未完成，请重新进入当前共享版本；世界进度保留'}});
    }
    this.transition(client,restored?'restoring_previous':'failed',{error:String(reason).slice(0,800),previous_recovery_requested:restored});
    client.rolling_back=false;
  }
  async disconnected(client){
    if(client.phase==='active'){
      await this.owner().leave(client);this.transition(client,'disconnected');
    }else await this.rollback(client,'目标客户端连接中断，未确认接续');
  }
  async request(user,req,res,url){
    if(!url.pathname.startsWith('/creation-api/native-clients/'))return false;
    const parts=url.pathname.slice('/creation-api/native-clients/'.length).split('/').map(decodeURIComponent);
    if(parts[0]==='client.mjs'&&parts.length===1&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'private, no-store','Content-Disposition':'attachment; filename="world-atelier-native-client.mjs"'});res.end(readFileSync(join(this.service.root,'tools/native-client.mjs')));return true;
    }
    if(parts[0]!=='checkouts')fail(404,'原生客户端接口不存在');
    if(!parts[1]&&req.method==='POST'){json(res,201,this.checkout(user,await readJson(req)));return true;}
    if(parts[1]&&!parts[2]&&req.method==='GET'){json(res,200,this.view(user,parts[1]));return true;}
    if(parts[2]==='access'&&req.method==='POST'){json(res,200,this.access(user,parts[1],req));return true;}
    if(parts[2]==='files'&&['GET','HEAD'].includes(req.method)){this.file(user,parts[1],parts.slice(3).join('/'),req,res);return true;}
    fail(404,'原生客户端接口不存在');
  }
  async close(){
    this.closed=true;clearInterval(this.timer);for(const client of this.clients.values())client.ws.close(1001,'Service closing');
    await new Promise(resolve=>{const timer=setTimeout(()=>{for(const client of this.clients.values())client.ws.terminate();},3000);this.wss.close(()=>{clearTimeout(timer);resolve();});});
    await Promise.allSettled([...this.pending]);
  }
}
