import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationAssets} from '../../services/creation/assets.mjs';
import {SemanticAuthoring} from '../../services/creation/semantic-authoring.mjs';
import {snapshotProjectRuntime,assembleProject,verifyProjectFiles} from '../../services/creation/project-snapshot.mjs';

// Set PVZ_CANDIDATE_SNAPSHOT to a captured candidate {manifest}; all writes are
// isolated. Source asset directories are read-only inputs (path.delimiter list).
const root=resolve(import.meta.dirname,'../..'),candidate=process.env.PVZ_CANDIDATE_SNAPSHOT;
const scene='scene-harbor',other='scene-independent-copy';
const probe=`extends Node
func _ready() -> void:
 run.call_deferred()
func run() -> void:
 var runtime = get_node("/root/GameRuntime")
 var expected: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://expected.json"))
 var observed: Dictionary = {}
 for scene_id in expected:
  if runtime.current_scene_id != scene_id: runtime.open_scene(scene_id)
  for i in range(1000):
   if runtime.running and runtime.current_scene_id == scene_id and not runtime.loading: break
   await get_tree().process_frame
  if not runtime.running or runtime.current_scene_id != scene_id:
   push_error("canonical scene failed: "+scene_id+" "+runtime.failure)
   get_tree().quit(2)
   return
  var entry: Dictionary = runtime.simulation.behaviors.entries["garden-map:garden-rules"]
  var plants: Dictionary = entry.instance.plant_defs(entry.context)
  var zombies: Dictionary = entry.instance.zombie_defs(entry.context)
  observed[scene_id] = {"plants":plants,"zombies":zombies,"scene_id":runtime.current_scene_id,"revision":runtime.release.revision,"script_hash":entry.hash}
  for family in expected[scene_id]:
   for kind in expected[scene_id][family]:
    for key in expected[scene_id][family][kind]:
     var actual = observed[scene_id][family][kind].get(key)
     var wanted = expected[scene_id][family][kind][key]
     if not (actual is int or actual is float) or not is_equal_approx(float(actual),float(wanted)):
      push_error("runtime mismatch: "+scene_id+"/"+family+"/"+kind+"/"+key+" actual="+str(actual)+" wanted="+str(wanted))
      get_tree().quit(3)
      return
 print("PVZ_INSTANCE_RUNTIME_COMPLETE "+JSON.stringify({"ok":true,"observed":observed}))
 get_tree().quit(0)
`;

test('PVZ scene overrides, inherited defaults and reset reach actual canonical Godot',{skip:!candidate,timeout:240000},async t=>{
 const evidenceRoot=resolve(root,'.local/creation-verification/pvz-instance-runtime');mkdirSync(evidenceRoot,{recursive:true});
 const evidence=mkdtempSync(resolve(evidenceRoot,'native-')),data=mkdtempSync(resolve(tmpdir(),'atelier-pvz-parameters-'));
 const store=new CreationStore(resolve(data,'creation.sqlite')),service={root,data,store,origin:'http://127.0.0.1:48921'};
 t.after(()=>{store.close();rmSync(data,{recursive:true,force:true});});service.assets=new CreationAssets({store,root,data});
 const input=JSON.parse(readFileSync(resolve(candidate),'utf8')),manifest=structuredClone(input.manifest??input);
 const assetDirs=(process.env.PVZ_ASSET_DIRS??resolve(root,'.local/model-preview/creation/assets')).split(process.platform==='win32'?';':':');
 const assetSet=new Map();function collect(value){if(!value||typeof value!=='object')return;if(value.model_hash)assetSet.set(value.model_hash,'glb');if(value.script_hash)assetSet.set(value.script_hash,'gd');Object.values(value).forEach(collect);}collect(manifest);
 for(const [hash,ext]of assetSet){let bytes;for(const dir of assetDirs){try{bytes=readFileSync(resolve(dir,hash+'.'+ext));break;}catch{}}assert.ok(bytes,'missing candidate asset '+hash);assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);service.assets.write(hash,ext,bytes);store.put('creator_asset',{id:hash,ext,builtin:true,bytes:bytes.length});}
 manifest.resources[other]={...structuredClone(manifest.resources[scene]),id:other,name:'独立场景继承对照'};
 const user=store.register({name:'PVZ runtime '+randomUUID(),password:randomUUID()}).user;
 const project=store.createProject(user,{name:'PVZ parameters independent'},manifest).project.id,semantic=new SemanticAuthoring({store});
 const current=()=>store.branchView(user,project,'main');
 const specs=[];for(const kind of ['pea','sunflower','walnut','zombie','cone','bucket'])for(const p of current().manifest.resources['prefab-'+kind].design.exposed_properties){assert.equal(p.instance_editable,true);specs.push({kind,family:['pea','sunflower','walnut'].includes(kind)?'plants':'zombies',resource:'prefab-'+kind,object:'template-'+kind,property:p});}assert.equal(specs.length,11);
 const definitions=()=>Object.fromEntries(Object.entries(current().manifest.resources).filter(([id])=>id.startsWith('prefab-')));
 const initialDefinitions=structuredClone(definitions()),initialOther=structuredClone(current().manifest.resources[other]);
 function detail(spec,resource=scene){return semantic.resources(user,project,'main',{resource_id:resource,...(resource.startsWith('scene-')?{object_id:spec.object}:{})});}
 function mutate(spec,action,value,resource=scene){const d=detail(spec,resource);return semantic.updateResource(user,project,'main',{resource_id:resource,...(resource.startsWith('scene-')?{object_id:spec.object}:{}),action,property_id:spec.property.id,...(value===undefined?{}:{value}),expected_version:d.target.expected_version,base_revision:d.revision,transaction_id:randomUUID()});}
 function next(spec,offset){const p=spec.property,step=p.step??(p.type==='integer'?1:.1),low=p.min??0;let value=low+step*offset;if(p.max!==undefined)value=Math.min(value,p.max);return p.type==='integer'?Math.round(value):Number(value.toFixed(6));}
 function expected(values){const result={plants:{},zombies:{}};for(const spec of specs){result[spec.family][spec.kind]??={};result[spec.family][spec.kind][spec.property.binding.property_key]=values(spec);}return result;}
 const inherited=spec=>detail(spec,spec.resource).properties.find(p=>p.id===spec.property.id).value;
 const stages=[];
 async function run(stage,wanted){
  const directory=resolve(evidence,stage);mkdirSync(directory);const snapshot=snapshotProjectRuntime(root,directory);verifyProjectFiles(directory,snapshot.files);
  await assembleProject({service,user,project_id:project,branch_id:'main',revision:current().head,entry_scene_id:scene,directory,runtime_source_hash:snapshot.hash});
  writeFileSync(resolve(directory,'probe.gd'),probe);writeFileSync(resolve(directory,'expected.json'),JSON.stringify(wanted));
  const settings=readFileSync(resolve(directory,'project.godot'),'utf8');assert.match(settings,/run\/main_scene="res:\/\/standalone.tscn"/);writeFileSync(resolve(directory,'project.godot'),settings.replace('GameRuntime="*res://standalone.gd"','GameRuntime="*res://standalone.gd"\nProbe="*res://probe.gd"'));
  let log='';for(const args of [['--headless','--editor','--path',directory,'--import'],['--headless','--path',directory,'--fixed-fps','60','--quit-after','1800']]){const result=spawnSync(process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot',args,{encoding:'utf8',timeout:60000});log+=(result.stdout??'')+(result.stderr??'');writeFileSync(resolve(directory,'verification.log'),log);assert.equal(result.status,0,log);assert.doesNotMatch(log,/SCRIPT ERROR|Parse Error|^ERROR:/m);}
  const line=log.split('\n').find(row=>row.startsWith('PVZ_INSTANCE_RUNTIME_COMPLETE '));assert.ok(line,log);const result=JSON.parse(line.slice('PVZ_INSTANCE_RUNTIME_COMPLETE '.length));assert.equal(result.ok,true);stages.push({stage,revision:current().head,expected:wanted,result});writeFileSync(resolve(evidence,'report.json'),JSON.stringify({completed:false,stages},null,2));
 }
 await run('initial-inherited',{[scene]:expected(inherited),[other]:expected(inherited)});
 for(const spec of specs)mutate(spec,'set_property',next(spec,7));assert.deepEqual(definitions(),initialDefinitions);assert.deepEqual(current().manifest.resources[other],initialOther);
 await run('scene-overrides',{[scene]:expected(spec=>next(spec,7)),[other]:expected(inherited)});
 for(const spec of specs)mutate(spec,'set_property',next(spec,13),spec.resource);
 await run('source-changed-overrides-preserved',{[scene]:expected(spec=>next(spec,7)),[other]:expected(inherited)});
 for(const spec of specs){mutate(spec,'reset_property');const p=detail(spec).properties.find(p=>p.id===spec.property.id);assert.equal(p.overridden,false);assert.equal(p.value,inherited(spec));}
 // A subsequent source edit proves reset removed the override instead of copying one current value.
 for(const spec of specs)mutate(spec,'set_property',next(spec,19),spec.resource);
 await run('reset-follows-next-source-change',{[scene]:expected(inherited),[other]:expected(inherited)});
 assert.deepEqual(current().manifest.resources[other],initialOther);
 writeFileSync(resolve(evidence,'report.json'),JSON.stringify({completed:true,source_candidate:resolve(candidate),scope:'Actual canonical native Godot, isolated SemanticAuthoring writes; no real project writes or Web gameplay claim',stages},null,2));console.log('PVZ_INSTANCE_RUNTIME_REPORT '+resolve(evidence,'report.json'));
});
