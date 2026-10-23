#!/usr/bin/env node
// Portable, single-file launcher for an already installed matching Godot 4.6.
// The native process receives only a short-lived, one-world game capability.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,lstat,realpath,copyFile,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join,dirname,basename,sep} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const exec=promisify(execFile),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hashJson=value=>digest(stable(value));
const assert=(value,message)=>{if(!value)throw Error(message);};
const isSafe=path=>typeof path==='string'&&!path.includes('\\')&&!path.includes('\0')&&!path.startsWith('/')&&path.split('/').every(part=>part&&part!=='.'&&part!=='..');
const shaFile=async path=>{const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return hash.digest('hex');};
async function exists(path){try{return await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function safeDirectory(path){
  const absolute=resolve(path),stat=await exists(absolute);
  if(stat){assert(stat.isDirectory()&&!stat.isSymbolicLink(),'客户端目录不能是符号链接或普通文件：'+absolute);return realpath(absolute);}
  const parent=await safeDirectory(dirname(absolute)),destination=join(parent,basename(absolute));
  try{await mkdir(destination,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const created=await lstat(destination);assert(created.isDirectory()&&!created.isSymbolicLink(),'客户端目录在创建期间改变');return destination;
}
export function clientRequest(server,token){
  const origin=new URL(server);assert(['http:','https:'].includes(origin.protocol)&&!origin.username&&!origin.password,'服务器地址无效');
  return async(route,{method='GET',body,bytes=false,maximum=1024*1024}={})=>{
    const url=new URL(route,origin);assert(url.origin===origin.origin&&url.pathname.startsWith('/creation-api/'),'拒绝向其他地址发送创作凭据');
    const response=await fetch(url,{method,redirect:'error',headers:{Authorization:`Bearer ${token}`,Origin:origin.origin,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>maximum){await response.body.cancel?.().catch(()=>{});throw Error('服务器响应超过固定清单上限');}chunks.push(chunk);}
    const value=Buffer.concat(chunks);if(!response.ok){let error;try{error=JSON.parse(value);}catch{}throw Object.assign(Error(error?.error??`请求失败 ${response.status}`),{status:response.status,details:error?.details});}
    return bytes?value:JSON.parse(value);
  };
}
export async function prepareNativeClient({request,checkout,directory,onProgress=()=>{}}){
  assert(checkout?.protocol==='wa-native-client-1'&&Array.isArray(checkout.files)&&checkout.files.length&&checkout.files.length<=50000&&hashJson(checkout.files)===checkout.manifest_hash,'固定客户端清单无效');
  let total=0;const paths=new Set();
  for(const file of checkout.files){assert(isSafe(file.path)&&!paths.has(file.path)&&/^[a-f0-9]{64}$/.test(file.sha256)&&Number.isSafeInteger(file.size)&&file.size>=0,'客户端文件身份无效');paths.add(file.path);total+=file.size;}
  assert(paths.has('project.godot')&&paths.has('atelier_runtime/release.json')&&total<=1024*1024*1024,'客户端工程不完整或超过 1 GiB 上限');
  const base=await safeDirectory(directory),objects=await safeDirectory(join(base,'objects')),projects=await safeDirectory(join(base,'projects')),project=join(projects,checkout.manifest_hash);
  let downloaded=0,reused=0,cursor=0;
  await Promise.all(Array.from({length:4},async()=>{
    for(;;){const index=cursor++;if(index>=checkout.files.length)return;const file=checkout.files[index],cache=join(objects,file.sha256),stat=await exists(cache);
      if(stat?.isFile()&&!stat.isSymbolicLink()&&stat.size===file.size&&await shaFile(cache)===file.sha256){reused+=file.size;onProgress({downloaded,reused,total});continue;}
      if(stat)throw Error('本地客户端缓存已变化，原件保留：'+file.sha256);
      const route=`/creation-api/native-clients/checkouts/${encodeURIComponent(checkout.id)}/files/`+file.path.split('/').map(encodeURIComponent).join('/');
      const bytes=await request(route,{bytes:true,maximum:file.size+1});assert(bytes.length===file.size&&digest(bytes)===file.sha256,'客户端下载校验失败：'+file.path);
      const temporary=join(objects,file.sha256+'.'+randomUUID()+'.part');await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
      try{await rename(temporary,cache);}finally{await rm(temporary,{force:true});}downloaded+=bytes.length;onProgress({downloaded,reused,total});
    }
  }));
  const verify=async root=>{for(const file of checkout.files){const path=join(root,file.path),stat=await lstat(path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===file.size&&(await realpath(path)).startsWith((await realpath(root))+sep)&&await shaFile(path)===file.sha256,'固定客户端副本已变化：'+file.path);}};
  if(await exists(project))await verify(project);
  else{
    const stage=await safeDirectory(join(projects,'.preparing-'+randomUUID()));
    try{for(const file of checkout.files){const target=join(stage,file.path);await safeDirectory(dirname(target));await copyFile(join(objects,file.sha256),target);}await verify(stage);await rename(stage,project);}catch(error){await rm(stage,{recursive:true,force:true});throw error;}
  }
  await writeFile(join(base,'latest-client.json'),JSON.stringify({format:1,checkout_id:checkout.id,project_id:checkout.project_id,branch_id:checkout.branch_id,resource_id:checkout.resource_id,world_id:checkout.world_id,game_build_id:checkout.game_build_id,runtime_build_id:checkout.runtime_build_id,manifest_hash:checkout.manifest_hash,project_directory:project,downloaded_bytes:downloaded,reused_bytes:reused},null,2)+'\n',{mode:0o600});
  return {directory:base,project,downloaded_bytes:downloaded,reused_bytes:reused,total_bytes:total};
}

async function verifyEngine(engine,checkout){
  const path=await realpath(engine),stat=await lstat(path);assert(stat.isFile(),'Godot 程序不存在');
  if(checkout.engine_identity?.sha256)assert(stat.size===checkout.engine_identity.size&&await shaFile(path)===checkout.engine_identity.sha256,'本机 Godot 与固定客户端工具链不匹配');
  const {stdout}=await exec(path,['--headless','--audio-driver','Dummy','--version'],{timeout:15000,maxBuffer:4000});assert(stdout.trim()===checkout.engine,'Godot 版本与固定工程不匹配：'+stdout.trim());
  if(checkout.engine_bundle){
    const mark=path.indexOf('.app/');assert(mark>=0,'此固定工程需要匹配的 Godot.app');const root=path.slice(0,mark+4),files=[];
    for(const file of checkout.engine_bundle.files){assert(isSafe(file.path),'工具链文件路径无效');const full=join(root,file.path),stat=await lstat(full);assert(stat.isFile()&&!stat.isSymbolicLink(),'工具链文件无效');files.push({path:file.path,sha256:await shaFile(full),size:stat.size});}
    assert(hashJson(files)===checkout.engine_bundle.sha256,'Godot.app 文件与固定工具链不一致');
  }
  return path;
}
async function launch({request,checkout,prepared,engine,headless=false,timeout=0,onStatus=()=>{}}){
  const executable=await verifyEngine(engine,checkout),access=await request(`/creation-api/native-clients/checkouts/${checkout.id}/access`,{method:'POST',body:{}});
  assert(access.protocol==='wa-native-client-1'&&access.checkout.manifest_hash===checkout.manifest_hash,'接续票据与已下载工程不匹配');
  const execution=await safeDirectory(join(prepared.directory,'executions',randomUUID())),config=join(execution,'launch.json');
  await writeFile(config,JSON.stringify({format:'wa-native-client-launch-1',ticket:access.ticket,websocket_url:access.websocket_url,runtime_instance_id:randomUUID()})+'\n',{flag:'wx',mode:0o600});
  const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','DISPLAY','XDG_RUNTIME_DIR'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));env.WA_NATIVE_CLIENT_CONFIG=config;env.GODOT_SILENCE_ROOT_WARNING='1';
  const args=[...(headless?['--headless','--audio-driver','Dummy','--max-fps','30']:[]),'--path',prepared.project,'--log-file',join(execution,'godot.log')];
  const log=await open(join(execution,'telemetry.jsonl'),'a',0o600);
  const child=spawn(executable,args,{env,cwd:execution,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  let partial='',errorTail='',active=false,closed=false;
  const stop=()=>{if(!closed)try{process.platform==='win32'?child.kill('SIGTERM'):process.kill(-child.pid,'SIGTERM');}catch{}};
  const deadline=timeout>0?setTimeout(stop,timeout*1000):null;
  child.stdout.on('data',chunk=>{partial+=chunk.toString();let end;while((end=partial.indexOf('\n'))>=0){const line=partial.slice(0,end);partial=partial.slice(end+1);if(line.startsWith('NATIVE_CLIENT_STATUS '))try{const packet=JSON.parse(line.slice(21));active||=packet.status==='active';void log.write(JSON.stringify(packet)+'\n').catch(error=>{errorTail='客户端日志保存失败：'+error.message;});onStatus(packet);}catch{}}if(partial.length>128000)partial=partial.slice(-64000);});
  child.stderr.on('data',chunk=>{errorTail=(errorTail+chunk.toString()).slice(-4000);});
  const done=new Promise((resolvePromise,reject)=>{
    child.once('error',reject);child.once('close',async(code,signal)=>{closed=true;if(deadline)clearTimeout(deadline);await log.close();await rm(config,{force:true});resolvePromise({code,signal,active,execution,error:errorTail});});
  });
  return {child,done,stop,execution,get active(){return active;}};
}

async function password(){
  assert(process.stdin.isTTY,'请通过 WORLD_ATELIER_TOKEN 提供当前登录，或在终端使用 --login=账号');
  process.stdout.write('密码（不回显）：');process.stdin.setRawMode(true);process.stdin.resume();let text='';
  return new Promise((resolvePromise,reject)=>{
    const finish=(error)=>{process.stdin.off('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolvePromise(text);};
    const data=bytes=>{for(const char of bytes.toString()){if(char==='\u0003'){finish(Error('已取消登录'));return;}if(char==='\r'||char==='\n'){finish();return;}if(char==='\u007f'||char==='\b')text=[...text].slice(0,-1).join('');else if(char>=' '&&text.length<200)text+=char;}};
    process.stdin.on('data',data);
  });
}
async function main(){
  const argv=process.argv.slice(2),command=argv.shift()??'help',args={};for(const arg of argv){const match=/^--([a-z-]+)(?:=(.*))?$/.exec(arg);assert(match&&!Object.hasOwn(args,match[1]),'参数须使用唯一 --key=value');args[match[1]]=match[2]??true;}
  if(command==='help'||!['prepare','connect'].includes(command)){console.log('用法：node native-client.mjs connect --server=http://127.0.0.1:48910 --project=游戏ID --branch=main --scene=场景ID --dir=缓存目录 [--login=账号] [--headless --timeout=60]\n已有登录可使用 WORLD_ATELIER_TOKEN 环境变量；凭据不传给游戏进程。prepare 仅准备固定客户端，不接管角色。');return;}
  const server=args.server??'http://127.0.0.1:48910',project=args.project,branch=args.branch??'main',resource=args.scene;assert(project&&resource,'请明确 --project 和 --scene');
  let token=process.env.WORLD_ATELIER_TOKEN;
  if(!token&&args.login){const origin=new URL(server).origin,response=await fetch(origin+'/creation-api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({name:args.login,password:await password()}),redirect:'error'}),value=await response.json();assert(response.ok,value.error??'登录失败');token=value.token;}
  assert(token,'请设置 WORLD_ATELIER_TOKEN，或使用 --login=账号 在终端登录');
  const request=clientRequest(server,token),directory=resolve(args.dir??'.local/native-client'),engine=String(args.engine??process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot');
  const locks=await safeDirectory(directory),lock=join(locks,'launcher.lock');let lockFile;
  const acquire=async()=>{const handle=await open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,started_at:Date.now()}));return handle;};
  try{lockFile=await acquire();}catch(error){
    if(error.code!=='EEXIST')throw error;
    const recoveryPath=join(locks,'launcher-recovery.lock');let recovery;
    try{recovery=await open(recoveryPath,'wx',0o600);}catch{throw Error('另一个启动器正在恢复此目录，请稍后重试');}
    try{
      let stale=false,prior;
      try{prior=await readFile(lock,'utf8');const owner=JSON.parse(prior);if(Number.isSafeInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(status){stale=status.code==='ESRCH';}}catch{}
      if(!stale||await readFile(lock,'utf8')!==prior)throw Error('此客户端目录已有启动器；核对原进程后再继续，未删除锁或覆盖工作区');
      await rm(lock);lockFile=await acquire();
    }finally{await recovery.close();await rm(recoveryPath,{force:true});}
  }
  let current=null,pending=null,stopping=false,completed=0;
  const stop=()=>{stopping=true;current?.stop();pending?.stop();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  const prepare=async()=>{const checkout=await request('/creation-api/native-clients/checkouts',{method:'POST',body:{request_id:randomUUID(),project_id:project,branch_id:branch,resource_id:resource}});const prepared=await prepareNativeClient({request,checkout,directory});console.log(JSON.stringify({stage:'prepared',checkout_id:checkout.id,source_revision:checkout.source_revision,runtime_build_id:checkout.runtime_build_id,downloaded_bytes:prepared.downloaded_bytes,reused_bytes:prepared.reused_bytes}));return {checkout,prepared};};
  try{
    let next=await prepare();if(command==='prepare')return;
    let upgraded=false;
    const start=async input=>launch({request,...input,engine,headless:args.headless===true,timeout:Number(args.timeout)||0,onStatus:packet=>{
      console.log(JSON.stringify(packet));if(packet.status==='upgrade_required')upgraded=true;
    }});
    current=await start(next);
    for(;;){
      const result=await Promise.race([current.done,new Promise(resolve=>setTimeout(()=>resolve(null),500))]);
      if(stopping){await current.done;break;}
      if(upgraded&&args['no-follow']!==true&&!pending){
        upgraded=false;
        try{
          next=await prepare();pending=await start(next);
          const deadline=Date.now()+90000;while(!pending.active&&!stopping&&Date.now()<deadline){const exited=await Promise.race([pending.done,new Promise(resolve=>setTimeout(()=>resolve(null),250))]);if(exited)throw Error(exited.error||'新客户端未确认接续');}
          assert(pending.active,'新客户端未确认接续，旧画面与服务器进度保留');current.stop();await current.done;current=pending;pending=null;completed++;continue;
        }catch(error){pending?.stop();await pending?.done;pending=null;console.error('客户端更新未接续：'+error.message);}
      }
      if(result){if(result.code!==0&&!(args.timeout&&result.signal==='SIGTERM'&&result.active))throw Error(result.error||(result.active?'共享客户端连接已结束，需要重新接续':'客户端未取得实际控制权'));break;}
    }
    console.log(JSON.stringify({stage:'closed',completed_transfers:completed}));
  }finally{stop();await Promise.allSettled([current?.done,pending?.done].filter(Boolean));await lockFile.close();await rm(lock,{force:true});process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
