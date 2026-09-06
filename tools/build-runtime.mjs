import {spawn} from 'node:child_process';
import {readdirSync,readFileSync,writeFileSync,mkdirSync,existsSync,statSync,renameSync,copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from '../services/control-plane/content.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const game=join(root,'runtimes/godot'),godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
function files(dir){return readdirSync(dir,{withFileTypes:true}).filter(e=>!['.godot','.git','.local','build','exports'].includes(e.name)).flatMap(e=>e.isDirectory()?files(join(dir,e.name)): [join(dir,e.name)]);}
async function run(cmd,args){console.log(cmd===godot?'Godot '+args.filter(x=>!x.startsWith('/Users/')).join(' '):cmd);await new Promise((res,rej)=>{const p=spawn(cmd,args,{cwd:root,stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',b=>output=(output+b).slice(-60000));p.stderr.on('data',b=>output=(output+b).slice(-60000));p.on('error',rej);p.on('exit',code=>{if(code!==0||/SCRIPT ERROR|Parse Error|Export failed/i.test(output))rej(Error(output));else res();});});}
if(!existsSync(join(game,'project.godot')))throw Error('Godot project is not yet implemented');
if(existsSync(join(root,'tools/godot-content.py')))await run('python3',[join(root,'tools/godot-content.py')]);
mkdirSync(join(game,'content'),{recursive:true});copyFileSync(join(root,'content/world.json'),join(game,'content/world.json'));
await run(godot,['--headless','--editor','--path',game,'--import']);
const sourceFiles=files(game).filter(f=>!f.endsWith('/README.md')).sort();
const source_hash=digest(sourceFiles.map(f=>({path:f.slice(game.length+1),sha256:digest(readFileSync(f))})));
mkdirSync(join(root,'.local/runtime-build'),{recursive:true});
const out=mkdtempSync(join(root,'.local/runtime-build/candidate-'));mkdirSync(join(out,'web'),{recursive:true});mkdirSync(join(out,'macos'),{recursive:true});mkdirSync(join(out,'authority'),{recursive:true});
await run(godot,['--headless','--path',game,'--export-release','Web',join(out,'web/index.html')]);
await run(godot,['--headless','--path',game,'--export-release','macOS',join(out,'macos/WorldAtelier.zip')]);
await run(godot,['--headless','--path',game,'--export-pack','macOS',join(out,'authority/game.pck')]);
await run('/usr/bin/unzip',['-q','-o',join(out,'macos/WorldAtelier.zip'),'-d',join(out,'authority')]);
const app=readdirSync(join(out,'authority')).find(x=>x.endsWith('.app'));if(!app)throw Error('macOS archive has no application');
const binaryDir=join(out,'authority',app,'Contents/MacOS');const binary=readdirSync(binaryDir).find(x=>statSync(join(binaryDir,x)).isFile());if(!binary)throw Error('macOS application has no executable');
const authority_binary=`authority/${app}/Contents/MacOS/${binary}`;
const artifacts=[];
for(const platform of ['web','macos'])for(const path of files(join(out,platform)))artifacts.push({platform,path:path.slice(out.length+1),sha256:digest(readFileSync(path)),bytes:statSync(path).size});
if(!artifacts.some(a=>a.path==='web/index.wasm')||!artifacts.some(a=>a.platform==='macos'))throw Error('Export artifacts incomplete');
const payload=files(out).sort().map(f=>({path:f.slice(out.length+1),sha256:digest(readFileSync(f))}));
const hash=digest({source_hash,payload,engine:'4.6.stable.official.89cea1439',mode:'release'});
const manifest={hash,source_hash,source_files:sourceFiles.map(f=>({path:f.slice(game.length+1),sha256:digest(readFileSync(f))})),authority_binary,artifacts,built_at:Date.now(),engine:'4.6.stable.official.89cea1439'};
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
mkdirSync(join(root,'.local/artifacts'),{recursive:true});
const published=join(root,'.local/artifacts',hash);if(existsSync(published))rmSync(out,{recursive:true});else renameSync(out,published);
mkdirSync(join(root,'.local/runtime-build'),{recursive:true});const destination=join(root,'.local/runtime-build/manifest.json');writeFileSync(destination+'.tmp',JSON.stringify(manifest,null,2)+'\n');renameSync(destination+'.tmp',destination);
console.log(JSON.stringify({ok:true,hash,artifacts:artifacts.length,authority_binary}));
