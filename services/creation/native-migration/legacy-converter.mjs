import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {matrix,identityTransform,quaternionFromEulerDegrees} from './legacy-transform.mjs';

const clone=structuredClone;
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')}}`:JSON.stringify(value);
const hash=value=>createHash('sha256').update(Buffer.isBuffer(value)?value:typeof value==='string'?value:stable(value)).digest('hex');
const q=JSON.stringify;
const safe=value=>String(value).replace(/[^A-Za-z0-9_]/g,'_');
const nodeName=id=>'N_'+safe(id)+'_'+hash(id).slice(0,6);
const mountName=id=>'I_'+safe(id)+'_'+hash(id).slice(0,6);
export const propertyName=key=>'p_'+safe(key)+'_'+hash(key).slice(0,8);
export const behaviorNodeId=(nodeId,behaviorId)=>nodeId+'__behavior__'+behaviorId;
const behaviorName=id=>'B_'+safe(id)+'_'+hash(id).slice(0,6);
const scalar=value=>{if(!Number.isFinite(value))throw Error('Nonfinite native value');return Object.is(value,-0)?'0':String(value);};
const raw=text=>({native_expression:text});
function native(value){
  if(value&&typeof value==='object'&&Object.keys(value).length===1&&value.native_expression)return value.native_expression;
  if(value===null)return 'null';
  if(typeof value==='number')return scalar(value);
  if(typeof value==='boolean')return String(value);
  if(typeof value==='string')return q(value);
  if(Array.isArray(value))return '['+value.map(native).join(', ')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).map(([k,v])=>q(k)+': '+native(v)).join(', ')+'}';
  throw Error('Unsupported native value');
}
const vec=value=>raw('Vector3('+value.map(scalar).join(', ')+')');
const trans=value=>{const m=matrix(value);return raw('Transform3D('+[...m.slice(0,3),...m.slice(4,7),...m.slice(8,11),...m.slice(12,15)].map(scalar).join(', ')+')');};
const color=value=>{const rgb=/^#[a-fA-F0-9]{6}$/.test(value??'')?value:'#74d5cd';return raw('Color('+[1,3,5].map(i=>parseInt(rgb.slice(i,i+2),16)/255).join(', ')+', 1)');};
const pathJoin=(a,b)=>a==='.'?b:a+'/'+b;
const splitPath=value=>{const i=value.lastIndexOf('/');return i<0?['.',value]:[value.slice(0,i),value.slice(i+1)];};
const assetRef=(type,path)=>({resource_type:type,resource_path:path});
const sourcePath=doc=>(doc.kind==='prefab'?'prefabs/':'scenes/')+doc.id+'.tscn';
const historyPath=(revision)=>'atelier_history/prefabs/'+revision+'.tscn';
const addressKey=(instances,id,kind='node')=>stable([kind,instances,id]);
const typeKey=value=>value===null?'variant':Array.isArray(value)?'Array':typeof value==='object'?'Dictionary':typeof value==='number'?'float':typeof value==='boolean'?'bool':'String';
const identityProps=(node,doc)=>({'metadata/wa_node_id':node.id,'metadata/wa_label':node.name,'metadata/wa_resource_id':doc.id,'metadata/wa_source_version':node.version??'',...(node.legacy_object_id?{'metadata/wa_legacy_object_id':node.legacy_object_id}:{}),...(node.legacy_flat_instance?{'metadata/wa_legacy_flat_instance':true}:{})});
const runtimeFiles=['behavior.gd','object.gd','collider.gd','area.gd','runtime.gd','behavior_context.gd','behavior_registry.gd'];

/** One-time conversion only. Files become the native source authority after
 * commit; this converter never interprets native files or regenerates them.
 * readAsset must return original bytes, and is checked against every digest. */
export async function convertLegacyManifest({manifest:input,readAsset,readLegacyRuntimeFile=null,projectName='World Atelier Game'}){
  if(!['creation-flat-1','creation-hierarchy-2'].includes(input?.schema))throw Error('legacy_schema_required');
  if(typeof readAsset!=='function')throw Error('readAsset is required');
  for(const [id,doc]of Object.entries(input.resources??{}))if(id!==doc.id||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(id)||!['scene','prefab'].includes(doc.kind))throw Error('invalid_legacy_resource_identity');
  for(const [revision,doc]of Object.entries(input.prefab_revisions??{}))if(!/^[a-f0-9]{64}$/.test(revision)||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(doc.id)||doc.kind!=='prefab'||doc.version!==revision)throw Error('invalid_historical_prefab_identity');
  if(input.resources?.[input.entry_scene_id]?.kind!=='scene')throw Error('legacy_entry_scene_missing');
  const files=new Map(),assets=new Map(),compiled=new Map(),compiling=new Set(),scenes=new Map();
  const migration={format:1,from_schema:input.schema,legacy_manifest_sha256:hash(input),resources:{},historical_prefabs:{},instances:[],overrides:[],addresses:[],warnings:[]};
  const manifest=input.schema==='creation-flat-1'?normalizeFlat(input,migration):clone(input);
  const catalog={format:1,entry_scene_id:manifest.entry_scene_id,resources:{},...(input.knowledge!==undefined?{knowledge:clone(input.knowledge)}:{})};
  const addText=(path,text)=>files.set(path,Buffer.from(text.endsWith('\n')?text:text+'\n'));
  const addScene=(path,result)=>{scenes.set(path,result);addText(path,serialize(result));};
  for(const file of runtimeFiles){let source=await readFile(new URL('./runtime/'+file,import.meta.url),'utf8');if(file==='behavior_registry.gd')source=source.replace('res://behavior_context.gd','res://atelier_legacy/behavior_context.gd');addText('atelier_legacy/'+file,source);}

  // API1 scripts could preload host-provided fonts before their callbacks run.
  // Preserve those original paths and bytes as ordinary native source assets;
  // moving the new GameRuntime bootstrap must not break old script imports.
  const runtimeDependencies=new Map(),loadingRuntime=new Set();
  const runtimeReferences=bytes=>[...bytes.toString('utf8').matchAll(/(["'])res:\/\/([^"'\r\n]+)\1/g)].map(match=>match[2]).filter(path=>path.startsWith('fonts/'));
  async function legacyRuntimeFile(path){
    if(!path.startsWith('fonts/')||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('invalid_legacy_runtime_dependency:'+path);
    if(runtimeDependencies.has(path))return;
    if(loadingRuntime.has(path))throw Error('cyclic_legacy_runtime_dependency:'+path);
    if(typeof readLegacyRuntimeFile!=='function')throw Error('legacy_runtime_dependency_reader_required:'+path);
    loadingRuntime.add(path);
    const bytes=Buffer.from(await readLegacyRuntimeFile(path));
    if(files.has(path)&&hash(files.get(path))!==hash(bytes))throw Error('legacy_runtime_dependency_path_collision:'+path);
    files.set(path,bytes);runtimeDependencies.set(path,{path,sha256:hash(bytes),bytes:bytes.length});
    if(/\.(tres|tscn|gd)$/.test(path))for(const dependency of runtimeReferences(bytes))await legacyRuntimeFile(dependency);
    if(/\.(ttf|otf|woff2?)$/i.test(path))await legacyRuntimeFile(path.slice(0,path.lastIndexOf('/')+1)+'OFL.txt');
    loadingRuntime.delete(path);
  }

  async function asset(digest,ext){
    if(!/^[a-f0-9]{64}$/.test(digest??''))throw Error('invalid_legacy_asset_hash');
    const key=digest+'.'+ext,path='assets/'+key;
    if(!assets.has(key)){
      const bytes=Buffer.from(await readAsset(digest,ext));
      if(hash(bytes)!==digest)throw Error('legacy_asset_hash_mismatch:'+key);
      files.set(path,bytes);assets.set(key,path);
      if(ext==='gd')for(const dependency of runtimeReferences(bytes))await legacyRuntimeFile(dependency);
    }
    return path;
  }
  async function wrapper(behavior,nodeId){
    const properties=behavior.properties??{},signature=Object.keys(properties).sort().map(key=>[key,typeKey(properties[key])]);
    const path='atelier_legacy/behaviors/'+hash(signature)+'.gd';
    if(!files.has(path)){
      let code='extends "res://atelier_legacy/behavior.gd"\n';
      const nullable=[];
      for(const [key,type]of signature){
        const name=propertyName(key),zero=type==='float'?'0.0':type==='bool'?'false':type==='String'?'""':type==='Array'?'[]':type==='Dictionary'?'{}':'null';
        if(type==='variant'){code+='var '+name+' = null\n';nullable.push(name);}
        else code+='@export var '+name+': '+type+' = '+zero+'\n';
      }
      if(nullable.length)code+='\nfunc _get_property_list() -> Array[Dictionary]:\n\treturn ['+nullable.map(name=>'{"name":'+q(name)+', "type":TYPE_NIL, "usage":PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NIL_IS_VARIANT}').join(', ')+']\n';
      code+='\nfunc legacy_properties() -> Dictionary:\n\treturn {'+signature.map(([key])=>q(key)+': '+propertyName(key)).join(', ')+'}\n';
      addText(path,code);
    }
    const props={script:assetRef('Script',path),behavior_id:behavior.id,source_script:assetRef('Script',await asset(behavior.script_hash,'gd')),script_hash:behavior.script_hash,
      'metadata/wa_node_id':behaviorNodeId(nodeId,behavior.id),'metadata/wa_component':'behavior','metadata/wa_behavior_id':behavior.id,
      'metadata/wa_property_bindings':Object.fromEntries(Object.keys(properties).map(key=>[key,propertyName(key)]))};
    for(const [key,value]of Object.entries(properties))props[propertyName(key)]=clone(value);
    return {props,signature};
  }

  async function ownGraph(doc){
    const rows=new Map(),paths=new Map();
    const nodePath=id=>{if(paths.has(id))return paths.get(id);const n=doc.nodes[id];if(!n)throw Error('missing_parent:'+id);const p=id===doc.root_id?'.':pathJoin(nodePath(n.parent_id),nodeName(id));paths.set(id,p);return p;};
    for(const node of Object.values(doc.nodes)){
      const path=nodePath(node.id),props={...identityProps(node,doc),transform:trans(node.transform??identityTransform())};
      if(node.id===doc.root_id){props['metadata/wa_resource_kind']=doc.kind;props['metadata/wa_legacy_schema']=input.schema;}
      if(node.kind!=='group'){props.script=assetRef('Script','atelier_legacy/object.gd');props.author_color=color(node.color);props.author_kind=node.kind??'anchor';}
      rows.set(addressKey([],node.id),{key:addressKey([],node.id),id:node.id,kind:'node',instance_ids:[],path,type:'Node3D',props});
      if(node.model_hash){
        const modelPath=await asset(node.model_hash,'glb'),modelKey=addressKey([],node.id+'__model','technical');
        rows.set(modelKey,{key:modelKey,id:node.id+'__model',kind:'technical',instance_ids:[],path:pathJoin(path,'__Model'),instance:assetRef('PackedScene',modelPath),props:{'metadata/wa_asset_model':true}});
      }
      // Native nodes own physics configuration. Disabled defaults allow scalar
      // overrides without dynamically reinterpreting an aggregate components map.
      if(node.kind!=='group'){
        const comp=node.components??{},collider=comp.collider??{},colliderPath=pathJoin(path,'__Collider');
        rows.set(addressKey([],node.id+'__collider','technical'),{key:addressKey([],node.id+'__collider','technical'),id:node.id+'__collider',kind:'technical',instance_ids:[],path:colliderPath,type:'StaticBody3D',props:{script:assetRef('Script','atelier_legacy/collider.gd'),enabled:Boolean(node.solid||comp.collider),'metadata/wa_component':'collider',shape_kind:collider.shape??'trimesh',box_size:vec(collider.size??[1,1,1]),shape_offset:vec(collider.offset??[0,0,0]),collision_layer:0}});
        rows.set(addressKey([],node.id+'__collider_shape','technical'),{key:addressKey([],node.id+'__collider_shape','technical'),id:node.id+'__collider_shape',kind:'technical',instance_ids:[],path:pathJoin(colliderPath,'Shape'),type:'CollisionShape3D',props:{}});
        for(const kind of ['trigger','interactable']){
          const component=comp[kind]??{},areaPath=pathJoin(path,kind==='trigger'?'__Trigger':'__Interactable');
          rows.set(addressKey([],node.id+'__'+kind,'technical'),{key:addressKey([],node.id+'__'+kind,'technical'),id:node.id+'__'+kind,kind:'technical',instance_ids:[],path:areaPath,type:'Area3D',props:{script:assetRef('Script','atelier_legacy/area.gd'),enabled:Boolean(comp[kind]),component_kind:kind,'metadata/wa_component':kind,shape_kind:component.shape??'sphere',radius:component.radius??(kind==='trigger'?1:2),box_size:vec(component.size??[2,2,2]),shape_offset:vec(component.offset??[0,0,0]),interaction_label:component.label??'',collision_layer:0,monitoring:false,monitorable:false}});
          rows.set(addressKey([],node.id+'__'+kind+'_shape','technical'),{key:addressKey([],node.id+'__'+kind+'_shape','technical'),id:node.id+'__'+kind+'_shape',kind:'technical',instance_ids:[],path:pathJoin(areaPath,'Shape'),type:'CollisionShape3D',props:{}});
        }
      }
      for(const behavior of node.components?.behaviors??[]){const value=await wrapper(behavior,node.id),id=behaviorNodeId(node.id,behavior.id),key=addressKey([],id,'behavior');rows.set(key,{key,id,kind:'behavior',instance_ids:[],path:pathJoin(path,behaviorName(behavior.id)),type:'Node',props:value.props,property_signature:value.signature});}
    }
    return {rows,paths};
  }

  function topology(rows){
    return stable([...rows.values()].map(row=>[row.key,row.path,row.type??'',row.instance?.resource_path??'',row.property_signature??null]).sort((a,b)=>a[0].localeCompare(b[0])));
  }
  function prefixGraph(rows,instanceId,path){
    const result=new Map();
    for(const row of rows.values()){
      const next=clone(row);next.instance_ids=[instanceId,...next.instance_ids];next.key=addressKey(next.instance_ids,next.id,next.kind);next.path=row.path==='.'?path:pathJoin(path,row.path);result.set(next.key,next);
    }
    return result;
  }
  async function desiredInstance(instance,stack){
    const doc=manifest.prefab_revisions?.[instance.prefab_revision];
    if(!doc||doc.id!==instance.prefab_id)throw Error('missing_pinned_prefab:'+instance.prefab_revision);
    const candidate=clone(doc);
    // Old override precedence: inner layers first, outer layers last. Carry
    // nested edits into temporary native variants without changing source docs.
    const nested=[];
    for(const override of instance.overrides??[]){
      if(override.target.instance_path.length){nested.push(override);continue;}
      const node=candidate.nodes[override.target.definition_node_id];if(!node)throw Error('missing_override_node');
      let cursor=node;for(const key of override.path.slice(0,-1)){if(!cursor[key]||typeof cursor[key]!=='object')throw Error('missing_override_field');cursor=cursor[key];}
      cursor[override.path.at(-1)]=clone(override.value);
    }
    if(instance.name!==undefined)candidate.nodes[candidate.root_id].name=instance.name;
    // Name root override takes precedence over mount's local display name.
    for(const override of instance.overrides??[])if(!override.target.instance_path.length&&override.target.definition_node_id===candidate.root_id&&stable(override.path)===stable(['name']))candidate.nodes[candidate.root_id].name=override.value;
    const result=await compile(candidate,{historical:true,transient:true,outerOverrides:nested,stack});
    return result;
  }

  async function compile(doc,{historical=false,transient=false,outerOverrides=[],stack=[]}={}){
    const key=(historical?'history:':'active:')+hash(doc)+':'+hash(outerOverrides);
    if(compiled.has(key)){
      const previous=compiled.get(key);
      if(!transient){const path=historical?historyPath(doc.version??hash(doc)):sourcePath(doc);if(!files.has(path))addScene(path,previous);}
      return previous;
    }
    if(compiling.has(key)||stack.includes(doc.id))throw Error('native_prefab_cycle:'+doc.id);
    compiling.add(key);
    const graph=await ownGraph(doc),rows=graph.rows,own=new Map(rows),references=[],overrides=new Map(),nextStack=[...stack,doc.id];
    for(const original of Object.values(doc.instances??{})){
      const instance=clone(original);
      for(const override of outerOverrides){
        if(override.target.instance_path[0]!==instance.instance_id)continue;
        const rewritten={...clone(override),target:{...clone(override.target),instance_path:override.target.instance_path.slice(1)}};
        instance.overrides=instance.overrides.filter(old=>stable([old.target,old.path])!==stable([rewritten.target,rewritten.path]));
        instance.overrides.push(rewritten);
      }
      const desired=await desiredInstance(instance,nextStack);
      let base,referencePath,mode,reason;
      const current=manifest.resources[instance.prefab_id];
      if(!historical&&current?.kind==='prefab'&&!nextStack.includes(current.id)){
        const currentCompiled=await compile(current,{stack:nextStack});
        if(topology(currentCompiled.rows)===topology(desired.rows)){base=currentCompiled;referencePath=sourcePath(current);mode='follow_current';}
      }
      if(!base){
        const pinned=manifest.prefab_revisions[instance.prefab_revision];
        base=await compile(pinned,{historical:true,stack:nextStack});referencePath=historyPath(instance.prefab_revision);mode='explicit_history';reason=historical?'historical_dependency_closure':'topology_incompatible_with_current';
        if(topology(base.rows)!==topology(desired.rows)){
          // An old aggregate behaviors/model override may change structure.
          // Preserve it as an explicit native compatibility prefab; no masks.
          const variant='atelier_history/variants/'+hash({doc:pinned,instance,outerOverrides})+'.tscn';
          addScene(variant,desired);base=desired;referencePath=variant;reason='legacy_structural_override';
        }
      }
      const mountPath=pathJoin(graph.paths.get(instance.parent_id),mountName(instance.instance_id)),definitionPath=pathJoin(mountPath,'__Definition');
      const mount={key:addressKey([instance.instance_id],instance.instance_id,'mount'),id:instance.instance_id,kind:'mount',instance_ids:[instance.instance_id],path:mountPath,type:'Node3D',props:{transform:trans(instance.transform),'metadata/wa_instance_id':instance.instance_id,'metadata/wa_instance_mount':true,'metadata/wa_prefab_resource_id':instance.prefab_id,'metadata/wa_label':instance.name??manifest.prefab_revisions[instance.prefab_revision].name,'metadata/wa_migration_reference_mode':mode,...(reason?{'metadata/wa_migration_reference_reason':reason}:{}),...(instance.legacy_object_id?{'metadata/wa_legacy_object_id':instance.legacy_object_id}:{})}};
      rows.set(mount.key,mount);own.set(mount.key,mount);
      const reference={path:definitionPath,resource:assetRef('PackedScene',referencePath),props:{}};
      references.push(reference);
      const oldRows=prefixGraph(desired.rows,instance.instance_id,definitionPath),baseRows=prefixGraph(base.rows,instance.instance_id,definitionPath);
      for(const row of oldRows.values()){
        const source=baseRows.get(row.key);if(!source)throw Error('native_topology_mismatch');
        const changes={};
        for(const [property,value]of Object.entries(row.props)){
          if(property.startsWith('metadata/wa_source_')||property==='metadata/wa_resource_id')continue;
          if(stable(value)!==stable(source.props[property]))changes[property]=value;
        }
        if(instance.legacy_object_id&&row.id===instance.legacy_definition_node_id&&row.kind==='node'&&row.instance_ids.length===1){
          changes['metadata/wa_legacy_object_id']=instance.legacy_object_id;changes['metadata/wa_legacy_flat_instance']=true;
          row.props['metadata/wa_legacy_object_id']=instance.legacy_object_id;row.props['metadata/wa_legacy_flat_instance']=true;
        }
        if(Object.keys(changes).length){
          if(row.path===definitionPath)Object.assign(reference.props,changes);
          else overrides.set(row.path,{...(overrides.get(row.path)??{}),...changes});
          if(!historical&&!transient){
            for(const [property,value]of Object.entries(changes))if(!property.startsWith('metadata/'))migration.overrides.push({resource_id:doc.id,instance_ids:row.instance_ids,node_id:row.id,property,value:clone(value),source:'migration_preserve_value'});
          }
        }
        rows.set(row.key,row);
      }
      if(!historical&&!transient)migration.instances.push({resource_id:doc.id,instance_id:instance.instance_id,prefab_id:instance.prefab_id,legacy_revision:instance.prefab_revision,path:referencePath,mode,...(reason?{reason}:{}),...(instance.legacy_object_id?{legacy_object_id:instance.legacy_object_id}:{})});
    }
    const result={doc,rows,own,references,overrides};compiled.set(key,result);compiling.delete(key);
    if(!transient){
      const path=historical?historyPath(doc.version??hash(doc)):sourcePath(doc);addScene(path,result);
    }
    return result;
  }

  function serialize(value){
    const resources=new Map();
    function render(v){
      if(v&&typeof v==='object'&&v.resource_type&&v.resource_path){const key=stable([v.resource_type,v.resource_path]);if(!resources.has(key))resources.set(key,{...v,id:'r'+(resources.size+1)});return 'ExtResource('+q(resources.get(key).id)+')';}
      return native(v);
    }
    const blocks=[];
    for(const row of [...value.own.values()].sort((a,b)=>a.path==='.'?-1:b.path==='.'?1:a.path.split('/').length-b.path.split('/').length||(a.path.endsWith('/__Model')?-1:b.path.endsWith('/__Model')?1:0))){
      const [parent,name]=row.path==='.'?[null,'Root']:splitPath(row.path);
      const header='[node name='+q(name)+(row.type?' type='+q(row.type):'')+(parent!==null?' parent='+q(parent):'')+(row.instance?' instance='+render(row.instance):'')+']';
      blocks.push(header+'\n'+Object.entries(row.props).map(([k,v])=>k+' = '+render(v)).join('\n'));
    }
    for(const ref of value.references){const [parent,name]=splitPath(ref.path);blocks.push('[node name='+q(name)+' parent='+q(parent)+' instance='+render(ref.resource)+']\n'+Object.entries(ref.props).map(([k,v])=>k+' = '+render(v)).join('\n'));}
    for(const [path,props]of value.overrides){const [parent,name]=splitPath(path);blocks.push('[node name='+q(name)+' parent='+q(parent)+']\n'+Object.entries(props).map(([k,v])=>k+' = '+render(v)).join('\n'));}
    for(const ref of value.references)blocks.push('[editable path='+q(ref.path)+']');
    return '[gd_scene load_steps='+(resources.size+1)+' format=3]\n\n'+[...resources.values()].map(ref=>'[ext_resource type='+q(ref.resource_type)+' path='+q('res://'+ref.resource_path)+' id='+q(ref.id)+']').join('\n')+'\n\n'+blocks.join('\n\n')+'\n';
  }

  for(const doc of Object.values(manifest.resources)){
    const result=await compile(doc),path=sourcePath(doc);
    const design=doc.design?clone(doc.design):undefined;
    if(design)for(const property of design.exposed_properties??[]){const old=property.binding;property.legacy_binding=clone(old);property.binding={node_id:behaviorNodeId(old.node_id,old.behavior_id),property:propertyName(old.property_key)};}
    catalog.resources[doc.id]={id:doc.id,kind:doc.kind,name:doc.name,path,...(design?{design}:{})};
    migration.resources[doc.id]={path,legacy_version:doc.version??null};
    for(const row of result.rows.values())if(row.kind==='node')migration.addresses.push({resource_id:doc.id,legacy_object_id:row.props['metadata/wa_legacy_object_id']??null,instance_ids:row.instance_ids,node_id:row.id,path:row.path});
  }
  for(const [revision,doc]of Object.entries(manifest.prefab_revisions??{})){
    const result=await compile(doc,{historical:true});
    // Readable immutable keys remain exactly the revisions used by old refs.
    const path=historyPath(revision);if(!files.has(path))addScene(path,result);
    migration.historical_prefabs[revision]={resource_id:doc.id,path};
  }
  // Historic files remain part of the immutable source archive. Only those
  // reached from a current resource (including unplaced prefabs) are editable
  // compatibility definitions; unreachable snapshots are not public prefabs.
  const reachable=new Set(),pending=Object.values(catalog.resources).map(resource=>resource.path);
  while(pending.length){
    const path=pending.pop();if(reachable.has(path))continue;reachable.add(path);
    const result=scenes.get(path);if(!result)throw Error('missing_compiled_scene:'+path);
    for(const reference of result.references)pending.push(reference.resource.resource_path);
  }
  migration.compatibility_resources={};
  const registered=new Map(Object.values(catalog.resources).map(resource=>[resource.path,resource.id]));
  for(const path of [...reachable].filter(path=>!registered.has(path)).sort()){
    const result=scenes.get(path),doc=result.doc,source=manifest.resources[doc.id]??doc;
    let id='legacy-compat-'+hash(path).slice(0,32),salt=0;
    while(catalog.resources[id])id='legacy-compat-'+hash({path,salt:++salt}).slice(0,32);
    const label=doc.nodes[doc.root_id]?.name??doc.name;
    const name=(source.name+' · 兼容'+(label!==source.name?'：'+label:'版本 '+hash(path).slice(0,8))).slice(0,160);
    const design=doc.design?clone(doc.design):undefined,omitted=[];
    if(design)design.exposed_properties=(design.exposed_properties??[]).filter(property=>{
      const old=property.binding,node_id=behaviorNodeId(old.node_id,old.behavior_id),native_property=propertyName(old.property_key);
      const node=result.rows.get(addressKey([],node_id,'behavior'));
      if(!node||!Object.hasOwn(node.props,native_property)||typeKey(node.props[native_property])!==typeKey(property.default)){
        omitted.push({property_id:property.id,legacy_binding:clone(old),reason:'binding_not_present_or_type_changed'});return false;
      }
      property.legacy_binding=clone(old);property.binding={node_id,property:native_property};return true;
    });
    catalog.resources[id]={id,kind:'prefab',name,path,...(design?{design}:{})};registered.set(path,id);
    const direct=migration.instances.find(instance=>instance.path===path&&instance.mode==='explicit_history');
    migration.compatibility_resources[id]={path,source_resource_id:doc.id,legacy_revision:doc.version??null,reason:direct?.reason??'historical_dependency_closure',...(omitted.length?{omitted_exposed_properties:omitted}:{})};
    for(const row of result.rows.values())if(row.kind==='node')migration.addresses.push({resource_id:id,legacy_object_id:row.props['metadata/wa_legacy_object_id']??null,instance_ids:row.instance_ids,node_id:row.id,path:row.path});
  }
  catalog.archived_scene_paths=[...scenes.keys()].filter(path=>!registered.has(path)).sort();
  for(const instance of migration.instances)instance.native_prefab_id=registered.get(instance.path);
  if(runtimeDependencies.size)migration.legacy_runtime_dependencies=[...runtimeDependencies.values()].sort((a,b)=>a.path.localeCompare(b.path));
  addText('.atelier/catalog.json',JSON.stringify(catalog,null,2));
  addText('.atelier/migration.json',JSON.stringify(migration,null,2));
  if(input.knowledge!==undefined)addText('.atelier/knowledge.json',JSON.stringify(input.knowledge,null,2));
  // Bootstrap is deliberately only configuration. The canonical project
  // assembler installs the existing GameRuntime + standalone entry and drives
  // the compatibility bridge. It must not create a second game host here.
  addText('project.godot','config_version=5\n\n[application]\nconfig/name='+q(projectName)+'\nrun/main_scene='+q('res://'+catalog.resources[catalog.entry_scene_id].path)+'\nconfig/features=PackedStringArray("4.6", "GL Compatibility")\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  return {files,catalog,migration,assets:Object.fromEntries(assets)};
}

function normalizeFlat(input,migration){
  const resources={},revisions={};
  for(const source of Object.values(input.resources)){
    const stem='hierarchy-root-'+hash(source.id).slice(0,24),nodes={},ids=new Set(source.objects.map(node=>node.id));let root=stem,suffix=0;while(ids.has(root))root=stem+'-'+(++suffix);
    nodes[root]={id:root,name:source.name,kind:'group',parent_id:null,transform:identityTransform(),components:{}};
    for(const old of source.objects){nodes[old.id]={...clone(old),legacy_object_id:old.id,parent_id:root,transform:{position:clone(old.position??[0,0,0]),rotation:quaternionFromEulerDegrees(old.rotation??[0,0,0]),scale:typeof old.scale==='number'?[old.scale,old.scale,old.scale]:clone(old.scale??[1,1,1])}};}
    const doc={...clone(source),schema:2,root_id:root,nodes,instances:{}};delete doc.objects;
    doc.version=hash(doc);resources[source.id]=doc;
  }
  // A flat instance was one copied definition node; it was never a grouped
  // multi-node prefab. Preserve that meaning via explicit one-node fragments.
  // Single-object definitions become whole native prefab references.
  const originals=clone(resources);
  for(const doc of Object.values(resources)){
    for(const node of Object.values({...doc.nodes})){
      if(!node.prefab)continue;
      const source=originals[node.prefab];
      if(!source||source.kind!=='prefab'){
        migration.warnings.push({resource_id:doc.id,node_id:node.id,reason:'missing_flat_prefab_definition_preserved_as_local_node'});continue;
      }
      const candidates=Object.values(source.nodes).filter(n=>n.id!==source.root_id),sourceId=node.prefab_node_id??(candidates.length===1?candidates[0].id:node.id),definition=source.nodes[sourceId];
      if(!definition){migration.warnings.push({resource_id:doc.id,node_id:node.id,reason:'missing_flat_source_node_preserved_as_local_node'});continue;}
      let prefabId=source.id,prefabDoc=source;
      if(candidates.length!==1){
        prefabId='legacy-fragment-'+hash([source.id,sourceId]).slice(0,24);
        prefabDoc={...clone(source),id:prefabId,name:source.name+' · '+definition.name,nodes:{[source.root_id]:clone(source.nodes[source.root_id]),[sourceId]:clone(definition)},instances:{}};
        prefabDoc.version=hash(prefabDoc);revisions[prefabDoc.version]=prefabDoc;
        migration.warnings.push({resource_id:doc.id,node_id:node.id,prefab_id:source.id,reason:'flat_multinode_copy_preserved_as_explicit_native_fragment'});
      }
      revisions[prefabDoc.version]=clone(prefabDoc);
      const effective=clone(node);
      // Runtime flat source is the stored object value. The UI-only opt-in
      // prefab_property_overrides marker is retained, not assumed to have
      // altered a game value the runtime never resolved.
      const overrides=[];
      for(const field of ['transform','name','color','solid','model_hash','model_url','components'])if(effective[field]!==undefined&&stable(effective[field])!==stable(definition[field]))overrides.push({target:{instance_path:[],definition_node_id:sourceId},path:[field],value:clone(effective[field])});
      // The previous flat object is addressable as the copied source node;
      // do not put its translation on both the mount and definition.
      doc.instances[node.id]={instance_id:node.id,name:node.name,prefab_id:prefabId,prefab_revision:prefabDoc.version,parent_id:node.parent_id,transform:identityTransform(),overrides,legacy_object_id:node.id,legacy_definition_node_id:sourceId};
      delete doc.nodes[node.id];
    }
    doc.version=hash(doc);
  }
  for(const doc of Object.values(resources))if(doc.kind==='prefab')revisions[doc.version]=clone(doc);
  return {...clone(input),schema:'creation-hierarchy-2',resources,prefab_revisions:revisions};
}
