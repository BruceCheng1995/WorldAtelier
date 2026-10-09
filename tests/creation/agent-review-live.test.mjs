/** Real Agent -> failed validator -> same-goal continuation -> live evidence.
 * Runs ONLY against a separately authorized, already running integration server.
 * Creates its own account/project/session/world. Never starts/stops that server,
 * writes another project, fabricates executor events or uploads synthetic images.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = process.env.WORLD_ATELIER_CREATION_ORIGIN;
const codeRoot = process.env.WORLD_ATELIER_CREATION_CODE_ROOT;
const expectedBuild = process.env.WORLD_ATELIER_EXPECT_RUNTIME_BUILD;
const resumePath = process.env.WORLD_ATELIER_AGENT_REVIEW_RESUME_REPORT;
const uid = name => `${name}-${randomUUID()}`;
const pause = ms => new Promise(yes => setTimeout(yes, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /^(token|password|email|account|authorization|access_token|refresh_token|id_token|api_key|cap)$/i.test(key) || key === 'code' && typeof entry === 'string' ? '[redacted]' : redact(entry)]));
  return typeof value === 'string' ? value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]').replace(/([?&]cap=)[^&\s"']+/g, '$1[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]') : value;
}

test('two actual Agent turns and private server-retained runtime review evidence', { timeout: 840000 }, async t => {
  assert.equal(process.env.WORLD_ATELIER_RUN_REAL_AGENT_REVIEW, '1', 'Enable only after the integration owner authorizes this exact origin');
  assert.equal(origin, 'http://127.0.0.1:48921', 'This driver never targets production ports');
  assert.ok(codeRoot); assert.match(expectedBuild ?? '', /^[a-f0-9]{64}$/);
  const prior = resumePath ? JSON.parse(await readFile(resumePath, 'utf8')) : null;
  if (prior) {
    assert.equal(prior.origin, origin); assert.equal(prior.code_root, codeRoot); assert.equal(prior.expected_runtime_build, expectedBuild);
    assert.ok(prior.first_start?.run?.id); assert.equal(prior.cases.some(item => item.id === 'RB03'), false, 'Only resume the original first turn; never duplicate a continuation');
  }
  const api = `${origin}/creation-api`, resourceId = 'scene-harbor', objectId = 'independent-review-anchor';
  const out = resolve(root, '.local/creation-verification/agent-review', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(out, { recursive: true }); await chmod(out, 0o700);
  const report = { started_at: new Date().toISOString(), origin, code_root: codeRoot, expected_runtime_build: expectedBuild,
    scope: 'Two real Codex turns in a new private project, real Godot validator/authority, authenticated protocol input and server runtime_trace bytes. No browser/GPU/screenshot or Case13 UI completion claim. Existing integration server remains running.',
    cases: [], events: [], http: [], completed: false, ...(prior ? { resumed_from: resolve(resumePath), resume_reason: 'Continue observing the same first turn after the original driver wait limit; do not resubmit it' } : {}) };
  const sourceFiles = ['services/creation/agent-runs.mjs', 'services/creation/service.mjs', 'services/creation/goal-review.mjs', 'services/creation/review-capture.mjs', 'services/creation/worlds.mjs', 'services/creation/realtime.mjs', 'services/creation/store.mjs', 'services/creation/codex-agent.mjs'];
  report.source_hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(resolve(codeRoot, file)))])));
  if (prior) assert.deepEqual(report.source_hashes, prior.source_hashes, 'A resumed observation must use the same audited backend source');
  let owner, outsider, projectId, session, peer, runtime, model, cursor = 0, activeRun, firstRun, secondRun, firstReview, finalReview;
  const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(redact(report), null, 2) + '\n');
  const record = row => appendFileSync(resolve(out, 'traffic.jsonl'), JSON.stringify(redact({ at: Date.now(), ...row })) + '\n');
  async function request(method, path, user = owner, input) {
    const headers = { origin, 'content-type': 'application/json' }; if (user) headers.authorization = `Bearer ${user.token}`;
    const response = await fetch(api + path, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) });
    const value = await response.json(), result = { status: response.status, value };
    record({ method, path, actor: user?.user?.id, input, ...result }); return result;
  }
  const ok = (result, expected = 200) => { assert.equal(result.status, expected, JSON.stringify(redact(result.value))); return result.value; };
  const branchPath = () => `/projects/${projectId}/branches/main`;
  const branch = () => request('GET', branchPath()).then(ok);
  const view = () => request('GET', `/sessions/${session.id}`).then(ok);
  const reviewView = () => request('GET', `/goals/${firstRun.goal_id}/review`).then(ok);
  async function events() {
    for (;;) {
      const page = ok(await request('GET', `/sessions/${session.id}/events?after=${cursor}`)).events;
      for (const event of page) { assert.ok(event.cursor > cursor); cursor = event.cursor; report.events.push(event); }
      if (page.length < 500) break;
    }
    await writeFile(resolve(out, 'executor-events.json'), JSON.stringify(redact(report.events), null, 2) + '\n');
  }
  function itemsFor(run) {
    return report.events.filter(event => event.kind === 'notification' && event.method === 'item/completed' && event.params?.threadId === run.thread_id && event.params?.turnId === run.turn_id).map(event => event.params.item).filter(Boolean);
  }
  async function finished(run, timeout = 360000) {
    const end = Date.now() + timeout; let notice = 0;
    while (Date.now() < end) {
      await events(); const current = await view(); activeRun = current.runs.find(value => value.id === run.id);
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(activeRun?.status)) return { run: activeRun, session: current };
      const pending = report.events.findLast(event => event.kind === 'approval_request' && (!event.params?.turnId || event.params.turnId === run.turn_id));
      if (pending) {
        report.blocked_request = { request_key: pending.request_key, method: pending.method, run_id: run.id };
        throw Error('Actual executor approval/input is pending; no synthetic answer was submitted');
      }
      if (Date.now() - notice > 10000) { console.log(`REAL_REVIEW_WAIT run=${run.id} status=${activeRun?.status} events=${report.events.length}`); notice = Date.now(); }
      await pause(500);
    }
    throw Error('Actual Agent turn timed out; never resubmit the objective automatically');
  }
  async function connect() {
    const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/ws/creation', { origin }), messages = [];
    const value = { socket, messages, inputSeq: 0 };
    socket.on('message', bytes => { const packet = JSON.parse(bytes.toString()); messages.push(packet); record({ transport: 'ws-receive', packet }); }); socket.on('error', () => {});
    value.send = packet => { record({ transport: 'ws-send', packet }); socket.send(JSON.stringify(packet)); };
    value.wait = async (predicate, mark = 0, timeout = 10000) => { const end = Date.now() + timeout; while (Date.now() < end) { const found = messages.slice(mark).find(predicate); if (found) return found; await pause(20); } throw Error('Own-world authenticated WS timed out: ' + JSON.stringify(redact(messages.slice(-3)))); };
    value.current = () => messages.findLast(packet => packet.type === 'world' && packet.packet?.action === 'snapshot')?.packet.snapshot;
    await new Promise((yes, no) => { socket.once('open', yes); socket.once('error', no); });
    value.send({ type: 'auth', token: owner.token }); await value.wait(packet => packet.type === 'authenticated');
    value.send({ type: 'subscribe', project_id: projectId, branch_id: 'main', resource_id: resourceId, generation: 1 }); await value.wait(packet => packet.type === 'baseline');
    const ping = setInterval(() => { if (socket.readyState === WebSocket.OPEN) value.send({ type: 'ping' }); }, 10000); ping.unref(); socket.once('close', () => clearInterval(ping));
    return value;
  }
  async function join(revision) {
    const mark = peer.messages.length; peer.send({ type: 'world_join', project_id: projectId, branch_id: 'main', resource_id: resourceId, source_revision: revision, runtime_build_id: runtime.build_id });
    const joined = await peer.wait(packet => packet.type === 'world' && packet.packet.action === 'join' || packet.type === 'error', mark, 70000); assert.equal(joined.type, 'world', JSON.stringify(joined));
    await snapshot(state => state.players[owner.user.id]?.online, mark); peer.inputSeq = peer.current().players[owner.user.id].last_input_seq; return joined.packet;
  }
  const snapshot = (predicate, mark = peer.messages.length) => peer.wait(packet => packet.type === 'world' && packet.packet?.action === 'snapshot' && predicate(packet.packet.snapshot), mark).then(packet => packet.packet.snapshot);
  function input(interact = false) {
    const state = peer.current(), input_seq = ++peer.inputSeq;
    peer.send({ type: 'world_input', input: { world_id: state.world_id, epoch: state.epoch, scene_revision: state.scene_revision, input_seq, move: [0, 0], interact } }); return input_seq;
  }
  async function capture(review, state, key) {
    const payload = { action: 'runtime_trace', request_id: key, review_id: review.id, expected_version: review.version, world_id: state.world_id, epoch: state.epoch, sequence: state.sequence };
    const result = ok(await request('POST', `/goals/${firstRun.goal_id}/capture`, owner, payload), 201);
    const response = await fetch(`${api}/goals/${firstRun.goal_id}/artifacts/${result.artifact.id}`, { headers: { authorization: `Bearer ${owner.token}` } }); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(sha(bytes), result.artifact.sha256); assert.equal(bytes.length, result.artifact.byte_length);
    const retained = JSON.parse(bytes); assert.deepEqual(retained.snapshot, state); assert.equal(sha(stable(state)), result.artifact.pin.state_hash); assert.equal(result.artifact.kind, 'runtime_trace'); assert.equal(result.artifact.pin.render_verified, false); assert.equal(result.artifact.pin.provenance, 'server_runtime_snapshot');
    assert.equal(result.artifact.pin.run_id, secondRun.id); assert.equal(result.artifact.pin.review_id, review.id); assert.equal(result.artifact.pin.revision, review.revision); assert.equal(result.artifact.pin.runtime_build_id, runtime.build_id);
    await writeFile(resolve(out, `${key}.json`), bytes); return { result, payload, retained };
  }
  async function step(id, title, fn) {
    const item = { id, title, status: 'running', started_at: Date.now(), observations: {} }; report.cases.push(item);
    await t.test(`${id} ${title}`, async () => { try { await fn(item.observations); item.status = 'passed'; } catch (error) { item.status = 'failed'; item.error = { message: error.message, stack: error.stack }; throw error; } finally { item.finished_at = Date.now(); await save(); console.log(`REAL_REVIEW_CASE ${id} ${item.status}`); } });
    if (item.status !== 'passed') throw Error(`Stop after ${id}; no replacement objective or fabricated evidence`);
  }
  try {
    await step('RB01', 'dedicated real project, account, flat world and actual executor availability', async o => {
      const health = ok(await request('GET', '/health', null)); assert.equal(health.agent_ready, true); assert.equal(health.worlds_ready, true);
      const runtimeResponse = await fetch(`${origin}/preview-runtime/manifest.json`); assert.equal(runtimeResponse.status, 200); runtime = await runtimeResponse.json(); assert.equal(runtime.build_id, expectedBuild); report.runtime_manifest = runtime;
      if (prior) {
        const access = JSON.parse(await readFile(resolve(dirname(resumePath), 'access.private.json'), 'utf8'));
        for (const [index, value] of access.users.entries()) {
          const user = ok(await request('POST', '/auth/login', null, { name: value.name, password: value.password }));
          assert.equal(user.user.id, value.user_id); if (index === 0) owner = user; else outsider = user;
        }
        projectId = prior.project_id; session = { id: prior.creator_session_id };
        report.project_id = projectId; report.creator_session_id = session.id;
        const existing = await view(); assert.equal(existing.runs.length, 1); assert.equal(existing.runs[0].id, prior.first_start.run.id);
        await writeFile(resolve(out, 'access.private.json'), JSON.stringify(access, null, 2), { mode: 0o600 });
        peer = await connect(); const joined = await join(undefined); // Explicit protocol reconnection to the still-running old live room.
        assert.equal(joined.world_id, prior.initial_world.world_id); assert.equal(joined.epoch, prior.initial_world.epoch); assert.equal(joined.scene_revision, prior.initial_world.scene_revision);
        report.initial_world = prior.initial_world; report.first_start = prior.first_start;
        const status = ok(await request('GET', '/agent/status')); assert.equal(status.ready, true); assert.equal(status.authenticated, true);
        model = prior.actual_model; assert.ok(status.models.some(value => value.model === model)); report.actual_model = model;
        o.resumed_same_session = session.id; o.original_run_id = existing.runs[0].id; o.original_run_status = existing.runs[0].status; o.world = joined;
        assert.equal((await request('GET', `/sessions/${session.id}`, outsider)).status, 403);
        return;
      }
      const privateUsers = [];
      for (const role of ['owner', 'outsider']) {
        const name = uid(`review-${role}`), password = uid('password'), user = ok(await request('POST', '/auth/register', null, { name, password }), 201);
        privateUsers.push({ name, password, user_id: user.user.id }); if (role === 'owner') owner = user; else outsider = user;
      }
      const created = ok(await request('POST', '/projects', owner, { name: uid('Independent actual Agent review'), template: 'empty' }), 201); projectId = created.project.id; report.project_id = projectId;
      ok(await request('POST', `${branchPath()}/transactions`, owner, { transaction_id: uid('fixture'), base_revision: created.branch.head, ops: [{ type: 'put_object', resource_id: resourceId, object_id: objectId, expected_version: null,
        object: { id: objectId, name: 'Independent review counter anchor', kind: 'anchor', position: [0, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1], components: {} } }] }));
      session = ok(await request('POST', `${branchPath()}/sessions`, owner, { title: 'Independent two-turn Agent review' }), 201); report.creator_session_id = session.id;
      const current = await branch(), object = current.manifest.resources[resourceId].objects.find(value => value.id === objectId);
      ok(await request('POST', `/sessions/${session.id}/attachments`, owner, { revision: current.head, resource_id: resourceId, object_id: objectId, expected_version: object.version }), 201);
      await writeFile(resolve(out, 'access.private.json'), JSON.stringify({ origin, project_id: projectId, session_id: session.id, users: privateUsers }, null, 2), { mode: 0o600 });
      peer = await connect(); report.initial_world = await join(current.head);
      const status = ok(await request('GET', '/agent/status')); assert.equal(status.ready, true); assert.equal(status.authenticated, true); assert.equal(status.executor, 'local-codex-app-server');
      model = status.default_model; assert.ok(model && status.models.some(value => value.model === model)); report.actual_model = model; o.executor = redact(status); o.world = report.initial_world;
      assert.equal((await request('GET', `/sessions/${session.id}`, outsider)).status, 403);
    });
    await step('RB02', 'first real turn produces a controlled failed Godot verification without publishing', async o => {
      const before = structuredClone(peer.current());
      const prompt = `Implement an interaction counter on the attached ${objectId} in ${resourceId}. This is an authorized independent two-phase integration test in this private project, not any other user game. In this first phase deliberately create a small broken GDScript candidate with one syntax error so the actual validator rejects it; the second phase will repair it. Read WORLD-API.md and the behavior API via world_read first. Use a normal shell/command to create and read back a local file independent-review-counter.gd. It should be a RefCounted API 1 counter intended to preserve state key interactions and increment it once per interact, but leave initialize with a missing parameter name (for example func initialize( -> Dictionary:) for this controlled negative phase. Publish the actual file with asset_publish, use world_apply with current versions to bind it as component id review-counter and an interactable radius 5 to the existing anchor, preserving all TRS. Call world_validate for the actual new revision and report its real failed result. STOP after this one failed technical validation. Do not repair the code in this turn and do not call world_publish. Do not modify server code, other workspaces, browsers, or invoke Blender. Do not fabricate a verification or acceptance. The same objective will be continued in a second real turn.`;
      const payload = { text: prompt, client_user_message_id: uid('real-review-message'), model };
      if (prior) {
        firstRun = prior.first_start.run; activeRun = firstRun; o.original_message_replay_verified_in = resolve(resumePath);
      } else {
        const started = ok(await request('POST', `/sessions/${session.id}/turns`, owner, payload), 202); activeRun = started.run; firstRun = started.run; report.first_start = started;
        assert.ok(firstRun.thread_id && firstRun.turn_id); const replay = ok(await request('POST', `/sessions/${session.id}/turns`, owner, payload), 202); assert.equal(replay.replayed, true); assert.equal(replay.run.id, firstRun.id);
      }
      const ended = await finished(firstRun); firstRun = ended.run; assert.equal(firstRun.status, 'completed');
      const current = await branch(), details = await reviewView(); assert.ok(firstRun.changes.includes(current.head)); assert.equal(firstRun.deliveries.length, 0);
      const failures = details.current_run.verification_records.filter(value => value.revision === current.head && value.status === 'failed'); assert.equal(failures.length, 1, 'Exactly the intended negative validation must actually run');
      const failure = failures[0]; assert.notEqual(failure.process.code, 0); assert.equal(failure.report.ok, false); assert.match(failure.report.error, /compile|parse|instantiate/i); assert.equal(failure.origin.run_id, firstRun.id);
      const items = itemsFor(firstRun); for (const tool of ['world_read', 'asset_publish', 'world_apply', 'world_validate']) assert.ok(items.some(item => item.type === 'dynamicToolCall' && item.tool === tool && item.success));
      assert.ok(items.some(item => item.type === 'commandExecution' && item.status === 'completed' && item.exitCode === 0)); assert.equal(items.some(item => item.tool === 'world_publish'), false);
      const after = await snapshot(state => state.tick > before.tick + 5); assert.equal(after.scene_revision, before.scene_revision); assert.equal(after.world_id, before.world_id); assert.deepEqual(after.runtime_fault, {});
      report.controlled_failed_verification = failure; o.run = firstRun; o.actual_failed_verification = failure; o.old_world_after = after; o.completed_items = items;
    });
    await step('RB03', 'review requests revision, then a second real turn repairs the same goal and truly publishes', async o => {
      const current = await branch();
      const criteria = [{ id: 'counter-one', text: '在这个独立世界发送一次真实 interact 输入，权威 interactions 从 0 变为 1，停止输入后不继续增加。' }];
      const opened = ok(await request('POST', `/goals/${firstRun.goal_id}/review`, owner, { request_id: uid('review-open'), expected_review_id: null, run_id: firstRun.id, revision: current.head, runtime_build_id: runtime.build_id, criteria, requires_application: true, verification_ids: [report.controlled_failed_verification.id], delivery_ids: [] }));
      firstReview = opened.review;
      assert.equal((await request('POST', `/goals/${firstRun.goal_id}/decision`, owner, { request_id: uid('bad-pass'), review_id: firstReview.id, expected_version: firstReview.version, outcome: 'pass', reason: 'Attempt must fail because actual technical validation failed', evidence_ids: [] })).status, 409);
      const revised = ok(await request('POST', `/goals/${firstRun.goal_id}/decision`, owner, { request_id: uid('request-revision'), review_id: firstReview.id, expected_version: firstReview.version, outcome: 'revise', reason: '真实 Godot 编译检查失败；请在同一目标修复这份候选，再验证和应用。', evidence_ids: [] })); firstReview = revised.review;
      const payload = { text: `Continue the SAME objective from our first phase. Read your existing independent-review-counter.gd and the actual API from world_read; do not rerun the negative phase. Repair the syntax and implement API 1 initialize preserving context.state interactions (default 0), and interact incrementing it by exactly 1. Keep component id review-counter, anchor ${objectId}, its TRS and interactable radius 5. Use a real native command to read/verify the file; publish the actual fixed script with asset_publish, update only the existing anchor using world_apply with fresh versions. Call world_validate on your actual new revision. If that real validation passes, call world_publish and wait for its genuine applied receipt. Report source revision, actual verification and delivery. Do not operate browsers, other projects, server code, or declare player acceptance. This second phase repairs our prior goal; it is not a new unrelated goal.`, client_user_message_id: uid('real-review-continuation'), model, goal_id: firstRun.goal_id, expected_run_id: firstRun.id };
      const started = ok(await request('POST', `/sessions/${session.id}/turns`, owner, payload), 202); activeRun = started.run; secondRun = started.run;
      assert.equal(secondRun.goal_id, firstRun.goal_id); assert.equal(secondRun.previous_run_id, firstRun.id); assert.equal(secondRun.thread_id, firstRun.thread_id); assert.notEqual(secondRun.turn_id, firstRun.turn_id);
      const stale = await request('POST', `/sessions/${session.id}/turns`, owner, { ...payload, client_user_message_id: uid('stale-continuation') }); assert.equal(stale.status, 409);
      const ended = await finished(secondRun); secondRun = ended.run; assert.equal(secondRun.status, 'completed');
      const replay = ok(await request('POST', `/sessions/${session.id}/turns`, owner, payload), 202); assert.equal(replay.replayed, true); assert.equal(replay.run.id, secondRun.id);
      const state = await view(); assert.equal(state.goals.length, 1); assert.deepEqual(state.goals[0].run_ids, [firstRun.id, secondRun.id]); assert.equal(state.runs.length, 2);
      const latest = await branch(), details = await reviewView(), verifications = details.current_run.verification_records.filter(value => value.revision === latest.head && value.status === 'passed'), deliveries = details.current_run.delivery_records.filter(value => value.revision === latest.head);
      assert.ok(verifications.length >= 1 && deliveries.length >= 1); assert.ok(secondRun.changes.includes(latest.head));
      for (const value of verifications) { assert.equal(value.process.code, 0); assert.equal(value.report.ok, true); assert.equal(value.origin.run_id, secondRun.id); }
      const items = itemsFor(secondRun); for (const tool of ['world_read', 'asset_publish', 'world_apply', 'world_validate', 'world_publish']) assert.ok(items.some(item => item.type === 'dynamicToolCall' && item.tool === tool && item.success));
      const applied = await snapshot(value => value.scene_revision === latest.head && value.object_states[objectId]?.['review-counter']); assert.equal(applied.world_id, report.initial_world.world_id); assert.equal(applied.epoch, report.initial_world.epoch);
      const newReview = ok(await request('POST', `/goals/${firstRun.goal_id}/review`, owner, { request_id: uid('second-review'), expected_review_id: firstReview.id, run_id: secondRun.id, revision: latest.head, runtime_build_id: runtime.build_id, criteria, requires_application: true, verification_ids: verifications.map(value => value.id), delivery_ids: deliveries.map(value => value.id) }));
      finalReview = newReview.review; assert.equal(finalReview.previous_review_id, firstReview.id); assert.equal(finalReview.cycle, 2); assert.equal(finalReview.objective, firstReview.objective);
      o.first_review = firstReview; o.second_review = finalReview; o.run = secondRun; o.actual_verifications = verifications; o.actual_deliveries = deliveries; o.applied_snapshot = applied; o.completed_items = items;
    });
    await step('RB04', 'real input plus two private server captures substantiate a review decision', async o => {
      const noEvidence = await request('POST', `/goals/${firstRun.goal_id}/decision`, owner, { request_id: uid('missing-experience'), review_id: finalReview.id, expected_version: finalReview.version, outcome: 'pass', reason: 'Must reject until observed evidence exists', evidence_ids: [] }); assert.equal(noEvidence.status, 409);
      const before = await snapshot(state => state.object_states[objectId]?.['review-counter']?.interactions === 0);
      const capturedBefore = await capture(finalReview, before, uid('before-input'));
      const mark = peer.messages.length, seq = input(true);
      await snapshot(state => state.players[owner.user.id].last_input_seq >= seq && state.object_states[objectId]['review-counter'].interactions === 1, mark);
      const stopSeq = input(false), stopped = await snapshot(state => state.players[owner.user.id].last_input_seq >= stopSeq);
      const after = await snapshot(state => state.tick >= stopped.tick + 15); assert.equal(after.object_states[objectId]['review-counter'].interactions, 1);
      const capturedAfter = await capture(finalReview, after, uid('after-input'));
      const repeat = ok(await request('POST', `/goals/${firstRun.goal_id}/capture`, owner, capturedAfter.payload), 201); assert.equal(repeat.replayed, true); assert.equal(repeat.artifact.id, capturedAfter.result.artifact.id);
      const arbitrary = await request('POST', `/goals/${firstRun.goal_id}/capture`, owner, { ...capturedAfter.payload, request_id: uid('reject-file-path'), path: '/tmp/not-an-authority-observation' }); assert.equal(arbitrary.status, 400);
      const refs = [capturedBefore.result.artifact.id, capturedAfter.result.artifact.id];
      const linked = ok(await request('POST', `/goals/${firstRun.goal_id}/evidence`, owner, { request_id: uid('evidence'), review_id: finalReview.id, expected_version: finalReview.version, artifact_refs: refs,
        checks: [{ criterion_id: 'counter-one', result: 'passed', observation: `真实认证WS输入序号${seq}：权威计数在sequence ${before.sequence} 为0，在sequence ${after.sequence}为1；停止输入后经过${after.tick - stopped.tick}个tick仍为1。两份原始server runtime_trace已读取并校验SHA。` }] })); finalReview = linked.review;
      const payload = { request_id: uid('accept'), review_id: finalReview.id, expected_version: finalReview.version, outcome: 'pass', reason: '独立协议验收：两份服务端真实权威快照及实际输入满足此计数条件；不表示浏览器画面或完整Case13 UI已通过。', evidence_ids: [linked.evidence.id] };
      const accepted = ok(await request('POST', `/goals/${firstRun.goal_id}/decision`, owner, payload)); finalReview = accepted.review;
      const decisionReplay = ok(await request('POST', `/goals/${firstRun.goal_id}/decision`, owner, payload)); assert.equal(decisionReplay.replayed, true); assert.equal(decisionReplay.decision.id, accepted.decision.id);
      assert.equal((await request('POST', `/goals/${firstRun.goal_id}/decision`, owner, { ...payload, reason: 'altered request content' })).status, 409);
      const acceptedView = await reviewView(); assert.equal(acceptedView.acceptance, 'accepted'); assert.equal(acceptedView.execution.status, 'completed'); assert.equal(acceptedView.verification, 'passed'); assert.equal(acceptedView.application, 'applied');
      await snapshot(state => state.tick > after.tick + 20); assert.equal((await reviewView()).acceptance, 'accepted', 'Normal world sequence progress does not invalidate the fixed decision');
      const outsiderResponse = await fetch(`${api}/goals/${firstRun.goal_id}/artifacts/${refs[0]}`, { headers: { authorization: `Bearer ${outsider.token}` } }); assert.equal(outsiderResponse.status, 403);
      o.before = capturedBefore; o.after = capturedAfter; o.actual_input_seq = seq; o.evidence = linked.evidence; o.decision = accepted.decision; o.final_view = acceptedView;
    });
    await step('RB05', 'same-goal history and private executor evidence survive complete paginated reads', async o => {
      await events(); const state = await view(), history = ok(await request('GET', `/goals/${firstRun.goal_id}/history`)).history;
      assert.equal(state.goals.length, 1); assert.equal(state.runs.length, 2); assert.equal(state.messages.filter(value => value.role === 'user').length, 2);
      assert.equal(history.length, 2); assert.equal(history[0].decision.outcome, 'revise'); assert.equal(history[1].decision.outcome, 'pass');
      assert.equal(history[0].review.run_id, firstRun.id); assert.equal(history[1].review.run_id, secondRun.id); assert.equal(history[0].review.objective, history[1].review.objective);
      assert.equal((await request('GET', `/sessions/${session.id}/events`, outsider)).status, 403);
      assert.equal(peer.messages.some(packet => packet.type === 'development_error'), false);
      o.goal = state.goals[0]; o.history = history; o.actual_thread_id = firstRun.thread_id; o.actual_turn_ids = [firstRun.turn_id, secondRun.turn_id]; o.event_count = report.events.length; o.last_cursor = cursor;
    });
    report.completed = true;
  } catch (error) { report.fatal_error = { message: error.message, stack: error.stack }; throw error; }
  finally {
    // Leave only this test client's world control. The shared server is not ours.
    if (peer?.socket.readyState === WebSocket.OPEN) { peer.send({ type: 'world_leave' }); peer.socket.close(); }
    if (session) { try { await events(); report.final_session = await view(); } catch (error) { report.final_read_error = error.message; } }
    if (activeRun && !['completed', 'failed', 'interrupted', 'cancelled'].includes(activeRun.status)) report.unfinished_own_run = { id: activeRun.id, session_id: session.id, status: activeRun.status, action: 'Needs explicit continuation/approval or exact-session cancellation; objective was not resent' };
    report.finished_at = new Date().toISOString(); report.counts = { executed: report.cases.length, passed: report.cases.filter(value => value.status === 'passed').length, failed: report.cases.filter(value => value.status === 'failed').length };
    report.source_hashes_after = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(resolve(codeRoot, file)))]))); report.source_changed_during_run = sourceFiles.filter(file => report.source_hashes[file] !== report.source_hashes_after[file]);
    if (report.source_changed_during_run.length || report.unfinished_own_run) report.completed = false;
    await save(); await writeFile(resolve(out, 'executed-driver.mjs'), await readFile(fileURLToPath(import.meta.url)));
    console.log(`REAL_AGENT_REVIEW_REPORT ${resolve(out, 'report.json')}`);
  }
});
