import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail, hash } from './schema.mjs';

const MAX_BYTES=5*1024*1024;
export const emptyPresentation=()=>({version:0,cover_id:null,images:[],auto_update:true,auto_image_id:null,last_auto_at:null});
export const presentationOf=value=>({...emptyPresentation(),...value,auto_update:value?.auto_update??!value?.images?.length});

// Restrict public-facing artwork to raster formats with bounded dimensions.
export function inspectImage(image){
  const match=typeof image?.data_url==='string'&&/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.data_url);
  if(!match)fail(422,'请选择 PNG、JPEG 或 WebP 图片');
  if(match[2].length>Math.ceil(MAX_BYTES/3)*4)fail(413,'图片不能超过 5 MB');
  const bytes=Buffer.from(match[2],'base64'),mime=`image/${match[1]}`;
  if(bytes.length>MAX_BYTES)fail(413,'图片不能超过 5 MB');
  if(bytes.toString('base64')!==match[2])fail(422,'图片编码无效');
  let width=0,height=0;
  if(match[1]==='png'&&bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND'){
    let offset=8,hasData=false,ended=false;
    while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);if(offset+12+length>bytes.length)fail(422,'PNG 图片不完整');if(type==='IDAT'&&length>0)hasData=true;if(type==='IEND'){ended=length===0&&offset+12===bytes.length;break;}offset+=12+length;}
    if(!hasData||!ended)fail(422,'PNG 图片缺少像素数据');
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
  }else if(match[1]==='jpeg'&&bytes.length>20&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217){
    let offset=2;while(offset+4<bytes.length){
      if(bytes[offset++]!==255)break;while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===218||marker===217)break;
      if(marker===1||marker>=208&&marker<=215)continue;
      const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8){height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;}offset+=length;
    }
  }else if(match[1]==='webp'&&bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)===bytes.length-8){
    const type=bytes.toString('ascii',12,16);
    if(type==='VP8X'){width=bytes.readUIntLE(24,3)+1;height=bytes.readUIntLE(27,3)+1;}
    else if(type==='VP8 '&&bytes[23]===157&&bytes[24]===1&&bytes[25]===42){width=bytes.readUInt16LE(26)&16383;height=bytes.readUInt16LE(28)&16383;}
    else if(type==='VP8L'&&bytes[20]===47){const bits=bytes.readUInt32LE(21);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;}
  }
  if(!width||!height||width>8192||height>8192||width*height>32000000)fail(422,'图片文件无效，或尺寸超过 8192 像素 / 3200 万像素');
  return {bytes,mime,width,height};
}

export class ProjectMedia {
  constructor({store,data}){this.store=store;this.directory=resolve(data,'project-media');mkdirSync(this.directory,{recursive:true});}
  update(user,p,b,input){
    this.store.projectFor(user,p,true);if(b)this.store.branchFor(user,p,b,true);
    if(!input||!Number.isSafeInteger(input.expected_version))fail(400,'需要封面资料版本');
    const candidate=input.image?inspectImage(input.image):null;
    return this.store.transaction(()=>{
      const target=b?this.store.branchFor(user,p,b,true):this.store.projectFor(user,p,true);
      const current=presentationOf(target.presentation);
      if(input.expected_version!==current.version)fail(409,'封面资料已被其他协作者更新，请刷新后重试');
      const next=structuredClone(current);
      if(input.image||input.remove_image_id||Object.hasOwn(input,'cover_id'))next.auto_update=false;
      if(Object.hasOwn(input,'auto_update')){
        if(typeof input.auto_update!=='boolean')fail(400,'自动更新设置必须为布尔值');
        if(input.image||input.remove_image_id||Object.hasOwn(input,'cover_id'))fail(400,'请单独修改自动更新设置');
        next.auto_update=input.auto_update;
      }
      if(input.remove_image_id){
        if(!next.images.some(i=>i.id===input.remove_image_id))fail(404,'截图已不存在');
        next.images=next.images.filter(i=>i.id!==input.remove_image_id);
        if(next.cover_id===input.remove_image_id)next.cover_id=next.images[0]?.id??null;
      }
      if(candidate){
        const imageId=hash(candidate.bytes);
        if(!next.images.some(i=>i.id===imageId)){
          if(next.images.length>=8)fail(422,'最多保存 8 张图片，请先移除不需要的截图');
          const filename=resolve(this.directory,imageId);
          if(!existsSync(filename))writeFileSync(filename,candidate.bytes,{flag:'wx'});
          const item={id:imageId,project_id:p,mime:candidate.mime,width:candidate.width,height:candidate.height,name:String(input.image.name??'游戏截图').slice(0,160),created_at:Date.now(),url:`/creation-api/projects/${encodeURIComponent(p)}/media/${imageId}`};
          this.store.put('creator_project_media',{...item,id:`${p}:${imageId}`,image_id:imageId});
          next.images.push(item);if(!next.cover_id)next.cover_id=imageId;
        }
      }
      if(Object.hasOwn(input,'cover_id')){
        if(input.cover_id!==null&&!next.images.some(i=>i.id===input.cover_id))fail(422,'头图必须来自当前截图集');
        next.cover_id=input.cover_id;
      }
      next.version++;target.presentation=next;
      this.store.put(b?'creator_branch':'creator_project',target);
      return {presentation:next};
    });
  }
  capture(user,p,b,input){
    this.store.branchFor(user,p,b,true);
    if(!Number.isSafeInteger(input.expected_version)||!Number.isSafeInteger(input.expected_project_version))fail(400,'缺少封面基线版本');
    if(!['edit','play'].includes(input.mode)||!input.resource_id||!input.source_revision||!/^[a-f0-9]{64}$/.test(input.runtime_build_id??''))fail(422,'缺少当前游戏画面上下文');
    const candidate=inspectImage(input.image),removed=[];
    const result=this.store.transaction(()=>{
      const branch=this.store.branchFor(user,p,b,true),project=this.store.projectFor(user,p,true);
      if(branch.head!==input.source_revision)fail(409,'游戏已修改，等待新画面后重新截图');
      const manifest=this.store.get('creator_revision',branch.head)?.manifest;
      if(manifest?.resources[input.resource_id]?.kind!=='scene')fail(422,'只有当前游戏场景可以更新封面');
      const branchMedia=presentationOf(branch.presentation),projectMedia=presentationOf(project.presentation);
      const targets=[];
      if(branchMedia.auto_update){if(branchMedia.version!==input.expected_version)fail(409,'分支封面已更新');targets.push([branch,'creator_branch',branchMedia]);}
      if(b==='main'&&projectMedia.auto_update){if(projectMedia.version!==input.expected_project_version)fail(409,'游戏头图已更新');targets.push([project,'creator_project',projectMedia]);}
      if(!targets.length)fail(409,'已使用手动封面，自动更新已关闭');
      // One replaceable automatic image per scope. Periodic captures never grow the gallery.
      const imageId=hash(candidate.bytes),filename=resolve(this.directory,imageId),now=Date.now();
      const item={id:imageId,project_id:p,mime:candidate.mime,width:candidate.width,height:candidate.height,name:'当前游戏画面',created_at:now,url:`/creation-api/projects/${encodeURIComponent(p)}/media/${imageId}`,source:'automatic',source_revision:branch.head,branch_id:b,resource_id:input.resource_id,runtime_build_id:input.runtime_build_id,mode:input.mode};
      for(const [target,kind,media]of targets){
        const images=media.images.filter(i=>i.id!==media.auto_image_id&&i.id!==imageId);
        if(images.length>=8)fail(422,'截图集已满，请移除一张截图再恢复自动更新');
        target.presentation={...media,version:media.version+1,auto_image_id:imageId,cover_id:imageId,last_auto_at:now,images:[item,...images]};
        this.store.put(kind,target);
      }
      if(!existsSync(filename))writeFileSync(filename,candidate.bytes,{flag:'wx'});
      this.store.put('creator_project_media',{...item,id:`${p}:${imageId}`,image_id:imageId});
      // Remove only superseded automatic blobs without any remaining project/branch references.
      const oldIds=new Set(targets.map(([, ,media])=>media.auto_image_id).filter(i=>i&&i!==imageId));
      const references=[project.presentation,...this.store.list('creator_branch').filter(x=>x.project_id===p).map(x=>x.presentation)];
      for(const oldId of oldIds)if(!references.some(v=>v?.images.some(i=>i.id===oldId))){this.store.remove('creator_project_media',`${p}:${oldId}`);removed.push(oldId);}
      return {presentation:presentationOf(branch.presentation),project_presentation:presentationOf(project.presentation),captured_at:now};
    });
    for(const imageId of removed)if(!this.store.list('creator_project_media').some(item=>item.image_id===imageId)){try{unlinkSync(resolve(this.directory,imageId));}catch{}}
    return result;
  }
  captureManual(user,p,b,input){
    this.store.branchFor(user,p,b,true);
    if(!['project','branch','both'].includes(input.scope))fail(400,'请选择封面保存范围');
    if(!Number.isSafeInteger(input.expected_version)||!Number.isSafeInteger(input.expected_project_version))fail(400,'缺少封面基线版本');
    if(!['edit','play','inspect'].includes(input.mode)||!input.resource_id||!input.source_revision||!/^[a-f0-9]{64}$/.test(input.runtime_build_id??''))fail(422,'缺少当前游戏画面上下文');
    if(input.scene_generation!==undefined&&(!Number.isSafeInteger(input.scene_generation)||input.scene_generation<0))fail(422,'游戏场景代次无效');
    const candidate=inspectImage(input.image);
    return this.store.transaction(()=>{
      const branch=this.store.branchFor(user,p,b,true),project=this.store.projectFor(user,p,true),revision=this.store.get('creator_revision',input.source_revision);
      if(revision?.project_id!==p||!this.store.ancestor(input.source_revision,branch.head))fail(409,'截图来源已不属于当前分支，请重新拍摄');
      if(revision.manifest?.resources[input.resource_id]?.kind!=='scene'||revision.manifest.resources[input.resource_id].purpose==='prefab_test')fail(422,'只有游戏场景可以拍摄封面');
      const targets=[];
      if(input.scope!=='project')targets.push([branch,'creator_branch',presentationOf(branch.presentation),input.expected_version]);
      if(input.scope!=='branch')targets.push([project,'creator_project',presentationOf(project.presentation),input.expected_project_version]);
      const imageId=hash(candidate.bytes),now=Date.now(),filename=resolve(this.directory,imageId);
      const item={id:imageId,project_id:p,mime:candidate.mime,width:candidate.width,height:candidate.height,name:String(input.image.name??'手动拍摄').slice(0,160),created_at:now,url:`/creation-api/projects/${encodeURIComponent(p)}/media/${imageId}`,source:'manual',source_revision:input.source_revision,branch_id:b,resource_id:input.resource_id,runtime_build_id:input.runtime_build_id,mode:input.mode,...(input.scene_generation!==undefined?{scene_generation:input.scene_generation}:{})};
      for(const [target,kind,media,expected]of targets){
        if(media.version!==expected)fail(409,'封面资料已更新，请重试保存');
        const images=media.images.filter(i=>i.id!==imageId);
        if(images.length>=8)fail(422,'截图集已满，请在封面管理中移除一张图片后重新拍摄');
        target.presentation={...media,version:media.version+1,auto_update:false,auto_image_id:media.auto_image_id===imageId?null:media.auto_image_id,cover_id:imageId,images:[item,...images]};
        this.store.put(kind,target);
      }
      if(!existsSync(filename))writeFileSync(filename,candidate.bytes,{flag:'wx'});
      this.store.put('creator_project_media',{...item,id:`${p}:${imageId}`,image_id:imageId});
      return {presentation:presentationOf(branch.presentation),project_presentation:presentationOf(project.presentation),captured_at:now};
    });
  }
  download(user,p,imageId,req,res){
    this.store.projectFor(user,p);
    if(!/^[a-f0-9]{64}$/.test(imageId))fail(404,'图片不存在');
    const item=this.store.get('creator_project_media',`${p}:${imageId}`);
    if(!item)fail(404,'图片不存在');
    const presentations=[this.store.projectFor(user,p).presentation,...this.store.list('creator_branch').filter(b=>b.project_id===p).map(b=>b.presentation)];
    if(!presentations.some(value=>value?.images.some(image=>image.id===imageId)))fail(404,'图片已从截图集移除');
    const bytes=readFileSync(resolve(this.directory,imageId));
    res.writeHead(200,{'Content-Type':item.mime,'Content-Length':bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
  }
}
