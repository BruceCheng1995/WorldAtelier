import {referenceToken} from '../../packages/contracts/authoring-references.mjs';
/** Language authoring for the existing session textarea. Persistence belongs to the host. */
const MODES = [
  { id: 'plan', title: '/plan', description: '先讨论设计与计划', label: '讨论设计' },
  { id: 'goal', title: '/goal', description: '围绕目标持续完成开发', label: '持续目标' },
];
const copy = value => value == null ? value : structuredClone(value);
const labelOf = item => String(item?.name ?? item?.title ?? item?.id ?? '未命名');

export function parseComposerToken(text, caret = text.length) {
  const prefix = String(text).slice(0, Math.max(0, caret));
  // Double prefixes take precedence; email addresses, URLs and paths are not mentions.
  const match = /(^|[^A-Za-z0-9_@/$])(@@|@|\$\$|\/)([^\s@/$，。；！？,;!?]*)$/u.exec(prefix);
  if (!match) return null;
  const trigger = match[2];
  return { trigger, query: match[3], start: prefix.length - trigger.length - match[3].length, end: prefix.length,
    kind: { '@': 'object', '@@': 'prefab', '$$': 'knowledge', '/': 'mode' }[trigger] };
}

export function unresolvedComposerReferences(text) {
  return [...String(text).matchAll(/(^|[^A-Za-z0-9_@/$])(@@|@|\$\$)([^\s@/$，。；！？,;!?]*)/gu)].map(match => {
    const start = match.index + match[1].length;
    return { trigger: match[2], kind: { '@': 'object', '@@': 'prefab', '$$': 'knowledge' }[match[2]], query: match[3], start, end: start + match[2].length + match[3].length };
  });
}

function matches(item, query) {
  const value = [labelOf(item), item?.description, item?.design?.description, ...(item?.tags ?? [])].filter(Boolean).join(' ').toLocaleLowerCase();
  return !query || value.includes(query.toLocaleLowerCase());
}

export function composerSuggestions(token, context = {}) {
  if (!token) return [];
  if (token.kind === 'mode') return MODES.filter(item => item.id.startsWith(token.query.toLowerCase())).map(item => ({ kind: 'mode', ...item }));
  if (token.kind === 'prefab') return (context.prefabs ?? []).filter(item => matches(item, token.query)).map(item => ({
    kind: 'prefab', id: item.id, title: labelOf(item), description: item.design?.description || item.description || '预制件定义',
    badge: item.design?.category === 'system' || item.category === 'system' ? '系统' : '预制件', item,
  }));
  if (token.kind !== 'object') return [];
  const selected = context.selectedObjects ?? [];
  const selectedIds = new Set(selected.map(item => item.id));
  const rows = (context.objects ?? []).filter(item => !selectedIds.has(item.id) && matches(item, token.query)).map(item => ({
    kind: 'object', id: item.id, title: labelOf(item), description: item.description || item.design?.description || '当前场景对象', item,
  }));
  if (selected.length > 1) rows.unshift({ kind: 'object-group', id: 'current-selection', title: `当前选中的 ${selected.length} 个对象`, description: selected.map(labelOf).join('、'), badge: '当前选中', items: selected });
  else if (selected.length === 1 && (!token.query || matches(selected[0], token.query) || '当前选中'.includes(token.query))) rows.unshift({
    kind: 'object', id: selected[0].id, title: labelOf(selected[0]), description: '将这个对象的版本与位置加入会话', badge: '当前选中', item: selected[0],
  });
  return rows;
}

export function composerKeyAction(event, { open = false, count = 0, composing = false } = {}) {
  if (composing || event.isComposing || event.keyCode === 229 || !open) return null;
  if (event.key === 'Escape') return 'close';
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (count && event.key === 'ArrowDown') return 'next';
  if (count && event.key === 'ArrowUp') return 'previous';
  if (count && (event.key === 'Enter' || event.key === 'Tab')) return 'choose';
  return null;
}

/**
 * getContext(): {key,sessionId,objects,selectedObjects,prefabs,references?,mode?,readOnly?}.
 * searchKnowledge(query, capturedContext, {signal}) returns the server response (items + revision).
 * onAddReference({kind,item,items?,revision?}, capturedContext) must fix stable references / attachments.
 * References rendered here use {id,kind,title|name,description?}; the host can instead use its attachment chips.
 * No callback is invoked by merely typing, highlighting or opening the list.
 */
export function createSemanticComposer({ textarea, mount = textarea?.parentElement, getContext = () => ({}), searchKnowledge,
  onAddReference, onRemoveReference, onOpenReference, onModeChange, onPendingChange, onError = () => {}, searchDelay = 160 } = {}) {
  if (!textarea || !mount) throw new TypeError('语言输入需要现有 textarea 和挂载容器');
  const document = textarea.ownerDocument;
  const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const chrome = make('div', 'semantic-composer');
  const stateRow = make('div', 'semantic-composer-state');
  const chips = make('div', 'semantic-reference-list'); chips.setAttribute('aria-label', '已引用的设计与知识');
  const menu = make('div', 'semantic-suggestions'); menu.hidden = true;
  const menuTitle = make('div', 'semantic-suggestions-heading');
  const list = make('div', 'semantic-suggestions-list'); list.setAttribute('role', 'listbox');
  const status = make('div', 'semantic-suggestions-status'); status.setAttribute('role', 'status');
  const hint = make('div', 'semantic-suggestions-hint', '↑ ↓ 选择 · Enter 引用 · Esc 关闭');
  const id = `semantic-suggestions-${++createSemanticComposer.sequence}`;
  list.id = id; menu.append(menuTitle, list, status, hint); chrome.append(stateRow, chips, menu);
  mount.insertBefore(chrome, textarea.parentElement === mount ? textarea : null);
  mount.classList.add('has-semantic-composer');
  const previousAria = Object.fromEntries(['aria-autocomplete', 'aria-controls', 'aria-expanded', 'aria-activedescendant'].map(key => [key, textarea.getAttribute(key)]));
  textarea.setAttribute('aria-autocomplete', 'list'); textarea.setAttribute('aria-controls', id); textarea.setAttribute('aria-expanded', 'false');
  let context = {}, contextKey, rows = [], active = 0, token = null, composing = false, destroyed = false;
  let timer = null, search = null, generation = 0, mode = 'normal', references = [], pending = 0, dismissed = null;
  const listeners = [];
  function listen(target, event, handler, options) { target.addEventListener(event, handler, options); listeners.push(() => target.removeEventListener(event, handler, options)); }
  function cancelSearch() { generation++; if (timer != null) clearTimeout(timer); timer = null; search?.abort(); search = null; }
  function hide() { cancelSearch(); menu.hidden = true; rows = []; token = null; textarea.setAttribute('aria-expanded', 'false'); textarea.removeAttribute('aria-activedescendant'); }
  function keyOf(value) { return value.key ?? [value.projectId, value.branchId, value.sessionId].join('/'); }
  function setContext(value = {}) {
    const nextKey = keyOf(value);
    if (nextKey !== contextKey) { hide(); dismissed = null; references = copy(value.references ?? []); mode = value.mode ?? 'normal'; }
    context = value; contextKey = nextKey;
    if (value.mode != null) mode = value.mode;
    if (value.references != null) references = copy(value.references);
    renderChrome();
  }
  function current() { const latest = getContext(); if (latest) setContext(latest); return context; }
  function notifyError(error) { if (error?.name !== 'AbortError' && !destroyed) onError(error); }
  function track(job) {
    pending++; onPendingChange?.(pending > 0);
    return Promise.resolve().then(job).catch(notifyError).finally(() => { pending--; if (!destroyed) onPendingChange?.(pending > 0); });
  }
  function renderChrome() {
    stateRow.replaceChildren(); chips.replaceChildren();
    const chosen = MODES.find(item => item.id === mode);
    if (chosen) {
      const pill = make('span', 'semantic-mode-pill', chosen.label); pill.dataset.mode = mode;
      const clear = make('button', 'semantic-chip-remove', '×'); clear.type = 'button'; clear.disabled = Boolean(context.readOnly);
      clear.setAttribute('aria-label', `退出${chosen.label}模式`); clear.onclick = () => changeMode('normal');
      pill.append(clear); stateRow.append(pill, make('small', '', chosen.description));
    }
    stateRow.hidden = !chosen;
    for (const reference of references) {
      const chip = make('span', 'semantic-reference-chip'); chip.dataset.referenceId = reference.id;
      const open = make('button', '', labelOf(reference)); open.type = 'button'; open.title = reference.description || labelOf(reference);
      open.onclick = () => onOpenReference?.(copy(reference), copy(current()));
      const remove = make('button', 'semantic-chip-remove', '×'); remove.type = 'button'; remove.disabled = Boolean(context.readOnly);
      remove.setAttribute('aria-label', `移除引用：${labelOf(reference)}`);
      remove.onclick = () => { const captured = copy(current()); track(() => onRemoveReference?.(copy(reference), captured)); };
      chip.append(open, remove); chips.append(chip);
    }
    chips.hidden = !references.length;
  }
  function changeMode(value) {
    current(); if (context.readOnly) return;
    mode = value; context = { ...context, mode: value }; renderChrome(); onModeChange?.(value, copy(context));
  }
  function renderMenu(message = '') {
    list.replaceChildren();
    menuTitle.textContent = { object: '当前场景对象', prefab: '全部预制件与系统', knowledge: '共享知识', mode: '会话模式' }[token?.kind] ?? '';
    rows.forEach((row, index) => {
      const option = make('button', 'semantic-suggestion'); option.type = 'button'; option.id = `${id}-${index}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === active)); option.tabIndex = -1;
      const text = make('span', 'semantic-suggestion-copy'); text.append(make('strong', '', row.title), make('small', '', row.description)); option.append(text);
      if (row.badge) option.append(make('span', 'semantic-suggestion-badge', row.badge));
      option.onpointerdown = event => event.preventDefault(); option.onclick = () => choose(index);
      list.append(option);
    });
    status.textContent = message || (rows.length ? '' : '没有找到匹配内容'); status.hidden = !status.textContent;
    hint.hidden = !rows.length; menu.hidden = false; textarea.setAttribute('aria-expanded', 'true');
    if (rows.length) textarea.setAttribute('aria-activedescendant', `${id}-${active}`); else textarea.removeAttribute('aria-activedescendant');
  }
  function update() {
    current(); cancelSearch();
    if (destroyed || composing || textarea.disabled || context.readOnly || textarea.selectionStart !== textarea.selectionEnd) { hide(); return; }
    const nextToken = parseComposerToken(textarea.value, textarea.selectionStart);
    if (!nextToken || dismissed === `${textarea.value}\u0000${textarea.selectionStart}`) { hide(); return; }
    token = nextToken; active = 0;
    if (token.kind !== 'knowledge') { rows = composerSuggestions(token, context); renderMenu(); return; }
    rows = [];
    if (!token.query.trim()) { renderMenu('输入关键词，查找相关设计与规则'); return; }
    if (!searchKnowledge) { renderMenu('共享知识暂不可查询'); return; }
    renderMenu('正在检索相关知识…');
    const captured = copy(context), capturedKey = contextKey, requestToken = copy(token), run = generation;
    timer = setTimeout(async () => {
      timer = null; search = new AbortController();
      try {
        const result = await searchKnowledge(requestToken.query, captured, { signal: search.signal });
        if (destroyed || generation !== run || keyOf(getContext() ?? context) !== capturedKey) return;
        const items = Array.isArray(result) ? result : result?.items ?? [];
        rows = items.map(item => ({ kind: 'knowledge', id: item.id, title: labelOf(item), description: item.description || item.content?.slice(0, 150) || '', badge: item.kind === 'resource' ? '设计' : '知识', item, revision: result?.revision ?? captured.revision }));
        active = 0; renderMenu();
      } catch (error) { if (!destroyed && generation === run && keyOf(getContext() ?? context) === capturedKey && error?.name !== 'AbortError') { rows = []; renderMenu('知识检索失败，请重新输入以重试'); notifyError(error); } }
    }, searchDelay);
  }
  function choose(index) {
    if (!rows[index] || !token) return;
    const beforeContext = contextKey; current();
    if (beforeContext !== contextKey || context.readOnly || !token) return;
    const row = copy(rows[index]), selectedToken = copy(token), captured = copy(context), original = textarea.value;
    hide(); dismissed = null;
    if (row.kind === 'mode') { removeToken(); changeMode(row.id); return; }
    if (!onAddReference) { notifyError(new Error('引用入口尚未连接')); return; }
    track(async () => {
      const added=await onAddReference({ kind: row.kind, item: row.item, items: row.items, revision: row.revision }, captured);
      if (!destroyed && keyOf(getContext() ?? context) === beforeContext) removeToken(Array.isArray(added)?added.map(referenceToken).join(' ')+' ':'');
    });
    function removeToken(replacement='') {
      if (textarea.value !== original) return; // Never erase text typed during an attachment request.
      const preserveFocus = document.activeElement === textarea;
      const adjust = position => position <= selectedToken.start ? position : Math.max(selectedToken.start, position - (selectedToken.end - selectedToken.start) + replacement.length);
      const selectionStart = adjust(textarea.selectionStart), selectionEnd = adjust(textarea.selectionEnd);
      textarea.value = original.slice(0, selectedToken.start) + replacement + original.slice(selectedToken.end);
      textarea.setSelectionRange(selectionStart, selectionEnd);
      textarea.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
      if (preserveFocus) textarea.focus();
    }
  }
  listen(textarea, 'input', () => { dismissed = null; update(); });
  listen(textarea, 'click', update);
  listen(textarea, 'keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update(); });
  listen(textarea, 'compositionstart', () => { composing = true; hide(); });
  listen(textarea, 'compositionend', () => { composing = false; update(); });
  listen(textarea, 'keydown', event => {
    const action = composerKeyAction(event, { open: !menu.hidden, count: rows.length, composing });
    if (!action) return; event.preventDefault(); event.stopImmediatePropagation();
    if (action === 'close') { dismissed = `${textarea.value}\u0000${textarea.selectionStart}`; hide(); }
    else if (action === 'choose') choose(active);
    else { active = (active + (action === 'next' ? 1 : rows.length - 1)) % rows.length; renderMenu(); list.children[active]?.scrollIntoView?.({ block: 'nearest' }); }
  }, { capture: true });
  listen(document, 'pointerdown', event => { if (event.target !== textarea && !chrome.contains(event.target)) hide(); });
  listen(document, 'focusin', event => { if (event.target !== textarea && !menu.contains(event.target)) hide(); });
  const view = document.defaultView;
  if (view) listen(view, 'blur', () => { view.setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME') hide(); }, 0); });
  setContext(getContext() ?? {});
  return {
    refresh() { current(); if (!menu.hidden) update(); }, setContext,
    setMode(value) { mode = value ?? 'normal'; renderChrome(); },
    setReferences(value) { references = copy(value ?? []); renderChrome(); },
    clear() { hide(); references = []; mode = 'normal'; dismissed = null; renderChrome(); },
    destroy() { destroyed = true; hide(); listeners.forEach(remove => remove()); chrome.remove(); mount.classList.remove('has-semantic-composer'); for (const [key, value] of Object.entries(previousAria)) { if (value == null) textarea.removeAttribute(key); else textarea.setAttribute(key, value); } },
  };
}
createSemanticComposer.sequence = 0;
