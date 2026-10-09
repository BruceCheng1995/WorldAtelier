// Copied into each creator session. Keep this launcher self-contained.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';

const invalid=message=>Object.assign(Error(message),{code:'GODOT_TEST_POLICY'});
const valueOf=(args,i)=>{if(i+1>=args.length||args[i+1].startsWith('--'))throw invalid(`Missing value for ${args[i]}`);return args[i+1];};

// Godot 4.6 Variant packet: ["embed:window_size", Thread::MAIN_ID, [Vector2i(w,h)]].
// This private loopback peer only sets the render surface, never desktop input.
export function embeddedResizePacket(width,height){
  const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
  const name=Buffer.from('embed:window_size'),padding=Buffer.alloc((4-name.length%4)%4);
  const body=Buffer.concat([u32(28),u32(3),u32(4),u32(name.length),name,padding,u32(2),u32(1),u32(28),u32(1),u32(6),u32(width),u32(height)]);
  return Buffer.concat([u32(body.length),body]);
}

export function testInvocation(input,{platform=process.platform}={}){
  const split=input.findIndex(a=>a==='--'||a==='++');
  const flags=split<0?[...input]:input.slice(0,split),user=split<0?[]:input.slice(split);
  const render=flags.includes('--wa-render');
  if(render&&platform!=='darwin')throw invalid('Background rendering is unavailable on this host. Use headless tests; do not open a desktop window.');
  const args=[];let timeout=render?120:180,fps=30,frames=render?1800:10800,headless=false,resolution=[1280,720];
  for(let i=0;i<flags.length;i++){
    const flag=flags[i];
    if(flag==='--wa-render')continue;
    if(flag==='--headless'){headless=true;continue;}
    if(flag==='--resolution'){
      const size=valueOf(flags,i++),match=/^(\d+)x(\d+)$/.exec(size);
      if(!match||Number(match[1])<64||Number(match[2])<64||Number(match[1])>1920||Number(match[2])>1920)throw invalid('Background test resolution must be 64..1920 pixels per side.');
      resolution=[Number(match[1]),Number(match[2])];args.push(flag,size);continue;
    }
    if(flag==='--embedded')throw invalid('Use --wa-render for managed background rendering.');
    if(['--display-driver','--audio-driver'].includes(flag)){
      const value=valueOf(flags,i++);
      if(value!==(flag==='--audio-driver'?'Dummy':render?'embedded':'headless'))throw invalid(`${flag} cannot override the silent background test policy.`);
      continue;
    }
    if(flag==='--wa-timeout'){
      timeout=Number(valueOf(flags,i++));
      if(!Number.isInteger(timeout)||timeout<1||timeout>(render?120:300))throw invalid('Test timeout must be 1..120 seconds for rendering or 1..300 for headless.');
      continue;
    }
    if(flag==='--max-fps'){
      const requested=Number(valueOf(flags,i++));
      if(!Number.isInteger(requested)||requested<1)throw invalid('Use a finite positive FPS limit.');
      fps=Math.min(requested,30);continue;
    }
    if(flag==='--quit-after'){
      frames=Number(valueOf(flags,i++));
      if(!Number.isInteger(frames)||frames<1)throw invalid('Use a finite positive frame limit.');
      frames=Math.min(frames,render?1800:18000);continue;
    }
    if(render&&['--editor','-e','--project-manager','-p','--import','--recovery-mode'].includes(flag))throw invalid('Editors and imports must run headless.');
    if(['--remote-debug','--debug-server','--wid','--fullscreen','-f','--always-on-top','--xr-mode'].includes(flag))throw invalid(`${flag} is unavailable in unattended server tests.`);
    // Godot does not support --option=value; reject policy lookalikes explicitly.
    if(/^--(?:audio-driver|display-driver|headless|embedded|wa-|max-fps|quit-after).*?=/.test(flag))throw invalid('Use space-separated test options.');
    args.push(flag);
  }
  if(render&&headless)throw invalid('Choose either headless logic tests or --wa-render visual tests.');
  args.push(render?'--embedded':'--headless','--audio-driver','Dummy');
  // Import/export/--quit set their own completion condition. Overriding it with
  // --quit-after keeps an import editor alive after all work has finished.
  const completionTool=flags.some(flag=>['--import','--editor','-e','--quit','--help','-h','--version','--export-release','--export-debug','--export-pack','--check-only'].includes(flag));
  if(!completionTool)args.push('--quit-after',String(frames));
  // Godot 4.6 embedded requires an initialized EngineDebugger. runTest attaches
  // its private resize peer after this local-debug default, without an editor.
  if(render)args.push('--debug','--ignore-error-breaks','--max-fps',String(fps));
  return {mode:render?'background_render':'headless',timeout_ms:timeout*1000,...(render?{resolution}:{}),args:[...args,...user]};
}

function within(root,path){const actual=realpathSync(path);if(actual!==root&&!actual.startsWith(root+sep))throw invalid('Test project must remain inside this creator session.');return actual;}

export async function runTest({executable,sessionRoot,args,cwd=process.cwd(),env=process.env}){
  const plan=testInvocation(args),root=realpathSync(sessionRoot);
  within(root,cwd);
  const separator=plan.args.findIndex(a=>a==='--'||a==='++');
  const engineArgs=separator<0?plan.args:plan.args.slice(0,separator);
  for(let i=0;i<engineArgs.length;i++)if(engineArgs[i]==='--path')within(root,resolve(cwd,valueOf(engineArgs,i++)));
  const directory=join(root,'outputs','godot-tests');mkdirSync(directory,{recursive:true});
  const receiptFile=join(directory,`${Date.now()}-${process.pid}.json`),logFile=receiptFile.replace(/\.json$/,'.log');
  if(!engineArgs.includes('--log-file'))plan.args.splice(separator<0?plan.args.length:separator,0,'--log-file',logFile);
  const lock=join(directory,'render.lock');let locked=false;
  if(plan.mode==='background_render'){
    for(let attempt=0;attempt<2;attempt++){
      try{writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});locked=true;break;}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        const old=readFileSync(lock,'utf8'),pid=Number(old);
        if(!Number.isInteger(pid)||pid<=0)throw invalid('Render lock is invalid; inspect it before retrying.');
        try{process.kill(pid,0);throw invalid('This session already has a rendering test. Wait for it to finish.');}
        catch(probe){if(probe.code!=='ESRCH')throw probe;}
        if(readFileSync(lock,'utf8')===old)unlinkSync(lock);
      }
    }
    if(!locked)throw invalid('Could not acquire the session rendering lock.');
  }
  const started=Date.now();let child,timer,killTimer,reason=null,peerServer;
  const peers=new Set();
  const kill=signal=>{if(!child?.pid)return;try{process.platform==='win32'?child.kill(signal):process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
  const stop=signal=>{reason??=signal;kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),1500);};
  const onInterrupt=()=>stop('SIGINT'),onTerminate=()=>stop('SIGTERM');
  process.on('SIGINT',onInterrupt);process.on('SIGTERM',onTerminate);
  try{
    if(plan.mode==='background_render'){
      peerServer=createServer(socket=>{
        peers.add(socket);socket.on('error',()=>{});socket.on('close',()=>peers.delete(socket));
        socket.resume();socket.write(embeddedResizePacket(...plan.resolution));
      });
      peerServer.maxConnections=1;
      await new Promise((done,reject)=>{peerServer.once('error',reject);peerServer.listen(0,'127.0.0.1',done);});
      const userSeparator=plan.args.findIndex(a=>a==='--'||a==='++');
      plan.args.splice(userSeparator<0?plan.args.length:userSeparator,0,'--remote-debug',`tcp://127.0.0.1:${peerServer.address().port}`);
    }
    child=spawn(executable,plan.args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    // Never retry with a desktop driver if Godot rejects background rendering.
    let tail='';
    const output=(chunk,stream)=>{
      stream.write(chunk);tail=(tail+chunk.toString()).slice(-4096);
      if(plan.mode==='background_render'&&/Display driver .*failed, falling back to/.test(tail))stop('DISPLAY_DRIVER_FALLBACK');
    };
    child.stdout.on('data',chunk=>output(chunk,process.stdout));
    child.stderr.on('data',chunk=>output(chunk,process.stderr));
    timer=setTimeout(()=>stop('TIMEOUT'),plan.timeout_ms);
    const result=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({exit_code:code,signal}));});
    const code=reason==='TIMEOUT'?124:reason?1:result.exit_code??1;
    writeFileSync(receiptFile,JSON.stringify({version:1,...plan,executable,pid:child.pid,cwd,started_at:started,finished_at:Date.now(),...result,reason,launcher_exit_code:code,audio_driver:'Dummy'},null,2)+'\n');
    return code;
  }finally{
    clearTimeout(timer);clearTimeout(killTimer);kill('SIGKILL');
    for(const socket of peers)socket.destroy();
    if(peerServer?.listening)await new Promise(done=>peerServer.close(done));
    process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate);
    if(locked&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const config=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'godot-test.json'),'utf8'));
    process.exitCode=await runTest({...config,args:process.argv.slice(2)});
  }catch(error){console.error(`${error.code??'GODOT_TEST_FAILED'}: ${error.message}`);process.exitCode=1;}
}
