// The compatibility renderer maps each lit material to display space before
// alpha composition. Keep its white-point normalization in the material pass.
export const toneFunctions=`
float waFilmic(float x) {
  return (x*(0.88*x+0.060)+0.002)/(x*(0.88*x+0.60)+0.060)-0.01/0.30;
}
vec3 waRRT(vec3 x) {return (x*(x+0.0245786)-0.000090537)/(x*(0.983729*x+0.432951)+0.238081);}
vec3 waNativeTone(vec3 c,vec3 p) {
  c=max(vec3(0.),c*p.y);
  float w=max(0.001,p.z);
  if(p.x==1.)return c*(vec3(1.)+c/(w*w))/(vec3(1.)+c);
  if(p.x==2.)return vec3(waFilmic(c.r),waFilmic(c.g),waFilmic(c.b))/waFilmic(w);
  if(p.x==3.){
    const mat3 rrt=mat3(vec3(.59719,.35458,.04823),vec3(.07600,.90834,.01566),vec3(.02840,.13383,.83777));
    const mat3 odt=mat3(vec3(1.60475,-.53108,-.07367),vec3(-.10208,1.10813,-.00605),vec3(-.00327,-.07276,1.07602));
    return (waRRT((c*1.8)*rrt)*odt)/waRRT(vec3(w*1.8)).r;
  }
  return c;
}`;

const targets=new WeakMap();
let hasDepthReaders=false;
export function registerDepthMaterial(){hasDepthReaders=true;}
export function prepareProjectedDepth(T,renderer,scene,camera){
  if(!hasDepthReaders)return;
  const readers=[],transparent=new Set();
  scene.traverseVisible(node=>{
    if(!node.material)return;
    for(const m of [].concat(node.material)){
      if(!m.visible)continue;
      if(m.userData.nativeDepthUniforms)readers.push(m);
      if(m.transparent||!m.depthWrite)transparent.add(m);
    }
  });
  if(!readers.length)return;
  const size=renderer.getDrawingBufferSize(new T.Vector2()),previous=renderer.getRenderTarget();
  if(previous)size.set(previous.width,previous.height);
  let target=targets.get(renderer);
  if(!target){
    target=new T.WebGLRenderTarget(size.x,size.y,{depthTexture:new T.DepthTexture(size.x,size.y,T.UnsignedIntType)});
    targets.set(renderer,target);
  }else if(target.width!==size.x||target.height!==size.y)target.setSize(size.x,size.y);
  const auto=renderer.autoClear,shadow=renderer.shadowMap.autoUpdate,background=scene.background;
  const face=renderer.getActiveCubeFace(),level=renderer.getActiveMipmapLevel();
  try{
    for(const m of transparent)m.visible=false;
    scene.background=null;renderer.shadowMap.autoUpdate=false;renderer.setRenderTarget(target);renderer.autoClear=true;
    renderer.render(scene,camera);
  }finally{
    renderer.setRenderTarget(previous,face,level);renderer.autoClear=auto;renderer.shadowMap.autoUpdate=shadow;scene.background=background;
    for(const m of transparent)m.visible=true;
  }
  for(const material of readers){
    const u=material.userData.nativeDepthUniforms;
    u.waOpaqueDepth.value=target.depthTexture;u.waDepthSize.value.copy(size);u.waInvProjection.value.copy(camera.projectionMatrixInverse);
  }
}
export function disposeProjectedDepth(renderer){
  const target=targets.get(renderer);if(target){target.dispose();targets.delete(renderer);}
}
export function renderProjectedScene(T,renderer,scene,camera){
  prepareProjectedDepth(T,renderer,scene,camera);renderer.render(scene,camera);
}
