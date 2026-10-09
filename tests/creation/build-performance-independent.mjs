// Manual, real-Godot performance probe. Reads an explicitly selected retained
// build; creates only private execution projects, logs and save domains.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,cpSync,rmSync,lstatSync,realpathSync,existsSync,readdirSync} from 'node:fs';
import {dirname,join,resolve,extname} from 'node:path';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {hash} from '../../services/creation/schema.mjs';
import {prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';

const option=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
const root=resolve(import.meta.dirname,'../..');
const selectedBuild=option('sample-build');
assert.ok(selectedBuild,'Pass --sample-build=<retained build ID>; no formal data is changed.');
const sampleData=resolve(option('sample-data')??join(root,'.local/model-preview/creation'));
const out=resolve(option('out')??join(root,'.local/creation-verification/build-performance','frames-'+new Date().toISOString().replaceAll(':','-')));
assert.ok(out.startsWith(join(root,'.local/creation-verification/build-performance')+'/'));
mkdirSync(out,{recursive:true});
const db=new DatabaseSync(join(sampleData,'creation.sqlite'),{readOnly:true});
const get=(kind,id)=>JSON.parse(db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind,id)?.body??'null');
const retained=get('creator_build',selectedBuild),revision=get('creator_revision',retained?.source_revision),retainedProject=get('creator_project',retained?.project_id),retainedStorage=get('creator_game_storage',retained?.project_id+':'+retained?.branch_id);db.close();
assert.ok(retained?.source_files?.length&&revision?.manifest?.resources);
const original=join(sampleData,'builds',retained.id,'project'),project=join(out,'project');
const report={started_at:new Date().toISOString(),scope:'Private copies of retained fixed native project; real Godot commands, no product service or world',source_build:retained.id,source_revision:retained.source_revision,resource_ids:Object.keys(revision.manifest.resources),commands:[]};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
const verify=(directory,files)=>{for(const file of files){const path=join(directory,file.path);assert.ok(lstatSync(path).isFile());assert.ok(realpathSync(path).startsWith(realpathSync(directory)+'/'));const bytes=readFileSync(path);assert.equal(bytes.length,file.size,file.path);assert.equal(hash(bytes),file.sha256,file.path);}};
verify(original,retained.source_files);
for(const file of retained.source_files){const destination=join(project,file.path);mkdirSync(dirname(destination),{recursive:true});cpSync(join(original,file.path),destination);}
verify(project,retained.source_files);
const godot=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot';
const active=new Set();
async function run(stage,projectPath,args,{importing=false,marker=null,allowErrors=false}={}){
  const cache=join(projectPath,'.godot');mkdirSync(cache,{recursive:true});
  const directory=join(out,'execution',stage),environment=prepareExecutionEnvironment({directory,readPaths:[projectPath],writePaths:importing?[cache]:[],safeSavePaths:importing?retained.source_files.filter(file=>file.path.endsWith('.import')).map(file=>join(projectPath,file.path)):[]});
  const invocation=environment.command(godot,args,{godot:true,projectPath}),start=performance.now();
  const result=await new Promise((done,reject)=>{
    const child=spawn(invocation.command,invocation.args,{...invocation.options,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});active.add(child);
    let log='';child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);
    const kill=()=>{try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}};
    const timeout=setTimeout(kill,90000);child.once('error',reject);
    child.once('close',(code,signal)=>{clearTimeout(timeout);active.delete(child);done({code,signal,log});});
  });
  writeFileSync(join(out,stage+'.log'),result.log);
  const row={stage,args,seconds:(performance.now()-start)/1000,code:result.code,signal:result.signal,errors:/SCRIPT ERROR|Parse Error|ERROR:|STANDALONE_RUNTIME_FAULT/.test(result.log),ready:marker?result.log.includes(marker):null,save_domain:environment.directories.home,physics_report:result.log.match(/INDEPENDENT_PHYSICS_REPORT (.+)/)?.[1]};
  if(row.physics_report)row.physics_report=JSON.parse(row.physics_report);
  report.commands.push(row);save();console.log(JSON.stringify(row));
  assert.equal(result.code,0,result.log);if(!allowErrors)assert.equal(row.errors,false,result.log);if(marker)assert.ok(row.ready,result.log);
  return row;
}

async function pipeline(){
  const {CreationStore}=await import('../../services/creation/store.mjs');
  const {NativeProjects}=await import('../../services/creation/native-project.mjs');
  const {CreationBuilds}=await import('../../services/creation/export-builds.mjs');
  assert.equal(typeof CreationBuilds.prototype.prepareImportedExport,'function','Optimized implementation is not ready');
  report.pipeline=[];
  for(const mode of ['baseline','optimized']){
    const data=join(out,mode,'data');mkdirSync(data,{recursive:true});
    const store=new CreationStore(join(data,'creation.sqlite')),native=new NativeProjects({store,data});
    const user=store.register({name:'Independent build probe',password:'private-build-probe-password'}).user;
    store.put('creator_project',{...retainedProject,members:{[user.id]:'owner'}});store.put('creator_revision',revision);
    store.put('creator_branch',{id:retained.project_id+':'+retained.branch_id,project_id:retained.project_id,branch_id:retained.branch_id,head:revision.id,base_revision:revision.id,name:'Independent performance source',created_at:Date.now()});
    if(retainedStorage)store.put('creator_game_storage',retainedStorage);
    for(const entry of Object.values(revision.manifest.source_files)){const bytes=readFileSync(join(sampleData,'native-source','objects',entry.hash.slice(0,2),entry.hash));assert.equal(hash(bytes),entry.hash);assert.equal(bytes.length,entry.size);native.archive.put(bytes);}
    const service={root,data,store,native,observe:fn=>fn()},builds=new CreationBuilds({service});service.builds=builds;
    // The pipeline comparison calls the production executor directly so the
    // baseline can change only its two performance behaviors. All Godot
    // processes still use the production enforced execution environment.
    builds.pump=()=>{};
    const command=builds.command.bind(builds),prepare=builds.prepareImportedExport.bind(builds);
    const row={mode,commands:[],resource_ready:[],started_at:new Date().toISOString()};report.pipeline.push(row);
    let snapshot=null,inserted=false;
    builds.prepareImportedExport=async(...args)=>{
      if(mode==='baseline')return null;
      snapshot=await prepare(...args);assert.ok(snapshot?.directory);assert.ok(snapshot.files.some(file=>file.path.startsWith('.godot/')));
      row.imported_snapshot_files=snapshot.files.length;return snapshot;
    };
    builds.command=async(job,bin,args,cwd,options)=>{
      if(mode==='baseline'){args=[...args];const fixed=args.indexOf('--fixed-fps');if(fixed>=0)args.splice(fixed,2);}
      const exportIndex=args.indexOf('--export-release');
      if(exportIndex>=0){const path=args[args.indexOf('--path')+1];assert.equal(existsSync(join(path,'independent-untrusted.txt')),false);assert.equal(existsSync(join(path,'.godot','independent-untrusted.txt')),false);row.untrusted_runtime_files_excluded=true;}
      const start=performance.now();let log;
      try{log=await command(job,bin,args,cwd,options);}
      finally{row.commands.push({bin,args,seconds:(performance.now()-start)/1000});save();}
      const resource=args.find(arg=>arg.startsWith('--release-scene='));
      if(resource){
        const ready=log.split('\n').filter(line=>line.startsWith('STANDALONE_READY ')).map(line=>JSON.parse(line.slice('STANDALONE_READY '.length)));
        assert.ok(ready.some(entry=>entry.scene_id===resource.slice('--release-scene='.length)));row.resource_ready.push(resource.slice('--release-scene='.length));
        if(mode==='optimized'&&!inserted){
          // A creator's runtime output must never become export input. These
          // test bytes deliberately appear after the trusted import snapshot.
          const checked=args[args.indexOf('--path')+1];writeFileSync(join(checked,'independent-untrusted.txt'),'not pinned');writeFileSync(join(checked,'.godot','independent-untrusted.txt'),'not trusted import');inserted=true;
        }
      }
      return log;
    };
    let job;
    try{
      const response=builds.create(user,retained.project_id,retained.branch_id,{confirmed:true,kind:'application',targets:['web'],request_id:'independent-'+mode,source_revision:revision.id,entry_scene_id:retained.entry_scene_id});
      job=store.get('creator_build',response.job.id);const start=performance.now();await builds.execute(job);row.execution_seconds=(performance.now()-start)/1000;
      assert.equal(job.status,'completed',JSON.stringify(job.target_results));assert.deepEqual(row.resource_ready,report.resource_ids);
      assert.equal(row.commands.filter(command=>command.args.includes('--import')).length,mode==='baseline'?2:1);
      const artifact=job.artifacts.find(artifact=>artifact.target==='web'),zip=join(builds.directory,job.id,artifact.filename),web=join(builds.directory,job.id,'web');
      assert.equal(hash(readFileSync(zip)),artifact.sha256);assert.equal(readFileSync(zip).length,artifact.size);assert.match(execFileSync('unzip',['-t',zip],{encoding:'utf8'}),/No errors detected/);
      for(const file of job.web_files){const bytes=readFileSync(join(web,file.path));assert.equal(bytes.length,file.size);assert.equal(hash(bytes),file.sha256);}
      row.job_id=job.id;row.web_directory=web;row.web_files=job.web_files;row.timings=job.timings;row.artifact=artifact;row.status=job.status;
      row.source_files=job.source_files;verify(join(builds.directory,job.id,'project'),job.source_files);
      assert.equal(store.branchFor(user,retained.project_id,retained.branch_id).head,revision.id);
      for(const kind of ['creator_native_game_release','creator_native_game_pointer','creator_game_release','creator_world'])assert.equal(store.list(kind).length,0);
      const homes=[];for(const directory of readdirSync(join(builds.directory,job.id,'checks'))){const home=join(builds.directory,job.id,'checks',directory,'home');if(existsSync(home))homes.push(home);}
      assert.equal(homes.length,row.commands.filter(command=>command.args.includes('--path')).length);row.private_save_domains=homes;
      row.completed=true;save();
    }finally{
      if(job){builds.queue=[];await builds.cleanupExecution(job);}await builds.close();await native.close();store.close();
    }
  }
  const [baseline,optimized]=report.pipeline;report.pipeline_speedup=baseline.execution_seconds/optimized.execution_seconds;
  assert.equal(baseline.source_files.length,optimized.source_files.length);for(const file of baseline.source_files){const other=optimized.source_files.find(entry=>entry.path===file.path);assert.ok(other);assert.equal(other.sha256,file.sha256,file.path);}
  report.pipeline_fixed_inputs_match=true;
  const {chromium}=await import('@playwright/test');
  const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.pck':'application/octet-stream'};
  const server=createServer((req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}const path=join(optimized.web_directory,decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname));if(!path.startsWith(optimized.web_directory+'/')||!existsSync(path)||!lstatSync(path).isFile()){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':mime[extname(path)]??'application/octet-stream'});res.end(readFileSync(path));});
  let browser;
  try{
    await new Promise((done,reject)=>{server.once('error',reject);server.listen(48921,'127.0.0.1',done);});
    browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}}),logs=[],errors=[];
    page.on('console',message=>{logs.push(message.text());if(message.type()==='error')errors.push(message.text());});page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:48921/index.html');const end=Date.now()+60000;while(!logs.some(line=>line.startsWith('STANDALONE_READY '))&&Date.now()<end)await new Promise(done=>setTimeout(done,100));
    assert.ok(logs.some(line=>line.startsWith('STANDALONE_READY ')));assert.equal(errors.length,0,errors.join('\n'));await page.screenshot({path:join(out,'optimized-web.png')});writeFileSync(join(out,'optimized-web.log'),logs.join('\n'));
    report.browser={ready:true,errors,url:'isolated 48921 optimized Web artifact',source_revision:revision.id};
  }finally{await browser?.close();await new Promise(done=>server.close(done));}
  report.completed=true;save();console.log(JSON.stringify({out,pipeline:report.pipeline.map(row=>({mode:row.mode,seconds:row.execution_seconds,ready:row.resource_ready.length,imports:row.commands.filter(command=>command.args.includes('--import')).length})),browser:report.browser}));
}

try{
  if(process.argv.includes('--pipeline'))await pipeline();
  else{
  await run('import',project,['--headless','--editor','--path',project,'--import'],{importing:true});
  const totals={baseline:0,fixed:0};
  for(const [index,id] of report.resource_ids.entries()){
    // Alternate order so one mode does not consistently benefit from a prior
    // filesystem read, while every run gets its own enforced user directory.
    for(const mode of index%2?['fixed','baseline']:['baseline','fixed']){
      const args=['--headless','--path',project,'--quit-after','180',...(mode==='fixed'?['--fixed-fps','60']:[]),'--','--release-scene='+id];
      const result=await run(mode+'-'+index,project,args,{marker:'STANDALONE_READY'});totals[mode]+=result.seconds;
    }
  }
  report.resource_totals_seconds=totals;report.resource_speedup=totals.baseline/totals.fixed;
  verify(original,retained.source_files);verify(project,retained.source_files);
  report.fixed_source_bytes_unchanged=true;
  const fixture=join(out,'physics-fixture');mkdirSync(fixture,{recursive:true});
  writeFileSync(join(fixture,'project.godot'),'config_version=5\n[application]\nconfig/name="Independent fixed frame probe"\nrun/main_scene="res://probe.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  writeFileSync(join(fixture,'probe.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://probe.gd" id="1"]\n[node name="FrameProbe" type="Node"]\nscript = ExtResource("1")\n');
  writeFileSync(join(fixture,'probe.gd'),`extends Node
var process_count = 0
var physics_count = 0
var process_elapsed = 0.0
var physics_elapsed = 0.0
var timer_fired = false
var start_us = Time.get_ticks_usec()
func _ready():
\tget_tree().create_timer(2.5).timeout.connect(func(): timer_fired = true)
func _process(delta):
\tprocess_count += 1
\tprocess_elapsed += delta
func _physics_process(delta):
\tphysics_count += 1
\tphysics_elapsed += delta
func _exit_tree():
\tprint("INDEPENDENT_PHYSICS_REPORT "+JSON.stringify({"process_count":process_count,"physics_count":physics_count,"process_elapsed":process_elapsed,"physics_elapsed":physics_elapsed,"timer_fired":timer_fired,"wall_seconds":(Time.get_ticks_usec()-start_us)/1000000.0}))
`);
  for(const mode of ['baseline','fixed'])await run('physics-'+mode,fixture,['--headless','--path',fixture,'--quit-after','180',...(mode==='fixed'?['--fixed-fps','60']:[])],{marker:'INDEPENDENT_PHYSICS_REPORT'});
  const diagnostics=report.commands.filter(row=>row.stage.startsWith('physics-'));
  assert.equal(diagnostics.length,2);for(const row of diagnostics)assert.equal(row.physics_report.process_count,180);
  assert.ok(diagnostics[1].physics_report.physics_count>=179);assert.ok(diagnostics[1].physics_report.timer_fired);
  assert.equal(new Set(report.commands.map(row=>row.save_domain)).size,report.commands.length);
  report.completed=true;save();console.log(JSON.stringify({out,totals,physics:diagnostics.map(row=>({stage:row.stage,...row.physics_report}))}));
  }
}catch(error){report.error=error.stack;save();throw error;}
finally{
  for(const child of active)try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}
  if(!process.argv.includes('--keep-projects')){rmSync(project,{recursive:true,force:true});rmSync(join(out,'physics-fixture'),{recursive:true,force:true});}
  save();
}
