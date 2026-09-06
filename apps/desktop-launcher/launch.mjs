import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseArgs,createApi,desktopArtifact,ensureRuntime,runNative,atomicWrite} from './runtime.mjs';
import {playOffline} from './workspace.mjs';

export async function launch(options={}){
  if(options.offline)return playOffline({file:options.offline,edited:!!options.edited,newSave:!!options['new-save'],options});
  const server=String(options.server??'http://127.0.0.1:48900').replace(/\/$/,''),token=process.env.WORLD_ATELIER_TOKEN;
  if(!token||!options.project)throw Error('Online launch requires WORLD_ATELIER_TOKEN and --project=ID. For a complete downloaded package use --offline=/path/workspace.json.');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),cacheDir=resolve(options.cache??join(root,'.local/client-cache'));
  const logDir=resolve(options['log-dir']??join(cacheDir,'sessions',`${Date.now()}-${randomUUID().slice(0,8)}`));
  const api=createApi({server,token,journalDir:join(cacheDir,'.operations')});
  const account=(await api('/api/me')).user;
  const checkout=await api(`/api/projects/${encodeURIComponent(options.project)}/checkouts`,{branch:options.branch??'main',platform:'macos',mode:options.mode??'join-live',...(options.world?{world_id:options.world}:{})});
  const artifact=desktopArtifact(checkout.release),runtime=await ensureRuntime({artifact,runtimeHash:checkout.release.runtime_hash,cacheDir,server,token});
  const target=await api(`/api/checkouts/${encodeURIComponent(checkout.checkout.id)}/prepare-join`,{});
  // Keep credentials out of manifests, diagnostics and launch receipts.
  await atomicWrite(join(logDir,'target.json'),{project_id:options.project,branch:options.branch??'main',checkout_id:checkout.checkout.id,world_id:target.world_id,release_id:target.release_id,runtime_hash:checkout.release.runtime_hash,client_sha256:artifact.sha256,user_id:account.id});
  return runNative({binary:runtime.binary,gameArgs:['--role=client',`--server=${target.server_url}`,`--ticket=${target.ticket}`],options,logDir,expected:{world_id:target.world_id,release_id:target.release_id,user_id:account.id}});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  launch(parseArgs(process.argv.slice(2))).then(result=>console.log(JSON.stringify({stage:'native_session_finished',active_confirmed:result.active_confirmed,log:result.output_file,save:result.save}))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
