import {randomUUID} from './client-platform.js';
const el=(tag,text)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;};

/** One contextual action from the current conversation; no engine-operation UI. */
export function openSessionContinuation({session,branches,request,getContext,onCreated,onError=()=>{}}){
  if(!session||session.owner_user_id!==getContext().user_id)throw Error('只能延续自己的会话');
  const targets=branches.filter(branch=>branch.branch_id!==session.branch_id);if(!targets.length)throw Error('先创建另一个分支，再带着上下文继续');
  const context=getContext(),same=()=>getContext().user_id===context.user_id&&getContext().project_id===context.project_id;
  const dialog=el('dialog');dialog.className='session-continuation-dialog';dialog.dataset.sessionContinuation='';const form=el('form');form.method='dialog';
  form.append(el('h2','到另一个分支继续'),el('small','创建新的私有会话，携带已发送的讨论和固定证据。原会话、未发送草稿与进行中的任务继续留在原分支。'));
  const targetLabel=el('label','目标分支'),target=el('select');target.dataset.continuationBranch='';for(const branch of targets){const option=el('option',`${branch.name??branch.branch_id} · ${branch.head.slice(0,12)}`);option.value=branch.branch_id;target.append(option);}targetLabel.append(target);
  const cutoffLabel=el('label','带入到哪条消息'),cutoff=el('select');cutoff.dataset.continuationCutoff='';
  const messages=(session.messages??[]).filter(message=>['user','assistant'].includes(message.role));
  for(const message of [...messages].reverse()){const option=el('option',`#${message.sequence} ${message.role==='user'?'我':'Agent'} · ${String(message.content??'').replace(/\s+/g,' ').slice(0,70)}`);option.value=message.id;cutoff.append(option);}
  if(!messages.length){const option=el('option','空会话，只带入新的继续目标');option.value='';cutoff.append(option);}cutoffLabel.append(cutoff);
  const objectiveLabel=el('label','在这个分支继续做什么'),objective=el('textarea');objective.rows=4;objective.maxLength=12000;objective.required=true;objective.placeholder='例如：参考刚才的试玩问题，在这个分支继续修好门的交互';objective.dataset.continuationObjective='';objectiveLabel.append(objective);
  const evidenceLabel=el('label'),evidence=el('input');evidence.type='checkbox';evidence.checked=true;evidence.dataset.continuationEvidence='';evidenceLabel.append(evidence,el('span','带入截止消息以前的试玩观察与关键画面'));
  const error=el('p');error.className='session-continuation-error';error.setAttribute('role','alert');const actions=el('div');actions.className='session-continuation-actions';
  const cancel=el('button','取消');cancel.type='button';cancel.onclick=()=>dialog.close();const submit=el('button','创建并继续');submit.type='submit';submit.dataset.continuationSubmit='';actions.append(cancel,submit);form.append(targetLabel,cutoffLabel,evidenceLabel,objectiveLabel,error,actions);dialog.append(form);document.body.append(dialog);
  let requestId=randomUUID(),fingerprint=null,busy=false;
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!objective.value.trim())return;
    const branch=targets.find(branch=>branch.branch_id===target.value);const input={target_branch_id:branch.branch_id,expected_target_head:branch.head,cutoff_message_id:cutoff.value||null,objective:objective.value.trim(),...(!evidence.checked?{observation_ids:[]}: {})};
    const next=JSON.stringify(input);if(fingerprint&&fingerprint!==next)requestId=randomUUID();fingerprint=next;busy=true;submit.disabled=true;submit.textContent='正在固定上下文…';error.textContent='';
    try{
      if(!same())throw Error('账号或项目已切换，未延续旧会话');
      const result=await request(`sessions/${encodeURIComponent(session.id)}/continue-context`,{method:'POST',body:{...input,request_id:requestId}});
      if(same()){dialog.close();await onCreated(result);}
    }catch(reason){error.textContent=reason.message;onError(reason);}
    finally{busy=false;submit.disabled=false;submit.textContent='创建并继续';}
  };
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();objective.focus();return dialog;
}
