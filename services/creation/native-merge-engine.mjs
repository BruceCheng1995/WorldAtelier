import {createHash} from 'node:crypto';
import {fail,hash,stable} from './schema.mjs';
import {nativeFileMap,nativeSourceIdentity} from './native-source.mjs';

export const NATIVE_MERGE_ALGORITHM='native-source-merge-2';
const TEXT_LIMIT=2*1024*1024,VALUE_PREVIEW=16000,PARSE_CACHE_LIMIT=128,PARSE_CACHE_BYTES=16*1024*1024;
const parsedCache=new Map();let parsedCacheBytes=0;
const binaryPath=path=>/\.(?:bin|scn|res|glb|png|jpe?g|webp|gif|bmp|tiff?|psd|blend|fbx|ttf|otf|woff2?|wav|ogg|mp3|flac|mp4|webm|pck|zip|wasm|dll|so|dylib)$/i.test(path);
const equal=(a,b)=>stable(a)===stable(b);
const digest=value=>hash(value);
const own=(value,key)=>Object.hasOwn(value,key);
const lines=text=>text.match(/[^\n]*\n|[^\n]+$/g)??[];
const utf8=bytes=>{
  if(bytes.length>TEXT_LIMIT||bytes.includes(0))return null;
  const text=bytes.toString('utf8');return Buffer.from(text).equals(bytes)?text:null;
};
const preview=value=>typeof value==='string'&&value.length>VALUE_PREVIEW?{text:value.slice(0,VALUE_PREVIEW),truncated:true,characters:value.length,sha256:digest(value)}:value;

/** Return every best common ancestor, not the first traversal intersection.
 * A virtual candidate is represented by all of its immutable parent heads. */
export function nativeMergeBases(store,leftHeads,rightHeads){
  const ancestors=heads=>{
    const seen=new Set(),active=new Set();let project=null;
    for(const head of heads){const pending=[[head,false]];while(pending.length){const [id,expanded]=pending.pop();if(expanded){active.delete(id);seen.add(id);continue;}if(active.has(id))fail(409,'源版本历史包含循环',{code:'native_merge_invalid_history',revision:id});if(seen.has(id))continue;const revision=store.revisionMeta?.(id)??store.get('creator_revision',id);if(!revision)fail(409,'源版本历史不完整',{code:'native_merge_missing_history',revision:id});project??=revision.project_id;if(revision.project_id!==project)fail(409,'源版本历史跨越项目',{code:'native_merge_invalid_history',revision:id});active.add(id);pending.push([id,true]);for(const parent of revision.parents??[])pending.push([parent,false]);}}
    return seen;
  };
  const left=ancestors(leftHeads),right=ancestors(rightHeads),common=[...left].filter(id=>right.has(id));
  const nonBest=new Set();
  // The intersection is ancestor-closed: marking its direct parents is enough.
  for(const id of common)for(const parent of (store.revisionMeta?.(id)??store.get('creator_revision',id)).parents??[])if(left.has(parent)&&right.has(parent))nonBest.add(parent);
  return common.filter(id=>!nonBest.has(id)).sort();
}

function conflictContext({resolutions={},prefix='',conflicts=[],used=new Set(),onConflict}={}){
  return {resolutions,prefix,conflicts,used,choose(local,base,source,target,details={},manual=true){
    const fingerprint=digest({algorithm:NATIVE_MERGE_ALGORITHM,local,base,source,target});
    const key=(prefix?prefix+'/':'')+local+'@'+fingerprint.slice(0,24),provided=own(resolutions,key),decision=resolutions[key];
    onConflict?.({key,fingerprint,base,source,target,...details});
    let choice=typeof decision==='string'?decision:decision?.choice;
    const item={key,fingerprint,...details,base:preview(base),source:preview(source),target:preview(target),choices:['source','target','base',...(manual?['manual']:[])],resolved:false};
    if(provided){
      used.add(key);
      if(!item.choices.includes(choice))fail(422,'合并冲突决议无效',{key,choices:item.choices});
      if(choice==='manual'){
        if(typeof decision.text!=='string'||Buffer.byteLength(decision.text)>TEXT_LIMIT)fail(422,'手工合并需要有界文本',{key});
        item.resolved=true;item.resolution='manual';conflicts.push(item);return decision.text;
      }
      item.resolved=true;item.resolution=choice;conflicts.push(item);return {base,source,target}[choice];
    }
    conflicts.push(item);return target;
  }};
}

function scalar(base,source,target,context,local,details,manual=true){
  if(equal(source,base))return target;if(equal(target,base)||equal(source,target))return source;
  return context.choose(local,base,source,target,details,manual);
}

/** Bounded exact LCS for small gaps, unique-line anchors for large files.
 * A hard repeated/large gap becomes one conservative hunk, never a guessed edit. */
export function nativeTextHunks(base,other){
  const a=Array.isArray(base)?base:lines(base),b=Array.isArray(other)?other:lines(other),matches=[];
  const align=(as,ae,bs,be,depth=0)=>{
    while(as<ae&&bs<be&&a[as]===b[bs]){matches.push([as++,bs++]);}
    const tail=[];while(as<ae&&bs<be&&a[ae-1]===b[be-1])tail.push([--ae,--be]);
    const n=ae-as,m=be-bs;
    if(n&&m&&n*m<=1000000){
      const width=m+1,table=new Uint32Array((n+1)*width);
      for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)table[i*width+j]=a[as+i]===b[bs+j]?table[(i+1)*width+j+1]+1:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
      for(let i=0,j=0;i<n&&j<m;){if(a[as+i]===b[bs+j])matches.push([as+i++,bs+j++]);else if(table[(i+1)*width+j]>=table[i*width+j+1])i++;else j++;}
    }else if(n&&m&&depth<32){
      const ac=new Map(),bc=new Map();for(let i=as;i<ae;i++)ac.set(a[i],ac.has(a[i])?-1:i);for(let i=bs;i<be;i++)bc.set(b[i],bc.has(b[i])?-1:i);
      const pairs=[...ac].filter(([key,index])=>index>=0&&(bc.get(key)??-1)>=0).map(([key,index])=>[index,bc.get(key)]).sort((x,y)=>x[0]-y[0]);
      const tails=[],indexes=[],previous=new Int32Array(pairs.length).fill(-1);
      for(let i=0;i<pairs.length;i++){let lo=0,hi=tails.length;while(lo<hi){const mid=(lo+hi)>>1;if(tails[mid]<pairs[i][1])lo=mid+1;else hi=mid;}if(lo)previous[i]=indexes[lo-1];tails[lo]=pairs[i][1];indexes[lo]=i;}
      const anchors=[];for(let i=indexes.at(-1);i!==undefined&&i>=0;i=previous[i])anchors.push(pairs[i]);anchors.reverse();
      let ap=as,bp=bs;for(const [ai,bi]of anchors){align(ap,ai,bp,bi,depth+1);matches.push([ai,bi]);ap=ai+1;bp=bi+1;}if(anchors.length)align(ap,ae,bp,be,depth+1);
    }
    matches.push(...tail.reverse());
  };
  align(0,a.length,0,b.length);matches.sort((x,y)=>x[0]-y[0]);
  const hunks=[];let ai=0,bi=0;for(const [am,bm]of [...matches,[a.length,b.length]]){if(am>ai||bm>bi)hunks.push({start:ai,end:am,lines:b.slice(bi,bm)});ai=am+1;bi=bm+1;}return hunks;
}

const overlaps=(a,b)=>a.start===a.end||b.start===b.end?a.start<=b.end&&b.start<=a.end:a.start<b.end&&b.start<a.end;
function applyHunks(base,start,end,hunks){let at=start,result=[];for(const h of hunks.sort((a,b)=>a.start-b.start)){result.push(...base.slice(at,h.start),...h.lines);at=h.end;}result.push(...base.slice(at,end));return result.join('');}

export function mergeNativeText(base,source,target,{context=conflictContext(),local='text',path=''}={}){
  if(source===base)return target;if(target===base||source===target)return source;
  const original=lines(base),edits=[...nativeTextHunks(original,lines(source)).map(h=>({...h,side:'source'})),...nativeTextHunks(original,lines(target)).map(h=>({...h,side:'target'}))].sort((a,b)=>a.start-b.start||a.end-b.end);
  const groups=[];
  for(const edit of edits){const previous=groups.at(-1);if(previous&&previous.edits.some(h=>overlaps(h,edit))){previous.edits.push(edit);previous.end=Math.max(previous.end,edit.end);}else groups.push({start:edit.start,end:edit.end,edits:[edit]});}
  let at=0,result='';
  for(const group of groups){
    result+=original.slice(at,group.start).join('');const from=group.edits.filter(h=>h.side==='source'),to=group.edits.filter(h=>h.side==='target');
    const before=original.slice(group.start,group.end).join(''),s=applyHunks(original,group.start,group.end,from),t=applyHunks(original,group.start,group.end,to);
    result+=scalar(before,s,t,context,local+'/'+group.start+'-'+group.end,{kind:'text',path,line_start:group.start+1,line_end:group.end});at=group.end;
  }
  return result+original.slice(at).join('');
}

function expressionState(text,state={quoted:false,escape:false,depth:0}){
  for(let i=0;i<text.length;i++){
    const c=text[i];if(state.quoted){if(state.escape)state.escape=false;else if(c==='\\')state.escape=true;else if(c==='"')state.quoted=false;continue;}
    if(c==='"')state.quoted=true;else if(c===';'||c==='#'){while(i<text.length&&text[i]!=='\n')i++;}else if('([{'.includes(c))state.depth++;else if(')]}'.includes(c))state.depth--;
    if(state.depth<0)return null;
  }return state;
}
function header(raw){
  const body=raw.trim();if(!body.startsWith('[')||!body.endsWith(']'))return null;
  const kind=body.match(/^\[(\w+)/)?.[1];if(!kind)return null;
  const attrs=new Map();let position=kind.length+1,end=body.length-1;
  while(position<end){while(/\s/.test(body[position]??'')&&position<end)position++;if(position>=end)break;const match=body.slice(position).match(/^([\w/]+)\s*=\s*/);if(!match)return null;const name=match[1],start=position;position+=match[0].length;const valueStart=position;let quoted=false,escaped=false,depth=0;
    while(position<end){const c=body[position];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if('([{'.includes(c))depth++;else if(')]}'.includes(c))depth--;else if(/\s/.test(c)&&depth===0)break;position++;}
    if(quoted||depth!==0||position===valueStart||attrs.has(name))return null;attrs.set(name,{value:body.slice(valueStart,position),start,end:position});
  }
  return {kind,attrs,raw};
}
const literal=value=>{try{const parsed=JSON.parse(value);return typeof parsed==='string'?parsed:null;}catch{return null;}};
const attr=(section,key)=>section.header.attrs.get(key)?.value;
const TRANSFORM_PROPERTIES=new Set(['transform','global_transform','position','rotation','rotation_degrees','scale','quaternion','basis','skew']);

function parseBody(text){
  const parts=lines(text),properties=new Map(),order=[];let pending='',index=0;
  while(index<parts.length){
    const line=parts[index],match=line.match(/^((?:[\w./:@-]+)|"(?:\\.|[^"\\])+")\s*=\s*/);
    if(!match){if(line.trim()&&!/^\s*[;#]/.test(line))return null;pending+=line;index++;continue;}
    const name=match[1];if(properties.has(name))return null;let raw=line,state=expressionState(line.slice(match[0].length));index++;
    if(!state)return null;
    while((state.quoted||state.depth)&&index<parts.length){state=expressionState(parts[index],state);raw+=parts[index++];if(!state)return null;}
    if(state.quoted||state.depth)return null;
    const token=pending+raw;pending='';properties.set(name,{raw:token,value:raw.slice(match[0].length).trim()});order.push(name);
  }
  return {properties,order,tail:pending};
}

/** A source-token view only. It is never persisted as an editable scene. */
export function parseNativeText(text){
  const digest=createHash('sha256').update(text).digest('hex');if(parsedCache.has(digest)){const cached=parsedCache.get(digest);parsedCache.delete(digest);parsedCache.set(digest,cached);return cached.result;}
  const result=(()=>{
    const sections=[],parts=lines(text);let prefix='',current=null,state={quoted:false,escape:false,depth:0};
    for(const line of parts){
      if(!state.quoted&&!state.depth&&/^\[\w+(?:\s|\])/.test(line)){
        const h=header(line);if(!h)return null;current={header:h,body:'',raw:line};sections.push(current);continue;
      }
      if(current){current.body+=line;current.raw+=line;}else prefix+=line;
      state=expressionState(line,state);if(!state)return null;
    }
    if(state.quoted||state.depth||!sections.length)return null;
    const nodePaths=new Map();
    for(const section of sections){
      section.parsed=parseBody(section.body);if(!section.parsed)return null;
      if(section.header.kind==='node'){
        const name=literal(attr(section,'name')),parent=literal(attr(section,'parent'));
        if(name===null)return null;section.nodePath=parent===null?'.':parent==='.'?name:parent+'/'+name;
        if(nodePaths.has(section.nodePath))return null;nodePaths.set(section.nodePath,section);
        section.nodeId=literal(section.parsed.properties.get('metadata/wa_node_id')?.value);
        section.instanceId=literal(section.parsed.properties.get('metadata/wa_instance_id')?.value);
      }
    }
    const keys=new Set();
    for(const section of sections){
      const kind=section.header.kind;
      if(kind==='node'){
        const parts=section.nodePath==='.'?[]:section.nodePath.split('/');if(parts.some(part=>!part||part==='..'||part==='.' ))return null;
        const prefixes=['.',...parts.map((_part,index)=>parts.slice(0,index+1).join('/'))],chain=prefixes.map(path=>nodePaths.get(path)?.instanceId).filter(Boolean);
        section.key=section.instanceId?'mount/'+JSON.stringify(chain):section.nodeId?'node/'+JSON.stringify([chain,section.nodeId]):'node-path/'+section.nodePath;
      }else if(kind==='ext_resource'||kind==='sub_resource')section.key=kind+'/'+(literal(attr(section,'id'))??attr(section,'id')??section.header.raw.trim());
      else if(['gd_scene','gd_resource','resource'].includes(kind))section.key=kind;
      else section.key='opaque/'+section.header.raw.trim();
      if(keys.has(section.key))return null;keys.add(section.key);
    }
    return {prefix,sections,byKey:new Map(sections.map(section=>[section.key,section]))};
  })();
  const bytes=result?Buffer.byteLength(text):64;parsedCache.set(digest,{result,bytes});parsedCacheBytes+=bytes;while(parsedCache.size>PARSE_CACHE_LIMIT||parsedCacheBytes>PARSE_CACHE_BYTES){const key=parsedCache.keys().next().value;parsedCacheBytes-=parsedCache.get(key).bytes;parsedCache.delete(key);}return result;
}

function mergedOrder(base,source,target,present,context,local,path){
  const surviving=list=>list.filter(key=>present.has(key)),b=surviving(base),s=surviving(source),t=surviving(target);
  const old=new Set(base),oldS=s.filter(key=>old.has(key)),oldT=t.filter(key=>old.has(key)),sSet=new Set(oldS),tSet=new Set(oldT),oldB=b.filter(key=>sSet.has(key)&&tSet.has(key)),commonSet=new Set(oldB);
  const sCommon=oldS.filter(key=>commonSet.has(key)),tCommon=oldT.filter(key=>commonSet.has(key));
  const additions=sequence=>{const groups=new Map(),following=new Array(sequence.length);let next='',before='';for(let i=sequence.length-1;i>=0;i--){following[i]=next;if(old.has(sequence[i]))next=sequence[i];}for(let i=0;i<sequence.length;i++){if(old.has(sequence[i])){before=sequence[i];continue;}const gap=JSON.stringify([before,following[i]]);if(!groups.has(gap))groups.set(gap,[]);groups.get(gap).push(sequence[i]);}return groups;};
  const sourceAdditions=additions(s),targetAdditions=additions(t);
  const additionCollision=[...sourceAdditions].some(([gap,values])=>targetAdditions.has(gap)&&!equal(values,targetAdditions.get(gap)));
  let preferred=t;
  if(additionCollision||!equal(sCommon,oldB)&&!equal(tCommon,oldB)&&!equal(sCommon,tCommon)){
    const selected=context.choose(local,base.join('\n'),source.join('\n'),target.join('\n'),{kind:'order',path,note:'排序选择不删除另一侧新增内容；未列出的新增项按原邻接位置补入'},false);preferred=selected.split('\n').filter(key=>present.has(key));
  }else if(!equal(sCommon,oldB))preferred=s;
  const nodes=new Map();let first=null,last=null;
  const insert=(key,next=null)=>{if(nodes.has(key))return;const previous=next===null?last:nodes.get(next).previous;nodes.set(key,{previous,next});if(previous===null)first=key;else nodes.get(previous).next=key;if(next===null)last=key;else nodes.get(next).previous=key;};
  for(const key of preferred)insert(key);
  for(const sequence of [s,t,b]){let next=null;for(let i=sequence.length-1;i>=0;i--){const key=sequence[i];if(!nodes.has(key))insert(key,next);next=key;}}
  const output=[];for(let key=first;key!==null;key=nodes.get(key).next)output.push(key);return output;
}

function mergeNativeStructured(baseText,sourceText,targetText,{context,local,path}){
  const documents=[baseText,sourceText,targetText].map(parseNativeText);if(documents.some(value=>!value))return null;
  const [base,source,target]=documents;
  const byNodePath=document=>new Map(document.sections.filter(section=>section.header.kind==='node').map(section=>[section.nodePath,section]));
  const nodePaths=documents.map(byNodePath);
  for(const nodePath of new Set([...nodePaths[1].keys(),...nodePaths[2].keys()])){
    const [b,s,t]=nodePaths.map(nodes=>nodes.get(nodePath));
    if(s&&t&&s.key!==t.key&&(!b||s.raw!==b.raw&&t.raw!==b.raw))return context.choose(local+'/node-identity/'+encodeURIComponent(nodePath),baseText,sourceText,targetText,{kind:'node_identity',path,note:'同一原生节点路径使用不同稳定身份，无法推断为改名或同一个对象；此决议选择整份文件'},true);
  }
  // A structural change and an independently edited descendant do not commute
  // merely because their property lines are separate. Preserve the originals.
  const baseNodes=base.sections.filter(section=>section.header.kind==='node'),editedPaths=document=>baseNodes.filter(node=>document.byKey.get(node.key)?.raw!==node.raw).map(node=>node.nodePath).sort(),sourceEdits=editedPaths(source),targetEdits=editedPaths(target);
  const hasDescendant=(paths,path)=>{if(path==='.')return paths.some(value=>value!=='.');const prefix=path+'/';let lo=0,hi=paths.length;while(lo<hi){const mid=(lo+hi)>>1;if(paths[mid]<prefix)lo=mid+1;else hi=mid;}return paths[lo]?.startsWith(prefix)??false;};
  for(const b of baseNodes)for(const [changed,otherEdits]of [[source,targetEdits],[target,sourceEdits]]){
    const next=changed.byKey.get(b.key);if(!next||next.header.raw===b.header.raw)continue;
    const descendantEdited=hasDescendant(otherEdits,b.nodePath);
    if(descendantEdited)return context.choose(local+'/hierarchy/'+encodeURIComponent(b.key),baseText,sourceText,targetText,{kind:'hierarchy_dependency',path,section:b.key,note:'父级结构变化与另一侧子树编辑相互影响，请核对完整层级；此决议选择整份文件'},true);
  }
  // Reusing a resource ID for another resource can silently redirect untouched
  // references. A token merge must not invent a cross-resource rename mapping.
  for(const section of source.sections.filter(s=>['ext_resource','sub_resource'].includes(s.header.kind))){
    const other=target.byKey.get(section.key);
    if(!base.byKey.has(section.key)&&other&&other.raw!==section.raw)return context.choose(local+'/new-resource-identity/'+encodeURIComponent(section.key),baseText,sourceText,targetText,{kind:'resource_identity',path,note:'双方新增了相同的局部资源 ID，但内容不同；逐段拼接会让另一侧引用错误资源，此决议选择整份文件'},true);
  }
  for(const section of base.sections.filter(s=>s.header.kind==='ext_resource')){
    const s=source.byKey.get(section.key),t=target.byKey.get(section.key),identity=x=>x?stable([...x.header.attrs].filter(([name])=>['path','uid','type'].includes(name)).map(([name,value])=>[name,value.value])):null;
    if(s&&t&&(identity(s)!==identity(section)||identity(t)!==identity(section))&&identity(s)!==identity(t))return context.choose(local+'/resource-identity',baseText,sourceText,targetText,{kind:'resource_identity',path,note:'外部资源身份变化，需明确核对所有引用'},true);
  }
  const merged=new Map(),all=new Set([...base.byKey.keys(),...source.byKey.keys(),...target.byKey.keys()]);
  for(const key of all){
    const [b,s,t]=documents.map(document=>document.byKey.get(key)),values=[b?.raw??null,s?.raw??null,t?.raw??null];
    let value;
    if(values[1]===values[0])value=values[2];else if(values[2]===values[0]||values[1]===values[2])value=values[1];
    else if(!b||!s||!t)value=context.choose(local+'/'+encodeURIComponent(key),...values,{kind:!s||!t?'delete_modify':'add_add',path,section:key},true);
    else{
      const structureChange=s.header.raw!==b.header.raw||t.header.raw!==b.header.raw;
      if(b.header.kind==='node'&&structureChange&&s.header.raw!==t.header.raw&&(s.body!==b.body||t.body!==b.body)){
        value=context.choose(local+'/'+encodeURIComponent(key)+'/structure',...values,{kind:'structure_with_edits',path,section:key,note:'节点改名、重挂或实例结构与另一侧属性修改需要共同核对'},true);
      }else{
        const heading=scalar(b.header.raw,s.header.raw,t.header.raw,context,local+'/'+encodeURIComponent(key)+'/header',{kind:'structure',path,section:key});
        const props=new Map(),names=new Set([...b.parsed.order,...s.parsed.order,...t.parsed.order]);
        const spatial=b.header.kind==='node'?[...names].filter(name=>TRANSFORM_PROPERTIES.has(name)):[];
        if(spatial.length){
          const group=[b,s,t].map(section=>spatial.map(name=>section.parsed.properties.get(name)?.raw??'').join(''));
          const chosen=scalar(...group,context,local+'/'+encodeURIComponent(key)+'/transform',{kind:'transform',path,section:key,property:'transform',properties:spatial,note:'完整变换作为一个整体处理，不自动拼接不同轴或位置、旋转、缩放'},true);
          const parsed=parseBody(chosen);if(!parsed||parsed.order.some(name=>!TRANSFORM_PROPERTIES.has(name)))fail(422,'手工变换决议必须只包含原生变换属性',{path,section:key});
          for(const name of parsed.order)props.set(name,parsed.properties.get(name).raw);
        }
        for(const name of names){if(spatial.includes(name))continue;const prop=[b,s,t].map(section=>section.parsed.properties.get(name)?.raw??null);const v=scalar(...prop,context,local+'/'+encodeURIComponent(key)+'/property/'+encodeURIComponent(name),{kind:'property',path,section:key,property:name});if(v!==null)props.set(name,v);}
        const order=mergedOrder(b.parsed.order,s.parsed.order,t.parsed.order,new Set(props.keys()),context,local+'/'+encodeURIComponent(key)+'/property-order',path);
        value=heading+order.map(name=>props.get(name)).join('')+scalar(b.parsed.tail,s.parsed.tail,t.parsed.tail,context,local+'/'+encodeURIComponent(key)+'/trivia',{kind:'text',path,section:key});
      }
    }
    if(value!==null)merged.set(key,value);
  }
  const order=mergedOrder(base.sections.map(s=>s.key),source.sections.map(s=>s.key),target.sections.map(s=>s.key),new Set(merged.keys()),context,local+'/section-order',path);
  return scalar(base.prefix,source.prefix,target.prefix,context,local+'/prefix',{kind:'text',path})+order.map(key=>merged.get(key)).join('');
}

/** The same pure three-way source operation powers branch merges and offline
 * replay. Only content-addressed blobs are read/written; no public head moves. */
export function mergeNativeFiles({base,source,target,archive,resolutions={},prefix='',onConflict}){
  [base,source,target]=[base,source,target].map(files=>nativeFileMap(files));
  const files=Object.assign(Object.create(null),target),changes=[],conflicts=[],used=new Set(),context=conflictContext({resolutions,prefix,conflicts,used,onConflict});
  const statistics={files_considered:0,hash_fast_paths:0,text_merges:0,native_merges:0,binary_conflicts:0,bytes_read:0};
  for(const path of [...new Set([...Object.keys(base),...Object.keys(source),...Object.keys(target)])].sort()){
    const b=base[path]??null,s=source[path]??null,t=target[path]??null;if(equal(s,b))continue;statistics.files_considered++;
    let result,method='hash';const start=conflicts.length,local='file/'+path;
    if(equal(t,b)||equal(s,t)){result=s;statistics.hash_fast_paths++;}
    else if(!b||!s||!t){
      method='file-conflict';const kind=!s||!t?'delete_modify':'add_add';
      const textValues=!binaryPath(path)?[b,s,t].map(entry=>{if(!entry)return null;const bytes=archive.read(entry);statistics.bytes_read+=bytes.length;return utf8(bytes);}):null;
      if(textValues&&[b,s,t].every((entry,index)=>!entry||textValues[index]!==null)){const value=context.choose(local,...textValues,{kind,path},true);result=value===null?null:archive.put(Buffer.from(value,'utf8'));}
      else result=context.choose(local,b,s,t,{kind,path},false);
    }
    else{
      const bytes=[b,s,t].map(entry=>archive.read(entry));statistics.bytes_read+=bytes.reduce((sum,bytes)=>sum+bytes.length,0);const texts=bytes.map(utf8);
      if(binaryPath(path)||texts.some(text=>text===null)){method='binary-conflict';statistics.binary_conflicts++;result=context.choose(local,b,s,t,{kind:'binary',path},false);}
      else{
        let text;const nativeText=/\.(tscn|tres)$/i.test(path);if(nativeText)text=mergeNativeStructured(...texts,{context,local,path});
        if(text!==null&&text!==undefined){method='native';statistics.native_merges++;}
        else if(nativeText){method='native-conflict';text=context.choose(local+'/unparsed',...texts,{kind:'native_unparsed',path,note:'原生结构不能无损识别，保留三份原件供明确解决'},true);}
        else{method='text';statistics.text_merges++;text=mergeNativeText(...texts,{context,local,path});}
        result=archive.put(Buffer.from(text,'utf8'));
      }
    }
    if(result===null)delete files[path];else files[path]=result;
    changes.push({key:local,path,base:b,source:s,target:t,result,method,conflict:conflicts.slice(start).some(item=>!item.resolved),conflict_keys:conflicts.slice(start).map(item=>item.key)});
  }
  const normalized=nativeFileMap(files);
  return {files:normalized,source_identity:nativeSourceIdentity(normalized),changes,conflicts,unresolved:conflicts.filter(item=>!item.resolved),used_resolutions:[...used],statistics};
}
