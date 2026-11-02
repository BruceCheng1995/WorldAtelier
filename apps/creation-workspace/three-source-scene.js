import {bindProjectedFog,createNativeSurfaceMaterial,projectSkyAndFog} from './three-native-materials.js';
export {prepareProjectedDepth,disposeProjectedDepth,renderProjectedScene} from './three-native-post.js';
export {createNativeSurfaceMaterial,bindProjectedFog} from './three-native-materials.js';
export {bindProjectedControls,layoutProjectedCanvas,logicalCanvasViewport} from './three-control-layout.js';
// Construct only from the platform's read-only projection. No authored scripts
// or URLs are interpreted by the same-origin editor.
export function createProjectedNode(THREE,row,resources) {
  let object;
  if(row.mesh?.type==='surfaces'){
    object=surfaceObject(THREE,row,resources);
  }else if(row.label){
    object=captionMesh(THREE,row.label);
  }else if(row.canvas){
    object=createCanvasVisual(THREE,row.canvas,resources);
  }else if(row.mesh){
    const m=row.mesh;
    const key=JSON.stringify(m);
    let shared=resources?.get(key);
    if(!shared){
      const geometry=primitiveGeometry(THREE,m);
      const [r,g,b,a]=m.color??[1,1,1,1];
      const material=new THREE.MeshStandardMaterial({color:new THREE.Color(r,g,b).convertSRGBToLinear(),roughness:m.roughness??1,
        metalness:m.metallic??0,emissive:new THREE.Color(...(m.emission??[0,0,0]).slice(0,3)).convertSRGBToLinear(),emissiveIntensity:m.emission_energy??1,
        transparent:Boolean(m.transparent),opacity:m.transparent?a:1});
      shared={geometry,material:bindProjectedFog(THREE,material)};resources?.set(key,shared);
    }
    object=new THREE.Mesh(shared.geometry,shared.material);
    object.castShadow=row.cast_shadow!==false;object.receiveShadow=true;
  }else if(row.light){
    // Godot GL Compatibility scales non-physical light energy by PI.
    const light=row.light,color=new THREE.Color(...light.color.slice(0,3)).convertSRGBToLinear(),intensity=light.sky_mode===2?0:light.energy*Math.PI;
    if(row.type==='DirectionalLight3D')object=new THREE.DirectionalLight(color,intensity);
    else if(row.type==='SpotLight3D')object=new THREE.SpotLight(color,intensity,light.range,light.angle*Math.PI/180,0,light.attenuation??1);
    else object=new THREE.PointLight(color,intensity,light.range,light.attenuation??1);
    object.castShadow=light.shadow;
    if(object.target){object.target.position.set(0,0,-1);object.add(object.target);}
    if(light.shadow&&object.isDirectionalLight){
      const lightNode=object,distance=light.shadow_distance;
      object=new THREE.Group();object.add(lightNode);
      lightNode.position.z=distance/2;
      Object.assign(lightNode.shadow.camera,{left:-distance/2,right:distance/2,top:distance/2,bottom:-distance/2,far:distance*2});
      lightNode.shadow.camera.updateProjectionMatrix();
    }
  }else if(row.camera){
    if(row.camera.projection===1){
      const half=row.camera.size/2;object=new THREE.OrthographicCamera(-half,half,half,-half,row.camera.near,row.camera.far);
    }else object=new THREE.PerspectiveCamera(row.camera.fov,1,row.camera.near,row.camera.far);
  }else object=new THREE.Group();
  object.name=row.path;object.userData.nativePath=row.path;object.visible=row.visible!==false;
  if(row.prefabPath)object.userData.prefabPath=row.prefabPath;
  if(row.world_matrix){object.matrix.fromArray(row.world_matrix);object.matrix.decompose(object.position,object.quaternion,object.scale);object.matrixAutoUpdate=false;}
  return object;
}

// Apply/restore editor lighting when the selected source document changes.
const defaults=new WeakMap();
export function applyProjectedEnvironment(THREE,scene,renderer,projection){
  if(!defaults.has(scene))defaults.set(scene,{background:scene.background,environment:scene.environment,fog:scene.fog,backgroundIntensity:scene.backgroundIntensity,environmentIntensity:scene.environmentIntensity,tone:renderer.toneMapping,exposure:renderer.toneMappingExposure});
  const original=defaults.get(scene);
  original.ambient?.removeFromParent();
  const env=projection?.environment;scene.userData.nativeTone=env??null;
  scene.background=original.background;scene.environment=original.environment;scene.fog=original.fog;
  scene.backgroundIntensity=original.backgroundIntensity;scene.environmentIntensity=original.environmentIntensity;
  renderer.toneMapping=original.tone;
  renderer.toneMappingExposure=original.exposure;
  renderer.shadowMap.enabled=Boolean(projection?.nodes.some(row=>row.light?.shadow));
  if(!env){projectSkyAndFog(THREE,scene,projection,original);return false;}
  scene.background=new THREE.Color(...env.background.slice(0,3)).multiplyScalar(env.background_energy);
  const skyAmbient=env.sky&&(env.ambient_source===3||env.ambient_source===0&&env.background_mode===2);
  const ambientFactor=env.ambient_source===1?0:skyAmbient?1-(env.sky_contribution??1):1;
  original.ambient=new THREE.AmbientLight(new THREE.Color(...env.ambient.slice(0,3)).convertSRGBToLinear(),Math.PI*env.ambient_energy*ambientFactor);
  scene.add(original.ambient);
  renderer.toneMapping=[THREE.LinearToneMapping,THREE.ReinhardToneMapping,THREE.CineonToneMapping,THREE.ACESFilmicToneMapping,THREE.AgXToneMapping][env.tone_mapper]??original.tone;
  renderer.toneMappingExposure=env.exposure;
  projectSkyAndFog(THREE,scene,projection,original);
  return true;
}

function primitiveGeometry(THREE,m){
    let geometry;
    switch(m.type){
      case 'box': geometry=new THREE.BoxGeometry(...(m.size??[1,1,1]));break;
      case 'sphere':
        geometry=new THREE.SphereGeometry(m.radius??0.5,m.radial_segments??64,(m.rings??32)+1,Math.PI/2);
        if((m.radius??0.5)>0)geometry.scale(1,(m.height??1)/(2*(m.radius??0.5)),1);
        break;
      case 'cylinder': geometry=new THREE.CylinderGeometry(m.top_radius??0.5,m.bottom_radius??0.5,m.height??2,m.radial_segments??64,Math.max(1,(m.rings??4)+1));break;
      case 'capsule': geometry=new THREE.CapsuleGeometry(m.radius??0.5,Math.max(0,(m.height??2)-2*(m.radius??0.5)),m.rings??8,m.radial_segments??64);break;
      case 'torus': {
        const inner=m.inner_radius??0.5,outer=m.outer_radius??1;
        geometry=new THREE.TorusGeometry((inner+outer)/2,Math.abs(outer-inner)/2,m.ring_segments??32,m.rings??64);
        geometry.rotateX(-Math.PI/2);break;
      }
      case 'plane': geometry=new THREE.PlaneGeometry(...(m.size??[2,2]));geometry.rotateX(-Math.PI/2);break;
      default: throw Error('无法显示此网格类型 '+m.type);
    }
  return geometry;
}

/** Per-document resources. The only input URL in the trusted editor is an
 * ephemeral same-origin capability, or an immutable build asset inside Play. */
export async function loadProjectedResources(THREE,projection,signal){
  const resources=new Map();
  resources.projection=projection;resources.textures=new Map();
  const binary=projection?.binary;
  if(!binary)return resources;
  const url=new URL(binary.url,location.href);
  if(url.origin!==location.origin||!(/^\/creation-api\/three-surfaces\/[\w-]+$/.test(url.pathname)||
     url.pathname.split('/').at(-1)==='surface-'+binary.sha256+'.bin'))throw Error('无效的固定渲染资源地址');
  const response=await fetch(url,{signal});
  if(!response.ok)throw Error('读取固定渲染资源失败 '+response.status);
  const bytes=await response.arrayBuffer();if(bytes.byteLength!==binary.size)throw Error('渲染资源长度不符');
  resources.bytes=bytes;
  try{
    for(const [id,[offset,size]] of Object.entries(projection.images??{})){
      if(offset<0||size<1||offset+size>bytes.byteLength)throw Error('纹理数据范围无效');
      const img=await createImageBitmap(new Blob([new Uint8Array(bytes,offset,size)],{type:'image/png'}));
      const texture=new THREE.Texture(img);texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=false;
      texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.needsUpdate=true;resources.textures.set(id,texture);
      signal?.throwIfAborted();
    }
  }catch(error){for(const texture of resources.textures.values()){texture.dispose();texture.image.close();}throw error;}
  return resources;
}

function surfaceGeometry(T,resources,id){
  const cacheKey='surface:'+id;
  let geometry=resources.get(cacheKey)?.geometry;
  if(geometry)return geometry;
  if(!resources.bytes)throw Error('请先读取固定原生网格资源');
  const descriptor=resources.projection.geometry[id];geometry=new T.BufferGeometry();
  for(const [name,itemSize] of [['position',3],['normal',3],['uv',2],['color',4]]){
    const span=descriptor[name];if(span){
      if(span[1]%(4*itemSize)!==0)throw Error('无效的网格属性 '+name);
      geometry.setAttribute(name,new T.BufferAttribute(new Float32Array(resources.bytes,span[0],span[1]/4),itemSize));
    }
  }
  const index=descriptor.index?new Uint32Array(resources.bytes,descriptor.index[0],descriptor.index[1]/4):
    Uint32Array.from({length:geometry.attributes.position.count},(_,i)=>i);
  // Godot's front faces are clockwise, Three's are counterclockwise.
  const ccw=index.slice();
  for(let i=0;i+2<ccw.length;i+=3){ccw[i+1]=index[i+2];ccw[i+2]=index[i+1];}
  geometry.setIndex(new T.BufferAttribute(ccw,1));if(!geometry.attributes.normal)geometry.computeVertexNormals();
  resources.set(cacheKey,{geometry});return geometry;
}

function surfaceObject(T,row,resources){
  const group=new T.Group(),m=row.mesh;
  for(const surface of m.surfaces){
    const geometry=surfaceGeometry(T,resources,surface.geometry),props=surface.material;
    const key='material:'+JSON.stringify(props);let material=resources.get(key)?.material;
    if(!material){
      const [r,g,b,a]=props.color??[1,1,1,1];
      const options={color:new T.Color(r,g,b).convertSRGBToLinear(),map:resources.textures.get(props.texture)??null,
        transparent:Boolean(props.transparent),opacity:props.transparent?a:1,side:props.double_sided?T.DoubleSide:T.FrontSide,
        vertexColors:Boolean(props.vertex_color&&geometry.attributes.color)};
      material=createNativeSurfaceMaterial(T,props,options);
      if(props.normal_texture&&material.normalMap!==undefined)material.normalMap=resources.textures.get(props.normal_texture)??null;
      resources.set(key,{material});
    }
    const mesh=m.instances?new T.InstancedMesh(geometry,material,m.instances.length):new T.Mesh(geometry,material);
    m.instances?.forEach((matrix,i)=>{mesh.setMatrixAt(i,new T.Matrix4().fromArray(matrix));if(m.colors?.[i])mesh.setColorAt(i,new T.Color(...m.colors[i].slice(0,3)));});
    mesh.castShadow=row.cast_shadow!==false;mesh.receiveShadow=true;mesh.userData.nativeFrameBounds=m.frame_bounds;group.add(mesh);
  }
  return group;
}
const cssColor=(rgba,fallback)=>rgba?'rgba('+rgba.slice(0,3).map(v=>Math.round(v*255)).join(',')+','+(rgba[3]??1)+')':fallback;
function captionMesh(T,label){
  const size=Math.max(1,Math.min(256,label.font_size??24)),canvas=document.createElement('canvas');
  const lines=String(label.text??'').split('\n'),ctx=canvas.getContext('2d');
  ctx.font=size+'px system-ui';canvas.width=Math.max(1,Math.min(4096,Math.ceil(Math.max(...lines.map(line=>ctx.measureText(line).width))+6)));
  canvas.height=Math.min(2048,Math.ceil((size+4)*lines.length));ctx.font=size+'px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillStyle=cssColor(label.color,'white');lines.forEach((line,i)=>ctx.fillText(line,canvas.width/2,(size+4)*(i+.5)));
  const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;
  const scale=label.pixel_size??.005;
  return new T.Mesh(new T.PlaneGeometry(canvas.width*scale,canvas.height*scale),new T.MeshBasicMaterial({map:texture,transparent:true,side:T.DoubleSide,depthWrite:false}));
}
function drawStyle(ctx,style,resources,w,h){
  if(!style)return;
  if(style.kind==='texture'){
    const img=resources?.textures.get(style.texture)?.image;if(!img)return;
    const [l,t,r,b]=style.margins,expand=style.expand??[0,0,0,0];
    const axis=(length,a,b)=>[0,a,length-b,length];
    const sx=axis(img.width,l,r),sy=axis(img.height,t,b);
    const dw=w+expand[0]+expand[2],dh=h+expand[1]+expand[3];
    const kx=Math.min(1,dw/Math.max(1,l+r)),ky=Math.min(1,dh/Math.max(1,t+b));
    const dx=axis(dw,l*kx,r*kx).map(x=>x-expand[0]),dy=axis(dh,t*ky,b*ky).map(y=>y-expand[1]);
    for(let j=0;j<3;j++)for(let i=0;i<3;i++){
      if(!style.center&&i===1&&j===1)continue;
      const sw=sx[i+1]-sx[i],sh=sy[j+1]-sy[j],tw=dx[i+1]-dx[i],th=dy[j+1]-dy[j];
      if(Math.min(sw,sh,tw,th)>0)ctx.drawImage(img,sx[i],sy[j],sw,sh,dx[i],dy[j],tw,th);
    }
  }else if(style.kind==='flat'){
    const [l,t,r,b]=style.widths??[0,0,0,0],radius=style.radius??[0,0,0,0];
    ctx.fillStyle=cssColor(style.border,'transparent');ctx.beginPath();ctx.roundRect(0,0,w,h,radius);ctx.fill();
    if(style.center){ctx.fillStyle=cssColor(style.background,'transparent');ctx.beginPath();ctx.roundRect(l,t,Math.max(0,w-l-r),Math.max(0,h-t-b),radius.map((v,i)=>Math.max(0,v-[Math.max(l,t),Math.max(r,t),Math.max(r,b),Math.max(l,b)][i])));ctx.fill();}
  }
}
export function createCanvasVisual(T,field,resources){
  const group=new T.Group(),[width,height]=field.size??[0,0];if(width<=0||height<=0)return group;
  const canvas=document.createElement('canvas'),ratio=Math.min(1,2048/Math.max(width,height));
  canvas.width=Math.max(1,Math.ceil(width*ratio));canvas.height=Math.max(1,Math.ceil(height*ratio));
  const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);
  const bg=cssColor(field.color??field.background,null);
  if(bg&&!field.style){ctx.fillStyle=bg;ctx.fillRect(0,0,width,height);}
  drawStyle(ctx,field.style,resources,width,height);drawStyle(ctx,field.focus_style,resources,width,height);
  const image=resources?.textures?.get(field.texture)?.image;
  if(image){
    const mode=field.stretch_mode??0;
    let w=width,h=height,x=0,y=0;
    if(mode>=2){const factor=mode===2||mode===3?1:(mode===6?Math.max:Math.min)(width/image.width,height/image.height);
      w=image.width*factor;h=image.height*factor;if([3,5,6].includes(mode)){x=(width-w)/2;y=(height-h)/2;}}
    ctx.drawImage(image,x,y,w,h);
  }
  if(field.text){ctx.font=(resources?.canvasFont?'600 ':'')+(field.font_size??16)+'px '+(resources?.canvasFont??'system-ui');ctx.textBaseline='alphabetic';
    const [l,t,r,b]=field.style?.content??[0,0,0,0],align=field.horizontal??(field.type==='Button'?1:0);
    ctx.textAlign=align===1?'center':align===2?'right':'left';
    const x=align===1?(width+l-r)/2:align===2?width-r:l;
    const ascent=field.font_ascent??(field.font_size??16)*.8,descent=field.font_descent??(field.font_size??16)*.2;
    const lineHeight=field.text_size?.[1]??(ascent+descent);
    const y=(field.vertical===0?t:field.vertical===2?height-b-lineHeight:(height+t-b-lineHeight)/2)+ascent;
    const shadow=field.text_shadow,maxWidth=Math.max(1,width-l-r);
    if(shadow?.color?.[3]>0){
      ctx.fillStyle=cssColor(shadow.color,'transparent');ctx.fillText(field.text,x+shadow.offset[0],y+shadow.offset[1],maxWidth);
    }
    ctx.fillStyle=cssColor(field.font_color,'white');ctx.fillText(field.text,x,y,maxWidth);}
  const tex=new T.CanvasTexture(canvas);tex.colorSpace=T.SRGBColorSpace;
  const geom=new T.PlaneGeometry(width,height);geom.rotateX(Math.PI);geom.translate(width/2,height/2,0);
  const mat=new T.MeshBasicMaterial({map:tex,transparent:true,side:T.DoubleSide,depthWrite:false,depthTest:false});
  const mesh=new T.Mesh(geom,mat);group.add(mesh);return group;
}
