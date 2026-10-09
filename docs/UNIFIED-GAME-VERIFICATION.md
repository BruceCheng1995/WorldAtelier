# 统一游戏入口迁移验证

2026-09-08。实现契约见 [统一游戏工程](./UNIFIED-GAME-RUNTIME.md)。测试由主集成与独立验证角色分别执行；保留原工作台、用户工程及历史检查，不以旧报告代替本轮证据。

## 实际游戏与浏览器

正式入口仍为 `http://127.0.0.1:48910/creation-workspace.html`。主集成使用现有 Bruce1 工作台打开“植物大战僵尸2d”，最终实际运行固定源 `src-fe2853346e10761e9eeefcdb358588ce8635629379c281ce758674b262e84ff9`。构建为 `build-66c95069-f6a8-4db7-95b1-ab79816f612b`，运行核为 `1f544e8c0eae327dc84e663d38cc9e02c6401ffd8f9fa9d62f2e123f9f6d7f69`，统一身份为 `a883c8dfe52cd5bcf880e848c6d1c866bda8b5d158c01761f28d5a624867465a`。

已直接检查中文标题、卡片、3D 文字，暂停前后背景与光照，显示暂停 UI、继续运行、停止返回原编辑器，以及新页面使用同一个构建 URL。未出现框架自动玩家和通用玩法控制区；停止恢复原编辑 iframe、当前源版本及七个预制件目录。实际截图经视觉核对；最终操作与产物身份记录于 `.local/unified-play/production-play-observation-final.json`。本轮没有宣告该游戏的五波战斗或历史玩法问题全部通过。

独立验证在 48921、独立数据库、账号、浏览器和存储目录进行，实际导出 Godot Web，未用前端替身代替游戏。最终 `1f544e8c…` 运行核证据位于 `.local/unified-play/verification/run-05/`：

| 检查 | 结果与证据 |
| --- | --- |
| 同包与字体 | 两入口实际网络 HTML、JS、WASM、PCK 字节与固定构建产物一致；中文 Label、draw_string、Label3D 可见。`browser/result.json` |
| 真实浏览器生命周期 | 15 项通过：作者真实 E 输入、独立两窗口、无框架默认玩家和动作、暂停固定 tick、只读 UI 的显示 ACK 与点击约束、检查相机鼠标输入、A→B→A、同关 reload、拒绝旧场景消息、重开和停止。`browser/result.json` |
| 存储 | 独立页面重载后真实存档存在；新嵌入 iframe 不继承；重开更换 nonce 并清空试玩存档。`browser/result.json` |
| 同输入对照 | 相同 906×875 视口、DPR 1、seed 1729；真实 E 键、进入 B、返回 A 后行为状态一致，明确排除墙钟 tick、存储路径和存档既存状态。`input-parity/result.json` |
| 工程和预制件 | 完整目录包含未摆放与嵌套预制件、固定历史定义及仅历史定义引用的实际脚本。`browser/result.json` |
| 独立原生引擎 | 28 项通过，包含无默认玩家、原生 SceneTree 生命周期、字体、暂停 UI/音频/Tween/粒子、游戏相机的环境、曝光、投影矩阵、偏移与恢复。`native-project/independent-result.json` |
| 停止竞争 | 真实服务已完成构建，但响应在停止后才到达，不能创建迟到 iframe。`stop-race/result.json` |
| 固定代码完整性 | 287 个固定源码文件无哈希偏移。`source-integrity.json` |

`run-04` 的 Web 15 项 / 原生 25 项属于删除默认玩家之前的中间运行核，保留原事实，不冒充本轮最终核证据。最终测试没有修改固定游戏运行核。额外的 headless `Input.parse_input_event` 物理键注入未触发作者行为，失败尝试单独保留于 `run-05/native-input-injection-attempt/`，未计入通过项；浏览器真实键输入及两入口同序列对照已通过，不能将其扩展为原生物理键注入通过。

最终独立报告与汇总为 `run-05/independent-report.md`、`run-05/independent-summary.json`。测试方自己的浏览器、driver 与服务已退出，48921 无监听，见 `run-05/cleanup.json`。

## 集成检查

| 检查组 | 结果 | 证据 |
| --- | --- | --- |
| 最终原生、Web、实际嵌入 GamePlay 与层级能力 | 2 个测试通过；验证没有默认玩家、作者自有玩法与暂停检查，实际导出 Web 并运行 | `.local/unified-play/final-current-runtime-tests.log`、`.local/creation-verification/no-default-player/native-NgiK9H/` |
| 统一自动技术检查 | 14 项通过，其中 4 项为真实 Godot 启动、故障、取消及 A→B 原生换场景；另 10 项是调度隔离检查 | `.local/unified-play/final-automatic-tests.log` |
| 工程、权限、身份、备份恢复、Agent 环境 | 60 项通过；实际 SQLite/资产/工程/Godot，模型 RPC 为明确替身 | `.local/unified-play/final-project-tests.log` |
| 前端桥接与生命周期 | 16 项通过；明确 DOM/传输替身，涵盖实际 UI 漏传版本标识的回归 | `.local/unified-play/final-bridge-tests.log` |
| Web 构建前端 | 12 项通过；服务解析、固定身份、取消、授权与历史记录 | `.local/unified-play/integrated-client-tests.log` |
| 原工作台回归 | 40 项通过；附件、层级编辑、相机、顶部布局 | `.local/unified-play/existing-ux-regression.log` |

## 自动检查迁移

独立验证发现旧自动技术检查仍从模型预览宿主启动，使合法 `GameRuntime` 行为被误报 initialize 失败。这项属于实际迁移缺陷，记录在 `run-04/observed-inbox-detail.json`，不能用 Play 通过覆盖。

修复将自动技术检查、Agent 的 `game_validate` 与兼容名称 `world_validate` 接到统一工程；共享权威世界仍有独立门禁。固定技术工程与后续独立 Agent 共用同一登记清单，运行源码、转换器、Godot 和验证器均进入身份。原失败记录保持原事实。

独立服务已真实重试原失败任务 `auto-check-25cc9173-5a84-4c62-9494-3b41d9039cf4`，生成 `auto-check-15d5d986-6064-4d4a-aa13-3fff469ea9c1`。最终 `1f544e8c…` 运行核下，六个资源全部通过真实统一工程启动与累计 120 tick 检查，当前问题列表为空；原任务仍保持 failed，历史 Inbox 标为过期，没有手工删除历史失败。证据为 `run-04/automatic-retry/result.json`。

该任务的固定工程同时经过实际备份创建和校验：98 个文件，32 个技术检查工程文件，以及六份 SQLite 内保存的实际命令、退出和运行输出，恢复内容逐项相等。证据为 `run-04/backup-proof-evidence.json`。这里证明技术检查与证据保存，不以无模型运行冒充完整独立 Agent 玩法判断。

## 数据保留与范围

迁移前完整备份在 `.local/unified-play/pre-migration-full-backup/`，989 个文件，37 个固定源版本和 8 个历史编辑运行包；原始备份也保留。最终记录哈希核对见 `source-preservation-before.json`、`source-preservation-final.json`：274 条受保护记录全部存在，270 条字节不变；原 37 个源版本、资产、消息、交付及检查记录保持原字节。

另外四条可变记录的差异为：两条分支的自动封面、植物游戏分支的源 head/文档序号，以及两条既有运行的服务租约代次。植物源 `src-fe285…` 是并行的真实创作任务 `run-420721c1-217f-4c46-b058-d53a167a8c69` 从 `src-978f…` 提交的子版本；本次保留该更新，没有回退分支。因此不能沿用迁移中途“分支 head 未变化”的描述。

新备份包含登记的构建输入、原生应用、Web 文件、Agent 固定工程，以及技术检查与独立验证共用的固定工程。旧未登记检查保留源、资产、结论及已有证据，并明确记录无法恢复当时精确工程的边界；不补造历史清单。

最终正式数据备份 `.local/unified-play/post-migration-final-backup/` 已创建并通过实际校验，包含 1,287 个文件、38 个源版本、9 个编辑运行包，并核对已包含本轮最终 `build-66c95069…` 的完整 Web 文件。日志为 `post-migration-final-backup.log`、`post-migration-final-backup-verify.log`。正式 48910 的唯一监听服务健康，未另开交付端口；临时浏览器游玩页已关闭，原工作台恢复编辑模式。

未覆盖全部浏览器、移动触屏、打包桌面应用的人工交互，也未以模型 RPC 替身宣告真实模型 Agent 完成玩法目标。任意原生 `.tscn` 往返、动态行为预制件注册、历史多存档合并及可变工作目录原子备份仍不是本次已实现能力。中央源稿及共享权威状态继续按各自门禁维护。
