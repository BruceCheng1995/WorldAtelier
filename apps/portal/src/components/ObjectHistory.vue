<script setup>
import {computed,ref,watch} from 'vue'
import {shortId} from '../api'
const props=defineProps({data:Object,loading:Boolean,error:String,currentWorldId:String,observedReleaseId:String,canEdit:Boolean})
const emit=defineEmits(['refresh','restore','annotate'])
const chosen=ref('')
watch(()=>props.data?.object_id,()=>{chosen.value=''})
const version=computed(()=>props.data?.versions.find(v=>v.revision===chosen.value)||props.data?.versions[0])
const currentWorld=computed(()=>props.data?.worlds.find(w=>w.world_id===props.currentWorldId))
const labels={editing:'开发中',testing:'验证中',failed:'验证失败',created:'创建批注',status:'状态变更',build_started:'开始构建',build_passed:'构建通过',build_failed:'构建失败',applied:'世界实际应用',delivered:'实际交付'}
const status=value=>labels[value]||value
const time=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—'
const value=v=>v===null?'∅':typeof v==='object'?JSON.stringify(v):String(v)
const delivery=(task,world)=>task.worlds?.find(w=>w.world_id===world.world_id)?.delivery_status
</script>

<template>
  <div class="object-history" aria-label="对象版本与批注">
    <div v-if="error" class="inline-error" role="alert">{{ error }}<button class="text-button" @click="emit('refresh')">重新读取</button></div>
    <p v-if="loading && !data" class="small-empty">正在读取此分支的对象版本…</p>
    <template v-if="data">
      <div class="history-context"><div><span class="eyebrow">{{ data.branch }} / OBJECT HISTORY</span><h3>{{ data.source.object?.name || data.object_id }}</h3><code>{{ data.object_id }}</code></div><button class="button secondary compact" :disabled="loading" @click="emit('refresh')">{{ loading?'刷新中…':'刷新版本' }}</button></div>
      <div class="history-identities">
        <article><small>源码最新</small><strong>{{ data.source.object?'对象已提交':'对象已删除' }}</strong><code :title="data.source.revision">{{ shortId(data.source.revision) }}</code><code :title="data.source.object_hash">对象 {{ shortId(data.source.object_hash) }}</code></article>
        <article><small>可玩发行</small><strong>{{ data.playable ? (data.playable.object_hash===data.source.object_hash?'此对象与源码一致':'此对象等待新发行') : '尚未构建' }}</strong><code>{{ shortId(data.playable?.release_id) }}</code><code>{{ shortId(data.playable?.revision) }}</code></article>
        <article :class="{'history-applied':currentWorld && currentWorld.object_hash===data.source.object_hash}"><small>当前查看世界</small><strong>{{ currentWorld?.name || '尚未选择世界' }}</strong><code>{{ shortId(currentWorld?.release_id) }}</code><span>{{ currentWorld ? (currentWorld.object_hash===data.source.object_hash?'世界已应用此对象源码':'世界仍使用另一对象版本') : '从现场世界选择运行实例' }}</span><span v-if="currentWorld && observedReleaseId && currentWorld.release_id!==observedReleaseId" class="history-wait">此客户端仍在同步另一发行</span></article>
      </div>
      <div class="history-columns">
        <section class="history-revisions"><div class="history-section-title"><h3>对象修改记录</h3><small>{{ data.versions.length }} 次 · 当前分支沿革</small></div>
          <label>选择对象版本<select v-model="chosen" aria-label="选择对象历史版本"><option value="">最近一次对象修改</option><option v-for="v in data.versions" :key="v.revision" :value="v.revision">{{ time(v.created_at) }} · {{ v.message || shortId(v.revision) }}{{ v.object ? '' : ' · 已删除' }}</option></select></label>
          <template v-if="version"><div class="history-revision-heading"><strong>{{ version.message || '对象修改' }}</strong><p>{{ version.author }} · {{ time(version.created_at) }}</p><code :title="version.revision">{{ version.revision }}</code></div>
            <div class="history-release-tags"><span v-for="r in version.releases" :key="r.release_id" class="badge" :class="r.status==='ready'?'success':'pending'">{{ shortId(r.release_id) }} · {{ r.status==='ready'?'可玩':r.status }}</span><span v-if="!version.releases.length" class="badge pending">此提交未形成发行</span></div>
            <div class="history-diff-wrap"><table class="history-diff"><thead><tr><th>字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody><tr v-for="change in version.changes" :key="change.path"><th>{{ change.path }}</th><td><code>{{ value(change.before) }}</code></td><td><code>{{ value(change.after) }}</code></td></tr></tbody></table></div>
            <button class="button secondary full-width" :disabled="!canEdit" @click="emit('restore',version)">{{ version.object?'将此对象版本放入草稿':'将此删除记录放入草稿' }}</button><p class="form-note">仅修改当前草稿中的此对象。基础提交与其他对象保留；提交、构建并应用后才改变世界。</p>
          </template><p v-else class="small-empty">此对象尚无已提交历史，请先提交新对象。</p>
          <p v-if="data.has_more" class="form-note">当前显示最近 30 次对象修改。</p>
        </section>
        <section class="history-annotations"><div class="history-section-title"><h3>关联批注与交付</h3><button class="text-button" :disabled="!canEdit" @click="emit('annotate')">添加批注</button></div><p v-if="!data.tasks.length" class="small-empty">此分支的对象还没有批注。</p>
          <article v-for="task in data.tasks" :key="task.id" class="history-task"><div class="history-task-heading"><span class="badge" :class="task.status==='delivered'?'success':task.status==='failed'?'danger':'pending'">{{ status(task.status) }}</span><small>第 {{ task.cycle || 1 }} 轮</small></div><h4>{{ task.title }}</h4><p>{{ task.author }} · {{ task.origin==='live'?'来自真实游戏现场':'来自源码工作区' }}</p><dl><dt>批注基础</dt><dd><code :title="task.annotation_revision || task.base_revision">{{ shortId(task.annotation_revision || task.base_revision) }}</code></dd><dt>本轮对象</dt><dd><code :title="task.base_object_hash">{{ shortId(task.base_object_hash) }}</code></dd><template v-if="task.observation"><dt>观察现场</dt><dd>{{ shortId(task.observation.world_id) }} · E{{ task.observation.epoch }} / {{ task.observation.sequence }}</dd></template><template v-if="task.delivered_revision"><dt>{{ task.status==='delivered'?'交付源码':'上轮交付源码' }}</dt><dd><code :title="task.delivered_revision">{{ shortId(task.delivered_revision) }}</code></dd><dt>{{ task.status==='delivered'?'交付发行':'上轮交付发行' }}</dt><dd><code :title="task.delivered_release_id || task.release_id">{{ shortId(task.delivered_release_id || task.release_id) }}</code></dd><dt>{{ task.status==='delivered'?'实际应用':'上轮实际应用' }}</dt><dd>{{ shortId(task.delivered_world_id || task.world_id) }} / #{{ task.applied_sequence }}</dd></template></dl>
            <p v-if="task.error" class="inline-error">{{ task.error }}</p>
            <div v-if="task.status==='delivered'" class="history-world-delivery"><div v-for="w in data.worlds" :key="w.world_id"><span>{{ w.name }}</span><span class="badge" :class="delivery(task,w)==='applied'?'success':'pending'">{{ delivery(task,w)==='applied'?'此世界已应用':'此世界等待应用' }}</span></div></div>
            <details><summary>批注完整修改周期 · {{ task.history?.length || 0 }} 个事件</summary><ol class="history-events"><li v-for="(event,index) in task.history" :key="index"><div><strong>{{ status(event.kind) }}</strong><span>{{ time(event.at) }}</span></div><p>{{ status(event.status) }}<span v-if="event.cycle"> · 第 {{ event.cycle }} 轮</span><span v-if="event.actor"> · {{ event.actor }}</span></p><code v-if="event.revision">{{ shortId(event.revision) }}</code><code v-if="event.release_id"> · {{ shortId(event.release_id) }}</code><p v-if="event.error">{{ event.error }}</p></li></ol></details>
          </article>
        </section>
      </div>
    </template>
  </div>
</template>
