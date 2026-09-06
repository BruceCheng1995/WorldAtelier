#!/usr/bin/env node
// Actual native Godot client + actual authority, isolated WS coordinator.
// Input is injected as ordinary Godot keyboard events, not directly into state.
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const {WebSocketServer}=createRequire(import.meta.url)('ws');
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const label=process.argv.find(x=>x.startsWith('--label='))?.slice(8)||'current';
const baseline=process.argv.includes('--baseline');
const content=JSON.parse(await readFile(resolve(repo,'content/world.json'),'utf8'));
const output=resolve(repo,'.local/verification/input-'+label);await mkdir(output,{recursive:true});
const server=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:32*1024*1024});
await new Promise(r=>server.once('listening',r));
const godot='/Applications/Godot.app/Contents/MacOS/Godot',base=['--path',resolve(repo,'runtimes/godot')];
const processes=[];let host,client,state,sequence=0,joined=false,readyResolve;const ready=new Promise(r=>readyResolve=r);
let logs='',attackRequests=0,attackAccepted=0,attackRejected=0,loaded=false,snapshotsAcknowledged=0;const times=[];
function send(ws,m){if(ws?.readyState===1)ws.send(JSON.stringify(m))}
function snapshot(){if(client&&joined&&state){const packet={type:'snapshot',state,epoch:1,release_id:'input-probe',sequence};setTimeout(()=>send(client,packet),80)}}
function launch(args){const p=spawn(godot,args,{stdio:['ignore','pipe','pipe']});processes.push(p);p.stdout.on('data',b=>logs+=b);p.stderr.on('data',b=>logs+=b);return p}
server.on('connection',(ws,req)=>{
 if(req.url==='/host'){host=ws;ws.on('message',b=>{const m=JSON.parse(b);if(m.type==='host_hello')send(host,{type:'init',world_id:'input-probe',epoch:1,release_id:'input-probe',content,state:null});
  if(m.type==='ready'){state=m.state;readyResolve()}
  if(m.type==='snapshot'){state=m.state;sequence++;snapshot()}
  if(m.type==='result'){state=m.state;sequence++;if(m.request_id.startsWith('g-')){if(m.ok)attackAccepted++;else attackRejected++;send(client,{type:'ack',request_id:m.request_id,ok:m.ok,error:m.error,sequence})}}
 })}else if(req.url==='/play'){client=ws;ws.on('message',b=>{const m=JSON.parse(b);if(m.type==='hello')send(client,{type:'welcome',user_id:'input-user',world_id:'input-probe',epoch:1,release_id:'input-probe',control_generation:1,content,state});
  if(m.type==='loaded'){loaded=true;send(host,{type:'join',user_id:'input-user',name:'Input count fixture'});joined=true;send(client,{type:'active',epoch:1,release_id:'input-probe',control_generation:1});snapshot()}
  if(m.type==='snapshot_ack')snapshotsAcknowledged++;
  if(m.type==='command'){if(m.action==='attack'){attackRequests++;times.push(performance.now())}send(host,{...m,user_id:'input-user'})}
 })}
});
try{
 launch(['--headless',...base,'--','--role=authority',`--server=ws://127.0.0.1:${server.address().port}`,'--world=input-probe','--host-key=fixture']);
 await Promise.race([ready,new Promise((_,j)=>setTimeout(()=>j(Error('authority readiness timeout')),12000).unref())]);
 const child=launch([...base,'--script',resolve(repo,'tools/godot-input-driver.gd'),'--','--role=client',`--server=ws://127.0.0.1:${server.address().port}`,'--ticket=isolated-fixture',`--capture=${resolve(output,'held-space.png')}`,'--capture-after=1.05',`--telemetry-file=${resolve(output,'telemetry.json')}`]);
 const code=await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,j)=>setTimeout(()=>j(Error('client input fixture timeout')),15000).unref())]);
 const intervals=times.slice(1).map((t,i)=>t-times[i]);
 const report={label,scope:'real native client keyboard Input events + real authority through isolated coordinator; not OS-manual input or central-service E2E',loaded,snapshotsAcknowledged,held_seconds:2.6,snapshot_delay_ms:80,attackRequests,attackAccepted,attackRejected,min_request_interval_ms:intervals.length?Math.min(...intervals):null,client_exit:code,logs};
 await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
 assert.equal(code,0);assert(loaded&&snapshotsAcknowledged>0);assert(attackAccepted>=4,'held Space must continue attacking');
 if(!baseline){assert(attackRequests<=9,'held Space must not flood requests on stale 10 Hz cooldown snapshots');assert(!/SCRIPT ERROR|ERROR:/.test(logs),'runtime logs must be clean')}
 console.log('CLIENT_INPUT_PROBE',JSON.stringify({...report,logs:undefined}));
}catch(e){console.error(e.stack);console.error(logs);process.exitCode=1}
finally{client?.terminate();host?.terminate();server.close();for(const p of processes)if(p.exitCode===null)p.kill('SIGTERM')}
