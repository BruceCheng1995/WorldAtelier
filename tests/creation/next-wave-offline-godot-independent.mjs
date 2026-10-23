/** Actual offline canonical Godot assembly and execution. The online checkout
 * uses real product request handlers and SQLite via an in-process transport;
 * offline mode rejects every API call. No browser or network transport claim. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {CreationService} from '../../services/creation/service.mjs';
import {prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';
import {NativeWorkspaceClient} from '../../tools/native-workspace.mjs';
import {scanNativeWorkspace} from '../../services/creation/native-agent-workspace.mjs';
import {nextWaveAuthorFiles} from './next-wave-author-fixture.mjs';
import {Evidence,ROOT,ORIGIN} from './next-wave-test-support.mjs';

const evidence=new Evidence('offline-godot-independent',{layers:['A','G'],scope:'Actual product SQLite/handlers, fixed offline runtime cache, real isolated headless Godot import and canonical execution of unsynced work. In-process online transport, no browser claim.'});
const data=mkdtempSync(join(tmpdir(),'atelier-next-wave-offline-engine-')),server=createServer(),prior={agent:process.env.WORLD_ATELIER_DISABLE_AGENT,worlds:process.env.WORLD_ATELIER_DISABLE_WORLDS};
let service,actor,project,client,sourceHead,prepared,offline=false,apiCalls=0,completed=false;
try{
  process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';service=new CreationService({server,root:ROOT,data:join(data,'server'),origin:ORIGIN,publicPlay:false});
  actor=service.store.register({name:'Independent offline engine author',password:'independent-offline-engine-password'});
  await evidence.check('F-GODOT-01','Actual checkout caches source, trusted runtime, assembler and engine identities',['A','G'],async receipt=>{
    const source=Object.fromEntries([...nextWaveAuthorFiles()].map(([path,bytes])=>[path,service.native.archive.put(bytes)]));
    const manifest=await service.native.inspectFiles(source,{assignIds:true});const created=service.store.createProject(actor.user,{name:'Independent offline canonical'},manifest);project=created.project;sourceHead=created.branch.head;
    const api=async(path,{method='GET',body,raw=false}={})=>{
      apiCalls++;if(offline)throw Error('Independent offline transport is disconnected');
      const bytes=body===undefined?null:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body)),req=Readable.from(bytes?[bytes]:[]);
      Object.assign(req,{url:path,method,headers:{host:'127.0.0.1:48921',origin:ORIGIN,authorization:'Bearer '+actor.token},socket:{remoteAddress:'127.0.0.1',localAddress:'127.0.0.1'}});
      const res={headers:{},setHeader(name,value){this.headers[name]=value;},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);},end(value){this.bytes=Buffer.from(value??'');}};
      assert.equal(await service.request(req,res),true);if(res.status>=400){let value;try{value=JSON.parse(res.bytes);}catch{}throw Object.assign(Error(value?.error??'HTTP '+res.status),{status:res.status,details:value?.details});}
      return raw?res.bytes:JSON.parse(res.bytes);
    };
    client=new NativeWorkspaceClient({directory:join(data,'offline-workspace'),server:ORIGIN,token:actor.token,api});
    const state=await client.checkout({project_id:project.id,branch_id:'main'}),runtime=JSON.parse(readFileSync(join(client.metadata,'runtime.json'),'utf8'));
    assert.equal(state.base_revision,sourceHead);assert.ok(runtime.template_files&&runtime.adapter_files&&runtime.policy.sha256&&runtime.engine.hash);
    receipt.source_revision=sourceHead;receipt.workspace_id=state.workspace_id;receipt.runtime_id=runtime.runtime_id;receipt.assembler=runtime.policy.sha256;receipt.engine=runtime.engine;receipt.online_api_calls=apiCalls;
    evidence.json('cached-runtime.json',runtime);
  });

  await evidence.check('F-GODOT-02','Disconnected current work discovers a new scene and assembles through canonical GameRuntime without rewriting source',['G'],async receipt=>{
    offline=true;const callsBefore=apiCalls;
    mkdirSync(join(client.project,'scenes'),{recursive:true});mkdirSync(join(client.project,'scripts'),{recursive:true});
    const originalProject=readFileSync(join(client.project,'project.godot'),'utf8');writeFileSync(join(client.project,'project.godot'),originalProject.replace('run/main_scene="res://scenes/a.tscn"','run/main_scene="res://scenes/offline-only.tscn"'));
    writeFileSync(join(client.project,'scenes/offline-only.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/offline-only.gd" id="logic"]\n[node name="OfflineOnly" type="Node2D"]\nscript=ExtResource("logic")\n');
    writeFileSync(join(client.project,'scripts/offline-only.gd'),`extends Node2D
@export var observed_value: int = 73
func _ready() -> void:
\tawait get_tree().process_frame
\tawait get_tree().process_frame
\tvar runtime: Node = get_node_or_null("/root/GameRuntime")
\tif runtime == null:
\t\tpush_error("NEXT_WAVE_OFFLINE_MISSING_RUNTIME")
\t\tget_tree().quit(8)
\t\treturn
\tprint("NEXT_WAVE_OFFLINE_READY value=", observed_value, " scene=", runtime.get("current_scene_id"), " revision=", runtime.get("release").get("revision"), " creator_token=", not OS.get_environment("WORLD_ATELIER_TOKEN").is_empty())
\tget_tree().quit(0)
`);
    const before=scanNativeWorkspace(client.project).files;
    prepared=await client.preparePlay({godotPath:service.native.godotPath});
    assert.equal(apiCalls,callsBefore);assert.equal(prepared.local_edits_included,true);assert.equal(prepared.network_required,false);assert.equal(prepared.source_modified,false);
    assert.ok(prepared.scenes.some(scene=>scene.id===prepared.entry_scene_id&&scene.path==='scenes/offline-only.tscn'));
    const settings=readFileSync(prepared.project,'utf8');assert.match(settings,/GameRuntime=/);assert.match(settings,/run\/main_scene="res:\/\/atelier_runtime\/standalone.tscn"/);
    assert.deepEqual(scanNativeWorkspace(client.project).files,before);assert.equal(service.store.branchFor(actor.user,project.id,'main').head,sourceHead);
    receipt.local_source_identity=prepared.source_identity;receipt.offline_revision=prepared.revision;receipt.entry_scene_id=prepared.entry_scene_id;receipt.api_calls_during_offline_prepare=apiCalls-callsBefore;
    evidence.json('offline-play-receipt.json',prepared);
  });

  await evidence.check('F-GODOT-03','Real headless canonical startup runs the new unsynced scene with no creator credential or network permission',['G'],async receipt=>{
    const execution=prepareExecutionEnvironment({directory:join(data,'actual-runtime-execution'),readPaths:[prepared.directory],networkOrigins:[]}),invocation=execution.command(service.native.godotPath,['--headless','--audio-driver','Dummy','--path',prepared.directory,'--quit-after','180'],{godot:true,projectPath:prepared.directory,logName:'independent-offline.log'});
    assert.deepEqual(execution.capabilities.loopback_tcp_ports,[]);assert.equal(invocation.options.env.WORLD_ATELIER_TOKEN,undefined);
    const child=spawn(invocation.command,invocation.args,{...invocation.options,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let log='';
    const proc={pid:child.pid,role:'independent-offline-canonical-headless',started_at:new Date().toISOString()};evidence.report.processes.push(proc);
    child.stdout.on('data',bytes=>{log+=bytes;});child.stderr.on('data',bytes=>{log+=bytes;});
    const timer=setTimeout(()=>{try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}},30000);
    const result=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));});clearTimeout(timer);Object.assign(proc,result,{finished_at:new Date().toISOString()});
    evidence.text('actual-offline-runtime.log',log);assert.equal(result.code,0,log);assert.match(log,/NEXT_WAVE_OFFLINE_READY value=73 .*revision=offline-.*creator_token=false/);assert.doesNotMatch(log,/SCRIPT ERROR:|Parse Error:|NEXT_WAVE_OFFLINE_MISSING_RUNTIME/);
    receipt.result=result;receipt.network_ports=execution.capabilities.loopback_tcp_ports;receipt.marker=log.split('\n').find(line=>line.includes('NEXT_WAVE_OFFLINE_READY'));
    const reuse=await client.preparePlay({godotPath:service.native.godotPath});assert.equal(reuse.reused,true);assert.equal(reuse.identity,prepared.identity);assert.equal(service.store.branchFor(actor.user,project.id,'main').head,sourceHead);
  });
  completed=true;
}catch(error){evidence.report.errors.push({message:error.message,stack:error.stack,details:error.details});console.error(error.stack);if(error.details)console.error(JSON.stringify(error.details));process.exitCode=1;}
finally{
  for(const [name,value]of [['WORLD_ATELIER_DISABLE_AGENT',prior.agent],['WORLD_ATELIER_DISABLE_WORLDS',prior.worlds]])if(value===undefined)delete process.env[name];else process.env[name]=value;
  await service?.close();server.close();evidence.report.retained_test_data=data;evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);
}
