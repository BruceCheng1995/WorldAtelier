import {userColor} from '../../apps/creation-workspace/client-platform.js';
// Independent state / event / actual-render tests. All transport and DOM are FAKE.
// No browser, service, Agent, world, network, or live user state is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const helpers=source.split('// BEGIN WORKSPACE TOPBAR')[1]?.split('// END WORKSPACE TOPBAR')[0];
assert.ok(helpers);
const {agentColor,sessionActivityAt,compareSessionActivity,agentListStatus,groupAgentAvatars,collaboratorUsers,agentAvatarSignal,AgentAvatarActivity,updateAgentRequests,AgentRoster}=await import('data:text/javascript;base64,'+Buffer.from(`import {userColor} from ${JSON.stringify(new URL('../../apps/creation-workspace/client-platform.js',import.meta.url).href)};\n`+helpers).toString('base64'));
const scope={user_id:'owner',project_id:'p',branch_id:'main'};
const run=(status='running',extra={})=>({id:'r',session_id:'s',thread_id:'thread',turn_id:'turn',created_at:20,status,...extra});
const session=(status='running',extra={})=>({id:'s',title:'FAKE session',project_id:'p',branch_id:'main',owner_user_id:'owner',visibility:'private',runs:status?[run(status)]:[],...extra});
const request=(extra={})=>({kind:'approval_request',request_key:'epoch:1',method:'item/tool/requestUserInput',category:'input',params:{threadId:'thread',turnId:'turn',questions:[{id:'q',question:'FAKE question'}]},...extra});
const signal=(s,pending=[],fresh=true,viewer='owner')=>agentAvatarSignal(s,pending,fresh,viewer);
const row=(s,pending=[],fresh=true)=>({session:s,state:signal(s,pending,fresh)});
function freeze(value){if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;}

test('motion follows execution rather than delivery, acceptance, stopping or uncertain outcomes',()=>{
  for(const [status,motion]of [['starting','working'],['running','working'],['waiting_input','paused'],['uncertain','paused'],['completed','idle'],['failed','error'],['cancelled','idle']]){
    const s=freeze(session(status,{goals:[{status:'completed',acceptance_status:'accepted'}]})),state=signal(s);
    assert.equal(state.motion,motion,status);assert.equal(state.needsReply,false,status);
    assert.doesNotMatch(state.label,/验收通过|已交付|需要你/,status);
  }
  assert.equal(signal(session(null)).motion,'idle');
  assert.equal(signal(session('interrupted',{runs:[run('interrupted',{cleanup_status:'verified'})]})).motion,'idle');
  for(const s of [null,session('running')]){
    const state=signal(s,[request()],false);assert.equal(state.key,'unknown');assert.equal(state.motion,'idle');assert.equal(state.needsReply,false);
  }
});

test('only the owner gets a reply cue for every backend-supported input or approval method',()=>{
  for(const [method,category]of [['item/tool/requestUserInput','input'],['mcpServer/elicitation/request','input'],['item/commandExecution/requestApproval','approval'],['item/fileChange/requestApproval','approval'],['execCommandApproval','approval'],['applyPatchApproval','approval']]){
    const s=freeze(session()),pending=freeze([request({method,category})]),state=signal(s,pending);
    assert.equal(state.motion,'reply',method);assert.equal(state.needsReply,true,method);
    assert.match(state.label,category==='approval'?/需要你授权/:/需要你回复/,method);
    const observer=signal({...s,visibility:'shared'},pending,true,'peer');
    assert.equal(observer.motion,'paused',method);assert.equal(observer.needsReply,false,method);assert.match(observer.label,/所有者/);assert.doesNotMatch(observer.label,/你的|需要你/);
  }
});

test('unsupported requests never tell either viewer to reply or authorize',()=>{
  for(const [method,category]of [['future/request','unsupported'],['item/permissions/requestApproval','approval']])for(const viewer of ['owner','peer']){
    const state=signal(session(),[request({method,category})],true,viewer);
    assert.equal(state.needsReply,false);assert.equal(state.motion,'paused');assert.doesNotMatch(state.label,/你的|需要你|你授权/,method+' '+viewer);
  }
});

test('old, malformed, missing-identity and terminal requests cannot trigger reply motion',()=>{
  for(const extra of [{kind:'notification'},{params:{threadId:'other',turnId:'turn'}},{params:{threadId:'thread',turnId:'old'}},{params:{}},{}]){
    const s=session();if(!Object.keys(extra).length)s.runs=[run('running',{thread_id:undefined,turn_id:undefined})];
    const state=signal(s,[request(extra)]);assert.notEqual(state.motion,'reply');assert.equal(state.needsReply,false);
  }
  for(const status of ['completed','failed','cancelled','uncertain'])assert.equal(signal(session(status),[request()]).needsReply,false,status);
  assert.equal(signal(session('running',{runs:[run('running',{turn_id:'new'}),run('running',{id:'old',created_at:1})]}),[request()]).needsReply,false);
});

test('cleanup on any run suppresses replies and completion effects until actually verified',()=>{
  for(const cleanup_status of ['pending','uncertain',undefined]){
    const s=session('running',{runs:[run(),run('interrupted',{id:'old',created_at:1,cleanup_status})]}),state=signal(s,[request()]);
    assert.equal(state.motion,'paused');assert.equal(state.needsReply,false);assert.match(state.label,/停止/);
    const activity=new AgentAvatarActivity();activity.update('scope',[row(session())],100);
    const ended={...s,runs:s.runs.map(r=>r.id==='r'?{...r,status:'completed'}:r)};
    assert.equal(activity.update('scope',[row(ended)],200)[0].state.motion,'paused');
  }
  assert.equal(signal(session('running',{runs:[run(),run('interrupted',{id:'old',created_at:1,cleanup_status:'verified'})]}),[request()]).motion,'reply');
});

test('reply, resolved, terminal turn and closed thread clear pending action cues',()=>{
  for(const closing of [{kind:'serverRequestReply',requestKey:'epoch:1'},{kind:'notification',method:'serverRequest/resolved',epoch:'epoch',params:{requestId:1,threadId:'thread'}},{kind:'run_state',run:run('completed')},{kind:'run_state',run:run('failed')},{kind:'run_state',run:run('interrupted')},{kind:'notification',method:'thread/closed',params:{threadId:'thread'}}]){
    const pending=new Map();updateAgentRequests(pending,[request()]);assert.equal(signal(session(),[...pending.values()]).needsReply,true);
    updateAgentRequests(pending,[closing]);assert.equal(pending.size,0);assert.equal(signal(session(),[...pending.values()]).needsReply,false);
  }
});

test('a terminal event fetched after running detail immediately stops working and reply motion',async()=>{
  for(const status of ['completed','failed','interrupted']){
    const s=session(),events=[{...request(),cursor:1},{kind:'run_state',cursor:2,run:run(status,{cleanup_status:status==='interrupted'?'verified':undefined})}];
    const roster=new AgentRoster({request:async route=>route.endsWith('/sessions')?{sessions:[s]}:route==='sessions/s'?structuredClone(s):{events}});
    roster.reset({...scope});await roster.refresh();const entry=roster.entries.get('s'),state=signal(entry.session,[...entry.requests.values()],entry.fresh);
    assert.equal(entry.fresh,true);assert.equal(entry.session.runs[0].status,status);assert.equal(entry.requests.size,0);
    assert.notEqual(state.motion,'working');assert.notEqual(state.motion,'reply');
  }
});

test('roster event merge is immutable, session-scoped and follows terminal events on later pages',async()=>{
  const input=freeze(session()),before=structuredClone(input),foreign=freeze({kind:'run_state',cursor:1,run:run('failed',{session_id:'other'})});
  const first=Array.from({length:500},(_,i)=>({kind:'notification',cursor:i+1,method:'item/agentMessage/delta',params:{delta:'FAKE'}}));first[0]=foreign;
  const terminal=freeze({kind:'run_state',cursor:501,run:run('completed')}),offsets=[];
  const roster=new AgentRoster({request:async route=>{
    if(route.endsWith('/sessions'))return {sessions:[input]};if(route==='sessions/s')return input;
    const cursor=Number(new URL(route,'https://fake.invalid').searchParams.get('after'));offsets.push(cursor);return {events:cursor===0?first:[terminal]};
  }});
  roster.reset({...scope});await roster.refresh();const entry=roster.entries.get('s');
  assert.deepEqual(offsets,[0,500]);assert.equal(entry.fresh,true,'frozen API snapshots remain usable');assert.equal(entry.session.runs[0].status,'completed');
  assert.deepEqual(input,before);assert.equal(entry.session.runs.some(r=>r.session_id==='other'),false);
});

test('completion is a single observed transition with fixed expiry, never initial historical celebration',()=>{
  const activity=new AgentAvatarActivity();
  assert.equal(activity.update('scope',[row(session('completed'))],100)[0].state.motion,'idle');
  activity.update('scope',[row(session('running'))],200);
  const done=activity.update('scope',[row(session('completed'))],300)[0].state;
  assert.equal(done.motion,'settled');assert.equal(done.settleUntil,2100);
  for(const now of [301,900,2099]){const state=activity.update('scope',[row(session('completed'))],now)[0].state;assert.equal(state.motion,'settled');assert.equal(state.settleUntil,2100,'repaint cannot extend completion');}
  for(const now of [2100,2200,10000]){const state=activity.update('scope',[row(session('completed'))],now)[0].state;assert.equal(state.motion,'idle');assert.equal(state.settleUntil,0);}
});

test('scope resets, unknown gaps, removed sessions and different runs never replay old completion',()=>{
  for(const boundary of ['scope','unknown','removed','different-run']){
    const activity=new AgentAvatarActivity();activity.update('scope',[row(session())],100);
    if(boundary==='unknown')activity.update('scope',[row(session(),[],false)],120);
    if(boundary==='removed')activity.update('scope',[],120);
    const done=session('completed');if(boundary==='different-run')done.runs=[run('completed',{id:'other'})];
    const state=activity.update(boundary==='scope'?'scope-new':'scope',[row(done)],200)[0].state;
    assert.equal(state.motion,'idle',boundary);assert.equal(state.settleUntil,0,boundary);
  }
});

test('waiting owner can finish once, but uncertain, failed and cancelled transitions cannot celebrate',()=>{
  const activity=new AgentAvatarActivity();activity.update('scope',[row(session('waiting_input'),[request()])],100);
  assert.equal(activity.update('scope',[row(session('completed'))],200)[0].state.motion,'settled');
  for(const status of ['uncertain','failed','cancelled']){
    const other=new AgentAvatarActivity();other.update('scope',[row(session(status))],100);
    assert.equal(other.update('scope',[row(session('completed'))],200)[0].state.motion,'idle',status);
  }
});

function section(from,to){const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start,from);return source.slice(start,end);}

// Minimal identity-preserving DOM fixture for the actual paint/render functions.
// It records HTML replacement; it does not simulate CSS animation or a browser.
class FakeNode {
  constructor(){this.style={setProperty:(key,value)=>{this.style[key]=value;}};this.dataset={};this.value='';this.textContent='';this.title='';this.className='';this.attributes={};this.children=[];this.writes=0;this.scrollTop=0;this.isConnected=true;}
  set innerHTML(value){
    this.html=value;this.writes++;this.children=[];
    if(value.includes('<svg')){this.svg={identity:Symbol('svg')};this.dot=new FakeNode();}
    for(const match of value.matchAll(/data-agent-avatar="([^"]+)" data-agent-owner="([^"]*)"/g)){const avatar=new FakeNode();avatar.dataset.agentAvatar=match[1];avatar.dataset.agentOwner=match[2];avatar.svg={identity:Symbol('svg')};avatar.dot=new FakeNode();this.children.push(avatar);}
    for(const match of value.matchAll(/data-agent-session="([^"]+)"/g)){const button=new FakeNode();button.dataset.agentSession=match[1];this.children.push(button);}
    for(const match of value.matchAll(/data-session="([^"]+)"/g)){const button=new FakeNode();button.dataset.session=match[1];this.children.push(button);}
  }
  get innerHTML(){return this.html??'';}
  querySelector(selector){return selector==='svg'?this.svg:selector==='.agent-dot'?this.dot:null;}
  querySelectorAll(selector){return selector==='button'?this.children.filter(n=>n.dataset.agentSession):selector==='button[data-session]'?this.children.filter(n=>n.dataset.session):[];}
  setAttribute(name,value){this.attributes[name]=String(value);}
  contains(node){return node===this||this.children.includes(node);}
  focus(){this.focused=true;}
}
function renderFixture(){
  const nodes=new Map(),timers=new Map();let nextTimer=1,now=1000;
  const $=selector=>{if(!nodes.has(selector))nodes.set(selector,new FakeNode());return nodes.get(selector);};
  $('#connectionStatus').dataset.state='connected';
  const state={$,document:{activeElement:null,querySelectorAll:()=>[...nodes.values()].flatMap(n=>[n,...n.children]).filter(n=>n.dataset.agentAvatar!==undefined)},
    sessions:[],sessionFilter:'mine',draftCache:new Map(),ownSession:s=>s?.owner_user_id===state.user.id,selectedSessionId:'s',sessionData:null,sessionEvents:[],sessionCursor:0,topbarScope:'owner/p/main/1',user:{id:'owner'},project:{id:'p',name:'FAKE project',members:[{id:'owner',name:'FAKE owner'}]},branch:{branch_id:'main'},peers:[],branchPeers:[],
    agentRoster:{entries:new Map([['s',{session:session(),requests:new Map(),fresh:true,cursor:0}]]),loading:false,error:false},sessionTitleConfirmations:new Map(),
    avatarActivity:new (class extends AgentAvatarActivity {update(scope,rows){return super.update(scope,rows,now);}})(),avatarSignals:new Map(),avatarSettleTimer:null,agentColor,sessionActivityAt,compareSessionActivity,agentListStatus,groupAgentAvatars,collaboratorUsers,agentAvatarSignal,updateAgentRequests,
    reconcileSessionTitle:s=>s,userColor,esc:value=>String(value??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
    icon:name=>`<svg class="icon"><use href="#i-${name}"/></svg>`,updateNewSessionControls(){},Date:class extends Date {static now(){return now;}},
    setTimeout:(callback,ms)=>{const id=nextTimer++;timers.set(id,{callback,ms});return id;},clearTimeout:id=>timers.delete(id),
  };
  vm.createContext(state);vm.runInContext(section('const robotAvatar=','function clearTopbar(){')+'\n'+section('function agentListCard(','async function selectSession(')+'\n'+section('function renderTopbarAgents(){','function closeTopbarMenu('),state);
  return {state,$,nodes,timers,setNow:value=>{now=value;},render:()=>vm.runInContext('renderTopbarAgents()',state),paint:()=>vm.runInContext('paintAgentAvatars()',state)};
}

test('actual repeated renders preserve active stack, dropdown and header avatar nodes',()=>{
  const f=renderFixture();f.render();
  const stack=f.$('#collaboratorAvatars'),list=f.$('#agentRosterList'),header=f.$('#sessionAgentAvatar');
  const stackAvatar=stack.children.find(n=>n.dataset.agentAvatar==='s'),listAvatar=list.children.find(n=>n.dataset.agentAvatar==='s');
  const original=[stackAvatar.svg,listAvatar.svg,header.svg],writes=[stack.writes,list.writes,header.writes];
  for(let i=0;i<10;i++)f.render();
  assert.deepEqual([stack.writes,list.writes,header.writes],writes,'same-state rerenders do not replace animated SVGs');
  assert.equal(stack.children.find(n=>n.dataset.agentAvatar==='s').svg,original[0]);assert.equal(list.children.find(n=>n.dataset.agentAvatar==='s').svg,original[1]);assert.equal(header.svg,original[2]);
  for(const avatar of [stackAvatar,listAvatar,header])assert.equal(avatar.dataset.motion,'working');
});

test('actual painting synchronizes all avatar states without rebuilding their SVG, and disconnect stops motion',()=>{
  const f=renderFixture();f.render();const header=f.$('#sessionAgentAvatar'),svg=header.svg;
  f.state.agentRoster.entries.get('s').requests.set('epoch:1',request());f.render();
  for(const avatar of f.state.document.querySelectorAll('[data-agent-avatar]')){assert.equal(avatar.dataset.motion,'reply');assert.equal(avatar.dot.textContent,'?');assert.match(avatar.title,/需要你回复/);}
  assert.equal(header.svg,svg);assert.match(f.$('#collaboratorsButton').attributes['aria-label'],/1 个需要你回复/);
  f.$('#connectionStatus').dataset.state='disconnected';f.render();
  for(const avatar of f.state.document.querySelectorAll('[data-agent-avatar]')){assert.equal(avatar.dataset.motion,'idle');assert.equal(avatar.dot.textContent,'');assert.match(avatar.title,/刷新/);}
  assert.equal(header.svg,svg);assert.doesNotMatch(f.$('#collaboratorsButton').attributes['aria-label'],/需要你回复/);
});

test('actual completed avatar stays briefly visible, has one expiry and cannot replay after disconnect',()=>{
  const f=renderFixture();f.render();f.setNow(1200);f.state.agentRoster.entries.get('s').session=session('completed');f.render();
  assert.equal(f.$('#sessionAgentAvatar').dataset.motion,'settled');assert.ok(f.$('#collaboratorAvatars').children.some(n=>n.dataset.agentAvatar==='s'));
  assert.equal(f.timers.size,1);f.setNow(2000);f.render();assert.equal(f.timers.size,1);
  f.setNow(3001);f.render();assert.equal(f.$('#sessionAgentAvatar').dataset.motion,'idle');assert.equal(f.timers.size,0);assert.equal(f.$('#collaboratorAvatars').children.some(n=>n.dataset.agentAvatar==='s'),false);
  f.$('#connectionStatus').dataset.state='disconnected';f.render();f.$('#connectionStatus').dataset.state='connected';f.render();assert.equal(f.$('#sessionAgentAvatar').dataset.motion,'idle');
});

test('reduced-motion explicitly disables avatar, SVG and pseudo-element motion while retaining static cues',()=>{
  const css=readFileSync(new URL('../../apps/creation-workspace/workspace.css',import.meta.url),'utf8');
  const rule=css.match(/@media\(prefers-reduced-motion:reduce\)\{([^\n]*\.agent-avatar[^\n]*)\}/)?.[1];assert.ok(rule,'avatar-specific reduced-motion media query');
  for(const selector of ['.agent-avatar[data-motion]','.agent-avatar[data-motion]>.icon','.agent-avatar[data-motion]::after'])assert.ok(rule.includes(selector),selector);
  for(const property of ['animation:none!important','transition:none!important','transform:none!important'])assert.ok(rule.includes(property),property);
  assert.match(rule,/data-motion=working\]::after\{opacity:/);assert.match(rule,/data-motion=reply\]::after\{opacity:/);
});


test('creator groups show numeric totals, preserve reply priority and keep every session in the dropdown',()=>{
  const f=renderFixture();
  f.state.agentRoster.entries.set('s2',{session:session('running',{id:'s2',title:'Second agent'}),requests:new Map([['epoch:1',request()]]),fresh:true});
  f.state.agentRoster.entries.set('peer',{session:session('running',{id:'peer',owner_user_id:'another-owner',title:'Peer agent'}),requests:new Map(),fresh:true});
  f.render();
  const stack=f.$('#collaboratorAvatars'),list=f.$('#agentRosterList');
  assert.equal(stack.children.length,2);
  assert.match(stack.innerHTML,/data-agent-avatar="s2"[^>]*data-agent-count="2"/);
  assert.match(stack.innerHTML,/<b class="agent-count">2<\/b>/);
  assert.equal(list.children.filter(n=>n.dataset.agentSession).length,3);
  assert.equal(stack.children.find(n=>n.dataset.agentAvatar==='s2').dataset.motion,'reply');
  for(const avatar of f.state.document.querySelectorAll('[data-agent-avatar]')){
    const owner=avatar.dataset.agentAvatar==='peer'?'another-owner':'owner';
    assert.equal(avatar.style['--agent-color'],userColor({id:owner}));
  }
  f.state.agentRoster.entries.delete('s2');f.render();
  assert.doesNotMatch(stack.innerHTML,/class="agent-count"/);
  assert.equal(stack.children.length,2);
  f.state.user={id:'different-viewer'};f.render();
  assert.equal(f.$('#sessionAgentAvatar').style['--agent-color'],userColor({id:'owner'}));
});


test('topbar humans use the branch roster even when the current scene has fewer peers',()=>{
  const f=renderFixture();
  f.state.peers=[{id:'owner',peer_id:'one',name:'Current scene'}];
  f.state.branchPeers=[{id:'owner',name:'Owner'},{id:'peer',name:'Other scene'}];
  f.render();
  assert.match(f.$('#collaboratorsButton').attributes['aria-label'],/2 人在线/);
  assert.match(f.$('#topbarPeople').innerHTML,/此分支在线协作者 · 2/);
  assert.match(f.$('#topbarPeople').innerHTML,/Other scene/);
  f.state.peers=[];f.render();
  assert.match(f.$('#collaboratorsButton').attributes['aria-label'],/2 人在线/);
  f.state.branchPeers=[];f.render();
  assert.match(f.$('#collaboratorsButton').attributes['aria-label'],/0 人在线/);
});
