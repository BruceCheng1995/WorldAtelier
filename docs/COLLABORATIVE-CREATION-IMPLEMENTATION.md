# 协作创作实现记录

日期：2026-09-07。本记录跟踪正在集成的新工作台，不能替代完整产品验收。旧 Starfall 技术报告不用于证明此流程。本轮三个内容已由工作台中的真实 Codex 会话完成，并在双 Godot Web 视口实际操作；后续层级与目标验收集成使用独立的新验收范围。

## 最新实际结果（2026-09-07 19:11）

常用 48910 已实际升级到 Godot 0.3.0 / `1dde489c662e22971a8cf586aa7c278f92451d13c21944ed8d91f6666bbd0b25`，原 flat 主干未迁移、源稿 efba4a3a… 不变。两用户接回原世界 epoch6，位置与计数保留；本批实际网页珊瑚交互2→3、退出重入礼花10→11、星门地球仪在编辑/对象预览/Play可见。个人检查/返回实时及协作者相机姓名标记已复验，[原内容与入口报告](../.local/creation-verification/browser/1dde-FINAL-REGRESSION.md)。升级需要刷新并重新加入，不是自动无缝迁移。

层级/预制件在独立48921完成双端变换、真实gizmo、重挂/撤销、实例覆盖/定义选择升级和删除冲突处理，以及同世界双Web Play；原数值Tab旧版本、临时同步取消gizmo、加载期间丢聚焦三个问题已修复。最新工作台SHA594ea6fb…，59条纯/FAKE检查只作辅助；实际操作证据和未执行变体见 [A/B浏览器索引](../.local/creation-verification/integration-ui/browser/SUMMARY.md)。

目标验收已用真实Agent同目标两轮完成坏脚本拒绝→续修→验证/应用；真实网页逐条件采集、原图上传、保存决定、同对象两个目标隔离、正常tick仍有效及源变化转历史均已操作。页面区分执行、技术、应用和体验，原文以下的“验收待接”是此前阶段记录。A+B同名嵌套目标的 [独立真实交叉专项](../.local/creation-verification/hierarchy-review/2026-09-07T11-05-00-459Z-e8c9d3ec/SUMMARY.md) 已6/6：两个真实Agent目标、单实例覆盖、左交互1/右0、撤权拒绝、显式定义升级后旧决定保留。根代理另在页面点选两实例、查看各自目标，并实际添加两份准确路径/坐标的草稿附件。Agent曾两次写请求格式错误被拒后自行查契约修正，此失败保留；不称任意工具首次调用可靠。

实际在线备份与存储恢复已有 [独立核对](../.local/creation-verification/backup-integration/2026-09-07T10-43-12-431Z-c61f15a5/SUMMARY.md)。后续UI原图/决定产生后，根代理又做了一次 [完整当前UI证据的存储恢复](../.local/creation-verification/backup-ui-complete/2026-09-07T11-11-17.195Z/report.json)：31文件、9证据，恢复JPEG逐字节相同且原决定保留。两批均未测试恢复后开服；原始validator工作目录、引擎/宿主源码和Agent工作区不在该备份格式内。

明确后续范围：个人检查中直接编辑、原生/离线双向往返、多选/表面与顶点吸附、互联网部署和任意代码迁移。下面的分阶段记录保留原失败与当时证据边界，不作为当前状态的单一摘要。

## 当前工程边界

- `services/creation/` 是新的创作文档、身份、会话、资产和运行管理层；使用独立 SQLite 数据库，不修改旧 48900 服务的数据。
- 当前入口仍是 `services/preview/server.mjs` 的 48910 工作台。`WORLD_ATELIER_CREATION_DATA` 可指定独立数据目录；默认位于预览数据目录的 `creation/`。
- 原演示主干仍为 `creation-flat-1`：场景与预制件都是包含多个对象的独立资源，Y 向上、米、XYZ 欧拉角、三轴缩放 0.1–5。主工程已接入 `creation-hierarchy-2` 的独立根节点、局部四元数变换、固定预制件实例和覆盖；写入由 `WORLD_ATELIER_ENABLE_HIERARCHY=1` 显式开启，当前演示主干没有自动迁移。新流程的浏览器验收尚未完成。
- 原有六类模型是本工程自制的 GLB 初始内容；模板不提供三个验收任务的行为脚本。新游戏可以使用星港模板或空白场景。

## 已接的协议

HTTP 前缀 `/creation-api`。除注册、登录、health 外均使用 Bearer 登录令牌；写请求需匹配当前工作台 Origin。私人会话不沿用七天登录记录的生命周期。

| 接口 | 作用 |
| --- | --- |
| `POST /auth/register`、`POST /auth/login` | 独立开发者身份 |
| `GET /bootstrap`、`POST /projects` | 有权限的游戏 / 分支入口；创建游戏 |
| `POST /projects/:p/invites`、`POST /invites/join` | 有效期邀请；所有者分配 editor / viewer |
| `PATCH /projects/:p/members/:user` | 降权或撤销；身份存在性先于写入 |
| `GET /projects/:p/branches/:b` | 规范 manifest 与不可变源 head |
| `POST .../branches` | 从固定 head 分出独立分支 |
| `POST .../:b/transactions` | 原子资源 / 对象操作，服务器派生 actor |
| `POST .../:b/merge-preview`、`POST .../:b/merge` | 固定源、目标、base；逐项冲突选择与原子合并 |
| `POST .../assets` | 真实 GLB / GDScript 上传，哈希资产与项目授权 |
| `GET .../:b/runtime-scene` | 为当前授权客户端签发只读资产能力地址 |
| `GET/POST .../:b/sessions` | 每个分支 / 开发者的长期多会话 |
| `GET/PATCH /sessions/:s` | 消息、实际 runs、草稿、模型、显式共享 |
| `POST /sessions/:s/attachments`、`inspection-attachments` | 固定对象／空间锚点、源稿／所见姿态、坐标约定、父链和相机上下文，见 [批注上下文](ANNOTATION-CONTEXT.md) |
| `POST /sessions/:s/turns`、`interrupt`、`reconcile` | 真实 Codex 执行、中断与不重跑的恢复核对 |
| `POST /sessions/:s/requests/:key` | 会话所有者回复真实审批或输入请求 |
| `POST .../:b/validate`、`publish` | 隔离 Godot 验证与实际权威应用；返回真实验证与应用回执 |

事务中每个对象用 opaque `expected_version` 比较。不同对象允许基于仍为祖先的旧 head 并行提交；同一对象以整组 TRS 冲突。内容改回原值也生成新版本，避免 ABA。资源版本、head、文档序列和幂等 receipt 在同一个同步 SQLite 事务写入；WebSocket 在 commit 后广播。撤销使用服务器返回的带版本前提 inverse。

`WS /ws/creation` 首包认证，其后按 project / branch / resource + generation 订阅。generation 在 unsubscribe 后仍保留高水位。baseline 与订阅在同一个事件循环边界建立；committed 返回完整规范 manifest。presence 中身份来自认证，相机位置来自各自真实客户端。临时拖动只有短租约，不写文档；断线、超时或撤权清理预览。

资产能力仅用于读取指定项目内的 hash 资产，不赋予文档写权。每次私有资产下载复查项目成员资格，撤权后旧能力也失效。既有模型预览的历史全局 uploads 路径不是新的私有项目资产库。

## Codex 与 Godot

Codex 使用本机已登录的 `codex app-server --stdio`。它运行在按项目、分支、开发者、会话划分的目录；中央服务记录真实 thread、turn、client message ID、事件和工具结果。动态工具提供 `world_read`、`world_apply`、`asset_publish`、`world_validate`、`world_publish`；普通命令、文件编辑和 Blender 执行保持可用。凭据不复制到创作工程。详情见 [执行器接入](CODEX-INTEGRATION.md)。

传输断开或回执未知保持 uncertain，禁止重复 turn/start。恢复比对持久化的真实 userMessage.clientId 与 turn ID。取消先使 run 写租约失效，再发真实 interrupt。官方 interrupt 不会自动停止后台终端，必须按本轮真实 command item 精确核对并终止遗留命令；清理尚未确认时禁止新轮，迟到命令重新进入清理状态。Agent 文本结束不等于目标玩法已验证，目标保留 ready_for_review。

Godot 使用一份权威模拟和多个呈现客户端。Node 通过有认证头的本机 `/ws/world-worker` 控制 headless Godot；角色输入需匹配 world、epoch、scene_revision。权威 60 Hz 物理、10 Hz 快照。source head、已应用 revision、world sequence 是不同状态。

个人检查先发送零输入，等待真实 `last_input_seq` 确认，再冻结自己的可漫游呈现。后台快照继续收，其他玩家继续运行。检查附件明确区分服务器核对过的世界边界和客户端实际呈现的观察变换，不能把后者写回权威物理状态。

候选由单独 Godot 进程真实下载 / 校验资产、构造碰撞、恢复检查点、执行多帧和声明生命周期。要求进程退出 0、报告成功且无引擎脚本错误。应用还要等待实际权威 ACK；GPU 效果和玩法正确另验。任意 GDScript 并不是安全沙箱，也没有通用安全热更新保证；无限循环和延迟故障仍需 watchdog 与明确失败 / 恢复状态。新渲染版本与原生扩展的客户端迁移尚不能由这套行为 API 自动解决。客户端按 manifest 固定到不可变 `/preview-builds/<build_id>/` 目录，每次下载核对哈希；加入时核对 build、world、epoch、source 与 state baseline。核心运行时更新目前要求刷新后重新加入，不能宣称自动无缝迁移。

## 新证据

- 独立新后端：`.local/creation-verification/backend/2026-09-07T06-24-01-554Z-bd915c84/report.json`，20 个实际 HTTP / WS 阶段通过。含不同对象并发、同对象冲突、逆事务、重复回执、generation、私有会话 / 附件、资产授权、优雅重启和 SIGKILL 后恢复。所有测试使用独立 48921 和临时数据库，Agent 禁用，没有运行 Godot 或浏览器。
- Codex 适配器独立真实三轮工具 / 命令 / 文件编辑、重启续聊、中断与 client ID 对账证据见 `docs/CODEX-INTEGRATION.md`；它们不等于工作台端到端验证。
- 独立合并与缩放：`.local/creation-verification/merge/2026-09-07T06-31-50-056Z-c64987a2/report.json`，10 个实际 HTTP / WS 阶段通过。
- 中央集成真实 Codex：`.local/creation-verification/agent/2026-09-07T06-45-20-568Z-86b37f93/report.json`，4/5。已证明读世界、实际改文件与执行命令、工具提交、服务重启后同 thread 续聊、消息幂等与私人流。取消阶段未证明后台进程停止，保留失败证据。修复后的独立真实取消窄测见下一项。
- 精准取消修复后的真实窄测：`.local/creation-verification/agent-cancel/2026-09-07T07-22-25-551Z-872812ba/report.json`，4/4。实际运行中的 OS PID 为 Ss，turn interrupted 后 94 ms 又收到迟到 command started；官方精确 terminate 返回 true，真实 command completed 为 failed/-1。进程随后消失，AppServer 持续运行超过原命令自然结束期限，心跳不增且无结束标志；清理前新轮 409，重启核对恢复 verified，原目标和 terminate 均未重复。
- 中央 Godot 世界首轮：`.local/creation-verification/world/2026-09-07T07-06-27-871Z-cdd59767/report.json`，10/11。真实双用户控制、同 authority PID 内容更新与状态保留、坏编译 / 嵌套 VM 错误 / 哈希损坏拒绝、检查点恢复通过；切订阅后旧世界输入仍被接受实证失败。
- 控制围栏与恢复修复后的独立窄测：`.local/creation-verification/world/2026-09-07T07-14-24-019Z-013f76a1/report.json`，6/6。实际同身份并发 join 只准一个、切分支 / 退订撤销旧输入与推送，真实 shutdown request → Godot checkpoint ACK → SQLite → 重启 validator state/hash 一致。该窄测不冒充重新跑过全部旧阶段。
- 工作台浏览器已用主创和协作者 B 两个受控账号进入同一场景，加载真实 GLB 与固定构建客户端，并创建独立持久会话；空间锚点通过实际 Y 轴操作柄拖动后精确调整到 `[0, 1.25, 0]` 并固定附件。三个内容均由工作台实际 Codex 创作并应用，最终内容为 `src-efba4a3a0ff7be1268079874a4dbcf996407cfa0966ceaa1a542311ca5012c60`。Blender 5.2.1 LTS 实际保留原星门并导出地球仪 GLB，48 meshes / 50 nodes / 9 materials，主场景与对象预览已真实显示该资产。首次珊瑚执行在浏览器权限请求处被中断，已通过真实清理核对并在同 thread 续聊；不把中断当完整完成。
- 原样实际内容触发首轮为 2/4：两个静止圈外玩家加入和重复应用时误触。原因由真实物理对照确认：玩家先加入物理空间才设置恢复位置。仅把位置设置提前，不屏蔽正常事件。固定新构建 `94921f68a04ef84c8ab3d5e32663ccc49058cab60757e92b3d3f866addd77ea6` 的独立复验 `.local/creation-verification/content-trigger/2026-09-07T08-04-15-790Z-18171dbb/report.json` 为 8/8：圈外加入及两次应用保持计数 0，入圈变 1，圈内应用仍 1，实际退出再入变 2；真实移动并按 E 使珊瑚计数 0→1，应用后保留；实际 Godot GLTF 识别星门 48 meshes，应用文档保持原 TRS。测试原样导入实际 7 资源、9 资产；没有修改业务脚本。中间一轮 6/8 的测试导航撞台沿也保留，最终仅调整真实输入路线。
- 新版工作台重连后，实际显示完整的礼花 1909 条和 Blender 2380 条执行事件；取消清理未核对时发送被拒，点击“核对运行”后才允许续聊。停服时信号与清理顺序导致的恢复缺陷已修复，独立真实恢复 5/5 见 [恢复补丁](WORLD-RECOVERY-PATCH.md)。最终 `680cd7a5…` 双 Web 实测：B 实际移动踩踏，A 同步看到纸屑和星光；退出再入可重复。A 个人检查固定 tick 246106 / sequence 35164，B 继续移动，双方最新世界推进到 tick 252168 / sequence 36030；A 返回实时后追上最新世界。B 走到约 `[3.51, -0.06, -0.49]`，两次实际 E 输入使珊瑚 resonance_count 0→2，A 画面同步出现共鸣光圈及文字。浏览器截图和 DOM 对照位于 `.local/creation-verification/browser/`；真实计数中保留此前误触的历史基数，不将其重置掩盖缺陷。

已知未覆盖：完整父子层级、嵌套预制件覆盖与升级冲突、原生编辑器双向往返、外部离线客户端、任意引擎 / 原生代码迁移、互联网多租户隔离部署和长期大规模数据分页。当前执行环境是可信本机开发者使用的 Codex / Godot / Blender，不能据此宣称任意外部代码已经安全隔离。

短视口回归：Play 控制面板限制为视口内高度并可滚动，避免前进按钮被顶部工具栏挡住。维护标签固定 14 CSS 像素、最长 240 像素，离屏和过近时隐藏；主视口近景已实测，独立投影测试 29/29、Play 控件探针 23/23。

恢复接触回归（2026-09-07）：680 双 Web 最后一次真实停服/恢复保留了位置与珊瑚计数，但礼花从 9→10，失败留在 `.local/creation-verification/browser/before-final-restart.json` 与 `INDEPENDENT-REVIEW.md`。平台接触成员账本现与玩家在线连接分开，恢复状态不再意味着新进入；业务脚本原样保留。固定 ce87792bf7e822cb0d597917a9626b1d5907d713d580e8c10c85e2d09f318bb9 独立实际 6/6，报告 `.local/creation-verification/content-recovery/2026-09-07T09-24-44-864Z-9a235f5e/report.json`；旧 680 无账本检查点→ce877 真实迁移 4/4，报告 `.local/creation-verification/content-legacy-recovery/2026-09-07T09-25-18-038Z-21d32713/report.json`。重启/同进程离线重连不新增，真实退出再入新增；未 join 的恢复角色 online=false。两批均无浏览器/GPU，不能替代 A/B 合并后的最终浏览器回归。

ce877 的实际双 Web 恢复已补验：主创与协作者 B 均进入原世界 epoch 5，位置保留，礼花 10→10、珊瑚 2→2；源稿仍为 `src-efba4a3a0ff…`。实际 DOM、前后权威状态与已查看画面分别在 `browser/contact-upgrade-ui.json`、`browser/before-contact-upgrade.json`、`browser/after-contact-upgrade.json`、`browser/contact-upgrade-owner.png`。这次只证明已执行的恢复路径，不能改写此前 9→10 的失败。

2026-09-07 A/B 集成进展：A Godot 0.3.0 的 22 个产品文件与 4 个作者测试文件按 SHA 清单合入，root 实际构建为 `1dde489c662e22971a8cf586aa7c278f92451d13c21944ed8d91f6666bbd0b25`。统一 capabilities 同时进入源清单、PCK 和导出文件；完整矩阵与显式实例挂载保留，不能表示的局部斜切与不支持的基础碰撞变换拒绝候选。作者真实 headless 检查与 root 独立验收分开，详见 `.local/creation-verification/hierarchy-runtime-import.json` 与构建日志 `hierarchy-runtime-build.log`。独立服务专项及 Case 02/05 尚未完成，未将此构建宣布为演示世界已升级。

B 的目标验收存储、固定运行归属、同目标续修、服务端世界快照采集和私有原图存储已接入主服务，抽屉中的目标面板已合入。运行结束、技术验证、世界应用、体验验收分别显示；同对象多个目标分别保留。B 11 项加 A 12 项纯/模拟边界检查通过，记录 `.local/creation-verification/goal-workspace-root-tests.log`；这不是 Case 13 的真实 Agent、浏览器或证据采集验收。备份工具已具备固定数据库、资产、验收证据与运行包闭包校验，实际项目备份/恢复验证仍待本批真实证据产生后执行。
