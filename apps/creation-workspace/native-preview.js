import {GodotPreview} from './preview-bridge.js';
import {randomUUID} from './client-platform.js';
const preparations=new Map();
const residentEditors=new Map();
const scopeKey=scene=>JSON.stringify([scene.project_id,scene.branch_id]);
const sourceKey=scene=>JSON.stringify([scene.project_id,scene.branch_id,scene.source_revision??scene.scene_revision,scene.source_identity]);
const cancelled=()=>new DOMException('预览目标已切换','AbortError');
function waitFor(promise,signal){
  if(signal?.aborted)return Promise.reject(cancelled());
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{const abort=()=>reject(cancelled());signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
async function prepareJob(request,scene,onProgress){
  const {project_id:p,branch_id:b,resource_id:rid}=scene,revision=scene.source_revision??scene.scene_revision;
  let {job}=await request(`projects/${encodeURIComponent(p)}/branches/${encodeURIComponent(b)}/native-preview-build`,{method:'POST',body:{source_revision:revision,entry_scene_id:rid,request_id:randomUUID()}});
  const id=job?.id,identity=job?.canonical_identity,deadline=Date.now()+15*60*1000;
  if(typeof id!=='string'||!id||typeof identity!=='string'||!identity)throw Error('编辑预览缺少固定构建身份');
  for(;;){
    if(job.purpose!=='native_preview'||job.project_id!==p||job.branch_id!==b||job.source_revision!==revision||job.canonical_identity!==identity||job.id!==id)throw Error('编辑预览与当前固定源版本不匹配');
    onProgress(job);
    if(['completed','partial','failed','interrupted'].includes(job.status))break;
    if(Date.now()>deadline)throw Error('编辑预览仍在构建，请稍后重试');
    await new Promise(resolve=>setTimeout(resolve,800));
    ({job}=await request(`builds/${encodeURIComponent(id)}`));
  }
  if(!['completed','partial'].includes(job.status)||!job.artifacts?.some(a=>a.target==='web'))throw Error(job.error?.message||job.error||'原生预览构建未完成');
  return job;
}
export async function prepareNativePreview(request,scene,{signal,onProgress=()=>{}}={}){
  const revision=scene.source_revision??scene.scene_revision;
  if(scene.document_schema!=='creation-native-1'||![scene.project_id,scene.branch_id,scene.resource_id,revision,scene.source_identity].every(v=>typeof v==='string'&&v))throw Error('原生预览缺少固定源版本');
  const key=JSON.stringify([scene.project_id,scene.branch_id,revision,scene.source_identity]);
  let prepared=preparations.get(key);
  if(!prepared){
    prepared={listeners:new Set(),at:Date.now(),job:null};
    preparations.set(key,prepared);
    prepared.promise=prepareJob(request,scene,job=>{prepared.job=job;for(const listener of prepared.listeners)listener(job);}).catch(error=>{if(preparations.get(key)===prepared)preparations.delete(key);throw error;});
    while(preparations.size>12)preparations.delete(preparations.keys().next().value);
  }
  prepared.listeners.add(onProgress);if(prepared.job)onProgress(prepared.job);
  try{
    const job=await waitFor(prepared.promise,signal);
    residentEditors.set(scopeKey(scene),job);
    while(residentEditors.size>8)residentEditors.delete(residentEditors.keys().next().value);
    // Access is acquired per consumer using its current login, even when an
    // immutable whole-source build is shared by viewport and thumbnails.
    const access=await request(`builds/${encodeURIComponent(job.id)}/access`,{method:'POST',body:{},signal});
    const url=new URL(access.web_url,location.origin);
    if(url.origin!==location.origin||url.pathname!==`/creation-releases/${job.id}/web/index.html`)throw Error('原生预览地址无效');
    return {job,url};
  }catch(error){if(error.name!=='AbortError'&&preparations.get(key)===prepared)preparations.delete(key);throw error;}
  finally{prepared.listeners.delete(onProgress);}
}

/** Existing editor protocol over a fixed native PackedScene bundle. */
export class NativeGodotPreview extends GodotPreview{
  constructor(host,mode,onEvent,request){super(host,mode,onEvent);this.request=request;this.nativeGeneration=0;this.nativeKey=null;this.preparingKey=null;this.buildAbort=null;this.frame.title=mode==='object'?'Godot 原生对象预览':'Godot 原生场景编辑视口';}
  loadRuntime(){return Promise.resolve(null);}
  receive(event){
    const pendingText=this.preparingKey?this.status.textContent:null;
    super.receive(event);
    if(pendingText&&this.preparingKey)this.status.textContent=pendingText;
  }
  async prepareScene(scene,signal,onProgress){
    // A newer source normally needs only the engine-derived PackedScene bytes.
    // Share the resident editor with the object view and thumbnail renderer too.
    const job=this.runtimeManifest?.project_id===scene.project_id&&this.runtimeManifest?.branch_id===scene.branch_id?this.runtimeManifest:residentEditors.get(scopeKey(scene));
    if(job?.native_content_protocol==='wa-native-editor-content-1'){
      const revision=scene.source_revision??scene.scene_revision;
      let content=null,compatible=job.source_revision===revision;
      if(!compatible){
        onProgress('源稿已保存 · 正在更新场景…');
        const result=await this.request(`projects/${encodeURIComponent(scene.project_id)}/branches/${encodeURIComponent(scene.branch_id)}/native-preview-content`,{method:'POST',body:{build_id:job.id,source_revision:revision,resource_id:scene.resource_id},signal,timeoutMs:180000});
        compatible=result.compatible;content=result.content;
      }
      if(signal.aborted)throw cancelled();
      if(compatible){
        if(this.runtimeManifest?.id===job.id)return {content};
        const access=await this.request(`builds/${encodeURIComponent(job.id)}/access`,{method:'POST',body:{},signal});
        const url=new URL(access.web_url,location.origin);
        if(url.origin!==location.origin||url.pathname!==`/creation-releases/${job.id}/web/index.html`)throw Error('原生预览地址无效');
        return {job,url,content};
      }
    }
    return prepareNativePreview(this.request,scene,{signal,onProgress:job=>onProgress('正在准备编辑器资源 · '+(job.stage||'请稍候'))});
  }
  async scene(scene,options={}){
    const key=JSON.stringify([sourceKey(scene),scene.native_scene_path]);
    const generation=++this.nativeGeneration;
    try{
      if(key===this.nativeKey&&this.preparingKey&&this.preparingKey!==key){this.buildAbort?.abort();this.preparingKey=null;this.preparing=null;this.status.textContent='';}
      if(key!==this.nativeKey){
        if(this.preparingKey!==key){
          this.buildAbort?.abort();this.buildAbort=new AbortController();this.preparingKey=key;
          this.host.dataset.previewState='updating';
          this.frame.style.pointerEvents='none';
          this.status.textContent=this.runtimeManifest?'源稿已保存 · 正在更新场景…':'正在准备编辑器…';
          const signal=this.buildAbort.signal;
          this.preparing=waitFor(new Promise(resolve=>setTimeout(resolve,this.runtimeManifest?150:0)),signal).then(()=>this.prepareScene(scene,signal,text=>{if(this.preparingKey===key&&!this.disposed)this.status.textContent=text;}));
          this.runtimeReady=this.preparing;this.preparing.catch(()=>{});
        }
        const build=await this.preparing;
        if(this.disposed||generation!==this.nativeGeneration)throw cancelled();
        this.nativeContent=build.content??null;this.nativeKey=key;this.preparingKey=null;this.preparing=null;
        if(build.job){
        this.reject(Error('预览目标已切换'));this.ready=false;this.key=null;
        this.runtimeManifest=build.job;this.runtimeBuildId=build.job.canonical_identity;this.host.dataset.runtimeBuild=this.runtimeBuildId;
        // A fresh nonce prevents late messages from the previous iframe from
        // matching sequence numbers restarted in another source generation.
        this.nonce=randomUUID();this.loadedSeq=0;
        build.url.searchParams.set('nonce',this.nonce);build.url.searchParams.set('mode',this.mode);this.frame.src=build.url.href;
        }
      }
      if(this.disposed||generation!==this.nativeGeneration)throw cancelled();
      const result=await super.scene({...scene,...(this.nativeContent?{native_preview_content:this.nativeContent}:{})},options);
      if(this.disposed||generation!==this.nativeGeneration)throw cancelled();
      this.host.dataset.previewState='ready';this.host.dataset.displayedSource=scene.source_revision??scene.scene_revision;this.frame.style.pointerEvents='';
      return result;
    }catch(error){if(!this.disposed&&generation===this.nativeGeneration&&error.name!=='AbortError'){this.status.textContent='场景更新失败 · '+error.message;this.host.dataset.previewState='error';this.nativeKey=null;this.preparingKey=null;this.preparing=null;}throw error;}
  }
  async snapshot(scene){
    await this.scene({...structuredClone(scene),selected_id:'',selected_ids:[],editable:false,frame:true});
    for(let n=0;n<2;n++)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('截图渲染超时')),3000);this.frame.contentWindow.requestAnimationFrame(()=>{clearTimeout(timer);this.disposed?reject(cancelled()):resolve();});});
    return (await this.captureFrame()).data_url;
  }
  dispose(){this.buildAbort?.abort();this.nativeGeneration++;super.dispose();}
}
