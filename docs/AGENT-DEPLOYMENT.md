# 让 Agent 部署并打开默认案例

这份指南面向第一次拿到仓库的 Agent。目标是把现有的 9 个工程、11 个分支打开给用户看；不需要先创作新游戏，也不需要 AI 服务凭据。

所有命令都在**当前 clone 的根目录**执行。其他文档中的 `/Users/chengzhi/Projects/WorldAtelier` 是作者开发机器的位置，不是安装要求。先用 `pwd` 和 `git rev-parse --show-toplevel` 确认自己的目录，保留其中已有的工作。

## 1. 先确认主机和任务范围

完整服务器目前需要 **macOS**，因为原生场景导入、预览和 Play 使用 `/usr/bin/sandbox-exec` 执行隔离。Linux、Windows、WSL 和普通 Linux 容器目前没有对应后端，不能仅装 Node/Godot 就宣称可运行，也不要删除隔离检查绕过它。浏览器访问端与服务器主机是两回事。

当前入口适用于本机或局域网。公网域名、反向代理和云托管不属于这条已验证的部署路径；不要为了打开案例另建端口或另一套应用。

仅展示默认案例时，使用下文的 `WORLD_ATELIER_DISABLE_AGENT=1`。需要用户进一步通过 Agent 创作时，另按 [Codex 集成](CODEX-INTEGRATION.md) 配置执行器；不要把 AI 登录设为浏览案例的前置条件。

## 2. 检查并补齐基础工具

```sh
uname -s
node --version
npm --version
python3 --version
git --version
curl --version
zip -v
test -x /usr/bin/sandbox-exec
```

需要 Node.js **24+**（自带 `node:sqlite`，不用另装数据库）、npm、Python 3、curl、zip。Python/curl 用于模板安装；zip 也用于实际游戏出包。

已有合适版本就复用。缺 Node/Python 且已安装 Homebrew 时，可仅安装缺少的项：

```sh
brew install node@24 python3
export PATH="$(brew --prefix node@24)/bin:$(brew --prefix)/bin:$PATH"
node --version
python3 --version
```

没有 Homebrew 时，按 [Node.js 官方下载](https://nodejs.org/en/download) 与 [Python 官方下载](https://www.python.org/downloads/macos/)安装。Homebrew 命令依据其 [Node 24](https://formulae.brew.sh/formula/node@24) 与 [Python](https://formulae.brew.sh/formula/python@3.13)说明。使用现有版本管理器也可以，关键是执行构建和启动的同一个 shell 确实使用 Node 24+。

## 3. 安装准确的 Godot 标准版

必须是 **`4.6.stable.official.89cea1439`**。不能替换为“最新 Godot”、其他 4.6 补丁版或 .NET 版；本地 HTTP 的 Web 适配按这一个版本校验。

先检查已有安装：

```sh
/Applications/Godot.app/Contents/MacOS/Godot --version
```

若版本正确，可使用该路径并跳过下载。否则将官方标准版装到当前项目自己的 `.local`，保留其他 Godot 安装：

```sh
set -e
mkdir -p .local/toolchains/godot-4.6
curl --fail --location --retry 3 --retry-all-errors --connect-timeout 15 --max-time 600 \
  --output .local/toolchains/Godot_v4.6-stable_macos.universal.zip \
  https://github.com/godotengine/godot-builds/releases/download/4.6-stable/Godot_v4.6-stable_macos.universal.zip
python3 - <<'PY'
from pathlib import Path
import hashlib
archive = Path('.local/toolchains/Godot_v4.6-stable_macos.universal.zip')
expected = 'fc15ceb6280420f117ab4ef62332654db0088078faeeb9025dd814276185ed3b'
digest = hashlib.sha256()
with archive.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
if digest.hexdigest() != expected:
    raise SystemExit('Godot archive checksum mismatch; do not extract or run it')
print('Official Godot archive verified')
PY
ditto -x -k .local/toolchains/Godot_v4.6-stable_macos.universal.zip .local/toolchains/godot-4.6
"$PWD/.local/toolchains/godot-4.6/Godot.app/Contents/MacOS/Godot" --version
```

如果目标目录已有其他安装，选择新的本地目录并同步修改后面的 `GODOT_BIN`。下载和 SHA-256 来自 [Godot 4.6 官方发行](https://github.com/godotengine/godot-builds/releases/tag/4.6-stable)；版本入口见 [官方归档](https://godotengine.org/download/archive/4.6-stable/)。macOS 标准包包含 Apple Silicon 和 Intel 二进制。

**`GODOT_BIN` 必须是绝对路径，预检、构建、启动要使用同一个值。** 下文每条命令都带路径，避免 Agent 分多次 shell 调用后丢失 `export`。若使用 `/Applications` 的正确版本，将每条命令中的路径替换为 `/Applications/Godot.app/Contents/MacOS/Godot`。

## 4. 安装 Web 模板和 JavaScript 依赖

```sh
set -e
python3 tools/install-release-templates.py web \
  --directory "$HOME/Library/Application Support/Godot/export_templates/4.6.stable"
npm ci
GODOT_BIN="$PWD/.local/toolchains/godot-4.6/Godot.app/Contents/MacOS/Godot" npm run doctor
```

模板安装器从官方 TPZ 中只提取 `version.txt` 和 `web_nothreads_release.zip`，不必手动下载所有平台的完整模板包。`tools/godot-install-templates.py` 是旧的 macOS 应用模板安装器，不能替代这里的 Web 模板命令。

入门流程使用上述**标准用户模板目录**。`build:preview` 查找这个目录；如果设置了 `WORLD_ATELIER_EXPORT_TEMPLATES`，游戏 Play 还会使用它指定的目录，预检会同时检查两处。不要仅把模板放进自定义目录就假定编辑视口也能构建。

`doctor` 只检查环境和内容包字节，不安装软件、不创建账号、不启动服务。退出码 `0` 表示预检通过，`1` 表示有缺项；按 `FAIL` 的修复提示补齐后重跑。Agent 需要机器可读结果时使用同一 `GODOT_BIN` 执行 `node tools/check-deployment.mjs --json`。

## 5. 构建和启动原工作台

```sh
set -e
GODOT_BIN="$PWD/.local/toolchains/godot-4.6/Godot.app/Contents/MacOS/Godot" npm run build:preview
GODOT_BIN="$PWD/.local/toolchains/godot-4.6/Godot.app/Contents/MacOS/Godot" \
  WORLD_ATELIER_DISABLE_AGENT=1 WORLD_ATELIER_DEFAULT_PROJECTS=1 WORLD_ATELIER_PUBLIC_PLAY=1 \
  npm start
```

保持启动服务的进程运行，在另一个终端或浏览器继续检查。Agent 使用的终端若在工具调用结束后回收子进程，应改用可持续的终端会话。需要登录后的后台运行时可使用已有后台命令，它会保留这里明确设置的 Godot、默认工程与 Agent 开关：

```sh
GODOT_BIN="$PWD/.local/toolchains/godot-4.6/Godot.app/Contents/MacOS/Godot" \
  WORLD_ATELIER_DISABLE_AGENT=1 WORLD_ATELIER_DEFAULT_PROJECTS=1 WORLD_ATELIER_PUBLIC_PLAY=1 \
  npm run background:install
npm run background:status
```

该命令管理同一个 48910；已有不同后台配置会拒绝覆盖。详情和停止方法见 [本机开发指南](LOCAL-DEVELOPMENT.md)。

固定地址为 **http://127.0.0.1:48910/creation-workspace.html**。`npm start` 会复用已确认的本项目服务；如果端口是其他服务或配置不同，应先核对进程和原任务，不能杀占用者或擅自换产品端口。不要直接运行另一个 HTTP 服务。`--headless` 的构建过程不需要打开 Godot App，也不应抢桌面焦点或播放声音。

## 6. 验证服务，再打开实际案例

先读取健康状态：

```sh
curl --fail http://127.0.0.1:48910/preview-api/health
curl --fail http://127.0.0.1:48910/creation-api/health
```

第一项应有 `ok: true`、`runtime_ready: true`；第二项应有 `ok: true`、`default_projects.count: 9`。只查看案例不要求 `agent_ready: true`。健康状态不能代替游戏运行检查。

接着使用真实浏览器完成：

1. 打开工作台并注册自己的账号；没有内置共享账号或通用密码。自动检查需要临时账号时使用下一节的隔离回归，不把测试身份写进正式库。
2. 游戏库应出现 9 个默认工程。它们共 11 个分支，已注册用户可以只读查看和试玩。
3. 先打开 **俄罗斯方块 → main → 只读浏览与试玩**，等待当前场景显示；打开一个预制件，再回到场景。
4. 点击 **Play / 独立运行**，等待真实构建进度结束，确认出现游戏画面和持续推进的“本局时刻”。可以再检查暂停/继续。
5. 再打开 **兽人必须死 → main** 检查三维案例。首次打开或 Play 会构建；后续复用匹配构建。不要把正在构建误判成空工程，也不要只看到 iframe 就宣告完成。

俄罗斯方块主干的直接入口（仍需正常登录）：

`http://127.0.0.1:48910/creation-workspace.html#/games/game-76af7385-c271-4c9d-9701-f53bd27d8e13/branches/main`

向用户交付时给出实际可访问地址、已打开的案例、是否真的进入 Play，以及仍缺少的步骤。用户查看的是远端机器时，不能把远端的 `127.0.0.1` 当作用户本机地址；同局域网可使用启动器打印的 LAN 地址。

## 7. 可选的隔离自动验证

```sh
npm run test:defaults
GODOT_BIN="$PWD/.local/toolchains/godot-4.6/Godot.app/Contents/MacOS/Godot" npm run doctor -- --browser
GODOT_BIN="$PWD/.local/toolchains/godot-4.6/Godot.app/Contents/MacOS/Godot" npm run test:defaults:browser
```

前一项检查文件、权限和安装行为；浏览器回归才实际构建、打开 9 个工程并检查运行。浏览器回归要求 **Google Chrome** 和 npm 开发依赖，使用无窗口、静音浏览器；单独安装 Playwright Chromium 不等于满足 `channel: 'chrome'`。

回归使用独立 **48921**、新建临时数据和测试账号，结束后关闭自有服务。运行前确认端口空闲，不与其他占用 48921 的测试并发。只需检查部分案例时，可设置 `WORLD_ATELIER_DEFAULT_TEST_GAMES=俄罗斯方块,兽人必须死`；报告必须注明是部分验证。无浏览器工具或 Chrome 时保留已通过的环境/构建结果，并明确尚未完成浏览器验证。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `node:sqlite` 不可用、Node 版本过低 | 切到 Node 24+，确认当前 shell 的 `node --version`，再 `npm ci`。 |
| Godot 版本校验失败 | 使用上面的固定标准版；不要用最新版替代，也不要删掉版本校验。 |
| Web 模板缺失或 ZIP 损坏 | 核对标准目录和 `WORLD_ATELIER_EXPORT_TEMPLATES`；备份并移走报错的文件后重装。安装器会跳过已存在的文件。 |
| `EXECUTION_ENVIRONMENT_UNAVAILABLE` | 确认服务器是受支持的 macOS，且外层执行环境允许实际启动 `sandbox-exec`；不用无隔离回退伪装部署成功。 |
| `GODOT_BIN` 在下一次调用失效 | 每次命令都带相同的绝对路径；不同 Agent shell 调用不一定保留 `export`。 |
| 48910 被占用或旧服务缺少默认工程 | 用 `lsof -nP -iTCP:48910 -sTCP:LISTEN` 核对；遵守已有任务的受控重启流程。 |
| 已注册但看不到案例 | 检查默认包、`WORLD_ATELIER_DEFAULT_PROJECTS`、`WORLD_ATELIER_PUBLIC_PLAY` 和项目归档/访问设置；不要重置现有数据库或权限来制造成功。 |
| 默认包缺文件 | 重新拉取仓库的 `content/default-projects/`，不是另做一份 demo。 |
| 自动浏览器检查提示 Chrome 缺失 | 安装 Google Chrome；或先用真实用户浏览器核对并如实报告自动检查未执行。 |
| `esbuild` 执行失败 | `npm ci` 后重跑 doctor；若 npm 报安装脚本被阻止，按它的提示处理 esbuild。 |

本指南于 2026-10-30 核验：预检分类回归 19 项通过；按官方地址新下载并校验 Godot 标准版及 Web 模板，实际预检通过，使用这套新工具链在隔离工作台打开俄罗斯方块和兽人必须死，场景、预制件及真实 Web Play 通过。这里的两例属于安装流程复验，全部默认工程的验证范围见 [默认工程分发](DEFAULT-PROJECTS.md)。
