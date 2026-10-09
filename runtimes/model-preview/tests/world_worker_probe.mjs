import http from 'node:http';
import {WebSocketServer} from 'ws';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
const options=Object.fromEntries(process.argv.slice(2).filter(v=>v.startsWith('--')).map(v=>{const i=v.indexOf('=');return[v.slice(2,i),v.slice(i+1)];}));
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scenes=JSON.parse(await readFile(options.fixture,'utf8'));
const token=randomBytes(24).toString('hex');
const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();});
const wss=new WebSocketServer({noServer:true,maxPayload:32*1024*1024});
const events=[],waiters=[],checks=[];
let socket,child,log='',exitPromise;
function check(ok,detail){checks.push({ok:Boolean(ok),detail});if(!ok)throw Error(detail);}
function received(packet){events.push(packet);if(events.length>256)events.shift();for(const item of [...waiters])if(item.match(packet)){clearTimeout(item.timer);waiters.splice(waiters.indexOf(item),1);item.resolve(packet);}}
function wait(match,timeout=8000){const old=events.find(match);if(old)return Promise.resolve(old);return new Promise((resolveWait,reject)=>{const item={match,resolve:resolveWait,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(item),1);reject(Error('worker response timeout'));},timeout)};waiters.push(item);});}
function send(packet){socket.send(JSON.stringify(packet));}
server.on('upgrade',(req,connection,head)=>{if(req.url!=='/ws/world-worker'||req.headers.authorization!=='Bearer '+token){connection.destroy();return;}wss.handleUpgrade(req,connection,head,ws=>wss.emit('connection',ws));});
wss.on('connection',ws=>{socket=ws;ws.on('message',bytes=>received(JSON.parse(bytes)));});
let failure='';
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 child=spawn(options.godot??'/Applications/Godot.app/Contents/MacOS/Godot',['--headless','--path',project,'--','--authority'],{env:{PATH:process.env.PATH,HOME:os.homedir(),TMPDIR:os.tmpdir(),WA_WORKER_URL:`ws://127.0.0.1:${server.address().port}/ws/world-worker`,WA_WORKER_TOKEN:token},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 exitPromise=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
 const hello=await wait(p=>p.type==='worker_hello');
 check(hello.pid===child.pid&&hello.protocol===1,'real Godot worker authenticates loopback WS with header and reports actual PID');
 send({type:'init',request_id:'initial',world_id:'ws-probe',epoch:7,scene_revision:scenes[0].scene_revision,scene:{...scenes[0],origin:options.origin}});
 const ready=await wait(p=>p.type==='world_ready'&&p.request_id==='initial');
 check(ready.ok&&ready.snapshot.world_id==='ws-probe'&&ready.module_assets.includes(scenes[0].objects[0].components.behaviors[0].script_hash),'world_ready returns matching request and actual loaded behavior hash');
 send({type:'join',player_id:'actor',name:'真实角色',color:'#7ccbff'});
 const joined=await wait(p=>p.type==='world_snapshot'&&p.snapshot.players.actor);
 const initialPosition=joined.snapshot.players.actor.position;
 send({type:'input',player_id:'actor',epoch:7,scene_revision:scenes[0].scene_revision,input_seq:1,move:[1,0],jump:false,interact:false});
 const moved=await wait(p=>p.type==='world_snapshot'&&p.snapshot.players.actor?.position[0]>initialPosition[0]+.25);
 check(moved.snapshot.tick>joined.snapshot.tick,'normal movement input advances actual authority physics and position');
 send({type:'input',player_id:'actor',epoch:7,scene_revision:scenes[0].scene_revision,input_seq:2,move:[0,0],jump:false,interact:false});
 const stopped=await wait(p=>p.type==='world_snapshot'&&p.snapshot.players.actor?.last_input_seq>=2);
 check(stopped.snapshot.players.actor.velocity[0]===0,'zero input is acknowledged in actual stopped snapshot');
 send({type:'input',player_id:'actor',epoch:7,scene_revision:scenes[0].scene_revision,input_seq:3,move:[0,0],jump:false,interact:true});
 const interacted=await wait(p=>p.type==='world_snapshot'&&p.snapshot.object_states.device.counter.count>=1);
 const count=interacted.snapshot.object_states.device.counter.count;
 check(interacted.snapshot.players.actor.interactions>=1,'normal E interaction executes external GDScript in authority Area3D');
 send({type:'apply_scene',request_id:'reject',world_id:'ws-probe',epoch:7,scene_revision:scenes[2].scene_revision,scene:{...scenes[2],origin:options.origin}});
 const rejected=await wait(p=>p.type==='applied'&&p.request_id==='reject');
 check(!rejected.ok&&rejected.snapshot.scene_revision===scenes[0].scene_revision,'bad behavior candidate is rejected with old world retained');
 const continuing=await wait(p=>p.type==='world_snapshot'&&p.snapshot.tick>rejected.snapshot.tick+6);
 check(continuing.snapshot.scene_revision===scenes[0].scene_revision&&continuing.snapshot.object_states.device.counter.count===count,'same worker continues old behavior state after rejected candidate');
 send({type:'apply_scene',request_id:'replace',world_id:'ws-probe',epoch:7,scene_revision:scenes[1].scene_revision,scene:{...scenes[1],origin:options.origin}});
 const replaced=await wait(p=>p.type==='applied'&&p.request_id==='replace');
 check(replaced.ok&&replaced.snapshot.object_states.device.counter.count===count&&replaced.snapshot.players.actor.last_input_seq===3,'successful candidate preserves gameplay state and input sequence');
 send({type:'input',player_id:'actor',epoch:7,scene_revision:scenes[1].scene_revision,input_seq:4,move:[0,0],jump:false,interact:true});
 const updated=await wait(p=>p.type==='world_snapshot'&&p.snapshot.scene_revision===scenes[1].scene_revision&&p.snapshot.object_states.device.counter.count>=count+2);
 check(updated.snapshot.module_assets.includes(scenes[1].objects[0].components.behaviors[0].script_hash),'new immutable GDScript behavior produces changed interaction result in same worker PID');
 send({type:'checkpoint',request_id:'checkpoint'});
 const checkpoint=await wait(p=>p.type==='checkpoint'&&p.request_id==='checkpoint');
 check(checkpoint.ok&&checkpoint.snapshot.players.actor.interactions>=2,'checkpoint contains actual authoritative interaction progress');
 socket.close();
 const exit=await Promise.race([exitPromise,new Promise((_,reject)=>setTimeout(()=>reject(Error('orphan worker did not exit')),3000))]);
 check(exit.code===0,'worker exits when central WS closes instead of running an orphan world');
 check(!/SCRIPT ERROR|Parse Error|^ERROR:/m.test(log),'positive and expected candidate-rejection run contains no engine/script errors');
}catch(error){failure=error.stack;checks.push({ok:false,detail:error.message});}
finally{if(child&&child.exitCode===null)child.kill('SIGTERM');for(const item of waiters)clearTimeout(item.timer);socket?.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
const result={ok:!failure,checks,pid:child?.pid,scope:'actual Godot child process and loopback WebSocket/HTTP/GDScript/physics; not browser or production central service',error:failure};
await writeFile(options.report,JSON.stringify(result,null,2)+'\n');await writeFile(options.report.replace(/\.json$/,'.log'),log);
console.log(JSON.stringify({ok:result.ok,checks:checks.length,report:options.report,error:failure}));process.exitCode=failure?1:0;
