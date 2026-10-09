# 语义编辑器集成验证

2026-09-08。主集成者在原工作台实施；独立测试角色分别复核原生执行器协议与真实 canonical Godot 运行。交付入口为 `http://127.0.0.1:48910/creation-workspace.html`。

## 已验证的功能

| 项目 | 本次实际证据 |
| --- | --- |
| 对象引用 | 48921 隔离工作台中多选两座信标，`@` 首项包含完整选择组，生成两份固定对象附件。 |
| 预制件引用 | `@@能源` 找到未摆放、无模型的能源结算系统，生成整个预制件附件；全部 7 个预制件可浏览，系统可独立打开。 |
| 共享知识 | `$$能源` 在发送前加入“星港能源规则”和系统设计的固定知识附件；知识入口可搜索并读全文。 |
| 实例调节 | 浏览器原生输入将单座信标从 2 改为 7，另一实例保持 2；服务器读回与运行隔离验证通过。 |
| 原生 Plan | 浏览器发出一次实际 `/plan`，Codex 读取附件后返回完整计划；没有源写入。最终原生 `plan` 类型正文正常显示。 |
| 原生 Goal | 真实 Codex 创建、激活并完成目标，实际执行语义工具；重启后恢复同一目标，不重复提交或重放消息。 |
| 模式持久化 | 选择模式、退出模式和刷新恢复均经过真实工作台验证；模式设置写入服务端会话。 |
| 原项目兼容 | 48910 原“植物大战僵尸2d”页面刷新后显示功能描述、可调属性与 Agent 入口；旧属性为空时明确提示。对象预览、协作页签与空间编辑入口保留。 |

浏览器操作通过 CUA 实际页面完成。DOM `fill` 曾仅改变数值显示而未触发原生 change，未被计为保存成功；随后使用原生键盘编辑并独立读回固定源才继续运行验证。

## 同一真实 Agent 到实际游戏的完整链条

隔离游戏 `game-5e4367a7-09d0-45e4-8ae7-a6a42e0c9b65`，会话 `session-a72f3c2f-1a83-4f0d-b7d2-a339d0e35238`。

1. 独立测试者通过版本保护的事务移除已有参数声明，保留行为实现和实际值 2。
2. 真实 `gpt-6-astra` Goal 读取 energy 脚本，执行 `semantic_read → semantic_apply → semantic_read`，公开“每秒能量”：整数、0–20、步长 1、真实绑定 `energy-system / energy / rate`。只有声明与资源版本改变。
3. 主集成者在独立系统面板用原生键盘把当前值改为 11；服务端固定源为 `src-00bd25286db2ca4888bbdeaf2d51c1dd9d3744eff056d44c9a901e7a1fc85901`。
4. 独立测试者分别登记 Agent 原交付源和 UI 新源的 canonical 工程，使用相同原行为脚本、`GameRuntime` Autoload 和 `standalone.tscn` 运行。观察器只读取参数与状态。

| 固定输入 | 实际 rate | 实际 tick | 能量增量 |
| --- | ---: | ---: | ---: |
| Agent 公开后的原交付源 | 2 | 120 | 4 |
| UI 调值后的新源 | 11 | 120 | 22 |

两版脚本 SHA 完全相同，增量比为 5.5；原固定工程哈希保持，测试者没有代写源或伪造运行回执。该结果证明绑定参数确实影响实际行为，不把 headless 运行说成完整 Web 玩法验证。

证据目录（本机 `.local`，不提交 Git）：

- `.local/semantic-authoring/verification/agent-exposed-property/`：真实目标、语义工具回执、前后完整源。
- `.local/semantic-authoring/verification/agent-ui-canonical/run-Nw2Gnv/`：两版固定工程、运行命令、观察结果与 `report.json`。
- `.local/semantic-authoring/verification/live-evidence/run-RACHPy/`：真实 Plan／Goal、RPC、原生目标恢复与 `resume-postfix.json`。
- `.local/semantic-authoring/verification/canonical-evidence/run-cSEMW5/`：独立双实例 2/2 → 7/2 行为验证。
- `.local/creation-verification/semantic-runtime/native-6p2r66/`：主根四阶段真实运行，覆盖实例调整、无模型系统、定义改值与显式实例升级。

## 回归与范围

- 语义数据 16 项：真实 SQLite、权限、版本保护、不可变附件、旧文档、嵌套实例、恢复默认与合并；实际动态工具参数修改只定位对应实例，回执重放不扩大目标。
- 原生模式 19 项：真实 CodexAgent／CreationAgentRuns／SQLite，外部 stdio 明确替换为测试传输；覆盖 Plan 写入门禁、Goal 多轮调度及清理、过期事件和历史消息恢复。
- 前端相关回归累计 71 项：命令解析、中文输入、选择组、发送竞态、模式持久化、直接场景对象附件、已发送引用类型、初始重置值文案与系统问题标记。
- 另有真实运行四阶段、HTTP 会话／知识持久化及环境与取消权限回归。协议测试不替代真实执行器和浏览器证据。

真实 Goal 本次首轮完成；自动连续多轮仅有协议回归，未声称已用真实付费执行器完成多轮压力测试。没有进行共享世界发布或全游戏美术／玩法验收。

最后的语义数据／原生模式／语义前端与宿主组合为 67/67。浏览器复验修复了无模型系统卡片出现问题标记时缺少图片标题容器导致的异常；修复后同一个有问题的系统可正常独立打开，已有问题仍如实显示。

## 自动评审的已知边界

原自动检查策略把任意预制件变化扩大到全项目技术检查，再要求独立 reviewer 对每个资源给出覆盖结论。后续 UI 调值还会把旧 Goal 文本带到新源进行重验。

本次新源的 8 项 canonical 技术检查全部通过；自动 reviewer 也实际确认 11 配置运行 120 tick 得到 22 点。但它仍按旧 Goal 的“实际值保持 2”判定目标不符，且缺少历史差分与浏览器输入上下文，最终 job 为 `blocked`。原始结果在 `agent-ui-canonical/run-Nw2Gnv/automatic-final-window.json` 保留，没有代写通过。

这与本次独立完成的输入、保存和实际运行证据分开记录。用户已将 Agent 收敛和评审策略留到后续，本轮没有扩展该策略。

## 原服务交付

原端口 48910 受控重启前保存了 SQLite 备份；确认当时无活动开发／验证任务。五个原分支源 head 前后完全一致。新静态模块的 HTTP 字节与主根源文件逐一相符；健康接口确认 `semantic_authoring` 与 Agent 服务可用。

备份和比对记录：`.local/semantic-authoring/pre-deploy-1788854934713/{creation.sqlite,before.json,after.json}`。48921 使用独立目录和账号，未在原游戏内写测试资源。

最后目标精度修正加载前再次备份为 `before-final-restart.sqlite`。隔离浏览器和 48921 测试服务已关闭；原工作台服务继续运行。

## 2026-09-08 对象面板紧凑布局与独立新会话

对象面板的修改功能、控制属性需求置顶；可调属性采用紧凑单行类型控件，描述和范围通过悬停或键盘聚焦查看，空间设置聚合到同一折叠模块，功能描述在底部。两个入口强制创建新私人会话，不继承旧会话的草稿、附件或 Goal 执行。

本次78项单元/真实SQLite回归通过；独立真实Chrome在原工作台代码和隔离服务上6项通过，覆盖布局/控件宽度/32px属性行、hover、折叠后源刷新仍保持状态、空间模块唯一、六种属性类型真实保存及两个新会话与旧draft/goal隔离。无页面异常，未自动发送Agent回合。测试结束已清理临时服务、Chrome及数据。

证据：`.local/creation-verification/semantic-inspector/2026-09-08T10-08-57-764Z/report.json` 及同目录截图。正式48910三个前端文件的HTTP字节与当前源码一致；静态更新无需重启。此结果仅证明面板与会话交互，不冒称执行了真实Agent或完整玩法检查。


## 实例检查器与组件导航（2026-09-08）

本轮原工作台改动限定于对象面板、来源预制件导航、图层标识和实例本地名称。以下 10:22 证据为随后顶部双击名称与统一空间参数控件重构前的通过版本；后续联调应使用追加的新报告。85 项单元与数据回归加会话/引用 helper 46 项回归通过。真实 Chrome 使用原服务代码与临时 SQLite 数据：

- Flat 实例 4/4：`.local/creation-verification/prefab-instance/2026-09-08T10-22-56-562Z-flat/report.json`。
- Hierarchy 实例 4/4：`.local/creation-verification/prefab-instance/2026-09-08T10-22-57-778Z-hierarchy/report.json`。
- 普通对象紧凑面板 6/6：`.local/creation-verification/semantic-inspector/2026-09-08T10-22-58-995Z/report.json`。

检查实例只显示已绑定且允许实例调整的参数，功能描述只读、名称可改、自动编号；写入只改变目标实例。跳转后定义显示完整参数与功能入口，返回仍定位改名后的原实例。普通对象的两项常用入口分别创建新会话，旧草稿和 Goal 保留。浏览器无未捕获异常，没有发送真实 Agent turn；临时服务与数据均清理。

正式服务已于本轮受控重启至 PID 78670，端口仍为 48910，健康检查保留 `agent_goals:true`、`automatic_verification:false`、`hierarchy_editing:false`。原地址可正常加载登录页面。Hierarchy 检查证明编辑与持久化，不代表尚未启用的层级游戏运行适配验收。


### 与顶部名称和统一空间参数控件合并后的最终检查

用户另一项面板任务随后要求名称仅在顶部显示并双击修改，坐标/旋转/缩放使用统一参数控件。本轮保留这些新改动，重新检查实例功能边界，未回退共同文件。最终证据：

- Flat 4/4：`.local/creation-verification/prefab-instance/2026-09-08T10-28-41-426Z-flat/report.json`。
- Hierarchy 5/5：`.local/creation-verification/prefab-instance/2026-09-08T10-28-42-625Z-hierarchy/report.json`。

两套均验证顶部双击改名、实例参数保存隔离、只读说明、来源定义与原实例往返，以及实例不显示导入模型/Agent 制作、颜色和固定会话入口。Hierarchy 新增验证：仅挂载根使用实例图标，内部普通节点保留自身类型图标。均 `completed:true`、`page_errors:[]`，临时服务与数据已清理。正式服务后续由面板任务重启至 PID 82259，仍使用唯一入口 48910。
