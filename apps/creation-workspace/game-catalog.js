import { randomUUID } from './client-platform.js';
import { autoCoverEnabled } from './auto-game-cover.js';
const empty=()=>({version:0,cover_id:null,images:[],auto_update:true});
const roleNames={owner:'拥有者',editor:'可编辑',viewer:'只读',player:'只读试玩',tester:'测试者'};
const cover=p=>p?.images?.find(i=>i.id===p.cover_id);
const date=t=>t?new Date(t).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'暂无修改';
const updated=p=>Math.max(p.created_at,...p.branches.map(b=>b.updated_at??b.created_at));
const preferenceKey=id=>`world-atelier:game-catalog:${id}`;
export function catalogPreference(userId){
  try{const value=JSON.parse(localStorage.getItem(preferenceKey(userId))??'null');return {selected:typeof value?.selected==='string'?value.selected:null,visits:Array.isArray(value?.visits)?value.visits.filter(v=>v&&typeof v.project_id==='string'&&typeof v.branch_id==='string'&&Number.isFinite(v.at)).slice(0,12):[]};}catch{return {selected:null,visits:[]};}
}

export function catalogRoute(hash=location.hash){
  if(!hash||hash==='#'||hash==='#/games'||hash==='#/games/')return {kind:'games'};
  try{const parts=hash.slice(1).split('/');if(parts[0]!==''||parts[1]!=='games'||!parts[2])return {kind:'invalid'};const projectId=decodeURIComponent(parts[2]);if(parts.length===3)return {kind:'game',projectId};if(parts.length===5&&parts[3]==='branches'&&parts[4])return {kind:'branch',projectId,branchId:decodeURIComponent(parts[4])};}catch{}
  return {kind:'invalid'};
}
export function catalogHref({projectId,branchId}={}){return '#/games'+(projectId?'/'+encodeURIComponent(projectId):'')+(projectId&&branchId?'/branches/'+encodeURIComponent(branchId):'');}

export function suggestBranchId(name,existing=[],seed=randomUUID()){
  const slug=String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9_.-]+/g,'-').replace(/^[^a-z0-9]+|[-.]+$/g,'').slice(0,80);
  const base=slug||`branch-${String(seed).replace(/[^a-z0-9]/gi,'').slice(0,8)||'draft'}`,taken=new Set(existing);
  let value=base,index=2;while(taken.has(value))value=`${base}-${index++}`;
  return value;
}

/** Navigation preferences are local to a user; all displayed games and branches come from the authorized catalog. */
export class GameCatalog {
  constructor({api,esc,icon,getState,select,enter,navigate,createBranch,refresh,modal,closeModal,toast,report}){
    Object.assign(this,{api,esc,icon,getState,select,enter,navigate,createBranch,refresh,modal,closeModal,toast,report});
    this.urls=new Map();this.owner=null;this.generation=0;this.opening=false;
    this.$=s=>document.querySelector(s);
    this.$('#gameSearch').oninput=()=>this.renderGames();
    this.$('#gameSort').onchange=()=>this.renderGames();
    this.$('#gameStatus').onchange=()=>this.render();
    this.$('#branchSearch').oninput=()=>this.renderBranches();
    this.$('#refreshGames').onclick=async e=>{const button=e.currentTarget;button.disabled=true;try{await refresh();}catch(error){report(error);}finally{button.disabled=false;}};
    this.$('#editGameMedia').onclick=()=>this.manage(this.getState().project);
    this.$('#renameProject').onclick=()=>this.editProject(this.getState().project,'rename');
    this.$('#archiveProject').onclick=()=>this.editProject(this.getState().project,'archive');
  }
  reset(){this.generation++;for(const value of this.urls.values())value.then(url=>URL.revokeObjectURL(url)).catch(()=>{});this.urls.clear();this.owner=null;this.preferences={selected:null,visits:[]};this.$('#gameSearch').value='';this.$('#branchSearch').value='';this.$('#gameStatus').value='active';}
  savePreference(){try{if(this.owner)localStorage.setItem(preferenceKey(this.owner),JSON.stringify(this.preferences));}catch{/* Storage restrictions must not block entering a game. */}}
  recordVisit(projectId,branchId){
    const {user,projects}=this.getState();if(!user||!projects.find(p=>p.id===projectId)?.branches.some(b=>b.branch_id===branchId))return;
    if(this.owner!==user.id){this.reset();this.owner=user.id;this.preferences=catalogPreference(user.id);}
    this.preferences={selected:projectId,visits:[{project_id:projectId,branch_id:branchId,at:Date.now()},...this.preferences.visits.filter(v=>v.project_id!==projectId||v.branch_id!==branchId)].slice(0,12)};this.savePreference();
  }
  visits(){const {projects}=this.getState();return this.preferences.visits.flatMap(v=>{const p=projects.find(p=>p.id===v.project_id),b=p?.branches.find(b=>b.branch_id===v.branch_id);return b?[{...v,project:p,branch:b}]:[];});}
  choose(id,{focus=false}={}){
    if(this.opening||!this.getState().projects.some(p=>p.id===id))return;
    this.$('#branchSearch').value='';return this.navigate({projectId:id},{focus});
  }
  async open(projectId,branchId){
    if(this.opening||!this.getState().projects.find(p=>p.id===projectId)?.branches.some(b=>b.branch_id===branchId))return;
    this.opening=true;
    try{await this.navigate({projectId,branchId});}catch(error){this.report(error);}finally{this.opening=false;}
  }
  image(item,alt=''){return item?`<img data-game-image="${this.esc(item.url)}" alt="${this.esc(alt)}" loading="lazy">`:'';}
  placeholder(name){return `<div class="game-art-placeholder"><span aria-hidden="true">${this.esc(name.slice(0,1))}</span><small>进入创作，生成第一张游戏画面</small></div>`;}
  async hydrate(root){
    const generation=this.generation;
    await Promise.all([...root.querySelectorAll('[data-game-image]')].map(async img=>{
      const path=img.dataset.gameImage;if(!path.startsWith('/creation-api/projects/'))return;
      if(!this.urls.has(path))this.urls.set(path,this.api.download(path.slice('/creation-api/'.length)).then(({blob})=>URL.createObjectURL(blob)));
      try{const url=await this.urls.get(path);if(img.isConnected&&generation===this.generation){img.onload=()=>img.classList.add('loaded');img.src=url;if(img.complete)img.classList.add('loaded');}}
      catch{this.urls.delete(path);if(img.isConnected){img.alt='截图暂时无法读取';img.classList.add('image-unavailable');}}
    }));
  }
  render(){
    const {user,project,catalogPage='games',routeError}=this.getState();if(this.owner!==user?.id){this.reset();this.owner=user?.id;this.preferences=catalogPreference(this.owner);}
    if(project){this.preferences.selected=project.id;this.savePreference();}
    const management=this.getState().projectManagementAvailable!==false;this.$('#gameStatus').hidden=!management;this.$('#gameStatus').disabled=!management;this.$('#gameStatus').title='筛选进行中或已归档工程';if(!management)this.$('#gameStatus').value='active';
    this.renderGames();this.renderRecent();
    const isIndex=catalogPage==='games';this.$('#landing').dataset.page=catalogPage;
    this.$('#catalogIndexHeading').hidden=!isIndex;this.$('#gameLibrary').hidden=!isIndex;
    this.$('#gameDetail').hidden=catalogPage!=='game'||!project;
    this.$('#catalogWelcome').hidden=!isIndex||this.getState().projects.length>0||this.$('#gameStatus').value==='archived';
    this.$('#catalogRouteError').hidden=catalogPage!=='error';this.$('#catalogRouteErrorText').textContent=routeError??'';
    if(catalogPage!=='game'||!project)return;
    this.$('#catalogGameCrumb').textContent=project.name;
    const writable=['owner','editor'].includes(project.role),art=cover(project.presentation),recent=this.visits().find(v=>v.project_id===project.id),entry=recent?.branch??project.branches.find(b=>b.branch_id==='main')??project.branches[0];
    this.$('#selectedGameTitle').textContent=project.name;
    this.$('#projectLabel').textContent=`${project.default_project?'默认工程 · ':''}${project.branches.length} 个分支 · ${project.members.length?`${project.members.length} 位成员 · `:''}${roleNames[project.role]??project.role}`;
    this.$('#editGameMedia').hidden=!writable;this.$('#catalogCollaboration').hidden=false;
    this.$('#renameProject').hidden=project.role!=='owner'||!management;this.$('#archiveProject').hidden=project.role!=='owner'||!management;for(const id of ['renameProject','archiveProject'])this.$('#'+id).disabled=!management;
    this.$('#gameDetail [data-action="newBranch"]').hidden=!writable;
    this.$('#gameHero').innerHTML=art?this.image(art,project.name+'头图'):this.placeholder(project.name);
    this.$('#gameCoverMode').textContent=autoCoverEnabled(project.presentation)?'自动封面 · 跟随主干画面':'手动头图';
    this.$('#gameModified').textContent=`最近编辑于 ${date(updated(project))}`;
    this.$('#gameEntryHint').textContent=entry?(recent?`上次打开 ${date(recent.at)} · ${entry.branch_id}`:project.default_project?'打开现成场景和预制件，点击 Play 即可试玩':`${writable?'从':'浏览'} ${entry.branch_id}${writable?' 开始创作':''}`):'先创建一个创作分支';
    const primary=this.$('#gamePrimaryEntry');primary.hidden=!entry;primary.innerHTML=`${!writable?'只读浏览与试玩':recent?'继续创作':'进入创作'} ${this.icon('arrow')}`;primary.setAttribute('aria-label',`${!writable?'只读浏览':recent?'继续':'进入'} ${project.name} 的 ${entry?.branch_id??''} 分支${writable?'创作':''}`);primary.onclick=()=>this.open(project.id,entry.branch_id);
    const images=project.presentation?.images??[];
    this.$('#screenshotCount').textContent=images.length?images.length:'';
    this.$('#galleryHint').textContent=autoCoverEnabled(project.presentation)?'主干画面自动更新 · 手动上传后停止自动更新':'已手动指定 · 可在管理中恢复自动更新';
    this.$('#gameScreenshots').innerHTML=images.length?images.map((item,index)=>`<button type="button" class="screenshot-thumb" data-gallery="${index}" aria-label="查看截图 ${index+1}：${this.esc(item.name)}">${this.image(item,item.name)}<span>${item.id===project.presentation.cover_id?'头图':item.source==='automatic'?'自动截图':'游戏截图'}</span></button>`).join(''):`<div class="gallery-empty"><div><strong>让游戏画面记录创作进展</strong><p>进入主干创作后自动采集画面；修改后等待 10 秒，之后每 60 秒更新。</p></div>${writable?'<button type="button" class="button small subtle" id="addFirstImage">上传图片</button>':''}</div>`;
    this.$('#addFirstImage')?.addEventListener('click',()=>this.manage(project));
    this.$('#gameScreenshots').querySelectorAll('[data-gallery]').forEach(button=>button.onclick=()=>this.gallery(images,Number(button.dataset.gallery)));
    this.renderBranches();this.hydrate(this.$('#gameDetail'));
  }
  renderRecent(){
    const list=this.visits().slice(0,3),root=this.$('#recentGames');root.hidden=!list.length||this.$('#gameStatus').value==='archived';
    root.innerHTML=`<h3>最近打开 <small>本机</small></h3>${list.map(v=>`<button type="button" data-recent-game="${this.esc(v.project_id)}" data-recent-branch="${this.esc(v.branch_id)}" aria-label="继续 ${this.esc(v.project.name)} 的 ${this.esc(v.branch_id)} 分支">${this.icon('branch')}<span><strong>${this.esc(v.project.name)}</strong><small>${this.esc(v.branch_id)}</small></span>${this.icon('arrow')}</button>`).join('')}`;
    root.querySelectorAll('[data-recent-game]').forEach(b=>b.onclick=()=>this.open(b.dataset.recentGame,b.dataset.recentBranch));
  }
  renderGames(){
    if(this.$('#gameStatus').value==='archived'){this.renderArchived();return;}
    const {projects,project}=this.getState(),q=this.$('#gameSearch').value.trim().toLocaleLowerCase();
    const list=projects.filter(p=>p.name.toLocaleLowerCase().includes(q)).sort(this.$('#gameSort').value==='name'?(a,b)=>a.name.localeCompare(b.name,'zh-CN'):(a,b)=>updated(b)-updated(a));
    this.$('#gameCount').textContent=q?`${list.length} / ${projects.length}`:projects.length;
    this.$('#gameCards').innerHTML=list.map(p=>`<article class="game-card"><a class="game-select" href="${catalogHref({projectId:p.id})}" data-game="${this.esc(p.id)}" aria-label="查看游戏 ${this.esc(p.name)} 的分支"><div class="game-cover">${cover(p.presentation)?this.image(cover(p.presentation),p.name+'封面'):this.placeholder(p.name)}<span class="game-role">${p.default_project?'默认工程 · ':''}${roleNames[p.role]??this.esc(p.role)}</span></div><div class="game-card-body"><h3>${this.esc(p.name)}</h3><div><span>${p.branches.length} 个分支</span><span>${p.default_project&&!p.members.length?'所有注册用户可查看':`${p.members.length} 位成员`}</span></div><small>${date(updated(p))} 编辑</small></div></a><div class="game-branch-links">${p.branches.slice(0,3).map(b=>`<button type="button" data-quick-game="${this.esc(p.id)}" data-quick-branch="${this.esc(b.branch_id)}" title="进入 ${this.esc(p.name)} / ${this.esc(b.name)}">${this.icon('branch')}${this.esc(b.branch_id)}</button>`).join('')}${p.branches.length>3?`<button type="button" data-game="${this.esc(p.id)}">+${p.branches.length-3} 个</button>`:''}</div></article>`).join('')||`<div class="empty-state">${q?'没有找到这个游戏。<button type="button" class="inline-link" id="clearGameSearch">清空搜索</button>':'游戏会显示在这里。创建一个游戏，或通过邀请加入。'}</div>`;
    this.$('#clearGameSearch')?.addEventListener('click',()=>{this.$('#gameSearch').value='';this.renderGames();this.$('#gameSearch').focus();});
    this.$('#gameCards').querySelectorAll('[data-game]').forEach(button=>button.onclick=e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();this.choose(button.dataset.game,{focus:true});});
    this.$('#gameCards').querySelectorAll('[data-quick-game]').forEach(button=>button.onclick=()=>this.open(button.dataset.quickGame,button.dataset.quickBranch));
    for(const p of list.filter(p=>p.role==='owner'&&this.getState().projectManagementAvailable!==false)){
      const card=[...this.$('#gameCards').querySelectorAll('[data-game]')].find(e=>e.dataset.game===p.id)?.closest('.game-card');
      card?.insertAdjacentHTML('beforeend',`<div class="game-card-actions"><button type="button" data-project-rename="${this.esc(p.id)}">重命名</button><button type="button" data-project-archive="${this.esc(p.id)}">归档</button></div>`);
    }
    this.bindProjectActions(list);
    this.hydrate(this.$('#gameCards'));
  }
  bindProjectActions(list){
    for(const [attribute,action]of [['data-project-rename','rename'],['data-project-archive','archive'],['data-project-restore','restore']])this.$('#gameCards').querySelectorAll(`[${attribute}]`).forEach(button=>{button.disabled=this.getState().projectManagementAvailable===false;button.title=button.disabled?'工程管理等待服务更新':'';button.onclick=()=>this.editProject(list.find(p=>p.id===button.getAttribute(attribute)),action);});
  }
  renderArchived(){
    const all=this.getState().archivedProjects??[],q=this.$('#gameSearch').value.trim().toLocaleLowerCase();
    const list=all.filter(p=>p.name.toLocaleLowerCase().includes(q)).sort(this.$('#gameSort').value==='name'?(a,b)=>a.name.localeCompare(b.name,'zh-CN'):(a,b)=>b.archived_at-a.archived_at);
    this.$('#gameCount').textContent=q?`${list.length} / ${all.length}`:all.length;
    this.$('#gameCards').innerHTML=list.map(p=>`<article class="game-card archived-game-card"><div class="game-card-body"><span class="recent-badge">已归档</span><h3>${this.esc(p.name)}</h3><p>${p.branch_count} 个分支 · ${date(p.archived_at)} 归档</p><small>源码、分支与会话已保留</small></div><div class="game-card-actions"><button type="button" data-project-rename="${this.esc(p.id)}">重命名</button><button type="button" data-project-restore="${this.esc(p.id)}">恢复工程</button></div></article>`).join('')||`<div class="empty-state">${q?'没有匹配的已归档工程。':'没有已归档工程。归档的工程可在这里恢复。'}</div>`;
    this.bindProjectActions(list);
  }
  editProject(project,action){
    if(!project||project.role!=='owner'||this.getState().projectManagementAvailable===false)return;
    const owner=this.owner,routeHash=location.hash,editorId=randomUUID(),renaming=action==='rename',restoring=action==='restore',title=renaming?'重命名工程':restoring?'恢复工程':'归档工程';
    let version=project.permission_version??1,busy=false;
    const active=()=>owner===this.owner&&this.$('#modal').open&&this.$('#projectEdit')?.dataset.editor===editorId;
    this.modal(title,`<div id="projectEdit" data-editor="${editorId}">${renaming?`<label class="project-name-field">工程名称<input id="projectName" value="${this.esc(project.name)}" maxlength="160" autocomplete="off"></label>`:`<p><strong>${this.esc(project.name)}</strong></p><p>${restoring?'恢复后，原有成员可以继续编辑和试玩。':'归档后将从游戏库移入「已归档」，关闭编辑与试玩访问，正在执行的 Agent 任务会停止。源码、分支和会话均保留，拥有者可随时恢复。'}</p>`}</div>`,[{label:'取消',action:this.closeModal},{label:renaming?'保存名称':title,primary:true,action:async()=>{
      if(busy||!active())return;busy=true;
      const patch=renaming?{name:this.$('#projectName').value.trim()}:{archived:!restoring};
      try{
        if(renaming&&!patch.name)throw Error('请输入工程名称');
        await this.api.api(`projects/${encodeURIComponent(project.id)}`,{method:'PATCH',body:{expected_version:version,...patch}});
        if(owner!==this.owner)return;
        // Close only this editor: an old response must not close a new modal.
        if(active())this.closeModal();await this.refresh();
        if(owner!==this.owner)return;
        if(!renaming&&!restoring&&location.hash===routeHash&&(!this.$('#modal').open||active())){this.$('#gameStatus').value='archived';await this.navigate({});}
        else this.render();
        this.toast(renaming?'工程名称已保存':restoring?'工程已恢复':'工程已归档，可在「已归档」中恢复');
      }catch(error){
        if(owner!==this.owner)return;
        try{await this.refresh();const state=this.getState(),latest=[...state.projects,...(state.archivedProjects??[])].find(p=>p.id===project.id);if(latest)version=latest.permission_version??1;}catch{}
        if(active())this.$('#modalError').textContent=error.message;
      }finally{busy=false;}
    }}]);
    if(renaming){this.$('#projectName').focus();this.$('#projectName').select();this.$('#projectName').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();this.$('#modalFooter .primary').click();}};}
  }
  renderBranches(){
    const {project}=this.getState();if(!project)return;
    const q=this.$('#branchSearch').value.trim().toLocaleLowerCase(),list=project.branches.filter(b=>`${b.name} ${b.branch_id}`.toLocaleLowerCase().includes(q)),writable=['owner','editor'].includes(project.role),recent=this.visits().find(v=>v.project_id===project.id);
    this.$('#branchCount').textContent=q?`${list.length} / ${project.branches.length}`:project.branches.length;
    this.$('#branchCards').innerHTML=list.map(b=>{
      const own=cover(b.presentation),art=own??cover(project.presentation);
      const branchName=b.branch_id==='main'?'主干':b.name,entryLabel=writable?'进入创作':'只读浏览与试玩';
      return `<article class="branch-card"><div class="branch-preview">${art?this.image(art,b.name+'封面'):this.placeholder(b.name)}${writable?`<button type="button" class="branch-cover-edit" data-branch-media="${this.esc(b.branch_id)}" aria-label="管理 ${this.esc(b.branch_id)} 分支封面" title="管理分支封面">${this.icon('camera')}</button>`:''}</div><div class="branch-body"><div class="branch-title">${this.icon('branch')}<h3>${this.esc(branchName)}</h3><code class="branch-code">${this.esc(b.branch_id)}</code>${recent?.branch_id===b.branch_id?'<span class="recent-badge">最近打开</span>':''}</div><p class="branch-origin-label">${b.parent_branch?'基于 '+this.esc(b.parent_branch)+' 创建':'默认创作分支'}<span>·</span>${date(b.updated_at??b.created_at)} 更新</p><div class="branch-metadata"><span title="源版本 ${this.esc(b.head)}">源版本 <code>${this.esc(b.head.slice(0,12))}</code></span><span>${art&&!own?'沿用工程封面':autoCoverEnabled(b.presentation)?'自动更新封面':'手动封面'}</span></div></div><div class="branch-bottom"><div class="branch-secondary">${b.presentation?.images.length?`<button type="button" class="inline-link" data-branch-gallery="${this.esc(b.branch_id)}">${b.presentation.images.length} 张截图</button>`:''}${writable?`<button type="button" class="inline-link" data-fork="${this.esc(b.branch_id)}">从此创建分支</button>`:''}</div><button type="button" class="button primary" data-enter="${this.esc(b.branch_id)}">${entryLabel} ${this.icon('arrow')}</button></div></article>`;
    }).join('')||(q?'<div class="empty-state">没有匹配的分支。<button type="button" class="inline-link" id="clearBranchSearch">查看全部分支</button></div>':'<div class="empty-state">还没有创作分支。</div>');
    if(!q&&project.branches.length===1&&writable)this.$('#branchCards').insertAdjacentHTML('beforeend',`<aside class="branch-start"><div class="branch-start-icon">${this.icon('branch')}</div><div><h3>在分支中尝试新想法</h3><p>从现有内容开始，独立调整玩法；准备好后再比较与合并。</p><button type="button" class="button small subtle" data-fork="${this.esc(project.branches[0].branch_id)}">创建分支 ${this.icon('plus')}</button></div></aside>`);
    this.$('#clearBranchSearch')?.addEventListener('click',()=>{this.$('#branchSearch').value='';this.renderBranches();this.$('#branchSearch').focus();});
    this.$('#branchCards').querySelectorAll('[data-enter]').forEach(button=>button.onclick=()=>this.open(project.id,button.dataset.enter));
    this.$('#branchCards').querySelectorAll('[data-fork]').forEach(button=>button.onclick=()=>this.createBranch(button.dataset.fork));
    this.$('#branchCards').querySelectorAll('[data-branch-media]').forEach(button=>button.onclick=()=>this.manage(project,project.branches.find(b=>b.branch_id===button.dataset.branchMedia)));
    this.$('#branchCards').querySelectorAll('[data-branch-gallery]').forEach(button=>button.onclick=()=>this.gallery(project.branches.find(b=>b.branch_id===button.dataset.branchGallery).presentation.images,0));
    this.hydrate(this.$('#branchCards'));
  }
  gallery(images,index){
    const item=images[index];this.modal(item.name,`<div class="screenshot-viewer">${this.image(item,item.name)}</div><p>${index+1} / ${images.length}</p>`,[
      ...(images.length>1?[{label:'上一张',action:()=>this.gallery(images,(index+images.length-1)%images.length)},{label:'下一张',action:()=>this.gallery(images,(index+1)%images.length)}]:[]),{label:'关闭',action:this.closeModal}]);this.hydrate(this.$('#modalBody'));
  }
  manage(project,branch=null){
    const target=branch??project,owner=this.owner,route=`projects/${encodeURIComponent(project.id)}${branch?'/branches/'+encodeURIComponent(branch.branch_id):''}/presentation`;
    let presentation=target.presentation??empty(),busy=false;
    const editorId=randomUUID(),active=()=>this.$('#modal').open&&this.$('#gameMediaUpload')?.dataset.editor===editorId;
    const render=()=>{
      this.modal(branch?`${branch.branch_id} · 分支封面`:`${project.name} · 头图与截图`,`<div class="media-auto-setting"><strong>${autoCoverEnabled(presentation)?'自动更新已开启':'手动封面 · 自动更新已关闭'}</strong><p>${branch?'采集当前分支游戏画面':'跟随主干的当前游戏画面'}。修改后等待 10 秒，之后每 60 秒更新。手动上传、指定或移除封面会关闭自动更新。</p><button type="button" class="button small subtle" id="toggleAutoCover">${autoCoverEnabled(presentation)?'暂停自动更新':'恢复自动更新'}</button>${presentation.last_auto_at?`<small>上次自动更新 ${date(presentation.last_auto_at)}</small>`:''}</div><p>上传头图或游戏截图，点击「设为头图」用于展示。${branch?'未设置头图时沿用游戏头图。':''}</p><label class="media-upload">＋ 上传图片<input type="file" id="gameMediaUpload" data-editor="${editorId}" accept="image/png,image/jpeg,image/webp" aria-label="上传游戏头图或截图"></label><small class="media-hint">PNG / JPEG / WebP · 每张不超过 5 MB · 建议横图 16:9 · ${presentation.images.length} / 8 张</small><div class="media-editor-grid">${presentation.images.map(item=>`<article>${this.image(item,item.name)}<div title="${this.esc(item.name)}">${this.esc(item.name)}</div><div class="row"><button type="button" class="button small subtle" data-cover="${item.id}" ${item.id===presentation.cover_id?'disabled':''}>${item.id===presentation.cover_id?'当前头图':'设为头图'}</button><button type="button" class="button small subtle" data-remove="${item.id}">移除</button></div></article>`).join('')||'<p class="muted">还没有图片，先上传一张吧。</p>'}</div><p id="mediaProgress" role="status"></p>`,[...(branch?[{label:'沿用游戏头图',action:()=>mutate({cover_id:null})}]:[]),{label:'完成',primary:true,action:this.closeModal}]);
      this.$('#toggleAutoCover').onclick=()=>mutate({auto_update:!autoCoverEnabled(presentation)});
      if(this.getState().automaticCoversAvailable===false){this.$('#toggleAutoCover').disabled=true;this.$('#toggleAutoCover').textContent='自动更新待服务启用';}
      this.$('#gameMediaUpload').disabled=presentation.images.length>=8;
      this.$('#gameMediaUpload').onchange=async e=>{
        const file=e.target.files[0];if(!file)return;
        try{
          if(file.size>5*1024*1024)throw new Error('图片不能超过 5 MB');
          if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择 PNG、JPEG 或 WebP 图片');
          const bitmap=await createImageBitmap(file);const valid=bitmap.width<=8192&&bitmap.height<=8192&&bitmap.width*bitmap.height<=32000000;bitmap.close();if(!valid)throw new Error('图片尺寸过大，请缩小后再上传');
          const data_url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
          await mutate({image:{data_url,name:file.name}});
        }catch(error){if(active())this.$('#modalError').textContent=error.message||'无法读取图片';}
      };
      this.$('#modalBody').querySelectorAll('[data-cover]').forEach(button=>button.onclick=()=>mutate({cover_id:button.dataset.cover}));
      this.$('#modalBody').querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>mutate({remove_image_id:button.dataset.remove}));this.hydrate(this.$('#modalBody'));
    };
    const mutate=async patch=>{
      if(busy||owner!==this.owner||!active())return;busy=true;
      this.$('#modalBody').querySelectorAll('button,input').forEach(e=>e.disabled=true);this.$('#modalFooter').querySelectorAll('button').forEach(e=>e.disabled=true);
      this.$('#mediaProgress').textContent='正在保存…';
      try{
        const result=await this.api.api(route,{method:'PATCH',body:{expected_version:presentation.version,...patch}});
        if(owner!==this.owner)return;const currentProject=this.getState().projects.find(p=>p.id===project.id),currentTarget=branch?currentProject?.branches.find(b=>b.branch_id===branch.branch_id):currentProject;presentation=(currentTarget?.presentation?.version??0)>result.presentation.version?currentTarget.presentation:result.presentation;target.presentation=presentation;if(currentTarget)currentTarget.presentation=presentation;this.render();
        if(active())render();this.toast('头图与截图已保存');
      }catch(error){
        if(owner!==this.owner)return;
        // Resolve uncertain writes and conflicts through the authenticated catalog before allowing another edit.
        try{await this.refresh();const p=this.getState().projects.find(p=>p.id===project.id);if(p){presentation=(branch?p.branches.find(b=>b.branch_id===branch.branch_id):p)?.presentation??empty();target.presentation=presentation;}}catch{}
        if(active()){render();this.$('#modalError').textContent=error.message;}
      }finally{busy=false;}
    };
    render();
  }
}
