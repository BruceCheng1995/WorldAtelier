/** Passive observer of actual Codex config request/response; never changes IO. */
import{appendFileSync}from'node:fs';import{CodexAgent}from'../../services/creation/codex-agent.mjs';
const original=CodexAgent.prototype._rpc;
CodexAgent.prototype._rpc=async function(method,args,options){
  const path=process.env.WORLD_ATELIER_TEST_CODEX_TRACE,observe=path&&['thread/start','turn/start','thread/resume'].includes(method);
  if(observe)appendFileSync(path,JSON.stringify({at:Date.now(),direction:'request',method,args})+'\n');
  try{const result=await original.call(this,method,args,options);if(observe)appendFileSync(path,JSON.stringify({at:Date.now(),direction:'response',method,thread_id:result.thread?.id,turn_id:result.turn?.id,turn_status:result.turn?.status})+'\n');return result;}
  catch(error){if(observe)appendFileSync(path,JSON.stringify({at:Date.now(),direction:'error',method,error:{code:error.code,message:error.message}})+'\n');throw error;}
};
