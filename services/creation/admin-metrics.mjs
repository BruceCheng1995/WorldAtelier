import os from 'node:os';
import {readdir, lstat, statfs} from 'node:fs/promises';
import {resolve, basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {monitorEventLoopDelay} from 'node:perf_hooks';

const execute=promisify(execFile), SAMPLE_MS=5000, DAY=86400000;
const cpuTimes=()=>os.cpus().reduce((v,c)=>({idle:v.idle+c.times.idle,total:v.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
const percent=(v,total)=>total>0?Math.max(0,Math.min(100,v/total*100)):null;

/** Measured, bounded telemetry. Never inspect or return process argv/env. */
export class AdminMetrics {
  constructor(service,server){
    this.service=service;this.store=service.store;this.samples=[];this.requests={count:0,errors:0,bytes:0};
    this.last={at:Date.now(),cpu:cpuTimes(),process:process.cpuUsage(),...this.requests};
    this.loop=monitorEventLoopDelay({resolution:20});this.loop.enable();
    this.storage={sampled_at:null,status:'pending',entries:[]};this.processes={sampled_at:null,status:'pending',items:[]};
    this.onRequest=(req,res)=>{
      let bytes=0;const size=(chunk,encoding)=>chunk==null||typeof chunk==='function'?0:typeof chunk==='string'?Buffer.byteLength(chunk,typeof encoding==='string'?encoding:undefined):chunk.byteLength??0;
      const write=res.write,end=res.end;
      res.write=function(chunk,encoding,...rest){bytes+=size(chunk,encoding);return write.call(this,chunk,encoding,...rest);};
      res.end=function(chunk,encoding,...rest){bytes+=size(chunk,encoding);return end.call(this,chunk,encoding,...rest);};
      res.once('finish',()=>{this.requests.count++;if(res.statusCode>=500)this.requests.errors++;this.requests.bytes+=bytes;});
    };
    server.prependListener('request',this.onRequest);this.server=server;
    this.timer=setInterval(()=>{void this.sample().catch(()=>{});},SAMPLE_MS);this.timer.unref();
    this.scanTimer=setInterval(()=>{void this.scan();},60000);this.scanTimer.unref();
    void this.scan();
  }
  async sample(){
    if(this.closed||this.sampling)return;this.sampling=true;
    try{
      const at=Date.now(),cpu=cpuTimes(),proc=process.cpuUsage(),elapsed=at-this.last.at,mem=process.memoryUsage(),total=os.totalmem(),freeMemory=os.freemem(),logicalCores=os.cpus().length;
      let disk=null;try{const v=await statfs(this.service.data);disk={total_bytes:v.blocks*v.bsize,free_bytes:v.bavail*v.bsize,available_bytes:v.bavail*v.bsize,reserved_bytes:Math.max(0,v.bfree-v.bavail)*v.bsize,used_bytes:(v.blocks-v.bfree)*v.bsize};}catch{}
      if(this.closed)return;
      const count=this.requests.count-this.last.count,errors=this.requests.errors-this.last.errors;
      const row={id:String(at),at,window_ms:elapsed,logical_cores:logicalCores,host_cpu_percent:percent(cpu.total-this.last.cpu.total-(cpu.idle-this.last.cpu.idle),cpu.total-this.last.cpu.total),process_cpu_percent:Math.max(0,((proc.user-this.last.process.user)+(proc.system-this.last.process.system))/(elapsed*10)),host_memory_bytes:total-freeMemory,host_memory_total:total,host_memory_free_bytes:freeMemory,host_memory_percent:percent(total-freeMemory,total),process_memory_bytes:mem.rss,heap_used_bytes:mem.heapUsed,disk,requests_per_second:count/(elapsed/1000),errors_5xx:errors,error_percent:count?errors/count*100:0,response_bytes_per_second:(this.requests.bytes-this.last.bytes)/(elapsed/1000),event_loop_p99_ms:this.loop.percentile(99)/1e6,connections:this.service.realtime.connections.size};
      this.loop.reset();this.last={at,cpu,process:proc,...this.requests};this.samples.push(row);this.samples=this.samples.filter(x=>x.at>at-3600000).slice(-720);
      const bucket=String(Math.floor(at/60000));
      if(this.savedBucket!==bucket){this.store.put('creator_admin_metric',{...row,id:bucket});this.savedBucket=bucket;this.store.db.prepare("DELETE FROM documents WHERE kind='creator_admin_metric' AND CAST(id AS INTEGER)<?").run(Math.floor((at-DAY)/60000));}
      await this.processSample();
    }finally{this.sampling=false;}
  }
  async processSample(){
    try{
      const {stdout}=await execute('ps',['-axo','pid=,ppid=,%cpu=,rss=,comm='],{timeout:2500,maxBuffer:2*1024*1024});
      const rows=stdout.split('\n').map(line=>{const m=/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);return m?{pid:+m[1],parent_pid:+m[2],cpu_percent:+m[3],memory_bytes:+m[4]*1024,name:basename(m[5])}:null;}).filter(Boolean);
      const ids=new Set([process.pid]);for(let depth=0;depth<20;depth++){const size=ids.size;for(const row of rows)if(ids.has(row.parent_pid))ids.add(row.pid);if(size===ids.size)break;}
      this.processes={sampled_at:Date.now(),status:'ready',items:rows.filter(x=>ids.has(x.pid)).sort((a,b)=>b.memory_bytes-a.memory_bytes).slice(0,100)};
    }catch{this.processes={sampled_at:Date.now(),status:'unavailable',items:[]};}
  }
  async scan(){
    if(this.scanning||this.closed)return;this.scanning=true;
    try{
      const started=Date.now(),entries=[],roots=['assets','worlds','builds','environments','automatic-evidence','review-evidence'];
      const dirEntries=await readdir(this.service.data,{withFileTypes:true});
      // One level partitions the whole service directory without double counting.
      for(const entry of dirEntries){
        let bytes=0,files=0,complete=true;const stack=[resolve(this.service.data,entry.name)];
        while(stack.length){
          if(this.closed||Date.now()-started>8000||files>100000){complete=false;break;}
          const file=stack.pop();try{const stat=await lstat(file);if(stat.isSymbolicLink())continue;if(stat.isDirectory()){for(const e of await readdir(file))stack.push(resolve(file,e));}else if(stat.isFile()){bytes+=stat.size;files++;}}catch{complete=false;}
        }
        const names={market:'资源市场原件与历史','native-source':'原生源稿与派生缓存',assets:'模型与脚本',worlds:'世界与执行副本',builds:'导出构建',environments:'Agent 环境','automatic-evidence':'自动检查证据','review-evidence':'历史检查证据','creation.sqlite':'创作数据库','creation.sqlite-wal':'数据库事务日志','creation.sqlite-shm':'数据库共享索引'};
        entries.push({name:names[entry.name]??(roots.includes(entry.name)?entry.name:'其他服务文件'),bytes,files,complete});
      }
      this.storage={sampled_at:Date.now(),status:entries.every(e=>e.complete)?'ready':'partial',total_bytes:entries.reduce((s,e)=>s+e.bytes,0),entries:entries.sort((a,b)=>b.bytes-a.bytes)};
    }catch{this.storage={sampled_at:Date.now(),status:'unavailable',entries:[]};}finally{this.scanning=false;}
  }
  view(range='1h'){
    const duration={'15m':900000,'1h':3600000,'24h':DAY}[range]??3600000,cutoff=Date.now()-duration;
    const points=new Map(this.store.list('creator_admin_metric').filter(x=>x.at>=cutoff).map(x=>[x.at,x]));for(const x of this.samples)if(x.at>=cutoff)points.set(x.at,x);
    const samples=[...points.values()].sort((a,b)=>a.at-b.at);
    return {sample_interval_ms:SAMPLE_MS,range,history_started_at:samples[0]?.at??null,sampled_at:this.samples.at(-1)?.at??null,latest:this.samples.at(-1)??null,samples,host:{name:os.hostname(),platform:os.platform(),architecture:os.arch(),cpu_model:os.cpus()[0]?.model??null,logical_cores:os.cpus().length,total_memory_bytes:os.totalmem(),uptime_seconds:os.uptime()},service:{pid:process.pid,node_version:process.version,uptime_seconds:process.uptime(),request_count:this.requests.count,error_count:this.requests.errors},storage:this.storage,processes:this.processes};
  }
  close(){this.closed=true;clearInterval(this.timer);clearInterval(this.scanTimer);this.loop.disable();this.server.off('request',this.onRequest);}
}
