import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const NATIVE_SCENE_PROTOCOL = 'wa-native-scene-1';
export class NativeSceneError extends Error {
  constructor(message, details={}) { super(message); this.name='NativeSceneError'; Object.assign(this, details); }
}

export function runNativeScene({projectDirectory, request, godotPath, ...options}) {
  return invokeNativeScene({projectDir:projectDirectory, request, godot:godotPath, ...options});
}

/** Complete the engine's normal import pass before indexing arbitrary Godot
 * projects (GLB, textures, class_name scripts and their native UID sidecars).
 * Import mutates only the disposable candidate and explicit execution storage.
 */
export async function importNativeProject({projectDirectory,godotPath='/opt/homebrew/bin/godot',timeoutMs=120000,signal,enforceIsolation=false,executionEnvironment}) {
  const candidate=await realpath(projectDirectory);
  if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
  const work=await mkdtemp(path.join(tmpdir(),'wa-native-import-'));
  try {
    const environmentOptions={directory:path.join(work,'execution'),readPaths:[await realpath(godotPath),candidate,work],writePaths:[candidate,work]};
    let environment=typeof executionEnvironment==='function'?await executionEnvironment(environmentOptions):executionEnvironment;
    if (enforceIsolation && !environment) {
      const {prepareExecutionEnvironment}=await import('../../services/creation/execution-environment.mjs');
      environment=prepareExecutionEnvironment(environmentOptions);
    }
    if (enforceIsolation && (!environment?.capabilities?.available || typeof environment.command!=='function')) throw new NativeSceneError('Enforced native import execution environment is unavailable');
    const args=['--headless','--editor','--path',candidate,'--import'];
    const command=environment?environment.command(godotPath,args,{godot:true,projectPath:candidate,logName:'native-import.log'}):{command:godotPath,args,options:{cwd:candidate}};
    const run=await new Promise((resolve,reject)=>{
      const child=spawn(command.command,command.args,{...command.options,stdio:['ignore','pipe','pipe'],signal});
      let stdout='',stderr='',overflow=false,timedOut=false;
      const collect=(name)=>(bytes)=>{if(name==='stdout') stdout+=bytes;else stderr+=bytes;if(stdout.length+stderr.length>16*1024*1024){overflow=true;child.kill('SIGKILL');}};
      child.stdout.on('data',collect('stdout'));child.stderr.on('data',collect('stderr'));
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr,overflow,timedOut});});
    });
    const unsafeErrors=run.stderr.split('\n').filter(line=>/^(?:SCRIPT ERROR|ERROR):/.test(line) && !/^ERROR: \d+ RID allocations .* were leaked at exit\.$/.test(line));
    if (run.code!==0 || run.overflow || run.timedOut || unsafeErrors.length) throw new NativeSceneError(unsafeErrors.join('\n') || (run.timedOut?'Native project import timed out':'Native project import failed'),{run});
    return {ok:true,protocol:NATIVE_SCENE_PROTOCOL,diagnostics:{stdout:run.stdout,stderr:run.stderr}};
  } finally {await rm(work,{recursive:true,force:true});}
}

/** Operate only on a disposable, complete candidate project. Callers own transaction commit.
 * No UI server is launched. Normal inspect never rewrites source scenes.
 * Requests and responses live outside candidate source to avoid accidental inclusion.
 */
export async function invokeNativeScene({projectDir, request, godot='/opt/homebrew/bin/godot', timeoutMs=45000, signal, adapterPath=path.join(import.meta.dirname,'adapter.gd'), enforceIsolation=false, executionEnvironment}) {
  const candidate=await realpath(projectDir);
  if (!request || !['inspect','inspect_many','apply','create_scene','project_info'].includes(request.action ?? 'inspect')) throw new NativeSceneError('Invalid native scene action');
  const validScenePath=value=>typeof value==='string'&&/^res:\/\/(?!.*(?:\.\.|\\)).+\.(?:tscn|scn)$/.test(value);
  if (request.action==='inspect_many') {
    if (!Array.isArray(request.scene_paths)||!request.scene_paths.length||request.scene_paths.length>512||new Set(request.scene_paths).size!==request.scene_paths.length||!request.scene_paths.every(validScenePath)) throw new NativeSceneError('Invalid native scene batch paths');
    if (['ops','assign_ids','discard_removed_overrides'].some(key=>Object.hasOwn(request,key))) throw new NativeSceneError('Native scene batch inspection is read-only');
  } else if (request.action!=='project_info'&&!validScenePath(request.scene_path)) throw new NativeSceneError('Invalid project scene path');
  if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
  const work=await mkdtemp(path.join(tmpdir(),'wa-native-scene-'));
  const requestFile=path.join(work,'request.json'),responseFile=path.join(work,'response.json');
  try {
    await writeFile(requestFile,JSON.stringify({protocol:NATIVE_SCENE_PROTOCOL,...request}));
    const environmentOptions={directory:path.join(work,'execution'),readPaths:[await realpath(godot),path.dirname(await realpath(adapterPath)),work,candidate],writePaths:[candidate,work]};
    let environment=typeof executionEnvironment==='function'?await executionEnvironment(environmentOptions):executionEnvironment;
    if (enforceIsolation && !environment) {
      // Integrated location is tools/native-scene/. Tests can inject the same
      // host helper without copying the service tree into their worker area.
      const {prepareExecutionEnvironment}=await import('../../services/creation/execution-environment.mjs');
      environment=prepareExecutionEnvironment(environmentOptions);
    }
    if (enforceIsolation && (!environment?.capabilities?.available || typeof environment.command!=='function')) throw new NativeSceneError('Enforced native scene execution environment is unavailable');
    const args=['--headless','--editor','--path',candidate,'--script',adapterPath,'--','--request',requestFile,'--response',responseFile];
    const command=environment?environment.command(godot,args,{godot:true,projectPath:candidate,logName:'native-scene.log'}):{command:godot,args,options:{cwd:candidate}};
    const run=await new Promise((resolve,reject)=>{
      const child=spawn(command.command,command.args,{...command.options,stdio:['ignore','pipe','pipe'],signal});
      let stdout='',stderr='',overflow=false,timedOut=false;
      const collect=(name)=>(bytes)=>{
        if (name==='stdout') stdout+=bytes; else stderr+=bytes;
        if (stdout.length+stderr.length>8*1024*1024) {overflow=true; child.kill('SIGKILL');}
      };
      child.stdout.on('data',collect('stdout')); child.stderr.on('data',collect('stderr'));
      const timer=setTimeout(()=>{timedOut=true; child.kill('SIGKILL');},timeoutMs);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr,overflow,timedOut});});
    });
    let result;
    try { result=JSON.parse(await readFile(responseFile,'utf8')); } catch { /* Missing response is always failure, including GDScript parse failures returning exit 0. */ }
    if (run.code!==0 || run.overflow || run.timedOut || !result || result.protocol!==NATIVE_SCENE_PROTOCOL || !result.ok) {
      throw new NativeSceneError(result?.errors?.map(x=>x.message).join('; ') || (run.timedOut?'Native scene operation timed out':'Native scene engine did not produce a successful response'), {result,run});
    }
    // Startup/parse errors may occur before the adapter's Logger is registered.
    // Godot editor teardown emits known RID warnings after a valid result; they
    // are kept in diagnostics and do not establish a scene load or save failure.
    const unsafeErrors=run.stderr.split('\n').filter(line=>/^(?:SCRIPT ERROR|ERROR):/.test(line) && !/^ERROR: \d+ RID allocations .* were leaked at exit\.$/.test(line));
    if (unsafeErrors.length) throw new NativeSceneError(unsafeErrors.join('\n'),{result,run});
    return {...result, diagnostics:{stdout:run.stdout,stderr:run.stderr}};
  } finally { await rm(work,{recursive:true,force:true}); }
}
