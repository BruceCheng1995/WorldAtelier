#!/usr/bin/env node
// Isolated protocol fixture around a real Godot authority process. This is a
// runtime contract check, not a replacement for central service/browser E2E.
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const {WebSocketServer}=createRequire(import.meta.url)('ws');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const nativeArg=process.argv.find(a=>a.startsWith('--native='));
const binary=nativeArg?.slice(9)||'/Applications/Godot.app/Contents/MacOS/Godot';
const content=JSON.parse(await readFile(resolve(repo,'content/world.json'),'utf8'));
const server=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:32*1024*1024});
await new Promise(r=>server.once('listening',r));
const connection=new Promise(r=>server.once('connection',r));
const flags=nativeArg?[]:['--path',resolve(repo,'runtimes/godot')];
const child=spawn(binary,['--headless',...flags,'--','--role=authority',`--server=ws://127.0.0.1:${server.address().port}`,'--world=isolated-probe','--host-key=fixture'],{stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
let exit;const exited=new Promise(r=>child.once('exit',(code,signal)=>{exit={code,signal};r(exit)}));
const queue=[],waiters=[];let socket;const results=[];
function next(predicate,ms=10000){const index=queue.findIndex(predicate);if(index>=0)return Promise.resolve(queue.splice(index,1)[0]);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject};waiter.timer=setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(new Error('Timed out awaiting actual Godot message'))},ms);waiters.push(waiter)})}
function check(label,condition){assert(condition,label);results.push(label);console.log('PASS',label)}
try{
 socket=await Promise.race([connection,new Promise((_,reject)=>setTimeout(()=>reject(Error('Authority failed to connect')),12000).unref())]);
 socket.on('message',b=>{const m=JSON.parse(b);const waiter=waiters.find(w=>w.predicate(m));if(waiter){clearTimeout(waiter.timer);waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(m)}else queue.push(m)});
 // Handshake may already be buffered by ws; connection callback precedes delivery.
 await next(m=>m.type==='host_hello');
 socket.send(JSON.stringify({type:'init',world_id:'isolated-probe',epoch:7,release_id:'r1',content,state:null}));
 const ready=await next(m=>m.type==='ready');
 check('ready includes actual restored state',ready.state?.tick===0&&ready.epoch===7);
 socket.send(JSON.stringify({type:'join',user_id:'alice',name:'小艾'}));
 socket.send(JSON.stringify({type:'command',request_id:'collect',user_id:'alice',action:'interact',payload:{object_id:'landing_crystal_0'}}));
 const collected=await next(m=>m.type==='result'&&m.request_id==='collect');
 check('actual authority awards collection',collected.ok&&collected.state.players.alice.crystals===2);
 const glb=await readFile(resolve(repo,'runtimes/godot/assets/explorer.glb'));const hash=createHash('sha256').update(glb).digest('hex');
 const model=structuredClone(content);model.objects[0].model_asset=hash;model.asset_blobs={[hash]:{mime:'model/gltf-binary',data_base64:glb.toString('base64')}};
 socket.send(JSON.stringify({type:'apply_content',request_id:'large-model',release_id:'r2',content:model}));
 const applied=await next(m=>m.type==='applied'&&m.request_id==='large-model');
 check('1.2 MB GLB message traverses real Godot WebSocket and imports',applied.ok&&applied.release_id==='r2'&&applied.state.players.alice.crystals===2);
 socket.send(JSON.stringify({type:'command',request_id:'move',user_id:'alice',action:'move',payload:{x:0,z:1}}));
 await next(m=>m.type==='result'&&m.request_id==='move');
 await new Promise(r=>setTimeout(r,220));
 socket.send(JSON.stringify({type:'freeze',request_id:'freeze-1'}));
 const frozen=await next(m=>m.type==='frozen'&&m.request_id==='freeze-1');
 check('freeze captures progressed world and inventory',frozen.ok&&frozen.state.tick>0&&frozen.state.players.alice.z>6&&frozen.state.players.alice.crystals===2);
 await new Promise(r=>setTimeout(r,250));
 socket.send(JSON.stringify({type:'command',request_id:'blocked-input',user_id:'alice',action:'attack',payload:{}}));
 const blocked=await next(m=>m.type==='result'&&m.request_id==='blocked-input');
 check('frozen authority rejects input without ticking',!blocked.ok&&blocked.state.tick===frozen.state.tick);
 socket.send(JSON.stringify({type:'tasks',tasks:[{id:'forbidden-after-freeze',object_id:'starheart',status:'editing'}]}));
 socket.send(JSON.stringify({type:'join',user_id:'bob',name:'Bob'}));
 socket.send(JSON.stringify({type:'leave',user_id:'alice'}));
 socket.send(JSON.stringify({type:'freeze',request_id:'freeze-2'}));
 const repeat=await next(m=>m.type==='frozen'&&m.request_id==='freeze-2');
 check('frozen checkpoint remains byte-equivalent after all mutation attempts',JSON.stringify(repeat.state)===JSON.stringify(frozen.state));
 socket.close();
 const status=await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('Disconnected authority did not exit')),5000).unref())]);
 check('disconnected authority terminates itself',status.code===3);
 await mkdir(resolve(repo,'.local/verification'),{recursive:true});
 await writeFile(resolve(repo,'.local/verification/host-probe'+(nativeArg?'-release':'-editor')+'.json'),JSON.stringify({ok:true,binary,checks:results,final_tick:frozen.state.tick,release:'r2',logs},null,2));
 console.log('HOST_PROTOCOL_PROBE_PASSED',results.length);
}catch(error){console.error(error.stack);console.error(logs);process.exitCode=1}
finally{socket?.terminate();server.close();if(!exit)child.kill('SIGTERM');for(const waiter of waiters)clearTimeout(waiter.timer)}
