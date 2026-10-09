// Readable, portable annotation context. It carries references, never asset data.
export const annotationInput = a => ({revision:a.source_revision??a.revision,resource_id:a.resource_id,kind:a.annotation_kind??a.kind,object_ids:(a.members??[]).map(m=>m.object_id),dimension:a.dimension,position:a.position,geometry:a.geometry,note:a.note,camera:a.camera});
export function annotationDraftText(annotations,{tokens=false}={}){
  return '请按以下视口批注修改：\n\n'+annotations.map((a,i)=>{
    const members=a.members??[],kind=a.annotation_kind??a.kind,g=a.geometry,unit=a.dimension==='2d'?'px':'m',label=kind==='region'?`空间区域 · ${members.length} 个对象`:kind==='objects'?`对象集合 · ${members.length} 个对象`:kind==='point'?'空间描点':members[0]?.name??a.name??'对象';
    const reference=tokens?` [[ref:${a.id}]]`:'';
    const vector=v=>v.map(n=>Number(n.toFixed(2))).join(', ');
    const shape=g?.shape==='box'?`\n   尺寸 XYZ：${vector(g.size)} m`:g?.shape==='prism'?`\n   空间笔刷：${g.plane.toUpperCase()} 平面，偏移 ${Number(g.offset.toFixed(2))} m，厚度 ${Number(g.depth.toFixed(2))} m` : '';
    return `${i+1}. ${a.note}${reference}\n   ${a.resource_name??a.resource_id} · ${label} · (${vector(a.position)}) ${unit}`+shape+(['region','objects'].includes(kind)&&members.length?`\n   内容：${members.map(m=>m.name??m.object_id).join('、')}`:'');
  }).join('\n\n');
}
export function portableAnnotations(annotations,scope){
  return annotationDraftText(annotations)+'\n\n```worldatelier-annotations\n'+JSON.stringify({version:1,project_id:scope.project_id,branch_id:scope.branch_id,annotations:annotations.map(annotationInput)})+'\n```';
}
export function parsePortableAnnotations(text){
  const match=String(text).match(/```worldatelier-annotations\s*\n([\s\S]*?)\n```/);
  if(!match)return null;
  const value=JSON.parse(match[1]);if(value?.version!==1||!Array.isArray(value.annotations))throw Error('批注格式无效');return value;
}
