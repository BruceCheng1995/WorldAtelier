import {createImagePreviews,imageElement,editScreenshot} from './image-attachments.js';
import {ViewportNavigation} from './viewport-navigation.js';
import {ViewportAnnotations,copyAnnotationText} from './viewport-annotations.js';
import {annotationInput,portableAnnotations,parsePortableAnnotations} from '../../packages/contracts/viewport-annotations.mjs';
import {referenceChip,referenceToken,referenceIds,expandReferenceText,renderReferenceContent,createReferenceEditor,createReferenceInteractions} from './reference-components.js';
import { randomUUID, bindDialogDismiss, positionFloatingPanel, sha256Hex } from './client-platform.js';
import { AutoGameCover } from './auto-game-cover.js';
import {mountAssetMarket} from './asset-market.js';
import { GameCatalog, catalogRoute, catalogHref, suggestBranchId } from './game-catalog.js';
import { GodotPreview, PlayControls, PrefabDragPlacement, PrefabThumbnails, prefabThumbnailKey } from './preview-bridge.js';
import { GamePlay, prepareGamePlay } from './game-play.js';
import {mountPrefabLab} from './prefab-lab.js';
import { CreationClient, SceneRevisionCache, WorldModeSequence, validWorldInput, validSessionPacket, previewPeers, userColor, withDevelopmentMetadata, aggregateDevelopment, LocalSelectionOrder, DEFAULT_DISPLAY, displayKey, normalizeDisplay, readDisplay } from './collaboration-client.js';
import { HierarchyPrefabPanel } from './hierarchy-prefabs.js';
import { fullAddressKey, lookupResolvedRow, captureTransformTarget, buildWorldTransformCommit, withWorldPosition, localTransformFromEuler } from './hierarchy-editor.js';
import { InboxWorkspace, issueSummary } from './inbox.js';
import { ClientDiagnostics } from './client-diagnostics.js';
import { createSemanticComposer, unresolvedComposerReferences } from './semantic-composer.js';
import { nativeOperation,nativePatchOperations,nativeTransformFields,nativeWorldTransformOperation,nativeDeleteOperation,nativeEditTarget,nativeInstantiateOperation,nativeCreateResourceOperation,nativeMatchesEvent,nativePreviewRows } from './native-authoring.js';
import {nativeControlOperation,nativeControlStorage,measureLegacyControl,nativeControlObservation} from './native-authoring.js';
import {renderControlLayoutInspector,updateControlLayoutInputs} from './control-layout-inspector.js';
let controlObservation=null;
import {NativeGodotPreview} from './native-preview.js';
import { createSemanticInspector, createParameterControl, createInspectorName } from './semantic-inspector.js';
import { nextSemanticSelection, semanticMutationBody, semanticAttachmentLabel, semanticAttachmentSummary, leadingSemanticMode } from './semantic-workspace-context.js';
import { matrix, multiply, inverse, transformPoint } from '../../packages/scene/transform.mjs';

// BEGIN CHAT PRESENTATION — kept in this entry for existing static servers.
// Presentation only. Executor events remain the source of execution state.
export const escapeChat = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function inlineMarkdown(source, depth = 0) {
  if (depth > 8) return escapeChat(source);
  const pattern = /(`+)([\s\S]*?)\1|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*/g;
  let html = '', cursor = 0;
  for (const match of source.matchAll(pattern)) {
    html += escapeChat(source.slice(cursor, match.index));
    if (match[1]) html += `<code>${escapeChat(match[2])}</code>`;
    else if (match[3]) {
      const href = match[4], safe = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href) && !/[\x00-\x20\\]/.test(href);
      html += safe ? `<a href="${escapeChat(href)}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(match[3], depth + 1)}</a>` : escapeChat(match[3]);
    } else if (match[5] || match[6]) html += `<strong>${inlineMarkdown(match[5] || match[6], depth + 1)}</strong>`;
    else if (match[7]) html += `<del>${escapeChat(match[7])}</del>`;
    else html += `<em>${inlineMarkdown(match[8], depth + 1)}</em>`;
    cursor = match.index + match[0].length;
  }
  return html + escapeChat(source.slice(cursor));
}

export function renderMarkdown(value, depth = 0) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n');
  if (depth > 8) return `<p>${escapeChat(source)}</p>`;
  const lines = source.split('\n'), result = [];
  const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  const listPattern = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/;
  const boundary = line => /^(?:\s*$|\s*```|\s*~~~|#{1,6}\s|>\s?|\s*[-+*]\s|\s*\d+[.)]\s|\s*(?:---+|___+|\*\*\*+)\s*$)/.test(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      result.push(`<div class="chat-code"><div class="chat-code-head"><span>${escapeChat(fence[2] || '代码')}</span><button type="button" data-copy-code aria-label="复制代码">复制代码</button></div><pre><code>${escapeChat(code.join('\n'))}</code></pre></div>`); continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) { const level = Math.min(heading[1].length + 1, 6); result.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); i++; continue; }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { result.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) { const quote = []; while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, '')); result.push(`<blockquote>${renderMarkdown(quote.join('\n'), depth + 1)}</blockquote>`); continue; }
    if (line.includes('|') && lines[i + 1]?.includes('-') && cells(lines[i + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) {
      const headers = cells(line), rows = []; i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      result.push(`<div class="chat-table" tabindex="0" role="region" aria-label="回复中的表格"><table><thead><tr>${headers.map(h => `<th>${inlineMarkdown(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, j) => `<td>${inlineMarkdown(row[j] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const list = listPattern.exec(line);
    if (list) {
      const ordered = /^\d/.test(list[2]), indent = list[1].length, tag = ordered ? 'ol' : 'ul', items = [];
      while (i < lines.length) {
        const item = listPattern.exec(lines[i]);
        if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
        const content = [item[3]]; i++;
        while (i < lines.length && lines[i].trim() && /^\s+/.test(lines[i]) && lines[i].match(/^\s*/)[0].length > indent) content.push(lines[i++].slice(indent + 2));
        const task = /^\[([ xX])\]\s+(.*)/.exec(content[0]);
        if (task) content[0] = task[2];
        items.push(`<li${task ? ' class="chat-task"' : ''}>${task ? `<input type="checkbox" disabled aria-label="${task[1] === ' ' ? '未完成' : '已完成'}" ${task[1] !== ' ' ? 'checked' : ''}>` : ''}${renderMarkdown(content.join('\n'), depth + 1)}</li>`);
      }
      result.push(`<${tag}${ordered ? ` start="${parseInt(list[2], 10)}"` : ''}>${items.join('')}</${tag}>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && !boundary(lines[i]) && !(lines[i].includes('|') && /^\s*\|?\s*:?-{3}/.test(lines[i + 1] || ''))) paragraph.push(lines[i++]);
    result.push(`<p>${paragraph.map(l => inlineMarkdown(l)).join('<br>')}</p>`);
  }
  return result.join('');
}

const toolNames = {commandExecution:'运行命令',fileChange:'修改文件',mcpToolCall:'调用工具',dynamicToolCall:'世界工具',webSearch:'搜索网页',imageView:'查看图片',imageGeneration:'生成图片',collabAgentToolCall:'协作任务'};
export function collectToolCalls(events) {
  const calls = new Map();
  for (const event of events) {
    const p = event.params ?? {}, item = p.item;
    if (event.kind !== 'notification') continue;
    const key = `${p.turnId ?? ''}:${item?.id ?? p.itemId ?? ''}`;
    if (item && toolNames[item.type] && ['item/started','item/completed'].includes(event.method)) {
      const old = calls.get(key);
      if (old?.done && event.method === 'item/started') continue;
      calls.set(key, {...old, ...item, key, turnId:p.turnId, threadId:p.threadId, at:event.at, detailsCursor:event.details_available?event.cursor:undefined, done:event.method === 'item/completed', streamedOutput:old?.streamedOutput ?? ''});
    } else if (event.method === 'item/commandExecution/outputDelta' && calls.has(key)) {
      const call = calls.get(key); call.streamedOutput = (call.streamedOutput + (p.delta ?? '')).slice(-24000);
    }
  }
  return [...calls.values()];
}
export function renderToolCalls(calls, key = 'tools') {
  if (!calls.length) return '';
  const active = calls.filter(c => !c.done).length;
  const failures = calls.filter(c => c.status === 'failed' || c.error || (typeof c.exitCode === 'number' && c.exitCode !== 0)).length;
  return `<details class="tool-group" data-disclosure="${escapeChat(key)}"><summary><span>${active ? '正在执行' : '执行过程'}</span><span class="tool-count">${calls.length} 个工具调用${active ? ` · ${active} 项进行中` : ''}${failures ? ` · ${failures} 项失败` : ''}</span></summary><div class="tool-list">${calls.map(call => {
    const failed = call.status === 'failed' || call.error || (typeof call.exitCode === 'number' && call.exitCode !== 0);
    const title = call.type === 'commandExecution' ? call.command : call.tool || call.name || call.changes?.map(c => c.path).join(', ') || call.query || toolNames[call.type];
    const output = call.error || call.aggregatedOutput || call.output || call.result || call.streamedOutput;
    const detail = output ? typeof output === 'string' ? output : JSON.stringify(output, null, 2) : JSON.stringify(call.arguments ?? call.changes ?? {}, null, 2);
    return `<details class="tool-call ${failed ? 'tool-failed' : ''}" data-disclosure="tool:${escapeChat(call.key)}"><summary><span class="tool-kind">${toolNames[call.type]}</span><span class="tool-title">${escapeChat(title)}</span><span class="tool-state">${failed ? '失败' : call.done ? '完成' : '进行中'}</span></summary><div class="tool-detail"><code>${escapeChat(title)}</code>${call.exitCode != null ? `<small>退出码 ${escapeChat(call.exitCode)}</small>` : ''}<pre>${escapeChat(detail)}</pre>${call.detailsCursor?`<button type="button" data-event-detail="${call.detailsCursor}">下载完整工具记录</button>`:''}</div></details>`;
  }).join('')}</div></details>`;
}

export function reasoningOptions(model) {
  return (model?.supportedReasoningEfforts ?? []).map(item => typeof item === 'string' ? {value:item,description:''} : {value:item.reasoningEffort,description:item.description ?? ''}).filter(item => typeof item.value === 'string');
}
export const effortLabel = value => ({none:'无',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高',ultra:'超高'}[value] ?? value);
// END CHAT PRESENTATION

// BEGIN WORKSPACE TOPBAR
export function agentColor(session){return userColor({id:session?.owner_user_id});}
export function sessionActivityAt(session){
  const times=[session?.created_at,session?.updated_at,session?.last_activity_at];
  for(const run of session?.runs??[])times.push(run.created_at,run.completed_at,run.cancel_requested_at);
  for(const message of session?.messages??[])times.push(message.created_at);
  return Math.max(0,...times.filter(value=>Number.isFinite(value)));
}
export function compareSessionActivity(a,b){return sessionActivityAt(b)-sessionActivityAt(a)||String(a.id).localeCompare(String(b.id));}
export function agentListStatus(state){
  if(state?.needsReply||state?.label==='等待会话所有者回复')return {key:'attention',label:'等待交互',detail:state.label};
  if(state?.key==='working')return {key:'working',label:state.runStatus==='starting'?'启动中':'运行中',detail:state.label};
  const labels={'本轮执行结束':'已结束','执行结束':'已结束','目标已完成':'已完成','尚未开始':'未开始','状态待刷新':'待刷新','正在停止后台命令':'停止中','正在停止':'停止中','停止结果待核对':'待核对','结果待核对':'待核对','状态待核对':'待核对','等待输入 · 请求待核对':'待核对'};
  return {key:state?.key??'unknown',label:labels[state?.label]??state?.label??'待刷新',detail:state?.label??'状态待刷新'};
}
export function groupAgentAvatars(rows){
  const groups=new Map();
  for(const row of rows){
    if(!row.state.active&&row.state.motion!=='settled')continue;
    const key=row.session.owner_user_id??row.session.id,group=groups.get(key);
    if(group)group.count++;else groups.set(key,{...row,count:1});
  }
  return [...groups.values()];
}
export function collaboratorUsers(peers){return [...new Map(peers.filter(p=>p.user_id??p.id).map(p=>[p.user_id??p.id,{...p,user_id:p.user_id??p.id}])).values()];}
export function agentState(session,pending=[],fresh=true){
  if(!fresh||!session)return {key:'unknown',label:'状态待刷新',active:false};
  const runs=[...(session.runs??[])].sort((a,b)=>b.created_at-a.created_at),run=runs[0];
  const cleanup=runs.find(r=>(r.cancel_requested_at||r.cleanup_status||['interrupted','cancelling'].includes(r.status))&&r.cleanup_status!=='verified');
  if(cleanup)return {key:'attention',label:cleanup.cleanup_status==='pending'?'正在停止后台命令':'停止结果待核对',active:true};
  if(!run)return {key:'idle',label:'尚未开始',active:false};
  if(['starting','running'].includes(run.status)&&pending.some(e=>e.params?.turnId===run.turn_id&&e.params?.threadId===run.thread_id))return {key:'attention',label:'等待你的回复',active:true};
  if(run.execution_mode==='goal'&&run.executor_goal){const status=run.executor_goal.status;if(status==='active')return {key:'working',label:'目标持续执行中',active:true};if(status==='complete')return {key:'ended',label:'目标已完成',active:false};if(['blocked','paused','budget_limited','usage_limited'].includes(status))return {key:'attention',label:({blocked:'目标遇到阻碍',paused:'目标已暂停',budget_limited:'目标达到预算限制',usage_limited:'目标等待额度恢复'})[status],active:false};}
  const states={starting:['working','正在启动',true],running:['working','正在执行',true],waiting_input:['attention','等待回复',true],cancelling:['attention','正在停止',true],uncertain:['attention','结果待核对',true],completed:['ended','执行结束',false],failed:['failed','执行失败',false],interrupted:['idle','已中断',false],cancelled:['idle','已取消',false]};
  const [key,label,active]=states[run.status]??['unknown','状态待核对',false];return {key,label,active};
}
// Avatar cues describe observed execution, never acceptance or permission grants.
export function agentAvatarSignal(session,pending=[],fresh=true,viewerId){
  const state=agentState(session,pending,fresh),runs=[...(session?.runs??[])].sort((a,b)=>b.created_at-a.created_at),run=runs[0];
  const cleanup=runs.some(r=>(r.cancel_requested_at||r.cleanup_status||['interrupted','cancelling'].includes(r.status))&&r.cleanup_status!=='verified');
  const request=fresh&&!cleanup&&run?.thread_id&&run?.turn_id&&['starting','running','waiting_input'].includes(run.status)&&pending.find(e=>e.kind==='approval_request'&&['item/tool/requestUserInput','item/commandExecution/requestApproval','item/fileChange/requestApproval','execCommandApproval','applyPatchApproval','mcpServer/elicitation/request'].includes(e.method)&&e.params?.threadId===run.thread_id&&e.params?.turnId===run.turn_id);
  const needsReply=Boolean(viewerId&&request&&session.owner_user_id===viewerId);
  const motion=needsReply?'reply':state.key==='working'?'working':state.key==='attention'?'paused':state.key==='failed'?'error':'idle';
  const label=request?(needsReply?(request.method.includes('Approval')?'需要你授权':'需要你回复'):'等待会话所有者回复'):state.key==='ended'?(run?.execution_mode==='goal'?state.label:'本轮执行结束'):!cleanup&&state.key==='attention'&&['starting','running','waiting_input'].includes(run?.status)?'等待输入 · 请求待核对':state.label;
  return {...state,label,motion,needsReply,runId:run?.id??null,runStatus:run?.status??null};
}
export class AgentAvatarActivity {
  constructor(){this.scope=null;this.seen=new Map();}
  update(scope,rows,now=Date.now()){
    if(scope!==this.scope){this.scope=scope;this.seen.clear();}
    const ids=new Set(rows.map(r=>r.session.id));for(const id of this.seen.keys())if(!ids.has(id))this.seen.delete(id);
    return rows.map(row=>{
      const {session,state}=row,previous=this.seen.get(session.id);
      if(state.key==='unknown'){this.seen.delete(session.id);return row;}
      let until=previous?.runId===state.runId?previous.until:0;
      if(previous?.runId&&previous.runId===state.runId&&['starting','running','waiting_input'].includes(previous.runStatus)&&state.key==='ended')until=now+1800;
      if(state.key!=='ended')until=0;
      this.seen.set(session.id,{runId:state.runId,runStatus:state.runStatus,until});
      return {...row,state:{...state,motion:until>now?'settled':state.motion,settleUntil:until>now?until:0}};
    });
  }
}
export function updateAgentRequests(pending,events){
  for(const e of events){
    if(e.kind==='approval_request')pending.set(e.request_key,e);
    if(e.kind==='serverRequestReply')pending.delete(e.requestKey);
    if(e.kind==='requests_reconciled')for(const key of pending.keys())if(!e.request_keys.includes(key))pending.delete(key);
    if(e.kind==='notification'&&e.method==='serverRequest/resolved'){const key=`${e.epoch}:${String(e.params?.requestId)}`;if(pending.get(key)?.params?.threadId===e.params?.threadId)pending.delete(key);}
    if(e.kind==='notification'&&['thread/closed','thread/deleted'].includes(e.method))for(const[k,r]of pending)if(r.params?.threadId===e.params?.threadId)pending.delete(k);
    if(e.kind==='run_state'&&['completed','interrupted','failed'].includes(e.run?.status))for(const[k,r]of pending)if(r.params?.threadId===e.run.thread_id&&r.params?.turnId===e.run.turn_id)pending.delete(k);
  }return pending;
}
// A separate read-only cache: polling never selects a chat or writes its draft.
export class AgentRoster {
  constructor({request,onChange=()=>{}}){this.request=request;this.onChange=onChange;this.generation=0;this.entries=new Map();this.scope=null;this.loading=false;this.error=false;}
  reset(scope=null){this.controller?.abort();this.generation++;this.scope=scope;this.entries.clear();this.pending=null;this.loading=false;this.error=false;this.onChange();}
  async refresh(){
    if(!this.scope||this.pending)return this.pending;
    const scope=this.scope,generation=this.generation,controller=this.controller=new AbortController(),current=()=>generation===this.generation&&!controller.signal.aborted;
    this.loading=true;this.onChange();
    const job=(async()=>{
      try{
        const result=await this.request(`projects/${encodeURIComponent(scope.project_id)}/branches/${encodeURIComponent(scope.branch_id)}/sessions`,{signal:controller.signal});
        if(!current())return;
        const visible=result.sessions.filter(s=>s.project_id===scope.project_id&&s.branch_id===scope.branch_id&&(s.owner_user_id===scope.user_id||s.visibility==='shared'));
        const ids=new Set(visible.map(s=>s.id));for(const id of this.entries.keys())if(!ids.has(id))this.entries.delete(id);
        const queue=[...visible];
        await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{
          while(queue.length&&current()){
            const summary=queue.shift(),prior=this.entries.get(summary.id),entry={session:summary,fresh:false,cursor:prior?.cursor??0,requests:new Map(prior?.requests??[])};
            this.entries.set(summary.id,entry);
            try{
              const data=await this.request(`sessions/${encodeURIComponent(summary.id)}`,{signal:controller.signal});
              if(!current())return;
              if(data.id!==summary.id||data.project_id!==scope.project_id||data.branch_id!==scope.branch_id||(data.owner_user_id!==scope.user_id&&data.visibility!=='shared')){this.entries.delete(summary.id);continue;}
              entry.session={id:data.id,title:data.title,created_at:data.created_at,updated_at:data.updated_at,last_activity_at:Math.max(sessionActivityAt(data),sessionActivityAt(prior?.session)),project_id:data.project_id,branch_id:data.branch_id,owner_user_id:data.owner_user_id,visibility:data.visibility,runs:[...(data.runs??[])]};
              entry.fresh=true;
              if(agentState(data).active){
                // Catch up paginated request events; never label a partial history as current.
                for(let page=0;page<4;page++){
                  const {events}=await this.request(`sessions/${encodeURIComponent(summary.id)}/events?view=compact&after=${entry.cursor}`,{signal:controller.signal});
                  if(!current())return;updateAgentRequests(entry.requests,events);entry.session.last_activity_at=Math.max(sessionActivityAt(entry.session),...events.map(e=>Number.isFinite(e.at)?e.at:0));entry.cursor=Math.max(entry.cursor,...events.map(e=>e.cursor??0));
                  for(const event of events)if(event.kind==='run_state'&&event.run?.session_id===data.id){const at=entry.session.runs.findIndex(r=>r.id===event.run.id);if(at<0)entry.session.runs.push(event.run);else entry.session.runs[at]=event.run;}
                  entry.fresh=events.length<500;if(entry.fresh)break;
                }
              }else entry.requests.clear();
            }catch(error){if(!current())return;if([401,403,404].includes(error.status))this.entries.delete(summary.id);else entry.fresh=false;}
          }
        }));
        if(current())this.error=false;
      }catch(error){if(current()){this.error=true;this.entries.clear();}}
      finally{if(current()){this.loading=false;this.pending=null;this.onChange();}}
    })();
    this.pending=job;return job;
  }
}
// END WORKSPACE TOPBAR

// BEGIN SESSION START UX
export function firstMessageTitle(text){const value=String(text??'').replace(/\s+/g,' ').trim();const chars=Array.from(value);return chars.length>36?chars.slice(0,36).join('')+'…':value||'新会话';}
export function reconcileSessionTitle(snapshot,confirmed){return snapshot&&confirmed&&(snapshot.updated_at??0)<=confirmed.updated_at?{...snapshot,title:confirmed.title}:snapshot;}
export function reusableNewSession(session,scope,draft=session?.draft){return Boolean(session&&scope&&session.title==='新会话'&&session.visibility==='shared'&&session.owner_user_id===scope.user_id&&session.project_id===scope.project_id&&session.branch_id===scope.branch_id&&!session.executor_thread_id&&!(session.messages??[]).length&&!(session.runs??[]).length&&!String(session.draft??'').trim()&&!String(draft??'').trim()&&!(session.draft_attachments??[]).length);}
export class SessionStartGate {
  constructor(){this.pending=new Map();this.uncertain=new Set();}
  run(key,operation){
    if(this.pending.has(key))return this.pending.get(key);
    if(this.uncertain.has(key))return Promise.reject(Object.assign(new Error('上次新建的回执尚未确认，请先在会话列表选择并核对，未重复创建。'),{uncertain:true}));
    const job=Promise.resolve().then(operation).catch(error=>{if(error.uncertain)this.uncertain.add(key);throw error;}).finally(()=>{if(this.pending.get(key)===job)this.pending.delete(key);});this.pending.set(key,job);return job;
  }
  acknowledge(key){this.uncertain.delete(key);}
}
// END SESSION START UX

// BEGIN ANNOTATION PRESENTATION
export function annotationCoordinateSummary(a){
  const label=a.space==='prefab_definition'?'定义空间':a.dimension==='2d'?'场景画布':a.observation?'所见世界':'场景世界';
  const position=a.world_position??a.position;
  return `${label} · ${Array.isArray(position)?position.map(n=>Number(n).toFixed(2)).join(', ')+(a.dimension==='2d'?' px':' m'):'坐标未记录'}`;
}
export function fixedAnnotationCamera(view,context){
  if(!view||['documentId','seq','mode','revision'].some(k=>view[k]!==context[k]))return null;
  return structuredClone(view.camera);
}
export function annotationDetails(a){
  const escape=escapeChat,missing='未记录',vec=v=>Array.isArray(v)?v.map(n=>Number(n).toFixed(3)).join(' / '):missing;
  const address=v=>v?[...(v.instance_path??[]),v.definition_node_id].filter(Boolean).join(' / '):'资源原点';
  const local=a.source_pose?.local_transform??a.local_transform,source=a.source_pose?.world_position;
  const rows=[['来源',a.observation?'个人检查 · 所见快照':'编辑 · 源稿快照'],['分支',a.branch_id],['资源',`${a.resource_name??a.resource_id} · ${a.resource_kind==='prefab'?'预制件定义':a.resource_kind==='scene'?'场景':a.resource_kind??missing}`],
    ['资源 ID',a.resource_id],['对象',a.address?address(a.address):a.object_id],['坐标空间',a.space==='prefab_definition'?'预制件定义空间（独立原点）':a.space==='scene_world'?'场景世界空间':a.space??missing],
    ['坐标约定',a.basis==='right_handed_y_up'?'右手系 · Y 向上 · 单位：米':a.basis??missing],
    [a.observation?'所见世界位置':a.space==='prefab_definition'?'定义空间位置':'世界位置',vec(a.world_position??a.position)+' m'],
    ...(a.observation?[['源稿世界位置',source?vec(source)+' m':missing]]:[]),
    ['源稿局部位置',local?vec(local.position)+' m':missing],['局部旋转',local?vec(local.rotation)+'（四元数 X / Y / Z / W）':missing],['局部缩放',vec(local?.scale)],
    ['父级',a.context_version?address(a.parent_address):missing],['父级版本',a.parent_version??(a.context_version?'资源原点':missing)],
    ['祖先链',a.ancestor_chain?.length?a.ancestor_chain.map(p=>address(p.address)).join(' → '):a.context_version?'无父节点':missing],
    ['预制件实例',a.prefab_instances?.length?a.prefab_instances.map(p=>`${p.instance_path.join(' / ')} → ${p.prefab_id} @ ${p.prefab_revision}`).join('\n'):a.prefab_reference?JSON.stringify(a.prefab_reference):a.context_version?'无':missing],
    ['源版本',a.source_revision??a.revision],['资源版本',a.resource_version],['对象版本',a.object_version],
    ['观察相机',a.camera?`位置 ${vec(a.camera.position)} m\n目标 ${vec(a.camera.target)} m\n${a.camera.projection==='orthographic'?'正交投影':a.camera.projection==='perspective'?'透视投影':'投影未记录'} · 客户端观察`:missing],
    ...(a.observation?[['世界',a.observation.world_id],['世界代次 / 序号',`${a.observation.epoch} / ${a.observation.sequence}`],['检查快照',a.observation.inspection_id],['状态哈希',a.observation.state_hash]]:[]),
    ['记录时间',Number.isFinite(a.captured_at)?new Date(a.captured_at).toLocaleString('zh-CN'):missing]];
  return `<p>已固定当时的对象、版本与坐标。后续编辑不会改变这份批注。${a.observation?'所见姿态与源稿布局分别保留。':''}</p><dl class="attachment-detail">${rows.map(([label,value])=>`<dt>${escape(label)}</dt><dd>${escape(value??missing)}</dd>`).join('')}</dl><details><summary>查看完整快照（含父级矩阵与版本）</summary><pre>${escape(JSON.stringify(a,null,2))}</pre></details>`;
}
// END ANNOTATION PRESENTATION

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=v=>structuredClone(v), uuid=()=>randomUUID(), short=v=>String(v??'').slice(0,15);
const icon=n=>`<svg class="icon" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const vector=(v,n=0)=>Array.isArray(v)?v.map(Number):[v??n,v??n,v??n];
const trs=o=>({position:vector(o.position),rotation:vector(o.rotation),scale:vector(o.scale,1)});
const fmt=n=>Number(n).toFixed(2);
const api=new CreationClient();
// An already-running older backend may not serve this optional module until
// its next controlled restart. Keep the existing editing session usable then.
const releaseBuilds=await import('./release-builds.js').then(({ReleaseBuilds})=>new ReleaseBuilds({request:(route,options)=>api.api(route,options),download:route=>api.download(route)})).catch(error=>{console.warn('导出模块暂不可用，服务更新后刷新工作台即可。',error);return null;});
window.addEventListener('pagehide',()=>releaseBuilds?.dispose());
let canCreateGame=false;
let user=null,projects=[],archivedProjects=[],project=null,branch=null,resourceId=null,selectedId=null,openResources=[];
let prefabReturnTarget=null;
let prefabLab=null,prefabLabSubject=null;
let referenceEditor=null,referenceInteractions=null;
let viewportAnnotations=null;
let semanticComposer=null,semanticInspector=null,semanticInspectorRoot=null,semanticInspectorGeneration=0,semanticComposerPending=false,semanticPreparingDraft=false;
let prefabPlacement=null;
let semanticSelection={key:null,ids:[],primary:null,anchor:null};
const semanticModes=new Map(),semanticDetails=new Map(),inspectorSectionState=new Map();
let explorerTab='scene',inspectorTab='object',mode='edit',modePending=false,world=null,worldScene=null,worldState=null;
let editorTool='select',editorSnap=false,drag=null,localEdit=null,localCommitPending=false,localCommit=null,cameraIntentSerial=0,peers=[],branchPeers=[],previews=new Map(),development=[];
let sessions=[],selectedSessionId=null,sessionData=null,sessionFilter='mine',attachTarget=null,annotationView=null;
let sessionFeatures=false,accessFeatures=false,aiPropertyActionsAvailable=false;
const questionDrafts=new Map(),questionWrites=new Set();
const sessionRecoveries=new Map(),sessionRecoveryErrors=new Map();
let questionHTMLKey=null;
let agentStatus=null,sessionEvents=[],sessionCursor=0,sessionLoadGeneration=0,branchLoadGeneration=0,sceneGeneration=0;
let mainPreview=null,editorPreview=null,objectPreview=null,mainDocument=null,objectDocument=null,sceneCache=null;
let viewportDisplay={...DEFAULT_DISPLAY};
function applyViewportDisplay(){
  viewportAnnotations?.setProcessing(viewportDisplay.show_agents?development:[]);
  $('#showPeerSelections').checked=viewportDisplay.show_selections;$('#showPeerCameras').checked=viewportDisplay.show_cameras;
  $('#showAgentOutlines').checked=viewportDisplay.show_agents;
  $('#outlineWidth').value=viewportDisplay.width;$('#outlineWidthValue').textContent=`${viewportDisplay.width} px`;
  $('#outlineOpacity').value=Math.round(viewportDisplay.opacity*100);$('#outlineOpacityValue').textContent=`${Math.round(viewportDisplay.opacity*100)}%`;
  for(const preview of [mainPreview,editorPreview,objectPreview])preview?.display?.(viewportDisplay);
}
let inbox=null,assetIssues=[],issuesGeneration=0,issuesTimer=null;
let collaborationAccess=null,permissionRefreshGeneration=0;
const diagnostics=new ClientDiagnostics({request:(...args)=>api.api(...args)});
let playControls=null,sessionRefreshTimer=null;
const pendingTurnSubmissions=new Map();
let hierarchyEnabled=false,hierarchyPanel=null,hierarchyPanelKey=null;
const resolvedDocuments=new Map();
let toastTimer,modalFocus,chatFocus,saveDraftTimer,draftWrite=Promise.resolve(),lastPresence=0,presenceTimer=null,presenceCamera=null,selectionIntent=0;
const selectionOrderTracker=new LocalSelectionOrder();
const draftCache=new Map(),pendingEdits=new Map(),histories=new Map(),sessionSelection=new Map();
const chatDisclosures=new Map(),settingsWrites=new Map(),attachmentWrites=new Map();
const sessionStartGate=new SessionStartGate(),sessionSendJobs=new Map(),sessionTitleWrites=new Map(),sessionTitleConfirmations=new Map();
let conversationRenderedSession=null,conversationHTML='';
const doc=()=>branch?.manifest.resources[resourceId];
const key=()=>branch?`${project.id}/${branch.branch_id}/${resourceId}`:null;
const branchKey=()=>branch?`${project.id}/${branch.branch_id}`:null;
const canWrite=()=>['owner','editor'].includes(project?.role);
const editable=()=>!viewportAnnotations?.active&&canWrite()&&mode==='edit'&&!modePending&&!prefabLabSubject&&(!isHierarchy()||hierarchyEnabled);
const ownSession=s=>s?.owner_user_id===user?.id;
const isHierarchy=()=>branch?.manifest.schema==='creation-hierarchy-2';
const isNative=()=>branch?.manifest.schema==='creation-native-1';
const resolvedKey=(rid=resourceId,head=branch?.head)=>`${key()?.split('/').slice(0,2).join('/')}/${rid}/${head}`;
const resolvedDocument=(rid=resourceId)=>resolvedDocuments.get(resolvedKey(rid));
const docObjects=(rid=resourceId)=>isHierarchy()||isNative()?resolvedDocument(rid)?.objects??[]:branch?.manifest.resources[rid]?.objects??[];
const objectAddress=o=>o?.address??(o?{project_id:project.id,branch_id:branch.branch_id,resource_id:resourceId,instance_path:[],definition_node_id:o.id}:null);
async function loadHierarchyDocument(rid=resourceId){
  if(!isHierarchy()&&!isNative())return;
  const p=project.id,b=branch.branch_id,head=branch.head,cacheKey=resolvedKey(rid,head);
  if(resolvedDocuments.has(cacheKey))return resolvedDocuments.get(cacheKey);
  const result=await api.api(`${branchRoute(p,b)}/resolved-scene?resource_id=${encodeURIComponent(rid)}&revision=${encodeURIComponent(head)}`);
  if(result.revision!==head)throw new Error('层级读取版本不匹配');
  resolvedDocuments.set(cacheKey,result);while(resolvedDocuments.size>12)resolvedDocuments.delete(resolvedDocuments.keys().next().value);
  return result;
}
const object=()=>{
  if(mode==='inspect'){const metadata=frozenScene?.objects.find(o=>o.id===selectedId),observation=worldState?.inspection_objects?.find(o=>o.id===selectedId);return metadata&&observation?{...metadata,...observation}:null;}
  return (mode==='edit'?docObjects():displayedPlayScene()?.objects??[])?.find(o=>o.id===selectedId)||null;
};
const branchRoute=(p=project.id,b=branch.branch_id)=>`projects/${encodeURIComponent(p)}/branches/${encodeURIComponent(b)}`;
const imagePreviews=createImagePreviews(api);
function hydrateImageAttachments(){imagePreviews.hydrate(document,`${api.token??''}/${selectedSessionId??''}`);}
const sessionRoute=(id=selectedSessionId)=>`sessions/${encodeURIComponent(id)}`;
const agentRoster=new AgentRoster({request:(route,options)=>api.api(route,options),onChange:()=>renderTopbarAgents()});
let topbarScope=null,topbarMenu=null,topbarTrigger=null,rosterRefreshTimer=null;
const avatarActivity=new AgentAvatarActivity();let avatarSettleTimer=null;let avatarSignals=new Map();
const robotAvatar=(session,count=1)=>`<span class="agent-avatar" style="--agent-color:${agentColor(session)}" data-agent-avatar="${esc(session?.id??'')}" data-agent-owner="${esc(session?.owner_user_id??'')}" data-agent-count="${count}" aria-hidden="true">${icon('robot')}<i class="agent-dot"></i>${count>1?`<b class="agent-count">${count}</b>`:''}</span>`;
function paintAgentAvatars(){
  const header=$('#sessionAgentAvatar');header.dataset.agentAvatar=selectedSessionId??'';
  const selected=sessionData?.id===selectedSessionId?sessionData:agentRoster.entries.get(selectedSessionId)?.session??sessions.find(s=>s.id===selectedSessionId);
  header.dataset.agentOwner=selected?.owner_user_id??'';
  if(!header.querySelector('svg'))header.innerHTML=icon('robot')+'<i class="agent-dot"></i>';
  for(const node of document.querySelectorAll('[data-agent-avatar]')){
    const id=node.dataset.agentAvatar,state=avatarSignals.get(id)??{key:'unknown',motion:'idle',label:'状态待刷新'};
    node.className='agent-avatar';node.style.setProperty('--agent-color',userColor({id:node.dataset.agentOwner}));node.dataset.motion=state.motion;node.title=state.label;
    const dot=node.querySelector('.agent-dot');dot.className='agent-dot '+state.key;dot.textContent=state.needsReply?'?':state.key==='failed'?'!':state.motion==='paused'?'−':'';
  }
  $('#toggleSessions').setAttribute('aria-description',avatarSignals.get(selectedSessionId)?.label??'选择一条会话');
}
function clearTopbar(){branchPeers=[];topbarScope=null;closeTopbarMenu(false);agentRoster.reset();renderTopbar();}
function applyAccountUser(updated){
  if(!updated?.id||!user)return;
  if(updated.id===user.id)user={...user,...updated,color:userColor(updated)};
  for(const p of projects)for(const member of p.members)if(member.id===updated.id)member.name=updated.name;
  if(project)for(const member of project.members)if(member.id===updated.id)member.name=updated.name;
  for(const peer of [...peers,...branchPeers])if(peer.id===updated.id)peer.name=updated.name;
  renderTopbar();if(branch&&inspectorTab==='collaboration')renderInspector();
}
function syncTopbarScope(){
  const next=branch&&user?`${user.id}/${branchKey()}/${branchLoadGeneration}`:null;
  if(next!==topbarScope){topbarScope=next;agentRoster.reset(next?{user_id:user.id,project_id:project.id,branch_id:branch.branch_id}:null);if(next)agentRoster.refresh();}
}
function renderTopbar(){
  if(!user)$('#adminEntry').hidden=true;
  collaborationAccess?.setContext({user,project,connected:api.ready});
  releaseBuilds?.setContext(user&&project&&branch?{user_id:user.id,project_id:project.id,project_name:project.name,branch_id:branch.branch_id,branch_name:branch.name,source_revision:branch.head,schema:branch.manifest?.schema,entry_scene_id:branch.manifest?.entry_scene_id,role:project.role,resources:Object.values(branch.manifest?.resources??{}).map(({id,name,kind})=>({id,name,kind}))}:null);
  const editing=!!branch;for(const id of ['workspaceTools','interfaceMenuButton','branchMenuButton','collaboratorsButton','topbarProject'])$('#'+id).hidden=!editing;
  $('.topbar-brand').hidden=false;
  $('#topbarProject').textContent=project?.name??'';$('#topbarProject').title=project?`返回 ${project.name} 的分支页`:'';$('#topbarProject').href=catalogHref({projectId:project?.id});
  $('#topbarBranch').textContent=branch?.branch_id??'';$('#topbarSource').textContent=branch?short(branch.head):'';
  $('#accountMenuButton').setAttribute('aria-label',user?`账号：${user.name}`:'账号：未登录');$('#accountAvatar').style.setProperty('--user-color',userColor(user));$('#accountMenuButton').title=user?`${user.name} · 你的代表色 ${userColor(user)}`:'账号';
  $('#renameAccount').hidden=!user;$('#accountName').textContent=user?.name??'未登录';$('#accountAvatar').textContent=user?.name.slice(0,1)??'·';
  if(editing){
    $('#topbarBranches').innerHTML=project.branches.map(b=>`<button type="button" data-topbar-branch="${esc(b.branch_id)}" aria-current="${b.branch_id===branch.branch_id?'true':'false'}">${icon('branch')}<span>${esc(b.branch_id)}<small>${esc(b.name)}</small></span>${b.branch_id===branch.branch_id?icon('check'):''}</button>`).join('');
    $('#topbarBranches').querySelectorAll('button').forEach(button=>button.onclick=()=>{const id=button.dataset.topbarBranch;closeTopbarMenu(false);if(id!==branch?.branch_id)enterBranch(id).catch(report);});
    filterTopbarBranches();
    for(const action of ['newBranch','merge']){
      const button=$(`[data-topbar-action="${action}"]`);button.disabled=!canWrite()||(action==='merge'&&project.branches.length<2);
      button.title=!canWrite()?'需要编辑权限':action==='merge'&&project.branches.length<2?'创建另一个分支后可以比较与合并':'';
    }
  }
  renderTopbarAgents();
}
function filterTopbarBranches(){
  const query=$('#topbarBranchSearch')?.value.trim().toLocaleLowerCase()??'',list=$('#topbarBranches');
  list.querySelector('.branch-menu-empty')?.remove();let visible=0;
  for(const row of list.querySelectorAll('[data-topbar-branch]')){row.hidden=!row.textContent.toLocaleLowerCase().includes(query);if(!row.hidden)visible++;}
  if(!visible)list.insertAdjacentHTML('beforeend','<p class="branch-menu-empty">没有找到匹配的分支</p>');
}
function renderTopbarAgents(){
  if(!$('#agentRosterList'))return;
  const connected=$('#connectionStatus').dataset.state==='connected',entries=new Map(agentRoster.entries);
  if(topbarScope&&sessionData?.id===selectedSessionId&&sessionData.project_id===project?.id&&sessionData.branch_id===branch?.branch_id){
    const prior=entries.get(sessionData.id),requests=new Map(prior?.requests??[]);
    updateAgentRequests(requests,sessionEvents.filter(e=>!e.cursor||e.cursor>(prior?.cursor??0)));
    const currentSession=prior?.cursor>sessionCursor?{...sessionData,runs:prior.session.runs}:sessionData;
    entries.set(sessionData.id,{session:{...currentSession,last_activity_at:Math.max(sessionActivityAt(currentSession),sessionActivityAt(prior?.session),...sessionEvents.map(e=>Number.isFinite(e.at)?e.at:0))},requests,fresh:prior?.fresh??true});
  }
  const rows=avatarActivity.update(topbarScope,[...entries.values()].map(entry=>({...entry,session:reconcileSessionTitle(entry.session,sessionTitleConfirmations.get(entry.session.id)),state:agentAvatarSignal(entry.session,[...entry.requests.values()],entry.fresh&&connected,user?.id)})));
  avatarSignals=new Map(rows.map(row=>[row.session.id,row.state]));clearTimeout(avatarSettleTimer);
  const expiry=Math.min(...rows.map(row=>row.state.settleUntil||Infinity));if(Number.isFinite(expiry))avatarSettleTimer=setTimeout(renderTopbarAgents,Math.max(0,expiry-Date.now())+20);
  rows.sort((a,b)=>compareSessionActivity(a.session,b.session));
  const avatarRows=[...rows].sort((a,b)=>Number(b.state.needsReply)-Number(a.state.needsReply)||Number(b.state.active)-Number(a.state.active)||compareSessionActivity(a.session,b.session));
  const active=rows.filter(row=>row.state.active),people=collaboratorUsers(branchPeers),q=$('#agentSearch').value.trim().toLowerCase();
  const human=p=>`<span class="collaborator-human" style="--user-color:${userColor(p)}" title="${esc(p.name??'协作者')}">${esc((p.name??'?').slice(0,1))}</span>`;
  const stack=[...groupAgentAvatars(avatarRows).map(({session,state,count})=>({html:robotAvatar(session,count),title:`${project?.members.find(m=>m.id===session.owner_user_id)?.name??'协作者'} · ${count} 个 Agent · ${session.title} · ${state.label}`})),...people.map(p=>({html:human(p),title:p.name??'协作者'}))];
  const stackHTML=stack.slice(0,5).map(p=>`<span title="${esc(p.title)}">${p.html}</span>`).join('')+(stack.length>5?`<span class="collaborator-overflow">+${stack.length-5}</span>`:'')||`<span class="collaborator-empty">${icon('robot')}</span>`;
  if($('#collaboratorAvatars').dataset.renderKey!==stackHTML){$('#collaboratorAvatars').innerHTML=stackHTML;$('#collaboratorAvatars').dataset.renderKey=stackHTML;}
  const replies=rows.filter(row=>row.state.needsReply).length;
  $('#collaboratorsButton').setAttribute('aria-label',`查看协作者：${people.length} 人在线，${active.length} 个 Agent 进行中${replies?`，${replies} 个需要你回复`:''}`);
  $('#activeAgentCount').hidden=!active.length;$('#activeAgentCount').textContent=active.length;
  $('#rosterScope').textContent=branch?`${project.name} / ${branch.branch_id}`:'';
  $('#rosterSummary').textContent=agentRoster.loading?'正在刷新…':agentRoster.error?'暂时无法读取':`${rows.length} 个 · ${active.length} 个进行中`;
  $('#refreshAgents').disabled=agentRoster.loading;
  $('#topbarPeople').innerHTML=`<span>此分支在线协作者 · ${people.length}</span><div>${people.map(p=>`<span class="topbar-person">${human(p)}<small>${esc(p.name??'协作者')}${p.user_id===user?.id?'（你）':''}</small></span>`).join('')||'<small>暂无在线协作者</small>'}</div>`;
  const list=$('#agentRosterList'),visible=rows.filter(({session})=>session.title.toLowerCase().includes(q));
  const html=visible.map(({session:s,state})=>`<button type="button" class="agent-roster-row ${s.id===selectedSessionId?'selected':''}" data-agent-session="${esc(s.id)}" aria-label="${esc(s.title)}，${esc(state.label)}" ${s.id===selectedSessionId?'aria-current="true"':''}>${agentListCard(s,state)}</button>`).join('')||`<div class="agent-empty">${agentRoster.error?'无法读取会话，请点击刷新。':q&&rows.length?'没有匹配的会话':agentRoster.loading?'正在读取真实会话…':q?'没有匹配的会话':'还没有可查看的会话。'}</div>`;
  if(list.dataset.renderKey!==html){const focus=list.contains(document.activeElement)?document.activeElement.dataset.agentSession:null,scroll=list.scrollTop;list.innerHTML=html;list.dataset.renderKey=html;list.scrollTop=scroll;
    list.querySelectorAll('button').forEach(button=>{if(button.dataset.agentSession===focus)button.focus({preventScroll:true});button.onclick=async()=>{const id=button.dataset.agentSession,scope=topbarScope;sessionStartGate.acknowledge(sessionStartKey());button.disabled=true;try{await selectSession(id);if(scope===topbarScope&&sessionData?.id===id){closeTopbarMenu(false);openChat(false);chatFocus=$('#agentsMenuButton');if(avatarSignals.get(id)?.needsReply){const request=$('#sessionQuestions .question-card input, #sessionQuestions .question-card textarea, #sessionQuestions .question-card button, #sessionConversation [data-request]');request?.scrollIntoView({block:'center',behavior:'instant'});request?.focus({preventScroll:true});}}}catch(error){report(error);}finally{if(button.isConnected)button.disabled=false;}};});
  }
  renderSessions();
  paintAgentAvatars();
  updateNewSessionControls();$('#topbarCurrentSession').disabled=!selectedSessionId;
}
function closeTopbarMenu(restore=true){if(!topbarMenu)return;$('#'+topbarMenu).hidden=true;$$('.atelier-topbar button[aria-expanded]:not(#agentsMenuButton)').forEach(b=>b.setAttribute('aria-expanded','false'));topbarMenu=null;if(restore)topbarTrigger?.focus();}
function toggleTopbarMenu(id,trigger){
  if(topbarMenu===id){closeTopbarMenu();return;}closeTopbarMenu(false);topbarMenu=id;topbarTrigger=trigger;$('#'+id).hidden=false;positionFloatingPanel($('#'+id),trigger,{align:id==='branchMenu'?'start':'end'});
  $$(`.atelier-topbar button[aria-controls="${id}"]`).forEach(b=>b.setAttribute('aria-expanded','true'));
  if(id==='agentsMenu'){agentRoster.refresh();$('#agentSearch').focus();}else if(id==='branchMenu'){$('#topbarBranchSearch').value='';filterTopbarBranches();$('#topbarBranchSearch').focus();}else $('#'+id).querySelector('button:not([hidden]):not(:disabled)')?.focus();
}
function scheduleRosterRefresh(){clearTimeout(rosterRefreshTimer);rosterRefreshTimer=setTimeout(()=>agentRoster.refresh(),350);}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),5500);}
function errorText(error){const reasons={runtime_sheared_box_unsupported:'盒碰撞体的当前世界变换包含剪切，暂不能运行。请调整父级的非均匀缩放或子级旋转，或移除此碰撞后重新验证；已保存的源稿不受影响。',runtime_sphere_transform_unsupported:'球碰撞体需要均匀缩放且不能含剪切。请统一缩放各轴或调整父级变换后重新验证；已保存的源稿不受影响。',local_trs_unrepresentable:'此世界变换无法表示为节点的局部位置、旋转和缩放。请调整父级缩放，或重挂时取消保持世界变换；本次变换未写入，原源稿保持不变。'},code=Object.keys(reasons).find(code=>error.message?.includes(code));return `${code?reasons[code]:error.message}${error.uncertain?'；请求回执不确定，请先刷新核对，未自动重试。':''}`;}
function report(error){if(error.message==='预览目标已切换')return;toast(errorText(error));$('#workspaceStatus').textContent=errorText(error);}
let modalGeneration=0;
function modal(title,html,buttons=[],options={}){
  const dialog=$('#modal'),body=$('#modalBody'),footer=$('#modalFooter'),generation=++modalGeneration;
  if(!dialog.open){
    const active=document.activeElement;
    modalFocus=active?.closest?.('.topbar-popover')?topbarTrigger:active?.closest?.('.workspace-disclosure,#chatSettings,.composer-help,.semantic-quick-actions,.prefab-card-menu')?.querySelector('summary')??active;
  }
  $('#modalTitle').textContent=title;
  dialog.dataset.size=options.size??(/screenshot-viewer|merge-columns/.test(html)?'wide':/semantic-knowledge-content|semantic-knowledge-results/.test(html)?'reading':/media-editor-grid/.test(html)?'medium':'compact');
  dialog.dataset.tone=options.tone??'neutral';
  dialog.removeAttribute('aria-busy');
  body.innerHTML=html;body.scrollTop=0;
  body.insertAdjacentHTML('beforeend','<p id="modalError" role="alert" class="error-text" tabindex="-1"></p>');
  const errorNode=$('#modalError'),isCurrent=()=>dialog.open&&generation===modalGeneration;
  footer.innerHTML=buttons.map((b,i)=>`<button type="button" class="button ${b.primary?'primary':'subtle'} ${b.danger?'danger':''}" data-modal-button="${i}">${esc(b.label)}</button>`).join('');
  let pending=false;
  buttons.forEach((b,i)=>footer.querySelector(`[data-modal-button="${i}"]`).onclick=async e=>{
    if(pending||!isCurrent())return;
    const button=e.currentTarget;
    if(b.primary&&b.validate!==false){
      const invalid=[...body.querySelectorAll('input,select,textarea')].find(control=>!control.disabled&&!control.checkValidity());
      if(invalid){
        invalid.closest('details')?.setAttribute('open','');invalid.setAttribute('aria-invalid','true');
        errorNode.textContent=invalid.dataset.validationMessage||invalid.validationMessage;invalid.focus();return;
      }
    }
    pending=true;button.disabled=true;dialog.setAttribute('aria-busy','true');errorNode.textContent='';
    button.textContent=b.busyLabel??(b.primary?'正在处理…':b.label);
    try{await b.action();}
    catch(error){if(isCurrent()){errorNode.textContent=errorText(error);errorNode.focus();}}
    finally{pending=false;if(isCurrent()){dialog.removeAttribute('aria-busy');button.disabled=false;button.textContent=b.label;}}
  });
  body.oninput=e=>{e.target.removeAttribute?.('aria-invalid');errorNode.textContent='';};
  body.onkeydown=e=>{
    if(e.key==='Enter'&&!e.isComposing&&!e.defaultPrevented&&e.target.matches('input:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=search])')){
      const submit=footer.querySelector('.primary');if(submit&&!submit.disabled){e.preventDefault();submit.click();}
    }
  };
  if(!dialog.open)dialog.showModal();
  (body.querySelector('[data-autofocus]')??$('#closeModal')).focus({preventScroll:true});
  return isCurrent;
}
function closeModal(){modalGeneration++;$('#modal').removeAttribute('aria-busy');$('#modal').close();const target=modalFocus?.isConnected&&modalFocus.getClientRects().length?modalFocus:$('#agentsMenuButton');target?.focus({preventScroll:true});}
function openChat(focus=false){if(!branch)return;if($('#chatDrawer').hidden)chatFocus=document.activeElement;$('#chatDrawer').hidden=false;closeSessionPicker();$('#openChat').setAttribute('aria-expanded','true');$('#agentsMenuButton').setAttribute('aria-expanded','true');renderSessions();renderComposer();(focus&&ownSession(sessionData)?$('#sessionDraft'):$('#closeChat')).focus();}
function closeChat(restore=true){closeSessionPicker();$('#chatDrawer').hidden=true;$('#openChat').setAttribute('aria-expanded','false');$('#agentsMenuButton').setAttribute('aria-expanded','false');if(restore)(chatFocus?.isConnected&&chatFocus.getClientRects().length?chatFocus:$('#agentsMenuButton')).focus();}

function scheduleIssues(){clearTimeout(issuesTimer);issuesTimer=setTimeout(()=>refreshIssues(),120);}
async function refreshIssues(){if(!user||!branch)return;const generation=++issuesGeneration,scope=branchKey(),head=branch.head;try{const result=await api.api(`${branchRoute(project.id,branch.branch_id)}/issues`);if(generation!==issuesGeneration||scope!==branchKey()||head!==branch.head)return;assetIssues=result.issues;renderIssueMarkers();}catch(error){if(generation===issuesGeneration&&[401,403,404].includes(error.status)){assetIssues=[];renderIssueMarkers();}}}
function issueTarget(rid=resourceId,o=null){return {project_id:project?.id,branch_id:branch?.branch_id,resource_id:rid,...(o?.address?{address:o.address}:o?{object_id:o.id}: {})};}
function issueButton(target,{inline=false}={}){const summary=issueSummary(assetIssues,target);if(!summary.count)return null;const button=document.createElement(inline?'span':'button');if(!inline)button.type='button';button.className='wa-asset-issue'+(summary.severity==='error'?' is-error':'');button.textContent=`! ${summary.count}`;button.title=button.ariaLabel=`${summary.count} 个待处理问题，点击查看`;button.dataset.issueMarker='true';button.onclick=e=>{e.preventDefault();e.stopPropagation();inbox.open({target,trigger:button});};return button;}
function renderIssueMarkers(){document.querySelectorAll('[data-issue-marker]').forEach(e=>e.remove());if(!branch)return;
  document.querySelectorAll('.catalog-card [data-resource]').forEach(el=>{const button=issueButton(issueTarget(el.dataset.resource)),card=el.closest('.catalog-card');if(button&&card)(card.querySelector('.prefab-caption')??card).append(button);});
  document.querySelectorAll('[data-select]').forEach(el=>{const o=docObjects().find(o=>o.id===el.dataset.select);if(o){const button=issueButton(issueTarget(resourceId,o),{inline:true});if(button)el.append(button);}});
  const resourceButton=issueButton(issueTarget());if(resourceButton){resourceButton.textContent+=' · 当前资源问题';$('#inspectorBody').prepend(resourceButton);}
  const o=object(),objectButton=o&&issueButton(issueTarget(resourceId,o));if(objectButton){objectButton.textContent+=' · 当前对象问题';$('#inspectorBody').prepend(objectButton);}
}
async function inboxAction({item,action:actionRecord,isCurrent}){
  const action=actionRecord.id;
  const owner=user?.id,guard=()=>{if(user?.id!==owner||!isCurrent())throw new Error('消息上下文已经切换');};guard();
  if(action==='collaboration'){inbox.close();await collaborationAccess.open({projectId:item.project_id,tab:item.access_request_id?'requests':'members',requestId:item.access_request_id});return;}
  if(item.project_id){
    let targetProject=projects.find(p=>p.id===item.project_id);
    if(!targetProject){const data=await api.api('bootstrap');guard();projects=data.projects.map(p=>({...p,members:p.members.map(m=>({...m,color:userColor(m)}))}));targetProject=projects.find(p=>p.id===item.project_id);}
    if(!targetProject)throw new Error('项目已经不可访问');
    if(project?.id!==item.project_id||branch?.branch_id!==item.branch_id){project=targetProject;await enterBranch(item.branch_id);guard();}
    if(project?.id!==item.project_id||branch?.branch_id!==item.branch_id)throw new Error('工作台已切换');
  }
  if(action==='locate'){
    const target=item.targets?.[0]??{resource_id:item.resource_id};if(!target.resource_id||!branch?.manifest.resources[target.resource_id])throw new Error('原资源已不存在，可查看历史消息');
    if(resourceId!==target.resource_id){await openResource(target.resource_id);guard();}if(project?.id!==item.project_id||branch?.branch_id!==item.branch_id||resourceId!==target.resource_id)throw new Error('定位范围已经变化');
    const o=target.address?docObjects().find(o=>o.address&&fullAddressKey(o.address)===fullAddressKey(target.address)):docObjects().find(o=>o.id===target.object_id);
    if((target.address||target.object_id)&&!o)throw new Error('原对象已变化，已定位资源，请查看历史记录');inbox.close();if(o)selectObject(o.id);showInspectorPanel();return;
  }
  if(action==='session'||action==='decision'){
    if(!item.session_id)throw new Error('此消息没有可访问的会话');await selectSession(item.session_id);guard();if(selectedSessionId!==item.session_id)throw new Error('会话已切换');
    if(action==='session'){inbox.close();openChat(false);return;}
    const result=await api.api(`sessions/${encodeURIComponent(item.session_id)}/requests`);guard();
    const request=result.requests?.find(r=>r.request_key===item.request_key);if(!request){inbox.invalidate();throw new Error('请求已结束，消息正在刷新');}
    inbox.close();openChat(false);showRequest(request);return;
  }
  if(action==='build'){guard();inbox.close();releaseBuilds?.open('history',$('#inboxButton'));return;}
}

function creationAccess(data){if(Array.isArray(data.archived_projects))archivedProjects=data.archived_projects;canCreateGame=data.can_create_project!==false;document.querySelectorAll('[data-action="newGame"]').forEach(button=>{button.disabled=!canCreateGame;button.title=canCreateGame?'创建游戏':'只读试玩账号：可在游戏的协作面板申请编辑';});}
async function bootstrap(){
  const data=await api.api('bootstrap');creationAccess(data);user={...data.user,color:userColor(data.user)};viewportDisplay=readDisplay(localStorage,user.id);applyViewportDisplay();projects=data.projects.map(p=>({...p,members:p.members.map(m=>({...m,color:userColor(m)}))}));
  $('#adminEntry').hidden=data.can_admin!==true;
  inbox?.setContext({user_id:user.id});diagnostics.setUser(user.id);$('#inboxButton').hidden=false;
  const health=await api.api('health');automaticCoversAvailable=health.automatic_covers===true;manualCoversAvailable=health.manual_covers===true;projectManagementAvailable=health.project_management===true;aiPropertyActionsAvailable=health.ai_property_actions===1;hierarchyEnabled=health.hierarchy_editing===true;sessionFeatures=health.chat_settings===true;accessFeatures=health.chat_access===true;
  $('#authView').hidden=true;$('#landing').hidden=false;$('#accountName').textContent=user.name;$('#accountAvatar').textContent=user.name.slice(0,1);$('#logout').hidden=false;
  project=projects.find(p=>p.id===catalogRoute().projectId)||null;
  renderBranches();renderTopbar();api.closed=false;api.connect();await applyCatalogRoute();
  try{agentStatus=await api.api('agent/status');renderAgentStatus();}catch(error){$('#agentStatus').textContent=errorText(error);}
  const invitation=new URL(location.href).searchParams.get('invite');if(invitation)joinInvite(invitation);
}
let gameCatalog,automaticCoversAvailable=false,manualCoversAvailable=false,projectManagementAvailable=false,catalogPage='games',routeError='',catalogNavigation=0;
function catalog(){return gameCatalog??=new GameCatalog({api,esc,icon,getState:()=>({user,projects,archivedProjects,project,automaticCoversAvailable,projectManagementAvailable,catalogPage,routeError}),navigate:navigateCatalog,select:id=>{++branchLoadGeneration;clearTopbar();project=projects.find(p=>p.id===id);renderBranches();},enter:enterBranch,createBranch:newBranch,refresh:refreshCatalog,modal,closeModal,toast,report});}
async function refreshCatalog(){
  const owner=user?.id,data=await api.api('bootstrap');if(owner!==user?.id)return;creationAccess(data);
  projects=data.projects.map(p=>({...p,members:p.members.map(m=>({...m,color:userColor(m)}))}));
  project=projects.find(p=>p.id===project?.id)||null;
  if(!branch){if(catalogRoute().projectId&&!project)await applyCatalogRoute();else renderBranches();}
  renderTopbar();if(project)document.title=branch?`${project.name} / ${branch.branch_id} · 世界工坊`:`${project.name} · 世界工坊`;
}
function clearPermissionSession(){
  closePrefabLab(false);
  clearTimeout(saveDraftTimer);clearTimeout(sessionRefreshTimer);
  if(selectedSessionId&&ownSession(sessionData))draftCache.set(selectedSessionId,$('#sessionDraft').value);
  ++sessionLoadGeneration;api.selectSessionBoundary();selectedSessionId=null;sessionData=null;sessionEvents=[];sessions=[];sessionCursor=0;
  agentRoster.reset();closeChat(false);renderComposer();
}
function applyProjectPermissions(value,pid){
  const previous=projects.find(p=>p.id===pid),active=project?.id===pid,wasWritable=active&&canWrite();
  const changed=previous?.role!==value?.role||previous?.permission_version!==value?.permission_version;
  if(value){const next={...previous,...value,branches:value.branches??previous?.branches??[],members:value.members.map(m=>({...m,color:userColor(m)}))};const index=projects.findIndex(p=>p.id===pid);if(index>=0)projects[index]=next;else projects.push(next);if(active)project=next;}
  else {projects=projects.filter(p=>p.id!==pid);if(active){clearPermissionSession();cancelLocalEdit();leaveWorkspaceForCatalog();project=null;applyCatalogRoute().catch(report);}}
  if(active&&value&&wasWritable&&!canWrite()){
    clearPermissionSession();cancelLocalEdit();previews.clear();pendingEdits.clear();histories.clear();
    toast('已切换为只读；未提交的聊天草稿保留在当前窗口，试玩可继续。');
  }else if(active&&value&&!wasWritable&&canWrite()){
    toast('编辑权限已开通，可以继续创作。');if(branch)loadSessions().catch(report);
  }
  if(active&&branch&&project&&changed)renderAll();else if(!branch){renderBranches();renderTopbar();}else renderTopbar();
}
async function refreshPermissions(){
  if(!user)return;const uid=user.id,generation=++permissionRefreshGeneration,pid=project?.id,data=await api.api('bootstrap');
  if(uid!==user?.id||generation!==permissionRefreshGeneration)return;
  applyAccountUser(data.user);
  creationAccess(data);if(pid===project?.id&&pid)applyProjectPermissions(data.projects.find(p=>p.id===pid)??null,pid);
  projects=data.projects.map(p=>({...p,members:p.members.map(m=>({...m,color:userColor(m)}))}));if(project)project=projects.find(p=>p.id===project.id)??null;
  renderBranches();renderTopbar();await collaborationAccess?.refresh();
}
function writeCatalogRoute(target,{replace=false}={}){
  const hash=catalogHref(target);if(location.hash===hash)return;
  window.history[replace?'replaceState':'pushState'](null,'',location.pathname+location.search+hash);
}
async function navigateCatalog(target,options={}){
  if(viewportAnnotations?.active){await viewportAnnotations.finish();if(viewportAnnotations.active)return;}
  writeCatalogRoute(target,options);await applyCatalogRoute(options);
}
async function applyCatalogRoute({focus=false}={}){
  if(viewportAnnotations?.active){await viewportAnnotations.finish();if(viewportAnnotations.active){writeCatalogRoute({projectId:project?.id,branchId:branch?.branch_id},{replace:true});return;}}
  const generation=++catalogNavigation;if(!user)return;$('#landing').removeAttribute('aria-busy');
  const route=catalogRoute();++branchLoadGeneration;if(project?.id!==route.projectId)$('#branchSearch').value='';
  if($('#modal').open)closeModal();
  if(branch||!$('#workbench').hidden)leaveWorkspaceForCatalog();
  routeError='';catalogPage=route.kind==='games'?'games':'game';
  project=route.projectId?projects.find(p=>p.id===route.projectId)??null:null;
  const fail=message=>{catalogPage='error';routeError=message;$('#workbench').hidden=true;$('#landing').hidden=false;document.body.classList.remove('is-editing');renderBranches();document.title='页面不可用 · 世界工坊';};
  if(route.kind==='invalid'){fail('这个地址无法识别，请返回游戏库选择游戏。');return;}
  if(route.projectId&&!project){fail(archivedProjects.some(p=>p.id===route.projectId)?'这个工程已归档。请返回游戏库，在「已归档」中恢复后继续创作。':'游戏不存在，或当前账号没有访问权限。可以返回游戏库，或切换账号后重试。');return;}
  if(route.kind==='branch'&&!project.branches.some(b=>b.branch_id===route.branchId)){fail('这个分支不存在，或当前账号没有访问权限。');return;}
  $('#landing').hidden=false;$('#workbench').hidden=true;renderBranches();renderTopbar();
  document.title=project?`${project.name} · 世界工坊`:'游戏库 · 世界工坊';
  if(route.kind==='games'&&!location.hash)writeCatalogRoute({}, {replace:true});
  if(route.kind==='branch'){
    $('#landing').setAttribute('aria-busy','true');
    try{await enterBranch(route.branchId,{syncRoute:false});if(generation!==catalogNavigation)return;document.title=`${project.name} / ${route.branchId} · 世界工坊`;}
    catch(error){if(generation!==catalogNavigation)return;leaveWorkspaceForCatalog();fail(errorText(error));}
    finally{if(generation===catalogNavigation)$('#landing').removeAttribute('aria-busy');}
  }else{
    $('#landing').removeAttribute('aria-busy');window.scrollTo({top:0,behavior:'instant'});
    if(focus&&project)$('#selectedGameTitle').focus({preventScroll:true});
  }
}
window.addEventListener('hashchange',()=>applyCatalogRoute().catch(report));
$('#retryCatalogRoute').onclick=async()=>{try{await refreshCatalog();await applyCatalogRoute();}catch(error){report(error);}};

function renderBranches(){catalog().render();}
let manualCoverBusy=false;
function manualCoverState(){
  if(!user||!branch||!project||!canWrite()||doc()?.kind!=='scene'||prefabLabSubject||doc()?.purpose==='prefab_test'||$('#workbench').hidden)return null;
  const preview=mainPreview,context=preview?.sceneContext,scene=mode==='edit'?doc():viewedScene(),sceneId=scene?.resource_id??scene?.id??resourceId,sceneKind=scene?.kind??branch.manifest.resources[sceneId]?.kind;
  const ready=!!(manualCoversAvailable&&context&&preview.ready&&!preview.pending&&!preview.disposed&&preview.loadedSeq===preview.seq&&!preview.status.textContent&&!modePending&&!worldLoadPending&&!localEdit&&!drag&&!localCommitPending&&document.visibilityState==='visible'&&context.document_id===viewedDocumentKey()&&sceneKind==='scene'&&scene?.purpose!=='prefab_test'&&(mode!=='edit'||context.source_revision===branch.head)&&(preview.sceneGeneration===undefined||preview.boundSceneGeneration===preview.sceneGeneration));
  return {user_id:user.id,project_id:project.id,branch_id:branch.branch_id,resource_id:sceneId,source_revision:context?.source_revision,document_id:context?.document_id,mode,runtime_build_id:preview?.runtimeBuildId,scene_generation:preview?.sceneGeneration,preview,seq:preview?.seq,local_generation:sceneGeneration,ready};
}
function sameManualCover(a,b){return a&&b&&['user_id','project_id','branch_id','resource_id','source_revision','document_id','mode','runtime_build_id','scene_generation','preview','seq','local_generation'].every(k=>a[k]===b[k]);}
function renderCaptureButton(){const state=manualCoverState(),button=$('#captureGameCover');button.hidden=!state;button.disabled=manualCoverBusy||!state?.ready;button.title=!manualCoversAvailable?'拍摄功能等待服务更新':manualCoverBusy?'正在拍摄…':state?.ready?'拍摄当前游戏画面并设为封面':'等待当前游戏画面就绪';}
async function captureGameCover(){
  const state=manualCoverState(),navigation=catalogNavigation;if(!state?.ready||manualCoverBusy)return;
  manualCoverBusy=true;renderCaptureButton();
  try{
    const image=await state.preview.captureFrame(),current=manualCoverState();
    if(!sameManualCover(state,current)||!current.ready||navigation!==catalogNavigation||image.document_id!==state.document_id||image.source_revision!==state.source_revision)throw Error('拍摄期间画面已切换，请重新拍摄');
    const editorId=randomUUID(),active=()=>$('#modal').open&&$('#manualCoverPreview')?.dataset.editor===editorId&&user?.id===state.user_id&&project?.id===state.project_id&&branch?.branch_id===state.branch_id;
    let busy=false;
    modal('拍摄封面',`<div class="manual-cover-preview" id="manualCoverPreview" data-editor="${editorId}"><img alt="刚刚拍摄的游戏画面"></div><p>已拍下当前画面。选择封面位置后保存，对应封面将停止自动更新。</p><label class="project-name-field">设为<select id="manualCoverScope"><option value="both">游戏与当前分支封面</option><option value="project">仅游戏封面</option><option value="branch">仅当前分支封面</option></select></label>`,[{label:'取消',action:closeModal},{label:'重新拍摄',action:()=>{closeModal();return captureGameCover();}},{label:'保存封面',primary:true,action:async()=>{
      if(busy||!active())return;busy=true;
      try{
        // The preview is a fixed photo. Gameplay may continue while choosing it;
        // navigation or permission loss still invalidates its destination.
        if(!canWrite()||navigation!==catalogNavigation)throw Error('工程或权限已变化，请重新拍摄');
        const p=projects.find(p=>p.id===state.project_id),b=p?.branches.find(b=>b.branch_id===state.branch_id),scope=$('#manualCoverScope').value;
        const result=await api.api(`${branchRoute(state.project_id,state.branch_id)}/manual-cover`,{method:'POST',body:{scope,expected_version:b?.presentation?.version??0,expected_project_version:p?.presentation?.version??0,source_revision:state.source_revision,resource_id:state.resource_id,mode:state.mode,runtime_build_id:state.runtime_build_id,...(state.scene_generation!==undefined?{scene_generation:state.scene_generation}:{}),image:{data_url:image.data_url,name:'手动拍摄 · '+new Date().toLocaleString('zh-CN')}}});
        if(user?.id!==state.user_id)return;
        applyCoverResult(state,result);
        if(active()){closeModal();toast('封面已保存，自动更新已关闭');}renderBranches();
      }catch(error){if(user?.id!==state.user_id)return;try{await refreshCatalog();}catch{}if(active())$('#modalError').textContent=errorText(error);}
      finally{busy=false;}
    }}]);
    $('#manualCoverPreview img').src=image.data_url;
  }catch(error){if(user?.id===state.user_id&&navigation===catalogNavigation)toast(errorText(error));}
  finally{manualCoverBusy=false;renderCaptureButton();}
}
$('#captureGameCover').onclick=captureGameCover;
function applyCoverResult(state,result){
  if(user?.id!==state.user_id)return;
  const p=projects.find(p=>p.id===state.project_id),b=p?.branches.find(b=>b.branch_id===state.branch_id);
  const accept=(target,next)=>{if(target&&next&&(target.presentation?.version??0)<=next.version)target.presentation=next;};
  accept(p,result.project_presentation);accept(b,result.presentation);
  if(branch&&branchKey()===`${state.project_id}/${state.branch_id}`)accept(branch,result.presentation);
}
function autoCoverState(){
  if(!user||!branch||!project||doc()?.kind!=='scene'||prefabLabSubject||doc()?.purpose==='prefab_test')return null;
  const media=project.branches.find(b=>b.branch_id===branch.branch_id)?.presentation??branch.presentation;
  const ready=!manualCoverBusy&&automaticCoversAvailable&&canWrite()&&!$('#modal').open&&document.visibilityState==='visible'&&!$('#workbench').hidden&&mode!=='inspect'&&!modePending&&!worldLoadPending&&!localEdit&&!drag&&!localCommitPending&&mainPreview?.ready&&!mainPreview.pending&&mainPreview.loadedSeq===mainPreview.seq&&!mainPreview.status.textContent&&mainPreview.sceneContext?.document_id===key()&&mainPreview.sceneContext?.source_revision===branch.head&&(mode!=='play'||worldState?.scene_revision===branch.head);
  return {user_id:user.id,project_id:project.id,branch_id:branch.branch_id,resource_id:resourceId,source_revision:branch.head,mode,presentation:media,project_presentation:project.presentation,ready,wait_reason:!automaticCoversAvailable?'封面 · 自动截图服务准备中':!canWrite()?'封面 · 仅编辑者更新':mode==='inspect'?'封面 · 检查期间暂停':mode==='play'&&worldState?.scene_revision!==branch.head?'封面 · 等待新版游戏画面':'封面 · 等待当前游戏画面'};
}
const autoGameCover=new AutoGameCover({getState:autoCoverState,capture:()=>mainPreview.captureFrame(),refresh:refreshCatalog,onStatus:status=>{renderCaptureButton();const button=$('#autoCoverStatus');button.hidden=!!status.hidden;button.textContent=status.text??'';button.title=status.error??'修改后等待 10 秒，随后每 60 秒更新；点击管理分支封面。';},save:async(state,image)=>{
  const result=await api.api(`${branchRoute(state.project_id,state.branch_id)}/auto-cover`,{method:'POST',body:{expected_version:state.presentation?.version??0,expected_project_version:state.project_presentation?.version??0,source_revision:state.source_revision,resource_id:state.resource_id,mode:state.mode,runtime_build_id:image.runtime_build_id,image:{data_url:image.data_url,name:image.name}}});
  if(user?.id!==state.user_id)return;
  applyCoverResult(state,result);
}});
$('#autoCoverStatus').onclick=()=>{if(canWrite()&&project&&branch)catalog().manage(project,project.branches.find(b=>b.branch_id===branch.branch_id)??branch);};
autoGameCover.start();
window.addEventListener('pagehide',()=>autoGameCover.stop(),{once:true});
function lastEditedSceneKey(){
  return user?.id&&project?.id&&branch?.branch_id
    ?'world-atelier:last-edited-scene:'+JSON.stringify([user.id,project.id,branch.branch_id]):null;
}
function restoredEditScene(){
  const storageKey=lastEditedSceneKey();
  try{
    const saved=storageKey&&localStorage.getItem(storageKey);
    if(saved&&branch.manifest.resources[saved]?.kind==='scene')return saved;
  }catch{}
  return branch.manifest.entry_scene_id;
}
function rememberEditedScene(){
  const storageKey=lastEditedSceneKey();
  if(!storageKey||branch.manifest.resources[resourceId]?.kind!=='scene')return;
  try{localStorage.setItem(storageKey,resourceId);}catch{}
}
async function enterBranch(id,{syncRoute=true}={}){
  if(viewportAnnotations?.active){await viewportAnnotations.finish();if(viewportAnnotations.active)return;}

  prefabPlacement?.cancel();
  prefabReturnTarget=null;
  if(syncRoute)return navigateCatalog({projectId:project?.id,branchId:id});
  clearPresence();
  clearTopbar();
  
  const generation=++branchLoadGeneration;flushDraft().catch(report);++sessionLoadGeneration;api.selectSessionBoundary();selectedSessionId=null;sessionData=null;sessions=[];sessionEvents=[];sessionCursor=0;leaveWorld();closeChat(false);api.unsubscribe();
  assetIssues=[];++issuesGeneration;
  branch=null;resourceId=null;selectedId=null;sceneCache=null;peers=[];branchPeers=[];development=[];localEdit=null;drag=null;previews.clear();
  $('#branchCards').setAttribute('aria-busy','true');$('#workspaceStatus').textContent='正在读取中央文档…';
  try{
    const result=await api.api(branchRoute(project.id,id));if(generation!==branchLoadGeneration)return;
    branch=result;resourceId=restoredEditScene();openResources=[resourceId];await loadHierarchyDocument();if(generation!==branchLoadGeneration)return;rememberEditedScene();selectedId=docObjects().find(o=>o.kind!=='group')?.id??docObjects()[0]?.id??null;
    selectedSessionId=sessionSelection.get(branchKey())??null;sessionData=null;sessionEvents=[];sessionCursor=0;mode='edit';
    document.body.classList.add('is-editing');$('#landing').hidden=true;$('#workbench').hidden=false;
    api.subscribe({project_id:project.id,branch_id:branch.branch_id,resource_id:resourceId,known_head:branch.head});
    syncTopbarScope();renderAll();scheduleIssues();await loadSessions();if(generation!==branchLoadGeneration)return;catalog().recordVisit(project.id,branch.branch_id);document.title=`${project.name} / ${branch.branch_id} · 世界工坊`;$('#branchMenuButton').focus();
  }finally{$('#branchCards').removeAttribute('aria-busy');}
}
async function openResource(id){
  if(viewportAnnotations?.active){await viewportAnnotations.finish();if(viewportAnnotations.active)return;}

  closePrefabLab(false);
  prefabPlacement?.cancel();
  if(!branch.manifest.resources[id])return;cancelLocalEdit();leaveWorld();clearPresence();resourceId=id;
  if(!openResources.includes(id))openResources.push(id);explorerTab='scene';$('#contentSearch').value='';const documentKey=key();await loadHierarchyDocument();if(key()!==documentKey)return;selectedId=docObjects().find(o=>o.kind!=='group')?.id??docObjects()[0]?.id??null;sceneCache=null;previews.clear();
  rememberEditedScene();api.subscribe({project_id:project.id,branch_id:branch.branch_id,resource_id:id,known_head:branch.head});renderAll();
}
function prefabLabContext(){
  return {subject:copy(branch?.manifest.resources[prefabLabSubject]),scenarios:Object.values(branch?.manifest.resources??{}).filter(resource=>resource.purpose==='prefab_test'&&resource.subject_id===prefabLabSubject).map(resource=>({...resource,description:resource.design?.description??''})),revision:branch?.head,projectId:project?.id,branchId:branch?.branch_id};
}
function closePrefabLab(render=true){
  if(!prefabLabSubject)return;
  prefabLabSubject=null;prefabLab?.close();document.body.classList.remove('prefab-lab-active');if($('#prefabLabHost'))$('#prefabLabHost').hidden=true;
  if(render&&branch)renderAll();
}
async function openPrefabLab(subjectId,scenarioId=null){
  if(viewportAnnotations?.active){await viewportAnnotations.finish();if(viewportAnnotations.active)return;}
  if(!isNative()||branch.manifest.resources[subjectId]?.kind!=='prefab')throw Error('请选择原生预制件');
  if(!['owner','editor','viewer'].includes(project.role))throw Error('能力预览需要源稿访问权限');
  if(localEdit||drag||localCommitPending)throw Error('请先完成当前编辑');
  leaveWorld();prefabPlacement?.cancel();
  prefabLabSubject=subjectId;
  let host=$('#prefabLabHost');if(!host){host=document.createElement('div');host.id='prefabLabHost';$('#stage').append(host);}
  if(!prefabLab)prefabLab=mountPrefabLab(host,{request:(path,options)=>api.api(path,options),getContext:()=>({canWrite:canWrite(),role:project?.role}),onClose:()=>closePrefabLab(),onError:error=>toast(typeof error==='string'?error:error.message),onOpenSource:({scenario})=>openResource(scenario.id).catch(report),onCreate:input=>createPrefabLabScene(input).catch(report),onRequest:input=>requestPrefabLabAgent(input).catch(report)});
  document.body.classList.add('prefab-lab-active');host.hidden=false;
  renderExplorer();renderInspector();prefabLab.open({...prefabLabContext(),scenarioId});
}
async function createPrefabLabScene({subject,text=''}){
  if(!canWrite()||!subject||subject.id!==prefabLabSubject)throw Error('预制件或编辑权限已变化');
  const ctx=prefabLabContext(),prefabs=Object.values(branch.manifest.resources).filter(resource=>resource.kind==='prefab');
  const active=modal('创建能力预览场景',`<p>场景将保存到当前分支，使用真实预制件，最终游戏包会自动排除。</p><label>场景名称<input id="prefabTestName" maxlength="160" value="${esc(subject.name+' · 能力预览')}"></label><label>交互靶子<select id="prefabTestTarget"><option value="">暂不放置</option>${prefabs.map(resource=>`<option value="${esc(resource.id)}">${esc(resource.name)}</option>`).join('')}</select></label><label>想检查的效果<textarea id="prefabTestDescription" rows="4" placeholder="例如：点击发射豌豆、显示命中伤害；让僵尸啃食并切换受损状态。">${esc(text)}</textarea></label><small>先创建基础舞台，再通过 Agent 连接技能、状态和反馈。</small>`,[{label:'取消',action:closeModal},{label:'创建场景',primary:true,action:async()=>{
    if(!canWrite()||project?.id!==ctx.projectId||branch?.branch_id!==ctx.branchId||branch?.head!==ctx.revision)throw Error('源稿或权限已变化，请重新打开创建');
    const name=$('#prefabTestName').value.trim(),description=$('#prefabTestDescription').value.trim(),target_id=$('#prefabTestTarget').value;
    const result=await api.api(`${branchRoute(ctx.projectId,ctx.branchId)}/prefab-tests`,{method:'POST',body:{request_id:uuid(),base_revision:ctx.revision,subject_id:subject.id,name,description,...(target_id?{target_id}:{})}});
    if(!active()||project?.id!==ctx.projectId||branch?.branch_id!==ctx.branchId||prefabLabSubject!==subject.id)return;closeModal();
    acceptBranch(result.branch);await openPrefabLab(subject.id,result.resource_id);
    if(description)await requestPrefabLabAgent({subject,scenario:branch.manifest.resources[result.resource_id],text:description});
  }}]);
}
async function requestPrefabLabAgent({subject,scenario,text,evidence}){
  if(!canWrite()||!subject||branch.manifest.resources[subject.id]?.kind!=='prefab')throw Error('请先取得当前分支的编辑权限');
  const scope=branchKey(),revision=branch.head,created=await newSession({forceNew:true});
  if(branchKey()!==scope||!created||selectedSessionId!==created.id)throw Error('会话已切换，未发送到其他会话');
  const captured=semanticComposerContext();
  await addSemanticReference({kind:'prefab',item:copy(branch.manifest.resources[subject.id]),revision},captured,'target');
  if(branchKey()!==scope||selectedSessionId!==created.id)return;
  const fixed=evidence?{source_revision:evidence.source_revision,build_id:evidence.build_id,canonical_identity:evidence.canonical_identity,scenario_id:evidence.scenario_id,scene_generation:evidence.scene_generation,captured_at:evidence.captured_at,observations:evidence.state?.observations,animation:evidence.state?.current,time:evidence.state?.time,events:evidence.state?.events?.slice(-12)}:null;
  const request=`请为「${subject.name}」${scenario?'完善':'创建'}可复用的能力预览测试场景。${scenario?`\n测试场景：${scenario.name}（${scenario.id}，${scenario.path}）`:''}\n需求：${text||'优先展示对象自身的动画、主动技能、可切换状态和控制器。靶子配置与外部伤害独立放入场景工具。'}\n使用真实预制件与玩法能力；将测试场景及辅助文件放在 test_scenes/，登记 purpose: prefab_test 和 subject_id。测试不进入最终游戏。按 WORLD-API.md 用 scope/kind 明确区分主体行为与外部测试工具。选中状态与动作前置条件由运行时回读；脚本和 Tween 保留原有实现，由预览框架捕获实际姿态并提供时间轴，无需逐个改写成 AnimationPlayer；外部控制器须在预览场景中真实运行，可用 atelier_preview_subject() 指定采样主体。接入真实反馈，并可增加显式自动测试计划。${fixed?'\n本次观察（固定历史版本，修改前重读当前源稿）：\n'+JSON.stringify(fixed).slice(0,16000):''}`;
  const draft=$('#sessionDraft');draft.value=(draft.value.trim()?draft.value.trim()+'\n\n':'')+request;draft.dispatchEvent(new Event('input',{bubbles:true}));openChat(true);draft.focus();
}
async function openInstanceDefinition(source,model){
  if(!branch||!project||model.project_id!==project.id||model.branch_id!==branch.branch_id||model.resource_id!==resourceId)throw new Error('原对象的文档已经切换，请重新选择');
  if(!branch.manifest.resources[source.id])throw new Error('来源预制件已经不存在');
  if(model.target.is_instance)prefabReturnTarget={projectId:project.id,branchId:branch.branch_id,resourceId,definitionId:source.id,objectId:model.target.object_id,address:copy(model.target.address),name:model.name};
  const originBranch=branchKey();await openResource(source.id);
  if(branchKey()===originBranch&&resourceId===source.id){explorerTab='scene';$('#contentSearch').value='';renderExplorer();}
}
async function returnToPrefabInstance(){
  const origin=prefabReturnTarget;
  if(!origin||project?.id!==origin.projectId||branch?.branch_id!==origin.branchId)throw new Error('原实例不在当前分支');
  if(!branch.manifest.resources[origin.resourceId])throw new Error('原实例所在场景已经删除');
  await openResource(origin.resourceId);
  if(project?.id!==origin.projectId||branch?.branch_id!==origin.branchId||resourceId!==origin.resourceId)return;
  const target=docObjects().find(o=>origin.address?o.address&&fullAddressKey(o.address)===fullAddressKey(origin.address):o.id===origin.objectId);
  if(!target)throw new Error('原实例已经删除');
  explorerTab='scene';$('#contentSearch').value='';selectObject(target.id);renderExplorer({reveal:target.id,scrollToSelection:true});
  focusExplorerRow(target.id,{focus:false});
}
async function renameSemanticInstance(name,model){
  assertSemanticModel(model);
  const target=docObjects().find(o=>model.target.address?o.address&&fullAddressKey(o.address)===fullAddressKey(model.target.address):o.id===model.target.object_id);
  if(!target||target.version!==model.target.expected_version)throw new Error('实例已变化，请重新选择');
  if(isNative())return patchObject(copy(target),{name},'实例名称',context());
  const ctx=context(),address=target.address,instance=address?.instance_path?.length===1?ctx.manifest.resources[ctx.resourceId].instances[address.instance_path[0]]:null;
  const definition=instance&&ctx.manifest.prefab_revisions[instance.prefab_revision];
  if(instance&&address.definition_node_id===definition?.root_id)return transact([{type:'patch_instance',resource_id:ctx.resourceId,instance_id:instance.instance_id,expected_version:instance.version,patch:{name}}],{ctx,label:'实例名称'});
  return patchObject(copy(target),{name},'实例名称',ctx);
}
function acceptBranch(next,{refreshInspector=true}={}){
  if(!branch||next.project_id!==project.id||next.branch_id!==branch.branch_id)return;
  if(Object.entries(branch.doc_sequences??{}).some(([rid,sequence])=>(next.doc_sequences?.[rid]??0)<sequence))return; // Reject a late HTTP ACK older than the WS baseline.
  if(!next.manifest&&(!next.manifest_unchanged||next.head!==branch.head)){api.subscribe({project_id:project.id,branch_id:branch.branch_id,resource_id:resourceId});return;}
  const previous=branch.head;if(previous!==next.head)prefabPlacement?.cancel();
  const {manifest,...metadata}=next;branch={...copy(metadata),manifest:manifest??branch.manifest};
  if(prefabLabSubject){if(!branch.manifest.resources[prefabLabSubject])closePrefabLab(false);else prefabLab?.refresh(prefabLabContext());}
  const card=project.branches.find(b=>b.branch_id===branch.branch_id);if(card)Object.assign(card,{head:branch.head,doc_sequences:branch.doc_sequences});
  openResources=openResources.filter(id=>branch.manifest.resources[id]);
  if(!doc()){resourceId=branch.manifest.entry_scene_id;rememberEditedScene();openResources=[resourceId];api.subscribe({project_id:project.id,branch_id:branch.branch_id,resource_id:resourceId,known_head:branch.head});}
  if(mode==='edit'&&!isHierarchy()&&!isNative()&&!docObjects().some(o=>o.id===selectedId))selectedId=docObjects()[0]?.id??null;
  if(previous!==branch.head){sceneCache=null;assetIssues=[];scheduleIssues();}
  if(/^(等待中央文档|正在读取中央文档|源稿就绪|3D 已就绪)/.test($('#workspaceStatus').textContent))$('#workspaceStatus').textContent=`源稿就绪 · ${short(branch.head)}`;
  renderHeader();renderExplorer();renderStage();
  if(refreshInspector&&!localEdit)renderInspector();
  if((isHierarchy()||isNative())&&!resolvedDocument()){
    const expectedKey=key(),expectedHead=branch.head;
    loadHierarchyDocument().then(()=>{if(key()!==expectedKey||branch.head!==expectedHead)return;if(mode==='edit'&&!docObjects().some(o=>o.id===selectedId))selectedId=docObjects().find(o=>o.kind!=='group')?.id??docObjects()[0]?.id??null;renderExplorer();renderStage();if(refreshInspector&&!localEdit)renderInspector();}).catch(report);
  }
}
function renderHeader(){renderTopbar();if(!branch)return;$('#branchTitle').textContent=project.name;$('#branchCode').textContent=branch.branch_id;$('#sourceBadge').textContent=short(branch.head);$('#sourceBadge').title=branch.head;$('#sessionBranch').textContent=branch.branch_id;$('#sourceStatus').textContent=!canWrite()?'只读浏览 · 点击 Play 试玩':mode==='edit'?'中央源稿':'源稿与运行世界分离';}
function renderAll(){renderHeader();renderExplorer();renderStage();renderInspector();renderSessions();renderComposer();}
function selectedSemanticObjects(){
  const scope=viewedDocumentKey(),objects=mode==='edit'?docObjects():mode==='inspect'?frozenScene?.objects??[]:displayedPlayScene()?.objects??[];
  const valid=new Set(objects.map(o=>o.id));
  if(semanticSelection.key!==scope||!selectedId||!semanticSelection.ids.includes(selectedId))semanticSelection={key:scope,ids:selectedId?[selectedId]:[],primary:selectedId,anchor:selectedId};
  semanticSelection.ids=semanticSelection.ids.filter(id=>valid.has(id));
  if(selectedId&&!valid.has(selectedId)){selectedId=semanticSelection.ids.at(-1)??null;semanticSelection.primary=selectedId;}
  return semanticSelection.ids.map(id=>objects.find(o=>o.id===id)).filter(Boolean);
}
export function orderExplorerRows(rows){
  const byKey=new Map(rows.map(row=>[row.key,row])),children=new Map(),ordered=[],seen=new Set();
  for(const row of rows){const parent=byKey.has(row.parent_key)?row.parent_key:null;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(row);}
  const visit=row=>{if(seen.has(row.key))return;seen.add(row.key);ordered.push(row);for(const child of children.get(row.key)??[])visit(child);};
  for(const row of children.get(null)??[])visit(row);
  for(const row of rows)visit(row);
  return ordered;
}
// BEGIN TREE PRESENTATION — local navigation state, never authored scene data.
export function createExplorerTreeState(){
  return {collapsed:new Set(),known:new Set(),focusId:null,scrollTop:0,query:'',searchScrollTop:0};
}
export function buildExplorerTree(rows,state,{query='',native=false,kind='scene'}={}){
  const byKey=new Map(rows.map(row=>[row.key,row])),children=new Map(),depths=new Map(),roles=new Map(),matches=new Set(),included=new Set();
  for(const row of rows){const parent=byKey.has(row.parent_key)?row.parent_key:null;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(row);}
  for(const row of rows){
    const o=row.object;if(!o)continue;
    const parent=byKey.get(row.parent_key),path=o.address?.instance_path??[],parentPath=parent?.object?.address?.instance_path??[];
    const instance=native?!!o.instance_root:!!o.prefab||path.length>0&&JSON.stringify(path)!==JSON.stringify(parentPath);
    roles.set(row.key,instance?'instance':kind==='prefab'&&!parent&&!path.length?'component':'');
    if(children.has(row.key)&&!state.known.has(row.key)){
      state.known.add(row.key);
      // Keep the scene overview open; prefab definitions and all child branches start folded.
      if(parent||kind==='prefab'||instance)state.collapsed.add(row.key);
    }
    if(query&&(o.name+' '+o.id+' '+(o.source_node_id??'')).toLowerCase().includes(query))matches.add(row.key);
  }
  for(const key of state.known)if(rows.length&&!children.has(key)){state.known.delete(key);state.collapsed.delete(key);}
  for(const key of matches){let row=byKey.get(key);const seen=new Set();while(row&&!seen.has(row.key)){seen.add(row.key);included.add(row.key);row=byKey.get(row.parent_key);}}
  const hidden=new Set(),visible=[];
  for(const row of rows){
    const parent=byKey.get(row.parent_key),depth=parent?1+(depths.get(parent.key)??0):0;depths.set(row.key,depth);
    if(parent&&(hidden.has(parent.key)||!query&&state.collapsed.has(parent.key)))hidden.add(row.key);
    if(!row.object||hidden.has(row.key)||query&&!included.has(row.key))continue;
    const siblings=(children.get(parent?.key??null)??[]).filter(r=>r.object&&(!query||included.has(r.key)));
    visible.push({...row,depth,role:roles.get(row.key),hasChildren:children.has(row.key),expanded:!!query||!state.collapsed.has(row.key),match:matches.has(row.key),position:siblings.findIndex(r=>r.key===row.key)+1,setSize:siblings.length});
  }
  return {rows,byKey,children,visible,matches,roles};
}
export function revealExplorerRow(tree,state,id){
  let row=tree.rows.find(r=>r.object?.id===id);const seen=new Set();
  while(row&&!seen.has(row.key)){seen.add(row.key);row=tree.byKey.get(row.parent_key);if(row)state.collapsed.delete(row.key);}
}
export function setExplorerExpanded(tree,state,key,expanded,recursive=false){
  const visit=[key],seen=new Set();
  while(visit.length){const current=visit.pop();if(seen.has(current))continue;seen.add(current);
    if(tree.children.has(current)){if(expanded)state.collapsed.delete(current);else state.collapsed.add(current);}
    if(recursive)visit.push(...(tree.children.get(current)??[]).map(r=>r.key));
  }
}
export function explorerTreeDestination(visible,key,direction){
  const index=visible.findIndex(row=>row.key===key),row=visible[index];if(!row)return null;
  if(direction==='Home')return visible[0]?.key;
  if(direction==='End')return visible.at(-1)?.key;
  if(direction==='ArrowUp'||direction==='ArrowDown')return visible[Math.max(0,Math.min(visible.length-1,index+(direction==='ArrowDown'?1:-1)))]?.key;
  if(direction==='ArrowLeft')return visible.find(r=>r.key===row.parent_key)?.key??key;
  if(direction==='ArrowRight')return visible[index+1]?.parent_key===key?visible[index+1].key:key;
  return key;
}
// END TREE PRESENTATION
const explorerTreeStates=new Map();
let displayedExplorerScope=null,currentExplorerTree=null;
function explorerScope(){return `${user?.id??''}/${mode==='edit'?'source':'runtime'}/${viewedDocumentKey()}/${explorerTab}`;}
function rememberExplorerView(){
  const host=$('#explorerList'),state=explorerTreeStates.get(displayedExplorerScope);if(!state)return;
  if(state.query)state.searchScrollTop=host.scrollTop;else state.scrollTop=host.scrollTop;
  if(host.contains(document.activeElement)&&document.activeElement.dataset.select)state.focusId=document.activeElement.dataset.select;
}
function focusExplorerRow(id,{focus=true}={}){
  const host=$('#explorerList'),row=[...host.querySelectorAll('[data-select]')].find(el=>el.dataset.select===id);if(!row)return;
  if(focus){host.querySelectorAll('[data-select]').forEach(el=>el.tabIndex=el===row?0:-1);row.focus({preventScroll:true});explorerTreeStates.get(displayedExplorerScope).focusId=id;}
  // Scroll only this panel; scrollIntoView can also move the viewport or page.
  const box=row.getBoundingClientRect(),panel=host.getBoundingClientRect();
  if(box.top<panel.top)host.scrollTop-=panel.top-box.top;else if(box.bottom>panel.bottom)host.scrollTop+=box.bottom-panel.bottom;
}
const prefabThumbnails=new PrefabThumbnails({cacheScope:()=>user?.id,viewerFactory:(scene,host)=>scene.document_schema==='creation-native-1'?new NativeGodotPreview(host,'object',()=>{},(path,options)=>api.api(path,options)):null,loadScene:entry=>api.api(`projects/${encodeURIComponent(entry.projectId)}/branches/${encodeURIComponent(entry.branchId)}/runtime-scene?resource_id=${encodeURIComponent(entry.resourceId)}&revision=${encodeURIComponent(entry.revision)}&thumbnail=1`)});
function renderSceneList(scenes){
  const host=$('#sceneList'),scrollTop=host.scrollTop,focused=host.contains(document.activeElement)?document.activeElement.dataset.sceneResource:null;
  $('#sceneCount').textContent=scenes.length;
  host.innerHTML=scenes.map(scene=>`<button type="button" class="scene-row" data-scene-resource="${esc(scene.id)}" ${scene.id===resourceId?'aria-current="true"':''} ${mode!=='edit'||modePending?'disabled':''} title="${esc(scene.name)}">${icon('scene')}<span class="scene-row-name">${esc(scene.name)}</span><span class="scene-row-current" aria-hidden="true">${scene.id===resourceId?'✓':''}</span></button>`).join('')||'<p class="scene-list-empty">还没有场景</p>';
  const buttons=[...host.querySelectorAll('[data-scene-resource]')];
  buttons.forEach(button=>{
    button.onclick=()=>{
      if(mode!=='edit'||modePending)return;
      $('#contentSearch').value='';explorerTab='scene';
      if(resourceId===button.dataset.sceneResource)renderExplorer();else openResource(button.dataset.sceneResource).catch(report);
    };
    button.onkeydown=e=>{
      if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
      e.preventDefault();const index=buttons.indexOf(button),next=e.key==='Home'?0:e.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,index+(e.key==='ArrowDown'?1:-1)));buttons[next]?.focus();
    };
    if(button.dataset.sceneResource===focused)button.focus({preventScroll:true});
  });
  host.scrollTop=scrollTop;
}
function renderExplorer({reveal=null,scrollToSelection=false}={}){
  ensurePrefabPlacement();
  if(!branch)return;
  const pendingTree=mode==='edit'&&(isHierarchy()||isNative())&&!resolvedDocument()&&explorerTab==='scene'&&explorerScope()===displayedExplorerScope;
  $('#explorerList').setAttribute('aria-busy',String(pendingTree));
  if(pendingTree)return; // Keep focus, scroll and selection while the next source index loads.
  const selectedObjects=new Set(selectedSemanticObjects().map(o=>o.id));semanticComposer?.refresh();
  const resources=Object.values(branch.manifest.resources),scenes=resources.filter(r=>r.kind==='scene'&&r.purpose!=='prefab_test'),q=$('#contentSearch').value.trim().toLowerCase();
  renderSceneList(scenes);
  $$('[data-explorer]').forEach(b=>b.setAttribute('aria-selected',b.dataset.explorer===explorerTab));
  $('#prefabCount').textContent=resources.filter(r=>r.kind==='prefab').length;
  $('#contentSearch').placeholder=explorerTab==='prefabs'?'搜索预制件…':'搜索当前文档中的对象…';
  const host=$('#explorerList'),hadFocus=host.contains(document.activeElement),focusResource=hadFocus?document.activeElement.dataset.resource:null;
  rememberExplorerView();const scope=explorerScope(),sameScope=scope===displayedExplorerScope;
  if(!explorerTreeStates.has(scope))explorerTreeStates.set(scope,createExplorerTreeState());
  const treeState=explorerTreeStates.get(scope),queryChanged=treeState.query!==q;treeState.query=q;displayedExplorerScope=scope;
  const restoreTop=q?(queryChanged?0:treeState.searchScrollTop):treeState.scrollTop;
  let html='',count=0,total=0;const thumbnailEntries=[];currentExplorerTree=null;
  if(explorerTab==='prefabs'){
    for(const r of resources.filter(r=>r.kind==='prefab'&&(!q||(r.name+' '+r.id).toLowerCase().includes(q)))){
      count++;
      if(r.design?.category==='system'){
        html+=`<article role="listitem" class="catalog-card semantic-system-card ${r.id===resourceId?'is-current':''}"><button type="button" class="semantic-system-open" data-resource="${esc(r.id)}" aria-label="打开游戏系统 ${esc(r.name)}"><span class="semantic-system-glyph" aria-hidden="true">◇</span><strong>${esc(r.name)}</strong><small>游戏系统</small><p>${esc(r.design.description||'通过描述与属性设计，无需可见模型。')}</p><span class="semantic-system-open-label">打开设计 →</span></button></article>`;
        continue;
      }
      const instances=isNative()?resources.reduce((n,resource)=>n+(resource.native_nodes??[]).filter(node=>node.path!=='.'&&node.scene_file_path==='res://'+r.path).length,0):isHierarchy()?resources.reduce((n,resource)=>n+Object.values(resource.instances??{}).filter(i=>i.prefab_id===r.id).length,0):resources.filter(resource=>resource.kind==='scene').flatMap(resource=>resource.objects).filter(o=>o.prefab===r.id).length;
      const thumbnailKey=prefabThumbnailKey(project.id,branch.branch_id,r,branch.head);
      thumbnailEntries.push({key:thumbnailKey,projectId:project.id,branchId:branch.branch_id,resourceId:r.id,revision:branch.head,documentId:`${project.id}/${branch.branch_id}/${r.id}`});
      html+=`<article role="listitem" data-drag-prefab="${esc(r.id)}" draggable="${editable()&&(isNative()||isHierarchy())&&r.id!==resourceId}" class="catalog-card ${r.id===resourceId?'is-current':''}"><button type="button" class="prefab-picture" data-resource="${esc(r.id)}" data-thumbnail-key="${esc(thumbnailKey)}" aria-label="打开预制件 ${esc(r.name)}" title="点击独立编辑 ${esc(r.name)} · 拖入场景创建实例"><img alt="${esc(r.name)}的预制件截图" draggable="false" hidden><span class="prefab-preview-placeholder" aria-hidden="true">${icon('component')}</span><span class="prefab-preview-status">正在读取预览…</span><span class="prefab-open-hint" aria-hidden="true">打开预制件 ${icon('arrow')}</span></button><div class="prefab-caption"><h3 title="预制件定义 · ${esc(r.name)}">${icon('component')}${esc(r.name)}</h3>${isHierarchy()||isNative()?`<details class="prefab-card-menu"><summary aria-label="${esc(r.name)}的更多操作" title="更多操作">···</summary><div class="prefab-card-actions"><button type="button" data-instance-prefab="${esc(r.id)}" ${!editable()?'disabled':''}>放入当前文档</button>${isHierarchy()?`<button type="button" data-prefab-impact="${esc(r.id)}">查看更新影响</button>`:''}<small>${instances} 个实例</small></div></details>`:''}</div></article>`;
    }
  }else{
    const objects=mode==='edit'?docObjects():viewedScene()?.objects??[],byAddress=new Map(objects.map(o=>[o.address?fullAddressKey(o.address):o.id,o]));
    const rows=orderExplorerRows(isHierarchy()?(mode==='edit'?resolvedDocument()?.rows??[]:viewedScene()?.hierarchy_pack?.objects??[]).map(row=>({...row,object:byAddress.get(fullAddressKey(row.address))})):objects.map(o=>({key:o.id,parent_key:isNative()?o.parent_id:null,object:o})));
    const options={query:q,native:isNative(),kind:mode==='edit'?doc().kind:viewedScene()?.kind??'scene'};
    let tree=buildExplorerTree(rows,treeState,options);
    if(reveal&&!q){revealExplorerRow(tree,treeState,reveal);tree=buildExplorerTree(rows,treeState,options);}
    currentExplorerTree=tree;total=rows.filter(r=>r.object).length;count=q?tree.matches.size:tree.visible.length;
    let focusId=treeState.focusId;
    if(!tree.visible.some(row=>row.object.id===focusId)){
      let ancestor=tree.rows.find(row=>row.object?.id===focusId);const seen=new Set();
      while(ancestor&&!seen.has(ancestor.key)){seen.add(ancestor.key);ancestor=tree.byKey.get(ancestor.parent_key);if(ancestor&&tree.visible.some(row=>row.key===ancestor.key)){focusId=ancestor.object.id;break;}}
      if(!tree.visible.some(row=>row.object.id===focusId))focusId=tree.visible.find(row=>selectedObjects.has(row.object.id))?.object.id??tree.visible[0]?.object.id;
    }
    treeState.focusId=focusId;
    for(const row of tree.visible){
      const o=row.object,prefabRole=row.role,glyph=prefabRole||(o.kind==='anchor'?'pin':o.kind==='group'?'group':o.kind==='light'?'light':'cube');
      const label=o.name||o.id,matchAt=q?label.toLowerCase().indexOf(q):-1,name=matchAt<0?esc(label):esc(label.slice(0,matchAt))+'<mark>'+esc(label.slice(matchAt,matchAt+q.length))+'</mark>'+esc(label.slice(matchAt+q.length));
      const childCount=tree.children.get(row.key)?.length??0;
      html+=`<button type="button" class="tree-row ${selectedObjects.has(o.id)?'active':''} ${q&&!row.match?'tree-context':''}" role="treeitem" tabindex="${o.id===focusId?0:-1}" aria-label="${esc(label)}" aria-level="${row.depth+1}" aria-posinset="${row.position}" aria-setsize="${row.setSize}" aria-selected="${selectedObjects.has(o.id)}" ${row.hasChildren?`aria-expanded="${row.expanded}"`:''} style="--tree-depth:${row.depth}" data-select="${esc(o.id)}" data-tree-node="${esc(row.key)}" data-prefab-role="${prefabRole}" title="${prefabRole==='instance'?'预制件实例 · ':prefabRole==='component'?'预制件定义 · ':''}${esc(label)} · Ctrl / ⌘ 多选 · Shift 连选"><span class="tree-chevron ${row.expanded?'is-open':''}" ${row.hasChildren?'data-tree-fold':''} aria-hidden="true" ${row.hasChildren?`title="${q?'搜索中显示匹配路径':row.expanded?'折叠':'展开'} · Alt 点击处理全部子级"`:''}>${row.hasChildren?icon('chevron'):''}</span>${icon(glyph)}<span class="tree-name">${name}</span>${row.hasChildren&&!row.expanded?`<span class="tree-child-count" aria-hidden="true" title="${childCount} 个直接子对象">${childCount}</span>`:''}</button>`;
    }
  }

  host.innerHTML=html||`<div class="tree-empty">${icon(q?'search':explorerTab==='prefabs'?'prefab':'layers')}<strong>${q?'没有匹配结果':explorerTab==='prefabs'?'还没有预制件':'场景还是空的'}</strong><small>${q?'试试其他名称或对象 ID':explorerTab==='prefabs'?'通过会话创建，可独立编辑。':'通过对话创建，或添加空间锚点。'}</small></div>`;
  host.classList.toggle('prefab-catalog',explorerTab==='prefabs');
  // A compact shelf shares the real catalog, thumbnail cache and document-opening path.
  const shelf=$('#prefabShelfList');
  if(shelf){
    $('#prefabShelf').classList.toggle('is-browsing',explorerTab==='prefabs');
    $('#browsePrefabs').textContent=explorerTab==='prefabs'?'返回结构树':'查看全部';
    $('#browsePrefabs').dataset.explorer=explorerTab==='prefabs'?'scene':'prefabs';
    shelf.hidden=explorerTab==='prefabs'||$('#togglePrefabShelf').getAttribute('aria-expanded')==='false';
    $('#togglePrefabShelf').disabled=explorerTab==='prefabs';
    shelf.innerHTML=explorerTab==='prefabs'?'':resources.filter(r=>r.kind==='prefab').slice(0,4).map(r=>{
      const thumbnailKey=prefabThumbnailKey(project.id,branch.branch_id,r,branch.head);
      if(r.design?.category!=='system')thumbnailEntries.push({key:thumbnailKey,projectId:project.id,branchId:branch.branch_id,resourceId:r.id,revision:branch.head,documentId:`${project.id}/${branch.branch_id}/${r.id}`});
      return `<article role="listitem" class="catalog-card ${r.id===resourceId?'is-current':''}" data-drag-prefab="${esc(r.id)}" draggable="${editable()&&(isNative()||isHierarchy())&&r.id!==resourceId}"><button type="button" class="prefab-picture" data-resource="${esc(r.id)}" ${r.design?.category!=='system'?`data-thumbnail-key="${esc(thumbnailKey)}"`:''} aria-label="打开预制件 ${esc(r.name)}" title="独立编辑 ${esc(r.name)}"><img alt="${esc(r.name)}" draggable="false" hidden><span class="prefab-preview-placeholder" aria-hidden="true">${icon('component')}</span><span class="prefab-preview-status">${r.design?.category==='system'?'游戏系统':'正在读取预览…'}</span></button><div class="prefab-caption"><h3 title="${esc(r.name)}">${esc(r.name)}</h3></div></article>`;
    }).join('')||'<p class="semantic-empty">还没有预制件，通过会话创建。</p>';
    shelf.querySelectorAll('[data-resource]').forEach(b=>b.onclick=()=>openResource(b.dataset.resource).catch(report));
  }
  prefabThumbnails.observe(shelf?$('.explorer'):host,thumbnailEntries);
  host.setAttribute('role',explorerTab==='scene'?'tree':'list');host.setAttribute('aria-label',explorerTab==='scene'?'当前文档对象':'全部预制件');
  if(explorerTab==='scene')host.setAttribute('aria-multiselectable','true');else host.removeAttribute('aria-multiselectable');
  $('#explorerCount').textContent=explorerTab==='prefabs'?`${count} 个预制件`:q?`${count} 项匹配 · ${total} 个对象`:`${total} 个对象 · 显示 ${count}`;
  $('#collapseTree').hidden=explorerTab!=='scene';$('#collapseTree').disabled=!!q||!currentExplorerTree?.children.size;
  $('#revealTreeSelection').hidden=explorerTab!=='scene';$('#revealTreeSelection').disabled=!selectedId;
  $('#addHierarchyGroup').hidden=(!isHierarchy()&&!isNative())||explorerTab!=='scene';$('#addHierarchyGroup').title=isNative()?'添加对象':'添加空组';$('#addHierarchyGroup').disabled=!editable();
  $('#migrateHierarchy').hidden=!hierarchyEnabled||isHierarchy()||isNative()||!editable();
  host.querySelectorAll('[data-resource]').forEach(b=>{b.onclick=()=>openResource(b.dataset.resource).catch(report);if(focusResource===b.dataset.resource)b.focus({preventScroll:true});});
  if(isNative()&&explorerTab==='prefabs')host.querySelectorAll('.catalog-card').forEach(card=>{
    const rid=card.querySelector('[data-resource]')?.dataset.resource;if(!rid)return;
    const count=resources.filter(r=>r.purpose==='prefab_test'&&r.subject_id===rid).length;
    const button=document.createElement('button');button.className='prefab-lab-entry';button.type='button';button.dataset.prefabLab=rid;button.textContent=`▷ 能力预览${count?' · '+count:''}`;button.title='预览对象的动画、技能、状态与控制器';button.onclick=()=>openPrefabLab(rid).catch(report);card.append(button);
  });
  host.querySelectorAll('.prefab-card-menu').forEach(menu=>{menu.onkeydown=e=>{if(e.key==='Escape'){menu.open=false;menu.querySelector('summary').focus();e.preventDefault();e.stopPropagation();}};});
  host.querySelectorAll('[data-select]').forEach(b=>{
    const fold=(open,recursive=false)=>{if(q)return;setExplorerExpanded(currentExplorerTree,treeState,b.dataset.treeNode,open,recursive);treeState.focusId=b.dataset.select;renderExplorer();focusExplorerRow(b.dataset.select);};
    b.onfocus=()=>{treeState.focusId=b.dataset.select;host.querySelectorAll('[data-select]').forEach(el=>el.tabIndex=el===b?0:-1);};
    b.onclick=e=>{if(host.getAttribute('aria-busy')==='true')return;if(e.target.closest('[data-tree-fold]'))fold(b.getAttribute('aria-expanded')!=='true',e.altKey);else selectObject(b.dataset.select,{toggle:e.ctrlKey||e.metaKey,range:e.shiftKey,order:[...host.querySelectorAll('[data-select]')].map(row=>row.dataset.select)});};
    b.onkeydown=e=>{
      if(host.getAttribute('aria-busy')==='true'){if(['ArrowUp','ArrowDown','Home','End','ArrowLeft','ArrowRight','Enter',' '].includes(e.key))e.preventDefault();return;}
      if(!['ArrowUp','ArrowDown','Home','End','ArrowLeft','ArrowRight'].includes(e.key))return;
      e.preventDefault();e.stopPropagation();
      const open=b.getAttribute('aria-expanded')==='true',group=b.hasAttribute('aria-expanded');
      if(!q&&group&&(e.key==='ArrowLeft'&&open||e.key==='ArrowRight'&&!open)){fold(e.key==='ArrowRight',e.altKey);return;}
      const target=currentExplorerTree.byKey.get(explorerTreeDestination(currentExplorerTree.visible,b.dataset.treeNode,e.key));if(!target?.object)return;
      if(e.shiftKey)selectObject(target.object.id,{range:true,order:currentExplorerTree.visible.map(row=>row.object.id)});
      focusExplorerRow(target.object.id);
    };
  });
  if(hadFocus&&sameScope&&explorerTab==='scene'){
    const focused=[...host.querySelectorAll('[data-select]')].find(el=>el.dataset.select===treeState.focusId);focused?.focus({preventScroll:true});
  }
  host.querySelectorAll('[data-instance-prefab]').forEach(b=>b.onclick=async()=>{if(b.disabled)return;b.disabled=true;b.closest('details').open=false;try{await instantiateHierarchyPrefab(b.dataset.instancePrefab);}catch(error){report(error);}finally{if(b.isConnected)b.disabled=!editable();}});
  host.querySelectorAll('[data-prefab-impact]').forEach(b=>b.onclick=()=>showHierarchyImpact(b.dataset.prefabImpact).catch(report));
  host.scrollTop=restoreTop;if(scrollToSelection&&reveal)focusExplorerRow(reveal,{focus:false});if(typeof renderIssueMarkers==='function')renderIssueMarkers();
}
function ensurePrefabPlacement(){
  if(prefabPlacement)return;
  prefabPlacement=new PrefabDragPlacement({catalog:$('.explorer'),viewport:$('#viewport'),onError:report,capture:prefabId=>{
    if(!editable()||!(isNative()||isHierarchy()))return null;
    const ctx=context(),prefab=ctx.manifest.resources[prefabId],preview=mainPreview;
    if(prefab?.kind!=='prefab'||prefabId===resourceId)throw Error('请选择其他预制件定义');
    if(localEdit||localCommitPending||drag)throw Error('请先完成当前编辑，再拖入预制件');
    if(!preview?.ready||preview.pending||preview.loadedSeq!==preview.seq||preview.sceneContext?.document_id!==ctx.key||preview.sceneContext?.source_revision!==ctx.base)throw Error('请等待当前场景加载完成，再拖入预制件');
    return {ctx,prefabId,name:prefab.name,preview,seq:preview.seq,dragId:uuid(),prefabPath:prefab.path?.startsWith('res://')?prefab.path:'res://'+prefab.path};
  },preview:(captured,screen)=>captured.preview.prefabDrag({phase:'move',drag_id:captured.dragId,prefab_path:captured.prefabPath,screen}),
  clear:captured=>captured.preview.prefabDrag({phase:'clear',drag_id:captured.dragId}),hide:captured=>captured.preview.prefabDrag({phase:'hide',drag_id:captured.dragId}),place:async(captured,screen)=>{
    const {ctx,prefabId,preview,seq}=captured;
    assertCurrentEdit(ctx);
    if(mainPreview!==preview||preview.seq!==seq||localEdit||localCommitPending||drag)throw Error('编辑视口已经变化，请重新拖入');
    const placement=await preview.placement(screen);
    assertCurrentEdit(ctx);
    if(mainPreview!==preview||preview.seq!==seq||localEdit||localCommitPending||drag)throw Error('编辑视口已经变化，请重新拖入');
    const result=await instantiateHierarchyPrefab(prefabId,ctx.resourceId,ctx,null,placement);
    if(key()!==ctx.key||branch.head!==result.revision)return;
    await loadHierarchyDocument(ctx.resourceId);
    if(key()!==ctx.key||branch.head!==result.revision)return;
    const created=docObjects().find(o=>o.address?.instance_path?.length===1&&o.address.instance_path[0]===result.instance_id&&(ctx.schema==='creation-native-1'?o.instance_root:o.address.definition_node_id===ctx.manifest.resources[prefabId].root_id));
    if(created)selectObject(created.id);toast(`已创建「${captured.name}」实例`);
  }});
}
function selectObject(id,{toggle=false,range=false,order=null,fromPreview=false,ids=null}={}){
  selectedSemanticObjects();const objects=mode==='edit'?docObjects():mode==='inspect'?frozenScene?.objects??[]:displayedPlayScene()?.objects??[];
  if(Array.isArray(ids)){
    const valid=new Set(objects.map(o=>o.id)),chosen=[...new Set(ids)].filter(value=>valid.has(value)).slice(0,128);
    semanticSelection={key:viewedDocumentKey(),ids:chosen,primary:chosen.includes(id)?id:chosen.at(-1)??null,anchor:chosen.includes(id)?id:chosen.at(-1)??null};
  }else semanticSelection={key:viewedDocumentKey(),...nextSemanticSelection(semanticSelection,id,order??objects.map(o=>o.id),{toggle,range})};
  const previousId=selectedId;id=semanticSelection.primary;selectionIntent=selectionIntent>=Number.MAX_SAFE_INTEGER?1:selectionIntent+1;if(id!==selectedId)invalidateMainCamera();if(localEdit&&localEdit.objectId!==id)finishLocalEdit().catch(report);selectedId=id;if(!fromPreview)mainPreview?.select?.(id??'',semanticSelection.ids);inspectorTab='object';renderExplorer({reveal:id,scrollToSelection:fromPreview});renderStage({syncPreview:!fromPreview});renderInspector();if(previousId!==selectedId)$('.inspector').scrollTop=0;sendPresence();
}
function disposeHierarchyPanel(){hierarchyPanel?.destroy();hierarchyPanel=null;hierarchyPanelKey=null;}
async function addHierarchyGroup(){if(isNative())return createNativeNode();try{if(!editable())return;const ctx=context(),selected=object(),nid='group-'+uuid(),parent=selected&&!selected.address.instance_path.length?selected.address.definition_node_id:ctx.manifest.resources[ctx.resourceId].root_id;await transact([newNodeOperation({id:nid,name:'新组',kind:'group',components:{},solid:false},ctx,parent)],{ctx,label:'空组'});if(key()!==ctx.key)return;await loadHierarchyDocument();if(key()===ctx.key)selectObject(nid);}catch(error){report(error);}}
async function instantiateHierarchyPrefab(prefabId,targetResource=resourceId,ctx=context(),fixedPrefab=null,placement=null){
  assertCurrentEdit(ctx);const prefab=fixedPrefab??ctx.manifest.resources[prefabId],destination=ctx.manifest.resources[targetResource];
  if(!prefab||prefab.kind!=='prefab'||!destination)throw new Error('预制件或目标文档不存在');
  if(prefabId===targetResource)throw new Error('预制件不能实例化到自身；请选择场景或其他定义');
  const instance_id='instance-'+uuid();
  if(ctx.schema==='creation-native-1'){
    const at={...ctx,resourceId:targetResource},names=new Set((destination.native_nodes??[]).filter(n=>n.owner_path==='.'&&!n.path.includes('/')).map(n=>n.name));
    const base=prefab.name.replace(/[.:@/"%\\]/g,'_')||'预制件';let name=base,index=2;while(names.has(name))name=base+' '+index++;
    const result=await transact([nativeInstantiateOperation(prefabId,at,{instanceId:instance_id,name,...(placement?{placement}:{})})],{ctx,label:'预制件实例',historyResource:targetResource});return {...result,instance_id};
  }
  if(placement&&placement.dimension!=='3d')throw Error('此文档仅支持三维预制件放置');
  const localPosition=placement?transformPoint(inverse(matrix(destination.nodes[destination.root_id].transform)),placement.position).map((v,i)=>v-prefab.nodes[prefab.root_id].transform.position[i]):[0,0,0];
  const result=await transact([{type:'instantiate_prefab',resource_id:targetResource,instance_id,expected_version:null,instance:{instance_id,prefab_id:prefabId,prefab_revision:prefab.version,parent_id:destination.root_id,transform:{position:localPosition,rotation:[0,0,0,1],scale:[1,1,1]},overrides:[]}}],{ctx,label:'预制件实例',historyResource:targetResource});return {...result,instance_id};
}
async function showHierarchyImpact(prefabId){
  if(mode!=='edit'||modePending)throw new Error('请返回编辑模式查看源定义更新影响');
  const ctx=context(),prefab=branch.manifest.resources[prefabId];const impact=await api.api(`${branchRoute()}/hierarchy-preview`,{method:'POST',body:{expected_head:ctx.base,prefab_id:prefabId,prefab_revision:prefab.version}});
  if(key()!==ctx.key||branch.head!==impact.source_revision)throw new Error('预览期间版本已经变化，请重新查看影响');
  inspectorTab='object';if(!object())selectedId=docObjects()[0]?.id??null;renderInspector();const panel=hierarchyPanel;if(!panel)throw new Error('层级属性尚未就绪，请稍后重试');await panel.setSnapshot(copy(branch));if(key()!==ctx.key||branch.head!==ctx.base||hierarchyPanel!==panel)throw new Error('影响预览目标已经变化，请重新查看');panel.setImpact(impact);if($('#semanticSpatialEditor'))$('#semanticSpatialEditor').open=true;showInspectorPanel();
}
function renderHierarchyInspector(){
  const o=object(),cache=resolvedDocument();
  if(!o){disposeHierarchyPanel();$('#inspectorBody').innerHTML='<div class="empty-state">选择层级中的对象，或添加空组与预制件实例。</div>';return;}
  const fingerprint=`${viewedDocumentKey()}/${mode==='edit'?branch.head:worldState?.scene_revision}/${selectedId}/${mode}/${modePending}/${mode==='inspect'?worldState?.frozen_sequence:''}`;
  if(hierarchyPanelKey===fingerprint&&hierarchyPanel){hierarchyPanel.setReadOnly(!editable());return;}
  disposeHierarchyPanel();hierarchyPanelKey=fingerprint;
  $('#inspectorBody').innerHTML=`<div class="identity"><p>${esc(o.address?.instance_path?.join(' / ')||'场景节点')} / ${esc(o.address?.definition_node_id||o.source_node_id)}</p><small>对象 ${esc(short(o.object_version??o.version))} · ${mode==='edit'?'源稿 '+esc(short(branch.head)):'所见 '+esc(short(mode==='inspect'?worldState?.frozen_revision:worldState?.scene_revision))}</small></div>${mode==='edit'?'<div class="model-actions"><button class="button subtle" data-action="import" '+(!editable()?'disabled':'')+'>导入模型</button><button class="button subtle" data-action="generateModel">Agent 制作</button></div><div id="hierarchyInspector"></div>':`<div class="readonly-note">${mode==='inspect'?'所见已冻结':'所见版本的源布局'} · 只读观察</div><p>世界位置 ${o.position?.map(fmt).join(' / ')} m</p>`}`;
  if(mode!=='edit'||!cache)return;
  const localFields={...o,...localEulerFields(o.local_transform)};
  $('#hierarchyInspector').insertAdjacentHTML('beforebegin',`<details class="hierarchy-angle-editor" open><summary>变换（相对父级）</summary>${transformFields(localFields,'position','坐标','m')}${transformFields(localFields,'rotation','旋转','°')}${transformFields(localFields,'scale','缩放','倍')}</details>`);
  bindTransformFields(o);
  const scope={project_id:project.id,branch_id:branch.branch_id,resource_id:resourceId},targetAddress=copy(o.address);
  const panel=hierarchyPanel=new HierarchyPrefabPanel($('#hierarchyInspector'),{
    read:async s=>{if(s.project_id===project?.id&&s.branch_id===branch?.branch_id)return copy(branch);return api.api(branchRoute(s.project_id,s.branch_id));},
    resolve:async(s,b)=>(await api.api(`${branchRoute(s.project_id,s.branch_id)}/resolved-scene?resource_id=${encodeURIComponent(s.resource_id)}&revision=${encodeURIComponent(b.head)}`)).rows,
    transact:async(s,payload)=>{if(key()!==`${s.project_id}/${s.branch_id}/${s.resource_id}`||!editable())throw new Error('编辑目标或权限已经变化');return transact(payload.ops,{ctx:{...context(),base:payload.base_revision},payload,label:'层级修改'});},
    preview:(s,input)=>{if(key()!==`${s.project_id}/${s.branch_id}/${s.resource_id}`)throw new Error('预览文档已经切换');return api.api(`${branchRoute(s.project_id,s.branch_id)}/hierarchy-preview`,{method:'POST',body:{...input,expected_head:hierarchyPanel?.branch?.head??branch.head}});},
    onOpenResource:id=>openResource(id).catch(report),
  },{regions:['inspector','impact'],readOnly:!editable(),showNodeTransform:false,semanticPresentation:true});
  panel.setContext(scope).then(()=>{if(hierarchyPanel===panel){panel.setReadOnly(!editable());panel.setSelection(targetAddress);}}).catch(report);
}
function renderStage({syncPreview=true}={}){
  $$('[data-scene-resource]').forEach(button=>button.disabled=mode!=='edit'||modePending);
  if(!doc())return;$('#documentTabs').innerHTML=openResources.map(id=>{const r=branch.manifest.resources[id];return `<button role="tab" class="document-tab" data-doc="${esc(id)}" aria-selected="${id===resourceId}">${icon(r.kind==='scene'?'scene':'component')}${esc(r.name)}<span class="tag dim">${r.kind==='scene'?'场景':'定义'}</span></button>`;}).join('');
  $('#currentDocumentName').textContent=doc().name;
  $('#currentDocumentKind').textContent=doc().kind==='prefab'?'定义':'场景';
  if(doc().purpose==='prefab_test')$('#currentDocumentKind').textContent='测试场景';
  const labSubject=doc().kind==='prefab'?doc().id:doc().purpose==='prefab_test'?doc().subject_id:object()?.prefab;
  $('#openPrefabLab').hidden=!isNative()||!labSubject||project?.role==='player';$('#openPrefabLab').disabled=!!localCommitPending||!!localEdit||!!drag;
  $('#openPrefabLab').onclick=()=>openPrefabLab(labSubject,doc().purpose==='prefab_test'?doc().id:null).catch(report);
  $('#currentDocumentIcon').setAttribute('href',doc().kind==='prefab'?'#i-component':'#i-scene');
  $('#documentMenu summary').title=`${doc().name} · ${doc().kind==='prefab'?'独立预制件':'场景'} · 切换已打开文档`;
  $$('[data-doc]').forEach(b=>b.onclick=()=>{closeWorkspaceDisclosure($('#documentMenu'));openResource(b.dataset.doc).catch(report);});
  $('#prefabBanner').hidden=doc().kind!=='prefab';$('#prefabBanner').innerHTML=doc().kind==='prefab'?doc().design?.category==='system'?`游戏系统 · ${esc(doc().name)} · 在右侧描述功能、微调规则`:`独立预制件 · ${esc(resourceId)} · ${docObjects().length} 个节点 <button id="placePrefab" class="inline-link" ${!editable()?'disabled':''}>放入场景</button>`:'';
  $('#returnToInstance')?.remove();
  if(doc().kind==='prefab'&&prefabReturnTarget?.definitionId===resourceId&&prefabReturnTarget.projectId===project.id&&prefabReturnTarget.branchId===branch.branch_id){
    const back=document.createElement('button');back.id='returnToInstance';back.className='button small prefab-return';back.textContent='返回实例';back.title=`返回 ${prefabReturnTarget.name}`;back.onclick=()=>returnToPrefabInstance().catch(report);$('#documentMenu').after(back);
  }
  if($('#placePrefab'))$('#placePrefab').onclick=placePrefab;
  $('#viewportTitle').textContent=mode==='edit'?doc().name:worldState?.scene_name??viewedScene()?.name??doc().name;$('#viewportSubtitle').textContent=`${viewedDocumentKey()} · ${short(mode==='edit'?branch.head:worldState?.scene_revision)}`;
  const stoppingAvailable=mode!=='edit'||modePending;
  $('#modeBadge').textContent={edit:'编辑模式',play:'独立试玩',inspect:'暂停观察'}[mode];
  $('#stage').dataset.previewMode=modePending?'preparing':mode;
  $('#editModeLabel').textContent=stoppingAvailable?'停止并编辑':'编辑';
  $('#playModeLabel').textContent=modePending?'切换中…':mode==='inspect'?'继续运行':mode==='play'?'运行中':'独立运行';
  $('#previewModeTitle').textContent=modePending?'正在切换':{edit:'编辑模式',play:'独立试玩',inspect:'暂停观察'}[mode];
  $('#previewModeDetail').textContent=modePending?'正在准备本次试玩，可随时停止并返回编辑':mode==='edit'?'共同编辑场景 · 每个窗口独立试玩':mode==='play'?'本窗口独立的一局 · 重新开始可恢复初始状态':'本局已暂停 · 右键环绕 / Shift + 右键平移 / 右键 + WASD 漫游';
  if(world?.native_shared){$('#modeBadge').textContent=mode==='inspect'?'个人检查':'共享世界';$('#previewModeTitle').textContent=mode==='inspect'?'个人检查':'共享世界';$('#previewModeDetail').textContent=mode==='inspect'?'只冻结本窗口 · 其他玩家继续运行':'与其他玩家游玩同一个世界';}
  if($('#viewportStateSummary')){const detail=project?.role==='player'&&mode==='edit'?'试玩使用已发布的固定版本':!world?.native_shared&&!modePending&&mode==='edit'?'独立运行读取当前源版本':$('#previewModeDetail').textContent;$('#viewportStateSummary').textContent=detail;$('#viewportStateSummary').title=detail;}
  $('#viewport').classList.toggle('inspect-frame',mode==='inspect');$('#viewport').classList.toggle('play-frame',mode==='play');
  $$('[data-mode]').forEach(b=>{b.classList.toggle('active',!modePending&&b.dataset.mode===mode);b.classList.toggle('inspect-active',b.dataset.mode==='inspect'&&mode==='inspect');b.setAttribute('aria-pressed',!modePending&&b.dataset.mode===mode);b.disabled=b.dataset.mode==='edit'?false:modePending||doc().kind==='prefab'||b.dataset.mode==='inspect'&&mode==='edit';if(b.dataset.mode==='inspect')b.hidden=mode==='edit';});
  $('#restartPlay').hidden=mode==='edit'||world?.native_shared===true;
  $('#sharedWorldButton').hidden=!isNative()||doc().kind!=='scene'||doc().purpose==='prefab_test';$('#sharedWorldButton').disabled=modePending||!!localEdit||!!localCommitPending;$('#restartPlay').disabled=modePending;
  renderInspectionUi();
  $('#playWebButton').disabled=!releaseBuilds||doc().kind!=='scene'||doc().purpose==='prefab_test'||!!localCommitPending||!!localEdit||!!drag;
  $('#returnLive').hidden=true;$('#returnLive').textContent='继续运行';$('#createAnchor').disabled=!editable();
  $('#previewModeStatus').hidden=!canWrite()&&mode==='edit'&&!modePending;
  if(!canWrite())$('#editModeLabel').textContent=stoppingAvailable?'停止并浏览':'只读浏览';
  $$('[data-action="publish"]').forEach(button=>button.hidden=isNative());
  $$('[data-action="publish"],.viewport-actions [data-action="import"]').forEach(button=>button.disabled=!canWrite());
  renderPlayControls();
  updateEditorControls();updateSelection();if(syncPreview)syncMainPreview().catch(report);
}
function updateSelection(){const o=object(),multiple=selectedSemanticObjects().length;$('#selectionStatus').textContent=multiple>1?`已选 ${multiple} 个对象 · 当前属性：${o?.name??''}`:o?`${o.name} · ${Array.isArray(o.position)?o.position.map(fmt).join(' / ')+(o.dimension==='2d'?' px':' m'):'等待所见坐标'}`:'未选择对象';}
function transformFields(o,name,label,unit){
  const value=trs(o)[name].map(number=>Number(number.toFixed(6)));
  const {row,reset}=createParameterControl(document,{type:'vector3',name:label,unit,transform:name,step:'any',min:name==='scale'?.1:name==='rotation'?-36000:-1000,max:name==='scale'?5:name==='rotation'?36000:1000,description:'相对父级的局部变换'},value,{disabled:!editable()||localCommitPending});
  reset.dataset.resetTransform=name;reset.disabled=!editable()||localCommitPending||value.every(v=>v===(name==='scale'?1:0));reset.title='恢复'+label+'为'+(name==='scale'?'1, 1, 1':'0, 0, 0');
  return row.outerHTML;
}
function renderInspectorName(){
  const existingActions=$('#semanticActionDock');existingActions?.remove();
  $('#inspectorNameDock')?.remove();if(inspectorTab!=='object'||!branch)return;
  const target=object(),resource=doc();if(!target&&resource?.kind!=='prefab')return;
  const ctx=context(),definition=resource.kind==='prefab'&&(!isNative()||!target||target.native_path==='.'),name=definition?resource.name:target.name;
  const heading=createInspectorName(document,{name,kind:definition?'预制件':target.address?.instance_path?.length||target.prefab?'预制件实例':target.kind==='anchor'?'空间锚点':'对象',editable:editable()&&(!isNative()||definition||target?.native_can_edit_structure),onError:report,
    onRename:async next=>{
      assertCurrentEdit(ctx);if(branch.head!==ctx.base||object()?.id!==target?.id)throw new Error('对象或源版本已变化，请重新选择后重命名');
      if(definition)return transact([{type:isNative()?'set_native_resource':'rename_resource',resource_id:ctx.resourceId,expected_version:resource.version,name:next}],{ctx,label:'预制件名称'});
      return renameSemanticInstance(next,{project_id:ctx.projectId,branch_id:ctx.branchId,revision:ctx.base,target:{resource_id:ctx.resourceId,object_id:target.id,address:copy(target.address),expected_version:target.version}});
    }});
  const hierarchy=isHierarchy(),address=target?.address,instance=address?.instance_path?.length===1?resource.instances?.[address.instance_path[0]]:null;
  const deletable=target&&(isNative()?target.native_can_edit_structure:!hierarchy||!address?.instance_path?.length&&address?.definition_node_id!==resource.root_id||instance&&address.definition_node_id===ctx.manifest.prefab_revisions[instance.prefab_revision]?.root_id);
  if(deletable){
    const remove=document.createElement('button');remove.type='button';remove.className='inspector-delete';remove.innerHTML=icon('trash');
    remove.title=`删除${hierarchy&&instance?'此实例':'所选对象'}「${target.name}」（可撤销）`;remove.setAttribute('aria-label',remove.title);remove.disabled=!editable();
    const panel=hierarchyPanel;
    remove.onclick=()=>{
      if(!editable()||key()!==ctx.key||object()?.id!==target.id||branch.head!==ctx.base)return;
      if(hierarchy){if(hierarchyPanel!==panel||panel?.busy)return;const action=panel?.root.querySelector('[data-inspector-delete]');if(action&&!action.disabled)action.click();}
      else transact([isNative()?nativeDeleteOperation(target,ctx):{type:'delete_object',resource_id:ctx.resourceId,object_id:target.id,expected_version:target.version}],{ctx,label:'删除对象'}).catch(report);
    };
    heading.insertBefore(remove,heading.querySelector('.semantic-kind'));
  }
  heading.id='inspectorNameDock';const preview=$('#objectPreviewDock');preview.parentElement.insertBefore(heading,preview);const actions=existingActions??$('#semanticActionDock');if(actions)heading.append(actions);
}
function renderInspector(){$('#previewDescription')?.remove();$('#semanticActionDock')?.remove();renderInspectorContent();mountSemanticInspector();renderInspectorName();renderIssueMarkers();}
function renderNativeInspector(){
  disposeHierarchyPanel();const target=object(),host=$('#inspectorBody');
  if(project?.role==='player'&&mode==='edit'){host.innerHTML='<div class="empty-state">点击 Play 运行已发布的试玩版本。获得协作权限后可查看源稿。</div>';return;}
  if(!target){host.innerHTML='<div class="empty-state">选择对象查看参数，或添加对象开始制作。</div><button class="button subtle" data-action="nativeNewNode" '+(!editable()?'disabled':'')+'>添加对象</button>';return;}
  const fields=mode==='edit'?nativeTransformFields(target):['position','rotation','scale'].every(k=>Array.isArray(target[k]))?trs(target):null;
  const kind=target.control_layout?'界面对象':target.dimension==='3d'?'三维对象':target.dimension==='2d'?'二维对象':target.type==='Control'?'界面对象':'组织节点';
  host.innerHTML=`<div class="identity">${kind}${target.native_target?.instance_ids?.length?' · 预制件实例':''}</div>${mode!=='edit'?'<p class="readonly-note">当前所见只读，返回编辑后修改源稿。</p>':''}${mode==='edit'?`<div class="model-actions"><button class="button subtle" data-action="import" ${!editable()?'disabled':''}>导入模型</button><button class="button subtle" data-action="nativeNewNode" ${!editable()?'disabled':''}>添加子对象</button></div>`:''}`;
  if(target.control_layout){
    const ctx=context(),loaded=mainPreview?.lastLoadedEvent?.objects?.find(row=>row.id===target.id),measured=nativeControlObservation(target,ctx,controlObservation,loaded),before=localEdit?.control&&localEdit.objectId===target.id?nativeControlObservation(target,ctx,localEdit.controlBefore,loaded):measured,observed=measured?.control_layout;
    const shown={...target,control_layout:observed?{...target.control_layout,values:copy(observed.values),viewport_size:copy(observed.viewport_size)}:target.control_layout};
    renderControlLayoutInspector(host,shown,{disabled:!editable()||localCommitPending,
      onPreview:value=>{if(!editable()||ctx.key!==key()||ctx.base!==branch.head||selectedId!==target.id)return;localEdit={ctx,objectId:target.id,target:copy(shown),native:true,control:true,controlBefore:copy(before),next:copy(value)};syncNativePreviews();},
      onCommit:async edit=>{assertCurrentEdit(ctx);if(selectedId!==target.id)throw Error('编辑目标已经切换');localEdit=null;controlObservation=null;api.scoped('drag_end');try{await transact([nativeControlOperation(shown,edit,ctx)],{ctx,label:'界面布局'});}finally{syncNativePreviews(true);}},
      onCancel:cancelLocalEdit,onError:report});return;
  }
  if(fields){
    for(const [field,label,unit]of [['position','坐标',target.dimension==='2d'?'px':'m'],['rotation','旋转','°'],['scale','缩放','倍']]){
      const planar=target.dimension==='2d',scalar=planar&&field==='rotation',values=scalar?fields.rotation[2]:planar?fields[field].slice(0,2):fields[field];
      const {row,input,reset}=createParameterControl(document,{type:scalar?'number':planar?'vector2':'vector3',name:label,unit,transform:field,step:'any',min:field==='scale'?-10000:-1000000,max:field==='scale'?10000:1000000,description:mode==='edit'?'相对父级的局部变换':'当前所见的位置与方向'},values,{disabled:!editable()||localCommitPending});
      if(scalar){input.dataset.transform=field;input.dataset.axis='2';}
      reset.dataset.resetTransform=field;reset.disabled=!editable()||localCommitPending;reset.title=field==='scale'?'将缩放设为1':'将'+label+'设为0';host.append(row);
    }
    if(mode==='edit')bindTransformFields(target);
  }else host.insertAdjacentHTML('beforeend','<p class="asset-line">此对象没有可直接调整的空间变换。</p>');
}
function renderInspectorContent(){
  if(!branch)return;$$('[data-inspector]').forEach(b=>b.setAttribute('aria-selected',b.dataset.inspector===inspectorTab));syncObjectPreview().catch(report);
  if(inspectorTab==='collaboration'){
    disposeHierarchyPanel();
    $('#inspectorBody').innerHTML=`<h3>当前文档在线协作者</h3><p class="asset-line">${api.ready?'实时连接正常':'连接断开，以下在线状态已失效'}</p>${api.ready&&peers.length?peers.map(p=>`<div class="collaborator"><div class="row"><span class="avatar" style="background:${esc(p.color)}">${esc(p.name.slice(0,1))}</span><strong>${esc(p.name)}${p.peer_id===api.peerId?'（当前窗口）':''}</strong></div><small>${esc({editing:'编辑',playing:'游玩',inspecting:'个人检查'}[p.mode]||p.mode)} · ${esc(p.selected_id||'未选中对象')}</small></div>`).join(''):'<div class="empty-state">等待在线协作者</div>'}<div class="field-heading">项目成员与权限</div>${project.members.map(m=>`<div class="row member-row"><span>${esc(m.name)}</span><span class="grow"></span><span class="tag dim">${esc(m.role)}</span></div>`).join('')}<button class="button subtle" data-action="invite">协作与权限</button><p class="asset-line">新 Agent 会话默认向项目成员公开，可在会话设置中手动设为私有。</p>`;return;
  }
  if(isHierarchy()){renderHierarchyInspector();return;}
  if(isNative()){renderNativeInspector();return;}
  disposeHierarchyPanel();
  const o=object();if(!o){$('#inspectorBody').innerHTML='<div class="empty-state">从树或 3D 视口选择对象。空场景可创建锚点、导入模型或通过真实 Codex 会话制作。</div>';return;}
  $('#inspectorBody').innerHTML=`<div class="identity"><code>${esc(o.id)}</code><br>对象版本 <code>${esc(short(o.version))}</code></div>${mode!=='edit'?'<div class="readonly-note">试玩视图只读；返回编辑后修改源稿。每个窗口拥有独立的试玩进度。</div>':''}<div class="model-actions"><button class="button subtle" data-action="import" ${!editable()?'disabled':''}>${icon('upload')}导入模型</button><button class="button subtle" data-action="generateModel">${icon('spark')}Agent 制作</button></div>${transformFields(o,'position','坐标','m')}${transformFields(o,'rotation','旋转','°')}${transformFields(o,'scale','缩放','倍')}${o.prefab?`<button class="button small subtle" data-resource="${esc(o.prefab)}">独立打开来源预制件</button>`:''}<div class="draft-info">${mode==='edit'?'中央源版本 '+esc(short(branch.head)):'世界版本 '+esc(short(world?.scene_revision))}<br>修改以服务器确认结果为准；冲突保留输入供核对。</div>`;
  $$('[data-resource]').forEach(b=>b.onclick=()=>openResource(b.dataset.resource));
  bindTransformFields(o);
}
// Pure source adapters. These accept captured scope/data only; no moving-head lookup.
// HIERARCHY_PURE_START
function localEulerFields(transform){
  const q=matrix({...transform,position:[0,0,0],scale:[1,1,1]});
  const x=Math.asin(Math.max(-1,Math.min(1,-q[9]))),y=Math.abs(Math.cos(x))>1e-7?Math.atan2(q[8],q[10]):Math.atan2(-q[2],q[0]),z=Math.abs(Math.cos(x))>1e-7?Math.atan2(q[1],q[5]):0;
  return {position:[...transform.position],rotation:[x,y,z].map(v=>v*180/Math.PI),scale:[...transform.scale]};
}
function scopeFor(ctx){return {project_id:ctx.projectId,branch_id:ctx.branchId,resource_id:ctx.resourceId};}
function assertEditContext(ctx,current,readOnly){
  if(readOnly)throw new Error('当前模式或角色只读');
  if(!ctx||ctx.projectId!==current.projectId||ctx.branchId!==current.branchId||ctx.key!==current.key)throw new Error('编辑目标已经切换，未提交旧文档修改');
}
function sourcePatchOperations(target,patch,ctx){
  if(ctx.schema==='creation-native-1')return nativePatchOperations(target,patch,ctx);
  if(ctx.schema!=='creation-hierarchy-2')return [{type:'patch_object',resource_id:ctx.resourceId,object_id:target.id,expected_version:target.version,patch:copy(patch)}];
  const a=target.address;if(!a||['project_id','branch_id','resource_id'].some(k=>a[k]!==scopeFor(ctx)[k]))throw new Error('对象完整地址与编辑文档不一致');
  if(['position','rotation','scale'].some(k=>Object.hasOwn(patch,k)))throw new Error('层级局部变换必须使用完整 quaternion transform；世界手柄必须提交完整矩阵');
  const resource=ctx.manifest.resources[ctx.resourceId];
  if(!a.instance_path.length)return [{type:'patch_node',resource_id:ctx.resourceId,node_id:a.definition_node_id,expected_version:target.node_version,patch:copy(patch)}];
  const instance=resource.instances[a.instance_path[0]];if(!instance)throw new Error('固定实例已经不存在');
  const relative={instance_path:a.instance_path.slice(1),definition_node_id:a.definition_node_id},overrides=[];
  for(const [field,value]of Object.entries(patch)){
    if(!['transform','name','color','solid','model_hash','model_url','components'].includes(field))throw new Error('此字段需打开预制件定义修改：'+field);
    if(field==='components'){
      if(!value||Object.keys(value).some(k=>!Object.hasOwn(target.components??{},k))||Object.keys(target.components??{}).some(k=>!Object.hasOwn(value,k)))throw new Error('实例不能增删组件，请打开定义编辑');
      for(const [component,data]of Object.entries(value))overrides.push({target:relative,path:['components',component],value:copy(data)});
    }else overrides.push({target:relative,path:[field],value:copy(value)});
  }
  if(!overrides.length)throw new Error('没有可提交的字段');
  return [{type:'set_overrides',resource_id:ctx.resourceId,instance_id:instance.instance_id,expected_version:instance.version,overrides}];
}
function newResourceOperation(id,kind,name,hierarchy){
  const resource=hierarchy?{schema:2,id,kind,name,root_id:'root',nodes:{root:{id:'root',name,kind:'group',parent_id:null,transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},solid:false,components:{}}},instances:{}}:{id,kind,name,objects:[]};
  return {type:'create_resource',resource_id:id,resource};
}
function newNodeOperation(target,ctx,parentId=null){
  if(ctx.schema==='creation-native-1')return nativeOperation(ctx,{op:'create_node',type:target.native_type??'Node3D',node_id:target.id,name:target.name,...(target.kind==='anchor'?{author_kind:'anchor'}:{}),...(parentId?{parent:typeof parentId==='object'?copy(parentId):{node_id:parentId,instance_ids:[]}}:{}),properties:{}});
  if(ctx.schema!=='creation-hierarchy-2')return {type:'put_object',resource_id:ctx.resourceId,object_id:target.id,expected_version:null,object:copy(target)};
  const {position,rotation,scale,model,...node}=copy(target);
  node.parent_id=parentId??ctx.manifest.resources[ctx.resourceId].root_id;
  node.transform=localTransformFromEuler({position:position??[0,0,0],rotation_degrees:rotation??[0,0,0],scale:scale??[1,1,1]});
  return {type:'put_node',resource_id:ctx.resourceId,node_id:node.id,expected_version:null,node};
}
function fixedSourceAttachment(target,ctx){
  const input={revision:ctx.base,resource_id:ctx.resourceId,expected_version:target.object_version??target.version};
  if(ctx.schema==='creation-hierarchy-2'||ctx.schema==='creation-native-1'){
    if(!target.address||['project_id','branch_id','resource_id'].some(k=>target.address[k]!==scopeFor(ctx)[k]))throw new Error('附件完整地址与会话文档不一致');
    input.address=copy(target.address);
  }else input.object_id=target.id;
  return input;
}
function matchesTransformEvent(message,target,id){
  try{return message.id===id&&fullAddressKey(message.address)===fullAddressKey(target.address)&&message.source_revision===target.base_revision&&message.object_version===target.object_version&&message.ancestry_hash===target.ancestry_hash&&Array.isArray(message.world_matrix)&&message.world_matrix.length===16&&message.world_matrix.every(Number.isFinite);}catch{return false;}
}
function hierarchyPreviewList(scene,values,selfId,now){
  return values.filter(p=>p.peer_id!==selfId&&p.expires_at>now&&p.source_revision===scene.source_revision).flatMap(p=>{
    const o=scene.objects.find(o=>o.id===p.object_id);
    try{if(!o||fullAddressKey(o.address)!==fullAddressKey(p.address)||o.version!==p.expected_version||o.ancestry_hash!==p.expected_ancestry_hash||!Array.isArray(p.world_matrix)||p.world_matrix.length!==16||!p.world_matrix.every(Number.isFinite))return [];}catch{return [];}
    return [{id:o.id,address:copy(p.address),world_matrix:[...p.world_matrix],expected_object_version:p.expected_version,expected_ancestry_hash:p.expected_ancestry_hash,peer_id:p.peer_id,expires_at:p.expires_at}];
  });
}
// HIERARCHY_PURE_END
// Source manifests are fixed snapshots: accepting a commit replaces branch,
// while measurements and drag drafts live in separate resolved objects. Keep
// that snapshot by reference so camera/selection events do not clone the whole
// project. An in-flight edit still retains its original head and manifest.
function context(){return {projectId:project.id,branchId:branch.branch_id,resourceId,base:branch.head,key:key(),schema:branch.manifest.schema,manifest:branch.manifest};}
function assertCurrentEdit(ctx){if(!branch||!project)throw new Error('编辑文档已经关闭');assertEditContext(ctx,context(),!editable());}
function hierarchyTarget(o,ctx=context()){
  const row=lookupResolvedRow(resolvedDocuments.get(resolvedKey(ctx.resourceId,ctx.base))?.rows??[],o.address);
  if(!row)throw new Error('缺少匹配源版本的层级行，请等待文档读取');
  return captureTransformTarget({scope:scopeFor(ctx),branch:{project_id:ctx.projectId,branch_id:ctx.branchId,head:ctx.base,manifest:ctx.manifest},row,readOnly:!editable()});
}
function history(ctx=context()){if(!histories.has(ctx.key))histories.set(ctx.key,{undo:[],redo:[]});return histories.get(ctx.key);}
function creationUndoAcknowledgements(manifest,instances){
  const result=[];
  for(const {resource_id,instance_id} of instances??[]){
    for(const node of manifest.resources[resource_id]?.native_nodes??[]){
      if(!(node.instance_ids??[]).includes(instance_id)||!(node.properties??[]).some(p=>p.stored_locally&&p.overridden&&!p.name.startsWith('metadata/')))continue;
      const target={instance_ids:copy(node.instance_ids),...(node.metadata?.wa_instance_mount?{mount:true}:{node_id:node.node_id})};
      result.push({resource_id,target,expected_node_version:node.version});
    }
  }
  return result;
}
async function transact(ops,{ctx=context(),label='修改',record=true,payload=null,historyResource=ctx.resourceId}={}){
  assertCurrentEdit(ctx);
  const initiatingModal=modalGeneration,initiatingUser=user?.id;
  const transaction=payload?copy(payload):{transaction_id:uuid(),base_revision:ctx.base,ops:copy(ops)};
  $('#workspaceStatus').textContent=`正在提交${label}…`;
  try{
    const result=await api.api(`${branchRoute(ctx.projectId,ctx.branchId)}/transactions`,{method:'POST',body:transaction});
    if(record&&result.inverse?.length){const owner={...ctx,resourceId:historyResource,key:`${ctx.projectId}/${ctx.branchId}/${historyResource}`};const createdInstances=ops.filter(op=>op.type==='native_scene_operation'&&op.operation?.op==='instantiate').map(op=>({resource_id:op.resource_id,instance_id:op.operation.instance_id}));history(owner).undo.push({ops:result.inverse,label,...(createdInstances.length?{createdInstances,discardRemoved:creationUndoAcknowledgements(result.branch.manifest,createdInstances)}:{})});history(owner).redo=[];}
    if(project?.id===ctx.projectId&&branch?.branch_id===ctx.branchId){acceptBranch(result.branch);$('#workspaceStatus').textContent=`已保存 ${short(result.revision)}${isNative()&&mode==='edit'?' · 场景更新中':''}`;updateEditorControls();}
    return result;
  }catch(error){
    pendingEdits.set(transaction.transaction_id,{ctx,label,transaction,error:errorText(error)});
    if(error.status===409){
      const latest=await api.api(branchRoute(ctx.projectId,ctx.branchId));
      if(project?.id===ctx.projectId&&branch?.branch_id===ctx.branchId)acceptBranch(latest,{refreshInspector:false});
      if(modalGeneration===initiatingModal&&user?.id===initiatingUser&&key()===ctx.key)modal('修改冲突 · 已保留输入',`<p>「${esc(label)}」没有写入。正式内容已刷新，请核对他人的修改。</p><details open><summary>待提交的修改</summary><pre>${esc(JSON.stringify(transaction,null,2))}</pre></details><details><summary>服务器当前对象</summary><pre>${esc(JSON.stringify(error.details?.current??error.details,null,2))}</pre></details><p>不会自动用旧值覆盖新的对象版本。</p>`,[{label:'保留记录并查看最新',primary:true,action:()=>{closeModal();renderInspector();}}]);
    }
    report(error);throw error;
  }
}
async function patchObject(target,patch,label,ctx=context()){
  assertCurrentEdit(ctx);
  return transact(sourcePatchOperations(target,patch,ctx),{ctx,label});
}
function startLocalEdit(target){
  if(!editable())return;
  if(localEdit?.objectId===target.id&&localEdit.ctx.key===key())return;
  const ctx=context(),hierarchy=ctx.schema==='creation-hierarchy-2',native=ctx.schema==='creation-native-1';localEdit={ctx,objectId:target.id,target:copy(target),next:native?nativeTransformFields(target):hierarchy?localEulerFields(target.local_transform):trs(target),hierarchy,native,...(hierarchy?{capture:hierarchyTarget(target,ctx)}:{})};
}
function bindTransformFields(target){
  const documentKey=key();
  $$('[data-reset-transform]').forEach(button=>button.onclick=()=>{
    if(key()!==documentKey||!editable()||localCommitPending||selectedId!==target.id)return;
    startLocalEdit(target);const field=button.dataset.resetTransform;localEdit.next[field]=[0,0,0].map(()=>field==='scale'?1:0);finishLocalEdit().catch(report);
  });
  $$('[data-transform]').forEach(input=>{
    // Focus alone is not an edit. Tab can focus the next field before the
    // previous save resolves; capturing here would pin that field to old data.
    input.oninput=()=>{
      if(key()!==documentKey||!editable()||localCommitPending||selectedId!==target.id||input.value.trim()==='')return;
      const value=Number(input.value),axis=Number(input.dataset.axis),field=input.dataset.transform;
      const valid=Number.isFinite(value)&&(isNative()?(field==='scale'?Math.abs(value)>=.0001&&Math.abs(value)<=10000:Math.abs(value)<=1000000):(field==='scale'?value>=.1&&value<=5:Math.abs(value)<=(field==='position'?1000:36000)));
      input.setCustomValidity(valid?'':field==='scale'?(isNative()?'缩放不能为0，绝对值范围0.0001–10000':'缩放范围 0.1–5'):'请输入有效的范围内数值');if(!valid)return;
      startLocalEdit(target);localEdit.next[field][axis]=value;
      if(localEdit.native){syncNativePreviews();}
      else if(localEdit.hierarchy){syncHierarchyPreviews();const transform=localTransformFromEuler({position:localEdit.next.position,rotation_degrees:localEdit.next.rotation,scale:localEdit.next.scale});sendDragPreview({...localEdit.target,source_revision:localEdit.ctx.base},{world_matrix:multiply(localEdit.capture.parent_world_matrix,matrix(transform))});}
      else{syncMainPreview().catch(report);sendDragPreview(localEdit.target,localEdit.next);}updateSelection();
    };
    input.onchange=()=>{if(key()===documentKey&&input.checkValidity()&&input.value.trim()!=='')finishLocalEdit().catch(report);};
    input.onblur=()=>{
      if(key()!==documentKey)return;
      if(!input.checkValidity()||input.value.trim()===''){input.value=(isNative()?nativeTransformFields(target):target.local_transform?localEulerFields(target.local_transform):trs(target))[input.dataset.transform][Number(input.dataset.axis)];input.setCustomValidity('');toast('未提交无效数值。');cancelLocalEdit();}
      else finishLocalEdit().catch(report);
    };
    input.onkeydown=e=>{
      if(e.isComposing||!['Enter','Escape'].includes(e.key))return;
      e.preventDefault();e.stopPropagation();
      if(key()!==documentKey||selectedId!==target.id||!editable()||localCommitPending)return;
      if(e.key==='Escape'){
        cancelLocalEdit();const canonical=object();
        if(!canonical||canonical.id!==target.id){renderInspector();return;}
        const values=isNative()?nativeTransformFields(canonical):canonical.local_transform?localEulerFields(canonical.local_transform):trs(canonical);
        $$('[data-transform]').forEach(field=>{field.value=values[field.dataset.transform][Number(field.dataset.axis)];field.setCustomValidity('');});
        bindTransformFields(canonical);updateSelection();return;
      }
      if(!input.checkValidity()||input.value.trim()===''){input.reportValidity();toast('未提交无效数值。');return;}
      finishLocalEdit().catch(report);
    };
  });
}
async function finishLocalEdit(){
  const edit=localEdit;if(!edit)return;localEdit=null;api.scoped('drag_end');
  const before=edit.native?nativeTransformFields(edit.target):edit.hierarchy?localEulerFields(edit.target.local_transform):trs(edit.target);
  if(JSON.stringify(before)===JSON.stringify(edit.next)){syncHierarchyPreviews();syncNativePreviews();return;}
  localCommitPending=true;$$('[data-transform]').forEach(input=>input.disabled=true);
  const commit={key:edit.ctx.key,objectId:edit.objectId,promise:null};localCommit=commit;
  commit.promise=(async()=>{
    try{return await patchObject(edit.target,edit.native?Object.fromEntries(Object.entries(edit.next).filter(([field,value])=>JSON.stringify(value)!==JSON.stringify(before[field]))):edit.hierarchy?{transform:localTransformFromEuler({position:edit.next.position,rotation_degrees:edit.next.rotation,scale:edit.next.scale})}:edit.next,'局部变换',edit.ctx);}
    finally{
      try{if(key()===edit.ctx.key)await loadHierarchyDocument();}finally{
        localCommitPending=false;
        updateEditorControls();
        if(key()===edit.ctx.key){syncHierarchyPreviews(true);syncMainPreview().catch(report);if(!localEdit)renderInspector();}
      }
    }
  })();
  try{return await commit.promise;}finally{if(localCommit===commit)localCommit=null;}
}
function cancelLocalEdit(){const wasFlat=localEdit&&!localEdit.hierarchy,wasControl=Boolean(localEdit?.control||drag?.target?.control_layout),before=localEdit?.controlBefore??drag?.controlBefore;localEdit=null;drag=null;if(wasControl)controlObservation=branch&&project?nativeControlObservation(object(),context(),before):null;api.scoped('drag_end');syncHierarchyPreviews(true);syncNativePreviews(true);if(wasFlat)syncMainPreview().catch(report);if(wasControl)renderInspector();}
let lastDrag=0;
function sendDragPreview(target,next){if(isNative())return sendNativeDragPreview(target,next);if(!editable()||Date.now()-lastDrag<80)return;lastDrag=Date.now();const h=target.address;api.scoped('drag_preview',h?{object_id:target.id,address:copy(h),expected_version:target.object_version??target.version,expected_ancestry_hash:target.ancestry_hash,source_revision:target.source_revision??branch.head,world_matrix:copy(next.world_matrix)}:{object_id:target.id,expected_version:target.version,...next});}
async function applyHistory(action){
  if(!editable())return;const ctx=context(),h=history(ctx),entry=h[action].at(-1);if(!entry)return;
  const payload=entry.discardRemoved?.length?{transaction_id:uuid(),base_revision:ctx.base,ops:copy(entry.ops),discard_removed_overrides:copy(entry.discardRemoved)}:null;
  const result=await transact(entry.ops,{ctx,label:(action==='undo'?'撤销 ':'重做 ')+entry.label,record:false,payload});
  const next={ops:result.inverse,label:entry.label,...(entry.createdInstances?{createdInstances:entry.createdInstances,...(action==='redo'?{discardRemoved:creationUndoAcknowledgements(result.branch.manifest,entry.createdInstances)}:{})}:{})};
  h[action].pop();h[action==='undo'?'redo':'undo'].push(next);updateEditorControls();
}
function updateEditorControls(){
  viewportAnnotations?.update();
  hierarchyPanel?.setReadOnly(!editable());$$('#inspectorBody input[data-transform]').forEach(input=>input.disabled=!editable()||localCommitPending);$$('#inspectorBody [data-action=import]').forEach(input=>input.disabled=!editable());if($('#hierarchySolid'))$('#hierarchySolid').disabled=!editable()||object()?.kind==='group';
  const h=branch?history():{undo:[],redo:[]};$$('[data-tool]').forEach(b=>{b.disabled=!editable();b.setAttribute('aria-pressed',b.dataset.tool===editorTool);});
  $('#toggleSnap').disabled=!editable();$('#toggleSnap').setAttribute('aria-pressed',editorSnap);
  $('#undoTransform').disabled=!editable()||!h.undo.length;$('#redoTransform').disabled=!editable()||!h.redo.length;
  $('#toolStatus').textContent=editable()?`${{select:'选择',move:'移动 · 世界',rotate:'旋转 · 世界',scale:'缩放 · 局部'}[editorTool]}${editorSnap?' · 吸附':''}`:'只读';
}
function nativeParentTarget(){const target=object();return target?.native_target?copy(target.native_target):null;}
function createNativeNode(){
  if(!editable())return;const ctx=context(),parent=nativeParentTarget(),parentName=object()?.name;
  const active=modal('添加对象',`<label class="dialog-field">名称<input id="nativeNodeName" required data-autofocus maxlength="160" value="新对象"></label><label>类型<select id="nativeNodeType"><option value="Node3D">三维对象</option><option value="Node2D">二维对象</option><option value="Control">界面对象</option><option value="Node">组织节点</option></select></label><p>${parentName?'添加到「'+esc(parentName)+'」中。':'添加到当前文档根节点。'}</p>`,[{label:'取消',action:closeModal},{label:'添加',primary:true,action:async()=>{
    if(!active())return;assertCurrentEdit(ctx);const id='node-'+uuid(),name=$('#nativeNodeName').value.trim(),type=$('#nativeNodeType').value;if(!name)throw Error('请输入对象名称');
    await transact([newNodeOperation({id,name,native_type:type},ctx,parent)],{ctx,label:'新对象'});if(!active())return;closeModal();if(key()===ctx.key){await loadHierarchyDocument();if(key()===ctx.key)selectObject(docObjects().find(o=>o.source_node_id===id)?.id??id);}
  }}]);
  if(object()?.dimension==='2d')$('#nativeNodeType').value='Node2D';
}
async function createAnchor(){
  if(!editable())return;const ctx=context(),target={id:'anchor-'+uuid(),name:'空间锚点',kind:'anchor',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],color:'#edb86c',solid:false,components:{}};
  if(isNative())target.native_type=object()?.dimension==='2d'?'Node2D':'Node3D';await transact([newNodeOperation(target,ctx)],{ctx,label:'空间锚点'});if(key()!==ctx.key)return;await loadHierarchyDocument();if(key()===ctx.key)selectObject(target.id);
}
function createResource(){
  if(!editable())return;const ctx=context();
  const active=modal('新建场景或预制件',`<p class="dialog-intro">场景组织游戏内容，预制件用于重复使用的角色、道具和逻辑。</p><label class="dialog-field">名称<input id="resourceName" required data-autofocus data-validation-message="请输入场景或预制件的名称。" maxlength="160" placeholder="例如 晨光花园"></label><div class="dialog-field-grid"><label>类型<select id="resourceKind"><option value="scene">场景</option><option value="prefab">预制件</option></select></label>${isNative()?'<label>空间<select id="nativeResourceType"><option value="Node3D">三维</option><option value="Node2D">二维</option><option value="Control">界面</option></select></label>':''}</div><div class="dialog-source"><strong>创建后独立打开</strong><p>通过导入模型、调整对象或与 Agent 对话继续完善。</p></div>`,[{label:'取消',action:closeModal},{label:'创建并打开',primary:true,busyLabel:'正在创建…',action:async()=>{
    if(!active())return;assertCurrentEdit(ctx);
    const kind=$('#resourceKind').value,id=`${kind}-${uuid()}`,name=$('#resourceName').value.trim();if(!name)throw new Error('请输入文档名称');
    await transact([ctx.schema==='creation-native-1'?nativeCreateResourceOperation(id,kind,name,$('#nativeResourceType').value):newResourceOperation(id,kind,name,ctx.schema==='creation-hierarchy-2')],{ctx,label:'文档'});
    if(!active())return;closeModal();if(branchKey()===`${ctx.projectId}/${ctx.branchId}`){explorerTab=kind==='scene'?'scene':'prefabs';await openResource(id);}
  }}]);
}
function placePrefab(){
  if(!editable()||doc().kind!=='prefab')return;const prefab=copy(doc()),ctx=context(),scenes=Object.values(branch.manifest.resources).filter(r=>r.kind==='scene'),hierarchy=isHierarchy(),native=isNative();
  const active=modal('将预制件放入场景',`<p>${native?'创建此预制件的真实场景实例。未单独调整的属性会跟随定义更新。':hierarchy?'固定定义版本 '+esc(short(prefab.version))+'，创建保留完整子树的实例挂载。':'按当前定义的全部 '+prefab.objects.length+' 个节点实例化，保留相对坐标、旋转、缩放与组件。'}</p><label>目标场景<select id="placementScene">${scenes.map(r=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></label>`,[{label:'取消',action:closeModal},{label:'放入',primary:true,action:async()=>{
    if(!active())return;assertCurrentEdit(ctx);const rid=$('#placementScene').value;if(!rid)throw new Error('先创建目标场景');
    if(hierarchy||native)await instantiateHierarchyPrefab(prefab.id,rid,ctx,prefab);
    else {if(!prefab.objects.length)throw new Error('该预制件还没有节点');const ops=prefab.objects.map(o=>{const instance={...copy(o),id:'obj-'+uuid(),prefab:prefab.id,prefab_node_id:o.id};delete instance.version;return{type:'put_object',resource_id:rid,object_id:instance.id,expected_version:null,object:instance};});await transact(ops,{ctx,label:'预制件实例',historyResource:rid});}
    if(!active())return;closeModal();if(key()===ctx.key)await openResource(rid);
  }}]);
}
function importNativeModel(){
  if(!editable())return;const ctx=context(),parent=nativeParentTarget();
  const active=modal('导入模型为新对象',`<p>${object()?'新模型添加到「'+esc(object().name)+'」中。':'新模型添加到当前场景。'}</p><label class="dialog-file-picker"><strong>选择模型文件</strong><span>GLB 格式 · 包含模型、材质与纹理</span><input id="modelFile" type="file" required data-validation-message="请选择一个 GLB 模型文件。" accept=".glb,model/gltf-binary"></label><p id="uploadStatus" role="status"></p>`,[{label:'取消',action:closeModal},{label:'上传并保存',primary:true,action:async()=>{
    if(!active())return;assertCurrentEdit(ctx);const file=$('#modelFile').files[0];if(!file)throw Error('请选择GLB文件');$('#uploadStatus').textContent='正在上传 '+file.name;
    const asset=await api.api(`projects/${encodeURIComponent(ctx.projectId)}/assets`,{method:'POST',body:file,headers:{'X-Asset-Name':encodeURIComponent(file.name)}});
    if(!active())return;assertCurrentEdit(ctx);const id='model-'+uuid();await transact([{type:'import_native_model',resource_id:ctx.resourceId,expected_version:ctx.manifest.resources[ctx.resourceId].version,asset_hash:asset.hash??asset.id,node_id:id,name:file.name.replace(/\.glb$/i,'').replace(/[.:@/"%\\]/g,'_'),...(parent?{parent}: {})}],{ctx,label:'模型导入'});
    if(!active())return;closeModal();if(key()===ctx.key){await loadHierarchyDocument();if(key()===ctx.key)selectObject(docObjects().find(o=>o.source_node_id===id)?.id??id);}toast('模型已保存到当前文档。');
  }}]);
}
function importModel(){
  if(isNative())return importNativeModel();
  if(!editable())return;const ctx=context(),selected=object()?copy(object()):null,hierarchy=ctx.schema==='creation-hierarchy-2';
  if(hierarchy&&selected?.address.instance_path.length&&selected.kind!=='model'){toast('此实例节点类型不能覆盖为模型。请独立打开预制件定义，在定义中添加模型。');return;}
  const target=hierarchy&&selected?.kind==='group'?null:selected;
  const parentId=hierarchy&&!target&&selected&&!selected.address.instance_path.length?selected.address.definition_node_id:null;
  const active=modal(target?'替换选中对象的模型':parentId?'导入模型为选中组的子节点':'导入模型为新对象',`<p>GLB 上传为项目不可变资产，再通过固定版本事务更新${target?.address?.instance_path.length?'仅此实例的模型覆盖':'文档'}。${parentId?'新模型的局部原点位于所选组。':''}</p><label class="dialog-file-picker"><strong>选择模型文件</strong><span>GLB 格式 · 包含模型、材质与纹理</span><input id="modelFile" type="file" required data-validation-message="请选择一个 GLB 模型文件。" accept=".glb,model/gltf-binary"></label><p id="uploadStatus" role="status"></p>`,[{label:'取消',action:closeModal},{label:'上传并保存',primary:true,action:async()=>{
    if(!active())return;assertCurrentEdit(ctx);const file=$('#modelFile').files[0];if(!file)throw new Error('请选择 GLB 文件');$('#uploadStatus').textContent=`正在上传 ${file.name} · ${Math.ceil(file.size/1024)} KiB…`;
    const asset=await api.api(`projects/${encodeURIComponent(ctx.projectId)}/assets`,{method:'POST',body:file,headers:{'X-Asset-Name':encodeURIComponent(file.name)}});
    if(!active())return;assertCurrentEdit(ctx);const hash=asset.hash||asset.id,patch={model_hash:hash,model_url:asset.url,...(!hierarchy?{model:hash}:{}),...(!target?.address?.instance_path.length?{kind:'model'}:{})};
    if(target)await patchObject(target,patch,'模型替换',ctx);
    else{const next={...patch,id:'obj-'+uuid(),name:file.name.replace(/\.glb$/i,''),position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],solid:true,color:'#74d5cd',components:{}};await transact([newNodeOperation(next,ctx,parentId)],{ctx,label:'模型对象'});if(active()&&key()===ctx.key){await loadHierarchyDocument();if(key()===ctx.key)selectedId=next.id;}}
    if(!active())return;closeModal();if(key()===ctx.key)renderAll();toast('GLB 资产与文档已由中央服务保存。运行世界仍需验证和应用。');
  }}]);
}
function migrateHierarchy(){
  if(!hierarchyEnabled||!editable()||isHierarchy()||isNative())return;const ctx=context();
  modal('迁移当前分支到层级文档',`<p>固定源版本 <code>${esc(ctx.base)}</code>。转换全部场景与预制件，保留旧源版本历史，建立显式根节点和局部变换。</p><p>旧平级预制件是复制对象；迁移会保留它们为独立节点，不自动推断实例引用。此操作不自动发布世界，原有撤销记录会清空；模型、脚本和可玩世界仍需匹配运行时验证。</p>`,[{label:'取消',action:closeModal},{label:'确认迁移此固定源版本',primary:true,action:async()=>{assertCurrentEdit(ctx);const payload={transaction_id:uuid(),base_revision:ctx.base,expected_head:ctx.base,ops:[{type:'migrate_hierarchy'}]};await transact(payload.ops,{ctx,payload,label:'层级迁移',record:false});for(const k of histories.keys())if(k.startsWith(`${ctx.projectId}/${ctx.branchId}/`))histories.delete(k);closeModal();if(key()===ctx.key){await loadHierarchyDocument();renderAll();}}}]);
}
function newGame(){
  if(!canCreateGame){toast('当前账号可试玩游戏，可在现有游戏中申请编辑，由拥有者批准后创作。');return;}
  const owner=user.id;
  const active=modal('创建游戏',`<p class="dialog-intro">从一个空场景开始，或选择模板作为创作起点。</p><label class="dialog-field">游戏名称<input id="gameName" required maxlength="160" data-autofocus data-validation-message="请先给游戏起一个名字。" placeholder="给新游戏起个名字" autocomplete="off"></label><fieldset class="dialog-choices"><legend>选择起点</legend><label class="dialog-choice"><input type="radio" name="gameTemplateChoice" value="empty" checked><span><strong>空白游戏</strong><small>一个空场景，从自己的想法开始。</small></span></label><label class="dialog-choice"><input type="radio" name="gameTemplateChoice" value="harbor"><span><strong>星港模板</strong><small>包含 6 种模型，可继续设计场景与玩法。</small></span></label></fieldset><p class="dialog-footnote">创建后进入主干工作台，随时邀请伙伴一起创作。</p>`,[{label:'取消',action:closeModal},{label:'创建并进入',primary:true,busyLabel:'正在创建…',action:async()=>{
    if(!active()||user?.id!==owner||!canCreateGame)return;
    const name=$('#gameName').value.trim();if(!name)throw new Error('请输入游戏名称');
    const result=await api.api('projects',{method:'POST',body:{name,template:$('#modalBody [name="gameTemplateChoice"]:checked').value}});
    if(!active()||user?.id!==owner)return;await refreshCatalog();
    if(!active()||user?.id!==owner)return;closeModal();await navigateCatalog({projectId:result.project.id,branchId:result.branch.branch_id});
  }}]);
}
function newBranch(sourceId){
  if(!project||!canWrite()){toast('先选择拥有编辑权限的项目。');return;}
  const owner=user.id,targetProject=project,sources=project.branches.map(b=>({...b}));
  const initial=sources.find(b=>b.branch_id===(sourceId??branch?.branch_id))??sources.find(b=>b.branch_id==='main')??sources[0];if(!initial)return;
  const seed=uuid();let customId=false;
  const active=modal('创建分支',`<p class="dialog-intro">在「${esc(project.name)}」中尝试新的玩法或场景，原分支继续保留。</p><label class="dialog-field">分支名称<input id="newBranchName" required maxlength="160" data-autofocus data-validation-message="请输入分支名称，例如：夜间花园。" placeholder="例如 夜间花园" autocomplete="off"></label><div class="dialog-source"><label>基于哪个分支<select id="newBranchSource">${sources.map(b=>`<option value="${esc(b.branch_id)}" ${b.branch_id===initial.branch_id?'selected':''}>${esc(b.branch_id)} · ${esc(b.branch_id==='main'?'主干':b.name)}</option>`).join('')}</select></label><p id="newBranchSourceVersion"></p></div><details class="dialog-advanced"><summary>分支标识 <code id="newBranchIdPreview"></code></summary><label>分支标识<input id="newBranchId" required maxlength="96" autocomplete="off" spellcheck="false" aria-describedby="branchIdHelp"><small id="branchIdHelp">已自动生成。可使用字母、数字、点、短横线和下划线。</small></label></details><p class="dialog-footnote">创建后直接进入新分支；之后可比较改动并合并。</p>`,[{label:'取消',action:closeModal},{label:'创建并进入',primary:true,busyLabel:'正在创建分支…',action:async()=>{
    if(!active()||user?.id!==owner||project?.id!==targetProject.id||!canWrite())throw new Error('当前游戏或权限已改变，请重新选择来源。');
    const source=sources.find(b=>b.branch_id===$('#newBranchSource').value),id=$('#newBranchId').value.trim(),name=$('#newBranchName').value.trim();
    if(!name)throw new Error('请输入分支名称');
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(id)){$('#newBranchId').closest('details').open=true;throw new Error('分支标识以字母或数字开头，最多 96 个字符，仅支持字母、数字、点、短横线和下划线。');}
    if(sources.some(b=>b.branch_id===id)){$('#newBranchId').closest('details').open=true;throw new Error('这个分支标识已存在，请换一个。');}
    if(!source)throw new Error('来源分支已变化，请重新选择。');
    const created=await api.api(`projects/${encodeURIComponent(targetProject.id)}/branches`,{method:'POST',body:{from_branch:source.branch_id,expected_head:source.head,branch_id:id,name}});
    if(!active()||user?.id!==owner||project?.id!==targetProject.id)return;
    if(!project.branches.some(b=>b.branch_id===created.branch_id))project.branches.push(created);
    closeModal();await navigateCatalog({projectId:targetProject.id,branchId:created.branch_id});
  }}]);
  const syncId=()=>{if(!customId)$('#newBranchId').value=suggestBranchId($('#newBranchName').value,sources.map(b=>b.branch_id),seed);$('#newBranchIdPreview').textContent=$('#newBranchId').value;};
  $('#newBranchName').addEventListener('input',syncId);$('#newBranchId').addEventListener('input',()=>{customId=!!$('#newBranchId').value.trim();syncId();});syncId();
  const showSource=()=>{$('#newBranchSourceVersion').textContent=`从当前源版本 ${short(sources.find(b=>b.branch_id===$('#newBranchSource').value).head)} 开始`;};$('#newBranchSource').onchange=showSource;showSource();
}
function invite(){if(project)return collaborationAccess.open({projectId:project.id,tab:project.role==='owner'?'invites':'members'});}
function joinInvite(code=''){
  let requestId=uuid(),lastCode=null;const owner=user?.id;
  const clearInvite=()=>{const url=new URL(location.href);url.searchParams.delete('invite');window.history.replaceState(null,'',url.pathname+url.search+url.hash);};
  const active=modal('加入游戏',`<p class="dialog-intro">输入伙伴分享的邀请码，加入同一个游戏工程。</p><label class="dialog-field">邀请码<input id="inviteCode" required data-autofocus data-validation-message="请输入伙伴分享的邀请码。" autocomplete="off" placeholder="粘贴邀请码" value="${esc(typeof code==='string'?code:'')}"></label><div class="dialog-source"><strong>以 ${esc(user?.name)} 的身份加入</strong><p>加入后的权限由游戏拥有者设置。</p></div><p class="dialog-footnote">邀请码有效期为 24 小时，使用一次后失效。</p>`,[{label:'取消',action:()=>{clearInvite();closeModal();}},{label:'确认加入',primary:true,action:async()=>{if(!active()||user?.id!==owner)return;const value=$('#inviteCode').value.trim();if(!value)throw new Error('请输入邀请代码');if(lastCode!==null&&value!==lastCode)requestId=uuid();lastCode=value;const joined=await api.api('invites/join',{method:'POST',body:{code:value,request_id:requestId}});if(!active()||user?.id!==owner)return;await refreshPermissions();if(!active()||user?.id!==owner)return;clearInvite();closeModal();await navigateCatalog({projectId:joined.id});toast(`已加入 ${joined.name} · ${joined.role==='editor'?'可编辑':joined.role==='owner'?'拥有者':'只读'}`);}}]);
}
async function loadSessions(){
  if(!branch)return;const ctx=branchKey(),generation=branchLoadGeneration,result=await api.api(`${branchRoute()}/sessions`);if(ctx!==branchKey()||generation!==branchLoadGeneration)return;
  sessions=result.sessions.map(s=>reconcileSessionTitle(s,sessionTitleConfirmations.get(s.id)));renderSessions();renderInspector();
  if(!sessions.some(s=>s.id===selectedSessionId))selectedSessionId=sessions.find(ownSession)?.id??sessions[0]?.id??null;
  if(selectedSessionId)await selectSession(selectedSessionId);else{sessionData=null;renderComposer();}
}
function agentListCard(s,signal){
  const state=agentListStatus(signal),at=sessionActivityAt(s),elapsed=Math.max(0,Date.now()-at);
  const activity=!at?'':elapsed<60000?'刚刚':elapsed<3600000?`${Math.floor(elapsed/60000)} 分钟前`:elapsed<86400000?`${Math.floor(elapsed/3600000)} 小时前`:`${new Date(at).getMonth()+1}/${new Date(at).getDate()}`;
  const owner=ownSession(s)?'我':project?.members.find(m=>m.id===s.owner_user_id)?.name??'协作者';
  return `${robotAvatar(s)}<span class="agent-roster-copy"><strong title="${esc(s.title)}">${esc(s.title)}</strong><small>${esc(owner)} · ${s.visibility==='private'?'私有':'公开'}${(draftCache.get(s.id)??s.draft)?' · 有草稿':''}</small></span><span class="agent-roster-trailing"><span class="agent-state ${state.key}" title="${esc(state.detail)}">${esc(state.label)}</span><small title="${at?'最近活跃：'+esc(new Date(at).toLocaleString('zh-CN')):''}">${activity}</small></span>`;
}
function renderSessions(){
  if(!branch)return;$('#sessionUser').innerHTML='<option value="mine">我的会话</option><option value="shared">协作者公开的会话</option>';$('#sessionUser').value=sessionFilter;
  const query=$('#sessionSearch').value.trim().toLowerCase(),list=sessions.map(s=>{const cached=agentRoster.entries.get(s.id)?.session,current=sessionData?.id===s.id?sessionData:null;return {...s,last_activity_at:Math.max(sessionActivityAt(s),sessionActivityAt(cached),sessionActivityAt(current))};}).filter(s=>(sessionFilter==='mine'?ownSession(s):!ownSession(s)&&s.visibility==='shared')&&s.title.toLowerCase().includes(query)).sort(compareSessionActivity);
  const html=list.length?list.map(s=>`<button type="button" class="session-row agent-roster-row ${s.id===selectedSessionId?'active':''}" data-session="${esc(s.id)}" aria-label="${esc(s.title)}，${esc(agentListStatus(avatarSignals.get(s.id)).label)}" ${s.id===selectedSessionId?'aria-current="true"':''}>${agentListCard(s,avatarSignals.get(s.id))}</button>`).join(''):'<div class="empty-state">'+(query?'没有匹配的会话':sessionFilter==='mine'?'还没有会话，点击 + 开始。':'没有协作者公开的会话。')+'</div>';
  const host=$('#sessionList');if(host.dataset.renderKey!==html){const focus=host.contains(document.activeElement)?document.activeElement.dataset.session:null,scroll=host.scrollTop;host.innerHTML=html;host.dataset.renderKey=html;host.scrollTop=scroll;if(focus)Array.from(host.querySelectorAll('button[data-session]')).find(b=>b.dataset.session===focus)?.focus({preventScroll:true});}
  // The draft also carries data-session to pin its content; only list buttons navigate.
  $('#sessionList').querySelectorAll('button[data-session]').forEach(b=>b.onclick=()=>{sessionStartGate.acknowledge(sessionStartKey());selectSession(b.dataset.session).catch(report);});updateNewSessionControls();paintAgentAvatars();
}
async function selectSession(id){
  
  const generation=++sessionLoadGeneration,scope=branchKey();api.selectSessionBoundary(id);
  await flushDraft();if(generation!==sessionLoadGeneration||scope!==branchKey())return;selectedSessionId=id;sessionSelection.set(scope,id);sessionData=null;sessionEvents=[];sessionCursor=0;renderComposer();renderSessions();
  const data=await api.api(sessionRoute(id));if(generation!==sessionLoadGeneration||selectedSessionId!==id||scope!==branchKey())return;
  if(data.project_id!==project.id||data.branch_id!==branch.branch_id)throw new Error('会话归属与当前分支不同');
  sessionData=reconcileSessionTitle(data,sessionTitleConfirmations.get(data.id));attachTarget=ownSession(data)?id:attachTarget;
  const events=await api.api(`${sessionRoute(id)}/events?view=compact&after=0`);if(generation!==sessionLoadGeneration||scope!==branchKey()||selectedSessionId!==id)return;
  sessionEvents=events.events;sessionCursor=Math.max(0,...sessionEvents.map(e=>e.cursor??0));api.subscribeSession(id,sessionCursor);
  renderComposer();renderInspector();
  if(ownSession(sessionData)&&canWrite()&&recoveryNeeded())void reconcileRun({quiet:true});
}
async function refreshSession(){if(!selectedSessionId)return;const id=selectedSessionId,boundary=branchKey(),owner=user?.id,generation=sessionLoadGeneration,data=await api.api(sessionRoute(id));if(id!==selectedSessionId||branchKey()!==boundary||user?.id!==owner||sessionLoadGeneration!==generation)return;sessionData=reconcileSessionTitle(data,sessionTitleConfirmations.get(data.id));const index=sessions.findIndex(s=>s.id===id);if(index>=0)sessions[index]={...sessions[index],...sessionData};renderSessions();renderComposer();}
const sessionStartKey=()=>user&&branch?`${user.id}/${branchKey()}`:null;
function updateNewSessionControls(){const busy=sessionStartGate.pending.has(sessionStartKey());for(const id of ['topbarQuickSession','quickNewSession','topbarNewSession','newSession']){const button=$('#'+id);button.disabled=!canWrite()||busy;button.setAttribute('aria-busy',String(busy));button.title=busy?'正在新建会话…':'新建会话';}}
function closeSessionPicker(restore=false){$('#chatSessions').hidden=true;$('#toggleSessions').setAttribute('aria-expanded','false');if(restore)$('#toggleSessions').focus();}
function openSessionPicker(){if(!branch)return;$('#chatSettings').open=false;$('#chatSessions').hidden=false;$('#toggleSessions').setAttribute('aria-expanded','true');renderSessions();$('#sessionSearch').focus();}
function newSession({forceNew=false,authoringAction=null}={}){
  if(!branch||!canWrite())return Promise.resolve();
  const ctx={user_id:user.id,project_id:project.id,branch_id:branch.branch_id,generation:branchLoadGeneration,navigation:sessionLoadGeneration},startKey=sessionStartKey();
  const current=()=>user?.id===ctx.user_id&&branchKey()===`${ctx.project_id}/${ctx.branch_id}`&&branchLoadGeneration===ctx.generation;
  closeTopbarMenu(false);closeSessionPicker();
  if(!forceNew&&reusableNewSession(sessionData,ctx,draftCache.get(selectedSessionId)??sessionData?.draft)&&!pendingSubmission()&&!attachmentWrites.has(selectedSessionId)&&!settingsWrites.has(selectedSessionId)){openChat(true);return Promise.resolve(sessionData);}
  const job=sessionStartGate.run(startKey,async()=>{
    await flushDraft();if(!current()||ctx.navigation!==sessionLoadGeneration)return;
    let created=await api.api(`${branchRoute(ctx.project_id,ctx.branch_id)}/sessions`,{method:'POST',body:{...(!authoringAction?{title:'新会话'}:{authoring_action:authoringAction}),visibility:'shared',model:agentStatus?.default_model??null}});
    // Keep freshly created sessions public while an older service finishes active runs.
    if(created.visibility==='private'&&user?.id===ctx.user_id){
      try{created=await api.api(sessionRoute(created.id),{method:'PATCH',body:{visibility:'shared'}});}
      catch(error){error.uncertain=true;throw error;}
    }
    if(!current())return created;
    if(!sessions.some(s=>s.id===created.id))sessions.push(created);scheduleRosterRefresh();renderSessions();
    if(ctx.navigation!==sessionLoadGeneration)return created;
    sessionFilter='mine';await selectSession(created.id);
    if(current()&&sessionData?.id===created.id){openChat(true);chatFocus=$('#agentsMenuButton');}
    return created;
  });
  updateNewSessionControls();
  return job.catch(error=>{report(error);if(current()&&error.uncertain){openChat(false);openSessionPicker();}}).finally(()=>{if(current())updateNewSessionControls();});
}
function renameSessionTitle(id,title,{automatic=false,session=sessionData}={}){
  if(!session||session.id!==id||!ownSession(session)||sessionTitleWrites.has(id))return;
  if(!session.executor_thread_id&&pendingTurnSubmissions.has(id))return;
  const value=String(title).trim();if(!value||value===session.title)return;
  const owner=user.id,scope=`${session.project_id}/${session.branch_id}`,generation=sessionLoadGeneration;
  const job=api.api(sessionRoute(id),{method:'PATCH',body:{title:value}}).then(updated=>{
    if(user?.id!==owner)return;
    sessionTitleConfirmations.set(id,{title:updated.title,updated_at:updated.updated_at??Date.now()});
    if(branchKey()!==scope)return;
    const summary=sessions.find(s=>s.id===id);if(summary)summary.title=updated.title;
    if(id===selectedSessionId&&sessionData&&generation===sessionLoadGeneration){sessionData.title=updated.title;$('#sessionTitle').textContent=updated.title;$('#sessionName').value=updated.title;$('#toggleSessions').title=`${updated.title} · 点击切换会话`;$('#toggleSessions').setAttribute('aria-label',`切换会话：${updated.title}`);}
    scheduleRosterRefresh();renderSessions();
  }).catch(error=>{if(user?.id===owner&&branchKey()===scope)toast(automatic?'会话名称暂未保存，可稍后在设置中修改。':errorText(error));}).finally(()=>{sessionTitleWrites.delete(id);if(id===selectedSessionId)$('#sessionName').disabled=!ownSession(sessionData);});
  sessionTitleWrites.set(id,job);if(id===selectedSessionId)$('#sessionName').disabled=true;return job;
}
function latestRun(){return sessionData?.runs?.slice().sort((a,b)=>b.created_at-a.created_at)[0];}
function cleanupBlocked(){return (sessionData?.runs??[]).find(r=>(r.cancel_requested_at||r.cleanup_status||['interrupted','cancelling'].includes(r.status))&&r.cleanup_status!=='verified');}
function cleanupLabel(){const run=cleanupBlocked();return run?(run.cleanup_status==='pending'?'正在停止后台命令':'停止结果待核对'):'';}
function recoveryNeeded(){return latestRun()?.status==='uncertain'||Boolean(cleanupBlocked());}
function renderSessionRecovery(){
  const sid=selectedSessionId,busy=sessionRecoveries.has(sid),needed=recoveryNeeded(),error=sessionRecoveryErrors.get(sid);
  $('#sessionRecovery').hidden=!ownSession(sessionData)||!(needed||busy||error);
  $('#sessionRecoveryText').textContent=busy?'正在恢复会话状态…':error||'连接中断后需要恢复会话；草稿和历史已保留。';
  $('#recoverSession').textContent=busy?'恢复中…':'恢复会话';
  $('#recoverSession').disabled=busy||!canWrite();
}
function runBusy(){return !!pendingSubmission()||!!cleanupBlocked()||['starting','running','cancelling','uncertain'].includes(latestRun()?.status);}
function runLabel(status,run=null){if(run?.execution_mode==='goal'){const state=run.executor_goal?.status;return state?({active:'目标持续执行中',complete:'目标已完成',blocked:'目标遇到阻碍',paused:'目标已暂停',budget_limited:'目标已达到预算限制',usage_limited:'目标等待额度恢复'}[state]??'目标状态：'+state):'正在建立持续目标';}if(run?.execution_mode==='plan'&&status==='completed')return '设计计划已生成';return {starting:'正在启动',running:'执行中',cancelling:'等待中断确认',uncertain:'结果待核对',completed:'本轮执行结束',failed:'执行失败',interrupted:'已中断'}[status]||status||'尚未运行';}
function renderAgentStatus(){
  $('#agentStatus').textContent=agentStatus?.ready?`Codex · ${agentStatus.authenticated?'已连接':'待登录'}`:`Codex 未就绪${agentStatus?.error?' · '+agentStatus.error:''}`;
  const model=sessionData?.model??agentStatus?.default_model??'';
  $('#sessionModel').innerHTML=(agentStatus?.models??[]).map(m=>`<option value="${esc(m.model)}" title="${esc(m.description)}">${esc(m.displayName||m.model)}</option>`).join('');
  if(model&&!agentStatus?.models?.some(m=>m.model===model))$('#sessionModel').insertAdjacentHTML('afterbegin',`<option value="${esc(model)}">${esc(model)} · 已存模型 / 当前目录不可用</option>`);
  $('#sessionModel').value=model;$('#sessionModel').disabled=!canWrite()||!ownSession(sessionData)||runBusy()||settingsWrites.has(selectedSessionId);
  const options=reasoningOptions(agentStatus?.models?.find(m=>m.model===model)),effort=sessionData?.effort??'';
  $('#sessionEffort').innerHTML='<option value="">默认强度</option>'+options.map(o=>`<option value="${esc(o.value)}" title="${esc(o.description)}">${esc(effortLabel(o.value))} · 思考强度</option>`).join('');
  if(effort&&!options.some(o=>o.value===effort))$('#sessionEffort').insertAdjacentHTML('beforeend',`<option value="${esc(effort)}">${esc(effortLabel(effort))} · 当前不可用</option>`);
  $('#sessionAccess').value=sessionData?.access_mode??'workspace-write';
  $('#sessionAccess').disabled=$('#sessionModel').disabled||!accessFeatures;
  $('#sessionAccess').title=!accessFeatures?'执行权限选择将在服务更新后启用':$('#sessionAccess').value==='full-access'?'此会话允许本机文件与网络访问，命令无需审批':'在会话工作区内编辑，额外权限按需审批';
  $('#sessionAccess').closest('label').classList.toggle('is-full-access',$('#sessionAccess').value==='full-access');
  $('#sessionEffort').value=effort;$('#sessionEffort').disabled=$('#sessionModel').disabled||!options.length||!sessionFeatures;
  $('#sessionEffort').title=!sessionFeatures?'思考强度选择将在服务更新后启用':options.find(o=>o.value===effort)?.description||'使用所选模型支持的思考强度；默认由执行器决定';
}
function eventText(event){
  const p=event.params??{},item=p.item;
  if(event.kind==='run_state')return `运行状态：${runLabel(event.run.status)}${event.run.error?'\n'+JSON.stringify(event.run.error):''}`;
  if(event.kind==='verification_started')return `开始真实 Godot 验证 · ${event.resource_id??''} · ${event.revision??''}`;
  if(event.kind==='notification'){
    if(item)return JSON.stringify(item,null,2);
    if(event.method?.includes('Delta'))return p.delta??p.text??JSON.stringify(p);
    return JSON.stringify(p,null,2);
  }
  if(event.kind==='serverRequestReply'&&event.result?.answers){const request=sessionEvents.find(e=>e.request_key===event.requestKey),safe=copy(event);for(const q of request?.params?.questions??[])if(q.isSecret&&safe.result.answers[q.id])safe.result.answers[q.id]={answers:['••••••']};return JSON.stringify(safe,null,2);}
  return JSON.stringify(event,null,2);
}
function pendingApprovals(){
  const pending=new Map();for(const e of sessionEvents){
    if(e.kind==='approval_request')pending.set(e.request_key,e);
    if(e.kind==='serverRequestReply')pending.delete(e.requestKey);
    if(e.kind==='requests_reconciled')for(const key of pending.keys())if(!e.request_keys.includes(key))pending.delete(key);
    if(e.kind==='notification'&&e.method==='serverRequest/resolved'){
      const key=`${e.epoch}:${String(e.params?.requestId)}`,request=pending.get(key);
      if(request?.params?.threadId===e.params?.threadId)pending.delete(key);
    }
    if(e.kind==='notification'&&['thread/closed','thread/deleted'].includes(e.method))for(const[key,request]of pending)if(request.params?.threadId===e.params?.threadId)pending.delete(key);
    if(e.kind==='run_state'&&['completed','interrupted','failed'].includes(e.run.status)&&e.run.turn_id)for(const[key,request]of pending)if(request.params?.turnId===e.run.turn_id&&request.params?.threadId===e.run.thread_id)pending.delete(key);
  }return [...pending.values()];
}
function renderPropertyActionResult(run){
  const result=run?.authoring_result;if(!result?.source_saved)return '';
  const names=result.properties.map(p=>`${p.name}${p.change==='removed'?'（已移除）':p.binding_valid===false?'（绑定需修复）':''}`).join('、');
  return `<article class="property-action-result"><strong>属性改动已保存</strong><p>${esc(result.name)} · 预制件定义</p>${names?`<p>${esc(names)}</p>`:''}<small>保存版本 ${esc(short(result.revision))} · 重新开始试玩读取</small><button type="button" class="button small" data-property-result="${esc(run.id)}" ${mode!=='edit'?'disabled title="返回编辑后打开属性"':''}>打开属性</button></article>`;
}
async function openPropertyActionResult(runId){
  const session=sessionData,run=session?.runs?.find(r=>r.id===runId),result=run?.authoring_result;
  if(!result||session.project_id!==project?.id||session.branch_id!==branch?.branch_id)throw new Error('结果不属于当前分支');
  if(mode!=='edit')throw new Error('请先返回编辑，再打开属性');
  const scope=branchKey(),sid=session.id;
  const current=await api.api(branchRoute(session.project_id,session.branch_id));
  if(branchKey()!==scope||sessionData?.id!==sid)return;
  if(!current.manifest.resources[result.resource_id])throw new Error('该预制件已被删除，历史保存记录仍保留');
  acceptBranch(current);await openResource(result.resource_id);
  if(branchKey()!==scope||sessionData?.id!==sid||resourceId!==result.resource_id)return;
  inspectorTab='object';closeChat(false);showInspectorPanel();
  pendingPropertyResult={resource_id:result.resource_id,property_ids:result.properties.filter(p=>p.change!=='removed').map(p=>p.id)};
  renderInspector();
}
let pendingPropertyResult=null;
function renderConversation(){
  const host=$('#sessionConversation'),scroller=$('.composer-content');
  if(conversationRenderedSession){
    const state=chatDisclosures.get(conversationRenderedSession)??new Map();
    host.querySelectorAll('details[data-disclosure]').forEach(d=>state.set(d.dataset.disclosure,d.open));
    chatDisclosures.set(conversationRenderedSession,state);
  }
  const changed=conversationRenderedSession!==sessionData?.id,wasBottom=changed||scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<70,oldTop=scroller.scrollTop;
  conversationRenderedSession=sessionData?.id??null;
  if(!sessionData){host.innerHTML='<div class="empty-state chat-welcome"><strong class="chat-empty-title">想创造什么？</strong>点击右上角 +，开始一段新会话。<br>场景、模型和玩法，都可以从一句话开始。</div>';conversationHTML='';return;}
  const messages=[...(sessionData.messages??[])],known=new Set(messages.map(m=>m.executor_item_id).filter(Boolean)),deltas=new Map();
  for(const e of sessionEvents){
    if(e.kind!=='notification')continue;const p=e.params??{},run=sessionData.runs?.find(r=>(r.turn_id===p.turnId||r.turn_ids?.includes(p.turnId))&&(!p.threadId||r.thread_id===p.threadId));
    if(['item/agentMessage/delta','item/plan/delta'].includes(e.method))deltas.set(p.itemId,{content:(deltas.get(p.itemId)?.content??'')+(p.delta??''),content_type:e.method==='item/plan/delta'?'plan':'text',run_id:run?.id});
    if(e.method==='item/completed'&&['agentMessage','plan'].includes(p.item?.type)){
      deltas.delete(p.item.id);if(!known.has(p.item.id)){known.add(p.item.id);messages.push({role:'assistant',content:p.item.text,content_type:p.item.type==='plan'?'plan':'text',executor_item_id:p.item.id,run_id:run?.id});}
    }
  }
  for(const[id,m]of deltas)if(!known.has(id))messages.push({...m,role:'assistant',executor_item_id:id,streaming:true});
  const attachmentById=new Map(),messageCopies=[];
  const renderMessage=m=>{
    const index=messageCopies.push(expandReferenceText(m.content,m.attachments??[]))-1;
    const inline=new Set(referenceIds(m.content));const attachments=(m.attachments??[]).filter(a=>!inline.has(a.id)).map(a=>referenceChip(a)).join('');
    return `<article class="agent-message ${m.role==='user'?'user-message':''} ${m.streaming?'streaming':''}"><strong>${m.automatic_resume?'服务器 · 自动续跑':m.role==='user'?esc(project.members.find(x=>x.id===sessionData.owner_user_id)?.name||'你'):m.content_type==='plan'?(m.streaming?'Codex · 正在规划':'Codex · 设计计划'):m.streaming?'Codex · 正在回复':'Codex'}</strong><div class="message-text">${renderReferenceContent(m.content,m.attachments??[],m.role==='user'?esc:renderMarkdown)}</div>${attachments?`<div class="sent-attachments">${attachments}</div>`:''}${m.role!=='user'&&!m.streaming?`<div class="message-actions"><button type="button" data-copy-message="${index}" aria-label="复制这条回复">复制回复</button></div>`:''}</article>`;
  };
  const calls=collectToolCalls(sessionEvents),usedCalls=new Set(),groups=[];
  for(const m of messages){if(m.role==='user'||!groups.length)groups.push([]);groups.at(-1).push(m);}
  let html=groups.map((group,index)=>{
    const userMessage=group.find(m=>m.role==='user'),answers=group.filter(m=>m.role!=='user'),last=answers.at(-1),prior=answers.slice(0,-1),run=sessionData.runs?.find(r=>r.id===(userMessage?.run_id??last?.run_id));
    const tools=calls.filter(c=>run&&(c.turnId===run.turn_id||run.turn_ids?.includes(c.turnId)));tools.forEach(c=>usedCalls.add(c.key));
    return (userMessage?renderMessage(userMessage):'')+(prior.length?`<details class="progress-group" data-disclosure="progress:${esc(userMessage?.id??run?.id??index)}"><summary>过程更新<span class="tool-count">${prior.length} 条</span></summary>${prior.map(renderMessage).join('')}</details>`:'')+renderToolCalls(tools,`tools:${run?.id??index}`)+(last?renderMessage(last):'')+renderPropertyActionResult(run);
  }).join('');
  html+=renderToolCalls(calls.filter(c=>!usedCalls.has(c.key)),'tools:unassigned');
  if(!messages.length&&!calls.length)html=sessionData?.authoring_action?.type==='expose_properties'?`<div class="empty-state chat-welcome"><strong class="chat-empty-title">为${esc(sessionData.authoring_action.name)}添加可调属性</strong>描述你希望调整的能力。Agent 会查看现有实现，公开参数，并保留已有取值。</div>`:'<div class="empty-state chat-welcome"><strong class="chat-empty-title">从一个想法开始</strong>描述你想要的场景、模型或玩法。<br>会话名称会从第一条消息自动生成。</div>';
  if(latestRun())html+=`<div class="run-status ${runBusy()?'is-running':''} ${latestRun()?.status==='failed'||cleanupBlocked()?.cleanup_status==='uncertain'?'error-text':''}" data-cleanup-status="${esc(cleanupBlocked()?.cleanup_status??'')}">${esc(cleanupLabel()||runLabel(latestRun()?.status,latestRun()))}</div>`;
  html+=pendingApprovals().filter(e=>e.method!=='item/tool/requestUserInput').map(e=>`<article class="approval-card"><strong>${e.category==='input'?'需要你的回答':'需要你的批准'}</strong><small>${esc(e.method)}</small><p>${esc(e.params?.questions?.[0]?.question||e.params?.message||'查看请求内容后，选择如何继续。')}</p>${ownSession(sessionData)?`<button class="button amber" data-request="${esc(e.request_key)}">查看并答复</button>`:'<small>仅会话所有者可答复</small>'}</article>`).join('');
  if(html!==conversationHTML||changed){
    const focused=document.activeElement?.closest('details[data-disclosure]')?.dataset.disclosure;
    host.innerHTML=html;conversationHTML=html;
    const state=chatDisclosures.get(sessionData.id)??new Map();
    host.querySelectorAll('details[data-disclosure]').forEach(d=>{d.open=state.get(d.dataset.disclosure)??false;if(focused===d.dataset.disclosure)d.querySelector('summary')?.focus({preventScroll:true});});
    host.querySelectorAll('[data-request]').forEach(b=>b.onclick=()=>showRequest(pendingApprovals().find(r=>r.request_key===b.dataset.request)));
    host.querySelectorAll('[data-sent-attachment]').forEach(b=>b.onclick=()=>showAttachment(attachmentById.get(b.dataset.sentAttachment)));
    host.querySelectorAll('[data-event-detail]').forEach(b=>b.onclick=async()=>{const sid=sessionData?.id;if(!sid)return;b.disabled=true;try{const {blob}=await api.download(`${sessionRoute(sid)}/events/${encodeURIComponent(b.dataset.eventDetail)}`);const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`tool-event-${b.dataset.eventDetail}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(error){report(error);}finally{b.disabled=false;}});
    host.querySelectorAll('[data-copy-message]').forEach(b=>b.onclick=()=>copyChatText(messageCopies[Number(b.dataset.copyMessage)],b));
    host.querySelectorAll('[data-property-result]').forEach(b=>b.onclick=()=>openPropertyActionResult(b.dataset.propertyResult).catch(report));
    host.querySelectorAll('[data-copy-code]').forEach(b=>b.onclick=()=>copyChatText(b.closest('.chat-code').querySelector('pre code').textContent,b));
    scroller.scrollTop=wasBottom?scroller.scrollHeight:oldTop;
  }
  updateChatScroll();
}
function renderQuestions(){
  const host=$('#sessionQuestions'),sid=sessionData?.id,own=ownSession(sessionData)&&canWrite();
  const requests=pendingApprovals().filter(e=>e.method==='item/tool/requestUserInput');
  const requestByKey=new Map(sessionEvents.filter(e=>e.kind==='approval_request'&&e.method==='item/tool/requestUserInput').map(e=>[e.request_key,e]));
  const replies=new Map(sessionEvents.filter(e=>e.kind==='serverRequestReply'&&requestByKey.has(e.requestKey)&&e.result?.answers).map(e=>[e.requestKey,e]));
  const signature=JSON.stringify([sid,own,requests.map(r=>r.request_key),[...replies.keys()]]);
  if(signature===questionHTMLKey)return;
  const scroller=$('.composer-content'),follow=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<90;
  questionHTMLKey=signature;
  host.innerHTML=[...replies].map(([key,e])=>`<details class="answered-questions"><summary>${icon('check')}已回答 · ${Object.keys(e.result.answers).length} 个问题</summary>${(requestByKey.get(key).params.questions??[]).map(q=>`<p><strong>${esc(q.question)}</strong><span>${esc(q.isSecret?'••••••':e.result.answers[q.id]?.answers.join('；')??'')}</span></p>`).join('')}</details>`).join('')+requests.map((r,index)=>{
    const draftKey=`${sid}:${r.request_key}`,state=questionDrafts.get(draftKey)??{answers:{},error:'',index:0};questionDrafts.set(draftKey,state);state.index=Math.min(state.index??0,r.params.questions.length-1);
    return `<form class="question-card" data-question-request="${esc(r.request_key)}"><div class="question-card-heading">${icon('chat')}<strong>需要你的回答</strong><span>${state.index+1} / ${r.params.questions.length}</span></div>${r.params.questions.map((q,i)=>{
      const options=q.options??[];if(!state.answers[q.id])state.answers[q.id]={option:options.length?0:'custom',text:''};const answer=state.answers[q.id],custom=!options.length||q.isOther===true;
      return `<fieldset data-question-id="${esc(q.id)}" ${i!==state.index?'hidden':''}><legend><span>${i+1}</span>${esc(q.question)}</legend>${options.map((o,j)=>`<label class="question-option"><input type="radio" name="question-${index}-${i}" value="${j}" ${answer.option===j?'checked':''} ${!own?'disabled':''}><span class="option-number" aria-hidden="true">${j+1}</span><span><strong>${esc(o.label.replace(/\s*[（(](?:Recommended|推荐)[)）]$/i,''))}</strong>${/[（(](?:Recommended|推荐)[)）]$/i.test(o.label)?'<span class="question-recommended">推荐</span>':''}${o.description?`<small>${esc(o.description)}</small>`:''}</span></label>`).join('')}${custom?`<label class="question-custom">${options.length?`<span><input type="radio" name="question-${index}-${i}" value="custom" ${answer.option==='custom'?'checked':''} ${!own?'disabled':''}>其他想法</span>`:'<span class="sr">你的答案</span>'}${q.isSecret?`<input type="password" data-question-text autocomplete="off" maxlength="10000" placeholder="输入你的答案" value="${esc(answer.text??'')}" ${!own?'disabled':''}>`:`<textarea data-question-text rows="2" maxlength="10000" placeholder="${options.length?'或写下你的想法…':'输入你的答案…'}" ${!own?'disabled':''}>${esc(answer.text??'')}</textarea>`}</label>`:''}</fieldset>`;
    }).join('')}<p class="question-error" role="alert">${esc(state.error)}</p><div class="question-footer"><small>${own?'选择后继续 · 最后统一提交':'等待会话所有者回答'}</small>${own?'<button type="button" class="question-back">上一题</button><button type="submit" class="question-submit">下一题 →</button>':''}</div></form>`;
  }).join('');
  host.querySelectorAll('[data-question-request]').forEach(form=>{
    const key=form.dataset.questionRequest,request=requests.find(r=>r.request_key===key),draftKey=`${sid}:${key}`,state=questionDrafts.get(draftKey);
    const valid=q=>{const a=state.answers[q.id];return a&&(typeof a.option==='number'||a.text?.trim());};
    const refresh=()=>{const writing=questionWrites.has(draftKey),last=state.index===request.params.questions.length-1,button=form.querySelector('[type=submit]'),back=form.querySelector('.question-back');
      form.querySelectorAll('fieldset').forEach((field,i)=>field.hidden=i!==state.index);
      form.querySelector('.question-card-heading>span').textContent=`${state.index+1} / ${request.params.questions.length}`;
      if(back){back.hidden=state.index===0;back.disabled=writing;}
      if(button){button.disabled=writing||!(last?request.params.questions.every(valid):valid(request.params.questions[state.index]));button.textContent=writing?'正在提交…':last?'提交答案 ↑':'下一题 →';}
      if(writing)form.querySelectorAll('input,textarea').forEach(el=>el.disabled=true);
    };
    const back=form.querySelector('.question-back');if(back)back.onclick=()=>{if(!questionWrites.has(draftKey)&&state.index>0){state.index--;refresh();form.querySelector('fieldset:not([hidden]) input,fieldset:not([hidden]) textarea')?.focus();}};
    form.querySelectorAll('fieldset').forEach(field=>{
      const id=field.dataset.questionId;
      field.querySelectorAll('[type=radio]').forEach(input=>input.onchange=()=>{state.answers[id]={...state.answers[id],option:input.value==='custom'?'custom':Number(input.value)};state.error='';form.querySelector('[role=alert]').textContent='';refresh();});
      const text=field.querySelector('[data-question-text]');if(text)text.oninput=()=>{state.answers[id]={...state.answers[id],option:'custom',text:text.value};const radio=field.querySelector('[value=custom]');if(radio)radio.checked=true;state.error='';form.querySelector('[role=alert]').textContent='';refresh();};
    });
    form.onsubmit=async event=>{
      event.preventDefault();if(questionWrites.has(draftKey)||!own||sessionData?.id!==sid||!pendingApprovals().some(r=>r.request_key===key))return;
      if(state.index<request.params.questions.length-1){if(valid(request.params.questions[state.index])){state.index++;refresh();form.querySelector('fieldset:not([hidden]) input,fieldset:not([hidden]) textarea')?.focus();}return;}
      const generation=sessionLoadGeneration;
      const answers=Object.create(null);
      for(const q of request.params.questions){const a=state.answers[q.id],value=typeof a?.option==='number'?q.options?.[a.option]?.label:a?.text?.trim();if(!value)return;answers[q.id]={answers:[value]};}
      questionWrites.add(draftKey);form.querySelectorAll('input,textarea').forEach(el=>el.disabled=true);refresh();
      try{
        await api.api(`${sessionRoute(sid)}/requests/${encodeURIComponent(key)}`,{method:'POST',body:{result:{answers}}});
        questionDrafts.delete(draftKey);
        if(sessionData?.id===sid&&generation===sessionLoadGeneration){sessionEvents.push({kind:'serverRequestReply',requestKey:key,result:{answers}});questionHTMLKey=null;renderComposer();}
      }catch(error){state.error=error.message;if(sessionData?.id===sid&&generation===sessionLoadGeneration){form.querySelector('[role=alert]').textContent=error.message;form.querySelectorAll('input,textarea').forEach(el=>el.disabled=false);}}
      finally{questionWrites.delete(draftKey);if(form.isConnected)refresh();}
    };refresh();
  });
  const first=host.querySelector('.question-card');if(follow&&first)scroller.scrollTop+=first.getBoundingClientRect().top-scroller.getBoundingClientRect().top-12;
  updateChatScroll();
}

async function copyChatText(text,button){
  try{await navigator.clipboard.writeText(text);const label=button.textContent;button.textContent='已复制';setTimeout(()=>{if(button.isConnected)button.textContent=label;},1400);}catch{toast('复制失败，请选中文字后复制。');}
}
function updateChatScroll(){const scroller=$('.composer-content');$('#jumpLatest').hidden=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<90;}
function resizeDraft(){const field=$('#sessionDraft');field.style.height='auto';field.style.height=Math.min(210,Math.max(72,field.scrollHeight))+'px';}
function updateSendButton(){
  $('#sendDraft').disabled=!canWrite()||!ownSession(sessionData)||runBusy()||!agentStatus?.ready||(!$('#sessionDraft').value.trim()&&!sessionData?.draft_attachments?.some(a=>a.kind==='image'))||settingsWrites.has(selectedSessionId)||attachmentWrites.has(selectedSessionId)||semanticComposerPending||semanticPreparingDraft;
}
// BEGIN SEMANTIC AUTHORING HOST — existing API, source heads and session attachments.
function semanticModeForSession(session=sessionData){
  const saved=['plan','goal'].includes(session?.execution_mode)?session.execution_mode:'normal';
  const value=settingsWrites.has(session?.id)?semanticModes.get(session.id)??saved:saved;
  if(session?.id)semanticModes.set(session.id,value);
  return value;
}
function semanticViewScope(){
  const scene=mode==='inspect'?frozenScene:mode==='play'?displayedPlayScene():null;
  return {project_id:project?.id,branch_id:branch?.branch_id,resource_id:scene?.resource_id??resourceId,revision:scene?.scene_revision??branch?.head};
}
function semanticComposerContext(){
  const scope=semanticViewScope(),objects=mode==='edit'?docObjects():mode==='inspect'?frozenScene?.objects??[]:displayedPlayScene()?.objects??[];
  return {...scope,key:[user?.id,scope.project_id,scope.branch_id,selectedSessionId,scope.resource_id,mode].join('/'),user_id:user?.id,sessionId:selectedSessionId,
    sessionGeneration:sessionLoadGeneration,objects,selectedObjects:selectedSemanticObjects(),prefabs:Object.values(branch?.manifest.resources??{}).filter(r=>r.kind==='prefab'),
    mode:semanticModeForSession(),readOnly:!branch||!canWrite()||!ownSession(sessionData)||Boolean(pendingSubmission())||settingsWrites.has(selectedSessionId),
    viewMode:mode,schema:branch?.manifest.schema,viewKey:viewedDocumentKey(),camera:fixedAnnotationCamera(annotationView,{documentId:viewedDocumentKey(),seq:mainPreview?.seq,mode,revision:scope.revision}),
    inspection:mode==='inspect'&&world?.session_kind!=='local_preview'?copy(inspectionRecord):null,world:world?{world_id:world.world_id,epoch:world.epoch,session_kind:world.session_kind}:null,references:[],
  };
}
function assertSemanticSession(captured){
  const current=semanticComposerContext();
  if(!captured||captured.key!==current.key||captured.user_id!==user?.id||captured.sessionGeneration!==sessionLoadGeneration||current.readOnly)throw new Error('会话、目标或权限已变化，请重新选择引用');
  if(modePending)throw new Error('请等待视口模式切换完成');
  if(attachmentWrites.has(captured.sessionId)||pendingTurnSubmissions.has(captured.sessionId))throw new Error('请等待当前附件或消息提交完成');
}
async function addSemanticReference(selection,captured=semanticComposerContext(),role='reference'){
  assertSemanticSession(captured);const sid=captured.sessionId,added=[];
  const job=(async()=>{
    if(['object','object-group'].includes(selection.kind)){
      if(captured.viewMode==='play')throw new Error('先暂停观察，再固定这一局中的对象');
      if(captured.viewMode==='edit'&&(localEdit||drag||localCommitPending))throw new Error('请先完成当前空间调整再添加引用');
      const targets=selection.kind==='object-group'?selection.items:[selection.item];
      for(const target of targets){
        const now=semanticComposerContext();if(now.key!==captured.key||now.sessionGeneration!==captured.sessionGeneration)throw new Error('会话已切换，剩余对象未加入旧会话');
        const fixedContext={projectId:captured.project_id,branchId:captured.branch_id,resourceId:captured.resource_id,base:captured.revision,key:captured.viewKey,schema:target.address?'creation-hierarchy-2':'creation-flat-1'};
        let route='attachments',body={...fixedSourceAttachment(target,fixedContext),camera:captured.camera};
        if(captured.inspection){route='inspection-attachments';body={inspection_id:captured.inspection.inspection_id,world_id:captured.world.world_id,epoch:captured.world.epoch,sequence:captured.inspection.sequence,resource_id:captured.resource_id,...(target.address?{address:copy(target.address)}:{object_id:target.id}),expected_version:target.object_version??target.version,camera:captured.camera};}
        added.push(await api.api(`${sessionRoute(sid)}/${route}`,{method:'POST',body}));
      }
    }else{
      const body={kind:selection.kind,project_id:captured.project_id,branch_id:captured.branch_id,revision:selection.revision??captured.revision,role,
        ...(selection.kind==='prefab'?{resource_id:selection.item.id}:{knowledge_id:selection.item.id})};
      added.push(await api.api(`${sessionRoute(sid)}/semantic-attachments`,{method:'POST',body}));
    }
  })();
  attachmentWrites.set(sid,job);renderComposer();
  try{await job;return added;}
  finally{
    if(attachmentWrites.get(sid)===job)attachmentWrites.delete(sid);
    if(selectedSessionId===sid&&branchKey()===`${captured.project_id}/${captured.branch_id}`){await refreshSession();renderComposer();}
  }
}
async function prepareSemanticDraftForSend(){
  const field=$('#sessionDraft'),original=field.value,captured=semanticComposerContext(),tokens=unresolvedComposerReferences(original);
  const ambiguous=tokens.find(token=>token.kind!=='knowledge');
  if(ambiguous){field.focus();field.setSelectionRange(ambiguous.end,ambiguous.end);field.dispatchEvent(new Event('click'));throw new Error(`请先从 ${ambiguous.trigger} 列表选择具体${ambiguous.kind==='object'?'对象':'预制件'}，确保 Agent 收到准确引用`);}
  if(!tokens.length)return;
  if(tokens.some(token=>!token.query.trim()))throw new Error('请在 $$ 后输入知识关键词');
  const alive=()=>{const now=semanticComposerContext();if(now.key!==captured.key||now.sessionGeneration!==captured.sessionGeneration||now.readOnly)throw new Error('会话已切换，未发送原草稿');};
  semanticPreparingDraft=true;updateSendButton();
  try{
    const queries=[...new Set(tokens.map(token=>token.query))];
    const matches=await Promise.all(queries.map(query=>api.api(`${branchRoute(captured.project_id,captured.branch_id)}/knowledge?revision=${encodeURIComponent(captured.revision)}&q=${encodeURIComponent(query)}`)));
    alive();if(field.value!==original)throw new Error('草稿在知识检索期间发生变化，请核对后重新发送');
    const refs=new Map();
    for(const [index,result] of matches.entries()){
      if(result.revision!==captured.revision)throw new Error('知识索引版本不匹配，请重新检索');
      if(!result.items?.length)throw new Error(`没有找到“${queries[index]}”相关知识，请调整关键词或移除 $$ 标记`);
      for(const item of result.items.slice(0,queries.length===1?3:1))refs.set(item.id,{item,revision:result.revision});
    }
    for(const reference of refs.values()){
      alive();if(field.value!==original)throw new Error('草稿已变化，已固定的知识保留在附件中，请核对后发送');
      if(sessionData.draft_attachments?.some(a=>a.kind==='knowledge'&&a.knowledge_id===reference.item.id&&a.revision===reference.revision))continue;
      await addSemanticReference({kind:'knowledge',...reference},captured);
    }
    alive();if(field.value!==original)throw new Error('草稿已变化，已固定的知识保留在附件中，请核对后发送');
    let text=original;for(const token of [...tokens].reverse())text=text.slice(0,token.start)+(sessionData.draft_attachments??[]).filter(a=>a.kind==='knowledge'&&a.revision===captured.revision&&matches[queries.indexOf(token.query)]?.items.slice(0,queries.length===1?3:1).some(item=>item.id===a.knowledge_id)).map(referenceToken).join(' ')+text.slice(token.end);
    field.value=text;field.dispatchEvent(new Event('input',{bubbles:true}));
  }finally{semanticPreparingDraft=false;updateSendButton();}
}
function sessionReferences(){return [...(sessionData?.draft_attachments??[]),...(sessionData?.messages??[]).flatMap(m=>m.attachments??[])];}
function initializeSemanticAuthoring(){
  referenceEditor=createReferenceEditor({textarea:$('#sessionDraft'),getAttachments:()=>sessionData?.draft_attachments??[],onChange:()=>renderDraftReferences()});
  referenceInteractions=createReferenceInteractions({document,getAttachment:id=>sessionReferences().find(a=>a.id===id),onOpen:showAttachment,onRemove:(a,button)=>removeDraftAttachment(selectedSessionId,a.id,button).catch(report)});
  semanticComposer=createSemanticComposer({textarea:$('#sessionDraft'),mount:$('.input-shell'),getContext:semanticComposerContext,
    searchKnowledge:(query,captured,{signal})=>api.api(`${branchRoute(captured.project_id,captured.branch_id)}/knowledge?q=${encodeURIComponent(query)}&revision=${encodeURIComponent(captured.revision)}`,{signal}),
    onAddReference:addSemanticReference,onModeChange:(value,captured)=>{if(captured.sessionId===selectedSessionId&&captured.sessionGeneration===sessionLoadGeneration)return saveSessionSettings({execution_mode:value==='normal'?'default':value});},
    onPendingChange:value=>{semanticComposerPending=value;updateSendButton();},onError:report});
  $('#browseKnowledge').onclick=()=>openKnowledgeBrowser().catch(report);
  window.addEventListener('pagehide',()=>{semanticComposer?.destroy();semanticInspector?.destroy();referenceEditor?.destroy();referenceInteractions?.destroy();});
}
function assertSemanticModel(model){
  const scope=semanticViewScope();
  if(!editable()||scope.project_id!==model.project_id||scope.branch_id!==model.branch_id||scope.resource_id!==model.target.resource_id)throw new Error('设计目标或权限已变化，请返回原对象后再调整');
  if(branch.head!==model.revision)throw new Error('设计已有更新，已保留输入；请刷新并核对当前值');
  if(localEdit||drag||localCommitPending)throw new Error('请先完成当前空间调整');
}
async function saveSemanticMutation(action,model,extra){
  assertSemanticModel(model);const body=semanticMutationBody(action,model,extra,uuid());
  const result=await api.api(`${branchRoute(model.project_id,model.branch_id)}/semantic-resources`,{method:'POST',body});
  if(branchKey()===`${model.project_id}/${model.branch_id}`){acceptBranch(result.branch);renderInspector();}
  return result;
}
async function requestSemanticAgent(intent,model){
  if(requestSemanticAgent.pending)return requestSemanticAgent.pending;
  const pending=(async()=>{
  assertSemanticModel(model);const documentKey=key(),target=copy(model.target),resource=copy(model.resource);
  const propertyAction=intent.kind==='expose-property'&&model.aiPropertiesAvailable;
  const created=await newSession({forceNew:true,...(propertyAction?{authoringAction:{type:'expose_properties',resource_id:resource.id,revision:model.revision,expected_version:resource.version}}:{})});
  if(key()!==documentKey||!created||created.id!==selectedSessionId||sessionData?.id!==created.id||!ownSession(sessionData))throw new Error('会话或对象已切换，未向其他会话添加需求');
  assertSemanticModel(model);
  const captured=semanticComposerContext();
  if(propertyAction){
    if(created.authoring_action?.resource_id!==resource.id)throw new Error('专用属性会话未建立，请刷新工作台后重试');
    await addSemanticReference({kind:'prefab',item:resource,revision:model.revision},captured,'target');
  }else if(target.object_id||target.address){
    const source=docObjects().find(o=>target.address?o.address&&fullAddressKey(o.address)===fullAddressKey(target.address):o.id===target.object_id);
    if(!source)throw new Error('原对象已变化，请重新选择');
    await addSemanticReference({kind:'object',item:copy(source)},captured,'target');
  }else await addSemanticReference({kind:'prefab',item:resource,revision:model.revision},captured,'target');
  if(key()!==documentKey||selectedSessionId!==captured.sessionId)return;
  const draft=$('#sessionDraft'),previous=draft.value.trim();
  const description=model.draftDescription??model.description??resource.design?.description??'';
  const request=propertyAction?'':intent.kind==='expose-property'?`请为「${model.name}」增加可调属性。先查看它的功能与实际行为，把我需要微调的能力作为有名称、说明、单位和合适范围的属性公开；完成真实实现。\n我希望能调整：`:`请调整「${model.name}」的功能，完成实现。${description?`\n当前设计：${description}`:''}\n我希望改变：`;
  draft.value=(previous?previous+'\n\n':'')+request;draft.dispatchEvent(new Event('input',{bubbles:true}));openChat(true);draft.focus();draft.setSelectionRange(draft.value.length,draft.value.length);
  })();
  requestSemanticAgent.pending=pending;
  try{return await pending;}finally{if(requestSemanticAgent.pending===pending)delete requestSemanticAgent.pending;}
}
function mountSemanticInspector(){
  const host=$('#inspectorBody');if(!branch||inspectorTab!=='object')return;
  if(project?.role==='player'&&isNative())return;
  const scope=semanticViewScope(),source=branch.manifest.resources[scope.resource_id],selected=object();
  if(!source||source.kind!=='prefab'&&!selected)return;
  if(!semanticInspectorRoot){
    semanticInspectorRoot=document.createElement('div');semanticInspectorRoot.id='semanticInspector';
    semanticInspector=createSemanticInspector({root:semanticInspectorRoot,callbacks:{
      onSaveDescription:(description,model)=>saveSemanticMutation('update_design',model,{design:{...copy(model.resource.design),description}}),
      onParameterChange:(property,value,model)=>saveSemanticMutation('set_property',model,{property_id:property.id,value}),
      onRestoreDefault:(property,model)=>saveSemanticMutation('reset_property',model,{property_id:property.id}),
      onRenameInstance:renameSemanticInstance,onOpenDefinition:openInstanceDefinition,onRequestAgent:requestSemanticAgent,onError:report,
    }});
  }
  if(!host.contains(semanticInspectorRoot)){
    const advanced=document.createElement('details');advanced.className='semantic-spatial-editor';advanced.id='semanticSpatialEditor';
    const sectionKey=JSON.stringify([user?.id,scope.project_id,scope.branch_id,scope.resource_id,mode,selected?.id]);
    const summary=document.createElement('summary');summary.textContent=selected?.control_layout?'布局与变换':'空间与变换';advanced.open=inspectorSectionState.get(sectionKey)??true;advanced.append(summary);
    advanced.ontoggle=()=>{if(advanced.isConnected)inspectorSectionState.set(sectionKey,advanced.open);};
    for(const child of [...host.childNodes])advanced.append(child);
    host.append(semanticInspectorRoot,advanced);
    if(!selected||(!isNative()&&source.design?.category==='system'))advanced.hidden=true;
  }
  const query=new URLSearchParams({resource_id:scope.resource_id,revision:scope.revision});
  if((source.kind!=='prefab'||isNative())&&selected){if(selected.address)query.set('address',JSON.stringify(selected.address));else query.set('object_id',selected.id);}
  const cacheKey=`${scope.project_id}/${scope.branch_id}/${query}`,generation=++semanticInspectorGeneration;
  const current=()=>generation===semanticInspectorGeneration&&inspectorTab==='object'&&host.contains(semanticInspectorRoot)&&semanticViewScope().revision===scope.revision&&semanticViewScope().resource_id===scope.resource_id;
  const render=detail=>{
    if(!current())return;const advanced=host.querySelector(':scope > #semanticSpatialEditor')??host.querySelector('#semanticSpatialEditor');const multiple=selectedSemanticObjects().length;
    semanticInspector.render({...detail,name:source.kind==='prefab'&&(!isNative()||selected?.native_path==='.')?detail.resource.name:selected?.name??detail.resource.name,editable:editable(),descriptionEditable:!isNative(),includeSuppliedProperties:isNative(),aiPropertiesAvailable:aiPropertyActionsAvailable&&isNative()&&source.kind==='prefab'&&!detail.target.is_instance,
      ...(multiple>1&&source.kind!=='prefab'?{scopeLabel:`仅当前主要对象「${selected.name}」；已选 ${multiple} 个对象可一起引用到会话`}:{}),
      readOnlyReason:mode!=='edit'?'正在观察固定版本。返回编辑后可调整共享源稿。':!canWrite()?'当前可浏览与试玩；获得编辑权限后可修改。':null});
    if(advanced){if(detail.target.is_instance&&!isNative())advanced.querySelectorAll('.model-actions,[data-resource]').forEach(node=>node.remove());semanticInspectorRoot.querySelector('.semantic-parameters')?.before(advanced);}
    const actions=semanticInspectorRoot.querySelector('.semantic-quick-actions');if(actions){actions.id='semanticActionDock';$('#semanticActionDock')?.remove();($('#inspectorNameDock')??host.parentElement).append(actions);}
    if(pendingPropertyResult?.resource_id===scope.resource_id){
      const target=pendingPropertyResult;pendingPropertyResult=null;
      const parameters=semanticInspectorRoot.querySelector('.semantic-parameters');if(parameters)parameters.open=true;
      const row=[...semanticInspectorRoot.querySelectorAll('[data-property-id]')].find(row=>target.property_ids.includes(row.dataset.propertyId));
      (row??parameters)?.scrollIntoView({block:'nearest'});
      if(row){row.classList.add('property-result-focus');row.querySelector('input,select')?.focus({preventScroll:true});}
    }
  };
  if(semanticDetails.has(cacheKey)){render(semanticDetails.get(cacheKey));return;}
  semanticInspectorRoot.replaceChildren();const loading=document.createElement('p');loading.className='semantic-caption';loading.textContent='正在读取功能描述与可调属性…';semanticInspectorRoot.append(loading);
  api.api(`${branchRoute(scope.project_id,scope.branch_id)}/semantic-resources?${query}`).then(detail=>{
    if(detail.revision!==scope.revision)throw new Error('设计读取版本不匹配');if(!current())return;semanticDetails.set(cacheKey,detail);while(semanticDetails.size>40)semanticDetails.delete(semanticDetails.keys().next().value);render(detail);
  }).catch(error=>{if(current()){semanticInspectorRoot.replaceChildren();const note=document.createElement('p');note.className='semantic-readonly';note.textContent=`设计信息暂不可用：${errorText(error)}`;semanticInspectorRoot.append(note);}});
}
async function openKnowledgeBrowser(){
  if(!branch)return;const captured=semanticViewScope(),scopeKey=branchKey(),initialRevision=captured.revision;
  modal('游戏知识',`<p>浏览这个游戏的功能描述、系统规则与共享知识。选择内容可查看全文，或作为参考加入当前会话。</p><label>搜索知识<input id="semanticKnowledgeQuery" type="search" placeholder="例如：战斗、天气、存档…"></label><div id="semanticKnowledgeResults" class="semantic-knowledge-results" role="list" aria-label="知识结果"></div><p id="semanticKnowledgeStatus" role="status"></p>`,[{label:'返回',action:closeModal}]);
  const query=$('#semanticKnowledgeQuery'),results=$('#semanticKnowledgeResults'),status=$('#semanticKnowledgeStatus');let generation=0,timer;
  const search=async()=>{
    const run=++generation;status.textContent='正在读取知识…';
    try{
      const data=await api.api(`${branchRoute(captured.project_id,captured.branch_id)}/knowledge?revision=${encodeURIComponent(initialRevision)}&q=${encodeURIComponent(query.value.trim())}`);
      if(run!==generation||!query.isConnected||branchKey()!==scopeKey)return;
      status.textContent=`${data.total??data.items.length} 条相关内容`;results.replaceChildren();
      for(const item of data.items){const button=document.createElement('button');button.type='button';button.className='semantic-knowledge-row';button.setAttribute('role','listitem');const title=document.createElement('strong'),description=document.createElement('small');title.textContent=item.title;description.textContent=item.description||'查看全文';button.append(title,description);button.onclick=()=>showKnowledgeItem(item,data.revision,captured);results.append(button);}
    }catch(error){if(run===generation&&query.isConnected)status.textContent='知识读取失败：'+errorText(error);}
  };
  query.oninput=()=>{generation++;clearTimeout(timer);timer=setTimeout(search,180);};query.focus();await search();
}
function showKnowledgeItem(item,revision,scope){
  const sid=selectedSessionId,owner=user?.id,generation=sessionLoadGeneration;
  const current=()=>generation===sessionLoadGeneration&&active()&&sid===selectedSessionId&&owner===user?.id&&branchKey()===`${scope.project_id}/${scope.branch_id}`;
  const buttons=[{label:'返回知识列表',action:()=>openKnowledgeBrowser()}];
  if(item.resource_id)buttons.push({label:'打开相关设计',action:()=>{if(branchKey()!==`${scope.project_id}/${scope.branch_id}`)throw new Error('游戏分支已切换');closeModal();return openResource(item.resource_id);}});
  if(canWrite()&&ownSession(sessionData))buttons.push({label:'加入会话参考',primary:true,action:async()=>{if(!current())throw new Error('游戏分支或会话已切换');await addSemanticReference({kind:'knowledge',item,revision},semanticComposerContext(),'reference');if(!current())return;closeModal();openChat(true);}});
  const active=modal(item.title,`<div class="semantic-knowledge-content">${renderMarkdown(item.content||item.description||'暂无补充说明')}</div><p class="semantic-caption">固定于当前浏览版本 · ${esc(short(revision))}</p>`,buttons);
}
// END SEMANTIC AUTHORING HOST
function renderDraftReferences(){
  const s=sessionData,own=ownSession(s)&&canWrite(),inlineReferences=new Set(referenceIds($('#sessionDraft').value));
  $('#draftAttachments').innerHTML=(s?.draft_attachments??[]).filter(a=>!inlineReferences.has(a.id)).map(a=>referenceChip(a,{remove:own,disabled:Boolean(pendingSubmission()||attachmentWrites.has(s?.id)||!sessionFeatures)})).join('');
  hydrateImageAttachments();
}
function renderComposer(){
  updateNewSessionControls();
  renderTopbarAgents();
  const s=sessionData,own=ownSession(s)&&canWrite(),busy=runBusy();
  const action=s?.authoring_action,actionContext=$('#propertyActionContext');
  if(actionContext){actionContext.hidden=!action;actionContext.textContent=action?`AI 添加属性 · ${action.name} · 预制件定义`:'';}
  $('#sessionDraft').placeholder=action?'想增加什么可调能力？例如：攻击间隔、每次产出数量…':'描述你想创造的内容…';
  $('#sessionTitle').textContent=s?.title??(selectedSessionId?'正在加载…':'开始创作');$('#toggleSessions').title=s?`${s.title} · 点击切换会话`:'切换会话';$('#toggleSessions').setAttribute('aria-label',s?`切换会话：${s.title}`:'切换会话');if(document.activeElement!==$('#sessionName'))$('#sessionName').value=s?.title??'';$('#sessionName').disabled=!own||sessionTitleWrites.has(s?.id)||Boolean(pendingSubmission()&&!s?.executor_thread_id);
  $('#sessionPath').textContent=s?`${s.branch_id} / ${project.members.find(m=>m.id===s.owner_user_id)?.name||s.owner_user_id} / ${s.visibility==='private'?'私有':'公开'}`:'';
  $('#copyViewportAnnotations').hidden=!(s?.draft_attachments??[]).some(a=>a.kind==='viewport_annotation');
  $('#sessionId').value=s?.id===selectedSessionId?s.id:'';$('#copySessionId').disabled=!$('#sessionId').value;
  $('#sessionVisibility').value=s?.visibility??'shared';$('#sessionVisibility').disabled=!own;
  renderAgentStatus();renderConversation();renderQuestions();renderPendingSubmission();
  const draft=s?(draftCache.get(s.id)??s.draft??''):'';
  if(!referenceEditor?.focused()||$('#sessionDraft').dataset.session!==s?.id)$('#sessionDraft').value=draft;
  $('#sessionDraft').dataset.session=s?.id??'';$('#sessionDraft').disabled=!own;
  $('#interruptRun').hidden=!busy;$('#sendDraft').hidden=busy;$('#interruptRun').disabled=!own||!busy||!!cleanupBlocked()||!!pendingSubmission();
  $$('[data-action="reconcile"]').forEach(button=>button.disabled=!own||sessionRecoveries.has(s?.id));
  renderSessionRecovery();
  $('#attachSelection').disabled=!own||!object()||!!pendingSubmission()||attachmentWrites.has(selectedSessionId);$('#refreshSession').disabled=!s;
  $('#attachImage').disabled=!own||!!pendingSubmission()||attachmentWrites.has(selectedSessionId);
  $('#imageAttachmentInput').disabled=$('#attachImage').disabled;
  $('#attachSelection').title=object()?`添加批注：${object().name??object().id}`:'先在场景树或视口中选择对象，再添加批注';
  renderDraftReferences();
  $('#attachmentCount').textContent=(s?.draft_attachments?.length??0)+(s?.messages??[]).reduce((n,m)=>n+(m.attachments?.length??0),0);
  $('#draftStatus').textContent=cleanupLabel()||(attachmentWrites.has(s?.id)?'正在保存附件…':settingsWrites.has(s?.id)?'正在保存设置…':busy?'可以先写下一条想法':own?'草稿自动保存':'共享会话 · 只读');
  $('#toggleSessions').setAttribute('aria-expanded',String(!$('#chatSessions').hidden));
  resizeDraft();updateSendButton();referenceEditor?.refresh();referenceInteractions?.refresh();semanticComposer?.refresh();hydrateImageAttachments();
}
async function removeDraftAttachment(sid,attachmentId,button){
  if(attachmentWrites.has(sid))return;
  button.disabled=true;
  const generation=sessionLoadGeneration,scope=branchKey();
  const write=api.api(`${sessionRoute(sid)}/attachments/${encodeURIComponent(attachmentId)}`,{method:'DELETE'});
  attachmentWrites.set(sid,write);renderComposer();
  try{const updated=await write;if(sid===selectedSessionId&&sessionData?.id===sid&&generation===sessionLoadGeneration&&scope===branchKey()){sessionData.draft_attachments=updated.draft_attachments;const field=$('#sessionDraft');field.value=field.value.split(referenceToken(attachmentId)).join('');field.dispatchEvent(new Event('input',{bubbles:true}));renderComposer();$('#sessionDraft').focus();}toast('已从草稿移除批注。');}
  finally{if(attachmentWrites.get(sid)===write)attachmentWrites.delete(sid);if(sid===selectedSessionId)renderComposer();if(button.isConnected)button.disabled=false;}
}
async function saveSessionSettings(patch){
  const sid=selectedSessionId;if(!canWrite()||!ownSession(sessionData))return;
  const generation=sessionLoadGeneration,scope=branchKey(),owner=user?.id,current=()=>sid===selectedSessionId&&sessionData?.id===sid&&generation===sessionLoadGeneration&&scope===branchKey()&&user?.id===owner;
  const previous={model:sessionData.model,effort:sessionData.effort??null,access_mode:sessionData.access_mode??'workspace-write',execution_mode:sessionData.execution_mode??'default'};Object.assign(sessionData,patch);
  if(patch.execution_mode)semanticModes.set(sid,patch.execution_mode==='default'?'normal':patch.execution_mode);
  const prior=settingsWrites.get(sid),send=()=>{if(user?.id!==owner)throw new Error('账号已切换，未保存原会话设置');return api.api(sessionRoute(sid),{method:'PATCH',body:patch});};
  const write=prior?prior.catch(()=>{}).then(send):send();settingsWrites.set(sid,write);renderComposer();
  try{const saved=await write;if(current()&&settingsWrites.get(sid)===write)Object.assign(sessionData,{model:saved.model,effort:saved.effort??null,access_mode:saved.access_mode??'workspace-write',execution_mode:saved.execution_mode??'default'});return saved;}
  catch(error){if(current()&&settingsWrites.get(sid)===write){const saved=await api.api(sessionRoute(sid)).catch(()=>null);if(current()&&settingsWrites.get(sid)===write)Object.assign(sessionData,saved?{model:saved.model,effort:saved.effort??null,access_mode:saved.access_mode??'workspace-write',execution_mode:saved.execution_mode??'default'}:previous);}report(error);return null;}
  finally{if(settingsWrites.get(sid)===write)settingsWrites.delete(sid);if(sid===selectedSessionId)renderComposer();}
}
function flushDraft(){
  clearTimeout(saveDraftTimer);const id=selectedSessionId,value=draftCache.get(id),owner=user?.id,pid=project?.id;if(!id||value===undefined||!ownSession(sessionData)||!canWrite())return draftWrite.catch(()=>{});
  const op=draftWrite.catch(()=>{}).then(async()=>{if(user?.id!==owner||!['owner','editor'].includes(projects.find(p=>p.id===pid)?.role))return;await api.api(sessionRoute(id),{method:'PATCH',body:{draft:value}});if(id===selectedSessionId&&sessionData){sessionData.draft=value;$('#draftStatus').textContent=cleanupLabel()||'会话草稿已保存';}});
  draftWrite=op;return op;
}
function submissionScope(){return branch&&sessionData?{project_id:project.id,branch_id:branch.branch_id,session_id:sessionData.id,user_id:user.id}:null;}
function pendingSubmission(){let pending=pendingTurnSubmissions.get(selectedSessionId);if(!pending&&user&&selectedSessionId){try{pending=JSON.parse(sessionStorage.getItem(`creator-pending-turn:${user.id}:${selectedSessionId}`));if(pending?.scope.user_id===user.id&&pending.scope.session_id===selectedSessionId){pending.sending=false;pendingTurnSubmissions.set(selectedSessionId,pending);}}catch{}}return pending?.scope.user_id===user?.id?pending:null;}
function storeSubmission(submission){sessionStorage.setItem(`creator-pending-turn:${submission.scope.user_id}:${submission.scope.session_id}`,JSON.stringify({...submission,sending:false}));}
function renderPendingSubmission(){
  const pending=pendingSubmission();$('#submissionNotice').hidden=!pending;
  $('#submissionText').textContent=pending?`原提交 ${short(pending.body.client_user_message_id)} 结果待核对；保留相同请求身份。`:'';
  $('#retryTurn').hidden=!pending;$('#retryTurn').disabled=!!pending?.sending;
}
function sameSubmissionScope(submission){const scope=submissionScope();return scope&&['project_id','branch_id','session_id','user_id'].every(k=>scope[k]===submission.scope[k]);}
function receiveSubmission(submission,result){
  sessionStorage.removeItem(`creator-pending-turn:${submission.scope.user_id}:${submission.scope.session_id}`);pendingTurnSubmissions.delete(submission.scope.session_id);
  const draft=draftCache.get(submission.scope.session_id);if(draft===undefined||draft.trim()===submission.body.text.trim())draftCache.delete(submission.scope.session_id);
  if(sameSubmissionScope(submission)){sessionData=reconcileSessionTitle(result.session,sessionTitleConfirmations.get(result.session.id));$('#sessionDraft').value=draftCache.get(submission.scope.session_id)??result.session.draft??'';renderComposer();}
}
async function transmitSubmission(submission){
  if(!sameSubmissionScope(submission))throw new Error('会话已经切换，未发送旧会话请求');
  storeSubmission(submission);submission.sending=true;renderComposer();
  try{const result=await api.api(`${sessionRoute(submission.scope.session_id)}/turns`,{method:'POST',body:copy(submission.body)});receiveSubmission(submission,result);return result;}
  catch(error){if(!error.uncertain){pendingTurnSubmissions.delete(submission.scope.session_id);sessionStorage.removeItem(`creator-pending-turn:${submission.scope.user_id}:${submission.scope.session_id}`);}else submission.uncertain=true;report(error);if(sameSubmissionScope(submission))await refreshSession();}
  finally{submission.sending=false;if(sameSubmissionScope(submission))renderComposer();}
}
function sendDraft(){
  const id=selectedSessionId;if(sessionSendJobs.has(id))return sessionSendJobs.get(id);const job=performSendDraft().finally(()=>{if(sessionSendJobs.get(id)===job)sessionSendJobs.delete(id);});sessionSendJobs.set(id,job);return job;
}
async function performSendDraft(){
  if(semanticComposerPending||semanticPreparingDraft)return;
  const initialSession=selectedSessionId,initialGeneration=sessionLoadGeneration;
  const command=leadingSemanticMode($('#sessionDraft').value);
  if(command){const saved=await saveSessionSettings({execution_mode:command.mode});if(!saved||selectedSessionId!==initialSession||sessionLoadGeneration!==initialGeneration)return;$('#sessionDraft').value=command.text;$('#sessionDraft').dispatchEvent(new Event('input',{bubbles:true}));semanticComposer?.refresh();if(!command.text.trim()&&!sessionData?.draft_attachments?.some(a=>a.kind==='image'))return;}
  if(unresolvedComposerReferences($('#sessionDraft').value).length)await prepareSemanticDraftForSend();
  if(selectedSessionId!==initialSession||sessionLoadGeneration!==initialGeneration)return;
  const settingsSession=selectedSessionId;if(sessionTitleWrites.has(settingsSession))await sessionTitleWrites.get(settingsSession);if(settingsWrites.has(settingsSession))await settingsWrites.get(settingsSession);if(attachmentWrites.has(settingsSession))await attachmentWrites.get(settingsSession);if(settingsSession!==selectedSessionId)return;
  if(!ownSession(sessionData)||runBusy())return;const scope=copy(submissionScope()),sid=scope.session_id,model=sessionData.model??agentStatus.default_model,text=$('#sessionDraft').value.trim();if(!text&&!sessionData.draft_attachments?.some(a=>a.kind==='image')){toast('先输入创作需求或添加图片。');return;}
  const submission={scope,body:{text,client_user_message_id:uuid(),model},sending:false};
  submission.body.effort=sessionData.effort??null;submission.body.access_mode=sessionData.access_mode??'workspace-write';
  submission.body.execution_mode=semanticModes.get(sid)==='plan'?'plan':semanticModes.get(sid)==='goal'?'goal':'default';
  await flushDraft();if(sessionTitleWrites.has(sid))await sessionTitleWrites.get(sid);if(!sameSubmissionScope(submission))throw new Error('会话已切换，未发送旧草稿');pendingTurnSubmissions.set(sid,submission);const automaticTitle=sessionData.title==='新会话'&&!(sessionData.messages??[]).some(m=>m.role==='user')?firstMessageTitle(expandReferenceText(text,sessionData.draft_attachments??[])||(sessionData.draft_attachments??[]).filter(a=>a.kind==='image').map(a=>a.name).join('、')):null;const result=await transmitSubmission(submission);
  // First executor binding may persist an earlier session snapshot. Name only
  // after its real turn receipt, so a later bind cannot overwrite the title.
  if(result&&automaticTitle&&user?.id===scope.user_id&&!sessionTitleConfirmations.has(sid)&&result.session?.title==='新会话')renameSessionTitle(sid,automaticTitle,{automatic:true,session:result.session});
}
async function retryTurn(){
  const submission=pendingSubmission();if(!submission||submission.sending||!sameSubmissionScope(submission))return;
  const session=await api.api(sessionRoute(submission.scope.session_id));if(!sameSubmissionScope(submission))return;
  const run=session.runs.find(r=>r.client_user_message_id===submission.body.client_user_message_id);
  if(run){receiveSubmission(submission,{run,session});toast('已从实际运行记录核对原提交，没有重复启动。');return;}
  await transmitSubmission(submission); // Explicit user retry uses the original immutable body and UUID.
}
async function attachCurrent(sid){
  if(!sid||!object())throw new Error('先选择对象与自己的会话');
  const session=sessions.find(s=>s.id===sid);if(!ownSession(session))throw new Error('附件只能加入自己的会话');
  if(attachmentWrites.has(sid)||pendingTurnSubmissions.has(sid))throw new Error('请等待当前批注或消息提交完成');
  if(modePending)throw new Error('请等待视口模式切换完成');
  const target=copy(object()),ctx=context(),selectedAtStart=selectedSessionId;
  if(mode==='inspect'&&(world?.session_kind==='local_preview'||world?.native_shared)&&frozenScene){ctx.resourceId=frozenScene.resource_id;ctx.key=frozenScene.document_id;ctx.base=frozenScene.scene_revision;}
  const camera=fixedAnnotationCamera(annotationView,{documentId:ctx.key,seq:mainPreview?.seq,mode,revision:mode==='inspect'?(world?.session_kind==='local_preview'?worldState?.frozen_revision:inspectionRecord?.revision):ctx.base});
  let route,payload;
  if(mode==='inspect'&&world?.session_kind==='local_preview'){
    const source=frozenScene?.objects.find(o=>o.id===target.id);if(!source)throw new Error('缺少固定版本的源对象');
    route='attachments';payload={...fixedSourceAttachment(source,{...ctx,base:frozenScene.scene_revision,schema:source.address?'creation-hierarchy-2':'creation-flat-1'}),camera};
  }else if(mode==='inspect'){
    if(!worldState||!world||!inspectionRecord)throw new Error('尚未收到中央服务对个人检查快照的确认');
    const identity=target.address?{address:copy(target.address),expected_version:target.object_version??target.version}:{object_id:target.id,expected_version:target.version};
    route='inspection-attachments';payload={inspection_id:inspectionRecord.inspection_id,world_id:world.world_id,epoch:world.epoch,sequence:inspectionRecord.sequence,resource_id:ctx.resourceId,...identity,camera};
  }else if(mode==='edit'){
    if(localEdit||drag||localCommitPending)throw new Error('请先完成当前变换编辑再固定附件');
    route='attachments';payload={...fixedSourceAttachment(target,ctx),camera};
  }else throw new Error('先进入个人检查，固定所见世界快照后再添加附件');
  const write=api.api(`${sessionRoute(sid)}/${route}`,{method:'POST',body:payload});attachmentWrites.set(sid,write);if(sid===selectedSessionId)renderComposer();
  try{
    const attachment=await write;
    if(branchKey()===`${ctx.projectId}/${ctx.branchId}`&&selectedSessionId===selectedAtStart){await selectSession(sid);openChat(true);}
    toast(`已固定 ${attachment.address?.definition_node_id??attachment.object_id} 的版本、坐标空间与上下文。`);
  }finally{if(attachmentWrites.get(sid)===write)attachmentWrites.delete(sid);if(sid===selectedSessionId)renderComposer();}
}
function showAttachment(a){
  if(!a)return;
  if(a.kind==='image'){modal(a.name,`${imageElement(a,'attachment-full-image')}<p class="muted">${a.width} × ${a.height} · ${(a.bytes/1024/1024).toFixed(2)} MB</p>`,[{label:'返回会话',action:closeModal}]);hydrateImageAttachments();return;}
  if(a.kind==='viewport_annotation'){modal(a.name,`<p>${esc(a.note)}</p><p>${esc(annotationCoordinateSummary(a))} · ${esc(a.resource_name)}</p><p>${a.members.length} 个对象 · ${esc(short(a.source_revision))}</p><ul>${a.members.map(m=>`<li>${esc(m.name)} <small>${esc(m.object_id)}</small></li>`).join('')}</ul>`,[{label:'复制批注',action:()=>copyAnnotationText(portableAnnotations([a],a)).then(()=>toast('已复制批注，可粘贴到其他 Agent'))},{label:'关闭',action:closeModal}]);return;}
  if(['prefab','knowledge'].includes(a.kind)){const item=a.snapshot,description=a.kind==='prefab'?a.design?.description??item?.design?.description??'':item?.content??item?.description??'';modal(semanticAttachmentLabel(a),`<p>${esc(semanticAttachmentSummary(a))} · 发送后保持这个版本的内容</p><div class="semantic-knowledge-content">${renderMarkdown(description||'尚无功能描述')}</div><p class="semantic-caption">${esc(a.branch_id)} · ${esc(short(a.revision))}</p>`,[{label:'返回会话',action:closeModal}]);return;}
  modal(semanticAttachmentLabel(a),annotationDetails(a),[{label:'返回会话',action:closeModal}]);
}
function showAttachmentRecords(){
  if(!sessionData)return;
  const draft=sessionData.draft_attachments??[],sent=(sessionData.messages??[]).flatMap(m=>(m.attachments??[]).map(a=>({...a,message_sequence:m.sequence}))),all=[...draft,...sent];
  const rows=list=>list.length?list.map(a=>`<div class="attachment-record">${referenceChip(a)}<small>${esc(a.branch_id)} · ${esc(a.kind==='image'?`${a.width} × ${a.height}`:semanticAttachmentSummary(a)??annotationCoordinateSummary(a))}${a.message_sequence?` · 消息 ${a.message_sequence}`:''}</small></div>`).join(''):'<p class="muted">暂无引用</p>';
  modal('会话批注记录',`<h3>待发送 · ${draft.length}</h3>${rows(draft)}<h3>已发送 · ${sent.length}</h3>${rows(sent)}`,[{label:'返回',action:closeModal}]);
  hydrateImageAttachments();$('#modalBody').querySelectorAll('[data-record-attachment]').forEach(b=>b.onclick=()=>showAttachment(all.find(a=>a.id===b.dataset.recordAttachment)));
}
async function agentEntry(){
  if(!branch)return;if(!ownSession(sessionData)){const mine=sessions.find(ownSession);if(mine)await selectSession(mine.id);else{newSession();return;}}
  openChat(true);$('#sessionDraft').placeholder='描述要创建的模型、场景或行为。Codex 可使用真实文件、Blender 与世界工具。';
}
function showRequest(request,{replyRoute=null}={}){
  if(!request||!ownSession(sessionData))return;const sid=selectedSessionId,key=request.request_key,owner=user?.id,scope=branchKey(),generation=sessionLoadGeneration;
  const current=()=>generation===sessionLoadGeneration&&active()&&sid===selectedSessionId&&owner===user?.id&&scope===branchKey();
  const command=['item/commandExecution/requestApproval','item/fileChange/requestApproval','execCommandApproval','applyPatchApproval'].includes(request.method);
  const input=request.method==='item/tool/requestUserInput';
  const elicitation=request.method==='mcpServer/elicitation/request'?elicitationDescriptor(request):null;
  let html=`<p>此请求属于 ${esc(sessionData.title)}。仅提交你的真实决定；关闭窗口会继续等待。</p><details open><summary>${esc(request.method)}</summary><pre>${esc(JSON.stringify(request.params,null,2))}</pre></details>`;
  if(input)html+=(request.params.questions??[]).map((q,i)=>`<label>${esc(q.question)}${q.options?.length?`<small>${q.options.map(o=>esc(o.label)+'：'+esc(o.description)).join('<br>')}</small>`:''}<textarea data-answer="${i}" rows="2" placeholder="输入你的答案"></textarea></label>`).join('');
  if(elicitation){
    html+=`<p>${esc(request.params?.serverName??'MCP 工具')} · ${esc(request.params?.message??'请求你的决定')}</p>`;
    html+=elicitation.supported?elicitationFields(elicitation.fields):`<p class="error-text">${esc(elicitation.reason||'该表单结构尚不支持填写')}。你仍可拒绝或取消此请求。</p>`;
  }
  const reply=async result=>{if(!current())throw new Error('会话或请求窗口已切换');await api.api(replyRoute??`${sessionRoute(sid)}/requests/${encodeURIComponent(key)}`,{method:'POST',body:{result}});if(!current())return;sessionEvents.push({kind:'serverRequestReply',requestKey:key});closeModal();inbox?.invalidate();renderComposer();};
  const buttons=[{label:'继续等待',action:closeModal}];
  if(command)buttons.push({label:'拒绝',action:()=>reply({decision:'decline'})},{label:'批准本次',primary:true,action:()=>reply({decision:'accept'})});
  else if(input)buttons.push({label:'提交答案',primary:true,action:()=>{const answers={};for(const[q,i]of (request.params.questions??[]).map((q,i)=>[q,i])){const text=$(`[data-answer="${i}"]`).value.trim();if(!text)throw new Error('请回答所有问题');answers[q.id]={answers:[text]};}return reply({answers});}});
  else if(elicitation){
    buttons.push({label:'取消请求',action:()=>reply({action:'cancel',content:null,_meta:null})},{label:'拒绝请求',action:()=>reply({action:'decline',content:null,_meta:null})});
    if(elicitation.supported)buttons.push({label:'允许本次',primary:true,action:()=>reply({action:'accept',content:elicitationValues(elicitation.fields),_meta:null})});
  }
  else html+='<p class="error-text">此请求类型尚无专用答复界面；可保留等待或在会话中中断任务。</p>';
  const active=modal('Codex 需要你的决定',html,buttons);
}
function elicitationDescriptor(request){
  if(request.elicitation)return request.elicitation;
  const schema=request.params?.requestedSchema,mode=request.params?.mode??'form';
  const empty=mode==='form'&&schema?.type==='object'&&schema.properties&&typeof schema.properties==='object'&&!Array.isArray(schema.properties)&&Object.keys(schema.properties).length===0&&(!schema.required||schema.required.length===0)&&Object.keys(schema).every(k=>['$schema','type','properties','required','additionalProperties','title','description'].includes(k));
  return {supported:!!empty,fields:[],reason:'此历史请求缺少受支持的表单描述，需要重新核对工具请求'};
}
function elicitationFields(fields){
  return fields.map((field,index)=>{
    const attributes=`data-elicitation-field="${index}" aria-label="${esc(field.title||field.name)}"`,label=esc(field.title||field.name)+(field.required?'（必填）':''),description=field.description?`<small>${esc(field.description)}</small>`:'';
    let input='';
    if(field.type==='boolean')input=`<select ${attributes}><option value="">请选择</option><option value="true" ${field.default===true?'selected':''}>是</option><option value="false" ${field.default===false?'selected':''}>否</option></select>`;
    else if(['enum','enum-array'].includes(field.type))input=`<select ${attributes} ${field.type==='enum-array'?'multiple size="4"':''}>${field.type==='enum'?'<option value="">请选择</option>':''}${(field.options??[]).map((option,i)=>`<option value="${i}" ${(field.type==='enum-array'?(field.default??[]).includes(option.value):field.default===option.value)?'selected':''}>${esc(option.label)}</option>`).join('')}</select>`;
    else if(['number','integer'].includes(field.type))input=`<input ${attributes} type="number" step="${field.type==='integer'?1:'any'}" ${field.minimum!==undefined?`min="${Number(field.minimum)}"`:''} ${field.maximum!==undefined?`max="${Number(field.maximum)}"`:''} value="${esc(field.default??'')}">`;
    else input=`<input ${attributes} type="${field.format==='email'?'email':field.format==='uri'?'url':'text'}" ${field.minLength!==undefined?`minlength="${Number(field.minLength)}"`:''} ${field.maxLength!==undefined?`maxlength="${Number(field.maxLength)}"`:''} value="${esc(field.default??'')}">`;
    return `<label>${label}${description}${input}</label>`;
  }).join('');
}
function elicitationValues(fields){
  const content={};
  for(const[field,index]of fields.map((field,i)=>[field,i])){
    const input=$(`[data-elicitation-field="${index}"]`),label=field.title||field.name;
    if(!input.checkValidity())throw new Error(`请核对「${label}」的格式或范围`);
    if(field.type==='enum-array'){
      const values=[...input.selectedOptions].map(option=>field.options[Number(option.value)].value);
      if(values.length<(field.minItems??0)||values.length>(field.maxItems??Infinity))throw new Error(`请核对「${label}」的选择数量`);
      if(values.length||field.required)content[field.name]=values;continue;
    }
    if(input.value===''){if(field.required)throw new Error(`请填写「${label}」`);continue;}
    if(field.type==='boolean')content[field.name]=input.value==='true';
    else if(field.type==='enum')content[field.name]=field.options[Number(input.value)].value;
    else if(['number','integer'].includes(field.type)){const value=Number(input.value);if(!Number.isFinite(value)||field.type==='integer'&&!Number.isInteger(value))throw new Error(`「${label}」需要有效数值`);content[field.name]=value;}
    else content[field.name]=input.value;
  }
  return content;
}
function modelRecord(o,isolated=false){return {...copy(o),position:isolated?[0,0,0]:vector(o.position),rotation:vector(o.rotation),scale:vector(o.scale,1),solid:!!o.solid,components:copy(o.components??{})};}
function ensurePreviews(){
  const native=isNative(),editor=editorPreview??mainPreview;
  if(editor&&!(editor instanceof GamePlay)&&(editor instanceof NativeGodotPreview)!==native){
    editor.dispose();mainDocument=null;loadedSourceScene=null;
    if(editorPreview){editorPreview=createMainPreview();editorPreview.frame.hidden=true;editorPreview.status.hidden=true;}
    else mainPreview=null;
  }
  if(!mainPreview)mainPreview=createMainPreview();
  if(objectPreview&&(objectPreview instanceof NativeGodotPreview)!==native){objectPreview.dispose();objectPreview=null;objectDocument=null;}
  if(!objectPreview){objectPreview=native?new NativeGodotPreview($('#objectPreview'),'object',()=>{},(route,options)=>api.api(route,options)):new GodotPreview($('#objectPreview'),'object');bindPreviewFrame(objectPreview);}
  applyViewportDisplay();$('#toggleObjectPreview').onclick=()=>{const toggle=$('#toggleObjectPreview'),open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));$('#objectPreviewDock').classList.toggle('is-collapsed',!open);};
  $('#fitObject').onclick=()=>objectPreview.camera('fit');
}
function bindPreviewFrame(preview){
  preview.frame.addEventListener('load',()=>{
    preview.frame.contentDocument?.addEventListener('pointerdown',()=>{if(!$('#modal').open)closeChat(false);});
    preview.frame.contentDocument?.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#chatDrawer').hidden&&!document.querySelector('dialog[open]')){e.preventDefault();closeChat();}});
  });
}
function createMainPreview(){
  const callback=message=>{if(mainPreview===preview)onPreviewEvent(message);};
  const preview=isNative()?new NativeGodotPreview($('#mainPreview'),'main',callback,(route,options)=>api.api(route,options)):new GodotPreview($('#mainPreview'),'main',callback);
  preview.host.dataset.runtimeKind='editor';
  bindPreviewFrame(preview);return preview;
}
let pendingSharedTransfer=null;
async function openSharedWorld(){
  if(!branch||!isNative()||doc()?.kind!=='scene')return;
  const ctx=context(),opening=modalGeneration,owner=user?.id,status=await api.api(`${branchRoute(ctx.projectId,ctx.branchId)}/shared-world?resource_id=${encodeURIComponent(ctx.resourceId)}`);
  if(ctx.key!==key()||opening!==modalGeneration||owner!==user?.id)return;
  const current=()=>active()&&ctx.key===key()&&owner===user?.id;
  const buttons=[];
  if(status.world&&status.world.status!=='failed')buttons.push({label:'加入共享世界',primary:true,action:async()=>{closeModal();await joinSharedWorld();}});
  if(status.can_publish)buttons.push({label:status.world?'更新共享世界':'启动共享世界',action:async()=>{
    if(!current())return;const requestId=uuid();$('#modalError').textContent='正在构建并验证共享世界…';
    let polling=false;const timer=setInterval(async()=>{if(polling||!current())return;polling=true;try{const latest=await api.api(`${branchRoute(ctx.projectId,ctx.branchId)}/shared-world?resource_id=${encodeURIComponent(ctx.resourceId)}`);if(current())$('#modalError').textContent=latest.operation?.stage??'正在准备共享世界…';}catch{}finally{polling=false;}},2000);
    let result;try{result=await api.api(`${branchRoute(ctx.projectId,ctx.branchId)}/publish`,{method:'POST',timeoutMs:16*60000,body:{revision:status.source_revision,resource_id:ctx.resourceId,request_id:requestId,expected_world_version:status.world?.version??null}});}finally{clearInterval(timer);}
    if(!current())return;toast('共享世界已应用 '+short(result.delivery?.revision??status.source_revision));await openSharedWorld();
  }});
  buttons.push({label:'关闭',action:closeModal});
  const active=modal('共享世界',`<p>${status.world?`当前共享版本 ${esc(short(status.world.source_revision))} · ${esc({running:'运行中',sleeping:'可加入',failed:'需要恢复'}[status.world.status]??status.world.status)}`:'此场景尚未启动共享世界。'}</p><p>加入后与其他玩家游玩同一个世界。暂停观察只冻结本窗口，其他玩家继续。</p>${status.can_publish?'<p>修改源稿后，可在这里更新共享世界。更新会保留可迁移的运行状态；失败时保留原世界。</p>':''}`,buttons);
  let index=0;if(status.world&&status.world.status!=='failed')$(`[data-modal-button="${index++}"]`).id='joinSharedWorld';if(status.can_publish){const button=$(`[data-modal-button="${index}"]`);button.id='publishSharedWorld';button.disabled=status.operation?.status==='running';}if(status.operation?.status==='running')$('#modalError').textContent=status.operation.stage;
}
async function joinSharedWorld(fixed=null,{transfer=false}={}){
  if(!branch||!isNative()||doc()?.kind!=='scene'||!api.ready)throw Error('请先连接当前场景');
  const scope={projectId:project.id,branchId:branch.branch_id,resourceId,documentId:key()};
  if(!transfer)leaveWorld();
  else{inputEnabled=false;playControls?.setEnabled(false);mainPreview?.world({action:'disconnect',world_id:world?.world_id,epoch:world?.epoch,scene_revision:world?.scene_revision});}
  const generation=++joinGeneration;requestedMode='play';modePending=true;clearTimeout(modeTimer);
  joinRequest={generation,documentId:scope.documentId,session_kind:'shared_world',native_shared:true};
  const request=joinRequest;
  const {NativeSharedPlay,prepareNativeSharedPlay}=await import('./native-shared-play.js');
  if(joinRequest!==request||key()!==scope.documentId)return;
  ensurePreviews();
  if(!editorPreview){editorPreview=mainPreview;editorPreview.frame.hidden=true;editorPreview.status.hidden=true;}
  const old=mainPreview===editorPreview?null:mainPreview;
  const preview=new NativeSharedPlay($('#mainPreview'),({signal,onProgress})=>prepareNativeSharedPlay({request:(route,options)=>api.api(route,options),...scope,signal,onProgress,fixed}),message=>{if(mainPreview===preview)onPreviewEvent(message);});
  mainPreview=preview;bindPreviewFrame(preview);old?.dispose();++sceneGeneration;
  $('#workspaceStatus').textContent=transfer?'正在同步共享世界的新版本…':'正在准备共享世界…';renderStage();renderInspector();
  try{
    const job=await preview.runtimeReady;
    if(joinRequest!==request||preview!==mainPreview||key()!==scope.documentId)return;
    api.send({type:'world_join',native_shared:true,project_id:scope.projectId,branch_id:scope.branchId,source_revision:job.source_revision,runtime_build_id:job.canonical_identity,resource_id:scope.resourceId});armModeTimeout();
  }catch(error){if(joinRequest===request&&preview===mainPreview)suspendWorld(`无法加入共享世界：${errorText(error)}`);}
}
async function receiveNativeWorld(packet){
  if(packet.action==='join'){
    const request=joinRequest,preview=mainPreview;
    if(!request?.native_shared||request.generation!==joinGeneration||request.documentId!==key()||!preview?.nativeShared)return;
    if(packet.scene?.document_id!==`${project.id}/${branch.branch_id}/${packet.resource_id}`||packet.manifest?.resource_id!==resourceId||packet.scene_revision!==preview.job.source_revision||packet.manifest.runtime_build_id!==preview.runtimeBuildId){suspendWorld('共享基线与已加载客户端不匹配');return;}
    world={session_kind:'shared_world',native_shared:true,world_id:packet.world_id,epoch:packet.epoch,scene_revision:packet.scene_revision,player_id:packet.player_id,control_generation:packet.control_generation,game_build_id:preview.job.id,resource_id:packet.resource_id,scene_generation:packet.scene_generation};
    worldScene=packet.scene;worldScenes.put(packet.scene);localSceneDocuments.set(`${packet.scene.document_id}/${packet.scene_revision}`,packet.scene);worldState=null;frozenScene=null;pendingSharedTransfer=null;
    inputEnabled=false;const phase=modeSequence.begin('play',null);armModeTimeout();
    try{await preview.startShared(packet.scene,{...packet,request_id:phase.request_id});if(joinRequest===request)joinRequest=null;}
    catch(error){if(mainPreview===preview)suspendWorld(`共享场景加载失败：${errorText(error)}`);}return;
  }
  if(!world?.native_shared||packet.world_id!==world.world_id)return;
  if(packet.action==='transfer'){
    if(packet.manifest?.resource_id!==resourceId||packet.epoch<world.epoch)return;
    inputEnabled=false;pendingSharedTransfer=packet.manifest;
    if(mode==='inspect'){mainPreview.world({action:'disconnect',world_id:world.world_id,epoch:world.epoch,scene_revision:world.scene_revision});modePending=false;clearTimeout(modeTimer);$('#workspaceStatus').textContent='共享世界已更新；继续运行时同步新版本';return;}
    await joinSharedWorld(packet.manifest,{transfer:true});return;
  }
  if(packet.epoch!==world.epoch||packet.scene_revision!==world.scene_revision)return;
  if(packet.action==='error'){suspendWorld(`共享世界故障：${packet.error}`);return;}
  if(packet.action==='active'){
    if(packet.control_generation!==world.control_generation||packet.resource_id!==world.resource_id||packet.scene_generation!==world.scene_generation)return;
    inputEnabled=true;
  }
  mainPreview?.world(packet);
}

function beginPlayPreview(prepare){
  ensurePreviews();
  if(editorPreview)return;
  // Keep the authored scene and its camera intact. Game scripts, UI and audio
  // live in a separate Web engine whose whole lifetime ends on Stop.
  editorPreview=mainPreview;editorPreview.frame.hidden=true;editorPreview.status.hidden=true;
  const preview=new GamePlay($('#mainPreview'),prepare,message=>{if(mainPreview===preview)onPreviewEvent(message);});
  mainPreview=preview;bindPreviewFrame(preview);++sceneGeneration;
}
function restoreEditPreview(){
  if(!editorPreview)return;
  const playingPreview=mainPreview;
  mainPreview=editorPreview;editorPreview=null;++sceneGeneration;
  playingPreview.dispose();
  mainPreview.frame.hidden=false;mainPreview.status.hidden=false;
  Object.assign(mainPreview.host.dataset,{runtimeKind:'editor',runtimeBuild:mainPreview.runtimeBuildId??'',loadedDocument:mainPreview.sceneContext?.document_id??'',loadedSeq:String(mainPreview.loadedSeq),meshes:String(mainPreview.lastLoadedEvent?.mesh_count??mainPreview.lastLoadedEvent?.meshes??''),assetHashes:JSON.stringify(mainPreview.lastLoadedEvent?.assets??[])});
  delete mainPreview.host.dataset.gameBuild;delete mainPreview.host.dataset.sceneGeneration;
  // Restore the real camera observation of the still-alive editor, including
  // its preset selector and annotation context, rather than the play camera.
  const camera=mainPreview.lastCameraEvent;
  if(camera&&camera.seq===mainPreview.loadedSeq){
    mainPreview.host.dataset.camera=JSON.stringify({position:camera.position,target:camera.target,view:camera.view,seq:camera.seq});
    onPreviewEvent(camera);
  }
}
async function sourceScene(revision=null,targetResource=resourceId){
  const ctx={...context(),resourceId:targetResource};ctx.key=`${ctx.projectId}/${ctx.branchId}/${targetResource}`;if(revision)ctx.base=revision;const cacheKey=`${ctx.key}/${ctx.base}`;
  if(sceneCache?.key===cacheKey)return sceneCache.promise;
  const promise=api.api(`${branchRoute(ctx.projectId,ctx.branchId)}/runtime-scene?resource_id=${encodeURIComponent(ctx.resourceId)}&revision=${encodeURIComponent(ctx.base)}`).then(scene=>{
    if(scene.scene_revision!==ctx.base||scene.document_id!==ctx.key||scene.source_revision&&scene.source_revision!==ctx.base)throw new Error('源场景固定版本或文档不匹配，请重新读取');
    if(scene.hierarchy_pack&&(scene.hierarchy_pack.source_revision!==ctx.base||typeof scene.hierarchy_pack_canonical!=='string'))throw new Error('层级包缺少匹配的固定源版本或规范校验文本');
    return {...scene,source_revision:ctx.base};
  });
  sceneCache={key:cacheKey,promise};try{return await promise;}catch(error){if(sceneCache?.promise===promise)sceneCache=null;throw error;}
}
let loadedSourceScene=null;
function syncHierarchyPreviews(resetLocal=false){
  const scene=loadedSourceScene;if(!scene?.hierarchy_pack||!mainPreview)return;
  // The runtime applies preview packets by restoring the canonical transforms.
  // Keep incoming observations buffered while our gizmo owns the transform;
  // even an empty echo packet would otherwise cancel this physical drag.
  if(drag&&!resetLocal)return;
  const valid=mode==='edit'&&!modePending&&scene.document_id===key()&&scene.source_revision===branch.head;
  const values=valid?hierarchyPreviewList(scene,[...previews.values()],api.peerId,Date.now()):[];
  if(valid&&localEdit?.hierarchy&&localEdit.ctx.key===key()&&localEdit.ctx.base===scene.source_revision){
    const capture=localEdit.capture,transform=localTransformFromEuler({position:localEdit.next.position,rotation_degrees:localEdit.next.rotation,scale:localEdit.next.scale});
    values.push({id:localEdit.objectId,address:copy(capture.address),world_matrix:multiply(capture.parent_world_matrix,matrix(transform)),expected_object_version:capture.object_version,expected_ancestry_hash:capture.ancestry_hash,peer_id:api.peerId,expires_at:Date.now()+2000});
  }
  mainPreview.transient({document_id:scene.document_id,source_revision:scene.source_revision,previews:values,reset_local:resetLocal});
}
function syncNativePreviews(resetLocal=false){
  const scene=loadedSourceScene;if(scene?.document_schema!=='creation-native-1'||!mainPreview||drag&&!resetLocal)return;
  const valid=mode==='edit'&&!modePending&&scene.document_id===key()&&scene.source_revision===branch.head;
  const local=valid&&localEdit?.native&&localEdit.ctx.key===key()&&localEdit.ctx.base===scene.source_revision?localEdit:null;
  const rows=nativePreviewRows(scene,valid?[...previews.values()]:[],{selfId:api.peerId,localEdit:local});
  mainPreview.transient({document_id:scene.document_id,source_revision:scene.source_revision,source_identity:scene.source_identity,canonical_objects:rows.canonical,objects:rows.active,observe_ids:local?[local.objectId]:[],reset_local:resetLocal});
}
function sendNativeDragPreview(target,observation,ctx=context()){
  if(!editable()||Date.now()-lastDrag<80||!nativeMatchesEvent(observation,target,ctx))return;
  lastDrag=Date.now();api.scoped('drag_preview',{object_id:target.id,address:copy(target.address),native_target:copy(nativeEditTarget(target)),expected_version:target.version,expected_ancestry_hash:target.ancestry_hash,source_revision:ctx.base,source_identity:ctx.manifest.source_identity,dimension:target.dimension,local_transform:copy(observation.local_transform),...(target.dimension==='3d'?{world_matrix:copy(observation.world_matrix)}:{}),...(observation.control_layout?{control_layout:Object.fromEntries(Object.entries(nativeControlStorage(observation.control_layout.values)).filter(([field])=>target.control_layout?.fields[field]?.editable))}:{})});
}
async function handleNativeTransform(message){
  if(message.phase==='start'){
    const target=docObjects().find(o=>o.id===message.id),ctx=context();if(!target||!nativeMatchesEvent(message,target,ctx))return;
    if(localEdit)cancelLocalEdit();drag={ctx,target:copy(target),native:true,controlBefore:nativeControlObservation(target,ctx,message)};return;
  }
  const captured=drag;if(!captured?.native||captured.ctx.key!==key()||!nativeMatchesEvent(message,captured.target,captured.ctx))return;
  if(message.phase==='preview'){
    sendNativeDragPreview(captured.target,message,captured.ctx);const fields=message.local_transform;
    if(message.control_layout){controlObservation=copy(message);updateControlLayoutInputs($('#inspectorBody'),message.control_layout.values);}
    $$('[data-transform]').forEach(input=>{if(document.activeElement!==input&&fields?.[input.dataset.transform])input.value=fields[input.dataset.transform][Number(input.dataset.axis)];});
    $('#selectionStatus').textContent=`${captured.target.name} · ${message.position.map(fmt).join(' / ')} ${captured.target.dimension==='2d'?'px':'m'}`;return;
  }
  drag=null;if(captured.target.control_layout)controlObservation=message.phase==='cancel'?nativeControlObservation(captured.target,captured.ctx,message):null;api.scoped('drag_end');
  if(message.phase==='commit'){
    try{const ops=captured.target.dimension==='3d'?[nativeWorldTransformOperation(captured.target,message.world_matrix,captured.ctx,{matrixTarget:'edit'})]:captured.target.control_layout?[nativeControlOperation(captured.target,{value:message.control_changed??{offsets:message.control_layout.values.offsets}},captured.ctx)]:nativePatchOperations(captured.target,message.local_transform,captured.ctx);await transact(ops,{ctx:captured.ctx,label:'对象变换'});}
    catch(error){report(error);}
  }
  syncNativePreviews(true);updateSelection();syncMainPreview().catch(report);renderInspector();
}
async function syncMainPreview(){
  if(!doc())return;ensurePreviews();const generation=++sceneGeneration,documentKey=key(),sourceRevision=branch.head;
  if(mode!=='edit'||modePending||drag)return;
  if(project?.role==='player'&&isNative()){
    if(mainPreview.nativeKey){mainPreview.dispose();mainPreview=createMainPreview();}
    mainDocument=null;loadedSourceScene=null;mainPreview.frame.hidden=true;mainPreview.status.textContent='点击 Play 运行已发布的试玩版本';return;
  }
  mainPreview.frame.hidden=false;
  const scene=withDevelopmentMetadata(await sourceScene(),development);if(generation!==sceneGeneration||key()!==documentKey||branch.head!==sourceRevision||mode!=='edit'||modePending||drag)return;
  if(!scene.hierarchy_pack&&scene.document_schema!=='creation-native-1')scene.objects=scene.objects.map(o=>{
    const preview=[...previews.values()].find(p=>p.object_id===o.id&&p.peer_id!==api.peerId&&p.expires_at>Date.now());
    let result=preview?{...o,...trs(preview)}:o;
    if(localEdit?.ctx.key===documentKey&&localEdit.objectId===o.id)result={...result,...localEdit.next};
    return modelRecord(result);
  });
  // H2 pack/canonical and asset_access remain verbatim. Transients use a separate packet.
  scene.selected_id=selectedId??'';scene.selected_ids=selectedSemanticObjects().map(o=>o.id);scene.editable=editable();scene.frame=documentKey!==mainDocument;
  await mainPreview.scene(scene);if(generation!==sceneGeneration||documentKey!==key()||branch.head!==sourceRevision)return;
  loadedSourceScene=scene;mainDocument=documentKey;mainPreview.editor({tool:editorTool,snap:editorSnap});syncHierarchyPreviews();syncNativePreviews();
  if(/^(等待中央文档|正在读取中央文档|源稿就绪|3D 已就绪|场景已更新)/.test($('#workspaceStatus').textContent)||$('#workspaceStatus').textContent===`已保存 ${short(sourceRevision)} · 场景更新中`)$('#workspaceStatus').textContent=`场景已更新 · 源稿 ${short(sourceRevision)}`;
}
async function syncObjectPreview(){
  if(project?.role==='player'&&isNative()){$('#objectPreviewDock').hidden=true;objectPreview?.dispose();objectPreview=null;objectDocument=null;return;}
  const o=object(),visible=inspectorTab==='object'&&!!o&&doc()?.design?.category!=='system';$('#objectPreviewDock').hidden=!visible;if(!visible)return;
  ensurePreviews();const documentKey=viewedDocumentKey(),targetId=o.id,previewMode=mode,expectedRevision=mode==='edit'?branch.head:mode==='inspect'?worldState?.frozen_revision:worldState?.scene_revision;
  const source=mode==='edit'?await sourceScene():mode==='inspect'?frozenScene:displayedPlayScene();
  if(viewedDocumentKey()!==documentKey||object()?.id!==targetId||mode!==previewMode||!source||source.scene_revision!==expectedRevision)return;
  const asset=source.objects.find(item=>item.id===targetId);if(!asset)return;
  const inspected=mode==='inspect'?worldState?.inspection_objects?.find(item=>item.id===targetId):null;
  const objectKey=`${documentKey}/${targetId}/${source.scene_revision}/${JSON.stringify(inspected?.world_matrix??inspected?.position??null)}`;
  $('#objectPreviewName').textContent='模型预览';
  let preview;
  if(source.hierarchy_pack||source.document_schema==='creation-native-1'){
    // Do not crop or reconstruct a hierarchy pack. Godot filters the visible subtree.
    preview={...copy(source),document_id:`${documentKey}/preview/${targetId}`,preview_object_id:targetId,editable:false,selected_id:'',frame:objectKey!==objectDocument};
    if(inspected)preview.preview_observation=copy(inspected);
  }else preview={...copy(source),document_id:`${documentKey}/preview/${targetId}`,objects:[modelRecord({...asset,...(inspected??{})},true)],editable:false,selected_id:'',frame:objectKey!==objectDocument};
  await objectPreview.scene(preview);if(viewedDocumentKey()===documentKey&&object()?.id===targetId&&mode===previewMode)objectDocument=objectKey;
}
function invalidateMainCamera(){cameraIntentSerial++;}
async function requestMainCamera(action){
  if(!mainPreview||!doc()||modePending)return false;
  const intent={serial:++cameraIntentSerial,documentId:key(),objectId:selectedId,mode};
  const alive=()=>intent.serial===cameraIntentSerial&&key()===intent.documentId&&selectedId===intent.objectId&&mode===intent.mode&&!modePending&&!mainPreview?.disposed;
  try{
    if(intent.mode==='edit'){
      const commit=localCommit;if(commit?.key===intent.documentId)await commit.promise;
      if(!alive()||localCommitPending||localEdit||drag)return false;
      const revision=branch.head;await syncMainPreview();
      if(!alive()||localCommitPending||localEdit||drag||branch.head!==revision)return false;
      if(loadedSourceScene?.document_id!==intent.documentId||loadedSourceScene.source_revision!==revision||loadedSourceScene.selected_id!==(intent.objectId??'')||mainPreview.pending||!mainPreview.ready||mainPreview.loadedSeq!==mainPreview.seq)return false;
    }
    if(!alive())return false;mainPreview.camera(action);return true;
  }catch(error){if(alive())report(error);return false;}
}
const previewExpiryTimer=setInterval(()=>{let changed=false;for(const [k,p]of previews)if(p.expires_at<=Date.now()){previews.delete(k);changed=true;}if(changed){if(isHierarchy())syncHierarchyPreviews();if(isNative())syncNativePreviews();}},500);
let requestedMode=null,modeTimer=null,inspectionRecord=null,joinGeneration=0,frozenScene=null,inspectionSentKey=null;
let inputEnabled=false,joinRequest=null,worldLoadPending=false,connectionInterrupted=false;
const worldScenes=new SceneRevisionCache(8),modeSequence=new WorldModeSequence();
const localSceneDocuments=new Map();let localDocumentRequest=null;
function localSceneDocument(revision,documentId){return localSceneDocuments.get(`${documentId}/${revision}`)??null;}
function displayedPlayScene(){return world?.native_shared||world?.session_kind==='local_preview'?localSceneDocument(worldState?.scene_revision??world?.scene_revision,worldState?.document_id??worldScene?.document_id):worldState?.scene_revision?worldScenes.get(worldState.scene_revision):worldScene;}
function viewedScene(){return mode==='inspect'?frozenScene:mode==='play'?displayedPlayScene():null;}
function viewedDocumentKey(){return mode==='edit'?key():viewedScene()?.document_id??worldState?.document_id??key();}
function trackLocalScene(message){
  if((world?.session_kind!=='local_preview'&&!world?.native_shared)||!message.document_id)return;
  const parts=message.document_id.split('/');
  if(parts.length!==3||parts[0]!==project.id||parts[1]!==branch.branch_id){suspendWorld('游戏返回了不属于当前工程的关卡');return;}
  const identity=`${message.document_id}/${message.scene_revision}`;
  const cached=localSceneDocument(message.scene_revision,message.document_id);
  if(cached){
    if(mainPreview.sceneContext?.document_id!==message.document_id||mainPreview.boundSceneGeneration!==message.scene_generation){
      invalidateMainCamera();annotationView=null;selectedId=null;localDocumentRequest=null;
      worldScene=cached;mainPreview.bindScene?.(cached,message.scene_generation);
      if(mode==='inspect'&&message.frozen_revision===cached.scene_revision)frozenScene=cached;
      renderExplorer();renderStage();renderInspector();
    }
    return;
  }
  if(localDocumentRequest?.identity===identity)return;
  const request=localDocumentRequest={identity,generation:joinGeneration,worldId:world.world_id};
  invalidateMainCamera();annotationView=null;selectedId=null;
  sourceScene(message.scene_revision,parts[2]).then(scene=>{
    if(localDocumentRequest!==request||request.generation!==joinGeneration||world?.world_id!==request.worldId)return;
    localSceneDocuments.set(identity,scene);while(localSceneDocuments.size>8)localSceneDocuments.delete(localSceneDocuments.keys().next().value);
    if(worldState?.document_id!==scene.document_id)return;
    worldScene=scene;mainPreview.bindScene?.(scene,worldState.scene_generation);
    if(mode==='inspect'&&worldState.frozen_revision===scene.scene_revision)frozenScene=scene;
    renderExplorer();renderStage();renderInspector();
  }).catch(error=>{if(localDocumentRequest===request&&request.generation===joinGeneration)suspendWorld(`无法读取所见关卡的固定源对象：${errorText(error)}`);});
}
const modeLong={edit:'editing',play:'playing',inspect:'inspecting'},modeShort={editing:'edit',playing:'play',inspecting:'inspect'};
function leaveWorld(){
  closePrefabLab(false);
  invalidateMainCamera();
  playControls?.setEnabled(false);
  inputEnabled=false;pendingSharedTransfer=null;++joinGeneration;joinRequest=null;worldLoadPending=false;
  if(world){mainPreview?.world?.({action:'leave',world_id:world.world_id,epoch:world.epoch,scene_revision:world.scene_revision});if(world.session_kind!=='local_preview')api.send({type:'world_leave'});}
  world=null;worldScene=null;worldState=null;frozenScene=null;worldScenes.clear();inspectionSentKey=null;inspectionRecord=null;requestedMode=null;modeSequence.clear();modePending=false;mode='edit';clearTimeout(modeTimer);
  localSceneDocuments.clear();localDocumentRequest=null;
  restoreEditPreview();
}
function suspendWorld(reason){
  connectionInterrupted=true;leaveWorld();
  if(branch){renderStage();renderInspector();}
  $('#workspaceStatus').textContent=reason;toast(reason);
}
function armModeTimeout(){
  clearTimeout(modeTimer);modeTimer=setTimeout(()=>suspendWorld('模式确认超时，已退出旧角色控制并返回源稿；请显式重新进入 Play。'),45000);
}
function issueModePhase(packet){
  if(!world||!inputEnabled||world.session_kind!=='local_preview'&&!api.ready)throw new Error('试玩尚未就绪');
  annotationView=null;
  playControls?.setEnabled(false);
  if(packet.mode==='inspecting')worldScenes.pin(worldState?.scene_revision);
  modePending=true;mainPreview.world({action:'mode',...packet,world_id:world.world_id,epoch:world.epoch,scene_revision:world.scene_revision});armModeTimeout();
}
function requestWorldMode(target){
  if(target==='play'&&pendingSharedTransfer){joinSharedWorld(pendingSharedTransfer,{transfer:true}).catch(report);return;}
  if(!world||!mainPreview?.world)throw new Error('世界模式接口尚未就绪');
  if(target==='play'&&world.session_kind==='local_preview'&&worldState?.error){toast('本局遇到脚本错误，修复后请重新开始；当前画面可继续观察');return;}
  requestedMode=target;issueModePhase(modeSequence.begin(target,worldState));
}
async function loadWorldScene(generation){
  worldLoadPending=true;
  try{
    while(world&&generation===joinGeneration){
      const scene=worldScene,revision=scene.scene_revision;
      await mainPreview.scene({...scene,editable:false,frame:false,selected_id:selectedId??''});
      if(!world||generation!==joinGeneration)return false;
      if(worldScene.scene_revision===revision)return true;
      // A real publication arrived during asset load; consume its immutable scene next.
    }
    return false;
  }finally{if(generation===joinGeneration)worldLoadPending=false;}
}
async function setMode(next){
  if(viewportAnnotations?.active){await viewportAnnotations.finish();if(viewportAnnotations.active)return;}

  prefabPlacement?.cancel();
  if(!branch||!doc()||!['edit','play','inspect'].includes(next))return;
  if(next==='play'&&doc().purpose==='prefab_test')return openPrefabLab(doc().subject_id,doc().id);
  // Stop remains available while loading, joining or waiting for an ACK.
  if(next==='edit'&&(mode!=='edit'||modePending)){
    cancelLocalEdit();annotationView=null;leaveWorld();sceneCache=null;
    $('#workspaceStatus').textContent='源稿就绪 · 已结束本次运行';
    renderAll();sendPresence();sendDevelopment();return;
  }
  if(modePending||next===mode||doc().kind==='prefab'&&next!=='edit'||mode==='edit'&&next==='inspect')return;
  invalidateMainCamera();
  cancelLocalEdit();inspectionRecord=null;annotationView=null;
  if(next!=='edit'&&world?.session_kind!=='local_preview'&&!api.ready){toast('实时连接已断开，无法进入世界。');return;}
  if(!world&&next!=='edit'){
    const scope={project_id:project.id,branch_id:branch.branch_id,resource_id:resourceId,source_revision:branch.head,role:project.role,native_default:isNative()&&resourceId===branch.manifest.entry_scene_id};
    beginPlayPreview(async({signal,onProgress})=>{
      let revision=scope.source_revision,entrySceneId=scope.resource_id;
      if(scope.role==='player'){
        const playable=await api.api(`${branchRoute(scope.project_id,scope.branch_id)}/playable-game${scope.native_default?'':'?resource_id='+encodeURIComponent(scope.resource_id)}`,{signal});
        revision=playable.source_revision;
        entrySceneId=playable.resource_id??entrySceneId;
      }
      return prepareGamePlay({request:(route,options)=>api.api(route,options),projectId:scope.project_id,branchId:scope.branch_id,revision,entrySceneId,signal,onProgress});
    });requestedMode=next;modePending=true;++joinGeneration;
    joinRequest={generation:joinGeneration,documentId:key(),session_kind:'local_preview'};
    $('#workspaceStatus').textContent='正在准备独立试玩…';renderStage();renderInspector();
    const request=joinRequest,preview=mainPreview;
    try {
      const job=await preview.runtimeReady;
      if(joinRequest!==request||request.generation!==joinGeneration||request.documentId!==key())return;
      const scene=await sourceScene(job.source_revision,job.entry_scene_id);
      if(joinRequest!==request||request.generation!==joinGeneration||request.documentId!==key())return;
      world={session_kind:'local_preview',world_id:'preview:'+uuid(),epoch:1,scene_revision:scene.scene_revision,game_build_id:job.id,canonical_identity:job.canonical_identity};
      worldScenes.put(scene);worldScene=worldScenes.get(scene.scene_revision);worldState=null;
      localSceneDocuments.set(`${scene.document_id}/${scene.scene_revision}`,scene);
      inputEnabled=true;
      const phase=modeSequence.begin('play',null);
      armModeTimeout();
      await preview.start({...scene,selected_id:selectedId??''},{...world,request_id:phase.request_id});
      if(joinRequest!==request||preview!==mainPreview)return;
      joinRequest=null;
    } catch(error) {if(request.generation===joinGeneration&&preview===mainPreview)suspendWorld(`无法进入试玩：${errorText(error)}`);return;}
    renderStage();return;
  }
  if(world){try{
    if(mode==='edit'&&next!=='edit'){
      const generation=joinGeneration;modePending=true;
      if(!await loadWorldScene(generation))return;
    }
    requestWorldMode(next);
  }catch(error){suspendWorld(`未能进入世界：${error.message}。已封停旧输入，请重新进入。`);}}else mode=next;
  renderStage();renderInspector();
}
async function restartPlay(){
  if(!world||world.native_shared||modePending||doc()?.kind!=='scene')return;
  await setMode('edit');
  await setMode('play');
}
async function receiveWorld(packet){
  if(packet.native_shared||world?.native_shared||joinRequest?.native_shared)return receiveNativeWorld(packet);
  if(world?.session_kind==='local_preview'||joinRequest?.session_kind==='local_preview')return;
  if(packet.action==='join'){
    if(!branch||packet.scene?.document_id!==key()||!joinRequest||joinRequest.generation!==joinGeneration||joinRequest.documentId!==key()){
      if(!world)api.send({type:'world_leave'});return;
    }
    const generation=joinGeneration,target=requestedMode??'play';joinRequest=null;
    world={world_id:packet.world_id,epoch:packet.epoch,scene_revision:packet.scene_revision,player_id:packet.player_id};worldScenes.put(packet.scene);worldScene=worldScenes.get(packet.scene_revision);worldState=null;
    ensurePreviews();++sceneGeneration;
    try{if(!await loadWorldScene(generation))return;}
    catch(error){if(generation===joinGeneration)suspendWorld(`世界资源加载失败：${error.message}。旧输入已停止。`);return;}
    if(generation!==joinGeneration||world?.world_id!==packet.world_id)return;
    worldLoadPending=false;inputEnabled=true;mainPreview.world(packet);requestWorldMode(target);return;
  }
  if(!world||packet.world_id!==world.world_id||packet.epoch!==world.epoch)return;
  if(packet.action==='error'){suspendWorld(`世界故障：${packet.error}。旧角色输入已停止，返回源稿；请重新进入 Play。`);return;}
  mainPreview?.world?.(packet);
}
function measureLegacyControlViews(message){
  if(!isNative()||mode!=='edit'||message.document_id!==key())return false;
  if(message.type!=='loaded'&&!message.control_layout)return false;
  let ctx,changed=false;
  for(const observation of message.type==='loaded'?message.objects??[]:[message]){
    if(observation.control_layout?.needs_measurement!==false)continue;
    const target=docObjects().find(value=>value.id===observation.id);
    if(target?.control_layout?.needs_measurement&&measureLegacyControl(target,observation,ctx??=context()))changed=true;
  }
  return changed;
}
async function onPreviewEvent(message){
  if(!branch)return;
  if(message.type==='runtime_error'&&mainPreview instanceof GamePlay){suspendWorld(`游戏运行失败：${message.message}`);return;}
  if(message.type==='shared_ready'){
    if(world?.native_shared&&mainPreview?.nativeShared&&message.world_id===world.world_id&&message.epoch===world.epoch&&message.control_generation===world.control_generation)api.send({...message,type:'world_ready'});return;
  }
  if(message.type==='native_shared_input'){
    if(world?.native_shared&&inputEnabled&&api.ready&&message.control_generation===world.control_generation&&validWorldInput(message,world,true,true))api.send({type:'world_input',input:message});return;
  }
  if(message.type==='player_input'){
    if(world?.session_kind!=='local_preview'&&validWorldInput(message,world,api.ready,inputEnabled))api.send({type:'world_input',input:message});return;
  }
  if(message.type==='world_state'){
    if(!world||!inputEnabled||message.world_id!==world.world_id||message.epoch!==world.epoch)return;
    const next=modeShort[message.mode],changed=next!==mode,displayedChanged=worldState?.scene_revision!==message.scene_revision||worldState?.document_id!==message.document_id;
    worldState=copy(message);
    trackLocalScene(message);
    if(!world)return;
    renderPlayControls();
    const acknowledgement=modeSequence.acknowledge(message);
    if(message.mode_request_failed){modeSequence.clear();modePending=false;requestedMode=null;clearTimeout(modeTimer);}
    if(message.error){$('#workspaceStatus').textContent=message.error;if(world.session_kind==='local_preview'&&modePending&&mode==='edit'){suspendWorld(`独立试玩未能启动：${message.error}`);return;}}
    if(next){
      mode=next;
      // Godot reports the transferred camera immediately before its inspection
      // ACK. Associate that real observation with the now-confirmed mode.
      if(changed&&next==='inspect'&&mainPreview.lastCameraEvent?.seq===mainPreview.loadedSeq)onPreviewEvent(mainPreview.lastCameraEvent);
      renderPlayControls();
      if(next==='inspect'){
        // Choose the actual frozen revision, which may lag a newly published world_scene.
        worldScenes.pin(message.frozen_revision);frozenScene=world.native_shared||world.session_kind==='local_preview'?localSceneDocument(message.frozen_revision,message.document_id??worldScene?.document_id):worldScenes.get(message.frozen_revision);
        if(!frozenScene)$('#workspaceStatus').textContent='缺少所见冻结版本的文档，暂不展示对象属性或添加附件。';
        const fingerprint=`${message.world_id}/${message.epoch}/${message.frozen_revision}/${message.frozen_sequence}/${message.stop_ack_sequence}`;
        if(world.session_kind!=='local_preview'&&frozenScene&&inspectionSentKey!==fingerprint){inspectionSentKey=fingerprint;inspectionRecord=null;api.send({type:'world_inspection',state:message});}
      }else{inspectionRecord=null;frozenScene=null;inspectionSentKey=null;if(modeSequence.target!=='inspect')worldScenes.pin(null);}
      if(acknowledgement.next)issueModePhase(acknowledgement.next);
      else if(acknowledgement.complete){modePending=false;requestedMode=null;clearTimeout(modeTimer);$('#workspaceStatus').textContent=message.error||(world.session_kind==='local_preview'?(next==='play'?`独立试玩已就绪 · ${short(message.scene_revision)}`:'本次试玩已暂停 · 可自由移动相机'):(next==='play'?`世界已就绪 · ${short(message.scene_revision)}`:next==='inspect'?'个人检查已冻结，正在核对所见边界':'源稿就绪'));}
      if(changed||displayedChanged)sendDevelopment();
      if(next==='play'&&displayedChanged&&!message.error)$('#workspaceStatus').textContent=`正在游玩 · ${short(message.scene_revision)}`;
      if(changed||acknowledgement.complete||acknowledgement.next||next==='play'&&displayedChanged){if(next==='edit')sceneCache=null;renderStage();renderInspector();sendPresence();}
    }else if(modePending){$('#workspaceStatus').textContent={preparing_play:'正在准备世界投影…',resyncing:'正在同步匹配的世界版本…',entering_inspect:'等待权威确认停止输入…'}[message.mode]||'等待世界模式确认…';}
    return;
  }
  if(message.document_id&&message.document_id!==viewedDocumentKey())return;
  if(message.type?.startsWith('annotation_')){viewportAnnotations?.accept(message);return;}
  if(message.type==='prefab_drag'){prefabPlacement?.feedback(message);return;}
  const measuredControl=measureLegacyControlViews(message);
  if(measuredControl)renderInspector();
  if(message.type==='native_transform_preview'){
    const edit=localEdit;if(isNative()&&edit?.native&&edit.ctx.key===key()&&nativeMatchesEvent(message,edit.target,edit.ctx)){sendNativeDragPreview(edit.target,message,edit.ctx);if(message.control_layout){controlObservation=copy(message);updateControlLayoutInputs($('#inspectorBody'),message.control_layout.values);}}return;
  }
  if(message.type==='interaction_error'){report(new Error(message.message));return;}
  if(message.type==='selected'){
    const candidates=mode==='edit'?docObjects():mode==='inspect'?frozenScene?.objects??[]:displayedPlayScene()?.objects??[],candidate=candidates.find(o=>o.id===message.id);
    if(message.id===''){selectObject('',{fromPreview:true,ids:[]});return;}
    if(!candidate)return;if(candidate.address&&(!message.address||fullAddressKey(candidate.address)!==fullAddressKey(message.address)))return;
    if(mode==='edit'&&candidate.address&&message.source_revision!==branch.head)return;if(message.control_layout)controlObservation=copy(message);selectObject(message.id,{fromPreview:true,ids:message.ids});return;
  }
  if(message.type==='loaded'){viewportAnnotations?.loaded();viewportNavigation.loaded();applyViewportDisplay();mainPreview.editor({tool:editorTool,snap:editorSnap});sendDevelopment();sendPresence();updateEditorControls();return;}
  if(message.type==='editor_state'){if(['select','move','rotate','scale'].includes(message.tool))editorTool=message.tool;if(typeof message.snap==='boolean')editorSnap=message.snap;updateEditorControls();return;}
  if(message.type==='history'){applyHistory(message.action).catch(report);return;}
  if(message.type==='viewport_performance'){viewportNavigation.accept(message);return;}
  if(message.type==='camera'){
    viewportNavigation.accept(message);
    $('#canvasZoomValue').hidden=message.dimension!=='2d';if(message.dimension==='2d')$('#canvasZoomValue').textContent=`${Math.round(message.zoom*100)}%`;
    annotationView={documentId:message.document_id,seq:message.seq,mode,revision:mainPreview?.sceneContext?.source_revision,
      camera:copy({position:message.position,target:message.target,view:message.view,projection:message.projection})};
    if(['perspective','top','front','right'].includes(message.view))$('#cameraView').value=message.view;
    if(message.position&&message.target)sendPresence({position:message.position,target:message.target});return;
  }
  if(message.type==='transform'&&editable()){
    if(isNative()){await handleNativeTransform(message);return;}
    if(isHierarchy()){
      if(message.phase==='start'){
        const target=docObjects().find(o=>o.id===message.id);if(!target)return;const ctx=context(),capture=hierarchyTarget(target,ctx);
        if(!matchesTransformEvent(message,capture,target.id))return;
        if(localEdit)cancelLocalEdit();drag={ctx,target:copy(target),capture,hierarchy:true};return;
      }
      const captured=drag;if(!captured?.hierarchy||captured.ctx.key!==key()||!matchesTransformEvent(message,captured.capture,captured.target.id))return;
      if(message.phase==='preview'){
        sendDragPreview({...captured.target,source_revision:captured.ctx.base},{world_matrix:message.world_matrix});
        $('#selectionStatus').textContent=`${captured.target.name} · 拖动预览 ${message.world_matrix.slice(12,15).map(fmt).join(' / ')} m`;return;
      }
      drag=null;api.scoped('drag_end');
      if(message.phase==='commit'){
        try{const payload=buildWorldTransformCommit(captured.capture,message.world_matrix,{readOnly:!editable(),transactionId:uuid()});await transact(payload.ops,{ctx:captured.ctx,payload,label:'层级手柄变换'});}
        catch(error){syncHierarchyPreviews(true);report(error);}
      }else syncHierarchyPreviews(true);
      updateSelection();syncMainPreview().catch(report);renderInspector();return;
    }
    const target=docObjects().find(o=>o.id===message.id);if(!target||!['position','rotation','scale'].every(k=>Array.isArray(message[k])&&message[k].length===3&&message[k].every(Number.isFinite)))return;
    if(message.phase==='start'){drag={ctx:context(),target:copy(target)};return;}
    if(message.phase==='preview'){
      const next=trs(message);sendDragPreview(drag?.target??target,next);$$('[data-transform]').forEach(i=>{if(document.activeElement!==i)i.value=next[i.dataset.transform][Number(i.dataset.axis)];});
      $('#selectionStatus').textContent=`${target.name} · 拖动预览 ${next.position.map(fmt).join(' / ')} m`;return;
    }
    const captured=drag;drag=null;api.scoped('drag_end');
    if(message.phase==='commit'){
      try{await patchObject(captured?.target??copy(target),trs(message),'手柄变换',captured?.ctx??context());}catch(error){report(error);}
    }else renderInspector();
  }
}

function clearPresence(){
  clearTimeout(presenceTimer);presenceTimer=null;presenceCamera=null;peers=[];selectionOrderTracker.clear();
  mainPreview?.presence?.({peers:[],local_peer:null,branch_id:branch?.branch_id,document_id:key()});
}
function developmentScope(){return {project_id:project?.id,branch_id:branch?.branch_id,resource_id:resourceId,scene_revision:mode==='edit'?branch?.head:mode==='inspect'?worldState?.frozen_revision:worldState?.scene_revision,...(mode!=='edit'&&world&&world.session_kind!=='local_preview'?{world_id:world.world_id,epoch:world.epoch}:{})};}
function sendDevelopment(){viewportAnnotations?.setProcessing(viewportDisplay.show_agents?development:[]);if(branch)mainPreview?.development({branch_id:branch.branch_id,document_id:key(),states:aggregateDevelopment(development,developmentScope())});}
function sendPresence(camera){
  if(camera)presenceCamera={scope:key(),camera};
  if(presenceTimer!==null)return;
  // Coalesce camera traffic, but always deliver the latest selection/mode.
  presenceTimer=setTimeout(()=>{
    presenceTimer=null;
    const pending=presenceCamera;presenceCamera=null;
    if(!branch||!api.ready||api.scope?.resource_id!==resourceId||api.scope?.branch_id!==branch.branch_id||api.scope?.project_id!==project?.id)return;
    lastPresence=Date.now();
    api.scoped('presence',{selected_id:mode==='edit'?selectedId:null,selected_address:mode==='edit'?(object()?.address??null):null,selected_objects:mode==='edit'?selectedSemanticObjects().map(o=>({id:o.id,...(o.address?{address:o.address}:{})})):[],selection_intent:selectionIntent,source_revision:mode==='edit'?branch.head:null,...(mode==='edit'&&isNative()?{source_identity:branch.manifest.source_identity}:{}),mode:modeLong[mode],...(pending?.scope===key()?{camera:pending.camera}:{})});
  },Math.max(0,100-(Date.now()-lastPresence)));
}
function renderInspectionUi(){
  const button=$('#inspectionUiToggle');button.hidden=mode!=='inspect';button.disabled=modePending;
  const visible=worldState?.inspection_ui_visible===true;
  button.setAttribute('aria-pressed',String(visible));button.textContent=visible?'隐藏游戏 UI':'显示游戏 UI';
}
function renderPlayControls(){
  if(!playControls)return;
  const panel=$('#playControls'),state=worldState,local=world?.session_kind==='local_preview';
  panel.hidden=!world||mode==='edit';
  const canControl=!!(world&&!local&&!world.native_shared&&api.ready&&inputEnabled&&!modePending&&mode==='play'&&state?.mode==='playing'&&state.control_ready);
  playControls.setEnabled(canControl);
  $('#playControlsTitle').textContent=mode==='inspect'?'暂停观察状态':local?'试玩运行状态':'共享世界控制';
  renderInspectionUi();
  $('#playControlActions').hidden=local||world?.native_shared===true||mode==='inspect';
  $('#playerPosition').hidden=local||world?.native_shared===true;
  $('#worldPlayerDetail').hidden=local;
  const position=state?.player_position;
  $('#playerPosition').textContent=Array.isArray(position)?`角色 ${position.map(fmt).join(' / ')} m`:'等待角色位置';
  const shown=state?.tick??0,latest=state?.latest_tick??0;
  $('#worldTick').textContent=mode==='inspect'?`${world?.native_shared?'个人画面冻结':'本局已暂停'} #${state?.frozen_tick??shown}`:`本局时刻 #${shown}`;
  Object.assign(panel.dataset,{sessionKind:world?.session_kind??'shared_world',objectStates:JSON.stringify(state?.object_states??{}),inspectionUiVisible:String(state?.inspection_ui_visible??false),mode:state?.mode??mode,displayRevision:state?.scene_revision??'',latestRevision:state?.latest_revision??'',tick:String(shown),latestTick:String(latest),frozenTick:String(state?.frozen_tick??''),playerPosition:JSON.stringify(position??null),worldId:world?.world_id??'',epoch:String(world?.epoch??''),sequence:String(state?.applied_sequence??''),latestSequence:String(state?.latest_sequence??''),frozenSequence:String(state?.frozen_sequence??''),inputZeroSeq:String(state?.input_zero_seq??''),stopAckSequence:String(state?.stop_ack_sequence??'')});
  $('#worldRevision').textContent=state?`所见版本 ${short(state.scene_revision)} · 最新 ${short(state.latest_revision)}`:'';
  $('#worldPlayerDetail').textContent=Array.isArray(state?.authoritative_player_position)?`${world?.session_kind==='local_preview'?'本局角色':'服务器角色'} ${state.authoritative_player_position.map(fmt).join(' / ')} m`:'';
}
let conversationFrame=null;
api.addEventListener('packet',({detail:p})=>{
  if(p.type==='user_updated'||p.type==='authenticated'){applyAccountUser(p.user);return;}
  if(p.type==='project_permissions'){const previous=projects.find(project=>project.id===p.project_id),revoked=['owner','editor'].includes(previous?.role)&&!['owner','editor'].includes(p.project?.role);++permissionRefreshGeneration;creationAccess(p);applyProjectPermissions(p.project,p.project_id);refreshPermissions().catch(report);inbox?.invalidate({clear:revoked});return;}
  if(p.type==='session_access_revoked'&&p.session_id===selectedSessionId){clearPermissionSession();if(branch)renderAll();return;}
  if(p.type==='inbox_changed')inbox?.invalidate();
  if(p.type==='issues_changed')scheduleIssues();
  if(p.type==='baseline'||p.type==='committed'){acceptBranch(p.branch);sendPresence();}
  if(p.type==='branch_presence'){
    if(p.project_id!==project?.id||p.branch_id!==branch?.branch_id)return;
    branchPeers=p.peers.map(peer=>({...peer,color:userColor(peer)}));renderTopbarAgents();return;
  }
  if(p.type==='presence'){
    if(p.project_id!==project?.id||p.branch_id!==branch?.branch_id||p.resource_id!==resourceId)return;
    peers=selectionOrderTracker.update(p.peers.map(peer=>({...peer,color:userColor(peer)})));
    const localPeer=peers.find(peer=>peer.peer_id===api.peerId);
    renderTopbarAgents();mainPreview?.presence?.({peers:previewPeers(peers,api.peerId),local_peer:localPeer?{...structuredClone(localPeer),user_id:localPeer.user_id??localPeer.id,id:localPeer.peer_id}:null,branch_id:branch?.branch_id,document_id:key()});
    $('#onlineStatus').textContent=`${peers.length} 个在线视口`;if(inspectorTab==='collaboration')renderInspector();
  }
  if(p.type==='drag_preview'){previews.set(`${p.preview.peer_id}/${p.preview.object_id}`,p.preview);if(isHierarchy())syncHierarchyPreviews();else if(isNative())syncNativePreviews();else if(!drag&&!localEdit)syncMainPreview().catch(report);}
  if(p.type==='drag_end'){previews.delete(`${p.peer_id}/${p.object_id}`);if(isHierarchy())syncHierarchyPreviews();else if(isNative())syncNativePreviews();else if(!drag&&!localEdit)syncMainPreview().catch(report);}
  if(p.type==='development'){scheduleRosterRefresh();development=p.states;sendDevelopment();}
  if(p.type==='development_error'){toast('开发状态暂不可用，场景保存不受影响');}
  if(p.type==='world')receiveWorld(p.packet).catch(report);
  if(p.type==='world_scene'&&world?.session_kind!=='local_preview'&&world?.world_id===p.world_id&&world.epoch===p.epoch){
    if(p.scene?.document_id!==key()||p.scene.scene_revision!==p.scene_revision)return;
    worldScenes.put(p.scene);world.scene_revision=p.scene_revision;worldScene=worldScenes.get(p.scene_revision);
    if((mode!=='edit'||modePending)&&!worldLoadPending){++sceneGeneration;mainPreview.scene({...p.scene,editable:false,frame:false,selected_id:selectedId??''}).catch(report);}
  }
  if(p.type==='inspection_recorded'&&world?.session_kind!=='local_preview'&&mode==='inspect'&&p.sequence===worldState?.frozen_sequence){inspectionRecord=p;$('#workspaceStatus').textContent=`个人检查快照已确认 #${p.sequence}`;}
  if(p.type==='session_events'||p.type==='session_event'){
    if(!validSessionPacket(p,selectedSessionId,sessionData,branch?{project_id:project.id,branch_id:branch.branch_id}:null))return;
    for(const event of p.events??[p.event]){if(!event||event.cursor<=sessionCursor||event.run&&event.run.session_id!==selectedSessionId)continue;sessionEvents.push(event);sessionCursor=event.cursor;
      if(event.kind==='run_state'||event.kind==='executor_goal'){clearTimeout(sessionRefreshTimer);sessionRefreshTimer=setTimeout(()=>refreshSession().catch(report),250);}
      if(event.kind==='executor_goal'&&sessionData){sessionData.executor_goal=copy(event.goal);const run=sessionData.runs?.find(r=>r.id===event.run_id);if(run)run.executor_goal=copy(event.goal);}
      if(event.kind==='run_state'&&sessionData){sessionData.runs??=[];const i=sessionData.runs.findIndex(r=>r.id===event.run.id);if(i<0)sessionData.runs.push(event.run);else sessionData.runs[i]=event.run;}
    }
    scheduleRosterRefresh();if(!conversationFrame)conversationFrame=requestAnimationFrame(()=>{conversationFrame=null;renderComposer();});
  }
  if(p.type==='error'){if(p.request_type==='world_input'&&p.status===409&&(p.code==='native_world_updating'||world?.native_shared&&(modePending||pendingSharedTransfer)))return;if(modePending||joinRequest)suspendWorld(`世界请求失败：${p.message}。请核对后重新进入。`);else report(Object.assign(new Error(p.message),{status:p.status}));if(branch)renderStage();}
});
api.addEventListener('status',({detail})=>{
  collaborationAccess?.setContext({user,project,connected:detail.state==='connected'});if(detail.state==='connected')refreshPermissions().catch(report);
  $('#connectionStatus').textContent={connecting:'正在连接',connected:'实时已连接',disconnected:'连接断开',error:'连接失败'}[detail.state];
  $('#connectionStatus').dataset.state=detail.state;inbox?.setConnection(detail.state==='connected');diagnostics.setConnection(detail.state==='connected');if(detail.state==='connected')scheduleIssues();
  if(detail.state==='connected'&&selectedSessionId)void refreshSession().then(()=>{if(ownSession(sessionData)&&canWrite()&&recoveryNeeded())return reconcileRun({quiet:true});}).catch(report);
  if(detail.state!=='connected'){
    clearPresence();
    peers=[];branchPeers=[];renderTopbarAgents();previews.clear();cancelLocalEdit();$('#onlineStatus').textContent='在线状态不可用';mainPreview?.presence?.({peers:[],local_peer:null,branch_id:branch?.branch_id,document_id:key()});
    if(world?.session_kind==='local_preview'){renderPlayControls();$('#workspaceStatus').textContent='协作连接中断，本窗口试玩继续；源稿操作等待重连';}
    else if(world||modePending||joinRequest)suspendWorld('实时连接中断，已停止旧角色输入并返回源稿；其他玩家不受影响。');
  }else if(connectionInterrupted){connectionInterrupted=false;$('#workspaceStatus').textContent='连接已恢复并重新订阅；点击 Play 才重新加入世界。';toast($('#workspaceStatus').textContent);}
});
api.addEventListener('authorization',({detail})=>{prefabThumbnails.clear();inbox?.reset(null);diagnostics.setUser(null);assetIssues=[];++issuesGeneration;renderIssueMarkers();clearTopbar();if(world||modePending)suspendWorld('授权失效，旧角色输入已停止。');toast(detail.message);$('#workspaceStatus').textContent='授权失效，请退出并重新登录';});
async function validateOrPublish(action){
  if(!branch||!canWrite())return;const ctx=context();$('#workspaceStatus').textContent=action==='publish'?'正在验证并应用到实际世界…':'正在运行 Godot 候选验证…';
  const result=await api.api(`${branchRoute()}/${action}`,{method:'POST',body:{resource_id:resourceId,revision:branch.head}});
  modal(action==='publish'?'实际应用回执':'Godot 验证结果',`<p>源版本 ${esc(short(ctx.base))}。下方为中央服务返回的真实结果，玩家体验仍需实际试玩核对。</p><pre>${esc(JSON.stringify(result,null,2))}</pre>`,[{label:'关闭',action:closeModal}]);
  $('#workspaceStatus').textContent=action==='publish'?`世界已确认应用 ${short(result.delivery?.revision)}`:`验证状态：${result.status}`;
}
$('#closeModal').onclick=closeModal;$('#modal').addEventListener('cancel',e=>{e.preventDefault();closeModal();});bindDialogDismiss($('#modal'),closeModal);
$('#openChat').onclick=()=>$('#chatDrawer').hidden?openChat(true):closeChat();$('#closeChat').onclick=()=>closeChat();
$('#toggleSessions').onclick=()=>$('#chatSessions').hidden?openSessionPicker():closeSessionPicker(true);
$('#expandChat').onclick=()=>{const wide=$('#chatDrawer').classList.toggle('is-wide');$('#expandChat').setAttribute('aria-pressed',String(wide));$('#expandChat').setAttribute('aria-label',wide?'收起聊天阅读区':'展开聊天阅读区');resizeDraft();};
$('#sessionList').addEventListener('click',e=>{if(e.target.closest('button[data-session]'))closeSessionPicker(true);});
$('#sessionSearch').oninput=renderSessions;$('#sessionName').onchange=e=>renameSessionTitle(selectedSessionId,e.target.value);$('#sessionName').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur();}};
for(const type of ['pointerdown','focusin'])document.addEventListener(type,e=>{if(!$('#chatSessions').hidden&&!$('#chatSessions').contains(e.target)&&!$('#toggleSessions').contains(e.target))closeSessionPicker();});
$('#copySessionId').onclick=async()=>{
  const id=sessionData?.id;if(!id||id!==selectedSessionId)return;
  const field=$('#sessionId');
  try{
    if(navigator.clipboard?.writeText&&window.isSecureContext)await navigator.clipboard.writeText(id);
    else {field.focus();field.select();if(!document.execCommand('copy'))throw new Error('clipboard_unavailable');}
    toast('会话 ID 已复制');
  }catch{
    if(sessionData?.id===id&&selectedSessionId===id){field.focus();field.select();}
    toast('无法自动复制，请选中会话 ID 后手动复制。');
  }
};
$('#chatSettings').addEventListener('toggle',()=>{if($('#chatSettings').open)closeSessionPicker();});
for(const type of ['pointerdown','focusin'])document.addEventListener(type,e=>{
  for(const menu of $$('#chatSettings[open],.semantic-quick-actions[open],.prefab-card-menu[open],.composer-help[open]'))if(!menu.contains(e.target))menu.open=false;
});
$('.composer-content').addEventListener('scroll',updateChatScroll,{passive:true});
$('#jumpLatest').onclick=()=>{const scroller=$('.composer-content');scroller.scrollTop=scroller.scrollHeight;updateChatScroll();};
$('#sessionDraft').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();e.stopPropagation();if(!$('#sendDraft').disabled)sendDraft().catch(report);}});
$('#chatDrawer').addEventListener('keydown',e=>{if(e.key!=='Escape'||e.isComposing||e.defaultPrevented)return;if($('#chatSettings').open){$('#chatSettings').open=false;$('#chatSettings summary').focus();e.preventDefault();e.stopPropagation();}else if(!$('#chatSessions').hidden){$('#chatSessions').hidden=true;$('#toggleSessions').setAttribute('aria-expanded','false');$('#toggleSessions').focus();e.preventDefault();e.stopPropagation();}});

document.addEventListener('pointerdown',e=>{if(!$('#chatDrawer').hidden&&!$('#modal').open&&!$('#chatDrawer').contains(e.target)&&!$('#openChat').contains(e.target)&&!$('.atelier-topbar').contains(e.target))closeChat(false);});
$('#authForm').onsubmit=async e=>{
  e.preventDefault();const button=$('#authSubmit');button.disabled=true;$('#authError').textContent='';
  try{const result=await api.api(`auth/${$('#authMode').value}`,{method:'POST',body:{name:$('#authName').value.trim(),password:$('#authPassword').value}});api.login(result.token);$('#authPassword').value='';await bootstrap();}
  catch(error){$('#authError').textContent=errorText(error);}finally{button.disabled=false;}
};
$('#authMode').onchange=e=>{$('#authSubmit').textContent=e.target.value==='register'?'注册并进入':'登录工作台';$('#authPassword').autocomplete=e.target.value==='register'?'new-password':'current-password';};
$('#renameAccount').onclick=()=>{
  if(!user)return;const owner=user.id,expectedName=user.name;
  const active=modal('修改账号名',`<p class="dialog-intro">新名称将用于登录和协作显示，密码保持不变。</p><label class="dialog-field">新账号名<input id="newAccountName" required maxlength="160" data-autofocus autocomplete="off" value="${esc(expectedName)}" data-validation-message="请输入新账号名。"></label><p class="dialog-footnote">支持中文，最多 160 个字符；名称不能与其他账号重复。你的游戏、权限、会话和身份色会保留。</p>`,[{label:'取消',action:closeModal},{label:'保存名称',primary:true,busyLabel:'正在保存…',action:async()=>{
    if(!active()||user?.id!==owner)return;
    const name=$('#newAccountName').value.trim();if(!name)throw new Error('请输入新账号名');
    const result=await api.api('auth/profile',{method:'PATCH',body:{name,expected_name:expectedName}});
    if(user?.id!==owner)return;applyAccountUser(result.user);if(active())closeModal();toast(`账号名已改为 ${result.user.name}，下次登录请使用新名称。`);
  }}]);closeTopbarMenu(false);
};
$('#adminEntry').onclick=async()=>{try{await api.api('admin/access',{method:'POST',body:{}});location.assign('/admin');}catch(error){toast(errorText(error));}};
$('#logout').onclick=async()=>{++catalogNavigation;gameCatalog?.reset();++branchLoadGeneration;clearTopbar();prefabThumbnails.clear();cancelLocalEdit();disposeHierarchyPanel();resolvedDocuments.clear();loadedSourceScene=null;try{await flushDraft();await api.api('auth/logout',{method:'POST',body:{}});}catch(error){toast(errorText(error));}++sessionLoadGeneration;api.selectSessionBoundary();leaveWorld();api.logout();imagePreviews.clear();inbox?.reset(null);diagnostics.setUser(null);assetIssues=[];++issuesGeneration;$('#inboxButton').hidden=true;user=null;project=null;branch=null;sessionData=null;selectedSessionId=null;draftCache.clear();semanticModes.clear();semanticDetails.clear();inspectorSectionState.clear();semanticSelection={key:null,ids:[],primary:null,anchor:null};semanticComposer?.clear();semanticInspector?.destroy();semanticInspector=null;semanticInspectorRoot=null;sessionTitleConfirmations.clear();sessions=[];document.body.classList.remove('is-editing');$('#workbench').hidden=true;$('#landing').hidden=true;$('#authView').hidden=false;$('#logout').hidden=true;$('#accountName').textContent='未登录';$('#accountAvatar').textContent='·';peers=[];renderTopbar();closeChat(false);};

function leaveWorkspaceForCatalog(){++branchLoadGeneration;clearTopbar();prefabThumbnails.clear();flushDraft().catch(report);++sessionLoadGeneration;api.selectSessionBoundary();sessionEvents=[];sessionCursor=0;sessions=[];cancelLocalEdit();leaveWorld();api.unsubscribe();branch=null;sessionData=null;selectedSessionId=null;closeChat(false);document.body.classList.remove('is-editing');$('#workbench').hidden=true;$('#landing').hidden=false;peers=[];renderTopbar();}
$('#backBranches').onclick=()=>navigateCatalog({projectId:project?.id});
$$('[data-explorer]').forEach(b=>b.onclick=()=>{explorerTab=b.dataset.explorer;$('#contentSearch').value='';renderExplorer();});
$$('[data-inspector]').forEach(b=>b.onclick=()=>{inspectorTab=b.dataset.inspector;renderInspector();});
$$('[data-mode]').forEach(b=>b.onclick=()=>setMode(b.dataset.mode).catch(report));$('#returnLive').onclick=()=>setMode('play').catch(report);
$('#sharedWorldButton').onclick=()=>openSharedWorld().catch(report);
$('#restartPlay').onclick=()=>restartPlay().catch(report);
$('#inspectionUiToggle').onclick=()=>{if(!world||mode!=='inspect'||modePending)return;mainPreview.world({action:'inspection_ui',world_id:world.world_id,epoch:world.epoch,visible:worldState?.inspection_ui_visible!==true});};
$('#playWebButton').onclick=()=>{if(!doc()||doc().kind!=='scene'||localCommitPending||localEdit||drag)return;releaseBuilds?.playWeb(resourceId,$('#playWebButton')).catch(report);};
$('#createAnchor').onclick=()=>createAnchor().catch(report);
$('#togglePrefabShelf').onclick=()=>{const toggle=$('#togglePrefabShelf'),open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));$('#prefabShelfList').hidden=!open;};
let marketOverlay=null,marketMount=null;
function closeAssetMarket(){marketMount?.dispose();marketMount=null;marketOverlay?.remove();marketOverlay=null;}
function openAssetMarket(assetId){closeAssetMarket();marketOverlay=document.createElement('section');marketOverlay.className='market-overlay';marketOverlay.setAttribute('aria-label','资源市场');document.body.append(marketOverlay);marketMount=mountAssetMarket(marketOverlay,{api,assetId,onClose:closeAssetMarket,getContext:()=>branch&&editable()?context():null,onImported:({result},ctx)=>{if(project?.id===ctx.projectId&&branch?.branch_id===ctx.branchId)acceptBranch(result.branch);}});}
$('#browseMarket').onclick=()=>openAssetMarket();
$('#toggleMarketShelf').onclick=async()=>{const toggle=$('#toggleMarketShelf'),list=$('#marketShelfList'),open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));list.hidden=!open;if(!open)return;list.textContent='正在加载…';try{const data=await api.api('market?publisher=official&limit=6');list.innerHTML=data.assets.map(a=>`<button class="market-mini" data-market-asset="${esc(a.id)}"><img src="${esc(a.thumbnail_url)}" alt=""><span>${esc(a.name)}</span></button>`).join('')||'暂无官方资源';list.querySelectorAll('[data-market-asset]').forEach(button=>button.onclick=()=>openAssetMarket(button.dataset.marketAsset));}catch(error){list.textContent=error.message;}};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&marketOverlay){event.preventDefault();event.stopImmediatePropagation();closeAssetMarket();}},true);
$('#toggleSceneList').onclick=()=>{const list=$('#sceneList');list.hidden=!list.hidden;$('#toggleSceneList').setAttribute('aria-expanded',String(!list.hidden));};
$('#addHierarchyGroup').onclick=addHierarchyGroup;
$('#toggleTreeSearch').onclick=()=>{const search=$('#treeSearch');search.hidden=!search.hidden;$('#toggleTreeSearch').setAttribute('aria-expanded',String(!search.hidden));if(!search.hidden)$('#contentSearch').focus();else{$('#contentSearch').value='';renderExplorer();}};
$('#contentSearch').oninput=()=>renderExplorer();
$('#contentSearch').onkeydown=e=>{
  if(e.isComposing)return;
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();e.currentTarget.value='';renderExplorer();}
  if(e.key==='ArrowDown'){e.preventDefault();const first=$('#explorerList [data-select]');if(first)focusExplorerRow(first.dataset.select);}
};
$('#explorerList').addEventListener('scroll',rememberExplorerView,{passive:true});
$('#collapseTree').onclick=e=>{
  if(!currentExplorerTree)return;const state=explorerTreeStates.get(displayedExplorerScope);
  for(const row of currentExplorerTree.rows)if(currentExplorerTree.children.has(row.key))setExplorerExpanded(currentExplorerTree,state,row.key,e.altKey);
  renderExplorer();
};
$('#revealTreeSelection').onclick=()=>{
  if(!selectedId)return;$('#contentSearch').value='';renderExplorer({reveal:selectedId,scrollToSelection:true});focusExplorerRow(selectedId);
};
for(const id of ['showPeerSelections','showPeerCameras','showAgentOutlines','outlineWidth','outlineOpacity'])$('#'+id).addEventListener('input',()=>{
  viewportDisplay=normalizeDisplay({show_selections:$('#showPeerSelections').checked,show_cameras:$('#showPeerCameras').checked,show_agents:$('#showAgentOutlines').checked,width:Number($('#outlineWidth').value),opacity:Number($('#outlineOpacity').value)/100});
  if(user?.id)try{localStorage.setItem(displayKey(user.id),JSON.stringify(viewportDisplay));}catch{}
  applyViewportDisplay();
});
window.addEventListener('storage',event=>{if(user?.id&&event.key===displayKey(user.id)){viewportDisplay=readDisplay(localStorage,user.id);applyViewportDisplay();}});
$('#focusView').onclick=()=>requestMainCamera('focus');$('#resetView').onclick=()=>requestMainCamera('fit');$('#cameraView').onchange=e=>requestMainCamera(e.target.value);
inbox=new InboxWorkspace({trigger:$('#inboxButton'),load:({context,filter,cursor,target,signal})=>{const query=new URLSearchParams({filter});if(cursor)query.set('cursor',cursor);if(target){if(target.resource_id||target.address?.resource_id)query.set('target',JSON.stringify(target));if(target.project_id)query.set('project_id',target.project_id);if(target.branch_id)query.set('branch_id',target.branch_id);}return api.api(`inbox?${query}`,{signal});},getItem:(id,{signal})=>api.api(`inbox/${encodeURIComponent(id)}`,{signal}),markRead:(id,{expected_version,request_id,signal})=>api.api(`inbox/${encodeURIComponent(id)}/read`,{method:'POST',body:{expected_version,request_id},signal}),onAction:inboxAction,onOpen:()=>{closeTopbarMenu(false);cancelLocalEdit();}});
try{
  const health=await api.api('health');
  if(health.collaboration_access){const {CollaborationAccess}=await import('./collaboration-access.js');collaborationAccess=new CollaborationAccess({api,getState:()=>({user,project,connected:api.ready}),onChanged:()=>refreshPermissions().catch(report),toast,userColor});}
}catch(error){console.warn('协作界面暂不可用',error.message);}
if(!collaborationAccess){const unavailable=()=>toast('协作权限功能正在更新，请稍后刷新。');collaborationAccess={setContext(){},refresh(){},open:unavailable,dispose(){}};$('#catalogCollaboration').onclick=unavailable;}
window.addEventListener('pagehide',()=>collaborationAccess.dispose());
window.addEventListener('pagehide',()=>{inbox.destroy();diagnostics.dispose();});
$('#retryTurn').onclick=()=>retryTurn().catch(report);
$('#sessionUser').onchange=e=>{sessionFilter=e.target.value;renderSessions();};$('#newSession').onclick=newSession;
$('#sessionDraft').oninput=e=>{resizeDraft();updateSendButton();if(!ownSession(sessionData))return;draftCache.set(selectedSessionId,e.target.value);clearTimeout(saveDraftTimer);saveDraftTimer=setTimeout(()=>flushDraft().catch(report),650);$('#draftStatus').textContent='草稿正在保存…';};
$('#sessionModel').onchange=e=>saveSessionSettings({model:e.target.value,effort:null});
$('#sessionEffort').onchange=e=>saveSessionSettings({effort:e.target.value||null});
$('#sessionAccess').onchange=e=>saveSessionSettings({access_mode:e.target.value});
$('#sessionVisibility').onchange=async e=>{const sid=selectedSessionId;try{const s=await api.api(sessionRoute(sid),{method:'PATCH',body:{visibility:e.target.value}});if(sid===selectedSessionId)Object.assign(sessionData,s);renderComposer();renderSessions();}catch(error){report(error);}};
$('#attachSelection').onclick=()=>attachCurrent(selectedSessionId).catch(report);$('#sendDraft').onclick=()=>sendDraft().catch(report);
$('#interruptRun').onclick=async()=>{try{await api.api(`${sessionRoute()}/interrupt`,{method:'POST',body:{}});await refreshSession();}catch(error){report(error);}};
$('#refreshSession').onclick=()=>refreshSession().catch(report);$('#allAttachments').onclick=showAttachmentRecords;
$('#undoTransform').onclick=()=>applyHistory('undo').catch(report);$('#redoTransform').onclick=()=>applyHistory('redo').catch(report);
$$('[data-tool]').forEach(b=>b.onclick=()=>{editorTool=b.dataset.tool;mainPreview?.editor({tool:editorTool,snap:editorSnap});updateEditorControls();if(!$('#viewportMore').open)mainPreview?.frame.contentWindow.focus();});
$('#toggleSnap').onclick=()=>{editorSnap=!editorSnap;mainPreview?.editor({tool:editorTool,snap:editorSnap});updateEditorControls();};
playControls=new PlayControls($('#playControls'),intent=>{
  if(!world||world.session_kind==='local_preview'||!api.ready||!inputEnabled)return;
  mainPreview?.control({...intent,world_id:world.world_id,epoch:world.epoch,scene_revision:world.scene_revision});
});
function closeInteractionGuide(restore=false){$('#interactionGuide').hidden=true;$('#interactionHelp').setAttribute('aria-expanded','false');if(restore)$('#interactionHelp').focus();}
$('#interactionHelp').onclick=()=>{const guide=$('#interactionGuide');guide.hidden=!guide.hidden;$('#interactionHelp').setAttribute('aria-expanded',!guide.hidden);if(!guide.hidden)positionFloatingPanel(guide,$('#interactionHelp'),{above:true});};
for(const type of ['pointerdown','focusin'])document.addEventListener(type,e=>{if(!$('#interactionGuide').contains(e.target)&&!$('#interactionHelp').contains(e.target))closeInteractionGuide();});
const narrowWorkspace=matchMedia('(max-width:639px)');let treeShown=!narrowWorkspace.matches,inspectorShown=!narrowWorkspace.matches,expanded=false;
function showInspectorPanel(){expanded=false;inspectorShown=true;if(narrowWorkspace.matches)treeShown=false;updatePanels();}
function updatePanels(){document.body.classList.toggle('tree-collapsed',!treeShown);document.body.classList.toggle('inspector-collapsed',!inspectorShown);document.body.classList.toggle('viewport-expanded',expanded);$('#toggleTree').setAttribute('aria-pressed',treeShown&&!expanded);$('#toggleInspector').setAttribute('aria-pressed',inspectorShown&&!expanded);$('#expandViewport').setAttribute('aria-pressed',expanded);$('#expandViewport').textContent=expanded?'恢复':'展开';}
$('#toggleTree').onclick=()=>{const visible=treeShown&&!expanded;if(expanded)inspectorShown=false;expanded=false;treeShown=!visible;if(narrowWorkspace.matches&&treeShown)inspectorShown=false;updatePanels();};
$('#toggleInspector').onclick=()=>{const visible=inspectorShown&&!expanded;if(expanded)treeShown=false;expanded=false;inspectorShown=!visible;if(narrowWorkspace.matches&&inspectorShown)treeShown=false;updatePanels();};
$('#expandViewport').onclick=()=>{expanded=!expanded;updatePanels();};narrowWorkspace.addEventListener('change',()=>{treeShown=!narrowWorkspace.matches;inspectorShown=!narrowWorkspace.matches;updatePanels();});updatePanels();
document.addEventListener('keydown',e=>{
  if(e.defaultPrevented||e.isComposing)return;
  if(e.key==='Escape'&&!$('#chatDrawer').hidden&&!document.querySelector('dialog[open]')){e.preventDefault();closeChat();return;}
  if(e.defaultPrevented||document.querySelector('dialog[open]')||!$('#workbench').contains(e.target)||e.composedPath().some(node=>node?.matches?.('input,textarea,select,[contenteditable=true]')))return;
  const k=e.key.toLowerCase();
  if((e.ctrlKey||e.metaKey)&&['z','y'].includes(k)){e.preventDefault();applyHistory(k==='y'||e.shiftKey?'redo':'undo').catch(report);return;}
  if(e.target!==$('#viewport')||e.ctrlKey||e.metaKey||e.altKey)return;
  const tool={q:'select',w:'move',e:'rotate',r:'scale'}[k];if(tool&&editable()){e.preventDefault();editorTool=tool;mainPreview?.editor({tool,snap:editorSnap});updateEditorControls();}
  if(k==='f'){e.preventDefault();requestMainCamera(e.shiftKey?'fit':'focus');}
  const planar=isNative()&&object()?.dimension==='2d';const axis=(planar?{ArrowRight:[0,1],ArrowLeft:[0,-1],ArrowUp:[1,-1],ArrowDown:[1,1]}:{ArrowRight:[0,1],ArrowLeft:[0,-1],ArrowUp:[2,-1],ArrowDown:[2,1],PageUp:[1,1],PageDown:[1,-1]})[e.key];
  if(axis&&editable()&&object()){e.preventDefault();const target=copy(object()),ctx=context();if(isNative()){if(target.dimension==='3d'){const next=[...target.world_matrix];next[12+axis[0]]+=axis[1]*(e.shiftKey?.025:.25);transact([nativeWorldTransformOperation(target,next,ctx)],{ctx,label:'键盘移动'}).catch(report);}else if(target.dimension==='2d'){const next=nativeTransformFields(target);if(next){next.position[axis[0]]+=axis[1]*(e.shiftKey?1:10);patchObject(target,{position:next.position},'键盘移动',ctx).catch(report);}}}else if(isHierarchy()){const capture=hierarchyTarget(target,ctx),position=capture.world_matrix.slice(12,15);position[axis[0]]+=axis[1]*(e.shiftKey?.025:.25);const payload=buildWorldTransformCommit(capture,withWorldPosition(capture.world_matrix,position),{readOnly:!editable(),transactionId:uuid()});transact(payload.ops,{ctx,payload,label:'层级键盘移动'}).catch(report);}else{const next=trs(target);next.position[axis[0]]+=axis[1]*(e.shiftKey?.025:.25);patchObject(target,next,'键盘变换',ctx).catch(report);}}
});
document.addEventListener('click',e=>{
  const button=e.target.closest('[data-action]');if(!button)return;const actions={nativeNewNode:createNativeNode,migrateHierarchy,newGame,newBranch,invite,joinInvite,newSession,merge:mergeBranch,reconcile:reconcileRun,newResource:createResource,deleteObject:()=>{const target=object();if(!editable()||!target)return;if(isHierarchy()){showInspectorPanel();toast('请在层级属性中选择删除节点或整个实例，并确认子内容范围。');return;}return transact([isNative()?nativeDeleteOperation(target,context()):{type:'delete_object',resource_id:resourceId,object_id:target.id,expected_version:target.version}],{label:'删除对象'});},import:importModel,generateModel:agentEntry,generateScene:agentEntry,validate:()=>validateOrPublish('validate'),publish:()=>isNative()?openSharedWorld():validateOrPublish('publish'),conflicts:()=>modal('保留的冲突与不确定提交',`<pre>${esc(JSON.stringify([...pendingEdits.values()],null,2))}</pre>`,[{label:'关闭',action:closeModal}])};
  if(!canWrite()&&['migrateHierarchy','newBranch','newSession','merge','reconcile','newResource','deleteObject','import','generateModel','generateScene','validate','publish'].includes(button.dataset.action)){collaborationAccess.open({tab:'requests'});return;}
  try{Promise.resolve(actions[button.dataset.action]?.()).catch(report);}catch(error){report(error);}
});
$('#designHelp').onclick=()=>modal('当前工作台',`<p>项目、分支文档、成员、会话、固定附件由中央服务器管理。Godot Web 在当前视口渲染和游玩。源稿修改与已验证的运行世界分别保留，只有真实验证和应用回执才能证明交付。</p><p>Codex 使用本机 App Server、真实模型目录和已登录账户。命令、文件改动、工具及失败原样展示；需要审批时等待你的决定。</p>`,[{label:'返回',action:closeModal}]);
window.addEventListener('pagehide',()=>{prefabThumbnails.dispose();clearInterval(previewExpiryTimer);clearTimeout(sessionRefreshTimer);disposeHierarchyPanel();api.disconnect();mainPreview?.dispose();editorPreview?.dispose();objectPreview?.dispose();});

for(const [id,menu]of [['branchMenuButton','branchMenu'],['collaboratorsButton','agentsMenu'],['interfaceMenuButton','interfaceMenu'],['accountMenuButton','accountMenu']])$('#'+id).onclick=e=>toggleTopbarMenu(menu,e.currentTarget);
for(const id of ['toggleTree','toggleInspector'])$('#topbarPanelActions').append($('#'+id));
$('#workspaceHome').onclick=()=>{closeTopbarMenu(false);navigateCatalog({});};
$('#topbarAllBranches').onclick=()=>{closeTopbarMenu(false);navigateCatalog({projectId:project?.id});};
$('#topbarBranchSearch').oninput=filterTopbarBranches;
$$('[data-topbar-action]').forEach(button=>button.onclick=()=>{closeTopbarMenu(false);$(`[data-action="${button.dataset.topbarAction}"]`).click();});
$('#topbarFocus').onclick=()=>{closeTopbarMenu(false);$('#expandViewport').click();};
$('#topbarNewSession').onclick=$('#topbarQuickSession').onclick=$('#quickNewSession').onclick=()=>newSession();
$('#agentsMenuButton').setAttribute('aria-controls','chatDrawer');$('#agentsMenuButton').onclick=()=>{closeTopbarMenu(false);if(!$('#chatDrawer').hidden){closeChat();return;}if(selectedSessionId)openChat(true);else if(canWrite())newSession();else openChat(false);};
$('#topbarCurrentSession').onclick=()=>{closeTopbarMenu(false);openChat(true);chatFocus=$('#agentsMenuButton');};
$('#agentSearch').oninput=renderTopbarAgents;$('#refreshAgents').onclick=()=>agentRoster.refresh();
document.addEventListener('pointerdown',e=>{if(topbarMenu&&!$('#'+topbarMenu).contains(e.target)&&!topbarTrigger?.contains(e.target))closeTopbarMenu(false);});
document.addEventListener('keydown',e=>{if(topbarMenu&&e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeTopbarMenu();}},true);
document.addEventListener('focusin',e=>{if(topbarMenu&&!$('#'+topbarMenu).contains(e.target)&&!topbarTrigger?.contains(e.target))closeTopbarMenu(false);});
const rosterInterval=setInterval(()=>{if(!document.hidden)agentRoster.refresh();},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)agentRoster.refresh();});
window.addEventListener('pagehide',()=>{clearInterval(rosterInterval);clearTimeout(rosterRefreshTimer);agentRoster.reset();});
// These disclosures only reorganize existing controls; they never remount a viewport.
function closeWorkspaceDisclosure(menu,restoreFocus=false){
  if(!menu?.open)return;
  const containedFocus=menu.contains(document.activeElement);
  menu.open=false;
  if(restoreFocus||containedFocus&&!document.querySelector('dialog[open]'))menu.querySelector('summary').focus();
}
$('#buildHistory').onclick=()=>releaseBuilds?.open('history',$('#interfaceMenuButton'));
const workspaceDisclosures=$$('.workspace-disclosure');
// Dynamically rendered inspector/card menus share the same placement rules.
const floatingDetails='#chatSettings,.semantic-quick-actions,.prefab-card-menu,.composer-help';
function positionDetails(menu){
  const panel=menu.querySelector('.session-settings,.semantic-ai-menu,.prefab-card-actions,#composerHint');
  positionFloatingPanel(panel,menu.querySelector('summary'),{above:menu.matches('.composer-help')});
}
document.addEventListener('toggle',e=>{
  if(!e.target.matches?.(floatingDetails)||!e.target.open)return;
  for(const other of $$(floatingDetails))if(other!==e.target)other.open=false;
  positionDetails(e.target);
},true);
function repositionOverlays(){
  if(topbarMenu)positionFloatingPanel($('#'+topbarMenu),topbarTrigger,{align:topbarMenu==='branchMenu'?'start':'end'});
  for(const menu of $$(floatingDetails))if(menu.open)positionDetails(menu);
  for(const menu of workspaceDisclosures)if(menu.open)positionFloatingPanel(menu.querySelector('.workspace-menu'),menu.querySelector('summary'),{align:menu.id==='documentMenu'?'start':'end'});
  if(!$('#interactionGuide').hidden)positionFloatingPanel($('#interactionGuide'),$('#interactionHelp'),{above:true});
}
window.addEventListener('resize',repositionOverlays);
document.addEventListener('scroll',e=>{
  if(e.target.matches?.('.workspace-menu,.topbar-popover,.session-settings,.semantic-ai-menu,.prefab-card-actions,#composerHint,.interaction-guide')||e.target.closest?.('.workspace-menu,.topbar-popover,.session-settings'))return;
  repositionOverlays();
},true);
for(const menu of workspaceDisclosures){
  menu.addEventListener('toggle',()=>{
    if(!menu.open)return;
    positionFloatingPanel(menu.querySelector('.workspace-menu'),menu.querySelector('summary'),{align:menu.id==='documentMenu'?'start':'end'});
    if(!menu.closest('.topbar-popover'))closeTopbarMenu(false);
    for(const other of workspaceDisclosures)if(other!==menu)closeWorkspaceDisclosure(other);
  });
  menu.addEventListener('click',e=>{
    if(e.target.closest('button:not(:disabled)')&&!e.target.closest('[data-keep-open],#inspectionUiToggle'))closeWorkspaceDisclosure(menu);
  });
}
document.addEventListener('pointerdown',e=>{
  for(const menu of workspaceDisclosures)if(!menu.contains(e.target))closeWorkspaceDisclosure(menu);
});
document.addEventListener('focusin',e=>{
  for(const menu of workspaceDisclosures)if(!menu.contains(e.target))closeWorkspaceDisclosure(menu);
});
window.addEventListener('blur',()=>{
  setTimeout(()=>{
    if(document.activeElement?.tagName!=='IFRAME'||document.querySelector('dialog[open]'))return;
    closeTopbarMenu(false);closeSessionPicker();closeInteractionGuide();
    for(const menu of $$('#chatSettings[open],.semantic-quick-actions[open],.prefab-card-menu[open],.composer-help[open]'))menu.open=false;
    for(const menu of workspaceDisclosures)if(menu.open)menu.open=false;
  },0);
});
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||document.querySelector('dialog[open]'))return;
  if(!$('#interactionGuide').hidden){e.preventDefault();e.stopImmediatePropagation();closeInteractionGuide(true);return;}
  const menu=workspaceDisclosures.find(item=>item.open)??$('#chatSettings[open],.semantic-quick-actions[open],.prefab-card-menu[open],.composer-help[open]');if(!menu)return;
  e.preventDefault();e.stopImmediatePropagation();closeWorkspaceDisclosure(menu,true);
},true);
// Approved warm workbench: compact presentation of existing actions and live status.
{
  const toolbar=$('.viewport-toolbar'),more=$('#viewportMore .viewport-menu');
  toolbar.insertBefore($('#displayMenu'),$('.viewport-run-controls'));
  const section=(title,controls,keepOpen=false)=>{const group=document.createElement('section');group.className='overlay-section';if(keepOpen)group.dataset.keepOpen='';const label=document.createElement('div');label.className='workspace-menu-label';label.textContent=title;group.append(label,...controls);return group;};
  const tools=$('.transform-tools'),camera=$('.camera-pad');
  for(const button of tools.querySelectorAll('[data-tool]'))button.firstChild.textContent={select:'选择',move:'移动',rotate:'旋转',scale:'缩放'}[button.dataset.tool];
  more.prepend(section('编辑工具',[tools],true),section('视角',[camera],true));
  more.append(section('场景资料',[$('#captureGameCover'),$('#autoCoverStatus'),$('#browseKnowledge')]));
  const buildActions=$('#releaseBuildActions');
  $('#interfaceMenu').append(buildActions);
  $('.atelier-topbar').insertBefore($('#interfaceMenuButton'),$('.account-rule'));
  const status=$('#workspaceStatus');
  $('.topbar-leading').append(status);
  const updateStatus=()=>{status.title=status.textContent;status.dataset.state=/^(源稿就绪|已保存|场景已更新|3D 已就绪)/.test(status.textContent)?'saved':/失败|错误|失效|冲突|缺少/.test(status.textContent)?'error':'pending';};
  new MutationObserver(updateStatus).observe(status,{childList:true,characterData:true,subtree:true});updateStatus();
}

function annotationScope(){
  if(!user||!project||!branch||!doc())return null;
  const preview=mainPreview;
  return {user_id:user.id,project_id:project.id,branch_id:branch.branch_id,resource_id:resourceId,resource_name:doc().name,revision:branch.head,objects:docObjects(),editing:canWrite()&&mode==='edit'&&!modePending&&!prefabLabSubject,available:canWrite()&&mode==='edit'&&!modePending&&!prefabLabSubject&&!localEdit&&!drag&&!localCommitPending&&preview?.ready&&!preview.pending&&preview.loadedSeq===preview.seq&&preview.sceneContext?.document_id===key()&&preview.sceneContext?.source_revision===branch.head};
}
const viewportNavigation=new ViewportNavigation({viewport:$('#viewport'),menu:$('#navigationSettings'),preview:()=>mainPreview,userId:()=>user?.id});
viewportAnnotations=new ViewportAnnotations({viewport:$('#viewport'),button:$('#toggleAnnotations'),scope:annotationScope,preview:()=>mainPreview,onError:report,onCopied:()=>toast('已复制批注，可粘贴到其他 Agent'),onChange:updateEditorControls,screenshot:annotateViewportScreenshot,
  save:async(batch,scope)=>{
    await flushDraft();
    const created=await api.api(`${branchRoute(scope.project_id,scope.branch_id)}/annotation-drafts`,{method:'POST',body:{batch_id:batch.batch_id,annotations:batch.annotations.map(annotationInput)}});
    if(user?.id!==scope.user_id||branchKey()!==`${scope.project_id}/${scope.branch_id}`)return created;
    if(!sessions.some(s=>s.id===created.id))sessions.push(created);draftCache.set(created.id,created.draft);scheduleRosterRefresh();sessionFilter='mine';await selectSession(created.id);openChat(true);toast('批注已放入新 Agent 草稿，点击发送后开始处理');return created;
  }});
async function annotateViewportScreenshot(batch,scope){
  const preview=mainPreview,seq=preview.seq,documentId=preview.sceneContext.document_id,scopeKey=`${scope.project_id}/${scope.branch_id}`,navigation=branchLoadGeneration;
  const current=()=>user?.id===scope.user_id&&branchKey()===scopeKey&&resourceId===scope.resource_id&&branchLoadGeneration===navigation&&canWrite();
  const assertCurrent=()=>{if(!current())throw Error('场景、分支、账号或权限已变化，未保存到其他会话');};
  const image=await preview.captureFrame();
  assertCurrent();
  if(mainPreview!==preview||seq!==preview.seq||image.document_id!==documentId||image.source_revision!==scope.revision)throw Error('截图期间场景已变化，请重新截图');
  const capturedAt=new Date().toISOString(),imageName=`${scope.resource_name.slice(0,50)}-划线批注-${uuid().slice(0,8)}`,camera=preview.lastCameraEvent;
  const cameraContext=camera?.seq===seq&&camera.document_id===documentId?{position:camera.position,target:camera.target,view:camera.view,projection:camera.projection}:null;
  let created=null,baseDraft=null,complete=false;
  const saved=await editScreenshot({dataUrl:image.data_url,subtitle:`${scope.resource_name} · ${scope.branch_id} · ${short(scope.revision)} · 画面已固定`,onSave:async({blob,note,strokeCount})=>{
    assertCurrent();await flushDraft();assertCurrent();
    if(!created){
      created=batch.annotations.length
        ?await api.api(`${branchRoute(scope.project_id,scope.branch_id)}/annotation-drafts`,{method:'POST',body:{batch_id:batch.batch_id,annotations:batch.annotations.map(annotationInput)}})
        :await api.api(`${branchRoute(scope.project_id,scope.branch_id)}/sessions`,{method:'POST',body:{title:'截图批注',visibility:'shared',model:agentStatus?.default_model??null}});
      baseDraft=created.draft??'';
    }
    assertCurrent();
    const sid=created.id;
    // Reconcile an interrupted upload before retrying. A successful upload's
    // response may have been lost; the unique name plus digest identifies it.
    const digest=await sha256Hex(await blob.arrayBuffer()),latest=await api.api(sessionRoute(sid));assertCurrent();
    const previous=latest.draft_attachments.filter(a=>a.kind==='image'&&a.name.startsWith(imageName));
    if(latest.messages.length||latest.draft!==baseDraft&&latest.draft!==created.draft)throw Error('截图草稿已在其他窗口修改，请在该会话中继续');
    const job=(async()=>{
      let attachment=previous.find(a=>a.sha256===digest);
      if(!attachment)attachment=await api.api(`${sessionRoute(sid)}/image-attachments?name=${encodeURIComponent(imageName+(blob.type==='image/png'?'.png':'.jpg'))}`,{method:'POST',body:blob,headers:{'Content-Type':blob.type}});
      assertCurrent();
      for(const old of previous)if(old.id!==attachment.id)await api.api(`${sessionRoute(sid)}/attachments/${encodeURIComponent(old.id)}`,{method:'DELETE'});
      const description=[`截图划线批注（${strokeCount} 笔）`,note||'请结合截图中的标记理解修改意图。',`来源：${scope.resource_name}（${scope.resource_id}），分支 ${scope.branch_id}，源版本 ${image.source_revision}，截图时间 ${capturedAt}。`,
        '线条、箭头和方框是截图中的屏幕标记；修改空间位置时结合场景源稿和空间批注确认。',cameraContext?`截图相机：${JSON.stringify(cameraContext)}`:''].filter(Boolean).join('\n');
      const draft=[baseDraft,description].filter(Boolean).join('\n\n');
      // Retain the attempted draft for retry after a lost PATCH response.
      created.draft=draft;assertCurrent();
      await api.api(sessionRoute(sid),{method:'PATCH',body:{draft}});complete=true;
    })();
    attachmentWrites.set(sid,job);
    try{await job;}finally{if(attachmentWrites.get(sid)===job)attachmentWrites.delete(sid);}
  }});
  if(created&&current()){
    if(!sessions.some(s=>s.id===created.id))sessions.push(created);scheduleRosterRefresh();
    if(saved&&complete){
      draftCache.set(created.id,created.draft);sessionFilter='mine';
      // A navigation/read failure after durable save must not repeat the batch.
      try{await selectSession(created.id);if(current()){openChat(true);toast('划线截图和批注已加入新 Agent 草稿，发送后开始处理');}}
      catch(error){report(Error('批注已保存，可从 Agent 会话列表重新打开。'+errorText(error)));}
    }else toast('未完成的截图草稿已保留在 Agent 会话列表，可继续编辑');
  }
  return saved&&complete;
}
async function addImageAttachments(files){
  const sid=selectedSessionId,owner=user?.id,scope=branchKey(),generation=sessionLoadGeneration;
  if(!ownSession(sessionData)||!canWrite()||attachmentWrites.has(sid)||pendingSubmission())throw Error('请等待当前会话保存完成后添加图片');
  const selected=[...files];if(!selected.length)return;
  if(selected.length+(sessionData.draft_attachments??[]).filter(a=>a.kind==='image').length>8)throw Error('每条消息最多附加 8 张图片');
  for(const file of selected){if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('请选择 PNG、JPEG 或 WebP 图片');if(!file.size||file.size>5*1024*1024)throw Error('每张图片须在 5 MB 以内');}
  const current=()=>selectedSessionId===sid&&user?.id===owner&&branchKey()===scope&&sessionLoadGeneration===generation;
  const job=(async()=>{
    for(const file of selected){
      if(!current())throw Error('会话已切换，已停止添加剩余图片');
      const attachment=await api.api(`${sessionRoute(sid)}/image-attachments?name=${encodeURIComponent(file.name||'粘贴图片')}`,{method:'POST',body:file,headers:{'Content-Type':file.type}});
      if(current()){if(!sessionData.draft_attachments.some(a=>a.id===attachment.id))sessionData.draft_attachments.push(attachment);renderComposer();}
    }
  })();
  attachmentWrites.set(sid,job);renderComposer();
  try{await job;if(current())toast('图片已加入草稿，发送后 Agent 即可查看');}
  catch(error){if(current())await refreshSession().catch(()=>{});throw error;}
  finally{if(attachmentWrites.get(sid)===job)attachmentWrites.delete(sid);if(current()){renderComposer();$('#sessionDraft').focus();}}
}
$('#attachImage').onclick=()=>$('#imageAttachmentInput').click();
$('#imageAttachmentInput').onchange=event=>{const files=[...event.target.files];event.target.value='';addImageAttachments(files).catch(report);};
const imageDropZone=$('.composer-input');
imageDropZone.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=$('#attachImage').disabled?'none':'copy';imageDropZone.classList.toggle('image-drop-active',!$('#attachImage').disabled);}});
imageDropZone.addEventListener('dragleave',event=>{if(!imageDropZone.contains(event.relatedTarget))imageDropZone.classList.remove('image-drop-active');});
imageDropZone.addEventListener('drop',event=>{imageDropZone.classList.remove('image-drop-active');if(!event.dataTransfer.files.length)return;event.preventDefault();event.stopPropagation();addImageAttachments(event.dataTransfer.files).catch(report);});
$('#copyViewportAnnotations').onclick=()=>{const items=(sessionData?.draft_attachments??[]).filter(a=>a.kind==='viewport_annotation');if(items.length)copyAnnotationText(portableAnnotations(items,sessionData)).then(()=>toast('已复制批注，可粘贴到其他 Agent')).catch(report);};
$('#chatDrawer').addEventListener('paste',event=>{
  if(!event.target.closest('[contenteditable=true],#sessionDraft'))return;
  const imageFiles=[...(event.clipboardData?.files??[])].filter(file=>file.type.startsWith('image/'));
  if(imageFiles.length){event.preventDefault();event.stopImmediatePropagation();addImageAttachments(imageFiles).catch(report);return;}
  let portable;try{portable=parsePortableAnnotations(event.clipboardData?.getData('text/plain'));}catch(error){event.preventDefault();event.stopImmediatePropagation();report(error);return;}if(!portable)return;
  event.preventDefault();event.stopImmediatePropagation();
  const sid=selectedSessionId,owner=user?.id;if(!ownSession(sessionData)||attachmentWrites.has(sid)||pendingSubmission()){report(Error('请等待当前会话保存完成后再粘贴'));return;}
  const write=(async()=>{await flushDraft();return api.api(`${sessionRoute(sid)}/annotation-imports`,{method:'POST',body:{...portable,batch_id:uuid()}});})();attachmentWrites.set(sid,write);renderComposer();
  write.then(updated=>{if(selectedSessionId!==sid||user?.id!==owner)return;sessionData=updated;draftCache.set(sid,updated.draft);$('#sessionDraft').value=updated.draft;renderComposer();toast('已粘贴固定版本批注，等待发送');}).catch(report).finally(()=>{if(attachmentWrites.get(sid)===write)attachmentWrites.delete(sid);if(selectedSessionId===sid)renderComposer();});
},true);
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&viewportAnnotations.active&&!document.querySelector('dialog[open]')&&!event.defaultPrevented&&!event.target.closest('input,textarea,[contenteditable=true]')){event.preventDefault();event.stopImmediatePropagation();viewportAnnotations.escape();}},true);

initializeSemanticAuthoring();
renderTopbar();

if(api.token){try{await bootstrap();}catch(error){$('#authError').textContent=errorText(error);$('#authView').hidden=false;$('#landing').hidden=true;}}else{$('#authView').hidden=false;$('#landing').hidden=true;}

function mergeBranch(){
  if(!branch||!canWrite())return;const ctx=context(),sources=project.branches.filter(b=>b.branch_id!==ctx.branchId);
  if(!sources.length){toast('先创建另一个分支再比较。');return;}
  const active=modal('比较其他分支到当前分支',`<p>目标 ${esc(ctx.branchId)} / ${esc(short(ctx.base))}。先取得真实差异，再选择每处冲突。</p><label>来源分支<select id="mergeSource">${sources.map(b=>`<option value="${esc(b.branch_id)}">${esc(b.name)} · ${esc(b.branch_id)}</option>`).join('')}</select></label>`,[{label:'取消',action:closeModal},{label:'读取差异',primary:true,action:async()=>{
    if(!active())return;assertCurrentEdit(ctx);const source=$('#mergeSource').value;
    const preview=await api.api(`${branchRoute(ctx.projectId,ctx.branchId)}/merge-preview`,{method:'POST',body:{source_branch_id:source}});
    if(active()&&key()===ctx.key)showMergePreview(ctx,source,preview);
  }}]);
}
function showMergePreview(ctx,source,preview){
  const active=modal('审查真实分支差异',`<p>${esc(source)} → ${esc(ctx.branchId)} · ${preview.changes.length} 处差异 / ${preview.conflicts.length} 处冲突</p><small>来源 ${esc(short(preview.source_revision))} · 目标 ${esc(short(preview.target_revision))}</small>${preview.changes.map((change,i)=>`<article class="merge-change ${change.conflict?'conflict':''}"><strong>${esc(change.key)}</strong><span class="tag ${change.conflict?'amber':'dim'}">${change.conflict?'需要选择':'可合并'}</span><div class="merge-columns"><div><small>来源分支</small><pre>${esc(JSON.stringify(change.source,null,2))}</pre></div><div><small>当前目标</small><pre>${esc(JSON.stringify(change.target,null,2))}</pre></div></div><details><summary>共同基线</summary><pre>${esc(JSON.stringify(change.base,null,2))}</pre></details>${change.conflict?`<label>处理方式<select data-resolution="${i}"><option value="">请选择</option><option value="source">采用来源版本</option><option value="target">保留目标版本</option></select></label>`:''}</article>`).join('')||'<div class="empty-state">没有差异</div>'}<p>任何一侧版本继续变化，服务器会拒绝本次合并，需重新比较。</p>`,[{label:'取消',action:closeModal},{label:'确认合并',primary:true,action:async()=>{
    if(!active())return;assertCurrentEdit(ctx);const resolutions={};for(const [i,change]of preview.changes.entries())if(change.conflict){const chosen=$(`[data-resolution="${i}"]`).value;if(!chosen)throw new Error('请为每处冲突选择处理方式');resolutions[change.key]=chosen;}
    const result=await api.api(`${branchRoute(ctx.projectId,ctx.branchId)}/merge`,{method:'POST',body:{preview_id:preview.id,resolutions}});
    if(!active())return;if(branchKey()===`${ctx.projectId}/${ctx.branchId}`)acceptBranch(result.branch);closeModal();toast('分支合并已保存；运行世界仍需真实验证与应用。');
  }}]);
}
async function reconcileRun({quiet=false}={}){
  if(!ownSession(sessionData)||!canWrite())return;const sid=selectedSessionId;
  if(sessionRecoveries.has(sid))return sessionRecoveries.get(sid);
  const generation=sessionLoadGeneration,scope=branchKey(),owner=user?.id;
  const current=()=>sid===selectedSessionId&&generation===sessionLoadGeneration&&scope===branchKey()&&owner===user?.id;
  sessionRecoveryErrors.delete(sid);
  const job=(async()=>{
    try{
      const result=await api.api(`${sessionRoute(sid)}/reconcile`,{method:'POST',body:{}});
      if(!current())return result;
      sessionData=reconcileSessionTitle(result.session,sessionTitleConfirmations.get(result.session.id));
      const index=sessions.findIndex(s=>s.id===sid);if(index>=0)sessions[index]={...sessions[index],...sessionData};
      if(result.reconciliation?.uncertain)sessionRecoveryErrors.set(sid,'暂未确认原任务已停止，可稍后重试恢复。');
      else if(!quiet)toast(result.reconciliation?.canSend?'会话已恢复，可以继续发送。':'已连接原任务，正在继续接收进度。');
      renderSessions();scheduleRosterRefresh();return result;
    }catch(error){if(current())sessionRecoveryErrors.set(sid,'恢复失败：'+error.message);}
    finally{sessionRecoveries.delete(sid);if(current())renderComposer();}
  })();
  sessionRecoveries.set(sid,job);renderComposer();return job;
}
