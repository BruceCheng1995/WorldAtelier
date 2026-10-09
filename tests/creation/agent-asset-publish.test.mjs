/** Actual dynamic tool and asset file pipeline, with an isolated in-memory identity store; no Codex executor. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,relative} from 'node:path';
import {CreationAgentRuns} from '../../services/creation/agent-runs.mjs';
import {CreationAssets} from '../../services/creation/assets.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {assetFixtureGLB,assetFixturePNG} from './asset-test-fixtures.mjs';

function fixture(t){
 const cwd=mkdtempSync(resolve(tmpdir(),'atelier-agent-asset-publish-')),foreign=mkdtempSync(resolve(tmpdir(),'atelier-agent-asset-foreign-'));
 t.after(()=>{rmSync(cwd,{recursive:true,force:true});rmSync(foreign,{recursive:true,force:true});});
 const records=new Map(),user={id:'owner'},session={id:'session',project_id:'project',branch_id:'main',owner_user_id:'owner',executor_thread_id:'thread'};
 const run={id:'run',status:'running',turn_id:'turn',lease_generation:1};let editor=true;
 const requireEditor=account=>{if(account.id!==user.id||!editor)throw Object.assign(new Error('permission denied'),{status:403});};
 const store={get:(kind,id)=>records.get(kind+':'+id),put:(kind,value)=>records.set(kind+':'+value.id,structuredClone(value)),publicUser:value=>value,
  sessionFor(account,id,write){requireEditor(account);assert.equal(id,session.id);assert.equal(write,true);return session;},projectFor(account,id,write){requireEditor(account);assert.equal(id,'project');assert.equal(write,true);return{id};}};
 store.put('creator_user',user);store.put('creator_session',session);
 const assets=new CreationAssets({store,root:process.cwd(),data:resolve(cwd,'private-store')});
 const manager=Object.create(CreationAgentRuns.prototype);Object.assign(manager,{store,service:{assets},turnBindings:new Map(),runForTurn:(thread,turn)=>thread==='thread'&&turn==='turn'?run:null,assertCleanupReady:()=>{}});
 mkdirSync(resolve(cwd,'work'),{recursive:true});
 const invoke=(path,callId='call-'+path,signal=new AbortController().signal)=>manager.dynamic({threadId:'thread',turnId:'turn',scope:{sessionId:'session',userId:'owner'},cwd,signal,tool:'asset_publish',arguments:{path},callId});
 return {cwd,foreign,run,assets,invoke,revoke:()=>editor=false};
}

test('asset_publish accepts GLB and GDScript by workspace path and returns only metadata',async t=>{
 const f=fixture(t),glb=assetFixtureGLB(),gd=Buffer.from('extends RefCounted\nfunc value() -> int:\n\treturn 7\n');
 for(const [filename,bytes] of [['work/imported.glb',glb],['work/behavior.gd',gd]]){
  writeFileSync(resolve(f.cwd,filename),bytes);const response=await f.invoke(filename),result=JSON.parse(response.contentItems[0].text);
  assert.equal(response.success,true);assert.equal(result.id,hash(bytes));assert.equal(result.bytes,bytes.length);
  assert.deepEqual(readFileSync(resolve(f.assets.directory,result.id+'.'+result.ext)),bytes);
  assert.doesNotMatch(JSON.stringify(response),/data_base64|binary_data|raw_bytes/);assert.equal(JSON.stringify(response).includes(bytes.toString('base64')),false);
  assert.deepEqual(await f.invoke(filename),response,'receipt replay must preserve metadata and avoid another publication');
 }
});

test('asset_publish retains path, format, membership, run and cancellation fences',async t=>{
 const f=fixture(t),glb=assetFixtureGLB();writeFileSync(resolve(f.cwd,'work/model.glb'),glb);writeFileSync(resolve(f.foreign,'foreign.glb'),glb);
 symlinkSync(resolve(f.foreign,'foreign.glb'),resolve(f.cwd,'work/escaped.glb'));
 for(const path of [resolve(f.foreign,'foreign.glb'),relative(f.cwd,resolve(f.foreign,'foreign.glb')),'work/escaped.glb'])await assert.rejects(f.invoke(path),error=>error.status===403,path);
 writeFileSync(resolve(f.cwd,'work/image.png'),assetFixturePNG());await assert.rejects(f.invoke('work/image.png'),error=>[400,422].includes(error.status));
 writeFileSync(resolve(f.cwd,'work/malformed.glb'),Buffer.from('not a GLB'));await assert.rejects(f.invoke('work/malformed.glb'),error=>error.status===400);
 f.run.status='completed';await assert.rejects(f.invoke('work/model.glb','expired'),error=>error.status===409);f.run.status='running';
 const controller=new AbortController();controller.abort();await assert.rejects(f.invoke('work/model.glb','cancelled',controller.signal),error=>error.status===409);
 f.revoke();await assert.rejects(f.invoke('work/model.glb','revoked'),error=>error.status===403);
});
