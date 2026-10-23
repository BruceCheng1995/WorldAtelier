/** Actual backup/verify/restore of new persistent record families. Source
 * indexes/build metadata are explicit fixtures; frame bytes and all archived
 * blobs are real. No runtime, browser or model acceptance is inferred. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeSourceArchive,nativeSourceIdentity} from '../../services/creation/native-source.mjs';
import {NativeTransactions} from '../../services/creation/native-transactions.mjs';
import {NativeMerges} from '../../services/creation/native-merge.mjs';
import {NativeOffline} from '../../services/creation/native-offline.mjs';
import {PlayObservations} from '../../services/creation/play-observations.mjs';
import {SessionImages} from '../../services/creation/session-images.mjs';
import {createCreationBackup,verifyCreationBackup,restoreCreationBackup} from '../../tools/backup-creation.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {assetFixturePNG} from './asset-test-fixtures.mjs';
import {Evidence,ROOT} from './next-wave-test-support.mjs';

const evidence=new Evidence('retention-independent',{layers:['A'],scope:'Actual private backup CLI implementation, SQLite restore, pending native upload and runtime template retention, immutable observation/image bytes. Explicit index/build metadata fixtures; no engine or model.'});
const root=mkdtempSync(join(tmpdir(),'atelier-next-wave-retention-')),data=join(root,'data');mkdirSync(data);
let original,restored,owner,p,sid,observation,workspace,upload,runtime,completed=false;
const png=assetFixturePNG(2),received=Buffer.from([0,4,128,255,42]),pending=Buffer.from([3,7,9,13]);
function openService(directory){
  const store=new CreationStore(join(directory,'creation.sqlite')),archive=new NativeSourceArchive(join(directory,'native-source/objects'));
  const manifest=files=>({schema:'creation-native-1',source_files:files,source_identity:nativeSourceIdentity(files),index_source_identity:nativeSourceIdentity(files),entry_scene_id:'entry',resources:{entry:{id:'entry',kind:'scene',name:'Fixture source index',path:'scene.tscn',native_nodes:[]}}});
  const native={archive,inspectFiles:async files=>manifest(files)};native.transactions=new NativeTransactions({store,archive,prepare:()=>{throw Error('This backup test does not run Godot.');}});
  const service={root:ROOT,data:directory,store,native,realtime:{committed(){}},builds:{forUser(user,id){const session=store.get('creator_session',sid);store.branchFor(user,session.project_id,session.branch_id);assert.equal(id,'build-retention-fixture');return{id,project_id:p,branch_id:'main',source_revision:store.branchFor(user,p,'main').head,status:'completed',canonical_identity:'c'.repeat(64)};}}};
  service.nativeMerges=new NativeMerges({store,native});service.nativeOffline=new NativeOffline({service});service.sessionImages=new SessionImages({store,data:directory});service.observations=new PlayObservations({service});
  service.close=async()=>{service.observations.close();await service.nativeOffline.close();await native.transactions.close();store.close();};
  return{service,store,archive,manifest};
}
try{
  original=openService(data);owner=original.store.register({name:'Retention owner',password:'independent-retention-password'}).user;
  const files=Object.fromEntries(Object.entries({'project.godot':'config_version=5\n[application]\nconfig/name="Retention fixture"\nrun/main_scene="res://scene.tscn"\n','scene.tscn':'[gd_scene format=3]\n[node name="Root" type="Node2D"]\nmetadata/wa_node_id="root"\n'}).map(([path,text])=>[path,original.archive.put(text)]));
  const created=original.store.createProject(owner,{name:'Retention fixture'},original.manifest(files));p=created.project.id;sid=original.store.createSession(owner,p,'main',{title:'Private retention source',visibility:'private'}).id;
  await evidence.check('R01','Prepare a real partial upload, cached runtime inputs and an immutable image observation',['A'],async receipt=>{
    workspace=original.service.nativeOffline.create(owner,{request_id:'retention-workspace',project_id:p,branch_id:'main'});
    const changed={...workspace.files,'received.bin':{hash:hash(received),size:received.length},'pending.bin':{hash:hash(pending),size:pending.length}};
    upload=original.service.nativeOffline.beginUpload(owner,workspace.workspace_id,{request_id:'partial-retained-upload',base_revision:workspace.base_revision,workspace_version:workspace.workspace_version,files:changed});
    original.service.nativeOffline.putBlob(owner,workspace.workspace_id,upload.upload_id,hash(received),received);
    runtime=await original.service.nativeOffline.runtime(owner,workspace.workspace_id,{revision:workspace.revision});
    const scope={project_id:p,branch_id:'main',source_revision:created.branch.head,build_id:'build-retention-fixture',canonical_identity:'c'.repeat(64),runtime_instance_id:'fixture-window',resource_id:'entry',scene_generation:1,session_kind:'local_preview'};
    observation=original.service.observations.capture(owner,sid,{protocol:'wa-play-context-1',request_id:'retention-observation',scope,captured_at:Date.now(),window:{requested_seconds:60,start_ms:0,end_ms:60000},events:[],snapshot:{objects:[]},focus:{kind:'screen_point',point:[0.2,0.3],frame_id:'retained-frame'},frames:[{id:'retained-frame',at_ms:59000,captured_at:Date.now(),resource_id:'entry',scene_generation:1,data_url:'data:image/png;base64,'+png.toString('base64')}],gaps:[]});
    receipt.workspace_id=workspace.workspace_id;receipt.upload_id=upload.upload_id;receipt.runtime_id=runtime.runtime_id;receipt.observation_id=observation.observation_id;
    const view=original.service.nativeOffline.uploadView(owner,workspace.workspace_id,upload.upload_id);assert.deepEqual(view.missing.map(entry=>entry.hash),[hash(pending)]);
  });
  await original.service.close();original=null;

  const backup=join(root,'backup'),restore=join(root,'restored');
  await evidence.check('R02','Create and independently verify the actual complete backup, then restore to a new private root',['A'],async receipt=>{
    const createdBackup=await createCreationBackup({data,out:backup});const verified=await verifyCreationBackup({from:backup});const result=await restoreCreationBackup({from:backup,out:restore});
    assert.equal(createdBackup.ok,true);assert.equal(verified.ok,true);assert.equal(result.ok,true);receipt.created=createdBackup;receipt.verified=verified;receipt.restored=result;
    const retention=JSON.parse(readFileSync(join(backup,'retention.json'),'utf8'));evidence.json('retention.json',retention);
    assert.ok(retention.native_source?.offline_workspaces?.runtimes?.some(row=>row.id===runtime.runtime_id));
    assert.ok(retention.native_source?.offline_workspaces?.uploads?.some(row=>row.id===upload.upload_id));
  });

  await evidence.check('R03','Restored observation images, uncommitted bytes and raw runtime templates retain exact hashes',['A'],async receipt=>{
    restored=openService(join(restore,'data'));
    const after=restored.service.observations.read(owner,sid,observation.observation_id);assert.equal(after.sha256,observation.sha256);
    assert.deepEqual(restored.service.observations.image(owner,sid,observation.observation_id,'retained-frame').bytes,png);
    assert.deepEqual(restored.service.nativeOffline.blob(owner,workspace.workspace_id,hash(received),{upload_id:upload.upload_id}),received);
    const runtimeRecord=restored.store.get('creator_native_workspace_runtime',runtime.runtime_id);assert.equal(runtimeRecord.runtime_hash,runtime.runtime_hash);assert.equal(runtimeRecord.policy.sha256,runtime.policy.sha256);
    for(const files of [runtime.template_files,runtime.adapter_files])for(const entry of Object.values(files))assert.deepEqual(restored.archive.read(entry),readFileSync(join(data,'native-source/objects',entry.hash.slice(0,2),entry.hash)));
    const missing=restored.service.nativeOffline.uploadView(owner,workspace.workspace_id,upload.upload_id).missing;assert.deepEqual(missing.map(entry=>entry.hash),[hash(pending)]);
    receipt.retained_template_count=Object.keys(runtime.template_files).length;receipt.missing_upload_hashes=missing.map(entry=>entry.hash);receipt.observation_sha256=after.sha256;
  });

  await evidence.check('R04','The restored partial upload resumes and commits through the same guarded source transaction',['A'],async receipt=>{
    restored.service.nativeOffline.putBlob(owner,workspace.workspace_id,upload.upload_id,hash(pending),pending);
    const prepared=await restored.service.nativeOffline.prepare(owner,workspace.workspace_id,upload.upload_id),committed=await restored.service.nativeOffline.commit(owner,workspace.workspace_id,upload.upload_id,{preview_id:prepared.preview.id});
    assert.equal(committed.status,'committed');const revision=restored.store.get('creator_revision',committed.result.revision);assert.deepEqual(restored.archive.read(revision.manifest.source_files['received.bin']),received);assert.deepEqual(restored.archive.read(revision.manifest.source_files['pending.bin']),pending);
    receipt.committed_revision=committed.result.revision;receipt.workspace_version=committed.snapshot.workspace_version;
  });
  completed=true;
}catch(error){evidence.report.errors.push({message:error.message,stack:error.stack,details:error.details});console.error(error.stack);process.exitCode=1;}
finally{await original?.service.close();await restored?.service.close();evidence.report.retained_test_data=root;evidence.finish({completed});console.log('NEXT_WAVE_EVIDENCE '+evidence.directory);}
