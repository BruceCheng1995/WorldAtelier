import {createParameterControl} from './semantic-inspector.js';
const definitions=[
 ['position','位置','vector2','px'],['size','尺寸','vector2','px'],
 ['anchors','锚点（左 / 上 / 右 / 下）','vector4','比例'],['offsets','偏移（左 / 上 / 右 / 下）','vector4','px'],
 ['pivot_offset','旋转中心','vector2','px'],['rotation_degrees','旋转','number','°'],['scale','缩放','vector2','倍'],
 ['custom_minimum_size','最小尺寸','vector2','px'],['grow_horizontal','横向增长','enum'],['grow_vertical','纵向增长','enum'],
 ['size_flags_horizontal','横向填充','enum'],['size_flags_vertical','纵向填充','enum'],['size_flags_stretch_ratio','扩展比例','number']];
const grow=[{value:0,label:'向前'},{value:1,label:'向后'},{value:2,label:'两侧'}];
const flags=[{value:0,label:'起点收缩'},{value:1,label:'填充'},{value:2,label:'起点并扩展'},{value:3,label:'填充并扩展'},{value:4,label:'居中收缩'},{value:6,label:'居中并扩展'},{value:8,label:'末端收缩'},{value:10,label:'末端并扩展'}];
const presets=[['','选择锚点布局…'],['top_left','左上'],['center','居中'],['top_right','右上'],['bottom_left','左下'],['bottom_right','右下'],['top_wide','顶部拉伸'],['bottom_wide','底部拉伸'],['left_wide','左侧拉伸'],['right_wide','右侧拉伸'],['full_rect','铺满父级']];
export function renderControlLayoutInspector(host,target,{disabled=false,onPreview,onCommit,onCancel,onError}){
  const doc=host.ownerDocument,layout=target.control_layout,values=layout.values;
  disabled=disabled||layout.needs_measurement===true;
  const note=doc.createElement('p');note.className='readonly-note';note.dataset.controlLayoutInfo='';
  note.textContent=layout.needs_measurement?'正在从原生场景读取布局尺寸…':layout.container_managed?`布局由 ${layout.parent_type} 管理。调整最小尺寸、填充方式和扩展比例；位置与尺寸由容器计算。`:`界面布局 · 参考画布 ${(layout.viewport_size??[]).join(' × ')} px。拖动边角可调整尺寸；锚点随父级尺寸响应。`;
  host.append(note);
  const actions=doc.createElement('div');actions.className='control-layout-actions';host.append(actions);
  if(!layout.container_managed){
    const select=doc.createElement('select');select.dataset.controlPreset='';select.setAttribute('aria-label','锚点布局预设');select.disabled=disabled;
    for(const [value,label]of presets){const option=doc.createElement('option');option.value=value;option.textContent=label;select.append(option);}
    select.onchange=()=>{if(select.value)Promise.resolve(onCommit({preset:select.value})).catch(onError);};actions.append(select);
  }
  const resetAll=doc.createElement('button');resetAll.type='button';resetAll.className='button subtle';resetAll.dataset.controlResetAll='';resetAll.textContent='恢复布局默认值';resetAll.disabled=disabled;
  resetAll.onclick=()=>Promise.resolve(onCommit({reset:definitions.map(([key])=>key).filter(key=>layout.fields[key]?.editable&&layout.fields[key]?.resettable&&!['position','size'].includes(key))})).catch(onError);actions.append(resetAll);
  for(const [key,name,type,unit]of definitions){
    const field=layout.fields[key],readonly=disabled||!field?.editable;
    if(layout.container_managed&&!field?.editable&&!['position','size'].includes(key))continue;
    const options=type==='enum'?[...(key.startsWith('grow_')?grow:flags)]:undefined;
    if(options&&!options.some(option=>option.value===values[key]))options.push({value:values[key],label:`自定义（${values[key]}）`});
    const control=createParameterControl(doc,{id:key,name:key==='anchors'?'锚点':key==='offsets'?'偏移':name,type,unit,options,axisLabels:['anchors','offsets'].includes(key)?['左','上','右','下']:undefined,description:name,min:['size','custom_minimum_size'].includes(key)?0:undefined,step:'any'},values[key],{disabled:readonly});
    control.row.dataset.controlLayout=key;control.row.dataset.overridden=String(Boolean(field?.overridden));
    control.row.title=field?.overridden?'已在当前实例覆盖；恢复默认会移除这组原生覆盖。':'Godot 原生布局属性';
    control.reset.disabled=readonly||!field?.resettable;control.reset.title='恢复来源默认值；位置与尺寸共同恢复四边偏移';
    control.reset.onclick=()=>Promise.resolve(onCommit({reset:[key]})).catch(onError);
    let draft=null,busy=false;
    const read=()=>{if(control.inputs.some(i=>i.value.trim()===''||!i.checkValidity()))return null;const numbers=control.inputs.map(i=>Number(i.value));if(numbers.some(n=>!Number.isFinite(n)))return null;return type.startsWith('vector')?numbers:numbers[0];};
    const commit=async()=>{if(draft===null||busy||readonly)return;busy=true;const value=draft;draft=null;try{await onCommit({value:{[key]:value}});}catch(error){onError(error);}finally{busy=false;}};
    for(const [axis,input]of control.inputs.entries()){
      input.dataset.controlField=key;input.dataset.controlAxis=String(axis);
      input.oninput=()=>{if(readonly||busy)return;draft=read();if(draft!==null)onPreview({[key]:draft});};
      input.onchange=()=>void commit();
      input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void commit();}else if(event.key==='Escape'){event.preventDefault();draft=null;control.inputs.forEach((item,i)=>item.value=Array.isArray(values[key])?values[key][i]:values[key]);onCancel();}};
    }
    host.append(control.row);
  }
}
export function updateControlLayoutInputs(host,values){
  for(const input of host.querySelectorAll('[data-control-field]')){
    if(input===host.ownerDocument.activeElement)continue;
    const value=values[input.dataset.controlField];if(value!=null)input.value=Array.isArray(value)?value[Number(input.dataset.controlAxis)]:value;
  }
}
