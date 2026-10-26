/** Real prompt/context projection and persistent-session plumbing with an explicit
 * FAKE App Server transport and synthetic source-index fixtures. No model, Godot,
 * listener, production database, or game-source mutation is used in these tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationAgentRuns} from '../../services/creation/agent-runs.mjs';
import {CodexAgent} from '../../services/creation/codex-agent.mjs';
import {nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {AGENT_PREFAB_GUIDANCE,AGENT_PREFAB_REMINDER} from '../../services/creation/agent-prefab-policy.mjs';
import {CREATOR_SKILLS,AGENT_WORKFLOW_REMINDER} from '../../services/creation/agent-skill-catalog.mjs';

const root=resolve(import.meta.dirname,'../..');
const clone=structuredClone;
const knowledgeContent='Actor owns health, movement and collision; level owns waves and placement. '.repeat(8);
const occurrences=(text,part)=>text.split(part).length-1;

class PromptTransport extends EventEmitter {
  constructor(){
    super();this.pid=1;this.stdout=new PassThrough();this.stderr=new PassThrough();this.messages=[];this.thread=null;this.serial=0;
    this.stdin=new Writable({write:(chunk,_encoding,done)=>{
      const message=JSON.parse(chunk);this.messages.push(clone(message));
      queueMicrotask(()=>{
        try{this.handle(message);}catch(error){this.stdout.write(JSON.stringify({id:message.id,error:{code:-32000,message:error.message}})+'\n');}
      });done();
    }});
  }
  handle(message){
    if(message.id===undefined||!message.method)return;
    const p=message.params;let result;
    switch(message.method){
      case 'initialize':result={userAgent:'EXPLICIT-FAKE-prefab-policy'};break;
      case 'account/read':result={account:{type:'FAKE-no-paid-account'}};break;
      case 'model/list':result={data:[{model:'FAKE-prefab-model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};break;
      case 'thread/start':
        this.thread={id:'FAKE-thread',cwd:p.cwd,ephemeral:false,status:{type:'idle'},turns:[]};result={thread:this.thread};break;
      case 'thread/read':case 'thread/resume':result={thread:this.thread};break;
      case 'thread/goal/get':result={goal:null};break;
      case 'turn/start':{
        const turn={id:'FAKE-turn-'+(++this.serial),status:'completed',items:[{id:'FAKE-user-'+this.serial,type:'userMessage',clientId:p.clientUserMessageId,content:clone(p.input)}]};
        this.thread.turns.push(turn);result={turn};break;
      }
      default:throw Error('Unexpected RPC during prompt-only regression: '+message.method);
    }
    this.stdout.write(JSON.stringify({id:message.id,result})+'\n');
  }
  calls(method){return this.messages.filter(message=>message.method===method);}
  kill(signal){queueMicrotask(()=>{this.stdout.end();this.stderr.end();this.emit('close',0,signal);});return true;}
}

function sourceFixture(native){
  const knowledge={architecture:{id:'architecture',title:'Prefab responsibilities',content:knowledgeContent,tags:['architecture','prefab'],version:'fixture-knowledge-v1'}};
  if(!native)return {schema:'creation-flat-1',entry_scene_id:'scene',knowledge,resources:{scene:{id:'scene',kind:'scene',name:'Fixture scene',objects:[]}}};
  const texts={'project.godot':'config_version=5\n[application]\nrun/main_scene="res://scene.tscn"\n','scene.tscn':'[gd_scene format=3]\n[node name="Scene" type="Node2D"]\n'};
  const source_files=Object.fromEntries(Object.entries(texts).map(([path,text])=>[path,{hash:createHash('sha256').update(text).digest('hex'),size:Buffer.byteLength(text)}]));
  const source_identity=nativeSourceIdentity(source_files);
  return {schema:'creation-native-1',entry_scene_id:'scene',source_files,source_identity,index_source_identity:source_identity,knowledge,
    resources:{scene:{id:'scene',kind:'scene',name:'Fixture native scene',path:'scene.tscn',version:'fixture-scene-v1',native_nodes:[],design:{description:'Projection fixture',exposed_properties:[]}}}};
}

function fixture(t,schema='creation-native-1'){
  const data=realpathSync(mkdtempSync(join(tmpdir(),'atelier-FAKE-prefab-policy-'))),store=new CreationStore(join(data,'creation.sqlite'));
  const user=store.register({name:'Prefab author '+randomUUID(),password:'isolated-fixture-password'}).user;
  const made=store.createProject(user,{name:'Prompt projection fixture'},sourceFixture(schema==='creation-native-1')),project=made.project.id;
  if(schema==='creation-hierarchy-2')store.apply(user,project,'main',{transaction_id:'fixture-hierarchy',base_revision:made.branch.head,expected_head:made.branch.head,ops:[{type:'migrate_hierarchy'}]});
  const session=store.createSession(user,project,'main',{title:'Persistent fixture session'});
  const service={root,data,origin:'http://FAKE-no-listener.invalid',store,realtime:{development(){}},sessionEvent(sid,event){return store.appendSessionEvent(sid,event);}};
  const workspaceRoot=join(data,'workspaces');mkdirSync(workspaceRoot);let transport;
  const adapter=new CodexAgent({workspaceRoot,requestTimeoutMs:1000,spawnProcess:()=>transport=new PromptTransport()});
  const manager=new CreationAgentRuns({service,adapter});
  t.after(async()=>{await manager.close();await manager.environments.close();store.close();rmSync(data,{recursive:true,force:true});});
  return {data,store,user,project,session,service,adapter,manager,get transport(){return transport;},
    current:()=>store.branchView(user,project,'main'),
    send:text=>manager.send(user,session.id,{text,client_user_message_id:'message-'+randomUUID()})};
}

test('native workspace refresh keeps authored files and cwd while supplying prefab and knowledge guidance',async t=>{
  const f=fixture(t),cwd=f.manager.workspace(f.session),before=f.current(),authored=join(cwd,'work/existing/scripts/unfinished.gd'),asset=join(cwd,'work/existing/assets/unfinished.dat'),otherSkill=join(cwd,'.agents/skills/custom/SKILL.md');
  const originalScript='extends Node\n# Preserve unfinished authored work.\n',originalAsset=Buffer.from([0,128,255,1,0,240]);
  for(const file of [authored,asset,otherSkill])mkdirSync(dirname(file),{recursive:true});
  writeFileSync(authored,originalScript);writeFileSync(asset,originalAsset);writeFileSync(otherSkill,'Unrelated user skill\n');
  for(const file of ['AGENTS.md','WORLD-API.md','SEMANTIC-AUTHORING.md'])writeFileSync(join(cwd,file),'Historical incomplete guidance\n');
  assert.equal(f.manager.workspace(f.store.get('creator_session',f.session.id)),cwd);
  assert.equal(readFileSync(authored,'utf8'),originalScript);assert.deepEqual(readFileSync(asset),originalAsset);assert.equal(readFileSync(otherSkill,'utf8'),'Unrelated user skill\n');
  for(const file of ['AGENTS.md','WORLD-API.md'])assert.equal(occurrences(readFileSync(join(cwd,file),'utf8'),AGENT_PREFAB_GUIDANCE),1,file+' must carry the single shared native guide');
  for(const file of ['AGENTS.md','WORLD-API.md'])for(const skill of CREATOR_SKILLS)assert.ok(readFileSync(join(cwd,file),'utf8').includes(skill.path),file+' discovers '+skill.name);
  for(const skill of JSON.parse(readFileSync(join(cwd,'workspace.json'),'utf8')).skills)assert.ok(readFileSync(skill.path).length);
  const semantic=readFileSync(join(cwd,'SEMANTIC-AUTHORING.md'),'utf8');
  assert.match(semantic,/design-knowledge-index\.json/);assert.match(semantic,/knowledge_search\/read/);assert.match(semantic,/verify them against current\s+source/);
  assert.match(semantic,/Do not copy\s+private conversation history/);
  assert.equal(f.current().head,before.head,'refresh only changes session-owned projections');
  await f.send('Inspect the existing structure without changing source.');
  const pointer=JSON.parse(readFileSync(join(cwd,'context/current.json'),'utf8')),context=JSON.parse(readFileSync(pointer.manifest,'utf8'));
  const knowledge=JSON.parse(readFileSync(context.design_knowledge_index,'utf8'));
  assert.equal(context.source_revision,before.head);assert.equal(knowledge.revision,before.head);
  assert.equal(knowledge.knowledge[0].id,'architecture');assert.equal(knowledge.knowledge[0].summary,knowledgeContent.slice(0,300));
  assert.equal(f.current().manifest.knowledge.architecture.content,knowledgeContent,'full shared knowledge remains in the source');
  assert.equal(JSON.parse(readFileSync(join(dirname(pointer.manifest),'source-manifest.json'),'utf8')).knowledge,undefined,'bounded native source projection still uses the dedicated knowledge index');
  assert.equal(f.store.list('creator_verification').length,0);assert.equal(f.store.list('creator_build').length,0);
});

test('actual create, loaded next turn and resume RPC paths receive prefab and workflow reminders',async t=>{
  const f=fixture(t),first=await f.send('Create a reusable actor.'),cwd=f.transport.thread.cwd;
  assert.equal(first.run.status,'completed');assert.equal(f.transport.calls('thread/start').length,1);
  assert.equal(occurrences(f.transport.calls('thread/start')[0].params.developerInstructions,AGENT_PREFAB_REMINDER),1);
  assert.equal(occurrences(f.transport.calls('thread/start')[0].params.developerInstructions,AGENT_WORKFLOW_REMINDER),1);
  const firstPointer=JSON.parse(readFileSync(join(cwd,'context/current.json'),'utf8')),firstContext=readFileSync(firstPointer.manifest,'utf8');
  await f.send('Tune the same actor in this already loaded session.');
  assert.equal(f.transport.calls('thread/start').length,1);assert.equal(f.transport.calls('thread/resume').length,0,'loaded sessions must get current guidance without relying on resume');
  f.adapter.threads.clear();
  await f.send('Continue after reconnecting to the persistent task.');
  assert.equal(f.transport.calls('thread/start').length,1);assert.equal(f.transport.calls('thread/resume').length,1);
  const resumed=f.transport.calls('thread/resume')[0].params;
  assert.equal(resumed.threadId,first.run.thread_id);assert.equal(resumed.cwd,cwd);assert.equal(occurrences(resumed.developerInstructions,AGENT_PREFAB_REMINDER),1);
  assert.equal(occurrences(resumed.developerInstructions,AGENT_WORKFLOW_REMINDER),1);
  assert.equal(f.transport.calls('turn/start').length,3);
  for(const call of f.transport.calls('turn/start')){
    const text=call.params.input.filter(item=>item.type==='text').map(item=>item.text).join('\n');
    assert.equal(occurrences(text,AGENT_PREFAB_REMINDER),1,'each turn contains the updated reminder even with existing thread history');
    assert.equal(occurrences(text,AGENT_WORKFLOW_REMINDER),1,'loaded sessions discover workflow skills on the next turn');
  }
  assert.equal(readFileSync(firstPointer.manifest,'utf8'),firstContext,'new turns preserve previous fixed context');
  assert.equal(f.current().head,first.run.input_revision);
});

for(const schema of ['creation-flat-1','creation-hierarchy-2'])test(`${schema} keeps its own prefab authority and version contract`,async t=>{
  const f=fixture(t,schema);await f.send('Review reusable objects in the current source schema.');
  const cwd=f.transport.thread.cwd,guide=readFileSync(join(cwd,'WORLD-API.md'),'utf8'),semantic=readFileSync(join(cwd,'SEMANTIC-AUTHORING.md'),'utf8');
  assert.ok(guide.startsWith('# WORLD-API: '+schema));assert.equal(guide.includes(AGENT_PREFAB_GUIDANCE),false,'native authoring rules must not replace legacy authority');
  for(const skill of CREATOR_SKILLS)assert.ok(guide.includes(skill.path),'legacy session discovers '+skill.name);
  assert.equal(guide.includes('.atelier/catalog.json'),false);assert.equal(guide.includes('set_native_property'),false);
  assert.match(semantic,/Instance values stay independent of prefab defaults/);
  if(schema==='creation-hierarchy-2')assert.match(guide,/Saving a prefab definition does not update existing instances/);
  else assert.match(guide,/Never migrate merely to reinterpret an old attachment/);
  assert.match(AGENT_PREFAB_REMINDER,/legacy/i,'the shared reminder must explicitly defer legacy operations to their own guide');
  assert.match(AGENT_PREFAB_REMINDER,/(?:do not|never) migrate|without migrating/i,'structure guidance must not request an implicit schema migration');
});
