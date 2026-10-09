const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, max) => Math.min(Math.max(0, finite(value)), Math.max(0, max));
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const option = (value, label) => { const node = el('option', '', label); node.value = value; return node; };
const seconds = value => `${Math.max(0, finite(value)).toFixed(2)} s`;

/** Read-only engine observations plus explicit commands. Scrubbing never rewinds game state. */
export function mountAnimationTimeline(host, {onCommand = () => {}, onRequest = () => {}} = {}) {
  let state = {animations:[], animation:null, disabled:true, speed:1}, disposed = false, catalogKey = '', draftTime = null, selectionIntent = null, scrubbing = false, seekFrame = null, lastSeekTime = null;
  const root = el('section', 'animation-timeline'); root.setAttribute('aria-label', '动画时间轴');
  const top = el('div', 'animation-timeline-top');
  top.append(el('strong', '', '动画时间轴'));
  const player = el('select'); player.setAttribute('aria-label', '动画播放器');
  const animation = el('select'); animation.setAttribute('aria-label', '动画');
  const loop = el('span', 'animation-loop');
  const speed = el('select', 'animation-speed'); speed.setAttribute('aria-label', '动画速度'); speed.title = '以此速度播放动画';
  for (const value of [.25, .5, 1, 2]) speed.append(option(String(value), `${value}×`));
  speed.value = '1'; top.append(player, animation, loop, speed);
  const controls = el('div', 'animation-timeline-controls');
  const button = (label, text, action) => {
    const node = el('button', 'animation-control', text); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label); node.addEventListener('click', action); return node;
  };
  const first = button('跳到动画开始', '⏮', () => { cancelScrub(); command('seek', {time:0}); });
  const play = button('播放动画', '▶', () => command(state.animation?.playing ? 'animation_pause' : 'animation_play'));
  const last = button('跳到动画结束', '⏭', () => { cancelScrub(); command('seek', {time:duration()}); });
  const time = el('input', 'animation-time'); time.type = 'number'; time.min = '0'; time.step = '.01'; time.setAttribute('aria-label', '动画时间（秒）');
  const durationText = el('span', 'animation-duration');
  const position = el('input', 'animation-scrubber'); position.type = 'range'; position.min = '0'; position.step = '.001'; position.setAttribute('aria-label', '动画播放位置');
  controls.append(first, play, last, time, durationText, position);
  const empty = el('div', 'animation-empty'); empty.append(el('span', '', '此测试场景尚未暴露动画。'));
  const request = button('请 Agent 添加动画预览', '描述动画需求', onRequest); empty.append(request);
  const foot = el('div', 'animation-timeline-note', '拖动只定位动画姿态，不会倒带战斗；重现交互请重置场景。');
  const seeking = el('span', 'animation-seeking'); seeking.setAttribute('role', 'status'); foot.append(seeking);
  root.append(top, controls, empty, foot); host.append(root);

  function entries() {
    return (Array.isArray(state.animations) ? state.animations : []).filter(item => item && typeof item.name === 'string').map(item => ({...item, player:String(item.player ?? '')}));
  }
  function selected() { return entries().find(item => item.player === player.value && item.name === animation.value) ?? null; }
  function duration() { return Math.max(0, finite(selected()?.duration ?? selected()?.length)); }
  function command(action, extra = {}) {
    if (disposed || state.disabled || !selected()) return;
    if (action !== 'seek') cancelScrub();
    onCommand({action, player:player.value, animation:animation.value, ...extra});
  }
  function populateAnimations(preferred) {
    const rows = entries().filter(item => item.player === player.value);
    animation.replaceChildren(option('', '选择动画…'), ...rows.map(item => option(item.name, item.label || item.name)));
    if (rows.some(item => item.name === preferred)) animation.value = preferred;
  }
  function cancelScrub() {
    if (seekFrame !== null) cancelAnimationFrame(seekFrame);
    seekFrame = null; draftTime = null; lastSeekTime = null; scrubbing = false;
    seeking.textContent = '';
  }
  function flushSeek() {
    if (seekFrame !== null) cancelAnimationFrame(seekFrame);
    seekFrame = null;
    if (draftTime === null || lastSeekTime === draftTime) return;
    lastSeekTime = draftTime;
    command('seek', {time:draftTime});
  }
  function finishScrub() {
    if (draftTime === null) return;
    draftTime = clamp(position.value, duration()); scrubbing = false;
    flushSeek(); seeking.textContent = '等待运行反馈…';
  }
  player.addEventListener('change', () => { cancelScrub(); selectionIntent = {player:player.value, name:''}; populateAnimations(); render(); });
  animation.addEventListener('change', () => { cancelScrub(); selectionIntent = {player:player.value, name:animation.value}; command('animation', {play:true}); render(); });
  speed.addEventListener('change', () => command('animation_play', {speed:finite(speed.value, 1)}));
  position.addEventListener('input', () => {
    scrubbing = true; draftTime = clamp(position.value, duration()); time.value = draftTime.toFixed(2);
    seeking.textContent = `定位 ${seconds(draftTime)}`;
    position.setAttribute('aria-valuetext', `${seconds(draftTime)} / ${seconds(duration())}`);
    // Send the latest position every display frame, while the pointer is held.
    if (seekFrame === null) seekFrame = requestAnimationFrame(flushSeek);
  });
  position.addEventListener('change', finishScrub);
  position.addEventListener('pointercancel', finishScrub);
  position.addEventListener('blur', finishScrub);
  time.addEventListener('change', () => { cancelScrub(); command('seek', {time:clamp(time.value, duration())}); seeking.textContent = '等待运行反馈…'; });
  function render() {
    const rows = entries(), current = state.animation ?? {};
    if (selectionIntent && !rows.some(item => item.player === selectionIntent.player && (!selectionIntent.name || item.name === selectionIntent.name))) selectionIntent = null;
    if (selectionIntent?.name && selectionIntent.player === String(current.player ?? '') && selectionIntent.name === current.name) selectionIntent = null;
    const nextCatalogKey = JSON.stringify(rows.map(item => [item.player, item.name, item.label]));
    if (catalogKey !== nextCatalogKey) {
      const previousPlayer = player.value, previousName = animation.value; catalogKey = nextCatalogKey;
      const players = [...new Set(rows.map(item => item.player))];
      player.replaceChildren(...players.map(value => option(value, value || '默认播放器')));
      const wanted = selectionIntent?.player ?? (players.includes(String(current.player ?? '')) ? String(current.player ?? '') : previousPlayer);
      if (players.includes(wanted)) player.value = wanted;
      populateAnimations(selectionIntent?.name ?? current.name ?? previousName);
    }
    if (!selectionIntent && rows.some(item => item.player === String(current.player ?? '') && item.name === current.name)) {
      if (player.value !== String(current.player ?? '')) { player.value = String(current.player ?? ''); populateAnimations(current.name); }
      animation.value = current.name;
    }
    const item = selected(), disabled = state.disabled || !item || current.name !== item.name || String(current.player ?? '') !== item.player, length = duration();
    root.classList.toggle('is-disabled', !!state.disabled);
    player.disabled = animation.disabled = state.disabled || !rows.length;
    for (const node of [first, play, last, time, position, speed]) node.disabled = disabled;
    empty.hidden = rows.length > 0;
    if (disabled) cancelScrub();
    loop.textContent = item ? (item.loop_mode === 2 ? '往返循环' : item.loop || item.loop_mode ? '循环' : '单次') : '';
    loop.title = '循环方式来自原生动画定义';
    play.textContent = current.playing ? 'Ⅱ' : '▶'; play.title = current.playing ? '暂停动画' : '播放动画'; play.setAttribute('aria-label', play.title); play.setAttribute('aria-pressed', String(!!current.playing));
    const matchesCurrent = item && current.name === item.name && String(current.player ?? '') === item.player;
    const value = draftTime ?? (matchesCurrent ? clamp(current.time, length) : 0);
    if (document.activeElement !== time) time.value = value.toFixed(2);
    position.max = String(length || 1); time.max = String(length); position.value = String(value);
    position.setAttribute('aria-valuetext', `${seconds(value)} / ${seconds(length)}`);
    durationText.textContent = `/ ${seconds(length)}`;
    speed.value = String(finite(state.speed, 1));
  }
  render();
  return {
    update(next = {}) {
      if (disposed) return;
      state = {...state, ...next};
      const current = state.animation;
      // Old engine observations cannot pull the handle away from the pointer.
      if (!scrubbing && draftTime !== null && current?.player === player.value && current?.name === animation.value && !current.playing && Math.abs(finite(current.time) - draftTime) < .002) cancelScrub();
      if (draftTime === null) seeking.textContent = '';
      render();
    },
    dispose() { cancelScrub(); disposed = true; root.remove(); },
  };
}
