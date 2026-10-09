// FAKE HTTP/source responses and iframe ACKs, exercising the actual workspace
// submit/load/camera functions plus the real bridge. No browser or Godot runtime.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GodotPreview} from '../../apps/creation-workspace/preview-bridge.js';
const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8'),origin='http://fake-camera.invalid';
const finishBlock=source.slice(source.indexOf('async function finishLocalEdit(){'),source.indexOf('\nfunction cancelLocalEdit(){'));
const syncBlock=source.slice(source.indexOf('async function syncMainPreview(){'),source.indexOf('\nasync function syncObjectPreview(){'));
const cameraBlock=source.slice(source.indexOf('function invalidateMainCamera(){'),source.indexOf('\nconst previewExpiryTimer='));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});promise.catch(()=>{});return {promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));let oldLocation;
before(()=>{oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{value:{origin},configurable:true});});
after(()=>{if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else delete globalThis.location;});
function harness(t){
 const commit=deferred(),read=deferred(),sent=[],errors=[],sender={postMessage:p=>sent.push(structuredClone(p))},bridge=Object.create(GodotPreview.prototype);
 Object.assign(bridge,{seq:1,loadedSeq:1,ready:true,key:'old-loaded',nonce:'fake',status:{},host:{dataset:{}},frame:{contentWindow:sender},worldQueue:new Map(),sceneContext:{document_id:'p/main/scene',source_revision:'old',selected_id:'node',preview_object_id:null},onEvent(){}});
 t.after(()=>bridge.reject(new Error('FAKE cleanup')));
 const create=Function('commit','read','mainPreview','errors',`
  let localEdit=null,localCommitPending=false,localCommit=null,cameraIntentSerial=0,sceneGeneration=0,documentKey='p/main/scene',selectedId='node',branch={head:'old'},mode='edit',modePending=false,drag=null,development=[],mainDocument=documentKey,editorTool='move',editorSnap=false;
  let loadedSourceScene={document_id:documentKey,source_revision:'old',selected_id:'node',hierarchy_pack:{}};
  const target={id:'node',position:[1,2,3],rotation:[0,0,0],scale:[1,1,1]},project={role:'editor'},isNative=()=>false,selectedSemanticObjects=()=>[target],syncNativePreviews=()=>{},short=s=>s,key=()=>documentKey,doc=()=>({}),api={scoped(){}},trs=o=>structuredClone({position:o.position,rotation:o.rotation,scale:o.scale}),$$=()=>[],updateEditorControls=()=>{},renderInspector=()=>{},loadHierarchyDocument=async()=>{},syncHierarchyPreviews=()=>{},report=e=>errors.push(e),ensurePreviews=()=>{},editable=()=>true,withDevelopmentMetadata=s=>structuredClone(s),sourceScene=()=>read.promise,$=()=>({textContent:''});
  const patchObject=async()=>{const result=await commit.promise;branch.head='new';return result;};
  ${finishBlock}\n${syncBlock}\n${cameraBlock}
  return {camera:requestMainCamera,save:()=>{localEdit={ctx:{key:key()},target,objectId:target.id,next:{position:[9,2,3],rotation:[0,0,0],scale:[1,1,1]}};return finishLocalEdit();},sourceAhead:()=>branch.head='new',switchAwayAndBack:kind=>{invalidateMainCamera();if(kind==='selection'){selectedId='other';selectedId='node';}else if(kind==='mode'){mode='play';mode='edit';}else{documentKey='p/other/scene';documentKey='p/main/scene';}},setDrag:()=>drag={},pending:()=>localCommitPending};
 `);
 const h=create(commit,read,bridge,errors),scene={document_id:'p/main/scene',source_revision:'new',scene_revision:'new',selected_id:'node',hierarchy_pack:{},objects:[]};
 return {...h,commit,read,sent,errors,scene,bridge,cameras:()=>sent.filter(p=>p.type==='camera'),ack:()=>bridge.receive({origin,source:sender,data:{source:'world-atelier-preview',nonce:'fake',type:'loaded',seq:bridge.seq,document_id:'p/main/scene',selected_id:'node'}})};
}

test('FAKE full ordering: Enter save -> camera intent -> HTTP ACK -> source response -> loaded ACK -> focus new pose',async t=>{
 const h=harness(t),save=h.save(),focus=h.camera('focus');assert.ok(h.pending());assert.equal(h.cameras().length,0);assert.equal(h.sent.length,0);
 h.commit.resolve({revision:'new'});await save;await tick();assert.equal(h.pending(),false);assert.equal(h.cameras().length,0,'old loaded renderer cannot consume F while new source HTTP waits');
 h.read.resolve(h.scene);await tick();assert.equal(h.sent.filter(p=>p.type==='scene').length,1);assert.equal(h.cameras().length,0,'camera still waits for the new scene ACK');
 h.ack();assert.equal(await focus,true);assert.equal(h.cameras().length,1);assert.equal(h.cameras()[0].seq,2);assert.equal(h.bridge.sceneContext.source_revision,'new');assert.equal(h.cameras()[0].selected_id,'node');
});

test('FAKE full ordering: latest action wins during source read, including after local commit has already completed',async t=>{
 const h=harness(t),save=h.save();h.commit.resolve({revision:'new'});await save;const first=h.camera('focus'),second=h.camera('top'),last=h.camera('fit');assert.equal(h.cameras().length,0);
 h.read.resolve(h.scene);await tick();h.ack();assert.deepEqual(await Promise.all([first,second,last]),[false,false,true]);assert.deepEqual(h.cameras().map(p=>p.action),['fit']);
});

test('FAKE full ordering: an already finished commit with only source HTTP pending cannot focus the old frame',async t=>{
 const h=harness(t);h.sourceAhead();const focus=h.camera('focus');await tick();assert.equal(h.cameras().length,0);h.read.resolve(h.scene);await tick();assert.equal(h.cameras().length,0);h.ack();assert.equal(await focus,true);
});

test('FAKE full ordering: document/selection/mode ABA boundaries cancel earlier camera intent',async t=>{
 for(const kind of ['document','selection','mode']){const h=harness(t),save=h.save(),focus=h.camera('focus');h.switchAwayAndBack(kind);h.commit.resolve({revision:'new'});await save;h.read.resolve(h.scene);await tick();if(h.bridge.pending)h.ack();assert.equal(await focus,false);assert.equal(h.cameras().length,0);}
});

test('FAKE full ordering: failed commit or source load never fires a delayed focus',async t=>{
 for(const failure of ['commit','source']){const h=harness(t),save=h.save(),saveResult=save.catch(()=>{}),focus=h.camera('focus');if(failure==='commit')h.commit.reject(new Error('FAKE commit rejected'));else h.commit.resolve({revision:'new'});await saveResult;h.read.reject(new Error('FAKE source failed'));await tick();assert.equal(await focus,false);assert.equal(h.cameras().length,0);assert.ok(h.errors.length>0);}
});

test('FAKE full ordering: scene rejection and a newly started gizmo both prevent camera delivery',async t=>{
 for(const failure of ['scene','drag']){const h=harness(t);h.sourceAhead();const focus=h.camera('focus');if(failure==='drag')h.setDrag();h.read.resolve(h.scene);await tick();if(failure==='scene')h.bridge.reject(new Error('FAKE scene rejected'));assert.equal(await focus,false);assert.equal(h.cameras().length,0);}
});

test('main viewport camera entry points all use the guarded wrapper; object preview keeps its independent bridge',()=>{
 assert.match(source,/focusView'\)\.onclick=\(\)=>requestMainCamera\('focus'\)/);assert.match(source,/resetView'\)\.onclick=\(\)=>requestMainCamera\('fit'\)/);assert.match(source,/cameraView'\)\.onchange=e=>requestMainCamera/);assert.match(source,/if\(k==='f'\).*requestMainCamera\(e.shiftKey\?'fit':'focus'\)/);
 const selection=source.slice(source.indexOf('function selectObject('),source.indexOf('\nfunction ',source.indexOf('function selectObject(')+1));
 const leave=source.slice(source.indexOf('function leaveWorld(){'),source.indexOf('\nfunction ',source.indexOf('function leaveWorld(){')+1));
 assert.match(selection,/if\(id!==selectedId\)invalidateMainCamera\(\)/);assert.match(leave,/invalidateMainCamera\(\)/);assert.match(source,/async function setMode\(next\)\{[^]*?invalidateMainCamera\(\)/);
});
