// Actual inspector modules and shipped styles in an isolated headless browser.
// No product service, user browser, Godot runtime or source transactions are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const app = new URL('../../apps/creation-workspace/', import.meta.url);
const [html, workspaceCss, semanticCss, workspaceSource] = await Promise.all([
  readFile(new URL('index.html', app), 'utf8'), readFile(new URL('workspace.css', app), 'utf8'),
  readFile(new URL('semantic-authoring.css', app), 'utf8'), readFile(new URL('workspace.js', app), 'utf8'),
]);
const aside = html.match(/<aside class="panel inspector"[\s\S]*?<\/aside>/)?.[0];
const symbols = html.match(/<svg width="0"[\s\S]*?<\/svg>/)?.[0];
assert.ok(aside && symbols, 'Use the real inspector shell and icon definitions');
const bundle = await build({ stdin: { contents: "export * from './semantic-inspector.js'; export * from './control-layout-inspector.js';", resolveDir: app.pathname }, bundle: true, write: false, format: 'iife', globalName: 'Inspector' });
let browser;
test.before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
test.after(async () => { await browser?.close(); });

async function withInspector(width, run) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent(`<body class="is-editing">${symbols}<div class="workspace" style="display:block;width:${width}px;height:100vh;min-height:0">${aside}</div></body>`);
    await page.addStyleTag({ content: workspaceCss });await page.addStyleTag({ content: semanticCss });
    await page.locator('.inspector').evaluate((node, width) => { node.style.width = width + 'px';node.style.height = '100vh'; }, width);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await run(page);assert.deepEqual(errors, []);
  } finally { await page.close(); }
}
const closeTo = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} != ${expected}`);

for (const width of [300, 378]) test(`${width}px inspector aligns typed fields, reset slots and long labels without overflow`, async () => {
  await withInspector(width, async page => {
    await page.evaluate(() => {
      const host = document.querySelector('#inspectorBody');host.replaceChildren();
      const specs = [
        { id: 'scalar', name: '移动速度', type: 'number', unit: 'm', value: 12.25 },
        { id: 'vector2', name: '位置', type: 'vector2', unit: 'px', value: [123, 456] },
        { id: 'vector3', name: '坐标', type: 'vector3', unit: 'm', value: [12.25, -3, 456] },
        { id: 'vector4', name: '锚点', type: 'vector4', unit: '比例', axisLabels: ['左', '上', '右', '下'], value: [0, 0, 1, 1] },
        { id: 'boolean', name: '允许移动', type: 'boolean', value: false },
        { id: 'color', name: '显示颜色', type: 'color', value: '#aabbcc' },
        { id: 'enum', name: '行为模式', type: 'enum', value: 'follow', options: [{ value: 'follow', label: '跟随玩家' }, { value: 'idle', label: '原地等待' }] },
        { id: 'long', name: '这是一个超过标签列宽度的中文属性名称', description: '完整属性说明', type: 'number', unit: 'px', value: 0 },
      ];
      for (const spec of specs) { const control = Inspector.createParameterControl(document, spec, spec.value);control.row.dataset.fixture = spec.id;control.reset.disabled = false;host.append(control.row); }
    });
    const result = await page.evaluate(() => {
      const rect = node => { const r = node.getBoundingClientRect();return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const host = document.querySelector('#inspectorBody'), panel = document.querySelector('.inspector');
      return { overflow: [host.scrollWidth - host.clientWidth, panel.scrollWidth - panel.clientWidth], rows: [...host.querySelectorAll('.semantic-property')].map(row => ({
        id: row.dataset.fixture, row: rect(row), label: rect(row.querySelector('.semantic-property-name')), editor: rect(row.querySelector('.semantic-property-editor')), reset: rect(row.querySelector('.semantic-property-reset')),
        inputs: [...row.querySelectorAll('input,select')].map(input => ({ ...rect(input), type: input.type, disabled: input.disabled })),
        axes: [...row.querySelectorAll('.semantic-vector-axis')].map(rect), axisLabels: [...row.querySelectorAll('.semantic-vector-axis>span')].map(node => node.textContent),
      })) };
    });
    assert.ok(result.overflow.every(px => px <= 1), `horizontal overflow: ${result.overflow}`);
    const first = result.rows[0];
    for (const item of result.rows) {
      closeTo(item.editor.x, first.editor.x, `${item.id} editor alignment`);closeTo(item.reset.x, first.reset.x, `${item.id} reset alignment`);
      assert.ok(item.label.right + 4 <= item.editor.x, `${item.id} label overlaps value`);
      assert.ok(item.editor.right <= item.reset.x && item.reset.right <= item.row.right + 1, `${item.id} editor/reset overlaps`);
      closeTo(item.row.height, item.id === 'vector4' ? 56 : 28, `${item.id} row height`);
      for (const field of item.axes.length ? item.axes : item.inputs.filter(input => input.type !== 'checkbox')) closeTo(field.height, 24, `${item.id} field height`);
      for (const input of item.inputs) assert.ok(input.x >= item.editor.x - 1 && input.right <= item.editor.right + 1, `${item.id} input leaves value column`);
    }
    const vector4 = result.rows.find(row => row.id === 'vector4');
    assert.deepEqual(vector4.axisLabels, ['左', '上', '右', '下']);
    closeTo(vector4.axes[0].y, vector4.axes[1].y, 'first vector4 row');closeTo(vector4.axes[2].y, vector4.axes[3].y, 'second vector4 row');
    assert.ok(vector4.axes[2].y >= vector4.axes[0].bottom + 3);closeTo(vector4.axes[0].x, vector4.axes[2].x, 'vector4 left column');
    const long = page.locator('[data-fixture="long"] .semantic-property-name');
    assert.match(await long.getAttribute('title'), /中文属性名称.*完整属性说明/);
    assert.equal(await long.locator('.semantic-property-title').evaluate(node => node.scrollWidth > node.clientWidth), true, 'long labels truncate within their column');
    assert.equal(await page.locator('[data-fixture="boolean"] input').isChecked(), false);
  });
});

test('compact semantic sections retain folding, typed commits, defaults and read-only instance capabilities', async () => {
  await withInspector(300, async page => {
    await page.evaluate(() => {
      const root = document.querySelector('#inspectorBody');window.calls = [];
      window.model = { project_id: 'p', branch_id: 'main', resource_id: 'prefab', revision: 'r1', editable: true,
        resource: { id: 'prefab', kind: 'prefab', name: '灯光预制件' }, target: { object_id: 'lamp', expected_version: 'v1', is_instance: false },
        design: { description: '默认功能描述', exposed_properties: [
          { id: 'speed', name: '速度', type: 'number', default: 1, min: 0, max: 10, step: 0.25 },
          { id: 'enabled', name: '启用', type: 'boolean', default: true },
          { id: 'policy', name: '定义策略', type: 'enum', default: 1, options: [{ value: 1, label: '跟随' }, { value: 2, label: '等待' }], instance_editable: false },
        ] }, properties: [
          { id: 'speed', value: 0, editable: true, binding_valid: true },
          { id: 'enabled', value: false, editable: true, binding_valid: true },
          { id: 'policy', value: 2, editable: true, binding_valid: true },
        ] };
      window.inspector = Inspector.createSemanticInspector({ root, callbacks: {
        onParameterChange: (property, value, captured) => calls.push({ kind: 'save', id: property.id, value, revision: captured.revision, version: captured.target.expected_version }),
        onRestoreDefault: property => calls.push({ kind: 'reset', id: property.id }), onSaveDescription: value => calls.push({ kind: 'description', value }),
      } });inspector.render(model);
    });
    const description = page.locator('.semantic-description-section'), parameters = page.locator('.semantic-parameters');
    assert.equal(await description.evaluate(node => node.open), false);assert.equal(await description.locator('textarea').isVisible(), false);
    await description.locator('summary').click();await description.locator('textarea').fill('保留的描述草稿');
    const collapsed = page.evaluate(() => new Promise(resolve => document.querySelector('.semantic-parameters').addEventListener('toggle', () => resolve(), { once: true })));
    await parameters.locator(':scope > summary').click();await collapsed;
    await page.evaluate(() => inspector.render({ ...model, revision: 'r2' }));
    assert.equal(await parameters.evaluate(node => node.open), false);assert.equal(await description.evaluate(node => node.open), true);
    assert.equal(await description.locator('textarea').inputValue(), '保留的描述草稿');
    await parameters.locator(':scope > summary').click();
    const speed = page.locator('[data-property-id="speed"] input');assert.equal(await speed.inputValue(), '0');
    assert.equal(await page.locator('[data-property-id="enabled"] input').isChecked(), false);
    await speed.fill('2.5');await speed.press('Tab');
    assert.deepEqual(await page.evaluate(() => calls.filter(call => call.kind === 'save')), [{ kind: 'save', id: 'speed', value: 2.5, revision: 'r2', version: 'v1' }]);
    await speed.fill('99');await speed.press('Tab');assert.equal(await page.evaluate(() => calls.filter(call => call.kind === 'save').length), 1, 'invalid values do not commit');
    await page.locator('[data-property-id="policy"] select').selectOption('1');
    assert.equal(await page.evaluate(() => calls.at(-1).value), 1, 'numeric enum values retain their type');
    await page.locator('[data-property-id="speed"] .semantic-property-reset').click();assert.deepEqual(await page.evaluate(() => calls.at(-1)), { kind: 'reset', id: 'speed' });
    await page.evaluate(() => inspector.render({ ...model, target: { ...model.target, is_instance: true } }));
    assert.equal(await page.locator('[data-property-id="policy"]').count(), 0);assert.equal(await page.locator('textarea').count(), 0);
    assert.equal(await page.locator('[data-property-id="speed"] .semantic-property-reset').isDisabled(), true, 'unmodified instance values cannot reset');
    await page.evaluate(() => inspector.render({ ...model, editable: false, readOnlyReason: '固定版本只读' }));
    assert.equal(await page.locator('.semantic-property input:enabled,.semantic-property select:enabled,.semantic-property-reset:enabled').count(), 0);
  });
});

test('compact Control layout retains 2x2 labels, one commit per edit, cancellation and container locks', async () => {
  await withInspector(300, async page => {
    await page.evaluate(() => {
      const values = { position: [10, 20], size: [160, 80], anchors: [0, 0, 0, 0], offsets: [10, 20, 170, 100], pivot_offset: [0, 0], rotation_degrees: 0, scale: [1, 1], custom_minimum_size: [0, 0], grow_horizontal: 1, grow_vertical: 1, size_flags_horizontal: 1, size_flags_vertical: 1, size_flags_stretch_ratio: 1 };
      window.calls = [];window.errors = [];window.controlTarget = { control_layout: { values, parent_type: 'Control', viewport_size: [800, 600], container_managed: false, fields: Object.fromEntries(Object.keys(values).map(key => [key, { editable: true, resettable: true }])) } };
      window.renderControl = (target = controlTarget, disabled = false) => { const host = document.querySelector('#inspectorBody');host.replaceChildren();Inspector.renderControlLayoutInspector(host, target, { disabled, onPreview: value => calls.push({ kind: 'preview', value }), onCommit: value => calls.push({ kind: 'commit', value }), onCancel: () => calls.push({ kind: 'cancel' }), onError: error => errors.push(error.message) }); };renderControl();
    });
    assert.deepEqual(await page.locator('[data-control-layout="anchors"] .semantic-vector-axis>span').allTextContents(), ['左', '上', '右', '下']);
    const width = page.locator('[data-control-field="size"][data-control-axis="0"]');await width.fill('220');await width.press('Enter');await width.blur();
    assert.deepEqual(await page.evaluate(() => calls.filter(call => call.kind === 'commit')), [{ kind: 'commit', value: { value: { size: [220, 80] } } }]);
    await width.fill('250');await width.press('Escape');assert.equal(await width.inputValue(), '160');assert.equal(await page.evaluate(() => calls.at(-1).kind), 'cancel');
    await page.locator('[data-control-preset]').selectOption('full_rect');assert.deepEqual(await page.evaluate(() => calls.at(-1)), { kind: 'commit', value: { preset: 'full_rect' } });
    assert.equal(await page.locator('#inspectorBody').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.evaluate(() => { const target = structuredClone(controlTarget);target.control_layout.container_managed = true;target.control_layout.parent_type = 'HBoxContainer';for (const [key, field] of Object.entries(target.control_layout.fields)) field.editable = ['custom_minimum_size', 'size_flags_horizontal', 'size_flags_vertical', 'size_flags_stretch_ratio'].includes(key);renderControl(target); });
    assert.equal(await page.locator('[data-control-preset]').count(), 0);assert.equal(await page.locator('[data-control-field="position"]:enabled,[data-control-field="size"]:enabled').count(), 0);assert.equal(await page.locator('[data-control-field="custom_minimum_size"]:enabled').count(), 2);
    await page.evaluate(() => renderControl({ ...controlTarget, control_layout: { ...controlTarget.control_layout, needs_measurement: true } }));
    assert.equal(await page.locator('#inspectorBody input:enabled,#inspectorBody select:enabled,#inspectorBody button:enabled').count(), 0);assert.deepEqual(await page.evaluate(() => errors), []);
  });
});

test('real preview toggle collapses the dock and object heading preserves keyboard rename semantics', async () => {
  await withInspector(300, async page => {
    const toggleStart = workspaceSource.indexOf("$('#toggleObjectPreview').onclick="), toggleEnd = workspaceSource.indexOf('\n', toggleStart);
    assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
    await page.addScriptTag({ content: `const $=selector=>document.querySelector(selector);${workspaceSource.slice(toggleStart, toggleEnd)}` });
    await page.locator('#toggleObjectPreview').click();assert.equal(await page.locator('#toggleObjectPreview').getAttribute('aria-expanded'), 'false');assert.equal(await page.locator('#objectPreview').isVisible(), false);assert.equal(await page.locator('#fitObject').isVisible(), false);
    await page.locator('#toggleObjectPreview').click();assert.equal(await page.locator('#objectPreview').isVisible(), true);
    await page.evaluate(() => { window.renames = [];const heading = Inspector.createInspectorName(document, { name: '灯光实例', kind: '预制件实例', editable: true, onRename: value => renames.push(value), onError: error => { throw error; } });heading.id = 'inspectorNameDock';document.querySelector('.inspector').prepend(heading); });
    assert.equal(await page.locator('#inspectorNameDock').getAttribute('data-object-kind'), 'instance');assert.equal(await page.locator('.inspector-object-icon use').getAttribute('href'), '#i-instance');
    const name = page.locator('.inspector-name'), input = page.locator('.inspector-name-input');await name.focus();await name.press('F2');await input.fill('未保存名称');await input.press('Escape');assert.equal(await name.innerText(), '灯光实例');assert.deepEqual(await page.evaluate(() => renames), []);
    await name.press('Enter');await input.fill('北侧灯光');await input.press('Enter');await input.blur();assert.deepEqual(await page.evaluate(() => renames), ['北侧灯光']);assert.equal(await name.innerText(), '北侧灯光');
  });
});

test('native object transforms remain visible inside a system-classified scene and remember their own fold state', async () => {
  await withInspector(300, async page => {
    const start = workspaceSource.indexOf('function mountSemanticInspector(){'), end = workspaceSource.indexOf('\nasync function openKnowledgeBrowser(', start);
    assert.ok(start >= 0 && end > start, 'Use the actual semantic inspector host');
    await page.evaluate(() => {
      const source = { id: 'scene', kind: 'scene', name: '坦克场景', design: { category: 'system', exposed_properties: [], description: '场景规则' } };
      Object.assign(window, {
        $: selector => document.querySelector(selector), copy: structuredClone, branch: { manifest: { resources: { scene: source } } }, user: { id: 'u' }, project: { role: 'owner' }, inspectorTab: 'object', mode: 'edit',
        semanticInspectorRoot: null, semanticInspector: null, semanticInspectorGeneration: 0, inspectorSectionState: new Map(), semanticDetails: new Map(), pendingPropertyResult: null, aiPropertyActionsAvailable: false,
        nativeMode: true, selectedObject: { id: 'player', name: 'Player', native_path: 'Player' },
        semanticViewScope: () => ({ project_id: 'p', branch_id: 'main', resource_id: 'scene', revision: 'r1' }),
        object: () => selectedObject, isNative: () => nativeMode, editable: () => true, canWrite: () => true,
        selectedSemanticObjects: () => selectedObject ? [selectedObject] : [], createSemanticInspector: Inspector.createSemanticInspector,
        saveSemanticMutation: () => { throw Error('Layout-only test cannot mutate source'); }, renameSemanticInstance() {}, openInstanceDefinition() {}, requestSemanticAgent() {}, report: error => { throw error; },
        branchRoute: () => 'unused', api: { api: () => { throw Error('Fixed test details should avoid network'); } },
      });
      window.prepareMount = () => {
        const query = new URLSearchParams({ resource_id: 'scene', revision: 'r1', object_id: selectedObject.id });
        semanticDetails.set(`p/main/${query}`, { revision: 'r1', resource: source, design: source.design, target: { object_id: selectedObject.id, is_instance: true }, properties: [] });
        document.querySelector('#inspectorBody').innerHTML = '<div class="semantic-property" data-real-transform="position">原生位置字段</div>';
      };prepareMount();
    });
    await page.addScriptTag({ content: workspaceSource.slice(start, end) });await page.evaluate(() => mountSemanticInspector());
    const spatial = page.locator('#semanticSpatialEditor');assert.equal(await spatial.isVisible(), true);assert.equal(await spatial.locator('[data-real-transform]').isVisible(), true);
    assert.equal(await page.locator('#semanticInspector').evaluate(root => Boolean(root.querySelector('#semanticSpatialEditor').compareDocumentPosition(root.querySelector('.semantic-parameters')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'spatial controls precede adjustable properties');
    const toggled = page.evaluate(() => new Promise(resolve => document.querySelector('#semanticSpatialEditor').addEventListener('toggle', () => resolve(), { once: true })));
    await spatial.locator(':scope > summary').click();await toggled;
    await page.evaluate(() => { prepareMount();mountSemanticInspector(); });assert.equal(await spatial.evaluate(node => node.open), false);
    await page.evaluate(() => { selectedObject = { id: 'enemy', name: 'Enemy', native_path: 'Enemy' };prepareMount();mountSemanticInspector(); });assert.equal(await spatial.evaluate(node => node.open), true, 'another object starts with its own open state');
    await page.evaluate(() => { nativeMode = false;prepareMount();mountSemanticInspector(); });assert.equal(await spatial.isVisible(), false, 'legacy model-free system behavior stays hidden');
  });
});
