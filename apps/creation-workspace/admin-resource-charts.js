const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const positive=value=>finite(value)>0?value:null;
const ratio=(value,total)=>finite(value)!==null&&positive(total)!==null?value/total*100:null;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(value,digits=1)=>finite(value)===null?'—':value.toLocaleString('zh-CN',{maximumFractionDigits:digits});
const percentage=value=>finite(value)===null?'—':number(value)+'%';
const byteLabel=value=>finite(value)===null?'—':value>=1024**4?number(value/1024**4,2)+' TB':value>=1024**3?number(value/1024**3,2)+' GB':value>=1024**2?number(value/1024**2,1)+' MB':value>=1024?number(value/1024,1)+' KB':number(value,0)+' B';
const amount=(value,kind)=>kind==='cpu'?finite(value)===null?'—':number(value,2)+' 核':byteLabel(value);
const clock=at=>new Date(at).toLocaleTimeString('zh-CN',{hour12:false});
const kinds=['cpu','memory','disk'],titles={cpu:'CPU',memory:'内存',disk:'磁盘'},colors={cpu:'#527d59',memory:'#b28a3d',disk:'#637faa',used:'#527d59',remaining:'#7898b5',service:'#bd8d3a',reserved:'#b6aaa0',capacity:'#8a9385'};
const rangeDurations={'15m':900000,'1h':3600000,'24h':86400000};

export function resourceReading(metrics,row,kind){
  let capacity=null,used=null,remaining=null,service=null,reserved=null,usedPercent=null;
  if(kind==='cpu'){
    capacity=positive(row?.logical_cores)??positive(metrics?.host?.logical_cores);
    const percent=finite(row?.host_cpu_percent);
    usedPercent=percent!==null&&percent<=100?percent:null;
    if(capacity!==null&&usedPercent!==null){used=capacity*usedPercent/100;remaining=capacity-used;}
    if(finite(row?.process_cpu_percent)!==null)service=row.process_cpu_percent/100;
  }else if(kind==='memory'){
    capacity=positive(row?.host_memory_total);used=finite(row?.host_memory_bytes);service=finite(row?.process_memory_bytes);
    if(capacity!==null&&used!==null&&used<=capacity)remaining=capacity-used;
    else if(capacity!==null&&used>capacity)used=null;
    usedPercent=ratio(used,capacity);
  }else if(kind==='disk'){
    capacity=positive(row?.disk?.total_bytes);used=finite(row?.disk?.used_bytes);remaining=finite(row?.disk?.available_bytes??row?.disk?.free_bytes);
    if(capacity!==null&&used!==null&&remaining!==null){
      if(used+remaining<=capacity)reserved=capacity-used-remaining;
      else {used=null;remaining=null;}
    }
    usedPercent=ratio(used,capacity);
  }
  return {capacity,used,remaining,service,reserved,usedPercent,remainingPercent:ratio(remaining,capacity),servicePercent:ratio(service,capacity),reservedPercent:ratio(reserved,capacity)};
}

export function historyFor(metrics,range){
  const end=finite(metrics?.latest?.at)??Date.now(),start=end-(rangeDurations[range]??rangeDurations['1h']);
  const rows=new Map();for(const row of metrics?.samples??[])if(finite(row.at)!==null&&row.at>=start&&row.at<=end)rows.set(row.at,row);
  return {start,end,points:[...rows.values()].sort((a,b)=>a.at-b.at)};
}
export const hasGap=(previousAt,currentAt)=>currentAt-previousAt>125000;
export function summarizeResource(metrics,range,kind){
  const rows=historyFor(metrics,range).points.map(row=>({at:row.at,...resourceReading(metrics,row,kind)})).filter(row=>row.usedPercent!==null);
  const first=rows[0]??null,last=rows.at(-1)??null,canCompare=rows.length>=2&&last.at>first.at;
  return {count:rows.length,first,last,peakPercent:rows.length?Math.max(...rows.map(row=>row.usedPercent)):null,deltaPercent:canCompare?last.usedPercent-first.usedPercent:null,deltaUsed:canCompare&&last.used!==null&&first.used!==null?last.used-first.used:null};
}

function change(value,format){return value===null?'等待更多采样':`${value>0?'↑ ':value<0?'↓ ':'持平 '}${format(Math.abs(value))}`;}
function card(metrics,range,kind){
  const current=resourceReading(metrics,metrics.latest,kind),summary=summarizeResource(metrics,range,kind),value=current.usedPercent;
  const remainingName=kind==='memory'?'系统空闲':kind==='disk'?'可用空间':'空闲算力';
  const total=current.capacity??(kind==='memory'?positive(metrics.host?.total_memory_bytes):null);
  const parts=[['used',current.usedPercent],['remaining',current.remainingPercent],['reserved',current.reservedPercent]];
  const badge=value===null?'等待采样':value>=90?'高占用':value>=75?'留意占用':'有余量';
  const subtitle={cpu:'全部逻辑核合计为 100%',memory:'主机已用包含系统缓存',disk:'创作数据目录所在卷'}[kind];
  return `<article class="capacity-card ${value>=90?'pressure-high':value>=75?'pressure-mid':''}" data-resource="${kind}"><div class="capacity-head"><h2>${titles[kind]}</h2><span class="capacity-badge">${badge}</span></div><p class="capacity-subtitle">${subtitle}</p><div class="capacity-value">${percentage(value)}<small>已用</small></div>
    <div class="capacity-bar" role="img" aria-label="${esc(titles[kind]+'：已用 '+percentage(value)+'，'+remainingName+' '+percentage(current.remainingPercent)+(kind==='disk'?'，预留 '+percentage(current.reservedPercent):''))}">${parts.filter(([,v])=>v!==null).map(([key,v])=>`<span class="capacity-${key}" style="width:${Math.min(100,v)}%"></span>`).join('')}</div>
    <dl class="capacity-facts"><div><dt>${kind==='cpu'?'总算力':'总容量'}</dt><dd>${amount(total,kind)}</dd></div><div><dt>${kind==='cpu'?'已用等效核数':'已用'}</dt><dd>${amount(current.used,kind)}</dd></div><div><dt>${remainingName}</dt><dd>${amount(current.remaining,kind)}</dd></div><div><dt>${kind==='disk'?'预留 / 不可用':'本服务进程'}</dt><dd>${amount(kind==='disk'?current.reserved:current.service,kind)}</dd></div></dl>
    <div class="capacity-trend"><span>时段峰值 <strong>${percentage(summary.peakPercent)}</strong></span><span title="${summary.first?'与所选时段首条有效记录 '+clock(summary.first.at)+' 比较':'缺少历史记录'}">${change(summary.deltaPercent,v=>number(v,2)+' 百分点')}</span></div>
    <p class="capacity-note">${kind==='disk'?`服务目录 ${byteLabel(metrics.storage?.total_bytes)}${metrics.storage?.status==='partial'?'（部分扫描）':''} · 文件逻辑大小，单独统计`:kind==='cpu'?`本服务占整机 ${percentage(current.servicePercent)} · 不含子进程`: `本服务 RSS 占整机 ${percentage(current.servicePercent)} · 空闲不含可回收缓存`}</p></article>`;
}

function seriesFor(kind,mode){
  if(kind==='comparison')return kinds.map(name=>({label:titles[name]+' 已用',color:colors[name],value:(metrics,row)=>resourceReading(metrics,row,name).usedPercent}));
  const percent=mode==='percent',free=kind==='memory'?'系统空闲':kind==='disk'?'可用空间':'空闲';
  const specs=[['capacity',kind==='cpu'?'总算力':'总容量'],['used','已用'],['remaining',free],...(kind==='disk'?[['reserved','预留 / 不可用']]:[['service','本服务进程']])];
  return specs.map(([key,label])=>({key,label,color:colors[key],dashed:key==='capacity',value:(metrics,row)=>{const values=resourceReading(metrics,row,kind);return percent?key==='capacity'?values.capacity===null?null:100:values[key+'Percent']:values[key];}}));
}

export function resourceDashboard(metrics,range,mode='percent'){
  const history=historyFor(metrics,range),earliest=history.points[0]?.at,span=earliest?Math.round((history.end-earliest)/60000):0;
  const panel=kind=>{const combined=kind==='comparison',specs=seriesFor(kind,mode),summary=combined?null:summarizeResource(metrics,range,kind);
    const subtitle=combined?'CPU、内存、磁盘均以各自总容量为 100%，共用时间轴':kind==='cpu'?'等效核数表示这段采样内占用的逻辑核算力':kind==='memory'?'本服务 RSS 与主机总量对照；系统空闲不等于可回收内存':'已用 + 可用 + 预留 = 总容量；服务目录文件用量在下方单列';
    return `<section class="panel resource-chart-panel" data-resource-panel="${kind}"><div class="panel-head"><div><h3>${combined?'资源占用率对比':titles[kind]+'容量与用量趋势'}</h3><p>${subtitle}</p></div><span class="chart-unit">${combined||mode==='percent'?'占用率 %':kind==='cpu'?'等效逻辑核':'容量 / 字节'}</span></div><div class="panel-body"><div class="resource-chart-wrap"><canvas data-resource-chart="${kind}" tabindex="0" role="img" aria-label="${titles[kind]??'资源占用率'}趋势，左右方向键查看真实采样"></canvas></div><div class="resource-legend">${specs.map(s=>`<span><i style="--series-color:${s.color}" class="${s.dashed?'dashed':''}"></i>${s.label}</span>`).join('')}</div><div class="chart-reading" data-chart-reading="${kind}" role="status"></div>${combined?'':`<div class="resource-period-stats"><span>已用峰值 <strong>${percentage(summary.peakPercent)}</strong></span><span>首末变化 <strong>${change(mode==='percent'?summary.deltaPercent:summary.deltaUsed,v=>mode==='percent'?number(v,2)+' 百分点':amount(v,kind))}</strong></span><span>${summary.count} 个有效采样</span></div>`}</div></section>`;
  };
  return `<div class="resource-toolbar"><div><strong>容量、用量与变化</strong><p>${esc(metrics.host?.cpu_model??metrics.host?.platform??'主机')} · ${esc(metrics.host?.architecture??'')}</p></div><div class="resource-controls"><div class="range" aria-label="资源统计时段">${Object.keys(rangeDurations).map((key,i)=>`<button data-range="${key}" aria-pressed="${range===key}" class="${range===key?'active':''}">${['15 分钟','1 小时','24 小时'][i]}</button>`).join('')}</div><div class="range" aria-label="用量显示单位">${[['percent','占用率'],['amount','实际用量']].map(([key,label])=>`<button data-resource-unit="${key}" aria-pressed="${mode===key}" class="${mode===key?'active':''}">${label}</button>`).join('')}</div></div></div>
    <div class="capacity-cards">${kinds.map(kind=>card(metrics,range,kind)).join('')}</div><p class="resource-history-note">${earliest?'所选时段内实际记录 '+new Date(earliest).toLocaleString('zh-CN',{hour12:false})+' 起，覆盖约 '+span+' 分钟':'等待首个实际采样，约需 5 秒'}。缺测保留空白；峰值与变化仅计算所选时段内有效记录。悬停、触摸或用方向键查看采样。</p>
    ${panel('comparison')}<div class="resource-detail-charts">${kinds.map(panel).join('')}</div><p class="resource-history-note">本服务仅指 Node.js 进程，子进程在下方单列。${history.points.some(p=>p.logical_cores==null)?'旧 CPU 记录的等效核数按当前主机逻辑核数换算。':''}这些曲线来自实际历史采样，不补造服务重启或采样中断期间的数据。</p>`;
}

export function drawResourceCharts(root,metrics,range,mode='percent'){
  const history=historyFor(metrics,range);
  for(const canvas of root.querySelectorAll('[data-resource-chart]')){
    const kind=canvas.dataset.resourceChart,specs=seriesFor(kind,mode),percent=kind==='comparison'||mode==='percent';
    const values=history.points.map(row=>({row,values:specs.map(spec=>spec.value(metrics,row))}));
    const w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight),dpr=Math.min(devicePixelRatio||1,2),left=54,right=12,top=15,bottom=28;
    canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);const ctx=canvas.getContext('2d');if(!ctx)continue;
    const finiteValues=values.flatMap(point=>point.values).filter(value=>finite(value)!==null);
    const maximum=percent?Math.max(100,...finiteValues):Math.max(1,...finiteValues)*1.05;
    const x=at=>left+(at-history.start)/(history.end-history.start)*(w-left-right),y=value=>top+(1-value/maximum)*(h-top-bottom);
    const format=value=>percent?percentage(value):amount(value,kind);
    const output=root.querySelector(`[data-chart-reading="${kind}"]`),savedAt=Number(canvas.dataset.selectedAt);let selected=values.length-1;
    if(savedAt>0&&values.length)selected=values.reduce((best,point,i)=>Math.abs(point.row.at-savedAt)<Math.abs(values[best].row.at-savedAt)?i:best,0);
    function read(index){
      if(index<0||!values.length){output.textContent='尚无有效采样；缺失数据不显示为 0。';return;}
      const point=values[index];canvas.dataset.selectedAt=String(point.row.at);output.replaceChildren();const time=document.createElement('time');time.textContent=clock(point.row.at);time.dateTime=new Date(point.row.at).toISOString();output.append(time);
      point.values.forEach((value,i)=>{const span=document.createElement('span');span.textContent=specs[i].label+' '+format(value);output.append(span);});
    }
    function draw(index=-1){
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.font='10px -apple-system, sans-serif';ctx.lineWidth=1;ctx.textBaseline='middle';
      for(let i=0;i<=4;i++){const value=maximum*i/4,atY=y(value);ctx.strokeStyle='#e7ebdf';ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(left,atY);ctx.lineTo(w-right,atY);ctx.stroke();ctx.fillStyle='#85927b';ctx.fillText(percent?number(value,0)+'%':kind==='cpu'?number(value,1)+'核':byteLabel(value),2,atY);}
      const ticks=w<440?2:4;for(let i=0;i<=ticks;i++){const at=history.start+(history.end-history.start)*i/ticks;ctx.fillStyle='#85927b';ctx.fillText(new Date(at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),Math.max(left,Math.min(w-38,x(at)-14)),h-9);}
      if(!finiteValues.length){ctx.fillStyle='#85927b';ctx.textAlign='center';ctx.fillText('等待实际采样 · 无记录时段保留空白',w/2,h/2);ctx.textAlign='left';}
      specs.forEach((spec,line)=>{
        ctx.strokeStyle=spec.color;ctx.fillStyle=spec.color;ctx.lineWidth=spec.dashed?1.2:1.8;ctx.setLineDash(spec.dashed?[4,4]:[]);ctx.beginPath();let previous=null,last=null;
        for(const point of values){const value=point.values[line];if(finite(value)===null){previous=null;continue;}if(!previous||hasGap(previous.row.at,point.row.at))ctx.moveTo(x(point.row.at),y(value));else ctx.lineTo(x(point.row.at),y(value));previous=point;last=point;}
        ctx.stroke();ctx.setLineDash([]);if(last){ctx.beginPath();ctx.arc(x(last.row.at),y(last.values[line]),2.5,0,Math.PI*2);ctx.fill();}
      });
      if(index>=0&&values[index]){const point=values[index],atX=x(point.row.at);ctx.strokeStyle='#aab79e';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(atX,top);ctx.lineTo(atX,h-bottom);ctx.stroke();ctx.setLineDash([]);point.values.forEach((value,i)=>{if(finite(value)!==null){ctx.fillStyle=specs[i].color;ctx.beginPath();ctx.arc(atX,y(value),3,0,Math.PI*2);ctx.fill();}});}
    }
    canvas.onpointermove=event=>{const at=history.start+(event.clientX-canvas.getBoundingClientRect().left-left)/(w-left-right)*(history.end-history.start);if(!values.length)return;selected=values.reduce((best,point,i)=>Math.abs(point.row.at-at)<Math.abs(values[best].row.at-at)?i:best,0);draw(selected);read(selected);};
    canvas.onpointerleave=()=>{selected=values.length-1;draw();read(selected);};
    canvas.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||!values.length)return;event.preventDefault();selected=event.key==='Home'?0:event.key==='End'?values.length-1:Math.max(0,Math.min(values.length-1,selected+(event.key==='ArrowLeft'?-1:1)));draw(selected);read(selected);};
    canvas.setAttribute('aria-label',`${kind==='comparison'?'CPU、内存、磁盘占用率对比':titles[kind]+'容量与用量趋势'}。${percent?'单位为百分比':'单位为'+(kind==='cpu'?'等效逻辑核':'字节')}。${values.length} 个实际记录；方向键逐条查看。`);
    draw(savedAt>0?selected:-1);read(selected);
  }
}
