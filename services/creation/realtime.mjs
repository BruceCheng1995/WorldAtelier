import { WebSocketServer, WebSocket } from 'ws';
import { fail, id, vector } from './schema.mjs';
import { HIERARCHY_SCHEMA, resolveScene, scopedAddressKey } from './hierarchy.mjs';
import { hierarchyRuntimeId } from './hierarchy-view.mjs';
import { inverse } from '../../packages/scene/transform.mjs';
import { NATIVE_SCHEMA } from './native-source.mjs';
import { nativeObjects,resolveNativeObject,nativePreviewTransform } from './native-reference.mjs';
import {compactSessionEvent} from './session-event-view.mjs';
import {presentationOf} from './project-media.mjs';

const selectionAddressKey=address=>JSON.stringify([address.project_id,address.branch_id,address.resource_id,address.instance_path,address.definition_node_id]);

export class CreationRealtime {
  constructor({server,store,onWorld,requestOrigin=null}) {
    this.store=store;this.onWorld=onWorld;this.connections=new Map();this.previews=new Map();this.resolved=new Map();
    this.wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
    server.on('upgrade',(req,socket,head)=>{
      if(new URL(req.url,'http://localhost').pathname!=='/ws/creation')return;
      const origin=requestOrigin?requestOrigin(req):`http://${req.headers.host}`;
      if(!origin||socket.destroyed){socket.destroy();return;}
      if(req.headers.origin&&req.headers.origin!==origin){socket.destroy();return;}
      this.wss.handleUpgrade(req,socket,head,ws=>this.connect(ws,origin));
    });
    this.timer=setInterval(()=>this.sweep(),3000);this.timer.unref();
  }
  send(client,value) {if(client.ws.readyState===WebSocket.OPEN)client.ws.send(JSON.stringify(value));}
  packet(client,type,fields={}) {return {type,project_id:client.scope?.project_id,branch_id:client.scope?.branch_id,resource_id:client.scope?.resource_id,generation:client.scope?.generation,...fields};}
  connect(ws,origin) {
    const client={id:id('peer'),ws,origin,scope:null,user:null,generation:0,last_seen:Date.now(),last_presence:0};this.connections.set(client.id,client);
    const timeout=setTimeout(()=>{if(!client.user)ws.close(1008,'Authentication required');},5000);
    ws.on('message',async bytes=>{let requestType;try{
      const message=JSON.parse(bytes.toString());requestType=typeof message.type==='string'?message.type:undefined;client.last_seen=Date.now();
      if(message.type==='auth'){
        if(client.user)fail(409,'连接已认证');client.token=message.token;client.user=this.store.authenticate(message.token);clearTimeout(timeout);this.send(client,{type:'authenticated',peer_id:client.id,user:client.user});return;
      }
      if(!client.user)fail(401,'请先认证');
      client.user=this.store.authenticate(client.token);
      if(message.type==='ping'){this.send(client,{type:'pong',at:Date.now()});return;}
      if(message.type==='subscribe') {
        const previous=client.scope;
        const current=this.store.branchFor(client.user,message.project_id,message.branch_id);
        const manifest=this.store.readRevision(current.head).manifest;
        if(!manifest.resources[message.resource_id])fail(404,'订阅文档不存在');
        // A document switch within the same fixed source needs a new scoped
        // baseline, not another full copy of every scene and prefab.
        const branch=message.known_head===current.head?{...current,presentation:presentationOf(current.presentation),manifest_unchanged:true}:this.store.branchView(client.user,message.project_id,message.branch_id);
        if(!Number.isSafeInteger(message.generation)||message.generation<1)fail(400,'订阅代次无效');
        if(message.generation<=client.generation)fail(409,'订阅代次已过期');client.generation=message.generation;
        // Drop the old control authority synchronously before exposing a new baseline.
        // onWorld starts leave() before its first await; no old-world input can interleave.
        Promise.resolve(this.onWorld?.(client,{type:'world_leave'})).catch(()=>{});
        this.clearPreview(client);client.scope={project_id:message.project_id,branch_id:message.branch_id,resource_id:message.resource_id,generation:message.generation};client.camera=null;client.selected_id=null;client.selected_address=null;client.selected_objects=[];client.selected_source_revision=null;client.selected_source_identity=null;client.selection_key=null;client.selection_intent=0;client.last_presence=0;
        // Same synchronous event-loop turn attaches the subscription and captures baseline.
        this.send(client,this.packet(client,'baseline',{branch,document_sequence:branch.doc_sequences[message.resource_id]??0,peer_id:client.id}));
        this.onSubscribe?.(client);
        for(const preview of this.previews.values())if(this.same(preview,client.scope)&&preview.source_revision===branch.head&&preview.expires_at>Date.now())this.send(client,this.packet(client,'drag_preview',{preview}));
        if(previous)this.presence(previous);this.presence(client.scope);return;
      }
      if(message.type==='unsubscribe'){const previous=client.scope;Promise.resolve(this.onWorld?.(client,{type:'world_leave'})).catch(()=>{});this.clearPreview(client);client.scope=null;if(previous)this.presence(previous);return;}
      if(message.type==='session_subscribe') {
        this.store.sessionFor(client.user,message.session_id);client.session_id=message.session_id;
        // Yield between pages, but keep live delivery behind the persisted
        // cursor. New events stay in the log until replay catches up, so a live
        // cursor cannot jump over an older approval during reconnect.
        const replay={sid:message.session_id};client.sessionReplay=replay;client.compactSession=message.compact===true;
        let cursor=Number(message.after)||0;
        for(;;){
          if(client.sessionReplay!==replay||client.ws.readyState!==WebSocket.OPEN)return;
          this.store.authenticate(client.token);
          const events=this.store.sessionEvents(client.user,message.session_id,cursor,{compact:client.compactSession});
          if(events.length)cursor=events.at(-1).cursor;
          this.send(client,{type:'session_events',session_id:message.session_id,events,caught_up:events.length<500});
          if(events.length<500){client.sessionReplay=null;break;}
          await new Promise(resolve=>setImmediate(resolve));
          while(client.ws.bufferedAmount>1024*1024&&client.ws.readyState===WebSocket.OPEN&&client.sessionReplay===replay)await new Promise(resolve=>setTimeout(resolve,20));
        }
        return;
      }
      if(message.type.startsWith('world_')){await this.onWorld?.(client,message);return;}
      if(!client.scope||message.generation!==client.scope.generation)fail(409,'订阅已切换');
      const s=client.scope,branch=this.store.branchFor(client.user,s.project_id,s.branch_id);
      if(message.type==='presence'){
        // Camera updates may be coalesced. Selection and mode boundaries must
        // never be dropped: the final clear may be the client's last packet.
        const manifest=this.store.readRevision(branch.head).manifest;
        const explicitObjects=Object.hasOwn(message,'selected_objects');
        if(explicitObjects&&(!Array.isArray(message.selected_objects)||message.selected_objects.length>128))fail(422,'选中对象列表必须是最多 128 个对象的数组');
        const hasSelection=explicitObjects?message.selected_objects.length>0:message.selected_id!=null||message.selected_address!=null;
        if(manifest.schema===NATIVE_SCHEMA&&hasSelection&&(message.source_revision!==branch.head||message.source_identity!=null&&message.source_identity!==manifest.source_identity))fail(409,'选中对象所属源版本已变化');
        const primary=hasSelection&&(message.selected_id!=null||message.selected_address!=null)?this.resolveSelectionTarget(s,branch,message.selected_address,message.selected_id,manifest):null;
        const objects=explicitObjects?message.selected_objects.map(object=>{
          if(!object||typeof object!=='object'||Array.isArray(object)||typeof object.id!=='string'||!object.id.length)fail(422,'选中对象必须包含有效 ID');
          return this.resolveSelectionTarget(s,branch,object.address,object.id,manifest);
        }):primary?[primary]:[];
        // Validate the whole packet before publishing any camera, intent or
        // selection changes. Explicit [] clears even stale legacy primary fields.
        const unique=[...new Map(objects.map(object=>[selectionAddressKey(object.address),object])).values()];
        if(primary&&!unique.some(object=>selectionAddressKey(object.address)===selectionAddressKey(primary.address)))fail(422,'主选中对象必须属于选中对象列表');
        const selected=primary??unique[0]??null;
        const selectedObjects=unique.map(({id,address})=>({id,address}));
        const selectionKey=JSON.stringify([selected?.id??null,selected?.address??null,selectedObjects,message.mode??'editing',message.source_revision??null,message.source_identity??null]);
        const selectionIntent=Number.isSafeInteger(message.selection_intent)&&message.selection_intent>=0?message.selection_intent:client.selection_intent??0;
        if(Date.now()-client.last_presence<60&&client.selection_key===selectionKey&&client.selection_intent===selectionIntent)return;
        const camera=message.camera?{position:vector(message.camera.position,0,10000),target:vector(message.camera.target,0,10000)}:client.camera;
        client.camera=camera;client.last_presence=Date.now();client.selection_key=selectionKey;client.selection_intent=selectionIntent;
        client.selected_id=selected?.id??null;client.selected_address=selected?.address??null;client.selected_objects=selectedObjects;
        client.selected_source_revision=selected?branch.head:null;client.selected_source_identity=selected&&manifest.schema===NATIVE_SCHEMA?manifest.source_identity:null;
        client.mode=['editing','playing','inspecting'].includes(message.mode)?message.mode:'editing';this.presence(s);return;
      }
      if(message.type==='drag_preview') {
        this.store.projectFor(client.user,s.project_id,true);
        if(message.source_revision&&message.source_revision!==branch.head)fail(409,'拖动所属源版本已变化');
        const target=this.resolveTarget(s,branch,message.address,message.object_id);
        if(!target||target.version!==message.expected_version)fail(409,'拖动目标版本已变化');
        const key=`${s.project_id}/${s.branch_id}/${s.resource_id}/${target.id}`,lease=this.previews.get(key);
        if(lease&&lease.peer_id!==client.id&&lease.expires_at>Date.now())fail(409,'另一位协作者正在拖动此对象');
        let transform;
        if(target.native){
          if(message.source_revision!==branch.head||message.source_identity!==target.source_identity)fail(409,'原生拖动所属源版本已变化');
          if(!message.address||!message.object_id)fail(422,'原生拖动需要完整对象地址和 ID');
          transform={...nativePreviewTransform(target,message),source_identity:target.source_identity};
        }else if(target.hierarchy){
          if(message.expected_ancestry_hash!==target.ancestry_hash)fail(409,'拖动的父级变换已变化');
          inverse(message.world_matrix);if(message.world_matrix.slice(12,15).some(v=>Math.abs(v)>10000))fail(422,'拖动位置超出当前运行范围');
          transform={world_matrix:[...message.world_matrix],expected_ancestry_hash:target.ancestry_hash};
        }else transform={position:vector(message.position),rotation:vector(message.rotation,0,36000),scale:vector(message.scale,1,5,.1)};
        const preview={key,peer_id:client.id,object_id:target.id,address:target.address,expected_version:target.version,source_revision:branch.head,actor:client.user,...transform,expires_at:Date.now()+2500,...s};
        this.previews.set(key,preview);this.broadcastScope(s,'drag_preview',{preview});return;
      }
      if(message.type==='drag_end'){this.clearPreview(client);return;}
      fail(400,'未知协作消息');
    }catch(error){this.send(client,{type:'error',status:error.status??400,message:error.message,...(requestType?{request_type:requestType}:{}),...(typeof error.details?.code==='string'?{code:error.details.code}:{})});if(error.status===401||error.status===403)ws.close(1008,'Authorization changed');}});
    ws.on('close',()=>{clearTimeout(timeout);this.clearPreview(client);this.connections.delete(client.id);if(client.scope)this.presence(client.scope);this.onWorld?.(client,{type:'world_disconnect'});});
  }
  resolveSelectionTarget(scope,branch,address,legacyId,manifest) {
    const identityPart=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x1f\x7f]/.test(value);
    if(legacyId!=null&&!identityPart(legacyId))fail(422,'选中对象 ID 无效');
    if(address!=null&&(!address||typeof address!=='object'||Array.isArray(address)||!identityPart(address.definition_node_id)||!Array.isArray(address.instance_path)||address.instance_path.length>128||address.instance_path.some(value=>!identityPart(value))))fail(422,'选中对象需要完整稳定地址');
    const selected=this.resolveTarget(scope,branch,address,legacyId,manifest);
    if(!selected)fail(409,'选中对象的完整地址已失效');
    if(legacyId!=null&&legacyId!==selected.id)fail(409,'对象 ID 与完整地址不一致');
    return selected;
  }
  resolveTarget(scope,branch,address,legacyId,manifest=this.store.readRevision(branch.head).manifest) {
    const doc=manifest.resources[scope.resource_id];
    if(!doc||!address&&!legacyId)return null;
    if(address&&(address.project_id!==scope.project_id||address.branch_id!==scope.branch_id||address.resource_id!==scope.resource_id))fail(409,'对象地址不属于当前场景');
    if(manifest.schema===NATIVE_SCHEMA){
      const cacheKey=JSON.stringify([scope.project_id,scope.branch_id,scope.resource_id,branch.head]);
      if(!this.resolved.has(cacheKey)){
        this.resolved.set(cacheKey,nativeObjects(manifest,scope));
        while(this.resolved.size>8)this.resolved.delete(this.resolved.keys().next().value);
      }
      const row=resolveNativeObject(manifest,scope,address,legacyId,this.resolved.get(cacheKey));
      return row?{...row,native:true,source_identity:manifest.source_identity}:null;
    }
    if(manifest.schema!==HIERARCHY_SCHEMA){
      if(address?.instance_path?.length)return null;
      const object=doc.objects.find(o=>o.id===(address?.definition_node_id??legacyId));
      return object?{...object,address:{project_id:scope.project_id,branch_id:scope.branch_id,resource_id:scope.resource_id,instance_path:[],definition_node_id:object.id}}:null;
    }
    const cacheKey=JSON.stringify([scope.project_id,scope.branch_id,scope.resource_id,branch.head]);
    if(!this.resolved.has(cacheKey)){
      this.resolved.set(cacheKey,resolveScene(manifest,scope.resource_id,{project_id:scope.project_id,branch_id:scope.branch_id}));
      while(this.resolved.size>8)this.resolved.delete(this.resolved.keys().next().value);
    }
    const rows=this.resolved.get(cacheKey),key=address?scopedAddressKey(address):null;
    const row=rows.find(row=>key?scopedAddressKey(row.address)===key:hierarchyRuntimeId(row.address)===legacyId);
    return row?{id:hierarchyRuntimeId(row.address),address:row.address,version:row.object_version,ancestry_hash:row.ancestry_hash,hierarchy:true}:null;
  }
  same(a,b){return a&&b&&a.project_id===b.project_id&&a.branch_id===b.branch_id&&a.resource_id===b.resource_id;}
  userUpdated(user) {
    const projects=this.store.list('creator_project').filter(p=>p.members[user.id]),scopes=new Map();
    for(const client of this.connections.values()){
      if(!client.user)continue;
      try{client.user=this.store.authenticate(client.token);}catch{client.ws.close(1008,'Authorization changed');continue;}
      if(client.user.id===user.id||this.store.isAdmin(client.user)||projects.some(p=>this.store.roleFor(client.user,p)))this.send(client,{type:'user_updated',user});
      if(client.user.id===user.id&&client.scope)scopes.set(JSON.stringify([client.scope.project_id,client.scope.branch_id,client.scope.resource_id]),client.scope);
    }
    for(const preview of this.previews.values())if(preview.actor?.id===user.id)preview.actor=user;
    for(const scope of scopes.values())this.presence(scope);
  }
  authorized(client,write=false){try{this.store.authenticate(client.token);this.store.projectFor(client.user,client.scope.project_id,write);return true;}catch{client.ws.close(1008,'Authorization changed');return false;}}
  broadcastScope(scope,type,fields) {for(const client of this.connections.values())if(this.same(client.scope,scope)&&this.authorized(client))this.send(client,this.packet(client,type,fields));}
  presence(scope) {
    const peers=[...this.connections.values()].filter(c=>this.same(c.scope,scope)&&this.authorized(c)).map(c=>({id:c.id,...c.user,camera:c.camera,selected_id:c.selected_id,selected_address:c.selected_address,selected_objects:c.selected_objects??[],selected_source_revision:c.selected_source_revision??null,selected_source_identity:c.selected_source_identity??null,selection_intent:c.selection_intent??0,mode:c.mode??'editing',last_seen:c.last_seen,peer_id:c.id}));
    this.broadcastScope(scope,'presence',{peers});
    this.branchPresence(scope);
  }
  branchPresence(scope) {
    const clients=[...this.connections.values()].filter(c=>c.scope?.project_id===scope.project_id&&c.scope.branch_id===scope.branch_id&&c.ws.readyState===WebSocket.OPEN&&this.authorized(c));
    // Branch-wide identity only. Camera, selection and document activity stay scene-scoped.
    const peers=[...new Map(clients.map(c=>[c.user.id,{id:c.user.id,name:c.user.name}])).values()].sort((a,b)=>a.id.localeCompare(b.id));
    for(const client of clients){
      const packet=this.packet(client,'branch_presence',{peers}),signature=JSON.stringify(packet);
      if(client.branchPresenceSignature===signature)continue;
      this.send(client,packet);client.branchPresenceSignature=signature;
    }
  }
  committed(projectId,branchId,result) {
    {
      const manifest=result.branch.manifest??this.store.readRevision(result.branch.head).manifest;
      const scopes=new Map();
      for(const client of this.connections.values())if(client.scope?.project_id===projectId&&client.scope.branch_id===branchId){
        if(manifest.schema===NATIVE_SCHEMA)this.clearPreview(client);
        const previous=client.selected_objects??(client.selected_id?[{id:client.selected_id,address:client.selected_address}]:[]);
        const objects=previous.flatMap(object=>{
          // The stable full address is authoritative across source changes;
          // a regenerated display ID must not rebind to a different object.
          try{const selected=this.resolveSelectionTarget(client.scope,result.branch,object.address,object.address?null:object.id,manifest);return [{id:selected.id,address:selected.address}];}catch{return [];}
        });
        const primaryKey=client.selected_address?selectionAddressKey(client.selected_address):null;
        const selected=objects.find(object=>primaryKey?selectionAddressKey(object.address)===primaryKey:object.id===client.selected_id)??objects[0]??null;
        client.selected_objects=objects;client.selected_id=selected?.id??null;client.selected_address=selected?.address??null;
        client.selected_source_revision=selected?result.branch.head:null;client.selected_source_identity=selected&&manifest.schema===NATIVE_SCHEMA?manifest.source_identity:null;
        client.selection_key=null;
        scopes.set(client.scope.resource_id,client.scope);
      }
      for(const scope of scopes.values())this.presence(scope);
    }
    for(const client of this.connections.values())if(client.scope?.project_id===projectId&&client.scope.branch_id===branchId&&this.authorized(client))this.send(client,this.packet(client,'committed',{...result,document_sequence:result.branch.doc_sequences[client.scope.resource_id]??0}));
  }
  sessionEvent(sid,event) {
    for(const client of this.connections.values())if(client.session_id===sid){try{this.store.authenticate(client.token);this.store.sessionFor(client.user,sid);if(!client.sessionReplay)this.send(client,{type:'session_event',session_id:sid,event:client.compactSession?compactSessionEvent(event):event});}catch{client.session_id=null;client.sessionReplay=null;client.ws.close(1008,'Authorization changed');}}
  }
  development(projectId,branchId,states) {
    for(const client of this.connections.values())if(client.scope?.project_id===projectId&&client.scope.branch_id===branchId&&this.authorized(client))this.send(client,this.packet(client,'development',{states}));
  }
  developmentFailed(projectId,branchId) {
    for(const client of this.connections.values())if(client.scope?.project_id===projectId&&client.scope.branch_id===branchId&&this.authorized(client))this.send(client,this.packet(client,'development_error',{code:'projection_unavailable'}));
  }
  clearPreview(client) {
    for(const [key,preview]of this.previews)if(preview.peer_id===client.id){this.previews.delete(key);this.broadcastScope(preview,'drag_end',{peer_id:client.id,object_id:preview.object_id,address:preview.address});}
  }
  sweep(){for(const client of this.connections.values())if(Date.now()-client.last_seen>35000)client.ws.close(1001,'Heartbeat expired');for(const [key,p]of this.previews)if(p.expires_at<Date.now()){this.previews.delete(key);this.broadcastScope(p,'drag_end',{peer_id:p.peer_id,object_id:p.object_id,address:p.address});}}
  permissionsChanged(projectId){
    for(const client of this.connections.values()){
      if(!client.user)continue;
      try{
        const user=this.store.authenticate(client.token),project=this.store.get('creator_project',projectId),role=this.store.roleFor(user,project);
        this.send(client,{type:'project_permissions',project_id:projectId,project:role?this.store.projectView(user,project):null,can_create_project:this.store.canCreateProject(user)});
        if(client.session_id&&this.store.get('creator_session',client.session_id)?.project_id===projectId){
          try{this.store.sessionFor(user,client.session_id);}catch{const sid=client.session_id;client.session_id=null;this.send(client,{type:'session_access_revoked',session_id:sid,project_id:projectId});}
        }
        if(client.scope?.project_id===projectId){if(!['owner','editor'].includes(role))this.clearPreview(client);this.authorized(client);}
      }catch{client.ws.close(1008,'Authorization changed');}
    }
    for(const client of this.connections.values())if(client.scope?.project_id===projectId)this.presence(client.scope);
  }
  close(){clearInterval(this.timer);for(const client of this.connections.values())client.ws.close();this.wss.close();}
}
