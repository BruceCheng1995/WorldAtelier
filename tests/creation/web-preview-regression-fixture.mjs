/** Isolated real Web export fixture. Browser actions must use CUA separately.
 * Start only after the integration change is ready; stop this owned process
 * when browser verification ends. No runtime ACKs or fabricated build rows.
 */
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir,networkInterfaces} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {createIndependentPreviewFixture} from './independent-preview-fixture.mjs';

const root=resolve(import.meta.dirname,'../..'),port=48923;
const probe=createServer();await new Promise((yes,no)=>{probe.once('error',no);probe.listen(port,'0.0.0.0',yes);});await new Promise(yes=>probe.close(yes));
const ip=Object.entries(networkInterfaces()).filter(([name])=>!/^utun|tun|tap/.test(name)).flatMap(([,rows])=>rows).find(row=>row.family==='IPv4'&&!row.internal)?.address;
if(!ip)throw Error('Actual LAN IPv4 is required for the insecure-context browser test');
const origin=`http://127.0.0.1:${port}`,lanOrigin=`http://${ip}:${port}`;
const data=await mkdtemp(resolve(tmpdir(),'atelier-web-preview-lan-'));
const out=resolve(root,'.local/creation-verification/web-preview-regression',new Date().toISOString().replaceAll(':','-'));await mkdir(out,{recursive:true});
let log='';const service=spawn(process.execPath,['tools/start-workspace.mjs'],{cwd:root,env:{...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:resolve(data,'preview'),WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_PUBLIC_PLAY:'0',WORLD_ATELIER_LAN:'1'},stdio:['ignore','pipe','pipe']});
service.stdout.on('data',d=>{log+=d;});service.stderr.on('data',d=>{log+=d;});
const stopping=()=>{if(service.exitCode===null)service.kill('SIGTERM');};process.on('SIGTERM',stopping);process.on('SIGINT',stopping);
service.on('exit',async code=>{await writeFile(resolve(out,'service.log'),log);process.exit(code??0);});
async function request(method,path,{auth,body,raw,name}={}){
 const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin,...(auth?{authorization:'Bearer '+auth.token}:{}),'content-type':raw?'application/octet-stream':'application/json',...(raw?{'x-asset-name':name}:{})},...(body!==undefined?{body:raw?body:JSON.stringify(body)}:{})});
 const value=await response.json();if(!response.ok)throw Error(response.status+' '+JSON.stringify(value));return value;
}
try{
 for(let i=0;i<150;i++){try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===149)throw Error(log);}
 const fixture=await createIndependentPreviewFixture(request),auth=fixture.users[0];
 const job=(await request('POST',`/projects/${fixture.project_id}/branches/main/builds`,{auth,body:{kind:'application',targets:['web'],source_revision:fixture.source_revision,entry_scene_id:fixture.resource_id,request_id:'web-lan-regression-'+randomUUID(),confirmed:true}})).job;
 await writeFile(resolve(out,'access.private.json'),JSON.stringify({...fixture,data,service_pid:service.pid,job_id:job.id,origin,lanOrigin},null,2),{mode:0o600});
 console.log(JSON.stringify({building:true,job_id:job.id,service_pid:service.pid,out}));
 const deadline=Date.now()+420000;let completed,lastStage;
 while(Date.now()<deadline){
  const current=(await request('GET',`/builds/${job.id}`,{auth})).job;
  if(current.stage!==lastStage){lastStage=current.stage;console.log(JSON.stringify({stage:current.stage,progress:current.progress,status:current.status}));}
  if(['completed','partial','failed','interrupted'].includes(current.status)){completed=current;break;}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(!completed)throw Error('Isolated Web build timed out');
 await writeFile(resolve(out,'build-result.json'),JSON.stringify(completed,null,2));
 if(completed.status!=='completed'||!completed.artifacts?.some(a=>a.target==='web'))throw Error('Web build failed: '+JSON.stringify(completed));
 const web=resolve(data,'creation/builds',job.id,'web'),files={};
 for(const name of ['index.html','index.js','index.wasm','index.pck','web-compatibility.json']){
  try{const bytes=await readFile(resolve(web,name));files[name]={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}catch(error){if(name!=='web-compatibility.json')throw error;}
 }
 await writeFile(resolve(out,'web-files.json'),JSON.stringify(files,null,2));
 console.log(JSON.stringify({ready:true,lan_url:lanOrigin+'/creation-workspace.html#/games/'+fixture.project_id+'/branches/main',local_url:origin+'/creation-workspace.html#/games/'+fixture.project_id+'/branches/main',user:{name:auth.name,password:auth.password},job_id:completed.id,status:completed.status,artifacts:completed.artifacts,files,out}));
}catch(error){console.error(error.stack);stopping();process.exitCode=1;}
