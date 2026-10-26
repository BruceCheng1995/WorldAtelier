import {createAnnotationDraft} from './viewport-annotations.mjs';
import {SemanticAuthoring} from './semantic-authoring.mjs';
import {prepareNativeEditorContent} from './native-editor-content.mjs';
import { CreationEnvironments } from './environments.mjs';
import { ProjectMedia } from './project-media.mjs';
import {SessionImages,MAX_IMAGE_BYTES} from './session-images.mjs';
import { resolve } from 'node:path';
import { createReadStream, statSync,readFileSync } from 'node:fs';
import { CreationStore } from './store.mjs';
import { CreationAssets } from './assets.mjs';
import { CreationRealtime } from './realtime.mjs';
import { CreationAgentRuns } from './agent-runs.mjs';
import { CreationWorlds } from './worlds.mjs';
import { seedManifest } from './seed.mjs';
import { fail } from './schema.mjs';
import { HIERARCHY_SCHEMA, resolveScene } from './hierarchy.mjs';
import { hierarchyPreview } from './hierarchy-store.mjs';
import { hierarchyObjectView } from './hierarchy-view.mjs';
import { CreationInbox } from './inbox.mjs';
import { CreationNotifications } from './notifications.mjs';
import { CanonicalGameValidation } from './canonical-game-validation.mjs';
import { CreationBuilds } from './export-builds.mjs';
import { CreationCollaboration } from './collaboration.mjs';
import { CreationAdmin } from './admin.mjs';
import { NativeProjects } from './native-project.mjs';
import { NATIVE_SCHEMA } from './native-source.mjs';
import { nativeObjectViews } from './native-view.mjs';
import { convertLegacyManifest } from './native-migration/legacy-converter.mjs';
import { gameStorage } from './project-snapshot.mjs';
import {NativeMerges} from './native-merge.mjs';
import {NativeGameReleases} from './native-game-releases.mjs';
import {prefabTestList,createPrefabTest} from './prefab-tests.mjs';
import {AssetMarket} from './asset-market.mjs';
import {RuntimeAccess} from './runtime-access.mjs';
import {workspaceNetwork} from '../preview/network.mjs';
import {PlayObservations} from './play-observations.mjs';
import {SessionContinuations} from './session-continuations.mjs';
import {NativeClients} from './native-clients.mjs';
import {NativeOffline} from './native-offline.mjs';
import {createBranchMergeDraft} from './native-merge-agent.mjs';
import {CREATOR_SKILLS} from './agent-skill-catalog.mjs';

async function readBody(req,max=512*1024,raw=false) {
  const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>max)fail(413,'请求内容过大');chunks.push(part);}
  const bytes=Buffer.concat(chunks);if(raw)return bytes;
  try{return bytes.length?JSON.parse(bytes):{};}catch{fail(400,'JSON 格式无效');}
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}

export class CreationService {
  constructor({server,root,data,origin,runtimeBuild,publicPlay=false,requestOrigin=null,workspaceUrls=()=>[],network=null}) {
    network??=workspaceNetwork(Number(new URL(origin).port||80));requestOrigin??=network.requestOrigin;
    this.requestOrigin=requestOrigin;this.root=root;this.data=data;this.origin=origin;this.runtimeBuild=runtimeBuild??resolve(root,'.local/model-preview/build');
    this.hierarchyEditing=process.env.WORLD_ATELIER_ENABLE_HIERARCHY==='1';
    this.store=new CreationStore(resolve(data,'creation.sqlite'));this.store.publicPlay=publicPlay;
    this.store.adminUserId=process.env.WORLD_ATELIER_ADMIN_USER_ID||null;
    this.assets=new CreationAssets({store:this.store,root,data});
    this.native=new NativeProjects({store:this.store,data,readModelAsset:({project_id,asset_hash})=>{
      if(!this.store.assetAllowed(project_id,asset_hash,'glb'))fail(403,'没有此项目模型资产的访问权限');
      return readFileSync(resolve(this.assets.directory,asset_hash+'.glb'));
    },convertLegacy:({manifest,project_id,branch_id})=>convertLegacyManifest({manifest,projectName:gameStorage(this,project_id,branch_id).namespace,readLegacyRuntimeFile:path=>{
      if(!['fonts/CreatorUI.tres','fonts/NotoSansSC.ttf','fonts/OFL.txt'].includes(path))fail(422,'未知的旧工程字体依赖');
      return readFileSync(resolve(root,'runtimes/model-preview',path));
    },readAsset:(digest,extension)=>{
      if(!this.store.assetAllowed(project_id,digest,extension))fail(403,'迁移依赖没有项目访问权限');
      return readFileSync(resolve(this.assets.directory,`${digest}.${extension}`));
    }})});
    this.nativeMerges=new NativeMerges({store:this.store,native:this.native});
    this.nativeOffline=new NativeOffline({service:this});
    this.market=new AssetMarket({service:this});this.market.loadOfficial();
    this.projectMedia=new ProjectMedia({store:this.store,data});
    this.sessionImages=new SessionImages({store:this.store,data});
    this.environments=new CreationEnvironments({service:this});
    this.builds=new CreationBuilds({service:this});
    this.runtimeAccess=new RuntimeAccess({service:this,network});
    this.observations=new PlayObservations({service:this});
    this.continuations=new SessionContinuations({service:this});
    this.gameReleases=new NativeGameReleases({service:this});
    this.realtime=new CreationRealtime({server,store:this.store,requestOrigin,onWorld:(client,message)=>this.worlds?.message(client,message)});
    this.agent=process.env.WORLD_ATELIER_DISABLE_AGENT==='1'?null:new CreationAgentRuns({service:this,codexPath:process.env.CODEX_BIN});
    this.worlds=process.env.WORLD_ATELIER_DISABLE_WORLDS==='1'?null:new CreationWorlds({service:this,server,godotPath:process.env.GODOT_BIN});this.authAttempts=new Map();
    this.nativeClients=new NativeClients({service:this,server});
    this.semantic=new SemanticAuthoring({store:this.store,commit:(user,p,b,input,origin)=>this.committed(user,p,b,input,origin)});
    this.inbox=new CreationInbox({store:this.store,onChanged:change=>this.inboxChanged(change)});
    this.notices=new CreationNotifications({service:this});
    for(const item of this.store.list('creator_inbox_item'))if(item.source==='agent'&&item.kind==='decision'&&item.status==='open')this.observe(()=>this.inbox.close(item.id,{status:'obsolete',reason:'服务已重启，旧请求入口已失效；核对执行后显示新的真实请求'}));
    this.validator=new CanonicalGameValidation({service:this});
    this.collaboration=new CreationCollaboration({store:this.store,inbox:this.inbox,workspaceUrls,onChanged:(p,change)=>this.collaborationChanged(p,change)});
    this.admin=new CreationAdmin({service:this,server});
    this.realtime.onSubscribe=client=>this.agent?.publicState(client.scope.project_id,client.scope.branch_id);
  }
  observe(action){try{const result=action();if(result?.catch)result.catch(error=>console.error('[creation-notification]',error.message));return result;}catch(error){console.error('[creation-notification]',error.message);return null;}}
  inboxChanged(change={}){if(this.closing)return;for(const client of this.realtime.connections.values()){if(!client.user)continue;try{const user=this.store.authenticate(client.token);if(!change.recipient_user_ids||change.recipient_user_ids.includes(user.id))this.realtime.send(client,{type:'inbox_changed'});if(client.scope&&(!change.project_id||client.scope.project_id===change.project_id)){this.store.branchFor(user,client.scope.project_id,client.scope.branch_id);this.realtime.send(client,this.realtime.packet(client,'issues_changed'));}}catch{}}}
  collaborationChanged(p,{permissionsChanged=true}={}){this.realtime.permissionsChanged(p);if(permissionsChanged)this.agent?.permissionsChanged(p);this.inboxChanged();}
  auth(req){return this.store.authenticate(String(req.headers.authorization??'').replace(/^Bearer /,''));}
  async createProject(user,input){
    if(!this.store.canCreateProject(user))fail(403,'当前账号没有新建游戏的权限');
    if(!['empty','harbor',undefined].includes(input.template))fail(400,'未知初始模板');
    let files;
    if(input.template==='harbor'){
      const converted=await convertLegacyManifest({manifest:seedManifest(this.root,'harbor'),projectName:String(input.name??'新的游戏'),readAsset:(digest,extension)=>{
        if(!this.store.assetAllowed(null,digest,extension))fail(403,'初始模板只能使用内置资产');
        return readFileSync(resolve(this.assets.directory,`${digest}.${extension}`));
      }});
      files=converted.files;
    }else files=new Map([
      ['project.godot',Buffer.from('config_version=5\n[application]\nconfig/name="World Atelier Game"\nrun/main_scene="res://scenes/main.tscn"\nconfig/features=PackedStringArray("4.6", "GL Compatibility")\n[display]\nwindow/size/viewport_width=1000\nwindow/size/viewport_height=700\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')],
      ['scenes/main.tscn',Buffer.from('[gd_scene format=3]\n[node name="Main" type="Node3D"]\nmetadata/wa_node_id = "main-root"\n')],
      ['.atelier/catalog.json',Buffer.from(JSON.stringify({format:1,entry_scene_id:'scene-harbor',resources:{'scene-harbor':{id:'scene-harbor',name:'初始场景',kind:'scene',path:'scenes/main.tscn'}}},null,2)+'\n')]
    ]);
    const source=Object.fromEntries([...files].map(([path,bytes])=>[path,this.native.archive.put(bytes)]));
    const manifest=await this.native.inspectFiles(source,{assignIds:true});
    return this.store.createProject(user,input,manifest);
  }
  committed(user,p,b,input,origin=null) {
    const branch=this.store.branchFor(user,p,b,true),manifest=this.store.get('creator_revision',branch.head).manifest;
    const native=manifest.schema===NATIVE_SCHEMA||input.ops?.some(op=>['migrate_native','import_native_project'].includes(op.type));
    if(!native)this.assertHierarchyEditing(user,p,b,input);
    const result=native?this.native.apply(user,p,b,input,origin):this.store.apply(user,p,b,input,origin);
    const publish=result=>{
      if(!result.replayed)this.realtime.committed(p,b,result);
      if(!result.replayed)this.agent?.publicState(p,b);
      return result;
    };
    return result?.then?result.then(publish):publish(result);
  }
  assertHierarchyEditing(user,p,b,input={}) {
    const branch=this.store.branchFor(user,p,b,true);
    if(!this.hierarchyEditing&&(input.ops?.some(op=>op.type==='migrate_hierarchy')||this.store.get('creator_revision',branch.head).manifest.schema===HIERARCHY_SCHEMA))fail(422,'层级工作台正在集成，尚未开放此写入',{code:'hierarchy_editor_unavailable'});
  }
  sessionEvent(sid,event){const stored=this.store.appendSessionEvent(sid,event);this.realtime.sessionEvent(sid,stored);this.observe(()=>this.notices?.session(sid,stored));return stored;}
  validationInput(user,p,b,input) {
    return {resource_id:input.resource_id,revision:input.revision,...(input.request_id!==undefined?{request_id:input.request_id}:{}),...(Object.hasOwn(input,'expected_world_version')?{expected_world_version:input.expected_world_version}:{})};
  }
  verificationFinished(verification) {
    if(this.closing)return;
    this.observe(()=>this.notices?.verification(verification));
    const origin=verification.origin;if(!origin)return;
    const run=this.store.get('creator_run',origin.run_id);
    if(!run||run.session_id!==origin.session_id||run.project_id!==verification.project_id||run.branch_id!==verification.branch_id)return;
    if(!run.verifications.includes(verification.id)){run.verifications.push(verification.id);this.store.put('creator_run',run);this.sessionEvent(run.session_id,{kind:'verification_finished',run_id:run.id,verification_id:verification.id,status:verification.status});this.agent?.publicState(run.project_id,run.branch_id);}
  }
  deliveryFinished(delivery,origin) {
    if(!origin)return;const run=this.store.get('creator_run',origin.run_id);if(!run||run.session_id!==origin.session_id)return;
    if(!run.deliveries.some(d=>(typeof d==='string'?d:d.id)===delivery.id)){run.deliveries.push(delivery.id);this.store.put('creator_run',run);this.sessionEvent(run.session_id,{kind:'delivery_finished',run_id:run.id,delivery_id:delivery.id});this.agent?.publicState(run.project_id,run.branch_id);}
  }
  async request(req,res) {
    if(this.runtimeAccess.network.runtimeRequestOrigin(req))return this.runtimeAccess.request(req,res);
    const url=new URL(req.url,this.origin),path=url.pathname;
    if(!path.startsWith('/creation-api/'))return false;
    let authenticatedUser=null,errorScope={};
    try {
      if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==`http://${req.headers.host}`)fail(403,'写入必须来自当前工作台');
      const parts=path.slice('/creation-api/'.length).split('/').map(decodeURIComponent);
      const [area,p,action,b,operation]=parts;
      let input;
      const body=async()=>input??=await readBody(req);
      if(area==='market'){
        if(p==='catalog'&&!action&&req.method==='GET'){json(res,200,this.market.catalog());return true;}
        if(!p&&req.method==='GET'){json(res,200,this.market.list(Object.fromEntries(url.searchParams)));return true;}
        if(p&&action==='versions'&&operation==='files'&&['GET','HEAD'].includes(req.method)){this.market.file(p,b,parts.slice(5).join('/'),req,res);return true;}
        if(p&&!action&&req.method==='GET'){const detail=this.market.detail(p,url.searchParams.get('version'));this.market.analytics.record(p,'views');json(res,200,detail);return true;}
        const uploader=this.auth(req);
        if(p==='files'&&req.method==='POST'){json(res,201,this.market.upload(uploader,await readBody(req,32*1024*1024,true),decodeURIComponent(req.headers['x-asset-name']??'asset.bin')));return true;}
        if(!p&&req.method==='POST'){json(res,201,this.market.publish(uploader,await readBody(req,1024*1024)));return true;}
        fail(404,'市场接口不存在');
      }
      if(area==='admin'){json(res,200,await this.admin.request(req,res,parts,body));return true;}
      if(area==='health'&&req.method==='GET'){json(res,200,{ok:true,service:'creation',registration_open:true,public_play:this.store.publicPlay===true,collaboration_access:true,schema:NATIVE_SCHEMA,supported_schemas:[NATIVE_SCHEMA,'creation-flat-1',HIERARCHY_SCHEMA],native_authoring:true,native_fine_merge:1,play_context:1,session_continuations:1,runtime_isolation:'wa-runtime-origin-1',native_clients:1,native_offline:1,ai_property_actions:1,native_editor:true,native_control_layout:true,native_shared_worlds:Boolean(this.worlds?.native),automatic_covers:true,manual_covers:true,project_management:true,annotation_context_version:4,viewport_annotations:2,agent_environment_version:1,agent_asset_files:true,creator_skills:CREATOR_SKILLS.map(skill=>skill.name),chat_settings:true,chat_access:true,chat_questions:true,export_builds:true,agent_goals:true,ai_limits_version:1,market_admin_version:1,automatic_verification:false,inbox:true,semantic_authoring:true,hierarchy_editing:this.hierarchyEditing,agent_ready:Boolean(this.agent),agent_auto_resume:Boolean(this.agent?.autoResume),worlds_ready:Boolean(this.worlds)});return true;}
      if(area==='auth'&&req.method==='POST'&&['register','login'].includes(p)){
        const address=req.socket.remoteAddress,attempts=this.authAttempts.get(address)?.filter(t=>t>Date.now()-60000)??[];
        if(attempts.length>60)fail(429,'登录尝试过于频繁，请稍后再试');attempts.push(Date.now());this.authAttempts.set(address,attempts);
        const result=p==='register'?this.store.register(await body()):this.store.login(await body());json(res,p==='register'?201:200,result);return true;
      }
      const user=this.auth(req);authenticatedUser=user;if(area==='projects'&&action==='branches'&&p&&b)errorScope={project_id:p,branch_id:b};
      if(area==='native-workspaces')return this.nativeOffline.request(user,req,res,url);
      if(await this.nativeClients.request(user,req,res,url))return true;
      if(await this.observations.request(req,res,user,parts,max=>readBody(req,max)))return true;
      if(await this.continuations.request(req,res,user,parts,max=>readBody(req,max)))return true;
      if(area==='auth'&&p==='profile'&&!action&&req.method==='PATCH'){
        const result=this.store.updateProfile(user,await body());
        this.observe(()=>this.realtime.userUpdated(result.user));json(res,200,result);return true;
      }
      if(area==='inbox'){
        if(!p&&req.method==='GET'){const query=Object.fromEntries(url.searchParams);if(query.limit)query.limit=Number(query.limit);if(query.target){try{query.target=JSON.parse(query.target);}catch{fail(400,'问题范围无效');}}json(res,200,this.inbox.list(user,query));return true;}
        if(p&&!action&&req.method==='GET'){json(res,200,{item:this.inbox.get(user,p)});return true;}
        if(p&&action==='read'&&req.method==='POST'){json(res,200,this.inbox.read(user,p,await body()));return true;}
      }
      if(area==='diagnostics'&&req.method==='POST'){json(res,200,p==='recovered'?this.notices.clientRecovered(user,await body()):this.notices.client(user,await body()));return true;}
      if(['goals','automatic-checks'].includes(area))fail(410,'会话验证流程已移除，Agent 结果直接应用');
      if(area==='builds'&&p){
        if(!action&&req.method==='GET'){json(res,200,{job:this.builds.view(this.builds.forUser(user,p))});return true;}
        if(action==='artifacts'&&b&&['GET','HEAD'].includes(req.method)){this.builds.download(user,p,b,req,res);return true;}
        if(action==='access'&&req.method==='POST'){json(res,200,this.builds.access(user,p,res,req));return true;}
      }
      if(area==='bootstrap'&&req.method==='GET'){json(res,200,this.store.bootstrap(user));return true;}
      if(area==='auth'&&p==='logout'&&req.method==='POST'){const token=String(req.headers.authorization).slice(7);const {hash}=await import('./schema.mjs');this.store.remove('creator_login',hash(token));json(res,200,{ok:true});return true;}
      if(area==='projects') {
        if(p&&!action&&req.method==='PATCH'){const input=await body(),result=this.store.updateProject(user,p,input);this.collaborationChanged(p,{permissionsChanged:Object.hasOwn(input,'archived')});json(res,200,result);return true;}
        if(action==='branches'&&operation==='manual-cover'&&req.method==='POST'){json(res,200,this.projectMedia.captureManual(user,p,b,await readBody(req,8*1024*1024)));return true;}
        if(action==='branches'&&operation==='auto-cover'&&req.method==='POST'){json(res,200,this.projectMedia.capture(user,p,b,await readBody(req,8*1024*1024)));return true;}
        if(action==='presentation'&&req.method==='PATCH'){json(res,200,this.projectMedia.update(user,p,null,await readBody(req,8*1024*1024)));return true;}
        if(action==='branches'&&operation==='presentation'&&req.method==='PATCH'){json(res,200,this.projectMedia.update(user,p,b,await readBody(req,8*1024*1024)));return true;}
        if(action==='media'&&b&&['GET','HEAD'].includes(req.method)){this.projectMedia.download(user,p,b,req,res);return true;}
        if(!p&&req.method==='POST') {json(res,201,await this.createProject(user,await body()));return true;}
        if(action==='collaboration'&&req.method==='GET'){json(res,200,this.collaboration.view(user,p));return true;}
        if(action==='share-invitations'&&!b&&req.method==='POST'){json(res,201,this.collaboration.invitePeople(user,p,await body()));return true;}
        if(action==='sharing'&&!b&&req.method==='PATCH'){json(res,200,this.collaboration.generalAccess(user,p,await body()));return true;}
        if(action==='access-requests'&&!b&&req.method==='POST'){json(res,201,this.collaboration.request(user,p,await body()));return true;}
        if(action==='access-requests'&&b&&['decision','cancel'].includes(operation)&&req.method==='POST'){json(res,200,this.collaboration.resolve(user,p,b,await body(),operation==='cancel'));return true;}
        if(action==='invites'&&!b&&req.method==='POST'){json(res,201,this.collaboration.invite(user,p,await body()));return true;}
        if(action==='invites'&&b&&operation==='revoke'&&req.method==='POST'){json(res,200,this.collaboration.revokeInvite(user,p,b,await body()));return true;}
        if(action==='members'&&b&&req.method==='PATCH'){json(res,200,this.collaboration.member(user,p,b,await body()));return true;}
        if(action==='assets'&&req.method==='POST'){
          this.store.projectFor(user,p,true);const bytes=await readBody(req,20*1024*1024,true);
          let filename;try{filename=decodeURIComponent(req.headers['x-asset-name']??'model.glb');}catch{fail(400,'资产名称编码无效');}
          json(res,201,this.assets.publish(user,p,bytes,filename));return true;
        }
        if(action==='branches') {
          if(operation==='market-import'&&req.method==='POST'){json(res,200,await this.market.importToProject(user,p,b,await body()));return true;}
          if(operation==='annotation-drafts'&&req.method==='POST'){json(res,201,createAnnotationDraft(this.store,user,p,b,await body()));return true;}
          if(operation==='semantic-resources'&&req.method==='GET'){json(res,200,this.semantic.resources(user,p,b,Object.fromEntries(url.searchParams)));return true;}
          if(operation==='semantic-resources'&&req.method==='POST'){json(res,200,await this.semantic.updateResource(user,p,b,await body()));return true;}
          if(operation==='knowledge'&&req.method==='GET'){json(res,200,this.semantic.knowledge(user,p,b,Object.fromEntries(url.searchParams)));return true;}
          if(operation==='knowledge'&&req.method==='POST'){json(res,200,await this.semantic.updateKnowledge(user,p,b,await body()));return true;}
          if(operation==='issues'&&req.method==='GET'){json(res,200,{issues:this.inbox.projection(user,p,b)});return true;}
          if(operation==='builds'&&req.method==='GET'){json(res,200,this.builds.list(user,p,b));return true;}
          if(operation==='builds'&&req.method==='POST'){json(res,202,this.builds.create(user,p,b,await body()));return true;}
          if(operation==='play-build'&&req.method==='POST'){json(res,202,await this.builds.preparePlay(user,p,b,await body()));return true;}
          if(operation==='prefab-tests'&&req.method==='GET'){json(res,200,prefabTestList(this,user,p,b,Object.fromEntries(url.searchParams)));return true;}
          if(operation==='prefab-tests'&&req.method==='POST'){json(res,200,await createPrefabTest(this,user,p,b,await body()));return true;}
          if(operation==='prefab-test-build'&&req.method==='POST'){json(res,202,this.builds.preparePrefabTest(user,p,b,await body()));return true;}
          if(operation==='native-preview-build'&&req.method==='POST'){json(res,202,this.builds.prepareNativePreview(user,p,b,await body()));return true;}
          if(operation==='native-preview-content'&&req.method==='POST'){json(res,200,await prepareNativeEditorContent(this.builds,user,p,b,await body()));return true;}
          if(operation==='shared-world'&&req.method==='GET'){
            if(!this.worlds)fail(503,'共享世界服务尚未就绪');
            json(res,200,this.worlds.native.view(user,p,b,url.searchParams.get('resource_id')||null));return true;
          }
          if(operation==='shared-playable'&&req.method==='GET'){
            if(!this.worlds)fail(503,'共享世界服务尚未就绪');
            const branch=this.store.branchView(user,p,b);
            json(res,200,this.worlds.native.playable(user,p,b,url.searchParams.get('resource_id')||branch.manifest.entry_scene_id));return true;
          }
          if(!b&&req.method==='POST'){json(res,201,this.store.fork(user,p,await body()));return true;}
          if(b&&!operation&&req.method==='GET'){json(res,200,this.store.branchView(user,p,b));return true;}
          if(operation==='transactions'&&req.method==='POST'){json(res,200,await this.committed(user,p,b,await body()));return true;}
          if(operation==='native-source'&&req.method==='GET'){json(res,200,this.native.source(user,p,b,Object.fromEntries(url.searchParams)));return true;}
          if(operation==='merge-preview'&&req.method==='POST'){
            const input=await body(),target=this.store.branchFor(user,p,b,true),sources=input.source_branch_ids??[input.source_branch_id];
            if(!Array.isArray(sources)||!sources.length||sources.length>16)fail(400,'请选择有效的来源分支');
            const sourceBranches=sources.map(source=>this.store.branchFor(user,p,source));
            const native=[target,...sourceBranches].some(branch=>this.store.get('creator_revision',branch.head).manifest.schema===NATIVE_SCHEMA);
            if(!native&&sources.length!==1)fail(422,'历史源格式仅支持逐个分支合并');
            json(res,200,native?this.nativeMerges.preview(user,p,b,input):this.store.mergePreview(user,p,b,{...input,source_branch_id:sources[0]}));return true;
          }
          if(operation==='merge-review'&&req.method==='POST'){json(res,200,this.nativeMerges.review(user,p,b,await body()));return true;}
          if(operation==='merge-revert-preview'&&req.method==='POST'){json(res,200,this.nativeMerges.revertPreview(user,p,b,await body()));return true;}
          if(operation==='merge-history'&&req.method==='GET'){
            const target=this.store.branchFor(user,p,b,true),rows=this.store.list('creator_revision').filter(revision=>revision.project_id===p&&revision.origin?.native_merge&&this.store.ancestor(revision.id,target.head));
            const items=rows.filter(revision=>this.store.get('creator_merge_preview',revision.origin.merge_preview_id)?.target_branch_id===b).sort((a,b)=>b.created_at-a.created_at).slice(0,40).map(revision=>({revision:revision.id,created_at:revision.created_at,parents:revision.parents,revert_of:revision.origin.revert_of??null,sources:this.store.get('creator_merge_preview',revision.origin.merge_preview_id)?.sources?.map(source=>source.branch_id)??[]}));
            json(res,200,{target_revision:target.head,items});return true;
          }
          if(operation==='merge'&&req.method==='POST'){const input=await body(),target=this.store.branchFor(user,p,b,true),native=this.store.get('creator_revision',target.head).manifest.schema===NATIVE_SCHEMA||this.store.get('creator_merge_preview',input.preview_id)?.schema===NATIVE_SCHEMA;if(!native)this.assertHierarchyEditing(user,p,b);const result=await(native?this.nativeMerges.merge(user,p,b,input):this.store.merge(user,p,b,input));if(!result.replayed){this.realtime.committed(p,b,result);this.agent?.publicState(p,b);}json(res,200,result);return true;}
          if(operation==='resolved-scene'&&req.method==='GET'){
            const branch=this.store.branchFor(user,p,b),revision=url.searchParams.get('revision');
            const fixed=revision&&this.store.get('creator_revision',revision);
            if(!fixed||fixed.project_id!==p||!this.store.ancestor(revision,branch.head))fail(409,'读取层级需要此分支可达的固定源版本');
            if(fixed.manifest.schema===NATIVE_SCHEMA){const objects=nativeObjectViews(fixed.manifest,url.searchParams.get('resource_id')||fixed.manifest.entry_scene_id,{project_id:p,branch_id:b});json(res,200,{revision,document_schema:NATIVE_SCHEMA,objects,rows:objects.map(object=>({key:object.id,parent_key:object.parent_id,address:object.address,object}))});return true;}
            const rows=resolveScene(fixed.manifest,url.searchParams.get('resource_id')||fixed.manifest.entry_scene_id,{project_id:p,branch_id:b,assetAllowed:(h,e)=>this.store.assetAllowed(p,h,e)});
            json(res,200,{revision,rows,objects:rows.map(hierarchyObjectView)});return true;
          }
          if(operation==='hierarchy-preview'&&req.method==='POST'){json(res,200,hierarchyPreview(this.store,user,p,b,await body()));return true;}
          if(operation==='runtime-scene'&&req.method==='GET'){
            let branch=this.store.branchView(user,p,b);const revision=url.searchParams.get('revision');
            if(revision){const fixed=this.store.get('creator_revision',revision);if(!fixed||fixed.project_id!==p)fail(409,'场景读取需要此项目的固定源版本');if(!this.store.ancestor(revision,branch.head)){if(fixed.manifest.schema!==NATIVE_SCHEMA)fail(409,'场景读取需要此分支可达的固定源版本');try{this.gameReleases.authorizeSource(user,p,b,revision);}catch(error){if(!this.worlds?.native.authorizeSource(user,p,b,revision))throw error;}}branch={...branch,head:revision,manifest:fixed.manifest};}
            const scene=this.assets.scene(user,p,branch,url.searchParams.get('resource_id')||branch.manifest.entry_scene_id,this.requestOrigin?.(req)??this.origin,branch.manifest.schema===HIERARCHY_SCHEMA?this.worlds?.runtimeManifest().capabilities??{}:{});
            if(scene.document_schema===NATIVE_SCHEMA&&url.searchParams.get('thumbnail')==='1')scene.thumbnail_renderer_identity=this.builds.nativeThumbnailRendererIdentity();
            json(res,200,scene);return true;
          }
          if(operation==='game-releases'){
            if(req.method==='GET'){json(res,200,this.gameReleases.list(user,p,b));return true;}
            if(req.method==='POST'){const result=this.gameReleases.publish(user,p,b,await body());json(res,result.replayed?200:201,result);return true;}
          }
          if(operation==='playable-game'&&req.method==='GET'){
            json(res,200,this.builds.playableGame(user,p,b,url.searchParams.get('resource_id')||null));return true;
          }
          if(operation==='playable'&&req.method==='GET'){
            if(!this.worlds)fail(503,'Godot 世界服务尚未就绪');
            const branch=this.store.branchView(user,p,b);
            json(res,200,this.worlds.playable(user,p,b,url.searchParams.get('resource_id')||branch.manifest.entry_scene_id));return true;
          }
          if(operation==='sessions'){
            if(req.method==='GET'){json(res,200,{sessions:this.store.sessions(user,p,b)});return true;}
            if(req.method==='POST'){const input=await body();this.store.branchFor(user,p,b,true);if(input.effort!=null){if(!this.agent)fail(503,'Codex 执行器尚未就绪');await this.agent.validateSettings(input.model,input.effort);}json(res,201,this.store.createSession(user,p,b,input));return true;}
          }
          if(operation==='validate'&&req.method==='POST'){if(!this.worlds)fail(503,'Godot 验证服务尚未就绪');json(res,200,await this.worlds.validate(user,p,b,this.validationInput(user,p,b,await body())));return true;}
          if(operation==='publish'&&req.method==='POST'){if(!this.worlds)fail(503,'Godot 世界服务尚未就绪');const result=await this.worlds.publish(user,p,b,this.validationInput(user,p,b,await body()));this.agent?.publicState(p,b);json(res,200,result);return true;}
        }
      }
      if(area==='invites'&&p==='join'&&req.method==='POST'){json(res,200,this.collaboration.join(user,await body()));return true;}
      if(area==='sessions'&&p) {
        if(action==='merge-context'&&req.method==='POST'){const result=createBranchMergeDraft(this,user,p,await body());json(res,200,{...result,session:this.store.sessionView(user,p)});return true;}
        if(!action&&req.method==='GET'){json(res,200,this.store.sessionView(user,p));return true;}
        if(!action&&req.method==='PATCH'){const input=await body(),session=this.store.sessionFor(user,p,true);if(input.model!==undefined&&input.model!==session.model&&input.effort===undefined)input.effort=null;const effort=input.effort===undefined?session.effort:input.effort;if((input.model!==undefined||input.effort!==undefined)&&effort!=null){if(!this.agent)fail(503,'Codex 执行器尚未就绪');await this.agent.validateSettings(input.model??session.model,effort);}json(res,200,this.store.updateSession(user,p,input));return true;}
        if(action==='annotation-imports'&&req.method==='POST'){const session=this.store.sessionFor(user,p,true),input=await body();if(input.project_id!==session.project_id||input.branch_id!==session.branch_id)fail(409,'只能粘贴到同一项目和分支的会话');json(res,200,createAnnotationDraft(this.store,user,session.project_id,session.branch_id,input,{sessionId:p}));return true;}
        if(action==='semantic-attachments'&&req.method==='POST'){json(res,201,this.semantic.attach(user,p,await body()));return true;}
        if(action==='image-attachments'&&!b&&req.method==='POST'){this.store.sessionFor(user,p,true);const bytes=await readBody(req,MAX_IMAGE_BYTES,true);json(res,201,this.sessionImages.attach(user,p,{bytes,mime:req.headers['content-type'],name:url.searchParams.get('name')}));return true;}
        if(action==='image-attachments'&&b&&['GET','HEAD'].includes(req.method)){this.sessionImages.download(user,p,b,req,res);return true;}
        if(action==='attachments'&&b&&req.method==='DELETE'){json(res,200,this.store.removeAttachment(user,p,b));return true;}
        if(action==='attachments'&&req.method==='POST'){json(res,201,this.store.attach(user,p,await body()));return true;}
        if(action==='inspection-attachments'&&req.method==='POST'){if(!this.worlds)fail(503,'世界服务尚未就绪');json(res,201,this.worlds.attachInspection(user,p,await body()));return true;}
        if(action==='events'&&b&&req.method==='GET'){const cursor=Number(b);if(!Number.isSafeInteger(cursor)||cursor<1)fail(400,'事件游标无效');json(res,200,this.store.sessionEventDetail(user,p,cursor));return true;}
        if(action==='events'&&req.method==='GET'){json(res,200,{events:this.store.sessionEvents(user,p,Math.max(0,Number(url.searchParams.get('after'))||0),{compact:url.searchParams.get('view')==='compact'})});return true;}
        if(action==='turns'&&req.method==='POST'){if(!this.agent)fail(503,'Codex 执行器尚未就绪');json(res,202,await this.agent.send(user,p,await body()));return true;}
        if(action==='interrupt'&&req.method==='POST'){if(!this.agent)fail(503,'Codex 执行器尚未就绪');json(res,200,await this.agent.interrupt(user,p));return true;}
        if(action==='reconcile'&&req.method==='POST'){if(!this.agent)fail(503,'Codex 执行器尚未就绪');json(res,200,await this.agent.reconcile(user,p));return true;}
        if(action==='requests'&&!b&&req.method==='GET'){const session=this.store.sessionFor(user,p,true);const requests=[...(this.agent?.requests??[])].filter(([key,r])=>r.session_id===p&&this.agent.adapter.pendingRequests(session.executor_thread_id).some(x=>x.key===key)).map(([key,r])=>({request_key:key,method:r.method,params:r.params}));json(res,200,{requests});return true;}
        if(action==='requests'&&b&&req.method==='POST'){if(!this.agent)fail(503,'Codex 执行器尚未就绪');json(res,200,await this.agent.reply(user,p,b,await body()));return true;}
      }
      if(area==='agent'&&p==='status'&&req.method==='GET'){json(res,200,this.agent?await this.agent.status():{ready:false});return true;}
      fail(404,'创作接口不存在');
    }catch(error){if(authenticatedUser&&!['admin','inbox','diagnostics','automatic-checks','goals'].includes(path.split('/')[2]))this.observe(()=>this.notices?.backend(authenticatedUser,errorScope,error));json(res,error.status??500,{error:error.message,details:error.details});return true;}
  }
  assetRequest(req,res) {
    const url=new URL(req.url,this.origin);if(!['GET','HEAD'].includes(req.method))return false;
    try{
      const path=decodeURIComponent(url.pathname);if(!path.startsWith('/preview-assets/'))return false;
      const asset=this.assets.resolveAsset(path.slice('/preview-assets/'.length),url.searchParams.get('cap'));if(!asset)return false;
      const length=statSync(asset.path).size;res.writeHead(200,{'Content-Type':asset.path.endsWith('.gd')?'text/plain; charset=utf-8':'model/gltf-binary','Content-Length':length,'Cache-Control':asset.private?'private,no-store':'public,max-age=31536000,immutable','X-Content-Type-Options':'nosniff'});
      if(req.method==='HEAD')res.end();else createReadStream(asset.path).pipe(res);return true;
    }catch(error){json(res,error.status??400,{error:error.message});return true;}
  }
  close(){
    if(this.closePromise)return this.closePromise;
    // Synchronous marker first: terminal Ctrl-C and socket closes must not be
    // persisted as content failures while waiting for a slower Agent shutdown.
    this.closing=true;this.observations?.close();this.admin?.close();this.worlds?.beginClose();this.realtime.close();
    const nativeClosing=this.native?.close();
    this.closePromise=(async()=>{await this.validator?.close();await this.nativeClients?.close();await this.nativeOffline?.close();await Promise.all([nativeClosing,this.worlds?.close(),this.agent?.close(),this.builds?.close(),this.environments?.close()]);this.store.close();})();
    return this.closePromise;
  }
}
