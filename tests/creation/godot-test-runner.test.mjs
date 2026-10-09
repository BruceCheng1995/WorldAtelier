import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync,realpathSync,readdirSync,existsSync,rmSync,symlinkSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testInvocation,runTest,embeddedResizePacket} from '../../services/creation/godot-test-runner.mjs';
import {CreationEnvironments} from '../../services/creation/environments.mjs';
import {CodexAgent} from '../../services/creation/codex-agent.mjs';

// The executable in these tests is a Node fixture, never an installed Godot.
const runnerSource=fileURLToPath(new URL('../../services/creation/godot-test-runner.mjs',import.meta.url));
const mac={platform:'darwin'};
const policyError=error=>error.code==='GODOT_TEST_POLICY';
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const fakeSource=`#!${process.execPath}
import {appendFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
const mode=process.env.WA_FAKE_MODE;
let descendant;
if(mode==='ignore-term') {
  process.on('SIGTERM',()=>{});
  descendant=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
}
appendFileSync(process.env.WA_FAKE_JOURNAL,JSON.stringify({pid:process.pid,descendant:descendant?.pid,args:process.argv.slice(2),cwd:process.cwd()})+'\\n');
console.log('WA_FAKE_READY');
if(mode==='peer'||mode==='peer-hang') {
  const endpoint=new URL(process.argv[process.argv.indexOf('--remote-debug')+1]);
  const socket=createConnection({host:endpoint.hostname,port:Number(endpoint.port)});
  let bytes=Buffer.alloc(0),captured=false;
  socket.on('error',error=>{console.error(error);process.exitCode=2;});
  socket.on('data',chunk=>{
    bytes=Buffer.concat([bytes,chunk]);
    if(!captured&&bytes.length>=4&&bytes.length>=bytes.readUInt32LE(0)+4){
      captured=true;socket.write('ignored client output, not a control channel');
      console.log('WA_FAKE_PACKET_READY');
      setTimeout(()=>{writeFileSync(process.env.WA_FAKE_PACKET,bytes);if(mode==='peer')socket.destroy();},100);
    }
  });
} else if(mode==='fallback') {
  process.stdout.write('Display driver embedded failed, falling ');
  setTimeout(()=>process.stdout.write('back to macos\\n'),20);
  setInterval(()=>{},1000);
} else if(mode==='hang'||mode==='ignore-term') setInterval(()=>{},1000);
else process.exitCode=Number(process.env.WA_FAKE_EXIT??0);
`;

function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"wa godot 'test-")));
  const cwd=join(root,'session'),execution=join(cwd,'.execution');
  mkdirSync(execution,{recursive:true});
  const fake=join(root,'fake-godot.mjs'),runner=join(execution,'godot-test-runner.mjs');
  writeFileSync(fake,fakeSource);chmodSync(fake,0o700);
  writeFileSync(runner,readFileSync(runnerSource));
  writeFileSync(join(execution,'godot-test.json'),JSON.stringify({executable:fake,sessionRoot:cwd}));
  const journal=join(root,'invocations.jsonl');
  const packet=join(root,'peer-packet.bin');
  const children=[];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    for(const entry of entries())for(const pid of [entry.pid,entry.descendant])if(pid)try{process.kill(pid,'SIGKILL');}catch{}
    await Promise.all(children.map(child=>child.done));
    rmSync(root,{recursive:true,force:true});
  });
  function entries(){return existsSync(journal)?readFileSync(journal,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];}
  function start(args=[],{mode='exit',exitCode=0,command=process.execPath,commandArgs=[runner,...args],directory=cwd,environment={}}={}){
    const child=spawn(command,commandArgs,{cwd:directory,env:{...process.env,...environment,WA_FAKE_MODE:mode,WA_FAKE_EXIT:String(exitCode),WA_FAKE_JOURNAL:journal,WA_FAKE_PACKET:packet},stdio:['ignore','pipe','pipe']});
    child.output='';
    child.stdout.on('data',data=>child.output+=data);
    child.stderr.on('data',data=>child.output+=data);
    child.done=new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({code,signal,output:child.output}));});
    children.push(child);return child;
  }
  async function ready(child,marker='WA_FAKE_READY'){
    const end=Date.now()+4000;
    while(!child.output.includes(marker)){
      if(child.exitCode!==null||child.signalCode!==null)assert.fail(`Launcher exited before readiness: ${child.output}`);
      if(Date.now()>end)assert.fail(`Fixture did not become ready: ${child.output}`);
      await delay(10);
    }
  }
  function receipts(){const dir=join(cwd,'outputs','godot-tests');return existsSync(dir)?readdirSync(dir).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(dir,name),'utf8'))):[];}
  return {root,cwd,execution,fake,runner,journal,packet,start,ready,entries,receipts,lock:join(cwd,'outputs','godot-tests','render.lock')};
}

// Independent, deliberately small decoder of the official Godot 4.6 wire
// primitives (core/variant/variant.h and core/io/marshalls.cpp), not its encoder.
function decodeDebuggerPacket(bytes){
  let offset=4;
  assert.equal(bytes.readUInt32LE(0),bytes.length-4,'PacketPeer TCP length must match one complete packet');
  function variant(){
    const type=bytes.readUInt32LE(offset);offset+=4;
    if(type===2){const value=bytes.readInt32LE(offset);offset+=4;return value;}
    if(type===4){const length=bytes.readUInt32LE(offset);offset+=4;const value=bytes.toString('utf8',offset,offset+length);offset+=Math.ceil(length/4)*4;return value;}
    if(type===6){const value={type:'Vector2i',x:bytes.readInt32LE(offset),y:bytes.readInt32LE(offset+4)};offset+=8;return value;}
    if(type===28){const length=bytes.readUInt32LE(offset);offset+=4;return Array.from({length},variant);}
    assert.fail(`Unexpected Variant type ${type}`);
  }
  const message=variant();assert.equal(offset,bytes.length,'No extra packets or control commands');
  assert.equal(message.length,3,'RemoteDebugger::_poll_messages requires [String, INT thread, Array]');
  assert.equal(typeof message[0],'string');assert.equal(message[1],1,'Thread::MAIN_ID is 1');assert.ok(Array.isArray(message[2]));
  return message;
}

async function assertPeerClosed(endpoint){
  const uri=new URL(endpoint);
  assert.equal(uri.hostname,'127.0.0.1');assert.ok(Number(uri.port)>0);
  await new Promise((done,reject)=>{
    const socket=createConnection({host:uri.hostname,port:Number(uri.port)});
    socket.once('connect',()=>{socket.destroy();reject(Error('Private debugger listener remained open after test completion'));});
    socket.once('error',error=>{try{assert.equal(error.code,'ECONNREFUSED');done();}catch(failure){reject(failure);}});
    socket.setTimeout(1000,()=>{socket.destroy();reject(Error('Timed out checking debugger listener cleanup'));});
  });
}

test('resize packet uses the actual Godot 4.6 typed three-part debugger envelope',()=>{
  const bytes=embeddedResizePacket(1280,720);
  // Godot Variant types: Array=28, String=4, INT=2, Vector2i=6; 4-byte LE alignment.
  const golden=Buffer.from('40000000 1c000000 03000000 04000000 11000000 656d6265643a77696e646f775f73697a65 000000 02000000 01000000 1c000000 01000000 06000000 00050000 d0020000'.replaceAll(' ',''),'hex');
  assert.deepEqual(bytes,golden);
  assert.deepEqual(decodeDebuggerPacket(bytes),['embed:window_size',1,[{type:'Vector2i',x:1280,y:720}]]);
  assert.deepEqual(decodeDebuggerPacket(embeddedResizePacket(64,1920))[2],[{type:'Vector2i',x:64,y:1920}]);
});

test('logic tests default to silent headless and retain import/script arguments',()=>{
  const plan=testInvocation(['--editor','--import','--path','work/game','--script','res://logic_test.gd']);
  assert.equal(plan.mode,'headless');assert.equal(plan.timeout_ms,180000);
  assert.deepEqual(plan.args.slice(0,6),['--editor','--import','--path','work/game','--script','res://logic_test.gd']);
  assert.deepEqual(plan.args.slice(6),['--headless','--audio-driver','Dummy']);
  assert.equal(plan.args.includes('--embedded'),false);
});

test('visual tests require supported background rendering and have bounded frames and FPS',()=>{
  const plan=testInvocation(['--wa-render','--display-driver','embedded','--audio-driver','Dummy','--max-fps','240','--quit-after','999999'],mac);
  assert.equal(plan.mode,'background_render');assert.equal(plan.timeout_ms,120000);
  assert.deepEqual(plan.resolution,[1280,720]);
  assert.deepEqual(plan.args,['--embedded','--audio-driver','Dummy','--quit-after','1800','--debug','--ignore-error-breaks','--max-fps','30']);
  const slower=testInvocation(['--wa-render','--max-fps','12','--quit-after','7','--wa-timeout','9'],mac);
  assert.equal(slower.timeout_ms,9000);assert.equal(slower.args.at(-1),'12');
  assert.equal(slower.args[slower.args.indexOf('--quit-after')+1],'7');
  for(const platform of ['linux','win32'])assert.throws(()=>testInvocation(['--wa-render'],{platform}),policyError);
  assert.throws(()=>testInvocation(['--wa-render','--headless'],mac),policyError);
});

test('background resolution rejects malformed or oversized surfaces and preserves requested dimensions',()=>{
  for(const size of ['63x720','1280x63','1921x720','1280x1921','0x0','-800x600','800X600','800.5x600','Infinityx720','800x600x2']){
    assert.throws(()=>testInvocation(['--wa-render','--resolution',size],mac),policyError,size);
  }
  assert.throws(()=>testInvocation(['--wa-render','--resolution'],mac),policyError);
  for(const size of ['64x64','800x600','1920x1920']){
    const plan=testInvocation(['--wa-render','--resolution',size],mac);
    assert.deepEqual(plan.resolution,size.split('x').map(Number));
    assert.equal(plan.args[plan.args.indexOf('--resolution')+1],size);
  }
  assert.deepEqual(testInvocation(['--wa-render','--resolution','800x600','--resolution','640x480'],mac).resolution,[640,480]);
});

test('engine options cannot restore audible output or a desktop display',()=>{
  for(const args of [
    ['--audio-driver','CoreAudio'],['--audio-driver','Dummy','--audio-driver','CoreAudio'],
    ['--display-driver','macos'],['--display-driver','headless','--display-driver','macos'],
    ['--embedded'],['--audio-driver=CoreAudio'],['--display-driver=macos'],
    ['--wa-render','--audio-driver','CoreAudio'],['--wa-render','--display-driver','macos'],
    ['--wa-render','--editor'],['--wa-render','--import'],['--wa-render','-p'],
    ['--fullscreen'],['--remote-debug','tcp://127.0.0.1:6007'],['--wid','123'],['--xr-mode','on'],
  ])assert.throws(()=>testInvocation(args,mac),policyError,JSON.stringify(args));
  const normalized=testInvocation(['--headless','--display-driver','headless','--audio-driver','Dummy']);
  assert.equal(normalized.args.filter(arg=>arg==='--headless').length,1);
  assert.equal(normalized.args.filter(arg=>arg==='--audio-driver').length,1);
});

test('wall deadlines reject unbounded or malformed values and frame limits are capped',()=>{
  for(const value of ['0','-1','Infinity','NaN','1.5','301'])assert.throws(()=>testInvocation(['--wa-timeout',value]),policyError);
  assert.throws(()=>testInvocation(['--wa-render','--wa-timeout','121'],mac),policyError);
  assert.throws(()=>testInvocation(['--wa-timeout']),policyError);
  assert.throws(()=>testInvocation(['--wa-timeout','--headless']),policyError);
  assert.equal(testInvocation(['--wa-timeout','300']).timeout_ms,300000);
  for(const option of ['--quit-after','--max-fps'])for(const value of ['0','-1','Infinity','NaN','1.5'])assert.throws(()=>testInvocation([option,value]),policyError);
  const plan=testInvocation(['--quit-after','999999']);
  assert.equal(plan.args[plan.args.indexOf('--quit-after')+1],'18000');
});

test('import, export and explicit completion retain their own exit condition with a wall deadline',()=>{
  for(const args of [
    ['--import'],['--editor','--quit'],['--version'],['--help'],['--check-only','--script','res://test.gd'],
    ['--export-release','Web','build/index.html'],['--export-debug','Web','build/index.html'],['--export-pack','Web','build/game.pck'],
    ['--import','--quit-after','99'],
  ]){
    const plan=testInvocation(args);
    assert.equal(plan.args.includes('--quit-after'),false,JSON.stringify(args));
    assert.equal(plan.timeout_ms,180000);
    assert.equal(plan.args.includes('--headless'),true);
  }
  assert.equal(testInvocation(['--script','res://test.gd']).args.includes('--quit-after'),true);
});

test('Godot user-argument separators preserve user data after mandatory engine options',()=>{
  for(const separator of ['--','++']){
    const user=[separator,'--audio-driver','CoreAudio','--display-driver','macos','--wa-render','--wa-timeout','999','two words'];
    const plan=testInvocation(['--script','res://test.gd',...user]);
    assert.equal(plan.mode,'headless');assert.equal(plan.timeout_ms,180000);
    assert.deepEqual(plan.args.slice(plan.args.indexOf(separator)),user);
    assert.deepEqual(plan.args.slice(0,plan.args.indexOf(separator)),['--script','res://test.gd','--headless','--audio-driver','Dummy','--quit-after','10800']);
  }
});

test('launcher preserves user argv, runs silently and records an actual child failure', {timeout:8000},async t=>{
  const f=fixture(t),user=['--','--audio-driver','CoreAudio','two words'];
  const result=await f.start(['--path',f.cwd,...user],{exitCode:7}).done;
  assert.equal(result.code,7);assert.equal(result.signal,null);
  const [call]=f.entries(),[receipt]=f.receipts();
  assert.deepEqual(call.args.slice(call.args.indexOf('--')),user);
  const engineArgs=call.args.slice(0,call.args.indexOf('--'));
  assert.equal(engineArgs[engineArgs.indexOf('--audio-driver')+1],'Dummy');
  assert.equal(engineArgs.includes('--headless'),true);
  assert.ok(engineArgs[engineArgs.indexOf('--log-file')+1].startsWith(join(f.cwd,'outputs','godot-tests')));
  assert.equal(receipt.pid,call.pid);assert.equal(receipt.exit_code,7);
  assert.equal(receipt.launcher_exit_code,7);assert.equal(receipt.reason,null);assert.equal(receipt.audio_driver,'Dummy');
});

test('deadline kills a child that ignores SIGTERM and its descendant', {timeout:10000},async t=>{
  const f=fixture(t),child=f.start(['--wa-timeout','1'],{mode:'ignore-term'});
  await f.ready(child);
  const result=await child.done;
  assert.equal(result.code,124);
  const [receipt]=f.receipts();assert.equal(receipt.reason,'TIMEOUT');assert.equal(receipt.signal,'SIGKILL');
  assert.ok(receipt.finished_at-receipt.started_at>=1000);
  assert.ok(receipt.finished_at-receipt.started_at<7000);
  for(const pid of [f.entries()[0].pid,f.entries()[0].descendant]){
    const end=Date.now()+1500;
    for(;;){try{process.kill(pid,0);}catch(error){assert.equal(error.code,'ESRCH');break;}
      assert.ok(Date.now()<end,`Fixture process ${pid} remained alive after launcher completion`);await delay(20);}
  }
});

test('SIGTERM cancels the actual test and releases the background rendering lock', {skip:process.platform!=='darwin',timeout:8000},async t=>{
  const f=fixture(t),child=f.start(['--wa-render'],{mode:'hang'});
  await f.ready(child);assert.equal(readFileSync(f.lock,'utf8'),String(child.pid));
  child.kill('SIGTERM');const result=await child.done;
  assert.equal(result.code,1);assert.equal(f.receipts()[0].reason,'SIGTERM');
  assert.equal(existsSync(f.lock),false);
  assert.equal((await f.start(['--wa-render']).done).code,0);
});

test('a live session rendering lock prevents a second process and becomes reusable', {skip:process.platform!=='darwin',timeout:10000},async t=>{
  const f=fixture(t),first=f.start(['--wa-render'],{mode:'hang'});
  await f.ready(first);
  const second=await f.start(['--wa-render']).done;
  assert.equal(second.code,1);assert.match(second.output,/already has a rendering test/);
  assert.equal(f.entries().length,1);assert.equal(readFileSync(f.lock,'utf8'),String(first.pid));
  first.kill('SIGTERM');await first.done;
  assert.equal(existsSync(f.lock),false);
  assert.equal((await f.start(['--wa-render']).done).code,0);assert.equal(f.entries().length,2);
});

test('stale render locks recover; invalid locks fail without starting a child', {skip:process.platform!=='darwin',timeout:10000},async t=>{
  const f=fixture(t),finished=f.start();await finished.done;
  assert.throws(()=>process.kill(finished.pid,0),error=>error.code==='ESRCH');
  writeFileSync(f.lock,String(finished.pid));
  assert.equal((await f.start(['--wa-render']).done).code,0);assert.equal(existsSync(f.lock),false);
  writeFileSync(f.lock,'not-a-pid');
  const invalid=await f.start(['--wa-render']).done;
  assert.equal(invalid.code,1);assert.match(invalid.output,/Render lock is invalid/);
  assert.equal(readFileSync(f.lock,'utf8'),'not-a-pid');assert.equal(f.entries().length,2);
});

test('renderer fallback output aborts the test without retrying and clears its lock', {skip:process.platform!=='darwin',timeout:8000},async t=>{
  const f=fixture(t),result=await f.start(['--wa-render'],{mode:'fallback'}).done;
  assert.equal(result.code,1);assert.equal(f.receipts()[0].reason,'DISPLAY_DRIVER_FALLBACK');
  assert.equal(f.entries().length,1);assert.equal(existsSync(f.lock),false);
});

test('failed executable spawn releases its render lock', {skip:process.platform!=='darwin',timeout:8000},async t=>{
  const f=fixture(t);
  writeFileSync(join(f.execution,'godot-test.json'),JSON.stringify({executable:join(f.root,'missing-godot'),sessionRoot:f.cwd}));
  const result=await f.start(['--wa-render']).done;
  assert.equal(result.code,1);assert.match(result.output,/ENOENT/);assert.equal(existsSync(f.lock),false);assert.equal(f.entries().length,0);
});

test('private loopback peer sends only the requested resize packet and closes after success', {skip:process.platform!=='darwin',timeout:8000},async t=>{
  const f=fixture(t),user=['--','--remote-debug','tcp://user-data.invalid:7000'];
  const result=await f.start(['--wa-render','--resolution','800x600',...user],{mode:'peer'}).done;
  assert.equal(result.code,0,result.output);
  const args=f.entries()[0].args,split=args.indexOf('--'),engine=args.slice(0,split);
  assert.equal(engine.filter(arg=>arg==='--remote-debug').length,1);
  assert.deepEqual(args.slice(split),user);
  const endpoint=engine[engine.indexOf('--remote-debug')+1];
  assert.deepEqual(decodeDebuggerPacket(readFileSync(f.packet)),['embed:window_size',1,[{type:'Vector2i',x:800,y:600}]]);
  assert.deepEqual(f.receipts()[0].resolution,[800,600]);
  await assertPeerClosed(endpoint);assert.equal(existsSync(f.lock),false);
});

test('connected debugger sockets and listener close on deadline and SIGTERM', {skip:process.platform!=='darwin',timeout:12000},async t=>{
  for(const reason of ['TIMEOUT','SIGTERM']){
    const f=fixture(t),child=f.start(['--wa-render','--wa-timeout','1'],{mode:'peer-hang'});
    await f.ready(child,'WA_FAKE_PACKET_READY');
    if(reason==='SIGTERM')child.kill('SIGTERM');
    const result=await child.done;
    assert.equal(result.code,reason==='TIMEOUT'?124:1,result.output);
    const [receipt]=f.receipts();assert.equal(receipt.reason,reason);
    const endpoint=receipt.args[receipt.args.indexOf('--remote-debug')+1];
    await assertPeerClosed(endpoint);assert.equal(existsSync(f.lock),false);
  }
});

test('project cwd and --path cannot escape the session, including through symlinks', {timeout:8000},async t=>{
  const f=fixture(t),outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.cwd,'escape'));
  for(const options of [
    {cwd:outside,args:[]},
    {cwd:f.cwd,args:['--path',outside]},
    {cwd:f.cwd,args:['--path','escape']},
  ])await assert.rejects(runTest({executable:f.fake,sessionRoot:f.cwd,...options}),policyError);
  assert.equal(f.entries().length,0);assert.equal(existsSync(join(f.cwd,'outputs')),false);
});

test('installing and refreshing the session wrapper preserves game files and shell arguments', {timeout:10000},async t=>{
  const f=fixture(t),data=join(f.root,'service data');mkdirSync(data);
  const session={id:"session 'quoted",project_id:'project',branch_id:'main',owner_user_id:'user'};
  const cwd=join(data,'workspaces',session.project_id,session.branch_id,session.owner_user_id,session.id);
  const project=join(cwd,'work','my game');mkdirSync(project,{recursive:true});
  const files=new Map([
    [join(project,'project.godot'),'[audio]\ndriver/driver="CoreAudio"\n'],
    [join(project,'main.tscn'),'[gd_scene format=3]\n[node name="Game" type="Node3D"]\n'],
    [join(cwd,'creator-notes.txt'),'keep unfinished creator work\n'],
  ]);
  for(const [file,contents] of files)writeFileSync(file,contents);
  let checks=0;
  const store={list:()=>[],sessionFor:(user,id,write)=>{assert.equal(user.id,session.owner_user_id);assert.equal(id,session.id);assert.equal(write,true);checks++;return session;},get:(kind,id)=>kind==='creator_editable_project'&&id===session.id?{environment_id:'env',directory:project,source_revision:'src'}:null};
  const manager=new CreationEnvironments({service:{data,store,root:resolve(dirname(runnerSource),'../..')}});manager.godot=f.fake;
  const first=manager.session(session,cwd),again=manager.session(session,cwd);
  assert.equal(checks,2);assert.equal(first.engine.executable,join(cwd,'.execution','godot'));assert.deepEqual(again,first);
  assert.equal(first.godot_project.project_directory,project);assert.equal(first.engine.test_policy.audio,'Dummy');
  assert.equal(first.engine.test_policy.default_mode,'headless');
  assert.equal(statSync(first.engine.executable).mode&0o777,0o700);
  for(const [file,contents] of files)assert.equal(readFileSync(file,'utf8'),contents);
  const result=await f.start([],{command:first.engine.executable,commandArgs:['--path',project,'--','quoted value',"single'quote"],directory:cwd}).done;
  assert.equal(result.code,0,result.output);
  const [call]=f.entries();assert.equal(call.cwd,cwd);
  assert.deepEqual(call.args.slice(call.args.indexOf('--')),['--','quoted value',"single'quote"]);
  assert.equal(call.args[call.args.indexOf('--path')+1],project);
  const adapter=new CodexAgent({workspaceRoot:cwd,spawnProcess:()=>assert.fail('This test must not start a real Agent')});
  const environment=adapter._config(cwd)['shell_environment_policy.set'];
  const fromPath=await f.start([],{command:'godot',commandArgs:['--version'],directory:project,environment}).done;
  assert.equal(fromPath.code,0,fromPath.output);assert.equal(f.entries().length,2);
  assert.equal(f.entries()[1].cwd,project);assert.equal(f.entries()[1].args.includes('--quit-after'),false);
  for(const [file,contents] of files)assert.equal(readFileSync(file,'utf8'),contents);
});
