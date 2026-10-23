/** Developer-supplied candidate, awaiting independent review and execution.
 * Run only when the independent 48921 service slot is free:
 *   node tests/creation/next-wave-merge-offline-ui-candidate.mjs --run
 * Uses the original workbench, actual HTTP/SQLite/native transactions, the
 * downloaded portable CLI and actual Godot engines. Never emits runtime ACKs.
 * Only this file belongs to the development-side author of this candidate.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from '@playwright/test';
import {prepareExecutionEnvironment} from '../../services/creation/execution-environment.mjs';
import {nextWaveAuthorFiles, nativeImportFiles} from './next-wave-author-fixture.mjs';
import {Evidence, IsolatedService, ORIGIN, request, waitFor, sha256, redact, implementationSnapshot} from './next-wave-test-support.mjs';

const SCENE = 'scenes/a.tscn';
const MANUAL_STEP = 7;
const branchPath = (project, branch = 'main') => `/creation-api/projects/${project.id}/branches/${branch}`;
const jsonFile = path => JSON.parse(readFileSync(path, 'utf8'));

// Edit authored native source bytes, never the derived native_nodes index.
function rootProperty(text, key, value) {
  const start = text.indexOf('[node name="JourneyA"');
  assert.ok(start >= 0, 'Expected actual author fixture root.');
  const next = text.indexOf('\n[node ', start + 1), end = next < 0 ? text.length : next;
  const chunk = text.slice(start, end), escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const property = new RegExp('^' + escaped + '\\s*=.*$', 'm');
  const updated = property.test(chunk) ? chunk.replace(property, `${key} = ${value}`) : chunk.trimEnd() + `\n${key} = ${value}\n`;
  return text.slice(0, start) + updated + text.slice(end);
}

function treeHashes(directory) {
  const result = {};
  const visit = (base, prefix = '') => {
    for (const item of readdirSync(base, {withFileTypes: true})) {
      const path = prefix + item.name, full = join(base, item.name);
      assert.ok(!item.isSymbolicLink(), 'Candidate workspace must not contain symbolic links.');
      if (item.isDirectory()) visit(full, path + '/');
      else if (item.isFile()) result[path] = sha256(readFileSync(full));
    }
  };
  visit(directory);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export async function runMergeOfflineUiCandidate() {
  const evidence = new Evidence('merge-offline-ui-candidate', {
    layers: ['A', 'G', 'B'],
    scope: 'Developer-supplied candidate for independent review: original UI ordered multi-source merge, local manual decision, draft-only discussion, compensating revert, downloaded CLI HTTP roundtrip, fixed Web play and explicit restart, disconnected canonical Godot reopen. No independent verdict is asserted by the author.',
  });
  evidence.report.candidate = {author_role: 'development', review_status: 'requires-independent-review-and-verdict', execution_opt_in: '--run'};
  const service = new IsolatedService(evidence, {agent: false, worlds: false});
  const consoleLog = [], pageErrors = [], requests = [], ownedChildren = new Set();
  let browser, page, actor, collaborator, project, baseline, merged, postEdit, reverted, synced, downloadedCli, workspace;
  let completed = false;
  const branches = {art: 'candidate-art', logic: 'candidate-logic'};

  const head = async (branch = 'main') => (await request('GET', branchPath(project, branch), {actor})).value;
  const source = async (branch = 'main') => {
    const fixed = await head(branch);
    const entries = await Promise.all(Object.keys(fixed.manifest.source_files).map(async path => {
      const result = (await request('GET', branchPath(project, branch) + '/native-source?revision=' + encodeURIComponent(fixed.head) + '&path=' + encodeURIComponent(path), {actor})).value;
      return [path, Buffer.from(result.data_base64, 'base64')];
    }));
    return {fixed, files: new Map(entries)};
  };
  const edit = async (branch, change, author = actor) => {
    const {fixed, files} = await source(branch);
    await change(files);
    return (await request('POST', branchPath(project, branch) + '/transactions', {actor: author, timeout: 120000, body: {
      transaction_id: 'ui-candidate-' + randomUUID(), base_revision: fixed.head, expected_head: fixed.head,
      ops: [{type: 'import_native_project', files: nativeImportFiles(files)}],
    }})).value.branch;
  };
  const databaseSnapshot = () => {
    const db = new DatabaseSync(join(service.creationData, 'creation.sqlite'), {readOnly: true});
    try {
      const revisions = db.prepare("SELECT body FROM documents WHERE kind='creator_revision'").all().map(row => JSON.parse(row.body)).filter(row => row.project_id === project.id);
      const releases = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind='creator_native_game_release'").get().n;
      const runs = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind='creator_run'").get().n;
      return {revision_count: revisions.length, public_release_count: releases, agent_run_count: runs};
    } finally { db.close(); }
  };
  const check = async (id, description, layers, execute) => {
    console.log('NEXT_WAVE_CASE_START ' + id + ' ' + description);
    await evidence.check(id, description, layers, execute);
    console.log('NEXT_WAVE_CASE_PASS ' + id);
  };
  const button = name => page.locator('#modalFooter').getByRole('button', {name, exact: true});
  const responseFromClick = async (path, action, method = 'POST') => {
    const response = page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === method, {timeout: 120000});
    await action();
    const result = await response, body = await result.json();
    assert.ok(result.ok(), redact(JSON.stringify(body)));
    return body;
  };
  const waitUiHead = revision => waitFor('workbench receives committed source', async () => (await page.locator('#sourceBadge').getAttribute('title')) === revision, {timeout: 20000});
  const menu = async () => {
    if (await page.locator('#branchMenu').evaluate(element => element.hidden)) await page.locator('#branchMenuButton').click();
  };
  const closeChat = async () => {
    if (!await page.locator('#chatDrawer').evaluate(element => element.hidden)) await page.locator('#closeChat').click();
  };
  async function compareSources() {
    await closeChat(); await menu(); await page.locator('[data-topbar-action="merge"]').click();
    const sources = page.locator('#modalBody [data-native-source]');
    assert.equal(await sources.count(), 2);
    for (let index = 0; index < 2; index++) {
      const checkbox = sources.nth(index), label = await checkbox.locator('xpath=../..').textContent();
      await checkbox.check();
      await page.locator(`#modalBody [data-native-order="${index}"]`).fill(label.includes(branches.logic) ? '1' : '2');
    }
    return responseFromClick(branchPath(project) + '/merge-preview', () => button('比较所选分支').click());
  }
  async function chooseManual(preview) {
    assert.equal(preview.conflicts.length, 1, 'Only the intentional counter property must conflict.');
    const conflict = preview.conflicts[0];
    assert.equal(conflict.path, SCENE); assert.equal(conflict.property, 'counter_step');
    await page.locator('[data-native-resolution="0"]').selectOption('manual');
    await page.locator('[data-native-manual="0"]').fill(`counter_step = ${MANUAL_STEP}\n`);
    return conflict;
  }
  const gameSnapshot = () => page.evaluate(() => [...(window.__nextWaveEvents ?? [])].reverse().find(event => event.type === 'play_context' && event.kind === 'snapshot') ?? null);
  const counter = async () => (await gameSnapshot())?.payload?.objects?.find(object => object.name === 'Counter')?.control?.text ?? '';
  const gameBuild = () => page.locator('#mainPreview').getAttribute('data-game-build');
  const pressE = async () => {
    const frame = page.frames().find(item => item.url().includes('/creation-runtime/') && item.url().includes('/web/index.html'));
    assert.ok(frame, 'Real canonical Godot iframe must be present.');
    await frame.locator('canvas').focus(); await frame.locator('canvas').press('e');
  };
  const waitCounter = pattern => waitFor('actual Godot counter ' + pattern, async () => pattern.test(await counter()) && await counter(), {timeout: 240000, interval: 250});

  async function processRun(name, command, args, {env = process.env, cwd = service.data, timeout = 120000, options = {}} = {}) {
    const child = spawn(command, args, {...options, cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    ownedChildren.add(child);
    const receipt = {pid: child.pid, role: name, started_at: new Date().toISOString()};
    evidence.report.processes.push(receipt);
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', bytes => {stdout += bytes;}); child.stderr.on('data', bytes => {stderr += bytes;});
    const kill = () => {try {process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') throw error;}};
    const timer = setTimeout(() => {timedOut = true; kill();}, timeout);
    try {
      const result = await new Promise((done, reject) => {child.once('error', reject); child.once('close', (code, signal) => done({code, signal}));});
      Object.assign(receipt, result, {timed_out: timedOut, finished_at: new Date().toISOString()});
      evidence.text(name + '.stdout.log', stdout); evidence.text(name + '.stderr.log', stderr);
      assert.equal(timedOut, false, name + ' timed out');
      assert.equal(result.code, 0, name + '\n' + redact(stderr.slice(-6000) + stdout.slice(-2000)));
      return {stdout, stderr};
    } finally {clearTimeout(timer); ownedChildren.delete(child);}
  }
  const cli = async (name, command, args = [], {offline = false} = {}) => {
    const env = {...process.env};
    for (const key of Object.keys(env)) if (key.startsWith('WORLD_ATELIER_') || key.startsWith('WA_WORKER_')) delete env[key];
    if (offline) env.NODE_OPTIONS = '--require=' + JSON.stringify(join(service.data, 'deny-network.cjs'));
    else env.WORLD_ATELIER_TOKEN = actor.token;
    const result = await processRun(name, process.execPath, [downloadedCli, command, '--dir=' + workspace, ...args], {env});
    return JSON.parse(result.stdout);
  };

  try {
    await service.start();
    await check('MU01', 'Create two real collaborators and native branch edits through HTTP transactions', ['A', 'G'], async receipt => {
      actor = await register('ui-owner'); collaborator = await register('ui-collaborator');
      const created = (await request('POST', '/creation-api/projects', {actor, expected: 201, timeout: 120000, body: {name: 'Merge Offline UI Candidate ' + randomUUID().slice(0, 6), template: 'empty'}})).value;
      project = created.project;
      const files = nextWaveAuthorFiles();
      files.set(SCENE, Buffer.from(rootProperty(rootProperty(files.get(SCENE).toString(), 'counter_step', '1'), 'allow_open', 'false')));
      baseline = (await request('POST', branchPath(project) + '/transactions', {actor, timeout: 120000, body: {transaction_id: 'candidate-fixture-' + randomUUID(), base_revision: created.branch.head, expected_head: created.branch.head, ops: [{type: 'import_native_project', files: nativeImportFiles(files)}]}})).value.branch;
      const invitation = (await request('POST', `/creation-api/projects/${project.id}/invites`, {actor, expected: 201, body: {role: 'editor'}})).value;
      await request('POST', '/creation-api/invites/join', {actor: collaborator, body: {code: invitation.code, request_id: randomUUID()}});
      for (const branch_id of Object.values(branches)) await request('POST', `/creation-api/projects/${project.id}/branches`, {actor, expected: 201, body: {from_branch: 'main', branch_id, expected_head: baseline.head}});
      await edit('main', files => files.set(SCENE, Buffer.from(rootProperty(rootProperty(files.get(SCENE).toString(), 'counter_step', '4'), 'metadata/target_note', '"target-only"'))));
      await edit(branches.art, files => files.set(SCENE, Buffer.from(rootProperty(rootProperty(files.get(SCENE).toString(), 'counter_step', '9'), 'metadata/art_note', '"source-art"'))), collaborator);
      await edit(branches.logic, files => files.set(SCENE, Buffer.from(rootProperty(files.get(SCENE).toString(), 'allow_open', 'true'))), collaborator);
      receipt.project_id = project.id; receipt.baseline_revision = baseline.head;
      receipt.source_branches = await Promise.all(Object.values(branches).map(async id => ({branch_id: id, revision: (await head(id)).head})));
      writeFileSync(join(service.data, 'candidate-test-state.json'), JSON.stringify({actor, collaborator, project, baseline_revision: baseline.head}, null, 2), {mode: 0o600});
    });

    browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--mute-audio', '--enable-unsafe-swiftshader']});
    const browserContext = await browser.newContext({viewport: {width: 1600, height: 1050}, acceptDownloads: true});
    page = await browserContext.newPage(); evidence.report.versions.chrome = browser.version();
    await page.addInitScript(() => {window.__nextWaveEvents = []; addEventListener('message', event => {
      if (event.data?.source === 'world-atelier-game' && !event.data.data_url) {window.__nextWaveEvents.push(event.data); if (window.__nextWaveEvents.length > 1000) window.__nextWaveEvents.shift();}
    });});
    page.on('console', message => consoleLog.push({type: message.type(), text: message.text()}));
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', item => {const url = new URL(item.url()); if (url.pathname.startsWith('/creation-api/')) requests.push({method: item.method(), path: url.pathname});});
    await page.goto(ORIGIN + '/creation-workspace.html#/games');
    await page.locator('#authName').fill(actor.credentials.name); await page.locator('#authPassword').fill(actor.credentials.password); await page.locator('#authSubmit').click();
    await page.locator('#landing').waitFor({state: 'visible'});
    await page.locator(`[data-quick-game="${project.id}"][data-quick-branch="main"]`).click(); await page.locator('#workbench').waitFor({state: 'visible'});

    await check('MU02', 'Original UI honors source order and attaches immutable manual decisions to an unsent private draft', ['A', 'B'], async receipt => {
      const before = databaseSnapshot(), revision = (await head()).head, preview = await compareSources();
      assert.deepEqual(preview.sources.map(item => item.branch_id), [branches.logic, branches.art]);
      await chooseManual(preview);
      const response = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/merge-context') && value.request().method() === 'POST', {timeout: 20000});
      await button('与 Agent 讨论这些冲突').click(); const attached = await (await response).json();
      assert.equal(attached.draft_only, true); assert.equal(attached.session.visibility, 'private');
      assert.equal(attached.attachment.kind, 'branch_merge'); assert.equal(attached.attachment.role, 'reference');
      assert.equal(attached.attachment.preview_id, preview.id); assert.deepEqual(attached.attachment.sources.map(item => item.branch_id), [branches.logic, branches.art]);
      assert.equal(attached.attachment.proposed_resolutions[preview.conflicts[0].key].text, `counter_step = ${MANUAL_STEP}\n`);
      assert.equal((await head()).head, revision); assert.deepEqual(databaseSnapshot(), before);
      await page.locator('#chatDrawer').waitFor({state: 'visible'}); await page.screenshot({path: join(evidence.directory, 'merge-context-private-unsent-draft.png')});
      receipt.preview_id = preview.id; receipt.attachment_id = attached.attachment.id; receipt.session_id = attached.session.id; receipt.draft_only = true;
      evidence.json('fixed-merge-discussion.json', attached.attachment);
    });

    await check('MU03', 'Original UI reviews and atomically saves one local decision with both nonconflicting branches', ['A', 'G', 'B'], async receipt => {
      const before = databaseSnapshot(), target = await head(), sourcesBefore = await Promise.all(Object.values(branches).map(head));
      const preview = await compareSources(); await chooseManual(preview);
      const reviewed = await responseFromClick(branchPath(project) + '/merge-review', () => button('更新冲突预览').click());
      assert.equal(reviewed.unresolved_count, 0); assert.equal((await head()).head, target.head); assert.deepEqual(databaseSnapshot(), before);
      await page.screenshot({path: join(evidence.directory, 'ordered-multi-source-reviewed.png')});
      const saved = await responseFromClick(branchPath(project) + '/merge', () => button('保存合并').click());
      merged = saved.branch; await waitUiHead(merged.head);
      assert.equal(databaseSnapshot().revision_count, before.revision_count + 1); assert.equal(databaseSnapshot().public_release_count, before.public_release_count);
      const actual = await source(), text = actual.files.get(SCENE).toString();
      for (const pattern of [/^counter_step\s*=\s*7$/m, /^allow_open\s*=\s*true$/m, /metadata\/target_note\s*=\s*"target-only"/, /metadata\/art_note\s*=\s*"source-art"/]) assert.match(text, pattern);
      for (const path of ['opaque/author.bin', 'opaque/author-notes.txt']) assert.deepEqual(actual.fixed.manifest.source_files[path], baseline.manifest.source_files[path]);
      for (let index = 0; index < sourcesBefore.length; index++) assert.equal((await head(Object.values(branches)[index])).head, sourcesBefore[index].head);
      receipt.target_before = target.head; receipt.revision = merged.head; receipt.sources = reviewed.sources; receipt.atomic_revision_delta = 1;
      evidence.json('merged-manifest.json', merged.manifest); await page.locator('#closeModal').click();
    });

    await check('MU04', 'History compensation restores the prior contribution and preserves later collaborator changes', ['A', 'G', 'B'], async receipt => {
      postEdit = await edit('main', files => files.set(SCENE, Buffer.from(rootProperty(files.get(SCENE).toString(), 'metadata/later_note', '"retain-later-collaborator-edit"'))), collaborator);
      await waitUiHead(postEdit.head); const before = databaseSnapshot();
      await menu(); await page.locator('#nativeMergeHistory').click(); await page.locator('#nativeRevertRevision').selectOption(merged.head);
      const preview = await responseFromClick(branchPath(project) + '/merge-revert-preview', () => button('比较补偿撤回').click());
      assert.equal(preview.revert_revision, merged.head); assert.equal(preview.target_revision, postEdit.head); assert.equal(preview.unresolved_count, 0);
      await page.screenshot({path: join(evidence.directory, 'compensation-keeps-later-edit.png')});
      const saved = await responseFromClick(branchPath(project) + '/merge', () => button('保存补偿撤回').click()); reverted = saved.branch; await waitUiHead(reverted.head);
      assert.notEqual(reverted.head, postEdit.head); assert.equal(databaseSnapshot().revision_count, before.revision_count + 1);
      const actual = await source(), text = actual.files.get(SCENE).toString();
      assert.match(text, /^counter_step\s*=\s*4$/m);
      // Godot omits an override equal to the PackedScene/script default.
      // MU05 separately proves the resulting actual two-input closed state.
      const openOverride=text.match(/^allow_open\s*=\s*(.*)$/m);assert.ok(!openOverride||openOverride[1].trim()==='false');
      assert.match(text, /retain-later-collaborator-edit/); assert.match(text, /target-only/); assert.doesNotMatch(text, /source-art/);
      for (const path of ['opaque/author.bin', 'opaque/author-notes.txt']) assert.deepEqual(actual.fixed.manifest.source_files[path], baseline.manifest.source_files[path]);
      receipt.reverted_merge = merged.head; receipt.later_revision = postEdit.head; receipt.compensation_revision = reverted.head;
      if (await page.locator('#modal').evaluate(element => element.open)) await page.locator('#closeModal').click();
    });

    await check('MU05', 'Original offline panel downloads a runnable client; actual HTTP sync preserves remote edits and running Web state', ['A', 'G', 'B'], async receipt => {
      await page.locator('[data-mode="play"]').click(); await waitCounter(/JourneyA.*clicks=0.*open=false/);
      const oldBuild = await gameBuild(), oldInstance = (await gameSnapshot()).runtime_instance_id;
      await pressE(); await waitCounter(/clicks=1.*open=false/); await pressE(); await waitCounter(/clicks=2.*open=false/);
      await menu(); await page.locator('#nativeWorkspace').click(); await page.locator('#modal').waitFor({state: 'visible'});
      const command = await page.locator('#modalBody pre').first().textContent();
      assert.ok(command.includes(ORIGIN) && command.includes(project.id) && command.includes("--branch='main'") && command.includes('--login'));
      assert.ok(!command.includes(actor.token) && !command.includes(actor.credentials.password));
      await page.screenshot({path: join(evidence.directory, 'actual-offline-panel.png')});
      const downloadEvent = page.waitForEvent('download'); await button('下载同步工具').click(); const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), 'world-atelier-native-workspace.mjs');
      downloadedCli = join(service.data, download.suggestedFilename()); await download.saveAs(downloadedCli); assert.equal(await download.failure(), null);
      await button('关闭').click(); workspace = join(service.data, 'actual-cli-workspace');
      const checkedOut = await cli('cli-checkout', 'checkout', ['--server=' + ORIGIN, '--project=' + project.id, '--branch=main']);
      assert.equal(checkedOut.base_revision, reverted.head);
      const localScene = join(workspace, 'project', SCENE), localText = readFileSync(localScene, 'utf8');
      writeFileSync(localScene, rootProperty(rootProperty(localText, 'counter_step', '17'), 'allow_open', 'true'));
      const binary = Buffer.from([10, 0, 255, 128, 64, 2]); writeFileSync(join(workspace, 'project/opaque/local.bin'), binary);
      const remote = await edit('main', files => files.set(SCENE, Buffer.from(rootProperty(files.get(SCENE).toString(), 'metadata/online_note', '"retain-online-edit"'))), collaborator);
      await waitUiHead(remote.head); const before = databaseSnapshot();
      const result = await cli('cli-sync', 'sync'); synced = await head(); await waitUiHead(synced.head);
      assert.equal(result.base_revision, synced.head); assert.equal(databaseSnapshot().revision_count, before.revision_count + 1);
      const actual = await source(), text = actual.files.get(SCENE).toString();
      assert.match(text, /^counter_step\s*=\s*17$/m); assert.match(text, /^allow_open\s*=\s*true$/m); assert.match(text, /retain-online-edit/); assert.match(text, /retain-later-collaborator-edit/);
      assert.equal(readFileSync(localScene, 'utf8'), text); assert.deepEqual(actual.files.get('opaque/local.bin'), binary);
      for (const path of ['opaque/author.bin', 'opaque/author-notes.txt']) assert.deepEqual(actual.fixed.manifest.source_files[path], baseline.manifest.source_files[path]);
      assert.equal(await gameBuild(), oldBuild); assert.equal((await gameSnapshot()).runtime_instance_id, oldInstance);
      assert.match(await counter(), /clicks=2.*open=false/); await pressE(); await waitCounter(/clicks=3.*open=false/);
      const status = await cli('cli-clean-status', 'status'); assert.deepEqual(status.changes, []); assert.equal(status.pending, null);
      const allMetadata = JSON.stringify(jsonFile(join(workspace, '.wa-workspace/state.json'))); assert.ok(!allMetadata.includes(actor.token) && !allMetadata.includes(actor.credentials.password));
      receipt.download_sha256 = sha256(readFileSync(downloadedCli)); receipt.workspace_id = checkedOut.workspace_id; receipt.base_revision = reverted.head; receipt.remote_revision = remote.head; receipt.synced_revision = synced.head; receipt.running_build_unchanged = oldBuild; receipt.running_instance_unchanged = oldInstance;
      evidence.json('downloaded-cli-sync-result.json', result); evidence.json('synced-manifest.json', synced.manifest);
    });

    await check('MU06', 'Explicit Web restart uses synced canonical content and resets only this independent run', ['A', 'G', 'B'], async receipt => {
      const oldBuild = await gameBuild(), oldInstance = (await gameSnapshot()).runtime_instance_id;
      await closeChat(); if (!await page.locator('#viewportMore').evaluate(element => element.open)) await page.locator('#viewportMore summary').click(); await page.locator('#restartPlay').click();
      await waitCounter(/JourneyA.*clicks=0.*open=false/);
      await waitFor('actual restarted Godot instance', async () => (await gameSnapshot())?.runtime_instance_id !== oldInstance, {timeout: 20000});
      const buildId = await gameBuild(), build = (await request('GET', '/creation-api/builds/' + buildId, {actor})).value.job;
      assert.notEqual(buildId, oldBuild); assert.equal(build.source_revision, synced.head); assert.equal(build.status, 'completed');
      await pressE(); await waitCounter(/clicks=1.*open=false/); await pressE(); await waitCounter(/clicks=2.*open=true/);
      assert.equal((await head()).head, synced.head); assert.equal(databaseSnapshot().public_release_count, 0);
      receipt.build_id = buildId; receipt.canonical_identity = build.canonical_identity; receipt.source_revision = build.source_revision; receipt.actual_counter = await counter(); receipt.new_instance_id = (await gameSnapshot()).runtime_instance_id;
      evidence.json('actual-synced-web-build.json', build); await page.screenshot({path: join(evidence.directory, 'actual-synced-web-restart.png')});
    });

    await check('MU07', 'Disconnected downloaded CLI assembles unsynced native source; two actual headless GameRuntime starts reset to initial state', ['A', 'G'], async receipt => {
      const scriptPath = join(workspace, 'project/scripts/main.gd');
      writeFileSync(scriptPath, readFileSync(scriptPath, 'utf8').replace('func _ready() -> void:\n', 'func _ready() -> void:\n\tcall_deferred("_candidate_reopen_probe")\n') + `
func _candidate_reopen_probe() -> void:
\tif OS.get_environment("WA_CANDIDATE_REOPEN_PROBE") != "1": return
\tawait get_tree().process_frame
\tvar runtime: Node = get_node_or_null("/root/GameRuntime")
\tif runtime == null or attempts != 0 or door_open or not allow_open or counter_step != 17:
\t\tpush_error("CANDIDATE_REOPEN_BAD_INITIAL_STATE")
\t\tget_tree().quit(11)
\t\treturn
\tprint("CANDIDATE_REOPEN_INITIAL scene=", runtime.get("current_scene_id"), " clicks=", attempts, " open=", door_open, " step=", counter_step, " creator_token=", not OS.get_environment("WORLD_ATELIER_TOKEN").is_empty())
\tinteract("candidate-scripted-input", {})
\tinteract("candidate-scripted-input", {})
\tif attempts != 2 or not door_open:
\t\tpush_error("CANDIDATE_REOPEN_BAD_INTERACTION")
\t\tget_tree().quit(12)
\t\treturn
\tprint("CANDIDATE_REOPEN_AFTER clicks=", attempts, " open=", door_open)
\tget_tree().quit(0)
`);
      // Test-only network denial is in the caller process, outside source. The
      // actual Godot importer/runtime also uses the product's OS isolation.
      writeFileSync(join(service.data, 'deny-network.cjs'), `const deny=()=>{throw Error('Candidate offline process attempted network access');};globalThis.fetch=deny;require('node:net').Socket.prototype.connect=deny;for(const m of ['node:http','node:https']){require(m).request=deny;require(m).get=deny;}\n`);
      const before = treeHashes(join(workspace, 'project')), dbBefore = databaseSnapshot();
      const godot = process.env.GODOT_BIN ?? '/Applications/Godot.app/Contents/MacOS/Godot';
      const prepared = await cli('cli-disconnected-prepare', 'prepare-play', ['--godot=' + godot], {offline: true});
      assert.equal(prepared.network_required, false); assert.equal(prepared.local_edits_included, true); assert.equal(prepared.source_modified, false);
      assert.match(readFileSync(prepared.project, 'utf8'), /GameRuntime=/); assert.match(readFileSync(prepared.project, 'utf8'), /run\/main_scene="res:\/\/atelier_runtime\/standalone.tscn"/);
      assert.deepEqual(treeHashes(join(workspace, 'project')), before);
      const markers = [];
      for (let run = 1; run <= 2; run++) {
        const execution = prepareExecutionEnvironment({directory: join(service.data, 'reopen-execution-' + run), readPaths: [prepared.directory], networkOrigins: []});
        const invocation = execution.command(godot, ['--headless', '--audio-driver', 'Dummy', '--path', prepared.directory, '--quit-after', '180'], {godot: true, projectPath: prepared.directory, logName: 'reopen.log'});
        assert.deepEqual(execution.capabilities.loopback_tcp_ports, []); assert.equal(invocation.options.env.WORLD_ATELIER_TOKEN, undefined);
        const result = await processRun('actual-offline-godot-reopen-' + run, invocation.command, invocation.args, {options: invocation.options, env: {...invocation.options.env, WA_CANDIDATE_REOPEN_PROBE: '1'}, cwd: invocation.options.cwd ?? prepared.directory, timeout: 30000});
        const log = result.stdout + result.stderr;
        assert.match(log, /CANDIDATE_REOPEN_INITIAL scene=journey-a clicks=0 open=false step=17 creator_token=false/);
        assert.match(log, /CANDIDATE_REOPEN_AFTER clicks=2 open=true/);
        assert.doesNotMatch(log, /SCRIPT ERROR:|Parse Error:|CANDIDATE_REOPEN_BAD/);
        markers.push(log.split('\n').filter(line => line.startsWith('CANDIDATE_REOPEN_')));
      }
      assert.deepEqual(treeHashes(join(workspace, 'project')), before); assert.equal((await head()).head, synced.head); assert.deepEqual(databaseSnapshot(), dbBefore);
      receipt.offline_revision = prepared.revision; receipt.local_source_identity = prepared.source_identity; receipt.unsynced_source_preserved = true; receipt.real_engine_markers = markers; receipt.network_ports = [];
      evidence.json('disconnected-prepared-game.json', prepared);
    });
    assert.deepEqual(pageErrors, [], 'Unexpected browser script errors');
    assert.equal(implementationSnapshot().product_identity, evidence.report.source.product_identity, 'Product implementation changed during candidate execution.');
    completed = true;
  } catch (error) {
    evidence.report.errors.push({message: error.message, stack: error.stack, details: error.details});
    console.error(redact(error.stack));
    if (page && !page.isClosed()) await page.screenshot({path: join(evidence.directory, 'failure.png')}).catch(() => {});
  } finally {
    evidence.json('browser-console.json', consoleLog); evidence.json('browser-page-errors.json', pageErrors); evidence.json('browser-http-routes.json', requests);
    if (page && !page.isClosed()) evidence.json('actual-received-events.json', await page.evaluate(() => window.__nextWaveEvents ?? []).catch(() => []));
    for (const child of ownedChildren) {try {process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');} catch {}}
    await browser?.close().catch(error => evidence.report.errors.push({phase: 'browser-cleanup', message: error.message}));
    await service.stop().catch(error => evidence.report.errors.push({phase: 'service-cleanup', message: error.message}));
    evidence.report.retained_test_data = service.data;
    evidence.finish({completed}); console.log('NEXT_WAVE_EVIDENCE ' + evidence.directory);
  }
  return {completed: evidence.report.completed, evidence_directory: evidence.directory};
}

// Delayed import is still read-only; it avoids accidental auth or service work
// when this module is imported for independent review.
async function register(label) {
  const {registerActor} = await import('./next-wave-test-support.mjs');
  return registerActor(label);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--run')) console.log('Developer-supplied candidate only. Review independently; pass --run when 48921 is free to execute.');
  else process.exitCode = (await runMergeOfflineUiCandidate()).completed ? 0 : 1;
}
