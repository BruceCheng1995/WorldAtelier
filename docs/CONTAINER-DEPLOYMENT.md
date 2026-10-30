# Windows 和 Linux：部署默认工程

这条路径用于展示现有工程：同一个 Linux 镜像提供原工作台、9 个默认工程及真实 Godot Web Play。Windows 通过 Docker Desktop 的 Linux 容器或 WSL2 中的 Docker Engine 运行；Linux 使用 Docker Engine。主机无需安装 Node、Python、Godot 或 Codex。

## 准备容器环境

| 主机 | 需要的环境 |
| --- | --- |
| Windows 10/11 | 当前 Docker Desktop，选择 Linux 容器与 WSL2 后端；使用支持 Landlock 的版本（Docker Desktop 4.60+、WSL 2.6+）。也可在 WSL2 Ubuntu 中安装 Docker Engine 并执行下面的 Linux 命令。 |
| Linux | Docker Engine 与 Compose v2，内核启用 Landlock ABI 3+；Ubuntu 24.04 的标准内核具备相应能力。最终以容器内的实际预检为准。 |
| macOS | 可使用当前 Docker Desktop 的同一容器路径；已有原生部署继续按 [Agent 部署指南](AGENT-DEPLOYMENT.md)执行。 |

安装入口：[Windows Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)、[Linux Docker Engine](https://docs.docker.com/engine/install/)、[WSL 更新](https://learn.microsoft.com/windows/wsl/install)。Windows 首次安装所需的系统功能、重启和 Docker 启动按官方安装流程完成。不要切到 Windows containers 模式。

在将要运行部署命令的终端检查：

```text
docker version
docker compose version
docker info --format "{{.OSType}}"
```

最后一项必须为 `linux`，且 Docker daemon 可以连接。Windows 使用 WSL 路径时，命令在对应 Ubuntu 终端执行；浏览器仍可在 Windows 打开。

使用 Docker Desktop 时，让 Desktop 保持运行。直接在 WSL Ubuntu 中安装 Docker Engine 时，使用正常的 Docker 系统服务（例如 `sudo systemctl enable --now docker`），并在演示期间保持 WSL 会话；不要把守护进程挂在随后会退出的 Agent 临时命令窗口里。

## 克隆、构建、启动

以下命令在 PowerShell、WSL 或 Linux shell 均可执行：

```text
git clone https://github.com/BruceCheng1995/WorldAtelier.git
cd WorldAtelier
docker compose up -d --build --wait
```

每一步成功后再继续。首次构建会安装固定的官方 Godot `4.6.stable.official.89cea1439`、Web 模板和 Linux 隔离 helper，并构建编辑视口。依赖与默认工程都来自镜像构建输入，不需要从作者机器拷贝 `.local`。

确认状态：

```text
docker compose ps
docker compose exec -T worldatelier node tools/check-deployment.mjs --json
docker compose logs --tail 60 worldatelier
```

容器应为 `healthy`，预检 `ok` 为 `true`。如果内核缺少 Landlock 或外层策略不允许实际安装隔离，服务会明确拒绝启动；升级 WSL、Docker Desktop 或 Linux 内核后重试。不要添加 `privileged`、挂载 Docker socket 或关闭 seccomp 来绕过失败。

打开 **http://127.0.0.1:48910/creation-workspace.html**，注册自己的账号。游戏库会直接显示默认工程。先打开 **俄罗斯方块 → main**，等待编辑场景显示，再点击 **Play / 独立运行**；随后可打开 **兽人必须死 → main** 查看三维案例。首次打开场景和 Play 还会构建对应游戏，等待真实进度结束后确认游戏画面和时刻推进。

`healthy`、文件齐全或 iframe 出现都不等于游戏已运行。Agent 应完成上述实际浏览器检查后交付地址；浏览器不可用时明确说明剩余检查。

## 数据与停止

工程、账号和构建记录保存在 Compose 管理的 `worldatelier-data` 卷。重启或重建容器会保留这些数据，不重复安装或覆盖默认工程。

```text
docker compose restart
docker compose down
```

`down` 停止容器并保留数据卷。**`docker compose down -v` 会删除此部署的数据**，只用于明确要清空的测试部署。

默认只向宿主 `127.0.0.1:48910` 发布端口。不要把容器内部 IP 当成可分享的地址。远程 Linux 可通过 SSH 转发到浏览器所在电脑：

```text
ssh -L 48910:127.0.0.1:48910 user@server
```

保持隧道连接，再在浏览器所在电脑打开上述本机地址。若 48910 已被其他程序占用，先核对占用者；不要停掉别人的服务或直接换端口掩盖冲突。

## 此配置的范围

- 使用原服务、中央原生源稿、场景/预制件浏览与独立 Play；默认工程不公开编辑，原权限继续生效。
- AI 创作执行器和联网共享世界 worker 在案例镜像中关闭；浏览与试玩不需要 AI 凭据。这不把独立 Play 描述成共享多人游戏，也不冒称 Windows 原生 Node/Godot 后端已实现。
- 容器以非 root 用户、只读镜像文件系统运行。每次 Godot 执行还应用 Landlock 与 seccomp，独立的文件目录和 `user://`；允许线程，拒绝新子进程、网络通信和跨进程操作。不提供不互信租户或每个任务的硬资源配额保证。
- Godot 编辑器的内置 LSP/DAP 可构造不可通信的 TCP 描述符，但 `bind/connect/listen/send/recv` 不允许；没有可访问的编辑器调试端口。Linux 的 `.import` 原子保存使用明确的私有候选父目录，导入后继续校验固定源文件。
- 固定版本启动时被拒绝的桌面目录查询只做精确、一次的诊断分类；真实脚本/导出错误继续阻止完成。隔离规则及 helper 身份参加构建键。

## 可复现验证

仓库工作流 `Cross-platform default projects` 配置了 Linux 和 Windows WSL2 两项验证：构建同一镜像、执行实际隔离检查、从宿主真实浏览器打开全部默认工程，再检查重启后的数据保留。测试使用 48921 和独立数据卷，保留源版本、构建身份和截图。Windows 工作流验证的是 WSL2 Ubuntu 内的 Docker Engine，不涵盖 Docker Desktop 的安装过程。实际通过范围以工作流结果为准，不用 Linux 成功替代 Windows 结果。

本机开发者可以用 `WORLD_ATELIER_PORT=48921` 为独立 Compose 项目设置测试端口；映射内外端口必须一致。浏览器回归设置 `WORLD_ATELIER_TEST_EXTERNAL_ORIGIN=http://127.0.0.1:48921` 后检查已有隔离服务，不启动第二个后端。该入口仅接受测试端口，不对正式 48910 自动创建测试账号。

### 实测记录（2026-10-30）

运行代码提交为 [`db9e357`](https://github.com/BruceCheng1995/WorldAtelier/commit/db9e357c6a43840c4b704db47bdbab918219a222)，[对应工作流及截图、JSON 报告](https://github.com/BruceCheng1995/WorldAtelier/actions/runs/41033509968)分别保存每种环境的结果。

| 环境 | 实际检查 | 结果 |
| --- | --- | --- |
| Linux AMD64 / Ubuntu 24.04 | 镜像构建、33 项隔离与日志检查（含真实 Godot 运行）；同一 Chrome 进程依次打开 9 个工程 main 分支的编辑场景及 Play；重启后重新登录并核对 9 工程、11 分支 | 通过 |
| Windows AMD64 / WSL2 Ubuntu 24.04 | 同一镜像与隔离检查；Windows Chrome 连续打开全部 9 个工程的 main 分支，再验证重启保留 | 通过 |
| Windows 独立冷启动对照 | 新部署优先打开小小梦魇，核对实际 `ready → loaded`、固定构建、tick 80 → 152，再验证重启保留 | 通过 |

完整回归保留同一 Chrome 进程，每个工程使用新的浏览器上下文。每个工程同时核对分支 head、编辑文档、Play 入口和构建身份；仅出现画面或旧视口的 ready 标记不能通过。Windows 大型工程的启动还覆盖分阶段等待：本次场景初始化约 137 秒，引擎启动时间不再挤占场景的完整时限。两阶段各 180 秒，重复就绪消息不会续期，加载期间可停止。

本机 Linux ARM64 容器另完成了 9 个工程、真实隔离及重启保留检查；macOS 原生入口在最终启动修复后复测了俄罗斯方块与兽人必须死。案例镜像的范围仍为浏览与独立 Play，完整创作 Agent 配置继续见 macOS 指南。
