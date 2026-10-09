import {clone,fail,hash,identifier,stable} from './schema.mjs';
import {emptyDesign,normalizeDesign,validatePropertyValue} from './semantic-design.mjs';
import {nativeObjectViews,nativeAddressKey,nativeTarget} from './native-view.mjs';

export function normalizeNativeDesign(value){
  const bindings=(value?.exposed_properties??[]).map(property=>{
    const binding=property.binding;
    if(!binding||typeof binding.node_id!=='string'||!binding.node_id||typeof binding.property!=='string'||!binding.property||Object.keys(binding).some(key=>!['node_id','instance_ids','property'].includes(key)))fail(422,'可调属性需要原生节点与属性绑定');
    if(binding.instance_ids!==undefined&&(!Array.isArray(binding.instance_ids)||binding.instance_ids.some(id=>typeof id!=='string'||!id)))fail(422,'原生属性实例路径无效');
    return clone(binding);
  });
  const normalized=normalizeDesign({...clone(value??emptyDesign()),exposed_properties:(value?.exposed_properties??[]).map(({legacy_binding,...property},i)=>({...property,binding:{node_id:'native',behavior_id:'native',property_key:'property_'+i}}))});
  const seen=new Set();normalized.exposed_properties.forEach((property,i)=>{property.binding=bindings[i];const key=bindingKey(bindings[i]);if(seen.has(key))fail(422,'同一原生属性不能重复暴露');seen.add(key);});return normalized;
}
const displayValue=(value,type)=>type==='color'&&value?.$type==='Color'?'#'+value.value.slice(0,3).map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join(''):value;
const nativeValue=(value,type,previous)=>type==='color'?{$type:'Color',value:[1,3,5].map(i=>parseInt(value.slice(i,i+2),16)/255).concat(previous?.$type==='Color'?previous.value[3]:1)}:value;
const viewResource=resource=>({id:resource.id,kind:resource.kind,name:resource.name,version:resource.version,design:clone(resource.design??emptyDesign())});
const bindingKey=binding=>stable([binding.node_id,binding.instance_ids??[],binding.property]);
const decodeAddress=value=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{fail(400,'对象引用格式无效');}};

export function nativeSemanticTarget(fixed,input){
  const rid=identifier(input.resource_id),document=fixed.manifest.resources[rid];if(!document)fail(404,'设计资源不存在');
  const address=decodeAddress(input.address);
  if(address&&(['project_id','branch_id'].some(key=>address[key]!=null&&address[key]!==fixed[key])||address.resource_id!=null&&address.resource_id!==rid))fail(409,'对象引用属于另一分支或资源');
  const objects=nativeObjectViews(fixed.manifest,rid,fixed);
  const object=address?objects.find(object=>nativeAddressKey(object.address)===nativeAddressKey(address)):input.object_id?objects.find(object=>object.id===input.object_id):null;
  if((address||input.object_id)&&!object)fail(410,'对象已删除或实例路径失效');
  const node=object?document.native_nodes.find(node=>nativeAddressKey(node)===nativeAddressKey(object.native_target)):null;
  const definition=object?.prefab?fixed.manifest.resources[object.definition_resource_id]??document:document;
  const isInstance=Boolean(object?.native_target.instance_ids.length);
  return {document,definition,object,node,isInstance,identity:{resource_id:rid,...(object?{address:clone(object.address),object_id:object.id}:{}),expected_version:object?.version??document.version,definition_resource_id:definition.id,definition_version:definition.version,is_instance:isInstance}};
}

export function nativeExposedProperties(target){
  const declared=clone(target.definition.design?.exposed_properties??[]),seen=new Set(declared.map(p=>bindingKey(p.binding)));
  // Native @export values are discoverable even before an Agent adds labels.
  // Existing migration components expose only the semantic fields registered by
  // the converter; their compatibility plumbing is not a creator parameter.
  for(const node of target.definition.native_nodes??[]){
    if(!node.addressable||node.metadata?.wa_component)continue;
    if(target.node&&!target.isInstance&&node.node_id!==target.node.node_id)continue;
    for(const property of node.properties??[]){
      const type={bool:'boolean',int:'integer',float:'number',String:'string',Color:'color'}[property.type_name];
      if(!type||!property.exported||!(property.usage&4))continue;
      const binding={node_id:node.node_id,...(node.instance_ids.length?{instance_ids:node.instance_ids}:{}),property:property.name};
      if(seen.has(bindingKey(binding)))continue;seen.add(bindingKey(binding));
      declared.push({id:'native-'+hash(binding).slice(0,32),name:property.name,description:'',type,default:displayValue(property.inherited_value??property.value,type),instance_editable:true,binding});
    }
  }
  return declared;
}
export function nativePropertyBinding(target,property){
  const binding=property.binding;
  const instances=[...(target.isInstance?target.node.instance_ids:[]),...(binding.instance_ids??[])];
  const node=target.document.native_nodes.find(node=>node.node_id===binding.node_id&&stable(node.instance_ids)===stable(instances));
  const descriptor=node?.properties.find(p=>p.name===binding.property);
  if(!node||!descriptor)fail(422,'原生属性绑定已失效：'+property.name);
  return {node,descriptor};
}
export function nativeSemanticDetail(fixed,input){
  const target=nativeSemanticTarget(fixed,input),properties=[];
  for(const property of nativeExposedProperties(target)){
    try{
      const {descriptor}=nativePropertyBinding(target,property),value=displayValue(descriptor.value,property.type);
      validatePropertyValue(property,value);
      properties.push({...property,value:clone(value),inherited_value:displayValue(descriptor.inherited_value,property.type),overridden:descriptor.overridden,
        expected_property_version:descriptor.version,editable:!target.isInstance||property.instance_editable,binding_valid:true,default_known:descriptor.default_known});
    }catch(error){if(error.status!==422)throw error;properties.push({...property,value:null,editable:false,binding_valid:false,unavailable_reason:error.message});}
  }
  return {project_id:fixed.project_id,branch_id:fixed.branch_id,revision:fixed.revision,resource:viewResource(target.definition),target:target.identity,properties};
}
export function nativeSemanticOperations(fixed,input){
  if(input.action==='create_resource')return [{type:'create_native_resource',resource_id:identifier(input.resource_id),kind:input.kind??'prefab',name:input.name??'新设计',design:normalizeNativeDesign(input.design??emptyDesign())}];
  const target=nativeSemanticTarget(fixed,input);
  if(target.identity.expected_version!==input.expected_version)fail(409,'内容已变化，请刷新后重试');
  if(input.action==='update_design'){
    if(target.isInstance)fail(422,'请打开来源预制件定义修改设计');
    return [{type:'set_native_design',resource_id:target.definition.id,expected_version:target.definition.version,design:normalizeNativeDesign(input.design)}];
  }
  if(!['set_property','reset_property'].includes(input.action))fail(422,'未知设计操作');
  const property=nativeExposedProperties(target).find(p=>p.id===input.property_id);if(!property)fail(404,'此版本未暴露该属性');
  if(target.isInstance&&!property.instance_editable)fail(403,'该属性仅可在定义中修改');
  const {node,descriptor}=nativePropertyBinding(target,property);
  return [{type:input.action==='reset_property'?'reset_native_property':'set_native_property',resource_id:target.document.id,target:nativeTarget(node),property:property.binding.property,
    expected_property_version:descriptor.version,...(input.action==='set_property'?{value:nativeValue(validatePropertyValue(property,input.value),property.type,descriptor.value)}:{})}];
}
