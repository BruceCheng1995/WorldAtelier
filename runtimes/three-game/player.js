import * as THREE from 'three';
import {previewClock,sceneTimers,hostFrame,cancelHostFrame} from './preview-clock.js';
import {HudObservation,compositeFrame} from './hud.js';
import {SceneObservation} from './inspection.js';
import {fitViewportSurface} from './three-control-layout.js';

const {identity,scenes,prefabs,storage:domain,viewportSettings}=JSON.parse(document.querySelector('#wa-game').textContent);
const surface=document.querySelector('#surface');
const canvas=document.querySelector('canvas'),ui=document.querySelector('#ui'),errorBox=document.querySelector('#error');
const params=new URLSearchParams(location.search),nonce=params.get('nonce');
const embedded=window!==parent&&params.get('wa_embedded')==='1'&&params.get('launch')==='editor'&&!!nonce;
const sourceStamp={canonical_identity:identity.content_key,source_revision:identity.source_revision,runtime_source_hash:identity.runtime_source_hash};
let renderer,game,world,source,sceneId,requestId,seq,generation=0,tick=0,mode='playing',previousTime=0,lastReport=0,raf=0,disposed=false,transitioning=false;
let inspectCamera=null,inspectTarget=null,drag=null,observations=null,selectedId='',frozenRows=[];
let loadTicket=0,activeGameTicket=0,contextSequence=0,lastSnapshot=0,inspectionView='perspective',selectionBox=null;
let hud,entryCapture=null,fault=null;
let preparingController=null,activeController=null;
const clock=embedded?previewClock(()=>transitioning?loadTicket:activeGameTicket):null;
const heldKeys=new Map(),heldPointers=new Map();
const overlay=new THREE.Scene();
const post=(type,data={})=>{
  if(embedded)parent.postMessage({source:'world-atelier-game',nonce,type,...sourceStamp,seq,scene_generation:generation,resource_id:sceneId,document_id:source?.document_id,scene_revision:identity.source_revision,...world,...data},location.origin);
};
function fail(reason){
  cancelHostFrame(raf);
  const text=reason instanceof Error?reason.message:String(reason);
  if(disposed||fault)return;
  errorBox.textContent=text;
  if(!embedded||!game||!source||!observations||!world){post('runtime_error',{message:text});disposed=true;return;}
  fault={error:text.slice(0,1024)};transitioning=false;++loadTicket;preparingController?.abort();
  contextEvent('runtime_fault',fault,'engine_observation');
  try{inspection({mode:'inspecting',request_id:requestId},true);}
  catch{clock?.pause(true);mode='inspecting';state();}
}
window.addEventListener('unhandledrejection',event=>fail(event.reason));
window.addEventListener('error',event=>fail(event.message));
function gameStorage(){
  const memory=new Map(),prefix='wa.three:'+JSON.stringify([identity.project_id,identity.branch_id,domain.namespace])+':';
  return {
    getItem:key=>embedded?memory.get(String(key))??null:localStorage.getItem(prefix+key),
    setItem(key,value){if(embedded)memory.set(String(key),String(value));else localStorage.setItem(prefix+key,value);},
    removeItem(key){if(embedded)memory.delete(String(key));else localStorage.removeItem(prefix+key);}
  };
}
const storage=gameStorage();
const prefabShards=new Map(),loadedPrefabPaths=new Set();
async function getPrefab(resourceId){
  if(typeof resourceId!=='string'||!Object.hasOwn(prefabs,resourceId))throw Error('预制件不属于本次固定构建');
  const filename=prefabs[resourceId];
  let pending=prefabShards.get(filename);
  if(!pending){
    pending=fetch(new URL(filename,location.href)).then(async response=>{
      if(!response.ok)throw Error('固定预制件读取失败 ('+response.status+')');
      const packets=await response.json();
      const fixed=scenes[identity.entry_scene_id];
      if(!Array.isArray(packets)||packets.some(packet=>packet?.kind!=='prefab'||prefabs[packet.resource_id]!==filename||packet.project_id!==identity.project_id||packet.branch_id!==identity.branch_id||packet.scene_revision!==identity.source_revision||packet.source_identity!==fixed.source_identity))throw Error('预制件与本次固定源版本不匹配');
      return new Map(packets.map(packet=>[packet.resource_id,packet]));
    });
    prefabShards.set(filename,pending);
    pending.catch(()=>{if(prefabShards.get(filename)===pending)prefabShards.delete(filename);});
    if(prefabShards.size>32)prefabShards.delete(prefabShards.keys().next().value);
  }
  const packet=(await pending).get(resourceId);
  if(!packet)throw Error('固定预制件数据缺失');
  loadedPrefabPaths.add(packet.native_scene_path);return structuredClone(packet);
}
function resizeCamera(camera,aspect){
  if(camera.isPerspectiveCamera)camera.aspect=aspect;
  else if(camera.isOrthographicCamera){
    const center=(camera.right+camera.left)/2,halfWidth=(camera.top-camera.bottom)*aspect/2;
    camera.left=center-halfWidth;camera.right=center+halfWidth;
  }else return;
  camera.updateProjectionMatrix();
}
let lastWidth,lastHeight,lastRatio;
function resize(force=false){
  const pixelRatio=Math.min(devicePixelRatio||1,2);
  fitViewportSurface(surface,viewportSettings,pixelRatio);
  if(!renderer||!game)return;
  const bounds=canvas.getBoundingClientRect(),width=Math.max(1,bounds.width),height=Math.max(1,bounds.height);
  if(!force&&width===lastWidth&&height===lastHeight&&pixelRatio===lastRatio)return;
  lastWidth=width;lastHeight=height;lastRatio=pixelRatio;
  if(renderer.getPixelRatio()!==pixelRatio)renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width,height,false);
  resizeCamera(game.camera,width/height);
  game.resize?.(width,height);
  if(inspectCamera){resizeCamera(inspectCamera,width/height);draw();}
}
function cameraReport(){
  const camera=inspectCamera??game.camera;
  const position=camera.getWorldPosition(new THREE.Vector3()),direction=camera.getWorldDirection(new THREE.Vector3());
  post('camera',{dimension:source.three_projection?.dimension==='2d'?'2d':'3d',position:position.toArray(),target:(inspectTarget??position.clone().add(direction)).toArray(),view:inspectCamera?inspectionView:'perspective',projection:camera.isPerspectiveCamera?'perspective':'orthographic'});
}
function state(){
  post('world_state',{mode,session_kind:'local_preview',request_id:requestId,runtime_ready:!fault,...(fault?{error:fault.error,runtime_fault:fault,requires_restart:true}:{}),tick,latest_tick:tick,applied_sequence:tick,latest_sequence:tick,latest_revision:identity.source_revision,
    ...(mode==='inspecting'?{frozen_tick:tick,frozen_sequence:tick,frozen_revision:identity.source_revision,inspection_ui_visible:!ui.hidden,inspection_objects:frozenRows}:{} )});
}
function draw(delta=0){
  if(!inspectCamera&&typeof game.render==='function'){
    const frame=renderer.info.render.frame;
    game.render(delta);
    if(renderer.info.render.frame===frame)throw Error('Web 游戏 render() 没有渲染当前帧');
  }else renderer.render(game.scene,inspectCamera??game.camera);
  if(inspectCamera&&selectionBox?.visible){
    const autoClear=renderer.autoClear;
    try{renderer.autoClear=false;renderer.clearDepth();renderer.render(overlay,inspectCamera);}
    finally{renderer.autoClear=autoClear;}
  }
}
function animate(now){
  if(disposed||transitioning||!game)return;
  try{
    const dt=previousTime?Math.min(.1,(now-previousTime)/1000):0;previousTime=now;
    if(mode==='playing'){game.update?.(dt);if(transitioning)return;tick++;}
    draw(dt);
    if(now-lastReport>250){state();lastReport=now;}
    if(embedded&&now-lastSnapshot>=1000){snapshot();lastSnapshot=now;}
    raf=hostFrame(animate);
  }catch(error){fail(error);}
}
function disposeScene(instance,controller,ticket){
  controller?.abort();
  try{if(clock)clock.owned(ticket,()=>instance?.dispose?.());else instance?.dispose?.();}
  finally{clock?.release(ticket);}
}
async function prepareScene(create,controller,ticket){
  if(controller.signal.aborted)return null;
  let onAbort;
  const canceled=new Promise(resolve=>{onAbort=()=>resolve(null);});
  controller.signal.addEventListener('abort',onAbort,{once:true});
  try{
    const creating=Promise.resolve(clock?clock.owned(ticket,create):create());
    const result=await Promise.race([creating,canceled]);
    if(controller.signal.aborted){
      clock?.release(ticket);
      // A transport may resolve after cancellation. Dispose its returned scene
      // without delaying the requested successor or changing its active scope.
      creating.then(instance=>disposeScene(instance,controller,ticket),()=>{}).catch(error=>console.warn('旧场景释放失败',error));
      return null;
    }
    return result;
  }finally{controller.signal.removeEventListener('abort',onAbort);}
}
let factory;
async function loadScene(resourceId,callerGeneration=generation){
  if(disposed||fault||inspectCamera||callerGeneration!==generation)return false;
  if(!Object.hasOwn(scenes,resourceId))throw Error('Web 入口场景不属于此固定版本');
  const ticket=++loadTicket,nextGeneration=generation+1;
  transitioning=true;cancelHostFrame(raf);
  preparingController?.abort();
  const controller=new AbortController();preparingController=controller;
  const timers=sceneTimers(controller.signal,clock,ticket);
  const nextUi=document.createElement('div');
  let candidate;
  try{
    factory??=(await import('wa:game')).createGame;
    if(typeof factory!=='function')throw Error('web/main.js 必须导出 createGame');
    // This callback belongs to the candidate. Retained callbacks from disposed
    // games cannot switch the workspace back to a stale scene generation.
    const create=()=>factory({THREE,renderer,canvas,ui:nextUi,signal:controller.signal,timers,entrySceneId:resourceId,source:structuredClone(scenes[resourceId]),storage,getPrefab,loadScene:id=>activeGameTicket===ticket?loadScene(id,nextGeneration):Promise.resolve(false)});
    candidate=await prepareScene(create,controller,ticket);
    if(ticket!==loadTicket||disposed){if(candidate)disposeScene(candidate,controller,ticket);return false;}
    if(!candidate?.scene?.isScene||!candidate.camera?.isCamera)throw Error('createGame 必须返回 Three.js scene 和 camera');
    if(activeGameTicket)disposeScene(game,activeController,activeGameTicket);
    activeController=controller;preparingController=null;heldKeys.clear();heldPointers.clear();entryCapture=null;
    game=candidate;sceneId=resourceId;source=scenes[sceneId];generation=nextGeneration;activeGameTicket=ticket;
    observations=new SceneObservation(game.scene,source,generation,loadedPrefabPaths);selectedId='';frozenRows=[];hud=new HudObservation(ui,generation);
    if(selectionBox)selectionBox.visible=false;
    ui.replaceChildren(nextUi);inspectCamera=null;inspectTarget=null;mode='playing';ui.inert=false;ui.hidden=false;
    resize(true);draw();
    let meshes=0;game.scene.traverseVisible(object=>{if(object.isMesh)meshes++;});
    transitioning=false;
    post('loaded',{mesh_count:meshes});state();cameraReport();contextEvent('scene_changed',{resource_id:sceneId},'engine_observation');
    previousTime=0;raf=hostFrame(animate);return true;
  }catch(error){
    controller.abort();clock?.release(ticket);
    if(ticket!==loadTicket||disposed)return false;
    preparingController=null;
    transitioning=false;throw error;
  }
}
function releaseInputs(){
  for(const [code,press] of heldKeys)press.target.dispatchEvent(new KeyboardEvent('keyup',{code,key:press.key,bubbles:true}));
  for(const [id,press] of heldPointers){
    press.target.dispatchEvent(new PointerEvent('pointercancel',{pointerId:id,pointerType:press.type,bubbles:true}));
    if(press.target.hasPointerCapture?.(id))press.target.releasePointerCapture(id);
  }
  heldKeys.clear();heldPointers.clear();
  if(document.pointerLockElement)document.exitPointerLock();
}
function inspection(action,failed=false){
  const next=action.mode;
  if(!['playing','inspecting'].includes(next))return;
  requestId=action.request_id;
  if(fault&&next==='playing'){state();return;}
  if(next!==mode){
    drag=null;
    if(next==='inspecting'){
      cancelHostFrame(raf);
      if(!failed){
        entryCapture=frameImage().catch(error=>({error:error.message}));
        releaseInputs();
      }
      mode=next;clock?.pause(true);
      ui.inert=true;ui.hidden=true;
      game.camera.updateWorldMatrix(true,false);inspectCamera=game.camera.clone(false);
      game.camera.matrixWorld.decompose(inspectCamera.position,inspectCamera.quaternion,inspectCamera.scale);
      observations.refresh();game.scene.updateMatrixWorld(true);frozenRows=observations.fixedRows(identity.source_revision,selectedId);
      inspectionView=source.three_projection?.dimension==='2d'?'canvas':'perspective';
      const center=observations.bounds().getCenter(new THREE.Vector3());
      const distance=Math.max(1,center.distanceTo(inspectCamera.position));
      inspectTarget=inspectCamera.position.clone().addScaledVector(inspectCamera.getWorldDirection(new THREE.Vector3()),distance);
      if(!failed)game.pause?.(true);
      canvas.focus();
    }else{
      mode=next;inspectCamera=null;inspectTarget=null;frozenRows=[];entryCapture=null;previousTime=0;
      ui.hidden=false;ui.inert=false;clock?.pause(false);game.pause?.(false);
      raf=hostFrame(animate);
    }
  }
  highlight();draw();cameraReport();state();snapshot();
}
function highlight(){
  const node=inspectCamera&&observations.ids.get(selectedId);
  if(!node){if(selectionBox)selectionBox.visible=false;return;}
  if(!selectionBox){selectionBox=new THREE.Box3Helper(new THREE.Box3(),0x82e1bd);overlay.add(selectionBox);}
  selectionBox.box.copy(observations.bounds(node));selectionBox.visible=!selectionBox.box.isEmpty();
}
function adjustCamera(action){
  if(typeof action==='object')action=action.view??action.action;
  const object=action==='focus'?observations.ids.get(selectedId):null;
  const bounds=observations.bounds(object);if(bounds.isEmpty())return;
  const sphere=bounds.getBoundingSphere(new THREE.Sphere());
  const views={top:[0,1,.0001],front:[0,0,1],right:[1,0,0],perspective:[1,.7,1]};
  if(!['fit','focus',...Object.keys(views)].includes(action))return;
  inspectTarget.copy(sphere.center);
  const direction=Object.hasOwn(views,action)?new THREE.Vector3(...views[action]).normalize():inspectCamera.getWorldDirection(new THREE.Vector3()).negate();
  const planar=source.three_projection?.dimension==='2d';
  if(Object.hasOwn(views,action)&&!planar){
    inspectionView=action;
    const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
    if(action==='perspective'&&!inspectCamera.isPerspectiveCamera)inspectCamera=new THREE.PerspectiveCamera(60,aspect,.02,30000);
    else if(action!=='perspective'&&!inspectCamera.isOrthographicCamera)inspectCamera=new THREE.OrthographicCamera(-aspect,aspect,1,-1,.02,30000);
    inspectCamera.up.set(0,action==='top'?0:1,action==='top'?1:0);
  }
  if(planar)direction.copy(game.camera.getWorldDirection(new THREE.Vector3())).negate();
  const radius=Math.max(.1,sphere.radius),camera=inspectCamera;
  let distance=radius*2;
  if(camera.isPerspectiveCamera){
    const tan=Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()*.5));
    distance=1.2*radius/Math.sin(Math.atan(tan*Math.min(1,camera.aspect)));
  }else if(camera.isOrthographicCamera){
    camera.zoom=Math.min(camera.right-camera.left,camera.top-camera.bottom)/(2.4*radius);camera.updateProjectionMatrix();
  }
  camera.position.copy(inspectTarget).addScaledVector(direction,distance);camera.lookAt(inspectTarget);
  draw();cameraReport();
}
function contextPacket(kind,payload,requestId=''){
  if(embedded&&world&&game&&!transitioning)post('play_context',{protocol:'wa-play-context-1',sequence:++contextSequence,runtime_instance_id:nonce,engine_time_ms:performance.now(),tick,kind,request_id:requestId,payload});
}
function contextEvent(kind,payload,source='user_input'){contextPacket('event',{kind,source,payload});}
function snapshotData(){
  const camera=inspectCamera??game.camera,scene=observations.snapshot(camera),dom=hud.snapshot(canvas,observations);
  // Put visible controls first: the focus projection retains a smaller subset
  // than the full observation when a game has hundreds of meshes.
  // Preserve room for world hits even in a large DOM HUD.
  const objects=[...dom.objects.slice(0,64),...scene.objects.slice(0,64),...dom.objects.slice(64),...scene.objects.slice(64)];
  return {...scene,objects:objects.slice(0,256),truncated:scene.truncated||dom.truncated||objects.length>256,mode:inspectCamera?'inspect':'play',
    resource_id:sceneId,scene_generation:generation,tick,text_input_regions:dom.text_input_regions,input_regions_complete:dom.input_regions_complete,
    ...(fault?{runtime_fault:fault}:{}),
    camera:{dimension:source.three_projection?.dimension==='2d'?'2d':'3d',position:camera.getWorldPosition(new THREE.Vector3()).toArray(),viewport_size:[canvas.clientWidth,canvas.clientHeight],projection:camera.isPerspectiveCamera?'perspective':'orthographic'}};
}
function snapshot(requestId=''){
  if(embedded&&game&&!transitioning&&!disposed)contextPacket('snapshot',snapshotData(),requestId);
}
let lastMotion=-Infinity;
function observeInput(type,event){
  if(!embedded||!world||!game||disposed||transitioning)return;
  if(!['keydown','keyup','pointerup','pointerdown','pointermove'].includes(type))return;
  if(event.target?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"])')){
    if(type==='keydown')contextEvent('text_input',{redacted:true,field_type:'DOM text input'});return;
  }
  if(type.startsWith('key')){
    if(event.repeat)return;
    contextEvent(type==='keydown'?'key_down':'key_up',{key:String(event.code).slice(0,40),shift:event.shiftKey,ctrl:event.ctrlKey,alt:event.altKey,meta:event.metaKey});return;
  }
  const rect=canvas.getBoundingClientRect(),at=performance.now();
  if(event.clientX<rect.left||event.clientX>=rect.right||event.clientY<rect.top||event.clientY>=rect.bottom)return;
  if(type==='pointermove'){if(at-lastMotion<100)return;lastMotion=at;}
  contextEvent({pointerdown:'pointer_down',pointerup:'pointer_up',pointermove:'pointer_move'}[type],{button:event.button,buttons:event.buttons,position:[(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height]});
}
async function frameImage(){
  draw();
  const payload=snapshotData(),stamp={tick,engine_time_ms:performance.now(),captured_at:Date.now(),frame_snapshot:payload};
  return {...stamp,...await compositeFrame(canvas,ui,payload)};
}
async function capture(packet){
  const at=generation,originalMode=mode;
  try{
    const frame=await (packet.inspection_entry?entryCapture:frameImage());
    if(at!==generation||mode!==originalMode||disposed)return;
    if(!frame||frame.error)throw Error(frame?.error||'当前检查没有保留暂停前画面');
    post('captured_frame',{request_id:packet.request_id,...frame});
  }catch(error){
    if(at===generation&&!disposed)post('captured_frame',{request_id:packet.request_id,error:error.message});
  }
}
addEventListener('message',async event=>{
  if(!embedded||disposed||event.source!==parent||event.origin!==location.origin)return;
  const packet=event.data;
  if(packet?.source!=='world-atelier-workspace'||packet.nonce!==nonce)return;
  try{
    if(packet.type==='start'&&!world){
      const entry=scenes[identity.entry_scene_id];
      if(packet.source_revision!==identity.source_revision||packet.document_id!==entry.document_id)throw Error('启动命令与固定场景不匹配');
      world={world_id:packet.world_id,epoch:packet.epoch};seq=packet.seq;requestId=packet.request_id;
      await loadScene(identity.entry_scene_id);return;
    }
    if(!world||transitioning||!game||packet.seq!==seq||packet.scene_generation!==generation)return;
    if(packet.type==='world'&&(packet.world_id!==world.world_id||packet.epoch!==world.epoch))return;
    if(packet.type==='world'&&packet.action==='mode')inspection(packet);
    if(packet.type==='world'&&packet.action==='inspection_ui'&&mode==='inspecting'){ui.hidden=!packet.visible;state();}
    if(packet.type==='world'&&packet.action==='control'&&mode==='playing')game.control?.(packet);
    if(packet.document_id&&packet.document_id!==source.document_id)return;
    if(packet.type==='select'&&mode==='inspecting'){selectedId=observations.ids.has(packet.id)?packet.id:'';highlight();draw();}
    if(packet.type==='camera'&&mode==='inspecting')adjustCamera(packet.action);
    if(packet.type==='context_request'&&packet.action==='snapshot')snapshot(packet.request_id);
    if(packet.type==='capture_frame'&&packet.document_id===source.document_id)capture(packet);
  }catch(error){fail(error);}
});
// Capture-phase interception suspends the game's normal DOM input in inspect mode.
for(const type of ['pointerdown','pointermove','pointerup','pointercancel','click','dblclick','contextmenu','keydown','keyup','wheel']){
  window.addEventListener(type,event=>{
    if((event.target===document.body||event.target===document.documentElement)&&['pointerdown','click','dblclick','contextmenu','wheel'].includes(type)){
      event.stopImmediatePropagation();return;
    }
    if(mode==='playing'){
      if(type==='keydown'&&!event.repeat)heldKeys.set(event.code,{key:event.key,target:event.target});
      if(type==='keyup')heldKeys.delete(event.code);
      if(type==='pointerdown')heldPointers.set(event.pointerId,{type:event.pointerType,target:event.target});
      if(type==='pointerup'||type==='pointercancel')heldPointers.delete(event.pointerId);
    }
    if(event.isTrusted)observeInput(type,event);
    if(!inspectCamera)return;
    event.stopImmediatePropagation();event.preventDefault();
    if(type==='click'&&event.button===0){
      const rect=canvas.getBoundingClientRect(),row=observations.pick(inspectCamera,(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height);
      selectedId=row?.id??'';highlight();draw();post('selected',{id:selectedId,...(row?{address:row.address}:{})});return;
    }
    if(type==='pointerdown'&&event.button===2){drag={x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);}
    if(type==='pointerup'||type==='pointercancel')drag=null;
    const offset=inspectCamera.position.clone().sub(inspectTarget);
    if(type==='pointermove'&&drag){
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag={x:event.clientX,y:event.clientY};
      if(event.shiftKey||source.three_projection?.dimension==='2d'){
        const right=new THREE.Vector3(1,0,0).applyQuaternion(inspectCamera.quaternion),up=new THREE.Vector3(0,1,0).applyQuaternion(inspectCamera.quaternion);
        inspectTarget.addScaledVector(right,-dx*offset.length()*.002).addScaledVector(up,dy*offset.length()*.002);
      }else{
        const s=new THREE.Spherical().setFromVector3(offset);s.theta-=dx*.008;s.phi-=dy*.008;s.makeSafe();offset.setFromSpherical(s);
      }
    }else if(type==='wheel'){
      if(inspectCamera.isOrthographicCamera){inspectCamera.zoom*=Math.exp(-Math.sign(event.deltaY)*.15);inspectCamera.updateProjectionMatrix();}
      else offset.multiplyScalar(Math.exp(Math.sign(event.deltaY)*.15));
    }else if(type==='keydown'&&drag){
      const keys={KeyW:[0,0,-1],KeyS:[0,0,1],KeyA:[-1,0,0],KeyD:[1,0,0]};
      if(!keys[event.code])return;
      inspectTarget.addScaledVector(new THREE.Vector3(...keys[event.code]).applyQuaternion(inspectCamera.quaternion),Math.max(.05,offset.length()*.05));
    }else return;
    inspectCamera.position.copy(inspectTarget).add(offset);inspectCamera.lookAt(inspectTarget);draw();cameraReport();
  },{capture:true,passive:false});
}
const viewportObserver=new ResizeObserver(()=>resize());
viewportObserver.observe(surface);
window.addEventListener('resize',()=>resize());
window.addEventListener('pagehide',()=>{disposed=true;preparingController?.abort();activeController?.abort();viewportObserver.disconnect();++loadTicket;cancelHostFrame(raf);selectionBox?.dispose();if(activeGameTicket)disposeScene(game,activeController,activeGameTicket);renderer?.dispose();},{once:true});
try{
  resize();
  renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
  if(embedded)post('ready',{capabilities:['canonical-game-runtime','capture-frame-1','inspection-entry-frame-1']});
  else loadScene(identity.entry_scene_id).catch(fail);
}catch(error){fail(error);}
