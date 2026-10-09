import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {CreationStore} from '../../services/creation/store.mjs';

// Real original workbench, HTTP and SQLite; disposable content and identities.
// No real Agent, Godot authority, or gameplay execution is started by this test.
const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(resolve(tmpdir(),'atelier-inspector-browser-'));
const evidence=resolve(root,'.local/creation-verification/semantic-inspector',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(evidence,{recursive:true});
const probe=createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
const origin='http://127.0.0.1:'+port,creation=resolve(data,'creation');mkdirSync(resolve(creation,'assets'),{recursive:true});
const store=new CreationStore(resolve(creation,'creation.sqlite')),auth=store.register({name:'Inspector '+randomUUID().slice(0,8),password:randomUUID()}),token=auth.token;
const source=Buffer.from('extends RefCounted\nfunc initialize(_ctx):\n\treturn {"ok":true}\n'),digest=createHash('sha256').update(source).digest('hex');
writeFileSync(resolve(creation,'assets',digest+'.gd'),source);store.put('creator_asset',{id:digest,ext:'gd',builtin:true,bytes:source.length});
const specs=[{id:'speed',name:'移动速度',type:'number',default:2,min:0,max:10,step:.25,unit:'米/秒'},
  {id:'count',name:'奖励数量',type:'integer',default:3,min:1,max:20,step:1,unit:'个'},
  {id:'enabled',name:'启用奖励',type:'boolean',default:true},
  {id:'label',name:'显示名称',type:'string',default:'宝箱'},
  {id:'color',name:'提示颜色',type:'color',default:'#335577'},
  {id:'difficulty',name:'奖励等级',type:'enum',default:'normal',options:[{value:'normal',label:'普通'},{value:'rare',label:'稀有'}]}];
const values=Object.fromEntries(specs.map(property=>[property.id,property.default]));
const properties=specs.map(property=>({...property,description:'此属性的详细说明 '+property.name,instance_editable:true,binding:{node_id:'core',behavior_id:'logic',property_key:property.id}}));
const node=(id,extra={})=>({id,name:id==='core'?'宝箱定义':'测试宝箱',kind:'anchor',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],components:{behaviors:[{id:'logic',api:1,script_hash:digest,script_url:'/preview-assets/'+digest+'.gd',properties:structuredClone(values)}]},...extra});
const created=store.createProject(auth.user,{name:'隔离紧凑属性检查'},{schema:'creation-flat-1',entry_scene_id:'scene',resources:{scene:{id:'scene',name:'测试关卡',kind:'scene',design:{category:'object',description:'这是位于属性末尾的功能描述。',exposed_properties:properties.map(property=>({...property,binding:{...property.binding,node_id:'chest'}})),relations:[]},objects:[node('chest')]},chest:{id:'chest',name:'宝箱',kind:'prefab',design:{category:'object',description:'这是位于属性末尾的功能描述。',exposed_properties:properties,relations:[]},objects:[node('core')]}}});
const project=created.project.id,old=store.createSession(auth.user,project,'main',{title:'原目标会话',execution_mode:'goal'});
store.updateSession(auth.user,old.id,{draft:'不要覆盖：旧会话的未发送需求。'});store.put('creator_goal',{id:'retained-goal',session_id:old.id,run_id:'retained-run',objective:'保留旧目标',status:'completed'});store.close();
let child,browser,page,serverLog='';const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
const report={origin,scope:'Original workbench UI + actual isolated HTTP/SQLite; no live Agent or gameplay proof',cases:[],completed:false};
async function api(method,path,body){const response=await fetch(origin+'/creation-api/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+token},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(response.ok,await response.clone().text());return response.json();}
async function check(name,fn){await fn();report.cases.push({name,status:'passed'});console.log('PASS '+name);}
const detail=()=>api('GET',`projects/${project}/branches/main/semantic-resources?resource_id=scene&object_id=chest`);
async function expectValue(id,value){for(let i=0;i<100;i++){const model=await detail();if(model.properties.find(property=>property.id===id)?.value===value){await wait(200);return;}await wait(40);}assert.equal((await detail()).properties.find(property=>property.id===id)?.value,value);}
try{
  child=spawn(process.execPath,['services/preview/server.mjs'],{cwd:root,env:{...process.env,WORLD_ATELIER_PREVIEW_PORT:String(port),WORLD_ATELIER_PREVIEW_DATA:data,WORLD_ATELIER_CREATION_DATA:creation,WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1',WORLD_ATELIER_LAN:'0',WORLD_ATELIER_PUBLIC_PLAY:'0'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',bytes=>serverLog+=bytes);child.stderr.on('data',bytes=>serverLog+=bytes);
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(serverLog);try{if((await fetch(origin+'/creation-api/health')).ok)break;}catch{}await wait(50);}
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(value=>sessionStorage.setItem('world-atelier-creator-token',value),token);page=await context.newPage();
  const errors=[],requests=[];report.page_errors=errors;report.requests=requests;page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push({url:request.url(),method:request.method()}));
  await page.goto(origin+`/creation-workspace.html#/games/${project}/branches/main`);await page.locator('#workbench').waitFor({state:'visible'});await page.locator('[data-select="chest"]').click();
  await page.locator('#semanticInspector [data-property-id="speed"]').waitFor({state:'visible'});
  const panel=page.locator('#semanticInspector');
  await check('compact property rows show semantic controls and keep the description after properties',async()=>{
    assert.equal(await panel.locator('[data-property-id]').count(),6);
    const order=await panel.evaluate(root=>{const property=root.querySelector('[data-property-id]'),description=root.querySelector('.semantic-description-read,.semantic-description');return Boolean(property&&description&&(property.compareDocumentPosition(description)&Node.DOCUMENT_POSITION_FOLLOWING));});assert.equal(order,true);
    assert.equal(await panel.evaluate(root=>root.scrollWidth<=root.clientWidth),true);
    await page.screenshot({path:resolve(evidence,'inspector-desktop.png')});
  });
  await check('quick actions precede preview and properties collapse as a group with hover details',async()=>{
    const dock=page.locator('#semanticActionDock'),preview=page.locator('#objectPreviewDock');
    assert.equal(await dock.getByRole('button').count(),2);assert.ok((await dock.boundingBox()).y<(await preview.boundingBox()).y);
    assert.equal(await page.locator('#inspectorBody .semantic-spatial-editor').count(),1,'spatial controls must not be duplicated');
    const row=panel.locator('[data-property-id="speed"]'),tooltip=row.locator('[role="tooltip"]');
    assert.ok((await row.boundingBox()).height<=40,'property remains a compact single row');assert.ok((await row.locator('input').boundingBox()).width>=130,'numeric field has usable width');
    assert.equal(await tooltip.isVisible(),false);await row.locator('.semantic-property-name').hover();await tooltip.waitFor({state:'visible'});assert.match(await tooltip.innerText(),/详细说明.*范围.*步长/);
    await page.screenshot({path:resolve(evidence,'inspector-tooltip.png')});await page.mouse.move(100,100);
    const summary=panel.locator('details.semantic-parameters>summary');await summary.click();assert.equal(await row.isVisible(),false);assert.equal(await panel.locator('.semantic-description-read').isVisible(),true);
    const fixed=await detail();await api('POST',`projects/${project}/branches/main/semantic-resources`,{action:'set_property',transaction_id:randomUUID(),base_revision:fixed.revision,expected_version:fixed.target.expected_version,resource_id:'scene',object_id:'chest',property_id:'count',value:4});await wait(300);
    assert.equal(await panel.locator('details.semantic-parameters').evaluate(element=>element.open),false,'source refresh preserves the collapsed group');
    await page.screenshot({path:resolve(evidence,'inspector-collapsed.png')});await summary.click();await row.waitFor({state:'visible'});
  });
  await check('real number integer switch string color and enum controls persist exact typed values',async()=>{
    for(const [id,value]of [['speed',4.25],['count',8],['label','独立测试宝箱']]){const input=panel.locator(`[data-property-id="${id}"] input:not([type=range])`).first();await input.fill(String(value));await input.press('Tab');await expectValue(id,value);}
    await panel.locator('[data-property-id="enabled"] input[type=checkbox]').uncheck();await expectValue('enabled',false);
    const color=panel.locator('[data-property-id="color"] input[type=color]');await color.fill('#aabbcc');await color.dispatchEvent('change');await expectValue('color','#aabbcc');
    await panel.locator('[data-property-id="difficulty"] select').selectOption('rare');await expectValue('difficulty','rare');
    const current=await api('GET',`projects/${project}/branches/main`);assert.deepEqual(current.manifest.resources.chest.objects[0].components.behaviors[0].properties,values,'editing a direct scene object preserves the unrelated prefab defaults');
  });
  await check('invalid typed input cannot persist a new value',async()=>{
    const input=panel.locator('[data-property-id="count"] input:not([type=range])').first();await input.fill('8.5');await input.press('Tab');await wait(100);assert.equal((await detail()).properties.find(property=>property.id==='count').value,8);await input.fill('8');await input.press('Tab');
  });
  await check('feature request opens a new private session and leaves old draft and goal unchanged',async()=>{
    const oldBefore=await api('GET','sessions/'+old.id);assert.equal(oldBefore.execution_mode,'goal');
    const before=(await api('GET',`projects/${project}/branches/main/sessions`)).sessions;
    await page.locator('#semanticActionDock').getByRole('button',{name:'修改功能',exact:true}).click();await page.getByRole('textbox',{name:'发送给选定会话的草稿',exact:true}).waitFor({state:'visible'});
    for(let i=0;i<100;i++){if((await api('GET',`projects/${project}/branches/main/sessions`)).sessions.length>before.length)break;await wait(40);}
    const after=(await api('GET',`projects/${project}/branches/main/sessions`)).sessions,newSession=after.find(session=>!before.some(previous=>previous.id===session.id));assert.ok(newSession);
    const fresh=await api('GET','sessions/'+newSession.id);assert.equal(fresh.execution_mode,'default');assert.equal(fresh.goals.length,0);assert.equal(fresh.draft_attachments.length,1);assert.equal(fresh.draft_attachments[0].object_id,'chest');
    assert.doesNotMatch(await page.locator('#sessionDraft').inputValue(),/不要覆盖/);assert.match(await page.locator('#sessionDraft').inputValue(),/测试宝箱/);
    const oldAfter=await api('GET','sessions/'+old.id);assert.equal(oldAfter.draft,oldBefore.draft);assert.deepEqual(oldAfter.goals,oldBefore.goals);assert.equal(oldAfter.execution_mode,'goal');
    await page.screenshot({path:resolve(evidence,'inspector-new-session.png')});
  });
  await check('control-property request creates a second fresh session instead of reusing the first request draft',async()=>{
    await wait(800);const before=(await api('GET',`projects/${project}/branches/main/sessions`)).sessions;
    const first=before.find(session=>session.id!==old.id),firstBefore=await api('GET','sessions/'+first.id);
    await page.locator('#closeChat').click();await page.locator('#semanticActionDock').getByRole('button',{name:'控制属性需求',exact:true}).click();
    let after=[];for(let i=0;i<100;i++){after=(await api('GET',`projects/${project}/branches/main/sessions`)).sessions;if(after.length>before.length)break;await wait(40);}
    const second=after.find(session=>!before.some(previous=>previous.id===session.id));assert.ok(second);assert.notEqual(second.id,first.id);
    await page.waitForFunction(()=>document.querySelector('#sessionDraft')?.value.includes('增加可调属性'));
    assert.equal((await api('GET','sessions/'+second.id)).draft_attachments.length,1);
    const firstAfter=await api('GET','sessions/'+first.id);assert.equal(firstAfter.draft,firstBefore.draft);assert.deepEqual(firstAfter.draft_attachments,firstBefore.draft_attachments);
    assert.equal((await api('GET','sessions/'+old.id)).draft,'不要覆盖：旧会话的未发送需求。');
    await page.screenshot({path:resolve(evidence,'inspector-property-session.png')});
  });
  assert.deepEqual(errors,[]);assert.equal(requests.some(request=>request.method==='POST'&&/\/turns$/.test(request.url)),false);report.requests=requests;report.page_errors=errors;report.completed=true;
}catch(error){report.error=error.stack;if(page){report.visible_text=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});}throw error;}
finally{await browser?.close();if(child&&child.exitCode===null){const exited=new Promise(ok=>child.once('exit',ok));child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);await exited;clearTimeout(timeout);}rmSync(data,{recursive:true,force:true});report.temporary_data_removed=true;report.finished_at=new Date().toISOString();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));writeFileSync(resolve(evidence,'server.log'),serverLog);console.log('BROWSER_REPORT '+resolve(evidence,'report.json'));}
