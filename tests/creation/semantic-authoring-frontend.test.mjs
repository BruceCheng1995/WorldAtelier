import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseComposerToken, composerSuggestions, composerKeyAction } from '../../apps/creation-workspace/semantic-composer.js';
import { semanticInspectorModel, propertyValue, coerceSemanticProperty } from '../../apps/creation-workspace/semantic-inspector.js';

test('mentions select longest prefixes and preserve exact replacement range', () => {
  assert.deepEqual(parseComposerToken('修改 @@天气，后面', 7), { trigger: '@@', query: '天气', start: 3, end: 7, kind: 'prefab' });
  assert.deepEqual(parseComposerToken('让@宝箱'), { trigger: '@', query: '宝箱', start: 1, end: 4, kind: 'object' });
  assert.equal(parseComposerToken('$$战斗').kind, 'knowledge');
  assert.equal(parseComposerToken('/goal').kind, 'mode');
});

test('email, file paths, URLs and malformed triple prefixes do not trigger', () => {
  for (const value of ['a@b', 'https://example.com/goal', 'res://scripts/plan', '@@@box', '$$$combat', '普通文字', '解释 @宝箱。']) assert.equal(parseComposerToken(value), null, value);
  assert.equal(parseComposerToken('@宝箱 然后'), null);
});

test('single current selection is first and is still the complete source object', () => {
  const selected = { id: 'nested:1', name: '宝箱', address: { instance_path: ['house-1'], definition_node_id: 'chest' }, version: 'v3' };
  const other = { id: 'nested:2', name: '宝箱', address: { instance_path: ['house-2'], definition_node_id: 'chest' }, version: 'v4' };
  const rows = composerSuggestions(parseComposerToken('@'), { objects: [other, selected], selectedObjects: [selected] });
  assert.deepEqual(rows.map(row => row.id), ['nested:1', 'nested:2']);
  assert.equal(rows[0].item, selected);
  assert.deepEqual(rows[1].item.address.instance_path, ['house-2']);
});

test('multiple current selections are an explicit complete group', () => {
  const items = [{ id: 'a', name: '树一' }, { id: 'b', name: '树二' }];
  const rows = composerSuggestions(parseComposerToken('@'), { objects: [...items, { id: 'c', name: '岩石' }], selectedObjects: items });
  assert.equal(rows[0].kind, 'object-group');
  assert.equal(rows[0].items, items);
  assert.deepEqual(rows.slice(1).map(row => row.id), ['c']);
});

test('prefab search includes systems with no model and unplaced definitions', () => {
  const prefabs = [{ id: 'chest', name: '宝箱', kind: 'prefab', design: { category: 'object' } }, { id: 'weather', name: '天气', kind: 'prefab', design: { category: 'system', description: '每天切换下雨和晴天' } }];
  assert.equal(composerSuggestions(parseComposerToken('@@'), { prefabs }).length, 2);
  const rows = composerSuggestions(parseComposerToken('@@下雨'), { prefabs });
  assert.equal(rows[0].badge, '系统');
  assert.equal(rows[0].item, prefabs[1]);
});

test('slash menu filters executable mode intentions', () => {
  assert.deepEqual(composerSuggestions(parseComposerToken('/'), {}).map(row => row.id), ['plan', 'goal']);
  assert.deepEqual(composerSuggestions(parseComposerToken('/g'), {}).map(row => row.id), ['goal']);
  assert.deepEqual(composerSuggestions(parseComposerToken('/unknown'), {}), []);
});

test('only a visible actual candidate consumes normal Enter or Tab', () => {
  assert.equal(composerKeyAction({ key: 'Enter' }, { open: false, count: 3 }), null);
  assert.equal(composerKeyAction({ key: 'Enter' }, { open: true, count: 0 }), null);
  assert.equal(composerKeyAction({ key: 'Enter' }, { open: true, count: 1 }), 'choose');
  assert.equal(composerKeyAction({ key: 'Tab' }, { open: true, count: 1 }), 'choose');
  assert.equal(composerKeyAction({ key: 'Enter', shiftKey: true }, { open: true, count: 1 }), null);
  assert.equal(composerKeyAction({ key: 'Enter', metaKey: true }, { open: true, count: 1 }), null);
});

test('IME composing and keyCode 229 do not choose references or swallow composition', () => {
  for (const event of [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'ArrowDown', isComposing: true }, { key: 'Escape', isComposing: true }]) assert.equal(composerKeyAction(event, { open: true, count: 2 }), null);
  assert.equal(composerKeyAction({ key: 'Enter' }, { open: true, count: 1, composing: true }), null);
  assert.equal(composerKeyAction({ key: 'ArrowDown' }, { open: true, count: 2 }), 'next');
  assert.equal(composerKeyAction({ key: 'ArrowUp' }, { open: true, count: 2 }), 'previous');
  assert.equal(composerKeyAction({ key: 'Escape' }, { open: true, count: 0 }), 'close');
});

const definition = { id: 'recovery', name: '恢复周期', description: '多久恢复一次', type: 'number', default: 24, unit: '小时', min: 1, max: 72, step: 1, instance_editable: true, binding: { node_id: 'root', behavior_id: 'recovery', property_key: 'hours' } };

test('inspector uses declared semantic properties and server current values', () => {
  const model = semanticInspectorModel({ resource: { id: 'chest', name: '宝箱', kind: 'prefab', design: { description: '每天恢复', exposed_properties: [definition] } }, target: { resource_id: 'scene', is_instance: true, definition_resource_id: 'chest', definition_version: 'v2' }, properties: [{ ...definition, value: 12, inherited_value: 24, overridden: true, editable: true, binding_valid: true }, { id: 'engine-secret', value: 55 }], editable: true });
  assert.equal(model.kind, 'instance');
  assert.equal(model.scopeLabel, '仅当前场景中的这个对象');
  assert.equal(model.properties.length, 1);
  assert.equal(propertyValue(model.properties[0]), 12);
  assert.deepEqual(model.sourceDefinition, { id: 'chest', version: 'v2', name: '宝箱' });
});

test('system semantics do not depend on any model asset or instantiated object', () => {
  const model = semanticInspectorModel({ resource: { id: 'weather', kind: 'prefab', name: '天气', design: { category: 'system', description: '控制全局天气', exposed_properties: [] } } });
  assert.equal(model.kind, 'system');
  assert.equal(model.scopeLabel, '整个游戏的系统规则');
  assert.equal(model.description, '控制全局天气');
  assert.deepEqual(model.properties, []);
  assert.equal(model.editable, false);
});

test('absent runtime bindings do not become editable by applying defaults', () => {
  const model = semanticInspectorModel({ resource: { id: 'a', design: { exposed_properties: [definition] } }, properties: [], editable: true });
  assert.equal(model.properties[0].binding_valid, undefined);
  assert.equal(model.properties[0].editable, undefined);
  assert.equal(propertyValue(model.properties[0]), 24);
});

test('falsy property values remain real values instead of inheriting defaults', () => {
  assert.equal(propertyValue({ value: 0, inherited_value: 24, default: 10 }), 0);
  assert.equal(propertyValue({ value: false, default: true }), false);
  assert.equal(propertyValue({ value: '', default: 'default' }), '');
  assert.equal(propertyValue({ inherited_value: 0, default: 2 }), 0);
});

test('definition display distinguishes initial reset value from the current value inherited by new instances', () => {
  const source = readFileSync(new URL('../../apps/creation-workspace/semantic-inspector.js', import.meta.url), 'utf8');
  assert.match(source, /isDefinition \? `初始重置值：\$\{format\(property\.default\)\}/);
  assert.equal(propertyValue({ value: 11, default: 2 }), 11);
});

test('number controls reject blank, nonfinite and out-of-range input without clamping', () => {
  for (const value of ['', '  ', 'NaN', Infinity, '0', '73']) assert.throws(() => coerceSemanticProperty(definition, value));
  assert.equal(coerceSemanticProperty(definition, '12.5'), 12.5);
  assert.throws(() => coerceSemanticProperty({ ...definition, type: 'integer' }, '12.5'));
});

test('enum controls preserve approved value types and reject invented options', () => {
  const property = { type: 'enum', options: [{ label: '简单', value: 1 }, { label: '困难', value: 3 }] };
  assert.equal(coerceSemanticProperty(property, '3'), 3);
  assert.throws(() => coerceSemanticProperty(property, '2'));
  assert.equal(coerceSemanticProperty({ type: 'enum', options: ['sunny', 'rain'] }, 'rain'), 'rain');
});

test('booleans and colors reject ambiguous input', () => {
  assert.equal(coerceSemanticProperty({ type: 'boolean' }, false), false);
  assert.throws(() => coerceSemanticProperty({ type: 'boolean' }, 'false'));
  assert.equal(coerceSemanticProperty({ type: 'color' }, '#AABBCC'), '#AABBCC');
  assert.throws(() => coerceSemanticProperty({ type: 'color' }, 'red'));
  assert.throws(() => coerceSemanticProperty({ type: 'json' }, '{}'));
});
