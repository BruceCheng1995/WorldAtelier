import {lstat, readdir, statfs} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fail} from './schema.mjs';

/** Bounded filesystem snapshots; never follow symlinks or delete stored content. */
export class AdminMarket {
  constructor(admin){this.admin=admin;this.store=admin.store;this.market=admin.service.market;this.storage={status:'pending',sampled_at:null};}
  rows(){
    const versions=this.store.list('market_version');
    return this.store.list('market_asset').map(a=>({id:a.id,name:a.name,publisher:a.publisher,publisher_name:a.publisher_name,category:a.category,dimension:a.dimension,license:a.license,author:a.author,
      status:a.hidden_at?'unlisted':'listed',version:a.admin_version??1,asset_version:a.version,created_at:a.created_at,updated_at:a.updated_at,hidden_at:a.hidden_at??null,
      total_bytes:Object.values(a.files).reduce((n,f)=>n+f.size,0),file_count:Object.keys(a.files).length,version_count:versions.filter(v=>v.asset_id===a.id).length,
      detail_url:`/market/assets/${encodeURIComponent(a.id)}`,metrics:this.market.analytics.stats(a.id),storage:this.storage.assets?.[a.id]??null}));
  }
  summary(rows){return {total:rows.length,listed:rows.filter(a=>a.status==='listed').length,unlisted:rows.filter(a=>a.status==='unlisted').length,
    downloads:rows.reduce((n,a)=>n+a.metrics.downloads,0),views_7d:rows.reduce((n,a)=>n+a.metrics.views_7d,0),imports_7d:rows.reduce((n,a)=>n+a.metrics.imports_7d,0),
    started_at:this.store.get('market_analytics_meta','singleton')?.started_at,window:'UTC today and previous 6 days',heat_formula:'views_7d + 5 * imports_7d'};}
  change(user,aid,input){
    if(!input||Object.keys(input).some(k=>!['request_id','expected_version','reason','status'].includes(k)))fail(400,'不支持的管理参数');
    return this.admin.mutate(user,'market.status',aid,input,()=>{
      const row=this.store.get('market_asset',aid);if(!row)fail(404,'市场资源不存在');this.admin.version(row,input);
      if(!['listed','unlisted'].includes(input.status))fail(400,'资源上下架状态无效');
      const before={status:row.hidden_at?'unlisted':'listed',asset_version:row.version};
      row.hidden_at=input.status==='unlisted'?Date.now():null;row.admin_version=(row.admin_version??1)+1;this.store.put('market_asset',row);
      return {target_name:row.name,before,after:{status:input.status,asset_version:row.version},version:row.admin_version};
    });
  }
  async scan({force=false}={}){
    if(this.scanning)return this.scanning;
    if(!force&&this.storage.sampled_at&&Date.now()-this.storage.sampled_at<60000)return this.storage;
    this.scanning=this.scanOnce().finally(()=>{this.scanning=null;});return this.scanning;
  }
  async scanOnce(){
    const started=Date.now(),objects=new Map(),seen=new Set();let visited=0;
    const sections=[];
    for(const [key,name,path] of [['market','市场原件与历史版本',resolve(this.admin.service.data,'market')],['native','游戏原生源文件',this.admin.service.native?.archive?.directory??resolve(this.admin.service.data,'native-source/objects')],['assets','模型与脚本',resolve(this.admin.service.data,'assets')]]){
      let bytes=0,allocated_bytes=0,files=0,complete=true;const stack=[path];
      while(stack.length){
        if(Date.now()-started>6000||visited++>100000){complete=false;break;}
        const file=stack.pop();
        try{
          const stat=await lstat(file);
          if(stat.isSymbolicLink()){complete=false;continue;}
          if(stat.isDirectory()){for(const child of await readdir(file))stack.push(resolve(file,child));continue;}
          if(!stat.isFile())continue;
          const allocated=Number.isFinite(stat.blocks)?stat.blocks*512:null;
          if(key==='market'&&/\/objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(file))objects.set(file.split('/').at(-1),{bytes:stat.size,allocated_bytes:allocated});
          const inode=`${stat.dev}:${stat.ino}`;if(seen.has(inode))continue;seen.add(inode);
          bytes+=stat.size;if(allocated===null)allocated_bytes=null;else if(allocated_bytes!==null)allocated_bytes+=allocated;files++;
        }catch(error){if(!(file===path&&error.code==='ENOENT'))complete=false;}
      }
      sections.push({key,name,bytes,allocated_bytes,files,complete});
    }
    const marketComplete=sections[0].complete,assets={},all=new Set(),current=new Set();
    const sum=hashes=>{let bytes=0,allocated_bytes=0,missing_files=0;for(const digest of hashes){const o=objects.get(digest);if(!o){missing_files++;continue;}bytes+=o.bytes;if(o.allocated_bytes===null)allocated_bytes=null;else if(allocated_bytes!==null)allocated_bytes+=o.allocated_bytes;}return {bytes,allocated_bytes,missing_files:marketComplete?missing_files:null,complete:marketComplete};};
    const versions=this.store.list('market_version');
    for(const a of this.store.list('market_asset')){
      const hashes=new Set(Object.values(a.files).map(f=>f.hash));for(const h of hashes)current.add(h);
      const history=new Set(versions.filter(v=>v.asset_id===a.id).flatMap(v=>Object.values(v.files).map(f=>f.hash)));
      for(const h of hashes)history.add(h);for(const h of history)all.add(h);
      assets[a.id]={current:sum(hashes),all_versions:sum(history)};
    }
    let disk=null;try{const s=await statfs(this.admin.service.data);disk={total_bytes:s.blocks*s.bsize,available_bytes:s.bavail*s.bsize,used_bytes:(s.blocks-s.bfree)*s.bsize};}catch{}
    const historicalOnly=new Set([...all].filter(h=>!current.has(h))),unreferenced=new Set([...objects.keys()].filter(h=>!all.has(h)));
    const storage={sampled_at:Date.now(),status:sections.every(s=>s.complete)&&disk?'ready':'partial',sections,assets,disk,
      total_bytes:sections.reduce((n,s)=>n+s.bytes,0),allocated_bytes:sections.every(s=>s.allocated_bytes!==null)?sections.reduce((n,s)=>n+s.allocated_bytes,0):null,
      market_objects:sum(new Set(objects.keys())),current:sum(current),historical_only:sum(historicalOnly),unreferenced:sum(unreferenced),referenced:sum(all)};
    this.storage=storage;return storage;
  }
  async request(req,target,query,user,body,page){
    if(req.method==='PATCH'&&target)return this.change(user,target,await body());
    if(req.method!=='GET')fail(404,'管理接口不存在');
    await this.scan();const rows=this.rows();
    if(target){const item=rows.find(a=>a.id===target);if(!item)fail(404,'市场资源不存在');return {item};}
    const sort=query.get('sort')||'heat';
    if(!['heat','downloads','size','updated','name'].includes(sort))fail(400,'市场排序无效');
    rows.sort((a,b)=>(sort==='name'?a.name.localeCompare(b.name,'zh-CN'):sort==='heat'?b.metrics.heat_7d-a.metrics.heat_7d:sort==='downloads'?b.metrics.downloads-a.metrics.downloads:sort==='size'?b.total_bytes-a.total_bytes:b.updated_at-a.updated_at)||a.id.localeCompare(b.id));
    const {assets,...storage}=this.storage;return {...page(rows,query),summary:this.summary(rows),storage,sort};
  }
}
