import { randomUUID, userColor } from './client-platform.js';
export { userColor } from './client-platform.js';
/** Authenticated central API + generation-scoped collaboration. No mutation retries. */
export class CreationClient extends EventTarget {
  constructor() {
    super(); this.token=sessionStorage.getItem('world-atelier-creator-token'); this.ws=null;
    this.generation=0; this.scope=null; this.session=null; this.after=0; this.ready=false;
    this.closed=false; this.retry=0; this.reconnect=null; this.heartbeat=null;
  }
  emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}
  login(token){this.disconnect();this.token=token;sessionStorage.setItem('world-atelier-creator-token',token);this.closed=false;this.connect();}
  logout(){this.disconnect();this.token=null;this.scope=null;this.session=null;sessionStorage.removeItem('world-atelier-creator-token');}
  async api(route,{method='GET',body,headers={},signal,timeoutMs=45000}={}) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),Math.min(20*60000,Math.max(1000,Number(timeoutMs)||45000)));
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    try {
      const raw=body instanceof Blob||body instanceof ArrayBuffer||ArrayBuffer.isView(body);
      const response=await fetch(`/creation-api/${route}`,{method,cache:'no-store',signal:controller.signal,
        headers:{...(this.token?{Authorization:`Bearer ${this.token}`} : {}),...(!raw&&body!==undefined?{'Content-Type':'application/json'}:{}),...headers},
        ...(body!==undefined?{body:raw?body:JSON.stringify(body)}:{})});
      const result=await response.json();
      if(!response.ok)throw Object.assign(new Error(result.error||`请求失败 (${response.status})`),{status:response.status,details:result.details});
      return result;
    } catch(error) {
      if(!error.status&&method!=='GET')error.uncertain=true;
      throw error;
    } finally {clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
  }
  async download(route){
    const response=await fetch(`/creation-api/${route}`,{cache:'no-store',headers:this.token?{Authorization:`Bearer ${this.token}`}:{}});
    if(!response.ok){const error=await response.json().catch(()=>({}));throw Object.assign(new Error(error.error||`证据下载失败 (${response.status})`),{status:response.status});}
    return {blob:await response.blob()};
  }
  connect() {
    if(!this.token||this.closed||this.ws&&this.ws.readyState<2)return;
    this.emit('status',{state:'connecting'});
    const ws=this.ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws/creation`);
    ws.onopen=()=>ws.send(JSON.stringify({type:'auth',token:this.token}));
    ws.onmessage=event=>{
      if(this.ws!==ws)return;let packet;
      try{packet=JSON.parse(event.data);}catch{return;}
      if(packet.type==='authenticated'){
        this.ready=true;this.retry=0;this.peerId=packet.peer_id;this.emit('status',{state:'connected',peerId:this.peerId});
        if(this.scope)this.subscribe(this.scope);
        if(this.session&&!this.sessionPaused)this.subscribeSession(this.session,this.after);
        clearInterval(this.heartbeat);this.heartbeat=setInterval(()=>this.send({type:'ping'}),10000);
      }
      if(['baseline','committed','presence','branch_presence','drag_preview','drag_end','development','development_error','issues_changed'].includes(packet.type)&&
        (!this.scope||packet.generation!==this.generation||packet.project_id!==this.scope.project_id||packet.branch_id!==this.scope.branch_id||packet.resource_id!==this.scope.resource_id))return;
      if(['session_events','session_event'].includes(packet.type)){
        if(this.sessionPaused||packet.session_id!==this.session)return;
        for(const event of packet.events??[packet.event])this.after=Math.max(this.after,event?.cursor??0);
      }
      if(['baseline','committed'].includes(packet.type)&&packet.branch?.head&&this.scope)this.scope.known_head=packet.branch.head;
      this.emit('packet',packet);
    };
    ws.onclose=event=>{
      if(this.ws!==ws)return;this.ws=null;this.ready=false;clearInterval(this.heartbeat);
      this.emit('status',{state:'disconnected',reason:event.reason});
      if(!this.closed&&this.token&&event.code!==1008)this.reconnect=setTimeout(()=>this.connect(),Math.min(12000,800*2**this.retry++));
      if(event.code===1008)this.emit('authorization',{message:event.reason||'授权已变更，请重新登录'});
    };
    ws.onerror=()=>this.emit('status',{state:'error',reason:'实时连接失败，正在等待重新连接'});
  }
  subscribe(scope){this.scope={project_id:scope.project_id,branch_id:scope.branch_id,resource_id:scope.resource_id,...(scope.known_head?{known_head:scope.known_head}:{})};this.generation++;this.send({type:'subscribe',...this.scope,generation:this.generation});}
  unsubscribe(){this.send({type:'unsubscribe'});this.scope=null;this.generation++;}
  selectSessionBoundary(sessionId=null){this.session=sessionId;this.after=0;this.sessionPaused=true;}
  subscribeSession(sessionId,after=0){this.sessionPaused=false;this.session=sessionId;this.after=after;this.send({type:'session_subscribe',session_id:sessionId,after,compact:true});}
  send(packet){if(!this.ready||this.ws?.readyState!==WebSocket.OPEN)return false;this.ws.send(JSON.stringify(packet));return true;}
  scoped(type,fields={}){if(!this.scope)return false;return this.send({type,generation:this.generation,...fields});}
  disconnect(){this.closed=true;clearTimeout(this.reconnect);clearInterval(this.heartbeat);const old=this.ws;this.ws=null;this.ready=false;old?.close();}
}

/** Pure wire-boundary helpers, shared by the workspace and fake transport probes. */
export class SceneRevisionCache {
  constructor(limit=8){this.limit=limit;this.scenes=new Map();this.pinned=null;}
  put(scene){if(!scene?.scene_revision)return;const revision=scene.scene_revision;this.scenes.delete(revision);this.scenes.set(revision,structuredClone(scene));this.trim();}
  pin(revision){this.pinned=revision??null;this.trim();}
  get(revision){const scene=this.scenes.get(revision);return scene?structuredClone(scene):null;}
  trim(){while(this.scenes.size>this.limit){const key=[...this.scenes.keys()].find(k=>k!==this.pinned);if(key===undefined)break;this.scenes.delete(key);}}
  clear(){this.scenes.clear();this.pinned=null;}
}
const longMode={edit:'editing',play:'playing',inspect:'inspecting'};
// Local games need a running scene, not an implicit framework player slot.
const playReady=state=>state?.session_kind==='local_preview'?state.runtime_ready===true:state?.control_ready===true;
export class WorldModeSequence {
  constructor(){this.clear();}
  clear(){this.target=null;this.phase=null;this.requestId=null;}
  begin(target,state){
    this.target=target;
    const phase=target==='inspect'&&!(state?.mode==='playing'&&playReady(state))?'play':target;
    return this.issue(phase);
  }
  issue(phase){this.phase=phase;this.requestId=randomUUID();return {mode:longMode[phase],request_id:this.requestId};}
  acknowledge(state){
    if(!this.requestId||state.request_id!==this.requestId||state.mode!==longMode[this.phase]||this.phase==='play'&&!playReady(state))return {complete:false,next:null};
    if(this.target==='inspect'&&this.phase==='play')return {complete:false,next:this.issue('inspect')};
    this.clear();return {complete:true,next:null};
  }
}
export function validWorldInput(message,world,connected,enabled){return Boolean(connected&&enabled&&world&&message.world_id===world.world_id&&message.epoch===world.epoch&&message.scene_revision===world.scene_revision);}
export function validSessionPacket(packet,sessionId,session,scope){return Boolean(sessionId&&packet.session_id===sessionId&&session?.id===sessionId&&scope&&session.project_id===scope.project_id&&session.branch_id===scope.branch_id);}
export function previewPeers(peers,self){return peers.filter(p=>p.peer_id&&p.peer_id!==self).map(p=>({...structuredClone(p),user_id:p.user_id??p.id,color:userColor(p),id:p.peer_id}));}

/** Viewer-local ordering for ephemeral selection display. The server only
 * relays each peer's current selection and client-generated intent token. */
export class LocalSelectionOrder {
  constructor(){this.next=0;this.fingerprints=new Map();this.ranks=new Map();}
  update(peers){
    const live=new Set();
    const result=peers.map(peer=>{
      const id=peer.peer_id??peer.id;live.add(id);
      const objects=Array.isArray(peer.selected_objects)?peer.selected_objects:peer.selected_id?[{id:peer.selected_id,address:peer.selected_address}]:[];
      const fingerprint=JSON.stringify([peer.selected_id??null,peer.selected_address??null,objects,peer.mode??'editing',Number.isSafeInteger(peer.selection_intent)?peer.selection_intent:0]);
      if(this.fingerprints.get(id)!==fingerprint){
        this.fingerprints.set(id,fingerprint);
        if(objects.length&&(peer.mode??'editing')==='editing')this.ranks.set(id,++this.next);else this.ranks.delete(id);
      }
      return {...peer,selection_order:this.ranks.get(id)??0};
    });
    for(const id of this.fingerprints.keys())if(!live.has(id)){this.fingerprints.delete(id);this.ranks.delete(id);}
    return result;
  }
  clear(){this.next=0;this.fingerprints.clear();this.ranks.clear();}
}
const developmentAddressKey=a=>a?JSON.stringify([a.project_id,a.branch_id,a.resource_id,a.instance_path,a.definition_node_id]):null;
export function aggregateDevelopment(states,scope={}){
  const grouped=new Map();
  for(const state of states??[]){
    if(state.status!=='editing'&&!['starting','running','cancelling','uncertain','waiting_input'].includes(state.execution))continue;
    const address=state.address,resource=address?.resource_id??state.resource_id;
    if(scope.resource_id&&resource!==scope.resource_id||address&&['project_id','branch_id'].some(k=>scope[k]&&address[k]!==scope[k]))continue;
    const id=state.id??state.object_id;if(!id||!state.run_id)continue;
    const key=developmentAddressKey(address)??JSON.stringify([scope.project_id,scope.branch_id,resource,id]);
    if(!grouped.has(key))grouped.set(key,{id,object_id:id,address:address?structuredClone(address):undefined,resource_id:resource,runs:[],status:'editing'});
    const group=grouped.get(key);if(group.runs.some(run=>run.run_id===state.run_id))continue;
    group.runs.push({run_id:state.run_id,execution:state.execution,label:state.label,actor:state.actor?structuredClone(state.actor):undefined});
  }
  return [...grouped.values()].map(group=>({...group,label:group.runs.length===1?group.runs[0].label??'Agent 正在开发':`${group.runs.length} 个 Agent 正在处理`}));
}
export function withDevelopmentMetadata(scene,states,worldContext=null){
  const result=structuredClone(scene),groups=aggregateDevelopment(states,{project_id:scene.project_id??scene.hierarchy_pack?.scope?.project_id,branch_id:scene.branch_id,resource_id:scene.resource_id,...(worldContext??{})});
  result.objects=result.objects.map(o=>({...o,developments:groups.filter(g=>g.id===o.id&&(!o.address||developmentAddressKey(o.address)===developmentAddressKey(g.address)))}));
  delete result.developments;return result;
}

export const DEFAULT_DISPLAY = Object.freeze({show_selections:true,show_cameras:true,show_agents:true,width:4,opacity:.85});
export const displayKey = userId => `world-atelier-viewport-display-v1:${userId}`;
export function normalizeDisplay(value={}){
  const number=(key,min,max)=>typeof value?.[key]==='number'&&Number.isFinite(value[key])?Math.min(max,Math.max(min,value[key])):DEFAULT_DISPLAY[key];
  return {show_selections:typeof value?.show_selections==='boolean'?value.show_selections:true,show_cameras:typeof value?.show_cameras==='boolean'?value.show_cameras:true,show_agents:typeof value?.show_agents==='boolean'?value.show_agents:true,width:number('width',.5,8),opacity:number('opacity',0,1)};
}
export function readDisplay(storage,userId){try{return normalizeDisplay(JSON.parse(storage.getItem(displayKey(userId))??'{}'));}catch{return {...DEFAULT_DISPLAY};}}
