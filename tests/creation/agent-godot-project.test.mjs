import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,unlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {CreationService} from '../../services/creation/service.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {commitNativeWorkspaceApply} from '../../services/creation/native-agent-workspace.mjs';
import {encodeAgentToolResult} from '../../services/creation/agent-tool-result.mjs';
import {assetFixturePNG,assetFixtureGLB} from './asset-test-fixtures.mjs';

test('real Godot project retains unfinished binary edits across turns, commits exact files, and imports PNG and GLB',{timeout:180000},async t=>{
 const data=mkdtempSync(join(tmpdir(),'atelier-agent-text-project-')),root=process.cwd(),server=createServer();
 const service=new CreationService({server,root,data,origin:'http://127.0.0.1:48921'});
 t.after(async()=>{await service.close();server.close();rmSync(data,{recursive:true,force:true});});
 const user=service.store.register({name:'text-project-author',password:'isolated-test-password'}).user;
 const text={
  'project.godot':'config_version=5\n[application]\nconfig/name="Text project test"\nrun/main_scene="res://scenes/main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  'scenes/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scripts/main.gd" id="1"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\nmetadata/wa_node_id = "main"\n',
  'scripts/main.gd':'extends Node2D\n@export var speed: float = 3.0\n',
  '.atelier/catalog.json':JSON.stringify({format:1,entry_scene_id:'main',resources:{main:{id:'main',kind:'scene',name:'Main',path:'scenes/main.tscn'}}})};
 const binary=Buffer.from([0,255,128,0,17,255]),modifiedBinary=Buffer.from([0,254,129,0,18,253]),png=assetFixturePNG(),glb=assetFixtureGLB(root);
 const files=Object.fromEntries(Object.entries(text).map(([path,text])=>[path,service.native.archive.put(text)]));files['assets/opaque.dat']=service.native.archive.put(binary);files['assets/remove.dat']=service.native.archive.put(binary);
 const manifest=await service.native.inspectFiles(files,{assignIds:true});const created=service.store.createProject(user,{name:'Text project'},manifest),p=created.project.id;
 const session=service.store.createSession(user,p,'main',{title:'Project editing'});const cwd=service.agent.workspace(session);
 const run={id:'run-1',session_id:session.id,project_id:p,branch_id:'main',owner_user_id:user.id,input_revision:created.branch.head,lease_generation:1,status:'running',created_at:Date.now()};service.store.put('creator_run',run);
 const options={session,run,cwd,guard:()=>{}};
 const prepared=await service.environments.prepareForRun(options),project=prepared.editable_project_directory;
 assert.ok(readFileSync(join(project,'project.godot'),'utf8').includes('GameRuntime'));
 assert.deepEqual(readFileSync(join(project,'assets/opaque.dat')),binary);
 assert.doesNotMatch(readFileSync(join(project,'atelier_runtime/source-manifest.json'),'utf8'),/native_nodes|data_base64/);
 assert.equal(JSON.parse(readFileSync(join(cwd,'workspace.json'),'utf8')).godot_project.project_directory,project);
 assert.equal((await service.environments.prepare(options)).editable_project_directory,project,'repeat prepare reuses registered project');
 writeFileSync(join(project,'scripts/main.gd'),text['scripts/main.gd']+'func authored_answer() -> int:\n\treturn 42\nfunc _ready() -> void:\n\tvar texture: Texture2D = load("res://assets/generated.png")\n\tvar model: PackedScene = load("res://assets/imported.glb")\n\tassert(texture != null and texture.get_width() >= 2 and texture.get_height() == 2)\n\tassert(model != null)\n\tvar instance: Node = model.instantiate()\n\tassert(instance != null)\n\tinstance.free()\n\tprint("AGENT_IMPORTED_ASSETS_OK width=", texture.get_width())\n');
 writeFileSync(join(project,'assets/opaque.dat'),modifiedBinary);unlinkSync(join(project,'assets/remove.dat'));
 writeFileSync(join(project,'assets/generated.png'),png);writeFileSync(join(project,'assets/imported.glb'),glb);
 const next={...run,id:'run-2',created_at:Date.now()+1};service.store.put('creator_run',{...run,status:'completed'});service.store.put('creator_run',next);
 const retained=await service.environments.prepareForRun({...options,run:next});assert.equal(retained.editable_project_directory,project);assert.equal(retained.retained_local_edits,true);assert.notEqual(retained.id,prepared.id);
 assert.match(readFileSync(join(project,'scripts/main.gd'),'utf8'),/return 42/);
 assert.deepEqual(readFileSync(join(project,'assets/opaque.dat')),modifiedBinary);assert.equal(existsSync(join(project,'assets/remove.dat')),false);
 assert.deepEqual(readFileSync(join(project,'assets/generated.png')),png);assert.deepEqual(readFileSync(join(project,'assets/imported.glb')),glb);
 const context=service.environments.context({...options,run:next,attachments:[],objective:'finish text edit'});const ctx=JSON.parse(readFileSync(context.manifest));assert.equal(ctx.godot_project.environment_id,retained.id);
 const projection=readFileSync(join(cwd,'context/run-2/source-manifest.json'),'utf8');assert.doesNotMatch(projection,/native_nodes|data_base64/);
 const result=await commitNativeWorkspaceApply({service,user,session,run:next,cwd,input:{transaction_id:'text-project-submit',base_revision:retained.source_revision,ops:[{type:'submit_native_workspace',environment_id:retained.id,path:retained.submit_path}]},guard:()=>{},signal:new AbortController().signal});
 const after=result.result.branch.manifest;
 for(const [path,bytes] of [['assets/opaque.dat',modifiedBinary],['assets/generated.png',png],['assets/imported.glb',glb]]){
  assert.equal(after.source_files[path].hash,hash(bytes));assert.deepEqual(service.native.archive.read(after.source_files[path]),bytes);
 }
 assert.equal(after.source_files['assets/remove.dat'],undefined);
 assert.match(service.native.archive.read(after.source_files['scripts/main.gd']).toString('utf8'),/return 42/);
 assert.equal(result.workspace_submission.changed_files.length,5);
 const receipt=JSON.stringify(encodeAgentToolResult({cwd,value:{...result.result,workspace_submission:result.workspace_submission}}));
 for(const bytes of [png,glb,modifiedBinary])assert.equal(receipt.includes(bytes.toString('base64')),false,'the Agent receipt must not expose asset bytes');
 writeFileSync(join(project,'scripts/main.gd'),readFileSync(join(project,'scripts/main.gd'),'utf8').replace('return 42','return 43'));
 const widerPNG=assetFixturePNG(3);writeFileSync(join(project,'assets/generated.png'),widerPNG);
 const third={...next,id:'run-3',input_revision:result.result.revision};service.store.put('creator_run',{...next,status:'completed'});service.store.put('creator_run',third);
 const continued=await service.environments.prepareForRun({...options,run:third});
 assert.equal(continued.source_revision,result.result.revision);
 assert.equal(continued.retained_local_edits,true);
 assert.match(readFileSync(join(continued.editable_project_directory,'scripts/main.gd'),'utf8'),/return 43/);
 assert.deepEqual(readFileSync(join(continued.editable_project_directory,'assets/generated.png')),widerPNG,'post-submit asset edits survive the next run');
 const saved=await commitNativeWorkspaceApply({service,user,session,run:third,cwd,input:{transaction_id:'text-project-submit-again',base_revision:continued.source_revision,ops:[{type:'submit_native_workspace',environment_id:continued.id,path:continued.submit_path}]},guard:()=>{}});
 assert.equal(saved.workspace_submission.changed_files.length,2);
 assert.deepEqual(service.native.archive.read(saved.result.branch.manifest.source_files['assets/generated.png']),widerPNG);
 const fourth={...third,id:'run-4',input_revision:saved.result.revision};service.store.put('creator_run',{...third,status:'completed'});service.store.put('creator_run',fourth);
 const refreshed=await service.environments.prepareForRun({...options,run:fourth});
 assert.equal(refreshed.source_revision,saved.result.revision);
 assert.notEqual(refreshed.retained_local_edits,true,'saved edits are not treated as unfinished forever');
 assert.match(readFileSync(join(refreshed.editable_project_directory,'scripts/main.gd'),'utf8'),/return 43/);
 assert.deepEqual(readFileSync(join(refreshed.editable_project_directory,'assets/opaque.dat')),modifiedBinary);
 assert.deepEqual(readFileSync(join(refreshed.editable_project_directory,'assets/generated.png')),widerPNG);
 assert.deepEqual(readFileSync(join(refreshed.editable_project_directory,'assets/imported.glb')),glb);
 const smoke=await service.environments.test({...options,run:fourth,input:{environment_id:refreshed.id}});
 assert.equal(smoke.status,'passed',smoke.error+'\n'+smoke.output);
 assert.match(smoke.output,/AGENT_IMPORTED_ASSETS_OK width=3/);
});
