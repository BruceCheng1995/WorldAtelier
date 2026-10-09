// Asset-free logic fixture for consumer matrix/identity tests, not a runtime ACK.
import {HIERARCHY_SCHEMA,emptyDocument,prepareManifest} from '../../services/creation/hierarchy.mjs';
import {identityTransform,quaternionFromEulerDegrees} from '../../packages/scene/transform.mjs';
export const trs=(position=[0,0,0],euler=[0,0,0],scale=[1,1,1])=>({position,rotation:quaternionFromEulerDegrees(euler),scale});
export const anchor=(id,parent_id='root',transform=identityTransform(),extra={})=>({id,name:id,kind:'anchor',parent_id,transform,color:'#74d5cd',solid:false,components:{},...extra});
export const prepare=manifest=>prepareManifest(manifest,()=>true);
export const mount=(instance_id,prefab,parent_id='root',transform=identityTransform(),overrides=[])=>({instance_id,prefab_id:prefab.id,prefab_revision:prefab.version,parent_id,transform,overrides});
export function hierarchyRuntimeSource() {
  const scene=emptyDocument('scene'),house=emptyDocument('house','prefab'),sign=emptyDocument('sign','prefab');
  scene.nodes.root.transform=trs([1,2,3]);scene.nodes.carrier=anchor('carrier','root',trs([10,1,0],[0,90,0],[2,2,2]));
  house.nodes.root.transform=trs([0,3,0]);house.nodes.door=anchor('door','root',trs([0,0,4]));
  sign.nodes.root.transform=trs([.5,0,0]);sign.nodes.tip=anchor('tip','root',trs([0,0,1]));
  let m=prepare({schema:HIERARCHY_SCHEMA,entry_scene_id:'scene',resources:{scene,house,sign},prefab_revisions:{}});
  m.resources.house.instances.sign=mount('sign',m.resources.sign,'door',trs([0,1,0]));m=prepare(m);
  m.resources.scene.instances.a=mount('a',m.resources.house,'carrier',trs([1,0,0]));
  m.resources.scene.instances.b=mount('b',m.resources.house,'root',trs([30,0,0]));return prepare(m);
}
