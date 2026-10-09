/** Independent image input tests: real HTTP/auth/SQLite/files; explicit FAKE RPC.
 * Uses only port 48921 and temporary data. No model, Godot or user session runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {deflateSync} from 'node:zlib';
import {CreationService} from '../../services/creation/service.mjs';
import {CreationAgentRuns} from '../../services/creation/agent-runs.mjs';
import {CodexAgent} from '../../services/creation/codex-agent.mjs';
import {CreationStore} from '../../services/creation/store.mjs';
import {SessionImages} from '../../services/creation/session-images.mjs';
import {createCreationBackup,restoreCreationBackup} from '../../tools/backup-creation.mjs';

const root=resolve(import.meta.dirname,'../..'),origin='http://127.0.0.1:48921';
function png(red=60){
  const chunk=(type,data)=>{const payload=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of payload){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,payload,checksum]);};
  const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(1,4);h[8]=8;h[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,red,80,90,255]))),chunk('IEND',Buffer.alloc(0))]);
}
class FakeExecutor extends EventEmitter{
  constructor(){super();this.connected=true;this.threads=new Map();this.turns=new Map();this.inputs=[];}
  async start(){}
  async listModels(){return {data:[{model:'FAKE-image-test',isDefault:true,supportedReasoningEfforts:[]}]};}
  async accountStatus(){return {account:{type:'FAKE-no-account'}};}
  async createThread(input){this.threads.set('FAKE-thread',{...input,loaded:true,busy:false,uncertain:false});return {thread:{id:'FAKE-thread',turns:[]}};}
  async sendTurn(threadId,input){this.inputs.push(structuredClone(input));const turn={id:`FAKE-turn-${this.inputs.length}`,status:'completed',items:[]};this.turns.set(`${threadId}/${turn.id}`,turn);return {turn};}
  async stop(){}
}
async function fixture(t){
  const data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-image-input-')));let service;
  const server=createServer(async(req,res)=>{try{if(!await service.request(req,res)){res.writeHead(404);res.end();}}catch(e){res.writeHead(500);res.end(e.message);}});
  const saved=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(k=>[k,process.env[k]]);
  for(const [k]of saved)process.env[k]='1';
  try{service=new CreationService({server,root,data,origin});}finally{for(const [k,v]of saved)v===undefined?delete process.env[k]:process.env[k]=v;}
  t.after(async()=>{await service.close();server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));rmSync(data,{recursive:true,force:true});});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(48921,'127.0.0.1',yes);});
  const owner=service.store.register({name:'ImageOwner',password:'test-password'}),editor=service.store.register({name:'ImageEditor',password:'test-password'}),viewer=service.store.register({name:'ImageViewer',password:'test-password'}),outsider=service.store.register({name:'ImageOutsider',password:'test-password'});
  const project=service.store.createProject(owner.user,{name:'Image fixture'},{schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Empty',objects:[]}}}).project;
  service.store.setMember(owner.user,project.id,editor.user.id,'editor');service.store.setMember(owner.user,project.id,viewer.user.id,'viewer');
  const session=service.store.createSession(owner.user,project.id,'main',{visibility:'private',effort:null});
  const request=async(method,path,account=owner,body,mime='application/json')=>{const response=await fetch(origin+'/creation-api/'+path,{method,headers:{origin,connection:'close','content-type':mime,...(account?{authorization:'Bearer '+account.token}:{})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});return {status:response.status,headers:response.headers,bytes:Buffer.from(await response.arrayBuffer())};};
  const url=`sessions/${session.id}`,upload=(bytes=png(),account=owner,mime='image/png',name='参考图.png')=>request('POST',url+'/image-attachments?name='+encodeURIComponent(name),account,bytes,mime);
  return {data,service,owner,editor,viewer,outsider,project,session,request,url,upload};
}
const json=r=>JSON.parse(r.bytes.toString());
const ok=(r,status=200)=>{assert.equal(r.status,status,r.bytes.toString());return json(r);};

test('image upload/download obeys session ACL, validates bytes, and persists compact immutable metadata',async t=>{
  const f=await fixture(t),bytes=png(),a=ok(await f.upload(),201),download=f.url+'/image-attachments/'+a.id;
  assert.equal(a.kind,'image');assert.equal(a.role,'reference');assert.equal(a.width,1);assert.equal(a.height,1);assert.equal(a.bytes,bytes.length);assert.equal(a.name,'参考图.png');assert.match(a.sha256,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(a).includes(bytes.toString('base64')),false);assert.equal(a.path,undefined);assert.equal(a.url,undefined);
  const image=await f.request('GET',download);assert.equal(image.status,200);assert.deepEqual(image.bytes,bytes);assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('cache-control'),'private, no-store');
  for(const account of [f.editor,f.viewer,f.outsider,null])assert.ok([401,403].includes((await f.request('GET',download,account)).status));
  for(const account of [f.editor,f.viewer,f.outsider])assert.equal((await f.upload(bytes,account)).status,403);
  f.service.store.updateSession(f.owner.user,f.session.id,{visibility:'shared'});
  for(const account of [f.editor,f.viewer])assert.deepEqual((await f.request('GET',download,account)).bytes,bytes);
  assert.equal((await f.request('GET',download,f.outsider)).status,403);
  assert.equal((await f.upload(Buffer.from('<svg/>'),f.owner,'image/svg+xml')).status,422);
  assert.equal((await f.upload(Buffer.from('not PNG'),f.owner)).status,422);
  assert.equal((await f.upload(bytes,f.owner,'image/jpeg')).status,422);
  assert.equal((await f.upload(Buffer.alloc(5*1024*1024+1),f.owner)).status,413);
  assert.equal(f.service.store.sessionFor(f.owner.user,f.session.id).draft_attachments.length,1);
  ok(await f.request('DELETE',f.url+'/attachments/'+a.id));assert.equal((await f.request('GET',download)).status,404);
  const b=ok(await f.upload(),201);assert.equal(b.sha256,a.sha256);assert.notEqual(b.id,a.id);
  for(let i=1;i<8;i++)ok(await f.upload(png(i)),201);
  assert.equal((await f.upload(png(200))).status,422);assert.equal(f.service.store.sessionFor(f.owner.user,f.session.id).draft_attachments.length,8);
});

test('image-only send persists attachment and materializes exact bytes once without object targets or base64 prompt',async t=>{
  const f=await fixture(t),executor=new FakeExecutor();f.service.agent=new CreationAgentRuns({service:f.service,adapter:executor});
  const a=ok(await f.upload(),201),input={text:'',client_user_message_id:'image-only-once'},sent=ok(await f.request('POST',f.url+'/turns',f.owner,input),202);
  assert.equal(executor.inputs.length,1);assert.equal(executor.inputs[0].images.length,1);assert.deepEqual(readFileSync(executor.inputs[0].images[0].path),png());assert.deepEqual(sent.run.targets,[]);assert.deepEqual(sent.session.draft_attachments,[]);assert.deepEqual(sent.session.messages[0].attachments,[a]);assert.equal(sent.session.messages[0].content,'');
  assert.equal(JSON.stringify(executor.inputs[0]).includes(png().toString('base64')),false);
  assert.equal((await f.request('GET',f.url+'/image-attachments/'+a.id)).status,200);
  const replay=ok(await f.request('POST',f.url+'/turns',f.owner,input),202);assert.equal(replay.replayed,true);assert.equal(replay.run.id,sent.run.id);assert.equal(executor.inputs.length,1);
  assert.equal((await f.request('POST',f.url+'/turns',f.owner,{...input,text:'changed'})).status,409);
  assert.equal((await f.request('POST',f.url+'/turns',f.owner,{text:'',client_user_message_id:'empty-new-message'})).status,400);
  const raw=readFileSync(resolve(f.data,'session-images',a.sha256));writeFileSync(resolve(f.data,'session-images',a.sha256),Buffer.from('tampered'));
  assert.equal((await f.request('GET',f.url+'/image-attachments/'+a.id)).status,409);writeFileSync(resolve(f.data,'session-images',a.sha256),raw);
});

test('actual adapter produces localImage input and rejects absent or escaped visual attachments using explicit FAKE RPC',async t=>{
  const f=await fixture(t),a=ok(await f.upload(),201),cwd=resolve(f.data,'workspace');mkdirSync(cwd);
  const images=f.service.sessionImages.materialize(f.owner.user,f.session.id,[a],cwd),agent=new CodexAgent({workspaceRoot:f.data}),calls=[];
  agent.threads.set('FAKE-thread',{loaded:true,cwd,scope:{projectId:f.project.id,branchId:'main'},busy:false,uncertain:false});
  agent._rpc=async(method,params)=>{calls.push(structuredClone({method,params}));return {turn:{id:'FAKE-rpc-'+calls.length,status:'completed'}};};
  const input={text:'请参考图片',model:'FAKE-model',attachments:[a],images};await agent.sendTurn('FAKE-thread',input);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'turn/start');assert.deepEqual(calls[0].params.input.filter(i=>i.type==='localImage'),[{type:'localImage',path:images[0].path}]);assert.equal(JSON.stringify(calls).includes(png().toString('base64')),false);
  await assert.rejects(agent.sendTurn('FAKE-thread',{...input,images:[]}),{code:'INVALID_IMAGES'});
  const outside=resolve(f.data,'outside.png');writeFileSync(outside,png());await assert.rejects(agent.sendTurn('FAKE-thread',{...input,images:[{...images[0],path:outside}]}),{code:'INVALID_IMAGE_PATH'});
  const link=resolve(cwd,'escaped.png');symlinkSync(outside,link);await assert.rejects(agent.sendTurn('FAKE-thread',{...input,images:[{...images[0],path:link}]}),{code:'INVALID_IMAGE_PATH'});
  const b=ok(await f.upload(png(80)),201);await assert.rejects(agent.sendTurn('FAKE-thread',{...input,attachments:[a,b],images:[images[0],images[0]]}),{code:'INVALID_IMAGES'});
  assert.equal(calls.length,1);
});

test('backup/restore and SQLite reopen preserve sent and draft images with private session ACL and hash verification',async t=>{
  const f=await fixture(t),executor=new FakeExecutor();f.service.agent=new CreationAgentRuns({service:f.service,adapter:executor});
  const sent=ok(await f.upload(),201);ok(await f.request('POST',f.url+'/turns',f.owner,{text:'参考图片',client_user_message_id:'backup-image-message'}),202);
  const draft=ok(await f.upload(png(90)),201),backupRoot=mkdtempSync(resolve(tmpdir(),'atelier-image-backup-')),backup=resolve(backupRoot,'backup'),restored=resolve(backupRoot,'restored');t.after(()=>rmSync(backupRoot,{recursive:true,force:true}));
  assert.equal((await createCreationBackup({data:f.data,out:backup})).ok,true);
  await restoreCreationBackup({from:backup,out:restored});
  const reopened=new CreationStore(resolve(f.data,'creation.sqlite'));try{const images=new SessionImages({store:reopened,data:f.data});assert.deepEqual(images.bytes(images.find(f.owner.user,f.session.id,sent.id)),png());assert.deepEqual(images.bytes(images.find(f.owner.user,f.session.id,draft.id)),png(90));}finally{reopened.close();}
  const store=new CreationStore(resolve(restored,'data/creation.sqlite'));
  try{
    const images=new SessionImages({store,data:resolve(restored,'data')}),session=store.sessionView(f.owner.user,f.session.id);
    assert.deepEqual(session.messages[0].attachments,[sent]);assert.deepEqual(session.draft_attachments,[draft]);
    for(const a of [sent,draft]){assert.deepEqual(images.find(f.owner.user,f.session.id,a.id),a);assert.throws(()=>images.find(f.editor.user,f.session.id,a.id),e=>e.status===403);}
    assert.deepEqual(images.bytes(sent),png());assert.deepEqual(images.bytes(draft),png(90));
  }finally{store.close();}
  writeFileSync(resolve(f.data,'session-images',draft.sha256),'corrupt');
  await assert.rejects(createCreationBackup({data:f.data,out:resolve(backupRoot,'corrupt-backup')}),/mismatch/);
});
