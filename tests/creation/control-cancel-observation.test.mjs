import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {nativeControlObservation,nativeMatchesEvent} from '../../apps/creation-workspace/native-authoring.js';

// Execute the real workspace Inspector/cancel/transform handlers. Observations
// are explicit event-boundary fixtures, not a simulated Godot load or save ACK.
const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const between=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
 const target={id:'panel',type:'Control',version:'node-version',dimension:'2d',ancestry_hash:'ancestry',native_target:{node_id:'panel',instance_ids:[]},address:{project_id:'p',branch_id:'main',resource_id:'scene',instance_path:[],definition_node_id:'panel'},control_layout:{values:{position:[0,0],size:[1000,700]},fields:{size:{editable:true}},viewport_size:[1000,700]}};
 const ctx={key:'p/main/scene',base:'source-revision',manifest:{source_identity:'source-identity'}},transform={position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]};
 const observation={id:target.id,source_revision:ctx.base,source_identity:ctx.manifest.source_identity,object_version:target.version,dimension:'2d',ancestry_hash:target.ancestry_hash,address:target.address,native_target:target.native_target,position:[0,0,0],local_transform:transform,control_layout:{needs_measurement:false,values:{position:[0,0],size:[600,400]},viewport_size:[600,400]}};
 const renders=[],resets=[],events=[],host={innerHTML:''};
 const context=vm.createContext({structuredClone,copy:structuredClone,project:{id:'p',role:'owner'},branch:{head:ctx.base},mode:'edit',selectedId:'panel',localEdit:null,drag:null,controlObservation:structuredClone(observation),mainPreview:{lastLoadedEvent:{objects:[structuredClone(observation)]}},localCommitPending:false,nativeControlObservation,nativeMatchesEvent,
   object:()=>target,docObjects:()=>[target],context:()=>ctx,key:()=>ctx.key,editable:()=>true,nativeTransformFields:()=>transform,disposeHierarchyPanel(){},$:()=>host,$$:()=>[],fmt:String,
   renderControlLayoutInspector(_host,shown,options){renders.push(structuredClone(shown));context.options=options;},
   syncNativePreviews:reset=>resets.push(reset),syncHierarchyPreviews(){},syncMainPreview:async()=>{},updateControlLayoutInputs(){},sendNativeDragPreview(){},updateSelection(){},api:{scoped:value=>events.push(value)},report:error=>{throw error;},transact:()=>{throw Error('cancel must not submit a source transaction');},assertCurrentEdit(){},
 });
 vm.runInContext(between('function renderNativeInspector(){','function renderInspectorContent(){')+'\n'+between('function cancelLocalEdit(){','let lastDrag=')+'\n'+between('async function handleNativeTransform(message){','async function syncMainPreview(){')+'\nfunction renderInspector(){renderNativeInspector();}',context);
 return{target,ctx,observation,context,renders,resets,events,render:()=>vm.runInContext('renderNativeInspector()',context)};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('Inspector Esc retains pre-edit actual viewport measurement across repeated previews and rerender',()=>{
 const f=fixture(),before=JSON.stringify(f.target);f.render();assert.deepEqual(plain(f.renders.at(-1).control_layout.values.size),[600,400]);
 f.context.options.onPreview({size:[900,550]});
 f.context.controlObservation={...structuredClone(f.observation),control_layout:{...structuredClone(f.observation.control_layout),values:{position:[0,0],size:[900,550]}}};
 f.render();f.context.options.onPreview({size:[910,560]});
 assert.deepEqual(plain(f.context.localEdit.controlBefore.control_layout.values.size),[600,400]);
 f.context.options.onCancel();
 assert.equal(f.context.localEdit,null);assert.deepEqual(plain(f.renders.at(-1).control_layout.values.size),[600,400]);assert.deepEqual(plain(f.renders.at(-1).control_layout.viewport_size),[600,400]);
 assert.equal(f.resets.at(-1),true);assert.equal(f.events.at(-1),'drag_end');assert.equal(JSON.stringify(f.target),before);
});

test('Inspector opened from object list uses actual loaded measurement, not design-canvas geometry',()=>{
 const f=fixture();f.context.controlObservation=null;f.render();f.context.options.onPreview({size:[800,500]});f.context.options.onCancel();
 assert.deepEqual(plain(f.renders.at(-1).control_layout.values.size),[600,400]);assert.deepEqual(plain(f.context.controlObservation.control_layout.viewport_size),[600,400]);
});

test('gizmo cancel uses the returned actual restored layout and drops the transient rectangle',async()=>{
 const f=fixture(),run=message=>{f.context.message=message;return vm.runInContext('handleNativeTransform(message)',f.context);};
 await run({...structuredClone(f.observation),phase:'start'});
 await run({...structuredClone(f.observation),phase:'preview',control_layout:{...structuredClone(f.observation.control_layout),values:{position:[0,0],size:[900,550]}}});
 const restored={...structuredClone(f.observation),phase:'cancel',control_layout:{...structuredClone(f.observation.control_layout),values:{position:[0,0],size:[610,410]},viewport_size:[610,410]}};
 await run(restored);
 assert.equal(f.context.drag,null);assert.deepEqual(plain(f.context.controlObservation.control_layout.values.size),[610,410]);assert.deepEqual(plain(f.renders.at(-1).control_layout.viewport_size),[610,410]);assert.equal(f.resets.at(-1),true);
});

test('stored pre-edit observations cannot restore another source version or object',()=>{
 const f=fixture();
 for(const patch of [{source_revision:'old'},{source_identity:'old'},{object_version:'old'},{ancestry_hash:'old'},{id:'another'}])assert.equal(nativeControlObservation(f.target,f.ctx,{...f.observation,...patch}),null);
 assert.equal(nativeControlObservation(f.target,f.ctx,{...f.observation,control_layout:{...f.observation.control_layout,needs_measurement:true}}),null);
});
