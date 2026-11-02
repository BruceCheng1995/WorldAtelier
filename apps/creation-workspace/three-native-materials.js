import {splitNativeShadowLights} from './three-gles-direct.js';
import {toneFunctions,registerDepthMaterial} from './three-native-post.js';
// Only GPU programs reviewed as part of this application are registered.
// Hashes identify the complete original Godot source, including inline shaders.
// Uniform values from projects remain values; they never become shader source.
const programs = new Map();

programs.set("3b0360285d7c499f97ac31325cf1e408937be33af9ef433a2fbe263ae06387dc", {
  name: "desert ground", defaults: {},
  header: `varying vec3 wa_wp;
uniform float waTime;`,
  vertex: `wa_wp=(modelMatrix*vec4(waVertex,1.0)).xyz;`,
  fragment: `float h=fract(sin(dot(floor(wa_wp.xz*15.0),vec2(12.9898,78.233)))*43758.5453);float p=sin(wa_wp.x*0.7+sin(wa_wp.z*0.4))*sin(wa_wp.z*0.9);diffuseColor.rgb=mix(vec3(0.46,0.255,0.13),vec3(0.70,0.44,0.235),0.7+0.08*p)+(h-0.5)*0.035;roughnessFactor=1.0;`,
  doubleSided: false, transparent: false, additive: false, unlit: false, clearcoat: false
});

programs.set("c4f7aeeeb88faf818d342503c21f38e2c29b805caaf6e5848d55829a3bad2f14", {
  name: "weathered metal", defaults: {"base_color": [0.5, 0.4, 0.3, 1.0], "metalness": 0.0, "roughness_value": 0.86, "weathering": 0.35, "grain_scale": 5.0, "hit_flash": 0.0},
  header: `uniform vec4 wa_base_color;
uniform float wa_metalness;
uniform float wa_roughness_value;
uniform float wa_weathering;
uniform float wa_grain_scale;
uniform float wa_hit_flash;
varying vec3 wa_surface_pos;
float wa_hash(vec3 p) { return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
float wa_noise3(vec3 p) {
 vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
 return mix(mix(mix(wa_hash(i),wa_hash(i+vec3(1,0,0)),f.x),mix(wa_hash(i+vec3(0,1,0)),wa_hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(wa_hash(i+vec3(0,0,1)),wa_hash(i+vec3(1,0,1)),f.x),mix(wa_hash(i+vec3(0,1,1)),wa_hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
uniform float waTime;`,
  vertex: `wa_surface_pos = waVertex;`,
  fragment: `vec3 p=wa_surface_pos*wa_grain_scale;
 float broad=wa_noise3(p*0.34), grain=wa_noise3(p*3.0);
 float wear=smoothstep(0.60,0.84,wa_noise3(p*2.1))*wa_weathering;
 vec3 surface=wa_base_color.rgb*(0.78+broad*0.34+(grain-0.5)*0.07);
 surface=mix(surface,vec3(0.20,0.12,0.065),wear*wa_metalness);
 surface=mix(surface,vec3(0.43,0.36,0.25),wa_weathering*0.13);
 diffuseColor.rgb=mix(surface,vec3(1.0,0.90,0.68),wa_hit_flash);
 metalnessFactor=wa_metalness*(1.0-wear);
 roughnessFactor=clamp(wa_roughness_value+(grain-0.5)*0.20+wear*0.25,0.18,1.0);
 // Fine surface relief in view space, stable on moving vehicles.
 vec3 q0=dFdx((-vViewPosition)),q1=dFdy((-vViewPosition));
 vec3 r0=cross(q1,normal),r1=cross(normal,q0);
 float det=dot(q0,r0);
 float height=grain*0.0015*wa_weathering;
 normal=normalize(abs(det)*normal-sign(det)*(dFdx(height)*r0+dFdy(height)*r1));`,
  doubleSided: false, transparent: false, additive: false, unlit: false, clearcoat: false
});

programs.set("225c21e70e2e3b608b084f9027d32807941cb5a90ec91c4da1d47ade6a750680", {
  name: "weathered road", defaults: {"base_color": [0.25, 0.28, 0.24, 1.0], "road": 0.0},
  header: `uniform vec4 wa_base_color;
uniform float wa_road;
varying vec3 wa_world_pos;
float wa_hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float wa_noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.-2.*f);return mix(mix(wa_hash(i),wa_hash(i+vec2(1,0)),f.x),mix(wa_hash(i+vec2(0,1)),wa_hash(i+vec2(1,1)),f.x),f.y);}
uniform float waTime;`,
  vertex: `wa_world_pos=(modelMatrix*vec4(waVertex,1.)).xyz;`,
  fragment: `vec2 p=wa_world_pos.xz;float grain=wa_noise(p*38.);float waPatch=wa_noise(p*.8)*.65+wa_noise(p*3.1)*.35;float crack=smoothstep(.48,.498,abs(wa_noise(p*2.)-.5));vec3 col=wa_base_color.rgb*(.68+.5*waPatch+.15*grain); col=mix(col,vec3(.08,.10,.085),crack*.8);float wet=smoothstep(.56,.74,wa_noise(p*.65));diffuseColor.rgb=col;roughnessFactor=mix(.94,.24,wet);metalnessFactor=wet*.15;`,
  doubleSided: false, transparent: false, additive: false, unlit: false, clearcoat: false
});

programs.set("c205db8ad508221669f65dd647aaba796fc2a8add6c2dae824ecf71b4aa8af3e", {
  name: "garden surface", defaults: {"base_color": [0.4, 0.6, 0.2, 1.0], "surface_roughness": 0.6, "surface_metallic": 0.0, "coating": 0.0, "grain_scale": 24.0, "grain_amount": 0.055, "bump_amount": 0.025, "surface_kind": 0.0},
  header: `uniform vec4 wa_base_color;
uniform float wa_surface_roughness;
uniform float wa_surface_metallic;
uniform float wa_coating;
uniform float wa_grain_scale;
uniform float wa_grain_amount;
uniform float wa_bump_amount;
uniform int wa_surface_kind;
varying vec3 wa_object_position;
float wa_hash(vec3 p) { return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
float wa_noise(vec3 p) {
 vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
 return mix(mix(mix(wa_hash(i),wa_hash(i+vec3(1,0,0)),f.x),mix(wa_hash(i+vec3(0,1,0)),wa_hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(wa_hash(i+vec3(0,0,1)),wa_hash(i+vec3(1,0,1)),f.x),mix(wa_hash(i+vec3(0,1,1)),wa_hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
uniform float waTime;`,
  vertex: `wa_object_position=waVertex;`,
  fragment: `vec3 p=wa_object_position*wa_grain_scale;
 if (wa_surface_kind==1) p*=vec3(1.0,0.13,1.0);
 if (wa_surface_kind==4) p*=vec3(0.12,3.0,1.0);
 float grain=wa_noise(p);
 float broad=wa_noise(wa_object_position*3.0);
 float detail=grain;
 if(wa_surface_kind==1) detail=sin((wa_object_position.x+wa_object_position.z)*65.0+broad*9.0)*0.5+0.5;
 if(wa_surface_kind==5) detail=sin(p.x*3.0)*sin(p.y*3.0)*0.5+0.5;
 diffuseColor.rgb=wa_base_color.rgb*(1.0+(detail-0.5)*wa_grain_amount);
 if(wa_surface_kind==2) diffuseColor.rgb*=mix(vec3(0.93,0.95,0.91),vec3(1.02,1.02,0.98),broad);
 roughnessFactor=clamp(wa_surface_roughness+(grain-0.5)*0.13,0.16,1.0);
 metalnessFactor=wa_surface_metallic;
 waSpec=0.36;
 waCoat=wa_coating;
 waCoatRoughness=0.25;
 // Keep imported smooth normals. Roughness grain supplies microstructure without
 // unstable screen derivatives on tiny triangles and grazing roof surfaces.`,
  doubleSided: true, transparent: false, additive: false, unlit: false, clearcoat: true
});

programs.set("13afb2ca2a49450c438765adcca52f6ec7822d22b2848ec0f00f85413d3ddb1c", {
  name: "aged surface", defaults: {"tint": [0.35, 0.38, 0.34, 1.0], "wear": 0.4, "grain_scale": 1.0, "surface_kind": 0.0, "base_roughness": 0.8, "bump_strength": 0.12, "wetness": 0.0, "cloth_sway": 0.0, "bevel_extent": [0.0, 0.0, 0.0], "bevel_radius": 0.0, "garment_folds": 0.0, "crumple": 0.0},
  header: `uniform vec4 wa_tint;
uniform float wa_wear;
uniform float wa_grain_scale;
// Plaster, enamel, iron, timber, linen, floor slabs.
uniform int wa_surface_kind;
uniform float wa_base_roughness;
uniform float wa_bump_strength;
uniform float wa_wetness;
uniform float wa_cloth_sway;
uniform vec3 wa_bevel_extent;
uniform float wa_bevel_radius;
uniform float wa_garment_folds;
uniform float wa_crumple;
varying vec3 wa_local_pos;
varying vec3 wa_world_pos;
varying vec3 wa_view_pos;
float wa_hash3(vec3 p) {
 p = fract(p * 0.1031);
 p += dot(p, p.yzx + 33.33);
 return fract((p.x + p.y) * p.z);
}
float wa_noise3(vec3 p) {
 vec3 i = floor(p), f = fract(p);
 f = f * f * (3.0 - 2.0 * f);
 return mix(mix(mix(wa_hash3(i),wa_hash3(i+vec3(1,0,0)),f.x),mix(wa_hash3(i+vec3(0,1,0)),wa_hash3(i+vec3(1,1,0)),f.x),f.y),mix(mix(wa_hash3(i+vec3(0,0,1)),wa_hash3(i+vec3(1,0,1)),f.x),mix(wa_hash3(i+vec3(0,1,1)),wa_hash3(i+vec3(1,1,1)),f.x),f.y),f.z);
}
uniform float waTime;`,
  vertex: `waVertex += objectNormal*wa_crumple*(sin(waVertex.x*45.0+waVertex.z*23.0)*0.016+sin(waVertex.y*61.0+waVertex.x*18.0)*0.012);
 if (wa_garment_folds>0.0) {
  float angle = atan(waVertex.z,waVertex.x);
  float fold = sin(angle*11.0+waVertex.y*2.0)*wa_garment_folds;
  waVertex.xz *= 1.0+fold;
 }
 if (wa_bevel_radius > 0.0) {
  vec3 inner = clamp(waVertex, -wa_bevel_extent+wa_bevel_radius, wa_bevel_extent-wa_bevel_radius);
  vec3 delta = waVertex-inner;
  if (length(delta)>0.00001) {
   objectNormal = normalize(delta);
   waVertex = inner+objectNormal*wa_bevel_radius;
  }
 }
 float pinned = 1.0-smoothstep(-1.275,1.275,waVertex.y);
 waVertex.z += wa_cloth_sway*(0.35+pinned*0.65)*(sin(waVertex.x*21.0+waVertex.y*0.5)*0.065+sin(waVertex.x*8.0+waTime*0.7)*pinned*0.025);
 waVertex.y -= wa_cloth_sway*pinned*(0.035+0.025*sin(waVertex.x*13.0));
 wa_local_pos = waVertex;
 wa_world_pos = (modelMatrix * vec4(waVertex,1.0)).xyz;
 wa_view_pos = (modelViewMatrix * vec4(waVertex,1.0)).xyz;`,
  fragment: `vec3 p = wa_local_pos * max(wa_grain_scale,0.05);
 float broad = wa_noise3(p*0.83);
 float medium = wa_noise3(p*5.7);
 float micro = wa_noise3(p*73.0);
 float streak = wa_noise3(p*vec3(2.8,0.24,2.8));
 float foot_dirt = (1.0-smoothstep(0.05,0.62,wa_world_pos.y))*wa_wear;
 float stain = smoothstep(0.32,0.78,broad*0.46+streak*0.54)*wa_wear;
 vec3 base = wa_tint.rgb*(0.87+broad*0.13+medium*0.045);
 float h = medium*0.1+micro*0.025;
 float rough = wa_base_roughness;
 float metal = 0.0;
 if (wa_surface_kind == 0) {
  base = mix(base,vec3(0.055,0.066,0.06),stain*0.48);
  h += medium*0.12;
 } else if (wa_surface_kind == 1) {
  float chip = smoothstep(0.57,0.71,medium*0.48+broad*0.42+micro*0.1)*wa_wear;
  float drip = smoothstep(0.56,0.74,wa_noise3(p*vec3(18.0,0.65,18.0)))*stain;
  base = mix(base,vec3(0.12,0.075,0.038),chip*0.7+drip*0.22);
  base *= 1.0-stain*0.16-foot_dirt*0.23;
  rough = mix(wa_base_roughness,0.96,max(chip,stain));
  h = medium*0.016-chip*0.045;
 } else if (wa_surface_kind == 2) {
  float rust = smoothstep(0.36,0.74,broad*0.6+medium*0.4)*wa_wear;
  base = mix(base,vec3(0.20,0.091,0.038)*(0.65+medium*0.6),rust);
  metal = 0.72*(1.0-rust);
  rough = mix(wa_base_roughness,0.94,rust);
  h += rust*0.16;
 } else if (wa_surface_kind == 3) {
  float grain = wa_noise3(p*vec3(1.0,48.0,12.0)+medium*2.0);
  base *= 0.66+grain*0.48;
  base = mix(base,vec3(0.073,0.055,0.036),stain*0.6);
  h = grain*0.06;
 } else if (wa_surface_kind == 4) {
  float aa = 1.0-smoothstep(0.4,1.6,length(fwidth(p))*190.0);
  float weave = sin(p.x*310.0)*sin(p.y*310.0)*0.5*aa+0.5;
  base *= 0.91+weave*0.06;
  float fold = sin(p.x*21.0+p.y*0.5);
  base *= 1.0-wa_cloth_sway*(0.07+0.07*fold);
  base = mix(base,vec3(0.18,0.16,0.105),stain*0.68);
  h = weave*0.006+medium*0.04+wa_cloth_sway*fold*0.22;
  rough = 0.94;
 } else {
  vec2 grid = fract(wa_world_pos.xz/0.86);
  vec2 edge = min(grid,1.0-grid);
  float joint = 1.0-smoothstep(0.009,0.024,min(edge.x,edge.y));
  float slab = wa_hash3(vec3(floor(wa_world_pos.xz/0.86),0.0));
  base *= 0.76+slab*0.29;
  base = mix(base,vec3(0.025,0.034,0.032),joint*0.7);
  h -= joint*0.085;
 }
 float damp = smoothstep(0.32,0.69,broad)*wa_wetness;
 if (wa_surface_kind == 5) {
  float puddle = smoothstep(0.50,0.65,wa_noise3(wa_world_pos*vec3(0.64,1.0,1.25)));
  damp = max(damp,puddle*0.88);
  h *= 1.0-damp*0.82;
 }
 base *= 1.0-damp*0.32;
 diffuseColor.rgb = base;
 roughnessFactor = clamp(mix(rough,0.18,damp)+(micro-0.5)*0.07,0.12,0.99);
 metalnessFactor = metal;
 waSpec = mix(0.34,0.52,damp);
 waAO = clamp(1.0-stain*0.27,0.6,1.0);
 waAOInfluence = 0.15;
 vec3 dx = dFdx(wa_view_pos), dy = dFdy(wa_view_pos);
 vec3 rx = cross(dy,normal), ry = cross(normal,dx);
 float determinant = dot(dx,rx);
 vec3 gradient = sign(determinant)*(dFdx(h)*rx+dFdy(h)*ry);
 normal = normalize(max(abs(determinant),0.000001)*normal-gradient*wa_bump_strength*0.20);`,
  doubleSided: false, transparent: false, additive: false, unlit: false, clearcoat: false
});

programs.set("c85cff5ae18c7a9b37a3fde897a5fb945455542007aeb61e208cb17a085c93a9", {
  name: "raincoat", defaults: {"fabric_color": [0.66, 0.445, 0.055, 1.0], "hood": false, "hem": false, "motion_wind": 0.0},
  header: `uniform vec4 wa_fabric_color;
uniform bool wa_hood;
uniform bool wa_hem;
uniform float wa_motion_wind;
varying vec3 wa_cloth_pos;
uniform float waTime;`,
  vertex: `wa_cloth_pos = waVertex;
 if (wa_hem) {
  float angle = atan(waVertex.z,waVertex.x);
  float weight = 1.0-smoothstep(-0.24,0.12,waVertex.y);
  float fold = (sin(angle*9.0+waVertex.y*7.0)+sin(angle*5.0-0.7)*0.45)*0.013;
  waVertex.xz *= 1.0+fold*weight*4.0;
  waVertex.x -= wa_motion_wind*weight*0.016;
  waVertex.z += sin(waTime*5.0+angle*2.0)*weight*wa_motion_wind*0.004;
 }
 if (wa_hood) {
  float crown = smoothstep(0.015,0.24,waVertex.y);
  waVertex.x -= crown*crown*0.12;
  waVertex.y += crown*crown*0.14;
  waVertex.z *= 1.0-crown*0.35;
 }`,
  fragment: `vec3 p = wa_cloth_pos;
 float aa = 1.0-smoothstep(0.35,1.2,length(fwidth(p))*450.0);
 float grain = mix(0.5,fract(sin(dot(floor(p*540.0),vec3(13.19,31.71,72.93)))*43758.5),aa);
 float crease = sin(atan(p.z,p.x)*9.0+p.y*7.0)*0.5+0.5;
 float hem_dirt = wa_hem ? (1.0-smoothstep(-0.25,-0.07,p.y))*0.24 : 0.0;
 vec3 base = wa_fabric_color.rgb*(0.89+crease*0.09+grain*0.035-hem_dirt);
 float opening = 0.0;
 if (wa_hood) {
  float front = p.x*0.83+p.z*0.55;
  float side = p.z*0.83-p.x*0.55;
  float aperture = pow(side/0.155,2.0)+pow((p.y+0.028)/0.172,2.0);
  if (front>0.11 && aperture<1.0) { discard; }
  opening = (1.0-smoothstep(1.0,1.17,aperture))*smoothstep(0.10,0.15,front);
  base *= 1.0-opening*0.20;
 }
 if (!gl_FrontFacing) { base *= 0.20; }
 if (wa_hem) {
  float seam = (1.0-smoothstep(0.008,0.016,abs(p.z)))*smoothstep(0.1,0.15,p.x);
  base *= 1.0-seam*0.24;
 }
 diffuseColor.rgb = base;
 roughnessFactor = mix(0.66+grain*0.05,0.84,opening);
 waSpec = 0.27*(1.0-opening);
 waAO = 1.0-opening*0.94;
 waAOInfluence = 0.9;`,
  doubleSided: true, transparent: false, additive: false, unlit: false, clearcoat: false
});

programs.set("a2a2a00cb87aba8b109849e21f170f828f4f0bccc68e34b901d3859e6fc8a6c0", {
  name: "worn skin", defaults: {"skin_color": [0.37, 0.31, 0.235, 1.0]},
  header: `uniform vec4 wa_skin_color;
varying vec3 wa_skin_pos;
uniform float waTime;`,
  vertex: `wa_skin_pos = waVertex;`,
  fragment: `vec3 p = wa_skin_pos;
 float mottling = sin(p.x*26.0+sin(p.y*31.0))*sin(p.z*21.0+p.y*19.0)*0.5+0.5;
 float crease = pow(0.5+0.5*sin(p.y*45.0+sin(p.x*16.0)*2.0),14.0);
 float mask = smoothstep(0.10,0.28,abs(p.y));
 diffuseColor.rgb = wa_skin_color.rgb*(0.92+0.08*mottling-crease*mask*0.035);
 roughnessFactor = 0.86;
 waSpec = 0.22;
 waAO = 1.0-crease*mask*0.16;`,
  doubleSided: false, transparent: false, additive: false, unlit: false, clearcoat: false
});

programs.set("a4bb5e1a569c02916d673bf3b49cce8911188086d5f9e3dc0401f99a1b10aece", {
  name: "water", defaults: {"tint": [0.065, 0.09, 0.09, 1.0], "ripple_strength": 0.035},
  header: `uniform vec4 wa_tint;
uniform float wa_ripple_strength;
varying vec3 wa_world_pos;
uniform float waTime;`,
  vertex: `wa_world_pos = (modelMatrix*vec4(waVertex,1.0)).xyz;`,
  fragment: `float wave = sin(wa_world_pos.x*9.0+waTime*0.9)*sin(wa_world_pos.z*7.0-waTime*0.63);
 diffuseColor.rgb = wa_tint.rgb*(0.9+wave*0.04);
 roughnessFactor = 0.17+wave*0.025;
 metalnessFactor = 0.28;
 waSpec = 0.7;
 normal = normalize(normal+vec3(cos(wa_world_pos.x*9.0+waTime*0.9),0.0,sin(wa_world_pos.z*7.0-waTime*0.63))*wa_ripple_strength);`,
  doubleSided: false, transparent: false, additive: false, unlit: false, clearcoat: false
});

programs.set("268c48cf0b66f6b2b338c2a3ac366cd56241e1efb3aa589c763119e86ffba990", {
  name: "rift portal", defaults: {"portal_color": [1.0, 0.23, 0.035, 1.0]},
  header: `uniform vec4 wa_portal_color;
varying vec2 waSurfaceUv;
uniform float waTime;`,
  vertex: `
waSurfaceUv=uv;`,
  fragment: `vec2 p = waSurfaceUv*2.0-1.0;
 float r = length(p*vec2(0.8,1.0));
 float a = atan(p.y,p.x);
 float ring = pow(max(0.0,1.0-abs(r-0.74)*8.0),2.0);
 float swirl = pow(max(0.0,sin(a*5.0+r*17.0-waTime*2.3)),5.0);
 float motes = pow(max(0.0,sin(waSurfaceUv.y*110.0+waTime*4.0)*sin(waSurfaceUv.x*81.0-waTime*3.0)),12.0);
 float mask = smoothstep(1.05,0.65,r);
 diffuseColor.rgb = wa_portal_color.rgb*(ring*1.4+swirl*0.23+motes*0.55);
 diffuseColor.a = mask*(0.2+ring*0.7+swirl*0.25);`,
  doubleSided: true, transparent: true, additive: true, unlit: true, clearcoat: false
});

programs.set("544280ebb86780b202dc2d6f87ffbb580e23c46b696e6676ee5e9858de5d17bf",{
  name:"atmospheric light shaft", unlit:true, transparent:true, doubleSided:true, sceneDepth:true,
  defaults:{light_tint:[.83,.77,.61,1],density:.025},
  header:`uniform vec4 wa_light_tint;uniform float wa_density,waTime;
    varying vec3 waLocal,waView,waNormal;varying vec2 waUV;`,
  vertex:`waLocal=waVertex;waView=(modelViewMatrix*vec4(waVertex,1.)).xyz;waNormal=normalMatrix*normal;waUV=uv;`,
  fragment:`float rim=pow(abs(dot(normalize(waNormal),normalize(-waView))),2.);
    float ends=smoothstep(0.,.18,waUV.y)*(1.-smoothstep(.68,1.,waUV.y));
    float haze=.88+.12*sin(waLocal.y*5.+waTime*.5+sin(waLocal.x*2.));
    vec2 at=gl_FragCoord.xy/waDepthSize;
    vec4 behind=waInvProjection*vec4(at*2.-1.,texture2D(waOpaqueDepth,at).r*2.-1.,1.);
    diffuseColor=vec4(wa_light_tint.rgb,wa_density*rim*ends*haze*smoothstep(0.,.65,-behind.z/behind.w+waView.z));`
});

function fixedUniform(T, fallback, input) {
  if (Array.isArray(fallback)) {
    const values = Array.isArray(input) && input.length === fallback.length && input.every(Number.isFinite) ? input : fallback;
    return {value: new T['Vector' + fallback.length](...values)};
  }
  if (typeof fallback === 'boolean') return {value: typeof input === 'boolean' ? input : fallback};
  return {value: Number.isFinite(input) ? input : fallback};
}

export function createNativeSurfaceMaterial(T, props, options) {
  const program = programs.get(props.shader_sha256);
  const unlit = props.unlit || program?.unlit;
  const lit = {...options, roughness: props.roughness ?? 1, metalness: props.metallic ?? 0,
    emissive: new T.Color(...(props.emission ?? [0, 0, 0]).slice(0, 3)).convertSRGBToLinear(), emissiveIntensity: props.emission_energy ?? 1};
  const material = program && !unlit ? new T.MeshPhysicalMaterial(lit) :
    unlit ? new T.MeshBasicMaterial(options) : new T.MeshStandardMaterial(lit);
  material.name = props.name ?? '';
  material.userData.nativeShader = props.shader ?? null;
  material.userData.uniforms = props.uniforms ?? {};
  if (program) {
    material.userData.nativeShaderStatus = 'adapted';
    material.userData.nativeShaderProgram = program.name;
    material.userData.timeDependent = /\bwaTime\b/.test([program.vertex,program.fragment,program.normal].join(' '));
    if (program.doubleSided) material.side = T.DoubleSide;
    if (program.transparent) {material.transparent = true; material.depthWrite = false;}
    if (program.additive) material.blending = T.AdditiveBlending;
    if (program.clearcoat) {material.clearcoat = Number(props.uniforms?.coating ?? program.defaults.coating); material.clearcoatRoughness = 0.25;}
    const uniforms = {waTime: {value: 0}};
    for (const [key, fallback] of Object.entries(program.defaults)) {
      uniforms['wa_' + key] = fixedUniform(T, fallback, props.uniforms?.[key]);
    }
    material.onBeforeRender = (_renderer,scene) => {uniforms.waTime.value = scene.userData.nativeShaderTime ?? performance.now()/1000;};
    if(program.sceneDepth){
      registerDepthMaterial();
      const depthUniforms={waOpaqueDepth:{value:null},waDepthSize:{value:new T.Vector2(1,1)},waInvProjection:{value:new T.Matrix4()}};
      Object.assign(uniforms,depthUniforms);material.userData.nativeDepthUniforms=depthUniforms;
    }
    material.customProgramCacheKey = () => 'wa-native:' + props.shader_sha256;
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      const vertex = 'vec3 waVertex = position;\n' + program.vertex;
      shader.vertexShader = program.header + '\n' + shader.vertexShader;
      if (program.unlit) {
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', vertex + '\nvec3 transformed=waVertex;');
        shader.fragmentShader = (program.sceneDepth?'uniform sampler2D waOpaqueDepth;uniform vec2 waDepthSize;uniform mat4 waInvProjection;\n':'')+program.header + '\n' + shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n{' + program.fragment + '\n}\n diffuseColor.rgb=sRGBTransferEOTF(diffuseColor).rgb;');
      } else {
        shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + vertex)
          .replace('#include <begin_vertex>', 'vec3 transformed = waVertex;');
        // Godot exposes its surface values before lighting. Match that stage
        // in the Three physical shader, preserving its light and shadow passes.
        shader.fragmentShader = program.header + '\n' + shader.fragmentShader
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            float waSpec = 0.5, waAO = 1.0, waAOInfluence = 0.0, waCoat = 0.0, waCoatRoughness = 0.25;
            { ${program.fragment}
            }
            diffuseColor.rgb=sRGBTransferEOTF(diffuseColor).rgb;`)
          .replace('#include <lights_physical_fragment>', T.ShaderChunk.lights_physical_fragment
            .replace('float specularIntensityFactor = specularIntensity;', 'float specularIntensityFactor = 4.0 * waSpec * waSpec;'))
          .replace('#include <aomap_fragment>', `#include <aomap_fragment>
            reflectedLight.indirectDiffuse *= waAO;
            reflectedLight.directDiffuse *= mix(1.0, waAO, waAOInfluence);
            reflectedLight.directSpecular *= mix(1.0, waAO, waAOInfluence);`);
      }
    };
  } else if (Object.hasOwn(props, 'shader') || props.shader_sha256) {
    material.userData.nativeShaderStatus = 'unsupported';
  }
  return bindProjectedFog(T, material);
}

// Godot compatibility uses radial distance and a linear extinction exponent.
// Preserve ordinary Three fog outside a projected environment. The bindings
// are per material because preview and Play may use different environments.
export function bindProjectedFog(T, material) {
  if (material.userData.nativeFogBindings) return material;
  const enabled = {value: false}, color = {value: new T.Color()}, values = {value: new T.Vector4()},
    depth = {value: new T.Vector4()}, sun = {value: new T.Vector3()}, sunColor = {value: new T.Color()};
  const tone={value:new T.Vector3(-1,1,1)};
  material.userData.nativeFogBindings = true;
  const onRender = material.onBeforeRender, compile = material.onBeforeCompile, cacheKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => cacheKey + ':wa-fog-1';
  material.onBeforeRender = function(renderer, scene, ...rest) {
    onRender.call(this, renderer, scene, ...rest);
    const env=scene.userData.nativeTone;
    tone.value.set(env&&this.toneMapped&&(!renderer.getRenderTarget()||renderer.getRenderTarget().userData?.nativeTone)?env.tone_mapper:-1,env?.exposure??1,env?.white??1);
    const fog = scene.fog?.nativeFog;
    enabled.value = !!fog;
    if (!fog) return;
    color.value.copy(fog.color);
    values.value.set(fog.density, fog.height, fog.heightDensity, fog.scatter);
    depth.value.set(fog.depthMode ? 1 : 0, fog.begin, fog.end > fog.begin ? fog.end : rest[0].far, fog.curve);
    sun.value.copy(fog.sun); sunColor.value.copy(fog.sunColor);
  };
  material.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    Object.assign(shader.uniforms, {waFogEnabled: enabled, waFogColor: color, waFogParams: values, waDepthFog: depth, waSunDir: sun, waSunColor: sunColor});
    shader.vertexShader = shader.vertexShader.replace('#include <fog_pars_vertex>', `#include <fog_pars_vertex>
      #ifdef USE_FOG
      varying vec3 waFogWorld;
      #endif`).replace('#include <fog_vertex>', `#include <fog_vertex>
      #ifdef USE_FOG
      vec4 waWorld = vec4(transformed, 1.0);
      #ifdef USE_BATCHING
      waWorld = batchingMatrix * waWorld;
      #endif
      #ifdef USE_INSTANCING
      waWorld = instanceMatrix * waWorld;
      #endif
      waFogWorld = (modelMatrix * waWorld).xyz;
      #endif`);
    shader.uniforms.waTone=tone;
    shader.fragmentShader='uniform vec3 waTone;\n'+toneFunctions+'\n'+shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>
      #ifdef USE_FOG
      varying vec3 waFogWorld;
      uniform bool waFogEnabled;
      uniform vec3 waFogColor, waSunDir, waSunColor;
      uniform vec4 waFogParams, waDepthFog;
      #endif`).replace('#include <tonemapping_fragment>', `
      #ifdef USE_FOG
      if (waFogEnabled) {
        vec3 delta = waFogWorld - cameraPosition;
        float d = length(delta);
        float end = waDepthFog.z;
        float f = waDepthFog.x > 0.5 ? pow(smoothstep(waDepthFog.y, max(end, waDepthFog.y + 1e-5), d), waDepthFog.w) * waFogParams.x : 1.0 - exp(-d * waFogParams.x);
        f = max(f, 1.0 - exp(min(0.0, (waFogWorld.y - waFogParams.y) * waFogParams.z)));
        vec3 fogLight = waFogColor + waSunColor * waFogParams.w * pow(max(0.0, dot(delta / max(d, 1e-5), waSunDir)), 8.0);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogLight, clamp(f, 0.0, 1.0));
      }
      #endif
      if(waTone.x>=0.&&waTone.x<=3.)gl_FragColor.rgb=waNativeTone(gl_FragColor.rgb,waTone);
      else {
        #include <tonemapping_fragment>
      }`).replace('#include <fog_fragment>', `
      #ifdef USE_FOG
      if (!waFogEnabled) {
      ${T.ShaderChunk.fog_fragment}
      }
      #endif`);
    splitNativeShadowLights(T,shader);
  };
  return material;
}

function directionalSuns(projection, T) {
  return (projection.nodes ?? []).filter(n=>n.type === 'DirectionalLight3D' && n.light && n.visible !== false && n.light.sky_mode !== 1 && n.world_matrix)
    .slice(0, 4).map(row=>({
      direction: new T.Vector3().fromArray(row.world_matrix, 8).normalize(),
      color: new T.Color(...row.light.color.slice(0, 3)).multiplyScalar(row.light.energy),
      size: Math.cos(T.MathUtils.degToRad(row.light.angular_diameter ?? 0))
    }));
}

// Bake the authored ProceduralSkyMaterial function into a half-float cubemap.
// A sky can light PBR surfaces as well as the background. Builds on hosts
// without a sky restore the camera's original background and lighting.
function proceduralSky(T, sky, suns, brightness, fog = null) {
  const dimension = 128, images = [];
  const sunLimit = Math.cos(T.MathUtils.degToRad(sky.sun_angle_max ?? 30));
  const sunExponent = 1.6 / Math.pow(Math.max(0.001, sky.sun_curve ?? 0.15), 1.4);
  const direction = new T.Vector3(), color = new T.Color();
  const top = new T.Color(...sky.top.slice(0,3)), horizon = new T.Color(...sky.horizon.slice(0,3));
  const fogColor = fog ? new T.Color(...fog.color.slice(0,3)).convertSRGBToLinear().multiplyScalar(fog.energy) : null;
  const scattered = suns.map(sun=>sun.color.clone().convertSRGBToLinear());
  const tint = new T.Color();
  const bottom = new T.Color(...sky.ground.slice(0,3)), groundHorizon = new T.Color(...sky.ground_horizon.slice(0,3));
  for (let face=0; face<6; face++) {
    const pixels = new Uint16Array(dimension*dimension*4);
    for (let y=0; y<dimension; y++) for (let x=0; x<dimension; x++) {
      const u=2*(x+0.5)/dimension-1, v=2*(y+0.5)/dimension-1;
      // WebGL's +X,-X,+Y,-Y,+Z,-Z faces. Three mirrors X when sampling
      // user cubemaps. Give each texel the corresponding world-space ray.
      if (face===0) direction.set(-1,-v,-u);
      if (face===1) direction.set(1,-v,u);
      if (face===2) direction.set(-u,1,v);
      if (face===3) direction.set(-u,-1,-v);
      if (face===4) direction.set(-u,-v,1);
      if (face===5) direction.set(u,-v,-1);
      direction.normalize();
      if (direction.y>=0) {
        color.copy(top).lerp(horizon,Math.pow(1-direction.y,0.6/Math.max(0.001,sky.curve))).multiplyScalar(sky.energy??1);
        for (const sun of suns) {
          const angle=direction.dot(sun.direction);
          if (angle>sun.size) color.copy(sun.color);
          else if (angle>sunLimit && sun.size>sunLimit) color.lerp(sun.color,Math.pow((angle-sunLimit)/(sun.size-sunLimit),sunExponent));
        }
      } else {
        color.copy(bottom).lerp(groundHorizon,Math.pow(1+direction.y,0.6/Math.max(0.001,sky.ground_curve))).multiplyScalar(sky.ground_energy??1);
      }
      color.multiplyScalar(brightness).convertSRGBToLinear();
      if (fogColor) {
        tint.copy(fogColor).lerp(color,fog.aerial??0);
        for (let j=0;j<suns.length;j++) {
          const weight=Math.pow(Math.max(0,direction.dot(suns[j].direction)),8)*Math.PI*(fog.sun_scatter??0);
          tint.r+=scattered[j].r*weight;tint.g+=scattered[j].g*weight;tint.b+=scattered[j].b*weight;
        }
        color.lerp(tint,fog.sky_affect??1);
      }
      const i=(x+y*dimension)*4;
      pixels[i]=T.DataUtils.toHalfFloat(color.r);pixels[i+1]=T.DataUtils.toHalfFloat(color.g);pixels[i+2]=T.DataUtils.toHalfFloat(color.b);pixels[i+3]=T.DataUtils.toHalfFloat(1);
    }
    const image = new T.DataTexture(pixels,dimension,dimension,T.RGBAFormat,T.HalfFloatType);
    images.push(image);
  }
  const cube = new T.CubeTexture(images);
  cube.type = T.HalfFloatType; cube.colorSpace=T.LinearSRGBColorSpace; cube.needsUpdate=true;
  return cube;
}

export function projectSkyAndFog(T,scene,projection,original) {
  const env=projection?.environment,sky=env?.sky,suns=directionalSuns(projection??{},T);
  const signature=sky?JSON.stringify([sky,suns,env.background_energy,env.fog]):null;
  if (original.skySignature!==signature) {
    original.cube?.dispose();original.skyBackground?.dispose();
    original.cube=sky?proceduralSky(T,sky,suns,env.background_energy):null;
    original.skyBackground=sky&&env.fog&&(env.fog.sky_affect??1)>0?proceduralSky(T,sky,suns,env.background_energy,env.fog):null;
    original.skySignature=signature;
  }
  const backgroundSky=env && (env.background_mode===2 || env.background_mode===undefined && sky);
  if (original.cube && backgroundSky) {
    scene.background=original.skyBackground??original.cube;
    scene.backgroundIntensity=1;
  }
  const reflectionSky=env?.reflection_source===2 || (env?.reflection_source===0 && backgroundSky);
  const ambientSky=env?.ambient_source===3 || (env?.ambient_source===0 && backgroundSky);
  if (original.cube && (reflectionSky || ambientSky)) {
    scene.environment=original.cube;
    scene.environmentIntensity=ambientSky?env.ambient_energy:1;
  }
  if (!env?.fog) return;
  const f=env.fog, color=new T.Color(...f.color.slice(0,3)).convertSRGBToLinear().multiplyScalar(f.energy);
  scene.fog=new T.FogExp2(color,f.density);
  scene.fog.nativeFog={color,density:f.density,height:f.height??0,heightDensity:f.height_density??0,depthMode:f.mode===1,
    begin:f.begin??0,end:f.end??0,curve:f.curve??1,scatter:f.sun_scatter??0,sun:suns[0]?.direction??new T.Vector3(),sunColor:suns[0]?.color??new T.Color(0)};
}
