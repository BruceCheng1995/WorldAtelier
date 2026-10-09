// Actual Node IPC and the production finish definition under transport pressure.
// This is a transport regression; real Godot execution is covered separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const workerSource=readFileSync(new URL('../../services/creation/build-worker.mjs',import.meta.url),'utf8');
if(process.argv.includes('--ipc-child')){
 const start=workerSource.indexOf('const finish='),end=workerSource.indexOf('\nlet builds=',start);
 assert.ok(start>=0&&end>start,'production finish definition is available');
 const finish=Function(workerSource.slice(start,end)+';return finish;')();
 process.once('message',async({size,terminal})=>{
  try{
   const payload='x'.repeat(size);
   for(let sequence=0;sequence<12;sequence++)process.send({type:'update',sequence,payload});
   await finish(terminal==='done'?{type:'done'}:{type:'failed',error:'deliberate execution failure'});
  }catch(error){process.exitCode=1;console.error(error);}
  finally{if(process.connected)process.disconnect();}
 });
}else{
 for(const terminal of ['done','failed'])for(const size of [50000,200000,1000000]){
  test(`worker flushes ${terminal} and twelve ${size}-byte progress messages before closing`,{timeout:15000},async t=>{
   const child=fork(fileURLToPath(import.meta.url),['--ipc-child'],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});
   t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
   const messages=[];let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
   const closed=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.on('message',message=>{
     messages.push(message);
     // The controller performs synchronous SQLite progress persistence; impose
     // repeatable receiver pressure without substituting any runtime ACK.
     const until=performance.now()+8;while(performance.now()<until){}
    });
    child.once('close',(code,signal)=>resolve({code,signal}));
   });
   child.send({size,terminal});
   assert.deepEqual(await closed,{code:0,signal:null},stderr);
   assert.equal(messages.length,13,'no progress or terminal message may be dropped');
   for(let i=0;i<12;i++){
    assert.equal(messages[i].type,'update');assert.equal(messages[i].sequence,i);assert.equal(messages[i].payload.length,size);
   }
   assert.equal(messages[12].type,terminal);
   if(terminal==='failed')assert.equal(messages[12].error,'deliberate execution failure');
  });
 }
}
