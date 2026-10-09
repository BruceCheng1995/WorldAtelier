import {userColor} from '../../apps/creation-workspace/client-platform.js';
// Independent pure projection / FAKE API tests of the production topbar helpers.
// No browser, service, user data, Agent, world, or network is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const start='// BEGIN WORKSPACE TOPBAR',end='// END WORKSPACE TOPBAR';
assert.equal(source.split(start).length,2,'one production topbar region');
assert.equal(source.split(end).length,2,'one production topbar region end');
const helpers=source.split(start)[1].split(end)[0];
const {agentColor,groupAgentAvatars,collaboratorUsers,agentState,updateAgentRequests,AgentRoster}=await import('data:text/javascript;base64,'+Buffer.from(`import {userColor} from ${JSON.stringify(new URL('../../apps/creation-workspace/client-platform.js',import.meta.url).href)};\n`+helpers).toString('base64'));
const scope={user_id:'owner',project_id:'project',branch_id:'main'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const run=(status='running',extra={})=>({id:'run-a',session_id:'session-a',thread_id:'thread-a',turn_id:'turn-a',created_at:10,status,...extra});
const session=(id='session-a',extra={})=>({id,project_id:scope.project_id,branch_id:scope.branch_id,owner_user_id:scope.user_id,visibility:'private',title:'Actual-shaped FAKE session',runs:[],...extra});
const requestEvent=(key='epoch:1',extra={})=>({kind:'approval_request',request_key:key,cursor:1,params:{threadId:'thread-a',turnId:'turn-a'},...extra});
const noise=cursor=>({kind:'notification',method:'item/agentMessage/delta',cursor,params:{threadId:'thread-a',turnId:'turn-a',delta:'FAKE'}});
function rosterFixture(handler){
  const calls=[],changes=[];
  const roster=new AgentRoster({request:async(route,options)=>{calls.push({route,options});assert.ok(options.signal instanceof AbortSignal);assert.ok(!options.method||options.method==='GET','roster must remain read only');assert.equal(options.body,undefined);return handler(route,options);},onChange:()=>changes.push({scope:roster.scope,ids:[...roster.entries.keys()],loading:roster.loading})});
  roster.reset({...scope});
  return {roster,calls,changes};
}

test('actual presence wire shape deduplicates multiple windows by user without dropping collaborators',()=>{
  // CreationRealtime.presence spreads publicUser {id,name,color}; peer_id is a window.
  const peers=[{id:'owner',peer_id:'window-1',name:'Owner'},{id:'owner',peer_id:'window-2',name:'Owner'},{id:'peer',peer_id:'window-3',name:'Peer'}];
  const before=structuredClone(peers),users=collaboratorUsers(peers);
  assert.equal(users.length,2);assert.deepEqual(users.map(p=>p.user_id??p.id).sort(),['owner','peer']);assert.deepEqual(peers,before);
  assert.equal(agentColor(session()),userColor({id:'owner'}));
  assert.equal(agentColor(session('other-session')),agentColor(session()),'creator identity survives different sessions');
  assert.notEqual(agentColor(session('other',{owner_user_id:'peer'})),agentColor(session()));
  assert.equal(agentColor(null),userColor(null));
});

test('execution status stays distinct from validation, application and acceptance',()=>{
  const cases=[['starting','working',true],['running','working',true],['waiting_input','attention',true],['uncertain','attention',true],['completed','ended',false],['failed','failed',false]];
  for(const [status,key,active]of cases){const s=session('s',{runs:[run(status)]}),copy=structuredClone(s),state=agentState(s);assert.equal(state.key,key,status);assert.equal(state.active,active,status);assert.deepEqual(s,copy);}
  const ended=agentState(session('s',{runs:[run('completed',{acceptance:'pending',deliveries:['delivery']})]}));
  assert.equal(ended.label,'执行结束');assert.doesNotMatch(ended.label,/已验收|已交付|验证通过/);
  assert.equal(agentState(session()).key,'idle');assert.equal(agentState(null).key,'unknown');
  assert.deepEqual(agentState(session('s',{runs:[run()]}),[],false),{key:'unknown',label:'状态待刷新',active:false});
});

test('cleanup of any older run remains visible until verified even if the latest run ended',()=>{
  for(const cleanup_status of ['pending','uncertain',undefined]){
    const s=session('s',{runs:[run('interrupted',{created_at:1,cleanup_status}),run('completed',{id:'new',created_at:20})]});
    const state=agentState(s);assert.equal(state.key,'attention');assert.equal(state.active,true);assert.match(state.label,cleanup_status==='pending'?/停止后台命令/:/待核对/);
  }
  assert.equal(agentState(session('s',{runs:[run('interrupted',{cleanup_status:'verified'})]})).active,false);
  assert.equal(agentState(session('s',{runs:[run('cancelling',{cleanup_status:'verified'})]})).active,true);
});

test('only a pending request for the latest exact thread and turn can show waiting for reply',()=>{
  const s=session('s',{runs:[run('running'),run('completed',{id:'old',created_at:1})]});
  assert.match(agentState(s,[requestEvent()]).label,/等待.*回复/);
  for(const params of [{threadId:'other',turnId:'turn-a'},{threadId:'thread-a',turnId:'old-turn'}])assert.equal(agentState(s,[requestEvent('e',{params})]).key,'working');
  assert.equal(agentState(session('s',{runs:[run('completed')]}),[requestEvent()]).active,false);
});

test('pending replies clear only their request, thread or terminal turn and survive paginated replay',()=>{
  const pending=new Map();
  updateAgentRequests(pending,[requestEvent(),requestEvent('epoch:2',{params:{threadId:'thread-a',turnId:'turn-b'}}),requestEvent('epoch:3',{params:{threadId:'thread-b',turnId:'turn-a'}})]);
  updateAgentRequests(pending,[{kind:'notification',method:'serverRequest/resolved',epoch:'epoch',params:{requestId:1,threadId:'wrong-thread'}}]);assert.equal(pending.size,3);
  updateAgentRequests(pending,[{kind:'notification',method:'serverRequest/resolved',epoch:'epoch',params:{requestId:1,threadId:'thread-a'}}]);assert.equal(pending.has('epoch:1'),false);
  updateAgentRequests(pending,[{kind:'serverRequestReply',requestKey:'epoch:2'}]);assert.deepEqual([...pending.keys()],['epoch:3']);
  updateAgentRequests(pending,[requestEvent(),{kind:'run_state',run:run('completed')}]);assert.deepEqual([...pending.keys()],['epoch:3']);
  updateAgentRequests(pending,[{kind:'notification',method:'thread/deleted',params:{threadId:'thread-b'}}]);assert.equal(pending.size,0);
});

test('roster filters wrong scopes and private collaborators before loading details; revocation removes stale entries',async()=>{
  let phase=0;
  const summaries=[session(),session('shared',{owner_user_id:'peer',visibility:'shared'}),session('private-peer',{owner_user_id:'peer'}),session('other-branch',{branch_id:'other'}),session('other-project',{project_id:'other'})];
  const f=rosterFixture(async route=>{
    if(route.endsWith('/sessions'))return {sessions:summaries};
    if(route==='sessions/session-a')return session();
    if(route==='sessions/shared'){if(phase===1)throw Object.assign(new Error('revoked'),{status:403});return summaries[1];}
    assert.fail('Unauthorized detail request: '+route);
  });
  await f.roster.refresh();assert.deepEqual([...f.roster.entries.keys()],['session-a','shared']);
  phase=1;await f.roster.refresh();assert.deepEqual([...f.roster.entries.keys()],['session-a']);
  assert.equal(f.calls.some(c=>/private-peer|other-branch|other-project/.test(c.route)),false);
});

test('detail scope/identity/access mismatch fails closed even after a visible summary',async()=>{
  const invalid=[{id:'other'},{project_id:'other'},{branch_id:'other'},{owner_user_id:'peer',visibility:'private'}];
  for(const mismatch of invalid){const f=rosterFixture(async route=>route.endsWith('/sessions')?{sessions:[session()]}:session('session-a',mismatch));await f.roster.refresh();assert.equal(f.roster.entries.size,0,JSON.stringify(mismatch));}
});

test('reset aborts requests; late old branch detail cannot enter a new branch or finish its loading state',async()=>{
  const old=deferred(),fresh=deferred();let details=0;
  const f=rosterFixture(async route=>{
    if(route.endsWith('/sessions'))return {sessions:[session('session-a',{branch_id:route.includes('/other/')?'other':'main'})]};
    return ++details===1?old.promise:fresh.promise;
  });
  const previous=f.roster.refresh();await tick();const oldSignal=f.calls.at(-1).options.signal;
  f.roster.reset({...scope,branch_id:'other'});assert.equal(oldSignal.aborted,true);assert.equal(f.roster.entries.size,0);
  const current=f.roster.refresh();await tick();old.resolve(session('session-a'));await previous;
  assert.equal(f.roster.loading,true);assert.equal(f.roster.entries.get('session-a').session.branch_id,'other');assert.ok(f.roster.pending);
  fresh.resolve(session('session-a',{branch_id:'other'}));await current;
  assert.equal(f.roster.loading,false);assert.equal(f.roster.entries.get('session-a').session.branch_id,'other');
});

test('same branch reentry is a new generation and rejects a late same-scope summary',async()=>{
  const old=deferred();let lists=0;
  const f=rosterFixture(async route=>route.endsWith('/sessions')?(++lists===1?old.promise:{sessions:[session('new')]}):session('new'));
  const previous=f.roster.refresh();await tick();f.roster.reset({...scope});await f.roster.refresh();
  old.resolve({sessions:[session('old')]});await previous;assert.deepEqual([...f.roster.entries.keys()],['new']);
  assert.equal(f.calls.some(c=>c.route==='sessions/old'),false);
  f.roster.reset();await f.roster.refresh();assert.equal(f.roster.entries.size,0);assert.equal(f.roster.scope,null);
});

test('list failure clears previous visibility; individual transient failure preserves only a stale state',async()=>{
  let phase=0;const f=rosterFixture(async route=>{
    if(route.endsWith('/sessions')){if(phase===2)throw new Error('offline');return {sessions:[session()]};}
    if(phase===1)throw new Error('temporary');return session('session-a',{runs:[run('completed')]});
  });
  await f.roster.refresh();assert.equal(f.roster.entries.get('session-a').fresh,true);
  phase=1;await f.roster.refresh();const stale=f.roster.entries.get('session-a');assert.equal(stale.fresh,false);assert.equal(agentState(stale.session,[],stale.fresh).key,'unknown');
  phase=2;await f.roster.refresh();assert.equal(f.roster.error,true);assert.equal(f.roster.entries.size,0);
});

test('event pagination consumes a later-page reply before exposing a current waiting state',async()=>{
  const offsets=[],first=Array.from({length:500},(_,i)=>noise(i+1));first[0]=requestEvent();
  const f=rosterFixture(async route=>{
    if(route.endsWith('/sessions'))return {sessions:[session()]};
    if(route==='sessions/session-a')return session('session-a',{runs:[run()]});
    const after=Number(new URL(route,'https://fake.invalid/').searchParams.get('after'));offsets.push(after);return {events:after===0?first:after===500?[{kind:'serverRequestReply',requestKey:'epoch:1',cursor:501}]:[]};
  });
  await f.roster.refresh();const entry=f.roster.entries.get('session-a');assert.deepEqual(offsets,[0,500]);assert.equal(entry.cursor,501);assert.equal(entry.requests.size,0);assert.equal(entry.fresh,true);assert.equal(agentState(entry.session,[...entry.requests.values()],entry.fresh).key,'working');
  await f.roster.refresh();assert.equal(offsets.at(-1),501,'next poll continues exact cursor');
});

test('four-page catchup limit stays unknown and the next poll resumes without skipping a late pending request',async()=>{
  const offsets=[];const f=rosterFixture(async route=>{
    if(route.endsWith('/sessions'))return {sessions:[session()]};
    if(route==='sessions/session-a')return session('session-a',{runs:[run()]});
    const after=Number(new URL(route,'https://fake.invalid/').searchParams.get('after'));offsets.push(after);
    return {events:after<2000?Array.from({length:500},(_,i)=>noise(after+i+1)):after===2000?[requestEvent('late',{cursor:2001})]:[]};
  });
  await f.roster.refresh();let entry=f.roster.entries.get('session-a');assert.deepEqual(offsets,[0,500,1000,1500]);assert.equal(entry.cursor,2000);assert.equal(entry.fresh,false);assert.equal(agentState(entry.session,[...entry.requests.values()],entry.fresh).key,'unknown');
  await f.roster.refresh();entry=f.roster.entries.get('session-a');assert.equal(offsets.at(-1),2000);assert.equal(entry.fresh,true);assert.match(agentState(entry.session,[...entry.requests.values()],entry.fresh).label,/等待.*回复/);
});

test('concurrent refreshes coalesce with at most three detail reads, only issue read-only requests and preserve API payloads',async()=>{
  const gates=Array.from({length:7},deferred),payload=Array.from({length:7},(_,i)=>session('s'+i));
  const snapshots=structuredClone(payload);
  let active=0,peak=0;const f=rosterFixture(async route=>{
    if(route.endsWith('/sessions'))return {sessions:payload};
    const index=Number(route.match(/^sessions\/s(\d+)$/)[1]);active++;peak=Math.max(peak,active);await gates[index].promise;active--;return payload[index];
  });
  const jobs=[f.roster.refresh(),f.roster.refresh(),f.roster.refresh()];await tick();assert.equal(f.calls.filter(c=>c.route.endsWith('/sessions')).length,1);assert.equal(active,3);
  for(let i=0;i<gates.length;i++){gates[i].resolve();await tick();}
  await Promise.all(jobs);assert.equal(peak,3);assert.equal(f.roster.entries.size,7);assert.deepEqual(payload,snapshots);assert.equal(f.roster.loading,false);
});

test('a run ending on the next read clears pending requests and removes active status without opening a session',async()=>{
  let ended=false;const f=rosterFixture(async route=>{
    if(route.endsWith('/sessions'))return {sessions:[session()]};
    if(route==='sessions/session-a')return session('session-a',{runs:[run(ended?'completed':'running')]});
    return {events:[requestEvent()]};
  });
  await f.roster.refresh();let entry=f.roster.entries.get('session-a');assert.match(agentState(entry.session,[...entry.requests.values()],entry.fresh).label,/等待.*回复/);
  ended=true;await f.roster.refresh();entry=f.roster.entries.get('session-a');assert.equal(entry.requests.size,0);assert.equal(agentState(entry.session,[],entry.fresh).active,false);assert.equal(f.calls.filter(c=>c.route.includes('/events')).length,1);
});
