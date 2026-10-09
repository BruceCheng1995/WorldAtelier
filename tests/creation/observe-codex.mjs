// Test-only observation of actual RPC calls/results. It never creates a result.
import { appendFileSync } from 'node:fs';
import { CodexAgent } from '../../services/creation/codex-agent.mjs';

const path = process.env.WORLD_ATELIER_TEST_CODEX_TRACE;
if (path) {
  let sequence = 0;
  const actual = CodexAgent.prototype._rpc;
  const watched = new Set(['thread/start', 'thread/resume', 'thread/read', 'turn/start', 'turn/interrupt', 'thread/backgroundTerminals/list', 'thread/backgroundTerminals/terminate']);
  const log = value => appendFileSync(path, JSON.stringify({ at: Date.now(), server_pid: process.pid, ...value }) + '\n');
  CodexAgent.prototype._rpc = function (method, params, options) {
    if (!watched.has(method)) return actual.call(this, method, params, options);
    const call_id = ++sequence;
    const input = Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => ['threadId', 'turnId', 'processId', 'cursor', 'limit', 'model', 'cwd', 'clientUserMessageId'].includes(key)));
    log({ direction: 'request', call_id, method, params: input });
    return actual.call(this, method, params, options).then(result => {
      let value = result;
      if (method.startsWith('thread/') && !method.startsWith('thread/backgroundTerminals/')) value = { thread: { id: result.thread?.id, turns: result.thread?.turns?.map(t => ({ id: t.id, status: t.status, items: t.items?.filter(i => i.type === 'commandExecution') })) } };
      if (method === 'turn/start') value = { turn: { id: result.turn?.id, status: result.turn?.status } };
      log({ direction: 'result', call_id, method, value }); return result;
    }, error => { log({ direction: 'error', call_id, method, error: { message: error.message, code: error.code } }); throw error; });
  };
}
