// FAKE UI/API asynchronous regressions. Runs actual extracted workspace handlers,
// with explicit DOM/transport substitutes; no browser/Godot/user acceptance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {matrix,multiply,identityTransform} from '../../packages/scene/transform.mjs';
import {localTransformFromEuler} from '../../apps/creation-workspace/hierarchy-editor.js';
const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const pure=source.split('// HIERARCHY_PURE_START\n')[1].split('// HIERARCHY_PURE_END')[0];
const {localEulerFields}=Function('matrix',`${pure};return {localEulerFields};`)(matrix);
const editBlock=source.slice(source.indexOf('function startLocalEdit(target){'),source.indexOf('\nlet lastDrag='));
const controlsBlock=source.slice(source.indexOf('function updateEditorControls(){'),source.indexOf('\nasync function createAnchor(){'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function keyEvent(key,extra={}){return {key,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...extra};}
class FakeInput {
 constructor(field,axis){this.dataset={transform:field,axis:String(axis)};this.disabled=false;this.valid=true;this.value='0';}
 get value(){return this.raw;}set value(v){this.raw=String(v);}
 setCustomValidity(message){this.valid=!message;}checkValidity(){return this.valid;}reportValidity(){this.reported=true;return this.valid;}
}
function harness({hierarchy=false,wait=Promise.resolve()}={}){
 const inputs=['position','rotation','scale'].flatMap(field=>[0,1,2].map(axis=>new FakeInput(field,axis))),calls=[],errors=[],messages=[];
 const initial={id:'node',version:'object-v1',name:'原对象',color:'#abcdef',solid:true,components:{kept:{answer:42}},position:[1,2,3],rotation:[10,20,30],scale:[1,2,3],...(hierarchy?{local_transform:localTransformFromEuler({position:[1,2,3],rotation_degrees:[10,20,30],scale:[1,2,3]})}:{})};
 const create=Function('inputs','initial','wait','calls','errors','messages','copy','localEulerFields','localTransformFromEuler','matrix','multiply','identityTransform',`
  let current=copy(initial),localEdit=null,localCommitPending=false,localCommit=null,selectedId=current.id,documentKey='p/main/scene',base='source-v1',writable=true,drag=null,branch={head:base};
  const key=()=>documentKey,editable=()=>writable,object=()=>current,trs=o=>({position:[...o.position],rotation:[...o.rotation],scale:[...o.scale]}),context=()=>({key:key(),base,schema:${hierarchy?"'creation-hierarchy-2'":"'flat'"}}),hierarchyTarget=()=>({parent_world_matrix:matrix(identityTransform())});
  const element={disabled:false,setAttribute(){},textContent:''},$=()=>element,$$=selector=>selector.includes('data-transform')?inputs:[],api={scoped:kind=>messages.push(kind)},syncHierarchyPreviews=()=>{},syncMainPreview=async()=>{},sendDragPreview=()=>{},updateSelection=()=>{},report=e=>errors.push(e),toast=text=>messages.push(text),hierarchyPanel=null,history=()=>({undo:[],redo:[]});let editorTool='move',editorSnap=false;
  async function patchObject(target,patch,label,ctx){calls.push({target:copy(target),patch:copy(patch),ctx:copy(ctx)});await wait;if(key()===ctx.key){current={...current,...(patch.transform?{local_transform:copy(patch.transform)}:copy(patch)),version:'object-v2'};base='source-v2';}}
  async function loadHierarchyDocument(){}
  function renderInspector(){const values=current.local_transform?localEulerFields(current.local_transform):trs(current);for(const i of inputs){i.value=values[i.dataset.transform][Number(i.dataset.axis)];i.disabled=!editable()||localCommitPending;i.setCustomValidity('');}bindTransformFields(current);}
  ${editBlock}\n${controlsBlock}
  renderInspector();return {finish:finishLocalEdit,controls:updateEditorControls,editing:()=>localEdit,pending:()=>localCommitPending,canonical:()=>copy(current),switchKey:k=>{documentKey=k;renderInspector();},setWritable:v=>writable=v};
 `);
 const h=create(inputs,initial,wait,calls,errors,messages,structuredClone,localEulerFields,localTransformFromEuler,matrix,multiply,identityTransform);return {...h,inputs,calls,errors,messages,initial};
}

test('FAKE fields: Enter submits once, preserves canonical until ACK, and later blur/change cannot duplicate',async()=>{
 for(const hierarchy of [false,true]){const wait=deferred(),h=harness({hierarchy,wait:wait.promise}),input=h.inputs[0],before=h.canonical();input.value='8.5';input.oninput();assert.deepEqual(h.canonical(),before);
  const event=keyEvent('Enter');input.onkeydown(event);assert.ok(event.defaultPrevented&&event.stopped);assert.equal(h.calls.length,1);assert.ok(h.pending());input.onchange();input.onblur();assert.equal(h.calls.length,1);
  wait.resolve();await tick();assert.equal(h.pending(),false);assert.equal(h.canonical().version,'object-v2');assert.deepEqual(h.canonical().components,before.components);assert.equal(h.canonical().solid,true);assert.equal(h.canonical().color,before.color);assert.equal(h.errors.length,0);
 }
});

test('FAKE fields: Escape cancels valid draft, restores all axes, and subsequent change/blur submits nothing',async()=>{
 for(const hierarchy of [false,true]){const h=harness({hierarchy}),before=h.canonical(),input=h.inputs[0];input.value='8.5';input.oninput();h.inputs[4].value='65';h.inputs[4].oninput();assert.ok(h.editing());const event=keyEvent('Escape');input.onkeydown(event);assert.ok(event.defaultPrevented&&event.stopped);assert.equal(h.editing(),null);assert.deepEqual(h.canonical(),before);
  input.onchange();input.onblur();await tick();assert.equal(h.calls.length,0);const values=hierarchy?localEulerFields(before.local_transform):before;for(const field of h.inputs)assert.ok(Math.abs(Number(field.value)-values[field.dataset.transform][Number(field.dataset.axis)])<1e-8);assert.equal(h.errors.length,0);
 }
});

test('FAKE fields: invalid or empty Enter cannot commit; Escape clears invalid draft without a mutation',async()=>{
 const h=harness(),input=h.inputs[0];input.value='4';input.oninput();input.value='100000';input.oninput();input.onkeydown(keyEvent('Enter'));assert.equal(h.calls.length,0);assert.equal(input.reported,true);
 input.onkeydown(keyEvent('Escape'));assert.equal(input.value,'1');assert.equal(input.valid,true);assert.equal(h.editing(),null);input.value='';input.oninput();input.onkeydown(keyEvent('Enter'));await tick();assert.equal(h.calls.length,0);
});

test('FAKE fields: source controls refresh cannot unlock inputs while commit awaits acknowledgement',async()=>{
 const wait=deferred(),h=harness({wait:wait.promise}),input=h.inputs[0];input.value='4';input.oninput();const pending=h.finish();h.controls();assert.ok(h.inputs.every(i=>i.disabled));h.inputs[1].value='10';h.inputs[1].oninput();assert.equal(h.editing(),null);assert.equal(h.calls.length,1);
 wait.resolve();await pending;assert.ok(h.inputs.every(i=>!i.disabled));
});

test('FAKE fields: old document ACK unlocks current resource without applying old draft there',async()=>{
 const wait=deferred(),h=harness({wait:wait.promise}),before=h.canonical(),input=h.inputs[0];input.value='4';input.oninput();const pending=h.finish();h.switchKey('p/main/other-scene');assert.ok(h.inputs.every(i=>i.disabled));wait.resolve();await pending;assert.ok(h.inputs.every(i=>!i.disabled));assert.deepEqual(h.canonical(),before);assert.equal(h.calls[0].ctx.key,'p/main/scene');
});

test('FAKE fields: stale keydown cannot submit or cancel another resource draft; composition does not submit',async()=>{
 const h=harness(),oldHandler=h.inputs[0].onkeydown;h.switchKey('p/main/new-scene');h.inputs[0].value='5';h.inputs[0].oninput();const draft=h.editing();oldHandler(keyEvent('Escape'));assert.equal(h.editing(),draft);oldHandler(keyEvent('Enter'));assert.equal(h.calls.length,0);
 const composition=keyEvent('Enter',{isComposing:true});h.inputs[0].onkeydown(composition);assert.equal(h.calls.length,0);assert.equal(composition.defaultPrevented,false);h.setWritable(false);h.inputs[0].onkeydown(keyEvent('Enter'));assert.equal(h.calls.length,0);
});

test('FAKE event bubbling: consumed numeric Escape cannot also close chat',()=>{
 const h=harness(),event=keyEvent('Escape');h.inputs[0].value='4';h.inputs[0].oninput();h.inputs[0].onkeydown(event);
 const body=source.split("document.addEventListener('keydown',e=>{\n")[1].split("\n});\ndocument.addEventListener('click'")[0];let closed=0;
 const document={querySelector:()=>null};const handler=Function('e','$','document','closeChat',body);handler(event,()=>({hidden:false}),document,()=>closed++);assert.equal(closed,0);assert.equal(h.calls.length,0);
});

test('FAKE source loader: an in-flight scene cannot reset a gizmo that started after loading began',async()=>{
 const block=source.slice(source.indexOf('async function syncMainPreview(){'),source.indexOf('\nasync function syncObjectPreview(){'));
 for(const boundary of ['drag','document','source']){const wait=deferred(),sent=[];
 const create=Function('wait','sent',`let sceneGeneration=0,documentKey='p/main/scene',branch={head:'source'},mode='edit',modePending=false,drag=null,development=[],selectedId='node',mainDocument=null,loadedSourceScene=null,editorTool='move',editorSnap=false;const key=()=>documentKey,doc=()=>({}),ensurePreviews=()=>{},withDevelopmentMetadata=s=>s,sourceScene=()=>wait,editable=()=>true,mainPreview={scene:async s=>sent.push(s),editor(){}},syncHierarchyPreviews=()=>{},$=()=>({textContent:''});${block};return {start:syncMainPreview,boundary:kind=>{if(kind==='drag')drag={id:'node'};if(kind==='document')documentKey='p/main/other';if(kind==='source')branch.head='new';}};`);
 const h=create(wait.promise,sent),loading=h.start();h.boundary(boundary);wait.resolve({hierarchy_pack:{},document_id:'p/main/scene',source_revision:'source'});await loading;assert.equal(sent.length,0,boundary+' must fence the late scene');}
});
