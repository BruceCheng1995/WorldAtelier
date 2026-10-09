import { createParameterControl } from './semantic-inspector.js';
import { randomUUID } from './client-platform.js';
// Independent workspace module. Host owns auth, route wiring, viewport and subscription lifecycle.
// read(scope)->branch; resolve(scope,branch)->resolved rows; transact(scope,payload)->receipt;
// preview(scope,{prefab_id,prefab_revision})->impact; onSelect(address), onOpenResource(resource_id).
import {matrix,quaternionFromEulerDegrees} from '../../packages/scene/transform.mjs';
const rotationDegrees=rotation=>{
  const m=matrix({position:[0,0,0],rotation,scale:[1,1,1]}),x=Math.asin(Math.max(-1,Math.min(1,-m[9]))),regular=Math.abs(Math.cos(x))>1e-7;
  return [x,regular?Math.atan2(m[8],m[10]):Math.atan2(-m[2],m[0]),regular?Math.atan2(m[1],m[5]):0].map(v=>v*180/Math.PI);
};
const copy=value=>structuredClone(value);
const identity=()=>({position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]});
const key=address=>JSON.stringify([...(address.instance_path??[]),address.definition_node_id]);
const el=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==null)node.textContent=text;for(const [k,v]of Object.entries(attrs))node.setAttribute(k,v);return node;};
const button=(label,action,{readOnlyAllowed=false}={})=>{const node=el('button',label,{type:'button'});if(['删除节点','删除此实例'].includes(label))node.setAttribute('data-inspector-delete','');if(readOnlyAllowed)node.dataset.readOnlyAllowed='true';node.addEventListener('click',action);return node;};
const style=`:host{display:block;color:var(--ink,#29424b);font:12px/1.55 system-ui;background:var(--panel,#fffefa)}*{box-sizing:border-box}section{padding:12px;border-bottom:1px solid var(--line,#dce4dc)}h3{font-size:12px;margin:0 0 10px}button,input,select,textarea{font:inherit;color:inherit;background:var(--panel2,#f2f5ef);border:1px solid var(--line,#dce4dc);border-radius:5px;padding:7px}button{cursor:pointer}button:hover{background:var(--panel3,#edf2ec);border-color:var(--cyan,#397f80)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--cyan,#397f80);outline-offset:2px}button:disabled{opacity:.45;cursor:not-allowed}input,select{max-width:100%;min-width:0}input[type=number]{width:100%}label{display:block;margin:9px 0 4px}.row{display:flex;gap:6px;align-items:center;margin:5px 0}.row>*{min-width:0}.row input{flex:1}.tree{display:block;width:100%;text-align:left;margin:3px 0}.tree[aria-selected=true]{border-color:var(--cyan,#397f80);background:var(--panel3,#edf2ec)}.muted{font-size:11px;color:var(--muted,#687f84);overflow-wrap:anywhere}.status{padding:10px;white-space:pre-wrap}.status:empty{display:none}.error{color:#a34433}.success{color:var(--cyan,#397f80)}.conflict{border:1px solid var(--amber,#a4702c);padding:8px;margin:7px 0}.conflict input{margin-right:5px}.catalog{display:grid;grid-template-columns:1fr auto auto;gap:5px;margin:5px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px}.transform{border:1px solid var(--line,#dce4dc);padding:8px;margin-top:10px}small{display:block;color:var(--muted,#687f84)}summary{cursor:pointer}form>button{margin-top:8px}`;
export class HierarchyPrefabPanel {
  constructor(host,hooks,{regions=null,readOnly=false,showNodeTransform=true,semanticPresentation=false}={}) {
    const names=regions??['tree','inspector','catalog','impact'];if(!Array.isArray(names)||names.some(r=>!['tree','inspector','catalog','impact'].includes(r)))throw new Error('未知层级面板区域');
    this.regions=new Set(names);this.readOnly=Boolean(readOnly);this.showNodeTransform=Boolean(showNodeTransform);this.semanticPresentation=Boolean(semanticPresentation);
    this.hooks=hooks;this.root=host.attachShadow({mode:'open'});this.generation=0;this.snapshotGeneration=0;this.selected=null;this.undo=[];this.status='';this.error=false;this.busy=false;this.impact=null;
  }
  async setContext(scope) {
    this.scope=copy(scope);this.generation++;this.selected=null;this.undo=[];this.impact=null;this.branch=null;this.rows=[];return this.refresh();
  }
  async refresh() {
    const generation=this.generation,snapshotGeneration=++this.snapshotGeneration,scope=copy(this.scope);
    try{const branch=await this.hooks.read(scope);const rows=branch.manifest.schema==='creation-flat-1'?[]:await this.hooks.resolve(scope,branch);if(generation!==this.generation||snapshotGeneration!==this.snapshotGeneration)return;this.branch=copy(branch);this.rows=copy(rows);this.render();}
    catch(error){if(generation===this.generation)this.message(error.message,true);}
  }
  async setSnapshot(branch) {
    const generation=this.generation,snapshotGeneration=++this.snapshotGeneration,head=branch.head;
    const rows=branch.manifest.schema==='creation-flat-1'?[]:await this.hooks.resolve(copy(this.scope),branch);if(generation!==this.generation||snapshotGeneration!==this.snapshotGeneration)return;
    this.branch=copy(branch);this.rows=copy(rows);if(this.impact?.source_revision!==head)this.impact=null;this.render();
  }
  message(text,error=false){this.status=text;this.error=error;const node=this.root.querySelector('[role=status]');if(node){node.textContent=text;node.className='status '+(error?'error':'success');}}
  async run(action) {
    if(this.readOnly){this.message('当前为只读视图，不能提交编辑。',true);return false;}
    if(this.busy)return;this.busy=true;this.syncDisabled();
    try{await action();}catch(error){this.message(error.message,true);}
    finally{this.busy=false;this.syncDisabled();}
  }
  async submit(ops,{expected_head,undo=false}={}) {
    if(this.readOnly)throw Object.assign(new Error('当前为只读视图，不能提交编辑。'),{status:403,code:'read_only'});
    const scope=copy(this.scope),generation=this.generation,base=this.branch.head;
    const receipt=await this.hooks.transact(scope,{transaction_id:'hierarchy-'+randomUUID(),base_revision:base,ops:copy(ops),...(expected_head?{expected_head}:{})});
    if(generation!==this.generation)return receipt;
    if(!undo&&receipt.inverse?.length)this.undo.push(copy(receipt.inverse));
    if(undo)this.undo.pop();this.impact=null;this.status='源稿已保存；试玩版本由运行服务另行确认。';this.error=false;
    await this.refresh();return receipt;
  }
  setReadOnly(value){this.readOnly=Boolean(value);this.syncDisabled();}
  syncDisabled(){
    this.root.querySelectorAll('button').forEach(b=>b.disabled=this.busy||(this.readOnly&&b.dataset.readOnlyAllowed!=='true'));
    this.root.querySelectorAll('input,select,textarea').forEach(input=>input.disabled=this.busy||this.readOnly);
  }
  setSelection(address,{notify=false}={}){
    if(address&&['project_id','branch_id','resource_id'].some(k=>address[k]!==this.scope?.[k]))throw new Error('选择不属于当前面板作用域');
    const next=address?key(address):null,changed=next!==this.selected;this.selected=next;
    if(notify&&changed)this.hooks.onSelect?.(address?copy(address):null);this.render();
  }
  select(address){this.setSelection(address,{notify:true});}
  setImpact(value){if(value&&value.source_revision!==this.branch?.head)throw new Error('影响预览不属于当前源版本');this.impact=value?copy(value):null;this.render();}

  render() {
    this.root.replaceChildren(el('style',style+(this.semanticPresentation?'[data-inspector-delete]{display:none}':'')),el('link',null,{rel:'stylesheet',href:'/semantic-authoring.css'}));
    this.root.append(el('div',this.status,{role:'status','aria-live':'polite',class:'status '+(this.error?'error':'success')}));
    if(!this.branch)return;
    if(this.branch.manifest.schema!=='creation-hierarchy-2'){
      const section=el('section',null);section.append(el('p','当前为旧平级文档。迁移会保存新的层级源稿，正在运行的版本保持自己的协议。'));
      if(this.regions.has('tree'))section.append(button('迁移此分支的源稿',()=>this.run(()=>this.submit([{type:'migrate_hierarchy'}],{expected_head:this.branch.head}))));this.root.append(section);this.syncDisabled();return;
    }
    const doc=this.branch.manifest.resources[this.scope.resource_id];
    if(this.regions.has('tree')){
    const tree=el('section',null);tree.append(el('h3','场景层级'),el('small',doc.name+' · '+this.scope.branch_id));
    const depths=new Map();
    for(const row of this.rows){
      const depth=row.parent_key?1+(depths.get(row.parent_key)??0):0;depths.set(row.key,depth);
      const item=button(row.node.name+(row.address.instance_path.length?' · 实例内容':''),()=>this.select(row.address),{readOnlyAllowed:true});item.className='tree';item.style.paddingLeft=(8+depth*13)+'px';item.setAttribute('aria-selected',String(this.selected===key(row.address)));item.dataset.address=key(row.address);tree.append(item);
    }
    const actions=el('div',null,{class:'row'});
    actions.append(button('添加空组',()=>this.run(()=>{const id='group-'+randomUUID(),selected=this.rows.find(r=>key(r.address)===this.selected);return this.submit([{type:'put_node',resource_id:doc.id,node_id:id,expected_version:null,node:{id,name:'新组',kind:'group',parent_id:selected&&!selected.address.instance_path.length?selected.node.id:doc.root_id,transform:identity(),components:{},solid:false}}]);})),button('撤销上一笔',()=>this.run(()=>this.undo.length?this.submit(this.undo.at(-1),{undo:true}):this.message('没有可撤销的操作。'))));tree.append(actions);this.root.append(tree);
    }
    const row=this.rows.find(r=>key(r.address)===this.selected);
    if(this.regions.has('inspector')){if(row)this.renderInspector(doc,row);else if(this.selected){const gone=el('section','选中的节点已删除或实例路径失效，原选择不会绑定其他节点。');this.root.append(gone);}}
    if(this.regions.has('catalog'))this.renderCatalog(doc);if(this.regions.has('impact')&&this.impact)this.renderImpact();
    this.syncDisabled();
  }
  transformForm(label,value,save) {
    const form=el('form',null,{class:'transform'});form.append(el('h3',label));const inputs={};
    for(const [field,title]of [['position','坐标'],['rotation','旋转'],['scale','缩放']]){
      const valueVector=field==='rotation'?rotationDegrees(value.rotation):value[field];
      const control=createParameterControl(document,{type:'vector3',name:title,unit:field==='position'?'m':field==='rotation'?'°':'倍',min:field==='scale'?.1:undefined,step:'any'},valueVector,{disabled:this.readOnly});
      inputs[field]=control.inputs;form.append(control.row);
    }
    const submit=el('button','保存变换',{type:'submit'});form.append(submit);form.addEventListener('submit',event=>{event.preventDefault();this.run(()=>{const transform=Object.fromEntries(Object.entries(inputs).map(([field,list])=>[field,list.map(input=>Number(input.value))]));transform.rotation=quaternionFromEulerDegrees(transform.rotation);return save(transform);});});return form;
  }
  renderInspector(doc,row) {
    const section=el('section',null);
    const inherited=row.address.instance_path.length>0,instance=inherited?doc.instances[row.address.instance_path[0]]:null;
    section.append(el('p',inherited?'正在修改：仅此实例覆盖':'正在修改：'+(doc.kind==='prefab'?'预制件定义':'场景节点'),{class:'muted'}));
    const reference=el('details',null);reference.append(el('summary','对象引用'),el('pre',JSON.stringify(row.address,null,2),{class:'muted'}));if(!this.semanticPresentation)section.append(reference);
    const target={instance_path:row.address.instance_path.slice(1),definition_node_id:row.address.definition_node_id};
    const saveField=(field,value)=>this.submit([inherited?{type:'set_override',resource_id:doc.id,instance_id:instance.instance_id,expected_version:instance.version,override:{target,path:[field],value}}:{type:'patch_node',resource_id:doc.id,node_id:row.node.id,expected_version:row.node.version,patch:{[field]:value}}]);
    if(this.showNodeTransform)section.append(this.transformForm(inherited?'内部节点局部变换':'节点局部变换',row.local_transform,value=>saveField('transform',value)));
    if(inherited){
      if(!this.semanticPresentation)section.append(button('打开预制件定义',()=>this.hooks.onOpenResource?.(row.definition_resource_id),{readOnlyAllowed:true}));
      if(row.address.instance_path.length===1&&row.node.id===this.branch.manifest.prefab_revisions[instance.prefab_revision].root_id){
        const mount=el('details',null);mount.append(el('summary','实例挂载偏移'),this.transformForm('相对挂载父级',instance.transform,value=>this.submit([{type:'patch_instance',resource_id:doc.id,instance_id:instance.instance_id,expected_version:instance.version,patch:{transform:value}}])));section.append(mount);
        this.renderReparent(section,doc,row,instance);
      }
      const overrides=instance.overrides.filter(o=>key(o.target)===key(target));
      for(const override of overrides.filter(o=>!this.semanticPresentation||['transform'].includes(o.path[0])))section.append(button('恢复定义值：'+(this.semanticPresentation?({name:'名称',color:'颜色',transform:'空间布局'}[override.path[0]]):override.path.join('.')),()=>this.run(()=>this.submit([{type:'remove_override',resource_id:doc.id,instance_id:instance.instance_id,expected_version:instance.version,override}]))));
    }else if(row.node.id!==doc.root_id)this.renderReparent(section,doc,row,null);
    if(!inherited&&row.node.id!==doc.root_id){const cascade=el('input',null,{type:'checkbox','aria-label':'同时删除子内容'}),label=el('label',null);label.append(cascade,document.createTextNode('同时删除子内容'));section.append(label,button('删除节点',()=>this.run(()=>this.submit([{type:'delete_node',resource_id:doc.id,node_id:row.node.id,expected_version:row.node.version,cascade:cascade.checked}]))));}
    if(inherited&&row.address.instance_path.length===1&&row.node.id===this.branch.manifest.prefab_revisions[instance.prefab_revision].root_id)section.append(button('删除此实例',()=>this.run(()=>this.submit([{type:'delete_instance',resource_id:doc.id,instance_id:instance.instance_id,expected_version:instance.version}]))));
    const components=el('details',null);components.append(el('summary','组件参数（JSON）'));const json=el('textarea',null,{'aria-label':'组件参数',rows:'7'});json.value=JSON.stringify(row.node.components,null,2);json.style.width='100%';components.append(json,button('保存组件参数',()=>this.run(async()=>{
      const value=JSON.parse(json.value);
      if(inherited){const fields=Object.keys(value);if(fields.some(field=>!Object.hasOwn(row.node.components,field))||Object.keys(row.node.components).some(field=>!Object.hasOwn(value,field)))throw new Error('实例不能增删组件，请打开定义编辑。');
        if(fields.length)await this.submit([{type:'set_overrides',resource_id:doc.id,instance_id:instance.instance_id,expected_version:instance.version,overrides:fields.map(field=>({target,path:['components',field],value:value[field]}))}]);
      }else await saveField('components',value);
    })));if(!this.semanticPresentation)section.append(components);this.root.append(section);
  }
  renderReparent(section,doc,row,instance) {
    const select=el('select',null,{'aria-label':'新父级'});
    for(const node of Object.values(doc.nodes))if(instance||node.id!==row.node.id){const option=el('option',node.name,{value:node.id});option.selected=node.id===(instance?.parent_id??row.node.parent_id);select.append(option);}
    const keep=el('input',null,{type:'checkbox','aria-label':'保持世界变换'});keep.checked=true;const label=el('label',null);label.append(keep,document.createTextNode('保持世界变换'));section.append(select,label,button('重挂父级',()=>this.run(()=>{
      const parent=this.rows.find(r=>!r.address.instance_path.length&&r.node.id===select.value),oldParent=instance?this.rows.find(r=>!r.address.instance_path.length&&r.node.id===instance.parent_id):null;
      return this.submit([{type:instance?'reparent_instance':'reparent_node',resource_id:doc.id,...(instance?{instance_id:instance.instance_id,expected_version:instance.version,expected_old_parent_version:oldParent.node.version}:{node_id:row.node.id,expected_version:row.node.version}),parent_id:parent.node.id,keep_world:keep.checked,expected_ancestry_hash:instance?oldParent.ancestry_hash:row.ancestry_hash,expected_parent_ancestry_hash:parent.ancestry_hash,expected_parent_version:parent.node.version}]);
    })));
  }
  renderCatalog(doc) {
    const section=el('section',null);section.append(el('h3','全部预制件（含未摆放）'));
    for(const prefab of Object.values(this.branch.manifest.resources).filter(r=>r.kind==='prefab')){
      const line=el('div',null,{class:'catalog'});line.append(el('span',prefab.name),button('独立编辑',()=>this.hooks.onOpenResource?.(prefab.id),{readOnlyAllowed:true}),button('放入',()=>this.run(()=>{
        const instance_id='instance-'+randomUUID();return this.submit([{type:'instantiate_prefab',resource_id:doc.id,instance_id,expected_version:null,instance:{instance_id,prefab_id:prefab.id,prefab_revision:prefab.version,parent_id:doc.root_id,transform:identity(),overrides:[]}}]);
      })));section.append(line,button('查看定义更新影响：'+prefab.name,()=>this.run(async()=>{
        const generation=this.generation,impact=await this.hooks.preview(copy(this.scope),{prefab_id:prefab.id,prefab_revision:prefab.version});if(generation!==this.generation)return;this.impact=impact;this.render();
      })));
    }
    this.root.append(section);
  }
  renderImpact() {
    const section=el('section',null);section.append(el('h3','定义更新影响'),el('p','只更新以下明确选择的实例；其他实例继续固定旧版本。'));
    for(const plan of this.impact.direct){
      const block=el('div',null,{class:'conflict'});block.append(el('p',plan.resource_name+' / '+plan.instance_name+' · '+plan.instance_id),el('p',`${plan.changes.length} 个节点变化，${plan.retained.length} 项覆盖保留，${plan.conflicts.length} 项冲突`));
      const changes=el('details',null);changes.append(el('summary','查看节点变化'));for(const change of plan.changes)changes.append(el('p',change.name+'：'+({added:'新增',deleted:'删除',changed:'修改'}[change.kind])+' '+change.changed_fields.map(field=>({components:'组件',transform:'局部变换',color:'颜色',name:'名称',model_hash:'模型',model_url:'模型',solid:'碰撞'}[field]??field)).join('、')));block.append(changes);
      const choices={};
      for(const conflict of plan.conflicts){const check=el('input',null,{type:'checkbox'}),label=el('label',null);label.append(check,document.createTextNode('放弃此覆盖：'+conflict.target.definition_node_id+' '+conflict.path.join('.')+'（'+({node_or_instance_path_deleted:'节点或嵌套路径已删除',override_field_deleted:'定义已删除此字段',override_type_changed:'字段类型已变化',component_variant_changed:'组件类型已变化',behavior_definition_changed:'行为脚本已变化'}[conflict.reason]??'定义不兼容')+'）'));choices[conflict.override_key]=check;block.append(label);}
      block.append(button('确认更新此实例',()=>this.run(()=>this.submit([{type:'upgrade_instance',resource_id:plan.resource_id,instance_id:plan.instance_id,expected_version:plan.instance_version,prefab_revision:plan.to_revision,expected_preview_hash:plan.preview_hash,resolutions:Object.fromEntries(Object.entries(choices).filter(([,input])=>input.checked).map(([key])=>[key,'drop_override']))}],{expected_head:this.impact.source_revision}))));section.append(block);
    }
    for(const item of this.impact.nested)section.append(el('p',item.resource_id+' / '+item.instance_path.join(' → ')+'：先升级外层定义，再更新场景引用。',{class:'muted'}));
    if(!this.impact.direct.length&&!this.impact.nested.length)section.append(el('p','所有直接实例已经使用此版本，或尚未摆放。'));
    this.root.append(section);
  }
  destroy(){this.generation++;this.root.replaceChildren();this.branch=null;this.rows=[];}
}
