import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';
import {hash} from '../../services/creation/schema.mjs';
import {snapshotProjectRuntime,assembleProject} from '../../services/creation/project-snapshot.mjs';

const root=resolve(import.meta.dirname,'../..');
const marketData=resolve(process.env.PREFAB_AUTOMATIC_MARKET_DATA??join(root,'.local/model-preview/creation'));
const marketDatabase=join(marketData,'creation.sqlite');
const compactState=state=>{
  const clip=({player,name,kind,duration,loop,track_count})=>({player,name,kind,duration,loop,track_count});
  const {resource_id,subject_id,source_revision,scene_generation,time,duration,playing,paused,faulted,error,observations}=state;
  return {resource_id,subject_id,source_revision,scene_generation,time,duration,playing,paused,faulted,error,observations,current:state.current?.name?clip(state.current):null,animations:state.animations.map(clip)};
};

function isolatedService(options){
  const keys=['WORLD_ATELIER_DISABLE_AGENT','WORLD_ATELIER_DISABLE_WORLDS'];
  const saved=keys.map(key=>[key,process.env[key]]);
  for(const key of keys)process.env[key]='1';
  try{return new CreationService(options);}finally{for(const [key,value]of saved)if(value===undefined)delete process.env[key];else process.env[key]=value;}
}

// Read one public asset/version only. The production SQLite connection is
// read-only, and every copied byte is verified before entering the test archive.
function copyOfficialAsset(service,assetId='official-3d-skaterMaleA'){
  const db=new DatabaseSync(marketDatabase,{readOnly:true});
  let asset,version;
  try{
    const read=db.prepare('SELECT body FROM documents WHERE kind=? AND id=?');
    asset=JSON.parse(read.get('market_asset',assetId).body);
    version=JSON.parse(read.get('market_version',asset.id+':'+asset.version).body);
  }finally{db.close();}
  for(const entry of Object.values(version.files)){
    const bytes=readFileSync(join(marketData,'market/objects',entry.hash.slice(0,2),entry.hash));
    assert.equal(bytes.length,entry.size);assert.equal(hash(bytes),entry.hash);
    assert.deepEqual(service.market.archive.put(bytes),entry);
  }
  service.store.put('market_asset',asset);service.store.put('market_version',version);
  return asset;
}

async function colorfulSubjectBounds(page,png){
  // Analyze an actual browser screenshot, never a substituted runtime frame.
  // The 2D stage is gray; the imported adventurer supplies the colored pixels.
  return page.evaluate(async base64=>{
    const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
    const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);
    const {data}=context.getImageData(0,0,image.width,image.height);
    let left=image.width,top=image.height,right=-1,bottom=-1,count=0;
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
      const i=(y*image.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
      if(data[i+3]<128||Math.max(r,g,b)-Math.min(r,g,b)<30)continue;
      left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);count++;
    }
    return {width:image.width,height:image.height,left,top,right,bottom,count,subject_height:bottom-top+1,subject_width:right-left+1};
  },png.toString('base64'));
}

async function renderedPoseDifference(page,first,second){
  return page.evaluate(async values=>{
    const decode=async base64=>{
      const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
      const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);
      return {width:image.width,height:image.height,pixels:context.getImageData(0,0,image.width,image.height).data};
    };
    const a=await decode(values[0]),b=await decode(values[1]);
    if(a.width!==b.width||a.height!==b.height)throw Error('pose screenshots changed size');
    let changed=0;
    // Compare the character area; leave the HTML feedback overlay and borders out.
    for(let y=Math.floor(a.height*.15);y<a.height*.8;y++)for(let x=Math.floor(a.width*.2);x<a.width*.8;x++){
      const i=(y*a.width+x)*4;
      if(Math.abs(a.pixels[i]-b.pixels[i])+Math.abs(a.pixels[i+1]-b.pixels[i+1])+Math.abs(a.pixels[i+2]-b.pixels[i+2])>45)changed++;
    }
    return {width:a.width,height:a.height,changed_pixels:changed};
  },[first.toString('base64'),second.toString('base64')]);
}

test('one generic Godot stage previews real 3D and 2D market characters, including when an authored scene exists',{
  skip:!existsSync(marketDatabase),timeout:900000,
},async t=>{
  const evidence=join(root,'.local/creation-verification/prefab-automatic-preview');mkdirSync(evidence,{recursive:true});
  const data=mkdtempSync(join(evidence,'case-')),origin='http://127.0.0.1:48921';
  const report={ok:false,data,scope:'Read-only copy of the real official skater asset, isolated source import, real canonical Web build and original prefab-lab/GamePlay components; no fabricated engine messages',checks:[]};
  let service,browser,page;
  const server=createServer(async(req,res)=>{try{
    if(await service.request(req,res))return;
    if(service.builds.webRequest(req,res))return;
    const path=new URL(req.url,origin).pathname;
    if(/^\/[a-z][a-z0-9-]*\.(js|css)$/.test(path)&&existsSync(join(root,'apps/creation-workspace',path.slice(1)))){
      res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(readFileSync(join(root,'apps/creation-workspace',path.slice(1))));return;
    }
    if(['/packages/scene/transform.mjs','/packages/contracts/authoring-references.mjs','/packages/contracts/viewport-annotations.mjs'].includes(path)){
      res.setHeader('content-type','text/javascript');res.end(readFileSync(join(root,path.slice(1))));return;
    }
    if(path==='/harness'){
      res.setHeader('content-type','text/html');
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/prefab-lab.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#host{position:relative;width:100vw;height:100vh}</style></head><body><div id="host"></div></body></html>');return;
    }
    res.writeHead(404);res.end();
  }catch(error){res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(48921,'127.0.0.1',yes);});
  service=isolatedService({server,root,data,origin,publicPlay:true});
  t.after(async()=>{
    await browser?.close();await service.close();await new Promise(yes=>server.close(yes));
    report.finished_at=new Date().toISOString();writeFileSync(join(data,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log('AUTOMATIC_PREFAB_EVIDENCE '+data);
  });
  const owner=service.store.register({name:'Automatic preview owner',password:'Independent-preview-password'});
  const viewer=service.store.register({name:'Automatic preview viewer',password:'Independent-preview-password'});
  const player=service.store.register({name:'Automatic preview public player',password:'Independent-preview-password'});
  async function request(method,path,user,body,expected=200){
    const response=await fetch(origin+'/creation-api'+path,{method,headers:{origin,authorization:'Bearer '+user.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
  }
  const created=await service.createProject(owner.user,{name:'Automatic skater preview acceptance',template:'empty'}),projectId=created.project.id;
  const route=`/projects/${projectId}/branches/main`;
  const invite=await request('POST',`/projects/${projectId}/invites`,owner,{role:'viewer'},201);
  await request('POST','/invites/join',viewer,{code:invite.code});
  const asset=copyOfficialAsset(service);
  const imported=await service.market.importToProject(owner.user,projectId,'main',{asset_id:asset.id,version:asset.version,transaction_id:'automatic-preview-skater',base_revision:created.branch.head});
  const before=service.store.branchView(owner.user,projectId,'main'),subject=before.manifest.resources[imported.import.resource_id];
  assert.equal(subject.kind,'prefab');
  assert.equal(Object.values(before.manifest.resources).filter(row=>row.purpose==='prefab_test').length,0);
  const sourceHash=hash(before.manifest),sourceFilesHash=hash(before.manifest.source_files),resourceCount=Object.keys(before.manifest.resources).length;
  report.asset={id:asset.id,version:asset.version};report.project_id=projectId;report.source_revision=before.head;report.subject_id=subject.id;
  const listing=await request('GET',route+'/prefab-tests',viewer);
  assert.deepEqual(listing.scenarios,[]);
  await request('POST',route+'/prefab-test-build',player,{source_revision:before.head,entry_scene_id:subject.id,request_id:'player-denied'},403);
  console.log('AUTOMATIC_PREFAB_IMPORTED '+JSON.stringify(report.asset));

  browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader','--mute-audio']});
  page=await browser.newPage({viewport:{width:1512,height:1000}});
  const browserErrors=[];
  page.on('pageerror',error=>browserErrors.push(error.message));
  page.on('console',message=>{if(/SCRIPT ERROR|Parse Error|RuntimeError/.test(message.text()))browserErrors.push(message.text());});
  try{
    await page.goto(origin+'/harness');
    await page.evaluate(async({token,projectId,revision,subject})=>{
      const {mountPrefabLab}=await import('/prefab-lab.js');
      window.previewState=null;window.previewPackets=[];window.previewErrors=[];window.previewRequests=[];
      addEventListener('message',event=>{if(event.origin===location.origin&&event.data?.type==='prefab_test_state'){window.previewState=event.data;window.previewPackets.push(event.data);if(window.previewPackets.length>200)window.previewPackets.shift();}});
      const request=async(path,options={})=>{
        previewRequests.push({path,method:options.method??'GET'});
        const response=await fetch('/creation-api/'+path,{...options,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})});
        const value=await response.json();if(!response.ok)throw Error(value.error||JSON.stringify(value));return value;
      };
      window.lab=mountPrefabLab(document.querySelector('#host'),{request,getContext:()=>({role:'viewer',canWrite:false}),onError:error=>previewErrors.push(String(error))});
      lab.open({subject,scenarios:[],revision,projectId,branchId:'main'});
    },{token:viewer.token,projectId,revision:before.head,subject:{id:subject.id,name:subject.name,kind:'prefab'}});
    assert.equal(await page.locator('.prefab-lab iframe').count(),1,'opening without an authored test scene starts a real runtime build');
    await page.waitForFunction(()=>previewState?.animations?.length>1||previewErrors.length>0,null,{timeout:600000});
    assert.deepEqual(await page.evaluate(()=>previewErrors),[]);
    const initial=await page.evaluate(()=>structuredClone(previewState));
    assert.equal(initial.source_revision,before.head);assert.equal(initial.resource_id,subject.id);
    assert.ok(initial.current?.name,'initial animation is selected automatically');assert.equal(initial.playing,true);
    const slider=page.getByRole('slider',{name:'动画播放位置'});
    assert.equal(await slider.isVisible(),true);assert.equal(await slider.isEnabled(),true);
    assert.equal(await page.locator('.animation-key,.animation-track,.animation-ticks').count(),0,'only the scrubber remains below the animation controls');
    await page.waitForFunction(time=>previewState.playing&&Math.abs(previewState.time-time)>.02,initial.time,{timeout:15000});
    await page.screenshot({path:join(data,'automatic-skater-initial.png')});
    const clip=initial.animations.find(row=>row.name!==initial.current.name&&row.duration>.2&&row.name!=='RESET');
    assert.ok(clip,'actual imported model contains another playable animation');
    const select=page.getByRole('combobox',{name:'动画',exact:true});
    if(clip.player!==initial.current.player)await page.getByRole('combobox',{name:'动画播放器',exact:true}).selectOption(clip.player);
    await select.selectOption(clip.name);
    await page.waitForFunction(clip=>previewState.current?.player===clip.player&&previewState.current?.name===clip.name&&previewState.playing&&previewState.time>.04,clip,{timeout:15000});
    assert.equal(await slider.isEnabled(),true);
    await page.getByRole('button',{name:'暂停动画',exact:true}).click();
    await page.waitForFunction(()=>previewState.playing===false,null,{timeout:15000});
    await slider.evaluate(node=>{
      window.scrubChanges=0;window.scrubInputs=0;
      node.addEventListener('change',()=>scrubChanges++);node.addEventListener('input',()=>scrubInputs++);
    });
    const dragTimes=[.15,.65].map(fraction=>Number((clip.duration*fraction).toFixed(3))),dragFeedback=[],dragFrames=[];
    for(const [index,time]of dragTimes.entries()){
      await slider.evaluate((node,time)=>{node.value=String(time);node.dispatchEvent(new Event('input',{bubbles:true}));},time);
      await page.waitForFunction(time=>Math.abs(previewState.time-time)<.003&&!previewState.playing,time,{timeout:15000});
      assert.equal(await page.evaluate(()=>scrubChanges),0,'native pose updates before releasing the scrubber');
      assert.ok(Math.abs(Number(await slider.inputValue())-time)<.003,'runtime feedback keeps the current drag position');
      dragFeedback.push({input_time:time,observed_time:await page.evaluate(()=>previewState.time),change_events:await page.evaluate(()=>scrubChanges)});
      dragFrames.push(await page.locator('.prefab-lab iframe').screenshot({path:join(data,`live-drag-pose-${index+1}.png`)}));
    }
    const poseDifference=await renderedPoseDifference(page,dragFrames[0],dragFrames[1]);
    assert.ok(poseDifference.changed_pixels>100,JSON.stringify(poseDifference));
    const seek=Math.min(clip.duration*.4,clip.duration-.01);
    await slider.evaluate((node,time)=>{node.value=String(time);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));},seek);
    await page.waitForFunction(time=>Math.abs(previewState.time-time)<.02&&!previewState.playing,seek,{timeout:15000});
    assert.equal(await page.evaluate(()=>scrubChanges),1,'release commits the final position after live input-only updates');
    assert.ok(Math.abs(Number(await slider.inputValue())-seek)<.003,'the final drag endpoint remains selected');
    assert.equal(await select.inputValue(),clip.name);
    await page.screenshot({path:join(data,'automatic-skater-switched.png')});
    report.observed={initial:compactState(initial),switched:compactState(await page.evaluate(()=>structuredClone(previewState)))};
    report.live_drag={feedback:dragFeedback,final_time:await page.evaluate(()=>previewState.time),input_events:await page.evaluate(()=>scrubInputs),change_events:await page.evaluate(()=>scrubChanges),pose_difference:poseDifference};
    const jobId=await page.locator('.prefab-lab-runtime').getAttribute('data-game-build');
    const {job}=await request('GET','/builds/'+jobId,viewer);
    assert.equal(job.status,'completed');assert.equal(job.purpose,'prefab_test');assert.equal(job.entry_scene_id,subject.id);assert.equal(job.source_revision,before.head);
    const release=JSON.parse(readFileSync(join(data,'builds',job.id,'project/atelier_runtime/release.json')));
    assert.equal(release.prefab_test.subject_id,subject.id);assert.equal(release.prefab_test.automatic,true);
    assert.match(release.scenes[subject.id].native_scene_path,/atelier_runtime/);
    assert.ok(release.scenes[subject.id].objects.every(row=>row.native_path==='Subject'||row.native_path.startsWith('Subject/')));
    report.build={id:job.id,canonical_identity:job.canonical_identity,source_revision:job.source_revision};
    assert.equal(await page.evaluate(()=>previewRequests.some(row=>row.method==='POST'&&row.path.endsWith('/prefab-tests'))),false);
    await page.getByRole('button',{name:'管理测试场景',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'打开测试场景',exact:true}).isVisible(),false);
    assert.equal(await page.getByRole('button',{name:'＋ 创建测试场景',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'关闭辅助面板',exact:true}).click();
    await slider.evaluate((node,time)=>{
      node.value=String(time);node.dispatchEvent(new Event('input',{bubbles:true}));
      window.lab.close(); // Close in the same task, before its scheduled animation frame.
    },clip.duration*.8);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.prefab-lab iframe').count(),0);
    assert.deepEqual(await page.evaluate(()=>previewErrors),[],'closing a pending live seek leaves no late runtime failure');
    assert.deepEqual(browserErrors,[]);
    const after=service.store.branchView(owner.user,projectId,'main');
    assert.equal(after.head,before.head);assert.equal(hash(after.manifest),sourceHash);assert.equal(hash(after.manifest.source_files),sourceFilesHash);
    assert.equal(Object.keys(after.manifest.resources).length,resourceCount);
    assert.deepEqual((await request('GET',route+'/prefab-tests',viewer)).scenarios,[]);
    const ordinaryDirectory=join(data,'ordinary-game-projection'),snapshot=snapshotProjectRuntime(root,ordinaryDirectory);
    await assembleProject({service,user:owner.user,project_id:projectId,branch_id:'main',revision:before.head,entry_scene_id:before.manifest.entry_scene_id,directory:ordinaryDirectory,runtime_source_hash:snapshot.hash,purpose:'game'});
    const ordinaryRelease=JSON.parse(readFileSync(join(ordinaryDirectory,'atelier_runtime/release.json')));
    assert.equal(ordinaryRelease.prefab_test,undefined);
    assert.equal(existsSync(join(ordinaryDirectory,'atelier_runtime/prefab_preview_stage.gd')),false);
    report.checks.push('Real official skater imports into an isolated source with no prefab test scenes','Source viewer opens original prefab lab and starts canonical Web without creating source content','Real imported animations appear automatically, start playing, switch and seek through enabled timeline','Input-only scrubber moves receive multiple real Godot pose updates and visibly different rendered poses before any change event','Final change retains its endpoint; closing during a scheduled input seek disposes the iframe without late errors','Keyframe tracks and dots are absent from the timeline','Player access denied; viewer cannot create or open generated stage as authored source','Source head, full manifest, source file hashes and resource count unchanged after preview','Ordinary game projection excludes automatic stage and prefab test release metadata');

    // A second dimension uses exactly the same native scene/template. Give it
    // a real authored test scene, then prove that default entry still resolves
    // the generic prefab preview and that explicit scene selection still works.
    const secondAsset=copyOfficialAsset(service,'official-2d-maleAdventurer');
    const secondImport=await service.market.importToProject(owner.user,projectId,'main',{asset_id:secondAsset.id,version:secondAsset.version,transaction_id:'automatic-preview-adventurer',base_revision:after.head});
    const secondSource=service.store.branchView(owner.user,projectId,'main'),secondSubject=secondSource.manifest.resources[secondImport.import.resource_id];
    const authoredResult=await request('POST',route+'/prefab-tests',owner,{request_id:'authored-adventurer-lab',base_revision:secondSource.head,subject_id:secondSubject.id,name:'探险家互动测试场景'});
    const secondBefore=service.store.branchView(owner.user,projectId,'main');
    const secondListing=await request('GET',route+'/prefab-tests?subject_id='+secondSubject.id,viewer);
    assert.equal(secondListing.scenarios.length,1);assert.equal(secondListing.scenarios[0].id,authoredResult.resource_id);
    const secondSourceHash=hash(secondBefore.manifest),secondFilesHash=hash(secondBefore.manifest.source_files),secondResourceCount=Object.keys(secondBefore.manifest.resources).length;
    console.log('AUTOMATIC_PREFAB_SECOND_IMPORTED '+JSON.stringify({id:secondAsset.id,authored_scene:authoredResult.resource_id}));
    await page.evaluate(({subject,scenarios,revision,projectId})=>{
      window.previewState=null;window.previewPackets=[];window.previewErrors=[];window.previewRequests=[];
      lab.open({subject,scenarios,revision,projectId,branchId:'main'});
    },{subject:{id:secondSubject.id,name:secondSubject.name,kind:'prefab'},scenarios:secondListing.scenarios,revision:secondBefore.head,projectId});
    assert.equal(await page.getByRole('combobox',{name:'测试场景',exact:true}).inputValue(),secondSubject.id,'authored scene does not replace the generic default');
    await page.waitForFunction(()=>previewState?.animations?.length>1||previewErrors.length>0,null,{timeout:600000});
    assert.deepEqual(await page.evaluate(()=>previewErrors),[]);
    const secondInitial=await page.evaluate(()=>structuredClone(previewState));
    assert.equal(secondInitial.resource_id,secondSubject.id);assert.equal(secondInitial.source_revision,secondBefore.head);
    assert.equal(secondInitial.playing,true);assert.ok(secondInitial.current?.name);
    assert.equal(await page.locator('.animation-key,.animation-track,.animation-ticks').count(),0);
    assert.ok(secondInitial.animations.some(clip=>clip.kind==='AnimatedSprite2D'));
    for(const name of secondAsset.animations)assert.ok(secondInitial.animations.some(clip=>clip.name===name),'native 2D animation '+name);
    assert.equal(await slider.isVisible(),true);assert.equal(await slider.isEnabled(),true);
    await page.waitForFunction(time=>previewState.playing&&Math.abs(previewState.time-time)>.02,secondInitial.time,{timeout:15000});
    await page.screenshot({path:join(data,'automatic-adventurer-initial.png')});
    await page.getByRole('button',{name:'播放动画 run',exact:true}).click();
    await page.waitForFunction(()=>previewState.current?.name==='run'&&previewState.playing&&previewState.time>.03,null,{timeout:15000});
    await page.getByRole('button',{name:'暂停动画',exact:true}).click();
    await page.waitForFunction(()=>!previewState.playing,null,{timeout:15000});
    const secondClip=secondInitial.animations.find(clip=>clip.name==='run'),secondSeek=secondClip.duration*.4;
    await slider.evaluate((node,time)=>{node.value=String(time);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));},secondSeek);
    await page.waitForFunction(time=>previewState.current?.name==='run'&&Math.abs(previewState.time-time)<.02&&!previewState.playing,secondSeek,{timeout:15000});
    await page.screenshot({path:join(data,'automatic-adventurer-switched.png')});
    const secondSwitched=await page.evaluate(()=>structuredClone(previewState));
    await page.setViewportSize({width:1050,height:720});
    await page.waitForTimeout(500); // Allow the real iframe/Godot viewport resize and a rendered frame.
    assert.equal(await slider.isVisible(),true);assert.equal(await slider.isEnabled(),true);
    const resizedFrame=await page.locator('.prefab-lab iframe').screenshot({path:join(data,'automatic-adventurer-resized-frame.png')});
    const resizedBounds=await colorfulSubjectBounds(page,resizedFrame);
    assert.ok(resizedBounds.count>500,'the rendered resized viewport contains the actual colored character');
    assert.ok(resizedBounds.left>resizedBounds.width*.02&&resizedBounds.right<resizedBounds.width*.98,JSON.stringify(resizedBounds));
    assert.ok(resizedBounds.top>resizedBounds.height*.02&&resizedBounds.bottom<resizedBounds.height*.98,JSON.stringify(resizedBounds));
    assert.ok(resizedBounds.subject_height>resizedBounds.height*.2&&resizedBounds.subject_height<resizedBounds.height*.85,JSON.stringify(resizedBounds));
    await page.screenshot({path:join(data,'automatic-adventurer-resized.png')});
    await page.setViewportSize({width:1512,height:1000});
    const secondJobId=await page.locator('.prefab-lab-runtime').getAttribute('data-game-build');
    const {job:secondJob}=await request('GET','/builds/'+secondJobId,viewer);
    assert.equal(secondJob.status,'completed');assert.equal(secondJob.entry_scene_id,secondSubject.id);assert.equal(secondJob.purpose,'prefab_test');
    const firstProject=join(data,'builds',job.id,'project'),secondProject=join(data,'builds',secondJob.id,'project');
    const templateHashes={};
    for(const path of ['prefab_preview_stage.tscn','prefab_preview_stage.gd']){
      const first=readFileSync(join(firstProject,'atelier_runtime',path)),second=readFileSync(join(secondProject,'atelier_runtime',path));
      assert.equal(hash(first),hash(second),'both dimensions instantiate identical framework template '+path);templateHashes[path]=hash(first);
    }
    for(const directory of [firstProject,secondProject]){
      const wrapper=readFileSync(join(directory,'atelier_runtime/prefab_preview.tscn'),'utf8');
      assert.match(wrapper,/prefab_preview_stage\.tscn/);assert.match(wrapper,/target_scene\s*=\s*ExtResource/);
    }
    const secondRelease=JSON.parse(readFileSync(join(secondProject,'atelier_runtime/release.json')));
    assert.equal(secondRelease.prefab_test.automatic,true);assert.equal(secondRelease.prefab_test.subject_id,secondSubject.id);
    report.second_case={asset:{id:secondAsset.id,version:secondAsset.version},subject_id:secondSubject.id,authored_scene_id:authoredResult.resource_id,build:{id:secondJob.id,canonical_identity:secondJob.canonical_identity},observed:{initial:compactState(secondInitial),switched:compactState(secondSwitched)},template_hashes:templateHashes,resized_bounds:resizedBounds};
    await page.getByRole('combobox',{name:'测试场景',exact:true}).selectOption(authoredResult.resource_id);
    await page.waitForFunction(id=>previewState?.resource_id===id&&previewState.animations?.length>1||previewErrors.length>0,authoredResult.resource_id,{timeout:600000});
    assert.deepEqual(await page.evaluate(()=>previewErrors),[]);
    assert.equal(await page.evaluate(()=>previewState.resource_id),authoredResult.resource_id,'an explicitly chosen authored scene still runs');
    await page.getByRole('button',{name:'管理测试场景',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'打开测试场景',exact:true}).isVisible(),true);
    await page.getByRole('button',{name:'关闭辅助面板',exact:true}).click();
    await page.getByRole('button',{name:'返回编辑',exact:true}).click();
    assert.equal(await page.locator('.prefab-lab iframe').count(),0);
    assert.deepEqual(browserErrors,[]);
    const secondAfter=service.store.branchView(owner.user,projectId,'main');
    assert.equal(secondAfter.head,secondBefore.head);assert.equal(hash(secondAfter.manifest),secondSourceHash);assert.equal(hash(secondAfter.manifest.source_files),secondFilesHash);
    assert.equal(Object.keys(secondAfter.manifest.resources).length,secondResourceCount);
    assert.deepEqual((await request('GET',route+'/prefab-tests?subject_id='+secondSubject.id,viewer)).scenarios,secondListing.scenarios);
    report.checks.push('Identical generic PackedScene template accepts real 3D AnimationPlayer and 2D AnimatedSprite2D targets','Existing authored scene does not override default generic preview; explicitly selecting it still runs its real canonical scene','Real 2D idle and run animations play and seek through the same timeline','Resized real 2D Web frame retains the full character inside viewport margins at usable scale','Second source head, full manifest, source files and authored scene list remain unchanged by both preview modes');
    report.ok=true;
  }catch(error){
    report.error=error.stack;report.browser_errors=browserErrors;
    if(page){await page.screenshot({path:join(data,'failure.png')}).catch(()=>{});writeFileSync(join(data,'failure.html'),await page.content().catch(()=>''));}
    throw error;
  }
});
