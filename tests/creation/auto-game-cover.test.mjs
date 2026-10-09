/** Scheduler unit checks with explicit fake clock, capture and save dependencies.
 * They prove timing and stale-context guards, never Godot screenshot readiness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoGameCover, AUTO_COVER_DELAY, AUTO_COVER_INTERVAL, autoCoverEnabled} from '../../apps/creation-workspace/auto-game-cover.js';

const turn = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const auto = () => ({version: 0, auto_update: true, images: []});
const frame = state => ({document_id: `${state.project_id}/${state.branch_id}/${state.resource_id}`, source_revision: state.source_revision, runtime_build_id: 'a'.repeat(64), data_url: 'explicit-fake-capture-result'});
function fixture(t, overrides = {}) {
  const f = {now: 0, statuses: [], captures: 0, saves: [], refreshes: 0, state: {user_id: 'test-user', project_id: 'test-game', branch_id: 'main', resource_id: 'test-scene', source_revision: 'source-1', mode: 'edit', presentation: auto(), project_presentation: auto(), ready: true}};
  f.scheduler = new AutoGameCover({getState: () => f.state, clock: () => f.now,
    capture: async () => { f.captures++; return overrides.capture ? overrides.capture(f) : frame(f.state); },
    save: async (state, image) => { f.saves.push({state: structuredClone(state), image}); return overrides.save?.(f); },
    refresh: async () => { f.refreshes++; return overrides.refresh?.(f); },
    onStatus: status => f.statuses.push(status),
  });
  f.tick = async time => { f.now = time; f.scheduler.tick(); await turn(); };
  f.last = () => f.statuses.at(-1);
  t.after(() => f.scheduler.stop());
  return f;
}

test('new projects default to automatic; legacy curated images remain manual', () => {
  assert.equal(AUTO_COVER_DELAY, 10000); assert.equal(AUTO_COVER_INTERVAL, 60000);
  assert.equal(autoCoverEnabled(undefined), true); assert.equal(autoCoverEnabled({images: []}), true);
  assert.equal(autoCoverEnabled({images: [{id: 'manual-image'}]}), false);
  assert.equal(autoCoverEnabled({auto_update: true, images: [{id: 'old-image'}]}), true);
  assert.equal(autoCoverEnabled({auto_update: false, images: []}), false);
});

test('ready scenes count down ten seconds and refresh every sixty seconds after completion', async t => {
  const f = fixture(t); await f.tick(0); assert.equal(f.last().seconds, 10);
  await f.tick(9000); assert.equal(f.last().seconds, 1); assert.equal(f.captures, 0);
  await f.tick(10000); assert.equal(f.captures, 1); assert.equal(f.saves.length, 1); assert.equal(f.last().updated, true);
  await f.tick(69000); assert.equal(f.last().seconds, 1); assert.equal(f.captures, 1);
  await f.tick(70000); assert.equal(f.captures, 2); assert.equal(f.saves.length, 2);
});

test('source modifications restart the countdown, and unavailable frames keep it waiting', async t => {
  const f = fixture(t); await f.tick(0); f.state.source_revision = 'source-2'; await f.tick(9000);
  assert.equal(f.last().seconds, 10); await f.tick(10000); assert.equal(f.captures, 0);
  f.state.ready = false; f.state.wait_reason = '等待当前游戏画面'; await f.tick(18000);
  assert.equal(f.last().text, '等待当前游戏画面'); await f.tick(30000); assert.equal(f.captures, 0);
  f.state.ready = true; await f.tick(31000); assert.equal(f.last().seconds, 9);
  await f.tick(40000); assert.equal(f.saves.length, 1); assert.equal(f.saves[0].state.source_revision, 'source-2');
});

test('manual mode stops scheduling and restoration starts a fresh countdown', async t => {
  const f = fixture(t); f.state.branch_id = 'experiment'; await f.tick(0);
  f.state.presentation.auto_update = false; await f.tick(10000);
  assert.equal(f.last().manual, true); assert.equal(f.captures, 0);
  await f.tick(200000); assert.equal(f.captures, 0);
  f.state.presentation.auto_update = true; await f.tick(200001); assert.equal(f.last().seconds, 10);
  await f.tick(210000); assert.equal(f.captures, 0); await f.tick(210001); assert.equal(f.saves.length, 1);
});

test('main can update an automatic game while its branch is manual; other branches cannot', async t => {
  const f = fixture(t); f.state.presentation.auto_update = false;
  await f.tick(0); await f.tick(10000); assert.equal(f.saves.length, 1);
  f.state.branch_id = 'experiment'; await f.tick(20000); await f.tick(80000);
  assert.equal(f.last().manual, true); assert.equal(f.saves.length, 1);
});

test('a pending capture never overlaps another capture and switching branches prevents old submission', async t => {
  const pending = deferred(), f = fixture(t, {capture: () => pending.promise});
  await f.tick(0); await f.tick(10000); await f.tick(11000); assert.equal(f.captures, 1);
  const old = structuredClone(f.state); f.state = {...f.state, branch_id: 'other'};
  await f.tick(12000); pending.resolve(frame(old)); await turn();
  assert.equal(f.saves.length, 0); assert.equal(f.scheduler.busy, false);
  assert.equal(f.scheduler.due, 22000);
});

test('logout, loss of readiness and manual mode during capture suppress submission', async t => {
  for (const change of [f => { f.state = null; }, f => { f.state.ready = false; }, f => { f.state.presentation.auto_update = false; f.state.project_presentation.auto_update = false; }]) {
    const pending = deferred(), f = fixture(t, {capture: () => pending.promise});
    await f.tick(0); await f.tick(10000); const old = structuredClone(f.state); change(f);
    pending.resolve(frame(old)); await turn(); assert.equal(f.saves.length, 0); assert.equal(f.scheduler.busy, false);
  }
});

test('captured document and revision must match the scheduled context', async t => {
  for (const wrong of [{document_id: 'another/game/scene'}, {source_revision: 'obsolete-source'}]) {
    const f = fixture(t, {capture: f => ({...frame(f.state), ...wrong})});
    await f.tick(0); await f.tick(10000); assert.equal(f.saves.length, 0);
    assert.match(f.last().error, /切换/); assert.equal(f.scheduler.due, 70000);
  }
});

test('conflicts and permission changes refresh metadata and retry only after the interval', async t => {
  for (const status of [409, 403, 429]) {
    const f = fixture(t, {save: () => { throw Object.assign(new Error('explicit rejection'), {status}); }});
    await f.tick(0); await f.tick(10000); assert.equal(f.refreshes, 1);
    assert.equal(f.last().error, 'explicit rejection'); await f.tick(69000); assert.equal(f.saves.length, 1);
    await f.tick(70000); assert.equal(f.saves.length, 2); assert.equal(f.refreshes, 2);
  }
});

test('a late save response never reports success into a different branch', async t => {
  const pending = deferred(), f = fixture(t, {save: () => pending.promise});
  await f.tick(0); await f.tick(10000); assert.equal(f.saves.length, 1);
  f.state = {...f.state, branch_id: 'other'}; await f.tick(12000); pending.resolve(); await turn();
  assert.equal(f.statuses.some(s => s.updated), false); assert.equal(f.scheduler.due, 22000);
});

test('stopping while capture or save is pending emits no late status and never schedules again', async t => {
  for (const dependency of ['capture', 'save']) {
    const pending = deferred(), f = fixture(t, {[dependency]: () => pending.promise});
    await f.tick(0); await f.tick(10000); const old = structuredClone(f.state);
    f.scheduler.stop(); const count = f.statuses.length;
    pending.resolve(dependency === 'capture' ? frame(old) : undefined); await turn();
    assert.equal(f.statuses.length, count, `late ${dependency} result emitted after stop`);
    await f.tick(100000); assert.equal(f.statuses.length, count); assert.equal(f.captures, 1);
  }
});
