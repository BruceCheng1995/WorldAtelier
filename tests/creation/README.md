# 协作创作独立验收

日期：2026-09-07。角色：本工程唯一独立测试者。当前阶段：**后端 20/20、后续合并与缩放 10/10；真实 Agent 首次 4/5，取消修复后窄测 4/4；中央世界首次 10/11、修复后窄测 6/6；实际三任务内容窄测最终 8/8；停机与故障恢复 5/5；原样礼花接触/在线恢复最终 6/6，真实旧存档迁移 4/4。完整创作旅程仍未完成。** 各批运行属于各自源码快照，不能合称同一最终版本全部通过。

- [浏览器证据只读复核](../../.local/creation-verification/browser/INDEPENDENT-REVIEW.md)：复核主集成真实 CUA 原件与生产只读快照，不增加独立输入通过数；保留原位重启礼花 9→10 的真实失败。
- [A/B 集成计划](AB-INTEGRATION-PLAN.md)：层级预制件、目标验收及交叉旅程，全部等待正式集成后执行。
- [原样礼花恢复窄测](content-recovery.test.mjs)：最终构建ce877实际6/6，新epoch未join玩家online=false；另legacy模式4/4，用真实680产生无contacts checkpoint再恢复，不改数据库计数。平台contacts和业务inside分别留证。
- [验收计划](ACCEPTANCE-PLAN.md)：分阶段旅程、证据等级和三个真实 Agent 任务。
- [存储与权限复用审查](STORAGE-AUTH-AUDIT.md)：当前源码事实、需要守住的条件及待补接口。
- [后端驱动](backend.test.mjs)：真实 HTTP/WS、权限、事务、资产、会话草稿/附件和两类服务重启。
- [合并驱动](merge.test.mjs)：固定源/目标版本、冲突决议、幂等 receipt、重启和缩放范围。
- [真实 Agent 驱动](agent.test.mjs)：实际 App Server、文件/命令/动态工具、同会话续聊、完成态重启和中断；不创建用户三个正式玩法任务。
- [真实取消窄测](agent-cancel.test.mjs)：实际迟到 command、官方精确 terminate、OS/心跳/自然期限、清理前新轮门禁及重启核对。
- [中央世界驱动](world.test.mjs)：首轮 10/11，修复后 6/6 窄测；实际双用户物理世界、候选验证与发布、坏候选、输入围栏、持久快照恢复。没有伪造 `world_inspection`，不替代浏览器个人检查体验。
- [实际内容触发窄测](content-trigger.test.mjs)：通过 API 原样导入生产发布清单及 9 个哈希资产。首次 2/4 暴露误触；平台修复后最终 8/8，包括圈外/圈内应用、退出再入、珊瑚 E 和实际 GLTF/应用文档检查。保留误触与导航失败。
- [停机与故障恢复窄测](world-recovery.test.mjs)：真实 **5/5**；仅对自身进程组发送 SIGINT，对自有 authority 发送 SIGKILL，检查真实 checkpoint、故障隔离、显式验证恢复和故障历史。保留真实故障包与验证器错误，未伪造 ACK。
- 机器可读矩阵：`.local/creation-verification/audit-matrix.json`；原始证据及后端摘要：`.local/creation-verification/backend/SUMMARY.md`。完整混合旅程不能由局部后端证据推定通过。
- 产品契约：[CREATION-PROTOCOL](../../docs/CREATION-PROTOCOL.md)、[CREATION-ACCEPTANCE](../../docs/CREATION-ACCEPTANCE.md)。

新测试只使用端口 **48921**、临时数据和自己的账号/项目/文档/世界。占用端口时退出并报告，不终止不属于测试的服务。驱动自行设置 `WORLD_ATELIER_PREVIEW_DATA`、`WORLD_ATELIER_CREATION_DATA`，实际启动 `services/preview/server.mjs`；结束停止拥有的进程，保留数据/日志便于复查。后端/合并驱动显式关闭 Agent 和 Godot 世界；Agent 驱动启用真实执行器并设 `WORLD_ATELIER_DISABLE_WORLDS=1`。这些测试隔离开关不代表生产服务未集成。

```sh
node --test tests/creation/backend.test.mjs
node --test tests/creation/merge.test.mjs
node --test tests/creation/agent.test.mjs
node --test tests/creation/agent-cancel.test.mjs
node --test tests/creation/world.test.mjs
WORLD_ATELIER_WORLD_FOCUS=boundaries node --test tests/creation/world.test.mjs
node --test tests/creation/content-trigger.test.mjs
node --test tests/creation/world-recovery.test.mjs
```

恢复窄测的通用计数行为仅属于临时测试项目；迟发 VM 错误是明确的故障注入，不修改三个正式玩法脚本。

最终后端运行：`2026-09-07T06-24-01-554Z-bd915c84`，20 个业务阶段通过，Node 统计 21 个测试包含父容器。没有执行 Agent、Godot authority 或浏览器；上传的 GDScript 本轮仅检查字节/权限，不代表编译与运行通过。

合并/缩放运行：`2026-09-07T06-31-50-056Z-c64987a2`，10 个业务阶段通过。覆盖预览后源或目标更新拒绝、未决冲突不半写、显式 source/target、同决议重试不重复广播、重启恢复及 HTTP/WS 接受 scale 0.1/5、拒绝 0.01/100。合并 receipt 在该轮开始前已由集成者补齐，没有把代码审查虚报为一次修复前失败。

Agent 运行：`2026-09-07T06-45-20-568Z-86b37f93`，5 个阶段中 4 通过 / 1 失败，Node exit 1。读取、原生命令/文件、写回、去重、完成态重启与第二轮续聊通过；实际 `turn/completed: interrupted` 后 5 秒内 OS PID 仍存在。原检测没有区分执行进程与 zombie，服务随后关闭使归因不明，尚未证明副作用继续或确定停止；原始失败保留。详见 `.local/creation-verification/agent/SUMMARY.md`。初始 HTTP 202 不代表目标完成。

取消修复后窄测 `2026-09-07T07-22-25-551Z-872812ba`，4/4 通过，实际复现 terminal 后 94 ms 才到的 command started；官方精确 terminate 确认，OS 进程消失，超过命令自然期限仍只有 1 行心跳、无结束文件。清理前和重启后未核对时新轮 409，reconcile 后 verified，未重发目标。此前其余 Agent 阶段未重复，不把它们算作新源码全回归。详见 `.local/creation-verification/agent-cancel/SUMMARY.md`。

中央世界运行 `2026-09-07T07-06-27-871Z-cdd59767`，构建 `1ffec7f5…f2fe5a6`，10/11 通过；切换到另一分支后旧世界输入仍生效，实际水平移动约 2 米，原始失败保留。它启用真实 Godot authority 并显式禁 Agent，仅在自身临时目录注入资源损坏；使用实际 `--headless --path` 编辑器程序，不把它称为原生导出包验证。客户端不可变文件全量哈希通过，但下载正确不代表 GPU 渲染或真实游玩通过。关服恢复证明最近持久快照，尚不证明最后物理帧无损。详见 `.local/creation-verification/world/SUMMARY.md`。

修复后 `2026-09-07T07-14-24-019Z-013f76a1` 窄测 6/6：必要前置 2 项，控制围栏/并发 join/恢复 4 项。实际关服 checkpoint 已等到并原样保存，同一状态/hash 交给恢复验证器。被动 WebSocket 日志仅记录真实收发，不伪造 ACK。CW03–CW09 没有在此轮重复，因此不计成全部用例的新版本回归。

真实内容触发运行 `2026-09-07T07-55-55-448Z-d4d63060`，构建仍为 `1ffec7f5…f2fe5a6`：同一真实 Godot PID 下，未发送移动输入的两人加入后礼花计数为 2，圈外保持完整玩家状态不变，连续实际应用同一内容后变成 4、6；真实走入后为 7、停留保持 7。两项误触断言失败，Node exit 1。脚本未改，9 资产 SHA 和完整 7 资源清单只排除服务生成的版本号后相等；这不是测试者预制的玩法。详见 `.local/creation-verification/content-trigger/SUMMARY.md`。

平台修复后 `2026-09-07T08-04-15-790Z-18171dbb`，构建 `94921f68…ddd77ea6`，最终 **8/8**。圈外两次应用保持 0，入圈 1，圈内应用保持 1，退出再入变 2；真实珊瑚 E 产生唯一共鸣事件、计数 0→1 并在应用后保留。星门 GLB 实际解析 48 mesh，发给实际 authority 的文档保留原 TRS。中间 `08-02-24-850Z-ddca6d20` 的 6/8 记录保留：测试路线走下真实台沿，回走碰撞受阻，后续重入/E 未到验证点；仅调整测试路线速度与台内离圈点后复跑，不修改平台/内容来绕过碰撞。GPU 外观、操作和完整用户旅程仍须浏览器证据。

恢复运行 `2026-09-07T08-21-13-970Z-7671c747`，构建 `680cd7a5…5c04bb9d`，**5/5**：真实自有 Node 进程组 SIGINT，独立 Godot 进程组正常返回 checkpoint tick75，持久状态完全相等，原内容重入 epoch1→2；单独 SIGKILL authority 后自动 join422，显式验证恢复 epoch3，验证中并发 join422；真实迟发 VM fault 后三次加入及重启加入均422且不启动 authority，同坏候选实际验证失败；修正测试源码后显式恢复 epoch4，interactions1 与两个不可变故障历史保留。实际记录两次 runtime source 清单仅 `collaboration_overlay.gd` 不同，未重跑上面的内容8项或旧 Agent 套件。详见 `.local/creation-verification/world-recovery/SUMMARY.md`。

首次启动曾因模型目录键名错误失败；第一轮 19 阶段复现订阅代次重用、未知成员污染项目、坏 GLB 返回 500，另一个资产恢复阶段受前序中断影响。原始失败保留，修复后新数据复验通过。当前 `creation-flat-1` 明确拒绝层级节点，不能称完整 schema 2 / 通用预制件编辑已通过。

独立测试者负责 API、多用户真实 WebSocket 与真实 Godot 运行/输入检查。主集成者通过 CUA 使用两个独立认证的真实浏览器身份完成 GPU、界面和输入验收。协议 ACK、headless 节点和源码审阅不能替代浏览器画面。不得使用 Playwright CLI/MCP 绕过浏览器限制。

此前模型预览、64 项输入与 11 项历史事务、旧 `tests/e2e` 的结果仅是对应版本的既有证据，不计入本目录的协作创作通过数。三个指定任务全部成功，也只证明这些任务及实际接入路径；“完整 Agent 接入”另需工具、代码、真实审批/输入、取消、续聊和恢复的证据。

原样礼花恢复运行 `2026-09-07T09-16-42-748Z-a44c0298`，构建 `306c0114…34a1a1cc`，独立服务/运行时复制后 **6/6**。真实计数0→1，WS仍连着优雅停止/恢复空窗/原地重连保持1，真出入2，普通offline/rejoin保持2，真出入3；真实三条礼花事件，两段自有Node/Godot进程均退出。业务inside被原脚本prune后可为空，平台contacts保留；恢复空窗A未join但snapshot.online仍继承true，已报告，不算presence准确性通过。缺contacts的旧checkpoint、浏览器/原生包和A/B集成未在本轮验证。详见 `.local/creation-verification/content-recovery/SUMMARY.md`。

最终接触/presence复验 `2026-09-07T09-24-44-864Z-9a235f5e`，ce877构建6/6；新增实际旧存档迁移 `2026-09-07T09-25-18-038Z-21d32713`，680→ce877四阶段全过。旧checkpoint由真实旧Godot圈内停机产生，缺contacts字段；新进程实际物理查询建立成员基线，原地重连不增，真实出入才增。A未join空窗online=false，原脚本/9资产不变。两轮独立服务快照相同，30项旧/新runtime源码各自全量哈希匹配，无fakeACK或直接存档改写；详见 `.local/creation-verification/contact-presence/SUMMARY.md`。
