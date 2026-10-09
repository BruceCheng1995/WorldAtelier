import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {readFileSync,realpathSync} from 'node:fs';
import {writeWorkspaceFile} from './environments.mjs';
import {agentTextContext} from './agent-text-context.mjs';

// Bound the encoded wire result, including JSON escaping, rather than JS length.
export const MAX_AGENT_TOOL_RESULT_BYTES=256*1024;
const wrap=text=>({success:true,contentItems:[{type:'inputText',text}]});
const smallFields=value=>Object.fromEntries(Object.entries(value??{}).filter(([,v])=>v===null||['string','number','boolean'].includes(typeof v)&&String(v).length<=4096));
export function encodeAgentToolResult({cwd,value}){
  value=agentTextContext(value);
  const text=JSON.stringify(value),result=wrap(text);
  if(Buffer.byteLength(JSON.stringify(result))<=MAX_AGENT_TOOL_RESULT_BYTES)return result;
  const sha256=createHash('sha256').update(text).digest('hex'),file=`outputs/tool-results/${sha256}.json`;
  writeWorkspaceFile(cwd,file,text);
  const summary=smallFields(value);
  for(const key of ['resource','source','branch','environment'])if(value?.[key])summary[key]=smallFields(value[key]);
  // A large collection of small fields must not defeat the transport budget.
  const boundedSummary=Buffer.byteLength(JSON.stringify(summary))<32*1024?summary:{};
  return wrap(JSON.stringify({projection:'tool-result-file',result_file:resolve(cwd,file),sha256,bytes:Buffer.byteLength(text),summary:boundedSummary,
    usage:'工具已成功执行，完整结果保存在本会话文件中；请用 Python/JS 按需要读取字段或分页，避免 cat 整份大文件。修改已执行时不要因结果改为文件而重复提交。'}));
}

/** Old overflow receipts retain the original effect but not a bypass around
 * current text projections. Only open verified, session-owned result artifacts. */
export function replayAgentToolResult({cwd,value}){
  if(value?.projection!=='tool-result-file')return encodeAgentToolResult({cwd,value});
  try{
    if(!/^[a-f0-9]{64}$/.test(value.sha256??''))throw Error('invalid_result_identity');
    const local=resolve(cwd,'outputs/tool-results',value.sha256+'.json'),expected=resolve(realpathSync(cwd),'outputs/tool-results',value.sha256+'.json');
    if(![local,expected].includes(resolve(value.result_file))||realpathSync(value.result_file)!==expected)throw Error('invalid_result_path');
    const bytes=readFileSync(expected);
    if(bytes.length!==value.bytes||createHash('sha256').update(bytes).digest('hex')!==value.sha256)throw Error('result_integrity_mismatch');
    return encodeAgentToolResult({cwd,value:JSON.parse(bytes.toString('utf8'))});
  }catch{
    return encodeAgentToolResult({cwd,value:{projection:'tool-result-unavailable',summary:value.summary??{},
      usage:'原工具已成功执行，历史结果文件现已缺失或无法核实。请读取当前源稿确认结果，不要重复提交此前修改。'}});
  }
}
