import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {clone,fail,hash,identifier,stable} from './schema.mjs';
import {NativeTransactions} from './native-transactions.mjs';
import {NATIVE_SCHEMA,NATIVE_CATALOG,NativeSourceArchive,nativeSourcePath,nativeSourceIdentity,nativeFileChanges} from './native-source.mjs';
import {runNativeScene,importNativeProject} from '../../tools/native-scene/invoke.mjs';
import {nativeAddressKey,nativeTarget} from './native-view.mjs';
import {normalizeNativeDesign} from './native-semantic.mjs';
import {applyKnowledgeOperation,normalizeKnowledge} from './semantic-design.mjs';
import {validatePrefabTests} from './prefab-tests.mjs';

const fromRes=path=>nativeSourcePath(String(path).replace(/^res:\/\//,''));
const sourcePath=path=>'res://'+nativeSourcePath(path);
const isScenePath=path=>/\.(?:tscn|scn)$/.test(path);
const addressKey=nativeAddressKey;
const persistent=value=>{
  if(Array.isArray(value))return value.map(persistent);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!(value.$type==='Resource'&&key==='instance_id')).map(([key,item])=>[key,persistent(item)]));
  return value;
};
const reversibleValue=value=>{
  if(Array.isArray(value))return value.every(reversibleValue);
  if(value&&typeof value==='object')return !value.truncated&&!value.read_only&&value.$type!=='Resource'&&Object.values(value).every(reversibleValue);
  return true;
};

export function readNativeCatalog(directory,files){
  if(!files['project.godot']||!files[NATIVE_CATALOG])fail(422,'原生工程需要 project.godot 和 .atelier/catalog.json');
  let catalog;try{catalog=JSON.parse(readFileSync(join(directory,NATIVE_CATALOG),'utf8'));}catch{fail(422,'原生场景目录 JSON 无效');}
  if(catalog?.format!==1||!catalog.resources||Array.isArray(catalog.resources))fail(422,'原生场景目录格式无效');
  if(catalog.archived_scene_paths!==undefined&&(!Array.isArray(catalog.archived_scene_paths)||catalog.archived_scene_paths.length>20000||catalog.archived_scene_paths.some(path=>typeof path!=='string'||!isScenePath(fromRes(path)))))fail(422,'原生归档场景路径无效');
  const paths=new Set();
  for(const [rid,resource]of Object.entries(catalog.resources)){
    identifier(rid,'资源 ID');if(resource?.id!==rid||!['scene','prefab'].includes(resource.kind)||typeof resource.name!=='string'||!resource.name.trim())fail(422,'原生场景目录条目无效',{resource_id:rid});
    const path=fromRes(resource.path);if(!isScenePath(path)||!files[path])fail(422,'原生场景目录引用缺失',{resource_id:rid,path});
    if(paths.has(path))fail(422,'同一原生场景不能重复注册',{path});paths.add(path);
    if(resource.design)normalizeNativeDesign(resource.design);
  }
  normalizeKnowledge(catalog.knowledge);
  validatePrefabTests(catalog);
  if(catalog.resources[catalog.entry_scene_id]?.kind!=='scene')fail(422,'原生工程入口须为已登记场景');return catalog;
}

/** Persist only an engine projection. Native inheritance is never interpreted
 * here; the Godot response supplies effective properties and their provenance. */
export function nativeDocumentIndex(resource,response,files){
  if(!response.ok||!Array.isArray(response.nodes))fail(422,'原生引擎没有返回完整场景索引');
  const path=fromRes(resource.path),dependencies=[path,...(response.dependencies??[]).map(fromRes)];
  const closure=Object.fromEntries([...new Set(dependencies)].filter(path=>files[path]).sort().map(path=>[path,files[path]]));
  const nodes=response.nodes.map(persistent),seen=new Set();
  for(const node of nodes){
    node.key=addressKey(node);node.addressable=Boolean(node.node_id||node.metadata?.wa_instance_mount)&&!(node.instance_ids??[]).some(id=>!id);
    if(node.addressable&&seen.has(node.key))fail(422,'原生场景包含重复稳定对象身份',{resource_id:resource.id,node_id:node.node_id,instance_ids:node.instance_ids});
    if(node.addressable)seen.add(node.key);
    node.version=hash({node,closure});
    for(const property of node.properties??[])property.version=hash({target:node.key,property});
  }
  // GDScript may preload another script or construct load paths at runtime.
  // ResourceLoader's scene dependency list is not the full executable closure.
  // Until the engine can prove a narrower closure, any project source change
  // invalidates resource observations and builds. Property guards stay granular.
  const project_source_identity=nativeSourceIdentity(files);
  const result={...clone(resource),design:normalizeNativeDesign(resource.design??{}),path,engine_version:response.engine_version,native_nodes:nodes,native_connections:persistent(response.connections??[]),native_dependencies:dependencies,project_source_identity};
  result.version=hash({resource,project_source_identity,nodes:response.nodes.map(persistent),connections:result.native_connections});
  return result;
}

export class NativeProjects{
  constructor({store,data,archive=null,godotPath=process.env.GODOT_BIN??'/Applications/Godot.app/Contents/MacOS/Godot',engine=runNativeScene,importProject=importNativeProject,enforceIsolation=true,convertLegacy=null,readModelAsset=null}){
    this.store=store;this.archive=archive??new NativeSourceArchive(join(data,'native-source','objects'));
    this.directory=join(data,'native-source','candidates');mkdirSync(this.directory,{recursive:true});
    this.godotPath=godotPath;this.engine=engine;this.importProject=importProject;this.enforceIsolation=enforceIsolation;this.convertLegacy=convertLegacy;this.readModelAsset=readModelAsset;
    this.transactions=new NativeTransactions({store,archive:this.archive,prepare:context=>this.prepare(context)});
  }
  async invoke(directory,request){
    try{return await this.engine({projectDirectory:directory,request,godotPath:this.godotPath,enforceIsolation:this.enforceIsolation});}
    catch(error){if(error.status)throw error;fail(422,'原生场景处理失败：'+error.message,{errors:error.result?.errors??[],scene_path:request.scene_path});}
  }
  findNode(manifest,rid,target){
    const doc=manifest.resources[rid];if(!doc)fail(404,'原生场景不存在');
    if(!target||typeof target!=='object'||!target.node_id&&!target.definition_node_id&&!target.mount)fail(422,'原生修改需要稳定对象身份');
    const node=doc.native_nodes.find(node=>node.addressable&&node.key===addressKey(target));
    if(!node)fail(410,'对象已删除或实例路径失效');return node;
  }
  guardSceneOperation(manifest,op){
    const rid=identifier(op.resource_id,'资源 ID'),doc=manifest.resources[rid];if(!doc)fail(404,'原生场景不存在');
    if(['set_native_property','reset_native_property','restore_native_property'].includes(op.type)){
      const node=this.findNode(manifest,rid,op.target),property=node.properties.find(property=>property.name===op.property);
      if(!property)fail(410,'原生属性已删除');
      if(!(property.usage&2))fail(422,'此属性是编辑别名；请通过原子场景操作修改底层属性',{property:op.property,operation:'native_scene_operation'});
      if(!op.expected_property_version||op.expected_property_version!==property.version)fail(409,'此属性已变化，请重新读取',{resource_id:rid,target:op.target,property:op.property,current:property});
      const set=op.type==='set_native_property'||op.type==='restore_native_property'&&op.stored_locally;
      return {op:set?'set_property':'reset_property',target:nativeTarget(node),property:op.property,...(set?{value:clone(op.value)}:{})};
    }
    if(op.type==='native_scene_operation'){
      if(op.expected_version!==doc.version)fail(409,'场景结构已变化，请重新读取');
      const operation=clone(op.operation);
      if(!['rename','transform','transform_world','control_layout','instantiate','create_node','delete_node','reparent'].includes(operation?.op))fail(422,'未知原生场景编辑操作');
      for(const key of ['target','parent','reference_target'])if(operation[key]){const node=this.findNode(manifest,rid,operation[key]);operation[key]=nativeTarget(node);}
      if(operation.op==='instantiate'){
        const prefab=manifest.resources[op.prefab_id];if(prefab?.kind!=='prefab')fail(422,'请选择已登记预制件');operation.scene_path=sourcePath(fromRes(prefab.path));
      }
      return operation;
    }
    fail(422,'未知原生场景操作：'+op.type);
  }
  async indexDirectory(directory,{assignIds=false,previousFiles=null}={}){
    try{await this.importProject({projectDirectory:directory,godotPath:this.godotPath,enforceIsolation:this.enforceIsolation});}
    catch(error){if(error.status)throw error;fail(422,'原生工程导入失败：'+error.message);}
    let files=this.archive.capture(directory);
    // Ordinary Godot projects need no platform-specific catalog before import.
    // Discover every native scene; the catalog adds semantic labels/roles only.
    if(assignIds){
      if(!files['project.godot'])fail(422,'原生工程缺少 project.godot');
      let catalog=files[NATIVE_CATALOG]?readNativeCatalog(directory,files):{format:1,resources:{}};
      const registered=new Set(Object.values(catalog.resources).map(resource=>fromRes(resource.path)));
      const archived=new Set((catalog.archived_scene_paths??[]).map(fromRes));
      const scenes=Object.keys(files).filter(isScenePath),missing=scenes.filter(path=>!registered.has(path)&&!archived.has(path));
      const info=(await this.invoke(directory,{action:'project_info'})).project_info;
      const main=String(info?.main_scene??'').replace(/^res:\/\//,'');
      if(main&&(!files[main]||!isScenePath(main)))fail(422,'project.godot 的运行主场景不存在或不是原生场景',{path:main});
      const configuredEntry=Object.values(catalog.resources).find(resource=>fromRes(resource.path)===main);
      if(missing.length||!files[NATIVE_CATALOG]||configuredEntry&&catalog.entry_scene_id!==configuredEntry.id){
        for(const path of missing){const rid='native-'+hash(path).slice(0,32);catalog.resources[rid]={id:rid,path,name:path.split('/').at(-1).replace(/\.(tscn|scn)$/,''),kind:path===main?'scene':'prefab'};}
        if(!catalog.entry_scene_id||main){
          const entry=Object.values(catalog.resources).find(resource=>resource.path===main)||(scenes.length===1?Object.values(catalog.resources)[0]:null);
          if(!entry)fail(422,'原生工程需要配置运行主场景，或在 .atelier/catalog.json 指定入口');
          entry.kind='scene';catalog.entry_scene_id=entry.id;
        }
        mkdirSync(join(directory,'.atelier'),{recursive:true});writeFileSync(join(directory,NATIVE_CATALOG),JSON.stringify(catalog,null,2)+'\n');files=this.archive.capture(directory);
      }
    }
    let catalog=readNativeCatalog(directory,files);
    if(assignIds){
      // Ask Godot for the dependency graph. Normalize definitions before their
      // owners so stable metadata remains defined at its original scene.
      const done=new Set(),visiting=new Set();
      const normalize=async path=>{
        // A fixed native revision already normalized these exact scene bytes.
        // New IDs belong to changed definitions; unchanged owners inherit them
        // through PackedScene and must not be rewritten one by one.
        if(previousFiles?.[path]?.hash===files[path]?.hash)return;
        if(done.has(path))return;if(visiting.has(path))fail(422,'原生场景循环引用',{path});visiting.add(path);
        const response=await this.invoke(directory,{action:'inspect',scene_path:sourcePath(path)});
        for(const dependency of response.dependencies??[]){const relative=fromRes(dependency);if(relative!==path&&isScenePath(relative)&&files[relative])await normalize(relative);}
        await this.invoke(directory,{action:'apply',scene_path:sourcePath(path),ops:[],assign_ids:true});visiting.delete(path);done.add(path);
      };
      for(const path of Object.keys(files).filter(isScenePath))await normalize(path);
      files=this.archive.capture(directory);catalog=readNativeCatalog(directory,files);
    }
    const resources={},entries=Object.entries(catalog.resources),scene_paths=entries.map(([,resource])=>sourcePath(fromRes(resource.path)));
    let responses;
    try{
      responses=[];
      for(let offset=0;offset<scene_paths.length;offset+=512){
        const batchPaths=scene_paths.slice(offset,offset+512),batch=await this.invoke(directory,{action:'inspect_many',scene_paths:batchPaths});
        if(!Array.isArray(batch.scenes)||batch.scenes.length!==batchPaths.length)fail(422,'原生引擎没有返回完整批量场景索引');
        responses.push(...batch.scenes);
      }
    }catch(error){
      // Tool/static scripts and custom Resource constructors can retain process
      // state. Keep the previous fresh-process semantics for the entire set;
      // actual load/index errors must still reject instead of being retried.
      if(!error.details?.errors?.length||!error.details.errors.every(item=>item.code==='BATCH_SCRIPT_ISOLATION_REQUIRED'))throw error;
      responses=[];
      for(const scene_path of scene_paths)responses.push(await this.invoke(directory,{action:'inspect',scene_path}));
    }
    if(!Array.isArray(responses)||responses.length!==entries.length)fail(422,'原生引擎没有返回完整批量场景索引');
    for(let index=0;index<entries.length;index++){
      const [rid,resource]=entries[index],response=responses[index];
      if(response?.scene_path!==scene_paths[index])fail(422,'原生批量场景索引路径不匹配',{resource_id:rid});
      resources[rid]=nativeDocumentIndex(resource,response,files);
    }
    if(nativeSourceIdentity(this.archive.capture(directory))!==nativeSourceIdentity(files))fail(409,'读取场景索引期间源文件发生额外修改；候选未发布');
    const source_identity=nativeSourceIdentity(files);
    return{schema:NATIVE_SCHEMA,source_files:files,source_identity,index_source_identity:source_identity,entry_scene_id:catalog.entry_scene_id,resources,knowledge:clone(catalog.knowledge??{})};
  }
  async inspectFiles(files,{assignIds=false}={}){
    const work=mkdtempSync(join(this.directory,'index-')),project=join(work,'project');
    try{this.archive.materialize(files,project);return await this.indexDirectory(project,{assignIds});}finally{rmSync(work,{recursive:true,force:true});}
  }
  async prepare({manifest,input,project_id,...context}){
    if(input.ops.some(op=>op.type==='import_native_project')){
      if(input.ops.length!==1||input.expected_head!==context.head)fail(409,'导入完整原生工程必须固定当前源版本并独立提交');
      const supplied=input.ops[0].files;if(!Array.isArray(supplied)||!supplied.length)fail(422,'导入原生工程需要完整源文件');
      const files=this.archive.applyFiles({},supplied.map(file=>({...file,type:'put_source_file',expected_hash:null}))).files;
      const candidate=await this.inspectFiles(files,{assignIds:true});
      const inverse=manifest.schema===NATIVE_SCHEMA?nativeFileChanges(manifest.source_files,candidate.source_files).map(change=>({type:'restore_source_file',path:change.path,expected_hash:change.after?.hash??null,entry:change.before})):[];
      return{manifest:candidate,inverse,migration:{kind:'native_project_import',from_schema:manifest.schema,previous_source_retained:true}};
    }
    if(input.ops.some(op=>op.type==='migrate_native')){
      if(input.ops.length!==1||input.expected_head!==context.head)fail(409,'原生迁移必须固定当前源版本并独立提交');
      if(manifest.schema===NATIVE_SCHEMA)fail(409,'此分支已经是原生工程');
      if(!this.convertLegacy)fail(503,'原生迁移转换器尚未就绪');
      const converted=await this.convertLegacy({manifest,project_id,branch_id:context.branch_id}),files={};
      for(const [path,bytes]of converted.files instanceof Map?converted.files:Object.entries(converted.files))files[nativeSourcePath(path)]=this.archive.put(bytes);
      return{manifest:await this.inspectFiles(files,{assignIds:true}),inverse:[],migration:converted.migration};
    }
    if(manifest.schema!==NATIVE_SCHEMA)fail(409,'此分支尚未迁移为原生工程');
    if(input.discard_removed_overrides!==undefined&&(!Array.isArray(input.discard_removed_overrides)||input.discard_removed_overrides.length>100))fail(422,'覆盖清理必须列出具体实例');
    const discardResources=new Set();
    for(const acknowledgement of input.discard_removed_overrides??[]){const node=this.findNode(manifest,acknowledgement.resource_id,acknowledgement.target);if(node.version!==acknowledgement.expected_node_version)fail(409,'待处理的实例覆盖已变化');discardResources.add(acknowledgement.resource_id);}
    const fileOps=input.ops.filter(op=>['put_source_file','delete_source_file','restore_source_file'].includes(op.type));
    const metadataOps=input.ops.filter(op=>['create_native_resource','set_native_design','set_native_resource','put_knowledge','delete_knowledge'].includes(op.type));
    const modelOps=input.ops.filter(op=>op.type==='import_native_model');
    const sceneOps=input.ops.filter(op=>!fileOps.includes(op)&&!metadataOps.includes(op)&&!modelOps.includes(op));
    const creations=[];
    if(metadataOps.length){
      if(fileOps.some(op=>op.path===NATIVE_CATALOG))fail(422,'目录文件修改与语义目录操作不能混用');
      const catalog=JSON.parse(this.archive.read(manifest.source_files[NATIVE_CATALOG]));
      for(const op of metadataOps){
        if(['put_knowledge','delete_knowledge'].includes(op.type)){applyKnowledgeOperation(catalog,op);continue;}
        const rid=identifier(op.resource_id,'资源 ID'),current=manifest.resources[rid];
        if(op.type==='create_native_resource'){
          if(current||catalog.resources[rid])fail(409,'资源 ID 已存在');
          if(!['scene','prefab'].includes(op.kind)||typeof op.name!=='string'||!op.name.trim()||op.name.length>160)fail(422,'新资源名称或类型无效');
          const path=(op.kind==='scene'?'scenes/':'prefabs/')+rid+'.tscn';
          if(manifest.source_files[path])fail(409,'此原生场景路径已存在');
          catalog.resources[rid]={id:rid,kind:op.kind,name:op.name,path,design:normalizeNativeDesign(op.design??{})};
          creations.push({path,name:op.name,root_type:op.root_type??'Node3D',node_id:'root-'+rid});
        }else{
          if(!current)fail(404,'原生资源不存在');if(current.version!==op.expected_version)fail(409,'资源已变化，请重新读取');
          if(op.type==='set_native_design')catalog.resources[rid].design=normalizeNativeDesign(op.design);
          else{if(typeof op.name!=='string'||!op.name.trim()||op.name.length>160)fail(422,'资源名称无效');catalog.resources[rid].name=op.name;}
        }
      }
      fileOps.push({type:'put_source_file',path:NATIVE_CATALOG,expected_hash:manifest.source_files[NATIVE_CATALOG].hash,text:JSON.stringify(catalog,null,2)+'\n'});
    }
    const checked=sceneOps.map(op=>({resource_id:op.resource_id,operation:this.guardSceneOperation(manifest,op)}));
    for(const op of modelOps){
      const rid=identifier(op.resource_id,'资源 ID'),doc=manifest.resources[rid];
      if(!doc||op.expected_version!==doc.version)fail(409,'模型导入目标场景已变化');
      identifier(op.node_id,'对象 ID');
      if(typeof op.name!=='string'||!op.name.trim()||op.name.length>160||! /^[a-f0-9]{64}$/.test(op.asset_hash??''))fail(422,'模型导入参数无效');
      if(!this.readModelAsset)fail(503,'原生模型资产入口不可用');
      const bytes=await this.readModelAsset({project_id,asset_hash:op.asset_hash});
      if(hash(bytes)!==op.asset_hash)fail(409,'模型资产内容校验失败');
      const path='assets/'+op.asset_hash+'.glb';
      fileOps.push({type:'put_source_file',path,expected_hash:manifest.source_files[path]?.hash??null,data_base64:Buffer.from(bytes).toString('base64')});
      checked.push({resource_id:rid,operation:{op:'import_model',scene_path:sourcePath(path),asset_hash:op.asset_hash,node_id:op.node_id,name:op.name,...(op.parent?{parent:nativeTarget(this.findNode(manifest,rid,op.parent))}:{})}});
    }
    const changed=this.archive.applyFiles(manifest.source_files,fileOps),work=mkdtempSync(join(this.directory,'transaction-')),project=join(work,'project');
    try{
      this.archive.materialize(changed.files,project);
      // Each candidate has a fresh import cache. GLB and custom script classes
      // must be imported before the first scene edit, not only before reindexing.
      if(creations.length||checked.length||discardResources.size)await this.importProject({projectDirectory:project,godotPath:this.godotPath,enforceIsolation:this.enforceIsolation});
      for(const creation of creations)await this.invoke(project,{action:'create_scene',scene_path:sourcePath(creation.path),name:creation.name,root_type:creation.root_type,node_id:creation.node_id,ops:[],assign_ids:true});
      for(const {resource_id,operation}of checked){
        const path=fromRes(manifest.resources[resource_id].path);
        await this.invoke(project,{action:'apply',scene_path:sourcePath(path),ops:[operation],assign_ids:true});
      }
      const discarded=[];
      for(const rid of discardResources){const response=await this.invoke(project,{action:'apply',scene_path:sourcePath(fromRes(manifest.resources[rid].path)),ops:[],assign_ids:true,discard_removed_overrides:true});discarded.push(...(response.discarded_overrides??[]).map(item=>({resource_id:rid,...item})));}
      const candidate=await this.indexDirectory(project,{assignIds:fileOps.length>0,previousFiles:manifest.source_files});
      const removed=[];
      for(const [rid,beforeDoc]of Object.entries(manifest.resources)){
        const afterKeys=new Set((candidate.resources[rid]?.native_nodes??[]).map(node=>node.key));
        for(const node of beforeDoc.native_nodes??[]){
          if(!(node.instance_ids??[]).length||afterKeys.has(node.key)||!(node.properties??[]).some(p=>p.stored_locally&&p.overridden&&!p.name.startsWith('metadata/')))continue;
          const explicitlyDeleted=checked.some(item=>item.resource_id===rid&&item.operation.op==='delete_node'&&(()=>{const root=this.findNode(manifest,rid,item.operation.target);return node.path===root.path||node.path.startsWith(root.path+'/');})());
          if(explicitlyDeleted)continue;
          const acknowledged=(input.discard_removed_overrides??[]).some(item=>item.resource_id===rid&&addressKey(item.target)===node.key&&item.expected_node_version===node.version);
          if(!acknowledged)removed.push({resource_id:rid,target:nativeTarget(node),expected_node_version:node.version,path:node.path,properties:node.properties.filter(p=>p.stored_locally&&p.overridden&&!p.name.startsWith('metadata/')).map(p=>p.name)});
        }
      }
      if(removed.length)fail(409,'预制件修改会移除其他实例上的覆盖；请先处理这些实例',{code:'native_removed_overrides',removed_overrides:removed});
      let inverse;
      if(!fileOps.length&&sceneOps.every(op=>['set_native_property','reset_native_property','restore_native_property'].includes(op.type)&&reversibleValue(this.findNode(manifest,op.resource_id,op.target).properties.find(p=>p.name===op.property)?.value)&&reversibleValue(op.value))){
        const unique=new Map(sceneOps.map(op=>[stable([op.resource_id,addressKey(op.target),op.property]),op]));
        inverse=[...unique.values()].map(op=>{
          const before=this.findNode(manifest,op.resource_id,op.target).properties.find(property=>property.name===op.property);
          const after=this.findNode(candidate,op.resource_id,op.target).properties.find(property=>property.name===op.property);
          return{type:'restore_native_property',resource_id:op.resource_id,target:clone(op.target),property:op.property,expected_property_version:after.version,value:clone(before.value),stored_locally:before.stored_locally};
        });
      }else inverse=nativeFileChanges(manifest.source_files,candidate.source_files).map(change=>({type:'restore_source_file',path:change.path,expected_hash:change.after?.hash??null,entry:change.before}));
      return {manifest:candidate,inverse,...(discarded.length?{discarded_overrides:discarded}:{})};
    }finally{rmSync(work,{recursive:true,force:true});}
  }
  apply(...args){return this.transactions.apply(...args);}
  source(...args){return this.transactions.source(...args);}
  close(){return this.transactions.close();}
}
