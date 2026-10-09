import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';

function fixture(t,hierarchy){
  const dir=mkdtempSync(join(tmpdir(),'wa-resource-rename-')),store=new CreationStore(join(dir,'test.sqlite'));
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  const owner=store.register({name:'owner',password:'test-password'}).user,viewer=store.register({name:'viewer',password:'test-password'}).user;
  const object={id:'core',name:'内部节点名称',kind:'anchor',position:[1,2,3],rotation:[0,10,0],scale:[1,1,1],solid:false,components:{}};
  const {project}=store.createProject(owner,{name:'资源名称测试'},{entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'场景',objects:[]},prefab:{id:'prefab',kind:'prefab',name:'原定义',custom_metadata:{keep:true},objects:[object]}}});
  store.setMember(owner,project.id,viewer.id,'viewer');
  const head=()=>store.branchView(owner,project.id,'main');
  const submit=(ops,{user=owner,base=head().head,transaction_id=randomUUID(),...extra}={})=>store.apply(user,project.id,'main',{transaction_id,base_revision:base,ops,...extra});
  if(hierarchy)submit([{type:'migrate_hierarchy'}],{expected_head:head().head});
  const rename=(name,expected_version=head().manifest.resources.prefab.version)=>({type:'rename_resource',resource_id:'prefab',expected_version,name});
  return {store,project,owner,viewer,head,submit,rename};
}

for(const hierarchy of [false,true]){
  const kind=hierarchy?'hierarchy':'flat';
  test(`${kind}: resource rename preserves node identity and metadata, advances source and supports guarded undo`,t=>{
    const f=fixture(t,hierarchy),before=f.head(),original=before.manifest.resources.prefab;
    const result=f.submit([f.rename('  新定义  ')]),renamed=f.head().manifest.resources.prefab;
    assert.equal(renamed.name,'新定义');assert.notEqual(renamed.version,original.version);assert.notEqual(result.revision,before.head);
    assert.deepEqual({...renamed,name:original.name,version:original.version},original);
    assert.deepEqual(result.changed_resources,['prefab']);assert.equal(result.branch.doc_sequences.prefab,before.doc_sequences.prefab+1);
    if(hierarchy){assert.deepEqual(result.branch.manifest.prefab_revisions[original.version],original);assert.deepEqual(result.branch.manifest.prefab_revisions[renamed.version],renamed);}
    const undone=f.submit(result.inverse),restored=undone.branch.manifest.resources.prefab;
    assert.deepEqual({...restored,version:original.version},original);
    assert.throws(()=>f.submit(result.inverse),error=>error.status===409);
  });
  test(`${kind}: stale rename and invalid names reject atomically without partial source updates`,t=>{
    const f=fixture(t,hierarchy),before=f.head(),oldVersion=before.manifest.resources.prefab.version;
    f.submit([f.rename('同事的名称')]);const current=f.head();
    assert.throws(()=>f.submit([f.rename('旧编辑',oldVersion)],{base:before.head}),error=>error.status===409);
    for(const name of [undefined,null,17,'','  ','x'.repeat(161)])assert.throws(()=>f.submit([f.rename(name)]),error=>error.status===400);
    assert.throws(()=>f.submit([f.rename('不应部分提交'),{type:'rename_resource',resource_id:'scene',expected_version:current.manifest.resources.scene.version,name:''}]),error=>error.status===400);
    assert.equal(f.head().head,current.head);assert.deepEqual(f.head().manifest,current.manifest);
  });
  test(`${kind}: viewer cannot rename and lost edit permission blocks receipt replay`,t=>{
    const f=fixture(t,hierarchy),ops=[f.rename('授权修改')],transaction_id=randomUUID(),base=f.head().head;
    assert.throws(()=>f.submit(ops,{user:f.viewer}),error=>error.status===403);
    f.store.setMember(f.owner,f.project.id,f.viewer.id,'editor');
    const result=f.submit(ops,{user:f.viewer,transaction_id,base});
    assert.equal(f.submit(ops,{user:f.viewer,transaction_id,base}).replayed,true);
    f.store.setMember(f.owner,f.project.id,f.viewer.id,'viewer');
    assert.throws(()=>f.submit(ops,{user:f.viewer,transaction_id,base}),error=>error.status===403);
    assert.equal(f.head().head,result.revision);
  });
}
