import {PLAY_CONTEXT_PROTOCOL,PLAY_CONTEXT_LIMITS,samePlayContext,playFocus,playContextBytes,summarizePlayCapture,observationValue} from '../../packages/contracts/play-context.mjs';

const copy=value=>structuredClone(value);
const keyOf=scope=>scope&&[scope.project_id,scope.branch_id,scope.source_revision,scope.build_id,scope.runtime_instance_id,scope.canonical_identity??'',scope.world_id??'',scope.epoch??'',scope.session_kind??''].join('/');
const objectKey=row=>row.runtime_id??row.id;
const fingerprint=row=>JSON.stringify([row.visible,row.position,row.world_matrix,row.canvas_transform,row.control,row.observed_values,row.mapping,row.parent_runtime_id]);
const projectedRow=row=>Object.fromEntries(['runtime_id','name','native_type','source','mapping','visible','screen_bounds','position','world_matrix','canvas_transform'].filter(key=>Object.hasOwn(row,key)).map(key=>[key,copy(row[key])]));

export function projectedFocusCandidates(frame,{point=null,rect=null}={}){
  if(frame?.projection?.synchronized!==true)return [];
  return (frame.projection.objects??[]).filter(row=>{
    const bounds=row.screen_bounds;if(row.visible===false||!Array.isArray(bounds)||bounds.length!==4)return false;
    return point?point[0]>=bounds[0]&&point[0]<=bounds[0]+bounds[2]&&point[1]>=bounds[1]&&point[1]<=bounds[1]+bounds[3]:rect&&rect[0]<bounds[0]+bounds[2]&&rect[0]+rect[2]>bounds[0]&&rect[1]<bounds[1]+bounds[3]&&rect[1]+rect[3]>bounds[1];
  }).slice(0,64);
}

/** A memory-only, current-window rolling record. It never reads DOM text,
 * keyboard input outside the game, cookies or storage, and never uploads. */
export class PlayContextBuffer {
  constructor({now=()=>performance.now(),wallNow=()=>Date.now(),limits={}}={}){
    this.now=now;this.wallNow=wallNow;this.limits={...PLAY_CONTEXT_LIMITS,...limits};this.reset();
  }
  reset(scope=null){
    this.scope=scope?copy(scope):null;this.events=[];this.frames=[];this.gaps=[];this.snapshot={objects:[]};this.focus={kind:'none',runtime_ids:[]};
    this.started=this.now();this.lastSeen=this.started;this.lastSequence=null;this.serial=0;this.bytes=0;this.snapshotBytes=0;this.mapBytes=0;this.windowSeconds=this.limits.defaultSeconds;
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
    let payload;try{payload=observationValue(input.payload??{});}catch{this.gap('invalid_event_payload',{},at);return false;}
    if(input.kind.length>64||typeof input.source==='string'&&input.source.length>64){this.gap('invalid_event_payload',{},at);return false;}
    const event={id:`event-${++this.serial}`,at_ms:at,kind:input.kind,source:input.source??'client_viewport',
      resource_id:input.resource_id??scope.resource_id,scene_generation:input.scene_generation??scope.scene_generation,payload,
      ...(input.sequence!=null?{sequence:input.sequence}:{})};
    const size=playContextBytes(event);
    if(size>Math.min(this.limits.localBytes,32768)){this.gap('event_size_limit',{},at);return false;}
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
    if(typeof packet.resource_id!=='string'||packet.resource_id.length>180)return false;
    if(!Number.isSafeInteger(packet.scene_generation)||packet.scene_generation<this.scope.scene_generation)return false;
    if(!this.bind({...this.scope,resource_id:packet.resource_id,scene_generation:packet.scene_generation}))return false;
    if(Number.isSafeInteger(packet.sequence)){
      if(this.lastSequence!=null&&packet.sequence<=this.lastSequence)return false;
      if(this.lastSequence!=null&&packet.sequence>this.lastSequence+1)this.gap('runtime_sequence_gap',{from_sequence:this.lastSequence+1,to_sequence:packet.sequence-1},at);
      this.lastSequence=packet.sequence;
    }
    if(packet.kind==='event')return this.record({...packet.payload,sequence:packet.sequence,resource_id:packet.resource_id,scene_generation:packet.scene_generation},{at});
    if(packet.kind!=='snapshot')return false;
    const raw=packet.payload??{};let snapshot={},objects=[];
    try{
      for(const name of ['camera','truncated','scanned_nodes','text_input_regions','input_regions_complete','scene_generation','resource_id','mode','runtime_fault','observation_policy'])if(Object.hasOwn(raw,name))snapshot[name]=observationValue(raw[name]);
      for(const row of (Array.isArray(raw.objects)?raw.objects:[]).slice(0,this.limits.objects))objects.push(observationValue(row));
    }catch{this.gap('invalid_snapshot_payload',{},at);return false;}
    if(raw.objects?.length>this.limits.objects||raw.truncated)this.gap('object_budget',{limit:this.limits.objects},at);
    // Keep the current snapshot and its compact diff index within the same local
    // budget as frames/events. A single oversized observation is never retained.
    const snapshotBudget=Math.max(0,Math.floor(this.limits.localBytes/2));
    while(objects.length&&playContextBytes({...snapshot,objects})>snapshotBudget){objects.pop();snapshot.truncated=true;}
    if(playContextBytes({...snapshot,objects})>snapshotBudget)snapshot={truncated:true,input_regions_complete:false};
    if(objects.length<(raw.objects?.length??0))this.gap('snapshot_size_limit',{},at);
    const next=new Map(objects.map(row=>[objectKey(row),fingerprint(row)])),added=[],changed=[],removed=[];
    for(const [key,value]of next)if(!this.objects.has(key))added.push(key);else if(this.objects.get(key)!==value)changed.push(key);
    for(const key of this.objects.keys())if(!next.has(key))removed.push(key);
    if((added.length||changed.length||removed.length)&&at-this.lastDiff>=500){
      this.record({kind:'state_changed',source:'engine_observation',payload:{added:added.slice(0,64),changed:changed.slice(0,64),removed:removed.slice(0,64),truncated:Math.max(added.length,changed.length,removed.length)>64}},{at});this.lastDiff=at;
    }
    this.bytes-=this.snapshotBytes+this.mapBytes;this.objects=next;this.snapshot={...snapshot,objects,engine_time_ms:packet.engine_time_ms??null,tick:packet.tick??null,at_ms:at,scene_generation:packet.scene_generation,resource_id:packet.resource_id};
    this.snapshotBytes=playContextBytes(this.snapshot);this.mapBytes=[...next].reduce((sum,[key,value])=>sum+String(key).length*2+value.length*2,0);this.bytes+=this.snapshotBytes+this.mapBytes;
    this.lastSeen=Math.max(this.lastSeen,at);this.prune(at);return true;
  }
  addFrame(image,{at=this.now(),scope=this.scope}={}){
    if(!this.matches(scope)||image?.source_revision&&image.source_revision!==scope.source_revision||image?.scene_generation!=null&&image.scene_generation!==scope.scene_generation)return false;
    if(typeof image?.data_url!=='string'||image.data_url.length>this.limits.frameBytes*1.4){this.gap('frame_size_limit',{},at);return false;}
    const observedAt=this.snapshot.at_ms,offset=Number.isFinite(observedAt)?at-observedAt:null;
    const matching=this.snapshot.scene_generation===scope.scene_generation&&this.snapshot.resource_id===scope.resource_id;
    const frozen=matching&&image.mode==='inspect'&&this.snapshot.mode==='inspect',matchedTick=matching&&Number.isFinite(image.tick)&&image.tick===this.snapshot.tick;
    const synchronized=matching&&offset!==null&&offset>=0&&offset<=500&&(frozen||matchedTick);
    const projection={synchronized,status:synchronized?(frozen?'frozen_observation':'matched_tick'):'unsynchronized',observed_at_ms:observedAt??null,offset_ms:offset,
      tick:this.snapshot.tick??null,source:'client_engine_projected_bounds',objects:matching&&offset!==null&&offset>=0&&offset<=1500?this.snapshot.objects.slice(0,128).map(projectedRow):[]};
    const frame={id:`frame-${++this.serial}`,at_ms:at,captured_at:this.wallNow(),resource_id:scope.resource_id,scene_generation:scope.scene_generation,data_url:image.data_url,redacted_input_regions:image.redacted_input_regions??0,projection};
    const size=playContextBytes(frame);if(size>this.limits.localBytes){this.gap('frame_size_limit',{},at);return false;}this.frames.push(frame);this.bytes+=size;this.lastFrame=at;this.prune(at);return frame;
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
    while(this.bytes>this.limits.localBytes&&(this.frames.length||this.events.length)){
      const entry=this.frames.length?this.frames.shift():this.events.shift();this.bytes-=playContextBytes(entry);lost++;
    }
    if(this.bytes>this.limits.localBytes){this.snapshot={objects:[],truncated:true,input_regions_complete:false};this.objects.clear();this.snapshotBytes=playContextBytes(this.snapshot);this.mapBytes=0;this.bytes=this.snapshotBytes;lost++;}
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
    const dropFrame=()=>{const unrelated=frames.findIndex(frame=>frame.id!==value.focus.frame_id),index=unrelated<0?0:unrelated;const [removed]=frames.splice(index,1);if(removed.id===value.focus.frame_id)value.focus.runtime_ids=[];};
    while(playContextBytes(value)>this.limits.captureBytes&&frames.length>1){dropFrame();if(!value.gaps.some(g=>g.reason==='upload_frame_budget'))value.gaps.push({reason:'upload_frame_budget'});}
    while(playContextBytes(value)>this.limits.captureBytes&&value.events.length>1){value.events.splice(0,Math.ceil(value.events.length/4));if(!value.gaps.some(g=>g.reason==='upload_event_budget'))value.gaps.push({reason:'upload_event_budget'});}
    if(playContextBytes(value)>this.limits.captureBytes){value.snapshot.objects=value.snapshot.objects.slice(0,64);value.gaps.push({reason:'upload_object_budget'});}
    while(playContextBytes(value)>this.limits.captureBytes&&value.frames.length){dropFrame();if(!value.gaps.some(g=>g.reason==='upload_frame_budget'))value.gaps.push({reason:'upload_frame_budget'});}
    while(playContextBytes(value)>this.limits.captureBytes&&value.snapshot.objects.length)value.snapshot.objects.pop();
    if(playContextBytes(value)>this.limits.captureBytes)throw Error('试玩观察超过传输预算，请缩短片段或移除记录后发送');
    return copy(value);
  }
  summary(){
    if(!this.scope||this.closed)return null;
    return summarizePlayCapture(this.freeze({requestId:'summary'}));
  }
  close(){this.closed=true;this.scope=null;this.events=[];this.frames=[];this.snapshot={objects:[]};this.objects.clear();this.focus={kind:'none',runtime_ids:[]};this.bytes=0;this.snapshotBytes=0;this.mapBytes=0;this.gaps=[];}
}
