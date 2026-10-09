// Real CreationService -> immutable native project -> isolated Godot processes.
// The negative source intentionally corrupts its runtime scene ID; no command
// result, STANDALONE_READY line or observation is fabricated/replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {CreationService} from '../../services/creation/service.mjs';
import {hash} from '../../services/creation/schema.mjs';
const root=resolve(import.meta.dirname,'../..');
async function fixture(t,{corruptSceneIdentity=false}={}){
 const evidence=resolve(root,'.local/native-validation-tests');mkdirSync(evidence,{recursive:true});
 const data=mkdtempSync(resolve(evidence,'case-')),server=createServer();
 const previous={agent:process.env.WORLD_ATELIER_DISABLE_AGENT,worlds:process.env.WORLD_ATELIER_DISABLE_WORLDS};
 process.env.WORLD_ATELIER_DISABLE_AGENT='1';process.env.WORLD_ATELIER_DISABLE_WORLDS='1';
 let service;
 try{service=new CreationService({server,root,data,origin:'http://127.0.0.1:48921'});}
 finally{for(const [key,value]of [['WORLD_ATELIER_DISABLE_AGENT',previous.agent],['WORLD_ATELIER_DISABLE_WORLDS',previous.worlds]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
 t.after(async()=>{await service.close();assert.equal(server.listening,false,'test server never acquired a port');});
 const user=service.store.register({name:'native-validation-'+crypto.randomUUID(),password:'native-validation-isolated-password'}).user;
 const created=service.store.createProject(user,{name:'Native validation scene switch'},{entry_scene_id:'scene-a',resources:{'scene-a':{id:'scene-a',name:'A',kind:'scene',objects:[]}}}),project=created.project.id;
 const texts={
  'project.godot':'config_version=5\n[application]\nrun/main_scene="res://scenes/a.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'scene-a',resources:{'scene-a':{id:'scene-a',name:'A',kind:'scene',path:'scenes/a.tscn'},'scene-b':{id:'scene-b',name:'B',kind:'scene',path:'scenes/b.tscn'}}}),
  'scripts/a.gd':'extends Node3D\nvar frames=0\nfunc _ready():\n\tset_meta("authored_ready",true)\nfunc _physics_process(_delta):\n\tframes+=1\n\tif frames==8:\n\t\tget_node("/root/GameRuntime").call_deferred("open_scene","scene-b")\n',
  'scripts/b.gd':'extends Node2D\nvar frames=0\nfunc _ready():\n\tset_meta("authored_ready",true)\nfunc _physics_process(_delta):\n\tframes+=1\n'+(corruptSceneIdentity?'\tif frames==5:\n\t\tget_node("/root/GameRuntime").current_scene_id="scene-a"\n':''),
  'scenes/a.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/a.gd" id="S"]\n[node name="A" type="Node3D"]\nscript=ExtResource("S")\nmetadata/wa_node_id="a-root"\n',
  'scenes/b.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/b.gd" id="S"]\n[node name="B" type="Node2D"]\nscript=ExtResource("S")\nmetadata/wa_node_id="b-root"\n',
 };
 const imported=await service.committed(user,project,'main',{transaction_id:'native-input',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(texts).map(([path,text])=>({path,text}))}]});
 return {service,user,project,data,revision:imported.revision};
}
test('actual native validator accepts namespaced GameRuntime and authored PackedScene A to B lifecycle',{timeout:180000},async t=>{
 const f=await fixture(t),report=await f.service.validator.validate(f.user,f.project,'main',{revision:f.revision,resource_id:'scene-a'});
 writeFileSync(resolve(f.data,'native-positive-report.json'),JSON.stringify(report,null,2));
 assert.equal(report.status,'passed',JSON.stringify(report));assert.equal(report.report.runtime_entry,'res://atelier_runtime/standalone.gd');assert.equal(report.report.main_scene,'res://scenes/b.tscn');
 assert.equal(report.report.entry_resource_id,'scene-a');assert.equal(report.report.resource_id,'scene-b');assert.equal(report.report.scene_generation,2);assert.ok(report.report.observed_ticks>=120);assert.ok(report.report.tick>0&&report.report.tick<120);
 assert.deepEqual(report.report.observed_scenes.map(row=>row.resource_id),['scene-a','scene-b']);assert.ok(Object.values(report.report.canonical_identity_checks).every(Boolean));
 const runtime=report.process.find(row=>row.name==='runtime');assert.equal(runtime.code,0);assert.equal(runtime.had_error,false);assert.equal(runtime.scene_ready_count,2);assert.equal(runtime.entry_ready.scene_id,'scene-a');assert.equal(runtime.entry_ready.native_scene_path,'res://scenes/a.tscn');assert.equal(runtime.entry_ready.scene_generation,1);assert.equal(runtime.last_scene_ready.scene_id,'scene-b');assert.equal(runtime.last_scene_ready.native_scene_path,'res://scenes/b.tscn');assert.equal(runtime.last_scene_ready.scene_generation,2);
 assert.equal(f.service.store.branchFor(f.user,f.project,'main').head,f.revision);
 const registration=f.service.store.get('creator_verification_project',report.game_validation_job_id),directory=resolve(f.data,registration.directory);
 for(const file of registration.files)assert.equal(hash(readFileSync(resolve(directory,file.path))),file.sha256,'fixed verification input retained '+file.path);
 console.log('NATIVE_VALIDATION_POSITIVE '+f.data);
});
test('actual native validator rejects a registered scene ID that disagrees with the real final PackedScene',{timeout:180000},async t=>{
 const f=await fixture(t,{corruptSceneIdentity:true}),report=await f.service.validator.validate(f.user,f.project,'main',{revision:f.revision,resource_id:'scene-a'});
 writeFileSync(resolve(f.data,'native-negative-report.json'),JSON.stringify(report,null,2));
 assert.equal(report.status,'failed',JSON.stringify(report));assert.equal(report.report.ok,true,'the actual engine completed normal ticks; central identity validation rejects this report');assert.equal(report.report.completed,true);assert.ok(report.report.observed_ticks>=120);
 assert.equal(report.report.main_scene,'res://scenes/b.tscn');assert.equal(report.report.resource_id,'scene-a');assert.equal(report.report.canonical_identity_checks.current_scene,false);assert.equal(report.report.canonical_identity_checks.final_scene,false);
 const runtime=report.process.find(row=>row.name==='runtime');assert.equal(runtime.code,0);assert.equal(runtime.had_error,false);assert.equal(runtime.entry_ready.scene_id,'scene-a');assert.equal(runtime.last_scene_ready.scene_id,'scene-b');assert.equal(runtime.scene_ready_count,2);
 assert.equal(f.service.store.get('creator_verification',report.id).status,'failed');assert.equal(f.service.store.get('creator_game_verification',report.game_validation_job_id).status,'failed');assert.equal(f.service.store.branchFor(f.user,f.project,'main').head,f.revision);
 console.log('NATIVE_VALIDATION_NEGATIVE '+f.data);
});
