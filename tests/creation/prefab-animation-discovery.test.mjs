import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CreationService} from '../../services/creation/service.mjs';
import {snapshotProjectRuntime,assembleProject} from '../../services/creation/project-snapshot.mjs';
import {importNativeProject} from '../../tools/native-scene/invoke.mjs';
import {prefabLabFixture} from './prefab-lab-fixture.mjs';

test('canonical prefab runtime discovers changing native animations and switches playback', {timeout:180000}, async t => {
  const root=resolve(import.meta.dirname,'../..'), evidence=join(root,'.local/creation-verification/prefab-animation-discovery');
  mkdirSync(evidence,{recursive:true}); const data=mkdtempSync(join(evidence,'case-'));
  const server=createServer(), settings=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'].map(key=>[key,process.env[key]]);
  for(const [key] of settings) process.env[key]='1';
  let service;
  try { service=new CreationService({server,root,data,origin:'http://127.0.0.1:48921'}); }
  finally { for(const [key,value] of settings) if(value===undefined) delete process.env[key]; else process.env[key]=value; }
  t.after(async()=>{await service.close(); console.log('ANIMATION_DISCOVERY_EVIDENCE '+data);});
  const {user}=service.store.register({name:'Animation checks',password:'isolated-animation-checks'});
  const created=await service.createProject(user,{name:'Animation checks'}), projectId=created.project.id;
  const files=prefabLabFixture();
  files['test_scenes/pea-lab/lab.gd']=files['test_scenes/pea-lab/lab.gd']
    .replace('"actions":[','"actions":[{"id":"add_animations"},{"id":"remove_later"},{"id":"replace_frames"},{"id":"rename_frames"},')
    .replace('match id:', 'match id:\n\t\t"add_animations": add_animations()\n\t\t"remove_later": remove_later()\n\t\t"replace_frames": $Subject/Sprite2D.sprite_frames = make_frames("jump")\n\t\t"rename_frames":\n\t\t\t$Subject/Sprite2D.sprite_frames.rename_animation("jump", "run")\n\t\t\t$Subject/Sprite2D.sprite_frames.set_animation_speed("run", 8)')
    .replace('return {"shots":','return {"catalog": animation_catalog(), "advanced": get_node("/root/GameRuntime").debug.prefab_test.animation_time > 0.05, "sprite_frame": $Subject/Sprite2D.frame if has_node("Subject/Sprite2D") else -1, "shots":') + String.raw`
func animation_catalog() -> Array:
	var result: Array = []
	if get_node("/root/GameRuntime").debug.prefab_test != null:
		for row in get_node("/root/GameRuntime").debug.prefab_test.animations: result.append(row.player + ":" + row.name)
	return result
func make_frames(clip_name: String) -> SpriteFrames:
	var frames = SpriteFrames.new()
	frames.remove_animation("default")
	frames.add_animation(clip_name)
	frames.set_animation_speed(clip_name, 4)
	for index in range(4): frames.add_frame(clip_name, GradientTexture2D.new())
	return frames
func add_animations() -> void:
	var sprite = AnimatedSprite2D.new()
	sprite.name = "Sprite2D"
	sprite.sprite_frames = make_frames("idle")
	$Subject.add_child(sprite)
	var sprite3 = AnimatedSprite3D.new()
	sprite3.name = "Sprite3D"
	sprite3.sprite_frames = make_frames("idle")
	$Subject.add_child(sprite3)
	$Subject/AnimationPlayer.get_animation_library("").add_animation("jump", $Subject/AnimationPlayer.get_animation("idle").duplicate())
func remove_later() -> void:
	await get_tree().create_timer(0.2, true).timeout
	$Subject/AnimationPlayer.queue_free()
`;
  const expect=(path,equals)=>({expect:{path,equals}}), command=(action,extra={})=>({command:{action,...extra}}), action=id=>command('action',{action_id:id});
  const select=(player,animation)=>command('animation',{player:'Subject/'+player,animation,play:true});
  const catalog=['Subject/AnimationPlayer:idle','Subject/AnimationPlayer:jump','Subject/AnimationPlayer:shoot','Subject/Sprite2D:idle','Subject/Sprite3D:idle'];
  const steps=[
    expect('observations.catalog',['Subject/AnimationPlayer:idle','Subject/AnimationPlayer:shoot']),
    select('AnimationPlayer','shoot'), expect('playing',true), {wait_frames:8}, expect('observations.advanced',true), expect('paused',true), expect('observations.method_calls',0),
    select('AnimationPlayer','idle'), expect('current.name','idle'), expect('playing',true),
    command('animation_pause'), expect('playing',false), command('resume'), expect('observations.subject_scale',[1,1]),
    action('add_animations'), {wait_frames:40}, expect('observations.catalog',catalog),
    select('Sprite2D','idle'), {wait_frames:20}, expect('observations.advanced',true), expect('current.player','Subject/Sprite2D'),
    select('Sprite3D','idle'), expect('current.player','Subject/Sprite3D'), expect('playing',true),
    action('replace_frames'), {wait_frames:40}, expect('observations.catalog',catalog.map(value=>value.replace('Sprite2D:idle','Sprite2D:jump'))),
    select('Sprite2D','jump'), {wait_frames:20}, expect('observations.advanced',true),
    action('rename_frames'), {wait_frames:40}, expect('observations.catalog',catalog.map(value=>value.replace('Sprite2D:idle','Sprite2D:run'))), select('Sprite2D','run'), expect('duration',.5),
    action('remove_later'), select('AnimationPlayer','shoot'), {wait_frames:40}, expect('current',{}), expect('playing',false), expect('observations.subject_scale',[1,1]),
    expect('observations.catalog',['Subject/Sprite2D:run','Subject/Sprite3D:idle']), expect('observations.method_calls',0), expect('observations.target_hp',100),
  ];
  files['test_scenes/pea-lab/discovery.json']=JSON.stringify({steps});
  const imported=await service.committed(user,projectId,'main',{transaction_id:'animation-fixture',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'import_native_project',files:Object.entries(files).map(([path,value])=>({path,data_base64:Buffer.from(value).toString('base64')}))}]});
  const directory=join(data,'canonical'), snapshot=snapshotProjectRuntime(root,directory);
  await assembleProject({service,user,project_id:projectId,branch_id:'main',revision:imported.revision,entry_scene_id:'pea-lab',directory,runtime_source_hash:snapshot.hash,project_name:'Animation checks',purpose:'prefab_test'});
  await importNativeProject({projectDirectory:directory,godotPath:service.builds.godot,enforceIsolation:true});
  const report=join(data,'report.json');
  let result;
  try { result=await promisify(execFile)(service.builds.godot,['--headless','--audio-driver','Dummy','--path',directory,'--max-fps','60','--log-file',join(data,'engine.log'),'--','--prefab-test-plan=res://test_scenes/pea-lab/discovery.json','--prefab-test-report='+report],{timeout:45000,maxBuffer:4*1024*1024}); }
  catch(error) { result=error; }
  const log=(result.stdout??'')+(result.stderr??''); writeFileSync(join(data,'process.log'),log);
  assert.equal(result.code,undefined,log);
  assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|^ERROR:/m);
  const actual=JSON.parse(readFileSync(report)); assert.equal(actual.ok,true,JSON.stringify(actual));
  assert.equal(actual.steps.length,steps.length); assert.equal(actual.source_revision,imported.revision);
  assert.equal(service.store.branchFor(user,projectId,'main').head,imported.revision);
});
