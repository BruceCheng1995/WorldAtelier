/**
 * Independent Full access / requestUserInput contracts.
 * Actual adapter + explicit FAKE stdio transport, and actual HTTP/SQLite/service
 * with an explicit FAKE executor. No Codex process, paid turn, Godot or browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CodexAgent } from '../../services/creation/codex-agent.mjs';
import { CreationService } from '../../services/creation/service.mjs';
import { CreationStore } from '../../services/creation/store.mjs';
import { CreationAgentRuns } from '../../services/creation/agent-runs.mjs';
import { CreationCollaboration } from '../../services/creation/collaboration.mjs';
import { CreationInbox } from '../../services/creation/inbox.mjs';
import { hash } from '../../services/creation/schema.mjs';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../..', import.meta.url));
const uid = prefix => `${prefix}-${randomUUID()}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const scope = { projectId: 'FAKE-project', branchId: 'FAKE-branch', userId: 'FAKE-owner', sessionId: 'FAKE-session' };

class ExplicitFakeProcess extends EventEmitter {
  constructor(handler) {
    super(); this.pid = 1; this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.messages = [];
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      const message = JSON.parse(chunk); this.messages.push(message); queueMicrotask(() => handler(this, message)); done();
    } });
  }
  server(message) { this.stdout.write(JSON.stringify(message) + '\n'); }
  kill(signal) { queueMicrotask(() => { this.stdout.end(); this.stderr.end(); this.emit('close', 0, signal); }); return true; }
}

async function adapterFixture(t) {
  const data = realpathSync(mkdtempSync(resolve(tmpdir(), 'atelier-FAKE-access-adapter-'))), cwd = resolve(data, 'session'); mkdirSync(cwd);
  const turn = { id: 'FAKE-turn', status: 'completed', items: [] };
  let process;
  const agent = new CodexAgent({ workspaceRoot: data, requestTimeoutMs: 500, spawnProcess: () => {
    process = new ExplicitFakeProcess((p, message) => {
      if (message.id === undefined || !message.method) return;
      const thread = { id: 'FAKE-thread', cwd, ephemeral: false, status: { type: 'idle' }, turns: [] };
      let result = {};
      if (message.method === 'initialize') result = { userAgent: 'FAKE-test-transport' };
      if (message.method === 'model/list') result = { data: [{ model: 'FAKE-access-model', isDefault: true }] };
      if (message.method === 'thread/goal/get') result = { goal: null };
      if (['thread/start', 'thread/resume', 'thread/read'].includes(message.method)) result = { thread };
      if (message.method === 'turn/start') result = { turn };
      p.server({ id: message.id, result });
    }); return process;
  } });
  t.after(async () => { await agent.stop(); rmSync(data, { recursive: true, force: true }); });
  await agent.start();
  return { agent, cwd, get process() { return process; }, rpc: method => process.messages.filter(m => m.method === method).at(-1)?.params };
}

test('FAKE transport: omitted access stays workspace-write/on-request for create, resume and turn', async t => {
  const f = await adapterFixture(t);
  await f.agent.createThread({ cwd: f.cwd, scope });
  assert.equal(f.rpc('thread/start').sandbox, 'workspace-write'); assert.equal(f.rpc('thread/start').approvalPolicy, 'on-request');
  assert.equal(f.rpc('thread/start').config['features.default_mode_request_user_input'], true);
  await f.agent.resumeThread({ threadId: 'FAKE-thread', cwd: f.cwd, scope });
  assert.equal(f.rpc('thread/resume').sandbox, 'workspace-write'); assert.equal(f.rpc('thread/resume').approvalPolicy, 'on-request');
  assert.equal(f.rpc('thread/resume').config['features.default_mode_request_user_input'], true);
  await f.agent.sendTurn('FAKE-thread', { text: 'FAKE default turn' });
  const sent = f.rpc('turn/start'); assert.equal(sent.approvalPolicy, 'on-request'); assert.equal(sent.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(sent.sandboxPolicy.writableRoots, [f.cwd]);
});

test('FAKE transport: explicit Full access maps across create/resume/turn and can be downgraded next turn', async t => {
  const f = await adapterFixture(t);
  await f.agent.createThread({ cwd: f.cwd, scope, accessMode: 'full-access' });
  assert.equal(f.rpc('thread/start').sandbox, 'danger-full-access'); assert.equal(f.rpc('thread/start').approvalPolicy, 'never');
  await f.agent.resumeThread({ threadId: 'FAKE-thread', cwd: f.cwd, scope, accessMode: 'full-access' });
  assert.equal(f.rpc('thread/resume').sandbox, 'danger-full-access'); assert.equal(f.rpc('thread/resume').approvalPolicy, 'never');
  await f.agent.sendTurn('FAKE-thread', { text: 'FAKE full turn', accessMode: 'full-access' });
  assert.deepEqual(f.rpc('turn/start').sandboxPolicy, { type: 'dangerFullAccess' }); assert.equal(f.rpc('turn/start').approvalPolicy, 'never');
  await f.agent.sendTurn('FAKE-thread', { text: 'FAKE restricted turn', accessMode: 'workspace-write' });
  assert.equal(f.rpc('turn/start').sandboxPolicy.type, 'workspaceWrite'); assert.equal(f.rpc('turn/start').approvalPolicy, 'on-request');
});

test('FAKE transport: Full access preserves attachment scope and input prompts still require an exact explicit answer', async t => {
  const f = await adapterFixture(t), requests = []; f.agent.on('request', event => requests.push(event));
  await f.agent.createThread({ cwd: f.cwd, scope, accessMode: 'full-access' });
  await assert.rejects(f.agent.sendTurn('FAKE-thread', { text: 'wrong scope', accessMode: 'full-access', attachments: [{ branch_id: 'other' }] }), { code: 'ATTACHMENT_SCOPE_MISMATCH' });
  assert.equal(f.process.messages.filter(m => m.method === 'turn/start').length, 0);
  f.process.server({ id: 901, method: 'item/tool/requestUserInput', params: { threadId: 'FAKE-thread', turnId: 'FAKE-turn', itemId: 'FAKE-question', isBlocking: true, questions: [{ id: 'look', header: 'Style', question: 'Which style?', isOther: true, options: null }] } });
  await tick(); assert.equal(requests.length, 1); assert.equal(f.process.messages.some(m => m.id === 901), false);
  const result = { answers: { look: { answers: ['Custom style written by the user'] } } };
  f.agent.replyRequest(requests[0].requestKey, result);
  assert.deepEqual(f.process.messages.find(m => m.id === 901).result, result);
  assert.throws(() => f.agent.replyRequest(requests[0].requestKey, result));
});

class ExplicitFakeExecutor extends EventEmitter {
  constructor() { super(); this.connected = true; this.threads = new Map(); this.turns = new Map(); this.calls = []; this.pending = new Map(); this.replies = []; this.activeNext = false; }
  async start() { this.connected = true; }
  async listModels() { return { data: [{ model: 'FAKE-access-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }] }; }
  async accountStatus() { return { account: { type: 'FAKE-no-paid-account' } }; }
  async createThread(input) {
    const id = uid('FAKE-thread'); this.threads.set(id, { ...input, loaded: true, busy: false, uncertain: false });
    this.calls.push({ method: 'createThread', input }); return { thread: { id, turns: [] }, reconciliation: { canSend: true } };
  }
  async resumeThread(input) {
    this.threads.set(input.threadId, { ...input, loaded: true, busy: false, uncertain: false });
    this.calls.push({ method: 'resumeThread', input }); return { thread: { id: input.threadId, turns: [] }, reconciliation: { canSend: true } };
  }
  async sendTurn(threadId, input) {
    const turn = { id: uid('FAKE-turn'), status: this.activeNext ? 'inProgress' : 'completed', items: [] }; this.activeNext = false;
    this.turns.set(`${threadId}/${turn.id}`, turn); this.threads.get(threadId).busy = turn.status === 'inProgress'; this.calls.push({ method: 'sendTurn', input: structuredClone(input) }); return { turn };
  }
  pendingRequests(threadId) { return [...this.pending.values()].filter(r => r.params.threadId === threadId); }
  replyRequest(key, result) { assert.ok(this.pending.has(key), 'Fake transport rejects stale request'); this.replies.push({ key, result: structuredClone(result) }); this.pending.delete(key); }
  ask(run, overrides = {}) {
    const key = uid('FAKE-input'), params = { threadId: run.thread_id, turnId: run.turn_id, itemId: uid('FAKE-item'), isBlocking: true, questions: [
      { id: 'style', header: 'Style', question: 'Choose a style', isOther: true, options: [{ label: 'Minimal', description: 'Simple geometry' }, { label: 'Detailed', description: 'Many details' }] },
      { id: 'name', header: 'Name', question: 'Name the scene', isOther: true },
    ], ...overrides };
    const request = { key, requestKey: key, epoch: 'FAKE-epoch', id: key, category: 'input', method: 'item/tool/requestUserInput', params };
    this.pending.set(key, request); this.emit('request', request); return request;
  }
  complete(run) {
    const turn = { id: run.turn_id, status: 'completed', items: [] }; this.threads.get(run.thread_id).busy = false; this.turns.set(`${run.thread_id}/${run.turn_id}`, turn); this.emit('terminal', { threadId: run.thread_id, turn });
  }
  async stop() { this.connected = false; }
}

async function serviceFixture(t) {
  const data = mkdtempSync(resolve(tmpdir(), 'atelier-FAKE-access-service-')), file = resolve(data, 'creation.sqlite'), origin = 'http://127.0.0.1:48921';
  const service = Object.assign(Object.create(CreationService.prototype), { root, data, origin, hierarchyEditing: true, worlds: null, authAttempts: new Map(), store: new CreationStore(file), assets: { directory: resolve(data, 'assets') }, realtime: { committed() {}, sessionEvent() {}, development() {}, permissionsChanged() {}, close() {} } });
  const bindCollaboration = () => { service.inbox = new CreationInbox({ store: service.store }); service.collaboration = new CreationCollaboration({ store: service.store, inbox: service.inbox }); };
  bindCollaboration();
  mkdirSync(service.assets.directory); let executor = new ExplicitFakeExecutor(); service.agent = new CreationAgentRuns({ service, adapter: executor });
  const server = createServer((req, res) => { service.request(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(error => { res.writeHead(500); res.end(error.message); }); });
  t.after(async () => { await service.close(); if (server.listening) await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }); rmSync(data, { recursive: true, force: true }); });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(48921, '127.0.0.1', done); });
  const request = async (method, path, auth, body) => {
    const response = await fetch(`${origin}/creation-api${path}`, { method, headers: { origin, ...(auth ? { authorization: `Bearer ${auth.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const expect = (response, code = 200) => { assert.equal(response.status, code, JSON.stringify(response.body)); return response.body; };
  const owner = expect(await request('POST', '/auth/register', null, { name: uid('access-owner'), password: uid('password') }), 201);
  const peer = expect(await request('POST', '/auth/register', null, { name: uid('access-peer'), password: uid('password') }), 201);
  const made = expect(await request('POST', '/projects', owner, { name: 'Independent access fixture', template: 'empty' }), 201), branchPath = `/projects/${made.project.id}/branches/main`;
  const invite = expect(await request('POST', `/projects/${made.project.id}/invites`, owner, { role: 'editor' }), 201); expect(await request('POST', '/invites/join', peer, { code: invite.code }));
  return { service, owner, peer, request, expect, branchPath, get executor() { return executor; },
    session: async (input = {}) => expect(await request('POST', `${branchPath}/sessions`, owner, { title: 'Access fixture', ...input }), 201),
    get: async sid => expect(await request('GET', `/sessions/${sid}`, owner)),
    patch: (sid, input, who = owner) => request('PATCH', `/sessions/${sid}`, who, input),
    send: (sid, input = {}) => request('POST', `/sessions/${sid}/turns`, owner, { text: 'FAKE access contract', client_user_message_id: uid('FAKE-message'), ...input }),
    reply: (sid, key, result, who = owner) => request('POST', `/sessions/${sid}/requests/${encodeURIComponent(key)}`, who, { result }),
    async reopen() { await service.agent.close(); service.store.close(); service.store = new CreationStore(file); bindCollaboration(); executor = new ExplicitFakeExecutor(); service.agent = new CreationAgentRuns({ service, adapter: executor }); },
  };
}

test('Full access and input replies: actual independent HTTP/SQLite with FAKE executor', { timeout: 30000 }, async t => {
  const f = await serviceFixture(t);
  await t.test('new sessions default to Full access; owner-selected access validates and persists across SQLite reopen', async () => {
    const defaultSession = await f.session(); assert.equal(defaultSession.access_mode, 'full-access'); assert.equal(defaultSession.effort, 'medium');
    const s = await f.session({ access_mode: 'workspace-write' }); assert.equal(s.access_mode, 'workspace-write');
    f.expect(await f.patch(s.id, { access_mode: 'full-access' }));
    for (const access_mode of ['read-only', 'danger-full-access', '', null, {}, 1]) f.expect(await f.patch(s.id, { access_mode }), 400);
    f.expect(await f.patch(s.id, { access_mode: 'workspace-write' }, f.peer), 403);
    await f.reopen(); assert.equal((await f.get(s.id)).access_mode, 'full-access');
    const direct = await f.session({ access_mode: 'full-access' }); assert.equal(direct.access_mode, 'full-access');
    f.expect(await f.request('POST', `${f.branchPath}/sessions`, f.owner, { title: 'invalid access', access_mode: 'root' }), 400);
  });
  await t.test('run snapshots access and forwards it through create/resume and actual turn input', async () => {
    const s = await f.session({ access_mode: 'full-access' });
    const full = f.expect(await f.send(s.id), 202);
    assert.equal(full.run.access_mode, 'full-access');
    assert.equal(f.executor.calls.find(c => c.method === 'createThread').input.accessMode, 'full-access');
    assert.equal(f.executor.calls.filter(c => c.method === 'sendTurn').at(-1).input.accessMode, 'full-access');
    await f.reopen();
    const resumed = f.expect(await f.send(s.id), 202); assert.equal(resumed.run.access_mode, 'full-access');
    assert.equal(f.executor.calls.find(c => c.method === 'resumeThread').input.accessMode, 'full-access');
    f.expect(await f.patch(s.id, { access_mode: 'workspace-write' }));
    const restricted = f.expect(await f.send(s.id), 202); assert.equal(restricted.run.access_mode, 'workspace-write');
    assert.equal(f.executor.calls.filter(c => c.method === 'sendTurn').at(-1).input.accessMode, 'workspace-write');
    assert.equal((await f.get(s.id)).runs.find(r => r.id === full.run.id).access_mode, 'full-access');
  });
  await t.test('replay preserves original access mode and default request hashes remain backward compatible', async () => {
    const s = await f.session({ access_mode: 'workspace-write', effort: null }), input = { text: 'Default access identity', client_user_message_id: uid('FAKE-default-replay') };
    const first = f.expect(await f.send(s.id, input), 202); assert.equal(first.run.input_hash, hash({ text: input.text, model: null }));
    f.expect(await f.patch(s.id, { access_mode: 'full-access' }));
    const replay = f.expect(await f.send(s.id, input), 202); assert.equal(replay.run.id, first.run.id); assert.equal(replay.run.access_mode, 'workspace-write');
    f.expect(await f.send(s.id, { ...input, access_mode: 'full-access' }), 409);
    const explicit = { text: 'Full access identity', client_user_message_id: uid('FAKE-full-replay'), access_mode: 'full-access' };
    const full = f.expect(await f.send(s.id, explicit), 202); assert.equal(full.run.access_mode, 'full-access');
    f.expect(await f.send(s.id, { ...explicit, access_mode: 'workspace-write' }), 409);
  });
  await t.test('valid multi-question answers forward exact user strings once; another editor cannot answer a shared session', async () => {
    const s = await f.session({ access_mode: 'full-access' }); f.expect(await f.patch(s.id, { visibility: 'shared' }));
    f.executor.activeNext = true; const run = f.expect(await f.send(s.id), 202).run, pending = f.executor.ask(run);
    const answer = { answers: { style: { answers: ['Detailed'] }, name: { answers: ['自定义名字 <plain data>'] } } };
    f.expect(await f.reply(s.id, pending.key, answer, f.peer), 403); assert.equal(f.executor.replies.length, 0);
    f.expect(await f.reply(s.id, pending.key, answer)); assert.deepEqual(f.executor.replies.at(-1).result, answer);
    f.expect(await f.reply(s.id, pending.key, answer), 409); assert.equal(f.executor.replies.length, 1);
    f.executor.complete(run);
  });
  await t.test('invalid answers stay pending without forwarding or manufacturing missing input', async () => {
    const s = await f.session(); f.executor.activeNext = true; const run = f.expect(await f.send(s.id), 202).run, pending = f.executor.ask(run), before = f.executor.replies.length;
    const valid = { style: { answers: ['Minimal'] }, name: { answers: ['My scene'] } };
    for (const result of [null, {}, { answers: {} }, { answers: { style: valid.style } }, { answers: { ...valid, name: { answers: [] } } }, { answers: { ...valid, name: { answers: ['  '] } } }, { answers: { ...valid, name: { answers: [7] } } }, { answers: { ...valid, name: { answers: ['x'.repeat(10001)] } } }, { answers: { ...valid, unsolicited: { answers: ['extra'] } } }]) {
      f.expect(await f.reply(s.id, pending.key, result), 400); assert.equal(f.executor.replies.length, before); assert.ok(f.service.agent.requests.has(pending.key));
    }
    f.expect(await f.reply(s.id, pending.key, { answers: valid })); f.executor.complete(run);
  });
  await t.test('wrong turn, absent transport request, resolved and completed inputs cannot be answered', async () => {
    const answer = { answers: { style: { answers: ['Minimal'] }, name: { answers: ['Scene'] } } };
    const s = await f.session(); f.executor.activeNext = true; const run = f.expect(await f.send(s.id), 202).run;
    const foreign = f.executor.ask(run, { turnId: 'FAKE-other-turn' }); f.expect(await f.reply(s.id, foreign.key, answer), 409);
    const missing = f.executor.ask(run, { turnId: null }); f.expect(await f.reply(s.id, missing.key, answer), 409);
    const absent = f.executor.ask(run); f.executor.pending.delete(absent.key); f.expect(await f.reply(s.id, absent.key, answer), 409);
    const resolved = f.executor.ask(run); f.executor.emit('event', { kind: 'notification', epoch: 'FAKE-epoch', method: 'serverRequest/resolved', params: { threadId: run.thread_id, requestId: resolved.id } });
    // The transport owns epoch/id keys. Simulate its independent removal too.
    f.executor.pending.delete(resolved.key); f.expect(await f.reply(s.id, resolved.key, answer), 409);
    const terminal = f.executor.ask(run); f.executor.complete(run); f.expect(await f.reply(s.id, terminal.key, answer), 409);
  });
});

const workspaceSource = readFileSync(new URL('../../apps/creation-workspace/workspace.js', import.meta.url), 'utf8');
const questionSource = workspaceSource.slice(workspaceSource.indexOf('function renderQuestions(){'), workspaceSource.indexOf('async function copyChatText('));
const eventTextSource = workspaceSource.slice(workspaceSource.indexOf('function eventText(event){'), workspaceSource.indexOf('function pendingApprovals(){'));
const pendingApprovalsSource = workspaceSource.slice(workspaceSource.indexOf('function pendingApprovals(){'), workspaceSource.indexOf('function renderConversation(){'));
const updateAgentRequestsSource = workspaceSource.slice(workspaceSource.indexOf('export function updateAgentRequests('), workspaceSource.indexOf('// A separate read-only cache:')).replace('export function', 'function');
assert.ok(questionSource.startsWith('function renderQuestions(){'));
function questionFixture({ own = true, scrollTop = 1500 } = {}) {
  const scroller = { scrollHeight: 2000, scrollTop, clientHeight: 500, getBoundingClientRect: () => ({ top: 100 }) };
  const firstCard = { getBoundingClientRect: () => ({ top: 440 }) };
  let html = '', scrollUpdates = 0;
  const host = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; scroller.scrollHeight = 2000 + (value.includes('class="question-card"') ? 600 : 0); },
    querySelectorAll: () => [],
    querySelector: selector => selector === '.question-card' && html.includes('class="question-card"') ? firstCard : null,
  };
  const question = (id, extra = {}) => ({ id, header: 'Question', question: `Question ${id}`, ...extra });
  const request = { kind: 'approval_request', method: 'item/tool/requestUserInput', request_key: 'epoch:input', params: { questions: [
    question('strict', { options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }], isOther: false }),
    question('choice', { options: [{ label: 'C', description: 'Third' }], isOther: true }),
    question('secret', { options: null, isSecret: true }),
  ] } };
  const state = { $: selector => selector === '.composer-content' ? scroller : host, sessionData: { id: 'session' }, ownSession: () => own, canWrite: () => true, sessionEvents: [request],
    pendingApprovals: () => state.sessionEvents.some(e => e.kind === 'serverRequestReply') ? [] : [request],
    questionDrafts: new Map(), questionWrites: new Set(), questionHTMLKey: null,
    icon: name => `<i>${name}</i>`, esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    runLabel: value => value, copy: structuredClone, updateChatScroll: () => { scrollUpdates++; },
  };
  vm.createContext(state); vm.runInContext(questionSource + '\n' + eventTextSource, state);
  return { state, host, request, scroller, get scrollUpdates() { return scrollUpdates; }, render: () => vm.runInContext('renderQuestions()', state), eventText: event => { state.testEvent = event; return vm.runInContext('eventText(testEvent)', state); } };
}

test('FAKE question markup: pager presents its first option, requires submission, honors isOther and masks secrets', () => {
  const f = questionFixture(); f.render();
  assert.match(f.host.innerHTML, /value="0" checked/);
  assert.match(f.host.innerHTML, /data-question-id="choice" hidden/);
  assert.match(f.host.innerHTML, /data-question-id="secret" hidden/);
  assert.match(f.host.innerHTML, /下一题 →/);
  assert.equal(f.state.sessionEvents.some(event => event.kind === 'serverRequestReply'), false, 'rendering a suggested option must not send a user answer');
  const strict = f.host.innerHTML.split('data-question-id="strict"')[1].split('</fieldset>')[0];
  const choice = f.host.innerHTML.split('data-question-id="choice"')[1].split('</fieldset>')[0];
  const secret = f.host.innerHTML.split('data-question-id="secret"')[1].split('</fieldset>')[0];
  assert.doesNotMatch(strict, /question-custom|data-question-text/);
  assert.match(choice, /value="custom"/); assert.match(choice, /textarea/);
  assert.match(secret, /type="password"/); assert.match(secret, /autocomplete="off"/);
  const peer = questionFixture({ own: false }); peer.render(); assert.doesNotMatch(peer.host.innerHTML, /type="submit"/); assert.match(peer.host.innerHTML, /disabled/);
});

test('FAKE question display: answered secret is masked in the conversation and raw event view without mutating transport data', () => {
  const f = questionFixture(), reply = { kind: 'serverRequestReply', requestKey: 'epoch:input', result: { answers: { strict: { answers: ['A'] }, choice: { answers: ['Custom'] }, secret: { answers: ['PRIVATE-ANSWER-SENTINEL'] } } } };
  f.state.sessionEvents.push(reply); f.render();
  assert.doesNotMatch(f.host.innerHTML, /PRIVATE-ANSWER-SENTINEL/);
  assert.doesNotMatch(f.eventText(reply), /PRIVATE-ANSWER-SENTINEL/);
  assert.equal(reply.result.answers.secret.answers[0], 'PRIVATE-ANSWER-SENTINEL');
});

test('FAKE question scroll: a new question aligns its first row when the user was following the bottom', () => {
  const f = questionFixture();
  assert.equal(f.scroller.scrollHeight - f.scroller.scrollTop - f.scroller.clientHeight, 0);
  f.render();
  assert.equal(f.scroller.scrollTop, 1500 + 440 - 100 - 12);
  assert.equal(f.scrollUpdates, 1);
});

test('FAKE question scroll: reading conversation history is preserved when a new question appears', () => {
  const f = questionFixture({ scrollTop: 200 });
  f.render();
  assert.equal(f.scroller.scrollTop, 200);
  assert.equal(f.scrollUpdates, 1);
});

test('FAKE question scroll: an unchanged question redraw cannot pull a reader back to the question', () => {
  const f = questionFixture(); f.render();
  f.scroller.scrollTop = 300;
  f.render();
  assert.equal(f.scroller.scrollTop, 300);
  assert.equal(f.scrollUpdates, 1, 'same request identity does not trigger a second positioning pass');
});

test('FAKE actual request views: reconciliation removes stale questions, retains live ones, and never creates a reply', () => {
  const request = key => ({ kind: 'approval_request', request_key: key, method: 'item/tool/requestUserInput', params: { threadId: 'FAKE-thread', turnId: 'FAKE-turn' } });
  const events = [request('FAKE-old'), request('FAKE-live'), { kind: 'requests_reconciled', request_keys: ['FAKE-live'] }, request('FAKE-new')];
  const state = { sessionEvents: events, pending: new Map() };
  vm.createContext(state); vm.runInContext(pendingApprovalsSource + '\n' + updateAgentRequestsSource, state);
  const conversation = vm.runInContext('pendingApprovals()', state);
  const avatars = vm.runInContext('updateAgentRequests(pending,sessionEvents)', state);
  assert.deepEqual(Array.from(conversation, request => request.request_key), ['FAKE-live', 'FAKE-new']);
  assert.deepEqual([...avatars.keys()], ['FAKE-live', 'FAKE-new']);
  assert.equal(events.some(event => event.kind === 'serverRequestReply'), false);
  assert.equal(events[0].kind, 'approval_request', 'history is retained instead of being rewritten as an answer');
  state.sessionEvents.push({ kind: 'requests_reconciled', request_keys: [] });
  assert.equal(vm.runInContext('pendingApprovals().length', state), 0);
  assert.equal(vm.runInContext('updateAgentRequests(pending,sessionEvents).size', state), 0);
});
