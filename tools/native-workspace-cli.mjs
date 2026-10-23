#!/usr/bin/env node
import {readFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Writable} from 'node:stream';
import {createInterface} from 'node:readline/promises';
import {NativeWorkspaceClient} from './native-workspace.mjs';

async function interactiveLogin(server,loginName){
  if(!process.stdin.isTTY||!process.stderr.isTTY)throw Error('--login 需要交互终端；非交互执行请使用 WORLD_ATELIER_TOKEN');
  let muted=false;const output=new Writable({write(chunk,_encoding,done){if(!muted)process.stderr.write(chunk);done();}}),reader=createInterface({input:process.stdin,output,terminal:true});
  let name,password;
  try{name=typeof loginName==='string'?loginName:await reader.question('工作台账号：');process.stderr.write('密码：');muted=true;password=await reader.question('');}finally{muted=false;process.stderr.write('\n');reader.close();}
  const origin=new URL(server).origin,response=await fetch(origin+'/creation-api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({name,password}),redirect:'error'});password='';
  const result=await response.json();if(!response.ok||!result.token)throw Error(result.error??result.message??'登录失败');return result.token;
}

export async function nativeWorkspaceMain(argv=process.argv.slice(2)){
  const [command,...values]=argv,options={};for(let i=0;i<values.length;i++){const arg=values[i];if(!arg.startsWith('--'))throw Error('参数需要 --name=value');const at=arg.indexOf('=');if(at<0)options[arg.slice(2)]=true;else options[arg.slice(2,at)]=arg.slice(at+1);}
  if(!command||command==='help')return{usage:'node world-atelier-native-workspace.mjs checkout|status|sync|pull|recover|conflicts|resolve|abort|prepare-play|refresh-runtime --dir=PATH [--server=URL --project=ID --branch=main --login] [--resolutions=FILE --export=PATH --godot=PATH]',authentication:'使用 --login 在当前命令内存中登录，或将令牌放在 WORLD_ATELIER_TOKEN 环境变量；客户端不保存密码或令牌。',workflow:['checkout 固定源工作区并缓存可信运行支持，编辑 project/ 中的原生文件','prepare-play 在断网状态用当前落盘源和匹配 Godot 4.6 装配统一 GameRuntime 工程，包含未提交修改与新增场景','sync 仅上传缺少的文件，细粒度合并后回放上传期间的本地编辑','pull 保留本地修改并读取中央更新，不提交本地修改','conflicts --export=新目录 导出三方材料；编辑 resolutions.json 后 resolve --resolutions=文件','recover 恢复断线、服务器已提交或本地批量替换中断','refresh-runtime 联网更新可信运行支持和工具链身份；生成文件不进入源同步'],boundary:'离线源稿与独立存档、共享世界状态分开；保存 Godot 编辑器缓冲区后再同步。离线装配目前需要本机受支持的隔离环境。'};
  if(!options.dir||typeof options.dir!=='string')throw Error('请指定 --dir=工作区目录');
  const client=new NativeWorkspaceClient({directory:options.dir,server:options.server,token:process.env.WORLD_ATELIER_TOKEN,log:event=>process.stderr.write(JSON.stringify(event)+'\n')});
  if(options.login){let server=options.server;if(!server){try{server=client.state().server;}catch{server=JSON.parse(readFileSync(client.operationPath,'utf8')).server;}}client.token=await interactiveLogin(server,options.login);}
  const resolutions=options.resolutions?JSON.parse(readFileSync(resolve(options.resolutions),'utf8')):{};
  if(command==='checkout'){if(!options.server||!options.project)throw Error('checkout 需要 --server=URL 和 --project=ID');return client.checkout({project_id:options.project,branch_id:options.branch??'main',revision:options.revision});}
  if(command==='status')return client.status();
  if(command==='sync')return client.synchronize({resolutions,replan:options.replan===true});
  if(command==='pull')return client.pull({resolutions});
  if(command==='recover'||command==='resolve')return client.recover({resolutions,replan:options.replan===true});
  if(command==='conflicts')return client.conflicts({exportDirectory:options.export});
  if(command==='abort')return client.abort();
  if(command==='prepare-play'){const result=await client.preparePlay({godotPath:options.godot});return{directory:result.directory,project:result.project,revision:result.revision,source_identity:result.source_identity,entry_scene_id:result.entry_scene_id,scene_count:result.scenes.length,local_edits_included:result.local_edits_included,source_modified:result.source_modified,network_required:result.network_required,reused:result.reused};}
  if(command==='refresh-runtime')return client.refreshRuntime();
  throw Error('未知命令，请运行 help');
}

if(process.argv[1]&&pathToFileURL(realpathSync(resolve(process.argv[1]))).href===import.meta.url)nativeWorkspaceMain().then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write(JSON.stringify({error:error.message,code:error.code,status:error.status,details:error.details})+'\n');process.exitCode=1;});
