/** Real live Codex integration test. Uses the CLI login, never reads credentials. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAgent } from '../services/creation/codex-agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.local', `codex-live-${Date.now()}`);
const cwd = path.join(dir, 'branch-workspace');
await mkdir(cwd, { recursive: true });
await writeFile(path.join(cwd, 'AGENTS.md'), '# Adapter verification workspace\nOnly modify adapter-note.txt in this directory. No project gameplay changes.\n');
const scope = { projectId: 'adapter-verification', branchId: 'probe', userId: 'tester', sessionId: `session-${Date.now()}` };
let events = [], calls = [], queuedWrites = Promise.resolve();
const specs = [{ type: 'function', name: 'world_read', description: 'Read the actual adapter verification workspace state and its stable marker. Use this tool before editing the probe file.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
const onDynamicTool = async request => {
  assert.equal(request.scope.branchId, scope.branchId); assert.equal(request.cwd, cwd);
  assert.equal(request.tool, 'world_read');
  const result = { marker: 'harbor-copper-472', file: await readFile(path.join(cwd, 'adapter-note.txt'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; }) };
  calls.push({ callId: request.callId, turnId: request.turnId, result });
  return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
};
const agent = new CodexAgent({ workspaceRoot: dir, requestTimeoutMs: 90_000 });
agent.on('event', event => {
  events.push(event);
  queuedWrites = queuedWrites.then(() => appendFile(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n'));
  if (event.kind === 'notification' && ['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(event.method)) {
    console.log(JSON.stringify({ method: event.method, turnId: event.params.turnId ?? event.params.turn?.id, type: event.params.item?.type, status: event.params.turn?.status ?? event.params.item?.status }));
  }
});
agent.on('request', request => {
  // Test never auto-accepts a real approval or invents a human answer.
  console.log('REAL_REQUEST_NEEDS_REVIEW ' + JSON.stringify(request));
});
let threadId;
try {
  await agent.start();
  const account = await agent.accountStatus();
  assert.equal(account.account?.type, 'chatgpt');
  const catalog = await agent.listModels(); const model = catalog.data.find(item => item.isDefault)?.model;
  assert.ok(model, 'No declared catalog default model');
  const created = await agent.createThread({ cwd, scope, dynamicTools: specs, onDynamicTool, model });
  threadId = created.thread.id;
  await writeFile(path.join(dir, 'thread.json'), JSON.stringify({ threadId, cwd, scope, dynamicTools: specs }, null, 2));
  console.log(JSON.stringify({ phase: 'thread-created', threadId, model: created.model, sandbox: created.sandbox, approval: created.approvalPolicy }));
  assert.equal(created.approvalPolicy, 'on-request'); assert.equal(created.sandbox.type, 'workspaceWrite');
  const attachments = [{ game: scope.projectId, branch: scope.branchId, scene: 'probe-scene', object_id: 'anchor-proof', source_revision: 'probe-rev-1', position: [1.25, 0.5, -2], immutable: true }];
  const first = await agent.sendTurn(threadId, { effort: 'low', attachments,
    text: 'This is a small adapter verification, not game development. Call the actual world_read dynamic tool once. Then use normal file editing to create adapter-note.txt in this current workspace containing exactly "phase=one\\nmarker=<the marker returned by world_read>\\n" with real newlines. Verify the file using the shell. Do not edit anything else, do not ask questions, and finish with a short factual result.' });
  attachments[0].position[0] = 999;
  const t1 = await agent.waitForTurn(threadId, first.turn.id, { timeoutMs: 300_000 });
  assert.equal(t1.status, 'completed'); assert.equal(await readFile(path.join(cwd, 'adapter-note.txt'), 'utf8'), 'phase=one\nmarker=harbor-copper-472\n');
  assert.ok(calls.some(c => c.turnId === t1.id));
  assert.equal(events.find(e => e.kind === 'submission').attachments[0].position[0], 1.25);
  const sameProcess = await agent.resumeThread({ threadId, cwd, scope, dynamicTools: specs, onDynamicTool });
  assert.equal(sameProcess.thread.id, threadId); assert.ok(sameProcess.reconciliation.canSend);
  const second = await agent.sendTurn(threadId, { effort: 'low', text: 'Continue the same adapter verification. Use world_read again, then append exactly "phase=two\n" to adapter-note.txt, retaining its existing lines. Verify the file using shell. Briefly state the immutable attachment X coordinate from our earlier message; do not use 999. No other file changes.' });
  const t2 = await agent.waitForTurn(threadId, second.turn.id, { timeoutMs: 300_000 });
  assert.equal(t2.status, 'completed'); assert.equal(await readFile(path.join(cwd, 'adapter-note.txt'), 'utf8'), 'phase=one\nmarker=harbor-copper-472\nphase=two\n');
  await agent.restart();
  const stored = await agent.readThread(threadId);
  assert.ok(stored.thread.turns.some(t => t.id === t1.id && t.status === 'completed'));
  assert.ok(stored.thread.turns.some(t => t.id === t2.id && t.status === 'completed'));
  const restored = await agent.resumeThread({ threadId, cwd, scope, dynamicTools: specs, onDynamicTool });
  assert.equal(restored.thread.id, threadId); assert.ok(restored.reconciliation.canSend);
  const third = await agent.sendTurn(threadId, { effort: 'low', text: 'The App Server process has restarted. Continue this stored thread without repeating prior edits: call the original world_read tool, then append exactly "phase=three\n" to adapter-note.txt and verify it using shell. Mention the first-turn marker from conversation history. Do not edit other files.' });
  const t3 = await agent.waitForTurn(threadId, third.turn.id, { timeoutMs: 300_000 });
  assert.equal(t3.status, 'completed');
  const contents = await readFile(path.join(cwd, 'adapter-note.txt'), 'utf8');
  assert.equal(contents, 'phase=one\nmarker=harbor-copper-472\nphase=two\nphase=three\n');
  assert.ok(calls.some(c => c.turnId === t3.id));
  const itemTypes = [...new Set(events.filter(e => e.kind === 'notification').map(e => e.params.item?.type).filter(Boolean))];
  assert.ok(itemTypes.includes('dynamicToolCall')); assert.ok(itemTypes.includes('commandExecution')); assert.ok(itemTypes.includes('fileChange'));
  const report = { outcome: 'passed', threadId, workspace: cwd, adapterVersion: 'codex-cli 0.147.0', model: created.model,
    turns: [t1,t2,t3].map(t => ({ id: t.id, status: t.status })), dynamicToolCalls: calls.length, itemTypes, contents,
    assertions: ['real dynamic world_read callback', 'normal shell and file edit stream', 'immutable attachment snapshot', 'same-process resume', 'process restart thread/read', 'persisted dynamic tool after resume', 'three distinct actual file edits'],
    limits: ['No gameplay task, UI Agent wiring, approval grant or large collaboration acceptance is claimed by this probe.'] };
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('CODEX_LIVE_PASSED ' + JSON.stringify(report));
} catch (error) {
  await writeFile(path.join(dir, 'failure.json'), JSON.stringify({ threadId, code: error.code, message: error.message, stack: error.stack }, null, 2));
  console.error('CODEX_LIVE_FAILED', dir, error); process.exitCode = 1;
} finally { await agent.stop(); await queuedWrites; console.log('EVIDENCE_DIRECTORY ' + dir); }
