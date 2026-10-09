import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CreationStore } from '../../services/creation/store.mjs';
import { CreationAssets } from '../../services/creation/assets.mjs';
import { prepareExecutionEnvironment } from '../../services/creation/execution-environment.mjs';
const root=resolve(import.meta.dirname,'../..');
test('real Godot accepts supported hierarchy feature subset and rejects unknown or malformed requirements',()=>{
  const base=mkdtempSync(join(tmpdir(),'atelier-canonical-capabilities-')),data=join(base,'data'),project=join(base,'project'),store=new CreationStore(join(data,'creation.sqlite'));
  try{
    const owner={id:'capability-owner'};store.put('creator_user',{...owner,name:'Capability owner'});
    const created=store.createProject(owner,{name:'Actual hierarchy capability validation'},{entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'Scene',objects:[]}}}),id=created.project.id;
    store.apply(owner,id,'main',{transaction_id:'migrate-capabilities',base_revision:created.branch.head,expected_head:created.branch.head,ops:[{type:'migrate_hierarchy'}]});
    const assets=new CreationAssets({store,root,data}),branch=store.branchView(owner,id,'main'),capabilities=JSON.parse(readFileSync(join(root,'runtimes/model-preview/runtime_capabilities.json'))),scene=assets.scene(owner,id,branch,'scene','',capabilities);
    assert.ok(capabilities.features.length>scene.hierarchy_pack.required_capabilities.length);
    mkdirSync(project);writeFileSync(join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Isolated capability validator"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    for(const file of ['hierarchy_scene.gd','runtime_capabilities.gd','runtime_capabilities.json'])cpSync(join(root,'runtimes/model-preview',file),join(project,file));
    writeFileSync(join(project,'scene.json'),JSON.stringify(scene));
    writeFileSync(join(project,'probe.gd'),`extends SceneTree
const Graph=preload("res://hierarchy_scene.gd")
func reseal(scene: Dictionary) -> void:
	var unsigned=scene.hierarchy_pack.duplicate(true)
	unsigned.erase("pack_hash")
	scene.hierarchy_pack_canonical=JSON.stringify(unsigned)
	scene.hierarchy_pack.pack_hash=scene.hierarchy_pack_canonical.sha256_text()
func _initialize() -> void:
	var scene=JSON.parse_string(FileAccess.get_file_as_string("res://scene.json"))
	var supported=Graph.validate(scene,"")
	var bad=scene.duplicate(true)
	bad.hierarchy_pack.required_capabilities.append("future-unsupported-required-feature")
	reseal(bad)
	var unknown=Graph.validate(bad,"")
	bad.hierarchy_pack.required_capabilities={"malformed":true}
	reseal(bad)
	var malformed=Graph.validate(bad,"")
	print("CAPABILITY_VALIDATION "+JSON.stringify({"supported":supported,"unknown":unknown,"malformed":malformed}))
	quit(0 if supported=="" and unknown=="unsupported hierarchy capabilities" and malformed=="unsupported hierarchy capabilities" else 1)
`);
    const isolated=prepareExecutionEnvironment({directory:join(base,'execution'),readPaths:[project]}),invocation=isolated.command(process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot',['--headless','--path',project,'--script','res://probe.gd'],{godot:true,projectPath:project});
    const result=spawnSync(invocation.command,invocation.args,{...invocation.options,encoding:'utf8',timeout:20000});
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.doesNotMatch(result.stdout+'\n'+result.stderr,/ERROR:/);
    const record=result.stdout.split('\n').find(line=>line.startsWith('CAPABILITY_VALIDATION '));assert.ok(record);assert.deepEqual(JSON.parse(record.slice(22)),{supported:'',unknown:'unsupported hierarchy capabilities',malformed:'unsupported hierarchy capabilities'});
  }finally{store.close();rmSync(base,{recursive:true,force:true});}
});
