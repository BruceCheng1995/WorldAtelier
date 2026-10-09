import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createCreationBackup,restoreCreationBackup,verifyCreationBackup} from '../../tools/backup-creation.mjs';

// Real SQLite, filesystem and backup API. All runtime/evidence contents are
// explicitly synthetic storage fixtures, not an Agent or Godot test result.
const hash=value=>createHash('sha256').update(value).digest('hex');
const states=['queued','running','reviewing','waiting_input','passed','failed','blocked','superseded'];
function fixture(t,{automatic=true,statuses=states}={}){
  const directory=mkdtempSync(join(tmpdir(),'wa-auto-backup-test-')),data=join(directory,'live','creation'),runtimes=join(directory,'live','releases');mkdirSync(data,{recursive:true});
  let db=new DatabaseSync(join(data,'creation.sqlite'));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE documents(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id));CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT,body TEXT NOT NULL)');
  const put=(kind,value)=>db.prepare('INSERT OR REPLACE INTO documents VALUES (?,?,?)').run(kind,value.id,JSON.stringify(value));
  const revision='src-'+hash('SOURCE FIXTURE'),manifest={schema:'creation-flat-1',resources:{scene:{id:'scene',kind:'scene',objects:[]}}};put('creator_revision',{id:revision,project_id:'p',parents:[],manifest});put('creator_branch',{id:'p/main',head:revision});
  const sources=[{path:'test-source.gd',sha256:hash('SOURCE INVENTORY FIXTURE')}],files=['index.html','index.js','index.wasm','index.pck'].map(path=>({path,sha256:hash('SYNTHETIC RUNTIME '+path),bytes:Buffer.byteLength('SYNTHETIC RUNTIME '+path)}));
  const build=hash(JSON.stringify({sources,files}));mkdirSync(join(runtimes,build),{recursive:true});for(const file of files)writeFileSync(join(runtimes,build,file.path),'SYNTHETIC RUNTIME '+file.path);writeFileSync(join(runtimes,build,'manifest.json'),JSON.stringify({format:1,build_id:build,sources,files}));
  const evidenceBytes=Buffer.from('SYNTHETIC RETAINED AUTOMATIC EVIDENCE'),sha=hash(evidenceBytes),automaticEvidenceRoot=join(data,'automatic-evidence');
  const jobs=[],artifacts=[];
  if(automatic){mkdirSync(automaticEvidenceRoot);writeFileSync(join(automaticEvidenceRoot,sha),evidenceBytes);
    for(const [index,status]of statuses.entries()){
      const job={id:'job-'+index,project_id:'p',branch_id:'main',actor_id:'u',session_id:'session',goal_id:'goal',run_id:'run',status,revision,runtime_build_id:build,resource_ids:['scene'],reports:[],requests:status==='waiting_input'?[{request_key:'old-request'}]:[],checks:[],review_thread_id:index%2?'thread-'+index:null,created_at:1000+index};
      const artifact={id:'evidence-'+index,job_id:job.id,project_id:'p',session_id:'session',path:'results/check-'+index+'.json',sha256:sha,bytes:evidenceBytes.length};
      job.checks=[{description:'SYNTHETIC STORAGE FIXTURE',kind:'static',status:'passed',evidence:[artifact]}];put('creator_auto_verification',job);put('creator_auto_artifact',artifact);jobs.push(job);artifacts.push(artifact);
    }
  }
  const close=()=>{if(db){db.close();db=null;}};
  t.after(()=>{close();rmSync(directory,{recursive:true,force:true});});
  return {directory,data,runtimes,revision,build,sha,evidenceBytes,automaticEvidenceRoot,jobs,artifacts,put,close,
    remove:(kind,id)=>db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind,id),
    create:(out,extra={})=>createCreationBackup({data,out,runtimeRoot:runtimes,...extra})};
}
function rows(path,kind){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY id').all(kind).map(row=>JSON.parse(row.body));}finally{db.close();}}
const json=path=>JSON.parse(readFileSync(path,'utf8'));

test('automatic evidence is retained once, runtime is included from auto job only, and verify is read only',async t=>{
  const f=fixture(t),out=join(f.directory,'backup');const result=await f.create(out);
  assert.equal(result.automatic_artifact_count,states.length);assert.equal(result.runtime_count,1);
  const manifest=json(join(out,'backup.json')),retention=json(join(out,'retention.json'));
  assert.equal(manifest.format,'world-atelier-creation-backup-1');assert.equal(manifest.files.filter(file=>file.path.startsWith('data/automatic-evidence/')).length,1);
  assert.equal(retention.automatic_evidence.length,states.length);assert.deepEqual(retention.runtime_build_ids,[f.build]);
  const before=hash(readFileSync(join(out,'data/creation.sqlite')));assert.equal((await verifyCreationBackup({from:out})).ok,true);assert.equal(hash(readFileSync(join(out,'data/creation.sqlite'))),before);
  assert(!existsSync(join(out,'data/automatic-checks')));
});

test('restore preserves completed facts and evidence, blocks every unfinished auto job, and records new DB identity',async t=>{
  const f=fixture(t),out=join(f.directory,'backup'),restored=join(f.directory,'restored');await f.create(out);const originalHash=hash(readFileSync(join(out,'data/creation.sqlite')));
  f.close();rmSync(join(f.directory,'live'),{recursive:true});const result=await restoreCreationBackup({from:out,out:restored});
  assert.equal(result.recovered_automatic_check_count,4);assert.deepEqual(readFileSync(join(restored,'data/automatic-evidence',f.sha)),f.evidenceBytes);
  const recovered=rows(join(restored,'data/creation.sqlite'),'creator_auto_verification');
  for(const [index,job]of recovered.entries()){
    if(index<4){assert.equal(job.status,'blocked');assert.equal(job.restored_from_status,states[index]);assert.deepEqual(job.requests,[]);assert.equal(job.checks[0].status,'passed');}
    else assert.deepEqual(job,f.jobs[index]);
  }
  assert.equal(hash(readFileSync(join(out,'data/creation.sqlite'))),originalHash);
  const receipt=json(join(restored,'restore.json'));assert.equal(receipt.service_started,false);assert.equal(receipt.automatic_check_recovery.length,4);assert.equal(receipt.database_after_recovery.sha256,hash(readFileSync(join(restored,'data/creation.sqlite'))));
  assert.equal(json(join(restored,'retention.json')).automatic_evidence.length,states.length);
});

test('auto artifact or dependency corruption cannot publish backup or restore',async t=>{
  for(const damage of ['bytes','missing','identity','missing-artifact','wrong-job','missing-runtime'])await t.test(damage,async t=>{
    const f=fixture(t,{statuses:['passed']}),out=join(f.directory,'backup');
    if(damage==='bytes')writeFileSync(join(f.automaticEvidenceRoot,f.sha),'BAD');
    if(damage==='missing')unlinkSync(join(f.automaticEvidenceRoot,f.sha));
    if(damage==='identity')f.put('creator_auto_artifact',{...f.artifacts[0],bytes:999});
    if(damage==='missing-artifact')f.remove('creator_auto_artifact',f.artifacts[0].id);
    if(damage==='wrong-job')f.put('creator_auto_artifact',{...f.artifacts[0],job_id:'other'});
    if(damage==='missing-runtime')rmSync(join(f.runtimes,f.build),{recursive:true});
    await assert.rejects(f.create(out));assert.equal(existsSync(out),false);assert.equal(readdirSync(f.directory).some(name=>name.includes('.preparing-')),false);
  });
});

test('verify/restore reject omitted or tampered retained automatic bytes',async t=>{
  const f=fixture(t,{statuses:['passed']}),out=join(f.directory,'backup'),restored=join(f.directory,'restored');await f.create(out);
  const path=join(out,'data/automatic-evidence',f.sha);writeFileSync(path,'CORRUPTED');
  await assert.rejects(verifyCreationBackup({from:out}),/mismatch/);await assert.rejects(restoreCreationBackup({from:out,out:restored}),/mismatch/);assert.equal(existsSync(restored),false);
  writeFileSync(path,f.evidenceBytes);const manifest=json(join(out,'backup.json'));manifest.files=manifest.files.filter(file=>file.path!==`data/automatic-evidence/${f.sha}`);writeFileSync(join(out,'backup.json'),JSON.stringify(manifest));
  await assert.rejects(verifyCreationBackup({from:out}),/closure file missing/);await assert.rejects(restoreCreationBackup({from:out,out:restored}),/closure file missing/);assert.equal(existsSync(restored),false);
});

test('unsafe metadata and symlink automatic evidence are rejected',async t=>{
  for(const damage of ['path','symlink'])await t.test(damage,async t=>{
    const f=fixture(t,{statuses:['passed']}),out=join(f.directory,'backup');
    if(damage==='path'){const artifact={...f.artifacts[0],path:'../outside'};f.put('creator_auto_artifact',artifact);f.put('creator_auto_verification',{...f.jobs[0],checks:[{evidence:[artifact]}]});}
    else {const target=join(f.directory,'outside');writeFileSync(target,f.evidenceBytes);unlinkSync(join(f.automaticEvidenceRoot,f.sha));symlinkSync(target,join(f.automaticEvidenceRoot,f.sha));}
    await assert.rejects(f.create(out),/Unsafe|Symlink/);assert.equal(existsSync(out),false);
  });
});

test('legacy backup without auto records keeps original retention and byte-identical restored database',async t=>{
  const f=fixture(t,{automatic:false}),out=join(f.directory,'backup'),restored=join(f.directory,'restored');await f.create(out);
  const retention=json(join(out,'retention.json'));assert.equal(Object.hasOwn(retention,'automatic_evidence'),false);assert.equal(Object.hasOwn(retention,'automatic_check_ids'),false);
  const before=readFileSync(join(out,'data/creation.sqlite'));const result=await restoreCreationBackup({from:out,out:restored});assert.deepEqual(readFileSync(join(restored,'data/creation.sqlite')),before);assert.equal(result.recovered_automatic_check_count,0);
  assert.equal(Object.hasOwn(json(join(restored,'restore.json')),'database_after_recovery'),false);
});

test('fixed online snapshot excludes automatic evidence written after snapshot',async t=>{
  const f=fixture(t,{statuses:['passed']}),out=join(f.directory,'backup');let late;
  await f.create(out,{onSnapshot(){const bytes=Buffer.from('LATE EVIDENCE');late=hash(bytes);writeFileSync(join(f.automaticEvidenceRoot,late),bytes);f.put('creator_auto_artifact',{...f.artifacts[0],id:'late-evidence',sha256:late,bytes:bytes.length});}});
  assert.equal(rows(join(out,'data/creation.sqlite'),'creator_auto_artifact').length,1);assert.equal(existsSync(join(out,'data/automatic-evidence',late)),false);
});

test('standalone verify CLI and explicit automatic evidence root use retained bytes only',async t=>{
  const f=fixture(t,{statuses:['passed']}),out=join(f.directory,'backup'),external=join(f.directory,'external');mkdirSync(external);writeFileSync(join(external,f.sha),f.evidenceBytes);rmSync(f.automaticEvidenceRoot,{recursive:true});
  const cli=resolve(import.meta.dirname,'../../tools/backup-creation.mjs');
  const created=JSON.parse(execFileSync(process.execPath,[cli,'create',`--data=${f.data}`,`--out=${out}`,`--runtime-root=${f.runtimes}`,`--automatic-evidence-root=${external}`],{encoding:'utf8'}));assert.equal(created.automatic_artifact_count,1);
  const verified=JSON.parse(execFileSync(process.execPath,[cli,'verify',`--from=${out}`],{encoding:'utf8'}));assert.equal(verified.ok,true);
});

test('previous canonical v1 backups remain verifiable without inventing verification project inventories',async t=>{
  const f=fixture(t,{statuses:['passed']}),out=join(f.directory,'previous-canonical-v1');await f.create(out);
  const retention=json(join(out,'retention.json'));retention.canonical_game.policy='immutable_indexed_game_projects_and_artifacts_v1';delete retention.canonical_game.verification_projects;delete retention.canonical_game.unregistered_verification_jobs;
  const bytes=Buffer.from(JSON.stringify(retention,null,2)+'\n');writeFileSync(join(out,'retention.json'),bytes);
  const manifest=json(join(out,'backup.json')),entry=manifest.files.find(file=>file.path==='retention.json');entry.bytes=bytes.length;entry.sha256=hash(bytes);writeFileSync(join(out,'backup.json'),JSON.stringify(manifest,null,2)+'\n');
  assert.equal((await verifyCreationBackup({from:out})).ok,true);const restored=join(f.directory,'v1-restored');await restoreCreationBackup({from:out,out:restored});assert.deepEqual(rows(join(restored,'data/creation.sqlite'),'creator_auto_verification'),f.jobs);
});
