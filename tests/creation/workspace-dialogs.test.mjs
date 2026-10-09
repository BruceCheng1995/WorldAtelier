// Actual production methods with bounded host doubles. No browser, service, engine or user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {GameCatalog,suggestBranchId} from '../../apps/creation-workspace/game-catalog.js';

const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
function section(start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`production section ${start}`);return source.slice(a,b);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const plain=value=>JSON.parse(JSON.stringify(value));
function node(document,extra={}){
  return {dataset:{},attributes:{},disabled:false,isConnected:true,hidden:false,textContent:'',value:'',
    focus(){document.activeElement=this;},getClientRects(){return this.hidden?[]:[{}];},
    setAttribute(name,value){this.attributes[name]=String(value);},removeAttribute(name){delete this.attributes[name];},
    closest(){return null;},checkValidity(){return true;},matches(){return false;},
    addEventListener(type,handler){this['on'+type]=handler;},...extra};
}

function modalFixture(){
  const document={activeElement:null},controls=[],nodes=new Map(),dialog=node(document,{open:false,
    showModal(){this.open=true;},close(){this.open=false;}}),body=node(document),footer=node(document);
  const trigger=node(document);document.activeElement=trigger;
  const close=node(document);let html='';
  Object.defineProperty(body,'innerHTML',{get:()=>html,set:value=>{html=value;nodes.get('#modalError')&&(nodes.get('#modalError').isConnected=false);}});
  body.insertAdjacentHTML=()=>nodes.set('#modalError',node(document));
  body.querySelectorAll=()=>controls;
  body.querySelector=selector=>selector==='[data-autofocus]'?controls.find(n=>n.dataset.autofocus!==undefined)??null:null;
  let buttons=[];
  Object.defineProperty(footer,'innerHTML',{set:value=>{
    buttons.forEach(button=>button.isConnected=false);
    buttons=[...value.matchAll(/<button[^>]*class="([^"]+)"[^>]*data-modal-button="(\d+)"[^>]*>([^<]*)<\/button>/g)].map(match=>node(document,{className:match[1],textContent:match[3],click(){if(!this.disabled)this.lastJob=this.onclick({currentTarget:this,target:this});return this.lastJob;}}));
  }});
  footer.querySelector=selector=>selector==='.primary'?buttons.find(button=>button.className.includes('primary')):buttons[Number(selector.match(/"(\d+)"/)[1])];
  for(const [id,value]of Object.entries({modal:dialog,modalBody:body,modalFooter:footer,modalTitle:node(document),closeModal:close}))nodes.set('#'+id,value);
  const context=vm.createContext({document,$:selector=>nodes.get(selector),topbarTrigger:trigger,modalFocus:null,
    esc:String,errorText:error=>error.message});
  vm.runInContext(section('let modalGeneration=','function openChat('),context);
  return {context,document,dialog,body,footer,controls,trigger,nodes,
    open:(...args)=>context.modal(...args),close:()=>context.closeModal(),primary:()=>footer.querySelector('.primary')};
}

test('branch IDs are valid, stable for Chinese input and avoid existing IDs without mutating names',()=>{
  const format=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
  for(const name of ['Night Garden','夜间花园','','  .-_  ','Été 測試','ＡＢＣ','a'.repeat(160),'__root/one']){
    const first=suggestBranchId(name,[],'12345678-abcd');
    assert.match(first,format);assert.equal(first,suggestBranchId(name,[],'12345678-abcd'));
    assert.notEqual(suggestBranchId(name,[first],'12345678-abcd'),first);
  }
  assert.equal(suggestBranchId('Night Garden',['night-garden','night-garden-2'],'seed'),'night-garden-3');
  assert.equal(suggestBranchId('夜间花园',[],'12345678-abcd'),'branch-12345678');
  assert.equal(suggestBranchId('Été',[],'seed'),'ete');
});

test('modal validates before submitting, expands invalid advanced controls and permits retry after correction',async()=>{
  const f=modalFixture(),details=node(f.document);let calls=0,valid=false;
  const input=node(f.document,{dataset:{autofocus:'',validationMessage:'请输入名称'},checkValidity:()=>valid,closest:()=>details});f.controls.push(input);
  f.open('Create','',[{label:'创建',primary:true,action:()=>{calls++;}}]);await f.primary().click();
  assert.equal(calls,0);assert.equal(f.document.activeElement,input);assert.equal(details.attributes.open,'');
  assert.equal(input.attributes['aria-invalid'],'true');assert.equal(f.nodes.get('#modalError').textContent,'请输入名称');
  valid=true;f.body.oninput({target:input});await f.primary().click();
  assert.equal(calls,1);assert.equal(input.attributes['aria-invalid'],undefined);
});

test('modal Enter submits once, ignores IME and textarea, and blocks repeated action while pending',async()=>{
  const f=modalFixture(),wait=deferred();let calls=0,prevented=0;
  const input=node(f.document,{matches:()=>true});
  f.open('Create','',[{label:'创建',primary:true,action:()=>{calls++;return wait.promise;}}]);
  f.body.onkeydown({key:'Enter',isComposing:true,target:input});
  f.body.onkeydown({key:'Enter',target:node(f.document)});assert.equal(calls,0);
  f.body.onkeydown({key:'Enter',target:input,preventDefault(){prevented++;}});const button=f.primary();
  await button.onclick({currentTarget:button,target:button});assert.equal(calls,1);assert.equal(prevented,1);
  assert.equal(f.dialog.attributes['aria-busy'],'true');wait.resolve();await button.lastJob;
  assert.equal(button.disabled,false);assert.equal(button.textContent,'创建');assert.equal(f.dialog.attributes['aria-busy'],undefined);
});

test('old modal failures and finalizers cannot write into or unlock a newer pending modal',async()=>{
  const f=modalFixture(),old=deferred(),current=deferred();
  const first=f.open('Old','',[{label:'旧操作',primary:true,action:()=>old.promise}]);const oldJob=f.primary().click();
  f.close();const second=f.open('New','',[{label:'新操作',primary:true,action:()=>current.promise}]);const currentJob=f.primary().click();
  old.reject(new Error('old failure'));await oldJob;
  assert.equal(first(),false);assert.equal(second(),true);assert.equal(f.nodes.get('#modalError').textContent,'');
  assert.equal(f.primary().disabled,true);assert.equal(f.dialog.attributes['aria-busy'],'true');
  current.reject(new Error('current failure'));await currentJob;
  assert.equal(f.nodes.get('#modalError').textContent,'current failure');assert.equal(f.primary().disabled,false);
});

test('modal redraw preserves the external trigger and overflow launches restore the visible menu button',()=>{
  const f=modalFixture();
  f.open('Gallery one','',[]);const inner=node(f.document);f.document.activeElement=inner;
  f.open('Gallery two','',[]);inner.isConnected=false;f.close();assert.equal(f.document.activeElement,f.trigger);
  const hiddenMenuAction=node(f.document,{hidden:true,closest:selector=>selector==='.topbar-popover'?{}:null});
  f.document.activeElement=hiddenMenuAction;f.open('Overflow dialog','',[]);f.close();assert.equal(f.document.activeElement,f.trigger);
});

test('dialogs opened from collapsing details return to the visible summary, or a connected fallback',()=>{
  for(const selector of ['.workspace-disclosure','#chatSettings','.composer-help','.semantic-quick-actions','.prefab-card-menu']){
    const f=modalFixture(),summary=node(f.document),details={querySelector:()=>summary};
    f.document.activeElement=node(f.document,{closest:value=>value.split(',').includes(selector)?details:null});
    f.open('Attachment','',[]);f.close();assert.equal(f.document.activeElement,summary,selector);
    const fallback=node(f.document);f.nodes.set('#agentsMenuButton',fallback);summary.isConnected=false;
    f.close();assert.equal(f.document.activeElement,fallback);
  }
});

function responseFixture(kind){
  const f=workflowFixture();Object.assign(f.context,{selectedSessionId:'s1',sessionLoadGeneration:1,sessionData:{id:'s1',title:'Session'},sessionEvents:[],
    ownSession:()=>true,sessionRoute:id=>'sessions/'+id,renderComposer:()=>f.navigation.push('render'),inbox:{invalidate:()=>f.navigation.push('invalidate')},
    renderMarkdown:String,openChat:()=>f.navigation.push('chat'),semanticComposerContext:()=>({sessionId:'s1',sessionGeneration:1}),
    addSemanticReference:async(...args)=>{f.calls.push({reference:plain(args)});return f.wait.promise;}});
  vm.runInContext(section('function showRequest(','function elicitationDescriptor(')+section('function showKnowledgeItem(','// END SEMANTIC AUTHORING HOST'),f.context);
  if(kind==='request')f.context.showRequest({request_key:'request-1',method:'item/commandExecution/requestApproval',params:{command:'bounded fake action'}});
  else f.context.showKnowledgeItem({id:'knowledge-1',title:'Knowledge'},'fixed-a',{project_id:'game-a',branch_id:'main'});
  return f;
}

test('request and knowledge completions update only their initiating modal, account, branch and session',async()=>{
  for(const kind of ['request','knowledge'])for(const change of ['none','dialog','user','project','session']){
    const f=responseFixture(kind),job=f.submit();assert.equal(f.calls.length,1);
    if(change==='dialog')f.replace();if(change==='user')f.context.user={id:'other'};
    if(change==='project')f.context.project={id:'other'};if(change==='session')f.context.selectedSessionId='s2';
    const current=f.current();f.wait.resolve({});await job;
    if(change==='none'){
      assert.equal(f.current(),null);assert.deepEqual(f.navigation,kind==='request'?['invalidate','render']:['chat']);
      if(kind==='request')assert.deepEqual(plain(f.context.sessionEvents),[{kind:'serverRequestReply',requestKey:'request-1'}]);
    }else{assert.equal(f.current(),current);assert.deepEqual(f.navigation,[]);assert.deepEqual(plain(f.context.sessionEvents),[]);}
  }
});

test('request and knowledge completions cannot affect a newer visit to the same session',async()=>{
  for(const kind of ['request','knowledge']){
    const f=responseFixture(kind),job=f.submit(),current=f.current();f.context.sessionLoadGeneration++;
    f.wait.resolve({});await job;assert.equal(f.current(),current,kind);assert.deepEqual(f.navigation,[],kind);assert.deepEqual(plain(f.context.sessionEvents),[],kind);
  }
});

test('prefab test scene completion does not close a replacement dialog or reopen a changed subject',async()=>{
  for(const change of ['none','dialog','subject','project']){
    const f=workflowFixture(),subject={id:'prefab-a',name:'Box'};
    Object.assign(f.context,{prefabLabSubject:subject.id,branch:{branch_id:'main',head:'fixed-a',manifest:{resources:{'prefab-a':{...subject,kind:'prefab'}}}},
      prefabLabContext:()=>({projectId:'game-a',branchId:'main',revision:'fixed-a'}),
      openPrefabLab:async(...args)=>f.navigation.push({lab:args}),requestPrefabLabAgent:()=>{throw Error('unexpected Agent request');}});
    vm.runInContext(section('async function createPrefabLabScene(','async function requestPrefabLabAgent('),f.context);
    await f.context.createPrefabLabScene({subject});f.get('#prefabTestName').value='Test Box';const job=f.submit();
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.body.base_revision,'fixed-a');
    if(change==='dialog')f.replace();if(change==='subject')f.context.prefabLabSubject='other';if(change==='project')f.context.project={id:'other'};
    const current=f.current();f.wait.resolve({branch:{head:'fixed-b'},resource_id:'test-box'});await job;
    if(change==='none'){assert.equal(f.current(),null);assert.deepEqual(plain(f.navigation),[{accepted:{head:'fixed-b'}},{lab:['prefab-a','test-box']}]);}
    else{assert.equal(f.current(),current);assert.deepEqual(f.navigation,[]);}
  }
});

function sharedFixture(){
  const f=workflowFixture(),initial=deferred(),polls=[],timers=[],cleared=[],status={can_publish:true,source_revision:'fixed-a'};
  Object.assign(f.context,{branch:{},doc:()=>({kind:'scene'}),setInterval:callback=>{timers.push(callback);return timers.length;},clearInterval:id=>cleared.push(id),
    joinSharedWorld:()=>{throw Error('runtime must not start');},toast:message=>f.navigation.push({toast:message})});
  let reads=0;f.context.api.api=async(path,options)=>{
    f.calls.push({path,options});if(options?.method==='POST')return f.wait.promise;
    if(++reads===1)return initial.promise;
    const request=deferred();polls.push(request);return request.promise;
  };
  vm.runInContext(section('async function openSharedWorld(){','async function joinSharedWorld('),f.context);
  return{...f,initial,polls,timers,cleared,status,start:()=>f.context.openSharedWorld(),publish:()=>f.current().buttons.find(button=>button.label==='启动共享世界').action()};
}

test('shared status initial reads cannot replace a newer dialog or follow a changed owner or document',async()=>{
  for(const change of ['dialog','user','document']){
    const f=sharedFixture(),job=f.start();if(change==='dialog')f.replace();if(change==='user')f.context.user={id:'other'};if(change==='document')f.context.key=()=> 'changed';
    const current=f.current();f.initial.resolve(f.status);await job;assert.equal(f.current(),current);assert.equal(f.calls.length,1);
  }
});

test('shared progress renders only its current view and a late publish cannot reopen a replacement dialog',async()=>{
  const f=sharedFixture(),opening=f.start();f.initial.resolve(f.status);await opening;const publishing=f.publish();
  assert.equal(f.calls[1].options.body.revision,'fixed-a');assert.equal(f.calls[1].options.body.expected_world_version,null);
  const polling=f.timers[0]();f.polls[0].resolve({operation:{stage:'正在准备固定资源'}});await polling;
  assert.equal(f.get('#modalError').textContent,'正在准备固定资源');
  const stale=f.timers[0]();f.replace();f.get('#modalError').textContent='New dialog';f.polls[1].resolve({operation:{stage:'Old progress'}});await stale;
  f.wait.resolve({delivery:{revision:'fixed-a'}});await publishing;
  assert.equal(f.get('#modalError').textContent,'New dialog');assert.equal(f.current().title,'Replacement');assert.deepEqual(f.navigation,[]);assert.deepEqual(f.cleared,[1]);
});

test('prefab menu placement closes the menu and blocks double submission without restoring revoked edit access',async()=>{
  const wait=deferred(),menu={open:true},button={disabled:false,isConnected:true,dataset:{instancePrefab:'box'},closest:()=>menu};let calls=0,write=true;
  const context=vm.createContext({host:{querySelectorAll:()=>[button]},instantiateHierarchyPrefab:async id=>{assert.equal(id,'box');calls++;await wait.promise;},editable:()=>write,report:error=>{throw error;}});
  const line=source.split('\n').find(line=>line.includes("host.querySelectorAll('[data-instance-prefab]').forEach"));assert.ok(line);vm.runInContext(line,context);
  const first=button.onclick();await button.onclick();assert.equal(calls,1);assert.equal(menu.open,false);assert.equal(button.disabled,true);
  write=false;wait.resolve();await first;assert.equal(button.disabled,true);
});

function workflowFixture(){
  const document={activeElement:null},nodes=new Map(),calls=[],navigation=[],wait=deferred();let generation=0,current=null;
  const project={id:'game-a',name:'花园',role:'owner',branches:[{branch_id:'main',name:'主干',head:'fixed-a'}]};
  const get=selector=>{if(!nodes.has(selector))nodes.set(selector,node(document,{closest:()=>node(document)}));return nodes.get(selector);};
  for(const [id,value]of Object.entries({newBranchSource:'main',newBranchName:'Night Garden',newBranchId:'',gameName:'新游戏',resourceKind:'scene',resourceName:'新场景',nativeResourceType:'Node3D'}))get('#'+id).value=value;
  get('#modalBody [name="gameTemplateChoice"]:checked').value='empty';
  const context=vm.createContext({document,$:get,user:{id:'owner',name:'Owner'},project,branch:null,canCreateGame:true,
    canWrite:()=>['owner','editor'].includes(context.project?.role),editable:()=>true,isNative:()=>true,
    context:()=>({schema:'creation-native-1',projectId:'game-a',branchId:'main',resourceId:'scene',key:'game-a/main/scene',base:'fixed-a',manifest:{resources:{scene:{version:'fixed-document'}}}}),
    assertCurrentEdit(){},branchKey:()=>context.project?.id+'/main',key:()=>context.project?.id+'/main/scene',explorerTab:'scene',
    copy:structuredClone,object:()=>null,nativeParentTarget:()=>null,isHierarchy:()=>false,
    doc:()=>({kind:'prefab',id:'prefab-a',objects:[]}),newNodeOperation:(value,ctx,parent)=>({value,parent}),
    loadHierarchyDocument:async()=>navigation.push({reload:true}),docObjects:()=>[],selectObject:id=>navigation.push({select:id}),renderAll:()=>navigation.push({render:true}),
    branchRoute:(projectId,branchId)=>`projects/${projectId}/branches/${branchId}`,acceptBranch:branch=>navigation.push({accepted:branch}),
    URL,location:{href:'http://example.invalid/creation-workspace.html?invite=code#/games'},window:{history:{replaceState:(...args)=>calls.push({replaceState:args})}},
    refreshPermissions:async()=>calls.push({refreshPermissions:true}),
    nativeCreateResourceOperation:(id,kind,name,type)=>({type:'create_native_resource',id,kind,name,native_type:type}),
    newResourceOperation(){throw Error('unexpected legacy operation');},
    transact:async(ops,options)=>{calls.push({ops,options});return wait.promise;},
    openResource:async id=>navigation.push({resourceId:id}),
    uuid:()=> '12345678-abcd',suggestBranchId,esc:String,short:String,
    toast(){},api:{api:async(path,options)=>{calls.push({path,options});return wait.promise;}},
    refreshCatalog:async()=>{calls.push({refresh:true});},
    navigateCatalog:async target=>navigation.push(plain(target)),
    modalGeneration:0,
    modal:(title,html,buttons)=>{const id=++generation;context.modalGeneration=generation;current={title,html,buttons,id};return()=>current?.id===id;},
    closeModal:()=>{context.modalGeneration=++generation;current=null;}});
  vm.runInContext(section('function newGame(){','function invite(){')+section('function createResource(){','function placePrefab(){')
    +section('function nativeParentTarget(){','async function createAnchor(){')+section('function placePrefab(){','function migrateHierarchy(){')
    +section("function joinInvite(code=''){",'async function loadSessions(){')+section('function mergeBranch(){','async function reconcileRun('),context);
  return {context,get,calls,navigation,wait,project,current:()=>current,
    submit:()=>current.buttons.find(button=>button.primary).action(),
    replace:()=>context.modal('Replacement','',[])};
}

test('create branch keeps fixed source, navigates the captured project and preserves explicit IDs',async()=>{
  const f=workflowFixture();f.context.newBranch('main');
  assert.equal(f.get('#newBranchId').value,'night-garden');
  f.get('#newBranchId').value='custom.branch';f.get('#newBranchId').oninput();f.get('#newBranchName').value='New name';f.get('#newBranchName').oninput();
  assert.equal(f.get('#newBranchId').value,'custom.branch');
  const job=f.submit();assert.deepEqual(plain(f.calls[0]),{path:'projects/game-a/branches',options:{method:'POST',body:{from_branch:'main',expected_head:'fixed-a',branch_id:'custom.branch',name:'New name'}}});
  f.wait.resolve({branch_id:'custom.branch',name:'New name',head:'fixed-b'});await job;
  assert.deepEqual(f.navigation,[{projectId:'game-a',branchId:'custom.branch'}]);assert.equal(f.project.branches.length,2);
});

test('create branch does not navigate or close a replacement dialog after close, project change or account change',async()=>{
  for(const change of ['dialog','project','user']){
    const f=workflowFixture();f.context.newBranch();const job=f.submit();
    if(change==='dialog')f.replace();if(change==='project')f.context.project={id:'game-b',role:'owner',branches:[]};if(change==='user')f.context.user={id:'other'};
    const remaining=f.current();f.wait.resolve({branch_id:'night-garden',head:'fixed-b'});await job;
    assert.deepEqual(f.navigation,[],change);assert.equal(f.current(),remaining,change);assert.equal(f.project.branches.length,1,change);
  }
});

test('create branch rejects forbidden, duplicate and malformed IDs before a request',async()=>{
  for(const value of ['main','bad space','-bad','中','a'.repeat(97)]){
    const f=workflowFixture();f.context.newBranch();f.get('#newBranchId').value=value;
    await assert.rejects(f.submit());assert.deepEqual(f.calls,[],value);
  }
  const f=workflowFixture();f.context.newBranch();f.context.project.role='viewer';await assert.rejects(f.submit());assert.deepEqual(f.calls,[]);
});

test('create game refreshes the catalog without bootstrapping and never closes a newer dialog',async()=>{
  const f=workflowFixture();f.context.newGame();const job=f.submit();
  assert.deepEqual(plain(f.calls[0]),{path:'projects',options:{method:'POST',body:{name:'新游戏',template:'empty'}}});
  f.wait.resolve({project:{id:'created-game'},branch:{branch_id:'main'}});await job;
  assert.deepEqual(f.calls.slice(1),[{refresh:true}]);assert.deepEqual(f.navigation,[{projectId:'created-game',branchId:'main'}]);
  const stale=workflowFixture();stale.context.newGame();const old=stale.submit();stale.replace();const remaining=stale.current();
  stale.wait.resolve({project:{id:'old-game'},branch:{branch_id:'main'}});await old;
  assert.equal(stale.current(),remaining);assert.deepEqual(stale.navigation,[]);assert.equal(stale.calls.length,1);
});

test('create resource does not close a newer modal or open its document when the source write returns late',async()=>{
  const f=workflowFixture();f.context.createResource();const job=f.submit();f.replace();const remaining=f.current();
  f.wait.resolve({});await job;assert.equal(f.current(),remaining);assert.deepEqual(f.navigation,[]);
  assert.equal(f.calls[0].ops[0].type,'create_native_resource');assert.equal(f.calls[0].options.ctx.base,'fixed-a');
});

test('branch cards expose read-only entries and hide edit actions for non-writers',()=>{
  for(const role of ['owner','editor','viewer','player']){
    const host={innerHTML:'',insertAdjacentHTML(position,html){this.innerHTML+=html;},querySelectorAll:()=>[]};
    const project={id:'a',role,branches:[{branch_id:'main',name:'主干',head:'revision',presentation:{images:[]}}]};
    const nodes={'#branchSearch':{value:''},'#branchCount':{},'#branchCards':host};
    GameCatalog.prototype.renderBranches.call({getState:()=>({project}),$:s=>nodes[s],visits:()=>[],esc:String,icon:()=>'',placeholder:()=>'',hydrate(){}});
    if(['owner','editor'].includes(role)){assert.match(host.innerHTML,/进入创作/);assert.match(host.innerHTML,/data-fork=/);}
    else{assert.match(host.innerHTML,/只读浏览与试玩/);assert.doesNotMatch(host.innerHTML,/data-fork=|data-branch-media=|进入创作/);}
  }
});

test('project management capability hides both the status filter and owner actions',()=>{
  for(const management of [true,false])for(const role of ['owner','editor','viewer']){
    const document={},nodes=new Map(),project={id:'a',name:'Garden',role,members:[],created_at:1,branches:[{branch_id:'main',name:'主干',head:'revision',presentation:{images:[]}}]};
    const get=selector=>{if(!nodes.has(selector))nodes.set(selector,node(document,{querySelectorAll:()=>[],addEventListener(){}}));return nodes.get(selector);};
    const catalog={owner:'user',preferences:{},getState:()=>({user:{id:'user'},projects:[project],project,catalogPage:'game',projectManagementAvailable:management}),$:get,
      savePreference(){},renderGames(){},renderRecent(){},renderBranches(){},hydrate(){},visits:()=>[],placeholder:()=>'',esc:String,icon:()=>''};
    GameCatalog.prototype.render.call(catalog);
    assert.equal(get('#gameStatus').hidden,!management);
    for(const id of ['renameProject','archiveProject'])assert.equal(get('#'+id).hidden,role!=='owner'||!management,`${role}/${management}/${id}`);
  }
});

test('object creation and prefab placement keep replacement dialogs open when the write completes late',async()=>{
  for(const type of ['node','prefab']){
    const f=workflowFixture();
    if(type==='node'){
      f.get('#nativeNodeName').value='树';f.get('#nativeNodeType').value='Node3D';f.context.createNativeNode();
    }else{
      f.context.branch={manifest:{resources:{scene:{id:'scene',kind:'scene',name:'Garden'}}}};
      f.get('#placementScene').value='scene';f.context.instantiateHierarchyPrefab=async(...args)=>{f.calls.push({instantiate:args});return f.wait.promise;};f.context.placePrefab();
    }
    const job=f.submit();f.replace();const remaining=f.current();f.wait.resolve({});await job;
    assert.equal(f.calls.length,1,type);assert.equal(f.current(),remaining,type);assert.deepEqual(f.navigation,[],type);
  }
});

test('native and legacy imports stop before the source transaction if their upload returns to a replaced dialog',async()=>{
  for(const native of [true,false]){
    const f=workflowFixture();f.context.isNative=()=>native;
    f.get('#modelFile').files=[{name:'tree.glb',size:128}];f.context.importModel();const job=f.submit();f.replace();const remaining=f.current();
    f.wait.resolve({hash:'uploaded-asset'});await job;
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'projects/game-a/assets');assert.equal(f.current(),remaining);assert.deepEqual(f.navigation,[]);
  }
});

test('native import keeps fixed document and parent identity, then ignores stale source commit completion',async()=>{
  const f=workflowFixture(),write=deferred(),started=deferred(),parent={path:'Root',instance_path:[]};
  f.context.object=()=>({name:'Parent',native_target:parent});f.get('#modelFile').files=[{name:'tree.glb',size:128}];
  f.context.transact=async(ops,options)=>{f.calls.push({ops,options});started.resolve();return write.promise;};
  f.context.importNativeModel();const job=f.submit();f.wait.resolve({hash:'uploaded-asset'});await started.promise;
  assert.equal(f.calls[1].ops[0].expected_version,'fixed-document');assert.equal(f.calls[1].ops[0].asset_hash,'uploaded-asset');assert.deepEqual(f.calls[1].ops[0].parent,parent);
  f.replace();const remaining=f.current();write.resolve({});await job;
  assert.equal(f.current(),remaining);assert.deepEqual(f.navigation,[]);
});

test('an edit context rejected after upload cannot enter the native source transaction',async()=>{
  const f=workflowFixture();let checks=0;
  f.context.assertCurrentEdit=()=>{if(++checks===2)throw Error('source or permission changed');};
  f.get('#modelFile').files=[{name:'tree.glb',size:128}];f.context.importNativeModel();const job=f.submit();f.wait.resolve({hash:'uploaded-asset'});
  await assert.rejects(job,/source or permission changed/);assert.equal(checks,2);assert.equal(f.calls.length,1);assert.deepEqual(f.navigation,[]);
});

test('joining waits for permission refresh, then closes and navigates only its current dialog and account',async()=>{
  for(const change of ['none','dialog','user']){
    const f=workflowFixture(),refresh=deferred(),started=deferred();f.get('#inviteCode').value='code';
    f.context.refreshPermissions=async()=>{f.calls.push({refreshPermissions:true});started.resolve();await refresh.promise;};
    f.context.joinInvite('code');const original=f.current(),job=f.submit();f.wait.resolve({id:'joined-game',name:'Joined',role:'editor'});
    await started.promise;assert.equal(f.current(),original);assert.deepEqual(f.navigation,[]);
    if(change==='dialog')f.replace();if(change==='user')f.context.user={id:'other'};const remaining=f.current();
    refresh.resolve();await job;
    if(change==='none'){assert.equal(f.current(),null);assert.deepEqual(f.navigation,[{projectId:'joined-game'}]);assert.equal(f.calls.filter(c=>c.replaceState).length,1);}
    else{assert.equal(f.current(),remaining);assert.deepEqual(f.navigation,[]);assert.equal(f.calls.filter(c=>c.replaceState).length,0);}
  }
});

test('late invitation acceptance cannot refresh, alter the URL or close a replacement dialog',async()=>{
  const f=workflowFixture();f.get('#inviteCode').value='code';f.context.joinInvite('code');const job=f.submit();f.replace();const remaining=f.current();
  f.wait.resolve({id:'joined-game',name:'Joined',role:'editor'});await job;
  assert.equal(f.current(),remaining);assert.equal(f.calls.length,1);assert.deepEqual(f.navigation,[]);
});

test('merge preview cannot replace a later dialog or follow a changed document',async()=>{
  for(const change of ['dialog','document']){
    const f=workflowFixture();f.context.branch={branch_id:'main'};f.project.branches.push({branch_id:'side',name:'Side',head:'side-head'});f.get('#mergeSource').value='side';
    f.context.mergeBranch();const job=f.submit();if(change==='dialog')f.replace();else f.context.key=()=> 'game-a/main/other-scene';const remaining=f.current();
    f.wait.resolve({id:'preview',changes:[],conflicts:[],source_revision:'side-head',target_revision:'fixed-a'});await job;
    assert.equal(f.current(),remaining);assert.equal(f.calls.length,1);assert.deepEqual(f.navigation,[]);
  }
});

test('merge keeps explicit conflict resolutions and a late completion cannot close a newer dialog',async()=>{
  const f=workflowFixture(),preview={id:'preview',changes:[{key:'resource/node',conflict:true,source:1,target:2,base:0}],conflicts:[{}],source_revision:'side-head',target_revision:'fixed-a'};
  f.get('[data-resolution="0"]').value='target';f.context.showMergePreview(f.context.context(),'side',preview);const job=f.submit();
  assert.deepEqual(plain(f.calls[0]),{path:'projects/game-a/branches/main/merge',options:{method:'POST',body:{preview_id:'preview',resolutions:{'resource/node':'target'}}}});
  f.replace();const remaining=f.current();f.wait.resolve({branch:{head:'merged'}});await job;
  assert.equal(f.current(),remaining);assert.deepEqual(f.navigation,[]);
});

test('a late source-conflict refresh retains the pending edit without replacing a newer dialog',async()=>{
  const f=workflowFixture(),read=deferred(),readStarted=deferred(),conflict=Object.assign(new Error('source conflict'),{status:409,details:{current:{version:'newer'}}});
  f.context.pendingEdits=new Map();f.context.errorText=error=>error.message;f.context.report=()=>{};
  f.context.api.api=async(path,options)=>{
    f.calls.push({path,options});if(options?.method==='POST')return f.wait.promise;readStarted.resolve();return read.promise;
  };
  vm.runInContext(section('async function transact(','async function patchObject('),f.context);
  f.context.createResource();const job=f.submit(),rejected=assert.rejects(job,/source conflict/);
  f.wait.reject(conflict);await readStarted.promise;f.replace();const remaining=f.current();read.resolve({head:'newer'});await rejected;
  assert.equal(f.context.pendingEdits.size,1);assert.equal(f.current(),remaining);assert.deepEqual(f.navigation,[]);
});

test('source conflicts open in the initiating context, but remain recorded after account or document changes',async()=>{
  for(const change of ['none','user','document']){
    const f=workflowFixture(),read=deferred(),started=deferred(),conflict=Object.assign(new Error('source conflict'),{status:409});let reports=0;
    f.context.pendingEdits=new Map();f.context.errorText=error=>error.message;f.context.report=()=>reports++;
    f.context.api.api=async(path,options)=>{if(options?.method==='POST')return f.wait.promise;started.resolve();return read.promise;};
    vm.runInContext(section('async function transact(','async function patchObject('),f.context);
    f.context.createResource();const remaining=f.current(),rejected=assert.rejects(f.submit(),/source conflict/);f.wait.reject(conflict);await started.promise;
    if(change==='user')f.context.user={id:'other'};if(change==='document')f.context.key=()=> 'game-a/main/other-scene';
    read.resolve({head:'newer'});await rejected;
    assert.equal(f.context.pendingEdits.size,1);assert.equal(reports,1);
    if(change==='none')assert.match(f.current().title,/修改冲突/);else assert.equal(f.current(),remaining,change);
  }
});
