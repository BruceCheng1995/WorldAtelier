import {referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip} from '../../apps/creation-workspace/reference-components.js';
import { leadingSemanticMode } from '../../apps/creation-workspace/semantic-workspace-context.js';
import { unresolvedComposerReferences } from '../../apps/creation-workspace/semantic-composer.js';
// Independent pure presentation tests. No DOM, browser, runtime or Agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const entrySource=readFileSync(new URL('../../apps/creation-workspace/workspace.js',import.meta.url),'utf8');
const presentationSource=entrySource.split('// BEGIN CHAT PRESENTATION')[1].split('\n').slice(1).join('\n').split('// END CHAT PRESENTATION')[0];
const {renderMarkdown,collectToolCalls,renderToolCalls,reasoningOptions,effortLabel}=await import('data:text/javascript;base64,'+Buffer.from(presentationSource).toString('base64'));


const notification = (method, item, extra = {}) => ({ kind: 'notification', method, at: 1, params: { turnId: 'turn-a', threadId: 'thread-a', ...(item ? { item } : {}), ...extra } });

test('Markdown escapes raw HTML and script protocols while preserving safe links and code literals', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **bold** `a < b && c` [safe](https://example.com/?x=1&y=2)');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<code>a &lt; b &amp;&amp; c</code>'));
  assert.ok(html.includes('href="https://example.com/?x=1&amp;y=2"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.doesNotMatch(html, /<img\b|<script\b/);
  for (const url of ['javascript:alert', 'data:text/html;base64,PHNjcmlwdD4=', '//evil.example', '/\\evil.example', 'file:///private/file', 'vbscript:evil']) {
    assert.doesNotMatch(renderMarkdown(`[link](${url})`), /<a\b/, url);
  }
  assert.ok(renderMarkdown('[quote](https://example.com/"onclick="x)').includes('&quot;onclick=&quot;x'));
});

test('Markdown formats paragraphs, headings, nested lists, tasks, quotes and horizontal separators', () => {
  const html = renderMarkdown('# Heading\n\nFirst **strong** and *emphasis*.\nSecond line.\n\n- Parent\n  - Child\n- [x] Done\n- [ ] Waiting\n\n3. Third\n4. Fourth\n\n> Quoted `code`\n\n---');
  assert.ok(html.includes('<h2>Heading</h2>'));
  assert.ok(html.includes('<br>Second line.'));
  assert.equal((html.match(/<ul>/g) ?? []).length, 2);
  assert.ok(html.includes('<ol start="3">'));
  assert.ok(html.includes('aria-label="已完成" checked'));
  assert.ok(html.includes('aria-label="未完成"'));
  assert.ok(html.includes('<blockquote><p>Quoted <code>code</code></p></blockquote>'));
  assert.ok(html.endsWith('<hr>'));
});

test('Markdown table cells and closed or streaming code fences remain escaped and readable', () => {
  const table = renderMarkdown('| Name | Value |\n| --- | --- |\n| **Door** | `a \\| b` |\n| <script> | 3 |');
  assert.ok(table.includes('role="region" aria-label="回复中的表格"'));
  assert.ok(table.includes('<th>Name</th>'));
  assert.ok(table.includes('<td><strong>Door</strong></td>'));
  assert.ok(table.includes('<code>a | b</code>'));
  assert.doesNotMatch(table, /<script>/);
  for (const suffix of ['', '\n```']) {
    const code = renderMarkdown('```js\nconst text = "<div>";\n# not a heading' + suffix);
    assert.ok(code.includes('data-copy-code'));
    assert.ok(code.includes('<pre><code>const text = &quot;&lt;div&gt;&quot;;\n# not a heading</code></pre>'));
    assert.doesNotMatch(code, /<h\d>/);
  }
});

test('tool start, output and completion fold into one row per turn/item and retain bounded output', () => {
  const command = { id: 'cmd', type: 'commandExecution', command: 'printf value', status: 'inProgress' };
  const events = [
    notification('item/started', command),
    notification('item/commandExecution/outputDelta', null, { itemId: 'cmd', delta: 'x'.repeat(25000) }),
    notification('item/completed', { ...command, status: 'completed', exitCode: 0 }),
    notification('item/completed', { ...command, status: 'completed', exitCode: 0 }),
    notification('item/started', command, { turnId: 'turn-b' }),
    notification('item/completed', { id: 'answer', type: 'agentMessage', text: 'not a tool' }),
  ];
  const calls = collectToolCalls(events);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, 'turn-a:cmd'); assert.equal(calls[1].key, 'turn-b:cmd');
  assert.equal(calls[0].done, true); assert.equal(calls[1].done, false);
  assert.equal(calls[0].streamedOutput.length, 24000);
});

test('tool duplicate start cannot make a known completed tool appear running again', () => {
  const item = { id: 'cmd', type: 'commandExecution', command: 'true' };
  const calls = collectToolCalls([
    notification('item/started', { ...item, status: 'inProgress' }),
    notification('item/completed', { ...item, status: 'completed', exitCode: 0 }),
    notification('item/started', { ...item, status: 'inProgress' }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].done, true);
  assert.equal(calls[0].status, 'completed');
});

test('tool groups default to folded and expose a failure count without expansion', () => {
  const calls = collectToolCalls([
    notification('item/completed', { id: 'good', type: 'commandExecution', command: 'true', status: 'completed', exitCode: 0 }),
    notification('item/completed', { id: 'bad', type: 'commandExecution', command: '<script>bad</script>', status: 'completed', exitCode: 7, aggregatedOutput: '<img src=x>' }),
  ]);
  const html = renderToolCalls(calls, 'turn-a');
  assert.doesNotMatch(html, /<details\b[^>]*\bopen\b/);
  assert.ok(html.includes('data-disclosure="turn-a"'));
  assert.ok(html.includes('tool-failed'));
  assert.ok(html.includes('退出码 7'));
  assert.doesNotMatch(html, /<script>|<img\b/);
  const groupSummary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
  assert.match(groupSummary, /1.*失败|失败.*1/, 'a failed tool must be evident while the outer group is folded');
});

test('tool failure detail preserves error text when there is no output', () => {
  const call = { key: 'turn:tool', type: 'mcpToolCall', tool: 'world_read', done: true, status: 'failed', error: { message: 'Fixed revision no longer available <retry>' } };
  const html = renderToolCalls([call]);
  assert.ok(html.includes('Fixed revision no longer available &lt;retry&gt;'));
});

test('reasoning options come from the model catalogue without invented effort choices', () => {
  assert.deepEqual(reasoningOptions(null), []);
  assert.deepEqual(reasoningOptions({ supportedReasoningEfforts: [] }), []);
  assert.deepEqual(reasoningOptions({ supportedReasoningEfforts: ['low', { reasoningEffort: 'high', description: 'Detailed' }, {}] }), [{ value: 'low', description: '' }, { value: 'high', description: 'Detailed' }]);
  assert.equal(effortLabel('high'), '高');
  assert.equal(effortLabel('future-effort'), 'future-effort');
});

const workspace = readFileSync(new URL('../../apps/creation-workspace/workspace.js', import.meta.url), 'utf8');
const asyncSources = [
  workspace.slice(workspace.indexOf('async function removeDraftAttachment('), workspace.indexOf('function flushDraft(){')),
  workspace.slice(workspace.indexOf('function sendDraft(){'), workspace.indexOf('async function retryTurn(){')),
].join('\n');
assert.ok(asyncSources.includes('async function saveSessionSettings('));
const deferred = () => { let resolvePromise, rejectPromise; const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; }); return { promise, resolve: resolvePromise, reject: rejectPromise }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function asyncComposerFixture() {
  const patch = deferred(), deletion = deferred(), observations = [], reports = [], requests = [], field = { value: 'Send after the context change', focus() {},dispatchEvent() {} };
  const server = { id: 's', model: 'model-a', effort: 'low', draft_attachments: [{ id: 'a', object_id: 'door' }] };
  const state = {
    sessionData: structuredClone(server), selectedSessionId: 's', sessionLoadGeneration: 1,
    branchIdentity: 'project/main', user: { id: 'owner' }, branch: { branch_id: 'main' }, project: { id: 'project' },
    settingsWrites: new Map(), attachmentWrites: new Map(), pendingTurnSubmissions: new Map(), sessionSendJobs: new Map(), sessionTitleWrites: new Map(),
    leadingSemanticMode,unresolvedComposerReferences,semanticComposerPending:false,semanticPreparingDraft:false,semanticModes:new Map(),prepareSemanticDraftForSend:async()=>true,canWrite:()=>true,
    branchKey: () => state.branchIdentity, ownSession: value => value?.id === 's',
    sessionRoute: sid => `sessions/${sid}`, report: error => reports.push(error), renderComposer() {}, updateSendButton() {}, toast() {},
    submissionScope: () => ({ project_id: 'project', branch_id: 'main', session_id: state.sessionData?.id, user_id: 'owner' }),
    copy: structuredClone, uuid: () => 'FAKE-ui-message', runBusy: () => false, $: () => field,
    flushDraft: async () => {}, sameSubmissionScope: submission => submission.scope.session_id === state.selectedSessionId,
    transmitSubmission: async submission => observations.push({ body: structuredClone(submission.body), attachments: structuredClone(server.draft_attachments) }),
    agentStatus: { ready: true, default_model: 'model-a' }, button: { disabled: false, isConnected: true },
    api: { api(path, options = {}) {
      requests.push({ path, options });
      if (options.method === 'PATCH') return patch.promise;
      if (options.method === 'DELETE') return deletion.promise;
      if (!options.method || options.method === 'GET') return Promise.resolve(structuredClone(server));
      throw Error('Unexpected FAKE API operation');
    } },
  };
  Object.assign(state,{Event,referenceToken,referenceIds,expandReferenceText,renderReferenceContent,referenceChip});vm.createContext(state); vm.runInContext(asyncSources, state);
  return { state, server, patch, deletion, observations, reports, requests, run: code => vm.runInContext(code, state) };
}

test('FAKE actual composer: late settings save cannot write into null data while the same session reloads', async () => {
  const f = asyncComposerFixture(), saving = f.run('saveSessionSettings({effort:"high"})');
  assert.equal(f.state.sessionData.effort, 'high');
  f.state.sessionLoadGeneration++; f.state.sessionData = null;
  f.patch.resolve({ ...f.server, effort: 'high' });
  await saving;
  assert.equal(f.state.sessionData, null);
  assert.deepEqual(f.reports, []);
});

test('FAKE actual composer: semantic mode PATCHes are serialized and exiting persists default', async () => {
  const f=asyncComposerFixture(),first=deferred(),second=deferred(),writes=[];
  f.state.api.api=(path,options)=>{writes.push({path,options});return writes.length===1?first.promise:second.promise;};
  const entering=f.run('saveSessionSettings({execution_mode:"plan"})');
  const exiting=f.run('saveSessionSettings({execution_mode:"default"})');
  assert.equal(writes.length,1);assert.equal(writes[0].options.body.execution_mode,'plan');
  assert.equal(f.state.semanticModes.get('s'),'normal');
  first.resolve({...f.server,execution_mode:'plan'});await tick();
  assert.equal(writes.length,2);assert.equal(writes[1].options.body.execution_mode,'default');
  assert.equal(f.state.sessionData.execution_mode,'default','earlier reply cannot overwrite the newer pending mode');
  second.resolve({...f.server,execution_mode:'default'});await Promise.all([entering,exiting]);
  assert.equal(f.state.sessionData.execution_mode,'default');assert.equal(f.state.settingsWrites.size,0);
});

test('FAKE actual composer: old settings reply or failure cannot override a newer visit to the same session', async () => {
  for (const fails of [false, true]) {
    const f = asyncComposerFixture(), saving = f.run('saveSessionSettings({effort:"high"})');
    f.state.sessionLoadGeneration++;
    f.state.sessionData = { ...f.server, effort: 'newer-choice' };
    if (fails) f.patch.reject(new Error('FAKE old PATCH failed'));
    else f.patch.resolve({ ...f.server, effort: 'high' });
    await saving;
    assert.equal(f.state.sessionData.effort, 'newer-choice');
  }
});

test('FAKE actual composer: sending waits for draft attachment removal before the executor context is captured', async () => {
  const f = asyncComposerFixture(), removing = f.run('removeDraftAttachment("s","a",button)');
  const sending = f.run('sendDraft()');
  await tick();
  assert.equal(f.observations.length, 0, 'send must not reach the server while DELETE is in flight');
  f.server.draft_attachments = []; f.deletion.resolve(structuredClone(f.server));
  await Promise.all([removing, sending]);
  assert.equal(f.observations.length, 1);
  assert.deepEqual(f.observations[0].attachments, []);
  assert.equal(f.observations[0].body.effort, 'low');
});

test('FAKE actual composer: failed attachment removal does not automatically send the original attachment', async () => {
  const f = asyncComposerFixture(), removing = f.run('removeDraftAttachment("s","a",button)'), sending = f.run('sendDraft()');
  const removedError = assert.rejects(removing, /FAKE removal failed/), sendError = assert.rejects(sending, /FAKE removal failed/);
  f.deletion.reject(new Error('FAKE removal failed'));
  await Promise.all([removedError, sendError]);
  assert.equal(f.observations.length, 0);
  assert.deepEqual(f.server.draft_attachments, [{ id: 'a', object_id: 'door' }]);
});
