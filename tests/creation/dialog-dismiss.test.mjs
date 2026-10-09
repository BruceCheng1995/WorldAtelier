// Pointer/focus behavior against production helpers/listeners; no browser or service.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {bindDialogDismiss} from '../../apps/creation-workspace/client-platform.js';

function target(extra={}){
  const listeners=new Map();
  return {addEventListener(type,handler){const rows=listeners.get(type)??[];rows.push(handler);listeners.set(type,rows);},
    emit(type,detail={}){const event={target:this,button:0,pointerId:1,clientX:50,clientY:50,prevented:false,stopped:false,
      preventDefault(){this.prevented=true;this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},stopImmediatePropagation(){this.stopped=true;},...detail};
      for(const handler of listeners.get(type)??[])handler(event);return event;},...extra};
}
function fixture(){
  let closed=0;
  const dialog=target({open:true,getBoundingClientRect:()=>({left:100,top:100,right:300,bottom:300})});
  bindDialogDismiss(dialog,()=>{closed++;dialog.open=false;dialog.emit('close');});
  return {dialog,closed:()=>closed,click:(details={})=>{dialog.emit('pointerdown',details);dialog.emit('pointerup',details);return dialog.emit('click',details);}};
}

test('a complete primary backdrop click dismisses exactly once and consumes the event',()=>{
  const f=fixture(),event=f.click();assert.equal(f.closed(),1);assert.equal(f.dialog.open,false);
  assert.equal(event.prevented,true);assert.equal(event.stopped,true);
  f.dialog.emit('click');assert.equal(f.closed(),1);
});

test('dialog padding, borders and child controls do not count as backdrop',()=>{
  for(const detail of [{clientX:150,clientY:150},{clientX:100,clientY:100},{clientX:300,clientY:300},{target:{},clientX:150,clientY:150},{target:{}}]){
    const f=fixture(),event=f.click(detail);assert.equal(f.closed(),0);assert.equal(event.prevented,false);
  }
});

test('dragging from inside to outside, outside to inside, or between pointer identities never dismisses',()=>{
  const inside={clientX:150,clientY:150},outside={clientX:50,clientY:50};
  for(const [down,up,click]of [[inside,outside,outside],[outside,inside,outside],[outside,outside,inside],[outside,{...outside,pointerId:2},outside]]){
    const f=fixture();f.dialog.emit('pointerdown',down);f.dialog.emit('pointerup',up);f.dialog.emit('click',click);assert.equal(f.closed(),0);
  }
});

test('right click, pointer cancellation and synthetic clicks cannot dismiss the dialog',()=>{
  const right=fixture();right.click({button:2});assert.equal(right.closed(),0);
  const cancelled=fixture();cancelled.dialog.emit('pointerdown');cancelled.dialog.emit('pointercancel');cancelled.dialog.emit('pointerup');cancelled.dialog.emit('click');assert.equal(cancelled.closed(),0);
  const keyboard=fixture();keyboard.dialog.emit('click',{detail:0});assert.equal(keyboard.closed(),0);
  const noRelease=fixture();noRelease.dialog.emit('pointerdown');noRelease.dialog.emit('click');assert.equal(noRelease.closed(),0);
});

test('closing and reopening clears an unfinished gesture, then accepts a new outside click',()=>{
  const f=fixture();f.dialog.emit('pointerdown');f.dialog.emit('pointerup');f.dialog.open=false;f.dialog.emit('close');f.dialog.open=true;
  f.dialog.emit('click');assert.equal(f.closed(),0);f.click();assert.equal(f.closed(),1);
  f.dialog.open=true;f.click();assert.equal(f.closed(),2);
});

test('closed dialogs ignore clicks and each dialog owns its own pointer sequence',()=>{
  const a=fixture(),b=fixture();a.dialog.open=false;a.click();assert.equal(a.closed(),0);
  a.dialog.open=true;a.dialog.emit('pointerdown');b.dialog.emit('pointerup');b.dialog.emit('click');assert.equal(b.closed(),0);
  a.dialog.emit('pointerup');a.dialog.emit('click');assert.equal(a.closed(),1);
});

const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
function menuFixture(){
  const document=target({activeElement:null}),window=target(),tasks=[],nodes=new Map(),closed=[];
  const element=(id='',className='')=>{const summary={focus(){document.activeElement=this;}};return {id,className,tagName:'DETAILS',open:true,summary,children:new Set([summary]),contains(value){return value===this||this.children.has(value);},querySelector:selector=>selector==='summary'?summary:null};};
  const menu=element(),trigger=element(),settings=element('chatSettings'),ai=element('','semantic-quick-actions'),prefab=element('','prefab-card-menu'),help=element('','composer-help'),bodySection=element('','semantic-section'),disclosures=[element(),element()];
  const lightMenus=[settings,ai,prefab,help],allDetails=[...lightMenus,bodySection,...disclosures];
  const select=selector=>allDetails.filter(node=>selector.split(',').some(value=>{
    const open=value.endsWith('[open]'),base=open?value.slice(0,-6):value;if(open&&!node.open)return false;
    return base==='details'||base.startsWith('#')&&node.id===base.slice(1)||base.startsWith('.')&&node.className.split(' ').includes(base.slice(1));
  }));
  const get=selector=>nodes.get(selector)??select(selector)[0]??null;
  nodes.set('#menu',menu);nodes.set('#chatSettings',settings);
  const guide=element(),guideTrigger=element();guide.hidden=true;guideTrigger.setAttribute=()=>{};guideTrigger.focus=()=>document.activeElement=guideTrigger;
  nodes.set('#interactionGuide',guide);nodes.set('#interactionHelp',guideTrigger);
  let modalOpen=false;document.querySelector=selector=>selector==='dialog[open]'?modalOpen?{}:null:get(selector);
  const context=vm.createContext({document,window,$:get,$$:select,topbarMenu:'menu',topbarTrigger:trigger,workspaceDisclosures:disclosures,
    setTimeout:handler=>tasks.push(handler),closeSessionPicker:()=>closed.push('sessions'),closeTopbarMenu:restore=>{closed.push(['topbar',restore]);context.topbarMenu=null;}});
  const lines=source.split('\n').filter(line=>line.startsWith("document.addEventListener('pointerdown',e=>{if(topbarMenu")
    ||line.startsWith("document.addEventListener('focusin',e=>{if(topbarMenu"));
  assert.equal(lines.length,2,'production topbar/focus listeners are present');
  const ranges=[
    ["function closeWorkspaceDisclosure(","\n$('#buildHistory')"],
    ["function closeInteractionGuide(","\n$('#interactionHelp').onclick"],
    ["for(const type of ['pointerdown','focusin'])document.addEventListener(type,e=>{\n  for(const menu","\n$('.composer-content')"],
    ["window.addEventListener('blur',()=>{","\n// Approved warm workbench:"]
  ].map(([from,to])=>{const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start);return source.slice(start,end);});
  vm.runInContext(lines.join('\n')+'\n'+ranges.join('\n'),context);
  return {context,document,window,menu,trigger,settings,lightMenus,bodySection,disclosures,guide,guideTrigger,closed,tasks,setModal:value=>modalOpen=value};
}

test('topbar stays open within its panel or trigger and closes on other banner/body pointer or focus targets',()=>{
  for(const type of ['pointerdown','focusin']){
    const f=menuFixture(),menuChild={},triggerChild={};f.menu.children.add(menuChild);f.trigger.children.add(triggerChild);
    for(const element of [f.menu,menuChild,f.trigger,triggerChild]){f.document.emit(type,{target:element});assert.equal(f.context.topbarMenu,'menu');}
    f.document.emit(type,{target:{region:'another banner control'}});assert.equal(f.context.topbarMenu,null);assert.deepEqual(f.closed,[['topbar',false]]);
  }
});

test('settings, AI, prefab and composer help menus stay open inside and close outside without folding body sections',()=>{
  for(const type of ['pointerdown','focusin'])for(const index of [0,1,2,3]){
    const f=menuFixture(),inside={},menu=f.lightMenus[index];menu.children.add(inside);f.document.emit(type,{target:inside});assert.equal(menu.open,true);
    f.document.emit(type,{target:{}});assert.equal(menu.open,false);assert.equal(f.bodySection.open,true);
  }
});

test('iframe focus closes lightweight menus without changing modal dialogs or reacting to ordinary app blur',()=>{
  for(const [tagName,modalOpen,expected]of [['IFRAME',false,true],['IFRAME',true,false],['BUTTON',false,false]]){
    const f=menuFixture();f.document.activeElement={tagName};f.setModal(modalOpen);f.window.emit('blur');
    assert.equal(f.closed.length,0,'wait for browser activeElement to settle');for(const run of f.tasks)run();
    if(expected){assert.deepEqual(f.closed,[['topbar',false],'sessions']);assert.ok(f.lightMenus.every(menu=>!menu.open));assert.ok(f.disclosures.every(menu=>!menu.open));}
    else{assert.deepEqual(f.closed,[]);assert.ok(f.lightMenus.every(menu=>menu.open));assert.ok(f.disclosures.every(menu=>menu.open));}
    assert.equal(f.bodySection.open,true);
  }
});

test('Escape dismisses each lightweight menu and restores its summary, while an open dialog takes priority',()=>{
  for(const index of [0,1,2,3])for(const modalOpen of [true,false]){
    const f=menuFixture(),menu=f.lightMenus[index];f.disclosures.forEach(node=>node.open=false);f.lightMenus.forEach(node=>node.open=node===menu);f.setModal(modalOpen);
    const event=f.document.emit('keydown',{key:'Escape'});
    assert.equal(menu.open,modalOpen);assert.equal(event.prevented,!modalOpen);assert.equal(f.bodySection.open,true);
    if(!modalOpen)assert.equal(f.document.activeElement,menu.summary);
  }
});

test('Escape closes the interaction guide first and returns focus to its trigger',()=>{
  const f=menuFixture();f.guide.hidden=false;const event=f.document.emit('keydown',{key:'Escape'});
  assert.equal(event.prevented,true);assert.equal(f.guide.hidden,true);assert.equal(f.document.activeElement,f.guideTrigger);
  assert.ok(f.lightMenus.every(menu=>menu.open));
});
