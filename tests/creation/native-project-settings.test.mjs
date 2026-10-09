import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLaunchSettings} from '../../services/creation/native-snapshot.mjs';
import {nativeSourceSettingsFromWorkspace} from '../../services/creation/native-project-settings.mjs';

test('project settings roundtrip removes unchanged launch overlay and preserves actual authored changes',()=>{
  const original='config_version=5\n[application]\nconfig/name="Author"\nrun/main_scene="res://main.tscn"\n[autoload]\nAuthor="*res://author.gd"\n[rendering]\ncustom/unknown=Vector3(1, 2, 3)\n';
  const fixed=nativeLaunchSettings(original,{namespace:'p:main'});
  const edited=fixed.replace('custom/unknown=Vector3(1, 2, 3)','custom/unknown=Vector3(4, 5, 6)').replace('[autoload]','[autoload]\nNewSystem="*res://new.gd"');
  const source=nativeSourceSettingsFromWorkspace(original,fixed,edited);
  assert.match(source,/config\/name="Author"/);assert.match(source,/run\/main_scene="res:\/\/main.tscn"/);
  assert.doesNotMatch(source,/GameRuntime=|import_etc2_astc=|import_s3tc_bptc=|convert_text_resources_to_binary=/);
  assert.match(source,/Author="\*res:\/\/author.gd"/);assert.match(source,/NewSystem="\*res:\/\/new.gd"/);assert.match(source,/custom\/unknown=Vector3\(4, 5, 6\)/);
  const changedMain=nativeSourceSettingsFromWorkspace(original,fixed,fixed.replace('run/main_scene="res://atelier_runtime/standalone.tscn"','run/main_scene = "res://other.tscn"'));
  assert.match(changedMain,/run\/main_scene = "res:\/\/other.tscn"/);
});

test('native export retains authored scene resources while workspace submission restores the original export preference',()=>{
  for(const authored of ['', '[editor]\nexport/convert_text_resources_to_binary=true\n', '[editor]\nexport/convert_text_resources_to_binary=false\n']){
    const original='config_version=5\n'+authored;
    const fixed=nativeLaunchSettings(original);
    assert.match(fixed,/export\/convert_text_resources_to_binary=false/);
    assert.doesNotMatch(fixed,/export\/convert_text_resources_to_binary=true/);
    const source=nativeSourceSettingsFromWorkspace(original,fixed,fixed);
    if(authored)assert.match(source,new RegExp('export/convert_text_resources_to_binary='+authored.includes('=true')));
    else assert.doesNotMatch(source,/convert_text_resources_to_binary=/);
  }
});

test('an author Autoload using the framework name is rejected without overwriting it',()=>{
  assert.throws(()=>nativeLaunchSettings('config_version=5\n[autoload]\nGameRuntime="*res://author.gd"\n'),/保留名称/);
});
