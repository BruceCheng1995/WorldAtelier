import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {CreationStore} from '../../services/creation/store.mjs';
import {resourceReading,historyFor,summarizeResource,hasGap,resourceDashboard,drawResourceCharts} from '../../apps/creation-workspace/admin-resource-charts.js';

const root=process.env.WORLD_ATELIER_TEST_ROOT??resolve(import.meta.dirname,'../..');
const now=1800000000000,GiB=1024**3,uid=p=>`${p}-${randomUUID()}`,wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=b=>createHash('sha256').update(b).digest('hex');
const sample=(at=now,patch={})=>({at,logical_cores:8,host_cpu_percent:50,process_cpu_percent:200,host_memory_total:16*GiB,host_memory_bytes:12*GiB,host_memory_percent:75,process_memory_bytes:2*GiB,disk:{total_bytes:1000,used_bytes:650,free_bytes:300},...patch});
const context=(rows=[],patch={})=>({latest:rows.at(-1)??null,samples:rows,range:'1h',sample_interval_ms:5000,host:{logical_cores:16,total_memory_bytes:32*GiB},...patch});
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;}
const close=(actual,expected)=>{assert.equal(typeof actual,'number');assert.ok(Math.abs(actual-expected)<1e-8,`${actual} differs from ${expected}`);};
const fields=(actual,expected)=>{for(const [key,value]of Object.entries(expected)){if(typeof value==='number')close(actual[key],value);else assert.equal(actual[key],value,key);}};
async function availablePort(port){const server=createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});const selected=server.address().port;await new Promise(ok=>server.close(ok));return selected;}

test('resource comparison: independent numeric contracts and protected module',{timeout:120000},async t=>{
  const evidence=resolve(root,'.local/creation-verification/admin-resource-comparison',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);mkdirSync(evidence,{recursive:true});
  const sources=['apps/creation-workspace/admin-resource-charts.js','apps/creation-workspace/admin.js','apps/creation-workspace/admin.css','services/creation/admin-metrics.mjs','services/preview/server.mjs'];
  const report={scope:'explicit numeric fixtures for pure view calculations plus isolated real HTTP authentication; no fabricated persisted monitoring history or browser chart claim',started_at:new Date().toISOString(),cases:[],source_hashes:Object.fromEntries(sources.map(p=>[p,hash(readFileSync(resolve(root,p)))])),completed:false};
  t.after(()=>{report.finished_at=new Date().toISOString();report.source_changed_during_run=sources.filter(p=>report.source_hashes[p]!==hash(readFileSync(resolve(root,p))));writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('ADMIN_RESOURCE_REPORT '+resolve(evidence,'report.json'));});
  async function check(name,fn){await t.test(name,async()=>{const row={name,status:'running'};report.cases.push(row);try{row.observations=await fn();row.status='passed';}catch(e){row.status='failed';row.error=e.message;throw e;}});}

  await check('CPU uses sampled logical cores and preserves valid multi-core service load',()=>{
    const row=sample(now,{host_cpu_percent:75,process_cpu_percent:250});fields(resourceReading(context([row]),row,'cpu'),{capacity:8,used:6,remaining:2,service:2.5,usedPercent:75,remainingPercent:25,servicePercent:31.25});
    const legacy={...row};delete legacy.logical_cores;fields(resourceReading(context([legacy]),legacy,'cpu'),{capacity:16,used:12,remaining:4,service:2.5,servicePercent:15.625});
    const zero=sample(now,{logical_cores:0,host_cpu_percent:null,process_cpu_percent:null});const unavailable=resourceReading(context([zero],{host:{logical_cores:0}}),zero,'cpu');assert.equal(unavailable.usedPercent,null);assert.equal(unavailable.servicePercent,null);
    return {raw_service_percent:250,sampled_cores:8,service_share_percent:31.25,legacy_cores_fallback:16};
  });
  await check('memory percentages and free capacity derive from the same historical byte sample',()=>{
    const row=sample(now,{host_memory_percent:1});fields(resourceReading(context([row]),row,'memory'),{capacity:16*GiB,used:12*GiB,remaining:4*GiB,service:2*GiB,usedPercent:75,remainingPercent:25,servicePercent:12.5});
    const old=sample(now,{host_memory_total:undefined});const reading=resourceReading(context([old]),old,'memory');fields(reading,{capacity:null,used:12*GiB,remaining:null,service:2*GiB,usedPercent:null,remainingPercent:null,servicePercent:null});
    const changed=sample(now,{host_memory_total:8*GiB,host_memory_bytes:2*GiB});fields(resourceReading(context([changed]),changed,'memory'),{capacity:8*GiB,remaining:6*GiB,usedPercent:25});
  });
  await check('disk usage excludes reserved space and reconciles capacity with available space',()=>{
    const row=sample();fields(resourceReading(context([row]),row,'disk'),{capacity:1000,used:650,remaining:300,reserved:50,usedPercent:65,remainingPercent:30,reservedPercent:5});
    const modern=sample(now,{disk:{total_bytes:1000,used_bytes:650,free_bytes:300,available_bytes:280,reserved_bytes:999}});const v=resourceReading(context([modern]),modern,'disk');fields(v,{remaining:280,reserved:70,usedPercent:65,reservedPercent:7});close(v.used+v.remaining+v.reserved,v.capacity);
    const exact=sample(now,{disk:{total_bytes:1000,used_bytes:650,free_bytes:350}});fields(resourceReading(context([exact]),exact,'disk'),{reserved:0,reservedPercent:0});
    const unavailable=sample(now,{disk:{total_bytes:1000,used_bytes:650}});fields(resourceReading(context([unavailable]),unavailable,'disk'),{usedPercent:65,remaining:null,remainingPercent:null,reserved:null});
    return {legacy_available:300,current_available_preferred:280,reserved_not_used:true};
  });
  await check('missing nonfinite and zero-capacity values do not masquerade as zero usage',()=>{
    const invalid=sample(now,{logical_cores:0,host_cpu_percent:NaN,process_cpu_percent:Infinity,host_memory_total:0,host_memory_bytes:NaN,process_memory_bytes:-1,disk:null}),m=context([invalid],{host:{logical_cores:0,total_memory_bytes:64*GiB}});
    for(const kind of ['cpu','memory','disk']){const reading=resourceReading(m,invalid,kind);assert.equal(reading.usedPercent,null);assert.equal(reading.remainingPercent,null);for(const value of Object.values(reading))assert.ok(value===null||typeof value==='number'&&Number.isFinite(value),'Invalid reading leaked a nonfinite value');}
    const realZero=sample(now,{host_cpu_percent:0,process_cpu_percent:0,host_memory_bytes:0,process_memory_bytes:0,disk:{total_bytes:1000,used_bytes:0,free_bytes:1000}});
    for(const kind of ['cpu','memory','disk'])fields(resourceReading(context([realZero]),realZero,kind),{used:0,usedPercent:0,remainingPercent:100});
  });
  await check('history windows filter sort and deduplicate without mutating input',()=>{
    const duplicate=sample(now-5000),rows=[sample(now-86400001),sample(now-3600001),sample(now-900001),sample(now-900000),sample(now),duplicate,{...duplicate},sample(now+1),sample(NaN)];
    const m=freeze(context(rows,{latest:sample(now)}));
    for(const [range,span,expected]of [['15m',900000,3],['1h',3600000,4],['24h',86400000,5]]){
      const h=historyFor(m,range);assert.equal(h.start,now-span);assert.equal(h.end,now);assert.equal(h.points.length,expected);assert.deepEqual(h.points.map(p=>p.at),[...new Set(h.points.map(p=>p.at))].sort((a,b)=>a-b));assert.ok(h.points.every(p=>p.at>=h.start&&p.at<=h.end));
    }
    assert.equal(rows.length,9);assert.equal(rows[0].at,now-86400001);
  });
  await check('summary peaks and deltas use only the selected actual window',()=>{
    const rows=[sample(now-900001,{host_cpu_percent:99}),sample(now-10000,{host_cpu_percent:25}),sample(now-5000,{host_cpu_percent:60}),sample(now,{host_cpu_percent:50})],m=context(rows);
    const summary=summarizeResource(m,'15m','cpu');assert.equal(summary.count,3);assert.equal(summary.first.at,now-10000);assert.equal(summary.last.at,now);close(summary.peakPercent,60);close(summary.deltaPercent,25);close(summary.deltaUsed,2);
    const only=summarizeResource(context([sample(now)]),'15m','cpu');assert.equal(only.count,1);assert.equal(only.deltaPercent,null);assert.equal(only.deltaUsed,null);
    const empty=summarizeResource(context([]),'15m','disk');assert.equal(empty.count,0);assert.equal(empty.first,null);assert.equal(empty.last,null);assert.equal(empty.peakPercent,null);assert.equal(empty.deltaPercent,null);assert.equal(empty.deltaUsed,null);
    return {out_of_range_peak_excluded:true,selected_peak:60,delta_percentage_points:25,delta_equivalent_cores:2};
  });
  await check('history uses now after restart and does not bridge unavailable intervals',()=>{
    const original=Date.now;Date.now=()=>now;try{const h=historyFor(context([sample(now-60000)],{latest:null}),'1h');assert.equal(h.end,now);assert.equal(h.points.length,1);}finally{Date.now=original;}
    assert.equal(hasGap(0,125000),false);assert.equal(hasGap(0,125001),true);assert.equal(hasGap(now-60000,now),false);assert.equal(hasGap(now,now-1),false);
    return {minute_points_continuous:true,gap_over_125_seconds:true};
  });
  await check('both display modes tolerate real zero and absent history with honest labels',()=>{
    for(const range of ['15m','1h','24h'])for(const mode of ['percent','amount'])for(const metrics of [context([]),context([sample()])]){
      const html=resourceDashboard(metrics,range,mode);assert.equal(typeof html,'string');assert.doesNotMatch(html,/NaN|undefined|Infinity/);assert.match(html,/CPU/);assert.match(html,/内存/);assert.match(html,/磁盘/);
    }
    assert.match(resourceDashboard(context([]),'1h','percent'),/等待|暂无|没有|无历史|采样/);
  });
  await check('canvas paths break at gaps and preserve inspected samples across redraws',()=>{
    const previousDocument=globalThis.document,previousDpr=globalThis.devicePixelRatio;
    globalThis.document={createElement:tag=>({tagName:tag,textContent:''})};globalThis.devicePixelRatio=1;
    try{
      const strokes=[],texts=[];let path=[],dash=[];
      const ctx={setTransform(){},clearRect(){},setLineDash(v){dash=[...v];},beginPath(){path=[];},moveTo(x,y){path.push(['move',x,y]);},lineTo(x,y){path.push(['line',x,y]);},stroke(){strokes.push({color:this.strokeStyle,path:[...path],dash:[...dash]});},fillText(v){texts.push(v);},arc(){},fill(){}};
      const output={nodes:[],textContent:'',replaceChildren(){this.nodes=[];},append(node){this.nodes.push(node);}};
      const canvas={dataset:{resourceChart:'cpu'},clientWidth:720,clientHeight:220,getContext:()=>ctx,getBoundingClientRect:()=>({left:0}),setAttribute(key,value){this[key]=value;}};
      const root={querySelectorAll:()=>[canvas],querySelector:()=>output};
      const rows=[sample(now-240000),sample(now-235000),sample(now-230000,{host_cpu_percent:null}),sample(now-225000),sample(now-5000),sample(now)],metrics=context(rows);
      drawResourceCharts(root,metrics,'15m','percent');
      const used=strokes.find(s=>s.color==='#527d59');assert.ok(used);assert.deepEqual(used.path.map(p=>p[0]),['move','line','move','move','line']);
      const first=used.path[0],second=used.path[1];close(second[1]-first[1],5000/900000*(720-54-12));close(first[2],15+.5*(220-15-28));assert.ok(texts.includes('100%'));
      assert.equal(output.nodes[0].dateTime,new Date(now).toISOString());
      let prevented=0;canvas.onkeydown({key:'Home',preventDefault(){prevented++;}});assert.equal(output.nodes[0].dateTime,new Date(rows[0].at).toISOString());
      canvas.onkeydown({key:'ArrowRight',preventDefault(){prevented++;}});assert.equal(output.nodes[0].dateTime,new Date(rows[1].at).toISOString());
      canvas.onkeydown({key:'End',preventDefault(){prevented++;}});assert.equal(output.nodes[0].dateTime,new Date(now).toISOString());assert.equal(prevented,3);
      canvas.onpointermove({clientX:first[1]});assert.equal(output.nodes[0].dateTime,new Date(rows[0].at).toISOString());canvas.onpointerleave();assert.equal(output.nodes[0].dateTime,new Date(now).toISOString());
      canvas.dataset.selectedAt=String(rows[1].at);strokes.length=0;
      drawResourceCharts(root,context([...rows,sample(now+5000)]),'15m','amount');
      assert.equal(canvas.dataset.selectedAt,String(rows[1].at));assert.equal(output.nodes[0].dateTime,new Date(rows[1].at).toISOString());
      const marker=strokes.find(s=>s.color==='#aab79e');assert.ok(marker,'Saved selection must draw its inspection marker');close(marker.path[0][1],54+(rows[1].at-(now+5000-900000))/900000*(720-54-12));
      canvas.dataset.selectedAt=String(rows[1].at+1000);drawResourceCharts(root,metrics,'15m','percent');assert.equal(canvas.dataset.selectedAt,String(rows[1].at));
      canvas.dataset.selectedAt='not-a-time';drawResourceCharts(root,metrics,'15m','percent');assert.equal(canvas.dataset.selectedAt,String(now));
      strokes.length=0;texts.length=0;drawResourceCharts(root,context([]),'15m','amount');assert.match(output.textContent,/尚无有效采样/);assert.ok(texts.some(v=>v.includes('等待实际采样')));assert.match(canvas['aria-label'],/0 个实际记录/);
      return {canvas_api_fixture:true,missing_value_and_220_second_gap_break_paths:true,inspection_uses_record_timestamps:true,saved_sample_retained_after_new_data_and_mode_redraw:true,missing_saved_timestamp_uses_nearest_actual_sample:true,not_a_browser_visual_claim:true};
    }finally{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;if(previousDpr===undefined)delete globalThis.devicePixelRatio;else globalThis.devicePixelRatio=previousDpr;}
  });
  await check('new resource module and metrics retain sole-admin HTTP authentication',async()=>{
    const port=await availablePort(Number(process.env.WORLD_ATELIER_RESOURCE_TEST_PORT??48931)),origin=`http://127.0.0.1:${port}`,data=realpathSync(mkdtempSync(resolve(tmpdir(),'atelier-resource-comparison-')));
    let child,log='';report.origin=origin;
    const store=new CreationStore(resolve(data,'creation/creation.sqlite')),A=store.register({name:uid('Resource admin'),password:uid('Password')}),B=store.register({name:uid('Resource viewer'),password:uid('Password')});store.put('creator_admin_settings',{id:'singleton',owner_user_id:A.user.id});store.close();
    const env={...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_PUBLIC_PLAY:'1',WORLD_ATELIER_LAN:'0'};delete env.WORLD_ATELIER_ADMIN_USER_ID;
    async function request(path,actor,method='GET') {const r=await fetch(origin+path,{method,headers:{Origin:origin,...(actor?.token?{Authorization:'Bearer '+actor.token}:{}),...(actor?.cookie?{Cookie:actor.cookie}:{})}});return {status:r.status,headers:r.headers,text:await r.text()};}
    try{
      child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);report.service_pid=child.pid;
      let ready=false;for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(log);try{const h=await request('/creation-api/health');if(h.status===200){ready=true;break;}}catch{}await wait(30);}assert.equal(ready,true,'Isolated service did not start');
      const path='/admin-assets/admin-resource-charts.js';assert.equal((await request(path)).status,401);assert.equal((await request(path,B)).status,401);assert.equal((await request('/creation-api/admin/metrics',B)).status,403);
      const access=await request('/creation-api/admin/access',A,'POST');assert.equal(access.status,200);const cookie={cookie:access.headers.get('set-cookie').split(';')[0]};const resource=await request(path,cookie);assert.equal(resource.status,200);assert.match(resource.headers.get('cache-control'),/no-store/);assert.match(resource.headers.get('content-type'),/javascript/);assert.equal(hash(resource.text),hash(readFileSync(resolve(root,'apps/creation-workspace/admin-resource-charts.js'))));
      assert.equal((await request('/admin%2dassets/admin-resource-charts.js')).status,401);assert.equal((await request('/admin-assets/admin-resource-charts.js/extra',cookie)).status,404);
      let metrics;for(let i=0;i<80;i++){const r=await request('/creation-api/admin/metrics?range=15m',cookie);assert.equal(r.status,200);metrics=JSON.parse(r.text);if(metrics.latest)break;await wait(100);}assert.ok(metrics.latest);assert.equal(metrics.range,'15m');assert.ok(metrics.latest.window_ms>0);
      const d=metrics.latest.disk;if(d){const v=resourceReading(metrics,metrics.latest,'disk');close(v.used+v.remaining+v.reserved,v.capacity);assert.ok(v.usedPercent>=0&&v.usedPercent<=100);}
      assert.equal((await request('/creation-api/admin/logout',cookie,'POST')).status,200);assert.equal((await request(path,cookie)).status,401);
      return {source_module_sha256:hash(resource.text),sampled_at:metrics.latest.at,actual_cpu_cores:metrics.latest.logical_cores??metrics.host.logical_cores};
    }finally{
      if(child&&child.exitCode===null&&child.signalCode===null){const ended=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),12000);await ended;clearTimeout(timer);}await availablePort(port);rmSync(data,{recursive:true,force:true});report.temporary_data_removed=!existsSync(data);writeFileSync(resolve(evidence,'server.log'),log);
    }
  });
  report.completed=report.cases.every(c=>c.status==='passed');
});
