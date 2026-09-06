import {mkdir,readFile,writeFile,rename,rm,cp,chmod,stat,readdir} from 'node:fs/promises';
import {join,resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {hash,atomicWrite,jsonFile,createApi,materialize,desktopArtifact,ensureRuntime,validateCandidate,runNative,cleanSource,pause} from './runtime.mjs';
import {createNativeEditor} from './native-editor.mjs';
const HERE=dirname(fileURLToPath(import.meta.url));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clone=v=>v===undefined?undefined:structuredClone(v);
export function mergeThree(base,local,remote,path='$',conflicts=[]){
  if(equal(local,base))return {value:clone(remote),conflicts};
  if(equal(remote,base)||equal(local,remote))return {value:clone(local),conflicts};
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  if(object(base)&&object(local)&&object(remote)){
    const value={};for(const key of new Set([...Object.keys(base),...Object.keys(remote),...Object.keys(local)])){const merged=mergeThree(base[key],local[key],remote[key],`${path}.${key}`,conflicts).value;if(merged!==undefined)value[key]=merged;}return {value,conflicts};
  }
  const keyed=a=>Array.isArray(a)&&a.every(v=>object(v)&&typeof v.id==='string')&&new Set(a.map(v=>v.id)).size===a.length;
  if(keyed(base)&&keyed(local)&&keyed(remote)){
    const b=new Map(base.map(v=>[v.id,v])),l=new Map(local.map(v=>[v.id,v])),r=new Map(remote.map(v=>[v.id,v])),value=[];
    for(const id of new Set([...remote.map(v=>v.id),...local.map(v=>v.id),...base.map(v=>v.id)])){const merged=mergeThree(b.get(id),l.get(id),r.get(id),`${path}[${id}]`,conflicts).value;if(merged!==undefined)value.push(merged);}return {value,conflicts};
  }
  conflicts.push({path,base,local,remote});return {value:clone(local),conflicts};
}
async function lock(directory,action){
  const path=join(directory,'.workspace-lock');
  try{await mkdir(path);}catch(e){if(e.code!=='EEXIST')throw e;const previous=await jsonFile(join(path,'owner.json'),{});if(!previous.pid&&Date.now()-(await stat(path)).mtimeMs<30000)throw Error('Another workspace command is acquiring the lock; retry shortly');let alive=false;try{process.kill(previous.pid,0);alive=true;}catch{}if(alive)throw Error('Another workspace command is still running');await rm(path,{recursive:true,force:true});await mkdir(path);}
  await atomicWrite(join(path,'owner.json'),{pid:process.pid,started_at:Date.now()});
  try{return await action();}finally{await rm(path,{recursive:true,force:true});}
}
async function writeTransaction(directory,workspace,before,after){
  const transaction={id:randomUUID(),workspace,before,after,at:Date.now()};
  await atomicWrite(join(directory,'.pending-transaction.json'),transaction);
  await recoverTransaction(directory);
}
async function recoverTransaction(directory){
  const path=join(directory,'.pending-transaction.json'),tx=await jsonFile(path,null);if(!tx)return;
  const disk=await jsonFile(join(directory,'content.json'));
  let next=tx.after,conflicts=[];
  if(!equal(disk,tx.before)&&!equal(disk,tx.after))({value:next,conflicts}=mergeThree(tx.before,disk,tx.after));
  if(conflicts.length){await atomicWrite(join(directory,'local-conflicts.json'),{...tx,local:disk,merged:tx.after,conflicts});await atomicWrite(join(directory,'workspace.json'),tx.workspace);await rm(path);throw Error('Local edits changed while publishing files; conflicts preserved in local-conflicts.json');}
  // Journal first, then replace each file atomically. Recovery handles either boundary.
  await atomicWrite(join(directory,'content.json'),next);
  await atomicWrite(join(directory,'workspace.json'),tx.workspace);
  await rm(path);
}
async function checkWorkspace(directory){await recoverTransaction(directory);if(await jsonFile(join(directory,'local-conflicts.json'),null))throw Error('Unresolved local replay conflict; inspect local-conflicts.json and run resolve --accept-current after editing content.json');return await jsonFile(join(directory,'workspace.json'));}
export async function checkoutWorkspace({directory,server,token,project,branch='main',log=console.log}){
  directory=resolve(directory);
  try{await stat(directory);throw Error('Destination already exists; choose another directory to preserve local edits and saves');}catch(e){if(e.code!=='ENOENT')throw e;}
  await mkdir(dirname(directory),{recursive:true});const staging=directory+'.download-'+randomUUID();await mkdir(staging);
  try{
    const api=createApi({server,token,journalDir:join(staging,'.operations')});
    const workspace=await api(`/api/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}/offline`);
    if(!workspace.workspace_id||!workspace.user_id||!workspace.content||!workspace.play_content)throw Error('Server did not provide a complete source/playable offline workspace');
    const artifact=desktopArtifact(workspace.release);
    if(hash(workspace.play_content)!==workspace.release.content_hash)throw Error('Playable content SHA-256 does not match release manifest');
    if(!/^[A-Za-z0-9_-]+$/.test(workspace.user_id))throw Error('Invalid offline user identity');
    if(workspace.play_revision!==workspace.release.revision||workspace.release_id!==workspace.release.id)throw Error('Offline playable identity mismatch');
    if(!equal(materialize(workspace.play_content,workspace.play_content.asset_blobs),workspace.play_content))throw Error('Playable asset closure is inconsistent');
    if(workspace.state_seed&&workspace.state_seed_release!==workspace.release.id)throw Error('Checkpoint does not match pinned playable release');
    const runtime=await ensureRuntime({artifact,runtimeHash:workspace.release.runtime_hash,cacheDir:join(staging,'client'),server,token,log});
    workspace.local={format:1,workspace_id:workspace.workspace_id,owner_user_id:workspace.user_id,created_at:Date.now(),runtime_binary:relative(staging,runtime.binary),runtime_archive:relative(staging,runtime.archive),runtime_sha256:artifact.sha256,state_domain:randomUUID(),source_verified:false};
    await atomicWrite(join(staging,'workspace.json'),workspace);
    await atomicWrite(join(staging,'content.json'),cleanSource(workspace.content));
    await atomicWrite(join(staging,'play-content.json'),workspace.play_content);
    await atomicWrite(join(staging,'source-assets.json'),workspace.source_assets??{});
    const seedFile=join(staging,'seed-state.json');if(workspace.state_seed)await atomicWrite(seedFile,workspace.state_seed);
    await mkdir(join(staging,'launcher'));for(const file of ['runtime.mjs','workspace.mjs','workspace-cli.mjs','launch.mjs','native-editor.mjs'])await cp(join(HERE,file),join(staging,'launcher',file));
    let templateRoot=join(HERE,'native-editor-template');try{await stat(templateRoot);}catch{templateRoot=resolve(HERE,'../../tools/native-editor/template');}
    await cp(templateRoot,join(staging,'launcher/native-editor-template'),{recursive:true});
    if(!workspace.source_preparation_error)await createNativeEditor({directory:staging,templateRoot});
    else await atomicWrite(join(staging,'NATIVE-EDITOR-UNAVAILABLE.txt'),`Source dependencies unavailable: ${workspace.source_preparation_error}\nRefresh assets, then run node launcher/workspace-cli.mjs editor --dir=.\n`);
    const identity=hash({user:workspace.user_id,workspace:workspace.workspace_id,domain:workspace.local.state_domain,mode:'playable',release:workspace.release.id}).slice(0,24);
    const stateDir=join(staging,'saves',identity);await mkdir(stateDir,{recursive:true});
    if(workspace.state_seed)await atomicWrite(join(stateDir,'state.json'),workspace.state_seed);
    await atomicWrite(join(stateDir,'identity.json'),{user_id:workspace.user_id,workspace_id:workspace.workspace_id,mode:'playable',release_id:workspace.release.id,state_origin:workspace.state_origin});
    const binary=workspace.local.runtime_binary;if(!/^[a-zA-Z0-9_./ -]+$/.test(binary)||binary.includes('..'))throw Error('Unsupported executable path for portable launch');
    // The playable baseline can launch without Node, a repository, or a connection.
    const extractionReceipt=await jsonFile(join(staging,'client',workspace.release.runtime_hash,'extracted','extraction.json'));
    const checksums=extractionReceipt.files.filter(f=>f.sha256).map(f=>`${f.sha256}  client/${workspace.release.runtime_hash}/extracted/app/${f.path}`).join('\n')+'\n'+hash(await readFile(join(staging,'play-content.json')))+'  play-content.json\n';
    await atomicWrite(join(staging,'PLAYABLE-SHA256.txt'),checksums);
    const command=`#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\n/usr/bin/shasum -a 256 -c PLAYABLE-SHA256.txt >/dev/null\nexec "./${binary}" -- --role=offline --offline-user='${workspace.user_id}' --content="$PWD/play-content.json" --save="$PWD/saves/${identity}/state.json" "$@"\n`;
    await atomicWrite(join(staging,'Play offline.command'),command,{mode:0o700});
    await atomicWrite(join(staging,'OFFLINE-README.txt'),`World Atelier portable offline workspace\n\nDouble-click Play offline.command to play the pinned verified baseline without Node or network. It never downloads files.\n\nEdit content.json as source. To validate and play edits in a separate save domain:\nnode launcher/launch.mjs --offline=workspace.json --edited\n\nReconnect and import source (requires Node and WORLD_ATELIER_TOKEN):\nnode launcher/workspace-cli.mjs push --dir=. --server=http://YOUR-SERVICE\n\nDefault playable revision: ${workspace.play_revision}\nEditable source revision: ${workspace.base_revision}\nSource ahead of playable: ${workspace.source_ahead_of_playable}\nUser: ${workspace.user_id}\n\nsource-assets.json and play-content.json contain the required GLB/GDScript blobs. Unavailable new asset references are rejected locally. Progress is under saves/ and never included in content imports.\n`);
    await rm(join(staging,'.operations'),{recursive:true,force:true});
    await rename(staging,directory);log(JSON.stringify({stage:'offline_package_ready',directory,workspace_id:workspace.workspace_id,play_revision:workspace.play_revision,base_revision:workspace.base_revision,source_ahead_of_playable:workspace.source_ahead_of_playable,client_sha256:artifact.sha256}));return workspace;
  }catch(e){await rm(staging,{recursive:true,force:true});throw e;}
}
export async function refreshSourceAssets({directory,server,token,workspace,source,api,log=console.log}) {
  directory=resolve(directory);workspace??=await jsonFile(join(directory,'workspace.json'));source??=await jsonFile(join(directory,'content.json'));
  api??=createApi({server,token,journalDir:join(directory,'.operations')});
  const blobs={...(workspace.play_content?.asset_blobs??{}),...await jsonFile(join(directory,'source-assets.json'),{})},needed=new Map();
  for(const object of source.objects??[])if(object.model_asset)needed.set(object.model_asset,'model/gltf-binary');
  for(const module of source.behaviors??[])needed.set(module.asset_hash,'text/x-gdscript');
  let problem=null;
  try {
    for(const [key,mime] of needed){
      if(blobs[key]?.mime===mime&&hash(Buffer.from(blobs[key]?.data_base64??'','base64'))===key)continue;
      const result=await api(`/api/projects/${encodeURIComponent(workspace.project_id)}/assets/${encodeURIComponent(key)}`);
      if(result.asset?.hash!==key||result.asset?.mime!==mime||hash(Buffer.from(result.data_base64??'','base64'))!==key)throw Error(`Received incompatible or corrupt source asset ${key}`);
      blobs[key]={mime,data_base64:result.data_base64};log(JSON.stringify({stage:'source_asset_verified',hash:key,mime}));
    }
    materialize(source,blobs);
    try{await stat(join(directory,'editor/project.godot'));for(const [key,mime] of needed)if(mime==='model/gltf-binary')await atomicWrite(join(directory,'editor/assets',key+'.glb'),Buffer.from(blobs[key].data_base64,'base64'));}catch(error){if(error.code!=='ENOENT')throw error;}
  } catch(error){problem=error.message;}
  await atomicWrite(join(directory,'source-assets.json'),blobs);
  const issue=join(directory,'source-preparation-error.json');
  if(problem)await atomicWrite(issue,{error:problem,at:Date.now(),base_revision:workspace.base_revision,required_hashes:[...needed.keys()]});
  else await rm(issue,{force:true});
  return {assets:blobs,error:problem};
}
export async function pushWorkspace({directory,server,token,message='外部工作区编辑',world,build=true,runtimeHash,log=console.log}){
  directory=resolve(directory);return lock(directory,async()=>{
    let workspace=await checkWorkspace(directory);const local=cleanSource(await jsonFile(join(directory,'content.json')));
    if(equal(local,workspace.content)){const assets=await refreshSourceAssets({directory,server,token,workspace,source:local,log});await atomicWrite(join(directory,'workspace.json'),{...workspace,source_assets:assets.assets,source_preparation_error:assets.error});if(assets.error)throw Error('Source unchanged but offline asset preparation is incomplete: '+assets.error);log('没有内容修改；本地资源依赖完整');return {unchanged:true};}
    const api=createApi({server,token,journalDir:join(directory,'.operations')});const path=`/api/projects/${encodeURIComponent(workspace.project_id)}/branches/${encodeURIComponent(workspace.branch)}`;
    // Import only the source domain; never spread a workspace or runtime materialization.
    const committed=await api(path+'/import',{format:1,project_id:workspace.project_id,branch:workspace.branch,base_revision:workspace.base_revision,content:local,message});
    const assetSync=await refreshSourceAssets({directory,api,workspace,source:committed.content,log});
    const current=cleanSource(await jsonFile(join(directory,'content.json'))),replay=mergeThree(local,current,committed.content);
    workspace={...workspace,base_revision:committed.revision,content:cleanSource(committed.content),source_ahead_of_playable:committed.revision!==workspace.play_revision,source_assets:assetSync.assets,source_preparation_error:assetSync.error,local:{...workspace.local,source_verified:false}};
    const backup=join(directory,'.history',`${Date.now()}-${randomUUID()}`);await mkdir(backup,{recursive:true});await atomicWrite(join(backup,'uploaded.json'),local);await atomicWrite(join(backup,'before-replay.json'),current);await atomicWrite(join(backup,'server-merged.json'),committed.content);
    if(replay.conflicts.length){await atomicWrite(join(directory,'local-conflicts.json'),{base:local,local:current,merged:committed.content,conflicts:replay.conflicts,revision:committed.revision});await atomicWrite(join(directory,'workspace.json'),workspace);throw Error('Server committed the upload, but newer local edits conflict with merged content; local content.json was retained. Resolve local-conflicts.json before pushing again.');}
    await writeTransaction(directory,workspace,current,replay.value);
    if(assetSync.error)throw Error('Source was committed and local edits preserved, but offline dependencies are incomplete; run refresh-assets to retry: '+assetSync.error);
    log(JSON.stringify({stage:'source_committed',revision:committed.revision,local_edits_replayed:!equal(local,current)}));
    if(!build)return {revision:committed.revision,content:replay.value};
    let task=(await api(path+'/build',runtimeHash?{runtime_hash:runtimeHash}:{})).build;const end=Date.now()+180000;
    while(['queued','running','building','validating'].includes(task.status)){if(Date.now()>end)throw Error(`Build ${task.id} is still pending; query its original identity before retrying`);await pause(400);task=(await api(`/api/projects/${encodeURIComponent(workspace.project_id)}`)).builds.find(b=>b.id===task.id);if(!task)throw Error('Build disappeared before its result was known');}
    if(task.status!=='passed')throw Error(`Build ${task.status}: ${task.error??task.log??''}`);
    log(JSON.stringify({stage:'build_passed',build_id:task.id,release_id:task.release_id}));
    let applied;if(world){applied=await api(`/api/worlds/${encodeURIComponent(world)}/apply-latest`,{release_id:task.release_id});log(JSON.stringify({stage:'world_applied',release_id:applied.world.release_id,sequence:applied.sequence}));}
    return {revision:committed.revision,build:task,applied};
  });
}
export async function refreshWorkspaceAssets(options){
  const directory=resolve(options.directory);return lock(directory,async()=>{
    const workspace=await checkWorkspace(directory),result=await refreshSourceAssets({...options,directory,workspace});
    await atomicWrite(join(directory,'workspace.json'),{...workspace,source_assets:result.assets,source_preparation_error:result.error});return result;
  });
}
export async function resolveWorkspace(directory){return lock(resolve(directory),async()=>{const conflict=await jsonFile(join(directory,'local-conflicts.json'));const source=cleanSource(await jsonFile(join(directory,'content.json')));await atomicWrite(join(directory,'.history',`resolved-${Date.now()}.json`),{conflict,accepted:source});await atomicWrite(join(directory,'content.json'),source);await rm(join(directory,'local-conflicts.json'));});}
export async function mergeNativeScene(directory){
  directory=resolve(directory);return lock(directory,async()=>{
    const workspace=await checkWorkspace(directory),editor=join(directory,'editor');
    const base=await jsonFile(join(editor,'import-base.json')),local=cleanSource(await jsonFile(join(editor,'scene-export.json'))),remote=cleanSource(await jsonFile(join(directory,'content.json')));
    if(!local.objects?.length||new Set(local.objects.map(o=>o.id)).size!==local.objects.length)throw Error('Native scene has duplicate IDs or no objects; workspace retained');
    const blobs={...workspace.play_content?.asset_blobs,...await jsonFile(join(directory,'source-assets.json'),{})};materialize(local,blobs);
    const merged=mergeThree(base,local,remote),conflictFile=join(editor,'native-export-conflicts.json');
    if(merged.conflicts.length){await atomicWrite(conflictFile,{base,local,remote,conflicts:merged.conflicts,at:Date.now()});throw Error('Native scene conflicts with workspace edits; content.json is untouched; resolve the conflicting scene fields and save again');}
    await writeTransaction(directory,workspace,remote,merged.value);
    // The scene's acknowledged snapshot is L, not merged M. A stale scene field
    // must never revert an independent web/remote field on the next native save.
    await atomicWrite(join(editor,'import-base.json'),local);await rm(conflictFile,{force:true});
    const receipt={stage:'native_scene_exported',at:Date.now(),source_hash:hash(merged.value),scene_hash:hash(local),base_revision:workspace.base_revision,objects:local.objects.length};
    await atomicWrite(join(editor,'export-receipt.json'),receipt);return receipt;
  });
}
export async function prepareOffline({file,edited=false,newSave=false,options={},log=console.log}){
  file=resolve(file);const directory=dirname(file),workspace=await jsonFile(file);if(!workspace.local||!workspace.play_content)throw Error('Not a complete downloaded offline package; use workspace checkout first');
  await recoverTransaction(directory);
  const artifact=desktopArtifact(workspace.release),runtime=await ensureRuntime({artifact,runtimeHash:workspace.release.runtime_hash,cacheDir:join(directory,'client'),offline:true,log});
  const baseIdentity={user:workspace.user_id,workspace:workspace.workspace_id,domain:workspace.local.state_domain,mode:edited?'edited':'playable',release:workspace.release.id};
  let contentFile=join(directory,'play-content.json'),content=workspace.play_content,validation=null;
  if(edited){
    const source=await jsonFile(join(directory,'content.json')),blobs={...(workspace.play_content.asset_blobs??{}),...await jsonFile(join(directory,'source-assets.json'),{})};
    content=materialize(source,blobs);const candidate=join(directory,'.candidates',hash(content)+'.json');await atomicWrite(candidate,content);
    validation=await validateCandidate(runtime.binary,candidate,join(directory,'.validation',hash(content)+'.log'));contentFile=candidate;
    // Every distinct edited content identity starts its own save unless explicit migration is implemented.
    baseIdentity.content_hash=hash(content);
    log(JSON.stringify({stage:'local_candidate_validated',content_hash:baseIdentity.content_hash,save_policy:'new domain for each distinct validated candidate'}));
  }else{
    const disk=await jsonFile(contentFile);if(!equal(disk,content))throw Error('Pinned playable file changed; source edits belong in content.json and require --edited validation');
    materialize(content,content.asset_blobs);
  }
  if(newSave)baseIdentity.fork=randomUUID();
  const stateId=hash(baseIdentity).slice(0,24),stateDir=join(directory,'saves',stateId);await mkdir(stateDir,{recursive:true});
  const save=join(stateDir,'state.json');
  if(!edited&&!newSave&&workspace.state_seed&&!(await jsonFile(save,null))){if(workspace.state_seed_release!==workspace.release.id)throw Error('Offline state seed release mismatch');await atomicWrite(save,workspace.state_seed);}
  await atomicWrite(join(stateDir,'identity.json'),{...baseIdentity,state_origin:edited?null:workspace.state_origin,validation:validation?{passed:true,sha256:validation.sha256}:null});
  return {runtime,workspace,contentFile,save,stateId,logDir:resolve(options['log-dir']??join(directory,'logs',`${Date.now()}-${randomUUID().slice(0,8)}`)),gameArgs:['--role=offline',`--offline-user=${workspace.user_id}`,`--content=${contentFile}`,`--save=${save}`]};
}
export async function playOffline(args){const prepared=await prepareOffline(args);const receipt=await runNative({binary:prepared.runtime.binary,gameArgs:prepared.gameArgs,options:args.options,logDir:prepared.logDir,log:args.log});return {...receipt,save:prepared.save,state_id:prepared.stateId,workspace_id:prepared.workspace.workspace_id};}
