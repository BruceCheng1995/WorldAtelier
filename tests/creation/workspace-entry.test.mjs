// Independent startup guard tests. Production 48910 receives GET requests only.
// All process tests copy the unmodified entry into a temporary fake project;
// its child is a tiny fake HTTP server, never CreationService, Godot, or Agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,access,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),port=48921;
const entry=await readFile(resolve(root,'tools/start-workspace.mjs'),'utf8');
const html=await readFile(resolve(root,'apps/creation-workspace/index.html'),'utf8');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=path=>access(path).then(()=>true,()=>false);
async function freePort(){const server=netServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});await new Promise(yes=>server.close(yes));}
async function until(check,label,timeout=5000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await sleep(20);}throw new Error('Timed out waiting for '+label);}

const fakeChild=`import http from 'node:http';
import {appendFile,readFile} from 'node:fs/promises';
await appendFile(process.env.ATELIER_ENTRY_FAKE_LEDGER,JSON.stringify({pid:process.pid,port:process.env.WORLD_ATELIER_PREVIEW_PORT})+'\\n');
if(process.env.ATELIER_ENTRY_FAKE_EXIT==='1')process.exit(0);
const html=await readFile('apps/creation-workspace/index.html','utf8');
const server=http.createServer((req,res)=>{if(req.url==='/preview-api/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,service:'model-preview'}));}else if(req.url==='/creation-workspace.html')res.end(html);else{res.statusCode=404;res.end();}});
const timer=setTimeout(()=>server.listen(Number(process.env.WORLD_ATELIER_PREVIEW_PORT),'127.0.0.1'),Number(process.env.ATELIER_ENTRY_FAKE_DELAY||0));
const stop=()=>{clearTimeout(timer);if(server.listening){server.close(()=>process.exit(0));server.closeAllConnections();}else process.exit(0);};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
`;

async function fixture(t){
  const directory=await realpath(await mkdtemp(resolve(tmpdir(),'atelier-entry-FAKE-')));
  for(const relative of ['tools','services/preview','apps/creation-workspace','.local'])await mkdir(resolve(directory,relative),{recursive:true});
  await writeFile(resolve(directory,'tools/start-workspace.mjs'),entry);
  await writeFile(resolve(directory,'services/preview/network.mjs'),await readFile(resolve(root,'services/preview/network.mjs')));
  await writeFile(resolve(directory,'services/preview/server.mjs'),fakeChild);
  await writeFile(resolve(directory,'apps/creation-workspace/index.html'),html);
  const children=[];
  t.after(async()=>{for(const child of children)if(child.process.exitCode===null&&child.process.signalCode===null){child.process.kill('SIGTERM');await Promise.race([child.done,sleep(3000)]);assert.ok(child.process.exitCode!==null||child.process.signalCode!==null,'owned FAKE startup process must stop');}await rm(directory,{recursive:true,force:true});});
  const ledger=resolve(directory,'child-starts.jsonl');
  function start(overrides={},args=[]){
    const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:resolve(directory,'isolated/preview'),WORLD_ATELIER_CREATION_DATA:resolve(directory,'isolated/creation'),ATELIER_ENTRY_FAKE_LEDGER:ledger,...overrides};
    for(const [key,value]of Object.entries(env))if(value===undefined)delete env[key];
    const processChild=spawn(process.execPath,['tools/start-workspace.mjs',...args],{cwd:directory,env,stdio:['ignore','pipe','pipe']});
    const state={process:processChild,output:'',done:null};processChild.stdout.on('data',b=>state.output+=b);processChild.stderr.on('data',b=>state.output+=b);
    state.done=new Promise((yes,no)=>{processChild.once('error',no);processChild.once('exit',(code,signal)=>yes({code,signal}));});children.push(state);return state;
  }
  const run=async(overrides={})=>{const child=start(overrides),result=await child.done;return {...result,output:child.output};};
  return {directory,ledger,start,run,lock:resolve(directory,`.local/workspace-${port}.start.lock`),starts:async()=>exists(ledger).then(async yes=>yes?(await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse):[])};
}

async function fakeHttp(t,handler){
  await freePort();const requests=[],server=httpServer((req,res)=>{requests.push({method:req.method,url:req.url});handler(req,res);});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});
  t.after(()=>new Promise((yes,no)=>{server.close(error=>error?no(error):yes());server.closeAllConnections();}));
  return requests;
}

test('both documented npm entrypoints use the guarded launcher',async()=>{
  const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  assert.equal(pkg.scripts.dev,'node tools/start-workspace.mjs');assert.equal(pkg.scripts['start:preview'],pkg.scripts.dev);
});

test('production 48910 identity is checked with GET only; never start or mutate it',{timeout:7000},async t=>{
  let health;
  try{health=await fetch('http://127.0.0.1:48910/preview-api/health',{method:'GET',signal:AbortSignal.timeout(2500)});}catch{t.skip('Production listener unavailable; never start it from an independent test');return;}
  assert.equal(health.status,200);const body=await health.json();assert.equal(body.ok,true);assert.equal(body.service,'model-preview');
  const response=await fetch('http://127.0.0.1:48910/creation-workspace.html',{method:'GET',signal:AbortSignal.timeout(2500)});assert.equal(response.status,200);assert.equal(await response.text(),await readFile(resolve(root,'apps/creation-workspace/index.html'),'utf8'));
});

test('an existing matching FAKE workspace is reused without lock, child process or new port',{timeout:10000},async t=>{
  const f=await fixture(t),requests=await fakeHttp(t,(req,res)=>{if(req.url==='/preview-api/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,service:'model-preview'}));}else res.end(html);});
  const result=await f.run();assert.equal(result.code,0,result.output);assert.match(result.output,/复用已运行/);assert.doesNotMatch(result.output,/启动世界工坊/);assert.deepEqual(await f.starts(),[]);assert.equal(await exists(f.lock),false);
  assert.deepEqual(requests,[{method:'GET',url:'/preview-api/health'},{method:'GET',url:'/creation-workspace.html'}]);
});

test('another listener or wrong workspace content rejects startup without trying another port',{timeout:15000},async t=>{
  for(const mismatch of ['service','workspace'])await t.test(mismatch,async t=>{
    const f=await fixture(t),requests=await fakeHttp(t,(req,res)=>{if(req.url==='/preview-api/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,service:mismatch==='service'?'foreign-service':'model-preview'}));}else res.end('foreign project');});
    const result=await f.run();assert.equal(result.code,1);assert.match(result.output,/48921.*已被占用/);assert.match(result.output,/不会换端口/);assert.equal(await exists(f.lock),false);assert.deepEqual(await f.starts(),[]);assert.ok(requests.every(r=>r.method==='GET'));
  });
});

test('concurrent starts acquire one lock and create one FAKE child; a later command reuses it',{timeout:15000},async t=>{
  await freePort();const f=await fixture(t),first=f.start({ATELIER_ENTRY_FAKE_DELAY:'1200'});
  await until(async()=>(await f.starts()).length===1,'first FAKE child');assert.equal(await exists(f.lock),true);
  const second=await f.run();assert.equal(second.code,1,second.output);assert.match(second.output,/另一个启动命令/);assert.equal((await f.starts()).length,1);
  await until(async()=>{try{const r=await fetch(`http://127.0.0.1:${port}/preview-api/health`,{signal:AbortSignal.timeout(200)});return r.ok;}catch{return false;}},'FAKE listener');
  const third=await f.run();assert.equal(third.code,0,third.output);assert.match(third.output,/复用已运行/);assert.equal((await f.starts()).length,1);
  first.process.kill('SIGTERM');assert.equal((await first.done).code,0);assert.equal(await exists(f.lock),false);await freePort();
});

test('a pre-existing startup lock is reported and never removed or bypassed',{timeout:10000},async t=>{
  await freePort();const f=await fixture(t),record=JSON.stringify({pid:987654321,port,scope:'FAKE stale lock; not owned by test starter'});await writeFile(f.lock,record);
  const result=await f.run();assert.equal(result.code,1);assert.match(result.output,/锁文件/);assert.equal(await readFile(f.lock,'utf8'),record);assert.deepEqual(await f.starts(),[]);
});

test('background mode waits for an existing service and starts after it exits',{timeout:25000},async t=>{
  await freePort();const f=await fixture(t),first=f.start();
  await until(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/preview-api/health`)).ok;}catch{return false;}},'first listener');
  const watcher=f.start({},['--background']);
  await until(()=>watcher.output.includes('后台守护等待'),'background watcher');
  assert.equal((await f.starts()).length,1);
  first.process.kill('SIGTERM');await first.done;
  await until(async()=>(await f.starts()).length===2,'background takeover',20000);
  watcher.process.kill('SIGTERM');assert.equal((await watcher.done).code,0);
  assert.equal(await exists(f.lock),false);
});

test('background mode only recovers a dead starter with matching root and port',{timeout:10000},async t=>{
  await freePort();const f=await fixture(t);
  for(const record of [
    {pid:process.pid,port,root:f.directory},
    {pid:987654321,port,root:'/unrelated/project'},
    {pid:987654321,port:48910,root:f.directory},
  ]){
    await writeFile(f.lock,JSON.stringify(record));
    const child=f.start({ATELIER_ENTRY_FAKE_EXIT:'1'},['--background']);
    assert.equal((await child.done).code,1);assert.deepEqual(JSON.parse(await readFile(f.lock,'utf8')),record);
  }
  await writeFile(f.lock,JSON.stringify({pid:987654321,port,root:f.directory}));
  const child=f.start({ATELIER_ENTRY_FAKE_EXIT:'1'},['--background']);
  assert.equal((await child.done).code,0,child.output);assert.match(child.output,/已清理退出的启动器/);
  assert.equal((await f.starts()).length,1);assert.equal(await exists(f.lock),false);
});

test('nondefault ports require both explicit data directories before any listener or child action',{timeout:10000},async t=>{
  const f=await fixture(t);
  for(const overrides of [{WORLD_ATELIER_PREVIEW_DATA:undefined,WORLD_ATELIER_CREATION_DATA:undefined},{WORLD_ATELIER_PREVIEW_DATA:undefined},{WORLD_ATELIER_CREATION_DATA:undefined}]){
    const result=await f.run({...overrides,ATELIER_ENTRY_FAKE_EXIT:'1'});assert.equal(result.code,1,result.output);assert.match(result.output,/独立.*PREVIEW_DATA.*CREATION_DATA/);
  }
  assert.deepEqual(await f.starts(),[]);assert.equal(await exists(f.lock),false);
});

test('nondefault data cannot alias production defaults, overlap them, or share the same directory',{timeout:15000},async t=>{
  const f=await fixture(t),production=resolve(f.directory,'.local/model-preview'),alias=resolve(f.directory,'production-alias');await mkdir(production,{recursive:true});await symlink(production,alias);
  const cases=[
    {WORLD_ATELIER_PREVIEW_DATA:production},
    {WORLD_ATELIER_CREATION_DATA:resolve(production,'creation')},
    {WORLD_ATELIER_PREVIEW_DATA:resolve(f.directory,'.local')},
    {WORLD_ATELIER_CREATION_DATA:resolve(production,'not-created/creation')},
    {WORLD_ATELIER_PREVIEW_DATA:resolve(alias,'not-created/preview')},
    {WORLD_ATELIER_PREVIEW_DATA:resolve(f.directory,'same'),WORLD_ATELIER_CREATION_DATA:resolve(f.directory,'same')},
  ];
  for(const overrides of cases){const result=await f.run({...overrides,ATELIER_ENTRY_FAKE_EXIT:'1'});assert.equal(result.code,1,JSON.stringify(overrides)+'\n'+result.output);assert.match(result.output,/隔离|独立|相同|生产|默认/);}
  assert.deepEqual(await f.starts(),[]);assert.equal(await exists(f.lock),false);
});

test('explicit independent nonexistent data paths allow one FAKE child and release its lock on exit',{timeout:10000},async t=>{
  await freePort();const f=await fixture(t),result=await f.run({ATELIER_ENTRY_FAKE_EXIT:'1'});
  assert.equal(result.code,0,result.output);assert.equal((await f.starts()).length,1);assert.equal((await f.starts())[0].port,String(port));assert.equal(await exists(f.lock),false);await freePort();
});
