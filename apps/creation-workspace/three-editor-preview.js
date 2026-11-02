import {comparisonCamera} from './game-catalog.js';
import {GodotPreview} from './preview-bridge.js';
import {NativeGodotPreview} from './native-preview.js';
import {randomUUID} from './client-platform.js';

// One route per fixed document. A mixed scene may still use the Three editor
// when only optional effects differ; missing authored shapes use the native host.
export function editorVisualRoute(scene,{annotation=false,comparison=false,unsupportedShader=false}={}){
  const native=detail=>({engine:'godot',detail});
  if(annotation)return native('Godot 空间批注使用当前固定文档');
  if(comparison)return native('已打开此版本的 Godot 对照窗口');
  const projection=scene.three_projection;
  if(!projection?.nodes)return native('此文档使用原生场景和材质显示');
  if(scene.objects?.some(o=>o.control_layout?.needs_measurement)||projection.nodes.some(r=>r.canvas&&!r.canvas.layout))
    return native('此版本的界面尺寸需要由 Godot 实测');
  const managed=scene.objects?.find(o=>o.control_layout?.container_managed&&!['HBoxContainer','VBoxContainer'].includes(o.control_layout.parent_type));
  if(managed)return native(managed.control_layout.parent_type+' 布局使用 Godot 排版');
  const focus=scene.preview_object_id&&scene.objects?.find(o=>o.id===scene.preview_object_id)?.native_path;
  const visible=projection.nodes.filter(r=>r.visible!==false&&(!focus||focus==='.'||r.path===focus||r.path.startsWith(focus+'/')));
  const missing=visible.find(r=>r.unsupported_visual||(!r.canvas&&(r.type?.endsWith('2D')||['TileMap','TileMapLayer'].includes(r.type))));
  if(missing)return native((missing.unsupported_visual||missing.type)+' 使用 Godot 显示和拾取');
  const differences=new Set(projection.differences),notes=[];
  if(visible.some(r=>r.particles)){
    if(!visible.some(r=>r.mesh||r.canvas||r.label))return native('粒子效果使用 Godot 显示');
    notes.push('粒子显示需在 Godot 对照窗口核对');
  }
  if(visible.some(r=>r.type==='Skeleton3D'))notes.push('蒙皮按固定姿态显示');
  if(unsupportedShader)notes.push('自定义着色器按材质参数近似显示');
  if(differences.has('unreadable_texture')||differences.has('compressed_texture'))notes.push('部分原生纹理未投影');
  if(differences.has('unsupported_sky')||differences.has('unsupported_sky_cover'))notes.push('环境天空近似显示');
  if(differences.has('unmapped_skin_joint'))notes.push('部分骨骼姿势未映射');
  if(differences.has('non_triangle_surface')||differences.has('unavailable_surface'))notes.push('部分网格表面未投影');
  return {engine:'three',detail:notes.join(' · ')};
}

export class ThreeEditorPreview extends NativeGodotPreview {
  get editorStartupText() {
    return this.engine === 'three' ? '正在启动 Three.js 编辑器…' : super.editorStartupText;
  }

  async scene(scene, options) {
    if(this.latestScene?.document_id!==scene.document_id||this.latestScene?.source_identity!==scene.source_identity)this.cancelGhost();
    this.latestScene = scene;
    if (this.annotationDocument && this.annotationDocument !== scene.document_id) this.annotationDocument = null;
    const {engine,detail}=editorVisualRoute(scene,{annotation:!!this.annotationDocument,
      comparison:new URLSearchParams(globalThis.location?.search).get('engine')==='godot'});
    const loaded=this.lastLoadedEvent;
    this.host.dataset.editorRouteDetail=engine==='three'&&loaded?.document_id===scene.document_id&&loaded.source_identity===scene.source_identity&&loaded.preview_object_id===(scene.preview_object_id??null)?
      editorVisualRoute(scene,{unsupportedShader:loaded.unsupported_shader}).detail:detail;
    if(this.transferredView&&(this.transferredView.document!==scene.document_id||this.transferredView.source!==scene.source_identity))this.transferredView=null;
    if (this.engine !== engine) {
      const current=this.sceneContext;
      const camera=current?.document_id===scene.document_id&&current.source_identity===scene.source_identity&&
        this.lastCameraEvent?.seq===this.loadedSeq?comparisonCamera(this.lastCameraEvent):null;
      this.transferredView=camera?{document:scene.document_id,source:scene.source_identity,engine,camera}:null;
      this.buildAbort?.abort();
      this.nativeGeneration++;
      this.reject(new DOMException('编辑器已切换', 'AbortError'));
      this.ready = false;
      this.key = this.nativeKey = this.preparingKey = this.preparing = this.nativeContent = null;
      this.runtimeManifest = this.lastCameraEvent = this.sceneContext = null;
      this.loadedSeq = 0;
      this.nonce = randomUUID();
      this.engine = this.host.dataset.editorEngine = engine;
      this.frame.title = engine === 'three' ? 'Three.js 原生场景编辑视口' : 'Godot 原生场景编辑视口';
      this.frame.setAttribute('aria-label', this.frame.title);
      if (engine === 'three') {
        this.runtimeBuildId = 'three-editor-v1';
        this.host.dataset.runtimeBuild = this.runtimeBuildId;
        this.frame.src = '/three-editor.html?'+new URLSearchParams({nonce:this.nonce,mode:this.mode});
        this.runtimeReady = Promise.resolve();
      } else {
        this.frame.src = 'about:blank';
      }
    }
    if (engine === 'godot') {
      const result=await super.scene(scene,options);this.restoreTransferredView();return result;
    }
    const generation = ++this.nativeGeneration;
    this.nativeKey = scene.source_identity;
    this.host.dataset.previewState = 'updating';
    const promise = GodotPreview.prototype.scene.call(this,scene,options);
    try {
      const result = await promise;
      if (generation !== this.nativeGeneration || this.disposed) throw new DOMException('预览目标已切换','AbortError');
      this.restoreTransferredView();
      this.frame.style.pointerEvents = '';
      this.host.dataset.previewState = 'ready';
      this.host.dataset.displayedSource = scene.source_revision ?? scene.scene_revision;
      return result;
    } catch (error) {
      if (generation === this.nativeGeneration && !this.disposed) this.host.dataset.previewState = 'error';
      throw error;
    }
  }

  cancelGhost(){
    this.ghostRequest?.abort.abort();this.ghostRequest=null;
  }
  restoreTransferredView(){
    const view=this.transferredView;
    if(!view||this.disposed||this.pending||this.loadedSeq!==this.seq||this.engine!==view.engine||
        this.sceneContext?.document_id!==view.document||this.sceneContext.source_identity!==view.source)return;
    this.transferredView=null;this.camera({bookmark:view.camera});
  }

  prefabDrag(fields){
    if(this.engine!=='three')return super.prefabDrag(fields);
    const current=this.ghostRequest;
    if(fields.phase==='clear'){
      if(current?.id===fields.drag_id)this.cancelGhost();
      return super.prefabDrag(fields);
    }
    if(fields.phase==='hide'){
      if(current?.id===fields.drag_id)current.last=fields;
      return super.prefabDrag(fields);
    }
    const scene=this.latestScene;
    if(fields.phase!=='move'||!scene?.editable||!fields.prefab_id)return false;
    if(!super.prefabDrag(fields))return false;
    if(current?.id===fields.drag_id&&current.seq===this.seq){
      current.last=fields;
      if(current.ready&&!current.sent)this.sendGhost(current);
      return true;
    }
    this.cancelGhost();
    const state=this.ghostRequest={id:fields.drag_id,last:fields,seq:this.seq,abort:new AbortController()};
    const e=encodeURIComponent,revision=scene.source_revision??scene.scene_revision;
    const route='projects/'+e(scene.project_id)+'/branches/'+e(scene.branch_id)+'/runtime-scene?prefab_ghost=1&resource_id='+e(fields.prefab_id)+'&revision='+e(revision);
    this.request(route,{signal:state.abort.signal,timeoutMs:180000}).then(packet=>{
      if(packet.resource_id!==fields.prefab_id||packet.kind!=='prefab'||packet.native_scene_path!==fields.prefab_path||
         packet.source_identity!==scene.source_identity||packet.scene_revision!==revision)throw Error('预制件版本已变化');
      state.packet=packet;
    }).catch(error=>{state.error=error.message;}).finally(()=>{
      state.ready=true;this.sendGhost(state);
    });
    return true;
  }
  sendGhost(state){
    if(state!==this.ghostRequest||this.disposed||state.seq!==this.seq||state.last.phase!=='move')return;
    state.sent=super.prefabDrag({...state.last,...(state.packet?.three_projection&&editorVisualRoute(state.packet).engine==='three'?{ghost:state.packet}:{ghost_error:state.error??'无空间模型'})});
  }
  dispose(){this.cancelGhost();super.dispose();}

  post(packet) {
    // The full volumetric annotation tools operate on native geometry. Open
    // the same fixed native scene and let its loaded event rescope the tool.
    if (packet.type === 'annotation' && this.latestScene?.three_projection?.version === 1) {
      const enter = this.engine === 'three' && packet.enabled;
      const exit = this.engine === 'godot' && this.annotationDocument === packet.document_id && !packet.enabled;
      if (enter || exit) {
        this.annotationDocument = enter ? this.latestScene.document_id : null;
        const switching = this.scene({...this.latestScene,frame:false,selected_id:this.sceneContext?.selected_id??'',selected_ids:this.sceneContext?.selected_ids??[]});
        this.annotationSwitch = switching;
        switching.catch(error => {
          if (error.name !== 'AbortError' && !this.disposed) this.status.textContent = error.message;
        }).finally(() => { if (this.annotationSwitch === switching) this.annotationSwitch = null; });
        return;
      }
    }
    super.post(packet);
  }

  async captureFrame() {
    if (this.engine !== 'three') return super.captureFrame();
    const context = this.sceneContext,seq = this.seq;
    if (!this.ready || this.pending || this.loadedSeq !== seq || this.disposed) throw Error('等待当前编辑画面');
    const inner = this.frame.contentWindow,canvas = this.frame.contentDocument.querySelector('canvas');
    if (!inner.waRenderForCapture || !canvas?.width) throw Error('编辑画布尚未就绪');
    inner.waRenderForCapture();
    const image = document.createElement('canvas'),scale = Math.min(1,1280/canvas.width,720/canvas.height);
    image.width = Math.max(1,Math.round(canvas.width*scale));
    image.height = Math.max(1,Math.round(canvas.height*scale));
    const ctx=image.getContext('2d');
    ctx.drawImage(canvas,0,0,image.width,image.height);
    ctx.scale(image.width/canvas.clientWidth,image.height/canvas.clientHeight);
    const surface=canvas.getBoundingClientRect();ctx.translate(-surface.x,-surface.y);
    for(const label of inner.document.querySelectorAll('#labels>span,.canvas-labels>span')){
      const rect=label.getBoundingClientRect(),style=inner.getComputedStyle(label);
      ctx.save();
      ctx.fillStyle=style.backgroundColor;ctx.beginPath();ctx.roundRect(rect.x,rect.y,rect.width,rect.height,4);ctx.fill();ctx.clip();
      const glyph=label.querySelector('canvas');
      if(glyph){
        const g=glyph.getBoundingClientRect();ctx.drawImage(glyph,g.x,g.y,g.width,g.height);
      }else{
        ctx.font=style.font;ctx.fillStyle=style.color;ctx.textBaseline='middle';ctx.fillText(label.textContent,rect.x+8,rect.y+rect.height/2);
      }
      ctx.restore();
    }
    return {data_url:image.toDataURL('image/jpeg',.84),document_id:context.document_id,source_revision:context.source_revision,runtime_build_id:this.runtimeBuildId};
  }

  receive(event) {
    const data = event.data;
    if(this.engine==='three'&&data?.type==='loaded'&&event.origin===location.origin&&event.source===this.frame.contentWindow&&
       data.source==='world-atelier-preview'&&data.nonce===this.nonce&&data.seq===this.seq&&data.document_id===this.latestScene?.document_id&&data.source_identity===this.latestScene.source_identity){
      this.host.dataset.editorRouteDetail=editorVisualRoute(this.latestScene,{unsupportedShader:data.unsupported_shader}).detail;
    }
    if (this.engine === 'three' && event.origin === location.origin &&
        event.source === this.frame.contentWindow && data?.nonce === this.nonce && data.source === 'world-atelier-preview' &&
        data.type === 'three_init_error') {
      this.reject(Error(data.message));
      this.key = null;
      this.status.textContent = data.message;
      return;
    }
    super.receive(event);
  }
}
