// Actual overlay helpers and bounded UI hosts. No browser, port, runtime or user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {positionFloatingPanel,bindDialogDismiss} from '../../apps/creation-workspace/client-platform.js';
import {createSemanticComposer} from '../../apps/creation-workspace/semantic-composer.js';

function section(source,from,to){const a=source.indexOf(from),b=source.indexOf(to,a+from.length);assert.ok(a>=0&&b>a,from);return source.slice(a,b);}
function positioned(rect,{width=250,height=150,viewWidth=1000,viewHeight=700,...options}={}){
  const panel={style:{},ownerDocument:{defaultView:{innerWidth:viewWidth,innerHeight:viewHeight}},getBoundingClientRect(){return {width:Math.min(width,parseFloat(this.style.maxWidth)),height:Math.min(height,parseFloat(this.style.maxHeight))};}};
  positionFloatingPanel(panel,{getBoundingClientRect:()=>rect},options);return panel.style;
}
test('floating panels align to either button edge, clamp horizontally and clear obsolete absolute offsets',()=>{
  assert.deepEqual({...positioned({left:400,right:440,top:80,bottom:110})},{position:'fixed',right:'auto',bottom:'auto',margin:'0',maxWidth:'976px',maxHeight:'570px',left:'190px',top:'118px'});
  assert.equal(positioned({left:400,right:440,top:80,bottom:110},{align:'start'}).left,'400px');
  assert.equal(positioned({left:0,right:40,top:80,bottom:110}).left,'12px');
  assert.equal(positioned({left:980,right:1020,top:80,bottom:110},{align:'start'}).left,'738px');
});
test('floating panels choose available vertical space and constrain oversized contents',()=>{
  const above=positioned({left:400,right:440,top:650,bottom:680});assert.equal(above.top,'492px');assert.equal(above.maxHeight,'630px');
  assert.equal(positioned({left:400,right:440,top:30,bottom:60},{above:true}).top,'68px');
  const huge=positioned({left:400,right:440,top:300,bottom:330},{height:1200,width:1400});
  assert.equal(huge.maxWidth,'976px');assert.equal(huge.left,'12px');assert.equal(huge.maxHeight,'350px');assert.equal(huge.top,'338px');
});

class FakeEvent {
  constructor(type,options={}){Object.assign(this,{type,defaultPrevented:false,button:0,pointerId:1,clientX:0,clientY:0},options);}
  preventDefault(){this.defaultPrevented=true;}stopPropagation(){}stopImmediatePropagation(){this.immediate=true;}
}
class Element {
  constructor(document,tag='div'){Object.assign(this,{ownerDocument:document,tagName:tag.toUpperCase(),children:[],listeners:new Map(),attributes:{},dataset:{},style:{},className:'',hidden:false,isConnected:true,value:'',selectionStart:0,selectionEnd:0});this.classList={add(){},remove(){}};}
  addEventListener(type,handler,options){const list=this.listeners.get(type)??[];list.push({handler,capture:options===true||options?.capture});this.listeners.set(type,list);}
  removeEventListener(type,handler){this.listeners.set(type,(this.listeners.get(type)??[]).filter(row=>row.handler!==handler));}
  dispatchEvent(event){event.target??=this;for(const {handler}of [...(this.listeners.get(event.type)??[])].sort((a,b)=>Number(b.capture)-Number(a.capture))){handler(event);if(event.immediate)break;}return !event.defaultPrevented;}
  emit(type,options){const event=new FakeEvent(type,options);this.dispatchEvent(event);return event;}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  insertBefore(node,before){node.parentElement=this;const i=this.children.indexOf(before);if(i<0)this.children.push(node);else this.children.splice(i,0,node);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  setAttribute(name,value){this.attributes[name]=String(value);}getAttribute(name){return this.attributes[name]??null;}removeAttribute(name){delete this.attributes[name];}
  focus(){this.ownerDocument.activeElement=this;this.ownerDocument.emit('focusin',{target:this});}
  setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
  getClientRects(){return this.hidden?[]:[{}];}getBoundingClientRect(){return{left:100,top:100,right:400,bottom:400};}
  remove(){this.isConnected=false;}
  showModal(){this.open=true;}close(){this.open=false;this.emit('close');}
}
function dom(){
  const document=new Element(null,'document');document.ownerDocument=document;document.createElement=tag=>new Element(document,tag);
  const tasks=[],view=new Element(document,'window');view.Event=FakeEvent;view.KeyboardEvent=FakeEvent;view.setTimeout=run=>tasks.push(run);document.defaultView=view;
  return{document,view,tasks,make:tag=>document.createElement(tag)};
}
function composer(){
  const f=dom(),mount=f.make(),textarea=f.make('textarea'),calls=[];mount.append(textarea);
  const component=createSemanticComposer({textarea,mount,getContext:()=>({key:'fixed-session',sessionId:'s1',objects:[{id:'box',name:'Box'}]}),onAddReference:async(selection,scope)=>{calls.push({selection,scope});return[{id:'box-ref'}];}});
  const chrome=mount.children[0],menu=chrome.children[2];
  return{...f,textarea,menu,calls,component,type:value=>{textarea.value=value;textarea.setSelectionRange(value.length,value.length);textarea.emit('input');}};
}
test('actual composer consumes candidate Tab through the rich-editor proxy before the host submit listener',async()=>{
  const f=composer(),editor=f.make();f.document.activeElement=editor;let submits=0;f.textarea.addEventListener('keydown',()=>submits++);
  const referenceSource=readFileSync(new URL('../../apps/creation-workspace/reference-components.js',import.meta.url),'utf8');
  const state=vm.createContext({editor,textarea:f.textarea,composing:false,syncSelection(){},win:f.view});
  vm.runInContext(section(referenceSource,'  const key=e=>{if(e.target!==editor)return;','\n  editor.addEventListener')+'\nhandle=key;',state);
  f.type('@');const event=new FakeEvent('keydown',{target:editor,key:'Tab',code:'Tab'});state.handle(event);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(event.defaultPrevented,true);assert.equal(submits,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].selection.item.id,'box');
  assert.equal(f.menu.hidden,true);assert.equal(f.document.activeElement,editor);assert.match(f.textarea.value,/\[\[ref:box-ref\]\]/);
  f.component.destroy();
});
test('Shift+Tab, empty candidates and IME preserve input semantics; focus leaving closes suggestions and aria state',()=>{
  for(const [value,options]of [['@',{key:'Tab',shiftKey:true}],['@missing',{key:'Tab'}],['@',{key:'Tab',isComposing:true}]]){
    const f=composer();f.textarea.focus();f.type(value);const event=f.textarea.emit('keydown',options);
    assert.equal(event.defaultPrevented,false);assert.equal(f.calls.length,0);assert.equal(f.menu.hidden,false);
    const outside=f.make('button');outside.focus();assert.equal(f.menu.hidden,true);assert.equal(f.textarea.getAttribute('aria-expanded'),'false');assert.equal(f.textarea.getAttribute('aria-activedescendant'),null);assert.equal(f.document.activeElement,outside);
    f.component.destroy();
  }
});
test('composer retains focus within a candidate, closes on iframe blur, and removes listeners on disposal',()=>{
  const f=composer();f.type('@');f.menu.children[1].children[0].focus();assert.equal(f.menu.hidden,false);
  f.document.activeElement=f.make('iframe');f.view.emit('blur');assert.equal(f.menu.hidden,false);f.tasks.splice(0).forEach(run=>run());assert.equal(f.menu.hidden,true);
  f.type('@');f.document.activeElement=f.textarea;f.view.emit('blur');f.tasks.splice(0).forEach(run=>run());assert.equal(f.menu.hidden,false);
  f.component.destroy();assert.ok([...f.document.listeners.values()].every(rows=>rows.length===0));assert.ok([...f.view.listeners.values()].every(rows=>rows.length===0));
});
function utility(){
  const f=dom(),dialog=f.make('dialog'),trigger=f.make('button');trigger.focus();
  const panels=Object.fromEntries(['library','scene','records','request'].map(key=>[key,f.make()])),prompt=f.make('textarea'),calls=[];
  const source=readFileSync(new URL('../../apps/creation-workspace/prefab-lab.js',import.meta.url),'utf8');
  const state=vm.createContext({document:f.document,dialog,panels,prompt,utility:null,utilityFeedback:f.make(),dialogTitle:f.make(),bindDialogDismiss,stopSpeech:()=>calls.push('speech-stop'),render:()=>calls.push('render')});
  vm.runInContext(section(source,'  let dialogFocus = null;','\n  const library =')+section(source,'  function openUtility(key) {','\n  function button('),state);
  return{...f,dialog,trigger,panels,prompt,calls,state};
}
test('actual prefab utility panels share backdrop dismissal, stop dictation and restore the opening trigger',()=>{
  const f=utility();for(const key of ['library','scene','records','request']){
    f.trigger.focus();f.state.openUtility(key);assert.equal(f.dialog.open,true);assert.equal(f.panels[key].hidden,false);
    assert.equal(Object.values(f.panels).filter(panel=>!panel.hidden).length,1);
    if(key==='request')assert.equal(f.document.activeElement,f.prompt);
    for(const type of ['pointerdown','pointerup','click'])f.dialog.emit(type);
    assert.equal(f.dialog.open,false);assert.equal(f.state.utility,null);assert.equal(f.document.activeElement,f.trigger);
  }
  assert.equal(f.calls.filter(value=>value==='speech-stop').length,4);
});
test('prefab utility redraw keeps its original trigger and close does not focus a detached trigger',()=>{
  const f=utility();f.state.openUtility('library');f.prompt.focus();f.state.openUtility('request');f.dialog.close();assert.equal(f.document.activeElement,f.trigger);
  f.state.openUtility('request');f.trigger.isConnected=false;f.dialog.close();assert.equal(f.document.activeElement,f.prompt);
});
