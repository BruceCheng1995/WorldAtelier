import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Uses the real service; start it with an isolated WORLD_ATELIER_PORT/DATA first.
const url = process.env.PORTAL_URL || 'http://127.0.0.1:48932'
const evidence = resolve(process.env.PORTAL_EVIDENCE || '.local/portal-ui-evidence')
await mkdir(evidence, {recursive:true})
const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true})
const contexts = []
const errors = []
const assertions = []
const suffix = Date.now()
const password = 'PortalE2E2026'
async function account(name) {
  const context = await browser.newContext({viewport:{width:1512,height:1100},acceptDownloads:true})
  contexts.push(context)
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(url)
  await page.getByLabel('协作者名称').fill(name)
  await page.getByLabel('密码',{exact:true}).fill(password)
  await page.getByRole('button',{name:'创建账号，进入工坊'}).click()
  await page.getByRole('button',{name:'创建第一个工程'}).waitFor()
  return page
}
async function state(page) {
  const session = await page.evaluate(()=>JSON.parse(localStorage.getItem('world-atelier:session')))
  const projectId = await page.locator('#project-select').inputValue()
  const response = await page.request.get(`${url}/api/projects/${projectId}`,{headers:{Authorization:`Bearer ${session.token}`}})
  assert.equal(response.status(),200)
  return {session,projectId,...await response.json()}
}
async function contentOf(page,branch='main') {
  const {session,projectId} = await state(page)
  const response = await page.request.get(`${url}/api/projects/${projectId}/branches/${branch}/content`,{headers:{Authorization:`Bearer ${session.token}`}})
  assert.equal(response.status(),200)
  return await response.json()
}
async function addMember(owner,name,role) {
  await owner.getByRole('button',{name:'协作工作台'}).click()
  await owner.getByRole('button',{name:'添加成员'}).click()
  await owner.getByLabel('已注册的协作者名称').fill(name)
  await owner.getByLabel('工程角色').selectOption(role)
  await owner.getByRole('button',{name:'创建并继续'}).click()
  await owner.getByRole('dialog').waitFor({state:'hidden'})
}
try {
  const ownerName = `portal-owner-${suffix}`, editorName = `portal-editor-${suffix}`
  const owner = await account(ownerName)
  const editor = await account(editorName)
  await owner.getByRole('button',{name:'创建第一个工程'}).click()
  await owner.getByLabel('工程名称',{exact:true}).fill(`星屿远征 · Portal E2E ${suffix}`)
  await owner.getByRole('button',{name:'创建并继续'}).click()
  await owner.getByRole('heading',{name:'现场检查器'}).waitFor()
  assertions.push('Registration and project creation completed via UI against real service')
  await addMember(owner,editorName,'editor')
  await editor.reload()
  await editor.getByRole('heading',{name:'现场检查器'}).waitFor()
  const initial = await contentOf(owner)
  const selectedId = await editor.getByLabel('当前对象',{exact:true}).inputValue()
  await owner.getByRole('button',{name:'现场世界',exact:true}).click()
  await owner.getByLabel('对象名称',{exact:true}).fill('主干协作信标 · Owner')
  await owner.getByRole('button',{name:'提交场景修改'}).click()
  await owner.getByText(/场景已提交/).waitFor()
  await editor.getByLabel('对象名称',{exact:true}).fill('并行修改信标 · Editor')
  await editor.getByRole('button',{name:'提交场景修改'}).click()
  await editor.getByRole('heading',{name:'这次修改需要处理冲突'}).waitFor()
  const after = await contentOf(owner)
  assert.equal(after.content.objects.find(o=>o.id===selectedId).name,'主干协作信标 · Owner')
  const draft = await editor.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.includes(':draft:')&&!key.endsWith(':backup')).map(([,v])=>JSON.parse(v))[0])
  assert.equal(draft.base_revision,initial.revision)
  assert.equal(draft.content.objects.find(o=>o.id===selectedId).name,'并行修改信标 · Editor')
  assertions.push('Concurrent conflicting edits produce HTTP conflict, preserve original base/local draft and keep server winner')
  await editor.getByRole('button',{name:'备份草稿并读取最新版'}).click()
  await editor.getByRole('heading',{name:'这次修改需要处理冲突'}).waitFor({state:'hidden'})
  await expect(editor.getByLabel('对象名称',{exact:true})).toHaveValue('主干协作信标 · Owner')
  const backup = await editor.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.endsWith(':backup')).map(([,v])=>JSON.parse(v))[0])
  assert.equal(backup.content.objects.find(o=>o.id===selectedId).name,'并行修改信标 · Editor')
  await editor.getByRole('button',{name:'分支与发行',exact:true}).click()
  await editor.locator('.versions-page').getByRole('button',{name:'新建分支',exact:true}).click()
  await editor.getByLabel('分支名称',{exact:true}).fill('garden-ui')
  await editor.getByRole('button',{name:'创建并继续'}).click()
  await editor.getByRole('dialog').waitFor({state:'hidden'})
  await editor.getByRole('button',{name:'场景与规则',exact:true}).click()
  await editor.getByLabel('对象名称',{exact:true}).fill('分支信标 · Garden')
  await editor.getByRole('button',{name:'提交场景修改'}).click()
  await editor.getByText(/场景已提交/).waitFor()
  const branchContent = await contentOf(editor,'garden-ui')
  assert.equal(branchContent.content.objects.find(o=>o.id===selectedId).name,'分支信标 · Garden')
  assert.equal((await contentOf(owner)).content.objects.find(o=>o.id===selectedId).name,'主干协作信标 · Owner')
  assertions.push('Branch creation loads selected branch content; branch edits do not change main')
  await editor.getByRole('button',{name:'离线工作区',exact:true}).click()
  const downloadEvent = editor.waitForEvent('download')
  await editor.getByRole('button',{name:'下载离线工作区',exact:true}).click()
  const download = await downloadEvent
  const pack = JSON.parse(await readFile(await download.path(),'utf8'))
  assert.equal(pack.branch,'garden-ui'); assert.equal(pack.base_revision,branchContent.revision)
  pack.content.objects.find(o=>o.id===selectedId).color='#eeac55'
  pack.state_seed = {players:{injected:{crystals:999999}}}
  const offlineFile = resolve(evidence,'offline-workspace.json')
  await writeFile(offlineFile,JSON.stringify(pack,null,2))
  const importRequest = editor.waitForRequest(req=>req.url().endsWith('/garden-ui/import')&&req.method()==='POST')
  await editor.locator('input[type=file]').setInputFiles(offlineFile)
  const request = await importRequest
  assert.ok(!('state_seed' in request.postDataJSON()))
  assert.ok(request.headers()['idempotency-key'])
  await editor.getByText('离线内容已合并到源码分支，等待构建验收。',{exact:true}).waitFor()
  assert.equal((await contentOf(editor,'garden-ui')).content.objects.find(o=>o.id===selectedId).color,'#eeac55')
  assertions.push('Offline workspace download/import uses base revision, mutates real branch content and excludes gameplay state')
  await editor.getByRole('button',{name:'场景与规则',exact:true}).click()
  await editor.getByRole('button',{name:'为此对象发起开发任务'}).click()
  await editor.getByLabel('任务标题').fill('验证星屿信标维护光圈')
  await editor.getByRole('button',{name:'创建并继续'}).click()
  await editor.getByRole('dialog').waitFor({state:'hidden'})
  await editor.getByRole('button',{name:'协作工作台'}).click()
  await editor.getByLabel('任务 验证星屿信标维护光圈 状态').selectOption('testing')
  await editor.getByText('协作者任务状态已更新。',{exact:true}).waitFor()
  const task=(await state(editor)).tasks.find(t=>t.title==='验证星屿信标维护光圈')
  assert.equal(task.status,'testing'); assert.equal(task.branch,'garden-ui')
  assert.equal(await editor.getByLabel('任务 验证星屿信标维护光圈 状态').locator('option[value=delivered]').count(),0)
  assertions.push('Object task is branch-scoped and updates on service; UI cannot manually claim delivered')
  await editor.screenshot({path:resolve(evidence,'collaboration.png'),fullPage:true})
  await editor.getByRole('button',{name:'场景与规则',exact:true}).click()
  await editor.screenshot({path:resolve(evidence,'editor.png'),fullPage:true})
  await editor.evaluate(()=>window.postMessage({source:'world-atelier-game',type:'telemetry',active:true,world_id:'fake',release_id:'fake'},location.origin))
  assert.equal(await editor.locator('.game-panel').getAttribute('data-game-active'),'false')
  assertions.push('Parent-window spoofed telemetry cannot mark game active')
  await addMember(owner,editorName,'viewer')
  await editor.reload()
  await editor.getByRole('heading',{name:'现场检查器'}).waitFor()
  assert.equal(await editor.getByLabel('对象名称',{exact:true}).isDisabled(),true)
  assert.equal(await editor.getByRole('button',{name:'提交场景修改'}).isDisabled(),true)
  assertions.push('Server membership downgrade is reflected in readonly editor controls')
  await editor.setViewportSize({width:430,height:932})
  await editor.screenshot({path:resolve(evidence,'mobile.png'),fullPage:true})
  const dimensions=await editor.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}))
  assert.ok(dimensions.scroll<=dimensions.width,`Horizontal overflow ${JSON.stringify(dimensions)}`)
  assert.deepEqual(errors,[])
  assertions.push('Mobile viewport has no horizontal overflow; no browser page errors throughout real collaboration flow')
  await writeFile(resolve(evidence,'report.json'),JSON.stringify({time:new Date().toISOString(),url,assertions,errors,scope:'Portal UI and real central service; game, runtime export and VFX require separate integration tests.'},null,2))
  console.log(JSON.stringify({passed:assertions.length,assertions,evidence},null,2))
} finally { await browser.close() }
