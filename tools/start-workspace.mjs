import net from 'node:net';
import {workspaceNetwork} from '../services/preview/network.mjs';
import {readFile,open,unlink,mkdir,realpath} from 'node:fs/promises';
import {resolve,dirname,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.WORLD_ATELIER_PREVIEW_PORT??48910);
const network=workspaceNetwork(port);
const url=`http://127.0.0.1:${port}/creation-workspace.html`;
const listening=()=>new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',error=>resolve(error.code==='ECONNREFUSED'?false:true));socket.once('timeout',()=>{socket.destroy();resolve(true);});});
async function existing(){
  if(!await listening())return false;
  try{
    const health=await fetch(`http://127.0.0.1:${port}/preview-api/health`,{signal:AbortSignal.timeout(2500)});
    const body=await health.json();
    if(!health.ok||!body.ok||body.service!=='model-preview')throw new Error('服务身份不匹配');
    if(Boolean(body.lan_enabled)!==network.lan||Boolean(body.public_play)!==network.publicPlay)throw new Error('当前服务的局域网或公共试玩设置与启动配置不同，请按开发文档受控重启');
    const response=await fetch(url,{signal:AbortSignal.timeout(2500)});
    if(!response.ok||await response.text()!==await readFile(resolve(root,'apps/creation-workspace/index.html'),'utf8'))throw new Error('工作台不是当前工程文件');
  }catch(error){throw new Error(`端口 ${port} 已被占用，但未确认是当前工作台：${error.message}。请检查监听进程；不会换端口或再启动一份。`);}
  console.log(`复用已运行的世界工坊：\n${network.urls().join('\n')}`);return true;
}
async function main(){
  if(existsSync(resolve(process.env.WORLD_ATELIER_CREATION_DATA??resolve(root,'.local/model-preview/creation'),'.native-migration.lock')))throw new Error('原生源稿迁移正在维护数据，暂不能启动工作台。异常退出后先核对锁中的进程，再按开发文档恢复。');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('无效的工作台端口');
  if(port!==48910&&(!process.env.WORLD_ATELIER_PREVIEW_DATA||!process.env.WORLD_ATELIER_CREATION_DATA))throw new Error('其他端口仅用于显式隔离测试，必须同时指定独立 PREVIEW_DATA 与 CREATION_DATA；日常工作台使用 48910。');
  if(port!==48910){
    const canonical=async path=>{try{return await realpath(path);}catch(error){if(error.code!=='ENOENT')throw error;return resolve(await canonical(dirname(path)),basename(path));}};
    const paths=await Promise.all([process.env.WORLD_ATELIER_PREVIEW_DATA,process.env.WORLD_ATELIER_CREATION_DATA,resolve(root,'.local/model-preview')].map(path=>canonical(resolve(path))));
    const overlaps=(a,b)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
    if(paths[0]===paths[1]||paths.slice(0,2).some(path=>overlaps(path,paths[2])))throw new Error('隔离测试的数据目录不能相同，也不能与正式 .local/model-preview 数据目录重叠（包括符号链接）。');
  }
  if(await existing())return;
  // Serialise starters before constructing the service or opening its database.
  const lock=resolve(root,`.local/workspace-${port}.start.lock`);await mkdir(dirname(lock),{recursive:true});
  let handle;
  try{handle=await open(lock,'wx');}catch(error){if(error.code==='EEXIST')throw new Error(`另一个启动命令正在管理端口 ${port}。请复用 ${url}；若进程已异常退出，按 docs/LOCAL-DEVELOPMENT.md 核对锁文件。`);throw error;}
  try{
    await handle.writeFile(JSON.stringify({pid:process.pid,port,root,created_at:new Date().toISOString()}));
    if(await existing())return;
    console.log(`启动世界工坊：${url}`);
    const child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,stdio:'inherit',env:process.env});
    const interrupt=()=>child.kill('SIGINT'),terminate=()=>child.kill('SIGTERM');
    process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
    try{process.exitCode=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',(code,signal)=>yes(code??(signal?1:0)));});}
    finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
  }finally{await handle.close();await unlink(lock);}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
