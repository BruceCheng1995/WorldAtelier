/** FAKE protocol/manager boundaries. Does not answer any actual MCP request. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {describeElicitation,validateElicitationResult} from '../../services/creation/elicitation.mjs';
import {CreationAgentRuns} from '../../services/creation/agent-runs.mjs';
const form=(properties={},required=[])=>({mode:'form',threadId:'thread',turnId:'turn',serverName:'fake-mcp',message:'FAKE permission question',requestedSchema:{type:'object',properties,required}});
const accept=content=>({action:'accept',content,_meta:null});
test('FAKE: empty object permission form has explicit accept/decline/cancel with exact nullable response',()=>{
 assert.deepEqual(describeElicitation(form()).actions,['accept','decline','cancel']);assert.deepEqual(validateElicitationResult(form(),accept({})),accept({}));
 for(const action of ['decline','cancel'])assert.deepEqual(validateElicitationResult(form(),{action}),{action,content:null,_meta:null});
 assert.throws(()=>validateElicitationResult(form(),{decision:'accept'}),/action/);assert.throws(()=>validateElicitationResult(form(),accept(null)),/对象/);
});
test('FAKE: standard primitive fields validate without coercion or silently filling defaults',()=>{
 const p=form({name:{type:'string',minLength:2,maxLength:4},count:{type:'integer',minimum:0,maximum:3},size:{type:'number',minimum:.1},enabled:{type:'boolean',default:false}},['name','count']);
 assert.equal(describeElicitation(p).supported,true);assert.deepEqual(validateElicitationResult(p,accept({name:'中文',count:2})).content,{name:'中文',count:2});
 for(const content of [{name:'a',count:2},{name:'okay',count:1.5},{name:'okay',count:'2'},{name:'okay',count:2,enabled:'false'},{name:'okay',count:2,extra:1},{name:'okay'},{name:'okay',count:2,size:NaN}])assert.throws(()=>validateElicitationResult(p,accept(content)));
});
test('FAKE: standard, legacy titled, titled single and both enum array variants normalize options',()=>{
 const p=form({color:{type:'string',enum:['a','b'],enumNames:['甲','乙']},choice:{type:'string',oneOf:[{const:'yes',title:'是'}]},many:{type:'array',items:{type:'string',enum:['a','b']},minItems:1,maxItems:2},manyTitled:{type:'array',items:{anyOf:[{const:'a',title:'甲'}]},default:['a']}},['color','many']);
 const d=describeElicitation(p);assert.equal(d.supported,true);assert.equal(d.fields[0].type,'enum');assert.deepEqual(d.fields[0].options,[{value:'a',label:'甲'},{value:'b',label:'乙'}]);assert.equal(d.fields[2].type,'enum-array');
 assert.equal(validateElicitationResult(p,accept({color:'a',many:['b'],choice:'yes',manyTitled:['a']})).action,'accept');
 for(const v of [{color:'c',many:['a']},{color:'a',many:[]},{color:'a',many:['x']}])assert.throws(()=>validateElicitationResult(p,accept(v)));
});
test('FAKE: supported formats are checked as data; URI parsing never opens a page',()=>{
 const p=form({email:{type:'string',format:'email'},uri:{type:'string',format:'uri'},date:{type:'string',format:'date'},time:{type:'string',format:'date-time'}});
 assert.equal(validateElicitationResult(p,accept({email:'a@example.test',uri:'https://example.test/path',date:'2024-02-29',time:'2024-02-29T12:30:00Z'})).action,'accept');
 for(const content of [{date:'2025-02-29'},{time:'2025-02-29T12:30:00Z'},{time:'2026-01-01'},{uri:'not a URI'},{email:'not-mail'}])assert.throws(()=>validateElicitationResult(p,accept(content)));
});
test('FAKE: unknown schemas/extensions and URL mode reject accept but still permit explicit decline/cancel',()=>{
 const unknown=[form({nested:{type:'object',properties:{}}}),form({code:{type:'string',pattern:'.*'}}),form({pick:{type:'string',enum:['a'],oneOf:[{const:'b',title:'B'}]}}),form({bad:{type:'integer',default:1.5}}),{mode:'url',url:'https://example.test/login',elicitationId:'fake'}, {...form(),mode:'openai/form'}, {...form(),requestedSchema:{type:'object',properties:{},additionalProperties:true}}, {...form(),requestedSchema:JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')}];
 for(const params of unknown){const d=describeElicitation(params);assert.equal(d.supported,false);assert.deepEqual(d.actions,['decline','cancel']);assert.throws(()=>validateElicitationResult(params,accept({})),e=>e.status===422);for(const action of ['decline','cancel'])assert.deepEqual(validateElicitationResult(params,{action,content:null,_meta:null}),{action,content:null,_meta:null});}
 assert.throws(()=>validateElicitationResult(form(),{action:'cancel',content:{x:1},_meta:null}));assert.throws(()=>validateElicitationResult(form(),{action:'accept',content:{},_meta:{execute:'no'}}));
});
function manager(){
 const m=Object.create(CreationAgentRuns.prototype),session={id:'session',executor_thread_id:'thread',owner_user_id:'owner'},sent=[],events=[];
 m.requests=new Map();m.store={sessionFor(user,sid){if(user.id!=='owner'||sid!=='session')throw Error('forbidden');return session;},list(){return[];}};
 m.sessionForThread=t=>t==='thread'?session:null;m.service={sessionEvent:(sid,e)=>events.push(e)};
 m.adapter={threads:new Map([['thread',{loaded:true}]]),pendingRequests:()=>[...m.requests].map(([key])=>({key})),replyRequest:(key,result)=>sent.push({key,result})};
 const add=(key='epoch:7',turnId='turn',params=form())=>m.request({requestKey:key,epoch:'epoch',id:7,category:'input',method:'mcpServer/elicitation/request',params:{...params,turnId}});
 return{m,session,sent,events,add};
}
test('FAKE manager: actual schema result forwarded, descriptor exposed, failed validation keeps request editable',async()=>{
 const f=manager();f.add();assert.equal(f.events[0].elicitation.supported,true);await assert.rejects(f.m.reply({id:'owner'},'session','epoch:7',{result:accept({extra:1})}));assert.equal(f.m.requests.size,1);
 await f.m.reply({id:'owner'},'session','epoch:7',{result:{action:'decline'}});assert.deepEqual(f.sent,[{key:'epoch:7',result:{action:'decline',content:null,_meta:null}}]);assert.equal(f.m.requests.size,0);
});
test('FAKE manager: resolved request is removed only for matching thread and exact transport epoch',async()=>{
 const f=manager();f.add();f.m.event({kind:'notification',epoch:'old',method:'serverRequest/resolved',params:{threadId:'thread',requestId:7}});assert.equal(f.m.requests.size,1);
 f.m.event({kind:'notification',epoch:'epoch',method:'serverRequest/resolved',params:{threadId:'foreign',requestId:7}});assert.equal(f.m.requests.size,1);
 f.m.event({kind:'notification',epoch:'epoch',method:'serverRequest/resolved',params:{threadId:'thread',requestId:7}});assert.equal(f.m.requests.size,0);await assert.rejects(f.m.reply({id:'owner'},'session','epoch:7',{result:{action:'cancel'}}),/失效/);assert.equal(f.sent.length,0);
});
test('FAKE manager: terminal removes exact turn requests, preserves null-turn request until thread unbind',()=>{
 const f=manager();f.add('epoch:7','turn');f.add('epoch:8',null);f.add('epoch:9','other-turn');f.m.finished({threadId:'thread',turn:{id:'turn',status:'completed'}});
 assert.deepEqual([...f.m.requests.keys()],['epoch:8','epoch:9']);f.m.event({kind:'notification',epoch:'epoch',method:'thread/closed',params:{threadId:'thread'}});assert.equal(f.m.requests.size,0);
});
test('FAKE manager: missing actual pending request, thread rebind, and wrong owner cannot answer',async()=>{
 for(const kind of ['pending','binding','owner']){const f=manager();f.add();if(kind==='pending')f.m.adapter.pendingRequests=()=>[];if(kind==='binding')f.session.executor_thread_id='replacement';await assert.rejects(f.m.reply({id:kind==='owner'?'other':'owner'},'session','epoch:7',{result:{action:'accept',content:{},_meta:null}}));assert.equal(f.sent.length,0);}
});
