/** Independent actual reference functions and extracted question host, explicit DOM/API doubles.
 * No browser, listening port, Codex or Godot. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {referenceToken,referenceParts,referenceIds,expandReferenceText,referenceChip,renderReferenceContent,createReferenceInteractions} from '../../apps/creation-workspace/reference-components.js';
import {unresolvedComposerReferences} from '../../apps/creation-workspace/semantic-composer.js';
import {CreationStore} from '../../services/creation/store.mjs';
const source=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const referenceSource=readFileSync(new URL('../../apps/creation-workspace/reference-components.js',import.meta.url),'utf8');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const attachments=[{id:'left',kind:'object',name:'宝箱',revision:'old',address:{instance_path:['left'],definition_node_id:'core'}},{id:'right',kind:'object',name:'宝箱',revision:'old',address:{instance_path:['right'],definition_node_id:'core'}},{id:'system',kind:'prefab',name:'天气',design:{category:'system',description:'旧天气说明'}},{id:'knowledge',kind:'knowledge',name:'天气',snapshot:{content:'旧天气规则'}}];

test('reference tokens round-trip Unicode text and retain exact UTF-16 replacement offsets',()=>{
 const text='😀把'+referenceToken('left')+'放到'+referenceToken('right')+'。';const parts=referenceParts(text);
 assert.equal(parts.map(p=>p.text).join(''),text);assert.deepEqual(referenceIds(text),['left','right']);for(const p of parts)assert.equal(text.slice(p.start,p.end),p.text);
 for(const id of ['', 'x"] onclick="bad','../scope', 'a'.repeat(181)])assert.throws(()=>referenceToken(id));
});
test('execution expansion preserves the direction of two same-name instances; copy remains human-readable',()=>{
 const first='把'+referenceToken('left')+'移到'+referenceToken('right'),second='把'+referenceToken('right')+'移到'+referenceToken('left');
 assert.equal(expandReferenceText(first,attachments),'把@宝箱移到@宝箱');
 assert.notEqual(expandReferenceText(first,attachments,{includeIdentity:true}),expandReferenceText(second,attachments,{includeIdentity:true}));
 assert.match(expandReferenceText(first,attachments,{includeIdentity:true}),/attachment:left.*attachment:right/);
 assert.equal(expandReferenceText(first,attachments,{includeIdentity:true}),'把[@宝箱](attachment:left)移到[@宝箱](attachment:right)');
});
test('chips distinguish object/system/knowledge identities, escape authored text and leave unknown tokens literal',()=>{
 const a={...attachments[0],name:'<img src=x onerror=alert(1)> "宝箱"'};const chip=referenceChip(a,{remove:true,disabled:true});
 assert.doesNotMatch(chip,/<img\b|onerror="/);assert.match(chip,/&lt;img/);assert.match(chip,/data-open-reference="left"/);assert.match(chip,/disabled/);
 const result=renderReferenceContent(attachments.map(referenceToken).join(' ')+referenceToken('missing'),attachments);
 assert.match(result,/场景对象：宝箱/);assert.match(result,/游戏系统：天气/);assert.match(result,/知识：天气/);assert.match(result,/\[\[ref:missing\]\]/);
 assert.equal((result.match(/data-open-reference=/g)??[]).length,4);
});
test('actual rich-editor keyboard proxy does not turn IME keyCode 229 Enter into a send',()=>{
 let sends=0;const editor={};const begin=referenceSource.indexOf('  const key=e=>{if(e.target!==editor)return;'),end=referenceSource.indexOf('\n  editor.addEventListener',begin);assert.ok(begin>=0&&end>begin);
 const marker="$('#sessionDraft').addEventListener('keydown',",line=source.slice(source.indexOf(marker)+marker.length).split('\n')[0];assert.ok(line.endsWith(');'));
 const state={editor,composing:false,syncSelection(){},win:{KeyboardEvent:class{constructor(type,options){Object.assign(this,{type,keyCode:0,defaultPrevented:false},options);}preventDefault(){this.defaultPrevented=true;}stopPropagation(){}}},
  $:()=>({disabled:false}),sendDraft:()=>{sends++;return Promise.resolve();},report:error=>{throw error;}};
 vm.createContext(state);vm.runInContext('const submitHandler='+line.slice(0,-2)+';',state);
 state.textarea={dispatchEvent:event=>{state.proxy=event;vm.runInContext('submitHandler(proxy)',state);return !event.defaultPrevented;}};
 vm.runInContext(referenceSource.slice(begin,end)+'\nhandle=key;',state);
 state.handle({target:editor,key:'Enter',code:'Enter',keyCode:229,isComposing:false,preventDefault(){}});assert.equal(sends,0,'IME commit must not submit');
});

class NodeDouble{
 constructor(){this.disabled=false;this.hidden=false;this.isConnected=true;this.textContent='';this.dataset={};this.attributes={};this.style={};}
 focus(){this.focused=true;}getBoundingClientRect(){return{top:100,left:20,bottom:130};}setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}
}
function questionsFixture({questions,request}={}){
 questions??=[{id:'first',question:'先做什么？',options:[{label:'玩法 (Recommended)',description:'先验证玩法'},{label:'美术',description:'先做美术'}],isOther:true},{id:'second',question:'说明原因',options:[]}];
 const req={kind:'approval_request',method:'item/tool/requestUserInput',request_key:'r1',params:{questions}};
 const calls=[],forms=[],scroller={scrollHeight:400,scrollTop:0,clientHeight:400,getBoundingClientRect:()=>({top:0})};let renderCount=0;
 const host={html:'',set innerHTML(html){this.html=html;forms.length=0;for(const r of state.pending){
   const form=new NodeDouble();form.dataset.questionRequest=r.request_key;form.submit=new NodeDouble();form.back=new NodeDouble();form.heading=new NodeDouble();form.error=new NodeDouble();
   form.fields=r.params.questions.map(q=>{const field=new NodeDouble();field.dataset.questionId=q.id;field.radios=(q.options??[]).map((o,i)=>Object.assign(new NodeDouble(),{value:String(i)}));
    if(q.isOther&&q.options?.length)field.radios.push(Object.assign(new NodeDouble(),{value:'custom'}));
    field.text=!q.options?.length||q.isOther?Object.assign(new NodeDouble(),{value:''}):null;
    field.querySelectorAll=s=>s==='[type=radio]'?field.radios:[];field.querySelector=s=>s==='[data-question-text]'?field.text:s==='[value=custom]'?field.radios.find(r=>r.value==='custom'):null;return field;
   });
   form.querySelectorAll=s=>s==='fieldset'?form.fields:s==='input,textarea'?form.fields.flatMap(f=>[...f.radios,...(f.text?[f.text]:[])]):[];
   form.querySelector=s=>s==='[type=submit]'?form.submit:s==='.question-back'?form.back:s==='.question-card-heading>span'?form.heading:s==='[role=alert]'?form.error:s.startsWith('fieldset:not')?form.fields.find(f=>!f.hidden)?.radios[0]??form.fields.find(f=>!f.hidden)?.text:null;
   forms.push(form);
 }},get innerHTML(){return this.html;},querySelectorAll:s=>s==='[data-question-request]'?forms:[],querySelector:s=>s==='.question-card'?forms[0]:null};
 const state={sessionData:{id:'s1'},sessionLoadGeneration:1,sessionEvents:[req],pending:[req],questionDrafts:new Map(),questionWrites:new Set(),questionHTMLKey:null,
  $:s=>s==='#sessionQuestions'?host:scroller,ownSession:()=>true,canWrite:()=>true,pendingApprovals:()=>state.pending,esc:escape,icon:()=>'',updateChatScroll(){},sessionRoute:s=>'sessions/'+s,
  api:{api:async(path,body)=>{calls.push({path,body:json(body)});return request?request(path,body):{};}},renderComposer(){renderCount++;},};
 vm.createContext(state);const begin=source.indexOf('function renderQuestions(){'),end=source.indexOf('\nasync function copyChatText',begin);assert.ok(begin>=0&&end>begin);vm.runInContext(source.slice(begin,end),state);vm.runInContext('renderQuestions()',state);
 return{state,host,forms,calls,questions,renderCount:()=>renderCount,submit:()=>forms[0].onsubmit({preventDefault(){}}),draft:()=>state.questionDrafts.get('s1:r1')};
}
test('actual sequential decision host preserves answers on back/next and submits all original IDs once',async()=>{
 const f=questionsFixture(),form=f.forms[0];assert.equal(form.heading.textContent,'1 / 2');assert.equal(form.fields[1].hidden,true);
 form.fields[0].radios[1].onchange();await f.submit();assert.equal(f.calls.length,0);assert.equal(form.heading.textContent,'2 / 2');assert.equal(form.submit.disabled,true);
 form.fields[1].text.value='  先核对视觉  ';form.fields[1].text.oninput();form.back.onclick();assert.equal(f.draft().answers.first.option,1);await f.submit();await f.submit();
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body.body.result.answers,{first:{answers:['美术']},second:{answers:['先核对视觉']}});
});
test('decision text must be nonblank; duplicate submits stay one flight and failed answers can retry',async()=>{
 const wait=deferred(),f=questionsFixture({questions:[{id:'explain',question:'解释',options:[]}],request:()=>wait.promise}),form=f.forms[0];
 form.fields[0].text.value='  ';form.fields[0].text.oninput();await f.submit();assert.equal(f.calls.length,0);
 form.fields[0].text.value='回答';form.fields[0].text.oninput();const pending=f.submit();await f.submit();assert.equal(f.calls.length,1);assert.equal(form.fields[0].text.disabled,true);
 wait.reject(new Error('暂时离线'));await pending;assert.equal(form.fields[0].text.disabled,false);assert.equal(form.submit.disabled,false);assert.equal(f.draft().answers.explain.text,'回答');assert.match(form.error.textContent,/离线/);
});
test('a resolved question cannot be submitted, and late success cannot write into a newer same-session visit',async()=>{
 const wait=deferred(),f=questionsFixture({questions:[{id:'first',question:'继续',options:[{label:'继续'}]}],request:()=>wait.promise});
 f.state.pending=[];await f.submit();assert.equal(f.calls.length,0);f.state.pending=f.state.sessionEvents;
 const pending=f.submit();f.state.sessionLoadGeneration++;wait.resolve({});await pending;assert.equal(f.state.sessionEvents.length,1);assert.equal(f.renderCount(),0);
});
test('answered secret questions remain masked in actual rendered history',()=>{
 const f=questionsFixture({questions:[{id:'secret',question:'密钥',isSecret:true,options:[]}]});f.state.pending=[];f.state.sessionEvents.push({kind:'serverRequestReply',requestKey:'r1',result:{answers:{secret:{answers:['DO_NOT_RENDER_ME']}}}});f.state.questionHTMLKey=null;
 vm.runInContext('renderQuestions()',f.state);assert.doesNotMatch(f.host.innerHTML,/DO_NOT_RENDER_ME/);assert.match(f.host.innerHTML,/••••••/);
});
test('actual knowledge preflight inserts only the captured revision, not older attachments with the same knowledge ID',async()=>{
 const field={value:'参考 $$天气',focus(){},setSelectionRange(){},dispatchEvent(){}};const state={semanticPreparingDraft:false,sessionData:{draft_attachments:[{id:'old',kind:'knowledge',knowledge_id:'knowledge:weather',revision:'source-old'}]},
  $:()=>field,unresolvedComposerReferences,referenceToken,semanticComposerContext:()=>({key:'scope',sessionId:'s',sessionGeneration:1,revision:'source-current',project_id:'p',branch_id:'main',readOnly:false}),updateSendButton(){},Event,
  branchRoute:()=>'/branch',api:{api:async()=>({revision:'source-current',items:[{id:'knowledge:weather',title:'天气'}]})},
  addSemanticReference:async()=>{state.sessionData.draft_attachments.push({id:'new',kind:'knowledge',knowledge_id:'knowledge:weather',revision:'source-current'});},};
 vm.createContext(state);const begin=source.indexOf('async function prepareSemanticDraftForSend(){'),end=source.indexOf('\nfunction sessionReferences()',begin);assert.ok(begin>=0&&end>begin);vm.runInContext(source.slice(begin,end),state);await vm.runInContext('prepareSemanticDraftForSend()',state);
 assert.deepEqual(referenceIds(field.value),['new']);assert.equal(state.sessionData.draft_attachments.length,2,'old immutable attachment retained independently');
});
test('new sessions default to full-access + medium but explicit settings and legacy stored records remain unchanged',t=>{
 const directory=mkdtempSync(resolve(tmpdir(),'atelier-independent-reference-')),store=new CreationStore(resolve(directory,'creation.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const user=store.register({name:'reference tester',password:'isolated-test-password'}).user,p=store.createProject(user,{name:'reference test'},{schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]}}}).project.id;
 const fresh=store.createSession(user,p,'main');assert.equal(fresh.visibility,'shared');assert.equal(fresh.access_mode,'full-access');assert.equal(fresh.effort,'medium');
 const explicit=store.createSession(user,p,'main',{access_mode:'workspace-write',effort:null,visibility:'private'});assert.equal(explicit.visibility,'private');assert.equal(explicit.access_mode,'workspace-write');assert.equal(explicit.effort,null);
 assert.throws(()=>store.createSession(user,p,'main',{visibility:'invalid'}),e=>e.status===400);
 const old={...explicit,id:'legacy-session'};delete old.access_mode;delete old.effort;store.put('creator_session',old);assert.equal(store.sessionView(user,old.id).visibility,'private');assert.equal(store.sessionView(user,old.id).access_mode,undefined);assert.equal(store.sessionView(user,old.id).effort,undefined);
});
