import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const implementation=source.slice(source.indexOf('function selectObject(id,'),source.indexOf('function disposeHierarchyPanel(){'));
function fixture(){
 const events=[],inspector={scrollTop:120},context=vm.createContext({selectedId:'old',selectionIntent:1,localEdit:null,mode:'edit',semanticSelection:{},inspectorTab:'collaboration',
  $:selector=>selector==='.inspector'?inspector:null,
  selectedSemanticObjects(){},docObjects:()=>[{id:'button'}],viewedDocumentKey:()=> 'project/main/scene',nextSemanticSelection:(_previous,id)=>({primary:id,ids:[id]}),invalidateMainCamera(){},
  mainPreview:{select:id=>events.push(['engine-select',id])},renderExplorer:()=>events.push(['explorer']),renderStage:options=>events.push(['stage',options.syncPreview]),renderInspector:()=>events.push(['inspector']),sendPresence:()=>events.push(['presence'])});
 vm.runInContext(implementation,context);return{context,events};
}
test('engine pointer selection updates authoring UI without echoing commands that cancel its active drag',()=>{
 const f=fixture();f.context.selectObject('button',{fromPreview:true});
 assert.equal(f.context.selectedId,'button');assert.equal(f.context.inspectorTab,'object');assert.deepEqual(f.events,[['explorer'],['stage',false],['inspector'],['presence']]);
});
test('object-list selection still commands the engine and synchronizes the selected document',()=>{
 const f=fixture();f.context.selectObject('button');assert.deepEqual(f.events,[['engine-select','button'],['explorer'],['stage',true],['inspector'],['presence']]);
});
