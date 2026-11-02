// The workbench passes the fixed entry scene to every independent run.
// Add game input and simulation here when the project gains gameplay.
import {createProjectedNode,applyProjectedEnvironment} from '@world-atelier/scene';

export function createGame({THREE, renderer, source}) {
  const scene=new THREE.Scene();
  scene.background=new THREE.Color(0x333333);
  applyProjectedEnvironment(THREE,scene,renderer,source.three_projection);
  const resources=new Map();
  let camera=null;
  for(const row of source.three_projection.nodes){
    const node=createProjectedNode(THREE,row,resources);
    scene.add(node);
    if(node.isCamera&&(!camera||row.camera.current))camera=node;
  }
  if(!camera){
    camera=new THREE.PerspectiveCamera(75,1,0.05,4000);
    camera.position.set(0,2,8);
    camera.lookAt(0,0,0);
  }
  return {scene,camera,dispose(){
    for(const {geometry,material} of resources.values()){geometry.dispose();material.dispose();}
    scene.traverse(node=>node.shadow?.dispose());
  }};
}
