import {randomUUID} from './client-platform.js';
import {portableAnnotations} from '../../packages/contracts/viewport-annotations.mjs';
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function copyAnnotationText(text){
  if(navigator.clipboard?.writeText&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}
  const field=document.createElement('textarea');field.value=text;field.style.cssText='position:fixed;left:-10000px;top:0';document.body.append(field);field.select();
  try{if(!document.execCommand('copy'))throw Error('复制失败，请重试');}finally{field.remove();}
}
const axes=plane=>plane==='xy'?[0,1,2]:plane==='yz'?[2,1,0]:[0,2,1];
const finite=v=>Number.isFinite(v)&&Math.abs(v)<=1e6;
const markPacket=a=>({id:a.id,annotation_kind:a.annotation_kind??a.kind,dimension:a.dimension,position:a.position,geometry:a.geometry??{},object_ids:(a.members??[]).map(m=>m.object_id),processing:!!a.processing});
const labelFor=a=>a.annotation_kind==='objects'?`对象集合 · ${a.members.length} 个`:a.annotation_kind==='region'?(a.geometry?.shape==='box'?'三维区域':'空间区域'):a.annotation_kind==='point'?'空间描点':a.members[0]?.name??'对象批注';
export class ViewportAnnotations{
  constructor({viewport,button,scope,preview,save,screenshot=null,onError,onChange=()=>{},onCopied=()=>{}}){
    Object.assign(this,{viewport,button,scope,preview,save,screenshot,onError,onChange,onCopied});
    Object.assign(this,{active:false,busy:false,tool:'point',target:'objects',brushTarget:'objects',plane:'xz',planeOffset:0,depth:2,radius:28,worldRadius:1,items:[],processing:[],documentKey:null,batch:randomUUID(),pinNodes:new Map(),lastCommand:'',adjusting:false});
    this.root=document.createElement('div');this.root.className='annotation-layer';
    this.root.innerHTML=`<div class="annotation-pins"></div><div class="annotation-tools" hidden><div class="annotation-toolbar" role="toolbar" aria-label="批注工具"><button type="button" data-annotation-tool="point" data-target="objects" title="精确点击模型表面">选对象</button><button type="button" data-annotation-tool="point" data-target="space" title="在固定工作平面放置空间坐标">空间描点</button><button type="button" data-annotation-tool="rect" data-target="objects" title="框选只收集对象">框选对象</button><button type="button" data-annotation-tool="brush">笔刷</button><button type="button" data-annotation-tool="volume" data-target="space" data-3d-only title="画底面，再调整三维区域尺寸">三维区域</button><span class="annotation-count"></span><button type="button" data-annotation-finish class="annotation-primary">完成批注</button><button type="button" data-annotation-menu title="批注操作" aria-label="更多批注操作">⋯</button><div class="annotation-actions" hidden><button type="button" data-annotation-copy>复制全部</button><button type="button" data-annotation-discard>取消全部</button></div></div><div class="annotation-options"><label class="annotation-brush-target" hidden>用途<select aria-label="笔刷用途"><option value="objects">选择对象</option><option value="space">描述空间区域</option></select></label><label class="annotation-radius" hidden>大小<input type="range" min="8" max="100" value="28" aria-label="批注笔刷大小"></label><label class="annotation-world-radius" hidden>半径 m<input type="number" value="1" min="0.05" max="10000" step="0.25" aria-label="空间笔刷半径"></label><div class="annotation-plane-controls" hidden><label>工作平面<select aria-label="批注工作平面"><option value="xz">XZ 水平</option><option value="xy">XY 正面</option><option value="yz">YZ 侧面</option></select></label><label>偏移 m<input type="number" value="0" min="-1000000" max="1000000" step="0.25" aria-label="工作平面偏移"></label><label class="annotation-depth" hidden>厚度 m<input type="number" value="2" min="0.05" max="10000" step="0.25" aria-label="区域厚度"></label><button type="button" data-annotation-align>正对平面</button><button type="button" data-annotation-center>在中心创建</button></div><span class="annotation-hint" role="status"></span></div></div><aside class="annotation-list" aria-label="待发送批注" hidden></aside><form class="annotation-bubble" aria-label="输入批注" hidden><div class="annotation-bubble-head"><strong></strong><button type="button" data-annotation-cancel aria-label="取消当前批注">×</button></div><div class="annotation-context"></div><div class="annotation-spatial-fields" hidden><div class="annotation-vector" data-vector="position"><span>位置 m</span>${['X','Y','Z'].map((a,i)=>`<label>${a}<input type="number" step="any" min="-1000000" max="1000000" data-coordinate="${i}" aria-label="批注位置 ${a}"></label>`).join('')}</div><div class="annotation-vector" data-vector="size" hidden><span>尺寸 m</span>${['X','Y','Z'].map((a,i)=>`<label>${a}<input type="number" step="any" min="0.05" max="10000" data-size="${i}" aria-label="区域尺寸 ${a}"></label>`).join('')}</div><label class="annotation-edit-depth" hidden>区域厚度 m<input type="number" min="0.05" max="10000" step="any" aria-label="调整区域厚度"></label><button type="button" data-annotation-focus>聚焦批注</button><small class="annotation-adjust-hint">拖动坐标轴移动；拖动区域面上的方块调整范围。</small></div><label><span class="sr">批注描述</span><textarea rows="3" maxlength="2000" placeholder="描述这里需要怎样修改…" aria-label="批注描述"></textarea></label><div class="annotation-bubble-actions"><small>⌘ / Ctrl + Enter 保存 · Esc 取消</small><button type="button" data-annotation-delete hidden>删除</button><button type="submit" class="annotation-primary">保存批注</button></div></form>`;
    viewport.append(this.root);this.pins=this.root.querySelector('.annotation-pins');this.tools=this.root.querySelector('.annotation-tools');this.bar=this.root.querySelector('.annotation-toolbar');this.list=this.root.querySelector('.annotation-list');this.bubble=this.root.querySelector('form');this.field=this.bubble.querySelector('textarea');this.hint=this.root.querySelector('.annotation-hint');
    const q=selector=>this.root.querySelector(selector);
    if(screenshot){const capture=document.createElement('button');capture.type='button';capture.dataset.annotationScreenshot='';capture.textContent='截图划线';capture.title='截取当前画面，用自由线、箭头和方框说明意图';q('[data-annotation-tool=volume]').after(capture);capture.onclick=()=>this.annotateScreenshot().catch(onError);}
    button.onclick=()=>{if(this.active)this.finish().catch(onError);else this.enter();};
    this.root.querySelectorAll('[data-annotation-tool]').forEach(b=>b.onclick=()=>{this.cancelBubble(false);this.tool=b.dataset.annotationTool;this.target=b.dataset.target??this.brushTarget;this.awaitMode();this.render();this.command();this.focusViewport();});
    q('[aria-label="笔刷用途"]').onchange=e=>{this.cancelBubble(false);this.target=this.brushTarget=e.target.value;this.awaitMode();this.render();this.command();this.focusViewport();};
    const setting=(label,property)=>q(`[aria-label="${label}"]`).onchange=e=>{const value=Number(e.target.value);if(!finite(value)||property!=='planeOffset'&&value<=0)return;this[property]=value;this.command();};
    setting('批注笔刷大小','radius');setting('空间笔刷半径','worldRadius');setting('工作平面偏移','planeOffset');setting('区域厚度','depth');
    q('[aria-label="批注工作平面"]').onchange=e=>{this.plane=e.target.value;this.command();};
    q('[data-annotation-align]').onclick=()=>{this.command({action:'align_plane'});this.focusViewport();};
    q('[data-annotation-focus]').onclick=()=>{this.command({action:'focus_edit'});this.focusViewport();};
    q('[data-annotation-center]').onclick=()=>this.command({action:'create_center'});
    q('[data-annotation-finish]').onclick=()=>this.finish().catch(onError);
    q('[data-annotation-menu]').onclick=()=>q('.annotation-actions').hidden=!q('.annotation-actions').hidden;
    q('[data-annotation-discard]').onclick=()=>{if(this.busy)return;this.items=[];this.batch=randomUUID();this.active=false;this.cancelBubble(false);this.persist();this.render();this.command();onChange();};
    q('[data-annotation-copy]').onclick=()=>this.copy().catch(onError);
    q('[data-annotation-cancel]').onclick=()=>this.cancelBubble();q('[data-annotation-delete]').onclick=()=>{if(this.pending)this.remove(this.pending.id);};
    this.bubble.onsubmit=e=>{e.preventDefault();this.commitBubble();};
    this.bubble.querySelectorAll('input[type=number]').forEach(input=>{input.onchange=()=>this.adjustFields();input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();input.blur();}};});
    this.field.onkeydown=e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();this.cancelBubble();}else if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();this.commitBubble();}};
    this.root.addEventListener('pointerdown',e=>e.stopPropagation());this.root.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'&&!e.defaultPrevented){e.preventDefault();this.escape();}});
  }
  dimension(){return this.preview()?.lastLoadedEvent?.dimension??'3d';}
  storageKey(scope){return `wa-viewport-annotations-v1:${scope.user_id}:${scope.project_id}:${scope.branch_id}:${scope.resource_id}`;}
  update(){
    const scope=this.scope(),key=scope?this.storageKey(scope):null;
    if(key!==this.documentKey){
      clearTimeout(this.modeTimer);this.root.classList.remove('is-entering');this.documentKey=key;this.batchScope=scope;this.active=false;this.pending=null;this.items=[];this.processing=[];this.batch=randomUUID();this.bubble.hidden=true;this.lastCommand='';
      if(key)try{const saved=JSON.parse(localStorage.getItem(key));if(Array.isArray(saved?.items)&&saved.items.length<=64){this.items=saved.items;this.batch=saved.batch??this.batch;}}catch{}
      this.render();this.command();
    }
    if(this.active&&!scope?.editing){this.active=false;this.pending=null;this.bubble.hidden=true;this.render();this.command();}
    this.pins.hidden=!scope?.editing;this.button.disabled=!scope?.available||this.busy;
  }
  enter(){this.update();if(this.button.disabled)return;this.active=true;if(this.dimension()==='2d'&&(this.tool==='volume'||this.tool==='brush'&&this.target==='space')){this.tool='point';this.target='objects';}this.awaitMode();this.render();this.command();this.onChange();this.focusViewport();}
  awaitMode(){clearTimeout(this.modeTimer);this.root.classList.add('is-entering');this.modeTimer=setTimeout(()=>{this.root.classList.remove('is-entering');this.active=false;this.render();this.command();this.onChange();this.onError(Error('批注工具尚未就绪，请刷新工作台后重试'));},5000);}
  focusViewport(){this.preview()?.frame?.contentWindow?.focus();}
  spatialEditable(){return this.pending?.dimension==='3d'&&(this.pending.annotation_kind==='point'||['box','prism'].includes(this.pending.geometry?.shape))&&this.pending.source_revision===this.scope()?.revision;}
  command(extra={}){
    const preview=this.preview();if(!this.active){clearTimeout(this.modeTimer);this.root.classList.remove('is-entering');}if(!preview?.ready||preview.pending||preview.loadedSeq!==preview.seq)return;
    const items=[...this.items,...this.processing].filter(a=>a.id!==this.pending?.id);if(this.pending)items.push(this.pending);
    const packet={type:'annotation',seq:preview.seq,document_id:preview.sceneContext.document_id,enabled:this.active,suspended:!!this.pending||this.busy,tool:this.tool,target:this.target,plane:this.plane,plane_offset:this.planeOffset,depth:this.depth,radius:this.radius,world_radius:this.worldRadius,marks:this.scope()?.editing?items.map(markPacket):[],edit:this.spatialEditable()?markPacket(this.pending):null,...extra};
    const signature=JSON.stringify(packet);if(signature===this.lastCommand&&!extra.action&&!extra.adjust&&!this.root.classList.contains('is-entering'))return;this.lastCommand=signature;
    this.root.dataset.command=JSON.stringify({seq:preview.seq,document_id:preview.sceneContext.document_id,enabled:this.active,tool:this.tool,target:this.target});preview.post(packet);
  }
  loaded(){this.lastCommand='';this.update();this.render();this.command();}
  accept(message){
    if(message.type==='annotation_state'){this.root.dataset.engineEnabled=String(message.enabled);if(message.enabled===this.active&&message.tool===this.tool&&message.target===this.target&&message.suspended===Boolean(this.pending||this.busy)){clearTimeout(this.modeTimer);this.root.classList.remove('is-entering');}return;}
    if(message.type==='annotation_projection'){
      for(const mark of message.marks??[]){const pin=this.pinNodes.get(mark.id),[x,y]=mark.screen;if(pin){pin.hidden=x<0||x>1||y<0||y>1;pin.style.left=`${x*100}%`;pin.style.top=`${y*100}%`;}if(this.pending?.id===mark.id){this.pending.screen=mark.screen;this.placeBubble(mark.screen);}}
      return;
    }
    if(message.type==='annotation_cancel'){this.escape();return;}
    if(message.type==='annotation_error'){this.adjusting=false;this.updateSpatialFields();this.onError(Error(message.message));return;}
    if(message.type==='annotation_adjustment'){
      if(!this.pending||message.id!==this.pending.id||message.source_revision!==this.pending.source_revision)return;
      const members=this.members(message.object_ids);if(!members)return;this.adjusting=!message.final;if(message.final)this.invalid=message.valid===false;Object.assign(this.pending,{position:message.position,geometry:message.geometry,members});this.describePending();this.updateSpatialFields();return;
    }
    if(message.type!=='annotation_candidate'||!this.active||this.busy)return;
    const scope=this.scope(),preview=this.preview();if(!scope?.available||message.document_id!==preview?.sceneContext?.document_id||message.seq!==preview.seq||message.source_revision!==scope.revision||preview.sceneContext.source_identity&&message.source_identity!==preview.sceneContext.source_identity)return;
    const members=this.members(message.object_ids);if(!members)return;
    this.openBubble({id:randomUUID(),annotation_kind:message.kind,kind:message.kind,note:'',revision:scope.revision,source_revision:scope.revision,resource_id:scope.resource_id,resource_name:scope.resource_name,dimension:message.dimension,position:message.position,geometry:message.geometry,screen:message.screen,camera:preview.lastCameraEvent?.seq===message.seq&&preview.lastCameraEvent?.document_id===message.document_id?{position:preview.lastCameraEvent.position,target:preview.lastCameraEvent.target,view:preview.lastCameraEvent.view,projection:preview.lastCameraEvent.projection}:null,members});
  }
  members(ids){const objects=new Map(this.scope().objects.map(o=>[o.id,o])),members=ids.map(id=>objects.get(id));if(members.some(m=>!m)){this.onError(Error('场景已变化，请重新选择批注范围'));return null;}return members.map(m=>({object_id:m.id,name:m.name,address:m.address}));}
  openBubble(item){
    this.pending=structuredClone(item);this.invalid=false;this.adjusting=false;this.bubble.hidden=false;this.root.classList.add('has-pending');this.field.value=item.note;this.describePending();this.updateSpatialFields();this.bubble.querySelector('[data-annotation-delete]').hidden=!this.items.some(a=>a.id===item.id);this.placeBubble(item.screen??[.5,.5]);this.command();this.field.focus();
  }
  describePending(){const a=this.pending;if(!a)return;this.bubble.querySelector('strong').textContent=labelFor(a);this.bubble.querySelector('.annotation-context').textContent=a.annotation_kind==='objects'||a.annotation_kind==='region'?`${a.members.length} 个对象${a.members.length?' · '+a.members.map(m=>m.name).join('、'):' · 空间范围内暂无对象'}`:`${a.position.map(n=>Number(n.toFixed(2))).join(', ')} ${a.dimension==='2d'?'px':'m'}`;}
  updateSpatialFields(){
    const a=this.pending;if(!a)return;const spatial=a.dimension==='3d'&&['point','region'].includes(a.annotation_kind),geometry=a.geometry;
    this.bubble.classList.toggle('is-spatial',spatial);this.bubble.querySelector('.annotation-spatial-fields').hidden=!spatial;this.bubble.querySelector('[data-vector=size]').hidden=geometry?.shape!=='box';this.bubble.querySelector('.annotation-edit-depth').hidden=geometry?.shape!=='prism';
    this.bubble.querySelectorAll('[data-coordinate]').forEach(input=>{if(document.activeElement!==input)input.value=Number((a.position[Number(input.dataset.coordinate)]??0).toFixed(3));});
    this.bubble.querySelectorAll('[data-size]').forEach(input=>{if(geometry?.size&&document.activeElement!==input)input.value=Number(geometry.size[Number(input.dataset.size)].toFixed(3));});
    const depth=this.bubble.querySelector('[aria-label="调整区域厚度"]');if(document.activeElement!==depth)depth.value=geometry?.depth??2;
    this.bubble.querySelectorAll('input').forEach(input=>input.disabled=!this.spatialEditable()||this.busy);
    this.bubble.querySelector('.annotation-adjust-hint').textContent=this.invalid?'范围超过 512 个对象，请缩小范围后保存。':this.spatialEditable()?(geometry?.shape==='box'?'拖动坐标轴移动；拖动方块调整范围。':'拖动坐标轴或直接输入 XYZ；坐标不随视角改变。'):'保留捕获时的旧版本坐标，可编辑批注文字。';
    this.bubble.querySelector('[type=submit]').disabled=this.adjusting||this.invalid||this.busy;
  }
  adjustFields(){
    if(!this.spatialEditable()||this.busy)return;
    const position=[...this.bubble.querySelectorAll('[data-coordinate]')].map(i=>Number(i.value)),old=this.pending.position;if(!position.every(finite)){this.updateSpatialFields();return;}
    let geometry=structuredClone(this.pending.geometry??{});const delta=position.map((n,i)=>n-old[i]);
    if(geometry.shape==='box'){
      const size=[...this.bubble.querySelectorAll('[data-size]')].map(i=>Number(i.value));if(!size.every(n=>finite(n)&&n>=.05&&n<=1e4))return;geometry.size=size;geometry.center=position;geometry.depth=size[axes(geometry.plane)[2]];geometry.offset=position[axes(geometry.plane)[2]]-geometry.depth/2;
    }else if(geometry.shape==='prism'){
      const nextDepth=Number(this.bubble.querySelector('[aria-label="调整区域厚度"]').value);if(!finite(nextDepth)||nextDepth<.05||nextDepth>1e4)return;const normal=axes(geometry.plane)[2];delta[normal]-=(nextDepth-geometry.depth)/2;geometry.depth=nextDepth;geometry.offset=position[normal]-nextDepth/2;geometry.center=position;geometry.world_points=geometry.world_points.map(point=>point.map((n,i)=>n+delta[i]));
    }
    if(JSON.stringify([position,geometry])===JSON.stringify([this.pending.position,this.pending.geometry]))return;this.pending.position=position;this.pending.geometry=geometry;this.adjusting=true;this.updateSpatialFields();this.command({adjust:true});
  }
  placeBubble(screen){
    const r=this.viewport.getBoundingClientRect(),w=Math.min(330,r.width-24);this.bubble.style.width=w+'px';const h=this.bubble.offsetHeight||210,bottom=this.active?r.height-this.tools.getBoundingClientRect().top+r.top+12:12,maxTop=Math.max(12,r.height-h-bottom);
    if(this.bubble.classList.contains('is-spatial')){this.bubble.style.left=Math.max(12,r.width-w-14)+'px';this.bubble.style.top=Math.min(18,maxTop)+'px';return;}
    const x=screen[0]*r.width,y=screen[1]*r.height;this.bubble.style.left=Math.max(12,Math.min(r.width-w-12,x+18))+'px';this.bubble.style.top=Math.max(12,Math.min(maxTop,y+18>maxTop?y-h-18:y+18))+'px';
  }
  commitBubble(){
    if(!this.pending||this.busy||this.adjusting||this.invalid)return false;const note=this.field.value.trim();if(!note){this.field.focus();return false;}const item={...this.pending,note},index=this.items.findIndex(a=>a.id===item.id);if(index<0){if(this.items.length>=64){this.onError(Error('每批最多 64 条批注，请先完成当前批注'));return false;}this.items.push(item);}else this.items[index]=item;
    this.batch=randomUUID();this.cancelBubble();this.persist();this.render();this.command();return true;
  }
  cancelBubble(focus=true){this.pending=null;this.adjusting=false;this.bubble.hidden=true;this.root.classList.remove('has-pending');if(this.active)this.awaitMode();this.command();if(focus)this.focusViewport();}
  remove(id){if(this.busy)return;this.items=this.items.filter(a=>a.id!==id);this.batch=randomUUID();this.cancelBubble();this.persist();this.render();this.command();}
  escape(){if(this.busy)return;if(this.pending)this.cancelBubble();else this.finish().catch(this.onError);}
  persist(){if(this.documentKey)try{localStorage.setItem(this.documentKey,JSON.stringify({items:this.items,batch:this.batch}));}catch{this.onError(Error('本机批注草稿未保存，请完成批注以保存到会话'));}}
  async annotateScreenshot(){
    if(this.busy||!this.scope()?.available||!this.screenshot)return;
    if(this.pending&&!this.commitBubble())return;
    const scope=this.scope(),key=this.documentKey,batch={batch_id:this.batch,annotations:structuredClone(this.items)};
    this.busy=true;this.screenshotBusy=true;this.render();this.command();this.onChange();
    try{
      const saved=await this.screenshot(batch,scope);
      if(saved){if(key===this.documentKey){this.items=[];this.active=false;this.batch=randomUUID();this.persist();}else localStorage.removeItem(key);}
    }finally{this.busy=false;this.screenshotBusy=false;this.render();this.command();this.onChange();}
  }
  async finish(){
    if(this.busy)return;if(this.pending&&!this.commitBubble())return;if(!this.items.length){this.active=false;this.render();this.command();this.onChange();return;}
    const scope=this.batchScope,key=this.documentKey,items=structuredClone(this.items);this.busy=true;this.render();this.command();this.onChange();
    try{await this.save({batch_id:this.batch,annotations:items},scope);if(key===this.documentKey){this.items=[];this.active=false;this.batch=randomUUID();this.persist();}else localStorage.removeItem(key);}finally{this.busy=false;this.render();this.command();this.onChange();}
  }
  async copy(){if(!this.items.length)return;await copyAnnotationText(portableAnnotations(this.items,this.scope()));this.onCopied();}
  setProcessing(states){const scope=this.scope(),next=(states??[]).filter(s=>s.annotation_id&&s.resource_id===scope?.resource_id&&s.project_id===scope?.project_id&&s.branch_id===scope?.branch_id).map(s=>({...s,id:`processing-${s.run_id}-${s.annotation_id}`,processing:true}));if(JSON.stringify(next)===JSON.stringify(this.processing))return;this.processing=next;this.renderPins();this.command();}
  renderPins(){
    const items=[...this.items,...this.processing],valid=new Set(items.map(a=>a.id));for(const[id,pin]of this.pinNodes)if(!valid.has(id)){pin.remove();this.pinNodes.delete(id);}
    items.forEach((item,i)=>{let pin=this.pinNodes.get(item.id);if(!pin){pin=document.createElement('button');pin.type='button';pin.dataset.annotationId=item.id;pin.style.left=`${(item.screen?.[0]??.5)*100}%`;pin.style.top=`${(item.screen?.[1]??.5)*100}%`;this.pins.append(pin);this.pinNodes.set(item.id,pin);}pin.className='annotation-pin'+(item.processing?' is-processing':'');const title=item.processing?`${item.actor?.name??'Agent'} · ${item.label??'正在开发'}`:item.note;if(pin.title!==title||pin.dataset.index!==String(i)){pin.title=title;pin.dataset.index=String(i);pin.setAttribute('aria-label',title);pin.textContent=item.processing?'✦':String(i+1);if(item.processing){const label=document.createElement('span');label.textContent=item.label??'Agent 正在开发';pin.append(label);}}pin.onclick=item.processing?null:()=>{if(this.busy)return;this.active=true;this.render();this.openBubble(item);};});
  }
  render(){
    this.button.setAttribute('aria-pressed',String(this.active));this.button.textContent=this.active?'退出批注':`批注${this.items.length?' · '+this.items.length:''}`;this.tools.hidden=!this.active;this.list.hidden=!this.active||!this.items.length;this.viewport.classList.toggle('is-annotating',this.active);this.root.querySelector('.annotation-count').textContent=`${this.items.length} 条`;
    const space=this.target==='space'&&this.dimension()==='3d',brush=this.tool==='brush';this.root.querySelector('[aria-label="笔刷用途"] option[value=space]').disabled=this.dimension()==='2d';this.root.querySelector('.annotation-brush-target').hidden=!brush;this.root.querySelector('.annotation-radius').hidden=!brush||space;this.root.querySelector('.annotation-world-radius').hidden=!brush||!space;this.root.querySelector('.annotation-plane-controls').hidden=!space;this.root.querySelector('.annotation-depth').hidden=!space||this.tool==='point';this.root.querySelector('[data-annotation-center]').hidden=!['point','volume'].includes(this.tool);
    this.root.querySelectorAll('[data-3d-only]').forEach(el=>el.hidden=this.dimension()==='2d');this.root.querySelectorAll('[data-annotation-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.annotationTool===this.tool&&(!b.dataset.target||b.dataset.target===this.target))));
    this.hint.textContent=space?(this.tool==='volume'?'拖出底面，再用控制柄调整长宽高':this.tool==='brush'?'在固定平面涂抹，厚度形成空间范围':'点击工作平面放置描点，随后调整 XYZ'):(this.tool==='point'?'精确点击对象表面':this.tool==='rect'?'框选只收集对象':'涂抹选择对象，空白不会创建区域');
    this.root.querySelectorAll('.annotation-tools button,.annotation-tools input,.annotation-tools select').forEach(b=>b.disabled=this.busy||b.hasAttribute('data-annotation-copy')&&!this.items.length);this.root.querySelector('[data-annotation-finish]').textContent=this.screenshotBusy?'截图划线中…':this.busy?'保存草稿…':'完成批注';
    this.list.innerHTML=`<strong>待发送批注 <small>${this.items.length}</small></strong>`+this.items.map((a,i)=>`<div class="annotation-list-row"><button type="button" data-edit-annotation="${escape(a.id)}"><b>${i+1}</b><span>${escape(a.note)}</span></button><button type="button" data-delete-annotation="${escape(a.id)}" aria-label="删除第 ${i+1} 条批注">×</button></div>`).join('');
    this.list.querySelectorAll('[data-edit-annotation]').forEach(b=>b.onclick=()=>{if(!this.busy)this.openBubble(this.items.find(a=>a.id===b.dataset.editAnnotation));});this.list.querySelectorAll('[data-delete-annotation]').forEach(b=>b.onclick=()=>this.remove(b.dataset.deleteAnnotation));this.renderPins();
  }
}
