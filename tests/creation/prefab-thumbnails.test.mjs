// Independent UI/queue regression. The DOM, canvas, renderer ACKs and pixels are
// explicitly FAKE: this file does not launch Godot, a browser, or any service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrefabThumbnails, prefabThumbnailKey, ThumbnailImageCache } from '../../apps/creation-workspace/preview-bridge.js';

const workspace = readFileSync(new URL('../../apps/creation-workspace/workspace.js', import.meta.url), 'utf8');
const origin = 'http://fake-thumbnails.invalid';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function globals(t, values) {
  const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
}
function entry(resourceId = 'beacon', revision = 'head-1', extra = {}) {
  const e = { projectId: 'project', branchId: 'main', resourceId, revision, version: 'prefab-1', ...extra };
  return { ...e, documentId: `${e.projectId}/${e.branchId}/${e.resourceId}`, key: prefabThumbnailKey(e.projectId, e.branchId, { id: e.resourceId, version: e.version }, e.revision) };
}
const scene = e => ({ resource_id: e.resourceId, document_id: e.documentId, scene_revision: e.revision, objects: [] });
function button(e) {
  const img = { hidden: true, src: '' }, status = { textContent: '正在生成预览…' };
  return { dataset: { thumbnailKey: e.key, resource: e.resourceId }, disabled: false, img, status,
    querySelector: query => query === 'img' ? img : query === '.prefab-preview-status' ? status : null };
}
function root(entries) {
  return { buttons: entries.map(button), scrollTop: 43, attributes: {}, innerHTML: '',
    classList: { toggle() {} }, contains: () => false,
    setAttribute(key, value) { this.attributes[key] = value; },
    querySelectorAll(query) { return ['[data-thumbnail-key]', '[data-resource]'].includes(query) ? this.buttons : []; } };
}
function manager(t, options = {}) {
  globals(t, { IntersectionObserver: undefined });
  const value = new PrefabThumbnails({ loadScene: async e => scene(e), render: async s => `FAKE-IMAGE:${s.document_id}:${s.scene_revision}`, ...options });
  t.after(() => value.dispose()); return value;
}
async function drained(value) {
  for (let i = 0; i < 40 && value.busy; i++) await tick();
  assert.equal(value.busy, false, 'FAKE queue should settle without a real render');
}

test('thumbnail identities include project, branch, document, prefab version and fixed branch revision', () => {
  const base = entry(), variants = [entry('other'), entry('beacon', 'head-2'), entry('beacon', 'head-1', { projectId: 'other' }), entry('beacon', 'head-1', { branchId: 'other' }), entry('beacon', 'head-1', { version: 'prefab-2' })];
  assert.equal(new Set([base, ...variants].map(e => e.key)).size, 6);
  assert.equal(base.key, entry().key);
  assert.notEqual(prefabThumbnailKey('a/b', 'c', { id: 'd' }, 'x'), prefabThumbnailKey('a', 'b/c', { id: 'd' }, 'x'), 'JSON key must preserve field boundaries');
});

test('FAKE queue serializes rendering, deduplicates repeated observation and reuses exact cached images', async t => {
  const gates = [deferred(), deferred()], calls = [], a = entry(), b = entry('arch'), host = root([a, b]);
  const value = manager(t, { render: s => { calls.push(s.document_id); return gates[calls.length - 1].promise; } });
  value.observe(host, [a, b]); value.observe(host, [a, b]); await tick();
  assert.deepEqual(calls, [a.documentId]); assert.equal(value.pending.size, 2);
  gates[0].resolve('FAKE-BEACON'); await tick(); assert.deepEqual(calls, [a.documentId, b.documentId]);
  gates[1].resolve('FAKE-ARCH'); await drained(value);
  assert.deepEqual(host.buttons.map(b => b.img.src), ['FAKE-BEACON', 'FAKE-ARCH']);
  const replacement = root([a, b]); value.observe(replacement, [a, b]); await drained(value);
  assert.deepEqual(replacement.buttons.map(b => b.img.src), ['FAKE-BEACON', 'FAKE-ARCH']); assert.equal(calls.length, 2); assert.equal(value.pending.size, 0);
});

test('FAKE late old-version image never paints the current document, and obsolete queued documents are skipped', async t => {
  const old = entry(), skipped = entry('removed'), next = entry('beacon', 'head-2'), oldGate = deferred(), rendered = [];
  const value = manager(t, { render: async s => { rendered.push(s.document_id + ':' + s.scene_revision); return s.scene_revision === old.revision ? oldGate.promise : 'FAKE-NEW'; } });
  value.observe(root([old, skipped]), [old, skipped]); await tick();
  const current = root([next]); value.observe(current, [next]); oldGate.resolve('FAKE-OLD'); await drained(value);
  assert.deepEqual(rendered, [old.documentId + ':' + old.revision, next.documentId + ':' + next.revision]);
  assert.equal(current.buttons[0].img.src, 'FAKE-NEW'); assert.equal(value.pending.size, 0); assert.equal(value.cache.has(skipped.key), false);
});

test('FAKE source identity mismatches are errors and never reach the renderer', async t => {
  for (const field of ['resource_id', 'document_id', 'scene_revision']) {
    const e = entry(), host = root([e]); let renders = 0;
    const value = manager(t, { loadScene: async () => ({ ...scene(e), [field]: 'wrong' }), render: async () => { renders++; return 'BAD'; } });
    value.observe(host, [e]); await drained(value);
    assert.equal(renders, 0, field); assert.equal(host.buttons[0].dataset.previewState, 'error', field); assert.equal(host.buttons[0].img.hidden, true); assert.equal(host.buttons[0].disabled, false);
  }
});

test('FAKE transient screenshot failures retain clickable cards and become retryable after the cooldown', async t => {
  let now = 10_000, calls = 0; t.mock.method(Date, 'now', () => now);
  const e = entry(), host = root([e]); let opens = 0; host.buttons[0].onclick = () => opens++;
  const value = manager(t, { render: async () => { if (++calls === 1) throw Error('FAKE GPU unavailable'); return 'FAKE-RETRY'; } });
  value.observe(host, [e]); await drained(value); host.buttons[0].onclick();
  assert.equal(opens, 1); assert.equal(host.buttons[0].disabled, false); assert.equal(host.buttons[0].dataset.previewState, 'error');
  now += 29_999; value.observe(host, [e]); await drained(value); assert.equal(calls, 1);
  now += 2; value.observe(host, [e]); await drained(value);
  assert.equal(calls, 2); assert.equal(host.buttons[0].dataset.previewState, 'ready'); assert.equal(host.buttons[0].img.hidden, false); assert.equal(host.buttons[0].status.textContent, '');
});

test('FAKE bounded cache evicts the oldest image and never substitutes a different document', async t => {
  const entries = [entry('a'), entry('b'), entry('c')]; let renders = 0;
  const value = manager(t, { limit: 2, render: async s => { renders++; return `FAKE:${s.resource_id}`; } });
  value.observe(root(entries), entries); await drained(value);
  assert.deepEqual([...value.cache.keys()], entries.slice(1).map(e => e.key));
  const a = root([entries[0]]); value.observe(a, [entries[0]]); await drained(value);
  assert.equal(renders, 4); assert.equal(a.buttons[0].img.src, 'FAKE:a'); assert.equal(value.cache.size, 2);
});

test('FAKE clear fences in-flight source reads and allows a new generation of the same key', async t => {
  const e = entry(), read = deferred(); let reads = 0, renders = 0;
  const value = manager(t, { loadScene: async () => ++reads === 1 ? read.promise : scene(e), render: async () => { renders++; return 'FAKE-CURRENT'; } });
  const old = root([e]); value.observe(old, [e]); await tick(); value.clear();
  assert.equal(value.cache.size, 0); assert.equal(value.pending.size, 0); assert.equal(value.root, null);
  const current = root([e]); value.observe(current, [e]); read.resolve(scene(e)); await drained(value);
  assert.equal(reads, 2); assert.equal(renders, 1); assert.equal(current.buttons[0].img.src, 'FAKE-CURRENT'); assert.equal(old.buttons[0].img.src, '');
});

test('FAKE clear fences an in-flight screenshot result, including a repeated identical key', async t => {
  const e = entry(), image = deferred(); let renders = 0;
  const value = manager(t, { render: async () => ++renders === 1 ? image.promise : 'FAKE-CURRENT' });
  const old = root([e]); value.observe(old, [e]); await tick(); value.clear();
  const current = root([e]); value.observe(current, [e]); image.resolve('FAKE-STALE'); await drained(value);
  assert.equal(renders, 2); assert.equal(value.cache.get(e.key).url, 'FAKE-CURRENT'); assert.equal(current.buttons[0].img.src, 'FAKE-CURRENT'); assert.equal(old.buttons[0].img.src, '');
});

test('FAKE dispose permanently fences delayed success and failure and does not enqueue again', async t => {
  for (const reject of [false, true]) {
    const e = entry(), image = deferred(), host = root([e]); let calls = 0;
    const value = manager(t, { render: async () => { calls++; return image.promise; } });
    value.observe(host, [e]); await tick(); value.dispose();
    if (reject) image.reject(Error('FAKE late failure')); else image.resolve('FAKE-STALE');
    await drained(value); value.observe(host, [e]);
    assert.equal(value.cache.size, 0); assert.equal(value.pending.size, 0); assert.equal(value.queue.length, 0); assert.equal(host.buttons[0].img.src, ''); assert.equal(calls, 1);
  }
});

test('FAKE IntersectionObserver renders only approaching cards and disconnects on refresh/clear', async t => {
  const observers = [], calls = [];
  class FakeObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; this.elements = []; observers.push(this); }
    observe(element) { this.elements.push(element); }
    unobserve(element) { this.elements = this.elements.filter(x => x !== element); }
    disconnect() { this.disconnected = true; this.elements = []; }
  }
  const value = manager(t, { render: async s => { calls.push(s.resource_id); return `FAKE:${s.resource_id}`; } });
  globalThis.IntersectionObserver = FakeObserver;
  const entries = [entry('a'), entry('b')], host = root(entries); value.observe(host, entries);
  assert.equal(calls.length, 0); assert.equal(value.viewer, null); assert.equal(observers[0].options.root, host);
  observers[0].callback([{ target: host.buttons[0], isIntersecting: false }]); await tick(); assert.equal(calls.length, 0);
  observers[0].callback([{ target: host.buttons[1], isIntersecting: true }]); await drained(value); assert.deepEqual(calls, ['b']);
  value.observe(host, entries); assert.equal(observers[0].disconnected, true);
  value.clear(); assert.equal(observers[1].disconnected, true);
});

function rendererDom(t, { autoFrames = true, blank = false } = {}) {
  const listeners = new Set(), frames = [], hosts = [], drawn = [], raf = [];
  const emit = (frame, packet) => { for (const listener of listeners) listener({ origin, source: frame.contentWindow, data: { source: 'world-atelier-preview', nonce: new URL(frame.src, origin).searchParams.get('nonce'), ...packet } }); };
  const document = {
    body: { append(host) { hosts.push(host); } },
    createElement(tag) {
      if (tag === 'iframe') {
        const canvas = { width: 384, height: 288, scene: null };
        const frame = { setAttribute() {}, remove() { this.removed = true; }, contentDocument: { querySelector: () => canvas } };
        frame.contentWindow = {
          requestAnimationFrame(callback) { raf.push(callback); if (autoFrames) queueMicrotask(callback); },
          postMessage(packet) { canvas.scene = packet; queueMicrotask(() => emit(frame, { type: 'loaded', seq: packet.seq, document_id: packet.document_id })); }
        };
        Object.defineProperty(frame, 'src', { get() { return this.url; }, set(url) { this.url = url; queueMicrotask(() => emit(frame, { type: 'ready' })); } });
        frames.push(frame); return frame;
      }
      if (tag === 'canvas') {
        let target;
        return { getContext: () => ({ drawImage(canvas) { target = structuredClone(canvas.scene); drawn.push(target); }, getImageData: () => ({ data: new Uint8ClampedArray(blank ? [0, 0, 0, 0] : [60, 70, 80, 255]) }) }), toDataURL: () => `FAKE:${target.document_id}:${target.scene_revision}` };
      }
      return { dataset: {}, setAttribute() {}, append() {}, remove() { this.removed = true; } };
    }
  };
  globals(t, { document, location: { origin }, window: { addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) }, fetch: async () => ({ ok: true, json: async () => ({ build_id: 'a'.repeat(64) }) }) });
  return { frames, hosts, drawn, raf, listeners };
}

test('FAKE production renderer is lazy, shared across cards, readonly, fixed-version and released when idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = rendererDom(t), entries = [entry('a'), entry('b')], value = manager(t, { render: undefined });
  assert.equal(dom.frames.length, 0); value.observe(root(entries), entries); await drained(value);
  assert.equal(dom.frames.length, 1); assert.equal(dom.hosts.length, 1); assert.equal(dom.raf.length, 4);
  assert.match(dom.frames[0].src, /^\/prefab-preview\.html\?build=a{64}&nonce=.+&mode=object$/);
  assert.deepEqual(dom.drawn.map(s => s.document_id), entries.map(e => e.documentId));
  assert.ok(dom.drawn.every(s => !s.editable && s.selected_id === '' && s.frame)); assert.equal(dom.hosts[0].inert, true);
  t.mock.timers.tick(1500); assert.equal(value.viewer, null); assert.equal(dom.frames[0].removed, true); assert.equal(dom.hosts[0].removed, true); assert.equal(dom.listeners.size, 0);
});

test('FAKE canvas waits two frames; clear removes the renderer before a delayed frame can paint', async t => {
  const dom = rendererDom(t, { autoFrames: false }), e = entry(), host = root([e]), value = manager(t, { render: undefined });
  value.observe(host, [e]); await tick(); assert.equal(dom.raf.length, 1); assert.equal(dom.drawn.length, 0);
  dom.raf[0](); await tick(); assert.equal(dom.raf.length, 2); assert.equal(dom.drawn.length, 0);
  value.clear(); assert.equal(dom.frames[0].removed, true); dom.raf[1](); await drained(value);
  assert.equal(dom.drawn.length, 0); assert.equal(host.buttons[0].img.src, ''); assert.equal(value.cache.size, 0);
});

test('FAKE stalled animation frame times out and releases the engine instead of blocking the queue forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = rendererDom(t, { autoFrames: false }), e = entry(), host = root([e]), value = manager(t, { render: undefined });
  value.observe(host, [e]); await tick(); t.mock.timers.tick(2000); await drained(value);
  assert.equal(host.buttons[0].dataset.previewState, 'error'); assert.equal(host.buttons[0].disabled, false); assert.equal(dom.frames[0].removed, true); assert.equal(value.viewer, null);
});

test('FAKE transparent/black capture is rejected and never advertised as a ready image', async t => {
  const dom = rendererDom(t, { blank: true }), e = entry(), host = root([e]), value = manager(t, { render: undefined });
  value.observe(host, [e]); await drained(value);
  assert.equal(host.buttons[0].dataset.previewState, 'error'); assert.equal(host.buttons[0].img.hidden, true); assert.equal(dom.frames[0].removed, true);
});

function explorerFixture(t, { focused = false } = {}) {
  const e = entry(), host = root([e]), value = manager(t, { render: async () => { throw Error('FAKE capture failure'); } });
  // The full catalog and the compact shelf now share the explorer observer root.
  // This fixture opens the full catalog, so the shelf has no thumbnail buttons.
  const shelf = root([]);
  const nodes = new Map([
    ['#explorerList', host], ['.explorer', host], ['#contentSearch', { value: '' }],
    ['#prefabShelfList', shelf], ['#prefabShelf', {classList:{toggle(){}}}],
    ['#browsePrefabs', {textContent:'',dataset:{}}],
  ]), opened = [], focusCalls = [];
  host.buttons[0].focus = options => focusCalls.push(options);
  host.removeAttribute = key => { delete host.attributes[key]; };
  host.contains = element => focused && element?.dataset.resource === e.resourceId;
  const summary = { focus() { this.focused = true; } }, menu = { open: true, querySelector: () => summary }, selectAll = host.querySelectorAll;
  host.querySelectorAll = query => query === '.prefab-card-menu' ? [menu] : selectAll.call(host, query);
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); };
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const start = workspace.indexOf('function renderExplorer(){'), end = workspace.indexOf('\nfunction ensurePrefabPlacement(', start);
  assert.ok(start >= 0 && end > start);
  const run = Function('$', '$$', 'document', 'prefabThumbnails', 'prefabThumbnailKey', 'openResource', 'esc', `
    const prefab={id:'beacon',name:'Beacon <unsafe>',kind:'prefab',version:'prefab-1'}, branch={branch_id:'main',head:'head-1',manifest:{resources:{beacon:prefab}}}, project={id:'project'};
    const doc=()=>prefab, resourceId='beacon',mode='edit',modePending=false,explorerTab='prefabs',isHierarchy=()=>true,editable=()=>true,hierarchyEnabled=true,icon=()=>'<svg></svg>',report=error=>{throw error};
    const ensurePrefabPlacement=()=>{},selectedSemanticObjects=()=>[],semanticComposer=null,renderSceneList=()=>{},isNative=()=>false;
    ${workspace.slice(start, end)}
    renderExplorer();
  `);
  run($, () => [], { activeElement: focused ? { dataset: { resource: e.resourceId } } : null }, value, prefabThumbnailKey, async id => opened.push(id), esc);
  return { host, value, opened, focusCalls, menu, summary };
}

test('actual explorer creates accessible image open buttons and preserves open behavior on failed previews', async t => {
  const { host, value, opened } = explorerFixture(t);
  await drained(value);
  assert.match(host.innerHTML, /<button type="button" class="prefab-picture"/); assert.match(host.innerHTML, /aria-label="打开预制件 Beacon &lt;unsafe&gt;"/); assert.match(host.innerHTML, /<h3[^>]*>(?:<svg><\/svg>)?Beacon &lt;unsafe&gt;<\/h3>/); assert.doesNotMatch(host.innerHTML, /<unsafe>/);
  assert.match(host.innerHTML, /<article role="listitem"/);
  assert.equal(host.buttons[0].dataset.previewState, 'error'); await host.buttons[0].onclick();
  assert.deepEqual(opened, ['beacon']); assert.equal(host.scrollTop, 43); assert.equal(host.buttons[0].disabled, false);
});

test('actual explorer preserves image keyboard focus without scrolling and Escape returns focus to the menu summary', async t => {
  const { value, host, focusCalls, menu, summary } = explorerFixture(t, { focused: true });
  await drained(value);
  assert.deepEqual(focusCalls, [{ preventScroll: true }]); assert.equal(host.scrollTop, 43);
  let prevented = 0, stopped = 0;
  menu.onkeydown({ key: 'Escape', preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.equal(menu.open, false); assert.equal(summary.focused, true); assert.equal(prevented, 1); assert.equal(stopped, 1);
});

test('persistent JPEG cache survives manager recreation, isolates user/build/revision and reauthorizes hits', async t => {
  const rows=new Map(),storage={getItem:k=>rows.get(k),setItem:(k,v)=>rows.set(k,v)},disk=new ThumbnailImageCache({storage:()=>storage});
  let build='a'.repeat(64),scope='user-a',renders=0,reads=0,denied=false;
  globals(t,{fetch:async()=>({ok:true,json:async()=>({build_id:build})})});
  const options={persistentCache:disk,cacheScope:()=>scope,loadScene:async e=>{reads++;if(denied)throw Error('403');return scene(e);},render:async()=>{renders++;return 'data:image/jpeg;base64,YWJj';}};
  const show=async(e=entry())=>{const value=manager(t,options),host=root([e]);value.observe(host,[e]);await drained(value);return host.buttons[0];};
  assert.equal((await show()).dataset.previewState,'ready');assert.equal(renders,1);
  assert.equal((await show()).dataset.previewState,'ready');assert.equal(renders,1);assert.equal(reads,2);
  scope='user-b';await show();assert.equal(renders,2);
  build='b'.repeat(64);await show();assert.equal(renders,3);
  await show(entry('beacon','head-2'));assert.equal(renders,4);
  denied=true;assert.equal((await show()).dataset.previewState,'error');assert.equal(renders,4);
});

test('persistent cache tolerates corrupt/unavailable storage and bounds all revisions by LRU and bytes',()=>{
  let data='broken JSON';const storage={getItem:()=>data,setItem:(_k,v)=>{data=v;}};
  const cache=new ThumbnailImageCache({storage:()=>storage,limit:2,maxBytes:1000}),url='data:image/jpeg;base64,YWJj';
  assert.equal(cache.get('a'),null);cache.set('a',url);cache.set('b',url);cache.get('a');cache.set('c',url);
  assert.equal(cache.get('b'),null);assert.equal(cache.get('a'),url);assert.equal(cache.get('c'),url);
  cache.set('oversize','data:image/jpeg;base64,'+'a'.repeat(1000));assert.ok(data.length*2<=1000);assert.equal(cache.get('oversize'),null);
  cache.set('error','error');assert.equal(cache.get('error'),null);
  const unavailable=new ThumbnailImageCache({storage:()=>{throw Error('denied');}});assert.equal(unavailable.get('a'),null);assert.doesNotThrow(()=>unavailable.set('a',url));
  storage.setItem=()=>{throw Error('quota');};assert.doesNotThrow(()=>cache.set('a',url));
});

test('clear fences a pending manifest fetch before any persistent image can be painted or written',async t=>{
  const manifest=deferred();let writes=0,gets=0;
  globals(t,{fetch:()=>manifest.promise});
  const e=entry(),host=root([e]),value=manager(t,{cacheScope:()=> 'user',persistentCache:{get:()=>{gets++;return 'data:image/jpeg;base64,YWJj';},set:()=>writes++}});
  value.observe(host,[e]);await tick();value.clear();manifest.resolve({ok:true,json:async()=>({build_id:'a'.repeat(64)})});await drained(value);
  assert.equal(writes,0);assert.equal(gets,0);assert.equal(host.buttons[0].img.src,'');
});

test('native persistent JPEG hits bypass renderer creation and legacy manifest on reentry and refresh',async t=>{
  const rows=new Map(),disk=new ThumbnailImageCache({storage:()=>({getItem:k=>rows.get(k),setItem:(k,v)=>rows.set(k,v)})});
  let reads=0,renders=0,viewers=0,scope='user-a',source='a'.repeat(64),renderer='b'.repeat(64),path='res://beacon.tscn',denied=false;
  globals(t,{fetch:async()=>{throw Error('Native cache must not fetch the legacy runtime');},document:{body:{append(){}},createElement:()=>({setAttribute(){},remove(){}})}});
  const options={persistentCache:disk,cacheScope:()=>scope,
    loadScene:async e=>{reads++;if(denied)throw Error('403');return {...scene(e),document_schema:'creation-native-1',source_identity:source,native_scene_path:path,thumbnail_renderer_identity:renderer};},
    render:undefined,viewerFactory:()=>{viewers++;return {snapshot:async()=>{renders++;return 'data:image/jpeg;base64,YWJj';},dispose(){}};}};
  const show=async(value=manager(t,options),e=entry())=>{const host=root([e]);value.observe(host,[e]);await drained(value);assert.equal(host.buttons[0].dataset.previewState,denied?'error':'ready');return value;};
  const first=await show();assert.equal(renders,1);assert.equal(disk.read().length,1);
  first.clear();await show(first);assert.equal(renders,1);assert.equal(viewers,1);
  await show();assert.equal(renders,1);assert.equal(reads,3);
  scope='user-b';await show();assert.equal(renders,2);
  source='c'.repeat(64);await show();assert.equal(renders,3);
  renderer='d'.repeat(64);await show();assert.equal(renders,4);
  path='res://other.tscn';await show();assert.equal(renders,5);
  await show(undefined,entry('beacon','head-2'));assert.equal(renders,6);
  denied=true;await show();assert.equal(renders,6);assert.equal(viewers,6);
});

test('native cache requires complete server identity and fences delayed source reads across clear or account changes',async t=>{
  const e=entry(),native={...scene(e),document_schema:'creation-native-1',source_identity:'a'.repeat(64),native_scene_path:'res://beacon.tscn',thumbnail_renderer_identity:'b'.repeat(64)};
  for(const field of ['source_identity','thumbnail_renderer_identity','native_scene_path']){
    let gets=0,sets=0,renders=0;
    const value=manager(t,{cacheScope:()=> 'user',loadScene:async()=>({...native,[field]:undefined}),persistentCache:{get:()=>{gets++;},set:()=>sets++},render:async()=>{renders++;return 'data:image/jpeg;base64,YWJj';}});
    value.observe(root([e]),[e]);await drained(value);assert.equal(gets,0);assert.equal(sets,0);assert.equal(renders,1);
  }
  for(const action of ['clear','account']){
    let gets=0,sets=0,renders=0,scope='user-a';const gate=deferred(),host=root([e]);
    const value=manager(t,{cacheScope:()=>scope,loadScene:()=>gate.promise,persistentCache:{get:()=>{gets++;return 'data:image/jpeg;base64,YWJj';},set:()=>sets++},render:async()=>{renders++;return 'data:image/jpeg;base64,YWJj';}});
    value.observe(host,[e]);await tick();if(action==='clear')value.clear();else scope='user-b';
    gate.resolve(native);await drained(value);assert.equal(gets,0);assert.equal(sets,0);assert.equal(renders,0);assert.equal(host.buttons[0].img.src,'');
  }
});
