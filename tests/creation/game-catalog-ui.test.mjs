/** Independent Chromium test against the real workbench and CreationService.
 * Uses explicit test games, temporary SQLite, and only port 48923.
 * Port 48923 is explicitly isolated because another task owns test port 48921.
 * Agent/Godot are disabled: entering a branch proves navigation, never runtime readiness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, extname, sep} from 'node:path';
import {chromium, expect} from '@playwright/test';
import {CreationService} from '../../services/creation/service.mjs';

const root = resolve(import.meta.dirname, '../..'), origin = 'http://127.0.0.1:48923';

test('game catalog: real browser navigation, media edits, races and responsive layouts', {timeout: 120000}, async t => {
  const data = await mkdtemp(resolve(tmpdir(), 'atelier-game-catalog-ui-'));
  const evidence = resolve(root, '.local/creation-verification/game-catalog-ui', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(evidence, {recursive: true});
  let service, browser;
  const server = createServer(async (req, res) => {
    try {
      if (await service.request(req, res)) return;
      const path = decodeURIComponent(new URL(req.url, origin).pathname);
      const base = path.startsWith('/packages/') ? root : resolve(root, 'apps/creation-workspace');
      const file = resolve(base, path === '/creation-workspace.html' || path === '/' ? 'index.html' : path.slice(1));
      if (!file.startsWith(base + sep) || !['.js', '.mjs', '.css', '.html'].includes(extname(file))) { res.writeHead(404); res.end(); return; }
      const bytes = await readFile(file);
      res.writeHead(200, {'content-type': ['.js', '.mjs'].includes(extname(file)) ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'text/html', 'cache-control': 'no-store'});
      res.end(bytes);
    } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.message); }
  });
  const previous = ['WORLD_ATELIER_DISABLE_AGENT', 'WORLD_ATELIER_DISABLE_WORLDS'].map(key => [key, process.env[key]]);
  for (const [key] of previous) process.env[key] = '1';
  try { service = new CreationService({server, root, data, origin}); }
  finally { for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value; }
  t.after(async () => {
    await browser?.close(); await service.close();
    if (server.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    await rm(data, {recursive: true, force: true});
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(48923, '127.0.0.1', done); });
  async function api(method, path, who, input) {
    const response = await fetch(`${origin}/creation-api/${path}`, {method, headers: {origin, connection: 'close', 'content-type': 'application/json', ...(who ? {authorization: `Bearer ${who.token}`} : {})}, body: input === undefined ? undefined : JSON.stringify(input)});
    const value = await response.json(); assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`); return value;
  }
  const credentials = {name: '目录独立测试用户', password: 'catalog-isolated-password'};
  const owner = await api('POST', 'auth/register', null, credentials), games = [];
  for (const name of ['测试：星港远航', '测试：森林探险']) {
    const created = await api('POST', 'projects', owner, {name, template: 'empty'});
    for (const branch of ['night', 'workshop']) await api('POST', `projects/${created.project.id}/branches`, owner, {from_branch: 'main', branch_id: branch, name: branch === 'night' ? '夜景实验' : '共创工坊'});
    games.push(created.project);
  }
  const [a, b] = games;
  const preferenceKey = `world-atelier:game-catalog:${owner.user.id}`;
  const presentation = async (id, branch) => { const game = (await api('GET', 'bootstrap', owner)).projects.find(p => p.id === id); return branch ? game.branches.find(b => b.branch_id === branch).presentation : game.presentation; };
  browser = await chromium.launch({headless: true, channel: 'chrome'});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/creation-workspace.html`);
  await page.locator('#authName').fill(credentials.name); await page.locator('#authPassword').fill(credentials.password); await page.locator('#authSubmit').click();
  await expect(page.locator('#gameCards .game-card')).toHaveCount(2);
  const route = (game, branch) => '#/games' + (game ? '/' + game.id : '') + (branch ? '/branches/' + branch : '');
  async function indexVisible(target = page) {
    await expect(target.locator('#gameLibrary')).toBeVisible(); await expect(target.locator('#gameDetail')).not.toBeVisible();
    await expect(target.locator('#workbench')).not.toBeVisible(); await expect(target.locator('#catalogRouteError')).not.toBeVisible();
  }
  async function detailVisible(game, target = page) {
    await expect(target.locator('#gameDetail')).toBeVisible(); await expect(target.locator('#gameLibrary')).not.toBeVisible();
    await expect(target.locator('#selectedGameTitle')).toHaveText(game.name); await expect(target.locator('#workbench')).not.toBeVisible();
    await expect(target).toHaveURL(`${origin}/creation-workspace.html${route(game)}`);
  }
  const select = async game => { await home(); await page.locator(`a.game-select[data-game="${game.id}"]`).click(); await detailVisible(game); };
  const preferences = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), preferenceKey);
  async function waitVisit(game, branch) { await expect.poll(async () => (await preferences()).visits[0]).toMatchObject({project_id: game.id, branch_id: branch}); }
  async function home() { await page.locator('#workspaceHome').click(); await indexVisible(); await expect(page).toHaveURL(`${origin}/creation-workspace.html#/games`); }
  const close = async () => { await page.locator('#closeModal').click(); await expect(page.locator('#modal')).not.toBeVisible(); };
  const png = async color => Buffer.from(await page.evaluate(color => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color), 'base64');
  const images = {green: await png('#378977'), orange: await png('#b76c37'), blue: await png('#375c97')};
  async function upload(name, bytes, count) {
    const response = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/presentation'));
    await page.locator('#gameMediaUpload').setInputFiles({name, mimeType: 'image/png', buffer: bytes});
    assert.equal((await response).status(), 200);
    await expect(page.locator('.media-editor-grid article')).toHaveCount(count);
    await expect(page.locator('#mediaProgress')).toHaveText('');
  }
  async function imageLoaded(locator) {
    await expect.poll(() => locator.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  }

  await t.test('two games, multiple branches, filters and branch entry target the chosen game', async () => {
    await indexVisible(); await expect(page).toHaveURL(`${origin}/creation-workspace.html#/games`);
    await page.locator('#gameSearch').fill('森林'); await expect(page.locator('#gameCards .game-card')).toHaveCount(1);
    await expect(page.locator('#gameCards h3')).toHaveText(b.name);
    await page.locator('#gameSearch').fill('不存在'); await expect(page.locator('#gameCards .game-card')).toHaveCount(0);
    await page.locator('#clearGameSearch').click(); await expect(page.locator('#gameSearch')).toHaveValue(''); await select(a);
    await expect(page.locator('#branchCards .branch-card')).toHaveCount(3);
    await page.locator('#branchSearch').fill('夜景'); await expect(page.locator('#branchCards .branch-card')).toHaveCount(1);
    await expect(page.locator('#branchCards [data-enter]')).toHaveAttribute('data-enter', 'night');
    await page.locator('#branchSearch').fill('不存在的分支'); await expect(page.locator('#branchCards .branch-card')).toHaveCount(0);
    await page.locator('#clearBranchSearch').click(); await expect(page.locator('#branchSearch')).toHaveValue('');
    await select(b); await expect(page.locator('#branchSearch')).toHaveValue(''); await expect(page.locator('#branchCards .branch-card')).toHaveCount(3);
    const branchRead = page.waitForResponse(r => r.request().method() === 'GET' && r.url() === `${origin}/creation-api/projects/${b.id}/branches/workshop`);
    await page.locator('#branchCards [data-enter="workshop"]').click(); assert.equal((await branchRead).status(), 200);
    await expect(page.locator('#workbench')).toBeVisible(); await expect(page.locator('#topbarProject')).toHaveText(b.name);
    await expect(page.locator('#topbarBranch')).toContainText('workshop');
    await waitVisit(b, 'workshop'); await home();
    await select(a);
  });

  await t.test('detail URLs survive refresh and recent branch links distinguish games without auto-selecting on the index', async () => {
    await expect(page.locator('#gamePrimaryEntry')).toHaveAttribute('aria-label', `进入 ${a.name} 的 main 分支创作`);
    await select(b); await expect(page.locator('#gamePrimaryEntry')).toHaveAttribute('aria-label', `继续 ${b.name} 的 workshop 分支创作`);
    await page.reload(); await expect(page.locator('#selectedGameTitle')).toHaveText(b.name);
    await expect(page.locator('#gamePrimaryEntry')).toHaveAttribute('aria-label', `继续 ${b.name} 的 workshop 分支创作`);
    await page.locator('#gamePrimaryEntry').click(); await expect(page.locator('#topbarProject')).toHaveText(b.name); await expect(page.locator('#topbarBranch')).toHaveText('workshop');
    await waitVisit(b, 'workshop'); await home();
    await page.locator(`[data-quick-game="${a.id}"][data-quick-branch="workshop"]`).click();
    await expect(page.locator('#topbarProject')).toHaveText(a.name); await expect(page.locator('#topbarBranch')).toHaveText('workshop');
    await waitVisit(a, 'workshop'); await home();
    await expect(page.locator('#recentGames [data-recent-game]')).toHaveCount(2);
    await select(b); await home(); await page.locator(`[data-recent-game="${a.id}"][data-recent-branch="workshop"]`).click();
    await expect(page.locator('#topbarProject')).toHaveText(a.name); await waitVisit(a, 'workshop'); await home();
    await indexVisible(); await page.reload(); await indexVisible();
    assert.deepEqual((await preferences()).visits.map(v => [v.project_id, v.branch_id]), [[a.id, 'workshop'], [b.id, 'workshop']]);
  });

  await t.test('failed branch entry preserves prior successful visits and releases navigation controls', async () => {
    await select(b); const before = (await preferences()).visits;
    const routePattern = `**/creation-api/projects/${b.id}/branches/night`;
    // Explicit transport-failure fixture; no simulated success or world ACK.
    await page.route(routePattern, route => route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: '独立测试：暂时无法读取分支'})}));
    try {
      const failed = page.waitForResponse(r => r.url().endsWith(`/projects/${b.id}/branches/night`) && r.status() === 503);
      await page.locator('#branchCards [data-enter="night"]').click(); await failed;
      await expect(page.locator('#landing')).not.toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('#catalogRouteError')).toBeVisible();
      assert.deepEqual((await preferences()).visits, before);
      await expect(page.locator('#landing')).toBeVisible();
    } finally { await page.unroute(routePattern); }
    await page.locator('#retryCatalogRoute').click(); await waitVisit(b, 'night'); await home(); await select(a);
  });

  await t.test('fork affordance chooses its source and creation enters the new persistent branch', async () => {
    await select(a); await page.locator('#branchCards [data-fork="workshop"]').click();
    await expect(page.locator('#modalTitle')).toHaveText('创建创作分支'); await expect(page.locator('#newBranchSource')).toHaveValue('workshop');
    await page.locator('#newBranchSource').selectOption('night');
    await page.locator('#newBranchName').fill('独立交互测试分支'); await page.locator('#newBranchId').fill('ui-fork');
    const creation = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/projects/${a.id}/branches`));
    await page.locator('#modalFooter').getByRole('button', {name: '创建并进入'}).click();
    const created = await creation; assert.equal(created.status(), 201); assert.equal((await created.json()).parent_branch, 'night');
    await expect(page.locator('#topbarProject')).toHaveText(a.name); await expect(page.locator('#topbarBranch')).toHaveText('ui-fork');
    await waitVisit(a, 'ui-fork'); await expect(page).toHaveURL(`${origin}/creation-workspace.html${route(a, 'ui-fork')}`);
    await expect(page.locator('#topbarProject')).toHaveAttribute('href', route(a));
    await page.locator('#topbarProject').click(); await detailVisible(a); await page.reload(); await detailVisible(a);
    await expect(page.locator('#branchCards .branch-card')).toHaveCount(4);
    await expect(page.locator('#gamePrimaryEntry')).toHaveAttribute('aria-label', `继续 ${a.name} 的 ui-fork 分支创作`);
  });

  await t.test('local preferences recover from corruption and never reveal inaccessible projects to another account', async () => {
    await home(); const saved = await preferences();
    await page.evaluate(key => localStorage.setItem(key, '{broken-json'), preferenceKey); await page.reload();
    await expect(page.locator('#gameCards .game-card')).toHaveCount(2); await expect(page.locator('#recentGames')).not.toBeVisible();
    await page.evaluate(({key, value}) => localStorage.setItem(key, JSON.stringify(value)), {key: preferenceKey, value: {...saved, visits: [{project_id: 'unavailable-game', branch_id: 'private', at: Date.now()}, {project_id: a.id, branch_id: 'deleted-branch', at: Date.now()}, ...saved.visits]}});
    await page.reload(); await expect(page.locator('#recentGames [data-recent-game="unavailable-game"]')).toHaveCount(0);
    await expect(page.locator('#recentGames [data-recent-branch="deleted-branch"]')).toHaveCount(0);
    const secondCredentials = {name: '另一个独立目录用户', password: 'catalog-isolated-password'};
    const second = await api('POST', 'auth/register', null, secondCredentials), otherPage = await page.context().newPage();
    try {
      await otherPage.goto(`${origin}/creation-workspace.html`); await otherPage.locator('#authName').fill(secondCredentials.name);
      await otherPage.locator('#authPassword').fill(secondCredentials.password); await otherPage.locator('#authSubmit').click();
      await expect(otherPage.locator('#catalogWelcome')).toBeVisible(); await expect(otherPage.locator('#gameCards .game-card')).toHaveCount(0);
      await expect(otherPage.locator('#recentGames')).not.toBeVisible();
      await otherPage.evaluate(({key, game}) => localStorage.setItem(key, JSON.stringify({selected: game, visits: [{project_id: game, branch_id: 'workshop', at: Date.now()}]})), {key: `world-atelier:game-catalog:${second.user.id}`, game: a.id});
      await otherPage.reload(); await expect(otherPage.locator('#catalogWelcome')).toBeVisible(); await expect(otherPage.locator('#recentGames')).not.toBeVisible();
      await expect(otherPage.locator('#gameCards .game-card')).toHaveCount(0);
      await otherPage.goto(`${origin}/creation-workspace.html${route(a, 'workshop')}`);
      await expect(otherPage.locator('#catalogRouteError')).toBeVisible(); await expect(otherPage.locator('#workbench')).not.toBeVisible();
      await expect(otherPage.locator('#gameLibrary')).not.toBeVisible(); await expect(otherPage.locator('#gameDetail')).not.toBeVisible();
    } finally { await otherPage.close(); }
    await page.evaluate(({key, value}) => localStorage.setItem(key, JSON.stringify(value)), {key: preferenceKey, value: saved});
    await page.reload(); await indexVisible(); await select(a);
  });

  await t.test('browser history and product back links follow index, game and branch URL levels', async () => {
    await home(); await select(a); await page.locator('#branchCards [data-enter="workshop"]').click();
    await waitVisit(a, 'workshop'); await expect(page).toHaveURL(`${origin}/creation-workspace.html${route(a, 'workshop')}`);
    await page.goBack(); await detailVisible(a); await page.goBack(); await indexVisible();
    await page.goForward(); await detailVisible(a); await page.goForward();
    await expect(page.locator('#workbench')).toBeVisible(); await expect(page.locator('#topbarBranch')).toHaveText('workshop');
    await page.locator('#branchMenuButton').click(); await page.locator('#topbarAllBranches').click(); await detailVisible(a);
    await expect(page.locator('#catalogBack')).toHaveAttribute('href', '#/games'); await page.locator('#catalogBack').click(); await indexVisible();
    await page.locator(`[data-quick-game="${b.id}"][data-quick-branch="workshop"]`).click();
    await expect(page.locator('#workbench')).toBeVisible(); await expect(page.locator('#topbarProject')).toHaveText(b.name);
    await home(); await indexVisible();
  });

  await t.test('a fresh tab preserves a protected branch deep link through login and reload', async () => {
    const deepPage = await context.newPage(); deepPage.on('pageerror', error => errors.push(error.message));
    const url = `${origin}/creation-workspace.html${route(b, 'night')}`;
    try {
      await deepPage.goto(url); await expect(deepPage.locator('#authView')).toBeVisible(); await expect(deepPage).toHaveURL(url);
      await deepPage.locator('#authName').fill(credentials.name); await deepPage.locator('#authPassword').fill(credentials.password); await deepPage.locator('#authSubmit').click();
      await expect(deepPage.locator('#workbench')).toBeVisible(); await expect(deepPage.locator('#topbarProject')).toHaveText(b.name);
      await expect(deepPage.locator('#topbarBranch')).toHaveText('night'); await expect(deepPage).toHaveURL(url);
      await deepPage.reload(); await expect(deepPage.locator('#workbench')).toBeVisible(); await expect(deepPage.locator('#topbarProject')).toHaveText(b.name);
      await expect(deepPage.locator('#topbarBranch')).toHaveText('night'); await expect(deepPage).toHaveURL(url);
      await expect(deepPage.locator('#topbarProject')).toHaveAttribute('href', route(b));
      await deepPage.locator('#topbarProject').click(); await detailVisible(b, deepPage);
    } finally { await deepPage.close(); }
  });

  await t.test('unknown, malformed and missing branch URLs show a recoverable error page without another game', async () => {
    for (const hash of ['#/unrecognized', '#/games/%broken', '#/games/missing-game', `${route(a)}/branches/missing-branch`]) {
      await page.evaluate(hash => { location.hash = hash; }, hash);
      await expect(page.locator('#catalogRouteError')).toBeVisible(); await expect(page.locator('#gameLibrary')).not.toBeVisible();
      await expect(page.locator('#gameDetail')).not.toBeVisible(); await expect(page.locator('#workbench')).not.toBeVisible();
      await expect(page.locator('#landing')).not.toHaveAttribute('aria-busy', 'true');
      await page.locator('#catalogRouteError').getByRole('link', {name: '返回游戏库'}).click(); await indexVisible();
    }
  });

  await t.test('a delayed branch read cannot replace a newer branch reached by changing the URL', async () => {
    await select(a); const pattern = `**/creation-api/projects/${a.id}/branches/night`;
    let release, received;
    const held = new Promise(done => { release = done; }), reached = new Promise(done => { received = done; });
    await page.route(pattern, async request => { const response = await request.fetch(); received(); await held; await request.fulfill({response}); });
    try {
      await page.locator('#branchCards [data-enter="night"]').click(); await reached;
      await page.evaluate(hash => { location.hash = hash; }, route(b, 'workshop'));
      await expect(page.locator('#workbench')).toBeVisible(); await expect(page.locator('#topbarProject')).toHaveText(b.name);
      await expect(page.locator('#topbarBranch')).toHaveText('workshop'); await waitVisit(b, 'workshop');
      const delivered = page.waitForResponse(r => r.url().endsWith(`/projects/${a.id}/branches/night`)); release(); await delivered;
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      await expect(page.locator('#topbarProject')).toHaveText(b.name); await expect(page.locator('#topbarBranch')).toHaveText('workshop');
      await expect(page).toHaveURL(`${origin}/creation-workspace.html${route(b, 'workshop')}`);
      await expect(page.locator('#catalogRouteError')).not.toBeVisible(); await expect(page.locator('#landing')).not.toHaveAttribute('aria-busy', 'true');
    } finally { release(); await page.unroute(pattern); }
    await home();
  });

  await t.test('PNG upload, cover selection, branch artwork and refresh persist through real APIs', async () => {
    await select(a); await page.locator('#editGameMedia').click();
    await upload('green.png', images.green, 1); await upload('orange.png', images.orange, 2);
    const state = await presentation(a.id), [green, orange] = state.images;
    const selected = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/presentation'));
    await page.locator(`[data-cover="${orange.id}"]`).click(); assert.equal((await selected).status(), 200);
    await expect(page.locator(`[data-cover="${orange.id}"]`)).toHaveText('当前头图'); await close();
    await expect(page.locator('#gameHero img')).toHaveAttribute('data-game-image', orange.url); await imageLoaded(page.locator('#gameHero img'));
    await expect(page.locator('#gameScreenshots .screenshot-thumb')).toHaveCount(2);
    await page.locator('[data-branch-media="night"]').click(); await upload('blue.png', images.blue, 1); await close();
    const branch = await presentation(a.id, 'night');
    await expect(page.locator('.branch-card').filter({has: page.locator('[data-enter="night"]')}).locator('img')).toHaveAttribute('data-game-image', branch.images[0].url);
    await page.locator('[data-branch-gallery="night"]').click(); await imageLoaded(page.locator('.screenshot-viewer img'));
    await expect(page.locator('#modalTitle')).toHaveText('blue.png'); await close();
    assert.equal((await presentation(a.id)).cover_id, orange.id); assert.equal((await presentation(b.id)).images.length, 0);
    await page.reload(); await expect(page.locator('#gameCards .game-card')).toHaveCount(2); await select(a);
    await expect(page.locator('#gameHero img')).toHaveAttribute('data-game-image', orange.url); await imageLoaded(page.locator('#gameHero img'));
    await page.locator('#gameScreenshots [data-gallery="0"]').click(); await imageLoaded(page.locator('.screenshot-viewer img'));
    await page.locator('#modalFooter').getByRole('button', {name: '下一张'}).click(); await expect(page.locator('#modalTitle')).toHaveText('orange.png'); await close();
    assert.ok(green.id !== orange.id);
  });

  await t.test('a stale edit refreshes metadata and its successful retry immediately updates the catalog', async () => {
    await select(a); await page.locator('#editGameMedia').click();
    const old = await presentation(a.id), [green, orange] = old.images;
    await api('PATCH', `projects/${a.id}/presentation`, owner, {expected_version: old.version, cover_id: orange.id});
    const conflict = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/presentation'));
    await page.locator(`[data-cover="${green.id}"]`).click(); assert.equal((await conflict).status(), 409);
    await expect(page.locator('#modalError')).toContainText('更新');
    await expect(page.locator(`[data-cover="${green.id}"]`)).toBeEnabled();
    const retry = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/presentation'));
    await page.locator(`[data-cover="${green.id}"]`).click(); assert.equal((await retry).status(), 200);
    await expect(page.locator('#gameHero img')).toHaveAttribute('data-game-image', green.url);
    await expect(page.locator(`[data-cover="${green.id}"]`)).toHaveText('当前头图'); await close();
  });

  await t.test('manual uploads disable automatic artwork and the UI can restore or pause it persistently', async () => {
    assert.equal((await presentation(a.id)).auto_update, false);
    assert.equal((await presentation(a.id, 'night')).auto_update, false);
    assert.equal((await presentation(b.id)).auto_update, true);
    await select(a); await page.locator('#editGameMedia').click();
    await expect(page.locator('#toggleAutoCover')).toHaveText('恢复自动更新');
    const resumed = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/presentation'));
    await page.locator('#toggleAutoCover').click(); assert.equal((await resumed).status(), 200);
    await expect(page.locator('#toggleAutoCover')).toHaveText('暂停自动更新'); await close();
    await page.reload(); await expect(page.locator('#gameCards .game-card')).toHaveCount(2); await select(a);
    assert.equal((await presentation(a.id)).auto_update, true);
    await page.locator('#editGameMedia').click(); await expect(page.locator('#toggleAutoCover')).toHaveText('暂停自动更新');
    const paused = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/presentation'));
    await page.locator('#toggleAutoCover').click(); assert.equal((await paused).status(), 200);
    await expect(page.locator('#toggleAutoCover')).toHaveText('恢复自动更新'); await close();
    assert.equal((await presentation(a.id)).auto_update, false);
    assert.equal((await presentation(a.id)).images.length, 2);
    assert.equal((await presentation(b.id)).auto_update, true);
  });

  await t.test('a late saved response does not replace a newer game artwork dialog', async () => {
    await select(a); await page.locator('#editGameMedia').click();
    const old = await presentation(a.id), next = old.images.find(i => i.id !== old.cover_id);
    const routePattern = `**/creation-api/projects/${a.id}/presentation`;
    let release, applied;
    const released = new Promise(done => { release = done; }), received = new Promise(done => { applied = done; });
    await page.route(routePattern, async route => { const response = await route.fetch(); applied(); await released; await route.fulfill({response}); });
    try {
      await page.locator(`[data-cover="${next.id}"]`).click(); await received;
      await close(); await select(b); await page.locator('#editGameMedia').click();
      const title = await page.locator('#modalTitle').textContent(), editor = await page.locator('#gameMediaUpload').getAttribute('data-editor');
      const delivered = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith(`/projects/${a.id}/presentation`));
      release(); await delivered;
      await expect(page.locator(`.game-select[data-game="${a.id}"] img`)).toHaveAttribute('data-game-image', next.url);
      await expect(page.locator('#modalTitle')).toHaveText(title); await expect(page.locator('#gameMediaUpload')).toHaveAttribute('data-editor', editor);
      await expect(page.locator('.media-editor-grid article')).toHaveCount(0); await close();
    } finally { release(); await page.unroute(routePattern); }
  });

  await t.test('desktop and mobile render mutually exclusive index and detail pages without overflow', async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 1000}); await home();
      const index = await page.evaluate(() => ({document: document.documentElement.scrollWidth, body: document.body.scrollWidth}));
      assert.ok(index.document <= width && index.body <= width, `${width}px index: ${JSON.stringify(index)}`);
      await page.screenshot({path: resolve(evidence, `games-index-${width}.png`), fullPage: true});
      await select(a); await expect(page.locator('#selectedGameTitle')).toBeFocused();
      const dimensions = await page.evaluate(() => ({viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth}));
      assert.ok(dimensions.document <= width && dimensions.body <= width, `${width}px detail: ${JSON.stringify(dimensions)}`);
      await page.screenshot({path: resolve(evidence, `game-detail-${width}.png`), fullPage: true});
      await page.locator('#editGameMedia').click();
      const dialog = await page.locator('#modal').evaluate(node => ({width: node.getBoundingClientRect().width, content: node.scrollWidth, inner: node.clientWidth}));
      assert.ok(dialog.width <= width && dialog.content <= dialog.inner, `${width}px dialog: ${JSON.stringify(dialog)}`);
      await page.screenshot({path: resolve(evidence, `media-editor-${width}.png`)}); await close();
    }
  });
  assert.deepEqual(errors, [], 'no uncaught browser JavaScript errors');
  t.diagnostic(`Evidence: ${evidence}`);
});
