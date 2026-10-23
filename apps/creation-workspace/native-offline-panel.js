const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const shell=value=>"'"+String(value).replaceAll("'","'\\''")+"'";

export function nativeOfflineCommand({server,projectId,branchId,directory='./WorldAtelier-workspace'}){
  return `node world-atelier-native-workspace.mjs checkout --server=${shell(server)} --project=${shell(projectId)} --branch=${shell(branchId)} --dir=${shell(directory)} --login`;
}

export function createNativeOfflinePanel({request,download,modal,close,assertCurrent,notify,onNativeClient,server=()=>location.origin}){
  return {async open(scope){
    assertCurrent(scope);const response=await request('/native-workspaces?project_id='+encodeURIComponent(scope.projectId)),command=nativeOfflineCommand({...scope,server:server()});
    modal('原生离线工作区',`<p>在本机编辑原生源文件，再把差异合回当前分支。文件按哈希增量传输；源稿、独立存档和共享世界进度分别保存。</p><p>下载同步工具后，在终端运行以下命令（需要 Node.js 24 或更新版本），按提示登录：</p><pre>${escape(command)}</pre><p>在 <code>project/</code> 中编辑，先保存 Godot 缓冲区，再运行：</p><pre>node world-atelier-native-workspace.mjs sync --dir='./WorldAtelier-workspace' --login</pre><p><code>pull</code> 读取远端更新并保留本地修改；<code>recover</code> 恢复中断；<code>conflicts --export=新目录</code> 导出三方冲突材料。</p><p><code>prepare-play --dir=工作区 --godot=程序路径</code> 使用已缓存的可信运行支持，断网装配当前落盘内容（含未提交修改和新增场景），生成同一 GameRuntime 启动的独立副本。需要匹配的 Godot 4.6 与本机隔离环境。生成配置、导入缓存和存档不回写源稿。</p><p>登录令牌只在当前命令内存中使用，不写入工程。</p><details><summary>我的已登记工作区（${response.workspaces.length}）</summary>${response.workspaces.map(workspace=>`<p>${escape(workspace.branch_id)} · ${escape(workspace.workspace_id)}<br><small>基线 ${escape(workspace.base_revision)}</small></p>`).join('')||'<p>尚未登记。运行 checkout 时会创建。</p>'}</details>`,[{label:'关闭',action:close},{label:'下载同步工具',primary:true,action:async()=>{
      assertCurrent(scope);const result=await download('/native-workspaces/client.mjs'),blob=result.blob??result,url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='world-atelier-native-workspace.mjs';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);notify('同步工具已下载。');
    }},...(onNativeClient?[{label:'本机接续共享世界',action:()=>{assertCurrent(scope);return onNativeClient(scope);}}]:[])],{size:'wide'});
  }};
}
