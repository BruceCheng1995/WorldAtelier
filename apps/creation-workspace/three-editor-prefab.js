import * as T from 'three';
import {assemble,disposeTree,setWorld} from './three-editor-scene.js';
import {layoutProjectedCanvas} from './three-control-layout.js';

// Lives outside both authored roots. Ghosts cannot be picked, outlined, saved
// or included as surfaces when finding the next drop position.
export class EditorPrefabGhost {
  constructor({scene,sheet,context,placement,reply,redraw}){
    Object.assign(this,{scene,sheet,context,placement,reply,redraw});
    this.retired=new Set();
  }
  retire(id){
    this.retired.add(id);
    if(this.retired.size>64)this.retired.delete(this.retired.values().next().value);
  }
  clear(){
    const g=this.active;if(!g)return;
    this.active=null;clearTimeout(g.timer);g.abort.abort();this.retire(g.id);
    if(g.data){
      for(const [mesh,original] of g.originals??[])mesh.material=original;
      g.tint?.dispose();
      g.data.root.removeFromParent();g.data.canvasRoot.removeFromParent();
      disposeTree(g.data.root);disposeTree(g.data.canvasRoot);
    }
    this.redraw();
  }
  receive(packet){
    const id=packet.drag_id,ctx=this.context();
    if(typeof id!=='string'||id.length>256||!id)return;
    if(packet.phase==='clear'){if(this.active?.id===id)this.clear();else this.retire(id);return;}
    if(packet.phase==='hide'){
      if(this.active?.id===id){this.active.point=null;this.position(this.active);}
      return;
    }
    if(packet.phase!=='move'||this.retired.has(id)||!ctx.current.editable||packet.source_identity!==ctx.current.source_identity)return;
    if(this.active?.id!==id){
      this.clear();
      this.active={id,path:packet.prefab_path,abort:new AbortController(),data:null,status:'pending'};
    }
    const g=this.active;
    if(g.path!==packet.prefab_path)return;
    clearTimeout(g.timer);g.timer=setTimeout(()=>{if(g===this.active)this.clear();},10000);
    g.point=Array.isArray(packet.screen)&&packet.screen.length===2&&packet.screen.every(n=>Number.isFinite(n)&&n>=0&&n<=1)?this.placement(packet.screen):null;
    if(packet.ghost_error)g.status='fallback';
    if(packet.ghost&&!g.loading){
      g.loading=true;
      void this.build(g,packet.ghost,ctx);
    }
    this.position(g);
  }
  async build(g,packet,ctx){
    if(packet.kind!=='prefab'||packet.source_identity!==ctx.current.source_identity||packet.native_scene_path!==g.path)return;
    const root=packet.objects.find(o=>o.native_path==='.');
    const row=packet.three_projection?.nodes.find(r=>r.path==='.');
    g.dimension=root?.dimension??(row?.canvas?'2d':row?.world_matrix&&row.type.endsWith('3D')?'3d':null);
    if(!g.dimension||!row){g.status='fallback';this.position(g);return;}
    if((g.dimension==='2d')!==this.sheet.only){g.status='invalid';this.position(g);return;}
    const parent=ctx.data.nodes.get('.');
    const parentObject=ctx.data.items.get(parent?.userData.objectId)?.object;
    if(g.dimension==='2d'&&parentObject?.type?.endsWith('Container')){g.status='invalid';this.position(g);return;}
    try{
      const data=await assemble(packet,g.abort.signal);
      if(this.active!==g){disposeTree(data.root);disposeTree(data.canvasRoot);return;}
      g.data=data;g.group=g.dimension==='2d'?data.canvasRoot:data.root;
      if(g.dimension==='2d'){
        const viewport=parentObject?.control_layout?.values.size??this.sheet.resolution;
        const rects=layoutProjectedCanvas(T,packet.three_projection,viewport);
        for(const [path,rect] of rects){const node=data.nodes.get(path);node.matrix.copy(rect.local);node.matrixWorldNeedsUpdate=true;}
      }
      const base=data.nodes.get('.');g.origin=new T.Vector3().setFromMatrixPosition(base.matrix);
      g.parent=parent&&!row.top_level&&parentObject?.dimension===g.dimension?parent.matrixWorld.clone():new T.Matrix4();
      g.parent.setPosition(0,0,0);g.origin.applyMatrix4(g.parent);
      if(Math.abs(g.parent.determinant())<1e-8){g.status='invalid';this.position(g);return;}
      const children=[];g.group.traverse(n=>children.push(n));
      if(g.dimension==='3d'){
        g.tint=new T.MeshBasicMaterial({color:0xb8a5ff,transparent:true,opacity:.48,depthWrite:false,side:T.DoubleSide});
        g.originals=new Map();
      }
      let visibleMeshes=0;
      for(const node of children){
        if(node.isLight||node.isCamera)node.removeFromParent();
        if(!node.isMesh)continue;
        visibleMeshes++;
        node.castShadow=node.receiveShadow=false;
        if(g.tint){g.originals.set(node,node.material);node.material=g.tint;}
        else for(const mat of [].concat(node.material??[])){
          mat.transparent=true;mat.opacity=Math.min(.48,mat.opacity);mat.depthWrite=false;
          mat.color?.multiply(new T.Color(.78,.65,1));
        }
      }
      (g.dimension==='2d'?this.sheet.scene:this.scene).add(g.group);
      g.status=visibleMeshes?'ready':'fallback';this.position(g);
    }catch(error){if(this.active===g&&!g.abort.signal.aborted){g.status='fallback';this.position(g);}}
  }
  position(g){
    if(this.active!==g)return;
    if(g.group){
      g.group.visible=!!g.point&&g.status==='ready';
      if(g.group.visible)setWorld(g.group,g.parent.clone().setPosition(g.point.clone().sub(g.origin)));
    }
    this.reply({drag_id:g.id,status:g.point?g.status:'invalid',shape:g.status==='ready'?g.dimension:'none',...(g.point?{position:g.point.toArray()}: {})});
    this.redraw();
  }
}
