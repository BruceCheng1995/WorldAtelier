# 世界工坊 · World Atelier

从中央服务器选择主干或分支，取得匹配的客户端与世界状态，进入游戏；在网页、Godot 编辑器或离线工作区制作内容，再提交回对应分支。

**本机完整开发与六项验收已交付，游戏版本 0.1.3。** 真实网页、桌面、离线和中央权威端均已运行；证据、精确版本与风险见 [验收报告](docs/VALIDATION-REPORT.md) 和 [验收矩阵](docs/ACCEPTANCE.md)。这是从头建立的新工程，旧工程记录不计入验收。

先阅读 [总体架构](docs/ARCHITECTURE.md) 和 [协议设计](docs/PROTOCOL.md)。

```text
apps/
  portal/                 网页分支入口、协作编辑、下载和实际 Web 游玩
  desktop-launcher/       客户端版本缓存、校验、启动与会话跳转
services/
  control-plane/          身份、工程、分支、发布、存储元数据与任务
  world-orchestrator/     权威进程代次、检查点、休眠、升级与恢复
runtimes/
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

当前实现采用 Node.js、SQLite、Vue/Vite 与 Godot 4.6。每个在线世界由对应发行中的独立 Godot 程序执行权威玩法，中央服务保存确认后的完整状态。源码、可玩发行和在线世界分别记录版本。

客户端切换的验收是版本匹配、状态接续和控制权正确；普通兼容内容仍争取在当前游戏内热更新。网页入口必须实际执行游戏玩法，只有 Three.js 模型预览不算完成。

## 本地运行

当前实际验证环境是 macOS、Node.js 26、Godot 4.6 和 Chrome。构建需要 Python 3、Godot 4.6 的 macOS/Web 导出模板；`GODOT_BIN` 可指定引擎，默认使用 `/Applications/Godot.app/Contents/MacOS/Godot`。原始 Blender 工程和生成脚本已保留，正常运行无需重新生成模型。

```sh
npm install
npm --prefix apps/portal install
npm run build:portal
npm run build:runtime
npm start
```

打开 `http://127.0.0.1:48900`，注册账号、建立工程、构建首个可玩版本并进入世界。另一个浏览器账号注册后，由工程拥有者加入成员即可共同编辑和游玩。

游戏包含观测站、园林、铸炉和城塞四个区域，227 个创作对象、46 个敌人及首领。WASD 移动，Space 攻击，Shift 闪避，E 交互，Q 在锻造台升级，Tab 展开地图。在线奖励与进度以中央权威结果为准。

## 验证与状态

```sh
node --test tests/content.test.mjs
node --test tests/e2e/central.test.mjs
node --test tests/e2e/live-content.test.mjs
WORLD_ATELIER_WEB_CAMPAIGN=1 node tests/web-play.mjs
```

独立协议驱动共用隔离端口 48921，必须顺序运行；真实网页驱动用 48923。驱动创建独立账号、项目、数据目录和世界，不清空正常服务。详见 [独立测试说明](tests/e2e/README.md)。

兼容参数、GLB 和受约束的行为模块可以在当前世界应用；需要不同程序的版本通过最终检查点和新权威代次接续。行为模块只支持明确的规则接口，不是任意脚本的安全沙箱。当前运行与证据均在本机，尚未部署公共网络服务。

服务数据默认位于 `.local/server`，不可变程序在 `.local/artifacts`。`WORLD_ATELIER_DATA`、`WORLD_ATELIER_PORT` 和 `WORLD_ATELIER_RUNTIME_ROOT` 可用于独立环境。发行及其资产当前全部保留，没有自动删除历史版本的清理任务。

本地管理员可用 `tools/backup.mjs create --data=目录 --out=新备份目录` 保存一致的数据库与被引用资产、客户端；`restore --from=备份 --data=新目录 --runtime-root=新产物目录` 恢复到独立位置。恢复拒绝覆盖已有数据库，备份包含账号认证数据，应按服务数据保管。

## 已建立的本机演示

本轮交付保留一个可继续编辑的「星屿远征 · 共享开发工程」，含 main、scene-lab 两个内容分支与各自的世界。示例账号与本机入口见 Git 忽略的 `.local/DEMO-ACCESS.md`；不在源码中内置通用密码。`node tools/create-local-demo.mjs` 通过正常授权 API 建立并记录这个工程，可重入且不会删除其他工程。

## 外部地址配置

反向代理部署时，显式设置 `WORLD_ATELIER_PUBLIC_URL=https://你的域名`；客户端票据使用同一外部 origin 对应的 `wss://`，避免外部用户误连自己的 localhost。默认监听 `127.0.0.1:48900`；需要另一个绑定地址时设置 `WORLD_ATELIER_BIND_HOST`。反向代理须转发 HTTP 与 WebSocket，并保留本服务的响应头；HTTPS 证书由部署环境提供。该配置不意味着本轮已经发布公网服务，公网 TLS、远程网络和容量仍需在目标环境验收。
