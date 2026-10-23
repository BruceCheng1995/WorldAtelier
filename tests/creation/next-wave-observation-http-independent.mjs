/** Actual product HTTP/WS routes + SQLite with explicit synthetic observation
 * packets. No browser recording, Godot acknowledgement or Agent run is claimed. */
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {randomUUID} from 'node:crypto';
import {assetFixturePNG} from './asset-test-fixtures.mjs';
import {Evidence,IsolatedService,ORIGIN,request,waitFor} from './next-wave-test-support.mjs';
import {seedRuntimeFixture} from './next-wave-runtime-fixture.mjs';

const evidence=new Evidence('observation-http-independent',{layers:['A'],scope:'Real original product HTTP/WS and SQLite; explicitly synthetic build and client capture packets, no Godot/browser/paid Agent.'});
const service=new IsolatedService(evidence,{agent:false,worlds:false,publicPlay:true}),fixture=seedRuntimeFixture(service.creationData,{name:'observation-http'});
const owner=fixture.accounts.owner,other=fixture.accounts.editor,player=fixture.accounts.player,branchRoute=`/creation-api/projects/${fixture.project_id}/branches/main`;
let session,second,observation,windowHandle,target,completed=false;const peers=[];
const scope={project_id:fixture.project_id,branch_id:'main',source_revision:fixture.job.source_revision,build_id:fixture.job.id,canonical_identity:fixture.job.canonical_identity,runtime_instance_id:'synthetic-runtime-for-protocol-only',resource_id:'entry',scene_generation:1,session_kind:'local_preview'};
const pixel='data:image/png;base64,'+assetFixturePNG(2).toString('base64');
const capture=()=>({protocol:'wa-play-context-1',request_id:'http-capture-'+randomUUID(),scope:{...scope},captured_at:Date.now(),window:{requested_seconds:60,start_ms:1000,end_ms:61000},events:[{id:'e-1',at_ms:5000,kind:'pointer_down',source:'user_input',payload:{button:1}}],snapshot:{objects:[{runtime_id:'runtime-only-door',name:'Private fixture door',observed_values:{open:false}}],tick:120},focus:{kind:'screen_region',rect:[0.2,0.2,0.3,0.3],runtime_ids:['runtime-only-door']},frames:[{id:'f-1',at_ms:60000,captured_at:Date.now(),resource_id:'entry',scene_generation:1,data_url:pixel}],gaps:[]});
const sessionPath=()=>`/creation-api/sessions/${session.id}`;
async function socket(actor){
  const ws=new WebSocket(ORIGIN.replace('http:','ws:')+'/ws/creation',{origin:ORIGIN}),messages=[];
  ws.on('message',bytes=>messages.push(JSON.parse(bytes)));ws.on('error',()=>{});await new Promise((done,reject)=>{ws.once('open',done);ws.once('error',reject);});
  const peer={ws,messages,send:packet=>{assert.ok(!['world_ready','shared_ready','applied'].includes(packet.type));ws.send(JSON.stringify(packet));}};peers.push(peer);peer.send({type:'auth',token:actor.token});await waitFor('actual WS authentication',()=>messages.find(m=>m.type==='authenticated'));return peer;
}
try {
  await service.start();
  await evidence.check('O-HTTP-01','Capture route stores one immutable observation and actual image attachments without starting an Agent',['A'],async receipt=>{
    session=(await request('POST',branchRoute+'/sessions',{actor:owner,body:{title:'Private independent protocol session',visibility:'private'},expected:201})).value;
    second=(await request('POST',branchRoute+'/sessions',{actor:owner,body:{title:'Second independent session',visibility:'private'},expected:201})).value;
    const before=(await request('GET',branchRoute,{actor:owner})).value,input=capture();
    const first=(await request('POST',sessionPath()+'/play-context/captures',{actor:owner,body:input,expected:201})).value;observation=first;
    assert.equal(first.session.runs.length,0);assert.equal(first.session.draft_attachments.filter(a=>a.kind==='play_observation').length,1);assert.equal(first.session.draft_attachments.filter(a=>a.kind==='image').length,1);
    const replay=(await request('POST',sessionPath()+'/play-context/captures',{actor:owner,body:input,expected:201})).value;assert.equal(replay.replayed,true);assert.equal(replay.observation_id,first.observation_id);
    await request('POST',sessionPath()+'/play-context/captures',{actor:owner,body:{...input,focus:{kind:'none'}},expected:409});
    assert.equal((await request('GET',branchRoute,{actor:owner})).value.head,before.head);
    const events=(await request('GET',sessionPath()+`/play-context/observations/${first.observation_id}?section=events&limit=1`,{actor:owner})).value;assert.equal(events.total,1);assert.equal(events.items[0].kind,'pointer_down');
    const frames=(await request('GET',sessionPath()+`/play-context/observations/${first.observation_id}?section=frames`,{actor:owner})).value;
    const bytes=await fetch(ORIGIN+frames.items[0].url,{headers:{authorization:'Bearer '+owner.token}});assert.equal(bytes.status,200);assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),assetFixturePNG(2));
    receipt.observation_id=first.observation_id;receipt.source_head=before.head;receipt.frame_sha256=frames.items[0].sha256;receipt.created_runs=first.session.runs.length;
  });

  await evidence.check('O-HTTP-02','Private captures, frame URLs and event subscriptions reject other creators and players',['A'],async receipt=>{
    for(const actor of [other,player]){
      await request('GET',sessionPath()+`/play-context/observations/${observation.observation_id}?section=objects`,{actor,expected:403});
      const frame=await fetch(`${ORIGIN}${sessionPath()}/play-context/observations/${observation.observation_id}/frames/f-1`,{headers:{authorization:'Bearer '+actor.token}});assert.equal(frame.status,403);
      await request('POST',sessionPath()+'/play-context/captures',{actor,body:capture(),expected:403});
    }
    const peer=await socket(other),mark=peer.messages.length;peer.send({type:'session_subscribe',session_id:session.id,after:0});
    const rejected=await waitFor('private WS subscription rejection',()=>peer.messages.slice(mark).find(m=>m.type==='error'));assert.equal(rejected.status,403);assert.equal(peer.messages.some(m=>m.type==='session_events'&&m.session_id===session.id),false);
    receipt.ws_denial_status=rejected.status;
  });

  await evidence.check('O-HTTP-03','The Origin guard and fixed-scope checks run before writing observations',['A'],async()=>{
    await request('POST',sessionPath()+'/play-context/captures',{actor:owner,body:capture(),headers:{origin:'http://untrusted.invalid'},expected:403});
    for(const patch of [{build_id:'missing-build'},{branch_id:'not-main'},{source_revision:'wrong-source'},{resource_id:'missing-scene'}])await request('POST',sessionPath()+'/play-context/captures',{actor:owner,body:{...capture(),scope:{...scope,...patch}},expected:[403,404,409]});
    const stored=(await request('GET',sessionPath(),{actor:owner})).value;assert.equal(stored.draft_attachments.filter(a=>a.kind==='play_observation').length,1);
  });

  await evidence.check('O-HTTP-04','Window capabilities reject malformed secrets and rebind without cross-session stale handles',['A'],async receipt=>{
    windowHandle=(await request('POST',sessionPath()+'/play-context/windows/register',{actor:owner,body:{window_id:'one-http-window',scope}})).value;
    await request('POST',sessionPath()+`/play-context/windows/${windowHandle.handle}/poll`,{actor:other,body:{secret:windowHandle.secret},expected:403});
    const polled=(await request('POST',sessionPath()+`/play-context/windows/${windowHandle.handle}/poll`,{actor:owner,body:{secret:windowHandle.secret}})).value;assert.deepEqual(polled.requests,[]);
    await request('POST',sessionPath()+`/play-context/windows/${windowHandle.handle}/poll`,{actor:owner,body:{secret:'é'.repeat(windowHandle.secret.length)},expected:403});
    const next=(await request('POST',`/creation-api/sessions/${second.id}/play-context/windows/register`,{actor:owner,body:{window_id:'one-http-window',scope}})).value;
    await request('POST',sessionPath()+`/play-context/windows/${windowHandle.handle}/poll`,{actor:owner,body:{secret:windowHandle.secret},expected:410});
    await request('POST',`/creation-api/sessions/${second.id}/play-context/windows/${next.handle}/close`,{actor:owner,body:{secret:next.secret}});
    await request('POST',`/creation-api/sessions/${second.id}/play-context/windows/${next.handle}/poll`,{actor:owner,body:{secret:next.secret},expected:410});receipt.old_handle_invalidated=true;
  });

  await evidence.check('X-HTTP-01','Continuation makes a private target and does not copy an unsent source draft or observations',['A'],async receipt=>{
    const branch=(await request('POST',`/creation-api/projects/${fixture.project_id}/branches`,{actor:owner,body:{from_branch:'main',branch_id:'night',name:'Night',expected_head:fixture.job.source_revision},expected:201})).value;
    await request('PATCH',sessionPath(),{actor:owner,body:{draft:'UNSENT PRIVATE DRAFT - MUST STAY HERE'}});
    const input={request_id:'http-continue-one',target_branch_id:'night',expected_target_head:branch.head,objective:'Continue on the target without unsent source material',observation_ids:[]};
    await request('POST',sessionPath()+'/continue-context',{actor:owner,body:{...input,request_id:'unsent-observation',observation_ids:[observation.observation_id]},expected:409});
    const first=(await request('POST',sessionPath()+'/continue-context',{actor:owner,body:input})).value;target=first.session;
    assert.equal(target.visibility,'private');assert.equal(target.branch_id,'night');assert.equal(target.executor_thread_id,null);assert.deepEqual(target.runs,[]);assert.equal(target.draft,input.objective);
    const history=(await request('GET',`/creation-api/sessions/${target.id}/continued-context?section=messages`,{actor:owner})).value;assert.equal(history.total,0);
    const summary=(await request('GET',`/creation-api/sessions/${target.id}/continued-context`,{actor:owner})).value;assert.deepEqual(summary.observation_ids,[]);
    assert.equal((await request('GET',sessionPath(),{actor:owner})).value.draft,'UNSENT PRIVATE DRAFT - MUST STAY HERE');
    const again=(await request('POST',sessionPath()+'/continue-context',{actor:owner,body:input})).value;assert.equal(again.session.id,target.id);assert.equal(again.replayed,true);
    await request('POST',sessionPath()+'/continue-context',{actor:owner,body:{...input,objective:'Different intent'},expected:409});
    receipt.target_session_id=target.id;receipt.source_messages=history.total;receipt.target_branch=target.branch_id;
  });

  await evidence.check('X-HTTP-02','Sharing a target never grants private source-history read access through alternate routes',['A'],async()=>{
    await request('PATCH',`/creation-api/sessions/${target.id}`,{actor:owner,body:{visibility:'shared'}});
    await request('GET',`/creation-api/sessions/${target.id}`,{actor:other});
    for(const section of ['summary','messages','mapping','observations'])await request('GET',`/creation-api/sessions/${target.id}/continued-context?section=${section}`,{actor:other,expected:403});
  });
  completed=true;
} catch(error) {evidence.report.errors.push({message:error.message,stack:error.stack});process.exitCode=1;console.error(error.stack);}
finally {
  for(const peer of peers)peer.ws.terminate();
  try{await service.stop();service.removeData();}catch(error){evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;}
  evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);
}
