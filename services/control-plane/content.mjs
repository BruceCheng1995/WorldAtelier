import {createHash} from 'node:crypto';

export const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonical(value)).digest('hex');
export function canonical(v) {
  if(Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  if(v&&typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
export function validateContent(content) {
  if(content?.asset_blobs)throw Error('Asset blobs are injected by the build service, not source edits');
  if(content?.behaviors&&(!Array.isArray(content.behaviors)||content.behaviors.length>8))throw Error('Invalid behavior list');
  if(!content || content.schema!==1) throw Error('Unsupported content schema');
  for(const key of ['zones','objects','enemies','quests']) {
    if(!Array.isArray(content[key])||content[key].length>3000) throw Error(`Invalid ${key}`);
    const ids=new Set();
    for(const item of content[key]) {
      if(!item||typeof item.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(item.id)||ids.has(item.id)) throw Error(`Invalid or duplicate ${key} ID`);
      ids.add(item.id);
    }
  }
  function check(v,depth=0) {
    if(depth>20) throw Error('Content nesting too deep');
    if(typeof v==='number'&&(!Number.isFinite(v)||Math.abs(v)>1e7)) throw Error('Invalid numeric content');
    if(typeof v==='string'&&v.length>20000) throw Error('Content string too long');
    if(v&&typeof v==='object') for(const [k,x] of Object.entries(v)) {
      if(['__proto__','constructor','prototype'].includes(k)) throw Error('Reserved content key');
      check(x,depth+1);
    }
  }
  check(content);
  if(!content.spawn||!content.rules) throw Error('Missing spawn/rules');
  return content;
}
const equal=(a,b)=>canonical(a)===canonical(b);
export function mergeContent(base,local,remote) {
  const conflicts=[];
  function merge(b,l,r,path) {
    if(equal(l,b))return structuredClone(r);
    if(equal(r,b)||equal(l,r))return structuredClone(l);
    if(l&&r&&typeof l==='object'&&typeof r==='object'&&!Array.isArray(l)&&!Array.isArray(r)) {
      const out={};
      for(const key of new Set([...Object.keys(b??{}),...Object.keys(l),...Object.keys(r)])) {
        const value=merge(b?.[key],l[key],r[key],`${path}/${key}`);
        if(value!==undefined)out[key]=value;
      }
      return out;
    }
    if(Array.isArray(l)&&Array.isArray(r)&&[...l,...r,...(b??[])].every(x=>x&&typeof x.id==='string')) {
      const bm=new Map((b??[]).map(x=>[x.id,x])),lm=new Map(l.map(x=>[x.id,x])),rm=new Map(r.map(x=>[x.id,x]));
      return [...new Set([...rm.keys(),...lm.keys(),...bm.keys()])].map(id=>merge(bm.get(id),lm.get(id),rm.get(id),`${path}/${id}`)).filter(x=>x!==undefined);
    }
    conflicts.push({path,base:b,local:l,remote:r});return structuredClone(r);
  }
  return {content:merge(base,local,remote,''),conflicts};
}
