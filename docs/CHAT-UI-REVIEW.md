# 聊天与场景树界面验证 · 2026-09-07

本轮范围：创作工作台的聊天抽屉、格式化回复、执行过程、输入框、执行权限、用户问答，以及左侧文档选择与对象树。Godot 引擎能力不因本轮界面检查而获得新的验收结论。

## 已实现

- 中性白灰聊天区；会话列表、设置、过程更新及工具调用按需展开，阅读宽度可在 600 / 900 px 间切换。
- Markdown 标题、强调、列表、嵌套列表、引用、表格、行内代码和代码块；回复及代码复制。转义 HTML，限制链接协议。
- 同轮工具事件按 turn/item 合并，默认灰色折叠；摘要显示失败数量。阅读历史保持滚动位置，提供回到最新消息。
- 固定批注的查看、逐项移除、模型和实际支持的 effort 选择；发送/停止状态、Enter/Shift+Enter、IME 合成保护。设置/附件写入完成后才发送，晚响应不能覆盖其他会话。
- 输入框底部提供「默认权限 / Full access」，按会话保存并固定到每轮执行和重试身份。旧会话保持默认权限；共享会话仅所有者可修改与执行。
- Codex 的 request_user_input 直接显示为内联卡片：单选、允许时的其他填写、多个问题、密码字段、未完成时禁用提交；不自动预选或答复。切换会话保留未提交填写。完成后折叠为回答记录，秘密答案在界面与原始日志展示中遮蔽。
- 只有对应当前会话、线程和执行轮次的待回答请求可提交；拒绝空白、缺失问题、过期或重复回答。MCP elicitation 保持既有单独协议。
- 场景树顶部为场景选择器，下方为图层与完整预制件目录；默认隐藏搜索框，按需展开。对象行 28 px，窄屏 32 px；长名截断，完整名称与 ID 可悬停查看。
- 单色 SVG 区分文档、模型、分组、预制件和锚点；层级按真实 parent_key 先序展示，分组可折叠，搜索保留祖先路径。支持键盘导航、独立预制件文档和窄屏面板切换。

## 执行协议

依据 [Codex App Server 官方协议](https://learn.chatgpt.com/docs/app-server) 与本机 `codex-cli 0.147.0` 生成的 schema 验证：

| 会话权限 | thread/start、resume | turn/start | 审批 |
| --- | --- | --- | --- |
| workspace-write | sandbox: workspace-write | sandboxPolicy.type: workspaceWrite | on-request |
| full-access | sandbox: danger-full-access | sandboxPolicy.type: dangerFullAccess | never |

Full access 允许本机会话的文件及网络访问，命令无需审批；中央项目 ACL、世界工具租约、附件范围与不可变历史仍由各自接口检查。权限不会批量改变其他会话。

线程配置启用本机已确认存在的 `features.default_mode_request_user_input`。该开关在当前 CLI 标注为 under development。实际答案通过 `{answers:{questionId:{answers:[string]}}}` 回复原 App Server 请求。`isOther` 控制自定义输入，`isSecret` 使用密码输入；不因超时制造答案。

## 自动化验证

最新完整回归 **84/84 通过**（含父测试）。HTTP 测试使用 48921、临时 SQLite 与明确标注的 Fake executor；adapter 测试使用 Fake transport。独立测试角色另行验证权限/问答边界及实际 hierarchy resolver 的展示顺序，发现的问题已修复。

```sh
node --test --test-concurrency=1 \
  tests/creation/chat-access-input.test.mjs \
  tests/creation/chat-presentation.test.mjs \
  tests/creation/chat-settings.test.mjs \
  tests/creation/scene-tree-presentation.test.mjs \
  tests/creation/session-input.test.mjs \
  tests/creation/elicitation.test.mjs \
  tests/creation/goal-workspace.test.mjs \
  tests/creation/goal-workspace-lifecycle.test.mjs \
  tools/test-codex-agent.mjs
```

本地输出：`.local/creation-verification/chat-ux/test-results.txt`。

## 浏览器与真实执行

隔离服务 48923 使用测试账号、独立状态路径与显式标记的样例。已实际检查模型/effort 保存、批注移除与重新添加、工具多层折叠、代码复制粘贴、输入快捷键、600/900 px 阅读区，以及真实问答卡片。

真实 Codex 检查运行 `run-4b78efe4-d7ac-4548-8f1f-dbb22071cbaa`，线程 `01a07c34-f1f7-7533-9ce3-b3f64244542c`，选择 Full access / GPT-5.6-Luna / low。通过浏览器发送仅提问、不修改文件或世界的检查请求；执行器真实发出两个问题。在浏览器选择暖白并填写「保留入口通行空间。」，切会话后选择和文本仍保留，提交后执行器真实回复「已收到：入口灯光用暖白；保留入口通行空间。」运行状态 completed。此记录与此前仅用于排版的 fixture-run 明确区分。

场景树样例含两场景、六个预制件、三组与 27 个锚点：浏览器读到约 28 px 行高，缩进逐层增加，长名称无水平溢出；分组折叠隐藏子节点，搜索匹配恢复祖先路径，场景切换和预制件独立打开正确。层级样例使用旧 Godot 预览构建，不将它视为层级运行时验收。

通过隔离尺寸检查页的真实 iframe 视口检查 980×650 和 390×600 布局，避免把无效的 viewport override 当成证据。窄屏聊天控件和左侧抽屉可见可操作。修正了原全局样式把单选按钮拉宽、深色原生控件和提交按钮文字对比度问题。

## 主服务状态

启用前重新检查 48910 数据库，已无 starting/running/cancelling/uncertain 创作运行。使用 SQLite backup 保存一致快照：`.local/creation-verification/chat-ux/main-backup-1788790885/creation.sqlite`。

主服务已正常重启，新 PID 62986；`GET /creation-api/health` 实测返回 `chat_settings: true`、`chat_access: true`、`chat_questions: true`、`agent_ready: true`、`worlds_ready: true`。保留主服务原有默认配置与数据路径，未开启其原本关闭的 hierarchy editing 开关。

用户原页面仍有场景编辑上下文，未强制重载；页面下次刷新会读取最新脚本、样式与能力标记。

新增/扩展接口：`DELETE /creation-api/sessions/:sessionId/attachments/:attachmentId`；Session 创建/PATCH 与 turn 输入的 `effort: null|string`、`access_mode: workspace-write|full-access`；原 requests 回复接口增加对应当前执行轮次的严格答案校验。

## 预制件图片卡片补充 · 2026-09-07

预制件目录现为真实 Godot 截图和名称；整张图片可点击或用键盘打开对应独立文档，当前文档显示细边框。长名称截断并保留完整 title，层级预制件的放入/影响操作收在更多菜单中。

截图使用一个按可见区域延迟启动的独立 Godot 视口，以固定源版本加载完整预制件，通过 retained framebuffer 生成 384×288 JPEG；主编辑视口与检查器相机不参与截图。按项目、分支、资源和源版本缓存，版本改变重新生成；失败显示占位且仍可打开，后续目录刷新可重试。退出工作台清理队列/缓存并释放渲染器，在途结果不能恢复旧缓存。

新建隔离 harbor 项目 `game-cad9841d-2b24-4b7a-9411-d3ce49839eef`、源版本 `src-72ce7faedd3636bdc5ca7242786eadf8e6cec2768651476c9b560f05643bcc4f`，在 48923 实际浏览器逐张检查信标、石台、星门、珊瑚树、探索艇、气候观测仪的不同模型截图。六张图均为 ready / 384×288，完成后临时渲染器数量为 0；点击信标图片后选中「导航信标 / 定义」标签和独立资源 pf-beacon。桌面卡片约 228×171，目录无横向溢出；另在真实 390×600 iframe 视口检查图片卡片与侧栏滚动。

独立测试角色新增缩略图专属回归 16/16 通过，覆盖版本/身份隔离、单渲染器与延迟加载、失败重试、清理期间在途结果失效、图片键盘打开与更多菜单 Escape。这些为明确的 Fake DOM/canvas/ACK 测试；真实渲染证据见上述浏览器记录。与现有场景树、聊天展示、目标面板生命周期测试合计 41/41 通过，输出位于 `.local/creation-verification/chat-ux/prefab-regression.txt`。本轮没有新增 Godot 层级运行时验收；与旧运行时不兼容的定义继续明确显示预览不可用。

主服务由并行验收修复任务统一重启（PID 68448）。本任务复核 `/prefab-preview.html` 返回 200 且装载新截图 shell，health 的 agent_ready、worlds_ready、chat_access、chat_questions 均为 true；未主动刷新用户编辑页面。
