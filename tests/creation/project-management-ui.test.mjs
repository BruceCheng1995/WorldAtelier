/** Real browser + real canonical Godot Web, isolated source/data/port.
 * The small authored animation is test content; no runtime ACKs or captures are mocked. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';

const root=resolve(import.meta.dirname,'../..'),origin='http://127.0.0.1:48924';
test('owner project controls and manual photography from a real running game', {timeout:240000},async t=>{
  const data=await mkdtemp(resolve(tmpdir(),'atelier-manual-cover-ui-'));
  const evidence=resolve(root,'.local/creation-verification/manual-cover-ui',new Date().toISOString().replaceAll(':','-'));
  await mkdir(evidence,{recursive:true});let browser,log='';
  const server=spawn(process.execPath,['tools/start-workspace.mjs'],{cwd:root,env:{...process.env,WORLD_ATELIER_PREVIEW_PORT:'48924',WORLD_ATELIER_PREVIEW_DATA:resolve(data,'preview'),WORLD_ATELIER_CREATION_DATA:resolve(data,'creation'),WORLD_ATELIER_PREVIEW_BUILD:resolve(root,'.local/model-preview/build'),WORLD_ATELIER_DISABLE_AGENT:'1',WORLD_ATELIER_DISABLE_WORLDS:'1'},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
  t.after(async()=>{await browser?.close();if(server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}await writeFile(resolve(evidence,'service.log'),log);await rm(data,{recursive:true,force:true});});
  await expect.poll(async()=>{if(server.exitCode!==null)throw Error(log);try{return (await fetch(origin+'/creation-api/health')).ok;}catch{return false;}},{timeout:20000}).toBe(true);
  let token;
  async function api(path,{method='GET',body}={}){const response=await fetch(origin+'/creation-api/'+path,{method,headers:{origin,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;}
  const credentials={name:'Manual cover browser test',password:'isolated-cover-test-password'};
  const auth=await api('auth/register',{method:'POST',body:credentials});token=auth.token;
  const created=await api('projects',{method:'POST',body:{name:'手动拍摄验证工程',template:'empty'}}),p=created.project.id;
  const other=await api('projects',{method:'POST',body:{name:'另一工程',template:'empty'}});
  const branchPath=`projects/${p}/branches/main`;
  const script=`extends Node2D\nvar elapsed := 0.0\nfunc _process(delta):\n\telapsed += delta\n\tqueue_redraw()\nfunc _draw():\n\tdraw_rect(Rect2(0,0,1000,700), Color("142e3b"))\n\tdraw_circle(Vector2(500,330), 210, Color("235564"))\n\tdraw_circle(Vector2(500,330), 160, Color("337a82"))\n\tdraw_circle(Vector2(500+sin(elapsed)*150,330+cos(elapsed)*150), 32, Color("eed993"))\n\tdraw_line(Vector2(220,590),Vector2(780,590),Color("75d7d0"),4)\n`;
  const scene=`[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scenes/main.gd" id="1"]\n[node name="CoverGame" type="Node2D"]\nscript = ExtResource("1")\nmetadata/wa_node_id = "main-root"\n[node name="Title" type="Label" parent="."]\noffset_left = 330.0\noffset_top = 60.0\noffset_right = 740.0\noffset_bottom = 108.0\ntext = "ORBIT / COVER TEST"\ntheme_override_font_sizes/font_size = 32\n`;
  const tx=await api(branchPath+'/transactions',{method:'POST',body:{transaction_id:'manual-cover-ui-scene',base_revision:created.branch.head,ops:[{type:'put_source_file',path:'scenes/main.gd',expected_hash:null,text:script},{type:'put_source_file',path:'scenes/main.tscn',expected_hash:created.branch.manifest.source_files['scenes/main.tscn'].hash,text:scene}]}});
  const project=async()=>(await api('bootstrap')).projects.find(x=>x.id===p);
  // Keep automatic captures idle so each assertion measures a deliberate click.
  for(const path of [`projects/${p}/presentation`,branchPath+'/presentation'])await api(path,{method:'PATCH',body:{expected_version:0,auto_update:false}});
  browser=await chromium.launch({headless:true,channel:'chrome',args:['--mute-audio','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.goto(origin+'/creation-workspace.html');await page.locator('#authName').fill(credentials.name);await page.locator('#authPassword').fill(credentials.password);await page.locator('#authSubmit').click();
  await expect(page.locator('#gameCards .game-card')).toHaveCount(2);
  await t.test('rename, archive, refresh and restore through owner controls',async()=>{
    await page.locator(`[data-project-rename="${p}"]`).click();await page.locator('#projectName').fill('轨道 · 已重命名');await page.locator('#modalFooter .primary').click();
    await expect(page.locator(`a[data-game="${p}"] h3`)).toHaveText('轨道 · 已重命名');
    await page.locator(`a[data-game="${p}"]`).click();await expect(page.locator('#selectedGameTitle')).toHaveText('轨道 · 已重命名');
    await page.locator('#archiveProject').click();await page.locator('#modalFooter .primary').click();
    await expect(page.locator('#gameStatus')).toHaveValue('archived');await expect(page.locator(`[data-project-restore="${p}"]`)).toBeVisible();
    await page.reload();await page.locator('#gameStatus').selectOption('archived');await expect(page.locator(`[data-project-restore="${p}"]`)).toBeVisible();
    await page.screenshot({path:resolve(evidence,'archived.png'),fullPage:true});
    await page.locator(`[data-project-restore="${p}"]`).click();await page.locator('#modalFooter .primary').click();await expect(page.locator('#modal')).not.toBeVisible();
    await page.locator('#gameStatus').selectOption('active');await expect(page.locator(`a[data-game="${p}"] h3`)).toHaveText('轨道 · 已重命名');
    assert.equal((await api(branchPath)).head,tx.revision);
  });
  await t.test('a late archive response preserves a subsequently opened project and modal',async()=>{
    let release,seen;
    const arrived=new Promise(r=>seen=r),hold=new Promise(r=>release=r);
    await page.route(`**/creation-api/projects/${other.project.id}`,async route=>{if(route.request().method()!=='PATCH')return route.continue();const response=await route.fetch();seen();await hold;await route.fulfill({response});});
    await page.locator(`[data-project-archive="${other.project.id}"]`).click();await page.locator('#modalFooter .primary').click();await arrived;
    await page.locator('#closeModal').click();await page.locator(`a[data-game="${p}"]`).click();await page.locator('#renameProject').click();await page.locator('#projectName').fill('未保存草稿');
    release();await expect.poll(async()=>{const x=await api('bootstrap');return x.archived_projects.some(x=>x.id===other.project.id);}).toBe(true);
    await page.waitForLoadState('networkidle');await expect(page.locator('#projectName')).toHaveValue('未保存草稿');await expect(page).toHaveURL(new RegExp(`/games/${p}$`));await page.locator('#closeModal').click();await page.unrouteAll({behavior:'wait'});
  });
  await page.locator('#gamePrimaryEntry').click();await page.locator('[data-mode="play"]').click();
  await expect(page.locator('#modeBadge')).toHaveText('独立试玩',{timeout:120000});
  await expect(page.locator('#captureGameCover')).toBeEnabled({timeout:90000});
  await t.test('real canonical play frame -> preview -> both covers -> authenticated image',async()=>{
    await page.locator('#captureGameCover').click();await expect(page.locator('#manualCoverPreview img')).toBeVisible();
    await expect.poll(()=>page.locator('#manualCoverPreview img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(100);
    await page.screenshot({path:resolve(evidence,'photo-preview.png')});
    const request=page.waitForResponse(r=>r.url().endsWith('/manual-cover')&&r.request().method()==='POST');await page.locator('#modalFooter .primary').click();const response=await request;assert.equal(response.status(),200);
    await expect(page.locator('#modal')).not.toBeVisible();
    const saved=await project(),photo=saved.presentation.images.find(i=>i.id===saved.presentation.cover_id);
    assert.equal(photo.source,'manual');assert.equal(photo.mode,'play');assert.equal(photo.source_revision,tx.revision);assert.equal(photo.resource_id,'scene-harbor');assert.ok(photo.scene_generation>=1);assert.equal(saved.presentation.auto_update,false);assert.equal(saved.branches[0].presentation.cover_id,photo.id);
    const download=await fetch(origin+photo.url,{headers:{authorization:'Bearer '+token}});assert.equal(download.status,200);await writeFile(resolve(evidence,'game-cover.jpg'),Buffer.from(await download.arrayBuffer()));
  });
  await t.test('paused observation can retake a photo; cancel does not save',async()=>{
    const before=await project();await page.locator('[data-mode="inspect"]').click();await expect(page.locator('#modeBadge')).toHaveText('暂停观察');await expect(page.locator('#captureGameCover')).toBeEnabled();
    await page.locator('#captureGameCover').click();await expect(page.locator('#manualCoverPreview')).toBeVisible();await page.getByRole('button',{name:'重新拍摄',exact:true}).click();await expect(page.locator('#manualCoverPreview')).toBeVisible();await page.getByRole('button',{name:'取消',exact:true}).click();
    assert.deepEqual((await project()).presentation,before.presentation);
    await page.locator('#captureGameCover').click();await page.locator('#manualCoverScope').selectOption('branch');const response=page.waitForResponse(r=>r.url().endsWith('/manual-cover'));await page.locator('#modalFooter .primary').click();assert.equal((await response).status(),200);await expect(page.locator('#modal')).not.toBeVisible();
    const after=await project();assert.deepEqual(after.presentation,before.presentation);assert.equal(after.branches[0].presentation.images[0].mode,'inspect');
  });
  await page.locator('#workspaceHome').click();await expect(page.locator(`a[data-game="${p}"] img`)).toBeVisible();await page.screenshot({path:resolve(evidence,'catalog.png'),fullPage:true});
  for(const width of [1440,390]){await page.setViewportSize({width,height:960});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve(evidence,`catalog-${width}.png`),fullPage:true});}
  assert.deepEqual(errors,[]);await writeFile(resolve(evidence,'result.json'),JSON.stringify({ok:true,source_revision:tx.revision,scope:'Owner rename/archive/restore and race, real canonical Godot Web play/inspection photo capture, persistent cover, responsive catalog',errors},null,2));console.log('Manual cover evidence: '+evidence);
});
