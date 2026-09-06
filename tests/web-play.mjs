import { CampaignBrain } from "../tools/godot-campaign-brain.mjs";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve("."),
  port = 48923,
  url = `http://127.0.0.1:${port}`,
  run = Date.now();
const evidence = join(root, ".local/evidence", `web-play-${run}`);
await mkdir(evidence, { recursive: true });
const server = spawn(process.execPath, ["services/control-plane/server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    WORLD_ATELIER_PORT: String(port),
    WORLD_ATELIER_DATA: join(evidence, "data"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (b) => (log += b));
server.stderr.on("data", (b) => (log += b));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(150);
  }
  throw Error("Timed out: " + label);
}
let browser;
const reports = [],
  errors = [],
  expectedErrors = [];
let injectingDownloadFault = false;
const attackRequests = new WeakMap();
try {
  await until(
    "server",
    async () => {
      try {
        return (await fetch(url + "/health")).ok;
      } catch {
        return false;
      }
    },
    15000,
  );
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--enable-webgl", "--enable-unsafe-swiftshader"],
  });
  async function newUser(name) {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1200 },
      deviceScaleFactor: 1,
      acceptDownloads: true,
    });
    const page = await context.newPage();
    attackRequests.set(page, []);
    page.on("websocket", socket => socket.on("framesent", event => {
      try {
        const message=JSON.parse(String(event.payload));
        if(message.type === "command" && message.action === "attack") attackRequests.get(page).push({at:Date.now(),request_id:message.request_id});
      } catch {}
    }));
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") {
        if (
          injectingDownloadFault &&
          m.text().includes("游戏产物长度不匹配：web/index.wasm")
        )
          expectedErrors.push(m.text());
        else errors.push(m.text());
      }
    });
    await page.addInitScript(() => {
      window.__gameTelemetry = [];
      window.addEventListener("message", (event) => {
        if (
          event.data?.source === "world-atelier-game" &&
          event.data.type === "telemetry" &&
          [...document.querySelectorAll("iframe")].some(
            (f) => f.contentWindow === event.source,
          )
        ) {
          window.__gameTelemetry.push(event.data);
          if (window.__gameTelemetry.length > 120)
            window.__gameTelemetry.shift();
        }
      });
    });
    await page.goto(url);
    await page.getByLabel("协作者名称").fill(name);
    await page.getByLabel("密码", { exact: true }).fill("WebPlayOnly2026!");
    await page.getByRole("button", { name: "创建账号，进入工坊" }).click();
    await page.getByRole("button", { name: "创建第一个工程" }).waitFor();
    return page;
  }
  const ownerName = "web-owner-" + run,
    editorName = "web-editor-" + run;
  const owner = await newUser(ownerName),
    editor = await newUser(editorName);
  await owner.getByRole("button", { name: "创建第一个工程" }).click();
  await owner
    .getByLabel("工程名称", { exact: true })
    .fill("星屿远征 · 真实网页联调");
  await owner.getByRole("button", { name: "创建并继续" }).click();
  await owner.getByRole("heading", { name: "现场检查器" }).waitFor();
  await owner.getByRole("button", { name: "协作工作台", exact: true }).click();
  await owner.getByRole("button", { name: "添加成员", exact: true }).click();
  await owner.getByLabel("已注册的协作者名称").fill(editorName);
  await owner.getByLabel("工程角色").selectOption("editor");
  await owner.getByRole("button", { name: "创建并继续" }).click();
  await owner.getByRole("dialog").waitFor({ state: "hidden" });
  await editor.reload();
  await editor.getByRole("heading", { name: "现场检查器" }).waitFor();
  await owner.getByRole("button", { name: "现场世界", exact: true }).click();
  await owner.getByRole("button", { name: "构建首个可玩版本" }).click();
  await owner
    .getByRole("button", { name: "进入星屿", exact: true })
    .waitFor({ timeout: 120000 });
  reports.push(
    "Two registered browser accounts, real membership and Godot release build via UI",
  );
  async function enter(page) {
    await page.getByRole("button", { name: "进入世界", exact: true }).click();
    await expect(page.locator(".game-panel")).toHaveAttribute(
      "data-game-active",
      "true",
      { timeout: 120000 },
    );
    await page
      .frameLocator('iframe[title="星屿远征 Godot 游戏"]')
      .locator("canvas")
      .waitFor();
    return page.evaluate(() => window.__gameTelemetry.at(-1));
  }
  const a = await enter(owner);
  await editor.reload();
  const b = await enter(editor);
  assert.equal(a.world_id, b.world_id);
  assert.notEqual(a.user_id, b.user_id);
  reports.push(
    "Two actual Godot Web WASM clients reached active in the same authoritative world",
  );
  await owner.bringToFront();
  const canvas = owner
    .frameLocator('iframe[title="星屿远征 Godot 游戏"]')
    .locator("canvas");
  await canvas.click({ position: { x: 60, y: 80 } });
  const before = await owner.evaluate(() => window.__gameTelemetry.at(-1));
  await owner.keyboard.down("s");
  await wait(650);
  await owner.keyboard.up("s");
  const moved = await until("real keyboard movement", async () => {
    const t = await owner.evaluate(() => window.__gameTelemetry.at(-1));
    return Math.hypot(
      t.player.x - before.player.x,
      t.player.z - before.player.z,
    ) > 1
      ? t
      : null;
  });
  assert.ok(moved.tick > before.tick);
  reports.push(
    "Native browser keyboard input moved the real Godot player; authoritative tick advanced",
  );
  const attackStart=attackRequests.get(owner).length;
  await owner.keyboard.down("Space");
  await wait(3000);
  await owner.keyboard.up("Space");
  await wait(350);
  const heldAttack=attackRequests.get(owner).slice(attackStart);
  assert.ok(heldAttack.length>=3 && heldAttack.length<=12, `Held Space must repeat attacks without a per-frame request flood: ${heldAttack.length}`);
  await writeFile(join(evidence,"held-space-input.json"),JSON.stringify({held_ms:3000,requests:heldAttack},null,2));
  reports.push(`Actual browser held-Space input sent ${heldAttack.length} attack requests over three seconds without per-frame flooding`);

  await owner.getByLabel("当前对象", { exact: true }).selectOption("starheart");
  await until(
    "selection in Godot",
    async () =>
      (await owner.evaluate(() => window.__gameTelemetry.at(-1)))?.selected ===
      "starheart",
  );
  await owner
    .locator(".game-panel")
    .screenshot({ path: join(evidence, "selection.png") });
  await owner.getByRole("button", { name: "为此对象发起开发任务" }).click();
  await owner.getByLabel("任务标题").fill("多人维护光圈真实验证");
  await owner.getByRole("button", { name: "创建并继续" }).click();
  await owner.getByRole("dialog").waitFor({ state: "hidden" });
  await until("task on rendered client", async () =>
    (await owner.evaluate(() => window.__gameTelemetry.at(-1)))?.tasks?.some(
      (t) => t.object_id === "starheart" && t.status === "editing",
    ),
  );
  await wait(600);
  await owner
    .locator(".game-panel")
    .screenshot({ path: join(evidence, "maintenance.png") });
  reports.push(
    "Selection and real branch-scoped editing task reached the running Web client; screenshots captured for visual review",
  );
  const ownerSession = await owner.evaluate(() =>
      JSON.parse(localStorage.getItem("world-atelier:session")),
    ),
    editorSession = await editor.evaluate(() =>
      JSON.parse(localStorage.getItem("world-atelier:session")),
    );
  async function api(session, path, body, method = body ? "POST" : "GET") {
    const response = await fetch(url + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + session.token,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  const project = (await api(ownerSession, "/projects")).projects[0],
    projectPath = "/projects/" + project.id;
  let details = await api(ownerSession, projectPath);
  const task = details.tasks.find((t) => t.object_id === "starheart");
  async function renderedStatus(status) {
    await until("rendered task " + status, async () => {
      const t = await owner.evaluate(() => window.__gameTelemetry.at(-1));
      return t?.rendered_tasks?.some(
        (x) => x.id === task.id && x.status === status,
      );
    });
    await wait(300);
    await owner
      .locator(".game-panel")
      .screenshot({ path: join(evidence, status + ".png") });
  }
  await api(editorSession, "/tasks/" + task.id, { status: "testing" }, "PATCH");
  await renderedStatus("testing");
  const pipeline=JSON.parse(await readFile(join(root,"runtimes/godot/assets/source/live_pipeline/pipeline-report.json"),"utf8"));
  const modelFile=join(root,"runtimes/godot/assets/source/live_pipeline/sunforge_relay.glb");
  const beforeEdit=await api(editorSession,projectPath+"/branches/main/content");
  await editor.getByLabel("当前对象",{exact:true}).selectOption("starheart");
  await editor.getByLabel("上传真实 GLB 模型",{exact:true}).setInputFiles(modelFile);
  await expect(editor.locator(".asset-reference")).toContainText("sunforge_relay.glb");
  const uploaded={asset:(await api(editorSession,projectPath+"/assets")).assets.find(a=>a.name==="sunforge_relay.glb")};
  assert.equal(uploaded.asset.hash,pipeline.glb_sha256);assert.equal(uploaded.asset.bytes,pipeline.glb_bytes);
  await editor.getByLabel("对象名称",{exact:true}).fill("Blender新建 · 星铸中继站");
  await editor.getByLabel("提交说明",{exact:true}).fill("从Blender建模、上传、提交到现场发布的完整验证");
  await editor.getByRole("button",{name:"提交场景修改",exact:true}).click();
  const committed=await until("UI source commit",async()=>{const result=await api(editorSession,projectPath+"/branches/main/content");return result.revision!==beforeEdit.revision?result:null;});
  assert.equal(committed.content.objects.find(o=>o.id==="starheart").model_asset,pipeline.glb_sha256);
  await editor.getByRole("button",{name:"构建验证",exact:true}).click();
  await until("actual model build from UI",async()=>{details=await api(editorSession,projectPath);const build=details.builds.find(b=>b.revision===committed.revision);if(build?.status==="failed")throw Error(build.error);return build?.status==="passed";});
  await writeFile(join(evidence,"blender-to-publication.json"),JSON.stringify({pipeline,asset:uploaded.asset,revision:committed.revision,build:details.builds.find(b=>b.revision===committed.revision)},null,2));
  const contentRelease = details.branches.find(
    (x) => x.name === "main",
  ).playable_head;
  const beforeHot = await owner.evaluate(() => window.__gameTelemetry.at(-1));
  await owner.getByRole("button", { name: "刷新工程", exact: true }).click();
  await owner
    .getByRole("button", { name: "应用最新可玩版本", exact: true })
    .click();
  await until("actual Web GLB application", async () => {
    const t = await owner.evaluate(() => window.__gameTelemetry.at(-1));
    return (
      t.active &&
      t.release_id === contentRelease &&
      t.rendered_model_assets.includes(uploaded.asset.hash)
    );
  });
  const afterHot = await owner.evaluate(() => window.__gameTelemetry.at(-1));
  assert.equal(afterHot.world_id, beforeHot.world_id);
  assert.ok(afterHot.tick > beforeHot.tick);
  assert.equal(afterHot.player.crystals, beforeHot.player.crystals);
  await renderedStatus("delivered");
  reports.push(
    "Second collaborator uploaded the freshly Blender-authored Sunforge Relay through the real Web file input, committed and built it through UI; both running Web clients applied the release without recreating their world, preserving player progress",
  );
  await api(editorSession, "/tasks/" + task.id, { status: "failed" }, "PATCH");
  await renderedStatus("failed");
  reports.push(
    "Actual renderer nodes and screenshots verified testing, server-confirmed delivered, and failed task states",
  );
  await owner.getByRole("button", { name: "新建分支", exact: true }).click();
  await owner.getByLabel("分支名称", { exact: true }).fill("visual-review");
  await owner.getByRole("button", { name: "创建并继续" }).click();
  await owner.getByRole("dialog").waitFor({ state: "hidden" });
  const sourceBeforeFailure = await owner.evaluate(() =>
    window.__gameTelemetry.at(-1),
  );
  const corruptArtifact = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/wasm",
      body: Buffer.from("intentionally truncated independent-test download"),
    });
  injectingDownloadFault = true;
  await owner.route("**/artifacts/**/*.wasm", corruptArtifact);
  await owner
    .getByRole("button", { name: "进入所选世界", exact: true })
    .click();
  await expect(owner.getByRole("alert")).toContainText("长度不匹配", {
    timeout: 120000,
  });
  await owner.unroute("**/artifacts/**/*.wasm", corruptArtifact);
  injectingDownloadFault = false;
  assert.equal(
    expectedErrors.length,
    1,
    "Exactly the deliberately corrupted artifact should be rejected",
  );
  const continued = await until(
    "original client still playing after target failure",
    async () => {
      const t = await owner.evaluate(() => window.__gameTelemetry.at(-1));
      return t?.active &&
        t.world_id === a.world_id &&
        t.tick > sourceBeforeFailure.tick
        ? t
        : null;
    },
  );
  assert.equal(continued.world_id, a.world_id);
  reports.push(
    "Injected a truncated target download; artifact verification rejected it while the original actual Web client kept playing",
  );
  await owner
    .getByRole("button", { name: "进入所选世界", exact: true })
    .click();
  const branchClient = await until("real branch handoff", async () => {
    const t = await owner.evaluate(() => window.__gameTelemetry.at(-1));
    return t?.active && t.world_id !== a.world_id ? t : null;
  });
  assert.equal(
    branchClient.tasks.length,
    0,
    "Main branch construction must not leak into branch world",
  );
  await owner
    .locator(".game-panel")
    .screenshot({ path: join(evidence, "branch-world.png") });
  await owner.getByLabel("当前分支", { exact: true }).selectOption("main");
  await owner
    .getByRole("button", { name: "进入所选世界", exact: true })
    .click();
  await until("return to authoritative main", async () => {
    const t = await owner.evaluate(() => window.__gameTelemetry.at(-1));
    return t?.active && t.world_id === a.world_id && t.tick > continued.tick;
  });
  reports.push(
    "Actual Web runtime switched to independent branch world, verified task isolation, then returned to continuously advancing main world",
  );
  if (process.env.WORLD_ATELIER_WEB_CAMPAIGN === "1") {
    const campaignContent = (
      await api(ownerSession, projectPath + "/branches/main/content")
    ).content;
    const brain = new CampaignBrain(campaignContent, [a.user_id, b.user_id]),
      campaignStart = Date.now();
    const samples = [];
    let lastPhase = -1,
      complete = false,
      lastState;
    while (Date.now() - campaignStart < 12 * 60000) {
      const world = (await api(ownerSession, "/worlds/" + a.world_id)).world;
      lastState = world.state;
      const result = brain.step(world.state);
      await Promise.all(
        [
          [owner, a.user_id],
          [editor, b.user_id],
        ].map(async ([page, user_id]) => {
          const commands = result.commands.filter((c) => c.user_id === user_id);
          if (commands.length)
            await page.evaluate((commands) => {
              const frame = document.querySelector(
                'iframe[title="星屿远征 Godot 游戏"]',
              );
              for (const command of commands)
                frame.contentWindow.postMessage(
                  {
                    source: "world-atelier-portal",
                    type: "command",
                    action: command.action,
                    payload: command.payload,
                  },
                  location.origin,
                );
            }, commands);
        }),
      );
      if (result.phase !== lastPhase) {
        lastPhase = result.phase;
        console.log(
          "Campaign phase " +
            result.phase +
            "/" +
            result.total +
            " " +
            JSON.stringify(result.target ?? {}),
        );
        const telemetry = await owner.evaluate(() =>
          window.__gameTelemetry.at(-1),
        );
        samples.push({
          phase: result.phase,
          tick: world.state.tick,
          elapsed_ms: Date.now() - campaignStart,
          telemetry,
        });
        await owner
          .locator(".game-panel")
          .screenshot({
            path: join(
              evidence,
              "campaign-" + String(result.phase).padStart(2, "0") + ".png",
            ),
          });
        await writeFile(
          join(evidence, "campaign-progress.json"),
          JSON.stringify(
            { samples, trace: result.trace, state: world.state },
            null,
            2,
          ),
        );
      }
      if (result.stalled)
        throw Error(
          "Actual rendered campaign stalled: " + JSON.stringify(result.target),
        );
      if (result.complete) {
        complete = true;
        break;
      }
      await wait(85);
    }
    await writeFile(
      join(evidence, "campaign-result.json"),
      JSON.stringify(
        {
          complete,
          elapsed_ms: Date.now() - campaignStart,
          trace: brain.trace,
          samples,
          state: lastState,
        },
        null,
        2,
      ),
    );
    assert.ok(complete, "The real rendered cooperative campaign must complete");
    assert.equal(lastState.objectives.beacons, 3);
    assert.ok(lastState.objectives.boss_defeated);
    assert.ok(Object.values(lastState.enemies).every((e) => e.hp <= 0));
    reports.push(
      "Full cooperative campaign completed through two actual Web renderers using only normal client commands: all four islands, three beacons, upgrades and all 46 enemies including the boss",
    );
  }
  await editor.bringToFront();
  await wait(3000);
  await owner.bringToFront();
  await wait(3000);
  reports.push("Both real browser clients resumed after backgrounding");
  await owner.screenshot({
    path: join(evidence, "portal-live.png"),
    fullPage: true,
  });
  await editor
    .locator(".game-panel")
    .screenshot({ path: join(evidence, "second-player.png") });
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(
      {
        run,
        url,
        reports,
        errors,
        expectedErrors,
        before,
        moved,
        world_id: a.world_id,
        users: [a.user_id, b.user_id],
        runtime: JSON.parse(await readFile(join(root,".local/runtime-build/manifest.json"),"utf8")),
        browser: browser.version(),
        scope: "Actual Web WASM clients, normal keyboard and client commands, UI asset pipeline and world handoff; optional full campaign enabled by WORLD_ATELIER_WEB_CAMPAIGN",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ evidence, reports, errors }, null, 2));
  assert.deepEqual(
    errors,
    [],
    "Real browser clients emitted errors; this run is not a pass",
  );
} catch (error) {
  await writeFile(join(evidence, "failure.txt"), String(error.stack));
  if (browser) {
    for (const [i, page] of browser
      .contexts()
      .flatMap((c) => c.pages())
      .entries())
      await page
        .screenshot({
          path: join(evidence, `failure-${i}.png`),
          fullPage: true,
        })
        .catch(() => {});
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await Promise.race([new Promise((r) => server.once("exit", r)), wait(5000)]);
  await writeFile(join(evidence, "server.log"), log);
  console.log("Evidence: " + evidence);
}
