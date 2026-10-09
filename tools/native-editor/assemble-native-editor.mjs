import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,readdir,mkdir,copyFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const toolDirectory=import.meta.dirname;
const ignored=new Set(['.git','.godot','.atelier','node_modules']);
async function entries(root,relative='') {
  const result=[];
  for(const item of await readdir(path.join(root,relative),{withFileTypes:true})) {
    if(ignored.has(item.name))continue;
    const name=relative?`${relative}/${item.name}`:item.name;
    if(item.isSymbolicLink())throw new Error(`Native preview source contains symbolic link: ${name}`);
    if(item.isDirectory())result.push(...await entries(root,name));
    else if(item.isFile())result.push(name);
    else throw new Error(`Native preview source is not a regular file: ${name}`);
  }
  return result.sort();
}
async function copy(root,target,names) { for(const name of names){ const out=path.join(target,name);await mkdir(path.dirname(out),{recursive:true});await copyFile(path.join(root,name),out); } }
function sectionConfig(text,{main,autoload=true}) {
  const sections=text.split(/(?=^\[[^\]]+\]\s*$)/m);
  text=sections.filter(s=>!/^\[(?:editor_plugins|autoload)\]/.test(s)||(/^\[autoload\]/.test(s)&&autoload)).join('');
  if(main){
    text=text.replace(/^run\/main_scene=.*$/mg,'');
    if(!/^\[application\]/m.test(text))text+='\n[application]\n';
    text=text.replace(/^\[application\]\s*$/m,`[application]\nrun/main_scene=${JSON.stringify(main)}`);
    text=text.replace(/^renderer\/rendering_method(?:\.mobile)?=.*$/mg,'');
    if(!/^\[rendering\]/m.test(text))text+='\n[rendering]\n';
    text=text.replace(/^\[rendering\]\s*$/m,'[rendering]\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"');
  }
  return text;
}
async function invoke({godotPath,args,candidate,work,executionEnvironment,enforceIsolation,timeoutMs,signal,extraReadPaths=[],run}) {
  if(run){
    // Godot's --editor custom SceneTree leaks these same editor RIDs even for
    // an empty script. Mirror the existing local executor's exact exit-only
    // diagnostic rule; keep the complete queue log and reject every other
    // engine/script/parse error. Nonzero exits are still rejected by run().
    const bake=args.includes('--script')&&args.includes(path.join(toolDirectory,'bake_preview.gd'));
    const output=String(await run(godotPath,args,work,{isolatedProject:candidate,importing:true,readPaths:[toolDirectory,work,...extraReadPaths],writePaths:[candidate,work],selfContained:true,allowErrors:bake}));
    const errors=output.split('\n').filter(line=>/^(ERROR|SCRIPT ERROR):/.test(line)&&!(bake&&/^ERROR: \d+ RID allocations .*were leaked at exit\.$/.test(line)));
    if(errors.length)throw Object.assign(new Error(errors.join('\n')),{run:{code:0,stdout:output,stderr:'',timedOut:false,overflow:false}});
    return {code:0,stdout:output,stderr:"",timedOut:false,overflow:false};
  }
  const options={directory:path.join(work,`execution-${sha(args.join('\0')).slice(0,8)}`),readPaths:[godotPath,toolDirectory,candidate,work,...extraReadPaths],writePaths:[candidate,work]};
  let environment=typeof executionEnvironment==='function'?await executionEnvironment(options):executionEnvironment;
  if(enforceIsolation&&!environment) {
    const {prepareExecutionEnvironment}=await import('../../services/creation/execution-environment.mjs');
    environment=prepareExecutionEnvironment(options);
  }
  if(enforceIsolation&&(!environment?.capabilities?.available||typeof environment.command!=='function'))throw new Error('Native editor requires enforced build isolation');
  const command=environment?environment.command(godotPath,args,{godot:true,projectPath:candidate,logName:'native-editor.log'}):{command:godotPath,args,options:{cwd:candidate}};
  const result=await new Promise((resolve,reject)=>{
    let stdout='',stderr='',timedOut=false,overflow=false;
    const child=spawn(command.command,command.args,{...command.options,stdio:['ignore','pipe','pipe'],signal});
    const collect=stream=>bytes=>{if(stream==='out')stdout+=bytes;else stderr+=bytes;if(stdout.length+stderr.length>16*1024*1024){overflow=true;child.kill('SIGKILL');}};
    child.stdout.on('data',collect('out'));child.stderr.on('data',collect('err'));
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut,overflow});});
  });
  const errors=result.stderr.split('\n').filter(line=>/^(ERROR|SCRIPT ERROR):/.test(line)&&!/^ERROR: \d+ RID allocations .*were leaked at exit\.$/.test(line));
  if(result.code!==0||result.timedOut||result.overflow||errors.length)throw Object.assign(new Error(errors.join('\n')||'Native editor engine build failed'),{run:result});
  return result;
}
/** Build a private, script-free static native editor project. Source is copied,
 * never saved. destinationDirectory must be new and outside sourceDirectory.
 * Toolchain hashing must include every runtimeFiles entry plus this tool/baker.
 * Optional scenes are full fixed read-only packets; initialScene is displayed on boot.
 */
export async function assembleNativeEditorProject({sourceDirectory,destinationDirectory,runtimeDirectory=path.join(toolDirectory,'../../runtimes/model-preview'),runtimeFiles,initialScene,scenes=[initialScene],sourceIdentity=initialScene?.source_identity,godotPath='/opt/homebrew/bin/godot',executionEnvironment,enforceIsolation=true,timeoutMs=120000,signal,run}) {
  const source=await realpath(sourceDirectory),destination=path.resolve(destinationDirectory);
  if(destination===source||destination.startsWith(source+path.sep)||source.startsWith(destination+path.sep))throw new Error('Native preview destination overlaps fixed source');
  if(!initialScene||!Array.isArray(scenes)||!scenes.length)throw new Error('Native preview needs fixed scene packets');
  const sourceFiles=await entries(source);
  if(sourceFiles.some(name=>name==='atelier_editor'||name.startsWith('atelier_editor/')))throw new Error('Native source uses reserved atelier_editor namespace');
  const trusted=runtimeFiles??(await entries(runtimeDirectory)).filter(name=>/\.(gd|gdshader|tscn|tres|ttf|otf|json)$/.test(name));
  for(const name of trusted)if(path.isAbsolute(name)||name.split('/').some(part=>!part||part==='..'||part==='.')||name.includes('\\'))throw new Error('Unsafe native editor runtime path');
  if(!trusted.includes('native_main.gd')||!trusted.includes('main.tscn'))throw new Error('Native editor runtime is incomplete');
  const inputHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,sha(await readFile(path.join(source,name)))])));
  const work=await mkdtemp(path.join(tmpdir(),'wa-native-editor-'));
  const bake=path.join(work,'source');await mkdir(bake);
  const diagnostics=[];
  try {
    await copy(source,bake,sourceFiles);
    const projectText=await readFile(path.join(source,'project.godot'),'utf8');
    await writeFile(path.join(bake,'project.godot'),sectionConfig(projectText,{autoload:true}));
    diagnostics.push(await invoke({godotPath,args:['--headless','--editor','--path',bake,'--import'],candidate:bake,work,executionEnvironment,enforceIsolation,timeoutMs,signal,run}));
    const previewScenes={};
    const bakeScenes=[];
    for(const packet of scenes){
      if(!packet||packet.document_schema!=='creation-native-1'||packet.source_identity!==sourceIdentity||!/^res:\/\/(?!.*(?:\.\.|\\)).+\.(tscn|scn)$/.test(packet.native_scene_path??''))throw new Error('Invalid or mixed-version native scene packet');
      if(previewScenes[packet.native_scene_path])continue;
      const output=`res://atelier_editor/scenes/${sha(packet.native_scene_path)}.scn`;
      previewScenes[packet.native_scene_path]=output;bakeScenes.push({source:packet.native_scene_path,output});
    }
    const request=path.join(work,'request.json'),response=path.join(work,'response.json');
    await writeFile(request,JSON.stringify({scenes:bakeScenes}));
    diagnostics.push(await invoke({godotPath,args:['--headless','--editor','--path',bake,'--script',path.join(toolDirectory,'bake_preview.gd'),'--',request,response],candidate:bake,work,executionEnvironment,enforceIsolation,timeoutMs,signal,run}));
    const receipt=JSON.parse(await readFile(response,'utf8'));
    if(!receipt.ok)throw Object.assign(new Error('Native static scene bake rejected'),{receipt});
    await mkdir(destination,{recursive:false});
    // Source scripts and scene/resource containers can still refer to removed
    // author Autoloads. The engine baked all containers inline. Only media/import
    // inputs plus the engine-generated static scenes enter the display project.
    // ShaderFormatLoader does not expose #include dependencies through the
    // generic ResourceLoader API. Retain the complete pinned shader source set.
    const media=new Set(sourceFiles.filter(name=>/\.(gdshader|gdshaderinc)$/.test(name)));
    for(const scene of Object.values(receipt.scenes))for(const dependency of scene.dependencies??[]) {
      const resourcePath=dependency.split('::').at(-1);
      if(!resourcePath.startsWith('res://'))throw new Error(`Preview contains non-project resource dependency: ${resourcePath}`);
      const name=resourcePath.slice(6);
      if(!sourceFiles.includes(name)||name.includes('..')||/\.(gd|cs|tscn|scn|tres|res|gdextension)$/.test(name))throw new Error(`Preview still contains an executable or unbaked source dependency: ${name}`);
      media.add(name);
      const sidecar=name+'.import';
      try{await readFile(path.join(bake,sidecar));media.add(sidecar);}catch{}
    }
    await copy(bake,destination,[...media]);
    // Preserve source import settings/data used by the static scene. The final
    // editor scan sees the same imported media, without user import plugins.
    const imported=path.join(bake,'.godot/imported');
    try{await copy(imported,path.join(destination,'.godot/imported'),await entries(imported));}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const {output} of bakeScenes)await copy(bake,destination,[output.slice(6)]);
    for(const name of trusted){
      let bytes=await readFile(path.join(runtimeDirectory,name));
      if(/\.(gd|gdshader|tscn|tres|json)$/.test(name)){
        let text=bytes.toString('utf8');
        for(const known of [...trusted,'native-editor.json'].sort((a,b)=>b.length-a.length))text=text.split(`res://${known}`).join(`res://atelier_editor/${known}`);
        if(name==='main.tscn')text=text.replace('res://atelier_editor/main.gd','res://atelier_editor/native_main.gd');
        bytes=Buffer.from(text);
      }
      const output=path.join(destination,'atelier_editor',name);await mkdir(path.dirname(output),{recursive:true});await writeFile(output,bytes);
    }
    const policy={...receipt.policy,preview_only:true,source_save:false,gameplay:false,author_autoloads:false,node_scripts:'removed_before_tree',tool_init:'may_execute_only_during_isolated_build',instance_structure:'engine_flattened_display_cache'};
    const config={schema:'wa-native-editor-1',source_identity:sourceIdentity,initial_scene:initialScene,preview_scenes:previewScenes,policy};
    await writeFile(path.join(destination,'atelier_editor/native-editor.json'),JSON.stringify(config,null,2));
    await writeFile(path.join(destination,'project.godot'),sectionConfig(projectText,{main:'res://atelier_editor/main.tscn',autoload:false}));
    await writeFile(path.join(destination,'export_presets.cfg'),'[preset.0]\nname="Web"\nplatform="Web"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter="atelier_editor/*.json"\nexclude_filter=""\nscript_export_mode=2\n[preset.0.options]\nvariant/extensions_support=false\nvariant/thread_support=false\nhtml/export_icon=false\nhtml/canvas_resize_policy=2\nhtml/focus_canvas_on_start=false\nprogressive_web_app/enabled=false\n');
    for(const name of sourceFiles)if(sha(await readFile(path.join(source,name)))!==inputHashes[name])throw new Error(`Fixed native source changed while building: ${name}`);
    return {ok:true,directory:destination,config,receipt,source_files:inputHashes,diagnostics};
  } finally {await rm(work,{recursive:true,force:true});}
}
