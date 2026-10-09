import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
const options=Object.fromEntries(process.argv.slice(2).filter(v=>v.startsWith('--')).map(v=>{const i=v.indexOf('=');return[v.slice(2,i),v.slice(i+1)];}));
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=options.out??await mkdtemp(join(os.tmpdir(),'creator-validator-'));
await mkdir(output,{recursive:true});
const scripts=new Map();
const source=`extends RefCounted
func initialize(ctx) -> Dictionary:
\tctx.state.count = ctx.state.get("count",0)
\tif ctx.role == "presentation":
\t\tvar mesh = MeshInstance3D.new()
\t\tmesh.mesh = BoxMesh.new()
\t\tctx.root.add_child(mesh)
\t\tctx.local.mesh = mesh
\treturn {"ok":true}
func tick(_ctx, _delta:float) -> Dictionary:
\treturn {"ok":true}
func interact(ctx, _player:Dictionary) -> Dictionary:
\tctx.state.count += 1
\tctx.emit_event("counter",{"count":ctx.state.count})
\treturn {"ok":true}
func trigger(_ctx, _player:Dictionary, _entered:bool) -> Dictionary:
\treturn {"ok":true}
func present(ctx, event:Dictionary) -> Dictionary:
\tctx.local.mesh.position.y = float(ctx.state.count) * .01
\treturn {"ok":true}
func freeze(_ctx, _frozen:bool) -> Dictionary:
\treturn {"ok":true}
func dispose(_ctx) -> Dictionary:
\treturn {"ok":true}
`;
const cases=[
 {id:'valid-two-roles',source,valid:true},
 {id:'reject-present',source:source.replace('ctx.local.mesh.position.y = float(ctx.state.count) * .01','return {"ok":false,"error":"fixture present rejected"}'),valid:false,error:'presentation'},
 {id:'reject-freeze',source:source.replace('func freeze(_ctx, _frozen:bool) -> Dictionary:\n\treturn {"ok":true}','func freeze(_ctx, _frozen:bool) -> Dictionary:\n\treturn {"ok":false}'),valid:false,error:'freeze'},
 {id:'reject-dispose',source:source.replace('func dispose(_ctx) -> Dictionary:\n\treturn {"ok":true}','func dispose(_ctx) -> Dictionary:\n\treturn {"ok":false}'),valid:false,error:'dispose'},
 {id:'reject-migration',source:source.replace('ctx.state.count = ctx.state.get("count",0)','if ctx.state.has("count"): return {"ok":false}\n\tctx.state.count = 0'),valid:false,error:'initialize'},
 {id:'reject-present-vm-error',source:source.replace('ctx.local.mesh.position.y = float(ctx.state.count) * .01','ctx.local.mesh.call("fixture_missing_method")'),valid:false,error:'presentation'}
];
for(const item of cases){item.hash=createHash('sha256').update(item.source).digest('hex');scripts.set(item.hash,item.source);}
const server=http.createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;const match=/^\/preview-assets\/([a-f0-9]{64})\.gd$/.exec(path);if(!match||!scripts.has(match[1])){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'text/x-gdscript'});res.end(scripts.get(match[1]));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const checks=[];let fatal='';
function check(ok,detail){checks.push({ok:Boolean(ok),detail});if(!ok)throw Error(detail);}
async function run(item){
 const scene={document_id:'validator/fixture',scene_revision:item.id,origin,spawn_position:[0,.2,1],objects:[{id:'device',kind:'anchor',position:[0,0,0],scale:1,components:{interactable:{radius:3},trigger:{shape:'sphere',radius:2},behaviors:[{id:'counter',api:1,script_hash:item.hash,script_url:`/preview-assets/${item.hash}.gd?cap=fixture`,properties:{}}]}}]};
 const state={tick:30,sequence:10,object_states:{device:{counter:{count:17}}},players:{existing:{id:'existing',name:'Existing',color:'#80caff',position:[7,.2,1],velocity:[0,0,0],yaw:.5,online:true,last_input_seq:39,interactions:8}}};
 const fixture=join(output,item.id+'.scene.json'),report=join(output,item.id+'.report.json');
 await writeFile(fixture,JSON.stringify({scene,scene_revision:item.id,state}));
 let log='';
 const child=spawn(options.godot??'/Applications/Godot.app/Contents/MacOS/Godot',['--headless','--path',project,'--',`--validate-scene=${fixture}`,`--report=${report}`],{stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);
 const timeout=setTimeout(()=>child.kill('SIGKILL'),35000);
 const result=await new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));clearTimeout(timeout);
 await writeFile(join(output,item.id+'.log'),log);
 const value=JSON.parse(await readFile(report,'utf8'));
 check(result.code===(item.valid?0:2)&&value.completed&&value.ok===item.valid,`${item.id}: actual validator process and completed report agree`);
 if(item.valid){
  check(value.checks.includes('presentation_freeze_resume_dispose')&&value.snapshot.object_states.device.counter.count>=18,'valid: actual authority state migrated and both roles executed lifecycle callbacks');
  check(value.snapshot.players.existing.last_input_seq===39&&value.snapshot.players.existing.interactions===8&&value.snapshot.players.existing.position[0]===7,'valid: existing online player input/progress/position survive checkpoint restoration');
  check(!/SCRIPT ERROR|Parse Error|^ERROR:/m.test(log),'valid: no engine or script errors');
 }else check(value.error.includes(item.error),`${item.id}: error identifies failed callback/role`);
 return {id:item.id,pid:child.pid,...result,report};
}
const runs=[];
try{for(const item of cases)runs.push(await run(item));}catch(error){fatal=error.stack;checks.push({ok:false,detail:error.message});}finally{await new Promise(r=>server.close(r));}
const report={ok:!fatal,checks,runs,error:fatal,scope:'six actual isolated Godot validators over HTTP; headless Node/physics/lifecycle execution, not GPU or production service publication'};
await writeFile(join(output,'summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ok:report.ok,checks:checks.length,output,error:fatal}));process.exitCode=fatal?1:0;
