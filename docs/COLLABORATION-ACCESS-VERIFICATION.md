# 协作权限验证记录

日期：2026-09-08。范围为游戏级只读/编辑权限、申请与审批、成员和邀请管理、消息中心以及撤权后的服务端和客户端行为。产品流程见 [COLLABORATION-ACCESS.md](COLLABORATION-ACCESS.md)。

## 自动回归

在主工程执行以下命令，46 项测试全部通过（执行回执 `411dd8`；03:18 UTC）：

```sh
WORLD_ATELIER_COLLAB_TEST_PORT=0 node --test \
  tests/creation/collaboration-access.test.mjs \
  tests/creation/collaboration-regressions.test.mjs \
  tests/creation/inbox.test.mjs \
  tests/creation/agent-cancel-revocation.test.mjs \
  tests/creation/lan-platform.test.mjs \
  tools/test-creation-wire-boundaries.mjs
```

| 验证 | 结果与证据边界 |
| --- | --- |
| HTTP / WebSocket / SQLite | 真实隔离服务与数据库；申请幂等、拥有者审批、版本冲突、实际源稿事务、只读写入拒绝、通知收件人、邀请单次/撤销和重启恢复通过 |
| 权限专项回归 | 私有项目移除后旧邀请回执不能读取当前成员；已有编辑者接受只读邀请不会降级且消费邀请；普通申请不清除编辑者拖动占用；降级只清理目标成员 |
| Inbox | 21 项真实 SQLite 用例，验证私人会话正文、项目开发问题与新协作通知的访问范围互不混用 |
| Agent 撤权 | 8 项 fake executor + 真实 SQLite 用例，覆盖延迟启动回执、未知 turn、权限恢复不复活旧租约、准确中断与命令清理；不是本轮付费模型执行证据 |
| 浏览器传输 / LAN 平台 | 断开后不自动重入旧世界、会话订阅边界、当前检查冻结版本、LAN UUID 和哈希回退通过 |

HTTP 最终报告：`.local/creation-verification/collaboration-access/2026-09-08T03-18-06-429Z-12493891/report.json`。HTTP 测试使用临时随机端口，已退出并删除自有临时数据。

旧传输测试的夹具同步了当前 `execution` 字段及新权限、Inbox、恢复编辑预览依赖；原控制停止顺序和不自动重入世界的断言保留。

## 真实浏览器

独立验证角色使用两个具有独立 sessionStorage 登录身份的 Chrome 标签页、48921 隔离服务和数据库。本人在页面注册，拥有者在游戏库通过消息中心打开对应游戏的审批；批准后申请人原场景页面立即解锁编辑，创建真实空间锚点并收到源版本保存回执。拥有者改为只读后，对方原页面立即禁用字段、锚点和新会话入口，已保存的对象和版本保留。

首轮详细证据目录：`.local/creation-verification/collaboration-access/2026-09-08T03-08-35-379Z-9a9c8dc5/`。其中还核对拒绝说明、撤回、邀请码加入、跨游戏 Inbox 导航。测试期间发现并修复了邀请跳转中 `history` 名称遮蔽、申请外部被拒绝后旧等待提示未清除、协作通知使用 Agent 文案，以及无文档订阅时发送 presence 的问题。

首轮 gate 误把已经自动消失的成功 toast 作为必要条件，因此其原始报告保留 `passed:false`，不作为最终通过回执。稳定的游戏 URL、对话框关闭和实际权限回读才是邀请加入成功的判断依据。

**最终浏览器门禁通过**：在最新后端上再次完成双账号注册、申请、游戏库 Inbox 审批、无需刷新实际编辑保存、拥有者降级及同页只读。最终 `node --test tests/creation/collaboration-access.test.mjs` 为 2/2 PASS；报告 `.local/creation-verification/collaboration-access/2026-09-08T03-20-49-006Z-63fb1d38/report.json` 的 `completed:true`、`browser-complete.json` 的 `passed:true`，测试期间源码漂移为空。最终截图为同目录 `owner-approval.png`、`approved-real-edit.png`、`revoked-readonly.png`。首轮拒绝、撤回、邀请跳转等扩展交互的稳定断言复核另存原目录 `browser-evidence-reviewed.json`，没有覆盖原失败报告。

独立服务 PID 39611 / 39612 已退出、临时数据库删除、两张自有测试页关闭，48921 无监听。正式服务和既有游戏未被这些测试修改。

本轮浏览器使用实际 Godot Web 编辑预览；测试服务禁用运行世界与付费 Agent，没有宣称本轮进行了完整多人玩法验证。

## 正式服务

03:19:31 UTC，原正式 launcher 31185 / service 31186 正常退出后，通过 `npm run dev` 启动原 48910 服务，当前服务 PID 39343、launcher 39342、持久化 npm 父进程 39323。更新前已确认无执行中 Agent、自动验证或打包任务，SQLite 备份放在 ignored 的 formal-update 目录。

正式地址：[局域网世界工坊](http://10.222.132.235:48910/creation-workspace.html)。`collaboration_access`、`registration_open`、`public_play`、`agent_ready`、`worlds_ready` 均为 true；服务监听 `0.0.0.0`。5 个权限相关静态文件 HTTP 200，下载内容 SHA-256 与当时本地文件一致；正式 In-app Browser 登录页成功刷新。再次运行 `npm run dev` 正常复用现有服务，没有启动副本。

正式健康与文件校验回执：`.local/creation-verification/collaboration-access/formal-update/report.json`。本轮没有创建生产测试用户、发送真实编辑申请或修改已有成员权限。运行构建核对时为 `48b522a1941f5df260d037d4349ec52b7f077c1688f66e16af1ab9ba39409e05`；另一项 Godot 预览模式任务随后继续开发，其后续构建和独立验证不属于此权限报告的通过声明。

## 顶栏授权提示收拢（2026-09-08）

移除视口权限条和只读浏览重复说明，把提醒集中到顶部「协作」旁的感叹号。独立内存 DOM 夹具使用实际协作模块，覆盖只读、等待、拒绝、拥有者待审批、读取失败、编辑成员、无待办拥有者、跨游戏错误隔离与断线，9/9 通过；核对标题、无障碍名称、角标显示以及点击后选择正确弹窗页签。夹具状态为模拟数据，不是新增真实授权证据，也未完成本轮浏览器视觉检查。报告：`.local/creation-verification/access-header/2026-09-08T03-44-19Z/dom-report.json`。

正式 48910 的 HTML、workspace.js、collaboration-access.js 和 collaboration-access.css 响应均与当前源码字节一致；静态更新无需重启服务器。本次未修改权限后端、正式账号数据或 Godot 运行构建。

## Figma Share 对齐（2026-09-08）

需求与业务边界见 [协作权限设计](COLLABORATION-ACCESS.md#figma-share-需求映射与界面2026-09-08)。原正式界面与 Figma 官方 Share 截图均在本轮直接查看并保存；新界面直接替换原工作台。

1. **分享入口与布局：通过。** 原 760 px 多栏目管理面板改为 520 px 内容自适应弹窗。真实 Chrome 拥有者视角约 520 × 477 px；正式编辑成员视角约 520 × 396 px。主集成检查了 390 × 844 窄屏，主操作完整可用，检查后已恢复默认视口。
2. **邀请和权限申请：通过。** 独立 Chrome 账号实际操作用户名直接邀请、只读申请、拥有者主页审批，以及无需刷新获得编辑权限；真实 Inbox 和权限后端接入。
3. **访问范围与撤权：通过。** 真实 UI 二次确认后改为仅受邀成员；行内降级后二次确认，另一个页面实时转为只读。真实 HTTP / SQLite / WebSocket 检查了未受邀用户失权、已邀请成员保留、版本冲突、幂等回执不重新授权、禁用与归档一致性、重启持久化和通知去重。
4. **复制链接：通过。** 独立 UI 与正式 UI 均观察到“链接已复制”。正式从 localhost 打开的页面生成局域网游戏/分支链接；链接契约检查覆盖 query 清除、目标游戏隔离、当前分支及 LAN 优先。剪贴板 API 缺失、报错或超时提供选中文本回退；本轮未人为禁用浏览器剪贴板权限。

最终命令 `node --test tests/creation/share-access.test.mjs tests/creation/collaboration-regressions.test.mjs`，7/7 通过；最新 API 报告 `.local/share-redesign/2026-09-08T04-14-40-657Z-e2670e8c/report.json`，浏览器报告 `.local/share-redesign/2026-09-08T04-07-06-724Z-e200bdc1/report.json`。浏览器运行期间发生了真实样式修正，旧截图与源漂移记录保留，拥有者已刷新并确认紧凑版；最终 API 复跑源未漂移。不是付费 Agent 或 Godot 玩法验收。

正式服务在核实没有运行中的 Agent、自动检查或构建后受控更新一次（与同期 LAN Web 导出修复合并），新 PID 52786 / launcher 52785，继续监听 `*:48910`。创建 API、真实 Agent/世界服务、LAN 与公共只读配置健康，前端响应和当前源码字节一致。未为分享验证修改正式成员或公开范围；测试账号、临时数据与 48921 已清理。正式只读 UI、链接与静态回读记录：`.local/share-redesign/formal-report.json`。

截图：`.local/share-redesign/01-before.png`、`figma-share-reference.png`、`03-mobile-share.png`、`04-share-final.png` 和 `share-dialog.png`；独立拥有者截图在上述浏览器报告目录的 `owner-compact-share.png`。
