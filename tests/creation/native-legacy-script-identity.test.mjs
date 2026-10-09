// Real migration, native edit, canonical Godot startup and corrupt execution
// copies. No formal source database, service, browser or Agent is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';
import {CreationAssets} from '../../services/creation/assets.mjs';
import {convertLegacyManifest} from '../../services/creation/native-migration/legacy-converter.mjs';
import {CanonicalGameValidation} from '../../services/creation/canonical-game-validation.mjs';
import {prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';
import {hash} from '../../services/creation/schema.mjs';

const root=resolve(import.meta.dirname,'../..');
const script=value=>`extends RefCounted
func initialize(ctx) -> Dictionary:
\tctx.state["native_value"] = ${value}
\tctx.state["instance_value"] = ctx.properties.amount
\treturn {"ok":true}
func tick(ctx,_delta) -> Dictionary:
\tctx.state["ticks"] = int(ctx.state.get("ticks",0))+1
\treturn {"ok":true}
`;

test('edited native script at its migrated path uses fixed file identity and rejects corrupt execution copies',{timeout:180000},async t=>{
 const data=mkdtempSync(join(tmpdir(),'wa-legacy-script-identity-'));
 const store=new CreationStore(join(data,'creation.sqlite')),native=new NativeProjects({store,data});
 const service={root,data,store,native,verificationFinished(){}};
 const validator=new CanonicalGameValidation({service});
 t.after(async()=>{await validator.close();await native.close();store.close();rmSync(data,{recursive:true,force:true});});
 const user=store.register({name:'Native compatibility identity',password:'independent-native-identity-password'}).user;
 const original=script(5),edited=script(41),oldHash=hash(original),path='assets/'+oldHash+'.gd';
 const legacy={schema:'creation-flat-1',entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Migrated scene',objects:['left','right'].map((id,index)=>({id,name:id,kind:'anchor',position:[index*2,0,0],rotation:[0,0,0],scale:[1,1,1],components:{behaviors:[{id:'logic',api:1,script_hash:oldHash,script_url:'/preview-assets/'+oldHash+'.gd',properties:{amount:index+2}}]}}))}}};
 const initial=store.createProject(user,{name:'Migration script identity'},{...legacy,resources:{main:{...legacy.resources.main,objects:[]}}}),p=initial.project.id;
 service.assets=new CreationAssets({store,root,data});assert.equal(service.assets.publish(user,p,Buffer.from(original),'native-identity.gd').id,oldHash);
 const flat=store.apply(user,p,'main',{transaction_id:'legacy-objects',base_revision:initial.branch.head,ops:legacy.resources.main.objects.map(object=>({type:'put_object',resource_id:'main',object_id:object.id,expected_version:null,object}))});
 const converted=await convertLegacyManifest({manifest:flat.branch.manifest,readAsset:async digest=>{assert.equal(digest,oldHash);return Buffer.from(original);}});
 const imported=await native.apply(user,p,'main',{transaction_id:'real-migration-import',base_revision:flat.revision,expected_head:flat.revision,ops:[{type:'import_native_project',files:[...converted.files].map(([path,bytes])=>({path,data_base64:bytes.toString('base64')}))}]});
 const r1=imported.revision,sourceBefore=imported.branch.manifest.source_files;
 const changed=await native.apply(user,p,'main',{transaction_id:'edit-migrated-script',base_revision:r1,ops:[{type:'put_source_file',path,expected_hash:oldHash,text:edited}]});
 const r2=changed.revision,files=changed.branch.manifest.source_files;
 assert.notEqual(r1,r2);assert.equal(files[path].hash,hash(edited));assert.equal(sourceBefore[path].hash,oldHash);
 const scene=changed.branch.manifest.resources.main.path;
 assert.equal(files[scene].hash,sourceBefore[scene].hash,'native script edit leaves scene bytes unchanged');
 assert.match(native.archive.read(files[scene]).toString(),new RegExp('script_hash = "'+oldHash+'"'),'stored compatibility field retains migration history');
 const report=await validator.validate(user,p,'main',{revision:r2,resource_id:'main'});
 assert.equal(report.status,'passed',JSON.stringify({error:report.error,report:report.report,process:report.process}));
 const states=report.report.telemetry.object_states;
 for(const [id,amount]of [['left',2],['right',3]]){
  assert.equal(states[id]?.logic?.native_value,41,'canonical execution uses edited logic for '+id);
  assert.equal(states[id].logic.instance_value,amount,'instance values remain separate');
  assert.ok(states[id].logic.ticks>=120);
 }
 assert.equal(report.report.revision,r2);assert.equal(report.report.runtime_entry,'res://atelier_runtime/standalone.gd');
 const registered=store.get('creator_verification_project',report.game_validation_job_id),fixedDirectory=resolve(data,registered.directory);
 const release=JSON.parse(readFileSync(join(fixedDirectory,'atelier_runtime/release.json'),'utf8'));
 assert.deepEqual(release.native_script_files[path],files[path]);
 assert.deepEqual(Object.keys(release.native_script_files).sort(),Object.keys(files).filter(path=>path.endsWith('.gd')).sort());
 assert.equal(release.source_identity,changed.branch.manifest.source_identity);
 assert.equal(readFileSync(join(fixedDirectory,path),'utf8'),edited);
 assert.match(readFileSync(join(fixedDirectory,scene),'utf8'),new RegExp('script_hash = "'+oldHash+'"'),'runtime binding does not rewrite PackedScene source');
 const evidence={at:new Date().toISOString(),r1,r2,path,old_hash:oldHash,actual_hash:files[path].hash,canonical_status:report.status,states,cases:[]};
 const successfulExecution=join(dirname(report.evidence.log),'runtime');
 for(const mode of ['tampered-script','missing-projection','missing-entry'])await t.test(mode,async()=>{
  const work=join(data,mode);cpSync(successfulExecution,work,{recursive:true});
  const releaseFile=join(work,'atelier_runtime/release.json');
  if(mode==='tampered-script')writeFileSync(join(work,path),edited+'# corruption after pin\n');
  else{const value=JSON.parse(readFileSync(releaseFile,'utf8'));if(mode==='missing-projection')delete value.native_script_files;else delete value.native_script_files[path];writeFileSync(releaseFile,JSON.stringify(value));}
  const cache=join(work,'.godot');mkdirSync(cache,{recursive:true});
  const environment=prepareExecutionEnvironment({directory:join(data,mode+'-execution'),readPaths:[work],writePaths:[cache]});
  const command=environment.command(validator.godot,['--headless','--path',work,'--fixed-fps','60','--','--release-scene=main'],{godot:true,projectPath:work});
  const result=await validator.run(command);
  assert.notEqual(result.code,0);assert.equal(result.timed_out,false);
  const line=result.output.split('\n').find(row=>row.startsWith('CANONICAL_GAME_VALIDATION '));assert.ok(line,result.output);
  const observed=JSON.parse(line.slice('CANONICAL_GAME_VALIDATION '.length));
  assert.equal(observed.ok,false);assert.ok(observed.error,'failure is explicit');assert.equal(result.entry_ready,null,'rejected integrity never reports a ready game');
  assert.match(observed.error,/脚本|script|SHA|摘要|固定|清单/i);
  evidence.cases.push({mode,status:'rejected',error:observed.error,code:result.code});
 });
 for(const [path,entry]of Object.entries(files))assert.equal(hash(native.archive.read(entry)),entry.hash,'fixed native archive remains unchanged: '+path);
 assert.equal(store.branchFor(user,p,'main').head,r2);assert.equal(store.readRevision(r1).manifest.source_files[path].hash,oldHash);
 for(const file of registered.files)assert.equal(hash(readFileSync(join(fixedDirectory,file.path))),file.sha256,'registered canonical inputs unchanged: '+file.path);
 const out=join(root,'.local/performance-20260909/independent');mkdirSync(out,{recursive:true});writeFileSync(join(out,'native-legacy-script-identity.json'),JSON.stringify(evidence,null,2));
});
