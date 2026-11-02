import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createNativeSurfaceMaterial} from '../../apps/creation-workspace/three-native-materials.js';
test('native direct passes separate atlas lights while leaving unshaded materials alone',()=>{
  function shader(props,library){
    const m=createNativeSurfaceMaterial(T,props,{color:new T.Color(.2,.3,.4)});
    const program={uniforms:{},vertexShader:library.vertexShader,fragmentShader:library.fragmentShader};
    m.onBeforeCompile(program,null);return program.fragmentShader;
  }
  const lit=shader({},T.ShaderLib.physical);
  for(const kind of ['DIR','POINT','SPOT'])assert.ok(lit.includes('UNROLLED_LOOP_INDEX < NUM_'+kind+'_LIGHT_SHADOWS'));
  assert.ok(lit.includes('waSeparated')&&lit.includes('waShadowFogVisibility')&&lit.includes('displaySum'));
  assert.ok(!shader({unlit:true},T.ShaderLib.basic).includes('waSeparated'));
});
