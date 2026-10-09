import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CreationStore} from '../../services/creation/store.mjs';
import {RevisionReads} from '../../services/creation/revision-reads.mjs';
import {CreationInbox} from '../../services/creation/inbox.mjs';
import {hash} from '../../services/creation/schema.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'wa-revision-reads-')),store=new CreationStore(join(dir,'test.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;
}
const revision=(id,parents=[],extra={})=>({id,parents,project_id:'p',created_at:100,manifest:{schema:'creation-native-1',resources:{scene:{id:'scene',kind:'scene',unknown:{value:1}},other:{id:'other',kind:'scene'},prefab:{id:'prefab',kind:'prefab',native_nodes:[]}},...extra}});

test('revision reads retain immutable snapshots and leave ordinary get mutable',t=>{
  const store=fixture(t);store.put('creator_revision',revision('r1'));
  const fixed=store.readRevision('r1');assert.equal(store.readRevision('r1'),fixed);
  assert.throws(()=>fixed.manifest.resources.scene.unknown.value=2,TypeError);
  const editable=store.get('creator_revision','r1');editable.manifest.resources.scene.unknown.value=3;
  assert.equal(store.readRevision('r1').manifest.resources.scene.unknown.value,1);
  store.put('creator_revision',editable);
  assert.equal(store.readRevision('r1').manifest.resources.scene.unknown.value,3);
  assert.equal(fixed.manifest.resources.scene.unknown.value,1);
});

test('revision metadata and signatures are invalidated by removal and rolled-back writes',t=>{
  const store=fixture(t);store.put('creator_revision',revision('r1'));
  const signature=store.revisionResourceSignature('r1','scene');store.revisionMeta('r1');
  assert.throws(()=>store.transaction(()=>{
    const next=revision('r1',['not-committed']);next.manifest.resources.scene.unknown.value=8;
    store.put('creator_revision',next);
    assert.notEqual(store.revisionResourceSignature('r1','scene'),signature);
    assert.deepEqual(store.revisionMeta('r1').parents,['not-committed']);
    throw Error('rollback');
  }),/rollback/);
  assert.deepEqual(store.revisionMeta('r1').parents,[]);
  assert.equal(store.revisionResourceSignature('r1','scene'),signature);
  store.remove('creator_revision','r1');assert.equal(store.readRevision('r1'),null);assert.equal(store.revisionMeta('r1'),null);assert.equal(store.revisionResourceSignature('r1','scene'),null);
});

test('lineage metadata stays small and follows each live branch head',t=>{
  const store=fixture(t);store.put('creator_revision',revision('base'));store.put('creator_revision',revision('a',['base']));store.put('creator_revision',revision('b',['base']));
  assert.equal(store.ancestor('base','a'),true);assert.equal(store.ancestor('a','b'),false);
  assert.equal('manifest' in store.revisionMeta('a'),false);
  store.put('creator_revision',revision('a',['b']));assert.equal(store.ancestor('b','a'),true);
});

test('resource signatures preserve complete old equality semantics including unknown fields and every prefab',t=>{
  const store=fixture(t),inbox=new CreationInbox({store});
  const original=revision('base'),variants=[];
  for(const change of [r=>{},r=>r.manifest.resources.other.extra=7,r=>r.manifest.resources.scene.unknown.value=2,r=>r.manifest.resources.prefab.unknown={future:3},r=>delete r.manifest.resources.scene,r=>r.manifest.schema='creation-hierarchy-2']){
    const value=structuredClone(original);value.id='v'+variants.length;change(value);variants.push(value);
  }
  store.put('creator_revision',original);
  const old=(m,rid)=>m.resources[rid]&&hash({schema:m.schema,resource:m.resources[rid],prefabs:Object.values(m.resources).filter(r=>r.kind==='prefab').sort((a,b)=>a.id.localeCompare(b.id))});
  for(const value of variants){store.put('creator_revision',value);const expected=Boolean(value.manifest.resources.scene)&&old(original.manifest,'scene')===old(value.manifest,'scene');
    for(let n=0;n<2;n++)assert.equal(inbox.resourceContextUnchanged({revision:'base',resource_id:'scene'},value.id),expected,value.id);
  }
  assert.equal(inbox.resourceContextUnchanged({revision:'base',resource_id:'missing'},'base'),false);
});

test('revision payload cache has byte and entry bounds and evicted snapshots can be reloaded',t=>{
  const store=fixture(t),reads=new RevisionReads(store,{maxBytes:1800,maxEntries:1});
  for(let n=0;n<4;n++)store.put('creator_revision',revision('r'+n));
  const first=reads.read('r0');for(let n=1;n<4;n++){reads.read('r'+n);assert(reads.bytes<=1800);assert(reads.documents.size<=1);}
  assert.deepEqual(reads.read('r0'),first);
  store.put('creator_revision',revision('huge',[],{unknown:'x'.repeat(2000)}));reads.read('huge');assert(!reads.documents.has('huge'));assert(reads.bytes<=1800);
});
