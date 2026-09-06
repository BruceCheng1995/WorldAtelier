import {readFileSync,writeFileSync,mkdirSync,watch,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';

const [command,...values]=process.argv.slice(2);
const args=Object.fromEntries(values.map(x=>{const [key,...v]=x.replace(/^--/,'').split('=');return [key,v.join('=')];}));
const server=(args.server??'http://127.0.0.1:48900').replace(/\/$/,'');
const directory=resolve(args.dir??'.local/workspace');
const token=process.env.WORLD_ATELIER_TOKEN;
if(!token)throw Error('Set WORLD_ATELIER_TOKEN for your account');
async function api(path,body){const response=await fetch(server+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(body?{'Idempotency-Key':crypto.randomUUID()}:{})},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));return result;}
if(command==='checkout'){
  if(!args.project)throw Error('--project=ID required');
  const workspace=await api(`/api/projects/${args.project}/branches/${args.branch??'main'}/offline`);mkdirSync(directory,{recursive:true});
  if(existsSync(join(directory,'workspace.json')))throw Error('Workspace already exists; choose another directory to preserve local changes');
  writeFileSync(join(directory,'workspace.json'),JSON.stringify(workspace,null,2));writeFileSync(join(directory,'content.json'),JSON.stringify(workspace.content,null,2));console.log(`工作区已下载：${directory}\n离线编辑 content.json；联网后运行 watch 或 push。`);
}else if(['push','watch'].includes(command)){
  let busy=false,dirty=false,timer;
  async function push(){
    if(busy){dirty=true;return;}busy=true;
    try {
      const workspace=JSON.parse(readFileSync(join(directory,'workspace.json'),'utf8')),content=JSON.parse(readFileSync(join(directory,'content.json'),'utf8'));
      if(JSON.stringify(content)===JSON.stringify(workspace.content)){console.log('没有内容修改');return;}
      const path=`/api/projects/${workspace.project_id}/branches/${workspace.branch}`;
      console.log('上传基于 '+workspace.base_revision+' 的内容差异…');
      const committed=await api(path+'/import',{...workspace,content,message:args.message??'外部工作区实时编辑'});
      workspace.base_revision=committed.revision;workspace.content=committed.content;writeFileSync(join(directory,'workspace.json'),JSON.stringify(workspace,null,2));
      const scheduled=await api(path+'/build',{});let build=scheduled.build;
      while(['queued','running'].includes(build.status)){await new Promise(r=>setTimeout(r,500));build=(await api(`/api/projects/${workspace.project_id}`)).builds.find(x=>x.id===build.id);}
      if(build.status!=='passed')throw Error(`构建 ${build.status}: ${build.error??build.log??''}`);
      console.log('已发布 '+build.release_id);
      if(args.world){const applied=await api(`/api/worlds/${args.world}/apply-latest`,{});console.log(`世界实际应用成功：${applied.world.release_id}，持久化水位 ${applied.sequence}`);}
    }catch(e){console.error(e.message);console.error('本地文件保留；冲突或候选失败未覆盖在线可玩版本。');if(command==='push')process.exitCode=1;}
    finally{busy=false;if(dirty){dirty=false;push();}}
  }
  await push();
  if(command==='watch'){watch(directory,(_,filename)=>{if(filename==='content.json'){clearTimeout(timer);timer=setTimeout(push,450);}});console.log('正在监听 content.json，Ctrl+C 停止。');}
}else throw Error('Usage: node tools/workspace.mjs checkout|push|watch --project=ID --branch=main --dir=PATH [--world=ID]');
