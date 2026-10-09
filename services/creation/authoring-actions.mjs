import {clone,fail,id,stable} from './schema.mjs';
import {emptyDesign} from './semantic-design.mjs';
import {nativeSemanticDetail,nativeSemanticTarget,nativePropertyBinding,normalizeNativeDesign} from './native-semantic.mjs';
import {nativeObjectViews} from './native-view.mjs';

export const PROPERTY_ACTION_GUIDE = `# AI add properties · recipe 1

This session started from a prefab's AI 添加属性 entry. Read the fixed
property-action.json first, then use authoring_context to refresh its target.
The target is a prefab DEFINITION, not a live game object or a single instance.
Unmodified instances inherit definition changes; existing overrides survive.
The entry is task guidance, not an additional filesystem sandbox. A later user
request can change the task; do not pretend this recipe grants broader authority.

Two paths:
1. A real parameter already exists and is consumed: use properties_expose to add
   readable names, descriptions, units and suitable ranges. Native @export fields
   may already be visible: keep their existing IDs and bindings from the context.
2. A parameter is hardcoded or disconnected: inspect the actual consumer scripts,
   implement the parameter and its reads in a FULL workspace_prepare copy under
   work/, and commit source + .atelier metadata together through world_apply.
   properties_expose can also produce validated metadata operations with prepare_only
   for an existing binding; combine these with related source operations atomically.

Preserve current values, property identities, unrelated metadata and instance
overrides. Read current revision/version before writing. Batch related metadata
with properties_expose, which merges by stable property ID. It checks bindings and
values, but NEVER proves gameplay consumption. Source candidates are search hints,
not complete data-flow analysis. Read more with world_read source_path as needed.
Do not submit a partial context directory as an entire native project.

Resolve meaningful ambiguity (sunlight vs shop coins, health vs armor) before
changing that behavior. Do not silently invent a new mechanic to expose a field.
Use the user's current execution mode; keep /goal continuous execution. Tests are
your choice. Do not schedule an automatic verification Agent or add a review gate.
Saved source, tests and public release are separate facts. Finish with the actual
properties, scope, when they take effect, and any tests actually performed. The
host derives result links from real source commits; prose is not a save receipt.
`;

const propertyMetadataSchema={type:'object',properties:{
  id:{type:'string',description:'Keep an existing ID from authoring_context for the same binding.'},name:{type:'string'},description:{type:'string'},
  type:{type:'string',enum:['number','integer','boolean','string','color','enum']},unit:{type:'string'},min:{type:'number'},max:{type:'number'},step:{type:'number'},
  options:{type:'array',items:{type:'object',properties:{value:{type:'string'},label:{type:'string'}},required:['value','label'],additionalProperties:false}},
  default:{description:'Metadata default; keep the existing value. This tool never changes native values.',type:['number','string','boolean']},instance_editable:{type:'boolean'},
  binding:{type:'object',properties:{node_id:{type:'string'},instance_ids:{type:'array',items:{type:'string'}},property:{type:'string'}},required:['node_id','property'],additionalProperties:false},
},required:['id','name','type','default','instance_editable','binding'],additionalProperties:false};

export const PROPERTY_ACTION_TOOLS = [
  {type:'function',name:'authoring_context',description:'Read the AI property action target, actual values and bounded source dependency hints. No full project dump. Refresh before writing; binding validity does not prove gameplay consumption.',inputSchema:{type:'object',properties:{revision:{type:'string'}},additionalProperties:false}},
  {type:'function',name:'properties_expose',description:'Batch add/update property metadata on this action\'s prefab definition. Preserves unrelated metadata and all native values. Read authoring_context first. Send metadata fields only, excluding read-only values, versions and binding_valid. prepare_only returns validated operations without saving; use world_apply to combine with source changes.',inputSchema:{type:'object',properties:{transaction_id:{type:'string'},base_revision:{type:'string'},expected_version:{type:'string'},properties:{type:'array',minItems:1,maxItems:100,items:propertyMetadataSchema},prepare_only:{type:'boolean'}},required:['transaction_id','base_revision','expected_version','properties'],additionalProperties:false}},
];
export function propertyActionTools(tools,session){
  return session.authoring_action?.type==='expose_properties'
    ? [...tools.filter(tool=>!['world_hierarchy_preview','world_validate','shared_world_validate','world_publish'].includes(tool.name)),...PROPERTY_ACTION_TOOLS]
    : tools;
}

export function createAuthoringAction(store,user,p,b,input){
  if(input==null)return null;
  if(typeof input!=='object'||Array.isArray(input)||input.type!=='expose_properties'||Object.keys(input).some(key=>!['type','resource_id','revision','expected_version'].includes(key)))fail(400,'AI 创作入口参数无效');
  const branch=store.branchFor(user,p,b,true);
  if(!input.revision||input.revision!==branch.head)fail(409,'目标已有更新，请重新打开 AI 添加属性');
  const fixed=store.readRevision(branch.head),resource=fixed.manifest.resources[input.resource_id];
  if(fixed.manifest.schema!=='creation-native-1'||resource?.kind!=='prefab')fail(422,'AI 添加属性试点需要原生预制件定义');
  if(input.expected_version!==resource.version)fail(409,'预制件版本已变化，请重新选择');
  return {id:id('action'),type:'expose_properties',recipe_version:1,entrypoint:'inspector.properties',scope:'definition',resource_id:resource.id,name:resource.name,path:resource.path,captured_revision:branch.head,captured_version:resource.version,created_at:Date.now()};
}

function actionFor(session,run){
  const action=run.authoring_action;
  if(!action||action.type!=='expose_properties'||action.recipe_version!==1||session.authoring_action?.id!==action.id||run.session_id!==session.id||run.project_id!==session.project_id||run.branch_id!==session.branch_id||run.owner_user_id!==session.owner_user_id)fail(403,'此执行没有匹配的 AI 属性目标');
  return action;
}
function targetFixed(service,session,run,revision){
  const action=actionFor(session,run);
  const fixed=service.semantic.fixed({id:session.owner_user_id},session.project_id,session.branch_id,revision);
  if(fixed.manifest.schema!=='creation-native-1'||fixed.manifest.resources[action.resource_id]?.kind!=='prefab')fail(410,'原预制件定义已不存在，请重新选择 AI 目标');
  return {action,fixed};
}

/** Bounded reading hints only; no independent scene authority or consumer claims. */
export function propertyActionContext(service,session,run,input={}){
  const {action,fixed}=targetFixed(service,session,run,input.revision);
  const resource=fixed.manifest.resources[action.resource_id],detail=nativeSemanticDetail(fixed,{resource_id:resource.id});
  const paths=new Set((resource.native_dependencies??[]).filter(path=>fixed.manifest.source_files[path]));
  paths.add(resource.path);
  const consumers=Object.values(fixed.manifest.resources).filter(other=>other.id!==resource.id&&(other.native_dependencies??[]).includes(resource.path));
  for(const other of consumers)for(const path of other.native_dependencies??[])if(/\.gd$/.test(path))paths.add(path);
  const terms=[resource.id,...detail.properties.map(p=>p.binding.property).filter(term=>term.length>=3)];
  const hints=[];let bytesRead=0,scanned=0;
  const scripts=Object.keys(fixed.manifest.source_files).filter(path=>/\.gd$/.test(path)).sort((a,b)=>Number(paths.has(b))-Number(paths.has(a))||a.localeCompare(b));
  for(const path of scripts){
    const file=fixed.manifest.source_files[path];
    if(scanned>=64||bytesRead+file.size>1024*1024)break;
    if(file.size>128*1024||!service.native?.archive)continue;
    const bytes=service.native.archive.read(file);bytesRead+=bytes.length;scanned++;
    const matches=bytes.toString('utf8').split('\n').flatMap((text,i)=>terms.some(term=>text.includes(term))?[{line:i+1,text:text.slice(0,240)}]:[]).slice(0,3);
    if(paths.has(path)||matches.length)hints.push({path,hash:file.hash,reason:paths.has(path)?'resource_dependency':'text_match_candidate',matches});
    if(hints.length>=16)break;
  }
  return {action:clone(action),project_id:fixed.project_id,branch_id:fixed.branch_id,revision:fixed.revision,source_schema:fixed.manifest.schema,
    captured_revision:action.captured_revision,changed_since_capture:action.captured_revision!==fixed.revision,
    target:{...detail.target,name:resource.name,path:resource.path,scope:'definition'},description:resource.design?.description??'',properties:detail.properties,
    nodes:(resource.native_nodes??[]).filter(node=>node.addressable).slice(0,64).map(node=>({node_id:node.node_id,instance_ids:node.instance_ids,native_path:node.path,type:node.type,exported_properties:(node.properties??[]).filter(p=>p.exported).slice(0,24).map(p=>({name:p.name,type_name:p.type_name,value:p.value}))})),
    uses:consumers.slice(0,24).map(r=>({resource_id:r.id,name:r.name,path:r.path})),source_candidates:hints,
    discovery:{complete:false,scanned_scripts:scanned,total_scripts:scripts.length,note:'依赖和文本匹配仅供定位，不证明玩法消费；可用 world_read source_path 继续读取。'},
    policy:{preserve_existing_values:true,inheritance:'原生定义与实例覆盖',effect:'重新开始试玩读取保存后的源稿',tests:'Agent 自选；未测试不得宣称效果已验证'},
    tools:{refresh:'authoring_context',expose:'properties_expose',source:'world_read',project:'workspace_prepare',commit:'world_apply'}};
}

const bindingKey=b=>stable([b.node_id,b.instance_ids??[],b.property]);
function exposureOperations(fixed,action,input){
  const resource=fixed.manifest.resources[action.resource_id];
  if(fixed.manifest.schema!=='creation-native-1'||resource?.kind!=='prefab')fail(410,'原预制件定义已不存在');
  if(input.expected_version!==resource.version)fail(409,'预制件版本已变化，请重读属性');
  if(!Array.isArray(input.properties)||!input.properties.length||input.properties.length>100)fail(422,'请提供 1–100 项属性');
  const existing=nativeSemanticDetail(fixed,{resource_id:resource.id}).properties;
  const design=clone(resource.design??emptyDesign()),merged=new Map(design.exposed_properties.map(p=>[p.id,p])),seen=new Set();
  for(const property of input.properties){
    if(!property||typeof property.id!=='string'||seen.has(property.id))fail(422,'属性 ID 缺失或重复');seen.add(property.id);
    const prior=existing.find(p=>p.id===property.id),sameBinding=existing.find(p=>property.binding&&bindingKey(p.binding)===bindingKey(property.binding));
    if(prior&&(!property.binding||bindingKey(prior.binding)!==bindingKey(property.binding)))fail(422,'已有属性不能改绑为另一个参数');
    if(sameBinding&&sameBinding.id!==property.id)fail(422,'此参数已经公开，请沿用属性 ID：'+sameBinding.id);
    merged.set(property.id,clone(property));
  }
  design.exposed_properties=[...merged.values()];
  const normalized=normalizeNativeDesign(design);
  const candidate={...fixed,manifest:{...fixed.manifest,resources:{...fixed.manifest.resources,[resource.id]:{...resource,design:normalized}}}};
  const check=query=>{
    const detail=nativeSemanticDetail(candidate,query),target=nativeSemanticTarget(candidate,query);
    for(const property of detail.properties.filter(p=>seen.has(p.id))){
      if(!property.binding_valid)fail(422,`${detail.target.resource_id}：${property.unavailable_reason??property.name+' 绑定无效'}`);
      const {descriptor}=nativePropertyBinding(target,property),types={bool:['boolean'],int:['integer','number'],float:['number'],String:['string','enum'],Color:['color']};
      if(!types[descriptor.type_name]?.includes(property.type)||!(descriptor.usage&2))fail(422,'属性类型或原生存储方式不匹配：'+property.name);
    }
  };
  check({resource_id:resource.id});
  for(const doc of Object.values(fixed.manifest.resources))for(const object of nativeObjectViews(fixed.manifest,doc.id,fixed)){
    if(object.definition_resource_id===resource.id&&object.native_target?.instance_ids?.length)check({resource_id:doc.id,address:object.address});
  }
  return [{type:'set_native_design',resource_id:resource.id,expected_version:resource.version,design:normalized}];
}
export async function exposeActionProperties(service,user,session,run,input){
  if(user.id!==session.owner_user_id)fail(403,'不能修改其他用户的创作动作');
  const action=actionFor(session,run);
  if(Object.keys(input).some(key=>!['transaction_id','base_revision','expected_version','properties','prepare_only'].includes(key)))fail(400,'属性工具参数无效，目标由会话固定');
  const origin={run_id:run.id,lease_generation:run.lease_generation,session_id:session.id};
  if(input.prepare_only){
    service.store.sessionFor(user,session.id,true);
    const current=service.store.get('creator_run',run.id);
    if(current?.status!=='running'||current.lease_generation!==run.lease_generation)fail(409,'Agent 运行已失去写入租约');
    const {fixed}=targetFixed(service,session,run,input.base_revision);
    if(!input.base_revision||fixed.branch.head!==input.base_revision)fail(409,'源版本已变化，请重读属性');
    return {prepared:true,base_revision:fixed.revision,ops:exposureOperations(fixed,action,input),note:'尚未保存；与相关原生源修改一起通过 world_apply 原子提交。'};
  }
  return service.semantic.mutation(user,session.project_id,session.branch_id,{...input,action:'expose_properties',resource_id:action.resource_id},fixed=>exposureOperations(fixed,action,input),origin);
}

const propertyFacts=p=>{const {expected_property_version,editable,default_known,...facts}=p;return facts;};
/** Compare each actual run commit to its first parent; never attribute later head edits. */
export function actionResult(store,run){
  const action=run.authoring_action;if(action?.type!=='expose_properties'||!run.changes?.length)return null;
  const properties=new Map();let revision=null,name=action.name,resourceChanged=false;
  for(const revisionId of run.changes){
    const after=store.readRevision(revisionId);
    if(after?.project_id!==run.project_id||after.origin?.run_id!==run.id)continue;
    const before=store.readRevision(after.parents[0]);
    const a=after.manifest.resources[action.resource_id],b=before?.manifest.resources[action.resource_id];
    if(!a||after.manifest.schema!=='creation-native-1'||a.version===b?.version)continue;
    const fixed=manifest=>({project_id:run.project_id,branch_id:run.branch_id,manifest});
    const next=nativeSemanticDetail(fixed(after.manifest),{resource_id:a.id}).properties;
    const prior=b?nativeSemanticDetail(fixed(before.manifest),{resource_id:b.id}).properties:[];
    // All resource versions include the full project's source identity. A version
    // change alone therefore cannot identify an edit to this action's target.
    const paths=new Set([a.path,...(a.native_dependencies??[]),...(b?.native_dependencies??[])]);
    const sourceChanged=[...paths].some(path=>after.manifest.source_files[path]?.hash!==before?.manifest.source_files[path]?.hash);
    if(!sourceChanged&&stable(a.design)===stable(b?.design)&&stable(next.map(propertyFacts))===stable(prior.map(propertyFacts)))continue;
    resourceChanged=true;revision=revisionId;name=a.name;
    for(const p of next){const previous=prior.find(old=>old.id===p.id);if(!previous||stable(propertyFacts(previous))!==stable(propertyFacts(p)))properties.set(p.id,{id:p.id,name:p.name,change:previous?'updated':'added',binding_valid:p.binding_valid});}
    for(const p of prior)if(!next.some(n=>n.id===p.id))properties.set(p.id,{id:p.id,name:p.name,change:'removed'});
  }
  return resourceChanged?{action_id:action.id,source_saved:true,revision,resource_id:action.resource_id,name,scope:'definition',properties:[...properties.values()],gameplay_verified:false}:null;
}
