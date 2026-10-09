import {clone, fail, hash} from './schema.mjs';
import {hierarchyRuntimeId} from './hierarchy-view.mjs';
import {NATIVE_SCHEMA} from './native-source.mjs';
import {resolveNativeObject} from './native-reference.mjs';

const ITEM = 'creator_inbox_item';
const READ = 'creator_inbox_read';
const RECEIPT = 'creator_inbox_receipt';
const SOURCES = new Set(['agent', 'godot_client', 'godot_authority', 'backend', 'collaboration']);
const KINDS = new Set(['error', 'decision', 'validation', 'notice']);
const SEVERITIES = new Set(['info', 'warning', 'error']);
const STATUSES = new Set(['open', 'resolved', 'obsolete']);
const retired = item => ['automatic_verification', 'automatic_completed', 'verification_request'].includes(item.code);
const SCOPE_FIELDS = ['project_id', 'branch_id', 'session_id', 'goal_id', 'run_id', 'job_id', 'revision', 'runtime_build_id', 'world_id', 'epoch', 'resource_id', 'client_id', 'collaboration_id'];
const ACTIONS = new Set(['locate', 'session', 'decision', 'build', 'collaboration']);
const RECORD_FIELDS = ['event_id', 'dedupe_key', 'source', 'kind', 'severity', ...SCOPE_FIELDS, 'targets', 'title', 'message', 'recipient_user_ids', 'actions', 'request_key', 'code', 'occurred_at'];
const has = (value, key) => Object.hasOwn(value, key);

function text(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${label}无效`);
  return value;
}
function integer(value, label, min = 1) {
  if (!Number.isSafeInteger(value) || value < min) fail(400, `${label}无效`);
  return value;
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, '通知参数含有不支持的字段');
}
function stringList(input, label, max = 100) {
  if (!Array.isArray(input) || input.length > max) fail(400, `${label}无效`);
  const values = input.map(value => text(value, label));
  if (new Set(values).size !== values.length) fail(400, `${label}不能重复`);
  return values;
}
const isEditor = (project, userId) => ['owner', 'editor'].includes(project?.members?.[userId]);

export function issueMatchesTarget(item, target) {
  if (!target) return true;
  if (item.project_id !== target.project_id || item.branch_id !== target.branch_id) return false;
  const refs = item.targets?.length ? item.targets : item.resource_id ? [{resource_id: item.resource_id}] : [];
  return refs.some(ref => {
    if ((ref.resource_id ?? ref.address?.resource_id) !== target.resource_id) return false;
    const wantedObject = target.object_id ?? (target.address ? hierarchyRuntimeId(target.address) : null);
    if (!target.address && !wantedObject) return true;
    if (!ref.address && !ref.object_id) return true; // Whole-resource problem includes its children.
    if (target.address && ref.address) return hash(ref.address) === hash(target.address);
    const actualObject = ref.object_id ?? (ref.address ? hierarchyRuntimeId(ref.address) : null);
    const expectedObject = target.object_id ?? (target.address ? hierarchyRuntimeId(target.address) : wantedObject);
    return actualObject === expectedObject;
  });
}

/** Persistent notifications/issues. record/close/closeByScope are SERVER ONLY.
 * Never expose them as generic client JSON write APIs. A host derives trusted
 * scope from authenticated sessions, actual runtime/client packets and jobs.
 * This ledger never approves a request, changes a run, validates gameplay,
 * writes a scene, publishes content, or treats reading as fixing an issue.
 */
export class CreationInbox {
  constructor({store, onChanged = () => {}, now = Date.now}) {
    this.store = store; this.onChanged = onChanged; this.now = now;
  }

  changed(item) {
    // Commit succeeded already. An auxiliary transport callback cannot undo it
    // or make a producer retry its authoritative operation as if it had failed.
    try {
      this.onChanged({item_id: item.id, project_id: item.project_id, branch_id: item.branch_id,
        recipient_user_ids: clone(item.recipient_user_ids), version: item.version, status: item.status});
    } catch (error) { this.lastNotificationError = {message: error.message, at: this.now()}; }
  }

  nativePreviewRecipient(item,userId) {
    if(item.source!=='backend'||item.kind!=='error'||item.code!=='build_result'||!item.job_id||item.session_id||item.run_id||item.goal_id||item.world_id||item.request_key)return false;
    const job=this.store.get('creator_build',item.job_id);
    return Boolean(job?.purpose==='native_preview'&&job.actor_id===userId&&job.project_id===item.project_id&&job.branch_id===item.branch_id&&job.source_revision===item.revision&&this.store.get('creator_revision',item.revision)?.manifest.schema===NATIVE_SCHEMA);
  }

  clientDiagnosticRecipient(item,userId) {
    // The authenticated client producer fixes one recipient and one window.
    // This read grant must not extend to Agent, authority or backend records.
    return item.source==='godot_client'&&['asset_load','runtime_load','runtime_fault','client_script','connection','operation_conflict'].includes(item.code)
      &&item.kind===(item.code==='connection'?'notice':'error')
      &&typeof item.client_id==='string'&&Boolean(item.client_id.trim())&&item.client_id.length<=160
      &&item.recipient_user_ids?.length===1&&item.recipient_user_ids[0]===userId
      &&Boolean(item.project_id&&item.branch_id&&item.revision)
      &&!item.session_id&&!item.run_id&&!item.goal_id&&!item.job_id&&!item.request_key&&!item.collaboration_id
      &&(item.actions??[]).every(action=>action.id==='locate');
  }

  target(input, scope) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '问题目标无效');
    // Deliberately retain public identity only, not opaque private annotations.
    const resourceId = input.resource_id ?? input.address?.resource_id ?? scope.resource_id;
    const result = {resource_id: text(resourceId, '目标文档')};
    if (input.object_id != null) result.object_id = text(input.object_id, '目标对象');
    if (input.address != null) {
      const a = input.address;
      fields(a, ['project_id', 'branch_id', 'resource_id', 'instance_path', 'definition_node_id']);
      if (a.project_id !== scope.project_id || a.branch_id !== scope.branch_id || a.resource_id !== resourceId) fail(409, '问题目标不属于此项目分支');
      if (!Array.isArray(a.instance_path) || a.instance_path.length > 64) fail(400, '实例路径无效');
      result.address = {project_id: a.project_id, branch_id: a.branch_id, resource_id: resourceId,
        instance_path: a.instance_path.map(part => text(part, '实例路径')), definition_node_id: text(a.definition_node_id, '定义节点')};
    }
    return result;
  }

  normalize(input) {
    fields(input, RECORD_FIELDS);
    text(input.event_id, '事件 ID'); text(input.dedupe_key, '问题去重键');
    if (!SOURCES.has(input.source) || !KINDS.has(input.kind)) fail(400, '通知来源或类别无效');
    const severity = input.severity ?? (input.kind === 'notice' ? 'info' : input.kind === 'decision' ? 'warning' : 'error');
    if (!SEVERITIES.has(severity)) fail(400, '问题严重度无效');
    const result = {source: input.source, kind: input.kind, severity,
      title: text(input.title, '通知标题', 240), message: text(input.message, '通知内容', 12000),
      code: input.code == null ? null : text(input.code, '问题代码', 200), request_key: input.request_key == null ? null : text(input.request_key, '请求引用')};
    for (const key of SCOPE_FIELDS) result[key] = input[key] ?? null;
    for (const key of SCOPE_FIELDS.filter(key => key !== 'epoch')) if (result[key] !== null) text(result[key], key);
    if (result.epoch !== null) integer(result.epoch, '世界代次');
    if (result.client_id !== null && (result.source !== 'godot_client' || result.client_id.length > 160)) fail(400, '客户端通知身份无效');
    let session = null, run = null, project = null, branch = null;
    if (result.session_id) {
      session = this.store.get('creator_session', result.session_id);
      if (!session) fail(404, '通知会话不存在');
      for (const key of ['project_id', 'branch_id']) {
        if (result[key] !== null && result[key] !== session[key]) fail(409, '通知会话范围不匹配');
        result[key] = session[key];
      }
    }
    if (result.run_id) {
      run = this.store.get('creator_run', result.run_id);
      if (!run || !session || run.session_id !== session.id || run.project_id !== result.project_id || run.branch_id !== result.branch_id || run.owner_user_id !== session.owner_user_id) fail(409, '通知执行绑定不匹配');
    }
    if (result.goal_id) {
      const goal = this.store.get('creator_goal', result.goal_id);
      if (!goal || !session || goal.session_id !== session.id || run && run.goal_id && run.goal_id !== goal.id) fail(409, '通知目标绑定不匹配');
      if (run && goal.run_id !== run.id && !(goal.run_ids ?? []).includes(run.id)) fail(409, '通知运行不属于该目标');
    }
    if (result.project_id) {
      project = this.store.get('creator_project', result.project_id);
      if (!project) fail(404, '通知项目不存在');
      if (result.branch_id) {
        branch = this.store.get('creator_branch', `${result.project_id}:${result.branch_id}`);
        if (!branch) fail(404, '通知分支不存在');
      }
    } else if (SCOPE_FIELDS.some(key => key !== 'project_id' && !(result.source === 'godot_client' && ['client_id', 'runtime_build_id'].includes(key)) && result[key] !== null)) fail(400, '无项目通知不能绑定分支或资产');
    if ((result.revision || result.resource_id || input.targets?.length || result.world_id) && !branch) fail(400, '资产或世界问题必须固定分支');
    if (!result.revision && (result.resource_id || input.targets?.length)) result.revision = run?.changes?.at(-1) ?? run?.input_revision ?? branch.head;
    const revision = result.revision && this.store.get('creator_revision', result.revision);
    if (result.revision && (!revision || revision.project_id !== result.project_id || !this.store.ancestor(result.revision, branch.head))) fail(409, '通知源版本不属于此分支');
    if (result.resource_id && !revision?.manifest.resources[result.resource_id]) fail(409, '通知文档不在固定版本中');
    if (!Array.isArray(input.targets ?? []) || (input.targets ?? []).length > 200) fail(400, '问题目标列表无效');
    result.targets = (input.targets ?? []).map(target => this.target(target, result));
    for (const target of result.targets) if (!revision?.manifest.resources[target.resource_id]) fail(409, '问题目标文档不在固定版本中');
    result.targets = [...new Map(result.targets.map(target => [hash(target), target])).values()].sort((a, b) => hash(a).localeCompare(hash(b)));
    if (result.world_id) {
      const world = this.store.get('creator_world', result.world_id);
      if (!world || world.project_id !== result.project_id || world.branch_id !== result.branch_id || result.resource_id && world.resource_id !== result.resource_id) fail(409, '通知世界范围不匹配');
      if (!result.epoch || !result.runtime_build_id || !result.revision) fail(400, '世界问题需固定代次、运行构建和源版本');
      // Historical epochs/revisions are valid records; currentness is projected
      // separately. A late old-world event cannot be rebased onto the new world.
    }
    if (result.request_key && (result.source !== 'agent' || !session || result.kind !== 'decision')) fail(400, '执行请求引用必须属于 Agent 会话决策');
    if (!Array.isArray(input.actions ?? []) || (input.actions ?? []).length > 10) fail(400, '通知操作无效');
    result.actions = (input.actions ?? []).map(action => {
      fields(action, ['id', 'label', 'enabled', 'reason']);
      if (!ACTIONS.has(action.id)) fail(400, '通知操作类型无效');
      if (action.enabled !== undefined && typeof action.enabled !== 'boolean') fail(400, '操作可用性无效');
      return {id: text(action.id, '操作 ID', 120), label: text(action.label, '操作文字', 120), enabled: action.enabled ?? true,
        ...(action.reason == null ? {} : {reason: text(action.reason, '操作不可用原因', 1000)})};
    });
    stringList(result.actions.map(action => action.id), '操作 ID', 10);
    if (input.recipient_user_ids !== undefined) stringList(input.recipient_user_ids, '收件人');
    const privateAgent = result.source === 'agent' && session;
    const defaults = privateAgent ? [session.owner_user_id] : project ? Object.keys(project.members).filter(uid => isEditor(project, uid)) : null;
    if (!project && !input.recipient_user_ids?.length) fail(400, '无项目通知必须明确收件人');
    result.recipient_user_ids = [...(input.recipient_user_ids ?? defaults)].sort();
    if (!result.recipient_user_ids.length) fail(400, '通知至少需要一位收件人');
    const collaboration = result.source === 'collaboration';
    if (collaboration) {
      const event = this.store.get('creator_collaboration_event', result.collaboration_id);
      if (!event || event.project_id !== result.project_id || SCOPE_FIELDS.some(key => !['project_id','collaboration_id'].includes(key) && result[key] !== null)
        || result.targets.length || result.request_key || !['decision','notice'].includes(result.kind)
        || result.actions.some(action => action.id !== 'collaboration')
        || result.recipient_user_ids.some(uid => !event.recipient_user_ids?.includes(uid))) fail(403, '协作通知必须绑定真实协作事件和收件人');
    } else if (result.collaboration_id || result.actions.some(action => action.id === 'collaboration')) fail(400, '协作引用只能用于协作通知');
    for (const userId of result.recipient_user_ids) {
      const sourceReader=(this.nativePreviewRecipient(result,userId)||this.clientDiagnosticRecipient(result,userId))&&['owner','editor','viewer'].includes(project?.members?.[userId]);
      if (!this.store.get('creator_user', userId) || project && !collaboration && !isEditor(project, userId)&&!sourceReader) fail(403, '收件人不具备项目开发权限');
      if (privateAgent && userId !== session.owner_user_id) fail(403, 'Agent 通知只能投递会话主人');
      if (session && userId !== session.owner_user_id && session.visibility !== 'shared') fail(403, '私人会话不能向其他成员投递正文');
    }
    result.visibility = session ? 'session' : project ? 'project' : 'recipient';
    return result;
  }

  record(input) {
    // Check durable event identity before recomputing mutable membership defaults.
    fields(input, RECORD_FIELDS); text(input.event_id, '事件 ID');
    if (!SOURCES.has(input.source)) fail(400, '通知来源无效');
    const receiptId = hash({action: 'record', source: input.source, event_id: input.event_id}), fingerprint = hash(input);
    let changed = null;
    const result = this.store.transaction(() => {
      const receipt = this.store.get(RECEIPT, receiptId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail(409, '相同事件 ID 不能改写通知内容');
        return {item: this.store.get(ITEM, receipt.item_id), replayed: true, changed: false};
      }
      const normalized = this.normalize(input), now = integer(this.now(), '当前时间', 0);
      const occurred = input.occurred_at === undefined ? now : integer(input.occurred_at, '发生时间', 0);
      if (occurred > now + 60000) fail(400, '通知发生时间超过服务端当前时间');
      const scope = Object.fromEntries(SCOPE_FIELDS.map(key => [key, normalized[key]]));
      const itemId = `inbox-${hash({source: input.source, kind: input.kind, dedupe_key: input.dedupe_key, ...scope, targets: normalized.targets, request_key: normalized.request_key})}`;
      const previous = this.store.get(ITEM, itemId);
      // Out-of-order repeats count as history but cannot reopen a closed issue or
      // replace its latest details. A new actual occurrence can reopen it.
      const late = previous && occurred < previous.last_occurred_at || previous?.closed_at != null && occurred <= previous.closed_at;
      const material = value => ({severity: value.severity, title: value.title, message: value.message, code: value.code, actions: value.actions});
      const update = !previous || !late && (previous.status !== 'open' || hash(material(previous)) !== hash(material(normalized)));
      const item = previous ? {...previous, occurrences: previous.occurrences + 1, last_seen_at: now,
        last_occurred_at: Math.max(previous.last_occurred_at, occurred)} : {id: itemId, schema: 1, ...normalized,
        dedupe_key: input.dedupe_key, status: 'open', version: 1, occurrences: 1, created_at: now, updated_at: now,
        first_occurred_at: occurred, last_occurred_at: occurred, last_seen_at: now, closed_at: null, resolution: null, resolution_history: []};
      if (previous && update) Object.assign(item, material(normalized), {status: 'open', version: previous.version + 1,
        updated_at: now, closed_at: null, resolution: null, recipient_user_ids: [...new Set([...previous.recipient_user_ids, ...normalized.recipient_user_ids])].sort()});
      this.store.put(ITEM, item);
      this.store.put(RECEIPT, {id: receiptId, action: 'record', fingerprint, item_id: item.id, created_at: now});
      if (update) changed = item;
      return {item: clone(item), replayed: false, changed: update};
    });
    if (changed) this.changed(changed);
    return result;
  }

  authorize(user, item) {
    if (!user?.id || !this.store.get('creator_user', user.id) || !item?.recipient_user_ids.includes(user.id)) fail(403, '没有此通知的访问权限');
    if (item.source === 'collaboration') {
      const event = this.store.get('creator_collaboration_event', item.collaboration_id);
      if (!event || event.project_id !== item.project_id || !event.recipient_user_ids?.includes(user.id)) fail(403, '没有此协作通知的访问权限');
      return item;
    }
    if (item.project_id) {
      const sourceReader=this.nativePreviewRecipient(item,user.id)||this.clientDiagnosticRecipient(item,user.id);
      const project = this.store.projectFor(user, item.project_id, !sourceReader);
      const branch=item.branch_id?this.store.branchFor(user, item.project_id, item.branch_id):null;
      if(sourceReader){if(!['owner','editor','viewer'].includes(project.members[user.id])||!branch||!this.store.ancestor(item.revision,branch.head))fail(403,'没有此客户端观察的源稿访问权限');}
      else if (!isEditor(project, user.id)) fail(403, '没有此项目的开发权限');
    }
    if (item.session_id) this.store.sessionFor(user, item.session_id);
    return item;
  }

  resourceContextUnchanged(item, currentRevision) {
    const resources = [...new Set([item.resource_id, ...(item.targets ?? []).map(target => target.resource_id ?? target.address?.resource_id)].filter(Boolean))];
    if (!resources.length) return false; // Branch-level observations keep an exact source pin.
    if(this.store.revisionResourceSignature){
      const original=this.store.revisionMeta(item.revision),current=this.store.revisionMeta(currentRevision);
      if(!original||!current||original.schema!==current.schema)return false;
      if(item.revision===currentRevision){const manifest=this.store.readRevision(currentRevision)?.manifest;return resources.every(id=>Boolean(manifest?.resources?.[id]));}
      return resources.every(id=>{const before=this.store.revisionResourceSignature(item.revision,id);return before!==null&&before===this.store.revisionResourceSignature(currentRevision,id);});
    }
    const original = this.store.get('creator_revision', item.revision)?.manifest;
    const current = this.store.get('creator_revision', currentRevision)?.manifest;
    if (!original?.resources || !current?.resources) return false;
    // All active prefab definitions are deliberately conservative dependencies.
    // A content-equal scene can retain an issue across an unrelated scene edit;
    // an edited prefab, missing target or schema change makes it historical.
    const signature = (manifest, resourceId) => hash({schema: manifest.schema, resource: manifest.resources[resourceId],
      prefabs: Object.values(manifest.resources).filter(resource => resource.kind === 'prefab').sort((a, b) => a.id.localeCompare(b.id))});
    return resources.every(resourceId => original.resources[resourceId] && current.resources[resourceId] && signature(original, resourceId) === signature(current, resourceId));
  }

  contextCurrent(item, {forMarker = false} = {}) {
    if (item.source === 'collaboration' && item.kind === 'decision') {
      const event = this.store.get('creator_collaboration_event', item.collaboration_id);
      return this.store.get('creator_access_request', event?.request_id)?.status === 'pending';
    }
    if (item.branch_id) {
      const branch = this.store.get('creator_branch', `${item.project_id}:${item.branch_id}`);
      // An actual pending Agent question remains answerable when a collaborator
      // changes unrelated source. Its existing reply endpoint decides request
      // liveness; markers additionally require the original target/dependency
      // content, even when an unrelated scene advanced the branch revision.
      if (!branch || (forMarker || item.kind !== 'decision') && item.revision && branch.head !== item.revision && !this.resourceContextUnchanged(item, branch.head)) return false;
    }
    if (item.goal_id && item.run_id && this.store.get('creator_goal', item.goal_id)?.run_id !== item.run_id) return false;
    if (item.world_id) {
      const world = this.store.get('creator_world', item.world_id);
      if (!world || world.epoch !== item.epoch || world.revision !== item.revision || world.runtime_build_id !== item.runtime_build_id) return false;
    }
    return true;
  }

  view(user, item) {
    this.authorize(user, item);
    if (retired(item)) fail(404, '此功能的历史通知已归档');
    const read = this.store.get(READ, hash({item_id: item.id, user_id: user.id}));
    const {recipient_user_ids, dedupe_key, ...value} = clone(item), current = this.contextCurrent(item);
    const branch = item.branch_id && this.store.get('creator_branch', `${item.project_id}:${item.branch_id}`);
    const resourceCurrent = Boolean(branch && item.revision && this.resourceContextUnchanged(item, branch.head));
    const actions = value.actions.map(action => {
      const permitted = ['session', 'build', 'collaboration'].includes(action.id) || (action.id === 'locate' ? resourceCurrent : item.status === 'open' && current);
      return {...action, enabled: action.enabled && permitted,
        ...(!permitted && action.enabled ? {reason: action.id === 'locate' ? '目标内容已经变化，请在历史会话中查看原始问题' : !current ? '通知属于历史上下文，请查看当前任务状态' : '此事项已结束'} : {})};
    });
    return {...value, ...(item.source === 'collaboration' ? {access_request_id:this.store.get('creator_collaboration_event', item.collaboration_id)?.request_id??null} : {}), actions, read_at: read?.read_at ?? null, read_version: read?.version ?? 0,
      unread: !read || read.version < item.version, context_current: current,
      actionable: item.status === 'open' && current && item.kind !== 'notice'};
  }

  get(user, itemId) {
    const item = this.store.get(ITEM, text(itemId, '通知 ID'));
    if (!item) fail(404, '通知不存在');
    return this.view(user, item);
  }

  list(user, input = {}) {
    fields(input, ['project_id', 'branch_id', 'status', 'unread_only', 'filter', 'target', 'limit', 'cursor']);
    if (!user?.id || !this.store.get('creator_user', user.id)) fail(401, '请登录工作台');
    input = {...input}; let target = null;
    if (input.target != null) {
      fields(input.target, ['project_id', 'branch_id', 'resource_id', 'object_id', 'address']);
      const raw = input.target, projectId = input.project_id ?? raw.project_id ?? raw.address?.project_id;
      const branchId = input.branch_id ?? raw.branch_id ?? raw.address?.branch_id;
      if (!projectId || !branchId) fail(400, '目标筛选需明确项目和分支');
      if (raw.project_id != null && raw.project_id !== projectId || raw.branch_id != null && raw.branch_id !== branchId) fail(409, '筛选目标不属于当前项目分支');
      const scope = {project_id: text(projectId, '筛选项目'), branch_id: text(branchId, '筛选分支')};
      target = {...scope, ...this.target(raw, scope)};
      const branch=this.store.branchFor(user,projectId,branchId),manifest=this.store.get('creator_revision',branch.head)?.manifest;
      if(manifest?.schema===NATIVE_SCHEMA&&(target.address||target.object_id)){
        const resolved=resolveNativeObject(manifest,{...scope,resource_id:target.resource_id},target.address,target.object_id);
        if(resolved)target={...scope,resource_id:target.resource_id,object_id:resolved.id,address:clone(resolved.address)};
        // A deleted object's fixed historical reference is still a valid read
        // filter. Never replace it by guessing a current node or instance ID.
      }else if (target.address && target.object_id && target.object_id !== hierarchyRuntimeId(target.address) && target.object_id !== target.address.definition_node_id) fail(409, '筛选对象与地址不匹配');
      input.project_id = projectId; input.branch_id = branchId;
    }
    if (input.project_id && !this.store.get('creator_project', input.project_id)) fail(404, '游戏不存在');
    if (input.branch_id && !input.project_id) fail(400, '筛选分支需指定项目');
    if (input.branch_id) this.store.branchFor(user, input.project_id, input.branch_id);
    if (input.status !== undefined && input.status !== 'all' && !STATUSES.has(input.status)) fail(400, '通知状态筛选无效');
    if (input.unread_only !== undefined && typeof input.unread_only !== 'boolean') fail(400, '未读筛选无效');
    if (input.filter !== undefined && !['actionable', 'unread', 'all'].includes(input.filter)) fail(400, '通知筛选无效');
    const limit = input.limit ?? 100; integer(limit, '分页大小'); if (limit > 200) fail(400, '分页大小不能超过 200');
    let cursor = null;
    if (input.cursor) {
      try { cursor = JSON.parse(Buffer.from(text(input.cursor, '分页游标', 4096), 'base64url').toString()); } catch { fail(400, '分页游标无效'); }
      if (!cursor || cursor.user_id !== user.id || !Number.isSafeInteger(cursor.at) || typeof cursor.id !== 'string') fail(400, '分页游标不属于当前用户');
    }
    const scoped = this.store.list(ITEM).filter(item => (!input.project_id || item.project_id === input.project_id) && (!input.branch_id || item.branch_id === input.branch_id));
    const visible = [];
    for (const item of scoped) {
      try { visible.push(this.view(user, item)); } catch (error) { if (![403, 404].includes(error.status)) throw error; }
    }
    const counts = {unread: visible.filter(item => item.unread).length, actionable: visible.filter(item => item.actionable).length};
    const sorted = visible.filter(item => issueMatchesTarget(item, target) && (!input.status || input.status === 'all' || item.status === input.status) && (!input.unread_only || item.unread)
      && (input.filter !== 'unread' || item.unread) && (input.filter !== 'actionable' || item.actionable))
      .sort((a, b) => b.updated_at - a.updated_at || b.id.localeCompare(a.id));
    const after = cursor ? sorted.filter(item => item.updated_at < cursor.at || item.updated_at === cursor.at && item.id.localeCompare(cursor.id) < 0) : sorted;
    const items = after.slice(0, limit), last = items.at(-1);
    const next = after.length > limit ? Buffer.from(JSON.stringify({user_id: user.id, at: last.updated_at, id: last.id})).toString('base64url') : null;
    return {items, counts, next_cursor: next};
  }

  read(user, itemId, input) {
    fields(input, ['expected_version', 'request_id']); integer(input.expected_version, '已读版本'); text(input.request_id, '请求 ID');
    if (!user?.id || !this.store.get('creator_user', user.id)) fail(401, '请登录工作台');
    const receiptId = hash({action: 'read', user_id: user.id, request_id: input.request_id}), fingerprint = hash({item_id: itemId, input});
    let changed = null;
    const result = this.store.transaction(() => {
      const item = this.store.get(ITEM, text(itemId, '通知 ID')); if (!item) fail(404, '通知不存在');
      this.authorize(user, item); // Always recheck authority before receipt replay.
      const receipt = this.store.get(RECEIPT, receiptId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail(409, '相同已读请求不能改写内容');
        return {item: this.view(user, item), replayed: true};
      }
      if (item.version !== input.expected_version) fail(409, '通知已有新进展，请读取当前内容后标为已读');
      const readId = hash({item_id: item.id, user_id: user.id}), existing = this.store.get(READ, readId);
      if (existing?.version !== item.version) {
        this.store.put(READ, {id: readId, item_id: item.id, user_id: user.id, version: item.version, read_at: this.now()});
        changed = {...item, recipient_user_ids: [user.id]};
      }
      this.store.put(RECEIPT, {id: receiptId, action: 'read', fingerprint, item_id: item.id, user_id: user.id, created_at: this.now()});
      return {item: this.view(user, item), replayed: false};
    });
    if (changed) this.changed(changed);
    return result;
  }

  finish(item, input) {
    if (!['resolved', 'obsolete'].includes(input.status)) fail(400, '结束状态必须为 resolved 或 obsolete');
    const reason = text(input.reason, '结束依据', 12000);
    if (input.expected_version !== undefined && item.version !== integer(input.expected_version, '通知版本')) fail(409, '通知已有新进展，不能结束旧版本');
    if (item.status !== 'open') {
      if (item.status === input.status && item.resolution === reason) return {item, changed: false};
      fail(409, '已结束的通知不能改写结束事实');
    }
    const now = this.now(), closed = {...item, status: input.status, resolution: reason, version: item.version + 1, updated_at: now, closed_at: now,
      resolution_history: [...(item.resolution_history ?? []), {status: input.status, reason, at: now, version: item.version + 1}]};
    this.store.put(ITEM, closed); return {item: closed, changed: true};
  }

  close(itemId, input) {
    fields(input, ['expected_version', 'status', 'reason']);
    const result = this.store.transaction(() => {
      const item = this.store.get(ITEM, text(itemId, '通知 ID')); if (!item) fail(404, '通知不存在');
      return this.finish(item, input);
    });
    if (result.changed) this.changed(result.item);
    return clone(result);
  }

  closeByScope(scope, input) {
    fields(scope, [...SCOPE_FIELDS, 'source', 'kind', 'code', 'request_key', 'dedupe_key']);
    fields(input, ['status', 'reason']);
    // Reject a broad "all project errors fixed" operation. The producer must
    // select its source/category and the exact causal incident/run/world pin.
    if (!SOURCES.has(scope.source) || !KINDS.has(scope.kind) || !['run_id', 'job_id', 'request_key', 'dedupe_key', 'world_id', 'revision'].some(key => scope[key] != null)) fail(400, '批量结束需固定来源、类别及问题因果范围');
    if (!scope.project_id && !scope.session_id && !scope.run_id && !scope.job_id && !scope.request_key && !scope.dedupe_key) fail(400, '批量结束需固定项目或私人范围');
    for (const [key, value] of Object.entries(scope)) if (value !== null) key === 'epoch' ? integer(value, '世界代次') : text(value, key);
    const result = this.store.transaction(() => {
      // Validate even if no matches, to expose producer programming mistakes.
      if (!['resolved', 'obsolete'].includes(input.status)) fail(400, '结束状态必须为 resolved 或 obsolete');
      text(input.reason, '结束依据', 12000);
      return this.store.list(ITEM).filter(item => item.status === 'open' && Object.entries(scope).every(([key, value]) => item[key] === value)).map(item => this.finish(item, input).item);
    });
    for (const item of result) this.changed(item);
    return {items: clone(result), count: result.length};
  }

  projection(user, projectId, branchId) {
    this.store.branchFor(user, projectId, branchId);
    // All project readers may see that a shared asset has a problem, including
    // problems from a private creator session. No text, actor/session/run/goal,
    // request key or navigation action is included in this public projection.
    return this.store.list(ITEM).filter(item => !retired(item) && item.project_id === projectId && item.branch_id === branchId && item.status === 'open' && item.kind !== 'notice' && this.contextCurrent(item, {forMarker: true}))
      .map(item => ({id: item.id, project_id: item.project_id, branch_id: item.branch_id,
        source: item.source, kind: item.kind, severity: item.severity,
        status: 'open', revision: item.revision, runtime_build_id: item.runtime_build_id,
        world_id: item.world_id, epoch: item.epoch, resource_id: item.resource_id,
        targets: clone(item.targets), occurrences: item.occurrences}));
  }
}
