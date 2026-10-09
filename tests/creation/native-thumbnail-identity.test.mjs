// Independent cache-identity regression. Uses temporary source files and stubbed
// build dependencies; never constructs CreationBuilds, starts Godot, or writes jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {CreationBuilds} from '../../services/creation/export-builds.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'wa-native-thumbnail-identity-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const files={
    'runtimes/model-preview/native_main.gd':'extends Node\n# runtime a\n',
    'runtimes/model-preview/shaders/outline.gdshader':'shader_type spatial;\n',
    'tools/native-editor/bake_preview.gd':'extends SceneTree\n# bake a\n',
    'apps/creation-workspace/native-preview.js':'export const nativeCapture = 1;\n',
    'apps/creation-workspace/preview-bridge.js':'export const jpegCapture = 1;\n'
  };
  for(const [path,content] of Object.entries(files)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),content);}
  let policy='policy-a',toolchain={godot:'godot-a',templates:{web:'template-a'}};
  const calls=[],forbidden=()=>assert.fail('cache identity must not create or prepare a build');
  const receiver={service:{root},directory:join(root,'builds'),
    policyIdentity:()=>policy,
    toolchainIdentity:targets=>{calls.push([...targets]);return toolchain;},
    pin:forbidden,prepareNativePreview:forbidden,update:forbidden,
    store:new Proxy({},{get:forbidden})};
  return {root,files,calls,receiver,
    identify:()=>CreationBuilds.prototype.nativeThumbnailRendererIdentity.call(receiver),
    policy:value=>{policy=value;},toolchain:value=>{toolchain=value;}};
}

function tree(root,path=root){
  return readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const full=join(path,entry.name),name=relative(root,full);
    return entry.isDirectory()?[[name,'directory'],...tree(root,full)]:[[name,readFileSync(full).toString('base64')]];
  });
}

test('native thumbnail identity is stable, asks only for web toolchain, and performs no source snapshot or build write',t=>{
  const f=fixture(t),before=tree(f.root),identity=f.identify();
  assert.match(identity,/^[a-f0-9]{64}$/);
  assert.equal(f.identify(),identity);
  assert.deepEqual(f.calls,[['web'],['web']]);
  assert.deepEqual(tree(f.root),before,'identity lookup leaves the complete temporary tree unchanged');
  assert.equal(existsSync(f.receiver.directory),false,'identity lookup does not initialize a build directory');
});

test('native thumbnail identity invalidates runtime, bake and both capture clients, including added dependencies',t=>{
  const f=fixture(t),original=f.identify();
  for(const [path,content] of Object.entries(f.files)){
    writeFileSync(join(f.root,path),content+'\n// identity changed\n');
    assert.notEqual(f.identify(),original,path+' must invalidate cached pictures');
    writeFileSync(join(f.root,path),content);
    assert.equal(f.identify(),original,path+' restored to its original content restores identity');
  }
  const added=join(f.root,'runtimes/model-preview/new-resource.tres');
  writeFileSync(added,'[gd_resource type="Resource" format=3]\n');
  assert.notEqual(f.identify(),original,'new native runtime dependencies invalidate cached pictures');
  rmSync(added);assert.equal(f.identify(),original);
});

test('native thumbnail identity invalidates changed policy, engine and web export template without preparing a build',t=>{
  const f=fixture(t),original=f.identify();
  f.policy('policy-b');assert.notEqual(f.identify(),original);
  f.policy('policy-a');assert.equal(f.identify(),original);
  f.toolchain({godot:'godot-b',templates:{web:'template-a'}});assert.notEqual(f.identify(),original);
  f.toolchain({godot:'godot-a',templates:{web:'template-b'}});assert.notEqual(f.identify(),original);
  f.toolchain({godot:'godot-a',templates:{web:'template-a'}});assert.equal(f.identify(),original);
  assert.ok(f.calls.every(targets=>targets.length===1&&targets[0]==='web'));
  assert.equal(existsSync(f.receiver.directory),false);
});
