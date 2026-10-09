import { randomUUID, bindDialogDismiss } from './client-platform.js';
import { GamePlay, prepareGamePlay } from './game-play.js';
import { mountAnimationTimeline } from './animation-timeline.js';

const element = (tag, className, text) => {
  const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
};
const copy = value => value == null ? value : structuredClone(value);
const display = value => typeof value === 'string' ? value : JSON.stringify(value);
const short = value => String(value ?? '').slice(0, 8);

/** Generic native prefab preview, with authored capability test scenes available explicitly. */
export function mountPrefabLab(host, {getContext = () => ({}), onCreate = () => {}, onRequest = () => {}, onOpenSource = () => {}, onClose = () => {}, onError = () => {}, request} = {}) {
  let context = null, scenario = null, runtime = null, generation = 0, disposed = false, observed = null, status = 'idle', error = '', receivedAt = null, actionKey = '', record = null;
  const pending = new Map();
  let recognition = null;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const root = element('section', 'prefab-lab'); root.hidden = true; root.setAttribute('aria-label', '预制件能力预览');
  let activeTab = 'animation', utility = null;
  const heading = element('header', 'prefab-lab-heading');
  const closeButton = button('返回编辑', () => { close(); onClose(); }, 'prefab-lab-back');
  const titleBox = element('div', 'prefab-lab-title'), title = element('strong', '', '能力预览'), subtitle = element('small', '', '能力预览'); titleBox.append(title, subtitle);
  const scenePicker = element('select', 'prefab-lab-scene-picker'); scenePicker.setAttribute('aria-label', '测试场景');
  scenePicker.addEventListener('change', () => { const next = availableScenarios().find(item => item.id === scenePicker.value); if (next) void start(next); });
  const manageButton = button('管理', () => openUtility('library'), 'prefab-lab-text-button'); manageButton.setAttribute('aria-label', '管理测试场景');
  const headingTools = element('div', 'prefab-lab-heading-tools');
  const sceneToolsButton = button('场景工具', () => openUtility('scene'));
  const recordsButton = button('测试记录', () => openUtility('records'));
  const requestButton = button('提需求', () => openUtility('request'), 'prefab-lab-request-entry');
  headingTools.append(sceneToolsButton, recordsButton, requestButton);
  heading.append(closeButton, titleBox, scenePicker, manageButton, headingTools);
  const body = element('div', 'prefab-lab-body');
  const center = element('div', 'prefab-lab-center');
  const viewport = element('div', 'prefab-lab-viewport');
  const runtimeHost = element('div', 'prefab-lab-runtime godot-preview');
  const viewportEmpty = element('div', 'prefab-lab-viewport-empty');
  const viewportEmptyTitle = element('strong', '', '让预制件动起来'), viewportEmptyDescription = element('p', '', '为这个对象创建独立舞台，连接它的动画与主动能力。');
  const emptyCreate = button('创建测试场景', () => create()); viewportEmpty.append(viewportEmptyTitle, viewportEmptyDescription, emptyCreate);
  const viewportCaption = element('div', 'prefab-lab-viewport-caption');
  const actionFeedback = element('div', 'prefab-lab-action-feedback'); actionFeedback.setAttribute('role', 'status');
  viewport.append(runtimeHost, viewportEmpty, viewportCaption, actionFeedback);
  const toolbar = element('div', 'prefab-lab-toolbar'), runState = element('span', 'prefab-lab-run-state', '选择测试场景'); runState.setAttribute('role', 'status');
  const controls = element('div', 'prefab-lab-run-controls');
  const toggle = button('运行', () => { if (!runtime || status === 'failed') void start(scenario); else command({action:observed?.paused ? 'resume' : 'pause'}); });
  const step = button('单帧', () => command({action:'step'})); step.title = '暂停后推进一帧';
  const reset = button('重置', () => void start(scenario)); reset.title = '从测试场景初始状态重新运行';
  const stopButton = button('停止', () => stop());
  const runtimeSpeed = element('select', 'prefab-lab-runtime-speed'); runtimeSpeed.setAttribute('aria-label', '测试运行速度'); runtimeSpeed.title = '场景运行速度';
  for (const value of [.25, .5, 1, 2]) { const item = element('option', '', `${value}×`); item.value = String(value); runtimeSpeed.append(item); }
  runtimeSpeed.value = '1'; runtimeSpeed.addEventListener('change', () => command({action:'speed', speed:Number(runtimeSpeed.value)}));
  controls.append(toggle, step, runtimeSpeed, reset, stopButton); toolbar.append(runState, controls);
  const timelineHost = element('div', 'prefab-lab-timeline'); timelineHost.hidden = true;
  center.append(viewport, toolbar, timelineHost);
  const inspector = element('aside', 'prefab-lab-inspector'); inspector.setAttribute('aria-label', '对象主动行为');
  const subjectHead = element('div', 'prefab-lab-subject-head'), subjectStatus = element('span', 'prefab-lab-subject-status');
  subjectHead.append(element('strong', '', '对象行为'), subjectStatus);
  const tabs = element('div', 'prefab-lab-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '主动行为分类');
  const tabButtons = new Map();
  for (const [key, label] of [['animation', '动画'], ['ability', '技能'], ['state', '状态']]) {
    const tab = button(label, () => selectTab(key)); tab.setAttribute('role', 'tab'); tab.dataset.kind = key; tab.setAttribute('aria-label', label); tabButtons.set(key, tab); tabs.append(tab);
  }
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const keys = [...tabButtons.keys()], index = keys.indexOf(activeTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    selectTab(keys[next]); tabButtons.get(keys[next]).focus();
  });
  const actions = element('div', 'prefab-lab-actions'); actions.setAttribute('role', 'tabpanel');
  const controllers = element('div', 'prefab-lab-controllers'); controllers.setAttribute('aria-label', '对象控制器');
  const inspectorFoot = element('div', 'prefab-lab-inspector-foot'); inspectorFoot.append(button('完善对象行为', () => { prompt.value = '完善这个预制件自身的动画、技能、状态和控制器。将靶子与受伤等外部测试单独放入场景工具。'; openUtility('request'); }, 'prefab-lab-text-button'));
  inspector.append(subjectHead, tabs, actions, controllers, inspectorFoot);
  body.append(center, inspector); root.append(heading, body); host.append(root);

  // Auxiliary tools are explicit, temporary surfaces. They never pause the running scene.
  const dialog = element('dialog', 'prefab-lab-dialog'); dialog.setAttribute('aria-label', '预览辅助工具');
  const dialogHead = element('header', 'prefab-lab-dialog-head'), dialogTitle = element('strong');
  const dialogClose = button('×', () => dialog.close(), 'prefab-lab-dialog-close'); dialogClose.setAttribute('aria-label', '关闭辅助面板'); dialogClose.title = '关闭 · Esc';
  dialogHead.append(dialogTitle, dialogClose);
  const dialogBody = element('div', 'prefab-lab-dialog-body'), utilityFeedback = element('div', 'prefab-lab-utility-feedback'); utilityFeedback.setAttribute('role', 'status'); dialog.append(dialogHead, dialogBody, utilityFeedback); root.append(dialog);
  let dialogFocus = null;
  bindDialogDismiss(dialog, () => dialog.close());
  dialog.addEventListener('close', () => { utility = null; stopSpeech(); if (dialogFocus?.isConnected && dialogFocus.getClientRects().length) dialogFocus.focus({preventScroll:true}); });
  const library = element('section', 'prefab-lab-library'); library.setAttribute('aria-label', '测试场景管理');
  const libraryHead = element('div', 'prefab-lab-section-head'), sceneCount = element('small'); libraryHead.append(element('strong', '', '这个对象的测试场景'), sceneCount);
  const scenarioList = element('div', 'prefab-lab-scenarios');
  const createButton = button('＋ 创建测试场景', () => { dialog.close(); create(); }, 'prefab-lab-create');
  const sourceButton = button('打开测试场景', () => { if (scenario) { dialog.close(); onOpenSource({scenario:copy(scenario), subject:copy(context?.subject), context:copy(context)}); } });
  const description = element('p', 'prefab-lab-description');
  library.append(libraryHead, scenarioList, createButton, sourceButton, description, element('small', 'prefab-lab-package-note', '动画预览通用场景自动加载目标预制件。另建的测试场景随源工程保存，最终游戏包会排除。'));
  const sceneTools = element('section', 'prefab-lab-scene-tools'); sceneTools.append(element('p', 'prefab-lab-utility-note', '布置靶子或施加外部影响，再回到对象行为检查效果。'));
  const externalActions = element('div', 'prefab-lab-external-actions'); sceneTools.append(externalActions);
  const records = element('section', 'prefab-lab-records');
  const observations = element('div', 'prefab-lab-observations');
  const eventsHeader = element('div', 'prefab-lab-section-head'); eventsHeader.append(element('strong', '', '最近事件'));
  const exportButton = button('导出', exportEvidence, 'prefab-lab-text-button'); exportButton.title = '导出本次运行的状态、事件与身份'; eventsHeader.append(exportButton);
  const events = element('ol', 'prefab-lab-events'), identity = element('div', 'prefab-lab-identity'); identity.title = '本次运行固定的源版本和构建';
  records.append(observations, eventsHeader, events, identity);
  const compose = element('form', 'prefab-lab-compose'), prompt = element('textarea'); prompt.rows = 5; prompt.placeholder = '描述想看的动作、状态，或你发现的问题…'; prompt.setAttribute('aria-label', '向 Agent 描述测试需求');
  const suggestions = element('div', 'prefab-lab-suggestions');
  for (const [label, text] of [['动画', '整理这个预制件现有的动画与程序动作，提供逐个播放的入口；真实动画片段可以在时间轴检查姿态。'], ['技能', '连接这个预制件的主动技能，点击后呈现真实效果，并明确它依赖的场景条件。'], ['状态', '列出这个预制件自身可切换的状态和控制器；把外部伤害与测试靶子单独放入场景工具。']]) suggestions.append(button(label, () => { prompt.value = text; prompt.focus(); }));
  const speechRow = element('div', 'prefab-lab-speech'), speechHint = element('small', '', SpeechRecognition ? '口述后可修改，再交给 Agent' : '可使用系统听写输入需求');
  const speechButton = button('口述', toggleSpeech, 'prefab-lab-speech-button'); speechButton.hidden = !SpeechRecognition; speechButton.setAttribute('aria-pressed', 'false');
  speechRow.append(speechButton, speechHint); speechHint.setAttribute('role', 'status');
  const submit = element('button', 'prefab-lab-request', '交给 Agent'); submit.type = 'submit';
  compose.append(element('p', 'prefab-lab-utility-note', '当前对象与这次运行观察会一并带入新的 Agent 会话。'), prompt, suggestions, speechRow, submit);
  compose.addEventListener('submit', event => { event.preventDefault(); if (prompt.value.trim()) { dialog.close(); handoff(prompt.value.trim()); } else prompt.focus(); });
  const panels = {library, scene:sceneTools, records, request:compose};
  for (const panel of Object.values(panels)) { panel.hidden = true; dialogBody.append(panel); }
  const timeline = mountAnimationTimeline(timelineHost, {onCommand:command, onRequest:() => { prompt.value = '为当前预制件暴露全部原生动画，提供播放、暂停和姿态定位。'; openUtility('request'); }});

  function selectTab(key) { activeTab = key; render(); }
  function openUtility(key) {
    utility = key; utilityFeedback.textContent = ''; dialogTitle.textContent = {library:'测试场景', scene:'场景工具', records:'测试记录', request:'向 Agent 提需求'}[key];
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== key;
    render(); if (!dialog.open) { dialogFocus = document.activeElement; dialog.showModal(); } if (key === 'request') prompt.focus();
  }
  function button(label, action, className = '') { const node = element('button', `prefab-lab-button ${className}`.trim(), label); node.type = 'button'; node.addEventListener('click', action); return node; }
  function stopSpeech() {
    const active = recognition; recognition = null;
    if (active) { active.onstart = active.onresult = active.onerror = active.onend = null; try { active.abort(); } catch {} }
    speechButton.textContent = '口述'; speechButton.setAttribute('aria-pressed', 'false'); speechHint.textContent = SpeechRecognition ? '口述后可修改，再交给 Agent' : '可使用系统听写输入需求';
  }
  function toggleSpeech() {
    if (!SpeechRecognition || !canWrite()) return;
    if (recognition) { try { recognition.stop(); } catch { stopSpeech(); } return; }
    let active;
    try { active = new SpeechRecognition(); } catch { speechHint.textContent = '听写未能启动，可使用系统听写'; return; }
    recognition = active; active.lang = 'zh-CN'; active.continuous = true; active.interimResults = true;
    const prefix = prompt.value.trim();
    active.onstart = () => { if (recognition !== active) return; speechButton.textContent = '结束口述'; speechButton.setAttribute('aria-pressed', 'true'); speechHint.textContent = '正在听写，不会自动发送'; };
    active.onresult = event => {
      if (recognition !== active || disposed) return;
      const transcript = Array.from(event.results, result => result[0]?.transcript ?? '').join('');
      prompt.value = `${prefix}${prefix && transcript ? '\n' : ''}${transcript}`;
    };
    active.onerror = event => { if (recognition !== active) return; speechHint.textContent = ['not-allowed', 'service-not-allowed'].includes(event.error) ? '未获得麦克风或听写权限，可使用系统听写' : event.error === 'no-speech' ? '没有听到语音，可再次口述' : '听写已中断，可编辑文字继续'; };
    active.onend = () => { if (recognition !== active) return; recognition = null; speechButton.textContent = '口述'; speechButton.setAttribute('aria-pressed', 'false'); if (speechHint.textContent === '正在听写，不会自动发送') speechHint.textContent = '听写已结束，请检查文字后发送'; active.onstart = active.onresult = active.onerror = active.onend = null; };
    speechHint.textContent = '正在请求听写…';
    try { active.start(); } catch { stopSpeech(); speechHint.textContent = '听写未能启动，可使用系统听写'; }
  }
  function canWrite() { const current = getContext() ?? {}; return current.canWrite !== false && current.can_write !== false && !['viewer', 'player'].includes(current.role); }
  function availableScenarios() {
    const authored = context?.scenarios ?? [];
    return context?.subject?.id ? [{id:context.subject.id, name:'通用动画预览', automatic:true, description:'将当前预制件放入通用 Godot 场景，自动提供动画列表和时间轴。'}, ...authored] : authored;
  }
  function scope() { return {project_id:context?.projectId, branch_id:context?.branchId, source_revision:context?.revision, scenario_id:scenario?.id, subject_id:context?.subject?.id}; }
  function evidence() { return {...copy(record ?? scope()), captured_at:new Date().toISOString(), last_observed_at:receivedAt, status, error:error || null, state:copy(observed)}; }
  function handoff(text) { stopSpeech(); onRequest({text, scenario:copy(scenario), subject:copy(context?.subject), evidence:evidence()}); }
  function create() { if (!context || !canWrite()) return; stopSpeech(); onCreate({subject:copy(context.subject), text:prompt.value.trim(), context:copy(context)}); }
  function exportEvidence() {
    if (!observed) return;
    const blob = new Blob([JSON.stringify(evidence(), null, 2)], {type:'application/json'}), url = URL.createObjectURL(blob), anchor = element('a');
    anchor.href = url; anchor.download = `prefab-test-${scenario?.id ?? 'scene'}-${short(record?.run_id)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function renderLibrary() {
    const scenarios = availableScenarios(); sceneCount.textContent = String(scenarios.length); scenarioList.replaceChildren(); scenePicker.replaceChildren();
    if (!scenarios.length) { scenarioList.append(element('p', 'prefab-lab-empty-list', '此预制件还没有测试场景。')); const option = element('option', '', '尚无测试场景'); option.value = ''; scenePicker.append(option); }
    for (const item of scenarios) {
      const option = element('option', '', item.name || item.id); option.value = item.id; scenePicker.append(option);
      const row = button('', () => { dialog.close(); void start(item); }, 'prefab-lab-scenario'); row.setAttribute('aria-pressed', String(item.id === scenario?.id));
      row.append(element('strong', '', item.name || item.id), element('small', '', item.description || '独立运行，检查真实效果')); scenarioList.append(row);
    }
    scenePicker.value = scenario?.id ?? ''; scenePicker.disabled = !scenarios.length;
    createButton.disabled = !canWrite(); emptyCreate.disabled = !canWrite(); submit.disabled = !canWrite(); speechButton.disabled = !canWrite(); requestButton.disabled = !canWrite(); if (!canWrite() && recognition) stopSpeech();
  }
  const subjectAction = action => action.scope === 'subject' && ['animation', 'ability', 'state', 'controller'].includes(action.kind);
  function renderActions() {
    const rows = (Array.isArray(observed?.actions) ? observed.actions : []).filter(row => row && typeof row.id === 'string');
    const clips = (Array.isArray(observed?.animations) ? observed.animations : []).filter(row => row && typeof row.name === 'string');
    const selectedIds = observed?.selection?.action_ids ?? [], blocked = observed?.selection?.blocked_actions ?? {};
    const nextKey = JSON.stringify([status, activeTab, rows, selectedIds, blocked, clips.map(({player,name,duration,loop}) => [player,name,duration,loop]), observed?.current?.player, observed?.current?.name, observed?.playing, observed?.capabilities, observed?.capture?.status, observed?.capture?.truncated, Math.floor(Number(observed?.capture?.time ?? 0) * 10)]);
    for (const [key, tab] of tabButtons) {
      const count = rows.filter(action => subjectAction(action) && action.kind === key).length + (key === 'animation' ? clips.length : 0);
      tab.textContent = {animation:'动画', ability:'技能', state:'状态'}[key]; if (count) tab.append(element('small', '', String(count)));
      tab.setAttribute('aria-selected', String(activeTab === key)); tab.tabIndex = activeTab === key ? 0 : -1;
    }
    subjectStatus.textContent = observed?.selection?.status || (status === 'running' ? '就绪' : '等待运行'); subjectStatus.title = subjectStatus.textContent;
    if (nextKey === actionKey) return; actionKey = nextKey; actions.replaceChildren(); controllers.replaceChildren(); externalActions.replaceChildren();
    actions.setAttribute('aria-label', {animation:'动画与动作演示', ability:'主动技能', state:'自身状态'}[activeTab]);
    const primary = rows.filter(action => subjectAction(action) && action.kind === activeTab);
    function actionButton(action, compact = false) {
      const reason = blocked[action.id] || (action.enabled === false ? action.disabled_reason || '当前不可用' : '');
      const node = button('', () => command({action:'action', action_id:action.id, parameters:copy(action.defaults ?? {})}), compact ? 'prefab-lab-controller-button' : 'prefab-lab-action');
      node.dataset.actionId = action.id; node.setAttribute('aria-label', action.label || action.id); node.disabled = status !== 'running' || !!reason;
      if (action.mode === 'select') node.setAttribute('aria-pressed', String(selectedIds.includes(action.id)));
      const text = element('span', 'prefab-lab-action-copy'); text.append(element('strong', '', action.label || action.id));
      if (!compact && (reason || action.description)) text.append(element('small', reason ? 'is-requirement' : '', reason || action.description));
      node.append(text);
      if (!compact) node.append(element('span', 'prefab-lab-action-type', action.mode === 'select' ? selectedIds.includes(action.id) ? '当前' : '切换' : '播放' === action.verb ? '播放' : action.kind === 'animation' ? '播放' : '执行'));
      node.title = reason || action.description || action.label || action.id; return node;
    }
    function groupActions(target, list, compact = false) {
      const groups = new Map();
      for (const action of list) { const group = !action.group || action.group === '对象行为' ? (subjectAction(action) ? {animation:'动作演示', ability:'主动技能', state:'自身状态', controller:'运行方式'}[action.kind] : action.legacy || !action.scope ? '未分类动作' : {fixture:'靶子布置', passive:'外部影响'}[action.kind] || '场景设置') : action.group; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(action); }
      for (const [label, members] of groups) {
        const group = element('div', 'prefab-lab-action-group'); group.append(element('small', 'prefab-lab-group-label', label));
        const buttons = element('div', 'prefab-lab-action-buttons'); for (const action of members) buttons.append(actionButton(action, compact)); group.append(buttons); target.append(group);
      }
    }
    if (activeTab === 'animation' && clips.length) {
      const clipGroup = element('div', 'prefab-lab-action-group'); clipGroup.append(element('small', 'prefab-lab-group-label', '动画片段 · 自动发现'));
      for (const clip of clips) {
        const player = String(clip.player ?? ''), label = clip.label || clip.name;
        const duplicate = clips.some(other => other !== clip && (other.label || other.name) === label);
        const node = button('', () => command({action:'animation', player, animation:clip.name, play:true}), 'prefab-lab-clip');
        const selected = observed?.current?.name === clip.name && String(observed?.current?.player ?? '') === String(clip.player ?? '');
        node.setAttribute('aria-pressed', String(selected)); node.setAttribute('aria-label', `播放动画 ${label}${duplicate ? ` · ${player || '默认播放器'}` : ''}`); node.disabled = status !== 'running';
        node.title = `${player || '默认播放器'} · ${label} · 点击从头播放`;
        const text = element('span', 'prefab-lab-action-copy'); text.append(element('strong', '', label));
        if (duplicate) text.append(element('small', '', player || '默认播放器'));
        node.append(text, element('small', '', `${selected ? observed?.playing ? '播放中 · ' : '已暂停 · ' : ''}${Number(clip.duration ?? clip.length ?? 0).toFixed(2)} s${clip.loop || clip.loop_mode ? ' · 循环' : ''}`)); clipGroup.append(node);
      }
      actions.append(clipGroup);
    }
    if (activeTab === 'animation' && status === 'running' && observed) {
      const capture = observed.capture;
      const recording = capture?.status === 'recording';
      const captureButton = button(recording ? `正在捕获脚本动画 · ${Number(capture.time ?? 0).toFixed(1)} / ${capture.duration} s` : '捕获脚本动画', () => command({action:'capture_animation'}), 'prefab-lab-text-button');
      captureButton.disabled = recording; actions.append(captureButton);
      if (clips.some(clip => clip.kind === 'ProceduralCapture')) actions.append(element('p', 'prefab-lab-behavior-note', '已捕获实际运行中的姿态，拖动可回放；继续运行恢复游戏逻辑。'));
      if (capture?.status === 'empty') actions.append(element('p', 'prefab-lab-behavior-note', '本次未观察到姿态变化。可先触发动作，再重新捕获；依赖外部控制器时请选择对应测试场景。'));
      if (capture?.status === 'invalidated') actions.append(element('p', 'prefab-lab-behavior-note', '对象已变化，请重新捕获。'));
      if (capture?.truncated) actions.append(element('p', 'prefab-lab-behavior-note', '对象较复杂，本次仅捕获部分节点。'));
    }
    groupActions(actions, primary);
    if (activeTab === 'animation' && primary.some(action => action.animation_kind === 'procedural')) actions.append(element('p', 'prefab-lab-behavior-note', '这些动作为实时演示，播放后会产生游戏效果。'));
    if (!primary.length && !(activeTab === 'animation' && clips.length)) {
      const empty = element('div', 'prefab-lab-empty-capabilities');
      empty.append(element('strong', '', status !== 'running' ? '准备对象行为' : activeTab === 'animation' && observed?.capture?.status === 'recording' ? '正在观察脚本驱动的动画' : {animation:'还没有可预览的动画', ability:'尚无主动技能', state:'尚无可切换状态'}[activeTab]), element('p', '', status !== 'running' ? '场景启动后显示对象实际支持的行为。' : activeTab === 'state' ? '外部受伤与生命值预设位于场景工具。' : '可以让 Agent 连接对象现有的行为。'));
      actions.append(empty);
    }
    if (primary.some(action => blocked[action.id])) { const note = element('div', 'prefab-lab-requirement'); note.append(element('span', '', '部分动作需要场景条件'), button('配置靶子', () => openUtility('scene'), 'prefab-lab-text-button')); actions.append(note); }
    const controllerRows = rows.filter(action => subjectAction(action) && action.kind === 'controller');
    controllers.hidden = !controllerRows.length; if (controllerRows.length) { controllers.append(element('strong', '', '控制器')); groupActions(controllers, controllerRows, true); }
    const external = rows.filter(action => !subjectAction(action)); groupActions(externalActions, external);
    if (!external.length) externalActions.append(element('p', 'prefab-lab-empty-capabilities', observed ? '此场景尚未提供外部测试工具。' : '运行后显示场景提供的测试工具。'));
  }
  function renderObservations() {
    const value = observed?.observations; observations.replaceChildren();
    const rows = Array.isArray(value) ? value.map((item, index) => [item.label ?? item.name ?? item.id ?? index, item.value ?? item]) : Object.entries(value ?? {});
    if (!rows.length) return;
    observations.append(element('strong', '', '运行观察'));
    for (const [key, value] of rows.slice(0, 30)) { const row = element('div', 'prefab-lab-observation'); row.append(element('span', '', String(key)), element('code', '', display(value))); observations.append(row); }
  }
  function renderEvents() {
    events.replaceChildren(); const rows = Array.isArray(observed?.events) ? observed.events : [];
    if (!rows.length) { events.append(element('li', 'prefab-lab-no-events', observed ? '还没有运行事件' : '等待场景反馈')); return; }
    for (const item of rows.slice(-12).reverse()) {
      const row = element('li');
      if (item && typeof item === 'object') { const label = String(item.label ?? item.message ?? item.name ?? item.type ?? item.kind ?? '事件'); row.append(element('span', '', label)); const time = item.tick ?? item.time ?? item.time_ms; if (time !== undefined) row.append(element('small', '', `${item.tick !== undefined ? '帧 ' : ''}${typeof time === 'number' ? String(Math.round(time * 100) / 100) : String(time)}`)); const fields = Object.fromEntries(Object.entries(item).filter(([key]) => !['sequence', 'tick', 'time', 'time_ms', 'label', 'message', 'name', 'type', 'kind', 'origin', 'source_revision', 'document_id', 'scene_generation'].includes(key))); const data = item.data ?? item.details ?? (Object.keys(fields).length ? fields : undefined); if (data !== undefined) row.append(element('code', '', display(data))); }
      else row.textContent = String(item);
      events.append(row);
    }
  }
  function render() {
    if (disposed) return;
    title.textContent = context?.subject?.name || '预制件'; subtitle.textContent = scenario?.automatic && activeTab === 'animation' ? '动画预览' : '能力预览';
    root.dataset.status = status; root.dataset.scenarioId = scenario?.id ?? ''; root.dataset.sourceRevision = context?.revision ?? '';
    const labels = {idle:scenario ? '尚未运行' : '选择测试场景', preparing:scenario?.automatic ? '准备预制件预览…' : '准备测试工程…', loading:'启动 Godot…', running:observed ? (observed.current?.name ? (observed.playing ? '动画播放中' : '动画已暂停') : observed.paused ? '已暂停' : '运行中') : '等待能力反馈…', stopped:'已停止', failed:error || '运行失败'};
    runState.textContent = (labels[status] || status) + (record?.source_revision && record.source_revision !== context?.revision ? ' · 内容已更新，重置查看' : ''); runState.title = error || '';
    toggle.textContent = !runtime || status === 'failed' ? '运行' : observed?.paused ? '继续' : '暂停';
    toggle.disabled = !scenario || ['preparing', 'loading'].includes(status) || status === 'running' && !observed;
    step.disabled = status !== 'running' || !observed?.paused; reset.disabled = !scenario; stopButton.disabled = !runtime;
    runtimeSpeed.disabled = status !== 'running' || !observed; runtimeSpeed.value = String(observed?.speed ?? 1);
    for (const control of [toggle, step, runtimeSpeed]) control.hidden = !!scenario?.automatic && activeTab === 'animation';
    reset.title = scenario?.automatic ? '重新加载目标预制件' : '从测试场景初始状态重新运行';
    viewportEmpty.hidden = !!runtime; viewportCaption.textContent = runtime && scenario ? '独立预览' : '';
    viewportEmptyTitle.textContent = status === 'failed' ? '测试场景运行失败' : scenario ? (status === 'stopped' ? '本次测试已停止' : '测试场景已准备好') : '让预制件动起来';
    viewportEmptyDescription.textContent = error || (scenario ? '点击运行，从场景初始状态开始测试。' : '为这个对象创建独立舞台，连接它的动画与主动能力。'); emptyCreate.hidden = !!scenario;
    description.textContent = scenario?.description || '动画、交互和响应都来自实际运行的预制件。'; sourceButton.hidden = !scenario || !!scenario.automatic;
    identity.textContent = context ? `源 ${short(record?.source_revision ?? context.revision)}${record?.build_id ? ` · 构建 ${short(record.build_id)}` : ''}${record?.scene_generation !== undefined ? ` · 场景 ${record.scene_generation}` : ''}${record?.source_revision && record.source_revision !== context.revision ? ' · 源已更新，重置使用新版' : ''}` : '';
    identity.title = JSON.stringify(record ?? scope(), null, 2);
    timeline.update({animations:observed?.animations ?? [], animation:observed?.current ? {...observed.current, time:observed.time, duration:observed.duration, playing:observed.playing} : null, disabled:status !== 'running' || !observed, speed:observed?.animation_speed ?? 1});
    timelineHost.hidden = activeTab !== 'animation' || !(observed?.animations?.length);
    exportButton.disabled = !observed; renderActions(); if (utility === 'records') { renderObservations(); renderEvents(); }
  }
  function command(value) {
    if (!runtime || status !== 'running' || !runtime.ready || !observed && value.action !== 'catalog') return;
    const requestId = randomUUID(); pending.set(requestId, {command:copy(value), requested_at:new Date().toISOString()});
    if (value.action !== 'catalog') { actionFeedback.textContent = '等待运行反馈…'; actionFeedback.classList.remove('is-error'); if (utility === 'scene') { utilityFeedback.textContent = '等待运行反馈…'; utilityFeedback.classList.remove('is-error'); } }
    runtime.post({type:'prefab_test', seq:runtime.commandSeq, source_revision:record.source_revision, scene_generation:runtime.sceneGeneration, document_id:runtime.sceneContext.document_id, command:{...copy(value), request_id:requestId}});
  }
  function stop(nextStatus = 'stopped') {
    generation++; pending.clear(); const previous = runtime; runtime = null; previous?.dispose(); status = nextStatus; render();
  }
  async function start(nextScenario) {
    if (disposed || !context || !nextScenario) return;
    stopSpeech(); stop('idle'); const token = generation; scenario = copy(nextScenario); observed = null; receivedAt = null; record = null; error = ''; actionKey = ''; actionFeedback.textContent = ''; status = 'preparing';
    const fixed = {projectId:context.projectId, branchId:context.branchId, revision:context.revision, entrySceneId:scenario.id};
    const runId = randomUUID(); record = {...scope(), run_id:runId, started_at:new Date().toISOString(), world_id:`prefab-test-${runId}`, epoch:1}; renderLibrary(); render();
    if (typeof request !== 'function') { status = 'failed'; error = '测试构建服务未连接'; render(); return; }
    let preview;
    try {
      preview = new GamePlay(runtimeHost, ({signal, onProgress}) => prepareGamePlay({...fixed, purpose:'prefab_test', request, signal, onProgress}), message => {
        if (disposed || generation !== token || runtime !== preview) return;
        if (message.type === 'runtime_error') { error = message.message || '测试运行失败'; status = 'failed'; render(); onError(error); return; }
        if (message.type === 'loaded') { status = 'running'; record.scene_generation = message.scene_generation; command({action:'catalog'}); render(); return; }
        if (message.type === 'prefab_test_result') {
          if (message.source_revision !== fixed.revision || message.document_id !== preview.sceneContext?.document_id || !pending.has(message.request_id)) return;
          const issued = pending.get(message.request_id); pending.delete(message.request_id);
          record.commands = [...(record.commands ?? []).slice(-99), {...issued, request_id:message.request_id, received_at:new Date().toISOString(), response:copy(message)}];
          if (issued.command.action !== 'catalog') { actionFeedback.textContent = message.ok ? `${observed?.actions?.find(action => action.id === issued.command.action_id)?.label || '操作'} · 已执行` : message.error || '动作执行失败'; actionFeedback.classList.toggle('is-error', !message.ok); if (utility === 'scene') { utilityFeedback.textContent = actionFeedback.textContent; utilityFeedback.classList.toggle('is-error', !message.ok); } }
          return;
        }
        if (message.type !== 'prefab_test_state') return;
        if (message.source_revision !== fixed.revision || message.document_id !== preview.sceneContext?.document_id || message.scene_generation !== preview.sceneGeneration) return;
        observed = copy(message); receivedAt = new Date().toISOString(); record.scene_generation = message.scene_generation; status = message.faulted ? 'failed' : 'running'; if (message.faulted) error = message.error || '测试运行发生错误'; render();
      });
      runtime = preview; preview.frame.title = `${scenario.name || '预制件'} · 能力测试`; preview.frame.setAttribute('aria-label', preview.frame.title); render();
      const job = await preview.runtimeReady;
      if (disposed || token !== generation || runtime !== preview) return;
      record = {...record, build_id:job.id, canonical_identity:job.canonical_identity, runtime_source_hash:job.runtime_source_hash, source_revision:job.source_revision}; status = 'loading'; render();
      await preview.start({document_id:`${fixed.projectId}/${fixed.branchId}/${fixed.entrySceneId}`, source_revision:fixed.revision}, {world_id:record.world_id, epoch:1, scene_revision:fixed.revision, request_id:randomUUID()});
    } catch (caught) {
      if (disposed || token !== generation || caught?.name === 'AbortError') return;
      error = caught.message || String(caught); status = 'failed'; if (runtime === preview) { runtime = null; preview?.dispose(); } render(); onError(error);
    }
  }
  function open(next) {
    if (disposed) return;
    stopSpeech(); if (dialog.open) dialog.close(); activeTab = 'animation'; stop('idle'); context = {...copy(next), scenarios:copy(next.scenarios ?? [])}; scenario = availableScenarios().find(item => item.id === next.scenarioId) ?? availableScenarios()[0] ?? null;
    observed = null; record = null; error = ''; receivedAt = null; prompt.value = ''; root.hidden = false; renderLibrary(); render();
    if (scenario && next.autoStart !== false) void start(scenario);
  }
  function refresh(next = {}) {
    if (disposed || !context) return;
    const changedScope = next.projectId && next.projectId !== context.projectId || next.branchId && next.branchId !== context.branchId;
    if (changedScope) { open({...context, ...next}); return; }
    const selectedId = scenario?.id; context = {...context, ...copy(next)};
    scenario = availableScenarios().find(item => item.id === selectedId) ?? null;
    if (!scenario && runtime) stop('idle');
    renderLibrary(); render();
  }
  function close() { if (disposed) return; stopSpeech(); if (dialog.open) dialog.close(); stop('idle'); root.hidden = true; }
  return {open, refresh, close, dispose() { if (disposed) return; close(); disposed = true; timeline.dispose(); root.remove(); }};
}
