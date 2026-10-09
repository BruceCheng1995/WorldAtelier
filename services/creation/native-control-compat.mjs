import {clone} from './schema.mjs';
// Generated with ClassDB.get_inheriters_from_class("Control") plus Control on
// Godot 4.6.stable.official.89cea1439. get_class() retains the native base class
// for GDScript subclasses; a similarly named script property is not a Control.
const CONTROL_CLASSES=new Set(["AspectRatioContainer","BaseButton","BoxContainer","Button","CenterContainer","CheckBox","CheckButton","CodeEdit","ColorPicker","ColorPickerButton","ColorRect","Container","Control","EditorDock","EditorInspector","EditorProperty","EditorResourcePicker","EditorScriptPicker","EditorSpinSlider","EditorToaster","FileSystemDock","FlowContainer","FoldableContainer","GraphEdit","GraphElement","GraphFrame","GraphNode","GridContainer","HBoxContainer","HFlowContainer","HScrollBar","HSeparator","HSlider","HSplitContainer","ItemList","Label","LineEdit","LinkButton","MarginContainer","MenuBar","MenuButton","NinePatchRect","OpenXRBindingModifierEditor","OpenXRInteractionProfileEditor","OpenXRInteractionProfileEditorBase","OptionButton","Panel","PanelContainer","ProgressBar","Range","ReferenceRect","RichTextLabel","ScriptEditor","ScriptEditorBase","ScrollBar","ScrollContainer","Separator","Slider","SpinBox","SplitContainer","SubViewportContainer","TabBar","TabContainer","TextEdit","TextureButton","TextureProgressBar","TextureRect","Tree","VBoxContainer","VFlowContainer","VScrollBar","VSeparator","VSlider","VSplitContainer","VideoStreamPlayer"]);
const FIELDS={anchors:['anchor_left','anchor_top','anchor_right','anchor_bottom'],offsets:['offset_left','offset_top','offset_right','offset_bottom'],position:['offset_left','offset_top','offset_right','offset_bottom'],size:['offset_left','offset_top','offset_right','offset_bottom'],pivot_offset:['pivot_offset'],rotation_degrees:['rotation'],scale:['scale'],custom_minimum_size:['custom_minimum_size'],grow_horizontal:['grow_horizontal'],grow_vertical:['grow_vertical'],size_flags_horizontal:['size_flags_horizontal'],size_flags_vertical:['size_flags_vertical'],size_flags_stretch_ratio:['size_flags_stretch_ratio']};
const CONTAINER_FIELDS=new Set(['custom_minimum_size','size_flags_horizontal','size_flags_vertical','size_flags_stretch_ratio']);
/** Compatibility projection of already recorded Godot descriptors. This does
 * not evaluate inheritance or rect geometry and never modifies a revision. */
export function nativeControlLayout(node,parent=null){
  if(node.control_layout)return clone(node.control_layout);
  if(!CONTROL_CLASSES.has(node.type))return null;
  const properties=new Map((node.properties??[]).map(value=>[value.name,value]));
  const read=name=>{const value=properties.get(name)?.value;return clone(value?.$type==='Vector2'?value.value:value??null);};
  const managed=Boolean((properties.get('position')?.usage??0)&(1<<28));
  const fields={},values={};
  for(const [key,names]of Object.entries(FIELDS)){
    const descriptors=names.map(name=>properties.get(name)),complete=descriptors.every(Boolean);
    fields[key]={editable:complete&&(!managed||CONTAINER_FIELDS.has(key))&&descriptors.every(value=>(value.usage&2)&&!(value.usage&(1<<28))),resettable:complete&&descriptors.every(value=>value.default_known===true),stored_locally:descriptors.some(value=>value?.stored_locally===true),overridden:descriptors.some(value=>value?.overridden===true),storage_properties:clone(names)};
    // Old adapters inspected Controls off-tree. Their position/size zeros are
    // not a measured rect; the real static PackedScene supplies these on load.
    values[key]=['position','size'].includes(key)?null:names.length>1?names.map(read):read(names[0]);
    if(key==='rotation_degrees'&&values[key]!==null)values[key]=values[key]*180/Math.PI;
  }
  return {values,fields,container_managed:managed,parent_type:parent?.type??'Viewport',parent_path:parent?.path??'',parent_size:null,minimum_size:null,viewport_size:null,needs_measurement:true,descriptor_schema:'godot-4.6-control-properties-1'};
}
