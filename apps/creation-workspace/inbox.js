import { randomUUID, bindDialogDismiss } from './client-platform.js';
const clone = value => value == null ? value : structuredClone(value);
const scopeKey = value => value?.user_id ? JSON.stringify([value.user_id, value.project_id ?? null, value.branch_id ?? null, value.generation ?? null]) : null;
const statusLabels = {open:'待处理', resolved:'已解决', obsolete:'历史消息'};
const sourceLabels = {agent:'Agent', godot_client:'Godot 视口', godot_authority:'Godot 世界', backend:'服务器', collaboration:'协作权限'};
const kindLabels = {error:'异常', decision:'需要决定', validation:'检查记录', notice:'通知'};
const navigationActions = new Set(['session', 'locate', 'build', 'collaboration']);
const unavailable = error => [401, 403, 404].includes(Number(error?.status));
const errorMessage = error => error?.message || '消息暂时无法读取，请刷新重试。';
const countText = value => value > 99 ? '99+' : String(value);
const timeText = value => {
  const date = new Date(value);
  return value != null && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '';
};
const validItem = item => item && typeof item.id === 'string' && ['open', 'resolved', 'obsolete'].includes(item.status);
const actionKey = (item, action) => JSON.stringify([item.id, item.version, action.id]);
const identity = item => JSON.stringify([item.id, item.version, item.project_id, item.branch_id, item.session_id, item.run_id, item.job_id, item.runtime_build_id, item.world_id, item.epoch, item.request_key, item.revision, item.resource_id, item.targets]);
const addressKey = address => address ? JSON.stringify([address.project_id ?? null, address.branch_id ?? null, address.resource_id ?? null, address.instance_path ?? [], address.definition_node_id ?? null]) : null;

export const inboxActionable = item => item?.status === 'open' && item.kind !== 'notice';
export const inboxUnread = item => item?.read_at == null;

/** Input must be the server's authorized public projection, never private session data. */
export function issueMatchesTarget(item, target) {
  if (!target) return true;
  const entries = item.targets?.length ? item.targets : item.resource_id ? [{resource_id:item.resource_id}] : [];
  return entries.some(entry => {
    const candidate = {...entry, project_id:entry.project_id ?? entry.address?.project_id ?? item.project_id,
      branch_id:entry.branch_id ?? entry.address?.branch_id ?? item.branch_id,
      resource_id:entry.resource_id ?? entry.address?.resource_id ?? item.resource_id};
    for (const field of ['project_id', 'branch_id', 'resource_id', 'asset_id']) {
      if (target[field] != null && candidate[field] !== target[field]) return false;
    }
    if (target.address) {
      if (!candidate.address) return false;
      const wanted = {...target.address, project_id:target.address.project_id ?? target.project_id,
        branch_id:target.address.branch_id ?? target.branch_id, resource_id:target.address.resource_id ?? target.resource_id};
      const actual = {...candidate.address, project_id:candidate.address.project_id ?? candidate.project_id,
        branch_id:candidate.address.branch_id ?? candidate.branch_id, resource_id:candidate.address.resource_id ?? candidate.resource_id};
      if (addressKey(wanted) !== addressKey(actual)) return false;
    } else if (target.object_id != null) {
      if (candidate.object_id !== target.object_id && !(candidate.address && !candidate.address.instance_path?.length && candidate.address.definition_node_id === target.object_id)) return false;
    }
    return true;
  });
}

export function issueSummary(items, target) {
  const matches = (items ?? []).filter(item => inboxActionable(item) && issueMatchesTarget(item, target));
  const severity = matches.some(item => item.severity === 'error' || item.severity === 'critical') ? 'error' : matches.length ? 'warning' : null;
  return {count:matches.length, unread:matches.filter(inboxUnread).length, severity,
    label:matches.length ? `${matches.length} 项待处理问题` : '没有待处理问题', ids:matches.map(item => item.id), items:matches};
}

/**
 * Server-backed Inbox for the existing workbench. The host owns authentication,
 * navigation, real pending request forms, and every non-read mutation.
 * No action is inferred from message prose; actions come from the server.
 */
export class InboxWorkspace {
  constructor({trigger, container, load, getItem, markRead, onAction, onChanged, onOpen, onClose, refreshMs = 15000}) {
    if (!trigger || !load || !getItem || !markRead) throw new Error('消息中心缺少宿主接口');
    Object.assign(this, {trigger, load, getItem, markRead, onAction, onChanged, onOpen, onClose, refreshMs});
    this.document = trigger.ownerDocument;
    this.context = null; this.key = null; this.generation = 0; this.listGeneration = 0; this.detailGeneration = 0;
    this.items = []; this.counts = {unread:0, actionable:0}; this.filter = 'actionable'; this.target = null;
    this.nextCursor = null; this.selectedId = null; this.detail = null; this.error = ''; this.detailError = '';
    this.pending = null; this.readJobs = new Map(); this.controllers = new Set(); this.busy = new Set();
    this.denied = false; this.disposed = false; this.opened = false; this.focusTarget = null; this.timer = null; this.connected = true;
    this.originalTrigger = {html:trigger.innerHTML, label:trigger.getAttribute('aria-label'), controls:trigger.getAttribute('aria-controls'), expanded:trigger.getAttribute('aria-expanded'), popup:trigger.getAttribute('aria-haspopup'), hidden:trigger.hidden, disabled:trigger.disabled, title:trigger.title};
    this.id = `wa-inbox-${randomUUID()}`;
    this.dialog = this.el('dialog', null, container ?? this.document.body, 'wa-inbox');
    this.dialog.id = this.id; this.dialog.setAttribute('aria-labelledby', `${this.id}-title`);
    this.trigger.classList.add('wa-inbox-trigger');
    this.trigger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v15H4zM4 13h5l1.5 3h3L15 13h5"/></svg><span class="wa-inbox-trigger-label">消息</span>';
    this.badge = this.el('span', '', trigger, 'wa-inbox-unread'); this.badge.setAttribute('aria-hidden', 'true');
    this.trigger.setAttribute('aria-haspopup', 'dialog'); this.trigger.setAttribute('aria-controls', this.id);
    this.triggerClick = () => this.opened ? this.close() : this.open();
    this.trigger.addEventListener('click', this.triggerClick);
    bindDialogDismiss(this.dialog, () => this.close());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('close', () => { if (this.opened) this.close(); });
    this.build();
    this.visibilityListener = () => { if (this.document.visibilityState === 'visible' && this.key) this.refresh(); };
    this.document.addEventListener('visibilitychange', this.visibilityListener);
    this.renderTrigger();
  }

  el(tag, text, parent, className) {
    const node = this.document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (className) node.className = className;
    parent?.append(node); return node;
  }
  button(label, action, parent, className = 'wa-inbox-button') {
    const button = this.el('button', label, parent, className); button.type = 'button'; button.onclick = action; return button;
  }
  build() {
    const header = this.el('header', null, this.dialog, 'wa-inbox-header'), heading = this.el('div', null, header);
    this.el('p', '工作台消息', heading, 'wa-inbox-eyebrow'); this.el('h2', '消息中心', heading).id = `${this.id}-title`;
    this.closeButton = this.button('×', () => this.close(), header, 'wa-inbox-close'); this.closeButton.setAttribute('aria-label', '关闭消息中心');
    const toolbar = this.el('div', null, this.dialog, 'wa-inbox-toolbar');
    this.filters = this.el('div', null, toolbar, 'wa-inbox-filters'); this.filters.setAttribute('role', 'group'); this.filters.setAttribute('aria-label', '筛选消息');
    this.filterButtons = new Map();
    for (const [key, label] of [['actionable','待处理'], ['unread','未读'], ['all','全部']]) {
      const button = this.button(label, () => this.setFilter(key), this.filters); button.dataset.filter = key;
      this.filterButtons.set(key, button);
    }
    this.refreshButton = this.button('刷新', () => this.refresh(), toolbar); this.refreshButton.setAttribute('aria-label', '刷新消息中心');
    this.scopeLine = this.el('div', null, this.dialog, 'wa-inbox-scope');
    this.scopeText = this.el('span', '', this.scopeLine);
    this.clearTargetButton = this.button('查看全部内容', () => { this.target = null; this.abort(); this.items = []; this.nextCursor = null; this.render(); this.refresh(); }, this.scopeLine, 'wa-inbox-link');
    this.status = this.el('p', '', this.dialog, 'wa-inbox-status'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.main = this.el('div', null, this.dialog, 'wa-inbox-main');
    this.listPane = this.el('section', null, this.main, 'wa-inbox-list-pane'); this.listPane.setAttribute('aria-label', '消息列表');
    this.list = this.el('div', null, this.listPane, 'wa-inbox-list');
    this.list.addEventListener('keydown', event => {
      const rows = [...this.list.querySelectorAll('[data-inbox-item]')], index = rows.indexOf(this.document.activeElement);
      if (index < 0 || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      rows[next]?.focus();
    });
    this.moreButton = this.button('加载更多', () => this.refresh({more:true}), this.listPane, 'wa-inbox-more');
    this.detailPane = this.el('section', null, this.main, 'wa-inbox-detail'); this.detailPane.setAttribute('aria-label', '消息详情');
    this.detailPane.tabIndex = -1;
    this.el('footer', '已读只表示你看过；问题状态会随实际处理结果更新。', this.dialog, 'wa-inbox-footer');
  }

  current(generation) { return !this.disposed && this.key && this.generation === generation; }
  controller() { const controller = new AbortController(); this.controllers.add(controller); return controller; }
  abort() { for (const controller of this.controllers) controller.abort(); this.controllers.clear(); this.pending = null; this.detailGeneration++; this.listGeneration++; }
  setContext(context) { if (scopeKey(context) === this.key) { this.context = clone(context); return; } this.reset(context); }
  setConnection(connected) {
    const next = !!connected, changed = next !== this.connected; this.connected = next;
    if (!next) { this.abort(); clearTimeout(this.timer); this.detailError = ''; this.render(); this.notify(); }
    else if (changed && this.key) { this.error = '连接已恢复，正在刷新消息…'; this.render(); this.refresh(); }
  }
  reset(context = null) {
    if (this.disposed) return;
    this.generation++; this.abort(); clearTimeout(this.timer); this.close(false);
    this.context = clone(context); this.key = scopeKey(context); this.items = []; this.counts = {unread:0, actionable:0};
    this.target = null; this.selectedId = null; this.detail = null; this.nextCursor = null; this.error = ''; this.detailError = '';
    this.denied = false; this.readJobs.clear(); this.busy.clear(); this.render(); this.notify();
    if (this.key) this.refresh();
  }
  invalidate({clear = false} = {}) {
    if (this.disposed) return;
    this.generation++; this.abort(); this.busy.clear(); this.readJobs.clear();
    if (clear) { this.items = []; this.detail = null; this.selectedId = null; this.counts = {unread:0, actionable:0}; this.render(); this.notify(); }
    this.refresh();
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.key || this.disposed || this.denied || !this.connected || !this.refreshMs) return;
    this.timer = setTimeout(() => this.refresh(), this.refreshMs);
  }
  notify() { this.onChanged?.({context:clone(this.context), items:clone(this.items), counts:clone(this.counts), unavailable:this.denied || !this.connected || !!this.error}); }
  allowed(item) {
    if (!validItem(item)) return false;
    return !['project_id', 'branch_id'].some(field => this.context?.[field] && item[field] !== this.context[field]);
  }
  async refresh({more = false} = {}) {
    if (!this.key || this.disposed || !this.connected) return;
    if (this.pending) return this.pending;
    if (more && !this.nextCursor) return;
    const generation = this.generation, serial = ++this.listGeneration, context = clone(this.context), controller = this.controller();
    const cursor = more ? this.nextCursor : null;
    const task = (async () => {
      try {
        const result = await this.load({context, filter:this.filter, cursor, target:clone(this.target), signal:controller.signal});
        if (!this.current(generation) || serial !== this.listGeneration) return;
        const incoming = (result.items ?? []).filter(item => this.allowed(item));
        this.items = [...new Map([...(more ? this.items : []), ...incoming].map(item => [item.id, item])).values()];
        this.counts = {unread:Math.max(0, Number(result.counts?.unread) || 0), actionable:Math.max(0, Number(result.counts?.actionable) || 0)};
        this.nextCursor = result.next_cursor ?? null; this.error = ''; this.denied = false;
        if (this.opened && this.selectedId) {
          const selected = incoming.find(item => item.id === this.selectedId);
          if (selected && this.detail && identity(selected) !== identity(this.detail)) this.detail = null;
          await this.select(this.selectedId, {focus:false, read:false});
        }
      } catch (error) {
        if (!this.current(generation) || controller.signal.aborted || serial !== this.listGeneration) return;
        this.error = errorMessage(error);
        if (unavailable(error)) { this.denied = true; this.items = []; this.detail = null; this.selectedId = null; this.counts = {unread:0, actionable:0}; this.nextCursor = null; }
      } finally {
        this.controllers.delete(controller);
        if (this.current(generation) && serial === this.listGeneration) {
          this.pending = null; this.render(); this.notify();
          if (this.reloadAfterPending) { this.reloadAfterPending = false; queueMicrotask(() => this.refresh()); } else this.schedule();
        }
      }
    })();
    this.pending = task; this.renderTrigger(); if (this.opened) this.render(); return task;
  }
  setFilter(filter) {
    if (!['actionable','unread','all'].includes(filter)) return;
    if (filter === this.filter) return;
    this.filter = filter; this.abort(); this.nextCursor = null; this.items = []; this.render(); this.refresh();
  }
  open({target = null, itemId = null, trigger = null} = {}) {
    if (!this.key || this.disposed) return;
    this.focusTarget = trigger ?? this.document.activeElement ?? this.trigger;
    if (JSON.stringify(target) !== JSON.stringify(this.target)) { this.abort(); this.items = []; this.nextCursor = null; }
    this.target = clone(target); this.filter = target ? 'actionable' : this.filter==='actionable'&&!this.counts.actionable&&this.counts.unread?'unread':this.filter;
    this.opened = true; this.onOpen?.(); this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.closeButton.focus(); this.refresh();
    if (itemId) this.select(itemId);
  }
  close(restoreFocus = true) {
    if (!this.opened && !this.dialog.open) return;
    this.opened = false; this.detailGeneration++; this.detail = null; this.selectedId = null; this.detailError = '';
    if (this.dialog.open) this.dialog.close();
    this.renderTrigger(); this.onClose?.();
    if (restoreFocus && this.focusTarget?.isConnected && !this.focusTarget.disabled && !this.focusTarget.hidden) this.focusTarget.focus();
  }
  visibleItems() {
    return this.items.filter(item => issueMatchesTarget(item, this.target))
      .filter(item => this.filter === 'all' || (this.filter === 'unread' ? inboxUnread(item) : inboxActionable(item)))
      .sort((a,b) => Number(inboxActionable(b)) - Number(inboxActionable(a)) || Number(new Date(b.updated_at ?? b.created_at)) - Number(new Date(a.updated_at ?? a.created_at)));
  }
  async select(id, {focus = true, read = true} = {}) {
    if (!this.opened || !this.key || this.disposed || !this.connected) return;
    const generation = this.generation, serial = ++this.detailGeneration, context = clone(this.context), controller = this.controller();
    this.selectedId = id; this.detail = null; this.detailError = ''; this.render();
    try {
      const result = await this.getItem(id, {context, signal:controller.signal}), item = result?.item ?? result;
      if (!this.current(generation) || serial !== this.detailGeneration || !this.opened || this.selectedId !== id) return;
      if (!this.allowed(item) || item.id !== id) throw Object.assign(new Error('这条消息已不可访问，请刷新列表。'), {status:404});
      this.detail = clone(item); this.replaceItem(item); this.render();
      if (focus) this.detailPane.focus({preventScroll:true});
      if (read && inboxUnread(item)) await this.read(item, generation, serial);
    } catch (error) {
      if (!this.current(generation) || controller.signal.aborted || serial !== this.detailGeneration || !this.opened) return;
      this.detail = null; this.detailError = unavailable(error) ? '这条消息已不可访问。权限或内容可能已经变化。' : errorMessage(error);
      if (unavailable(error)) { this.items = this.items.filter(item => item.id !== id); this.notify(); }
      this.render();
    } finally { this.controllers.delete(controller); }
  }
  replaceItem(item) {
    const index = this.items.findIndex(row => row.id === item.id);
    if (index >= 0 && !(Number(this.items[index].version) > Number(item.version))) this.items[index] = clone(item);
  }
  refreshAfterRead() { if (this.pending) this.reloadAfterPending = true; else this.refresh(); }
  async read(item, generation, serial) {
    const key = JSON.stringify([this.key, item.id, item.version]);
    if (this.readJobs.has(key)) return this.readJobs.get(key);
    const context = clone(this.context), controller = this.controller(), request_id = randomUUID();
    const job = (async () => {
      try {
        const result = await this.markRead(item.id, {context, expected_version:item.version, request_id, signal:controller.signal});
        if (!this.current(generation)) return;
        const saved = result?.item ?? result;
        if (saved?.id === item.id && this.allowed(saved)) {
          this.replaceItem(saved);
          if (serial === this.detailGeneration && this.selectedId === item.id && this.opened && !(Number(this.detail?.version) > Number(saved.version))) this.detail = clone(saved);
          if (result?.counts) this.counts = clone(result.counts);
          else if (inboxUnread(item) && !inboxUnread(saved)) this.counts.unread = Math.max(0, this.counts.unread - 1);
          this.render(); this.notify(); this.refreshAfterRead();
        } else this.refreshAfterRead();
      } catch (error) {
        if (!this.current(generation) || controller.signal.aborted || serial !== this.detailGeneration || !this.opened) return;
        if (unavailable(error)) { this.items = this.items.filter(row => row.id !== item.id); this.detail = null; this.detailError = '这条消息已不可访问，请刷新列表。'; this.notify(); }
        else if (Number(error?.status) === 409) {
          this.detail = null; this.detailError = '消息已更新，正在核对当前记录…'; this.render();
          await this.select(item.id, {focus:false, read:false});
        } else this.detailError = '未能保存已读状态。消息仍保留未读，可稍后重试。';
        this.render();
      } finally { this.controllers.delete(controller); this.readJobs.delete(key); }
    })();
    this.readJobs.set(key, job); return job;
  }
  actionEnabled(item, action) {
    if (!this.onAction || this.denied || !this.connected || this.error || action.enabled === false) return false;
    if (item.status !== 'open' && !navigationActions.has(action.id)) return false;
    return true;
  }
  async act(item, action) {
    if (!this.actionEnabled(item, action) || this.busy.size || !this.opened) return;
    const generation = this.generation, serial = this.detailGeneration, context = clone(this.context), controller = this.controller(), busyKey = actionKey(item, action);
    this.busy.add(busyKey); this.detailError = ''; this.render();
    try {
      const result = await this.getItem(item.id, {context, signal:controller.signal}), fresh = result?.item ?? result;
      if (!this.current(generation) || serial !== this.detailGeneration || !this.opened || this.selectedId !== item.id) return;
      if (!this.allowed(fresh) || fresh.id !== item.id) throw Object.assign(new Error('这条消息已不可访问。'), {status:404});
      this.detail = clone(fresh); this.replaceItem(fresh);
      const currentAction = fresh.actions?.find(value => value.id === action.id);
      if (identity(fresh) !== identity(item) || !currentAction || !this.actionEnabled(fresh, currentAction)) {
        this.detailError = '消息或请求已经更新。请查看当前状态后再操作。'; this.render(); return;
      }
      // The host must recheck the real session / pending request before executing.
      await this.onAction({item:clone(fresh), action:clone(currentAction), context,
        isCurrent:() => !!this.current(generation) && serial === this.detailGeneration && this.opened && this.selectedId === item.id});
      if (this.current(generation)) this.refresh();
    } catch (error) {
      if (!this.current(generation) || controller.signal.aborted || serial !== this.detailGeneration || !this.opened) return;
      if (unavailable(error)) { this.detail = null; this.items = this.items.filter(row => row.id !== item.id); this.detailError = '这条消息已不可访问，未继续原操作。'; this.notify(); }
      else this.detailError = Number(error?.status) === 409 ? '请求已结束或内容已更新，未继续旧操作。请刷新查看。' : errorMessage(error);
      this.render();
    } finally { this.controllers.delete(controller); this.busy.delete(busyKey); if (this.current(generation)) this.render(); }
  }
  renderTrigger() {
    this.trigger.hidden = !this.key; this.trigger.disabled = !this.key;
    this.trigger.setAttribute('aria-expanded', String(this.opened));
    this.trigger.setAttribute('aria-label', !this.connected ? '消息中心：连接已断开，消息状态待刷新' : this.error ? '消息中心：状态暂不可用，点击查看' : `消息中心：${this.counts.unread} 条未读，${this.counts.actionable} 项待处理`);
    this.trigger.title = !this.connected ? '连接已断开，已有消息保留' : this.error ? '消息状态暂不可用' : `${this.counts.unread} 条未读 · ${this.counts.actionable} 项待处理`;
    this.trigger.classList.toggle('has-issues', this.counts.actionable > 0); this.trigger.classList.toggle('is-unavailable', !this.connected || !!this.error);
    this.badge.textContent = countText(this.counts.unread); this.badge.hidden = !this.counts.unread;
  }
  render() {
    this.renderTrigger(); if (!this.opened) return;
    const focused = this.list.contains(this.document.activeElement) ? this.document.activeElement.dataset.inboxItem : null, scroll = this.list.scrollTop;
    for (const [filter, button] of this.filterButtons) {
      button.setAttribute('aria-pressed', String(filter === this.filter));
      const label = {actionable:'待处理', unread:'未读', all:'全部'}[filter], count = filter === 'actionable' ? this.counts.actionable : filter === 'unread' ? this.counts.unread : null;
      button.textContent = `${label}${count == null ? '' : ` ${countText(count)}`}`;
    }
    this.scopeText.textContent = this.target ? `相关内容：${this.target.name ?? this.target.resource_name ?? this.target.object_id ?? this.target.resource_id ?? '当前对象'}` : this.context?.project_name ?? '你有权限查看的工作台消息';
    this.clearTargetButton.hidden = !this.target;
    this.refreshButton.disabled = !!this.pending || !this.connected; this.moreButton.disabled = !!this.pending || !this.connected;
    this.status.textContent = !this.connected ? '连接已断开。已有消息保留，恢复后会刷新状态。' : this.error || (this.pending ? '正在读取消息…' : ''); this.status.hidden = !this.status.textContent;
    this.status.classList.toggle('is-error', !this.connected || !!this.error);
    this.list.replaceChildren(); const rows = this.visibleItems();
    if (!rows.length) this.el('div', this.error ? '暂时无法读取消息。刷新后重试。' : this.pending ? '正在读取…' : this.target ? '此内容暂无可查看的消息。私人会话的问题详情仅负责人可见。' : this.filter === 'actionable' ? '当前没有需要处理的消息。' : this.filter === 'unread' ? '没有未读消息。' : '还没有工作台消息。', this.list, 'wa-inbox-empty');
    for (const item of rows) {
      const button = this.button('', () => this.select(item.id), this.list, 'wa-inbox-row'); button.dataset.inboxItem = item.id;
      button.classList.toggle('is-unread', inboxUnread(item)); button.classList.toggle('is-selected', item.id === this.selectedId);
      button.setAttribute('aria-current', String(item.id === this.selectedId));
      const top = this.el('span', null, button, 'wa-inbox-row-top');
      const symbol = this.el('span', item.kind === 'decision' ? '?' : item.status === 'resolved' ? '✓' : item.severity === 'error' || item.severity === 'critical' ? '!' : '·', top, 'wa-inbox-symbol');
      symbol.classList.toggle('is-error', item.severity === 'error' || item.severity === 'critical'); symbol.setAttribute('aria-hidden', 'true');
      this.el('strong', item.title || kindLabels[item.kind] || '工作台消息', top);
      if (inboxUnread(item)) this.el('span', '未读', top, 'wa-inbox-unread-text');
      this.el('span', item.message || '', button, 'wa-inbox-row-message');
      const meta = this.el('span', null, button, 'wa-inbox-row-meta');
      this.el('span', `${sourceLabels[item.source] ?? '工作台'} · ${item.kind === 'notice' && item.status === 'open' ? '通知' : statusLabels[item.status]}`, meta);
      this.el('time', timeText(item.updated_at ?? item.created_at), meta);
      if (item.project_name || item.branch_id) this.el('span', [item.project_name, item.branch_id].filter(Boolean).join(' / '), button, 'wa-inbox-row-scope');
    }
    this.list.scrollTop = scroll;
    if (focused) [...this.list.querySelectorAll('[data-inbox-item]')].find(button => button.dataset.inboxItem === focused)?.focus({preventScroll:true});
    this.moreButton.hidden = !this.nextCursor;
    this.dialog.classList.toggle('has-detail', !!this.selectedId);
    this.renderDetail();
  }
  renderDetail() {
    const active = this.detailPane.contains(this.document.activeElement) ? this.document.activeElement.dataset.inboxAction : null, scroll = this.detailPane.scrollTop, recordOpen = this.detailPane.querySelector('.wa-inbox-record')?.open;
    this.detailPane.replaceChildren();
    if (!this.selectedId) { this.el('div', '选择一条消息，查看原因、相关内容和可用操作。', this.detailPane, 'wa-inbox-detail-empty'); return; }
    this.button('← 返回列表', () => { this.detailGeneration++; this.selectedId = null; this.detail = null; this.detailError = ''; this.render(); this.list.querySelector('button')?.focus(); }, this.detailPane, 'wa-inbox-back');
    if (this.detailError) this.el('p', this.detailError, this.detailPane, 'wa-inbox-error').setAttribute('role', 'alert');
    const item = this.detail;
    if (!item) { if (!this.detailError) this.el('p', '正在读取当前消息…', this.detailPane, 'wa-inbox-empty'); else this.button('重新读取', () => this.select(this.selectedId), this.detailPane); return; }
    this.el('p', `${sourceLabels[item.source] ?? '工作台'} · ${kindLabels[item.kind] ?? '消息'}`, this.detailPane, 'wa-inbox-eyebrow');
    this.el('h3', item.title || '工作台消息', this.detailPane);
    const state = this.el('span', item.kind === 'notice' && item.status === 'open' ? '通知' : statusLabels[item.status], this.detailPane, 'wa-inbox-detail-state');
    state.classList.toggle('is-open', inboxActionable(item));
    this.el('p', item.message || '没有补充说明。', this.detailPane, 'wa-inbox-message');
    if (item.status === 'obsolete') this.el('p', '这条消息关联的运行、请求或版本已经变化，旧操作已停用。', this.detailPane, 'wa-inbox-history');
    if (item.status === 'resolved') this.el('p', '此项已由实际处理结果确认解决，记录保留供查看。', this.detailPane, 'wa-inbox-history');
    if (item.kind === 'decision' && item.status === 'open') this.el('p', item.source === 'collaboration' ? '打开此游戏的编辑申请，查看申请说明后批准或拒绝。已读不会授予权限。' : '从下方入口打开当前会话的真实请求，查看后答复。', this.detailPane, 'wa-inbox-history');
    const info = this.el('dl', null, this.detailPane, 'wa-inbox-facts');
    for (const [label, value] of [['时间', timeText(item.created_at)], ['游戏', item.project_name], ['分支', item.branch_id], ['相关内容', item.resource_name], ['会话', item.session_title]]) if (value) { this.el('dt', label, info); this.el('dd', value, info); }
    const actions = this.el('div', null, this.detailPane, 'wa-inbox-actions');
    for (const action of item.actions ?? []) {
      if (!action?.id || !action.label) continue;
      const enabled = this.actionEnabled(item, action), wrap = this.el('div', null, actions);
      const button = this.button(this.busy.has(actionKey(item, action)) ? '正在核对…' : action.label, () => this.act(item, action), wrap);
      button.dataset.inboxAction = action.id; button.disabled = !enabled || this.busy.size > 0;
      if (action.reason && !enabled) this.el('small', action.reason, wrap);
    }
    if (!(item.actions ?? []).length && item.status === 'open') this.el('p', item.kind === 'notice' ? '这条通知无需操作。' : '暂无可用操作。相关任务有新结果时，状态会自动更新。', this.detailPane, 'wa-inbox-history');
    const refs = [['消息', item.id], ['资源', item.resource_id], ['运行', item.run_id], ['源版本', item.revision]].filter(([,value]) => value);
    if (refs.length) {
      const details = this.el('details', null, this.detailPane, 'wa-inbox-record'); details.open = !!recordOpen; this.el('summary', '记录信息', details);
      for (const [label, value] of refs) { const line = this.el('p', null, details); this.el('span', `${label}：`, line); this.el('code', value, line); }
    }
    this.detailPane.scrollTop = scroll;
    if (active) [...this.detailPane.querySelectorAll('[data-inbox-action]')].find(button => button.dataset.inboxAction === active && !button.disabled)?.focus({preventScroll:true});
  }
  destroy() {
    if (this.disposed) return;
    this.close(false); this.disposed = true; this.generation++; this.abort(); clearTimeout(this.timer);
    this.document.removeEventListener('visibilitychange', this.visibilityListener); this.trigger.removeEventListener('click', this.triggerClick);
    this.dialog.remove(); this.trigger.classList.remove('wa-inbox-trigger', 'has-issues', 'is-unavailable'); this.trigger.innerHTML = this.originalTrigger.html;
    for (const [attribute, value] of [['aria-label',this.originalTrigger.label], ['aria-controls',this.originalTrigger.controls], ['aria-expanded',this.originalTrigger.expanded], ['aria-haspopup',this.originalTrigger.popup]]) value == null ? this.trigger.removeAttribute(attribute) : this.trigger.setAttribute(attribute, value);
    this.trigger.hidden = this.originalTrigger.hidden; this.trigger.disabled = this.originalTrigger.disabled; this.trigger.title = this.originalTrigger.title;
  }
  dispose() { this.destroy(); }
}
