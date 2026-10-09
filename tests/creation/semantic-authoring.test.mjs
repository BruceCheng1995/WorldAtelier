import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';
import {CreationAgentRuns} from '../../services/creation/agent-runs.mjs';
import {SemanticAuthoring} from '../../services/creation/semantic-authoring.mjs';
import {normalizeDesign,validatePropertyValue} from '../../services/creation/semantic-design.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {HIERARCHY_SCHEMA,resolveScene,emptyDocument} from '../../services/creation/hierarchy.mjs';
import {identityTransform} from '../../packages/scene/transform.mjs';

const script='extends RefCounted\nfunc on_ready(ctx):\n\tctx.state["reward"] = ctx.properties["reward"]\n';
const scriptHash=hash(script);
const behavior=()=>({id:'reward_logic',api:1,script_hash:scriptHash,script_url:`/preview-assets/${scriptHash}.gd`,properties:{reward:3,cooldown:5}});
const node=(id,extra={})=>({id,name:id,kind:'anchor',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],solid:false,components:{behaviors:[behavior()]},...extra});
const design=()=>({description:'打开宝箱获得奖励',category:'object',exposed_properties:[{id:'reward',name:'奖励数量',description:'打开后给予的物品数量',type:'integer',unit:'个',min:1,max:10,step:1,default:3,instance_editable:true,binding:{node_id:'core',behavior_id:'reward_logic',property_key:'reward'}}],relations:[]});
function setup(t,{hierarchy=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'wa-semantic-')),path=join(dir,'test.sqlite');let store=new CreationStore(path);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  const user=store.register({name:'owner',password:'test-password'}).user,editor=store.register({name:'editor',password:'test-password'}).user,viewer=store.register({name:'viewer',password:'test-password'}).user,outsider=store.register({name:'outsider',password:'test-password'}).user;
  store.put('creator_asset',{id:scriptHash,ext:'gd',builtin:true,bytes:Buffer.byteLength(script)});
  const created=store.createProject(user,{name:'语义测试'},{schema:'creation-flat-1',entry_scene_id:'scene',knowledge:{},resources:{scene:{id:'scene',kind:'scene',name:'测试场景',objects:[node('a',{prefab:'chest',prefab_node_id:'core'}),node('b',{prefab:'chest',prefab_node_id:'core'})]},chest:{id:'chest',kind:'prefab',name:'宝箱',design:design(),custom_metadata:{preserved:true},objects:[node('core')]}}}),p=created.project.id;
  store.setMember(user,p,editor.id,'editor');store.setMember(user,p,viewer.id,'viewer');
  if(hierarchy){let branch=store.branchView(user,p,'main');store.apply(user,p,'main',{transaction_id:randomUUID(),base_revision:branch.head,expected_head:branch.head,ops:[{type:'migrate_hierarchy'}]});branch=store.branchView(user,p,'main');const doc=branch.manifest.resources.scene;store.apply(user,p,'main',{transaction_id:randomUUID(),base_revision:branch.head,ops:['a','b'].map(instance_id=>({type:'instantiate_prefab',resource_id:'scene',instance_id:'mount_'+instance_id,expected_version:null,instance:{instance_id:'mount_'+instance_id,prefab_id:'chest',prefab_revision:branch.manifest.resources.chest.version,parent_id:doc.root_id,transform:identityTransform(),overrides:[]}}))});}
  const api=new SemanticAuthoring({store});
  return {store,api,user,editor,viewer,outsider,p,path,reopen(){store.db.close();store=new CreationStore(path);api.store=store;api.commit=(user,p,b,input,origin)=>store.apply(user,p,b,input,origin);this.store=store;},head(b='main'){return store.branchView(user,p,b);},address(instance='mount_a'){return {project_id:p,branch_id:'main',resource_id:'scene',instance_path:[instance],definition_node_id:store.branchView(user,p,'main').manifest.resources.chest.root_id};}};
}
function update(f,args,b='main',user=f.user){const fixed=f.api.resources(user,f.p,b,{resource_id:args.resource_id??'chest',...(args.object_id?{object_id:args.object_id}:{}),...(args.address?{address:args.address}:{})});return f.api.updateResource(user,f.p,b,{transaction_id:randomUUID(),base_revision:fixed.revision,expected_version:fixed.target.expected_version,resource_id:'chest',...args});}
function putKnowledge(f,id='death',content='死亡后任务钥匙保留',b='main'){return f.api.updateKnowledge(f.user,f.p,b,{action:'put',transaction_id:randomUUID(),base_revision:f.head(b).head,expected_version:f.head(b).manifest.knowledge?.[id]?.version??null,entry:{id,title:'死亡规则',content,tags:['任务','背包']}});}

test('flat design is durable metadata; exposed edits change the real behavior property and reset',t=>{
  const f=setup(t),before=f.head();update(f,{action:'set_property',property_id:'reward',value:7});
  assert.equal(f.head().manifest.resources.chest.objects[0].components.behaviors[0].properties.reward,7);
  assert.equal(f.api.resources(f.user,f.p,'main',{resource_id:'chest'}).properties[0].value,7);
  update(f,{action:'reset_property',property_id:'reward'});assert.equal(f.head().manifest.resources.chest.objects[0].components.behaviors[0].properties.reward,3);
  update(f,{action:'update_design',design:{...design(),description:'新的共享宝箱描述'}});f.reopen();
  assert.equal(f.head().manifest.resources.chest.design.description,'新的共享宝箱描述');assert.deepEqual(f.head().manifest.resources.chest.custom_metadata,{preserved:true});
  assert.equal(f.api.resources(f.user,f.p,'main',{revision:before.head,resource_id:'chest'}).resource.design.description,'打开宝箱获得奖励');
});
test('flat instance tuning changes only the selected instance; definition and sibling remain intact',t=>{
  const f=setup(t);update(f,{action:'set_property',resource_id:'scene',object_id:'a',property_id:'reward',value:8});
  const m=f.head().manifest;assert.equal(m.resources.scene.objects[0].components.behaviors[0].properties.reward,8);assert.equal(m.resources.scene.objects[1].components.behaviors[0].properties.reward,3);assert.equal(m.resources.chest.objects[0].components.behaviors[0].properties.reward,3);
  const panel=f.api.resources(f.user,f.p,'main',{resource_id:'scene',object_id:'a'});assert.equal(panel.resource.id,'chest');assert.equal(panel.properties[0].overridden,true);
  assert.throws(()=>update(f,{action:'update_design',resource_id:'scene',object_id:'a',design:design()}),/来源预制件/);
});
test('opt-in flat parameters inherit defaults and preserve explicit equal-value overrides until reset',t=>{
  const f=setup(t),before=f.head();
  f.store.apply(f.user,f.p,'main',{transaction_id:randomUUID(),base_revision:before.head,ops:before.manifest.resources.scene.objects.map(o=>({type:'patch_object',resource_id:'scene',object_id:o.id,expected_version:o.version,patch:{prefab_property_overrides:{}}}))});
  const property=(id='a')=>f.api.resources(f.user,f.p,'main',{resource_id:'scene',object_id:id}).properties[0];
  const tune=(action,value)=>update(f,{action,resource_id:'scene',object_id:'a',property_id:'reward',value});
  tune('set_property',3);assert.equal(property().overridden,true);
  update(f,{action:'set_property',property_id:'reward',value:7});
  assert.equal(property().value,3);assert.equal(property('b').value,7);assert.equal(property('b').overridden,false);
  tune('reset_property');assert.equal(property().value,7);assert.equal(property().overridden,false);
  assert.deepEqual(f.head().manifest.resources.scene.objects[0].prefab_property_overrides,{});
  update(f,{action:'set_property',property_id:'reward',value:9});assert.equal(property().value,9);
  assert.equal(f.head().manifest.resources.scene.objects[0].components.behaviors[0].properties.cooldown,5);
  const fixed=f.head(),a=fixed.manifest.resources.scene.objects[0];
  for(const marker of [null,[],{reward:false},{reward:3}])assert.throws(()=>f.store.apply(f.user,f.p,'main',{transaction_id:randomUUID(),base_revision:fixed.head,ops:[{type:'patch_object',resource_id:'scene',object_id:a.id,expected_version:a.version,patch:{prefab_property_overrides:marker}}]}),error=>error.status===422);
  assert.equal(f.head().head,fixed.head);
});
test('hierarchy tuning uses the actual instance override and retains pinned definitions',t=>{
  const f=setup(t,{hierarchy:true}),fixed=f.head(),oldDefinition=fixed.manifest.resources.chest.version;
  update(f,{action:'set_property',resource_id:'scene',address:f.address(),property_id:'reward',value:9});
  const m=f.head().manifest,rows=resolveScene(m,'scene'),value=mount=>rows.find(row=>row.address.instance_path[0]===mount&&row.node.id==='core').node.components.behaviors[0].properties.reward;
  assert.equal(value('mount_a'),9);assert.equal(value('mount_b'),3);assert.equal(m.resources.chest.nodes.core.components.behaviors[0].properties.reward,3);
  assert.deepEqual(m.resources.scene.instances.mount_a.overrides[0].path,['components','behaviors']);
  update(f,{action:'update_design',design:{...design(),description:'宝箱新定义'}});
  assert.equal(f.head().manifest.prefab_revisions[oldDefinition].design.description,'打开宝箱获得奖励');
  assert.equal(f.api.resources(f.user,f.p,'main',{resource_id:'scene',address:f.address()}).resource.design.description,'打开宝箱获得奖励');
  assert.equal(f.head().manifest.resources.scene.instances.mount_b.prefab_revision,oldDefinition);
});
test('nested tuning inherits outer prefab overrides and resetting one property preserves other edits and sibling instances',t=>{
  const f=setup(t,{hierarchy:true}),next=design();
  next.exposed_properties.push({id:'cooldown',name:'恢复时间',description:'再次领取的间隔',type:'integer',unit:'秒',min:1,max:20,default:5,instance_editable:true,binding:{node_id:'core',behavior_id:'reward_logic',property_key:'cooldown'}});
  update(f,{action:'update_design',design:next});
  let branch=f.head(),chest=branch.manifest.resources.chest,house=emptyDocument('house','prefab','奖励房间');
  const inner=(instance_id,reward,cooldown)=>({instance_id,prefab_id:'chest',prefab_revision:chest.version,parent_id:house.root_id,transform:identityTransform(),overrides:[{target:{instance_path:[],definition_node_id:'core'},path:['components','behaviors'],value:[{...behavior(),properties:{reward,cooldown}}]}]});
  house.instances.inner_a=inner('inner_a',6,8);house.instances.inner_b=inner('inner_b',4,7);
  f.store.apply(f.user,f.p,'main',{transaction_id:randomUUID(),base_revision:branch.head,ops:[{type:'create_resource',resource_id:'house',resource:house}]});
  branch=f.head();house=branch.manifest.resources.house;
  f.store.apply(f.user,f.p,'main',{transaction_id:randomUUID(),base_revision:branch.head,ops:['house_a','house_b'].map(instance_id=>({type:'instantiate_prefab',resource_id:'scene',instance_id,expected_version:null,instance:{instance_id,prefab_id:'house',prefab_revision:house.version,parent_id:branch.manifest.resources.scene.root_id,transform:identityTransform(),overrides:[]}}))});
  const address=(outer='house_a',inner='inner_a')=>({project_id:f.p,branch_id:'main',resource_id:'scene',instance_path:[outer,inner],definition_node_id:chest.root_id});
  const detail=(outer,inner)=>f.api.resources(f.user,f.p,'main',{resource_id:'scene',address:address(outer,inner)});
  const value=(property,outer,inner)=>detail(outer,inner).properties.find(item=>item.id===property);
  const tune=(action,property_id,value)=>update(f,{action,resource_id:'scene',address:address(),property_id,...(value!==undefined?{value}:{})});
  assert.equal(value('reward').value,6);assert.equal(value('reward').inherited_value,6);assert.equal(value('reward').overridden,false);assert.equal(value('cooldown').inherited_value,8);
  tune('set_property','reward',9);tune('set_property','cooldown',10);
  assert.equal(value('reward').value,9);assert.equal(value('reward').inherited_value,6);assert.equal(value('reward').overridden,true);
  assert.equal(value('reward','house_b','inner_a').value,6);assert.equal(value('reward','house_a','inner_b').value,4);assert.equal(value('cooldown','house_b','inner_a').value,8);
  tune('reset_property','reward');
  assert.equal(value('reward').value,6);assert.equal(value('reward').overridden,false);assert.equal(value('cooldown').value,10);assert.equal(value('cooldown').overridden,true);
  assert.equal(f.head().manifest.resources.scene.instances.house_a.overrides.length,1);
  tune('reset_property','cooldown');
  assert.equal(value('cooldown').value,8);assert.equal(value('cooldown').overridden,false);assert.deepEqual(f.head().manifest.resources.scene.instances.house_a.overrides,[]);
  assert.deepEqual(f.head().manifest.resources.house.instances.inner_a.overrides,house.instances.inner_a.overrides);
  assert.equal(f.head().manifest.resources.chest.nodes.core.components.behaviors[0].properties.reward,3);
  assert.deepEqual(f.head().manifest.resources.scene.instances.house_b.overrides,[]);
});
test('parameter type, range, step, default, duplicate binding and missing implementation reject atomically',t=>{
  const f=setup(t),head=f.head().head;
  for(const value of [0,11,3.5,'4',null])assert.throws(()=>update(f,{action:'set_property',property_id:'reward',value}),error=>error.status===422);
  for(const transform of [p=>({...p,default:20}),p=>({...p,unit:23}),p=>({...p,step:0}),p=>({...p,binding:{...p.binding,property_key:'missing'}})]){
    const next=design();next.exposed_properties[0]=transform(next.exposed_properties[0]);assert.throws(()=>update(f,{action:'update_design',design:next}),error=>error.status===422);
  }
  const next=design();next.exposed_properties.push({...next.exposed_properties[0],id:'duplicate'});assert.throws(()=>normalizeDesign(next),/重复暴露/);
  assert.equal(f.head().head,head);
  const object=f.head().manifest.resources.chest.objects[0];assert.throws(()=>f.store.apply(f.user,f.p,'main',{transaction_id:randomUUID(),base_revision:head,ops:[{type:'patch_object',resource_id:'chest',object_id:'core',expected_version:object.version,patch:{components:{behaviors:[{...behavior(),properties:{reward:100}}]}}}]}),/范围/);assert.equal(f.head().head,head);
});
test('all documented property types have value checks',()=>{
  for(const [type,value,bad,extra]of [['boolean',true,1,{}],['string','文字',{},{}],['color','#123aBC','red',{}],['enum','easy','other',{options:[{value:'easy',label:'简单'}]}],['number',.5,.6,{min:0,max:1,step:.25}]]){
    const property={name:'属性',type,...extra};assert.equal(validatePropertyValue(property,value),value);assert.throws(()=>validatePropertyValue(property,bad),error=>error.status===422);
  }
});
test('instance editability and project ACL are enforced on reads, writes and receipt replays',t=>{
  const f=setup(t),next=design();next.exposed_properties[0].instance_editable=false;update(f,{action:'update_design',design:next});
  assert.throws(()=>update(f,{action:'set_property',resource_id:'scene',object_id:'a',property_id:'reward',value:5}),error=>error.status===403);
  assert.throws(()=>f.api.resources(f.outsider,f.p,'main'),error=>error.status===403);
  assert.equal(f.api.resources(f.viewer,f.p,'main').resources.length,2);
  assert.throws(()=>update(f,{action:'set_property',property_id:'reward',value:5},'main',f.viewer),error=>error.status===403);
  const detail=f.api.resources(f.editor,f.p,'main',{resource_id:'chest'}),input={action:'set_property',resource_id:'chest',property_id:'reward',value:5,expected_version:detail.target.expected_version,transaction_id:randomUUID(),base_revision:detail.revision};
  f.api.updateResource(f.editor,f.p,'main',input);assert.equal(f.api.updateResource(f.editor,f.p,'main',input).replayed,true);
  assert.throws(()=>f.api.updateResource(f.editor,f.p,'main',{...input,value:6}),error=>error.status===409);
  f.store.setMember(f.user,f.p,f.editor.id,'viewer');assert.throws(()=>f.api.updateResource(f.editor,f.p,'main',input),error=>error.status===403);
});
test('knowledge search is pinned, shared entries persist, and branch merge preserves descriptions and knowledge',t=>{
  const f=setup(t);putKnowledge(f);const original=f.head();f.store.fork(f.user,f.p,{from_branch:'main',branch_id:'draft'});
  putKnowledge(f,'death','死亡后只有主线任务钥匙保留','draft');update(f,{action:'update_design',design:{...design(),description:'分支上的宝箱'}},'draft');
  assert.equal(f.api.knowledge(f.user,f.p,'main',{q:'主线'}).items.length,0);
  assert.equal(f.api.knowledge(f.user,f.p,'draft',{q:'主线'}).items[0].id,'knowledge:death');
  const preview=f.store.mergePreview(f.user,f.p,'main',{source_branch_id:'draft'});f.store.merge(f.user,f.p,'main',{preview_id:preview.id,resolutions:{}});f.reopen();
  assert.equal(f.head().manifest.resources.chest.design.description,'分支上的宝箱');assert.equal(f.head().manifest.knowledge.death.content,'死亡后只有主线任务钥匙保留');
  assert.equal(f.api.knowledge(f.user,f.p,'main',{revision:original.head,id:'knowledge:death'}).item.content,'死亡后任务钥匙保留');
  assert.equal(f.api.knowledge(f.user,f.p,'main',{q:'奖励数量'}).items[0].id,'resource:chest');
});
test('hierarchy migration and merge retain shared knowledge and design archives',t=>{
  const f=setup(t,{hierarchy:true});putKnowledge(f);const old=f.head().manifest.resources.chest.version;f.store.fork(f.user,f.p,{from_branch:'main',branch_id:'draft'});
  putKnowledge(f,'healing','治疗不消耗任务钥匙','draft');update(f,{action:'update_design',design:{...design(),description:'分支系统设计'}},'draft');
  const preview=f.store.mergePreview(f.user,f.p,'main',{source_branch_id:'draft'});f.store.merge(f.user,f.p,'main',{preview_id:preview.id,resolutions:{}});
  assert.equal(f.head().manifest.schema,HIERARCHY_SCHEMA);assert.equal(f.head().manifest.knowledge.healing.content,'治疗不消耗任务钥匙');assert.equal(f.head().manifest.prefab_revisions[old].design.description,'打开宝箱获得奖励');
});
test('prefab and knowledge attachments are immutable, scoped, and keep reference distinct from target',t=>{
  const f=setup(t);putKnowledge(f);const session=f.store.createSession(f.user,f.p,'main'),head=f.head().head;
  const prefab=f.api.attach(f.user,session.id,{kind:'prefab',role:'target',project_id:f.p,branch_id:'main',revision:head,resource_id:'chest'});
  const knowledge=f.api.attach(f.user,session.id,{kind:'knowledge',role:'reference',project_id:f.p,branch_id:'main',revision:head,knowledge_id:'knowledge:death'});
  update(f,{action:'update_design',design:{...design(),description:'修改后的描述'}});putKnowledge(f,'death','修改后的知识');
  assert.equal(prefab.snapshot.design.description,'打开宝箱获得奖励');assert.equal(knowledge.snapshot.content,'死亡后任务钥匙保留');assert.equal(prefab.role,'target');assert.equal(knowledge.role,'reference');assert.match(prefab.sha256,/^[a-f0-9]{64}$/);
  assert.equal(f.store.sessionView(f.user,session.id).draft_attachments[1].snapshot.content,'死亡后任务钥匙保留');
  assert.throws(()=>f.api.attach(f.user,session.id,{kind:'knowledge',role:'target',project_id:f.p,branch_id:'main',revision:head,knowledge_id:'knowledge:death'}),/参考资料/);
  assert.throws(()=>f.api.attach(f.user,session.id,{kind:'prefab',project_id:f.p,branch_id:'draft',revision:head,resource_id:'chest'}),error=>error.status===409);
  assert.throws(()=>f.api.attach(f.editor,session.id,{kind:'prefab',project_id:f.p,branch_id:'main',revision:head,resource_id:'chest'}),error=>error.status===403);
});
test('stale inputs and revisions unique to another branch never rebind silently',t=>{
  const f=setup(t),old=f.api.resources(f.user,f.p,'main',{resource_id:'chest'});update(f,{action:'set_property',property_id:'reward',value:5});
  assert.throws(()=>f.api.updateResource(f.user,f.p,'main',{action:'set_property',resource_id:'chest',property_id:'reward',value:8,base_revision:old.revision,expected_version:old.target.expected_version,transaction_id:randomUUID()}),error=>error.status===409);
  f.store.fork(f.user,f.p,{from_branch:'main',branch_id:'draft'});putKnowledge(f,'branch-only','仅在草稿分支存在','draft');const branchHead=f.head('draft').head;
  assert.throws(()=>f.api.knowledge(f.user,f.p,'main',{revision:branchHead}),error=>error.status===409);
});
test('model-free systems are real prefab resources; descriptions alone expose no functioning parameters',t=>{
  const f=setup(t);f.api.updateResource(f.user,f.p,'main',{action:'create_resource',resource_id:'inventory',kind:'prefab',name:'背包系统',design:{description:'存放玩家物品',category:'system'},transaction_id:randomUUID(),base_revision:f.head().head});
  const result=f.api.resources(f.user,f.p,'main',{resource_id:'inventory'});assert.equal(result.resource.kind,'prefab');assert.equal(result.resource.design.category,'system');assert.deepEqual(result.properties,[]);assert.equal(f.head().manifest.resources.inventory.objects.length,0);
});


// Real store + dynamic dispatcher; the executor session is synthetic, no runtime ACK is involved.
function dynamicFixture(f){
  const session=f.store.createSession(f.user,f.p,'main');session.executor_thread_id='semantic-thread';f.store.put('creator_session',session);
  const run={id:randomUUID(),thread_id:session.executor_thread_id,turn_id:'semantic-turn',session_id:session.id,project_id:f.p,branch_id:'main',owner_user_id:f.user.id,status:'running',execution_mode:'default',lease_generation:1,changes:[],targets:[],verifications:[],deliveries:[],created_at:Date.now()};f.store.put('creator_run',run);
  const manager=Object.create(CreationAgentRuns.prototype),publications=[];
  Object.assign(manager,{store:f.store,service:{semantic:f.api,realtime:{development:(p,b,states)=>publications.push({p,b,states})}},turnBindings:new Map(),requests:new Map()});
  return {run,manager,publications,async call(args){const result=await manager.dynamic({threadId:run.thread_id,turnId:run.turn_id,callId:randomUUID(),scope:{sessionId:session.id,userId:f.user.id},signal:new AbortController().signal,tool:'semantic_apply',arguments:args});return JSON.parse(result.contentItems[0].text);}};
}
for(const kind of ['flat','hierarchy','nested'])test(`semantic dynamic dispatch targets only the bound ${kind} instance, including receipt replay and reset`,async t=>{
  const f=setup(t,{hierarchy:kind!=='flat'}),d=dynamicFixture(f);
  let address=kind==='flat'?null:f.address();
  if(kind==='nested'){
    let branch=f.head(),house=emptyDocument('house','prefab','嵌套宝箱');
    house.instances.inner={instance_id:'inner',prefab_id:'chest',prefab_revision:branch.manifest.resources.chest.version,parent_id:house.root_id,transform:identityTransform(),overrides:[]};
    f.store.apply(f.user,f.p,'main',{transaction_id:randomUUID(),base_revision:branch.head,ops:[{type:'create_resource',resource_id:'house',resource:house}]});branch=f.head();
    f.store.apply(f.user,f.p,'main',{transaction_id:randomUUID(),base_revision:branch.head,ops:['house_a','house_b'].map(instance_id=>({type:'instantiate_prefab',resource_id:'scene',instance_id,expected_version:null,instance:{instance_id,prefab_id:'house',prefab_revision:branch.manifest.resources.house.version,parent_id:branch.manifest.resources.scene.root_id,transform:identityTransform(),overrides:[]}}))});
    address={...f.address(),instance_path:['house_a','inner']};
  }
  const selection={resource_id:'scene',...(address?{address}:{object_id:'a'})},detail=f.api.resources(f.user,f.p,'main',selection);
  const args={...selection,action:'set_property',property_id:'reward',value:7,transaction_id:randomUUID(),base_revision:detail.revision,expected_version:detail.target.expected_version};
  const first=await d.call(args),expectedAddress={project_id:f.p,branch_id:'main',resource_id:'scene',instance_path:address?.instance_path??[],definition_node_id:address?'core':'a'};
  const check=(result)=>{
    const saved=f.store.get('creator_run',d.run.id);assert.equal(saved.targets.length,1);assert.deepEqual(saved.targets[0].address,expectedAddress);assert.equal(saved.targets[0].source_revision,result.revision);assert.equal(saved.targets[0].resource_version,result.branch.manifest.resources.scene.version);assert.ok(saved.targets[0].object_version);
    assert.equal(d.manager.lastProjectionError,undefined);assert.equal(d.publications.at(-1).states.length,1);assert.deepEqual(d.publications.at(-1).states[0].address,expectedAddress);assert.equal(d.publications.at(-1).states[0].source_revision,result.revision);
  };
  assert.equal(first.committed_ops[0].type,address?'set_override':'patch_object');check(first);
  const replay=await d.call(args);assert.equal(replay.replayed,true);assert.equal(replay.revision,first.revision);assert.deepEqual(replay.committed_ops,first.committed_ops);check(replay);
  // Existing receipts from before committed_ops was introduced keep their original immutable scope.
  const receipt=f.store.get('creator_receipt',`semantic:${f.p}:main:${args.transaction_id}`);delete receipt.result.committed_ops;f.store.put('creator_receipt',receipt);
  const legacyReplay=await d.call(args);assert.equal(legacyReplay.replayed,true);assert.deepEqual(legacyReplay.committed_ops,first.committed_ops);check(legacyReplay);
  const fresh=f.api.resources(f.user,f.p,'main',selection),reset=await d.call({...selection,action:'reset_property',property_id:'reward',transaction_id:randomUUID(),base_revision:fresh.revision,expected_version:fresh.target.expected_version});
  assert.equal(reset.committed_ops[0].type,address?'remove_override':'patch_object');check(reset);
  assert.equal(f.store.get('creator_run',d.run.id).changes.length,2);
  const lease=f.store.get('creator_run',d.run.id);lease.lease_generation=2;f.store.put('creator_run',lease);
  assert.throws(()=>f.api.updateResource(f.user,f.p,'main',args,{run_id:lease.id,lease_generation:1,session_id:lease.session_id}),error=>error.status===409);
});
test('semantic dynamic design updates retain all definition nodes as targets',async t=>{
  const f=setup(t,{hierarchy:true}),d=dynamicFixture(f),detail=f.api.resources(f.user,f.p,'main',{resource_id:'chest'});
  const result=await d.call({action:'update_design',resource_id:'chest',design:{...design(),description:'整个宝箱的新设计'},base_revision:detail.revision,expected_version:detail.target.expected_version,transaction_id:randomUUID()});
  assert.equal(result.committed_ops[0].type,'set_resource_design');
  const targets=f.store.get('creator_run',d.run.id).targets,rows=resolveScene(result.branch.manifest,'chest');
  assert.ok(rows.length>1);assert.equal(targets.length,rows.length);assert.ok(targets.every(target=>target.resource_id==='chest'&&target.address.instance_path.length===0&&target.source_revision===result.revision));
  assert.deepEqual(targets.map(target=>target.address.definition_node_id).sort(),rows.map(row=>row.node.id).sort());assert.equal(d.manager.lastProjectionError,undefined);
});
