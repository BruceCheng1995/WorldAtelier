const TERMINAL = new Set(['completed', 'interrupted', 'failed']);
const COMMAND_TERMINAL = new Set(['completed', 'failed', 'declined']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Drain only terminals with proven command item ownership in one cancelled turn.
 * The host invalidates the run lease BEFORE calling and owns the new-turn gate.
 * knownItemIds must come from private, persisted real events, never user input.
 * onEvent receives PRIVATE cleanup audit records, not synthetic executor events.
 * No interrupt request, replay, thread-wide clean, or OS process signal is sent.
 */
export async function drainCancelledTurn(adapter, {
  threadId, turnId, knownItemIds = [], knownItems = [], knownTerminations = [], onEvent = () => {}, timeoutMs = 10_000,
  quietMs = 1000, pollIntervalMs = 150,
} = {}) {
  if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId) throw new TypeError('Exact threadId and turnId required');
  if (!Array.isArray(knownItemIds) || knownItemIds.some(id => typeof id !== 'string' || !id)) throw new TypeError('knownItemIds must be real item ID strings');
  if (!Array.isArray(knownItems) || !Array.isArray(knownTerminations)) throw new TypeError('Persisted evidence arrays required');
  if (!(timeoutMs > 0) || !(quietMs >= 0) || !(pollIntervalMs > 0)) throw new TypeError('Invalid cleanup timing');
  const startedAt = Date.now(), deadline = startedAt + timeoutMs, commands = new Map();
  let turnStatus = null, lastActivityAt = startedAt, emptyChecks = 0, lastListed = [], disconnected = false;
  let reason = null, status = 'uncertain', auditFailure = null, audits = Promise.resolve();
  const audit = (kind, extra = {}) => {
    const event = { kind: 'cancel_cleanup', action: kind, threadId, turnId, at: Date.now(), ...structuredClone(extra) };
    audits = audits.then(() => onEvent(event)).catch(error => { auditFailure = error?.message ?? String(error); });
  };
  const record = id => {
    if (!commands.has(id)) { commands.set(id, { itemId: id, processId: null, completed: false, terminationConfirmed: false, terminationAttempted: false }); lastActivityAt = Date.now(); emptyChecks = 0; }
    return commands.get(id);
  };
  for (const id of knownItemIds) record(id);
  const ingest = (item, source) => {
    if (item?.type !== 'commandExecution' || typeof item.id !== 'string') return;
    const command = record(item.id), before = JSON.stringify(command);
    if (typeof item.processId === 'string' && item.processId) command.processId = item.processId;
    if (typeof item.cwd === 'string') command.cwd = item.cwd;
    if (COMMAND_TERMINAL.has(item.status)) { command.completed = true; command.commandStatus = item.status; command.exitCode = item.exitCode ?? null; }
    if (JSON.stringify(command) !== before) { lastActivityAt = Date.now(); emptyChecks = 0; audit('command_observed', { source, command }); }
  };
  // These are trusted private records from actual executor events/receipts.
  // They preserve completion evidence when resumed thread/read omits items.
  for (const item of knownItems) ingest(item, 'persisted_item');
  for (const proof of knownTerminations) {
    if (proof?.terminationConfirmed !== true || !commands.has(proof.itemId) || typeof proof.processId !== 'string') continue;
    const command = commands.get(proof.itemId);
    if (command.processId && command.processId !== proof.processId) continue;
    command.processId = proof.processId; command.terminationConfirmed = true;
  }
  const notification = event => {
    const p = event.params ?? {};
    if (p.threadId !== threadId) return;
    if (event.method === 'turn/completed' && p.turn?.id === turnId && TERMINAL.has(p.turn.status)) {
      turnStatus = p.turn.status; for (const item of p.turn.items ?? []) ingest(item, 'turn/completed');
    }
    if (p.turnId === turnId && ['item/started', 'item/completed'].includes(event.method)) ingest(p.item, event.method);
  };
  const lost = () => { disconnected = true; reason = 'executor_disconnected'; };
  // Listen before the first await: terminal may precede the command startup event.
  adapter.on('notification', notification); adapter.on('disconnected', lost);
  const remaining = () => Math.max(1, deadline - Date.now());
  const bounded = async (method, call) => {
    let timer;
    try { return await Promise.race([call(), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${method} cleanup deadline exceeded`), { code: 'CLEANUP_DEADLINE' })), remaining()); })]); }
    finally { clearTimeout(timer); }
  };
  const read = async () => {
    const result = await bounded('thread/read', () => adapter.readThread(threadId, { includeTurns: true, timeoutMs: remaining() }));
    if (result?.thread?.id !== threadId) throw new Error('thread/read returned a different thread');
    const turn = result.thread.turns?.find(t => t.id === turnId);
    if (turn && TERMINAL.has(turn.status)) turnStatus = turn.status;
    for (const item of turn?.items ?? []) ingest(item, 'thread/read');
  };
  const list = async () => {
    const all = [], seen = new Set(); let cursor;
    do {
      const result = await bounded('backgroundTerminals/list', () => adapter.listBackgroundTerminals(threadId, { cursor, limit: 100, timeoutMs: remaining() }));
      if (!Array.isArray(result?.data)) throw new Error('Invalid background terminal list');
      all.push(...result.data); cursor = result.nextCursor;
      if (cursor) { if (seen.has(cursor)) throw new Error('Background terminal pagination repeated a cursor'); seen.add(cursor); }
    } while (cursor && Date.now() < deadline && !disconnected);
    if (cursor) throw new Error('Background terminal list was incomplete');
    return all;
  };
  audit('started', { knownItemIds, timeoutMs, quietMs });
  try {
    while (Date.now() < deadline && !disconnected) {
      await read(); lastListed = await list();
      const owned = lastListed.filter(entry => commands.has(entry.itemId));
      for (const entry of owned) {
        const command = commands.get(entry.itemId);
        // itemId equality establishes turn ownership. A recorded cwd mismatch is
        // treated as corruption instead of broadening the cleanup authority.
        if (command.cwd && entry.cwd !== command.cwd) throw new Error('Owned terminal cwd changed');
        if (typeof entry.processId !== 'string' || !entry.processId) throw new Error('Owned terminal lacks executor processId');
        if (command.processId && command.processId !== entry.processId) throw new Error('Owned terminal processId changed');
        command.processId = entry.processId;
        if (!command.terminationAttempted) {
          command.terminationAttempted = true; lastActivityAt = Date.now(); emptyChecks = 0;
          audit('termination_requested', { itemId: entry.itemId, processId: entry.processId });
          const result = await bounded('backgroundTerminals/terminate', () => adapter.terminateBackgroundTerminal(threadId, entry.processId, { timeoutMs: remaining() }));
          command.terminationConfirmed = result?.terminated === true;
          audit('termination_result', { itemId: entry.itemId, processId: entry.processId, terminated: command.terminationConfirmed });
          // A false/uncertain mutation is not repeated. Reconcile its actual
          // command completion and presence until deadline, then report unknown.
        }
      }
      if (owned.length) { emptyChecks = 0; lastActivityAt = Date.now(); }
      else emptyChecks++;
      const unresolved = [...commands.values()].filter(command => !command.completed && !command.terminationConfirmed);
      if (turnStatus && !owned.length && !unresolved.length && emptyChecks >= 2 && Date.now() - lastActivityAt >= quietMs) {
        // This pass re-read the turn and all terminal pages after the quiet period.
        status = 'verified'; reason = 'owned_terminals_stopped_and_rechecked'; break;
      }
      await pause(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    if (status !== 'verified' && !reason) reason = !turnStatus ? 'turn_terminal_unconfirmed' : 'command_cleanup_unconfirmed';
  } catch (error) { reason = error?.message ?? String(error); audit('uncertain', { reason, code: error?.code ?? null }); }
  finally { adapter.off('notification', notification); adapter.off('disconnected', lost); }
  if (disconnected) { status = 'uncertain'; reason = 'executor_disconnected'; }
  await audits;
  if (auditFailure) { status = 'uncertain'; reason = `cleanup_audit_failed: ${auditFailure}`; }
  const result = { status, threadId, turnId, turnStatus, commands: [...commands.values()], reason,
    startedAt, settledAt: Date.now(), remainingOwnedItemIds: lastListed.filter(entry => commands.has(entry.itemId)).map(entry => entry.itemId) };
  audit('finished', { result }); await audits;
  if (auditFailure) { result.status = 'uncertain'; result.reason = `cleanup_audit_failed: ${auditFailure}`; }
  return result;
}
