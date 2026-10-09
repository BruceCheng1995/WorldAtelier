// Codex CLI 0.147.0 McpElicitationSchema / McpServerElicitationRequestResponse.
// No remote schema resolution, URL navigation, code evaluation, or auto-answer.
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key));
const text=value=>typeof value==='string'&&value.length<=10000;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const reject=message=>{throw Object.assign(new Error(message),{status:400});};
const supported=condition=>{if(!condition)throw Error('请求包含当前不支持或无效的表单结构');};
const base=['type','title','description','default'];
function optionsFrom(schema){
  if(own(schema,'enum')){
    supported(Array.isArray(schema.enum)&&schema.enum.length>0&&schema.enum.length<=100&&schema.enum.every(text)&&new Set(schema.enum).size===schema.enum.length);
    if(own(schema,'enumNames'))supported(Array.isArray(schema.enumNames)&&schema.enumNames.length===schema.enum.length&&schema.enumNames.every(text));
    return schema.enum.map((value,i)=>({value,label:schema.enumNames?.[i]??value}));
  }
  const options=schema.oneOf??schema.anyOf;
  supported(Array.isArray(options)&&options.length>0&&options.length<=100&&options.every(option=>keys(option,['const','title'])&&text(option.const)&&text(option.title)));
  supported(new Set(options.map(option=>option.const)).size===options.length);
  return options.map(option=>({value:option.const,label:option.title}));
}
function field(name,schema,required){
  supported(keys(schema,[...base,'minLength','maxLength','format','minimum','maximum','enum','enumNames','oneOf','items','minItems','maxItems']));
  for(const key of ['title','description'])if(own(schema,key))supported(text(schema[key]));
  const result={name,type:schema.type,title:schema.title??name,description:schema.description??'',required};
  if(schema.type==='string'){
    if(own(schema,'enum')||own(schema,'oneOf')){
      supported(!(own(schema,'enum')&&own(schema,'oneOf'))&&keys(schema,own(schema,'enum')?[...base,'enum','enumNames']:[...base,'oneOf']));
      result.type='enum';result.options=optionsFrom(schema);
    }else{
      supported(keys(schema,[...base,'minLength','maxLength','format']));
      for(const key of ['minLength','maxLength'])if(own(schema,key)){supported(count(schema[key]));result[key]=schema[key];}
      supported(result.minLength===undefined||result.maxLength===undefined||result.minLength<=result.maxLength);
      if(own(schema,'format')){supported(['email','uri','date','date-time'].includes(schema.format));result.format=schema.format;}
    }
  }else if(['number','integer'].includes(schema.type)){
    supported(keys(schema,[...base,'minimum','maximum']));
    for(const key of ['minimum','maximum'])if(own(schema,key)){supported(typeof schema[key]==='number'&&Number.isFinite(schema[key]));result[key]=schema[key];}
    supported(result.minimum===undefined||result.maximum===undefined||result.minimum<=result.maximum);
  }else if(schema.type==='boolean')supported(keys(schema,base));
  else if(schema.type==='array'){
    supported(keys(schema,[...base,'minItems','maxItems','items']));
    const items=schema.items;
    supported(keys(items,['type','enum'])&&items.type==='string'&&own(items,'enum')||keys(items,['anyOf'])&&own(items,'anyOf'));
    result.type='enum-array';result.options=optionsFrom(items);
    for(const key of ['minItems','maxItems'])if(own(schema,key)){supported(count(schema[key]));result[key]=schema[key];}
    supported(result.minItems===undefined||result.maxItems===undefined||result.minItems<=result.maxItems);
  }else supported(false);
  if(own(schema,'default')){validateField(result,schema.default);result.default=structuredClone(schema.default);}
  return result;
}
function validDate(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;
}
function validateField(field,value){
  const invalid=()=>reject(`字段 ${field.title} 的值不符合请求格式`);
  if(field.type==='string'){
    if(!text(value))invalid();const length=Array.from(value).length;
    if(field.minLength!==undefined&&length<field.minLength||field.maxLength!==undefined&&length>field.maxLength)invalid();
    if(field.format==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))invalid();
    if(field.format==='uri'){try{new URL(value);}catch{invalid();}} // Parses only; never opens or fetches.
    if(field.format==='date'&&!validDate(value))invalid();
    if(field.format==='date-time'&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)||!validDate(value.slice(0,10))||!Number.isFinite(Date.parse(value))))invalid();
  }else if(field.type==='number'||field.type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||field.type==='integer'&&!Number.isSafeInteger(value)||field.minimum!==undefined&&value<field.minimum||field.maximum!==undefined&&value>field.maximum)invalid();
  }else if(field.type==='boolean'){if(typeof value!=='boolean')invalid();}
  else if(field.type==='enum'){if(!field.options.some(option=>option.value===value))invalid();}
  else if(field.type==='enum-array'){
    if(!Array.isArray(value)||value.length>100||value.some(v=>!field.options.some(option=>option.value===v))||field.minItems!==undefined&&value.length<field.minItems||field.maxItems!==undefined&&value.length>field.maxItems)invalid();
  }else invalid();
}
export function describeElicitation(params){
  const result={mode:params?.mode??null,supported:false,reason:null,fields:[],actions:['decline','cancel']};
  if(params?.mode!=='form'){result.reason='此交互模式尚未支持；可以拒绝或取消，工作台不会自动打开网址或登录';return result;}
  try{
    const schema=params.requestedSchema;
    supported(keys(schema,['$schema','type','properties','required'])&&schema.type==='object'&&object(schema.properties));
    if(own(schema,'$schema'))supported(text(schema.$schema)); // An identifier, not an instruction to fetch it.
    const names=Object.keys(schema.properties);supported(names.length<=64&&names.every(name=>text(name)&&name.length>0&&!['__proto__','prototype','constructor'].includes(name)));
    const required=schema.required??[];supported(Array.isArray(required)&&required.every(name=>names.includes(name))&&new Set(required).size===required.length);
    result.fields=names.map(name=>field(name,schema.properties[name],required.includes(name)));
    result.supported=true;result.actions=['accept','decline','cancel'];
  }catch(error){result.reason=error.message;result.fields=[];}
  return result;
}
export function validateElicitationResult(params,result){
  if(!keys(result,['action','content','_meta'])||!['accept','decline','cancel'].includes(result.action))reject('MCP 表单响应必须包含合法 action');
  // This UI does not provide extension-specific metadata. Never echo untrusted
  // request _meta as response metadata or fabricate a specialized action.
  if(result._meta!==undefined&&result._meta!==null)reject('当前表单不支持额外客户端元数据');
  if(result.action!=='accept'){
    if(result.content!==undefined&&result.content!==null)reject('拒绝或取消表单不能携带填写内容');
    return {action:result.action,content:null,_meta:null};
  }
  const description=describeElicitation(params);
  if(!description.supported)throw Object.assign(new Error(description.reason),{status:422});
  const content=result.content;
  if(!object(content)||Object.keys(content).some(name=>!description.fields.some(field=>field.name===name)))reject('填写内容必须是仅包含已声明字段的对象');
  if(JSON.stringify(content).length>65536)reject('表单填写内容过长');
  for(const field of description.fields){
    if(!own(content,field.name)){if(field.required)reject(`请填写 ${field.title}`);continue;}
    validateField(field,content[field.name]);
  }
  return {action:'accept',content:structuredClone(content),_meta:null};
}
