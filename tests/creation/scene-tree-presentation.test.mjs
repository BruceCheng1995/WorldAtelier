// Independent tree-order regression using the actual hierarchy resolver and the
// actual pure UI helper. No browser, service, runtime or user data is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { HIERARCHY_SCHEMA, emptyDocument, prepareManifest, resolveScene } from '../../services/creation/hierarchy.mjs';
import { hierarchyObjectView } from '../../services/creation/hierarchy-view.mjs';
import { identityTransform } from '../../packages/scene/transform.mjs';

const source = readFileSync(new URL('../../apps/creation-workspace/workspace.js', import.meta.url), 'utf8');
const start = source.indexOf('export function orderExplorerRows('), end = source.indexOf('// BEGIN TREE PRESENTATION', start);
assert.ok(start >= 0 && end > start, 'Actual pure tree-order helper must be available');
const context = vm.createContext({});
vm.runInContext(source.slice(start, end).replace('export function ', 'function '), context);
const presentationEnd = source.indexOf('// END TREE PRESENTATION', end);
assert.ok(presentationEnd > end, 'Actual tree presentation helpers must be available');
vm.runInContext(source.slice(end, presentationEnd).replaceAll('export function ', 'function '), context);
const { createExplorerTreeState, buildExplorerTree, revealExplorerRow, setExplorerExpanded, explorerTreeDestination } = context;
const ordered = rows => { context.rows = rows; return vm.runInContext('orderExplorerRows(rows)', context); };
const scope = { project_id: 'tree-project', branch_id: 'main' };

function fixture() {
  const scene = emptyDocument('scene'), prefab = emptyDocument('prefab', 'prefab', 'Beacon');
  for (const id of ['group-a', 'group-b']) scene.nodes[id] = { id, name: id, kind: 'group', parent_id: 'root', transform: identityTransform(), components: {}, solid: false };
  prefab.nodes.light = { id: 'light', name: 'Same definition node', kind: 'anchor', parent_id: 'root', transform: identityTransform(), components: {}, solid: false };
  let manifest = prepareManifest({ schema: HIERARCHY_SCHEMA, entry_scene_id: 'scene', resources: { scene, prefab }, prefab_revisions: {} });
  for (const side of ['a', 'b']) manifest.resources.scene.instances[`instance-${side}`] = { instance_id: `instance-${side}`, prefab_id: 'prefab', prefab_revision: manifest.resources.prefab.version, parent_id: `group-${side}`, transform: identityTransform(), overrides: [] };
  return prepareManifest(manifest);
}

test('scene tree orders descendants directly below their actual parent rather than below a later sibling', () => {
  const rows = [
    { key: 'root', parent_key: null }, { key: 'group-a', parent_key: 'root' },
    { key: 'group-b', parent_key: 'root' }, { key: 'instance-a', parent_key: 'group-a' },
    { key: 'instance-a-child', parent_key: 'instance-a' },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(Array.from(ordered(rows), row => row.key), ['root', 'group-a', 'instance-a', 'instance-a-child', 'group-b']);
  assert.deepEqual(rows, before, 'presentation ordering must not rewrite source rows');
});

test('actual resolved prefab instances retain identity while their visible subtrees become contiguous', () => {
  const manifest = fixture(), before = structuredClone(manifest), rows = resolveScene(manifest, 'scene', scope);
  const label = row => [...row.address.instance_path, row.address.definition_node_id].join('/');
  assert.deepEqual(rows.map(label), ['root', 'group-a', 'group-b', 'instance-a/root', 'instance-a/light', 'instance-b/root', 'instance-b/light'], 'fixture reproduces source-first resolver order');
  const tree = Array.from(ordered(rows));
  assert.deepEqual(tree.map(label), ['root', 'group-a', 'instance-a/root', 'instance-a/light', 'group-b', 'instance-b/root', 'instance-b/light']);
  assert.equal(new Set(tree.map(row => row.key)).size, rows.length);
  assert.ok(tree.every(row => rows.includes(row)), 'the visual tree retains the actual resolver records');
  assert.deepEqual(manifest, before);
});

test('independent prefab editing keeps its own resource root and local node addresses', () => {
  const rows = resolveScene(fixture(), 'prefab', scope), tree = Array.from(ordered(rows));
  assert.deepEqual(tree.map(row => row.address.definition_node_id), ['root', 'light']);
  assert.ok(tree.every(row => row.address.resource_id === 'prefab' && row.address.instance_path.length === 0));
  assert.deepEqual(Array.from(ordered([])), []);
});

function nativeRows() {
  const row = (key, parent_key, fields = {}) => ({ key, parent_key, object: { id: key, name: key, kind: 'node', ...fields } });
  return [
    row('scene', null, { kind: 'group' }),
    row('left', 'scene', { instance_root: true, prefab: 'beacon' }),
    row('inner', 'left', { instance_root: true, prefab: 'lamp' }),
    row('needle', 'inner', { prefab: 'lamp', source_node_id: 'stable-lamp' }),
    row('left-leaf', 'left', { prefab: 'beacon' }),
    row('right', 'scene', { instance_root: true, prefab: 'beacon' }),
    row('right-leaf', 'right', { prefab: 'beacon' }),
  ];
}
const visibleKeys = tree => Array.from(tree.visible, row => row.key);
const collapsedKeys = state => [...state.collapsed].sort();
const nativeTree = (rows, state, options = {}) => buildExplorerTree(rows, state, { native: true, ...options });

test('native scene overview stays open while instances and nested branches start collapsed', () => {
  const rows = nativeRows(), before = structuredClone(rows), state = createExplorerTreeState(), tree = nativeTree(rows, state);
  assert.deepEqual(visibleKeys(tree), ['scene', 'left', 'right']);
  assert.deepEqual(collapsedKeys(state), ['inner', 'left', 'right']);
  assert.equal(tree.roles.get('left'), 'instance');
  assert.equal(tree.roles.get('inner'), 'instance');
  assert.equal(tree.roles.get('needle'), '', 'an ordinary instance child keeps its node icon');
  assert.equal(tree.visible.find(row => row.key === 'left').expanded, false);
  assert.deepEqual(rows, before, 'navigation state never changes native query records');
});

test('actual H2 instance roots and independent prefab roots get distinct roles and folded children', () => {
  const manifest = fixture(), makeRows = rid => Array.from(ordered(resolveScene(manifest, rid, scope).map(row => ({ ...row, object: hierarchyObjectView(row) }))));
  const rows = makeRows('scene'), state = createExplorerTreeState(), tree = buildExplorerTree(rows, state);
  const mount = rows.find(row => row.address.instance_path[0] === 'instance-a' && row.address.definition_node_id === 'root');
  const child = rows.find(row => row.address.instance_path[0] === 'instance-a' && row.address.definition_node_id === 'light');
  assert.equal(tree.roles.get(mount.key), 'instance');
  assert.equal(tree.roles.get(child.key), '');
  assert.equal(state.collapsed.has(mount.key), true);
  assert.deepEqual(Array.from(tree.visible, row => row.object.id), ['root', 'group-a', 'group-b']);
  const definitionState = createExplorerTreeState(), definition = buildExplorerTree(makeRows('prefab'), definitionState, { kind: 'prefab' });
  assert.deepEqual(Array.from(definition.visible, row => row.object.id), ['root']);
  assert.equal(definition.visible[0].role, 'component');
  assert.equal(definition.visible[0].expanded, false);
  const nativeDefinition = nativeTree(nativeRows().slice(1, 5).map(row => ({ ...row, parent_key: row.key === 'left' ? null : row.parent_key, object: { ...row.object, instance_root: row.key === 'inner' } })), createExplorerTreeState(), { kind: 'prefab' });
  assert.deepEqual(visibleKeys(nativeDefinition), ['left']);
  assert.equal(nativeDefinition.visible[0].role, 'component');
  assert.equal(nativeDefinition.visible[0].expanded, false);
});

test('manual expansion survives rebuilt row records and newly discovered branches start folded', () => {
  const rows = nativeRows(), state = createExplorerTreeState(), tree = nativeTree(rows, state);
  setExplorerExpanded(tree, state, 'left', true);
  assert.deepEqual(visibleKeys(nativeTree(structuredClone(rows), state)), ['scene', 'left', 'inner', 'left-leaf', 'right']);
  const next = Array.from(ordered([...structuredClone(rows), { key: 'new', parent_key: 'left', object: { id: 'new', name: 'New instance', instance_root: true } }, { key: 'new-child', parent_key: 'new', object: { id: 'new-child', name: 'New child' } }]));
  const rebuilt = nativeTree(next, state);
  assert.equal(state.collapsed.has('left'), false);
  assert.equal(state.collapsed.has('new'), true);
  assert.ok(visibleKeys(rebuilt).includes('new'));
  assert.equal(visibleKeys(rebuilt).includes('new-child'), false);
});

test('an empty loading pass between revisions does not erase a manually expanded branch', () => {
  const rows = nativeRows(), state = createExplorerTreeState(), tree = nativeTree(rows, state);
  setExplorerExpanded(tree, state, 'left', true);
  nativeTree([], state);
  assert.deepEqual(visibleKeys(nativeTree(rows, state)), ['scene', 'left', 'inner', 'left-leaf', 'right']);
});

test('search temporarily reveals matching paths, counts only matches, and restores folded rows', () => {
  const rows = nativeRows(), state = createExplorerTreeState(), normal = nativeTree(rows, state), before = collapsedKeys(state);
  const filtered = nativeTree(rows, state, { query: 'needle' });
  assert.deepEqual(visibleKeys(filtered), ['scene', 'left', 'inner', 'needle']);
  assert.equal(filtered.matches.size, 1);
  assert.deepEqual(Array.from(filtered.visible, row => row.match), [false, false, false, true]);
  assert.ok(filtered.visible.filter(row => row.hasChildren).every(row => row.expanded));
  assert.deepEqual(collapsedKeys(state), before);
  assert.deepEqual(visibleKeys(nativeTree(rows, state)), visibleKeys(normal));
  assert.equal(nativeTree(rows, state, { query: 'stable-lamp' }).matches.size, 1, 'stable node identifiers remain searchable');
  assert.equal(nativeTree(rows, state, { query: 'absent' }).visible.length, 0);
});

test('reveal opens only target ancestors and leaves the target and sibling branches folded', () => {
  const rows = nativeRows(), state = createExplorerTreeState(), tree = nativeTree(rows, state);
  setExplorerExpanded(tree, state, 'scene', false);
  revealExplorerRow(tree, state, 'inner');
  assert.deepEqual(collapsedKeys(state), ['inner', 'right']);
  assert.deepEqual(visibleKeys(nativeTree(rows, state)), ['scene', 'left', 'inner', 'left-leaf', 'right']);
  revealExplorerRow(tree, state, 'unknown');
  assert.deepEqual(collapsedKeys(state), ['inner', 'right']);
});

test('recursive fold and expand remain inside the requested subtree', () => {
  const rows = nativeRows(), state = createExplorerTreeState(), tree = nativeTree(rows, state);
  setExplorerExpanded(tree, state, 'left', true, true);
  assert.deepEqual(collapsedKeys(state), ['right']);
  assert.deepEqual(visibleKeys(nativeTree(rows, state)), ['scene', 'left', 'inner', 'needle', 'left-leaf', 'right']);
  setExplorerExpanded(tree, state, 'left', false, true);
  assert.deepEqual(collapsedKeys(state), ['inner', 'left', 'right']);
  assert.equal(state.collapsed.has('needle'), false, 'leaf nodes do not gain a fold state');
  assert.equal(state.collapsed.has('scene'), false);
});

test('keyboard destinations follow visible parent-child relationships and clamp traversal', () => {
  const rows = nativeRows(), state = createExplorerTreeState(), tree = nativeTree(rows, state);
  assert.equal(explorerTreeDestination(tree.visible, 'left', 'ArrowDown'), 'right', 'collapsed descendants are skipped');
  assert.equal(explorerTreeDestination(tree.visible, 'left', 'ArrowRight'), 'left', 'a folded row has no visible first child');
  assert.equal(explorerTreeDestination(tree.visible, 'scene', 'ArrowLeft'), 'scene');
  setExplorerExpanded(tree, state, 'left', true, true);
  const visible = nativeTree(rows, state).visible;
  assert.equal(explorerTreeDestination(visible, 'left', 'ArrowRight'), 'inner');
  assert.equal(explorerTreeDestination(visible, 'needle', 'ArrowLeft'), 'inner');
  assert.equal(explorerTreeDestination(visible, 'needle', 'ArrowRight'), 'needle');
  assert.equal(explorerTreeDestination(visible, 'needle', 'Home'), 'scene');
  assert.equal(explorerTreeDestination(visible, 'needle', 'End'), 'right');
  assert.equal(explorerTreeDestination(visible, 'scene', 'ArrowUp'), 'scene');
  assert.equal(explorerTreeDestination(visible, 'right', 'ArrowDown'), 'right');
  assert.equal(explorerTreeDestination(visible, 'missing', 'ArrowDown'), null);
});

function loadingRenderFixture({ native = true, hierarchy = false, resolved = null, mode = 'edit', scope = 'source/project/main/scene' } = {}) {
  const renderStart = source.indexOf('function renderExplorer('), renderEnd = source.indexOf('\nfunction ensurePrefabPlacement(', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const attributes = new Map(), activeRow = { dataset: { select: 'needle' } }, host = { innerHTML: '<button>Existing selected object</button>', scrollTop: 280, setAttribute: (key, value) => attributes.set(key, value) };
  const selected = { ids: ['needle'], primary: 'needle', anchor: 'needle' }, state = { focusId: 'needle', scrollTop: 280 };
  const renderContinued = new Error('render reached current selection reconciliation');
  const sandbox = {
    branch: { head: 'next-revision' }, mode, explorerTab: 'scene', displayedExplorerScope: 'source/project/main/scene',
    selectedId: 'needle', semanticSelection: selected, explorerTreeStates: new Map([['source/project/main/scene', state]]),
    document: { activeElement: activeRow }, ensurePrefabPlacement() {},
    isNative: () => native, isHierarchy: () => hierarchy, resolvedDocument: () => resolved, explorerScope: () => scope,
    $: selector => { assert.equal(selector, '#explorerList'); return host; },
    selectedSemanticObjects: () => { throw renderContinued; },
  };
  vm.createContext(sandbox);vm.runInContext(source.slice(renderStart, renderEnd), sandbox);
  return { sandbox, host, activeRow, selected, state, attributes, renderContinued };
}

test('same-document index loading preserves the existing tree, focus, scroll and semantic selection', () => {
  for (const schema of [{ native: true }, { native: false, hierarchy: true }]) {
    const f = loadingRenderFixture(schema), html = f.host.innerHTML;
    assert.doesNotThrow(() => f.sandbox.renderExplorer({ reveal: 'needle', scrollToSelection: true }));
    assert.equal(f.attributes.get('aria-busy'), 'true');
    assert.equal(f.host.innerHTML, html);
    assert.equal(f.host.scrollTop, 280);
    assert.equal(f.sandbox.document.activeElement, f.activeRow);
    assert.equal(f.sandbox.selectedId, 'needle');
    assert.equal(f.sandbox.semanticSelection, f.selected);
    assert.deepEqual(f.selected, { ids: ['needle'], primary: 'needle', anchor: 'needle' });
    assert.deepEqual(f.state, { focusId: 'needle', scrollTop: 280 });
  }
});

test('loading protection yields to a ready index or a different document instead of retaining stale rows', () => {
  for (const options of [{ resolved: { objects: [] } }, { scope: 'source/project/main/other' }, { native: false }, { mode: 'play' }]) {
    const f = loadingRenderFixture(options);
    assert.throws(() => f.sandbox.renderExplorer(), error => error === f.renderContinued);
    assert.equal(f.attributes.get('aria-busy'), 'false');
  }
});
