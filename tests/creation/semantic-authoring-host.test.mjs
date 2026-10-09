import {referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip} from '../../apps/creation-workspace/reference-components.js';
// Actual pure adapters and actual composer preflight, with explicit API/DOM test doubles.
// This is not browser, server persistence or Godot behavior evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { nextSemanticSelection, semanticMutationBody, leadingSemanticMode, semanticAttachmentLabel, semanticAttachmentSummary } from '../../apps/creation-workspace/semantic-workspace-context.js';
import { unresolvedComposerReferences } from '../../apps/creation-workspace/semantic-composer.js';

test('Ctrl toggles exact objects, Shift includes visible range, viewport click clears group',()=>{
  const order=['root','house-a/chest','house-b/chest','tree'];
  let state=nextSemanticSelection({ids:[],anchor:null},order[1],order);
  state=nextSemanticSelection(state,order[2],order,{toggle:true});
  assert.deepEqual(state.ids,['house-a/chest','house-b/chest']);
  state=nextSemanticSelection(state,'tree',order,{range:true});
  assert.deepEqual(state.ids,['house-b/chest','tree']);
  state=nextSemanticSelection(state,'root',order);
  assert.deepEqual(state.ids,['root']);
  assert.equal(nextSemanticSelection(state,'root',order,{toggle:true}).primary,null);
});

test('instance property write pins full address and expected version, never its display name',()=>{
  const address={project_id:'p',branch_id:'main',resource_id:'scene',instance_path:['house-b','inside'],definition_node_id:'chest'};
  const model={revision:'source-7',resource:{id:'chest',version:'definition-5'},target:{resource_id:'scene',address,expected_version:'instance-3',is_instance:true}};
  const body=semanticMutationBody('set_property',model,{property_id:'recovery',value:12},'t-1');
  assert.deepEqual(body,{action:'set_property',transaction_id:'t-1',base_revision:'source-7',resource_id:'scene',expected_version:'instance-3',address,property_id:'recovery',value:12});
  assert.notEqual(body.address,address);
  assert.throws(()=>semanticMutationBody('update_design',model,{design:{}},'t-2'),/来源预制件/);
  assert.equal(semanticMutationBody('reset_property',model,{property_id:'recovery'},'t-3').address.instance_path[0],'house-b');
});

test('definition description writes keep definition identity separate from instance values',()=>{
  const model={revision:'source-7',resource:{id:'weather',version:'definition-5'},target:{resource_id:'weather',expected_version:'root-1',is_instance:false}};
  const body=semanticMutationBody('update_design',model,{design:{category:'system',description:'每天改变天气'}},'t-1');
  assert.equal(body.expected_version,'definition-5');assert.equal(body.resource_id,'weather');assert.equal(body.base_revision,'source-7');
  assert.throws(()=>semanticMutationBody('set_property',{...model,revision:null},{},'t-2'),/固定版本/);
});

test('mode prefixes map to visible intentions and leave file paths alone',()=>{
  assert.deepEqual(leadingSemanticMode('/plan 先讨论天气'),{mode:'plan',text:'先讨论天气'});
  assert.deepEqual(leadingSemanticMode('/goal'),{mode:'goal',text:''});
  assert.equal(leadingSemanticMode('/planning/a.txt'),null);
});

test('unresolved references find all keywords without treating emails as object names',()=>{
  const tokens=unresolvedComposerReferences('联系 a@example.com；参考 $$天气 和 $$存档，调整 @宝箱');
  assert.deepEqual(tokens.map(({kind,query})=>({kind,query})),[{kind:'knowledge',query:'天气'},{kind:'knowledge',query:'存档'},{kind:'object',query:'宝箱'}]);
  assert.equal(semanticAttachmentLabel({kind:'knowledge',name:'死亡规则',snapshot:{title:'旧名称'}}),'死亡规则');
  assert.equal(semanticAttachmentSummary({kind:'prefab',role:'target',design:{category:'system'}}),'游戏系统 · 修改目标');
});

const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
test('actual issue rendering keeps model-free system cards openable when checks need attention',()=>{
  const appended=[],marker={textContent:'! 1'};
  const card={querySelector:()=>null,append:node=>appended.push(node)};
  const resourceButton={dataset:{resource:'energy-system'},closest:()=>card};
  const document={querySelectorAll:selector=>selector==='.catalog-card [data-resource]'?[resourceButton]:[]};
  const context=vm.createContext({document,branch:{manifest:{resources:{}}},resourceId:'scene',project:{id:'p'},
    issueTarget:rid=>({resource_id:rid}),issueButton:target=>target.resource_id==='energy-system'?marker:null,
    object:()=>null,$:()=>null,docObjects:()=>[]});
  const begin=source.indexOf('function renderIssueMarkers(){'),end=source.indexOf('\n}',begin)+2;
  assert.ok(begin>=0&&end>begin);vm.runInContext(source.slice(begin,end)+'\nrenderIssueMarkers();',context);
  assert.deepEqual(appended,[marker]);
});
const start=source.indexOf('async function prepareSemanticDraftForSend(){'),end=source.indexOf('function initializeSemanticAuthoring(){',start);
assert.ok(start>=0&&end>start);
const code=source.slice(start,end);
function fixture({text='参考 $$天气 设计新关卡',request}={}){
  const calls=[],attachments=[],scope={key:'owner/p/main/session/scene/edit',project_id:'p',branch_id:'main',sessionId:'session',sessionGeneration:1,revision:'source-7',readOnly:false};
  const field={value:text,focus(){},setSelectionRange(){},dispatchEvent(){}};
  const state={unresolvedComposerReferences,semanticPreparingDraft:false,sessionData:{draft_attachments:[]},Event,Map,Set,Promise,
    $:()=>field,semanticComposerContext:()=>structuredClone(scope),updateSendButton(){},
    branchRoute:(p,b)=>`projects/${p}/branches/${b}`,
    api:{api:async(route)=>{calls.push(route);return request?request(route):{revision:'source-7',items:[{id:'knowledge:weather',title:'天气'},{id:'resource:climate',title:'气候系统'},{id:'knowledge:season',title:'季节'},{id:'knowledge:extra',title:'无关'}]};}},
    addSemanticReference:async(selection,captured)=>{attachments.push(structuredClone({selection,captured}));state.sessionData.draft_attachments.push({id:'attachment-'+attachments.length,kind:'knowledge',knowledge_id:selection.item.id,name:selection.item.title,revision:selection.revision});},
  };
  Object.assign(state,{referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip});vm.createContext(state);vm.runInContext(code,state);
  return {field,scope,state,calls,attachments,run:()=>vm.runInContext('prepareSemanticDraftForSend()',state)};
}
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};

test('send preflight fixes three highest-ranked real knowledge results at the captured revision',async()=>{
  const f=fixture();await f.run();assert.equal(f.attachments.length,3);assert.match(f.calls[0],/revision=source-7/);
  assert.deepEqual(f.attachments.map(a=>a.selection.item.id),['knowledge:weather','resource:climate','knowledge:season']);
  assert.ok(f.attachments.every(a=>a.selection.revision==='source-7'&&a.captured.sessionId==='session'));
  assert.equal(f.field.value,'参考 [[ref:attachment-1]] [[ref:attachment-2]] [[ref:attachment-3]] 设计新关卡');assert.equal(f.state.semanticPreparingDraft,false);
});

test('unknown knowledge keeps the literal draft and reports no match before any attachment',async()=>{
  const f=fixture({request:async()=>({revision:'source-7',items:[]})});await assert.rejects(f.run(),/没有找到/);
  assert.equal(f.attachments.length,0);assert.equal(f.field.value,'参考 $$天气 设计新关卡');assert.equal(f.state.semanticPreparingDraft,false);
});

test('late knowledge search cannot attach into a changed or revisited session',async()=>{
  const wait=deferred(),f=fixture({request:()=>wait.promise}),job=f.run();f.scope.sessionGeneration++;
  wait.resolve({revision:'source-7',items:[{id:'knowledge:weather'}]});await assert.rejects(job,/会话已切换/);assert.equal(f.attachments.length,0);assert.match(f.field.value,/\$\$/);
});

test('editing the draft during lookup preserves new text and avoids attaching an obsolete request',async()=>{
  const wait=deferred(),f=fixture({request:()=>wait.promise}),job=f.run();f.field.value='换个设计';
  wait.resolve({revision:'source-7',items:[{id:'knowledge:weather'}]});await assert.rejects(job,/草稿.*变化/);assert.equal(f.attachments.length,0);assert.equal(f.field.value,'换个设计');
});

test('unresolved object references block sending until a stable object or prefab is chosen',async()=>{
  for(const text of ['调整 @宝箱 的奖励','修改 @@天气 的周期']){const f=fixture({text});await assert.rejects(f.run(),/选择具体/);assert.equal(f.calls.length,0);assert.equal(f.attachments.length,0);}
});

test('knowledge from an unexpected revision cannot become an attachment',async()=>{
  const f=fixture({request:async()=>({revision:'source-8',items:[{id:'knowledge:weather'}]})});await assert.rejects(f.run(),/版本不匹配/);assert.equal(f.attachments.length,0);
});

test('actual conversation renders streamed and completed plan items across native goal turns',()=>{
  const begin=source.indexOf('function renderConversation(){'),finish=source.indexOf('function renderQuestions(){',begin);
  const resultBegin=source.indexOf('function renderPropertyActionResult('),resultEnd=source.indexOf('async function openPropertyActionResult(',resultBegin);
  const host={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null},scroller={scrollHeight:100,scrollTop:100,clientHeight:100};
  const state={conversationRenderedSession:null,conversationHTML:'',chatDisclosures:new Map(),
    $:selector=>selector==='#sessionConversation'?host:scroller,document:{activeElement:null},project:{members:[]},
    sessionData:{id:'session',owner_user_id:'owner',messages:[],runs:[{id:'run',thread_id:'thread',turn_id:'second',turn_ids:['first','second']}]},
    sessionEvents:[{kind:'notification',method:'item/plan/delta',params:{threadId:'thread',turnId:'first',itemId:'plan-1',delta:'准备天气系统'}}],
    esc:value=>String(value??''),icon:()=>'',renderMarkdown:value=>String(value??''),collectToolCalls:()=>[],renderToolCalls:()=>'',latestRun:()=>null,pendingApprovals:()=>[],updateChatScroll(){},semanticAttachmentLabel,
  };
  Object.assign(state,{referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip});vm.createContext(state);vm.runInContext(source.slice(resultBegin,resultEnd)+source.slice(begin,finish),state);vm.runInContext('renderConversation()',state);
  assert.match(host.innerHTML,/正在规划/);assert.match(host.innerHTML,/准备天气系统/);
  state.sessionEvents.push({kind:'notification',method:'item/completed',params:{threadId:'thread',turnId:'first',item:{id:'plan-1',type:'plan',text:'完整天气计划'}}});
  vm.runInContext('renderConversation()',state);assert.match(host.innerHTML,/设计计划/);assert.match(host.innerHTML,/完整天气计划/);assert.doesNotMatch(host.innerHTML,/正在规划/);
  state.sessionData.messages=[{role:'user',content:'调整天气',attachments:[{id:'p',kind:'prefab',name:'天气'},{id:'k',kind:'knowledge',name:'天气'},{id:'o',kind:'object',name:'天气'}]}];state.sessionEvents=[];
  vm.runInContext('renderConversation()',state);assert.match(host.innerHTML,/aria-label="预制件：天气"/);assert.match(host.innerHTML,/aria-label="知识：天气"/);assert.match(host.innerHTML,/aria-label="场景对象：天气"/);
});

test('actual agent state follows native goal status instead of a completed intermediate turn',()=>{
  const begin=source.indexOf('export function agentState('),finish=source.indexOf('// Avatar cues',begin),state={};
  Object.assign(state,{referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip});vm.createContext(state);vm.runInContext(source.slice(begin,finish).replace('export function','function'),state);
  state.session={runs:[{id:'run',status:'completed',execution_mode:'goal',executor_goal:{status:'active'}}]};
  assert.equal(vm.runInContext('agentState(session).active',state),true);
  assert.match(vm.runInContext('agentState(session).label',state),/持续执行/);
  state.session.runs[0].executor_goal.status='complete';assert.match(vm.runInContext('agentState(session).label',state),/目标已完成/);
});

test('persisted session modes restore after refresh and override stale local cache once writes settle',()=>{
  const begin=source.indexOf('function semanticModeForSession('),finish=source.indexOf('function semanticViewScope(){',begin);
  const state={sessionData:{id:'s',execution_mode:'plan'},settingsWrites:new Map(),semanticModes:new Map()};
  Object.assign(state,{referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip});vm.createContext(state);vm.runInContext(source.slice(begin,finish),state);
  assert.equal(vm.runInContext('semanticModeForSession()',state),'plan');
  state.semanticModes.set('s','goal');state.settingsWrites.set('s',Promise.resolve());
  assert.equal(vm.runInContext('semanticModeForSession()',state),'goal');
  state.settingsWrites.clear();state.sessionData.execution_mode='default';
  assert.equal(vm.runInContext('semanticModeForSession()',state),'normal');
  state.sessionData={id:'other',execution_mode:'goal'};assert.equal(vm.runInContext('semanticModeForSession()',state),'goal');
});

test('direct scene objects use object attachments even without a prefab instance',async()=>{
  const begin=source.indexOf('async function requestSemanticAgent('),finish=source.indexOf('function mountSemanticInspector(){',begin);
  for(const identity of [{object_id:'direct'}, {address:{project_id:'p',branch_id:'main',resource_id:'scene',instance_path:[],definition_node_id:'direct'}}]){
    const attached=[],field={value:'',dispatchEvent(){},focus(){},setSelectionRange(){}};
    const target={id:'direct',name:'直接对象',...identity};
    const state={assertSemanticModel(){},key:()=> 'p/main/scene',copy:structuredClone,ownSession:()=>true,sessionData:{id:'s'},selectedSessionId:'s',
      newSession:async options=>{assert.equal(options.forceNew,true);return {id:'s'};},semanticComposerContext:()=>({sessionId:'s'}),docObjects:()=>[target],fullAddressKey:value=>JSON.stringify(value),
      addSemanticReference:async(selection)=>attached.push(selection),$:()=>field,Event,openChat(){},
      model:{target:{resource_id:'scene',is_instance:false,...identity},resource:{id:'scene',kind:'scene'},name:'直接对象',revision:'r'},intent:{kind:'expose-property'},
    };
    Object.assign(state,{referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip});vm.createContext(state);vm.runInContext(source.slice(begin,finish),state);await vm.runInContext('requestSemanticAgent(intent,model)',state);
    assert.equal(attached.length,1);assert.equal(attached[0].kind,'object');assert.equal(attached[0].item.id,'direct');assert.match(field.value,/增加可调属性/);
  }
});

test('inspector request waits for its own fresh session and rejects late or failed creation',async()=>{
  const begin=source.indexOf('async function requestSemanticAgent('),finish=source.indexOf('function mountSemanticInspector(){',begin);
  for(const scenario of ['creation-failed','document-changed','selection-changed','new-session-not-selected','permission-lost']){
    const wait=deferred(),attached=[],field={value:'旧会话草稿',dispatchEvent(){},focus(){},setSelectionRange(){}};
    const state={assertSemanticModel(){},key:()=>state.documentKey,documentKey:'p/main/scene',copy:structuredClone,
      ownSession:()=>state.allowed,allowed:true,sessionData:{id:'old'},selectedSessionId:'old',
      newSession:options=>{assert.equal(options.forceNew,true);return wait.promise;},
      semanticComposerContext:()=>({sessionId:state.selectedSessionId}),docObjects:()=>[{id:'direct'}],fullAddressKey:JSON.stringify,
      addSemanticReference:async selection=>attached.push(selection),$:()=>field,Event,openChat(){},
      model:{target:{resource_id:'scene',object_id:'direct'},resource:{id:'scene'},name:'对象',revision:'r'},intent:{kind:'develop'}};
    Object.assign(state,{referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip});vm.createContext(state);vm.runInContext(source.slice(begin,finish),state);const action=vm.runInContext('requestSemanticAgent(intent,model)',state);
    assert.equal(attached.length,0);assert.equal(field.value,'旧会话草稿');
    state.sessionData={id:'fresh'};state.selectedSessionId='fresh';
    if(scenario==='document-changed')state.documentKey='p/main/another';
    if(scenario==='selection-changed')state.selectedSessionId='other';
    if(scenario==='new-session-not-selected')state.sessionData={id:'old'};
    if(scenario==='permission-lost')state.allowed=false;
    wait.resolve(scenario==='creation-failed'?undefined:{id:'fresh'});
    await assert.rejects(action,/会话|对象/);assert.equal(attached.length,0);assert.equal(field.value,'旧会话草稿');
  }
});

test('inspector request cannot append its prompt after the user switches sessions during attachment persistence',async()=>{
  const begin=source.indexOf('async function requestSemanticAgent('),finish=source.indexOf('function mountSemanticInspector(){',begin);
  const wait=deferred(),field={value:'切换后会话的草稿',dispatchEvent(){assert.fail('must not edit new session');},focus(){},setSelectionRange(){}};
  const state={assertSemanticModel(){},key:()=> 'p/main/scene',copy:structuredClone,ownSession:()=>true,sessionData:{id:'fresh'},selectedSessionId:'fresh',
    newSession:async()=>({id:'fresh'}),semanticComposerContext:()=>({sessionId:'fresh'}),docObjects:()=>[{id:'direct'}],
    addSemanticReference:()=>wait.promise,$:()=>field,Event,openChat(){},model:{target:{resource_id:'scene',object_id:'direct'},resource:{id:'scene'},name:'对象',revision:'r'},intent:{kind:'develop'}};
  Object.assign(state,{referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip});vm.createContext(state);vm.runInContext(source.slice(begin,finish),state);const action=vm.runInContext('requestSemanticAgent(intent,model)',state);await new Promise(done=>setImmediate(done));
  state.selectedSessionId='other';wait.resolve();await action;assert.equal(field.value,'切换后会话的草稿');
});
