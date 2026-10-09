# 目标验收闭环交接 · 开发 B

2026-09-07。第一阶段独立模块交付就绪，**尚未接入产品，也未完成真实体验验收**。主开发继续优先完成原三个指定内容任务及原验收；本交付不要求提前交出公共文件。普通交付通知发产品协调任务，由协调者按主开发排期交接。

## 基线、提交与文件所有权

- 隔离 worktree：`/Users/chengzhi/.codex/worktrees/285c/WorldAtelier`。
- 分支：`codex/goal-review-20260907`；开始时 detached HEAD `78b0b51eafeb28a2c06c8e613ec6aaf48dcc4d18`、无任何已修改或未跟踪文件，随后建立独立分支。
- 协调快照：`parallel-20260907-152356/source.tar.gz`，SHA-256 `c60fab3c4ad7a9494a9b1cef8aa8ad3e26bda9d2aa956f05cefebd445ee5f06a`。按安全相对路径逐项核验 250 个文件的字节哈希、大小、模式/执行位；删除清单为空。未导入 `.git`、`.local`、凭据、数据库或构建。
- 快照基线：`f646332865503aa6833ddd51c113e3399d1b12b0`。**禁止将此基线提交整体合回主工程**；快照不是已验收发行。
- 功能提交：`542e1e15be5c4b7ef7337660fe33b1090213a2d4`。
- 最终实现/自测提交：`3c1fc837d9ae947d680d3edadd9616ed215a159e`，在功能提交上修正独立浏览器测试的退出顺序。本文件由后续纯文档提交交付。
- A 的身份契约：已只读核对其 worktree 的 `docs/handoffs/hierarchy-prefabs-CONTRACT.md`，契约提交 `f6ff8b6`。没有复制其实现，也没有另建资源 schema。

| 新增文件 | 所有权与用途 |
| --- | --- |
| `services/creation/goal-review.mjs` | B；独立验收 ledger、状态投影、权限、幂等、历史 |
| `services/creation/goal-review-evidence.mjs` | B；可信固定证据的读取适配器 |
| `apps/creation-workspace/goal-review.js` | B；可挂载/销毁的独立审查面板，样式局限自身 class |
| `tests/creation/goal-review.test.mjs` | B 自测；真实 SQLite，执行/验证/应用/观察为明确替身 |
| `tests/creation/goal-review-ui.test.mjs` | B 自测；49032 静态夹具、独立 Chrome，服务数据全为替身 |
| `docs/handoffs/goal-review-HANDOFF.md` | B；本交接 |

没有修改 `workspace.js`、`index.html`、公共 CSS、公共路由、`agent-runs`、取消清理、`schema/store`、世界控制或 Godot。未使用 48900/48910/48921，未启动重型导出，未操作主目录数据库或别人的进程。

## 持久化与固定身份

直接使用现有 `Storage.get/list/put/transaction` 和 `CreationStore` 权限接口，无 DDL、无场景迁移。新增 document kind：

| kind | 事实 |
| --- | --- |
| `creator_goal_review_head` | 每个既有 goal 当前 review 的指针 |
| `creator_goal_review` | 固定目标标准、运行身份、源版本、构建、目标引用、技术/应用记录副本；带递增 version |
| `creator_goal_review_evidence` | 不可变体验证据、逐条件结果、观察文字、artifact ref/hash/pin、记录者 |
| `creator_goal_review_decision` | 不可变 pass/reject/revise、理由、明确选择的证据、决定者、时间 |
| `creator_goal_review_receipt` | 用户/目标/请求 ID 的幂等结果，事务内和记录一起提交 |
| `creator_goal_review_artifact` | 可选读取适配器消费的、由主集成可信采集服务写入的保留记录；本模块没有 HTTP 写入口 |

既有 `creator_goal`、`creator_run` 完全不改写。旧 `ready_for_review` 仅表示执行器阶段，客户端以 review 投影判断体验完成；不要将运行 `completed` 或 delivery 映射成目标已验收。

每轮固定：`goal_id + goal_revision(hash(objective, criteria)) + run_id + run_identity + revision + runtime_build_id + target_refs`。`run_identity` 包含 session/owner/input revision/input hash/executor thread/turn/client message ID；运行状态可以继续变化，但换 turn 或换目标绑定会使旧验收陈旧。验收标准不能在同轮改写，修订标准须新轮次。

`target_refs` 是既有 `run.targets` 的不透明副本。可保留 flat 引用，也可保留 A 的 `{address, versions}`，或主集成采用的其他既有规范包装；本模块不解释/拼装实例地址、不换算坐标、不追随最新源稿补齐旧引用。新地址的内部字段仍由 A 唯一管理。体验 artifact pin 也保留可信解析器给出的额外 opaque 地址、版本、state hash 和观察数据。

技术和应用引用必须来自本轮同一 run 的 `verifications/deliveries`。技术记录必须匹配本项目/分支/固定源版本/构建且已结束；应用记录须关联本轮选中的通过验证、同项目/分支/资源、实际 epoch 和 applied sequence。每轮复制这些记录，随后原记录被改写时不能继续沿用。

## 四层状态与转换

| 层 | 行为 |
| --- | --- |
| 执行 | 读取固定 run；failed、uncertain、等待输入、cancelling、cancelled 分开。任何 cancel/cleanup 标记且 cleanup 非 verified 时显示 `cleanup_unconfirmed`。verified 仅说明清理，不使已取消运行变为成功 |
| 技术验证 | 所选固定记录中有失败则 failed；没有记录是 not_recorded；记录被改写是 stale；全部通过才 passed |
| 现场应用 | 固定 delivery 与当前 world 的项目、分支、资源、源版本、构建、epoch、失败标记及 sequence 下界匹配才 applied；历史应用保留 |
| 体验验收 | pending → pass/reject/revise；分别投影 accepted/rejected/changes_requested。决定不覆盖；继续修订通过 open 新 cycle，保留 previous_review_id |

`pass` 同时要求：

1. 当前 cycle、goal 标准、run 身份、目标引用与源版本未变化；实际 run 成功完成，且无待输入/不确定/取消门禁。
2. 本轮固定技术验证通过；默认还需本轮现场应用仍匹配当前世界。
3. 显式选择的本轮体验证据覆盖每条 criterion；同一条件所选证据中不能同时包含失败结果。技术报告不能当体验照片或人工试玩结论使用。
4. 决定时重新读取证据字节/权限/哈希和完整 pin；目标、run、源版本、构建、world/epoch 与观察基线匹配。plain text、任意 URL 或 HTTP 自报 applied 不够。

世界 sequence 正常增长不使证据陈旧；观察只需 `sequence >= applied_sequence`。源 revision、运行构建、world epoch、身份/标准或固定记录变化会使此前 pass 显示 `accepted_historical`，不会抹除历史决定。当前采用**保守的完整 source revision 比较**：即使只改了无关内容，也需新轮次；尚未实现按目标依赖闭包排除无关修改。不能将本实现描述为已完成精细依赖失效算法。

纯编辑目标可在 open 时显式固定 `requires_application:false`；默认 true。此选择不制造应用记录，UI 仍显示尚无现场记录。开门、在线玩法等目标必须保持 true，由目标标准的主集成入口控制，不应提供含糊的“一键绕过”选项。

reject/revise 可记录失败或需要修改的原因，不宣称执行已停止；它们不会自动取消/重跑 Agent。开启下一次 Agent 运行仍必须经过主开发当前取消清理和会话串行门禁。

## 权限、隐私与事件

会话主人有默认验收权。项目 owner、共享会话读者、编辑者均没有默认代验权。主人可显式 setReviewers，但必须先把会话共享，受委派者必须仍有项目编辑权限。改回私人、撤销成员或降为只读后，读取/写入/原请求重放均重新核验。

`view/history` 只走 `sessionFor` 的私人/共享边界；它们包含私有目标、技术日志引用、体验文字，不能进入公共活动流。公共投影只保留 goal ID、经过资源适配器裁剪的对象身份、执行者 ID、四层状态；一目标一行，不按对象去重。无配置时 `publicTarget` 返回 null，默认不向公共端泄露原始 target。

记录和精简 session event 在同一 SQLite transaction 中持久化。方法返回 `event`（已有 cursor）。主集成在提交成功且 `!replayed` 后调用现有 `realtime.sessionEvent(review.session_id, result.event)` 广播；**不要再调用会重新 append 的 `service.sessionEvent` 复制同一事件**。断线后沿用 session event cursor 补齐。

公共多人推送应针对已验证订阅成员生成 `publicStates(user,p,b)`；不能广播 `view/history`、artifact 记录或原始错误。运行完成、权限变化、证据/决定、源提交、世界应用/重启后重新算投影。对象上多个目标仍分别显示，不能因一个 accepted 关闭整个维护状态。

## 主集成接入点与顺序

主开发完成原任务并准备接入时再执行；本任务未改动这些文件。

1. 保护主目录现有未提交代码；只按本基线之后的 B 新增文件差异集成功能提交、测试修复和本交接文档。不要 cherry-pick 快照基线。
2. 在 CreationService 装配 `new CreationGoalReview({store, resolveEvidence, publicTarget, hasPendingInput})`。原存储和取消清理由原负责人持有。`hasPendingInput(run)` 从真实执行器的 pending requests 读状态，必须匹配 session + executor turn，不能把另一个目标的请求串进来；重连后继续使用原 uncertain/reconcile 机制。
3. 加受现有认证、同源写入和 body 大小限制保护的路由。下表是建议路由，未自行写入公共服务；path 中的 goal/review ID 必须覆盖 body 同名字段。
4. Session 详情返回其可读 `creator_goal` 及每目标 review 概况。现有 sessionView 只返回 runs；必须补目标身份入口，不能用当前选中对象推断唯一目标。
5. 前端独立挂载，先显示四层状态，再实现 prepareReview 与可信 captureEvidence。初始 cycle 应在明确固定候选/技术报告/应用引用后打开；run 包含多个历史版本报告时，显式选择此次同一版本的 IDs，不混入以前失败或不同版本的记录。
6. 同一长期目标续修时，主集成在 Agent send 的既有事务中把新 run 关联至**原 goal ID**，更新其 current run 绑定；不要为该次续修再建第二个无关联目标。之后以旧 review ID 开新 cycle。B 不负责改 agent-runs；主集成完成取消/uncertain 门禁后再接此挂钩。
7. 替换旧按对象去重的 publicState 消费方式，保留所有目标。先在固定集成源码上跑模块自测，再由原唯一独立测试角色验证真实 HTTP/WS、真实 Agent/Godot、双人界面与 Case 13 变体。

| 建议路由 / 方法 | 调用参数 |
| --- | --- |
| GET `/creation-api/goals/:g/reviews` | `history(user,g)`；当前状态 `view(user,g)` |
| POST `/creation-api/goals/:g/reviews` | `open(user,g,{request_id,expected_review_id,run_id,revision,runtime_build_id,criteria:[{id,text}],verification_ids?,delivery_ids?,requires_application?})` |
| POST `.../:g/reviews/:r/evidence` | `addEvidence(user,g,{request_id,review_id:r,expected_version,artifact_refs,checks:[{criterion_id,result,observation}]})` |
| POST `.../:g/reviews/:r/decision` | `decide(user,g,{request_id,review_id:r,expected_version,outcome:'pass'|'reject'|'revise',reason,evidence_ids})` |
| POST `.../:g/reviews/:r/reviewers` | `setReviewers(user,g,{request_id,review_id:r,expected_version,reviewer_user_ids})`，仅主人 |

`open` 的 expected_review_id 初始为 null，后续为原当前 review ID。其他写操作携 expected_version。相同用户/goal/request_id 与同一 payload 返回原结果；改 payload、改 action、旧 version 或无权限均拒绝。收到不确定响应时保留完整原 payload/ID 重试；403/409 应解释权限或冲突，刷新后再形成新请求。

前端导出：

```js
const panel = mountGoalReview({
  container, goalId,
  load: goalId => api.readGoalReview(goalId),
  mutate: (goalId, action, payload) => api.mutateGoalReview(goalId, action, payload),
  prepareReview: view => showPinnedCandidateAndCriteria(view),
  captureEvidence: view => capturePinnedObservationAndChecks(view),
  onContinue: view => openOriginalGoalForRevision(view),
  onOpenArtifact: artifact => openAuthorizedEvidence(artifact.ref),
});
// 切场景/分支/session 或权限丢失时撤销旧挂载。
panel.dispose();
```

上述 api/UI 函数是**待主集成挂钩示例**，本交付不声称它们已经存在。prepareReview 返回 open 的固定版本和 criteria；captureEvidence 返回 `{artifact_refs,checks}`。面板保存网络不确定时的原 ID、版本和选中证据；迟到的读取/采集结果不能污染新挂载或在 dispose 后发送。

## 可信 artifact resolver 接口与样例

同步接口 `resolveEvidence({user,goal,review,reference}) -> {ref,sha256,kind,pin}`；服务事务内不允许 Promise。kind 仅 `browser_capture/runtime_trace/manual_observation`。它必须重验当前读取授权、确认保留的真实字节与摘要，并以服务端采集的观察身份返回 pin。直接把请求 JSON 返回会破坏信任边界。

```js
// 仅可信采集服务在实际观察/文件保留完成后登记。
// 下方值来自服务侧 capture receipt；不是把浏览器请求 body 写入数据库。
store.put('creator_goal_review_artifact', {
  id: capture.artifactId,
  project_id: review.project_id,
  session_id: review.session_id,
  capture_status: 'retained',
  storage_key: capture.immutableObjectKey,
  sha256: capture.digest,
  kind: 'browser_capture',
  pin: {
    goal_id: review.goal_id, run_id: review.run_id,
    revision: capture.observedRevision,
    runtime_build_id: capture.observedBuildId,
    world_id: capture.worldId, epoch: capture.epoch,
    sequence: capture.worldSequence,
    inspection_ref: capture.inspectionRef,
    // 需要时附 A 契约的不透明 address/versions/state_hash，保留原观察。
  },
});
const resolveEvidence = createGoalReviewEvidenceResolver({
  store,
  readBytes: storageKey => immutableEvidenceStore.readBytes(storageKey),
});
```

`capture`、`immutableEvidenceStore` 是待接入的可信采集边界示例，不是已有产品能力。未接 resolver 时 addEvidence 返回 503；未登记/无权读取/字节摘要变化时拒绝。不得提供任意 URL 下载、任意本地文件读取，或让 Agent tool 直接写此 kind。技术验证报告仍引用原 creator_verification，不能改 kind 当体验证据。

采集权限和证据保留策略由主集成落实：同 session 的分享范围作用于读取；失去权限立即拒绝。固定 artifact 必须纳入引用保留，不能被清理器当临时截图删除。resolver 自身的哈希校验只证明字节和可信登记一致，无法自动证明画面里的门确实完成玩法目标；该判断由获授权验收者针对逐条条件记录。

## 本轮自测与证据

最终复验：Node `v26.3.0`，Google Chrome `152.0.7977.76`，代码/测试提交 `3c1fc837d9ae947d680d3edadd9616ed215a159e`，2026-09-07 15:48（北京时间）。

- **21/21 逻辑自测通过**：多目标、四层状态、真实 SQLite 重启持久化、请求重放/冲突、事务回滚、权限撤销、私人/共享/委派边界、旧 run/目标标准/内容/构建/epoch/证据拒用、sequence 增长不误失效、逐条件部分失败、跨轮修订历史、opaque 地址保留、可信读取适配器。
- **1/1 独立浏览器模块自测通过**：真实 headless Chrome DOM，1000px 与 420px 布局、四层状态、选择证据、文本注入不执行、网络未确认时原 ID 重试、读取失权清屏、dispose 后迟到采集不提交、异步旧读取不覆盖新结果；无 pageerror。所有产品状态响应均为明确夹具。
- **未执行**真实产品路由/会话挂钩、真实 Agent 失败/请求/取消、真实 Godot validator/应用、实际体验截图登记、同视口开门、双用户完整旅程、原三个内容任务和独立验收。这些仍交由主开发及唯一独立测试角色安排。

本 worktree 内证据：

- 最终报告：`.local/goal-review-tests/reports/2026-09-07T07-48-09-247Z/report.json`，包含源码 SHA-256、版本、范围、截图摘要与历史问题；`valid_for_delivery:true` 指**此独立模块自测交付有效**，不是产品 Case 验收。
- 同目录 `test.log`：22 tests / 22 pass / 0 fail / 0 cancelled / 0 skipped，完整约 1.02 秒，正常退出且无需人工清理。
- `.local/goal-review-tests/ui/panel-desktop.png`、`panel-narrow.png`：已实际打开检查，布局无横向溢出；图片明确标注自测夹具。

发现并保留的历史问题：首次 UI 尝试缺 Playwright 自带浏览器，改为显式使用本机 Chrome。首次合并运行在退出时先关 server、后关 browser，断言完成后等待连接退出；只向自己启动的测试进程发 SIGTERM。该轮虽然 reporter 返回 22 pass/exit 0，已在 `07-46-24-460Z/report.json` 明确标 `valid_for_delivery:false` 并记录干预，**不作为最终干净通过**。测试修复为先关闭独立浏览器，再关闭自身服务器连接，随后上述最终轮正常通过。

复现命令（在接入后工程副本，端口 49032 需空闲）：

```sh
node --test tests/creation/goal-review.test.mjs
GOAL_REVIEW_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/creation/goal-review-ui.test.mjs
```

也可让 GOAL_REVIEW_BROWSER 指向测试机已安装的浏览器，或省略它使用已安装的 Playwright Chromium。只启动自己的静态 server 和临时浏览器上下文；不使用日常浏览器、日常数据或 48921。

| 产品 Case | 本交付覆盖的自测 | 仍需真实验收 |
| --- | --- | --- |
| 13 | 逐目标关闭、失败/等待/取消清理不误成功、修订历史、版本证据门禁 | 三个真实执行变体、真实主人回复、开门试玩证明 |
| 07 | 私人/共享/委派和持久化、禁止默认代验 | 双会话工作台恢复及显式分享旅程 |
| 12 | 已应用与已验收分开、陈旧版本保留历史 | 真正兼容应用、双人进度保留与坏候选恢复 |
| 17 | 成员撤销/降权对新写入与重放生效、公共投影无私文 | 在线旧页面、排队目标和多用户界面 |

## 第二阶段依赖（未开始实现）

个人检查编辑继续使用同一任务，不另设验收负责人。必须等主开发完成原任务并明确交接，同时确认世界控制修复已复验、A 地址/坐标/预制件契约和实际运行适配固定。当前只保留需求：固定本人观察，后台世界与文档继续；编辑草稿叠层独立于动态姿态；按完整祖先/目标版本处理旧观察冲突；附件引用不可变观察；返回真实当前世界并清旧输入。**未在旧坐标契约上先写实现，等待不是第二阶段完成。**
