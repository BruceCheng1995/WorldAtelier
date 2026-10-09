// FAKE DOM regression of the actual workspace function bodies. No browser,
// user data, service, Godot or Agent is accessed; browser focus remains a UI check.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../apps/creation-workspace/workspace.js', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('function renderSessions(){'), source.indexOf('async function selectSession(id){'));
assert.ok(renderSource.startsWith('function renderSessions(){'));
const controlsSource = source.slice(source.indexOf('function updateNewSessionControls(){'), source.indexOf('function closeSessionPicker('));
assert.ok(controlsSource.startsWith('function updateNewSessionControls(){'));

class FakeNode {
  constructor(tag, id = '', dataset = {}) {
    Object.assign(this, {tagName: tag.toUpperCase(), id, dataset, children: [], value: '', disabled: false, onclick: null, attributes: new Map()});
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector === '[data-session]') return Object.hasOwn(this.dataset, 'session');
    if (selector === 'button[data-session]') return this.tagName === 'BUTTON' && Object.hasOwn(this.dataset, 'session');
    if (selector === 'input,textarea,select,[contenteditable=true]') return ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName);
    throw new Error('Unsupported explicit FAKE DOM selector: ' + selector);
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(n => [n, ...n.descendants()]);
    return descendants.filter(n => n.matches(selector));
  }
  descendants() { return this.children.flatMap(n => [n, ...n.descendants()]); }
  set innerHTML(html) {
    this.html = html;
    if (this.id === 'sessionList') {
      this.children = [...html.matchAll(/<button\b[^>]*data-session="([^"]+)"[^>]*>/g)].map(m => new FakeNode('button', '', {session: m[1]}));
    }
  }
  get innerHTML() { return this.html || ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  click() { if (!this.disabled) return this.onclick?.({target: this, currentTarget: this}); }
}

function fixture({filter = 'mine', sessions} = {}) {
  const body = new FakeNode('body'), list = new FakeNode('div', 'sessionList');
  const draft = new FakeNode('textarea', 'sessionDraft', {session: 'own-a'});
  draft.value = '正在输入中文草稿\nkeep this text';
  const outside = new FakeNode('button', 'unrelated', {session: 'own-a'});
  let outsideClicks = 0;
  outside.onclick = () => { outsideClicks++; };
  const search = new FakeNode('input', 'sessionSearch');
  const newSessionButtons = ['topbarQuickSession', 'quickNewSession', 'topbarNewSession', 'newSession'].map(id => new FakeNode('button', id));
  body.children = [list, draft, outside, search, new FakeNode('select', 'sessionUser'), ...newSessionButtons];
  const $ = selector => body.querySelectorAll(selector)[0];
  const calls = [], errors = [], acknowledged = [];
  const state = {
    $, $$: selector => body.querySelectorAll(selector), branch: {branch_id: 'main'},
    project: {members: [{id: 'collaborator', name: 'Collaborator'}]}, sessionFilter: filter,
    selectedSessionId: 'own-a', draftCache: new Map(),
    sessions: sessions ?? [
      {id: 'own-a', title: '初始化', owner_user_id: 'owner', visibility: 'private', draft: ''},
      {id: 'own-b', title: '第二会话', owner_user_id: 'owner', visibility: 'private', draft: ''},
      {id: 'shared-c', title: '已共享', owner_user_id: 'collaborator', visibility: 'shared', draft: ''},
    ],
    ownSession: session => session?.owner_user_id === 'owner', canWrite: () => true,
    // Isolated presentation and navigation dependencies; the two DOM binding
    // functions under regression are still read verbatim from workspace.js.
    robotAvatar: () => '<span class="fake-robot-avatar" aria-hidden="true"></span>',
    paintAgentAvatars: () => {},
    sessionStartKey: () => 'owner/project/main',
    sessionStartGate: {pending: new Set(), acknowledge: key => acknowledged.push(key)},
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
    selectSession: async id => { calls.push(id); }, report: error => errors.push(error),
  };
  vm.createContext(state);
  vm.runInContext(controlsSource + '\n' + renderSource, state);
  return {list, draft, outside, search, newSessionButtons, state, calls, errors, acknowledged, render: () => vm.runInContext('renderSessions()', state), outsideClicks: () => outsideClicks};
}

test('FAKE actual renderSessions: clicking the populated draft after repeated list redraws never selects a session', async () => {
  const f = fixture(), original = f.draft, text = f.draft.value;
  for (let n = 0; n < 5; n++) {
    f.state.draftCache.set('own-a', `saved ${n}`);
    f.render();
    await f.draft.click();
    assert.equal(f.draft, original);
    assert.equal(f.draft.onclick, null, 'data-session on the draft is content identity, not a navigation trigger');
    assert.equal(f.draft.dataset.session, 'own-a');
    assert.equal(f.draft.value, text);
    assert.equal(f.draft.disabled, false);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.acknowledged, [], 'draft clicks do not acknowledge navigation or a session creation intent');
});

test('FAKE actual renderSessions: genuine list buttons still select their own IDs after each redraw', async () => {
  const f = fixture();
  f.render();
  assert.deepEqual(f.list.children.map(n => n.dataset.session), ['own-a', 'own-b']);
  await f.list.children[1].click();
  f.state.selectedSessionId = 'own-b';
  f.render();
  await f.list.children[0].click();
  assert.deepEqual(f.calls, ['own-b', 'own-a']);
  assert.deepEqual(f.acknowledged, ['owner/project/main', 'owner/project/main']);
  assert.deepEqual(f.errors, []);
});

test('FAKE actual renderSessions: unrelated buttons carrying session metadata retain their own handler', async () => {
  const f = fixture(), handler = f.outside.onclick;
  f.render(); f.render();
  assert.equal(f.outside.onclick, handler, 'tag restriction alone is insufficient; binding must also stay inside the session list');
  await f.outside.click();
  assert.equal(f.outsideClicks(), 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.acknowledged, []);
});

test('FAKE actual renderSessions: shared filter and empty list cannot turn the draft into a session row', async () => {
  const f = fixture({filter: 'shared'});
  f.render();
  assert.deepEqual(f.list.children.map(n => n.dataset.session), ['shared-c']);
  await f.list.children[0].click();
  f.state.sessions = [];
  f.render();
  assert.equal(f.list.children.length, 0);
  await f.draft.click();
  assert.deepEqual(f.calls, ['shared-c']);
});

test('FAKE actual renderSessions: search and new-session controls remain independent of the populated draft', async () => {
  const f = fixture(), text = f.draft.value;
  f.search.value = ' 第二 ';
  f.state.sessionStartGate.pending.add('owner/project/main');
  f.render();
  assert.deepEqual(f.list.children.map(node => node.dataset.session), ['own-b']);
  for (const button of f.newSessionButtons) {
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
  }
  f.state.sessionStartGate.pending.clear();
  f.search.value = '没有这条会话';
  f.render();
  assert.equal(f.list.children.length, 0);
  for (const button of f.newSessionButtons) {
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-busy'), 'false');
  }
  await f.draft.click();
  assert.equal(f.draft.value, text);
  assert.equal(f.draft.onclick, null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.acknowledged, []);
});

test('FAKE actual document keydown: textarea text, shortcuts and IME do not dispatch world editing actions', () => {
  const marker = "document.addEventListener('keydown',e=>{\n";
  const body = source.split(marker)[1]?.split("\n});\ndocument.addEventListener('click'")[0];
  assert.ok(body);
  const draft = new FakeNode('textarea', 'sessionDraft'), calls = [];
  const context = {
    $: selector => selector === '#chatDrawer' ? {hidden: false} : selector === '#workbench' ? {contains: () => true} : {},
    document: {querySelector: () => null}, closeChat: () => calls.push('close'),
    applyHistory: () => { calls.push('history'); return Promise.resolve(); },
    report: error => { throw error; },
  };
  vm.createContext(context);
  vm.runInContext(`handle = e => {${body}\n}`, context);
  for (const extra of [{key: 'w'}, {key: 'Enter'}, {key: 'Enter', shiftKey: true}, {key: 'z', metaKey: true}, {key: 'ArrowLeft'}, {key: 'Escape', isComposing: true}]) {
    const event = {target: draft, composedPath: () => [draft], defaultPrevented: false, isComposing: false, preventDefault() { this.defaultPrevented = true; }, ...extra};
    context.handle(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(calls, []);
});
