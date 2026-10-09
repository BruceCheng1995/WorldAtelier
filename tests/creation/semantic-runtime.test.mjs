import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationAssets} from '../../services/creation/assets.mjs';
import {SemanticAuthoring} from '../../services/creation/semantic-authoring.mjs';
import {CanonicalGameValidation} from '../../services/creation/canonical-game-validation.mjs';
import {emptyDocument} from '../../services/creation/hierarchy.mjs';
import {hierarchyRuntimeId} from '../../services/creation/hierarchy-view.mjs';
import {previewInstanceUpgrade} from '../../services/creation/hierarchy-prefabs.mjs';
import {identityTransform} from '../../packages/scene/transform.mjs';
import {verifyProjectFiles,GAME_PROJECT_CONTRACT} from '../../services/creation/project-snapshot.mjs';

const root=resolve(import.meta.dirname,'../..');
const logic=`extends RefCounted
func initialize(ctx) -> Dictionary:
\tctx.state["initialized_amount"] = ctx.properties["amount"]
\tctx.state["runtime_entry"] = str(GameRuntime.get_script().resource_path)
\tctx.state["scene_count"] = GameRuntime.list_scenes().size()
\tctx.state["prefab_count"] = GameRuntime.list_prefabs().size()
\tctx.state["category"] = ctx.properties["category"]
\treturn {"ok":true}
func tick(ctx,_delta) -> Dictionary:
\tif ctx.role == "authority":
\t\tctx.state["observed_amount"] = ctx.properties["amount"]
\t\tctx.state["ticks"] = int(ctx.state.get("ticks",0))+1
\treturn {"ok":true}
`;
const writeJSON=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n');

test('exposed properties reach real canonical Godot behavior states with isolated instances and model-free systems',{timeout:180000},async t=>{
  const evidenceRoot=resolve(root,'.local/creation-verification/semantic-runtime');mkdirSync(evidenceRoot,{recursive:true});
  const evidence=mkdtempSync(resolve(evidenceRoot,'native-')),data=resolve(evidence,'data'),store=new CreationStore(resolve(data,'creation.sqlite'));
  const service={root,data,origin:'http://127.0.0.1:48921',store,verificationFinished(){}};
  service.assets=new CreationAssets({store,root,data});
  const semantic=new SemanticAuthoring({store}),validator=new CanonicalGameValidation({service});
  t.after(async()=>{await validator.close();store.close();});
  const user=store.register({name:'Semantic runtime '+randomUUID(),password:'isolated-semantic-runtime-password'}).user;
  const project=store.createProject(user,{name:'真实语义参数验证'},{schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',kind:'scene',name:'参数验证场景',objects:[]}}}).project.id;
  const current=()=>store.branchView(user,project,'main');
  const transaction=ops=>store.apply(user,project,'main',{transaction_id:randomUUID(),base_revision:current().head,ops});
  const initial=current();store.apply(user,project,'main',{transaction_id:randomUUID(),base_revision:initial.head,expected_head:initial.head,ops:[{type:'migrate_hierarchy'}]});
  const asset=service.assets.publish(user,project,Buffer.from(logic),'semantic-property-runtime-probe.gd');
  function prefab(id,amount,category){
    const document=emptyDocument(id,'prefab',category==='system'?'无模型系统':'奖励宝箱');
    document.nodes.core={id:'core',name:document.name,kind:'anchor',parent_id:document.root_id,transform:identityTransform(),solid:false,components:{behaviors:[{id:'logic',api:1,script_hash:asset.id,script_url:asset.url,properties:{amount,category}}]}};
    document.design={description:category==='system'?'无模型系统通过真实行为读取可调强度':'每次给予指定数量的奖励',category,relations:[],exposed_properties:[{id:'amount',name:category==='system'?'系统强度':'奖励数量',description:'由实际行为读取的数值',type:'integer',unit:'点',min:1,max:20,step:1,default:amount,instance_editable:true,binding:{node_id:'core',behavior_id:'logic',property_key:'amount'}}]};
    return document;
  }
  transaction([{type:'create_resource',resource_id:'chest',resource:prefab('chest',2,'object')},{type:'create_resource',resource_id:'system',resource:prefab('system',3,'system')}]);
  const beforeInstances=current();
  transaction([['left','chest'],['right','chest'],['system_live','system']].map(([instance_id,prefab_id])=>({type:'instantiate_prefab',resource_id:'scene',instance_id,expected_version:null,instance:{instance_id,prefab_id,prefab_revision:beforeInstances.manifest.resources[prefab_id].version,parent_id:beforeInstances.manifest.resources.scene.root_id,transform:{...identityTransform(),position:[instance_id==='left'?-2:instance_id==='right'?2:0,0,0]},overrides:[]}})));
  const templateRevision=current().manifest.resources.chest.version;
  const objectId=instance=>hierarchyRuntimeId({instance_path:[instance],definition_node_id:'core'});
  const reports=[];
  async function run(stage,expected){
    const revision=current().head,report=await validator.validate(user,project,'main',{revision,resource_id:'scene'});
    reports.push({stage,expected,report});writeJSON(resolve(evidence,'stage-reports.json'),reports);
    assert.equal(report.status,'passed',JSON.stringify({stage,error:report.error,report:report.report,process:report.process}));
    assert.equal(report.game_project_contract,GAME_PROJECT_CONTRACT);assert.equal(report.report.runtime_entry,'res://standalone.gd');assert.equal(report.report.main_scene,'res://standalone.tscn');assert.equal(report.report.revision,revision);
    const runtime=report.process.find(process=>process.name==='runtime');assert.equal(runtime.code,0);assert.match(runtime.output,/CANONICAL_GAME_VALIDATION /);assert.equal(runtime.entry_ready.revision,revision);assert.equal(runtime.entry_ready.scene_id,'scene');assert.equal(runtime.args.includes('--script'),false);assert.equal(runtime.args.some(arg=>arg.startsWith('--export')),false);
    const states=report.report.telemetry.object_states;
    for(const [instance,amount]of Object.entries(expected)){
      const state=states[objectId(instance)]?.logic;assert.ok(state,`${stage}: missing actual behavior state for ${instance}`);
      assert.equal(state.initialized_amount,amount,stage+' initialize '+instance);assert.equal(state.observed_amount,amount,stage+' tick '+instance);assert.ok(state.ticks>=120,stage+' real behavior ticks '+instance);
      assert.equal(state.runtime_entry,'res://standalone.gd');assert.equal(state.scene_count,1);assert.equal(state.prefab_count,2);assert.equal(state.category,instance==='system_live'?'system':'object');
    }
    const registration=store.get('creator_verification_project',report.game_validation_job_id);assert.equal(registration.source_revision,revision);assert.equal(registration.canonical_identity,report.canonical_project_identity);
    const directory=resolve(data,registration.directory);verifyProjectFiles(directory,registration.files);
    const settings=readFileSync(resolve(directory,'project.godot'),'utf8');assert.match(settings,/GameRuntime="\*res:\/\/standalone.gd"/);assert.match(settings,/run\/main_scene="res:\/\/standalone.tscn"/);
    const source=JSON.parse(readFileSync(resolve(directory,'source-manifest.json'),'utf8'));assert.equal(source.resources.system.design.category,'system');assert.equal(source.resources.system.nodes.core.kind,'anchor');assert.equal(source.resources.system.nodes.core.model_hash,undefined);assert.equal(source.resources.chest.design.exposed_properties[0].binding.property_key,'amount');
    console.log(`Semantic runtime ${stage}: ${JSON.stringify(expected)}; revision ${revision}`);
    return report;
  }
  function tune(resource_id,instance,amount){
    const request={resource_id,...(instance?{address:{project_id:project,branch_id:'main',resource_id,instance_path:[instance],definition_node_id:instance==='system_live'?current().manifest.resources.system.root_id:current().manifest.resources.chest.root_id}}:{})};
    const detail=semantic.resources(user,project,'main',request);
    return semantic.updateResource(user,project,'main',{...request,action:'set_property',property_id:'amount',value:amount,expected_version:detail.target.expected_version,base_revision:detail.revision,transaction_id:randomUUID()});
  }
  await run('initial',{left:2,right:2,system_live:3});
  tune('scene','left',7);tune('scene','system_live',11);
  await run('instance-and-system-tuned',{left:7,right:2,system_live:11});
  tune('chest',null,4);
  assert.equal(current().manifest.resources.scene.instances.right.prefab_revision,templateRevision);assert.equal(current().manifest.resources.scene.instances.left.prefab_revision,templateRevision);
  await run('template-changed-old-instances-pinned',{left:7,right:2,system_live:11});
  const branch=current(),definition=branch.manifest.resources.chest,preview=previewInstanceUpgrade(branch.manifest,'scene','right',definition.version,{source_revision:branch.head});
  assert.equal(preview.conflicts.length,0);
  store.apply(user,project,'main',{transaction_id:randomUUID(),base_revision:branch.head,expected_head:branch.head,ops:[{type:'upgrade_instance',resource_id:'scene',instance_id:'right',expected_version:branch.manifest.resources.scene.instances.right.version,prefab_revision:definition.version,expected_preview_hash:preview.preview_hash,resolutions:{}}]});
  await run('right-instance-explicitly-upgraded',{left:7,right:4,system_live:11});
  assert.equal(current().manifest.resources.scene.instances.left.prefab_revision,templateRevision);
  assert.equal(reports.length,4);assert.equal(new Set(reports.map(row=>row.report.canonical_project_identity)).size,4);
  writeJSON(resolve(evidence,'summary.json'),{ok:true,scope:'actual native canonical Godot behavior reads; no Web export or shared-world claims',stages:reports.map(({stage,expected,report})=>({stage,expected,revision:report.revision,canonical_project_identity:report.canonical_project_identity,verification_id:report.id,report:report.evidence.report,log:report.evidence.log})),script_hash:asset.id});
  console.log('Semantic canonical runtime evidence: '+evidence);
});
