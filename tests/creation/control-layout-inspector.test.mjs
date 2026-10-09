import test from 'node:test';
import assert from 'node:assert/strict';import {build} from 'esbuild';import {chromium} from '@playwright/test';import path from 'node:path';
import {nativeControlOperation,nativePreviewRows,nativePatchOperations} from '../../apps/creation-workspace/native-authoring.js';
import {nativePreviewTransform} from '../../services/creation/native-reference.mjs';
test('Control Inspector uses native layout actions and honors container and read-only capabilities',async()=>{
const values={anchors:[0,0,0,0],offsets:[10,20,170,100],position:[10,20],size:[160,80],pivot_offset:[0,0],rotation_degrees:0,scale:[1,1],custom_minimum_size:[0,0],grow_horizontal:1,grow_vertical:1,size_flags_horizontal:1,size_flags_vertical:1,size_flags_stretch_ratio:1};
const object=(id,managed)=>({id,native_path:id,native_target:{node_id:id,instance_ids:[]},address:{project_id:'p',branch_id:'b',resource_id:'main',instance_path:[],definition_node_id:id},version:'v1',ancestry_hash:'a1',dimension:'2d',native_edit_transform:{position:[10,20,0],rotation:[0,0,0],scale:[1,1,1]},control_layout:{values:structuredClone(values),container_managed:managed,parent_type:managed?'HBoxContainer':'Control',viewport_size:[800,600],fields:Object.fromEntries(Object.keys(values).map(key=>[key,{editable:!managed||['custom_minimum_size','size_flags_horizontal','size_flags_vertical','size_flags_stretch_ratio'].includes(key),resettable:true,overridden:false}]))}});
const packet={document_schema:'creation-native-1',source_identity:'control-proof',source_revision:'r1',objects:[object('A/Child',false),object('Box/Item',true)]},target=packet.objects.find(x=>x.native_path==='A/Child'),ctx={base:'r1',resourceId:'main',manifest:{source_identity:'control-proof',resources:{main:{version:'rv1'}}}};
assert.equal(nativeControlOperation(target,{reset:['size']},ctx).expected_version,'rv1');
assert.equal(nativePatchOperations(target,{position:[2,3,0]},ctx)[0].operation.op,'control_layout');
const rows=nativePreviewRows(packet,[],{localEdit:{objectId:target.id,control:true,next:{size:[222,111]}}});assert.deepEqual(rows.active[0].control_layout,{size:[222,111]});assert.ok(rows.canonical.find(x=>x.id===target.id).control_layout.offsets);
const view={...target,ancestry_hash:'a1'};const value=Object.fromEntries(Object.entries(target.control_layout.values).filter(([key])=>!['position','size'].includes(key)));const message={dimension:'2d',native_target:target.native_target,expected_ancestry_hash:'a1',local_transform:target.native_edit_transform,control_layout:value};assert.deepEqual(nativePreviewTransform(view,message).control_layout,value);assert.throws(()=>nativePreviewTransform(view,{...message,control_layout:{...value,bogus:1}}));
const managed=packet.objects.find(x=>x.native_path==='Box/Item');assert.throws(()=>nativeControlOperation(managed,{value:{position:[1,2]}},ctx),/容器/);
const bundle=await build({stdin:{contents:`export * from './control-layout-inspector.js';`,resolveDir:path.resolve(import.meta.dirname,'../../apps/creation-workspace')},bundle:true,write:false,format:'iife',globalName:'ControlInspector'});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:460,height:1100}});await page.setContent('<div id="inspector"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(target=>{window.target=target;window.calls=[];window.errors=[];window.render=(readonly=false,value=target)=>{const host=document.querySelector('#inspector');host.replaceChildren();ControlInspector.renderControlLayoutInspector(host,value,{disabled:readonly,onPreview:value=>calls.push({type:'preview',value}),onCommit:value=>calls.push({type:'commit',value}),onCancel:()=>calls.push({type:'cancel'}),onError:error=>errors.push(error.message)});};render();},target);
 const width=page.locator('[data-control-field="size"][data-control-axis="0"]');await width.fill('222');assert.equal(await page.evaluate(()=>calls.at(-1).type),'preview');await width.press('Enter');await width.blur();assert.equal(await page.evaluate(()=>calls.filter(c=>c.type==='commit').length),1,'Enter then blur commits exactly once');assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.type==='commit').value),{value:{size:[222,target.control_layout.values.size[1]]}});
 await page.locator('[data-control-layout="offsets"] button').click();assert.deepEqual(await page.evaluate(()=>calls.at(-1).value),{reset:['offsets']});
 await page.locator('[data-control-preset]').selectOption('full_rect');assert.deepEqual(await page.evaluate(()=>calls.at(-1).value),{preset:'full_rect'});
 await page.evaluate(()=>render(true));assert.equal(await page.locator('#inspector input:enabled').count(),0);assert.equal(await page.locator('#inspector button:enabled').count(),0);
 await page.evaluate(managed=>render(false,managed),managed);assert.equal(await page.locator('[data-control-preset]').count(),0);assert.equal(await page.locator('[data-control-field="position"]:enabled').count(),0);assert.equal(await page.locator('[data-control-field="custom_minimum_size"]:enabled').count(),2);
 assert.deepEqual(await page.evaluate(()=>errors),[]);

}finally{await browser.close();}

});
