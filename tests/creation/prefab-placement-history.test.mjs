import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const pick=name=>{const start=source.indexOf('function '+name+'(');return source.slice(start,source.indexOf('\n}',start)+2);};
const node=(id,chain,version,overridden=true)=>({node_id:id,instance_ids:chain,version,properties:[{name:'position',stored_locally:true,overridden}]});
const manifest=version=>({resources:{scene:{native_nodes:[node('root',[],version),node('new',['inserted'],version),node('nested',['inserted','child'],'nested-'+version),node('untouched',['other'],'other'),node('inherits',['inserted'],version,false)]},other:{native_nodes:[node('outside',['inserted'],version)]}}});
function fixture(entry){
 const calls=[],h={undo:entry?[entry]:[],redo:[]};
 const sandbox={copy:structuredClone,editable:()=>true,context:()=>({base:'current',key:'scene'}),history:()=>h,uuid:()=> 'test-intent',updateEditorControls(){},
  transact:async(ops,options)=>{calls.push({ops,options});return {inverse:[{type:'restore_source_file',path:'scene.tscn'}],branch:{manifest:manifest('after-redo')}};}};
 const context=vm.createContext(sandbox);vm.runInContext(pick('creationUndoAcknowledgements')+'\nasync '+pick('applyHistory'),context);return {context,calls,h};
}
test('creation Undo acknowledges only the created subtree, with exact fixed versions and no other document scope',()=>{
 const {context}=fixture();const actual=structuredClone(context.creationUndoAcknowledgements(manifest('v1'),[{resource_id:'scene',instance_id:'inserted'}]));
 assert.deepEqual(actual,[{resource_id:'scene',target:{node_id:'new',instance_ids:['inserted']},expected_node_version:'v1'},{resource_id:'scene',target:{node_id:'nested',instance_ids:['inserted','child']},expected_node_version:'nested-v1'}]);
});
test('actual creation history sends one guarded Undo and restores fresh guard versions after Redo',async()=>{
 const createdInstances=[{resource_id:'scene',instance_id:'inserted'}],entry={ops:[{type:'restore_source_file',path:'scene.tscn',expected_hash:'placed'}],label:'预制件实例',createdInstances};
 const {context,calls,h}=fixture(entry);entry.discardRemoved=structuredClone(context.creationUndoAcknowledgements(manifest('placed'),createdInstances));
 await context.applyHistory('undo');assert.equal(calls.length,1);assert.deepEqual(calls[0].options.payload.discard_removed_overrides,entry.discardRemoved);assert.equal(calls[0].options.payload.base_revision,'current');assert.deepEqual(calls[0].options.payload.ops,entry.ops);assert.equal(h.undo.length,0);assert.equal(h.redo.length,1);assert.equal(h.redo[0].discardRemoved,undefined);
 await context.applyHistory('redo');assert.equal(calls[1].options.payload,null);assert.equal(h.undo[0].discardRemoved[0].expected_node_version,'after-redo');
});
test('failed Undo preserves its history entry and never retries a stale acknowledgement',async()=>{
 const entry={ops:[],label:'placed',discardRemoved:[{resource_id:'scene',target:{node_id:'new',instance_ids:['inserted']},expected_node_version:'old'}]};
 const {context,h}=fixture(entry);let calls=0;context.transact=async()=>{calls++;throw Object.assign(Error('changed'),{status:409});};
 await assert.rejects(context.applyHistory('undo'),/changed/);assert.equal(calls,1);assert.equal(h.undo[0],entry);assert.equal(h.redo.length,0);
});
