import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeNativeScene,refreshWorkspaceAssets} from '../../apps/desktop-launcher/workspace.mjs';
import {atomicWrite,jsonFile,hash} from '../../apps/desktop-launcher/runtime.mjs';
test('Native repeated saves preserve remote-only fields and refuse same-field overwrite',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'atelier-native-'));
  try{
    const base={schema:1,objects:[{id:'a',name:'Original',x:1,z:2,color:'#112233'}],rules:{attack_damage:10}};
    await atomicWrite(join(directory,'workspace.json'),{base_revision:'source-1',content:base,play_content:{}});await atomicWrite(join(directory,'source-assets.json'),{});await atomicWrite(join(directory,'editor/import-base.json'),base);
    const remote=structuredClone(base);remote.objects[0].name='Remote collaborator';await atomicWrite(join(directory,'content.json'),remote);
    const scene=structuredClone(base);scene.objects[0].x=4;await atomicWrite(join(directory,'editor/scene-export.json'),scene);await mergeNativeScene(directory);
    assert.equal((await jsonFile(join(directory,'content.json'))).objects[0].name,'Remote collaborator');
    scene.objects[0].x=5;await atomicWrite(join(directory,'editor/scene-export.json'),scene);await mergeNativeScene(directory);
    const kept=await jsonFile(join(directory,'content.json'));assert.equal(kept.objects[0].name,'Remote collaborator');assert.equal(kept.objects[0].x,5);
    kept.objects[0].x=8;await atomicWrite(join(directory,'content.json'),kept);scene.objects[0].x=7;await atomicWrite(join(directory,'editor/scene-export.json'),scene);
    await assert.rejects(mergeNativeScene(directory),/conflicts/);assert.equal((await jsonFile(join(directory,'content.json'))).objects[0].x,8);assert.equal((await jsonFile(join(directory,'editor/native-export-conflicts.json'))).conflicts[0].path,'$.objects[a].x');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('Missing authorized asset preserves source base, reports failure and can retry without source import',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'atelier-assets-'));
  try{
    const bytes=Buffer.from('extends RefCounted\n'),key=hash(bytes),source={objects:[],behaviors:[{id:'rule',asset_hash:key,api:1}]};
    await atomicWrite(join(directory,'workspace.json'),{project_id:'p',base_revision:'fixed-source',content:source,play_content:{}});await atomicWrite(join(directory,'content.json'),source);
    const result=await refreshWorkspaceAssets({directory,api:async()=>{throw Error('Membership revoked');}});assert.match(result.error,/Membership revoked/);assert.equal((await jsonFile(join(directory,'workspace.json'))).base_revision,'fixed-source');
    let calls=0;const retried=await refreshWorkspaceAssets({directory,api:async path=>{calls++;assert.equal(path,`/api/projects/p/assets/${key}`);return {asset:{hash:key,mime:'text/x-gdscript'},data_base64:bytes.toString('base64')};}});
    assert.equal(retried.error,null);assert.equal(calls,1);const metadata=await jsonFile(join(directory,'workspace.json'));assert.equal(metadata.base_revision,'fixed-source');assert.equal(metadata.source_preparation_error,null);assert.deepEqual(metadata.content,source);assert.equal(await jsonFile(join(directory,'source-preparation-error.json'),null),null);
  }finally{await rm(directory,{recursive:true,force:true});}
});
