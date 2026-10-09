import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {PlayControls} from '../../../apps/creation-workspace/preview-bridge.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const options=Object.fromEntries(process.argv.slice(2).filter(v=>v.startsWith('--')).map(v=>{const i=v.indexOf('=');return[v.slice(2,i),v.slice(i+1)];}));
const checks=[],intents=[];
function check(ok,detail){checks.push({ok:Boolean(ok),detail});if(!ok)throw Error(detail);}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
class Button extends EventTarget{constructor(control){super();this.dataset={playControl:control};this.attributes={};}setAttribute(k,v){this.attributes[k]=v;}setPointerCapture(){}}
const buttons=['forward','left','right','backward','jump','interact','stop'].map(v=>new Button(v));
const host=new EventTarget();host.querySelectorAll=()=>buttons;host.open=true;
globalThis.window=new EventTarget();globalThis.document=new EventTarget();document.hidden=false;
const controls=new PlayControls(host,intent=>intents.push(intent));
const button=id=>buttons.find(v=>v.dataset.playControl===id);
const event=(target,type,values={})=>{const e=new Event(type);Object.assign(e,values);target.dispatchEvent(e);};
const pointer=(id,type,pointerId=1)=>event(button(id),type,{button:0,pointerId});
let failure='';
try{
 event(button('forward'),'click');check(!intents.length,'disabled controls reject click intent');
 controls.setEnabled(true);pointer('forward','pointerdown');pointer('forward','pointerup');event(button('forward'),'click');
 check(intents.at(-1).kind==='tap'&&intents.at(-1).control==='forward','short pointer click becomes bounded tap intent');
 const before=intents.length;await delay(210);check(intents.length===before,'short click cancels delayed hold timer');
 pointer('right','pointerdown');await delay(310);check(intents.filter(v=>v.kind==='start'&&v.control==='right').length>=2,'holding emits renewable start intents');
 pointer('right','pointerup');const count=intents.length;event(button('right'),'click');await delay(120);
 check(intents.length===count&&intents.at(-1).kind==='end','hold release ends immediately and does not add a click step');
 event(button('jump'),'click');event(button('interact'),'click');
 check(intents.at(-2).control==='jump'&&intents.at(-1).control==='interact','keyboard/native click can request jump and interact without pointer holding');
 pointer('left','pointerdown');await delay(190);event(window,'blur');const blurs=intents.length;await delay(130);
 check(intents.at(-1).control==='stop'&&intents.length===blurs&&!controls.press,'window blur stops movement and cancels lease renewal');
 pointer('left','pointerdown');await delay(190);controls.setEnabled(false);const disabled=intents.length;event(button('left'),'click');await delay(120);
 check(intents.length===disabled&&buttons.every(v=>v.disabled),'mode disable emits stop, disables all buttons and prevents further input');
 controls.setEnabled(true);event(button('forward'),'click');host.open=false;event(host,'toggle');
 check(intents.at(-1).control==='stop','collapsing controls cancels pending movement');
 const source=await readFile(resolve(root,'apps/creation-workspace/workspace.js'),'utf8');
 const names=['latestRun','cleanupBlocked','cleanupLabel','runBusy'];
 const functions=names.map(name=>{const match=source.match(new RegExp(`^function ${name}\\(.*$`,'m'));if(!match)throw Error('missing function '+name);return match[0];}).join('\n');
 const context=vm.createContext({sessionData:{runs:[]}});vm.runInContext(functions,context);
 for(const status of ['pending','uncertain']){
  context.sessionData.runs=[{id:'earlier',created_at:1,status:'interrupted',cleanup_status:status},{id:'newer',created_at:2,status:'completed'}];
  check(vm.runInContext('runBusy()',context)===true,`${status}: any uncleared prior run blocks new send despite terminal status`);
  check(vm.runInContext('cleanupLabel()',context)===(status==='pending'?'正在停止后台命令':'停止结果待核对'),`${status}: user sees specific cleanup state`);
 }
 context.sessionData.runs=[{id:'verified',created_at:1,status:'interrupted',cleanup_status:'verified'}];
 check(vm.runInContext('runBusy()',context)===false&&vm.runInContext('cleanupLabel()',context)==='','verified cleanup restores normal sending eligibility');
 check(source.includes("$$('[data-action=\"reconcile\"]').forEach(button=>button.disabled=!own)"),'owned session reconciliation remains enabled while send is blocked');
 const formSource=source.slice(source.indexOf('function showRequest(request)'),source.indexOf('function modelRecord('));
 const replies=[],elements=new Map();let dialog;
 const formContext=vm.createContext({sessionData:{title:'Fixture'},selectedSessionId:'fixture-session',ownSession:()=>true,sessionEvents:[],sessionRoute:id=>'sessions/'+id,api:{api:async(path,packet)=>replies.push({path,...packet.body})},modal:(title,html,choices)=>dialog={title,html,choices},closeModal:()=>{},renderComposer:()=>{},$:(selector)=>elements.get(selector)});
 vm.runInContext(source.match(/^const esc=.*$/m)[0]+'\n'+formSource,formContext);
 formContext.request={method:'mcpServer/elicitation/request',request_key:'fixture-request',params:{mode:'form',serverName:'<img src=x>',message:'Fixture permission',requestedSchema:{type:'object',properties:{}}}};
 vm.runInContext('showRequest(request)',formContext);
 check(dialog.choices.some(v=>v.label==='允许本次')&&dialog.choices.some(v=>v.label==='拒绝请求')&&!dialog.html.includes('<img src=x>'),'historical empty MCP form exposes real decisions and escapes server text');
 await dialog.choices.find(v=>v.label==='允许本次').action();
 check(JSON.stringify(replies.at(-1).result)==='{"action":"accept","content":{},"_meta":null}','MCP empty form acceptance uses the exact structured response shape');
 await dialog.choices.find(v=>v.label==='拒绝请求').action();
 check(replies.at(-1).result.action==='decline'&&replies.at(-1).result.content===null,'MCP decline remains available without form content');
 formContext.request.elicitation={supported:false,reason:'Unknown nested schema',fields:[]};vm.runInContext('showRequest(request)',formContext);
 check(!dialog.choices.some(v=>v.label==='允许本次')&&dialog.choices.some(v=>v.label==='取消请求'),'unsupported MCP schema cannot be accepted but remains cancelable');
 const fields=[{name:'flag',type:'boolean',required:true},{name:'amount',type:'number'},{name:'choice',type:'enum',options:[{value:'safe',label:'Safe'}]},{name:'tags',type:'enum-array',options:[{value:'a',label:'A'},{value:'b',label:'B'}],minItems:1}];
 ['false','1.25','0',''].forEach((value,i)=>elements.set(`[data-elicitation-field="${i}"]`,{value,checkValidity:()=>true,selectedOptions:i===3?[{value:'1'}]:[]}));
 formContext.fields=fields;
 check(JSON.stringify(vm.runInContext('elicitationValues(fields)',formContext))==='{"flag":false,"amount":1.25,"choice":"safe","tags":["b"]}','flat MCP fields preserve typed boolean/number/enum/enum-array values');
 elements.get('[data-elicitation-field="0"]').value='';let requiredRejected=false;try{vm.runInContext('elicitationValues(fields)',formContext);}catch{requiredRejected=true;}
 check(requiredRejected,'required unanswered MCP field cannot be accepted');
 const displayContext=vm.createContext({worldState:{scene_revision:'shown-old'},worldScene:{id:'latest-new'},worldScenes:{get:revision=>({id:revision})}});
 vm.runInContext(source.match(/^function displayedPlayScene\(.*$/m)[0],displayContext);
 check(vm.runInContext('displayedPlayScene().id',displayContext)==='shown-old','Play inspector source resolves actual displayed revision rather than latest server/source head');
 const requestsContext=vm.createContext({sessionEvents:[{kind:'approval_request',request_key:'1:5',params:{threadId:'thread',turnId:null}},{kind:'run_state',run:{status:'completed',thread_id:'thread',turn_id:'some-turn'}},{kind:'notification',method:'serverRequest/resolved',epoch:2,params:{requestId:5,threadId:'thread'}}]});
 vm.runInContext(source.slice(source.indexOf('function pendingApprovals()'),source.indexOf('function renderConversation()')),requestsContext);
 check(vm.runInContext('pendingApprovals().length',requestsContext)===1,'null-turn MCP request survives unrelated terminal and different-epoch resolution');
 requestsContext.sessionEvents.push({kind:'notification',method:'serverRequest/resolved',epoch:1,params:{requestId:5,threadId:'other'}});
 check(vm.runInContext('pendingApprovals().length',requestsContext)===1,'MCP request resolution requires matching thread identity');
 requestsContext.sessionEvents.push({kind:'notification',method:'serverRequest/resolved',epoch:1,params:{requestId:5,threadId:'thread'}});
 check(vm.runInContext('pendingApprovals().length',requestsContext)===0,'exact MCP request resolution clears the matching pending form');
}catch(error){failure=error.stack;checks.push({ok:false,detail:error.message});}
finally{controls.setEnabled(false);clearTimeout(controls.suppressTimer);}
const report={ok:!failure,completed:true,checks,error:failure,scope:'production JS handlers on Node EventTarget fixtures and actual cleanup predicates; not browser DOM/gesture/GPU or transport ACK evidence'};
if(options.report)await writeFile(options.report,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ok:report.ok,checks:checks.length,error:failure}));process.exitCode=failure?1:0;
