import {resolve,extname} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {NativeSourceArchive,nativeFileMap,nativeSourcePath,NATIVE_CATALOG,NATIVE_SCHEMA} from './native-source.mjs';
import {fail,hash,identifier,clone} from './schema.mjs';
import {MarketAnalytics} from './market-analytics.mjs';
import {MARKET_FILTERS,marketCatalog,searchMarket} from './asset-market-search.mjs';

const LIMITS={files:500,fileBytes:32*1024*1024,totalBytes:128*1024*1024};
const categories=Object.keys(MARKET_FILTERS.category);
const textExtensions=new Set(['.tscn','.tres','.gd','.gdshader','.json','.gltf','.cfg']);
const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.json':'application/json','.wav':'audio/wav','.ogg':'audio/ogg','.mp3':'audio/mpeg'};
const label=(value,max,required=false)=>{if(typeof value!=='string'||value.length>max||(required&&!value.trim()))fail(422,'资源名称或描述无效');return value.trim();};
const url=value=>{if(!value)return '';try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw 0;return u.href;}catch{fail(422,'来源 URL 无效');}};
const strings=(items,max=30)=>{if(!Array.isArray(items)||items.length>max)fail(422,'资源标签或功能列表无效');return items.map(item=>label(item,240,true));};

/** Market originals are immutable objects. Imports create source files through
 * the same native transaction authority as every other authoring operation. */
export class AssetMarket{
  constructor({service}){this.service=service;this.store=service.store;this.archive=new NativeSourceArchive(resolve(service.data,'market/objects'),{limits:LIMITS});this.analytics=new MarketAnalytics(this.store);}
  assertPublisher(user){if(!this.store.canCreateProject(user))fail(403,'上传资源需要开发者权限');}
  upload(user,bytes,name){this.assertPublisher(user);name=nativeSourcePath(name);const entry=this.archive.put(bytes);this.store.put('market_upload',{id:`${user.id}:${entry.hash}`,user_id:user.id,...entry,name});return entry;}
  normalize(input){
    const files=nativeFileMap(input.files,{limits:LIMITS});if(!Object.keys(files).length)fail(422,'资源包不能为空');this.archive.verify(files);
    for(const path of Object.keys(files))if(path==='project.godot'||path.startsWith('.atelier/')||path.startsWith('addons/')||path==='provenance.json')fail(422,'资源包不能覆盖工程设置、插件或来源记录');
    if(!categories.includes(input.category)||!['2d','3d','any'].includes(input.dimension))fail(422,'请选择资源类别与维度');
    if(!['CC0-1.0','CC-BY-4.0','MIT','Apache-2.0'].includes(input.license)||input.redistribution_confirmed!==true)fail(422,'需要允许再分发的许可及上传者确认');
    const entry_path=input.entry_path?nativeSourcePath(input.entry_path):null;if(entry_path&&!files[entry_path])fail(422,'入口文件不在资源包中');
    const screenshots=strings(input.screenshots??[],8);if(!screenshots.length||screenshots.some(path=>!files[path]||!['.png','.jpg','.jpeg','.webp','.gif'].includes(extname(path).toLowerCase())))fail(422,'请提供至少一张资源截图');
    const preview=clone(input.preview??{type:'image',path:screenshots[0]});
    if(!['image','sprite','model','audio'].includes(preview.type)||!files[preview.path])fail(422,'预览文件无效');
    if(preview.type==='model'&&extname(preview.path)!=='.glb')fail(422,'交互模型预览需要独立 GLB 文件');
    if(preview.type==='sprite'){
      for(const key of ['width','height','columns'])if(!Number.isSafeInteger(preview[key])||preview[key]<1||preview[key]>8192)fail(422,'精灵预览尺寸无效');
      if(!preview.animations||Object.keys(preview.animations).length>30)fail(422,'精灵预览需要动画');
      for(const animation of Object.values(preview.animations))if(!Array.isArray(animation.frames)||!animation.frames.length||animation.frames.length>240||animation.frames.some(n=>!Number.isSafeInteger(n)||n<0||n>65535)||!Number.isFinite(animation.fps)||animation.fps<1||animation.fps>120)fail(422,'精灵动画帧无效');
    }
    const taxonomy={role:input.role??'other',genres:strings(input.genres??[],8),styles:strings(input.styles??[],4),capabilities:strings(input.capabilities??[],12),animations:strings(input.animations??[],240)};
    for(const [key,field] of [['role','role'],['genre','genres'],['style','styles'],['capability','capabilities']])if((Array.isArray(taxonomy[field])?taxonomy[field]:[taxonomy[field]]).some(value=>!Object.hasOwn(MARKET_FILTERS[key],value)))fail(422,'资源分类或能力无效');
    return {...taxonomy,name:label(input.name,160,true),description:label(input.description,12000,true),category:input.category,dimension:input.dimension,license:input.license,author:label(input.author??'',160),source_url:url(input.source_url),files,entry_path,screenshots,preview,tags:strings(input.tags??[]),features:strings(input.features??[]),usage:label(input.usage??'',12000),engine:'Godot 4.6',redistribution_confirmed:true};
  }
  publish(user,input){this.assertPublisher(user);for(const entry of Object.values(input.files??{}))if(!this.store.get('market_upload',`${user.id}:${entry.hash}`))fail(403,'文件须由当前开发者上传');return this.save(this.normalize(input),{publisher:'developer',owner_user_id:user.id,publisher_name:user.name});}
  installOfficial(input){const asset=this.normalize(input);return this.save(asset,{publisher:'official',owner_user_id:null,publisher_name:'世界工坊官方精选'},input.id);}
  save(value,publisher,assetId=`asset-${randomUUID()}`){
    identifier(assetId,'资产 ID');const version=hash({...value,...publisher}),existing=this.store.get('market_asset',assetId);
    if(existing&&existing.publisher!==publisher.publisher)fail(409,'资产 ID 已被占用');
    if(existing?.version===version)return this.detail(assetId,version,{includeHidden:true});
    const asset={...value,...publisher,id:assetId,version,created_at:existing?.created_at??Date.now(),updated_at:Date.now(),hidden_at:existing?.hidden_at??null,admin_version:existing?(existing.admin_version??1)+1:1};
    this.store.transaction(()=>{if(!this.store.get('market_version',`${assetId}:${version}`))this.store.put('market_version',{...asset,id:`${assetId}:${version}`,asset_id:assetId});this.store.put('market_asset',asset);});return {asset:this.detail(assetId,version,{includeHidden:true}).asset};
  }
  detail(assetId,version,{includeHidden=false}={}){
    const current=this.store.get('market_asset',assetId);if(!current||(!includeHidden&&current.hidden_at))fail(404,'资源不存在或已下架');
    const record=version?this.store.get('market_version',`${assetId}:${version}`):current;if(!record)fail(404,'资源版本不存在');
    const asset={...clone(record),id:assetId,detail_url:`/market/assets/${encodeURIComponent(assetId)}`,version_url:`/market/assets/${encodeURIComponent(assetId)}?version=${record.version}`};delete asset.asset_id;
    asset.file_base_url=`/creation-api/market/${encodeURIComponent(assetId)}/versions/${record.version}/files/`;
    asset.thumbnail_url=asset.file_base_url+asset.screenshots[0].split('/').map(encodeURIComponent).join('/');
    asset.total_bytes=Object.values(asset.files).reduce((sum,item)=>sum+item.size,0);return {asset};
  }
  catalog(){return marketCatalog();}
  list(query={}){
    const {records,...result}=searchMarket(this.store.list('market_asset'),query);
    return {...result,assets:records.map(a=>{const {files,usage,animations,...summary}=this.detail(a.id).asset;return {...summary,animation_count:animations?.length??0,file_count:Object.keys(files).length};})};
  }
  file(assetId,version,path,req,res){
    const {asset}=this.detail(assetId,version);path=nativeSourcePath(path);const entry=asset.files[path];if(!entry)fail(404,'文件不在资源版本中');const bytes=this.archive.read(entry),type=mime[extname(path).toLowerCase()]??'application/octet-stream';
    const download=new URL(req.url,'http://localhost').searchParams.get('download')==='1';
    if(download&&req.method==='GET')res.once('finish',()=>this.analytics.record(assetId,'file_downloads'));
    res.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length,'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'none'; sandbox",...(download||!mime[extname(path).toLowerCase()]?{'Content-Disposition':'attachment'}:{})});res.end(req.method==='HEAD'?undefined:bytes);
  }
  importOperations(user,p,b,input){
    identifier(input.transaction_id,'事务 ID');const branch=this.store.branchFor(user,p,b,true),base=this.store.get('creator_revision',input.base_revision);
    if(!base||base.project_id!==p||!this.store.ancestor(base.id,branch.head)||base.manifest.schema!==NATIVE_SCHEMA)fail(409,'请选择当前原生分支的有效源版本');
    if(!input.version)fail(422,'导入需要固定资产版本');const {asset}=this.detail(input.asset_id,input.version);
    const directory=`assets/market/${asset.id}/${input.transaction_id}`,manifest=base.manifest,ops=[];
    for(const [path,entry]of Object.entries(asset.files)){
      let bytes=this.archive.read(entry);
      if(textExtensions.has(extname(path))){let text=bytes.toString('utf8');text=text.replace(/res:\/\/([^"'\s)\]]+)/g,(full,target)=>{const local=target.replace(/^__ASSET__\//,'');if(!asset.files[local])fail(422,'资源包含未打包的绝对依赖',{path,dependency:target});return `res://${directory}/${local}`;});bytes=Buffer.from(text);}
      const destination=`${directory}/${path}`;if(manifest.source_files[destination])fail(409,'导入目录已存在');ops.push({type:'put_source_file',path:destination,expected_hash:null,data_base64:bytes.toString('base64')});
    }
    const provenance={asset_id:asset.id,version:asset.version,detail_url:asset.detail_url,source_url:asset.source_url,license:asset.license,author:asset.author,files:asset.files,copy_policy:'independent-source-copy'};
    ops.push({type:'put_source_file',path:`${directory}/provenance.json`,expected_hash:null,text:JSON.stringify(provenance,null,2)+'\n'});
    let resource_id=null;
    if(asset.entry_path&&/\.tscn$/.test(asset.entry_path)){
      resource_id=`market-${hash(input.transaction_id).slice(0,20)}`;const catalog=JSON.parse(this.service.native.archive.read(manifest.source_files[NATIVE_CATALOG]));
      catalog.resources[resource_id]={id:resource_id,name:asset.name,kind:'prefab',path:`${directory}/${asset.entry_path}`};
      ops.push({type:'put_source_file',path:NATIVE_CATALOG,expected_hash:manifest.source_files[NATIVE_CATALOG].hash,text:JSON.stringify(catalog,null,2)+'\n'});
    }
    let transaction={transaction_id:input.transaction_id,base_revision:input.base_revision,expected_head:input.base_revision,ops};
    if(ops.length>100){const files=new Map(Object.entries(manifest.source_files).map(([path,entry])=>[path,{path,data_base64:this.service.native.archive.read(entry).toString('base64')}]));for(const op of ops)files.set(op.path,{path:op.path,data_base64:op.data_base64??Buffer.from(op.text).toString('base64')});transaction={...transaction,ops:[{type:'import_native_project',files:[...files.values()]}]};}
    return {transaction,import:{asset_id:asset.id,version:asset.version,resource_id,directory,entry_path:asset.entry_path?`res://${directory}/${asset.entry_path}`:null}};
  }
  async importToProject(user,p,b,input,origin=null){
    const prepared=this.importOperations(user,p,b,input),branch=this.store.branchFor(user,p,b,true);
    const intent=this.analytics.prepare(user,branch,prepared,origin);
    try{const result=await this.service.committed(user,p,b,prepared.transaction,origin);this.analytics.complete(intent);return {result,import:prepared.import};}
    catch(error){this.analytics.complete(intent);this.store.remove('market_import_pending',intent.id);throw error;}
  }
  loadOfficial(){
    const path=resolve(this.service.data,'market/official-install.json');if(!existsSync(path))return;
    const entries=JSON.parse(readFileSync(path,'utf8'));for(const input of entries)this.installOfficial(input);
  }
}
