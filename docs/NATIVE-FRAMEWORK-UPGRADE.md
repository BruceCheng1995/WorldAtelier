# 原生 Godot 源稿框架升级

2026-09-09。用户授权的原生源稿框架升级已完成。本文件记录实施契约、当前证据与能力边界。唯一产品入口仍为 48910 原工作台。

## 目标契约

- 完整原生 Godot 工程是中央管理的游戏源稿。场景、预制件引用、实例覆盖保存在真实 `.tscn`，资源和脚本保留原生表示。源文件内容及语义元数据进入不可变版本。
- `creation-native-1` 使用 `source_files` 映射路径到不可变字节哈希；`resources` 仅是引擎生成、可从同版本文件重建的查询索引，不是另一份可独立编辑的场景权威。
- 编辑分支内默认跟随预制件定义，逐属性保留原生实例覆盖。整个工程快照负责历史复现、Play、导出和 Agent 固定工程；不会自动改写已有构建或在线世界。
- 网页、Agent 与原生/离线工程提交经过同一中央事务入口。保留权限、运行租约、幂等回执、稳定对象身份、并发冲突、撤销及分支隔离。
- 原生文件往返保留网页不认识的节点、资源、脚本、动画和连接。不能以重新生成受限 JSON 模型的方式丢掉它们。
- 参数描述映射到真实属性；实例值、默认值、覆盖状态由引擎解释。复杂资源的共享与实例独有遵循 Godot 规则。
- 编辑预览、统一 GameRuntime + standalone 启动与个人检查复用相同游戏场景；各窗口独立 Play。显式共享世界与存档保持独立权威。
- 既有源版本、长期会话、附件、资产、存储域、构建及验证历史完整保留；迁移写新提交并记录映射，不重写历史。迁移中的真实功能问题必须解决后再启用正式入口。
- 保留 `/goal` 与 Agent 自选测试；不增加产品自动验收面板或自动测试审批门禁。

## 实施与独立验证

| 工作 | 负责人 | 当前状态 | 完成证据要求 |
| --- | --- | --- | --- |
| 原服务定位及未提交源码保护 | 主集成 | 已完成 | 48910 PID 51497 → services/preview/server.mjs → apps/creation-workspace/index.html；源码备份 `.local/native-framework/initial-source.zip` 与 411 文件哈希清单 |
| 原生场景引擎适配器 | 主集成 + 独立测试 | 核心已验证 | 真实保存/重载、覆盖/恢复、未知资源保留；GLB/完整矩阵/剪切/改名 26 项独立检查通过 |
| 不可变源文件、中央事务、迁移 | 主集成 + 独立测试 | 正式迁移已完成 | 五分支原生提交；完整保留 73 旧源版本、19 会话及 2446 既有非分支记录 |
| 原生源稿与网页/语义编辑接入 | 主集成 + 独立测试 | 35 项原工作台交互已通过 | 实际 UI 文档/实例/覆盖/重置、GLB、锚点、双用户并发及查看者只读 |
| 统一原生场景运行与工程往返 | 主集成 + 独立测试 | 原生、独立及嵌入 Web 已验证 | 两窗口实际原生运行、暂停/恢复/重启、同一固定构建；真实编辑队列的导出与临时缓存清理通过 |
| Agent 工具与既有游戏迁移 | 主集成 + 独立测试 | 真实 Agent 17 项通过；正式迁移已完成 | 两个真实回合在同一会话读/改/提交/重读；5 游戏 28 个当前及必要兼容资源、31 个历史场景归档 |
| 独立验收与正式服务复验 | native_independent_verification + 主集成 | 已完成 | 35 项核心 UI、25 项显式发行 UI、11 项玩家占位复验、正式快照六场景实际运行及 48910 服务/源身份 |

## 引擎接口

候选工程由中央服务物化到隔离目录，适配器只修改候选。协议 `wa-native-scene-1`；使用 Godot 编辑器构建的 headless 脚本入口。请求包含 `scene_path`、`inspect/apply/create_scene` 及结构化操作；响应包含原生节点索引、属性及继承来源、稳定实例路径、变换、依赖和文件变更。

场景目录与语义描述位于 `.atelier/catalog.json`。节点使用 `metadata/wa_node_id` 保存定义身份，实例挂载使用 `metadata/wa_instance_id`；实际作用域还包括项目、分支、资源和完整实例链。名称、NodePath、临时 Node instance ID 不作为跨版本稳定身份。

## 首轮迁移完成时的范围

正式五个分支已完成迁移，48910 原服务受控重启与 HTTP/源目录复验通过。正式精确快照六场景实际运行、25 项显式发行 UI 和最后 11 项玩家占位复验均已通过。

首轮迁移时尚未实现原生共享权威运行，Control 布局也仅支持只读；本轮补齐的实现见下文“原生共享运行与 Control 补齐”。实际平台出包证据覆盖 Web，未配置的签名平台不在已验证范围。六个正式场景的运行检查覆盖启动与 tick，不等于完整玩法或视觉验收。

## 新证据索引（2026-09-09）

- 早期正式数据只读备份：`.local/native-framework/pre-native-backup/`，2433 文件、73 源版本、9 运行客户端；该固定备份用于迁移演练。最终迁移前已另行复查活动会话与源版本，并生成下述维护备份。
- 真实 5 游戏迁移：`.local/native-framework/workers/real-migration/REPORT.md` 和 `font-closure/report.json`。25 资源（6 场景/19 预制件），6 场景都实际推进 tick 1→240、无脚本/运行错误；40 对象、108 行为参数、33 模型引用、28 资产和25 属性绑定共294项一致。此证据没有覆盖输入、视觉、胜负或重开。
- 原生运行：`tests/creation/native-canonical-project.test.mjs` 保留原文件并验证真实 GameRuntime/原生实例、脚本与暂停恢复。独立 Web 完整队列报告：`.local/creation-verification/native-framework-independent/canonical-web/case-ZCbSeg/report.json`，20 项运行断言及双窗口独立/刷新初始值通过。
- 主工程原生编辑队列：`tests/creation/native-editor-web.test.mjs`；`.local/creation-verification/native-framework/editor-web-pF9cQx/report.json` 与 `native-editor.png`。真实授权 API、固定全场景、受限导出、Chrome 显示两个 Mesh 后切换独立预制件复用同一构建，作者 `_ready` 未运行，源 head 不变。这是浏览器桥接检查，不代替完整工作台交互。
- 原生编辑操作独立报告：`.local/creation-verification/native-framework-independent/editor-transactions/case-n4NPbC/report.json`，26 项，实际 GLB 引用与材质、权限/重复 ID、完整世界矩阵/剪切/撤销、迁移名称一致性。
- 原生协作与附件：`.local/native-framework/workers/collaboration-native/evidence/report.json`，13 项真实 Godot/SQLite/WebSocket 检查；包括嵌套完整地址、双用户选择/拖动、陈旧版本拒绝及附件历史字节。冻结观察解析只做了 fixture，不作为共享世界实际暂停 ACK 的证据。
- 普通工程导入与启动设置往返：`tests/creation/native-catalog.test.mjs` 和 `native-project-settings.test.mjs`。自动发现未摆放场景、原生主场景变更、元数据重建和作者工程设置保留通过。

导出执行使用固定 Godot 工具链及模板，macOS 的完整 `.app` 哈希清单参与构建身份。私有副本启用 Godot self-contained 目录，避免将系统临时目录开放给作者工具脚本。签名平台在受限签名环境未配置时明确失败；没有完成平台出包就不称该平台已验证。

- 原工作台完整 UI：`.local/creation-verification/native-framework-independent/workspace-ui/case-0MxqUZ/report.json`，35 项。真实注册、独立场景与预制件编辑器、自动导出属性、覆盖/还原/定义跟随、实际 GLB、完整锚点附件、协作并发及两窗口独立运行。发现的邀请后分支目录不更新已修复并用第三个实际账号复验；查看者诊断恢复的 403 已修复，43 项权限及通知回归通过。
- 真实 Agent 往返：`.local/creation-verification/native-framework-independent/agent-roundtrip/case-v7A6Ca/report.json`，17 项。同一真实 Codex 会话两个回合经 `workspace_prepare`、实际工作副本修改、`submit_native_workspace` 提交和重读，未知文件保留，作者工程不泄漏生成的启动配置。
- 主最新编辑 Web 队列：`.local/creation-verification/native-framework/editor-web-kChIu5/report.json`，44.5 秒。真实原生静态编辑导出、两个实例→独立预制件复用同一构建、源 head 不变；完成后私有 Godot 引擎副本与导入缓存已删除，固定工程、回执与可用 Web 文件保留。
- 批量索引：`.local/native-framework/workers/batch-inspect/DELIVERY.md` 和 `regression/report.json`。16 项批处理与隔离检查，18 项主现有回归及 7 项知识保留检查通过；普通四场景读取 7.42 秒降到 2.15 秒。工具脚本、静态状态、自定义 Resource 或原生扩展退回整批逐场景独立进程。
- 备份保留：`.local/native-framework/workers/preview-retention/INTEGRATION.md`，71 项及 372 个实际还原文件检查。原生预览分别保留作者源、派生显示工程、固定引擎源码与登记回执；不将导入缓存或未知额外文件伪称为已验证产物。
- 迁移前清理：`.local/native-framework/cleanup-reconcile/report.json`。原执行器重新读取旧中断回合与全部终端，确认 38 条命令已结束、没有残留终端，分支源版本未改变。之后新建 `.local/native-framework/pre-native-maintenance-backup/`，2433 文件、73 源版本、19 会话和 9 运行客户端。

## 原生共享运行与 Control 补齐

2026-09-09 后续实现使用独立原生共享运行端。`creation-native-1` 从真实固定工程装配服务器权威和 Web 显示端；不经过旧 JSON 模拟器。普通 Play 继续每窗口独立运行，共享世界从原工作台的明确入口发布和加入。固定 Web 构建、实际权威基线、输入控制权和实际关卡代次必须一致。

兼容参数更新以短暂检查点暂停和原生属性事务保留同一权威进程；脚本或结构变化使用候选进程恢复声明状态，通过后原子提交世界版本、应用回执、幂等请求和转移记录。旧场景和运行状态不会因为源稿保存而自动改版。个人检查先确认该玩家停止输入，再冻结当前浏览器画面。

Control 现在使用真实引擎布局 API 与 `.tscn` 保存，支持 Inspector 参数、锚点预设、拖动、八边角 resize、原生覆盖/reset、文件字节撤销和版本冲突保护。Container 管理的几何保留只读测量，最小尺寸、尺寸标志和扩展比例可编辑。

具体契约与引擎证据见 [原生共享世界](NATIVE-SHARED-WORLDS.md)、[Control 布局](NATIVE-CONTROL-LAYOUT.md)。本轮原工作台集成和正式服务复验见 [原生框架补齐验证](NATIVE-COMPLETION-VERIFICATION.md)；下述原生迁移证据仍是此前任务的历史事实，不替代本轮验收。

旧 flat/H2 在线房间、检查点、发行和会话继续保留。原生房间使用独立的中央记录键，既有房间仍由旧固定程序恢复；旧 `SceneLoader` 对原生索引的拒绝继续有效。

## 正式迁移与受控重启

- `.local/native-framework/formal-migration-evidence/report.json`：5 个分支各新增一个原生源提交，原 73 源版本、19 会话及 2446 个既有非分支记录原字节保留，既有事件没有改写。迁移前原执行器清理复核和完整备份已完成。
- `.local/native-framework/post-native-backup/`：正式迁移后完整备份通过，2633 文件、78 源版本、9 运行客户端；还原到 `formal-validation-copy/` 用于精确正式源身份的运行检查。演练和正式首次保存的 Godot `unique_id` 可不同，因此不将演练源哈希等同于正式源哈希。
- `.local/native-framework/formal-service-verification.json`：48910 已恢复，原生健康接口与全部五个源 head 通过；6 个场景、22 个预制件、19 个会话；原 HTML 及 5 个模块的 HTTP 字节与工作区哈希相同。再次 `npm start` 复用同一服务。此记录是服务/源身份复验，不冒充该端口的已登录用户交互证明。
- 显式原生试玩发行：`services/creation/native-game-releases.mjs` 和原工作台出包记录的“发布试玩版本”。主发布/构建权限 31 项及新页编排 15 项通过；构建完成不公开，玩家访问固定到确切 build，未发布默认入口变更或分支重置不替换既有发行。
- 原生游戏验证路径：真实 A→B 换场景接受 namespaced GameRuntime 与作者 PackedScene；实际运行故意错报场景 ID 时中央拒绝。旧 4 项、新原生 2 项通过。通知按该固定验证身份恢复，不要求不存在的共享运行 build ID。

- 正式精确快照运行：`.local/native-framework/workers/final-native-validation/FORMAL-REPORT.md`。5 个 head/source_identity 与正式提交一致，6/6 作者场景实际通过统一 GameRuntime 启动，各 120 tick，合计 720；28 公开资源、31 归档场景、200 唯一源 blob 与迁移地址完整。该次只验证启动和 tick，不包含输入、场景切换或完整玩法视觉验收。
- 最终原工作台发行 UI：`.local/creation-verification/native-framework-independent/final-publication/case-eWi3Of/report.json`，25/25 通过。查看者与公开玩家的嵌入及新页面使用同一真实原生构建；完成构建仍不能公开，原 UI 显式发布后开放；未发布 damage=91 或默认入口换为 2D 不改变玩家旧 3D 场景及 24/15 参数；移除成员与关闭公共试玩后重新访问/旧 cookie 均被拒绝。私有引擎副本和缓存清理完成，固定工程与 Web 保留。后补的分支 reset 非祖先访问规则由主权限测试覆盖，不计为该轮真实浏览器证据。
- 公开玩家占位复验：上述目录下 `public-placeholder/report.json`，11/11 通过。进入、Play、Stop 全程没有私有预览或语义接口请求，原权限错误提示已消除；Play 复用同一已发布构建并实际运行原生脚本，Stop 返回可见占位提示。保留一条静默的源稿诊断恢复请求被权限守卫拒绝的非阻断记录，没有扩大公开玩家源稿权限。浏览器与独立 48921 服务已关闭；正式 48910 仍运行，最新 `workspace.js` HTTP 字节与独立复验及主工作区一致。
