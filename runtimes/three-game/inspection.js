import * as THREE from 'three';

// Observe the Three scene actually running. Stable author addresses are valid
// only for a unique, explicitly bound object in this fixed document.
export class SceneObservation {
  constructor(scene,source,generation,prefabPaths){
    this.scene=scene;this.generation=generation;this.prefabPaths=prefabPaths;
    this.definitions=new Map(source.objects.map(row=>[row.native_path,row]));
    this.refresh();
  }
  refresh(){
    this.nodes=[];this.byPath=new Map();this.truncated=false;
    const pending=[this.scene],visited=new Set(pending);
    for(let i=0;i<pending.length;i++){
      const node=pending[i];this.nodes.push(node);
      const path=Object.getOwnPropertyDescriptor(node.userData??{},'nativePath')?.value;
      if(typeof path==='string'&&!prefabOrigin(node))this.byPath.set(path,this.byPath.has(path)?null:node);
      for(const child of node.children){
        if(!visited.has(child)){visited.add(child);pending.push(child);}
      }
    }
    // The report has a bounded size, but uniqueness must be checked against
    // every live binding (including geometry outside the reported prefix).
    this.truncated=this.nodes.length>256;
    this.rows=new Map();this.ids=new Map();
    for(const [path,node] of this.byPath){
      const row=this.definitions.get(path);
      if(node&&row){this.rows.set(node,row);this.ids.set(row.id,node);}
    }
  }
  // Descendants may be generated render pieces below an addressable root.
  // Resolve a hit to the nearest bound owner, never by matching display names.
  owner(node){
    if(prefabOrigin(node))return null;
    for(let current=node;current;current=current.parent){
      if(this.rows.has(current))return current;
      let path=Object.getOwnPropertyDescriptor(current.userData??{},'nativePath')?.value;
      if(typeof path!=='string'||this.byPath.get(path)!==current)continue;
      while(path!=='.'){
        path=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.';
        const bound=this.byPath.get(path);if(bound&&this.rows.has(bound))return bound;
      }
    }
    return null;
  }
  meshes(){
    return this.nodes.filter(node=>node.isMesh&&visible(node));
  }
  pick(camera,x,y){
    const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(x*2-1,1-y*2),camera);
    ray.layers.mask=camera.layers.mask;
    const first=ray.intersectObjects(this.meshes(),false)[0];
    return first?this.rows.get(this.owner(first.object))??null:null;
  }
  bounds(object=null){
    const box=new THREE.Box3();
    for(const mesh of this.meshes()){
      if(object&&this.owner(mesh)!==object)continue;
      const own=meshBounds(mesh);if(own)box.union(own);
    }
    if(box.isEmpty()&&object)box.setFromCenterAndSize(object.getWorldPosition(new THREE.Vector3()),new THREE.Vector3(1,1,1));
    return box;
  }
  fixedRows(sourceRevision,selection){
    const priority=([,row])=>row.id===selection?2:row.type==='CharacterBody3D'?1:0;
    return [...this.rows].sort((a,b)=>priority(b)-priority(a)).slice(0,256).map(([node,row])=>{
      const position=node.getWorldPosition(new THREE.Vector3()).toArray();
      return {id:row.id,version:row.version,address:row.address,source_revision:sourceRevision,native_type:node.type,native_node_path:row.native_path,dimension:'3d',position,
        world_matrix:node.matrixWorld.toArray(),local_transform:{position:node.position.toArray(),rotation:node.quaternion.toArray(),scale:node.scale.toArray()}};
    });
  }
  snapshot(camera){
    this.refresh();
    const objects=[],point=new THREE.Vector3();
    this.scene.updateMatrixWorld(true);
    camera.updateWorldMatrix(true,false);
    const rects=new Map(),ownerRects=new Map();
    for(const mesh of this.meshes()){
      if(!camera.layers.test(mesh.layers))continue;
      const box=meshBounds(mesh),rect=box&&screenBounds(box,camera);
      if(!rect)continue;
      rects.set(mesh,rect);
      const owner=this.owner(mesh);
      if(owner)ownerRects.set(owner,unionRect(ownerRects.get(owner),rect));
    }
    for(const [node,rect] of ownerRects)rects.set(node,rect);
    // A group-heavy graph can reach the report limit before its first mesh.
    // Reserve picks across the viewport, then source owners and render pieces.
    const cells=new Map();
    for(const [node,rect] of [...ownerRects,...rects]){
      const x=Math.min(7,Math.floor((rect[0]+rect[2]/2)*8)),y=Math.min(5,Math.floor((rect[1]+rect[3]/2)*6));
      const cell=y*8+x;if(!cells.has(cell))cells.set(cell,node);
    }
    const ordered=new Set([...cells.values(),...ownerRects.keys(),...rects.keys(),...this.nodes]);
    for(const node of ordered){
      if(objects.length===256)break;
      const row=this.rows.get(node);
      const record={runtime_id:this.runtimeId(node),parent_runtime_id:node===this.scene?null:this.runtimeId(node.parent),
        name:String(node.name).slice(0,160),native_type:node.type,mapping:row?'exact_source':'runtime_only',visible:visible(node),position:node.getWorldPosition(point).toArray(),
        world_matrix:node.matrixWorld.toArray(),source:row?{address:row.address,object_version:row.version}:{}};
      const prefab=prefabOrigin(node);
      if(!row&&this.prefabPaths.has(prefab)){record.mapping='spawned_from_prefab';record.source={prefab_path:prefab};}
      if(rects.has(node))record.screen_bounds=rects.get(node);
      objects.push(record);
    }
    return {objects,scanned_nodes:this.nodes.length,truncated:this.truncated||this.nodes.length>objects.length};
  }
  runtimeId(node){return 'three-'+this.generation+'-'+node.id;}
}
function prefabOrigin(node){
  for(;node;node=node.parent){
    const path=Object.getOwnPropertyDescriptor(node.userData??{},'prefabPath')?.value;
    if(typeof path==='string')return path;
  }
  return null;
}
function visible(node){for(;node;node=node.parent)if(!node.visible)return false;return true;}
function meshBounds(mesh){
  if(!mesh.geometry)return null;
  const owner=mesh.isInstancedMesh||mesh.isSkinnedMesh?mesh:mesh.geometry;
  if(!owner.boundingBox)owner.computeBoundingBox();
  return owner.boundingBox?.clone().applyMatrix4(mesh.matrixWorld);
}
function unionRect(a,b){
  if(!a)return b;
  const x=Math.min(a[0],b[0]),y=Math.min(a[1],b[1]);
  return [x,y,Math.max(a[0]+a[2],b[0]+b[2])-x,Math.max(a[1]+a[3],b[1]+b[3])-y];
}
function screenBounds(box,camera){
  let minX=1,minY=1,maxX=0,maxY=0;
  for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
    const p=new THREE.Vector3(x,y,z).project(camera);if(p.z< -1||p.z>1)continue;
    const u=(p.x+1)*.5,v=(1-p.y)*.5;minX=Math.min(minX,u);maxX=Math.max(maxX,u);minY=Math.min(minY,v);maxY=Math.max(maxY,v);
  }
  minX=Math.max(0,minX);minY=Math.max(0,minY);maxX=Math.min(1,maxX);maxY=Math.min(1,maxY);
  if(maxX>minX&&maxY>minY)return [minX,minY,maxX-minX,maxY-minY];
  return null;
}
