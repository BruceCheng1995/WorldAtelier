/** Actual Godot Web canvas -> timed capture -> authenticated persisted artwork.
 * Uses an isolated service/data/user/project; no runtime ACKs are fabricated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';

test('real Godot current frame automatically supplies the game and branch cover', {timeout:120000},async t=>{
  const root=resolve(import.meta.dirname,'../..'),data=await mkdtemp(resolve(tmpdir(),'atelier-auto-cover-godot-'));
  const origin='http://127.0.0.1:48924',evidence=resolve(root,'.local/creation-verification/auto-cover-godot',new Date().toISOString().replaceAll(':','-'));
  await mkdir(evidence,{recursive:true});let browser,log='';
  const service=spawn(process.execPath,['tools/start-workspace.mjs'],{cwd:root,env:{...process.env,WORLD_ATELIER_PREVIEW_PORT:'48924',WORLD_ATELIER_PREVIEW_DATA:resolve(data,'preview'),WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_PREVIEW_BUILD:resolve(root,'.local/model-preview/build'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1'},stdio:['ignore','pipe','pipe']});
  service.stdout.on('data',d=>log+=d);service.stderr.on('data',d=>log+=d);
  t.after(async()=>{await browser?.close();if(service.exitCode===null){service.kill('SIGTERM');await new Promise(r=>service.once('exit',r));}await writeFile(resolve(evidence,'service.log'),log);await rm(data,{recursive:true,force:true});});
  await expect.poll(async()=>{if(service.exitCode!==null)throw Error(log);try{return (await fetch(origin+'/creation-api/health')).ok;}catch{return false;}},{timeout:15000}).toBe(true);
  let token;
  async function api(path,{method='GET',body}={}){const response=await fetch(origin+'/creation-api/'+path,{method,headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;}
  const auth=await api('auth/register',{method:'POST',body:{name:'Automatic cover visual test',password:'isolated-cover-validation'}});token=auth.token;
  const created=await api('projects',{method:'POST',body:{name:'真实 Godot 自动截图验证',template:'harbor'}}),p=created.project.id;
  const project=async()=>(await api('bootstrap')).projects.find(x=>x.id===p);
  browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/creation-workspace.html');
  await page.getByLabel('开发者名称',{exact:true}).fill('Automatic cover visual test');await page.getByLabel('密码',{exact:true}).fill('isolated-cover-validation');await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await page.locator('#branchCards [data-enter="main"]').click();
  await expect.poll(async()=>page.locator('#mainPreview').getAttribute('data-loaded-seq'),{timeout:60000}).not.toBeNull();
  await expect(page.locator('#autoCoverStatus')).toContainText(/秒后更新/,{timeout:15000});
  await page.screenshot({path:resolve(evidence,'countdown.png')});
  await expect.poll(async()=>(await project()).presentation?.last_auto_at??null,{timeout:30000}).not.toBeNull();
  const first=await project(),image=first.presentation.images[0];
  assert.equal(image.source,'automatic');assert.equal(image.source_revision,created.branch.head);assert.equal(image.resource_id,created.branch.manifest.entry_scene_id);assert.equal(first.presentation.cover_id,first.branches[0].presentation.cover_id);assert.ok(image.width>100&&image.height>100);
  const download=await fetch(origin+image.url,{headers:{authorization:'Bearer '+token}});assert.equal(download.status,200);await writeFile(resolve(evidence,'automatic-cover.jpg'),Buffer.from(await download.arrayBuffer()));
  const branch=await api(`projects/${p}/branches/main`),doc=branch.manifest.resources[branch.manifest.entry_scene_id],object=doc.objects[0];
  const changed=await api(`projects/${p}/branches/main/transactions`,{method:'POST',body:{transaction_id:'cover-change-after-first',base_revision:branch.head,ops:[{type:'patch_object',resource_id:doc.id,object_id:object.id,expected_version:object.version,patch:{name:'修改后的真实场景对象'}}]}});
  await expect(page.locator('#autoCoverStatus')).toContainText(/秒后更新/,{timeout:15000});
  await expect.poll(async()=>(await project()).presentation.images[0]?.source_revision,{timeout:30000}).toBe(changed.revision);
  const second=await project();assert.equal(second.presentation.images.length,1);assert.equal(second.branches[0].presentation.images.length,1);assert.ok(second.presentation.last_auto_at>first.presentation.last_auto_at);
  await page.getByRole('button',{name:'世界工坊 · 游戏首页',exact:true}).click();
  await expect(page.locator('.game-cover img')).toBeVisible();await expect.poll(()=>page.locator('.game-cover img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(100);
  await page.screenshot({path:resolve(evidence,'catalog-auto-cover.png'),fullPage:true});
  assert.deepEqual(errors,[]);await writeFile(resolve(evidence,'result.json'),JSON.stringify({ok:true,scope:'real Godot editor canvas capture, post-edit countdown and persisted cover; no gameplay claim',first_revision:first.presentation.images[0].source_revision,second_revision:second.presentation.images[0].source_revision,dimensions:[image.width,image.height],errors},null,2));
  console.log('Actual Godot cover evidence: '+evidence);
});
