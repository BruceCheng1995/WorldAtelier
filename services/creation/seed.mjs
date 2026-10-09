import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// This catalog is original project content. It does not supply gameplay behavior.
export function seedManifest(root, template='empty') {
  const resources={};
  if(template==='harbor') {
    const {assets:models}=JSON.parse(readFileSync(resolve(root,'content/model-preview/manifest.json')));
    for(const model of models)resources[model.id]={id:model.id,kind:'prefab',name:model.name,objects:[{
      id:model.id,name:model.name,kind:model.slug,model:model.sha256,
      model_url:`/preview-assets/${model.sha256}.glb`,model_hash:model.sha256,
      position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],color:'#74d5cd',solid:['platform','arch','beacon'].includes(model.slug),components:{}
    }]};
  }
  const objects=template==='harbor'?[
    ['obj-dais-01','pf-platform','中央浮台',[0,0,0]],
    ['obj-beacon-07','pf-beacon','港口导航信标',[1.8,.2,.7]],
    ['obj-arch-02','pf-arch','北侧星门',[-3,0,-2]],
    ['obj-tree-11','pf-tree','珊瑚树 · 东',[4,0,-1.5]],
    ['obj-tree-12','pf-tree','珊瑚树 · 西',[-3.5,0,2.3]]
  ].map(([id,prefab,name,position])=>({...structuredClone(resources[prefab].objects[0]),id,prefab,name,position})):[];
  resources['scene-harbor']={id:'scene-harbor',kind:'scene',name:template==='harbor'?'星港广场':'初始场景',objects};
  return {schema:'creation-flat-1',entry_scene_id:'scene-harbor',resources};
}
