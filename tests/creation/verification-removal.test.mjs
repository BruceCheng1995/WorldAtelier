/** Real service/store boundary tests with isolated SQLite and no listening port,
 * real executor, Godot process or production data. Native goal RPC coverage is
 * maintained separately in semantic-native-modes.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {CreationService} from '../../services/creation/service.mjs';
import {CanonicalGameValidation} from '../../services/creation/canonical-game-validation.mjs';

const root=resolve(import.meta.dirname,'../..'),origin='http://127.0.0.1:48921';
function fixture(t){
  const data=mkdtempSync(resolve(tmpdir(),'atelier-verification-removal-')),server=createServer();
  const saved=Object.fromEntries(['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(key=>[key,process.env[key]]));
  process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';
  let service;
  try{service=new CreationService({server,root,data,origin});}
  finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
  t.after(async()=>{await service.close();rmSync(data,{recursive:true,force:true});});
  const auth=service.store.register({name:'Isolated removal owner',password:'isolated-removal-password'});
  const {project,branch}=service.store.createProject(auth.user,{name:'Removal regression'},{entry_scene_id:'room',resources:{room:{id:'room',name:'Room',kind:'scene',objects:[]}}});
  const session=service.store.createSession(auth.user,project.id,'main',{execution_mode:'goal'});
  const run={id:'run1',goal_id:'goal1',session_id:session.id,project_id:project.id,branch_id:'main',owner_user_id:auth.user.id,status:'completed',input_revision:branch.head,changes:[],targets:[],verifications:[],deliveries:[]};
  service.store.put('creator_run',run);service.store.put('creator_goal',{id:'goal1',session_id:session.id,run_id:run.id,status:'completed'});
  const request=async(method,path,input={})=>{
    const req=Readable.from(method==='GET'?[]:[Buffer.from(JSON.stringify(input))]);
    Object.assign(req,{method,url:'/creation-api'+path,headers:{host:'127.0.0.1:48921',origin,authorization:'Bearer '+auth.token},socket:{remoteAddress:'127.0.0.1'}});
    const res={writeHead(status){this.status=status;},end(value){this.body=JSON.parse(String(value));}};
    await service.request(req,res);return res;
  };
  return {service,store:service.store,user:auth.user,project:project.id,branch,session,run,request};
}

test('service retains native goal capability and explicit canonical validation without automatic scheduling',async t=>{
  const f=fixture(t),health=await f.request('GET','/health');
  assert.equal(health.status,200);assert.equal(health.body.agent_goals,true);assert.equal(health.body.automatic_verification,false);
  assert.equal(f.service.automatic,undefined);assert(f.service.validator instanceof CanonicalGameValidation);
  assert.equal(f.store.sessionView(f.user,f.session.id).execution_mode,'goal');
  assert.equal(f.store.sessionView(f.user,f.session.id).goals.length,1);
  f.service.sessionEvent(f.session.id,{kind:'run_state',run:f.run});
  const result=f.service.committed(f.user,f.project,'main',{transaction_id:'removal-edit',base_revision:f.branch.head,ops:[{type:'put_object',resource_id:'room',object_id:'marker',expected_version:null,object:{id:'marker',name:'Marker',kind:'anchor',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],components:{}}}]});
  assert.notEqual(result.revision,f.branch.head);
  f.service.realtime.onSubscribe({user:f.user,scope:{project_id:f.project,branch_id:'main'}});
  f.service.collaborationChanged(f.project);
  await new Promise(done=>setImmediate(done));
  assert.equal(f.store.list('creator_auto_verification').length,0);assert.equal(f.store.list('creator_game_verification').length,0);
  assert.equal(f.store.list('creator_inbox_item').some(item=>item.code?.startsWith('automatic')),false);
});

test('retired verification routes return 410 while the persistent session remains available',async t=>{
  const f=fixture(t);
  for(const [method,path]of [['GET','/goals/goal1/review'],['POST','/goals/goal1/decision'],['GET','/automatic-checks/old-job'],['POST','/automatic-checks/old-job/retry'],['POST','/automatic-checks/old-job/requests/old-key']]){
    const response=await f.request(method,path);assert.equal(response.status,410,path);
  }
  const session=await f.request('GET','/sessions/'+f.session.id);assert.equal(session.status,200);
  assert.equal(f.store.get('creator_goal','goal1').status,'completed');
});

test('historical automatic notices disappear from Inbox, asset markers and admin counts without deleting records',async t=>{
  const f=fixture(t),scope={project_id:f.project,branch_id:'main',resource_id:'room',revision:f.branch.head};
  const ordinary=f.service.inbox.record({...scope,event_id:'ordinary-event',dedupe_key:'ordinary',source:'backend',kind:'error',code:'ordinary_failure',title:'Ordinary failure',message:'Keep this actual error',targets:[{resource_id:'room'}],actions:[{id:'locate',label:'Locate'}]}).item;
  for(const [index,code]of ['automatic_verification','automatic_completed','verification_request'].entries())f.store.put('creator_inbox_item',{...ordinary,id:'retired-'+index,code,job_id:'legacy-job',kind:code==='verification_request'?'decision':code==='automatic_completed'?'notice':'validation'});
  f.store.put('creator_auto_verification',{id:'legacy-job',project_id:f.project,branch_id:'main',status:'running',created_at:1});
  const listed=f.service.inbox.list(f.user,{filter:'all'});assert.deepEqual(listed.items.map(item=>item.id),[ordinary.id]);assert.deepEqual(listed.counts,{unread:1,actionable:1});
  assert.deepEqual(f.service.inbox.projection(f.user,f.project,'main').map(item=>item.id),[ordinary.id]);
  assert.equal(f.service.admin.overview().counts.open_issues,1);assert.equal(f.service.admin.overview().counts.active_jobs,0);
  assert.equal(f.store.list('creator_inbox_item').length,4);assert.equal(f.store.get('creator_auto_verification','legacy-job').status,'running');
  assert.throws(()=>f.service.inbox.get(f.user,'retired-0'),error=>error.status===404);
  assert.throws(()=>f.service.inbox.record({...scope,event_id:'retired-action',dedupe_key:'retired-action',source:'backend',kind:'error',title:'Unsupported retry',message:'No automatic task',actions:[{id:'retry_verification',label:'Retry'}]}),error=>error.status===400);
});

test('the original workspace removes the verification panel while keeping the goal composer entry',()=>{
  const html=readFileSync(resolve(root,'apps/creation-workspace/index.html'),'utf8');
  const workspace=readFileSync(resolve(root,'apps/creation-workspace/workspace.js'),'utf8');
  const composer=readFileSync(resolve(root,'apps/creation-workspace/semantic-composer.js'),'utf8');
  assert.doesNotMatch(html,/id="sessionGoals"|goal-delivery\.css/);
  assert.doesNotMatch(workspace,/new GoalWorkspace|from ['"]\.\/goal-delivery\.js|automatic-checks\//);
  assert.match(composer,/\/goal/);
});
