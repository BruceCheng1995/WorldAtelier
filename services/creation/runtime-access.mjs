import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fail,hash} from './schema.mjs';

export const RUNTIME_ACCESS_POLICY='wa-runtime-origin-1';
const KIND='creator_runtime_access',TTL=10*60*1000,MAX_AGE=12*60*60*1000;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'});res.end(JSON.stringify(value));};
const escapeJson=value=>JSON.stringify(value).replace(/</g,'\\u003c');
const safeName=(value,paths=false)=>{
  let result=String(value??'').trim();
  if(paths)result=result.replaceAll('\\','/').replaceAll('//','/').replaceAll('..','-');
  else {if(result==='.')result='dot';if(result==='..')result='twodots';result=result.replace(/[\/\\]/g,'-');}
  return result.replace(/[:*?"<>|]/g,'-').replace(/\.+$/,'');
};
const scalarWithoutComment=text=>{
  let quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const char=text[i];if(escaped){escaped=false;continue;}if(quoted&&char==='\\'){escaped=true;continue;}if(char==='"')quoted=!quoted;
    if(!quoted&&(char===';'||char==='#'))return text.slice(0,i).trim();
  }
  return text.trim();
};

/** Resolve only this fixed build's actual Godot save prefix, never arbitrary
 * paths supplied by a game or a caller. Old source/artifact bytes stay intact. */
export function runtimeSaveDomain(builds,job){
  try{
    const entry=job.source_files?.find(file=>file.path==='project.godot');if(!entry)return null;
    const bytes=readFileSync(join(builds.directory,job.id,'project','project.godot'));if(hash(bytes)!==entry.sha256)return null;
    let section='',values={};
    for(const raw of bytes.toString('utf8').split(/\r?\n/)){
      const line=scalarWithoutComment(raw);
      const heading=/^\s*\[([^\]]+)\]\s*$/.exec(line);if(heading){section=heading[1];continue;}
      const field=/^\s*(config\/(?:name|use_custom_user_dir|custom_user_dir_name))\s*=\s*(.+?)\s*$/.exec(line);
      if(section==='application'&&field){try{values[field[1]]=JSON.parse(scalarWithoutComment(field[2]));}catch{return null;}}
    }
    const name=safeName(values['config/name']),custom=values['config/use_custom_user_dir']===true;
    const suffix=name?(custom?(safeName(values['config/custom_user_dir_name'],true)||name):'godot/app_userdata/'+name):'godot/app_userdata/[unnamed project]';
    if(suffix.startsWith('/')||suffix.split('/').some(v=>!v||v==='.'||v==='..'))return null;
    return {policy:'godot-idbfs-save-domain-1',database:'/userfs',prefix:'/userfs/'+suffix,namespace:job.storage?.namespace??job.project_name,project_id:job.project_id,branch_id:job.branch_id};
  }catch{return null;}
}

export class RuntimeAccess {
  constructor({service,network}){this.service=service;this.store=service.store;this.network=network;}
  issue(user,job,req){
    if(!this.network?.runtimeOriginFor)fail(503,'隔离运行地址尚未配置');
    if(job.purpose==='native_preview')fail(400,'静态编辑预览不使用作者游戏运行授权');
    if(!job.web_files?.length||!['completed','partial'].includes(job.status))fail(409,'此任务没有就绪的 Web 版本');
    const workspaceOrigin=this.network.requestOrigin(req),runtimeOrigin=this.network.runtimeOriginFor(req);
    if(!workspaceOrigin||runtimeOrigin===workspaceOrigin)fail(403,'作者游戏必须使用隔离运行地址');
    if(new URL(runtimeOrigin).hostname.startsWith('[')&&job.web_compatibility?.ipv4_mapped_ipv6!==true)fail(422,'此固定历史构建不支持隔离的局域网 HTTP。可在服务器本机试玩，或由创作者显式发布支持隔离地址的新构建。历史文件未改写。',{code:'runtime_lan_build_incompatible'});
    const token=randomBytes(32).toString('base64url'),nonce=randomBytes(24).toString('base64url'),created=Date.now();
    const loginToken=String(req.headers.authorization??'').replace(/^Bearer /,'');
    const login=this.store.authenticate(loginToken);if(login.id!==user.id)fail(403,'运行授权必须绑定当前登录');
    const record={id:hash(token),job_id:job.id,user_id:user.id,login_id:hash(loginToken),project_id:job.project_id,branch_id:job.branch_id,source_revision:job.source_revision,canonical_identity:job.canonical_identity??null,purpose:job.purpose??'application',workspace_origin:workspaceOrigin,runtime_origin:runtimeOrigin,launch_nonce:nonce,created_at:created,expires_at:created+TTL,maximum_at:created+MAX_AGE,storage:runtimeSaveDomain(this.service.builds,job)};
    this.store.put(KIND,record);
    return {policy:RUNTIME_ACCESS_POLICY,web_url:`${runtimeOrigin}/creation-runtime/${token}/${job.id}/launch.html`,runtime_origin:runtimeOrigin,parent_origin:workspaceOrigin,launch_nonce:nonce,build_id:job.id,expires_at:record.expires_at,storage:record.storage,storage_status:record.storage?'verified':'unavailable',legacy_save_origin:workspaceOrigin};
  }
  authorize(token,req){
    if(!TOKEN.test(token))fail(403,'运行授权无效');
    const grant=this.store.get(KIND,hash(token));
    if(!grant||grant.expires_at<=Date.now()||grant.maximum_at<=Date.now())fail(403,'试玩访问已过期，请从工作台重新打开');
    const origin=this.network.runtimeRequestOrigin(req);
    if(!origin||origin!==grant.runtime_origin)fail(403,'运行授权与当前地址不一致');
    if(grant.login_id){const login=this.store.get('creator_login',grant.login_id);if(!login||login.user_id!==grant.user_id||login.expires_at<=Date.now())fail(403,'登录已失效，请从工作台重新打开');}
    const job=this.service.builds.forUser({id:grant.user_id},grant.job_id);
    if(job.project_id!==grant.project_id||job.branch_id!==grant.branch_id||job.source_revision!==grant.source_revision||(job.canonical_identity??null)!==grant.canonical_identity||job.purpose==='native_preview')fail(409,'运行授权的固定构建已变化');
    return {grant,job};
  }
  request(req,res){
    const origin=this.network.runtimeRequestOrigin(req);if(!origin)return false;
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('X-Content-Type-Options','nosniff');
    const url=new URL(req.url,origin);
    if(url.pathname==='/creation-runtime/health'&&req.method==='GET'){json(res,200,{ok:true,policy:RUNTIME_ACCESS_POLICY,role:'runtime'});return true;}
    const match=/^\/creation-runtime\/([A-Za-z0-9_-]{43})\/(build-[a-f0-9-]+)\/(launch\.html|host\.js|storage\.js|renew|web\/[\w.-]+)$/.exec(url.pathname);
    if(!match)fail(403,'运行地址仅提供已授权的固定游戏资源');
    const {grant,job}=this.authorize(match[1],req);if(job.id!==match[2])fail(403,'运行授权不属于此构建');
    const asset=match[3];
    if(asset==='renew'){
      if(req.method!=='POST'||req.headers.origin!==origin)fail(403,'运行授权续期来源无效');
      grant.expires_at=Math.min(grant.maximum_at,Date.now()+TTL);this.store.put(KIND,grant);json(res,200,{expires_at:grant.expires_at});return true;
    }
    if(!['GET','HEAD'].includes(req.method))fail(405,'运行资源只允许读取');
    const base=url.pathname.slice(0,url.pathname.lastIndexOf('/')+1);
    if(asset==='launch.html'){
      const configuration={policy:RUNTIME_ACCESS_POLICY,job_id:job.id,project_id:job.project_id,branch_id:job.branch_id,source_revision:job.source_revision,canonical_identity:job.canonical_identity??null,runtime_source_hash:job.runtime_source_hash??null,resource_id:job.entry_scene_id,purpose:job.purpose??'application',parent_origin:grant.workspace_origin,runtime_origin:origin,launch_nonce:grant.launch_nonce,storage:grant.storage,base};
      const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>世界工坊 · 游戏</title><style>html,body,#game{margin:0;width:100%;height:100%;border:0;background:#10151c;color:#dae5ef}body{overflow:hidden;font:14px system-ui}#status{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}#status:empty{display:none}</style><body><div id="status">正在载入固定游戏…</div><script id="runtime-config" type="application/json">${escapeJson(configuration)}</script><script type="module" src="host.js"></script></body></html>`;
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self' ${grant.workspace_origin}; base-uri 'none'; form-action 'none'`});res.end(req.method==='HEAD'?undefined:html);return true;
    }
    if(['host.js','storage.js'].includes(asset)){
      const path=join(this.service.root,'apps/creation-workspace',asset==='host.js'?'runtime-host.js':'runtime-storage.js');
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'private, no-store'});res.end(req.method==='HEAD'?undefined:readFileSync(path));return true;
    }
    const filename=asset.slice(4),entry=job.web_files.find(file=>file.path===filename);if(!entry)fail(404,'文件不在固定发行清单中');
    const type={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',wasm:'application/wasm',png:'image/png',json:'application/json'}[filename.split('.').at(-1)]??'application/octet-stream';
    if(filename.endsWith('.html'))res.setHeader('Content-Security-Policy',`frame-ancestors 'self' ${grant.workspace_origin}; base-uri 'self'; form-action 'none'`);
    this.service.builds.stream(req,res,join(this.service.builds.directory,job.id,'web',filename),entry,type);return true;
  }
}
