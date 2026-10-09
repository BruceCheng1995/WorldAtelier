// Production workspace functions with isolated context/API doubles. These
// protect snapshot/observation boundaries; they do not claim real Godot input.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {measureLegacyControl,nativeOperation} from '../../apps/creation-workspace/native-authoring.js';
const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const implementation=[between('function context(){','function hierarchyTarget('),between('function assertEditContext(','function sourcePatchOperations('),between('function measureLegacyControlViews(','async function onPreviewEvent('),between('async function transact(','async function patchObject(')].join('\n');
function fixture(){
 const manifest={schema:'creation-native-1',source_identity:'identity-1',resources:{scene:{version:'resource-1'}}},branch={head:'revision-1',branch_id:'main',manifest};
 const calls={documents:0,measure:0,clone:0,api:[],modals:[]},target={id:'control',dimension:'2d',version:'object-1',ancestry_hash:'ancestry-1',address:{project_id:'p',branch_id:'main',resource_id:'scene',definition_node_id:'control',instance_path:[]},native_target:{instance_ids:[],node_id:'control'},control_layout:{needs_measurement:true,values:{position:null,size:null}}};
 const sandbox={branch,project:{id:'p'},resourceId:'scene',mode:'edit',key:()=>`${sandbox.project.id}/${sandbox.branch.branch_id}/${sandbox.resourceId}`,isNative:()=>true,editable:()=>true,copy:value=>{calls.clone++;return structuredClone(value);},docObjects:()=>{calls.documents++;return [target];},measureLegacyControl:(...args)=>{calls.measure++;return measureLegacyControl(...args);},$:()=>({textContent:''}),uuid:()=> 'transaction-test',api:{api:async(...args)=>{calls.api.push(args);throw Error('API not configured');}},branchRoute:(p,b)=>`projects/${p}/branches/${b}`,pendingEdits:new Map(),errorText:e=>e.message,esc:String,modal:(...args)=>calls.modals.push(args),report:()=>{},acceptBranch:next=>{sandbox.branch=next;},short:String,updateEditorControls:()=>{}};
 vm.createContext(sandbox);vm.runInContext(implementation,sandbox);
 const observation={type:'transform',id:target.id,document_id:'p/main/scene',source_revision:'revision-1',source_identity:manifest.source_identity,object_version:target.version,dimension:'2d',ancestry_hash:target.ancestry_hash,address:target.address,native_target:target.native_target,local_transform:{position:[100,90,0],rotation:[0,0,0],scale:[1,1,1]},control_layout:{needs_measurement:false,values:{position:[100,90],size:[320,180]},viewport_size:[1024,768],parent_size:[400,300],minimum_size:[0,0]}};
 return {sandbox,calls,target,manifest,observation};
}
test('fixed edit context retains old resource identity after a collaborator replaces branch',()=>{
 const {sandbox:s,manifest,calls}=fixture(),ctx=s.context();assert.equal(ctx.manifest,manifest);assert.equal(calls.clone,0);
 s.branch={...s.branch,head:'revision-2',manifest:{...manifest,source_identity:'identity-2',resources:{scene:{version:'resource-2'}}}};
 assert.equal(ctx.base,'revision-1');assert.equal(ctx.manifest.source_identity,'identity-1');assert.equal(nativeOperation(ctx,{op:'test'}).expected_version,'resource-1');
 assert.equal(s.context().base,'revision-2');assert.equal(s.context().manifest.resources.scene.version,'resource-2');
 s.resourceId='other';assert.throws(()=>s.assertCurrentEdit(ctx),/编辑目标已经切换/);
});
test('stale source transaction keeps original guards and records rejection without replaying',async()=>{
 const {sandbox:s,manifest,calls}=fixture(),ctx=s.context(),next={...s.branch,head:'revision-2',manifest:{...manifest,resources:{scene:{version:'resource-2'}}}};s.branch=next;
 s.api.api=async(route,options)=>{calls.api.push([route,options]);if(options?.method==='POST')throw Object.assign(Error('源版本冲突'),{status:409});return next;};
 await assert.rejects(s.transact([nativeOperation(ctx,{op:'test'})],{ctx}),/源版本冲突/);
 const posts=calls.api.filter(([,options])=>options?.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0][1].body.base_revision,'revision-1');assert.equal(posts[0][1].body.ops[0].expected_version,'resource-1');assert.equal(s.branch.head,'revision-2');assert.equal(s.pendingEdits.size,1);assert.equal(calls.modals.length,1);
});
test('camera and unrelated native events never scan documents or clone manifest',()=>{
 const {sandbox:s,calls}=fixture();for(let i=0;i<100;i++)for(const type of ['camera','selected','editor_state','transform'])assert.equal(s.measureLegacyControlViews({type,document_id:'p/main/scene',id:'control'}),false);
 assert.equal(s.measureLegacyControlViews({type:'loaded',document_id:'p/main/scene',objects:[{id:'mesh'}]}),false);assert.equal(calls.documents,0);assert.equal(calls.measure,0);assert.equal(calls.clone,0);
});
test('matching Control measurement updates only resolved view once and preserves fixed source',()=>{
 const {sandbox:s,calls,target,manifest,observation}=fixture(),before=JSON.stringify(manifest);
 assert.equal(s.measureLegacyControlViews({...observation,source_revision:'old'}),false);assert.equal(target.control_layout.needs_measurement,true);
 assert.equal(s.measureLegacyControlViews({type:'loaded',document_id:'p/main/scene',objects:[observation]}),true);assert.deepEqual(target.control_layout.values.size,[320,180]);assert.equal(JSON.stringify(manifest),before);
 const measured=calls.measure;assert.equal(s.measureLegacyControlViews(observation),false);assert.equal(calls.measure,measured);assert.equal(calls.clone,0);
 assert.equal(s.measureLegacyControlViews({...observation,document_id:'other'}),false);
});
