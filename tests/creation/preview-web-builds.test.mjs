// API/window doubles verify orchestration only. Real game evidence is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReleaseBuilds} from '../../apps/creation-workspace/release-builds.js';
import {prepareGamePlay} from '../../apps/creation-workspace/game-play.js';
const context={user_id:'owner',project_id:'game',project_name:'Garden',branch_id:'main',source_revision:'source-a',role:'owner',resources:[{id:'current-scene',kind:'scene',name:'Current'},{id:'default-scene',kind:'scene',name:'Default'}]};
const webPolicy='world-atelier-single-thread-local-http-v1';
const build=(patch={})=>({id:'build-test',kind:'application',project_id:'game',branch_id:'main',source_revision:'source-a',entry_scene_id:'current-scene',targets:['web'],canonical_identity:'a'.repeat(64),runtime_source_hash:'b'.repeat(64),web_compatibility_policy:webPolicy,web_compatibility:{policy:webPolicy},status:'completed',progress:100,stage:'Ready',artifacts:[{id:'web',target:'web'}],...patch});
function fixture(t,{jobs=[],blocked=false,request,insecure=false}={}){
  const calls=[],popups=[],saved={};
  for(const [name,value] of Object.entries({isSecureContext:!insecure,location:{origin:'http://localhost:48921',protocol:'http:'},window:{open(){if(blocked)return null;const popup={document:{body:{}},closed:false,close(){this.closed=true;},location:{replace(url){popup.url=url;}}};popups.push(popup);return popup;}}})){
    saved[name]=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,configurable:true});
  }
  t.after(()=>{for(const [name,descriptor] of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];});
  const manager=Object.create(ReleaseBuilds.prototype);
  Object.assign(manager,{context:structuredClone(context),key:'game/main',generation:1,disposed:false,jobs,targets:[],targetsLoaded:true,error:'',readDenied:false,clientErrors:new Map(),opening:new Set(),downloads:new Set(),webPreview:null,dialog:{open:false,showModal(){this.open=true;}},render(){},renderTopbar(){},schedule(){},refresh:async()=>{},open(type){this.view={type,context:structuredClone(this.context)};},request:async(route,options)=>{calls.push({route,options});if(request)return request(route,options);if(route.endsWith('/access'))return {web_url:'/creation-releases/build-test/web/index.html'};return {job:build()};}});
  t.after(()=>manager.cancelWebPreview());return {manager,calls,popups};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const helper=(manager,extra={})=>prepareGamePlay({request:manager.request,projectId:'game',branchId:'main',revision:'source-a',entrySceneId:'current-scene',...extra});

test('both launch surfaces request the server-resolved fixed game rather than guessing from build history',async t=>{
  const {manager,calls,popups}=fixture(t,{jobs:[build({id:'old-identical-content',runtime_source_hash:'old-engine'})]});
  const opening=manager.playWeb('current-scene');manager.context.source_revision='source-b';await opening;
  assert.deepEqual(calls.map(c=>c.route),['projects/game/branches/main/play-build','builds/build-test/access']);
  assert.equal(calls[0].options.body.source_revision,'source-a');assert.equal(calls[0].options.body.entry_scene_id,'current-scene');
  assert.equal(calls[0].options.body.confirmed,undefined);assert.equal(calls[0].options.body.targets,undefined);
  assert.equal(popups[0].url,'http://localhost:48921/creation-releases/build-test/web/index.html');assert.equal(manager.webPreview,null);
  calls.length=0;const embedded=await helper(manager);assert.equal(embedded.job.id,'build-test');assert.equal(embedded.url,popups[0].url);
});

test('a reader resolves the authorized playable revision without acquiring general export authority',async t=>{
  const {manager,calls,popups}=fixture(t,{request:async route=>route.includes('/playable-game?')?{source_revision:'published-old'}:route.endsWith('/access')?{web_url:'/creation-releases/build-test/web/index.html'}:{job:build({source_revision:'published-old'})}});
  manager.context.role='player';await manager.playWeb('current-scene');
  assert.match(calls[0].route,/playable/);assert.equal(calls[1].options.body.source_revision,'published-old');assert.ok(popups[0].url);
});

test('native viewer new-page Play fixes readable source and never calls shared playable',async t=>{
  const {manager,calls,popups}=fixture(t);Object.assign(manager.context,{role:'viewer',schema:'creation-native-1'});
  await manager.playWeb('current-scene');
  assert.deepEqual(calls.map(c=>c.route),['projects/game/branches/main/play-build','builds/build-test/access']);
  assert.equal(calls[0].options.body.source_revision,'source-a');assert.ok(popups[0].url);
});

test('native public default new-page Play follows the published entry after source default changes',async t=>{
  const {manager,calls,popups}=fixture(t,{request:async route=>route.endsWith('/playable-game')?{source_revision:'published-old',resource_id:'removed-old-entry'}:route.endsWith('/access')?{web_url:'/creation-releases/build-test/web/index.html'}:{job:build({source_revision:'published-old',entry_scene_id:'removed-old-entry'})}});
  Object.assign(manager.context,{role:'player',schema:'creation-native-1',entry_scene_id:'current-scene'});
  await manager.playWeb('current-scene');
  assert.equal(calls[0].route,'projects/game/branches/main/playable-game');assert.equal(calls[1].options.body.entry_scene_id,'removed-old-entry');assert.equal(calls[1].options.body.source_revision,'published-old');assert.ok(popups[0].url);
});

test('native public explicit scene keeps the same entry filter in a new page',async t=>{
  const {manager,calls,popups}=fixture(t,{request:async route=>route.includes('/playable-game?')?{source_revision:'published-old',resource_id:'current-scene'}:route.endsWith('/access')?{web_url:'/creation-releases/build-test/web/index.html'}:{job:build({source_revision:'published-old'})}});
  Object.assign(manager.context,{role:'player',schema:'creation-native-1',entry_scene_id:'default-scene'});
  await manager.playWeb('current-scene');assert.equal(calls[0].route,'projects/game/branches/main/playable-game?resource_id=current-scene');assert.equal(calls[1].options.body.entry_scene_id,'current-scene');assert.ok(popups[0].url);
});

test('wrong content, missing canonical identity, and a failed real build never navigate a popup',async t=>{
  const {manager,popups}=fixture(t,{request:async()=>({job:build({source_revision:'other-source'})})});await manager.playWeb('current-scene');assert.equal(popups[0].closed,true);assert.match(manager.error,/不匹配/);
  manager.request=async()=>({job:build({canonical_identity:undefined})});await assert.rejects(helper(manager),/不匹配/);
  manager.request=async()=>({job:build({status:'failed',artifacts:[],error:'real Godot parse failure'})});await assert.rejects(helper(manager),/Godot parse failure/);
});

test('scope cancellation during artifact preparation rejects late work without starting another run',async t=>{
  const pending=deferred();const {manager,calls,popups}=fixture(t,{request:()=>pending.promise});
  const opening=manager.playWeb('current-scene');await manager.playWeb('current-scene');assert.equal(calls.length,1);assert.equal(popups.length,1);
  manager.generation++;manager.cancelWebPreview();pending.resolve({job:build()});await opening;
  assert.equal(popups[0].closed,true);assert.equal(popups[0].url,undefined);assert.equal(calls.length,1);
});

test('closing during access resolution cannot navigate a disposed popup',async t=>{
  const access=deferred();const {manager,popups}=fixture(t,{request:route=>route.endsWith('/access')?access.promise:Promise.resolve({job:build()})});
  const opening=manager.playWeb('current-scene');await new Promise(setImmediate);manager.cancelWebPreview();access.resolve({web_url:'/creation-releases/build-test/web/index.html'});await opening;assert.equal(popups[0].url,undefined);
});

test('a blocked popup does not start a build',async t=>{const {manager,calls}=fixture(t,{blocked:true});await manager.playWeb('current-scene');assert.equal(calls.length,0);assert.match(manager.error,/拦截/);});

test('unexpected artifact origins and build paths are rejected',async t=>{
  const {manager}=fixture(t,{request:async route=>route.endsWith('/access')?{web_url:'https://example.com/game/index.html'}:{job:build()}});await assert.rejects(helper(manager),/地址/);
  manager.request=async route=>route.endsWith('/access')?{web_url:'/creation-releases/build-other/web/index.html'}:{job:build()};await assert.rejects(helper(manager),/地址/);
});

test('permission revocation while preparing a run is surfaced and closes the waiting page',async t=>{
  const {manager,popups}=fixture(t,{request:async()=>{throw Object.assign(Error('project access revoked'),{status:403});}});await manager.playWeb('current-scene');assert.equal(popups[0].closed,true);assert.equal(manager.error,'project access revoked');
});
test('history refuses an old package on insecure HTTP before opening its error page',async t=>{
  const {manager,calls,popups}=fixture(t,{insecure:true,jobs:[build({status:'completed',artifacts:[{id:'web',target:'web'}],web_compatibility:undefined})]});
  await manager.openWeb('build-test','web');
  assert.equal(calls.length,0);assert.equal(popups.length,0);assert.match(manager.clientErrors.get('build-test'),/旧 Web 包.*局域网 HTTP/);
});

test('a player opening legacy LAN history is directed to a compatible package or an editor',async t=>{
  const {manager,calls,popups}=fixture(t,{insecure:true,jobs:[build({status:'completed',artifacts:[{id:'web',target:'web'}],web_compatibility:undefined})]});
  manager.context.role='player';await manager.openWeb('build-test','web');
  assert.equal(calls.length,0);assert.equal(popups.length,0);assert.match(manager.clientErrors.get('build-test'),/编辑者/);assert.doesNotMatch(manager.clientErrors.get('build-test'),/预览窗口点击/);
});

test('history opens a compatible package on insecure HTTP through a fresh access grant',async t=>{
  const {manager,calls,popups}=fixture(t,{insecure:true,jobs:[build({status:'completed',artifacts:[{id:'web',target:'web'}]})]});
  await manager.openWeb('build-test','web');
  assert.deepEqual(calls.map(call=>call.route),['builds/build-test/access']);assert.equal(popups[0].url,'http://localhost:48921/creation-releases/build-test/web/index.html');
});

test('history keeps an immutable old package usable in a secure context',async t=>{
  const {manager,calls,popups}=fixture(t,{jobs:[build({status:'completed',artifacts:[{id:'web',target:'web'}],web_compatibility:undefined})]});
  await manager.openWeb('build-test','web');
  assert.deepEqual(calls.map(call=>call.route),['builds/build-test/access']);assert.ok(popups[0].url);
});
