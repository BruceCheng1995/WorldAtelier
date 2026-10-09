/** Restore only the launch settings injected into a fixed authoring workspace.
 * All other lines, including unfamiliar native settings, remain author bytes.
 * The managed values are scalar Godot config entries; no scene data is parsed.
 */
const managed=[['application','run/main_scene'],['application','config/name'],['autoload','GameRuntime'],['editor','export/convert_text_resources_to_binary'],['rendering','textures/vram_compression/import_etc2_astc'],['rendering','textures/vram_compression/import_s3tc_bptc']];
function field(text,section,key){
  const lines=text.split(/(?<=\n)/),result={lines,index:-1,value:null,line:null};let current='';
  for(let i=0;i<lines.length;i++){
    const label=lines[i].match(/^\s*\[([^\]]+)\]\s*$/);if(label){current=label[1];continue;}
    const entry=lines[i].match(/^\s*([^;#=]+?)\s*=([^\r\n]*)/);
    if(current===section&&entry?.[1].trim()===key){result.index=i;result.value=entry[2].trim();result.line=lines[i];}
  }
  return result;
}
export function nativeSourceSettingsFromWorkspace(original,prepared,edited){
  let result=edited;
  for(const [section,key]of managed){
    const source=field(original,section,key),fixed=field(prepared,section,key),candidate=field(result,section,key);
    if(fixed.value===source.value||candidate.value!==fixed.value||candidate.index<0)continue;
    candidate.lines.splice(candidate.index,1,...(source.line===null?[]:[source.line]));result=candidate.lines.join('');
  }
  return result;
}
