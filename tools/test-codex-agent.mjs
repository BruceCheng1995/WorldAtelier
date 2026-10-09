/** Protocol unit tests with an explicit fake transport; not live execution evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdir, mkdtemp, symlink, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAgent } from '../services/creation/codex-agent.mjs';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.local');
await mkdir(base, { recursive: true });
const scope = { projectId: 'test-project', branchId: 'test-branch', userId: 'test-user', sessionId: 'test-session' };
const tool = { type: 'function', name: 'world_read', description: 'Unit test tool', inputSchema: { type: 'object', properties: {} } };
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeProcess extends EventEmitter {
  constructor(handler) {
    super(); this.pid = 1; this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.messages = [];
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      const message = JSON.parse(chunk); this.messages.push(message);
      queueMicrotask(() => handler(this, message)); done();
    } });
  }
  server(message) { this.stdout.write(JSON.stringify(message) + '\n'); }
  kill(signal) { queueMicrotask(() => { this.stdout.end(); this.stderr.end(); this.emit('close', 0, signal); }); return true; }
}
async function fixture(handler = null) {
  const root = await mkdtemp(path.join(base, 'adapter-unit-')), cwd = path.join(root, 'branch'); await mkdir(cwd);
  const processes = [];
  const turn = { id: 'turn-1', status: 'inProgress', items: [] };
  const serverHandler = (p, m) => {
    if (handler?.(p, m, { cwd, turn }) === true || m.id === undefined || !m.method) return;
    const thread = { id: 'thread-1', cwd, ephemeral: false, status: { type: 'idle' }, turns: [] };
    let result = {};
    if (m.method === 'initialize') result = { userAgent: 'unit-fake' };
    if (m.method === 'model/list') result = { data: [{ id: 'unit-model', model: 'unit-model', isDefault: true }] };
    if (m.method === 'thread/start' || m.method === 'thread/resume') result = { thread, model: 'unit-model', sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' };
    if (m.method === 'thread/read') result = { thread };
    if (m.method === 'turn/start') result = { turn };
    p.server({ id: m.id, result });
  };
  const agent = new CodexAgent({ workspaceRoot: root, requestTimeoutMs: 80, spawnProcess: () => { const p = new FakeProcess(serverHandler); processes.push(p); return p; } });
  await agent.start();
  return { agent, root, cwd, processes, get p() { return processes.at(-1); } };
}
async function bind(f, extra = {}) { return f.agent.createThread({ cwd: f.cwd, scope, dynamicTools: [tool], ...extra }); }

test('initialize capability and persistent thread settings use local schema', async () => {
  const f = await fixture(); try {
    await bind(f); const init = f.p.messages.find(m => m.method === 'initialize'); const start = f.p.messages.find(m => m.method === 'thread/start');
    assert.equal(init.params.capabilities.experimentalApi, true);
    assert.equal(start.params.ephemeral, false); assert.equal(start.params.sandbox, 'workspace-write'); assert.equal(start.params.approvalPolicy, 'on-request');
    assert.deepEqual(start.params.dynamicTools, [tool]); assert.deepEqual(start.params.runtimeWorkspaceRoots, [f.cwd]);
  } finally { await f.agent.stop(); }
});

test('new and resumed persistent tasks receive current file-based asset guidance and the same workspace skill entry',async()=>{
  const f=await fixture();try{
    await bind(f);
    await f.agent.resumeThread({threadId:'thread-1',cwd:f.cwd,scope,dynamicTools:[tool]});
    const instructions=f.p.messages.filter(message=>['thread/start','thread/resume'].includes(message.method)).map(message=>message.params.developerInstructions);
    assert.equal(instructions.length,2);
    for(const value of instructions){
      assert.ok(value.includes('.agents/skills/game-assets/SKILL.md'),'each persistent thread entry provides the actual packaged skill path');
      assert.match(value,/download/i);assert.match(value,/submit_native_workspace/);assert.match(value,/base64/i);
      assert.doesNotMatch(value,/assets (?:are|remain) read.only|only (?:edit|modify) text/i,'resume cannot restore the obsolete no-import contract');
    }
  }finally{await f.agent.stop();}
});

test('approval and input stay pending, reply forwards exact result, stale generation rejected', async () => {
  const f = await fixture(); const requests = []; f.agent.on('request', e => requests.push(e));
  try {
    f.p.server({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', command: 'echo ok' } });
    f.p.server({ id: 901, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [{ id: 'q1', question: 'Choose' }] } });
    assert.equal(f.agent.pendingRequests().length, 2); assert.equal(f.p.messages.some(m => m.id === 900), false);
    f.agent.replyRequest(requests[0].requestKey, { decision: 'decline' });
    f.agent.replyRequest(requests[1].requestKey, { answers: { q1: { answers: ['A'] } } });
    assert.equal(f.p.messages.find(m => m.id === 900).result.decision, 'decline');
    assert.deepEqual(f.p.messages.find(m => m.id === 901).result.answers.q1.answers, ['A']);
    await f.agent.restart(); assert.throws(() => f.agent.replyRequest(requests[0].requestKey, { decision: 'accept' }), { code: 'STALE_REQUEST' });
  } finally { await f.agent.stop(); }
});

test('dynamic tool callback receives fixed scope; undeclared tool fails without dispatch', async () => {
  const f = await fixture(); let called = 0;
  try {
    await bind(f, { onDynamicTool: async p => { called++; assert.deepEqual(p.scope, scope); assert.equal(p.cwd, f.cwd); return { success: true, contentItems: [{ type: 'inputText', text: 'actual callback value' }] }; } });
    f.p.server({ id: 99, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 't', callId: 'c', namespace: null, tool: 'world_read', arguments: {} } }); await tick();
    assert.equal(called, 1); assert.equal(f.p.messages.find(m => m.id === 99).result.success, true);
    f.p.server({ id: 100, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 't', callId: 'd', namespace: null, tool: 'other_tool', arguments: {} } }); await tick();
    assert.equal(called, 1); assert.equal(f.p.messages.find(m => m.id === 100).result.success, false);
  } finally { await f.agent.stop(); }
});

test('turn gate prevents concurrent starts; attachments captured before await and scope checked', async () => {
  const f = await fixture(); try {
    await bind(f); const attachments = [{ game: scope.projectId, branch: scope.branchId, position: [1,2,3] }];
    const first = f.agent.sendTurn('thread-1', { text: 'one', attachments }); attachments[0].position[0] = 999;
    await assert.rejects(f.agent.sendTurn('thread-1', { text: 'two' }), { code: 'TURN_BUSY_OR_UNCERTAIN' }); await first;
    const sent = f.p.messages.find(m => m.method === 'turn/start'), attachmentText = sent.params.input[1].text;
    const [reference] = JSON.parse(attachmentText.slice(attachmentText.indexOf('\n') + 1));
    assert.ok(reference.snapshot_file.startsWith(f.cwd + path.sep));
    assert.deepEqual(JSON.parse(await readFile(reference.snapshot_file, 'utf8')).position, [1, 2, 3], 'the reference snapshot captures data before the original attachment mutates');
    assert.ok(!attachmentText.includes('[1,2,3]')); assert.ok(!attachmentText.includes('999'), 'captured object details stay out of default context');
    f.p.server({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    await assert.rejects(f.agent.sendTurn('thread-1', { text: 'scope', attachments: [{ branch: 'wrong' }] }), { code: 'ATTACHMENT_SCOPE_MISMATCH' });
    assert.equal(f.p.messages.filter(m => m.method === 'turn/start').length, 1);
  } finally { await f.agent.stop(); }
});

test('terminal notification arriving before start response is not overwritten', async () => {
  const f = await fixture((p, m) => { if (m.method === 'turn/start') { p.server({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } }); p.server({ id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } }); return true; } });
  try { await bind(f); await f.agent.sendTurn('thread-1', { text: 'one' }); assert.equal((await f.agent.waitForTurn('thread-1', 'turn-1')).status, 'completed'); assert.equal(f.agent.threads.get('thread-1').busy, false); } finally { await f.agent.stop(); }
});

test('RPC timeout retains uncertain gate; restart never replays turn', async () => {
  const f = await fixture((_p, m) => m.method === 'turn/start');
  try {
    await bind(f); await assert.rejects(f.agent.sendTurn('thread-1', { text: 'one' }), { code: 'RPC_TIMEOUT', uncertain: true });
    await assert.rejects(f.agent.sendTurn('thread-1', { text: 'repeat' }), { code: 'TURN_BUSY_OR_UNCERTAIN' });
    await f.agent.restart(); assert.equal(f.processes.flatMap(p => p.messages).filter(m => m.method === 'turn/start').length, 1);
  } finally { await f.agent.stop(); }
});

test('persisted nonterminal turn stays fenced after resume', async () => {
  const f = await fixture((p, m, { cwd }) => { if (m.method === 'thread/resume') { p.server({ id: m.id, result: { thread: { id: 'thread-1', cwd, status: { type: 'idle' }, turns: [{ id: 'old', status: 'inProgress', items: [] }] } } }); return true; } });
  try { await bind(f); const r = await f.agent.resumeThread({ threadId: 'thread-1', cwd: f.cwd, scope, dynamicTools: [tool] }); assert.equal(r.reconciliation.uncertain, true); await assert.rejects(f.agent.sendTurn('thread-1', { text: 'replacement' }), { code: 'TURN_BUSY_OR_UNCERTAIN' }); } finally { await f.agent.stop(); }
});

test('workspace path replacement cannot redirect writes into another branch', async () => {
  const f = await fixture(); try {
    await bind(f); const other = path.join(f.root, 'other'); await mkdir(other); await rename(f.cwd, f.cwd + '-old'); await symlink(other, f.cwd);
    await assert.rejects(f.agent.sendTurn('thread-1', { text: 'write' }), { code: 'WORKSPACE_REPLACED' });
    assert.equal(f.p.messages.some(m => m.method === 'turn/start'), false);
  } finally { await f.agent.stop(); }
});

test('callback completion after disconnect is aborted and cannot emit a late reply', async () => {
  const f = await fixture(); let resolve, request;
  try {
    await bind(f, { onDynamicTool: p => { request=p; return new Promise(r => { resolve=r; }); } });
    f.p.server({ id: 99, method: 'item/tool/call', params: { threadId:'thread-1', turnId:'turn-1', callId:'call-1', namespace:null, tool:'world_read', arguments:{} } });
    await tick(); const process=f.p; await f.agent.stop(); assert.equal(request.signal.aborted, true);
    resolve({ success:true,contentItems:[{type:'inputText',text:'too late'}] }); await tick();
    assert.equal(process.messages.some(m=>m.id===99),false);
  } finally { await f.agent.stop(); }
});


test('lost start response remains fenced even when resumed thread is idle and empty', async () => {
  const f = await fixture((_p, m) => m.method === 'turn/start');
  try {
    await bind(f); await assert.rejects(f.agent.sendTurn('thread-1', { text: 'one', clientUserMessageId: 'durable-message-1' }), { code: 'RPC_TIMEOUT' });
    await f.agent.restart();
    const r = await f.agent.resumeThread({ threadId:'thread-1', cwd:f.cwd, scope, expectedClientUserMessageId:'durable-message-1' });
    assert.equal(r.reconciliation.missingExpectedTurn,true); assert.equal(r.reconciliation.canSend,false);
    const again = await f.agent.resumeThread({ threadId:'thread-1', cwd:f.cwd, scope });
    assert.equal(again.reconciliation.missingExpectedTurn,true); assert.equal(again.reconciliation.canSend,false);
    await assert.rejects(f.agent.sendTurn('thread-1', { text:'retry' }), { code:'TURN_BUSY_OR_UNCERTAIN' });
  } finally { await f.agent.stop(); }
});

test('durable user message client ID resolves only a matching persisted terminal turn', async () => {
  const f = await fixture((p,m,{cwd}) => { if(m.method==='thread/resume') {
    p.server({id:m.id,result:{thread:{id:'thread-1',cwd,status:{type:'idle'},turns:[{id:'done',status:'completed',items:[{type:'userMessage',clientId:'message-2'}]}]}}}); return true;
  }});
  try {
    const missing=await f.agent.resumeThread({threadId:'thread-1',cwd:f.cwd,scope,expectedClientUserMessageId:'message-other'});
    assert.equal(missing.reconciliation.canSend,false);
    const found=await f.agent.resumeThread({threadId:'thread-1',cwd:f.cwd,scope,expectedClientUserMessageId:'message-2'});
    assert.equal(found.reconciliation.matchedTurnId,'done'); assert.equal(found.reconciliation.canSend,true);
  } finally { await f.agent.stop(); }
});

test('duplicate tool request resends cached response without dispatching effects twice', async () => {
  const f=await fixture();let called=0;
  try {
    await bind(f,{onDynamicTool:async()=>{called++;return {success:true,contentItems:[{type:'inputText',text:'once'}]};}});
    const request={id:99,method:'item/tool/call',params:{threadId:'thread-1',turnId:'t',callId:'c',namespace:null,tool:'world_read',arguments:{}}};
    f.p.server(request);await tick();f.p.server(request);await tick();
    assert.equal(called,1);assert.equal(f.p.messages.filter(m=>m.id===99).length,2);
  }finally{await f.agent.stop();}
});

test('terminal turn aborts outstanding host callback before it can reply', async () => {
  const f=await fixture();let resolve,request;
  try {
    await bind(f,{onDynamicTool:p=>{request=p;return new Promise(r=>{resolve=r;});}});
    f.p.server({id:99,method:'item/tool/call',params:{threadId:'thread-1',turnId:'t',callId:'c',namespace:null,tool:'world_read',arguments:{}}});await tick();
    f.p.server({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'t',status:'interrupted',items:[]}}});
    assert.equal(request.signal.aborted,true);resolve({success:true,contentItems:[]});await tick();assert.equal(f.p.messages.some(m=>m.id===99),false);
  }finally{await f.agent.stop();}
});
