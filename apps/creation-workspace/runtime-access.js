import {randomUUID} from './client-platform.js';
import {readSaveDomain,serializeSave} from './runtime-storage.js';

export function validateRuntimeAccess(access,jobId){
  const url=new URL(access?.web_url??'',location.origin);
  if(access?.policy!=='wa-runtime-origin-1'||access.build_id!==jobId||access.parent_origin!==location.origin||url.origin!==access.runtime_origin||url.origin===location.origin||!/^\/creation-runtime\/[A-Za-z0-9_-]{43}\/build-[a-f0-9-]+\/launch\.html$/.test(url.pathname)||url.pathname.split('/')[3]!==jobId||typeof access.launch_nonce!=='string'||access.launch_nonce.length<24)throw Error('游戏运行授权与固定构建或隔离地址不一致');
  return url;
}

export function openRuntimePlaceholder(title){
  const popup=window.open('about:blank','_blank');if(!popup)return null;
  // about:blank may copy sessionStorage before opener is removed. Erase only
  // this new window's copy before it can navigate to any author content.
  popup.sessionStorage.clear();popup.opener=null;popup.document.title=title;
  popup.document.body.textContent='正在准备固定游戏…';return popup;
}

function chooseMigration(popup,domain,record){
  return new Promise(resolve=>{
    const doc=popup.document;doc.body.replaceChildren();doc.body.style.cssText='font:16px/1.7 system-ui;padding:36px;background:#10151c;color:#e1e9f1;max-width:720px;margin:auto';
    const title=doc.createElement('h2');title.textContent='此游戏有旧版浏览器存档';
    const note=doc.createElement('p');note.textContent=`游戏现在在隔离空间中运行。已找到 ${record.entries.filter(row=>(row.value.mode&0xf000)===0x8000).length} 个存档文件。迁移会保留旧存档；目标空间已有不同内容时不会覆盖。`;
    doc.body.append(title,note);
    for(const [label,value]of [['迁移存档并打开','migrate'],['在隔离空间打开，保留旧存档','fresh'],['取消','cancel']]){
      const button=doc.createElement('button');button.textContent=label;button.style.cssText='padding:10px 16px;margin:6px 8px 6px 0';button.onclick=()=>{clearInterval(timer);resolve(value);};doc.body.append(button);
    }
    const exportButton=doc.createElement('button');exportButton.textContent='导出旧存档备份';exportButton.style.cssText='padding:10px 16px;margin:6px 8px 6px 0';
    exportButton.onclick=()=>{const url=URL.createObjectURL(new Blob([serializeSave(domain,record.entries)],{type:'application/json'})),anchor=doc.createElement('a');anchor.href=url;anchor.download='world-atelier-save-backup.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60000);};doc.body.append(exportButton);
    const timer=setInterval(()=>{if(popup.closed){clearInterval(timer);resolve('cancel');}},300);
  });
}

function chooseUnknownStorage(popup){
  return new Promise(resolve=>{
    const doc=popup.document;doc.body.replaceChildren();doc.body.style.cssText='font:16px/1.7 system-ui;padding:36px;background:#10151c;color:#e1e9f1;max-width:720px;margin:auto';
    const note=doc.createElement('p');note.textContent='此历史构建缺少可核对的存档目录，无法自动迁移旧版浏览器存档。旧数据仍保留；继续将使用隔离空间内的存档，可能从初始状态开始。';doc.body.append(note);
    const timer=setInterval(()=>{if(popup.closed){clearInterval(timer);resolve(false);}},300);
    for(const [label,value]of [['使用隔离空间继续',true],['取消',false]]){const button=doc.createElement('button');button.textContent=label;button.style.cssText='padding:10px 16px;margin:8px';button.onclick=()=>{clearInterval(timer);resolve(value);};doc.body.append(button);}
  });
}

async function migrate(access,entries){
  const frame=document.createElement('iframe');frame.hidden=true;frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.referrerPolicy='no-referrer';
  const url=validateRuntimeAccess(access,access.build_id);url.searchParams.set('wa_storage_bridge','1');
  const requestId=randomUUID();
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>done(Error('存档迁移超时，原存档仍保留')),30000);
      const done=error=>{clearTimeout(timer);window.removeEventListener('message',listener);error?reject(error):resolve();};
      const listener=event=>{
        const packet=event.data;if(event.source!==frame.contentWindow||event.origin!==access.runtime_origin||packet?.source!=='world-atelier-game'||packet.nonce!==access.launch_nonce)return;
        if(packet.type==='storage_ready')frame.contentWindow.postMessage({source:'world-atelier-workspace',nonce:access.launch_nonce,type:'storage_import',request_id:requestId,packet:{format:'wa-godot-save-transfer-1',prefix:access.storage.prefix,entries}},access.runtime_origin);
        if(packet.type==='storage_imported'&&packet.request_id===requestId)done(packet.error?Error(packet.error):null);
      };
      window.addEventListener('message',listener);frame.src=url.href;document.body.append(frame);
    });
  }finally{frame.remove();}
}

export async function navigateStandaloneRuntime(popup,access,{current=()=>true}={}){
  const url=validateRuntimeAccess(access,access.build_id);
  if(popup.closed||!current())return false;
  const key='wa-runtime-save-choice:'+access.runtime_origin+':'+(access.storage?.prefix??access.build_id);
  if(!access.storage&&!localStorage.getItem(key)){
    if(!await chooseUnknownStorage(popup)||popup.closed||!current())return false;
    localStorage.setItem(key,'unknown-explicit-continue');
  }
  if(access.storage&&!localStorage.getItem(key)){
    const record=await readSaveDomain(access.storage);if(popup.closed||!current())return false;
    if(!record.available)throw Error(record.reason+'。旧存档保留，请通过支持的浏览器导出后再运行。');
    if(record.entries.some(row=>(row.value.mode&0xf000)===0x8000)){
      const choice=await chooseMigration(popup,access.storage,record);if(choice==='cancel'||popup.closed||!current())return false;
      if(choice==='migrate')await migrate(access,record.entries);
      localStorage.setItem(key,choice);
    }
  }
  if(popup.closed||!current())return false;
  popup.location.replace(url.href);return true;
}
