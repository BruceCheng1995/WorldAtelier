// Exercise the actual workspace request assembly; engine/store acknowledgements
// remain test doubles and real shared inspection is verified separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const implementation=source.slice(source.indexOf('async function attachCurrent(sid){'),source.indexOf('function showAttachment(a){'));
test('shared inspection attachment and camera use the actual frozen scene after a scene switch',async()=>{
 const scope={project_id:'p',branch_id:'main',resource_id:'second'},target={id:'root',version:'node-version',address:{...scope,definition_node_id:'root',instance_path:[]}},writes=[],cameraChecks=[];
 const sandbox={copy:structuredClone,object:()=>target,sessions:[{id:'session'}],ownSession:()=>true,attachmentWrites:new Map(),pendingTurnSubmissions:new Map(),mode:'inspect',modePending:false,
  context:()=>({projectId:'p',branchId:'main',resourceId:'entry',key:'p/main/entry',base:'newer-source',schema:'creation-native-1'}),selectedSessionId:'session',world:{native_shared:true,world_id:'world',epoch:2},worldState:{},frozenScene:{...scope,document_id:'p/main/second',scene_revision:'frozen-source'},mainPreview:{seq:8},annotationView:{camera:true},inspectionRecord:{inspection_id:'inspection',sequence:30,revision:'frozen-source'},
  fixedAnnotationCamera:(_view,ctx)=>{cameraChecks.push(ctx);return{position:[1,2,3],target:[0,0,0]};},sessionRoute:sid=>'sessions/'+sid,api:{api:async(route,input)=>{writes.push({route,...input});return{address:target.address};}},renderComposer(){},branchKey:()=> 'p/main',selectSession:async()=>{},openChat(){},toast(){}};
 vm.runInNewContext(implementation,sandbox);await sandbox.attachCurrent('session');
 assert.equal(writes[0].route,'sessions/session/inspection-attachments');const body=writes[0].body;
 assert.equal(body.resource_id,'second');assert.equal(body.world_id,'world');assert.equal(body.epoch,2);assert.equal(body.sequence,30);assert.deepEqual(body.address,target.address);assert.equal(body.expected_version,'node-version');
 assert.deepEqual({...cameraChecks[0]},{documentId:'p/main/second',seq:8,mode:'inspect',revision:'frozen-source'});assert.equal(sandbox.attachmentWrites.size,0);
});
