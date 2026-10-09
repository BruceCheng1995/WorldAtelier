// Transport projection only. Full event bytes remain in the durable event log.
export const COMPACT_EVENT_LIMIT=64*1024;
export const TOOL_EVENT_PATHS=['$.result.contentItems','$.result.content','$.result.structuredContent','$.params.item.contentItems','$.params.item.result','$.params.item.output','$.params.item.aggregatedOutput','$.params.item.arguments','$.params.item.changes'];
export const TOOL_EVENT_SQL="((json_extract(body,'$.kind')='serverRequestReply' AND json_extract(body,'$.method')='item/tool/call') OR (json_extract(body,'$.kind')='notification' AND json_extract(body,'$.params.item.type') IN ('dynamicToolCall','mcpToolCall','commandExecution','fileChange')))";
export function compactSessionEvent(event){
  const item=event.params?.item;
  if(!(event.kind==='serverRequestReply'&&event.method==='item/tool/call'||event.kind==='notification'&&['dynamicToolCall','mcpToolCall','commandExecution','fileChange'].includes(item?.type)))return event;
  if(JSON.stringify(event).length<=COMPACT_EVENT_LIMIT)return event;
  const result={...event,details_available:true};
  if(event.result){result.result={...event.result};for(const field of ['contentItems','content','structuredContent'])delete result.result[field];}
  if(item){result.params={...event.params,item:{...item}};for(const field of ['contentItems','result','output','aggregatedOutput','arguments','changes'])delete result.params.item[field];}
  return result;
}
