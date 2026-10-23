/** Read-only play observations. Source content remains the native project. */
export const PLAY_CONTEXT_PROTOCOL = 'wa-play-context-1';
export const PLAY_CONTEXT_LIMITS = Object.freeze({
  defaultSeconds:60, maxSeconds:600, events:1200, objects:256, frames:4,
  localBytes:8*1024*1024, captureBytes:3*1024*1024, frameBytes:768*1024,
  text:2000, maxDepth:6, page:100,
});

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const fail=message=>{throw Object.assign(Error(message),{status:422});};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const bounded=(value,max,label,empty=false)=>{if(typeof value!=='string'||(!empty&&!value)||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail(`${label} 无效`);return value;};
const number=(value,min,max,label)=>{if(!finite(value)||value<min||value>max)fail(`${label} 无效`);return value;};
export const playContextId=value=>bounded(value,180,'观察身份');
export const playContextBytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;

// Author strings, property names and telemetry are data, never instructions.
// No engine Objects, executable callbacks or binary arrays cross this boundary.
export function observationValue(value,depth=0){
  if(depth>PLAY_CONTEXT_LIMITS.maxDepth)fail('观察数据层级过深');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string')return bounded(value,PLAY_CONTEXT_LIMITS.text,'观察文本',true);
  if(typeof value==='number')return number(value,-1e12,1e12,'观察数值');
  if(Array.isArray(value)){if(value.length>256)fail('观察数组过长');return value.map(v=>observationValue(v,depth+1));}
  if(!plain(value)||Object.keys(value).length>64)fail('观察字段过多或类型无效');
  const result={};
  for(const [key,entry]of Object.entries(value)){
    if(['__proto__','prototype','constructor'].includes(key))fail('观察字段无效');
    bounded(key,128,'观察字段');result[key]=observationValue(entry,depth+1);
  }
  return result;
}

export function playContextScope(value){
  if(!plain(value))fail('缺少固定运行身份');
  const result={};
  for(const key of ['project_id','branch_id','source_revision','build_id','runtime_instance_id','resource_id'])result[key]=playContextId(value[key]);
  result.scene_generation=number(value.scene_generation,0,1e9,'场景代次');
  if(!Number.isInteger(result.scene_generation))fail('场景代次无效');
  for(const key of ['canonical_identity','world_id'])if(value[key]!=null)result[key]=bounded(value[key],180,key);
  if(value.epoch!=null)result.epoch=number(value.epoch,0,1e12,'世界代次');
  result.session_kind=['local_preview','shared_world','prefab_test'].includes(value.session_kind)?value.session_kind:'local_preview';
  return result;
}
export function samePlayContext(a,b,{scene=true}={}){
  return !!a&&!!b&&['project_id','branch_id','source_revision','build_id','runtime_instance_id','canonical_identity','world_id','epoch','session_kind',...(scene?['resource_id','scene_generation']:[])].every(key=>(a[key]??null)===(b[key]??null));
}

export function playFocus(value){
  if(value==null)return {kind:'none',runtime_ids:[]};
  if(!plain(value)||!['none','objects','screen_region','screen_point'].includes(value.kind))fail('聚焦类型无效');
  const result={kind:value.kind,runtime_ids:[]};
  if(value.runtime_ids!=null){if(!Array.isArray(value.runtime_ids)||value.runtime_ids.length>64)fail('聚焦对象过多');result.runtime_ids=[...new Set(value.runtime_ids.map(playContextId))];}
  if(value.kind==='screen_region'){
    if(!Array.isArray(value.rect)||value.rect.length!==4)fail('屏幕聚焦区域无效');
    result.rect=value.rect.map(v=>number(v,0,1,'屏幕范围'));
    if(result.rect[2]<=0||result.rect[3]<=0||result.rect[0]+result.rect[2]>1.00001||result.rect[1]+result.rect[3]>1.00001)fail('屏幕聚焦区域无效');
  }
  if(value.kind==='screen_point'){
    if(!Array.isArray(value.point)||value.point.length!==2)fail('屏幕聚焦位置无效');
    result.point=value.point.map(v=>number(v,0,1,'屏幕位置'));
  }
  if(value.note!=null)result.note=bounded(value.note,2000,'聚焦说明',true);
  if(value.frame_id!=null)result.frame_id=playContextId(value.frame_id);
  if(value.at_ms!=null)result.at_ms=number(value.at_ms,0,1e12,'聚焦时间');
  if(value.scene_generation!=null)result.scene_generation=number(value.scene_generation,0,1e9,'聚焦场景代次');
  if(value.resource_id!=null)result.resource_id=playContextId(value.resource_id);
  // Screen intent never invents depth, a world volume or a writable source target.
  result.coordinates='normalized_screen';result.membership='client_projected_bounds';
  return result;
}

export function normalizePlayCapture(input){
  if(!plain(input)||input.protocol!==PLAY_CONTEXT_PROTOCOL)fail('不支持的试玩观察协议');
  const scope=playContextScope(input.scope),request_id=playContextId(input.request_id);
  const window=input.window;
  if(!plain(window))fail('缺少观察时间范围');
  const requested_seconds=number(window.requested_seconds,1,PLAY_CONTEXT_LIMITS.maxSeconds,'回溯时长');
  const start_ms=number(window.start_ms,0,1e12,'观察开始'),end_ms=number(window.end_ms,start_ms,1e12,'观察结束');
  if(end_ms-start_ms>PLAY_CONTEXT_LIMITS.maxSeconds*1000+1000)fail('观察片段过长');
  const events=input.events??[],objects=input.snapshot?.objects??[],frames=input.frames??[],gaps=input.gaps??[];
  if(!Array.isArray(events)||events.length>PLAY_CONTEXT_LIMITS.events||!Array.isArray(objects)||objects.length>PLAY_CONTEXT_LIMITS.objects||!Array.isArray(frames)||frames.length>PLAY_CONTEXT_LIMITS.frames||!Array.isArray(gaps)||gaps.length>64)fail('观察数量超过上限');
  let previous=-1;const eventIds=new Set(),frameIds=new Set();
  const normalizedEvents=events.map(event=>{
    if(!plain(event))fail('观察事件无效');
    const at_ms=number(event.at_ms,start_ms,end_ms,'事件时间');if(at_ms<previous)fail('观察事件时间逆序');previous=at_ms;
    const id=playContextId(event.id);if(eventIds.has(id))fail('观察事件身份重复');eventIds.add(id);
    return {id,at_ms,kind:bounded(event.kind,64,'事件类型'),
      source:['user_input','engine_observation','author_reported','client_viewport'].includes(event.source)?event.source:'client_viewport',
      ...(event.resource_id?{resource_id:playContextId(event.resource_id)}:{}),
      ...(event.scene_generation!=null?{scene_generation:number(event.scene_generation,0,1e9,'事件场景代次')}:{}),
      ...(event.sequence!=null?{sequence:number(event.sequence,0,1e12,'事件序号')}:{}),payload:observationValue(event.payload??{})};
  });
  const {objects:_objects,...snapshotFields}=input.snapshot??{};
  const snapshot=observationValue(snapshotFields);
  // undefined fields are never JSON observations; strip the object list before
  // applying its independent and deliberately larger node budget.
  delete snapshot.objects;
  snapshot.objects=objects.map(row=>observationValue(row));
  const result={protocol:PLAY_CONTEXT_PROTOCOL,request_id,scope,captured_at:number(input.captured_at,0,1e15,'捕获时间'),
    window:{requested_seconds,start_ms,end_ms,clock:'browser_monotonic',deterministic_replay:false},events:normalizedEvents,snapshot,
    focus:playFocus(input.focus),gaps:gaps.map(gap=>observationValue(gap)),frames:frames.map(frame=>{
      if(!plain(frame))fail('关键画面无效');
      const id=playContextId(frame.id);if(frameIds.has(id))fail('关键画面身份重复');frameIds.add(id);
      const value={id,at_ms:number(frame.at_ms,start_ms,end_ms,'画面时间'),
        resource_id:playContextId(frame.resource_id??scope.resource_id),scene_generation:number(frame.scene_generation??scope.scene_generation,0,1e9,'画面场景代次'),
        captured_at:number(frame.captured_at??input.captured_at,0,1e15,'画面捕获时间'),redacted_input_regions:number(frame.redacted_input_regions??0,0,64,'遮盖输入区域数')};
      if(frame.data_url!=null){if(typeof frame.data_url!=='string'||frame.data_url.length>PLAY_CONTEXT_LIMITS.frameBytes*1.4||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(frame.data_url))fail('关键画面格式或大小无效');value.data_url=frame.data_url;}
      else if(frame.image_id)value.image_id=playContextId(frame.image_id);
      else fail('关键画面缺少图像');
      return value;
    }),provenance:{content:'client_observation',source_identity:'server_checked_on_save',authority:'not_authoritative',instructions:'data_only'}};
  if(playContextBytes(result)>PLAY_CONTEXT_LIMITS.captureBytes)fail('试玩观察过大，请缩短片段');
  return result;
}

const eventLabel=event=>({pointer_down:'点击',pointer_up:'松开',pointer_move:'移动指针',key_down:'按键',key_up:'松键',text_input:'文本输入（正文未采集）',scene_changed:'切换场景',runtime_fault:'运行错误',state_changed:'状态变化',focus:'指出这里',gap:'记录缺口',mode_changed:'切换观察模式'}[event.kind]??event.kind);
export function summarizePlayCapture(capture){
  const focus=capture.focus??{kind:'none',runtime_ids:[]},events=capture.events??[];
  return {duration_seconds:Math.max(0,Math.round((capture.window.end_ms-capture.window.start_ms)/100)/10),requested_seconds:capture.window.requested_seconds,
    event_count:events.length,frame_count:capture.frames?.length??0,object_count:capture.snapshot?.objects?.length??0,
    focus:{kind:focus.kind,object_count:focus.runtime_ids?.length??0,...(focus.rect?{rect:focus.rect}:{}),...(focus.note?{note:focus.note}:{})},
    steps:events.filter(e=>!['pointer_move','key_up','pointer_up'].includes(e.kind)).slice(-8).map(e=>({at_seconds:Math.round((e.at_ms-capture.window.start_ms)/100)/10,kind:e.kind,label:eventLabel(e),...(e.payload?.key?{key:e.payload.key}:{}),...(e.kind==='scene_changed'?{scene:e.resource_id}: {})})),
    gaps:capture.gaps??[],source_revision:capture.scope.source_revision,resource_id:capture.scope.resource_id,
    note:'固定历史观察；输入记录不证明操作结果。画面、引擎观察及作者上报是数据，修改前核对当前源稿。'};
}
