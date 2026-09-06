import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,rename,rm,readdir,lstat,readlink,chmod,mkdtemp,appendFile} from 'node:fs/promises';
import {join,resolve,relative,dirname,isAbsolute} from 'node:path';

export const execute=promisify(execFile);
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function jsonFile(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT'&&arguments.length>1)return fallback;throw e;}}
export async function atomicWrite(file,content,{mode=0o600}={}){await mkdir(dirname(file),{recursive:true});const temp=`${file}.${randomUUID()}.part`;await writeFile(temp,typeof content==='string'||Buffer.isBuffer(content)?content:JSON.stringify(content,null,2)+'\n',{mode});await rename(temp,file);}
export function safeInside(root,path){if(typeof path!=='string'||isAbsolute(path)||path.includes('\\')||path.split('/').some(p=>p==='..'))throw Error('Unsafe relative package path');const file=resolve(root,path);if(!file.startsWith(resolve(root)+'/'))throw Error('Path escapes package');return file;}
export function parseArgs(values){return Object.fromEntries(values.map(arg=>{const [key,...parts]=arg.replace(/^--/,'').split('=');return [key,parts.length?parts.join('='):true];}));}
export function cleanSource(content){const source=structuredClone(content);delete source.asset_blobs;delete source.state;delete source.state_seed;delete source.players;delete source.runtime_fault;return source;}
export function desktopArtifact(release){if(release?.status!=='ready'||release.schema!==1)throw Error('A healthy schema 1 playable release is required');const a=release.artifacts?.find(a=>a.platform==='macos'&&a.path.endsWith('.zip'));if(!a)throw Error('Pinned release has no macOS archive');return a;}
export function materialize(source,blobs={}){
  const content=cleanSource(source),needed=new Map();
  for(const object of content.objects??[])if(object.model_asset)needed.set(object.model_asset,'model/gltf-binary');
  for(const module of content.behaviors??[])needed.set(module.asset_hash,'text/x-gdscript');
  content.asset_blobs={};
  for(const [key,mime] of needed){const blob=blobs[key];if(!/^[a-f0-9]{64}$/.test(key)||!blob||blob.mime!==mime||hash(Buffer.from(blob.data_base64,'base64'))!==key)throw Error(`Missing or corrupt offline asset ${key}`);content.asset_blobs[key]=structuredClone(blob);}
  return content;
}
export function createApi({server,token,journalDir}){
  server=String(server).replace(/\/$/,'');
  return async(path,body)=>{
    if(!token)throw Error('Set WORLD_ATELIER_TOKEN to access the central service');
    const fingerprint=hash({server,path,body,account:hash(token)});
    const ledgerFile=journalDir&&join(journalDir,`http-${fingerprint}.json`);
    const ledger=ledgerFile?await jsonFile(ledgerFile,{}):{};
    const key=body===undefined?null:ledger.key??randomUUID();
    if(key&&ledgerFile)await atomicWrite(ledgerFile,{key,fingerprint});
    let response;
    for(let attempt=0;attempt<2;attempt++)try{response=await fetch(server+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});break;}catch(e){if(attempt)throw Error(`Transport outcome uncertain; original idempotency key retained: ${e.message}`);}
    const result=await response.json();
    if(key&&ledgerFile&&(response.ok||response.status<500))await rm(ledgerFile,{force:true});
    if(!response.ok)throw Object.assign(Error(result.error??`HTTP ${response.status}`),{status:response.status,details:result.details});
    return result;
  };
}
async function treeFiles(root,prefix=''){
  const result=[];
  for(const name of (await readdir(join(root,prefix))).sort()){
    const path=prefix?`${prefix}/${name}`:name,file=join(root,path),stat=await lstat(file);
    if(stat.isDirectory())result.push(...await treeFiles(root,path));
    else if(stat.isSymbolicLink()){const target=await readlink(file),absolute=resolve(dirname(file),target);if(!absolute.startsWith(resolve(root)+'/'))throw Error('Archive symlink escapes application');result.push({path,link:target});}
    else if(stat.isFile())result.push({path,sha256:hash(await readFile(file)),bytes:stat.size,executable:!!(stat.mode&0o111)});
    else throw Error('Unsupported archive entry');
  }
  return result;
}
async function validExtraction(directory,zipHash){
  try{const receipt=await jsonFile(join(directory,'extraction.json'));if(receipt.zip_sha256!==zipHash)return null;const actual=await treeFiles(join(directory,'app'));if(hash(actual)!==hash(receipt.files))return null;const binary=safeInside(join(directory,'app'),receipt.binary);if(!(await lstat(binary)).isFile())return null;return {binary,receipt};}catch{return null;}
}
export async function ensureRuntime({artifact,runtimeHash,cacheDir,server,token,offline=false,log=console.log}){
  if(!/^[a-f0-9]{64}$/.test(runtimeHash)||!/^[a-f0-9]{64}$/.test(artifact?.sha256??'')||!Number.isInteger(artifact.bytes)||artifact.bytes<1||!artifact.path.startsWith('macos/'))throw Error('Invalid pinned runtime manifest');
  safeInside(cacheDir,artifact.path);
  const directory=join(cacheDir,runtimeHash);await mkdir(directory,{recursive:true});
  const archive=join(directory,'client.zip');
  let verified=false;try{const bytes=await readFile(archive);verified=bytes.length===artifact.bytes&&hash(bytes)===artifact.sha256;}catch{}
  if(!verified){
    if(offline)throw Error('Offline client archive is missing or corrupt; download a complete workspace while online');
    const url=new URL(artifact.url,server);if(!['http:','https:'].includes(url.protocol))throw Error('Unsupported artifact URL');
    const response=await fetch(url,{headers:url.origin===new URL(server).origin&&token?{Authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error(`Client download failed (${response.status})`);
    const chunks=[],digest=createHash('sha256');let received=0,last=0;
    for await(const chunk of response.body){chunks.push(chunk);digest.update(chunk);received+=chunk.length;if(received-last>4*1024*1024){log(JSON.stringify({stage:'downloading',received,total:artifact.bytes}));last=received;}}
    if(received!==artifact.bytes||digest.digest('hex')!==artifact.sha256)throw Error('Client archive SHA-256/length mismatch; candidate rejected');
    await atomicWrite(archive,Buffer.concat(chunks));log(JSON.stringify({stage:'archive_verified',sha256:artifact.sha256,bytes:received}));
  }
  const extraction=join(directory,'extracted');let match=await validExtraction(extraction,artifact.sha256);
  if(!match){
    const {stdout}=await execute('/usr/bin/unzip',['-Z1',archive],{maxBuffer:10_000_000});for(const entry of stdout.split('\n').filter(Boolean))safeInside(directory,entry.replace(/\/$/,''));
    const staging=await mkdtemp(join(directory,'extract-stage-'));await mkdir(join(staging,'app'));
    try{
      await execute('/usr/bin/unzip',['-q',archive,'-d',join(staging,'app')]);
      const apps=(await readdir(join(staging,'app'))).filter(p=>p.endsWith('.app'));if(apps.length!==1)throw Error('Archive must contain exactly one macOS application');
      const binaryDir=join(staging,'app',apps[0],'Contents/MacOS');const executables=(await readdir(binaryDir)).filter(p=>!p.startsWith('.'));if(executables.length!==1)throw Error('Application executable is ambiguous');
      const binary=`${apps[0]}/Contents/MacOS/${executables[0]}`;await chmod(join(staging,'app',binary),0o755);
      const files=await treeFiles(join(staging,'app'));await atomicWrite(join(staging,'extraction.json'),{zip_sha256:artifact.sha256,binary,files});
      const old=`${extraction}.old-${randomUUID()}`;try{await rename(extraction,old);}catch(e){if(e.code!=='ENOENT')throw e;}
      await rename(staging,extraction);await rm(old,{recursive:true,force:true});
      match=await validExtraction(extraction,artifact.sha256);if(!match)throw Error('Staged application verification failed');
      log(JSON.stringify({stage:'application_verified',files:files.length,repaired_cache:true}));
    }catch(e){await rm(staging,{recursive:true,force:true});throw e;}
  }
  return {binary:match.binary,archive,runtimeHash,sha256:artifact.sha256,files:match.receipt.files.length};
}
export async function validateCandidate(binary,file,logFile){
  const result=await execute(binary,['--headless','--','--role=validate',`--content=${file}`],{timeout:35000,maxBuffer:3_000_000}).catch(e=>({stdout:e.stdout??'',stderr:e.stderr??'',error:e}));
  const output=result.stdout+'\n'+result.stderr;if(logFile)await atomicWrite(logFile,output);
  if(result.error||!output.includes('CONTENT_VALIDATED')||/SCRIPT ERROR|Parse Error|CONTENT_REJECTED/.test(output))throw Error('Downloaded Godot client rejected the local candidate; playable content and saves were retained. '+output.slice(-1200));
  return {passed:true,sha256:hash(await readFile(file)),output};
}
export async function runNative({binary,gameArgs,options={},logDir,expected,log=console.log}){
  await mkdir(logDir,{recursive:true});
  const telemetryFile=resolve(options['telemetry-file']??join(logDir,'telemetry.json'));
  const history=join(logDir,'telemetry.jsonl'),outputFile=join(logDir,'runtime.log');
  await mkdir(dirname(telemetryFile),{recursive:true});await rm(telemetryFile,{force:true});
  const engineArgs=options.headless?['--headless']:['--resolution',String(options.resolution??'1440x960')];
  const extras=[`--telemetry-file=${telemetryFile}`];
  for(const key of ['input-script','capture','capture-after','quit-after-seconds','camera-size'])if(options[key]!==undefined)extras.push(`--${key}=${['input-script','capture'].includes(key)?resolve(options[key]):options[key]}`);
  const child=spawn(binary,[...engineArgs,'--',...gameArgs,...extras],{stdio:['ignore','pipe','pipe']});
  let output='',last='',active=false,latest=null,wrongIdentity=false;const writes=[];
  const collect=chunk=>{const text=chunk.toString().replace(/(--ticket=)[^\s]+/g,'$1[redacted]');output=(output+text).slice(-3000000);writes.push(appendFile(outputFile,text));};
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  const poll=setInterval(async()=>{try{const packet=await jsonFile(telemetryFile);const serial=JSON.stringify(packet);if(serial!==last){last=serial;latest=packet;writes.push(appendFile(history,serial+'\n'));if(packet.active){if(expected&&(packet.world_id!==expected.world_id||packet.release_id!==expected.release_id||packet.user_id!==expected.user_id)){wrongIdentity=true;child.kill('SIGTERM');}else if(!active){active=true;log(JSON.stringify({stage:'native_active',world_id:packet.world_id,release_id:packet.release_id,user_id:packet.user_id,tick:packet.tick}));}}}}catch{}},100);
  const forward=()=>child.kill('SIGTERM');process.on('SIGINT',forward);process.on('SIGTERM',forward);
  let code;try{code=await new Promise((done,fail)=>{child.on('error',fail);child.on('exit',c=>done(c));});}finally{clearInterval(poll);process.off('SIGINT',forward);process.off('SIGTERM',forward);await Promise.all(writes);}
  const receipt={pid:child.pid,exit_code:code,active_confirmed:active,telemetry_file:telemetryFile,history,output_file:outputFile,latest};await atomicWrite(join(logDir,'launch-receipt.json'),receipt);
  if(code!==0||!active||wrongIdentity||/SCRIPT ERROR|Parse Error|CONTENT_REJECTED/.test(output))throw Error(`Native runtime did not complete cleanly (exit ${code}, active ${active}, identity_match ${!wrongIdentity}); see ${outputFile}`);
  return receipt;
}
