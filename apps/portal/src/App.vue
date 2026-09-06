<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './components/Icon.vue'
import ObjectHistory from './components/ObjectHistory.vue'
import { api, post, readSession, writeSession, clone, shortId, downloadJSON, verifyWebArtifacts } from './api'

const session = ref(readSession())
const authMode = ref('register')
const credentials = ref({ name: '', password: '' })
const projects = ref([])
const projectId = ref('')
const projectData = ref(null)
const branchName = ref('main')
const page = ref('world')
const busy = ref('')
const error = ref('')
const notice = ref('')
const offline = ref(!navigator.onLine)
const lastSynced = ref(null)
const modal = ref(null)
const objectHistory = ref(null)
const historyLoading = ref(false)
const historyError = ref('')
const historyObjectId = ref('')
let historyRequest = 0
const form = ref({})
const content = ref(null)
const baseRevision = ref(null)
const cleanContent = ref('')
const selectedId = ref('')
const search = ref('')
const zoneFilter = ref('all')
const inspectorTab = ref('object')
const conflicts = ref(null)
const commitMessage = ref('')
const draftSaved = ref(null)
const backupDraft = ref(null)
const fileInput = ref(null)
const modelInput = ref(null)
const assets = ref([])
const assetTargetId = ref('')
const behaviorId = ref('cooperative-damage')
const defaultBehaviorSource = 'extends RefCounted\n\nfunc evaluate(context: Dictionary) -> Dictionary:\n    var rules: Dictionary = context.get("rules", {})\n    var players: int = int(context.get("player_count", 1))\n    var bonus: float = 1.4 if players > 1 else 1.0\n    return {"attack_damage": float(rules.get("attack_damage", 20)) * bonus}\n'
const behaviorSource = ref(defaultBehaviorSource)
const behaviorLoadedHash = ref(null)
const behaviorFileInput = ref(null)
const selectedWorldId = ref('')
const frames = ref([])
const currentFrameId = ref(null)
const pendingFrameId = ref(null)
const frameEls = new Map()
const gamePanel = ref(null)
const telemetry = ref(null)
const joinStatus = ref('')
const downloadProgress = ref(null)
const desktopPackage = ref(null)
const showControls = ref(false)
let loadingContent = false
let contentRequest = 0
let polling = false
let pollTimer
let lastTelemetryAt = 0

const project = computed(() => projectData.value?.project || projects.value.find(p => p.id === projectId.value))
const branches = computed(() => projectData.value?.branches || [])
const releases = computed(() => projectData.value?.releases || [])
const worlds = computed(() => projectData.value?.worlds || [])
const tasks = computed(() => projectData.value?.tasks || [])
const members = computed(() => projectData.value?.members || [])
const builds = computed(() => projectData.value?.builds || [])
const activity = computed(() => [...(projectData.value?.activity || [])].sort((a,b) => timeValue(b) - timeValue(a)))
const branch = computed(() => branches.value.find(b => branchLabel(b) === branchName.value))
const branchWorlds = computed(() => worlds.value.filter(w => (w.branch || w.branch_name) === branchName.value))
const selectedWorld = computed(() => branchWorlds.value.find(w => w.id === selectedWorldId.value) || branchWorlds.value.find(w => w.release_id === playableId.value) || branchWorlds.value[0])
const playableId = computed(() => branch.value?.playable_head?.id || branch.value?.playable_head || null)
const sourceId = computed(() => branch.value?.source_head?.id || branch.value?.source_head || null)
const role = computed(() => project.value?.role || projects.value.find(p => p.id === projectId.value)?.role || members.value.find(m => (m.user_id || m.id) === session.value?.user?.id || m.name === session.value?.user?.name)?.role || 'viewer')
const canEdit = computed(() => ['owner', 'editor'].includes(role.value))
const canManage = computed(() => role.value === 'owner')
const branchTasks = computed(() => tasks.value.filter(t => (t.branch || t.branch_name) === branchName.value))
const objects = computed(() => content.value?.objects || [])
const filteredObjects = computed(() => objects.value.filter(o => (zoneFilter.value === 'all' || o.zone_id === zoneFilter.value) && `${o.name} ${o.id} ${o.kind}`.toLowerCase().includes(search.value.toLowerCase())))
const selected = computed(() => objects.value.find(o => o.id === selectedId.value))
const selectedTasks = computed(() => branchTasks.value.filter(t => t.object_id === selectedId.value))
const dirty = computed(() => !!content.value && JSON.stringify(content.value) !== cleanContent.value)
const remoteChanged = computed(() => !!sourceId.value && !!baseRevision.value && sourceId.value !== baseRevision.value)
const draftKey = computed(() => `world-atelier:draft:${session.value?.user?.id}:${projectId.value}:${branchName.value}`)
const active = computed(() => !!telemetry.value?.active && !!currentFrameId.value)
const currentFrame = computed(() => frames.value.find(f=>f.id===currentFrameId.value))
const liveAnnotation = computed(() => active.value && currentFrame.value?.project_id===projectId.value && currentFrame.value?.branch===branchName.value && telemetry.value?.world_id===currentFrame.value?.world_id)
const player = computed(() => telemetry.value?.player || {})
const activeCount = computed(() => branchTasks.value.filter(t => ['editing','testing'].includes(t.status)).length)
const projectPath = () => `/projects/${encodeURIComponent(projectId.value)}`
const branchPath = () => `${projectPath()}/branches/${encodeURIComponent(branchName.value)}`
const roleLabels = { owner: '项目所有者', editor: '开发者', tester: '测试者', viewer: '观察者' }
const statusLabels = { superseded: '已被新构建替代', editing: '开发中', testing: '验证中', delivered: '已交付', failed: '失败', queued: '排队中', building: '构建中', running: '运行中', validating: '验证中', succeeded: '通过', success: '通过', passed: '通过', ready: '就绪', complete: '完成', completed: '完成', published: '已发布', starting: '启动中', stopped: '已停止', pending: '等待中' }
const nav = [{id:'world',icon:'globe',label:'现场世界'}, {id:'editor',icon:'layers',label:'场景与规则'}, {id:'versions',icon:'branch',label:'分支与发行'}, {id:'collaboration',icon:'users',label:'协作工作台'}, {id:'offline',icon:'download',label:'离线工作区'}]
function branchLabel(b) { return typeof b === 'string' ? b : b.name || b.branch || b.id }
function timeValue(item) { return new Date(item.created_at || item.updated_at || item.timestamp || item.time || item.at || 0).getTime() }
function timestamp(value) { if (!value) return '—'; return new Date(value).toLocaleString('zh-CN', { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' }) }
function statusLabel(value) { return statusLabels[value] || value || '等待状态' }
function statusClass(value) { return ['ready','succeeded','success','passed','complete','completed','delivered','published','running'].includes(value) ? 'success' : value === 'failed' ? 'danger' : 'pending' }
function taskFor(id) { return branchTasks.value.find(t => t.object_id === id && ['editing','testing','failed'].includes(t.status)) }
function actor(item) { return item.author || item.user_name || item.actor_name || item.actor || item.name || '协作者' }
function tell(message) { notice.value = message; error.value = '' }
function fail(e) { error.value = e.message || String(e); if (e.status === 409) conflicts.value = e.details; console.error(e) }
async function run(label, action) {
  if (busy.value) return
  busy.value = label; error.value = ''
  try { return await action() } catch (e) { fail(e) } finally { busy.value = '' }
}
function openModal(type, values = {}) {
  if (type==='task') { openTask(page.value==='world' && liveAnnotation.value ? 'live' : 'source',values.object_id || selectedId.value); return }
  modal.value = type; form.value = values; error.value = ''
}
function openTask(origin='source',objectId=selectedId.value) {
  if (origin==='live' && !liveAnnotation.value) { fail(new Error('当前游戏不属于所选工程与分支，先进入对应世界或使用源码批注。')); return }
  if (origin==='source' && !JSON.parse(cleanContent.value || '{}').objects?.some(o=>o.id===objectId)) { fail(new Error('新对象需要先提交源码，才能建立有基础版本的批注。')); return }
  form.value={object_id:objectId,status:'editing',title:'',origin,branch:branchName.value,project_id:projectId.value,base_revision:baseRevision.value,...(origin==='live'?{observed_world_id:telemetry.value.world_id,observed_release_id:telemetry.value.release_id}:{})}
  modal.value='task';error.value=''
}
async function loadObjectHistory() {
  if (!historyObjectId.value || !projectId.value) return
  const request=++historyRequest,key=`${projectId.value}/${branchName.value}/${historyObjectId.value}`
  historyLoading.value=true;historyError.value=''
  try { const result=await api(`${branchPath()}/objects/${encodeURIComponent(historyObjectId.value)}/history`);if(request===historyRequest && key===`${projectId.value}/${branchName.value}/${historyObjectId.value}`)objectHistory.value=result }
  catch(e){if(request===historyRequest)historyError.value=e.message}
  finally{if(request===historyRequest)historyLoading.value=false}
}
function openObjectHistory(id=selectedId.value){historyObjectId.value=id;objectHistory.value=null;modal.value='history';loadObjectHistory()}
function restoreObjectVersion(version){
  if (busy.value || !canEdit.value || !objectHistory.value || objectHistory.value.project_id!==projectId.value || objectHistory.value.branch!==branchName.value) return
  const id=objectHistory.value.object_id,index=content.value.objects.findIndex(o=>o.id===id)
  if(version.object){if(index>=0)content.value.objects[index]=clone(version.object);else content.value.objects.push(clone(version.object));selectedId.value=id}
  else if(index>=0)content.value.objects.splice(index,1)
  modal.value=null;page.value='editor';tell(`已将对象 ${id} 的历史${version.object?'版本':'删除记录'}放入当前草稿；提交基础与其他对象保留，世界尚未改变。`)
}
watch([projectId,branchName],()=>{historyRequest++;objectHistory.value=null;historyObjectId.value='';if(['history','task'].includes(modal.value))modal.value=null})
async function authenticate() {
  await run(authMode.value === 'register' ? '创建账号' : '登录', async () => {
    const result = await post(`/auth/${authMode.value}`, credentials.value)
    writeSession(result); session.value = result; credentials.value.password = ''
    await loadProjects(); tell('已连接中央服务。')
  })
}
function logout() {
  writeSession(null); session.value = null; projects.value = []; projectData.value = null; projectId.value = ''
  frames.value = []; frameEls.clear(); currentFrameId.value = null; pendingFrameId.value = null; telemetry.value = null
  content.value = null; error.value = ''; notice.value = ''
}
async function loadProjects() {
  const result = await api('/projects')
  projects.value = result.projects || []
  if (!projectId.value && projects.value.length) await chooseProject(projects.value[0].id)
}
async function chooseProject(id) {
  projectId.value = id; branchName.value = 'main'; selectedWorldId.value = ''
  projectData.value = null; content.value = null; selectedId.value = ''; conflicts.value = null; assets.value = []
  await refreshProject(); await loadContent()
}
async function refreshProject() {
  if (!projectId.value) return
  const id = projectId.value
  const result = await api(`/projects/${encodeURIComponent(id)}`)
  if (id !== projectId.value) return
  projectData.value = result; lastSynced.value = Date.now(); offline.value = false
  if (!branches.value.some(b => branchLabel(b) === branchName.value)) branchName.value = branchLabel(branches.value[0]) || 'main'
}
async function chooseBranch(name) {
  if (branchName.value === name) return
  branchName.value = name; selectedWorldId.value = ''; selectedId.value = ''; conflicts.value = null
  try { await loadContent() } catch(e) { fail(e) }
}
async function loadContent({ ignoreDraft = false } = {}) {
  const request = ++contentRequest
  const key = draftKey.value
  const result = await api(`${branchPath()}/content`)
  if (request !== contentRequest || key !== draftKey.value) return
  loadingContent = true
  baseRevision.value = result.revision
  content.value = clone(result.content)
  cleanContent.value = JSON.stringify(result.content)
  backupDraft.value = null
  try {
    const savedScript = JSON.parse(localStorage.getItem(`${key}:script`) || 'null')
    if (savedScript?.source) { behaviorId.value = savedScript.id; behaviorSource.value = savedScript.source; behaviorLoadedHash.value = savedScript.asset_hash || null }
    else { behaviorId.value = 'new-behavior'; behaviorSource.value = defaultBehaviorSource; behaviorLoadedHash.value = null }
    backupDraft.value = JSON.parse(localStorage.getItem(`${key}:backup`) || 'null')
    const saved = !ignoreDraft && JSON.parse(localStorage.getItem(key) || 'null')
    if (saved?.content && saved.base_revision) {
      content.value = saved.content; baseRevision.value = saved.base_revision; draftSaved.value = saved.saved_at
      if (JSON.stringify(saved.content) !== cleanContent.value) tell('已恢复此分支的本地草稿；基础版本仍然保留。')
    }
  } catch { /* A malformed local draft must not block loading server content. */ }
  selectedId.value = content.value?.objects?.find(o => o.kind === 'beacon')?.id || content.value?.objects?.[0]?.id || ''
  loadingContent = false
}
watch(content, () => {
  if (loadingContent || !content.value || !projectId.value || !baseRevision.value) return
  try {
    draftSaved.value = Date.now()
    localStorage.setItem(draftKey.value, JSON.stringify({ format:1, project_id:projectId.value, branch:branchName.value, base_revision:baseRevision.value, content:content.value, saved_at:draftSaved.value }))
  } catch { error.value = '浏览器草稿空间已满，请下载离线包保存当前修改。' }
}, { deep:true, flush:'sync' })

watch([behaviorId,behaviorSource,behaviorLoadedHash], () => {
  if (loadingContent || !projectId.value) return
  try { localStorage.setItem(`${draftKey.value}:script`, JSON.stringify({id:behaviorId.value,source:behaviorSource.value,asset_hash:behaviorLoadedHash.value})) }
  catch { error.value = '行为源码草稿未能写入浏览器存储，请下载保存。' }
}, {flush:'sync'})
function encodeBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768))
  return btoa(binary)
}
function decodeBase64(text) { return Uint8Array.from(atob(text),c=>c.charCodeAt(0)) }
async function uploadAsset(name,mime,bytes) {
  const result = await post(`${projectPath()}/assets`, {name,mime,data_base64:encodeBase64(bytes)})
  if (!/^[a-f0-9]{64}$/i.test(result.asset?.hash || '')) throw new Error('资产服务没有返回有效内容哈希。')
  if (!assets.value.some(a=>a.hash===result.asset.hash)) assets.value.push(result.asset)
  return result.asset
}
async function uploadModel(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  const objectId = selectedId.value
  await run('上传 GLB 模型',async () => {
    if (!/\.glb$/i.test(file.name)) throw new Error('请选择二进制 glTF 模型 (.glb)。')
    if (file.size > 2 * 1024 * 1024) throw new Error('GLB 模型应不超过 2 MB。')
    const object = content.value?.objects.find(o=>o.id===objectId)
    if (!object) throw new Error('请先选择要绑定模型的场景对象。')
    const asset = await uploadAsset(file.name,'model/gltf-binary',new Uint8Array(await file.arrayBuffer()))
    object.model_asset = asset.hash
    tell(`模型 ${file.name} 已上传并关联到场景草稿。仍需提交、构建并应用，游戏表现才会改变。`)
  })
}
async function openAssetLibrary() {
  assetTargetId.value = selectedId.value
  modal.value = 'assets'
  await run('读取工程资源',async () => { const result = await api(`${projectPath()}/assets`); assets.value = result.assets || [] })
}
function attachExistingModel(asset) {
  if (!canEdit.value || busy.value) return
  const object = content.value?.objects.find(o=>o.id===assetTargetId.value)
  if (!object) { error.value = '关联对象已不存在，请重新选择对象。'; return }
  object.model_asset = asset.hash; modal.value = null
  tell(`模型 ${asset.name} 已关联到场景草稿，等待提交与构建。`)
}
function clearModel() { if (canEdit.value && !busy.value && selected.value) delete selected.value.model_asset }
async function readBehavior(behavior) {
  await run('读取行为源码',async () => {
    const result = await api(`${projectPath()}/assets/${encodeURIComponent(behavior.asset_hash)}`)
    const source = new TextDecoder().decode(decodeBase64(result.data_base64))
    if (!source.trim()) throw new Error('资产服务返回了空的行为源码。')
    behaviorLoadedHash.value = behavior.asset_hash; behaviorId.value = behavior.id; behaviorSource.value = source
    tell('已读取这个行为模块的实际源码，修改后可上传新的不可变资产版本。')
  })
}
async function readBehaviorFile(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  await run('读取 GDScript 文件',async () => {
    if (!/\.gd$/i.test(file.name) || file.size > 32 * 1024) throw new Error('请选择不超过 32 KB 的 GDScript (.gd) 文件。')
    behaviorId.value = file.name.replace(/\.gd$/i,'').replace(/[^a-zA-Z0-9_-]/g,'-') || 'new-behavior'
    behaviorLoadedHash.value = null; behaviorSource.value = await file.text()
    tell('行为文件已读入本机源码草稿；尚未上传或应用。')
  })
}
async function uploadBehavior() {
  await run('上传行为模块',async () => {
    const id = behaviorId.value.trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,63}$/.test(id)) throw new Error('模块 ID 使用 1–64 位字母、数字、横线或下划线，并以字母或数字开头。')
    const bytes = new TextEncoder().encode(behaviorSource.value)
    if (!bytes.length || bytes.length > 32 * 1024) throw new Error('行为源码应为 1–32 KB。')
    const asset = await uploadAsset(`${id}.gd`,'text/x-gdscript',bytes)
    const definition = {id,asset_hash:asset.hash,api:1}
    if (!content.value.behaviors) content.value.behaviors = []
    const index = content.value.behaviors.findIndex(b=>b.id===id)
    if (index === -1) content.value.behaviors.push(definition)
    else content.value.behaviors.splice(index,1,definition)
    behaviorLoadedHash.value = asset.hash
    tell('真实行为源码已上传，模块引用已写入场景草稿。引擎验证与在线应用尚未执行。')
  })
}
function removeBehavior(id) {
  if (canEdit.value && !busy.value) content.value.behaviors = (content.value.behaviors || []).filter(b=>b.id!==id)
}
function downloadBehaviorSource() {
  const blob = new Blob([behaviorSource.value],{type:'text/plain;charset=utf-8'})
  const url = URL.createObjectURL(blob), anchor=document.createElement('a')
  anchor.href=url; anchor.download=`${behaviorId.value || 'behavior'}.gd`; anchor.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}

function localWorkspace() { return { format:1, project_id:projectId.value, branch:branchName.value, base_revision:baseRevision.value, content:clone(content.value) } }
async function saveContent() {
  await run('提交场景', async () => {
    const result = await post(`${branchPath()}/commit`, { base_revision:baseRevision.value, content:content.value, message:commitMessage.value || '更新场景与玩法配置' })
    localStorage.removeItem(draftKey.value); conflicts.value = null; commitMessage.value = ''
    await refreshProject(); await loadContent({ignoreDraft:true})
    tell(`场景已提交 ${shortId(result.revision)}。构建通过并应用到世界后才会生效。`)
  })
}
async function reloadServerContent() {
  await run('读取最新内容', async () => {
    if (dirty.value) {
      const backup = localWorkspace(); localStorage.setItem(`${draftKey.value}:backup`, JSON.stringify(backup)); backupDraft.value = backup
    }
    localStorage.removeItem(draftKey.value); conflicts.value = null
    await loadContent({ignoreDraft:true}); tell('已读取服务器最新内容。此前草稿已保留为本地备份，可随时下载。')
  })
}
function selectObject(id) { selectedId.value = id; inspectorTab.value = 'object'; command('select', {object_id:id}) }
function addObject() {
  const id = `object_${crypto.randomUUID().slice(0,8)}`
  content.value.objects.push({ id, name:'新的星屿装置', kind:'monument', x:0, z:0, scale:1, color:'#edbb6a', solid:true, zone_id:content.value.zones?.[0]?.id })
  selectedId.value = id
}
function removeObject() {
  if (!selected.value || !canEdit.value) return
  content.value.objects = content.value.objects.filter(o => o.id !== selectedId.value)
  selectedId.value = content.value.objects[0]?.id || ''
}
async function buildBranch() {
  await run('提交构建任务', async () => {
    const result = await post(`${branchPath()}/build`)
    await refreshProject(); tell(`构建任务 ${shortId(result.build?.id)} 已提交，正在等待真实引擎验证。`)
  })
}
async function applyLatest(world = selectedWorld.value) {
  if (!world) return
  let enterUpdatedClient = false
  await run('准备并应用可玩版本', async () => {
    const target = releases.value.find(r => r.id === playableId.value)
    const current = releases.value.find(r => r.id === world.release_id)
    const thisClientIsPlaying = frames.value.some(f => f.id === currentFrameId.value && f.world_id === world.id)
    if (thisClientIsPlaying && target && current && target.runtime_hash !== current.runtime_hash) {
      joinStatus.value = '正在准备匹配的新客户端，当前世界继续运行…'
      await verifyWebArtifacts(target.artifacts, progress => { downloadProgress.value = progress })
    }
    const applied = await post(`/worlds/${encodeURIComponent(world.id)}/apply-latest`, {release_id:target?.id || playableId.value})
    enterUpdatedClient = applied.requires_client_upgrade && thisClientIsPlaying
    await refreshProject(); joinStatus.value = ''
    tell(applied.requires_client_upgrade ? '世界已从最终检查点接续，正在进入匹配的新客户端。' : '服务器已确认世界版本更新；游戏端仍需完成实际内容同步。')
  })
  if (enterUpdatedClient && !error.value) await joinWorld()
}
async function submitModal() {
  const type = modal.value
  await run('保存', async () => {
    if (type === 'project') {
      const result = await post('/projects', {name:form.value.name})
      modal.value = null; await loadProjects(); await chooseProject(result.project.id); tell('新工程已创建，主干场景已准备。提交构建后可进入世界。')
    } else if (type === 'branch') {
      const name = form.value.name
      await post(`${projectPath()}/branches`, {name,from_branch:form.value.from_branch || branchName.value})
      modal.value = null; await refreshProject(); await chooseBranch(name); tell(`分支 ${name} 已创建。`)
    } else if (type === 'member') {
      await post(`${projectPath()}/members`, {name:form.value.name,role:form.value.role || 'editor'})
      modal.value = null; await refreshProject(); tell('协作者权限已保存。')
    } else if (type === 'task') {
      if(form.value.project_id!==projectId.value || form.value.branch!==branchName.value)throw new Error('批注所属工程或分支已改变，请重新选择对象。')
      if(form.value.origin==='live' && (!liveAnnotation.value || telemetry.value.release_id!==form.value.observed_release_id || telemetry.value.world_id!==form.value.observed_world_id))throw new Error('观察现场的版本已变化，请关闭后重新发起批注。')
      const created = await post(`${projectPath()}/tasks`, {branch:form.value.branch,object_id:form.value.object_id,title:form.value.title,origin:form.value.origin,...(form.value.origin==='live'?{observed_world_id:form.value.observed_world_id,observed_release_id:form.value.observed_release_id}:{base_revision:form.value.base_revision})})
      if (form.value.status === 'testing') await api(`/tasks/${encodeURIComponent(created.task.id)}`,{method:'PATCH',body:{status:'testing'}})
      modal.value = null; await refreshProject(); tell('对象任务已创建，所在分支的在线世界会同步施工状态。')
    } else if (type === 'world') {
      const result = await post(`${projectPath()}/worlds`, {branch:branchName.value,name:form.value.name || undefined})
      modal.value = null; selectedWorldId.value = result.world.id; await refreshProject(); tell('世界已创建，正在等待权威运行实例就绪。')
    }
  })
}
async function mergeBranch() {
  await run('合并到主干', async () => {
    await post(`${branchPath()}/merge`, {target:'main'})
    await refreshProject(); tell('场景内容已合并到主干。主干仍需构建与应用；实验世界的游玩进度不会一起合并。')
  })
}
async function updateTask(task, status) {
  await run('更新任务状态', async () => {
    await api(`/tasks/${encodeURIComponent(task.id)}`, {method:'PATCH',body:{status}})
    await refreshProject(); tell('协作者任务状态已更新。')
  })
}
async function downloadOffline() {
  await run('下载离线工作区', async () => {
    const pack = await api(`${branchPath()}/offline`)
    downloadJSON(pack, `${project.value.name}-${branchName.value}-${shortId(pack.base_revision)}.json`)
    tell('离线工作区已下载，包含基础提交与完整场景配置。')
  })
}
async function importFile(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  await run('导入离线修改', async () => {
    if (file.size > 20 * 1024 * 1024) throw new Error('工作区 JSON 超过 20 MB，请检查文件是否正确。')
    const pack = JSON.parse(await file.text())
    if (pack.format !== 1 || !pack.content || !pack.base_revision) throw new Error('文件不是有效的世界工坊离线工作区。')
    if (pack.project_id !== projectId.value) throw new Error('这个离线工作区属于另一工程，请先切换到对应工程。')
    if (pack.branch !== branchName.value) throw new Error(`工作区属于 ${pack.branch} 分支，请先切换分支再导入。`)
    loadingContent = true; content.value = clone(pack.content); baseRevision.value = pack.base_revision; loadingContent = false
    localStorage.setItem(draftKey.value, JSON.stringify({...pack,saved_at:Date.now()}))
    await post(`${branchPath()}/import`, {format:pack.format,project_id:pack.project_id,branch:pack.branch,base_revision:pack.base_revision,content:pack.content})
    localStorage.removeItem(draftKey.value); conflicts.value = null
    await refreshProject(); await loadContent({ignoreDraft:true}); tell('离线内容已合并到源码分支，等待构建验收。')
  })
}
async function joinWorld(mode = 'join-live') {
  const targetBranch = branchName.value
  if (pendingFrameId.value) return
  await run('准备目标世界', async () => {
    try {
    downloadProgress.value = null; joinStatus.value = '正在锁定匹配的客户端、内容和世界…'
    const result = await post(`${projectPath()}/checkouts`, {branch:branchName.value,platform:'web',mode,...(mode === 'join-live' && selectedWorld.value ? {world_id:selectedWorld.value.id,release_id:selectedWorld.value.release_id} : {})})
    await verifyWebArtifacts(result.artifacts, progress => {
      downloadProgress.value = progress
      const size = `${(progress.loaded / 1048576).toFixed(1)} / ${(progress.total / 1048576).toFixed(1)} MB`
      joinStatus.value = progress.complete ? '游戏产物 SHA-256 已验证，正在准备世界与加入票据…' : `${progress.verifying ? '校验' : '下载'}游戏资源 · ${size}`
    })
    const prepared = await post(`/checkouts/${encodeURIComponent(result.checkout.id)}/prepare-join`)
    if (!prepared.game_url) throw new Error('服务器没有提供这个版本的网页游戏产物。')
    const url = new URL(prepared.game_url, window.location.href)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('游戏产物地址协议不受支持。')
    const id = crypto.randomUUID()
    pendingFrameId.value = id
    frames.value.push({id,project_id:projectId.value,url:url.href,world_id:prepared.world_id,release_id:prepared.release_id,branch:targetBranch,origin:url.origin,started:Date.now()})
    joinStatus.value = '正在下载 Godot 游戏并同步世界；等待实际控制权确认…'
    notice.value = ''
    } catch(e) { joinStatus.value = ''; downloadProgress.value = null; throw e }
  })
}
function setFrame(el, id) { if (el) frameEls.set(id, el); else frameEls.delete(id) }
function handleMessage(event) {
  const frame = frames.value.find(f => frameEls.get(f.id)?.contentWindow === event.source && f.origin === event.origin)
  if (!frame || event.data?.source !== 'world-atelier-game') return
  const data = event.data
  if (data.type === 'telemetry') {
    if (frame.id === pendingFrameId.value) {
      if (data.error) { pendingFailure(frame, String(data.error)); return }
      if (data.active && data.world_id === frame.world_id && data.release_id === frame.release_id) {
        currentFrameId.value = frame.id; pendingFrameId.value = null; frames.value = [frame]
        telemetry.value = data; lastTelemetryAt = Date.now(); joinStatus.value = ''
        tell(`已进入 ${frame.branch} 世界，运行端已确认同步与控制权。`)
        nextTick(() => frameEls.get(frame.id)?.focus())
      }
    } else if (frame.id === currentFrameId.value) {
      telemetry.value = data; lastTelemetryAt = Date.now()
      if (frame.project_id===projectId.value && frame.branch===branchName.value && data.selected && objects.value.some(o => o.id === data.selected)) selectedId.value = data.selected
    }
  } else if (data.type === 'progress' && frame.id === pendingFrameId.value) {
    joinStatus.value = Number.isFinite(data.total) && data.total > 0 ? `下载游戏资源 ${Math.min(100,Math.round(data.loaded / data.total * 100))}%` : '正在下载游戏资源…'
  } else if (data.type === 'error') { pendingFailure(frame, String(data.error || data.message || '游戏加载失败')) }
}
function pendingFailure(frame, message) {
  error.value = message
  if (frame.id === pendingFrameId.value) { frames.value = frames.value.filter(f=>f.id!==frame.id); pendingFrameId.value = null; joinStatus.value = '' }
}
function command(action, payload = {}) {
  if (!active.value) return
  const frame = frames.value.find(f => f.id === currentFrameId.value)
  frameEls.get(frame?.id)?.contentWindow?.postMessage({source:'world-atelier-portal',type:'command',action,payload}, frame.origin)
}
function cancelJoin() {
  frames.value = frames.value.filter(f => f.id !== pendingFrameId.value); pendingFrameId.value = null
  joinStatus.value = ''; tell('已关闭尚未完成进入的目标运行实例。')
}
async function downloadDesktop() {
  await run('解析桌面客户端', async () => {
    desktopPackage.value = await post(`${projectPath()}/checkouts`, {branch:branchName.value,platform:'macos',mode:'offline'})
    modal.value = 'desktop'
  })
}
function artifactEntries(pack) {
  const artifacts = pack?.artifacts || []
  return (Array.isArray(artifacts) ? artifacts : Object.entries(artifacts).map(([name,value]) => typeof value === 'string' ? {name,url:value} : {name,...value})).filter(a => (!a.platform || a.platform === 'macos') && (a.url || a.download_url))
}
async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await gamePanel.value?.requestFullscreen() } catch(e) { fail(e) } }
function beforeUnload(event) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
function onOnline() { offline.value = false; refreshProject().catch(fail) }
function onOffline() { offline.value = true }
onMounted(async () => {
  window.addEventListener('message', handleMessage); window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline); window.addEventListener('beforeunload', beforeUnload)
  if (session.value) await run('恢复工作区', async () => { try { await api('/me'); await loadProjects() } catch(e) { if (e.status === 401) logout(); throw e } })
  pollTimer = setInterval(async () => {
    if (!session.value || !projectId.value || polling) return
    polling = true
    try { await refreshProject(); if(modal.value==='history')await loadObjectHistory() } catch (e) { if (e.status !== 401) offline.value = true } finally { polling = false }
    if (telemetry.value?.active && lastTelemetryAt && Date.now() - lastTelemetryAt > 15000) telemetry.value = {...telemetry.value,active:false}
  }, 3000)
})
onBeforeUnmount(() => { clearInterval(pollTimer); window.removeEventListener('message',handleMessage); window.removeEventListener('online',onOnline); window.removeEventListener('offline',onOffline); window.removeEventListener('beforeunload',beforeUnload) })
</script>

<template>
  <div v-if="!session" class="auth-shell">
    <section class="auth-story">
      <a class="wordmark" href="/"><span class="brand-icon"><Icon name="star" size="25" /></span><span>世界工坊 <small>WORLD ATELIER</small></span></a>
      <div class="story-body"><p class="eyebrow">A WORLD WE BUILD TOGETHER</p><h1>世界在生长。<br>你也在其中。</h1><p class="story-description">进入星屿，和同伴一起探索。<br>在游玩中创作，让每一次想法成为世界的一部分。</p><div class="story-tags"><span><Icon name="globe" size="15" />真实世界</span><span><Icon name="branch" size="15" />分支创作</span><span><Icon name="users" size="15" />多人协作</span></div></div>
      <div class="orbital-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit orbit-three"></div><div class="star-core"><Icon name="star" size="90" /></div><i class="satellite satellite-one"></i><i class="satellite satellite-two"></i><span class="orbit-label">STARFALL<br>EXPEDITION</span></div>
      <div class="story-foot"><span>01 / 星屿远征</span><span>EXPLORE. CREATE. CONTINUE.</span></div>
    </section>
    <section class="auth-panel">
      <div class="auth-card"><p class="eyebrow">YOUR NEXT WORLD STARTS HERE</p><h2>{{ authMode === 'register' ? '成为世界的共创者' : '欢迎回到工坊' }}</h2><p class="muted">连接中央服务，继续你的探索与创作。</p>
        <div class="segmented"><button :class="{selected:authMode === 'register'}" @click="authMode='register'">创建账号</button><button :class="{selected:authMode === 'login'}" @click="authMode='login'">登录工坊</button></div>
        <form @submit.prevent="authenticate"><label>协作者名称<input v-model="credentials.name" name="username" autocomplete="username" required minlength="2" maxlength="40" placeholder="在世界中如何称呼你" /></label><label>密码<input v-model="credentials.password" name="password" type="password" :autocomplete="authMode === 'register' ? 'new-password' : 'current-password'" required minlength="8" placeholder="至少 8 个字符" /></label><div v-if="error" class="inline-error" role="alert"><Icon name="alert" size="16" />{{ error }}</div><button class="button primary auth-submit" :disabled="!!busy">{{ busy || (authMode === 'register' ? '创建账号，进入工坊' : '登录并继续') }}<Icon name="arrow" size="18" /></button></form>
        <p class="auth-note"><Icon name="shield" size="16" />账号与世界数据保存在当前中央服务。</p>
      </div><span class="auth-bottom">世界工坊 · WORLD ATELIER</span>
    </section>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <a class="wordmark" href="/" @click.prevent="page='world'"><span class="brand-icon"><Icon name="star" size="25" /></span><span>世界工坊 <small>WORLD ATELIER</small></span></a>
      <div class="project-switch"><label for="project-select" class="eyebrow">当前工程</label><div class="project-select-row"><Icon name="box" size="18" /><select id="project-select" :value="projectId" aria-label="选择工程" :disabled="!!busy" @change="run('切换工程',()=>chooseProject($event.target.value))"><option disabled value="">选择一个工程</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select></div><button class="text-button" @click="openModal('project')"><Icon name="plus" size="13" />新建工程</button></div>
      <nav aria-label="主导航"><button v-for="item in nav" :key="item.id" :class="['nav-item',{current:page === item.id}]" :disabled="!projectId" @click="page=item.id"><Icon :name="item.icon" size="20" /><span>{{ item.label }}</span><span v-if="item.id === 'collaboration' && activeCount" class="nav-count">{{ activeCount }}</span></button></nav>
      <div v-if="projectId" class="sidebar-branches"><div class="sidebar-section-title"><span>工作分支</span><button class="icon-button" title="新建分支" aria-label="新建分支" :disabled="!canEdit" @click="openModal('branch',{from_branch:branchName})"><Icon name="plus" size="15" /></button></div><button v-for="b in branches.slice(0,7)" :key="branchLabel(b)" :disabled="!!busy" :class="['branch-item',{selected:branchName===branchLabel(b)}]" @click="chooseBranch(branchLabel(b))"><span class="branch-dot" :class="{main:branchLabel(b)==='main'}"></span><span>{{ branchLabel(b) }}</span><Icon v-if="branchName===branchLabel(b)" name="check" size="13" /></button></div>
      <div class="sidebar-bottom"><div class="service-status"><i :class="{disconnected:offline}"></i><span>{{ offline ? '连接暂时中断' : '中央服务已连接' }}</span></div><div class="user-row"><span class="avatar">{{ session.user.name.slice(0,1).toUpperCase() }}</span><div><strong>{{ session.user.name }}</strong><small>{{ projectId ? roleLabels[role] : '共创者' }}</small></div><button class="icon-button" aria-label="退出登录" title="退出登录" @click="logout"><Icon name="logout" size="18" /></button></div></div>
    </aside>

    <main class="workspace">
      <header class="topbar"><div class="breadcrumb"><span>我的工作空间</span><Icon name="chevron" size="13" /><strong>{{ project?.name || '开始新的世界' }}</strong><span v-if="projectId" class="local-badge">共享工程</span></div><div class="topbar-actions"><span class="sync-label"><Icon name="refresh" size="13" />{{ busy || (lastSynced ? `同步于 ${timestamp(lastSynced).split(' ')[1] || '刚刚'}` : '正在连接') }}</span><button v-if="projectId" class="icon-button" aria-label="刷新工程" title="刷新工程" :disabled="!!busy" @click="run('刷新工程',refreshProject)"><Icon name="refresh" size="17" /></button><span class="avatar small">{{ session.user.name.slice(0,1).toUpperCase() }}</span></div></header>
      <div class="page-content">
        <div v-if="error" class="banner error-banner" role="alert"><Icon name="alert" size="18" /><div><strong>操作未完成</strong><span>{{ error }}</span></div><button class="icon-button" aria-label="关闭错误" @click="error='' "><Icon name="close" size="16" /></button></div>
        <div v-if="notice" class="banner notice-banner" role="status"><Icon name="check" size="18" /><span>{{ notice }}</span><button class="icon-button" aria-label="关闭提示" @click="notice='' "><Icon name="close" size="16" /></button></div>
        <div v-if="offline" class="banner offline-banner"><Icon name="wifi" size="18" /><span>暂时无法同步中央服务。场景修改会继续保存在此浏览器，联网后可提交。</span></div>
        <div v-if="!projectId" class="new-project-empty"><span class="large-emblem"><Icon name="star" size="50" /></span><p class="eyebrow">YOUR WORLD, YOUR NEXT CHAPTER</p><h1>从一座星屿开始</h1><p>创建包含四大区域的远征工程，邀请同伴，<br>让探索、战斗与现场创作发生在同一个世界。</p><button class="button primary" @click="openModal('project',{name:'星屿远征'})"><Icon name="plus" size="18" />创建第一个工程</button><div class="start-features"><span><Icon name="compass" />四个探索区域</span><span><Icon name="branch" />独立开发分支</span><span><Icon name="users" />协作与权限</span></div></div>

        <template v-else>
          <section class="page-heading"><div><p class="eyebrow">STARFALL EXPEDITION <span class="eyebrow-line"></span> SHARED WORLD</p><h1>{{ page === 'world' ? '进入世界，继续创造。' : page === 'editor' ? '让想法在现场发生。' : page === 'versions' ? '每个分支，都是一种可能。' : page === 'collaboration' ? '一起，建造下一个世界。' : '带着你的世界出发。' }}</h1><p>{{ page === 'world' ? '探索星屿远征，与同伴共同塑造这片正在生长的世界。' : page === 'editor' ? '编辑真实场景与玩法规则。提交、验证，再将改动带入正在游玩的世界。' : page === 'versions' ? '源码、可玩发行与在线世界分别记录；每次进入都有明确的版本。' : page === 'collaboration' ? '围绕具体对象协作，让开发、验证与交付在世界中清晰可见。' : '保留基础版本，离线制作，回到工坊后合并真实内容。' }}</p></div><div class="heading-actions"><button class="button secondary" :disabled="!!busy" @click="downloadDesktop"><Icon name="download" size="16" />桌面客户端</button><button class="button primary" :disabled="!!busy || !!pendingFrameId || !playableId" @click="joinWorld()"><Icon name="play" size="16" />{{ active ? '进入所选世界' : '进入世界' }}</button></div></section>

          <div class="version-strip"><div class="branch-select"><Icon name="branch" size="16" /><select aria-label="当前分支" :disabled="!!busy" :value="branchName" @change="chooseBranch($event.target.value)"><option v-for="b in branches" :key="branchLabel(b)" :value="branchLabel(b)">{{ branchLabel(b) }}</option></select><span v-if="branchName==='main'" class="tiny-label">主干</span></div><div><span>源码</span><code :title="sourceId">{{ shortId(sourceId) }}</code></div><Icon name="chevron" size="12" /><div><span>可玩发行</span><code :title="playableId">{{ shortId(playableId) }}</code></div><Icon name="chevron" size="12" /><div><span>所选世界</span><code :title="selectedWorld?.release_id">{{ shortId(selectedWorld?.release_id) }}</code></div><span class="strip-end"><i class="dot" :class="active ? 'green' : 'gray'"></i>{{ active ? '游戏已确认在线' : '尚未接管游戏' }}</span></div>

          <div v-if="conflicts" class="conflict-box" role="alert"><div><Icon name="branch" size="22" /><h3>这次修改需要处理冲突</h3></div><p>其他协作者也修改了相同内容。你的草稿与基础版本已保留，可下载比较后继续编辑。</p><pre>{{ JSON.stringify(conflicts,null,2) }}</pre><div class="button-row"><button class="button secondary" @click="downloadJSON(localWorkspace(),`${branchName}-conflicting-draft.json`)"><Icon name="download" size="15" />下载我的草稿</button><button class="button secondary" :disabled="!!busy" @click="reloadServerContent">备份草稿并读取最新版</button></div></div>

          <div v-show="page==='world' || page==='editor'" class="world-layout" :class="{'editor-layout':page==='editor'}">
            <div class="world-main"><div v-if="joinStatus && !pendingFrameId" class="download-status" role="status"><span class="spinner"></span><div><strong>{{ joinStatus }}</strong><progress v-if="downloadProgress?.total" :value="downloadProgress.loaded" :max="downloadProgress.total" aria-label="真实游戏下载进度"></progress></div></div>
              <section ref="gamePanel" class="game-panel" :data-game-active="active" :data-world-id="telemetry?.world_id || ''" :data-release-id="telemetry?.release_id || ''">
                <div class="game-toolbar"><div class="game-title"><span class="live-square" :class="{active}"></span><strong>星屿远征</strong><span v-if="currentFrameId" class="game-active-branch">{{ frames.find(f=>f.id===currentFrameId)?.branch }}</span><span v-else>STARFALL EXPEDITION</span></div><div class="game-tools"><span v-if="telemetry" class="game-tick">TICK {{ telemetry.tick || 0 }}</span><button class="icon-button" title="展开游戏" aria-label="展开游戏" @click="fullscreen"><Icon name="fullscreen" size="17" /></button></div></div>
                <div class="game-viewport">
                  <iframe v-for="frame in frames" :key="frame.id" :ref="el=>setFrame(el,frame.id)" :src="frame.url" title="星屿远征 Godot 游戏" allow="autoplay; fullscreen; gamepad; cross-origin-isolated" :class="{'game-frame':true, 'pending-frame':frame.id===pendingFrameId && !!currentFrameId}" />
                  <div v-if="!frames.length" class="game-empty"><div class="empty-world-symbol"><Icon name="compass" size="62" /></div><p class="eyebrow">THE EXPEDITION AWAITS</p><h2>下一段远征，从这里开始。</h2><p v-if="playableId">进入 {{ branchName }} 分支的真实世界，<br>探索、战斗，或与同伴一起改变这片星屿。</p><p v-else>场景内容已准备。首次进入前，<br>请构建并验证这个分支的可玩版本。</p><button v-if="playableId" class="button primary" :disabled="!!busy" @click="joinWorld()"><Icon name="play" size="17" />进入星屿</button><button v-else class="button primary" :disabled="!!busy || !canEdit" @click="buildBranch"><Icon name="hammer" size="17" />构建首个可玩版本</button><span class="game-empty-foot">GODOT ENGINE · 真实在线玩法</span></div>
                  <div v-if="pendingFrameId" class="game-loading"><span class="spinner"></span><div><strong>正在前往 {{ frames.find(f=>f.id===pendingFrameId)?.branch }}</strong><p>{{ joinStatus }}</p></div><button class="icon-button" aria-label="取消世界跳转" title="取消世界跳转" @click="cancelJoin"><Icon name="close" size="16" /></button></div>
                  <div v-else-if="currentFrameId && !active" class="game-loading"><Icon name="wifi" size="20" /><div><strong>等待游戏同步与控制权</strong><p>尚未收到有效运行确认；角色输入暂时不可用。</p></div></div>
                </div>
                <div class="game-footer"><div class="key-hints"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>移动</span><span><kbd>Space</kbd>攻击</span><span><kbd>Shift</kbd>闪避</span><span><kbd>E</kbd>交互</span></div><button class="text-button" @click="showControls=!showControls"><Icon name="settings" size="14" />辅助操作</button></div>
                <div v-if="showControls" class="accessible-controls"><div class="move-pad"><button aria-label="向前移动" :disabled="!active" @pointerdown="command('move',{x:0,z:-1})" @pointerup="command('move',{x:0,z:0})" @pointerleave="command('move',{x:0,z:0})">↑</button><button aria-label="向左移动" :disabled="!active" @pointerdown="command('move',{x:-1,z:0})" @pointerup="command('move',{x:0,z:0})" @pointerleave="command('move',{x:0,z:0})">←</button><button aria-label="向后移动" :disabled="!active" @pointerdown="command('move',{x:0,z:1})" @pointerup="command('move',{x:0,z:0})" @pointerleave="command('move',{x:0,z:0})">↓</button><button aria-label="向右移动" :disabled="!active" @pointerdown="command('move',{x:1,z:0})" @pointerup="command('move',{x:0,z:0})" @pointerleave="command('move',{x:0,z:0})">→</button></div><button class="button secondary" :disabled="!active" @click="command('attack')">攻击</button><button class="button secondary" :disabled="!active" @click="command('dash')">闪避</button><button class="button secondary" :disabled="!active" @click="command('interact')">附近交互</button><button class="button secondary" :disabled="!active" @click="command('upgrade')">升级装备</button></div>
              </section>
              <div class="below-game"><section class="panel world-selector"><div class="section-heading"><div><span class="eyebrow">LIVE WORLDS</span><h3>当前分支的世界</h3></div><button class="icon-button" aria-label="创建世界" title="创建世界" :disabled="!canEdit || !playableId || !!busy" @click="openModal('world',{name:`${branchName} · 共享世界`})"><Icon name="plus" size="18" /></button></div><div v-if="!branchWorlds.length" class="small-empty">构建通过后，可直接进入或创建独立世界。</div><label v-for="world in branchWorlds.slice(0,3)" :key="world.id" class="world-option" :class="{selected:selectedWorld?.id===world.id}"><input type="radio" name="world" :value="world.id" v-model="selectedWorldId" /><Icon name="globe" size="20" /><div><strong>{{ world.name || `${branchName} 世界` }}</strong><small>{{ shortId(world.release_id) }} · {{ statusLabel(world.status) }}</small></div><span class="world-option-dot"></span></label><div class="world-actions"><button class="text-button" :disabled="!selectedWorld || !canEdit || !!busy || selectedWorld.release_id===playableId" @click="applyLatest()"><Icon name="refresh" size="14" />应用最新可玩版本</button><button class="text-button" :disabled="!playableId || !!busy" @click="joinWorld('preview-frozen')">独立试玩 <Icon name="arrow" size="14" /></button></div></section><section class="panel expedition-card"><div class="section-heading"><div><span class="eyebrow">EXPEDITION JOURNAL</span><h3>{{ active ? '你的远征记录' : '星屿探索计划' }}</h3></div><Icon name="compass" size="24" /></div><div v-if="active" class="player-stats"><div><strong>{{ player.level || 1 }}</strong><span>远征等级</span></div><div><strong>{{ player.crystals ?? 0 }}</strong><span>星晶</span></div><div><strong>{{ player.kills ?? 0 }}</strong><span>击败敌人</span></div></div><div v-else class="zone-chips"><span v-for="zone in content?.zones" :key="zone.id"><i :style="{background:zone.color}"></i>{{ zone.name }}</span></div><p>{{ active ? `生命 ${Math.round(player.hp || 0)} / ${player.max_hp || '—'} · 任务阶段 ${player.quest_stage ?? 0} · 状态来自当前权威世界` : '观测站集结、探索园林、穿越铸炉，最后向古代城塞进发。' }}</p></section></div>
              <section v-if="page==='editor' && content" class="panel scene-objects"><div class="section-heading"><div><span class="eyebrow">SCENE CONTENT</span><h3>场景对象 <span class="count">{{ objects.length }}</span></h3></div><button class="button secondary compact" :disabled="!canEdit || !!busy" @click="addObject"><Icon name="plus" size="14" />添加对象</button></div><div class="object-filters"><div class="search-field"><Icon name="search" size="16" /><input v-model="search" placeholder="查找名称、类型或对象 ID" aria-label="搜索场景对象" /></div><select v-model="zoneFilter" aria-label="筛选区域"><option value="all">全部区域</option><option v-for="zone in content.zones" :key="zone.id" :value="zone.id">{{ zone.name }}</option></select></div><div class="object-grid"><button v-for="object in filteredObjects" :key="object.id" :class="['object-tile',{selected:object.id===selectedId}]" @click="selectObject(object.id)"><span class="object-swatch" :style="{'--object-color':object.color}"><Icon :name="object.kind==='beacon' ? 'star' : 'box'" size="20" /></span><div><strong>{{ object.name }}</strong><small>{{ object.kind }} · {{ object.id }}</small></div><i v-if="taskFor(object.id)" class="maintenance-dot" :class="taskFor(object.id).status"></i></button></div></section>
            </div>

            <aside class="inspector panel">
              <div class="inspector-head"><div><span class="eyebrow">WORLD INSPECTOR</span><h3>现场检查器</h3></div><Icon name="layers" size="19" /></div><div class="inspector-tabs"><button :class="{selected:inspectorTab==='object'}" @click="inspectorTab='object'">对象</button><button :class="{selected:inspectorTab==='rules'}" @click="inspectorTab='rules'">规则</button><button :class="{selected:inspectorTab==='tasks'}" @click="inspectorTab='tasks'">协作 <span v-if="activeCount">{{ activeCount }}</span></button></div>
              <template v-if="inspectorTab==='object' && content"><div class="inspector-body"><label class="object-picker-label">当前对象<select :value="selectedId" aria-label="当前对象" @change="selectObject($event.target.value)"><option v-for="o in objects" :key="o.id" :value="o.id">{{ o.name }}</option></select></label><template v-if="selected"><div class="selected-object-preview" :style="{'--object-color':selected.color}"><span class="preview-halo"></span><span class="preview-object"><Icon :name="selected.kind==='beacon' ? 'star' : 'box'" size="44" /></span><span class="selection-bracket tl"></span><span class="selection-bracket tr"></span><span class="selection-bracket bl"></span><span class="selection-bracket br"></span><span class="preview-label">对象配置示意</span></div><div class="object-title"><h3>{{ selected.name }}</h3><code>{{ selected.id }}</code></div><fieldset :disabled="!canEdit || !!busy"><label>名称<input v-model="selected.name" aria-label="对象名称" maxlength="100" /></label><div class="field-section-title"><Icon name="compass" size="14" />空间变换</div><div class="coordinate-fields"><label><span>X</span><input v-model.number="selected.x" type="number" step="0.5" aria-label="对象 X 坐标" /></label><label><span>Z</span><input v-model.number="selected.z" type="number" step="0.5" aria-label="对象 Z 坐标" /></label><label><span>缩放</span><input v-model.number="selected.scale" type="number" min="0.1" max="20" step="0.1" aria-label="对象缩放" /></label></div><div class="field-section-title"><Icon name="eye" size="14" />外观与交互</div><label class="color-field"><span>对象颜色</span><input v-model="selected.color" type="color" aria-label="对象颜色" /><code>{{ selected.color }}</code></label><label class="checkbox-field"><span>实体碰撞<small>角色与敌人会受到阻挡</small></span><input v-model="selected.solid" type="checkbox" aria-label="实体碰撞" /><span class="toggle-track"></span></label></fieldset><section class="asset-section"><div class="field-section-title"><Icon name="box" size="14" />真实 GLB 模型</div><div v-if="selected.model_asset" class="asset-reference"><Icon name="box" size="18" /><div><strong>{{ assets.find(a=>a.hash===selected.model_asset)?.name || '已关联模型资产' }}</strong><code :title="selected.model_asset">{{ selected.model_asset.slice(0,18) }}…</code></div><button class="icon-button" title="从草稿解除模型绑定" aria-label="解除模型绑定" :disabled="!canEdit || !!busy" @click="clearModel"><Icon name="close" size="13" /></button></div><p v-else class="asset-hint">上传模型替换该对象的外观。变更经过真实构建与世界应用后生效。</p><div class="asset-buttons"><button class="button secondary compact" :disabled="!canEdit || !!busy" @click="modelInput?.click()"><Icon name="upload" size="13" />上传 GLB</button><button class="button secondary compact" :disabled="!!busy" @click="openAssetLibrary"><Icon name="layers" size="13" />资源库</button></div><small class="asset-limit">二进制 glTF · 最大 2 MB · 不可变内容哈希</small></section><button class="button secondary full-width object-history-entry" @click="openObjectHistory()"><Icon name="branch" size="15" />对象版本与批注</button><div class="selection-note"><span class="outline-swatch"></span><p>选中对象使用青色包围描边。<br>有进行中的任务时显示施工光圈。</p></div><button class="button secondary full-width" :disabled="!canEdit || !!busy" @click="openModal('task',{object_id:selectedId,status:'editing'})"><Icon name="hammer" size="15" />为此对象发起开发任务</button><div v-if="selectedTasks.length" class="object-task-mini"><div v-for="task in selectedTasks" :key="task.id"><i class="dot" :class="task.status==='delivered' ? 'green' : 'amber'"></i><span>{{ task.title }}</span><small>{{ statusLabel(task.status) }}</small></div></div><button v-if="page==='editor'" class="text-button danger-text delete-object" :disabled="!canEdit || !!busy" @click="removeObject"><Icon name="trash" size="13" />从草稿删除对象</button></template></div></template>
              <div v-else-if="inspectorTab==='rules' && content" class="inspector-body"><p class="form-note">玩法参数会由真实 Godot 引擎验证。构建成功后，应用到在线世界以验证实际行为。</p><fieldset :disabled="!canEdit || !!busy"><label v-for="(value,key) in content.rules" :key="key">{{ ({player_speed:'角色移动速度',attack_damage:'攻击伤害',enemy_damage:'敌人伤害',attack_range:'攻击范围',dash_speed:'闪避速度'})[key] || key }}<input v-if="typeof value==='number'" v-model.number="content.rules[key]" type="number" step="0.1" :aria-label="`规则 ${key}`" /><input v-else v-model="content.rules[key]" :aria-label="`规则 ${key}`" /></label></fieldset><div class="rule-summary"><strong>{{ content.quests?.length || 0 }} 个任务</strong><span>{{ content.enemies?.length || 0 }} 个敌人 · {{ content.zones?.length || 0 }} 个区域</span></div><section class="behavior-section"><div class="behavior-heading"><div><span class="eyebrow">LIVE BEHAVIOR MODULES</span><h4>真实行为模块</h4></div><Icon name="activity" size="18" /></div><p class="asset-hint">GDScript 通过 evaluate(context) 返回规则覆盖。这里编辑实际源码，保存后仍需引擎验证与世界应用。</p><div v-for="behavior in content.behaviors || []" :key="behavior.id" class="behavior-row"><button class="behavior-open" :disabled="!!busy" @click="readBehavior(behavior)"><Icon name="activity" size="14" /><div><strong>{{ behavior.id }}</strong><code>{{ shortId(behavior.asset_hash) }}</code></div></button><button class="icon-button" :aria-label="`移除行为 ${behavior.id}`" title="从草稿移除模块" :disabled="!canEdit || !!busy" @click="removeBehavior(behavior.id)"><Icon name="close" size="13" /></button></div><fieldset :disabled="!canEdit || !!busy"><label>模块 ID<input v-model="behaviorId" aria-label="行为模块 ID" maxlength="64" placeholder="cooperative-damage" /></label><label class="source-label">GDScript 源码<span class="source-origin">{{ behaviorLoadedHash ? `已读取 ${shortId(behaviorLoadedHash)}` : '本机源码草稿' }}</span><textarea v-model="behaviorSource" aria-label="GDScript 行为源码" rows="12" spellcheck="false" autocomplete="off" autocapitalize="off" /></label></fieldset><div class="asset-buttons"><button class="button secondary compact" :disabled="!canEdit || !!busy" @click="behaviorFileInput?.click()"><Icon name="upload" size="12" />打开 .gd</button><button class="button secondary compact" @click="downloadBehaviorSource"><Icon name="download" size="12" />保存源码</button></div><button class="button secondary full-width" :disabled="!canEdit || !!busy || !behaviorSource.trim()" @click="uploadBehavior"><Icon name="upload" size="14" />上传并更新模块引用</button><small class="asset-limit">32 KB 以内 · API 1 · 仅上传不代表已生效</small></section></div>
              <div v-else-if="inspectorTab==='tasks'" class="inspector-body"><div class="legend"><span><i class="outline-swatch"></i>选中</span><span><i class="hazard-swatch"></i>开发中</span><span><i class="dot green"></i>已交付</span></div><div v-if="!branchTasks.length" class="small-empty">尚无对象任务。<br>选中场景对象，为协作者添加工作。</div><article v-for="task in branchTasks" :key="task.id" class="mini-task" @click="selectObject(task.object_id)"><div><span class="badge" :class="statusClass(task.status)">{{ statusLabel(task.status) }}</span><small>{{ actor(task) }}</small></div><h4>{{ task.title }}</h4><code>{{ task.object_id }}</code></article></div>
              <div v-if="!content" class="small-empty">正在读取场景内容…</div>
              <div v-if="content" class="inspector-footer"><div class="draft-status"><i class="dot" :class="dirty ? 'amber' : 'green'"></i><span>{{ dirty ? '有未提交修改 · 已保存在本机' : '场景与已读取版本一致' }}</span></div><p v-if="remoteChanged" class="remote-notice">服务器已有更新；提交时会进行三方合并。</p><input v-model="commitMessage" placeholder="这次改动做了什么？" aria-label="提交说明" :disabled="!canEdit || !!busy" /><button class="button primary full-width" :disabled="!dirty || !canEdit || !!busy" @click="saveContent"><Icon name="save" size="15" />提交场景修改</button><div class="footer-secondary-actions"><button class="text-button" :disabled="!canEdit || !!busy" @click="buildBranch">构建验证</button><span>→</span><button class="text-button" :disabled="!canEdit || !selectedWorld || !!busy || selectedWorld.release_id===playableId" @click="applyLatest()">应用到世界</button></div></div>
            </aside>
          </div>

          <section v-if="page==='versions'" class="versions-page">
            <div class="two-columns"><section class="panel"><div class="section-heading"><div><span class="eyebrow">BRANCHES</span><h3>工程分支</h3></div><button class="button secondary compact" :disabled="!canEdit" @click="openModal('branch',{from_branch:branchName})"><Icon name="plus" size="14" />新建分支</button></div><div v-for="b in branches" :key="branchLabel(b)" class="branch-card" :class="{selected:branchName===branchLabel(b)}"><button class="branch-card-main" :disabled="!!busy" @click="chooseBranch(branchLabel(b))"><span class="branch-symbol"><Icon name="branch" size="20" /></span><div><h4>{{ branchLabel(b) }} <span v-if="branchLabel(b)==='main'" class="tiny-label">主干</span></h4><p>源码 {{ shortId(b.source_head) }} · 可玩 {{ shortId(b.playable_head) }}</p></div><Icon v-if="branchName===branchLabel(b)" name="check" size="17" /></button></div><div class="button-row panel-bottom"><button class="button primary" :disabled="!canEdit || !!busy" @click="buildBranch"><Icon name="hammer" size="16" />构建 {{ branchName }}</button><button class="button secondary" :disabled="!canEdit || branchName==='main' || !!busy" @click="mergeBranch"><Icon name="branch" size="16" />合并到主干</button></div><p class="form-note">合并只推进源码。每个在线世界仍保留自己的发行版本与游玩进度。</p></section><section class="panel"><div class="section-heading"><div><span class="eyebrow">BUILD PIPELINE</span><h3>真实构建记录</h3></div><span class="count">{{ builds.length }}</span></div><div v-if="!builds.length" class="small-empty">还没有构建任务。<br>开始构建后，这里会显示引擎实际验证结果。</div><article v-for="build in [...builds].reverse().slice(0,8)" :key="build.id" class="build-row"><div><Icon name="hammer" size="18" /><strong>{{ build.branch || build.branch_name || '构建' }}</strong><span class="badge" :class="statusClass(build.status)">{{ statusLabel(build.status) }}</span></div><p>{{ shortId(build.source_revision || build.revision || build.id) }} <span>{{ timestamp(build.created_at) }}</span></p><pre v-if="build.error || build.log || build.output">{{ build.error || build.log || build.output }}</pre></article></section></div>
            <section class="panel release-panel"><div class="section-heading"><div><span class="eyebrow">IMMUTABLE RELEASES</span><h3>可玩发行与世界</h3></div><button class="button secondary compact" :disabled="!canEdit || !playableId" @click="openModal('world')"><Icon name="plus" size="15" />新建世界</button></div><div v-if="!releases.length" class="small-empty">构建成功后，经过验证的发行版本会在这里登记。</div><div v-else class="table-scroll"><table><thead><tr><th>发行版本</th><th>来源提交</th><th>分支</th><th>验证状态</th><th>登记时间</th></tr></thead><tbody><tr v-for="release in [...releases].reverse()" :key="release.id"><td><code>{{ shortId(release.id) }}</code></td><td><code>{{ shortId(release.source_revision || release.revision) }}</code></td><td><span class="branch-label"><Icon name="branch" size="13" />{{ release.branch || release.branch_name || builds.find(b=>b.revision===release.revision)?.branch || '历史版本' }}</span></td><td><span class="badge" :class="statusClass(release.status || 'ready')">{{ statusLabel(release.status || 'ready') }}</span></td><td>{{ timestamp(release.created_at) }}</td></tr></tbody></table></div><div class="world-list"><article v-for="world in worlds" :key="world.id"><Icon name="globe" size="25" /><div><h4>{{ world.name || world.id }}</h4><p>{{ world.branch || world.branch_name }} · 发行 {{ shortId(world.release_id) }} · {{ statusLabel(world.status) }}</p></div><button class="button secondary compact" :disabled="!canEdit || !!busy" @click="applyLatest(world)">应用分支最新</button></article></div></section>
          </section>

          <section v-if="page==='collaboration'" class="collaboration-page"><div class="collaboration-grid"><section class="panel"><div class="section-heading"><div><span class="eyebrow">PEOPLE IN THIS WORLD</span><h3>工程协作者 <span class="count">{{ members.length }}</span></h3></div><button class="button secondary compact" :disabled="!canManage" @click="openModal('member',{role:'editor'})"><Icon name="plus" size="14" />添加成员</button></div><div v-for="(member,index) in members" :key="member.user_id || member.id || member.name" class="member-row"><span class="avatar" :class="`avatar-${index%4}`">{{ (member.name || member.user_name || '?').slice(0,1).toUpperCase() }}</span><div><strong>{{ member.name || member.user_name }}</strong><small>{{ roleLabels[member.role] || member.role }}</small></div><span v-if="(member.user_id || member.id)===session.user.id" class="tiny-label">你</span></div><p class="form-note">开发者可修改、构建与管理对象任务；测试者可试玩验证；观察者可查看。成员需要先在此服务注册账号。</p></section><section class="panel activity-panel"><div class="section-heading"><div><span class="eyebrow">ACTIVITY FEED</span><h3>工程动态</h3></div><Icon name="activity" size="20" /></div><div v-if="!activity.length" class="small-empty">协作者提交与版本操作会记录在这里。</div><ol class="activity-list"><li v-for="item in activity.slice(0,10)" :key="item.id || item.activity_sequence || item.created_at"><span class="activity-marker"></span><div><strong>{{ item.message || item.title || item.action || item.type || item.kind }}</strong><p>{{ actor(item) }} <span>{{ timestamp(item.created_at || item.timestamp || item.at) }}</span></p></div></li></ol></section></div><section class="panel tasks-panel"><div class="section-heading"><div><span class="eyebrow">OBJECT WORKBOARD · {{ branchName }}</span><h3>现场开发任务</h3></div><button class="button primary compact" :disabled="!canEdit" @click="openModal('task',{object_id:selectedId,status:'editing'})"><Icon name="plus" size="15" />创建任务</button></div><div class="legend"><span><i class="outline-swatch"></i>选中包围描边</span><span><i class="hazard-swatch"></i>橙黄维护圈与黄黑施工标识</span><span><i class="dot green"></i>交付后结束维护状态</span></div><div v-if="!branchTasks.length" class="small-empty">此分支还没有开发任务，先为一个场景对象安排工作。</div><div class="task-grid"><article v-for="task in branchTasks" :key="task.id" class="task-card"><div class="task-card-top"><span class="badge" :class="statusClass(task.status)"><Icon v-if="task.status==='editing'" name="hammer" size="12" />{{ statusLabel(task.status) }}</span><small>{{ actor(task) }}</small></div><h4>{{ task.title }}</h4><button class="task-object text-button" @click="selectObject(task.object_id);page='editor'"><Icon name="box" size="14" />{{ objects.find(o=>o.id===task.object_id)?.name || task.object_id }}</button><div class="task-version-link"><small>{{ task.origin==='live'?'现场批注':'源码批注' }} · 基础 {{ shortId(task.annotation_revision || task.base_revision) }}</small><button class="text-button" @click="openObjectHistory(task.object_id)">版本差异与交付记录</button></div><div class="task-card-bottom"><small>{{ task.status==='delivered' ? `交付世界 ${shortId(task.delivered_world_id || task.world_id)} / #${task.applied_sequence}` : '等待修改、构建与实际应用' }}</small><select :value="task.status" :disabled="!canEdit || !!busy" :aria-label="`任务 ${task.title} 状态`" @change="updateTask(task,$event.target.value)"><option value="editing">开发中</option><option value="testing">验证中</option><option v-if="task.status==='delivered'" value="delivered" disabled>已验证交付</option><option value="failed">失败</option></select></div></article></div><p class="form-note">批注保留其观察版本。对象构建时自动进入验证，失败会记录原因；只有实际修改应用到世界才完成交付，其他旧世界继续显示等待应用。</p></section></section>

          <section v-if="page==='offline'" class="offline-page"><div class="offline-hero panel"><span class="offline-illustration"><Icon name="download" size="55" /></span><div><p class="eyebrow">CREATE BEYOND THE CONNECTION</p><h2>离线创作，联网继续。</h2><p>下载当前分支的场景工作区，保留原始基础版本。<br>回来时上传修改，服务器会将你的内容与协作者的最新提交进行三方合并。</p><div class="button-row"><button class="button primary" :disabled="!!busy" @click="downloadOffline"><Icon name="download" size="16" />下载离线工作区</button><button class="button secondary" :disabled="!canEdit || !!busy" @click="fileInput?.click()"><Icon name="upload" size="16" />上传离线修改</button></div></div></div><div class="offline-cards"><section class="panel"><span class="step-number">01</span><h3>固定基础版本</h3><p>工作区包含工程、分支、基础提交与完整场景 JSON。客户端下载可从页面右上角的桌面入口取得。</p><code>{{ shortId(baseRevision) }} · {{ branchName }}</code></section><section class="panel"><span class="step-number">02</span><h3>保留本地创作</h3><p>现场检查器中的改动会自动保存在浏览器。离线试玩与在线世界各自保留进度，不会覆盖彼此。</p><span class="badge" :class="dirty ? 'pending' : 'success'">{{ dirty ? '本机有未提交草稿' : '当前内容已同步' }}</span></section><section class="panel"><span class="step-number">03</span><h3>合并、验证、进入</h3><p>有冲突时保留你的修改。合并完成后构建新发行，再进入分支世界验证真实玩法。</p><span class="branch-label"><Icon name="shield" size="15" />可玩版本独立验收</span></section></div><section class="panel local-draft-panel"><div><h3>当前浏览器的工作草稿</h3><p>{{ draftSaved ? `最近保存于 ${timestamp(draftSaved)}` : '编辑场景后将自动保存在此浏览器。' }}</p></div><div class="button-row"><button class="button secondary" :disabled="!content" @click="downloadJSON(localWorkspace(),`${branchName}-local-draft.json`)"><Icon name="download" size="15" />下载当前草稿</button><button v-if="backupDraft" class="button secondary" @click="downloadJSON(backupDraft,`${branchName}-saved-backup.json`)">下载此前草稿备份</button><button class="button secondary" :disabled="!!busy" @click="reloadServerContent"><Icon name="refresh" size="15" />读取服务器最新版</button></div></section></section>
          <footer class="workspace-footer"><span><Icon name="star" size="13" />世界工坊 <span class="footer-slash">/</span> 一个共同生长的世界</span><span>STARFALL EXPEDITION <span class="footer-slash">·</span> GODOT 4.6</span></footer>
        </template>
      </div>
    </main>
    <input ref="modelInput" type="file" accept=".glb,model/gltf-binary" class="visually-hidden" aria-label="上传真实 GLB 模型" @change="uploadModel" /><input ref="behaviorFileInput" type="file" accept=".gd,text/x-gdscript" class="visually-hidden" aria-label="读取本地 GDScript 文件" @change="readBehaviorFile" /><input ref="fileInput" type="file" accept="application/json,.json" class="visually-hidden" aria-label="导入离线工作区文件" @change="importFile" />
  </div>

  <div v-if="modal" class="modal-backdrop" @click.self="modal=null"><section :class="['modal',{'history-modal':modal==='history'}]" role="dialog" aria-modal="true" :aria-label="({project:'创建工程',branch:'新建分支',member:'添加协作者',task:'创建对象任务',world:'创建世界',desktop:'桌面客户端下载',assets:'工程模型资源库',history:'对象版本与批注'})[modal]"><div class="modal-heading"><div><p class="eyebrow">WORLD ATELIER</p><h2>{{ ({project:'创建一个新工程',branch:'从这里开启新分支',member:'邀请协作者加入',task:'为对象安排开发工作',world:'创建独立世界',desktop:'取得桌面客户端',assets:'工程模型资源库',history:'对象版本与批注'})[modal] }}</h2></div><button class="icon-button" aria-label="关闭弹窗" @click="modal=null"><Icon name="close" size="20" /></button></div><ObjectHistory v-if="modal==='history'" :data="objectHistory" :loading="historyLoading" :error="historyError" :current-world-id="liveAnnotation ? telemetry.world_id : selectedWorld?.id" :observed-release-id="liveAnnotation ? telemetry.release_id : null" :can-edit="canEdit && !busy" @refresh="loadObjectHistory" @restore="restoreObjectVersion" @annotate="openTask(page==='world' && liveAnnotation ? 'live' : 'source',historyObjectId)" /><template v-else-if="modal==='assets'"><p class="muted">选择工程内已上传的实际 GLB 资产，关联到当前对象草稿。已有发行内容保持不变。</p><div v-if="!assets.filter(a=>a.mime==='model/gltf-binary').length" class="small-empty">工程中还没有 GLB 模型，先从对象检查器上传。</div><button v-for="asset in assets.filter(a=>a.mime==='model/gltf-binary')" :key="asset.hash" class="asset-library-item" :disabled="!canEdit || !!busy" @click="attachExistingModel(asset)"><Icon name="box" size="25" /><div><strong>{{ asset.name }}</strong><small>{{ (asset.bytes / 1024).toFixed(1) }} KB · {{ asset.hash.slice(0,18) }}…</small></div><Icon name="plus" size="16" /></button><div v-if="error" class="inline-error" role="alert">{{ error }}</div></template><template v-else-if="modal==='desktop'"><p class="muted">已锁定发行 {{ shortId(desktopPackage?.release?.id) }}。下载对应产物后，按工程启动器说明运行客户端；这不会静默安装软件。</p><div v-if="!artifactEntries(desktopPackage).length" class="small-empty">服务已返回发行信息，但没有可直接下载的桌面产物链接。</div><a v-for="artifact in artifactEntries(desktopPackage)" :key="artifact.url || artifact.download_url" class="artifact-link" :href="artifact.url || artifact.download_url" download><Icon name="download" size="22" /><div><strong>{{ artifact.name || artifact.path || artifact.platform || '下载产物' }}</strong><code>{{ artifact.sha256 || artifact.hash || '哈希见发行清单' }}</code></div><Icon name="arrow" size="18" /></a><button class="button secondary full-width" @click="downloadJSON(desktopPackage,`${branchName}-desktop-manifest.json`)">下载固定发行清单</button><p class="form-note">离线编辑包与桌面运行包用途不同。在线游玩通过启动器获取短期加入票据；请勿把票据公开分享。</p></template><form v-else @submit.prevent="submitModal"><label v-if="['project','branch','world'].includes(modal)">{{ modal==='project' ? '工程名称' : modal==='branch' ? '分支名称' : '世界名称' }}<input v-model="form.name" :placeholder="modal==='branch' ? '例如 garden-redesign' : modal==='project' ? '例如 星屿远征' : '例如 园林协作测试世界'" :pattern="modal==='branch' ? '[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,63}' : undefined" :maxlength="modal==='branch' ? 64 : 70" required autofocus /></label><label v-if="modal==='branch'">基于分支<select v-model="form.from_branch"><option v-for="b in branches" :key="branchLabel(b)" :value="branchLabel(b)">{{ branchLabel(b) }}</option></select></label><template v-if="modal==='member'"><label>已注册的协作者名称<input v-model="form.name" placeholder="输入对方在本服务注册的账号名称" required /></label><label>工程角色<select v-model="form.role"><option value="editor">开发者 · 场景编辑、构建、对象任务</option><option value="tester">测试者 · 游玩与验证</option><option value="viewer">观察者 · 查看工程</option></select></label></template><template v-if="modal==='task'"><label>任务标题<input v-model="form.title" placeholder="例如 调整观测站信标光效" required maxlength="160" /></label><div class="annotation-origin"><span class="badge pending">{{ form.origin==='live'?'真实游戏现场批注':'源码工作区批注' }}</span><strong>{{ objects.find(o=>o.id===form.object_id)?.name || form.object_id }}</strong><code>{{ form.object_id }}</code><p>{{ form.branch }} · {{ form.origin==='live'?'观察发行':'基础提交' }} {{ shortId(form.origin==='live'?form.observed_release_id:form.base_revision) }}</p><small>{{ form.origin==='live'?'批注绑定打开时实际看到的世界版本；版本改变会拒绝提交。':'批注基于已提交源码，当前未提交草稿不作为批注版本。' }}</small></div><label>当前状态<select v-model="form.status"><option value="editing">开发中 · 橙黄维护光圈</option><option value="testing">验证中 · 施工状态</option></select></label></template><p v-if="modal==='project'" class="form-note">新工程将创建主干与星屿远征场景；成员、发行版本和世界状态均独立管理。</p><p v-if="modal==='world'" class="form-note">世界使用当前分支的可玩发行，并拥有独立的角色与关卡进度。</p><div v-if="error" class="inline-error" role="alert">{{ error }}</div><div class="modal-actions"><button type="button" class="button secondary" @click="modal=null">取消</button><button class="button primary" :disabled="!!busy">{{ busy || '创建并继续' }}<Icon name="arrow" size="16" /></button></div></form></section></div>
</template>
