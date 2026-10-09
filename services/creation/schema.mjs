import {normalizeDesign} from './semantic-design.mjs';
import { createHash, randomUUID } from 'node:crypto';

export const clone = value => structuredClone(value);
export const id = prefix => `${prefix}-${randomUUID()}`;
export const fail = (status, message, details) => { throw Object.assign(new Error(message), {status, details}); };
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
export function identifier(value, label='ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value) || ['constructor','prototype','__proto__'].includes(value)) fail(400, `${label} 无效`);
  return value;
}
export function name(value, fallback='未命名') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 160) fail(400,'名称须为 1–160 个字符');
  return value.trim();
}
export function vector(value, fallback=0, limit=1000, min=-limit) {
  value ??= [fallback,fallback,fallback];
  if (typeof value === 'number') value = [value,value,value];
  if (!Array.isArray(value) || value.length !== 3 || !value.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=limit)) fail(400,'变换需要有效的三轴数值');
  return [...value];
}
function jsonValue(value,depth=0) {
  if(depth>12)return false;
  if(value===null||typeof value==='boolean'||typeof value==='string')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.every(v=>jsonValue(v,depth+1));
  if(value&&typeof value==='object')return Object.values(value).every(v=>jsonValue(v,depth+1));
  return false;
}
export function object(value, assetAllowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'对象格式无效');
  const result=clone(value);
  identifier(result.id,'对象 ID'); result.name=name(result.name);
  if(result.prefab_property_overrides!==undefined){
    const overrides=result.prefab_property_overrides;
    if(!result.prefab||!overrides||typeof overrides!=='object'||Array.isArray(overrides))fail(422,'实例参数覆盖须为预制件实例上的对象');
    for(const [key,value]of Object.entries(overrides)){identifier(key,'参数 ID');if(value!==true)fail(422,'实例参数覆盖标记须为 true');}
  }
  if (result.parent_id != null) fail(422,'当前运行时尚不支持层级节点；不能静默丢弃 parent_id');
  result.position=vector(result.position); result.rotation=vector(result.rotation,0,36000); result.scale=vector(result.scale,1,5,.1);
  result.solid=Boolean(result.solid); result.kind=result.kind||'model';
  result.color=/^#[0-9a-fA-F]{6}$/.test(result.color||'')?result.color:'#74d5cd';
  if (result.model_url) {
    if (!/^\/preview-assets\/[a-f0-9]{64}\.glb$/.test(result.model_url) || !/^[a-f0-9]{64}$/.test(result.model_hash||'') || result.model_url!==`/preview-assets/${result.model_hash}.glb`) fail(400,'模型必须引用不可变 GLB 资产');
    if (!assetAllowed(result.model_hash,'glb')) fail(403,'当前项目不能访问该模型资产');
  } else if (result.kind!=='anchor') fail(400,'非锚点对象需要模型资产');
  result.components??={};
  if (!result.components || Array.isArray(result.components) || typeof result.components!=='object') fail(400,'组件格式无效');
  const components=result.components;
  if (Object.keys(components).some(k=>!['collider','interactable','trigger','behaviors'].includes(k))) fail(422,'存在当前运行时不支持的组件');
  for(const key of ['collider','interactable','trigger'])if(components[key]!==undefined&&(!components[key]||typeof components[key]!=='object'||Array.isArray(components[key])))fail(400,'组件格式无效：'+key);
  if (components.collider && !['trimesh','box'].includes(components.collider.shape)) fail(400,'碰撞形状无效');
  if (components.trigger && !['sphere','box'].includes(components.trigger.shape)) fail(400,'触发区形状无效');
  for (const component of [components.collider,components.trigger,components.interactable].filter(Boolean)) {
    if (component.size) component.size=vector(component.size,1,100,component===components.trigger?.1:.01);
    if (component.offset) component.offset=vector(component.offset);
    if (component.radius!==undefined && (typeof component.radius!=='number'||!Number.isFinite(component.radius)||component.radius<.1||component.radius>(component===components.interactable?20:100))) fail(400,'交互半径无效');
  }
  if(components.interactable?.label!==undefined&&(typeof components.interactable.label!=='string'||components.interactable.label.length>120))fail(400,'交互提示长度无效');
  if (components.behaviors) {
    if (!Array.isArray(components.behaviors)||components.behaviors.length>16) fail(400,'行为列表无效');
    const seen=new Set();
    for(const behavior of components.behaviors) {
      identifier(behavior.id,'行为 ID'); if(seen.has(behavior.id))fail(400,'行为 ID 重复');seen.add(behavior.id);
      if(behavior.api!==1||! /^[a-f0-9]{64}$/.test(behavior.script_hash||'')||behavior.script_url!==`/preview-assets/${behavior.script_hash}.gd`)fail(400,'行为需要 API 1 和不可变 GDScript 引用');
      if(!assetAllowed(behavior.script_hash,'gd'))fail(403,'当前项目不能访问该行为脚本');
      const properties=behavior.properties??{};
      if(!properties||typeof properties!=='object'||Array.isArray(properties)||!jsonValue(properties))fail(400,'行为参数必须是有限 JSON 对象');
      if(stable(properties).length>32768)fail(413,'行为参数过大');
    }
  }
  if (stable(result).length>200000) fail(413,'对象数据过大');
  delete result.change; delete result.developments;
  delete result.version; result.version=id('ov');
  return result;
}
export function resource(value, assetAllowed) {
  if(!value||!['scene','prefab'].includes(value.kind))fail(400,'资源类型须为 scene 或 prefab');
  const result={...clone(value),id:identifier(value.id,'资源 ID'),kind:value.kind,name:name(value.name),objects:[]};
  if(value.design!==undefined)result.design=normalizeDesign(value.design);
  if(!Array.isArray(value.objects)||value.objects.length>400)fail(400,'资源对象列表无效：每个资源最多 400 个对象');
  const seen=new Set();
  result.objects=value.objects.map(o=>{if(seen.has(o.id))fail(400,'对象 ID 重复');seen.add(o.id);return object(o,assetAllowed);});
  result.version=id('dv');
  return result;
}
