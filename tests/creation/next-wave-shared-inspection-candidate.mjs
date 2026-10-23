/** DEVELOPMENT-AUTHORED CANDIDATE — not executed by its author.
 * Independent reviewer must review, run and judge this file on owned 48921.
 * Usage: node tests/creation/next-wave-shared-inspection-candidate.mjs <NC data>
 * Optional separate gate: --with-scene-change (default covers SI01-SI06 only).
 *
 * Reuses NC's real published native_shared build and its retained synthetic
 * account. Both browsers join through the original workbench UI. Inputs are
 * real browser key/pointer events. WebSocket/message listeners are read-only:
 * this driver never calls receive(), sends a ready ACK, edits authority state,
 * overwrites source, or bypasses a disabled Agent-send control.
 *
 * SI05 is deliberately a separate API-layer capture check using only actual A
 * packets/pixels and the rectangle drawn in SI03, replayed through the existing
 * pure PlayContextBuffer. It is NOT original-UI send or real-Agent evidence.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {Evidence,IsolatedService,ORIGIN,request,registerActor,waitFor,delay,sha256,redact} from './next-wave-test-support.mjs';
import {PlayContextBuffer,projectedFocusCandidates} from '../../apps/creation-workspace/play-context-buffer.js';

const supplied=process.argv.find(value=>value.startsWith('--data='))?.slice(7)??process.argv[2];
const withSceneChange=process.argv.includes('--with-scene-change');
assert.ok(supplied&&!supplied.startsWith('--'),'Provide NC retained test data explicitly. No service is started without it.');
const data=resolve(supplied),fixtureFile=join(data,'independent-native-state.json'),fixture=JSON.parse(readFileSync(fixtureFile,'utf8'));
assert.ok(fixture.actor?.user?.id&&fixture.actor?.credentials?.name?.startsWith('next-wave-')&&fixture.actor?.credentials?.password&&fixture.actor.token,'Expected NC synthetic actor fixture.');
assert.ok(fixture.project?.id&&fixture.revision&&fixture.publication?.verification?.game_build_id,'Expected a real completed NC publication.');
assert.equal(fixture.publication.verification.status,'passed');
const actorA=fixture.actor,project=fixture.project,branchId=fixture.branch_id??'main',entry=fixture.resource_id??'journey-a';
const route=`/creation-api/projects/${project.id}/branches/${encodeURIComponent(branchId)}`;
const evidence=new Evidence('shared-inspection-candidate',{layers:['A','G','B'],scope:'Developer-authored candidate for independent review: two original-UI Web joins to a genuine native_shared authority; A-only inspection/focus, B actual input/authority progress, current-scene resumption, and separately labelled API persistence of actual A observations.'});
evidence.report.authorship='development role; no execution or independent verdict supplied by the author';
evidence.report.optional_scene_change=withSceneChange?'requested_separate_gate':'not_executed_by_default';
evidence.report.prerequisite={state_file:fixtureFile,source_revision:fixture.revision,project_id:project.id,branch_id:branchId,entry_scene_id:entry,NC_game_build_id:fixture.publication.verification.game_build_id};
const service=new IsolatedService(evidence,{worlds:true,agent:false,data});
let browser,actorB,sessionA,sessionB,fixedBuild,A,B,focusEvidence,observationId,observationHash,initialHead,completed=false;
const clients=[];
const rootKey=JSON.stringify([[],'world-root']),actorKey=user=>JSON.stringify([['player-'+user.id],'actor-root']);
const rootState=snapshot=>snapshot?.nodes?.[rootKey]?.state;
const actorState=(snapshot,user)=>snapshot?.nodes?.[actorKey(user)]?.state;
const check=async(id,description,layers,fn)=>{console.log('NEXT_WAVE_CASE_START '+id+' '+description);await evidence.check(id,description,layers,fn);console.log('NEXT_WAVE_CASE_PASS '+id);};

function collectSocket(client,socket){
  if(new URL(socket.url()).pathname!=='/ws/creation')return;
  const add=(direction,event)=>{
    let value;try{value=JSON.parse(typeof event.payload==='string'?event.payload:Buffer.from(event.payload).toString());}catch{return;}
    if(direction==='sent'&&!['world_join','world_ready','world_input','world_leave','world_inspection'].includes(value.type))return;
    if(direction==='received'&&value.type!=='world')return;
    const record={direction,at:Date.now(),value};client.wire.push(record);if(client.wire.length>600)client.wire.splice(0,100);
    const snapshot=direction==='received'?value.packet?.snapshot:null;
    if(snapshot?.world_id&&Number.isFinite(snapshot.sequence)&&(!client.authority||snapshot.epoch>client.authority.epoch||snapshot.epoch===client.authority.epoch&&snapshot.sequence>=client.authority.sequence))client.authority=structuredClone(snapshot);
  };
  socket.on('framesent',event=>add('sent',event));socket.on('framereceived',event=>add('received',event));
}

async function newClient(label,actor,session){
  const context=await browser.newContext({viewport:{width:1600,height:1050}}),page=await context.newPage();page.setDefaultTimeout(20000);
  const client={label,actor,session,context,page,wire:[],console:[],errors:[],http:[],authority:null};clients.push(client);
  await page.addInitScript(()=>{
    window.__nwSharedEvents=[];window.__nwSharedCaptures=[];
    addEventListener('message',event=>{
      const value=event.data;if(!value||value.source!=='world-atelier-game'||event.source===window)return;
      const iframe=[...document.querySelectorAll('#mainPreview iframe')].find(frame=>!frame.hidden);
      const from_active_frame=!!iframe&&event.source===iframe.contentWindow,at=performance.now();
      const packet=structuredClone(value);
      if(packet.type==='captured_frame'&&typeof packet.data_url==='string'){
        window.__nwSharedCaptures.push({at,origin:event.origin,from_active_frame,data:structuredClone(packet)});
        if(window.__nwSharedCaptures.length>8)window.__nwSharedCaptures.shift();
        packet.image_length=packet.data_url.length;delete packet.data_url;
      }
      window.__nwSharedEvents.push({at,origin:event.origin,from_active_frame,data:packet});
      if(window.__nwSharedEvents.length>900)window.__nwSharedEvents.splice(0,150);
    });
  });
  page.on('websocket',socket=>collectSocket(client,socket));
  page.on('console',message=>client.console.push({at:Date.now(),type:message.type(),text:message.text()}));
  page.on('pageerror',error=>client.errors.push(error.message));
  page.on('request',req=>{const path=new URL(req.url()).pathname;if(path.startsWith('/creation-api/')&&!['GET','HEAD'].includes(req.method()))client.http.push({at:Date.now(),method:req.method(),path});});
  await page.goto(ORIGIN+'/creation-workspace.html#/games');
  await page.locator('#authName').fill(actor.credentials.name);await page.locator('#authPassword').fill(actor.credentials.password);await page.locator('#authSubmit').click();await page.locator('#landing').waitFor({state:'visible'});
  await page.locator(`[data-quick-game="${project.id}"][data-quick-branch="${branchId}"]`).click();await page.locator('#workbench').waitFor({state:'visible'});
  // Selecting the actual private creator session gives A a legitimate context
  // destination; it does not start a model or fabricate executor readiness.
  if(await page.locator('#chatDrawer').evaluate(element=>element.hidden))await page.locator('#agentsMenuButton').click();
  if(await page.locator('#sessionId').inputValue()!==session.id){await page.locator('#toggleSessions').click();await page.locator(`button[data-session="${session.id}"]`).click();}
  await page.waitForFunction(sid=>document.querySelector('#sessionId')?.value===sid,session.id);
  await page.locator('#closeChat').click();return client;
}

const ui=client=>client.page.evaluate(()=>({mode:document.querySelector('#stage')?.dataset.previewMode,build_id:document.querySelector('#mainPreview')?.dataset.gameBuild,
  scene_generation:Number(document.querySelector('#mainPreview')?.dataset.sceneGeneration),status:document.querySelector('#workspaceStatus')?.textContent,
  controls:{...document.querySelector('#playControls')?.dataset},runtime_kind:document.querySelector('#mainPreview')?.dataset.runtimeKind}));
async function packet(client,type,{kind=null,mode=null,resource=null,generation=null,after=-1}={}){
  return client.page.evaluate(options=>[...(window.__nwSharedEvents??[])].reverse().find(row=>row.from_active_frame&&row.at>options.after&&row.data.type===options.type&&(!options.kind||row.data.kind===options.kind)&&(!options.mode||(row.data.payload?.mode??row.data.mode)===options.mode)&&(!options.resource||row.data.resource_id===options.resource)&&(options.generation===null||row.data.scene_generation===options.generation))??null,{type,kind,mode,resource,generation,after});
}
const snapshot=(client,options={})=>packet(client,'play_context',{kind:'snapshot',...options});
const renderedCounter=record=>record?.data?.payload?.objects?.find(row=>row.name==='Counter')?.control?.text??'';
async function gameFrame(client){return waitFor(client.label+' actual isolated Godot frame',()=>client.page.frames().find(frame=>frame.url().includes('/creation-runtime/')&&frame.url().includes('/web/index.html')),{timeout:150000,interval:250});}
async function mode(client,expected,{resource=null,generation=null}={}){
  return waitFor(client.label+' original shared UI '+expected,async()=>{
    const view=await ui(client);if(view.mode==='edit'&&/失败|超时/.test(view.status??''))throw Error(client.label+' '+view.status);
    const state=await packet(client,'world_state',{mode:expected==='play'?'playing':'inspecting',resource,generation});
    return view.mode===expected&&view.runtime_kind==='native_shared'&&state?.data.session_kind==='shared_world'&&(expected!=='play'||state.data.control_ready===true)&&{view,state};
  },{timeout:150000,interval:200});
}
async function joinShared(client){
  await client.page.bringToFront();if(!await client.page.locator('#viewportMore').evaluate(element=>element.open))await client.page.locator('#viewportMore summary').click();
  await client.page.locator('#sharedWorldButton').click();await client.page.locator('#joinSharedWorld').waitFor({state:'visible'});await client.page.locator('#joinSharedWorld').click();
  const active=await mode(client,'play');await gameFrame(client);
  await waitFor(client.label+' genuine ready then server active',()=>{
    const ready=client.wire.find(row=>row.direction==='sent'&&row.value.type==='world_ready'&&row.value.world_id===active.state.data.world_id);
    const confirmed=client.wire.find(row=>row.direction==='received'&&row.value.packet?.action==='active'&&row.value.packet.world_id===active.state.data.world_id&&row.value.packet.control_generation===ready?.value.control_generation);
    return ready&&confirmed&&confirmed.at>=ready.at&&{ready,confirmed};
  },{timeout:20000});
  const current=await waitFor(client.label+' actual play context',()=>snapshot(client,{mode:'play',resource:active.state.data.resource_id,generation:active.state.data.scene_generation}),{timeout:20000});
  assert.equal(active.view.build_id,fixedBuild.id);assert.equal(current.data.source_revision,fixedBuild.source_revision);assert.equal(current.data.canonical_identity,fixedBuild.canonical_identity);assert.equal(current.data.runtime_instance_id,current.data.nonce);
  assert.notEqual(current.origin,ORIGIN);return {active,current};
}
async function clickAuthored(client,name){
  await client.page.bringToFront();const current=await waitFor(client.label+' visible authored '+name,async()=>{const item=await snapshot(client,{mode:'play'}),node=item?.data.payload.objects.find(row=>row.name===name&&row.visible!==false&&Array.isArray(row.screen_bounds));return node&&{item,node};},{timeout:20000});
  const frame=await gameFrame(client),canvas=frame.locator('canvas'),box=await canvas.boundingBox();assert.ok(box&&box.width>0&&box.height>0);
  const logical=current.item.data.payload.camera?.viewport_size??[1000,700],bounds=current.node.screen_bounds,scale=Math.min(box.width/logical[0],box.height/logical[1]);
  const point={x:(box.width-logical[0]*scale)/2+(bounds[0]+bounds[2]/2)*logical[0]*scale,y:(box.height-logical[1]*scale)/2+(bounds[1]+bounds[3]/2)*logical[1]*scale};
  assert.ok(point.x>=0&&point.x<=box.width&&point.y>=0&&point.y<=box.height,'Authored button must lie in the actual canvas.');
  await canvas.click({position:point});return {node:current.node.name,bounds,logical,canvas:{width:box.width,height:box.height},point,source_revision:current.item.data.source_revision,scene_generation:current.item.data.scene_generation};
}
async function moveRight(client,{milliseconds=450,release=true}={}){
  await client.page.bringToFront();const frame=await gameFrame(client);await frame.locator('canvas').focus();await client.page.keyboard.down('d');await delay(milliseconds);if(release)await client.page.keyboard.up('d');
}
async function canvasPNG(client,name){const frame=await gameFrame(client),bytes=await frame.locator('canvas').screenshot({path:join(evidence.directory,name)});return sha256(bytes);}
function sameWorld(actual,expected){assert.equal(actual.world_id,expected.world_id);assert.equal(actual.epoch,expected.epoch);assert.equal(actual.scene_revision,expected.scene_revision);}
async function sourceUnchanged(){const current=(await request('GET',route,{actor:actorA})).value;assert.equal(current.head,initialHead);return current;}

// Compare real decoded pixels. Exact bytes are preferred; if the workbench
// compacted a keyframe to JPEG/1280, compare a uniformly resampled image instead.
async function matchingCapture(client,overlayDataUrl){
  const captures=await client.page.evaluate(()=>window.__nwSharedCaptures.filter(row=>row.from_active_frame));assert.ok(captures.length,'No actual captured_frame arrived.');
  const exact=captures.findLast(row=>row.data.data_url===overlayDataUrl);if(exact)return {record:exact,comparison:{exact_bytes:true}};
  const match=await client.page.evaluate(async({overlay,candidates})=>{
    async function pixels(url){const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=160;canvas.height=112;canvas.getContext('2d').drawImage(image,0,0,160,112);return canvas.getContext('2d').getImageData(0,0,160,112).data;}
    const target=await pixels(overlay);let best=null;
    for(let index=0;index<candidates.length;index++){const source=await pixels(candidates[index]);let error=0;for(let n=0;n<source.length;n+=4)error+=Math.abs(source[n]-target[n])+Math.abs(source[n+1]-target[n+1])+Math.abs(source[n+2]-target[n+2]);const mean=error/(160*112*3);if(!best||mean<best.mean)best={index,mean};}
    return best;
  },{overlay:overlayDataUrl,candidates:captures.map(row=>row.data.data_url)});
  assert.ok(match&&match.mean<5,'Focus overlay must represent an actual A rendered capture, not a substitute image.');return {record:captures[match.index],comparison:{exact_bytes:false,mean_rgb_error:match.mean}};
}

try{
  await service.start();
  await check('SI01','Reuse NC fixed native_shared publication; create only real member/session prerequisites',['A'],async receipt=>{
    const branch=(await request('GET',route,{actor:actorA})).value;initialHead=branch.head;assert.equal(initialHead,fixture.revision);assert.equal(branch.manifest.schema,'creation-native-1');
    const playable=(await request('GET',route+'/shared-playable?resource_id='+encodeURIComponent(entry),{actor:actorA})).value;
    assert.equal(playable.native_shared,true);assert.equal(playable.game_build_id,fixture.publication.verification.game_build_id);
    fixedBuild=(await request('GET','/creation-api/builds/'+playable.game_build_id,{actor:actorA})).value.job;assert.equal(fixedBuild.purpose,'native_shared');assert.equal(fixedBuild.status,'completed');assert.equal(fixedBuild.source_revision,initialHead);
    actorB=await registerActor('shared-inspection-b');
    const collaboration=(await request('GET',`/creation-api/projects/${project.id}/collaboration`,{actor:actorA})).value;
    await request('PATCH',`/creation-api/projects/${project.id}/members/${actorB.user.id}`,{actor:actorA,body:{request_id:randomUUID(),expected_version:collaboration.project.permission_version,role:'editor'}});
    sessionA=(await request('POST',route+'/sessions',{actor:actorA,body:{title:'A shared observation candidate',visibility:'private'},expected:201})).value;
    sessionB=(await request('POST',route+'/sessions',{actor:actorB,body:{title:'B shared input candidate',visibility:'private'},expected:201})).value;
    writeFileSync(join(service.data,'independent-shared-inspection-state.json'),JSON.stringify({actorA,actorB,project,branch_id:branchId,resource_id:entry,sessionA,sessionB,source_revision:initialHead,game_build_id:fixedBuild.id})+'\n',{mode:0o600});
    evidence.json('fixed-shared-build.json',fixedBuild);receipt.source_revision=initialHead;receipt.game_build_id=fixedBuild.id;receipt.runtime_source_hash=fixedBuild.runtime_source_hash;receipt.accounts=[actorA.user.id,actorB.user.id];receipt.boundary='Member/session setup is API evidence; neither source nor runtime state is patched.';
  });
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio','--enable-unsafe-swiftshader']});evidence.report.versions.chrome=browser.version();
  A=await newClient('A',actorA,sessionA);B=await newClient('B',actorB,sessionB);
  await check('SI02','Two separate accounts join the same real world through sharedWorldButton and genuine Godot readiness',['A','G','B'],async receipt=>{
    const joinedA=await joinShared(A),joinedB=await joinShared(B);sameWorld(joinedA.active.state.data,joinedB.active.state.data);
    assert.notEqual(joinedA.current.data.nonce,joinedB.current.data.nonce,'Runtime windows require distinct identities.');
    assert.equal(joinedA.active.state.data.control_ready,true);assert.equal(joinedB.active.state.data.control_ready,true);
    await waitFor('both actual player states in authority',()=>actorState(B.authority,actorA.user)&&actorState(B.authority,actorB.user),{timeout:20000});
    const baseline=rootState(B.authority);assert.ok(Number.isInteger(baseline.attempts));
    const input=await clickAuthored(A,'Door');await waitFor('actual A authored interaction',()=>rootState(B.authority)?.attempts===baseline.attempts+1&&rootState(B.authority)?.last_actor===actorA.user.id,{timeout:15000});
    const oldDistance=actorState(B.authority,actorB.user).distance;await moveRight(B);await waitFor('actual B movement',()=>actorState(B.authority,actorB.user)?.distance>oldDistance,{timeout:10000});
    receipt.world_id=B.authority.world_id;receipt.epoch=B.authority.epoch;receipt.initial_attempts=baseline.attempts;receipt.after_A_attempts=rootState(B.authority).attempts;receipt.B_distance=actorState(B.authority,actorB.user).distance;receipt.A_nonce=joinedA.current.data.nonce;receipt.B_nonce=joinedB.current.data.nonce;receipt.actual_button=input;
    await A.page.screenshot({path:join(evidence.directory,'A-shared-playing.png')});await B.page.screenshot({path:join(evidence.directory,'B-shared-playing.png')});
  });
  await check('SI03','A points at the real frame while moving; actual zero-input ACK precedes frozen personal inspection',['A','G','B'],async receipt=>{
    await moveRight(A,{milliseconds:300,release:false});const started=await A.page.evaluate(()=>performance.now());
    await A.page.locator('[data-play-context-focus]').click();await mode(A,'inspect');const layer=A.page.locator('.play-context-focus-layer');await layer.waitFor({state:'visible'});await A.page.keyboard.up('d');
    const overlay=await layer.locator('img').getAttribute('src'),uiFrameId=await layer.getAttribute('data-play-context-frame');assert.ok(overlay?.startsWith('data:image/'));
    const matched=await matchingCapture(A,overlay),capture=matched.record.data,current=await waitFor('A actual frozen snapshot',()=>snapshot(A,{mode:'inspect'}),{timeout:10000});
    assert.equal(capture.nonce,current.data.nonce);assert.equal(capture.source_revision,initialHead);assert.equal(capture.scene_generation,current.data.scene_generation);assert.equal(capture.document_id,`${project.id}/${branchId}/${current.data.resource_id}`);
    const box=await layer.boundingBox();assert.ok(box);const rectangle=[.40,.24,.23,.39];
    await A.page.mouse.move(box.x+box.width*rectangle[0],box.y+box.height*rectangle[1]);await A.page.mouse.down();await A.page.mouse.move(box.x+box.width*(rectangle[0]+rectangle[2]),box.y+box.height*(rectangle[1]+rectangle[3]),{steps:8});await A.page.mouse.up();await layer.waitFor({state:'detached'});
    const state=(await packet(A,'world_state',{mode:'inspecting'})).data;
    assert.equal(state.input_stopped,true);assert.ok(state.input_zero_seq>0);assert.ok(state.stop_ack_sequence>=state.frozen_sequence);
    const zero=A.wire.findLast(row=>row.direction==='sent'&&row.value.type==='world_input'&&row.value.input?.input_seq===state.input_zero_seq&&row.value.input.inputs?.length===0);
    const stopped=A.wire.findLast(row=>row.direction==='received'&&row.value.packet?.action==='input_ack'&&row.value.packet.input_seq===state.input_zero_seq&&row.value.packet.ok===true);
    assert.ok(zero&&stopped,'Only actual sent zero input and authority acknowledgment prove the stop.');
    const observed=await waitFor('A real HUD hidden',async()=>{const item=await snapshot(A,{mode:'inspect'});return item?.data.payload.objects.some(row=>row.name==='Counter'&&row.visible===false)&&item;},{timeout:10000});
    assert.equal((await ui(A)).controls.inspectionUiVisible,'false');assert.equal(await A.page.locator('#inspectionUiToggle').getAttribute('aria-pressed'),'false');
    assert.equal((await mode(B,'play')).state.data.control_ready,true);
    focusEvidence={started,rectangle,overlay,uiFrameId,capture:matched.record,comparison:matched.comparison,frozenState:state,frozenSnapshot:observed,canvasHash:await canvasPNG(A,'A-frozen-before-B-input.png'),sourceScope:observed.data};
    const image=Buffer.from(overlay.slice(overlay.indexOf(',')+1),'base64');writeFileSync(join(evidence.directory,'A-focus-visible-game-ui.'+(overlay.startsWith('data:image/jpeg')?'jpg':'png')),image);
    receipt.actual_zero_input_seq=state.input_zero_seq;receipt.actual_stop_ack_sequence=state.stop_ack_sequence;receipt.frozen_tick=state.frozen_tick;receipt.scene_generation=state.scene_generation;receipt.UI_hidden=true;receipt.focus_rectangle=rectangle;receipt.focus_source_frame=uiFrameId;receipt.capture_request_id=capture.request_id;receipt.capture_tick=capture.tick;receipt.image_sha256=sha256(image);receipt.image_comparison=matched.comparison;receipt.boundary='The fixed overlay preserves the frame before default UI hiding; the underlying paused game UI is checked separately.';
  });
  await check('SI04','B keeps interacting and moving while authority advances; A rendered tick, objects and pixels stay frozen',['A','G','B'],async receipt=>{
    const frozen=focusEvidence.frozenSnapshot,baseline=structuredClone(B.authority),before=rootState(baseline).attempts,oldDistance=actorState(baseline,actorB.user).distance;
    await clickAuthored(B,'Door');await waitFor('B first actual interaction while A frozen',()=>rootState(B.authority)?.attempts===before+1,{timeout:10000});
    await clickAuthored(B,'Door');await waitFor('B second actual interaction while A frozen',()=>rootState(B.authority)?.attempts===before+2&&rootState(B.authority)?.last_actor===actorB.user.id,{timeout:10000});
    await moveRight(B,{milliseconds:700});await waitFor('B real motion and authority tick advance',()=>B.authority?.tick>baseline.tick&&actorState(B.authority,actorB.user)?.distance>oldDistance,{timeout:10000});
    await delay(1200);await A.page.bringToFront();const after=await waitFor('fresh A personal observation',()=>snapshot(A,{mode:'inspect',after:frozen.at}),{timeout:10000});
    assert.equal(after.data.tick,frozen.data.tick);assert.equal(renderedCounter(after),renderedCounter(frozen));assert.equal(after.data.resource_id,frozen.data.resource_id);assert.equal(after.data.scene_generation,frozen.data.scene_generation);assert.equal(after.data.nonce,frozen.data.nonce);
    const canvasHash=await canvasPNG(A,'A-frozen-after-B-input.png');assert.equal(canvasHash,focusEvidence.canvasHash,'The deterministic fixture canvas must remain frozen, not merely its DOM label.');
    sameWorld(B.authority,baseline);assert.ok(B.authority.sequence>baseline.sequence);assert.equal(actorState(B.authority,actorA.user).motion,0,'A held movement must not continue during personal inspection.');
    assert.equal((await ui(A)).mode,'inspect');assert.equal((await ui(B)).mode,'play');await sourceUnchanged();
    receipt.before_authority_tick=baseline.tick;receipt.after_authority_tick=B.authority.tick;receipt.B_attempts=rootState(B.authority).attempts;receipt.B_distance=actorState(B.authority,actorB.user).distance;receipt.A_frozen_tick=after.data.tick;receipt.A_canvas_sha256=canvasHash;receipt.world_id=B.authority.world_id;receipt.epoch=B.authority.epoch;
    await B.page.screenshot({path:join(evidence.directory,'B-continues-while-A-inspects.png')});
  });
  await check('SI05','API layer stores only actual A packets, selected A frame and real focus coordinates as an immutable observation',['A','G'],async receipt=>{
    const gathered=await A.page.evaluate(()=>({time_origin:performance.timeOrigin,now:performance.now(),events:window.__nwSharedEvents.filter(row=>row.from_active_frame),captures:window.__nwSharedCaptures.filter(row=>row.from_active_frame)}));
    const state=focusEvidence.frozenState,source=focusEvidence.sourceScope,scope={project_id:project.id,branch_id:branchId,source_revision:initialHead,build_id:fixedBuild.id,canonical_identity:fixedBuild.canonical_identity,runtime_instance_id:source.nonce,resource_id:source.resource_id,scene_generation:source.scene_generation,world_id:state.world_id,epoch:state.epoch,session_kind:'shared_world'};
    const other=await snapshot(B,{mode:'play'});assert.notEqual(other.data.nonce,scope.runtime_instance_id);
    let now=0;const buffer=new PlayContextBuffer({now:()=>now,wallNow:()=>gathered.time_origin+now});buffer.bind(scope);let chosenFrame=null,observedMode='play';
    for(const record of gathered.events){
      if(record.data.nonce!==scope.runtime_instance_id)continue;now=record.at;
      if(record.data.type==='world_state')observedMode=record.data.mode==='inspecting'?'inspect':'play';
      if(record.data.type==='play_context'){
        assert.equal(record.data.runtime_instance_id,scope.runtime_instance_id);assert.equal(record.data.source_revision,scope.source_revision);assert.equal(record.data.scene_generation,scope.scene_generation);buffer.accept(record.data,{at:record.at});
      }
      if(record.data.type==='captured_frame'&&record.data.request_id===focusEvidence.capture.data.request_id){
        const real=focusEvidence.capture.data;chosenFrame=buffer.addFrame({...real,data_url:focusEvidence.overlay,mode:observedMode},{at:record.at,scope});
      }
    }
    assert.ok(chosenFrame,'Actual selected frame must remain within the production buffer budgets.');now=gathered.now;
    const candidates=projectedFocusCandidates(chosenFrame,{rect:focusEvidence.rectangle});
    buffer.setFocus({kind:'screen_region',rect:focusEvidence.rectangle,runtime_ids:candidates.map(row=>row.runtime_id),frame_id:chosenFrame.id,at_ms:chosenFrame.at_ms,resource_id:scope.resource_id,scene_generation:scope.scene_generation});
    const capture=buffer.freeze({requestId:'shared-inspection-'+randomUUID()}),saved=(await request('POST',`/creation-api/sessions/${sessionA.id}/play-context/captures`,{actor:actorA,body:capture,expected:201})).value;
    observationId=saved.observation_id;const read=(await request('GET',`/creation-api/sessions/${sessionA.id}/play-context/observations/${observationId}`,{actor:actorA})).value;observationHash=read.sha256;
    assert.equal(read.scope.session_kind,'shared_world');assert.equal(read.scope.runtime_instance_id,scope.runtime_instance_id);assert.notEqual(read.scope.runtime_instance_id,other.data.nonce);assert.equal(read.scope.scene_generation,scope.scene_generation);assert.equal(read.scope.resource_id,scope.resource_id);assert.deepEqual(read.focus.rect,focusEvidence.rectangle);
    assert.equal(read.provenance.authority,'not_authoritative');assert.equal((await request('GET',`/creation-api/sessions/${sessionA.id}/play-context/observations/${observationId}`,{actor:actorB,expected:403})).status,403);
    const session=(await request('GET',`/creation-api/sessions/${sessionA.id}`,{actor:actorA})).value;assert.equal(session.runs.length,0);assert.equal(session.messages.length,0);
    evidence.json('A-actual-observation-summary.json',read);evidence.json('A-actual-observation-events.json',(await request('GET',`/creation-api/sessions/${sessionA.id}/play-context/observations/${observationId}?section=events&limit=100`,{actor:actorA})).value);
    receipt.observation_id=observationId;receipt.sha256=observationHash;receipt.A_runtime_instance=scope.runtime_instance_id;receipt.B_runtime_instance=other.data.nonce;receipt.source_revision=scope.source_revision;receipt.scene_generation=scope.scene_generation;receipt.real_engine_packet_count=gathered.events.filter(row=>row.data.type==='play_context'&&row.data.nonce===scope.runtime_instance_id).length;receipt.boundary='API/storage coverage over actual recorded A evidence, not a natural UI send and not a real Agent execution; J05 owns that separate gate.';
  });
  await check('SI06','A returns to the current shared baseline with no stale movement; B remains active',['A','G','B'],async receipt=>{
    const latest=structuredClone(B.authority),expected=rootState(latest).attempts;
    await A.page.bringToFront();await A.page.locator('[data-mode="play"]').click();const active=await mode(A,'play',{resource:latest.resource_id,generation:latest.scene_generation});
    const observed=await waitFor('A receives B changes on resume',async()=>{const value=await snapshot(A,{mode:'play',resource:latest.resource_id,generation:latest.scene_generation});return value?.data.tick>=latest.tick&&renderedCounter(value).includes('clicks='+expected)&&value;},{timeout:15000});
    sameWorld(active.state.data,latest);assert.equal(active.state.data.inspection_ui_visible,true);assert.ok(observed.data.tick>focusEvidence.frozenSnapshot.data.tick);
    const before=actorState(B.authority,actorA.user).distance;await delay(900);assert.ok(Math.abs(actorState(B.authority,actorA.user).distance-before)<.01,'Old held A input must not replay on resume.');
    assert.equal((await mode(B,'play')).state.data.control_ready,true);
    assert.equal((await request('GET',`/creation-api/sessions/${sessionA.id}/play-context/observations/${observationId}`,{actor:actorA})).value.sha256,observationHash);await sourceUnchanged();
    receipt.resumed_tick=observed.data.tick;receipt.minimum_current_tick=latest.tick;receipt.actual_counter=renderedCounter(observed);receipt.A_distance_without_new_input=actorState(B.authority,actorA.user).distance;receipt.old_observation_sha256=observationHash;
    await A.page.screenshot({path:join(evidence.directory,'A-resumed-current-world.png')});
  });
  if(withSceneChange)await check('SI07','A new authored scene generation updates both real clients while the prior observation stays pinned',['A','G','B'],async receipt=>{
    const prior=structuredClone(B.authority),next=prior.resource_id==='journey-a'?'journey-b':'journey-a';
    await clickAuthored(B,'Next');await waitFor('actual authority changes scene',()=>B.authority?.resource_id===next&&B.authority.scene_generation>prior.scene_generation,{timeout:20000});
    const current=structuredClone(B.authority);sameWorld(current,prior);
    const activeA=await mode(A,'play',{resource:next,generation:current.scene_generation}),activeB=await mode(B,'play',{resource:next,generation:current.scene_generation});
    const observedA=await waitFor('A actual current-scene observation',()=>snapshot(A,{mode:'play',resource:next,generation:current.scene_generation}),{timeout:20000}),observedB=await waitFor('B actual current-scene observation',()=>snapshot(B,{mode:'play',resource:next,generation:current.scene_generation}),{timeout:20000});
    assert.notEqual(observedA.data.nonce,observedB.data.nonce);assert.equal(observedA.data.source_revision,initialHead);assert.equal(activeA.view.build_id,fixedBuild.id);assert.equal(activeB.view.build_id,fixedBuild.id);
    const old=(await request('GET',`/creation-api/sessions/${sessionA.id}/play-context/observations/${observationId}`,{actor:actorA})).value;
    assert.equal(old.sha256,observationHash);assert.equal(old.scope.resource_id,focusEvidence.sourceScope.resource_id);assert.equal(old.scope.scene_generation,focusEvidence.sourceScope.scene_generation);assert.notEqual(old.scope.scene_generation,current.scene_generation);await sourceUnchanged();
    receipt.world_id=current.world_id;receipt.epoch=current.epoch;receipt.previous_scene=prior.resource_id;receipt.current_scene=next;receipt.previous_generation=prior.scene_generation;receipt.current_generation=current.scene_generation;receipt.A_current_runtime=observedA.data.runtime_instance_id;receipt.B_current_runtime=observedB.data.runtime_instance_id;receipt.old_observation_scope=old.scope;
    await A.page.screenshot({path:join(evidence.directory,'A-new-scene-generation.png')});await B.page.screenshot({path:join(evidence.directory,'B-new-scene-generation.png')});
  });
  completed=true;
}catch(error){
  evidence.report.errors.push({message:error.message,stack:error.stack});console.error(redact(error.stack??error.message));process.exitCode=1;
  for(const client of clients)if(!client.page.isClosed()){
    evidence.json(client.label+'-failure-ui.json',await ui(client).catch(()=>({})));await client.page.screenshot({path:join(evidence.directory,client.label+'-failure.png')}).catch(()=>{});
  }
}finally{
  for(const client of clients){
    if(!client.page.isClosed()){
      // Release only keys this driver pressed, then leave by the ordinary UI.
      await client.page.keyboard.up('d').catch(()=>{});
      if(await client.page.locator('[data-mode="edit"]').isVisible().catch(()=>false))await client.page.locator('[data-mode="edit"]').click({timeout:5000}).catch(()=>{});
      evidence.json(client.label+'-actual-game-messages.json',await client.page.evaluate(()=>window.__nwSharedEvents??[]).catch(()=>[]));
    }
    evidence.json(client.label+'-actual-websocket-frames.json',client.wire);evidence.json(client.label+'-browser-console.json',client.console);evidence.json(client.label+'-browser-errors.json',client.errors);evidence.json(client.label+'-actual-http-writes.json',client.http);
    if(client.errors.length){evidence.report.errors.push({phase:'browser',client:client.label,messages:client.errors});process.exitCode=1;}
    await client.context.close().catch(()=>{});
  }
  await browser?.close();
  try{await service.stop();}catch(error){evidence.report.errors.push({phase:'cleanup',message:error.message});process.exitCode=1;}
  evidence.report.retained_test_data=service.data;evidence.report.credentials='Synthetic credentials remain only in the private NC/test state files; never in the public report.';
  evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);
}
