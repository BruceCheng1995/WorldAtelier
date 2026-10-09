import {constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CreationGoalReview} from './goal-review.mjs';
import {clone, fail, hash, id} from './schema.mjs';

const ARTIFACT = 'creator_goal_review_artifact';
const CAPTURE = 'creator_goal_review_capture';
const RECEIPT = 'creator_goal_review_capture_receipt';
const MAX_BYTES = 8 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const pinFields = ['project_id', 'branch_id', 'session_id', 'goal_id', 'run_id', 'review_id', 'goal_revision', 'revision', 'runtime_build_id'];
const same = (a, b) => hash(a) === hash(b);

function text(value, label) {
  if (typeof value !== 'string' || !value || value.length > 512) fail(400, `${label}无效`);
  return value;
}
function sequence(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(400, '世界代次或序号无效');
  return value;
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, '采集参数含有不支持的字段');
}

/** Private, synchronous capture boundary. `worlds` MUST be the server's actual
 * CreationWorlds instance, never request JSON or persisted creator_world rows.
 * The host owns authentication, body limits, route authorization and scheduling.
 * This module never launches a world, accepts a file path/URL, freezes gameplay,
 * attaches evidence to a review, or claims to verify rendered pixels.
 */
export class CreationReviewCapture {
  constructor({store, worlds, directory, captureTtlMs = 120000}) {
    if (!(worlds?.worlds instanceof Map)) throw new TypeError('server-owned CreationWorlds is required');
    if (!Number.isSafeInteger(captureTtlMs) || captureTtlMs < 1) throw new TypeError('captureTtlMs must be positive');
    this.store = store; this.worlds = worlds; this.directory = resolve(directory); this.captureTtlMs = captureTtlMs;
    this.ledger = new CreationGoalReview({store});
    mkdirSync(this.directory, {recursive: true, mode: 0o700});
    if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) throw new Error('Evidence directory must be a private directory, not a symlink');
    this.resolveEvidence = this.resolveEvidence.bind(this);
  }

  authorize(user, review, write = false) {
    const session = this.store.sessionFor(user, review.session_id);
    this.store.branchFor(user, review.project_id, review.branch_id, write);
    if (session.project_id !== review.project_id || session.branch_id !== review.branch_id || session.owner_user_id !== review.owner_user_id) fail(409, '验收会话绑定已变化');
    if (write) this.ledger.reviewer(user, {session}, review);
    return session;
  }

  current(user, goalId, reviewId, version) {
    const context = this.ledger.context(user, goalId, true);
    const review = this.ledger.current(goalId);
    if (!review || review.id !== reviewId || (version !== undefined && review.version !== version)) fail(409, '采集所属验收已变化，请重新采集');
    this.authorize(user, review, true);
    if (review.decision_id) fail(409, '已决定的验收不能开始或补交采集');
    const facts = this.ledger.facts(review, context.goal, context.run);
    if (facts.stale_reasons.length) fail(409, '采集所属目标、运行或内容已变化', {reasons: facts.stale_reasons});
    return review;
  }

  liveWorld(review, worldId, epoch) {
    const world = [...this.worlds.worlds.values()].find(w => w.id === worldId);
    if (this.worlds.closing || !world || this.worlds.worlds.get(world.key) !== world || !world.ready || !world.activated || world.failed || world.failure || world.ws?.readyState !== 1) fail(409, '没有可采集的在线 Godot 权威世界');
    if (world.project_id !== review.project_id || world.branch_id !== review.branch_id || world.revision !== review.revision || world.runtime_build_id !== review.runtime_build_id || world.epoch !== epoch) fail(409, '运行世界与验收版本不匹配');
    this.checkSnapshot(world.snapshot, world, review);
    return world;
  }

  checkSnapshot(snapshot, world, review) {
    if (!snapshot || snapshot.world_id !== world.id || snapshot.epoch !== world.epoch || snapshot.scene_revision !== review.revision || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || (snapshot.runtime_fault && Object.keys(snapshot.runtime_fault).length)) fail(409, 'Godot 快照版本、序号或运行状态无效');
  }

  boundary(review, input) {
    text(input.world_id, '世界 ID'); sequence(input.epoch, 1);
    const world = this.liveWorld(review, input.world_id, input.epoch);
    const n = sequence(input.sequence ?? world.snapshot.sequence);
    const snapshot = n === world.snapshot.sequence ? world.snapshot : world.history?.get(n);
    this.checkSnapshot(snapshot, world, review);
    if (snapshot.sequence !== n || n > world.snapshot.sequence) fail(409, '采集序号不在当前世界历史边界内');
    const delivery = review.deliveries.find(d => d.world_id === world.id && d.epoch === world.epoch && d.resource_ref === world.resource_id && d.runtime_build_id === world.runtime_build_id && d.applied_sequence <= n);
    if (!delivery) fail(409, '此观察没有属于该验收的世界应用基线');
    const {resource_ref, runtime_build_id, ...original} = delivery;
    if (!same(original, this.store.get('creator_delivery', delivery.id))) fail(409, '采集引用的应用记录已变化');
    return {snapshot: clone(snapshot), pin: {
      schema: 1, project_id: review.project_id, branch_id: review.branch_id, session_id: review.session_id,
      goal_id: review.goal_id, run_id: review.run_id, review_id: review.id, review_version: review.version,
      goal_revision: review.goal_revision, revision: review.revision, runtime_build_id: review.runtime_build_id,
      resource_id: world.resource_id, world_id: world.id, epoch: world.epoch, sequence: n,
      state_hash: hash(snapshot), delivery_id: delivery.id, target_refs: clone(review.target_refs),
    }};
  }

  // Paths below are derived ONLY from validated digests in trusted records.
  readBytes(storageKey) {
    if (!DIGEST.test(storageKey ?? '')) fail(409, '证据存储键无效');
    let fd;
    try {
      fd = openSync(resolve(this.directory, storageKey), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) fail(409, '证据文件无效或过大');
      const bytes = readFileSync(fd);
      if (hash(bytes) !== storageKey) fail(409, '证据字节哈希不匹配');
      return bytes;
    } catch (error) {
      if (error.status) throw error;
      fail(409, '证据字节缺失或不可读取');
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  retainBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) fail(413, '证据须为 1 字节至 8 MiB 的原始字节');
    bytes = Buffer.from(bytes);
    const digest = hash(bytes), destination = resolve(this.directory, digest), temporary = resolve(this.directory, id('.capture'));
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      try { linkSync(temporary, destination); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!this.readBytes(digest).equals(bytes)) fail(409, '已有证据对象字节不同');
      const directoryFd = openSync(this.directory, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return {storage_key: digest, sha256: digest, byte_length: bytes.length};
  }

  retainArtifact(user, captureId, pin, kind, mimeType, bytes) {
    if (JSON.stringify(pin).length > 65000) fail(413, '观察身份记录过大');
    const stored = this.retainBytes(bytes);
    const artifact = {id: id('review-artifact'), schema: 1, capture_id: captureId,
      project_id: pin.project_id, session_id: pin.session_id, kind, mime_type: mimeType,
      pin: {...clone(pin), provenance: kind === 'runtime_trace' ? 'server_runtime_snapshot' : 'authenticated_user_upload', render_verified: false},
      capture_status: 'retained', submitted_by: user.id, retained_at: Date.now(), ...stored};
    this.store.put(ARTIFACT, artifact);
    return artifact;
  }

  descriptor(artifact) {
    const {storage_key, ...publicRecord} = artifact;
    return clone(publicRecord);
  }

  start(user, input, action) {
    fields(input, ['request_id', 'goal_id', 'review_id', 'expected_version', 'world_id', 'epoch', 'sequence']);
    text(input.request_id, '请求 ID'); text(input.goal_id, '目标 ID'); text(input.review_id, '验收 ID'); sequence(input.expected_version, 1);
    return this.store.transaction(() => {
      // Authenticate the original private scope even before durable replay.
      const requested = this.store.get('creator_goal_review', input.review_id);
      if (!requested || requested.goal_id !== input.goal_id) fail(404, '验收不存在');
      this.authorize(user, requested, true);
      const receiptId = hash({user: user.id, request_id: input.request_id}), fingerprint = hash({action, input});
      const previous = this.store.get(RECEIPT, receiptId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, '相同采集请求 ID 不能改写内容');
        this.readArtifact(user, previous.result.baseline_ref);
        return {...clone(previous.result), replayed: true};
      }
      const review = this.current(user, input.goal_id, input.review_id, input.expected_version);
      const {snapshot, pin} = this.boundary(review, input), captureId = id('review-capture'), started = Date.now();
      const trace = this.retainArtifact(user, captureId, pin, 'runtime_trace', 'application/json', Buffer.from(JSON.stringify({schema: 1, captured_at: started, pin, snapshot})));
      const capture = {id: captureId, schema: 1, action, pin, actor_id: user.id, baseline_ref: trace.id, started_at: started, expires_at: started + this.captureTtlMs};
      this.store.put(CAPTURE, capture);
      const result = {capture_id: capture.id, pin: clone(pin), baseline_ref: trace.id, artifact: this.descriptor(trace), expires_at: capture.expires_at};
      this.store.put(RECEIPT, {id: receiptId, capture_id: capture.id, fingerprint, result: clone(result)});
      return result;
    });
  }

  captureRuntimeTrace(user, input) { return this.start(user, input, 'runtime_trace'); }
  beginClientObservation(user, input) { return this.start(user, input, 'client_observation'); }

  submitClientObservation(user, captureId, input) {
    fields(input, ['bytes', 'mime_type']);
    return this.store.transaction(() => {
      const capture = this.store.get(CAPTURE, text(captureId, '采集 ID'));
      const review = capture && this.store.get('creator_goal_review', capture.pin.review_id);
      if (!review) fail(404, '采集不存在');
      this.authorize(user, review, true);
      if (capture.actor_id !== user.id || capture.action !== 'client_observation') fail(403, '只能补交本人启动的客户端观察');
      const bytes = input.bytes instanceof Uint8Array ? Buffer.from(input.bytes) : null;
      if (!bytes || !bytes.length || bytes.length > MAX_BYTES) fail(413, '图片须为 1 字节至 8 MiB 的原始字节');
      // Signature checks select a safe download MIME; they do not prove image
      // validity, visible gameplay, screenshot freshness or pixel provenance.
      const png = input.mime_type === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = input.mime_type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) fail(415, '仅支持具有对应文件签名的 PNG 或 JPEG 用户图片');
      const existing = this.store.list(ARTIFACT).find(a => a.capture_id === capture.id && a.kind === 'authenticated_client_observation');
      if (existing) {
        if (existing.sha256 !== hash(bytes) || existing.mime_type !== input.mime_type) fail(409, '此采集已完成，不能替换原始图片');
        this.readArtifact(user, existing.id);
        return {artifact: this.descriptor(existing), replayed: true};
      }
      if (Date.now() > capture.expires_at) fail(409, '采集已过期，请重新开始');
      const current = this.current(user, capture.pin.goal_id, capture.pin.review_id);
      if (pinFields.some(key => (key === 'review_id' ? current.id : current[key]) !== capture.pin[key])) fail(409, '旧采集不能绑定到新的验收上下文');
      const world = this.liveWorld(current, capture.pin.world_id, capture.pin.epoch);
      if (world.resource_id !== capture.pin.resource_id || world.snapshot.sequence < capture.pin.sequence) fail(409, '世界资源或序号边界已变化');
      this.readArtifact(user, capture.baseline_ref);
      const artifact = this.retainArtifact(user, capture.id, capture.pin, 'authenticated_client_observation', input.mime_type, bytes);
      return {artifact: this.descriptor(artifact)};
    });
  }

  readArtifact(user, reference) {
    const artifact = this.store.get(ARTIFACT, text(reference, '证据引用'));
    const review = artifact && this.store.get('creator_goal_review', artifact.pin?.review_id);
    if (!artifact || !review || artifact.capture_status !== 'retained') fail(404, '证据不存在');
    this.authorize(user, review);
    if (artifact.session_id !== review.session_id || artifact.project_id !== review.project_id || pinFields.some(key => (key === 'review_id' ? review.id : review[key]) !== artifact.pin[key])) fail(409, '证据私有范围或版本绑定无效');
    const bytes = this.readBytes(artifact.storage_key);
    if (hash(bytes) !== artifact.sha256 || bytes.length !== artifact.byte_length) fail(409, '证据元数据与原始字节不匹配');
    return {artifact: this.descriptor(artifact), bytes};
  }

  resolveEvidence({user, goal, review, reference}) {
    const {artifact} = this.readArtifact(user, reference);
    if (goal.id !== review.goal_id || pinFields.some(key => (key === 'review_id' ? review.id : review[key]) !== artifact.pin[key])) fail(409, '证据属于另一目标或验收轮次');
    return {ref: artifact.id, sha256: artifact.sha256, kind: artifact.kind, pin: clone(artifact.pin)};
  }

  /** SERVER ONLY retention/backup enumeration; never expose as a public route.
   * Retain all cycles and incomplete captures; there is deliberately no GC.
   * Revision roots imply transitive asset closure handled by the host's GC.
   */
  retentionRoots() {
    const captures = this.store.list(CAPTURE).map(c => c.pin);
    const reviews = this.store.list('creator_goal_review');
    const pins = [...captures, ...reviews.map(r => ({...r, review_id: r.id}))];
    const unique = key => [...new Set(pins.map(p => p[key]).filter(v => v != null))].sort();
    return {revision_ids: [...new Set([...unique('revision'), ...reviews.map(r => r.run_identity?.input_revision).filter(Boolean)])].sort(), runtime_build_ids: unique('runtime_build_id'), review_ids: unique('review_id'), goal_ids: unique('goal_id'), run_ids: unique('run_id'), session_ids: unique('session_id'), delivery_ids: [...new Set([...unique('delivery_id'), ...reviews.flatMap(r => r.delivery_ids)])].sort(), verification_ids: [...new Set(reviews.flatMap(r => r.verification_ids))].sort(), worlds: captures.map(p => ({world_id: p.world_id, epoch: p.epoch, sequence: p.sequence, state_hash: p.state_hash})), artifacts: this.store.list(ARTIFACT).map(a => ({id: a.id, storage_key: a.storage_key, sha256: a.sha256, byte_length: a.byte_length}))};
  }

  /** Call with a consistent SQLite backup, with capture writes quiesced. Each
   * yielded file has freshly verified bytes. Paths never come from clients.
   * Back up full creation.sqlite as well: records below are not auth/ledger DB.
   */
  *enumerateBackupArtifacts() {
    const seen = new Set();
    for (const a of this.store.list(ARTIFACT)) {
      const bytes = this.readBytes(a.storage_key);
      if (hash(bytes) !== a.sha256 || bytes.length !== a.byte_length) fail(409, '备份证据元数据不匹配');
      if (seen.has(a.storage_key)) continue;
      seen.add(a.storage_key);
      yield {relative_path: `review-evidence/${a.storage_key}`, storage_key: a.storage_key, sha256: a.sha256, byte_length: bytes.length, bytes};
    }
  }
}
