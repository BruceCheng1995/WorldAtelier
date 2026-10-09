import { randomUUID } from './client-platform.js';
import { GodotPreview } from './preview-bridge.js';

const terminal = new Set(['completed', 'partial', 'failed', 'interrupted']);
const stopped = () => Object.assign(new Error('本次试玩已停止'), {name:'AbortError'});
const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(stopped());
  const abort = () => { clearTimeout(timer); reject(stopped()); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
  signal?.addEventListener('abort', abort, {once:true});
});

/** The server resolves the complete program/content/toolchain identity once.
 * Both launch surfaces use this API; a browser never guesses which old ZIP fits. */
export async function prepareGamePlay({request, projectId, branchId, revision, entrySceneId, requestId=randomUUID(), signal, onProgress=()=>{},purpose='play'}) {
  const route = `projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/${purpose==='prefab_test'?'prefab-test-build':'play-build'}`;
  if (signal?.aborted) throw stopped();
  let {job} = await request(route, {method:'POST', body:{source_revision:revision, entry_scene_id:entrySceneId, request_id:requestId}, signal});
  const check = value => {
    if(purpose==='prefab_test'&&value?.purpose!=='prefab_test'||purpose!=='prefab_test'&&value?.purpose==='prefab_test')throw Error('构建用途与本次运行不匹配');
    if (!value || value.project_id !== projectId || value.branch_id !== branchId || revision && value.source_revision !== revision || value.entry_scene_id !== entrySceneId || !value.targets?.includes('web') || !/^[a-f0-9]{64}$/.test(value.canonical_identity ?? '')) throw Error('运行工程与本次固定的场景版本不匹配');
  };
  check(job);
  const identity = job.canonical_identity, jobId = job.id, deadline = Date.now() + 15 * 60 * 1000;
  while (true) {
    if (signal?.aborted) throw stopped();
    check(job);
    if (job.id !== jobId || job.canonical_identity !== identity) throw Error('准备期间运行工程身份发生变化');
    onProgress(job);
    if (terminal.has(job.status)) break;
    if (Date.now() > deadline) throw Error('运行工程仍在后台构建，可在出包记录查看进度后重试');
    await wait(1000, signal);
    ({job} = await request(`builds/${encodeURIComponent(jobId)}`, {signal}));
  }
  if (!job.artifacts?.some(artifact => artifact.target === 'web')) throw Error(job.error?.message || job.error || 'Godot Web 构建未完成，请查看出包记录');
  const access = await request(`builds/${encodeURIComponent(jobId)}/access`, {method:'POST', body:{}, signal});
  if (signal?.aborted) throw stopped();
  const url = new URL(access.web_url, location.origin);
  if (!access.web_url || url.origin !== location.origin || url.pathname !== `/creation-releases/${jobId}/web/index.html`) throw Error('运行工程地址与当前后台不一致');
  return {job, url:url.href};
}

/** A real exported game, with an optional inspection bridge.
 * Scene construction is exclusively owned by the game's Godot startup. */
export class GamePlay {
  constructor(host, prepare, onEvent=()=>{}) {
    Object.assign(this, {host, onEvent, seq:0, loadedSeq:0, ready:false, disposed:false, nonce:randomUUID(), worldContext:null});
    this.controller = new AbortController();
    this.frame = document.createElement('iframe');
    this.frame.title = 'Godot 独立游戏'; this.frame.allow = 'fullscreen; autoplay'; this.frame.setAttribute('aria-label', this.frame.title);
    this.status = document.createElement('div'); this.status.className = 'render-status'; this.status.setAttribute('role', 'status');
    this.status.textContent = '正在准备游戏工程…'; host.append(this.frame, this.status);
    this.listener = event => this.receive(event); window.addEventListener('message', this.listener);
    this.runtimeReady = this.load(prepare); this.runtimeReady.catch(()=>{});
  }
  async load(prepare) {
    try {
      const result = await prepare({signal:this.controller.signal, onProgress:job=>{
        if (this.disposed) return;
        this.status.textContent = `${job.stage || '准备游戏工程'} · ${Math.round(Number(job.progress) || 0)}%`;
        this.host.dataset.gameBuild = job.id;
      }});
      if (this.disposed) throw stopped();
      this.job = result.job; this.runtimeBuildId = result.job.canonical_identity;
      this.host.dataset.runtimeBuild = this.runtimeBuildId;
      this.host.dataset.runtimeKind = 'game';
      this.host.dataset.gameBuild = result.job.id;
      const url = new URL(result.url); url.searchParams.set('wa_embedded','1'); url.searchParams.set('launch','editor'); url.searchParams.set('nonce',this.nonce);
      this.frame.src = url.href; this.status.textContent = '正在启动游戏…';
      return result.job;
    } catch (error) {
      if (!this.disposed) { this.status.textContent = error.message; this.diagnostic('runtime_load', error.message); }
      throw error;
    }
  }
  post(payload) { if (!this.disposed) this.frame.contentWindow.postMessage({source:'world-atelier-workspace', nonce:this.nonce, ...payload}, location.origin); }
  receive(event) {
    const message = event.data;
    if (this.disposed || event.origin !== location.origin || event.source !== this.frame.contentWindow || message?.source !== 'world-atelier-game' || message.nonce !== this.nonce) return;
    if (message.canonical_identity && message.canonical_identity !== this.runtimeBuildId) { this.fail('实际运行工程与固定构建身份不匹配'); return; }
    if (message.type === 'ready') {
      if (!message.capabilities?.includes('canonical-game-runtime')) { this.fail('运行工程不支持当前工作台，请重新构建'); return; }
      if (message.source_revision !== this.job?.source_revision || message.runtime_source_hash !== this.job?.runtime_source_hash) { this.fail('游戏启动清单与固定工程不匹配'); return; }
      this.ready = true; if (this.startPacket) this.post(this.startPacket); return;
    }
    if (Number.isSafeInteger(message.scene_generation)) {
      if (message.scene_generation < (this.sceneGeneration ?? 0)) return;
      if (message.scene_generation > (this.sceneGeneration ?? 0)) {
        this.sceneGeneration = message.scene_generation;
        this.lastCameraEvent = null;
      }
    }
    if (message.seq !== undefined && message.seq !== this.commandSeq) return;
    if (message.type === 'error' || message.type === 'runtime_error') { this.fail(message.message || message.error || '游戏未能启动'); return; }
    if (['world_state','loaded','camera','selected'].includes(message.type)) {
      if (message.world_id && (message.world_id !== this.worldContext?.world_id || message.epoch !== this.worldContext?.epoch)) return;
      if (message.scene_revision && message.scene_revision !== this.job?.source_revision || message.source_revision && message.source_revision !== this.job?.source_revision) { this.fail('游戏实际运行版本与固定工程不匹配'); return; }
    }
    if (message.type === 'loaded') {
      if (message.runtime_source_hash && message.runtime_source_hash !== this.job.runtime_source_hash) { this.fail('游戏代码与构建清单不匹配'); return; }
      this.loadedSeq = this.seq; this.status.textContent = '';
      this.host.dataset.loadedDocument = message.document_id || this.sceneContext?.document_id || '';
      this.host.dataset.loadedSeq = String(this.seq);
      this.host.dataset.meshes = String(message.mesh_count ?? '');
      this.host.dataset.sceneGeneration = String(message.scene_generation ?? '');
      this.host.dataset.assetHashes = JSON.stringify(message.assets ?? []);
      this.diagnostic('runtime_load', '固定游戏工程已实际加载', {recovered:true});
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(message); this.pending = null; }
    }
    if (message.type === 'camera') { this.lastCameraEvent = structuredClone({...message,seq:this.seq}); this.host.dataset.camera = JSON.stringify({position:message.position,target:message.target,view:message.view,seq:this.seq}); }
    if (message.type === 'world_state' && (message.error || message.runtime_fault?.error)) this.diagnostic('runtime_fault', message.error || message.runtime_fault.error, {...(message.runtime_fault?.object_id ? {object_id:message.runtime_fault.object_id} : {})});
    this.onEvent({...message,seq:this.seq});
  }
  start(scene, packet) {
    this.bindScene(scene); this.commandSeq = this.seq; this.worldContext = {...packet,document_id:scene.document_id};
    const payload = this.startPacket = {...structuredClone(packet), type:'start', seq:this.seq, document_id:scene.document_id, source_revision:scene.source_revision, selected_id:scene.selected_id ?? ''};
    let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;});
    this.pending = {resolve,reject,promise,timer:setTimeout(()=>this.fail('游戏加载超时，请查看出包记录后重试'),90000)};
    if (this.ready) this.post(payload);
    return promise;
  }
  bindScene(scene, sceneGeneration=this.sceneGeneration) {
    this.boundSceneGeneration = sceneGeneration;
    this.seq++;
    this.sceneContext = {document_id:scene.document_id,source_revision:scene.source_revision ?? scene.scene_revision,hierarchy:!!scene.hierarchy_pack,selected_id:scene.selected_id ?? '',preview_object_id:null};
    if (this.loadedSeq) this.loadedSeq = this.seq;
  }
  select(id) { if (this.sceneContext) { this.sceneContext.selected_id = id ?? ''; this.post({type:'select',seq:this.commandSeq,scene_generation:this.sceneGeneration,document_id:this.sceneContext.document_id,id:id ?? ''}); } }
  camera(action) { if (this.ready && this.sceneContext) this.post({type:'camera',seq:this.commandSeq,scene_generation:this.sceneGeneration,document_id:this.sceneContext.document_id,selected_id:this.sceneContext.selected_id,action:structuredClone(action)}); }
  world(packet) {
    if (!this.worldContext) return;
    const identity = {world_id:this.worldContext.world_id,epoch:this.worldContext.epoch,scene_revision:this.worldContext.scene_revision ?? this.job.source_revision};
    if (Object.entries(identity).some(([field,value])=>packet[field] !== undefined && packet[field] !== value)) return;
    this.post({...identity,...structuredClone(packet),type:'world',seq:this.commandSeq,scene_generation:this.sceneGeneration});
  }
  editor() {} presence() {} development() {} transient() { return false; }
  captureFrame() { return GodotPreview.prototype.captureFrame.call(this); }
  diagnostic(...args) { return GodotPreview.prototype.diagnostic.apply(this,args); }
  fail(message) {
    if (this.disposed) return;
    this.status.textContent = message; this.diagnostic('runtime_load',message);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(Error(message)); this.pending = null; }
    this.onEvent({type:'runtime_error',message});
  }
  dispose() {
    this.disposed = true; this.controller.abort();
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(stopped()); this.pending = null; }
    this.worldContext = null; window.removeEventListener('message',this.listener);
    this.frame.src = 'about:blank'; this.frame.remove(); this.status.remove();
  }
}
