import { randomUUID, bindDialogDismiss } from './client-platform.js';
import { prepareGamePlay } from './game-play.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const terminal = new Set(['completed', 'partial', 'failed', 'interrupted']);
const webCompatibilityPolicy = 'world-atelier-single-thread-local-http-v1';
const compatibleWeb = job => job?.web_compatibility?.policy === webCompatibilityPolicy;
const statusLabels = {queued:'等待后台处理', running:'后台处理中', completed:'已完成', partial:'部分完成', failed:'失败', interrupted:'处理已中断'};
const targetLabels = {source:'Godot 工程', web:'Web', windows:'Windows', macos:'macOS', linux:'Linux', android:'Android', ios:'iOS'};
const progressOf = job => Math.max(0, Math.min(100, Number(job?.progress) || 0));
const short = value => String(value ?? '').slice(0, 15);
const scopeKey = context => context?.user_id && context.project_id && context.branch_id ? JSON.stringify([context.user_id, context.project_id, context.branch_id]) : null;
const canBuild = context => ['owner', 'editor'].includes(context?.role);
const bytes = value => { const size = Number(value); return size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GB` : size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`; };
const errorMessage = error => error?.message || '请求失败，请重试';

/** The workbench supplies its authenticated API and its current server-backed context. */
export class ReleaseBuilds {
  constructor({request, download}) {
    this.request = request; this.download = download; this.context = null; this.key = null;
    this.generation = 0; this.jobs = []; this.targets = []; this.targetsLoaded = false;
    this.pending = null; this.controller = null; this.timer = null; this.view = null;
    this.error = ''; this.readDenied = false; this.focusTarget = null; this.submitting = false;
    this.disposed = false; this.downloads = new Set(); this.opening = new Set(); this.clientErrors = new Map();
    this.webPreview = null;
    this.releaseState = null; this.releaseError = ''; this.publishing = new Set(); this.publishRequests = new Map();
    this.actions = document.getElementById('releaseBuildActions');
    this.exportButton = document.getElementById('exportProjectButton');
    this.packageButton = document.getElementById('packageProjectButton');
    this.progressButton = document.getElementById('releaseBuildProgress');
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'releaseBuildDialog'; this.dialog.className = 'release-build-dialog';
    this.dialog.setAttribute('aria-labelledby', 'releaseBuildTitle');
    this.dialog.innerHTML = '<div class="release-build-head"><div><p class="release-build-eyebrow">导出与打包</p><h2 id="releaseBuildTitle"></h2></div><button type="button" class="release-build-close" aria-label="关闭导出与打包">×</button></div><div class="release-build-body"></div><div class="release-build-footer"></div>';
    document.body.append(this.dialog);
    this.body = this.dialog.querySelector('.release-build-body');
    this.footer = this.dialog.querySelector('.release-build-footer');
    this.dialog.querySelector('.release-build-close').onclick = () => this.close();
    bindDialogDismiss(this.dialog, () => this.close());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.exportButton.onclick = () => this.open('source', this.exportButton);
    this.packageButton.onclick = () => this.open('configure', this.packageButton);
    this.progressButton.onclick = () => this.open('history', this.progressButton);
    this.visibilityListener = () => { if (document.visibilityState === 'visible' && this.key) this.refresh(); };
    document.addEventListener('visibilitychange', this.visibilityListener);
  }

  setContext(context) {
    if (this.disposed) return;
    const nextKey = scopeKey(context), changed = nextKey !== this.key;
    this.context = context ? structuredClone(context) : null;
    if (changed) {
      this.cancelWebPreview();
      this.generation++; this.key = nextKey; this.controller?.abort(); this.controller = null;
      clearTimeout(this.timer); this.pending = null; this.jobs = []; this.targets = [];
      this.targetsLoaded = false; this.error = ''; this.readDenied = false; this.submitting = false;
      this.releaseState = null; this.releaseError = ''; this.publishing.clear(); this.publishRequests.clear();
      this.close(false); this.downloads.clear(); this.opening.clear(); this.clientErrors.clear();
      if (this.key) this.refresh();
    } else if (!canBuild(this.context)) { if (this.view && this.view.type !== 'history') this.close(false); }
    this.renderTopbar();
  }

  route(context = this.context) { return `projects/${encodeURIComponent(context.project_id)}/branches/${encodeURIComponent(context.branch_id)}/builds`; }
  releaseRoute(context = this.context) { return `projects/${encodeURIComponent(context.project_id)}/branches/${encodeURIComponent(context.branch_id)}/game-releases`; }
  current(generation) { return !this.disposed && generation === this.generation && !!this.key; }
  schedule() {
    clearTimeout(this.timer);
    if (!this.key || this.disposed || this.readDenied) return;
    this.timer = setTimeout(() => this.refresh(), this.jobs.some(job => !terminal.has(job.status)) ? 2000 : 15000);
  }

  async refresh() {
    if (!this.key || this.disposed) return;
    if (this.pending) return this.pending;
    const generation = this.generation, context = this.context;
    const controller = this.controller = new AbortController();
    const task = (async () => {
      try {
        const [builds, releases] = await Promise.allSettled([
          this.request(this.route(context), {signal:controller.signal}),
          this.request(this.releaseRoute(context), {signal:controller.signal})
        ]);
        if (!this.current(generation)) return;
        if (releases.status === 'fulfilled' && releases.value.project_id === context.project_id && releases.value.branch_id === context.branch_id) {
          this.releaseState = releases.value; this.releaseError = '';
        } else { this.releaseState = null; this.releaseError = errorMessage(releases.reason || new Error('发行状态归属不匹配')); }
        if (builds.status === 'rejected') throw builds.reason;
        const result = builds.value;
        this.jobs = (result.jobs ?? []).filter(job => job.project_id === context.project_id && job.branch_id === context.branch_id);
        this.targets = result.targets ?? []; this.targetsLoaded = true; this.error = ''; this.readDenied = false;
      } catch (error) {
        if (!this.current(generation) || controller.signal.aborted) return;
        this.error = errorMessage(error);
        if ([401, 403, 404].includes(error.status)) { this.jobs = []; this.targets = []; this.targetsLoaded = false; this.readDenied = true; }
      } finally {
        if (this.current(generation)) {
          this.pending = null; this.controller = null; this.renderTopbar();
          if (this.view?.type === 'history' || this.view?.type === 'loading') this.render();
          this.updateWebPreview();
          this.schedule();
        }
      }
    })();
    this.pending = task;
    return task;
  }

  renderTopbar() {
    this.actions.hidden = !this.key;
    const disabled = !canBuild(this.context) || this.readDenied || !this.context?.source_revision;
    for (const button of [this.exportButton, this.packageButton]) button.disabled = disabled;
    this.exportButton.title = disabled ? '需要项目拥有者或编辑者权限，并进入一个分支' : '导出 Godot 工程';
    this.packageButton.title = disabled ? '需要项目拥有者或编辑者权限，并进入一个分支' : '打包应用';
    const active = this.jobs.filter(job => !terminal.has(job.status));
    this.progressButton.hidden = !this.key || (!this.jobs.length && !this.error);
    this.progressButton.classList.toggle('is-running', !!active.length);
    this.progressButton.classList.toggle('has-error', !!this.error);
    const label = this.error ? '状态待刷新' : active.length ? `${active.length} 项 · ${Math.round(progressOf(active[0]))}%` : '出包记录';
    this.progressButton.querySelector('.release-build-progress-label').textContent = label;
    this.progressButton.querySelector('.release-build-progress-track > span').style.width = `${active.length ? progressOf(active[0]) : 100}%`;
    this.progressButton.setAttribute('aria-label', this.error ? `出包状态暂不可用：${this.error}` : active.length ? `${active.length} 项后台任务，当前进度 ${Math.round(progressOf(active[0]))}%，查看进度` : '查看导出与打包记录');
    const menuTrigger = this.actions?.querySelector?.('#buildMenu > summary');
    if (menuTrigger) { const description = `构建与导出${this.error ? ' · 状态待刷新' : active.length ? ' · '+label : ''}`; menuTrigger.title = description; menuTrigger.setAttribute('aria-label',description); }
  }

  open(type, trigger) {
    if (!this.key || type !== 'history' && (!canBuild(this.context) || this.readDenied)) return;
    this.focusTarget = trigger?.closest?.('.topbar-popover') ? document.getElementById('interfaceMenuButton') : trigger?.closest?.('.workspace-disclosure')?.querySelector('summary') ?? trigger; const context = structuredClone(this.context);
    const scenes = (context.resources ?? []).filter(resource => resource.kind === 'scene' && resource.purpose !== 'prefab_test');
    this.view = {type, context, error:'', targetIds:[], entrySceneId:scenes.find(scene => scene.id === context.entry_scene_id)?.id ?? scenes[0]?.id ?? ''};
    if (type === 'configure' && !this.targetsLoaded) this.view.type = 'loading';
    this.render(); if (!this.dialog.open) this.dialog.showModal();
    if (type === 'history' || !this.targetsLoaded) this.refresh();
  }

  close(restoreFocus = true) {
    this.view = null; if (this.dialog.open) this.dialog.close();
    if (restoreFocus && this.focusTarget?.isConnected && !this.focusTarget.disabled && !this.focusTarget.hidden) this.focusTarget.focus();
  }

  fixedVersion(context) {
    return `<div class="release-build-version"><strong>${escape(context.project_name)}</strong><span>${escape(context.branch_id)} <span aria-hidden="true">·</span> <code title="${escape(context.source_revision)}">${escape(short(context.source_revision))}</code></span></div>`;
  }

  button(label, action, {primary = false, disabled = false} = {}) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `release-build-button${primary ? ' is-primary' : ''}`;
    button.textContent = label; button.disabled = disabled; button.onclick = action;
    this.footer.append(button); return button;
  }

  render() {
    const view = this.view; if (!view) return;
    if (view.type === 'loading' && this.targetsLoaded) view.type = 'configure';
    this.footer.replaceChildren();
    const title = this.dialog.querySelector('#releaseBuildTitle');
    if (view.type === 'history') { title.textContent = '导出与打包记录'; this.renderHistory(); return; }
    if (view.type === 'loading') {
      title.textContent = '打包应用';
      this.body.innerHTML = `${this.fixedVersion(view.context)}<p>${this.error ? escape(this.error) : '正在读取后台可用平台…'}</p>`;
      this.button('关闭', () => this.close());
      if (this.error) this.button('重新读取', () => this.refresh(), {primary:true});
      return;
    }
    if (view.type === 'configure') { title.textContent = '打包应用'; this.renderConfiguration(); return; }
    const source = view.type === 'source';
    title.textContent = source ? '确认导出 Godot 工程' : '确认打包应用';
    const scene = view.context.resources?.find(resource => resource.id === view.entrySceneId);
    this.body.innerHTML = `${this.fixedVersion(view.context)}<p class="release-build-lead">${source ? '将这个固定版本导出为可下载的 Godot 工程。' : '将这个固定版本交给后台，生成以下应用。'}</p>${source ? '<div class="release-build-summary"><strong>Godot 工程 · ZIP</strong><span>包含场景、预制件、模型资产和运行脚本。</span></div>' : `<div class="release-build-summary"><strong>${view.targetIds.map(id => escape(this.targets.find(target => target.id === id)?.label || targetLabels[id] || id)).join(' / ')}</strong><span>入口场景：${escape(scene?.name || view.entrySceneId)}</span></div>`}<p class="release-build-note">${source ? '完成后下载到本机。' : '应用包完成后下载；Web 版本在新页面打开。'}任务在后台继续，关闭窗口后可从顶部查看进度。</p><p class="release-build-fixed-note">使用上方已固定的源版本；后续协作编辑会进入新的版本。</p><p class="release-build-error" role="alert">${escape(view.error)}</p>`;
    this.button(source ? '取消' : '返回选择', () => { if (source) this.close(); else { view.type = 'configure'; view.error = ''; this.render(); } }, {disabled:this.submitting});
    const pendingUncertain = !!view.uncertain;
    this.button(this.submitting ? '正在提交…' : pendingUncertain ? '核对原任务' : source ? '确认导出' : '确认打包', () => this.submit(), {primary:true, disabled:this.submitting || !canBuild(this.context)});
  }

  renderConfiguration() {
    const view = this.view, scenes = (view.context.resources ?? []).filter(resource => resource.kind === 'scene' && resource.purpose !== 'prefab_test');
    this.body.innerHTML = `${this.fixedVersion(view.context)}<div class="release-build-section-heading"><strong>选择平台</strong><button type="button" class="release-build-link" id="releaseSelectAvailable">全部可用平台</button></div><div class="release-target-grid">${this.targets.map(target => `<label class="release-target ${target.available ? '' : 'is-unavailable'}"><input type="checkbox" value="${escape(target.id)}" ${target.available ? '' : 'disabled'} ${view.targetIds.includes(target.id) ? 'checked' : ''}><span><strong>${escape(target.label || targetLabels[target.id] || target.id)}</strong><small>${escape(target.available ? target.description || (target.id === 'web' ? '在新页面打开' : '下载应用包') : target.reason || '当前后台尚未配置此平台')}</small></span></label>`).join('')}</div><label class="release-entry-scene">入口场景<select id="releaseEntryScene">${scenes.map(scene => `<option value="${escape(scene.id)}" ${view.entrySceneId === scene.id ? 'selected' : ''}>${escape(scene.name || scene.id)}</option>`).join('')}</select></label>${!scenes.length ? '<p class="release-build-error">当前版本还没有可用场景，请先创建场景。</p>' : ''}<p class="release-build-note">Web 在新页面运行这个出包版本，其他平台提供下载。</p><p class="release-build-error" role="alert">${escape(view.error)}</p>`;
    const selected = () => { view.targetIds = [...this.body.querySelectorAll('.release-target input:checked')].map(input => input.value); next.disabled = !view.targetIds.length || !scenes.length; };
    this.body.querySelectorAll('.release-target input').forEach(input => input.onchange = selected);
    this.body.querySelector('#releaseEntryScene').onchange = event => { view.entrySceneId = event.target.value; };
    this.body.querySelector('#releaseSelectAvailable').onclick = () => { this.body.querySelectorAll('.release-target input:not(:disabled)').forEach(input => input.checked = true); selected(); };
    this.button('取消', () => this.close());
    const next = this.button('下一步：确认打包', () => { view.type = 'confirmation'; view.error = ''; this.render(); }, {primary:true, disabled:!view.targetIds.length || !scenes.length});
  }

  async submit() {
    const view = this.view;
    if (!view || this.submitting || !canBuild(this.context) || this.key !== scopeKey(view.context)) return;
    const generation = this.generation;
    view.requestId ??= randomUUID(); this.submitting = true; view.error = ''; this.render();
    try {
      const result = await this.request(this.route(view.context), {method:'POST', body:{kind:view.type === 'source' ? 'source' : 'application', targets:view.type === 'source' ? [] : view.targetIds, source_revision:view.context.source_revision, entry_scene_id:view.entrySceneId || null, request_id:view.requestId, confirmed:true}});
      if (!this.current(generation)) return;
      const job = result.job;
      if (!job || job.project_id !== view.context.project_id || job.branch_id !== view.context.branch_id) throw Object.assign(new Error('后台任务归属不匹配，请刷新任务记录核对'), {uncertain:true});
      this.jobs = [job, ...this.jobs.filter(prior => prior.id !== job.id)];
      if (this.view === view) this.view = {type:'history', context:view.context, jobId:job.id, error:''};
      this.error = ''; this.refresh();
    } catch (error) {
      if (!this.current(generation)) return;
      view.error = error.uncertain ? '提交结果尚未确认。点击“核对原任务”查询同一次提交，避免重复出包。' : errorMessage(error);
      view.uncertain = !!error.uncertain;
      if (!error.uncertain) view.requestId = null;
    } finally {
      if (this.current(generation)) { this.submitting = false; this.renderTopbar(); this.render(); this.schedule(); }
    }
  }

  renderHistory() {
    const currentJob = this.view.jobId;
    const activeElement = this.dialog.contains(document.activeElement) ? document.activeElement : null;
    const focusedArtifact = activeElement?.dataset.releaseDownload || activeElement?.dataset.releaseOpen;
    const openDetails = new Set([...this.body.querySelectorAll('.release-job details[open]')].map(details => details.closest('[data-release-job]')?.dataset.releaseJob));
    const scrollTop = this.body.scrollTop;
    const jobs = [...this.jobs].sort((a, b) => Number(b.id === currentJob) - Number(a.id === currentJob) || Number(b.created_at) - Number(a.created_at));
    this.body.innerHTML = `${this.fixedVersion(this.view.context)}${this.releaseSummaryMarkup()}<p class="release-build-note">任务由后台保存，关闭窗口或刷新工作台后仍可在这里查看。</p>${this.error ? `<p class="release-build-error" role="alert">进度暂未更新：${escape(this.error)}</p>` : ''}<div class="release-job-list">${jobs.length ? jobs.map(job => this.jobMarkup(job)).join('') : `<p class="release-build-empty">${this.pending ? '正在读取任务…' : '当前分支还没有导出或打包记录。'}</p>`}</div>`;
    this.body.querySelectorAll('[data-release-download]').forEach(button => button.onclick = () => this.downloadArtifact(button.dataset.job, button.dataset.releaseDownload));
    this.body.querySelectorAll('[data-release-open]').forEach(button => button.onclick = () => this.openWeb(button.dataset.job, button.dataset.releaseOpen));
    this.body.querySelectorAll('[data-release-publish]').forEach(button => button.onclick = () => this.publishWeb(button.dataset.releasePublish));
    this.body.querySelectorAll('.release-job details').forEach(details => { details.open = openDetails.has(details.closest('[data-release-job]')?.dataset.releaseJob); });
    this.body.scrollTop = scrollTop;
    if (focusedArtifact) [...this.body.querySelectorAll('[data-release-download],[data-release-open]')].find(button => (button.dataset.releaseDownload || button.dataset.releaseOpen) === focusedArtifact && !button.disabled)?.focus({preventScroll:true});
    this.button('刷新状态', () => this.refresh(), {disabled:!!this.pending});
    this.button(this.jobs.some(job => !terminal.has(job.status)) ? '关闭，后台继续' : '关闭', () => this.close(), {primary:true});
  }

  jobMarkup(job) {
    const active = !terminal.has(job.status), progress = progressOf(job);
    const title = job.kind === 'source' ? 'Godot 工程' : '应用打包';
    const when = Number.isFinite(Number(job.created_at)) ? new Date(Number(job.created_at)).toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '';
    const errors = (job.target_results ?? []).filter(result => result.error);
    return `<article class="release-job ${active ? 'is-active' : ''}" data-release-job="${escape(job.id)}"><div class="release-job-heading"><strong>${title}</strong><span class="release-job-state ${escape(job.status)}">${escape(statusLabels[job.status] || job.status)}</span></div><div class="release-job-meta"><span>${escape(when)}</span><code title="${escape(job.source_revision)}">${escape(short(job.source_revision))}</code></div><div class="release-job-stage"><span>${escape(job.stage || statusLabels[job.status] || '')}</span><strong>${Math.round(progress)}%</strong></div><progress class="release-job-progress" max="100" value="${progress}" aria-label="${title}进度">${Math.round(progress)}%</progress>${job.error ? `<p class="release-build-error">${escape(typeof job.error === 'string' ? job.error : job.error.message || JSON.stringify(job.error))}</p>` : ''}${errors.length ? `<details class="release-target-errors"><summary>查看未完成平台（${errors.length}）</summary>${errors.map(result => `<p><strong>${escape(targetLabels[result.target] || result.target)}</strong> ${escape(result.error)}</p>`).join('')}</details>` : ''}<div class="release-artifacts">${(job.artifacts ?? []).map(artifact => {
      const web = artifact.target === 'web', busy = (web ? this.opening : this.downloads).has(artifact.id);
      return `<div class="release-artifact"><div><strong>${escape(artifact.label || targetLabels[artifact.target] || artifact.filename)}</strong><small>${escape(artifact.filename || '')}${artifact.size ? ` · ${bytes(artifact.size)}` : ''}</small></div><button type="button" class="release-build-button" data-job="${escape(job.id)}" ${web ? 'data-release-open' : 'data-release-download'}="${escape(artifact.id)}" ${busy || this.readDenied ? 'disabled' : ''}>${busy ? web ? '正在打开…' : '准备下载…' : web ? '新页面打开 Web ↗' : '下载'}</button></div>`;
    }).join('')}</div>${this.publishMarkup(job)}${this.clientErrors.has(job.id) ? `<p class="release-build-error" role="alert">${escape(this.clientErrors.get(job.id))}</p>` : ''}</article>`;
  }

  releaseSummaryMarkup() {
    if (this.releaseError) return `<p class="release-build-error" role="alert">试玩发行状态暂不可用：${escape(this.releaseError)}</p>`;
    if (!this.releaseState?.native_source && !this.releaseState?.pointers?.length) return '';
    const current = (this.releaseState.pointers ?? []).map(pointer => this.releaseState.releases?.find(release => release.id === pointer.release_id)).filter(Boolean);
    return `<div class="release-build-note"><strong>当前试玩发行</strong>${current.length ? current.map(release => `<p>${escape(release.entry_scene_name || release.entry_scene_id)} · ${escape(short(release.source_revision))} · ${escape(short(release.build_id))}</p>`).join('') : '<p>尚未发布试玩版本。</p>'}<p>构建完成后，点击“发布试玩版本”才会向试玩用户开放。源稿修改不会自动替换已发布版本。</p></div>`;
  }

  publishMarkup(job) {
    if (!canBuild(this.context) || job.status !== 'completed' || job.purpose === 'native_preview' || !this.releaseState?.can_publish || !this.releaseState.publishable_build_ids?.includes(job.id)) return '';
    const pointer = this.releaseState.pointers?.find(pointer => pointer.entry_scene_id === job.entry_scene_id);
    const release = this.releaseState.releases?.find(release => release.id === pointer?.release_id);
    const current = release?.build_id === job.id, busy = this.publishing?.has(job.id);
    return `<div class="release-artifact"><div><strong>${current ? '当前试玩版本' : '向试玩用户发布此固定版本'}</strong><small>${escape(job.entry_scene_id)} · ${escape(short(job.source_revision))}</small></div><button type="button" class="release-build-button" data-release-publish="${escape(job.id)}" ${current || busy || this.readDenied || this.releaseError ? 'disabled' : ''}>${current ? '已发布为当前试玩版本' : busy ? '正在发布…' : '发布试玩版本'}</button></div>`;
  }

  async publishWeb(jobId) {
    const job = this.jobs.find(job => job.id === jobId);
    if (!job || job.status !== 'completed' || job.purpose === 'native_preview' || !canBuild(this.context) || !this.releaseState?.can_publish || !this.releaseState.publishable_build_ids?.includes(jobId) || this.publishing.has(jobId) || this.readDenied || this.releaseError) return;
    const context = structuredClone(this.context), generation = this.generation;
    const pointer = this.releaseState.pointers?.find(pointer => pointer.entry_scene_id === job.entry_scene_id);
    const existing = this.publishRequests.get(jobId);
    const input = existing || {request_id:randomUUID(), build_id:job.id, source_revision:job.source_revision, entry_scene_id:job.entry_scene_id, expected_pointer_version:pointer?.version ?? null};
    this.publishRequests.set(jobId, input); this.publishing.add(jobId); this.clientErrors.delete(jobId); this.render();
    try {
      const result = await this.request(this.releaseRoute(context), {method:'POST', body:input});
      if (!this.current(generation)) return;
      if (result.release?.project_id !== context.project_id || result.release?.branch_id !== context.branch_id || result.release?.build_id !== jobId || result.release?.source_revision !== job.source_revision || result.release?.entry_scene_id !== job.entry_scene_id) throw Object.assign(new Error('发行结果尚未确认，请重试核对同一次发布'), {uncertain:true});
      this.publishRequests.delete(jobId);
      await this.pending;
      if (this.current(generation)) await this.refresh();
    } catch (error) {
      if (!this.current(generation)) return;
      this.clientErrors.set(jobId, Number.isInteger(error.status) ? errorMessage(error) : '发行结果尚未确认，请重试核对同一次发布：' + errorMessage(error));
      if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) this.publishRequests.delete(jobId);
      if (error.status === 409) await this.refresh();
    } finally { if (this.current(generation)) { this.publishing.delete(jobId); this.render(); } }
  }

  async downloadArtifact(jobId, artifactId) {
    const job = this.jobs.find(value => value.id === jobId), artifact = job?.artifacts?.find(value => value.id === artifactId);
    if (!artifact || this.downloads.has(artifactId) || this.readDenied) return;
    const generation = this.generation; this.downloads.add(artifactId); this.clientErrors.delete(jobId); this.render();
    try {
      const url = new URL(artifact.download_url, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/creation-api/builds/')) throw new Error('下载地址与当前后台不一致');
      const result = await this.download(url.pathname.slice('/creation-api/'.length) + url.search);
      if (!this.current(generation)) return;
      const objectUrl = URL.createObjectURL(result.blob), anchor = document.createElement('a');
      anchor.href = objectUrl; anchor.download = artifact.filename || `${jobId}.zip`; document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (error) { if (this.current(generation)) this.clientErrors.set(jobId, errorMessage(error)); }
    finally { if (this.current(generation)) { this.downloads.delete(artifactId); this.render(); } }
  }

  async openWeb(jobId, artifactId) {
    const job = this.jobs.find(value => value.id === jobId), artifact = job?.artifacts?.find(value => value.id === artifactId);
    if (!artifact || this.opening.has(artifactId) || this.readDenied) return;
    if (globalThis.isSecureContext === false && location.protocol === 'http:' && !compatibleWeb(job)) {
      this.clientErrors.set(jobId, canBuild(this.context) ? '此旧 Web 包不支持局域网 HTTP。请从预览窗口点击“新页面游玩”，自动生成兼容版本。' : '此旧 Web 包不支持局域网 HTTP。请选择新版 Web 包，或请游戏编辑者生成兼容版本。'); this.render(); return;
    }
    const popup = window.open('about:blank', '_blank');
    if (!popup) { this.clientErrors.set(jobId, '浏览器拦截了新页面，请允许此站点打开弹出式窗口后重试。'); this.render(); return; }
    popup.opener = null; popup.document.title = '正在打开 Web 出包版本';
    popup.document.body.textContent = '正在核对这个出包版本的访问权限…';
    const generation = this.generation; this.opening.add(artifactId); this.clientErrors.delete(jobId); this.render();
    try {
      await this.navigateWeb(popup, jobId, generation);
    } catch (error) { popup.close(); if (this.current(generation)) this.clientErrors.set(jobId, errorMessage(error)); }
    finally { if (this.current(generation)) { this.opening.delete(artifactId); this.render(); } }
  }

  async navigateWeb(popup, jobId, generation) {
    const result = await this.request(`builds/${encodeURIComponent(jobId)}/access`, {method:'POST', body:{}});
    if (!this.current(generation) || popup.closed) { popup.close(); return; }
    const url = new URL(result.web_url, location.origin);
    if (!result.web_url || url.origin !== location.origin || !url.pathname.startsWith(`/creation-releases/${encodeURIComponent(jobId)}/web/`)) throw new Error('Web 版本地址与当前后台不一致');
    popup.location.replace(url.href);
  }

  cancelWebPreview() {
    const preview = this.webPreview; this.webPreview = null;
    preview?.controller?.abort();
    if (preview && !preview.popup.closed) preview.popup.close();
  }

  async playWeb(entrySceneId, trigger) {
    if (!this.key || this.readDenied || !this.context.source_revision) return;
    const context = structuredClone(this.context);
    const scene = context.resources?.find(resource => resource.id === entrySceneId && resource.kind === 'scene' && resource.purpose !== 'prefab_test');
    if (!scene) return;
    if (this.webPreview && !this.webPreview.popup.closed) { this.open('history', trigger); return; }
    const popup = window.open('about:blank', '_blank');
    this.open('history', trigger);
    if (!popup) { this.error = '浏览器拦截了新页面，请允许此站点打开弹出式窗口后重试。'; this.renderTopbar(); this.render(); return; }
    popup.opener = null; popup.document.title = `${scene.name} · 正在准备 Web 游玩`;
    const preview = this.webPreview = {popup, context, entrySceneId, generation:this.generation, requestId:randomUUID(), jobId:null, opening:true, controller:new AbortController()};
    popup.document.body.textContent = '正在准备固定的 Godot 游戏工程…';
    const alive = () => this.current(preview.generation) && this.webPreview === preview && !popup.closed;
    try {
      const native = context.schema === 'creation-native-1';
      if (!canBuild(context) && !(native && context.role === 'viewer')) {
        const usePublishedDefault = native && context.role === 'player' && entrySceneId === context.entry_scene_id;
        const playable = await this.request(`projects/${encodeURIComponent(context.project_id)}/branches/${encodeURIComponent(context.branch_id)}/playable-game${usePublishedDefault ? '' : '?resource_id=' + encodeURIComponent(entrySceneId)}`, {signal:preview.controller.signal});
        context.source_revision = playable.source_revision;
        entrySceneId = playable.resource_id ?? entrySceneId;
      }
      const result = await prepareGamePlay({request:this.request, projectId:context.project_id, branchId:context.branch_id, revision:context.source_revision, entrySceneId, requestId:preview.requestId, signal:preview.controller.signal, onProgress:job=>{
        if (!alive()) { preview.controller.abort(); return; }
        this.jobs = [job, ...this.jobs.filter(prior=>prior.id !== job.id)]; preview.jobId = job.id;
        if (this.view?.type === 'history') { this.view.context = context; this.view.jobId = job.id; }
        popup.document.body.textContent = `${context.project_name} / ${context.branch_id} / ${scene.name}\n固定源版本 ${context.source_revision}\n${job.stage || statusLabels[job.status]} · ${Math.round(progressOf(job))}%`;
        this.renderTopbar(); this.render(); this.schedule();
      }});
      if (!alive()) return;
      popup.location.replace(result.url); this.webPreview = null;
    } catch (error) {
      if (!alive()) return;
      this.cancelWebPreview(); this.error = errorMessage(error); this.renderTopbar(); this.render();
    }
  }

  updateWebPreview() {
    const preview = this.webPreview;
    if (!preview || preview.opening) return;
    if (!this.current(preview.generation) || preview.popup.closed || this.readDenied) { this.cancelWebPreview(); return; }
    const job = this.jobs.find(job => job.id === preview.jobId);
    if (!job) return;
    const artifact = job.artifacts?.find(artifact => artifact.target === 'web');
    if (!terminal.has(job.status)) {
      preview.popup.document.body.textContent = `${preview.context.project_name} / ${preview.context.branch_id}\n固定源版本 ${preview.context.source_revision}\n${job.stage || statusLabels[job.status]} · ${Math.round(progressOf(job))}%\n完成后自动游玩。关闭此页后，仍可从工作台的出包记录打开。`;
      return;
    }
    if (!artifact) {
      this.clientErrors.set(job.id, job.error?.message || job.error || 'Web 构建未完成，请查看平台错误后重试。');
      this.cancelWebPreview(); this.render(); return;
    }
    if (!compatibleWeb(job)) {
      this.clientErrors.set(job.id, 'Web 包尚未通过局域网兼容检查，请重新点击“新页面游玩”生成兼容版本。');
      this.cancelWebPreview(); this.render(); return;
    }
    preview.opening = true;
    this.navigateWeb(preview.popup, job.id, preview.generation).catch(error => {
      if (this.webPreview === preview) { preview.popup.close(); this.clientErrors.set(job.id, errorMessage(error)); this.render(); }
    }).finally(() => { if (this.webPreview === preview) this.webPreview = null; });
  }

  dispose() {
    this.cancelWebPreview();
    this.disposed = true; this.generation++; this.controller?.abort(); clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.visibilityListener);
    this.dialog.remove(); this.actions.hidden = true;
  }
}
