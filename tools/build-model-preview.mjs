import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,stat,cp} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {adaptSingleThreadLocalHttp} from './godot-web-compatibility.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const project=join(root,'runtimes/model-preview');
const option=process.argv.slice(2).find(v=>v.startsWith('--out='));
const output=resolve(option?option.slice(6):join(root,'.local/model-preview/build'));
const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function inventory(path){
  const items=[];
  for(const file of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(['.godot','.local','tests','README.md'].includes(file.name))continue;
    const full=join(path,file.name);
    if(file.isDirectory())items.push(...await inventory(full));
    else items.push(full);
  }
  return items;
}
async function run(args){
  return new Promise((resolveRun,reject)=>{
    const process=spawn(godot,args,{cwd:root,stdio:['ignore','pipe','pipe']});
    let log='',stdout='';
    process.stdout.on('data',b=>{stdout+=b.toString();log+=b.toString();});process.stderr.on('data',b=>{log+=b.toString();});
    process.once('error',reject);
    process.once('exit',code=>{
      if(code!==0||/SCRIPT ERROR|Parse Error|ERROR:|Export failed/.test(log))reject(Error(log));
      else {console.log(log.trim());resolveRun((args.length===1&&args[0]==='--version'?stdout:log).trim());}
    });
  });
}
await mkdir(output,{recursive:true});
const engineVersion=await run(['--version']);
await run(['--headless','--editor','--path',project,'--import']);
await run(['--headless','--path',project,'--quit-after','3']);
await run(['--headless','--path',project,'--export-release','Web',join(output,'index.html')]);
// Apply the reviewed single-thread local-HTTP policy before any artifact hash
// or immutable archive is created. Fail closed when the template changes.
const webCompatibility=await adaptSingleThreadLocalHttp({javascript:await readFile(join(output,'index.js'),'utf8'),html:await readFile(join(output,'index.html'),'utf8'),wasm:await readFile(join(output,'index.wasm')),presets:await readFile(join(project,'export_presets.cfg'),'utf8'),engineVersion});
await writeFile(join(output,'index.js'),webCompatibility.javascript);
await writeFile(join(output,'index.html'),webCompatibility.html);
const compatibility={...webCompatibility.metadata,build_inputs:await Promise.all(['build-model-preview.mjs','godot-web-compatibility.mjs'].map(async path=>({path:`tools/${path}`,sha256:digest(await readFile(join(root,'tools',path)))})))};
await writeFile(join(output,'web-compatibility.json'),JSON.stringify(compatibility,null,2)+'\n');
const sources=await Promise.all((await inventory(project)).map(async path=>({path:relative(project,path),sha256:digest(await readFile(path))})));
let capabilities;
if(sources.some(file=>file.path==='runtime_capabilities.json')){
  const bytes=await readFile(join(project,'runtime_capabilities.json'));capabilities=JSON.parse(bytes);
  if(capabilities.schema!==1||!Array.isArray(capabilities.document_schemas)||!Array.isArray(capabilities.features)||[...capabilities.document_schemas,...capabilities.features].some(v=>typeof v!=='string'))throw Error('Invalid actual runtime capabilities');
  // Retain the very same source bytes beside the immutable Web artifacts so a
  // client/backup can verify the advertised projection without engine decoding.
  await writeFile(join(output,'runtime_capabilities.json'),bytes);
}
const files=[];
for(const file of (await readdir(output)).filter(file=>file!=='manifest.json').sort()){
  const path=join(output,file),info=await stat(path);
  if(!info.isFile())continue;
  files.push({path:file,sha256:digest(await readFile(path)),bytes:info.size});
}
for(const required of ['index.html','index.js','index.wasm','index.pck'])if(!files.some(v=>v.path===required))throw Error('Missing Web artifact: '+required);
const build_id=digest(JSON.stringify({sources,files}));
const runtimeVersion=(await readFile(join(project,'project.godot'),'utf8')).match(/^config\/version="([^"]+)"/m)?.[1]??'0.1.0';
const manifest={format:1,build_id,runtime:'world-atelier-model-preview',runtime_version:runtimeVersion,engine:'Godot 4.6 stable',single_threaded:true,rendering:'gl_compatibility',models_embedded:false,entry:'index.html',built_at:new Date().toISOString(),sources,files,web_compatibility:{path:'web-compatibility.json',policy:compatibility.policy},...(capabilities?{capabilities}:{})};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const immutableOutput=join(dirname(output),'releases',build_id);
await mkdir(dirname(immutableOutput),{recursive:true});
let alreadyArchived=false;try{alreadyArchived=(await stat(immutableOutput)).isDirectory();}catch{}
if(!alreadyArchived)await cp(output,immutableOutput,{recursive:true,force:false,errorOnExist:true});
console.log(JSON.stringify({ok:true,output,immutableOutput,build_id,files:files.length}));
