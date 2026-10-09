import {referenceParts,referenceToken,referenceIds,referenceName,referencePrefix,expandReferenceText} from '../../packages/contracts/authoring-references.mjs';
import {imageElement} from './image-attachments.js';
export {referenceParts,referenceToken,referenceIds,expandReferenceText};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const referenceKind=a=>a?.kind==='image'?'图片':a?.kind==='viewport_annotation'?'视口批注':a?.kind==='knowledge'?'知识':a?.kind==='prefab'?(a?.design?.category==='system'||a?.snapshot?.design?.category==='system'?'游戏系统':'预制件'):'场景对象';
export function referenceChip(a,{remove=false,disabled=false}={}){
  const name=referenceName(a),prefix=referencePrefix(a);
  if(a.kind==='image')return `<span class="reference-component image-reference" data-reference-id="${escape(a.id)}" contenteditable="false"><button type="button" class="reference-link" data-open-reference="${escape(a.id)}" aria-label="查看图片：${escape(name)}">${imageElement(a)}<span class="reference-name">${escape(name)}</span></button>${remove?`<button type="button" class="reference-remove" data-remove-reference="${escape(a.id)}" aria-label="移除图片：${escape(name)}" ${disabled?'disabled':''}>×</button>`:''}</span>`;
  return `<span class="reference-component" data-reference-id="${escape(a.id)}" contenteditable="false"><button type="button" class="reference-link" data-open-reference="${escape(a.id)}" aria-label="${escape(referenceKind(a)+'：'+name)}"><span class="reference-prefix" aria-hidden="true">${prefix}</span><span class="reference-name">${escape(name)}</span></button>${remove?`<button type="button" class="reference-remove" data-remove-reference="${escape(a.id)}" aria-label="移除引用：${escape(name)}" ${disabled?'disabled':''}>×</button>`:''}</span>`;
}
export function renderReferenceContent(text,attachments=[],renderText=escape){
  const byId=new Map(attachments.map(a=>[a.id,a]));let prefix='\uE000reference-';while(String(text).includes(prefix))prefix+='x';
  const chips=[];
  const source=referenceParts(text).map(p=>{
    if(!p.id||!byId.has(p.id))return p.text;
    const index=chips.push(referenceChip(byId.get(p.id)))-1;return prefix+index+'\uE001';
  }).join('');
  let html=renderText(source);chips.forEach((chip,i)=>{html=html.split(prefix+i+'\uE001').join(chip);});return html;
}

/** One accessible hover/focus preview shared by composer, conversation and history. */
export function createReferenceInteractions({document,getAttachment,onOpen,onRemove}){
  const popover=document.createElement('aside');popover.className='reference-preview';popover.hidden=true;popover.setAttribute('role','tooltip');popover.id='reference-preview';document.body.append(popover);
  let anchor=null,activeId=null,timer=null,leaveTimer=null;
  const resolve=element=>getAttachment(element?.dataset.openReference??element?.closest?.('[data-reference-id]')?.dataset.referenceId);
  function close(){clearTimeout(timer);clearTimeout(leaveTimer);anchor?.removeAttribute('aria-describedby');anchor=null;activeId=null;popover.hidden=true;}
  function position(){if(!anchor?.isConnected){close();return;}const r=anchor.getBoundingClientRect(),w=popover.offsetWidth,h=popover.offsetHeight;
    popover.style.left=Math.max(12,Math.min(r.left,document.defaultView.innerWidth-w-12))+'px';popover.style.top=(r.top>h+18?r.top-h-8:Math.min(r.bottom+8,document.defaultView.innerHeight-h-12))+'px';}
  function show(element){const a=resolve(element);if(!a)return;close();(element.closest('dialog[open]')??document.body).append(popover);anchor=element;activeId=a.id;
    const description=a.kind==='knowledge'?a.snapshot?.content:a.design?.description??a.snapshot?.design?.description??a.snapshot?.description;
    popover.innerHTML=`<div class="reference-preview-heading"><span class="reference-preview-icon">${referencePrefix(a)}</span><div><strong>${escape(referenceName(a))}</strong><small>${escape(referenceKind(a))}</small></div></div><p>${escape(description?.slice(0,360)||'已固定此引用的内容，可点击查看详情。')}</p><footer><span>${escape(a.branch_id??'')} · ${escape(String(a.revision??a.source_revision??'').slice(0,15))}</span><span>点击查看 ↗</span></footer>`;
    popover.hidden=false;anchor.setAttribute('aria-describedby',popover.id);position();}
  const enter=e=>{const element=e.target.closest?.('[data-open-reference]');if(!element)return;clearTimeout(leaveTimer);clearTimeout(timer);timer=setTimeout(()=>show(element),220);};
  const leave=e=>{if(e.relatedTarget&&popover.contains(e.relatedTarget))return;if(e.target.closest?.('[data-open-reference]')){clearTimeout(timer);leaveTimer=setTimeout(close,100);}};
  const focus=e=>{const element=e.target.closest?.('[data-open-reference]');if(element)show(element);};
  const click=e=>{const remove=e.target.closest?.('[data-remove-reference]'),open=e.target.closest?.('[data-open-reference]');if(!remove&&!open)return;
    const a=getAttachment((remove??open).dataset[remove?'removeReference':'openReference']);if(!a)return;
    e.preventDefault();e.stopPropagation();close();if(remove)onRemove?.(a,remove);else onOpen?.(a,open);};
  const key=e=>{if(e.key==='Escape')close();};
  document.addEventListener('pointerover',enter);document.addEventListener('pointerout',leave);document.addEventListener('focusin',focus);document.addEventListener('focusout',leave);document.addEventListener('click',click);document.addEventListener('keydown',key);document.addEventListener('scroll',close,true);
  popover.onpointerenter=()=>clearTimeout(leaveTimer);popover.onpointerleave=close;
  return {refresh(){if(activeId&&(!getAttachment(activeId)||!anchor?.isConnected||anchor.closest('dialog')?.open===false))close();},close,destroy(){close();popover.remove();document.removeEventListener('pointerover',enter);document.removeEventListener('pointerout',leave);document.removeEventListener('focusin',focus);document.removeEventListener('focusout',leave);document.removeEventListener('click',click);document.removeEventListener('keydown',key);document.removeEventListener('scroll',close,true);}};
}

/** Rich surface with the original textarea remaining the persistence/command contract. */
export function createReferenceEditor({textarea,getAttachments=()=>[],onChange}){
  const document=textarea.ownerDocument,win=document.defaultView,editor=document.createElement('div');
  editor.className='reference-editor';editor.contentEditable='true';editor.setAttribute('role','textbox');editor.setAttribute('aria-multiline','true');editor.setAttribute('aria-label','发送给选定会话的草稿');editor.dataset.placeholder=textarea.placeholder;editor.spellcheck=false;
  textarea.before(editor);textarea.hidden=true;textarea.setAttribute('aria-hidden','true');
  const valueDescriptor=Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype,'value');
  const nativeFocus=textarea.focus.bind(textarea),nativeRange=textarea.setSelectionRange.bind(textarea);
  let composing=false,syncing=false,rendered='',lastDisabled=null;
  const lookup=()=>new Map(getAttachments().map(a=>[a.id,a]));
  function read(node=editor){
    if(node.nodeType===3)return node.nodeValue;
    if(node.nodeType!==1)return '';
    if(node.dataset.referenceId)return referenceToken(node.dataset.referenceId);
    if(node.tagName==='BR')return '\n';
    const children=[...node.childNodes];return children.map((child,i)=>{
      const block=child.nodeType===1&&['DIV','P'].includes(child.tagName),before=i>0&&block&&!read(children[i-1]).endsWith('\n')?'\n':'';
      return before+read(child);
    }).join('');
  }
  function selectionOffset(node,offset){const range=document.createRange();range.selectNodeContents(editor);try{range.setEnd(node,offset);}catch{return textarea.value.length;}const holder=document.createElement('div');holder.append(range.cloneContents());return read(holder).length;}
  function syncSelection(){const s=win.getSelection();if(!s?.rangeCount||!editor.contains(s.anchorNode)||!editor.contains(s.focusNode))return;const a=selectionOffset(s.anchorNode,s.anchorOffset),b=selectionOffset(s.focusNode,s.focusOffset);nativeRange(Math.min(a,b),Math.max(a,b));}
  function atOffset(offset){let remaining=offset;const walk=node=>{
    for(const child of node.childNodes){
      if(child.nodeType===3){if(remaining<=child.length)return [child,remaining];remaining-=child.length;continue;}
      if(child.nodeType!==1)continue;
      const atomic=child.dataset.referenceId||child.tagName==='BR';
      if(atomic){const length=read(child).length,index=[...node.childNodes].indexOf(child);if(remaining<length)return [node,index];if(remaining===length)return [node,index+1];remaining-=length;continue;}
      const result=walk(child);if(result)return result;
    }
  };return walk(editor)??[editor,editor.childNodes.length];}
  function setRange(start,end=start){nativeRange(start,end);if(composing)return;const a=atOffset(start),b=atOffset(end),range=document.createRange();range.setStart(...a);range.setEnd(...b);const selection=win.getSelection();selection.removeAllRanges();selection.addRange(range);}
  function render(force=false){if(composing)return;const value=valueDescriptor.get.call(textarea),byId=lookup();
    const signature=JSON.stringify([value,[...byId].map(([id,a])=>[id,referenceName(a)])]);if(!force&&signature===rendered)return;
    const focused=editor===document.activeElement||editor.contains(document.activeElement);if(focused)syncSelection();const start=textarea.selectionStart,end=textarea.selectionEnd;
    editor.innerHTML=referenceParts(value).map(p=>p.id&&byId.has(p.id)?referenceChip(byId.get(p.id)):escape(p.text).replaceAll('\n','<br>')).join('');
    // A terminal text node makes the caret after a noneditable reference usable.
    if(!editor.lastChild||editor.lastChild.nodeType!==3)editor.append(document.createTextNode(''));
    rendered=signature;editor.dataset.empty=String(!value);if(focused)setRange(start,end);
  }
  function sync(){syncing=true;valueDescriptor.set.call(textarea,read());syncing=false;syncSelection();rendered=JSON.stringify([textarea.value,[...lookup()].map(([id,a])=>[id,referenceName(a)])]);editor.dataset.empty=String(!textarea.value);textarea.dispatchEvent(new win.Event('input',{bubbles:true}));onChange?.();}
  Object.defineProperty(textarea,'value',{configurable:true,get(){return valueDescriptor.get.call(this);},set(value){const old=valueDescriptor.get.call(this);valueDescriptor.set.call(this,value);if(!syncing&&old!==String(value)){rendered='';render();}}});
  textarea.focus=options=>editor.focus(options);textarea.setSelectionRange=setRange;
  const key=e=>{if(e.target!==editor)return;syncSelection();const proxy=new win.KeyboardEvent('keydown',{key:e.key,code:e.code,ctrlKey:e.ctrlKey,metaKey:e.metaKey,altKey:e.altKey,shiftKey:e.shiftKey,isComposing:e.isComposing||composing||e.keyCode===229,bubbles:true,cancelable:true});
    if(!textarea.dispatchEvent(proxy))e.preventDefault();};
  editor.addEventListener('keydown',key);editor.addEventListener('input',()=>{if(!composing)sync();});
  editor.addEventListener('keyup',e=>{syncSelection();textarea.dispatchEvent(new win.KeyboardEvent('keyup',{key:e.key,bubbles:true}));});
  editor.addEventListener('click',e=>{if(e.target.closest('[data-reference-id]'))return;syncSelection();textarea.dispatchEvent(new win.Event('click'));});
  editor.addEventListener('compositionstart',()=>{composing=true;textarea.dispatchEvent(new win.CompositionEvent('compositionstart'));});
  editor.addEventListener('compositionend',()=>{composing=false;sync();textarea.dispatchEvent(new win.CompositionEvent('compositionend'));});
  editor.addEventListener('paste',e=>{e.preventDefault();const source=e.clipboardData.getData('text/x-worldatelier-reference'),plain=e.clipboardData.getData('text/plain'),known=lookup();
    const rich=source&&referenceIds(source).every(id=>known.has(id))?source:null;
    const html=rich?renderReferenceContent(rich,getAttachments(),s=>escape(s).replaceAll('\n','<br>')):escape(plain).replaceAll('\n','<br>');
    document.execCommand('insertHTML',false,html);sync();});
  for(const name of ['copy','cut'])editor.addEventListener(name,e=>{const s=win.getSelection();if(!s?.rangeCount||s.isCollapsed)return;const box=document.createElement('div');box.append(s.getRangeAt(0).cloneContents());const text=read(box);e.preventDefault();e.clipboardData.setData('text/plain',expandReferenceText(text,getAttachments()));e.clipboardData.setData('text/x-worldatelier-reference',text);if(name==='cut'){document.execCommand('delete');sync();}});
  const attributes=['aria-controls','aria-expanded','aria-activedescendant','aria-autocomplete'];
  const observer=win.MutationObserver?new win.MutationObserver(()=>{for(const name of attributes){const value=textarea.getAttribute(name);if(value===null)editor.removeAttribute(name);else editor.setAttribute(name,value);}}):null;observer?.observe(textarea,{attributes:true,attributeFilter:attributes});
  render();
  return {element:editor,focused:()=>document.activeElement===editor||editor.contains(document.activeElement),refresh(){if(lastDisabled!==textarea.disabled){lastDisabled=textarea.disabled;editor.contentEditable=String(!lastDisabled);editor.setAttribute('aria-disabled',String(lastDisabled));}editor.dataset.placeholder=textarea.placeholder;render();},destroy(){observer?.disconnect();delete textarea.value;textarea.focus=nativeFocus;textarea.setSelectionRange=nativeRange;textarea.hidden=false;textarea.removeAttribute('aria-hidden');editor.remove();}};
}
