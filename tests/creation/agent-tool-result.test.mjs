/** Isolated payload regression. No service, executor, game or paid model starts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {encodeAgentToolResult,replayAgentToolResult,MAX_AGENT_TOOL_RESULT_BYTES} from '../../services/creation/agent-tool-result.mjs';

const fixture=t=>{
  const cwd=mkdtempSync(resolve(tmpdir(),'atelier-tool-result-'));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));return cwd;
};

test('small tool results preserve the exact structured payload',t=>{
  const cwd=fixture(t),value={revision:'revision-1',committed:true,resource:{id:'scene',version:'v2'},text:'中文😀\n"quoted"\\'};
  const result=encodeAgentToolResult({cwd,value});
  assert.deepEqual(result,{success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
});

for(const [label,text] of [['UTF-8','中'.repeat(100000)],['JSON escaping','"'.repeat(90000)]]){
  test(`${label} bytes are bounded after wrapping, with lossless recoverable output`,t=>{
    const cwd=fixture(t),value={head:'fixed-head',revision:'fixed-revision',resource:{id:'scene',version:'resource-v7'},text};
    assert.ok(text.length<MAX_AGENT_TOOL_RESULT_BYTES,'raw JavaScript character count would miss this case');
    const result=encodeAgentToolResult({cwd,value});
    assert.equal(result.success,true);assert.ok(Buffer.byteLength(JSON.stringify(result))<=MAX_AGENT_TOOL_RESULT_BYTES);
    const pointer=JSON.parse(result.contentItems[0].text);assert.equal(pointer.projection,'tool-result-file');
    assert.ok(pointer.result_file.startsWith(resolve(cwd,'outputs/tool-results')+'/'));
    const bytes=readFileSync(pointer.result_file);assert.deepEqual(JSON.parse(bytes),value);
    assert.equal(pointer.bytes,bytes.length);assert.equal(pointer.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.equal(pointer.summary.revision,value.revision);assert.deepEqual(pointer.summary.resource,value.resource);
    assert.deepEqual(encodeAgentToolResult({cwd,value}),result,'same full value should resolve to the same content-addressed output');
  });
}

test('many small summary fields cannot recreate an oversized tool result',t=>{
  const cwd=fixture(t),value=Object.fromEntries(Array.from({length:1000},(_,i)=>['field-'+i,'中😀'.repeat(100)]));
  const result=encodeAgentToolResult({cwd,value});assert.ok(Buffer.byteLength(JSON.stringify(result))<=MAX_AGENT_TOOL_RESULT_BYTES);
  const pointer=JSON.parse(result.contentItems[0].text);assert.equal(pointer.projection,'tool-result-file');
  assert.deepEqual(JSON.parse(readFileSync(pointer.result_file,'utf8')),value);
});

test('overflow receipt replay retains exact safe output and does not mutate its source receipt',t=>{
  const cwd=fixture(t),value={revision:'fixed',text:'Readable source prose. '.repeat(20000)},original=encodeAgentToolResult({cwd,value}),pointer=JSON.parse(original.contentItems[0].text),before=structuredClone(pointer);
  assert.deepEqual(replayAgentToolResult({cwd,value:pointer}),original);assert.deepEqual(pointer,before);
});

for(const damage of ['missing','modified','foreign','symlink'])test(`unavailable ${damage} historical artifact preserves success without exposing an unchecked result file`,t=>{
  const cwd=fixture(t),value={revision:'fixed',text:'Readable source prose. '.repeat(20000)},pointer=JSON.parse(encodeAgentToolResult({cwd,value}).contentItems[0].text);
  if(damage==='missing')unlinkSync(pointer.result_file);
  if(damage==='modified')writeFileSync(pointer.result_file,'{"secret":"changed after receipt"}');
  if(damage==='foreign')pointer.result_file=resolve(fixture(t),'private.json');
  if(damage==='symlink'){
    const foreign=resolve(fixture(t),'private.json');writeFileSync(foreign,JSON.stringify(value));unlinkSync(pointer.result_file);symlinkSync(foreign,pointer.result_file);
  }
  const result=replayAgentToolResult({cwd,value:pointer}),body=JSON.parse(result.contentItems[0].text);
  assert.equal(result.success,true,'result retrieval failure must not suggest the original write failed');
  assert.equal(body.projection,'tool-result-unavailable');assert.equal('result_file' in body,false);assert.equal(body.summary.revision,'fixed');
});
