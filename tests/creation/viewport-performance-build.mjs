// Rebuild the existing immutable native fixture with the current editor template.
// This diagnostic uses the canonical native assembler, private output and muted
// headless Godot. It neither starts a server nor writes the original fixture.
import {cp,mkdir,readFile,writeFile,readdir,symlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {assembleNativeEditorProject} from '../../tools/native-editor/assemble-native-editor.mjs';
import {nativeScenePacket} from '../../services/creation/native-view.mjs';
import {adaptSingleThreadLocalHttp} from '../../tools/godot-web-compatibility.mjs';

const exec=promisify(execFile),root=resolve(import.meta.dirname,'../..');
const fixture=resolve(process.env.WA_PERF_FIXTURE??join(root,'.local/creation-verification/viewport-annotation/browser-OXIT4P'));
const out=resolve(process.env.WA_PERF_BUILD_OUT??join(root,'.local/creation-verification/viewport-performance',`current-${Date.now()}`));
const fixed=JSON.parse(await readFile(join(fixture,'report.json')));
const previous=fixed.runtime_builds.find(row=>row.purpose==='native_preview'&&row.status==='completed').id;
const original=join(fixture,'builds',previous),build=join(out,'builds','current-editor'),runtime=join(build,'runtime'),project=join(build,'project'),web=join(build,'web');
const isolatedHome=join(out,'home'),scratch=join(out,'tmp');
await Promise.all([mkdir(build,{recursive:true}),mkdir(web,{recursive:true}),mkdir(isolatedHome,{recursive:true}),mkdir(scratch,{recursive:true})]);
await cp(process.env.WA_PERF_RUNTIME??join(root,'runtimes/model-preview'),runtime,{recursive:true,filter:path=>!path.split('/').includes('.godot')});
const db=new DatabaseSync(join(fixture,'creation.sqlite'),{readOnly:true});
const revision=JSON.parse(db.prepare("SELECT body FROM documents WHERE kind='creator_revision' AND id=?").get(fixed.source_revision).body);db.close();
const config=JSON.parse(await readFile(join(original,'project/atelier_editor/native-editor.json')));
const scenes=Object.keys(revision.manifest.resources).map(id=>nativeScenePacket(revision.manifest,id,{project_id:revision.project_id,branch_id:'main',revision:revision.id}));
const engine=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
const env={...process.env,HOME:isolatedHome,TMPDIR:scratch,XDG_CONFIG_HOME:join(isolatedHome,'config'),XDG_DATA_HOME:join(isolatedHome,'data'),XDG_CACHE_HOME:join(isolatedHome,'cache')};
let commandIndex=0;
async function run(command,args,cwd){
  try {
    const result=await exec(command,['--audio-driver','Dummy',...args],{cwd,env,timeout:120000,maxBuffer:16*1024*1024});
    const log=result.stdout+result.stderr;await writeFile(join(out,`godot-${++commandIndex}.log`),log);return log;
  } catch(error) {await writeFile(join(out,`godot-${++commandIndex}.log`),String(error.stdout??'')+String(error.stderr??''));throw error;}
}
const assembled=await assembleNativeEditorProject({sourceDirectory:join(original,'native-source'),destinationDirectory:project,runtimeDirectory:runtime,initialScene:config.initial_scene,scenes,godotPath:engine,run});
// Preserve the original viewport/project export behavior; the only difference
// is the canonical assembler's current editor template and explicit template.
await cp(join(original,'project/project.godot'),join(project,'project.godot'));
let presets=await readFile(join(original,'project/export_presets.cfg'),'utf8');
const template=process.env.GODOT_WEB_TEMPLATE??'/Users/chengzhi/Library/Application Support/Godot/export_templates/4.6.stable/web_nothreads_release.zip';
presets=presets.replace('custom_template/release=""','custom_template/release='+JSON.stringify(template));
const privateTemplates=join(isolatedHome,'Library/Application Support/Godot/export_templates/4.6.stable');
await mkdir(privateTemplates,{recursive:true});
for(const name of ['web_nothreads_release.zip','web_nothreads_debug.zip'])await symlink(join(dirname(template),name),join(privateTemplates,name));
await writeFile(join(project,'export_presets.cfg'),presets);
await run(engine,['--headless','--editor','--path',project,'--import','--quit'],out);
await run(engine,['--headless','--path',project,'--export-release','Web',join(web,'index.html')],out);
const version=(await exec(engine,['--headless','--audio-driver','Dummy','--version'],{env})).stdout.trim();
const adapted=await adaptSingleThreadLocalHttp({javascript:await readFile(join(web,'index.js'),'utf8'),html:await readFile(join(web,'index.html'),'utf8'),wasm:await readFile(join(web,'index.wasm')),presets,engineVersion:version});
await writeFile(join(web,'index.js'),adapted.javascript);await writeFile(join(web,'index.html'),adapted.html);
await cp(join(fixture,'creation.sqlite'),join(out,'creation.sqlite'));
await writeFile(join(out,'report.json'),JSON.stringify(fixed,null,2));
const hashes=[];for(const name of (await readdir(runtime)).filter(name=>name.endsWith('.gd')))hashes.push({path:name,sha256:createHash('sha256').update(await readFile(join(runtime,name))).digest('hex')});
await writeFile(join(out,'build-evidence.json'),JSON.stringify({fixture,previous_build:previous,build:'current-editor',source_revision:revision.id,source_identity:revision.manifest.source_identity,engine:version,headless:true,audio:'Dummy',canonical_assembler:true,receipt:assembled.receipt,runtime_hashes:hashes},null,2));
console.log('VIEWPORT_PERFORMANCE_BUILD '+out);
