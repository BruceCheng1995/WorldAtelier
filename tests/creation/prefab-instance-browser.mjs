import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';
import {HIERARCHY_SCHEMA,emptyDocument} from '../../services/creation/hierarchy.mjs';
import {hierarchyRuntimeId} from '../../services/creation/hierarchy-view.mjs';
import {identityTransform} from '../../packages/scene/transform.mjs';

// Real original workbench and server, independent ephemeral data and port.
// Run once normally for legacy flat documents (production's current gate), and
// once with --hierarchy for the full stable-address document protocol.
// Agent/authority executors are disabled; no Agent or gameplay outcome claimed.
const hierarchy=process.argv.includes('--hierarchy'),mode=hierarchy?'hierarchy':'flat';
const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(resolve(tmpdir(),'atelier-instance-'+mode+'-'));
const evidence=resolve(root,'.local/creation-verification/prefab-instance',new Date().toISOString().replace(/[:.]/g,'-')+'-'+mode);mkdirSync(evidence,{recursive:true});
const socket=createServer();await new Promise(ok=>socket.listen(0,'127.0.0.1',ok));const port=socket.address().port;await new Promise(ok=>socket.close(ok));
const origin='http://127.0.0.1:'+port,creation=resolve(data,'creation');mkdirSync(resolve(creation,'assets'),{recursive:true});
const store=new CreationStore(resolve(creation,'creation.sqlite')),auth=store.register({name:'Instance '+randomUUID().slice(0,8),password:randomUUID()}),token=auth.token;
const bytes=Buffer.from('extends RefCounted\nfunc initialize(_ctx):\n\treturn {"ok":true}\n'),digest=createHash('sha256').update(bytes).digest('hex');
writeFileSync(resolve(creation,'assets',digest+'.gd'),bytes);store.put('creator_asset',{id:digest,ext:'gd',builtin:true,bytes:bytes.length});
const values={reward:3,enabled:true,policy:'definition-only'},properties=[
  {id:'reward',name:'奖励数量',type:'integer',default:3,min:1,max:20,step:1,instance_editable:true},
  {id:'enabled',name:'启用奖励',type:'boolean',default:true,instance_editable:true},
  {id:'policy',name:'仅定义可改规则',type:'string',default:'definition-only',instance_editable:false},
].map(property=>({...property,description:'详情 '+property.name,binding:{node_id:'core',behavior_id:'logic',property_key:property.id}}));
const behavior=()=>({id:'logic',api:1,script_hash:digest,script_url:'/preview-assets/'+digest+'.gd',properties:structuredClone(values)});
const flat=id=>({id,name:'宝箱',kind:'anchor',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],components:{behaviors:[behavior()]}});
const design={category:'object',description:'由预制件统一定义的只读功能说明。',exposed_properties:properties,relations:[]};
const scene={id:'scene',name:'实例测试场景',kind:'scene',objects:[]};
const prefab={id:'chest',name:'宝箱',kind:'prefab',design,objects:[flat('core')]};
const made=store.createProject(auth.user,{name:'预制件实例 '+mode},{schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene,chest:prefab}}),project=made.project.id;
if(hierarchy)store.apply(auth.user,project,'main',{transaction_id:randomUUID(),base_revision:made.branch.head,expected_head:made.branch.head,ops:[{type:'migrate_hierarchy'}]});
const current=()=>store.branchView(auth.user,project,'main');
const addOperation=id=>hierarchy?{type:'instantiate_prefab',resource_id:'scene',instance_id:id,expected_version:null,instance:{instance_id:id,prefab_id:'chest',prefab_revision:current().manifest.resources.chest.version,parent_id:current().manifest.resources.scene.root_id,transform:identityTransform(),overrides:[]}}:{type:'put_object',resource_id:'scene',object_id:id,expected_version:null,object:{...flat(id),prefab:'chest',prefab_node_id:'core'}};
store.apply(auth.user,project,'main',{transaction_id:randomUUID(),base_revision:current().head,ops:['one','two'].map(addOperation)});
const definitionRoot=hierarchy?current().manifest.resources.chest.root_id:null;store.close();
const address=id=>({project_id:project,branch_id:'main',resource_id:'scene',instance_path:[id],definition_node_id:definitionRoot});
const runtimeId=id=>hierarchy?hierarchyRuntimeId(address(id)):id;
let child,browser,page,serverLog='';const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
const report={mode,origin,scope:'Original workbench, real HTTP + SQLite; no real Agent execution',cases:[],completed:false};
async function api(method,path,body){const response=await fetch(origin+'/creation-api/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+token},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
const branch=()=>api('GET',`projects/${project}/branches/main`);
const detail=id=>api('GET',`projects/${project}/branches/main/semantic-resources?resource_id=scene&`+(hierarchy?'address='+encodeURIComponent(JSON.stringify(address(id))):'object_id='+id));
const selected=id=>page.locator(`[data-select="${runtimeId(id)}"]`);
async function check(name,fn){await fn();report.cases.push({name,status:'passed'});console.log('PASS '+name);}
async function expectProperty(id,key,value){for(let i=0;i<100;i++){if((await detail(id)).properties.find(property=>property.id===key)?.value===value){await wait(250);return;}await wait(40);}assert.fail('property not persisted: '+id+'/'+key);}
try{
  child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env:{...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:creation,WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_ENABLE_HIERARCHY:hierarchy?'1':'0',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',value=>serverLog+=value);child.stderr.on('data',value=>serverLog+=value);
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(serverLog);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(value=>sessionStorage.setItem('world-atelier-creator-token',value),token);page=await context.newPage();
  const errors=[],requests=[];report.page_errors=errors;report.requests=requests;page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push({url:request.url(),method:request.method()}));
  await page.goto(origin+`/creation-workspace.html#/games/${project}/branches/main`);await page.locator('#workbench').waitFor({state:'visible'});await selected('one').click();
  const panel=page.locator('#semanticInspector');await panel.locator('[data-property-id="reward"]').waitFor({state:'visible'});
  if(hierarchy)await check('ordinary children inside a mount retain their node icon instead of becoming independent instances',async()=>{
    const mount=selected('one');if(await mount.getAttribute('aria-expanded')==='false')await mount.locator('[data-tree-fold]').click();
    const childId=hierarchyRuntimeId({...address('one'),definition_node_id:'core'}),childRow=page.locator(`[data-select="${childId}"]`);
    await childRow.waitFor({state:'visible'});assert.notEqual(await childRow.getAttribute('data-prefab-role'),'instance');
    const glyphs=await childRow.locator('svg use').evaluateAll(elements=>elements.map(element=>element.getAttribute('href')));
    assert.equal(glyphs.includes('#i-instance'),false);assert.ok(glyphs.includes('#i-pin'),'anchor child keeps its spatial-anchor icon');
    assert.equal(await mount.getAttribute('data-prefab-role'),'instance');
  });
  await check('instances show only allowed parameters and a readonly description without implementation actions or obsolete color/context controls',async()=>{
    assert.equal(await panel.locator('[data-property-id]').count(),2);assert.equal(await panel.locator('[data-property-id="policy"]').count(),0);
    assert.equal(await panel.locator('textarea').count(),0);assert.match(await panel.locator('.semantic-description-read').innerText(),/统一定义/);
    assert.equal(await page.locator('#semanticActionDock').count(),0);
    const spatial=page.locator('#semanticSpatialEditor');assert.equal(await spatial.locator('input[type=color]').count(),0);assert.equal(await spatial.locator('.model-actions').count(),0);assert.doesNotMatch(await spatial.innerText(),/固定上下文|颜色|修改逻辑|引擎逻辑|修改功能|控制属性需求/);
    assert.equal(await page.getByRole('button',{name:'修改功能',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'控制属性需求',exact:true}).count(),0);
    assert.equal(await selected('one').getAttribute('data-prefab-role'),'instance');assert.equal(await selected('two').getAttribute('data-prefab-role'),'instance');
    assert.ok((await selected('one').locator('svg use').evaluateAll(elements=>elements.map(element=>element.getAttribute('href')))).includes('#i-instance'));
    assert.match(await selected('one').innerText(),/宝箱 1/);assert.match(await selected('two').innerText(),/宝箱 2/);
    await page.screenshot({path:resolve(evidence,'instance-panel.png')});
  });
  await check('saving instance parameters changes only that instance and retains definition-only values',async()=>{
    const input=panel.getByLabel('奖励数量',{exact:true});await input.fill('8');await input.press('Tab');await expectProperty('one','reward',8);
    await panel.getByLabel('启用奖励',{exact:true}).uncheck();await expectProperty('one','enabled',false);
    assert.equal((await detail('two')).properties.find(property=>property.id==='reward').value,3);
    const fixed=await branch(),definition=fixed.manifest.resources.chest;const node=hierarchy?definition.nodes.core:definition.objects[0];assert.deepEqual(node.components.behaviors[0].properties,values);
  });
  await check('instance name edits persist separately and do not rename its sibling or prefab',async()=>{
    await page.locator('#inspectorNameDock .inspector-name').dblclick();const name=page.getByLabel('对象名称',{exact:true});await name.fill('北侧奖励箱');await name.press('Enter');
    for(let i=0;i<100;i++){if((await selected('one').innerText()).includes('北侧奖励箱'))break;await wait(40);}
    assert.match(await selected('one').innerText(),/北侧奖励箱/);assert.match(await selected('two').innerText(),/宝箱 2/);assert.equal((await branch()).manifest.resources.chest.name,'宝箱');
  });
  await check('definition navigation opens editable defaults with a distinct purple component icon and returns to the original instance',async()=>{
    const instanceColor=await selected('one').locator('svg').last().evaluate(element=>getComputedStyle(element).color);
    await panel.getByRole('button',{name:'跳转到预制件',exact:true}).click();await page.locator('#returnToInstance').waitFor({state:'visible'});
    await panel.locator('[data-property-id="policy"]').waitFor({state:'visible'});assert.equal(await page.locator('#semanticActionDock button').count(),2);assert.equal(await panel.locator('textarea').count(),1);
    const component=page.locator('[data-prefab-role="component"]').first();await component.waitFor({state:'visible'});assert.ok((await component.locator('svg use').evaluateAll(elements=>elements.map(element=>element.getAttribute('href')))).includes('#i-component'));
    assert.equal(await component.locator('svg').last().evaluate(element=>getComputedStyle(element).color),instanceColor);
    await page.screenshot({path:resolve(evidence,'definition-panel.png')});await page.locator('#returnToInstance').click();await page.locator('#inspectorNameDock .inspector-name').waitFor({state:'visible'});
    assert.equal(await page.locator('#inspectorNameDock .inspector-name').innerText(),'北侧奖励箱');assert.equal(await selected('one').getAttribute('aria-selected'),'true');assert.equal(await panel.locator('[data-property-id="policy"]').count(),0);assert.equal(await page.locator('#returnToInstance').count(),0);
    await page.screenshot({path:resolve(evidence,'returned-instance.png')});
  });
  assert.deepEqual(errors,[]);assert.equal(requests.some(request=>request.method==='POST'&&/\/turns$/.test(request.url)),false);report.completed=true;
}catch(error){report.error=error.stack;if(page){report.visible_text=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});}throw error;}
finally{await browser?.close();if(child&&child.exitCode===null){const exited=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);await exited;clearTimeout(timeout);}rmSync(data,{recursive:true,force:true});report.temporary_data_removed=true;report.finished_at=new Date().toISOString();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));writeFileSync(resolve(evidence,'server.log'),serverLog);console.log('BROWSER_REPORT '+resolve(evidence,'report.json'));}
