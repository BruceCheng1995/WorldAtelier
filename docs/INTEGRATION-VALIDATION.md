# A / B 第一阶段集成验证

2026-09-07 **19:26 收口**。主开发负责唯一集成，沿用 `status_vfx_test` 独立验证；设计师维护体验目标与证据索引。**本批 A/B 集成已完成已约定的关键流程及交叉验收**，常用入口保留运行。完整 Case 02 / 05 / 13 的全部变体、20 个用户 Case 全集及后续能力没有因此全部关闭，具体覆盖与欠项见本索引。

顺序：原三个内容任务及运行修复复验 → A 层级 / 预制件与运行适配 → B 目标验收与真实证据采集 → A+B 交叉验证及原内容回归。共享文件、运行应用与 48921 验收串行；作者在隔离 worktree 修复其负责模块。

## 必须看到的结果

| 范围 | 用户操作与通过条件 | 本次必须留存的证据 |
| --- | --- | --- |
| 迁移与运行门禁 | 独立旧场景迁移不丢内容；旧在线世界继续。新格式未受运行时支持时 Play 明确拒绝；不得丢弃层级或悄悄玩旧版。成功落库不能因旧状态投影报错而显示保存失败 | 公共入口结果、迁移前后内容、旧世界持续运行。门禁、新面板和目标 / 协作身份接点未接通前不开放迁移；Play 必须核对本次请求的固定源版本 |
| Case 02：空间操作 | 导入真实模型，非零高度、多轴旋转、非均匀缩放；移动父级、重挂、撤销及取消；两用户看到同一结果 | 公共工作台输入、Godot 画面、拾取与数值、第二用户观察；错误或过期坐标请求保留原内容 |
| Case 05：实例与定义 | 两场景三个同源实例：只改一个，独立改定义，预览影响并升级；嵌套物随父级移动；删除被覆盖节点有明确决议 | 目录、独立编辑、3D 视口连续操作，覆盖保留、冲突拒绝及处理、重开后的实例对照 |
| Case 13：完成可信 | 同对象两个独立目标；只验收完成的一个。真实失败重试、中断清理、主人回复输入 / 审批分别记录；实际试玩后逐条件通过 / 拒绝 / 要求修改 | 真实 Agent 事件、同轮固定验证 / 应用记录、可信观察证据、四层界面状态。未触发的变体记未执行 |
| A+B：验收版本 | 验收后修改源稿或升级预制件，旧决定保留为历史且不可证明新版；正常游玩推进时间不误失效 | 公共界面历史 / 当前状态、旧证据拒用、新轮次。B 当前按整个源版本失效，不能宣称已做精细依赖判断 |
| A+B：嵌套目标 | 两个小屋均含同名门，分别附到不同目标；只修改 / 验收一个，切场景、分支、会话后仍准确 | 点选、附件、执行目标与证据对应同一完整实例路径；另一实例不变；迟到采集不能写入新目标 |
| 持久化与权限 | 重开恢复验收历史；共享读者不能默认代验；撤权后旧页面也不能提交；修改要求继续关联原目标 | 真实账户、公共路由、界面重开、权限变更结果；幂等决定、同目标续修与私人信息隔离 |
| 原三个内容回归 | 角色与珊瑚树交互；进出固定锚点触发礼花，圈外加入 / 热应用不误计数；编辑和 Web Play 均能看到保留原结构的星门地球仪 | 本批集成版本下的实际画面、输入和权威结果；原制作来源可追溯。旧录屏不能代替回归 |

个人检查的已有冻结 / 返回实时路径也需回归。**个人检查中编辑与 Case 19/20 跨端仍是后续交付，本批通过不关闭这些需求。**

## 固定基线与结果记录

每批记录 `源码提交或哈希清单｜运行构建 hash｜时间｜独立场景 / 数据来源｜用例和变体｜通过 / 失败 / 阻塞 / 未执行｜画面及原始证据路径`。代码改变后，对受影响项复验；失败证据保留。作者自测与独立验收分别列出，不能相加为用户 Case 通过数。

| 阶段 | 当前已知状态 | 下一门槛 |
| --- | --- | --- |
| 原内容与运行修复 | 常用 48910 已实际升级 1dde489c / epoch6，正式源 efba 保留 flat。双 Web 位置与原计数保留；再次珊瑚交互 2→3、真实离开再入礼花 10→11；冻结 / 返回和星门模型回归已有记录 | 保留明确测试范围，不把旧失败覆盖成成功，也不推定未执行变体 |
| A 第一阶段 | 独立 Godot 专项 13/13，浏览器 Case 02 / 05 关键流程已有实测与完整浏览器索引；数值 / gizmo / 定义升级 / 固定 Play / 个人检查及相机聚焦均有对应记录 | 尚未覆盖的变体单列，不把关键流程扩成全例通过。正式源稿未自动迁移 |
| B 第一阶段 | 真实协议专项 5/5 后，浏览器逐条件证据 / 原始 JPEG 上传 / pass / 多目标独立状态 / 源变化转历史均已操作；独立存储恢复后，主开发又补验了包含最终 JPEG / 决定的新版快照恢复 | Case 13 未覆盖 UI 变体保留；仍未验证恢复后开服，补充恢复不增加独立测试计数 |
| A+B 与原内容回归 | 1dde 下原内容已实际回归；同名嵌套目标 / 版本 / 权限交叉独立 6/6，通过后主开发补做实际页面与新草稿附件核对 | 本批收口；不扩为所有 UI 变体 / 任意 Agent 能力 / 跨端通过 |

交付索引在 `.local/coordination/parallel-20260907-152356/tasks.json`；A 的 `6002f15` 与 B 的 `f6463328` 是源码快照基线，禁止整体合回。A 的共享 store 只按函数级接入，不能覆盖主开发的新修改。

原内容复验：[本次报告](../.local/creation-verification/content-trigger/2026-09-07T08-04-15-790Z-18171dbb/report.json)，runtime `94921f68a04ef84c8ab3d5e32663ccc49058cab60757e92b3d3f866addd77ea6`。8 项通过、无失败、执行期间源码未变化；真实 Godot headless 和两个认证协议客户端，**不含浏览器 / GPU 验收**。A/B 集成后还需对受影响内容回归。

后续证据分开记录：[恢复专项 5/5](../.local/creation-verification/world-recovery/2026-09-07T08-21-13-970Z-7671c747/report.json) 使用 runtime `680cd7a5a2b5e07654e24e0840e6279ba0478301d6848db0d52c22545c04bb9d`；真实 headless Godot 停机 / 故障恢复，无浏览器。双 Web 的 [冻结与另一用户输入](../.local/creation-verification/browser/freeze-peer-input.json) 显示同 world / epoch 中，A 固定 tick 246106 / sequence 35164，B 推进至 tick 252168 / sequence 36030；[返回实时](../.local/creation-verification/browser/return-live.json) 为 playing / sequence 36959。[个人检查画面](../.local/creation-verification/browser/owner-still-frozen-peer-moved.png) 与 [珊瑚反馈画面](../.local/creation-verification/browser/coral-e-peer-effect.png) 已打开核对。该记录不证明“检查中编辑”已完成。

主集成下一步所需的 [schema2 派生运行包方案](coordination/SCHEMA2-RUNTIME-PROPOSAL.md) 已由独立 agent 准备并放入被动待办；未派发实施，也未修改 A 的源稿接口。

### 2026-09-07 17:30 更新

上段方案是早期协调记录；主开发随后正式固定契约并取得 A 的纯运行包交付，当前按 [运行包交接](handoffs/hierarchy-runtime-HANDOFF.md) 集成。设计师本轮只读核对源码接点与报告，未改工程实现、启动服务或向现有任务注入指令。

- **恢复缺陷的后续复验：** [6 阶段接触 / 在线身份](../.local/creation-verification/content-recovery/2026-09-07T09-24-44-864Z-9a235f5e/report.json) 与 [4 阶段旧存档迁移](../.local/creation-verification/content-legacy-recovery/2026-09-07T09-25-18-038Z-21d32713/report.json) 均 completed / 全部通过 / 执行期间源码未变化，目标构建 `ce87792bf7e822cb0d597917a9626b1d5907d713d580e8c10c85e2d09f318bb9`。使用真实 headless Godot、认证协议客户端、实际停止 / checkpoint / 恢复，原礼花脚本不变；没有浏览器 / GPU，也未执行 Agent。[摘要及范围](../.local/creation-verification/contact-presence/SUMMARY.md)。
- **保留真实失败：** 680 双 Web 最终重启中原地礼花 9→10，见 [独立只读复核](../.local/creation-verification/browser/INDEPENDENT-REVIEW.md)。后续专项通过不改写这次结果，也不推广为任意内容 / 坏存档迁移已验证。
- **当前基础后端回归：** [20/20 报告](../.local/creation-verification/backend/2026-09-07T09-27-24-487Z-fe72b8ee/report.json) 为真实 HTTP / WS，completed 且源码未变；不含 Agent / Godot / 浏览器，不是新 A/B 用户用例通过数。
- **仍待真实体验：** Case 02 / 05 / 13 与 A+B 交叉验证尚未执行；个人检查中编辑、Case 19 / 20 范围不变。

### 2026-09-07 18:03 更新

- **ce877 双 Web 恢复已补验：** [前状态](../.local/creation-verification/browser/before-contact-upgrade.json)、[后状态](../.local/creation-verification/browser/after-contact-upgrade.json)、[两端 DOM](../.local/creation-verification/browser/contact-upgrade-ui.json) 已读取，[主创画面](../.local/creation-verification/browser/contact-upgrade-owner.png) 已打开核对。同一 world、源 `src-efba4a3a0ff7be1268079874a4dbcf996407cfa0966ceaa1a542311ca5012c60`，epoch 4→5；两端 playing，礼花 10→10、珊瑚 2→2，两角色位置保留，其中一名角色 Y 有约 0.000006 米浮点差异。此前 9→10 失败不改写。
- **A 独立专项 13/13：** [实际报告](../.local/creation-verification/hierarchy-world/2026-09-07T10-01-14-780Z-c08affc6/report.json) completed，13 passed / 0 failed，执行期间服务源码未变化；报告中的实际 runtime manifest 为 `1dde489c662e22971a8cf586aa7c278f92451d13c21944ed8d91f6666bbd0b25`、版本 0.3.0。覆盖固定能力及下载哈希、flat→hierarchy 迁移、两场景三实例固定引用、明确升级、双用户嵌套冲突及条件撤销、预览取消、保世界姿态重挂、真实模型 / 逻辑与矩阵、不支持碰撞和坏脚本拒绝、分支 / 附件身份及真实重启状态保留。使用隔离 48921 的 HTTP / WS 与实际 Godot headless；**没有真实 Agent、浏览器 / GPU、手柄或完整 Case 02 / 05 通过结论**。
- **B 完成合入，真实体验仍待验：** 主开发的 [当前实现记录](COLLABORATIVE-CREATION-IMPLEMENTATION.md) 已登记 capture、私有原图存储、backup、manager 与抽屉目标面板接入；[23 条纯 / 模拟检查日志](../.local/creation-verification/goal-workspace-root-tests.log) 为 B11 + A12，不视为 Case 13 或实际项目备份恢复通过。
- **仍待关闭：** Case 02 / 05 / 13、A+B 交叉验证和新集成版本的原内容回归。演示主干仍保留原 flat 源及运行版本，不因新构建或专项完成而自动迁移。

### 2026-09-07 18:40 更新

**A 浏览器关键流程已操作，完整用例未全部关闭。** 主开发在独立集成工程实际导入 tree GLB，修改高度 / 多轴旋转 / 非均匀缩放；修复 numeric Tab 使用旧版本的问题后实际验 Enter / Escape。真实 gizmo 一度被自己的 preview 回声取消，修复后重测 start → preview → commit 保存，另一用户实际看到 X=0.780909，并执行撤销。主开发还报告已操作保世界姿态重挂、父移动及撤销、嵌套门跟随、独立改定义 / 只升级 hut-b / 保留名称覆盖、其余实例维持旧引用、删除有覆盖节点的拒绝与明确 drop 决议，以及重开树核对。后者完整浏览器索引正在整理，不从最终源稿反推每一步已独立验收。

本产品索引已读取以下当前记录：

| 记录 | 本次核对内容 |
| --- | --- |
| [双端多轴字段](../.local/creation-verification/integration-ui/browser/dual-multiaxis-fields.json) | 两端为同一 build / document；Y=2.5、旋转 15/30/10、缩放 1.2/1.5/0.8 |
| [gizmo 提交](../.local/creation-verification/integration-ui/browser/gizmo-commit.json)、[另一端观察](../.local/creation-verification/integration-ui/browser/gizmo-peer-observed.json) | 事件保留完整地址和矩阵；另一端 X=0.780909、其余变换保留 |
| [双 Web Play](../.local/creation-verification/integration-ui/browser/hierarchy-dual-web-play.json) | 两端同 build 1dde489c、同 world / epoch3 / 已应用 revision，均 playing |
| [个人冻结](../.local/creation-verification/integration-ui/browser/hierarchy-personal-freeze.json)、[返回实时](../.local/creation-verification/integration-ui/browser/hierarchy-return-live.json) | A 固定 tick5392 / seq776，另一端及 latest 继续推进；A 随后 playing、冻结字段清空。没有据此关闭“检查中编辑” |

**B 真实协议专项 5/5：** [最终报告](../.local/creation-verification/agent-review/2026-09-07T10-26-04-392Z-1b21445e/report.json) completed / 5 passed / 0 failed / 源码未变，[摘要](../.local/creation-verification/agent-review/2026-09-07T10-26-04-392Z-1b21445e/SUMMARY.md) 保留同 goal / thread 两轮因果。真实 Agent 生成受控坏脚本 → 实际 Godot 拒绝且原世界继续 → revise → 原目标续修 → 验证 / 发布成功 → 实际交互计数 0→1 → 两份私有 server trace 原字节及 hash 核对 → pass。缺证据拒绝、决定幂等、旧 run 拒绝、私人读取权限也有实际记录。**没有 B 浏览器 UI / GPU / screenshot、待审批或取消的新通过结论。**

18:15 的“验证与恢复目标不匹配”已在该专项摘要中定位为测试副本缺字体 import cache，主开发实际 import 后继续；18:20 驱动超时保留，真实 Agent 没有被中断或重复派发，后续驱动接回原 run 完成。上述旧失败不覆盖，也不继续当作未解决的同一产品故障。

本轮仍待：B 浏览器 Case 13、A+B 交叉、1dde 新集成版本下原三个内容最终回归，以及各用例未覆盖变体。生产 48910 未升级 / 迁移；不将独立测试世界可玩描述为演示入口已更新。52 条前端纯 / FAKE 回归仅为主开发本次报告的辅助检查数，不计入用户 Case 完成数。

### 2026-09-07 19:07 更新

**上段的 B 浏览器和常用入口状态已推进。** [实际浏览器总索引](../.local/creation-verification/integration-ui/browser/SUMMARY.md) 已完成，运行构建仍为 1dde489c；期间前端修复按各次记录保留，最新 workspace SHA 为 `594ea6fbeded6a65e7c1194c2720a06020469d34afa01b271293c69a35a0a673`。最新 Enter Y12 → 主视口 F 的实际记录为 seq7 / targetY13.3807249；59 条纯 / FAKE 检查仅是辅助，不能计作浏览器验收。

- **B 网页实际验收：** 基线 count1 → 界面一次 E → count2 → 停止后持续 count2；上传真实 JPEG 原字节，初次错扩展名导致 415 的失败保留。勾选 3 份实际证据后提交 pass；[网页通过](../.local/creation-verification/integration-ui/browser/review-web-pass.txt)、[正常 tick 后仍通过](../.local/creation-verification/integration-ui/browser/review-tick-keeps-accepted.txt)、[原图字节核对](../.local/creation-verification/integration-ui/browser/review-upload-byte-audit.json) 已有留证。上传标记为 authenticated_user_upload / render_verified=false，不声称服务器认证了 GPU 画面。
- **多目标与版本：** 同对象的新真实只读 Agent 目标[尚未验收](../.local/creation-verification/integration-ui/browser/two-goals-second-unaccepted.txt)，[旧目标仍通过](../.local/creation-verification/integration-ui/browser/two-goals-first-still-accepted.txt)；手动改色源稿后[旧通过变为历史](../.local/creation-verification/integration-ui/browser/review-source-change-history.txt)。这些界面文本本轮已读取；不能据此关闭嵌套双门交叉专项。
- **真实在线备份 / 存储恢复：** [独立索引](../.local/creation-verification/backup-integration/2026-09-07T10-43-12-431Z-c61f15a5/SUMMARY.md) 记录首次 3/4 与最终 BI04 窄测 1/1，失败原件保留。恢复保留快照当时两份 trace、原 revise / pass 历史及第三轮未决记录；**快照早于后来 JPEG 和网页决定，不包含它们；未验证恢复后开服**。原始 Godot candidate / report / log 文件和宿主源码字节也不在该备份覆盖范围，详见索引。
- **常用 48910 已切集成运行构建：** [双 Web 加入](../.local/creation-verification/browser/1dde-dual-web-joined.json) 两端同原 world / epoch6 / build1dde / flat源efba，均 playing，位置保留。[恢复基数](../.local/creation-verification/browser/1dde-before-owner-join.json) 礼花10、珊瑚2；[再交互](../.local/creation-verification/browser/1dde-coral-interact.json) 珊瑚3；[离开](../.local/creation-verification/browser/1dde-anchor-exit.json) 礼花仍10，[重入](../.local/creation-verification/browser/1dde-anchor-reenter.json) 礼花11。上述原始世界与 DOM 状态已读取。
- **1dde 个人检查与原模型回归：** [冻结前](../.local/creation-verification/browser/1dde-freeze-before.json)、[另一用户输入](../.local/creation-verification/browser/1dde-freeze-peer-input.json) 中 A 固定 tick770134 / seq110027，B 实际移动并推进至 tick772458 / seq110359；[A 返回实时](../.local/creation-verification/browser/1dde-return-live.json) 为 playing / tick773214。主开发已查看星门在编辑、对象预览与 Play 中的实际画面，48 mesh 记录见 [模型元数据](../.local/creation-verification/browser/1dde-globe-models.json)。[旧取消清理](../.local/creation-verification/browser/1dde-cancel-reconciled.json) 为 cleanup verified，原 run 仍 interrupted，不改写成成功。
- **最后正在执行的本批交叉专项：** [嵌套目标报告](../.local/creation-verification/hierarchy-review/2026-09-07T11-05-00-459Z-e8c9d3ec/report.json) 当前 completed=false，无最终 counts。唯一独立测试角色使用新项目、两个真实 Codex 目标、实际 Godot 和权限检查；不能提前宣称全部通过。

剩余未覆盖变体按浏览器总索引保留：真实拖动按住时 Esc、真实迟到采集跨场景 / 会话、实际输入请求等未在这轮全部触发。个人检查中编辑、原生 / 离线往返与客户端升级仍是后续能力。本次只更新证据索引，没有追加开发或改动常用运行服务。

### 2026-09-07 19:11 后补充索引

- 常用入口与原内容的最终记录已整理为 [1dde 原三内容与常用入口回归](../.local/creation-verification/browser/1dde-FINAL-REGRESSION.md)：覆盖 epoch6 双 Web、原位恢复、真实珊瑚 / 礼花交互、星门三种视图、个人冻结 / 返回、协作者相机姓名标记及旧中断命令 cleanup verified。升级需要刷新重新加入，原 flat 主干未迁移；报告不自动替私人会话写验收决定。
- **后续 JPEG / 决定已补做存储恢复：** [补充摘要](../.local/creation-verification/backup-ui-complete/2026-09-07T11-11-17.195Z/SUMMARY.md)、[原始报告](../.local/creation-verification/backup-ui-complete/2026-09-07T11-11-17.195Z/report.json) 已读取。restore.ok=true，31 个文件、9 份证据；原 JPEG same_original=true，实际 SHA 与声明摘要同为 `f77cda839881cf244b7c64453f873e7be8252443734f24ce9acbc576199d9596`；真实网页 pass 决定和同对象两目标从恢复库读回。主开发在在线服务保持运行时补做该验证，**不增加独立测试数，不证明恢复后开服 / Agent 续跑**。
- 第一次独立快照不含后来图片 / 决定仍是事实；新报告验证的是之后产生的新快照。原始 validator 工作目录、Godot 宿主源码 / 引擎及 Agent 工作区仍不在备份格式内。未改变这些范围，也未复制或公开私人授权数据库。
- A+B 同名嵌套目标 / 版本 / 权限交叉专项仍待完整结果；本次未新增开发派发，未将已有单项结果扩为整批通过。

### 2026-09-07 19:26 本批收口

**A+B 交叉已完成：** [6/6 摘要](../.local/creation-verification/hierarchy-review/2026-09-07T11-05-00-459Z-e8c9d3ec/SUMMARY.md) 与 [原始报告](../.local/creation-verification/hierarchy-review/2026-09-07T11-05-00-459Z-e8c9d3ec/report.json) 本轮已读取，completed=true / 6 passed / 0 failed / 服务源码运行期间未变。固定 1dde489c，两个真实 Agent 目标绑定不同完整嵌套地址；左单实例覆盖和实际计数 0→1，右内容 / 计数0保持；撤权后原请求和读取拒绝；源定义升级后旧通过变历史，普通 tick 不误失效。[最终独立审计](../.local/creation-verification/hierarchy-review/2026-09-07T11-05-00-459Z-e8c9d3ec/independent-audit.json) 另核对 9 个后端文件、38 个运行源码和 8 个 Web 文件以及六次真实 Godot 验证。

保留具体边界：左 Agent 两次参数格式错误被平台拒绝、源稿不变，第三次自行纠正成功；这些错误未抹去。审核仍保守绑定完整 source revision，不能称为精细到目标依赖的失效策略。模型 / 计数逻辑使用注明来源的已有夹具，不称本轮重新创作了两个门资产。6/6 是协议 / 实际 headless Godot / 真实 Agent / 权限专项，不是 UI 全变体或原生客户端验收。

**主开发补充页面核对：** [浏览器索引末段](../.local/creation-verification/integration-ui/browser/SUMMARY.md) 留有原左右附件 / 目标状态 / 实例属性的实际查看，及 [两份新 UI 草稿附件](../.local/creation-verification/integration-ui/browser/nested-new-ui-draft-attachments.json)：右 [8,0,3]、左 [0,0,3]，完整路径各自固定。这两份是专项结束后的未发送草稿，不冒充原真实 Agent 附件。原 B 验收刷新页面后保留历史通过及 JPEG 引用。

**交付运行状态（主开发收口报告）：** 12–15 临时浏览器已关闭；独立 48921 自有服务优雅结束、checkpoint 保留；常用 48910 / 1dde489c 继续，两用户窗口保留。主干仍为 flat 源 efba，实验层级受开关控制，未自动迁移日常场景。入口为 `http://127.0.0.1:48910/creation-workspace.html`。

**明确保留：** 未触发的 UI 变体、个人检查中编辑、原生 / 离线与客户端升级、恢复后开服及其余未执行用户 Case。本批结束不代表这些需求被取消或完成。设计师仅更新索引；没有再次派发开发、重跑验收或操作服务。

关联：[用户体验 Case](USER-EXPERIENCE-CASES.md)、[产品进度](PRODUCT-EXPERIENCE.md)、[角色与文件权限](PARALLEL-EXECUTION.md)。
