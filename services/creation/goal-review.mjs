import { clone, fail, hash, id } from './schema.mjs';
import { goalSourceValidation, isGoalRevalidation } from './goal-revalidation.mjs';

const KIND = 'creator_goal_review';
const HEAD = 'creator_goal_review_head';
const EVIDENCE = 'creator_goal_review_evidence';
const DECISION = 'creator_goal_review_decision';
const RECEIPT = 'creator_goal_review_receipt';
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const list = value => Array.isArray(value) ? value : [];
const same = (a, b) => hash(a) === hash(b);
const runIdentity = run => ({run_id: run.id, session_id: run.session_id, owner_user_id: run.owner_user_id, input_revision: run.input_revision, input_hash: run.input_hash ?? null, thread_id: run.thread_id ?? null, turn_id: run.turn_id ?? null, client_user_message_id: run.client_user_message_id ?? null});

function text(value, label, max = 5000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${label}无效`);
  return value;
}
function refs(value, label, max = 100) {
  if (!Array.isArray(value) || value.length > max) fail(400, `${label}无效`);
  const result = value.map(v => text(v, label, 512));
  if (new Set(result).size !== result.length) fail(400, `${label}不能重复`);
  return result;
}
function criteria(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50) fail(400, '请固定 1–50 条验收条件');
  const result = value.map(c => ({id: text(c?.id, '条件 ID', 120), text: text(c?.text, '验收条件', 2000)}));
  refs(result.map(c => c.id), '条件 ID');
  return result;
}
function positive(value, label, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) fail(400, `${label}无效`);
  return value;
}
function runExecution(run, pendingInput = false) {
  if (run.cancel_requested_at || run.cleanup_status || ['cancelling', 'interrupted', 'cancelled'].includes(run.status)) {
    if (run.cleanup_status !== 'verified') return {status: 'cleanup_unconfirmed', ended: terminal.has(run.status), cleanup_status: run.cleanup_status ?? 'uncertain'};
    return {status: terminal.has(run.status) ? 'cancelled' : 'cancelling', ended: terminal.has(run.status), cleanup_status: 'verified'};
  }
  if (pendingInput || run.pending_request || list(run.pending_requests).length || ['blocked', 'waiting_input', 'waiting_approval'].includes(run.status)) return {status: 'waiting_input', ended: false};
  return {status: run.status, ended: terminal.has(run.status)};
}

/** Independent acceptance ledger. Never writes creator_goal, creator_run or scenes.
 * resolveEvidence is a synchronous, server-owned artifact resolver. It must check
 * access, immutable bytes/digest and capture provenance; never bind it to request
 * JSON, arbitrary file reads or arbitrary URLs. No resolver means fail closed.
 * publicTarget converts an existing canonical target to a public identity only;
 * it is the resource adapter's responsibility. No resource schema is defined here.
 */
export class CreationGoalReview {
  constructor({store, resolveEvidence, publicTarget = () => null, hasPendingInput = () => false}) {
    this.store = store;
    this.resolveEvidence = resolveEvidence;
    this.publicTarget = publicTarget;
    this.hasPendingInput = hasPendingInput;
  }

  execution(run) { return runExecution(run, this.hasPendingInput(clone(run))); }

  context(user, goalId, write = false) {
    const goal = this.store.get('creator_goal', goalId);
    if (!goal) fail(404, '目标不存在');
    const session = this.store.sessionFor(user, goal.session_id);
    this.store.branchFor(user, session.project_id, session.branch_id, write);
    const run = this.store.get('creator_run', goal.run_id);
    if (!run || run.session_id !== session.id || run.project_id !== session.project_id || run.branch_id !== session.branch_id || run.owner_user_id !== session.owner_user_id) fail(409, '目标的执行绑定无效');
    return {goal, session, run};
  }

  owner(user, context) {
    if (context.session.owner_user_id !== user.id) fail(403, '只有会话主人可以组织此目标的验收');
  }

  reviewer(user, context, review) {
    if (context.session.owner_user_id !== user.id && !review.reviewer_user_ids.includes(user.id)) fail(403, '未获此目标的验收授权');
  }

  current(goalId) {
    const head = this.store.get(HEAD, goalId);
    return head ? this.store.get(KIND, head.review_id) : null;
  }

  expected(goalId, reviewId, version) {
    const review = this.current(goalId);
    if (!review || review.id !== reviewId || review.version !== version) fail(409, '验收已变化，请刷新后继续');
    return review;
  }

  mutate(user, goalId, action, input, authorize, fn) {
    // Permission is checked even when replaying a durable receipt.
    return this.store.transaction(() => {
      const context = this.context(user, goalId, true);
      authorize(context);
      const requestId = text(input.request_id, '请求 ID', 200);
      const receiptId = hash({goalId, user: user.id, requestId});
      const fingerprint = hash({action, input});
      const previous = this.store.get(RECEIPT, receiptId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, '相同请求 ID 不能改写操作或内容');
        return {...clone(previous.result), replayed: true};
      }
      const result = fn(context);
      this.store.put(RECEIPT, {id: receiptId, fingerprint, result: clone(result)});
      return result;
    });
  }

  notify(review, kind) {
    // Private event only. The host can publish a freshly authorized projection.
    return this.store.appendSessionEvent(review.session_id, {kind, goal_id: review.goal_id, review_id: review.id, version: review.version});
  }

  open(user, goalId, input) {
    return this.mutate(user, goalId, 'open', input, c => this.owner(user, c), ({goal, session, run}) => {
      const old = this.current(goalId);
      if ((input.expected_review_id ?? null) !== (old?.id ?? null)) fail(409, '目标已有新的验收轮次');
      if (input.run_id !== run.id) fail(409, '验收必须绑定目标当前运行');
      const branch = this.store.branchFor(user, session.project_id, session.branch_id);
      const revision = this.store.get('creator_revision', input.revision);
      if (!revision || revision.project_id !== session.project_id || branch.head !== revision.id) fail(409, '请固定当前源版本再发起验收');
      const source = goalSourceValidation(this.store, run, revision.id, this.execution(run));
      if (!source.allowed) fail(409, source.reason);
      const checks = criteria(input.criteria);
      const verificationIds = refs(input.verification_ids ?? list(run.verifications), '技术验证引用');
      const deliveryIds = refs(input.delivery_ids ?? list(run.deliveries).map(d => typeof d === 'string' ? d : d?.id), '应用引用');
      const runDeliveries = list(run.deliveries).map(d => typeof d === 'string' ? d : d?.id);
      if (verificationIds.some(v => !list(run.verifications).includes(v)) || deliveryIds.some(d => !runDeliveries.includes(d))) fail(409, '不能借用其他目标运行的验证或应用');
      if (input.requires_application !== undefined && typeof input.requires_application !== 'boolean') fail(400, '应用要求无效');
      const review = {
        id: id('review'), schema: 1, goal_id: goalId, session_id: session.id,
        project_id: session.project_id, branch_id: session.branch_id, owner_user_id: session.owner_user_id,
        previous_review_id: old?.id ?? null, cycle: (old?.cycle ?? 0) + 1, version: 1,
        objective: goal.objective, criteria: checks,
        goal_revision: hash({goal_id: goalId, objective: goal.objective, criteria: checks}),
        run_id: run.id, revision: revision.id, runtime_build_id: text(input.runtime_build_id, '运行构建 ID', 512),
        run_identity: runIdentity(run),
        target_refs: clone(list(run.targets)), requires_application: input.requires_application ?? true,
        verification_ids: verificationIds, delivery_ids: deliveryIds,
        reviewer_user_ids: [], evidence_ids: [], decision_id: null, created_at: Date.now(), created_by: user.id,
      };
      // Pin the existing persisted reports as immutable review material.
      review.verifications = verificationIds.map(v => this.verification(review, v));
      if (source.revalidation && (!review.verifications.length || review.verifications.some(v => !isGoalRevalidation(v, goal, run, source)))) fail(409, '当前源版本已更新，请先为此目标重新技术验证，不能借用其他目标的报告');
      if (source.revalidation) review.revalidation_basis_revision = source.basis_revision;
      review.deliveries = deliveryIds.map(d => this.delivery(review, d));
      this.store.put(KIND, review);
      this.store.put(HEAD, {id: goalId, review_id: review.id});
      const event = this.notify(review, 'goal_review_opened');
      return {review: clone(review), event};
    });
  }

  verification(review, verificationId) {
    const v = this.store.get('creator_verification', verificationId);
    if (!v || v.project_id !== review.project_id || v.branch_id !== review.branch_id || v.revision !== review.revision || v.runtime_build_id !== review.runtime_build_id || !['passed', 'failed'].includes(v.status)) fail(409, '技术验证未结束或版本不匹配');
    return clone(v);
  }

  delivery(review, deliveryId) {
    const d = this.store.get('creator_delivery', deliveryId);
    const v = d && review.verifications.find(v => v.id === d.verification_id);
    const w = d && this.store.get('creator_world', d.world_id);
    if (!d || !v || v.status !== 'passed' || !w || w.project_id !== review.project_id || w.branch_id !== review.branch_id || w.resource_id !== v.resource_id || d.revision !== review.revision) fail(409, '应用记录与目标内容或验证不匹配');
    positive(d.epoch, '世界代次'); positive(d.applied_sequence, '应用序号', true);
    return {...clone(d), resource_ref: v.resource_id, runtime_build_id: v.runtime_build_id};
  }

  setReviewers(user, goalId, input) {
    return this.mutate(user, goalId, 'reviewers', input, c => this.owner(user, c), ({session}) => {
      const review = this.expected(goalId, input.review_id, input.expected_version);
      const users = refs(input.reviewer_user_ids, '验收者');
      if (users.length && session.visibility !== 'shared') fail(409, '请先显式共享会话再委派验收');
      for (const uid of users) this.store.branchFor({id: uid}, review.project_id, review.branch_id, true);
      review.reviewer_user_ids = users; review.version++;
      this.store.put(KIND, review); const event = this.notify(review, 'goal_review_permissions_changed');
      return {review: clone(review), event};
    });
  }

  addEvidence(user, goalId, input) {
    return this.mutate(user, goalId, 'evidence', input, c => this.reviewer(user, c, this.current(goalId) ?? {reviewer_user_ids: []}), context => {
      const review = this.expected(goalId, input.review_id, input.expected_version);
      if (review.decision_id) fail(409, '已决定的验收记录不可追加证据，请开启新轮次');
      if (!this.resolveEvidence) fail(503, '可信体验证据存储尚未接入');
      const references = refs(input.artifact_refs, '体验证据引用', 20);
      if (!references.length) fail(400, '请提供实际体验证据');
      if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > review.criteria.length) fail(400, '请记录本次实际检查的条件');
      const checks = input.checks.map(c => {
        if (!review.criteria.some(k => k.id === c?.criterion_id) || !['passed', 'failed'].includes(c.result)) fail(400, '验收条件或检查结果无效');
        return {criterion_id: c.criterion_id, result: c.result, observation: text(c.observation, '实际观察', 2000)};
      });
      refs(checks.map(c => c.criterion_id), '检查条件');
      const artifacts = references.map(reference => {
        const artifact = this.resolveEvidence({user, goal: clone(context.goal), review: clone(review), reference});
        if (!artifact || typeof artifact.then === 'function' || artifact.ref !== reference || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') || !['browser_capture', 'runtime_trace', 'manual_observation', 'authenticated_client_observation'].includes(artifact.kind)) fail(422, '证据必须来自可读取的不可变体验记录');
        const pin = artifact.pin;
        if (!pin || pin.goal_id !== goalId || pin.run_id !== review.run_id || pin.revision !== review.revision || pin.runtime_build_id !== review.runtime_build_id) fail(409, '证据属于另一个目标、运行或内容版本');
        if ((pin.review_id != null || artifact.kind === 'authenticated_client_observation') && pin.review_id !== review.id) fail(409, '证据属于另一验收轮次');
        if (pin.world_id != null) {
          const delivery = review.deliveries.find(d => d.world_id === pin.world_id && d.epoch === pin.epoch && d.applied_sequence <= pin.sequence);
          if (!delivery) fail(409, '观察没有匹配的世界应用基线');
          text(pin.world_id, '世界 ID', 512); positive(pin.epoch, '世界代次'); positive(pin.sequence, '观察序号', true);
        } else if (review.requires_application) fail(409, '此目标需要固定实际试玩世界和观察序号');
        if (pin.inspection_ref != null) text(pin.inspection_ref, '检查观察引用', 512);
        // Keep additional opaque observation/address/version fields from the
        // trusted resolver. Never re-resolve them from the moving source head.
        const encoded = JSON.stringify(pin);
        if (encoded.length > 65536) fail(413, '观察身份记录过大');
        return {ref: reference, sha256: artifact.sha256, kind: artifact.kind, pin: JSON.parse(encoded)};
      });
      const evidence = {id: id('review-evidence'), review_id: review.id, goal_id: goalId, goal_revision: review.goal_revision, run_id: review.run_id, revision: review.revision, runtime_build_id: review.runtime_build_id, layer: 'experience', checks, artifacts, recorded_by: user.id, created_at: Date.now()};
      this.store.put(EVIDENCE, evidence); review.evidence_ids.push(evidence.id); review.version++;
      this.store.put(KIND, review); const event = this.notify(review, 'goal_review_evidence_added');
      return {review: clone(review), evidence: clone(evidence), event};
    });
  }

  facts(review, goal, run) {
    const branch = this.store.get('creator_branch', `${review.project_id}:${review.branch_id}`);
    const reasons = [];
    if (branch?.head !== review.revision) reasons.push('source_changed');
    if (goal.run_id !== review.run_id) reasons.push('run_changed');
    const pinnedRun = this.store.get('creator_run', review.run_id);
    if (!pinnedRun || !same(list(pinnedRun.targets), review.target_refs)) reasons.push('target_changed');
    if (!pinnedRun || !same(runIdentity(pinnedRun), review.run_identity)) reasons.push('run_identity_changed');
    if (hash({goal_id: goal.id, objective: goal.objective, criteria: review.criteria}) !== review.goal_revision) reasons.push('goal_changed');
    const unchanged = review.verifications.every(v => same(v, this.store.get('creator_verification', v.id)));
    if (!unchanged) reasons.push('verification_changed');
    const verification = !review.verifications.length ? 'not_recorded' : !unchanged ? 'stale' : review.verifications.some(v => v.status === 'failed') ? 'failed' : 'passed';
    const applications = review.deliveries.map(d => {
      const {resource_ref, runtime_build_id, ...original} = d;
      const w = this.store.get('creator_world', d.world_id);
      const current = same(original, this.store.get('creator_delivery', d.id)) && w?.project_id === review.project_id && w?.branch_id === review.branch_id && w?.resource_id === resource_ref && !w?.failure && w?.revision === review.revision && w?.epoch === d.epoch && w?.runtime_build_id === runtime_build_id && Number.isSafeInteger(w?.snapshot?.sequence) && w.snapshot.sequence >= d.applied_sequence;
      return {delivery_id: d.id, world_id: d.world_id, epoch: d.epoch, applied_sequence: d.applied_sequence, current};
    });
    const application = applications.some(a => a.current) ? 'applied' : applications.length ? 'stale' : 'not_recorded';
    if (review.requires_application && application === 'stale') reasons.push('world_changed');
    const execution = pinnedRun ? this.execution(pinnedRun) : {status: 'uncertain', ended: false};
    const evidence = review.evidence_ids.map(e => this.store.get(EVIDENCE, e));
    const decision = review.decision_id && this.store.get(DECISION, review.decision_id);
    const sourceCurrent = this.current(goal.id)?.id === review.id;
    if (!sourceCurrent) reasons.push('cycle_superseded');
    const acceptedCurrent = decision?.outcome === 'pass' && !reasons.length && execution.status === 'completed' && verification === 'passed' && (!review.requires_application || application === 'applied');
    return {execution, verification, application, applications, evidence, decision: decision || null, stale_reasons: reasons, acceptance: acceptedCurrent ? 'accepted' : decision?.outcome === 'pass' ? 'accepted_historical' : decision?.outcome === 'reject' ? 'rejected' : decision?.outcome === 'revise' ? 'changes_requested' : reasons.length ? 'stale' : 'pending'};
  }

  decide(user, goalId, input) {
    return this.mutate(user, goalId, 'decide', input, c => this.reviewer(user, c, this.current(goalId) ?? {reviewer_user_ids: []}), ({goal, run}) => {
      const review = this.expected(goalId, input.review_id, input.expected_version);
      if (review.decision_id) fail(409, '此轮验收已有不可变决定，请开启新轮次');
      if (!['pass', 'reject', 'revise'].includes(input.outcome)) fail(400, '请选择通过、不通过或继续修改');
      const reason = text(input.reason, '验收说明');
      const ids = refs(input.evidence_ids ?? [], '验收证据');
      const selected = ids.map(eid => {
        if (!review.evidence_ids.includes(eid)) fail(409, '不能使用其他验收轮次的证据');
        const evidence = this.store.get(EVIDENCE, eid);
        if (!evidence || evidence.review_id !== review.id || evidence.goal_revision !== review.goal_revision) fail(409, '验收证据绑定无效');
        return evidence;
      });
      const facts = this.facts(review, goal, run);
      if (input.outcome === 'pass') {
        if (facts.stale_reasons.length) fail(409, '版本已变化，请使用当前版本重新验收', {reasons: facts.stale_reasons});
        if (facts.execution.status !== 'completed') fail(409, '执行尚未成功结束或取消清理尚未核对');
        if (facts.verification !== 'passed') fail(409, '此固定版本尚无通过的技术验证');
        if (review.requires_application && facts.application !== 'applied') fail(409, '此固定版本尚未确认应用到当前世界');
        for (const criterion of review.criteria) {
          const checks = selected.flatMap(e => e.checks).filter(c => c.criterion_id === criterion.id);
          if (!checks.some(c => c.result === 'passed') || checks.some(c => c.result === 'failed')) fail(409, '每条条件都需要本轮通过的体验证据', {criterion_id: criterion.id});
        }
        // Re-resolve bytes/authority at decision time. An old ID must not hide
        // revoked access, a changed artifact, a different world or a different run.
        for (const e of selected) for (const a of e.artifacts) {
          const current = this.resolveEvidence?.({user, goal: clone(goal), review: clone(review), reference: a.ref});
          if (!current || current.ref !== a.ref || current.sha256 !== a.sha256 || current.kind !== a.kind || !same(current.pin, a.pin)) fail(409, '体验证据已失效或发生变化');
          if (review.requires_application && !facts.applications.some(d => d.current && d.world_id === a.pin.world_id && d.epoch === a.pin.epoch)) fail(409, '体验观察的世界已变化');
        }
      }
      const decision = {id: id('review-decision'), review_id: review.id, goal_id: goalId, goal_revision: review.goal_revision, run_id: review.run_id, revision: review.revision, runtime_build_id: review.runtime_build_id, outcome: input.outcome, reason, evidence_ids: ids, verification_ids: clone(review.verification_ids), delivery_ids: clone(review.delivery_ids), actor_id: user.id, decided_at: Date.now()};
      this.store.put(DECISION, decision); review.decision_id = decision.id; review.version++;
      this.store.put(KIND, review); const event = this.notify(review, 'goal_review_decided');
      return {review: clone(review), decision: clone(decision), event};
    });
  }

  view(user, goalId, reviewId = null) {
    const {goal, session, run} = this.context(user, goalId);
    const review = reviewId ? this.store.get(KIND, reviewId) : this.current(goalId);
    if (reviewId && !review) fail(404, '验收记录不存在');
    if (review && review.goal_id !== goalId) fail(404, '此目标没有该验收记录');
    const writable = ['owner', 'editor'].includes(this.store.projectFor(user, session.project_id).members[user.id]);
    if (!review) return {goal_id: goalId, review: null, execution: this.execution(run), acceptance: 'not_started', can_decide: false, can_organize: writable && user.id === session.owner_user_id};
    return {goal_id: goalId, review: clone(review), ...this.facts(review, goal, run), can_decide: writable && (user.id === session.owner_user_id || review.reviewer_user_ids.includes(user.id)), can_organize: writable && user.id === session.owner_user_id};
  }

  history(user, goalId) {
    this.context(user, goalId);
    return this.store.list(KIND).filter(r => r.goal_id === goalId).sort((a, b) => a.cycle - b.cycle).map(r => this.view(user, goalId, r.id));
  }

  publicStates(user, projectId, branchId) {
    this.store.branchFor(user, projectId, branchId);
    const result = [];
    for (const goal of this.store.list('creator_goal')) {
      const run = this.store.get('creator_run', goal.run_id);
      if (!run || run.project_id !== projectId || run.branch_id !== branchId) continue;
      const review = this.current(goal.id);
      const facts = review ? this.facts(review, goal, run) : {execution: this.execution(run), verification: 'not_recorded', application: 'not_recorded', acceptance: 'not_started'};
      // Deliberately keep one entry per goal, even when several share an object.
      result.push({goal_id: goal.id, target_refs: list(run.targets).map(t => this.publicTarget(clone(t))).filter(t => t != null), actor_id: run.owner_user_id, execution: facts.execution.status, verification: facts.verification, application: facts.application, acceptance: facts.acceptance});
    }
    return result;
  }
}
