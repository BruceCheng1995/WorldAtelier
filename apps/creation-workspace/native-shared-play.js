import {GamePlay} from './game-play.js';

const cancelled=()=>Object.assign(Error('共享世界准备已停止'),{name:'AbortError'});

/** Resolve the explicitly applied room once. Source Play and public independent
 * game releases cannot accidentally authorize this different runtime role. */
export async function prepareNativeSharedPlay({request,projectId,branchId,resourceId,signal,onProgress=()=>{},fixed=null}){
  const route=`projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`;
  const playable=fixed??await request(`${route}/shared-playable?resource_id=${encodeURIComponent(resourceId)}`,{signal});
  if(!playable.native_shared||playable.resource_id!==resourceId||!playable.game_build_id||!playable.source_revision)throw Error('此场景没有可加入的原生共享世界');
  const {job}=await request(`builds/${encodeURIComponent(playable.game_build_id)}`,{signal});
  if(job?.purpose!=='native_shared'||job.status!=='completed'||job.project_id!==projectId||job.branch_id!==branchId||job.entry_scene_id!==resourceId||job.source_revision!==playable.source_revision||job.canonical_identity!==playable.runtime_build_id)throw Error('共享世界与固定客户端身份不一致');
  onProgress(job);
  const access=await request(`builds/${encodeURIComponent(job.id)}/access`,{method:'POST',body:{},signal});
  if(signal?.aborted)throw cancelled();
  const url=new URL(access.web_url,location.origin);
  if(url.origin!==location.origin||url.pathname!==`/creation-releases/${job.id}/web/index.html`)throw Error('共享客户端不属于当前服务');
  return {job,url:url.href,playable};
}

export class NativeSharedPlay extends GamePlay {
  constructor(host,prepare,onEvent=()=>{}){
    super(host,async context=>{const result=await prepare(context);this.playable=result.playable;return result;},onEvent);
    this.nativeShared=true;this.frame.title='Godot 共享世界';this.frame.setAttribute('aria-label',this.frame.title);this.host.dataset.runtimeKind='native_shared';
  }
  async load(prepare){const job=await super.load(prepare);if(!this.disposed)this.host.dataset.runtimeKind='native_shared';return job;}
  diagnostic(code,message,extra={}){
    const job=this.job;
    // Before a fixed completed job exists, retain ordinary unscoped startup
    // errors. Loaded/recovered events dispatch through this same override.
    if(!job||job.purpose!=='native_shared'||job.status!=='completed')return super.diagnostic(code,message,{unscoped:true,...(extra.recovered?{recovered:true}:{})});
    return super.diagnostic(code,message,{unscoped:true,shared_build_id:job.id,project_id:job.project_id,branch_id:job.branch_id,revision:job.source_revision,resource_id:job.entry_scene_id,runtime_build_id:job.canonical_identity,...(extra.recovered?{recovered:true}:{})});
  }
  validEnvelope(event){return !this.disposed&&event.origin===location.origin&&event.source===this.frame.contentWindow&&event.data?.source==='world-atelier-game'&&event.data.nonce===this.nonce;}
  receive(event){
    if(!this.validEnvelope(event))return;
    const message=event.data;
    if(message.canonical_identity&&message.canonical_identity!==this.runtimeBuildId){this.fail('共享客户端实际身份不匹配');return;}
    // Loading the projection may briefly increment its local scene counter.
    // Only the authority-pinned generation can enter GamePlay's mode/observation
    // state; otherwise a transient A -> B load can poison the final lower fence.
    if(['world_state','loaded','camera','selected'].includes(message.type)){
      const fixed=this.worldContext;
      if(!fixed||message.scene_generation!==fixed.scene_generation||message.resource_id!==undefined&&message.resource_id!==fixed.resource_id||message.document_id!==undefined&&message.document_id!==this.sceneContext?.document_id)return;
    }
    if(!['native_shared','shared_ready'].includes(message.type))return super.receive(event);
    const packet=message.type==='shared_ready'?{...message,action:'shared_ready'}:message.packet;
    if(!packet||!this.worldContext||packet.world_id!==this.worldContext.world_id||packet.epoch!==this.worldContext.epoch||packet.scene_revision!==this.job.source_revision)return;
    if(['shared_ready','applied'].includes(packet.action)||packet.type==='shared_ready'){
      if(packet.control_generation!==this.worldContext.control_generation||packet.resource_id!==this.worldContext.resource_id||packet.scene_generation!==this.worldContext.scene_generation)return;
      this.loadedSeq=this.seq;this.host.dataset.loadedDocument=this.sceneContext.document_id;this.host.dataset.loadedSeq=String(this.seq);this.host.dataset.sceneGeneration=String(packet.scene_generation);this.status.textContent='场景已加载，正在确认控制权…';
      if(this.pending){clearTimeout(this.pending.timer);this.pending.resolve(packet);this.pending=null;this.diagnostic('runtime_load','共享场景已实际加载',{recovered:true});}
      this.onEvent({type:'shared_ready',...structuredClone(packet),seq:this.seq});return;
    }
    if(packet.action==='input'){
      if(packet.control_generation!==this.worldContext.control_generation)return;
      this.onEvent({type:'native_shared_input',...structuredClone(packet),seq:this.seq});return;
    }
    this.onEvent({type:'native_shared_event',packet:structuredClone(packet),seq:this.seq});
  }
  startShared(scene,packet){
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(cancelled());this.pending=null;}
    this.bindScene(scene,packet.scene_generation);this.sceneGeneration=packet.scene_generation;this.commandSeq=this.seq;
    this.worldContext={world_id:packet.world_id,epoch:packet.epoch,scene_revision:packet.scene_revision,resource_id:packet.resource_id,scene_generation:packet.scene_generation,control_generation:packet.control_generation,document_id:scene.document_id};
    this.startPacket={type:'native_shared',packet:{...structuredClone(packet),seq:this.commandSeq,document_id:scene.document_id,request_id:packet.request_id}};
    const promise=new Promise((resolve,reject)=>{this.pending={resolve,reject,timer:setTimeout(()=>this.fail('共享场景加载超时，尚未授予控制权'),90000)};});
    if(this.ready)this.post(this.startPacket);return promise;
  }
  world(packet){
    if(!this.worldContext||packet.world_id!==this.worldContext.world_id||packet.epoch!==this.worldContext.epoch||packet.scene_revision!==undefined&&packet.scene_revision!==this.worldContext.scene_revision)return;
    if(packet.action==='active'){
      if(packet.control_generation!==this.worldContext.control_generation)return;
      this.status.textContent='';
    }
    const outgoing={...this.worldContext,...structuredClone(packet),seq:this.commandSeq};
    if(packet.action==='mode'){outgoing.action='mode';outgoing.mode=packet.mode;}
    this.post({type:'native_shared',packet:outgoing});
  }
  camera(action){return super.camera(action);}
  select(id){return super.select(id);}
}
