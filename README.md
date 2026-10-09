# 世界工坊 · World Atelier

多人在同一世界里编辑场景、发现全部预制件并独立编辑，通过长期 Agent 会话生成模型与逻辑，在当前网页视口 Play Godot 游戏。个人暂停只固定自己的检查视图，其他玩家继续玩。

**当前可用入口是 [48910 协作工作台](http://127.0.0.1:48910/creation-workspace.html)**，已接中央文档、真实 Codex、Godot Web 及真实模型。最新运行时 0.3.0 / 1dde489c；三个指定内容和双用户操作已实际回归，[当前实现与证据](docs/COLLABORATIVE-CREATION-IMPLEMENTATION.md)。个人检查中直接编辑、原生/离线往返等仍未交付，不能据此称全产品完成。原0.1.3/48900六项示例保留为 [历史证据](docs/VALIDATION-REPORT.md)。

后续开发先读 [创作工作台设计](docs/CREATION-WORKSPACE.md)、[创作协议](docs/CREATION-PROTOCOL.md) 和 [新的验收旅程](docs/CREATION-ACCEPTANCE.md)。[可点击设计稿](docs/design/creation-workspace.html)仅供检查布局和交互，不接入 Godot、多人服务或 Agent 执行。

正式工作台通过 `npm run dev` 默认开放局域网连接和注册，启动器会打印当前网卡的共享地址。注册用户可直接浏览、试玩现有游戏，创作需拥有者邀请授权；私人会话保持隔离。启动配置、临时关闭与单线程 HTTP 兼容边界见 [本机与局域网启动说明](docs/LOCAL-DEVELOPMENT.md)。

```text
apps/
  creation-workspace/     当前协作工作台：场景树、Godot视口、属性、会话抽屉
  desktop-launcher/       历史协议与离线包兼容工具（不是产品入口）
services/
  creation/              当前创作文档、协作、真实Agent、世界与验收记录
  preview/               48910工作台与固定Godot客户端/模型资源服务
  control-plane/         共用存储模块与隔离的历史协议测试代码
  world-orchestrator/     权威进程代次、检查点、休眠、升级与恢复
runtimes/
  model-preview/         当前Godot Web呈现和权威玩法运行时
  godot/                  同一 Godot 工程的客户端、权威端与共享玩法
tools/                    真实导出、外部编辑、备份与游戏验证工具
packages/
  contracts/              各端共用的数据与消息协议
  runtime-sdk/            模块、状态、事件、热更新和同步接口
content/                  示例世界与模块的创作源文件
docs/                     设计、决定与后续验收
research/godot/4.6-stable/ 官方引擎研究资料，源码及压缩包不进入 Git
.local/                   本地验证记录，以及后续服务数据、缓存和测试世界
```

当前实现采用 Node.js、SQLite、原生 Web 界面与 Godot 4.6。每个在线世界由对应发行中的独立 Godot 程序执行权威玩法，中央服务保存确认后的完整状态。源码、可玩发行和在线世界分别记录版本。

客户端切换的验收是版本匹配、状态接续和控制权正确；普通兼容内容仍争取在当前游戏内热更新。网页入口必须实际执行游戏玩法，只有 Three.js 模型预览不算完成。

## 真实模型工作台

运行 `npm run build:preview` 后执行 `npm run start:preview`，打开 <http://127.0.0.1:48910/creation-workspace.html>。使用自己的账号进入游戏/分支，点选场景对象编辑；W/E/R移动、旋转、缩放，F聚焦，Ctrl临时吸附、Shift精细调整，Enter提交数值、Esc取消。聊天从右侧抽屉打开，可附当前对象与精确坐标并发送给真实Codex；消息、附件和已确认编辑由中央服务持久保存。

点击Play在当前视口运行真实Godot。保存源稿与应用到世界分开：新内容先验证并应用，不能默默玩旧版本。个人检查只冻结自己的画面。主视口和对象预览均加载真实GLB，聊天关闭后不占视口。[3D操作说明](docs/3D-INTERACTION.md)与[当前回归](.local/creation-verification/browser/1dde-FINAL-REGRESSION.md)可直接核对。本机演示主干仍保留flat源格式；层级/固定实例升级的实验入口须显式设置 `WORLD_ATELIER_ENABLE_HIERARCHY=1`，已有场景不会自动迁移。独立48921测试已操作新格式，不把测试数据当作演示主干。

## 本地运行

```sh
npm install
npm start
```

唯一产品入口：[世界工坊](http://127.0.0.1:48910/creation-workspace.html)。`npm start`、`npm run dev`、`npm run start:preview` 使用同一个带冲突检查的启动器；已运行时复用原服务。日常只需启动一次，终端保持打开，在启动服务的终端按 Ctrl+C 停止。

48910 同时提供界面、创作 API、Agent 会话和 Godot Web；无需另开后端。Godot 构建与执行需要 Godot 4.6 及相应导出模板；首次准备编辑视口可运行 `npm run build:preview`。玩法启动、导出与 Agent 固定工程见 [统一游戏工程](docs/UNIFIED-GAME-RUNTIME.md)。

正式数据位于 `.local/model-preview/`，包括既有游戏、账号、会话和资产。启动、局域网、权限与数据隔离配置见 [本机开发说明](docs/LOCAL-DEVELOPMENT.md)。

## 旧中央门户已退役

2026-09-08 用户决定只保留协作创作工作台。48900 服务和旧门户前端已撤下，`build:portal` 已移除；不再维护第二个产品入口。旧数据库、发行文件和历史证据保留，未迁移或清空当前创作数据。

`services/control-plane/storage.mjs` 仍被当前创作服务复用。其余历史协议代码用于隔离技术测试；旧服务入口要求显式指定非 48900/48910 端口和独立数据目录，拒绝使用正式及旧服务数据，并且不再提供门户页面。`npm test` 当前仍是历史中央协议测试；其通过不能代表创作工作台验收。测试边界见 [历史测试说明](tests/e2e/README.md)，当前产品验证按 [创作验收](docs/CREATION-ACCEPTANCE.md)选择与改动相关的检查。
