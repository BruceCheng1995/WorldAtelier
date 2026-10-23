import {randomUUID} from './client-platform.js';
import {PlayContextBuffer,projectedFocusCandidates} from './play-context-buffer.js';
import {PLAY_CONTEXT_PROTOCOL,samePlayContext,summarizePlayCapture} from '../../packages/contracts/play-context.mjs';

const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const contextKey=c=>c&&[c.user_id,c.project_id,c.branch_id,c.session_id,c.session_generation??''].join('/');
const gapNames={recording_started:'记录从本次试玩开始',history_not_retained:'较早过程已超出原保留范围，延长从现有记录继续',runtime_sequence_gap:'部分运行事件未收到',local_budget:'记录达到内存上限，较早内容已省略',snapshot_stale:'当前状态可能已过时',no_keyframes:'未取得关键画面',frame_capture_failed:'一张关键画面未取得',object_budget:'对象观察达到上限',upload_frame_budget:'部分画面未附带',upload_event_budget:'部分事件未附带',runtime_observation_unavailable:'当前构建未提供完整运行观察'};

export function playRuntimeScope(preview,context,last={}){
  const job=preview?.job;if(!job||preview.disposed||!preview.nonce||!['play','inspect'].includes(context?.mode)||context.project_id!==job.project_id||context.branch_id!==job.branch_id)return null;
  const resource=last.resource_id??preview.sceneContext?.resource_id??preview.sceneContext?.document_id?.split('/').at(-1)??job.entry_scene_id;
  const generation=preview.sceneGeneration??last.scene_generation;
  if(!Number.isSafeInteger(generation)||!resource)return null;
  return {project_id:job.project_id,branch_id:job.branch_id,source_revision:job.source_revision,build_id:job.id,canonical_identity:job.canonical_identity,
    runtime_instance_id:preview.nonce,resource_id:resource,scene_generation:generation,session_kind:preview.nativeShared?'shared_world':job.purpose==='prefab_test'?'prefab_test':'local_preview',
    ...(preview.worldContext?.world_id?{world_id:preview.worldContext.world_id,epoch:preview.worldContext.epoch}: {})};
}

/** The controller brokers only validated runtime packets/captures from GamePlay.
 * It never reaches through the iframe, reads chat text, or uploads the local
 * history until the creator sends a message / explicitly requests live context. */
export class PlayContextController {
  constructor({composer,viewport,request,getContext,preview,requestInspect,onSession=()=>{},onError=()=>{}}){
    Object.assign(this,{composer,viewport,request,getContext,preview,requestInspect,onSession,onError});
    this.buffer=new PlayContextBuffer();this.windowId=randomUUID();this.runtime=null;this.last={};this.included=true;this.sessionBinding=null;this.sessionChanged=false;this.pendingSnapshots=new Map();this.generation=0;this.prepared=null;this.captureJob=null;this.removalJob=null;this.removalError=null;this.frameJob=null;this.live=null;this.disposed=false;this.focusLayer=null;
    this.chip=el('div','play-context-chip');this.chip.hidden=true;
    const label=el('label','play-context-include');this.checkbox=el('input');this.checkbox.type='checkbox';this.checkbox.checked=true;this.checkbox.dataset.playContextInclude='';label.append(this.checkbox,el('span','','附带试玩过程'));
    this.range=el('select');this.range.dataset.playContextRange='';this.range.setAttribute('aria-label','试玩回溯时长');
    for(const [value,text]of [[15,'最近 15 秒'],[30,'最近 30 秒'],[60,'最近 60 秒'],[180,'延长至 3 分钟'],[600,'延长至 10 分钟']]){const option=el('option','',text);option.value=value;this.range.append(option);}this.range.value='60';
    this.details=el('button','play-context-link','查看过程');this.details.type='button';this.details.dataset.playContextReview='';
    this.status=el('span','play-context-status');this.status.setAttribute('aria-live','polite');
    this.chip.append(label,this.range,this.details,this.status);composer.append(this.chip);
    this.focusButton=el('button','play-context-focus-button','指出这里');this.focusButton.type='button';this.focusButton.dataset.playContextFocus='';this.focusButton.hidden=true;this.focusButton.title='暂停个人观察，点选或框出想讨论的画面';viewport.append(this.focusButton);
    this.checkbox.onchange=()=>{
      this.included=this.checkbox.checked;this.sessionChanged=false;
      if(!this.included){
        this.removalError=null;const job=this.removePrepared();this.removalJob=job;
        job.catch(error=>{this.removalError=error;onError(error);}).finally(()=>{if(this.removalJob===job)this.removalJob=null;this.render();});
      }
      this.render();
    };
    this.range.onchange=()=>{this.buffer.extend(Number(this.range.value));this.replacePrepared();this.render();};
    this.details.onclick=()=>this.review();this.focusButton.onclick=()=>this.focus().catch(onError);
    this.timer=setInterval(()=>{this.update();this.sampleFrame().catch(()=>{});this.poll().catch(error=>{if(this.live){this.live=null;this.status.textContent=error.message;}});},3000);
  }
  update(){
    if(this.disposed)return;
    const context=this.getContext(),preview=this.preview(),scope=playRuntimeScope(preview,context,this.last);
    if(!scope||!context?.user_id){if(this.runtime)this.reset();this.render();return;}
    const identity=[context.user_id,scope.project_id,scope.branch_id,scope.runtime_instance_id].join('/');
    if(identity!==this.runtime){this.reset();this.runtime=identity;this.buffer.bind(scope);this.included=true;this.checkbox.checked=true;this.range.value='60';}
    else this.buffer.bind(scope);
    const binding=contextKey(context);
    if(this.sessionBinding&&binding!==this.sessionBinding){
      this.closeLive();this.prepared=null;this.captureJob=null;this.included=false;this.sessionChanged=true;
    }
    this.sessionBinding=binding;
    if(this.live&&(!samePlayContext(this.live.scope,scope)||this.live.contextKey!==contextKey(context)))this.closeLive();
    this.render();
  }
  reset(){
    this.closeLive();this.generation++;this.runtime=null;this.last={};this.buffer.close();this.prepared=null;this.captureJob=null;this.removalJob=null;this.removalError=null;this.frameJob=null;this.sessionBinding=null;this.sessionChanged=false;this.closeFocus();
    for(const pending of this.pendingSnapshots.values())pending.reject(Error('试玩已停止或切换'));this.pendingSnapshots.clear();
  }
  render(){
    const context=this.getContext(),available=!!this.runtime&&!!context?.can_write&&!!context.session_id;
    this.chip.hidden=!available;this.focusButton.hidden=!this.runtime||!context?.can_write||context.mode_pending;
    this.checkbox.checked=this.included;this.range.disabled=!this.included||!!this.captureJob||!!this.removalJob;this.details.disabled=!this.buffer.events.length&&!this.buffer.frames.length;
    if(available&&!this.captureJob){const seconds=Math.max(0,Math.min(this.buffer.windowSeconds,(performance.now()-Math.max(this.buffer.started,this.buffer.retainedFrom))/1000));this.status.textContent=this.included?`${Math.round(seconds)} 秒可用 · 仅此窗口${this.buffer.gaps.length?' · 有记录缺口':''}`:this.sessionChanged?'会话已切换；勾选后带入当前试玩':'本条消息不附带试玩记录';}
  }
  accept(message){
    if(this.disposed)return;
    if(['loaded','world_state','play_context'].includes(message.type)&&message.resource_id)this.last={resource_id:message.resource_id,scene_generation:message.scene_generation};
    this.update();if(!this.runtime)return;
    if(message.type==='play_context'){
      const accepted=this.buffer.accept(message);if(!accepted)return;
      const pending=this.pendingSnapshots.get(message.request_id);
      if(pending&&message.kind==='snapshot'){this.pendingSnapshots.delete(message.request_id);pending.resolve(message);}
      if(message.kind==='event'&&['pointer_down','key_down','runtime_fault','scene_changed'].includes(message.payload?.kind))this.sampleFrame({event:true}).catch(()=>{});
    }else if(message.type==='runtime_error')this.buffer.record({kind:'runtime_fault',source:'engine_observation',payload:{message:String(message.message??'').slice(0,2000)}});
  }
  async requestSnapshot(){
    this.update();const preview=this.preview(),scope=this.buffer.scope;if(!this.runtime||!preview?.ready||!scope)throw Error('当前没有已就绪的试玩窗口');
    const request_id=randomUUID(),generation=this.generation;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pendingSnapshots.delete(request_id);this.buffer.gap('runtime_observation_unavailable');reject(Error('运行观察暂未返回，已保留可用画面与过程'));},2200);
      this.pendingSnapshots.set(request_id,{resolve:value=>{clearTimeout(timer);generation===this.generation?resolve(value):reject(Error('试玩已切换'));},reject:error=>{clearTimeout(timer);reject(error);}});
      preview.post({type:'context_request',action:'snapshot',request_id,seq:preview.commandSeq??preview.seq,document_id:preview.sceneContext.document_id,scene_generation:scope.scene_generation});
    });
  }
  async compactFrame(image){
    if(typeof image?.data_url!=='string')throw Error('运行窗口没有返回画面');
    const regions=this.buffer.snapshot.text_input_regions??[];
    if(this.buffer.snapshot.input_regions_complete===false)throw Error('输入区域扫描不完整，本帧未纳入自动记录');
    if(image.data_url.length<700*1024&&!regions.length)return image;
    const bitmap=await createImageBitmap(await (await fetch(image.data_url)).blob());
    try{
      const ratio=Math.min(1,1280/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
      const context=canvas.getContext('2d');context.drawImage(bitmap,0,0,canvas.width,canvas.height);context.fillStyle='#12251b';
      for(const rect of regions)if(Array.isArray(rect)&&rect.length===4&&rect.every(Number.isFinite))context.fillRect(Math.floor(rect[0]*canvas.width)-2,Math.floor(rect[1]*canvas.height)-2,Math.ceil(rect[2]*canvas.width)+4,Math.ceil(rect[3]*canvas.height)+4);
      return {...image,data_url:canvas.toDataURL('image/jpeg',.78),width:canvas.width,height:canvas.height,redacted_input_regions:regions.length};
    }finally{bitmap.close();}
  }
  sampleFrame({force=false,event=false}={}){
    this.update();const preview=this.preview(),scope=this.buffer.scope,generation=this.generation,capturedMode=this.getContext()?.mode;
    if(this.frameJob)return this.frameJob;
    if(!this.runtime||!scope||!preview?.ready||preview.pending||document.visibilityState==='hidden')return Promise.resolve(null);
    if(!force&&performance.now()-this.buffer.lastFrame<(event?2500:7000))return Promise.resolve(null);
    const work=(async()=>{
      try{if(performance.now()-(this.buffer.snapshot.at_ms??-Infinity)>1500)await this.requestSnapshot();const image=await this.compactFrame(await preview.captureFrame());if(generation!==this.generation||preview!==this.preview()||!samePlayContext(scope,this.buffer.scope)||capturedMode!==this.getContext()?.mode)return null;return this.buffer.addFrame({...image,mode:capturedMode},{scope});}
      catch(error){if(generation===this.generation)this.buffer.gap('frame_capture_failed');if(force)throw error;return null;}
    })();this.frameJob=work;return work.finally(()=>{if(this.frameJob===work)this.frameJob=null;});
  }
  async registerLive(context,scope){
    if(this.live&&this.live.contextKey===contextKey(context)&&samePlayContext(this.live.scope,scope))return this.live;
    this.closeLive();const result=await this.request(`sessions/${encodeURIComponent(context.session_id)}/play-context/windows/register`,{method:'POST',body:{window_id:this.windowId,scope}});
    if(contextKey(this.getContext())!==contextKey(context)||!samePlayContext(this.buffer.scope,scope)){this.request(`sessions/${encodeURIComponent(context.session_id)}/play-context/windows/${result.handle}/close`,{method:'POST',body:{secret:result.secret}}).catch(()=>{});throw Error('会话或试玩已切换，未绑定旧窗口');}
    this.live={...result,scope:structuredClone(scope),sessionId:context.session_id,contextKey:contextKey(context),polling:false};return this.live;
  }
  closeLive(){const live=this.live;this.live=null;if(live)this.request(`sessions/${encodeURIComponent(live.sessionId)}/play-context/windows/${live.handle}/close`,{method:'POST',body:{secret:live.secret}}).catch(()=>{});}
  async poll(){
    const live=this.live;if(!live||live.polling||this.disposed)return;live.polling=true;
    try{
      const response=await this.request(`sessions/${encodeURIComponent(live.sessionId)}/play-context/windows/${live.handle}/poll`,{method:'POST',body:{secret:live.secret}});
      if(this.live!==live)return;
      for(const pending of response.requests){
        try{
          if(!samePlayContext(pending.scope,this.buffer.scope)||contextKey(this.getContext())!==live.contextKey)throw Error('当前试玩已经切换');
          await this.requestSnapshot();await this.sampleFrame({force:true}).catch(()=>{});
          if(this.live!==live)throw Error('当前观察窗口已关闭');
          const capture=this.buffer.freeze({requestId:pending.id,seconds:1});
          await this.request(`sessions/${encodeURIComponent(live.sessionId)}/play-context/windows/${live.handle}/respond`,{method:'POST',body:{secret:live.secret,request_id:pending.id,capture}});
        }catch(error){await this.request(`sessions/${encodeURIComponent(live.sessionId)}/play-context/windows/${live.handle}/respond`,{method:'POST',body:{secret:live.secret,request_id:pending.id,error:String(error.message).slice(0,300)}}).catch(()=>{});}
      }
    }finally{live.polling=false;}
  }
  async beforeSend(){
    if(this.removalJob)await this.removalJob;
    if(this.removalError){await this.removePrepared();this.removalError=null;}
    this.update();const context=this.getContext(),scope=this.buffer.scope;
    if(!this.runtime||!this.included||!context?.can_write||!context.session_id||!scope)return null;
    const binding=contextKey(context);
    if(this.prepared?.binding===binding){
      if(this.prepared.result){
        const attached=context.session?.draft_attachments?.some(a=>a.kind==='play_observation'&&a.observation_id===this.prepared.result.observation_id);
        if(context.session&&!attached){this.included=false;await this.removePrepared();this.render();return null;}
        return this.prepared.result.session;
      }
    }else this.prepared={binding,requestId:randomUUID(),scope:structuredClone(scope),input:null,result:null};
    if(this.captureJob)return this.captureJob;
    const prepared=this.prepared;
    const job=(async()=>{
      this.status.textContent='正在固定试玩记录…';
      if(!prepared.input){
        await this.requestSnapshot().catch(()=>{});await this.sampleFrame({force:true}).catch(()=>{});
        if(contextKey(this.getContext())!==binding||!samePlayContext(scope,this.buffer.scope))throw Error('会话、关卡或试玩已变化，请重新发送');
        if(!this.included){if(this.prepared===prepared)this.prepared=null;this.closeLive();return null;}
        if(this.prepared!==prepared)throw Error('关注内容已改变，请重新发送以固定新的画面');
        const live=await this.registerLive(context,scope);prepared.input={...this.buffer.freeze({requestId:prepared.requestId}),live_handle:live.handle};
      }
      if(!this.included){if(this.prepared===prepared)this.prepared=null;this.closeLive();return null;}
      const result=await this.request(`sessions/${encodeURIComponent(context.session_id)}/play-context/captures`,{method:'POST',body:prepared.input,timeoutMs:45000});prepared.result=result;
      if(!this.included&&contextKey(this.getContext())===binding){
        if(this.removalJob)await this.removalJob;else await this.removePrepared(prepared,context);
        return null;
      }
      if(this.prepared!==prepared&&contextKey(this.getContext())===binding){if(this.removalJob)await this.removalJob;throw Error('附带范围或关注画面已改变，请重新发送');}
      if(contextKey(this.getContext())===binding)this.onSession(result.session);
      return result.session;
    })();this.captureJob=job;this.render();
    try{return await job;}finally{if(this.captureJob===job)this.captureJob=null;this.render();}
  }
  sent({session_id=null}={}){if(session_id&&this.getContext()?.session_id!==session_id)return;this.prepared=null;this.included=true;this.sessionChanged=false;this.checkbox.checked=true;this.render();}
  allowCurrentSession(){this.update();this.prepared=null;this.included=true;this.sessionChanged=false;this.render();}
  replacePrepared(){
    if(!this.prepared)return;
    if(!this.prepared.input&&!this.prepared.result){this.prepared=null;return;}
    this.removalError=null;const job=this.removePrepared();this.removalJob=job;
    job.catch(error=>{this.removalError=error;this.onError(error);}).finally(()=>{if(this.removalJob===job)this.removalJob=null;this.render();});
  }
  async removePrepared(prepared=this.prepared,context=this.getContext()){
    if(!prepared||prepared.binding!==contextKey(context))return;
    // An interrupted upload response is an unknown result. Recover the original
    // idempotent request before removing it, so unchecked UI cannot leave hidden
    // server-side observation/image attachments in the next message.
    if(!prepared.result&&prepared.input)prepared.result=await this.request(`sessions/${encodeURIComponent(context.session_id)}/play-context/captures`,{method:'POST',body:prepared.input});
    if(!prepared.result)return;
    const current=await this.request(`sessions/${encodeURIComponent(context.session_id)}`),attachments=current.draft_attachments??[];
    for(const attachment of attachments.filter(a=>a.observation_id===prepared.result.observation_id))await this.request(`sessions/${encodeURIComponent(context.session_id)}/attachments/${encodeURIComponent(attachment.id)}`,{method:'DELETE'});
    const updated=await this.request(`sessions/${encodeURIComponent(context.session_id)}`);if(contextKey(this.getContext())===prepared.binding)this.onSession(updated);if(this.prepared===prepared)this.prepared=null;
  }
  async focus(frame=null){
    this.update();if(!this.runtime)throw Error('先运行游戏，再指出希望讨论的内容');
    if(!frame){
      if(this.getContext().mode!=='inspect'){
        await this.requestInspect();const deadline=Date.now()+10000;
        while(this.getContext().mode!=='inspect'&&Date.now()<deadline){if(!this.runtime)throw Error('试玩已结束');await sleep(50);}
        if(this.getContext().mode!=='inspect')throw Error('个人观察尚未就绪，请稍后再试');
      }
      await this.requestSnapshot().catch(()=>{});frame=await this.sampleFrame({force:true});
    }
    if(!frame)throw Error('这次没有取得画面，请重试');
    this.closeFocus();const preview=this.preview(),host=preview?.host??this.viewport,layer=this.focusLayer=el('div','play-context-focus-layer');layer.tabIndex=0;layer.dataset.playContextFrame=frame.id;
    const image=el('img');image.src=frame.data_url;image.alt='已固定的试玩画面，点选或框出关注范围';image.draggable=false;
    const rectangle=el('div','play-context-focus-rect'),hint=el('div','play-context-focus-hint','点一下或拖出范围，空白区域也可以');
    const cancel=el('button','play-context-focus-cancel','取消');cancel.type='button';cancel.onclick=()=>this.closeFocus();layer.append(image,rectangle,hint,cancel);host.append(layer);layer.focus();
    let start=null;
    const point=event=>{const box=layer.getBoundingClientRect();return [Math.max(0,Math.min(1,(event.clientX-box.left)/box.width)),Math.max(0,Math.min(1,(event.clientY-box.top)/box.height))];};
    layer.onpointerdown=event=>{if(event.target.closest('button'))return;event.preventDefault();event.stopPropagation();start=point(event);layer.setPointerCapture(event.pointerId);rectangle.hidden=false;};
    layer.onpointermove=event=>{if(!start)return;const end=point(event);Object.assign(rectangle.style,{left:`${Math.min(start[0],end[0])*100}%`,top:`${Math.min(start[1],end[1])*100}%`,width:`${Math.abs(end[0]-start[0])*100}%`,height:`${Math.abs(end[1]-start[1])*100}%`});};
    layer.onpointerup=event=>{
      if(!start)return;event.preventDefault();event.stopPropagation();const end=point(event),rect=[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.abs(end[0]-start[0]),Math.abs(end[1]-start[1])],isPoint=rect[2]+rect[3]<.015;
      const candidates=projectedFocusCandidates(frame,isPoint?{point:end}:{rect});
      this.buffer.setFocus({kind:isPoint?'screen_point':'screen_region',...(isPoint?{point:end}:{rect}),runtime_ids:candidates.map(row=>row.runtime_id),frame_id:frame.id,at_ms:frame.at_ms,resource_id:frame.resource_id,scene_generation:frame.scene_generation});
      this.replacePrepared();this.included=true;this.sessionChanged=false;this.closeFocus();this.render();this.status.textContent=`已固定关注画面${candidates.length?` · ${candidates.length} 个可能相关对象`:' · 屏幕区域'}，随消息发送`;
    };
    layer.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.closeFocus();}};
  }
  closeFocus(){this.focusLayer?.remove();this.focusLayer=null;}
  review(){
    this.update();if(!this.runtime)return;const capture=this.buffer.freeze({requestId:'review'}),summary=summarizePlayCapture(capture);
    const dialog=el('dialog','play-context-review'),heading=el('h2','','这段试玩过程'),description=el('p','',`最近 ${summary.duration_seconds} 秒 · ${summary.event_count} 条事件 · ${summary.frame_count} 张关键画面`),frames=el('div','play-context-frames');
    for(const frame of capture.frames){const button=el('button');button.type='button';const image=el('img');image.src=frame.data_url;image.alt=`${Math.round((frame.at_ms-capture.window.start_ms)/100)/10} 秒时的试玩画面`;button.append(image,el('span','',`${Math.round((frame.at_ms-capture.window.start_ms)/100)/10}s · 指出这里`));button.onclick=()=>{dialog.close();dialog.remove();this.focus(frame).catch(this.onError);};frames.append(button);}
    const list=el('ol','play-context-events');for(const step of summary.steps)list.append(el('li','',`${step.at_seconds}s · ${step.label}${step.key?' '+step.key:''}`));
    const gaps=el('p','play-context-gaps',summary.gaps.map(g=>gapNames[g.reason]??'部分内容未记录').filter((v,i,a)=>a.indexOf(v)===i).join('；'));
    const note=el('p','play-context-note','只记录本游戏画布内的操作。文本输入正文不采集；关键画面不是逐帧录像，输入记录不证明操作成功。发送前保存在当前浏览器内存。');
    const close=el('button','','返回对话');close.type='button';close.onclick=()=>{dialog.close();dialog.remove();};dialog.append(heading,description,frames,list,gaps,note,close);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
  }
  dispose(){this.disposed=true;clearInterval(this.timer);this.reset();this.chip.remove();this.focusButton.remove();}
}
