import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mergeContent,validateContent} from '../services/control-plane/content.mjs';
import {Storage} from '../services/control-plane/storage.mjs';

test('independent edits to stable scene objects merge without discarding additions',()=>{
  const b={objects:[{id:'gate',x:1,color:'red'},{id:'tree',x:2}]};
  const l={objects:[{id:'gate',x:5,color:'red'},{id:'tree',x:2},{id:'new',x:10}]};
  const r={objects:[{id:'tree',x:3},{id:'gate',x:1,color:'blue'}]};
  const merged=mergeContent(b,l,r);assert.deepEqual(merged.conflicts,[]);assert.deepEqual(merged.content.objects.find(x=>x.id==='gate'),{id:'gate',x:5,color:'blue'});assert.equal(merged.content.objects.find(x=>x.id==='tree').x,3);assert.ok(merged.content.objects.find(x=>x.id==='new'));
});
test('delete versus edit preserves remote data and reports semantic conflict',()=>{
  const b={objects:[{id:'gate',x:1}]},l={objects:[]},r={objects:[{id:'gate',x:4}]};const merged=mergeContent(b,l,r);assert.equal(merged.conflicts[0].path,'/objects/gate');assert.equal(merged.content.objects[0].x,4);assert.equal(l.objects.length,0);
});
test('simultaneous differing property changes conflict rather than overwrite',()=>{
  const m=mergeContent({objects:[{id:'gate',x:1}]},{objects:[{id:'gate',x:2}]},{objects:[{id:'gate',x:3}]});assert.equal(m.conflicts[0].path,'/objects/gate/x');assert.equal(m.content.objects[0].x,3);
});
test('unsafe keys, duplicate IDs and nonfinite data cannot enter content storage',()=>{
  const valid={schema:1,spawn:{x:0,z:0},rules:{},zones:[],objects:[],enemies:[],quests:[]};assert.throws(()=>validateContent({...valid,objects:[{id:'a'},{id:'a'}]}));assert.throws(()=>validateContent({...valid,spawn:{x:Infinity,z:0}}));assert.throws(()=>validateContent({...valid,extra:JSON.parse('{"__proto__":{}}')}));
});
test('durable state survives reopen and failed transaction restores previous revision',()=>{
  const dir=mkdtempSync(join(tmpdir(),'atelier-store-')),file=join(dir,'state.sqlite');let db=new Storage(file);
  try {db.put('world',{id:'one',sequence:9,state:{reward:50}});assert.throws(()=>db.transaction(()=>{db.put('world',{id:'one',sequence:10,state:{reward:0}});throw Error('failure');}));db.close();db=new Storage(file);assert.deepEqual(db.get('world','one'),{id:'one',sequence:9,state:{reward:50}});}finally{db.close();rmSync(dir,{recursive:true});}
});

 test('bridge source must contain the dimensions required by actual rendering',()=>{
 const valid={schema:1,spawn:{x:0,z:0},rules:{},zones:[],objects:[{id:'bridge',kind:'bridge',length:24,width:8}],enemies:[],quests:[]};
 assert.equal(validateContent(valid),valid);
 for(const key of ['length','width']) for(const value of [undefined,null,'8',0,-1,161]) {
   const candidate=structuredClone(valid); if(value===undefined) delete candidate.objects[0][key]; else candidate.objects[0][key]=value;
   assert.throws(()=>validateContent(candidate),/Bridge bridge requires/);
 }
});
