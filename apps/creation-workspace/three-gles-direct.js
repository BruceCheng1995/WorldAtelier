// GLES3 blends each shadow-atlas light's encoded contribution after the
// encoded base lighting pass. Combine those same terms in one Three draw.
// Three orders its lights with active shadow maps first in each light family.
const active='defined(USE_SHADOWMAP) && (NUM_DIR_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS + NUM_POINT_LIGHT_SHADOWS > 0) && !defined(USE_TRANSMISSION)';
const slots='(NUM_DIR_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS + NUM_POINT_LIGHT_SHADOWS)';
const index={POINT:'UNROLLED_LOOP_INDEX',SPOT:'(UNROLLED_LOOP_INDEX + NUM_POINT_LIGHT_SHADOWS)',DIR:'(UNROLLED_LOOP_INDEX + NUM_POINT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS)'};
const direct='RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

// Called after the native material/lighting/fog code has been assembled.
// Custom materials without Three's standard lighting stage remain untouched.
export function splitNativeShadowLights(T, shader) {
  if(!shader.fragmentShader.includes('#include <lights_fragment_begin>'))return;
  const hasNativeAO=shader.fragmentShader.includes('float waSpec =');
  const loops=T.ShaderChunk.lights_fragment_begin.replace(
    /(#pragma unroll_loop_start\s+for \( int i = 0; i < NUM_(POINT|SPOT|DIR)_LIGHTS; i \+\+ \) \{)([\s\S]*?)(\n\s*}\s*#pragma unroll_loop_end)/g,
    (_,start,type,body,end)=>{
      const key=index[type],guard=active+' && (UNROLLED_LOOP_INDEX < NUM_'+type+'_LIGHT_SHADOWS)';
      return start+body.replace(direct,`
        #if ${guard}
        {
          vec3 previousDirect = reflectedLight.directDiffuse + reflectedLight.directSpecular;
          #ifdef USE_CLEARCOAT
          vec3 previousCoat = clearcoatSpecularDirect;
          #endif
          #ifdef USE_SHEEN
          vec3 previousSheen = sheenSpecularDirect;
          #endif
          ${direct}
          waSeparated[${key}] = reflectedLight.directDiffuse + reflectedLight.directSpecular - previousDirect;
          #ifdef USE_CLEARCOAT
          waSeparatedCoat[${key}] = clearcoatSpecularDirect - previousCoat;
          #endif
          #ifdef USE_SHEEN
          waSeparatedSheen[${key}] = sheenSpecularDirect - previousSheen;
          #endif
        }
        #else
          ${direct}
        #endif`)+end;
    });
  shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',`
    #if ${active}
    vec3 waSeparated[${slots}];
    #ifdef USE_CLEARCOAT
    vec3 waSeparatedCoat[${slots}];
    #endif
    #ifdef USE_SHEEN
    vec3 waSeparatedSheen[${slots}];
    #endif
    float waShadowFogVisibility = 1.0;
    #endif
    ${loops}`)
    .replace('gl_FragColor.rgb = mix(gl_FragColor.rgb, fogLight, clamp(f, 0.0, 1.0));',`
      #if ${active}
      waShadowFogVisibility = 1.0-clamp(f,0.0,1.0);
      #endif
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogLight, clamp(f, 0.0, 1.0));`)
    .replace('if(waTone.x>=0.&&waTone.x<=3.)gl_FragColor.rgb=waNativeTone(gl_FragColor.rgb,waTone);',`
      if (waTone.x >= 0.0 && waTone.x <= 3.0) {
        #if ${active}
        vec3 separatedSum = vec3(0.0), displaySum = vec3(0.0);
        for (int k=0; k<${slots}; k++) {
          vec3 direct = waSeparated[k] * ${hasNativeAO?'mix(1.0, waAO, waAOInfluence)':'1.0'};
          #ifdef USE_SHEEN
          direct += waSeparatedSheen[k];
          #endif
          #ifdef USE_CLEARCOAT
          direct = direct * (1.0 - material.clearcoat * Fcc) + waSeparatedCoat[k] * material.clearcoat;
          #endif
          direct *= waShadowFogVisibility;
          separatedSum += direct;
          vec3 mapped = max(waNativeTone(max(direct,vec3(0.0)),waTone),vec3(0.0));
          displaySum += max(1.055*pow(mapped,vec3(1.0/2.4))-0.055,vec3(0.0));
        }
        vec3 base = max(waNativeTone(max(gl_FragColor.rgb-separatedSum,vec3(0.0)),waTone),vec3(0.0));
        displaySum += max(1.055*pow(base,vec3(1.0/2.4))-0.055,vec3(0.0));
        // The following Three colorspace stage still owns the destination
        // encoding, including linear intermediate render targets.
        gl_FragColor.rgb = sRGBTransferEOTF(vec4(displaySum,1.0)).rgb;
        #else
        gl_FragColor.rgb = waNativeTone(gl_FragColor.rgb,waTone);
        #endif
      }`);
}
