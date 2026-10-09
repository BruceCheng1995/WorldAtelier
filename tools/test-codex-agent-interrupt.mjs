/** Real interrupt/reconcile probe on a stored thread from test-codex-agent-live.mjs. */
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexAgent } from '../services/creation/codex-agent.mjs';
if (!process.argv[2]) throw new Error('Pass an existing live-test evidence directory');
const directory = path.resolve(process.argv[2]);
const record = JSON.parse(await readFile(path.join(directory, 'thread.json'), 'utf8'));
const { threadId, cwd, scope, dynamicTools } = record;
const agent = new CodexAgent({ workspaceRoot: directory });
let events = [], interruptReceipt, interruptSent = false, writes = Promise.resolve();
agent.on('event', event => {
  events.push(event); writes = writes.then(() => appendFile(path.join(directory, 'interrupt-events.jsonl'), JSON.stringify(event) + '\n'));
  if (event.method === 'item/started' && event.params.item?.type === 'commandExecution' && !interruptSent) {
    interruptSent = true;
    interruptReceipt = agent.interrupt(threadId, event.params.turnId);
    interruptReceipt.catch(error => console.error('INTERRUPT_REQUEST_FAILED', error.message));
  }
});
agent.on('request', request => console.log('REAL_REQUEST_NEEDS_REVIEW', JSON.stringify(request)));
try {
  await agent.start();
  const before = await readFile(path.join(cwd, 'adapter-note.txt'), 'utf8');
  await agent.resumeThread({ threadId, cwd, scope, dynamicTools, onDynamicTool: async () => ({ success: true, contentItems: [{ type: 'inputText', text: await readFile(path.join(cwd, 'adapter-note.txt'), 'utf8') }] }) });
  const started = await agent.sendTurn(threadId, { effort: 'low', text: 'This is a real cancellation probe. Start one normal sandboxed shell command `python3 -c "import time; time.sleep(30)"` now. Do not modify any files. The host will interrupt the command; do not retry it.' });
  const terminal = await agent.waitForTurn(threadId, started.turn.id, { timeoutMs: 120_000 });
  assert.equal(interruptSent, true); await interruptReceipt;
  assert.equal(terminal.status, 'interrupted');
  const stored = await agent.readThread(threadId);
  assert.equal(stored.thread.turns.find(t => t.id === terminal.id)?.status, 'interrupted');
  assert.equal(await readFile(path.join(cwd, 'adapter-note.txt'), 'utf8'), before);
  const resumed = await agent.resumeThread({ threadId, cwd, scope, dynamicTools });
  assert.equal(resumed.reconciliation.canSend, true);
  const report = { outcome: 'passed', threadId, turnId: terminal.id, status: terminal.status, observedRealCommand: true, persistedInterruptedStatus: true, probeFileUnchanged: true, canResumeAfterInterrupt: true };
  await writeFile(path.join(directory, 'interrupt-report.json'), JSON.stringify(report, null, 2));
  console.log('CODEX_INTERRUPT_PASSED', JSON.stringify(report));
} finally { await agent.stop(); await writes; }
