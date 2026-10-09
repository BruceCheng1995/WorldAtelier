import {referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip} from '../../apps/creation-workspace/reference-components.js';
import { leadingSemanticMode } from '../../apps/creation-workspace/semantic-workspace-context.js';
import { unresolvedComposerReferences } from '../../apps/creation-workspace/semantic-composer.js';
// Independent pure helpers and actual-function FAKE VM/API regressions.
// No service, browser, project mutation, or Agent execution is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const helpers=source.split('// BEGIN SESSION START UX')[1]?.split('// END SESSION START UX')[0];assert.ok(helpers);
const {firstMessageTitle,reconcileSessionTitle,reusableNewSession,SessionStartGate}=await import('data:text/javascript;base64,'+Buffer.from(helpers).toString('base64'));
const scope={user_id:'owner',project_id:'p',branch_id:'main'};
const blank=(extra={})=>({id:'s',...scope,owner_user_id:scope.user_id,title:'新会话',visibility:'shared',draft:'',messages:[],runs:[],draft_attachments:[],executor_thread_id:null,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function section(from,to){const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start,from);return source.slice(start,end);}
const startCode=section('function newSession(','function renameSessionTitle(');
const titleCode=section('function renameSessionTitle(','function latestRun(){');
const sendCode=section('function sameSubmissionScope(','async function retryTurn(){');
const refreshCode=section('async function refreshSession(){','const sessionStartKey=');

test('first title folds whitespace, remains plain text and truncates by Unicode code point',()=>{
  assert.equal(firstMessageTitle('  建造\n\t一个  星港  '),'建造 一个 星港');
  assert.equal(firstMessageTitle('   '),'新会话');assert.equal(firstMessageTitle(null),'新会话');
  assert.equal(firstMessageTitle('😀'.repeat(37)),'😀'.repeat(36)+'…');
  assert.equal(firstMessageTitle('<img src=x> & 内容'),'<img src=x> & 内容');
});

test('reusing a new session requires the current owner, exact scope and no persisted or unsaved work',()=>{
  assert.equal(reusableNewSession(blank(),scope),true);
  for(const changes of [{title:'我的计划'},{visibility:'private'},{owner_user_id:'peer'},{project_id:'other'},{branch_id:'other'},{executor_thread_id:'thread'},{messages:[{role:'assistant'}]},{runs:[{status:'completed'}]},{draft:'saved text'},{draft_attachments:[{id:'object'}]}])assert.equal(reusableNewSession(blank(changes),scope),false,JSON.stringify(changes));
  assert.equal(reusableNewSession(blank(),scope,'unsaved draft'),false);
  assert.equal(reusableNewSession(blank({draft:'saved'}),scope,''),false,'local empty cache cannot hide persisted text');
  assert.equal(reusableNewSession(null,scope),false);assert.equal(reusableNewSession(blank(),null),false);
});

test('confirmed title overrides only equal/older snapshots, preserves their other facts and yields to a newer remote rename',()=>{
  const confirmed={title:'Confirmed',updated_at:200};
  for(const updated_at of [undefined,199,200]){const input=blank({title:'Old',updated_at,messages:[{role:'user'}]}),before=structuredClone(input),result=reconcileSessionTitle(input,confirmed);assert.equal(result.title,'Confirmed');assert.deepEqual(result.messages,input.messages);assert.deepEqual(input,before);}
  assert.equal(reconcileSessionTitle(blank({title:'Newer remote',updated_at:201}),confirmed).title,'Newer remote');
  assert.equal(reconcileSessionTitle(null,confirmed),null);assert.equal(reconcileSessionTitle(blank({title:'No confirmation'}),null).title,'No confirmation');
});

test('creation gate coalesces same scope, permits independent scopes and releases ordinary failures',async()=>{
  const gate=new SessionStartGate(),wait=deferred();let calls=0;
  const first=gate.run('p/main',()=>{calls++;return wait.promise;}),again=gate.run('p/main',()=>assert.fail('duplicate operation'));
  assert.equal(first,again);await tick();assert.equal(calls,1);assert.equal(await gate.run('p/other',async()=>42),42);
  wait.resolve('created');assert.equal(await first,'created');assert.equal(gate.pending.size,0);
  await assert.rejects(gate.run('p/main',async()=>{throw new Error('known failure');}),/known failure/);
  assert.equal(await gate.run('p/main',async()=>43),43);
});

test('uncertain creation remains locked until explicit list acknowledgement and does not block another branch',async()=>{
  const gate=new SessionStartGate();let calls=0;
  await assert.rejects(gate.run('p/main',async()=>{calls++;throw Object.assign(new Error('lost receipt'),{uncertain:true});}),/lost receipt/);
  await assert.rejects(gate.run('p/main',async()=>{calls++;}),{uncertain:true});assert.equal(calls,1);
  assert.equal(await gate.run('p/other',async()=>7),7);gate.acknowledge('p/main');
  await gate.run('p/main',async()=>{calls++;});assert.equal(calls,2);
});

function fixture({session=blank({title:'Existing session'}),request,flush}={}){
  const nodes=new Map(),calls=[],errors=[],toasts=[],state={};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='#sessionDraft'?'创建北侧星门':'' ,textContent:'',disabled:false,attributes:{},setAttribute(name,value){this.attributes[name]=String(value);},focus(){calls.push(['focus',id]);}});return nodes.get(id);};
  const memory=new Map();let messageId=0;
  Object.assign(state,{user:{id:'owner'},project:{id:'p'},branch:{branch_id:'main'},branchLoadGeneration:1,sessionLoadGeneration:1,
    selectedSessionId:session?.id??null,sessionData:structuredClone(session),sessions:session?[structuredClone(session)]:[],sessionFilter:'mine',chatFocus:null,
    sessionStartGate:new SessionStartGate(),sessionSendJobs:new Map(),sessionTitleWrites:new Map(),sessionTitleConfirmations:new Map(),draftCache:new Map(),pendingTurnSubmissions:new Map(),attachmentWrites:new Map(),settingsWrites:new Map(),
    leadingSemanticMode,unresolvedComposerReferences,semanticComposerPending:false,semanticPreparingDraft:false,semanticModes:new Map(),prepareSemanticDraftForSend:async()=>true,
    firstMessageTitle,reconcileSessionTitle,reusableNewSession,copy:structuredClone,uuid:()=>`FAKE-message-${++messageId}`,
    $:node,canWrite:()=>state.writeAllowed!==false,ownSession:s=>Boolean(s&&s.owner_user_id===state.user?.id),branchKey:()=>state.branch?`${state.project.id}/${state.branch.branch_id}`:null,
    branchRoute:(p,b)=>`projects/${p}/branches/${b}`,sessionRoute:id=>`sessions/${id}`,
    sessionStartKey:()=>state.user&&state.branch?`${state.user.id}/${state.project.id}/${state.branch.branch_id}`:null,
    closeTopbarMenu:()=>calls.push(['close-topbar']),closeSessionPicker:()=>calls.push(['close-picker']),openSessionPicker:()=>calls.push(['open-picker']),
    openChat:focus=>calls.push(['open-chat',focus]),updateNewSessionControls:()=>calls.push(['create-controls']),scheduleRosterRefresh:()=>calls.push(['refresh-roster']),renderSessions:()=>calls.push(['render-sessions']),
    flushDraft:()=>{calls.push(['flush']);return flush?flush():Promise.resolve();},
    selectSession:async id=>{calls.push(['select',id]);state.selectedSessionId=id;state.sessionData=structuredClone(state.sessions.find(s=>s.id===id));state.sessionLoadGeneration++;},
    report:e=>errors.push(e),toast:m=>toasts.push(m),errorText:e=>e.message,
    renderComposer:()=>{calls.push(['render-composer']);node('#sessionTitle').textContent=state.sessionData?.title??'';},
    submissionScope:()=>state.user&&state.branch&&state.sessionData?{user_id:state.user.id,project_id:state.project.id,branch_id:state.branch.branch_id,session_id:state.sessionData.id}:null,
    runBusy:()=>state.pendingTurnSubmissions.has(state.selectedSessionId),pendingSubmission:()=>state.pendingTurnSubmissions.get(state.selectedSessionId),
    storeSubmission:submission=>memory.set(submission.scope.session_id,structuredClone(submission)),sessionStorage:{removeItem:key=>memory.delete(key)},refreshSession:async()=>{},
    agentStatus:{ready:true,default_model:'model'},api:{api:async(route,options)=>{calls.push(['api',route,structuredClone(options)]);return request?request(route,options,state):blank({id:'created'});}},
  });
  Object.assign(state,{referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip});vm.createContext(state);vm.runInContext([startCode,titleCode,sendCode,refreshCode].join('\n'),state);
  return {state,calls,errors,toasts,nodes,run:code=>vm.runInContext(code,state),apiCalls:()=>calls.filter(c=>c[0]==='api')};
}

test('actual quick create makes one public session with one selection, without a naming modal',async()=>{
  const wait=deferred(),f=fixture({request:()=>wait.promise});
  const first=f.run('newSession()'),second=f.run('newSession()');await tick();assert.equal(f.apiCalls().length,1);
  const [,route,options]=f.apiCalls()[0];assert.equal(route,'projects/p/branches/main/sessions');assert.equal(options.method,'POST');assert.equal(options.body.title,'新会话');
  wait.resolve(blank({id:'created'}));await Promise.all([first,second]);assert.deepEqual(f.calls.filter(c=>c[0]==='select'),[['select','created']]);assert.deepEqual(f.calls.filter(c=>c[0]==='open-chat'),[['open-chat',true]]);
  await f.run('newSession()');assert.equal(f.apiCalls().length,1,'subsequent click reuses the still-empty current session');
});

test('inspector forceNew creates a fresh session even when the current one is empty',async()=>{
  const f=fixture({session:blank()});await f.run('newSession({forceNew:true})');
  assert.equal(f.apiCalls().length,1);assert.equal(f.state.selectedSessionId,'created');
  assert.deepEqual(f.apiCalls()[0][2].body,{title:'新会话',visibility:'shared',model:'model'});
});

test('inspector forceNew preserves old goal mode, draft and attachments instead of copying them',async()=>{
  const original=blank({execution_mode:'goal',draft:'旧目标草稿',draft_attachments:[{id:'old-target'}],goals:[{id:'old-goal'}]});
  const f=fixture({session:original});f.state.draftCache.set('s','未保存的新文本');
  await f.run('newSession({forceNew:true})');
  assert.equal(f.calls[0][0],'close-topbar');assert.ok(f.calls.findIndex(call=>call[0]==='flush')<f.calls.findIndex(call=>call[0]==='api'));
  assert.equal(f.state.draftCache.get('s'),'未保存的新文本');assert.deepEqual(f.state.sessions.find(session=>session.id==='s'),original);
  assert.equal(f.apiCalls()[0][2].body.execution_mode,undefined);assert.equal(f.apiCalls()[0][2].body.goal_id,undefined);
});

test('actual quick create preserves old draft and skips POST if branch, user or navigation changes during flush',async()=>{
  for(const change of [s=>s.branch={branch_id:'other'},s=>s.user={id:'other'},s=>s.branchLoadGeneration++,s=>s.sessionLoadGeneration++]){
    const wait=deferred(),f=fixture({flush:()=>wait.promise});f.state.draftCache.set('s','do not discard');
    const action=f.run('newSession()');await tick();change(f.state);wait.resolve();await action;
    assert.equal(f.apiCalls().length,0);assert.equal(f.calls.some(c=>c[0]==='select'||c[0]==='open-chat'),false);assert.equal(f.state.draftCache.get('s'),'do not discard');
  }
});

test('late create receipts cannot select or focus a different branch, user or same-branch reentry',async()=>{
  for(const change of [s=>s.branch={branch_id:'other'},s=>s.user={id:'other'},s=>s.branchLoadGeneration++]){
    const wait=deferred(),f=fixture({request:()=>wait.promise});const action=f.run('newSession()');await tick();change(f.state);wait.resolve(blank({id:'late'}));await action;
    assert.equal(f.state.sessions.some(s=>s.id==='late'),false);assert.equal(f.calls.some(c=>c[0]==='select'||c[0]==='open-chat'),false);
  }
});

test('navigation during creation keeps the new session available without stealing the selected conversation',async()=>{
  const wait=deferred(),f=fixture({request:()=>wait.promise}),action=f.run('newSession()');await tick();f.state.sessionLoadGeneration++;f.state.selectedSessionId='chosen-by-user';wait.resolve(blank({id:'created'}));await action;
  assert.equal(f.state.sessions.some(s=>s.id==='created'),true);assert.equal(f.state.selectedSessionId,'chosen-by-user');assert.equal(f.calls.some(c=>c[0]==='select'||c[0]==='open-chat'),false);
});

test('pending message, attachment or settings work prevents empty-session reuse, and viewers cannot create',async()=>{
  for(const map of ['pendingTurnSubmissions','attachmentWrites','settingsWrites']){const f=fixture({session:blank()});f.state[map].set('s',{});await f.run('newSession()');assert.equal(f.apiCalls().length,1,map);}
  const f=fixture();f.state.writeAllowed=false;await f.run('newSession()');assert.equal(f.apiCalls().length,0);
});

test('actual uncertain create opens the picker and further clicks cannot repeat its POST',async()=>{
  const f=fixture({request:async()=>{throw Object.assign(new Error('lost receipt'),{uncertain:true});}});await f.run('newSession()');await f.run('newSession()');assert.equal(f.apiCalls().length,1);assert.ok(f.calls.some(c=>c[0]==='open-picker'));assert.ok(f.errors.every(e=>e.uncertain));
  f.state.sessionStartGate.acknowledge('owner/p/main');await f.run('newSession()');assert.equal(f.apiCalls().length,2);
});

function sendingFixture({title='新会话',messages=[],bound=false}={}){
  const titleWait=deferred(),turnWait=deferred();const f=fixture({session:blank({title,messages,executor_thread_id:bound?'FAKE-existing-thread':null}),request:(route,options={})=>route.endsWith('/turns')?turnWait.promise:options.method==='PATCH'?titleWait.promise:route==='sessions/s'?blank({title,messages,executor_thread_id:bound?'FAKE-existing-thread':null}):assert.fail(route)});
  f.state.draftCache.set('s','创建北侧星门');return {...f,titleWait,turnWait,reply:(name=title)=>turnWait.resolve({session:blank({title:name,messages:[{role:'user',content:'创建北侧星门'}]})})};
}

test('actual sending is single-flight while flush and first binding wait; auto title PATCH starts only after successful turn receipt',async()=>{
  const flush=deferred(),f=sendingFixture();f.state.flushDraft=()=>flush.promise;
  const first=f.run('sendDraft()'),second=f.run('sendDraft()');assert.equal(first,second);await tick();assert.equal(f.apiCalls().length,0);
  flush.resolve();await tick();assert.equal(f.apiCalls().filter(c=>c[1].endsWith('/turns')).length,1);assert.equal(f.apiCalls().filter(c=>c[2].method==='PATCH').length,0,'no title can race first executor binding');
  assert.equal(f.run('sendDraft()'),first,'click during first binding also coalesces');
  const turn=f.apiCalls().find(c=>c[1].endsWith('/turns'));assert.equal(turn[2].body.text,'创建北侧星门');assert.equal(turn[2].body.client_user_message_id,'FAKE-message-1');
  f.reply('新会话');await first;assert.equal(f.apiCalls().filter(c=>c[2].method==='PATCH').length,1);f.titleWait.resolve(blank({title:'创建北侧星门'}));await tick();assert.equal(f.state.sessionData.title,'创建北侧星门');assert.equal(f.state.sessionSendJobs.size,0);
});

test('title failure never blocks the immutable turn and never clears the submitted message',async()=>{
  const f=sendingFixture(),action=f.run('sendDraft()');await tick();f.reply();await action;f.titleWait.reject(new Error('title failed'));await tick();
  assert.equal(f.apiCalls().filter(c=>c[1].endsWith('/turns')).length,1);assert.equal(f.state.sessionData.messages[0].content,'创建北侧星门');assert.ok(f.toasts.some(t=>/名称/.test(t)));
});

test('custom names and already-sent sessions never trigger first-message automatic naming',async()=>{
  for(const input of [{title:'手动名称'},{messages:[{role:'user',content:'earlier'}]}]){const f=sendingFixture(input),action=f.run('sendDraft()');await tick();assert.equal(f.apiCalls().some(c=>c[2].method==='PATCH'),false);f.reply(input.title??'新会话');await action;}
});

test('confirmed automatic title cannot be rolled back by a late turn snapshot',async()=>{
  const f=sendingFixture(),action=f.run('sendDraft()');await tick();f.reply('新会话');await action;f.titleWait.resolve(blank({title:'创建北侧星门',updated_at:200}));await tick();assert.equal(f.state.sessionData.title,'创建北侧星门');
  assert.equal(f.nodes.get('#toggleSessions').attributes['aria-label'],'切换会话：创建北侧星门');assert.equal(f.nodes.get('#toggleSessions').title,'创建北侧星门 · 点击切换会话');
  f.state.lateSubmission={scope:{...scope,session_id:'s'},body:{text:'创建北侧星门'}};f.state.lateResult={session:blank({title:'新会话',updated_at:100,messages:[{role:'user',content:'创建北侧星门'}]})};f.run('receiveSubmission(lateSubmission,lateResult)');assert.equal(f.state.sessionData.title,'创建北侧星门');assert.equal(f.nodes.get('#sessionTitle').textContent,'创建北侧星门');
});

test('existing manual title PATCH finishes before first binding and repeated send clicks remain one turn',async()=>{
  const f=sendingFixture(),rename=f.run('renameSessionTitle("s","手动名称")'),first=f.run('sendDraft()'),second=f.run('sendDraft()');assert.equal(first,second);await tick();assert.equal(f.apiCalls().filter(c=>c[1].endsWith('/turns')).length,0);
  f.titleWait.resolve(blank({title:'手动名称'}));await rename;await tick();assert.equal(f.apiCalls().filter(c=>c[1].endsWith('/turns')).length,1);f.reply('手动名称');await first;assert.equal(f.apiCalls().filter(c=>c[2].method==='PATCH').length,1);assert.equal(f.state.sessionData.title,'手动名称');
});

test('switching session while waiting for an existing title write never sends into the next conversation',async()=>{
  const f=sendingFixture(),rename=f.run('renameSessionTitle("s","旧会话标题")'),action=f.run('sendDraft()');f.state.selectedSessionId='other';f.state.sessionData=blank({id:'other',title:'Current'});f.state.sessionLoadGeneration++;
  f.titleWait.resolve(blank({title:'旧会话标题'}));await rename;await action;assert.equal(f.apiCalls().filter(c=>c[1].endsWith('/turns')).length,0);assert.equal(f.state.sessionData.title,'Current');
});

test('known and uncertain turn failures do not automatically name or resend; uncertain request stays recoverable',async()=>{
  for(const uncertain of [false,true]){const f=sendingFixture(),action=f.run('sendDraft()');await tick();f.turnWait.reject(Object.assign(new Error('FAKE turn failure'),{uncertain}));await action;assert.equal(f.apiCalls().filter(c=>c[2]?.method==='PATCH').length,0);assert.equal(f.apiCalls().filter(c=>c[1].endsWith('/turns')).length,1);assert.equal(f.state.pendingTurnSubmissions.has('s'),uncertain);assert.equal(f.state.sessionSendJobs.size,0);assert.equal(f.state.draftCache.get('s'),'创建北侧星门');}
});

test('successful first receipt may name its own old session after navigation without touching the new conversation',async()=>{
  for(const boundary of ['session','branch']){const f=sendingFixture(),action=f.run('sendDraft()');await tick();f.state.selectedSessionId='other';f.state.sessionData=blank({id:'other',title:'Keep current',branch_id:boundary==='branch'?'other':'main'});f.state.sessionLoadGeneration++;if(boundary==='branch')f.state.branch={branch_id:'other'};
    f.reply();await action;const patches=f.apiCalls().filter(c=>c[2]?.method==='PATCH');assert.equal(patches.length,1);assert.equal(patches[0][1],'sessions/s');assert.equal(f.state.sessionData.title,'Keep current');f.titleWait.resolve(blank({title:'创建北侧星门'}));await tick();assert.equal(f.state.sessionData.title,'Keep current');assert.equal(f.calls.some(c=>c[0]==='open-chat'),false);}
});

test('logging into another account while first receipt waits prevents automatic title mutation',async()=>{
  const f=sendingFixture(),action=f.run('sendDraft()');await tick();f.state.user={id:'other-owner'};f.state.sessionData=blank({id:'new-account-session',owner_user_id:'other-owner',title:'New account'});f.state.selectedSessionId='new-account-session';f.reply();await action;
  assert.equal(f.apiCalls().filter(c=>c[2]?.method==='PATCH').length,0);assert.equal(f.state.sessionData.title,'New account');
});

test('confirmed manual name in an already-bound session remains authoritative when an in-flight turn returns an older title',async()=>{
  const f=sendingFixture({title:'已有标题',bound:true}),action=f.run('sendDraft()');await tick();const rename=f.run('renameSessionTitle("s","我的手动名称")');f.titleWait.resolve(blank({title:'我的手动名称'}));await rename;
  assert.equal(f.nodes.get('#toggleSessions').attributes['aria-label'],'切换会话：我的手动名称');assert.equal(f.nodes.get('#toggleSessions').title,'我的手动名称 · 点击切换会话');
  f.reply('已有标题');await action;assert.equal(f.state.sessionData.title,'我的手动名称');assert.equal(f.state.sessions[0].title,'我的手动名称');
});

test('actual rename refuses an unbound session while its first submit is sending or uncertain',async()=>{
  for(const pending of [{sending:true},{sending:false,uncertain:true}]){const f=fixture({session:blank()});f.state.pendingTurnSubmissions.set('s',{...pending,scope:{...scope,session_id:'s'}});await f.run('renameSessionTitle("s","不应抢在绑定前")');assert.equal(f.apiCalls().length,0,JSON.stringify(pending));assert.equal(f.state.sessionData.title,'新会话');}
});

test('actual composer disables name input throughout sending and uncertain initial binding but permits already-bound renaming',()=>{
  const composer=section('function renderComposer(){','async function removeDraftAttachment('),expression=composer.match(/\$\('#sessionName'\)\.disabled=([^;]+);/)?.[1];assert.ok(expression,'test actual name-input disabling expression');
  const evaluate=(pending,bound=false,own=true)=>vm.runInNewContext(expression,{own,s:blank({executor_thread_id:bound?'existing':null}),sessionTitleWrites:new Map(),pendingSubmission:()=>pending});
  assert.equal(evaluate({sending:true}),true);assert.equal(evaluate({sending:false,uncertain:true}),true);assert.equal(evaluate(null),false);assert.equal(evaluate({sending:true},true),false);assert.equal(evaluate(null,true,false),true);
});

test('actual refresh keeps a confirmed title in both composer and picker but accepts a newer remote title',async()=>{
  let data=blank({title:'Old snapshot',updated_at:100});const f=fixture({session:blank({title:'Confirmed',updated_at:200}),request:async()=>structuredClone(data)});f.state.sessionTitleConfirmations.set('s',{title:'Confirmed',updated_at:200});
  await f.run('refreshSession()');assert.equal(f.state.sessionData.title,'Confirmed');assert.equal(f.state.sessions[0].title,'Confirmed');
  data=blank({title:'Newer remote',updated_at:300});await f.run('refreshSession()');assert.equal(f.state.sessionData.title,'Newer remote');assert.equal(f.state.sessions[0].title,'Newer remote');
});

test('late title success or failure cannot update another user or branch',async()=>{
  for(const fail of [false,true])for(const boundary of ['branch','user']){const f=sendingFixture({title:'Before'}),rename=f.run('renameSessionTitle("s","New")');if(boundary==='branch')f.state.branch={branch_id:'other'};else f.state.user={id:'other'};f.state.sessionData=blank({id:'other',branch_id:'other',title:'Keep current'});f.state.selectedSessionId='other';
    if(fail)f.titleWait.reject(new Error('old failure'));else f.titleWait.resolve(blank({title:'New'}));await rename;assert.equal(f.state.sessionData.title,'Keep current');assert.equal(f.state.sessions[0].title,'Before');assert.deepEqual(f.toasts,[]);}
});

test('session changes during flush preserve original draft and never dispatch it into the next conversation',async()=>{
  const wait=deferred(),f=sendingFixture();f.state.flushDraft=()=>wait.promise;const action=f.run('sendDraft()');f.state.selectedSessionId='other';f.state.sessionData=blank({id:'other'});wait.resolve();await assert.rejects(action,/切换/);assert.equal(f.apiCalls().length,0);assert.equal(f.state.draftCache.get('s'),'创建北侧星门');
});

 test('quick create makes the new session public on an older service without changing existing private sessions',async()=>{
 const f=fixture({session:blank({visibility:'private'}),request:(route,options)=>blank({id:'created',visibility:options.method==='POST'?'private':'shared'})});
 await f.run('newSession()');
 assert.equal(f.apiCalls().length,2);
 assert.equal(f.apiCalls()[0][2].body.visibility,'shared');
 assert.equal(f.apiCalls()[1][1],'sessions/created');
 assert.deepEqual(f.apiCalls()[1][2],{method:'PATCH',body:{visibility:'shared'}});
 assert.equal(f.state.sessions.find(s=>s.id==='s').visibility,'private');
 assert.equal(f.state.sessionData.visibility,'shared');
});
