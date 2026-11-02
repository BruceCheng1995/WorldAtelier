import * as T from 'three';
import {createProjectedNode,loadProjectedResources} from './three-source-scene.js';

export function disposeTree(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    for (const mat of [].concat(node.material ?? [])) {
      materials.add(mat);
      for (const texture of Object.values(mat)) if (texture?.isTexture) textures.add(texture);
    }
  });
  for (const texture of textures) { texture.dispose(); texture.source?.data?.close?.(); }
  for (const geom of geometries) geom.dispose();
  for (const mat of materials) mat.dispose();
}

function parentPath(path) {
  return path === '.' ? null : path.includes('/') ? path.slice(0,path.lastIndexOf('/')) : '.';
}

export function setWorld(node, matrix) {
  node.parent.updateWorldMatrix(true,false);
  node.matrix.copy(node.parent.matrixWorld).invert().multiply(matrix);
  node.matrixAutoUpdate = false;
  node.updateWorldMatrix(false,true,true);
}

export async function assemble(packet,signal) {
  const root = new T.Group(),canvasRoot=new T.Group(), nodes = new Map(), items = new Map(), byPath = new Map();
  const resources = await loadProjectedResources(T,packet.three_projection,signal);
  if(packet.three_projection.nodes.some(row=>row.canvas?.text)){
    await document.fonts.load('600 16px AtelierCreator');resources.canvasFont='AtelierCreator';
  }
  const rows = new Map(packet.three_projection.nodes.map(row => [row.path,row]));
  for (const object of packet.objects) {
    byPath.set(object.native_path,object);
    if (!rows.has(object.native_path)) rows.set(object.native_path,{path:object.native_path,world_matrix:object.world_matrix});
  }
  const sourceOrder=new Map([...rows.keys()].map((path,index)=>[path,index+1]));
  const depth=path=>path==='.'?0:path.split('/').length;
  const ordered=[...rows.values()].sort((a,b)=>depth(a.path)-depth(b.path));
  const visiblePath = packet.preview_object_id && packet.objects.find(o=>o.id === packet.preview_object_id)?.native_path;
  signal.throwIfAborted();
  try {
    for (const row of ordered) {
      const inScope = !visiblePath || visiblePath === '.' || row.path === visiblePath || row.path.startsWith(visiblePath+'/');
      const group = inScope ? createProjectedNode(T,row,resources) : new T.Group(), object = byPath.get(row.path);
      group.name = row.path;group.userData.inScope=inScope;
      group.userData.objectId = object?.id;
      let ancestor = parentPath(row.path);
      while (ancestor !== null && (!nodes.has(ancestor)||Boolean(rows.get(ancestor)?.canvas)!==Boolean(row.canvas)))ancestor=parentPath(ancestor);
      (nodes.get(ancestor) ?? (row.canvas?canvasRoot:root)).add(group);
      if(row.canvas)group.traverse(node=>{node.renderOrder=sourceOrder.get(row.path);});
      if (row.world_matrix) setWorld(group,new T.Matrix4().fromArray(row.world_matrix));
      group.userData.original = group.matrix.clone();
      group.visible = row.visible !== false;
      nodes.set(row.path,group);
      if (object) items.set(object.id,{object,node:group,canvas:Boolean(row.canvas),field:row.canvas});
    }
    if (visiblePath && packet.preview_observation?.world_matrix) {
      setWorld(nodes.get(visiblePath),new T.Matrix4().fromArray(packet.preview_observation.world_matrix));
    }
    root.updateMatrixWorld(true);
    return {root,canvasRoot,items,nodes,resources};
  } catch (error) {disposeTree(root);disposeTree(canvasRoot);throw error;}
}

export function bounds(node,useNativeFrame=false) {
  const box = new T.Box3(), part = new T.Box3();
  node.updateWorldMatrix(true,true);
  node.traverseVisible(child => {
    if (!child.isMesh) return;
    const native=useNativeFrame&&child.userData.nativeFrameBounds;
    if(native){
      part.min.fromArray(native,0);part.max.fromArray(native,3);box.union(part.applyMatrix4(child.matrixWorld));return;
    }
    if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
    box.union(part.copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld));
  });
  if (box.isEmpty()) box.expandByPoint(node.getWorldPosition(new T.Vector3())).expandByScalar(.25);
  return box;
}

// Map a change on a native mount to its displayed (possibly nested) child.
// Always use the exact stored bases; translation preserves shear and reflection.
export function applyEdit(item, world) {
  const obj = item.object, baseline = new T.Matrix4().fromArray(obj.native_edit_world_matrix ?? obj.world_matrix);
  const display = new T.Matrix4().fromArray(obj.world_matrix);
  setWorld(item.node,world.clone().multiply(baseline.invert()).multiply(display));
}

export function localMatrix(fields) {
  const rotation = new T.Euler(...fields.rotation.map(n=>T.MathUtils.degToRad(n)),'YXZ');
  return new T.Matrix4().compose(new T.Vector3(...fields.position),new T.Quaternion().setFromEuler(rotation),new T.Vector3(...fields.scale));
}
