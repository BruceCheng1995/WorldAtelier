import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

function disposeTree(root) {
  const geometries=new Set(),materials=new Set(),textures=new Set();
  root?.traverse(node=>{
    if(node.geometry)geometries.add(node.geometry);
    for(const material of Array.isArray(node.material)?node.material:node.material?[node.material]:[]){
      materials.add(material);
      for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
    }
    node.skeleton?.dispose();
  });
  for(const texture of textures){texture.source?.data?.close?.();texture.dispose();}
  for(const material of materials)material.dispose();
  for(const geometry of geometries)geometry.dispose();
}

function standaloneDocument(buffer) {
  const view=new DataView(buffer);
  if(buffer.byteLength<28||view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==buffer.byteLength||view.getUint32(16,true)!==0x4e4f534a)throw Error('模型不是有效的 GLB 2.0 文件');
  const jsonLength=view.getUint32(12,true);
  if(jsonLength>4*1024*1024||20+jsonLength>buffer.byteLength)throw Error('模型文件结构无效');
  const json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,jsonLength)));
  if([...(json.buffers??[]),...(json.images??[])].some(part=>part.uri!=null))throw Error('仅支持嵌入网格和纹理的独立 GLB');
  const unsupported=(json.extensionsRequired??[]).filter(name=>['KHR_draco_mesh_compression','KHR_texture_basisu','EXT_meshopt_compression','KHR_meshopt_compression'].includes(name));
  if(unsupported.length)throw Error('此模型使用压缩扩展，请提供未压缩的 GLB 后预览：'+unsupported.join('、'));
  return json;
}

export function mountModelPreview(host,{asset,onAuthError=()=>{},onRetry,sourceUrl=null}) {
  host.innerHTML=`<section class="model-preview" aria-label="模型预览">
    <div class="model-heading"><strong>模型预览</strong><span class="muted">只读查看</span><button class="button small" data-model="expand" aria-pressed="false">放大预览</button></div>
    <div class="model-stage"><canvas tabindex="0" aria-label="3D 模型。拖动旋转，滚轮缩放，右键拖动平移；方向键旋转，加减键缩放，F 复位。"></canvas><div class="model-message" role="status">正在读取模型…</div></div>
    <div class="model-toolbar" aria-label="模型显示控制"><button class="button small" data-model="reset" disabled>复位视角</button><button class="button small" data-model="wire" aria-pressed="false" disabled>线框</button><button class="button small" data-model="rotate" aria-pressed="false" disabled>自动旋转</button><button class="button small" data-model="grid" aria-pressed="true" disabled>网格</button></div>
    <div class="model-animation" hidden><label>动画<select aria-label="选择模型动画"></select></label><button class="button small" data-model="play" aria-pressed="false">播放动画</button></div>
    <p class="model-help">拖动旋转 · 滚轮 / 双指缩放 · 右键拖动平移</p><p class="model-stats" aria-live="polite"></p>
  </section>`;
  const $=s=>host.querySelector(s),stage=$('.model-stage'),canvas=$('canvas'),message=$('.model-message'),dialog=host.closest('dialog');
  const abort=new AbortController();
  let disposed=false,renderer,scene,controls,camera,grid,model,mixer,gltf,frame=0,resizeObserver,loaded=false,rotating=false,playing=false,lastTime=0,radius=1;
  let pollTimer,checking=false;
  const state=(value,text)=>{host.dataset.previewState=value;if(text)message.textContent=text;message.hidden=value==='ready';};
  const stopGraphics=()=>{
    cancelAnimationFrame(frame);resizeObserver?.disconnect();controls?.dispose();
    mixer?.stopAllAction();if(model)mixer?.uncacheRoot(model);
    if(gltf)for(const root of new Set(gltf.scenes))disposeTree(root);
    disposeTree(grid);renderer?.dispose();renderer?.forceContextLoss();
    gltf=null;model=null;renderer=null;canvas.hidden=true;
  };
  const fail=error=>{
    if(disposed)return;stopGraphics();loaded=false;clearInterval(pollTimer);
    state('error',error.message||'无法预览模型');
    host.querySelectorAll('[data-model]').forEach(button=>{if(button.dataset.model!=='expand')button.disabled=true;});
    const retry=document.createElement('button');retry.className='button small';retry.textContent='重新加载';
    retry.onclick=()=>onRetry();message.append(document.createElement('br'),retry);
  };
  function dispose(){if(disposed)return;disposed=true;abort.abort();clearInterval(pollTimer);stopGraphics();host.removeEventListener('click',click);canvas.removeEventListener('keydown',key);document.removeEventListener('visibilitychange',visibility);dialog?.classList.remove('model-expanded');host.dataset.previewState='disposed';}
  function reset(){if(!controls||!loaded)return;controls.target.set(0,0,0);const half=Math.min(THREE.MathUtils.degToRad(camera.fov)/2,Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov)/2)*camera.aspect));const distance=radius/Math.sin(half)*1.15;camera.position.copy(new THREE.Vector3(1,.65,1.2).normalize().multiplyScalar(distance));controls.update();}
  function zoom(factor){camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);controls.update();}
  function selectAnimation(){mixer.stopAllAction();if((playing||sourceUrl)&&gltf.animations.length){mixer.clipAction(gltf.animations[Number($('.model-animation select').value)]).reset().play();if(!playing)mixer.update(0.05);}}
  function click(event){
    const button=event.target.closest('[data-model]');if(!button||button.disabled)return;const action=button.dataset.model;
    if(action==='expand'){const expanded=dialog?.classList.toggle('model-expanded');button.setAttribute('aria-pressed',String(Boolean(expanded)));button.textContent=expanded?'收起预览':'放大预览';return;}
    if(!loaded)return;
    if(action==='reset')reset();
    if(action==='wire'){const enabled=button.getAttribute('aria-pressed')!=='true';model.traverse(node=>{for(const material of Array.isArray(node.material)?node.material:node.material?[node.material]:[])material.wireframe=enabled;});button.setAttribute('aria-pressed',String(enabled));}
    if(action==='rotate'){rotating=!rotating;controls.autoRotate=rotating;button.setAttribute('aria-pressed',String(rotating));}
    if(action==='grid'){grid.visible=!grid.visible;button.setAttribute('aria-pressed',String(grid.visible));}
    if(action==='play'){playing=!playing;button.setAttribute('aria-pressed',String(playing));button.textContent=playing?'暂停动画':'播放动画';if(playing){const clip=gltf.animations[Number($('.model-animation select').value)],current=mixer.existingAction(clip);if(!current?.isRunning())mixer.clipAction(clip).play();}}
  }
  function key(event){
    if(!loaded||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','f','F'].includes(event.key))return;event.preventDefault();
    if(event.key.toLowerCase()==='f')reset();else if(['+','=','-'].includes(event.key))zoom(event.key==='-'?1.15:1/1.15);
    else {const offset=camera.position.clone().sub(controls.target),spherical=new THREE.Spherical().setFromVector3(offset);spherical.theta+=(event.key==='ArrowLeft'?.12:event.key==='ArrowRight'?-.12:0);spherical.phi+=(event.key==='ArrowUp'?-.12:event.key==='ArrowDown'?.12:0);spherical.makeSafe();camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));controls.update();}
  }
  function resize(){if(!renderer)return;const width=Math.max(1,stage.clientWidth),height=Math.max(1,stage.clientHeight);renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();}
  function render(time){
    if(disposed||!renderer||document.hidden)return;
    const delta=lastTime?Math.min((time-lastTime)/1000,.05):0;lastTime=time;controls.update(delta);if(playing)mixer?.update(delta);renderer.render(scene,camera);frame=requestAnimationFrame(render);
  }
  function visibility(){cancelAnimationFrame(frame);lastTime=0;if(!document.hidden&&renderer){void checkAccess();frame=requestAnimationFrame(render);}}
  async function checkAccess(){
    if(sourceUrl)return;
    if(disposed||checking||document.hidden)return;checking=true;
    try{const response=await fetch('/creation-api/admin/assets/'+asset.id,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
      const data=await response.json();if(disposed)return;
      if(response.status===401||response.status===403){onAuthError(data.error);dispose();return;}
      if(!response.ok)throw Error(data.error||'无法核对资产状态');
      if(data.item.status==='quarantined')throw Error('此模型已隔离，请先恢复资产再预览');
    }catch(error){if(!disposed)fail(error);}finally{checking=false;}
  }
  host.addEventListener('click',click);canvas.addEventListener('keydown',key);document.addEventListener('visibilitychange',visibility);
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();if(!disposed&&renderer)fail(Error('图形上下文已丢失，请重新加载预览'));},{signal:abort.signal});
  state('loading');
  void (async()=>{
    const response=await fetch(sourceUrl??('/admin-models/'+asset.id+'.glb'),{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])});
    if(!response.ok){const data=await response.json().catch(()=>({}));if(response.status===401){onAuthError(data.error);dispose();return;}throw Error(data.error||'模型读取失败');}
    const buffer=await response.arrayBuffer();if(disposed)return;standaloneDocument(buffer);state('loading','正在解析网格与材质…');
    const manager=new THREE.LoadingManager();manager.setURLModifier(url=>{if(!url.startsWith('blob:'+location.origin+'/'))throw Error('模型包含不允许的外部资源');return url;});
    const loadedGltf=await new GLTFLoader(manager).parseAsync(buffer,'');
    if(disposed){for(const root of new Set(loadedGltf.scenes))disposeTree(root);return;}
    gltf=loadedGltf;model=gltf.scene;model.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
    if(bounds.isEmpty()||![...size,...center].every(Number.isFinite)||size.length()<=0)throw Error('模型没有可显示的有效网格');
    renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
    scene=new THREE.Scene();scene.background=new THREE.Color('#e8ede5');
    scene.add(new THREE.HemisphereLight(0xffffff,0x657969,2.8));const keyLight=new THREE.DirectionalLight(0xfff6df,3);keyLight.position.set(4,8,5);scene.add(keyLight);const fill=new THREE.DirectionalLight(0xc3dafa,1.5);fill.position.set(-4,3,-5);scene.add(fill);
    const container=new THREE.Group();container.position.copy(center).negate();container.add(model);scene.add(container);
    radius=Math.max(size.length()/2,1e-6);grid=new THREE.GridHelper(radius*3,20,0x9aa995,0xc9d3c2);grid.position.y=bounds.min.y-center.y-radius*.005;scene.add(grid);
    camera=new THREE.PerspectiveCamera(40,1,radius/1000,radius*1000);controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.minDistance=radius*.05;controls.maxDistance=radius*30;controls.autoRotateSpeed=1;controls.target.set(0,0,0);
    mixer=new THREE.AnimationMixer(model);resizeObserver=new ResizeObserver(resize);resizeObserver.observe(stage);resize();loaded=true;reset();canvas.hidden=false;
    let meshes=0,triangles=0;const materials=new Set();model.traverse(node=>{if(node.isMesh){meshes++;const geometry=node.geometry;triangles+=Math.floor((geometry.index?.count??geometry.attributes.position?.count??0)/3)*(node.isInstancedMesh?node.count:1);for(const material of Array.isArray(node.material)?node.material:[node.material])materials.add(material);}});
    const format=n=>Number(n.toPrecision(4)).toLocaleString('zh-CN');$('.model-stats').textContent=`${meshes.toLocaleString('zh-CN')} 个网格实例 · ${triangles.toLocaleString('zh-CN')} 个三角面 · ${materials.size} 种材质 · ${gltf.animations.length} 段动画 ｜ 尺寸 ${[size.x,size.y,size.z].map(format).join(' × ')}（模型单位）`;
    host.querySelectorAll('[data-model]').forEach(button=>button.disabled=false);
    if(gltf.animations.length){$('.model-animation').hidden=false;const select=$('.model-animation select');gltf.animations.forEach((clip,index)=>select.add(new Option(clip.name||'动画 '+(index+1),String(index))));select.onchange=selectAnimation;if(sourceUrl){const idle=gltf.animations.findIndex(clip=>/^idle$/i.test(clip.name));select.value=String(Math.max(0,idle));selectAnimation();}}
    state('ready');frame=requestAnimationFrame(render);pollTimer=setInterval(()=>void checkAccess(),5000);
  })().catch(error=>{if(!disposed)fail(error);});
  return {dispose};
}
