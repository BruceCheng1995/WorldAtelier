import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');

// Browser component checks only. No runtime bridge messages or Godot ACKs are manufactured.
async function harness(t, width = 1100) {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width, height:760}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://prefab-components.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({contentType:'text/html', body:'<!doctype html><html><head><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/prefab-lab.css"></head><body><div id="host" style="position:relative;width:100vw;height:760px"></div></body></html>'});
    if (/^\/[a-z-]+\.(?:js|css)$/.test(path)) return route.fulfill({contentType:path.endsWith('.css') ? 'text/css' : 'text/javascript', body:readFileSync(resolve(root, 'apps/creation-workspace', path.slice(1)))});
    return route.fulfill({status:404});
  });
  await page.goto('http://prefab-components.test/');
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

test('animation timeline uses observed positions, requires clip choice, and emits explicit commands', async t => {
  const page = await harness(t);
  await page.evaluate(async () => {
    const {mountAnimationTimeline} = await import('/animation-timeline.js');
    window.commands = []; window.timeline = mountAnimationTimeline(document.querySelector('#host'), {onCommand:value => commands.push(value)});
    window.clips = [{player:'Subject/AnimationPlayer', name:'idle', duration:2, loop:true, tracks:[{path:'Visual:position', keys:[0, 1, 2]}]}, {player:'Subject/AnimationPlayer', name:'fire', duration:.5, tracks:[]}];
    timeline.update({animations:clips, disabled:false, animation:null});
  });
  assert.equal(await page.getByRole('combobox', {name:'动画', exact:true}).isEnabled(), true);
  assert.equal(await page.getByRole('button', {name:'播放动画', exact:true}).isDisabled(), true);
  await page.getByRole('combobox', {name:'动画', exact:true}).selectOption('idle');
  assert.deepEqual(await page.evaluate(() => commands), [{action:'animation', player:'Subject/AnimationPlayer', animation:'idle', play:true}]);
  assert.equal(await page.getByRole('button', {name:'播放动画', exact:true}).isDisabled(), true);
  await page.evaluate(() => timeline.update({animation:{player:'Subject/AnimationPlayer', name:'idle', time:.25, duration:2, playing:false}}));
  assert.equal(await page.getByRole('spinbutton', {name:'动画时间（秒）'}).inputValue(), '0.25');
  assert.equal(await page.locator('.animation-key,.animation-track,.animation-ticks').count(), 0);
  await page.getByRole('button', {name:'播放动画', exact:true}).click();
  assert.equal(await page.getByRole('button', {name:'播放动画', exact:true}).getAttribute('aria-pressed'), 'false');
  await page.getByRole('slider', {name:'动画播放位置'}).evaluate(node => { node.value = '1.25'; node.dispatchEvent(new Event('input')); node.dispatchEvent(new Event('change')); });
  assert.deepEqual((await page.evaluate(() => commands)).at(-1), {action:'seek', player:'Subject/AnimationPlayer', animation:'idle', time:1.25});
  await page.evaluate(() => timeline.update({animation:{player:'Subject/AnimationPlayer', name:'idle', time:1.25, duration:2, playing:false}}));
  await page.getByRole('combobox', {name:'动画速度'}).selectOption('0.5');
  assert.deepEqual((await page.evaluate(() => commands)).at(-1), {action:'animation_play', player:'Subject/AnimationPlayer', animation:'idle', speed:.5});
  await page.evaluate(() => timeline.update({animation:{player:'Subject/AnimationPlayer', name:'idle', time:1.5, duration:2, playing:true}, speed:.5}));
  assert.equal(await page.getByRole('button', {name:'暂停动画', exact:true}).getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => timeline.dispose());
  assert.equal(await page.locator('.animation-timeline').count(), 0);
});

test('scrubbing sends live positions before release, resists stale observations and cancels on disposal', async t => {
  const page = await harness(t);
  await page.evaluate(async () => {
    const {mountAnimationTimeline} = await import('/animation-timeline.js');
    window.commands = [];
    window.timeline = mountAnimationTimeline(document.querySelector('#host'), {onCommand:value => commands.push(value)});
    timeline.update({animations:[{player:'Subject', name:'idle', duration:2}], animation:{player:'Subject', name:'idle', time:0, playing:true}, disabled:false});
  });
  const slider = page.getByRole('slider', {name:'动画播放位置'});
  await slider.evaluate(node => { for (const at of [.2, .4, .8]) { node.value = String(at); node.dispatchEvent(new Event('input')); } });
  await page.waitForFunction(() => commands.length === 1);
  assert.deepEqual(await page.evaluate(() => commands), [{action:'seek', player:'Subject', animation:'idle', time:.8}]);
  await page.evaluate(() => timeline.update({animation:{player:'Subject', name:'idle', time:.2, playing:false}}));
  assert.equal(await slider.inputValue(), '0.8', 'old feedback does not move the handle while dragging');
  await slider.evaluate(node => { node.value = '1.2'; node.dispatchEvent(new Event('input')); node.dispatchEvent(new Event('change')); });
  assert.equal((await page.evaluate(() => commands)).at(-1).time, 1.2, 'release flushes the final pending position');
  await page.evaluate(() => timeline.update({animation:{player:'Subject', name:'idle', time:.8, playing:false}}));
  assert.equal(await slider.inputValue(), '1.2', 'old feedback does not replace the pending final position');
  await page.evaluate(() => timeline.update({animation:{player:'Subject', name:'idle', time:1.2, playing:false}}));
  await page.evaluate(() => timeline.update({animation:{player:'Subject', name:'idle', time:1.3, playing:true}}));
  assert.equal(await slider.inputValue(), '1.3', 'accepted final position returns to engine-driven playback');
  const count = await page.evaluate(() => commands.length);
  await slider.evaluate(node => { node.value = '1.6'; node.dispatchEvent(new Event('input')); timeline.dispose(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => commands.length), count, 'closing cancels queued seek');
});

test('lab empty state hands off requests, respects read-only scope, and fits narrow stage', async t => {
  const page = await harness(t, 610);
  await page.evaluate(async () => {
    const {mountPrefabLab} = await import('/prefab-lab.js');
    window.calls = []; window.role = 'editor';
    window.lab = mountPrefabLab(document.querySelector('#host'), {getContext:() => ({role}), onCreate:value => calls.push(['create', value]), onRequest:value => calls.push(['request', value]), onClose:() => calls.push(['close'])});
    lab.open({subject:{id:'pea', name:'豌豆射手'}, scenarios:[], revision:'revision-a', projectId:'project-a', branchId:'main', autoStart:false});
  });
  assert.equal(await page.locator('.prefab-lab').isVisible(), true);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.getByRole('button', {name:'单帧', exact:true, includeHidden:true}).isVisible(), false,'generic animation preview uses timeline controls instead of scene stepping');
  await page.getByRole('button', {name:'提需求', exact:true}).click();
  await page.getByRole('button', {name:'技能', exact:true}).click();
  await page.getByRole('button', {name:'交给 Agent', exact:true}).click();
  const handoff = (await page.evaluate(() => calls))[0];
  assert.equal(handoff[0], 'request'); assert.equal(handoff[1].subject.id, 'pea'); assert.equal(handoff[1].evidence.source_revision, 'revision-a'); assert.equal(handoff[1].evidence.state, null);
  await page.getByRole('button', {name:'管理测试场景', exact:true}).click();
  await page.getByRole('button', {name:'＋ 创建测试场景', exact:true}).click();
  assert.equal((await page.evaluate(() => calls)).at(-1)[0], 'create');
  for(const width of [1000,610]){
    await page.setViewportSize({width,height:760});
    const sizing = await page.locator('.prefab-lab').evaluate(node => ({width:node.clientWidth, scroll:node.scrollWidth}));
    assert.ok(sizing.scroll <= sizing.width + 1, JSON.stringify(sizing));
    assert.equal(await page.getByRole('button', {name:'管理测试场景', exact:true}).isVisible(), true,'management remains reachable at '+width+'px');
    assert.equal(await page.getByRole('button', {name:'场景工具', exact:true}).isVisible(), true);
  }
  await page.evaluate(() => { role = 'viewer'; lab.refresh({}); });
  assert.equal(await page.getByRole('button', {name:'提需求', exact:true}).isDisabled(), true);
  await page.getByRole('button', {name:'管理测试场景', exact:true}).click();
  assert.equal(await page.getByRole('button', {name:'＋ 创建测试场景', exact:true}).isDisabled(), true);
  await page.getByRole('button', {name:'关闭辅助面板', exact:true}).click();
  await page.getByRole('button', {name:'返回编辑', exact:true}).click();
  assert.equal(await page.locator('.prefab-lab').isVisible(), false);
  assert.equal((await page.evaluate(() => calls)).at(-1)[0], 'close');
});

test('switching animation players keeps the user selection through older observations', async t => {
  const page = await harness(t);
  await page.evaluate(async () => {
    const {mountAnimationTimeline} = await import('/animation-timeline.js');
    window.commands = []; window.timeline = mountAnimationTimeline(document.querySelector('#host'), {onCommand:value => commands.push(value)});
    timeline.update({animations:[{player:'Subject', name:'idle', duration:2}, {player:'Target', name:'walk', duration:1}], animation:{player:'Subject', name:'idle', time:.5, playing:false}, disabled:false});
  });
  await page.getByRole('combobox', {name:'动画播放器'}).selectOption('Target');
  assert.equal(await page.getByRole('combobox', {name:'动画播放器'}).inputValue(), 'Target');
  assert.equal(await page.getByRole('combobox', {name:'动画', exact:true}).inputValue(), '');
  assert.deepEqual(await page.evaluate(() => commands), []);
  await page.evaluate(() => timeline.update({animation:{player:'Subject', name:'idle', time:.6, playing:true}}));
  assert.equal(await page.getByRole('combobox', {name:'动画播放器'}).inputValue(), 'Target');
  await page.getByRole('combobox', {name:'动画', exact:true}).selectOption('walk');
  assert.deepEqual(await page.evaluate(() => commands), [{action:'animation', player:'Target', animation:'walk', play:true}]);
  await page.evaluate(() => timeline.update({animation:{player:'Subject', name:'idle', time:.7, playing:true}}));
  assert.equal(await page.getByRole('combobox', {name:'动画', exact:true}).inputValue(), 'walk');
  assert.equal(await page.getByRole('spinbutton', {name:'动画时间（秒）'}).isDisabled(), true);
  await page.evaluate(() => timeline.update({animation:{player:'Target', name:'walk', time:0, playing:false}}));
  assert.equal(await page.getByRole('spinbutton', {name:'动画时间（秒）'}).isEnabled(), true);
  assert.equal(await page.getByRole('button', {name:'播放动画', exact:true}).isEnabled(), true);
});

test('animation catalog exposes new clips and switches same-name players without stale selection', async t => {
  const page = await harness(t);
  await page.evaluate(async () => {
    const {mountAnimationTimeline} = await import('/animation-timeline.js');
    window.commands = []; window.timeline = mountAnimationTimeline(document.querySelector('#host'), {onCommand:value => commands.push(value)});
    window.clips = [{player:'Subject/A', name:'idle', duration:2}, {player:'Subject/B', name:'idle', duration:1}];
    timeline.update({animations:clips, animation:{player:'Subject/A', name:'idle', time:.5, playing:true}, disabled:false});
  });
  await page.getByRole('combobox', {name:'动画播放器'}).selectOption('Subject/B');
  await page.getByRole('combobox', {name:'动画', exact:true}).selectOption('idle');
  assert.deepEqual((await page.evaluate(() => commands)).at(-1), {action:'animation', player:'Subject/B', animation:'idle', play:true});
  await page.evaluate(() => timeline.update({animation:{player:'Subject/A', name:'idle', time:.6, playing:true}}));
  assert.equal(await page.getByRole('combobox', {name:'动画播放器'}).inputValue(), 'Subject/B');
  await page.evaluate(() => timeline.update({animation:{player:'Subject/B', name:'idle', time:.2, playing:true}}));
  assert.equal(await page.getByRole('button', {name:'暂停动画', exact:true}).isEnabled(), true);
  await page.evaluate(() => { clips.push({player:'Subject/B', name:'jump', duration:.4}); timeline.update({animations:clips}); });
  await page.getByRole('combobox', {name:'动画', exact:true}).selectOption('jump');
  assert.equal((await page.evaluate(() => commands)).at(-1).animation, 'jump');
  // Pending clip is removed before an observation acknowledges it.
  await page.evaluate(() => timeline.update({animations:clips.slice(0, 2), animation:{player:'Subject/B', name:'idle', time:.3, playing:true}}));
  assert.equal(await page.getByRole('combobox', {name:'动画', exact:true}).inputValue(), 'idle');
  await page.evaluate(() => timeline.update({animations:[], animation:null}));
  assert.equal(await page.getByRole('combobox', {name:'动画', exact:true}).isDisabled(), true);
});

test('closing a preparing lab aborts its request and ignores late completion', async t => {
  const page = await harness(t);
  await page.evaluate(async () => {
    const {mountPrefabLab} = await import('/prefab-lab.js');
    window.requestWasAborted = false;
    const request = (route, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { requestWasAborted = true; reject(Object.assign(new Error('Cancelled'), {name:'AbortError'})); }, {once:true});
    });
    window.lab = mountPrefabLab(document.querySelector('#host'), {request});
    lab.open({subject:{id:'pea', name:'豌豆射手'}, scenarios:[{id:'preview-pea', name:'攻击测试'}], revision:'revision-a', projectId:'project-a', branchId:'main'});
  });
  assert.equal(await page.locator('iframe').count(), 1);
  await page.getByRole('button', {name:'返回编辑', exact:true}).click();
  assert.equal(await page.evaluate(() => requestWasAborted), true);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('.prefab-lab').isVisible(), false);
});

test('optional dictation starts only on click, edits text, and stops when the lab closes', async t => {
  const page = await harness(t);
  await page.evaluate(async () => {
    window.speechCalls = []; window.handoffs = [];
    window.SpeechRecognition = class {
      constructor() { window.speech = this; }
      start() { speechCalls.push('start'); this.onstart?.(); }
      stop() { speechCalls.push('stop'); this.onend?.(); }
      abort() { speechCalls.push('abort'); }
    };
    const {mountPrefabLab} = await import('/prefab-lab.js');
    window.lab = mountPrefabLab(document.querySelector('#host'), {onRequest:value => handoffs.push(value)});
    lab.open({subject:{id:'pea', name:'豌豆射手'}, scenarios:[], revision:'revision-a', projectId:'project-a', branchId:'main'});
  });
  assert.deepEqual(await page.evaluate(() => speechCalls), []);
  await page.getByRole('button', {name:'提需求', exact:true}).click();
  await page.getByRole('button', {name:'口述', exact:true}).click();
  assert.deepEqual(await page.evaluate(() => speechCalls), ['start']);
  await page.evaluate(() => speech.onresult({results:[[{transcript:'放一个僵尸靶子。'}]]}));
  assert.equal(await page.getByRole('textbox', {name:'向 Agent 描述测试需求'}).inputValue(), '放一个僵尸靶子。');
  assert.deepEqual(await page.evaluate(() => handoffs), []);
  await page.getByRole('button', {name:'关闭辅助面板', exact:true}).click();
  await page.waitForFunction(() => speechCalls.includes('abort'));
  assert.deepEqual(await page.evaluate(() => speechCalls), ['start', 'abort']);
  assert.equal(await page.evaluate(() => speech.onresult), null);
  await page.getByRole('button', {name:'返回编辑', exact:true}).click();
});
