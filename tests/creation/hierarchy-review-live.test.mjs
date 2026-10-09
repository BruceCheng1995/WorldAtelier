/** Actual hierarchy + Codex goals + authority + immutable review evidence.
 * Uses an authorized existing server; creates only its own project/account/session.
 * No fake executor, domain rows, world ACK, screenshot or browser input.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocket} from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'http://127.0.0.1:48921', api = `${origin}/creation-api`;
const codeRoot = process.env.WORLD_ATELIER_CREATION_CODE_ROOT, expectedBuild = process.env.WORLD_ATELIER_EXPECT_RUNTIME_BUILD;
const sceneId = 'scene-harbor', doorId = 'cross-prefab-door', houseId = 'cross-prefab-house';
const uid = name => `${name}-${randomUUID()}`, pause = ms => new Promise(yes => setTimeout(yes, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = x => Array.isArray(x) ? `[${x.map(stable).join(',')}]` : x && typeof x === 'object' ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}` : JSON.stringify(x);
const key = a => JSON.stringify([a.project_id, a.branch_id, a.resource_id, a.instance_path, a.definition_node_id]);
const clean = x => Array.isArray(x) ? x.map(clean) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k,v]) => [k, /^(token|password|authorization|cap|email|account)$/i.test(k) || k === 'code' && typeof v === 'string' ? '[redacted]' : clean(v)])) : typeof x === 'string' ? x.replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]') : x;
const trs = (p = [0,0,0]) => ({position:p, rotation:[0,0,0,1], scale:[1,1,1]});
const node = (id, parent, extra = {}) => ({id, name:id, kind:'anchor', parent_id:parent, transform:trs(), color:'#74d5cd', solid:false, components:{}, ...extra});
const document = id => ({schema:2,id,kind:'prefab',name:id,root_id:'root',nodes:{root:node('root',null,{kind:'group'})},instances:{}});

test('actual nested-address goals, source isolation, review staleness and revoked requests', {timeout: 900000}, async t => {
  assert.equal(process.env.WORLD_ATELIER_RUN_REAL_CROSS_REVIEW, '1'); assert.ok(codeRoot); assert.match(expectedBuild ?? '', /^[a-f0-9]{64}$/);
  const out = resolve(root, '.local/creation-verification/hierarchy-review', `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
  await mkdir(out,{recursive:true}); await chmod(out,0o700);
  const report = {started_at:new Date().toISOString(), origin, code_root:codeRoot, expected_runtime_build:expectedBuild, cases:[], events:[], completed:false,
    scope:'Two real Codex turns / distinct goals in one new session, actual Godot headless world, protocol input, trusted server runtime_trace and real permission checks. No UI/GPU or arbitrary Agent capability claim.'};
  const sources = ['services/creation/service.mjs','services/creation/store.mjs','services/creation/agent-runs.mjs','services/creation/hierarchy-agent.mjs','services/creation/hierarchy-store.mjs','services/creation/goal-review.mjs','services/creation/review-capture.mjs','services/creation/worlds.mjs','services/creation/realtime.mjs'];
  report.source_hashes = Object.fromEntries(await Promise.all(sources.map(async f => [f,sha(await readFile(resolve(codeRoot,f)))])));
  const save = () => writeFile(resolve(out,'report.json'), JSON.stringify(clean(report),null,2)+'\n');
  const trace = row => appendFileSync(resolve(out,'traffic.jsonl'),JSON.stringify(clean({at:Date.now(),...row}))+'\n');
  let owner, reviewer, projectId, session, runtime, model, peer, reviewerPeer, leftAddress, rightAddress, leftId, rightId, rightRun, leftRun, activeRun, rightReview, leftReview, acceptedDecision, acceptedPayload, approvedRevision, cursor=0;
  const req = async (method,path,user=owner,input,raw=false) => {
    const headers={origin,'content-type':raw?'application/octet-stream':'application/json'}; if(user)headers.authorization=`Bearer ${user.token}`;
    if(raw)headers['x-asset-name']=encodeURIComponent(input.name);
    const response=await fetch(api+path,{method,headers,body:input===undefined?undefined:raw?input.bytes:JSON.stringify(input)}),value=await response.json();
    trace({method,path,actor:user?.user?.id,input:raw?{name:input.name,sha256:sha(input.bytes),bytes:input.bytes.length}:input,status:response.status,value}); return{status:response.status,value};
  };
  const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(clean(r.value)));return r.value;};
  const branchPath=()=>`/projects/${projectId}/branches/main`, branch=()=>req('GET',branchPath()).then(ok), sessionView=()=>req('GET',`/sessions/${session.id}`).then(ok);
  const reviewView=(run,user=owner)=>req('GET',`/goals/${run.goal_id}/review`,user).then(ok);
  async function tx(ops,base){const b=base??await branch();return ok(await req('POST',`${branchPath()}/transactions`,owner,{transaction_id:uid('cross-edit'),base_revision:b.head,expected_head:b.head,ops}));}
  const rows=async()=>{const b=await branch();return ok(await req('GET',`${branchPath()}/resolved-scene?revision=${b.head}&resource_id=${sceneId}`));};
  const rowFor=(list,a)=>list.rows.find(r=>key(r.address)===key(a));
  const mount=(id,prefab,parent,p=[0,0,0])=>({instance_id:id,prefab_id:prefab.id,prefab_revision:prefab.version,parent_id:parent,transform:trs(p),overrides:[]});
  async function connect(user){
    const socket=new WebSocket(origin.replace('http','ws')+'/ws/creation',{origin}),messages=[];
    const p={socket,messages,user,inputSeq:0,send:m=>{trace({ws_send:m,actor:user.user.id});socket.send(JSON.stringify(m));}};
    socket.on('message',b=>{const m=JSON.parse(b.toString());messages.push(m);trace({ws_receive:m,actor:user.user.id});});socket.on('error',()=>{});
    p.wait=async(fn,mark=0,timeout=12000)=>{const end=Date.now()+timeout;while(Date.now()<end){const m=messages.slice(mark).find(fn);if(m)return m;await pause(20);}throw Error('Actual WS timeout: '+JSON.stringify(clean(messages.slice(-3))));};
    p.current=()=>messages.findLast(m=>m.type==='world'&&m.packet?.action==='snapshot')?.packet.snapshot;
    await new Promise((yes,no)=>{socket.once('open',yes);socket.once('error',no);});p.send({type:'auth',token:user.token});await p.wait(m=>m.type==='authenticated');
    p.send({type:'subscribe',project_id:projectId,branch_id:'main',resource_id:sceneId,generation:1});await p.wait(m=>m.type==='baseline');
    const ping=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)p.send({type:'ping'});},10000);ping.unref();socket.once('close',()=>clearInterval(ping));return p;
  }
  const snapshot=(fn,mark=peer.messages.length,timeout=12000)=>peer.wait(m=>m.type==='world'&&m.packet?.action==='snapshot'&&fn(m.packet.snapshot),mark,timeout).then(m=>m.packet.snapshot);
  const counter=(s,id)=>s.object_states[id]?.['cross-counter']?.interactions;
  function input(interact=false){const s=peer.current(),input_seq=++peer.inputSeq;peer.send({type:'world_input',input:{world_id:s.world_id,epoch:s.epoch,scene_revision:s.scene_revision,input_seq,move:[0,0],interact}});return input_seq;}
  async function events(){for(;;){const page=ok(await req('GET',`/sessions/${session.id}/events?after=${cursor}`)).events;for(const e of page){assert.ok(e.cursor>cursor);cursor=e.cursor;report.events.push(e);}if(page.length<500)break;}await writeFile(resolve(out,'executor-events.json'),JSON.stringify(clean(report.events),null,2)+'\n');}
  async function run(text,address){
    const b=await branch(), row=rowFor(await rows(),address);
    const attachment=ok(await req('POST',`/sessions/${session.id}/attachments`,owner,{revision:b.head,address,expected_version:row.object_version}),201);assert.deepEqual(attachment.address,address);
    const payload={text,model,client_user_message_id:uid('cross-message')},start=ok(await req('POST',`/sessions/${session.id}/turns`,owner,payload),202);activeRun=start.run;assert.ok(activeRun.turn_id&&activeRun.thread_id);
    report.starts??=[];report.starts.push(start);await save();
    const replay=ok(await req('POST',`/sessions/${session.id}/turns`,owner,payload),202);assert.equal(replay.run.id,activeRun.id);assert.equal(replay.replayed,true);
    const end=Date.now()+360000;let notice=0;
    while(Date.now()<end){await events();const view=await sessionView();activeRun=view.runs.find(r=>r.id===start.run.id);if(['completed','failed','interrupted','cancelled'].includes(activeRun.status))break;
      if(report.events.some(e=>e.kind==='approval_request'&&(!e.params?.turnId||e.params.turnId===activeRun.turn_id)))throw Error('Real approval/input is pending; no synthetic answer');
      if(Date.now()-notice>10000){console.log(`CROSS_REAL_RUN ${activeRun.id} ${activeRun.status} events=${report.events.length}`);notice=Date.now();}await pause(500);
    }
    assert.equal(activeRun.status,'completed','Do not resubmit a timed-out or failed objective'); assert.equal(activeRun.targets.length,1);assert.deepEqual(activeRun.targets[0].address,address);return activeRun;
  }
  const items=run=>report.events.filter(e=>e.method==='item/completed'&&e.params?.turnId===run.turn_id&&e.params.threadId===run.thread_id).map(e=>e.params.item);
  async function actualVerification(v){assert.equal(v.status,'passed');assert.equal(v.process.code,0);assert.equal(v.report.ok,true);assert.equal(v.report.completed,true);await mkdir(resolve(out,'validators'),{recursive:true});
    for(const [field,extension] of [['report','json'],['log','log']]){assert.ok(v.evidence?.[field]);const b=await readFile(v.evidence[field]);await writeFile(resolve(out,'validators',`${v.id}.${extension}`),field==='report'?JSON.stringify(clean(JSON.parse(b)),null,2):clean(b.toString()));}
    for(const a of [leftAddress,rightAddress]){const actual=v.report.scene_graph.objects.find(o=>key(o.address)===key(a));assert.ok(actual);assert.equal(actual.id,key(a)===key(leftAddress)?leftId:rightId);assert.equal(actual.world_matrix[12],key(a)===key(leftAddress)?0:8);assert.equal(actual.world_matrix[14],3);}
    assert.equal(v.report.assets.filter(a=>a.mesh_count>0).length,2);return v;
  }
  async function capture(review,label){const state=await snapshot(s=>s.scene_revision===review.revision),payload={action:'runtime_trace',request_id:uid(label),review_id:review.id,expected_version:review.version,world_id:state.world_id,epoch:state.epoch,sequence:state.sequence};
    const result=ok(await req('POST',`/goals/${leftRun.goal_id}/capture`,reviewer,payload),201),response=await fetch(`${api}/goals/${leftRun.goal_id}/artifacts/${result.artifact.id}`,{headers:{authorization:`Bearer ${reviewer.token}`}});assert.equal(response.status,200);
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(sha(bytes),result.artifact.sha256);assert.equal(bytes.length,result.artifact.byte_length);const trace=JSON.parse(bytes);assert.deepEqual(trace.snapshot,state);assert.equal(result.artifact.pin.state_hash,sha(stable(state)));assert.equal(result.artifact.pin.render_verified,false);assert.deepEqual(result.artifact.pin.target_refs.map(t=>t.address),[leftAddress]);await writeFile(resolve(out,`${label}.json`),bytes);return{result,payload,state};
  }
  async function openReview(run,criteria){const b=await branch(),v=await reviewView(run);const verifications=v.current_run.verification_records.filter(x=>x.revision===b.head),deliveries=v.current_run.delivery_records.filter(x=>x.revision===b.head);assert.ok(verifications.length&&deliveries.length);
    for(const value of verifications)await actualVerification(value);
    const result=ok(await req('POST',`/goals/${run.goal_id}/review`,owner,{request_id:uid('cross-review'),expected_review_id:null,run_id:run.id,revision:b.head,runtime_build_id:runtime.build_id,criteria,requires_application:true,verification_ids:verifications.map(v=>v.id),delivery_ids:deliveries.map(d=>d.id)}));return result.review;
  }
  async function step(id,title,fn){const c={id,title,status:'running',started_at:Date.now(),observations:{}};report.cases.push(c);await t.test(`${id} ${title}`,async()=>{try{await fn(c.observations);c.status='passed';}catch(e){c.status='failed';c.error={message:e.message,stack:e.stack};throw e;}finally{c.finished_at=Date.now();await save();console.log(`CROSS_CASE ${id} ${c.status}`);}});if(c.status!=='passed')throw Error(`Stop after ${id}; no mock substitute or repeated goal`);}
  try {
    await step('AX01','new schema2 project with two real models and separately addressed nested counters',async o=>{
      const health=ok(await req('GET','/health',null));assert.ok(health.hierarchy_editing&&health.agent_ready&&health.worlds_ready);
      const response=await fetch(`${origin}/preview-runtime/manifest.json`);runtime=await response.json();assert.equal(runtime.build_id,expectedBuild);assert.ok(runtime.capabilities.document_schemas.includes('creation-hierarchy-2'));report.runtime_manifest=runtime;
      for(const f of runtime.sources)assert.equal(sha(await readFile(resolve(codeRoot,'runtimes/model-preview',f.path))),f.sha256);
      const credentials=[];for(const role of ['owner','reviewer']){const name=uid(`cross-${role}`),password=uid('private-password'),user=ok(await req('POST','/auth/register',null,{name,password}),201);credentials.push({name,password,user_id:user.user.id});if(role==='owner')owner=user;else reviewer=user;}
      const made=ok(await req('POST','/projects',owner,{name:uid('Independent A B address cross'),template:'empty'}),201);projectId=made.project.id;report.project_id=projectId;
      const invite=ok(await req('POST',`/projects/${projectId}/invites`,owner,{role:'editor'}),201);ok(await req('POST','/invites/join',reviewer,{code:invite.code}));
      await tx([{type:'migrate_hierarchy'}]);let b=await branch();const entryRoot=b.manifest.resources[sceneId].root_id;
      const catalog=JSON.parse(await readFile(resolve(codeRoot,'content/model-preview/manifest.json'),'utf8')),modelAsset=catalog.assets.find(a=>a.slug==='beacon');assert.ok(modelAsset);
      const source=resolve(root,'.local/creation-verification/backup-integration/2026-09-07T10-43-12-431Z-c61f15a5/bundle/data/assets/55916ca9f486a34dd08415cf1e28158a98bf6dccdb6272a32084b707a711dbf1.gd');
      const bytes=await readFile(source);assert.equal(sha(bytes),'55916ca9f486a34dd08415cf1e28158a98bf6dccdb6272a32084b707a711dbf1');
      const script=ok(await req('POST',`/projects/${projectId}/assets`,owner,{name:'previous-real-agent-counter-fixture.gd',bytes},true),201);
      const door=document(doorId);door.nodes.door=node('door','root',{name:'同名嵌套门',kind:'model',model_hash:modelAsset.sha256,model_url:`/preview-assets/${modelAsset.sha256}.glb`,components:{interactable:{radius:1.5,label:'门计数'},behaviors:[{id:'cross-counter',api:1,script_hash:script.id,script_url:script.url,properties:{}}]}});
      await tx([{type:'create_resource',resource_id:doorId,resource:door}]);b=await branch();const house=document(houseId);house.instances['door-slot']=mount('door-slot',b.manifest.resources[doorId],'root');await tx([{type:'create_resource',resource_id:houseId,resource:house}]);b=await branch();
      await tx(['left-house','right-house'].map((id,i)=>({type:'instantiate_prefab',resource_id:sceneId,instance_id:id,expected_version:null,instance:mount(id,b.manifest.resources[houseId],entryRoot,[8*i,0,3])})),b);
      leftAddress={project_id:projectId,branch_id:'main',resource_id:sceneId,instance_path:['left-house','door-slot'],definition_node_id:'door'};rightAddress={...leftAddress,instance_path:['right-house','door-slot']};
      const list=await rows(),left=rowFor(list,leftAddress),right=rowFor(list,rightAddress);assert.equal(left.node.name,right.node.name);assert.notEqual(key(left.address),key(right.address));
      const current=await branch(),sc=ok(await req('GET',`${branchPath()}/runtime-scene?revision=${current.head}&resource_id=${sceneId}`));leftId=sc.hierarchy_pack.objects.find(x=>key(x.address)===key(leftAddress)).id;rightId=sc.hierarchy_pack.objects.find(x=>key(x.address)===key(rightAddress)).id;assert.notEqual(leftId,rightId);
      session=ok(await req('POST',`${branchPath()}/sessions`,owner,{title:'Independent nested goals'}),201);ok(await req('PATCH',`/sessions/${session.id}`,owner,{visibility:'shared'}));report.session_id=session.id;
      await writeFile(resolve(out,'access.private.json'),JSON.stringify({origin,project_id:projectId,session_id:session.id,users:credentials},null,2),{mode:0o600});
      peer=await connect(owner);reviewerPeer=await connect(reviewer);const mark=peer.messages.length;peer.send({type:'world_join',project_id:projectId,branch_id:'main',resource_id:sceneId,source_revision:current.head,runtime_build_id:runtime.build_id});
      const joined=await peer.wait(m=>m.type==='world'&&m.packet.action==='join'||m.type==='error',mark,70000);assert.equal(joined.type,'world',JSON.stringify(joined));report.initial_world=joined.packet;
      await snapshot(s=>s.players[owner.user.id]?.online&&counter(s,leftId)===0&&counter(s,rightId)===0,mark);peer.inputSeq=peer.current().players[owner.user.id].last_input_seq;
      const status=ok(await req('GET','/agent/status'));assert.equal(status.ready,true);model=status.default_model;assert.ok(status.models.some(m=>m.model===model));report.actual_model=model;
      o.fixture={left_address:leftAddress,right_address:rightAddress,left_runtime_id:leftId,right_runtime_id:rightId,script_hash:script.id,script_origin:'Previous actual Agent B counter reused as a disclosed test fixture',script_source:source,model_hash:modelAsset.sha256};o.rows=[left,right];
    });
    await step('AX02','two actual goals retain distinct full addresses for same-name nested doors',async o=>{
      rightRun=await run(`This independent goal concerns ONLY the attached RIGHT nested door at ${JSON.stringify(rightAddress)}. Read world_read for ${sceneId}; report its full scoped address and actual pinned definition. This is a read-only goal: do not change any source, files, assets or object. Call real world_validate and then world_publish on the unchanged current revision so this target has a genuine technical/application baseline. Stop after its actual receipt. Do not touch the left door, other projects, browsers, or declare player acceptance.`,rightAddress);
      assert.equal(rightRun.changes.length,0);assert.ok(rightRun.deliveries.length);rightReview=await openReview(rightRun,[{id:'right-separate',text:'右侧门是独立目标；须单独试玩和证据后才能验收。'}]);
      const before=await branch(),beforeRows=await rows();report.before_left_change={branch:before,rows:beforeRows};
      leftRun=await run(`This is a NEW independent goal for ONLY the attached LEFT nested door at ${JSON.stringify(leftAddress)}. It is not a continuation or acceptance of the previous right-door goal. Read fresh world_read for ${sceneId} and WORLD-API.md. Make exactly one source edit: set this left nested door color to #ffbb33 using set_override on outer instance left-house, target instance_path ["door-slot"], definition_node_id "door", path ["color"], current expected_version. Preserve all models, scripts, component properties, transforms, prefab definitions, the right-house instance and its nested door. Then call real world_validate and world_publish for the actual edited revision; wait for applied receipt. Do not operate browsers or other projects, write scripts, or claim experience acceptance.`,leftAddress);
      assert.notEqual(leftRun.goal_id,rightRun.goal_id);assert.equal(leftRun.thread_id,rightRun.thread_id);assert.notEqual(leftRun.turn_id,rightRun.turn_id);
      const s=await sessionView();assert.equal(s.goals.length,2);assert.equal(s.runs.length,2);assert.equal(s.messages.filter(m=>m.role==='user').length,2);for(const r of [rightRun,leftRun])assert.deepEqual(r.targets.map(t=>t.address),[r===rightRun?rightAddress:leftAddress]);
      for(const r of [rightRun,leftRun])for(const tool of ['world_read','world_validate','world_publish'])assert.ok(items(r).some(i=>i.type==='dynamicToolCall'&&i.tool===tool&&i.success));assert.ok(items(leftRun).some(i=>i.tool==='world_apply'&&i.success));assert.equal(items(rightRun).some(i=>i.tool==='world_apply'),false);
      o.right_run=rightRun;o.left_run=leftRun;o.right_review=rightReview;
    });
    await step('AX03','one actual override changes only the left content and both Godot addresses remain separate',async o=>{
      const before=report.before_left_change,after=await branch(),list=await rows();assert.equal(rowFor(list,leftAddress).node.color,'#ffbb33');assert.deepEqual(rowFor(list,rightAddress).node,rowFor(before.rows,rightAddress).node);assert.deepEqual(rowFor(list,rightAddress).world_matrix,rowFor(before.rows,rightAddress).world_matrix);
      assert.deepEqual(after.manifest.resources[sceneId].instances['right-house'],before.branch.manifest.resources[sceneId].instances['right-house']);assert.deepEqual(after.manifest.resources[doorId],before.branch.manifest.resources[doorId]);assert.deepEqual(after.manifest.resources[houseId],before.branch.manifest.resources[houseId]);
      approvedRevision=after.head;assert.ok(leftRun.changes.includes(approvedRevision));const current=await snapshot(s=>s.scene_revision===approvedRevision);assert.equal(current.world_id,report.initial_world.world_id);assert.equal(current.epoch,report.initial_world.epoch);assert.equal(counter(current,leftId),0);assert.equal(counter(current,rightId),0);
      leftReview=await openReview(leftRun,[{id:'only-left',text:'一次真实 interact 只将左侧嵌套门计数从0增加至1；右侧同名门始终0。停止后计数不再增加。'}]);
      leftReview=ok(await req('POST',`/goals/${leftRun.goal_id}/reviewers`,owner,{request_id:uid('delegate'),review_id:leftReview.id,expected_version:leftReview.version,reviewer_user_ids:[reviewer.user.id]})).review;
      o.before_right=rowFor(before.rows,rightAddress);o.after_right=rowFor(list,rightAddress);o.after_left=rowFor(list,leftAddress);o.applied=current;o.left_review=leftReview;
    });
    await step('AX04','real input and retained traces accept only the left goal; normal ticks retain acceptance',async o=>{
      assert.equal((await req('POST',`/goals/${leftRun.goal_id}/decision`,reviewer,{request_id:uid('missing-proof'),review_id:leftReview.id,expected_version:leftReview.version,outcome:'pass',reason:'Must reject missing actual experience evidence',evidence_ids:[]})).status,409);
      const before=await capture(leftReview,'before-left-interact');assert.equal(counter(before.state,leftId),0);assert.equal(counter(before.state,rightId),0);
      const mark=peer.messages.length,seq=input(true);await snapshot(s=>s.players[owner.user.id].last_input_seq>=seq&&counter(s,leftId)===1,mark);const stopSeq=input(false),stopped=await snapshot(s=>s.players[owner.user.id].last_input_seq>=stopSeq);await snapshot(s=>s.tick>stopped.tick+15);
      const after=await capture(leftReview,'after-left-interact');assert.equal(counter(after.state,leftId),1);assert.equal(counter(after.state,rightId),0);
      const evidence=ok(await req('POST',`/goals/${leftRun.goal_id}/evidence`,reviewer,{request_id:uid('cross-evidence'),review_id:leftReview.id,expected_version:leftReview.version,artifact_refs:[before.result.artifact.id,after.result.artifact.id],checks:[{criterion_id:'only-left',result:'passed',observation:`真实认证输入 ${seq}；sequence ${before.state.sequence} 两门均0，sequence ${after.state.sequence} 左1右0，停止后已继续${after.state.tick-stopped.tick} tick。身份以两份服务端原始trace固定。`}]}));leftReview=evidence.review;
      acceptedPayload={request_id:uid('cross-pass'),review_id:leftReview.id,expected_version:leftReview.version,outcome:'pass',reason:'真实协议输入和两份权威快照通过；不代替浏览器体验或视觉验收。',evidence_ids:[evidence.evidence.id]};const accepted=ok(await req('POST',`/goals/${leftRun.goal_id}/decision`,reviewer,acceptedPayload));leftReview=accepted.review;acceptedDecision=accepted.decision;assert.equal(acceptedDecision.actor_id,reviewer.user.id);
      assert.equal((await reviewView(leftRun)).acceptance,'accepted');const oldTick=peer.current().tick;await snapshot(s=>s.tick>=oldTick+35);assert.equal((await reviewView(leftRun)).acceptance,'accepted');
      const other=await reviewView(rightRun);assert.equal(other.decision,null);assert.notEqual(other.acceptance,'accepted');assert.equal(other.review.id,rightReview.id);
      const dev=await peer.wait(m=>m.type==='development'&&m.states.some(x=>x.goal_id===leftRun.goal_id&&x.acceptance==='accepted'));const left=dev.states.filter(x=>x.goal_id===leftRun.goal_id),right=dev.states.filter(x=>x.goal_id===rightRun.goal_id);assert.equal(left.length,1);assert.equal(right.length,1);assert.deepEqual(left[0].address,leftAddress);assert.deepEqual(right[0].address,rightAddress);assert.notEqual(right[0].acceptance,'accepted');
      o.before=before;o.after=after;o.input_seq=seq;o.evidence=evidence.evidence;o.decision=acceptedDecision;o.public_states=[left[0],right[0]];o.right_goal_after=other;
    });
    await step('AX05','removing delegated authority rejects the original request before replay and closes revoked scope',async o=>{
      const replay=ok(await req('POST',`/goals/${leftRun.goal_id}/decision`,reviewer,acceptedPayload));assert.equal(replay.replayed,true);assert.equal(replay.decision.id,acceptedDecision.id);
      leftReview=ok(await req('POST',`/goals/${leftRun.goal_id}/reviewers`,owner,{request_id:uid('revoke-reviewer'),review_id:leftReview.id,expected_version:leftReview.version,reviewer_user_ids:[]})).review;
      const revoked=await req('POST',`/goals/${leftRun.goal_id}/decision`,reviewer,acceptedPayload);assert.equal(revoked.status,403);
      const traceRef=report.cases.find(c=>c.id==='AX04').observations.before.result.artifact.id;
      const stillShared=await fetch(`${api}/goals/${leftRun.goal_id}/artifacts/${traceRef}`,{headers:{authorization:`Bearer ${reviewer.token}`}});assert.equal(stillShared.status,200);
      ok(await req('PATCH',`/projects/${projectId}/members/${reviewer.user.id}`,owner,{role:null}));assert.equal((await req('POST',`/goals/${leftRun.goal_id}/decision`,reviewer,acceptedPayload)).status,403);assert.equal((await req('GET',`/sessions/${session.id}`,reviewer)).status,403);
      const denied=await fetch(`${api}/goals/${leftRun.goal_id}/artifacts/${traceRef}`,{headers:{authorization:`Bearer ${reviewer.token}`}});assert.equal(denied.status,403);
      const end=Date.now()+3000;while(reviewerPeer.socket.readyState!==WebSocket.CLOSED&&Date.now()<end)await pause(20);assert.equal(reviewerPeer.socket.readyState,WebSocket.CLOSED);
      assert.deepEqual((await reviewView(leftRun)).decision,acceptedDecision);assert.equal((await reviewView(leftRun)).acceptance,'accepted');
      o.delegation_revoked_status=revoked.status;o.project_revoked_read_status=denied.status;o.old_socket_closed=true;o.original_decision=acceptedDecision;
    });
    await step('AX06','fixed inside-out definition upgrades preserve old decisions as historical and cannot borrow that run',async o=>{
      let b=await branch();const oldHousePin=b.manifest.resources[sceneId].instances['right-house'].prefab_revision,oldDoorPin=b.manifest.resources[doorId].version;
      await tx([{type:'patch_node',resource_id:doorId,node_id:'door',expected_version:b.manifest.resources[doorId].nodes.door.version,patch:{name:'同名嵌套门 · 新定义'}}],b);b=await branch();const newDoorPin=b.manifest.resources[doorId].version;assert.notEqual(newDoorPin,oldDoorPin);
      let stale=await reviewView(leftRun);assert.equal(stale.acceptance,'accepted_historical');assert.ok(stale.stale_reasons.includes('source_changed'));assert.deepEqual(stale.decision,acceptedDecision);
      assert.equal(rowFor(await rows(),leftAddress).node.name,'同名嵌套门');assert.equal(rowFor(await rows(),rightAddress).node.name,'同名嵌套门');
      async function upgrade(resourceId,instanceId,pin){const base=await branch();const preview=ok(await req('POST',`${branchPath()}/hierarchy-preview`,owner,{expected_head:base.head,resource_id:resourceId,instance_id:instanceId,prefab_revision:pin}));assert.equal(preview.conflicts.length,0);await tx([{type:'upgrade_instance',resource_id:resourceId,instance_id:instanceId,expected_version:base.manifest.resources[resourceId].instances[instanceId].version,prefab_revision:pin,expected_preview_hash:preview.preview_hash,resolutions:{}}],base);return preview;}
      const inner=await upgrade(houseId,'door-slot',newDoorPin);b=await branch();const newHousePin=b.manifest.resources[houseId].version,outer=await upgrade(sceneId,'left-house',newHousePin);b=await branch();const list=await rows();assert.equal(rowFor(list,leftAddress).node.name,'同名嵌套门 · 新定义');assert.equal(rowFor(list,leftAddress).node.color,'#ffbb33');assert.equal(rowFor(list,rightAddress).node.name,'同名嵌套门');assert.equal(b.manifest.resources[sceneId].instances['right-house'].prefab_revision,oldHousePin);
      assert.equal((await req('POST',`/goals/${leftRun.goal_id}/review`,owner,{request_id:uid('reject-new-version-borrow'),expected_review_id:leftReview.id,run_id:leftRun.id,revision:b.head,runtime_build_id:runtime.build_id,criteria:leftReview.criteria,requires_application:true})).status,409);
      const publication=ok(await req('POST',`${branchPath()}/publish`,owner,{revision:b.head,resource_id:sceneId}));await actualVerification(publication.verification);const applied=await snapshot(s=>s.scene_revision===b.head);assert.equal(applied.world_id,report.initial_world.world_id);assert.equal(applied.epoch,report.initial_world.epoch);assert.equal(counter(applied,leftId),1);assert.equal(counter(applied,rightId),0);
      stale=await reviewView(leftRun);assert.equal(stale.acceptance,'accepted_historical');assert.ok(stale.stale_reasons.includes('source_changed'));assert.deepEqual(stale.decision,acceptedDecision);assert.equal(stale.review.revision,approvedRevision);assert.equal(stale.application,'stale');assert.equal((await reviewView(rightRun)).decision,null);
      o.inner_preview=inner;o.outer_preview=outer;o.new_revision=b.head;o.old_accepted_revision=approvedRevision;o.actual_publication=publication;o.applied=applied;o.historical_view=stale;
    });
    report.completed=true;
  }catch(e){report.fatal_error={message:e.message,stack:e.stack};throw e;}
  finally {
    if(peer?.socket.readyState===WebSocket.OPEN){if(peer.current())input(false);peer.send({type:'world_leave'});peer.socket.close();}if(reviewerPeer?.socket.readyState===WebSocket.OPEN)reviewerPeer.socket.close();
    if(session){try{await events();report.final_session=await sessionView();}catch(e){report.final_read_error=e.message;}}
    if(activeRun&&!['completed','failed','interrupted','cancelled'].includes(activeRun.status)){report.unfinished_own_run={id:activeRun.id,session_id:session.id,status:activeRun.status};report.completed=false;}
    report.finished_at=new Date().toISOString();report.counts={executed:report.cases.length,passed:report.cases.filter(c=>c.status==='passed').length,failed:report.cases.filter(c=>c.status==='failed').length};
    report.source_hashes_after=Object.fromEntries(await Promise.all(sources.map(async f=>[f,sha(await readFile(resolve(codeRoot,f)))])));report.source_changed_during_run=sources.filter(f=>report.source_hashes[f]!==report.source_hashes_after[f]);if(report.source_changed_during_run.length)report.completed=false;
    await save();await writeFile(resolve(out,'executed-driver.mjs'),await readFile(fileURLToPath(import.meta.url)));console.log(`HIERARCHY_REVIEW_REPORT ${resolve(out,'report.json')}`);
  }
});
