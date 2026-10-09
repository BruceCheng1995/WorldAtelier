// Images use authenticated downloads. Never put login tokens in image URLs.
export function createImagePreviews(api){
  let scope=null,generation=0;const urls=new Map(),pending=new Map();
  function clear(next=null){generation++;for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();pending.clear();scope=next;}
  function hydrate(root,next){
    if(scope!==next)clear(next);
    const captured=generation;
    for(const img of root.querySelectorAll('img[data-image-attachment]')){
      const key=img.dataset.imageSession+'/'+img.dataset.imageAttachment;
      if(img.dataset.imageLoaded===String(generation))continue;
      img.dataset.imageLoaded=String(generation);
      if(urls.has(key)){img.src=urls.get(key);continue;}
      if(!pending.has(key)){
        const job=api.download(`sessions/${encodeURIComponent(img.dataset.imageSession)}/image-attachments/${encodeURIComponent(img.dataset.imageAttachment)}`).then(({blob})=>{
          if(generation!==captured)return null;
          const url=URL.createObjectURL(blob);urls.set(key,url);return url;
        }).finally(()=>{if(generation===captured)pending.delete(key);});pending.set(key,job);
      }
      pending.get(key).then(url=>{if(url&&img.isConnected&&generation===captured)img.src=url;}).catch(()=>{if(img.isConnected&&generation===captured){delete img.dataset.imageLoaded;img.alt='图片加载失败，点击重试';}});
    }
  }
  return {hydrate,clear};
}
export function imageElement(a,className='attachment-thumbnail'){
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<img class="${className}" data-image-session="${esc(a.session_id)}" data-image-attachment="${esc(a.id)}" alt="${esc(a.name)}" loading="lazy">`;
}

// Screen-space intent stays in an immutable image; it is never a scene edit.
export async function editScreenshot({dataUrl,subtitle='',onSave}){
  const source=new Image();source.src=dataUrl;await source.decode();
  const previousFocus=document.activeElement,dialog=document.createElement('dialog');
  dialog.className='screenshot-annotation-editor';dialog.setAttribute('aria-label','截图划线');
  dialog.innerHTML=`<header><div><strong>截图划线</strong><small class="screenshot-context"></small></div><button type="button" data-markup-action="cancel" aria-label="关闭截图划线">×</button></header>
    <div class="screenshot-toolbar" role="toolbar" aria-label="截图标记工具">
      <button type="button" data-markup-tool="pen">自由线</button><button type="button" data-markup-tool="arrow">箭头</button><button type="button" data-markup-tool="rect">方框</button>
      <span class="screenshot-divider"></span><label>颜色<input type="color" aria-label="划线颜色" value="#ef4444"></label>
      <label>粗细<select aria-label="划线粗细"><option value="3">细</option><option value="6" selected>中</option><option value="10">粗</option></select></label>
      <span class="screenshot-divider"></span><button type="button" data-markup-action="undo" title="⌘ / Ctrl + Z">撤销</button><button type="button" data-markup-action="redo" title="⌘ / Ctrl + Shift + Z">重做</button><button type="button" data-markup-action="clear">清空划线</button>
      <small class="screenshot-count" role="status"></small>
    </div><div class="screenshot-stage"><canvas aria-label="截图划线画布" tabindex="0"></canvas></div>
    <footer><label>补充说明<textarea aria-label="截图批注说明" rows="2" maxlength="2000" placeholder="例如：沿红线铺一条路，把箭头所指的入口移到方框内…"></textarea></label>
      <p class="screenshot-error" role="alert"></p><div class="screenshot-footer-actions"><small>在截图上拖动标记 · ⌘ / Ctrl + Enter 保存</small><button type="button" data-markup-action="cancel">取消</button><button type="button" data-markup-action="save" class="screenshot-primary">加入 Agent 草稿</button></div></footer>`;
  const q=selector=>dialog.querySelector(selector),canvas=q('canvas'),ctx=canvas.getContext('2d'),stage=q('.screenshot-stage'),note=q('textarea'),error=q('.screenshot-error');
  q('.screenshot-context').textContent=subtitle||'画面已固定，标记你希望修改的位置和方向';
  const scale=Math.min(1,1600/source.naturalWidth,1000/source.naturalHeight);
  canvas.width=Math.max(1,Math.round(source.naturalWidth*scale));canvas.height=Math.max(1,Math.round(source.naturalHeight*scale));
  let strokes=[],history=[[]],historyIndex=0,active=null,tool='pen',busy=false,closed=false,frame=0,resolveClosed;
  const finished=new Promise(resolve=>{resolveClosed=resolve;});
  function drawStroke(stroke){
    const points=stroke.points,start=points[0],end=points.at(-1);
    ctx.lineCap='round';ctx.lineJoin='round';
    const path=()=>{
      ctx.beginPath();
      if(stroke.tool==='rect')ctx.rect(start[0],start[1],end[0]-start[0],end[1]-start[1]);
      else{ctx.moveTo(...start);for(const point of points.slice(1))ctx.lineTo(...point);
        if(points.length===1)ctx.lineTo(start[0]+.01,start[1]);
        if(stroke.tool==='arrow'){
          const angle=Math.atan2(end[1]-start[1],end[0]-start[0]),length=Math.max(14,stroke.width*3);
          for(const offset of [-.52,.52]){ctx.moveTo(end[0]-Math.cos(angle+offset)*length,end[1]-Math.sin(angle+offset)*length);ctx.lineTo(...end);}
        }
      }
      ctx.stroke();
    };
    ctx.strokeStyle='#ffffffd9';ctx.lineWidth=stroke.width+2;path();ctx.strokeStyle=stroke.color;ctx.lineWidth=stroke.width;path();
  }
  function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,0,0,canvas.width,canvas.height);for(const stroke of strokes)drawStroke(stroke);if(active)drawStroke(active);}
  function scheduleDraw(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;if(!closed)draw();});}
  function update(){
    dialog.setAttribute('aria-busy',String(busy));
    dialog.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=busy;});
    q('[data-markup-action=undo]').disabled=busy||historyIndex===0;
    q('[data-markup-action=redo]').disabled=busy||historyIndex===history.length-1;
    q('[data-markup-action=clear]').disabled=busy||!strokes.length;
    q('[data-markup-action=save]').disabled=busy||!!active||(!strokes.length&&!note.value.trim());
    q('[data-markup-action=save]').textContent=busy?'正在保存…':'加入 Agent 草稿';
    q('.screenshot-count').textContent=`${strokes.length} 笔`;
    dialog.querySelectorAll('[data-markup-tool]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.markupTool===tool)));
  }
  function fit(){const ratio=Math.min((stage.clientWidth-32)/canvas.width,(stage.clientHeight-32)/canvas.height);canvas.style.width=Math.max(1,canvas.width*ratio)+'px';canvas.style.height=Math.max(1,canvas.height*ratio)+'px';}
  const observer=new ResizeObserver(fit);
  function close(saved=false){if(closed)return;closed=true;cancelAnimationFrame(frame);observer.disconnect();dialog.close();dialog.remove();source.src='';if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});resolveClosed(saved);}
  function point(event){const r=canvas.getBoundingClientRect();return [Math.max(0,Math.min(canvas.width,(event.clientX-r.left)*canvas.width/r.width)),Math.max(0,Math.min(canvas.height,(event.clientY-r.top)*canvas.height/r.height))];}
  function cancelStroke(){if(!active)return;const pointer=active.pointer;active=null;if(canvas.hasPointerCapture(pointer))canvas.releasePointerCapture(pointer);draw();update();}
  function commit(next){strokes=next;history=history.slice(0,historyIndex+1);history.push(next);if(history.length>201)history.shift();historyIndex=history.length-1;}
  canvas.onpointerdown=event=>{
    if(busy||active||event.button!==0)return;event.preventDefault();
    if(strokes.length>=200){error.textContent='每张截图最多 200 笔，可撤销或清空后继续。';return;}
    error.textContent='';canvas.focus({preventScroll:true});active={tool,color:q('input[type=color]').value,width:Number(q('select').value),points:[point(event)],pointer:event.pointerId};canvas.setPointerCapture(event.pointerId);draw();update();
  };
  function move(event){
    if(!active||active.pointer!==event.pointerId)return;
    const next=point(event),last=active.points.at(-1);
    if(active.tool==='pen'){
      if(Math.hypot(next[0]-last[0],next[1]-last[1])<1)return;
      // Bound long drags without disconnecting their visible endpoint.
      if(active.points.length>=2048)active.points=active.points.filter((_,i)=>i%2===0);
      active.points.push(next);
    }else active.points=[active.points[0],next];
    scheduleDraw();
  }
  canvas.onpointermove=move;
  canvas.onpointerup=event=>{
    if(!active||active.pointer!==event.pointerId)return;move(event);const stroke=active;active=null;
    if(stroke.tool==='pen'||Math.hypot(...stroke.points.at(-1).map((v,i)=>v-stroke.points[0][i]))>2)commit([...strokes,stroke]);
    if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);draw();update();
  };
  canvas.onpointercancel=cancelStroke;canvas.onlostpointercapture=cancelStroke;
  dialog.querySelectorAll('[data-markup-tool]').forEach(button=>button.onclick=()=>{cancelStroke();tool=button.dataset.markupTool;update();});
  function undoStroke(){if(busy)return;cancelStroke();if(historyIndex>0)strokes=history[--historyIndex];draw();update();}
  function redoStroke(){if(busy)return;cancelStroke();if(historyIndex<history.length-1)strokes=history[++historyIndex];draw();update();}
  q('[data-markup-action=undo]').onclick=undoStroke;q('[data-markup-action=redo]').onclick=redoStroke;
  q('[data-markup-action=clear]').onclick=()=>{cancelStroke();if(strokes.length)commit([]);draw();update();};
  dialog.querySelectorAll('[data-markup-action=cancel]').forEach(button=>button.onclick=()=>{if(!busy)close();});
  dialog.oncancel=event=>{event.preventDefault();if(!busy){if(active)cancelStroke();else close();}};
  dialog.onclose=()=>close();
  note.oninput=update;
  async function save(){
    if(busy||active||(!strokes.length&&!note.value.trim()))return;
    busy=true;error.textContent='';update();
    try{
      draw();const encode=(type,quality)=>new Promise(resolve=>canvas.toBlob(resolve,type,quality));
      let blob=await encode('image/png');if(blob?.size>5*1024*1024)blob=await encode('image/jpeg',.92);
      if(!blob||blob.size>5*1024*1024)throw Error('标记图片过大，请减少划线后重试');
      await onSave({blob,note:note.value.trim(),strokeCount:strokes.length,width:canvas.width,height:canvas.height});close(true);
    }catch(cause){error.textContent=cause.message||'保存失败，请重试';}
    finally{busy=false;if(!closed)update();}
  }
  q('[data-markup-action=save]').onclick=save;
  dialog.addEventListener('keydown',event=>{
    event.stopPropagation();
    if(event.key==='Escape'&&active){event.preventDefault();if(!busy)cancelStroke();return;}
    if(event.isComposing||!(event.ctrlKey||event.metaKey))return;
    if(event.key==='Enter'){event.preventDefault();void save();}
    else if(!event.target.closest('textarea,input')&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();event.shiftKey||event.key.toLowerCase()==='y'?redoStroke():undoStroke();}
  });
  document.body.append(dialog);dialog.showModal();observer.observe(stage);fit();draw();update();canvas.focus({preventScroll:true});
  return finished;
}
