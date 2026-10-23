// Godot 4.6/IDBFS storage transfer. This module only handles the fixed save
// prefix supplied by the authenticated launch service, never creator storage.
const MAX_BYTES=64*1024*1024,MAX_ENTRIES=5000;
const validDomain=domain=>domain?.policy==='godot-idbfs-save-domain-1'&&domain.database==='/userfs'&&typeof domain.prefix==='string'&&domain.prefix.startsWith('/userfs/')&&!domain.prefix.split('/').some((p,i)=>i&&(!p||p==='.'||p==='..'));
const directory=value=>(Number(value?.mode)&0xf000)===0x4000;
const bytesOf=value=>value instanceof Uint8Array?value:value instanceof ArrayBuffer?new Uint8Array(value):null;
const inScope=(key,value,prefix)=>typeof key==='string'&&(key===prefix||key.startsWith(prefix+'/')||directory(value)&&prefix.startsWith(key+'/'))&&key.startsWith('/userfs')&&!key.includes('\0')&&!key.includes('\\')&&!key.split('/').some((p,i)=>i&&(p==='.'||p==='..'||!p));
function openDatabase(name,{create=false}={}){
  return new Promise((resolve,reject)=>{
    const request=create?indexedDB.open(name,21):indexedDB.open(name);
    request.onerror=()=>reject(request.error??Error('无法读取浏览器存档'));
    request.onblocked=()=>reject(Error('存档被另一个页面占用，请关闭旧游戏后重试'));
    request.onupgradeneeded=()=>{
      if(!create){request.transaction.abort();return;}
      if(!request.result.objectStoreNames.contains('FILE_DATA'))request.result.createObjectStore('FILE_DATA').createIndex('timestamp','timestamp',{unique:false});
    };
    request.onsuccess=()=>resolve(request.result);
  });
}
export async function readSaveDomain(domain){
  if(!validDomain(domain))return {available:false,reason:'无法确认此固定版本的存档目录',entries:[]};
  if(!globalThis.indexedDB?.databases)return {available:false,reason:'当前浏览器不支持存档目录检查',entries:[]};
  if(!(await indexedDB.databases()).some(item=>item.name===domain.database))return {available:true,entries:[],bytes:0};
  const db=await openDatabase(domain.database);
  try{
    if(!db.objectStoreNames.contains('FILE_DATA'))throw Error('旧存档格式无法识别，原数据已保留');
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('FILE_DATA','readonly'),entries=[];let bytes=0,failure=null;
      const cursor=tx.objectStore('FILE_DATA').openCursor();
      cursor.onsuccess=()=>{
        const row=cursor.result;if(!row)return;
        if(inScope(row.key,row.value,domain.prefix)){
          const contents=bytesOf(row.value.contents);bytes+=contents?.byteLength??0;
          if(entries.length>=MAX_ENTRIES||bytes>MAX_BYTES){failure=Error('存档超过迁移上限，原存档未改变');tx.abort();return;}
          entries.push({key:row.key,value:{mode:row.value.mode,timestamp:row.value.timestamp,...(contents?{contents:contents.slice()}: {})}});
        }
        row.continue();
      };
      tx.oncomplete=()=>resolve({available:true,entries,bytes});tx.onerror=()=>reject(tx.error??failure??Error('读取存档失败'));tx.onabort=()=>reject(failure??tx.error??Error('读取存档中断'));
    });
  }finally{db.close();}
}
export async function importSaveDomain(domain,packet){
  if(!validDomain(domain)||packet?.format!=='wa-godot-save-transfer-1'||packet.prefix!==domain.prefix||!Array.isArray(packet.entries)||packet.entries.length>MAX_ENTRIES)throw Error('存档与此游戏的固定存储域不一致');
  const keys=new Set();let bytes=0;
  const entries=packet.entries.map(row=>{
    if(!row||keys.has(row.key)||!inScope(row.key,row.value,domain.prefix))throw Error('存档包含越界或重复路径');keys.add(row.key);
    const mode=Number(row.value?.mode),isDirectory=directory(row.value),contents=bytesOf(row.value?.contents),timestamp=new Date(row.value?.timestamp);
    if(!Number.isInteger(mode)||mode<0||mode>0xffff||(!isDirectory&&(mode&0xf000)!==0x8000)||!Number.isFinite(timestamp.getTime())||(!isDirectory&&!contents)||(isDirectory&&contents?.length))throw Error('存档记录无效');
    bytes+=contents?.length??0;if(bytes>MAX_BYTES)throw Error('存档超过迁移上限');
    return {key:row.key,value:{mode,timestamp,...(isDirectory?{}:{contents:contents.slice()})}};
  });
  const db=await openDatabase(domain.database,{create:true});
  try{
    if(!db.objectStoreNames.contains('FILE_DATA'))throw Error('目标存档格式无法识别');
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('FILE_DATA','readwrite'),store=tx.objectStore('FILE_DATA');let inserted=0,existing=0,failure=null;
      for(const row of entries){
        const request=store.get(row.key);
        request.onsuccess=()=>{
          if(failure)return;
          const prior=request.result;
          if(prior){
            const a=bytesOf(prior.contents),b=bytesOf(row.value.contents);
            const same=directory(prior)&&directory(row.value)||prior.mode===row.value.mode&&a&&b&&a.length===b.length&&a.every((byte,i)=>byte===b[i]);
            if(!same){failure=Error('隔离空间已有不同存档，未覆盖任何文件。请先导出并明确选择存档。');tx.abort();return;}
            existing++;
          }else{store.put(row.value,row.key);inserted++;}
        };
      }
      tx.oncomplete=()=>resolve({imported:inserted,already_present:existing,bytes});tx.onerror=()=>reject(failure??tx.error??Error('存档迁移失败'));tx.onabort=()=>reject(failure??tx.error??Error('存档迁移中断'));
    });
  }finally{db.close();}
}
export function serializeSave(domain,entries){
  return JSON.stringify({format:'wa-godot-save-export-1',prefix:domain.prefix,project_id:domain.project_id,branch_id:domain.branch_id,created_at:new Date().toISOString(),entries:entries.map(row=>{
    const bytes=bytesOf(row.value.contents);let encoded='';if(bytes)for(let i=0;i<bytes.length;i+=0x6000)encoded+=String.fromCharCode(...bytes.subarray(i,i+0x6000));
    return {key:row.key,value:{mode:row.value.mode,timestamp:row.value.timestamp,...(bytes?{base64:btoa(encoded)}:{})}};
  })},null,2);
}
