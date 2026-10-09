import {createHash} from 'node:crypto';

const fail=(status,message,details)=>{throw Object.assign(new Error(message),{status,details});};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:record(value)?`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')}}`:JSON.stringify(value);
const version=value=>createHash('sha256').update(stable(value)).digest('hex');
const identity=(value,label)=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value)||['constructor','prototype','__proto__'].includes(value))fail(422,label+'无效');return value;};
const text=(value,label,max=10000)=>{if(typeof value!=='string'||value.length>max)fail(422,label+'格式或长度无效');return value;};
export const emptyDesign=()=>({description:'',category:'object',exposed_properties:[],relations:[]});

export function validatePropertyValue(property,value) {
  const type=property.type;
  if(type==='number'||type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||type==='integer'&&!Number.isSafeInteger(value))fail(422,property.name+'需要'+(type==='integer'?'整数':'有限数值'));
    if(property.min!==undefined&&value<property.min||property.max!==undefined&&value>property.max)fail(422,property.name+'超出允许范围');
    if(property.step!==undefined){const delta=(value-(property.min??0))/property.step;if(Math.abs(delta-Math.round(delta))>1e-7*Math.max(1,Math.abs(delta)))fail(422,property.name+'不符合调整步长');}
  }else if(type==='boolean'){if(typeof value!=='boolean')fail(422,property.name+'需要开关值');}
  else if(type==='string'){text(value,property.name,4000);}
  else if(type==='color'){if(typeof value!=='string'||!/^#[0-9a-fA-F]{6}$/.test(value))fail(422,property.name+'需要 RGB 颜色');}
  else if(type==='enum'){if(!property.options?.some(option=>option.value===value))fail(422,property.name+'不在可选值中');}
  else fail(422,'不支持的属性类型');
  return structuredClone(value);
}

export function normalizeDesign(value) {
  if(value===undefined)return undefined;
  if(!record(value))fail(422,'设计描述必须是对象');
  const result={...emptyDesign(),...structuredClone(value)};
  if(Object.keys(result).some(key=>!['description','category','exposed_properties','relations'].includes(key)))fail(422,'未知设计字段');
  text(result.description,'功能描述',30000);
  if(!['object','system'].includes(result.category))fail(422,'设计分类须为 object 或 system');
  if(!Array.isArray(result.exposed_properties)||result.exposed_properties.length>100)fail(422,'可调属性列表无效');
  const ids=new Set(),bindings=new Set();
  result.exposed_properties=result.exposed_properties.map(property=>{
    if(!record(property))fail(422,'属性定义无效');
    if(Object.keys(property).some(key=>!['id','name','description','type','unit','min','max','step','options','default','instance_editable','binding'].includes(key)))fail(422,'未知属性定义字段');
    const p=structuredClone(property);identity(p.id,'属性 ID');if(ids.has(p.id))fail(422,'属性 ID 重复');ids.add(p.id);
    text(p.name,'属性名称',160);if(!p.name.trim())fail(422,'属性名称不能为空');p.description=text(p.description??'','属性说明',4000);
    if(!['number','integer','boolean','string','color','enum'].includes(p.type))fail(422,'属性类型无效');
    if(typeof p.instance_editable!=='boolean')fail(422,'属性须声明是否可在实例上修改');
    if(p.unit!==undefined)text(p.unit,'属性单位',40);
    for(const key of ['min','max','step'])if(p[key]!==undefined&&(!['number','integer'].includes(p.type)||typeof p[key]!=='number'||!Number.isFinite(p[key])||key==='step'&&p[key]<=0))fail(422,'属性范围或步长无效');
    if(p.min!==undefined&&p.max!==undefined&&p.min>p.max)fail(422,'属性范围颠倒');
    if(p.type==='integer'&&['min','max','step'].some(key=>p[key]!==undefined&&!Number.isSafeInteger(p[key])))fail(422,'整数属性的范围和步长须为整数');
    if(p.type==='enum'){
      if(!Array.isArray(p.options)||!p.options.length||p.options.length>100)fail(422,'枚举选项无效');
      const values=new Set();p.options=p.options.map(option=>{if(!record(option)||typeof option.value!=='string'||values.has(option.value))fail(422,'枚举值须为唯一文本');text(option.value,'枚举值',160);text(option.label,'枚举名称',160);values.add(option.value);return {value:option.value,label:option.label};});
    }else if(p.options!==undefined)fail(422,'只有枚举属性支持选项');
    if(!own(p,'default'))fail(422,'属性须有默认值');validatePropertyValue(p,p.default);
    if(!record(p.binding)||Object.keys(p.binding).some(key=>!['node_id','behavior_id','property_key'].includes(key)))fail(422,'属性绑定无效');
    for(const key of ['node_id','behavior_id','property_key'])identity(p.binding[key],'属性绑定 '+key);
    const key=stable(p.binding);if(bindings.has(key))fail(422,'同一运行属性不能重复暴露');bindings.add(key);return p;
  });
  if(!Array.isArray(result.relations)||result.relations.length>200)fail(422,'设计关联列表无效');
  const related=new Set();result.relations=result.relations.map(relation=>{if(!record(relation))fail(422,'设计关联无效');identity(relation.resource_id,'关联资源');if(related.has(relation.resource_id))fail(422,'关联资源重复');related.add(relation.resource_id);return {resource_id:relation.resource_id,description:text(relation.description??'','关联说明',2000)};});
  return result;
}

export function propertyBinding(document,property) {
  const binding=property.binding,node=document.nodes?.[binding.node_id]??document.objects?.find(node=>node.id===binding.node_id);
  const behavior=node?.components?.behaviors?.find(behavior=>behavior.id===binding.behavior_id);
  if(!node||!behavior||!own(behavior.properties??{},binding.property_key))fail(422,'可调属性尚未连接实际功能：'+property.name,{resource_id:document.id,property_id:property.id,binding});
  validatePropertyValue(property,behavior.properties[binding.property_key]);return {node,behavior,value:behavior.properties[binding.property_key]};
}
export function validateDesignBindings(document) {for(const property of document.design?.exposed_properties??[])propertyBinding(document,property);}
export function validateDesignRelations(manifest) {
  for(const document of Object.values(manifest.resources))for(const relation of document.design?.relations??[])if(!manifest.resources[relation.resource_id])fail(422,'设计关联的资源不存在：'+relation.resource_id);
}
export function normalizeKnowledgeEntry(value) {
  if(!record(value))fail(422,'共享知识无效');
  const result={id:identity(value.id,'知识 ID'),title:text(value.title,'知识标题',160),content:text(value.content,'共享知识',30000),tags:value.tags??[]};
  if(!result.title.trim()||!result.content.trim())fail(422,'知识标题和内容不能为空');
  if(!Array.isArray(result.tags)||result.tags.length>30||result.tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>80))fail(422,'知识关键词无效');
  result.tags=[...new Set(result.tags)];result.version=version(result);return result;
}
export function normalizeKnowledge(value) {
  if(value===undefined)return undefined;
  if(!record(value)||Object.keys(value).length>1000)fail(422,'共享知识目录无效');
  return Object.fromEntries(Object.entries(value).map(([key,entry])=>{const next=normalizeKnowledgeEntry(entry);if(key!==next.id)fail(422,'知识 ID 与目录不匹配');return [key,next];}));
}
export function applyKnowledgeOperation(manifest,op) {
  const key=identity(op.knowledge_id??op.entry?.id,'知识 ID'),existing=manifest.knowledge?.[key];
  if((existing?.version??null)!==(op.expected_version??null))fail(409,'共享知识已变化，请刷新后重试');
  manifest.knowledge??={};
  if(op.type==='delete_knowledge'){if(!existing)fail(404,'共享知识不存在');delete manifest.knowledge[key];}
  else manifest.knowledge[key]=normalizeKnowledgeEntry({...op.entry,id:key});
  return existing?{type:'put_knowledge',knowledge_id:key,expected_version:manifest.knowledge[key]?.version??null,entry:existing}:{type:'delete_knowledge',knowledge_id:key,expected_version:manifest.knowledge[key].version};
}
