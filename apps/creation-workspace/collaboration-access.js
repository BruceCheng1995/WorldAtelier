import { randomUUID, bindDialogDismiss } from './client-platform.js';

const roles = {owner:'所有者', editor:'可编辑', viewer:'可查看', player:'可查看'};
const requestStates = {pending:'等待审批', approved:'已批准', rejected:'未通过', cancelled:'已撤回', superseded:'已结束'};
const inviteStates = {active:'可使用', used:'已使用', revoked:'已撤销', expired:'已过期'};
const copy = value => value == null ? value : structuredClone(value);
const denied = error => [401,403,404].includes(Number(error?.status));
const time = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '';
};
const contextKey = ({user,project} = {}) => JSON.stringify([user?.id ?? null, project?.id ?? null, project?.permission_version ?? null, project?.role ?? null]);

/** Server-authorized collaboration UI. The host retains sessions, navigation and bootstrap. */
export class CollaborationAccess {
  constructor({api, getState, onChanged, toast, userColor} = {}) {
    if (!api?.api || typeof getState !== 'function') throw new Error('协作与权限缺少宿主接口');
    Object.assign(this, {api,getState,onChanged,toast,userColor});
    this.document = document; this.context = {}; this.key = null; this.projectId = null;
    this.generation = 0; this.serial = 0; this.controllers = new Set(); this.hosts = new Map();
    this.data = null; this.hostData = null; this.readJob = null; this.operation = null; this.confirmation = null;
    this.drafts = new Map(); this.invite = null; this.error = ''; this.notice = ''; this.loading = false;
    this.opened = false; this.disposed = false; this.tab = 'members'; this.requestId = null;
    this.makeDialog(); this.bindHosts();
    this.onVisibility = () => { if (this.document.visibilityState !== 'hidden') this.refresh(); };
    this.document.addEventListener('visibilitychange', this.onVisibility);
    this.setContext(getState() ?? {});
  }

  element(tag, text, parent, className) {
    const node = this.document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    parent?.append(node); return node;
  }
  icon(name,parent) {
    const svg = this.document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class','icon'); svg.setAttribute('aria-hidden','true');
    const use = this.document.createElementNS('http://www.w3.org/2000/svg','use');
    use.setAttribute('href',`#i-${name}`); svg.append(use); parent.append(svg); return svg;
  }
  button(text, parent, action, {kind='', disabled=false, key} = {}) {
    const button = this.element('button', text, parent, kind ? `wa-access-${kind}` : '');
    button.type = 'button'; button.disabled = disabled;
    if (key) button.dataset.focusKey = key;
    button.addEventListener('click', action); return button;
  }
  makeDialog() {
    const id = `wa-access-${randomUUID()}`;
    this.dialog = this.element('dialog', null, this.document.body, 'wa-access'); this.dialog.id = id;
    this.dialog.setAttribute('aria-labelledby', `${id}-title`);
    const header = this.element('header', null, this.dialog, 'wa-access-header');
    const heading = this.element('div', null, header);
    this.title = this.element('h2', '分享', heading); this.title.id = `${id}-title`;
    this.subtitle = this.element('p', '', heading);
    this.closeButton = this.button('', header, () => this.close(), {kind:'close',key:'close'}); this.closeButton.setAttribute('aria-label','关闭分享'); this.icon('close',this.closeButton);
    this.tabs = this.element('nav', null, this.dialog, 'wa-access-tabs'); this.tabs.setAttribute('aria-label','共享设置导航');
    this.status = this.element('div', null, this.dialog, 'wa-access-status'); this.status.setAttribute('aria-live','polite');
    this.body = this.element('div', null, this.dialog, 'wa-access-body'); this.body.tabIndex = -1;
    this.footer = this.element('footer', null, this.dialog, 'wa-access-footer');
    bindDialogDismiss(this.dialog, () => this.close());
    this.dialog.addEventListener('cancel',event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('close',() => { if (this.opened) this.close(); });
    this.dialog.addEventListener('keydown',event => this.trapFocus(event));
  }
  bindHosts() {
    for (const id of ['collaborationButton','catalogCollaboration']) {
      const node = this.document.getElementById(id);
      if (!node || this.hosts.has(id)) continue;
      const original = {html:node.innerHTML, hidden:node.hidden, disabled:node.disabled, title:node.title,
        attrs:Object.fromEntries(['aria-label','aria-haspopup','aria-controls','aria-expanded'].map(key => [key,node.getAttribute(key)]))};
      const click = event => {
        event.preventDefault();
        this.open({projectId:node.dataset.projectId || this.context.project?.id,tab:'members'});
      };
      node.addEventListener('click',click); this.hosts.set(id,{node,original,click});
      node.classList.add('wa-access-trigger');
      node.setAttribute('aria-haspopup','dialog'); node.setAttribute('aria-controls',this.dialog.id);
      if (id === 'collaborationButton') {
        node.replaceChildren();
        this.badge = this.element('span','!',node,'wa-access-badge'); this.badge.hidden = true; this.badge.setAttribute('aria-hidden','true');
        this.element('span','分享',node);
      } else {
        node.textContent = '分享';
      }
    }
  }
  setContext(value = {}) {
    if (this.disposed) return;
    const next = {user:copy(value.user),project:copy(value.project),connected:value.connected !== false};
    const key = contextKey(next), changed = this.key !== key, wasConnected = this.context.connected;
    const userChanged = this.context.user?.id !== next.user?.id;
    this.context = next; this.bindHosts();
    if (changed) this.hostData = null;
    const staleTarget = next.project?.id === this.projectId && this.data &&
      ((next.project.permission_version != null && next.project.permission_version !== this.data.project.permission_version) ||
       (next.project.role != null && next.project.role !== this.data.project.role));
    if (this.key === null || userChanged || (!this.opened && this.projectId !== next.project?.id)) {
      this.reset(); this.key = key; this.projectId = next.project?.id ?? null;
      this.render(); if (this.available()) this.refresh();
    } else if (changed && staleTarget) {
      // A dialog opened from Inbox owns its target project independently of the viewport.
      // Only a change to that target's permissions invalidates its forms and pending reads.
      this.reset({keepOpen:true}); this.key = key;
      this.render(); if (this.available()) this.refresh();
    } else if (wasConnected !== next.connected) {
      // A dropped connection does not discard an uncertain mutation's idempotency key.
      this.abortRead(); clearTimeout(this.timer); this.render();
      if (next.connected) this.refresh();
    } else this.renderHosts();
    this.key = key;
  }
  available() { return !this.disposed && !!this.context.user?.id && !!this.projectId; }
  current(generation) { return !this.disposed && this.generation === generation; }
  abortRead() {
    this.readController?.abort(); this.readController = null; this.serial++; this.readJob = null; this.loading = false;
  }
  reset({keepOpen=false,keepHostData=false} = {}) {
    this.generation++; this.abortRead(); clearTimeout(this.timer);
    for (const controller of this.controllers) controller.abort(); this.controllers.clear();
    if (!keepOpen) this.close({restoreContext:false});
    this.data = null; if (!keepHostData) this.hostData = null;
    this.operation = null; this.confirmation = null; this.invite = null;
    this.drafts.clear(); this.error = ''; this.notice = ''; this.requestId = null; this.manualLink = null;
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.available() && this.context.connected) this.timer = setTimeout(() => {
      if (this.document.visibilityState !== 'hidden') this.refresh(); else this.schedule();
    },20000);
  }
  route(suffix = '') { return `projects/${encodeURIComponent(this.projectId)}/${suffix || 'collaboration'}`; }
  async refresh() {
    if (!this.available() || !this.context.connected) { this.render(); return; }
    if (this.readJob) return this.readJob;
    const generation = this.generation, serial = ++this.serial, projectId = this.projectId;
    const controller = new AbortController(); this.readController = controller;
    this.loading = true; this.render();
    const job = (async () => {
      try {
        const result = await this.api.api(this.route(),{signal:controller.signal});
        if (!this.current(generation) || serial !== this.serial || projectId !== this.projectId) return;
        if (result?.project?.id !== projectId || !result.capabilities) throw new Error('协作权限数据不完整，请重试。');
        const previous = this.data;
        this.data = copy(result); this.error = '';
        if (previous && JSON.stringify(previous.requests?.map(row => [row.id,row.status,row.version])) !== JSON.stringify(result.requests?.map(row => [row.id,row.status,row.version]))) this.notice = '';
        if (projectId === this.context.project?.id) this.hostData = copy(result);
        if (previous && (previous.project.role !== result.project.role || previous.project.permission_version !== result.project.permission_version)) {
          this.drafts.clear(); this.confirmation = null;
        }
        if (!this.data.capabilities.can_manage) {
          if (this.tab === 'invites') this.tab = 'members';
          this.invite = null;
        } else if (this.invite) {
          const savedInvite = this.data.invites?.find(row => row.id === this.invite.id);
          if (savedInvite && savedInvite.status !== 'active') this.invite = null;
        }
        if (this.confirmation && !this.confirmationCurrent()) { this.confirmation = null; this.notice = '权限或申请已更新，请查看当前状态后再操作。'; }
        if (previous && (previous.project.permission_version !== result.project.permission_version || previous.capabilities.can_edit !== result.capabilities.can_edit)) this.notifyChanged(generation);
      } catch (error) {
        if (!this.current(generation) || serial !== this.serial || controller.signal.aborted) return;
        this.error = denied(error) ? '此游戏的协作权限已不可访问，请刷新工作台。' : error?.message || '暂时无法读取协作权限，请重试。';
        if (denied(error)) { this.data = null; if (projectId === this.context.project?.id) this.hostData = null; this.confirmation = null; this.invite = null; this.drafts.clear(); }
      } finally {
        if (this.current(generation) && serial === this.serial) {
          this.readJob = null; this.readController = null; this.loading = false; this.render(); this.schedule();
        }
      }
    })();
    this.readJob = job; return job;
  }
  open({projectId,tab='members',requestId=null} = {}) {
    if (this.disposed) return;
    const focusTarget = this.document.activeElement;
    this.setContext(this.getState() ?? this.context);
    const target = projectId ?? this.context.project?.id;
    if (!this.context.user?.id || !target) return;
    if (this.projectId !== target) { this.reset({keepHostData:true}); this.projectId = target; }
    this.focusTarget = focusTarget;
    this.tab = ['members','requests','invites','activity','settings','request-details'].includes(tab) ? tab : 'members';
    if (this.tab === 'requests') this.tab = 'members';
    this.requestId = requestId;
    this.opened = true; this.render();
    if (!this.dialog.open) this.dialog.showModal(); this.closeButton.focus(); this.refresh();
  }
  close({restoreContext=true} = {}) {
    const restore = this.opened;
    this.opened = false; this.confirmation = null; this.manualLink = null;
    if (this.dialog.open) this.dialog.close();
    this.renderHosts();
    if (restore) {
      const target = this.focusTarget?.isConnected && !this.focusTarget.disabled && !this.focusTarget.hidden ? this.focusTarget : this.hosts.get('collaborationButton')?.node;
      if (target && !target.hidden && !target.disabled) target.focus();
    }
    if (restoreContext && this.projectId !== this.context.project?.id) {
      const previous = this.hostData;
      this.reset({keepHostData:true}); this.projectId = this.context.project?.id ?? null;
      this.data = previous?.project.id === this.projectId ? previous : null;
      this.render(); this.refresh();
    }
  }
  trapFocus(event) {
    if (event.key !== 'Tab') return;
    const candidates = Array.from(this.dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]'))
      .filter(node => !node.hidden && node.getClientRects().length);
    const first = candidates[0], last = candidates.at(-1);
    if (!first) { event.preventDefault(); this.body.focus(); return; }
    if (event.shiftKey && (this.document.activeElement === first || !candidates.includes(this.document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && this.document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  canWrite() { return this.available() && this.context.connected && !!this.data && !this.loading && !this.error && !this.operation; }
  confirmationCurrent() {
    const value = this.confirmation;
    if (!value) return true;
    if (value.kind === 'access') return this.data?.capabilities.can_change_access && this.data.project.permission_version === value.version;
    if (value.kind === 'member') return this.data?.capabilities.can_manage && this.data.project.permission_version === value.version && this.data.members?.some(row => row.id === value.id && row.role !== 'owner');
    if (value.kind === 'request') return this.data?.requests?.some(row => row.id === value.id && row.version === value.version && row.status === 'pending');
    return this.data?.capabilities.can_manage && this.data.invites?.some(row => row.id === value.id && row.status === 'active');
  }
  notifyChanged(generation = this.generation) {
    if (!this.current(generation)) return;
    try {
      Promise.resolve(this.onChanged?.()).catch(() => {
        if (this.current(generation)) { this.notice = '权限已更新，工作台状态未刷新。请刷新页面查看。'; this.render(); }
      });
    } catch { this.notice = '权限已更新，工作台状态未刷新。请刷新页面查看。'; this.render(); }
  }
  async mutate({key,path,method='POST',body,success,invite=false}) {
    if (!this.canWrite()) return;
    this.operation = {key,path,method,body:{...body,request_id:randomUUID()},success,invite,status:'sending',message:''};
    return this.sendOperation();
  }
  async sendOperation() {
    const operation = this.operation;
    if (!operation || !this.available() || !this.context.connected || operation.inFlight) return;
    const generation = this.generation, controller = new AbortController(); this.controllers.add(controller);
    operation.status = 'sending'; operation.inFlight = true; operation.message = ''; this.notice = ''; this.render();
    try {
      const result = await this.api.api(operation.path,{method:operation.method,body:copy(operation.body),signal:controller.signal});
      if (!this.current(generation) || this.operation !== operation) return;
      this.operation = null; this.confirmation = null; this.drafts.clear();
      if (operation.invite) {
        if (typeof result?.code !== 'string' || !result.code) throw new Error('邀请已创建，但返回的邀请信息不完整。请刷新列表后撤销该邀请并重新生成。');
        this.invite = {...copy(result),role:operation.body.role};
      }
      const success = operation.key === 'invite-people' && Array.isArray(result.added)
        ? result.added.length ? `已邀请 ${result.added.length} 位协作者，通知已发送。` : '这些账号已拥有相同或更高权限。'
        : operation.success;
      if (operation.key === 'general-access') this.tab = 'members';
      this.notice = success; this.toast?.(success);
      this.abortRead(); await this.refresh(); this.notifyChanged(generation);
    } catch (error) {
      if (!this.current(generation) || controller.signal.aborted) return;
      if (Number(error?.status) === 409) {
        this.operation = null; this.confirmation = null; this.drafts.clear();
        this.notice = '权限或申请已被更新，本次操作未继续。请以最新记录为准。';
        this.abortRead(); await this.refresh(); this.notifyChanged(generation);
      } else if (denied(error)) {
        this.operation = null; this.confirmation = null; this.invite = null; this.drafts.clear();
        this.notice = '操作未获授权，权限可能已经变化。请查看当前权限。';
        this.abortRead(); await this.refresh(); this.notifyChanged(generation);
      } else if (this.operation === operation) {
        // Preserve the exact operation, including expected_version, for ambiguous transport/server errors.
        operation.status = error?.uncertain || !error?.status || Number(error.status) >= 500 ? 'uncertain' : 'failed';
        operation.message = error?.message || '操作未完成，请重试。';
      } else this.notice = error?.message || '操作结果暂不可用，请刷新查看。';
    } finally {
      this.controllers.delete(controller); operation.inFlight = false;
      if (this.current(generation)) this.render();
    }
  }
  renderHosts() {
    this.bindHosts();
    const authenticated = !!this.context.user?.id, project = this.context.project;
    const data = this.data?.project?.id === project?.id ? this.data : this.hostData?.project?.id === project?.id ? this.hostData : null;
    const error = this.projectId === project?.id && this.error;
    for (const [id,{node}] of this.hosts) {
      node.hidden = !authenticated || !(node.dataset.projectId || project?.id); node.disabled = node.hidden;
      node.setAttribute('aria-expanded',String(this.opened && this.projectId === (node.dataset.projectId || project?.id)));
      node.title = !this.context.connected ? '连接已断开，可查看协作状态' : error ? '协作状态暂不可用，点击重试' : '查看成员、编辑申请与权限';
    }
    const pending = data?.capabilities.can_manage ? Math.max(0,Number(data.pending_count) || 0) : 0;
    const readOnly = data ? !data.capabilities.can_edit : project && !['owner','editor'].includes(project.role);
    const request = data?.my_request;
    let message = readOnly ? '只读，可查看和试玩 · 点击申请编辑' : '可编辑 · 查看协作与权限';
    if (readOnly && request?.status === 'pending') message = '编辑申请等待拥有者审批 · 点击查看申请';
    else if (readOnly && request?.status === 'rejected') message = '编辑申请未通过 · 点击查看结果或再次申请';
    if (pending) message = `${pending} 个编辑申请待处理 · 点击审批`;
    if (error) message = '权限状态暂不可用 · 点击重试';
    if (!this.context.connected) message = '连接已断开，权限状态待刷新 · 点击查看协作';
    if (this.badge) this.badge.hidden = !authenticated || !project || !(readOnly || pending || error || !this.context.connected);
    const header = this.hosts.get('collaborationButton')?.node;
    if (header) {
      header.title = message; header.setAttribute('aria-label',`分享，${message}`);
      header.dataset.accessTab = 'members';
      header.dataset.accessState = !this.context.connected ? 'offline' : error ? 'error' : pending || request?.status === 'pending' && readOnly ? 'pending' : readOnly ? 'readonly' : 'editable';
    }
  }
  render() {
    this.renderHosts(); if (!this.opened) return;
    const active = this.document.activeElement, focusKey = active?.dataset.focusKey;
    const selection = typeof active?.selectionStart === 'number' ? [active.selectionStart,active.selectionEnd] : null;
    const scroll = this.body.scrollTop;
    const projectName = this.data?.project?.name ?? (this.projectId === this.context.project?.id ? this.context.project?.name : '') ?? '';
    this.title.textContent = projectName ? `分享「${projectName}」` : '分享';
    this.title.title = this.title.textContent;
    this.subtitle.textContent = '整个游戏 · 包含主干与所有分支';
    this.tabs.replaceChildren();
    const manages = !!this.data?.capabilities.can_manage;
    if (!manages && ['invites','settings'].includes(this.tab)) this.tab = 'members';
    if (this.tab === 'requests') this.tab = 'members';
    this.tabs.hidden = this.tab === 'members';
    if (!this.tabs.hidden) {
      this.button('‹ 返回分享',this.tabs,() => { this.tab = 'members'; this.confirmation = null; this.render(); },{key:'back-share'});
      this.element('strong',{'settings':'访问设置','invites':'邀请链接','activity':'共享记录','request-details':manages?'编辑申请':'我的申请'}[this.tab] || '共享设置',this.tabs);
    }
    this.status.replaceChildren();
    if (!this.context.connected) this.message('连接已断开。已有记录仅供查看，恢复连接后才能更改权限。','warning');
    if (this.error) { const row = this.message(this.error,'error'); this.button('重试',row,() => this.refresh(),{disabled:!this.context.connected || this.loading,key:'retry-load'}); }
    if (this.notice) this.message(this.notice,'notice');
    if (this.operation) {
      const operation = this.operation;
      const row = this.message(operation.status === 'sending' ? '正在提交，请稍候…' : operation.status === 'uncertain' ? '尚未确认操作结果。此前操作可能已生效，重试不会重复提交。' : operation.message,'error');
      if (operation.status !== 'sending') {
        if (operation.status === 'uncertain' && operation.message) this.element('small',operation.message,row);
        this.button('重试确认结果',row,() => this.sendOperation(),{disabled:!this.context.connected,key:'retry-operation'});
        if (operation.status === 'failed') this.button('返回修改',row,() => { this.operation = null; this.render(); },{key:'edit-operation'});
      }
    }
    this.status.hidden = !this.status.childNodes.length;
    this.body.replaceChildren(); this.body.setAttribute('aria-busy',String(this.loading));
    this.renderFooter();
    if (!this.data) this.element('p',this.loading ? '正在读取协作信息…' : '协作信息暂不可用，请重试。',this.body,'wa-access-empty');
    else {
      if (this.tab === 'members') this.renderMembers();
      else if (this.tab === 'request-details') this.renderRequests();
      else if (this.tab === 'settings' && manages) this.renderSettings();
      else if (this.tab === 'invites' && manages) this.renderInvites();
      else this.renderActivity();
    }
    this.body.scrollTop = scroll;
    if (focusKey) {
      const replacement = Array.from(this.dialog.querySelectorAll('[data-focus-key]')).find(node => node.dataset.focusKey === focusKey);
      if (replacement && !replacement.disabled) { replacement.focus({preventScroll:true}); if (selection && replacement.setSelectionRange) replacement.setSelectionRange(...selection); }
      else if (this.dialog.contains(active) || !active?.isConnected) this.body.focus({preventScroll:true});
    }
    if (this.requestId && ['members','request-details'].includes(this.tab)) {
      const target = Array.from(this.body.querySelectorAll('[data-request-id]')).find(node => node.dataset.requestId === this.requestId);
      if (target) { target.classList.add('is-targeted'); target.scrollIntoView({block:'nearest'}); this.requestId = null; }
    }
  }
  message(text,kind) { return this.element('div',text,this.status,`wa-access-message is-${kind}`); }
  card(parent = this.body) { return this.element('section',null,parent,'wa-access-card'); }
  person(person,parent) {
    const row = this.element('div',null,parent,'wa-access-person');
    const avatar = this.element('span',(person?.name || '?').slice(0,1),row,'wa-access-avatar'); avatar.setAttribute('aria-hidden','true');
    try {
      const color = this.userColor?.(person);
      if (typeof color === 'string' && globalThis.CSS?.supports('color',color)) avatar.style.backgroundColor = color;
    } catch { /* Display remains usable if the host color helper cannot resolve a removed member. */ }
    this.element('strong',person?.name || '已离开的用户',row); return row;
  }
  draftInput(key,parent,{label,placeholder='',value='',select=false,options=[]} = {}) {
    const field = this.element('label',null,parent,'wa-access-field'); this.element('span',label,field);
    const input = this.element(select ? 'select' : 'textarea',null,field); input.dataset.focusKey = key;
    if (select) for (const [id,text] of options) { const option = this.element('option',text,input); option.value = id; }
    else { input.maxLength = 500; input.rows = 3; input.placeholder = placeholder; }
    input.value = this.drafts.has(key) ? this.drafts.get(key) : value;
    input.disabled = !this.canWrite();
    input.addEventListener('input',() => this.drafts.set(key,input.value));
    input.addEventListener('change',() => this.drafts.set(key,input.value)); return input;
  }
  confirmationBox(parent,text,confirm,action) {
    const box = this.element('div',null,parent,'wa-access-confirm'); box.setAttribute('role','group');
    this.element('p',text,box);
    const actions = this.element('div',null,box,'wa-access-actions');
    this.button(confirm,actions,action,{kind:'danger',disabled:!this.canWrite(),key:'confirm-action'});
    this.button('暂不更改',actions,() => { this.confirmation = null; this.render(); },{disabled:!!this.operation,key:'cancel-confirm'});
  }
  shareLink() {
    const here = new URL(this.document.location.href);
    const loopback = url => ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    let base = here;
    if (loopback(here)) for (const candidate of this.data?.share_urls ?? []) {
      try { const url = new URL(candidate); if (['http:','https:'].includes(url.protocol) && !loopback(url)) { base = url; break; } } catch {}
    }
    const url = new URL('/creation-workspace.html',base.origin);
    const game = `/games/${encodeURIComponent(this.projectId)}`;
    const route = here.hash.slice(1), branch = route.startsWith(game+'/branches/') ? route.slice(game.length+'/branches/'.length).split(/[/?#]/)[0] : '';
    url.hash = game + (branch ? `/branches/${branch}` : '');
    return url.href;
  }
  async writeClipboard(value) {
    const clipboard = this.document.defaultView?.navigator?.clipboard;
    if (!clipboard?.writeText) throw new Error('manual-copy');
    let timer;
    try {
      await Promise.race([clipboard.writeText(value),new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('manual-copy')),1500); })]);
    } finally { clearTimeout(timer); }
  }
  renderFooter() {
    this.footer.replaceChildren();
    const links = this.element('div',null,this.footer,'wa-access-footer-links');
    if (this.data?.capabilities.can_manage) this.button('邀请链接',links,() => { this.tab = 'invites'; this.render(); },{kind:'text',key:'more-invites'});
    this.button('共享记录',links,() => { this.tab = 'activity'; this.render(); },{kind:'text',key:'more-activity',disabled:!this.data});
    const button = this.button('复制链接',this.footer,async () => {
      const value = this.shareLink(), generation = this.generation;
      button.textContent = '正在复制…'; button.disabled = true;
      try {
        await this.writeClipboard(value);
        if (this.current(generation) && button.isConnected) { button.textContent = '链接已复制'; button.disabled = false; this.toast?.('分享链接已复制'); }
      } catch {
        if (!this.current(generation) || !this.opened) return;
        this.manualLink = value; this.render();
        const input = this.footer.querySelector('input'); input?.focus(); input?.select();
      }
    },{kind:'primary',key:'copy-share-link',disabled:!this.data});
    if (this.data) button.title = this.shareLink();
    if (this.manualLink) {
      const field = this.element('label',null,this.footer,'wa-access-manual-link');
      this.element('span','请按 ⌘C / Ctrl+C 复制链接',field);
      const input = this.element('input',null,field); input.value = this.shareLink(); input.readOnly = true; input.dataset.focusKey = 'manual-share-link';
    }
  }
  renderMembers() {
    const {project,capabilities,members=[]} = this.data;
    if (capabilities.can_invite) this.renderInvitePeople();
    if (capabilities.can_manage) {
      const pending = (this.data.requests ?? []).filter(request => request.status === 'pending');
      if (pending.length) {
        const section = this.element('section',null,this.body,'wa-access-pending');
        this.element('h3',`编辑申请 · ${this.data.pending_count}`,section);
        for (const request of pending) {
          const card = this.element('div',null,section,'wa-access-pending-row'); card.dataset.requestId = request.id;
          const row = this.person(request.requester,card);
          const actions = this.element('span',null,row,'wa-access-inline-actions');
          this.button('拒绝',actions,() => { this.confirmation = {kind:'request',id:request.id,version:request.version,decision:'reject'}; this.render(); },{key:`reject-${request.id}`,disabled:!this.canWrite()});
          this.button('批准',actions,() => this.decide(request,'approve',''),{kind:'primary',key:`approve-${request.id}`,disabled:!this.canWrite()});
          if (request.reason) this.element('p',request.reason,card,'wa-access-request-reason');
          if (this.confirmation?.kind === 'request' && this.confirmation.id === request.id) this.confirmationBox(card,'拒绝后，对方会收到通知；仍可再次申请。','拒绝申请',() => this.decide(request,'reject',''));
        }
        this.button('查看申请详情',section,() => { this.tab = 'request-details'; this.render(); },{kind:'text',key:'request-details'});
      }
    } else if (!capabilities.can_edit) {
      const row = this.element('section',null,this.body,'wa-access-my-status'), request = this.data.my_request;
      const copy = this.element('div',null,row);
      this.element('strong',request?.status === 'pending' ? '编辑申请已发送' : request?.status === 'rejected' ? '编辑申请未通过' : '你可以查看和试玩',copy);
      this.element('small',request?.status === 'pending' ? '等待游戏拥有者处理' : request?.status === 'rejected' ? '查看处理说明或再次申请' : '修改内容需要编辑权限',copy);
      this.button(request?.status === 'pending' ? '查看申请' : '申请编辑',row,() => { this.tab = 'request-details'; this.render(); },{key:'member-request',disabled:!request&&!capabilities.can_request_edit});
    }
    this.element('h3','谁可以访问',this.body,'wa-access-section-title');
    const general = this.element('div',null,this.body,'wa-access-general-row');
    this.icon(this.data.general_access === 'registered_readonly' ? 'eye' : 'lock',this.element('span',null,general,'wa-access-scope-icon'));
    const text = this.element('div',null,general,'wa-access-general-copy');
    this.element('strong',this.data.general_access === 'registered_readonly' ? '任何已注册用户' : '只有受邀成员',text);
    this.element('small',this.data.general_access === 'registered_readonly' ? '通过链接或游戏首页访问' : '链接不会额外授予权限',text);
    if (capabilities.can_change_access) this.button(this.data.general_access === 'registered_readonly' ? '可查看 ⌄' : '更改 ›',general,() => { this.tab = 'settings'; this.render(); },{kind:'text',key:'general-access'});
    else this.element('span',this.data.general_access === 'registered_readonly' ? '可查看' : '受限',general,'wa-access-role');
    const list = this.element('div',null,this.body,'wa-access-member-list'); list.setAttribute('aria-label','已受邀成员');
    for (const member of members) {
      const card = this.element('div',null,list,'wa-access-member'), row = this.person(member,card);
      if (member.id === this.context.user.id) this.element('small','（你）',row,'wa-access-you');
      if (!capabilities.can_manage || member.role === 'owner') {
        this.element('span',roles[member.role] ?? '可查看',row,'wa-access-role'); continue;
      }
      const select = this.element('select',null,row,'wa-access-member-role'); select.setAttribute('aria-label',`${member.name} 的权限`); select.dataset.focusKey = `role-${member.id}`;
      for (const [value,label] of [['viewer','可查看'],['editor','可编辑'],['remove','移除权限']]) { const option = this.element('option',label,select); option.value = value; }
      select.value = member.role; select.disabled = !this.canWrite();
      select.addEventListener('change',() => {
        const role = select.value === 'remove' ? null : select.value;
        if (role === member.role) return;
        if (role === 'editor') this.saveMember(member.id,role,project.permission_version);
        else { this.confirmation = {kind:'member',id:member.id,role,version:project.permission_version}; this.render(); }
      });
      if (this.confirmation?.kind === 'member' && this.confirmation.id === member.id) {
        const change = this.confirmation, publicRead = this.data.general_access === 'registered_readonly';
        this.confirmationBox(card,change.role === null ? publicRead ? `移除 ${member.name} 的直接权限后，对方仍可公共查看和试玩。` : `移除后，${member.name} 将无法访问此游戏。` : `${member.name} 将只能查看和试玩，无法修改游戏。`,change.role === null ? '移除权限' : '改为可查看',() => this.saveMember(member.id,change.role,change.version));
      }
    }
    this.element('p','共享权限适用于整个游戏；新 Agent 会话默认向项目成员公开，可手动设为私有。',this.body,'wa-access-privacy');
  }
  renderInvitePeople() {
    const form = this.element('form',null,this.body,'wa-access-invite-form');
    const input = this.element('input',null,form); input.type = 'text'; input.autocomplete = 'off'; input.placeholder = '用户名，多个用逗号分隔'; input.setAttribute('aria-label','邀请账号用户名'); input.maxLength = 1000; input.dataset.focusKey = 'invite-names'; input.value = this.drafts.get('invite-names') || ''; input.disabled = !this.canWrite();
    const role = this.element('select',null,form); role.setAttribute('aria-label','邀请权限'); role.dataset.focusKey = 'direct-invite-role';
    for (const [value,label] of [['viewer','可查看'],['editor','可编辑']]) { const option = this.element('option',label,role); option.value = value; }
    role.value = this.drafts.get('direct-invite-role') || 'editor'; role.disabled = !this.canWrite();
    const send = this.button('邀请',form,() => {},{kind:'primary',key:'invite-people',disabled:!this.canWrite() || !input.value.trim()}); send.type = 'submit';
    input.addEventListener('input',() => { this.drafts.set('invite-names',input.value); send.disabled = !this.canWrite() || !input.value.trim(); });
    role.addEventListener('change',() => this.drafts.set('direct-invite-role',role.value));
    form.addEventListener('submit',event => {
      event.preventDefault(); if (send.disabled) return;
      const names = input.value.split(/[,，;；\n]/).map(name=>name.trim()).filter(Boolean);
      this.mutate({key:'invite-people',path:this.route('share-invitations'),body:{names,role:role.value,expected_version:this.data.project.permission_version},success:'权限已授予，邀请通知已发送。'});
    });
    this.element('p','输入同事注册时使用的用户名，邀请会显示在对方的消息中。',this.body,'wa-access-invite-hint');
  }
  renderSettings() {
    this.element('h3','谁可以访问',this.body);
    const scope = this.draftInput('general-access',this.body,{label:'访问范围',select:true,value:this.data.general_access,options:[['members_only','只有受邀成员'],...(this.data.public_access_available ? [['registered_readonly','任何已注册用户']] : [])]});
    this.element('p','选择“任何已注册用户”后，同事可通过游戏首页或链接查看场景、预制件并试玩。选择“只有受邀成员”后，其他用户将无法访问。',this.body,'wa-access-muted');
    this.element('h3','他们可以做什么',this.body);
    this.element('p','可查看与试玩。编辑权限通过邀请或审批单独授予。',this.body,'wa-access-muted');
    if (!this.data.public_access_available) this.element('p','服务器当前仅开放受邀访问。',this.body,'wa-access-muted');
    this.button('保存访问设置',this.body,() => {
      if (scope.value === this.data.general_access) { this.tab = 'members'; this.render(); return; }
      this.confirmation = {kind:'access',version:this.data.project.permission_version,general_access:scope.value}; this.render();
    },{kind:'primary',disabled:!this.canWrite(),key:'save-access'});
    if (this.confirmation?.kind === 'access') {
      const change = this.confirmation;
      this.confirmationBox(this.body,change.general_access === 'members_only' ? '未受邀用户将失去此游戏的查看和试玩权限；已受邀成员保留各自权限。' : '所有已注册用户将能看到并试玩这个游戏，仍不能编辑。','确认更改',() => this.mutate({key:'general-access',path:this.route('sharing'),method:'PATCH',body:{general_access:change.general_access,expected_version:change.version},success:'共享范围已更新。'}));
    }
  }
  saveMember(id,role,version) {
    return this.mutate({key:`member-${id}`,path:this.route(`members/${encodeURIComponent(id)}`),method:'PATCH',body:{expected_version:version,role},success:role === null ? this.data.general_access === 'registered_readonly' ? '成员已移除，对方仍可公共查看和试玩。' : '成员已移除，对方不再拥有此游戏的访问权限。' : `成员权限已改为${roles[role]}。`});
  }
  renderRequests() {
    if (!this.data.capabilities.can_manage) { this.renderMyRequest(); return; }
    const requests = [...(this.data.requests ?? [])].sort((a,b) => Number(b.status === 'pending') - Number(a.status === 'pending') || new Date(b.created_at) - new Date(a.created_at));
    this.element('p','批准后，对方可以编辑此游戏。新 Agent 会话默认向项目成员公开，可手动设为私有。',this.body,'wa-access-muted');
    if (!requests.length) this.element('p','还没有编辑申请。新申请会显示在这里。',this.body,'wa-access-empty');
    for (const request of requests) {
      const card = this.requestCard(request);
      if (request.status !== 'pending') continue;
      const key = `note-${request.id}`;
      const note = this.draftInput(key,card,{label:'审批说明（可选）',placeholder:'向申请人说明决定，最多 500 字'});
      const actions = this.element('div',null,card,'wa-access-actions');
      this.button('批准编辑',actions,() => this.decide(request,'approve',note.value),{kind:'primary',disabled:!this.canWrite(),key:`approve-${request.id}`});
      this.button('拒绝申请',actions,() => { this.confirmation = {kind:'request',id:request.id,version:request.version,decision:'reject'}; this.render(); },{disabled:!this.canWrite(),key:`reject-${request.id}`});
      if (this.confirmation?.id === request.id && this.confirmation.kind === 'request') this.confirmationBox(card,`拒绝后，${request.requester?.name || '申请人'} 会看到你的审批说明，仍可查看、试玩并再次申请。`,'确认拒绝申请',() => this.decide(request,'reject',this.drafts.get(key) || ''));
    }
  }
  requestCard(request) {
    const card = this.card(); card.dataset.requestId = request.id;
    const row = this.person(request.requester,card);
    this.element('span',requestStates[request.status] || '已结束',row,`wa-access-role ${request.status === 'pending' ? 'is-pending' : ''}`);
    this.element('small',`申请于 ${time(request.created_at)}`,card,'wa-access-muted');
    this.element('p',request.reason || '未填写申请说明。',card,'wa-access-prose');
    if (request.decision_note) { this.element('span','审批说明',card,'wa-access-caption'); this.element('p',request.decision_note,card,'wa-access-prose'); }
    if (request.reviewer) this.element('small',`${request.reviewer.name} · ${time(request.resolved_at || request.updated_at)}`,card,'wa-access-muted');
    return card;
  }
  renderMyRequest() {
    const request = this.data.my_request, capabilities = this.data.capabilities;
    if (request) this.requestCard(request);
    if (request?.status === 'pending') {
      const card = this.card(); this.element('p','所有者审批后，编辑权限会在工作台生效。等待期间仍可查看和试玩。',card,'wa-access-muted');
      this.button('撤回申请',card,() => { this.confirmation = {kind:'request',id:request.id,version:request.version}; this.render(); },{disabled:!this.canWrite(),key:'cancel-request'});
      if (this.confirmation?.id === request.id) this.confirmationBox(card,'撤回后，本次申请不再等待审批。需要编辑时可以重新申请。','确认撤回申请',() => this.mutate({key:`cancel-${request.id}`,path:this.route(`access-requests/${encodeURIComponent(request.id)}/cancel`),body:{expected_version:request.version},success:'编辑申请已撤回。'}));
    } else if (capabilities.can_request_edit) {
      const card = this.card(); this.element('h3',request ? '再次申请编辑' : '申请编辑权限',card);
      this.element('p','向游戏所有者申请修改场景、资产与游戏逻辑。新 Agent 会话默认向项目成员公开，可手动设为私有。',card,'wa-access-muted');
      const reason = this.draftInput('request-reason',card,{label:'申请说明（可选）',placeholder:'告诉所有者你想参与哪些工作，最多 500 字'});
      this.button('提交编辑申请',card,() => this.mutate({key:'request',path:this.route('access-requests'),body:{reason:reason.value},success:'编辑申请已提交，等待所有者审批。'}),{kind:'primary',disabled:!this.canWrite(),key:'submit-request'});
    } else {
      const card = this.card(); this.element('p',capabilities.can_edit ? '你当前已拥有编辑权限。' : '当前无法申请编辑权限，你仍可查看和试玩。',card,'wa-access-muted');
    }
  }
  decide(request,decision,note) {
    return this.mutate({key:`decision-${request.id}`,path:this.route(`access-requests/${encodeURIComponent(request.id)}/decision`),body:{expected_version:request.version,decision,note},success:decision === 'approve' ? '申请已批准，对方可以编辑此游戏。' : '申请已拒绝，审批说明已发送给申请人。'});
  }
  renderInvites() {
    const create = this.card(); this.element('h3','邀请协作者',create);
    this.element('p','邀请仅可使用一次，24 小时后失效。请分享给你希望加入的协作者。',create,'wa-access-muted');
    const role = this.draftInput('invite-role',create,{label:'加入后的权限',select:true,value:'viewer',options:[['viewer','只读 · 查看与试玩'],['editor','可编辑 · 修改游戏内容']]});
    this.button('生成一次性邀请',create,() => this.mutate({key:'invite',path:this.route('invites'),body:{role:role.value},success:'邀请已生成，请复制后分享。',invite:true}),{kind:'primary',disabled:!this.canWrite(),key:'create-invite'});
    if (this.invite) {
      const card = this.card(); this.element('h3',`新邀请 · ${roles[this.invite.role]}`,card);
      this.element('p',`有效期至 ${time(this.invite.expires_at)}。关闭页面后无法再次查看此邀请码。`,card,'wa-access-muted');
      this.copyField('邀请码',this.invite.code,card,'invite-code');
      this.copyField('邀请链接',`${new URL(this.shareLink()).origin}/creation-workspace.html?invite=${encodeURIComponent(this.invite.code)}`,card,'invite-link');
    }
    this.element('h3','邀请记录',this.body,'wa-access-section-title');
    if (!this.data.invites?.length) this.element('p','尚未生成邀请。',this.body,'wa-access-empty');
    for (const invite of this.data.invites ?? []) {
      const card = this.card(), row = this.element('div',null,card,'wa-access-invite-row');
      this.element('strong',`${roles[invite.role] || '只读'}邀请`,row); this.element('span',inviteStates[invite.status] || '已结束',row,'wa-access-role');
      this.element('p',`创建于 ${time(invite.created_at)} · 到期 ${time(invite.expires_at)}`,card,'wa-access-muted');
      if (invite.used_by) this.element('p',`使用者：${typeof invite.used_by === 'object' ? invite.used_by.name : '已加入的协作者'}`,card,'wa-access-muted');
      if (invite.status !== 'active') continue;
      this.button('撤销邀请',card,() => { this.confirmation = {kind:'invite',id:invite.id}; this.render(); },{disabled:!this.canWrite(),key:`revoke-${invite.id}`});
      if (this.confirmation?.kind === 'invite' && this.confirmation.id === invite.id) this.confirmationBox(card,'撤销后，这个邀请链接和邀请码将立即失效。','确认撤销邀请',() => this.mutate({key:`revoke-${invite.id}`,path:this.route(`invites/${encodeURIComponent(invite.id)}/revoke`),body:{},success:'邀请已撤销。'}));
    }
  }
  copyField(label,value,parent,key) {
    const field = this.element('label',null,parent,'wa-access-field'); this.element('span',label,field);
    const row = this.element('span',null,field,'wa-access-copy'); const input = this.element('input',null,row);
    input.readOnly = true; input.value = value; input.dataset.focusKey = key;
    const feedback = this.element('small','',field,'wa-access-muted'); feedback.setAttribute('aria-live','polite');
    this.button('复制',row,async () => {
      const generation = this.generation;
      try {
        await this.writeClipboard(value);
        if (this.current(generation) && feedback.isConnected) feedback.textContent = '已复制。';
      } catch {
        if (!this.current(generation) || !input.isConnected) return;
        input.focus(); input.select(); input.setSelectionRange(0,input.value.length);
        feedback.textContent = '内容已选中，请按 ⌘C / Ctrl+C 复制，或长按选择复制。';
      }
    },{key:`copy-${key}`});
  }
  renderActivity() {
    const actions = {
      access_requested:'提交了编辑申请',access_request_created:'提交了编辑申请',request_created:'提交了编辑申请',
      access_request_approved:'批准了编辑申请',request_approved:'批准了编辑申请',access_approved:'批准了编辑申请',
      access_request_rejected:'拒绝了编辑申请',request_rejected:'拒绝了编辑申请',access_rejected:'拒绝了编辑申请',
      access_request_cancelled:'撤回了编辑申请',request_cancelled:'撤回了编辑申请',
      request_superseded:'结束了已失效的编辑申请',
      general_access_changed:'更改了访问范围',member_added:'添加了协作成员',member_joined:'加入了协作',member_role_changed:'更改了成员权限',member_updated:'更改了成员权限',member_removed:'移除了协作成员',
      invite_created:'生成了邀请',invite_used:'通过邀请加入协作',invite_revoked:'撤销了邀请'
    };
    this.element('p',this.data.capabilities.can_manage ? '此游戏最近的协作权限变更。' : '与你有关的协作权限变更。',this.body,'wa-access-muted');
    if (!this.data.activity?.length) this.element('p','暂无权限变更记录。',this.body,'wa-access-empty');
    for (const audit of this.data.activity ?? []) {
      const card = this.card(); this.person(audit.actor,card);
      this.element('p',`${actions[audit.action] || '更新了协作权限'}${audit.subject ? ` · ${audit.subject.name}` : ''}`,card,'wa-access-prose');
      if (audit.from_role != null || audit.to_role != null) this.element('p',`${roles[audit.from_role] ?? '公共只读'} → ${roles[audit.to_role] ?? '公共只读'}`,card,'wa-access-muted');
      if (audit.from_access && audit.to_access) this.element('p',`${audit.from_access === 'registered_readonly' ? '任何已注册用户' : '只有受邀成员'} → ${audit.to_access === 'registered_readonly' ? '任何已注册用户' : '只有受邀成员'}`,card,'wa-access-muted');
      this.element('small',time(audit.created_at),card,'wa-access-muted');
    }
  }
  dispose() {
    if (this.disposed) return;
    this.reset(); this.disposed = true; this.document.removeEventListener('visibilitychange',this.onVisibility);
    for (const [id,{node,original,click}] of this.hosts) {
      node.removeEventListener('click',click); node.innerHTML = original.html; node.hidden = original.hidden;
      if (original.disabled != null) node.disabled = original.disabled;
      node.title = original.title; node.classList.remove('wa-access-trigger');delete node.dataset.accessTab;delete node.dataset.accessState;
      for (const [name,value] of Object.entries(original.attrs)) { if (value == null) node.removeAttribute(name); else node.setAttribute(name,value); }
    }
    this.hosts.clear(); this.dialog.remove();
  }
}
