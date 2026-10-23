const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const route=scope=>`/projects/${encodeURIComponent(scope.projectId)}/branches/${encodeURIComponent(scope.branchId)}`;
const short=value=>String(value??'').slice(0,14);
const labels={property:'属性冲突',transform:'完整变换冲突',text:'文本冲突',binary:'二进制冲突',delete_modify:'删除与修改',add_add:'同时新增',structure:'结构冲突',structure_with_edits:'结构与属性修改',resource_identity:'资源引用身份',native_unparsed:'需要核对原生结构',order:'顺序冲突'};
const choiceLabels={source:'采用来源变化',target:'保留当前目标',base:'采用共同基线',manual:'手工组合片段'};
const display=value=>value===null?'（不存在 / 未显式覆盖）':typeof value==='string'?value:JSON.stringify(value,null,2);

export function collectNativeMergeResolutions(root,preview,previous={}){
  const result={};
  preview.conflicts.forEach((conflict,index)=>{
    const selected=root.querySelector(`[data-native-resolution="${index}"]`)?.value??previous[conflict.key]?.choice??previous[conflict.key];
    if(!selected)return;
    result[conflict.key]=selected==='manual'?{choice:'manual',text:root.querySelector(`[data-native-manual="${index}"]`)?.value??previous[conflict.key]?.text??''}:selected;
  });return result;
}

/** Reuses the canonical workbench modal and API; this module creates no app,
 * service, fixture or second source model. */
export function createNativeMergePanel({request,modal,close,assertCurrent,applyBranch,notify,onDiscuss,root=()=>document.querySelector('#modalBody')}){
  function open(scope,sources){
    if(!sources.length){notify('先创建另一个分支再比较。');return;}
    const active=modal('合并到当前分支',`<p>目标 ${escape(scope.branchId)} · ${escape(short(scope.revision??scope.base))}。可选择多个来源，并明确它们的处理顺序。</p>${sources.map((source,index)=>`<label class="merge-change"><span><input type="checkbox" data-native-source="${index}" ${index===0?'checked':''}> ${escape(source.name??source.branch_id)} · ${escape(source.branch_id)}</span><span>处理顺序 <input type="number" min="1" max="${Math.max(16,sources.length)}" value="${index+1}" data-native-order="${index}" aria-label="${escape(source.branch_id)} 的合并顺序"></span></label>`).join('')}<p>先预览全部变化和局部冲突，再一次性保存到目标分支。来源分支继续保留。</p>`,[{label:'取消',action:close},{label:'比较所选分支',primary:true,action:async()=>{
      if(!active())return;assertCurrent(scope);const selected=sources.map((source,index)=>({source,index,selected:root().querySelector(`[data-native-source="${index}"]`).checked,order:Number(root().querySelector(`[data-native-order="${index}"]`).value)})).filter(item=>item.selected).sort((a,b)=>a.order-b.order||a.index-b.index);
      if(!selected.length||selected.length>16)throw Error('请选择 1–16 条来源分支');
      const preview=await request(route(scope)+'/merge-preview',{method:'POST',body:{source_branch_ids:selected.map(item=>item.source.branch_id),expected_head:scope.revision??scope.base}});if(active())show(scope,preview,{});
    }}],{size:'wide'});
  }
  function show(scope,preview,resolutions){
    const sequence=preview.kind==='revert'?'撤回合并 '+short(preview.revert_revision):(preview.sources??[]).map(source=>source.branch_id+' @ '+short(source.revision)).join(' → ');
    const conflicts=preview.conflicts??[],unresolved=conflicts.filter(conflict=>!conflict.resolved).length;
    const markup=`<p>${escape(sequence)} → ${escape(scope.branchId)}</p><p>${preview.changes.length} 处文件变化 · ${unresolved} 处待解决冲突。目标固定为 ${escape(short(preview.target_revision))}。</p><details><summary>自动保留的变化与处理步骤</summary>${preview.changes.map(change=>`<div>${escape(change.path)} · ${escape(change.method)}${change.conflict?' · 待解决':''}</div>`).join('')||'<p>没有新的文件变化。</p>'}</details>${conflicts.map((conflict,index)=>{
      const decision=resolutions[conflict.key],choice=typeof decision==='string'?decision:decision?.choice??conflict.resolution??'';
      return `<article class="merge-change conflict"><strong>${escape(conflict.path)}${conflict.property?' · '+escape(conflict.property):''}</strong><p>${escape(labels[conflict.kind]??conflict.kind)}${conflict.note?' · '+escape(conflict.note):''}</p><div class="merge-columns"><div><small>来源变化</small><pre>${escape(display(conflict.source))}</pre></div><div><small>当前目标</small><pre>${escape(display(conflict.target))}</pre></div></div><details><summary>共同基线</summary><pre>${escape(display(conflict.base))}</pre></details><label>处理方式<select data-native-resolution="${index}"><option value="">暂未决定</option>${conflict.choices.map(value=>`<option value="${value}" ${choice===value?'selected':''}>${choiceLabels[value]}</option>`).join('')}</select></label>${conflict.choices.includes('manual')?`<label data-native-manual-label="${index}" ${choice==='manual'?'':'hidden'}>组合后的原生片段<textarea data-native-manual="${index}" rows="8" spellcheck="false">${escape(decision?.text??(typeof conflict.target==='string'?conflict.target:''))}</textarea></label>`:''}</article>`;
    }).join('')}<p>来源或目标版本变化时需要重新比较。保存仅推进源稿；构建、公开试玩和正在运行的世界保持各自版本。</p>`;
    const active=modal(preview.kind==='revert'?'核对合并撤回':'核对原生合并',markup,[{label:'取消',action:close},...(onDiscuss?[{label:'与 Agent 讨论这些冲突',action:async()=>{if(!active())return;assertCurrent(scope);const choices=collectNativeMergeResolutions(root(),preview,resolutions);await onDiscuss({scope,preview,resolutions:choices});}}]:[]),{label:'更新冲突预览',action:async()=>{
      if(!active())return;assertCurrent(scope);const choices=collectNativeMergeResolutions(root(),preview,resolutions),review=await request(route(scope)+'/merge-review',{method:'POST',body:{preview_id:preview.id,resolutions:choices}});if(active())show(scope,review,choices);
    }},{label:preview.kind==='revert'?'保存补偿撤回':'保存合并',primary:true,action:async()=>{
      if(!active())return;assertCurrent(scope);const choices=collectNativeMergeResolutions(root(),preview,resolutions);
      if(conflicts.some(conflict=>!choices[conflict.key]))throw Error('请为每处冲突选择处理方式');
      try{
        const result=await request(route(scope)+'/merge',{method:'POST',body:{preview_id:preview.id,resolutions:choices}});if(!active())return;applyBranch(result.branch);close();notify(result.unchanged?'这些变化已经在目标分支中。':'原生合并已保存，后续编辑和来源分支均已保留。');
        if(result.revert)modal('合并已保存',`<p>源版本 ${escape(short(result.revision))} 已保存。</p><p>如需撤回，此操作将创建补偿提交，并保留其他人之后的修改。</p>`,[{label:'完成',primary:true,action:close},{label:'比较撤回这次合并',action:()=>revert({...scope,revision:result.revision,base:result.revision},result.revision)}]);
      }catch(error){if(active()&&error.details?.preview){show(scope,error.details.preview,choices);return;}throw error;}
    }}],{size:'wide'});
    conflicts.forEach((conflict,index)=>{const select=root().querySelector(`[data-native-resolution="${index}"]`),manual=root().querySelector(`[data-native-manual-label="${index}"]`);if(manual)select.addEventListener('change',()=>manual.hidden=select.value!=='manual');});
  }
  async function revert(scope,revision){assertCurrent(scope);const preview=await request(route(scope)+'/merge-revert-preview',{method:'POST',body:{revision}});show(scope,preview,{});}
  return{open,show,revert};
}
