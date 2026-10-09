// A reference token names an immutable session attachment, never a display name.
const pattern = () => /\[\[ref:([A-Za-z0-9_-]{1,180})\]\]/g;
export function referenceToken(attachment) {
  const id=typeof attachment==='string'?attachment:attachment?.id;
  if(!/^[A-Za-z0-9_-]{1,180}$/.test(id??''))throw new TypeError('引用身份无效');
  return `[[ref:${id}]]`;
}
export function referenceParts(text) {
  text=String(text??'');const parts=[];let offset=0;
  for(const match of text.matchAll(pattern())){
    if(match.index>offset)parts.push({text:text.slice(offset,match.index),start:offset,end:match.index});
    parts.push({id:match[1],text:match[0],start:match.index,end:match.index+match[0].length});offset=match.index+match[0].length;
  }
  if(offset<text.length)parts.push({text:text.slice(offset),start:offset,end:text.length});return parts;
}
export const referenceIds=text=>referenceParts(text).filter(p=>p.id).map(p=>p.id);
export const referencePrefix=a=>a?.kind==='knowledge'?'$$':a?.kind==='prefab'?'@@':'@';
export const referenceName=a=>String(a?.name??a?.snapshot?.name??a?.snapshot?.title??a?.object_id??'未命名引用');
export function expandReferenceText(text,attachments=[],{includeIdentity=false}={}){
  const byId=new Map(attachments.map(a=>[a.id,a]));
  return referenceParts(text).map(p=>{
    if(!p.id||!byId.has(p.id))return p.text;
    const label=`${referencePrefix(byId.get(p.id))}${referenceName(byId.get(p.id))}`;
    return includeIdentity?`[${label.replace(/[\\\[\]]/g,'\\$&').replace(/[\r\n]/g,' ')}](attachment:${p.id})`:label;
  }).join('');
}
