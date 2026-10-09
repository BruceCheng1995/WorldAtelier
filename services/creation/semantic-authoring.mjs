import {clone,fail,hash,id,identifier,stable} from './schema.mjs';
import {HIERARCHY_SCHEMA,resolveScene,addressKey,emptyDocument,normalizeInstance} from './hierarchy.mjs';
import {emptyDesign,normalizeDesign,normalizeKnowledgeEntry,propertyBinding,validatePropertyValue} from './semantic-design.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';
import {nativeSemanticDetail,nativeSemanticOperations,nativeSemanticTarget} from './native-semantic.mjs';

const viewResource=resource=>({id:resource.id,kind:resource.kind,name:resource.name,version:resource.version,design:clone(resource.design??emptyDesign())});
const requireVersion=(actual,expected)=>{if(!expected||actual!==expected)fail(409,'内容已变化，请刷新后重试');};
const roles=new Set(['reference','target']);
const decodeAddress=value=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{fail(400,'对象引用格式无效');}};

/** Shared, versioned design projection. Values always come from the canonical behavior properties. */
export class SemanticAuthoring {
  constructor({store,commit}={}){this.store=store;this.commit=commit??((user,p,b,input,origin)=>store.apply(user,p,b,input,origin));}
  fixed(user,p,b,revision,{write=false}={}){
    const project=this.store.projectFor(user,p,write);
    if(!['owner','editor','viewer'].includes(project.members[user.id]))fail(403,'共享设计资料仅供项目协作者访问');
    const branch=this.store.branchFor(user,p,b,write),fixed=this.store.get('creator_revision',revision??branch.head);
    if(!fixed||fixed.project_id!==p||!this.store.ancestor(fixed.id,branch.head))fail(409,'需要当前分支可达的固定源版本');
    return {project_id:p,branch_id:b,revision:fixed.id,manifest:fixed.manifest,branch};
  }
  scope(fixed){return {project_id:fixed.project_id,branch_id:fixed.branch_id,revision:fixed.revision};}
  target(fixed,input){
    if(fixed.manifest.schema===NATIVE_SCHEMA)return nativeSemanticTarget(fixed,input);
    const manifest=fixed.manifest,rid=identifier(input.resource_id),document=manifest.resources[rid];
    if(!document)fail(404,'设计资源不存在');
    const address=decodeAddress(input.address);
    if(address&&(['project_id','branch_id'].some(key=>address[key]!=null&&address[key]!==fixed[key])||address.resource_id!=null&&address.resource_id!==rid))fail(409,'对象引用属于另一分支或资源');
    if(manifest.schema===HIERARCHY_SCHEMA&&address){
      const rows=resolveScene(manifest,rid,{project_id:fixed.project_id,branch_id:fixed.branch_id}),row=rows.find(row=>addressKey(row.address)===addressKey(address));
      if(!row)fail(410,'对象已删除或实例路径失效');
      const isInstance=row.address.instance_path.length>0,definition=isInstance?manifest.prefab_revisions[row.definition_revision]:document;
      return {manifest,document,definition,row,rows,isInstance,identity:{resource_id:rid,address:row.address,expected_version:row.object_version,definition_resource_id:definition.id,definition_version:definition.version,is_instance:isInstance}};
    }
    if(manifest.schema!==HIERARCHY_SCHEMA&&input.object_id){
      const object=document.objects.find(object=>object.id===input.object_id);if(!object)fail(410,'对象已删除');
      const definition=object.prefab?manifest.resources[object.prefab]:document;if(!definition)fail(410,'对象的预制件已删除');
      return {document,definition,object,isInstance:Boolean(object.prefab),identity:{resource_id:rid,object_id:object.id,expected_version:object.version,definition_resource_id:definition.id,definition_version:definition.version,is_instance:Boolean(object.prefab)}};
    }
    return {document,definition:document,isInstance:false,identity:{resource_id:rid,expected_version:document.version,definition_resource_id:document.id,definition_version:document.version,is_instance:false}};
  }
  propertyTarget(target,property){
    const binding=propertyBinding(target.definition,property);
    if(target.row){
      const row=target.rows.find(row=>stable(row.address.instance_path)===stable(target.row.address.instance_path)&&row.address.definition_node_id===property.binding.node_id);
      if(!row)fail(422,'属性绑定的对象不在此实例中');
      if(!target.isInstance)return {...binding,node:row.node,row};
      if(!target.inheritedRows){
        // Remove only the current scene instance's behavior overrides in a temporary projection.
        // Nested definitions and their own overrides remain pinned and continue to contribute defaults.
        const inherited=clone(target.manifest),document=inherited.resources[target.document.id],instanceId=row.address.instance_path[0],instance=document.instances[instanceId];
        document.instances[instanceId]=normalizeInstance({...instance,overrides:instance.overrides.filter(override=>stable(override.path)!==stable(['components','behaviors']))});
        target.inheritedRows=resolveScene(inherited,document.id);
      }
      const inheritedRow=target.inheritedRows.find(candidate=>addressKey(candidate.address)===addressKey(row.address));
      const inheritedBehavior=inheritedRow?.node.components?.behaviors?.find(behavior=>behavior.id===property.binding.behavior_id);
      if(!inheritedBehavior||!Object.hasOwn(inheritedBehavior.properties??{},property.binding.property_key))fail(422,'该实例的继承功能绑定已失效');
      const value=inheritedBehavior.properties[property.binding.property_key];validatePropertyValue(property,value);
      return {...binding,value,node:row.node,row,inherited_behaviors:clone(inheritedRow.node.components.behaviors)};
    }
    if(target.object){
      if(target.isInstance){
        const sourceId=target.object.prefab_node_id??(target.definition.objects.length===1?target.definition.objects[0].id:target.object.id);
        if(sourceId!==property.binding.node_id)fail(422,'此旧版实例缺少该属性的稳定来源节点绑定');
      }else if(target.object.id!==property.binding.node_id)fail(422,'属性属于此资源中的另一个对象');
      return {...binding,node:target.object};
    }
    return binding;
  }
  detail(fixed,input){
    if(fixed.manifest.schema===NATIVE_SCHEMA)return nativeSemanticDetail(fixed,input);
    const target=this.target(fixed,input),properties=[];
    for(const property of target.definition.design?.exposed_properties??[]){
      // Selecting a definition node limits the panel to that node; selecting an instance root opens its design unit.
      if(target.object&&!target.isInstance&&property.binding.node_id!==target.object.id)continue;
      try{
        const bound=this.propertyTarget(target,property),behavior=bound.node.components?.behaviors?.find(value=>value.id===property.binding.behavior_id);
        if(!behavior||!Object.hasOwn(behavior.properties??{},property.binding.property_key))fail(422,'实例尚未连接该可调功能');
        const overrides=target.isInstance?target.object?.prefab_property_overrides:undefined;
        const explicit=overrides!==undefined&&Object.hasOwn(overrides,property.id);
        const value=overrides!==undefined&&!explicit?bound.value:behavior.properties[property.binding.property_key];validatePropertyValue(property,value);
        properties.push({...clone(property),value:clone(value),inherited_value:clone(bound.value),overridden:target.isInstance&&(overrides!==undefined?explicit:stable(value)!==stable(bound.value)),editable:!target.isInstance||property.instance_editable,binding_valid:true});
      }catch(error){if(!target.isInstance||error.status!==422)throw error;properties.push({...clone(property),value:null,editable:false,binding_valid:false,unavailable_reason:error.message});}
    }
    return {...this.scope(fixed),resource:viewResource(target.definition),target:target.identity,properties};
  }
  resources(user,p,b,input={}){
    const fixed=this.fixed(user,p,b,input.revision);
    return input.resource_id?this.detail(fixed,input):{...this.scope(fixed),resources:Object.values(fixed.manifest.resources).map(viewResource)};
  }
  mutation(user,p,b,input,build,origin=null){
    const fixed=this.fixed(user,p,b,input.base_revision,{write:true});identifier(input.transaction_id,'事务 ID');
    if(origin){const run=this.store.get('creator_run',origin.run_id);if(!run||run.status!=='running'||run.lease_generation!==origin.lease_generation||run.owner_user_id!==user.id||run.project_id!==p||run.branch_id!==b)fail(409,'Agent 运行已失去写入租约');}
    if(!input.base_revision)fail(409,'修改需要固定源版本');
    const receiptId=`semantic:${p}:${b}:${input.transaction_id}`,fingerprint=hash({user_id:user.id,input,origin}),old=this.store.get('creator_receipt',receiptId);
    if(old){if(old.fingerprint!==fingerprint)fail(409,'同一事务 ID 不能改变内容');return {...old.result,committed_ops:clone(old.result.committed_ops??build(fixed)),replayed:true};}
    const granular=fixed.manifest.schema===NATIVE_SCHEMA&&['set_property','reset_property'].includes(input.action);
    if(!granular&&fixed.branch.head!==fixed.revision)fail(409,'源版本已变化，请保留输入并刷新后重试');
    if(input.project_id!=null&&input.project_id!==p||input.branch_id!=null&&input.branch_id!==b)fail(409,'修改请求属于另一分支');
    const ops=build(fixed),committed_ops=clone(ops),committed=this.commit(user,p,b,{transaction_id:input.transaction_id,base_revision:fixed.revision,...(!granular?{expected_head:fixed.revision}:{}),ops},origin);
    const finish=value=>{const result={...value,committed_ops};this.store.put('creator_receipt',{id:receiptId,fingerprint,result});return result;};
    return committed?.then?committed.then(finish):finish(committed);
  }
  updateResource(user,p,b,input,origin=null){return this.mutation(user,p,b,input,fixed=>{
    if(fixed.manifest.schema===NATIVE_SCHEMA)return nativeSemanticOperations(fixed,input);
    if(input.action==='create_resource'){
      const rid=identifier(input.resource_id),kind=input.kind??'prefab';if(!['scene','prefab'].includes(kind))fail(422,'资源类型无效');
      const design=normalizeDesign(input.design??emptyDesign()),resource=fixed.manifest.schema===HIERARCHY_SCHEMA?emptyDocument(rid,kind,input.name??'新设计'):{id:rid,kind,name:input.name??'新设计',objects:[]};
      resource.design=design;return [{type:'create_resource',resource_id:rid,resource}];
    }
    const target=this.target(fixed,input);requireVersion(target.identity.expected_version,input.expected_version);
    if(input.action==='update_design'){
      if(target.isInstance)fail(422,'新增设计属性须在来源预制件定义中建立；请打开定义');
      if(input.design===undefined||input.design===null)fail(422,'请提供完整设计描述');
      return [{type:'set_resource_design',resource_id:target.definition.id,expected_version:target.definition.version,design:normalizeDesign(input.design)}];
    }
    if(!['set_property','reset_property'].includes(input.action))fail(422,'未知设计操作');
    const property=target.definition.design?.exposed_properties?.find(property=>property.id===input.property_id);if(!property)fail(404,'此版本未暴露该属性');
    if(target.isInstance&&!property.instance_editable)fail(403,'该属性仅可在预制件定义中修改');
    const bound=this.propertyTarget(target,property),behaviors=clone(bound.node.components?.behaviors??[]),behavior=behaviors.find(value=>value.id===property.binding.behavior_id);
    if(!behavior||!Object.hasOwn(behavior.properties??{},property.binding.property_key))fail(422,'可调属性尚未连接实际功能');
    const value=validatePropertyValue(property,input.action==='reset_property'?(target.isInstance?bound.value:property.default):input.value);behavior.properties[property.binding.property_key]=value;
    if(fixed.manifest.schema===HIERARCHY_SCHEMA){
      if(target.isInstance){const address=bound.row.address,instance=target.document.instances[address.instance_path[0]];
        if(input.action==='reset_property'&&stable(behaviors)===stable(bound.inherited_behaviors)){
          const override=instance.overrides.find(override=>addressKey(override.target)===addressKey({instance_path:address.instance_path.slice(1),definition_node_id:address.definition_node_id})&&stable(override.path)===stable(['components','behaviors']));
          if(override)return [{type:'remove_override',resource_id:target.document.id,instance_id:instance.instance_id,expected_version:instance.version,override:clone(override)}];
        }
        return [{type:'set_override',resource_id:target.document.id,instance_id:instance.instance_id,expected_version:instance.version,override:{target:{instance_path:address.instance_path.slice(1),definition_node_id:address.definition_node_id},path:['components','behaviors'],value:behaviors}}];}
      return [{type:'patch_node',resource_id:target.document.id,node_id:bound.node.id,expected_version:bound.node.version,patch:{components:{...clone(bound.node.components),behaviors}}}];
    }
    const patch={components:{...clone(bound.node.components),behaviors}};
    // Opt-in flat projects distinguish an explicit override from a copied default.
    // Their runtime must resolve the same marker; legacy projects keep their value semantics.
    if(target.isInstance&&target.object?.prefab_property_overrides!==undefined){
      patch.prefab_property_overrides=clone(target.object.prefab_property_overrides);
      if(input.action==='reset_property')delete patch.prefab_property_overrides[property.id];
      else patch.prefab_property_overrides[property.id]=true;
    }
    return [{type:'patch_object',resource_id:target.document.id,object_id:bound.node.id,expected_version:bound.node.version,patch}];
  },origin);}
  index(fixed){
    const resources=Object.values(fixed.manifest.resources).map(resource=>{
      const design=resource.design??emptyDesign(),propertyText=design.exposed_properties.map(property=>`${property.name}：${property.description}${property.unit?'（'+property.unit+'）':''}`).join('\n'),relations=design.relations.map(relation=>`${fixed.manifest.resources[relation.resource_id]?.name??relation.resource_id}：${relation.description}`).join('\n');
      return {id:'resource:'+resource.id,kind:'resource',resource_id:resource.id,title:resource.name,description:design.description,content:[design.description,propertyText,relations].filter(Boolean).join('\n'),version:resource.version,tags:[resource.kind,design.category],relations:clone(design.relations)};
    });
    return [...resources,...Object.values(fixed.manifest.knowledge??{}).map(entry=>({id:'knowledge:'+entry.id,kind:'knowledge',title:entry.title,description:entry.content.slice(0,240),content:entry.content,version:entry.version,tags:clone(entry.tags)}))];
  }
  knowledge(user,p,b,input={}){
    const fixed=this.fixed(user,p,b,input.revision),items=this.index(fixed);
    if(input.id){const item=items.find(item=>item.id===input.id);if(!item)fail(404,'此版本的知识条目不存在');return {...this.scope(fixed),item};}
    const query=String(input.q??'').trim().slice(0,300),tokens=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches=items.map(item=>{const title=item.title.toLocaleLowerCase(),content=[item.content,...item.tags].join(' ').toLocaleLowerCase();return {...item,score:tokens.reduce((sum,token)=>sum+(title.includes(token)?10:0)+(content.includes(token)?1:0),0)};}).filter(item=>!tokens.length||item.score>0).sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title));
    const limit=Math.min(1000,Math.max(1,Number(input.limit)||100));return {...this.scope(fixed),query,total:matches.length,items:matches.slice(0,limit)};
  }
  updateKnowledge(user,p,b,input,origin=null){return this.mutation(user,p,b,input,()=>{
    if(input.action==='put'){const entry=normalizeKnowledgeEntry(input.entry);return [{type:'put_knowledge',knowledge_id:entry.id,expected_version:input.expected_version??null,entry}];}
    if(input.action==='delete')return [{type:'delete_knowledge',knowledge_id:identifier(input.knowledge_id),expected_version:input.expected_version}];
    fail(422,'未知知识操作');
  },origin);}
  attach(user,sid,input){
    const session=this.store.sessionFor(user,sid,true);
    if(input.project_id!==session.project_id||input.branch_id!==session.branch_id)fail(409,'引用属于另一项目或分支');
    if(!roles.has(input.role??'reference'))fail(422,'引用用途须为 reference 或 target');
    const fixed=this.fixed(user,session.project_id,session.branch_id,input.revision,{write:true});if(!input.revision)fail(409,'引用需要固定源版本');
    let data;
    if(input.kind==='prefab'){
      const resource=fixed.manifest.resources[input.resource_id];if(resource?.kind!=='prefab')fail(404,'此版本的预制件不存在');
      data={kind:'prefab',resource_id:resource.id,resource_version:resource.version,snapshot:clone(resource),design:clone(resource.design??emptyDesign()),name:resource.name};
    }else if(input.kind==='knowledge'){
      if(input.role==='target')fail(422,'知识引用是参考资料，不能作为修改目标');
      const item=this.index(fixed).find(item=>item.id===input.knowledge_id);if(!item)fail(404,'此版本的知识条目不存在');
      data={kind:'knowledge',knowledge_id:item.id,knowledge_version:item.version,snapshot:clone(item),name:item.title};
    }else fail(422,'引用类型无效');
    const attachment={id:id('attachment'),...this.scope(fixed),session_id:sid,source_revision:fixed.revision,role:input.role??'reference',...data,captured_at:Date.now()};
    attachment.sha256=hash(attachment);session.draft_attachments.push(attachment);session.updated_at=Date.now();this.store.put('creator_session',session);return attachment;
  }
}
