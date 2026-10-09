// getRandomValues also works on LAN HTTP; randomUUID and SubtleCrypto require
// a secure context in browsers. Keep nonces cryptographically random either way.
export function randomUUID() {
  if(globalThis.crypto.randomUUID)return globalThis.crypto.randomUUID();
  const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// Native dialog backdrops target the dialog itself. Check its bounds as well:
// padding, text selection and drags out of a form must not dismiss the form.
export function bindDialogDismiss(dialog, close) {
  let pointer = null, released = false;
  const outside = event => {
    if (event.target !== dialog || !dialog.open) return false;
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  const reset = () => { pointer = null; released = false; };
  dialog.addEventListener('pointerdown', event => {
    reset();
    if (event.button === 0 && outside(event)) pointer = event.pointerId;
  });
  dialog.addEventListener('pointerup', event => {
    released = pointer !== null && event.pointerId === pointer && event.button === 0 && outside(event);
    if (!released) reset();
  });
  dialog.addEventListener('click', event => {
    const dismiss = released && outside(event); reset();
    if (dismiss) { event.preventDefault(); event.stopPropagation(); close(); }
  });
  dialog.addEventListener('pointercancel', reset);
  dialog.addEventListener('close', reset);
}

// Anchor temporary panels to the actual button, including after toolbar reordering.
// Fixed positioning also lets card menus escape a scrolling sidebar's clipping box.
export function positionFloatingPanel(panel, anchor, {align = 'end', above = false} = {}) {
  if (!panel || !anchor) return;
  const view = panel.ownerDocument.defaultView, gap = 8, inset = 12;
  const rect = anchor.getBoundingClientRect();
  Object.assign(panel.style, {position:'fixed', right:'auto', bottom:'auto', margin:'0',
    maxWidth:`${Math.max(0, view.innerWidth - inset * 2)}px`, maxHeight:`${Math.max(0, view.innerHeight - inset * 2)}px`});
  const box = panel.getBoundingClientRect();
  const below = view.innerHeight - rect.bottom - gap - inset, before = rect.top - gap - inset;
  const flip = above ? before >= box.height || before > below : below < box.height && before > below;
  const available = Math.max(0, flip ? before : below);
  panel.style.maxHeight = `${available}px`;
  panel.style.left = `${Math.max(inset, Math.min(align === 'start' ? rect.left : rect.right - box.width, view.innerWidth - box.width - inset))}px`;
  panel.style.top = `${Math.max(inset, flip ? rect.top - gap - Math.min(box.height, available) : rect.bottom + gap)}px`;
}

const SHA256_K=new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
const rotate=(n,b)=>(n>>>b)|(n<<(32-b));
export async function sha256Hex(buffer) {
  const bytes=ArrayBuffer.isView(buffer)?new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.byteLength):new Uint8Array(buffer);
  if(globalThis.crypto?.subtle){
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  }
  const padded=new Uint8Array(Math.ceil((bytes.length+9)/64)*64);padded.set(bytes);padded[bytes.length]=128;
  const data=new DataView(padded.buffer),bits=bytes.length*8;
  data.setUint32(padded.length-8,Math.floor(bits/0x100000000));data.setUint32(padded.length-4,bits>>>0);
  const state=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),words=new Uint32Array(64);
  for(let offset=0;offset<padded.length;offset+=64){
    for(let i=0;i<16;i++)words[i]=data.getUint32(offset+i*4);
    for(let i=16;i<64;i++){
      const x=words[i-15],y=words[i-2];
      words[i]=words[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+words[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10));
    }
    let [a,b,c,d,e,f,g,h]=state;
    for(let i=0;i<64;i++){
      const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+SHA256_K[i]+words[i])>>>0;
      const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((n,i)=>{state[i]+=n;});
  }
  return Array.from(state,n=>n.toString(16).padStart(8,'0')).join('');
}

/** Identity color v1. The server-persisted random user UUID is the seed, so
 * registration order, connection ids, names and local storage cannot change it.
 * Return RGB hex for both CSS and Godot; avoid client-supplied color overrides.
 */
export function userColor(user){
  const id=user?.user_id??user?.id;
  if(typeof id!=='string'||!id)return '#8b9c92';
  let seed=2166136261;for(const c of id)seed=Math.imul(seed^c.charCodeAt(0),16777619)>>>0;
  const hue=seed%360,saturation=.58+((seed>>>10)%15)/100,lightness=.72+((seed>>>20)%7)/100;
  const amplitude=saturation*Math.min(lightness,1-lightness);
  const channel=n=>{const k=(n+hue/30)%12;return Math.round(255*(lightness-amplitude*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');};
  return '#'+channel(0)+channel(8)+channel(4);
}
