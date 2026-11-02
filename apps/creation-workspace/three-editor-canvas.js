import * as T from 'three';
import {bounds,disposeTree} from './three-editor-scene.js';
import {createCanvasVisual,layoutProjectedCanvas,logicalCanvasViewport} from './three-source-scene.js';
import {EditorOverlays} from './three-editor-overlays.js';

// The authored canvas keeps Godot's pixel axes (right, down) and is composited
// after the 3D viewport. Both passes use the same selection/Agent label code.
export class EditorCanvas {
  constructor(renderer,element){
    this.renderer=renderer;this.element=element;this.scene=new T.Scene();
    this.camera=new T.OrthographicCamera(-1,1,1,-1,.01,5000);this.camera.up.set(0,-1,0);
    this.labels=document.createElement('div');this.labels.className='canvas-labels';
    document.querySelector('#surface').append(this.labels);
    this.handles=Array.from({length:8},()=>{const el=document.createElement('i');el.className='control-handle';el.hidden=true;
      document.querySelector('#surface').append(el);return el;});
    this.outline=new EditorOverlays(this.scene,renderer,this.labels);
    this.center=new T.Vector2();this.zoom=1;
  }
  load(data,projection,reset){
    if(this.root){this.root.removeFromParent();disposeTree(this.root);}
    this.root=data.canvasRoot;this.scene.add(this.root);this.outline.setContent(this.root,projection);
    this.projection=projection;this.nodes=data.nodes;this.resources=data.resources;
    this.overrides=new Map();this.previewKey="";
    this.items=new Map([...data.items].filter(([,item])=>item.canvas).sort((a,b)=>a[1].node.renderOrder-b[1].node.renderOrder));
    this.only=projection.dimension==='2d';
    const retainView=!reset&&this.only&&this.resolution;
    this.resolution=null;this.resize(!retainView);
  }
  resize(refit=false){
    if(!this.root)return;
    const size=logicalCanvasViewport(this.projection,this.element.width,this.element.height);
    if(size.every((value,i)=>value===this.resolution?.[i]))return;
    this.resolution=size;this.layout();
    if(refit||!this.only)this.fit(null,this.only);else this.update();
  }
  preview(rows){
    const overrides=new Map();
    for(const row of rows){
      const item=this.items?.get(row.id);
      if(item?.object.control_layout&&row.control_layout)overrides.set(item.object.native_path,row.control_layout);
    }
    this.setOverrides(overrides);
  }
  setOverrides(overrides){
    const key=JSON.stringify([...overrides]);
    if(key===this.previewKey)return;
    this.previewKey=key;this.overrides=overrides;this.layout();
  }
  layout(){
    const size=this.resolution,rects=layoutProjectedCanvas(T,this.projection,size,this.overrides);
    for(const row of this.projection.nodes){
      if(!row.canvas)continue;
      const rect=rects.get(row.path),node=this.nodes.get(row.path),item=this.items.get(node.userData.objectId);
      const field={...row.canvas,size:rect.size};
      if(node.userData.inScope&&(!node.userData.renderSize||rect.size.some((n,i)=>n!==node.userData.renderSize[i]))){
        node.userData.renderSize=[...rect.size];
        for(const child of [...node.children])if(child.isMesh){node.remove(child);disposeTree(child);}
        const visual=createCanvasVisual(T,field,this.resources);
        for(const child of [...visual.children]){child.renderOrder=node.renderOrder;node.add(child);}
      }
      node.matrix.copy(rect.local);node.matrixAutoUpdate=false;node.matrixWorldNeedsUpdate=true;
      if(item){
        item.field=field;
        const layout=item.object.control_layout;
        if(layout){item.object={...item.object,world_matrix:rect.world.toArray(),native_edit_world_matrix:rect.world.toArray(),
          control_layout:{...layout,needs_measurement:false,viewport_size:[...size],parent_size:[...rect.parentSize],minimum_size:[...rect.minimumSize],values:rect.values},
          native_edit_transform:item.object.native_edit_transform&&{position:[...rect.pos,0],rotation:[0,0,rect.values.rotation_degrees],scale:[...rect.values.scale,1]}};}
      }
    }
    this.root.updateMatrixWorld(true);
  }
  observation(id){
    const item=this.items?.get(id),obj=item?.object,layout=obj?.control_layout;
    if(!layout)return null;
    const {position,rotation_degrees,scale}=layout.values;
    return {id,address:obj.address,native_target:obj.native_mount_target??obj.native_target,object_version:obj.version,
      ancestry_hash:obj.ancestry_hash,dimension:'2d',world_matrix:item.node.matrixWorld.toArray(),position:item.node.matrixWorld.elements.slice(12,15),
      local_transform:{position:[...position,0],rotation:[0,0,rotation_degrees],scale:[...scale,1]},control_layout:layout};
  }
  fit(item,fitContent=true){
    const [w,h]=this.resolution;
    this.center.set(w/2,h/2);this.zoom=1;
    if(fitContent&&this.items?.size){
      const box=bounds(item?.node??this.root),size=box.getSize(new T.Vector3()),center=box.getCenter(new T.Vector3());
      this.center.set(center.x,center.y);
      this.zoom=T.MathUtils.clamp(.8*Math.min(w/Math.max(size.x,1),h/Math.max(size.y,1)),.001,1000);
    }
    this.update();
  }
  update(){
    if(!this.resolution)return;
    const [w,h]=this.resolution,halfX=w/2/this.zoom,halfY=h/2/this.zoom;
    Object.assign(this.camera,{left:-halfX,right:halfX,top:halfY,bottom:-halfY});
    this.camera.position.set(this.center.x,this.center.y,-1000);this.camera.lookAt(this.center.x,this.center.y,0);
    this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld();this.root.updateMatrixWorld(true);
  }
  point(at){
    const p=new T.Vector3(at[0]*2-1,1-at[1]*2,0).unproject(this.camera);p.z=0;return p;
  }
  pick(at){
    if(!this.items?.size)return null;
    const point=this.point(at),items=[...this.items.values()].reverse();
    for(const item of items){
      const node=item.node,field=item.field;
      if(!node.visible||!field||(!this.only&&!field.text&&!field.color&&!field.background&&!field.texture))continue;
      const p=node.worldToLocal(point.clone());
      if(p.x>=0&&p.y>=0&&p.x<=field.size[0]&&p.y<=field.size[1])return {id:item.object.id,point,canvas:true};
    }
    return null;
  }
  handlePoints(item){
    if(!item?.object.control_layout||item.object.control_layout.container_managed||!item.node.visible)return [];
    const [w,h]=item.field.size;
    return [[0,0],[.5,0],[1,0],[1,.5],[1,1],[.5,1],[0,1],[0,.5]].map(([x,y])=>{
      const v=item.node.localToWorld(new T.Vector3(x*w,y*h,0)).project(this.camera);
      return [(v.x+1)*this.element.clientWidth/2,(1-v.y)*this.element.clientHeight/2];
    });
  }
  render(selection,mode,editable){
    const points=editable&&selection.length===1?this.handlePoints(this.items?.get(selection[0])):[];
    this.handles.forEach((el,i)=>{el.hidden=!points[i];if(points[i]){el.style.left=points[i][0]+'px';el.style.top=points[i][1]+'px';el.style.borderColor=this.outline.local?.color??'#69e7ed';}});
    if(!this.items?.size)return;
    const r=this.renderer;r.autoClear=false;r.clearDepth();r.render(this.scene,this.camera);r.autoClear=true;
    this.outline.draw(this.camera,this.items,selection.filter(id=>this.items.has(id)),mode);
  }
  dispose(){this.outline.dispose();if(this.root)disposeTree(this.root);this.labels.remove();this.handles.forEach(el=>el.remove());}
}
