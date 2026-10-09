// Read-only performance probe: serves an already fixed native editor Web build
// on the isolated test port. It never starts CreationService or writes source.
// Timing is diagnostic evidence, not a hardware-independent CI threshold.
import {createServer} from 'node:http';
import {createReadStream,existsSync,mkdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {nativeScenePacket} from '../../services/creation/native-view.mjs';

const root=resolve(import.meta.dirname,'../..');
const fixture=resolve(process.env.WA_PERF_FIXTURE??join(root,'.local/creation-verification/viewport-annotation/browser-OXIT4P'));
const fixed=JSON.parse(readFileSync(join(fixture,'report.json')));
const build=process.env.WA_PERF_BUILD??fixed.runtime_builds.find(row=>row.purpose==='native_preview'&&row.status==='completed').id;
const buildRoot=join(fixture,'builds',build),web=join(buildRoot,'web');
const out=resolve(process.env.WA_PERF_OUT??join(root,'.local/creation-verification/viewport-performance',`web-${Date.now()}`));mkdirSync(out,{recursive:true});
const db=new DatabaseSync(join(fixture,'creation.sqlite'),{readOnly:true});
const revision=JSON.parse(db.prepare("SELECT body FROM documents WHERE kind='creator_revision' AND id=?").get(fixed.source_revision).body);db.close();
const resource=Object.values(revision.manifest.resources).find(resource=>resource.path===(process.env.WA_PERF_SCENE??'world.tscn'));
if(!resource)throw Error('The fixed fixture has no requested scene');
const port=Number(process.env.WA_PERF_PORT??48921),origin=`http://127.0.0.1:${port}`;
const packet=nativeScenePacket(revision.manifest,resource.id,{project_id:revision.project_id,branch_id:'main',revision:revision.id,origin});
packet.source_revision=revision.id;
const sensitivity=Number(process.env.WA_PERF_SENSITIVITY??.004);
const summary={scope:'existing immutable native editor Web export, isolated static harness; no formal workbench backend or gameplay',fixture,build,requested_sensitivity:sensitivity,resource:{id:resource.id,path:resource.path,nodes:resource.native_nodes.length,addressable_objects:packet.objects.length,source_revision:revision.id},cases:[],errors:[],hashes:[]};
for(const path of ['main.gd','editor_navigation.gd','remote_selection_mask_layer.gd','remote_selection_outline.gd','editor_annotations.gd','annotation_spatial.gd','annotation_visuals.gd']){
  const file=join(buildRoot,'runtime',path);if(existsSync(file))summary.hashes.push({path,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')});
}
const sockets=new Set(),server=createServer((req,res)=>{
  const pathname=new URL(req.url,origin).pathname;
  if(pathname==='/harness'){
    res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style><iframe id="preview" src="/web/index.html?nonce=perf-isolated&mode=main"></iframe><script>window.events=[];window.addEventListener("message",e=>{if(e.origin===location.origin&&e.data?.source==="world-atelier-preview")events.push({...e.data,received:performance.now()});});window.post=p=>preview.contentWindow.postMessage({source:"world-atelier-workspace",nonce:"perf-isolated",...p},location.origin);</script>');return;
  }
  const file=resolve(web,'.'+pathname.replace(/^\/web/,''));
  if(!file.startsWith(web+'/')||!existsSync(file)||!statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.png':'image/png'})[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});createReadStream(file).pipe(res);
});
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
let browser;
try {
  await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
  summary.browser=browser.version();
  for(const dpr of (process.env.WA_PERF_DPRS??'1,2').split(',').map(Number)){
    const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:dpr});
    const page=await context.newPage();page.on('pageerror',error=>summary.errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&/SCRIPT ERROR|RuntimeError/.test(message.text()))summary.errors.push(message.text());});
    await page.goto(origin+'/harness');await page.waitForFunction(()=>events.some(event=>event.type==='ready'),null,{timeout:90000});
    await page.evaluate(packet=>post({...packet,type:'scene',seq:10,selected_id:'',selected_ids:[],editable:true,frame:true}),packet);
    await page.waitForFunction(()=>events.some(event=>event.type==='loaded'&&event.seq===10),null,{timeout:90000});
    await page.evaluate(({packet,sensitivity})=>post({type:'navigation_settings',seq:10,document_id:packet.document_id,camera_speed:6,sensitivity}),{packet,sensitivity});
    const frame=page.frames().find(frame=>frame.url().includes('/web/'));
    const environment=await frame.evaluate(()=>{
      const canvas=document.getElementById('canvas'),gl=canvas.getContext('webgl2')??canvas.getContext('webgl');
      const debug=gl?.getExtension('WEBGL_debug_renderer_info');return {dpr:devicePixelRatio,css:{width:innerWidth,height:innerHeight},canvas:{width:canvas.width,height:canvas.height},webgl:!!gl,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl?.getParameter(gl.RENDERER),vendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null};
    });
    if(process.env.WA_PERF_FIXED_DELTA==='1'){
      const start=await page.evaluate(packet=>{const index=events.length;post({type:'camera',seq:10,document_id:packet.document_id,action:'fit'});return index;},packet);
      await page.waitForFunction(index=>events.slice(index).some(event=>event.type==='camera'),start);
      const before=await page.evaluate(()=>events.filter(event=>event.type==='camera').at(-1));
      await page.mouse.move(640,400);await page.mouse.down({button:'right'});
      await frame.waitForFunction(()=>document.pointerLockElement===document.getElementById('canvas'));
      await frame.evaluate(()=>{window.perfMotion={x:0,y:0,count:0};document.addEventListener('mousemove',event=>{if(document.pointerLockElement){perfMotion.x+=event.movementX;perfMotion.y+=event.movementY;perfMotion.count++;}});});
      for(const [x,y] of [[680,410],[720,420],[760,430]])await page.mouse.move(x,y);
      const releaseIndex=await page.evaluate(()=>events.length);await page.mouse.up({button:'right'});
      await frame.waitForFunction(()=>!document.pointerLockElement);
      await page.waitForFunction(index=>events.slice(index).some(event=>event.type==='camera'&&event.navigation===''),releaseIndex);
      const after=await page.evaluate(()=>events.filter(event=>event.type==='camera').at(-1)),motion=await frame.evaluate(()=>perfMotion);
      const result={environment,requested_css_delta:{x:120,y:30},browser_movement:motion,yaw_delta:after.yaw-before.yaw,pitch_delta:after.pitch-before.pitch,position_before:before.position,position_after:after.position,final_navigation:after.navigation,pointer_locked:false};
      (summary.fixed_delta??=[]).push(result);console.log('FIXED_DELTA '+JSON.stringify(result));
    }
    const tower=packet.objects.find(object=>/Tower/.test(object.name))??packet.objects[1];
    const ground=packet.objects.find(object=>/Ground/.test(object.name))??packet.objects[2];
    let cases=[{name:'idle-unselected',ids:[],moving:false},{name:'freelook-unselected',ids:[],moving:true},{name:'idle-tower',ids:[tower.id],moving:false},{name:'freelook-tower',ids:[tower.id],moving:true},{name:'freelook-two-selections',ids:[tower.id,ground.id],moving:true},{name:'freelook-two-selections-outlines-off',ids:[tower.id,ground.id],moving:true,opacity:0}];
    if(process.env.WA_PERF_ANNOTATIONS==='1'){
      const points=Array.from({length:64},(_,i)=>({id:`mark-${i}`,annotation_kind:'point',dimension:'3d',position:[(i%8-3.5)*1.1,1, (Math.floor(i/8)-3.5)*1.1],geometry:{},object_ids:[]}));
      const boxes=points.map(a=>({...a,annotation_kind:'region',geometry:{shape:'box',tool:'volume',plane:'xz',center:a.position,size:[.8,2,.8],offset:0,depth:2}}));
      const prisms=points.map(a=>({...a,annotation_kind:'region',geometry:{shape:'prism',tool:'brush',plane:'xz',center:a.position,offset:0,depth:2,radius:.4,world_points:Array.from({length:96},(_,i)=>[a.position[0]+Math.cos(i*Math.PI/48)*.4,0,a.position[2]+Math.sin(i*Math.PI/48)*.4])}}));
      cases=[{name:'idle-empty',marks:[],moving:false},{name:'orbit-empty',marks:[],moving:true},{name:'idle-64-points',marks:points,moving:false},{name:'orbit-64-points',marks:points,moving:true},{name:'idle-64-volumes',marks:boxes,moving:false},{name:'orbit-64-volumes',marks:boxes,moving:true},{name:'idle-64-prisms',marks:prisms,moving:false},{name:'orbit-64-prisms',marks:prisms,moving:true}].map(a=>({...a,ids:[]}));
    }
    for(const entry of cases.filter(entry=>!process.env.WA_PERF_CASES||process.env.WA_PERF_CASES.split(',').includes(entry.name))){
      await page.evaluate(({packet,ids,opacity})=>{post({type:'display_settings',seq:10,document_id:packet.document_id,settings:{opacity}});post({type:'select',seq:10,document_id:packet.document_id,id:ids[0]??'',ids});post({type:'camera',seq:10,document_id:packet.document_id,action:'fit'});}, {packet,ids:entry.ids,opacity:entry.opacity??.85});
      if(process.env.WA_PERF_ANNOTATIONS==='1')await page.evaluate(({packet,marks})=>post({type:'annotation',seq:10,document_id:packet.document_id,enabled:true,tool:'point',target:'objects',marks}),{packet,marks:entry.marks});
      await frame.evaluate(()=>new Promise(resolve=>{let count=30;const tick=()=>{if(--count)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);}));
      let moving=true,movement;
      if(entry.moving){
        await page.mouse.move(640,400);await page.mouse.down({button:'right'});
        movement=(async()=>{let step=0;while(moving){await page.mouse.move(640+Math.sin(step/60)*90,400+Math.sin(step/110)*20);step++;await new Promise(resolve=>setTimeout(resolve,8));}})();
      }
      const metrics=await frame.evaluate(async({frames})=>{
        const samples=[];let previous=null,step=0;
        const start=performance.now(),startEvents=parent.events.length;
        await new Promise(resolve=>{
          const tick=time=>{
            if(previous!==null)samples.push(time-previous);previous=time;
            if(++step<frames)requestAnimationFrame(tick);else resolve();
          };requestAnimationFrame(tick);
        });
        const receipt=parent.events.slice(startEvents),cameras=receipt.filter(e=>e.type==='camera'&&e.seq===10),sorted=[...samples].sort((a,b)=>a-b),percentile=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
        return {frames:samples.length,elapsed_ms:performance.now()-start,mean_ms:samples.reduce((a,b)=>a+b,0)/samples.length,p50_ms:percentile(.5),p95_ms:percentile(.95),p99_ms:percentile(.99),max_ms:sorted.at(-1),over_25ms:samples.filter(n=>n>25).length,over_50ms:samples.filter(n=>n>50).length,annotation_projection_events:receipt.filter(e=>e.type==='annotation_projection').length,camera_events:cameras.length,yaw_span:cameras.length?Math.max(...cameras.map(e=>e.yaw))-Math.min(...cameras.map(e=>e.yaw)):0,pointer_locked:document.pointerLockElement===document.getElementById('canvas'),engine_performance:receipt.filter(e=>e.type==='viewport_performance'),samples};
      },{frames:Number(process.env.WA_PERF_FRAMES??180)});
      if(process.env.WA_PERF_SCREENSHOTS==='1'&&entry.moving){
        const path=join(out,`${entry.name}-dpr${dpr}-moving.png`);await frame.locator('#canvas').screenshot({path});metrics.moving_screenshot=path;
      }
      moving=false;await movement;if(entry.moving)await page.mouse.up({button:'right'});
      if(process.env.WA_PERF_SCREENSHOTS==='1'&&entry.moving){
        await frame.evaluate(()=>new Promise(resolve=>{let count=30;const tick=()=>{if(--count)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);}));
        const path=join(out,`${entry.name}-dpr${dpr}-stopped.png`);await frame.locator('#canvas').screenshot({path});metrics.stopped_screenshot=path;
        metrics.stopped_pointer_locked=await frame.evaluate(()=>!!document.pointerLockElement);
      }
      if(entry.moving&&(!metrics.camera_events||metrics.yaw_span<.001))throw Error('The measured movement did not reach the real camera; reject this performance sample');
      summary.cases.push({name:entry.name,environment,selected_ids:entry.ids,annotation_count:entry.marks?.length,...metrics});
      writeFileSync(join(out,'report.json'),JSON.stringify(summary,null,2));
      console.log(JSON.stringify({name:entry.name,dpr,renderer:environment.renderer,p50_ms:metrics.p50_ms,p95_ms:metrics.p95_ms,p99_ms:metrics.p99_ms,camera_events:metrics.camera_events,yaw_span:metrics.yaw_span}));
    }
    await context.close();
  }
} finally {
  await browser?.close();for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(yes=>server.close(yes));
  writeFileSync(join(out,'report.json'),JSON.stringify(summary,null,2));console.log('VIEWPORT_PERFORMANCE_EVIDENCE '+out);
}
