import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CreationStore} from '../../services/creation/store.mjs';
import {NativeProjects} from '../../services/creation/native-project.mjs';

test('ordinary Godot import discovers every scene and source main settings control default entry',{timeout:180000},async t=>{
  const data=mkdtempSync(join(tmpdir(),'wa-native-catalog-')),store=new CreationStore(join(data,'creation.sqlite')),native=new NativeProjects({store,data});
  t.after(async()=>{await native.close();store.close();rmSync(data,{recursive:true,force:true});});
  const texts={'project.godot':'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n','main.tscn':'[gd_scene format=3]\n[node name="Main" type="Node3D"]\n','unplaced.tscn':'[gd_scene format=3]\n[node name="Unplaced" type="Node3D"]\n','.gitignore':'.godot/\n','.editorconfig':'root=true\n'};
  const files=Object.fromEntries(Object.entries(texts).map(([path,text])=>[path,native.archive.put(text)]));
  const first=await native.inspectFiles(files,{assignIds:true});
  assert.equal(Object.keys(first.resources).length,2);assert.equal(first.resources[first.entry_scene_id].path,'main.tscn');
  const prefab=Object.values(first.resources).find(resource=>resource.path==='unplaced.tscn');assert.equal(prefab.kind,'prefab');
  assert.equal(native.archive.read(first.source_files['.gitignore']).toString(),texts['.gitignore']);
  assert.ok(first.resources[first.entry_scene_id].native_nodes[0].node_id);
  const changed=native.archive.applyFiles(first.source_files,[{type:'put_source_file',path:'project.godot',expected_hash:first.source_files['project.godot'].hash,text:texts['project.godot'].replace('main.tscn','unplaced.tscn')}]);
  const second=await native.inspectFiles(changed.files,{assignIds:true});
  assert.equal(second.entry_scene_id,prefab.id);assert.equal(second.resources[prefab.id].kind,'scene');
  const rebuilt=await native.inspectFiles(second.source_files);assert.equal(rebuilt.source_identity,second.source_identity);
  assert.equal(rebuilt.resources[prefab.id].version,second.resources[prefab.id].version);
});
