// Independent pure persisted-settings checks and explicitly FAKE iframe transport.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DEFAULT_DISPLAY,normalizeDisplay,readDisplay,displayKey} from '../../apps/creation-workspace/collaboration-client.js';
import {GodotPreview} from '../../apps/creation-workspace/preview-bridge.js';

test('display settings normalize types, finite numbers and exact supported boundaries',()=>{
  assert.equal(DEFAULT_DISPLAY.width,4);assert.equal(DEFAULT_DISPLAY.show_agents,true);
  for(const value of [null,undefined,[],{width:'2',opacity:NaN,show_selections:'false',show_cameras:0}])assert.deepEqual(normalizeDisplay(value),DEFAULT_DISPLAY);
  assert.deepEqual(normalizeDisplay({width:-4,opacity:5,show_selections:false,show_cameras:false}),{width:.5,opacity:1,show_selections:false,show_cameras:false,show_agents:true});
  assert.deepEqual(normalizeDisplay({width:99,opacity:-1}),{width:8,opacity:0,show_selections:true,show_cameras:true,show_agents:true});
  assert.deepEqual(normalizeDisplay({width:Infinity,opacity:-Infinity}),DEFAULT_DISPLAY);
  const source={width:8,opacity:.25,show_selections:false,show_cameras:true,extra:'ignored'},snapshot=structuredClone(source);
  assert.deepEqual(normalizeDisplay(source),{width:8,opacity:.25,show_selections:false,show_cameras:true,show_agents:true});assert.deepEqual(source,snapshot);
});


test('Agent visibility accepts only booleans and remains independent of human visibility',()=>{
  for(const show_agents of [true,false])for(const show_selections of [true,false])for(const show_cameras of [true,false]){
    const source={show_agents,show_selections,show_cameras,width:2,opacity:.4},snapshot=structuredClone(source);
    assert.deepEqual(normalizeDisplay(source),source);assert.deepEqual(source,snapshot);
  }
  for(const show_agents of [undefined,null,'false','true',0,1,[],{},NaN]){
    assert.deepEqual(normalizeDisplay({show_agents,show_selections:false}),{...DEFAULT_DISPLAY,show_selections:false,show_agents:true});
  }
  assert.deepEqual(normalizeDisplay({show_selections:false,show_cameras:false,width:2,opacity:.4}),{show_selections:false,show_cameras:false,show_agents:true,width:2,opacity:.4});
});

test('persisted Agent visibility round-trips false without changing legacy keys or other accounts',()=>{
  assert.equal(displayKey('user-a'),'world-atelier-viewport-display-v1:user-a');
  const saved=new Map(),storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
  for(const show_agents of [false,true]){
    const preferences={...DEFAULT_DISPLAY,show_agents,show_selections:false,width:6};
    storage.setItem(displayKey('user-a'),JSON.stringify(preferences));
    assert.deepEqual(readDisplay(storage,'user-a'),preferences);
    assert.deepEqual(readDisplay(storage,'user-b'),DEFAULT_DISPLAY);
  }
  storage.setItem(displayKey('user-a'),JSON.stringify({show_agents:'false',show_cameras:false}));
  assert.deepEqual(readDisplay(storage,'user-a'),{...DEFAULT_DISPLAY,show_cameras:false});
});

test('persisted display settings are isolated by user UUID and tolerate corrupt or unavailable storage',()=>{
  const saved=new Map([[displayKey('user-a'),JSON.stringify({show_cameras:false,width:3})],[displayKey('user-b'),JSON.stringify({show_selections:false,opacity:.2})]]),storage={getItem:key=>saved.get(key)??null};
  assert.notEqual(displayKey('user-a'),displayKey('user-b'));
  assert.deepEqual(readDisplay(storage,'user-a'),{show_selections:true,show_cameras:false,show_agents:true,width:3,opacity:.85});
  assert.deepEqual(readDisplay(storage,'user-b'),{show_selections:false,show_cameras:true,show_agents:true,width:4,opacity:.2});
  assert.deepEqual(readDisplay(storage,'user-c'),DEFAULT_DISPLAY);
  saved.set(displayKey('user-a'),'{broken');assert.deepEqual(readDisplay(storage,'user-a'),DEFAULT_DISPLAY);
  assert.deepEqual(readDisplay({getItem(){throw Error('unavailable');}},'user-a'),DEFAULT_DISPLAY);
});

test('actual workspace storage listener refreshes only the currently signed-in account',()=>{
  const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
  const statement=source.split('\n').find(line=>line.startsWith("window.addEventListener('storage'"));assert.ok(statement);
  let listener,applied=0,saved={width:3,show_agents:false,show_selections:true};const state={user:{id:'user-a'},viewportDisplay:{...DEFAULT_DISPLAY},displayKey,readDisplay,localStorage:{getItem:()=>JSON.stringify(saved)},applyViewportDisplay:()=>applied++,window:{addEventListener:(type,fn)=>{assert.equal(type,'storage');listener=fn;}}};
  vm.runInNewContext(statement,state);listener({key:displayKey('user-b')});assert.equal(applied,0);
  listener({key:displayKey('user-a')});assert.equal(applied,1);assert.equal(state.viewportDisplay.width,3);assert.equal(state.viewportDisplay.show_agents,false);assert.equal(state.viewportDisplay.show_selections,true);
  saved={width:5,show_agents:true,show_selections:false};listener({key:displayKey('user-a')});assert.equal(applied,2);assert.equal(state.viewportDisplay.show_agents,true);assert.equal(state.viewportDisplay.show_selections,false);
  saved={width:2};listener({key:displayKey('user-a')});assert.equal(applied,3);assert.equal(state.viewportDisplay.show_agents,true);
  state.user=null;listener({key:displayKey('user-a')});assert.equal(applied,3);
});

test('actual workspace Agent control persists and updates every preview without other controls re-enabling it',()=>{
  const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
  const apply=source.match(/function applyViewportDisplay\(\)\{[\s\S]*?\n\}/)?.[0];
  const inputs=source.match(/for\(const id of \['showPeerSelections'[^\n]*\n[\s\S]*?\n\}\);/)?.[0];
  assert.ok(apply);assert.ok(inputs);
  const elements=new Map(),saved=new Map(),received=[[],[],[]];
  const element=id=>{if(!elements.has(id))elements.set(id,{checked:false,value:0,textContent:'',addEventListener(type,fn){assert.equal(type,'input');this.input=fn;}});return elements.get(id);};
  const state={user:{id:'user-a'},viewportDisplay:{...DEFAULT_DISPLAY},displayKey,normalizeDisplay,$:element,localStorage:{setItem:(key,value)=>saved.set(key,value)},...Object.fromEntries(['mainPreview','editorPreview','objectPreview'].map((key,i)=>[key,{display:value=>received[i].push(structuredClone(value))}]))};
  vm.runInNewContext(apply+'\n'+inputs+'\napplyViewportDisplay();',state);
  assert.equal(element('#showAgentOutlines').checked,true);
  element('#showAgentOutlines').checked=false;element('#showAgentOutlines').input();
  assert.equal(JSON.parse(saved.get(displayKey('user-a'))).show_agents,false);
  for(const id of ['#showPeerSelections','#showPeerCameras','#outlineWidth','#outlineOpacity']){
    element(id).input();assert.equal(state.viewportDisplay.show_agents,false);
    assert.equal(JSON.parse(saved.get(displayKey('user-a'))).show_agents,false);
    for(const packets of received)assert.equal(packets.at(-1).show_agents,false);
  }
  element('#showPeerSelections').checked=false;element('#showPeerSelections').input();
  element('#showAgentOutlines').checked=true;element('#showAgentOutlines').input();
  assert.equal(state.viewportDisplay.show_selections,false);
  for(const packets of received){assert.equal(packets.at(-1).show_agents,true);assert.equal(packets.at(-1).show_selections,false);}
  state.localStorage.setItem=()=>{throw Error('quota exceeded');};
  element('#showAgentOutlines').checked=false;assert.doesNotThrow(()=>element('#showAgentOutlines').input());
  for(const packets of received)assert.equal(packets.at(-1).show_agents,false);
});

const origin='http://fake-display.invalid',savedGlobals={};
before(()=>{for(const [name,value]of Object.entries({location:{origin},window:{removeEventListener(){}}})){savedGlobals[name]=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,configurable:true});}});
after(()=>{for(const [name,descriptor]of Object.entries(savedGlobals))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];});
function bridgeFixture(t){
  const sent=[],sender={postMessage:packet=>sent.push(structuredClone(packet))},bridge=Object.create(GodotPreview.prototype);
  Object.assign(bridge,{seq:0,loadedSeq:0,ready:false,nonce:'fake-display',status:{remove(){}},host:{dataset:{}},frame:{contentWindow:sender,remove(){}},worldQueue:new Map(),onEvent(){}});
  const receive=packet=>bridge.receive({origin,source:sender,data:{source:'world-atelier-preview',nonce:'fake-display',...packet}});
  const loaded=extra=>receive({type:'loaded',seq:bridge.seq,document_id:bridge.sceneContext.document_id,selected_id:'',...extra});
  t.after(()=>bridge.dispose());return {bridge,sent,receive,loaded,settings:()=>sent.filter(packet=>packet.type==='display_settings')};
}
const scene=document_id=>({document_id,source_revision:'v1',scene_revision:'v1',selected_id:'',objects:[]});

test('display preferences queue the newest value, replay after exact scene load and persist through document reload',async t=>{
  const f=bridgeFixture(t);f.bridge.display({...DEFAULT_DISPLAY,width:2});
  const pending=f.bridge.scene(scene('project/main/room'));f.bridge.display({...DEFAULT_DISPLAY,width:3,show_cameras:false,show_agents:false});assert.equal(f.sent.length,0);
  f.receive({type:'ready'});assert.equal(f.settings().length,0);f.loaded({seq:0});assert.equal(f.settings().length,0);
  f.loaded({document_id:'wrong'});assert.equal(f.settings().length,0);f.loaded();await pending;
  assert.equal(f.settings().length,1);assert.equal(f.settings()[0].settings.width,3);assert.equal(f.settings()[0].settings.show_agents,false);assert.equal(f.settings()[0].document_id,'project/main/room');
  const second=f.bridge.scene(scene('project/main/other'));f.bridge.display({...DEFAULT_DISPLAY,opacity:.3,show_agents:false});assert.equal(f.settings().length,1);
  f.loaded();await second;assert.equal(f.settings().length,2);assert.equal(f.settings()[1].seq,2);assert.equal(f.settings()[1].settings.opacity,.3);assert.equal(f.settings()[1].settings.show_agents,false);assert.equal(f.settings()[1].document_id,'project/main/other');
  const third=f.bridge.scene(scene('project/main/other'),{force:true});f.loaded();await third;
  assert.equal(f.settings().at(-1).seq,3);assert.equal(f.settings().at(-1).settings.opacity,.3);assert.equal(f.settings().at(-1).settings.show_agents,false);
  f.bridge.dispose();const count=f.sent.length;f.bridge.display(DEFAULT_DISPLAY);assert.equal(f.sent.length,count);
});


test('Agent toggle updates a loaded bridge immediately and snapshots the settings payload',async t=>{
  const f=bridgeFixture(t),pending=f.bridge.scene(scene('project/main/room'));
  f.receive({type:'ready'});f.loaded();await pending;
  const settings={...DEFAULT_DISPLAY,show_agents:false,show_selections:true};
  f.bridge.display(settings);settings.show_agents=true;
  assert.equal(f.settings().at(-1).settings.show_agents,false);
  assert.equal(f.bridge.pendingDisplay.show_agents,false);
  assert.equal(f.settings().at(-1).settings.show_selections,true);
  f.bridge.display({...DEFAULT_DISPLAY,show_agents:true,show_selections:false});
  assert.equal(f.settings().length,2);
  assert.equal(f.settings().at(-1).settings.show_agents,true);
  assert.equal(f.settings().at(-1).settings.show_selections,false);
  const reload=f.bridge.scene(scene('project/main/room'),{force:true});f.loaded();await reload;
  assert.equal(f.settings().at(-1).settings.show_agents,true);
  assert.equal(f.settings().at(-1).settings.show_selections,false);
});
