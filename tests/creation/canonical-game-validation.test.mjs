import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationAssets} from '../../services/creation/assets.mjs';
import {CanonicalGameValidation,GAME_VALIDATION_CONTRACT} from '../../services/creation/canonical-game-validation.mjs';
import {hash} from '../../services/creation/schema.mjs';
const root=resolve(import.meta.dirname,'../..');
const logic=`extends RefCounted
func initialize(ctx) -> Dictionary:
\tvar scenes = GameRuntime.list_scenes()
\tvar prefabs = GameRuntime.list_prefabs()
\tif scenes.size()!=2 or prefabs.size()!=1: return {"ok":false}
\tctx.state["actual_project_scenes"] = scenes.size()
\tctx.state["actual_project_prefabs"] = prefabs.size()
\treturn {"ok":true}
func tick(ctx,_delta) -> Dictionary:
\tif ctx.role == "authority":
\t\tctx.state["ticks"] = int(ctx.state.get("ticks",0))+1
\t\tif ctx.properties.get("next_scene","")!="" and ctx.state.ticks==5: GameRuntime.call_deferred("open_scene",ctx.properties.next_scene)
\t\tif ctx.properties.get("fail_during_play",false) and ctx.state.ticks>=5: return {"ok":false}
\treturn {"ok":true}
`;
function fixture(t){
 const data=mkdtempSync(resolve(tmpdir(),'atelier-canonical-validation-')),store=new CreationStore(resolve(data,'creation.sqlite'));
 const service={root,data,origin:'http://127.0.0.1:48921',store,observe:fn=>fn(),inboxChanged(){},sessionEvent(){},notices:{automatic(){}},worlds:{validate(){throw Error('Old preview world validator must never run');},runtimeManifest(){throw Error('Editor runtime build must not gate canonical game validation');}}};
 service.assets=new CreationAssets({store,root,data});
 const user=store.register({name:'Canonical validation '+Date.now()+Math.random(),password:'isolated-password-for-tests'}).user;
 const manifest={schema:'creation-flat-1',entry_scene_id:'scene-a',resources:Object.fromEntries(['scene-a','scene-b','unplaced-prefab'].map(id=>[id,{id,kind:id.startsWith('scene')?'scene':'prefab',name:id,objects:[]}]))};
 const project=store.createProject(user,{name:'Canonical validation fixture'},manifest).project.id;
 const asset=service.assets.publish(user,project,Buffer.from(logic),'canonical-game-runtime-behavior.gd');let serial=0;
 const current=()=>store.branchView(user,project,'main');
 const put=(failure=false,nextScene='')=>store.apply(user,project,'main',{transaction_id:'canonical-fixture-'+(++serial),base_revision:current().head,ops:[{type:'put_object',resource_id:'scene-a',object_id:'canonical-object',expected_version:current().manifest.resources['scene-a'].objects.find(o=>o.id==='canonical-object')?.version??null,object:{id:'canonical-object',kind:'anchor',name:'Actual GameRuntime-dependent behavior',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],components:{behaviors:[{id:'canonical-component',api:1,script_hash:asset.id,script_url:asset.url,properties:{fail_during_play:failure,next_scene:nextScene}}]}}}]});
 put();const validator=new CanonicalGameValidation({service});
 t.after(async()=>{await validator.close();store.close();});
 return {data,store,service,user,project,asset,validator,current,put};
}
test('actual canonical game validation boots GameRuntime, all definitions, complete ticks and immutable project',{timeout:120000},async t=>{
 const f=fixture(t),identity=f.validator.identity();assert.match(identity.runtime_source_hash,/^[a-f0-9]{64}$/);assert.equal(identity.contract,GAME_VALIDATION_CONTRACT);
 const started=performance.now();for(let i=0;i<40;i++)assert.deepEqual(f.validator.identity(),identity);assert.ok(performance.now()-started<1500,'cached identity avoids esbuild and large binary hashing on each poll');
 const report=await f.validator.validate(f.user,f.project,'main',{revision:f.current().head,resource_id:'scene-a'});
 assert.equal(report.status,'passed',JSON.stringify(report));assert.equal(report.validation_kind,'canonical_local_game');assert.equal(report.runtime_build_id,undefined);assert.match(report.process.find(row=>row.name==='runtime').output,/CANONICAL_GAME_VALIDATION/,'real command evidence persists in the SQLite-backed record');
 assert.equal(report.report.scene_count,2);assert.equal(report.report.prefab_count,1);assert.ok(report.report.tick>=120);assert.equal(report.report.runtime_entry,'res://standalone.gd');
 assert.equal(report.report.telemetry.object_states['canonical-object']['canonical-component'].actual_project_scenes,2);
 const registration=f.store.get('creator_verification_project',report.game_validation_job_id);assert.equal(registration.canonical_identity,report.canonical_project_identity);assert.equal(registration.job_kind,'creator_game_verification');
 const directory=resolve(f.data,registration.directory);assert.match(readFileSync(resolve(directory,'project.godot'),'utf8'),/GameRuntime="\*res:\/\/standalone.gd"/);assert.equal(registration.files.some(file=>file.path==='canonical_validation_observer.gd'),false,'observer belongs only to execution copy');
 for(const file of registration.files)assert.equal(hash(readFileSync(resolve(directory,file.path))),file.sha256,'fixed project stays immutable');
 console.log('Canonical validation actual evidence: '+f.data);
});
test('actual callback fault after initialization fails canonical validation and no legacy preview report is reused',{timeout:120000},async t=>{
 const f=fixture(t);f.put(true);
 const old={id:'old-preview-report',project_id:f.project,branch_id:'main',resource_id:'scene-a',revision:f.current().head,runtime_build_id:'old-editor-preview',status:'passed',report:{scope:'historical preview evidence'}};f.store.put('creator_verification',old);
 const report=await f.validator.validate(f.user,f.project,'main',{resource_id:'scene-a'});
 assert.equal(report.status,'failed',JSON.stringify(report));assert.notEqual(report.id,old.id);assert.deepEqual(f.store.get('creator_verification',old.id),old);
 assert.equal(report.validation_kind,'canonical_local_game');assert.ok(report.report.error.includes('脚本错误')||report.error?.includes('脚本错误'),JSON.stringify(report));assert.ok(f.store.get('creator_verification_project',report.game_validation_job_id));
});
test('a cancelled lease cannot start canonical subprocesses or persist successful verification',{timeout:90000},async t=>{
 const f=fixture(t),abort=new AbortController();abort.abort();await assert.rejects(f.validator.validate(f.user,f.project,'main',{resource_id:'scene-a',signal:abort.signal}),/取消/);assert.equal(f.store.list('creator_verification').length,0);
 let checks=0;await assert.rejects(f.validator.validate(f.user,f.project,'main',{resource_id:'scene-a',guard(){if(++checks>=3)throw Error('lease revoked during preparation');}}),/lease revoked/);
 assert.equal(f.store.list('creator_verification').some(row=>row.status==='passed'),false);assert.equal(f.store.list('creator_verification').at(-1).process.length,0);
 let lateChecks=0;await assert.rejects(f.validator.validate(f.user,f.project,'main',{resource_id:'scene-a',guard(){if(++lateChecks>=6)throw Error('lease revoked after real runtime command');}}),/lease revoked/);
 assert.equal(f.store.list('creator_verification').some(row=>row.status==='passed'),false);assert.equal(f.store.list('creator_verification').find(row=>row.error==='lease revoked after real runtime command').process.length,2,'actual completed commands cannot write passed after lease revocation');
});

test('actual canonical validation allows authored startup A to load B and counts real ticks across native scene generations',{timeout:120000},async t=>{
 const f=fixture(t);f.put(false,'scene-b');
 const report=await f.validator.validate(f.user,f.project,'main',{revision:f.current().head,resource_id:'scene-a'});
 assert.equal(report.status,'passed',JSON.stringify(report));assert.equal(report.report.entry_resource_id,'scene-a');assert.equal(report.report.resource_id,'scene-b');assert.equal(report.report.scene_generation,2);
 assert.ok(report.report.observed_ticks>=120);assert.ok(report.report.tick<120,'elapsed validation uses cumulative actual ticks across scenes');
 assert.deepEqual(report.report.observed_scenes.map(row=>row.resource_id),['scene-a','scene-b']);
 const runtime=report.process.find(row=>row.name==='runtime');assert.equal(runtime.entry_ready.scene_id,'scene-a');assert.equal(runtime.scene_ready_count,2);assert.match(runtime.output,/"scene_id":"scene-b"/);
});
