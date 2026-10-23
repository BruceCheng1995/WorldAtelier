import {PLAY_CONTEXT_PROTOCOL,PLAY_CONTEXT_LIMITS,samePlayContext,playFocus,playContextBytes,summarizePlayCapture} from '../../packages/contracts/play-context.mjs';

const copy=value=>structuredClone(value);
const keyOf=scope=>scope&&[scope.project_id,scope.branch_id,scope.source_revision,scope.build_id,scope.runtime_instance_id,scope.canonical_identity??'',scope.world_id??'',scope.epoch??'',scope.session_kind??''].join('/');
const objectKey=row=>row.runtime_id??row.id;
const fingerprint=row=>JSON.stringify([row.visible,row.position,row.world_matrix,row.canvas_transform,row.control,row.observed_values,row.mapping,row.parent_runtime_id]);

/** A memory-only, current-window rolling record. It never reads DOM text,
 * keyboard input outside the game, cookies or storage, and never uploads. */
export class PlayContextBuffer {
  constructor({now=()=>performance.now(),wallNow=()=>Date.now(),limits={}}={}){
    this.now=now;this.wallNow=wallNow;this.limits={...PLAY_CONTEXT_LIMITS,...limits};this.reset();
  }
  reset(scope=null){
    this.scope=scope?copy(scope):null;this.events=[];this.frames=[];this.gaps=[];this.snapshot={objects:[]};this.focus={kind:'none',runtime_ids:[]};
    this.started=this.now();this.lastSeen=this.started;this.lastSequence=null;this.serial=0;this.bytes=0;this.windowSeconds=this.limits.defaultSeconds;
    this.objects=new Map();this.lastDiff=-Infinity;this.lastFrame=-Infinity;this.closed=false;
  }
  bind(scope){
    if(keyOf(scope)!==keyOf(this.scope)){this.reset(scope);return true;}
    if(scope.resource_id!==this.scope.resource_id||scope.scene_generation!==this.scope.scene_generation){
      if(scope.scene_generation<this.scope.scene_generation)return false;
      const prior={resource_id:this.scope.resource_id,scene_generation:this.scope.scene_generation};this.scope=copy(scope);this.objects.clear();this.snapshot={objects:[]};this.focus={kind:'none',runtime_ids:[]};
      this.record({kind:'scene_changed',source:'engine_observation',payload:{previous:prior},resource_id:scope.resource_id,scene_generation:scope.scene_generation});
    }else this.scope=copy(scope);
    return true;
  }
  extend(seconds){
    if(!Number.isFinite(seconds)||seconds<1||seconds>this.limits.maxSeconds)throw Error('记录范围须在 1–600 秒之间');
    this.windowSeconds=seconds;this.prune();return this.windowSeconds;
  }
  matches(scope){return !this.closed&&samePlayContext(this.scope,scope,{scene:false});}
  gap(reason,extra={},at=this.now()){
    const prior=this.gaps.at(-1);
    if(prior?.reason===reason&&at-prior.end_ms<2000){prior.end_ms=at;prior.count=(prior.count??1)+1;}
    else this.gaps.push({reason,start_ms:at,end_ms:at,count:1,...copy(extra)});
    if(this.gaps.length>32)this.gaps.splice(0,this.gaps.length-32);
  }
  record(input,{at=this.now(),scope=this.scope}={}){
    if(!this.matches(scope)||!input||typeof input.kind!=='string')return false;
    if(at<this.lastSeen-1000){this.gap('out_of_order_event');return false;}
    at=Math.max(this.lastSeen,at);this.lastSeen=at;
    const event={id:`event-${++this.serial}`,at_ms:at,kind:input.kind,source:input.source??'client_viewport',
      resource_id:input.resource_id??scope.resource_id,scene_generation:input.scene_generation??scope.scene_generation,payload:copy(input.payload??{}),
      ...(input.sequence!=null?{sequence:input.sequence}:{})};
    // Continuous pointer motion is sampled and collapsed; it cannot consume the
    // budget needed for clicks, transitions, state changes and error evidence.
    const prior=this.events.at(-1);
    if(event.kind==='pointer_move'&&prior?.kind===event.kind&&event.at_ms-prior.at_ms<150&&prior.scene_generation===event.scene_generation){
      this.bytes-=playContextBytes(prior);event.payload.coalesced=(prior.payload.coalesced??1)+1;this.events[this.events.length-1]=event;
    }else this.events.push(event);
    this.bytes+=playContextBytes(event);this.prune(at);return true;
  }
  accept(packet,{at=this.now()}={}){
    if(!this.scope||this.closed||packet?.type!=='play_context'||packet.protocol!==PLAY_CONTEXT_PROTOCOL)return false;
    if(packet.runtime_instance_id!==this.scope.runtime_instance_id||packet.source_revision!==this.scope.source_revision)return false;
    if(!Number.isSafeInteger(packet.scene_generation)||packet.scene_generation<this.scope.scene_generation)return false;
    if(!this.bind({...this.scope,resource_id:packet.resource_id,scene_generation:packet.scene_generation}))return false;
    if(Number.isSafeInteger(packet.sequence)){
      if(this.lastSequence!=null&&packet.sequence<=this.lastSequence)return false;
      if(this.lastSequence!=null&&packet.sequence>this.lastSequence+1)this.gap('runtime_sequence_gap',{from_sequence:this.lastSequence+1,to_sequence:packet.sequence-1},at);
      this.lastSequence=packet.sequence;
    }
    if(packet.kind==='event')return this.record({...packet.payload,sequence:packet.sequence,resource_id:packet.resource_id,scene_generation:packet.scene_generation},{at});
    if(packet.kind!=='snapshot')return false;
    const snapshot=copy(packet.payload??{}),objects=Array.isArray(snapshot.objects)?snapshot.objects.slice(0,this.limits.objects):[];
    if(snapshot.objects?.length>this.limits.objects||snapshot.truncated)this.gap('object_budget',{limit:this.limits.objects},at);
    const next=new Map(objects.map(row=>[objectKey(row),fingerprint(row)])),added=[],changed=[],removed=[];
    for(const [key,value]of next)if(!this.objects.has(key))added.push(key);else if(this.objects.get(key)!==value)changed.push(key);
    for(const key of this.objects.keys())if(!next.has(key))removed.push(key);
    if((added.length||changed.length||removed.length)&&at-this.lastDiff>=500){
      this.record({kind:'state_changed',source:'engine_observation',payload:{added:added.slice(0,64),changed:changed.slice(0,64),removed:removed.slice(0,64),truncated:Math.max(added.length,changed.length,removed.length)>64}},{at});this.lastDiff=at;
    }
    this.objects=next;this.snapshot={...snapshot,objects,engine_time_ms:packet.engine_time_ms??null,tick:packet.tick??null,at_ms:at,scene_generation:packet.scene_generation,resource_id:packet.resource_id};
    this.lastSeen=Math.max(this.lastSeen,at);this.prune(at);return true;
  }
  addFrame(image,{at=this.now(),scope=this.scope}={}){
    if(!this.matches(scope)||image?.source_revision&&image.source_revision!==scope.source_revision||image?.scene_generation!=null&&image.scene_generation!==scope.scene_generation)return false;
    if(typeof image?.data_url!=='string'||image.data_url.length>this.limits.frameBytes*1.4){this.gap('frame_size_limit',{},at);return false;}
    const frame={id:`frame-${++this.serial}`,at_ms:at,captured_at:this.wallNow(),resource_id:scope.resource_id,scene_generation:scope.scene_generation,data_url:image.data_url,redacted_input_regions:image.redacted_input_regions??0};
    const size=playContextBytes(frame);this.frames.push(frame);this.bytes+=size;this.lastFrame=at;this.prune(at);return frame;
  }
  setFocus(value){
    if(!this.scope||this.closed)return;
    this.focus={...playFocus(value),resource_id:value.resource_id??this.scope.resource_id,scene_generation:value.scene_generation??this.scope.scene_generation,at_ms:value.at_ms??this.now()};
    this.record({kind:'focus',source:'user_input',payload:{kind:this.focus.kind,runtime_ids:this.focus.runtime_ids,...(this.focus.rect?{rect:this.focus.rect}:{}),...(this.focus.point?{point:this.focus.point}:{})}});
    return copy(this.focus);
  }
  prune(at=this.now()){
    const cutoff=at-this.windowSeconds*1000;
    while(this.events.length&&this.events[0].at_ms<cutoff)this.bytes-=playContextBytes(this.events.shift());
    while(this.frames.length&&this.frames[0].at_ms<cutoff)this.bytes-=playContextBytes(this.frames.shift());
    this.gaps=this.gaps.filter(g=>g.end_ms>=cutoff);
    let lost=0;
    while(this.events.length>this.limits.events){this.bytes-=playContextBytes(this.events.shift());lost++;}
    // Limit captures independently of time, then shed older frames before events.
    while(this.frames.length>24){this.bytes-=playContextBytes(this.frames.shift());lost++;}
    while(this.bytes>this.limits.localBytes&&(this.frames.length>1||this.events.length>1)){
      const entry=this.frames.length>1?this.frames.shift():this.events.shift();this.bytes-=playContextBytes(entry);lost++;
    }
    if(lost)this.gap('local_budget',{dropped:lost},at);
    this.bytes=Math.max(0,this.bytes);
  }
  freeze({requestId,seconds=this.windowSeconds,scope=this.scope}={}){
    if(!this.matches(scope))throw Error('试玩窗口已关闭或已切换，未附带旧记录');
    const end=this.now(),start=Math.max(this.started,end-Math.min(this.windowSeconds,seconds)*1000);this.prune(end);
    const events=this.events.filter(e=>e.at_ms>=start&&e.at_ms<=end).map(copy),available=this.frames.filter(f=>f.at_ms>=start&&f.at_ms<=end);
    const selected=new Map(),select=frame=>{if(frame)selected.set(frame.id,frame);};
    // Current image and focus are most useful, then the lead-in and the last
    // action. Time and capture identity remain attached to every selected frame.
    select(available.find(f=>f.id===this.focus.frame_id));select(available.at(-1));select(available[0]);
    const action=events.findLast(e=>['pointer_down','key_down','runtime_fault'].includes(e.kind));
    if(action)select(available.findLast(f=>f.at_ms<=action.at_ms));
    let frames=[...selected.values()].sort((a,b)=>a.at_ms-b.at_ms).slice(-this.limits.frames).map(copy);
    const gaps=this.gaps.filter(g=>g.end_ms>=start).map(copy);
    if(start> end-seconds*1000)gaps.unshift({reason:'recording_started',available_seconds:Math.max(0,(end-start)/1000)});
    if(this.snapshot.at_ms==null||end-this.snapshot.at_ms>5000)gaps.push({reason:'snapshot_stale',age_ms:this.snapshot.at_ms==null?null:end-this.snapshot.at_ms});
    if(!frames.length)gaps.push({reason:'no_keyframes'});
    const value={protocol:PLAY_CONTEXT_PROTOCOL,request_id:requestId,scope:copy(this.scope),captured_at:this.wallNow(),
      window:{requested_seconds:Math.min(seconds,this.limits.maxSeconds),start_ms:start,end_ms:end},events,snapshot:copy(this.snapshot),focus:copy(this.focus),gaps,frames};
    while(playContextBytes(value)>this.limits.captureBytes&&frames.length>1){frames.splice(0,1);value.gaps.push({reason:'upload_frame_budget'});}
    while(playContextBytes(value)>this.limits.captureBytes&&value.events.length>1){value.events.splice(0,Math.ceil(value.events.length/4));if(!value.gaps.some(g=>g.reason==='upload_event_budget'))value.gaps.push({reason:'upload_event_budget'});}
    if(playContextBytes(value)>this.limits.captureBytes){value.snapshot.objects=value.snapshot.objects.slice(0,64);value.gaps.push({reason:'upload_object_budget'});}
    return copy(value);
  }
  summary(){
    if(!this.scope||this.closed)return null;
    return summarizePlayCapture(this.freeze({requestId:'summary'}));
  }
  close(){this.closed=true;this.scope=null;this.events=[];this.frames=[];this.snapshot={objects:[]};this.objects.clear();this.focus={kind:'none',runtime_ids:[]};this.bytes=0;this.gaps=[];}
}
