import * as T from 'three';
import {bounds,disposeTree} from './three-editor-scene.js';
import {silhouetteDistances} from './three-editor-outline-mask.js';
import {userColor} from './client-platform.js';

const vertex = 'varying vec2 p; void main(){p=uv;gl_Position=vec4(position.xy,0.,1.);}';
const fragment = `
uniform sampler2D layers,coverage; uniform vec2 maskOrigin,maskSize; uniform float opacity,clock,ratio,frameHeight;
varying vec2 p;
void main(){
  vec2 at=(p-maskOrigin)/maskSize;
  if(min(min(at.x,at.y),min(1.-at.x,1.-at.y))<0.)discard;
  vec4 band=texture2D(layers,at); vec2 style=texture2D(coverage,at).rg;
  float phase=fract((gl_FragCoord.x+frameHeight-gl_FragCoord.y)/(18.*ratio)-clock*.65);
  float dash=smoothstep(.03,.10,phase)*(1.-smoothstep(.58,.65,phase));
  float alpha=band.a*(1.-style.r)*opacity*mix(1.,mix(.18,1.,dash),style.g);
  gl_FragColor=vec4(mix(band.rgb,vec3(1.),style.g*dash*.22),alpha);
}`;
const sameAddress = (a,b) => a && b && ['project_id','branch_id','resource_id','definition_node_id'].every(k=>a[k] === b[k]) && JSON.stringify(a.instance_path) === JSON.stringify(b.instance_path);

function cameraMarker(color) {
  const vertices = [], corners = [[-.35,-.22,-.7],[.35,-.22,-.7],[.35,.22,-.7],[-.35,.22,-.7]];
  corners.forEach((p,i)=>vertices.push(0,0,0,...p,...p,...corners[(i+1)%4]));
  const geom = new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(vertices,3));
  return new T.LineSegments(geom,new T.LineBasicMaterial({color}));
}

function projectedRect(node,camera,w,h,nativeFrame=false) {
  const b=bounds(node,nativeFrame),point=new T.Vector3();
  let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
  for(let i=0;i<8;i++){
    point.set(i&1?b.max.x:b.min.x,i&2?b.max.y:b.min.y,i&4?b.max.z:b.min.z).project(camera);
    if(point.z < -1 || point.z>1)continue;
    const x=(point.x+1)*w/2,y=(1-point.y)*h/2;
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
  return right>=0 && left<=w && bottom>=0 && top<=h ? {left,right,top,bottom} : null;
}

function maskTexture(bytes,w,h,format){
  const texture=new T.DataTexture(bytes,w,h,format);
  texture.minFilter=texture.magFilter=T.LinearFilter;texture.needsUpdate=true;
  return texture;
}
function composeBands(distance,w,h,layers,width) {
  const colors=new Uint8Array(w*h*4),coverage=new Uint8Array(w*h*2);
  const palette=layers.map(layer=>{
    const tint=new T.Color(layer.color).convertLinearToSRGB();
    return [Math.round(255*tint.r),Math.round(255*tint.g),Math.round(255*tint.b),255];
  });
  // Ownership is composed opaquely, outermost to innermost in Godot. Every
  // raster texel belongs to just one identity; only the final screen overlay
  // gets opacity/dashes. Neighbouring colours filter once, even at shared edges.
  for(let i=0;i<distance.length;i++){
    const layer=Math.max(0,Math.ceil(Math.sqrt(distance[i])/width)-1);
    if(layer>=layers.length)continue;
    colors.set(palette[layer],4*i);
    coverage[2*i]=distance[i]===0?255:0;
    coverage[2*i+1]=layers[layer].agent?255:0;
  }
  const band=maskTexture(colors,w,h,T.RGBAFormat),style=maskTexture(coverage,w,h,T.RGFormat);
  return {band,style,dispose(){band.dispose();style.dispose();}};
}

export class EditorOverlays {
  constructor(scene,renderer,labels) {
    Object.assign(this,{scene,renderer,labels});
    this.settings = {show_selections:true,show_agents:true,show_cameras:true,width:4,opacity:.85};
    this.textMeasure=document.createElement('canvas').getContext('2d');
    this.fontRevision=0;
    this.fontLoaded=()=>this.fontRevision++;
    document.fonts.addEventListener('loadingdone',this.fontLoaded);
    this.peers = []; this.local = null; this.states = []; this.markers = new Map();
    this.target = new T.WebGLRenderTarget(1,1,{type:T.UnsignedByteType});
    this.cache = new Map();
    this.depth = new T.MeshBasicMaterial({colorWrite:false,fog:false,toneMapped:false});
    this.white = new T.MeshBasicMaterial({color:0xffffff,fog:false,toneMapped:false});
    this.quad = new T.Scene(); this.camera = new T.Camera();
    const uniforms = Object.fromEntries(Object.entries({layers:null,coverage:null,maskOrigin:new T.Vector2(),maskSize:new T.Vector2(1,1),clock:0,ratio:1,frameHeight:1,opacity:.85}).map(([k,value])=>[k,{value}]));
    this.material = new T.ShaderMaterial({uniforms,vertexShader:vertex,fragmentShader:fragment,depthWrite:false,depthTest:false,transparent:true});
    this.quad.add(new T.Mesh(new T.PlaneGeometry(2,2),this.material));
  }
  setPresence(packet) {
    this.local = packet.local_peer;
    this.peers = packet.peers ?? [];
    const keep = new Set();
    for(const peer of this.peers){
      if(!Array.isArray(peer.camera?.position)||!Array.isArray(peer.camera?.target))continue;
      let marker=this.markers.get(peer.id);
      if(!marker){marker=cameraMarker(peer.color);this.markers.set(peer.id,marker);this.scene.add(marker);}
      marker.position.set(...peer.camera.position);
      marker.lookAt(...peer.camera.target);marker.rotateY(Math.PI);
      keep.add(peer.id);
    }
    for(const [id,marker] of this.markers)if(!keep.has(id)){this.scene.remove(marker);disposeTree(marker);this.markers.delete(id);}
  }
  draw(camera,items,selection,mode,navigating=false) {
    this.navigating=navigating;
    const rows = [], labels = new Map();
    if(this.settings.show_selections && mode==='main'){
      for(const peer of this.peers)if((peer.mode??'editing')==='editing'){
        for(const entry of peer.selected_objects??[{id:peer.selected_id,address:peer.selected_address}]){
          if(!sameAddress(entry.address,items.get(entry.id)?.object.address)) continue;
          rows.push({id:entry.id,identity:'user:'+peer.user_id,text:peer.name,color:peer.color,order:peer.selection_order??0});
        }
      }
    }
    for(const id of selection)rows.push({id,identity:'user:'+(this.local?.user_id??''),text:this.local?.name,color:this.local?userColor(this.local):'#69e7ed',order:this.local?.selection_order || Number.MAX_SAFE_INTEGER});
    if(this.settings.show_agents)for(const state of this.states){
      if(!sameAddress(state.address,items.get(state.id)?.object.address) && state.address)continue;
      rows.push({id:state.id,identity:'agent:'+state.runs.map(r=>r.run_id).sort().join(','),text:state.label||'Agent',color:'#ffb73e',order:-1,agent:true});
    }
    const groups=new Map();
    for(const row of rows){
      const item=items.get(row.id);
      if(!item || !item.node.visible)continue;
      if(!groups.has(row.id))groups.set(row.id,new Map());
      const identities=groups.get(row.id),prior=identities.get(row.identity);
      if(!prior || prior.order < row.order)identities.set(row.identity,row);
    }
    const canvas=this.renderer.domElement,w=canvas.clientWidth,h=canvas.clientHeight;
    const sources=[];
    if(groups.size&&this.settings.opacity>0)this.content.traverseVisible(mesh=>{if(mesh.isMesh)sources.push(mesh);});
    const signature=[w,h,this.navigating,...camera.matrixWorld.elements,...camera.projectionMatrix.elements,...sources.flatMap(mesh=>[mesh.id,...mesh.matrixWorld.elements])].join(',');
    const silhouettes=new Map(),used=new Set(),sourceOrder=new Map(sources.map((mesh,i)=>[mesh.id,i]));
    for(const [id,entries] of groups){
      const node=items.get(id).node,rect=projectedRect(node,camera,w,h);
      if(!rect)continue;
      const sorted=[...entries.values()].sort((a,b)=>b.order-a.order||a.identity.localeCompare(b.identity));
      if(this.settings.opacity>0){
        const meshes=[];node.traverseVisible(child=>{if(child.isMesh)meshes.push(child.id);});
        const key=JSON.stringify(meshes.sort((a,b)=>a-b));
        if(meshes.length){
          if(!silhouettes.has(key))silhouettes.set(key,{node,rect,layers:new Map(),first:meshes.reduce((first,id)=>Math.min(first,sourceOrder.get(id)),Infinity),count:meshes.length});
          const layers=silhouettes.get(key).layers;
          for(const row of sorted)if(!layers.has(row.identity)||layers.get(row.identity).order<row.order)layers.set(row.identity,row);
        }
      }
      const labelRect=projectedRect(node,camera,w,h,true)??rect;
      for(const row of sorted){
        if(!row.text)continue;
        const old=labels.get(row.identity);
        if(old){old.left=Math.min(old.left,labelRect.left);old.top=Math.min(old.top,labelRect.top);}
        else labels.set(row.identity,{...row,...labelRect});
      }
    }
    // An ancestor silhouette contains its child's coverage. Composite the
    // broader selection first, including when their first mesh is shared.
    for(const {node,rect,layers} of [...silhouettes.values()].sort((a,b)=>a.first-b.first||b.count-a.count)){
      used.add(node);
      const ordered=[...layers.values()].sort((a,b)=>Number(Boolean(a.agent))-Number(Boolean(b.agent))||b.order-a.order||a.identity.localeCompare(b.identity));
      this.outline(camera,node,ordered,rect,sources,signature);
    }
    for(const [node,entry] of this.cache)if(!used.has(node)){entry.masks?.dispose();this.cache.delete(node);}
    for(const peer of this.peers){
      const marker=this.markers.get(peer.id);
      if(!marker?.visible)continue;
      const pt=marker.position.clone().add(new T.Vector3(0,.45,0)).project(camera);
      if(Math.abs(pt.x)<1 && Math.abs(pt.y)<1 && Math.abs(pt.z)<1)labels.set('camera:'+peer.id,{left:(1+pt.x)*w/2,top:(1-pt.y)*h/2,text:peer.name,color:peer.color});
    }
    this.paintLabels(labels,w,h);
  }
  updateMarkers(camera) {
    for(const marker of this.markers.values())marker.visible=this.settings.show_cameras && camera.position.distanceTo(marker.position)>=1.5;
  }
  outline(camera,node,layers,rect,sources,signature) {
    const {renderer,scene,target}=this,mask=30;
    const canvas=renderer.domElement,size=renderer.getDrawingBufferSize(new T.Vector2());
    const budget=this.navigating?196608:786432;
    const scale=Math.min(1,Math.sqrt(budget/(canvas.clientWidth*canvas.clientHeight)));
    const w=Math.max(1,Math.ceil(canvas.clientWidth*scale)),h=Math.max(1,Math.ceil(canvas.clientHeight*scale));
    const pad=Math.ceil(this.settings.width*layers.length*scale)+2;
    const x=Math.max(0,Math.floor(rect.left*w/canvas.clientWidth)-pad),y=Math.max(0,Math.floor((canvas.clientHeight-rect.bottom)*h/canvas.clientHeight)-pad);
    const sw=Math.min(w,Math.ceil(rect.right*w/canvas.clientWidth)+pad)-x,sh=Math.min(h,Math.ceil((canvas.clientHeight-rect.top)*h/canvas.clientHeight)+pad)-y;
    signature+=';'+[x,y,sw,sh,w,h].join(',');
    if(sw<=0 || sh<=0)return;
    // Reuse static coverage between animation frames. Occluder transforms
    // also belong to the signature, so a collaborator moving another mesh
    // invalidates the selected object's outline.
    let cached=this.cache.get(node);
    if(cached?.signature!==signature){
      const selected=[];
      node.traverseVisible(mesh=>{if(mesh.isMesh)selected.push(mesh);});
      if(!selected.length)return;
      if(target.width!==w||target.height!==h)target.setSize(w,h);
      const oldBackground=scene.background,oldMask=camera.layers.mask;
      renderer.setRenderTarget(target);renderer.setClearColor(0,0);renderer.clear();
      scene.background=null;camera.layers.set(mask);
      try{
        for(const mesh of sources)mesh.layers.enable(mask);
        scene.overrideMaterial=this.depth;renderer.autoClear=false;renderer.render(scene,camera);
        for(const mesh of sources)mesh.layers.disable(mask);
        for(const mesh of selected)mesh.layers.enable(mask);
        scene.overrideMaterial=this.white;renderer.render(scene,camera);
        const pixels=new Uint8Array(sw*sh*4);
        renderer.readRenderTargetPixels(target,x,y,sw,sh,pixels);
        cached?.masks?.dispose();
        cached={signature,distance:silhouetteDistances(pixels,sw,sh)};this.cache.set(node,cached);
      }finally{
        for(const mesh of sources)mesh.layers.disable(mask);
        renderer.setRenderTarget(null);renderer.autoClear=true;scene.background=oldBackground;scene.overrideMaterial=null;camera.layers.mask=oldMask;
      }
    }
    const uniforms=this.material.uniforms;
    const layerSignature=JSON.stringify([this.settings.width,...layers.map(row=>[row.color,!!row.agent])]);
    if(cached.layerSignature!==layerSignature){
      cached.masks?.dispose();
      cached.masks=composeBands(cached.distance,sw,sh,layers,this.settings.width*scale);
      cached.layerSignature=layerSignature;
    }
    uniforms.layers.value=cached.masks.band;uniforms.coverage.value=cached.masks.style;
    uniforms.maskOrigin.value.set(x/w,y/h);uniforms.maskSize.value.set(sw/w,sh/h);
    uniforms.opacity.value=this.settings.opacity;
    // Godot's canvas shader receives physical fragment coordinates in the
    // displayed top-down viewport and its gizmo ratio is logical width / CSS
    // width. The drawing-buffer DPR alone doesn't describe a stretched game.
    uniforms.frameHeight.value=size.y;
    uniforms.ratio.value=this.logicalPixelRatio();
    uniforms.clock.value=(performance.now()/1000)%3600;
    renderer.autoClear=false;
    renderer.setScissor(Math.floor(x*canvas.clientWidth/w),Math.floor(y*canvas.clientHeight/h),Math.ceil(sw*canvas.clientWidth/w)+1,Math.ceil(sh*canvas.clientHeight/h)+1);
    renderer.setScissorTest(true);renderer.render(this.quad,this.camera);
    renderer.setScissorTest(false);renderer.autoClear=true;
  }
  paintLabels(rows,w,h) {
    const ratio=this.logicalPixelRatio();
    this.labels.style.setProperty('--wa-label-font',Math.max(12,Math.round(12*ratio))/ratio+'px');
    const occupied=[],elements=new Map([...this.labels.children].map(el=>[el.dataset.id,el]));
    for(const [id,row] of rows){
      let el=elements.get(id);elements.delete(id);
      if(!el){el=document.createElement('span');el.dataset.id=id;this.labels.append(el);}
      this.labelGlyph(el,row.text,row.color,ratio,w);
      const width=el.getBoundingClientRect().width, left=Math.max(8,Math.min(w-width-8,row.left));
      let top=Math.max(8,Math.min(h-28,row.top-24));
      for(let i=0;i<32&&occupied.some(r=>left<r.right&&left+width>r.left&&top<r.bottom&&top+20>r.top);i++){top+=23;if(top+28>h)top=8;}
      el.style.transform='translate('+left+'px,'+top+'px)';
      occupied.push({left,top,right:left+width,bottom:top+20});
    }
    for(const el of elements.values())el.remove();
  }
  labelGlyph(el,text,color,ratio,w) {
    const fontSize=Math.max(12,Math.round(12*ratio)),font='600 '+fontSize+'px AtelierCreator,system-ui,sans-serif';
    const key=JSON.stringify([text,color,fontSize,ratio,w,this.fontRevision]);
    if(el.dataset.rasterKey===key)return;
    const measure=this.textMeasure;measure.font=font;
    const budget=Math.min(240,w-16)*ratio-16*ratio;
    const chars=Array.from(text);let display=text;
    while(chars.length>1&&measure.measureText(display).width>budget){chars.pop();display=chars.join('')+'…';}
    const metrics=measure.measureText(display),advance=metrics.width,logicalHeight=20*ratio;
    // TextServerAdvanced quantizes the viewport's glyph oversampling in
    // sixty-fourths. Measure at the logical size, raster at the viewport
    // scale, then filter the raster into the same screen-space label box.
    const sample=Math.floor(64*T.MathUtils.clamp(this.renderer.getPixelRatio()/ratio,.1,100))/64;
    const glyph=document.createElement('canvas');
    glyph.width=Math.max(1,Math.ceil(advance*sample));glyph.height=Math.max(1,Math.ceil(logicalHeight*sample));
    const ctx=glyph.getContext('2d');ctx.font='600 '+fontSize*sample+'px AtelierCreator,system-ui,sans-serif';ctx.fillStyle=color;ctx.textBaseline='alphabetic';
    const ascent=metrics.fontBoundingBoxAscent,descent=metrics.fontBoundingBoxDescent;
    ctx.fillText(display,0,((logicalHeight-ascent-descent)*.5+ascent)*sample);
    el.replaceChildren(document.createTextNode(display),glyph);
    el.style.width=advance/ratio+'px';el.style.color=color;
    glyph.style.width=glyph.width/(ratio*sample)+'px';glyph.style.height=glyph.height/(ratio*sample)+'px';
    el.dataset.rasterKey=key;
  }
  logicalPixelRatio() {
    const canvas=this.renderer.domElement,projection=this.projection;
    let width=projection?.viewport?.[0];
    if(!width || projection.stretch_mode==='disabled')return this.renderer.getPixelRatio();
    if(['expand','keep_height'].includes(projection.stretch_aspect)){
      width=Math.max(width,Math.floor(projection.viewport[1]*canvas.clientWidth/canvas.clientHeight));
    }
    return T.MathUtils.clamp(width/canvas.clientWidth,.25,8);
  }
  setContent(root,projection) {
    this.projection=projection;
    for(const entry of this.cache.values())entry.masks?.dispose();
    this.cache.clear();
    this.content=root;
  }
  dispose() {
    document.fonts.removeEventListener('loadingdone',this.fontLoaded);
    this.setContent(null);
    this.target.dispose();this.depth.dispose();this.white.dispose();disposeTree(this.quad);this.setPresence({peers:[]});this.labels.replaceChildren();
  }
}
