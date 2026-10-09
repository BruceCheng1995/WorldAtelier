import { canonicalGameRetention } from './canonical-game-retention.mjs';
import { nativeSourceRetention } from './native-source-retention.mjs';
import {DatabaseSync, backup} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, renameSync, rmSync, writeSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const FORMAT = 'world-atelier-creation-backup-1';
const HEX = /^[a-f0-9]{64}$/;
const AUTO_ACTIVE = new Set(['queued','running','reviewing','waiting_input']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const insist = (ok, message) => {if (!ok) throw new Error(message);};

function relativePath(value) {
  insist(typeof value === 'string' && value.length && !isAbsolute(value) && !/[\\\0]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe backup path');
  return value;
}
function regularPath(root, relative) {
  const parts = relativePath(relative).split('/');
  let path = resolve(root);
  insist(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Storage root must be a directory, not a symlink');
  for (let i = 0; i < parts.length; i++) {
    path = resolve(path, parts[i]);
    const stat = lstatSync(path);
    insist(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()), 'Symlink or non-file rejected');
  }
  return path;
}
function syncDirectory(path) {const fd = openSync(path, constants.O_RDONLY); try {fsyncSync(fd);} finally {closeSync(fd);}}
function privateWrite(path, bytes) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const fd = openSync(path, 'wx', 0o600);
  try {writeFileSync(fd, bytes); fsyncSync(fd);} finally {closeSync(fd);}
  syncDirectory(dirname(path));
}
function copyVerified(sourceRoot, sourceRelative, destination, expected = {}) {
  const source = regularPath(sourceRoot, sourceRelative);
  if (destination) mkdirSync(dirname(destination), {recursive: true, mode: 0o700});
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output, size = 0;
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    insist(fstatSync(input).isFile(), 'Source is not a regular file');
    if (destination) output = openSync(destination, 'wx', 0o600);
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null); if (!count) break;
      hash.update(buffer.subarray(0, count)); size += count;
      if (output !== undefined) {let offset = 0; while (offset < count) offset += writeSync(output, buffer, offset, count - offset);}
    }
    const sha256 = hash.digest('hex');
    insist(expected.sha256 === undefined || expected.sha256 === sha256, `SHA-256 mismatch: ${sourceRelative}`);
    insist(expected.bytes === undefined || expected.bytes === size, `Byte length mismatch: ${sourceRelative}`);
    if (output !== undefined) fsyncSync(output);
    return {sha256, bytes: size};
  } finally {
    closeSync(input); if (output !== undefined) closeSync(output);
    if (destination) syncDirectory(dirname(destination));
  }
}

function snapshotRows(path) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    insist(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'SQLite snapshot integrity check failed');
    return db.prepare('SELECT kind,id,body FROM documents ORDER BY kind,id').all().map(row => ({kind: row.kind, id: row.id, value: JSON.parse(row.body)}));
  } finally {db.close();}
}

function sourceAssets(manifest) {
  const found = new Map();
  const add = (value, extension) => {if (value == null) return; insist(HEX.test(value), 'Invalid source asset digest'); found.set(`${value}.${extension}`, {id: value, ext: extension});};
  const model = node => {
    add(node?.model_hash, 'glb');
    if (node?.model_url != null) {const match = /^\/preview-assets\/([a-f0-9]{64})\.glb$/.exec(node.model_url); insist(match, 'Invalid source model URL'); add(match[1], 'glb');}
  };
  const behaviors = list => {for (const b of list ?? []) {add(b.script_hash, 'gd'); if (b.script_url != null) {const match = /^\/preview-assets\/([a-f0-9]{64})\.gd$/.exec(b.script_url); insist(match, 'Invalid source behavior URL'); add(match[1], 'gd');}}};
  for (const doc of [...Object.values(manifest.resources ?? {}), ...Object.values(manifest.prefab_revisions ?? {})]) {
    for (const node of [...(doc.objects ?? []), ...Object.values(doc.nodes ?? {})]) {model(node); behaviors(node.components?.behaviors);}
    for (const instance of Object.values(doc.instances ?? {})) for (const override of instance.overrides ?? []) {
      if (override.path?.length === 1 && ['model_hash','model_url'].includes(override.path[0])) model({[override.path[0]]: override.value});
      if (override.path?.join('.') === 'components.behaviors') behaviors(override.value);
    }
  }
  return [...found.values()].sort((a, b) => `${a.id}.${a.ext}`.localeCompare(`${b.id}.${b.ext}`));
}

function sessionImageFiles(rows){
  const files=new Map();
  for(const row of rows){
    const attachments=row.kind==='creator_session'?row.value.draft_attachments:row.kind==='creator_message'?row.value.attachments:[];
    for(const a of attachments??[])if(a.kind==='image'){
      insist(HEX.test(a.sha256)&&Number.isSafeInteger(a.bytes)&&a.bytes>0&&a.bytes<=5*1024*1024&&['image/png','image/jpeg','image/webp'].includes(a.mime),'Invalid session image attachment');
      const previous=files.get(a.sha256);insist(!previous||previous.bytes===a.bytes,'Session image metadata differs');
      files.set(a.sha256,{path:`data/session-images/${a.sha256}`,sha256:a.sha256,bytes:a.bytes});
    }
  }
  return [...files.values()];
}

function inventory(rows,{retainCanonical=true,canonicalVerification=true,storageRoot=null}={}) {
  const list = kind => rows.filter(r => r.kind === kind).map(r => r.value);
  const assets = list('creator_asset'), revisions = list('creator_revision'), reviews = list('creator_goal_review');
  const captures = list('creator_goal_review_capture'), artifacts = list('creator_goal_review_artifact');
  const automaticChecks = list('creator_auto_verification'), automaticArtifacts = list('creator_auto_artifact');
  const nativeSources=nativeSourceRetention(rows);
  const marketObjects=new Map();
  for(const record of [...list('market_version'),...list('market_asset')])for(const file of Object.values(record.files??{})){
    insist(HEX.test(file.hash)&&Number.isSafeInteger(file.size)&&file.size>=0,'Invalid market file identity');
    const old=marketObjects.get(file.hash);insist(!old||old.bytes===file.size,'Conflicting market object size');
    marketObjects.set(file.hash,{path:`market/objects/${file.hash.slice(0,2)}/${file.hash}`,sha256:file.hash,bytes:file.size});
  }
  const registered = new Map(assets.map(a => [`${a.id}.${a.ext}`, a]));
  for (const asset of assets) insist(HEX.test(asset.id) && ['glb','gd'].includes(asset.ext) && Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && (asset.hash == null || asset.hash === asset.id), 'Invalid registered creation asset');
  const closure = revisions.map(r => {
    insist(typeof r.id === 'string' && r.manifest, 'Invalid source revision');
    const refs = sourceAssets(r.manifest);
    for (const a of refs) insist(registered.has(`${a.id}.${a.ext}`), `Source asset registration missing: ${a.id}.${a.ext}`);
    return {revision_id: r.id, project_id: r.project_id, parents: r.parents ?? [], asset_refs: refs};
  });
  const nativeSharedBuilds = new Map(list('creator_build').filter(job=>job.purpose==='native_shared').map(job=>[job.canonical_identity,job]));
  const runtimeIds = new Set(), revisionIds = new Set(revisions.map(r => r.id));
  function scan(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'runtime_build_id' && child != null) {insist(HEX.test(child), 'Invalid retained runtime build ID'); if(!nativeSharedBuilds.has(child))runtimeIds.add(child);}
      if (['revision','source_revision','input_revision','base_revision'].includes(key) && typeof child === 'string' && child.startsWith('src-')) insist(revisionIds.has(child), `Referenced source revision is missing: ${child}`);
    }
  }
  // Only domain records with owned version fields; arbitrary user message text
  // and behavior properties must not become runtime/file references.
  for (const kind of ['creator_world','creator_world_failure','creator_verification','creator_delivery','creator_inspection','creator_run','creator_goal_review','creator_goal_review_capture','creator_goal_review_artifact','creator_goal_review_evidence','creator_auto_verification']) for (const row of list(kind)) {
    scan(row); scan(row.pin); scan(row.run_identity); scan(row.failure);
    if (kind === 'creator_goal_review') {for (const item of [...row.verifications, ...row.deliveries]) scan(item);}
    if (kind === 'creator_goal_review_evidence') for (const a of row.artifacts ?? []) scan(a.pin);
    if (kind === 'creator_run') for (const revision of row.changes ?? []) insist(revisionIds.has(revision), 'Run output source revision is missing');
    if (kind === 'creator_auto_verification') for (const report of row.reports ?? []) scan(report);
  }
  for (const branch of list('creator_branch')) insist(revisionIds.has(branch.head), 'Branch source head is missing');
  for (const r of revisions) for (const parent of r.parents ?? []) insist(revisionIds.has(parent), 'Source parent revision is missing');
  const artifactIds = new Set(artifacts.map(a => a.id));
  for (const capture of captures) insist(artifactIds.has(capture.baseline_ref), 'Capture baseline artifact is missing');
  for (const evidence of list('creator_goal_review_evidence')) for (const artifact of evidence.artifacts ?? []) insist(artifactIds.has(artifact.ref), 'Review evidence artifact is missing');
  for (const a of artifacts) insist(a.capture_status === 'retained' && HEX.test(a.storage_key) && a.storage_key === a.sha256 && Number.isSafeInteger(a.byte_length) && a.byte_length > 0, 'Invalid retained evidence identity');
  const automaticJobs = new Map(automaticChecks.map(job => [job.id,job])), automaticById = new Map(automaticArtifacts.map(artifact => [artifact.id,artifact]));
  for (const artifact of automaticArtifacts) {
    const job = automaticJobs.get(artifact.job_id);
    insist(typeof artifact.id === 'string' && artifact.id.length && job, 'Automatic evidence job is missing');
    insist(artifact.project_id === job.project_id && (artifact.session_id ?? null) === (job.session_id ?? null), 'Automatic evidence scope mismatch');
    relativePath(artifact.path);
    insist(HEX.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0, 'Invalid automatic evidence identity');
  }
  for (const job of automaticChecks) for (const check of job.checks ?? []) for (const evidence of check.evidence ?? []) {
    const artifact = automaticById.get(evidence.id);
    insist(artifact && artifact.job_id === job.id, 'Automatic check evidence artifact is missing');
    insist(['job_id','project_id','session_id','path','sha256','bytes'].every(key => (evidence[key] ?? null) === (artifact[key] ?? null)), 'Automatic check evidence identity mismatch');
  }
  return {assets, artifacts, automaticChecks, automaticArtifacts, retention: {
    policy: 'all_registered_assets_and_all_persisted_source_revisions',
    ...(nativeSources?{native_source:nativeSources}:{}),
    ...(marketObjects.size?{asset_market:{policy:'all_published_versions',objects:[...marketObjects.values()].sort((a,b)=>a.path.localeCompare(b.path))}}:{}),
    ...(retainCanonical?{canonical_game:canonicalGameRetention(rows,{includeVerification:canonicalVerification,storageRoot})}:{}),
    source_revision_ids: [...revisionIds].sort(), source_asset_closure: closure,
    runtime_build_ids: [...runtimeIds].sort(), runtime_sources: [],
    review_ids: reviews.map(r => r.id), capture_ids: captures.map(c => c.id),
    review_evidence: artifacts.map(a => ({id: a.id, capture_id: a.capture_id, review_id: a.pin?.review_id, storage_key: a.storage_key, sha256: a.sha256, byte_length: a.byte_length})),
    ...(automaticChecks.length || automaticArtifacts.length ? {
      automatic_check_ids: automaticChecks.map(job => job.id),
      automatic_evidence: automaticArtifacts.map(artifact => ({id:artifact.id,job_id:artifact.job_id,project_id:artifact.project_id,session_id:artifact.session_id ?? null,path:artifact.path,sha256:artifact.sha256,bytes:artifact.bytes})),
    } : {}),
  }};
}

function runtimeEntries(root, buildId) {
  const path = regularPath(root, `${buildId}/manifest.json`), raw = readFileSync(path), manifest = JSON.parse(raw);
  insist(manifest.format === 1 && manifest.build_id === buildId && Array.isArray(manifest.files) && Array.isArray(manifest.sources), 'Invalid runtime manifest');
  insist(digest(JSON.stringify({sources: manifest.sources, files: manifest.files})) === buildId, 'Runtime build identity mismatch');
  const paths = new Set();
  for (const file of manifest.files) {
    relativePath(file.path); insist(file.path !== 'manifest.json' && !paths.has(file.path) && HEX.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'Invalid runtime file entry'); paths.add(file.path);
  }
  for (const required of ['index.html','index.js','index.wasm','index.pck']) insist(paths.has(required), 'Required Web runtime file missing from manifest');
  for (const source of manifest.sources) {relativePath(source.path); insist(HEX.test(source.sha256), 'Invalid runtime source inventory');}
  const capabilitySource = manifest.sources.filter(f => f.path === 'runtime_capabilities.json');
  const capabilityFile = manifest.files.find(f => f.path === 'runtime_capabilities.json');
  if (manifest.capabilities !== undefined || capabilitySource.length || capabilityFile) {
    insist(capabilitySource.length === 1 && capabilityFile && manifest.capabilities !== undefined && capabilitySource[0].sha256 === capabilityFile.sha256, 'Runtime capability source/file binding mismatch');
    const bytes = readFileSync(regularPath(root, `${buildId}/runtime_capabilities.json`));
    insist(digest(bytes) === capabilityFile.sha256 && bytes.length === capabilityFile.bytes, 'Runtime capability bytes mismatch');
    insist(isDeepStrictEqual(JSON.parse(bytes), manifest.capabilities), 'Runtime capability projection mismatch');
  }
  return {manifest, raw};
}

async function stageOutput(destination, action) {
  destination = resolve(destination); insist(!existsSync(destination), 'Destination already exists; use a fresh private directory');
  mkdirSync(dirname(destination), {recursive: true, mode: 0o700});
  const stage = `${destination}.preparing-${randomUUID()}`; mkdirSync(stage, {mode: 0o700});
  try {
    const result = await action(stage);
    insist(!existsSync(destination), 'Destination appeared during backup');
    syncDirectory(stage); renameSync(stage, destination); syncDirectory(dirname(destination));
    return {...result, directory: destination};
  } catch (error) {rmSync(stage, {recursive: true, force: true}); throw error;}
}

/** Online, read-only SQLite backup, then enumeration from the closed fixed copy.
 * No server pause is claimed. Immutable files must remain retained while copying;
 * a future GC must hold these roots (or the host must quiesce GC).
 * onSnapshot is an optional server scheduling/progress callback after DB backup;
 * it receives no DB handle and cannot change which live rows are enumerated.
 */
export async function createCreationBackup({data, out, evidenceRoot, automaticEvidenceRoot, runtimeRoot, onSnapshot}) {
  data = resolve(data); out = resolve(out);
  evidenceRoot = resolve(evidenceRoot ?? resolve(data, 'review-evidence'));
  automaticEvidenceRoot = resolve(automaticEvidenceRoot ?? resolve(data, 'automatic-evidence'));
  runtimeRoot = resolve(runtimeRoot ?? resolve(dirname(data), 'releases'));
  for (const source of [data, evidenceRoot, automaticEvidenceRoot, runtimeRoot]) insist(out !== source && !out.startsWith(source + sep), 'Backup destination must be outside source storage roots');
  regularPath(data, 'creation.sqlite');
  return stageOutput(out, async stage => {
    const startedAt = Date.now(), dbRelative = 'data/creation.sqlite', dbPath = resolve(stage, dbRelative);
    mkdirSync(dirname(dbPath), {mode: 0o700});
    const source = new DatabaseSync(resolve(data, 'creation.sqlite'), {readOnly: true});
    try {await backup(source, dbPath);} finally {source.close();}
    chmodSync(dbPath, 0o600);
    const snapshotAt = Date.now(), rows = snapshotRows(dbPath);
    const {assets, artifacts, automaticArtifacts, retention} = inventory(rows,{storageRoot:data}), files = [];
    if (onSnapshot) await onSnapshot({snapshot_completed_at: snapshotAt});
    const add = (sourceRoot, sourceRelative, destinationRelative, expected) => {
      files.push({path: destinationRelative, ...copyVerified(sourceRoot, sourceRelative, resolve(stage, destinationRelative), expected)});
    };
    files.push({path: dbRelative, ...copyVerified(stage, dbRelative)});
    const dbFd = openSync(dbPath, constants.O_RDONLY); try {fsyncSync(dbFd);} finally {closeSync(dbFd);}
    for (const a of assets) add(resolve(data, 'assets'), `${a.id}.${a.ext}`, `data/assets/${a.id}.${a.ext}`, {sha256: a.id, bytes: a.bytes});
    for(const file of sessionImageFiles(rows))add(data,file.path.slice(5),file.path,file);
    for(const file of retention.native_source?.objects??[])add(data,file.path,'data/'+file.path,file);
    for(const file of retention.asset_market?.objects??[])add(data,file.path,'data/'+file.path,file);
    const copiedEvidence = new Set();
    for (const a of artifacts) {
      if (copiedEvidence.has(a.storage_key)) {copyVerified(evidenceRoot, a.storage_key, null, {sha256: a.sha256, bytes: a.byte_length}); continue;}
      copiedEvidence.add(a.storage_key);
      add(evidenceRoot, a.storage_key, `data/review-evidence/${a.storage_key}`, {sha256: a.sha256, bytes: a.byte_length});
    }
    const copiedAutomaticEvidence = new Set();
    for (const artifact of automaticArtifacts) {
      const expected = {sha256:artifact.sha256,bytes:artifact.bytes};
      if (copiedAutomaticEvidence.has(artifact.sha256)) {copyVerified(automaticEvidenceRoot,artifact.sha256,null,expected);continue;}
      copiedAutomaticEvidence.add(artifact.sha256);
      add(automaticEvidenceRoot,artifact.sha256,`data/automatic-evidence/${artifact.sha256}`,expected);
    }
    for (const buildId of retention.runtime_build_ids) {
      const {manifest, raw} = runtimeEntries(runtimeRoot, buildId), manifestRelative = `runtimes/${buildId}/manifest.json`;
      privateWrite(resolve(stage, manifestRelative), raw); files.push({path: manifestRelative, bytes: raw.length, sha256: digest(raw)});
      for (const file of manifest.files) add(runtimeRoot, `${buildId}/${file.path}`, `runtimes/${buildId}/${file.path}`, file);
      retention.runtime_sources.push({runtime_build_id: buildId, source_bytes_included: false, sources: manifest.sources});
    }
    for(const file of retention.canonical_game.files)add(data,file.path,'data/'+file.path,file);
    const retained = Buffer.from(JSON.stringify(retention, null, 2) + '\n');
    privateWrite(resolve(stage, 'retention.json'), retained); files.push({path: 'retention.json', bytes: retained.length, sha256: digest(retained)});
    const manifest = {format: FORMAT, status: 'complete', started_at: startedAt, snapshot_completed_at: snapshotAt, completed_at: Date.now(), consistency: 'sqlite_online_backup_then_fixed_snapshot_inventory', contains_private_authorization_data: true, files: files.sort((a, b) => a.path.localeCompare(b.path))};
    privateWrite(resolve(stage, 'backup.json'), JSON.stringify(manifest, null, 2) + '\n');
    return {ok: true, file_count: files.length, source_revision_count: retention.source_revision_ids.length, runtime_count: retention.runtime_build_ids.length, artifact_count: artifacts.length, automatic_artifact_count:automaticArtifacts.length};
  });
}

function backupManifest(from) {
  const manifest = JSON.parse(readFileSync(regularPath(from, 'backup.json')));
  insist(manifest.format === FORMAT && manifest.status === 'complete' && Array.isArray(manifest.files), 'No complete creation backup manifest');
  const seen = new Set();
  for (const f of manifest.files) {
    relativePath(f.path);
    insist(/^(data\/creation\.sqlite|data\/assets\/[a-f0-9]{64}\.(glb|gd)|data\/(native-source|market)\/objects\/[a-f0-9]{2}\/[a-f0-9]{64}|data\/(review-evidence|automatic-evidence|session-images)\/[a-f0-9]{64}|runtimes\/[a-f0-9]{64}\/.+|data\/(builds|environments)\/[a-z]+-[a-f0-9-]+\/.+|data\/automatic-checks\/[A-Za-z0-9._-]+\/runtime\/.+|retention\.json)$/.test(f.path) && !seen.has(f.path) && HEX.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes >= 0, 'Invalid backup file inventory');
    const native=/^data\/native-source\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(f.path);
    if(native)insist(native[1]===native[2].slice(0,2)&&f.sha256===native[2],'Native source archive path identity mismatch');
    const market=/^data\/market\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(f.path);
    if(market)insist(market[1]===market[2].slice(0,2)&&f.sha256===market[2],'Market archive path identity mismatch');
    seen.add(f.path);
  }
  insist(seen.has('data/creation.sqlite') && seen.has('retention.json'), 'Backup database or retention inventory missing');
  return manifest;
}

function verifyClosure(root,manifest) {
  const storedRetention=JSON.parse(readFileSync(resolve(root,'retention.json')));
  const records = inventory(snapshotRows(resolve(root,'data/creation.sqlite')),{retainCanonical:Boolean(storedRetention.canonical_game),canonicalVerification:storedRetention.canonical_game?.policy==='immutable_indexed_game_projects_and_artifacts_v2',storageRoot:resolve(root,'data')});
  const {assets,artifacts,automaticArtifacts,retention} = records;
  const requireEntry = (path,expected) => {
    const file = manifest.files.find(value => value.path === path); insist(file,`Backup closure file missing: ${path}`);
    insist(file.sha256 === expected.sha256 && file.bytes === expected.bytes,'Backup closure metadata differs');
  };
  for (const artifact of assets) requireEntry(`data/assets/${artifact.id}.${artifact.ext}`,{sha256:artifact.id,bytes:artifact.bytes});
  for(const file of sessionImageFiles(snapshotRows(resolve(root,'data/creation.sqlite'))))requireEntry(file.path,file);
  for(const file of retention.native_source?.objects??[])requireEntry('data/'+file.path,file);
  for(const file of retention.asset_market?.objects??[])requireEntry('data/'+file.path,file);
  for (const artifact of artifacts) requireEntry(`data/review-evidence/${artifact.storage_key}`,{sha256:artifact.sha256,bytes:artifact.byte_length});
  for (const artifact of automaticArtifacts) requireEntry(`data/automatic-evidence/${artifact.sha256}`,{sha256:artifact.sha256,bytes:artifact.bytes});
  for (const buildId of retention.runtime_build_ids) {
    const {manifest:runtime} = runtimeEntries(resolve(root,'runtimes'),buildId);
    insist(manifest.files.some(file => file.path === `runtimes/${buildId}/manifest.json`),'Retained runtime manifest is missing from backup inventory');
    for (const file of runtime.files) requireEntry(`runtimes/${buildId}/${file.path}`,file);
    retention.runtime_sources.push({runtime_build_id:buildId,source_bytes_included:false,sources:runtime.sources});
  }
  for(const file of retention.canonical_game?.files??[])requireEntry('data/'+file.path,file);
  insist(JSON.stringify(storedRetention) === JSON.stringify(retention),'Retention inventory differs from fixed database');
  return records;
}

/** Read-only verification of all bytes, SQLite integrity and retained references. */
export async function verifyCreationBackup({from}) {
  from = resolve(from); const manifest = backupManifest(from);
  for (const file of manifest.files) copyVerified(from,file.path,null,file);
  const {artifacts,automaticArtifacts,retention} = verifyClosure(from,manifest);
  return {ok:true,file_count:manifest.files.length,artifact_count:artifacts.length,automatic_artifact_count:automaticArtifacts.length,runtime_count:retention.runtime_build_ids.length};
}

function restoreAutomaticChecks(databasePath,jobs) {
  const unfinished = jobs.filter(job => AUTO_ACTIVE.has(job.status));
  if (!unfinished.length) return [];
  const now = Date.now(), db = new DatabaseSync(databasePath), recovery = [];
  try {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    const update = db.prepare('UPDATE documents SET body=? WHERE kind=? AND id=?');
    for (const job of unfinished) {
      const restored = {...job,status:'blocked',stage:'备份恢复后检查尚未完成，请重试自动检查',requests:[],
        recovery_required:Boolean(job.review_thread_id),restored_from_status:job.status,restored_at:now,updated_at:now};
      update.run(JSON.stringify(restored),'creator_auto_verification',job.id);
      recovery.push({job_id:job.id,from_status:job.status,to_status:'blocked'});
    }
    db.exec('COMMIT');
    // Keep the restored bundle self-contained, including when the source used WAL.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    insist(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok','Restored database integrity check failed');
  } catch (error) {try {db.exec('ROLLBACK');} catch {} throw error;}
  finally {db.close();}
  const fd = openSync(databasePath,constants.O_RDONLY);try {fsyncSync(fd);} finally {closeSync(fd);} syncDirectory(dirname(databasePath));
  return recovery;
}

function restoreBuildExecutions(databasePath,restoredDataDirectory){
  const db=new DatabaseSync(databasePath),recovery=[];
  try{
    const rows=db.prepare("SELECT id,body FROM documents WHERE kind='creator_build'").all();
    for(const row of rows){let job=JSON.parse(row.body);if(job.native_shared){job={...job,native_shared:{...job.native_shared,authority_directory:resolve(restoredDataDirectory,'builds',job.id,'native-authority')}};db.prepare("UPDATE documents SET body=? WHERE kind='creator_build' AND id=?").run(JSON.stringify(job),job.id);recovery.push({id:job.id,action:'rebase_fixed_shared_authority_directory'});}if(!['queued','running'].includes(job.status))continue;
      const restored={...job,status:'interrupted',stage:job.purpose==='native_preview'?'备份恢复后请重新准备编辑视口':'备份恢复后请重新准备游戏运行或打包',restored_from_status:job.status,finished_at:Date.now(),updated_at:Date.now()};
      db.prepare("UPDATE documents SET body=? WHERE kind='creator_build' AND id=?").run(JSON.stringify(restored),job.id);recovery.push({id:job.id,from_status:job.status,to_status:'interrupted'});
    }
    for(const row of db.prepare("SELECT id,body FROM documents WHERE kind='creator_game_verification'").all()){
      const job=JSON.parse(row.body);if(!['queued','running'].includes(job.status))continue;
      const restored={...job,status:'interrupted',restored_from_status:job.status,error:'备份恢复后需重新执行游戏检查',finished_at:Date.now()};
      db.prepare("UPDATE documents SET body=? WHERE kind='creator_game_verification' AND id=?").run(JSON.stringify(restored),job.id);recovery.push({id:job.id,kind:'creator_game_verification',from_status:job.status,to_status:'interrupted'});
    }
    for(const row of db.prepare("SELECT id,body FROM documents WHERE kind='creator_environment'").all()){
      const environment=JSON.parse(row.body),restored={...environment,project_directory:resolve(restoredDataDirectory,'environments',environment.id,'project'),restored_from_project_directory:environment.project_directory,restored_at:Date.now()};
      db.prepare("UPDATE documents SET body=? WHERE kind='creator_environment' AND id=?").run(JSON.stringify(restored),environment.id);
      recovery.push({id:environment.id,action:'rebase_fixed_project_directory'});
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }finally{db.close();}
  return recovery;
}

/** Restores a new private bundle and blocks unfinished automatic checks.
 * Evidence and source snapshot facts are retained. It starts no service or job.
 */
export async function restoreCreationBackup({from, out}) {
  from = resolve(from); out = resolve(out);
  insist(out !== from && !out.startsWith(from + sep),'Restore destination must be outside backup');
  const manifest = backupManifest(from);
  return stageOutput(out, async stage => {
    for (const f of manifest.files) copyVerified(from, f.path, resolve(stage, f.path), f);
    const {artifacts,automaticArtifacts,automaticChecks} = verifyClosure(stage,manifest);
    const recovery = restoreAutomaticChecks(resolve(stage,'data/creation.sqlite'),automaticChecks);
    const buildRecovery=restoreBuildExecutions(resolve(stage,'data/creation.sqlite'),resolve(out,'data'));
    privateWrite(resolve(stage, 'restore.json'), JSON.stringify({format:FORMAT,status:'complete',restored_at:Date.now(),service_started:false,canonical_build_recovery:buildRecovery,
      ...(recovery.length?{automatic_check_recovery:recovery}:{}),...((recovery.length||buildRecovery.length)?{database_after_recovery:copyVerified(stage,'data/creation.sqlite')}:{})}) + '\n');
    return {ok:true,file_count:manifest.files.length,artifact_count:artifacts.length,automatic_artifact_count:automaticArtifacts.length,recovered_automatic_check_count:recovery.length,recovered_build_count:buildRecovery.length};
  });
}

async function cli() {
  const [command, ...values] = process.argv.slice(2), args = {};
  for (const value of values) {const match = /^--([a-z-]+)=(.+)$/.exec(value); insist(match && !Object.hasOwn(args, match[1]), 'Use unique --key=value options'); args[match[1]] = match[2];}
  if (command === 'create') {
    insist(args.data && args.out && Object.keys(args).every(k => ['data','out','evidence-root','automatic-evidence-root','runtime-root'].includes(k)), 'create requires --data=CREATION_DATA --out=NEW_PRIVATE_BACKUP [--evidence-root=PATH] [--automatic-evidence-root=PATH] [--runtime-root=RELEASES]');
    return createCreationBackup({data: args.data, out: args.out, evidenceRoot: args['evidence-root'], automaticEvidenceRoot:args['automatic-evidence-root'], runtimeRoot: args['runtime-root']});
  }
  if (command === 'verify') {insist(args.from && Object.keys(args).every(key => key === 'from'),'verify requires --from=BACKUP');return verifyCreationBackup({from:args.from});}
  insist(command === 'restore' && args.from && args.out && Object.keys(args).every(k => ['from','out'].includes(k)), 'restore requires --from=BACKUP --out=NEW_PRIVATE_BUNDLE');
  return restoreCreationBackup({from: args.from, out: args.out});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli().then(result => console.log(JSON.stringify(result))).catch(error => {console.error(JSON.stringify({ok: false, error: error.message})); process.exitCode = 1;});
