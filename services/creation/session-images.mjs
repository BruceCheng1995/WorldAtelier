import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fail,hash,id} from './schema.mjs';
import {inspectImage} from './project-media.mjs';
import {writeWorkspaceFile} from './environments.mjs';

export const MAX_IMAGE_BYTES=5*1024*1024,MAX_SESSION_IMAGES=8;
export class SessionImages {
  constructor({store,data}){this.store=store;this.directory=resolve(data,'session-images');mkdirSync(this.directory,{recursive:true,mode:0o700});}
  attach(user,sid,{bytes,mime,name}){
    const session=this.store.sessionFor(user,sid,true);
    if(session.draft_attachments.filter(a=>a.kind==='image').length>=MAX_SESSION_IMAGES)fail(422,'每条消息最多附加 8 张图片');
    if(!Buffer.isBuffer(bytes)||bytes.length>MAX_IMAGE_BYTES)fail(413,'图片不能超过 5 MB');
    const image=inspectImage({data_url:`data:${mime};base64,${bytes.toString('base64')}`}),sha256=hash(bytes);
    const filename=resolve(this.directory,sha256);
    if(!existsSync(filename))writeFileSync(filename,bytes,{flag:'wx',mode:0o600});
    const attachment={id:id('attachment'),kind:'image',role:'reference',session_id:sid,project_id:session.project_id,branch_id:session.branch_id,name:String(name||'图片').replace(/[\x00-\x1f]/g,'').slice(0,160)||'图片',mime:image.mime,width:image.width,height:image.height,bytes:bytes.length,sha256,captured_at:Date.now()};
    session.draft_attachments.push(attachment);session.updated_at=Date.now();this.store.put('creator_session',session);return attachment;
  }
  find(user,sid,attachmentId){
    const session=this.store.sessionView(user,sid);
    const attachment=[...session.draft_attachments,...session.messages.flatMap(m=>m.attachments??[])].find(a=>a.id===attachmentId&&a.kind==='image');
    if(!attachment)fail(404,'图片附件不存在');return attachment;
  }
  bytes(attachment){
    if(!/^[a-f0-9]{64}$/.test(attachment.sha256??''))fail(422,'图片附件摘要无效');
    const bytes=readFileSync(resolve(this.directory,attachment.sha256));
    if(bytes.length!==attachment.bytes||hash(bytes)!==attachment.sha256)fail(409,'图片附件完整性校验失败');return bytes;
  }
  download(user,sid,attachmentId,req,res){
    const attachment=this.find(user,sid,attachmentId),bytes=this.bytes(attachment);
    res.writeHead(200,{'Content-Type':attachment.mime,'Content-Length':bytes.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
  }
  materialize(user,sid,attachments,cwd){
    this.store.sessionFor(user,sid,true);
    return attachments.filter(a=>a.kind==='image').map(a=>{
      const saved=this.find(user,sid,a.id);if(saved.sha256!==a.sha256)fail(409,'图片附件已变化');
      const file=`context/images/${saved.sha256}.${saved.mime==='image/jpeg'?'jpg':saved.mime.slice(6)}`;
      writeWorkspaceFile(cwd,file,this.bytes(saved));return {id:saved.id,name:saved.name,path:resolve(cwd,file)};
    });
  }
}
