// Godot 4.6/IDBFS storage transfer. This module only handles the fixed save
// prefix supplied by the authenticated launch service, never creator storage.
const MAX_BYTES=64*1024*1024,MAX_ENTRIES=5000;
const validDomain=domain=>domain?.policy==='godot-idbfs-save-domain-1'&&domain.database==='/userfs'&&typeof domain.prefix==='string'&&domain.prefix.startsWith('/userfs/')&&!domain.prefix.split('/').some((p,i)=>i&&(!p||p==='.'||p==='..'));
const directory=value=>(Number(value?.mode)&0xf000)===0x4000;
// Emscripten MEMFS may retain an Int8Array view of its heap when IDBFS flushes
// a file. Interpret every view by its byte range, preserving signed bytes and
// offsets rather than treating the view's elements as new byte values.
const bytesOf=value=>ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):value instanceof ArrayBuffer?new Uint8Array(value):null;
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
          if(!directory(row.value)&&!contents){failure=Error('旧存档文件的字节格式无法识别，原数据已保留');tx.abort();return;}
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

// The compiled game declares one shared non-negative integer. Never enumerate
// localStorage or copy arbitrary files between engines.
function scoreAddress(config){
  const spec=config.score_bridge,domain=spec?.domain;
  if(!['godot','three'].includes(config.web_engine)||spec?.format!=='wa-config-high-score-1'||!validDomain(domain)||
     domain.project_id!==config.project_id||domain.branch_id!==config.branch_id||domain.namespace!==config.project_id+':'+config.branch_id||
     !/^[A-Za-z0-9_-]{1,64}\.cfg$/.test(spec.file)||![spec.section,spec.key].every(k=>typeof k==='string'&&/^[A-Za-z0-9_-]{1,48}$/.test(k)))
    throw Error('成绩声明与固定游戏存档域不匹配');
  const web='wa.three:'+JSON.stringify([domain.project_id,domain.branch_id,domain.namespace])+':'+[spec.file,spec.section,spec.key].join('/');
  return {config,spec,domain,web,file:domain.prefix+'/'+spec.file};
}
function nonnegativeScore(value){
  const number=Number(value);
  if(!/^(?:0|[1-9]\d*)$/.test(String(value))||!Number.isSafeInteger(number))throw Error('成绩格式不受支持，已保留原存档');
  return number;
}
function configScore(row,{section,key},write=null){
  const bytes=bytesOf(row?.contents);
  if(row&&(!bytes||bytes.length>65536||(row.mode&0xf000)!==0x8000))throw Error('成绩文件格式不受支持，已保留原存档');
  const text=bytes?new TextDecoder('utf-8',{fatal:true}).decode(bytes):'';
  const lines=text.split(/(?<=\n)/),end=text.includes('\r\n')?'\r\n':'\n';
  let header=-1,active=false,at=-1,score=0,replace=null;
  for(const [i,line] of lines.entries()){
    if(/^\s*(?:[;#]|$)/.test(line))continue;
    const group=line.match(/^\s*\[([^\]\n\r]+)\]\s*(?:[;#].*)?$/);
    if(group){active=group[1]===section;if(active){if(header!==-1)throw Error('成绩文件包含重复分组');header=i;}continue;}
    // Preserve other simple ConfigFile fields verbatim. Complex serialized
    // Godot variants or multiline values require a game-specific converter.
    const field=line.match(/^\s*([\w.-]+)\s*=\s*(true|false|null|-?\d+(?:\.\d+)?|"(?:[^"\\\r\n]|\\.)*")\s*(?:[;#].*)?$/);
    if(!field)throw Error('成绩文件含有无法无损转换的字段');
    if(active&&field[1]===key){
      if(at!==-1)throw Error('成绩文件包含重复键');
      score=nonnegativeScore(field[2]);at=i;replace=new RegExp('^(\\s*'+key+'\\s*=\\s*)'+field[2]);
    }
  }
  if(write===null)return score;
  if(at!==-1)lines[at]=lines[at].replace(replace,(_,prefix)=>prefix+write);
  else if(header!==-1)lines.splice(header+1,0,(lines[header].endsWith('\n')?'':end)+key+'='+write+end);
  else lines.push((text&&!text.endsWith('\n')?end:'')+'['+section+']'+end+key+'='+write+end);
  return new TextEncoder().encode(lines.join(''));
}
async function godotScore(address,change=null){
  if(!indexedDB.databases)throw Error('浏览器无法核对当前游戏的存档');
  if(!change&&!(await indexedDB.databases()).some(db=>db.name===address.domain.database))return 0;
  const db=await openDatabase(address.domain.database,{create:!!change});
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('FILE_DATA',change?'readwrite':'readonly'),store=tx.objectStore('FILE_DATA');
      let score=0,error;
      const fail=e=>{error=e;tx.abort();};
      const request=store.get(address.file);
      request.onsuccess=()=>{
        try{
          score=configScore(request.result,address.spec);
          if(!change)return;
          if(score!==change.target||nonnegativeScore(localStorage.getItem(address.web)??0)!==change.source)
            throw Error('成绩已变化，请重新核对');
          const contents=configScore(request.result,address.spec,change.source),timestamp=new Date();
          const parts=address.domain.prefix.split('/').slice(1);
          for(let i=1;i<=parts.length;i++){
            const path='/'+parts.slice(0,i).join('/'),dir=store.get(path);
            dir.onsuccess=()=>{if(!dir.result)store.put({mode:0o40777,timestamp},path);else if(!directory(dir.result))fail(Error('存档目录已被文件占用'));};
          }
          store.put({mode:request.result?.mode??0o100666,timestamp,contents},address.file);
        }catch(e){fail(e);}
      };
      tx.oncomplete=()=>resolve(score);tx.onerror=()=>reject(error??tx.error);tx.onabort=()=>reject(error??tx.error??Error('成绩读取中断'));
    });
  }finally{db.close();}
}
export async function scoreTransferOffer(config){
  const address=scoreAddress(config),godot=await godotScore(address),three=nonnegativeScore(localStorage.getItem(address.web)??0);
  const [target,source]=config.web_engine==='godot'?[godot,three]:[three,godot];
  return source>target?{target,source}:null;
}
export async function acceptScoreTransfer(config,offer){
  const address=scoreAddress(config),current=await scoreTransferOffer(config);
  if(!current||current.source!==offer?.source||current.target!==offer?.target)throw Error('成绩已变化，请重新核对');
  if(config.web_engine==='godot')await godotScore(address,current);
  else{
    if(nonnegativeScore(localStorage.getItem(address.web)??0)!==current.target)throw Error('目标成绩已变化，请重新核对');
    localStorage.setItem(address.web,String(current.source));
  }
}

// Both the trusted workspace's legacy migration and the game-origin host's
// score conversion must obtain a concrete choice before changing storage.
export function chooseSaveAction(host,{heading,detail,actions}){
  const doc=host.ownerDocument;
  host.replaceChildren();
  host.style.cssText='font:16px/1.7 system-ui;padding:36px;background:#10151c;color:#e1e9f1;max-width:720px;margin:auto;pointer-events:auto';
  const title=doc.createElement('h2'),note=doc.createElement('p');title.textContent=heading;note.textContent=detail;
  host.append(title,note);
  return new Promise(resolve=>{
    const timer=setInterval(()=>{if(doc.defaultView?.closed||!doc.defaultView){clearInterval(timer);resolve('cancel');}},300);
    for(const {label,value,run} of actions){
      const button=doc.createElement('button');button.textContent=label;button.style.cssText='padding:10px 16px;margin:6px 8px 6px 0';
      button.onclick=()=>{if(run){run();return;}clearInterval(timer);resolve(value);};host.append(button);
    }
  });
}
