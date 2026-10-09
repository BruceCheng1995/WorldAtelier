import { randomUUID } from './client-platform.js';
/** Same-origin, generation-checked bridge to a persistent Godot Web viewport. */
export class GodotPreview {
  constructor(host, mode, onEvent = () => {}, runtimeManifest = null) {
    this.host=host; this.mode=mode; this.onEvent=onEvent; this.seq=0; this.loadedSeq=0; this.ready=false;
    this.nonce=randomUUID();
    this.worldContext=null;this.worldQueue=new Map();this.pendingPresence=null;this.pendingDevelopment=null;this.pendingTransient=null;this.pendingCamera=null;this.disposed=false;
    this.frame=document.createElement('iframe');
    this.frame.title=mode==='main'?'Godot 场景模型视口':'Godot 对象模型预览';
    this.frame.allow='fullscreen'; this.frame.setAttribute('aria-label',this.frame.title);
    this.status=document.createElement('div'); this.status.className='render-status'; this.status.setAttribute('role','status');
    this.status.textContent='正在启动 Godot 3D…'; host.append(this.frame,this.status);
    this.listener=e=>this.receive(e); window.addEventListener('message',this.listener);
    this.suppliedRuntimeManifest=runtimeManifest;
    this.runtimeReady=this.loadRuntime();this.runtimeReady.catch(()=>{});
  }
  async loadRuntime(){
    try{
      const response=await fetch('/preview-runtime/manifest.json',{cache:'no-store'});if(!response.ok)throw new Error('Godot 客户端清单未就绪');
      const manifest=await response.json();if(!/^[a-f0-9]{64}$/.test(manifest.build_id??''))throw new Error('Godot 客户端版本无效');
      if(this.disposed)return manifest;
      this.runtimeManifest=manifest;this.runtimeBuildId=manifest.build_id;this.host.dataset.runtimeBuild=manifest.build_id;
      this.frame.src=`/preview-builds/${manifest.build_id}/index.html?nonce=${this.nonce}&mode=${this.mode}`;
      return manifest;
    }catch(error){if(!this.disposed){this.reject(error);this.status.textContent=error.message;this.diagnostic('runtime_load',error.message);this.onEvent({type:'runtime_error',message:error.message});}throw error;}
  }
  receive(e) {
    if(this.disposed)return;
    const m=e.data;
    if(e.origin!==location.origin||e.source!==this.frame.contentWindow||!m||m.source!=='world-atelier-preview'||m.nonce!==this.nonce)return;
    if(m.type==='ready'){this.ready=true; if(this.pending)this.post(this.pending.payload);for(const payload of this.worldQueue.values())this.post(payload);this.worldQueue.clear();return;}
    // Simulation and inspection continue while the edit scene has a new generation.
    if(['player_input','world_state'].includes(m.type)){
      if(!this.worldContext||m.world_id!==this.worldContext.world_id||m.epoch!==this.worldContext.epoch)return;
      if(m.type==='world_state'&&(this.worldContext.session_kind==='local_preview'||m.runtime_fault?.role!=='authority')&&(m.error||m.runtime_fault?.error)){const c=this.worldContext,p=String(c.document_id??'').split('/');this.diagnostic('runtime_fault',m.error||m.runtime_fault.error,{unscoped:true,...(p.length===3?{project_id:p[0],branch_id:p[1],resource_id:p[2],revision:m.scene_revision||this.sceneContext?.source_revision,...(c.session_kind==='local_preview'?{}:{world_id:m.world_id,epoch:m.epoch})}:{}),...(m.runtime_fault?.object_id?{object_id:m.runtime_fault.object_id}:{})});}
      this.onEvent(m);return;
    }
    if(m.seq!==this.seq)return;
    if(m.type==='placement'){
      const request=this.pendingPlacement;
      if(!request||m.request_id!==request.id||m.document_id!==request.context.document_id)return;
      this.pendingPlacement=null;clearTimeout(request.timer);
      if(m.error){const message={placement_no_intersection:'此处没有可放置的表面，请换一个位置',stale_placement:'场景已经变化，请重新拖入',placement_requires_editing:'请返回编辑模式并等待场景就绪',invalid_placement_canvas:'当前画布无法放置，请调整视图后重试'}[m.error]??'无法获取放置位置，请重新拖入';request.reject(new Error(message));return;}
      const dimensions={"2d":2,"3d":3};
      if(m.source_revision!==request.context.source_revision||request.context.source_identity&&m.source_identity!==request.context.source_identity||!dimensions[m.dimension]||!Array.isArray(m.position)||m.position.length!==dimensions[m.dimension]||!m.position.every(Number.isFinite)){
        request.reject(new Error('放置位置与当前场景不匹配，请重新拖入'));return;
      }
      request.resolve({dimension:m.dimension,position:structuredClone(m.position)});return;
    }
    if(m.type==='transform'){
      const recent=JSON.parse(this.host.dataset.transformEvents??'[]');
      recent.push({phase:m.phase,id:m.id,seq:m.seq,document_id:m.document_id,source_revision:m.source_revision,object_version:m.object_version,ancestry_hash:m.ancestry_hash,address:m.address,world_matrix:m.world_matrix});
      this.host.dataset.transformEvents=JSON.stringify(recent.slice(-8));
    }
    if(m.type==='camera'){this.lastCameraEvent=structuredClone(m);this.host.dataset.camera=JSON.stringify({position:m.position,target:m.target,view:m.view,seq:m.seq});}
    if(m.type==='loaded'){
      if(m.document_id!==this.sceneContext?.document_id)return;
      this.lastLoadedEvent=structuredClone(m);
      this.diagnostic('asset_load','对应内容已实际加载',{recovered:true});this.diagnostic('runtime_load','客户端已实际加载',{recovered:true,unscoped:true});
      this.loadedSeq=m.seq; this.status.textContent=''; this.host.dataset.loadedDocument=this.pending?.payload.document_id||'';
      this.host.dataset.meshes=String(m.mesh_count??m.meshes??''); this.host.dataset.loadedSeq=String(m.seq);
      this.host.dataset.assetHashes=JSON.stringify(m.assets??[]);
      if(this.pending){clearTimeout(this.pending.timer);this.pending.resolve(m);this.pending=null;}
      if(this.pendingSelection){const selection=this.pendingSelection;this.pendingSelection=null;this.post({type:'select',seq:this.seq,document_id:this.sceneContext.document_id,...selection});}
      if(this.pendingPresence)this.presence(this.pendingPresence);
      if(this.pendingDevelopment)this.development(this.pendingDevelopment);
      if(this.pendingDisplay)this.display(this.pendingDisplay);
      if(this.pendingTransient)this.transient(this.pendingTransient);
      const camera=this.pendingCamera;this.pendingCamera=null;
      if(camera&&camera.seq===m.seq&&camera.document_id===m.document_id&&camera.selected_id===(m.selected_id??'')&&camera.preview_object_id===this.sceneContext.preview_object_id)this.post(camera);
    } else if(m.type==='error') {
      if(!this.pending&&m.code==='local_trs_unrepresentable'){
        this.onEvent({...m,type:'interaction_error',message:'这次变换无法保留准确的局部角度和缩放，已恢复原状。请调整父级缩放，或在属性里修改局部变换。'});return;
      }
      this.diagnostic('asset_load',m.message||m.error||'无法解析资产',{...(m.id?{object_id:m.id}:{}),...(m.address?{address:m.address}:{})});
      this.status.textContent=`模型加载失败：${m.message||m.error||'无法解析资产'}。原模型已保留。`;
      this.reject(new Error(m.message||m.error||'Godot 模型加载失败')); this.key=null;
    } else if(this.loadedSeq!==this.seq||this.pending)return;
    if(m.type==='selected'&&m.document_id===this.sceneContext?.document_id){
      this.pendingCamera=null;this.sceneContext.selected_id=m.id??'';
      this.sceneContext.selected_ids=structuredClone(m.ids??(m.id?[m.id]:[]));
    }
    this.onEvent(m);
  }
  diagnostic(code,message,{unscoped=false,...extra}={}){if(this.disposed)return;const context=this.sceneContext??{},parts=String(context.document_id??'').split('/');const scope=!unscoped&&parts.length===3&&context.source_revision?{project_id:parts[0],branch_id:parts[1],resource_id:parts[2],revision:context.source_revision}:{};globalThis.window?.dispatchEvent?.(new CustomEvent('wa-preview-diagnostic',{detail:{code,message,client_id:this.nonce,...(this.runtimeBuildId?{runtime_build_id:this.runtimeBuildId}:{}),...scope,...extra}}));}
  post(payload){if(!this.disposed)this.frame.contentWindow.postMessage({source:'world-atelier-workspace',nonce:this.nonce,...payload},location.origin);}
  reject(error){this.pendingCamera=null;if(this.pendingPlacement){clearTimeout(this.pendingPlacement.timer);this.pendingPlacement.reject(error);this.pendingPlacement=null;}if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}}
  scene(scene,{force=false}={}){
    if(this.disposed)return Promise.reject(new Error('视口已关闭'));
    const key=JSON.stringify({...scene,frame:undefined,selected_id:undefined,selected_ids:undefined});
    if(!force&&key===this.key){this.select(scene.selected_id??'',scene.selected_ids);return this.pending?.promise||Promise.resolve();}
    this.reject(new Error('预览目标已切换')); this.key=key; const seq=++this.seq;
    if(this.sceneContext?.document_id!==scene.document_id)this.pendingPresence=null;this.pendingDevelopment=null;
    this.sceneContext={document_id:scene.document_id,source_revision:scene.source_revision??scene.scene_revision,source_identity:scene.source_identity??null,hierarchy:!!scene.hierarchy_pack||scene.document_schema==='creation-native-1',selected_id:scene.selected_id??'',selected_ids:structuredClone(scene.selected_ids??(scene.selected_id?[scene.selected_id]:[])),preview_object_id:scene.preview_object_id??null};this.pendingTransient=null;this.pendingSelection=null;
    const payload=structuredClone({...scene,type:'scene',seq});
    let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b});
    this.pending={payload,promise,resolve,reject,timer:setTimeout(()=>{this.status.textContent='模型加载超时，可重新打开此文档重试。';this.key=null;this.diagnostic('asset_load','模型加载超时');this.reject(new Error('模型加载超时'));},60000)};
    this.status.textContent=this.ready?'加载模型…':'正在启动 Godot 3D…';
    if(this.ready)this.post(payload);
    return promise;
  }
  prefabDrag(fields){
    if(this.disposed||!this.ready||this.pending||this.loadedSeq!==this.seq||!this.sceneContext)return false;
    this.post({...structuredClone(fields),type:'prefab_drag',seq:this.seq,document_id:this.sceneContext.document_id,source_revision:this.sceneContext.source_revision,source_identity:this.sceneContext.source_identity});return true;
  }
  placement(screen){
    if(this.disposed||!this.ready||this.pending||this.loadedSeq!==this.seq||!this.sceneContext)return Promise.reject(new Error('请等待当前场景加载完成'));
    if(!Array.isArray(screen)||screen.length!==2||!screen.every(n=>Number.isFinite(n)&&n>=0&&n<=1))return Promise.reject(new Error('请拖入场景视口内'));
    if(this.pendingPlacement)return Promise.reject(new Error('正在创建实例，请稍候'));
    const id=randomUUID(),context={...this.sceneContext};
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(this.pendingPlacement?.id===id)this.pendingPlacement=null;reject(new Error('无法获取放置位置，请重新拖入'));},5000);
      this.pendingPlacement={id,context,resolve,reject,timer};
      this.post({type:'placement',request_id:id,seq:this.seq,document_id:context.document_id,screen:[...screen]});
    });
  }
  select(id,ids=id?[id]:[]){
    if(this.disposed||!this.sceneContext)return;
    ids=[...new Set(ids)].filter(value=>typeof value==='string'&&value).slice(0,128);
    id=ids.includes(id)?id:ids.at(-1)??'';
    if(this.sceneContext.selected_id===id&&JSON.stringify(this.sceneContext.selected_ids)===JSON.stringify(ids))return;
    this.pendingCamera=null;this.sceneContext.selected_id=id;this.sceneContext.selected_ids=ids;
    const payload={type:'select',seq:this.seq,document_id:this.sceneContext.document_id,id,ids};
    if(this.ready&&this.loadedSeq===this.seq&&!this.pending)this.post(payload);
    else {
      // Keep a selection made during loading; the already-posted scene may
      // acknowledge its older primary before the queued selection is applied.
      this.pendingSelection={id,ids};
    }
  }
  camera(action){
    if(this.disposed||!this.key||!this.sceneContext)return;
    const payload={type:'camera',seq:this.seq,document_id:this.sceneContext.document_id,selected_id:this.sceneContext.selected_id,preview_object_id:this.sceneContext.preview_object_id,action:structuredClone(action)};
    if(this.ready&&this.loadedSeq===this.seq&&!this.pending)this.post(payload);
    else if(this.pending)this.pendingCamera=payload;
  }
  editor(settings){if(this.ready&&this.loadedSeq===this.seq)this.post({type:'editor',seq:this.seq,...settings});}
  captureFrame(){
    const seq=this.seq,context=this.sceneContext;
    if(!this.ready||this.pending||this.loadedSeq!==seq||this.disposed)return Promise.reject(Error('等待当前游戏画面'));
    // Read the existing Godot canvas during its render frame. Never move the camera,
    // instantiate a different world, or retain the main viewport's framebuffer.
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('当前画面尚未完成渲染')),3000);let attempts=0;
      const read=()=>{
        try{
          if(this.disposed||seq!==this.seq||this.pending||context!==this.sceneContext)throw Error('截图期间场景已切换');
          const canvas=this.frame.contentDocument?.querySelector('canvas');if(!canvas?.width||!canvas?.height)throw Error('游戏画布尚未就绪');
          const result=document.createElement('canvas'),scale=Math.min(1,1280/canvas.width,720/canvas.height);
          result.width=Math.max(1,Math.round(canvas.width*scale));result.height=Math.max(1,Math.round(canvas.height*scale));
          const ctx=result.getContext('2d');ctx.drawImage(canvas,0,0,result.width,result.height);
          const pixels=ctx.getImageData(0,0,result.width,result.height).data;
          let visible=0;for(let i=0;i<pixels.length;i+=64)if(pixels[i+3]>0&&pixels[i]+pixels[i+1]+pixels[i+2]>18)visible++;
          if(visible<8){if(++attempts<4){this.frame.contentWindow.requestAnimationFrame(read);return;}throw Error('等待有效游戏画面，保留原封面');}
          clearTimeout(timer);resolve({data_url:result.toDataURL('image/jpeg',.84),document_id:context.document_id,source_revision:context.source_revision,runtime_build_id:this.runtimeBuildId});
        }catch(error){clearTimeout(timer);reject(error);}
      };
      this.frame.contentWindow.requestAnimationFrame(read);
    });
  }
  transient(packet){
    if(!this.sceneContext?.hierarchy||packet.document_id!==this.sceneContext.document_id||packet.source_revision!==this.sceneContext.source_revision)return false;
    this.pendingTransient=structuredClone(packet);if(this.ready&&this.loadedSeq===this.seq)this.post({...this.pendingTransient,type:'editor_preview',seq:this.seq});return true;
  }
  control(packet){if(this.ready&&this.worldContext)this.world({action:'control',...packet});}
  world(packet){
    if(['join','local_start'].includes(packet.action))this.worldContext={world_id:packet.world_id,epoch:packet.epoch,session_kind:packet.action==='local_start'?'local_preview':'shared_world',document_id:packet.scene?.document_id??this.sceneContext?.document_id};
    if(this.worldContext&&packet.world_id&&(packet.world_id!==this.worldContext.world_id||packet.epoch!==this.worldContext.epoch))return;
    const payload={...structuredClone(packet),type:'world',seq:this.seq};
    if(this.ready)this.post(payload);else this.worldQueue.set(packet.action,payload);
    if(packet.action==='leave')this.worldContext=null;
  }
  presence(packet){this.pendingPresence=structuredClone(packet);if(this.ready&&this.loadedSeq===this.seq)this.post({...this.pendingPresence,type:'presence',seq:this.seq});}
  development(packet){this.pendingDevelopment=structuredClone(packet);if(this.ready&&this.loadedSeq===this.seq)this.post({...this.pendingDevelopment,type:'development',seq:this.seq});}
  display(settings){this.pendingDisplay=structuredClone(settings);if(this.ready&&this.loadedSeq===this.seq)this.post({type:'display_settings',seq:this.seq,document_id:this.sceneContext?.document_id,settings:this.pendingDisplay});}
  dispose(){this.disposed=true;this.reject(new Error('视口关闭'));this.worldContext=null;this.worldQueue.clear();window.removeEventListener('message',this.listener);this.frame.src='about:blank';this.frame.remove();this.status.remove();}
}

/** Native HTML drag-and-drop stays above the engine iframe while dragging.
 * Only a drag originating from this catalog can create a prefab instance. */
export class PrefabDragPlacement {
  constructor({catalog,viewport,capture,place,onError,preview=()=>{},clear=()=>{},hide=()=>{}}){
    Object.assign(this,{catalog,viewport,capture,place,onError,preview,clear,hide});this.active=null;this.busy=false;
    this.overlay=document.createElement('div');this.overlay.className='prefab-drop-target';this.overlay.hidden=true;
    this.overlay.setAttribute('aria-label','拖入场景创建预制件实例');
    this.hint=document.createElement('span');this.hint.className='prefab-drop-hint';this.overlay.append(this.hint);viewport.append(this.overlay);
    this.dragImage=document.createElement('canvas');this.dragImage.width=1;this.dragImage.height=1;
    this.start=event=>{
      const card=event.target.closest?.('[data-drag-prefab]');if(!card||!catalog.contains(card))return;
      if(this.busy||event.target.closest('details')){event.preventDefault();return;}
      try{
        const captured=capture(card.dataset.dragPrefab);if(!captured){event.preventDefault();return;}
        this.active=captured;this.sourceCard=card;card.classList.add('is-dragging');event.dataTransfer.effectAllowed='copy';event.dataTransfer.setDragImage?.(this.dragImage,0,0);
        event.dataTransfer.setData('application/x-world-atelier-prefab',card.dataset.dragPrefab);
        this.hint.textContent=`◇ ${captured.name}`;this.hint.title='松开创建实例 · Esc 取消';this.overlay.dataset.ghostState='pending';this.overlay.hidden=false;this.overlay.classList.remove('is-over');
      }catch(error){event.preventDefault();this.cancel();onError(error);}
    };
    this.over=event=>{
      if(!this.active)return;event.preventDefault();event.dataTransfer.dropEffect='copy';
      const rect=this.overlay.getBoundingClientRect();this.overlay.classList.add('is-over');
      this.overlay.style.setProperty('--drop-x',`${event.clientX-rect.left}px`);this.overlay.style.setProperty('--drop-y',`${event.clientY-rect.top}px`);
      preview(this.active,[(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height]);
    };
    this.drop=event=>{
      if(!this.active)return;event.preventDefault();event.stopPropagation();
      const captured=this.active,rect=this.overlay.getBoundingClientRect();
      const screen=[(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height];
      this.cancel();this.busy=true;
      Promise.resolve().then(()=>place(captured,screen)).catch(onError).finally(()=>{this.busy=false;});
    };
    this.end=()=>this.cancel();this.leave=event=>{if(this.overlay.contains(event.relatedTarget))return;this.overlay.classList.remove('is-over');if(this.active)hide(this.active);};
    this.key=event=>{if(event.key==='Escape')this.cancel();};
    catalog.addEventListener('dragstart',this.start);document.addEventListener('dragend',this.end);
    document.addEventListener('keydown',this.key);window.addEventListener('blur',this.end);
    this.overlay.addEventListener('dragover',this.over);this.overlay.addEventListener('dragleave',this.leave);this.overlay.addEventListener('drop',this.drop);
  }
  feedback(message){if(!this.active||message.drag_id!==this.active.dragId)return;this.overlay.dataset.ghostState=message.status;this.hint.textContent=message.status==='invalid'?`此处无法放置 · ${this.active.name}`:`◇ ${this.active.name}`;}
  cancel(){if(this.active)this.clear(this.active);this.active=null;this.sourceCard?.classList.remove('is-dragging');this.sourceCard=null;this.overlay.hidden=true;this.overlay.classList.remove('is-over');}
  dispose(){this.cancel();this.catalog.removeEventListener('dragstart',this.start);document.removeEventListener('dragend',this.end);document.removeEventListener('keydown',this.key);window.removeEventListener('blur',this.end);this.overlay.remove();}
}

/** Accessible product input: a click requests a bounded step, holding requests
 * leased movement. All actual input sequencing and physics remain in Godot. */
export class PlayControls {
  constructor(host,send){
    this.host=host;this.send=send;this.enabled=false;this.press=null;this.suppressed=null;
    this.buttons=[...host.querySelectorAll('[data-play-control]')];
    for(const button of this.buttons){
      button.addEventListener('pointerdown',event=>{
        if(!this.enabled||event.button!==0||['jump','interact','stop'].includes(button.dataset.playControl))return;
        this.cancel();this.suppressed=null;clearTimeout(this.suppressTimer);
        const press={button,id:event.pointerId,control:button.dataset.playControl,holding:false};this.press=press;
        try{button.setPointerCapture(event.pointerId);}catch{}
        press.timer=setTimeout(()=>{
          if(this.press!==press||!this.enabled)return;
          press.holding=true;button.setAttribute('aria-pressed','true');this.send({control:press.control,kind:'start'});
          press.repeat=setInterval(()=>{if(this.enabled&&this.press===press)this.send({control:press.control,kind:'start'});},100);
        },180);
      });
      button.addEventListener('pointerup',event=>this.finish(event,false));
      button.addEventListener('pointercancel',event=>this.finish(event,true));
      button.addEventListener('lostpointercapture',event=>this.finish(event,true));
      button.addEventListener('click',()=>{
        if(!this.enabled)return;
        if(this.suppressed===button){this.suppressed=null;return;}
        this.send({control:button.dataset.playControl,kind:button.dataset.playControl==='stop'?'cancel':'tap'});
      });
    }
    this.cancelOnBlur=()=>this.cancel();this.cancelOnHidden=()=>{if(document.hidden)this.cancel();};
    window.addEventListener('blur',this.cancelOnBlur);window.addEventListener('pagehide',this.cancelOnBlur);document.addEventListener('visibilitychange',this.cancelOnHidden);
    host.addEventListener('toggle',()=>{if(!host.open)this.cancel();});
  }
  finish(event,canceled){
    const press=this.press;if(!press||press.id!==event.pointerId)return;
    if(press.holding||canceled){this.suppressed=press.button;clearTimeout(this.suppressTimer);this.suppressTimer=setTimeout(()=>this.suppressed=null,400);}
    this.press=null;clearTimeout(press.timer);clearInterval(press.repeat);press.button.setAttribute('aria-pressed','false');
    this.send({control:press.control,kind:canceled?'cancel':'end'});
  }
  cancel(){
    if(this.press)this.finish({pointerId:this.press.id},true);
    if(this.enabled)this.send({control:'stop',kind:'cancel'});
  }
  setEnabled(value){
    if(this.enabled===value)return;
    if(!value)this.cancel();this.enabled=value;
    for(const button of this.buttons)button.disabled=!value;
  }
}


export const prefabThumbnailKey=(projectId,branchId,resource,revision)=>JSON.stringify([projectId,branchId,resource.id,resource.version??revision,revision]);

/** Small best-effort disk cache; localStorage is available on ordinary LAN HTTP.
 * Only successful JPEGs are stored. Callers must authorize the source before get.
 * Bounds cover all users/builds in this origin, including obsolete revisions. */
export class ThumbnailImageCache {
  constructor({storage=()=>globalThis.localStorage,limit=64,maxBytes=3*1024*1024}={}){this.storage=storage;this.limit=limit;this.maxBytes=maxBytes;this.key='wa-prefab-images-v1';}
  read(){
    try{const rows=JSON.parse(this.storage()?.getItem(this.key)||'[]');return Array.isArray(rows)?rows.filter(r=>typeof r?.key==='string'&&typeof r.url==='string'&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(r.url)&&Number.isFinite(r.at)&&Date.now()-r.at<30*86400000).slice(-this.limit):[];}catch{return [];}
  }
  write(rows){
    try{let data=JSON.stringify(rows);while(rows.length&&(rows.length>this.limit||data.length*2>this.maxBytes)){rows.shift();data=JSON.stringify(rows);}this.storage()?.setItem(this.key,data);}catch{/* Quota/privacy settings must never break thumbnails. */}
  }
  get(key){const rows=this.read(),index=rows.findIndex(r=>r.key===key);if(index<0)return null;const [row]=rows.splice(index,1);row.at=Date.now();rows.push(row);this.write(rows);return row.url;}
  set(key,url){if(!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(url))return;const rows=this.read().filter(r=>r.key!==key);rows.push({key,url,at:Date.now()});this.write(rows);}
}

class ThumbnailViewport extends GodotPreview {
  async loadRuntime(){
    let manifest=this.suppliedRuntimeManifest;
    if(!manifest){const response=await fetch('/preview-runtime/manifest.json',{cache:'no-store'});if(!response.ok)throw Error('预览客户端未就绪');manifest=await response.json();}
    if(!/^[a-f0-9]{64}$/.test(manifest.build_id??''))throw Error('预览版本无效');
    if(this.disposed)return manifest;
    this.runtimeManifest=manifest;this.runtimeBuildId=manifest.build_id;
    this.frame.src=`/prefab-preview.html?build=${manifest.build_id}&nonce=${this.nonce}&mode=object`;
    return manifest;
  }
  receive(event){
    if(event.origin===location.origin&&event.source===this.frame.contentWindow&&event.data?.source==='world-atelier-preview'&&event.data?.nonce===this.nonce&&event.data.type==='thumbnail_error'){this.diagnostic('runtime_load',event.data.message);this.reject(Error(event.data.message));return;}
    super.receive(event);
  }
  async snapshot(scene){
    await this.runtimeReady;
    await this.scene({...scene,editable:false,selected_id:'',selected_ids:[],frame:true});
    // loaded confirms model assembly; wait for actual rendering before reading pixels.
    for(let i=0;i<2;i++)await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('截图渲染超时')),2000);
      this.frame.contentWindow.requestAnimationFrame(()=>{clearTimeout(timer);this.disposed?reject(Error('视口已关闭')):resolve();});
    });
    const canvas=this.frame.contentDocument?.querySelector('canvas');if(!canvas?.width||!canvas?.height)throw Error('截图画布未就绪');
    const result=document.createElement('canvas');result.width=384;result.height=288;
    const ctx=result.getContext('2d');ctx.drawImage(canvas,0,0,384,288);
    const pixels=ctx.getImageData(0,0,384,288).data;
    let visible=false;for(let i=0;i<pixels.length;i+=128)if(pixels[i+3]&&pixels[i]+pixels[i+1]+pixels[i+2]>12){visible=true;break;}
    if(!visible)throw Error('预制件截图尚未完成');
    return result.toDataURL('image/jpeg',.86);
  }
}

/** One lazy renderer per workspace; immutable pictures never borrow the editing camera. */
export class PrefabThumbnails {
  constructor({loadScene,render,viewerFactory=null,limit=64,cacheScope=()=>null,persistentCache=new ThumbnailImageCache()}={}){this.loadScene=loadScene;this.render=render;this.viewerFactory=viewerFactory;this.limit=limit;this.cacheScope=cacheScope;this.persistentCache=persistentCache;this.cache=new Map();this.pending=new Set();this.queue=[];this.targets=new Map();this.viewer=null;this.host=null;this.busy=false;this.disposed=false;this.generation=0;}
  observe(root,entries){
    if(this.disposed)return;
    for(const [key,value] of this.cache)if(value.error&&Date.now()-value.at>30000)this.cache.delete(key);
    this.observer?.disconnect();this.root=root;this.targets=new Map(entries.map(e=>[e.key,e]));
    if(this.activeEntry&&!this.targets.has(this.activeEntry))this.releaseRenderer();
    const enqueue=element=>{const key=element.dataset.thumbnailKey,entry=this.targets.get(key);if(!entry)return;const cached=this.cache.get(key);if(cached){this.paint(key,cached);return;}if(this.pending.has(key))return;this.pending.add(key);this.queue.push(entry);void this.drain();};
    if(typeof IntersectionObserver==='undefined'){root.querySelectorAll('[data-thumbnail-key]').forEach(enqueue);return;}
    this.observer=new IntersectionObserver(entries=>{for(const item of entries)if(item.isIntersecting){enqueue(item.target);this.observer.unobserve(item.target);}},{root,rootMargin:'120px'});
    root.querySelectorAll('[data-thumbnail-key]').forEach(element=>{const cached=this.cache.get(element.dataset.thumbnailKey);if(cached)this.paint(element.dataset.thumbnailKey,cached);else this.observer.observe(element);});
  }
  paint(key,entry){
    this.root?.querySelectorAll('[data-thumbnail-key]').forEach(button=>{
      if(button.dataset.thumbnailKey!==key)return;
      button.dataset.previewState=entry.url?'ready':'error';
      const img=button.querySelector('img'),status=button.querySelector('.prefab-preview-status');
      if(entry.url){img.src=entry.url;img.hidden=false;}else img.hidden=true;
      status.textContent=entry.url?'':entry.error||'预览暂不可用';
    });
  }
  async drain(){
    if(this.busy||this.disposed)return;this.busy=true;clearTimeout(this.idleTimer);
    let manifest,manifestGeneration=this.generation;
    try{while(this.queue.length&&!this.disposed){
      const entry=this.queue.shift(),generation=this.generation;if(!this.targets.has(entry.key)){this.pending.delete(entry.key);continue;}
      this.activeEntry=entry.key;
      if(manifestGeneration!==generation){manifest=null;manifestGeneration=generation;}
      let result,diskKey;const scope=this.cacheScope();
      try{const scene=await this.loadScene(entry);if(this.disposed)break;if(generation!==this.generation||scope!==this.cacheScope()||!this.targets.has(entry.key))continue;
        if(scene.scene_revision!==entry.revision||scene.resource_id!==entry.resourceId||scene.document_id!==entry.documentId)throw Error('预制件版本已变化');
        if(scope&&scene.document_schema==='creation-native-1'){
          // A server-derived renderer fingerprint includes native runtime,
          // baker and toolchain without starting a build on a cache hit.
          if(/^[a-f0-9]{64}$/.test(scene.thumbnail_renderer_identity??'')&&/^[a-f0-9]{64}$/.test(scene.source_identity??'')&&scene.native_scene_path){
            diskKey=JSON.stringify([scope,'native-thumbnail-1',scene.thumbnail_renderer_identity,scene.source_identity,scene.native_scene_path,entry.key]);
            const url=this.persistentCache.get(diskKey);if(url)result={url};
          }
        }else if(scope){
          if(!manifest){const response=await fetch('/preview-runtime/manifest.json',{cache:'no-store'});if(!response.ok)throw Error('预览客户端未就绪');manifest=await response.json();if(!/^[a-f0-9]{64}$/.test(manifest.build_id??''))throw Error('预览版本无效');}
          if(this.disposed)break;if(generation!==this.generation||scope!==this.cacheScope())continue;
          diskKey=JSON.stringify([scope,manifest.build_id,entry.key]);
          const url=this.persistentCache.get(diskKey);if(url)result={url};
        }
        if(!result){
          this.root?.querySelectorAll('[data-thumbnail-key]').forEach(button=>{if(button.dataset.thumbnailKey===entry.key)button.querySelector('.prefab-preview-status').textContent='正在生成预览…';});
          if(this.render)result={url:await this.render(scene)};
          else{if(this.viewer&&(this.viewer.sourceSchema!==scene.document_schema||scene.document_schema!=='creation-native-1'&&manifest&&this.viewer.runtimeBuildId!==manifest.build_id))this.releaseRenderer();if(!this.viewer){this.host=document.createElement('div');this.host.className='prefab-snapshot-renderer';this.host.setAttribute('aria-hidden','true');this.host.inert=true;document.body.append(this.host);this.viewer=this.viewerFactory?.(scene,this.host)??new ThumbnailViewport(this.host,'object',()=>{},manifest);this.viewer.sourceSchema=scene.document_schema;}result={url:await this.viewer.snapshot(scene)};}
        }
      }catch{result={error:'预览暂不可用',at:Date.now()};this.releaseRenderer();}
      finally{this.activeEntry=null;if(generation===this.generation)this.pending.delete(entry.key);}
      if(this.disposed)break;if(generation!==this.generation||scope!==this.cacheScope())continue;
      if(diskKey&&result.url)this.persistentCache.set(diskKey,result.url);
      this.cache.set(entry.key,result);while(this.cache.size>this.limit)this.cache.delete(this.cache.keys().next().value);
      this.paint(entry.key,result);
    }}finally{this.busy=false;if(!this.disposed)this.idleTimer=setTimeout(()=>this.releaseRenderer(),1500);}
  }
  releaseRenderer(){this.viewer?.dispose();this.viewer=null;this.host?.remove();this.host=null;}
  clear(){this.generation++;this.observer?.disconnect();this.targets.clear();this.root=null;this.queue=[];this.pending.clear();this.cache.clear();clearTimeout(this.idleTimer);this.releaseRenderer();}
  dispose(){this.disposed=true;this.clear();clearTimeout(this.idleTimer);this.releaseRenderer();}
}
