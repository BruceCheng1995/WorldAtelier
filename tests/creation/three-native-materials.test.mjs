import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createNativeSurfaceMaterial} from '../../apps/creation-workspace/three-native-materials.js';
import {applyProjectedEnvironment} from '../../apps/creation-workspace/three-source-scene.js';

test('native shader bytes select trusted code and source values remain typed uniforms',()=>{
  const weathered={shader:'res://materials/weathered.gdshader',shader_sha256:'c4f7aeeeb88faf818d342503c21f38e2c29b805caaf6e5848d55829a3bad2f14',uniforms:{base_color:[.2,.3,.4,1],grain_scale:11,weathering:'void malicious(){}'}};
  const material=createNativeSurfaceMaterial(T,weathered,{color:new T.Color(1,1,1)});
  assert.equal(material.userData.nativeShaderStatus,'adapted');
  const shader={uniforms:{},vertexShader:T.ShaderLib.physical.vertexShader,fragmentShader:T.ShaderLib.physical.fragmentShader};
  material.onBeforeCompile(shader,null);
  assert.deepEqual(shader.uniforms.wa_base_color.value.toArray(),[.2,.3,.4,1]);
  assert.equal(shader.uniforms.wa_grain_scale.value,11);
  assert.equal(shader.uniforms.wa_weathering.value,.35);assert.ok(!shader.fragmentShader.includes('malicious'));
  assert.ok(shader.fragmentShader.includes('wa_noise3')&&shader.fragmentShader.includes('dFdx(height)'));
  const changed=createNativeSurfaceMaterial(T,{...weathered,shader_sha256:'0'.repeat(64)},{color:new T.Color(1,1,1)});
  assert.equal(changed.userData.nativeShaderStatus,'unsupported');
  const renamed=createNativeSurfaceMaterial(T,{...weathered,shader:'res://any/renamed.gdshader'},{color:new T.Color(1,1,1)});
  assert.equal(renamed.userData.nativeShaderStatus,'adapted');
});

test('sky and fog use the fixed environmental settings and restore the prior scene',()=>{
  const scene=new T.Scene(),renderer={shadowMap:{},toneMapping:T.NoToneMapping,toneMappingExposure:1};
  const prior=new T.Color(0x232233),priorFog=new T.Fog(0x444455,1,50);scene.background=prior;scene.fog=priorFog;
  const sky={top:[.1,.2,.9,1],horizon:[.7,.8,.85,1],ground:[.15,.07,.02,1],ground_horizon:[.6,.66,.7,1],curve:.18,ground_curve:.05};
  const env={background_mode:2,background:[0,0,0,1],ambient:[1,1,1,1],ambient_energy:1,background_energy:1,tone_mapper:0,exposure:1,sky,
    fog:{color:[.2,.3,.4,1],density:.02,energy:1,height_density:.05,mode:0,sky_affect:.25}};
  applyProjectedEnvironment(T,scene,renderer,{nodes:[],environment:env});assert.ok(scene.background.isCubeTexture);
  const cube=scene.background;assert.equal(scene.fog.nativeFog.heightDensity,.05);
  applyProjectedEnvironment(T,scene,renderer,{nodes:[],environment:env});assert.equal(scene.background,cube);
  let disposed=false;cube.addEventListener('dispose',()=>{disposed=true;});
  applyProjectedEnvironment(T,scene,renderer,null);assert.equal(scene.background,prior);assert.equal(scene.fog,priorFog);assert.ok(disposed);
});
