import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,statSync,renameSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const [key,...value]=a.replace(/^--/,'').split('=');return [key,value.join('=')||true];}));
const server=String(args.server??'http://127.0.0.1:48900').replace(/\/$/,'');
const token=process.env.WORLD_ATELIER_TOKEN;
const cache=resolve(args.cache??join(root,'.local/client-cache'));
async function api(path,body){const response=await fetch(server+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token??''}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw Error(result.error);return result;}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function cachedArtifact(artifact,runtime) {
  if(!/^[a-f0-9]{64}$/.test(runtime)||!artifact.path.startsWith('macos/')||artifact.path.includes('..'))throw Error('Invalid artifact identity');
  const dir=join(cache,runtime);mkdirSync(dir,{recursive:true});const file=join(dir,'client.zip');
  if(!existsSync(file)||hash(readFileSync(file))!==artifact.sha256){console.log('下载固定版本客户端…');const response=await fetch(server+artifact.url,{headers:{Authorization:`Bearer ${token??''}`}});if(!response.ok)throw Error('Client download failed');const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length!==artifact.bytes||hash(bytes)!==artifact.sha256)throw Error('Client integrity verification failed');writeFileSync(file+'.part',bytes);renameSync(file+'.part',file);}
  const apps=readdirSync(dir).filter(x=>x.endsWith('.app'));
  if(!apps.length)await new Promise((resolve,reject)=>{const p=spawn('/usr/bin/unzip',['-q','-o',file,'-d',dir]);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('Client extraction failed')));});
  const app=readdirSync(dir).find(x=>x.endsWith('.app'));if(!app)throw Error('Downloaded client is missing application');
  const binDir=join(dir,app,'Contents/MacOS'),binary=readdirSync(binDir).find(x=>statSync(join(binDir,x)).isFile());return join(binDir,binary);
}
let binary,launchArgs;
if(args.offline){
  const workspace=JSON.parse(readFileSync(resolve(args.offline),'utf8'));
  const rel=workspace.release;
  if(!rel)throw Error('Offline workspace has no pinned release; download a workspace after a successful build');
  const artifact=rel.artifacts.find(a=>a.platform==='macos'&&a.path.endsWith('.zip'));if(!artifact)throw Error('Offline workspace has no desktop export');
  binary=await cachedArtifact(artifact,rel.runtime_hash);
  const workspaceDir=resolve(args.workspace??join(cache,'offline',workspace.project_id,workspace.branch));mkdirSync(workspaceDir,{recursive:true});
  const content=join(workspaceDir,'content.json'),save=join(workspaceDir,'state.json');writeFileSync(content,JSON.stringify(workspace.content,null,2));
  if(!existsSync(save)&&workspace.state_seed)writeFileSync(save,JSON.stringify(workspace.state_seed));
  launchArgs=['--','--role=offline',`--offline-user=${workspace.user_id??'offline-explorer'}`,`--content=${content}`,`--save=${save}`];console.log('进入独立离线世界；进度保存到 '+save);
}else{
  if(!token||!args.project)throw Error('Set WORLD_ATELIER_TOKEN and provide --project=ID; use --offline=workspace.json for an already downloaded workspace');
  const resolved=await api(`/api/projects/${args.project}/checkouts`,{branch:args.branch??'main',platform:'macos',mode:args.mode??'join-live',...(args.world?{world_id:args.world}:{})});
  const artifact=resolved.artifacts.find(a=>a.platform==='macos'&&a.path.endsWith('.zip'));binary=await cachedArtifact(artifact,resolved.release.runtime_hash);
  const prepared=await api(`/api/checkouts/${resolved.checkout.id}/prepare-join`,{});
  launchArgs=['--','--role=client',`--server=${prepared.server_url}`,`--ticket=${prepared.ticket}`];console.log(`启动 ${resolved.release.id}，等待运行端确认进入。`);
}
const child=spawn(binary,launchArgs,{stdio:'inherit'});child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
