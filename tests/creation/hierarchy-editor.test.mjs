// Pure contract/operation tests; panel uses a tiny FAKE DOM (no browser claim).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fullAddressKey,lookupResolvedRow,captureTransformTarget,buildWorldTransformCommit,withWorldPosition,localTransformFromEuler } from '../../apps/creation-workspace/hierarchy-editor.js';
import { HierarchyPrefabPanel } from '../../apps/creation-workspace/hierarchy-prefabs.js';
import { identityTransform,matrix,multiply,quaternionFromEulerDegrees } from '../../packages/scene/transform.mjs';
import { HIERARCHY_SCHEMA,emptyDocument,prepareManifest,resolveScene } from '../../services/creation/hierarchy.mjs';
import { applyHierarchyOps } from '../../services/creation/hierarchy-operations.mjs';
import { nativeObjects,resolveNativeObject } from '../../services/creation/native-reference.mjs';
const scope={project_id:'p',branch_id:'main',resource_id:'scene'},copy=structuredClone;
const trs=(p=[0,0,0],r=[0,0,0],s=[1,1,1])=>({position:p,rotation:quaternionFromEulerDegrees(r),scale:s});
const node=(id,parent='root',transform=identityTransform())=>({id,name:id,kind:'anchor',parent_id:parent,transform,solid:false,color:'#74d5cd',components:{}});
function fixture(){
  const scene=emptyDocument('scene'),house=emptyDocument('house','prefab'),sign=emptyDocument('sign','prefab');
  scene.nodes.parent=node('parent','root',trs([1,3,0],[0,0,0],[2,1,1]));scene.nodes.child=node('child','parent',trs([0,2,0],[0,45,0]));sign.nodes.marker=node('marker');
  let manifest=prepareManifest({schema:HIERARCHY_SCHEMA,entry_scene_id:'scene',resources:{scene,house,sign},prefab_revisions:{}},()=>true);
  const mount=(instance_id,prefab)=>({instance_id,prefab_id:prefab,prefab_revision:manifest.resources[prefab].version,parent_id:'root',transform:identityTransform(),overrides:[]});
  manifest.resources.house.instances.nested=mount('nested','sign');manifest=prepareManifest(manifest,()=>true);
  manifest.resources.scene.instances.left=mount('left','house');manifest.resources.scene.instances.right=mount('right','house');manifest=prepareManifest(manifest,()=>true);
  const branch={project_id:'p',branch_id:'main',head:'src-original',manifest},rows=resolveScene(manifest,'scene',scope);
  return{branch,rows,manifest};
}
const at=(rows,path,id)=>lookupResolvedRow(rows,{...scope,instance_path:path,definition_node_id:id});
const near=(a,b)=>a.forEach((x,i)=>assert.ok(Math.abs(x-b[i])<1e-7,`${i}: ${x} != ${b[i]}`));
test('complete address key separates branches, documents, and same-name nested nodes; lookup never falls back',()=>{
  const{rows}=fixture(),left=at(rows,['left','nested'],'marker'),right=at(rows,['right','nested'],'marker');assert.notEqual(fullAddressKey(left.address),fullAddressKey(right.address));
  for(const change of [{branch_id:'other'},{resource_id:'house'}])assert.notEqual(fullAddressKey(left.address),fullAddressKey({...left.address,...change}));
  assert.equal(lookupResolvedRow(rows,{...left.address,instance_path:['missing','nested']}),null);assert.throws(()=>lookupResolvedRow([...rows,left],left.address),/duplicate/);assert.throws(()=>fullAddressKey({instance_path:[],definition_node_id:'marker'}),/invalid_address/);
});
test('native engine rows with opaque prefab identities can populate the explorer and resolve exactly',()=>{
  const nodes=['left/instance','right/instance'].map((instance,i)=>({path:'Tower'+i,node_id:'prefab-tower-machine_gun/Head/SingleBarrel',instance_ids:[instance],name:'SingleBarrel',type:'Node',addressable:true,version:'node-v1',properties:[],metadata:{}}));
  const manifest={schema:'creation-native-1',source_identity:'fixed',index_source_identity:'fixed',resources:{scene:{id:'scene',path:'scenes/main.tscn',version:'v1',native_nodes:nodes}}};
  const rows=nativeObjects(manifest,scope),byAddress=new Map(rows.map(row=>[fullAddressKey(row.address),row]));
  assert.equal(byAddress.size,2);
  for(const row of rows){assert.equal(lookupResolvedRow(rows,row.address),row);assert.equal(resolveNativeObject(manifest,scope,row.address,null,rows),row);}
  assert.notEqual(fullAddressKey(rows[0].address),fullAddressKey({...rows[0].address,definition_node_id:nodes[0].node_id.replaceAll('/','_')}));
});
test('shared read-only address keys retain native bounds, scope validation and opaque identity without normalization',()=>{
  const value={...scope,instance_path:Array.from({length:128},(_,i)=>'实例/'+i),definition_node_id:'部件/'+('x'.repeat(1021))};
  assert.doesNotThrow(()=>fullAddressKey(value));
  for(const bad of ['',null,1,'x'.repeat(1025),'line\nbreak','nul\0id','del\x7f']){
    assert.throws(()=>fullAddressKey({...value,definition_node_id:bad}),/invalid_address/);
    assert.throws(()=>fullAddressKey({...value,instance_path:[bad]}),/invalid_address/);
  }
  assert.throws(()=>fullAddressKey({...value,instance_path:[...value.instance_path,'extra']}),/invalid_address/);
  assert.throws(()=>fullAddressKey({...value,project_id:'project/other'}),/invalid_address/);
  assert.throws(()=>fullAddressKey({...value,resource_id:'__proto__'}),/invalid_address/);
  assert.notEqual(fullAddressKey({...value,instance_path:['a/b','c']}),fullAddressKey({...value,instance_path:['a','b/c']}));
});
test('native-compatible read keys do not widen H2 mutation identity or depth rules',()=>{
  const{branch,rows}=fixture(),row=at(rows,[],'child'),captured=captureTransformTarget({scope,branch,row});
  for(const changed of [{...row.address,definition_node_id:'prefab/child'},{...row.address,instance_path:Array(33).fill('instance') }]){
    assert.doesNotThrow(()=>fullAddressKey(changed));
    assert.throws(()=>captureTransformTarget({scope,branch,row:{...row,address:changed}}),/invalid_address/);
    assert.throws(()=>buildWorldTransformCommit({...captured,address:changed},captured.world_matrix),/invalid_address/);
  }
});
test('gizmo move preserves all sheared basis values and ordinary node+ancestry guard; real pure operation applies exactly',()=>{
  const{branch,rows}=fixture(),row=at(rows,[],'child');assert.equal(row.world_transform,null);
  const captured=captureTransformTarget({scope,branch,row}),desired=withWorldPosition(captured.world_matrix,[8,9,10]);const payload=buildWorldTransformCommit(captured,desired,{transactionId:'tx'});
  const op=payload.ops[0];assert.equal(op.type,'set_node_world_transform');assert.equal(op.expected_version,row.node.version);assert.equal(op.expected_ancestry_hash,row.ancestry_hash);assert.equal(payload.base_revision,'src-original');assert.equal(op.world_transform,undefined);assert.deepEqual(desired.slice(0,12),row.world_matrix.slice(0,12));
  const next=applyHierarchyOps(branch.manifest,payload.ops,()=>true).manifest;near(at(resolveScene(next,'scene',scope),[],'child').world_matrix,desired);
  row.world_matrix[0]=999;branch.head='later';assert.notEqual(captured.world_matrix[0],999);assert.equal(captured.base_revision,'src-original');assert.ok(Object.isFrozen(captured.world_matrix));
});
test('nested gizmo submits outer instance version, effective object version, ancestry and complete relative path',()=>{
  const{branch,rows}=fixture(),row=at(rows,['left','nested'],'marker'),captured=captureTransformTarget({scope,branch,row});
  const desired=withWorldPosition(captured.world_matrix,[5,6,7]),payload=buildWorldTransformCommit(captured,desired),op=payload.ops[0];
  assert.equal(op.type,'set_override_world_transform');assert.equal(op.instance_id,'left');assert.equal(op.expected_version,branch.manifest.resources.scene.instances.left.version);assert.equal(op.expected_object_version,row.object_version);assert.equal(op.expected_ancestry_hash,row.ancestry_hash);assert.deepEqual(op.target,{instance_path:['nested'],definition_node_id:'marker'});
  const next=applyHierarchyOps(branch.manifest,payload.ops,()=>true).manifest,nextRows=resolveScene(next,'scene',scope);near(at(nextRows,['left','nested'],'marker').world_matrix,desired);near(at(nextRows,['right','nested'],'marker').world_matrix,at(rows,['right','nested'],'marker').world_matrix);
});
test('stale ancestor and stale nested instance guards reject instead of silently rebasing',()=>{
  const{branch,rows}=fixture(),row=at(rows,[],'child'),captured=captureTransformTarget({scope,branch,row}),payload=buildWorldTransformCommit(captured,withWorldPosition(row.world_matrix,[4,5,6]));
  const changed=applyHierarchyOps(branch.manifest,[{type:'patch_node',resource_id:'scene',node_id:'parent',expected_version:branch.manifest.resources.scene.nodes.parent.version,patch:{transform:trs([2,3,0],[0,0,0],[2,1,1])}}],()=>true).manifest;
  assert.throws(()=>applyHierarchyOps(changed,payload.ops,()=>true),/祖先/);
  const nested=at(rows,['left','nested'],'marker'),newBranch=copy(branch);newBranch.manifest=applyHierarchyOps(branch.manifest,[{type:'patch_instance',resource_id:'scene',instance_id:'left',expected_version:branch.manifest.resources.scene.instances.left.version,patch:{transform:trs([3,0,0])}}],()=>true).manifest;const stale=captureTransformTarget({scope,branch:newBranch,row:nested});assert.throws(()=>applyHierarchyOps(newBranch.manifest,buildWorldTransformCommit(stale,nested.world_matrix).ops,()=>true),/目标已变化/);
});
test('capture and commit reject read-only, observed domain, wrong scope and incomplete matrices',()=>{
  const{branch,rows}=fixture(),row=at(rows,[],'child'),captured=captureTransformTarget({scope,branch,row});
  assert.throws(()=>captureTransformTarget({scope,branch,row,readOnly:true}),e=>e.status===403);assert.throws(()=>buildWorldTransformCommit(captured,row.world_matrix,{readOnly:true}),e=>e.status===403);
  assert.throws(()=>captureTransformTarget({scope,branch,row:{...row,domain:'frozen'}}),/source_hierarchy_required/);assert.throws(()=>captureTransformTarget({scope:{...scope,branch_id:'other'},branch,row}),/scope/);
  assert.throws(()=>buildWorldTransformCommit(captured,{position:[1,2,3],rotation:[0,0,0],scale:[1,1,1]}),/world_matrix/);
});
test('local degree editor uses actual YXZ quaternion product, retaining XYZ position/scale',()=>{
  const value=localTransformFromEuler({position:[1,2,3],rotation_degrees:[20,40,60],scale:[2,3,4]});
  const rx=matrix(trs([0,0,0],[20,0,0])),ry=matrix(trs([0,0,0],[0,40,0])),rz=matrix(trs([0,0,0],[0,0,60]));near(matrix({...value,position:[0,0,0],scale:[1,1,1]}),multiply(multiply(ry,rx),rz));assert.deepEqual(value.position,[1,2,3]);assert.deepEqual(value.scale,[2,3,4]);assert.throws(()=>localTransformFromEuler({position:[0,0,0],rotation_degrees:[NaN,0,0],scale:[1,1,1]}),/euler/);
});

// Minimal event/attribute tree: tests rendering choices/guards, not browser UX.
class FakeNode {
  constructor(tag){this.tag=tag;this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.dataset={};this.style={};this.events=new Map();this.disabled=false;this.ownText='';this.classList={add:(...names)=>{this.className=[...new Set([...(this.className??'').split(' ').filter(Boolean),...names])].join(' ');}};}
  set textContent(t){this.ownText=String(t);this.children=[];}get textContent(){return this.ownText+this.children.map(c=>c.textContent).join('');}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(k,v){this.attrs[k]=String(v);}addEventListener(k,f){this.events.set(k,f);}
  attachShadow(){return this.shadowRoot=new FakeNode('shadow');}
  querySelectorAll(selector){const selectors=selector.split(','),out=[];const visit=n=>{for(const c of n.children){if(selectors.some(s=>s.startsWith('[')?c.attrs.role===s.slice(6,-1):c.tag===s))out.push(c);visit(c);}};visit(this);return out;}
  querySelector(s){return this.querySelectorAll(s)[0]??null;}
}
const fakeDocument={createElement:tag=>new FakeNode(tag),createTextNode:t=>{const n=new FakeNode('text');n.textContent=t;return n;}};
function panelFixture(options={}){const f=fixture(),host=new FakeNode('host'),calls={select:0,transact:0};const panel=new HierarchyPrefabPanel(host,{read:async()=>f.branch,resolve:async()=>f.rows,transact:async()=>{calls.transact++;return{};},onSelect:()=>calls.select++},options);return{...f,panel,host,calls};}
test('FAKE DOM: inspector/catalog/impact mount separately; external selection does not notify or loop',async t=>{
  const previous=globalThis.document;globalThis.document=fakeDocument;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  for(const region of ['inspector','catalog','impact']){
    const{panel,rows,calls}=panelFixture({regions:[region]});await panel.setContext(scope);const row=at(rows,[],'child');panel.setSelection(row.address);panel.setImpact({source_revision:'src-original',direct:[],nested:[]});
    const titles=panel.root.querySelectorAll('h3').map(n=>n.textContent);assert.equal(titles.includes('场景层级'),false);assert.equal(titles.includes('全部预制件（含未摆放）'),region==='catalog');assert.equal(titles.includes('定义更新影响'),region==='impact');assert.equal(titles.includes('节点局部变换'),region==='inspector');assert.equal(titles.includes('child'),false);assert.equal(calls.select,0);
    if(region==='inspector'){
      const axes=panel.root.querySelectorAll('input').filter(n=>n.type==='number');assert.equal(axes.length,9);
      assert.deepEqual(axes.map(n=>n.attrs['aria-label']),['X 坐标','Y 坐标','Z 坐标','X 旋转','Y 旋转','Z 旋转','X 缩放','Y 缩放','Z 缩放']);
      assert.ok(axes.every(n=>n.required));assert.equal(axes[1].value,'2');assert.equal(panel.root.querySelectorAll('input').some(n=>n.type==='color'),false);
    }
    panel.hooks.onSelect=address=>{calls.select++;panel.setSelection(address);};panel.select(at(rows,['left','nested'],'marker').address);assert.equal(calls.select,1);assert.throws(()=>panel.setSelection({...row.address,branch_id:'other'}),/作用域/);panel.destroy();
  }
});
test('FAKE DOM: readonly blocks run callbacks, direct submit, and form controls but permits tree navigation',async t=>{
  const previous=globalThis.document;globalThis.document=fakeDocument;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});const{panel,rows,calls}=panelFixture({readOnly:true});await panel.setContext(scope);panel.setSelection(at(rows,[],'child').address);
  let actions=0;await panel.run(()=>actions++);await assert.rejects(panel.submit([]),e=>e.status===403);assert.equal(actions,0);assert.equal(calls.transact,0);
  for(const b of panel.root.querySelectorAll('button'))assert.equal(b.disabled,b.dataset.readOnlyAllowed!=='true');assert.ok(panel.root.querySelectorAll('input').every(i=>i.disabled));
  panel.setReadOnly(false);let proceed;const pause=new Promise(r=>proceed=r);const pending=panel.run(async()=>{await pause;return panel.submit([]);});panel.setReadOnly(true);proceed();await pending;assert.equal(calls.transact,0);assert.ok(panel.root.querySelectorAll('input').every(i=>i.disabled));
});
