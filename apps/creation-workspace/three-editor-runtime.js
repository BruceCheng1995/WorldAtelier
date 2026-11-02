import * as T from 'three';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {assemble,bounds,applyEdit,localMatrix,disposeTree} from './three-editor-scene.js';
import {applyProjectedEnvironment,renderProjectedScene,disposeProjectedDepth} from './three-source-scene.js';
import {EditorCanvas} from './three-editor-canvas.js';
import {EditorPrefabGhost} from './three-editor-prefab.js';
import {EditorOverlays} from './three-editor-overlays.js';
import {fitViewportSurface} from './three-control-layout.js';

const params = new URLSearchParams(location.search), nonce = params.get('nonce'), mode = params.get('mode');
const send = (type,fields) => parent.postMessage({source:'world-atelier-preview',nonce,type,...fields},location.origin);
const clamp = T.MathUtils.clamp;

function start() {
  const canvas=document.querySelector('canvas'),scene=new T.Scene();
  const renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  scene.background=new T.Color(0xd5d4ce);
  // Match the native editing host's neutral environment and two fixed lights.
  // Source lights are additional children of the projected scene.
  scene.add(new T.AmbientLight(0xd2e0f5,.25*Math.PI));
  for(const [color,energy,pitch,yaw] of [[0xfff0d9,.65,-48,-35],[0x93bdff,.20,-22,140]]){
    const light=new T.DirectionalLight(color,energy*Math.PI);
    light.position.set(0,0,1).applyEuler(new T.Euler(T.MathUtils.degToRad(pitch),T.MathUtils.degToRad(yaw),0,'YXZ'));
    scene.add(light);
  }

  const sheet=new EditorCanvas(renderer,canvas);
  const overlays=new EditorOverlays(scene,renderer,document.querySelector('#labels'));
  const perspective=new T.PerspectiveCamera(45,1,.02,20000),ortho=new T.OrthographicCamera(-1,1,1,-1,.02,30000);
  let camera=perspective,view='perspective',distance=8,yaw=.65,pitch=.48,speed=6,sensitivity=.0025,response=.045;
  const velocity=new T.Vector3();
  const target=new T.Vector3(),ray=new T.Raycaster(),proxy=new T.Object3D(); scene.add(proxy);
  const controls=new TransformControls(camera,canvas);controls.setSize(.85);scene.add(controls.getHelper());
  let current=null,data=null,seq=-1,request=null,selection=[],tool='select',snap=false,drag=null,down=null,navigation=null;
  let frame=0,lastFrame=0,lastCamera=0,closed=false,metrics=[],fpsStart=0,hidden=document.hidden;
  const keys=new Set();
  let marks=[];
  const emit=(type,fields={})=>send(type,{seq,document_id:current?.document_id,source_revision:current?.source_revision??current?.scene_revision,source_identity:current?.source_identity,...fields});
  const screen=({clientX,clientY})=>{
    const rect=canvas.getBoundingClientRect();
    return [(clientX-rect.left)/rect.width,(clientY-rect.top)/rect.height];
  };

  function invalidate() {if(!frame&&!closed&&!hidden)frame=requestAnimationFrame(render);}
  function orbit(announce=true) {
    camera=view==='perspective'?perspective:ortho;
    controls.camera=camera;
    const direction=view==='top'?new T.Vector3(0,1,0):view==='right'?new T.Vector3(1,0,0):view==='front'?new T.Vector3(0,0,1):
      new T.Vector3(Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch));
    camera.up.set(0,view==='top'?0:1,view==='top'?1:0);
    camera.position.copy(target).addScaledVector(direction,distance);camera.lookAt(target);
    const half=distance*Math.tan(perspective.fov*Math.PI/360);
    ortho.top=half;ortho.bottom=-half;ortho.right=half*perspective.aspect;ortho.left=-ortho.right;
    ortho.updateProjectionMatrix();camera.updateMatrixWorld();
    invalidate();
    if(marks.length)projectMarks();
    if(announce && current)cameraEvent();
  }
  function projectMarks() {
    const projected=marks.filter(mark=>mark.position?.length===3).map(mark=>{
      const pos=new T.Vector3(...mark.position).project(camera);
      const rect=canvas.getBoundingClientRect();
      return {id:mark.id,screen:pos.z < -1 || pos.z > 1 ? [-1,-1] : [(rect.left+(pos.x+1)/2*rect.width)/innerWidth,(rect.top+(1-pos.y)/2*rect.height)/innerHeight]};
    });
    if(projected.length)emit('annotation_projection',{marks:projected});
  }
  function cameraEvent() {
    lastCamera=performance.now();
    if(sheet.only){emit('camera',{dimension:'2d',position:[sheet.center.x,sheet.center.y,1],target:[sheet.center.x,sheet.center.y,0],view:'canvas',projection:'orthographic',zoom:sheet.zoom});return;}
    emit('camera',{dimension:'3d',position:camera.position.toArray(),target:target.toArray(),view,projection:view==='perspective'?'perspective':'orthographic',distance,yaw,pitch,camera_speed:speed,sensitivity,response:response?'smooth':'direct',navigation:navigation?.mode==='fly'?'freelook':'',speed_multiplier:boost()});
  }
  function fit(selected=false) {
    if(!data)return;
    const item=selected?data.items.get(selection.at(-1)):null;
    if(sheet.only||item?.canvas){sheet.fit(item);invalidate();return;}
    const node=item?.node;
    const box=bounds(node??data.root,true);
    if(!node&&mode!=='object'){
      // The native frame includes empty objects such as a high camera rig,
      // in addition to the extent of their rendered meshes.
      for(const item of data.items.values()){
        if(!item.canvas&&!item.node.children.length&&!item.node.isMesh){
          const point=item.node.getWorldPosition(new T.Vector3());
          box.union(new T.Box3(point.clone().addScalar(-.2),point.clone().addScalar(.2)));
        }
      }
    }
    target.copy(box.getCenter(new T.Vector3()));
    const half=Math.min(perspective.fov*Math.PI/360,Math.atan(Math.tan(perspective.fov*Math.PI/360)*perspective.aspect));
    distance=clamp(Math.max(.15,box.getSize(new T.Vector3()).length()/2)/Math.sin(half)*1.2,.4,15000);
    orbit(false);
  }
  function layoutSurface() {
    fitViewportSurface(document.querySelector('#surface'),current?.three_projection,renderer.getPixelRatio());
  }
  window.addEventListener('resize',layoutSurface);
  function resize() {
    const w=canvas.clientWidth||1,h=canvas.clientHeight||1;
    renderer.setSize(w,h,false);sheet.resize();perspective.aspect=w/h;perspective.updateProjectionMatrix();orbit(false);
  }
  const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
  document.fonts.addEventListener('loadingdone',invalidate);
  function pick(at) {
    const control=sheet.pick(at);if(control||sheet.only)return control;
    return pickWorld(at);
  }
  function pickWorld(at){
    ray.setFromCamera(new T.Vector2(at[0]*2-1,1-at[1]*2),camera);
    const meshes=[];data?.root.traverseVisible(child=>{if(child.isMesh)meshes.push(child);});
    const hits=ray.intersectObjects(meshes,false);
    for(const hit of hits){
      let node=hit.object;
      while(node&&!node.userData.objectId)node=node.parent;
      if(node)return {id:node.userData.objectId,point:hit.point};
    }
    return null;
  }
  function placement(at) {
    const local=screen({clientX:at[0]*innerWidth,clientY:at[1]*innerHeight});
    if(local.some(value=>value<0||value>1))return null;
    if(sheet.only)return sheet.point(local);
    // HUD coordinates are logical pixels and cannot be used as world meters.
    const hit=pickWorld(local);return hit?.point??ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,1,0),0),new T.Vector3());
  }

  function select(ids,announce=false) {
    selection=[...new Set(ids)].filter(id=>data?.items.has(id)).slice(-128);
    updateControls();
    if(announce) {
      const id=selection.at(-1)??'';
      emit('selected',{...sheet.observation(id),id,ids:selection,address:data?.items.get(id)?.object.address});
    }
    invalidate();
  }
  function editMatrix(obj) {return new T.Matrix4().fromArray(obj.native_edit_world_matrix??obj.world_matrix);}
  function updateControls() {
    controls.detach();
    const item=data?.items.get(selection.at(-1));
    if(!current?.editable||mode!=='main'||item?.canvas||!item?.object.native_edit_transform||tool==='select')return;
    const world=editMatrix(item.object);
    world.decompose(proxy.position,proxy.quaternion,proxy.scale);
    proxy.updateMatrixWorld();
    controls.attach(proxy);controls.setMode(({move:'translate',rotate:'rotate',scale:'scale'})[tool]);
    controls.setSpace(tool==='scale'?'local':'world');

  }
  function editor(settings){
    if(['select','move','rotate','scale'].includes(settings.tool))tool=settings.tool;
    if(typeof settings.snap==='boolean')snap=settings.snap;
    if(!drag)updateControls();invalidate();emit('editor_state',{tool,snap,editable:current.editable});
  }

  function observation(item,world) {
    const obj=item.object,fields=obj.native_edit_transform;
    const relative=localMatrix(fields).multiply(editMatrix(obj).invert()).multiply(world);
    const p=new T.Vector3(),q=new T.Quaternion(),s=new T.Vector3();relative.decompose(p,q,s);
    const e=new T.Euler().setFromQuaternion(q,'YXZ');
    return {id:obj.id,address:obj.address,native_target:obj.native_mount_target??obj.native_target,object_version:obj.version,
      ancestry_hash:obj.ancestry_hash,dimension:'3d',world_matrix:world.toArray(),position:new T.Vector3().setFromMatrixPosition(world).toArray(),
      local_transform:{position:p.toArray(),rotation:[e.x,e.y,e.z].map(T.MathUtils.radToDeg),scale:s.toArray()}};
  }
  let pointerCtrl=false,pointerShift=false;
  function modifiers(event){pointerCtrl=event.ctrlKey;pointerShift=event.shiftKey;}
  for(const type of ['pointerdown','pointermove','keydown','keyup'])window.addEventListener(type,modifiers,true);
  function dragWorld() {
    const fine=pointerShift ? .1 : 1,snapping=snap!==pointerCtrl;
    const p=proxy.position.clone(),q=proxy.quaternion.clone(),s=proxy.scale.clone();
    if(tool==='move'){
      p.sub(drag.p).multiplyScalar(fine);
      if(snapping)for(const axis of ['x','y','z'])p[axis]=Math.round(p[axis]/.25)*.25;
      p.add(drag.p);
    }else if(tool==='rotate'){
      let angle=controls.rotationAngle*fine;
      if(snapping)angle=Math.round(angle/(Math.PI/12))*(Math.PI/12);
      q.setFromAxisAngle(controls.rotationAxis,angle).multiply(drag.q);
    }else if(tool==='scale'){
      for(const axis of ['x','y','z']){
        let factor=1+(s[axis]/drag.s[axis]-1)*fine;
        if(snapping)factor=Math.round(factor*10)/10;
        s[axis]=drag.s[axis]*Math.max(snapping ? .1 : .0001,factor);
      }
    }
    proxy.position.copy(p);proxy.quaternion.copy(q);proxy.scale.copy(s);proxy.updateMatrixWorld();
    return proxy.matrixWorld.clone().multiply(drag.inverseProxy).multiply(drag.original);
  }
  controls.addEventListener('mouseDown',()=>{
    const item=data.items.get(selection.at(-1));if(!item)return;
    proxy.updateMatrixWorld();
    drag={item,original:editMatrix(item.object),inverseProxy:proxy.matrixWorld.clone().invert(),p:proxy.position.clone(),q:proxy.quaternion.clone(),s:proxy.scale.clone(),last:0};
    emit('transform',{phase:'start',...observation(item,drag.original)});down=null;
  });
  controls.addEventListener('objectChange',()=>{
    if(!drag)return;
    const world=drag.world=dragWorld();applyEdit(drag.item,world);invalidate();
    if(performance.now()-drag.last>40){drag.last=performance.now();emit('transform',{phase:'preview',...observation(drag.item,world)});}
  });
  controls.addEventListener('mouseUp',()=>{
    if(!drag)return;
    emit('transform',{phase:'commit',...observation(drag.item,drag.world??drag.original)});drag=null;down=null;invalidate();
  });
  controls.addEventListener('change',invalidate);
  function cancelDrag() {
    if(!drag)return;
    const {item,original}=drag;drag=null;applyEdit(item,original);
    emit('transform',{phase:'cancel',...observation(item,original)});controls.dragging=false;updateControls();invalidate();
  }
  function preview(packet) {
    if(drag || canvasDrag || !data || packet.source_identity!==current.source_identity)return;
    for(const item of data.worldItems.values()){item.node.matrix.copy(item.node.userData.original);item.node.matrixWorldNeedsUpdate=true;}
    sheet.preview(packet.objects??[]);
    data.root.updateMatrixWorld(true);
    for(const row of packet.objects??[]){
      const item=data.items.get(row.id);if(!item)continue;
      if(item.canvas){
        const measured=sheet.observation(row.id);
        if(measured&&packet.observe_ids?.includes(row.id))emit('native_transform_preview',measured);
        continue;
      }
      let world;
      if(row.world_matrix)world=new T.Matrix4().fromArray(row.world_matrix);
      else if(row.local_transform_patch){
        const original=item.object.native_edit_transform,fields={...original,...row.local_transform_patch};
        world=editMatrix(item.object).multiply(localMatrix(original).invert()).multiply(localMatrix(fields));
      }
      if(!world)continue;
      applyEdit(item,world);
      if(packet.observe_ids?.includes(row.id))emit('native_transform_preview',observation(item,world));
    }
    invalidate();
  }

  async function load(packet) {
    if(packet.seq<=seq)return;
    request?.abort();const own=new AbortController();request=own;
    release();ghost.clear();seq=packet.seq;current=packet;
    try {
      const next=await assemble(packet,own.signal);
      if(own.signal.aborted){disposeTree(next.root);disposeTree(next.canvasRoot);return;}
      controls.detach();
      if(data){scene.remove(data.root);disposeTree(data.root);}
      data=next;data.worldItems=new Map([...data.items].filter(([,item])=>!item.canvas));scene.add(data.root);overlays.setContent(data.root,packet.three_projection);
      applyProjectedEnvironment(T,scene,renderer,{...packet.three_projection,environment:null});
      marks=[];
      // Native editing keeps its dedicated backdrop and frames the authored
      // aspect. Letterboxed pixels aren't active hit/placement coordinates.
      scene.background=new T.Color(0xd5d4ce);
      layoutSurface();
      resize();sheet.load(next,packet.three_projection,packet.frame||seq===1);
      overlays.states=packet.objects.flatMap(o=>o.developments??[]);
      overlays.setPresence({peers:[]});sheet.outline.setPresence({peers:[]});sheet.outline.states=overlays.states;
      select(packet.selected_ids??(packet.selected_id?[packet.selected_id]:[]));
      if(packet.frame||seq===1)fit();
      const meshes=[];data.root.traverseVisible(node=>{if(node.isMesh)meshes.push(node);});
      const unsupportedShader=meshes.some(mesh=>[].concat(mesh.material??[]).some(mat=>mat.userData.nativeShaderStatus==='unsupported'));
      data.animated=meshes.some(mesh=>[].concat(mesh.material??[]).some(mat=>mat.userData.timeDependent));
      draw();
      emit('loaded',{dimension:sheet.only?'2d':'3d',mesh_count:meshes.length,object_ids:[...data.items.keys()],selected_id:selection.at(-1)??'',selected_ids:selection,
        objects:[...sheet.items.keys()].map(id=>sheet.observation(id)).filter(Boolean).map(row=>({...row,source_revision:packet.source_revision,source_identity:packet.source_identity})),source_identity:packet.source_identity,renderer:'three',preview_object_id:packet.preview_object_id??null,unsupported_shader:unsupportedShader,runtime_version:T.REVISION});
      cameraEvent();
    } catch(error) {if(!own.signal.aborted)emit('error',{message:error.message});}
  }

  const boost=()=>keys.has('ShiftLeft')||keys.has('ShiftRight')?3:(keys.has('AltLeft')||keys.has('AltRight')) ? .2 : 1;
  function fly(dt) {
    if(sheet.only||navigation?.mode!=='fly')return false;
    const forward=camera.getWorldDirection(new T.Vector3()),right=new T.Vector3().crossVectors(forward,camera.up).normalize();
    const desired=new T.Vector3();
    desired.addScaledVector(forward,Number(keys.has('KeyW'))-Number(keys.has('KeyS')));
    desired.addScaledVector(right,Number(keys.has('KeyD'))-Number(keys.has('KeyA')));
    desired.y+=Number(keys.has('KeyE'))-Number(keys.has('KeyQ'));
    const active=desired.lengthSq()>0;
    if(!active&&velocity.lengthSq()<1e-6){velocity.set(0,0,0);return false;}
    desired.normalize().multiplyScalar(speed*boost());
    const duration=active?response:Math.min(response,.02);
    const decay=duration?Math.exp(-dt/duration):0,prior=velocity.clone().sub(desired);
    target.addScaledVector(desired,dt).addScaledVector(prior,duration*(1-decay));
    velocity.copy(desired).addScaledVector(prior,decay);
    orbit(false);if(performance.now()-lastCamera>100)cameraEvent();return true;
  }
  function draw() {
    overlays.updateMarkers(camera);renderProjectedScene(T,renderer,scene,camera);
    if(data){
      if(!sheet.only)overlays.draw(camera,data.worldItems,selection,mode,Boolean(navigation));
      sheet.render(selection,mode,current.editable&&mode==='main');
    }
  }
  function render(now) {
    frame=0;if(closed||hidden)return;
    const dt=lastFrame?now-lastFrame:0;lastFrame=now;
    const moving=fly(Math.min(dt/1000,.05));draw();
    const animate=moving||Boolean(data?.animated)||overlays.settings.show_agents&&overlays.states.some(state=>data?.items.has(state.id));
    if(animate)invalidate();
    if(animate&&dt>0&&dt<300)metrics.push(dt);
    if(!animate){metrics=[];fpsStart=0;lastFrame=0;}
    else if(!fpsStart)fpsStart=now;
    else if(now-fpsStart>1000 && metrics.length){
      const sorted=metrics.sort((a,b)=>a-b),mean=sorted.reduce((a,b)=>a+b,0)/sorted.length;
      emit('viewport_performance',{fps:1000/mean,frame_ms:mean,p95_ms:sorted[Math.floor(sorted.length*.95)]});metrics=[];fpsStart=now;
    }
  }

  function cameraCommand(action) {
    const bookmark=action?.bookmark;
    if(bookmark){
      if(![bookmark.target,bookmark.position].every(v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)))return;
      if(sheet.only&&bookmark.dimension==='2d'&&Number.isFinite(bookmark.zoom)){
        sheet.center.set(...bookmark.target);sheet.zoom=clamp(bookmark.zoom,.001,1000);sheet.update();
      }else if(!sheet.only&&bookmark.dimension==='3d'&&['perspective','top','right','front'].includes(bookmark.view)){
        const offset=new T.Vector3(...bookmark.position).sub(new T.Vector3(...bookmark.target));
        if(offset.length()<.001)return;
        target.fromArray(bookmark.target);distance=clamp(offset.length(),.1,15000);
        yaw=Math.atan2(offset.x,offset.z);pitch=Math.asin(clamp(offset.normalize().y,-1,1));view=bookmark.view;
      }else return;
      orbit();return;
    }
    if(action==='fit'||action==='focus')fit(action==='focus');
    else if(action==='rotate'){view='perspective';yaw+=.35;}
    else if(['top','front','right','perspective'].includes(action)){view=action;fit(true);}
    orbit();
  }

  let canvasDrag=null;
  function canvasChange(phase,at){
    const d=canvasDrag;if(!d)return;
    const {obj,before,initial,handle,start,tool}=d;
    const parent=d.parentInverse,world=sheet.point(at),startWorld=sheet.point(start);
    const local=world.clone().applyMatrix4(parent).sub(startWorld.clone().applyMatrix4(parent));
    const own=d.world.clone().invert(),delta=world.clone().applyMatrix4(own).sub(startWorld.clone().applyMatrix4(own));
    const values=structuredClone(initial);
    const [oldW,oldH]=initial.size,shift=new T.Vector3();let key='offsets';
    if(handle>=0){
      const left=[0,6,7].includes(handle),right=[2,3,4].includes(handle),top=[0,1,2].includes(handle),bottom=[4,5,6].includes(handle);
      const minimum=obj.control_layout.minimum_size??[0,0];
      values.size=[Math.max(minimum[0],oldW+(right?delta.x:left?-delta.x:0)),Math.max(minimum[1],oldH+(bottom?delta.y:top?-delta.y:0))];
      shift.set(left?oldW-values.size[0]:0,top?oldH-values.size[1]:0,0).applyMatrix4(before).sub(new T.Vector3().setFromMatrixPosition(before));
    }else if(tool==='move')shift.copy(local);
    else if(tool==='rotate'){key='rotation_degrees';values.rotation_degrees+=((at[0]-start[0])*canvas.clientWidth)*.5;}
    else if(tool==='scale'){key='scale';const factor=Math.max(.01,1+(at[0]-start[0])*canvas.clientWidth*.01);values.scale=initial.scale.map(n=>n*factor);}
    values.position=[initial.position[0]+shift.x,initial.position[1]+shift.y];
    values.offsets=initial.offsets.map((v,i)=>v+(i%2?shift.y:shift.x)+(i<2?0:values.size[i-2]-initial.size[i-2]));
    const changed={[key]:values[key]},overrides=new Map(d.originalOverrides);
    if(phase==='preview'||phase==='commit')overrides.set(obj.native_path,{...overrides.get(obj.native_path),...changed});
    sheet.setOverrides(overrides);
    emit('transform',{...sheet.observation(obj.id),phase,control_changed:changed,tool,handle:handle>=0?'resize_'+handle:'xy'});
    invalidate();
  }
  function beginCanvasDrag(event){
    if(event.button!==0||keys.has('Space')||event.shiftKey||event.ctrlKey||event.metaKey||!current.editable||mode!=='main'||selection.length!==1)return false;
    const item=sheet.items?.get(selection[0]);if(!item?.object.native_edit_transform||item.object.control_layout?.container_managed)return false;
    const at=screen(event),points=sheet.handlePoints(item);
    const handle=points.findIndex(([x,y])=>Math.hypot(x-at[0]*canvas.clientWidth,y-at[1]*canvas.clientHeight)<=8);
    if(handle<0&&(tool==='select'||sheet.pick(at)?.id!==item.object.id))return false;
    canvasDrag={obj:item.object,handle,start:at,before:item.node.matrix.clone(),world:item.node.matrixWorld.clone(),
      parentInverse:item.node.parent.matrixWorld.clone().invert(),initial:structuredClone(item.object.control_layout.values),originalOverrides:sheet.overrides,tool};
    canvasChange('start',at);canvas.setPointerCapture(event.pointerId);event.preventDefault();return true;
  }
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  canvas.addEventListener('pointerdown',event=>{
    if(!data)return;
    canvas.focus({preventScroll:true});if(beginCanvasDrag(event))return;
    if(!sheet.only&&event.button===0&&event.altKey){
      const anchor=data.items.get(selection.at(-1));
      navigation={mode:'pivot',x:event.clientX,y:event.clientY,pivot:anchor&&!anchor.canvas?bounds(anchor.node).getCenter(new T.Vector3()):target.clone()};
      canvas.setPointerCapture(event.pointerId);event.preventDefault();return;
    }
    if(event.button===2 || event.button===1 || event.button===0&&keys.has('Space')){
      navigation={mode:event.button===1||event.shiftKey||keys.has('Space')?'pan':'fly',x:event.clientX,y:event.clientY};
      canvas.setPointerCapture(event.pointerId);
      if(!sheet.only&&navigation.mode==='fly'&&canvas.requestPointerLock){
        const gesture=navigation;
        try{
          const pending=canvas.requestPointerLock();
          pending?.catch(()=>{if(navigation===gesture)endNavigation();});
        }catch{endNavigation();}
        cameraEvent();invalidate();
      }
      event.preventDefault();return;
    }
    if(event.button!==0||controls.dragging)return;
    down={x:event.clientX,y:event.clientY};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove',event=>{
    if(canvasDrag){canvasChange('preview',screen(event));return;}
    if(!navigation)return;
    const locked=document.pointerLockElement===canvas;
    const dx=locked?event.movementX:event.clientX-navigation.x,dy=locked?event.movementY:event.clientY-navigation.y;
    navigation.x=event.clientX;navigation.y=event.clientY;
    if(sheet.only){
      sheet.center.x-=dx*sheet.resolution[0]/canvas.clientWidth/sheet.zoom;
      sheet.center.y-=dy*sheet.resolution[1]/canvas.clientHeight/sheet.zoom;sheet.update();invalidate();cameraEvent();return;
    }
    if(navigation.mode==='pan'){
      const scale=2*distance*Math.tan(perspective.fov*Math.PI/360)/canvas.clientHeight;
      const right=new T.Vector3().setFromMatrixColumn(camera.matrix,0),up=new T.Vector3().setFromMatrixColumn(camera.matrix,1);
      target.addScaledVector(right,-dx*scale).addScaledVector(up,dy*scale);
    }else{
      const old=camera.position.clone(),previousQ=camera.quaternion.clone();yaw-=dx*sensitivity;pitch=clamp(pitch+dy*sensitivity,-1.48,1.48);view='perspective';orbit(false);
      if(navigation.mode==='fly')target.add(old.sub(camera.position));
      else if(navigation.mode==='pivot'){
        // Rotate the eye and target together, preserving an off-center selection on screen.
        const rotation=camera.quaternion.clone().multiply(previousQ.invert());
        const eye=old.sub(navigation.pivot).applyQuaternion(rotation).add(navigation.pivot);
        target.add(eye.sub(camera.position));
      }
    }
    orbit(false);if(performance.now()-lastCamera>45)cameraEvent();
  });
  canvas.addEventListener('pointerup',event=>{
    if(canvasDrag){canvasChange('commit',screen(event));canvasDrag=null;return;}
    if(navigation){endNavigation();return;}
    const gesture=down;down=null;if(!gesture||drag||!data||event.button!==0)return;
    if(Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>5)return;
    const hit=pick(screen(event)),toggle=event.ctrlKey||event.metaKey;
    if(!hit){if(!toggle&&!event.shiftKey)select([],true);return;}
    if(toggle&&selection.includes(hit.id))select(selection.filter(id=>id!==hit.id),true);
    else if(toggle||event.shiftKey)select([...selection.filter(id=>id!==hit.id),hit.id],true);
    else {
      const path=[];
      for(let node=data.items.get(hit.id)?.node;node;node=node.parent)if(node.userData.objectId)path.unshift(node.userData.objectId);
      if(path.length>1&&data.items.get(path[0]).object.native_path==='.')path.shift();
      const level=selection.length===1?path.indexOf(selection[0]):-1;
      select([path[Math.min(level+1,path.length-1)]??hit.id],true);
    }
  });
  function endNavigation(){
    const wasActive=!!navigation;navigation=null;velocity.set(0,0,0);
    if(document.pointerLockElement===canvas)document.exitPointerLock();
    if(wasActive)cameraEvent();
  }
  document.addEventListener('pointerlockerror',()=>{if(navigation?.mode==='fly')endNavigation();});
  document.addEventListener('pointerlockchange',()=>{
    if(document.pointerLockElement===canvas){
      if(navigation?.mode==='fly')navigation.locked=true;
      else document.exitPointerLock(); // Ignore a grant arriving after mouseup.
    }else if(navigation?.locked)endNavigation();
  });
  function release(){
    if(canvasDrag){canvasChange('cancel',canvasDrag.start);canvasDrag=null;}
    down=null;endNavigation();keys.clear();cancelDrag();
  }
  canvas.addEventListener('pointercancel',release);
  window.addEventListener('blur',release);
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    const factor=Math.exp(clamp(event.deltaY,-400,400)*.001);
    if(sheet.only){
      const at=screen(event),before=sheet.point(at);sheet.zoom=clamp(sheet.zoom/factor,.001,1000);sheet.update();
      const after=sheet.point(at);sheet.center.x+=before.x-after.x;sheet.center.y+=before.y-after.y;
      sheet.update();invalidate();cameraEvent();return;
    }
    if(navigation)speed=clamp(speed/factor,.1,1000);
    else distance=clamp(distance*factor,.1,15000);
    orbit();
  },{passive:false});
  window.addEventListener('keydown',event=>{
    if(!current)return;keys.add(event.code);
    if(event.code==='Escape'){release();return;}
    if((event.ctrlKey||event.metaKey)&&['KeyY','KeyZ'].includes(event.code)&&current.editable){
      event.preventDefault();emit('history',{action:event.shiftKey||event.code==='KeyY'?'redo':'undo'});return;
    }
    if(navigation){event.preventDefault();invalidate();return;}
    if(event.repeat)return;
    if(event.code==='KeyF'){cameraCommand(event.shiftKey?'fit':'focus');return;}
    const choice={KeyQ:'select',KeyW:'move',KeyE:'rotate',KeyR:'scale'}[event.code];
    if(choice&&current.editable)editor({tool:choice});
  });
  window.addEventListener('keyup',event=>keys.delete(event.code));
  const ghost=new EditorPrefabGhost({scene,sheet,context:()=>({data,current}),placement,
    reply:fields=>emit('prefab_drag',fields),redraw:invalidate});
  window.addEventListener('message',event=>{
    const m=event.data;
    if(event.source!==parent||event.origin!==location.origin||m?.source!=='world-atelier-workspace'||m.nonce!==nonce)return;
    if(m.type==='scene'){void load(m);return;}
    if(!data||m.seq!==seq||m.document_id&&m.document_id!==current.document_id)return;
    switch(m.type){
      case 'camera': cameraCommand(m.action);break;
      case 'annotation': marks=m.marks??[];projectMarks();break;
      case 'editor': editor(m);break;
      case 'select':
        if(canvasDrag&&!(m.ids??[m.id]).includes(canvasDrag.obj.id)){canvasChange('cancel',canvasDrag.start);canvasDrag=null;}
        cancelDrag();select(m.ids??[m.id]);break;
      case 'editor_preview': preview(m);break;
      case 'presence': overlays.setPresence(m);sheet.outline.setPresence({...m,peers:(m.peers??[]).map(peer=>({...peer,camera:null}))});invalidate();break;
      case 'development': overlays.states=sheet.outline.states=m.states??[];invalidate();break;
      case 'display_settings': Object.assign(overlays.settings,m.settings);Object.assign(sheet.outline.settings,m.settings);invalidate();break;
      case 'navigation_settings': speed=m.camera_speed??speed;sensitivity=m.sensitivity??sensitivity;if(m.response)response=m.response==='direct'?0:.045;cameraEvent();break;
      case 'placement': {
        const point=current.editable && placement(m.screen);
        emit('placement',{request_id:m.request_id,dimension:sheet.only?'2d':'3d',...(point?{position:sheet.only?point.toArray().slice(0,2):point.toArray()}:{error:'placement_no_intersection'})});break;
      }
      case 'prefab_drag': ghost.receive(m);break;
      case 'capture': draw();break;
    }
  });
  document.addEventListener('visibilitychange',()=>{hidden=document.hidden;if(!hidden)invalidate();else release();});
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();emit('error',{message:'Three.js 图形上下文已丢失，请重新打开场景。'});});
  window.addEventListener('pagehide',()=>{
    closed=true;ghost.clear();cancelAnimationFrame(frame);request?.abort();observer.disconnect();controls.dispose();overlays.dispose();sheet.dispose();
    scene.remove(controls.getHelper());disposeTree(scene);disposeProjectedDepth(renderer);renderer.dispose();renderer.forceContextLoss();
  },{once:true});
  // The outer frame reads pixels only on explicit screenshot requests. Render
  // synchronously in that callback so idle rendering can discard its backbuffer.
  window.waRenderForCapture=draw;
  send('ready',{renderer:'three',runtime_version:T.REVISION});
}
try{start();}catch(error){send('three_init_error',{message:'Three.js 编辑器启动失败 · '+error.message});}
