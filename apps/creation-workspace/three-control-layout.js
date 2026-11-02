// Use integer device pixels for the native Window margins. Both the editor
// and Play put the scene, overlays and pointer surface inside this rectangle.
export function fitViewportSurface(surface,settings,pixelRatio){
  const width=Math.round(innerWidth*pixelRatio),height=Math.round(innerHeight*pixelRatio);
  const [baseWidth,baseHeight]=settings?.viewport??[];
  const ratio=settings?.aspect_ratio||baseWidth/baseHeight;
  const aspect=settings?.stretch_aspect;
  const keep=settings?.stretch_mode!=='disabled'&&ratio>0&&(
    settings.aspect_ratio||aspect==='keep'||aspect==='keep_width'&&width>height*ratio||aspect==='keep_height'&&width<height*ratio);
  const w=keep?Math.min(width,Math.floor(height*ratio)):width;
  const h=keep?Math.min(height,Math.floor(width/ratio)):height;
  Object.assign(surface.style,{position:'absolute',left:Math.floor((width-w)/2)/pixelRatio+'px',top:Math.floor((height-h)/2)/pixelRatio+'px',width:w/pixelRatio+'px',height:h/pixelRatio+'px'});
}

// Canvas coordinates are Godot logical pixels. Disabled stretch tracks the
// window, while a stretched project can retain or expand its design area.
export function logicalCanvasViewport(projection,width,height){
  const [w,h]=projection.viewport??[width,height];
  const mode=projection.stretch_mode??'canvas_items',aspect=projection.stretch_aspect??'keep';
  if(mode==='disabled')return [Math.max(1,width),Math.max(1,height)];
  const ratio=width/Math.max(1,height);
  if(ratio>w/h&&(aspect==='expand'||aspect==='keep_height'))return [Math.floor(h*ratio),h];
  if(ratio<w/h&&(aspect==='expand'||aspect==='keep_width'))return [w,Math.floor(w/ratio)];
  return [w,h];
}
function anchored(layout,min,parent){
  const edges=layout.anchors.map((a,i)=>parent[i%2]*a+layout.offsets[i]);
  const pos=edges.slice(0,2),size=[edges[2]-pos[0],edges[3]-pos[1]];
  for(let axis=0;axis<2;axis++){
    if(size[axis]>=min[axis])continue;
    const grow=axis?layout.grow_vertical:layout.grow_horizontal;
    if(grow===0||grow===2)pos[axis]+=(size[axis]-min[axis])*(grow===0?1:.5);
    size[axis]=min[axis];
  }
  return {pos,size};
}
function boxChildren(row,children,size){
  const axis=row.type==='VBoxContainer'?1:0,cross=1-axis;
  const gap=row.canvas.separation??4,rects=new Map();
  const visible=children.filter(c=>c.visible);
  const items=visible.map(node=>{
    const l=node.canvas.layout,flags=[l.size_flags_horizontal,l.size_flags_vertical],min=node.canvas.minimum_size??l.size;
    return {node,min,flags,length:Math.ceil(min[axis]),stretch:Boolean(flags[axis]&2),ratio:l.size_flags_stretch_ratio??1};
  });
  const available=Math.max(0,Math.floor(size[axis])-Math.max(0,items.length-1)*gap);
  const delta=Math.max(0,available-items.reduce((n,c)=>n+c.length,0));
  let flexible=items.filter(c=>c.stretch&&c.ratio>0);
  let space=available-items.filter(c=>!flexible.includes(c)).reduce((n,c)=>n+c.length,0);
  while(flexible.length){
    const total=flexible.reduce((n,c)=>n+c.ratio,0),small=flexible.find(c=>space*c.ratio/total<c.length);
    if(small){space-=small.length;flexible=flexible.filter(c=>c!==small);continue;}
    let used=0,sum=0;
    for(const c of flexible){sum+=c.ratio;const end=Math.floor(space*sum/total);c.length=end-used;used=end;}
    break;
  }
  let offset=items.some(c=>c.stretch)?0:row.canvas.alignment===2?delta:row.canvas.alignment===1?Math.floor(delta/2):0;
  for(const c of items){
    const slot=[0,0],pos=[0,0];slot[axis]=c.length;slot[cross]=Math.floor(size[cross]);pos[axis]=offset;
    const childSize=slot.slice();
    for(let j=0;j<2;j++)if(!(c.flags[j]&1)){
      childSize[j]=c.min[j];const extra=slot[j]-childSize[j];
      pos[j]+=(c.flags[j]&8)?extra:(c.flags[j]&4)?Math.floor(extra/2):0;
    }
    rects.set(c.node.path,{pos,size:childSize});offset+=c.length+gap;
  }
  return rects;
}
function controlMatrix(T,layout,position){
  const [sx,sy]=layout.scale??[1,1],angle=(layout.rotation_degrees??0)*Math.PI/180;
  const matrix=new T.Matrix4().makeRotationZ(angle).scale(new T.Vector3(sx,sy,1)),e=matrix.elements;
  const [x,y]=layout.pivot_offset??[0,0];
  return matrix.setPosition(position[0]+x-e[0]*x-e[4]*y,position[1]+y-e[1]*x-e[5]*y,0);
}
export function layoutProjectedCanvas(T,projection,viewport,overrides=new Map()){
  const children=new Map(),rows=projection.nodes.filter(n=>n.canvas).map(row=>{
    const patch=overrides.get(row.path);
    if(!patch)return row;
    const field=row.canvas,layout={...field.layout,...patch};
    const baseMin=field.intrinsic_minimum_size??field.minimum_size??[0,0];
    const minimum=baseMin.map((value,i)=>Math.max(value,layout.custom_minimum_size?.[i]??0));
    return {...row,originalLayout:field.layout,canvas:{...field,layout,minimum_size:minimum}};
  });
  const byPath=new Map(rows.map(r=>[r.path,r]));
  const parentOf=path=>path==='.'?null:path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.';
  for(const r of rows){const p=parentOf(r.path);if(!children.has(p))children.set(p,[]);children.get(p).push(r);}
  const result=new Map(),slots=new Map();
  for(const row of rows){
    const parent=byPath.get(parentOf(row.path)),previous=parent&&result.get(parent.path);
    const l=row.canvas.layout,original=row.originalLayout??l,patch=overrides.get(row.path);
    const parentSize=previous?.size??viewport,min=row.canvas.minimum_size??[0,0];
    const rect=slots.get(row.path)??anchored(l,min,parentSize);
    const values={...l};
    if(!slots.has(row.path)&&patch&&(patch.position||patch.size)){
      // Rect aliases are assigned after anchors/offsets, as in Control.
      if(patch.position)rect.pos=patch.position;
      if(patch.size)rect.size=patch.size.map((n,i)=>Math.max(n,min[i]));
      values.offsets=l.anchors.map((a,i)=>rect.pos[i%2]+(i>1?rect.size[i%2]:0)-a*parentSize[i%2]);
    }
    values.position=rect.pos;values.size=rect.size;
    const native=row.world_matrix?new T.Matrix4().fromArray(row.world_matrix):new T.Matrix4();
    const local=parent?.world_matrix?new T.Matrix4().fromArray(parent.world_matrix).invert().multiply(native):native;
    if(patch&&(patch.pivot_offset||patch.rotation_degrees!==undefined||patch.scale)){
      local.multiply(controlMatrix(T,original,original.position).invert()).multiply(controlMatrix(T,l,rect.pos));
    }else{
      local.elements[12]+=rect.pos[0]-original.position[0];local.elements[13]+=rect.pos[1]-original.position[1];
    }
    const world=previous?previous.world.clone().multiply(local):local.clone();
    result.set(row.path,{...rect,local,world,values,parentSize,minimumSize:min});
    if(row.type==='HBoxContainer'||row.type==='VBoxContainer'){
      for(const [path,slot] of boxChildren(row,children.get(row.path)??[],rect.size))slots.set(path,slot);
    }
  }
  return result;
}

// Map one native Control to its drawn surface and HTML hit region. Geometry
// starts at the Control's top left and uses Godot canvas axes (right, down).
// A scripted _draw may fit a design canvas to the viewport independently of
// the Control's size. Its authored transform still applies to both layers.
export function bindProjectedControls(T,projection,bindings){
  const rows=new Map(projection.nodes.filter(row=>row.canvas).map(row=>[row.path,row]));
  for(const {path,object,element} of bindings){
    if(!rows.has(path))throw Error('固定场景缺少界面布局 '+path);
    if(object)object.userData.nativePath=path;
    if(element)element.dataset.waNativePath=path;
  }
  return function resize(width,height){
    const viewport=logicalCanvasViewport(projection,width,height);
    const rects=layoutProjectedCanvas(T,projection,viewport);
    const cssX=width/viewport[0],cssY=height/viewport[1];
    for(const {path,object,element,designSize,fitViewport} of bindings){
      const row=rows.get(path),rect=rects.get(path);
      const [w,h]=designSize??row.canvas.size;
      const size=fitViewport?viewport:rect.size;
      const fit=fitViewport?Math.min(size[0]/w,size[1]/h):null;
      const local=new T.Matrix4().makeScale(fit??(w?size[0]/w:1),fit??(h?size[1]/h:1),1);
      if(fitViewport)local.setPosition((size[0]-w*fit)/2,(size[1]-h*fit)/2,0);
      const world=rect.world.clone().multiply(local);
      if(object){
        object.matrix.copy(world);
        if(object.parent){
          object.parent.updateWorldMatrix(true,false);
          object.matrix.premultiply(object.parent.matrixWorld.clone().invert());
        }
        object.matrix.decompose(object.position,object.quaternion,object.scale);
        object.matrixAutoUpdate=false;object.matrixWorldNeedsUpdate=true;object.updateWorldMatrix(false,true);object.visible=row.visible!==false;
      }
      if(element){
        const e=world.elements;
        const css=[e[0]*cssX,e[1]*cssY,e[4]*cssX,e[5]*cssY,e[12]*cssX,e[13]*cssY];
        Object.assign(element.style,{position:'absolute',left:'0',top:'0',width:w+'px',height:h+'px',
          transformOrigin:'0 0',transform:'matrix('+css.join(',')+')'});
        element.hidden=row.visible===false;
      }
    }
    return viewport;
  };
}
