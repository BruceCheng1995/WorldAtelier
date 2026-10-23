/** Independent actual Godot native client/authority checks. The relay may delay
 * or drop actual packets; it NEVER constructs positive runtime acknowledgments.
 * Original CLI startup and instrumented input execution have separate receipts. */
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer as createHttpServer} from 'node:http';
import {WebSocket,WebSocketServer} from 'ws';
import {clientRequest,prepareNativeClient} from '../../tools/native-client.mjs';
import {Evidence,IsolatedService,ROOT,ORIGIN,request,registerActor,waitFor,delay,sha256,redact} from './next-wave-test-support.mjs';
import {nativeImportFiles} from './next-wave-author-fixture.mjs';
const exec=promisify(execFile),godot='/Applications/Godot.app/Contents/MacOS/Godot';
const heldData=process.argv.find(value=>value.startsWith('--held-transfer='))?.slice('--held-transfer='.length);
const evidence=new Evidence(heldData?'native-held-transfer-independent':'native-client-independent',{layers:['A','G'],scope:heldData?'Narrow actual held-input handoff using an already verified fixed shared build; no new export or fabricated acknowledgement.':'Actual native_shared canonical authority plus original portable CLI and separately instrumented Godot input. No exported native executable or browser claims.'});
const service=new IsolatedService(evidence,{worlds:true,...(heldData?{data:heldData}:{})});
let actor,project,route,revision,publication,api,completed=false;
const processes=[],relays=[];
const check=async(id,text,fn)=>{console.log('NEXT_WAVE_CASE_START '+id+' '+text);await evidence.check(id,text,['A','G'],fn);console.log('NEXT_WAVE_CASE_PASS '+id);};
const cliArgs=directory=>['tools/native-client.mjs','connect','--server='+ORIGIN,'--project='+project.id,'--branch=main','--scene=journey-a','--dir='+directory,'--headless','--timeout=5','--no-follow'];
function spawnOwned(label,command,args,options={}){
 const child=spawn(command,args,{cwd:ROOT,detached:true,stdio:['ignore','pipe','pipe'],...options});const item={label,child,stdout:'',stderr:'',status:[],closed:false,started_at:Date.now()};processes.push(item);
 evidence.report.processes.push({role:label,pid:child.pid,started_at:new Date().toISOString()});
 child.stdout.on('data',value=>{item.stdout+=value.toString();for(const line of item.stdout.split('\n').slice(item.parsed??0,-1)){let value;try{value=JSON.parse(line.startsWith('NATIVE_CLIENT_STATUS ')?line.slice(21):line);}catch{}if(value?.status)item.status.push(value);}item.parsed=item.stdout.split('\n').length-1;});
 child.stderr.on('data',value=>item.stderr+=value.toString());
 item.done=new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{item.closed=true;item.result={code,signal};done(item.result);});});
 item.stop=async()=>{if(!item.closed)try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([item.done,delay(5000)]);if(!item.closed)try{process.kill(-child.pid,'SIGKILL');}catch{}await item.done;};
 return item;
}
const latest=client=>[...client.status].reverse().find(row=>row.status==='active'&&row.nodes);
const rootState=client=>latest(client)?.nodes?.['[[],"world-root"]']?.state;
async function active(client,{after=0}={}){return waitFor('real '+client.label+' control confirmation',()=>{if(client.closed)throw Error(client.label+' exited: '+client.stderr+' '+client.stdout.slice(-5000));return client.status.slice(after).find(row=>row.status==='active');},{timeout:30000,interval:100});}
async function checkout(){return (await request('POST','/creation-api/native-clients/checkouts',{actor,body:{request_id:'independent-'+randomUUID(),project_id:project.id,branch_id:'main',resource_id:'journey-a'},expected:201})).value;}
async function view(value){return (await request('GET','/creation-api/native-clients/checkouts/'+value.id,{actor})).value;}

class PacketRelay{
 constructor(label,{holdReady=0,dropConfirmed=false}={}){this.label=label;this.holdReady=holdReady;this.dropConfirmed=dropConfirmed;this.events=[];this.held=[];this.heldInputs=[];this.holdInputs=false;this.readyCount=0;relays.push(this);}
 async start(){this.server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(done=>this.server.once('listening',done));this.url='ws://127.0.0.1:'+this.server.address().port+'/relay';this.server.on('connection',downstream=>{this.downstream=downstream;const upstream=this.upstream=new WebSocket(ORIGIN.replace('http:','ws:')+'/ws/native-client');const queued=[];
 const send=bytes=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(bytes);else queued.push(bytes);};upstream.on('open',()=>{for(const bytes of queued)upstream.send(bytes);});
 downstream.on('message',bytes=>{const packet=JSON.parse(bytes.toString());this.events.push({direction:'to-server',at:Date.now(),type:packet.type,packet:packet.packet,input:packet.input});if(packet.type==='native_ready'&&++this.readyCount===this.holdReady){this.held.push({bytes:Buffer.from(bytes),send});return;}if(packet.type==='world_input'&&this.holdInputs){this.heldInputs.push({bytes:Buffer.from(bytes),send});return;}send(bytes);});
 upstream.on('message',bytes=>{const packet=JSON.parse(bytes.toString());this.events.push({direction:'to-client',at:Date.now(),type:packet.type,action:packet.packet?.action,packet:packet.packet});if(this.dropConfirmed&&packet.packet?.action==='control_confirmed'){this.held.push({bytes:Buffer.from(bytes),send:message=>downstream.send(message)});return;}if(downstream.readyState===WebSocket.OPEN)downstream.send(bytes);});
 downstream.on('close',()=>upstream.close());upstream.on('close',()=>downstream.close());upstream.on('error',()=>{});downstream.on('error',()=>{});
 });return this;}
 release(){for(const item of this.held.splice(0))item.send(item.bytes);}
 releaseInputs(){this.holdInputs=false;for(const item of this.heldInputs.splice(0))item.send(item.bytes);}
 async close(){this.downstream?.terminate();this.upstream?.terminate();if(this.server)await new Promise(done=>this.server.close(done));this.server=null;evidence.json(this.label+'-relay.json',this.events);}
}

// Only this extra Autoload and project.godot Autoload entry differ from the
// downloaded package. It sends real InputEventAction and real button signals.
// It never calls transport/shared.receive or creates acknowledgments/state.
const probe=`extends Node
var done_id = ""
var clock = 0.0
func _ready() -> void:
\tprocess_mode = Node.PROCESS_MODE_ALWAYS
\tprint("NW_NATIVE_PROBE " + JSON.stringify({"creator_token_present":not OS.get_environment("WORLD_ATELIER_TOKEN").is_empty()}))
func _process(delta: float) -> void:
\tclock += delta
\tif clock < 0.1: return
\tclock = 0.0
\tvar path = OS.get_environment("NW_INPUT_COMMAND_FILE")
\tif not FileAccess.file_exists(path): return
\tvar command: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
\tif not command is Dictionary or command.get("id", "") == done_id: return
\tdone_id = str(command.id)
\tvar runtime: Node = get_node("/root/GameRuntime")
\tif command.kind == "button":
\t\tvar button: BaseButton = runtime.game_scene.get_node("HUD/" + str(command.name)) as BaseButton
\t\tbutton.pressed.emit()
\telif command.kind == "key":
\t\tvar event = InputEventAction.new()
\t\tevent.action = str(command.action)
\t\tevent.pressed = bool(command.pressed)
\t\tInput.parse_input_event(event)
\tprint("NW_NATIVE_COMMAND " + JSON.stringify({"id":done_id,"kind":command.kind,"scene":runtime.current_scene_id}))
`;
async function instrumented(label,{relay=null}={}){
 const fixed=await checkout(),prepared=await prepareNativeClient({request:api,checkout:fixed,directory:join(service.data,'native-cache')});
 const directory=join(service.data,'native-executions',label+'-'+randomUUID()),projectPath=join(directory,'project');mkdirSync(projectPath,{recursive:true});
 for(const file of fixed.files){const destination=join(projectPath,file.path);mkdirSync(dirname(destination),{recursive:true});copyFileSync(join(prepared.project,file.path),destination);}
 const configPath=join(projectPath,'project.godot'),baseConfig=readFileSync(configPath,'utf8');assert.match(baseConfig,/\[autoload\]/);writeFileSync(configPath,baseConfig.replace('[autoload]','[autoload]\nIndependentInput="*res://independent_input.gd"'));writeFileSync(join(projectPath,'independent_input.gd'),probe);
 const environment=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));environment.GODOT_SILENCE_ROOT_WARNING='1';
 const imported=await exec(godot,['--headless','--audio-driver','Dummy','--editor','--import','--path',projectPath],{env:environment,timeout:90000,maxBuffer:3*1024*1024});evidence.text(label+'-import.log',imported.stdout+imported.stderr);assert.doesNotMatch(imported.stdout+imported.stderr,/SCRIPT ERROR|Parse Error|ERROR:/);
 for(const file of fixed.files)if(file.path!=='project.godot')assert.equal(sha256(readFileSync(join(projectPath,file.path))),file.sha256,'Native test overlay must preserve '+file.path);
 const access=(await request('POST','/creation-api/native-clients/checkouts/'+fixed.id+'/access',{actor,body:{}})).value;
 const config=join(directory,'launch.json'),command=join(directory,'commands.json');writeFileSync(config,JSON.stringify({format:'wa-native-client-launch-1',ticket:access.ticket,websocket_url:relay?.url??access.websocket_url,runtime_instance_id:randomUUID()}),{mode:0o600});
 const client=spawnOwned(label,godot,['--headless','--audio-driver','Dummy','--max-fps','30','--path',projectPath],{env:{...environment,WA_NATIVE_CLIENT_CONFIG:config,NW_INPUT_COMMAND_FILE:command},cwd:directory});Object.assign(client,{fixed,prepared,directory,command,relay});
 client.issue=async value=>{const id=randomUUID();writeFileSync(command,JSON.stringify({id,...value}));await waitFor('real authored input '+label,()=>client.stdout.includes(id),{timeout:5000});};
 evidence.json(label+'-execution.json',{checkout_id:fixed.id,source_revision:fixed.source_revision,manifest_hash:fixed.manifest_hash,downloaded_bytes:prepared.downloaded_bytes,reused_bytes:prepared.reused_bytes,original_project:prepared.project,execution_project:projectPath,overlay:{source:probe,sha256:sha256(probe),config_original:sha256(baseConfig),config_instrumented:sha256(readFileSync(configPath))},boundary:'Only original CLI case proves unmodified startup. This execution includes explicitly recorded input-only Autoload; all runtime and authority ACKs are genuine.'});
 return client;
}
async function clickDoor(client,expected){await client.issue({kind:'button',name:'Door'});return waitFor('actual authority door interaction '+expected,()=>rootState(client)?.attempts===expected&&latest(client),{timeout:10000,interval:100});}

try{
 await service.start();
 if(heldData){
  const saved=JSON.parse(readFileSync(join(service.data,'independent-native-state.json')));({actor,project,revision,publication}=saved);route='/creation-api/projects/'+project.id+'/branches/main';api=clientRequest(ORIGIN,actor.token);
  let oldEndpoint;
  await check('NC09','A held native direction advances during preparation, stops at the real fence, and resumes only under the new endpoint',async receipt=>{
   assert.equal((await request('GET',route,{actor})).value.head,revision);
   const a=await instrumented('held-native-a');await active(a);assert.equal(a.fixed.game_build_id,publication.verification.game_build_id);
   const key=JSON.stringify([['player-'+actor.user.id],'actor-root']);
   const actorState=client=>latest(client)?.nodes?.[key]?.state;
   await a.issue({kind:'key',action:'move_right',pressed:true});await waitFor('actual held native movement',()=>actorState(a)?.motion===1,{timeout:10000});
   const relay=await new PacketRelay('held-input-handoff',{holdReady:1}).start(),b=await instrumented('held-native-b',{relay});await waitFor('replacement actual ready held during motion',()=>relay.held.length>0,{timeout:30000});
   const preparing=(await view(b.fixed)).transfer;assert.equal(preparing.status,'preparing');const before=latest(a),beforeDistance=actorState(a).distance;
   await delay(1400);const during=await waitFor('old actual input continues while candidate prepares',()=>{const state=latest(a);return state?.tick>before.tick&&actorState(a).motion===1&&actorState(a).distance>beforeDistance&&state;},{timeout:10000});
   relay.release();await active(b);await waitFor('real old endpoint transferred',()=>a.status.some(row=>row.status==='transferred'),{timeout:10000});
   await waitFor('authority has stopped held direction at fence',()=>actorState(b)?.motion===0,{timeout:10000});const stopped=latest(b),stoppedDistance=actorState(b).distance;
   await delay(1500);const stable=await waitFor('authority still ticks after held input is fenced',()=>latest(b)?.tick>stopped.tick&&latest(b),{timeout:10000});
   assert.equal(actorState(b).motion,0);assert.equal(actorState(b).distance,stoppedDistance,'Old held input must not continue moving authority');assert.deepEqual(stable.nodes[key].transform,stopped.nodes[key].transform,'Authority position remains stable after fence');
   await b.issue({kind:'key',action:'move_right',pressed:true});await waitFor('new endpoint moves the same actor',()=>actorState(b)?.motion===1&&actorState(b).distance>stoppedDistance,{timeout:10000});const moved=latest(b);await b.issue({kind:'key',action:'move_right',pressed:false});await waitFor('actual new input release',()=>actorState(b)?.motion===0,{timeout:10000});
   const transfer=(await view(b.fixed)).transfer;assert.equal(transfer.status,'active');assert.ok(transfer.stop_input_seq>0);assert.equal(b.fixed.game_build_id,a.fixed.game_build_id);assert.equal((await request('GET',route,{actor})).value.head,revision);
   receipt.fixed_build_id=a.fixed.game_build_id;receipt.world_id=stable.world_id;receipt.epoch=stable.epoch;receipt.owner_key=key;receipt.preparing={before_tick:before.tick,after_tick:during.tick,before_distance:beforeDistance,after_distance:during.nodes[key].state.distance};receipt.fenced={tick:stopped.tick,later_tick:stable.tick,distance:stoppedDistance,motion:0,unchanged_transform:stable.nodes[key].transform};receipt.new_endpoint={tick:moved.tick,distance:moved.nodes[key].state.distance};receipt.transfer=transfer;receipt.boundary='Explicit input-only Autoload in private execution copies; original fixed runtime files unchanged and all successful prepare/control/state acknowledgments originate in actual Godot.';oldEndpoint=b;
  });
  await check('NC10','A real delayed held input is rejected nonfatally after fencing, then the failed replacement restores the actual old client',async receipt=>{
   const old=oldEndpoint,key=JSON.stringify([['player-'+actor.user.id],'actor-root']),state=()=>latest(old)?.nodes?.[key]?.state;
   await old.issue({kind:'key',action:'move_right',pressed:true});await waitFor('old endpoint moving before failed transfer',()=>state()?.motion===1,{timeout:10000});
   old.relay.holdInputs=true;await waitFor('actual held input retained in test transport',()=>old.relay.heldInputs.length>0,{timeout:5000});
   const mark=old.status.length,networkMark=old.relay.events.length,relay=await new PacketRelay('held-input-failed-replacement',{holdReady:2}).start(),candidate=await instrumented('held-native-failed',{relay});await waitFor('actual final candidate baseline held',()=>relay.held.length>0,{timeout:30000});
   assert.equal((await view(candidate.fixed)).transfer.status,'synchronizing');old.relay.releaseInputs();
   const negative=await waitFor('actual late held input received structured negative ACK',()=>old.relay.events.slice(networkMark).find(row=>row.action==='input_ack'&&row.packet?.ok===false&&row.packet?.code==='CONTROL_FENCED'),{timeout:10000});
   assert.equal(old.closed,false);assert.equal(old.status.slice(mark).some(row=>row.status==='failed'),false);
   await relay.close();await candidate.done;
   const recovered=await waitFor('actual old held-input endpoint recovered',async()=>{const transfer=(await view(candidate.fixed)).transfer;return transfer?.status==='failed_recovered'&&transfer;},{timeout:15000});
   await waitFor('old recovery reports actual control and stopped motion',()=>old.status.slice(mark).some(row=>row.status==='active')&&state()?.motion===0,{timeout:10000});
   const distance=state().distance;await delay(1300);assert.equal(state().distance,distance,'Old held input must remain cleared after recovery');
   await old.issue({kind:'key',action:'move_right',pressed:false});await old.issue({kind:'key',action:'move_right',pressed:true});await waitFor('actual fresh input after recovery moves authority',()=>state()?.motion===1&&state().distance>distance,{timeout:10000});const final=latest(old);await old.issue({kind:'key',action:'move_right',pressed:false});
   receipt.fixed_build_id=old.fixed.game_build_id;receipt.negative_ack={ok:negative.packet.ok,code:negative.packet.code,input_seq:negative.packet.input_seq};receipt.old_process_remained_alive=true;receipt.recovery=recovered;receipt.stable_recovered_distance=distance;receipt.new_actual_distance=final.nodes[key].state.distance;receipt.tick=final.tick;
  });
  completed=true;
 }else{
 await check('NC01','Create and explicitly publish actual canonical native shared authority',async receipt=>{
  actor=await registerActor('native-owner');api=clientRequest(ORIGIN,actor.token);
  const created=(await request('POST','/creation-api/projects',{actor,body:{name:'Independent native handoff '+randomUUID().slice(0,6),template:'empty'},expected:201,timeout:120000})).value;project=created.project;route='/creation-api/projects/'+project.id+'/branches/main';
  const imported=(await request('POST',route+'/transactions',{actor,body:{transaction_id:'fixture-'+randomUUID(),base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:nativeImportFiles()}]},timeout:120000})).value;revision=imported.revision;
  publication=(await request('POST',route+'/publish',{actor,body:{request_id:'publish-'+randomUUID(),revision,resource_id:'journey-a'},timeout:300000})).value;
  assert.equal(publication.verification.status,'passed');assert.ok(publication.verification.report.observed_ticks>=120);evidence.json('actual-native-publication.json',publication);
  receipt.source_revision=revision;receipt.verification_id=publication.verification.id;receipt.game_build_id=publication.verification.game_build_id;receipt.observed_ticks=publication.verification.report.observed_ticks;
  writeFileSync(join(service.data,'independent-native-state.json'),JSON.stringify({actor,project,branch_id:'main',resource_id:'journey-a',revision,publication})+'\n',{mode:0o600});
 });
 await check('NC02','Unmodified portable CLI imports and launches the verified fixed native project',async receipt=>{
  const cache=join(service.data,'original-cli'),cli=spawnOwned('unmodified-cli',process.execPath,cliArgs(cache),{env:{...process.env,WORLD_ATELIER_TOKEN:actor.token}});
  await active(cli);const result=await cli.done;assert.equal(result.code,0,cli.stderr);assert.ok(cli.status.some(row=>row.status==='active'&&row.tick>0));
  const fixed=JSON.parse(readFileSync(join(cache,'latest-client.json')));const manifest=await view({id:fixed.checkout_id});assert.equal(manifest.transfer.status,'disconnected');
  assert.equal(existsSync(join(cache,'launcher.lock')),false);assert.equal((await request('GET',route,{actor})).value.head,revision);
  receipt.checkout_id=fixed.checkout_id;receipt.manifest_hash=fixed.manifest_hash;receipt.actual_active_samples=cli.status.filter(row=>row.status==='active').length;receipt.exit=result;receipt.boundary='Matching Godot editor binary executes the fixed project. This is not a platform exported native executable.';
 });
 let a,b;
 await check('NC03','Actual native input reaches authority and state advances before handoff',async receipt=>{
  a=await instrumented('native-a');await active(a);await clickDoor(a,1);
  assert.match(a.stdout,/"creator_token_present":false/);await a.issue({kind:'key',action:'move_right',pressed:true});
  const before=latest(a);await delay(1400);const after=await waitFor('authority tick and owned motion advance',()=>{const value=latest(a);return value?.tick>before.tick&&value;},{timeout:10000});
  const key=JSON.stringify([['player-'+actor.user.id],'actor-root']);assert.ok(after.nodes[key].state.distance>before.nodes[key].state.distance);await a.issue({kind:'key',action:'move_right',pressed:false});
  receipt.world_id=after.world_id;receipt.epoch=after.epoch;receipt.before_tick=before.tick;receipt.after_tick=after.tick;receipt.owned_key=key;receipt.distance=after.nodes[key].state.distance;
 });
 await check('NC04','A real prepared replacement waits while old client plays, then takes the same progress',async receipt=>{
  const relay=await new PacketRelay('handoff-success',{holdReady:1}).start();b=await instrumented('native-b',{relay});await waitFor('actual first ready held',()=>relay.held.length>0,{timeout:30000});
  const before=latest(a);await clickDoor(a,2);assert.equal(a.status.at(-1).status,'active');const whilePreparing=await view(b.fixed);assert.equal(whilePreparing.transfer.status,'preparing');
  relay.release();await active(b);await waitFor('actual old client transferred',()=>a.status.some(row=>row.status==='transferred'),{timeout:10000});
  const after=await waitFor('new client received same authored progress',()=>rootState(b)?.attempts===2&&latest(b),{timeout:10000});assert.equal(after.world_id,before.world_id);assert.equal(after.epoch,before.epoch);assert.ok(after.tick>=before.tick);
  await a.issue({kind:'button',name:'Door'});await delay(700);assert.equal(rootState(b).attempts,2);await clickDoor(b,3);
  const received=(await view(b.fixed)).transfer;assert.equal(received.status,'active');assert.ok(received.stop_input_seq>0);receipt.transfer=received;receipt.before_tick=before.tick;receipt.after_tick=after.tick;receipt.preserves_attempts=3;
 });
 await check('NC05','Preparation disconnect leaves existing native input and actual authority running',async receipt=>{
  const relay=await new PacketRelay('fail-preparing',{holdReady:1}).start(),candidate=await instrumented('native-c',{relay});await waitFor('actual prepared packet held',()=>relay.held.length>0,{timeout:30000});await relay.close();await candidate.done;
  const state=await waitFor('failed prepare receipt',async()=>{const transfer=(await view(candidate.fixed)).transfer;return transfer?.status==='failed'&&transfer;},{timeout:10000});await clickDoor(b,4);receipt.transfer=state;receipt.current_tick=latest(b).tick;
 });
 await check('NC06','Final baseline disconnect recovers old endpoint only after real Godot acknowledgments',async receipt=>{
  receipt.old_endpoint_age_ms=Date.now()-b.started_at;
  const mark=b.status.length,relay=await new PacketRelay('fail-synchronizing',{holdReady:2}).start(),candidate=await instrumented('native-d',{relay});await waitFor('actual final ready held',()=>relay.held.length>0,{timeout:30000});
  const waiting=(await view(candidate.fixed)).transfer;assert.equal(waiting.status,'synchronizing');assert.ok(b.status.slice(mark).some(row=>row.status==='handoff_pending'));await relay.close();await candidate.done;await active(b,{after:mark});
  const recovered=await waitFor('real recovery completed',async()=>{const transfer=(await view(candidate.fixed)).transfer;return transfer?.status==='failed_recovered'&&transfer;},{timeout:10000});await clickDoor(b,5);receipt.transfer=recovered;receipt.old_endpoint_actual_recovery=b.status.slice(mark).filter(row=>['applying_baseline','active'].includes(row.status));
 });
 await check('NC07','Post-commit confirmation loss is recorded separately and a new actual connection recovers state',async receipt=>{
  const relay=await new PacketRelay('lost-final-confirmation',{dropConfirmed:true}).start(),candidate=await instrumented('native-e',{relay});await waitFor('actual final confirmation withheld',()=>relay.held.length>0,{timeout:30000});
  const committed=(await view(candidate.fixed)).transfer;assert.equal(committed.status,'active');assert.equal(candidate.status.some(row=>row.status==='active'),false);await relay.close();await candidate.done;
  const disconnected=await waitFor('postcommit disconnect receipt',async()=>{const transfer=(await view(candidate.fixed)).transfer;return transfer?.status==='disconnected'&&transfer;},{timeout:10000});
  const recovered=await instrumented('native-f');await active(recovered);await waitFor('real reconnected retained progress',()=>rootState(recovered)?.attempts===5,{timeout:10000});await clickDoor(recovered,6);
  receipt.server_committed=committed;receipt.target_never_observed_confirmation=true;receipt.disconnected=disconnected;receipt.recovered_checkout=recovered.fixed.id;receipt.boundary='This verifies a fresh explicit reconnect after the uncertain committed result. Automatic original-launcher recovery requires its own relay test.';
 });
 await check('NC08','Unmodified CLI resolves a genuinely committed but lost confirmation and reconnects automatically',async receipt=>{
  // A test-only API relay changes only the first returned WebSocket address.
  // The actual service issues the real checkout, ticket and transfer receipt.
  // No returned source/build/transfer data or successful ACK is fabricated.
  let accessCount=0;const relay=await new PacketRelay('original-cli-lost-confirmation',{dropConfirmed:true}).start();
  const server=createHttpServer(async(req,res)=>{
   try{
    assert.ok(req.url.startsWith('/creation-api/native-clients/'));
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const response=await fetch(ORIGIN+req.url,{method:req.method,headers:{Origin:ORIGIN,...(req.headers.authorization?{Authorization:req.headers.authorization}:{}),...(req.headers['content-type']?{'Content-Type':req.headers['content-type']}:{})},...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
    let bytes=Buffer.from(await response.arrayBuffer());
    if(req.url.endsWith('/access')&&response.ok&&++accessCount===1){const result=JSON.parse(bytes);result.websocket_url=relay.url;bytes=Buffer.from(JSON.stringify(result));}
    res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/octet-stream','Content-Length':bytes.length});res.end(bytes);
   }catch(error){res.writeHead(502);res.end(JSON.stringify({error:error.message}));}
  });await new Promise(done=>server.listen(0,'127.0.0.1',done));
  try{
   const cache=join(service.data,'original-cli-recovery'),args=cliArgs(cache).map(arg=>arg.startsWith('--server=')?'--server=http://127.0.0.1:'+server.address().port:arg);
   const cli=spawnOwned('unmodified-cli-recovery',process.execPath,args,{env:{...process.env,WORLD_ATELIER_TOKEN:actor.token}});
   await waitFor('original CLI genuine final confirmation withheld',()=>relay.held.length>0,{timeout:45000});await relay.close();await active(cli);const result=await cli.done;
   assert.equal(result.code,0,cli.stderr);assert.match(cli.stdout,/"stage":"committed_disconnected"/);assert.match(cli.stdout,/"stage":"recovering_committed_transfer"/);assert.ok(accessCount>=2);
   const telemetry=cli.status.find(row=>row.status==='active'&&row.nodes?.['[[],"world-root"]']?.state?.attempts===6);assert.ok(telemetry,'Automatic real reconnect must preserve authored progress');
   receipt.access_requests=accessCount;receipt.world_id=telemetry.world_id;receipt.retained_attempts=6;receipt.tick=telemetry.tick;receipt.exit=result;receipt.boundary='Original portable CLI and original downloaded project are unmodified; only one actual final server confirmation was dropped by the test transport.';
  }finally{await new Promise(done=>server.close(done));}
 });
 completed=true;
 }
}catch(error){evidence.report.errors.push({message:error.message,stack:error.stack});console.error(error.stack);process.exitCode=1;}
finally{
 for(const item of [...processes].reverse())await item.stop().catch(error=>evidence.report.errors.push({phase:'cleanup',message:error.message}));
 for(const relay of relays)await relay.close().catch(error=>evidence.report.errors.push({phase:'cleanup',message:error.message}));
 for(const item of processes){evidence.text(item.label+'-stdout.log',item.stdout);evidence.text(item.label+'-stderr.log',item.stderr);evidence.json(item.label+'-telemetry.json',item.status);if(item.directory)rmSync(join(item.directory,'launch.json'),{force:true});}
 await service.stop().catch(error=>{evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;});
 evidence.report.retained_test_data=service.data;evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);
}
