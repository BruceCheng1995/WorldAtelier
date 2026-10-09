import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import { inspectGLB, MAX_GLB_BYTES } from '../preview/glb.mjs';
import { clone, fail, hash, stable } from './schema.mjs';
import { assertHierarchyRuntimeCompatibility } from './hierarchy-references.mjs';
import { HIERARCHY_SCHEMA } from './hierarchy.mjs';
import { packHierarchyRuntime } from './hierarchy-runtime.mjs';
import { hierarchyObjectView } from './hierarchy-view.mjs';
import { NATIVE_SCHEMA } from './native-source.mjs';
import { nativeScenePacket } from './native-view.mjs';

export class CreationAssets {
  constructor({store,root,data}) {
    this.store=store;this.directory=resolve(data,'assets');this.capabilities=new Map();this.builtinAliases=new Map();mkdirSync(this.directory,{recursive:true});
    const {assets:models}=JSON.parse(readFileSync(resolve(root,'content/model-preview/manifest.json')));
    for(const model of models) {
      const bytes=readFileSync(resolve(root,'content/model-preview',model.file));
      if(hash(bytes)!==model.sha256)throw new Error('Built-in asset hash mismatch');
      this.write(model.sha256,'glb',bytes);
      this.builtinAliases.set(model.file,model.sha256);
      store.put('creator_asset',{...store.get('creator_asset',model.sha256),id:model.sha256,ext:'glb',name:model.name,bytes:bytes.length,meshes:model.meshes,builtin:true,project_ids:[]});
    }
  }
  write(digest,ext,bytes) {
    const file=resolve(this.directory,`${digest}.${ext}`);
    if(!existsSync(file)){const temporary=file+'.'+randomBytes(5).toString('hex')+'.tmp';writeFileSync(temporary,bytes);renameSync(temporary,file);}return file;
  }
  publish(user,projectId,bytes,filename) {
    this.store.projectFor(user,projectId,true);
    const ext=extname(filename).slice(1).toLowerCase();let info;
    if(ext==='glb'){try{info=inspectGLB(bytes);}catch(error){fail(400,error.message);}}
    else if(ext==='gd') {
      if(bytes.length<1||bytes.length>256*1024||bytes.includes(0))fail(400,'GDScript 文件须为 1–262144 字节 UTF-8 文本');
      try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail(400,'GDScript 编码需要 UTF-8');}
      info={hash:hash(bytes),bytes:bytes.length};
    } else fail(400,'当前支持独立 GLB 与 GDScript 资产');
    const previous=this.store.get('creator_asset',info.hash);
    if(previous?.quarantined_at)fail(403,'该资产已被管理员隔离，不能重新上传使用');
    this.write(info.hash,ext,bytes);
    const asset={...previous,...info,id:info.hash,ext,name:basename(filename).slice(0,160),project_ids:[...new Set([...(previous?.project_ids??[]),projectId])],created_by:previous?.created_by??user.id,created_at:previous?.created_at??Date.now()};
    this.store.put('creator_asset',asset);return {...asset,url:`/preview-assets/${asset.id}.${ext}`};
  }
  publishFile(user,p,cwd,file) {
    const base=realpathSync(cwd),actual=realpathSync(resolve(cwd,file));
    if(!actual.startsWith(base+sep)||!statSync(actual).isFile())fail(403,'只能发布当前 Agent 工作区中的文件');
    if(statSync(actual).size>MAX_GLB_BYTES)fail(413,'文件过大');
    return this.publish(user,p,readFileSync(actual),basename(actual));
  }
  capability(user,p) {
    this.store.projectFor(user,p);
    const key=`${user.id}:${p}`,old=this.capabilities.get(key);
    if(old&&old.expires_at>Date.now()+600000&&this.store.get('creator_asset_cap',hash(old.token)))return old.token;
    const token=randomBytes(24).toString('base64url'),expires_at=Date.now()+12*3600000;
    this.store.put('creator_asset_cap',{id:hash(token),user_id:user.id,project_id:p,expires_at});
    this.capabilities.set(key,{token,expires_at});return token;
  }
  resolveAsset(filename,cap) {
    const alias=this.builtinAliases.get(filename);
    if(alias&&this.store.get('creator_asset',alias)?.quarantined_at)fail(403,'该资产已被管理员隔离');
    const match=/^([a-f0-9]{64})\.(glb|gd)$/.exec(filename);if(!match)return null;
    const asset=this.store.get('creator_asset',match[1]);if(!asset)return null;
    if(asset.quarantined_at)fail(403,'该资产已被管理员隔离');
    if(asset.ext!==match[2])fail(404,'资产类型不存在');
    if(!asset.builtin){
      const grant=cap&&this.store.get('creator_asset_cap',hash(cap));
      if(!grant||grant.expires_at<Date.now())fail(403,'资产访问授权失效，请重新连接场景');
      this.store.projectFor({id:grant.user_id},grant.project_id);
      if(!this.store.assetAllowed(grant.project_id,asset.id,asset.ext))fail(403,'无权访问此项目资产');
    }
    return {path:resolve(this.directory,filename),private:!asset.builtin};
  }
  scene(user,p,branch,resourceId,origin,capabilities={}) {
    if(branch.manifest.schema===NATIVE_SCHEMA){this.store.branchFor(user,p,branch.branch_id);return nativeScenePacket(branch.manifest,resourceId,{project_id:p,branch_id:branch.branch_id,revision:branch.head,origin});}
    assertHierarchyRuntimeCompatibility(branch.manifest,capabilities);
    const doc=branch.manifest.resources[resourceId];if(!doc)fail(404,'资源不存在');
    if(branch.manifest.schema===HIERARCHY_SCHEMA){
      const pack=packHierarchyRuntime(branch.manifest,{project_id:p,branch_id:branch.branch_id,resource_id:resourceId,source_revision:branch.head,assetAllowed:(h,e)=>this.store.assetAllowed(p,h,e)});
      const cap=this.capability(user,p),asset_access=pack.asset_closure.map(asset=>({...asset,url:asset.url+`?cap=${cap}`}));
      const authorized=new Map(asset_access.map(asset=>[asset.extension+':'+asset.hash,asset.url]));
      const objects=pack.objects.map(row=>{const view=hierarchyObjectView(row);if(view.model_hash)view.model_url=authorized.get('glb:'+view.model_hash);for(const behavior of view.components?.behaviors??[])behavior.script_url=authorized.get('gd:'+behavior.script_hash);return view;});
      const {pack_hash,...canonical}=pack;
      return {origin,document_id:`${p}/${branch.branch_id}/${doc.id}`,project_id:p,branch_id:branch.branch_id,resource_id:doc.id,scene_revision:branch.head,document_schema:HIERARCHY_SCHEMA,hierarchy_pack:pack,hierarchy_pack_canonical:stable(canonical),asset_access,objects};
    }
    const cap=this.capability(user,p),objects=clone(doc.objects);
    for(const o of objects){
      if(o.model_url)o.model_url+=`?cap=${cap}`;
      for(const behavior of o.components?.behaviors??[])behavior.script_url+=`?cap=${cap}`;
    }
    return {origin,document_id:`${p}/${branch.branch_id}/${doc.id}`,branch_id:branch.branch_id,resource_id:doc.id,scene_revision:branch.head,objects};
  }
}
