import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,mkdir,rm,realpath} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from '../../services/creation/schema.mjs';
import {fixedScoreBridge} from '../../services/creation/runtime-access.mjs';
import {buildThreeWeb,threeToolchain} from '../../services/creation/three-web-build.mjs';
import {nativeVisualProjection,readVisualBytes} from '../../services/creation/three-native-visuals.mjs';
import {NativeSourceArchive} from '../../services/creation/native-source.mjs';
import {threeSceneProjection} from '../../services/creation/three-scene-projection.mjs';
import {DefaultProjectBundle} from '../../services/creation/default-projects.mjs';
import {prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';

const root=resolve(import.meta.dirname,'../..'),exec=promisify(execFile);
const cases=[
  {name:'俄罗斯方块',file:'neon_stack.cfg',node:'GameUI/Tetris',selector:'#ui [data-best]',read:el=>Number(el.dataset.best)},
  {name:'贪吃蛇',file:'jade_snake.cfg',node:'SnakeGame',selector:'.jade-stat:nth-child(2) b',read:el=>Number(el.textContent)}
];
async function temporary(t){
  const path=await mkdtemp(join(tmpdir(),'wa-score-'));t.after(()=>rm(path,{recursive:true,force:true}));return realpath(path);
}
test('score declaration only resolves inside the actual fixed, branch-owned Godot domain',async t=>{
  const directory=await temporary(t),id='build-score',project=join(directory,id,'project'),namespace='game-test:main';
  await mkdir(join(project,'web'),{recursive:true});
  const config=Buffer.from('[application]\nconfig/name="'+namespace+'"\n');
  const schema=Buffer.from(JSON.stringify({format:'wa-config-high-score-1',file:'score.cfg',section:'records',key:'best'}));
  await writeFile(join(project,'project.godot'),config);await writeFile(join(project,'web/save-schema.json'),schema);
  const job={kind:'application',id,project_id:'game-test',branch_id:'main',storage:{namespace},source_files:[{path:'project.godot',size:config.length,sha256:hash(config)},{path:'web/save-schema.json',size:schema.length,sha256:hash(schema)}]};
  const bridge=fixedScoreBridge({directory},job);assert.equal(bridge.domain.prefix,'/userfs/godot/app_userdata/game-test-main');
  assert.equal(fixedScoreBridge({directory},{...job,branch_id:'other'}),null);
  assert.equal(fixedScoreBridge({directory},{...job,purpose:'prefab_test'}),null);
  await writeFile(join(project,'web/save-schema.json'),schema.toString().replace('score.cfg','other.cfg'));
  assert.equal(fixedScoreBridge({directory},job),null,'modified unpinned source');
  const bad=Buffer.from(schema.toString().replace('score.cfg','../outside.cfg'));
  await writeFile(join(project,'web/save-schema.json'),bad);job.source_files[1]={path:'web/save-schema.json',size:bad.length,sha256:hash(bad)};
  assert.equal(fixedScoreBridge({directory},job),null);
});

async function nativeScore({dir,manifest,bundle,item}){
  const project=join(dir,'native'),engine=process.env.GODOT_BIN||'/Applications/Godot.app/Contents/MacOS/Godot';
  for(const [name,entry] of Object.entries(manifest.source_files)){
    const path=join(project,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,bundle.readObject(entry.hash));
  }
  const probe=`extends SceneTree
func _initialize():
  call_deferred("run")
func run():
  if not FileAccess.file_exists("res://migrated.cfg"):
    var original=ConfigFile.new()
    original.set_value("extra","mute",true)
    original.set_value("records","best",5)
    original.save("res://migrated.cfg")
  var dst = FileAccess.open("user://${item.file}",FileAccess.WRITE)
  dst.store_buffer(FileAccess.get_file_as_bytes("res://migrated.cfg"))
  dst.close()
  var scene=load("res://${manifest.resources[manifest.entry_scene_id].path}").instantiate()
  root.add_child(scene)
  print("WA_SCORE_READ=", scene.get_node("${item.node}").best)
  root.remove_child(scene)
  scene.free()
  quit()
`;
  await writeFile(join(project,'check.gd'),probe);
  const env=prepareExecutionEnvironment({directory:join(dir,'private'),readPaths:[await realpath(engine),project],writePaths:[project]});
  const run=async args=>{
    const cmd=env.command(engine,['--path',project,'--headless','--audio-driver','Dummy',...args],{godot:true,projectPath:project});
    return exec(cmd.command,cmd.args,{...cmd.options,maxBuffer:4*1024*1024,timeout:45000});
  };
  await run(['--import']);
  return async bytes=>{
    if(bytes)await writeFile(join(project,'migrated.cfg'),bytes);
    const result=await run(['--script',join(project,'check.gd')]);
    const match=result.stdout.match(/WA_SCORE_READ=(\d+)/);
    assert.ok(match,result.stderr.slice(-1000));return {best:Number(match[1]),bytes:await readFile(join(project,'migrated.cfg'))};
  };
}

for(const item of cases)test(item.name+' real Three Play and Godot scene read both consented score transfers',
  {skip:!process.env.WA_THREE_TEST_CHROME},async t=>{
    const dir=await temporary(t),bundle=new DefaultProjectBundle(join(root,'content/default-projects')),p=bundle.catalog.projects.find(p=>p.name===item.name);
    const m=bundle.snapshot(p.branches.find(x=>x.id==='main')),namespace=p.id+':main',out=join(dir,'web');
    const domain={policy:'godot-idbfs-save-domain-1',database:'/userfs',prefix:'/userfs/godot/app_userdata/'+p.id+'-main',project_id:p.id,branch_id:'main',namespace};
    const spec=m.source_files['web/save-schema.json'];
    assert.ok(spec,'current fixed default must declare its score format');
    const score_bridge={domain,...JSON.parse(bundle.readObject(spec.hash))};
    const identity={content_key:'score-test',project_id:p.id,branch_id:'main',source_revision:m.source_identity,entry_scene_id:m.entry_scene_id,
      runtime_source_hash:'score-runtime',web_engine:'three',toolchain:{three:threeToolchain(root)}};
    const archive=new NativeSourceArchive(join(dir,'objects'));
    for(const entry of Object.values(m.source_files))archive.put(bundle.readObject(entry.hash));
    await buildThreeWeb({root,out,manifest:m,job:{game_identity:identity,canonical_identity:'score-test',project_id:p.id,branch_id:'main',
      source_revision:m.source_identity,entry_scene_id:m.entry_scene_id,storage:{namespace}},archive,projection:async(manifest,id,read,emit)=>{
      if(!manifest.source_files['web/native-visuals.json'])return threeSceneProjection(manifest,id,read);
      const baked=await nativeVisualProjection({root,data:dir,archive,godot:process.env.GODOT_BIN||'/Applications/Godot.app/Contents/MacOS/Godot'},manifest,id);
      if(baked?.asset)baked.projection.binary={url:emit(baked.asset,await readVisualBytes(baked.asset)),sha256:baked.asset.sha256,size:baked.asset.size};
      return baked?.projection??null;
    }});
    const verifyGodot=await nativeScore({dir,manifest:m,bundle,item});
    const {chromium}=await import('@playwright/test'),browser=await chromium.launch({executablePath:process.env.WA_THREE_TEST_CHROME,headless:true,args:['--mute-audio','--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    t.after(()=>browser.close());
    const page=await browser.newPage(),origin='https://runtime.test';page.setDefaultTimeout(10000);
    const choose=async name=>{try{await page.getByRole('button',{name}).click();}catch(error){throw Error(name+' · '+(await page.locator('body').innerText()).slice(0,400),{cause:error});}};
    let authorized=true;
    await page.route(origin+'/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/renew')return route.fulfill({status:authorized?200:403,contentType:'application/json',body:'{}'});
      if(path==='/setup')return route.fulfill({contentType:'text/html',body:'<body></body>'});
      if(path==='/storage.js'||path==='/host.js')return route.fulfill({contentType:'text/javascript',body:await readFile(join(root,'apps/creation-workspace',path==='/storage.js'?'runtime-storage.js':'runtime-host.js'))});
      if(path==='/three'||path==='/godot'){
        const config={base:'/',runtime_origin:origin,parent_origin:'https://workspace.test',launch_nonce:'score-test',source_revision:m.source_identity,project_id:p.id,branch_id:'main',web_engine:path.slice(1),score_bridge};
        return route.fulfill({contentType:'text/html',body:'<div id="status"></div><script id="runtime-config" type="application/json">'+JSON.stringify(config)+'</script><script src="/host.js" type="module"></script>'});
      }
      if(path==='/web/index.html'&&page.url().endsWith('/godot'))return route.fulfill({contentType:'text/html',body:'<p>独立 Godot 探针读取这份文件</p>'});
      if(path.startsWith('/web/'))return route.fulfill({contentType:path.endsWith('.js')?'application/javascript':path.endsWith('.html')?'text/html':path.endsWith('.json')?'application/json':'application/octet-stream',body:await readFile(join(out,path.slice(5)))});
      return route.fulfill({status:404,body:''});
    });
    await page.goto(origin+'/setup');
    const initial=await verifyGodot(null);assert.equal(initial.best,5);const cfg=initial.bytes.toString();
    // Seed the declared IDBFS file plus an unrelated setting. The host reads
    // only the declared scalar and keeps the old file bytes.
    await page.evaluate(async({domain,file,cfg})=>{
      const {importSaveDomain}=await import('/storage.js');
      await importSaveDomain(domain,{format:'wa-godot-save-transfer-1',prefix:domain.prefix,
        entries:[{key:domain.prefix+'/'+file,value:{timestamp:new Date(),mode:0o100666,contents:new TextEncoder().encode(cfg)}}]});
    },{domain,file:item.file,cfg});
    const webKey='wa.three:'+JSON.stringify([p.id,'main',namespace])+':'+item.file+'/records/best';
    await page.goto(origin+'/three');await page.getByRole('button',{name:'带入最高分并打开'}).waitFor();authorized=false;
    await choose('带入最高分并打开');await page.getByText('当前成绩未同步').waitFor();
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),webKey),null,'Revoked grant cannot write a score');
    authorized=true;
    await page.goto(origin+'/three');await choose('带入最高分并打开');
    const hud=page.frameLocator('#game').locator(item.selector);await hud.waitFor({state:'attached'});assert.equal(await hud.evaluate(item.read),5);
    const canvas=page.frameLocator('#game').locator('canvas').first();await canvas.press('Enter');
    if(item.name==='俄罗斯方块'){await canvas.press('Space');await canvas.press('p');}
    await page.waitForFunction(key=>Number(localStorage.getItem(key))>5,webKey,{timeout:8000});
    const earned=Number(await page.evaluate(key=>localStorage.getItem(key),webKey));
    await page.goto(origin+'/setup');
    await page.goto(origin+'/godot');await choose('使用本端存档');await page.locator('#game').waitFor();
    const read=()=>page.evaluate(async({domain,file})=>{
      const {readSaveDomain}=await import('/storage.js');const record=await readSaveDomain(domain);
      return Array.from(record.entries.find(row=>row.key===domain.prefix+'/'+file).value.contents);
    },{domain,file:item.file});
    assert.equal(Buffer.from(await read()).toString(),cfg);
    await page.goto(origin+'/godot');await choose('带入最高分并打开');await page.locator('#game').waitFor();
    const migrated=Buffer.from(await read());assert.equal(migrated.toString(),cfg.replace('best=5','best='+earned));
    assert.equal((await verifyGodot(migrated)).best,earned);
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),webKey),String(earned));
    t.diagnostic(item.name+' '+m.source_identity+' · Godot '+initial.best+' → Three '+earned+' → Godot '+earned);
  });
