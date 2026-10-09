// Column-major affine matrices; right handed, Y up, metres. No engine dependency.
export const identity = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
export const identityTransform = () => ({position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]});
const error = code => { throw Object.assign(new Error(code), {status:422,code}); };
const finite = (v,n) => Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
export function normalizeTransform(value) {
  if (!value || !finite(value.position,3) || !finite(value.rotation,4) || !finite(value.scale,3)) error('invalid_transform');
  if (value.position.some(x=>Math.abs(x)>1e6) || value.scale.some(x=>x<1e-4||x>1e4)) error('invalid_transform_bounds');
  const length=Math.hypot(...value.rotation);
  if(length<1e-8)error('invalid_quaternion');
  let q=value.rotation.map(x=>Math.abs(length-1)<1e-12?x:x/length);
  const sign=[q[3],q[0],q[1],q[2]].find(x=>Math.abs(x)>1e-12)<0?-1:1;
  q=q.map(x=>x*sign||0);
  return {position:[...value.position],rotation:q,scale:[...value.scale]};
}
export function multiply(a,b) {
  const r=Array(16).fill(0);
  for(let c=0;c<4;c++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)r[c*4+row]+=a[k*4+row]*b[c*4+k];
  return r;
}
export function matrix(transform) {
  const {position:p,rotation:[x,y,z,w],scale:s}=normalizeTransform(transform);
  return [(1-2*(y*y+z*z))*s[0],2*(x*y+z*w)*s[0],2*(x*z-y*w)*s[0],0,
    2*(x*y-z*w)*s[1],(1-2*(x*x+z*z))*s[1],2*(y*z+x*w)*s[1],0,
    2*(x*z+y*w)*s[2],2*(y*z-x*w)*s[2],(1-2*(x*x+y*y))*s[2],0,...p,1];
}
export function inverse(a) {
  if(!finite(a,16)||Math.abs(a[3])+Math.abs(a[7])+Math.abs(a[11])+Math.abs(a[15]-1)>1e-8)error('invalid_affine_matrix');
  const [a00,a10,a20]=a, [a01,a11,a21]=a.slice(4), [a02,a12,a22]=a.slice(8);
  const det=a00*(a11*a22-a12*a21)-a01*(a10*a22-a12*a20)+a02*(a10*a21-a11*a20);
  if(Math.abs(det)<1e-15)error('singular_transform');
  const r=[(a11*a22-a12*a21)/det,(a12*a20-a10*a22)/det,(a10*a21-a11*a20)/det,0,
    (a02*a21-a01*a22)/det,(a00*a22-a02*a20)/det,(a01*a20-a00*a21)/det,0,
    (a01*a12-a02*a11)/det,(a02*a10-a00*a12)/det,(a00*a11-a01*a10)/det,0,0,0,0,1];
  for(let i=0;i<3;i++)r[12+i]=-(r[i]*a[12]+r[4+i]*a[13]+r[8+i]*a[14]);
  return r;
}
export const transformPoint=(m,p)=>[0,1,2].map(i=>m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12]);
export function decompose(m) {
  if(!finite(m,16))error('invalid_affine_matrix');
  const s=[0,4,8].map(i=>Math.hypot(m[i],m[i+1],m[i+2]));
  if(s.some(x=>x<1e-12))error('singular_transform');
  const r=m.map((x,i)=>i<12?x/s[Math.floor(i/4)]:x);
  const dot=(a,b)=>r[a]*r[b]+r[a+1]*r[b+1]+r[a+2]*r[b+2];
  if(Math.max(Math.abs(dot(0,4)),Math.abs(dot(0,8)),Math.abs(dot(4,8)))>1e-7)error('unrepresentable_shear');
  const determinant=r[0]*(r[5]*r[10]-r[9]*r[6])-r[4]*(r[1]*r[10]-r[9]*r[2])+r[8]*(r[1]*r[6]-r[5]*r[2]);
  if(determinant<0)error('negative_scale');
  const trace=r[0]+r[5]+r[10]; let x,y,z,w;
  if(trace>0){const t=2*Math.sqrt(1+trace);w=t/4;x=(r[6]-r[9])/t;y=(r[8]-r[2])/t;z=(r[1]-r[4])/t;}
  else if(r[0]>r[5]&&r[0]>r[10]){const t=2*Math.sqrt(1+r[0]-r[5]-r[10]);w=(r[6]-r[9])/t;x=t/4;y=(r[4]+r[1])/t;z=(r[8]+r[2])/t;}
  else if(r[5]>r[10]){const t=2*Math.sqrt(1+r[5]-r[0]-r[10]);w=(r[8]-r[2])/t;x=(r[4]+r[1])/t;y=t/4;z=(r[9]+r[6])/t;}
  else{const t=2*Math.sqrt(1+r[10]-r[0]-r[5]);w=(r[1]-r[4])/t;x=(r[8]+r[2])/t;y=(r[9]+r[6])/t;z=t/4;}
  const result=normalizeTransform({position:m.slice(12,15),rotation:[x,y,z,w],scale:s});
  if(matrix(result).some((x,i)=>Math.abs(x-m[i])>1e-6*Math.max(1,Math.abs(m[i]))))error('unrepresentable_shear');
  return result;
}
export function worldTransform(m) {try{return decompose(m);}catch(e){if(e.code==='unrepresentable_shear')return null;throw e;}}
export function quaternionFromEulerDegrees([x,y,z]) {
  [x,y,z]=[x,y,z].map(v=>v*Math.PI/360);
  // Godot Node3D's default Euler order YXZ: qY * qX * qZ.
  const cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z);
  return normalizeTransform({position:[0,0,0],scale:[1,1,1],rotation:[cy*sx*cz+sy*cx*sz,sy*cx*cz-cy*sx*sz,cy*cx*sz-sy*sx*cz,cy*cx*cz+sy*sx*sz]}).rotation;
}
