// Normalization and rejection checks for actual native observation wire names.
// This fixture does not stand in for the world stop/application ACK protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectionObjects} from '../../services/creation/inspection-objects.mjs';
const scope={project_id:'p',branch_id:'main',resource_id:'scene'};
const manifest={schema:'creation-native-1',source_identity:'fixed',index_source_identity:'fixed',resources:{scene:{path:'scene.tscn',version:'resource-version',native_nodes:[{addressable:true,node_id:'label',instance_ids:[],path:'.',type:'Label',name:'Label',metadata:{},properties:[],version:'node-version',key:'label'}]}}};
const observation={id:'label',address:{...scope,definition_node_id:'label',instance_path:[]},object_version:'node-version',source_identity:'fixed',dimension:'2d'};
const matrix=[0.8,0.6,-1.2,1.6,24,48];
test('canonical canvas observations and editor world observations preserve one full affine matrix',()=>{
 const canonical=inspectionObjects(manifest,scope,[{...observation,canvas_transform:matrix}])[0];
 const editor=inspectionObjects(manifest,scope,[{...observation,world_transform_2d:matrix}])[0];
 assert.deepEqual(canonical,editor);assert.deepEqual(canonical.world_transform_2d,matrix);assert.deepEqual(canonical.position,[24,48,0]);
 assert.deepEqual(canonical.native_world_transform,{$type:'Transform2D',x:[.8,.6],y:[-1.2,1.6],origin:[24,48]});
});
test('canvas alias retains dimension, source, full-address and matrix validation',()=>{
 for(const patch of [{object_version:'other'},{source_identity:'other'},{dimension:'3d'},{address:{...observation.address,resource_id:'other'}}])assert.throws(()=>inspectionObjects(manifest,scope,[{...observation,canvas_transform:matrix,...patch}]),e=>e.status===409);
 for(const invalid of [[],[1,0,0,1,NaN,0],[1,0,0,1,20000,0],[0,0,0,0,0,0]])assert.throws(()=>inspectionObjects(manifest,scope,[{...observation,canvas_transform:invalid}]));
 assert.throws(()=>inspectionObjects(manifest,scope,[{...observation,canvas_transform:matrix,world_transform_2d:[1,0,0,1,0,0]}]),e=>e.status===422);
});
