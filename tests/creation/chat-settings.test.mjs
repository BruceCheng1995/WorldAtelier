/**
 * Independent chat settings contract: actual HTTP + SQLite + service/manager.
 * Executor and collaboration broadcast are explicitly FAKE; no Codex, Godot,
 * browser, paid model invocation or production service data is accessed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CreationService } from '../../services/creation/service.mjs';
import { CreationStore } from '../../services/creation/store.mjs';
import { CreationAgentRuns } from '../../services/creation/agent-runs.mjs';
import { hash } from '../../services/creation/schema.mjs';
import { SemanticAuthoring } from '../../services/creation/semantic-authoring.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const origin = 'http://127.0.0.1:48921';
const uid = prefix => `${prefix}-${randomUUID()}`;
const models = [
  { model: 'FAKE-chat-capable', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'medium', description: 'Medium' }, { reasoningEffort: 'high', description: 'High' }] },
  { model: 'FAKE-chat-limited', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low only' }] },
  { model: 'FAKE-chat-no-effort-catalog', supportedReasoningEfforts: [] },
];

class ExplicitFakeExecutor extends EventEmitter {
  constructor() { super(); this.connected = true; this.threads = new Map(); this.turns = new Map(); this.inputs = []; }
  async start() { this.connected = true; }
  async listModels() { return { data: structuredClone(models) }; }
  async accountStatus() { return { account: { type: 'FAKE-no-model-account' } }; }
  async createThread(input) {
    const id = uid('FAKE-thread');
    this.threads.set(id, { ...input, loaded: true, busy: false, uncertain: false });
    return { thread: { id, turns: [] }, reconciliation: { canSend: true } };
  }
  async resumeThread(input) {
    this.threads.set(input.threadId, { ...input, loaded: true, busy: false, uncertain: false });
    return { thread: { id: input.threadId, turns: [] }, reconciliation: { canSend: true } };
  }
  async sendTurn(threadId, input) {
    this.inputs.push(structuredClone(input));
    const turn = { id: uid('FAKE-turn'), status: 'completed', items: [] };
    this.turns.set(`${threadId}/${turn.id}`, turn);
    return { turn };
  }
  async stop() { this.connected = false; }
}

async function fixture(t) {
  const data = mkdtempSync(resolve(tmpdir(), 'atelier-FAKE-chat-settings-'));
  const file = resolve(data, 'creation.sqlite');
  const service = Object.assign(Object.create(CreationService.prototype), {
    root, data, origin, hierarchyEditing: true, worlds: null, authAttempts: new Map(),
    store: new CreationStore(file), assets: { directory: resolve(data, 'assets') },
    realtime: { committed() {}, sessionEvent() {}, development() {}, permissionsChanged() {}, close() {} },
  });
  mkdirSync(service.assets.directory);
  let executor = new ExplicitFakeExecutor();
  service.agent = new CreationAgentRuns({ service, adapter: executor });
  service.semantic = new SemanticAuthoring({store:service.store,commit:(...args)=>service.committed(...args)});
  const server = createServer((req, res) => { service.request(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(error => { res.writeHead(500); res.end(error.message); }); });
  t.after(async () => {
    await service.close();
    if (server.listening) await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); });
    rmSync(data, { recursive: true, force: true });
  });
  // Bind only the independent test port. EADDRINUSE must fail without touching
  // whichever process already owns the port.
  await new Promise((done, reject) => { server.once('error', reject); server.listen(48921, '127.0.0.1', done); });
  const request = async (method, path, auth, body) => {
    const response = await fetch(`${origin}/creation-api${path}`, { method, headers: { origin, ...(auth ? { authorization: `Bearer ${auth.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const expect = (response, code = 200) => { assert.equal(response.status, code, JSON.stringify(response.body)); return response.body; };
  const owner = expect(await request('POST', '/auth/register', null, { name: uid('chat-owner'), password: uid('password') }), 201);
  const peer = expect(await request('POST', '/auth/register', null, { name: uid('chat-peer'), password: uid('password') }), 201);
  const made = expect(await request('POST', '/projects', owner, { name: 'Independent chat settings fixture', template: 'empty' }), 201);
  const project = made.project.id, branchPath = `/projects/${project}/branches/main`;
  // Membership is fixture setup; this suite exercises chat/semantic HTTP rather
  // than the separate collaboration invitation and notification subsystem.
  service.store.setMember(owner.user,project,peer.user.id,'editor');
  const f = { service, data, owner, peer, request, expect, project, branchPath, get executor() { return executor; },
    session: async (input = {}, auth = owner) => expect(await request('POST', `${branchPath}/sessions`, auth, { title: 'Chat fixture', ...input }), 201),
    get: async sid => expect(await request('GET', `/sessions/${sid}`, owner)),
    patch: async (sid, input, auth = owner) => request('PATCH', `/sessions/${sid}`, auth, input),
    send: async (sid, input = {}) => request('POST', `/sessions/${sid}/turns`, owner, { text: 'Explicit FAKE executor contract only', client_user_message_id: uid('message'), ...input }),
    async reopenStore() {
      await service.agent.close(); service.store.close(); service.store = new CreationStore(file);
      executor = new ExplicitFakeExecutor(); service.agent = new CreationAgentRuns({ service, adapter: executor });
      service.semantic = new SemanticAuthoring({store:service.store,commit:(...args)=>service.committed(...args)});
    },
  };
  return f;
}

test('chat settings: independent HTTP/SQLite with FAKE executor', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await t.test('semantic knowledge HTTP stays pinned, creates real immutable attachments and persists execution mode',async()=>{
    const s=await f.session({execution_mode:'plan'});assert.equal(s.execution_mode,'plan');
    const before=f.expect(await f.request('GET',f.branchPath,f.owner));
    const write=f.expect(await f.request('POST',`${f.branchPath}/knowledge`,f.owner,{action:'put',transaction_id:uid('knowledge'),base_revision:before.head,knowledge_id:'chest-rules',expected_version:null,entry:{id:'chest-rules',title:'宝箱规则',content:'只给打开它的玩家奖励。',tags:['宝箱']}}));
    const search=f.expect(await f.request('GET',`${f.branchPath}/knowledge?q=${encodeURIComponent('宝箱')}&revision=${write.revision}`,f.owner));
    assert.equal(search.items.length,1);assert.equal(search.items[0].id,'knowledge:chest-rules');
    const attachment=f.expect(await f.request('POST',`/sessions/${s.id}/semantic-attachments`,f.owner,{kind:'knowledge',knowledge_id:search.items[0].id,project_id:f.project,branch_id:'main',revision:search.revision}),201);
    assert.equal(attachment.kind,'knowledge');assert.equal(attachment.snapshot.content,'只给打开它的玩家奖励。');
    f.expect(await f.request('POST',`/sessions/${s.id}/semantic-attachments`,f.peer,{kind:'knowledge',knowledge_id:search.items[0].id,project_id:f.project,branch_id:'main',revision:search.revision}),403);
    f.expect(await f.patch(s.id,{execution_mode:'goal'}));await f.reopenStore();
    const saved=await f.get(s.id);assert.equal(saved.execution_mode,'goal');assert.deepEqual(saved.draft_attachments[0],attachment);
    f.expect(await f.patch(s.id,{execution_mode:'invalid'}),400);
  });
  await t.test('new defaults reach first execution; references preserve history and replay identities',async()=>{
    const s=await f.session();assert.equal(s.access_mode,'full-access');assert.equal(s.effort,'medium');
    const explicit=await f.session({access_mode:'workspace-write',effort:null});assert.equal(explicit.access_mode,'workspace-write');assert.equal(explicit.effort,null);
    const branch=f.expect(await f.request('GET',f.branchPath,f.owner));
    const a=f.expect(await f.request('POST',`/sessions/${s.id}/semantic-attachments`,f.owner,{kind:'knowledge',knowledge_id:'knowledge:chest-rules',project_id:f.project,branch_id:'main',revision:branch.head}),201);
    const text=`请遵循 [[ref:${a.id}]]`,message=uid('reference');
    const result=f.expect(await f.send(s.id,{text,client_user_message_id:message}),202);
    assert.equal(result.run.access_mode,'full-access');assert.equal(result.run.effort,'medium');
    assert.equal(f.executor.inputs.at(-1).accessMode,'full-access');assert.equal(f.executor.inputs.at(-1).effort,'medium');
    assert.ok(f.executor.inputs.at(-1).text.startsWith('请遵循 $$宝箱规则'));assert.ok(!f.executor.inputs.at(-1).text.includes('[[ref:'));
    assert.equal(result.session.messages.at(-1).content,text);assert.equal(result.session.messages.at(-1).attachments[0].id,a.id);
    const count=f.executor.inputs.length;const replay=f.expect(await f.send(s.id,{text,client_user_message_id:message}),202);assert.ok(replay.replayed);assert.equal(f.executor.inputs.length,count);
    f.expect(await f.send(explicit.id,{text}),400);assert.equal(f.executor.inputs.length,count);
    await f.reopenStore();assert.equal((await f.get(s.id)).messages.at(-1).content,text);
  });
  await t.test('model catalogue exposes only actual configured efforts; session choice persists across reopening SQLite', async () => {
    const status = f.expect(await f.request('GET', '/agent/status', f.owner));
    assert.deepEqual(status.models[0].supportedReasoningEfforts, models[0].supportedReasoningEfforts);
    const s = await f.session({ model: models[0].model, effort: 'high' });
    assert.equal(s.effort, 'high');
    f.expect(await f.patch(s.id, { draft: '未发送草稿', effort: 'low' }));
    await f.reopenStore();
    const saved = await f.get(s.id);
    assert.equal(saved.model, models[0].model); assert.equal(saved.effort, 'low'); assert.equal(saved.draft, '未发送草稿');
  });
  await t.test('unsupported and malformed effort cannot partially save a draft or session', async () => {
    const s = await f.session({ model: models[0].model, effort: 'high' });
    f.expect(await f.patch(s.id, { draft: 'retained draft' }));
    const before = await f.get(s.id);
    for (const effort of ['ultra', 4, {}, ['low'], '']) {
      f.expect(await f.patch(s.id, { effort, draft: 'must not persist' }), 400);
      const after = await f.get(s.id); assert.equal(after.effort, before.effort); assert.equal(after.draft, before.draft);
    }
    f.expect(await f.request('POST', `${f.branchPath}/sessions`, f.owner, { title: 'invalid', model: models[1].model, effort: 'high' }), 400);
    f.expect(await f.request('POST', `${f.branchPath}/sessions`, f.owner, { title: 'invalid', model: models[2].model, effort: 'low' }), 400);
    f.expect(await f.patch(s.id, { model: models[1].model, effort: 'high' }), 400);
    assert.equal((await f.get(s.id)).model, models[0].model);
    f.expect(await f.patch(s.id, { model: models[1].model, effort: null }));
    const switched = await f.get(s.id); assert.equal(switched.model, models[1].model); assert.equal(switched.effort, null);
    f.expect(await f.patch(s.id, { effort: 'low' }, f.peer), 403);
  });
  await t.test('turns inherit session effort, explicit null uses model default, effective choice reaches executor and durable run', async () => {
    const s = await f.session({ model: models[0].model, effort: 'high' });
    const inherited = f.expect(await f.send(s.id), 202);
    assert.equal(inherited.run.effort, 'high'); assert.equal(f.executor.inputs.at(-1).effort, 'high');
    const cleared = f.expect(await f.send(s.id, { effort: null }), 202);
    assert.equal(cleared.run.effort ?? null, null); assert.equal(f.executor.inputs.at(-1).effort ?? null, null);
    const explicit = f.expect(await f.send(s.id, { effort: 'low' }), 202);
    assert.equal(explicit.run.effort, 'low'); assert.equal(f.executor.inputs.at(-1).effort, 'low');
    f.expect(await f.send(s.id, { effort: 'ultra' }), 400);
    f.expect(await f.send(s.id, { model: 'FAKE-model-outside-catalogue', effort: null }), 400);
    assert.equal(f.executor.inputs.length, 3, 'invalid model or effort never invokes executor');
  });
  await t.test('effort is immutable on request replay and legacy default hash remains compatible', async () => {
    const s = await f.session({ model: models[0].model, effort: null, access_mode:'workspace-write' });
    const firstInput = { text: 'default legacy payload', client_user_message_id: uid('legacy-default'), model: models[0].model };
    const initial = f.expect(await f.send(s.id, firstInput), 202);
    assert.equal(initial.run.input_hash, hash({ text: firstInput.text, model: firstInput.model }));
    const baseCount = f.executor.inputs.length;
    const replay = f.expect(await f.send(s.id, { ...firstInput, effort: null }), 202);
    assert.equal(replay.replayed, true); assert.equal(replay.run.id, initial.run.id); assert.equal(f.executor.inputs.length, baseCount);
    f.expect(await f.send(s.id, { ...firstInput, effort: 'high' }), 409);
    const input = { text: 'fixed effort payload', client_user_message_id: uid('effort-id'), model: models[0].model, effort: 'high' };
    const high = f.expect(await f.send(s.id, input), 202);
    assert.equal(f.expect(await f.send(s.id, input), 202).run.id, high.run.id);
    f.expect(await f.send(s.id, { ...input, effort: 'low' }), 409);
    f.expect(await f.send(s.id, { ...input, effort: null }), 409);
  });
  await t.test('removing one draft attachment is owner-only, idempotent, scoped, and preserves sent immutable observations', async () => {
    const s = await f.session();
    const scene = f.expect(await f.request('GET', f.branchPath, f.owner));
    const rid = scene.manifest.entry_scene_id;
    const created = f.expect(await f.request('POST', `${f.branchPath}/transactions`, f.owner, {
      transaction_id: uid('attachment-anchor'), base_revision: scene.head,
      ops: [{ type: 'put_object', resource_id: rid, object_id: 'annotation-anchor', expected_version: null, object: { id: 'annotation-anchor', name: '固定批注', kind: 'anchor', position: [12.5, 3, -8.25] } }],
    }));
    const current = f.expect(await f.request('GET', f.branchPath, f.owner));
    const target = current.manifest.resources[rid].objects.find(o => o.id === 'annotation-anchor');
    assert.ok(created.revision);
    const attach = async sid => f.expect(await f.request('POST', `/sessions/${sid}/attachments`, f.owner, { revision: current.head, resource_id: rid, object_id: target.id, expected_version: target.version }), 201);
    const sent = await attach(s.id);
    const turn = f.expect(await f.send(s.id), 202);
    const historic = turn.session.messages.find(m => m.role === 'user').attachments;
    assert.deepEqual(historic, [sent]);
    const first = await attach(s.id), retained = await attach(s.id);
    const remove = (sid, aid, auth = f.owner) => f.request('DELETE', `/sessions/${sid}/attachments/${aid}`, auth);
    f.expect(await remove(s.id, first.id, f.peer), 403);
    f.expect(await f.patch(s.id, { visibility: 'shared' }));
    f.expect(await remove(s.id, first.id, f.peer), 403);
    const another = await f.session();
    const other = await attach(another.id);
    f.expect(await remove(s.id, other.id));
    assert.equal((await f.get(another.id)).draft_attachments.length, 1);
    const removed = f.expect(await remove(s.id, first.id));
    assert.deepEqual(removed.draft_attachments, [retained]);
    f.expect(await remove(s.id, first.id));
    f.expect(await remove(s.id, sent.id));
    await f.reopenStore();
    const reopened = await f.get(s.id);
    assert.deepEqual(reopened.draft_attachments, [retained]);
    assert.deepEqual(reopened.messages.find(m => m.role === 'user').attachments, historic);
    assert.deepEqual(historic[0].position, [12.5, 3, -8.25]);
  });
  assert.equal(f.service.agent.lastProjectionError, undefined);
});
