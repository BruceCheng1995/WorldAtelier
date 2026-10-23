# 本机工作台：复用一个入口

日常创作工作台固定为 **http://127.0.0.1:48910/creation-workspace.html**。它由 `services/preview/server.mjs` 提供，页面源文件在 `apps/creation-workspace/`，同一服务包含创作 API、真实会话和 Godot Web。48900 中央门户已退役，不再启动；48921 仅供隔离测试。48922 顶部设计临时服务已停用。

2026-10-23：作者游戏使用同一监听服务上的独立运行来源。本机为 `wa-runtime.localhost`，局域网为对应 IPv4-mapped IPv6；由已认证的工作台签发固定构建授权，不手工拼接运行 URL。浏览器可直接解析 `*.localhost`，命令行系统 DNS 的行为可能不同。运行 Host 不开放创作或管理 API；静态编辑器、独立 Play 与显式共享世界继续分别处理。旧存档通过可信页面显式迁移或导出，详见 [运行隔离](RUNTIME-ORIGIN-ISOLATION.md)。顶部「本机与离线工作区」提供离线工具和[原生客户端接续](NATIVE-CLIENT-CONTINUITY.md)。

## 启动与复用

在工程根目录执行 `npm start`（`npm run dev`、`npm run start:preview` 是同一入口）。只需一个终端和一个服务，48910 同时提供工作台、创作 API 与 Godot Web；在实际启动服务的终端按 Ctrl+C 停止。

正式 48910 默认监听 `0.0.0.0`，同时保留本机入口。启动和复用时会打印本机地址与当前网卡的局域网地址；同事使用同一局域网中的 `http://<这台电脑的局域网IP>:48910/creation-workspace.html`。电脑与服务需要保持运行，IP 可能随网络变化。此配置不需要外部部署，也不会配置路由器端口转发。

注册默认开放。正式服务默认让所有已注册账号浏览和试玩现有游戏；未受邀用户显示“可试玩”，不写入项目成员列表。用户可直接申请编辑，游戏拥有者从消息中心或协作面板审批，也可通过一次性邀请授予权限。新注册试玩账号也不能新建游戏或启动 Agent；获得任一游戏的编辑权限后可创建自己的游戏。空数据库仅首个注册账号可创建首个游戏，作为初始拥有者。公共试玩不开放项目会话（包括向项目成员共享的会话）；私人会话继续仅对本人可见。首次进入未运行的世界可以执行必要的 Godot 技术检查并启动，显式验证、发布、源稿编辑和 Agent 会话仍检查原有编辑权限。源稿、可玩版本和已有世界状态仍分别校验，试玩不会绕过失败或版本不匹配的拒绝。

配置可显式覆盖：`WORLD_ATELIER_LAN=0` 只监听本机，`WORLD_ATELIER_PUBLIC_PLAY=0` 恢复仅邀请成员访问；正式默认均为开启。自定义测试端口默认均关闭，LAN 测试需要显式设置两者为 `1`。这些是启动配置，修改后需受控重启。服务仍核对本机网卡/主机名与端口的 Host、写请求及浏览器 WebSocket 的同源 Origin；Godot 权威进程继续使用回环地址和独立执行环境。

局域网 HTTP 的 UUID 使用 `crypto.getRandomValues` 回退，历史证据下载保留 SHA-256 完整性检查。Godot Web 必须通过当前构建脚本生成适配后的单线程构建及新的不可变清单；不要手改已归档的发行文件或跳过资产哈希检查。

独立 Play 先通过 `GET /creation-api/projects/:p/branches/:b/playable-game` 解析可玩版本，再使用统一 `play-build`。原生分支的 owner/editor/viewer 可以从可访问的源版本独立运行；公共 player 只能使用创作者显式发布的固定 Web 构建，完成 Play 或出包不会自动发布。既有旧共享发行继续按其固定版本提供兼容入口；原生显式共享世界通过 `shared-playable` 解析独立的 `native_shared` 固定构建，再完成真实场景应用和控制权确认；旧共享发行仍保留原 `playable` 协议。共享发布与公共独立 Play 发布互不授权。

- 48910 已运行：检查服务健康身份、当前工程 HTML 及局域网/公共试玩配置，打印地址后退出，不再创建服务。配置不匹配则提示受控重启，不默默复用旧设置。
- 48910 被其他服务占用：明确报错，不自动改端口、不杀占用进程。
- 48910 空闲：用启动锁串行启动原服务。两个启动命令同时执行时，只有一个能启动。
- 自定义测试端口必须显式设置独立的 `WORLD_ATELIER_PREVIEW_DATA` 和 `WORLD_ATELIER_CREATION_DATA`；检查真实路径，拒绝与正式数据重叠。

如果启动进程被强制终止，可能留下 `.local/workspace-48910.start.lock`。先读取其中 PID，用 `ps -p <PID> -o pid=,command=` 核对进程，再用 `lsof -nP -iTCP:48910 -sTCP:LISTEN` 检查监听者。只有确认启动器和服务均已不存在，才删除这个对应锁文件后重新执行 `npm run dev`。不要凭文件存在就杀进程或删除数据。

## 每次改界面前的处理约定

1. 先确认用户当前 URL → 监听进程 → 服务路由 → 页面源文件。已有产品的“设计一下”“改图标”“更新界面”，默认直接修改原页面。
2. 编辑 `apps/creation-workspace/index.html`、`workspace.css`、`workspace.js` 后刷新原地址。这些文件由原服务按请求读取，通常无需重启后端。
3. 只有用户明确要求独立原型，才另开原型服务；先说明用途、端口、退出方式。禁止用演示会话、假状态替代真实工作台。
4. 独立测试必须隔离端口、世界和数据，完成后关闭自己创建的测试进程；测试地址不能作为用户的交付入口。
5. 完成时检查原地址的可见效果，提供原地址。需要重启后端时先检查当前任务和世界，说明影响；不能因静态页面改动而顺手重启。

启动器是默认命令的保护，不是操作系统层面的禁令；直接运行 Python 或服务器文件仍可绕过。因此启动命令保护与 `AGENTS.md` 中的工作约定同时执行。

## 原生源稿迁移维护

`tools/migrate-native-creation.mjs` 只在停服维护时运行。先确认所有创作、构建及待清理任务结束，核对 48910 的实际进程后受控关闭原服务，再执行完整备份。迁移逐字节比对备份中的全部数据库记录和事件，包含最新会话与权限；备份后出现任何新记录都会拒绝开始。

```sh
node tools/backup-creation.mjs create --data=.local/model-preview/creation --out=.local/native-maintenance-backup
node tools/migrate-native-creation.mjs --data=.local/model-preview/creation --backup=.local/native-maintenance-backup --out=.local/native-maintenance-report
npm start
```

备份与报告必须使用新的目录；报告不能放进固定备份。迁移同时取得数据目录的 `.native-migration.lock` 和正式启动锁，启动器与服务入口也检查维护锁。不要删除活跃维护进程的锁。每个分支通过原中央事务写一个新源提交，原源版本、会话、资产、构建与事件保留。部分完成后遇错，应先解决实际错误，重新创建完整备份，再运行到新的报告目录；已原生化的分支自动跳过，不重写此前的迁移记录。

协作申请、成员权限、邀请和 Inbox 闭环见 [COLLABORATION-ACCESS.md](COLLABORATION-ACCESS.md)。正式试玩默认保持开放，拥有者移除成员不等于禁止公共试玩。

## 私有管理后台

后台使用同一服务的 `http://127.0.0.1:48910/admin`，设计与权限范围见 [管理后台](ADMIN-DASHBOARD.md)。账号菜单仅给唯一管理员显示入口；匿名访客只见登录页，管理页面、数据及专用脚本均受服务端门禁保护。

初次绑定需先核实本人的现有账号 UUID，再由本机操作者运行 `npm run admin:bind -- --user-id <账号 UUID>`。设置保存在原创作数据库，立即生效；默认不推断第一个注册者。此命令拒绝覆盖已有不同管理员，不提供网页委派或自助认领入口。不要把真实账号 UUID/密码写入源码。隔离测试可用 `WORLD_ATELIER_ADMIN_USER_ID` 指定其测试账号。

`npm run test:admin` 使用 48921 和独立临时数据，运行前保证端口空闲；验证结果写入 `.local/creation-verification/admin-independent/`。该测试不启动真实 Agent 或 Godot，不计为玩法或工作进程停止的证明。

资产详情支持 GLB 交互预览。首次更新后执行 `npm install` 安装锁定的 Three.js/esbuild 依赖；专用模块由原服务按需打包到内存，修改 `admin-model-preview.js` 后刷新即可。模型通过管理员专用端点读取，隔离状态与不可变哈希继续校验。`node --test tests/creation/admin-model-preview.test.mjs` 执行独立权限/字节测试；`node tests/creation/admin-model-preview-browser.mjs` 使用本机 Chrome、临时数据与随机空闲端口执行实际 WebGL 交互检查并自动清理。默认测试端口被其他任务占用时，模型测试可通过 `WORLD_ATELIER_ADMIN_MODEL_TEST_PORT` 显式指定另一空闲端口；不要停止占用者。
